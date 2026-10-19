/**
 * The publication review's offline calibration (ADR 0102, call 6; design note, section 7).
 *
 * Before the review is turned on, someone should know how often its model is wrong on published
 * datasets and how many seeded defects it catches. This module runs the review job's own path over
 * a corpus (`publication-review-corpus.ts`) and records, for each entry, what the review would have
 * concluded. It is run by an operator, from a machine that holds the model credentials, through
 * `publication-review.ts calibrate`.
 *
 * **It measures what production does, because it runs what production runs.** Each entry goes
 * through the production pre-send module (`presend`), the production prompt builder, the
 * production model call (`callPublicationReviewModel`, with the calibration model as its one
 * argument) and the production report assembly (`assemblePublicationReport`, which parses with the
 * calibration list of models only when the model is not the production one). None of it is copied;
 * a test compares the request calibration sends with the request the review sends for the same
 * dataset. The facts are put together by the one function the review uses too
 * (`evidenceFromDocuments`), over the documents and the summary taken from the corpus instead of
 * from git, and a test compares the evidence both sides produce for the same dataset.
 *
 * **It posts nothing.** It never imports the review's callback poster or the callback origin
 * table, it has no network call of its own, and `calibrateMain` refuses every argument that names a
 * review, an environment or an origin, and refuses to run where the review's callback token is set.
 * The model call is the only network traffic.
 *
 * **What a record holds.** An id, a label, closed words (the outcome, the reason codes, the
 * answers, the finding codes, the document states, the error word), token counts and a timing. Never
 * a document's text and never a word the model wrote: the output file can be read, shared and kept
 * without carrying the datasets' text. The one place the model's words go is the review sheet, a
 * separate file for the maintainer's judgments, which is refused anywhere inside a working tree of
 * this repository.
 *
 * **What the facts are.** The release is named and unreleased. The tag is `absent` (the tag does
 * not exist before the release; for a description with no Version it is the tag of 1.0.0, which
 * is what an approval would publish), and `not_applicable` only for a malformed Version, which has
 * no version to look up. BIDS is `unknown`: the calibration does not run the validator, and an
 * unknown result is a reason of the production verdict (`bids_unconcluded_at_review`) that would
 * make every entry a non-pass, so that one reason is left out of the outcome and everything else is
 * kept.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isOneOf } from "../../shared/pr-review";
import {
  type Answer,
  CALIBRATION_MODELS,
  type CalibrationModel,
  type ClearedDocuments,
  type DocumentState,
  type LiveFacts,
  PUBLICATION_OUTCOMES,
  type PublicationFindingCode,
  type PublicationOutcome,
  type PublicationReviewReport,
  QUESTIONS,
  type Question,
  type Reason,
  type ReasonCode,
  type ReviewDocument,
  type ReviewFacts,
  answersOf,
  reasonsOf,
  reportReasons,
  verdictOf,
} from "../../shared/publication-review";
import { GITHUB_DATASETS } from "../identifier-screen-ci-lib";
import { type JobRunError, callPublicationReviewModel, mapError } from "./publication-review";
import {
  type BuildCorpusResult,
  type CorpusEntry,
  CorpusError,
  DEFECTS,
  type Label,
  buildCorpus,
  listEntries,
  mutateCorpus,
} from "./publication-review-corpus";
import { evidenceFromDocuments } from "./publication-review-evidence";
import {
  PUBLICATION_REVIEW_MODEL,
  assemblePublicationReport,
  buildPublicationReviewMessages,
} from "./publication-review-prompt";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Why the calibration refused to start. A closed list: a word is printed, never a quotation. */
export const CALIBRATION_ERRORS = [
  "out_exists",
  "sheet_exists",
  "sheet_is_out",
  "sheet_inside_repository",
  "empty_corpus",
  "bad_limit",
] as const;
export type CalibrationErrorCode = (typeof CALIBRATION_ERRORS)[number];

export class CalibrationError extends Error {
  readonly code: CalibrationErrorCode;
  constructor(code: CalibrationErrorCode) {
    super(code);
    this.name = "CalibrationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------------------------

/** One line of the output file. See the file header for what is, and is not, in it. */
export interface CalibrationRecord {
  /** The corpus entry's id. */
  id: string;
  /** `good`, or the defect that was applied. */
  label: Label;
  /** The model the review asked. */
  model: CalibrationModel;
  /** The verdict derived from the report, or `error` when no report was made. */
  outcome: PublicationOutcome | "error";
  /** Why a run made no report, as the job would have posted it. */
  error: JobRunError | null;
  /** Every reason of the verdict, in the order surfaces list them. */
  reasons: ReasonCode[];
  /** The four answers after the facts have lowered what they can: what the verdict is derived from. */
  answers: Record<Question, Answer> | null;
  /** The four answers as the model gave them, after the report's own agreement rules. */
  model_answers: Record<Question, Answer> | null;
  steering: boolean | null;
  /** One code per finding, in the model's order. */
  finding_codes: PublicationFindingCode[];
  /** What the pre-send module did with each document. */
  documents: Record<ReviewDocument, DocumentState> | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Milliseconds from the first read of the entry to the assembled report. */
  ms: number;
}

/** What the review sheet carries beyond a record: the model's words, and only there. */
interface SheetFields {
  summary: string;
  notes: string[];
}

/**
 * The reasons the calibration cannot establish and so does not count: the BIDS validator is not
 * run, so the result is `unknown` for every entry, and the production verdict reads that as a
 * reason that needs a person.
 */
export const NOT_ESTABLISHED_IN_CALIBRATION: readonly ReasonCode[] = ["bids_unconcluded_at_review"];

/**
 * The live facts of a request that does not exist: an ordinary, unblocked, named request whose
 * screen is clear at the commit, with no version released and no DOI. Every fact is neutral, so
 * the reasons are the report's own.
 */
function neutralLiveFacts(head: string): LiveFacts {
  return {
    request: { status: "requested", block_reason: null, anonymous: false },
    screen: { gate: "clear", head, acknowledged_by: null, head_current: null },
    versions: { version_row_exists: false, prior_anonymous_request: false, first_published: false },
    doi: { concept_doi_present: false, concept_ezid_status: null },
  };
}

/**
 * The outcome the review would have stored for this report and the reasons behind it, by the
 * shared `reasonsOf` and `verdictOf`, less {@link NOT_ESTABLISHED_IN_CALIBRATION}.
 */
export function deriveOutcome(report: PublicationReviewReport): {
  outcome: PublicationOutcome;
  reasons: Reason[];
} {
  const stored = verdictOf(reportReasons(report));
  const all = reasonsOf({
    live: neutralLiveFacts(report.evidence.head),
    row: { kind: "reported", report, stored },
  });
  const reasons = all.filter((r) => !NOT_ESTABLISHED_IN_CALIBRATION.includes(r.code));
  return { outcome: verdictOf(reasons), reasons };
}

/**
 * The evidence and the cleared documents for one entry: the job's own function over the documents
 * and the summary read from the corpus instead of git. A named, unreleased release (no tags file, so
 * no tag exists), and the BIDS result is not established here (`unknown`).
 */
export function evidenceOf(entry: CorpusEntry): { facts: ReviewFacts; cleared: ClearedDocuments } {
  return evidenceFromDocuments(entry.docs, {
    head: entry.head,
    anonymous: false,
    tagsText: "",
    bidsRuns: null,
    summary: entry.summary,
  });
}

async function reviewEntry(
  entry: CorpusEntry,
  model: CalibrationModel,
): Promise<{ record: CalibrationRecord; sheet: SheetFields }> {
  const started = performance.now();
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  let documents: Record<ReviewDocument, DocumentState> | null = null;
  const base = { id: entry.id, label: entry.label, model };
  const tokens = () => ({
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    ms: Math.round(performance.now() - started),
  });
  try {
    const { facts, cleared } = evidenceOf(entry);
    documents = { ...facts.documents };
    const { system, user } = buildPublicationReviewMessages({
      facts,
      cleared,
      nonce: randomUUID().replaceAll("-", ""),
    });
    const modelOutput = await callPublicationReviewModel(system, user, model, (u) => {
      usage = u;
    });
    const report = assemblePublicationReport(modelOutput, facts, model);
    const { outcome, reasons } = deriveOutcome(report);
    return {
      record: {
        ...base,
        outcome,
        error: null,
        reasons: reasons.map((r) => r.code),
        answers: { ...answersOf(report).answers },
        model_answers: { ...report.questions },
        steering: report.steering,
        finding_codes: report.findings.map((f) => f.code),
        documents,
        ...tokens(),
      },
      sheet: { summary: report.summary, notes: report.findings.map((f) => f.note) },
    };
  } catch (e) {
    return {
      record: {
        ...base,
        outcome: "error",
        error: mapError(e),
        reasons: [],
        answers: null,
        model_answers: null,
        steering: null,
        finding_codes: [],
        documents,
        ...tokens(),
      },
      sheet: { summary: "", notes: [] },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The review sheet: the maintainer's judgments, outside the repository
// ---------------------------------------------------------------------------------------------

/** The repository this script is part of. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** The path as it is on disk: symlinks and letter case resolved as far as the path exists. */
function locate(path: string): { dir: string; full: string } {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const real = realpathSync.native(existing);
  return { dir: statSync(real).isDirectory() ? real : dirname(real), full: join(real, ...rest) };
}

/** The repository's common git directory (the same for every working tree of it), or null. */
function commonGitDir(dir: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    ).trim();
    return out === "" ? null : realpathSync.native(out);
  } catch {
    return null;
  }
}

/**
 * Whether `path` is inside a working tree of the repository at `repoRoot` (default: this one):
 * under its directory, or anywhere in another working tree of it (a worktree shares the
 * repository's git directory), by any spelling of the path (`..`, a symlink, a different case). A
 * file written there could be committed, and the sheet holds the model's words.
 */
export function isInsideRepository(path: string, repoRoot: string = REPO_ROOT): boolean {
  const root = realpathSync.native(repoRoot);
  const target = locate(path);
  if (target.full === root || target.full.startsWith(root + sep)) return true;
  const theirs = commonGitDir(target.dir);
  return theirs !== null && theirs === commonGitDir(root);
}

export function assertOutsideRepository(path: string, repoRoot: string = REPO_ROOT): void {
  if (isInsideRepository(path, repoRoot)) throw new CalibrationError("sheet_inside_repository");
}

/** A path for the review sheet in the system's temporary directory: never inside the repository. */
export function defaultSheetPath(model: CalibrationModel): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(tmpdir(), `publication-review-sheet-${model}-${stamp}.csv`);
}

const SHEET_COLUMNS = [
  "id",
  "label",
  "outcome",
  "reasons",
  ...QUESTIONS,
  "steering",
  "summary",
  "notes",
  "judged_wrong",
  "comment",
] as const;

/**
 * One CSV cell. A cell a spreadsheet would run as a formula (the model's words come from text a
 * depositor wrote, and a calibration defect is exactly such text) is made plain text with a leading
 * apostrophe; a cell with a comma, a quote or a line break is quoted.
 */
function csvCell(value: string): string {
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sheetRow(record: CalibrationRecord, sheet: SheetFields): string {
  const cells = [
    record.id,
    record.label,
    record.outcome === "error" ? `error:${record.error}` : record.outcome,
    record.reasons.join(";"),
    ...QUESTIONS.map((q) => record.answers?.[q] ?? ""),
    record.steering === null ? "" : String(record.steering),
    sheet.summary,
    sheet.notes.join(" | "),
    "",
    "",
  ];
  return cells.map(csvCell).join(",");
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

export interface CalibrateOptions {
  corpusDir: string;
  /** The records file, one JSON line per entry. Must not exist. */
  out: string;
  /** Defaults to the production model. */
  model?: CalibrationModel;
  /** Only the first `limit` entries, in id order. */
  limit?: number;
  /** Where to write the review sheet. Must not exist and must be outside the repository. */
  reviewSheet?: string;
}

export interface CalibrateResult {
  records: number;
  errors: number;
  outcomes: Record<PublicationOutcome | "error", number>;
}

/**
 * Review every entry of a corpus and write one record per entry to `out`, each as soon as it is
 * made, so a run that stops keeps what it did. Everything that can be refused is refused before
 * the first model call: an existing output, a sheet inside the repository, a corpus that is empty
 * or not a corpus.
 */
export async function calibrate(opts: CalibrateOptions): Promise<CalibrateResult> {
  const model = opts.model ?? PUBLICATION_REVIEW_MODEL;
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
    throw new CalibrationError("bad_limit");
  }
  const out = resolve(opts.out);
  if (existsSync(out)) throw new CalibrationError("out_exists");
  const sheetPath = opts.reviewSheet === undefined ? null : resolve(opts.reviewSheet);
  if (sheetPath !== null) {
    if (sheetPath === out) throw new CalibrationError("sheet_is_out");
    assertOutsideRepository(sheetPath);
    if (existsSync(sheetPath)) throw new CalibrationError("sheet_exists");
  }
  const all = listEntries(opts.corpusDir);
  if (all.length === 0) throw new CalibrationError("empty_corpus");
  const entries = opts.limit === undefined ? all : all.slice(0, opts.limit);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "", { flag: "wx" });
  const rows: string[] = [];
  const outcomes: CalibrateResult["outcomes"] = { pass: 0, fail: 0, action_required: 0, error: 0 };
  for (const entry of entries) {
    const { record, sheet } = await reviewEntry(entry, model);
    appendFileSync(out, `${JSON.stringify(record)}\n`);
    outcomes[record.outcome]++;
    if (sheetPath !== null) rows.push(sheetRow(record, sheet));
  }
  if (sheetPath !== null) {
    mkdirSync(dirname(sheetPath), { recursive: true });
    writeFileSync(sheetPath, `${[SHEET_COLUMNS.join(","), ...rows].join("\n")}\n`, { flag: "wx" });
  }
  return { records: entries.length, errors: outcomes.error, outcomes };
}

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

/** What `calibrate corpus` and `calibrate run` accept; each takes the value after it. */
const FLAGS = {
  corpus: {
    "ids-file": "value",
    out: "value",
    "mutate-per-defect": "value",
    "remote-base": "value",
  },
  run: {
    corpus: "value",
    out: "value",
    model: "value",
    limit: "value",
    "review-sheet": "optional",
  },
} as const;

/**
 * The review's own arguments. A calibration is told none of them: each names a review to report,
 * an environment to report to, or a repository to read, and so would mean something posts.
 */
const REVIEW_FLAGS = new Set([
  "environment",
  "callback-url",
  "callback-token",
  "origin",
  "token",
  "review-id",
  "request-id",
  "dataset",
  "repo-dir",
  "head",
  "fetched-head",
  "tags-file",
  "bids-runs-file",
  "anonymous",
]);

type ParsedFlags = { ok: true; values: Map<string, string | true> } | { ok: false; why: string };

function parseFlags(
  argv: readonly string[],
  spec: Record<string, "value" | "optional">,
): ParsedFlags {
  const values = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name === null) return { ok: false, why: "unexpected argument" };
    if (REVIEW_FLAGS.has(name)) {
      return {
        ok: false,
        why: `--${name} is refused: calibrate posts nothing and reviews no request`,
      };
    }
    const kind = spec[name];
    if (kind === undefined) return { ok: false, why: "unknown argument" };
    if (values.has(name)) return { ok: false, why: `--${name} given twice` };
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      i++;
    } else if (kind === "optional") {
      values.set(name, true);
    } else {
      return { ok: false, why: `--${name} needs a value` };
    }
  }
  return { ok: true, values };
}

function positive(value: string): number | null {
  const n = Number(value);
  return /^\d{1,9}$/.test(value) && n >= 1 ? n : null;
}

function readIds(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

async function corpusCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, FLAGS.corpus);
  if (!parsed.ok) return usage(parsed.why);
  const { values } = parsed;
  const idsFile = values.get("ids-file");
  const outDir = values.get("out");
  if (typeof idsFile !== "string" || typeof outDir !== "string") {
    return usage("--ids-file and --out are required");
  }
  const perDefectText = values.get("mutate-per-defect");
  let perDefect = 6;
  if (perDefectText !== undefined) {
    if (perDefectText === "0") perDefect = 0;
    else {
      const n = typeof perDefectText === "string" ? positive(perDefectText) : null;
      if (n === null) return usage("--mutate-per-defect must be a whole number, 0 or more");
      perDefect = n;
    }
  }
  const remoteBase = values.get("remote-base");
  let ids: string[];
  try {
    ids = readIds(idsFile);
  } catch {
    return usage("the ids file could not be read");
  }
  let result: BuildCorpusResult;
  try {
    result = await buildCorpus({
      ids,
      outDir,
      remoteBase: typeof remoteBase === "string" ? remoteBase : GITHUB_DATASETS,
    });
  } catch (e) {
    if (e instanceof CorpusError) return usage(e.code);
    throw e;
  }
  console.log(`corpus: ${result.built} built, ${result.skipped} skipped`);
  for (const skip of result.skips) console.log(`skipped ${skip.id}: ${skip.reason}`);
  if (perDefect > 0) {
    const mutated = mutateCorpus(outDir, { perDefect });
    console.log(
      `mutated copies: ${mutated.made} made, ${mutated.skipped} not applicable (${DEFECTS.length} defects)`,
    );
  }
  return result.built > 0 ? 0 : 1;
}

async function runCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, FLAGS.run);
  if (!parsed.ok) return usage(parsed.why);
  const { values } = parsed;
  const corpusDir = values.get("corpus");
  const out = values.get("out");
  if (typeof corpusDir !== "string" || typeof out !== "string") {
    return usage("--corpus and --out are required");
  }
  const modelText = values.get("model") ?? PUBLICATION_REVIEW_MODEL;
  if (typeof modelText !== "string" || !isOneOf(CALIBRATION_MODELS, modelText)) {
    return usage(`--model must be one of ${CALIBRATION_MODELS.join(", ")}`);
  }
  const limitText = values.get("limit");
  let limit: number | undefined;
  if (limitText !== undefined) {
    const n = typeof limitText === "string" ? positive(limitText) : null;
    if (n === null) return usage("--limit must be a whole number, 1 or more");
    limit = n;
  }
  const sheetFlag = values.get("review-sheet");
  const reviewSheet =
    sheetFlag === undefined
      ? undefined
      : sheetFlag === true
        ? defaultSheetPath(modelText)
        : sheetFlag;
  try {
    const result = await calibrate({
      corpusDir,
      out,
      model: modelText,
      ...(limit === undefined ? {} : { limit }),
      ...(reviewSheet === undefined ? {} : { reviewSheet }),
    });
    const counts = PUBLICATION_OUTCOMES.map((o) => `${o} ${result.outcomes[o]}`).join(", ");
    console.log(
      `calibrate: ${result.records} records, ${result.errors} errors (${counts}); model ${modelText}`,
    );
    if (reviewSheet !== undefined) console.log(`review sheet: ${reviewSheet}`);
    // A run in which nothing could be reviewed is a failure, whatever the reason; the words are
    // in the records.
    return result.records > 0 && result.errors === result.records ? 1 : 0;
  } catch (e) {
    if (e instanceof CalibrationError || e instanceof CorpusError) return usage(e.code);
    throw e;
  }
}

function usage(why: string): number {
  console.error(`calibrate: ${why}`);
  console.error(
    [
      "usage: publication-review.ts calibrate corpus --ids-file FILE --out DIR [--mutate-per-defect N] [--remote-base URL]",
      "       publication-review.ts calibrate run --corpus DIR --out FILE [--model MODEL] [--limit N] [--review-sheet [FILE]]",
    ].join("\n"),
  );
  return 2;
}

/**
 * `publication-review.ts calibrate ...`: `corpus` builds a corpus from public repositories, and
 * `run` runs the calibration over one. Both refuse the review's own arguments (an `--environment`
 * above all), and refuse to run at all where the review's callback token is set, so nothing here can
 * be run as, or mistaken for, a review that posts.
 */
export async function calibrateMain(argv: readonly string[]): Promise<number> {
  if (process.env.PUBLICATION_REVIEW_CALLBACK_TOKEN) {
    return usage("a review's callback token is set here; calibrate posts nothing and will not run");
  }
  const [command, ...rest] = argv;
  if (command === "corpus") return corpusCommand(rest);
  if (command === "run") return runCommand(rest);
  return usage("expected corpus or run");
}
