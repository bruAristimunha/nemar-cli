/**
 * What a pull request changed, read as git data (ADR 0092, ADR 0107).
 *
 * Runs inside the central review workflow against a repository made with `git init` and
 * `git fetch`, which has no working tree. **Nothing is checked out and nothing from the pull
 * request is executed**: with no working tree, no hook, filter, `.gitattributes` driver or script
 * in the pull request can run, and a fork's content is read exactly like a branch's. Every git
 * call passes its arguments as an array (no shell) after the commit ids have been checked against
 * a 40-hex shape, and with `--literal-pathspecs`, so a path or a branch name is only ever data and
 * a file named like a pathspec (`:(glob)*.json`) cannot make git read another file's content. Each
 * call also runs with {@link childEnv}, this process's environment less the model credential, the
 * request for an identity token and the callback token, so the git that reads a contributor's
 * objects is handed none of them.
 *
 * **Two passes, for the two stages.** {@link gatherListing} reads what the screen is shown: the
 * change list, the version and name in `dataset_description.json` (the one file whose content it
 * reads), the subject counts and the commit subjects. {@link gatherContent} reads what only the
 * full review is shown: the cosmetic checks, the diffs and the change log. A pull request the
 * screen stops never has a file's content read beyond `dataset_description.json`.
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
 * a new file cannot remove anything. Nor does a MODIFIED `.json` or `.tsv` file whose change the
 * platform itself proved cosmetic (see {@link GitFacts.cosmeticOnlyFiles}); such a file is not
 * shown either, because there is nothing in it to read. Nor does a MODIFIED `.json` or `.tsv` file
 * the change summary accounted for (see {@link ContentFacts.summary}): the platform parsed both
 * sides and accounted for every change in it as a class, so the file counts as read without its
 * diff; a few such files are still shown as diffs, after the ones the summary did not cover.
 *
 * **One change repeated across many files is read once.** A bulk edit often makes the same change in
 * every subject's sidecar. A file whose diff is exactly one already shown, line for line (see
 * {@link diffSignature}), is not shown again: it is counted on the patch that shows the change
 * ({@link Patch.same}), costs none of the file or character budget, and counts as read exactly when
 * that diff was shown in full. The match is exact, so a change that differs in one byte is shown.
 */

import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hasVisibleText } from "../../shared/naming-rule";
import {
  AREAS,
  type Area,
  type AreaCounts,
  type ChangeStatus,
  type ChangedFile,
  type ChangelogEntry,
  MAX_LISTED,
  MAX_MODEL_FILES,
  type NameFinding,
  type NamingProblem,
  type ReviewEvidence,
  SEMVER,
} from "../../shared/pr-review";
import { shouldAnnex } from "../../src/lib/git-annex/policy";
import {
  ABANDONED_SUMMARY,
  type ChangeSummary,
  EMPTY_SUMMARY,
  type PoolFile,
  SUMMARY_LIMITS,
  type SummaryCandidate,
  poolFileMatters,
  summarizeChanges,
} from "./pr-review-summary";

export { MAX_MODEL_FILES };
export type { ChangelogEntry };
/** At most this many files have their content (a diff) shown to the model. */
export const MAX_PATCH_FILES = 40;
/** Characters of one file's diff shown to the model. */
export const MAX_PATCH_FILE_CHARS = 12_000;
/** Characters of diff shown to the model in all (about 20,000 tokens). */
export const MAX_PATCH_TOTAL_CHARS = 80_000;
/** Commit subjects shown to the model. */
export const MAX_COMMITS = 30;
/**
 * The most changed metadata files whose diff is read to look for a change repeated across files
 * (see {@link diffSignature}). Past it the files are unread, as before this pass existed.
 */
export const MAX_DIFFS_EXAMINED = 500;
/** The time left in the content pass below which, once the patches are full, no more diffs are examined for repeats. */
const FOLD_TIME_RESERVE_MS = 20_000;

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
  "changelog_unreadable",
  "no_merge_base",
  "changes_unreadable",
  "commits_unreadable",
  "timed_out",
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
  /**
   * The other changed files whose diff is this one, line for line, with only the file's name
   * different (see {@link diffSignature}). The reviewer reads the change once; each of these files
   * counts as read exactly when this diff was shown in full.
   */
  same: string[];
}

/**
 * What the screen is shown, read without any file's content but `dataset_description.json`'s: the
 * change list, the commit subjects, the version and name at both ends, and the subject counts.
 */
export interface Listing {
  /** The commit the pull request branched from `main` at: what it is compared against. */
  mergeBase: string;
  /** The pull request's head commit. */
  head: string;
  changes: RawChange[];
  /** Subject lines of the commits being merged. Attacker-controlled. */
  commits: string[];
  versionBefore: string | null;
  versionAfter: string | null;
  /**
   * The dataset's `Name` in `dataset_description.json` at the merge base and at the head, or null
   * where the file is absent, unparseable, or has no `Name` that is text a reader can see (a `Name`
   * of blanks or of invisible characters is none). Attacker-controlled at the head.
   */
  nameBefore: string | null;
  nameAfter: string | null;
  /**
   * The pull request adds or edits `dataset_description.json` and there is no readable name at the
   * head: the file is not JSON, or has no `Name`, or its `Name` is not text or shows nothing.
   * `nameAfter` is null for that and for a file the pull request does not touch, and only this says
   * which it was, so a name nobody could read is not mistaken for a dataset with no name to check.
   */
  nameUnreadable: boolean;
  subjectsBefore: number | null;
  subjectsAfter: number | null;
  /** True when the change list was longer than {@link MAX_MODEL_FILES}. */
  listCut: boolean;
  /**
   * A file named CHANGES or CHANGELOG (any case, optionally `.md`, `.txt` or `.rst`) at the dataset
   * root was added or modified. A deleted one does not count. Read from the change list alone.
   */
  changelogTouched: boolean;
  /**
   * The changed metadata files by the shape of their path, with how many of each, and nothing a
   * content read would add (what was shown, what was cosmetic): the screen's view of a bulk edit.
   * Ordered and cut as {@link GitFacts.groups} is.
   */
  shapes: PathShape[];
  /** Changed metadata files that belong to a path shape cut by {@link MAX_GROUPS}. */
  shapesOmittedFiles: number;
}

/** One shape of changed path, counted from the change list alone. */
export interface PathShape {
  status: ChangeStatus;
  pattern: string;
  files: number;
}

/** What only the full review is shown: the diffs, the cosmetic proofs and the change log. */
export interface ContentFacts {
  /** Diffs of the changed metadata files that fit the budget, most important first. */
  patches: Patch[];
  /**
   * True when a MODIFIED or REMOVED metadata file with a real change was not shown in full: it did
   * not fit the file or character budget, its diff was cut, reading it failed, or git wrote its diff
   * as binary, which shows none of its content. A file the platform proved cosmetic-only
   * ({@link cosmeticOnlyFiles}) is not counted, and neither is one the change summary accounted for
   * ({@link summary}).
   */
  readIncomplete: boolean;
  /**
   * How many files made {@link readIncomplete} true: the modified and removed metadata files that
   * are not cosmetic-only, not accounted for by the summary and not shown in full. Counted with the
   * one predicate `readIncomplete` is decided by, which is exactly `unreadFiles > 0`, so the two
   * cannot disagree. For the calibration's numbers: neither the report nor the prompt carries it.
   */
  unreadFiles: number;
  /**
   * How many MODIFIED metadata files the platform proved differ only cosmetically. Decided from
   * the two blobs, not by the model, and only for a regular file whose mode did not change:
   *  - a `.json` file whose text is identical once whitespace outside strings is removed (a
   *    reindent or a change of line endings; a key moved, a number respelled or a key repeated or
   *    dropped is NOT cosmetic, because the token text differs);
   *  - a `.tsv` file whose text is identical once spaces and carriage returns at the end of each
   *    line are removed (a trailing TAB is a column, so it is NOT cosmetic).
   * Such a file needs no reading to know that nothing was lost, so it never makes
   * {@link readIncomplete} true and does not use the patch budget.
   */
  cosmeticOnlyFiles: number;
  /**
   * Changed metadata files grouped by the shape of their path, so a bulk edit reads as one line.
   * Removed shapes first, then modified, then added; within a status the largest first. At most
   * {@link MAX_GROUPS} are kept; {@link groupsOmittedFiles} counts the files in the rest.
   */
  groups: PathGroup[];
  /** Changed metadata files that belong to a path shape cut by {@link MAX_GROUPS}. */
  groupsOmittedFiles: number;
  /**
   * Whether this pull request adds an entry for the new version to the change log, in the words of
   * {@link ChangelogEntry} (declared with the report, which enforces them). The report carries it
   * as `changelog_entry`, and a version without an entry cannot advance the revision.
   */
  changelogEntry: ChangelogEntry;
  /**
   * The change summary of the modified `.tsv` and `.json` files (`pr-review-summary.ts`): what each
   * changed, as exact classes, and the files it accounts for, which count as read. `EMPTY_SUMMARY`
   * when there was nothing to summarize; abandoned, and accounting for nothing, when the pass had
   * too little time left to start it or to finish it, or could not read the blobs it needs, which
   * leaves everything else exactly as it is without a summary.
   */
  summary: ChangeSummary;
}

/** Everything the full review is shown: the listing and the content pass together. */
export type GitFacts = Listing & ContentFacts;

/**
 * The four facts decided before any model is asked (ADR 0107), from the pull request's own text and
 * the dataset's name: whether the description is empty, whether it is cut, and how the title and a
 * changed dataset name break the naming rule. An empty description and a naming problem fail a
 * criterion whatever a model says; a cut description and an unreadable name only lower one to
 * `unknown` (see `factsOf` in `shared/pr-review.ts`). The change log is not among them: it is read
 * after the screen.
 */
export interface TextFacts {
  descriptionEmpty: boolean;
  /**
   * The description, as the models read it (after `tidy`), is longer than they are shown, so they
   * read its start and the mark `[cut]`. The cap is `MAX_BODY_CHARS` in `pr-review-prompt.ts`.
   */
  descriptionCut: boolean;
  titleProblem: NamingProblem | null;
  /** How the new name breaks the rule, or `unchecked` when it changed and cannot be read. */
  nameProblem: NameFinding | null;
}

/** One shape of changed path: `sub-*` and `ses-*` and `run-*` stand for any value. */
export interface PathGroup {
  status: ChangeStatus;
  pattern: string;
  files: number;
  /** How many of the group's files had their diff shown to the reviewer in full. */
  shown: number;
  /** How many of the group's files differ only cosmetically. */
  cosmeticOnly: number;
  /** How many of the group's files the change summary accounted for (a file can also be shown). */
  summarized: number;
}

/** The most path shapes reported, largest first within a status; the files of any others are counted in `groupsOmittedFiles`. */
export const MAX_GROUPS = 12;

/** The most modified `.json` and `.tsv` files compared for a cosmetic-only change. The rest are treated as really changed (read, or counted as unread). */
const MAX_COSMETIC_CHECKS = 2_000;

const CHANGELOG_NAME = /^(CHANGES|CHANGELOG)(\.(md|txt|rst))?$/i;

/**
 * How long each evidence pass may spend in git, all its calls together: the listing, before the
 * screen, and the content, after it. The job reads a partial clone, whose missing blobs git fetches
 * from GitHub inside these calls, so a stalled fetch would otherwise run on to the job's own
 * timeout. A pass that runs out is `timed_out`, which is no verdict. The workflow test counts both
 * in the job's worst case.
 */
export const EVIDENCE_BUDGET_MS = { listing: 60_000, content: 120_000 } as const;

/** When the pass now running must be done by (epoch ms); null outside a pass. */
let gitDeadline: number | null = null;

/** A shorter budget for a test of a stall; production never sets one. */
let budgetOverride: Partial<Record<keyof typeof EVIDENCE_BUDGET_MS, number>> = {};

export function __setEvidenceBudgetForTests(
  ms: Partial<Record<keyof typeof EVIDENCE_BUDGET_MS, number>> | null,
): void {
  budgetOverride = ms ?? {};
}

/** Run one pass under its budget. The passes are synchronous, so one deadline at a time holds. */
function withinBudget<T>(pass: keyof typeof EVIDENCE_BUDGET_MS, read: () => T): T {
  const saved = gitDeadline;
  gitDeadline = Date.now() + (budgetOverride[pass] ?? EVIDENCE_BUDGET_MS[pass]);
  try {
    return read();
  } finally {
    gitDeadline = saved;
  }
}

/**
 * What no child process of the review is handed: the model credential and everything that
 * redirects or federates it (every `ANTHROPIC_*` variable, in any case, because a name that only
 * looks different is not worth the risk); the request for an identity token
 * (`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, which the runner puts in
 * every step of a job with `id-token: write`, and with which a holder can mint a token for the
 * federation; the workflow minted the one the SDK reads in an earlier step, into a file); and the
 * callback token the job posts its report with.
 */
const WITHHELD_FROM_CHILDREN =
  /^(?:ANTHROPIC_|ACTIONS_ID_TOKEN_REQUEST_|PR_REVIEW_CALLBACK_TOKEN$)/i;

/**
 * The environment every child of the review is run with, here and in the calibration script
 * (`pr-review-calibrate.ts`): `env` (this process's own, read when the child starts, unless a test
 * hands one in) without the variables of {@link WITHHELD_FROM_CHILDREN}, and with no prompt and no
 * system git configuration. The children are `git`, which reads a contributor's objects and has no
 * use for either credential, and `gh`. Everything else stays, which is what they need: `PATH`,
 * `HOME`, and what `gh` signs in with (`GH_TOKEN`, `GITHUB_TOKEN`, its configuration directory).
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!WITHHELD_FROM_CHILDREN.test(name)) kept[name] = value;
  }
  return { ...kept, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

/** The most output one git call may produce unless it says otherwise. */
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

/** What one git call may add to the pass's bounds (see {@link runGit}). */
interface GitCallOptions {
  /** Bytes written to the call's standard input; without them its input is closed. */
  input?: Buffer;
  /**
   * When this one call must be over (epoch ms), on top of the pass's budget. A call past it is
   * {@link CallExpired}, never `timed_out`: the pass itself still has time.
   */
  deadline?: number;
  /** The most output the call may produce; {@link MAX_GIT_OUTPUT} unless given. */
  maxBuffer?: number;
}

/**
 * A call reached its own deadline ({@link GitCallOptions.deadline}) before the pass's budget ran
 * out. Not an {@link EvidenceError}: what an expired call means is its caller's to say, and
 * {@link tryGit} and {@link tryGitBytes} turn it into null like any other failure.
 */
class CallExpired extends Error {}

/**
 * One git call, bounded by what is left of the pass's budget and by its own deadline, if it has
 * one. Running out of the pass's budget, before the call or during it, is {@link EvidenceError}
 * `timed_out`, which no caller swallows; running out of the call's own deadline first is
 * {@link CallExpired}; any other failure is thrown as git's own error, for the caller to turn into
 * its word.
 */
function runGit(
  dir: string,
  args: string[],
  encoding: "utf8" | "latin1",
  call?: GitCallOptions,
): string;
function runGit(dir: string, args: string[], encoding: "buffer", call?: GitCallOptions): Buffer;
function runGit(
  dir: string,
  args: string[],
  encoding: "utf8" | "latin1" | "buffer",
  call: GitCallOptions = {},
): string | Buffer {
  const started = Date.now();
  const passLeft = gitDeadline === null ? Number.POSITIVE_INFINITY : gitDeadline - started;
  const callLeft = call.deadline === undefined ? Number.POSITIVE_INFINITY : call.deadline - started;
  if (passLeft <= 0) throw new EvidenceError("timed_out");
  // For a call with no time left at all: a timeout of 0 means no timeout to `execFileSync`, so the
  // call would run unbounded and the pass's own deadline would be ignored with it. A negative one
  // is refused by the runtime anyway, so the zero is what this guard is for.
  if (callLeft <= 0) throw new CallExpired();
  const timeout = Math.min(passLeft, callLeft);
  const options: ExecFileSyncOptions = {
    encoding,
    maxBuffer: call.maxBuffer ?? MAX_GIT_OUTPUT,
    env: childEnv(),
    stdio: [call.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(call.input === undefined ? {} : { input: call.input }),
    ...(Number.isFinite(timeout) ? { timeout } : {}),
  };
  try {
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
      options,
    );
  } catch (e) {
    if ((e as { code?: unknown }).code === "ETIMEDOUT") {
      throw callLeft < passLeft ? new CallExpired() : new EvidenceError("timed_out");
    }
    throw e;
  }
}

/**
 * The same call as {@link tryGit} but with the bytes kept: each byte becomes the one character with
 * that code (latin1), so two blobs that differ only in bytes that are not valid UTF-8 (`caf\xe9`
 * and `caf\xe8`) are still different strings. Decoding them as UTF-8 would turn both into the same
 * replacement characters.
 */
function tryGitBytes(dir: string, args: string[]): string | null {
  try {
    return runGit(dir, args, "latin1");
  } catch (e) {
    if (e instanceof EvidenceError) throw e;
    return null;
  }
}

/** A git call whose failure is null, for the caller to name; running out of time is thrown. */
function tryGit(dir: string, args: string[]): string | null {
  try {
    return runGit(dir, args, "utf8");
  } catch (e) {
    if (e instanceof EvidenceError) throw e;
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
 * The `Version` and the `Name` in `dataset_description.json` at a revision. Either is null when the
 * file has none: an absent file, a file that is not JSON, a missing field, a `Version` that is not
 * `X.Y.Z`, a `Name` that is not a string or shows a reader nothing (empty, blanks, or only
 * characters nobody sees, see `hasVisibleText`). A file that EXISTS but cannot be read is not "no
 * version": it is an {@link EvidenceError}, so a failed fetch of a blob cannot pass as "this
 * dataset has no version".
 */
function descriptionAt(dir: string, rev: string): { version: string | null; name: string | null } {
  // Ask the TREE whether the file exists: that needs no blob, so a blob that cannot be fetched
  // is told apart from a file that is not there.
  const entry = tryGit(dir, ["ls-tree", rev, "--", "dataset_description.json"]);
  if (entry === null) throw new EvidenceError("tree_unreadable");
  if (entry.trim() === "") return { version: null, name: null };
  const raw = tryGit(dir, ["show", `${rev}:dataset_description.json`]);
  if (raw === null) throw new EvidenceError("description_unreadable");
  try {
    const parsed: unknown = JSON.parse(raw);
    const doc =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const v = doc.Version;
    const n = doc.Name;
    return {
      version: typeof v === "string" && SEMVER.test(v) ? v : null,
      // A name that shows nothing is no name to ask the naming rule about: it is unreadable, and
      // a changed one is `unchecked`, never clean.
      name: typeof n === "string" && hasVisibleText(n) ? n : null,
    };
  } catch {
    return { version: null, name: null };
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

/** An order that does not depend on the runtime's locale, so every machine reads files in the same order. */
function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const STATUS_RANK: Record<ChangeStatus, number> = { removed: 0, modified: 1, added: 2 };

/** The order a reviewer would open files in: removed, then modified, then added; within each, the files that describe the dataset first and recordings last. */
function byReviewOrder(a: RawChange, b: RawChange): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    AREA_PRIORITY[classifyPath(a.path)] - AREA_PRIORITY[classifyPath(b.path)] ||
    codeUnitOrder(a.path, b.path)
  );
}

/** The shape of a path: subject, session and run labels replaced by `*`. `task-` and `acq-` are kept. */
export function pathPattern(path: string): string {
  return path
    .replace(/(?<![A-Za-z0-9-])sub-[^/_.]+/g, "sub-*")
    .replace(/(?<![A-Za-z0-9-])ses-[^/_.]+/g, "ses-*")
    .replace(/(?<![A-Za-z0-9-])run-[^/_.]+/g, "run-*");
}

/** A regular file: the only kind whose text can be compared for a cosmetic change. */
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/** The object id git writes for the side of a change that does not exist. */
const ZERO_OID = "0".repeat(40);

/**
 * One changed path as `git diff --raw` names it: its status, the mode and the object id on each
 * side (`000000` and {@link ZERO_OID} for a side that does not exist). A type change (`T`: a
 * regular file to a symlink, say) is its own status here, though the change list calls it
 * modified. A submodule keeps its mode, `160000`.
 */
export interface RawEntry {
  status: "added" | "modified" | "removed" | "typechange";
  modeBefore: string;
  modeAfter: string;
  oidBefore: string;
  oidAfter: string;
  path: string;
}

/** One meta token of `git diff --raw -z --no-abbrev`: two modes, two full ids, one status. */
const RAW_META = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDT])$/;
const RAW_STATUS: Readonly<Record<string, RawEntry["status"]>> = {
  A: "added",
  M: "modified",
  D: "removed",
  T: "typechange",
};

/**
 * Parse `git diff --raw -z --no-renames --no-abbrev` output, by path. Null when any of it is not
 * what that command writes: a meta token of another shape (an abbreviated or a 64-hex id, a status
 * other than A, M, D or T), an empty path, a path given twice, or a token with no path after it.
 * Null is "git could not say", which its caller treats as knowing no mode and no id at all.
 */
export function parseRawEntries(raw: string): Map<string, RawEntry> | null {
  const out = new Map<string, RawEntry>();
  if (raw === "") return out;
  if (!raw.endsWith("\0")) return null;
  const parts = raw.slice(0, -1).split("\0");
  if (parts.length % 2 !== 0) return null;
  for (let i = 0; i < parts.length; i += 2) {
    const m = RAW_META.exec(parts[i] as string);
    const path = parts[i + 1] as string;
    if (m === null || path === "" || out.has(path)) return null;
    out.set(path, {
      status: RAW_STATUS[m[5] as string] as RawEntry["status"],
      modeBefore: m[1] as string,
      modeAfter: m[2] as string,
      oidBefore: m[3] as string,
      oidAfter: m[4] as string,
      path,
    });
  }
  return out;
}

/**
 * The status, modes and object ids of every changed path (see {@link parseRawEntries}). Full ids,
 * never abbreviations, so a repository whose ids are not 40-hex fails the parse instead of handing
 * out ids that name nothing. Null when git could not say, in which case no file is proven cosmetic.
 */
function rawEntries(dir: string, mergeBase: string, head: string): Map<string, RawEntry> | null {
  const raw = tryGit(dir, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", mergeBase, head]);
  return raw === null ? null : parseRawEntries(raw);
}

/**
 * Read blobs by their ids with two processes: `git cat-file --batch-check` for every id's type and
 * size (no content), then `git cat-file --batch` for the blobs within the caps. Only full ids are
 * asked about: an id that is not 40 lowercase hex, and the zero id, are dropped before any process
 * starts, so no name a revision could resolve (`HEAD`, `rev:path`) ever reaches git's input. Ids
 * are taken once each, in the order first given.
 *
 * A blob over `maxBytes` is left out, and so is every id from the first blob that would bring the
 * total past `maxTotalBytes`, a smaller later one included (the prefix rule the summary keeps for
 * its own bytes). An id git says is `missing`, or names a tree, a commit or a tag, is left out too.
 * Left out is never an empty buffer: its caller reads it as a file it could not read.
 *
 * Null when the answer cannot be trusted or was not had: output of another shape, a call that
 * failed, or one past `deadline` (its own, on top of the pass's budget). Null is "could not say",
 * which is not "every blob was missing". Running out of the pass's budget is still
 * {@link EvidenceError} `timed_out`, thrown.
 */
export function readBlobs(
  dir: string,
  oids: readonly string[],
  caps: { maxBytes: number; maxTotalBytes: number },
  deadline?: number,
): Map<string, Buffer> | null {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const oid of oids) {
    if (!SHA40.test(oid) || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    ids.push(oid);
  }
  const blobs = new Map<string, Buffer>();
  if (ids.length === 0) return blobs;
  const bound = deadline === undefined ? {} : { deadline };
  try {
    const answer = runGit(dir, ["cat-file", "--batch-check"], "utf8", {
      ...bound,
      input: Buffer.from(`${ids.join("\n")}\n`),
    });
    // The checks on what git answers here and below (the number of lines, the shape of each line,
    // the header of each blob, the LF after it and the end of the output) guard against output only
    // a fake or a broken git could produce. Real git cannot be made to, and fakes are not used
    // (.rules/testing.md), so these branches are not tested.
    const lines = answer.split("\n");
    if (lines.pop() !== "" || lines.length !== ids.length) return null;
    const selected: { id: string; size: number }[] = [];
    let total = 0;
    let exhausted = false;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string;
      const line = lines[i] as string;
      if (line === `${id} missing`) continue;
      const m = /^([0-9a-f]{40}) (blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(line);
      if (m === null || m[1] !== id) return null;
      if (m[2] !== "blob" || exhausted) continue;
      const size = Number(m[3]);
      if (size > caps.maxBytes) continue;
      if (total + size > caps.maxTotalBytes) {
        exhausted = true;
        continue;
      }
      total += size;
      selected.push({ id, size });
    }
    if (selected.length === 0) return blobs;
    const out = runGit(dir, ["cat-file", "--batch"], "buffer", {
      ...bound,
      input: Buffer.from(`${selected.map((s) => s.id).join("\n")}\n`),
      maxBuffer: total + selected.length * 128 + 65_536,
    });
    let at = 0;
    for (const { id, size } of selected) {
      const nl = out.indexOf(0x0a, at);
      if (nl < 0 || out.toString("latin1", at, nl) !== `${id} blob ${size}`) return null;
      const end = nl + 1 + size;
      if (end >= out.length || out[end] !== 0x0a) return null;
      blobs.set(id, out.subarray(nl + 1, end));
      at = end + 1;
    }
    return at === out.length ? blobs : null;
  } catch (e) {
    // Swallowing this too would give the same result for the pass: its budget is spent, so the next
    // git call throws `timed_out` again at once. It is rethrown so the code says what happens.
    if (e instanceof EvidenceError) throw e;
    return null;
  }
}

/** JSON text with the whitespace outside strings removed: two texts that agree are the same token stream. */
export function stripJsonWhitespace(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      out += ch;
    }
  }
  return out;
}

/** Whether `text` is valid JSON. The value is not used: a change that breaks the file is never cosmetic. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `before` and `after` differ only cosmetically for the kind of file `path` is. Both are
 * the blobs' bytes as latin1 (see {@link tryGitBytes}), so a byte that is not valid UTF-8 is a
 * difference like any other.
 *  - `.json`: both parse, and they are the same once whitespace outside strings is removed. A
 *    change that merges tokens (`[1 2]` to `[12]`) breaks the JSON and so is not cosmetic.
 *  - `.tsv`: the same once spaces and carriage returns at the end of each line are removed, where
 *    the run is not preceded by a tab: a trailing tab, and a cell holding only spaces, are data.
 */
export function isCosmeticChange(path: string, before: string, after: string): boolean {
  if (path.endsWith(".json")) {
    return (
      parsesAsJson(before) &&
      parsesAsJson(after) &&
      stripJsonWhitespace(before) === stripJsonWhitespace(after)
    );
  }
  if (path.endsWith(".tsv")) {
    const trim = (t: string) =>
      t
        .split("\n")
        .map((line) => line.replace(/(?<!\t)[ \r]+$/, ""))
        .join("\n");
    return trim(before) === trim(after);
  }
  return false;
}

/**
 * The text of the dataset's change log at `rev`: every CHANGES or CHANGELOG blob at the root,
 * joined. Null when there is none. A name that is a directory, a symlink or a submodule is not a
 * change log. An unreadable tree or blob is an {@link EvidenceError}, never "no change log".
 */
function changelogAt(dir: string, rev: string): string | null {
  const listing = tryGit(dir, ["ls-tree", "-z", rev]);
  if (listing === null) throw new EvidenceError("tree_unreadable");
  const texts: string[] = [];
  for (const entry of listing.split("\0").filter(Boolean)) {
    const m = entry.match(/^(\d{6}) blob [0-9a-f]+\t(.+)$/s);
    if (!m?.[1] || !m[2] || !REGULAR_FILE_MODES.has(m[1]) || !CHANGELOG_NAME.test(m[2])) continue;
    const text = tryGit(dir, ["show", `${rev}:${m[2]}`]);
    if (text === null) throw new EvidenceError("changelog_unreadable");
    texts.push(text);
  }
  return texts.length === 0 ? null : texts.join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A heading for `version`: a line that starts with it, after any spaces, `#` marks or `[`, and an
 * optional `v`, `version` or `release` (with an optional `:`). A bullet that happens to start with
 * the number is not a heading, and neither is `1.0.1-beta` or `1.0.10`. The text is tested one line
 * at a time, so a hostile file of blank lines cannot make the match quadratic.
 */
function hasHeadingFor(text: string, version: string): boolean {
  const re = new RegExp(
    `^[ \\t#\\[]*(?:(?:v|version|release):?[ \\t]*)?${escapeRegExp(version)}(?![0-9A-Za-z_-]|\\.[0-9])`,
    "i",
  );
  return text.split("\n").some((line) => re.test(line));
}

function changelogEntryFor(
  dir: string,
  mergeBase: string,
  headSha: string,
  version: string | null,
): ChangelogEntry {
  // With no version to look for the platform cannot tell, whatever the log holds: an unknown is
  // never turned into a failure.
  if (version === null) return "unknown_version";
  const after = changelogAt(dir, headSha);
  if (after === null) return "no_file";
  const before = changelogAt(dir, mergeBase);
  return hasHeadingFor(after, version) && !hasHeadingFor(before ?? "", version)
    ? "added"
    : "not_added";
}

/**
 * What one file's diff says once the file's name is taken out: the lines of `git diff` before the
 * first hunk, less the ones that name the file (`diff --git`, `---` and `+++`, and the object ids of
 * the `index` line, whose mode stays), then every hunk exactly as git wrote it. Two files with the
 * same signature were changed in the same way, line for line, at the same lines, and have the same
 * kind and mode: a bulk edit that repeats one change across subjects reads as one change, and a
 * symlink or an executable is never one with a regular file. It is exact, with no masking of
 * anything in the content, so a signature never matches two changes that differ in a byte; pass it
 * the diff as latin1 bytes (see {@link tryGitBytes}) so that bytes which are not valid UTF-8 differ
 * too. Null for a diff with no hunk (a binary file, a mode change alone), which is never folded.
 */
export function diffSignature(diff: string): string | null {
  const at = diff.search(/^@@ /m);
  if (at < 0) return null;
  const header = diff
    .slice(0, at)
    .split("\n")
    .flatMap((line) => {
      if (/^(diff --git |--- |\+\+\+ )/.test(line)) return [];
      if (!line.startsWith("index ")) return [line];
      // The object ids name the blobs and differ for every file; the mode, which git prints only
      // here when it did not change, is what tells a symlink or an executable from a regular file.
      const m = line.match(/^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d{6}))?$/);
      if (m === null) return [line];
      return m[1] === undefined ? [] : [`mode ${m[1]}`];
    });
  return `${header.join("\n")}\n${diff.slice(at)}`;
}

/**
 * The metadata files a review would read, in the order it would read them: removals and
 * modifications first, because that is where a loss hides, and additions last, so a budget that runs
 * out costs the least important reads.
 */
function readableChanges(changes: readonly RawChange[]): RawChange[] {
  return changes.filter((c) => READABLE_AREAS.has(classifyPath(c.path))).sort(byReviewOrder);
}

/** Removed shapes first, then modified, then added; within a status the largest first. */
function byShapeOrder(a: PathShape, b: PathShape): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.files - a.files ||
    codeUnitOrder(a.pattern, b.pattern)
  );
}

/**
 * Read what `headSha` changes relative to the point it branched from `baseSha`, without reading
 * any file's content but `dataset_description.json`'s: the screen's whole view.
 *
 * `baseSha` is the tip of `main`; the diff is taken against the merge base, so a pull request
 * is judged on what IT changes and not on what `main` gained since. Throws {@link EvidenceError}
 * when the commits are not present or share no history, or when the pass runs past its share of
 * {@link EVIDENCE_BUDGET_MS}. Every call here reads a tree, a commit or that one file, so a partial
 * clone fetches no other blob for it.
 */
export function gatherListing(dir: string, baseSha: string, headSha: string): Listing {
  return withinBudget("listing", () => readListing(dir, baseSha, headSha));
}

function readListing(dir: string, baseSha: string, headSha: string): Listing {
  requireSha(baseSha);
  requireSha(headSha);
  const mergeBase = tryGit(dir, ["merge-base", baseSha, headSha])?.trim();
  if (!mergeBase || !SHA40.test(mergeBase)) throw new EvidenceError("no_merge_base");

  const raw = tryGit(dir, ["diff", "--name-status", "-z", "--no-renames", mergeBase, headSha]);
  if (raw === null) throw new EvidenceError("changes_unreadable");
  const changes = parseNameStatus(raw);

  const shapeMap = new Map<string, PathShape>();
  for (const c of readableChanges(changes)) {
    const pattern = pathPattern(c.path);
    const key = `${c.status}\t${pattern}`;
    const shape = shapeMap.get(key) ?? { status: c.status, pattern, files: 0 };
    shape.files++;
    shapeMap.set(key, shape);
  }
  // Removed shapes first: that is where a loss hides, and the cut must never take them.
  const ordered = [...shapeMap.values()].sort(byShapeOrder);

  const before = descriptionAt(dir, mergeBase);
  const after = descriptionAt(dir, headSha);
  // A removed file has no name to read, and its removal is a fact of its own.
  const descriptionKept = changes.some(
    (c) => c.path === "dataset_description.json" && c.status !== "removed",
  );
  // An empty list would read to the model as "no commits", so a failed read is an error.
  const log = tryGit(dir, ["log", "--format=%s", `-n${MAX_COMMITS}`, `${mergeBase}..${headSha}`]);
  if (log === null) throw new EvidenceError("commits_unreadable");
  return {
    mergeBase,
    head: headSha,
    changes,
    commits: log.split("\n").filter(Boolean),
    versionBefore: before.version,
    versionAfter: after.version,
    nameBefore: before.name,
    nameAfter: after.name,
    nameUnreadable: descriptionKept && after.name === null,
    subjectsBefore: subjectsAt(dir, mergeBase),
    subjectsAfter: subjectsAt(dir, headSha),
    listCut: changes.length > MAX_MODEL_FILES,
    changelogTouched: changes.some((c) => c.status !== "removed" && CHANGELOG_NAME.test(c.path)),
    shapes: ordered.slice(0, MAX_GROUPS),
    shapesOmittedFiles: ordered.slice(MAX_GROUPS).reduce((n, g) => n + g.files, 0),
  };
}

/**
 * At most this many files the change summary accounted for are also shown as a diff, after every
 * file it did not account for and only while there is room: an illustration of what the summary
 * says, whose cut or absence changes nothing about what was read.
 */
export const MAX_ILLUSTRATION_PATCHES = 3;

/** The after side a pool file is given when its blob could not be read: no parser accepts it. */
const EMPTY_BYTES = new Uint8Array(0);

/**
 * The line git writes in place of a diff it takes for binary: a file with a NUL byte in either
 * version, a `.tsv` or a `.json` among them. It names the file and shows none of its content, so a
 * row removed from such a table is in no line the reviewer could read. Such a diff makes no patch:
 * the file stays unread (a modified or removed one keeps the content incomplete) and takes no slot.
 * A change of mode alone prints no such line, because the content is the same, and stays shown.
 *
 * Matched only as a whole line between line feeds (or the start or end of the output), the way
 * git writes it: git ends every line it writes with a line feed, every line of a text diff's
 * content starts with a space, `+`, `-`, `@` or `\`, and a path with a line break or another
 * control character in it is quoted. A carriage return is not a line break here: a cell that holds
 * a bare carriage return followed by these words is still inside one diff line that starts with a
 * space, `+` or `-`, so it cannot forge this line (a match that took a carriage return for the
 * start of a line, as the `m` flag does, would leave such a text table unread).
 */
const BINARY_DIFF = /(?:^|\n)Binary files [^\n]* differ(?:\n|$)/;

/** What a test may set for one content pass; production passes nothing. */
export interface ContentOptions {
  /**
   * The clock the change summary is started and stopped by: `Date.now` unless given. Only the
   * summary reads it; every git call's timeout and the search for repeats keep the real clock.
   */
  now?: () => number;
}

/**
 * Read what only the full review is shown, for a listing {@link gatherListing} made: the cosmetic
 * proofs, the change summary, the diffs of the changed metadata files that fit the budget, and the
 * change log. Called only when the screen let the pull request through, and bounded by its share of
 * {@link EVIDENCE_BUDGET_MS}.
 */
export function gatherContent(
  dir: string,
  listing: Listing,
  options: ContentOptions = {},
): ContentFacts {
  return withinBudget("content", () => readContent(dir, listing, options));
}

/**
 * The change summary of the candidates: the modified `.tsv` and `.json` files that were compared
 * for a cosmetic change, are not cosmetic, and are not the README or the change log. Every other
 * outcome is a summary that accounts for nothing, so the raw diffs read the pull request exactly as
 * they would without one:
 *
 * - no candidate: {@link EMPTY_SUMMARY};
 * - less than `timeReserveMs` of the pass left: {@link ABANDONED_SUMMARY}, and nothing more is
 *   read. The reserve is the raw diffs' and the change log's, so the summary never costs them their
 *   time;
 * - the pool's blobs could not be read, or not before the summary's deadline:
 *   {@link ABANDONED_SUMMARY}, and the pass goes on;
 * - past its deadline while it runs: abandoned by {@link summarizeChanges} itself.
 *
 * The pool is every added or modified `.tsv` and `.json` file, in path order, that a candidate can
 * consult ({@link poolFileMatters}): a table at `sourcedata/<D>/<a candidate's path>`, where a
 * removed row may have been kept, and a sidecar that applies to a candidate, which a moved key may
 * have reached or which may stop a move past it. No other file can change what the summary says,
 * so its blobs are not read at all; `summarizeChanges` prunes with the same predicate. A JSON path
 * whose blob is not a regular file at the head (a type change, a symlink, a submodule), or could
 * not be read, is in the pool as a document that cannot be read, so it still stops a key from
 * being read as moved past it. A table that cannot be read is left out, so nothing can be found
 * kept in it. A side that could not be read is never handed on as a missing one, which would say
 * the file was added.
 */
function changeSummary(
  dir: string,
  entries: ReadonlyMap<string, RawEntry> | null,
  checkedBlobs: ReadonlyMap<string, Buffer>,
  candidates: readonly SummaryCandidate[],
  now: () => number,
): ChangeSummary {
  if (entries === null || candidates.length === 0) return EMPTY_SUMMARY;
  const deadline = gitDeadline === null ? null : gitDeadline - SUMMARY_LIMITS.timeReserveMs;
  if (deadline !== null && now() >= deadline) return ABANDONED_SUMMARY;

  const matters = poolFileMatters(candidates.map((c) => c.path));
  const sides: { entry: RawEntry; regular: boolean }[] = [];
  for (const entry of [...entries.values()].sort((a, b) => codeUnitOrder(a.path, b.path))) {
    const json = entry.path.endsWith(".json");
    if (entry.status === "removed" || (!json && !entry.path.endsWith(".tsv"))) continue;
    if (!matters(entry.path)) continue;
    const regular =
      (entry.status === "added" || entry.status === "modified") &&
      REGULAR_FILE_MODES.has(entry.modeAfter);
    if (regular || json) sides.push({ entry, regular });
  }
  // The blobs the cosmetic proofs already read are not read again, and count toward the bound.
  // The subtraction binds only when those blobs and the pool's pass `maxTotalBytes` (256 MiB) in
  // all; no test builds that much data, so it is read, not run.
  let held = 0;
  for (const blob of checkedBlobs.values()) held += blob.length;
  const poolBlobs = readBlobs(
    dir,
    sides
      .filter((side) => side.regular)
      .flatMap(({ entry }) =>
        entry.status === "modified" ? [entry.oidBefore, entry.oidAfter] : [entry.oidAfter],
      )
      .filter((id) => !checkedBlobs.has(id)),
    { maxBytes: SUMMARY_LIMITS.maxBlobBytes, maxTotalBytes: SUMMARY_LIMITS.maxTotalBytes - held },
    deadline ?? undefined,
  );
  if (poolBlobs === null) return ABANDONED_SUMMARY;
  const blobOf = (id: string): Buffer | undefined => checkedBlobs.get(id) ?? poolBlobs.get(id);
  const pool: PoolFile[] = [];
  for (const { entry, regular } of sides) {
    const after = regular ? blobOf(entry.oidAfter) : undefined;
    const before = entry.status === "modified" ? blobOf(entry.oidBefore) : null;
    if (after === undefined || before === undefined) {
      if (entry.path.endsWith(".json")) {
        pool.push({ path: entry.path, before: null, after: EMPTY_BYTES });
      }
      continue;
    }
    pool.push({ path: entry.path, before, after });
  }
  return summarizeChanges({ candidates, pool, deadline, now });
}

function readContent(dir: string, listing: Listing, options: ContentOptions): ContentFacts {
  const { mergeBase } = listing;
  const headSha = listing.head;
  const wanted = readableChanges(listing.changes);

  // A modified file that differs only cosmetically needs no reading: nothing in it was lost. The
  // test is exact (see GitFacts.cosmeticOnlyFiles) and falls back to "not cosmetic" whenever git
  // cannot say, a mode changed, or the cap on comparisons is reached.
  // The review job works in a partial clone, where reading a missing blob is a network round trip
  // of its own: 124 seconds for 89 changed files when each `git show` fetched alone. One diff over
  // the whole range asks for every blob it needs in a single batched fetch, so the reads below are
  // local. Its output is not used, and a failure here only makes the reads slower.
  tryGit(dir, [
    "diff",
    "--numstat",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    mergeBase,
    headSha,
  ]);
  const entries = rawEntries(dir, mergeBase, headSha);
  // The files whose two blobs are compared: modified on both lists, a regular file on both sides
  // with the same mode, a `.json` or a `.tsv`, at most MAX_COSMETIC_CHECKS of them in review order.
  const checked: { path: string; entry: RawEntry }[] = [];
  for (const c of wanted) {
    if (entries === null || checked.length >= MAX_COSMETIC_CHECKS) break;
    if (c.status !== "modified") continue;
    if (!c.path.endsWith(".json") && !c.path.endsWith(".tsv")) continue;
    const entry = entries.get(c.path);
    if (
      entry === undefined ||
      entry.status !== "modified" ||
      entry.modeBefore !== entry.modeAfter ||
      !REGULAR_FILE_MODES.has(entry.modeBefore)
    ) {
      continue;
    }
    checked.push({ path: c.path, entry });
  }
  // Both sides of every checked file in one batch, two processes in all instead of two per file.
  // No deadline of its own: a read that stalls here stalls the pass, which is `timed_out`, as a
  // stalled `git show` was. Each blob may be as large as the whole bound, so a proof never depends
  // on the summary's per-file cap; a blob that cannot be read leaves its file unproven.
  const checkedBlobs =
    readBlobs(
      dir,
      checked.flatMap((f) => [f.entry.oidBefore, f.entry.oidAfter]),
      { maxBytes: SUMMARY_LIMITS.maxTotalBytes, maxTotalBytes: SUMMARY_LIMITS.maxTotalBytes },
    ) ?? new Map<string, Buffer>();
  const cosmeticOnly = new Set<string>();
  const candidates: SummaryCandidate[] = [];
  for (const { path, entry } of checked) {
    const before = checkedBlobs.get(entry.oidBefore);
    const after = checkedBlobs.get(entry.oidAfter);
    if (before === undefined || after === undefined) continue;
    // As latin1, so bytes that are not valid UTF-8 still differ (see tryGitBytes).
    if (isCosmeticChange(path, before.toString("latin1"), after.toString("latin1"))) {
      cosmeticOnly.add(path);
    } else if (classifyPath(path) !== "readme_and_changes") {
      // The README and the change log are prose, read as diffs, never as tables or documents.
      candidates.push({ path, before, after });
    }
  }
  const summary = changeSummary(dir, entries, checkedBlobs, candidates, options.now ?? Date.now);
  const accounted = summary.accounted;

  const patches: Patch[] = [];
  const read = new Map<string, Patch>();
  // The patch that already shows a change, by status and the hash of its diff's signature.
  const shownBy = new Map<string, Patch>();
  let budget = MAX_PATCH_TOTAL_CHARS;
  const full = (): boolean => patches.length >= MAX_PATCH_FILES || budget <= 0;
  const late = (): boolean =>
    gitDeadline !== null && gitDeadline - Date.now() < FOLD_TIME_RESERVE_MS;
  /**
   * Read one file's diff: fold it onto the patch that already shows it, or show it if there is
   * room. A diff git wrote as binary is no read at all: see {@link BINARY_DIFF}.
   */
  const showDiff = (c: RawChange): void => {
    const bytes = tryGitBytes(dir, [
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
    if (bytes === null || bytes === "" || BINARY_DIFF.test(bytes)) return;
    const signature = diffSignature(bytes);
    // What the model reads is the text, as before: the same bytes decoded as UTF-8.
    const diff = Buffer.from(bytes, "latin1").toString("utf8");
    const key =
      signature === null
        ? null
        : `${c.status}\0${createHash("sha256").update(signature).digest("hex")}`;
    const same = key === null ? undefined : shownBy.get(key);
    if (same !== undefined) {
      same.same.push(c.path);
      read.set(c.path, same);
      return;
    }
    if (full()) return;
    const { text, truncated } = clip(diff, Math.min(MAX_PATCH_FILE_CHARS, budget));
    budget -= text.length;
    const patch: Patch = { path: c.path, text, truncated, same: [] };
    patches.push(patch);
    read.set(c.path, patch);
    if (key !== null) shownBy.set(key, patch);
  };
  // The read budget goes to files that are not cosmetic-only, and to each DISTINCT change once: a
  // file whose diff is exactly one already shown is covered by it and costs nothing. It goes first
  // to the removed and modified files the summary did not account for, which nothing else covers;
  // then to a few it did, as illustrations; then to the added files. With nothing accounted for,
  // that is the files in review order, read exactly as they were before the summary existed.
  const toRead = wanted.filter((c) => !cosmeticOnly.has(c.path));
  const first = toRead.filter((c) => c.status !== "added" && !accounted.has(c.path));
  const illustrations = toRead
    .filter((c) => c.status !== "added" && accounted.has(c.path))
    .slice(0, MAX_ILLUSTRATION_PATCHES);
  const added = toRead.filter((c) => c.status === "added");
  // The search for repeats is optional, the first diffs are not: once the patches are full, the
  // search goes on only while time is left. When little is, the files not yet examined stay unread
  // (which fails closed, as always) instead of the pass running out of time and the whole review
  // with it. At most MAX_DIFFS_EXAMINED files are examined, the illustrations not counted.
  let examined = 0;
  const goOn = (): boolean => examined < MAX_DIFFS_EXAMINED && !(full() && late());
  for (const c of first) {
    if (!goOn()) break;
    examined++;
    showDiff(c);
  }
  // An illustration is shown only into room that is left, never in place of a file that needed
  // reading, and only while the pass is not short of time; one that repeats a change already shown
  // folds onto it as any diff does.
  for (const c of illustrations) {
    if (full() || late()) break;
    showDiff(c);
  }
  for (const c of added) {
    if (!goOn()) break;
    examined++;
    showDiff(c);
  }

  // Covered: added, cosmetic, accounted for by the summary, or shown in full. One predicate counts
  // the files that are not and decides whether any is, so the count and the flag cannot drift.
  const unreadFiles = wanted.filter((c) => {
    if (c.status === "added") return false;
    if (cosmeticOnly.has(c.path)) return false;
    if (accounted.has(c.path)) return false;
    const patch = read.get(c.path);
    return patch === undefined || patch.truncated;
  }).length;
  const readIncomplete = unreadFiles > 0;

  const groupMap = new Map<string, PathGroup>();
  for (const c of wanted) {
    const pattern = pathPattern(c.path);
    const key = `${c.status}\t${pattern}`;
    const g = groupMap.get(key) ?? {
      status: c.status,
      pattern,
      files: 0,
      shown: 0,
      cosmeticOnly: 0,
      summarized: 0,
    };
    g.files++;
    const patch = read.get(c.path);
    if (patch !== undefined && !patch.truncated) g.shown++;
    if (cosmeticOnly.has(c.path)) g.cosmeticOnly++;
    if (accounted.has(c.path)) g.summarized++;
    groupMap.set(key, g);
  }
  // Removed shapes first: that is where a loss hides, and the cut must never take them.
  const ordered = [...groupMap.values()].sort(byShapeOrder);

  return {
    patches,
    readIncomplete,
    unreadFiles,
    cosmeticOnlyFiles: cosmeticOnly.size,
    groups: ordered.slice(0, MAX_GROUPS),
    groupsOmittedFiles: ordered.slice(MAX_GROUPS).reduce((n, g) => n + g.files, 0),
    changelogEntry: changelogEntryFor(dir, mergeBase, headSha, listing.versionAfter),
    summary,
  };
}

/** Both passes, for a caller that wants everything the full review is shown. */
export function gatherGitFacts(dir: string, baseSha: string, headSha: string): GitFacts {
  const listing = gatherListing(dir, baseSha, headSha);
  return { ...listing, ...gatherContent(dir, listing) };
}

// ---------------------------------------------------------------------------------------------
// The deterministic account
// ---------------------------------------------------------------------------------------------

function emptyAreas(): Record<Area, AreaCounts> {
  const out = {} as Record<Area, AreaCounts>;
  for (const a of AREAS) out[a] = { added: 0, modified: 0, removed: 0 };
  return out;
}

/** The parts of the evidence block a listing alone decides, and the text facts. */
function listedEvidence(listing: Listing, text: TextFacts) {
  const areas = emptyAreas();
  for (const c of listing.changes) areas[classifyPath(c.path)][c.status]++;
  const listed: ChangedFile[] = [...listing.changes].sort(byReviewOrder).slice(0, MAX_LISTED);
  return {
    files_changed: listing.changes.length,
    version_before: listing.versionBefore,
    version_after: listing.versionAfter,
    subjects_before: listing.subjectsBefore,
    subjects_after: listing.subjectsAfter,
    areas,
    listed,
    description_empty: text.descriptionEmpty,
    description_cut: text.descriptionCut,
    title_problem: text.titleProblem,
    name_problem: text.nameProblem,
  };
}

/**
 * The report's evidence block for a full review, from git and the text facts alone. Every change is
 * counted in exactly one area, so the areas add up to `files_changed` by construction (the Worker
 * refuses a report where they do not). The file list is the first {@link MAX_LISTED} a reviewer
 * would open, in {@link byReviewOrder}.
 */
export function buildEvidence(facts: GitFacts, text: TextFacts): ReviewEvidence {
  return {
    ...listedEvidence(facts, text),
    files_read: filesRead(facts),
    truncated: facts.listCut || facts.readIncomplete,
    changelog_entry: facts.changelogEntry,
  };
}

/**
 * How many changed files were read: the files the change summary accounted for, the file each diff
 * was shown for, and the files a diff shown in full repeats in (a diff that was cut stands for no
 * other file, though its own file still counts). A set, so a file that was both accounted for and
 * shown counts once. Every member is a path of the change list, so the count never exceeds
 * `files_changed`; with nothing accounted for it is the count of the diffs and their repeats.
 */
function filesRead(facts: ContentFacts): number {
  const read = new Set<string>(facts.summary.accounted);
  for (const patch of facts.patches) {
    read.add(patch.path);
    if (!patch.truncated) for (const path of patch.same) read.add(path);
  }
  return read.size;
}

/**
 * The evidence block of a report that ended before the review read any content, at the screen or at
 * the facts: the same account, built from the listing alone, and no content read. `truncated` keeps
 * its meaning: the change list was cut, or a modified or removed metadata file was not shown, which,
 * with nothing read, is any such file at all. The change log is content, so it was not read either:
 * `changelog_entry` is null.
 */
export function buildListingEvidence(listing: Listing, text: TextFacts): ReviewEvidence {
  return {
    ...listedEvidence(listing, text),
    files_read: 0,
    truncated:
      listing.listCut || readableChanges(listing.changes).some((c) => c.status !== "added"),
    changelog_entry: null,
  };
}
