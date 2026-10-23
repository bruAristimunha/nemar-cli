/**
 * The dataset pull-request review's contract (ADR 0092, ADR 0107): the report a review run posts,
 * the verdict derived from it, the check-run words shown to people, and the one standing decision
 * about a contributor, an administrator's block.
 *
 * One module, three readers. The workflow script builds a report with it, the Worker parses
 * what comes back with it before storing a byte, and the check-run is rendered from it, so
 * the check, the stored row and the tally cannot disagree about what a review said.
 *
 * **Two stages, one report (version 2).** A screen (stage 1) reads only the pull request's own
 * metadata and may stop it as spam; everything it does not stop goes to the review (stage 2), which
 * reads the content. The report says which stage it ended at (`stage`), and a report that ended at
 * the screen can never pass. A review can also end before either: the naming rule needs no model, so
 * a pull request whose title breaks it, or whose changed dataset name breaks it or cannot be read,
 * is reported at the `facts` stage with no model asked, nothing assessed and no tokens spent; it can
 * never pass either. Rows written before the screen existed hold version 1 reports, which
 * {@link parseStoredPrReviewReport} still reads with their own rules, so a stored verdict does not
 * change; a version 1 report arriving by callback is refused.
 *
 * **Every field of a pull request is attacker-controlled text**: title, body, commit messages,
 * file names, file contents. That text reaches a language model, and the model's output reaches
 * a public-facing check-run. Three rules keep the model from steering the outcome:
 *
 *  1. **The verdict is derived, never reported.** The model supplies a result per criterion and
 *     some findings. {@link verdictOf} decides pass, fail or uncertain from those and from
 *     facts the script computed from git, and no field of the report is "the verdict".
 *  2. **Facts override the model.** A criterion the facts contradict cannot pass, whatever the
 *     model said ({@link factsOf}): the git facts, the change log's entry for a new version, an
 *     empty or cut description, and the naming rule on the title and on the dataset's name, which
 *     is also unable to pass a name it could not read.
 *  3. **Free text is a note, never markup.** The one place a model's words reach a person,
 *     {@link sanitizeNote}, removes links, mentions, cross-references, HTML and emphasis, so a
 *     note cannot ping someone, link anywhere or hide the verdict.
 *
 * **Unknown is never green** (ADR 0053, ADR 0054, ADR 0086). Anything that is not a clear pass maps to a
 * conclusion that does not satisfy a required check: `neutral` and `skipped` DO satisfy one on
 * GitHub, which is why `neutral` appears nowhere in {@link conclusionOf}, and `skipped` for exactly
 * one outcome, `exempt`: a pull request opened by a NEMAR owner or administrator is not reviewed at
 * all, so there is no unknown in it to hide (ADR 0107). The naming rule still applies to it: a title
 * or a dataset name that breaks the rule is a `naming` outcome, which fails.
 *
 * The parser throws a fixed-word {@link PrReviewReportError}; it never quotes its input.
 */

import { NAMING_PROBLEMS, type NamingProblem } from "./naming-rule.js";
import { sanitizeNote } from "./untrusted-text.js";

// The sanitizer lives in `shared/untrusted-text.ts`, shared with the publication review
// (ADR 0102); it is re-exported so every importer of this module keeps working.
export { sanitizeNote };
// The naming rule's words, declared with the rule itself.
export { NAMING_PROBLEMS, type NamingProblem };

/** The report version the job writes and a callback must carry. */
export const REPORT_VERSION = 2;

/** The check-run's name. Stable: a ruleset that requires the check names it. */
export const PR_REVIEW_CHECK_NAME = "NEMAR PR Review";

/**
 * Where a review ended: at the screen (stage 1), after the full review (stage 2), or at the facts,
 * before either, because the naming rule had already decided it and no model was asked.
 */
export const REVIEW_STAGES = ["screen", "full", "facts"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

/**
 * The models a report may name, per stage. Closed sets, so a model change is a reviewed code change.
 * The screen is the small model, because it reads only a pull request's own text and may stop only
 * spam; the review reads the content and judges the text.
 */
export const SCREEN_MODELS = ["claude-haiku-5-5"] as const;
export type ScreenModel = (typeof SCREEN_MODELS)[number];
export const REVIEW_MODELS = ["claude-sonnet-5-5"] as const;
export type ReviewModel = (typeof REVIEW_MODELS)[number];
/** The one model a version 1 report could name. Read back from stored rows only. */
export const V1_MODELS = ["claude-haiku-5-5"] as const;
export type V1Model = (typeof V1_MODELS)[number];

/**
 * What a pull request to a dataset is asked to be: the six criteria of a version 2 report.
 *
 *  - `genuine_contribution`: set by the script from the screen, never by a model's say-so in the
 *    review: proceed is a pass, a stop is a fail.
 *  - `no_degradation`, `advances_revision`, `material_improvement`: the review's three questions
 *    about the files.
 *  - `clear_title_and_description`: the title and the description say, in readable words, what
 *    changed.
 *  - `description_not_misleading`: the description does not contradict the title or itself.
 */
export const CRITERIA = [
  "genuine_contribution",
  "no_degradation",
  "advances_revision",
  "material_improvement",
  "clear_title_and_description",
  "description_not_misleading",
] as const;
export type Criterion = (typeof CRITERIA)[number];

/** The three questions of a version 1 report, which stored rows still hold. */
export const V1_CRITERIA = ["no_degradation", "advances_revision", "material_improvement"] as const;
export type V1Criterion = (typeof V1_CRITERIA)[number];

export const CRITERION_RESULTS = ["pass", "fail", "unknown"] as const;
export type CriterionResult = (typeof CRITERION_RESULTS)[number];

export const SEVERITIES = ["blocker", "concern", "note"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Why a finding exists. Closed, so the tally and the check can say it without quoting anyone. */
export const FINDING_CODES = [
  "data_removed",
  "metadata_removed",
  "structure_broken",
  "validation_regressed",
  "version_not_advanced",
  "changes_log_missing",
  "changes_log_mismatch",
  "description_mismatch",
  "churn_only",
  "no_substantive_change",
  "improvement_unclear",
  "evidence_incomplete",
  "steering_attempt",
  // The screen's one reason to stop a pull request.
  "spam",
  // The review's judgments of the pull request's own text.
  "title_placeholder",
  "title_not_descriptive",
  "description_missing",
  "description_placeholder",
  "description_misleading",
  // The description is longer than the models read, so part of it was not assessed.
  "description_cut",
  // The naming rule (`shared/naming-rule.ts`), decided by the script and never by a model.
  "title_author_year",
  "title_doi",
  "title_template_field",
  "name_author_year",
  "name_doi",
  "name_template_field",
  // The pull request changes dataset_description.json and its new name could not be read.
  "name_unchecked",
  // What the original authors published was changed or what was recorded was replaced (epic #1851,
  // Part B). The review script decides these from platform facts and never a model, and has
  // emitted them since Part B was integrated into the review. They have been accepted here since
  // v0.10.22, a release earlier, because the review script runs from `main` as soon as it is
  // released while the Worker deploys separately.
  "original_text_altered",
  "original_field_altered",
  "recording_replaced",
  "other",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export const MAX_FINDINGS = 8;
export const NOTE_MAX = 200;
export const SUMMARY_MAX = 400;

/**
 * The most changed files the model is shown by name. A change list longer than this is cut, and a
 * report for one must say `truncated` ({@link parsePrReviewReport} refuses one that does not).
 */
export const MAX_MODEL_FILES = 400;

/** What a review concludes. Derived by {@link verdictOf}, stored beside the report. */
export const VERDICTS = ["pass", "fail", "uncertain"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** A stored review's lifecycle. Kept equal to the CHECK in migration 0092 by a test. */
export const REVIEW_STATES = [
  "dispatched",
  "reported",
  "declined",
  "errored",
  "unreported",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** A maintainer's standing decision about one contributor. */
export const OVERRIDE_MODES = ["allow", "block"] as const;
export type OverrideMode = (typeof OVERRIDE_MODES)[number];

export function isOverrideMode(x: unknown): x is OverrideMode {
  return isOneOf(OVERRIDE_MODES, x);
}

export interface ReviewFinding {
  criterion: Criterion;
  severity: Severity;
  code: FindingCode;
  /** A repository path the finding is about, or null. Pattern-checked, never trusted. */
  path: string | null;
  /** Sanitized free text, at most {@link NOTE_MAX} characters. */
  note: string;
}

/**
 * Where in a dataset a changed file sits. Closed, so a change summary can be counted, shown and
 * compared without quoting a path. The script that fills it is `classifyPath` in
 * `scripts/ci/pr-review-evidence.ts`; this list is what the Worker will accept.
 */
export const AREAS = [
  "dataset_description",
  "readme_and_changes",
  "participants",
  "sidecars",
  "recordings",
  "derivatives",
  "sourcedata",
  "code",
  "other",
] as const;
export type Area = (typeof AREAS)[number];

export interface AreaCounts {
  added: number;
  modified: number;
  removed: number;
}

export const CHANGE_STATUSES = ["added", "modified", "removed"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/** The most changed files a report lists for a person to open. The counts above are exact. */
export const MAX_LISTED = 50;

export interface ChangedFile {
  status: ChangeStatus;
  /** Null when the name is not path-shaped; the file is still counted. */
  path: string | null;
}

/**
 * Facts the script computed from git, as a version 1 report carries them. The model never writes
 * this block, so the account of what changed cannot be shaded by it: the counts come from the whole
 * change list, and they must add up to `files_changed` ({@link parsePrReviewReport} refuses a report
 * where they do not).
 */
export interface ReviewEvidenceV1 {
  files_changed: number;
  /** How many changed files had their content (a diff) given to the model, a change repeated line for line across files counted for each file it covers. The rest were judged by name and type. */
  files_read: number;
  /**
   * Something the reviewer needed to see was not shown in full: the change list was cut at
   * {@link MAX_MODEL_FILES}, a modified or removed metadata file was not read or was cut, or a read
   * failed. A pass about nothing being lost cannot be trusted then. Unread ADDED files do not set
   * it (a new file cannot remove anything), but they still count in `files_changed` and not in
   * `files_read`.
   */
  truncated: boolean;
  version_before: string | null;
  version_after: string | null;
  subjects_before: number | null;
  subjects_after: number | null;
  areas: Record<Area, AreaCounts>;
  /** Up to {@link MAX_LISTED} changed files, the ones a reviewer is most likely to open first. */
  listed: ChangedFile[];
}

/**
 * The facts of a version 2 report: version 1's, and five more that the platform decides itself, from
 * the pull request as the API returns it and from git, whatever a model says ({@link factsOf} turns
 * them into criteria). Four are decided before any model is asked: `description_empty`,
 * `description_cut`, `title_problem` and `name_problem`. The fifth, `changelog_entry`, is read from
 * git after the screen lets the pull request through, so it is null in a `screen` report and in a
 * `facts` report, and a `full` report always has one.
 *
 * Not every fact fails the verdict. An empty description, a title or a new dataset name that breaks
 * the naming rule, and a new version with no entry in the change log each FAIL a criterion. A
 * description cut short for the models (`description_cut`) and a changed dataset name nobody could
 * read (`name_problem` is `unchecked`) only lower a criterion to `unknown`: nothing was found wrong,
 * it was not assessed, and a person has to look.
 */
export interface ReviewEvidence extends ReviewEvidenceV1 {
  /** The pull request's description is empty or only whitespace. */
  description_empty: boolean;
  /**
   * The description is longer than the models read, so they were shown its start and the mark
   * `[cut]`. Whether the rest misleads, or tries to instruct them, was not assessed.
   */
  description_cut: boolean;
  /**
   * What the change log says about the new version (see {@link ChangelogEntry}), or null when no
   * review read it: the content is read only after the screen lets a pull request through, so a
   * report that ended at the screen has none, and a full report always has one.
   */
  changelog_entry: ChangelogEntry | null;
  /** How the title breaks the naming rule, or null when it does not. */
  title_problem: NamingProblem | null;
  /**
   * How the pull request's new dataset name (the `Name` of `dataset_description.json` at the head,
   * when it differs from the name at the merge base) breaks the naming rule; `unchecked` when the
   * pull request changes that file and the head's name cannot be read from it. Null when the name
   * is unchanged or fine, or the file was not touched.
   */
  name_problem: NameFinding | null;
}

/**
 * What the change log says about the new version, as the evidence reader decides it from git:
 *  - `added`: a heading for the new version is in the head's change log and was not in the merge
 *    base's (a heading is a line that starts with the version, after any `#` or `[`, and an
 *    optional `v`, `version` or `release`; a bullet is not a heading);
 *  - `not_added`: the head has a change log but no new heading for the new version, which includes
 *    a heading that was already there, a date-only heading, and a version only mentioned in prose;
 *  - `no_file`: the head has no change log file;
 *  - `unknown_version`: the new version is unknown (absent or not `X.Y.Z`), so the platform cannot
 *    tell what to look for. This is decided first, so it wins over `no_file`.
 * Both models are told this word as a fact, and {@link factsOf} enforces what it means: a revision
 * with no new entry in the change log does not advance, whatever a model answered.
 */
export const CHANGELOG_ENTRIES = ["added", "not_added", "no_file", "unknown_version"] as const;
export type ChangelogEntry = (typeof CHANGELOG_ENTRIES)[number];

/**
 * What the naming rule made of a pull request's new dataset name: one of its two problems, or
 * `unchecked` when the pull request changes `dataset_description.json` and the name in it could not
 * be read (the file is not JSON, or its `Name` is not text or shows a reader nothing, as an empty
 * one or one of zero-width characters does), so there was no name to ask about. An unreadable name
 * is never a clean one.
 */
export type NameFinding = NamingProblem | "unchecked";

/** Tokens one model call used, from the API's own response. */
export interface StageTokens {
  input_tokens: number;
  output_tokens: number;
}

/**
 * What the review cost, counted from the API's responses: the screen's call, and the review's when
 * there was one. Never rendered in a check; the administrator's volume line sums it.
 */
export interface ReviewUsage {
  screen: StageTokens;
  review: StageTokens | null;
}

interface ReportCommon {
  findings: ReviewFinding[];
  summary: string;
  /** The model says the pull request tried to instruct it. Always fails the review. */
  steering: boolean;
}

/** A version 1 report: one model, three questions. Read back from stored rows only. */
export interface ReportShapeV1 extends ReportCommon {
  v: 1;
  model: V1Model;
  criteria: Record<V1Criterion, CriterionResult>;
  evidence: ReviewEvidenceV1;
}

/**
 * A version 2 report: the screen, the review when the screen let it through, six criteria. A model
 * is named only if it was asked: `screen` is null at the `facts` stage, which asked none, and
 * `review` is null unless the review ran.
 */
export interface ReportShapeV2 extends ReportCommon {
  v: typeof REPORT_VERSION;
  stage: ReviewStage;
  models: { screen: ScreenModel | null; review: ReviewModel | null };
  criteria: Record<Criterion, CriterionResult>;
  evidence: ReviewEvidence;
  usage: ReviewUsage;
}

export type ReportShape = ReportShapeV1 | ReportShapeV2;

declare const validated: unique symbol;

/**
 * A report that {@link parsePrReviewReport} or {@link parseStoredPrReviewReport} accepted. The brand
 * makes that a fact of the type for an object literal: one cannot be handed to {@link verdictOf},
 * {@link renderCheck} or a stored {@link ReviewOutcome} without going through a parser, so the
 * closed vocabulary and the counts-must-add-up rule cannot be skipped by accident. It does NOT stop
 * a cast, and it does not stop a spread of a parsed report (`{ ...report, steering: false }` keeps
 * the brand in its type), and `Readonly` is shallow. The brand guards against forgetting to parse,
 * not against someone who means to bypass it; a test keeps `as PrReviewReport` out of every other
 * file.
 */
export type PrReviewReport = (Readonly<ReportShapeV1> | Readonly<ReportShapeV2>) & {
  readonly [validated]: true;
};

/** The criteria a report answers, in the order a person reads them. */
export function criteriaOf(report: Pick<ReportShape, "v">): readonly Criterion[] {
  return report.v === 1 ? V1_CRITERIA : CRITERIA;
}

/** One criterion's answer, or undefined when the report's version does not ask it. */
function resultOf(
  criteria: Readonly<Partial<Record<Criterion, CriterionResult>>>,
  c: Criterion,
): CriterionResult | undefined {
  return criteria[c];
}

// ---------------------------------------------------------------------------------------------
// Parsing: a closed vocabulary, enforced at the door.
// ---------------------------------------------------------------------------------------------

/** Fixed words a refused report is described with. Never a quotation of the input. */
export const REPORT_ERRORS = [
  "not_an_object",
  "unknown_key",
  "bad_version",
  "bad_model",
  "bad_stage",
  "bad_criteria",
  "bad_findings",
  "bad_summary",
  "bad_steering",
  "bad_evidence",
  "bad_usage",
] as const;
export type ReportErrorCode = (typeof REPORT_ERRORS)[number];

export class PrReviewReportError extends Error {
  readonly code: ReportErrorCode;
  constructor(code: ReportErrorCode) {
    super(code);
    this.name = "PrReviewReportError";
    this.code = code;
  }
}

/** A plain `X.Y.Z` version, the only shape a report may carry. The evidence reader uses the same. */
export const SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
/** A BIDS-shaped path. Anything else is dropped from a finding, not trusted into a check-run. */
const SAFE_PATH = /^[A-Za-z0-9._\-/]{1,200}$/;
const MAX_FILES = 10_000_000;
/** More tokens than any one call can use, input and output together; a larger count is not a count. */
const MAX_TOKENS_COUNTED = 10_000_000;

/** Whether `x` is one of the words in a closed list, as a type guard. */
export function isOneOf<T extends string>(all: readonly T[], x: unknown): x is T {
  return typeof x === "string" && (all as readonly string[]).includes(x);
}

/** A path the report may show, or null: BIDS-shaped, no traversal. */
function safePath(p: unknown): string | null {
  return typeof p === "string" && SAFE_PATH.test(p) && !p.includes("..") ? p : null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

function parseFinding(raw: unknown, criteria: readonly Criterion[]): ReviewFinding {
  if (!isRecord(raw) || !hasExactKeys(raw, ["criterion", "severity", "code", "path", "note"])) {
    throw new PrReviewReportError("bad_findings");
  }
  const { criterion, severity, code, path, note } = raw;
  if (
    !isOneOf(criteria, criterion) ||
    !isOneOf(SEVERITIES, severity) ||
    !isOneOf(FINDING_CODES, code)
  ) {
    throw new PrReviewReportError("bad_findings");
  }
  if (path !== null && typeof path !== "string") throw new PrReviewReportError("bad_findings");
  if (typeof note !== "string") throw new PrReviewReportError("bad_findings");
  return { criterion, severity, code, path: safePath(path), note: sanitizeNote(note, NOTE_MAX) };
}

/** A count of files or subjects: a non-negative integer no larger than {@link MAX_FILES}. */
function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > MAX_FILES) {
    throw new PrReviewReportError("bad_evidence");
  }
  return v;
}

function nullableCount(v: unknown): number | null {
  return v === null ? null : count(v);
}

function nullableVersion(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v === "string" && SEMVER.test(v)) return v;
  throw new PrReviewReportError("bad_evidence");
}

function parseAreaCounts(raw: unknown): AreaCounts {
  if (!isRecord(raw) || !hasExactKeys(raw, ["added", "modified", "removed"])) {
    throw new PrReviewReportError("bad_evidence");
  }
  return { added: count(raw.added), modified: count(raw.modified), removed: count(raw.removed) };
}

function parseListed(raw: unknown): ChangedFile {
  if (!isRecord(raw) || !hasExactKeys(raw, ["status", "path"])) {
    throw new PrReviewReportError("bad_evidence");
  }
  const { status, path } = raw;
  if (!isOneOf(CHANGE_STATUSES, status)) throw new PrReviewReportError("bad_evidence");
  if (path !== null && typeof path !== "string") throw new PrReviewReportError("bad_evidence");
  return { status, path: safePath(path) };
}

const EVIDENCE_V1_KEYS = [
  "files_changed",
  "files_read",
  "truncated",
  "version_before",
  "version_after",
  "subjects_before",
  "subjects_after",
  "areas",
  "listed",
] as const;

const EVIDENCE_V2_KEYS = [
  ...EVIDENCE_V1_KEYS,
  "description_empty",
  "description_cut",
  "changelog_entry",
  "title_problem",
  "name_problem",
] as const;

function parseEvidenceV1Fields(raw: Record<string, unknown>): ReviewEvidenceV1 {
  const files_changed = count(raw.files_changed);
  const files_read = count(raw.files_read);
  if (files_read > files_changed || typeof raw.truncated !== "boolean") {
    throw new PrReviewReportError("bad_evidence");
  }
  const rawAreas = raw.areas;
  if (!isRecord(rawAreas) || !hasExactKeys(rawAreas, AREAS)) {
    throw new PrReviewReportError("bad_evidence");
  }
  const areas = {} as Record<Area, AreaCounts>;
  let total = 0;
  for (const a of AREAS) {
    areas[a] = parseAreaCounts(rawAreas[a]);
    total += areas[a].added + areas[a].modified + areas[a].removed;
  }
  // Every changed file is in exactly one area. A report whose areas do not add up to its own
  // total has dropped or invented a change, and is refused rather than shown.
  if (total !== files_changed) throw new PrReviewReportError("bad_evidence");
  if (!Array.isArray(raw.listed) || raw.listed.length > MAX_LISTED) {
    throw new PrReviewReportError("bad_evidence");
  }
  // A list cannot hold more files than changed, and a change list longer than the model was
  // shown must say it was cut: `truncated` is the precondition of the `no_degradation` rule.
  if (raw.listed.length > files_changed) throw new PrReviewReportError("bad_evidence");
  if (files_changed > MAX_MODEL_FILES && raw.truncated !== true) {
    throw new PrReviewReportError("bad_evidence");
  }
  return {
    files_changed,
    files_read,
    truncated: raw.truncated,
    version_before: nullableVersion(raw.version_before),
    version_after: nullableVersion(raw.version_after),
    subjects_before: nullableCount(raw.subjects_before),
    subjects_after: nullableCount(raw.subjects_after),
    areas,
    listed: raw.listed.map(parseListed),
  };
}

function parseEvidenceV1(raw: unknown): ReviewEvidenceV1 {
  if (!isRecord(raw) || !hasExactKeys(raw, EVIDENCE_V1_KEYS)) {
    throw new PrReviewReportError("bad_evidence");
  }
  return parseEvidenceV1Fields(raw);
}

function nullableNamingProblem(v: unknown): NamingProblem | null {
  if (v === null) return null;
  if (isOneOf(NAMING_PROBLEMS, v)) return v;
  throw new PrReviewReportError("bad_evidence");
}

/** A name's finding: a title is never `unchecked`, only a name that could not be read. */
function nullableNameFinding(v: unknown): NameFinding | null {
  return v === "unchecked" ? v : nullableNamingProblem(v);
}

function nullableChangelogEntry(v: unknown): ChangelogEntry | null {
  if (v === null) return null;
  if (isOneOf(CHANGELOG_ENTRIES, v)) return v;
  throw new PrReviewReportError("bad_evidence");
}

function parseEvidence(raw: unknown): ReviewEvidence {
  if (!isRecord(raw) || !hasExactKeys(raw, EVIDENCE_V2_KEYS)) {
    throw new PrReviewReportError("bad_evidence");
  }
  if (typeof raw.description_empty !== "boolean" || typeof raw.description_cut !== "boolean") {
    throw new PrReviewReportError("bad_evidence");
  }
  return {
    ...parseEvidenceV1Fields(raw),
    description_empty: raw.description_empty,
    description_cut: raw.description_cut,
    changelog_entry: nullableChangelogEntry(raw.changelog_entry),
    title_problem: nullableNamingProblem(raw.title_problem),
    name_problem: nullableNameFinding(raw.name_problem),
  };
}

function parseTokens(raw: unknown): StageTokens {
  if (!isRecord(raw) || !hasExactKeys(raw, ["input_tokens", "output_tokens"])) {
    throw new PrReviewReportError("bad_usage");
  }
  const tokens = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > MAX_TOKENS_COUNTED) {
      throw new PrReviewReportError("bad_usage");
    }
    return v;
  };
  return { input_tokens: tokens(raw.input_tokens), output_tokens: tokens(raw.output_tokens) };
}

function parseCriteria<C extends Criterion>(
  raw: unknown,
  criteria: readonly C[],
): Record<C, CriterionResult> {
  if (!isRecord(raw) || !hasExactKeys(raw, criteria)) {
    throw new PrReviewReportError("bad_criteria");
  }
  const out = {} as Record<C, CriterionResult>;
  for (const c of criteria) {
    const r = raw[c];
    if (!isOneOf(CRITERION_RESULTS, r)) throw new PrReviewReportError("bad_criteria");
    out[c] = r;
  }
  return out;
}

/**
 * The rules every version shares, which make a report agree with itself in the direction of "needs
 * a person": a finding that says the pull request tried to instruct the reviewer IS a steering
 * attempt whatever the flag says, a criterion cannot pass while a blocker is filed against it, and
 * a criterion that fails with no finding against it gets one (`other`, "No detail given.") so a red
 * check always has something for a person to read. Room for that is made by dropping the model's
 * LAST findings (the prompt asks for most important first), never one of the added ones. None of it
 * can raise anything.
 */
function settle<C extends Criterion>(
  rawFindings: unknown,
  rawSteering: unknown,
  criteria: Record<C, CriterionResult>,
  order: readonly C[],
): { findings: ReviewFinding[]; steering: boolean } {
  if (!Array.isArray(rawFindings) || rawFindings.length > MAX_FINDINGS) {
    throw new PrReviewReportError("bad_findings");
  }
  const findings = rawFindings.map((f) => parseFinding(f, order));
  if (typeof rawSteering !== "boolean") throw new PrReviewReportError("bad_steering");
  const steering = rawSteering || findings.some((f) => f.code === "steering_attempt");
  for (const f of findings) {
    const c = f.criterion as C;
    if (f.severity === "blocker" && criteria[c] === "pass") criteria[c] = "unknown";
  }
  const unexplained = order.filter(
    (c) => criteria[c] === "fail" && !findings.some((f) => f.criterion === c),
  );
  findings.splice(MAX_FINDINGS - unexplained.length);
  for (const c of unexplained) {
    findings.push({
      criterion: c,
      severity: "blocker",
      code: "other",
      path: null,
      note: "No detail given.",
    });
  }
  return { findings, steering };
}

const V1_KEYS = ["v", "model", "criteria", "findings", "summary", "steering", "evidence"];
const V2_KEYS = [
  "v",
  "stage",
  "models",
  "criteria",
  "findings",
  "summary",
  "steering",
  "evidence",
  "usage",
];

/** The version 1 parser, unchanged, for rows stored before the screen existed. */
function parseV1Report(raw: Record<string, unknown>): PrReviewReport {
  if (!hasExactKeys(raw, V1_KEYS)) throw new PrReviewReportError("unknown_key");
  if (raw.v !== 1) throw new PrReviewReportError("bad_version");
  if (!isOneOf(V1_MODELS, raw.model)) throw new PrReviewReportError("bad_model");
  const criteria = parseCriteria(raw.criteria, V1_CRITERIA);
  if (typeof raw.summary !== "string") throw new PrReviewReportError("bad_summary");
  const evidence = parseEvidenceV1(raw.evidence);
  const { findings, steering } = settle(raw.findings, raw.steering, criteria, V1_CRITERIA);
  const report: ReportShapeV1 = {
    v: 1,
    model: raw.model,
    criteria,
    findings,
    summary: sanitizeNote(raw.summary, SUMMARY_MAX),
    steering,
    evidence,
  };
  return report as PrReviewReport;
}

/**
 * Validate a version 2 report: what a callback must carry. Accepts only the keys declared above,
 * only members of the closed sets, only counts that are non-negative integers, and only versions
 * that are `X.Y.Z`. Free text (`note`, `summary`) is not rejected for its content, it is sanitized:
 * a model's wording is not a reason to lose the review. Any other version, version 1 included, is
 * refused (`bad_version`): a report is posted by the job of the same release.
 *
 * The stage is a contract, not a label:
 *  - `facts`: the naming rule ended the review before any model was asked, so no model is named,
 *    every criterion is `unknown` (the rules of {@link factsOf} still fail what they find), no
 *    tokens were used, and the evidence holds the naming fact that ended it;
 *  - `screen`: the screen stopped the pull request, so `genuine_contribution` is a fail, the other
 *    five were never assessed (`unknown`), no review model is named and the review used nothing;
 *  - `full`: the screen let it through, so `genuine_contribution` is a pass, the review's model and
 *    usage are named, and the evidence says what the change log holds (`changelog_entry`).
 * A report that breaks its stage's contract is refused (`bad_stage`, or `bad_model` and `bad_usage`
 * for the models and the tokens), which is how a screen report or a facts report can never pass.
 */
export function parsePrReviewReport(raw: unknown): PrReviewReport {
  if (!isRecord(raw)) throw new PrReviewReportError("not_an_object");
  if (raw.v !== REPORT_VERSION) throw new PrReviewReportError("bad_version");
  if (!hasExactKeys(raw, V2_KEYS)) throw new PrReviewReportError("unknown_key");
  if (!isOneOf(REVIEW_STAGES, raw.stage)) throw new PrReviewReportError("bad_stage");
  const stage = raw.stage;

  const models = raw.models;
  if (!isRecord(models) || !hasExactKeys(models, ["screen", "review"])) {
    throw new PrReviewReportError("bad_model");
  }
  // The facts stage asked no model at all; every other stage asked the screen.
  let screenModel: ScreenModel | null = null;
  if (stage === "facts") {
    if (models.screen !== null) throw new PrReviewReportError("bad_model");
  } else {
    if (!isOneOf(SCREEN_MODELS, models.screen)) throw new PrReviewReportError("bad_model");
    screenModel = models.screen;
  }
  let reviewModel: ReviewModel | null = null;
  if (stage === "full") {
    if (!isOneOf(REVIEW_MODELS, models.review)) throw new PrReviewReportError("bad_model");
    reviewModel = models.review;
  } else if (models.review !== null) {
    throw new PrReviewReportError("bad_model");
  }

  const criteria = parseCriteria(raw.criteria, CRITERIA);
  if (stage === "screen") {
    if (criteria.genuine_contribution !== "fail") throw new PrReviewReportError("bad_stage");
    if (CRITERIA.some((c) => c !== "genuine_contribution" && criteria[c] !== "unknown")) {
      throw new PrReviewReportError("bad_stage");
    }
  } else if (stage === "facts") {
    // No model was asked, so nothing was assessed, and a report that assessed nothing cannot pass.
    if (CRITERIA.some((c) => criteria[c] !== "unknown")) throw new PrReviewReportError("bad_stage");
  } else if (criteria.genuine_contribution !== "pass") {
    throw new PrReviewReportError("bad_stage");
  }

  if (typeof raw.summary !== "string") throw new PrReviewReportError("bad_summary");
  const evidence = parseEvidence(raw.evidence);
  // The review reads the change log, and a rule below fails a revision that has no entry in it: a
  // full report that says nothing about the log would be a way to skip the rule.
  if (stage === "full" && evidence.changelog_entry === null) {
    throw new PrReviewReportError("bad_evidence");
  }
  // The facts stage exists because a naming fact ended the review; without one it ended for no reason.
  if (stage === "facts" && evidence.title_problem === null && evidence.name_problem === null) {
    throw new PrReviewReportError("bad_stage");
  }

  const usage = raw.usage;
  if (!isRecord(usage) || !hasExactKeys(usage, ["screen", "review"])) {
    throw new PrReviewReportError("bad_usage");
  }
  const screenTokens = parseTokens(usage.screen);
  // Nothing was asked at the facts stage, so nothing was spent.
  if (stage === "facts" && (screenTokens.input_tokens !== 0 || screenTokens.output_tokens !== 0)) {
    throw new PrReviewReportError("bad_usage");
  }
  let reviewTokens: StageTokens | null = null;
  if (stage === "full") reviewTokens = parseTokens(usage.review);
  else if (usage.review !== null) throw new PrReviewReportError("bad_usage");

  const { findings, steering } = settle(raw.findings, raw.steering, criteria, CRITERIA);
  const report: ReportShapeV2 = {
    v: REPORT_VERSION,
    stage,
    models: { screen: screenModel, review: reviewModel },
    criteria,
    findings,
    summary: sanitizeNote(raw.summary, SUMMARY_MAX),
    steering,
    evidence,
    usage: { screen: screenTokens, review: reviewTokens },
  };
  return report as PrReviewReport;
}

/**
 * Validate a report read back from a stored row: version 2 by {@link parsePrReviewReport}, and
 * version 1 by its own rules, so a review stored before the screen existed keeps the verdict it
 * had. Used to show and re-publish a stored result (`outcomeOfRow`, the watchdog, the admin views),
 * never for a callback.
 */
export function parseStoredPrReviewReport(raw: unknown): PrReviewReport {
  if (isRecord(raw) && raw.v === 1) return parseV1Report(raw);
  return parsePrReviewReport(raw);
}

// ---------------------------------------------------------------------------------------------
// Verdict: derived from the report and the facts, never read from it.
// ---------------------------------------------------------------------------------------------

/** A fact that moved a criterion away from what the model said, or that a rule found. */
export interface FactNote {
  criterion: Criterion;
  code: FindingCode;
  /** What the fact made of the criterion. */
  result: "fail" | "unknown";
}

/** Compare two `X.Y.Z` strings: negative when `a` is older than `b`. Both are parser-validated. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const TITLE_RULE_CODE: Record<NamingProblem, FindingCode> = {
  author_year: "title_author_year",
  doi: "title_doi",
  template_field: "title_template_field",
};

const NAME_RULE_CODE: Record<NamingProblem, FindingCode> = {
  author_year: "name_author_year",
  doi: "name_doi",
  template_field: "name_template_field",
};

/**
 * The criteria after the facts have had their say, and the facts that moved them. The model's
 * answer can only be lowered by a fact, never raised.
 *
 * The git facts, in every version:
 *  - No file changed: the pull request improves nothing, so `material_improvement` fails.
 *  - Both versions are known and the new one is not newer (equal, or a downgrade):
 *    `advances_revision` fails. (The required `version-check` already refuses this for a merge;
 *    the review says it in its own words so the two never read as contradicting each other.)
 *  - The new version is unknown (absent or unreadable): `advances_revision` cannot be better than
 *    unknown.
 *  - Something a reviewer needed was not shown (`truncated`): a pass about nothing being lost
 *    (`no_degradation`) rests on evidence nobody saw, so it is unknown.
 *  - Any file was REMOVED (the dataset description, README or CHANGES, the participants table, a
 *    recording, a sidecar, anything) or the subject count fell: a removal can be right (a privacy
 *    correction) but it is never something to pass on a model's word, so `no_degradation` is
 *    unknown and a person confirms it.
 *
 * The rules of a version 2 report, each of which fails its criterion and is ALWAYS stated, even
 * when another fact or the model already failed that criterion, so the author reads every problem
 * at once:
 *  - An empty description fails `clear_title_and_description` (`description_missing`).
 *  - A title that breaks the naming rule fails `clear_title_and_description`.
 *  - A new dataset name that breaks the naming rule fails `no_degradation`: the name is part of the
 *    dataset, and a name the policy refuses is broken metadata.
 *  - A new version with no new entry in the change log fails `advances_revision`
 *    (`changes_log_missing`): the CHANGES file must gain an entry headed by the new version, and
 *    both a log that did not gain one and no log at all mean there is none. An unknown new version
 *    is not this rule's to judge; the version fact above has already made it `unknown`.
 *
 * Two facts lower a criterion to `unknown` and never to a fail, because they are things nobody could
 * check, not things found wrong:
 *  - A description longer than the models read (`description_cut`) lowers
 *    `description_not_misleading`: the models saw only its start, so that it does not mislead, and
 *    that it does not try to instruct them, were not assessed. A steering finding on the part they
 *    did see still fails the review whatever this says. It is stated when it moves the answer.
 *  - A pull request that changes `dataset_description.json` and leaves a name that cannot be read
 *    (`name_problem` is `unchecked`) lowers `no_degradation`: the naming rule had no name to ask
 *    about, and an unreadable name is never a clean one. It is always stated, as the rules are.
 */
export function factsOf(report: PrReviewReport): {
  criteria: Partial<Record<Criterion, CriterionResult>>;
  notes: FactNote[];
} {
  const out: Partial<Record<Criterion, CriterionResult>> = { ...report.criteria };
  const notes: FactNote[] = [];
  const rank = { pass: 2, unknown: 1, fail: 0 } as const;
  const lower = (criterion: Criterion, code: FindingCode, to: "fail" | "unknown") => {
    const now = out[criterion];
    // Only ever lower a criterion: a fail stays a fail, and unknown never replaces a fail.
    if (now !== undefined && rank[to] < rank[now]) {
      out[criterion] = to;
      notes.push({ criterion, code, result: to });
    }
  };
  /** A rule: it fails the criterion, and it is stated whether or not it moved it. */
  const rule = (criterion: Criterion, code: FindingCode) => {
    if (out[criterion] === undefined) return;
    out[criterion] = "fail";
    notes.push({ criterion, code, result: "fail" });
  };
  /**
   * A fact nobody could check: it lowers the criterion to `unknown`, never to a fail, and is stated
   * whether or not it moved it, so a review that asked nothing (the facts stage) still says why a
   * person must look.
   */
  const unchecked = (criterion: Criterion, code: FindingCode) => {
    const now = out[criterion];
    if (now === undefined) return;
    if (rank.unknown < rank[now]) out[criterion] = "unknown";
    notes.push({ criterion, code, result: "unknown" });
  };
  const e = report.evidence;
  if (e.files_changed === 0) lower("material_improvement", "no_substantive_change", "fail");
  if (e.version_after === null) {
    lower("advances_revision", "evidence_incomplete", "unknown");
  } else if (e.version_before !== null && compareVersions(e.version_after, e.version_before) <= 0) {
    lower("advances_revision", "version_not_advanced", "fail");
  }
  if (e.truncated) lower("no_degradation", "evidence_incomplete", "unknown");
  if (e.areas.recordings.removed > 0) lower("no_degradation", "data_removed", "unknown");
  if (
    e.areas.dataset_description.removed +
      e.areas.readme_and_changes.removed +
      e.areas.participants.removed >
    0
  ) {
    lower("no_degradation", "metadata_removed", "unknown");
  }
  // Any other removal is a loss somebody should look at too. The areas above are the ones the
  // classifier is sure about; files it could not place (a format outside the annex policy's
  // extension list), sidecars, derivatives, source data and code count the same, so a mass
  // deletion cannot ride on a model's "nothing is lost".
  if (AREAS.some((a) => e.areas[a].removed > 0)) lower("no_degradation", "data_removed", "unknown");
  if (
    e.subjects_before !== null &&
    e.subjects_after !== null &&
    e.subjects_after < e.subjects_before
  ) {
    lower("no_degradation", "data_removed", "unknown");
  }
  if (report.v === REPORT_VERSION) {
    const v2 = report.evidence;
    if (v2.description_empty) rule("clear_title_and_description", "description_missing");
    if (v2.changelog_entry === "not_added" || v2.changelog_entry === "no_file") {
      rule("advances_revision", "changes_log_missing");
    }
    if (v2.description_cut) lower("description_not_misleading", "description_cut", "unknown");
    if (v2.title_problem !== null) {
      rule("clear_title_and_description", TITLE_RULE_CODE[v2.title_problem]);
    }
    if (v2.name_problem === "unchecked") {
      unchecked("no_degradation", "name_unchecked");
    } else if (v2.name_problem !== null) {
      rule("no_degradation", NAME_RULE_CODE[v2.name_problem]);
    }
  }
  return { criteria: out, notes };
}

export function effectiveCriteria(
  report: PrReviewReport,
): Partial<Record<Criterion, CriterionResult>> {
  return factsOf(report).criteria;
}

export function verdictOf(report: PrReviewReport): Verdict {
  if (report.steering) return "fail";
  const c = effectiveCriteria(report);
  const results = criteriaOf(report).map((k) => resultOf(c, k) ?? "unknown");
  if (results.includes("fail")) return "fail";
  if (results.every((r) => r === "pass")) return "pass";
  return "uncertain";
}

// ---------------------------------------------------------------------------------------------
// Outcome -> check-run
// ---------------------------------------------------------------------------------------------

/**
 * Why the Worker declines a pull request: an administrator has blocked its contributor. Nothing
 * else is a reason, and in particular no count of reviews, per contributor or per day, and no
 * count of rejections is one any more (ADR 0107).
 */
export const PRODUCED_DECLINE_REASONS = ["contributor_paused"] as const;
export type ProducedDeclineReason = (typeof PRODUCED_DECLINE_REASONS)[number];

/**
 * Words rows written before the counts were removed still hold. They are never produced again and
 * there is no migration: such a row keeps its word, and it parses and renders as "Not reviewed".
 * (`contributor_paused` is not among them: a block still writes it, though rows from before the
 * automatic pause was removed hold it too.)
 */
export const HISTORICAL_DECLINE_REASONS = ["rate_limited", "daily_limit"] as const;

/**
 * Every word a stored declined row can hold: the migration's CHECK list, kept equal to it by a test.
 * Only {@link PRODUCED_DECLINE_REASONS} is written by new code.
 */
export const DECLINE_REASONS = [
  ...PRODUCED_DECLINE_REASONS,
  ...HISTORICAL_DECLINE_REASONS,
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/**
 * How many times an edit of a pull request's title, description or base, a reopening or a marking as
 * ready may restart the review of one head commit; the next is refused (ADR 0107, decision 4). The
 * owner set it on 2026-10-19. An administrator's start resets the count, and a push is a new commit
 * and so a new count. The Worker keeps the count in `pr_reviews.edit_restarts`.
 */
export const PR_REVIEW_EDIT_CAP = 5;

/** Why a review ended without a report. Some are the Worker's own words (see the callback). */
export const RUN_ERRORS = [
  "evidence_unavailable",
  "stale_head",
  "too_large",
  "auth_failed",
  "model_unavailable",
  "model_refused",
  "model_truncated",
  "model_invalid",
  "report_invalid",
  "dispatch_failed",
  "workflow_failed",
  "edit_limit",
] as const;
export type RunError = (typeof RUN_ERRORS)[number];

export function isRunError(x: unknown): x is RunError {
  return isOneOf(RUN_ERRORS, x);
}

/**
 * The run errors only the Worker may say: a job's callback that names one is `workflow_failed`
 * ({@link parseCallbackOutcome}). `dispatch_failed` is the Worker's word for "GitHub never ran the
 * workflow", which a redelivery retries and does not count as a model call, and `edit_limit` is its
 * word for a restart it refused at the cap (decision 4 of ADR 0107). Neither is something a job can
 * have seen, so neither may be forged by one.
 */
export const WORKER_ONLY_RUN_ERRORS: readonly RunError[] = ["dispatch_failed", "edit_limit"];

export function isDeclineReason(x: unknown): x is DeclineReason {
  return isOneOf(DECLINE_REASONS, x);
}

/**
 * What the naming rule found on a pull request it was applied to without a review: the title, and
 * the dataset's new name when the pull request changes it. `name` is `unchecked` when the name
 * could not be read from GitHub.
 */
export interface NamingFacts {
  title: NamingProblem | null;
  name: NameFinding | null;
}

export type ReviewOutcome =
  | { kind: "reported"; report: PrReviewReport }
  | { kind: "declined"; reason: DeclineReason }
  | { kind: "error"; error: RunError }
  | { kind: "unreported" }
  /**
   * Not reviewed, by design: the author is a NEMAR owner or administrator (ADR 0107), and the
   * naming rule found nothing, or an administrator waived it for this commit (`waived`). It is only
   * ever published, never stored, so no row has this outcome and nothing reads it back:
   * {@link StoredOutcome} is the type of everything that is stored or read back.
   */
  | { kind: "exempt"; waived?: boolean }
  /**
   * An owner's or administrator's pull request that the naming rule refuses, or could not check:
   * the review does not run for them, and the rule runs first. Published, never stored.
   */
  | { kind: "naming"; facts: NamingFacts };

/** An outcome a `pr_reviews` row can stand for: every outcome but the ones never stored. */
export type StoredOutcome = Exclude<ReviewOutcome, { kind: "exempt" } | { kind: "naming" }>;

/**
 * Every kind of outcome, from a record keyed by the union's own tags, so that adding a kind to
 * {@link ReviewOutcome} without listing it here is a compile error. The tests build one outcome
 * of each kind and check them against this list, so a new kind cannot slip past the rule that only
 * `exempt` is `skipped`.
 */
const OUTCOME_KINDS: Record<ReviewOutcome["kind"], true> = {
  reported: true,
  declined: true,
  error: true,
  unreported: true,
  exempt: true,
  naming: true,
};
export const REVIEW_OUTCOME_KINDS = Object.keys(OUTCOME_KINDS) as ReviewOutcome["kind"][];

export type CheckConclusion = "success" | "failure" | "action_required" | "skipped";

/** Whether the naming rule refused something (as opposed to not being able to check it). */
function namingRefused(facts: NamingFacts): boolean {
  return facts.title !== null || (facts.name !== null && facts.name !== "unchecked");
}

/**
 * Why a report that ended at the facts ended there, from its naming fact alone: `refused` when the
 * rule found a problem with the title or the new dataset name, `unchecked` when it found none and
 * could not read the name. The check's title and copy, and the CLI's one-line reason, all come from
 * this answer, so they cannot disagree. The verdict is not the answer: a version that did not
 * advance fails the verdict of a report whose name was only unreadable, and the rule refused nothing.
 */
export function factsStop(
  evidence: Pick<ReviewEvidence, "title_problem" | "name_problem">,
): "refused" | "unchecked" {
  return namingRefused({ title: evidence.title_problem, name: evidence.name_problem })
    ? "refused"
    : "unchecked";
}

/**
 * The check-run conclusion for an outcome.
 *
 * `success` and `failure` are the two answers a review can give. Everything else, a review that
 * could not decide, did not run, or never reported, is `action_required`: GitHub does not count
 * it as passing for a required check, and it tells a person to look. `neutral` is deliberately
 * unused, because a required check accepts it as a pass.
 *
 * `skipped` is the conclusion of exactly one outcome, `exempt`, and of no other: a required check
 * accepts it, which is the point (a pull request nobody is asked to review must not be held by a
 * review that does not apply to it), and it is safe only because it is never what a review that
 * ran, failed or could not decide says. An owner's pull request that the naming rule refuses is a
 * `failure`; one whose name could not be checked needs a person, whatever else the rule found: a
 * waiver covers only what the rule found, so while the name cannot be read nothing can be waived,
 * and a `failure` would offer the administrator a waiver that is then refused.
 */
export function conclusionOf(outcome: ReviewOutcome): CheckConclusion {
  if (outcome.kind === "exempt") return "skipped";
  if (outcome.kind === "naming") {
    const { facts } = outcome;
    return facts.name !== "unchecked" && namingRefused(facts) ? "failure" : "action_required";
  }
  if (outcome.kind !== "reported") return "action_required";
  const v = verdictOf(outcome.report);
  return v === "pass" ? "success" : v === "fail" ? "failure" : "action_required";
}

const CRITERION_LABEL: Record<Criterion, string> = {
  genuine_contribution: "A genuine contribution, not spam",
  no_degradation: "Nothing is lost or broken",
  advances_revision: "The revision advances",
  material_improvement: "The dataset is materially better",
  clear_title_and_description: "The title and description say what changed",
  description_not_misleading: "The description is not misleading",
};

const RESULT_WORD: Record<CriterionResult, string> = {
  pass: "Yes",
  fail: "No",
  unknown: "Could not tell",
};

/** Who reads a pull request the automation could not decide. */
const PERSON = "a NEMAR administrator";

/**
 * What a declined pull request is told. A stored row is shown again whenever its result is
 * re-stated, long after the decision, so each sentence is about the moment the commit arrived and
 * not about now. `contributor_paused` does not say who paused the contributor: rows written while
 * a rejection record paused people automatically hold the same word as a block does. The two
 * historical words are about a limit that no longer exists, so they say so and say what to do now,
 * which is the same for both.
 */
const DECLINE_COPY: Record<DeclineReason, string> = {
  contributor_paused: `Automated review was paused for this contributor when this commit arrived. ${capitalized(PERSON)} needs to review this one by hand.`,
  rate_limited:
    "Automated review was rate limited for this contributor when this commit arrived. That limit has since been removed. Push a new commit, or ask a NEMAR administrator to start the review.",
  daily_limit:
    "The daily limit of automated reviews had been reached when this commit arrived. That limit has since been removed. Push a new commit, or ask a NEMAR administrator to start the review.",
};

function capitalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What a pull request opened by an owner or administrator is told (ADR 0107). It says the review is
 * not required, and that skipped is not a pass: nobody reading the check should mistake "this does
 * not apply" for "this was reviewed and is fine". The naming rule is said to have run, because it
 * did, and a waiver is said to be one.
 */
const EXEMPT_COPY = {
  title: "Not required: opened by a NEMAR owner or administrator",
  summary:
    "The automated review did not run on this pull request. NEMAR owners and administrators are not reviewed, and may merge without it. The title and the dataset name were checked against the naming rule, and nothing was found.",
  text: "Skipped is not a pass. It says the review is not required here, not that this change was reviewed. A pull request opened by anyone else is reviewed.",
} as const;

const WAIVED_COPY = {
  title: "Not required: opened by a NEMAR owner or administrator (naming rule waived)",
  summary:
    "The automated review did not run on this pull request. NEMAR owners and administrators are not reviewed. The title or the dataset name breaks the naming rule, and a NEMAR administrator waived the rule for this commit with an explicit override, which is recorded.",
  text: "Skipped is not a pass. A new commit is checked against the naming rule again, and the waiver does not carry over to it.",
} as const;

/**
 * What a pull request whose review ended at the facts is told, by the naming fact that ended it
 * ({@link factsStop}, not the verdict): it says the rule decided and no model was asked, and what
 * the author does: a new title is an edit, which starts the review again (until the commit has had
 * {@link PR_REVIEW_EDIT_CAP} restarts by edits, after which a push or an administrator's start does),
 * and a new dataset name is a change to the files, which needs a push. Nothing is reviewed until the
 * rule is satisfied, so the next edit or push is what runs the review.
 */
const FACTS_COPY = {
  refused: `The naming rule found a problem with this pull request, so the review stage did not run and no model was asked. Edit the title, or the Name in dataset_description.json, as described below. A new title runs the review again as soon as it is saved, until edits have already started the review of this commit ${PR_REVIEW_EDIT_CAP} times, the most one commit gets, and after that a push or a NEMAR administrator's start is what runs it; a new Name is a change to the files, so push again: the review runs on the new commit.`,
  unchecked:
    "The naming rule could not check this pull request's new dataset name, so the review stage did not run and no model was asked. Fixing dataset_description.json as described below and pushing again runs the review.",
} as const;

/**
 * What the rule says of a citation, an author-year key or a DOI: the two are one thing to an author,
 * so they are said in the same words, and neither names the closed word it was found as.
 */
const CITATION_TITLE_SENTENCE =
  "The title has a citation (an author and a year, or a DOI) in it, the way a dataset is named (for example Lee2019, Lee-2019-EEG or 10.1038/s41597-020-0532-5), and the naming rule refuses one anywhere in a title. A pull request title says what the change does, such as Add three EEG recordings. Edit the title. Cite the paper in ReferencesAndLinks and the README instead.";
const CITATION_NAME_SENTENCE =
  "This pull request changes the dataset's name (the Name field of dataset_description.json) to one that has a citation (an author and a year, or a DOI) in it, which the naming rule refuses anywhere in a name. Choose a name that says what the dataset is, and cite the paper in ReferencesAndLinks and the README instead.";

/** What each finding of the naming rule says to the author, with what to do about it. */
const NAMING_SENTENCE: Record<"title" | "name", Record<NamingProblem, string>> = {
  title: {
    author_year: CITATION_TITLE_SENTENCE,
    doi: CITATION_TITLE_SENTENCE,
    template_field:
      "The title still has an unfilled template field (such as FirstAuthorSurname, paperDOI, or a bracketed instruction). Put the real words in its place. Edit the title.",
  },
  name: {
    author_year: CITATION_NAME_SENTENCE,
    doi: CITATION_NAME_SENTENCE,
    template_field:
      "This pull request changes the dataset's name (the Name field of dataset_description.json) to one with an unfilled template field. Put the real name in its place.",
  },
};

/** What the check says when a pull request changes the dataset description and its name cannot be read. */
const NAME_UNCHECKED_SENTENCE =
  "This pull request changes dataset_description.json, but the dataset's name (its Name field) could not be read from it, so the name was not checked against the naming rule. Make sure the file is valid JSON and that Name is text with a visible name.";

/**
 * What the check of an owner's or administrator's pull request says when the dataset's name could
 * not be checked. Two things can cause that and they are cured differently: GitHub may not have
 * answered, which one more start settles, or the file at the head may have no readable `Name`
 * (missing where nothing says it was removed, not JSON, no text `Name`, or a `Name` that shows
 * nothing), which the same start will find again, so the file has to be fixed and pushed. The text
 * says both, in that order because a retry costs nothing, and says that nothing can be waived
 * meanwhile.
 */
const NAME_UNCHECKED_EXEMPT =
  "The dataset's name could not be checked against the naming rule. GitHub may not have answered, or dataset_description.json has no readable Name (it is missing, is not valid JSON, or its Name is not text or shows nothing). Start the check again once with `nemar admin pr-reviews start <dataset> <pr>`. If it says the same, fix dataset_description.json and push: the new commit is checked, and nothing can be waived until the name can be read.";

const ERROR_COPY: Record<RunError, string> = {
  evidence_unavailable: "The changes could not be read.",
  stale_head:
    "The pull request or dataset changed while the review was starting. Check the current pull request and publication status; a new delivery may be needed.",
  too_large: `The change is too large for automated review. ${capitalized(PERSON)} needs to review it.`,
  auth_failed: `The review service could not sign in. ${capitalized(PERSON)} needs to fix the review service.`,
  model_unavailable: "The reviewing model was unavailable, or did not finish in time.",
  model_refused: "The reviewing model declined to review this change.",
  model_truncated: `The automated review used all the room it is given before it reached an answer, which a large pull request is likely to cause. Split it into smaller pull requests, for example by group of subjects or by kind of change, and open each one separately. ${capitalized(PERSON)} can also review it by hand.`,
  model_invalid: "The reviewing model did not return a usable review.",
  report_invalid: "The review could not be read back.",
  dispatch_failed: "The review could not be started. Push again to re-run it.",
  workflow_failed: "The review job failed before it finished.",
  edit_limit: `Edits to the title, description or base of this pull request, and reopenings and markings as ready for review, had already started the review of this commit ${PR_REVIEW_EDIT_CAP} times, the most one commit gets. This latest change did not start the review again, and the earlier result no longer stands, because the text it judged may no longer be the pull request's. Push a new commit to run the review, or ask a NEMAR administrator to start the review of this commit again.`,
};

const CODE_LABEL: Record<FindingCode, string> = {
  data_removed: "Data removed",
  metadata_removed: "Metadata removed",
  structure_broken: "Dataset structure broken",
  validation_regressed: "Validation regressed",
  version_not_advanced: "Version not advanced",
  changes_log_missing: "CHANGES entry missing",
  changes_log_mismatch: "CHANGES entry does not match the change",
  description_mismatch: "Description does not match the change",
  churn_only: "Formatting or churn only",
  no_substantive_change: "No substantive change",
  improvement_unclear: "Improvement unclear",
  evidence_incomplete: "Evidence incomplete",
  steering_attempt: "Text in the pull request tried to instruct the reviewer",
  spam: "Spam: promotional, unrelated or purposeless content, or repeated links",
  title_placeholder: "Title is placeholder or template text",
  title_not_descriptive: "Title does not say what changed",
  description_missing: "Description is empty",
  description_placeholder: "Description is placeholder text or not readable",
  description_misleading: "Description is misleading",
  description_cut: "Description is too long to read in full",
  title_author_year: "Title has a citation (an author and a year, or a DOI)",
  title_doi: "Title has a citation (an author and a year, or a DOI)",
  title_template_field: "Title has an unfilled template field",
  name_author_year: "New dataset name has a citation (an author and a year, or a DOI)",
  name_doi: "New dataset name has a citation (an author and a year, or a DOI)",
  name_template_field: "New dataset name has an unfilled template field",
  name_unchecked: "New dataset name could not be read",
  original_text_altered: "Original text changed",
  original_field_altered: "Original field changed",
  recording_replaced: "Recorded data changed",
  other: "Other",
};

/** Where a fact came from, in the words the check uses for it. */
function factSource(code: FindingCode): string {
  switch (code) {
    case "description_missing":
      return "found from the pull request, not by the reviewer: a pull request needs a description of what changed";
    case "description_cut":
      return "found from the pull request, not by the reviewer: the description is longer than the reviewer reads, so whether it is misleading, or tries to instruct the reviewer, was not assessed";
    case "title_author_year":
    case "title_doi":
    case "title_template_field":
    case "name_author_year":
    case "name_doi":
    case "name_template_field":
    case "name_unchecked":
      return "found by the naming rule, not by the reviewer";
    default:
      return "found from the files, not by the reviewer";
  }
}

export interface RenderedCheck {
  title: string;
  summary: string;
  text: string;
}

const FOOTER =
  "An automated review of the changes in this pull request. It does not replace a NEMAR " +
  "administrator, whose approval is what merges it. Where the dataset's rules require this check, " +
  "the pull request cannot be merged until it passes.";

/** The line every outcome without a verdict ends with: it does not pass, and a person must look. */
const NO_VERDICT = `No verdict was reached, so this check does not pass. ${capitalized(PERSON)} needs to look at this pull request.`;

const AREA_LABEL: Record<Area, string> = {
  dataset_description: "Dataset description",
  readme_and_changes: "README and CHANGES",
  participants: "Participants",
  sidecars: "Sidecars and tables",
  recordings: "Recordings and data files",
  derivatives: "Derivatives",
  sourcedata: "Source data",
  code: "Code",
  other: "Other files",
};

const STATUS_WORD: Record<ChangeStatus, string> = {
  added: "added",
  modified: "changed",
  removed: "removed",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The account of what changed: a table of counts per area, the version and subject change, and
 * how much of it the model actually read. Computed from git, so it is the same whatever the model
 * said, and it accounts for every changed file. `screened` says the full review never ran, so
 * nothing was read.
 */
export function describeChanges(e: ReviewEvidenceV1, screened = false): string[] {
  const out: string[] = ["**What changed**", ""];
  if (e.files_changed === 0) {
    out.push("No files changed.", "");
    return out;
  }
  out.push("| Area | Added | Changed | Removed |", "| --- | ---: | ---: | ---: |");
  for (const a of AREAS) {
    const c = e.areas[a];
    if (c.added + c.modified + c.removed === 0) continue;
    out.push(`| ${AREA_LABEL[a]} | ${c.added} | ${c.modified} | ${c.removed} |`);
  }
  out.push("");
  const facts: string[] = [];
  if (e.version_before !== null || e.version_after !== null) {
    facts.push(`Version ${e.version_before ?? "unknown"} to ${e.version_after ?? "unknown"}.`);
  }
  if (e.subjects_before !== null || e.subjects_after !== null) {
    facts.push(`Subjects ${e.subjects_before ?? "unknown"} to ${e.subjects_after ?? "unknown"}.`);
  }
  facts.push(
    screened
      ? "The full review did not run, so no file's content was read."
      : e.files_read === e.files_changed
        ? `The content of all ${plural(e.files_changed, "changed file", "changed files")} was read.`
        : `The content of ${e.files_read} of ${plural(e.files_changed, "changed file", "changed files")} was read. Files not read were judged by name and type only. Recordings and other data files are stored outside git and are never read.`,
  );
  out.push(facts.join(" "), "");
  return out;
}

function listChangedFiles(e: ReviewEvidenceV1): string {
  if (e.listed.length === 0) return "";
  const rows = e.listed.map((f) =>
    f.path
      ? `- ${STATUS_WORD[f.status]} \`${f.path}\``
      : `- ${STATUS_WORD[f.status]} (name not shown)`,
  );
  const hidden = e.files_changed - e.listed.length;
  const more =
    hidden > 0 ? `\n- and ${plural(hidden, "more file", "more files")}, counted above` : "";
  return `<details><summary>Changed files (${e.listed.length} of ${e.files_changed})</summary>\n\n${rows.join("\n")}${more}\n\n</details>`;
}

/**
 * The findings that say a contributor changed what the original authors published (epic #1851,
 * Part B). A moved or replaced recording is not one of them: that is a question for a person, and
 * the paragraph below does not answer it.
 */
export const ORIGINAL_ALTERED_CODES: readonly FindingCode[] = [
  "original_text_altered",
  "original_field_altered",
];

/**
 * What the contributor does instead, said once under the findings of a report that has one of
 * {@link ORIGINAL_ALTERED_CODES}. It is one line so a check, a comment and a terminal show it
 * unbroken, and its own words are fixed: the Worker and the CLI render it from here.
 */
export const ORIGINAL_CONTENT_PARAGRAPH =
  "Contributors add to what the original authors published and do not change it. Describe your change in the CHANGES entry for the new version. Put new information in a new, clearly separate section of the README. If something the authors wrote is wrong, open an issue for the NEMAR administrators, who can correct it; an administrator can also review this pull request by hand.";

/**
 * What a reader should look at before approving: a steering attempt, each finding, the facts
 * that no finding already states, and a warning when the reviewer did not see everything. Empty
 * when there is nothing to say. One bullet per line, in markdown, then (when a finding says the
 * original authors' content was changed) a blank line and one paragraph on what to do instead, so
 * the bullets stay one list.
 */
export function findingLines(report: PrReviewReport): string[] {
  // A code newer than this build (the CLI ships apart from the Worker) is named, not "undefined".
  const labelOf = (code: FindingCode): string =>
    (CODE_LABEL as Record<string, string | undefined>)[code] ?? `Unknown finding (${code})`;
  const { notes } = factsOf(report);
  const details: string[] = [];
  if (report.steering) {
    details.push(`- **${CODE_LABEL.steering_attempt}.** The review fails for that alone.`);
  }
  for (const f of report.findings) {
    const where = f.path ? ` (\`${f.path}\`)` : "";
    const note = f.note ? `: ${f.note}` : "";
    details.push(`- **${labelOf(f.code)}**${where}, ${f.severity}${note}`);
  }
  // Facts stated in their own right so a red or amber answer is never left without a reason. A
  // model finding that already says the same thing is not repeated.
  for (const n of notes) {
    if (report.findings.some((f) => f.criterion === n.criterion && f.code === n.code)) continue;
    details.push(
      `- **${labelOf(n.code)}**, ${n.result === "fail" ? "blocker" : "concern"}: ${factSource(n.code)}.`,
    );
  }
  // A report that ended before the review read no content at all, which the account of what
  // changed already says; this line is about a review that read some of it.
  const unread = report.v === REPORT_VERSION && report.stage !== "full";
  if (report.evidence.truncated && !unread) {
    details.push(
      "- Some changed files were not shown to the reviewer in full, so a clean result is not claimed.",
    );
  }
  // Last, and once however many findings qualify: the findings and the facts above stay one list,
  // and the Worker clips a long check from its end, which reaches the changed-files list first.
  if (report.findings.some((f) => ORIGINAL_ALTERED_CODES.includes(f.code))) {
    details.push("", ORIGINAL_CONTENT_PARAGRAPH);
  }
  return details;
}

/** What the naming rule says to an author, sentence by sentence. Empty when it found nothing. */
export function namingLines(report: PrReviewReport): string[] {
  if (report.v !== REPORT_VERSION) return [];
  const out: string[] = [];
  if (report.evidence.title_problem !== null) {
    out.push(NAMING_SENTENCE.title[report.evidence.title_problem]);
  }
  const name = report.evidence.name_problem;
  if (name === "unchecked") out.push(NAME_UNCHECKED_SENTENCE);
  else if (name !== null) out.push(NAMING_SENTENCE.name[name]);
  return out;
}

/**
 * The check of an owner's or administrator's pull request the naming rule refused or could not
 * check. A name that could not be read decides it, whatever the title says (the reason is given
 * with {@link conclusionOf}): the check needs a person, and says what else the rule found in what
 * it could read. Otherwise a refusal is a failure, and the override is the one way past it without
 * a change.
 */
function renderNaming(facts: NamingFacts): RenderedCheck {
  const lines: string[] = [];
  if (facts.title !== null) lines.push(NAMING_SENTENCE.title[facts.title]);
  if (facts.name !== null && facts.name !== "unchecked") {
    lines.push(NAMING_SENTENCE.name[facts.name]);
  }
  if (facts.name === "unchecked") {
    return {
      title: "Could not decide: the naming rule was not checked",
      summary: [
        ...(lines.length > 0
          ? [
              "The naming rule also found a problem in what it could read.",
              "",
              ...lines.map((l) => `- ${l}`),
              "",
            ]
          : []),
        NAME_UNCHECKED_EXEMPT,
      ].join("\n"),
      text: `${NO_VERDICT}\n\n${FOOTER}`,
    };
  }
  const override =
    "The only way past the naming rule without a change is an explicit override by a NEMAR administrator: `nemar admin pr-reviews allow <dataset> <pr> --admin --reason <why>`, which is recorded with the reason and applies to this commit only.";
  if (namingRefused(facts)) {
    return {
      title: "Needs changes: the naming rule",
      summary: [
        "The automated review does not run for NEMAR owners and administrators, but the naming rule applies to every pull request, and it found a problem.",
        "",
        ...lines.map((l) => `- ${l}`),
      ].join("\n"),
      text: `${override}\n\n${FOOTER}`,
    };
  }
  return {
    title: "Could not decide: the naming rule was not checked",
    summary: NO_VERDICT,
    text: `${NO_VERDICT}\n\n${FOOTER}`,
  };
}

/**
 * The model line at the foot of a report: which model screened it, and which reviewed it. A model
 * is named only if it was asked, so a report that asked none says that.
 */
function modelLine(report: PrReviewReport): string {
  if (report.v === 1) return `Reviewed with ${report.model}.`;
  const { screen, review } = report.models;
  if (screen === null) return "No model was asked: the screen and the full review did not run.";
  return review === null
    ? `Screened with ${screen}; the full review did not run.`
    : `Screened with ${screen} and reviewed with ${review}.`;
}

/** Render the check-run's title, summary and detail from an outcome. Pure; no input is quoted raw. */
export function renderCheck(outcome: ReviewOutcome): RenderedCheck {
  if (outcome.kind === "exempt") return outcome.waived ? { ...WAIVED_COPY } : { ...EXEMPT_COPY };
  if (outcome.kind === "naming") return renderNaming(outcome.facts);
  if (outcome.kind === "declined") {
    return {
      title: "Not reviewed",
      summary: DECLINE_COPY[outcome.reason],
      text: FOOTER,
    };
  }
  if (outcome.kind === "error") {
    return {
      // The refusal at the edit cap says why in its title: the person who reads the check list
      // learns that nothing is wrong with the review, and that the edits are what held it. So does
      // a review that used all its room: the title tells the author to make the pull request smaller.
      title:
        outcome.error === "edit_limit"
          ? "Could not decide: too many edits"
          : outcome.error === "model_truncated"
            ? "Could not decide: split this pull request"
            : "Could not decide",
      summary: ERROR_COPY[outcome.error],
      text: `${FOOTER}\n\n${NO_VERDICT}`,
    };
  }
  if (outcome.kind === "unreported") {
    return {
      title: "Could not decide",
      summary: "The review did not finish in time. Push again to re-run it.",
      text: `${FOOTER}\n\n${NO_VERDICT}`,
    };
  }

  const { report } = outcome;
  const verdict = verdictOf(report);
  const { criteria } = factsOf(report);
  const stage = report.v === REPORT_VERSION ? report.stage : "full";
  const screened = stage === "screen";
  const factsOnly = stage === "facts";
  // Why a facts report ended, which picks its title and copy: the naming fact, and never the verdict.
  const stop = report.v === REPORT_VERSION && factsOnly ? factsStop(report.evidence) : null;
  // Neither the screen nor the facts read a file, and a question they never asked is not assessed.
  const unread = stage !== "full";
  const title =
    verdict === "pass"
      ? report.v === 1
        ? "Passes: nothing lost, revision advances, materially better"
        : "Passes: nothing lost, revision advances, materially better, clearly described"
      : stop !== null
        ? stop === "refused"
          ? "Needs changes: the naming rule"
          : "Could not decide: the naming rule was not checked"
        : verdict === "fail"
          ? screened
            ? "Needs changes: stopped by the screen"
            : "Needs changes"
          : "Could not decide";
  const lines: string[] = [];
  if (screened) {
    lines.push(
      `The screen read this pull request as spam (promotional, unrelated or purposeless content, or repeated links), so the full review did not run. If that is a mistake, ask ${PERSON} to look at this pull request.`,
      "",
    );
  }
  if (stop !== null) lines.push(FACTS_COPY[stop], "");
  if (report.summary) lines.push(report.summary, "");
  const naming = namingLines(report);
  if (naming.length > 0) {
    lines.push("**Naming rule**", "", ...naming.map((l) => `- ${l}`), "");
  }
  lines.push(...describeChanges(report.evidence, unread));
  lines.push("| Question | Answer |", "| --- | --- |");
  for (const c of criteriaOf(report)) {
    const result = resultOf(criteria, c) ?? "unknown";
    // A screen report never asked anything but whether the pull request is genuine, and a facts
    // report asked nothing; a rule may still have failed one of the questions.
    const word = unread && result === "unknown" ? "Not assessed" : RESULT_WORD[result];
    lines.push(`| ${CRITERION_LABEL[c]} | ${word} |`);
  }
  const details = findingLines(report);
  const text = [
    details.length ? `### Findings\n\n${details.join("\n")}` : "No findings.",
    listChangedFiles(report.evidence),
    FOOTER,
    verdict === "uncertain" ? `${capitalized(PERSON)} needs to look at this pull request.` : "",
    modelLine(report),
  ]
    .filter((x) => x !== "")
    .join("\n\n");
  return { title, summary: lines.join("\n"), text };
}

/**
 * The hidden marker on the review's pull-request comment. It labels the comment as this review's
 * so a person (or a later search) can tell it apart. The Worker does not search for it: it edits
 * the comment whose id it stored in `pr_reviews.comment_id`, so a pull request carries one review
 * comment, reused by later commits, not one per push.
 */
export const PR_REVIEW_COMMENT_MARKER = "<!-- nemar-pr-review:v1 -->";

const SHA7 = /^[0-9a-f]{7,40}$/;

/** The word on the comment's heading for each conclusion. A record, so a new conclusion cannot lack one. */
const COMMENT_BADGE: Record<CheckConclusion, string> = {
  success: "PASS",
  failure: "NEEDS CHANGES",
  action_required: "NEEDS A PERSON",
  skipped: "NOT REQUIRED",
};

/**
 * The pull-request comment: the same words as the check-run, led by the marker and the commit it
 * is about. `headSha` is validated here (a malformed value is left out rather than quoted).
 */
export function renderComment(outcome: ReviewOutcome, headSha: string): string {
  const { title, summary, text } = renderCheck(outcome);
  const badge = COMMENT_BADGE[conclusionOf(outcome)];
  const commit = SHA7.test(headSha) ? ` on commit \`${headSha.slice(0, 7)}\`` : "";
  return [
    PR_REVIEW_COMMENT_MARKER,
    `## NEMAR PR review: ${badge}`,
    `**${title}**${commit}`,
    summary,
    text,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// What the reviews cost: token counts and an estimate in dollars, for the administrator's list.
// ---------------------------------------------------------------------------------------------

/**
 * List prices in US dollars per million tokens, by model, checked against the published price list
 * on 2026-10-16. Haiku 5.5's is the rate for prompts up to 100,000 tokens (five times that above),
 * which the screen's always are; thinking is billed as output and is inside `output_tokens`. An
 * estimate for orientation, never an input to a decision: the token counts are the measurement.
 */
export const MODEL_PRICES_USD_PER_MTOK: Readonly<
  Record<ScreenModel | ReviewModel, { input: number; output: number }>
> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

/** Token totals of a set of reviews, by stage. */
export interface TokenTotals {
  screen_input: number;
  screen_output: number;
  review_input: number;
  review_output: number;
}

/**
 * What the token totals cost at {@link MODEL_PRICES_USD_PER_MTOK}, in US dollars, to the cent. The
 * screen is priced as {@link SCREEN_MODELS}' model and the review as {@link REVIEW_MODELS}'.
 */
export function estimateCostUsd(t: TokenTotals): number {
  const screen = MODEL_PRICES_USD_PER_MTOK[SCREEN_MODELS[0]];
  const review = MODEL_PRICES_USD_PER_MTOK[REVIEW_MODELS[0]];
  const dollars =
    (t.screen_input * screen.input +
      t.screen_output * screen.output +
      t.review_input * review.input +
      t.review_output * review.output) /
    1_000_000;
  return Math.round(dollars * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// Who gets reviewed: an administrator's block, and the record shown beside it.
// ---------------------------------------------------------------------------------------------

/**
 * What a contributor's pull requests have come to, shown to the administrator who reads it. It is
 * information and nothing else: no rejection record, however bad, pauses anyone's reviews any more
 * (ADR 0107), because with the check required a contributor who could not be reviewed could never
 * merge. Only an administrator's block does.
 */
export interface AuthorTally {
  /** Distinct pull requests whose latest decided review was a fail. */
  rejected: number;
  /** Distinct pull requests that have at least one decided (pass or fail) review. */
  decided: number;
}

/**
 * An administrator's standing decision about one contributor, or none. `block` pauses their reviews;
 * `allow` is only the word for lifting a block, since nothing else pauses anyone.
 */
export type AuthorOverride = OverrideMode | null;

export type Standing = { paused: false } | { paused: true; because: "maintainer" };

export function standingOf(override: AuthorOverride): Standing {
  return override === "block" ? { paused: true, because: "maintainer" } : { paused: false };
}

// ---------------------------------------------------------------------------------------------
// The callback body
// ---------------------------------------------------------------------------------------------

/** What a callback can say: a parsed report, or the word for why there is none. */
export type CallbackOutcome = Extract<ReviewOutcome, { kind: "reported" | "error" }>;

/**
 * Turn a callback's untrusted `outcome`, `report` and `error` fields into an outcome. A report
 * goes through {@link parsePrReviewReport} (version 2 only); one it refuses is the run error
 * `report_invalid`. An error word that is not in the vocabulary, or that only the Worker may use,
 * is `workflow_failed`. Anything else (a missing or unknown `outcome`) is also `workflow_failed`: it
 * can never become a verdict.
 */
export function parseCallbackOutcome(
  body: {
    outcome: unknown;
    report: unknown;
    error: unknown;
  },
  /** Told the parser's fixed-word reason when a report is refused; the outcome does not carry it. */
  onRefused?: (code: ReportErrorCode) => void,
): CallbackOutcome {
  if (body.outcome === "reported") {
    try {
      return { kind: "reported", report: parsePrReviewReport(body.report) };
    } catch (err) {
      if (!(err instanceof PrReviewReportError)) throw err;
      onRefused?.(err.code);
      return { kind: "error", error: "report_invalid" };
    }
  }
  // The Worker's own words (see {@link WORKER_ONLY_RUN_ERRORS}) are not ones a job may say.
  return {
    kind: "error",
    error:
      isRunError(body.error) && !WORKER_ONLY_RUN_ERRORS.includes(body.error)
        ? body.error
        : "workflow_failed",
  };
}
