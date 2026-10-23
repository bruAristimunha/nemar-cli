/**
 * Part B of the change summary: the facts about what a dataset pull request changed of the content
 * its original authors published (ADR 0109; design `.context/plans/pr-review-change-summary.md`,
 * Part B, sections B1 to B7).
 *
 * The owner's rule is that a contributor may add to what the original authors wrote but may not
 * alter or remove it; the account of a change belongs in CHANGES. The model used to read a README
 * diff and be told about "deletions" that were only line endings or a final newline. This module
 * computes the facts the rule is decided on, mechanically and in closed words, so the platform can
 * act on them and the model is told what they are instead of guessing from a diff.
 *
 * **This module is pure.** No git, no file system and no clock: it reads the bytes its caller has
 * already fetched and returns counts, booleans and closed words, so every rule here is tested on
 * bytes alone and none of it can reach a repository. Which blobs are read, at which commit, and
 * what a fact does to the review are the caller's.
 *
 * Two rules run through it, as through the summary it extends:
 *
 * 1. **What cannot be decided is said, never guessed.** A document the module will not read is one
 *    of the closed words in {@link PROSE_REFUSALS}, which the caller turns into "unknown" (a person
 *    looks), never into "clean". The words are printed in a public log, so none is built from a
 *    path or a contributor's text.
 * 2. **Where a reading is doubtful, the reading that flags is the one taken.** Protection falls
 *    back to the stricter side, every copy of an original line is protected, and a choice the rules
 *    leave open goes the way that reports more, never the way that could call an alteration clean.
 */

import { firstReadme } from "../../shared/readme-candidates";
import {
  type ChangeSummary,
  type ClassKind,
  type JsonValue,
  SUMMARY_LIMITS,
  canonicalJson,
  isMissingJson,
  parseJson,
} from "./pr-review-summary";

// ---------------------------------------------------------------------------------------------
// Limits and closed words
// ---------------------------------------------------------------------------------------------

/**
 * The bounds of Part B. Each is a refusal, never a silent truncation: a document over a bound is
 * not compared, and the caller reports the comparison as unknown. Set A at its largest is a README
 * of 54 KB, 128 lines and a longest line of 2,207 bytes, so every bound is far above real input and
 * exists for hostile input only. The last two are read by later sections of this module.
 */
export const ORIGINAL_LIMITS = {
  maxDocumentBytes: 4 * 1024 * 1024, // one side of a document, every part together
  maxDocumentParts: 16, // root files in one document, per side
  maxDocumentLines: 20_000, // one side, counted after normalization (blank lines are not lines)
  // Lines removed plus lines inserted past which two sides are not aligned at all.
  maxEditDistance: 2_000,
  // Removed times inserted lines of one anchor hunk up to which every pair is tried for a minor
  // edit; past it, lines are paired from the start and from the end of the hunk.
  maxMinorPairs: 4_096,
  // Code points of the shorter line of each pair, summed over the hunks whose every pair is tried,
  // past which a hunk is paired from its ends too: about one document's worth of banded distance.
  maxMinorPairCodePoints: 4 * 1024 * 1024,
  // The minor-edit bound of one line is a tenth of the longer line, in code points, kept between
  // these two (design B2.1).
  minorFloor: 3,
  minorCeiling: 20,
  maxExamples: 3, // removed original lines kept for the fenced block
  pointerMaxBytes: 1_023, // an unlocked annex pointer is a regular blob shorter than 1 KiB
  maxTagsTried: 32, // version tags tried for an ancestor of the merge base
} as const;

/**
 * Why a document was not compared. A closed list: the first three are the bounds of
 * {@link ORIGINAL_LIMITS}, the next three are about a part's bytes or mode, and the last is the
 * alignment's cap.
 *
 * - `too_large`: one side's parts hold more than `maxDocumentBytes` together.
 * - `too_many_parts`: one side has more than `maxDocumentParts` parts.
 * - `too_many_lines`: one side has more than `maxDocumentLines` lines once normalized.
 * - `binary`: a part holds a NUL byte and is not the same blob on both sides.
 * - `not_regular`: a part is not a regular file (a symbolic link, a submodule).
 * - `unreadable`: the caller could not read a part's bytes.
 * - `edit_distance_cap`: the two sides differ by more than `maxEditDistance` lines.
 */
export const PROSE_REFUSALS = [
  "too_large",
  "too_many_parts",
  "too_many_lines",
  "binary",
  "not_regular",
  "unreadable",
  "edit_distance_cap",
] as const;
export type ProseRefusal = (typeof PROSE_REFUSALS)[number];

/** A result that is either read or refused in one of the closed words above. */
export type ProseRead<T> = { ok: true; value: T } | { ok: false; refusal: ProseRefusal };

// ---------------------------------------------------------------------------------------------
// Documents: names, bytes to text, normalization (design B2.1, items 1 and 2)
// ---------------------------------------------------------------------------------------------

/** The two prose documents Part B compares. */
export type DocumentKind = "readme" | "changes";

/**
 * The root file names that make up each document, compared without regard to case. The README is
 * every root `README` with at most one alphanumeric extension; CHANGES is `CHANGES` or `CHANGELOG`,
 * bare or with `.md`, `.txt` or `.rst`. One document across names is what makes `README` renamed
 * to `README.md`, or `README.md` to `README.rst`, with the same text a preserved document rather
 * than one file removed and another added.
 */
export const DOCUMENT_NAME: Readonly<Record<DocumentKind, RegExp>> = {
  readme: /^readme(\.[A-Za-z0-9]+)?$/i,
  changes: /^(changes|changelog)(\.(md|txt|rst))?$/i,
};

/** Whether `path` is a part of the document: a root file (no `/` at all) whose name matches. */
export function isDocumentName(document: DocumentKind, path: string): boolean {
  return !path.includes("/") && DOCUMENT_NAME[document].test(path);
}

/** One root file of a document, as the caller read it at one commit. */
export interface DocumentPart {
  /** The root path, which {@link isDocumentName} accepts for the document. */
  name: string;
  /** The git mode as `ls-tree` writes it: `100644` and `100755` are regular files. */
  mode: string;
  /** The blob id. Two parts with one id hold the same bytes. */
  oid: string;
  /** The blob's bytes, or `unreadable` when the caller could not read them. */
  content: Uint8Array | "unreadable";
}

/** The kind of line breaks a text holds: one kind throughout, several (`mixed`), or none at all. */
export type LineBreaks = "none" | "lf" | "crlf" | "cr" | "mixed";

/**
 * A text as one part's bytes say it. A leading UTF-8 byte order mark is dropped first. The rest is
 * strict UTF-8 when it decodes as such (a malformed sequence is never replaced by U+FFFD, which
 * would make two different texts one); otherwise it is ISO-8859-1, every byte the code point of its
 * value, and `notUtf8` says so. ISO-8859-1 is decoded here by hand because the WHATWG decoder
 * labeled `latin1` is windows-1252, which maps the bytes 0x80 to 0x9F to other characters.
 */
export function decodeProse(bytes: Uint8Array): { text: string; notUtf8: boolean } {
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    // `ignoreBOM: true` keeps a second U+FEFF as text: the one byte order mark was removed above.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return { text, notUtf8: false };
  } catch {
    let text = "";
    for (let i = 0; i < body.length; i += 0x2000) {
      text += String.fromCharCode(...body.subarray(i, i + 0x2000));
    }
    return { text, notUtf8: true };
  }
}

/** A text's lines once normalized, with what normalization removed that the facts still report. */
export interface NormalizedText {
  /**
   * The lines that are not blank, without their trailing spaces and tabs. `paragraphStart` is set
   * on the first line of the text, on every line that followed a blank one, and on the blocks
   * {@link normalizeProse} reads: a heading, the line after it, and a list item that starts one.
   */
  lines: { text: string; paragraphStart: boolean }[];
  breaks: LineBreaks;
  /** The text is not empty and its last character is a line break. */
  endsWithBreak: boolean;
  /**
   * The text has more lines than the `maxLines` it was read with: reading stopped at the first line
   * past the bound, so `lines` holds `maxLines + 1` lines and `breaks` and `endsWithBreak` describe
   * nothing. A caller that sees it refuses the text.
   */
  overLimit: boolean;
}

/** An ATX heading line: up to three spaces, one to six `#`, then a blank or the end of the line. */
const ATX_HEADING = /^ {0,3}#{1,6}(\s|$)/;

/**
 * A list item line: up to three spaces, `-`, `*`, `+` or one to nine digits and `.` or `)`, then a
 * blank or the end of the line.
 */
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;

/**
 * A list item that can interrupt a paragraph: a `-`, `*` or `+`, or exactly `1.` or `1)`, then a
 * blank and some text. CommonMark lets no other item interrupt one: `2.`, `01.` or `2019.` in the
 * middle of a paragraph, or a marker with nothing after it, is that paragraph's text.
 */
const INTERRUPTING_ITEM = /^ {0,3}([-*+]|1[.)])[ \t]+\S/;

/** The code units {@link normalizeProse} read, for a test to bound. Added to, never reset. */
export interface NormalizeMeter {
  units: number;
}

/**
 * Whether a UTF-16 code unit is a space or a tab, the only characters stripped from a line's end.
 */
function isTrailingBlank(unit: number): boolean {
  return unit === 0x20 || unit === 0x09;
}

/**
 * Normalize one part's text for comparison (design B2.1, item 2). A line ends at a CRLF, an LF or a
 * lone CR (a lone CR is a line break, as CommonMark reads it). Trailing spaces and tabs are removed
 * from every line; a line left empty is blank, sets `paragraphStart` on the next line kept, and is
 * dropped. The paragraph flags are therefore decided BEFORE the blank lines are gone, which is the
 * only way they can be decided. Nothing else changes: case, inner whitespace, leading indentation
 * and a no-break space are all significant.
 *
 * Two kinds of line start a block in rendered Markdown, and so start a paragraph here too: an ATX
 * heading ({@link ATX_HEADING}), and the line after it, and a list item ({@link LIST_ITEM}). A list
 * item that cannot interrupt a paragraph (anything but {@link INTERRUPTING_ITEM}) starts one only
 * where no paragraph is open to interrupt: on the first line, after a blank line or a heading, or
 * inside a list, which an item opens and a blank line or a heading closes. A README written with
 * no blank lines around its headings is then read as the sections it renders as, and a line that
 * opens with a year (`2019. The study`) inside a paragraph stays in it. Nothing else of Markdown is
 * parsed: fenced code, tables, setext headings and block quotes are not, and every other line is
 * governed by blank lines alone.
 *
 * This removes exactly the two artifacts measured on set A (a final newline added and CRLF turned
 * into LF) and the trailing whitespace a mass cleanup touches; `breaks` and `endsWithBreak` keep
 * what was removed so the caller can say it.
 *
 * Trailing blanks are stripped by a loop from the end, not by a regular expression: `/[ \t]+$/`
 * backtracks over every run of spaces that is not at the end, which is quadratic in a hostile line.
 *
 * With `maxLines`, reading stops at the first line past it (`overLimit`), so the lines a refused
 * text costs are bounded by the cap and not by its length; `meter`, when given, counts the code
 * units read, so a test can see where reading stopped.
 */
export function normalizeProse(
  text: string,
  maxLines: number = Number.POSITIVE_INFINITY,
  meter?: NormalizeMeter,
): NormalizedText {
  const over: NormalizedText = { lines: [], breaks: "none", endsWithBreak: false, overLimit: true };
  const lines: { text: string; paragraphStart: boolean }[] = [];
  let paragraphStart = true;
  let afterHeading = false;
  let inList = false;
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  const keep = (from: number, to: number): void => {
    let end = to;
    while (end > from && isTrailingBlank(text.charCodeAt(end - 1))) end--;
    if (end === from) {
      paragraphStart = true;
      return;
    }
    const line = text.slice(from, end);
    const heading = ATX_HEADING.test(line);
    const item =
      LIST_ITEM.test(line) &&
      (paragraphStart || afterHeading || inList || INTERRUPTING_ITEM.test(line));
    lines.push({ text: line, paragraphStart: paragraphStart || afterHeading || heading || item });
    // A line of an item, its own or one that continues it with no blank line, keeps a list open.
    inList = item || (inList && !heading && !paragraphStart);
    paragraphStart = false;
    afterHeading = heading;
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit !== 0x0a && unit !== 0x0d) continue;
    keep(start, i);
    if (lines.length > maxLines) {
      if (meter) meter.units += i + 1;
      return { ...over, lines };
    }
    if (unit === 0x0a) lf++;
    else if (text.charCodeAt(i + 1) === 0x0a) {
      crlf++;
      i++;
    } else cr++;
    start = i + 1;
  }
  keep(start, text.length);
  if (meter) meter.units += text.length;
  if (lines.length > maxLines) return { ...over, lines };
  const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  const breaks: LineBreaks =
    kinds === 0 ? "none" : kinds > 1 ? "mixed" : lf > 0 ? "lf" : crlf > 0 ? "crlf" : "cr";
  const last = text.charCodeAt(text.length - 1);
  return { lines, breaks, endsWithBreak: last === 0x0a || last === 0x0d, overLimit: false };
}

/** One normalized line of a document, with the part it came from. */
export interface ProseLine {
  text: string;
  /**
   * The line starts a paragraph: it is the first line of its part, follows a blank line, or starts
   * a block {@link normalizeProse} reads (a heading, the line after it, a list item).
   */
  paragraphStart: boolean;
  /** The name of the part the line is in. */
  part: string;
}

/** One side of a document, read and normalized. */
export interface ProseDocument {
  /** Every part's lines, the parts in code-unit order of their names. */
  lines: readonly ProseLine[];
  /** The line breaks of every part read, together. */
  breaks: LineBreaks;
  /** A part read was not UTF-8 and was decoded as ISO-8859-1. */
  notUtf8: boolean;
  /** For each part read that is not empty, whether its text ends with a line break. */
  finalBreak: ReadonlyMap<string, boolean>;
}

/** One git mode a regular file can have. */
const REGULAR_MODE = /^100(644|755)$/;

/** The line breaks of two texts read as one. */
function joinBreaks(a: LineBreaks, b: LineBreaks): LineBreaks {
  if (a === "none" || a === b) return b;
  if (b === "none") return a;
  return "mixed";
}

/**
 * One side of a document from its parts (design B2.1, item 1): the parts in code-unit order of
 * their names (the order `ls-tree` lists them, and not a locale's), each decoded with
 * {@link decodeProse} and normalized with {@link normalizeProse}, their lines concatenated. The
 * first line of every part starts a paragraph, so the end of one file and the start of the next are
 * never one paragraph.
 *
 * The checks run in this order, each over every part before the next, so the word a side gets
 * depends on what its parts are and never on the order they are listed: more than
 * `maxDocumentParts` parts is `too_many_parts`; a part that is not a regular file `not_regular`; a
 * part the caller could not read `unreadable`; more than `maxDocumentBytes` over every part
 * `too_large`; a NUL byte `binary`; more than `maxDocumentLines` lines `too_many_lines`.
 *
 * A part that holds a NUL byte is skipped instead of refused when its blob id is in `skip`, the ids
 * the caller found on BOTH sides of the comparison. A binary part that did not change says nothing
 * about the text, and refusing it would make every edit of a README unknown for as long as a
 * `README.pdf` sat beside it; one that did change is `binary`, and the comparison is unknown.
 *
 * A part whose name is not one of the document's, or a name given twice, is a defect in the caller
 * and throws: it is not a property of the pull request, so it has no refusal word.
 */
export function assembleDocument(
  document: DocumentKind,
  parts: readonly DocumentPart[],
  skip: ReadonlySet<string>,
): ProseRead<ProseDocument> {
  const names = new Set<string>();
  for (const part of parts) {
    if (!isDocumentName(document, part.name) || names.has(part.name)) {
      throw new Error(`assembleDocument: not one ${document} part per name`);
    }
    names.add(part.name);
  }
  if (parts.length > ORIGINAL_LIMITS.maxDocumentParts) {
    return { ok: false, refusal: "too_many_parts" };
  }
  const sorted = [...parts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.some((part) => !REGULAR_MODE.test(part.mode))) {
    return { ok: false, refusal: "not_regular" };
  }
  const read: { name: string; oid: string; content: Uint8Array }[] = [];
  let bytes = 0;
  for (const part of sorted) {
    if (part.content === "unreadable") return { ok: false, refusal: "unreadable" };
    read.push({ name: part.name, oid: part.oid, content: part.content });
    bytes += part.content.length;
  }
  if (bytes > ORIGINAL_LIMITS.maxDocumentBytes) return { ok: false, refusal: "too_large" };
  const kept = read.filter(({ oid, content }) => !(content.includes(0) && skip.has(oid)));
  if (kept.some(({ content }) => content.includes(0))) return { ok: false, refusal: "binary" };
  const lines: ProseLine[] = [];
  const finalBreak = new Map<string, boolean>();
  let breaks: LineBreaks = "none";
  let notUtf8 = false;
  for (const { name, content } of kept) {
    const decoded = decodeProse(content);
    // The lines this side has left are the bound for the part, so no part is split into more lines
    // than the side may hold: 4 MiB of short lines is refused at line 20,001, not after millions.
    const normalized = normalizeProse(
      decoded.text,
      ORIGINAL_LIMITS.maxDocumentLines - lines.length,
    );
    if (normalized.overLimit) return { ok: false, refusal: "too_many_lines" };
    notUtf8 ||= decoded.notUtf8;
    breaks = joinBreaks(breaks, normalized.breaks);
    if (decoded.text.length > 0) finalBreak.set(name, normalized.endsWithBreak);
    for (const line of normalized.lines) lines.push({ ...line, part: name });
  }
  return { ok: true, value: { lines, breaks, notUtf8, finalBreak } };
}

// ---------------------------------------------------------------------------------------------
// Distances: the minor edit of one line (design B2.1, "Minor edit")
// ---------------------------------------------------------------------------------------------

/** A string's code points: an astral character is one, a combining mark is one of its own. */
function codePoints(s: string): Int32Array {
  const out = new Int32Array(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i) as number;
    out[n++] = cp;
    if (cp > 0xffff) i++;
  }
  return out.subarray(0, n);
}

/** How many code points a string holds, without copying it. */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if ((s.codePointAt(i) as number) > 0xffff) i++;
    n++;
  }
  return n;
}

/**
 * The most a line may change and still be a minor edit: a tenth of the longer of the two lines,
 * rounded down and counted in code points, but never less than `minorFloor` (3) or more than
 * `minorCeiling` (20). The `Funding` typo fix measured on set A (7 in about 100 characters) is
 * within it; a rewritten sentence is not.
 */
export function minorBound(a: string, b: string): number {
  return boundOfLonger(Math.max(codePointLength(a), codePointLength(b)));
}

/** {@link minorBound} from the length of the longer line, in code points. */
function boundOfLonger(longer: number): number {
  return Math.min(
    ORIGINAL_LIMITS.minorCeiling,
    Math.max(ORIGINAL_LIMITS.minorFloor, Math.floor(longer / 10)),
  );
}

/**
 * The Levenshtein distance between two strings in code points when it is at most `k`, and `k + 1`
 * when it is more. Only the band of `2k + 1` diagonals around the main one is computed, and the
 * computation stops at the first row whose every cell is past `k`, so the cost is linear in the
 * length of the strings for the small `k` a minor edit allows, and a megabyte line against a short
 * one costs nothing (their lengths alone differ by more than `k`). Counting code points and not
 * UTF-16 code units is what makes an astral character one edit, as a reader counts it; a
 * combining mark is a code point of its own, and so an edit of its own.
 */
export function levenshteinWithin(a: string, b: string, k: number): number {
  if (a === b) return 0;
  const cap = k + 1;
  let x = codePoints(a);
  let y = codePoints(b);
  if (x.length > y.length) [x, y] = [y, x];
  if (y.length - x.length > k) return cap;
  // A common prefix and suffix cost nothing and are cut first.
  let start = 0;
  while (start < x.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  x = x.subarray(start, endX);
  y = y.subarray(start, endY);
  const n = x.length;
  const m = y.length;
  if (n === 0) return Math.min(m, cap);
  // Row i holds the cells of columns i - k to i + k, column j at index j - i + k.
  const width = 2 * k + 1;
  let prev = new Int32Array(width).fill(cap);
  let cur = new Int32Array(width);
  for (let j = 0; j <= Math.min(m, k); j++) prev[j + k] = j;
  for (let i = 1; i <= n; i++) {
    cur.fill(cap);
    let best = cap;
    const last = Math.min(m, i + k);
    for (let j = Math.max(0, i - k); j <= last; j++) {
      const t = j - i + k;
      let value = i; // column 0: i deletions
      if (j > 0) {
        const replace = (prev[t] as number) + (x[i - 1] === y[j - 1] ? 0 : 1);
        const remove = t + 1 < width ? (prev[t + 1] as number) + 1 : cap;
        const insert = t > 0 ? (cur[t - 1] as number) + 1 : cap;
        value = Math.min(replace, remove, insert, cap);
      }
      cur[t] = value;
      if (value < best) best = value;
    }
    // Every path to the end crosses this row, and no step lowers a distance.
    if (best > k) return cap;
    [prev, cur] = [cur, prev];
  }
  return Math.min(prev[m - n + k] as number, cap);
}

/** Whether `b` is a minor edit of `a`: their distance is within {@link minorBound}. */
export function isMinorEdit(a: string, b: string): boolean {
  const bound = minorBound(a, b);
  return levenshteinWithin(a, b, bound) <= bound;
}

// ---------------------------------------------------------------------------------------------
// Alignment: Myers' diff of two line sequences (design B2.1, item 3)
// ---------------------------------------------------------------------------------------------

/** One step of an edit script: a line kept, a line of the first side removed, or one inserted. */
export type AlignOp = "equal" | "delete" | "insert";

/** A shortest edit script and its length, the number of lines removed plus inserted. */
export interface Alignment {
  ops: AlignOp[];
  distance: number;
}

/**
 * The work an alignment did, for a test to bound: one step per diagonal tried and one per line
 * matched along a diagonal, so about one comparison each. It is added to, never reset, so one
 * meter can be passed to several calls.
 */
export interface AlignMeter {
  steps: number;
}

/**
 * The middle of an alignment by Myers' greedy algorithm ("An O(ND) Difference Algorithm and Its
 * Variations", 1986), or null when the distance is more than `maxD`. Both sides are non-empty and
 * already interned. The work is O((N + M) D) and the memory one slice of the furthest-reaching
 * frontier per distance, each holding only the diagonals of its parity: about two million numbers
 * (8 MB) at `maxD` 2,000, which is what keeps the cap a bound on memory as well as time.
 *
 * The tie-break is pinned, because it decides which lines a hunk pairs: the path goes down (an
 * insertion) iff `k == -d || (k != d && V[k - 1] < V[k + 1])`, and the backtrack repeats the same
 * rule over the stored slices, so it retraces exactly the path that was found.
 */
function myersMiddle(
  x: Int32Array,
  y: Int32Array,
  maxD: number,
  meter: AlignMeter | undefined,
): AlignOp[] | null {
  const n = x.length;
  const m = y.length;
  let steps = 0;
  try {
    // The distance is at least the difference in length, so a larger one is over the cap at once.
    if (Math.abs(n - m) > maxD) return null;
    const offset = maxD + 1;
    const v = new Int32Array(2 * maxD + 3);
    const trace: Int32Array[] = [];
    for (let d = 0; d <= maxD; d++) {
      const slice = new Int32Array(d + 1);
      for (let k = -d; k <= d; k += 2) {
        steps++;
        const down =
          k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
        let px = down ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
        let py = px - k;
        while (px < n && py < m && x[px] === y[py]) {
          px++;
          py++;
          steps++;
        }
        v[offset + k] = px;
        slice[(k + d) >> 1] = px;
        if (px >= n && py >= m) {
          trace.push(slice);
          return backtrack(trace, n, m);
        }
      }
      trace.push(slice);
    }
    return null;
  } finally {
    if (meter) meter.steps += steps;
  }
}

/**
 * The script of the path {@link myersMiddle} found, from the slices it stored, in forward order.
 */
function backtrack(trace: readonly Int32Array[], n: number, m: number): AlignOp[] {
  const ops: AlignOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array;
    const at = (k: number): number => prev[(k + d - 1) >> 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const moved = down ? prevX : prevX + 1;
    for (; x > moved; x--, y--) ops.push("equal");
    ops.push(down ? "insert" : "delete");
    x = prevX;
    y = prevX - prevK;
  }
  for (; x > 0; x--) ops.push("equal");
  return ops.reverse();
}

/**
 * A shortest edit script turning the lines `a` into the lines `b`, or null when it would remove
 * and insert more than `maxD` lines together. Lines are compared exactly, as interned numbers. A
 * common prefix and suffix are matched first; when nothing is left on one side the middle is pure
 * insertion or pure removal and its script is immediate and never capped, so a README that only
 * gained a long new section is never refused, however long the section. Otherwise the middle goes
 * through Myers' algorithm with the cap; `meter`, when given, counts its work.
 */
export function alignLines(
  a: readonly string[],
  b: readonly string[],
  maxD: number = ORIGINAL_LIMITS.maxEditDistance,
  meter?: AlignMeter,
): Alignment | null {
  const ids = new Map<string, number>();
  const intern = (lines: readonly string[]): Int32Array =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    });
  const x = intern(a);
  const y = intern(b);
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
  let suffix = 0;
  while (
    prefix + suffix < x.length &&
    prefix + suffix < y.length &&
    x[x.length - 1 - suffix] === y[y.length - 1 - suffix]
  ) {
    suffix++;
  }
  const n = x.length - prefix - suffix;
  const m = y.length - prefix - suffix;
  let middle: AlignOp[] | null;
  if (n === 0) middle = new Array<AlignOp>(m).fill("insert");
  else if (m === 0) middle = new Array<AlignOp>(n).fill("delete");
  else {
    middle = myersMiddle(
      x.subarray(prefix, prefix + n),
      y.subarray(prefix, prefix + m),
      maxD,
      meter,
    );
  }
  if (middle === null) return null;
  const ops: AlignOp[] = new Array<AlignOp>(prefix).fill("equal");
  for (const op of middle) ops.push(op);
  for (let i = 0; i < suffix; i++) ops.push("equal");
  let distance = 0;
  for (const op of middle) if (op !== "equal") distance++;
  return { ops, distance };
}

// ---------------------------------------------------------------------------------------------
// Prose facts: README and CHANGES (design B2.1, items 4 and 5)
// ---------------------------------------------------------------------------------------------

/**
 * Which lines of the merge-base document are the original authors' (design B2.1, item 4), as one
 * flag per base line.
 *
 * For CHANGES, every line: its history is kept whole, and a new entry goes beside the old ones.
 * For the README, every line whose text is in the anchor document, the README at the first version
 * tag that is an ancestor of the merge base: every copy of that text, however many the anchor has.
 * Which copy of a repeated line is the original cannot be told from the text, and counting copies
 * would have to guess: protecting the first ones can leave the original unprotected when a later
 * copy was added above it, and its removal would then read as later text (a false pass). Protecting
 * every copy errs the other way: removing a copy added after the tag reads as an alteration, a rare
 * false fail, which is the side to err on.
 *
 * A README line is also protected when it is an original line minor-edited since the tag: the
 * anchor is aligned with the base as {@link proseFacts} aligns two sides, and inside each hunk an
 * inserted base line is protected when it is within {@link isMinorEdit} of any removed anchor line
 * of the same hunk, so a new line merged next to the edited one does not hide the edit, and one
 * anchor line can protect several base lines (a line copied and each copy edited). When the hunk
 * has more than `maxMinorPairs` removed times inserted lines, or when trying every pair would take
 * the code points of the shorter lines, summed over every hunk so tried, past
 * `maxMinorPairCodePoints`, only the k-th line from the start of each side is tried with the
 * other's k-th, and the k-th from the end with the k-th from the end: an edited line with new
 * lines on both sides of it in such a hunk is then not protected, the accepted limit. A pair whose
 * lengths alone differ by more than the bound is never computed.
 * Without this, a typo merged after the tag (a minor edit, information) would make the line later
 * text, and a second pull request could then rewrite it freely. Edits that add up past the minor
 * bound against the anchor line (several merged minor edits of one line) leave it unprotected:
 * the accepted limit, since the bound is what tells an edit of the original line from a new line.
 *
 * With no anchor (null), an anchor with no line, or an anchor too far from the base to align
 * (more than `maxEditDistance` lines apart), every base line is protected. That is the strict side,
 * and every failure to find an anchor (no tag, no README at the tag, an anchor document that could
 * not be read) falls back to it. `meter`, when given, counts the alignment's work.
 */
export function protectedMask(
  document: DocumentKind,
  base: readonly string[],
  anchor: readonly string[] | null,
  meter?: AlignMeter,
): boolean[] {
  return anchoredMask(document, base, anchor, meter).mask;
}

/**
 * {@link protectedMask}, and whether the anchor decided it: false when every base line is
 * protected for want of an anchor that could be aligned, which the facts then call `merge_base`.
 */
function anchoredMask(
  document: DocumentKind,
  base: readonly string[],
  anchor: readonly string[] | null,
  meter?: AlignMeter,
): { mask: boolean[]; anchored: boolean } {
  const everyLine = { mask: base.map(() => true), anchored: false };
  if (document === "changes" || anchor === null || anchor.length === 0) return everyLine;
  const alignment = alignLines(anchor, base, ORIGINAL_LIMITS.maxEditDistance, meter);
  if (alignment === null) return everyLine;
  const original = new Set(anchor);
  const mask = base.map((line) => original.has(line));
  const budget = { codePoints: ORIGINAL_LIMITS.maxMinorPairCodePoints };
  const { ops } = alignment;
  let a = 0;
  let b = 0;
  let at = 0;
  while (at < ops.length) {
    if (ops[at] === "equal") {
      a++;
      b++;
      at++;
      continue;
    }
    const removed: number[] = [];
    const inserted: number[] = [];
    for (; at < ops.length && ops[at] !== "equal"; at++) {
      if (ops[at] === "delete") removed.push(a++);
      else inserted.push(b++);
    }
    protectMinorEdits(anchor, base, removed, inserted, mask, budget);
  }
  return { mask, anchored: true };
}

/**
 * Within one hunk of the anchor's alignment with the base, sets `mask` for each inserted base line
 * that is a minor edit of a removed anchor line, as {@link protectedMask} states it: every pair
 * while the hunk is within `maxMinorPairs` and its pairs within what is left of `budget`, which
 * they then spend, and otherwise the pairs counted from the start and from the end. A line already
 * protected is not tried again, and a pair whose code point lengths differ by more than the bound
 * is not computed.
 */
function protectMinorEdits(
  anchor: readonly string[],
  base: readonly string[],
  removed: readonly number[],
  inserted: readonly number[],
  mask: boolean[],
  budget: { codePoints: number },
): void {
  if (removed.length === 0 || inserted.length === 0) return;
  const removedLengths = removed.map((line) => codePointLength(anchor[line] as string));
  const insertedLengths = inserted.map((line) => codePointLength(base[line] as string));
  // Whether the pair's lengths alone allow a minor edit.
  const fits = (r: number, i: number): boolean => {
    const was = removedLengths[r] as number;
    const is = insertedLengths[i] as number;
    return Math.abs(was - is) <= boundOfLonger(Math.max(was, is));
  };
  const tryPair = (r: number, i: number): void => {
    const now = inserted[i] as number;
    if (mask[now] || !fits(r, i)) return;
    if (isMinorEdit(anchor[removed[r] as number] as string, base[now] as string)) mask[now] = true;
  };
  if (removed.length * inserted.length <= ORIGINAL_LIMITS.maxMinorPairs) {
    let total = 0;
    for (let i = 0; i < inserted.length; i++) {
      for (let r = 0; r < removed.length; r++) {
        if (fits(r, i))
          total += Math.min(removedLengths[r] as number, insertedLengths[i] as number);
      }
    }
    if (total <= budget.codePoints) {
      budget.codePoints -= total;
      for (let i = 0; i < inserted.length; i++) {
        for (let r = 0; r < removed.length; r++) tryPair(r, i);
      }
      return;
    }
  }
  // With as many lines on each side, the pairs from the end are the pairs from the start.
  const shift = removed.length - inserted.length;
  const paired = Math.min(removed.length, inserted.length);
  for (let k = 0; k < paired; k++) {
    tryPair(k, k);
    if (shift !== 0) tryPair(removed.length - 1 - k, inserted.length - 1 - k);
  }
}

/**
 * What a pull request did to one document, in counts and booleans (design B2.1, item 5). A line
 * here is a normalized line (see {@link normalizeProse}); "protected" is {@link protectedMask}'s.
 * The comparison pairs lines inside a hunk, a maximal run of removed and inserted lines between two
 * kept ones: the j-th removed line with the j-th inserted line, whatever either is.
 */
export interface ProseFacts {
  document: DocumentKind;
  /**
   * Where protection came from: the first version tag's README, or every merge-base line, which is
   * also the word when the tag's README has no line or is too far from the base to align.
   */
  anchor: "first_version_tag" | "merge_base";
  /**
   * Every protected line is kept verbatim and in order: none altered, moved or minor-edited, and
   * no run of new lines between two lines of one original paragraph (`insertedInsideParagraph` is
   * 0). It says nothing of new lines placed directly before or after an original paragraph with no
   * paragraph start between, which the rendered README reads as part of that paragraph: that is
   * `joinedInsertedRuns`, which this fact does not consider.
   */
  preserved: boolean;
  /** Merge-base lines that are protected. */
  protectedLines: number;
  /** Protected lines removed, or replaced beyond a minor edit, whose text is nowhere new. */
  protectedAltered: number;
  /** Protected lines replaced by a minor edit (README only; CHANGES allows none). */
  minorEdits: number;
  /** Lines removed or replaced that are not protected: text added after the anchor. */
  laterAltered: number;
  /** Some protected line left its place and its exact text was inserted elsewhere. */
  moved: boolean;
  /** How many protected lines did so. */
  movedLines: number;
  /**
   * Runs of new lines placed inside an original paragraph: between two protected lines that were
   * adjacent in one paragraph at the base (the earlier kept, verbatim or by a minor edit), and in
   * the head joined to both: neither the run's first line nor the line after its last starts a
   * paragraph (a blank line, a heading, a list item; see {@link ProseLine.paragraphStart}). A run
   * set off on either side is not inside: joined on one side it is a joined run
   * (`joinedInsertedRuns`), on neither a new paragraph. So a section added between two lines a
   * README never separated (a heading right after its text) is an addition, not an alteration.
   */
  insertedInsideParagraph: number;
  /**
   * Runs of new head lines (lines that are not kept, and not the new text of a minor edit) that
   * sit in a head paragraph holding original text: the paragraph (consecutive head lines from one
   * that starts a paragraph to the next, new lines included; see {@link ProseLine.paragraphStart})
   * holds at least one kept protected line, verbatim or minor-edited. Each such run counts once,
   * however many original lines it touches, and wherever in the paragraph it is: directly at an
   * original line, or beyond a later line that is itself joined to one. A paragraph made only of
   * new lines is not joined. Markdown can turn an original paragraph into something that renders
   * as nothing this way (the open title of a link reference definition, a footnote definition
   * above it), which no base-side fact sees. Not part of {@link proseAltered} or `preserved`: what
   * it does is the caller's to decide.
   */
  joinedInsertedRuns: number;
  /** Lines of the head that are not kept from the base, the new text of minor edits included. */
  insertedLines: number;
  /** Both sides have line breaks, and they are not of the same kind (LF, CRLF, CR or mixed). */
  lineEndingsChanged: boolean;
  /** A part on both sides ended without a line break at the base and ends with one at the head. */
  finalNewlineAdded: boolean;
  /** The base or the head holds a part that is not UTF-8 and was read as ISO-8859-1. */
  notUtf8: boolean;
  /** Parts at the base and at the head, binary ones included. */
  partsBefore: number;
  partsAfter: number;
  /**
   * Places where new markup can hide original text, counted two ways and added together. Each run
   * of consecutive head lines that are not kept verbatim (inserted lines and the new text of minor
   * edits together) counts once when {@link hidesText} finds markup in it (it reads the run as one
   * text, so a tag split across lines is one tag), or when one of its new lines, inside an original
   * paragraph, is a footnote definition (which takes the lines after it as its text) or a link
   * definition whose next head line starts with `"`, `'` or `(` (CommonMark takes that line, and
   * every line to the closing mark, as the definition's title, which renders as nothing), or when
   * it starts with such a line right under a kept link definition. The title test is coarse, the
   * safe side: a title closed before the end of its line is none, and still counts. And each
   * minor edit counts once when its new text can hide the line it replaces
   * ({@link minorEditHides}). Wrapping original paragraphs in such markup keeps every protected
   * line verbatim or within a minor edit, so without this fact it would read as preserved. A
   * complete link definition followed by any other line, and an image line, next to an original
   * paragraph are ordinary and not counted (the definition cannot take a plain line, and cannot
   * interrupt a paragraph; an image line and the text beside it render as one visible paragraph),
   * and neither is a footnote in a paragraph of its own.
   */
  hidingMarkupInserted: number;
  /**
   * A protected line the platform showed at the base is kept, but in a part it no longer shows: a
   * new `README.md` beside the original `README` hides the original from every reader of the
   * shown README while the document, read whole, is preserved.
   * Also true when the base had a README the platform shows and the head has none it can show.
   */
  shownPartReplaced: boolean;
  /**
   * Up to `maxExamples` protected lines that were not kept, the altered ones first and then the
   * moved ones, each cut to `maxValueChars + 1` code points (so a renderer can tell it was cut)
   * without splitting a surrogate pair. Author text: for the fenced block only.
   */
  examples: string[];
}

/**
 * Elements whose content a reader of the rendered README does not see, or sees only on request:
 * named by their whole tag name, so `<s>` is not `<script>` and `<details2>` is not `<details>`.
 */
const HIDING_ELEMENTS: ReadonlySet<string> = new Set([
  "details",
  "script",
  "style",
  "template",
  "noscript",
  "textarea",
  "iframe",
  "object",
  "dialog",
  "title",
  "datalist",
  "noembed",
  "noframes",
  "video",
  "audio",
  "canvas",
  "map",
]);

/** An attribute or a style inside one tag that hides the element. */
const HIDING_ATTRIBUTE = /\bhidden\b|display\s*:\s*none/i;

/**
 * The start of a Markdown link reference definition or a GFM footnote definition: up to three
 * spaces, `[label]` or `[^label]`, and a colon. The label may be empty here, which no renderer
 * takes as a definition: the pattern errs toward flagging.
 */
const DEFINITION = /^ {0,3}\[\^?[^\]]*\]:/;

// A line that is only an image, or only a link around an image. Both patterns are the platform's
// own, ported from nemarOrg/website `src/lib/markdown.ts` (STANDALONE_IMAGE_RE, LINKED_IMAGE_RE),
// whose renderer drops such a line before rendering, so its text is never shown. Each class is a
// negated one that stops at its closing bracket, so neither can backtrack on a long line.
const STANDALONE_IMAGE = /^[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*$/;
const LINKED_IMAGE = /^[ \t]*\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)[ \t]*$/;

/** The start of a link definition's title on a line of its own: blanks, then `"`, `'` or `(`. */
const TITLE_START = /^[ \t]*["'(]/;

/** The start of a GFM footnote definition: up to three spaces, `[^label]` and a colon. */
const FOOTNOTE = /^ {0,3}\[\^[^\]]*\]:/;

/** Whether a line is a link or footnote definition, or a line the platform drops as an image. */
function definesOrIsAnImage(line: string): boolean {
  return DEFINITION.test(line) || STANDALONE_IMAGE.test(line) || LINKED_IMAGE.test(line);
}

/** The characters a minor edit may not add: with them it can wrap the line in a tag or a link. */
const WRAPPING_CHARACTERS = [0x3c, 0x3e, 0x5b, 0x5d]; // < > [ ]

/** How many of each of {@link WRAPPING_CHARACTERS} a line holds, in one pass. */
function wrappingCounts(line: string): number[] {
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < line.length; i++) {
    const at = WRAPPING_CHARACTERS.indexOf(line.charCodeAt(i));
    if (at >= 0) counts[at] = (counts[at] as number) + 1;
  }
  return counts;
}

/**
 * Whether the new text of a minor edit can hide the original line it replaces: it is a link or
 * footnote definition, or a line the platform drops as an image (see {@link definesOrIsAnImage}),
 * or the edit adds one of `<`, `>`, `[` or `]` (the new line holds more of it than the old one).
 * Three characters are within the minor bound of any line, so without this a footnote label, a
 * link destination in angle brackets, an image's brackets or a tag around the line would each make
 * an original line render as nothing and still read as a minor edit. `!`, `(` and `)` are not
 * counted: an exclamation mark or a parenthesis added to prose is the edit a minor edit is for.
 */
export function minorEditHides(before: string, after: string): boolean {
  if (definesOrIsAnImage(after)) return true;
  const was = wrappingCounts(before);
  const now = wrappingCounts(after);
  return now.some((count, at) => count > (was[at] as number));
}

/** Whether a UTF-16 code unit is an ASCII letter. */
function isAsciiLetter(unit: number): boolean {
  return (unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a);
}

/** Whether a UTF-16 code unit can continue an HTML tag name. */
function isTagNameUnit(unit: number): boolean {
  return isAsciiLetter(unit) || (unit >= 0x30 && unit <= 0x39) || unit === 0x2d;
}

/**
 * Whether a line is a link reference definition that leaves what follows to be read as part of
 * it: a title opened (`"`, `'` or `(`) and not closed on the line, or nothing at all after the
 * colon (the destination is then taken from the next line). `[x]: <> "` before an original
 * paragraph, and `"` after it, make the paragraph the title of a definition, which renders as
 * nothing.
 */
function opensLinkDefinition(line: string): boolean {
  const start = DEFINITION.exec(line);
  if (start === null) return false;
  let at = start[0].length;
  const skipBlanks = (): void => {
    while (at < line.length && (line.charCodeAt(at) === 0x20 || line.charCodeAt(at) === 0x09)) at++;
  };
  skipBlanks();
  if (at === line.length) return true;
  if (line.charCodeAt(at) === 0x3c) {
    const close = line.indexOf(">", at + 1);
    if (close < 0) return true;
    at = close + 1;
  } else {
    while (at < line.length && line.charCodeAt(at) !== 0x20 && line.charCodeAt(at) !== 0x09) at++;
  }
  skipBlanks();
  const opener = line.charAt(at);
  if (opener !== '"' && opener !== "'" && opener !== "(") return false;
  return line.indexOf(opener === "(" ? ")" : opener, at + 1) < 0;
}

/**
 * Whether a text holds HTML that can hide what it touches: the start or the end of a comment, a
 * processing instruction (`<?`), a declaration or bogus comment (`<!` and a letter) or a CDATA
 * section (`<![`), the opening or closing tag of one of {@link HIDING_ELEMENTS}, a tag carrying
 * `hidden` or `display: none`, or a tag (or a quoted attribute value inside one) left open at the
 * end of the text, which makes whatever follows part of the tag. One pass over the text: each tag
 * is read once, to its `>` outside quotes, and nothing backtracks.
 */
function markupHides(text: string): boolean {
  if (text.includes("<!--") || text.includes("-->")) return true;
  let from = 0;
  for (;;) {
    const lt = text.indexOf("<", from);
    if (lt < 0) return false;
    const next = text.charCodeAt(lt + 1);
    if (next === 0x3f) return true; // <?
    if (next === 0x21) {
      const after = text.charCodeAt(lt + 2);
      if (after === 0x5b || isAsciiLetter(after)) return true; // <![CDATA[ or <!x
      from = lt + 2;
      continue;
    }
    const closing = next === 0x2f;
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isAsciiLetter(text.charCodeAt(nameStart))) {
      from = lt + 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < text.length && isTagNameUnit(text.charCodeAt(nameEnd))) nameEnd++;
    if (HIDING_ELEMENTS.has(text.slice(nameStart, nameEnd).toLowerCase())) return true;
    let quote = 0;
    let end = nameEnd;
    for (; end < text.length; end++) {
      const unit = text.charCodeAt(end);
      if (quote !== 0) {
        if (unit === quote) quote = 0;
      } else if (unit === 0x22 || unit === 0x27) quote = unit;
      else if (unit === 0x3e) break;
    }
    if (end >= text.length) return true;
    if (!closing && HIDING_ATTRIBUTE.test(text.slice(lt, end))) return true;
    from = end + 1;
  }
}

/**
 * Whether a run of consecutive new lines holds markup that can hide text: a link reference
 * definition left open on one of its lines ({@link opensLinkDefinition}), or HTML that hides in the
 * run read as one text, its lines joined by a space ({@link markupHides}), so a tag split across
 * lines (`<div` then `hidden>`) is read as the one tag it is. Inline code is read like any text:
 * telling a code span from live HTML takes a whole CommonMark parse (an escaped backtick, a
 * backtick pair across a line break or inside an attribute leaves the markup live), so what looks
 * like markup is flagged even between backticks, the safe side. The cost: a `<` before a letter
 * with no `>` after it in a new run (`a<b`, in prose or in code) holds the pull request as unknown
 * for a person; `p < 0.05` and closed tags (`<label>`, `List<String>`) do not. One pass over the
 * run, whatever it holds.
 */
export function hidesText(run: readonly string[]): boolean {
  return run.some(opensLinkDefinition) || markupHides(run.join(" "));
}

/** At most `maxValueChars + 1` code points of a line, never half a surrogate pair. */
function cutExample(text: string): string {
  const max = SUMMARY_LIMITS.maxValueChars + 1;
  let end = 0;
  for (let points = 0; end < text.length && points < max; points++) {
    end += (text.codePointAt(end) as number) > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}

/**
 * The facts of one document (design B2.1), from its parts at the merge base, at the head, and at
 * the anchor (the first version tag; null when there is none). Either side may have no part at all:
 * a README added is all insertion, one removed all removal.
 *
 * Both sides are assembled (a part unchanged between them may be binary, see {@link
 * assembleDocument}) and aligned; a refusal of either side, or an alignment over the cap, is the
 * refusal, never a partial result. The anchor matters only for the README, and an anchor document
 * that cannot be read, has no part, or has no line protects every merge-base line instead.
 *
 * Inside each hunk the j-th removed line is paired with the j-th inserted line. A removed protected
 * line is a minor edit when its partner is within {@link isMinorEdit} (README only); otherwise it
 * is `moved` when its exact text is among the inserted lines of the document not yet taken (each
 * taken once, by the protected lines in base order, after the minor edits took theirs), and
 * `protectedAltered` when it is not. A run of extra inserted lines (past the last pair of a hunk)
 * is `insertedInsideParagraph` when the base lines on either side of it are protected, the later
 * one does not start a paragraph at the base, the earlier one is kept verbatim or by a minor edit,
 * and in the head neither the run's first line nor the line after the run starts a paragraph: the
 * run is read inside the paragraph only when nothing sets it off on either side (a blank line, a
 * heading, a list item).
 *
 * The part the platform shows is the first of `README_CANDIDATES` present, compared with exact case
 * as git stores names, while the document's own names are matched without regard to case: a
 * `readme.md` is in the document but is never the shown part. When no part of a side is a
 * candidate, every part of that side counts as shown: a candidate added beside a base that had none
 * hides every original part it does not hold. But a base that HAD a shown README and a head that
 * has none (a `README.md` renamed `readme.md` or `README.MD`) has lost it, whatever the text: the
 * fact is true.
 */
export function proseFacts(input: {
  document: DocumentKind;
  base: readonly DocumentPart[];
  head: readonly DocumentPart[];
  anchor: readonly DocumentPart[] | null;
}): { ok: true; facts: ProseFacts } | { ok: false; refusal: ProseRefusal } {
  const { document } = input;
  const readme = document === "readme";
  const baseOids = new Set(input.base.map((part) => part.oid));
  const skip = new Set(input.head.map((part) => part.oid).filter((oid) => baseOids.has(oid)));
  const baseRead = assembleDocument(document, input.base, skip);
  if (!baseRead.ok) return { ok: false, refusal: baseRead.refusal };
  const headRead = assembleDocument(document, input.head, skip);
  if (!headRead.ok) return { ok: false, refusal: headRead.refusal };
  let anchorLines: string[] | null = null;
  if (readme && input.anchor !== null && input.anchor.length > 0) {
    const anchorRead = assembleDocument(document, input.anchor, skip);
    // An anchor with no line at all (empty, or only blank lines) protects nothing it could name,
    // so it is treated as no anchor: every merge-base line is protected.
    if (anchorRead.ok && anchorRead.value.lines.length > 0) {
      anchorLines = anchorRead.value.lines.map((line) => line.text);
    }
  }
  const base = baseRead.value.lines;
  const head = headRead.value.lines;
  const { mask: isProtected, anchored } = anchoredMask(
    document,
    base.map((line) => line.text),
    anchorLines,
  );
  const alignment = alignLines(
    base.map((line) => line.text),
    head.map((line) => line.text),
  );
  if (alignment === null) return { ok: false, refusal: "edit_distance_cap" };

  const kept = new Array<boolean>(base.length).fill(false); // verbatim or by a minor edit
  const pairs: [number, number][] = []; // base and head index of every line kept
  const takenByMinor = new Set<number>();
  const inserted: number[] = [];
  const pending: number[] = []; // removed protected lines that are not minor edits, in base order
  let minorEdits = 0;
  let laterAltered = 0;
  let insertedInsideParagraph = 0;
  const { ops } = alignment;
  let i = 0;
  let j = 0;
  let at = 0;
  while (at < ops.length) {
    if (ops[at] === "equal") {
      kept[i] = true;
      pairs.push([i, j]);
      i++;
      j++;
      at++;
      continue;
    }
    const before = i - 1;
    const removedHere: number[] = [];
    const insertedHere: number[] = [];
    for (; at < ops.length && ops[at] !== "equal"; at++) {
      if (ops[at] === "delete") removedHere.push(i++);
      else insertedHere.push(j++);
    }
    for (const line of insertedHere) inserted.push(line);
    removedHere.forEach((removed, k) => {
      if (!isProtected[removed]) {
        laterAltered++;
        return;
      }
      const partner = insertedHere[k];
      const baseText = (base[removed] as ProseLine).text;
      if (
        readme &&
        partner !== undefined &&
        isMinorEdit(baseText, (head[partner] as ProseLine).text)
      ) {
        minorEdits++;
        kept[removed] = true;
        pairs.push([removed, partner]);
        takenByMinor.add(partner);
        return;
      }
      pending.push(removed);
    });
    if (insertedHere.length > removedHere.length) {
      const earlier =
        removedHere.length > 0 ? (removedHere[removedHere.length - 1] as number) : before;
      const after = i;
      // The run's first line in the head, and the head line after the run: the kept line `after`.
      const firstExtra = insertedHere[removedHere.length] as number;
      if (
        earlier >= 0 &&
        after < base.length &&
        isProtected[earlier] &&
        isProtected[after] &&
        !(base[after] as ProseLine).paragraphStart &&
        kept[earlier] &&
        !(head[firstExtra] as ProseLine).paragraphStart &&
        !(head[j] as ProseLine).paragraphStart
      ) {
        insertedInsideParagraph++;
      }
    }
  }

  const pool = new Map<string, number>();
  for (const line of inserted) {
    if (takenByMinor.has(line)) continue;
    const text = (head[line] as ProseLine).text;
    pool.set(text, (pool.get(text) ?? 0) + 1);
  }
  const altered: string[] = [];
  const moved: string[] = [];
  for (const removed of pending) {
    const text = (base[removed] as ProseLine).text;
    const left = pool.get(text) ?? 0;
    if (left > 0) {
      pool.set(text, left - 1);
      moved.push(text);
    } else altered.push(text);
  }

  let shownPartReplaced = false;
  if (readme) {
    const shownBase = firstReadme(input.base.map((part) => part.name));
    const shownHead = firstReadme(input.head.map((part) => part.name));
    const shown = (name: string | null, part: string): boolean => name === null || part === name;
    // A README the platform showed, and none it can show now (`README.md` renamed `readme.md`).
    const shownLost = shownBase !== null && shownHead === null;
    shownPartReplaced =
      shownLost ||
      pairs.some(
        ([b, h]) =>
          isProtected[b] &&
          shown(shownBase, (base[b] as ProseLine).part) &&
          !shown(shownHead, (head[h] as ProseLine).part),
      );
  }
  let finalNewlineAdded = false;
  for (const [name, ends] of baseRead.value.finalBreak) {
    if (!ends && headRead.value.finalBreak.get(name) === true) finalNewlineAdded = true;
  }
  const beforeBreaks = baseRead.value.breaks;
  const afterBreaks = headRead.value.breaks;
  const protectedAltered = altered.length;
  const movedLines = moved.length;
  // Head lines by what they are: kept protected lines (verbatim or by a minor edit) and lines not
  // kept, which are the inserted lines and the new text of minor edits.
  const keptProtected = new Set<number>();
  for (const [b, h] of pairs) if (isProtected[b]) keptProtected.add(h);
  const notKept = new Set(inserted);
  // Maximal runs of consecutive head lines that `member` holds, cut at every paragraph start too
  // when `byParagraph`, so that each run then lies in one paragraph.
  const runsOf = (member: (line: number) => boolean, byParagraph = false): [number, number][] => {
    const runs: [number, number][] = [];
    let start = -1;
    for (let line = 0; line <= head.length; line++) {
      const inRun = line < head.length && member(line);
      if (start >= 0 && (!inRun || (byParagraph && startsParagraph(line)))) {
        runs.push([start, line - 1]);
        start = -1;
      }
      if (inRun && start < 0) start = line;
    }
    return runs;
  };
  const startsParagraph = (line: number): boolean => (head[line] as ProseLine).paragraphStart;
  // The head's paragraphs: one starts at every line that starts a paragraph (the first line of a
  // part among them), and one is an original paragraph when it holds a kept protected line. A new
  // line in such a paragraph is attached to the original text, which renders as one block with it.
  const paragraphOf = new Int32Array(head.length);
  const holdsOriginal: boolean[] = [];
  for (let line = 0; line < head.length; line++) {
    if (line === 0 || startsParagraph(line)) holdsOriginal.push(false);
    paragraphOf[line] = holdsOriginal.length - 1;
    if (keptProtected.has(line)) holdsOriginal[holdsOriginal.length - 1] = true;
  }
  const attached = (line: number): boolean => holdsOriginal[paragraphOf[line] as number] === true;
  const isNew = (line: number): boolean => notKept.has(line) && !takenByMinor.has(line);
  // A line a link definition right above it would take as its title: no blank line between, and
  // an opening quote or parenthesis first. Read coarsely, the safe side: a title closed before the
  // end of its line (`(Smith 2020) found`) is no title, and still counts.
  const isTitle = (line: number): boolean => {
    const at = head[line];
    return at !== undefined && !at.paragraphStart && TITLE_START.test(at.text);
  };
  const isDefinition = (line: number): boolean =>
    head[line] !== undefined && DEFINITION.test((head[line] as ProseLine).text);
  // A run of lines not kept hides when its markup does, or, inside an original paragraph, when one
  // of its new lines is a footnote definition or a link definition a title line follows, or when
  // it starts with a title line under a kept link definition; a minor edit hides on its own.
  const hidingRuns = runsOf((line) => notKept.has(line)).filter(([first, last]) => {
    if (hidesText(head.slice(first, last + 1).map((line) => line.text))) return true;
    if (attached(first) && isTitle(first) && isDefinition(first - 1)) return true;
    for (let line = first; line <= last; line++) {
      if (!isNew(line) || !attached(line)) continue;
      const text = (head[line] as ProseLine).text;
      if (FOOTNOTE.test(text) || (isDefinition(line) && isTitle(line + 1))) return true;
    }
    return false;
  }).length;
  const hidingMinorEdits = pairs.filter(
    ([b, h]) =>
      takenByMinor.has(h) &&
      minorEditHides((base[b] as ProseLine).text, (head[h] as ProseLine).text),
  ).length;
  const hidingMarkupInserted = hidingRuns + hidingMinorEdits;
  const joinedInsertedRuns = runsOf(isNew, true).filter(([first]) => attached(first)).length;
  return {
    ok: true,
    facts: {
      document,
      anchor: anchored ? "first_version_tag" : "merge_base",
      preserved:
        protectedAltered === 0 &&
        movedLines === 0 &&
        insertedInsideParagraph === 0 &&
        minorEdits === 0,
      protectedLines: isProtected.filter(Boolean).length,
      protectedAltered,
      minorEdits,
      laterAltered,
      moved: movedLines > 0,
      movedLines,
      insertedInsideParagraph,
      joinedInsertedRuns,
      insertedLines: inserted.length,
      lineEndingsChanged:
        beforeBreaks !== "none" && afterBreaks !== "none" && beforeBreaks !== afterBreaks,
      finalNewlineAdded,
      notUtf8: baseRead.value.notUtf8 || headRead.value.notUtf8,
      partsBefore: input.base.length,
      partsAfter: input.head.length,
      hidingMarkupInserted,
      shownPartReplaced,
      examples: [...altered, ...moved].slice(0, ORIGINAL_LIMITS.maxExamples).map(cutExample),
    },
  };
}

/**
 * Whether the facts of a document are an alteration of the original authors' text: the one
 * definition of the trigger the platform fails a review on. A protected line altered or moved
 * fails either document; a line inserted inside an original paragraph fails only the README,
 * because CHANGES takes a new entry anywhere. Minor edits, later text and the tripwire facts are
 * not alterations here; the caller decides what the tripwires do.
 */
export function proseAltered(facts: ProseFacts): boolean {
  return (
    facts.protectedAltered > 0 ||
    facts.moved ||
    (facts.document === "readme" && facts.insertedInsideParagraph > 0)
  );
}

// ---------------------------------------------------------------------------------------------
// Author fields of the dataset description (design B2.2)
// ---------------------------------------------------------------------------------------------

/**
 * The top-level keys of `dataset_description.json` that the original authors own (design B1), in
 * the order every list of them is written. A closed list of names, none with an underscore, so a
 * fact naming them can go into a note. The tool-managed keys (`BIDSVersion`, `GeneratedBy` and the
 * like) are Part A's to show and are not here, and neither is anything below the top level.
 */
export const AUTHOR_OWNED_KEYS = [
  "Name",
  "Authors",
  "License",
  "ReferencesAndLinks",
  "Funding",
  "Acknowledgements",
  "HowToAcknowledge",
  "DatasetDOI",
  "EthicsApprovals",
] as const;
export type AuthorOwnedKey = (typeof AUTHOR_OWNED_KEYS)[number];

/**
 * The author-owned keys whose strings may take a minor edit (a typo fixed in a grant number or a
 * link). `Name`, `Authors`, `License` and `DatasetDOI` take none: one character of a license or a
 * DOI is a different license or a different DOI, and an author's name is theirs.
 */
export const MINOR_EDIT_KEYS: readonly AuthorOwnedKey[] = [
  "Funding",
  "Acknowledgements",
  "HowToAcknowledge",
  "EthicsApprovals",
  "ReferencesAndLinks",
];

/**
 * The author-owned keys whose value BIDS writes as an array. Only these can grow, and only for
 * these is a lone string read as the array of that one string, so `"Ada"` that became `["Ada",
 * "Alan"]` has grown. The others (`Name`, `License`, `DatasetDOI`, `Acknowledgements`,
 * `HowToAcknowledge`) hold one value: any change between two values that are not missing is altered
 * (an array that gained an element, a changed type, `"CC0"` that became `["CC0", "CC-BY-NC-4.0"]`),
 * except a minor edit of a string for the two of them that take one.
 */
export const ARRAY_VALUED_KEYS: readonly AuthorOwnedKey[] = [
  "Authors",
  "Funding",
  "EthicsApprovals",
  "ReferencesAndLinks",
];

/**
 * What a pull request did to the author-owned keys, each list in {@link AUTHOR_OWNED_KEYS} order.
 */
export interface AuthorFieldFacts {
  /** Keys changed beyond what design B1 permits. */
  altered: AuthorOwnedKey[];
  /** Keys that held a value and hold none now: deleted, or emptied to a missing value. */
  removed: AuthorOwnedKey[];
  /** Keys with a string, or an array element, changed by a minor edit (permitted). */
  minor: AuthorOwnedKey[];
  /**
   * Arrays whose old elements are all kept, in order, at the start, with new ones after
   * (permitted).
   */
  grown: AuthorOwnedKey[];
  /** Keys that held no value and hold one now (permitted). */
  added: AuthorOwnedKey[];
  /** One side could not be read, did not parse, or is not a JSON object: unknown, never clean. */
  unparsed: boolean;
}

/**
 * One side of the dataset description: its bytes, no file at all, or bytes that could not be read.
 */
export type DescriptionSide = Uint8Array | "absent" | "unreadable";

/** The top-level members of a side, empty when there is no file, null when they cannot be known. */
function descriptionKeys(side: DescriptionSide): ReadonlyMap<string, JsonValue> | null {
  if (side === "absent") return new Map();
  if (side === "unreadable") return null;
  const parsed = parseJson(side);
  if (!parsed.ok || parsed.value.value.t !== "obj") return null;
  return parsed.value.value.v;
}

/**
 * A key that is not there, or holds a missing value (`isMissingJson`: null, `""`, `[]`, `[""]`...).
 */
function holdsNothing(value: JsonValue | undefined): boolean {
  return value === undefined || isMissingJson(value);
}

/**
 * What changed in one author-owned key: nothing, or the lists of {@link AuthorFieldFacts} it joins.
 */
function fieldChange(
  key: AuthorOwnedKey,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): ("altered" | "removed" | "minor" | "grown" | "added")[] {
  if (holdsNothing(before)) return holdsNothing(after) ? [] : ["added"];
  if (holdsNothing(after)) return ["removed"];
  const was = before as JsonValue;
  const now = after as JsonValue;
  if (canonicalJson(was) === canonicalJson(now)) return [];
  const minorAllowed = MINOR_EDIT_KEYS.includes(key);
  const compare = (x: JsonValue, y: JsonValue): "same" | "minor" | "different" => {
    if (canonicalJson(x) === canonicalJson(y)) return "same";
    if (minorAllowed && x.t === "str" && y.t === "str" && isMinorEdit(x.v, y.v)) return "minor";
    return "different";
  };
  if (was.t === "str" && now.t === "str") {
    return compare(was, now) === "minor" ? ["minor"] : ["altered"];
  }
  // Only an array-valued key can grow; any other change of a scalar field is altered.
  if (!ARRAY_VALUED_KEYS.includes(key)) return ["altered"];
  // For an array-valued key a lone string beside an array is read as the array of that one string,
  // so a string that became a list starting with it has grown. Missing elements are dropped on both
  // sides first, so a placeholder `""` removed or added is no change.
  const elements = (v: JsonValue): JsonValue[] | null =>
    v.t === "arr" ? v.v.filter((item) => !isMissingJson(item)) : v.t === "str" ? [v] : null;
  const old = elements(was);
  const fresh = elements(now);
  if (old === null || fresh === null || old.length > fresh.length) return ["altered"];
  let minor = false;
  for (let i = 0; i < old.length; i++) {
    const verdict = compare(old[i] as JsonValue, fresh[i] as JsonValue);
    if (verdict === "different") return ["altered"];
    if (verdict === "minor") minor = true;
  }
  const out: ("grown" | "minor")[] = [];
  if (fresh.length > old.length) out.push("grown");
  if (minor) out.push("minor");
  return out;
}

/**
 * The facts of the author-owned keys of `dataset_description.json` (design B2.2) between the merge
 * base and the head. Both sides go through Part A's strict parser; a side that cannot be read, does
 * not parse, or is not an object gives `unparsed` with every list empty, which the caller treats as
 * unknown and never as clean.
 *
 * Per key, "missing" is a key that is absent or holds a missing value: missing to missing is no
 * change (`[""]` to `[]`); missing to a value is `added`; a value to missing is `removed`; an equal
 * value is no change. Two strings are `minor` when the key is one of {@link MINOR_EDIT_KEYS} and
 * the edit is within {@link isMinorEdit}, and `altered` otherwise. Two arrays, with missing
 * elements dropped, must start with every old element in order (equal, or a minor edit for a
 * minor-edit key): then the key is `grown` when new elements follow, and `minor` when an element
 * took a minor edit; anything else is `altered`, so an author list reordered, or an author inserted
 * before an old one, is altered, and one appended is grown. Arrays, growth and a string read as an
 * array of one are for {@link ARRAY_VALUED_KEYS} only: for every other key any change but a minor
 * edit of a string (where the key takes one) is `altered`. Every other change is `altered`.
 */
export function authorFieldFacts(
  before: DescriptionSide,
  after: DescriptionSide,
): AuthorFieldFacts {
  const facts: AuthorFieldFacts = {
    altered: [],
    removed: [],
    minor: [],
    grown: [],
    added: [],
    unparsed: false,
  };
  const was = descriptionKeys(before);
  const now = descriptionKeys(after);
  if (was === null || now === null) return { ...facts, unparsed: true };
  for (const key of AUTHOR_OWNED_KEYS) {
    for (const list of fieldChange(key, was.get(key), now.get(key))) facts[list].push(key);
  }
  return facts;
}

/**
 * Whether the facts are an alteration of what the authors published: a key altered or removed.
 * Unparsed facts are not an alteration here; they are unknown, which is the caller's to say.
 */
export function authorFieldsAltered(facts: AuthorFieldFacts): boolean {
  return facts.altered.length > 0 || facts.removed.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Recordings: annexed content that changed (design B2.4)
// ---------------------------------------------------------------------------------------------

/**
 * What the caller read of one side of a changed path to tell whether git-annex holds its content:
 * the blob's bytes when the blob is no longer than `pointerMaxBytes` (a symlink target, or an
 * unlocked pointer, is far shorter), `large` when it is longer (a recording of gigabytes is never
 * fetched, and a blob over the bound cannot be a pointer), or `unreadable` when the caller tried
 * and could not read it. A failed read is never `large`: one is a fact about the blob and the other
 * is a fact about the caller, and only the first lets a path be called plain git content.
 */
export type PointerProbe = Uint8Array | "large" | "unreadable";

/**
 * The top-level directories the review leaves out: changes below them are not read and not
 * summarized (design section 14, "Deliberately out of scope"). One list, for this module, the
 * set A reader and their tests, so the scope is never written twice.
 */
export const REVIEW_LEFT_OUT_DIRS = ["sourcedata", "derivatives", "code"] as const;

/** Whether a path is in the reviewed scope: not below one of {@link REVIEW_LEFT_OUT_DIRS}. */
export function inReviewedScope(path: string): boolean {
  return !REVIEW_LEFT_OUT_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

/**
 * One changed path as `git diff --raw` names it (the fields of `RawEntry` in the evidence module,
 * which this module never imports; the shapes are compared by the compiler where they meet), with
 * what the caller knows about it: whether the path is in the recordings area of the annex policy,
 * and the probe of each side that exists (null for a side that does not: `before` of an added path,
 * `after` of a removed one).
 */
export interface RecordingChange {
  path: string;
  status: "added" | "modified" | "removed" | "typechange";
  modeBefore: string;
  modeAfter: string;
  oidBefore: string;
  oidAfter: string;
  /**
   * The path is in the recordings area. Entered by the caller so this module never imports the
   * policy.
   */
  recordingArea: boolean;
  /**
   * The path is in the reviewed scope, {@link inReviewedScope} of the path: not below one of {@link
   * REVIEW_LEFT_OUT_DIRS}. A replacement or a type change counts only here; a key moved and a side
   * that could not be read count wherever the path is. Entered by the caller, which passes every
   * changed path, so a key that left `derivatives/` for the raw tree is still seen to move. This is
   * NOT the evidence module's `READABLE_AREAS`, the narrower set of areas whose files the review
   * reads in full: a recording is in the reviewed scope and is never read in full.
   */
  inReviewedScope: boolean;
  before: PointerProbe | null;
  after: PointerProbe | null;
}

/**
 * What one side of a changed path is: content git-annex holds under a key (`annexed`), a regular
 * file git holds itself (`git`), a symbolic link that is not an annex link (`link`), anything else,
 * a submodule above all (`other`), or a side whose bytes could not be read (`unreadable`).
 */
export type AnnexSide =
  | { kind: "annexed"; key: string }
  | { kind: "git" }
  | { kind: "link" }
  | { kind: "other" }
  | { kind: "unreadable" };

/**
 * The shape of a git-annex key: a backend name, optional `-s<size>`-style fields, `--`, then the
 * rest of the name. Applied to the LAST component of a link target or a pointer line, so what a key
 * is does not depend on how many directories sit above it.
 */
const ANNEX_KEY = /^[A-Z0-9]+(-[A-Za-z][0-9]+)*--[^/]+$/;

/** What git-annex looks for in a link target or in the first line of a pointer. */
const OBJECTS_INFIX = "/annex/objects/";

/** Whether a string holds a control character: U+0000 to U+001F, or U+007F. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** The text of bytes when they are strict UTF-8, else null: a malformed byte is never replaced. */
function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The key a link target's or a pointer's first line names, or null: the line (without its line
 * break and one carriage return before it) must hold `/annex/objects/` anywhere, as git-annex
 * requires, so `annex/objects/KEY` with no slash before it is no annex path, and its last
 * component must have the shape of a key and hold no control character. git-annex itself accepts a
 * NUL or a carriage return inside a key; no recording has one, and reading such a key as no key
 * reports the side as a plain file, which flags the change, never hides it.
 */
function keyOfLine(raw: string): string | null {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (!line.includes(OBJECTS_INFIX)) return null;
  const name = line.slice(line.lastIndexOf("/") + 1);
  return ANNEX_KEY.test(name) && !hasControlCharacter(name) ? name : null;
}

/**
 * The key of an annex symlink, or null when the target (the probe, decoded as strict UTF-8) is not
 * one, by git-annex's own reading: one line, a final line break allowed but nothing after it, read
 * by {@link keyOfLine}. Only the last component is the key: a link that gained or lost a `../` is
 * the same object.
 */
function linkKey(bytes: Uint8Array): string | null {
  const target = strictUtf8(bytes);
  if (target === null) return null;
  const lf = target.indexOf("\n");
  if (lf >= 0 && lf !== target.length - 1) return null;
  return keyOfLine(lf >= 0 ? target.slice(0, lf) : target);
}

/**
 * The key of an unlocked annex pointer, or null when the bytes are not one, by git-annex's own
 * reading: the WHOLE blob must be the pointer. Its first line is read by {@link keyOfLine}, and
 * every line after it must hold `/annex/`. So a pointer with data appended (a table's rows after
 * it) is plain content, never the recording it once pointed at.
 */
function pointerKey(bytes: Uint8Array): string | null {
  const text = strictUtf8(bytes);
  if (text === null) return null;
  const lf = text.indexOf("\n");
  if (lf < 0) return keyOfLine(text);
  const rest = text.slice(lf + 1).split("\n");
  if (rest[rest.length - 1] === "") rest.pop();
  if (!rest.every((line) => line.includes("/annex/"))) return null;
  return keyOfLine(text.slice(0, lf));
}

/**
 * What one side of a changed path is (design B2.4), from its git mode and its probe. A submodule
 * (160000) has no blob to read and is `other` whatever the probe says. A probe of `unreadable` is
 * `unreadable`, for every other mode. A symlink (120000) is `annexed` when its target is an annex
 * link ({@link linkKey}), else `link`; a regular file (100644, 100755) is `annexed` when it is an
 * unlocked pointer ({@link pointerKey}), else `git`; every other mode is `other`. A probe of
 * `large` (or bytes over `pointerMaxBytes`, which a caller should have sent as `large`) is not an
 * annex link and not a pointer, and nothing is decoded: a symlink is then a `link` and a regular
 * file `git`. The bytes are never trusted past the key grammar, so NUL, a newline or a megabyte of
 * text in a target gives a `link` or `git` side and never a key.
 */
export function annexSide(mode: string, probe: PointerProbe): AnnexSide {
  if (mode === "160000") return { kind: "other" };
  if (probe === "unreadable") return { kind: "unreadable" };
  const symlink = mode === "120000";
  if (!symlink && !REGULAR_MODE.test(mode)) return { kind: "other" };
  const bytes = probe === "large" || probe.length > ORIGINAL_LIMITS.pointerMaxBytes ? null : probe;
  const key = bytes === null ? null : symlink ? linkKey(bytes) : pointerKey(bytes);
  if (key !== null) return { kind: "annexed", key };
  return { kind: symlink ? "link" : "git" };
}

/** What a pull request did to recorded content, in counts (design B2.4). */
export interface RecordingFacts {
  /**
   * Annexed content whose key changed, or a recordings-area path that is not annexed and changed
   * its content, its link target or its kind.
   */
  replaced: number;
  /** A path annexed on one side and not on the other: annexed to git, to a link, or the reverse. */
  typeChanged: number;
  /** A removed annexed key found again, key for key, at an added path (one added path per key). */
  moved: number;
}

/**
 * The facts of the recordings a pull request touched (design B2.4; whether a side is annexed is
 * decided by what the side is, never by the area of its path or by the status `typechange`). Each
 * changed path is read as two sides ({@link annexSide}; a null probe is a side that does not
 * exist). Every fact is a count, and moves are matched over a multiset of keys, so the order the
 * caller lists the paths in changes nothing. The caller passes every changed path. For a path that
 * exists on both sides and is in the reviewed scope (`inReviewedScope`):
 *
 * - both annexed, with different keys: `replaced`; with the same key (a locked link made an
 *   unlocked pointer, or a link whose `../` depth changed): nothing;
 * - annexed on one side only: `typeChanged`, decided by what each side IS and not by the status
 *   `typechange`, so an unlocked pointer replaced by its content (status modified) counts;
 * - neither annexed: inside the recordings area, `replaced` when the side changed kind (a git file
 *   made a plain link or a submodule, or the reverse) or its blob id (new content, a link with a
 *   new target, a submodule at a new commit); a mode alone changing is nothing; outside the
 *   recordings area, nothing.
 *
 * Below `sourcedata/`, `derivatives/` or `code/` a path on both sides is no fact at all: the review
 * does not read those areas, and what changed there is not what the authors recorded.
 *
 * A removed path that was annexed, matched against the added annexed paths with the same key (a
 * multiset, one added path consumed per match), is `moved`, and a matched path is counted as
 * nothing else. The match runs over every path given, whatever its area: a pointer moved with its
 * key is the same recording wherever it went, so a set of links moved from `derivatives/` into the
 * raw tree is `moved`, and not an unexplained addition. An unmatched removal or addition is Part
 * A's loss fact, not a recording fact.
 *
 * A path with an `unreadable` side, in any area, adds 1 to `unread` (once, whether one side or
 * both) and nothing else: it is unknown, never clean, and the caller says what unknown does.
 */
export function recordingFacts(
  changes: readonly RecordingChange[],
): RecordingFacts & { unread: number } {
  const facts = { replaced: 0, typeChanged: 0, moved: 0, unread: 0 };
  const removedKeys: string[] = [];
  const addedKeys = new Map<string, number>();
  for (const change of changes) {
    const was = change.before === null ? null : annexSide(change.modeBefore, change.before);
    const now = change.after === null ? null : annexSide(change.modeAfter, change.after);
    if (was?.kind === "unreadable" || now?.kind === "unreadable") {
      facts.unread++;
      continue;
    }
    if (was === null || now === null) {
      if (was?.kind === "annexed") removedKeys.push(was.key);
      if (now?.kind === "annexed") addedKeys.set(now.key, (addedKeys.get(now.key) ?? 0) + 1);
      continue;
    }
    if (!change.inReviewedScope) continue;
    if (was.kind === "annexed" && now.kind === "annexed") {
      if (was.key !== now.key) facts.replaced++;
    } else if (was.kind === "annexed" || now.kind === "annexed") {
      facts.typeChanged++;
    } else if (
      change.recordingArea &&
      (was.kind !== now.kind || change.oidBefore !== change.oidAfter)
    ) {
      facts.replaced++;
    }
  }
  for (const key of removedKeys) {
    const left = addedKeys.get(key) ?? 0;
    if (left === 0) continue;
    addedKeys.set(key, left - 1);
    facts.moved++;
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------
// Provenance: which version tag anchors what is original (design B3)
// ---------------------------------------------------------------------------------------------

/**
 * A version tag of the dataset repository: its name (`v1.2.3`, the digits as written), its three
 * numbers as the digit strings written (a version number is arbitrarily long, so none is ever
 * converted to a `Number`), and the commit it points at: the peeled commit of an annotated tag, or
 * the commit a lightweight tag names.
 */
export interface VersionTag {
  name: string;
  version: [string, string, string];
  commit: string;
}

/** One line of `git ls-remote --tags`: an id, a tab, and a `v<major>.<minor>.<patch>` tag ref. */
const TAG_LINE = /^([0-9a-f]{40})\trefs\/tags\/v(\d+)\.(\d+)\.(\d+)(\^\{\})?$/;

/** The digits of a number without its leading zeros (but never fewer than one digit). */
function significantDigits(digits: string): string {
  let start = 0;
  while (start < digits.length - 1 && digits.charCodeAt(start) === 0x30) start++;
  return start === 0 ? digits : digits.slice(start);
}

/** Two numbers written in digits, by value: the longer is the larger, then digit by digit. */
function compareDigits(a: string, b: string): number {
  const x = significantDigits(a);
  const y = significantDigits(b);
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ascending by (major, minor, patch) by value, then by name in code-unit order. */
function compareVersionTags(a: VersionTag, b: VersionTag): number {
  for (let i = 0; i < 3; i++) {
    const order = compareDigits(a.version[i] as string, b.version[i] as string);
    if (order !== 0) return order;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The version tags in the text `git ls-remote --tags` wrote, lowest version first (design B3). A
 * line counts only if it is exactly a 40-hex id, a tab and `refs/tags/v<n>.<n>.<n>`, with the
 * peeled suffix `^{}` allowed; everything else is ignored: a pre-release (`v1.0.0-rc1`), a capital
 * `V`, a 64-hex id, a ref that is not a tag, a line with a carriage return, a blank line. The
 * commit of a tag is its peeled id when the listing has one, else its plain id. A name that the
 * listing gives two different plain ids, or two different peeled ids, is not one tag the platform
 * can name a commit of and is dropped. Versions compare by value, so `v1.10.0` is above `v1.9.0`,
 * and as digit strings with no limit on their length (`v1.02.3` and `v1.2.3` are one version, told
 * apart by name).
 */
export function parseVersionTags(lsRemote: string): VersionTag[] {
  const seen = new Map<
    string,
    { version: [string, string, string]; plain: Set<string>; peeled: Set<string> }
  >();
  for (const line of lsRemote.split("\n")) {
    const match = TAG_LINE.exec(line);
    if (match === null) continue;
    const id = match[1] as string;
    const major = match[2] as string;
    const minor = match[3] as string;
    const patch = match[4] as string;
    const peeledLine = match[5] !== undefined;
    const name = `v${major}.${minor}.${patch}`;
    let entry = seen.get(name);
    if (entry === undefined) {
      entry = { version: [major, minor, patch], plain: new Set(), peeled: new Set() };
      seen.set(name, entry);
    }
    (peeledLine ? entry.peeled : entry.plain).add(id);
  }
  const tags: VersionTag[] = [];
  for (const [name, { version, plain, peeled }] of seen) {
    if (plain.size > 1 || peeled.size > 1) continue;
    const commit = [...peeled, ...plain][0];
    if (commit !== undefined) tags.push({ name, version, commit });
  }
  return tags.sort(compareVersionTags);
}

/**
 * Where protection comes from (design B3): the lowest version tag whose commit is an ancestor of
 * the merge base, or the merge base itself with the reason there was no tag to use:
 *
 * - `no_tag`: the listing holds no version tag;
 * - `no_ancestor`: every tag was tried and none is an ancestor of the merge base;
 * - `check_failed`: the ancestor check could not be answered for a tag (it errored, or timed out);
 * - `too_many_tags`: `maxTagsTried` tags were tried and none was an ancestor.
 */
export type AnchorChoice =
  | { anchor: "first_version_tag"; tag: VersionTag; commit: string }
  | { anchor: "merge_base"; reason: "no_tag" | "no_ancestor" | "check_failed" | "too_many_tags" };

/**
 * The anchor for a set of version tags, trying them lowest first (the order is decided here, not
 * trusted from the caller). `isAncestor` answers for a tag's commit: true chooses that tag, false
 * moves on to the next, and null, the check could NOT be answered, stops the search with
 * `merge_base` and `check_failed`. A null is never read as "not an ancestor": that would move on to
 * a later, higher tag, and a failed check would then silently protect less of the README. At most
 * `maxTagsTried` tags are tried; past them the answer is `too_many_tags`, so a repository with
 * thousands of tags costs a bounded number of checks.
 */
export function chooseAnchor(
  tags: readonly VersionTag[],
  isAncestor: (commit: string) => boolean | null,
): AnchorChoice {
  if (tags.length === 0) return { anchor: "merge_base", reason: "no_tag" };
  const ordered = [...tags].sort(compareVersionTags);
  for (let tried = 0; tried < ordered.length; tried++) {
    if (tried >= ORIGINAL_LIMITS.maxTagsTried) {
      return { anchor: "merge_base", reason: "too_many_tags" };
    }
    const tag = ordered[tried] as VersionTag;
    const answer = isAncestor(tag.commit);
    if (answer === true) return { anchor: "first_version_tag", tag, commit: tag.commit };
    if (answer === null) return { anchor: "merge_base", reason: "check_failed" };
  }
  return { anchor: "merge_base", reason: "no_ancestor" };
}

// ---------------------------------------------------------------------------------------------
// Participants: values the original authors recorded about their subjects (design B2.3)
// ---------------------------------------------------------------------------------------------

/**
 * The two root files that hold what the authors recorded about their participants. A class of the
 * change summary is about one of them when its `shape` (the path with every BIDS entity value
 * written `*`) is exactly one of these names: a root path has no entity to fold, and a nested
 * `sub-01/participants.tsv` has a shape that begins `sub-*` and then a slash, which is no root
 * file.
 */
export const PARTICIPANT_FILES = ["participants.tsv", "participants.json"] as const;

/**
 * Whether a change of each kind, in a participants file, alters a value the authors recorded
 * (design B2.3, with a change of a JSON value's type counted as a changed value): a cell or a JSON
 * value replaced, rewritten by a rule or emptied, a row relabeled (the participant's own id), or a
 * value's type changed. The other kinds are not: a removal is Part A's loss fact, a row or a key
 * that was found elsewhere verbatim is kept, an addition or a fill takes nothing away, a rename of
 * a JSON key (case and punctuation only) and a reorder or a layout change leave every value as it
 * was. A `Record` over {@link ClassKind}, as `ROLE_OF` is of its roles: a kind added to the summary
 * without an entry here does not compile, because a kind that defaulted to `false` would let a new
 * way of changing a value pass unseen.
 */
export const ALTERS_PARTICIPANT_VALUE: Readonly<Record<ClassKind, boolean>> = {
  column_removed: false,
  row_removed: false,
  json_key_removed: false,
  row_relocated: false,
  json_key_moved: false,
  key_relabeled: true,
  cell_templated: true,
  cell_replaced: true,
  cell_emptied: true,
  json_value_changed: true,
  json_type_changed: true,
  json_emptied: true,
  json_key_renamed: false,
  json_empty_key_removed: false,
  rows_reordered: false,
  columns_reordered: false,
  json_keys_reordered: false,
  format: false,
  column_added: false,
  row_added: false,
  cell_filled: false,
  json_key_added: false,
  json_filled: false,
};

/**
 * How many participant values a pull request changed (design B2.3), from the classes of the change
 * summary: the sum of `items` over the classes whose shape is a root participants file and whose
 * kind is one of {@link ALTERS_PARTICIPANT_VALUE}. Null when the count cannot be known, which is
 * never zero:
 *
 * - the summary was abandoned, so it holds no class at all;
 * - a root participants file changed type (`typechange`);
 * - a root participants file was modified, is not in `cosmetic` (the files the platform proved
 *   differ only in layout, a set the caller decides), and has no outcome in the summary without a
 *   refusal: the summary never saw it, or refused it (ragged rows, a cap, an unread blob), so its
 *   classes, if any, are not all of its changes. Two outcomes for one path are read as both
 *   needed, so any refusal among them is unknown.
 *
 * A participants file added or removed contributes nothing: an addition changes no value the
 * authors recorded, and a removal is Part A's loss fact.
 */
export function participantValuesAltered(
  summary: ChangeSummary,
  changes: readonly { path: string; status: string }[],
  cosmetic: ReadonlySet<string>,
): number | null {
  if (summary.abandoned) return null;
  for (const file of PARTICIPANT_FILES) {
    for (const change of changes) {
      if (change.path !== file || change.status === "added" || change.status === "removed")
        continue;
      if (change.status === "typechange") return null;
      if (cosmetic.has(file)) continue;
      const outcomes = summary.files.filter((outcome) => outcome.path === file);
      if (outcomes.length === 0 || outcomes.some((outcome) => outcome.refusal !== null))
        return null;
    }
  }
  let altered = 0;
  for (const changeClass of summary.classes) {
    const participants = (PARTICIPANT_FILES as readonly string[]).includes(changeClass.shape);
    if (participants && ALTERS_PARTICIPANT_VALUE[changeClass.kind]) altered += changeClass.items;
  }
  return altered;
}

// ---------------------------------------------------------------------------------------------
// The facts of one pull request: everything above, for the content pass to hand the review
// ---------------------------------------------------------------------------------------------

/**
 * What the search for the README's anchor came to. A closed list, printed in a public log like
 * every word of this module:
 *
 * - `not_needed`: no root README or CHANGES part changed, so no tag was looked for;
 * - `not_looked_up`: a README or CHANGES part changed and the version tags were not read (the
 *   caller was told not to, as an offline calibration is), or the pass was abandoned;
 * - `lookup_failed`: the repository's tags could not be listed (an error, a timeout, an answer past
 *   its bound);
 * - `tag_tree_unreadable`: a tag was chosen and its commit's root tree could not be listed;
 * - `first_version_tag`: the README at the first version tag is the anchor;
 * - `no_tag`: the tags were listed and the origin has no version tag at all. The dataset has never
 *   been published, so nothing of its README or CHANGES is protected yet: a changed one is
 *   `unpublished` (see {@link originalContentFacts});
 * - `no_ancestor`, `check_failed`, `too_many_tags`: the other reasons of {@link AnchorChoice}.
 *
 * Every word but `first_version_tag` and `no_tag` leaves the README with no anchor, so every
 * merge-base line is protected (the stricter side): only a lookup that succeeded and found no tag
 * lifts the protection, and a lookup that failed in any way keeps it. A tag whose README could not
 * be read, has no line or is too far from the merge base to align keeps `first_version_tag` here
 * while the README's own facts say `merge_base`: this word is about the search, the facts' `anchor`
 * about what protected the lines.
 */
export const ANCHOR_LOOKUPS = [
  "not_needed",
  "not_looked_up",
  "lookup_failed",
  "tag_tree_unreadable",
  "first_version_tag",
  "no_tag",
  "no_ancestor",
  "check_failed",
  "too_many_tags",
] as const;
export type AnchorLookup = (typeof ANCHOR_LOOKUPS)[number];

/**
 * What became of one document: no part of it changed (`unchanged`, and nothing was compared), it
 * changed in a dataset that has never been published (`unpublished`: the tag lookup found no
 * version tag, so there is no original text to protect and nothing was compared), it was refused in
 * one of the closed words of {@link PROSE_REFUSALS}, or it was compared.
 */
export type DocumentResult =
  | { readonly status: "unchanged" }
  | { readonly status: "unpublished" }
  | { readonly status: "refused"; readonly refusal: ProseRefusal }
  | { readonly status: "compared"; readonly facts: ProseFacts };

/**
 * Everything Part B says about one pull request, for the review to act on. All or nothing: when
 * `abandoned` is true the pass that reads the bytes ran out of time or could not read them, and
 * nothing below it is a fact (it is {@link ORIGINAL_ABANDONED}, which the caller reports as not
 * compared, never as clean).
 */
export interface OriginalContentFacts {
  readonly abandoned: boolean;
  readonly anchorLookup: AnchorLookup;
  readonly readme: DocumentResult;
  readonly changes: DocumentResult;
  /** Null when `dataset_description.json` is not among the changed paths. */
  readonly authorFields: AuthorFieldFacts | null;
  /**
   * The count of {@link participantValuesAltered}, asked only when a root participants file is
   * modified or changed type, and 0 otherwise; null when it cannot be known.
   */
  readonly participantValues: number | null;
  readonly recordings: Readonly<RecordingFacts & { unread: number }>;
  /**
   * The root files a finding about each kind of change may name, or null. Each is a name the
   * module's own patterns accept (a README or CHANGES part, a participants file), so none can carry
   * more of a contributor's text than such a name.
   */
  readonly paths: Readonly<OriginalPaths>;
}

/** The root files of {@link OriginalContentFacts.paths}. */
export interface OriginalPaths {
  /**
   * When any README part changed: the part the platform showed at the merge base (the first of
   * `README_CANDIDATES` present, with exact case), else the first README part of the merge base in
   * code-unit order (a `readme.md`, which is a README part but no candidate), or null when the
   * merge base had no README part at all.
   */
  readme: string | null;
  /** When any CHANGES part changed: the first part at the merge base, in code-unit order. */
  changes: string | null;
  /**
   * The participants file whose values were counted: the file of the first class the count took,
   * or, when none was counted, the first root participants file in {@link PARTICIPANT_FILES} order
   * that was modified or retyped.
   */
  participants: string | null;
}

/** A document no part of which changed: one object, shared and frozen. */
const UNCHANGED: DocumentResult = Object.freeze({ status: "unchanged" });

/** A document that changed in a dataset never published: one object, shared and frozen. */
const UNPUBLISHED: DocumentResult = Object.freeze({ status: "unpublished" });

/**
 * The facts of a pass that was abandoned: nothing compared, nothing counted, and the anchor never
 * looked for. One object shared by every caller, frozen through every level it has, like the
 * summary's `ABANDONED_SUMMARY`, so no reader can change it for the next one.
 */
export const ORIGINAL_ABANDONED: OriginalContentFacts = Object.freeze({
  abandoned: true,
  anchorLookup: "not_looked_up",
  readme: UNCHANGED,
  changes: UNCHANGED,
  authorFields: null,
  participantValues: 0,
  recordings: Object.freeze({ replaced: 0, typeChanged: 0, moved: 0, unread: 0 }),
  paths: Object.freeze({ readme: null, changes: null, participants: null }),
});

/**
 * What {@link originalContentFacts} is given: the bytes and entries the caller read, and nothing it
 * would have to decide here.
 */
export interface OriginalContentInput {
  /**
   * Every changed path with its status as `git diff --raw` names it, so a type change is
   * `typechange` (the change list calls it modified, which would hide it).
   */
  changes: readonly { path: string; status: RecordingChange["status"] }[];
  /**
   * The parts of each document at the merge base and at the head, both sides of a document any part
   * of which changed, the parts that did not change among them. A document with no changed part is
   * not compared, so its parts are not needed.
   */
  documents: Readonly<
    Record<DocumentKind, { base: readonly DocumentPart[]; head: readonly DocumentPart[] }>
  >;
  /** The README parts at the anchor the search found, or null when there is none. */
  anchor: readonly DocumentPart[] | null;
  anchorLookup: AnchorLookup;
  /** `dataset_description.json` at the merge base and at the head. */
  description: { before: DescriptionSide; after: DescriptionSide };
  /** Every changed path, read as {@link recordingFacts} needs it: the same paths as `changes`. */
  recordings: readonly RecordingChange[];
  /** The change summary of the same pass. */
  summary: ChangeSummary;
  /** The paths the platform proved differ only in layout. */
  cosmetic: ReadonlySet<string>;
}

/**
 * The facts of one pull request from what its caller read (design B2 and B3, as built). Each
 * document any part of which changed is compared once, with the anchor for the README alone
 * (CHANGES protects every merge-base line whatever the anchor), and is `refused` in its closed word
 * when it cannot be; a document no part of which changed is `unchanged`.
 *
 * No protection before publication: when the tag lookup succeeded and the origin has no version
 * tag at all (`no_tag`), the dataset has never been published, so a README or CHANGES that changed
 * is `unpublished` and is not compared (no counts, no tripwires, no refusals): its edits are the
 * review's to judge like any other file's. Only that word does it. Every lookup that could not
 * answer (`lookup_failed`, `tag_tree_unreadable`, `check_failed`, `no_ancestor`, `too_many_tags`)
 * keeps every merge-base line protected, so a failure never lifts the protection; the cost of the
 * rule is that a published dataset whose tags were all deleted loses it too. The author fields,
 * the participant values and the recordings are compared whatever the lookup found.
 *
 * The author fields are
 * compared only when `dataset_description.json` changed. Participant values are counted only when
 * a root participants file was modified or changed type: an abandoned summary has no count for any
 * file (see {@link participantValuesAltered}), and asking it about a pull request that touched no
 * participants file would make every such pass unknown for no change at all.
 */
export function originalContentFacts(input: OriginalContentInput): OriginalContentFacts {
  const changed = (document: DocumentKind): boolean =>
    input.changes.some((change) => isDocumentName(document, change.path));
  const documentResult = (document: DocumentKind): DocumentResult => {
    if (!changed(document)) return UNCHANGED;
    if (input.anchorLookup === "no_tag") return UNPUBLISHED;
    const { base, head } = input.documents[document];
    const anchor = document === "readme" ? input.anchor : null;
    const result = proseFacts({ document, base, head, anchor });
    return result.ok
      ? { status: "compared", facts: result.facts }
      : { status: "refused", refusal: result.refusal };
  };
  const participantsChanged = PARTICIPANT_FILES.filter((file) =>
    input.changes.some(
      (change) =>
        change.path === file && (change.status === "modified" || change.status === "typechange"),
    ),
  );
  const baseNames = (document: DocumentKind): string[] =>
    changed(document)
      ? input.documents[document].base
          .map((part) => part.name)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : [];
  const descriptionChanged = input.changes.some(
    (change) => change.path === "dataset_description.json",
  );
  const participantValues =
    participantsChanged.length > 0
      ? participantValuesAltered(input.summary, input.changes, input.cosmetic)
      : 0;
  // The file the count came from: the shape of the first class it took (a root file's shape is its
  // name), so a finding about participants.json values names it, not participants.tsv.
  const countedFile =
    participantValues !== null && participantValues > 0
      ? (input.summary.classes.find(
          (c) =>
            (PARTICIPANT_FILES as readonly string[]).includes(c.shape) &&
            ALTERS_PARTICIPANT_VALUE[c.kind],
        )?.shape ?? null)
      : null;
  return {
    abandoned: false,
    anchorLookup: input.anchorLookup,
    readme: documentResult("readme"),
    changes: documentResult("changes"),
    authorFields: descriptionChanged
      ? authorFieldFacts(input.description.before, input.description.after)
      : null,
    participantValues,
    recordings: recordingFacts(input.recordings),
    paths: {
      readme: firstReadme(baseNames("readme")) ?? baseNames("readme")[0] ?? null,
      changes: baseNames("changes")[0] ?? null,
      participants: countedFile ?? participantsChanged[0] ?? null,
    },
  };
}
