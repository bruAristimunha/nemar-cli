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
 *
 * FILE holds one pull request per line, `nm000153#2`, optionally followed by the outcome a person
 * expects (`pass`, `fail` or `uncertain`), which adds an agreement column. Blank lines and lines that
 * start with `#` are skipped.
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
 * and says which by name, never by value. Every child it starts, its own `gh` and `git` and the
 * `git` the review's evidence reader runs on a contributor's objects, is started with
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
 * closed word), and 2 for bad arguments or an environment it refuses to run in.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  STAGE_BUDGETS,
  type StageObservation,
  isFromFork,
  mapError,
  reviewPullRequest,
} from "./pr-review";
import { childEnv } from "./pr-review-evidence";

/** One pull request to calibrate on, and what a person expects of it, if they said. */
export interface CalibrationTarget {
  dataset: string;
  number: number;
  expected: Verdict | null;
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
}

const PR_REF = /^(?:nemarDatasets\/)?((?:nm|xx|on)\d{6})#(\d{1,9})$/;
const SHA40 = /^[0-9a-f]{40}$/;
const VERDICT_WORDS = ["pass", "fail", "uncertain"] as const;

/** Read `nm000153#2` (or `nemarDatasets/nm000153#2`) and an optional expected outcome. */
export function parseTarget(line: string): CalibrationTarget | null {
  const [ref, expected, ...rest] = line.trim().split(/\s+/);
  if (ref === undefined || rest.length > 0) return null;
  const m = ref.match(PR_REF);
  if (!m?.[1] || !m[2]) return null;
  if (expected !== undefined && !(VERDICT_WORDS as readonly string[]).includes(expected)) {
    return null;
  }
  return { dataset: m[1], number: Number(m[2]), expected: (expected as Verdict) ?? null };
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
const ACCEPTED_FLAGS = ["pr", "prs", "json"] as const;
const KNOWN_FLAGS: ReadonlySet<string> = new Set<string>([...ACCEPTED_FLAGS, ...REFUSED_FLAGS]);

/**
 * Why a pull request could not be read before its review began, as a closed word for the table:
 * `gh` failed or answered with something that is not a pull request, the pull request names no
 * base or head commit, or git could not fetch them.
 */
export const CALIBRATION_READ_ERRORS = ["gh_failed", "no_commit", "fetch_failed"] as const;
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

export interface FetchedPullRequest {
  dir: string;
  base: string;
  head: string;
  pr: Record<string, unknown>;
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
      },
      observe,
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

function usage(why: string): number {
  console.error(`pr-review-calibrate: ${why}`);
  console.error(
    "usage: pr-review-calibrate.ts (--pr nm000153#2 ... | --prs FILE) [--json]\n" +
      "       FILE: one pull request per line, optionally followed by pass, fail or uncertain",
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
 * Read the arguments, refuse what would post or leak the key, calibrate, and print. `read` is where
 * each pull request comes from, as for {@link calibrateOne}.
 */
export async function calibrateMain(
  argv: readonly string[],
  out: (line: string) => void = (l) => console.log(l),
  read: (t: CalibrationTarget, root: string) => FetchedPullRequest = fetchPullRequest,
): Promise<number> {
  if (process.env.PR_REVIEW_CALLBACK_TOKEN) {
    return usage("a review's callback token is set here; calibrate posts nothing and will not run");
  }
  const redirecting = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].filter(
    (name) => process.env[name] !== undefined,
  );
  if (redirecting.length > 0) {
    return usage(
      `${redirecting.join(" and ")} ${redirecting.length === 1 ? "is" : "are"} set; unset ${redirecting.length === 1 ? "it" : "them"} so the key goes only to the Anthropic API`,
    );
  }
  const targets: CalibrationTarget[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // Only the flag's name is read, and it is said only if the script knows it. What follows an `=`
    // is a value, and a value is never echoed: it may be a token, and a refusal is no place to
    // print one. An unknown name is no safer, since a key pasted after two dashes is one.
    const name = arg.startsWith("--") ? (arg.slice(2).split("=", 1)[0] ?? "") : null;
    if (name === null) return usage("arguments are flags: --pr, --prs and --json");
    if (!KNOWN_FLAGS.has(name)) return usage("unknown flag");
    if (REFUSED_FLAGS.has(name)) {
      return usage(`--${name} is refused: calibrate posts nothing and reviews no dispatch`);
    }
    if (arg.includes("=")) return usage("write a flag and its value as two arguments");
    if (name === "json") {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return usage(`--${name} needs a value`);
    i++;
    if (name === "pr") {
      const t = parseTarget(value);
      if (t === null) return usage("--pr needs a pull request like nm000153#2");
      targets.push(t);
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

  const root = mkdtempSync(join(tmpdir(), "pr-review-calibrate-"));
  try {
    const rows: CalibrationRow[] = [];
    for (const t of once) rows.push(await calibrateOne(t, root, read));
    if (json) out(JSON.stringify(rows, null, 2));
    else for (const line of renderTable(rows)) out(line);
    return exitCodeOf(rows);
  } finally {
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
