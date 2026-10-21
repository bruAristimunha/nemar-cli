/**
 * The mechanical change summary of a dataset pull request: strict parsers, value rendering and the
 * closed vocabulary they share (ADR 0092, ADR 0107; design `.context/plans/pr-review-change-summary.md`).
 *
 * **This module is pure.** No git, no file system, and no import at all; it reads the clock only
 * through the `now` the caller passes to {@link summarizeChanges}, which defaults to `Date.now`, and
 * only to check the summary's deadline. So everything here can be tested on bytes and strings
 * alone and cannot reach the pull request's repository. The model is shown a summary of a change
 * instead of every diff, and that is only safe if the summary loses nothing; the coverage argument
 * (design section 6.2) therefore starts from two promises made here, and every function below is
 * written to keep one of them.
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
 *
 * The second half of the module is the change model: for a modified table or JSON document it
 * computes every difference as an atom with a role ({@link CLASS_KINDS}, {@link ROLE_OF}), and it
 * asserts that the computation is TOTAL (design section 6.2): every row, column and leaf of both
 * versions is in exactly one bucket, and the counts add up or the file is refused. Where the
 * evidence for a pairing is doubtful, the pairing is not made: a doubtful pair is a removal and an
 * addition, shown as such and counted as a loss, and never a quiet match. That direction is the
 * rule of every choice in it.
 *
 * The third part groups the atoms of every file into change classes ({@link classify}): one class
 * per kind, path shape, field, rule and detail, so one edit repeated over 125 subjects is one
 * class with a count. It renders them within fixed bounds ({@link renderClasses}), decides which
 * files the summary accounts for ({@link accountedFiles}: only those whose every non-additive
 * class was shown completely) and counts the loss facts ({@link lossFactsOf}).
 * {@link summarizeChanges} runs all of it over a pull request's candidate files.
 */

/**
 * The bounds of the summary. Every cap is a refusal or a cut, never a silent truncation: a file
 * over a per-file cap is refused, a class that does not fit is not rendered, and a cut makes what
 * was cut incomplete (design sections 5.2 to 5.4). Later phases use the rest of the object.
 */
export const SUMMARY_LIMITS = {
  maxBlobBytes: 8 * 1024 * 1024, // per file side
  maxRows: 200_000, // per table
  // Columns per table; a wider header refuses the file `too_large` before its names are split, so
  // the cost of a table is not its width times its rows of changed cells.
  maxColumns: 10_000,
  maxJsonDepth: 64,
  maxJsonNodes: 200_000,
  maxKeyChars: 128, // longer keys get no relabel rule
  // A column name, a JSON key or a JSON path longer than this, in UTF-16 code units (`.length`),
  // refuses its file `too_large`. Every atom of a file can carry one, so an unbounded name would
  // make the cost of a file its row count times the name. Above `maxValueChars` on purpose: a
  // name between 301 and 1024 is still summarized, and its class line is cut and incomplete.
  maxNameChars: 1024,
  maxRuns: 24,
  maxPairingSteps: 12_000_000, // per file: the pairing passes' work, in steps of about one lookup
  maxTotalBytes: 256 * 1024 * 1024, // all blobs the summary reads in one run
  // What the relocation pools hold in one run, in UTF-16 code units: a table's header and new rows,
  // and a JSON document's top-level keys and, per new leaf, its path, its value and its key in
  // `byLeaf`. `maxTotalBytes` does not bound this: a leaf repeats its whole path, so a document can
  // hold hundreds of times its size. A pool file that would pass it is left out as one that cannot
  // be read (see `buildPools`).
  maxPoolChars: 32 * 1024 * 1024,
  maxSummaryChars: 30_000, // the fenced block
  maxClasses: 120, // classes rendered
  // Distinct classes a run may hold. A file whose atoms would make more is refused `too_large`
  // whole, and the run goes on with the next file, so what a run holds is bounded by its classes,
  // not its atoms, and one file with thousands of distinct changes costs only that file.
  maxTrackedClasses: 5_000,
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
 * `too_large` is also the word for a column name, a JSON key or a JSON path over `maxNameChars`.
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
 * `bare_cr`; 7. no line at all: `empty`; 8. the first line is the header: more than `maxColumns`
 * columns is `too_large` (counted before the line is split into names, and before any row is
 * split into cells), an empty column name `empty_column_name`, a repeated one `duplicate_column`,
 * one longer than `maxNameChars` code units `too_large` (so no atom or class key is ever built
 * from such a name); 9. every other line
 * must have exactly the header's number of cells (`ragged_row`), and there may be at most
 * `maxRows` of them (`too_many_rows`, reported only when no row was ragged); 10. a header name or
 * a cell that STARTS with a double quote is `quoted_cell`, because BIDS tables do not quote but
 * pandas does at the start of a field, so a file two readers would split differently is refused
 * instead of guessed;
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

  // Step 8. The width first, by counting tabs, so a header too wide is never split.
  const first = lines[0] as string;
  let tabs = 0;
  for (let at = first.indexOf("\t"); at !== -1; at = first.indexOf("\t", at + 1)) {
    if (++tabs >= SUMMARY_LIMITS.maxColumns) return { ok: false, refusal: "too_large" };
  }
  const header = first.split("\t");
  if (header.includes("")) return { ok: false, refusal: "empty_column_name" };
  if (new Set(header).size !== header.length) return { ok: false, refusal: "duplicate_column" };
  if (header.some((name) => name.length > SUMMARY_LIMITS.maxNameChars)) {
    return { ok: false, refusal: "too_large" };
  }

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
      // Before the key is stored, so no path or atom is ever built from it.
      if (key.length > SUMMARY_LIMITS.maxNameChars) throw new JsonRefusal("too_large");
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
 * same key); a key longer than `maxNameChars` code units once decoded is `too_large`; nesting past
 * `maxJsonDepth` is `too_deep` and more than `maxJsonNodes` values `too_many_nodes`. Where a
 * document has several faults the word is the first one met in reading order.
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

// ---------------------------------------------------------------------------------------------
// The vocabulary of a change (design section 4.1)
// ---------------------------------------------------------------------------------------------

/**
 * Every kind of difference the change model can find between two versions of a file, in the order
 * of the design's table (section 4.1): the loss kinds first, then the relocated, the modifications
 * and the additive kinds, which is also the order a class renders in (section 5.1). The words are
 * the platform's own and are printed in a public log, so none of them is built from author text.
 *
 * - `column_removed`, `row_removed`, `json_key_removed`: content of the before side that the after
 *   side does not have and that no rule below accounts for. These are the platform's loss facts.
 * - `row_relocated`, `json_key_moved`: content that left the file but is verbatim elsewhere in the
 *   same pull request (design section 4.6); information, not a loss.
 * - `key_relabeled`, `cell_templated`, `cell_replaced`, `cell_emptied`, `json_value_changed`,
 *   `json_type_changed`, `json_emptied`, `json_key_renamed`, `json_empty_key_removed`,
 *   `rows_reordered`, `columns_reordered`, `json_keys_reordered`, `format`: the content is still
 *   there but different, or only its order or layout changed. Each is shown exactly.
 * - `column_added`, `row_added`, `cell_filled`, `json_key_added`, `json_filled`: new content, or a
 *   missing value filled in. They remove nothing, so coverage never needs them shown.
 */
export const CLASS_KINDS = [
  "column_removed",
  "row_removed",
  "json_key_removed",
  "row_relocated",
  "json_key_moved",
  "key_relabeled",
  "cell_templated",
  "cell_replaced",
  "cell_emptied",
  "json_value_changed",
  "json_type_changed",
  "json_emptied",
  "json_key_renamed",
  "json_empty_key_removed",
  "rows_reordered",
  "columns_reordered",
  "json_keys_reordered",
  "format",
  "column_added",
  "row_added",
  "cell_filled",
  "json_key_added",
  "json_filled",
] as const;
export type ClassKind = (typeof CLASS_KINDS)[number];

/** What a kind means for the review: see {@link CLASS_KINDS}. */
export type ClassRole = "loss" | "relocated" | "modification" | "additive";

/**
 * The role of every kind. It is a `Record` over {@link ClassKind}, so a kind added to the list
 * without a role does not compile: a new kind that silently defaulted to "additive" would be a kind
 * coverage never needed shown, which is the one mistake this table exists to make impossible.
 */
export const ROLE_OF: Readonly<Record<ClassKind, ClassRole>> = {
  column_removed: "loss",
  row_removed: "loss",
  json_key_removed: "loss",
  row_relocated: "relocated",
  json_key_moved: "relocated",
  key_relabeled: "modification",
  cell_templated: "modification",
  cell_replaced: "modification",
  cell_emptied: "modification",
  json_value_changed: "modification",
  json_type_changed: "modification",
  json_emptied: "modification",
  json_key_renamed: "modification",
  json_empty_key_removed: "modification",
  rows_reordered: "modification",
  columns_reordered: "modification",
  json_keys_reordered: "modification",
  format: "modification",
  column_added: "additive",
  row_added: "additive",
  cell_filled: "additive",
  json_key_added: "additive",
  json_filled: "additive",
};

/**
 * A table cell that holds no value: exactly `n/a` or nothing. The set is deliberately narrow. A
 * wider one (`None`, `unknown`, `NA`) would turn the overwrite of a real value into "filled", which
 * is additive and needs no display, so the narrower the set the more a change is shown.
 */
export function isMissingCell(v: string): boolean {
  return v === "" || v === "n/a";
}

/**
 * A JSON value that holds nothing: `null`, `""`, `"n/a"`, `[]`, `{}`, or an array whose every
 * element is itself one of these. Narrow for the same reason as {@link isMissingCell}: `0`, `false`,
 * `"None"` and `{"a": null}` are values.
 */
export function isMissingJson(v: JsonValue): boolean {
  switch (v.t) {
    case "null":
      return true;
    case "str":
      return v.v === "" || v.v === "n/a";
    case "arr":
      return v.v.every(isMissingJson);
    case "obj":
      return v.keys.length === 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Relabel rules (design section 4.3)
// ---------------------------------------------------------------------------------------------

/**
 * One exact description of how a name or a cell became another, written so that it is a function of
 * the BEFORE value: a class that holds one rule describes every member of the class completely, and
 * a member the rule does not describe has a different rule or none. `case`, `repad` and the
 * `repadded` flag are the exceptions, and deliberately so: they say only that a spelling changed
 * (which letters are upper case, how many zeros pad a number), never what the new spelling is, and
 * a spelling is all they can change.
 */
export interface RelabelRule {
  /**
   * `case`: only letter case changed (for keys only: in a cell, a case change is a replaced value).
   * `wrap` and `strip`: text was added around the value, or removed from around it. `repad`: only
   * the zero padding of numbers changed. `insert` and `delete`: text was added to or removed from
   * between the parts of the value.
   */
  kind: "case" | "wrap" | "strip" | "repad" | "insert" | "delete";
  /**
   * `wrap`/`strip`: the text before and the text after, `[prefix, suffix]`. `insert`/`delete`: the
   * text added or removed before each kept part and after the last one, so one more than the number
   * of kept parts. `case`/`repad`: empty.
   */
  gaps: readonly string[];
  /**
   * `insert`/`delete`: the kept parts, one letter each, `L` for a run of letters, `D` for a run of
   * digits and `O` for one other character; or `c<n>` for a character rule that keeps `n`
   * characters. Empty for every other kind.
   */
  shape: string;
  /** A number kept its value but changed its zero padding (`1` to `01`). */
  repadded: boolean;
}

/**
 * Both sides are plain decimal numbers. Such a pair never gets a rule: `64` to `640` is a replaced
 * value, not "a 0 was added", and a rule would file a changed measurement under a name that sounds
 * like formatting.
 */
const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ASCII_DIGITS = /^[0-9]+$/;
const LETTER = /^\p{L}$/u;
const NUMBER_CHARACTER = /^\p{N}$/u;

type RunClass = "L" | "D" | "O";

/** A part of a name: a run of letters, a run of digits, or one other character. */
interface Run {
  cls: RunClass;
  text: string;
  /**
   * What the run is compared by when the digits of a pair are compared by value, which they are
   * only when every digit run of both strings stands among the neighbors {@link plainSide} allows
   * (see {@link Name.numbersAsText}). Letters and other characters: exactly their text. Digits:
   * their value, so `01` and `1` are one number, but only for ASCII digits; any other digit
   * (Arabic-Indic, a superscript, a fraction) is the text it is, because it has no value this
   * module can vouch for, and a string that holds one is compared as text whole.
   */
  norm: string;
}

/**
 * The separators a run of ASCII digits may have beside it, one character each, and still be read
 * as a number with padding: a space, a hyphen and an underscore, as in `0100 Hz`, `sub-01` and
 * `x_02_y`. An ALLOWLIST: every other character beside a digit (a dot, a comma, an apostrophe, a
 * middle dot, any other mark, symbol or space, a format or combining character) may be part of
 * the number, and no list of such marks could be complete, so it compares the pair as text.
 */
const DIGIT_SEPARATORS: ReadonlySet<string> = new Set([" ", "-", "_"]);
const ASCII_LETTERS = /^[A-Za-z]+$/;

function normalizeRun(run: { cls: RunClass; text: string }): string {
  if (run.cls !== "D" || !ASCII_DIGITS.test(run.text)) return run.text;
  return run.text.replace(/^0+(?=[0-9])/, "");
}

/**
 * Whether a string compares its pair as text (see {@link Name.numbersAsText}): it holds a digit
 * run with a non-ASCII digit, or an ASCII digit run with a side {@link plainSide} does not allow.
 */
function holdsNumberText(runs: readonly Run[]): boolean {
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] as Run;
    if (run.cls !== "D") continue;
    if (!ASCII_DIGITS.test(run.text)) return true;
    if (!plainSide(runs, i, -1) || !plainSide(runs, i, 1)) return true;
  }
  return false;
}

/**
 * Whether one side (`step` -1 or 1) of the digit run at `i` lets its digits be read by value. The
 * allowlist, and nothing else:
 *
 * - the edge of the string;
 * - a run of ASCII letters that is not ONE letter with a digit run beyond it ({@link plainLetters}):
 *   `E001`, `Fp1` and `ECOG1` are plain, the `p` of `0p05`, the `e` of `1e05` and the `x` of
 *   `1x000` are each part of one number;
 * - ONE separator of {@link DIGIT_SEPARATORS} with the edge or such a letter run beyond it, as in
 *   `0100 Hz`, `sub-01` and `x_02_y`. A digit run beyond it JOINS the two (`5 000`, `1-05`, `1_000`
 *   are one number), and anything else beyond it is not on the list (`. 5`, two separators).
 */
function plainSide(runs: readonly Run[], i: number, step: number): boolean {
  const next = runs[i + step];
  if (next === undefined) return true;
  if (next.cls === "L") return plainLetters(runs, i + step, step);
  if (next.cls !== "O" || !DIGIT_SEPARATORS.has(next.text)) return false;
  const beyond = runs[i + 2 * step];
  if (beyond === undefined) return true;
  return beyond.cls === "L" && plainLetters(runs, i + 2 * step, step);
}

/** Whether the letter run at `j`, beside a digit run on its other side, is plain: see {@link plainSide}. */
function plainLetters(runs: readonly Run[], j: number, step: number): boolean {
  const letters = (runs[j] as Run).text;
  if (!ASCII_LETTERS.test(letters)) return false;
  return letters.length > 1 || runs[j + step]?.cls !== "D";
}

/**
 * The class of one code point. ASCII is decided by its code, because this runs once per character
 * of every key a large table holds and a Unicode property test is the slow path; the result is the
 * one the property tests give (ASCII letters are the only `\p{L}` and ASCII digits the only `\p{N}`
 * below U+0080).
 */
function runClassOf(ch: string): RunClass {
  const code = ch.charCodeAt(0);
  if (code < 0x80) {
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return "L";
    return code >= 0x30 && code <= 0x39 ? "D" : "O";
  }
  if (LETTER.test(ch)) return "L";
  if (NUMBER_CHARACTER.test(ch)) return "D";
  return "O";
}

/** Whether a string is longer than `maxKeyChars` code points, without counting a long one in full. */
function exceedsKeyChars(s: string): boolean {
  const max = SUMMARY_LIMITS.maxKeyChars;
  if (s.length <= max) return false;
  if (s.length > 2 * max) return true;
  let points = 0;
  for (const _ of s) if (++points > max) return true;
  return false;
}

/**
 * Split a name into runs, or null when it has more than `maxRuns` of them. The caller has already
 * bounded the length in code points.
 */
function splitRuns(s: string): Run[] | null {
  const parts: { cls: RunClass; text: string }[] = [];
  let cls: RunClass | null = null;
  let text = "";
  for (const ch of s) {
    const next = runClassOf(ch);
    // Letters and digits extend the run they are in; every other character is a run of its own.
    if (cls === next && next !== "O") {
      text += ch;
      continue;
    }
    if (cls !== null) parts.push({ cls, text });
    if (parts.length >= SUMMARY_LIMITS.maxRuns) return null;
    cls = next;
    text = ch;
  }
  if (cls !== null) parts.push({ cls, text });
  return parts.map((part) => ({ cls: part.cls, text: part.text, norm: normalizeRun(part) }));
}

/**
 * A string as the relabel rules read it, computed once: a table diff asks for the rule between the
 * same keys many times, and splitting a key into runs is most of the cost of asking.
 */
interface Name {
  text: string;
  /** Longer than `maxKeyChars` code points: not a name, and no rule of any kind. */
  long: boolean;
  /** Its runs, or null when it is long or has more than `maxRuns` of them. */
  runs: readonly Run[] | null;
  /**
   * The string has a digit run whose zeros may be part of a number rather than its padding, so its
   * pair is compared as text. The digits of a pair are read by VALUE only when every digit run of
   * both strings is ASCII and stands among neighbors an allowlist names ({@link plainSide}): the
   * edge of the string, an ASCII letter run that is not one letter with digits beyond it, or one
   * space, hyphen or underscore with the edge or such a letter run beyond it. So `sub-01_ses-02`,
   * `0100 Hz`, `EEG 001`, `x_02_y`, `E001`, `ECOG1` and `Fp1` are plain; `0.05`, `5 000`, `1'000`,
   * `0·05`, `1٫05`, `0ꞏ05`, `1ʼ000`, `0p05`, `1e05`, `．05` and `.⁠5` (a word joiner after the dot)
   * are not, and no mark has to be known for that.
   *
   * It is decided for each string alone, and it decides the PAIR: when either string of a pair
   * holds such a run, every digit run of both is compared by its text, so no rule between them
   * can say a number kept its value. Deciding it run by run is not enough, because the mark can be
   * in the text a rule adds: `05 Hz` to `.5 Hz` would otherwise read as a prefix `.` added and the
   * zero padding changed, which is a tenfold change.
   */
  numbersAsText: boolean;
}

function nameOf(text: string): Name {
  const long = exceedsKeyChars(text);
  const runs = long ? null : splitRuns(text);
  return { text, long, runs, numbersAsText: runs !== null && holdsNumberText(runs) };
}

/**
 * Whether two runs are the same part: the same class and, for digits, the same text when the pair
 * compares numbers as text (`byText`), the same {@link Run.norm} otherwise.
 */
function sameRun(a: Run, b: Run, byText: boolean): boolean {
  return a.cls === b.cls && (byText ? a.text === b.text : a.norm === b.norm);
}

/** The leftmost offset at which all of `short` appears among the runs of `long`, or -1. */
function findContiguous(short: readonly Run[], long: readonly Run[], byText: boolean): number {
  for (let k = 0; k + short.length <= long.length; k++) {
    let all = true;
    for (let i = 0; i < short.length && all; i++) {
      all = sameRun(short[i] as Run, long[k + i] as Run, byText);
    }
    if (all) return k;
  }
  return -1;
}

/**
 * Match the runs of `short` against the TEXT of `long`, in order, and return the text left over
 * between the matches (one more gap than there are runs), or null when they do not all match.
 *
 * A digit run matches only a whole digit run of the same value (the same text, when `byText`).
 * A letter run or another character
 * matches an occurrence of its text, preferably one that starts and ends where a run of `long`
 * does, else the first occurrence after the previous match: `GA` is in `EEGGA` only as its tail, and
 * that is how `GA01` becomes `EEGGA_01REF`. The choice is greedy and never backs up, so a name that
 * could only match by a different earlier choice gets no rule, which shows MORE change (a removal
 * and an addition), never less. Whatever choice is made, the gaps and the matched text rebuild
 * `long` exactly, so the rule is an exact description either way.
 */
function matchInOrder(
  short: readonly Run[],
  long: readonly Run[],
  byText: boolean,
): { gaps: string[]; repadded: boolean } | null {
  const text = long.map((run) => run.text).join("");
  const starts: number[] = [];
  let offset = 0;
  for (const run of long) {
    starts.push(offset);
    offset += run.text.length;
  }

  const gaps: string[] = [];
  let position = 0;
  let repadded = false;
  for (const run of short) {
    let at = -1;
    let length = run.text.length;
    if (run.cls === "D") {
      for (let i = 0; i < long.length; i++) {
        const candidate = long[i] as Run;
        if ((starts[i] as number) >= position && sameRun(candidate, run, byText)) {
          at = starts[i] as number;
          length = candidate.text.length;
          if (candidate.text !== run.text) repadded = true;
          break;
        }
      }
    } else {
      // An occurrence that starts and ends where runs of `long` do is a whole run of `long` with
      // this text: a letter run is maximal (a letter next to it would have joined it), and any other
      // character is a run of its own. So it is found among the runs, never by scanning every
      // occurrence of the text, which a hostile name can make hundreds; failing that, the first
      // occurrence after the previous match.
      for (let i = 0; i < long.length; i++) {
        const candidate = long[i] as Run;
        // Equal text is equal class: a letter run and another character never share a text.
        if ((starts[i] as number) >= position && candidate.text === run.text) {
          at = starts[i] as number;
          break;
        }
      }
      if (at === -1) at = text.indexOf(run.text, position);
    }
    if (at === -1) return null;
    gaps.push(text.slice(position, at));
    position = at + length;
  }
  gaps.push(text.slice(position));
  return { gaps, repadded };
}

/**
 * The rules over runs: `repad`, `wrap`/`strip`, then `insert`/`delete`.
 *
 * **An insertion or a deletion needs an anchor**: the name with fewer runs must hold a digit run,
 * and a digit run matches only a whole digit run of the same value. Without that, a rule built from
 * letters alone would call two different electrodes one electrode respelled (`Cz` is in `FCz`, `Pz`
 * in `POz`, `FC3` in `FCC3h` with a letter between), and a removed channel would pair with an
 * unrelated new one. A number is what makes `GA01` and `EEGGA_01REF` the same channel; a name with
 * no number has no part that the insertion could not have changed the meaning of.
 */
function runRule(
  before: readonly Run[],
  after: readonly Run[],
  byText: boolean,
): RelabelRule | null {
  if (before.length === after.length) {
    // Same number of parts: only a number's padding can be the whole difference. Letters and other
    // characters compare by their exact text and the two strings differ (the caller returned on
    // equal strings), so when every run is the same by `norm`, some digit run changed its padding.
    // Compared by text, every run the same would be two equal strings: no repad is ever found.
    for (let i = 0; i < before.length; i++) {
      if (!sameRun(before[i] as Run, after[i] as Run, byText)) return null;
    }
    return { kind: "repad", gaps: [], shape: "", repadded: true };
  }

  const beforeShorter = before.length < after.length;
  const short = beforeShorter ? before : after;
  const long = beforeShorter ? after : before;

  const k = findContiguous(short, long, byText);
  if (k >= 0) {
    const prefix = long
      .slice(0, k)
      .map((run) => run.text)
      .join("");
    const suffix = long
      .slice(k + short.length)
      .map((run) => run.text)
      .join("");
    const repadded = short.some((run, i) => run.text !== (long[k + i] as Run).text);
    return { kind: beforeShorter ? "wrap" : "strip", gaps: [prefix, suffix], shape: "", repadded };
  }

  if (!short.some((run) => run.cls === "D")) return null;
  // Every gap is never empty here: if the runs of `short` sat in `long` with nothing between them,
  // `long` would split into the same runs (a matched letter run is followed by a digit or another
  // character, so it is a whole run of `long`), and the two would have the same number of runs.
  const matched = matchInOrder(short, long, byText);
  if (matched === null) return null;
  return {
    kind: beforeShorter ? "insert" : "delete",
    gaps: matched.gaps,
    shape: short.map((run) => run.cls).join(""),
    repadded: matched.repadded,
  };
}

/**
 * The last rule: the shorter string is a subsequence of the longer one, character by character,
 * and **every inserted or deleted text is made of whole runs of the longer string** (the runs of
 * rule 2: a maximal run of letters, a maximal run of digits, or one other character). It is the
 * rule for `DCEMBRACE` becoming `DC EMBRACE-REF`, where no part of the first survives whole but
 * the text put in (` `, `-REF`) is separate parts of the new name.
 *
 * The whole-runs condition is what keeps a character rule from changing a name's meaning: without
 * it `A1` becomes `A10` ("a 0 inserted"), `sub-2` becomes `sub-12` and `Cz` becomes `FCz`, each a
 * different channel or participant, because the inserted text joins a run that was already there.
 *
 * The leftmost subsequence is used, so the result depends only on the two strings. A pair that
 * only another alignment would describe in whole runs gets no rule: a removal and an addition,
 * which shows more change, never less.
 */
function characterRule(before: Name, after: Name): RelabelRule | null {
  const b = Array.from(before.text);
  const a = Array.from(after.text);
  const beforeShorter = b.length < a.length;
  const short = beforeShorter ? b : a;
  const long = beforeShorter ? a : b;
  // The places, in code points, where a run of the longer string starts or ends.
  const boundary = new Set<number>([0]);
  let offset = 0;
  for (const run of (beforeShorter ? after.runs : before.runs) as readonly Run[]) {
    for (const _ of run.text) offset++;
    boundary.add(offset);
  }
  const wholeRuns = (start: number, end: number): boolean =>
    start === end || (boundary.has(start) && boundary.has(end));

  const gaps: string[] = [];
  let gap = "";
  let gapStart = 0;
  let j = 0;
  for (let i = 0; i < long.length; i++) {
    const ch = long[i] as string;
    if (j < short.length && ch === short[j]) {
      if (!wholeRuns(gapStart, i)) return null;
      // Text put between two digits that were one number (LA12 to LA1-2, E10 to E1.0) splits the
      // number; text taken from between them merges two. Either way it is another name.
      if (
        gap !== "" &&
        j > 0 &&
        runClassOf(short[j - 1] as string) === "D" &&
        runClassOf(ch) === "D"
      ) {
        return null;
      }
      gaps.push(gap);
      gap = "";
      gapStart = i + 1;
      j++;
    } else {
      gap += ch;
    }
  }
  // Equal lengths cannot reach here with a full match: that would be two equal strings.
  if (j < short.length || !wholeRuns(gapStart, long.length)) return null;
  gaps.push(gap);
  return {
    kind: beforeShorter ? "insert" : "delete",
    gaps,
    shape: `c${short.length}`,
    repadded: false,
  };
}

/**
 * The first rule that says how `before` became `after`, or null. In order: `case` (equal once both
 * are lower-cased); then, over the runs of each string (a maximal run of letters, a maximal run of
 * digits, or one other character; digits compared by value, so `01` is `1`, only when every digit
 * run of both strings stands among the neighbors an allowlist names, and otherwise every digit of
 * both is compared as text: see {@link Name.numbersAsText}), `repad`, `wrap` or `strip` (the
 * shorter string's runs sit contiguously in the longer one), and `insert` or `delete` (they sit in
 * order, with text between them, and the one with fewer runs holds a digit run: see `runRule`);
 * and only when `opts.chars` is set, the character rule, whose inserted text must be whole runs
 * (see `characterRule`). Cells never ask for characters: a changed character in a cell is a
 * replaced value.
 *
 * A pair gets no rule when the strings are equal, either is empty, either is longer than
 * `maxKeyChars` code points or has more than `maxRuns` runs (a long text is not a name, and an
 * unbounded search would be a way to stall the review), both are plain numbers, or the text the
 * rule would add or remove holds a digit. Every case that gets no rule is shown as a removal and an
 * addition or as a replaced value, which is more change shown, never less. So `A1` and `A10`,
 * `sub-1` and `sub-10`, `Cz` and `FCz`, `A1` and `A1-A2`, `LA12` and `LA1-2` get no rule of any
 * kind: `1` is not `10`, inserted text would join a run that was already there, and a number put
 * in, taken out or split is another name.
 *
 * A rule says that a pair COULD be one name respelled; whether a table pairs it is decided by the
 * evidence of the rest of the row (see {@link diffTable}).
 */
export function relabelRule(
  before: string,
  after: string,
  opts: { chars: boolean },
): RelabelRule | null {
  return relabelNames(nameOf(before), nameOf(after), opts);
}

/** {@link relabelRule} over names whose runs are already known. */
function relabelNames(before: Name, after: Name, opts: { chars: boolean }): RelabelRule | null {
  if (before.text === after.text || before.text === "" || after.text === "") return null;
  if (before.long || after.long) return null;
  if (NUMERIC_TEXT.test(before.text) && NUMERIC_TEXT.test(after.text)) return null;
  if (before.text.toLowerCase() === after.text.toLowerCase()) {
    return { kind: "case", gaps: [], shape: "", repadded: false };
  }
  if (before.runs === null || after.runs === null) return null;
  // One mode for the whole pair: see `Name.numbersAsText`.
  const byRuns = runRule(before.runs, after.runs, before.numbersAsText || after.numbersAsText);
  const found = byRuns ?? (opts.chars ? characterRule(before, after) : null);
  // A number put in or taken out is never a respelling: `A1` to `A1-A2` adds a channel to the name
  // and `A1-A2` to `A2` drops one, and either can be a removed row and an unrelated new one that
  // happen to share text. So a rule whose added or removed text holds a digit is no rule, whichever
  // rule found it, and the pair is shown as a removal and an addition.
  if (found?.gaps.some((gap) => DIGIT_TEXT.test(gap))) return null;
  return found;
}

/** A text that holds a number character anywhere. */
const DIGIT_TEXT = /\p{N}/u;

const REPAD_WORDS = "zero padding of numbers changed";

/** `a`, `a and b`, `a, b and c`. */
function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * A rule in plain English, for the class line. Deterministic, and injective enough that two rules
 * that read the same differ only in text the rule itself holds. The only author text in it is the
 * gap strings, which are written between straight double quotes exactly as they are, with no
 * escaping: the renderer that puts the line in front of the model escapes the whole line, so doing
 * it here too would show the escapes twice. A gap that itself holds a double quote therefore reads
 * ambiguously; the class key is the rule's own fields, not this text, so two such rules still
 * stay two classes.
 */
export function ruleWords(rule: RelabelRule): string {
  const tail = rule.repadded ? `, ${REPAD_WORDS}` : "";
  switch (rule.kind) {
    case "case":
      return "letter case changed";
    case "repad":
      return REPAD_WORDS;
    case "wrap":
    case "strip": {
      const [prefix = "", suffix = ""] = rule.gaps;
      const parts: string[] = [];
      if (prefix !== "") parts.push(`prefix "${prefix}"`);
      if (suffix !== "") parts.push(`suffix "${suffix}"`);
      return `${rule.kind === "wrap" ? "added" : "removed"} ${joinWords(parts)}${tail}`;
    }
    case "insert":
    case "delete": {
      const characters = /^c[0-9]+$/.test(rule.shape);
      const unit = characters ? "character" : "run";
      const places: string[] = [];
      rule.gaps.forEach((gap, i) => {
        if (gap === "") return;
        places.push(`"${gap}" ${i === 0 ? "at the start" : `after ${unit} ${i}`}`);
      });
      const kept = characters
        ? `characters kept: ${rule.shape.slice(1)}`
        : `runs kept: ${[...rule.shape].map((c) => (c === "L" ? "letters" : c === "D" ? "digits" : "a character")).join(", ")}`;
      const verb = rule.kind === "insert" ? "inserted" : "deleted";
      return `${verb} ${joinWords(places)} (${kept})${tail}`;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// JSON leaves (design section 2.3)
// ---------------------------------------------------------------------------------------------

/** A key that can be written after a dot: the rest are written in brackets, so the paths stay unambiguous. */
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One value of a JSON document that is compared as a unit: see {@link flattenJson}. */
export interface JsonLeaf {
  /**
   * Where the leaf is: `.name` for a key that matches `^[A-Za-z_][A-Za-z0-9_]*$`, `["..."]` (JSON
   * escaped) for any other key, `[i]` for an index. The encoding is injective: no two places in a
   * document share a path, and a key `a.b` (`["a.b"]`) is not the key `b` inside `a` (`.a.b`).
   */
  path: string;
  /** The path of the container the leaf is in (`""` for the document itself). */
  parent: string;
  /** The key (verbatim) or, for an element of an array that holds containers, its index as `[i]`. */
  name: string;
  /** The leaf is an object member (it has a key that can be renamed), not an array element. */
  isKey: boolean;
  /**
   * The key of the document's root object that the leaf sits under (`a` for `.a.b[0].c`), or null
   * when the document is not an object or the leaf is the document itself. BIDS inheritance merges
   * sidecars one level deep, at this key, so it is what decides whether a moved leaf still applies
   * (see {@link diffJson}).
   */
  top: string | null;
  /** The leaf's value as canonical JSON text: strings decoded and re-encoded, numbers as written. */
  value: string;
  json: JsonValue;
}

/**
 * The leaves of a document, in source order. An object recurses into its keys, and an EMPTY object
 * is a leaf; an array whose elements are all scalars is ONE leaf whose value is the array's
 * canonical text, and an empty array is a leaf; an array with any object or array element recurses
 * with index paths; a scalar is a leaf. Treating a list of scalars as one value keeps a list that
 * lost an element a CHANGED value, shown whole, instead of a removed index with a shifted tail.
 *
 * Null when a path would be longer than `maxNameChars` code units: every atom of a leaf carries its
 * path or its parent's, so a long path repeated over many leaves would make the cost of a document
 * its leaf count times the path. The length is checked before a path is joined, so no path over
 * the bound is ever built, and the caller refuses the file (`too_large`).
 */
export function flattenJson(root: JsonValue): JsonLeaf[] | null {
  const leaves = leavesWithin(root, Number.POSITIVE_INFINITY);
  return typeof leaves === "string" ? null : leaves;
}

/**
 * The walk of {@link flattenJson}, which also stops once the paths and values of the leaves it has
 * found pass `maxChars` code units together: `too_long` for a path over `maxNameChars`,
 * `over_budget` for `maxChars`, whichever the walk meets first in source order. So a caller with a
 * bound never has a document flattened further than it could hold (see `jsonPart`).
 */
function leavesWithin(root: JsonValue, maxChars: number): JsonLeaf[] | "too_long" | "over_budget" {
  const out: JsonLeaf[] = [];
  const max = SUMMARY_LIMITS.maxNameChars;
  let stop: "too_long" | "over_budget" | null = null;
  let chars = 0;
  const walk = (
    v: JsonValue,
    path: string,
    parent: string,
    name: string,
    isKey: boolean,
    top: string | null,
  ): void => {
    if (v.t === "obj" && v.keys.length > 0) {
      for (const key of v.keys) {
        // A segment is at least the key and one character, so a key that cannot fit is never
        // escaped either.
        if (path.length + key.length + 1 > max) {
          stop = "too_long";
          return;
        }
        const segment = BARE_KEY.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
        if (path.length + segment.length > max) {
          stop = "too_long";
          return;
        }
        // The root (the one place whose path is empty) holds the top-level keys; below them the
        // top-level key is inherited.
        walk(v.v.get(key) as JsonValue, path + segment, path, key, true, path === "" ? key : top);
        if (stop !== null) return;
      }
      return;
    }
    if (v.t === "arr" && v.v.some((item) => item.t === "arr" || item.t === "obj")) {
      for (let i = 0; i < v.v.length; i++) {
        const segment = `[${i}]`;
        if (path.length + segment.length > max) {
          stop = "too_long";
          return;
        }
        walk(v.v[i] as JsonValue, path + segment, path, segment, false, top);
        if (stop !== null) return;
      }
      return;
    }
    const value = canonicalJson(v);
    chars += path.length + value.length;
    if (chars > maxChars) {
      stop = "over_budget";
      return;
    }
    out.push({ path, parent, name, isKey, top, value, json: v });
  };
  walk(root, "", "", "", false, null);
  return stop ?? out;
}

// ---------------------------------------------------------------------------------------------
// The relocation pools (design section 4.6)
// ---------------------------------------------------------------------------------------------

/** One added or modified file of the pull request, both sides as bytes (`before` is null for an added file). */
export interface PoolFile {
  path: string;
  before: Uint8Array | null;
  after: Uint8Array;
}

/** What one table of the pool has that its earlier version did not. */
export interface RowPoolFile {
  /** The table's header after the change, its names joined with a tab. */
  header: string;
  /**
   * The rows (cells joined with a tab) the table has now and did not have before, with how many
   * copies. Counts here are the copies still UNUSED: a diff that relocates a row takes one copy
   * (see {@link diffTable}), so one copy never accounts for two removed rows.
   */
  rows: Map<string, number>;
}

/**
 * The rows a pull request adds, by file, so a row removed from one file can be recognized as kept in
 * another. Built once per run, before any file is diffed, from EVERY added or modified table in the
 * pull request wherever it sits (`sourcedata/` included): a row is only a copy of a removed one if
 * the pool says it is new, and a row that was already in that file proves nothing.
 *
 * A pool is used up by the diffs that read it; build one per run. Which file a copy can serve is
 * fixed by its path (`sourcedata/<one directory>/<the file's full path>`, see `sourcedataFor`), so
 * no two different files can compete for one copy and the order the files are diffed in does not
 * change what either is told. The caller still diffs in sorted path order (design section 4.6), so
 * that nothing about a run depends on the order git listed the files in.
 */
export interface RowPool {
  /** By path. Only files that add at least one row are here. */
  readonly files: ReadonlyMap<string, RowPoolFile>;
  /**
   * The paths in `files` that are exactly `sourcedata/<D>/<F>`, where `D` is ONE path segment, by
   * `F`, sorted. These are the only places a row removed from `F` can be relocated to: the layout
   * the open pull requests use (`sourcedata/channels-removed-2026-10-18/<F>`), and nothing looser.
   * `sourcedata/<F>` itself is not one (it is the file's own path one level down, a place a
   * dataset keeps a real table), and neither is a deeper nesting.
   */
  readonly sourcedataFor: ReadonlyMap<string, readonly string[]>;
}

/** The leaves each JSON file of the pull request has now and did not have before. */
export interface JsonPool {
  /** By path, then leaf path to canonical value. Only files with at least one such leaf are here. */
  readonly files: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Leaf (path and value) to the files that have it as a new leaf, in the order given. */
  readonly byLeaf: ReadonlyMap<string, readonly string[]>;
  /**
   * By top-level key, EVERY JSON file of the pull request whose after document has that key,
   * whether it adds a leaf or not. A sidecar nearer to a file than the one a key was moved to
   * decides the key's value for that file, so a move is checked against all of them (see
   * {@link diffJson}).
   */
  readonly byTopKey: ReadonlyMap<string, readonly string[]>;
  /**
   * The JSON files of the pull request whose after document could not be read, or whose path was
   * listed more than once. Such a file may hold any key, so where it applies to a file nothing can
   * be said to have moved past it.
   */
  readonly unreadable: ReadonlySet<string>;
}

/** The key of {@link JsonPool.byLeaf}: injective in the pair, since both parts are JSON text. */
export function leafKey(path: string, value: string): string {
  return JSON.stringify([path, value]);
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The file a `sourcedata/<D>/<F>` path keeps rows for (`F`), or null for any other path. */
function correspondingFile(path: string): string | null {
  const match = /^sourcedata\/[^/]+\/(.+)$/.exec(path);
  return match === null ? null : (match[1] as string);
}

function sameCells(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((cell, i) => cell === b[i]);
}

/**
 * Build the pools from every added or modified `.tsv` and `.json` file of the pull request.
 *
 * For a table, the pool holds the rows its after side has that its before side did not: the multiset
 * difference when the two headers are equal (a row that was there before is not a copy of anything),
 * and all of the after side's rows otherwise (a new layout makes every row new). For a JSON
 * document, it holds the leaves it has now that it did not have: a leaf at a path whose value
 * changed is new at its new value.
 *
 * **A file that does not parse is skipped, and never an error.** Either side failing to parse (a
 * table that is ragged or not UTF-8, a document with a repeated key) leaves that file out of the
 * pool, so a copy cannot be found in it: the removal it would have explained is shown as a removal,
 * which is more change shown, never less. Nothing is thrown, because the pool is built before any
 * file is diffed and one contributor's bad file must not stop the diffs of the others.
 *
 * **A path listed more than once contributes nothing**: git lists a path once, so two entries are
 * a caller's mistake, and which of them is the file cannot be decided. Keeping one would make the
 * pool depend on the order of `files`; keeping neither means no row or leaf of either can be shown
 * relocated or moved, so the removals they would have explained stay removals. A JSON path listed
 * twice is named `unreadable`, never simply left out: left out, a nearer sidecar that sets a key
 * would no longer stop a move past it, and a removed key would read as moved.
 *
 * **What the pools hold is bounded by `maxPoolChars`** (UTF-16 code units, over the whole pool):
 * a table's header and each distinct new row, as the cells joined with tabs; a JSON document's
 * top-level keys, and for each new leaf its path, its value and its key in `byLeaf`. A file whose
 * pieces would take the total past the bound is left out as one that cannot be read, and the next
 * file is tried: a table is skipped (none of its rows is a copy, so a removal it would have
 * explained stays a removal) and a JSON document is `unreadable` (it is never a home and stops
 * every move past it). A file is counted as it is read and dropped as soon as it passes what is
 * left, so no file is held whole past the bound; a document added whole is not even flattened past
 * it. A document whose leaves pass the bound before its walk reaches a path over `maxNameChars` is
 * therefore `unreadable` rather than kept for its top-level keys alone, the stricter of the two.
 *
 * Which files fit is decided in code-unit path order, whatever the order of `files`; what fits is
 * then added in the order given, which only orders the lists below. So nothing about the pools
 * depends on the order of `files` but the order of the paths within one list, which no reader of
 * the pools depends on.
 */
export function buildPools(files: readonly PoolFile[]): Pools {
  return poolsWithin(files, () => false) as Pools;
}

/** The two pools of a run (see {@link buildPools}). */
type Pools = { rows: RowPool; json: JsonPool };

/** What one pool file adds to the pools: decided for every file before anything is added. */
type PoolPart =
  | { kind: "nothing" }
  | { kind: "unreadable" }
  | { kind: "table"; header: string; rows: Map<string, number>; chars: number }
  | {
      kind: "json";
      topKeys: readonly string[];
      /** Null when the document's leaves are left out (a side that does not parse, a long path). */
      fresh: Map<string, string> | null;
      /** The `byLeaf` key of each entry of `fresh`, in its order. */
      leafKeys: readonly string[];
      chars: number;
    };

const NOTHING: PoolPart = { kind: "nothing" };
const UNREADABLE: PoolPart = { kind: "unreadable" };

/**
 * {@link buildPools}, which checks `expired` before each file, in the order the files are read, and
 * gives null as soon as it is true: the pools of a run that reached its deadline are never used.
 */
function poolsWithin(files: readonly PoolFile[], expired: () => boolean): Pools | null {
  const listed = new Map<string, number>();
  for (const file of files) listed.set(file.path, (listed.get(file.path) ?? 0) + 1);

  // Read in path order, so which files fit `maxPoolChars` does not depend on the order given.
  const order = files
    .map((_, i) => i)
    .sort((a, b) => byCodeUnits(files[a]?.path ?? "", files[b]?.path ?? ""));
  const parts: PoolPart[] = new Array(files.length);
  let room = SUMMARY_LIMITS.maxPoolChars;
  for (const i of order) {
    if (expired()) return null;
    const file = files[i] as PoolFile;
    let part = NOTHING;
    if ((listed.get(file.path) ?? 0) > 1) {
      // Which entry is the document cannot be decided, so it is read as one that could not be
      // read at all: it may hold any key, blocks every move past it, and is never a home.
      if (file.path.endsWith(".json")) part = UNREADABLE;
    } else if (file.path.endsWith(".tsv")) {
      part = tablePart(file, room);
    } else if (file.path.endsWith(".json")) {
      part = jsonPart(file, room);
    }
    if (part.kind === "table" || part.kind === "json") room -= part.chars;
    parts[i] = part;
  }

  const rows = new Map<string, RowPoolFile>();
  const sourcedataFor = new Map<string, string[]>();
  const jsonFiles = new Map<string, Map<string, string>>();
  const byLeaf = new Map<string, string[]>();
  const byTopKey = new Map<string, string[]>();
  const unreadable = new Set<string>();
  const add = (map: Map<string, string[]>, key: string, path: string): void => {
    const listed = map.get(key);
    if (listed === undefined) map.set(key, [path]);
    else listed.push(path);
  };
  for (const [i, file] of files.entries()) {
    const part = parts[i] as PoolPart;
    if (part.kind === "unreadable") {
      unreadable.add(file.path);
    } else if (part.kind === "table") {
      rows.set(file.path, { header: part.header, rows: part.rows });
      const kept = correspondingFile(file.path);
      if (kept !== null) add(sourcedataFor, kept, file.path);
    } else if (part.kind === "json") {
      // Every top-level key the file has now, whether it adds a leaf or not: a file that only
      // changed elsewhere still overrides a farther sidecar under these keys.
      for (const key of part.topKeys) add(byTopKey, key, file.path);
      if (part.fresh === null || part.fresh.size === 0) continue;
      jsonFiles.set(file.path, part.fresh);
      for (const key of part.leafKeys) add(byLeaf, key, file.path);
    }
  }
  // Sorted, so which of two copies of one removed row is taken does not depend on the order of
  // `files`: a relocation names the shape of the place it found the row, and that must not vary.
  for (const listed of sourcedataFor.values()) listed.sort(byCodeUnits);
  return {
    rows: { files: rows, sourcedataFor },
    json: { files: jsonFiles, byLeaf, byTopKey, unreadable },
  };
}

/** What a table adds to the row pool, within `room` code units (see {@link buildPools}). */
function tablePart(file: PoolFile, room: number): PoolPart {
  const after = parseTsv(file.after);
  const before = file.before === null ? null : parseTsv(file.before);
  if (!after.ok || (before !== null && !before.ok)) return NOTHING;
  const known = new Map<string, number>();
  if (before?.ok && sameCells(before.value.header, after.value.header)) {
    for (const row of before.value.rows) {
      const text = row.join("\t");
      known.set(text, (known.get(text) ?? 0) + 1);
    }
  }
  const header = after.value.header.join("\t");
  let chars = header.length;
  const added = new Map<string, number>();
  for (const row of after.value.rows) {
    const text = row.join("\t");
    const have = known.get(text) ?? 0;
    if (have > 0) {
      known.set(text, have - 1);
      continue;
    }
    const copies = added.get(text) ?? 0;
    // A row is held once however many copies there are; the count is a number.
    if (copies === 0) {
      chars += text.length;
      if (chars > room) return NOTHING;
    }
    added.set(text, copies + 1);
  }
  return added.size === 0 ? NOTHING : { kind: "table", header, rows: added, chars };
}

/**
 * What a JSON document adds to the leaf pool, within `room` code units (see {@link buildPools}).
 */
function jsonPart(file: PoolFile, room: number): PoolPart {
  const after = parseJson(file.after);
  if (!after.ok) return UNREADABLE;
  const root = after.value.value;
  const topKeys = root.t === "obj" ? root.keys : [];
  let chars = 0;
  for (const key of topKeys) chars += key.length;
  if (chars > room) return UNREADABLE;
  // A side that does not parse, or a path over `maxNameChars` on either side, leaves the file's
  // leaves out: it keeps its top-level keys, and is never a home.
  const keysOnly: PoolPart = { kind: "json", topKeys, fresh: null, leafKeys: [], chars };
  const before = file.before === null ? null : parseJson(file.before);
  if (before !== null && !before.ok) return keysOnly;
  const beforeLeaves = before === null ? [] : flattenJson(before.value.value);
  if (beforeLeaves === null) return keysOnly;
  // Every leaf of an added document is new, so its walk stops at the room left; which leaves of a
  // modified one are new is known only against its earlier version, so it is walked whole.
  const afterLeaves = leavesWithin(root, before === null ? room - chars : Number.POSITIVE_INFINITY);
  if (afterLeaves === "over_budget") return UNREADABLE;
  if (afterLeaves === "too_long") return keysOnly;
  const had = new Map<string, string>();
  for (const leaf of beforeLeaves) had.set(leaf.path, leaf.value);
  const fresh = new Map<string, string>();
  const leafKeys: string[] = [];
  for (const leaf of afterLeaves) {
    if (had.get(leaf.path) === leaf.value) continue;
    const key = leafKey(leaf.path, leaf.value);
    chars += leaf.path.length + leaf.value.length + key.length;
    if (chars > room) return UNREADABLE;
    fresh.set(leaf.path, leaf.value);
    leafKeys.push(key);
  }
  return { kind: "json", topKeys, fresh, leafKeys, chars };
}

/** Code-unit order, the one order that is the same on every machine and in every locale. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Atoms and the shape of a diff (design sections 4.1 and 6.2)
// ---------------------------------------------------------------------------------------------

/**
 * One difference between two versions of a file. Raw strings throughout: the renderer escapes them
 * when it shows them, and an atom is never shown as it is stored.
 *
 * What each field holds, by kind:
 *
 * - table cells (`cell_*`): `field` is the column, `before` and `after` the cells (null on a side
 *   that has no value to show); `cell_templated` also carries its `rule`.
 * - `key_relabeled`: `field` is the key column, `before` and `after` the two keys, `rule` how one
 *   became the other.
 * - `row_removed`, `row_added`, `row_relocated`: in a keyed table `field` is the key column and the
 *   side holds the KEY; in a keyless table `field` is null and the side holds the whole row, its
 *   cells joined with a tab. `row_relocated` also carries, in `detail`, the shape
 *   ({@link entityPattern}) of the path the row was found at.
 * - `column_removed`: `field` is the column and `detail` the count of its non-missing values, as
 *   decimal text; a column of nothing but missing values is a removal that loses nothing.
 *   `column_added`: `field` is the column.
 * - `columns_reordered`: `before` and `after` are the order of the columns both versions have, joined
 *   with a tab. `rows_reordered` carries nothing: the order of the rows is the whole fact.
 * - `format`: `detail` is the {@link FormatDetail} word for what differs, `before` and
 *   `after` its state on each side.
 * - JSON value kinds (`json_value_changed`, `json_type_changed`, `json_emptied`, `json_filled`):
 *   `field` is the leaf path, `before` and `after` the canonical texts.
 * - JSON key kinds (`json_key_removed`, `json_empty_key_removed`, `json_key_added`,
 *   `json_key_moved`, `json_key_renamed`): `field` is the PARENT path (so many keys of one object are
 *   one class), `detail` the key name (`old -> new` for a rename), and `before`/`after` the value's
 *   canonical text on the side that has it (both, for a rename).
 * - `json_keys_reordered` carries nothing.
 */
export interface Atom {
  kind: ClassKind;
  field: string | null;
  rule: RelabelRule | null;
  detail: string | null;
  before: string | null;
  after: string | null;
}

/**
 * The words a `format` atom's `detail` is one of. The state strings in `before` and `after` are
 * `present`/`absent` for a byte order mark and a final newline, the file-level word
 * (`lf`, `crlf`, `mixed`, `none`) for line endings, and the per-line pattern for a mixed table.
 * `json_respelled` is a JSON document whose tree is equal and whose text differs beyond the
 * whitespace between tokens: a string escape spelled another way (`\u0041` for `A`). It carries
 * no states (`before` and `after` are null), and only {@link summarizeChanges} adds it, because
 * the diff reads trees and the parser keeps no token text (design section 3.2).
 */
export type FormatDetail =
  | "bom"
  | "line_endings"
  | "line_ending_pattern"
  | "final_newline"
  | "json_respelled";

/**
 * The tallies a table diff proves itself total with (design section 6.2). The totals
 * (`beforeRows`, `afterRows`, `beforeColumns`, `afterColumns`) come from the input. Every other
 * field is a tally of what the pairing DECIDED, counted from the fate of each row and from the
 * recorded pairs, never from the atoms; {@link verifyTableCounts} then counts the atoms that were
 * EMITTED and requires the two to agree. So a row that fell through, a row taken twice, and an atom
 * that was dropped or added on the way out each make the check fail.
 */
export interface TableCounts {
  beforeRows: number;
  afterRows: number;
  /** Before rows paired with an after row by equal key (keyed) or equal projection (keyless). */
  matched: number;
  /** Before rows paired by a relabel rule (keyed) or by the near-row rule (keyless). */
  paired: number;
  relocated: number;
  removed: number;
  /** The after side of `matched` and `paired`, counted on the after rows. */
  afterMatched: number;
  afterPaired: number;
  added: number;
  /** Pairs made by a relabel rule: every keyed `paired` row, and no keyless one. */
  relabeled: number;
  /** Compared cells that differ, over every matched and paired row: one cell atom each. */
  cellsChanged: number;
  /** A row was claimed twice. Always 0 unless the diff is wrong. */
  conflicts: number;
  beforeColumns: number;
  afterColumns: number;
  commonColumns: number;
  columnsRemoved: number;
  columnsAdded: number;
}

/**
 * The tallies a JSON diff proves itself total with, over leaves ({@link flattenJson}). The totals
 * come from the input. The fields without a prefix count the BEFORE leaves by what became of them,
 * the `after` ones count the AFTER leaves, and every fate that has a leaf on both sides is counted
 * on each side, so a leaf claimed twice or never makes the sums fail. As for tables, every tally is
 * counted from the fates, and {@link verifyJsonCounts} checks it against the atoms emitted.
 */
export interface JsonCounts {
  beforeLeaves: number;
  afterLeaves: number;
  /** Before leaves whose path the after document has, with an equal value, a changed one (value or type), an emptied one, a filled one. */
  unchanged: number;
  changed: number;
  emptied: number;
  filled: number;
  /** Before leaves that left their path and are the same value under a respelled sibling key. */
  renamed: number;
  /** Before leaves found, with their path and value, in a sidecar that applies (moved), and lost: with a value (removed), holding nothing (emptyRemoved). */
  moved: number;
  removed: number;
  emptyRemoved: number;
  /** After leaves at a path the before document did not have and that are not the new name of a rename. */
  added: number;
  /** The after side of the fates that pair a before leaf with an after leaf. */
  afterUnchanged: number;
  afterChanged: number;
  afterEmptied: number;
  afterFilled: number;
  afterRenamed: number;
  /** A leaf was claimed twice. Always 0 unless the diff is wrong. */
  conflicts: number;
}

/** What a diff of one file is. */
export interface FileDiff<C = TableCounts | JsonCounts> {
  family: "tsv" | "json";
  /** The key column a table was paired by, or null (always null for JSON). */
  keyColumn: string | null;
  atoms: Atom[];
  counts: C;
}

/** Every difference of the two layouts: one atom per field of {@link TextFormat} that differs. */
export function formatAtoms(before: TextFormat, after: TextFormat): Atom[] {
  const atoms: Atom[] = [];
  const word = (flag: boolean): string => (flag ? "present" : "absent");
  const push = (detail: FormatDetail, b: string, a: string): void => {
    atoms.push({ kind: "format", field: null, rule: null, detail, before: b, after: a });
  };
  if (before.bom !== after.bom) push("bom", word(before.bom), word(after.bom));
  if (before.eol !== after.eol) push("line_endings", before.eol, after.eol);
  if (before.crPattern !== after.crPattern) {
    push("line_ending_pattern", before.crPattern, after.crPattern);
  }
  if (before.finalNewline !== after.finalNewline) {
    push("final_newline", word(before.finalNewline), word(after.finalNewline));
  }
  return atoms;
}

// ---------------------------------------------------------------------------------------------
// Table diff (design sections 2.2, 4.4, 4.5 and 4.6)
// ---------------------------------------------------------------------------------------------

/**
 * The column a table's rows are identified by, from its BIDS file name and nothing else (design
 * section 2.2). Never inferred from the data: a key chosen by looking at the values lets the author
 * choose the key by choosing values.
 */
function tableKeyColumn(path: string): string | null {
  if (path === "participants.tsv") return "participant_id";
  if (path === "samples.tsv") return "sample_id";
  const name = lastSegment(path);
  if (name.endsWith("_channels.tsv") || name.endsWith("_electrodes.tsv")) return "name";
  if (name.endsWith("_scans.tsv")) return "filename";
  if (name.endsWith("_sessions.tsv")) return "session_id";
  return null;
}

/** Keys that identify a row: none empty or `n/a`, and no two equal. */
function usableKeys(keys: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const key of keys) {
    if (isMissingCell(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * The most candidates a single key looks at in one lookup, counting the ones already paired. The
 * lookup finds the unpaired keys a key's parts could be, and a hostile table can make thousands of
 * keys share one normalized form (every case variant of one word); without a bound each of them
 * would scan all the others. Counting the paired ones too keeps one lookup's work bounded however
 * the table was paired before it. The bound only ever leaves a key unpaired, which shows it as a
 * removal and an addition: more change, never less.
 */
const LOOKUP_CANDIDATE_CAP = 64;

/**
 * What the pairing passes spend of `maxPairingSteps`. A step is about the cost of one substring
 * looked up in an index (a slice and a map lookup). A candidate pair tried costs its evidence (one
 * comparison per cell) and its relabel rule, whose work grows with the characters of the two names
 * (case, the character rule) and with the product of their run counts (matching the runs of one
 * against the runs of the other), so it is charged by all three: a fixed part, one step per 8
 * characters and compared cells, and one per 8 pairs of runs. The weights follow measured costs,
 * so the budget bounds time, not a count of attempts that can be cheap or dear.
 */
const PROBE_STEPS = 1;
function candidateSteps(keyChars: number, cellCount: number, runPairs: number): number {
  return 4 + ((keyChars + cellCount) >> 3) + (runPairs >> 3);
}

/** A key as the lookup compares it: runs lower-cased and digits by value, with where each run starts. */
interface LookupForm {
  text: string;
  offsets: number[];
}

function lookupForm(name: Name): LookupForm | null {
  if (name.runs === null) return null;
  let text = "";
  const offsets = [0];
  for (const run of name.runs) {
    text += run.norm.toLowerCase();
    offsets.push(text.length);
  }
  return { text, offsets };
}

/**
 * The rows of one side whose keys share a lookup form, in file order, with a cursor past the ones
 * already paired. A row once paired is never unpaired, so the cursor only moves forward, and a run
 * of paired rows at the front of the list is passed once in a pass rather than once per lookup.
 */
interface Bucket {
  rows: number[];
  next: number;
}

/**
 * Every substring of a key that starts and ends on a run boundary and whose form is in `index`, as
 * the buckets that have it, longest first and then leftmost: the order the lookup takes them in.
 * Each substring looked up spends a step; a lookup that runs out of steps finds nothing.
 */
function lookupHits(
  form: LookupForm,
  index: ReadonlyMap<string, Bucket>,
  lengths: ReadonlySet<number>,
  spend: (steps: number) => boolean,
): Bucket[] {
  const hits: { length: number; start: number; bucket: Bucket }[] = [];
  const runs = form.offsets.length - 1;
  for (let i = 0; i < runs; i++) {
    for (let j = i + 1; j <= runs; j++) {
      const length = (form.offsets[j] as number) - (form.offsets[i] as number);
      if (!lengths.has(length)) continue;
      if (!spend(PROBE_STEPS)) return [];
      const bucket = index.get(form.text.slice(form.offsets[i], form.offsets[j]));
      if (bucket !== undefined) hits.push({ length, start: i, bucket });
    }
  }
  hits.sort((x, y) => y.length - x.length || x.start - y.start);
  return hits.map((hit) => hit.bucket);
}

/**
 * The difference between two versions of a table, as atoms, or `internal_mismatch` when the diff is
 * not total. Every before row ends in exactly one of: paired with an after row, relocated, removed;
 * every after row in one of: paired, added; every column in one of: in both, removed, added. The
 * tallies and the atoms are checked against each other ({@link verifyTableCounts}) and a file that
 * does not add up is refused, never summarized.
 *
 * **Keyed tables** (the key column is in both headers, and its values are non-empty, not `n/a` and
 * unique on both sides): rows with the same key are paired; the rest are paired in this order,
 * strongest evidence first, each step taking only rows the one before left:
 *
 * 1. strict relabel by lookup: each added key's parts are looked up among the gone keys, then each
 *    gone key's parts among the added keys (relabel rules without characters);
 * 2. strict relabel by position, where the character rule is allowed too;
 * 3. relocation of what is still unpaired: a row removed here and found verbatim in a row the pull
 *    request adds at `sourcedata/<one directory>/<this path>`;
 * 4. lenient relabel, by lookup and then by position (relabel rules without characters);
 * 5. what is left: removed and added.
 *
 * **What a relabel needs besides its rule** (EQ is the number of the other common cells that are
 * equal AND not missing, DIFF the number that differ). A `case` or `repad` rule needs nothing: it
 * changes how a key is spelled, never which key it is. Every other rule needs evidence, because it
 * changes the key's text, and two keys can share text and be two rows (`A1` and `A1-A2`): in the
 * strict passes DIFF is 0 and EQ is at least 1; in the lenient pass EQ is at least 1 and at least
 * DIFF. The strict passes also take a `case` or `repad` pair only with DIFF 0, so a row whose
 * cells are all equal is paired before a look-alike whose cells changed. A cell equal only because
 * both sides are missing counts for nothing: a table of ids alone, or of `n/a`, has no evidence,
 * and `sub-1` removed with `sub-10` added stays a removal and an addition.
 *
 * The order is the lesson of the first prototype: relocating before relabeling matched renamed rows
 * to identical copies and left their real removals with no copy, and relabeling on the name alone
 * paired a few names with the wrong new row. An error in this order can only turn "relocated" into
 * "relabeled, with changed cells" or into "removed", that is, into more visible change or a loss
 * fact; it cannot make content vanish from the account. What it cannot rule out is a removed row
 * paired with a new row under a rule the evidence allows: that pair is shown as a relabel with its
 * every changed cell, and it is the model's to judge (design section 4.4).
 *
 * **Keyless tables** (every other table, and a keyed one whose keys are not usable) compare rows as
 * a multiset projected on the columns both versions have, then relocate the unmatched rows, then pair
 * what is left in file order only when at most half the common columns differ AND EQ is at least
 * DIFF, so a deleted event and an unrelated new one stay a removal and an addition, and a row whose
 * only equal cells are `n/a` is not called an edit of another. Nothing is ever inferred as a key.
 * `rows_reordered` is decided over every pair, so a keyless row paired as an edit counts toward it.
 *
 * **Relocation** consumes the copy it uses from `pool`: one copy never accounts for two removed
 * rows. The copies are taken only if the diff succeeds, so a file that is refused does not use up
 * copies; and since a copy can serve only the one file its path names, no other file can take it.
 *
 * **The relabel passes share one budget per file** (`maxPairingSteps`): every substring looked up
 * and every candidate pair tried spends from it, and when it is spent no further pair is made. What
 * is still unpaired then is removed and added, exactly as if no rule had held: the budget can only
 * show more change, never pair a row it did not check, and it is spent in the same order on every
 * run, so the result does not depend on the machine. The keyless pairing needs none: it compares
 * at most three pairs of rows per row, each over the common columns, so its work is bounded by the
 * size of the table (a few million cell comparisons at the 8 MiB cap) and could never reach it.
 */
export function diffTable(
  path: string,
  before: Table,
  after: Table,
  pool: RowPool,
): Parsed<FileDiff<TableCounts>> {
  return diffTableWith(path, before, after, pool, verifyTableCounts);
}

/** How many atoms of each kind a list holds. */
function kindCounts(atoms: readonly Atom[]): Record<ClassKind, number> {
  const counts = Object.fromEntries(CLASS_KINDS.map((kind) => [kind, 0])) as Record<
    ClassKind,
    number
  >;
  for (const atom of atoms) counts[atom.kind]++;
  return counts;
}

/**
 * The totality assertion of a table diff (design section 6.2). The tallies were counted from what
 * the pairing decided; this checks that they add up, and then counts the atoms that were EMITTED and
 * requires them to say the same: one `row_removed` per removed row, one `row_added` per added row,
 * one `row_relocated` per relocated row, one `key_relabeled` per relabeled pair (every keyed pair,
 * no keyless one), one cell atom per differing cell of a paired row, one atom per removed and added
 * column, at most one reorder atom of each kind, and no atom of any other kind. A dropped atom, an
 * extra one, or a row that fell through each make it false.
 */
export function verifyTableCounts(diff: FileDiff<TableCounts>): boolean {
  const c = diff.counts;
  const n = kindCounts(diff.atoms);
  const cellAtoms = n.cell_templated + n.cell_replaced + n.cell_emptied + n.cell_filled;
  const known =
    n.row_removed +
    n.row_added +
    n.row_relocated +
    n.key_relabeled +
    cellAtoms +
    n.column_removed +
    n.column_added +
    n.columns_reordered +
    n.rows_reordered +
    n.format;
  return (
    c.conflicts === 0 &&
    c.beforeRows === c.matched + c.paired + c.relocated + c.removed &&
    c.afterRows === c.afterMatched + c.afterPaired + c.added &&
    c.matched === c.afterMatched &&
    c.paired === c.afterPaired &&
    c.beforeColumns === c.commonColumns + c.columnsRemoved &&
    c.afterColumns === c.commonColumns + c.columnsAdded &&
    c.relabeled === (diff.keyColumn === null ? 0 : c.paired) &&
    n.row_removed === c.removed &&
    n.row_added === c.added &&
    n.row_relocated === c.relocated &&
    n.key_relabeled === c.relabeled &&
    cellAtoms === c.cellsChanged &&
    n.column_removed === c.columnsRemoved &&
    n.column_added === c.columnsAdded &&
    n.columns_reordered <= 1 &&
    n.rows_reordered <= 1 &&
    known === diff.atoms.length
  );
}

const FATE_NONE = 0;
const FATE_MATCHED = 1;
const FATE_PAIRED = 2;
const FATE_RELOCATED = 3;
const FATE_REMOVED = 4;
const FATE_ADDED = 5;

interface RowPair {
  before: number;
  after: number;
  relabel: RelabelRule | null;
}

/** The rows a fate array leaves unpaired, in file order. */
function unpairedRows(fate: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < fate.length; i++) if (fate[i] === FATE_NONE) out.push(i);
  return out;
}

/** A value of a lazily filled cache, computed on first use. */
function cached<T>(cache: (T | undefined)[], i: number, compute: () => T): T {
  let value = cache[i];
  if (value === undefined) {
    value = compute();
    cache[i] = value;
  }
  return value;
}

/**
 * {@link diffTable} with the totality check passed in. Production code calls `diffTable`; this
 * exists so a test can hand it a check that fails and prove the guard turns the file into
 * `internal_mismatch`, or a check that counts its calls and prove each diff is checked once.
 */
export function diffTableWith(
  path: string,
  before: Table,
  after: Table,
  pool: RowPool,
  verify: (diff: FileDiff<TableCounts>) => boolean,
): Parsed<FileDiff<TableCounts>> {
  const nb = before.rows.length;
  const na = after.rows.length;

  // Columns: in both (in before order), only before, only after.
  const beforeColumn = new Map(before.header.map((name, i) => [name, i]));
  const afterColumn = new Map(after.header.map((name, i) => [name, i]));
  const common: { name: string; bi: number; ai: number }[] = [];
  const removedColumns: { name: string; bi: number }[] = [];
  for (const [bi, name] of before.header.entries()) {
    const ai = afterColumn.get(name);
    if (ai === undefined) removedColumns.push({ name, bi });
    else common.push({ name, bi, ai });
  }
  const addedColumns = after.header.filter((name) => !beforeColumn.has(name));

  // The key, only if it identifies rows on both sides.
  let keyColumn: string | null = null;
  let keysBefore: string[] = [];
  let keysAfter: string[] = [];
  const wanted = tableKeyColumn(path);
  if (wanted !== null) {
    const kb = beforeColumn.get(wanted);
    const ka = afterColumn.get(wanted);
    if (kb !== undefined && ka !== undefined) {
      const bk = before.rows.map((row) => row[kb] as string);
      const ak = after.rows.map((row) => row[ka] as string);
      if (usableKeys(bk) && usableKeys(ak)) {
        keyColumn = wanted;
        keysBefore = bk;
        keysAfter = ak;
      }
    }
  }
  // The columns compared cell by cell: every common column but the key, so every common column of
  // a keyless table.
  const cells = common.filter((column) => column.name !== keyColumn);

  const bFate = new Uint8Array(nb);
  const aFate = new Uint8Array(na);
  const pairOfBefore = new Int32Array(nb).fill(-1);
  const pairs: RowPair[] = [];
  const relocatedTo = new Map<number, string>();
  let conflicts = 0;

  /** Pair a before row with an after row; a row already claimed is a conflict, never a second claim. */
  const pairRows = (
    bi: number,
    ai: number,
    fate: typeof FATE_MATCHED | typeof FATE_PAIRED,
    relabel: RelabelRule | null,
  ): void => {
    if (bFate[bi] !== FATE_NONE || aFate[ai] !== FATE_NONE) {
      conflicts++;
      return;
    }
    bFate[bi] = fate;
    aFate[ai] = fate;
    pairOfBefore[bi] = pairs.length;
    pairs.push({ before: bi, after: ai, relabel });
  };

  // The step budget every pairing pass spends from (see the doc above).
  let steps = 0;
  const spend = (cost: number): boolean => {
    if (steps >= SUMMARY_LIMITS.maxPairingSteps) return false;
    steps += cost;
    return true;
  };

  // Relocation. The copies taken are held here and applied to the pool only when the diff succeeds.
  // The before header is the one a copy must have: the removed row's cells mean what they mean
  // under it, and a copy under any other header (the after one included) is another row.
  const header = before.header.join("\t");
  const targets = pool.sourcedataFor.get(path) ?? [];
  const taken = new Map<string, Map<string, number>>();
  const relocate = (bi: number): void => {
    const text = (before.rows[bi] as readonly string[]).join("\t");
    for (const target of targets) {
      const entry = pool.files.get(target);
      if (entry === undefined || entry.header !== header) continue;
      const used = taken.get(target)?.get(text) ?? 0;
      if ((entry.rows.get(text) ?? 0) - used <= 0) continue;
      const forTarget = taken.get(target) ?? new Map<string, number>();
      forTarget.set(text, used + 1);
      taken.set(target, forTarget);
      bFate[bi] = FATE_RELOCATED;
      relocatedTo.set(bi, target);
      return;
    }
  };

  if (keyColumn !== null) {
    const afterByKey = new Map(keysAfter.map((key, ai) => [key, ai]));
    for (let bi = 0; bi < nb; bi++) {
      const ai = afterByKey.get(keysBefore[bi] as string);
      if (ai !== undefined) pairRows(bi, ai, FATE_MATCHED, null);
    }

    const beforeNames: (Name | undefined)[] = [];
    const afterNames: (Name | undefined)[] = [];
    const nameBefore = (bi: number): Name =>
      cached(beforeNames, bi, () => nameOf(keysBefore[bi] as string));
    const nameAfter = (ai: number): Name =>
      cached(afterNames, ai, () => nameOf(keysAfter[ai] as string));
    const beforeForms: (LookupForm | null | undefined)[] = [];
    const afterForms: (LookupForm | null | undefined)[] = [];
    const formBefore = (bi: number): LookupForm | null =>
      cached(beforeForms, bi, () => lookupForm(nameBefore(bi)));
    const formAfter = (ai: number): LookupForm | null =>
      cached(afterForms, ai, () => lookupForm(nameAfter(ai)));

    /** EQ and DIFF of a candidate pair over the other common cells: see the doc above. */
    const evidence = (bi: number, ai: number): { equal: number; differ: number } => {
      const b = before.rows[bi] as readonly string[];
      const a = after.rows[ai] as readonly string[];
      let equal = 0;
      let differ = 0;
      for (const column of cells) {
        const cell = b[column.bi] as string;
        if (cell !== a[column.ai]) differ++;
        else if (!isMissingCell(cell)) equal++;
      }
      return { equal, differ };
    };

    /** The rule a candidate pair is relabeled by, or null when it has none or lacks the evidence. */
    const pairable = (
      bi: number,
      ai: number,
      strict: boolean,
      chars: boolean,
    ): RelabelRule | null => {
      const b = nameBefore(bi);
      const a = nameAfter(ai);
      const runPairs = (b.runs?.length ?? 0) * (a.runs?.length ?? 0);
      if (!spend(candidateSteps(b.text.length + a.text.length, cells.length, runPairs))) {
        return null;
      }
      const { equal, differ } = evidence(bi, ai);
      if (strict && differ > 0) return null;
      const rule = relabelNames(b, a, { chars });
      if (rule === null || rule.kind === "case" || rule.kind === "repad") return rule;
      return equal >= 1 && equal >= differ ? rule : null;
    };
    const attempt = (bi: number, ai: number, strict: boolean): boolean => {
      const rule = pairable(bi, ai, strict, false);
      if (rule === null) return false;
      pairRows(bi, ai, FATE_PAIRED, rule);
      return true;
    };

    /** Steps 1 and 4: look each unpaired key's parts up among the other side's unpaired keys. */
    const lookupPass = (strict: boolean): void => {
      const index = (rows: readonly number[], formOf: (row: number) => LookupForm | null) => {
        const byForm = new Map<string, Bucket>();
        const lengths = new Set<number>();
        for (const row of rows) {
          const form = formOf(row);
          if (form === null) continue;
          lengths.add(form.text.length);
          const bucket = byForm.get(form.text);
          if (bucket === undefined) byForm.set(form.text, { rows: [row], next: 0 });
          else bucket.rows.push(row);
        }
        return { byForm, lengths };
      };
      /** Try the rows a key's hits name, in hit order, until one pairs or the cap is reached. */
      const hunt = (
        form: LookupForm,
        found: { byForm: Map<string, Bucket>; lengths: Set<number> },
        fate: Uint8Array,
        tryRow: (row: number) => boolean,
      ): void => {
        let looked = 0;
        for (const bucket of lookupHits(form, found.byForm, found.lengths, spend)) {
          while (
            bucket.next < bucket.rows.length &&
            fate[bucket.rows[bucket.next] as number] !== FATE_NONE
          ) {
            bucket.next++;
          }
          for (let k = bucket.next; k < bucket.rows.length; k++) {
            if (++looked > LOOKUP_CANDIDATE_CAP) return;
            const row = bucket.rows[k] as number;
            if (fate[row] !== FATE_NONE) continue;
            if (tryRow(row)) return;
          }
        }
      };

      // Each added key against the gone keys: the parts of the new name are the old name (a wrap).
      const gone = index(unpairedRows(bFate), formBefore);
      if (gone.byForm.size > 0) {
        for (const ai of unpairedRows(aFate)) {
          const form = formAfter(ai);
          if (form !== null) hunt(form, gone, bFate, (bi) => attempt(bi, ai, strict));
        }
      }
      // Then each gone key against the added keys: the parts of the old name are the new name.
      const added = index(unpairedRows(aFate), formAfter);
      if (added.byForm.size > 0) {
        for (const bi of unpairedRows(bFate)) {
          const form = formBefore(bi);
          if (form !== null) hunt(form, added, aFate, (ai) => attempt(bi, ai, strict));
        }
      }
    };

    /**
     * Steps 2 and 4: walk the unpaired keys of both sides in file order, two pointers. A pair that
     * holds is taken; otherwise the added key is skipped when the gone key pairs with the next one,
     * else the gone key when the next one pairs with the added key, else both.
     */
    const positionalPass = (strict: boolean, chars: boolean): void => {
      const gone = unpairedRows(bFate);
      const added = unpairedRows(aFate);
      let i = 0;
      let j = 0;
      // Once the budget is spent every try returns at once, so the walk only advances its pointers.
      while (i < gone.length && j < added.length) {
        const g = gone[i] as number;
        const a = added[j] as number;
        const here = pairable(g, a, strict, chars);
        if (here !== null) {
          pairRows(g, a, FATE_PAIRED, here);
          i++;
          j++;
          continue;
        }
        const nextAdded = j + 1 < added.length ? (added[j + 1] as number) : -1;
        const skipAdded = nextAdded < 0 ? null : pairable(g, nextAdded, strict, chars);
        if (skipAdded !== null) {
          // This added key belongs to nothing here; the next one is the gone key's.
          pairRows(g, nextAdded, FATE_PAIRED, skipAdded);
          i++;
          j += 2;
          continue;
        }
        const nextGone = i + 1 < gone.length ? (gone[i + 1] as number) : -1;
        const skipGone = nextGone < 0 ? null : pairable(nextGone, a, strict, chars);
        if (skipGone !== null) {
          // This gone key was removed; the next one is the added key's.
          pairRows(nextGone, a, FATE_PAIRED, skipGone);
          i += 2;
          j++;
          continue;
        }
        i++;
        j++;
      }
    };

    lookupPass(true);
    positionalPass(true, true);
    for (const bi of unpairedRows(bFate)) relocate(bi);
    lookupPass(false);
    positionalPass(false, false);
  } else {
    // Keyless: a multiset match on the common columns, in before order for equal rows. A cell holds
    // no tab, so joining with one keeps two different rows two different texts.
    const project = (row: readonly string[], side: "bi" | "ai"): string =>
      cells.map((column) => row[column[side]] as string).join("\t");
    const waiting = new Map<string, { rows: number[]; next: number }>();
    for (let bi = 0; bi < nb; bi++) {
      const text = project(before.rows[bi] as readonly string[], "bi");
      const queue = waiting.get(text);
      if (queue === undefined) waiting.set(text, { rows: [bi], next: 0 });
      else queue.rows.push(bi);
    }
    for (let ai = 0; ai < na; ai++) {
      const queue = waiting.get(project(after.rows[ai] as readonly string[], "ai"));
      if (queue !== undefined && queue.next < queue.rows.length) {
        pairRows(queue.rows[queue.next++] as number, ai, FATE_MATCHED, null);
      }
    }
    for (const bi of unpairedRows(bFate)) relocate(bi);

    /**
     * Two rows are one row, edited, when at most half the common columns differ AND the equal cells
     * that say something are at least as many as the differing ones (design section 4.5). The
     * second half is what keeps `1.0 n/a go n/a n/a` and `9.3 n/a stop n/a n/a` apart: two cells
     * differ and three are equal, but only because they are all missing.
     */
    const near = (bi: number, ai: number): boolean => {
      const b = before.rows[bi] as readonly string[];
      const a = after.rows[ai] as readonly string[];
      let equal = 0;
      let differ = 0;
      for (const column of cells) {
        const cell = b[column.bi] as string;
        if (cell !== a[column.ai]) differ++;
        else if (!isMissingCell(cell)) equal++;
      }
      // The first condition follows from the second (EQ + DIFF is at most the column count); it is
      // kept because it is the design's own statement of what an edit is.
      return differ * 2 <= cells.length && equal >= differ;
    };
    const goneRows = unpairedRows(bFate);
    const addedRows = unpairedRows(aFate);
    let i = 0;
    let j = 0;
    while (i < goneRows.length && j < addedRows.length) {
      const g = goneRows[i] as number;
      const a = addedRows[j] as number;
      if (near(g, a)) {
        pairRows(g, a, FATE_PAIRED, null);
        i++;
        j++;
      } else if (j + 1 < addedRows.length && near(g, addedRows[j + 1] as number)) {
        pairRows(g, addedRows[j + 1] as number, FATE_PAIRED, null);
        i++;
        j += 2;
      } else if (i + 1 < goneRows.length && near(goneRows[i + 1] as number, a)) {
        pairRows(goneRows[i + 1] as number, a, FATE_PAIRED, null);
        i += 2;
        j++;
      } else {
        i++;
        j++;
      }
    }
  }

  // What is left was neither paired nor relocated: removed and added.
  for (let bi = 0; bi < nb; bi++) if (bFate[bi] === FATE_NONE) bFate[bi] = FATE_REMOVED;
  for (let ai = 0; ai < na; ai++) if (aFate[ai] === FATE_NONE) aFate[ai] = FATE_ADDED;

  // The tallies, from the fates and the pairs alone: never from the atoms below, which the check
  // counts on its own.
  const counts: TableCounts = {
    beforeRows: nb,
    afterRows: na,
    matched: 0,
    paired: 0,
    relocated: 0,
    removed: 0,
    afterMatched: 0,
    afterPaired: 0,
    added: 0,
    relabeled: 0,
    cellsChanged: 0,
    conflicts,
    beforeColumns: before.header.length,
    afterColumns: after.header.length,
    commonColumns: common.length,
    columnsRemoved: removedColumns.length,
    columnsAdded: addedColumns.length,
  };
  for (const fate of bFate) {
    if (fate === FATE_MATCHED) counts.matched++;
    else if (fate === FATE_PAIRED) counts.paired++;
    else if (fate === FATE_RELOCATED) counts.relocated++;
    else if (fate === FATE_REMOVED) counts.removed++;
  }
  for (const fate of aFate) {
    if (fate === FATE_MATCHED) counts.afterMatched++;
    else if (fate === FATE_PAIRED) counts.afterPaired++;
    else if (fate === FATE_ADDED) counts.added++;
  }
  for (const pair of pairs) {
    if (pair.relabel !== null) counts.relabeled++;
    const b = before.rows[pair.before] as readonly string[];
    const a = after.rows[pair.after] as readonly string[];
    for (const column of cells) if (b[column.bi] !== a[column.ai]) counts.cellsChanged++;
  }

  // Emission: every atom comes from here.
  const atoms: Atom[] = [];
  for (const column of removedColumns) {
    let present = 0;
    for (const row of before.rows) if (!isMissingCell(row[column.bi] as string)) present++;
    atoms.push({
      kind: "column_removed",
      field: column.name,
      rule: null,
      detail: String(present),
      before: null,
      after: null,
    });
  }
  for (const name of addedColumns) {
    atoms.push({
      kind: "column_added",
      field: name,
      rule: null,
      detail: null,
      before: null,
      after: null,
    });
  }
  const orderBefore = common.map((column) => column.name);
  const orderAfter = [...common].sort((x, y) => x.ai - y.ai).map((column) => column.name);
  if (orderBefore.some((name, i) => name !== orderAfter[i])) {
    atoms.push({
      kind: "columns_reordered",
      field: null,
      rule: null,
      detail: null,
      before: orderBefore.join("\t"),
      after: orderAfter.join("\t"),
    });
  }
  atoms.push(...formatAtoms(before.format, after.format));

  /** What a row is called in an atom: its key in a keyed table, the whole row in a keyless one. */
  const nameOfRow = (rows: Table["rows"], keys: readonly string[], row: number): string =>
    keyColumn === null ? (rows[row] as readonly string[]).join("\t") : (keys[row] as string);

  for (let bi = 0; bi < nb; bi++) {
    const fate = bFate[bi];
    if (fate === FATE_MATCHED || fate === FATE_PAIRED) {
      const pair = pairs[pairOfBefore[bi] as number] as RowPair;
      if (pair.relabel !== null) {
        atoms.push({
          kind: "key_relabeled",
          field: keyColumn,
          rule: pair.relabel,
          detail: null,
          before: keysBefore[bi] as string,
          after: keysAfter[pair.after] as string,
        });
      }
      for (const column of cells) {
        const b = (before.rows[bi] as readonly string[])[column.bi] as string;
        const a = (after.rows[pair.after] as readonly string[])[column.ai] as string;
        if (b !== a) atoms.push(cellAtom(column.name, b, a));
      }
    } else if (fate === FATE_RELOCATED) {
      atoms.push({
        kind: "row_relocated",
        field: keyColumn,
        rule: null,
        detail: entityPattern(relocatedTo.get(bi) as string),
        before: nameOfRow(before.rows, keysBefore, bi),
        after: null,
      });
    } else if (fate === FATE_REMOVED) {
      atoms.push({
        kind: "row_removed",
        field: keyColumn,
        rule: null,
        detail: null,
        before: nameOfRow(before.rows, keysBefore, bi),
        after: null,
      });
    }
  }
  for (let ai = 0; ai < na; ai++) {
    if (aFate[ai] !== FATE_ADDED) continue;
    atoms.push({
      kind: "row_added",
      field: keyColumn,
      rule: null,
      detail: null,
      before: null,
      after: nameOfRow(after.rows, keysAfter, ai),
    });
  }

  // The rows both versions have keep their relative order, or the table is reordered.
  const inBeforeOrder = [...pairs].sort((x, y) => x.before - y.before);
  if (
    inBeforeOrder.some((pair, i) => i > 0 && pair.after < (inBeforeOrder[i - 1] as RowPair).after)
  ) {
    atoms.push({
      kind: "rows_reordered",
      field: null,
      rule: null,
      detail: null,
      before: null,
      after: null,
    });
  }

  const diff: FileDiff<TableCounts> = { family: "tsv", keyColumn, atoms, counts };
  if (!verify(diff)) return { ok: false, refusal: "internal_mismatch" };

  // The diff stands, so the copies it relocated against are used up.
  for (const [target, rows] of taken) {
    const entry = pool.files.get(target) as RowPoolFile;
    for (const [text, used] of rows) entry.rows.set(text, (entry.rows.get(text) as number) - used);
  }
  return { ok: true, value: diff };
}

/** The relabel rules that are templates in a cell: see {@link cellAtom}. */
const CELL_TEMPLATES: ReadonlySet<RelabelRule["kind"]> = new Set(["wrap", "strip", "repad"]);

/**
 * The atom for one table cell that is not equal on the two sides. Only a rule that says the cell was
 * wrapped, stripped or repadded is a template; an insertion, a deletion or a character rule is for
 * names, so in a cell it is a replaced value, and so is a change of letter case: `mV` to `MV` is
 * millivolts to megavolts, and a cell's case is part of its value in a way a key's is not. Two
 * missing cells that differ (`n/a` and empty) are a replaced value too: calling the change anything
 * gentler would hide that the file says something else.
 */
function cellAtom(field: string, before: string, after: string): Atom {
  const missingBefore = isMissingCell(before);
  const missingAfter = isMissingCell(after);
  if (!missingBefore && missingAfter) {
    return { kind: "cell_emptied", field, rule: null, detail: null, before, after };
  }
  if (missingBefore && !missingAfter) {
    return { kind: "cell_filled", field, rule: null, detail: null, before, after };
  }
  if (!missingBefore && !missingAfter) {
    const rule = relabelRule(before, after, { chars: false });
    if (rule !== null && CELL_TEMPLATES.has(rule.kind)) {
      return { kind: "cell_templated", field, rule, detail: null, before, after };
    }
  }
  return { kind: "cell_replaced", field, rule: null, detail: null, before, after };
}

// ---------------------------------------------------------------------------------------------
// JSON diff (design sections 2.3, 4.6 and 4.7)
// ---------------------------------------------------------------------------------------------

/**
 * A BIDS file name as the inheritance rule reads it: the directory, the suffix (the last
 * underscore-separated part), the extension, and the `key-value` entities before the suffix. A name
 * with any other shape (a part before the suffix that is not `key-value`, no suffix, no extension)
 * is not one this rule can reason about, and gets null: the rule then cannot say a key was kept
 * elsewhere, so the key stays a removed key, which is a loss fact and never a quiet pass.
 */
function bidsName(
  path: string,
): { dir: string; suffix: string; extension: string; entities: ReadonlySet<string> } | null {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash);
  const name = path.slice(slash + 1);
  const dot = name.indexOf(".");
  if (dot <= 0) return null;
  const parts = name.slice(0, dot).split("_");
  const suffix = parts[parts.length - 1] as string;
  if (!/^[A-Za-z0-9]+$/.test(suffix)) return null;
  const entities = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    if (!/^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(part)) return null;
    entities.add(part);
  }
  return { dir, suffix, extension: name.slice(dot), entities };
}

/**
 * Of the `sidecars` that apply to `target` under BIDS inheritance, the one whose value of a key the
 * target sees: the nearest, that is the deepest directory, and in one directory the one whose name
 * holds the most entities. Null when none applies, or when two are equally near: BIDS gives no
 * order between those, so which one wins cannot be decided here and nothing is said to reach the
 * target through either.
 */
function nearestSidecar(target: string, sidecars: readonly string[]): string | null {
  let best: string | null = null;
  let bestRank: readonly [number, number] = [-1, -1];
  let tie = false;
  for (const sidecar of new Set(sidecars)) {
    if (!sidecarApplies(sidecar, target)) continue;
    const name = bidsName(sidecar) as NonNullable<ReturnType<typeof bidsName>>;
    const rank = [name.dir === "" ? 0 : name.dir.split("/").length, name.entities.size] as const;
    const order = rank[0] - bestRank[0] || rank[1] - bestRank[1];
    if (order > 0) {
      best = sidecar;
      bestRank = rank;
      tie = false;
    } else if (order === 0) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/**
 * Whether the JSON file `sidecar` applies to the file `target` under BIDS inheritance, as far as
 * this module reads it (design section 4.6): it sits in the target's directory or in an ancestor of
 * it, it has the same suffix and the same extension, and every `key-value` entity of its name is in
 * the target's name. A sidecar in a sibling or a deeper directory, with another suffix, or naming an
 * entity the target does not have, applies to no file of the target's, so a key moved there has not
 * been kept for the target.
 */
export function sidecarApplies(sidecar: string, target: string): boolean {
  if (sidecar === target) return false;
  const t = bidsName(sidecar);
  const f = bidsName(target);
  if (t === null || f === null) return false;
  if (t.suffix !== f.suffix || t.extension !== f.extension) return false;
  const inherited = t.dir === "" || f.dir === t.dir || f.dir.startsWith(`${t.dir}/`);
  if (!inherited) return false;
  for (const entity of t.entities) if (!f.entities.has(entity)) return false;
  return true;
}

/**
 * Which pool files can change what a run says about `candidates`: the predicate, built once per run
 * from the candidates' paths, that {@link summarizeChanges} prunes its pool with, and that the
 * evidence reader applies before it reads a pool file's blobs.
 *
 * A diff consults the pools for one candidate at a time, and only in two ways:
 *
 * - a table diff reads the rows of the pool tables at `sourcedata/<D>/<the candidate's path>`
 *   (`sourcedataFor`), and no other table: a table is kept when it is such a copy of a candidate;
 * - a JSON diff asks, per removed leaf, which file of the pull request that applies to the
 *   candidate under BIDS inheritance ({@link sidecarApplies}) and has the leaf's top-level key, or
 *   is unreadable, is the nearest, and then whether THAT file is a home of the leaf (see
 *   {@link diffJson}): a document is kept when it applies to some candidate.
 *
 * A file this says false for is therefore never a copy, a decider, a blocker or a home for any
 * candidate, and the pools without it answer every one of those questions as the pools with it
 * do; a test compares whole summaries with and without it on generated pull requests. Any other
 * extension is never pooled, `.JSON` included. What the pruning does change is the room the files
 * that do matter have within `maxPoolChars` and `maxTotalBytes`, which is only ever more.
 *
 * One pool path is answered by a lookup and a scan of few candidates: they are indexed by
 * extension, suffix and each of their ancestor directories, then by entity, and a sidecar is
 * checked only against the candidates that hold the rarest of its entities.
 */
export function poolFileMatters(candidates: readonly string[]): (path: string) => boolean {
  const tables = new Set<string>();
  type Indexed = { path: string; entities: ReadonlySet<string> };
  const near = new Map<string, { all: Indexed[]; byEntity: Map<string, Indexed[]> }>();
  const bucketKey = (extension: string, suffix: string, dir: string): string =>
    JSON.stringify([extension, suffix, dir]);
  for (const path of candidates) {
    if (path.endsWith(".tsv")) tables.add(path);
    const name = bidsName(path);
    if (name === null) continue;
    const indexed: Indexed = { path, entities: name.entities };
    // Every directory a sidecar may sit in to apply to this candidate: the root, each ancestor and
    // its own (see `sidecarApplies`).
    const dirs = new Set(["", name.dir]);
    for (let at = name.dir.indexOf("/"); at >= 0; at = name.dir.indexOf("/", at + 1)) {
      dirs.add(name.dir.slice(0, at));
    }
    for (const dir of dirs) {
      const key = bucketKey(name.extension, name.suffix, dir);
      let bucket = near.get(key);
      if (bucket === undefined) {
        bucket = { all: [], byEntity: new Map() };
        near.set(key, bucket);
      }
      bucket.all.push(indexed);
      for (const entity of name.entities) {
        const listed = bucket.byEntity.get(entity);
        if (listed === undefined) bucket.byEntity.set(entity, [indexed]);
        else listed.push(indexed);
      }
    }
  }
  return (path: string): boolean => {
    if (path.endsWith(".tsv")) {
      const kept = correspondingFile(path);
      return kept !== null && tables.has(kept);
    }
    if (!path.endsWith(".json")) return false;
    const name = bidsName(path);
    if (name === null) return false;
    const bucket = near.get(bucketKey(name.extension, name.suffix, name.dir));
    if (bucket === undefined) return false;
    let fewest = bucket.all;
    for (const entity of name.entities) {
      const listed = bucket.byEntity.get(entity);
      if (listed === undefined) return false;
      if (listed.length < fewest.length) fewest = listed;
    }
    return fewest.some(
      (c) => c.path !== path && [...name.entities].every((entity) => c.entities.has(entity)),
    );
  };
}

/**
 * A name with case and punctuation removed, so `MISC_Channel-Count` and `MiscChannelCount` fold
 * alike. Punctuation between two digits is part of a number and stays: `1.2` is not `12`, and `0.5`
 * is not `05`, so a key renamed from one to the other is not a respelling.
 */
function foldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, (run: string, at: number, whole: string) =>
      DIGIT_BEFORE.test(whole.slice(Math.max(0, at - 2), at)) &&
      DIGIT_AFTER.test(whole.slice(at + run.length, at + run.length + 2))
        ? run
        : "",
    );
}

/** A digit ends (or starts) the text: two code units cover a digit outside the basic plane. */
const DIGIT_BEFORE = /\p{N}$/u;
const DIGIT_AFTER = /^\p{N}/u;

const JSON_FATE_NONE = 0;
const JSON_FATE_UNCHANGED = 1;
const JSON_FATE_CHANGED = 2;
const JSON_FATE_EMPTIED = 3;
const JSON_FATE_FILLED = 4;
const JSON_FATE_RENAMED = 5;
const JSON_FATE_MOVED = 6;
const JSON_FATE_REMOVED = 7;
const JSON_FATE_EMPTY_REMOVED = 8;
const JSON_FATE_ADDED = 9;

/**
 * The totality assertion of a JSON diff (design section 6.2). The tallies were counted from the
 * fate of each leaf; this checks that they add up on both sides and pair one to one, and then counts
 * the atoms that were EMITTED and requires them to say the same, kind by kind: one
 * `json_value_changed` or `json_type_changed` per changed leaf, one `json_emptied`, `json_filled`,
 * `json_key_renamed`, `json_key_moved`, `json_key_removed`, `json_empty_key_removed` and
 * `json_key_added` per leaf of that fate, at most one `json_keys_reordered`, and no atom of any other
 * kind. A dropped atom, an extra one, or a leaf that fell through each make it false.
 */
export function verifyJsonCounts(diff: FileDiff<JsonCounts>): boolean {
  const c = diff.counts;
  const n = kindCounts(diff.atoms);
  const known =
    n.json_value_changed +
    n.json_type_changed +
    n.json_emptied +
    n.json_filled +
    n.json_key_renamed +
    n.json_key_moved +
    n.json_key_removed +
    n.json_empty_key_removed +
    n.json_key_added +
    n.json_keys_reordered;
  return (
    c.conflicts === 0 &&
    c.beforeLeaves ===
      c.unchanged +
        c.changed +
        c.emptied +
        c.filled +
        c.renamed +
        c.moved +
        c.removed +
        c.emptyRemoved &&
    c.afterLeaves ===
      c.afterUnchanged +
        c.afterChanged +
        c.afterEmptied +
        c.afterFilled +
        c.afterRenamed +
        c.added &&
    c.unchanged === c.afterUnchanged &&
    c.changed === c.afterChanged &&
    c.emptied === c.afterEmptied &&
    c.filled === c.afterFilled &&
    c.renamed === c.afterRenamed &&
    n.json_value_changed + n.json_type_changed === c.changed &&
    n.json_emptied === c.emptied &&
    n.json_filled === c.filled &&
    n.json_key_renamed === c.renamed &&
    n.json_key_moved === c.moved &&
    n.json_key_removed === c.removed &&
    n.json_empty_key_removed === c.emptyRemoved &&
    n.json_key_added === c.added &&
    n.json_keys_reordered <= 1 &&
    known === diff.atoms.length
  );
}

/**
 * The difference between two versions of a JSON document, as atoms, or `internal_mismatch` when the
 * diff is not total, or `too_large` when a path of either is longer than `maxNameChars` (checked
 * before the path is built). Both documents are flattened to leaves ({@link flattenJson}); every
 * before leaf ends in exactly one of: unchanged, changed (value or type), emptied, filled, renamed,
 * moved, removed (with a value, or without one); every after leaf in one of: unchanged, changed,
 * emptied, filled, renamed, added. The tallies and the atoms are checked against each other
 * ({@link verifyJsonCounts}).
 *
 * Leaves at the same path are compared first. A before leaf whose path is gone is then, in order:
 *
 * - **renamed** (`json_key_renamed`) when it is the ONLY before leaf with its parent and value, ONE
 *   after leaf has that parent and value, and the two key names fold to the same (case and
 *   punctuation removed, except punctuation between two digits) or match by a relabel rule. A shared value is no evidence of which key
 *   became which: with `go` and `go2` both `"Go"`, `go` removed and `go3` added is a removed key
 *   and an added one, not `go` renamed.
 * - **moved** (`json_key_moved`) when this file's after document is an object that no longer has
 *   the leaf's top-level key at all, and the NEAREST file of the pull request that applies to this
 *   one under BIDS inheritance ({@link sidecarApplies}) and has that top-level key holds the leaf,
 *   with its path and value, as a leaf it did not have before. Inheritance merges sidecars one
 *   level deep: the nearest file that has a top-level key gives its whole value under it, so a
 *   nested leaf removed from a key this file keeps is gone, and a key moved to a farther file is
 *   overridden by a nearer one that sets it (see `nearestSidecar` for nearness and ties). What the
 *   module cannot see is an UNCHANGED sidecar between the two; that limit is the model's to weigh
 *   (design section 4.6).
 * - otherwise **removed**: a loss (`json_key_removed`), or a modification
 *   (`json_empty_key_removed`) when the value held nothing ({@link isMissingJson}), because nothing
 *   was lost.
 *
 * The rename pass is linear by construction (one candidate per leaf), so unlike a table diff it
 * needs no step budget. The `format` of a document (its byte order mark and line endings) is not
 * in the parsed value, so it is not in this diff; {@link formatAtoms} gives it from the two
 * {@link TextFormat}s the parser returned.
 */
export function diffJson(
  path: string,
  before: JsonValue,
  after: JsonValue,
  pool: JsonPool,
): Parsed<FileDiff<JsonCounts>> {
  return diffJsonWith(path, before, after, pool, verifyJsonCounts);
}

/**
 * {@link diffJson} with the totality check passed in, so a test can prove a failing check turns the
 * file into `internal_mismatch`, or count the checks a run makes.
 */
export function diffJsonWith(
  path: string,
  before: JsonValue,
  after: JsonValue,
  pool: JsonPool,
  verify: (diff: FileDiff<JsonCounts>) => boolean,
): Parsed<FileDiff<JsonCounts>> {
  const bl = flattenJson(before);
  const al = flattenJson(after);
  if (bl === null || al === null) return { ok: false, refusal: "too_large" };
  const bFate = new Uint8Array(bl.length);
  const aFate = new Uint8Array(al.length);
  const pairOfBefore = new Int32Array(bl.length).fill(-1);
  const pairs: { before: number; after: number }[] = [];
  let conflicts = 0;

  const pairLeaves = (bi: number, ai: number, fate: number): void => {
    if (bFate[bi] !== JSON_FATE_NONE || aFate[ai] !== JSON_FATE_NONE) {
      conflicts++;
      return;
    }
    bFate[bi] = fate;
    aFate[ai] = fate;
    pairOfBefore[bi] = pairs.length;
    pairs.push({ before: bi, after: ai });
  };

  // 1. Leaves at the same path.
  const afterAt = new Map(al.map((leaf, ai) => [leaf.path, ai]));
  for (const [bi, leaf] of bl.entries()) {
    const ai = afterAt.get(leaf.path);
    if (ai === undefined) continue;
    const now = al[ai] as JsonLeaf;
    if (leaf.value === now.value) {
      pairLeaves(bi, ai, JSON_FATE_UNCHANGED);
      continue;
    }
    const wasMissing = isMissingJson(leaf.json);
    const isMissing = isMissingJson(now.json);
    if (!wasMissing && isMissing) pairLeaves(bi, ai, JSON_FATE_EMPTIED);
    else if (wasMissing && !isMissing) pairLeaves(bi, ai, JSON_FATE_FILLED);
    else pairLeaves(bi, ai, JSON_FATE_CHANGED);
  }

  // 2. Renames: the one leaf with a parent and value on each side, under a respelled key. With the
  // value unique on both sides a before leaf has at most one candidate, and a relabel rule refuses a
  // name over `maxKeyChars` before it reads it, so the pass is linear in the document and needs no
  // step budget.
  const groupOf = (leaf: JsonLeaf): string => JSON.stringify([leaf.parent, leaf.value]);
  const beforeInGroup = new Map<string, number>();
  for (const leaf of bl) {
    const group = groupOf(leaf);
    beforeInGroup.set(group, (beforeInGroup.get(group) ?? 0) + 1);
  }
  // The index of the one after leaf of each group, or -1 when the group has more than one.
  const afterOfGroup = new Map<string, number>();
  for (const [ai, leaf] of al.entries()) {
    const group = groupOf(leaf);
    afterOfGroup.set(group, afterOfGroup.has(group) ? -1 : ai);
  }
  for (const [bi, leaf] of bl.entries()) {
    if (bFate[bi] !== JSON_FATE_NONE || !leaf.isKey) continue;
    const group = groupOf(leaf);
    const ai = afterOfGroup.get(group);
    if (beforeInGroup.get(group) !== 1 || ai === undefined || ai < 0) continue;
    const now = al[ai] as JsonLeaf;
    if (aFate[ai] !== JSON_FATE_NONE || !now.isKey) continue;
    if (
      foldName(leaf.name) === foldName(now.name) ||
      relabelRule(leaf.name, now.name, { chars: false }) !== null
    ) {
      pairLeaves(bi, ai, JSON_FATE_RENAMED);
    }
  }

  // 3. What is left of the before side: kept in a sidecar that applies, or removed. A non-object
  // after document has no keys for a sidecar to merge under, so nothing in it is moved.
  const keptKeys = after.t === "obj" ? after.v : null;
  const nearestByKey = new Map<string, string | null>();
  const nearest = (key: string): string | null => {
    let found = nearestByKey.get(key);
    if (found === undefined) {
      // An unreadable file can be the nearest; it is never a home, so it keeps the leaf removed.
      found = nearestSidecar(path, [...(pool.byTopKey.get(key) ?? []), ...pool.unreadable]);
      nearestByKey.set(key, found);
    }
    return found;
  };
  for (const [bi, leaf] of bl.entries()) {
    if (bFate[bi] !== JSON_FATE_NONE) continue;
    const unshadowed = leaf.top !== null && keptKeys !== null && !keptKeys.has(leaf.top);
    const decider = unshadowed ? nearest(leaf.top as string) : null;
    const homes = decider === null ? [] : (pool.byLeaf.get(leafKey(leaf.path, leaf.value)) ?? []);
    if (decider !== null && homes.includes(decider)) bFate[bi] = JSON_FATE_MOVED;
    else bFate[bi] = isMissingJson(leaf.json) ? JSON_FATE_EMPTY_REMOVED : JSON_FATE_REMOVED;
  }
  // 4. What is left of the after side is new.
  for (let ai = 0; ai < al.length; ai++)
    if (aFate[ai] === JSON_FATE_NONE) aFate[ai] = JSON_FATE_ADDED;

  // The tallies, from the fates alone: never from the atoms below, which the check counts.
  const counts: JsonCounts = {
    beforeLeaves: bl.length,
    afterLeaves: al.length,
    unchanged: 0,
    changed: 0,
    emptied: 0,
    filled: 0,
    renamed: 0,
    afterRenamed: 0,
    moved: 0,
    removed: 0,
    emptyRemoved: 0,
    added: 0,
    afterUnchanged: 0,
    afterChanged: 0,
    afterEmptied: 0,
    afterFilled: 0,
    conflicts,
  };
  for (const fate of bFate) {
    if (fate === JSON_FATE_UNCHANGED) counts.unchanged++;
    else if (fate === JSON_FATE_CHANGED) counts.changed++;
    else if (fate === JSON_FATE_EMPTIED) counts.emptied++;
    else if (fate === JSON_FATE_FILLED) counts.filled++;
    else if (fate === JSON_FATE_RENAMED) counts.renamed++;
    else if (fate === JSON_FATE_MOVED) counts.moved++;
    else if (fate === JSON_FATE_REMOVED) counts.removed++;
    else if (fate === JSON_FATE_EMPTY_REMOVED) counts.emptyRemoved++;
  }
  for (const fate of aFate) {
    if (fate === JSON_FATE_UNCHANGED) counts.afterUnchanged++;
    else if (fate === JSON_FATE_CHANGED) counts.afterChanged++;
    else if (fate === JSON_FATE_EMPTIED) counts.afterEmptied++;
    else if (fate === JSON_FATE_FILLED) counts.afterFilled++;
    else if (fate === JSON_FATE_RENAMED) counts.afterRenamed++;
    else if (fate === JSON_FATE_ADDED) counts.added++;
  }

  // Emission: every atom comes from here.
  const atoms: Atom[] = [];
  const keyAtom = (kind: ClassKind, leaf: JsonLeaf, side: "before" | "after"): Atom => ({
    kind,
    field: leaf.parent,
    rule: null,
    detail: leaf.name,
    before: side === "before" ? leaf.value : null,
    after: side === "after" ? leaf.value : null,
  });

  for (const [bi, leaf] of bl.entries()) {
    const fate = bFate[bi];
    const partner = (): JsonLeaf =>
      al[(pairs[pairOfBefore[bi] as number] as { after: number }).after] as JsonLeaf;
    if (fate === JSON_FATE_CHANGED || fate === JSON_FATE_EMPTIED || fate === JSON_FATE_FILLED) {
      const now = partner();
      const kind: ClassKind =
        fate === JSON_FATE_EMPTIED
          ? "json_emptied"
          : fate === JSON_FATE_FILLED
            ? "json_filled"
            : leaf.json.t !== now.json.t
              ? "json_type_changed"
              : "json_value_changed";
      atoms.push({
        kind,
        field: leaf.path,
        rule: null,
        detail: null,
        before: leaf.value,
        after: now.value,
      });
    } else if (fate === JSON_FATE_RENAMED) {
      atoms.push({
        kind: "json_key_renamed",
        field: leaf.parent,
        rule: null,
        detail: `${leaf.name} -> ${partner().name}`,
        before: leaf.value,
        after: leaf.value,
      });
    } else if (fate === JSON_FATE_MOVED) {
      atoms.push(keyAtom("json_key_moved", leaf, "before"));
    } else if (fate === JSON_FATE_REMOVED) {
      atoms.push(keyAtom("json_key_removed", leaf, "before"));
    } else if (fate === JSON_FATE_EMPTY_REMOVED) {
      atoms.push(keyAtom("json_empty_key_removed", leaf, "before"));
    }
  }
  for (const [ai, leaf] of al.entries()) {
    if (aFate[ai] === JSON_FATE_ADDED) atoms.push(keyAtom("json_key_added", leaf, "after"));
  }

  // The leaves both versions have keep their relative order, or the document's keys are reordered.
  const inBeforeOrder = [...pairs].sort((x, y) => x.before - y.before);
  if (
    inBeforeOrder.some(
      (pair, i) => i > 0 && pair.after < (inBeforeOrder[i - 1] as { after: number }).after,
    )
  ) {
    atoms.push({
      kind: "json_keys_reordered",
      field: null,
      rule: null,
      detail: null,
      before: null,
      after: null,
    });
  }

  const diff: FileDiff<JsonCounts> = { family: "json", keyColumn: null, atoms, counts };
  if (!verify(diff)) return { ok: false, refusal: "internal_mismatch" };
  return { ok: true, value: diff };
}

// ---------------------------------------------------------------------------------------------
// Change classes (design sections 4.2 and 5.1)
// ---------------------------------------------------------------------------------------------

/**
 * The words a class of each kind is called by, in the class table of the facts block and on the
 * class line of the fenced block. Closed phrases written by the platform, one per kind and no two
 * alike, so a class line names its kind exactly and no author text is ever in the facts. A
 * `Record` over {@link ClassKind}, so a kind added without words does not compile.
 */
export const KIND_WORDS: Readonly<Record<ClassKind, string>> = {
  column_removed: "columns removed",
  row_removed: "rows removed",
  json_key_removed: "keys removed",
  row_relocated: "rows removed and found verbatim in a row this pull request adds",
  json_key_moved: "keys moved to a sidecar that applies by inheritance",
  key_relabeled: "rows relabeled",
  cell_templated: "cells changed by a rule",
  cell_replaced: "cells replaced",
  cell_emptied: "cells emptied",
  json_value_changed: "values changed",
  json_type_changed: "value types changed",
  json_emptied: "values emptied",
  json_key_renamed: "keys renamed",
  json_empty_key_removed: "keys without a value removed",
  rows_reordered: "row order changed",
  columns_reordered: "column order changed",
  json_keys_reordered: "key order changed",
  format: "file layout changed",
  column_added: "columns added",
  row_added: "rows added",
  cell_filled: "cells filled",
  json_key_added: "keys added",
  json_filled: "values filled",
};

/**
 * What showing a class of a kind COMPLETELY takes (design section 5.3).
 *
 * - `pairs`: every distinct before and after value, with its count, and no value cut. The kinds
 *   whose atoms say "this value became that one", where only the values say what was lost.
 * - `removals`: the same for kinds with one side only (a removed row's key or row text, a removed
 *   key's `name = value`).
 * - `rule`: the class line, whose rule is the full description (a relabel rule, the place a row
 *   was found, a rename, the fact of a reorder or a layout change); examples only illustrate.
 * - `additive`: nothing. New content removes nothing, so coverage never needs it shown.
 *
 * A `Record` over {@link ClassKind}: a kind added without saying how it is shown does not compile,
 * because a kind that defaulted to `rule` or `additive` would let a class be called complete
 * without its values.
 */
export type ClassDisplay = "pairs" | "removals" | "rule" | "additive";
export const DISPLAY_OF: Readonly<Record<ClassKind, ClassDisplay>> = {
  column_removed: "rule",
  row_removed: "removals",
  json_key_removed: "removals",
  row_relocated: "rule",
  json_key_moved: "rule",
  key_relabeled: "rule",
  cell_templated: "rule",
  cell_replaced: "pairs",
  cell_emptied: "pairs",
  json_value_changed: "pairs",
  json_type_changed: "pairs",
  json_emptied: "pairs",
  json_key_renamed: "rule",
  json_empty_key_removed: "removals",
  rows_reordered: "rule",
  columns_reordered: "rule",
  json_keys_reordered: "rule",
  format: "rule",
  column_added: "additive",
  row_added: "additive",
  cell_filled: "additive",
  json_key_added: "additive",
  json_filled: "additive",
};

/**
 * One change, repeated: every atom of every file that has the same kind, path shape, field, rule
 * and detail (design section 4.2). One edit made to 125 subjects is one class with a count, and an
 * edit that differs in any of those is another class.
 */
export interface ChangeClass {
  /** The JSON text of `[kind, shape, field, rule, detail]`: unique per class, stable within a run. */
  key: string;
  kind: ClassKind;
  /** The path with every BIDS entity value written `*` ({@link entityPattern}). */
  shape: string;
  /**
   * The column for a table kind; for a JSON kind the leaf path (value kinds) or the parent path
   * (key kinds), with every array index written `[*]` ({@link foldIndices}); null for the kinds
   * that have none (the reorders, `format`, and a row kind of a keyless table).
   */
  field: string | null;
  /** The relabel rule, for `key_relabeled` and `cell_templated`; null otherwise. */
  rule: RelabelRule | null;
  /**
   * Part of the key for three kinds only: the {@link FormatDetail} word of `format`, the target
   * shape of `row_relocated`, and the `old -> new` names of `json_key_renamed`. Null otherwise:
   * a removed column's count, a key's name and every value are what a class is made OF, not what
   * it is.
   */
  detail: string | null;
  /** The files that have an atom of the class, in review order. */
  files: ReadonlySet<string>;
  /** How many atoms the class holds. */
  items: number;
  /**
   * For the `pairs` and `removals` kinds ({@link DISPLAY_OF}), each distinct value pair as the
   * text `before + U+0000 + after` with how many atoms have it; empty for every other kind. The
   * before side of a removal is the removed key or row text, or `name = value` for a JSON key, and
   * its after side is empty. No after side can hold U+0000 (a table refuses a NUL byte, and
   * canonical JSON escapes it), so the LAST U+0000 is always the separator, while a JSON key name
   * on the before side may hold one.
   */
  pairs: ReadonlyMap<string, number>;
  /**
   * Up to `samplesPerClass` examples, each a file path and what in it changed (a row's key, a key's
   * name, a cell's two values), already rendered for the prompt: the first atom of each of the
   * first files in review order, or, when the class is in one file only, its first atoms there.
   * Rendered only for the first `maxClasses` classes in render order, the only ones that can be
   * shown; every later class has none, and is never shown.
   */
  examples: readonly string[];
  /**
   * The path of one of the examples was cut at `maxValueChars` code points. The examples only
   * illustrate, but a path is a token of the block's grammar like the shape (design section 8.2),
   * so a cut one cuts the class line and the class is incomplete. False when there are no examples.
   */
  examplePathCut: boolean;
}

/** One file's atoms, as {@link classify} groups them. */
export interface FileAtoms {
  path: string;
  atoms: readonly Atom[];
}

/** The kinds whose `detail` is part of the class key: see {@link ChangeClass.detail}. */
const DETAIL_IN_KEY: ReadonlySet<ClassKind> = new Set([
  "format",
  "row_relocated",
  "json_key_renamed",
]);

/**
 * A JSON path with every array index written `[*]`, so the same edit in every element of a list is
 * one class. A key in brackets (`["a b"]`, JSON-escaped) is passed over whole, so a key that reads
 * `[0]` is never taken for an index: only a bracket of digits is one.
 */
export function foldIndices(path: string): string {
  return path.replace(/(\["(?:[^"\\]|\\.)*"\])|\[[0-9]+\]/g, (match, key: string | undefined) =>
    key === undefined ? "[*]" : match,
  );
}

/** What names a class: see {@link ChangeClass}. */
type ClassIdentity = Pick<ChangeClass, "key" | "kind" | "shape" | "field" | "rule" | "detail">;

/** The identity of the class an atom of a file belongs to: see {@link ChangeClass}. */
export function classKeyOf(path: string, atom: Atom): ClassIdentity {
  return classIdentity(entityPattern(path), atom);
}

/** {@link classKeyOf} with the file's shape already known: it is the same for all its atoms. */
function classIdentity(shape: string, atom: Atom): ClassIdentity {
  // A table's column name is the author's text and is never folded; a JSON path is the module's.
  const field =
    atom.field === null
      ? null
      : atom.kind.startsWith("json_")
        ? foldIndices(atom.field)
        : atom.field;
  const rule = atom.kind === "key_relabeled" || atom.kind === "cell_templated" ? atom.rule : null;
  const detail = DETAIL_IN_KEY.has(atom.kind) ? atom.detail : null;
  // The rule by its fields in a fixed order, so two equal rules are one key however they were built.
  const ruleKey = rule === null ? null : [rule.kind, rule.gaps, rule.shape, rule.repadded];
  const key = JSON.stringify([atom.kind, shape, field, ruleKey, detail]);
  return { key, kind: atom.kind, shape, field, rule, detail };
}

/** The before side of a removal as its pair shows it: see {@link ChangeClass.pairs}. */
function removedText(atom: Atom): string {
  return atom.kind === "row_removed"
    ? (atom.before ?? "")
    : `${atom.detail ?? ""} = ${atom.before ?? ""}`;
}

/** The pair an atom adds to its class, or null for a kind that is not shown by its values. */
function pairOf(atom: Atom): string | null {
  switch (DISPLAY_OF[atom.kind]) {
    case "pairs":
      return `${atom.before ?? ""}\u{0}${atom.after ?? ""}`;
    case "removals":
      return `${removedText(atom)}\u{0}`;
    default:
      return null;
  }
}

/**
 * A path as the summary prints it: one quoted token, rendered exactly as a value is
 * ({@link renderValue}: escaped, and cut at `maxValueChars` code points with the marker after the
 * closing quote). A path may hold ` | `, quotes, a line break, an invisible character or the
 * platform's own words, and still cannot add a field or a line, or read as another path. A cut
 * path cuts the class line it is on (see {@link renderClass}).
 */
function renderPath(path: string): { text: string; cut: boolean } {
  return renderValue(path);
}

/**
 * What one example of an atom says, after its file's path as {@link renderPath} gave it: see
 * {@link ChangeClass.examples}.
 */
function exampleOf(where: string, atom: Atom): string {
  const value = (v: string | null): string => renderValue(v ?? "").text;
  switch (atom.kind) {
    case "key_relabeled":
      return `${where} row ${value(atom.before)} -> ${value(atom.after)}`;
    case "row_removed":
    case "row_relocated":
      return `${where} row ${value(atom.before)}`;
    case "row_added":
      return `${where} row ${value(atom.after)}`;
    case "cell_templated":
    case "cell_replaced":
    case "cell_emptied":
    case "cell_filled":
      return `${where} ${value(atom.before)} -> ${value(atom.after)}`;
    case "json_value_changed":
    case "json_type_changed":
    case "json_emptied":
    case "json_filled":
      // A document that is one scalar changed at its root, which has no path to name.
      return atom.field === "" ? where : `${where} key ${value(atom.field)}`;
    case "json_key_removed":
    case "json_empty_key_removed":
    case "json_key_added":
    case "json_key_moved":
    case "json_key_renamed":
      return `${where} key ${value(atom.detail)}`;
    case "column_removed": {
      // The count as the diff wrote it, or `unknown` for one it could not have written, never a 0
      // that is not there: a missing or unreadable count is a loss (see `heldValues`).
      const count = atom.detail !== null && /^[0-9]+$/.test(atom.detail) ? atom.detail : "unknown";
      return `${where} (${count} non-missing values)`;
    }
    case "format":
      // The states are the platform's own words, except a mixed file's per-line pattern.
      return atom.detail === "line_ending_pattern" || atom.before === null || atom.after === null
        ? where
        : `${where} (${atom.before} to ${atom.after})`;
    case "column_added":
    case "columns_reordered":
    case "rows_reordered":
    case "json_keys_reordered":
      return where;
  }
}

/** The order of the roles in the summary: what a reader most needs to see comes first. */
const ROLE_RANK: Readonly<Record<ClassRole, number>> = {
  loss: 0,
  relocated: 1,
  modification: 2,
  additive: 3,
};

/** Where an example comes from: rendered only if its class is among the ones that can be shown. */
interface ExampleSource {
  path: string;
  atom: Atom;
}

/** A class while its files are folded in. */
interface Building {
  identity: ClassIdentity;
  files: Set<string>;
  items: number;
  pairs: Map<string, number>;
  examples: ExampleSource[];
  /** The second atom of the first file, used when no second file has the class. */
  spare: ExampleSource | null;
}

/** Render order (design section 5.1): see {@link classify}. */
function renderOrder(a: Building, b: Building): number {
  return (
    ROLE_RANK[ROLE_OF[a.identity.kind]] - ROLE_RANK[ROLE_OF[b.identity.kind]] ||
    b.files.size - a.files.size ||
    b.items - a.items ||
    byCodeUnits(a.identity.key, b.identity.key)
  );
}

/**
 * The classes of a run, built one file at a time, so a file's atoms can be dropped once they are
 * folded in: what a run holds is its classes (their counts, pairs and at most three atoms each, for
 * the examples), never every atom of every file.
 *
 * `fold` takes a file whole or not at all. It first computes each atom's class key, once, and
 * counts the classes the file would add; when the run would then hold more than `limit` classes it
 * returns null and the builder is exactly as it was, so the summary can refuse that one file and
 * go on. Otherwise it folds the atoms in, with the keys it already computed, and hands the file's
 * keys back. `finish` sorts the classes into render order and renders the examples of the first
 * `maxClasses` only, since no later class can be shown.
 */
class ClassBuilder {
  private readonly byKey = new Map<string, Building>();

  constructor(private readonly limit: number) {}

  fold(path: string, atoms: readonly Atom[]): Set<string> | null {
    // First the file's classes, without touching the builder: one identity per distinct key, and
    // how many of them the run does not hold yet.
    const shape = entityPattern(path);
    const ofFile = new Map<string, ClassIdentity>();
    const identities: ClassIdentity[] = [];
    let added = 0;
    for (const atom of atoms) {
      const computed = classIdentity(shape, atom);
      let identity = ofFile.get(computed.key);
      if (identity === undefined) {
        identity = computed;
        ofFile.set(computed.key, computed);
        if (!this.byKey.has(computed.key) && this.byKey.size + ++added > this.limit) return null;
      }
      identities.push(identity);
    }
    // Then the fold, with the keys computed above.
    for (const [i, atom] of atoms.entries()) {
      const identity = identities[i] as ClassIdentity;
      let entry = this.byKey.get(identity.key);
      if (entry === undefined) {
        entry = {
          identity,
          files: new Set(),
          items: 0,
          pairs: new Map(),
          examples: [],
          spare: null,
        };
        this.byKey.set(identity.key, entry);
      }
      const newFile = !entry.files.has(path);
      entry.files.add(path);
      entry.items++;
      const pair = pairOf(atom);
      if (pair !== null) entry.pairs.set(pair, (entry.pairs.get(pair) ?? 0) + 1);
      if (newFile && entry.examples.length < SUMMARY_LIMITS.samplesPerClass) {
        entry.examples.push({ path, atom });
      } else if (!newFile && entry.files.size === 1 && entry.spare === null) {
        entry.spare = { path, atom };
      }
    }
    return new Set(ofFile.keys());
  }

  finish(): ChangeClass[] {
    return [...this.byKey.values()].sort(renderOrder).map((entry, i) => {
      const sources = i < SUMMARY_LIMITS.maxClasses ? [...entry.examples] : [];
      if (
        i < SUMMARY_LIMITS.maxClasses &&
        sources.length < SUMMARY_LIMITS.samplesPerClass &&
        entry.spare !== null
      ) {
        sources.push(entry.spare);
      }
      const shown = sources.map((source) => ({
        where: renderPath(source.path),
        atom: source.atom,
      }));
      return {
        ...entry.identity,
        files: entry.files,
        items: entry.items,
        pairs: entry.pairs,
        examples: shown.map((example) => exampleOf(example.where.text, example.atom)),
        examplePathCut: shown.some((example) => example.where.cut),
      };
    });
  }
}

/**
 * Group the atoms of every file into classes (design section 4.2), in render order (section 5.1):
 * loss, then relocated, then modification, then additive; within a role the class in more files
 * first, then the one with more items, then the class key in code-unit order, so the order is a
 * function of the classes alone.
 *
 * `files` must be in review order (the summary passes them sorted by path); the examples are taken
 * in that order, so they too depend only on the input. Only the first `maxClasses` classes have
 * their examples rendered (see {@link ChangeClass.examples}). This is {@link ClassBuilder} with no
 * bound on the classes; the summary folds its files one at a time under `maxTrackedClasses`.
 */
export function classify(files: readonly FileAtoms[]): ChangeClass[] {
  const builder = new ClassBuilder(Number.POSITIVE_INFINITY);
  for (const file of files) builder.fold(file.path, file.atoms);
  return builder.finish();
}

// ---------------------------------------------------------------------------------------------
// Rendering, bounds and completeness (design sections 5.2 to 5.4 and 8.2)
// ---------------------------------------------------------------------------------------------

/** What a `format` class says changed, in the platform's words. */
const FORMAT_WORDS: Readonly<Record<FormatDetail, string>> = {
  bom: "byte order mark added or removed",
  line_endings: "line endings changed",
  line_ending_pattern: "which lines end in CRLF changed",
  final_newline: "final newline added or removed",
  json_respelled: "same values, string escapes spelled differently",
};

/** The JSON kinds whose field is a leaf path; every other JSON kind with a field names its parent. */
const JSON_VALUE_KINDS: ReadonlySet<ClassKind> = new Set([
  "json_value_changed",
  "json_type_changed",
  "json_emptied",
  "json_filled",
]);

/** The last line of a summary that could not show every class; never written for none. */
function moreClassesLine(n: number): string {
  return n === 1 ? "(1 more change class not shown)" : `(${n} more change classes not shown)`;
}

/** The line under a class whose distinct pairs were not all shown; never written for none. */
function morePairsLine(n: number): string {
  return n === 1
    ? "    (1 more distinct value not shown)"
    : `    (${n} more distinct values not shown)`;
}

/** A value with every character {@link renderValue} would escape removed, spaces kept. */
function withoutUnseen(v: string): string {
  return v.replace(UNSEEN, (ch) => (ch === " " ? ch : ""));
}

/**
 * The note a pair needs when its two sides may LOOK alike (design section 8.2), or null. A pair
 * gets one when its two rendered texts are equal (two values cut at the same place), when they
 * differ only in characters the renderer escapes (a zero-width space, a bidirectional mark, a
 * control character), when the raw values are equal after NFC normalization but not byte for byte
 * (a precomposed letter against the letter and a combining mark), or when they first differ at a
 * character outside ASCII (a Latin `a` against a Cyrillic one, U+0430). The last is wider than it
 * must be, and deliberately: a note on a pair that did not need one costs a few words, while a
 * look-alike without one is a change the reader cannot see. The note is computed on the raw
 * values, never on the rendered ones.
 */
function differenceNote(
  before: string,
  after: string,
  b: { text: string },
  a: { text: string },
): string | null {
  const note = firstDifference(before, after);
  if (note === null) return null;
  // The NFC condition is the design's own, kept as it is written, though the last condition covers
  // it: two values equal after NFC that differ first at an ASCII character on both sides cannot
  // exist (an ASCII character is a starter that decomposes to itself, so the decompositions would
  // differ there too), so such a pair always differs first at a character outside ASCII. Checked,
  // not only argued: a brute force over 400,000 strings in the phase 3 review found no pair this
  // condition annotates that the last one would not.
  if (
    b.text === a.text ||
    withoutUnseen(before) === withoutUnseen(after) ||
    before.normalize("NFC") === after.normalize("NFC")
  ) {
    return note;
  }
  const points = [...note.matchAll(/U\+([0-9A-F]+)/g)].map((m) =>
    Number.parseInt(m[1] as string, 16),
  );
  return points.some((p) => p >= 0x80) ? note : null;
}

/**
 * One class as the fenced block shows it, numbered `n` (design section 8.2), and whether that
 * showing is COMPLETE (section 5.3):
 *
 * ```text
 * C<n> | "<shape>" | <column "x" | key "path" | under "parent"> | <kind words>[: <rule>]
 *     "<before>" -> "<after>" x<count>        (pairs; a removal shows one side)
 *     (<k> more distinct values not shown)        (`1 more distinct value` for one)
 *     e.g. "<path>" <what changed>
 * ```
 *
 * Every author text is rendered so that nothing from the pull request can start a line, add a
 * field or imitate the platform's words: values, column names, JSON paths, a rule's added text and
 * every file path (the shape, a relocation's target, an example's file) go through
 * {@link renderValue} (quoted, escaped, cut with a marker after the closing quote), so each is one
 * quoted token.
 *
 * A class is complete when nothing on its class line was cut (the shape, the field, a rename's
 * names, a relocation's target, and the path of any of its examples, which is a token of the same
 * grammar) and, for the `pairs` and `removals` kinds, every distinct pair is shown and no shown
 * value was cut. A cut anywhere a reader needs is a reason not to account for the class's files,
 * whatever the kind: the rule of a rule kind describes its members only if the reader can read
 * which column or key it applies to. The examples only illustrate, so a value cut in an example
 * changes nothing.
 */
function renderClass(n: number, c: ChangeClass): { text: string; complete: boolean } {
  let lineCut = c.examplePathCut;
  const quoted = (v: string): string => {
    const r = renderValue(v);
    if (r.cut) lineCut = true;
    return r.text;
  };
  const path = (p: string): string => {
    const r = renderPath(p);
    if (r.cut) lineCut = true;
    return r.text;
  };
  const parts = [`C${n}`, path(c.shape)];
  if (c.field !== null) {
    if (!c.kind.startsWith("json_")) parts.push(`column ${quoted(c.field)}`);
    else if (JSON_VALUE_KINDS.has(c.kind)) {
      parts.push(c.field === "" ? "the whole document" : `key ${quoted(c.field)}`);
    } else parts.push(c.field === "" ? "top level" : `under ${quoted(c.field)}`);
  }
  let rule: string | null = null;
  if (c.rule !== null) {
    // The rule's added or removed text is the author's: each gap is rendered like a value and
    // put where `ruleWords` puts its quotes, so the words are the module's and the text is escaped.
    // No gap can be cut today: a rule is found only between names of at most `maxKeyChars` (128)
    // code points, so a gap never reaches the 300 of a cut. `quoted` would still mark the line
    // cut if one did; that is kept as the guard that fails closed, not as a case that happens.
    const gaps = c.rule.gaps.map((gap) => {
      const text = quoted(gap);
      return text.slice(1, text.lastIndexOf('"'));
    });
    rule = ruleWords({ ...c.rule, gaps });
  } else if (c.kind === "row_relocated" && c.detail !== null) {
    // The shape of the path the rows were found at, a path like the class's own.
    rule = `to ${path(c.detail)}`;
  } else if (c.kind === "json_key_renamed" && c.detail !== null) {
    rule = quoted(c.detail);
  } else if (c.kind === "format" && c.detail !== null) {
    rule = FORMAT_WORDS[c.detail as FormatDetail] ?? quoted(c.detail);
  }
  parts.push(rule === null ? KIND_WORDS[c.kind] : `${KIND_WORDS[c.kind]}: ${rule}`);
  const lines = [parts.join(" | ")];

  const display = DISPLAY_OF[c.kind];
  let pairsComplete = true;
  if (display === "pairs" || display === "removals") {
    // Most frequent first, then by text, so which pairs fit is a function of the class alone.
    const ordered = [...c.pairs].sort((x, y) => y[1] - x[1] || byCodeUnits(x[0], y[0]));
    const shown = ordered.slice(0, SUMMARY_LIMITS.maxPairsPerClass);
    for (const [pair, count] of shown) {
      const at = pair.lastIndexOf("\u{0}");
      const before = pair.slice(0, at);
      const b = renderValue(before);
      if (b.cut) pairsComplete = false;
      if (display === "removals") {
        lines.push(`    ${b.text} x${count}`);
        continue;
      }
      const after = pair.slice(at + 1);
      const a = renderValue(after);
      if (a.cut) pairsComplete = false;
      const note = differenceNote(before, after, b, a);
      lines.push(`    ${b.text} -> ${a.text} x${count}${note === null ? "" : ` (${note})`}`);
    }
    if (ordered.length > shown.length) {
      lines.push(morePairsLine(ordered.length - shown.length));
      pairsComplete = false;
    }
  }
  for (const example of c.examples) lines.push(`    e.g. ${example}`);
  return { text: lines.join("\n"), complete: !lineCut && pairsComplete };
}

/** The fenced block of a summary, and which classes it shows and shows completely. */
export interface RenderedClasses {
  /** The block's text: every shown class, then the line that counts the others; "" for no class. */
  text: string;
  /** The keys of the classes shown, in render order: always a prefix of the classes given. */
  shown: ReadonlySet<string>;
  /** The keys of the classes shown completely (design section 5.3); a subset of `shown`. */
  complete: ReadonlySet<string>;
  /** How many classes were not shown. */
  cut: number;
}

/**
 * Render classes, in the order given, within `maxClasses` and `maxSummaryChars` (design sections
 * 5.2 to 5.4). A class renders whole or not at all, and rendering STOPS at the first class that
 * does not fit: the classes shown are always a prefix of the order, so a loss class can never be
 * left out while a later class is shown, and no class's showing depends on the size of the ones
 * after it. When any class is left out, the block ends with `(N more change classes not shown)`
 * (`(1 more change class not shown)` for one);
 * room for that line is kept from the start, so the text never exceeds `maxSummaryChars`.
 */
export function renderClasses(classes: readonly ChangeClass[]): RenderedClasses {
  const blocks: string[] = [];
  const shown = new Set<string>();
  const complete = new Set<string>();
  let length = 0;
  for (const [i, c] of classes.entries()) {
    if (shown.size >= SUMMARY_LIMITS.maxClasses) break;
    const block = renderClass(shown.size + 1, c);
    const after = classes.length - i - 1;
    const reserve = after > 0 ? 1 + moreClassesLine(after).length : 0;
    const separator = blocks.length > 0 ? 1 : 0;
    if (length + separator + block.text.length + reserve > SUMMARY_LIMITS.maxSummaryChars) break;
    blocks.push(block.text);
    length += separator + block.text.length;
    shown.add(c.key);
    if (block.complete) complete.add(c.key);
  }
  const cut = classes.length - shown.size;
  if (cut > 0) blocks.push(moreClassesLine(cut));
  return { text: blocks.join("\n"), shown, complete, cut };
}

// ---------------------------------------------------------------------------------------------
// Coverage and loss facts (design sections 6.1, 7.1 and 8.1)
// ---------------------------------------------------------------------------------------------

/** What became of one summary candidate. */
export interface FileOutcome {
  path: string;
  family: "tsv" | "json";
  /** Why the file was not summarized, or null when both sides parsed and its diff was total. */
  refusal: SummaryRefusal | null;
  /** The key column its rows were paired by (tables only), or null. */
  keyColumn: string | null;
  /** The keys of the classes its atoms are in; empty for a refused file. */
  classKeys: ReadonlySet<string>;
}

/**
 * The loss and relocation facts of a run (design section 7.1), counted over EVERY summarized file,
 * whether the summary accounted for it or not: a pull request is held to the same rule at 3 files
 * and at 3,000, and a file that is also shown as a raw diff still counts.
 */
export interface LossFacts {
  /** `row_removed` atoms, and the number of files they are in. */
  rowsRemoved: number;
  rowsRemovedFiles: number;
  /** `row_relocated` atoms. */
  rowsRelocated: number;
  /** `column_removed` atoms whose column held at least one non-missing value. */
  columnsRemoved: number;
  /** `json_key_removed` atoms, and the number of files they are in. */
  keysRemoved: number;
  keysRemovedFiles: number;
  /** `json_key_moved` atoms. */
  keysMoved: number;
  /** `cell_emptied` and `json_emptied` atoms. */
  valuesEmptied: number;
  /**
   * The first path in code-unit order with a blocking atom (`row_removed`, `json_key_removed`, or
   * a `column_removed` that held a value), for the platform finding's `path`; null when none.
   */
  firstBlockingPath: string | null;
}

/** The facts of a run with nothing lost. */
export const NO_LOSS: Readonly<LossFacts> = Object.freeze({
  rowsRemoved: 0,
  rowsRemovedFiles: 0,
  rowsRelocated: 0,
  columnsRemoved: 0,
  keysRemoved: 0,
  keysRemovedFiles: 0,
  keysMoved: 0,
  valuesEmptied: 0,
  firstBlockingPath: null,
});

/**
 * A removed column held a value unless its count is exactly the text `0`. A missing count, an empty
 * one or one that is not a number cannot come from the diff; if one ever did, it would be counted
 * as a loss, never as nothing lost. (Comparing as a number would not do: `Number(null)`,
 * `Number("")` and `Number(" ")` are all 0.)
 */
function heldValues(atom: Atom): boolean {
  return atom.detail !== "0";
}

/**
 * The loss facts of the summarized files: see {@link LossFacts}. The summary counts the same facts
 * one file at a time as it folds the file in ({@link addLossFacts}), so the two always agree.
 */
export function lossFactsOf(files: readonly FileAtoms[]): LossFacts {
  const facts: LossFacts = { ...NO_LOSS };
  for (const file of files) addLossFacts(facts, file);
  return facts;
}

/** Add one summarized file's loss facts to a run's: the one place a loss fact is counted. */
function addLossFacts(facts: LossFacts, file: FileAtoms): void {
  let rows = 0;
  let keys = 0;
  let blocking = false;
  for (const atom of file.atoms) {
    switch (atom.kind) {
      case "row_removed":
        rows++;
        blocking = true;
        break;
      case "row_relocated":
        facts.rowsRelocated++;
        break;
      case "column_removed":
        if (heldValues(atom)) {
          facts.columnsRemoved++;
          blocking = true;
        }
        break;
      case "json_key_removed":
        keys++;
        blocking = true;
        break;
      case "json_key_moved":
        facts.keysMoved++;
        break;
      case "cell_emptied":
      case "json_emptied":
        facts.valuesEmptied++;
        break;
      // No loss fact: every other kind, named, so a kind added to `CLASS_KINDS` without being
      // placed here or above does not compile.
      case "key_relabeled":
      case "cell_templated":
      case "cell_replaced":
      case "json_value_changed":
      case "json_type_changed":
      case "json_key_renamed":
      case "json_empty_key_removed":
      case "rows_reordered":
      case "columns_reordered":
      case "json_keys_reordered":
      case "format":
      case "column_added":
      case "row_added":
      case "cell_filled":
      case "json_key_added":
      case "json_filled":
        break;
      default: {
        const unclassified: never = atom.kind;
        throw new Error(`addLossFacts: a kind with no case: ${String(unclassified)}`);
      }
    }
  }
  facts.rowsRemoved += rows;
  if (rows > 0) facts.rowsRemovedFiles++;
  facts.keysRemoved += keys;
  if (keys > 0) facts.keysRemovedFiles++;
  if (
    blocking &&
    (facts.firstBlockingPath === null || byCodeUnits(file.path, facts.firstBlockingPath) < 0)
  ) {
    facts.firstBlockingPath = file.path;
  }
}

/**
 * The files the summary accounts for (design section 6.1): a file is accounted for when it parsed
 * on both sides with no refusal (so its table round-tripped and its diff was total) and EVERY class
 * that holds one of its atoms and is not additive was shown completely. Additive classes are never
 * needed: new content removes nothing. A class this function does not know, or a path that appears
 * twice with different fates, accounts for nothing: every doubt here falls toward the raw-diff
 * path. An abandoned run never gets here: {@link summarizeChanges} returns the abandoned summary,
 * which accounts for nothing, before anything is accounted for.
 */
export function accountedFiles(
  outcomes: readonly FileOutcome[],
  classes: readonly ChangeClass[],
  complete: ReadonlySet<string>,
): Set<string> {
  const accounted = new Set<string>();
  const kindOf = new Map(classes.map((c) => [c.key, c.kind]));
  const refused = new Set<string>();
  for (const outcome of outcomes) {
    const covered =
      outcome.refusal === null &&
      [...outcome.classKeys].every((key) => {
        const kind = kindOf.get(key);
        if (kind === undefined) return false;
        return ROLE_OF[kind] === "additive" || complete.has(key);
      });
    if (covered) accounted.add(outcome.path);
    else refused.add(outcome.path);
  }
  for (const path of refused) accounted.delete(path);
  return accounted;
}

/**
 * The summary's numbers for the facts block (design section 8.1), outside every fence. Only
 * counts and the platform's own words: no path, value or name from the pull request.
 */
export interface SummaryFacts {
  /** The run reached its deadline: every other number is then zero and nothing is accounted for. */
  abandoned: boolean;
  /** Candidates that parsed on both sides with a total diff. */
  files_summarized: number;
  /** Candidates refused, for any reason; the reasons are not given here. */
  files_not_summarized: number;
  files_accounted_for: number;
  classes_shown: number;
  classes_cut: number;
  rows_removed_not_found_elsewhere: number;
  rows_removed_found_verbatim_in_sourcedata: number;
  columns_with_values_removed: number;
  keys_removed_not_found_elsewhere: number;
  keys_moved_to_an_inherited_sidecar: number;
  values_emptied: number;
}

/** `1 item`, `2 items`. */
function counted(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The class table of the facts block: one line per SHOWN class, `C<n> <kind words> | <items> in
 * <files> | in full` or `not shown in full`, numbered as the fenced block numbers them. Only the
 * platform's words and counts, so a value cannot forge or change it. `not shown in full` is said of
 * every incomplete class, whatever made it so: a pair not shown, a value cut, or a token of its
 * class line cut (its shape, field or target, or an example's path), so the words never name a
 * cause the block does not have.
 */
export function classTable(
  classes: readonly ChangeClass[],
  shown: ReadonlySet<string>,
  complete: ReadonlySet<string>,
): string[] {
  return classes
    .filter((c) => shown.has(c.key))
    .map(
      (c, i) =>
        `C${i + 1} ${KIND_WORDS[c.kind]} | ${counted(c.items, "item")} in ${counted(c.files.size, "file")} | ${complete.has(c.key) ? "in full" : "not shown in full"}`,
    );
}

/** The facts of a run: see {@link SummaryFacts}. */
export function summaryFacts(input: {
  abandoned: boolean;
  outcomes: readonly FileOutcome[];
  accounted: ReadonlySet<string>;
  shown: number;
  cut: number;
  loss: LossFacts;
}): SummaryFacts {
  const summarized = input.outcomes.filter((o) => o.refusal === null).length;
  return {
    abandoned: input.abandoned,
    files_summarized: summarized,
    files_not_summarized: input.outcomes.length - summarized,
    files_accounted_for: input.accounted.size,
    classes_shown: input.shown,
    classes_cut: input.cut,
    rows_removed_not_found_elsewhere: input.loss.rowsRemoved,
    rows_removed_found_verbatim_in_sourcedata: input.loss.rowsRelocated,
    columns_with_values_removed: input.loss.columnsRemoved,
    keys_removed_not_found_elsewhere: input.loss.keysRemoved,
    keys_moved_to_an_inherited_sidecar: input.loss.keysMoved,
    values_emptied: input.loss.valuesEmptied,
  };
}

// ---------------------------------------------------------------------------------------------
// The summary of a pull request (design sections 5.4, 6.1 and 10.1)
// ---------------------------------------------------------------------------------------------

/** A modified `.tsv` or `.json` file the summary is asked to account for (design section 2.1). */
export interface SummaryCandidate {
  path: string;
  before: Uint8Array;
  after: Uint8Array;
}

/**
 * Everything the summary of a pull request decided, for the evidence and the prompt. Read-only
 * throughout: {@link EMPTY_SUMMARY} is one shared object, and no reader may change a summary.
 */
export interface ChangeSummary {
  /** The deadline was reached: nothing below is used, and nothing is accounted for. */
  abandoned: boolean;
  /** One outcome per `.tsv` and `.json` candidate, in the order the candidates were processed. */
  files: readonly FileOutcome[];
  /** Every class, in render order (the shown ones are a prefix). */
  classes: readonly ChangeClass[];
  /** The keys of the classes rendered, and of those rendered completely. */
  shown: ReadonlySet<string>;
  complete: ReadonlySet<string>;
  /** The paths the summary accounts for (design section 6.1). */
  accounted: ReadonlySet<string>;
  loss: Readonly<LossFacts>;
  facts: Readonly<SummaryFacts> & { readonly classes: readonly string[] };
  /** The fenced block's text: author text inside it, escaped; "" when there is no class. */
  text: string;
}

/** A summary with nothing in it: no candidate, or (abandoned) a pass that ran out of time. */
function emptySummary(
  abandoned: boolean,
  emptySet: () => ReadonlySet<string> = () => new Set<string>(),
): ChangeSummary {
  const outcomes: readonly FileOutcome[] = Object.freeze([]);
  return Object.freeze({
    abandoned,
    files: outcomes,
    classes: Object.freeze([]),
    shown: emptySet(),
    complete: emptySet(),
    accounted: emptySet(),
    loss: NO_LOSS,
    facts: Object.freeze({
      ...summaryFacts({
        abandoned,
        outcomes,
        accounted: new Set(),
        shown: 0,
        cut: 0,
        loss: NO_LOSS,
      }),
      classes: Object.freeze([]),
    }),
    text: "",
  });
}

/**
 * An empty set that stays empty: its `add`, `delete` and `clear` throw. `Object.freeze` does not
 * reach a set's entries, so without this a caller could fill the shared summary's sets through a
 * cast and change them for every later reader.
 */
function frozenSet(): ReadonlySet<string> {
  const set = new Set<string>();
  const refuse = (): never => {
    throw new TypeError("the shared empty summary cannot change");
  };
  for (const name of ["add", "delete", "clear"] as const) {
    Object.defineProperty(set, name, { value: refuse });
  }
  return Object.freeze(set);
}

/**
 * The summary of a pull request with no candidate: not abandoned, and nothing in it. One object
 * shared by every caller, so it is frozen, its facts too, and its sets refuse every change
 * ({@link frozenSet}). The summaries a run returns are its own and keep ordinary sets.
 */
export const EMPTY_SUMMARY: ChangeSummary = emptySummary(false, frozenSet);

/**
 * The summary of a pull request whose summary was not made: its caller reached the line it starts
 * by with too little time left, or could not read the blobs it is made from. Abandoned and empty,
 * so it accounts for nothing, as the result of {@link summarizeChanges} does past its deadline, and
 * leaves the review where it was without a summary; a caller can say so without faking a deadline
 * that has passed. Unlike a run's own result it is one frozen object shared by every caller, like
 * {@link EMPTY_SUMMARY}.
 */
export const ABANDONED_SUMMARY: ChangeSummary = emptySummary(true, frozenSet);

/**
 * JSON text with the whitespace between its tokens removed (space, tab, LF and CR outside a
 * string; a string is copied exactly, escapes and all). Two documents whose trees are equal and
 * whose texts differ after this differ only in how a string was spelled, which is the
 * `json_respelled` format class. The text must be one the parser accepted, so every string ends.
 */
export function stripJsonSpace(text: string): string {
  let out = "";
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      out += text.slice(start, i);
      start = i + 1;
    }
  }
  return out + text.slice(start);
}

/** The text of bytes the JSON parser accepted, without its byte order mark. */
function jsonText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/** The checks a summary proves each diff total with: the real ones, unless a test passes others. */
export interface SummaryChecks {
  table: (diff: FileDiff<TableCounts>) => boolean;
  json: (diff: FileDiff<JsonCounts>) => boolean;
}

/** Both sides of a candidate parsed, or the first refusal: the before side's, then the after side's. */
function parseBoth<T>(
  parse: (bytes: Uint8Array) => Parsed<T>,
  candidate: SummaryCandidate,
): Parsed<{ before: T; after: T }> {
  const before = parse(candidate.before);
  if (!before.ok) return before;
  const after = parse(candidate.after);
  if (!after.ok) return after;
  return { ok: true, value: { before: before.value, after: after.value } };
}

/**
 * One candidate summarized, or why it was refused (steps 5 and 6 of {@link summarizeChangesWith}):
 * both sides parsed, diffed against the pools, and the atoms folded into the run's classes. A
 * table's layout atoms come from its diff; a JSON document's come from {@link formatAtoms} here,
 * plus `json_respelled` when the trees are equal and the texts differ beyond whitespace. A file
 * whose atoms would make the run hold more than `maxTrackedClasses` classes is `too_large`, and
 * nothing of it is folded.
 */
function summarizeFile(
  candidate: SummaryCandidate,
  family: "tsv" | "json",
  pools: { rows: RowPool; json: JsonPool },
  checks: SummaryChecks,
  builder: ClassBuilder,
): Parsed<{ atoms: Atom[]; keyColumn: string | null; classKeys: ReadonlySet<string> }> {
  const file = fileAtoms(candidate, family, pools, checks);
  if (!file.ok) return file;
  const classKeys = builder.fold(candidate.path, file.value.atoms);
  if (classKeys === null) return { ok: false, refusal: "too_large" };
  return { ok: true, value: { ...file.value, classKeys } };
}

/** The atoms of one candidate, or why it was refused: see {@link summarizeFile}. */
function fileAtoms(
  candidate: SummaryCandidate,
  family: "tsv" | "json",
  pools: { rows: RowPool; json: JsonPool },
  checks: SummaryChecks,
): Parsed<{ atoms: Atom[]; keyColumn: string | null }> {
  const { path } = candidate;
  if (family === "tsv") {
    const sides = parseBoth(parseTsv, candidate);
    if (!sides.ok) return sides;
    const diff = diffTableWith(
      path,
      sides.value.before,
      sides.value.after,
      pools.rows,
      checks.table,
    );
    if (!diff.ok) return diff;
    return { ok: true, value: { atoms: diff.value.atoms, keyColumn: diff.value.keyColumn } };
  }
  const sides = parseBoth(parseJson, candidate);
  if (!sides.ok) return sides;
  const { before, after } = sides.value;
  const diff = diffJsonWith(path, before.value, after.value, pools.json, checks.json);
  if (!diff.ok) return diff;
  const atoms = [...diff.value.atoms, ...formatAtoms(before.format, after.format)];
  if (
    canonicalJson(before.value) === canonicalJson(after.value) &&
    stripJsonSpace(jsonText(candidate.before)) !== stripJsonSpace(jsonText(candidate.after))
  ) {
    atoms.push({
      kind: "format",
      field: null,
      rule: null,
      detail: "json_respelled",
      before: null,
      after: null,
    });
  }
  return { ok: true, value: { atoms, keyColumn: null } };
}

/**
 * Summarize the modified candidates of a pull request against its pools (design sections 4 to 7).
 * Past the deadline the result is `abandoned` and accounts for nothing; see
 * {@link summarizeChangesWith} for how a run proceeds.
 */
export function summarizeChanges(input: {
  candidates: readonly SummaryCandidate[];
  pool: readonly PoolFile[];
  deadline: number | null;
  now?: () => number;
}): ChangeSummary {
  return summarizeChangesWith(input, { table: verifyTableCounts, json: verifyJsonCounts });
}

/**
 * {@link summarizeChanges} with the totality checks passed in, so a test can prove that a diff the
 * check rejects is refused (`internal_mismatch`) and accounts for nothing, and with the pool's
 * pruning passed in, so a test can compare a run that keeps every pool file. A run:
 *
 * 1. **Sorts the candidates by path, in code-unit order**, and processes them in that order. So
 *    nothing about a run depends on the order git listed the files in: not the outcomes, not the
 *    examples, and not which file takes a relocated row's copy. (A copy can serve only the file at
 *    its corresponding path, so two different files never compete for one; the only order that
 *    could matter is two candidates with ONE path, and a path given twice is refused, every time
 *    it appears, as `internal_mismatch`, the word for the platform's own reading not adding up.)
 * 2. Builds the pools once, from the files of `pool` that can matter to a candidate (`keep`, which
 *    is {@link poolFileMatters} unless a test passes another): any other file is never consulted,
 *    so it is not read, and takes nothing of `maxPoolChars`. {@link buildPools} gives the same
 *    pools for the files in any order (it decides which files fit `maxPoolChars` in path order,
 *    sorts the copies of one file itself, and a path listed twice contributes nothing, whichever
 *    entry comes first), so the pool needs no sorting here.
 * 3. Checks the deadline BEFORE each pool file it reads, BEFORE each candidate, AFTER each file it
 *    folds in (a diff can be long), and once more after the last file, before anything is
 *    rendered. When `now()` has reached it at any of these, the WHOLE summary is abandoned: no file
 *    is accounted for, no class or text is kept, and the loss facts are zero. All or nothing is
 *    simpler to prove than a partial account, and an abandoned summary leaves the review where it
 *    was without one (design section 5.4). A null deadline never abandons, and the clock is then
 *    never read.
 * 4. Reads each file whose path ends in `.tsv` or `.json`; any other path is not a candidate and is
 *    left out. Once the bytes read (both sides of every file so far) would pass `maxTotalBytes`,
 *    that file and EVERY later one is refused `too_large`, so what the summary holds is bounded.
 * 5. Parses both sides (the before side's refusal first) and diffs them against the pools
 *    ({@link summarizeFile}). Any refusal, `internal_mismatch` included, is recorded on the file's
 *    outcome, and such a file has no atoms, no class and no loss fact: it stays on the raw-diff
 *    path.
 * 6. Folds each summarized file into the classes ({@link ClassBuilder}) and adds its loss facts as
 *    it goes, then drops its atoms, so a run never holds every atom of every file. A file whose
 *    atoms would make the run hold more than `maxTrackedClasses` classes is refused `too_large`
 *    whole (no atom, no class, no loss fact) and the run goes on, so which file is refused is
 *    decided by the sorted order alone.
 * 7. Renders the classes, and accounts for files.
 */
export function summarizeChangesWith(
  input: {
    candidates: readonly SummaryCandidate[];
    pool: readonly PoolFile[];
    deadline: number | null;
    now?: () => number;
  },
  checks: SummaryChecks,
  keep: (candidates: readonly string[]) => (path: string) => boolean = poolFileMatters,
): ChangeSummary {
  const now = input.now ?? Date.now;
  const expired = (): boolean => input.deadline !== null && now() >= input.deadline;
  const candidates = [...input.candidates].sort((a, b) => byCodeUnits(a.path, b.path));
  const listed = new Map<string, number>();
  for (const candidate of candidates) {
    listed.set(candidate.path, (listed.get(candidate.path) ?? 0) + 1);
  }
  const matters = keep(candidates.map((c) => c.path));
  const pools = poolsWithin(
    input.pool.filter((file) => matters(file.path)),
    expired,
  );
  if (pools === null) return emptySummary(true);

  const outcomes: FileOutcome[] = [];
  const builder = new ClassBuilder(SUMMARY_LIMITS.maxTrackedClasses);
  const loss: LossFacts = { ...NO_LOSS };
  let read = 0;
  let exhausted = false;
  for (const candidate of candidates) {
    if (expired()) return emptySummary(true);
    const { path } = candidate;
    const family = path.endsWith(".tsv") ? "tsv" : path.endsWith(".json") ? "json" : null;
    if (family === null) continue;
    const refuse = (refusal: SummaryRefusal): void => {
      outcomes.push({ path, family, refusal, keyColumn: null, classKeys: new Set() });
    };
    if ((listed.get(path) ?? 0) > 1) {
      refuse("internal_mismatch");
      continue;
    }
    const bytes = candidate.before.length + candidate.after.length;
    if (exhausted || read + bytes > SUMMARY_LIMITS.maxTotalBytes) {
      exhausted = true;
      refuse("too_large");
      continue;
    }
    read += bytes;

    const file = summarizeFile(candidate, family, pools, checks, builder);
    if (!file.ok) {
      refuse(file.refusal);
      continue;
    }
    const { atoms, keyColumn, classKeys } = file.value;
    outcomes.push({ path, family, refusal: null, keyColumn, classKeys });
    addLossFacts(loss, { path, atoms });
    if (expired()) return emptySummary(true);
  }
  if (expired()) return emptySummary(true);

  const classes = builder.finish();
  const rendered = renderClasses(classes);
  const accounted = accountedFiles(outcomes, classes, rendered.complete);
  return {
    abandoned: false,
    files: outcomes,
    classes,
    shown: rendered.shown,
    complete: rendered.complete,
    accounted,
    loss,
    facts: {
      ...summaryFacts({
        abandoned: false,
        outcomes,
        accounted,
        shown: rendered.shown.size,
        cut: rendered.cut,
        loss,
      }),
      classes: classTable(classes, rendered.shown, rendered.complete),
    },
    text: rendered.text,
  };
}
