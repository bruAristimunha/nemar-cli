/**
 * The identifier screen's report: one shape, written by the workflow that screens a dataset at
 * publication time, validated by the Worker before it stores a byte, and read back by the admin
 * email, the status views and the approval gate.
 *
 * **A report carries no value.** It holds closed-set kinds, counts, field names the scanner draws
 * from a closed set, and a few fixed words. The parser is the enforcement: it accepts only keys it
 * knows, only kinds in {@link FINDING_KINDS}, only numbers that are non-negative integers, and
 * only strings that match a narrow pattern, so a workflow that was changed to print a header's
 * text into its report is refused at the door rather than stored, mailed and shown. The parser
 * throws a fixed-word {@link ReportError}; it never quotes the input.
 *
 * **Unknown is never healthy** (ADR 0053). {@link screenGate} maps every state to what the
 * publication may do next, and a screen that did not run, did not finish or did not report is its
 * own state with its own answer, never "clean" and never "no findings".
 */

import {
  DATE_KINDS,
  DIRECTORY_FORMATS,
  type FindingKind,
  OTHER_RECORDING_EXTENSIONS,
} from "./identifier-scan";

export const REPORT_VERSION = 1;

/** Every finding kind. A `Record` over the union, so adding a kind to the scanner fails the build here. */
const KIND_TABLE: Record<FindingKind, true> = {
  "edf-unreadable": true,
  "edf-patient-nonascii": true,
  "edf-recording-nonascii": true,
  "path-subject-label": true,
  "edf-patient-name": true,
  "edf-patient-code": true,
  "edf-patient-recordnumber": true,
  "edf-patient-age": true,
  "edf-patient-freetext": true,
  "edf-patient-birthdate": true,
  "edf-recording-startdate": true,
  "edf-recording-freetext": true,
  "edf-recording-technician": true,
  "edf-startdate": true,
  "edf-startdate-unparsed": true,
  "participants-identifier-column": true,
  "json-identifier-key": true,
  "acq-time-dated": true,
  "image-or-document-file": true,
  "tooling-debris": true,
  "local-user-path": true,
};
export const FINDING_KINDS: readonly FindingKind[] = Object.keys(KIND_TABLE) as FindingKind[];
const KIND_SET: ReadonlySet<string> = new Set(FINDING_KINDS);

/** What the scanner concluded about a dataset. */
export const DATASET_STATUSES = [
  "direct-identifiers",
  "dates-only",
  "review",
  "clean",
  "clean-edf-only-others-unscreened",
  "not-screened",
  "no-recordings",
  "unchecked",
] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];

export type ManifestSource = "manifest.json" | "s3-version-manifest" | "git-tree" | "clone";
const MANIFEST_SOURCES: ReadonlySet<string> = new Set([
  "manifest.json",
  "s3-version-manifest",
  "git-tree",
  "clone",
]);

export interface SamplingStat {
  candidates: number;
  oversize: number;
  selected: number;
  scanned: number;
}

/** One dataset's scan: what the fleet scan writes per dataset and the publication screen sends. */
export interface DatasetRecord {
  id: string;
  version: string | null;
  scanned_at: string;
  status: DatasetStatus;
  incomplete: boolean;
  incomplete_reasons: string[];
  manifest_source?: ManifestSource;
  files?: { total: number; edf_bdf: number; header_read: number; header_read_failed: number };
  sampling?: Record<"edf_headers" | "scans_tables" | "json_files" | "text_files", SamplingStat>;
  read_failures?: Record<string, number>;
  edf_bdf_files_flagged?: number;
  distinct_patient_field_values?: number;
  distinct_subjects_with_edf_bdf?: number;
  distinct_patient_code_subfield?: number;
  distinct_patient_name_subfield?: number;
  distinct_patient_birth_subfield?: number;
  distinct_patient_field_values_in_flagged_files?: number;
  findings_by_kind?: Partial<Record<FindingKind, number>>;
  edf_bdf_files_by_kind?: Partial<Record<FindingKind, number>>;
  unscreened_formats?: Record<string, number>;
  side_reads_failed?: number;
  /** The fleet scan writes this; the publication report does not carry it (a pattern is not a vocabulary). */
  finding_fields?: string[];
}

/** Why a screen produced no scan. Fixed words; the first four are set by the Worker, the rest by the workflow. */
export const SCREEN_ERRORS = [
  "dispatch-unconfigured",
  "dispatch-failed",
  "no-report-in-time",
  "workflow-failed",
  "clone-failed",
  "credentials-missing",
  "deadline",
] as const;
export type ScreenError = (typeof SCREEN_ERRORS)[number];
const ERROR_SET: ReadonlySet<string> = new Set(SCREEN_ERRORS);

/** What the workflow posts. Exactly one of `scan` and `error`. */
export interface ScreenReport {
  version: typeof REPORT_VERSION;
  /**
   * `identifier-scan@<revision>` of the scanner that ran; null only on an error report, where
   * the workflow failed before (or without) knowing which scanner it had.
   */
  scanner: string | null;
  /** The commit of the dataset's `main` that was screened; null when the screen never got that far. */
  head: string | null;
  scan?: DatasetRecord;
  error?: ScreenError;
}

/** The state a publication request is in with respect to its screen. */
export type ScreenState = "pending" | DatasetStatus | "error" | "unreported";

export class ReportError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ReportError";
  }
}

function bad(code: string): never {
  throw new ReportError(code);
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isCount = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

function onlyKeys(x: Record<string, unknown>, allowed: readonly string[], code: string): void {
  for (const key of Object.keys(x)) if (!allowed.includes(key)) bad(code);
}

/** A map of closed words to counts. */
function countMap(x: unknown, accepts: (key: string) => boolean, max: number, code: string) {
  if (!isObject(x) || Object.keys(x).length > max) bad(code);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(x as Record<string, unknown>)) {
    if (!accepts(key) || !isCount(value)) bad(code);
    out[key] = value as number;
  }
  return out;
}

const FORMAT_KEY = /^(\.[a-z0-9]{1,12}(\.[a-z0-9]{1,12})?\/?|\(no extension\))$/;
/**
 * Why a scan fell short, as the scanner names it. A closed list, not a pattern: a pattern lets
 * a lowercase name through as a "reason" and into the admin mail.
 */
export const INCOMPLETE_REASONS = [
  "edf-headers-oversize",
  "edf-headers-sampled",
  "edf-headers-unread",
  "json-oversize",
  "json-sampled",
  "json-unread",
  "text-oversize",
  "text-sampled",
  "text-unread",
  "scans-unread",
  "participants-unread",
  "participants-truncated",
  "history-unread",
  "submodule-unread",
  "no-latest-version",
  "manifest-shape",
  "tree-truncated",
  "credentials-missing",
  "deadline",
] as const;
const REASON_SET: ReadonlySet<string> = new Set(INCOMPLETE_REASONS);

/** What a failed read was reading, and the fixed classes a failure can have. */
const READ_WHAT: ReadonlySet<string> = new Set([
  "edf",
  "participants",
  "scans",
  "json",
  "text",
  "internal",
]);
const READ_CLASS: ReadonlySet<string> = new Set([
  "timeout",
  "network",
  "deadline",
  "credentials-missing",
  "header-truncated",
  "json-parse",
  "no-body",
  "short-body",
  "unreadable-entry",
  "superseded-absent",
  "blob-missing",
  "blob-closed",
  "internal",
  // A thrown error that is not a read failure, named by its built-in class (lowercase).
  "error-error",
  "error-rangeerror",
  "error-typeerror",
  "error-syntaxerror",
  "error-referenceerror",
  "error-evalerror",
  "error-urierror",
  "error-aborterror",
  "error-timeouterror",
]);
const HTTP_CLASS = /^http-[1-5]\d\d$/;

/** Is this a `<what>/<class>` failure key from the closed vocabulary? */
export function isReadFailureKey(key: string): boolean {
  const slash = key.indexOf("/");
  if (slash < 0) return false;
  const what = key.slice(0, slash);
  const cls = key.slice(slash + 1);
  return READ_WHAT.has(what) && (READ_CLASS.has(cls) || HTTP_CLASS.test(cls));
}

const SCANNER = /^identifier-scan@[0-9a-f]{7,40}$/;
const HEAD = /^[0-9a-f]{40}$/;
const DATASET_ID = /^(nm|on|xx)\d{6}$/;
/**
 * A UTC timestamp, to the second, as `Date.prototype.toISOString` writes it. The only free-form
 * string a scan carries besides closed words, so it is a pattern and not a vocabulary. The
 * scanner's `finding_fields` (a matched column or key name, a header field) is not accepted at all:
 * {@link parseRecord} lists the keys it takes, and a name is exactly what a report must not hold.
 */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * A report may not claim a cleaner status than its own counts allow. The status is the
 * workflow's word, and the gate reads only the status, so a record that says `clean` while its
 * counts say 3 name findings, an unread header or an unparsed format would otherwise be
 * believed. This is a one-way check: it refuses a record that is too clean for its counts, and
 * does not re-derive the scanner's verdict (a review-severity hit of a direct kind is legitimate
 * and the counts cannot tell it apart from a direct one).
 */
function checkStatus(
  r: Pick<
    DatasetRecord,
    | "status"
    | "incomplete"
    | "incomplete_reasons"
    | "files"
    | "findings_by_kind"
    | "unscreened_formats"
    | "edf_bdf_files_flagged"
  >,
): void {
  const kinds = Object.keys(r.findings_by_kind ?? {}) as FindingKind[];
  const unscreened = Object.values(r.unscreened_formats ?? {}).reduce((a, b) => a + b, 0);
  const files = r.files;
  if (files) {
    const shortfall = files.header_read !== files.edf_bdf || r.incomplete_reasons.length > 0;
    if (r.incomplete !== shortfall) bad("scan-status");
  }
  const clear = r.status === "clean" || r.status === "dates-only" || r.status === "no-recordings";
  if (clear) {
    if (!files || r.incomplete || unscreened > 0 || (r.edf_bdf_files_flagged ?? 0) > 0) {
      bad("scan-status");
    }
    if (r.status === "no-recordings") {
      if (files.edf_bdf !== 0) bad("scan-status");
    } else if (files.edf_bdf === 0) {
      bad("scan-status");
    }
    if (r.status === "clean" && kinds.length > 0) bad("scan-status");
    if (r.status !== "clean" && !kinds.every((k) => DATE_KINDS.has(k))) bad("scan-status");
  }
  if (r.status === "unchecked" && !r.incomplete) bad("scan-status");
}

function parseRecord(x: unknown): DatasetRecord {
  if (!isObject(x)) return bad("scan-shape");
  onlyKeys(
    x,
    [
      "id",
      "version",
      "scanned_at",
      "status",
      "incomplete",
      "incomplete_reasons",
      "manifest_source",
      "files",
      "sampling",
      "read_failures",
      "edf_bdf_files_flagged",
      "distinct_patient_field_values",
      "distinct_subjects_with_edf_bdf",
      "distinct_patient_code_subfield",
      "distinct_patient_name_subfield",
      "distinct_patient_birth_subfield",
      "distinct_patient_field_values_in_flagged_files",
      "findings_by_kind",
      "edf_bdf_files_by_kind",
      "unscreened_formats",
      "side_reads_failed",
    ],
    "scan-key",
  );
  if (typeof x.id !== "string" || !DATASET_ID.test(x.id)) bad("scan-id");
  if (
    x.version !== null &&
    !(typeof x.version === "string" && /^v?\d+\.\d+\.\d+$/.test(x.version))
  ) {
    bad("scan-version");
  }
  const record = {
    id: x.id,
    version: x.version,
    ...parseScanBody(x),
  } as unknown as DatasetRecord;
  checkStatus(record);
  return record;
}

/**
 * Every field of a scan except the dataset's identity, validated. Shared by the publication
 * report and the uploader preflight, which is made before the dataset has an id. The caller has
 * already refused unknown keys.
 */
function parseScanBody(x: Record<string, unknown>): Record<string, unknown> {
  if (typeof x.scanned_at !== "string" || !ISO_TIME.test(x.scanned_at)) bad("scan-time");
  if (!(DATASET_STATUSES as readonly string[]).includes(x.status as string)) bad("scan-status");
  if (typeof x.incomplete !== "boolean") bad("scan-incomplete");
  if (
    !Array.isArray(x.incomplete_reasons) ||
    x.incomplete_reasons.length > 40 ||
    !x.incomplete_reasons.every((r) => typeof r === "string" && REASON_SET.has(r))
  ) {
    bad("scan-reasons");
  }
  const out: Record<string, unknown> = {
    scanned_at: x.scanned_at,
    status: x.status,
    incomplete: x.incomplete,
    incomplete_reasons: x.incomplete_reasons,
  };
  if (x.manifest_source !== undefined) {
    if (typeof x.manifest_source !== "string" || !MANIFEST_SOURCES.has(x.manifest_source)) {
      bad("scan-source");
    }
    out.manifest_source = x.manifest_source;
  }
  if (x.files !== undefined) {
    const f = x.files;
    if (!isObject(f)) bad("scan-files");
    const files = f as Record<string, unknown>;
    onlyKeys(files, ["total", "edf_bdf", "header_read", "header_read_failed"], "scan-files");
    for (const k of ["total", "edf_bdf", "header_read", "header_read_failed"]) {
      if (!isCount(files[k])) bad("scan-files");
    }
    out.files = files;
  }
  if (x.sampling !== undefined) {
    const s = x.sampling;
    if (!isObject(s)) bad("scan-sampling");
    const sampling = s as Record<string, unknown>;
    const names = ["edf_headers", "scans_tables", "json_files", "text_files"];
    onlyKeys(sampling, names, "scan-sampling");
    for (const name of names) {
      const stat = sampling[name];
      if (!isObject(stat)) bad("scan-sampling");
      const st = stat as Record<string, unknown>;
      onlyKeys(st, ["candidates", "oversize", "selected", "scanned"], "scan-sampling");
      for (const k of ["candidates", "oversize", "selected", "scanned"]) {
        if (!isCount(st[k])) bad("scan-sampling");
      }
    }
    out.sampling = sampling;
  }
  if (x.read_failures !== undefined) {
    out.read_failures = countMap(x.read_failures, isReadFailureKey, 60, "scan-failures");
  }
  for (const k of [
    "edf_bdf_files_flagged",
    "distinct_patient_field_values",
    "distinct_subjects_with_edf_bdf",
    "distinct_patient_code_subfield",
    "distinct_patient_name_subfield",
    "distinct_patient_birth_subfield",
    "distinct_patient_field_values_in_flagged_files",
    "side_reads_failed",
  ]) {
    if (x[k] !== undefined) {
      if (!isCount(x[k])) bad("scan-count");
      out[k] = x[k];
    }
  }
  for (const k of ["findings_by_kind", "edf_bdf_files_by_kind"]) {
    if (x[k] !== undefined) out[k] = countMap(x[k], (key) => KIND_SET.has(key), 40, "scan-kinds");
  }
  if (x.unscreened_formats !== undefined) {
    out.unscreened_formats = countMap(
      x.unscreened_formats,
      (k) => FORMAT_KEY.test(k),
      60,
      "scan-formats",
    );
  }
  return out;
}

/** Validate a report from the wire. Throws {@link ReportError} with a fixed word, never the input. */
export function parseScreenReport(x: unknown): ScreenReport {
  if (!isObject(x)) return bad("report-shape");
  onlyKeys(x, ["version", "scanner", "head", "scan", "error"], "report-key");
  if (x.version !== REPORT_VERSION) bad("report-version");
  if (x.scanner !== null && !(typeof x.scanner === "string" && SCANNER.test(x.scanner))) {
    bad("report-scanner");
  }
  if (x.head !== null && !(typeof x.head === "string" && HEAD.test(x.head))) bad("report-head");
  const hasScan = x.scan !== undefined;
  const hasError = x.error !== undefined;
  if (hasScan === hasError) bad("report-outcome");
  const report: ScreenReport = {
    version: REPORT_VERSION,
    scanner: x.scanner as string | null,
    head: x.head as string | null,
  };
  if (hasScan) {
    // A scan is a scan OF a commit: a report that claims findings about no commit cannot be
    // matched to the content it describes, so the approval gate could never tell it was stale.
    if (x.head === null) bad("report-head");
    if (x.scanner === null) bad("report-scanner");
    report.scan = parseRecord(x.scan);
  } else {
    if (typeof x.error !== "string" || !ERROR_SET.has(x.error)) bad("report-error");
    report.error = x.error as ScreenError;
  }
  return report;
}

/** The state a stored report puts a request in. */
export function stateOf(report: ScreenReport): ScreenState {
  return report.scan ? report.scan.status : "error";
}

/**
 * What a screen state allows the publication to do.
 *
 * - `clear`: nothing to act on; the request goes to the admin as it is.
 * - `blocks`: a direct identifier. The request is blocked; there is no acknowledgment, the data is
 *   fixed and the screen run again.
 * - `acknowledge`: the screen found something a person must look at, or could not look at
 *   everything. An admin may approve with a recorded reason.
 * - `rerun`: the screen did not produce a verdict (did not run, did not finish, did not report, or
 *   was never started for this request). Approval waits for a run that does.
 * - `wait`: a run is in flight.
 */
export type ScreenGate = "clear" | "blocks" | "acknowledge" | "rerun" | "wait";

export function screenGate(state: ScreenState | null): ScreenGate {
  switch (state) {
    case "clean":
    case "dates-only":
    case "no-recordings":
      return "clear";
    case "direct-identifiers":
      return "blocks";
    case "review":
    case "unchecked":
    case "not-screened":
    case "clean-edf-only-others-unscreened":
      return "acknowledge";
    case "pending":
      return "wait";
    default:
      // "error", "unreported" and null (a request that predates the screen). Unknown is not
      // healthy, so none of them is clear.
      return "rerun";
  }
}

/** Is this stored value a state at all? The column is TEXT, so a read must not trust it. */
export function isScreenState(x: unknown): x is ScreenState {
  return (
    x === "pending" ||
    x === "error" ||
    x === "unreported" ||
    (DATASET_STATUSES as readonly string[]).includes(x as string)
  );
}

export interface ScreenDescription {
  /** One line, safe for a subject line or a table cell. */
  headline: string;
  /** How loudly to say it. */
  tone: "ok" | "note" | "warn" | "stop";
  /** Counts and fixed words, one per line. Never a value. */
  lines: string[];
}

/**
 * Why a screen produced no scan, as a person reads it. Exported through {@link screenErrorText}
 * so the scheduled sweep's report (ADR 0088) states a cause in these words and no others.
 */
const ERROR_TEXT: Record<ScreenError, string> = {
  "dispatch-unconfigured":
    "the screen could not be started: the Worker had no GitHub credential or callback secret, or the dataset has no repository",
  "dispatch-failed": "GitHub refused to start the screen workflow",
  "no-report-in-time":
    "no report arrived from the screen workflow in time (it may never have started)",
  "workflow-failed": "the screen workflow failed before it produced a result",
  "clone-failed": "the screen workflow could not read the dataset repository",
  "credentials-missing":
    "the screen workflow had no storage credentials, so it could not read headers",
  deadline: "the screen workflow ran out of time before it finished reading",
};

/**
 * What each state is called, without the surface's prefix. The publication screen says
 * "Identifier screen: <verdict>" and the uploader preflight "Identifier preflight: <verdict>", so
 * one state reads the same everywhere it is shown. The scheduled sweep's report (ADR 0088) puts
 * the verdict alone beside a count.
 */
const VERDICTS: Record<ScreenState, { verdict: string; tone: ScreenDescription["tone"] }> = {
  pending: { verdict: "running", tone: "note" },
  clean: { verdict: "clean", tone: "ok" },
  "dates-only": { verdict: "clean (acquisition dates only)", tone: "ok" },
  "no-recordings": { verdict: "clean (no recordings)", tone: "ok" },
  review: { verdict: "needs review", tone: "warn" },
  "direct-identifiers": { verdict: "FOUND IDENTIFIERS", tone: "stop" },
  unchecked: { verdict: "INCOMPLETE", tone: "warn" },
  "not-screened": { verdict: "recordings NOT screened", tone: "warn" },
  "clean-edf-only-others-unscreened": {
    verdict: "EDF/BDF clean, other recordings NOT screened",
    tone: "warn",
  },
  error: { verdict: "DID NOT RUN", tone: "stop" },
  unreported: { verdict: "DID NOT REPORT", tone: "stop" },
};

/** The name of a state, without the `Identifier screen:` prefix. */
export function screenStateLabel(state: ScreenState): string {
  return VERDICTS[state].verdict;
}

/** The cause of a screen that produced no scan, as {@link describeScreen} states it. */
export function screenErrorText(error: ScreenError): string {
  return ERROR_TEXT[error];
}

/** Kinds and counts as every surface prints them: `edf-patient-name x12, edf-patient-birthdate x12`. */
export function kindsPhrase(byKind: Partial<Record<FindingKind, number>> | undefined): string {
  return Object.entries(byKind ?? {})
    .map(([k, n]) => `${k} x${n}`)
    .join(", ");
}

/** What the screen does not read, whatever it found. One sentence, shown by every surface. */
export const SCREEN_NOT_READ = "Not read: the contents of sidecars and tables in earlier commits.";

/**
 * How many findings of the acquisition-date kinds ({@link DATE_KINDS}) a scan's counts hold. A
 * count that is not a non-negative integer is ignored rather than added, so a record that never
 * went through the parser cannot turn the warning's number into text.
 */
export function dateFindingCount(byKind: Partial<Record<FindingKind, number>> | undefined): number {
  let total = 0;
  for (const [kind, n] of Object.entries(byKind ?? {})) {
    if (DATE_KINDS.has(kind as FindingKind) && isCount(n)) total += n;
  }
  return total;
}

/** The first words of the warning's first line, which a terminal uses to find the warning's lines. */
const DATE_WARNING_LEAD = "Warning: acquisition dates finer than year and month were found";

/**
 * The warning's sentences after the first, fixed words and no number. Together with the first
 * line they are THE wording of the acquisition-date warning (ADR 0090): the admin email, the
 * status views, the CLI's upload preflight and the terminal all show these lines and no others.
 */
const DATE_WARNING_FIXED_LINES: readonly string[] = [
  "NEMAR does not change them.",
  "A date can help identify a participant when it is combined with other information.",
  "Remove or coarsen any date that could identify someone before uploading or requesting publication.",
  "Administrators are told of these findings when publication is requested.",
];

/** What the warning needs to know about a scan. Every field is optional: a view may have lost some. */
export interface DateWarningInput {
  findings_by_kind?: Partial<Record<FindingKind, number>>;
  /** The verdict. `dates-only` IS the scanner saying a date was found, whatever the counts say. */
  status?: DatasetStatus;
  /** An incomplete scan read less than it could, so its count is a lower bound. */
  incomplete?: boolean;
}

/**
 * The acquisition-date warning for a scan, as lines; empty when the scan holds no date finding.
 *
 * Policy B (ADR 0090): a date finer than year and month stays a review-level finding. It never
 * gates and nothing rewrites it, so this changes no verdict and no acknowledgment, and it is
 * only words. They carry one number, the count of date findings, and never a date, a value, a
 * file name or a path. The count is "at least" when the scan was incomplete. A `dates-only`
 * verdict with no date counted (a report that did not read back, or counts that were lost) still
 * warns, with the count left out: the verdict alone says a date was found, and a warning that
 * went missing without a word is the failure this exists to prevent.
 *
 * The screen workflow's own log is public and prints no verdict by design, so it must not print
 * these lines; it posts a report and the Worker words it.
 */
export function dateWarningLines(scan: DateWarningInput | undefined): string[] {
  const n = dateFindingCount(scan?.findings_by_kind);
  let where = "in recording headers or scans tables";
  if (n > 0) {
    const size = `${scan?.incomplete === true ? "at least " : ""}${n} ${n === 1 ? "entry" : "entries"}`;
    where = `${where} (${size})`;
  } else if (scan?.status !== "dates-only") {
    return [];
  }
  return [`${DATE_WARNING_LEAD} ${where}.`, ...DATE_WARNING_FIXED_LINES];
}

/** Is this line one of the warning's? For a terminal that wants to set the warning apart. */
export function isDateWarningLine(line: string): boolean {
  return line.startsWith(DATE_WARNING_LEAD) || DATE_WARNING_FIXED_LINES.includes(line);
}

/**
 * The one line `nemar dataset upload` prints about the dates it set itself (ADR 0091), once they
 * are set: fixed words and the count, never a date, a value or a path. It is not a warning and asks
 * nothing; the warning above covers only the dates that stay.
 */
export function dateNormalizationLine(count: number): string {
  const headers = `${count} recording header${count === 1 ? "" : "s"}`;
  return `Acquisition dates in ${headers} were set to 1 January of their year.`;
}

/**
 * What a person is told when a publication request has been ACCEPTED, one sentence per line (ADR
 * 0090, amendment "what an accepted request is told"). The terminal and the route's
 * `request_notice` both come from here, and no other source file spells these sentences (a test
 * enforces it).
 *
 * It is neutral on purpose and takes no screen as input: the identifier screen runs after the
 * request is made and its verdict is bound to a commit, so a finding, a verdict, a count or the
 * acquisition-date warning shown at this moment could be stale or wrong by the time anyone acts on
 * it. The requester learns the outcome from `nemar dataset publish status` or from the mail, which
 * is where the date warning is shown too. The only variable part is the dataset id, which the
 * caller has just had accepted. A request refused up front gets its own refusal text and no notice.
 *
 * The mail sentence names only the mails the requester really gets: one when the identifier screen
 * blocks the request (`sendIdentifierScreenBlockedEmail`), one on approval and one on denial. A
 * clean screen mails the administrators and not the requester, so no line says the requester is
 * told when the checks complete.
 */
export function publicationRequestNotice(datasetId: string): string[] {
  return [
    "Your request was received.",
    "NEMAR is checking publication eligibility.",
    "If every check passes, an administrator is notified to approve it.",
    "You will be emailed if a check needs your attention, and when an administrator decides.",
    `Run 'nemar dataset publish status ${datasetId}' to see where it stands.`,
  ];
}

/** The counts of a scan as lines of fixed words, shared by the publication screen and the preflight. */
function scanLines(
  scan: Pick<
    DatasetRecord,
    | "files"
    | "findings_by_kind"
    | "edf_bdf_files_flagged"
    | "unscreened_formats"
    | "incomplete_reasons"
  >,
): string[] {
  const lines: string[] = [];
  if (scan.files) {
    const unreadable =
      scan.files.header_read_failed > 0 ? ` (${scan.files.header_read_failed} unreadable)` : "";
    lines.push(
      `Files: ${scan.files.total}; EDF/BDF headers read: ${scan.files.header_read} of ${scan.files.edf_bdf}${unreadable}.`,
    );
  }
  const kinds = kindsPhrase(scan.findings_by_kind);
  if (kinds) lines.push(`Findings by kind: ${kinds}.`);
  if (scan.edf_bdf_files_flagged) {
    lines.push(`EDF/BDF files with an identifier finding: ${scan.edf_bdf_files_flagged}.`);
  }
  const formats = Object.entries(scan.unscreened_formats ?? {});
  if (formats.length > 0) {
    lines.push(
      `Not screened (format x files): ${formats.map(([f, n]) => `${f} x${n}`).join(", ")}.`,
    );
  }
  if (scan.incomplete_reasons.length > 0) {
    lines.push(`Incomplete: ${scan.incomplete_reasons.join(", ")}.`);
  }
  return lines;
}

/**
 * The words that go in front of a person. One function for the admin email, the status view and
 * the CLI, so the three cannot disagree about what a state means.
 */
export function describeScreen(
  state: ScreenState | null,
  report: ScreenReport | null,
): ScreenDescription {
  if (state === null) {
    return {
      headline: "Identifier screen: NOT RUN for this request",
      tone: "stop",
      lines: ["This request predates the screen, or the screen was never started for it."],
    };
  }
  const base = VERDICTS[state];
  const lines: string[] = [];
  // The Worker stores an 'unreported' screen WITH the error report that says so
  // (`no-report-in-time`), so the cause is stated once, from the report, when
  // there is one; the state's own cause is only for a caller with no report.
  if (state === "unreported" && !report?.error) {
    lines.push(`Cause: ${ERROR_TEXT["no-report-in-time"]}.`);
  }
  if (report?.error) lines.push(`Cause: ${ERROR_TEXT[report.error]}.`);
  const scan = report?.scan;
  if (scan) {
    lines.push(...scanLines(scan));
    lines.push(...dateWarningLines(scan));
    lines.push(SCREEN_NOT_READ);
    lines.push(`Scanner ${report.scanner}; commit ${report.head?.slice(0, 12)}.`);
  } else if (state === "dates-only") {
    // The verdict reads back and its report does not: the warning does not depend on the report.
    lines.push(...dateWarningLines({ status: state }));
  }
  return { headline: `Identifier screen: ${base.verdict}`, tone: base.tone, lines };
}

// ---------------------------------------------------------------------------------------
// Folding a scan into the vocabulary
// ---------------------------------------------------------------------------------------

/** The bucket for a format whose name is not shaped like an extension. */
export const OTHER_FORMAT = ".other";
const MAX_FORMAT_KEYS = 60;

/**
 * `unscreened_formats` names formats by file extension, and an extension is whatever the file's
 * author typed (`.dat_backup`, a thirteen-letter suffix). The contract refuses a key that does
 * not look like an extension, which would turn a dataset with one odd file into a screen that
 * never reports. The count is the point, so such keys (and any beyond the contract's key limit)
 * are folded into `.other`: the dataset is still not clean, and no file name rides in a key.
 */
export function foldOddFormats<T extends { unscreened_formats?: Record<string, number> }>(
  record: T,
): T {
  const formats = record?.unscreened_formats;
  if (typeof formats !== "object" || formats === null) return record;
  const kept: Record<string, number> = {};
  let other = 0;
  for (const [key, count] of Object.entries(formats)) {
    if (FORMAT_KEY.test(key)) kept[key] = count;
    else other += count;
  }
  const ranked = Object.entries(kept).sort(([, a], [, b]) => b - a);
  const room = MAX_FORMAT_KEYS - 1;
  const folded: Record<string, number> = Object.fromEntries(ranked.slice(0, room));
  for (const [, count] of ranked.slice(room)) other += count;
  if (other > 0) folded[OTHER_FORMAT] = (folded[OTHER_FORMAT] ?? 0) + other;
  return { ...record, unscreened_formats: folded };
}

/** The class for a read failure whose name is not a fixed word. */
export const INTERNAL_FAILURE = "internal";
const MAX_FAILURE_KEYS = 60;

/**
 * `read_failures` keys are `<what>/<class>`. The fleet scan names the class of a failure that is
 * not a ReadFailure after the error (`error-RangeError`), which the contract refuses because it
 * allows lower case only. One unexpected throw in one sidecar (a JSON nested deep enough to
 * overflow the scanner's stack) must not turn into a scan that cannot be reported and drop the
 * findings from every header, so here the class is lowercased and anything still outside the
 * pattern becomes the fixed class `internal`. The failure stays counted, so the record is still
 * incomplete. The fleet scan's own output is unchanged.
 */
export function foldOddFailures<T extends { read_failures?: Record<string, number> }>(
  record: T,
): T {
  const failures = record?.read_failures;
  if (typeof failures !== "object" || failures === null) return record;
  const folded: Record<string, number> = {};
  const add = (key: string, count: number) => {
    folded[key] = (folded[key] ?? 0) + count;
  };
  for (const [key, count] of Object.entries(failures)) {
    const lower = key.toLowerCase();
    if (isReadFailureKey(lower)) {
      add(lower, count);
      continue;
    }
    const what = lower.slice(0, Math.max(0, lower.indexOf("/")));
    add(
      `${isReadFailureKey(`${what}/${INTERNAL_FAILURE}`) ? what : INTERNAL_FAILURE}/${INTERNAL_FAILURE}`,
      count,
    );
  }
  // Past the contract's key limit, the smallest classes share one key.
  const ranked = Object.entries(folded).sort(([, a], [, b]) => b - a);
  if (ranked.length > MAX_FAILURE_KEYS) {
    const kept: Record<string, number> = Object.fromEntries(ranked.slice(0, MAX_FAILURE_KEYS - 1));
    const key = `${INTERNAL_FAILURE}/${INTERNAL_FAILURE}`;
    for (const [, count] of ranked.slice(MAX_FAILURE_KEYS - 1))
      kept[key] = (kept[key] ?? 0) + count;
    return { ...record, read_failures: kept };
  }
  return { ...record, read_failures: folded };
}

// ---------------------------------------------------------------------------------------
// The uploader preflight (ADR 0087)
// ---------------------------------------------------------------------------------------

/**
 * `nemar dataset upload` runs the same scan on the uploader's machine before anything is sent,
 * and records the result with the deposit attestation. It is early feedback for the uploader and
 * is NEVER trusted: a modified client can send anything, so nothing gates on it, and the
 * publication screen above stays the check that holds (ADR 0086). It is parsed at the door like
 * the publication report, so what is stored is counts and fixed words only.
 */
export const PREFLIGHT_VERSION = 1;

/** A scan made before the dataset had an id: the scan fields that describe coverage and findings. */
export interface PreflightScan {
  scanned_at: string;
  status: DatasetStatus;
  incomplete: boolean;
  incomplete_reasons: string[];
  files: { total: number; edf_bdf: number; header_read: number; header_read_failed: number };
  findings_by_kind: Partial<Record<FindingKind, number>>;
  edf_bdf_files_flagged: number;
  unscreened_formats: Record<string, number>;
  read_failures: Record<string, number>;
}

/**
 * The format names a preflight may carry: the recording formats the scanner names itself, its
 * directory formats, the extensions BIDS gives data files, and `(no extension)`. `formatCoverage`
 * takes an extension from whatever a file is called, so `sourcedata/Smith.John` would yield
 * `.john`: a pattern cannot keep a name out, a closed list can. The preflight's output can land in
 * a public CI log, so anything else is folded into `.other` before it is printed or stored, and
 * the door refuses it.
 */
export const KNOWN_FORMATS: ReadonlySet<string> = new Set([
  ...OTHER_RECORDING_EXTENSIONS,
  ...DIRECTORY_FORMATS.map((format) => `${format}/`),
  // BIDS data and companion extensions not already in the scanner's list.
  ".eeg",
  ".vmrk",
  ".mef",
  ".kdf",
  ".mrk",
  ".elp",
  ".hsp",
  ".raw",
  ".mhd",
  ".tsv.gz",
  "(no extension)",
  OTHER_FORMAT,
]);

/** Fold every format name outside {@link KNOWN_FORMATS} into `.other`, keeping its count. */
export function foldUnknownFormats<T extends { unscreened_formats?: Record<string, number> }>(
  record: T,
): T {
  const formats = record?.unscreened_formats;
  if (typeof formats !== "object" || formats === null) return record;
  const folded: Record<string, number> = {};
  for (const [key, count] of Object.entries(formats)) {
    const name = KNOWN_FORMATS.has(key) ? key : OTHER_FORMAT;
    folded[name] = (folded[name] ?? 0) + count;
  }
  return { ...record, unscreened_formats: folded };
}

/** Every field is required: a count that is missing is not a count of zero. */
const PREFLIGHT_SCAN_KEYS = [
  "scanned_at",
  "status",
  "incomplete",
  "incomplete_reasons",
  "files",
  "findings_by_kind",
  "edf_bdf_files_flagged",
  "unscreened_formats",
  "read_failures",
] as const;

/** How the uploader acknowledged a verdict the gate does not clear. No free text, by design. */
export type AcknowledgedVia = "prompt" | "flag";

export interface UploaderPreflight {
  version: typeof PREFLIGHT_VERSION;
  /** `nemar-cli@<version>`: the client that ran the scanner. */
  scanner: string;
  scan: PreflightScan;
  /** Set exactly when {@link screenGate} says the verdict needs an acknowledgment; null otherwise. */
  acknowledged_via: AcknowledgedVia | null;
}

/** The verdicts an uploader may acknowledge and upload anyway: the gate's `acknowledge` set. */
export const PREFLIGHT_ACKNOWLEDGEABLE: readonly DatasetStatus[] = DATASET_STATUSES.filter(
  (s) => screenGate(s) === "acknowledge",
);

const PREFLIGHT_SCANNER = /^nemar-cli@\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9a-z.]{1,24})?$/;

/** Validate the scan half of a preflight. Throws {@link ReportError} with a fixed word. */
export function parsePreflightScan(x: unknown): PreflightScan {
  if (!isObject(x)) return bad("scan-shape");
  onlyKeys(x, PREFLIGHT_SCAN_KEYS, "scan-key");
  for (const key of PREFLIGHT_SCAN_KEYS) if (x[key] === undefined) bad("scan-missing");
  const scan = parseScanBody(x) as unknown as PreflightScan;
  // Narrower than the publication report's pattern: only names from the closed list.
  for (const key of Object.keys(scan.unscreened_formats)) {
    if (!KNOWN_FORMATS.has(key)) bad("scan-formats");
  }
  checkStatus(scan);
  return scan;
}

/**
 * Validate a preflight from the wire or from storage. Throws {@link ReportError} with a fixed
 * word, never the input. An acknowledgment is required exactly when the verdict needs one, so a
 * stored record cannot say "acknowledged" about a clean scan, or leave a review unacknowledged.
 */
export function parseUploaderPreflight(x: unknown): UploaderPreflight {
  if (!isObject(x)) return bad("preflight-shape");
  onlyKeys(x, ["version", "scanner", "scan", "acknowledged_via"], "preflight-key");
  if (x.version !== PREFLIGHT_VERSION) bad("preflight-version");
  if (typeof x.scanner !== "string" || !PREFLIGHT_SCANNER.test(x.scanner)) {
    bad("preflight-scanner");
  }
  const scan = parsePreflightScan(x.scan);
  const via = x.acknowledged_via;
  if (via !== null && via !== "prompt" && via !== "flag") bad("preflight-ack");
  if ((screenGate(scan.status) === "acknowledge") !== (via !== null)) bad("preflight-ack");
  return {
    version: PREFLIGHT_VERSION,
    scanner: x.scanner as string,
    scan,
    acknowledged_via: via as AcknowledgedVia | null,
  };
}

/** The words for a preflight: the publication screen's verdicts and count lines, under its own name. */
export function describePreflight(
  scan: PreflightScan,
  acknowledgedVia: AcknowledgedVia | null,
): ScreenDescription {
  const base = VERDICTS[scan.status];
  const lines = scanLines(scan);
  lines.push(...dateWarningLines(scan));
  if (acknowledgedVia === "prompt") lines.push("Acknowledged by the uploader at the prompt.");
  if (acknowledgedVia === "flag") {
    lines.push("Acknowledged by the uploader with --acknowledge-identifier-preflight.");
  }
  return { headline: `Identifier preflight: ${base.verdict}`, tone: base.tone, lines };
}
