#!/usr/bin/env bun
/**
 * The pull-request review's offline calibration (ADR 0107): the measurement behind the
 * pre-enforcement calibration gate that ADR records.
 *
 * Before the review check is required, someone has to know how its two stages answer real pull
 * requests: how often a legitimate one is stopped or failed, what each stage costs, and how long
 * each takes. This reads named pull requests with `gh` and `git` (read-only), runs the review job's
 * own stage flow on each with the operator's own Anthropic credential, and prints a table.
 *
 *   bun run scripts/ci/pr-review-calibrate.ts --pr nm000153#2 --pr nemarDatasets/nm000456#1
 *   bun run scripts/ci/pr-review-calibrate.ts --prs FILE [--json]
 *   bun run scripts/ci/pr-review-calibrate.ts --prs FILE --clones DIR [--offline] [--json]
 *
 * FILE holds one pull request per line, `nm000153#2`, optionally followed by the outcome a person
 * expects (`pass`, `fail` or `uncertain`), which adds an agreement column, and optionally by the
 * base and head commits to read it at (`nm000153#2 pass <base> <head>`, full ids): a frozen set of
 * pull requests is read at the commits it was frozen at, not wherever the pull request has moved
 * since. Blank lines and lines that start with `#` are skipped. Pinned commits come only from FILE.
 *
 * **`--clones DIR`** reads each pull request from a clone already made, `DIR/<dataset>-<number>`,
 * at its pinned commits or the ones in `DIR/<dataset>-<number>.shas` (`<base> <head>`), with its
 * title and description from `DIR/<dataset>-<number>.pr.json`; it never runs `gh`, and it checks
 * that the clone holds both commits without fetching either. That check, and `--offline`, rely on
 * git honoring `GIT_NO_LAZY_FETCH`, so a run with `--clones` refuses a git older than 2.45.0, which
 * would fetch (see {@link honorsNoLazyFetch}). **`--offline`** (only with `--clones`) also keeps
 * git from fetching anything else: a clone that lacks a blob of the one diff the content pass
 * prefetches (from the merge base to the head) is `objects_missing` before any pass runs, and any
 * other object the review reads and the clone lacks (an unchanged `dataset_description.json` the
 * listing reads, or a change log the content pass reads) is not fetched, so that pull request ends
 * as `evidence_unavailable`. It sets `GIT_NO_LAZY_FETCH` for the run and restores it after, and it
 * keeps the content pass from asking the clone's origin for the dataset's version tags (the README's
 * anchor, `FetchedPullRequest.offline`): a clone's origin is the public repository, and a frozen
 * set is compared with every merge-base line, the stricter anchor, whatever GitHub holds today;
 * `--offline` changes only git, never the model calls. In every mode, the git a run starts reads
 * neither the operator's nor the system's git configuration, and no variable that would point it
 * at another repository (see {@link scopeRunEnvironment}), so its numbers do not depend on the
 * machine.
 *
 * **`--evidence-only`** asks no model and needs no key: it runs the review's two evidence passes
 * (`gatherListing`, `gatherContent`) and `buildEvidence` on each pull request, as the review would
 * after its screen, and prints what they came to in a table of numbers and closed words (see
 * {@link renderEvidenceTable}): how many files were read, summarized, refused and by what refusal,
 * accounted for, left unread, what the summary's classes are (kind, counts, completeness), its loss
 * facts, and how long each pass took. A pinned pull request is fetched by its ids with no `gh`.
 * **`--without-summary`** (only with `--evidence-only`) never starts the change summary, so the
 * same passes read the pull request as they did before the summary existed. Part B (the original
 * authors' content) starts by the same clock check and is abandoned with it, so every row's PART-B
 * column reads `abandoned`. The normal mode prints
 * the same evidence numbers in a second table under the first, for the pull requests whose content
 * the review read.
 *
 * **It measures what production does, because it runs what production runs.** Each pull request
 * goes through `reviewPullRequest` in `pr-review.ts`: the same facts, the same screen and review,
 * the same models, budgets and prompts, the same report assembly. Only the dispatch's own checks
 * are left out (the pull request must still be open, at the dispatched commit), because a
 * calibration reads pull requests that were merged or closed long ago. The base is the one GitHub
 * recorded on the pull request, so a merged pull request is judged on what it changed then.
 *
 * **It posts nothing.** It never imports the review's callback poster or the callback origin table,
 * it refuses every argument that names a review, an environment or an origin, and it refuses to run
 * where the review's callback token is set. Its network traffic is `gh api` reads, `git fetch` of a
 * public dataset repository, and the model calls.
 *
 * **The operator's key reaches only the API.** It refuses to run while `ANTHROPIC_BASE_URL` or
 * `ANTHROPIC_AUTH_TOKEN` is set (a shell that points the SDK at a gateway would hand it the key),
 * and says which by name, never by value; `--evidence-only` makes no model client at all, so it
 * refuses neither, but it still refuses to run where the callback token is set. Every child it
 * starts, its own `gh` and `git` and the `git` the review's evidence reader runs on a
 * contributor's objects, is started with
 * {@link childEnv} (`pr-review-evidence.ts`): this process's environment without any `ANTHROPIC_*`
 * variable, without any `ACTIONS_ID_TOKEN_REQUEST_*` variable (the request for an identity token,
 * which an Actions runner puts in a step's environment) and without the review's callback token.
 * So the key goes to the SDK in this process and to nothing it starts. No message repeats an
 * argument: a flag is named only if the script knows it (one it accepts, or one it refuses by
 * name), and any other is `unknown flag`, because a key pasted after two dashes looks like one.
 *
 * **What the table holds.** Closed words, counts, token counts, seconds and an estimate in dollars,
 * never a pull request's text or a word a model wrote, so it can be pasted anywhere. Its columns
 * are what the gate reads: the verdict, and whether it agrees with the one a person expected (a
 * false pass or a false fail), the screen's decision (a stop of a legitimate pull request), and
 * whether the review flagged steering, which the gate allows on no legitimate pull request.
 *
 * Exits 0 when every pull request reached a verdict, 1 when any did not (the table says why, in a
 * closed word), and 2 for bad arguments or an environment it refuses to run in. With
 * `--evidence-only`, 0 when every pull request was read and no removal in a file the summary
 * refused is HIDDEN (see {@link refusedDeletions}), 1 otherwise.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Criterion,
  type PrReviewReport,
  type RunError,
  type StageTokens,
  type Verdict,
  conclusionOf,
  estimateCostUsd,
  factsOf,
  verdictOf,
} from "../../shared/pr-review";
import {
  type EvidenceStats,
  MAX_REVIEWABLE_FILES,
  STAGE_BUDGETS,
  type StageObservation,
  evidenceStats,
  isFromFork,
  mapError,
  reviewPullRequest,
  timed,
} from "./pr-review";
import {
  type ContentOptions,
  type GitFacts,
  type TextFacts,
  buildEvidence,
  childEnv,
  gatherContent,
  gatherListing,
} from "./pr-review-evidence";
import { type ClassKind, SUMMARY_REFUSALS, type SummaryRefusal } from "./pr-review-summary";

/** The base and head commits a pull request is read at, both full ids. */
export interface PinnedCommits {
  base: string;
  head: string;
}

/**
 * One pull request to calibrate on, what a person expects of it, if they said, and the commits to
 * read it at, if the line named them (absent otherwise).
 */
export interface CalibrationTarget {
  dataset: string;
  number: number;
  expected: Verdict | null;
  pin?: PinnedCommits;
}

/** What one pull request came to, in closed words and numbers. */
export interface CalibrationRow {
  pr: string;
  expected: Verdict | null;
  /** The facts the script decided before any model: closed words, or `none`. */
  facts: string[];
  files: number | null;
  stage: "screen" | "full" | "facts" | null;
  /**
   * The screen's decision, or what stopped it; `not_run` when the naming rule ended the review
   * first and no model was asked.
   */
  screen: "proceed" | "reject" | "not_run" | RunError | null;
  /** The criteria after the facts, in the report's order; null with no report. */
  criteria: Partial<Record<Criterion, string>> | null;
  /**
   * Whether the report says the pull request tried to instruct the reviewer, which fails it whatever
   * else it says; null with no report. The gate allows none on a legitimate pull request.
   */
  steering: boolean | null;
  verdict: Verdict | null;
  check: string | null;
  /**
   * Why no report was made: a run error, or what could not be read before the review began
   * ({@link CALIBRATION_READ_ERRORS}).
   */
  error: string | null;
  screenTokens: StageTokens | null;
  reviewTokens: StageTokens | null;
  screenSeconds: number | null;
  reviewSeconds: number | null;
  costUsd: number | null;
  /**
   * What the content pass came to, when the review read the content (after its screen let the pull
   * request through); null otherwise. Numbers and booleans only.
   */
  evidence: EvidenceStats | null;
}

const PR_REF = /^(?:nemarDatasets\/)?((?:nm|xx|on)\d{6})#(\d{1,9})$/;
const SHA40 = /^[0-9a-f]{40}$/;
const VERDICT_WORDS = ["pass", "fail", "uncertain"] as const;

/**
 * Read `nm000153#2` (or `nemarDatasets/nm000153#2`), an optional expected outcome, and optionally the
 * base and head commits after it, both full ids: `nm000153#2 [pass] [<base> <head>]`. One commit
 * alone is refused, as is anything else after the reference.
 */
export function parseTarget(line: string): CalibrationTarget | null {
  const [ref, ...rest] = line.trim().split(/\s+/);
  if (ref === undefined) return null;
  const m = ref.match(PR_REF);
  if (!m?.[1] || !m[2]) return null;
  const expected =
    rest[0] !== undefined && (VERDICT_WORDS as readonly string[]).includes(rest[0])
      ? (rest.shift() as Verdict)
      : null;
  const target: CalibrationTarget = { dataset: m[1], number: Number(m[2]), expected };
  if (rest.length === 0) return target;
  const [base, head, ...more] = rest;
  if (base === undefined || head === undefined || more.length > 0) return null;
  if (!SHA40.test(base) || !SHA40.test(head)) return null;
  return { ...target, pin: { base, head } };
}

/** The review's own arguments, and anything that would name somewhere to post. All refused. */
const REFUSED_FLAGS = new Set([
  "environment",
  "callback-url",
  "callback-token",
  "origin",
  "token",
  "review-id",
  "dataset",
  "repo-dir",
  "base",
  "head",
  "fetched-head",
  "pr-json",
]);

/**
 * The flags the script accepts. With {@link REFUSED_FLAGS} they are the only flags a message ever
 * names: any other name may be a key pasted after two dashes, and a message is no place to print one.
 */
const ACCEPTED_FLAGS = [
  "pr",
  "prs",
  "json",
  "clones",
  "offline",
  "evidence-only",
  "without-summary",
] as const;
/** The accepted flags that take no value. */
const SWITCHES: ReadonlySet<string> = new Set([
  "json",
  "offline",
  "evidence-only",
  "without-summary",
]);
const KNOWN_FLAGS: ReadonlySet<string> = new Set<string>([...ACCEPTED_FLAGS, ...REFUSED_FLAGS]);

/**
 * Why a pull request could not be read before its review began, as a closed word for the table:
 * `gh` failed or answered with something that is not a pull request, the pull request names no
 * base or head commit, or git could not fetch them; with `--clones`, the clone (or a file beside
 * it the run needs) is not there, or the clone lacks an object the review needs.
 */
export const CALIBRATION_READ_ERRORS = [
  "gh_failed",
  "no_commit",
  "fetch_failed",
  "clone_missing",
  "objects_missing",
] as const;
export type CalibrationReadErrorCode = (typeof CALIBRATION_READ_ERRORS)[number];

export class CalibrationReadError extends Error {
  readonly code: CalibrationReadErrorCode;
  constructor(code: CalibrationReadErrorCode) {
    super(code);
    this.name = "CalibrationReadError";
    this.code = code;
  }
}

/**
 * A command, run with {@link childEnv} (the one environment every child of the review gets, the
 * evidence reader's git included) and, because it is an operator's machine, without the operator's
 * own git configuration either; the environment is read now.
 */
function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...childEnv(), GIT_CONFIG_GLOBAL: "/dev/null" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The variables that would point git at another repository than the one a call names with `-C`.
 * A run removes them, so every git it starts finds the clone's own repository or none.
 */
const REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

/**
 * Set this process's environment for one run, and return the function that puts it back exactly as
 * it was, a variable that was unset included. Every git the run starts, the evidence reader's
 * included, is started with {@link childEnv}, which reads this environment at each call, so these
 * reach all of them:
 * - `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`: no git reads the operator's or the
 *   system's configuration, so every git of the run reads the same one. A `diff.algorithm` the
 *   reader read and the deletion count of {@link refusedDeletions} did not would make the two
 *   disagree about a diff shown in full, and the counts, a stored baseline among them, would
 *   depend on the machine;
 * - `GIT_NO_LAZY_FETCH=1` when `offline`, so no git fetches;
 * - none of {@link REPOSITORY_VARIABLES}, so no git reads a repository other than the one it names.
 */
export function scopeRunEnvironment(offline: boolean): () => void {
  const wanted: [string, string | null][] = [
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ...(offline ? [["GIT_NO_LAZY_FETCH", "1"] as [string, string]] : []),
    ...REPOSITORY_VARIABLES.map((name): [string, null] => [name, null]),
  ];
  const saved = wanted.map(([name]) => [name, process.env[name]] as const);
  for (const [name, value] of wanted) {
    if (value === null) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}

export interface FetchedPullRequest {
  dir: string;
  base: string;
  head: string;
  pr: Record<string, unknown>;
  /**
   * Set by a reader of frozen clones that was asked for `--offline`: nothing about this pull
   * request may be fetched or asked of a remote, so the content pass lists no version tags (its
   * README is compared with every merge-base line, the stricter anchor). Unset: the pass may.
   */
  offline?: boolean;
}

/**
 * Read the pull request with `gh api` and fetch its base and head as git data, the way the
 * workflow does: `git init` and a blob-less `git fetch`, never a checkout, so nothing in the pull
 * request runs. The base is the one GitHub recorded on the pull request. A failure is a
 * {@link CalibrationReadError}, so the table says which step failed.
 */
function fetchPullRequest(t: CalibrationTarget, root: string): FetchedPullRequest {
  let pr: Record<string, unknown>;
  try {
    const raw = run("gh", ["api", `repos/nemarDatasets/${t.dataset}/pulls/${t.number}`]);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    pr = parsed as Record<string, unknown>;
  } catch {
    throw new CalibrationReadError("gh_failed");
  }
  const base = (pr.base as { sha?: unknown } | undefined)?.sha;
  const head = (pr.head as { sha?: unknown } | undefined)?.sha;
  if (
    typeof base !== "string" ||
    !SHA40.test(base) ||
    typeof head !== "string" ||
    !SHA40.test(head)
  ) {
    throw new CalibrationReadError("no_commit");
  }
  const dir = join(root, `${t.dataset}-${t.number}`);
  try {
    fetchInto(dir, t, base);
  } catch {
    throw new CalibrationReadError("fetch_failed");
  }
  return { dir, base, head, pr };
}

/** `git init` and the blob-less fetch of the pull ref and the base, into `dir`. */
function fetchInto(dir: string, t: CalibrationTarget, base: string): void {
  run("git", ["init", "-q", dir]);
  run("git", ["-C", dir, "config", "core.hooksPath", "/dev/null"]);
  // A named promisor remote, as the workflow sets it up, so the blob-less clone fetches a blob the
  // evidence reader asks for when it asks.
  run("git", [
    "-C",
    dir,
    "remote",
    "add",
    "origin",
    `https://github.com/nemarDatasets/${t.dataset}.git`,
  ]);
  run("git", ["-C", dir, "config", "extensions.partialClone", "origin"]);
  run("git", [
    "-C",
    dir,
    "fetch",
    "-q",
    "--no-tags",
    "--filter=blob:none",
    "origin",
    `+refs/pull/${t.number}/head:refs/remotes/pr/head`,
    base,
  ]);
}

/**
 * A pull request at the commits its line pins, fetched by id, blob-less, from the dataset's
 * repository: `git init`, the promisor remote, `git fetch origin <base> <head>`, and
 * `refs/remotes/pr/head` set to the head, as {@link fetchInto} leaves it. No `gh`: the pull
 * request's text is not read, so this serves only a run that needs none (`--evidence-only`). A
 * head that was force-pushed away is no longer reachable on GitHub and is `fetch_failed`.
 */
export function fetchPinned(t: CalibrationTarget, root: string): FetchedPullRequest {
  if (t.pin === undefined) throw new CalibrationReadError("no_commit");
  const { base, head } = t.pin;
  const dir = join(root, `${t.dataset}-${t.number}`);
  try {
    run("git", ["init", "-q", dir]);
    run("git", ["-C", dir, "config", "core.hooksPath", "/dev/null"]);
    run("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      `https://github.com/nemarDatasets/${t.dataset}.git`,
    ]);
    run("git", ["-C", dir, "config", "extensions.partialClone", "origin"]);
    run("git", ["-C", dir, "fetch", "-q", "--no-tags", "--filter=blob:none", "origin", base, head]);
    run("git", ["-C", dir, "update-ref", "refs/remotes/pr/head", head]);
  } catch {
    throw new CalibrationReadError("fetch_failed");
  }
  return { dir, base, head, pr: {} };
}

/** The environment a git call that must not fetch is run with: {@link childEnv} and no lazy fetch. */
function offlineEnv(): NodeJS.ProcessEnv {
  return { ...childEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1" };
}

/** Whether a git call in `dir` succeeds without fetching anything. */
function gitHolds(dir: string, args: string[]): boolean {
  try {
    execFileSync("git", ["-C", dir, ...args], {
      env: offlineEnv(),
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** The `<base> <head>` of a `.shas` file, or null when it is not exactly two full ids. */
function readShas(path: string): PinnedCommits | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const m = /^([0-9a-f]{40}) ([0-9a-f]{40})\n?$/.exec(text);
  return m?.[1] && m[2] ? { base: m[1], head: m[2] } : null;
}

/**
 * Whether `dir` is a repository of its own, and not a directory inside another one that git would
 * find by searching up from it. Asked of git and compared by real path, after resolving links on
 * both sides: a working tree's top level (`rev-parse --show-toplevel`) must be `dir` itself, and a
 * bare repository (`--is-bare-repository` prints `true`) must have `dir` as its git directory
 * (`--absolute-git-dir`). Anything else, a failure of git included, is not. A working tree whose
 * `.git` is a file (a linked worktree) is one; an empty `.git` directory or a `.git` file that names
 * nothing is not. The git is started with this process's environment, which a run has stripped of
 * every variable that would name another repository ({@link scopeRunEnvironment}).
 */
function isOwnRepository(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    const real = realpathSync(dir);
    const ask = (flag: string): string =>
      execFileSync("git", ["-C", dir, "rev-parse", flag], {
        encoding: "utf8",
        env: offlineEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      }).replace(/\n$/, "");
    if (ask("--is-bare-repository") === "true") {
      return realpathSync(ask("--absolute-git-dir")) === real;
    }
    return realpathSync(ask("--show-toplevel")) === real;
  } catch {
    return false;
  }
}

/**
 * Where each pull request comes from with `--clones DIR`: the clone `DIR/<dataset>-<number>`, made
 * before (for a frozen set, by the recipe in its manifest), read in place and never fetched into by
 * this function.
 *
 * - The clone must be a directory that is a repository of its own ({@link isOwnRepository}), else
 *   `clone_missing`: an empty `.git`, none, or a link into another repository's tree is not taken
 *   for the repository that encloses it.
 * - The commits are the line's pin, else the ones in `DIR/<dataset>-<number>.shas`, else `no_commit`.
 * - Both must be commits the clone holds, asked without fetching (in every mode, not only
 *   `offline`), else `objects_missing`.
 * - `offline`: every blob the content pass's one prefetch would fetch (the diff from the merge base
 *   to the head, which `--numstat` reads in full) must be in the clone already, asked without
 *   fetching, else `objects_missing`. So a clone short of a blob of that diff is a closed word, not
 *   a failure in the middle of a pass. An object outside that diff that the review still reads (an
 *   unchanged `dataset_description.json` the listing reads, or a change log the content pass
 *   reads) is not checked here; no pass can fetch it either, so the pull request ends as
 *   `evidence_unavailable`. (The merge base, not the base: the review diffs from the merge base,
 *   and the files the base's branch changed since are never read.)
 * - The pull request's text is `DIR/<dataset>-<number>.pr.json`, an object, else `clone_missing`;
 *   with `needsText` false (a run that reads no text) it is not read at all.
 */
export function cloneReader(
  clones: string,
  offline: boolean,
  needsText: boolean,
): (t: CalibrationTarget) => FetchedPullRequest {
  return (t) => {
    const name = `${t.dataset}-${t.number}`;
    const dir = join(clones, name);
    if (!isOwnRepository(dir)) throw new CalibrationReadError("clone_missing");
    const pin = t.pin ?? readShas(join(clones, `${name}.shas`));
    if (pin === null) throw new CalibrationReadError("no_commit");
    for (const sha of [pin.base, pin.head]) {
      if (!gitHolds(dir, ["cat-file", "-e", `${sha}^{commit}`])) {
        throw new CalibrationReadError("objects_missing");
      }
    }
    if (offline) {
      let mergeBase = "";
      try {
        mergeBase = execFileSync("git", ["-C", dir, "merge-base", pin.base, pin.head], {
          encoding: "utf8",
          env: offlineEnv(),
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        throw new CalibrationReadError("objects_missing");
      }
      if (
        !SHA40.test(mergeBase) ||
        !gitHolds(dir, [
          "diff",
          "--numstat",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          mergeBase,
          pin.head,
        ])
      ) {
        throw new CalibrationReadError("objects_missing");
      }
    }
    let pr: Record<string, unknown> = {};
    if (needsText) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(clones, `${name}.pr.json`), "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error();
        }
        pr = parsed as Record<string, unknown>;
      } catch {
        throw new CalibrationReadError("clone_missing");
      }
    }
    return { dir, base: pin.base, head: pin.head, pr, offline };
  };
}

function sum(tokens: Array<StageTokens | null>): StageTokens | null {
  const present = tokens.filter((t): t is StageTokens => t !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => ({
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }));
}

/** The facts a report decided before any model, as closed words. */
function factWords(report: PrReviewReport): string[] {
  if (report.v !== 2) return [];
  const out: string[] = [];
  if (report.evidence.description_empty) out.push("description_empty");
  if (report.evidence.title_problem) out.push(`title_${report.evidence.title_problem}`);
  if (report.evidence.name_problem) out.push(`name_${report.evidence.name_problem}`);
  return out;
}

/**
 * Calibrate on one pull request. Never throws: what went wrong is a closed word in the row. `read`
 * is where the pull request comes from: GitHub, through `gh` and `git`, unless a test hands it a
 * repository of its own; the review itself is always the job's.
 */
export async function calibrateOne(
  t: CalibrationTarget,
  root: string,
  read: (t: CalibrationTarget, root: string) => FetchedPullRequest = fetchPullRequest,
): Promise<CalibrationRow> {
  const row: CalibrationRow = {
    pr: `${t.dataset}#${t.number}`,
    expected: t.expected,
    facts: [],
    files: null,
    stage: null,
    screen: null,
    criteria: null,
    steering: null,
    verdict: null,
    check: null,
    error: null,
    screenTokens: null,
    reviewTokens: null,
    screenSeconds: null,
    reviewSeconds: null,
    costUsd: null,
    evidence: null,
  };
  let fetched: FetchedPullRequest;
  try {
    fetched = read(t, root);
  } catch (e) {
    // A word of the closed list, or the generic one; never the error's own text.
    row.error = e instanceof CalibrationReadError ? e.code : "not_readable";
    return row;
  }
  const observe = (o: StageObservation) => {
    const seconds = Math.round(o.ms / 100) / 10;
    if (o.stage === "screen") {
      row.screenTokens = o.usage;
      row.screenSeconds = seconds;
      if (o.result !== "ok") row.screen = o.result;
    } else {
      // The review runs only after the screen let the pull request through.
      row.screen = "proceed";
      row.reviewTokens = o.usage;
      row.reviewSeconds = seconds;
    }
  };
  try {
    const report = await reviewPullRequest(
      {
        repoDir: fetched.dir,
        base: fetched.base,
        head: fetched.head,
        pr: fetched.pr,
        fromFork: isFromFork(fetched.pr),
        versionTags: fetched.offline !== true,
      },
      observe,
      (s) => {
        row.evidence = s;
      },
    );
    row.files = report.evidence.files_changed;
    row.facts = factWords(report);
    if (report.v === 2) {
      row.stage = report.stage;
      row.screen =
        report.stage === "facts" ? "not_run" : report.stage === "screen" ? "reject" : "proceed";
    }
    row.criteria = factsOf(report).criteria;
    row.steering = report.steering;
    row.verdict = verdictOf(report);
    row.check = conclusionOf({ kind: "reported", report });
  } catch (e) {
    row.error = mapError(e);
  }
  // No tokens is no measurement, unless no model was asked: then nothing was spent, and that is one.
  row.costUsd =
    row.screenTokens === null && row.reviewTokens === null
      ? row.stage === "facts"
        ? 0
        : null
      : estimateCostUsd({
          screen_input: row.screenTokens?.input_tokens ?? 0,
          screen_output: row.screenTokens?.output_tokens ?? 0,
          review_input: row.reviewTokens?.input_tokens ?? 0,
          review_output: row.reviewTokens?.output_tokens ?? 0,
        });
  return row;
}

// ---------------------------------------------------------------------------------------------
// --evidence-only: the review's evidence passes alone, with no model
// ---------------------------------------------------------------------------------------------

/**
 * The text facts of a run that reads no pull request text: none of them wrong. `buildEvidence`
 * copies them into the evidence and reads them for nothing else, so the counts do not depend on it.
 */
const NEUTRAL_TEXT: TextFacts = {
  descriptionEmpty: false,
  descriptionCut: false,
  titleProblem: null,
  nameProblem: null,
};

/** One class of the change summary as the evidence rows carry it: its kind and counts, no path. */
export interface EvidenceClass {
  kind: ClassKind;
  items: number;
  files: number;
  complete: boolean;
}

/**
 * The modified and removed files the summary REFUSED (so no loss fact counts them) whose diff
 * deletes at least one line, by what the review was given of each: `shown` (a diff not cut, its
 * own or one it repeats, that holds as many deleted lines as git counts for the file), `incomplete`
 * (not shown, and the evidence says the content was not read in full, so the pull request cannot
 * pass on it) or `hidden` (neither: a removal the review could not see and was not told about,
 * which must never happen).
 */
export interface RefusedDeletions {
  shown: number;
  incomplete: number;
  hidden: number;
}

/** The evidence numbers without the passes' times, which a row carries apart. */
export type EvidenceCounts = Omit<EvidenceStats, "listingMs" | "contentMs">;

/**
 * What the evidence passes came to for one pull request, in numbers and closed words only: no
 * path, no value and no text of the pull request. `timings` is the one part that changes from run
 * to run, kept under one key so a stored baseline can drop it.
 */
export interface EvidenceRow {
  pr: string;
  /** Why there is no evidence: a read error, a run error, or `too_large`; null when it was read. */
  error: string | null;
  evidence: EvidenceCounts | null;
  /** How many candidates the summary refused, by its closed word; null when not counted. */
  refusedBy: Partial<Record<SummaryRefusal, number>> | null;
  /** The classes the summary showed, in its order; null when not counted. */
  classes: EvidenceClass[] | null;
  refusedDeleted: RefusedDeletions | null;
  timings: { listingMs: number; contentMs: number } | null;
}

/** How many candidates the summary refused, by refusal, in the order of {@link SUMMARY_REFUSALS}. */
function refusalTally(facts: GitFacts): Partial<Record<SummaryRefusal, number>> {
  const counts = new Map<SummaryRefusal, number>();
  for (const o of facts.summary.files) {
    if (o.refusal !== null) counts.set(o.refusal, (counts.get(o.refusal) ?? 0) + 1);
  }
  const out: Partial<Record<SummaryRefusal, number>> = {};
  for (const word of SUMMARY_REFUSALS) {
    const n = counts.get(word);
    if (n !== undefined) out[word] = n;
  }
  return out;
}

/** The classes the summary showed, in render order, as kind and counts. */
function classesOf(facts: GitFacts): EvidenceClass[] {
  const { summary } = facts;
  return summary.classes
    .filter((c) => summary.shown.has(c.key))
    .map((c) => ({
      kind: c.kind,
      items: c.items,
      files: c.files.size,
      complete: summary.complete.has(c.key),
    }));
}

/**
 * About how many bytes of paths one `git diff --numstat` of {@link refusedDeletions} is handed. A
 * pull request can refuse tens of thousands of files, and one call with every path would pass the
 * system's limit on a command's arguments and fail as `objects_missing`; `git diff` reads no list
 * of paths from a file, so the paths are split into calls of about this size.
 */
export const REFUSED_NUMSTAT_CHUNK_BYTES = 100_000;

/** `paths` in order, in runs of at most `maxBytes` bytes (and at least one path each). */
function chunkPaths(paths: readonly string[], maxBytes: number): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (chunk.length > 0 && bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(path);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/**
 * How many lines a diff's text deletes: its lines that start with `-` after its first `@@` line.
 * A deleted line whose own text starts with `--` prints as `---` and is counted; the header's
 * `--- a/<path>` comes before the first `@@` and is not. A diff with no `@@` line (git's one line
 * for a binary diff, or a change of mode alone) deletes none.
 */
function deletedLinesShown(text: string): number {
  const lines = text.split("\n");
  const hunk = lines.findIndex((line) => line.startsWith("@@"));
  if (hunk < 0) return 0;
  let n = 0;
  for (const line of lines.slice(hunk + 1)) if (line.startsWith("-")) n++;
  return n;
}

/**
 * Sort the files the summary refused that delete a line ({@link RefusedDeletions}). Which delete a
 * line, and how many, is asked of git: `git diff --numstat` from the merge base to the head over
 * those paths alone, in calls of at most `chunkBytes` bytes of paths (a binary file, `-` deleted,
 * counts as deleting). What the review was given of each is read from the content pass's own
 * facts and decided from the content of the diff, not from its being there: a file is shown only
 * when the diff not cut that stands for it (its own, or the one it is folded onto) holds at least
 * as many deleted lines as git counts. A binary file is never shown, since git prints no line of
 * it, and neither is a file whose diff holds fewer deleted lines than its count. A file not shown
 * is incomplete when the pass's `readIncomplete` says so, and hidden otherwise. Run on blobs the
 * content pass already read, so it fetches nothing.
 */
export function refusedDeletions(
  dir: string,
  facts: GitFacts,
  chunkBytes: number = REFUSED_NUMSTAT_CHUNK_BYTES,
): RefusedDeletions {
  const out: RefusedDeletions = { shown: 0, incomplete: 0, hidden: 0 };
  const refused = facts.summary.files.filter((o) => o.refusal !== null).map((o) => o.path);
  if (refused.length === 0) return out;
  // The diff not cut that stands for each file, and how many deleted lines it holds.
  const shownBy = new Map<string, number>();
  for (const p of facts.patches) {
    if (p.truncated) continue;
    const deleted = deletedLinesShown(p.text);
    shownBy.set(p.path, deleted);
    for (const path of p.same) shownBy.set(path, deleted);
  }
  for (const chunk of chunkPaths(refused, chunkBytes)) {
    let raw: string;
    try {
      raw = run("git", [
        "--literal-pathspecs",
        "-C",
        dir,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "protocol.ext.allow=never",
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        facts.mergeBase,
        facts.head,
        "--",
        ...chunk,
      ]);
    } catch {
      throw new CalibrationReadError("objects_missing");
    }
    for (const record of raw.split("\0")) {
      if (record === "") continue;
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
      if (m === null) throw new CalibrationReadError("objects_missing");
      const deleted = m[2] as string;
      if (deleted !== "-" && Number(deleted) === 0) continue;
      const inDiff = shownBy.get(m[3] as string);
      if (deleted !== "-" && inDiff !== undefined && inDiff >= Number(deleted)) out.shown++;
      else if (facts.readIncomplete) out.incomplete++;
      else out.hidden++;
    }
  }
  return out;
}

/**
 * The evidence of one pull request, as the review reads it after its screen, with no model asked:
 * the listing and the content pass, each timed, the evidence built from them, and the numbers of
 * {@link EvidenceRow}. A pull request over the review's file limit is `too_large`, as the review
 * would make it. `withoutSummary` gives the content pass a clock that has always run out, so the
 * change summary is never started and the pass reads the pull request as it did before the summary
 * existed. Never throws: what went wrong is a closed word in the row.
 */
export function evidenceOne(
  t: CalibrationTarget,
  root: string,
  read: (t: CalibrationTarget, root: string) => FetchedPullRequest,
  opts: { withoutSummary: boolean },
): EvidenceRow {
  const row: EvidenceRow = {
    pr: `${t.dataset}#${t.number}`,
    error: null,
    evidence: null,
    refusedBy: null,
    classes: null,
    refusedDeleted: null,
    timings: null,
  };
  let fetched: FetchedPullRequest;
  try {
    fetched = read(t, root);
  } catch (e) {
    row.error = e instanceof CalibrationReadError ? e.code : "not_readable";
    return row;
  }
  try {
    const { dir, base, head } = fetched;
    const { value: listing, ms: listingMs } = timed(() => gatherListing(dir, base, head));
    if (listing.changes.length > MAX_REVIEWABLE_FILES) {
      row.error = "too_large";
      return row;
    }
    const options: ContentOptions = {
      ...(opts.withoutSummary ? { now: () => Number.POSITIVE_INFINITY } : {}),
      versionTags: fetched.offline !== true,
    };
    const { value: content, ms: contentMs } = timed(() => gatherContent(dir, listing, options));
    const all: GitFacts = { ...listing, ...content };
    const stats = evidenceStats(all, buildEvidence(all, NEUTRAL_TEXT), { listingMs, contentMs });
    const { listingMs: _listing, contentMs: _content, ...counts } = stats;
    const refusedDeleted = refusedDeletions(dir, all);
    row.evidence = counts;
    row.refusedBy = refusalTally(all);
    row.classes = classesOf(all);
    row.refusedDeleted = refusedDeleted;
    row.timings = { listingMs, contentMs };
  } catch (e) {
    row.error = e instanceof CalibrationReadError ? e.code : mapError(e);
  }
  return row;
}

/** The evidence row of a normal run: its numbers, and `-` for what only an evidence run counts. */
export function evidenceRowOf(r: CalibrationRow): EvidenceRow {
  if (r.evidence === null) {
    return {
      pr: r.pr,
      error: r.error,
      evidence: null,
      refusedBy: null,
      classes: null,
      refusedDeleted: null,
      timings: null,
    };
  }
  const { listingMs, contentMs, ...counts } = r.evidence;
  return {
    pr: r.pr,
    error: null,
    evidence: counts,
    refusedBy: null,
    classes: null,
    refusedDeleted: null,
    timings: { listingMs, contentMs },
  };
}

/** The exit code of an evidence run: 1 when a pull request was not read or a removal is HIDDEN. */
export function evidenceExitCode(rows: readonly EvidenceRow[]): 0 | 1 {
  return rows.some((r) => r.error !== null || (r.refusedDeleted?.hidden ?? 0) > 0) ? 1 : 0;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** `no`, `list`, `content` or `list+content`: what made the evidence truncated. */
function truncatedWord(e: EvidenceCounts): string {
  if (e.listCut && e.readIncomplete) return "list+content";
  if (e.listCut) return "list";
  if (e.readIncomplete) return "content";
  return "no";
}

/**
 * What Part B (the original authors' content) did to a pull request, as the one word the table
 * shows, from the numbers of {@link EvidenceStats}: `abandoned` (the pass was abandoned: a person
 * looks), `fail` (`originalFails`: `no_degradation` fails whatever the review says), `unknown`
 * (the platform has a finding and no fail: recordings replaced, or a part it could not compare),
 * `info` (only what the model is left to judge: a minor edit, later text altered, an author field
 * edited slightly, a recording moved with its key) or `-` (nothing). The fail and the findings are
 * the review's own (`originalLowersToFail`, `platformFindings`), not a second reading of the facts.
 */
export function partBWord(e: EvidenceCounts): "abandoned" | "fail" | "unknown" | "info" | "-" {
  if (e.originalAbandoned) return "abandoned";
  if (e.originalFails > 0) return "fail";
  if (e.originalFindings > 0) return "unknown";
  const information =
    e.readmeMinorEdits + e.readmeLaterAltered + e.authorFieldsEdited + e.recordingsMoved;
  return information > 0 ? "info" : "-";
}

/**
 * The lines of text a pull request altered, as the platform counts them for its note: README lines
 * the original authors published that were altered or moved, runs of new lines put inside one of
 * their paragraphs (each counts as one line), and existing CHANGES lines altered or moved.
 */
function textLinesAltered(e: EvidenceCounts): number {
  return e.readmeAlteredLines + e.readmeInsideParagraph + e.changesAlteredLines;
}

/**
 * The evidence table, one pull request per line, with a header and totals. Pure; numbers and
 * closed words only. Columns: the files changed, wanted (in the areas the review reads), proven
 * cosmetic, summarized and refused by the summary, accounted for, the classes it showed and cut
 * and the characters of its block, the diffs shown, the files read and left unread, what made the
 * evidence truncated, the rows, columns and keys removed and not kept (LOSS r/c/k), the platform's
 * findings about the change summary, Part B's word ({@link partBWord}) and its numbers (B t/f/p/r:
 * text lines altered, author fields altered, participant values altered, recordings replaced), the
 * refused files that delete a line (shown/incomplete/hidden), and the two passes' seconds. A cell
 * the run did not count (the normal mode counts no refusal) is `-`.
 */
export function renderEvidenceTable(rows: readonly EvidenceRow[]): string[] {
  const cells = rows.map((r) => {
    const e = r.evidence;
    if (e === null) {
      return [r.pr, `no evidence (${r.error ?? "content not read"})`];
    }
    const d = r.refusedDeleted;
    return [
      r.pr,
      String(e.files),
      String(e.wanted),
      String(e.cosmetic),
      e.summaryAbandoned ? "abandoned" : String(e.summarized),
      String(e.refused),
      String(e.accounted),
      String(e.classes),
      String(e.cut),
      String(e.summaryChars),
      String(e.patches),
      String(e.read),
      String(e.unread),
      truncatedWord(e),
      `${e.rowsRemoved}/${e.columnsRemoved}/${e.keysRemoved}`,
      String(e.platformFindings),
      partBWord(e),
      `${textLinesAltered(e)}/${e.authorFieldsAltered}/${e.participantValuesAltered}/${e.recordingsReplaced}`,
      d === null ? "-" : `${d.shown}/${d.incomplete}/${d.hidden}${d.hidden > 0 ? " HIDDEN" : ""}`,
      r.timings === null ? "-" : `${seconds(r.timings.listingMs)}|${seconds(r.timings.contentMs)}`,
    ];
  });
  const header = [
    "PR",
    "FILES",
    "WANTED",
    "COSMETIC",
    "SUMMARIZED",
    "REFUSED",
    "ACCOUNTED",
    "CLASSES",
    "CUT",
    "CHARS",
    "PATCHES",
    "READ",
    "UNREAD",
    "TRUNCATED",
    "LOSS r/c/k",
    "FINDINGS",
    "PART-B",
    "B t/f/p/r",
    "REFUSED-DELETED s/i/h",
    "SECONDS listing|content",
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (c: string[]) =>
    c
      .map((x, i) => x.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(header), ...cells.map(line), "", ...evidenceTotals(rows)];
}

/** The totals under the evidence table. */
function evidenceTotals(rows: readonly EvidenceRow[]): string[] {
  const read = rows.filter((r) => r.evidence !== null);
  const total = (f: (e: EvidenceCounts) => number) =>
    read.reduce((n, r) => n + f(r.evidence as EvidenceCounts), 0);
  const count = (f: (e: EvidenceCounts) => boolean) =>
    read.filter((r) => f(r.evidence as EvidenceCounts)).length;
  const errors = new Map<string, number>();
  for (const r of rows) {
    if (r.evidence === null && r.error !== null) {
      errors.set(r.error, (errors.get(r.error) ?? 0) + 1);
    }
  }
  const refusals = new Map<string, number>();
  let refusalsCounted = false;
  for (const r of rows) {
    if (r.refusedBy === null) continue;
    refusalsCounted = true;
    for (const [word, n] of Object.entries(r.refusedBy)) {
      refusals.set(word, (refusals.get(word) ?? 0) + (n ?? 0));
    }
  }
  const byReason = refusalsCounted
    ? ` (${[...refusals.entries()].map(([w, n]) => `${w} ${n}`).join(", ") || "none"})`
    : "";
  const deleted = rows.filter((r) => r.refusedDeleted !== null);
  const withDeleted = deleted.filter((r) => {
    const d = r.refusedDeleted as RefusedDeletions;
    return d.shown + d.incomplete + d.hidden > 0;
  });
  const sumDeleted = (k: keyof RefusedDeletions) =>
    deleted.reduce((n, r) => n + (r.refusedDeleted as RefusedDeletions)[k], 0);
  const withTimes = rows.filter((r) => r.timings !== null);
  const slowest = (k: "listingMs" | "contentMs"): string => {
    let top: EvidenceRow | null = null;
    for (const r of withTimes) {
      if (top === null || (r.timings?.[k] ?? 0) > (top.timings?.[k] ?? 0)) top = r;
    }
    return top?.timings ? `${seconds(top.timings[k])} s (${top.pr})` : "-";
  };
  const allMs = withTimes.reduce(
    (n, r) => n + (r.timings?.listingMs ?? 0) + (r.timings?.contentMs ?? 0),
    0,
  );
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const notRead = rows.length - read.length;
  // Part B: a fail is counted once and then by what it altered (a row may alter several kinds); the
  // rest that the platform holds is unknown, with the pass that was abandoned counted apart from the
  // parts it could not compare and the recordings it found replaced.
  const failing = (f: (e: EvidenceCounts) => boolean) =>
    count((e) => partBWord(e) === "fail" && f(e));
  const holding = (f: (e: EvidenceCounts) => boolean) =>
    count((e) => partBWord(e) === "unknown" && f(e));
  const failed = count((e) => partBWord(e) === "fail");
  const abandoned = count((e) => partBWord(e) === "abandoned");
  const unknownOnly = count((e) => partBWord(e) === "unknown") + abandoned;
  return [
    `${plural(rows.length, "pull request", "pull requests")}, ${notRead} without evidence${
      errors.size > 0 ? ` (${[...errors.entries()].map(([w, n]) => `${w} ${n}`).join(", ")})` : ""
    }.`,
    `Files: ${total((e) => e.files)} changed, ${total((e) => e.wanted)} wanted, ${total((e) => e.cosmetic)} cosmetic, ${total((e) => e.summarized)} summarized, ${total((e) => e.refused)} refused${byReason}, ${total((e) => e.accounted)} accounted for, ${total((e) => e.read)} read, ${total((e) => e.unread)} unread.`,
    `Pull requests: ${count((e) => e.truncated)} truncated (${count((e) => e.listCut)} list cut, ${count((e) => e.readIncomplete)} content not read in full), ${count((e) => e.summaryAbandoned)} with the summary abandoned, ${count((e) => e.platformFindings > 0)} with a blocking loss (a platform finding), ${count((e) => e.cut > 0)} with a class cut.`,
    `Part B: ${failed} fail (text ${failing((e) => textLinesAltered(e) > 0)}, fields ${failing((e) => e.authorFieldsAltered > 0)}, participants ${failing((e) => e.participantValuesAltered > 0)}), ${unknownOnly} unknown only (recordings ${holding((e) => e.recordingsReplaced > 0)}, not decided ${holding((e) => e.originalUndecided)}, abandoned ${abandoned}); anchor from a version tag in ${count((e) => e.anchorFromTag)}.`,
    deleted.length === 0
      ? "Removals in refused files: not counted in this mode."
      : `Removals in refused files: ${withDeleted.length} pull requests have a refused file that deletes a line; files shown ${sumDeleted("shown")}, incomplete ${sumDeleted("incomplete")}, HIDDEN ${sumDeleted("hidden")}.`,
    `Seconds: slowest listing ${slowest("listingMs")}, slowest content ${slowest("contentMs")}, all passes ${seconds(allMs)}.`,
    "LOSS r/c/k = rows, columns with values and keys removed and not kept elsewhere; REFUSED-DELETED s/i/h = files the summary refused that delete a line, shown in full, in a pull request whose content is incomplete, or HIDDEN (neither, exit 1); TRUNCATED says what made the evidence truncated.",
    "PART-B = fail (the original authors' text, author fields or participant values were altered), unknown (recordings replaced, or a part not compared), abandoned (not compared at all), info (only edits the model judges) or - (nothing); B t/f/p/r = text lines altered, author fields altered, participant values altered, recordings replaced.",
  ];
}

const SHORT: Record<string, string> = {
  pass: "pass",
  fail: "FAIL",
  unknown: "?",
};

/** The criteria a person reads first, in the column order of the table. */
const COLUMNS: ReadonlyArray<[Criterion, string]> = [
  ["no_degradation", "lost"],
  ["advances_revision", "rev"],
  ["material_improvement", "better"],
  ["clear_title_and_description", "text"],
  ["description_not_misleading", "honest"],
];

function tokens(t: StageTokens | null): string {
  return t === null ? "-" : `${t.input_tokens}/${t.output_tokens}`;
}

/** The table, one pull request per line, with a header and a total. Pure. */
export function renderTable(rows: readonly CalibrationRow[]): string[] {
  const cells = rows.map((r) => {
    const answers = r.criteria
      ? COLUMNS.map(([c]) => SHORT[r.criteria?.[c] ?? "unknown"] ?? "?").join(" ")
      : "-";
    const agrees = r.expected === null ? "" : r.verdict === r.expected ? "yes" : "NO";
    return [
      r.pr,
      r.files === null ? "-" : String(r.files),
      r.facts.length > 0 ? r.facts.join(",") : "none",
      r.screen ?? "-",
      answers,
      r.steering === null ? "-" : r.steering ? "YES" : "no",
      r.verdict ?? `no verdict (${r.error ?? "unknown"})`,
      r.check ?? "-",
      ...(rows.some((x) => x.expected !== null) ? [r.expected ?? "-", agrees] : []),
      `${tokens(r.screenTokens)} | ${tokens(r.reviewTokens)}`,
      `${r.screenSeconds ?? "-"} | ${r.reviewSeconds ?? "-"}`,
      r.costUsd === null ? "-" : `$${r.costUsd.toFixed(2)}`,
    ];
  });
  const header = [
    "PR",
    "FILES",
    "FACTS",
    "SCREEN",
    `REVIEW (${COLUMNS.map(([, h]) => h).join(" ")})`,
    "STEERING",
    "VERDICT",
    "CHECK",
    ...(rows.some((x) => x.expected !== null) ? ["EXPECTED", "AGREES"] : []),
    "TOKENS IN/OUT (screen | review)",
    "SECONDS (screen | review)",
    "COST",
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (c: string[]) =>
    c
      .map((x, i) => x.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const total = rows.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const tokensUsed = sum(rows.flatMap((r) => [r.screenTokens, r.reviewTokens]));
  const noVerdict = rows.filter((r) => r.verdict === null).length;
  const steered = rows.filter((r) => r.steering === true).length;
  // No tokens is no measurement, not a cost of nothing.
  const spend =
    tokensUsed === null
      ? "no tokens reported, so no cost estimate"
      : `${tokensUsed.input_tokens} tokens in, ${tokensUsed.output_tokens} out; about $${total.toFixed(2)} at list prices`;
  return [
    line(header),
    ...cells.map(line),
    "",
    `${rows.length} pull request${rows.length === 1 ? "" : "s"}, ${noVerdict} without a verdict, ${steered} with a steering flag; screen ${STAGE_BUDGETS.screen.model}, review ${STAGE_BUDGETS.review.model}, both at max effort; ${spend}.`,
    "Review columns, after the facts: lost = nothing is lost or broken, rev = the revision advances, better = materially better, text = the title and description say what changed, honest = the description is not misleading. pass, FAIL, or ? for could not tell (or not assessed when the screen stopped it or the naming rule ended the review). STEERING is YES when the review said text in the pull request tried to instruct it, which fails the pull request whatever else it says.",
  ];
}

/** A git version: its major, minor and patch numbers. */
export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * The version in `git --version`'s output (`git version 2.45.0`, `git version 2.39.5 (Apple
 * Git-154)`, `git version 2.45.1.windows.1`), or null when the output does not start that way. A
 * missing patch number reads as 0. Pure.
 */
export function parseGitVersion(output: string): GitVersion | null {
  const m = /^git version (\d+)\.(\d+)(?:\.(\d+))?(?:[.\s-]|$)/.exec(output.trim());
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

/**
 * Whether git honors `GIT_NO_LAZY_FETCH`, read from its version: from 2.45.0 on, the first release
 * whose notes name the variable (and `--no-lazy-fetch`). A git before it ignores the variable and
 * fetches what a partial clone lacks, silently. Some maintenance releases of older lines carry the
 * variable too; they are refused ON PURPOSE, since telling them apart would mean trusting a list of
 * versions, and the cost of the safe side is a refusal, never a fetch.
 */
export function honorsNoLazyFetch(v: GitVersion): boolean {
  return v.major > 2 || (v.major === 2 && v.minor >= 45);
}

/** The git this process would start, read from `git --version`; null when it cannot be read. */
function gitVersion(): GitVersion | null {
  try {
    return parseGitVersion(run("git", ["--version"]));
  } catch {
    return null;
  }
}

function usage(why: string): number {
  console.error(`pr-review-calibrate: ${why}`);
  console.error(
    "usage: pr-review-calibrate.ts (--pr nm000153#2 ... | --prs FILE) [--clones DIR [--offline]]\n" +
      "                              [--evidence-only [--without-summary]] [--json]\n" +
      "       FILE: one pull request per line, optionally followed by pass, fail or uncertain,\n" +
      "       and optionally by its base and head commits (full ids), which need --clones\n" +
      "       or --evidence-only\n" +
      "       --without-summary also abandons Part B (the original authors' content): the\n" +
      "       PART-B column reads abandoned for every pull request",
  );
  return 2;
}

/**
 * The exit code of a run: 0 when every pull request reached a verdict, 1 when any did not. A row
 * with no verdict is something a person has to look at (a refusal, a truncation, a pull request that
 * could not be read), so the run says so even when the others passed.
 */
export function exitCodeOf(rows: readonly CalibrationRow[]): 0 | 1 {
  return rows.some((r) => r.verdict === null) ? 1 : 0;
}

/**
 * Where a pull request comes from when no `--clones` is given: fetched at its pinned commits by id
 * (a run that reads no text, `--evidence-only`), else read with `gh` and fetched as the workflow
 * fetches it.
 */
function readPullRequest(t: CalibrationTarget, root: string): FetchedPullRequest {
  return t.pin === undefined ? fetchPullRequest(t, root) : fetchPinned(t, root);
}

/**
 * Read the arguments, refuse what would post or leak the key, calibrate, and print. `read` is where
 * each pull request comes from when no `--clones` is given, as for {@link calibrateOne}.
 *
 * The refusals come in this order: the callback token first, before an argument is read, because
 * calibrate posts nothing in any mode; then the arguments; then, unless `--evidence-only`, the
 * variables that would point the model client elsewhere. An evidence run makes no client, so a
 * shell with them set is no danger to a key it never reads. Then the flags that need one another,
 * and, with `--clones`, a git older than 2.45.0 (see {@link honorsNoLazyFetch}).
 */
export async function calibrateMain(
  argv: readonly string[],
  out: (line: string) => void = (l) => console.log(l),
  read: (t: CalibrationTarget, root: string) => FetchedPullRequest = readPullRequest,
): Promise<number> {
  if (process.env.PR_REVIEW_CALLBACK_TOKEN) {
    return usage("a review's callback token is set here; calibrate posts nothing and will not run");
  }
  const targets: CalibrationTarget[] = [];
  const switches = new Set<string>();
  let clones: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // Only the flag's name is read, and it is said only if the script knows it. What follows an `=`
    // is a value, and a value is never echoed: it may be a token, and a refusal is no place to
    // print one. An unknown name is no safer, since a key pasted after two dashes is one.
    const name = arg.startsWith("--") ? (arg.slice(2).split("=", 1)[0] ?? "") : null;
    if (name === null) {
      return usage(
        "arguments are flags: --pr, --prs, --clones, --offline, --evidence-only, --without-summary and --json",
      );
    }
    if (!KNOWN_FLAGS.has(name)) return usage("unknown flag");
    if (REFUSED_FLAGS.has(name)) {
      return usage(`--${name} is refused: calibrate posts nothing and reviews no dispatch`);
    }
    if (arg.includes("=")) return usage("write a flag and its value as two arguments");
    if (SWITCHES.has(name)) {
      switches.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return usage(`--${name} needs a value`);
    i++;
    if (name === "pr") {
      const t = parseTarget(value);
      if (t === null) return usage("--pr needs a pull request like nm000153#2");
      // Pinned commits come from the file of a frozen set, never from an argument.
      if (t.pin !== undefined) return usage("--pr names no commits; pin them in a --prs file");
      targets.push(t);
    } else if (name === "clones") {
      // The directory is checked here and never named: a path is the operator's, not the table's.
      let isDirectory = false;
      try {
        isDirectory = statSync(value).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (!isDirectory) return usage("--clones is not a directory that can be read");
      clones = value;
    } else if (name === "prs") {
      let text: string;
      try {
        text = await Bun.file(value).text();
      } catch {
        return usage("the pull request file could not be read");
      }
      const lines = text.split("\n");
      for (const [n, line] of lines.entries()) {
        if (line.trim() === "" || line.trim().startsWith("#")) continue;
        // A line of a label template a person has not labeled yet: its outcome is still `?`. Said
        // by its number, as every bad line is, and never by its text.
        if (line.trim().split(/\s+/)[1] === "?") {
          return usage(
            `line ${n + 1} of the pull request file is not labeled yet: replace its ? with pass, fail or uncertain`,
          );
        }
        const t = parseTarget(line);
        if (t === null)
          return usage(`line ${n + 1} of the pull request file is not like nm000153#2 pass`);
        targets.push(t);
      }
    } else {
      // Not reachable while the accepted flags and this chain agree; the word names nothing.
      return usage("unknown flag");
    }
  }
  if (targets.length === 0) return usage("name at least one pull request");
  const json = switches.has("json");
  const offline = switches.has("offline");
  const evidenceOnly = switches.has("evidence-only");
  const withoutSummary = switches.has("without-summary");
  if (!evidenceOnly) {
    const redirecting = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].filter(
      (name) => process.env[name] !== undefined,
    );
    if (redirecting.length > 0) {
      return usage(
        `${redirecting.join(" and ")} ${redirecting.length === 1 ? "is" : "are"} set; unset ${redirecting.length === 1 ? "it" : "them"} so the key goes only to the Anthropic API`,
      );
    }
  }
  if (withoutSummary && !evidenceOnly) return usage("--without-summary is for --evidence-only");
  if (offline && clones === null) return usage("--offline reads only --clones, which is not given");
  // A git before 2.45.0 ignores GIT_NO_LAZY_FETCH and would fetch, silently: offline, and when a
  // clone is checked for its commits, which happens with every --clones (--offline needs it). Its
  // version is never printed: the words are closed, and the refusal is the same for a version that
  // cannot be read.
  if (clones !== null) {
    const version = gitVersion();
    if (version === null || !honorsNoLazyFetch(version)) {
      return usage(
        "--clones needs git 2.45 or later, which keeps a clone from fetching; this git is older, or its version could not be read",
      );
    }
  }
  if (clones === null && !evidenceOnly && targets.some((t) => t.pin !== undefined)) {
    return usage(
      "a pull request with pinned commits is read from --clones or with --evidence-only",
    );
  }
  // An evidence run reads no text, so a clone needs no `.pr.json` and a pin needs no `gh`.
  const reader = clones === null ? read : cloneReader(clones, offline, !evidenceOnly);
  // A pull request named twice is calibrated once. Its second read would run `git remote add` in
  // the directory the first made and fail, and its row would say fetch_failed for no fault of the
  // pull request's. The first mention wins, and with it the outcome expected of the pull request.
  const named = new Set<string>();
  const once = targets.filter((t) => {
    const key = `${t.dataset}#${t.number}`;
    if (named.has(key)) return false;
    named.add(key);
    return true;
  });
  if (once.length < targets.length) {
    const extra = targets.length - once.length;
    console.error(
      `pr-review-calibrate: ${extra} mention${extra === 1 ? "" : "s"} of a pull request already named; each is calibrated once, with the first expected outcome given`,
    );
  }

  // The run's own environment for git (see scopeRunEnvironment): set only once the temporary
  // directory exists, inside the `try` whose `finally` puts it back as it was before anything else,
  // so a run that fails at any point leaves the environment as it found it.
  const root = mkdtempSync(join(tmpdir(), "pr-review-calibrate-"));
  let restore: (() => void) | null = null;
  try {
    restore = scopeRunEnvironment(offline);
    if (evidenceOnly) {
      // No model client is made on this path, so no key is read and nothing is sent.
      const rows = once.map((t) => evidenceOne(t, root, reader, { withoutSummary }));
      if (json) out(JSON.stringify(rows, null, 2));
      else for (const line of renderEvidenceTable(rows)) out(line);
      return evidenceExitCode(rows);
    }
    const rows: CalibrationRow[] = [];
    for (const t of once) rows.push(await calibrateOne(t, root, reader));
    if (json) out(JSON.stringify(rows, null, 2));
    else {
      for (const line of renderTable(rows)) out(line);
      out("");
      for (const line of renderEvidenceTable(rows.map(evidenceRowOf))) out(line);
    }
    return exitCodeOf(rows);
  } finally {
    restore?.();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  calibrateMain(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(
        `pr-review-calibrate failed: ${e instanceof Error ? e.constructor.name : "unknown"}`,
      );
      process.exit(1);
    });
}

export { fetchPullRequest };
