/**
 * Deterministic identifier screening for deposited datasets.
 *
 * The Data Contributor Terms require that a deposit carry no names, birth dates finer than
 * year, or record numbers, in file contents, vendor headers, file names or sidecars. This
 * module is the mechanical half of checking that: pure functions over bytes and strings, no
 * I/O, no dependencies, so the CLI preflight, the publication gate and a fleet sweep all ask
 * the same question.
 *
 * **A finding never carries a value.** It names the kind, a field name from a CLOSED set (a
 * header field, or the canonical spelling of a matched column or key; never an ancestor key,
 * a path or the text itself), and the SHAPE of what was there. `shapeOf` is the only way to
 * build a {@link Shape}: uppercase letters of any script become `A`, other letters `a`,
 * digits `9`, printable ASCII punctuation stays, and every other character (symbols, marks,
 * control characters) becomes `?`, so a report cannot repeat a participant's name.
 *
 * **Screening is a best effort and says what it did not read.** `formatCoverage` counts
 * recording data in formats this module cannot parse, including archives and any raw file under `sourcedata/` it does not recognize, so a caller can tell "nothing found"
 * from "nothing looked at"; a caller must not call a dataset clean while that count is
 * non-zero. Only the EDF/BDF identification fields are parsed here: the patient
 * identification, the recording identification and the start date and time of the 256-byte
 * header. Signal-header fields (transducer, prefilter), reserved bytes and EDF+ annotation
 * channels are not read.
 *
 * Policy owned here, not by a library (make-versus-take). A birth date is an identifier
 * unless it is year-only (1 January in any common layout; a token that can be read two ways is
 * year-only only if every reading is 1 January). A name, a record number and an age over 89 are
 * identifiers. An acquisition date is NOT an identifier on its own: it is reported at review
 * severity as a DATE kind and never blocks, because it names nobody unless something else
 * links the recording to a person.
 */

export type Severity = "identifier" | "review";

export type FindingKind =
  | "edf-unreadable"
  | "edf-patient-nonascii"
  | "edf-recording-nonascii"
  | "path-subject-label"
  | "edf-patient-name"
  | "edf-patient-code"
  | "edf-patient-recordnumber"
  | "edf-patient-age"
  | "edf-patient-freetext"
  | "edf-patient-birthdate"
  | "edf-recording-startdate"
  | "edf-recording-freetext"
  | "edf-recording-technician"
  | "edf-startdate"
  | "edf-startdate-unparsed"
  | "participants-identifier-column"
  | "json-identifier-key"
  | "acq-time-dated"
  | "image-or-document-file"
  | "tooling-debris"
  | "local-user-path";

/**
 * Finding kinds that name a person or a clinical record: what must not stay public. A finding
 * counts as direct only when its severity is also `identifier`, so a slot-bound free-text hit
 * emitted at review severity stays a review finding.
 */
export const DIRECT_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  "edf-patient-name",
  "edf-patient-code",
  "edf-patient-freetext",
  "edf-patient-birthdate",
  "edf-patient-nonascii",
  "edf-patient-age",
  "edf-recording-freetext",
  "json-identifier-key",
  "participants-identifier-column",
]);

/**
 * Acquisition dates. Policy (2026-10-04): a recording's start date alone is acceptable when
 * nothing links it to an identifiable person, so these are review findings and never gate.
 * Only a PARSED date belongs here; text in a date slot that is not a date is a different kind.
 */
export const DATE_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  "edf-startdate",
  "edf-recording-startdate",
  "acq-time-dated",
]);

/** The shape of some text: produced only by {@link shapeOf}, so a raw value cannot be assigned to it. */
export type Shape = string & { readonly __brand: "Shape" };

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** A header field, or the canonical spelling of a matched column or key. Never a value. */
  field: string;
  /** Letters, digits and length only; never the value. */
  shape: Shape;
}

/** Size of the fixed EDF/BDF header, which holds the identification fields this module reads. */
export const EDF_HEADER_BYTES = 256;

/** Tokens that mean "nothing was entered". Compared case-insensitively. */
const PLACEHOLDER_WORDS = new Set([
  "x",
  "x_x",
  "xx",
  "unknown",
  "anonymous",
  "anon",
  "n/a",
  "na",
  "none",
  "null",
  "default",
  "noname",
  "no_name",
  "patient",
  "subject",
  "participant",
  "-",
]);

/**
 * Words that describe a field, a group or a device, not a person. Compared
 * case-insensitively, per alphabetic part, so `right-handed` is neutral when both parts are.
 */
const NEUTRAL_WORDS = new Set([
  "m",
  "f",
  "male",
  "female",
  "sex",
  "age",
  "id",
  "name",
  "dob",
  "mrn",
  "ssn",
  "hand",
  "handed",
  "handedness",
  "right",
  "left",
  "ambidextrous",
  "sub",
  "subj",
  "session",
  "ses",
  "run",
  "task",
  "rest",
  "resting",
  "test",
  "pilot",
  "phantom",
  "study",
  "control",
  "healthy",
  "recording",
  "eeg",
  "emg",
  "meg",
  "ieeg",
  "birth",
  "birthdate",
  "date",
  "startdate",
  "weight",
  "height",
  "kg",
  "cm",
  "year",
  "years",
  "anonymized",
  "anonymised",
  "deidentified",
  "de",
  "identified",
  "unnamed",
  "nn",
  "hc",
  "pd",
  "ad",
  "mci",
  "and",
  "biosemi",
  "neuracle",
  "neuroscan",
  "brainvision",
  "brainproducts",
  "actichamp",
  "nihonkohden",
  "natus",
  "compumedics",
  "eego",
  "mitsar",
  "emotiv",
  "openbci",
  "gtec",
  "biopac",
  "bitbrain",
  "cognionics",
  "state",
  "eyes",
  "closed",
  "open",
  "recorder",
  "baseline",
  "calibration",
  "impedance",
  "cap",
  "amplifier",
  "reference",
  "ref",
  "online",
  "offline",
  "software",
  "system",
  "device",
  "lab",
  "laboratory",
  "clinic",
  "hospital",
  "unit",
  "centre",
  "center",
  "department",
  "dept",
  "university",
  "institute",
  "experiment",
  "trial",
  "block",
  "acquisition",
  "protocol",
  "montage",
  "channel",
  "channels",
  "sampling",
  "filter",
  "raw",
  "data",
  "file",
  "time",
  "start",
  "end",
  "day",
  "visit",
  "pre",
  "post",
  "stim",
  "stimulation",
  "sham",
  "active",
  "of",
  "the",
  "at",
  "in",
  "by",
  "with",
  "for",
  "to",
  "a",
  "an",
  "on",
  "or",
  "from",
]);

/**
 * What a patient code or name SLOT may hold without being a name: placeholders and bare group
 * labels. Slots take no other neutral vocabulary, because a short surname such as `Day` or `Open`
 * is the same word.
 */
const SLOT_PLACEHOLDERS = new Set([
  ...PLACEHOLDER_WORDS,
  "unnamed",
  "nn",
  "hc",
  "pd",
  "mci",
  "anonymized",
  "anonymised",
  "deidentified",
]);

/** Study-design words that are never a surname, so a code like `Control_01` or `Phantom` is a code. */
const GROUP_WORDS = new Set([
  "control",
  "healthy",
  "test",
  "pilot",
  "phantom",
  "study",
  "group",
  "cohort",
  "patient",
  "volunteer",
]);

/** `sub-01`, `S_01`, `subject12`, `P3`: a study code, not a person. */
const SUBJECT_LABEL = /^(sub|subj|subject|s|p|pt|participant)[-_ ]?\d+$/i;

/** Whole month names and the standard abbreviations, so `Marker` and `Julia` are not months. */
const MONTH_WORDS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const monthNumber = (word: string): number => MONTH_WORDS[word.toLowerCase()] ?? 0;

/**
 * The shape of some text: uppercase letters become `A`, other letters `a`, digits `9`,
 * printable ASCII punctuation and space stay, and EVERYTHING else (symbols, combining marks,
 * control characters) becomes `?`. Letters of any script are letters: an accented or CJK
 * name becomes a run of `a`, which says nothing but its length class. Runs of three or more
 * collapse to `x+`.
 */
export function shapeOf(text: string): Shape {
  let out = "";
  for (const ch of text) {
    if (/\p{Lu}/u.test(ch)) out += "A";
    else if (/\p{L}/u.test(ch)) out += "a";
    else if (/\p{N}/u.test(ch)) out += "9";
    else if (/^[ -~]$/.test(ch)) out += ch;
    else out += "?";
  }
  return out.replace(/(.)\1{2,}/g, "$1+") as Shape;
}

function isPlaceholder(token: string): boolean {
  return PLACEHOLDER_WORDS.has(token.toLowerCase());
}

/** True for a token that is a study code or placeholder, so not a name. */
function isCodeLike(token: string): boolean {
  return isPlaceholder(token) || SUBJECT_LABEL.test(token) || /^\d+$/.test(token);
}

function isNeutral(word: string): boolean {
  const lower = word.toLowerCase();
  return NEUTRAL_WORDS.has(lower) || PLACEHOLDER_WORDS.has(lower);
}

/** Anything that is not a letter, a digit, or a character a name may contain splits a token. */
const PART_SPLIT = /[^\p{L}\p{N}'._-]+/u;

/**
 * One delimiter-free part that could be a person's name. A part of letters (and `' . _ -`)
 * only is name-like unless every alphabetic piece is a neutral word, so a two-letter surname
 * is caught and `right-handed` is not. A part that mixes letters with digits (`john3`) is
 * name-like only when it holds an alphabetic run of four or more letters that is not a neutral
 * word, so a study code like `S_01` is not, and a short name fused to digits is a known miss.
 */
function isNameLikePart(part: string, strict: boolean): boolean {
  if (part === "" || isCodeLike(part)) return false;
  const exempt = strict
    ? (w: string) => SLOT_PLACEHOLDERS.has(w.toLowerCase()) || GROUP_WORDS.has(w.toLowerCase())
    : isNeutral;
  if (/^[\p{L}'._-]+$/u.test(part)) {
    const pieces = part.split(/['._-]+/).filter((p) => p !== "");
    return pieces.length > 0 && !pieces.every(exempt);
  }
  const runs = part.match(/\p{L}+/gu) ?? [];
  return runs.some((run) => run.length >= 4 && !exempt(run));
}

/** A whitespace token that could be a name, after splitting on delimiters such as `^ , / = :`. */
function isNameLike(token: string, strict = false): boolean {
  if (token === "" || isCodeLike(token)) return false;
  return token.split(PART_SPLIT).some((part) => isNameLikePart(part, strict));
}

function hasNonAscii(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if ((bytes[i] as number) >= 0x80) return true;
  return false;
}

/** A header field as text, one character per byte, NUL read as a space, not trimmed. */
function rawFieldText(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number;
    out += b === 0 ? " " : String.fromCharCode(b);
  }
  return out;
}

function fieldText(bytes: Uint8Array, start: number, end: number): string {
  return rawFieldText(bytes, start, end).trim();
}

/**
 * The raw identification text of an EDF/BDF header, for CALLERS THAT ONLY COUNT (for example
 * distinct values per dataset). It returns values: never log it, serialize it, or put it in a
 * finding. Offsets are the single source of truth for this module's own scan.
 */
export function edfIdentificationText(bytes: Uint8Array): {
  patient: string;
  recording: string;
  startdate: string;
} {
  return {
    patient: fieldText(bytes, 8, 88),
    recording: fieldText(bytes, 88, 168),
    startdate: fieldText(bytes, 168, 176),
  };
}

interface DateParts {
  day: number;
  month: number;
  year: number;
}

interface DateMatch {
  text: string;
  /** Where it starts in the text it was found in. */
  index: number;
  candidates: DateParts[];
}

const validDayMonth = (day: number, month: number) =>
  month >= 1 && month <= 12 && day >= 1 && day <= 31;

/** Year-only by convention: the date is 1 January under EVERY reading of the token. */
function isYearOnly(candidates: DateParts[]): boolean {
  return candidates.length > 0 && candidates.every((c) => c.day === 1 && c.month === 1);
}

/**
 * Every calendar date inside some text, in any common layout, with every reading of each.
 * Matches need no whitespace around them, only no neighboring digit or letter, so `dob=14.03.1993`,
 * `*14.03.1993`, `(14.03.1993)`, `14.03.1993.` and `14MAR1993` are all found. Layouts: day,
 * month name (3 to 9 letters, first three match) and year; ISO `1993-03-14`; numeric
 * `14.03.1993`, `14 03 1993` and `03/14/1993` (day-first and month-first both offered when
 * both are possible, because only the writer knows which it meant); and compact `19930314`
 * or `14031993`.
 */
function findDates(text: string): DateMatch[] {
  const out: DateMatch[] = [];
  const push = (m: RegExpMatchArray, candidates: DateParts[]) =>
    out.push({ text: m[0], index: m.index ?? 0, candidates });
  const named =
    /(?<![\p{L}\p{N}])(\d{1,2})[-./_ ]?([A-Za-z]{3,9})[-./_ ]?(\d{2,4})(?![\p{L}\p{N}])/gu;
  for (const m of text.matchAll(named)) {
    const month = monthNumber(m[2] as string);
    const day = Number(m[1]);
    if (validDayMonth(day, month)) push(m, [{ day, month, year: Number(m[3]) }]);
  }
  // A day, a word that is not an English month, and a year (`14.Okt.1993`, `14-Dez-1993`): a date in
  // another language. The month is unknown, so it can never be year-only.
  const localized =
    /(?<![\p{L}\p{N}])(\d{1,2})[-./_ ]?([A-Za-z]{3,9})[-./_ ]?((?:19|20)\d{2})(?![\p{L}\p{N}])/gu;
  for (const m of text.matchAll(localized)) {
    const day = Number(m[1]);
    if (monthNumber(m[2] as string) === 0 && day >= 1 && day <= 31) {
      push(m, [{ day, month: 0, year: Number(m[3]) }]);
    }
  }
  const iso = /(?<![\p{N}])(\d{4})[-./_](\d{1,2})[-./_](\d{1,2})(?![\p{N}])/gu;
  for (const m of text.matchAll(iso)) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validDayMonth(day, month)) push(m, [{ day, month, year }]);
  }
  // Numeric day-month-year. A space may separate the parts only when the year has four digits,
  // so `Subject 01 02 03` and `12 11 10` are not dates.
  const numeric = [
    /(?<![\p{N}])(\d{1,2})[-./_](\d{1,2})[-./_](\d{2,4})(?![\p{N}])/gu,
    /(?<![\p{N}])(\d{1,2}) (\d{1,2}) (\d{4})(?![\p{N}])/gu,
  ];
  for (const re of numeric) {
    for (const m of text.matchAll(re)) {
      const [a, b, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const candidates: DateParts[] = [];
      if (validDayMonth(a, b)) candidates.push({ day: a, month: b, year });
      if (validDayMonth(b, a)) candidates.push({ day: b, month: a, year });
      if (candidates.length > 0) push(m, candidates);
    }
  }
  const compact = /(?<![\p{N}])(\d{8})(?![\p{N}])/gu;
  for (const m of text.matchAll(compact)) {
    const digits = m[1] as string;
    const candidates: DateParts[] = [];
    const ymd = {
      year: Number(digits.slice(0, 4)),
      month: Number(digits.slice(4, 6)),
      day: Number(digits.slice(6)),
    };
    if (ymd.year >= 1900 && ymd.year <= 2100 && validDayMonth(ymd.day, ymd.month)) {
      candidates.push(ymd);
    }
    const dmy = {
      day: Number(digits.slice(0, 2)),
      month: Number(digits.slice(2, 4)),
      year: Number(digits.slice(4)),
    };
    if (dmy.year >= 1900 && dmy.year <= 2100 && validDayMonth(dmy.day, dmy.month)) {
      candidates.push(dmy);
    }
    if (candidates.length > 0) push(m, candidates);
  }
  // Year and month only (`1993-03`, `MAR-1993`): finer than year, so never year-only (day 0).
  const yearMonthIso = /(?<![\p{L}\p{N}_])(\d{4})[-./_](\d{1,2})(?![\p{N}])/gu;
  for (const m of text.matchAll(yearMonthIso)) {
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) push(m, [{ day: 0, month, year: Number(m[1]) }]);
  }
  // Month first, then year: `03/1993`, `03.1993`. A letter before the digits makes it a code (`S01-2012`).
  const monthYearNumeric = /(?<![\p{L}\p{N}])(\d{1,2})[-./_](\d{4})(?![\p{N}])/gu;
  for (const m of text.matchAll(monthYearNumeric)) {
    const [month, year] = [Number(m[1]), Number(m[2])];
    if (month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
      push(m, [{ day: 0, month, year }]);
    }
  }
  const monthYearName = /(?<![\p{L}\p{N}])([A-Za-z]{3,9})[-./_ ](\d{4})(?![\p{L}\p{N}])/gu;
  for (const m of text.matchAll(monthYearName)) {
    const month = monthNumber(m[1] as string);
    if (month > 0) push(m, [{ day: 0, month, year: Number(m[2]) }]);
  }
  // A match wholly inside a longer one is the same date seen twice; keep the longer.
  return out.filter(
    (d) =>
      !out.some(
        (o) =>
          o !== d &&
          o.text.length > d.text.length &&
          d.index >= o.index &&
          d.index + d.text.length <= o.index + o.text.length,
      ),
  );
}

/** The text with every date found in it replaced by a space, so month names are not read as names. */
function blankDates(text: string, dates: DateMatch[]): string {
  let out = text;
  for (const d of dates) out = out.replace(d.text, " ");
  return out;
}

/** Parse the EDF family's `dd.mm.yy` start date field. */
function parseHeaderStartDate(text: string): { day: number; month: number } | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(text);
  if (!m) return null;
  const [day, month] = [Number(m[1]), Number(m[2])];
  return validDayMonth(day, month) ? { day, month } : null;
}

/**
 * How the scanner reads the header start date (bytes 168..176): not a `dd.mm.yy` date at all, the
 * year-only 1 January, or a date finer than the year. The year is never read.
 */
function readHeaderStartDate(text: string): "unparsed" | "year-only" | "dated" {
  const start = parseHeaderStartDate(text);
  if (!start) return "unparsed";
  return start.day === 1 && start.month === 1 ? "year-only" : "dated";
}

/** The dates in a local recording identification, read the one way the scanner reads them. */
interface RecordingDateReading {
  parts: string[];
  /** The EDF+ form: the field starts with the keyword `Startdate`, in any letter case. */
  keyword: boolean;
  /** In the EDF+ form, the token after the keyword and where it starts in the field's text. */
  slot: { text: string; index: number } | undefined;
  dates: DateMatch[];
  /**
   * The acquisition date: in the EDF+ form the first date that is not year-only inside the slot;
   * in a free-text field the first that is not year-only, unless a birth word is present.
   */
  acquisition: DateMatch | undefined;
  /** Every other date that is not year-only and is not the acquisition date's slot: a birth date. */
  birth: DateMatch[];
}

function readRecordingDates(recording: string): RecordingDateReading {
  const parts = recording.split(/\s+/);
  const keyword = (parts[0] as string).toLowerCase() === "startdate";
  const dates = findDates(recording);
  const slotText = keyword ? parts[1] : undefined;
  const slot =
    slotText === undefined
      ? undefined
      : { text: slotText, index: recording.indexOf(slotText, (parts[0] as string).length) };
  const inSlot = (d: DateMatch) =>
    slot !== undefined && d.index >= slot.index && d.index < slot.index + slot.text.length;
  // A birth word anywhere in a free-text recording id makes every date in it a birth date: the
  // writer said what the field holds, and which date it means cannot be told from distance.
  const hasBirthWord =
    /\b(?:dob|d\.o\.b)\b|birth|\bborn|\bgeb|nacid|nacimiento|(?:^|\s)\*(?=\d)/iu.test(recording);
  let acquisition: DateMatch | undefined;
  const birth: DateMatch[] = [];
  for (const d of dates) {
    if (isYearOnly(d.candidates)) continue;
    // In the EDF+ form only the date in the slot after `Startdate` is an acquisition date;
    // a date anywhere else in the field is not the start date of anything.
    const isAcquisition = keyword ? inSlot(d) : !hasBirthWord;
    if (isAcquisition) acquisition ??= d;
    else birth.push(d);
  }
  return { parts, keyword, slot, dates, acquisition, birth };
}

/**
 * Where an EDF/BDF header holds the acquisition dates the scanner reports: the reading behind
 * `edf-startdate` and `edf-recording-startdate` in {@link scanEdfHeader}, with byte offsets, for
 * the one rule that rewrites them (`normalizeEdfDates`, ADR 0091). Null when the bytes are not an
 * EDF or BDF header. It returns positions, never text.
 */
export interface EdfAcquisitionDates {
  /** `edf-startdate`: bytes 168..176 hold a `dd.mm.yy` date that is not 1 January. */
  startdate: boolean;
  /**
   * `edf-recording-startdate`: the byte range of the date the scanner reports in the recording
   * field, and whether that date is the whole EDF+ slot after `Startdate`.
   */
  recording: { start: number; end: number; wholeSlot: boolean } | null;
}

export function edfAcquisitionDates(bytes: Uint8Array): EdfAcquisitionDates | null {
  if (!detectEdfFamily(bytes)) return null;
  const raw = rawFieldText(bytes, 88, 168);
  const recording = raw.trim();
  let found: EdfAcquisitionDates["recording"] = null;
  if (recording !== "" && !isPlaceholder(recording)) {
    const reading = readRecordingDates(recording);
    const d = reading.acquisition;
    if (d) {
      // The field's text is trimmed; one character is one byte, so the offset is the trim plus the index.
      const start = 88 + (raw.length - raw.trimStart().length) + d.index;
      // An EDF+ acquisition date lies inside the slot, so one as long as the slot is the slot.
      found = {
        start,
        end: start + d.text.length,
        wholeSlot: reading.slot !== undefined && reading.slot.text === d.text,
      };
    }
  }
  return {
    startdate: readHeaderStartDate(fieldText(bytes, 168, 176)) === "dated",
    recording: found,
  };
}

export function detectEdfFamily(bytes: Uint8Array): "edf" | "bdf" | null {
  if (bytes.length < EDF_HEADER_BYTES) return null;
  if (bytes[0] === 0xff && fieldText(bytes, 1, 8) === "BIOSEMI") return "bdf";
  if (fieldText(bytes, 0, 8) === "0") return "edf";
  return null;
}

/**
 * Screen the 256-byte header of an EDF, EDF+ or BDF file.
 *
 * An unreadable header is itself a finding (`edf-unreadable`, severity review) and never
 * an empty list: a caller that could not look must not read the result as clean.
 */
export function scanEdfHeader(bytes: Uint8Array): Finding[] {
  if (!detectEdfFamily(bytes)) {
    return [{ kind: "edf-unreadable", severity: "review", field: "header", shape: shapeOf("") }];
  }
  const findings: Finding[] = [];
  const add = (kind: FindingKind, severity: Severity, field: string, text: string) =>
    findings.push({ kind, severity, field, shape: shapeOf(text) });

  // Local patient identification, bytes 8..88. The specification says ASCII; a byte above
  // 0x7F cannot be a placeholder, and no rule below can read it, so it is a finding itself.
  const patient = fieldText(bytes, 8, 88);
  if (hasNonAscii(bytes, 8, 88)) add("edf-patient-nonascii", "identifier", "patient", patient);
  const tokens = patient === "" ? [] : patient.split(/\s+/);
  const patientDates = findDates(patient);
  // One birth-date finding per field, so a birth date in the recording field is reported even when
  // the patient field has one too (otherwise removing the first would only reveal the second).
  const birthFlagged = new Set<string>();
  const flagBirth = (field: string, text: string) => {
    if (birthFlagged.has(field)) return;
    birthFlagged.add(field);
    add("edf-patient-birthdate", "identifier", field, text);
  };
  // Any date anywhere in the field that is not year-only is a birth date.
  for (const d of patientDates)
    if (!isYearOnly(d.candidates)) flagBirth("patient.birthdate", d.text);

  const sexWords = ["m", "f", "x", "male", "female"];
  const structuredSlots =
    tokens.length >= 4 && sexWords.includes((tokens[1] as string).toLowerCase());
  const clean = (t: string) => blankDates(t, findDates(t)).trim();
  if (structuredSlots) {
    const [code, , birth, name] = tokens as [string, string, string, string];
    if (isNameLike(clean(code), true)) add("edf-patient-code", "identifier", "patient.code", code);
    if (isNameLike(clean(name), true)) add("edf-patient-name", "identifier", "patient.name", name);
    // The birth slot holds X or a placeholder, a bare birth year, an age, or a date. Any other
    // content cannot be shown to be clean, so it is reported as a birth date.
    const birthOk =
      birth === "X" ||
      isPlaceholder(birth) ||
      /^(19|20)\d{2}$/.test(birth) ||
      /^\d{1,3}y?$/i.test(birth) ||
      findDates(birth).length > 0;
    if (!birthOk) flagBirth("patient.birthdate", birth);
    const extras = tokens.slice(4).map(clean);
    if (extras.some((t) => isNameLike(t))) {
      add("edf-patient-freetext", "identifier", "patient.additional", extras.join(" "));
    }
  } else {
    // A classic free-text patient field: any bare word that is not a date may be a name.
    const words = blankDates(patient, patientDates)
      .split(/\s+/)
      .filter((t) => t !== "");
    if (words.some((t) => isNameLike(t)))
      add("edf-patient-freetext", "identifier", "patient", patient);
  }
  // An age over 89 is an identifier: in the birth slot, as `age=95`, `95y`, `95yo`, `95-year-old`,
  // after a sex word (`M 95`), or implied by a birth year before the oldest age that is allowed.
  const blanked = blankDates(patient, patientDates);
  const ageFound = (): string | undefined => {
    const over = (text: string, n: number) => (n >= 90 && n <= 130 ? text : undefined);
    const slot = structuredSlots ? (tokens[2] as string) : "";
    const slotAge = /^(\d{2,3})y?$/i.exec(slot);
    if (slotAge) return over(slot, Number(slotAge[1]));
    const patterns = [
      /\bage[=: _-]*(\d{2,3})\b/gi,
      /\b(\d{2,3})\s?(?:y|yr|yrs|yo|y\/o|years?)\b/gi,
      /\b(\d{2,3})[- ]?(?:year|yr)s?[- ]?old\b/gi,
      /\b(?:m|f|male|female)\s+(\d{2,3})\b(?!\s?(?:kg|cm|lbs?|bpm|mm|hz|ms|mv|uv|years?\b))/gi,
    ];
    for (const re of patterns) {
      for (const m of blanked.matchAll(re)) {
        const hit = over(m[0], Number(m[1]));
        if (hit) return hit;
      }
    }
    const oldest = new Date().getFullYear() - 90;
    const bareYear = /^(19|20)\d{2}$/.test(slot) ? Number(slot) : undefined;
    const years = [...patientDates.flatMap((d) => d.candidates.map((c) => c.year)), bareYear];
    for (const y of years) if (y !== undefined && y >= 1900 && y < oldest) return String(y);
    return undefined;
  };
  const ageText = ageFound();
  if (ageText) add("edf-patient-age", "identifier", "patient.age", ageText);
  // A long run of digits (or a 3-2-4 digit group) that is not a date is a possible record number.
  const digitRun = /\d{6,}|\b\d{3}-\d{2}-\d{4}\b/.exec(blankDates(patient, patientDates));
  if (digitRun) add("edf-patient-recordnumber", "review", "patient", digitRun[0]);

  // Local recording identification, bytes 88..168.
  const recording = fieldText(bytes, 88, 168);
  if (hasNonAscii(bytes, 88, 168)) add("edf-recording-nonascii", "review", "recording", recording);
  if (recording !== "" && !isPlaceholder(recording)) {
    // One reading of the field's dates, shared with `edfAcquisitionDates`, so the rule that
    // rewrites an acquisition date finds exactly the date reported here.
    const {
      parts,
      keyword,
      dates: recDates,
      slot: slotAt,
      acquisition: acquisitionDate,
      birth,
    } = readRecordingDates(recording);
    const slot = slotAt?.text;
    const firstBirth = birth[0];
    if (firstBirth) flagBirth("recording.birthdate", firstBirth.text);
    if (acquisitionDate) {
      add("edf-recording-startdate", "review", "recording.startdate", acquisitionDate.text);
    }
    if (keyword) {
      // After the keyword the slot holds X or a date; anything else is not a date, whatever it is.
      if (slot !== undefined && slot !== "X" && findDates(slot).length === 0) {
        add("edf-recording-freetext", "review", "recording.startdate", slot);
      }
      // Admin code, technician and equipment that read as names.
      parts.slice(2).forEach((token, i) => {
        if (!isNameLike(clean(token))) return;
        const technician = i === 1;
        add(
          technician ? "edf-recording-technician" : "edf-recording-freetext",
          "review",
          technician ? "recording.technician" : "recording",
          token,
        );
      });
    } else {
      // A classic free-text recording identification has no designated slots, so a name-like
      // word in it is as serious as one in the patient field.
      const words = blankDates(recording, recDates)
        .split(/\s+/)
        .filter((t) => t !== "");
      if (words.some((t) => isNameLike(t))) {
        add("edf-recording-freetext", "identifier", "recording", recording);
      }
    }
  }

  // Header start date, bytes 168..176: `dd.mm.yy`. Anything else is reported as not a date.
  const startText = fieldText(bytes, 168, 176);
  const start = readHeaderStartDate(startText);
  if (start === "unparsed") add("edf-startdate-unparsed", "review", "startdate", startText);
  else if (start === "dated") add("edf-startdate", "review", "startdate", startText);
  return findings;
}

/**
 * Lowercase with every whitespace character (all that JavaScript's `\s` matches, so a no-break
 * space, a tab and a byte order mark too), underscore and hyphen removed: the canonical spelling
 * of a name. `canon` in scripts/scrub/git/rewrite_history.py and `canonicalKey` in
 * scripts/scrub/git/git-lib.ts spell it the same way, and test/scrub/git/canonical-key.test.ts
 * holds the three together; change this and that test shows what else to change.
 */
export const canonical = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

/** Table columns that name a person or a clinical record, in canonical spelling. */
const IDENTIFIER_COLUMNS = new Set([
  "name",
  "firstname",
  "lastname",
  "fullname",
  "givenname",
  "familyname",
  "surname",
  "forename",
  "participantname",
  "subjectname",
  "initials",
  "dob",
  "birthdate",
  "dateofbirth",
  "birthday",
  "email",
  "phone",
  "telephone",
  "address",
  "street",
  "zip",
  "postcode",
  "mrn",
  "ssn",
  "medicalrecord",
  "medicalrecordnumber",
  "medicalrecordno",
  "medicalrecordid",
  "recordnumber",
  "patientid",
  "patientname",
  "patientcode",
  "hospitalid",
  "nationalid",
]);

/**
 * Screen the header row of a participants/scans table (tab-separated). The reported field is
 * the canonical spelling from a closed set, never the raw column text.
 */
export function scanTableColumns(headerRow: string): Finding[] {
  const out: Finding[] = [];
  for (const raw of headerRow.replace(/^\uFEFF/, "").split("\t")) {
    const name = canonical(raw);
    if (name !== "" && IDENTIFIER_COLUMNS.has(name)) {
      out.push({
        kind: "participants-identifier-column",
        severity: "identifier",
        field: name,
        shape: shapeOf(raw.trim()),
      });
    }
  }
  return out;
}

/** A label that is only letters, four or more, and not a descriptive word, reads as a name. */
function labelIsNameLike(label: string): boolean {
  return /^\p{L}{4,}$/u.test(label) && !isNeutral(label);
}

/**
 * Screen the participant labels in a participants table (the first column, `sub-<label>`).
 * Review severity: BIDS labels are free alphanumerics, and an all-letter label of four or
 * more letters that is not a descriptive word may be a name.
 */
export function scanParticipantIds(tsvText: string): Finding[] {
  const out: Finding[] = [];
  const rows = tsvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(1);
  for (const row of rows) {
    const id = (row.split("\t")[0] ?? "").trim().replace(/^sub-/i, "");
    if (labelIsNameLike(id)) {
      out.push({
        kind: "path-subject-label",
        severity: "review",
        field: "participant_id",
        shape: shapeOf(id),
      });
    }
  }
  return out;
}

/**
 * Screen one `acq_time` value from a scans table. An acquisition date is acceptable when
 * nothing links it to a person, so this is a DATE kind at review severity.
 */
export function scanAcqTime(value: string): Finding[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return [];
  if (Number(m[3]) === 1 && Number(m[2]) === 1) return [];
  return [{ kind: "acq-time-dated", severity: "review", field: "acq_time", shape: shapeOf(value) }];
}

/** One `acq_time` cell of a scans table: where its text starts in the table's text, and the text. */
export interface AcqTimeCell {
  index: number;
  value: string;
}

/**
 * Every `acq_time` cell of a scans table, read the way the screen reads one: a leading byte-order
 * mark dropped, rows split at `\n`, the column found by its exact name in the header row (the
 * first such column), and a row too short to have that cell skipped. `index` is a position in the
 * text as given, the mark included. Shared by the screen ({@link scanScansTable}) and the one rule
 * that rewrites these dates (ADR 0091), so the two read the same cells.
 */
export function acqTimeCells(tsvText: string): AcqTimeCell[] {
  const out: AcqTimeCell[] = [];
  let rowStart = tsvText.startsWith("\uFEFF") ? 1 : 0;
  let col = -1;
  for (let row = 0; ; row++) {
    const newline = tsvText.indexOf("\n", rowStart);
    const rowEnd = newline < 0 ? tsvText.length : newline;
    const text = tsvText.slice(rowStart, rowEnd);
    if (row === 0) {
      col = text.replace(/\r$/, "").split("\t").indexOf("acq_time");
      if (col < 0) return out;
    } else {
      let cellStart = 0;
      let k = 0;
      for (; k < col; k++) {
        const tab = text.indexOf("\t", cellStart);
        if (tab < 0) break;
        cellStart = tab + 1;
      }
      if (k === col) {
        const tab = text.indexOf("\t", cellStart);
        out.push({
          index: rowStart + cellStart,
          value: text.slice(cellStart, tab < 0 ? text.length : tab),
        });
      }
    }
    if (newline < 0) return out;
    rowStart = newline + 1;
  }
}

/** Screen a scans table's text: the dated `acq_time` values ({@link scanAcqTime}). */
export function scanScansTable(tsvText: string): Finding[] {
  return acqTimeCells(tsvText).flatMap((cell) => scanAcqTime(cell.value));
}

/**
 * JSON keys that name a person or a clinical record, in canonical spelling. Bare `name`,
 * `first_name` and the like are NOT here: citation and dataset metadata carry the authors'
 * names by design, and a pipeline config has a `name` for everything.
 */
const IDENTIFIER_KEYS = new Set([
  "patientname",
  "patientid",
  "patientguid",
  "patientcode",
  "patientbirthdate",
  "birthdate",
  "dateofbirth",
  "dob",
  "examdoctor",
  "diagnosisdoctor",
  "requestdoctor",
  "admissionid",
  "bednumber",
  "medicalrecord",
  "medicalrecordnumber",
  "medicalrecordno",
  "medicalrecordid",
  "mrn",
  "ssn",
  "nationalid",
]);
/** Keys that may be an author's public contact or a participant's: a person decides. */
const REVIEW_KEYS = new Set(["address", "contact", "phone", "telephone", "email", "national"]);

/** True when a JSON value holds anything at all, at any depth. */
export function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === "object") return Object.values(value as object).some(hasContent);
  return false;
}

/**
 * Walk a parsed JSON document; flag identifier-named keys that hold content, whether a
 * string, a number, an array or an object. The reported field is the canonical spelling of
 * the matched key, a member of a closed set: an ancestor key can itself be a name, so it never
 * enters a finding.
 */
export function scanJsonKeys(doc: unknown): Finding[] {
  const out: Finding[] = [];
  if (Array.isArray(doc)) {
    for (const item of doc) out.push(...scanJsonKeys(item));
    return out;
  }
  if (doc === null || typeof doc !== "object") return out;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    const name = canonical(key);
    const severity: Severity | null = IDENTIFIER_KEYS.has(name)
      ? "identifier"
      : REVIEW_KEYS.has(name)
        ? "review"
        : null;
    if (severity && hasContent(value)) {
      const sample = Array.isArray(value) ? "[]" : typeof value === "object" ? "{}" : String(value);
      out.push({ kind: "json-identifier-key", severity, field: name, shape: shapeOf(sample) });
      continue;
    }
    if (value !== null && typeof value === "object") out.push(...scanJsonKeys(value));
  }
  return out;
}

const IMAGE_OR_DOCUMENT = /\.(jpe?g|png|gif|bmp|tiff?|webp|pdf|docx?|xlsx?|pptx?|rtf|odt)$/i;
/** BIDS photo suffixes (electrode and head photographs) are an accepted image use. */
const BIDS_PHOTO = /_photo\.(jpe?g|png|tiff?)$/i;
const TOOLING_DEBRIS =
  /(^|\/)(\.idea|\.vscode|__pycache__|\.ipynb_checkpoints|\.DS_Store|Thumbs\.db)(\/|$)|\.pyc$/;

/**
 * Screen a list of dataset-relative paths. Images and documents outside the BIDS photo
 * convention can show a name on screen or be a consent form; editor and interpreter
 * debris carries local user names and machine paths; an all-letter `sub-` label that is
 * not a descriptive word may be a name.
 */
export function scanPaths(paths: string[]): Finding[] {
  const out: Finding[] = [];
  const seenLabels = new Set<string>();
  for (const path of paths) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (TOOLING_DEBRIS.test(path)) {
      out.push({ kind: "tooling-debris", severity: "review", field: "path", shape: shapeOf(base) });
    } else if (IMAGE_OR_DOCUMENT.test(base) && !BIDS_PHOTO.test(base)) {
      out.push({
        kind: "image-or-document-file",
        severity: "review",
        field: "path",
        shape: shapeOf(base),
      });
    }
    for (const m of path.matchAll(/(?:^|\/)sub-([\p{L}\p{N}]+)/gu)) {
      const label = m[1] as string;
      if (labelIsNameLike(label) && !seenLabels.has(label)) {
        seenLabels.add(label);
        out.push({
          kind: "path-subject-label",
          severity: "review",
          field: "path",
          shape: shapeOf(label),
        });
      }
    }
  }
  return out;
}

/** A Windows `C:\Users\<name>` or a POSIX home path that is not part of a URL. */
const LOCAL_USER_PATH =
  /(?:[A-Za-z]:\\{1,2}Users\\{1,2}|(?<![A-Za-z0-9._~:/-])\/(?:Users|home)\/)([A-Za-z0-9_.-]+)/;
/** Account names that name nobody: placeholders and CI accounts. */
const GENERIC_ACCOUNTS = new Set([
  "user",
  "username",
  "name",
  "you",
  "me",
  "yourname",
  "your_name",
  "runner",
  "ubuntu",
  "vagrant",
  "node",
  "foo",
  "example",
  "dev",
  "docker",
  "root",
  "shared",
  "public",
  "default",
]);

/**
 * Screen text for a local user path such as `C:\Users\<name>` or `/Users/<name>`. EVERY path in
 * the text is examined, so a generic account (`/home/user`) never hides a real one after it;
 * the result is still one finding per text, shaped from the first non-generic path.
 */
export function scanTextForLocalPaths(text: string): Finding[] {
  // A fresh global copy per call: the constant has no flags, so it keeps no `lastIndex` and one
  // call can never change what the next one sees.
  for (const m of text.matchAll(new RegExp(LOCAL_USER_PATH, "g"))) {
    if (GENERIC_ACCOUNTS.has((m[1] as string).toLowerCase())) continue;
    return [{ kind: "local-user-path", severity: "review", field: "text", shape: shapeOf(m[0]) }];
  }
  return [];
}

export interface FormatCoverage {
  /** EDF and BDF files, whose header this module parses. */
  screened: number;
  /**
   * Recording data this module cannot parse, counted by format: `.set`, `.hdf5`, `.edf.gz`,
   * and directory formats as `.ds/`, `.mff/`, `.mefd/`, `.zarr/` (one per directory).
   */
  unscreened: Record<string, number>;
}

/** Directory formats: the recording is a folder, and a manifest lists the files inside it. */
export const DIRECTORY_FORMATS: readonly string[] = [".ds", ".mff", ".mefd", ".zarr"];
/** A BIDS data file: `..._<suffix>.<extension>`, with a one- or two-part extension. */
const BIDS_DATA_FILE = /_(eeg|ieeg|meg|emg|nirs|physio|motion)\.([a-z0-9+]+(?:\.[a-z0-9]+)?)$/;
/** Formats counted as recording or signal data wherever they sit, named or not by BIDS. */
export const OTHER_RECORDING_EXTENSIONS: readonly string[] = [
  ".vhdr",
  ".set",
  ".fdt",
  ".fif",
  ".fif.gz",
  ".cnt",
  ".xdf",
  ".nwb",
  ".snirf",
  ".gdf",
  ".con",
  ".sqd",
  ".hdf5",
  ".h5",
  ".mat",
  ".trc",
  ".cdt",
  ".nev",
  ".edf.gz",
  ".bdf.gz",
  ".nii",
  ".nii.gz",
  ".ns1",
  ".ns2",
  ".ns3",
  ".ns4",
  ".ns5",
  ".ns6",
  ".lay",
  ".rec",
  ".smr",
  ".dat",
  ".npy",
  ".parquet",
  // Archives hold raw files of any format that nobody opened.
  ".zip",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".7z",
  ".rar",
];

/**
 * Under `sourcedata/` anything that is not one of these is raw material of unknown format and is
 * counted as unscreened. Text, tables, code and documents are read by other rules or carry no signal.
 */
const SOURCEDATA_HARMLESS = new Set([
  "json",
  "tsv",
  "csv",
  "txt",
  "md",
  "yml",
  "yaml",
  "xml",
  "iml",
  "py",
  "pyc",
  "m",
  "r",
  "rmd",
  "ipynb",
  "gitignore",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "pdf",
  "svg",
  "tex",
  "bib",
  "rst",
  "cfg",
  "ini",
  "toml",
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "odt",
  "ods",
  "rtf",
  "html",
  "htm",
  "log",
  "sh",
  "bat",
  "ps1",
  "js",
  "ts",
  "css",
  "lock",
  "gitkeep",
  "ds_store",
]);

/** Base names that are documentation or housekeeping, with or without an extension. */
const HARMLESS_BASENAME =
  /^(readme|license|licence|changes|citation|authors|notice|thumbs\.db|\.ds_store|\.gitkeep)/;

/**
 * Count recording data by whether this module can read it. The question it answers is "what is
 * here that nobody looked at", so it counts by what a file IS (a BIDS data file in any format
 * but EDF, BDF, JSON or TSV; a directory format; a known signal extension) rather than by a
 * short list of formats someone remembered.
 */
export function formatCoverage(paths: string[]): FormatCoverage {
  const unscreened: Record<string, number> = {};
  const directories = new Set<string>();
  let screened = 0;
  const count = (key: string) => {
    unscreened[key] = (unscreened[key] ?? 0) + 1;
  };
  for (const raw of paths) {
    const path = raw.toLowerCase();
    if (path.endsWith(".edf") || path.endsWith(".bdf")) {
      screened++;
      continue;
    }
    const segments = path.split("/");
    const dirIndex = segments.findIndex(
      (s, i) => i < segments.length - 1 && DIRECTORY_FORMATS.some((e) => s.endsWith(e)),
    );
    if (dirIndex >= 0) {
      const dir = segments.slice(0, dirIndex + 1).join("/");
      if (!directories.has(dir)) {
        directories.add(dir);
        const ext = DIRECTORY_FORMATS.find((e) => (segments[dirIndex] as string).endsWith(e));
        count(`${ext}/`);
      }
      continue;
    }
    const bids = BIDS_DATA_FILE.exec(path);
    if (bids) {
      const ext = bids[2] as string;
      if (ext !== "json" && ext !== "tsv") count(`.${ext}`);
      continue;
    }
    const hit = OTHER_RECORDING_EXTENSIONS.filter((e) => path.endsWith(e)).sort(
      (a, b) => b.length - a.length,
    )[0];
    if (hit) {
      count(hit);
      continue;
    }
    // Raw material under sourcedata/ in a format not listed above is still unread.
    if (path.startsWith("sourcedata/")) {
      const base = segments[segments.length - 1] as string;
      const dot = base.lastIndexOf(".");
      const ext = dot > 0 ? base.slice(dot + 1) : dot === 0 ? base.slice(1) : "";
      if (!SOURCEDATA_HARMLESS.has(ext) && !HARMLESS_BASENAME.test(base)) {
        count(ext === "" ? "(no extension)" : `.${ext}`);
      }
    }
  }
  return { screened, unscreened };
}

/** Count findings by kind. Values never enter a summary, only counts. */
export function countByKind(findings: Finding[]): Partial<Record<FindingKind, number>> {
  const counts: Partial<Record<FindingKind, number>> = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}
