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
 * shown either, because there is nothing in it to read.
 *
 * **One change repeated across many files is read once.** A bulk edit often makes the same change in
 * every subject's sidecar. A file whose diff is exactly one already shown, line for line (see
 * {@link diffSignature}), is not shown again: it is counted on the patch that shows the change
 * ({@link Patch.same}), costs none of the file or character budget, and counts as read exactly when
 * that diff was shown in full. The match is exact, so a change that differs in one byte is shown.
 */

import { execFileSync } from "node:child_process";
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
   * not fit the file or character budget, its diff was cut, or reading it failed. A file the
   * platform proved cosmetic-only ({@link cosmeticOnlyFiles}) is not counted.
   */
  readIncomplete: boolean;
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

/**
 * One git call, bounded by what is left of the pass's budget. Running out, before the call or
 * during it, is {@link EvidenceError} `timed_out`, which no caller swallows; any other failure is
 * thrown as git's own error, for the caller to turn into its word.
 */
function runGit(dir: string, args: string[], encoding: "utf8" | "latin1"): string {
  let timeout: number | undefined;
  if (gitDeadline !== null) {
    timeout = gitDeadline - Date.now();
    if (timeout <= 0) throw new EvidenceError("timed_out");
  }
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
      {
        encoding,
        maxBuffer: 256 * 1024 * 1024,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        ...(timeout === undefined ? {} : { timeout }),
      },
    );
  } catch (e) {
    if ((e as { code?: unknown }).code === "ETIMEDOUT") throw new EvidenceError("timed_out");
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

/**
 * The modes of every changed path, old and new, from `git diff --raw`. Null when git could not
 * say, in which case no file is treated as cosmetic.
 */
function modesByPath(
  dir: string,
  mergeBase: string,
  headSha: string,
): Map<string, { before: string; after: string }> | null {
  const raw = tryGit(dir, ["diff", "--raw", "-z", "--no-renames", mergeBase, headSha]);
  if (raw === null) return null;
  const parts = raw.split("\0");
  const out = new Map<string, { before: string; after: string }>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]?.match(/^:(\d{6}) (\d{6}) /);
    const path = parts[i + 1];
    if (meta?.[1] && meta[2] && path) out.set(path, { before: meta[1], after: meta[2] });
  }
  return out;
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
 * Read what only the full review is shown, for a listing {@link gatherListing} made: the cosmetic
 * proofs, the diffs of the changed metadata files that fit the budget, and the change log. Called
 * only when the screen let the pull request through, and bounded by its share of
 * {@link EVIDENCE_BUDGET_MS}.
 */
export function gatherContent(dir: string, listing: Listing): ContentFacts {
  return withinBudget("content", () => readContent(dir, listing));
}

function readContent(dir: string, listing: Listing): ContentFacts {
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
  const modes = modesByPath(dir, mergeBase, headSha);
  let cosmeticChecks = 0;
  const cosmeticOnly = new Set<string>();
  for (const c of wanted) {
    if (c.status !== "modified" || modes === null) continue;
    if (!c.path.endsWith(".json") && !c.path.endsWith(".tsv")) continue;
    const m = modes.get(c.path);
    if (!m || m.before !== m.after || !REGULAR_FILE_MODES.has(m.before)) continue;
    if (cosmeticChecks >= MAX_COSMETIC_CHECKS) continue;
    cosmeticChecks++;
    const before = tryGitBytes(dir, ["show", `${mergeBase}:${c.path}`]);
    const after = tryGitBytes(dir, ["show", `${headSha}:${c.path}`]);
    if (before !== null && after !== null && isCosmeticChange(c.path, before, after)) {
      cosmeticOnly.add(c.path);
    }
  }

  const patches: Patch[] = [];
  const read = new Map<string, Patch>();
  // The patch that already shows a change, by status and the hash of its diff's signature.
  const shownBy = new Map<string, Patch>();
  let budget = MAX_PATCH_TOTAL_CHARS;
  // The read budget goes to files that are not cosmetic-only, and to each DISTINCT change once: a
  // file whose diff is exactly one already shown is covered by it and costs nothing.
  const toRead = wanted.filter((c) => !cosmeticOnly.has(c.path));
  for (const c of toRead.slice(0, MAX_DIFFS_EXAMINED)) {
    // The search for repeats is optional, the first diffs are not: once the patches are full, the
    // search goes on only while time is left. When little is, the files not yet examined stay unread
    // (which fails closed, as always) instead of the pass running out of time and the whole review
    // with it.
    if (
      (patches.length >= MAX_PATCH_FILES || budget <= 0) &&
      gitDeadline !== null &&
      gitDeadline - Date.now() < FOLD_TIME_RESERVE_MS
    ) {
      break;
    }
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
    if (bytes === null || bytes === "") continue;
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
      continue;
    }
    if (patches.length >= MAX_PATCH_FILES || budget <= 0) continue;
    const { text, truncated } = clip(diff, Math.min(MAX_PATCH_FILE_CHARS, budget));
    budget -= text.length;
    const patch: Patch = { path: c.path, text, truncated, same: [] };
    patches.push(patch);
    read.set(c.path, patch);
    if (key !== null) shownBy.set(key, patch);
  }

  const readIncomplete = wanted.some((c) => {
    if (c.status === "added") return false;
    if (cosmeticOnly.has(c.path)) return false;
    const patch = read.get(c.path);
    return patch === undefined || patch.truncated;
  });

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
    };
    g.files++;
    const patch = read.get(c.path);
    if (patch !== undefined && !patch.truncated) g.shown++;
    if (cosmeticOnly.has(c.path)) g.cosmeticOnly++;
    groupMap.set(key, g);
  }
  // Removed shapes first: that is where a loss hides, and the cut must never take them.
  const ordered = [...groupMap.values()].sort(byShapeOrder);

  return {
    patches,
    readIncomplete,
    cosmeticOnlyFiles: cosmeticOnly.size,
    groups: ordered.slice(0, MAX_GROUPS),
    groupsOmittedFiles: ordered.slice(MAX_GROUPS).reduce((n, g) => n + g.files, 0),
    changelogEntry: changelogEntryFor(dir, mergeBase, headSha, listing.versionAfter),
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
    // Each file a diff stands for counts as read, the file it was shown for and the ones it repeats;
    // a diff that was cut stands for no other file.
    files_read: facts.patches.reduce((n, p) => n + (p.truncated ? 1 : 1 + p.same.length), 0),
    truncated: facts.listCut || facts.readIncomplete,
    changelog_entry: facts.changelogEntry,
  };
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
