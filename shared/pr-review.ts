/**
 * The dataset pull-request review's contract (ADR 0092): the report a review run posts, the
 * verdict derived from it, the check-run words shown to people, and the rule that stops
 * reviewing a contributor whose pull requests keep being rejected.
 *
 * One module, three readers. The workflow script builds a report with it, the Worker parses
 * what comes back with it before storing a byte, and the check-run is rendered from it, so
 * the check, the stored row and the tally cannot disagree about what a review said.
 *
 * **Every field of a pull request is attacker-controlled text**: title, body, commit messages,
 * file names, file contents. That text reaches a language model, and the model's output reaches
 * a public-facing check-run. Three rules keep the model from steering the outcome:
 *
 *  1. **The verdict is derived, never reported.** The model supplies a result per criterion and
 *     some findings. {@link verdictOf} decides pass, fail or uncertain from those and from
 *     facts the script computed from git, and no field of the report is "the verdict".
 *  2. **Facts override the model.** A criterion the git facts contradict cannot pass, whatever
 *     the model said ({@link factsOf}).
 *  3. **Free text is a note, never markup.** The one place a model's words reach a person,
 *     {@link sanitizeNote}, removes links, mentions, cross-references, HTML and emphasis, so a
 *     note cannot ping someone, link anywhere or hide the verdict.
 *
 * **Unknown is never green** (ADR 0053, ADR 0054, ADR 0086). Anything that is not a clear pass maps to a
 * conclusion that does not satisfy a required check: `neutral` and `skipped` DO satisfy one on
 * GitHub, which is why neither appears in {@link conclusionOf}.
 *
 * The parser throws a fixed-word {@link PrReviewReportError}; it never quotes its input.
 */

export const REPORT_VERSION = 1;

/** The check-run's name. Stable: a ruleset that requires the check names it. */
export const PR_REVIEW_CHECK_NAME = "NEMAR PR Review";

/** The models a report may name. A closed set, so a model change is a reviewed code change. */
export const REVIEW_MODELS = ["claude-haiku-5-5"] as const;
export type ReviewModel = (typeof REVIEW_MODELS)[number];

/** What a pull request to a dataset is asked to be: the three questions of the review. */
export const CRITERIA = ["no_degradation", "advances_revision", "material_improvement"] as const;
export type Criterion = (typeof CRITERIA)[number];

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
  /** Sanitised free text, at most {@link NOTE_MAX} characters. */
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
 * Facts the script computed from git. The model never writes this block, so the account of what
 * changed cannot be shaded by it: the counts come from the whole change list, and they must add
 * up to `files_changed` ({@link parsePrReviewReport} refuses a report where they do not).
 */
export interface ReviewEvidence {
  files_changed: number;
  /** How many changed files had their content (a diff) given to the model. The rest were judged by name and type. */
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

export interface ReportShape {
  v: typeof REPORT_VERSION;
  model: ReviewModel;
  criteria: Record<Criterion, CriterionResult>;
  findings: ReviewFinding[];
  summary: string;
  /** The model says the pull request tried to instruct it. Always fails the review. */
  steering: boolean;
  evidence: ReviewEvidence;
}

declare const validated: unique symbol;

/**
 * A report that {@link parsePrReviewReport} accepted. The brand makes that a fact of the type for
 * an object literal: one cannot be handed to {@link verdictOf}, {@link renderCheck} or a stored
 * {@link ReviewOutcome} without going through the parser, so the closed vocabulary and the
 * counts-must-add-up rule cannot be skipped by accident. It does NOT stop a cast, and it does
 * not stop a spread of a parsed report (`{ ...report, steering: false }` keeps the brand in its
 * type), and `Readonly` is shallow. The brand guards against forgetting to parse, not against
 * someone who means to bypass it; a test keeps `as PrReviewReport` out of every other file.
 */
export type PrReviewReport = Readonly<ReportShape> & { readonly [validated]: true };

// ---------------------------------------------------------------------------------------------
// Parsing: a closed vocabulary, enforced at the door.
// ---------------------------------------------------------------------------------------------

/** Fixed words a refused report is described with. Never a quotation of the input. */
export const REPORT_ERRORS = [
  "not_an_object",
  "unknown_key",
  "bad_version",
  "bad_model",
  "bad_criteria",
  "bad_findings",
  "bad_summary",
  "bad_steering",
  "bad_evidence",
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

/**
 * Free text from a model or a pull request, made safe to put in a check-run.
 *
 * Removes what could notify a person (`@name`, `GH-12`), cross-reference an issue (`#12`), link
 * somewhere (URLs, `[text](url)`, images, HTML entities that decode to `@` or `#`), inject markup
 * (HTML tags, emphasis, table pipes, backslash escapes), or hide itself (control, zero-width and
 * bidirectional-override characters). What is left is plain words, cut to `max` characters.
 *
 * The order matters, and it is the lesson of a real bug: deleting special characters AFTER finding
 * links rebuilt them (`ht@tp://x` became `http://x`). So the special characters go first, in a
 * loop until nothing changes (removing one can reveal another), and links are found LAST. The
 * replacement text contains none of the characters stripped, so the result is a fixed point:
 * `sanitizeNote(sanitizeNote(x))` equals `sanitizeNote(x)`, which a test pins.
 */
export function sanitizeNote(input: unknown, max: number = NOTE_MAX): string {
  if (typeof input !== "string") return "";
  // The loop below is quadratic on input like "![![![...", and a callback body may be 256 KB.
  // Only the start of a note is ever shown, so cut it before the work begins. The cut may split a
  // surrogate pair; \p{Cs} removes a lone half.
  const bounded = input.length > max * 8 ? input.slice(0, max * 8) : input;
  let s = bounded.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ");
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/&#?\w+;/g, " ")
      .replace(/[@#`*_~|\\<>[\]{}]/g, "")
      .replace(/\bGH-\d+/gi, "");
    if (s === before) break;
  }
  s = s
    .replace(/\b(?:https?|ftp|file|data|javascript):\/*\S*/gi, "(link removed)")
    .replace(/\bwww\.\S+/gi, "(link removed)")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(s);
  return chars.length > max
    ? `${chars
        .slice(0, max - 3)
        .join("")
        .trimEnd()}...`
    : s;
}

function parseFinding(raw: unknown): ReviewFinding {
  if (!isRecord(raw) || !hasExactKeys(raw, ["criterion", "severity", "code", "path", "note"])) {
    throw new PrReviewReportError("bad_findings");
  }
  const { criterion, severity, code, path, note } = raw;
  if (
    !isOneOf(CRITERIA, criterion) ||
    !isOneOf(SEVERITIES, severity) ||
    !isOneOf(FINDING_CODES, code)
  ) {
    throw new PrReviewReportError("bad_findings");
  }
  if (path !== null && typeof path !== "string") throw new PrReviewReportError("bad_findings");
  if (typeof note !== "string") throw new PrReviewReportError("bad_findings");
  return { criterion, severity, code, path: safePath(path), note: sanitizeNote(note) };
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

function parseEvidence(raw: unknown): ReviewEvidence {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "files_changed",
      "files_read",
      "truncated",
      "version_before",
      "version_after",
      "subjects_before",
      "subjects_after",
      "areas",
      "listed",
    ])
  ) {
    throw new PrReviewReportError("bad_evidence");
  }
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

/**
 * Validate a report. Accepts only the keys declared above, only members of the closed sets,
 * only counts that are non-negative integers, and only versions that are `X.Y.Z`. Free text
 * (`note`, `summary`) is not rejected for its content, it is sanitised: a model's wording is
 * not a reason to lose the review.
 *
 * A criterion that fails with no finding against it gets one added (`other`, "No detail given."),
 * so a red check always has something for a person to read. Room is made by dropping the model's
 * LAST findings (the prompt asks for most important first), never one of the added ones.
 */
export function parsePrReviewReport(raw: unknown): PrReviewReport {
  if (!isRecord(raw)) throw new PrReviewReportError("not_an_object");
  const keys = ["v", "model", "criteria", "findings", "summary", "steering", "evidence"];
  if (!hasExactKeys(raw, keys)) throw new PrReviewReportError("unknown_key");
  if (raw.v !== REPORT_VERSION) throw new PrReviewReportError("bad_version");
  if (!isOneOf(REVIEW_MODELS, raw.model)) throw new PrReviewReportError("bad_model");
  const rawCriteria = raw.criteria;
  if (!isRecord(rawCriteria) || !hasExactKeys(rawCriteria, CRITERIA)) {
    throw new PrReviewReportError("bad_criteria");
  }
  const criteria = {} as Record<Criterion, CriterionResult>;
  for (const c of CRITERIA) {
    const r = rawCriteria[c];
    if (!isOneOf(CRITERION_RESULTS, r)) throw new PrReviewReportError("bad_criteria");
    criteria[c] = r;
  }
  if (!Array.isArray(raw.findings) || raw.findings.length > MAX_FINDINGS) {
    throw new PrReviewReportError("bad_findings");
  }
  const findings = raw.findings.map(parseFinding);
  if (typeof raw.summary !== "string") throw new PrReviewReportError("bad_summary");
  if (typeof raw.steering !== "boolean") throw new PrReviewReportError("bad_steering");
  const evidence = parseEvidence(raw.evidence);

  // The report must agree with itself, because the verdict reads the flags and not the prose.
  // A finding that says the pull request tried to instruct the reviewer IS a steering attempt
  // whatever the flag says, and a criterion cannot pass while a blocker is filed against it.
  // Both coerce toward "needs a person"; neither can raise anything.
  const steering = raw.steering || findings.some((f) => f.code === "steering_attempt");
  for (const f of findings) {
    if (f.severity === "blocker" && criteria[f.criterion] === "pass") {
      criteria[f.criterion] = "unknown";
    }
  }

  const unexplained = CRITERIA.filter(
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

  const report: ReportShape = {
    v: REPORT_VERSION,
    model: raw.model,
    criteria,
    findings,
    summary: sanitizeNote(raw.summary, SUMMARY_MAX),
    steering,
    evidence,
  };
  return report as PrReviewReport;
}

// ---------------------------------------------------------------------------------------------
// Verdict: derived from the report and the git facts, never read from it.
// ---------------------------------------------------------------------------------------------

/** A fact found from the files that moved a criterion away from what the model said. */
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

/**
 * The criteria after the git facts have had their say, and the facts that moved them. The model's
 * answer can only be lowered by a fact, never raised.
 *
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
 */
export function factsOf(report: PrReviewReport): {
  criteria: Record<Criterion, CriterionResult>;
  notes: FactNote[];
} {
  const out = { ...report.criteria };
  const notes: FactNote[] = [];
  const lower = (criterion: Criterion, code: FindingCode, to: "fail" | "unknown") => {
    // Only ever lower a criterion: a fail stays a fail, and unknown never replaces a fail.
    const rank = { pass: 2, unknown: 1, fail: 0 } as const;
    if (rank[to] < rank[out[criterion]]) {
      out[criterion] = to;
      notes.push({ criterion, code, result: to });
    }
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
  return { criteria: out, notes };
}

export function effectiveCriteria(report: PrReviewReport): Record<Criterion, CriterionResult> {
  return factsOf(report).criteria;
}

export function verdictOf(report: PrReviewReport): Verdict {
  if (report.steering) return "fail";
  const c = effectiveCriteria(report);
  const results = CRITERIA.map((k) => c[k]);
  if (results.includes("fail")) return "fail";
  if (results.every((r) => r === "pass")) return "pass";
  return "uncertain";
}

// ---------------------------------------------------------------------------------------------
// Outcome -> check-run
// ---------------------------------------------------------------------------------------------

/** Why a pull request was not sent to the model. */
export const DECLINE_REASONS = ["contributor_paused", "rate_limited", "daily_limit"] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

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
] as const;
export type RunError = (typeof RUN_ERRORS)[number];

export function isRunError(x: unknown): x is RunError {
  return isOneOf(RUN_ERRORS, x);
}

export function isDeclineReason(x: unknown): x is DeclineReason {
  return isOneOf(DECLINE_REASONS, x);
}

export type ReviewOutcome =
  | { kind: "reported"; report: PrReviewReport }
  | { kind: "declined"; reason: DeclineReason }
  | { kind: "error"; error: RunError }
  | { kind: "unreported" };

export type CheckConclusion = "success" | "failure" | "action_required";

/**
 * The check-run conclusion for an outcome.
 *
 * `success` and `failure` are the two answers a review can give. Everything else, a review that
 * could not decide, did not run, or never reported, is `action_required`: GitHub does not count
 * it as passing for a required check, and it tells a person to look. `neutral` is deliberately
 * unused, because a required check accepts it as a pass.
 */
export function conclusionOf(outcome: ReviewOutcome): CheckConclusion {
  if (outcome.kind !== "reported") return "action_required";
  const v = verdictOf(outcome.report);
  return v === "pass" ? "success" : v === "fail" ? "failure" : "action_required";
}

const CRITERION_LABEL: Record<Criterion, string> = {
  no_degradation: "Nothing is lost or broken",
  advances_revision: "The revision advances",
  material_improvement: "The dataset is materially better",
};

const RESULT_WORD: Record<CriterionResult, string> = {
  pass: "Yes",
  fail: "No",
  unknown: "Could not tell",
};

const DECLINE_COPY: Record<DeclineReason, string> = {
  contributor_paused:
    "Automated review is paused for this contributor. A maintainer needs to review this one by hand.",
  rate_limited:
    "Automated review is rate limited for this contributor right now. Push again later, or ask a maintainer to review it by hand.",
  daily_limit:
    "The daily limit of automated reviews was reached. A maintainer needs to review this one by hand.",
};

const ERROR_COPY: Record<RunError, string> = {
  evidence_unavailable: "The changes could not be read.",
  stale_head:
    "The pull request or dataset changed while the review was starting. Check the current pull request and publication status; a new delivery may be needed.",
  too_large: "The change is too large for automated review. A maintainer needs to review it.",
  auth_failed:
    "The review service could not sign in. A maintainer needs to fix the review service.",
  model_unavailable: "The reviewing model was unavailable.",
  model_refused: "The reviewing model declined to review this change.",
  model_truncated: "The reviewing model ran out of room before it finished.",
  model_invalid: "The reviewing model did not return a usable review.",
  report_invalid: "The review could not be read back.",
  dispatch_failed: "The review could not be started. Push again to re-run it.",
  workflow_failed: "The review job failed before it finished.",
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
  other: "Other",
};

export interface RenderedCheck {
  title: string;
  summary: string;
  text: string;
}

const FOOTER =
  "An automated review of the changes in this pull request. It does not replace a maintainer, " +
  "and a maintainer's approval is what merges it.";

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
 * said, and it accounts for every changed file.
 */
export function describeChanges(e: ReviewEvidence): string[] {
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
    e.files_read === e.files_changed
      ? `The content of all ${plural(e.files_changed, "changed file", "changed files")} was read.`
      : `The content of ${e.files_read} of ${plural(e.files_changed, "changed file", "changed files")} was read. Files not read were judged by name and type only. Recordings and other data files are stored outside git and are never read.`,
  );
  out.push(facts.join(" "), "");
  return out;
}

function listChangedFiles(e: ReviewEvidence): string {
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
 * What a reader should look at before approving: a steering attempt, each finding, the facts found
 * from the files that no finding already states, and a warning when the reviewer did not see
 * everything. Empty when there is nothing to say. One bullet per line, in markdown.
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
  // Facts found from the files, stated in their own right so a red or amber answer is never left
  // without a reason. A model finding that already says the same thing is not repeated.
  for (const n of notes) {
    if (report.findings.some((f) => f.criterion === n.criterion && f.code === n.code)) continue;
    details.push(
      `- **${labelOf(n.code)}**, ${n.result === "fail" ? "blocker" : "concern"}: found from the files, not by the reviewer.`,
    );
  }
  if (report.evidence.truncated) {
    details.push(
      "- Some changed files were not shown to the reviewer in full, so a clean result is not claimed.",
    );
  }
  return details;
}

/** Render the check-run's title, summary and detail from an outcome. Pure; no input is quoted raw. */
export function renderCheck(outcome: ReviewOutcome): RenderedCheck {
  if (outcome.kind === "declined") {
    return {
      title: "Not reviewed",
      summary: DECLINE_COPY[outcome.reason],
      text: FOOTER,
    };
  }
  if (outcome.kind === "error") {
    return {
      title: "Could not decide",
      summary: ERROR_COPY[outcome.error],
      text: `${FOOTER}\n\nNo verdict was reached, so this check does not pass.`,
    };
  }
  if (outcome.kind === "unreported") {
    return {
      title: "Could not decide",
      summary: "The review did not finish in time. Push again to re-run it.",
      text: `${FOOTER}\n\nNo verdict was reached, so this check does not pass.`,
    };
  }

  const { report } = outcome;
  const verdict = verdictOf(report);
  const { criteria } = factsOf(report);
  const title =
    verdict === "pass"
      ? "Passes: nothing lost, revision advances, materially better"
      : verdict === "fail"
        ? "Needs changes"
        : "Could not decide";
  const lines: string[] = [];
  if (report.summary) lines.push(report.summary, "");
  lines.push(...describeChanges(report.evidence));
  lines.push("| Question | Answer |", "| --- | --- |");
  for (const c of CRITERIA) lines.push(`| ${CRITERION_LABEL[c]} | ${RESULT_WORD[criteria[c]]} |`);
  const details = findingLines(report);
  const text = [
    details.length ? `### Findings\n\n${details.join("\n")}` : "No findings.",
    listChangedFiles(report.evidence),
    FOOTER,
    `Reviewed with ${report.model}.`,
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

/**
 * The pull-request comment: the same words as the check-run, led by the marker and the commit it
 * is about. `headSha` is validated here (a malformed value is left out rather than quoted).
 */
export function renderComment(outcome: ReviewOutcome, headSha: string): string {
  const { title, summary, text } = renderCheck(outcome);
  const conclusion = conclusionOf(outcome);
  const badge =
    conclusion === "success"
      ? "PASS"
      : conclusion === "failure"
        ? "NEEDS CHANGES"
        : "NEEDS A PERSON";
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
// Who gets reviewed: the contributor tally and the rate caps.
// ---------------------------------------------------------------------------------------------

/**
 * Automated review is paused for a contributor once MORE THAN this many of their pull requests
 * were rejected AND those rejections are MORE THAN {@link REJECTION_PERCENT} percent of the pull
 * requests that got a decision. Both must hold, so the harder one to reach decides: a newcomer's
 * first failure never pauses anyone, and a prolific contributor with a few failures among hundreds
 * of accepted pull requests is not paused either.
 */
export const REJECTION_COUNT = 5;
export const REJECTION_PERCENT = 10;

export interface AuthorTally {
  /** Distinct pull requests whose latest decided review was a fail. */
  rejected: number;
  /** Distinct pull requests that have at least one decided (pass or fail) review. */
  decided: number;
}

/** A maintainer's standing decision about one contributor, or none. Wins over the tally in both directions. */
export type AuthorOverride = OverrideMode | null;

export type Standing = { paused: false } | { paused: true; because: "maintainer" | "tally" };

export function standingOf(tally: AuthorTally, override: AuthorOverride): Standing {
  if (override === "allow") return { paused: false };
  if (override === "block") return { paused: true, because: "maintainer" };
  // Integer arithmetic: rejected / decided > 10 / 100  <=>  rejected * 100 > decided * 10.
  if (
    tally.decided > 0 &&
    tally.rejected > REJECTION_COUNT &&
    tally.rejected * 100 > tally.decided * REJECTION_PERCENT
  ) {
    return { paused: true, because: "tally" };
  }
  return { paused: false };
}

/** GitHub's `author_association` values that mark someone with a standing relationship to the repository. */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Reviews one contributor may start per hour. Anyone GitHub does not mark as the repository's
 * owner, a member or a collaborator (a fork's author, or a past contributor) gets the small
 * allowance: any GitHub user can open a pull request on a public dataset, and each review costs
 * money.
 */
export const HOURLY_REVIEW_CAP = { trusted: 20, other: 3 } as const;

/** Reviews one contributor may start per day, so a few accounts cannot drain the platform's pool. */
export const DAILY_AUTHOR_CAP = { trusted: 100, other: 6 } as const;

/** Reviews the whole platform starts per day, a ceiling on spend whatever else is true. */
export const DAILY_REVIEW_CAP = 400;

export function hourlyCapFor(authorAssociation: string | null | undefined): number {
  return authorAssociation && TRUSTED_ASSOCIATIONS.has(authorAssociation)
    ? HOURLY_REVIEW_CAP.trusted
    : HOURLY_REVIEW_CAP.other;
}

export function dailyAuthorCapFor(authorAssociation: string | null | undefined): number {
  return authorAssociation && TRUSTED_ASSOCIATIONS.has(authorAssociation)
    ? DAILY_AUTHOR_CAP.trusted
    : DAILY_AUTHOR_CAP.other;
}

// ---------------------------------------------------------------------------------------------
// The callback body
// ---------------------------------------------------------------------------------------------

/** What a callback can say: a parsed report, or the word for why there is none. */
export type CallbackOutcome = Extract<ReviewOutcome, { kind: "reported" | "error" }>;

/**
 * Turn a callback's untrusted `outcome`, `report` and `error` fields into an outcome. A report
 * goes through {@link parsePrReviewReport}; one it refuses is the run error `report_invalid`. An
 * error word that is not in the vocabulary, or that only the Worker may use, is `workflow_failed`. Anything else (a missing or
 * unknown `outcome`) is also `workflow_failed`: it can never become a verdict.
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
  // `dispatch_failed` is the Worker's own word for "GitHub never ran the workflow" and is retried
  // on redelivery and refunded from the caps: a job must not be able to say it.
  return {
    kind: "error",
    error:
      isRunError(body.error) && body.error !== "dispatch_failed" ? body.error : "workflow_failed",
  };
}
