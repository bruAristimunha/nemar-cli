/**
 * The mechanical change summary of a dataset pull request: strict parsers, value rendering and the
 * closed vocabulary they share (ADR 0092, ADR 0107; design `.context/plans/pr-review-change-summary.md`).
 *
 * **This module is pure.** No git, no file system, no clock, and no import from the other
 * `pr-review-*` modules, so everything here can be tested on bytes and strings alone and cannot
 * reach the pull request's repository. The model is shown a summary of a change instead of every
 * diff, and that is only safe if the summary loses nothing; the coverage argument (design section
 * 6.2) therefore starts from two promises made here, and every function below is written to keep
 * one of them.
 *
 * 1. **A parse loses nothing a reader could tell apart.** A table is accepted only when
 *    serializing the parse gives the input back byte for byte ({@link parseTsv}). A JSON document is
 *    accepted only when it is plain RFC 8259 with no key repeated and every number kept as written
 *    ({@link parseJson}); its whitespace and the spelling of its escapes are dropped, because they
 *    carry no value, so two documents with equal trees say the same thing to every conforming
 *    reader. A difference the summary does not show is then a difference the files do not have.
 * 2. **Anything ambiguous is a refusal, never a guess.** A file the parsers cannot read exactly
 *    stays on the raw-diff path as it is today; a refusal is one of the closed words in
 *    {@link SUMMARY_REFUSALS}, because the word is printed in a public log and an error built from a
 *    path or a message would put a contributor's text there.
 *
 * What the model is shown of a value goes through {@link renderValue}, which escapes the characters
 * that are invisible or are not text (see {@link UNSEEN}), so a value cannot forge the platform's
 * own markers.
 */

/**
 * The bounds of the summary. Every cap is a refusal or a cut, never a silent truncation: a file
 * over a per-file cap is refused, a class that does not fit is not rendered, and a cut makes what
 * was cut incomplete (design sections 5.2 to 5.4). Later phases use the rest of the object.
 */
export const SUMMARY_LIMITS = {
  maxBlobBytes: 8 * 1024 * 1024, // per file side
  maxRows: 200_000, // per table
  maxJsonDepth: 64,
  maxJsonNodes: 200_000,
  maxKeyChars: 128, // longer keys get no relabel rule
  maxRuns: 24,
  maxTotalBytes: 256 * 1024 * 1024, // all blobs the summary reads in one run
  maxSummaryChars: 30_000, // the fenced block
  maxClasses: 120, // classes rendered
  maxPairsPerClass: 12, // distinct value pairs rendered per class
  maxValueChars: 300, // per rendered value
  samplesPerClass: 2,
  timeReserveMs: 40_000, // stop summarizing when less than this is left of the content pass
} as const;

/**
 * Why a file was not summarized. A closed list, grouped by what it is about: the first five are
 * about the bytes, the next six about a table's shape, the next four about a JSON document, and the
 * last two about the platform's own reading (`blob_missing` is a git object that
 * could not be read, `internal_mismatch` is the bucket count of design section 6.2 not adding up).
 */
export const SUMMARY_REFUSALS = [
  "too_large",
  "nul_byte",
  "invalid_utf8",
  "bare_cr",
  "empty",
  "empty_column_name",
  "duplicate_column",
  "ragged_row",
  "quoted_cell",
  "too_many_rows",
  "no_round_trip",
  "not_json",
  "duplicate_key",
  "too_deep",
  "too_many_nodes",
  "blob_missing",
  "internal_mismatch",
] as const;
export type SummaryRefusal = (typeof SUMMARY_REFUSALS)[number];

/** How a text file is laid out, apart from its content: what a `format` change is made of. */
export interface TextFormat {
  /** A leading U+FEFF, removed before parsing and put back by the serializer. */
  bom: boolean;
  /**
   * The line endings of the terminated lines: `lf` when every one is LF, `crlf` when every one is
   * CRLF, `mixed` otherwise, and `none` when no line is terminated.
   */
  eol: "lf" | "crlf" | "mixed" | "none";
  /**
   * For a table with `mixed` endings, one character per terminated line, `1` where the line ends in
   * CRLF and `0` where it ends in LF, so two files that differ only in WHICH lines end in CRLF have
   * different formats and the difference is not lost. Empty for every other table, and always empty
   * for a JSON document (its whitespace is not compared).
   */
  crPattern: string;
  /** The text ends with a line break. */
  finalNewline: boolean;
}

/** A parsed tab-separated table, with everything {@link serializeTsv} needs to write it back exactly. */
export interface Table {
  format: TextFormat;
  /**
   * Per line (the header first), whether it ended in CR before its LF, so a file with mixed
   * endings round-trips. One entry per line; an unterminated last line has `false`.
   */
  crByLine: readonly boolean[];
  header: readonly string[];
  rows: readonly (readonly string[])[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: SummaryRefusal };

/**
 * A parsed JSON document. Numbers are the text the file wrote (`1.0`, `1`, `1e400` and `-0` are
 * four different values here, because a platform that normalized them would hide a change); an
 * object keeps its keys in source order. A key named `__proto__` is an ordinary key, held in a
 * `Map` that has no prototype lookup.
 */
export type JsonValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: string }
  | { t: "str"; v: string }
  | { t: "arr"; v: readonly JsonValue[] }
  | { t: "obj"; keys: readonly string[]; v: ReadonlyMap<string, JsonValue> };

// ---------------------------------------------------------------------------------------------
// Paths and values
// ---------------------------------------------------------------------------------------------

/**
 * A path with every BIDS entity value replaced by `*`, in every segment, so the same edit in 125
 * subjects has one shape: the file name `sub-001_ses-01_task-sleep_run-01_channels.tsv` becomes
 * `sub-*_ses-*_task-*_run-*_channels.tsv`, and the directories `sub-001` and `ses-01` above it
 * become `sub-*` and `ses-*` the same way. An entity is a letters-only label, a hyphen and an
 * alphanumeric value that is followed by a separator (a slash, an underscore or a dot), so a name
 * without that shape (`dataset_description.json`, a final `sub-001` with nothing after it) is left
 * alone.
 */
export function entityPattern(path: string): string {
  return path.replace(/(^|[/_])([a-zA-Z]+)-[a-zA-Z0-9]+(?=[/_.])/g, "$1$2-*");
}

/**
 * The characters {@link renderValue} escapes: control, format, separator, private-use and unassigned
 * code points, every default-ignorable code point (the Hangul fillers, the variation selectors, the
 * Mongolian free variation selectors and the like, which render as nothing but are letters or marks
 * to Unicode) and the Braille blank U+2800. Characters that merely look like another (a Cyrillic
 * letter for a Latin one, a precomposed letter for the same letter and a combining mark) are NOT
 * escaped: the platform's pairing says when two values differ only so (design section 8.2).
 */
const UNSEEN = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u{2800}]/gu;

/** The marker that a value was cut. It goes after the closing quote, where a value cannot write it. */
const CUT_MARKER = "...(cut)";

/**
 * A value as the model is shown it: quoted, with nothing in it that could be mistaken for the
 * platform's own text, and cut at `max` characters.
 *
 * The order is deliberate. The value is first cut to `max` CODE POINTS (an astral character is one,
 * so a cut never splits a surrogate pair). The kept text then goes through `JSON.stringify`, which
 * doubles every backslash and escapes quotes, line breaks and the other control characters, so no
 * value can imitate an escape the platform writes after it. Only then is every character that
 * survives and is in {@link UNSEEN} (control, format and separator characters, private-use and
 * unassigned code points, the default-ignorable ones and the Braille blank) replaced by `\u{HEX}`, which is
 * safe because a literal `\u{200B}` in the value was already doubled to `\\u{200B}`. Only U+0020 is
 * left alone. A lone surrogate is escaped by `JSON.stringify` itself (well-formed since ES2019).
 * When the value was cut, `...(cut)` is appended AFTER the closing quote; a value that merely ends
 * in that text is not cut and is quoted like any other, so the marker cannot be forged.
 */
export function renderValue(
  v: string,
  max: number = SUMMARY_LIMITS.maxValueChars,
): { text: string; cut: boolean } {
  let end = 0;
  let points = 0;
  while (end < v.length && points < max) {
    end += (v.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
    points++;
  }
  const cut = end < v.length;
  const quoted = JSON.stringify(v.slice(0, end)).replace(UNSEEN, (ch) =>
    ch === " " ? ch : `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
  return { text: cut ? `${quoted}${CUT_MARKER}` : quoted, cut };
}

/** A code point as the notes print it: `U+` and at least four uppercase hex digits. */
function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Where two strings that may look the same first differ, for the line that must say so: null when
 * they are equal, otherwise `first difference at character k: U+XXXX to U+YYYY`. `k` is 1-based and
 * counted in code points; a side that has ended is the word `end`. Computed on the raw values, one
 * code point at a time and without copying either string, because a value can be megabytes long.
 */
export function firstDifference(a: string, b: string): string | null {
  if (a === b) return null;
  let i = 0;
  let j = 0;
  let k = 0;
  for (;;) {
    k++;
    const ca = i < a.length ? a.codePointAt(i) : undefined;
    const cb = j < b.length ? b.codePointAt(j) : undefined;
    if (ca !== cb) {
      const left = ca === undefined ? "end" : codePointLabel(ca);
      const right = cb === undefined ? "end" : codePointLabel(cb);
      return `first difference at character ${k}: ${left} to ${right}`;
    }
    if (ca === undefined) return null;
    const width = ca > 0xffff ? 2 : 1;
    i += width;
    j += width;
  }
}

// ---------------------------------------------------------------------------------------------
// Bytes to text (steps 1 to 4 of both parsers)
// ---------------------------------------------------------------------------------------------

/** A byte order mark, as the one character it decodes to. */
const BOM = "\u{FEFF}";

/**
 * The checks every file passes before its structure is read, in the order the design gives them:
 * size, NUL, strict UTF-8, byte order mark. `ignoreBOM: true` is what makes the decoder KEEP a
 * leading U+FEFF (the flag names whether the BOM is ignored by the decoder, not by us), so this
 * function can record it and the serializer can put it back; with the default the first character
 * would vanish and the round trip could not be exact. `fatal: true` refuses a malformed sequence
 * instead of replacing it with U+FFFD, which would make two different files decode to one text.
 */
function decodeText(bytes: Uint8Array): Parsed<{ bom: boolean; text: string }> {
  if (bytes.length > SUMMARY_LIMITS.maxBlobBytes) return { ok: false, refusal: "too_large" };
  if (bytes.includes(0)) return { ok: false, refusal: "nul_byte" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, refusal: "invalid_utf8" };
  }
  const bom = text.startsWith(BOM);
  return { ok: true, value: { bom, text: bom ? text.slice(BOM.length) : text } };
}

// ---------------------------------------------------------------------------------------------
// Tab-separated tables
// ---------------------------------------------------------------------------------------------

/** The tab-separated text of a table, exactly as {@link parseTsv} read it (BOM, endings, final newline). */
export function serializeTsv(table: Table): Uint8Array {
  const lines = [table.header, ...table.rows];
  const last = lines.length - 1;
  const parts: string[] = [];
  if (table.format.bom) parts.push(BOM);
  for (let i = 0; i <= last; i++) {
    parts.push((lines[i] as readonly string[]).join("\t"));
    if (i < last || table.format.finalNewline) parts.push(table.crByLine[i] ? "\r\n" : "\n");
  }
  return new TextEncoder().encode(parts.join(""));
}

/** Whether two byte strings are the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Read a tab-separated table, or say in one closed word why the platform will not. The steps are
 * the design's (section 3.1), in this order, so the word a file gets is the first thing wrong with
 * it and never depends on the implementation:
 *
 * 1. more than `maxBlobBytes`: `too_large`; 2. a NUL: `nul_byte`; 3. not strict UTF-8:
 * `invalid_utf8`; 4. a leading BOM is removed and recorded; 5. the text is split on LF, an empty
 * last piece meaning a final newline; 6. one CR ending a TERMINATED line is the line's CRLF and is
 * recorded per line, any other CR (inside a line, or ending an unterminated last line) is
 * `bare_cr`; 7. no line at all: `empty`; 8. the first line is the header, and an empty column name
 * is `empty_column_name`, a repeated one `duplicate_column`; 9. every other line must have exactly
 * the header's number of cells (`ragged_row`), and there may be at most `maxRows` of them
 * (`too_many_rows`, reported only when no row was ragged); 10. a header name or a cell that STARTS
 * with a double quote is `quoted_cell`, because BIDS tables do not quote but pandas does at the
 * start of a field, so a file two readers would split differently is refused instead of guessed;
 * 11. the round trip: the serialization of what was read must equal the input byte for byte.
 *
 * Step 11 is the precondition of the coverage argument (design section 6.2): a parse that loses no
 * byte cannot hide a difference between two versions of a file. Steps 1 to 10 make it hold for
 * every file they accept, so the guard cannot fire on real input; {@link parseTsvWith} is how a test
 * proves it would.
 *
 * **A one-column table is stricter.** csv readers skip an empty line and pandas skips a line of
 * only spaces, so in a table with one column such a line is a row here and not there. The platform
 * would show more than the reader sees, which cannot hide a change, but "two readers cannot
 * disagree" is the promise, so a one-column table with an empty or all-space line is `ragged_row`
 * (an empty header is already `empty_column_name`; an all-space header reaches this rule). In a
 * table with two or more columns every reader agrees.
 */
export function parseTsv(bytes: Uint8Array): Parsed<Table> {
  return parseTsvWith(bytes, serializeTsv);
}

/**
 * {@link parseTsv} with the serializer the round trip compares against passed in. Production code
 * calls `parseTsv`; this exists so a test can hand it a serializer that loses a byte and prove the
 * guard fires.
 */
export function parseTsvWith(
  bytes: Uint8Array,
  check: (table: Table) => Uint8Array,
): Parsed<Table> {
  const decoded = decodeText(bytes);
  if (!decoded.ok) return decoded;
  const { bom, text } = decoded.value;

  // Step 5. No text is no lines and no final newline; otherwise the last piece is empty exactly
  // when the text ends in LF, and that piece is the end of the file, not a line.
  const pieces = text === "" ? [] : text.split("\n");
  const finalNewline = pieces.length > 0 && pieces[pieces.length - 1] === "";
  if (finalNewline) pieces.pop();

  // Step 6.
  const lines: string[] = [];
  const crByLine: boolean[] = [];
  let terminated = 0;
  let crlf = 0;
  for (let i = 0; i < pieces.length; i++) {
    let line = pieces[i] as string;
    const ended = i < pieces.length - 1 || finalNewline;
    let cr = false;
    if (ended && line.endsWith("\r")) {
      line = line.slice(0, -1);
      cr = true;
    }
    if (line.includes("\r")) return { ok: false, refusal: "bare_cr" };
    lines.push(line);
    crByLine.push(cr);
    if (ended) terminated++;
    if (cr) crlf++;
  }

  // Step 7.
  if (lines.length === 0) return { ok: false, refusal: "empty" };

  // Step 8.
  const header = (lines[0] as string).split("\t");
  if (header.includes("")) return { ok: false, refusal: "empty_column_name" };
  if (new Set(header).size !== header.length) return { ok: false, refusal: "duplicate_column" };

  // A one-column table with an empty or all-space line: see the doc above.
  if (header.length === 1 && lines.some((line) => /^ *$/.test(line))) {
    return { ok: false, refusal: "ragged_row" };
  }

  // Step 9. A row past the cap is counted, not kept, so a hostile file cannot make this hold it
  // all; its width is still checked, because a ragged row anywhere is the first thing wrong.
  const rows: string[][] = [];
  let tooMany = false;
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split("\t");
    if (cells.length !== header.length) return { ok: false, refusal: "ragged_row" };
    if (rows.length < SUMMARY_LIMITS.maxRows) rows.push(cells);
    else tooMany = true;
  }
  if (tooMany) return { ok: false, refusal: "too_many_rows" };

  // Step 10.
  if (header.some(startsWithQuote) || rows.some((cells) => cells.some(startsWithQuote))) {
    return { ok: false, refusal: "quoted_cell" };
  }

  const eol =
    terminated === 0 ? "none" : crlf === 0 ? "lf" : crlf === terminated ? "crlf" : "mixed";
  const crPattern =
    eol === "mixed"
      ? crByLine
          .slice(0, terminated)
          .map((cr) => (cr ? "1" : "0"))
          .join("")
      : "";
  const table: Table = { format: { bom, eol, crPattern, finalNewline }, crByLine, header, rows };

  // Step 11.
  if (!sameBytes(check(table), bytes)) return { ok: false, refusal: "no_round_trip" };
  return { ok: true, value: table };
}

function startsWithQuote(cell: string): boolean {
  return cell.charCodeAt(0) === 34;
}

// ---------------------------------------------------------------------------------------------
// JSON documents
// ---------------------------------------------------------------------------------------------

/** A refusal raised inside the recursive reader and turned back into a result at its one entry point. */
class JsonRefusal extends Error {
  readonly refusal: SummaryRefusal;
  constructor(refusal: SummaryRefusal) {
    super(refusal);
    this.name = "JsonRefusal";
    this.refusal = refusal;
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** The characters after a backslash that stand for one character, by their code. */
const SIMPLE_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x22, '"'],
  [0x5c, "\\"],
  [0x2f, "/"],
  [0x62, "\b"],
  [0x66, "\f"],
  [0x6e, "\n"],
  [0x72, "\r"],
  [0x74, "\t"],
]);

/**
 * A recursive-descent reader of RFC 8259 JSON, written by hand because `JSON.parse` does the three
 * things the summary cannot accept: it keeps the LAST of a repeated key (a file that says two things
 * to two readers), it turns a number into a double (`1.0`, `1` and `1e400` become values that hide
 * a change), and it has no bound on nesting. Whitespace is exactly space, tab, LF and CR.
 *
 * **Depth is bounded before it is entered.** An array or object checks its level against
 * `maxJsonDepth` the moment its opening bracket is read, before it reads anything inside, so the
 * recursion is at most `maxJsonDepth + 1` calls deep whatever the input: a megabyte of `[` is
 * refused at its 65th byte, in constant stack and linear time.
 */
class JsonReader {
  private pos = 0;
  private nodes = 0;

  constructor(private readonly text: string) {}

  document(): JsonValue {
    this.skipSpace();
    const value = this.value(0);
    this.skipSpace();
    if (this.pos < this.text.length) throw new JsonRefusal("not_json");
    return value;
  }

  private skipSpace(): void {
    const text = this.text;
    let i = this.pos;
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
    this.pos = i;
  }

  /** Every value, container or not, counts toward `maxJsonNodes`. */
  private count(): void {
    if (++this.nodes > SUMMARY_LIMITS.maxJsonNodes) throw new JsonRefusal("too_many_nodes");
  }

  /** The level a container opened at `depth` has, checked before anything inside is read. */
  private open(depth: number): number {
    const level = depth + 1;
    if (level > SUMMARY_LIMITS.maxJsonDepth) throw new JsonRefusal("too_deep");
    this.count();
    return level;
  }

  private value(depth: number): JsonValue {
    const c = this.text.charCodeAt(this.pos);
    if (c === 0x7b) return this.object(depth);
    if (c === 0x5b) return this.array(depth);
    this.count();
    if (c === 0x22) return { t: "str", v: this.string() };
    if (c === 0x74) return this.literal("true", { t: "bool", v: true });
    if (c === 0x66) return this.literal("false", { t: "bool", v: false });
    if (c === 0x6e) return this.literal("null", { t: "null" });
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return this.number();
    throw new JsonRefusal("not_json");
  }

  /** What follows a literal or a number is checked by the caller, which accepts only a delimiter. */
  private literal(word: string, value: JsonValue): JsonValue {
    if (!this.text.startsWith(word, this.pos)) throw new JsonRefusal("not_json");
    this.pos += word.length;
    return value;
  }

  private number(): JsonValue {
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (match === null) throw new JsonRefusal("not_json");
    this.pos += match[0].length;
    return { t: "num", v: match[0] };
  }

  private string(): string {
    const text = this.text;
    let out = "";
    let start = this.pos + 1;
    let i = start;
    for (;;) {
      if (i >= text.length) throw new JsonRefusal("not_json");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        this.pos = i + 1;
        return out + text.slice(start, i);
      }
      if (c < 0x20) throw new JsonRefusal("not_json");
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(start, i);
      const e = text.charCodeAt(i + 1);
      const simple = SIMPLE_ESCAPES.get(e);
      if (simple !== undefined) {
        out += simple;
        i += 2;
      } else if (e === 0x75) {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JsonRefusal("not_json");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
      } else {
        throw new JsonRefusal("not_json");
      }
      start = i;
    }
  }

  private array(depth: number): JsonValue {
    const level = this.open(depth);
    this.pos++;
    const items: JsonValue[] = [];
    this.skipSpace();
    if (this.text.charCodeAt(this.pos) === 0x5d) {
      this.pos++;
      return { t: "arr", v: items };
    }
    for (;;) {
      items.push(this.value(level));
      this.skipSpace();
      const c = this.text.charCodeAt(this.pos);
      this.pos++;
      if (c === 0x5d) return { t: "arr", v: items };
      if (c !== 0x2c) throw new JsonRefusal("not_json");
      this.skipSpace();
    }
  }

  private object(depth: number): JsonValue {
    const level = this.open(depth);
    this.pos++;
    const keys: string[] = [];
    const members = new Map<string, JsonValue>();
    this.skipSpace();
    if (this.text.charCodeAt(this.pos) === 0x7d) {
      this.pos++;
      return { t: "obj", keys, v: members };
    }
    for (;;) {
      if (this.text.charCodeAt(this.pos) !== 0x22) throw new JsonRefusal("not_json");
      const key = this.string();
      if (members.has(key)) throw new JsonRefusal("duplicate_key");
      this.skipSpace();
      if (this.text.charCodeAt(this.pos) !== 0x3a) throw new JsonRefusal("not_json");
      this.pos++;
      this.skipSpace();
      members.set(key, this.value(level));
      keys.push(key);
      this.skipSpace();
      const c = this.text.charCodeAt(this.pos);
      this.pos++;
      if (c === 0x7d) return { t: "obj", keys, v: members };
      if (c !== 0x2c) throw new JsonRefusal("not_json");
      this.skipSpace();
    }
  }
}

/** The layout of a JSON text: its BOM, the kind of line breaks it holds anywhere, and its last character. */
function jsonFormat(bom: boolean, text: string): TextFormat {
  let lf = 0;
  let crlf = 0;
  let bareCr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) lf++;
    else if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        crlf++;
        i++;
      } else bareCr = true;
    }
  }
  const eol =
    lf + crlf === 0 && !bareCr
      ? "none"
      : bareCr || (lf > 0 && crlf > 0)
        ? "mixed"
        : crlf > 0
          ? "crlf"
          : "lf";
  return { bom, eol, crPattern: "", finalNewline: text.endsWith("\n") };
}

/**
 * Read a JSON document, or say in one closed word why the platform will not. The first four steps
 * are the TSV parser's (`too_large`, `nul_byte`, `invalid_utf8`, a BOM removed and recorded); the
 * rest is RFC 8259 and nothing more, read by {@link JsonReader}. `NaN`, `Infinity`, comments,
 * trailing commas, single quotes, leading zeros, a raw control character in a string and anything
 * after the value are `not_json`; a key repeated within one object, at any depth, is
 * `duplicate_key` (keys are compared decoded, so `"a"` and the six-character escape of `a` are the
 * same key); nesting past `maxJsonDepth` is `too_deep` and more than `maxJsonNodes` values
 * `too_many_nodes`. Where a document has several faults the word is the first one met in reading
 * order.
 *
 * Numbers stay as the text the file wrote and strings are decoded, so the six-character escape of
 * `A` and a plain `A` are one value, while `1.0`, `1` and `1e400` are three. Equal trees therefore
 * mean equal values to every conforming reader, which is what makes a JSON file's change summary
 * as complete as a TSV's. Whitespace is not kept: a reindent is the cosmetic proof's business, and
 * `format` reports only what the line breaks were.
 */
export function parseJson(bytes: Uint8Array): Parsed<{ value: JsonValue; format: TextFormat }> {
  const decoded = decodeText(bytes);
  if (!decoded.ok) return decoded;
  const { bom, text } = decoded.value;
  try {
    const value = new JsonReader(text).document();
    return { ok: true, value: { value, format: jsonFormat(bom, text) } };
  } catch (error) {
    // Anything but a refusal is a defect in this reader and must be loud, never a quiet refusal.
    if (error instanceof JsonRefusal) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

/**
 * A value as compact JSON text: no whitespace, object keys in source order, strings re-encoded
 * with `JSON.stringify` (so two spellings of one string have one text), numbers as written. This is
 * the text a leaf is compared and shown as (design section 2.3), so it is injective on values.
 */
export function canonicalJson(v: JsonValue): string {
  switch (v.t) {
    case "null":
      return "null";
    case "bool":
      return v.v ? "true" : "false";
    case "num":
      return v.v;
    case "str":
      return JSON.stringify(v.v);
    case "arr":
      return `[${v.v.map((item) => canonicalJson(item)).join(",")}]`;
    case "obj":
      return `{${v.keys
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(v.v.get(key) as JsonValue)}`)
        .join(",")}}`;
  }
}
