/**
 * The pure half of the mechanical change summary (design `.context/plans/pr-review-change-summary.md`
 * sections 2.3, 3, 8.2 and 12): the closed vocabulary, the path shape, how a value is shown to the
 * model, and where two look-alike values first differ. Bytes and strings in, bytes and strings out;
 * nothing here touches git or a file.
 */

import { describe, expect, test } from "bun:test";
import {
  type JsonValue,
  SUMMARY_LIMITS,
  SUMMARY_REFUSALS,
  type SummaryRefusal,
  type Table,
  canonicalJson,
  entityPattern,
  firstDifference,
  parseJson,
  parseTsv,
  parseTsvWith,
  renderValue,
  serializeTsv,
} from "../scripts/ci/pr-review-summary";

/** The text exactly as written, backslashes and all: the expectations below are about backslashes. */
const raw = String.raw;

describe("the limits and the refusal words", () => {
  test("the limits are the numbers of design section 5.2, and every one is a positive integer", () => {
    expect(SUMMARY_LIMITS).toEqual({
      maxBlobBytes: 8 * 1024 * 1024,
      maxRows: 200_000,
      maxJsonDepth: 64,
      maxJsonNodes: 200_000,
      maxKeyChars: 128,
      maxRuns: 24,
      maxPairingSteps: 12_000_000,
      maxTotalBytes: 256 * 1024 * 1024,
      maxSummaryChars: 30_000,
      maxClasses: 120,
      maxPairsPerClass: 12,
      maxValueChars: 300,
      samplesPerClass: 2,
      timeReserveMs: 40_000,
    });
    for (const [name, value] of Object.entries(SUMMARY_LIMITS)) {
      expect(Number.isInteger(value) && value > 0, name).toBe(true);
    }
  });

  test("the refusal words are the closed list of design section 10.1, each once and in snake case", () => {
    expect([...SUMMARY_REFUSALS]).toEqual([
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
    ]);
    expect(new Set(SUMMARY_REFUSALS).size).toBe(SUMMARY_REFUSALS.length);
    for (const word of SUMMARY_REFUSALS) expect(word).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
  });
});

describe("entityPattern", () => {
  test("every entity value in every segment becomes a star, directories and file name alike", () => {
    expect(entityPattern("sub-001/ses-01/ieeg/sub-001_ses-01_task-sleep_run-01_channels.tsv")).toBe(
      "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv",
    );
  });

  test("the last entity before the extension is replaced, and values may mix letters and digits", () => {
    expect(entityPattern("sub-A01/eeg/sub-A01_task-rest2_eeg.json")).toBe(
      "sub-*/eeg/sub-*_task-*_eeg.json",
    );
    expect(entityPattern("sub-01_task-sleep.json")).toBe("sub-*_task-*.json");
    expect(entityPattern("Sub-001_x.tsv")).toBe("Sub-*_x.tsv");
  });

  test("the same edit in two subjects has one shape; a different file name has another", () => {
    const a = entityPattern("sub-001/ses-01/eeg/sub-001_ses-01_task-x_channels.tsv");
    const b = entityPattern("sub-125/ses-02/eeg/sub-125_ses-02_task-x_channels.tsv");
    const c = entityPattern("sub-125/ses-02/eeg/sub-125_ses-02_task-x_electrodes.tsv");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("a name without the entity shape is not changed", () => {
    for (const unchanged of [
      "",
      "dataset_description.json",
      "participants.tsv",
      "README",
      "CHANGES",
      "sub-001", // nothing follows the value, so it is not followed by a separator
      "task-sleep",
      "T1-w_x.json", // the label has a digit
      "sub-a-b_x.tsv", // the value is followed by a hyphen
      "task-_x.tsv", // no value
      "sourcedata/raw/events.tsv",
    ]) {
      expect(entityPattern(unchanged), unchanged).toBe(unchanged);
    }
    // With a separator after it the same name is an entity, which is what the exclusions above rest on.
    expect(entityPattern("sub-001/")).toBe("sub-*/");
  });

  test("a shape is stable under a second application", () => {
    const once = entityPattern("sub-001/ses-01/sub-001_ses-01_task-x_run-01_events.tsv");
    expect(entityPattern(once)).toBe(once);
  });
});

describe("renderValue", () => {
  test("a plain value is quoted and not cut", () => {
    expect(renderValue("good")).toEqual({ text: '"good"', cut: false });
    expect(renderValue("")).toEqual({ text: '""', cut: false });
    expect(renderValue("a b")).toEqual({ text: '"a b"', cut: false });
  });

  test("non-ASCII letters that are visible stay as they are", () => {
    expect(renderValue("café 日本 \u{430}").text).toBe('"café 日本 \u{430}"');
  });

  test("characters that render as nothing but are letters or marks to Unicode are written out too", () => {
    // Hangul fillers, a combining grapheme joiner, a variation selector, a Mongolian free variation
    // selector, a variation selector supplement, and the Braille blank: all draw nothing.
    for (const ch of [
      "\u{3164}",
      "\u{115F}",
      "\u{034F}",
      "\u{FE0F}",
      "\u{180B}",
      "\u{E0100}",
      "\u{2800}",
      "\u{FFA0}",
    ]) {
      const hex = ch.codePointAt(0)?.toString(16).toUpperCase();
      expect(renderValue(`go${ch}od`).text, hex).toBe(raw`"go\u{${hex}}od"`);
    }
    // Characters that are seen are left alone, including a letter with its accent either way.
    expect(renderValue("\u{E9}").text).toBe('"\u{E9}"');
    expect(renderValue("e\u{301}").text).toBe('"e\u{301}"');
    expect(renderValue("\u{43E}").text).toBe('"\u{43E}"');
  });

  test("a zero-width space is written out, so good and go<ZWSP>od are told apart", () => {
    expect(renderValue("go\u{200B}od").text).toBe(raw`"go\u{200B}od"`);
    expect(renderValue("go\u{200B}od").text).not.toBe(renderValue("good").text);
    expect(renderValue("\u{200D}\u{2060}\u{FEFF}").text).toBe(raw`"\u{200D}\u{2060}\u{FEFF}"`);
  });

  test("a bidi override is written out", () => {
    expect(renderValue("a\u{202E}b").text).toBe(raw`"a\u{202E}b"`);
    expect(renderValue("\u{2066}x\u{2069}").text).toBe(raw`"\u{2066}x\u{2069}"`);
  });

  test("a no-break space is written out, an ordinary space is not", () => {
    expect(renderValue("a\u{A0}b").text).toBe(raw`"a\u{A0}b"`);
    expect(renderValue("a b").text).toBe('"a b"');
    expect(renderValue("a\u{2003}b\u{3000}c\u{2028}d").text).toBe(
      raw`"a\u{2003}b\u{3000}c\u{2028}d"`,
    );
  });

  test("a soft hyphen is written out", () => {
    expect(renderValue("a\u{AD}b").text).toBe(raw`"a\u{AD}b"`);
  });

  test("a lone surrogate is written out and cannot reach the model as a raw code unit", () => {
    const rendered = renderValue("a\uD800b\uDC00").text;
    expect(rendered).toBe(raw`"a\ud800b\udc00"`);
    // Every code unit of the output is a plain one: nothing unpaired is left to be re-encoded.
    for (let i = 0; i < rendered.length; i++) {
      const unit = rendered.charCodeAt(i);
      expect(unit >= 0xd800 && unit <= 0xdfff).toBe(false);
    }
  });

  test("a newline, a carriage return and a tab are escaped, so no value can start a line", () => {
    expect(renderValue("a\nb").text).toBe(raw`"a\nb"`);
    expect(renderValue("a\r\nb").text).toBe(raw`"a\r\nb"`);
    expect(renderValue("a\tb").text).toBe(raw`"a\tb"`);
    expect(renderValue("\u0001\u001F").text).toBe(raw`"\u0001\u001f"`);
    expect(renderValue("a\nC9 | x").text).not.toContain("\n");
  });

  test("other control, private-use and unassigned characters are written out", () => {
    expect(renderValue("\u007F").text).toBe(raw`"\u{7F}"`);
    expect(renderValue("\u0085").text).toBe(raw`"\u{85}"`);
    expect(renderValue("\u{E000}").text).toBe(raw`"\u{E000}"`);
    expect(renderValue("\u{E0001}").text).toBe(raw`"\u{E0001}"`);
    expect(renderValue("\u{378}").text).toBe(raw`"\u{378}"`); // unassigned
  });

  test("a quote and a backslash are escaped, so a value cannot close its own quotes", () => {
    expect(renderValue('say "hi"').text).toBe(raw`"say \"hi\""`);
    expect(renderValue("a\\b").text).toBe(raw`"a\\b"`);
    expect(renderValue('"," -> "').text).toBe(raw`"\",\" -> \""`);
  });

  test("text that spells an escape the platform writes is told from the escape itself", () => {
    // The author typed backslash, u, brace, 200B, brace: six visible characters, doubled backslash.
    const typed = raw`\u{200B}`;
    expect(renderValue(typed).text).toBe(raw`"\\u{200B}"`);
    expect(renderValue(typed).text).not.toBe(renderValue("\u{200B}").text);
    expect(renderValue(raw`\n`).text).toBe(raw`"\\n"`);
    expect(renderValue(raw`\n`).text).not.toBe(renderValue("\n").text);
  });

  test("a value cut at the limit is marked outside its quotes, and the marker is the only thing outside", () => {
    const long = "a".repeat(305);
    const out = renderValue(long);
    expect(out.cut).toBe(true);
    expect(out.text).toBe(`"${"a".repeat(300)}"...(cut)`);
    expect(out.text.endsWith('"...(cut)')).toBe(true);
    expect(renderValue("abcd", 3)).toEqual({ text: '"abc"...(cut)', cut: true });
  });

  test("a value exactly at the limit is not cut, and one more is", () => {
    expect(renderValue("a".repeat(300))).toEqual({ text: `"${"a".repeat(300)}"`, cut: false });
    expect(renderValue("a".repeat(301)).cut).toBe(true);
    expect(renderValue("abc", 3).cut).toBe(false);
    expect(renderValue("abc", 2).cut).toBe(true);
    expect(renderValue("x", 0)).toEqual({ text: '""...(cut)', cut: true });
    expect(renderValue("", 0)).toEqual({ text: '""', cut: false });
  });

  test("a short value that ends in the literal marker is quoted, not cut", () => {
    expect(renderValue("good...(cut)")).toEqual({ text: '"good...(cut)"', cut: false });
    expect(renderValue("...(cut)").cut).toBe(false);
  });

  test("a cut value that already ends in the marker still shows the real marker after the quote", () => {
    const out = renderValue("...(cut)zzzz", 8);
    expect(out.cut).toBe(true);
    expect(out.text).toBe('"...(cut)"...(cut)');
  });

  test("the cut is counted in code points: an astral character is one, and a pair is never split", () => {
    const grin = "\u{1F600}";
    expect(renderValue(grin.repeat(300))).toEqual({ text: `"${grin.repeat(300)}"`, cut: false });
    expect(renderValue(grin.repeat(301)).cut).toBe(true);
    expect(renderValue(`a${grin}b`, 2)).toEqual({ text: `"a${grin}"...(cut)`, cut: true });
    expect(renderValue(`a${grin}b`, 3)).toEqual({ text: `"a${grin}b"`, cut: false });
  });

  test("a lone surrogate counts as one code point toward the cut", () => {
    expect(renderValue("\uD800\uD800x", 2)).toEqual({
      text: raw`"\ud800\ud800"...(cut)`,
      cut: true,
    });
  });

  test("the cut is made before the escapes, so escapes never eat into the limit", () => {
    // 300 newlines render as 600 characters of escapes, and are still not a cut value.
    const out = renderValue("\n".repeat(300));
    expect(out.cut).toBe(false);
    expect(out.text).toBe(`"${raw`\n`.repeat(300)}"`);
    expect(renderValue("\n".repeat(301)).cut).toBe(true);
  });
});

describe("firstDifference", () => {
  test("equal strings have none", () => {
    expect(firstDifference("", "")).toBeNull();
    expect(firstDifference("good", "good")).toBeNull();
    expect(firstDifference("a\u{1F600}b", "a\u{1F600}b")).toBeNull();
  });

  test("the first differing character is named by its 1-based position and both code points", () => {
    expect(firstDifference("abcd", "abXd")).toBe(
      "first difference at character 3: U+0063 to U+0058",
    );
    expect(firstDifference("a", "b")).toBe("first difference at character 1: U+0061 to U+0062");
    expect(firstDifference("good", "go\u{200B}od")).toBe(
      "first difference at character 3: U+006F to U+200B",
    );
  });

  test("hex is uppercase and at least four digits", () => {
    expect(firstDifference("\u0001", "\u0002")).toBe(
      "first difference at character 1: U+0001 to U+0002",
    );
    expect(firstDifference("\u{E9}", "e")).toBe(
      "first difference at character 1: U+00E9 to U+0065",
    );
    expect(firstDifference("a", "\u{430}")).toBe(
      "first difference at character 1: U+0061 to U+0430",
    );
  });

  test("a side that has ended is the word end", () => {
    expect(firstDifference("abc", "abcA")).toBe("first difference at character 4: end to U+0041");
    expect(firstDifference("abcd", "abc")).toBe("first difference at character 4: U+0064 to end");
    expect(firstDifference("", "x")).toBe("first difference at character 1: end to U+0078");
    expect(firstDifference("x", "")).toBe("first difference at character 1: U+0078 to end");
  });

  test("positions count code points, not code units, and a five-digit code point is not padded", () => {
    const grin = "\u{1F600}";
    expect(firstDifference(`a${grin}b`, `a${grin}c`)).toBe(
      "first difference at character 3: U+0062 to U+0063",
    );
    expect(firstDifference(`a${grin}`, "a\u{1F601}")).toBe(
      "first difference at character 2: U+1F600 to U+1F601",
    );
    expect(firstDifference(`${grin}`, "")).toBe("first difference at character 1: U+1F600 to end");
    expect(firstDifference(`${grin}${grin}`, grin)).toBe(
      "first difference at character 2: U+1F600 to end",
    );
  });

  test("a lone surrogate is its own character", () => {
    expect(firstDifference("a\uD800", "a\uD801")).toBe(
      "first difference at character 2: U+D800 to U+D801",
    );
    expect(firstDifference("\uD83D", "\u{1F600}")).toBe(
      "first difference at character 1: U+D83D to U+1F600",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Tab-separated tables
// ---------------------------------------------------------------------------------------------

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
// Keeps a leading byte order mark, which the default decoder would drop.
const dec = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

/** The refusal word a text gets, or null when it parsed. */
function tsvRefusal(input: string | Uint8Array): SummaryRefusal | null {
  const parsed = parseTsv(typeof input === "string" ? enc(input) : input);
  return parsed.ok ? null : parsed.refusal;
}

/** The table a text parses to; a refusal fails the test with its word. */
function tsvTable(text: string): Table {
  const parsed = parseTsv(enc(text));
  if (!parsed.ok) throw new Error(`refused as ${parsed.refusal}`);
  return parsed.value;
}

describe("parseTsv accepts and describes a plain table", () => {
  test("header, rows and the format of an LF file with a final newline", () => {
    const table = tsvTable("name\ttype\nA1\tEEG\nA2\tEMG\n");
    expect(table.header).toEqual(["name", "type"]);
    expect(table.rows).toEqual([
      ["A1", "EEG"],
      ["A2", "EMG"],
    ]);
    expect(table.format).toEqual({ bom: false, eol: "lf", crPattern: "", finalNewline: true });
    expect(table.crByLine).toEqual([false, false, false]);
  });

  test("a header with no rows, with and without a final newline", () => {
    expect(tsvTable("a\tb\n").rows).toEqual([]);
    const bare = tsvTable("a\tb");
    expect(bare.rows).toEqual([]);
    expect(bare.format).toEqual({ bom: false, eol: "none", crPattern: "", finalNewline: false });
    expect(bare.crByLine).toEqual([false]);
  });

  test("empty cells are cells: adjacent tabs, a leading tab and a trailing tab", () => {
    const table = tsvTable("a\tb\tc\n\t\t\n1\t\t3\n\t2\t\n");
    expect(table.rows).toEqual([
      ["", "", ""],
      ["1", "", "3"],
      ["", "2", ""],
    ]);
  });

  test("a quote that does not start a cell is data", () => {
    const table = tsvTable('a\tb\nsay "hi"\tit\'s\n');
    expect(table.rows).toEqual([['say "hi"', "it's"]]);
  });

  test("a one-column table has no blank or all-space line: readers disagree about it, so it is refused", () => {
    expect(tsvTable("a\n").rows).toEqual([]);
    expect(tsvTable("a\nb\n").rows).toEqual([["b"]]);
    // csv skips an empty line and pandas a line of only spaces; this parser would read a row.
    expect(tsvRefusal("a\n\n")).toBe("ragged_row");
    expect(tsvRefusal("a\n\n\n")).toBe("ragged_row");
    expect(tsvRefusal("a\n \n1\n")).toBe("ragged_row");
    expect(tsvRefusal(" \nb\n")).toBe("ragged_row");
    // With two columns every reader agrees, and an empty cell is a cell.
    expect(tsvTable("a\tb\n\t\n").rows).toEqual([["", ""]]);
  });

  test("the first character of a file that is a second byte order mark is data, not a second BOM", () => {
    const table = tsvTable("\u{FEFF}\u{FEFF}a\tb\n");
    expect(table.format.bom).toBe(true);
    expect(table.header).toEqual(["\u{FEFF}a", "b"]);
  });
});

describe("two tables that differ only in which lines end in CRLF have different formats", () => {
  test("the CR pattern of a mixed table names the lines, and no other table has one", () => {
    const first = tsvTable("a\tb\r\n1\t2\n3\t4\n");
    const second = tsvTable("a\tb\n1\t2\r\n3\t4\n");
    // Same cells, same class of ending, same final newline: only WHICH lines end in CRLF differs.
    expect(first.header).toEqual(second.header);
    expect(first.rows).toEqual(second.rows);
    expect(first.format.eol).toBe("mixed");
    expect(second.format.eol).toBe("mixed");
    expect(first.format).not.toEqual(second.format);
    expect(first.format.crPattern).toBe("100");
    expect(second.format.crPattern).toBe("010");
    // An unterminated last line is not part of the pattern.
    expect(tsvTable("a\r\n1\n2").format.crPattern).toBe("10");
    // A table that is all LF, all CRLF or has no line ending needs no pattern.
    expect(tsvTable("a\tb\n1\t2\n").format.crPattern).toBe("");
    expect(tsvTable("a\tb\r\n1\t2\r\n").format.crPattern).toBe("");
    expect(tsvTable("a\tb").format.crPattern).toBe("");
  });
});

describe("parseTsv records the byte order mark and the line endings", () => {
  test("a BOM is removed from the first name and recorded", () => {
    const table = tsvTable("\u{FEFF}a\tb\n1\t2\n");
    expect(table.header).toEqual(["a", "b"]);
    expect(table.format).toEqual({ bom: true, eol: "lf", crPattern: "", finalNewline: true });
  });

  test("CRLF throughout", () => {
    const table = tsvTable("a\tb\r\n1\t2\r\n");
    expect(table.format).toEqual({ bom: false, eol: "crlf", crPattern: "", finalNewline: true });
    expect(table.crByLine).toEqual([true, true]);
    expect(table.header).toEqual(["a", "b"]);
    expect(table.rows).toEqual([["1", "2"]]);
  });

  test("mixed endings are kept line by line", () => {
    const table = tsvTable("a\tb\r\n1\t2\n3\t4\r\n5\t6\n");
    expect(table.format.eol).toBe("mixed");
    expect(table.crByLine).toEqual([true, false, true, false]);
    expect(dec(serializeTsv(table))).toBe("a\tb\r\n1\t2\n3\t4\r\n5\t6\n");
  });

  test("an unterminated last line has no ending, and the ones before it decide the style", () => {
    const lf = tsvTable("a\n1");
    expect(lf.format).toEqual({ bom: false, eol: "lf", crPattern: "", finalNewline: false });
    expect(lf.crByLine).toEqual([false, false]);
    const crlf = tsvTable("a\r\n1\r\n2");
    expect(crlf.format).toEqual({ bom: false, eol: "crlf", crPattern: "", finalNewline: false });
    expect(crlf.crByLine).toEqual([true, true, false]);
  });

  test("a file with no terminated line has no line ending", () => {
    expect(tsvTable("a\tb").format.eol).toBe("none");
  });

  test("a CR that is not the one before a terminating LF is refused, and the kept one is per line", () => {
    expect(tsvRefusal("a\tb\r\n1\t2\r\n")).toBeNull();
    expect(tsvRefusal("a\tb\r\r\n1\t2\n")).toBe("bare_cr");
  });
});

describe("parseTsv refuses, with one closed word per fault", () => {
  test("too_large: one byte over 8 MiB, and exactly 8 MiB is read", () => {
    const limit = SUMMARY_LIMITS.maxBlobBytes;
    expect(tsvRefusal(new Uint8Array(limit + 1).fill(97))).toBe("too_large");
    const exact = enc(`a\n${"x".repeat(limit - 2)}`);
    expect(exact.length).toBe(limit);
    expect(tsvRefusal(exact)).toBeNull();
  });

  test("nul_byte", () => {
    expect(tsvRefusal("a\tb\n1\t\u{0}\n")).toBe("nul_byte");
    expect(tsvRefusal(Uint8Array.of(0))).toBe("nul_byte");
    expect(tsvRefusal(Uint8Array.of(0x61, 0x0a, 0x00))).toBe("nul_byte");
  });

  test("invalid_utf8: a stray byte, an overlong form, an encoded surrogate, a truncated sequence, too high", () => {
    for (const bad of [
      [0xff],
      [0x61, 0x09, 0x80, 0x0a],
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xe2, 0x82],
      [0xf4, 0x90, 0x80, 0x80],
    ]) {
      expect(tsvRefusal(Uint8Array.from(bad)), bad.join(",")).toBe("invalid_utf8");
    }
    // Latin-1 and Shift-JIS bytes are the real cases (design section 3.3): the micro sign and a unit.
    expect(tsvRefusal(Uint8Array.from([0x61, 0x0a, 0xb5, 0x56, 0x0a]))).toBe("invalid_utf8");
    expect(tsvRefusal(Uint8Array.from([0x83, 0xca]))).toBe("invalid_utf8");
  });

  test("bare_cr: inside a line, before a CRLF, and ending an unterminated last line", () => {
    expect(tsvRefusal("a\tb\n1\r2\t3\n")).toBe("bare_cr");
    expect(tsvRefusal("a\tb\n1\t2\r")).toBe("bare_cr");
    expect(tsvRefusal("a\tb\r\n1\t2\r")).toBe("bare_cr");
    expect(tsvRefusal("a\r\rb\n")).toBe("bare_cr");
    expect(tsvRefusal("a\r\r\nb\n")).toBe("bare_cr");
    expect(tsvRefusal("\r")).toBe("bare_cr");
    expect(tsvRefusal("a\tb\r\n1\t2\r\n")).toBeNull();
  });

  test("empty: no bytes, and nothing after a byte order mark", () => {
    expect(tsvRefusal("")).toBe("empty");
    expect(tsvRefusal(new Uint8Array(0))).toBe("empty");
    expect(tsvRefusal("\u{FEFF}")).toBe("empty");
  });

  test("a lone line break is one empty line, whose header has an empty name", () => {
    expect(tsvRefusal("\n")).toBe("empty_column_name");
    expect(tsvRefusal("\r\n")).toBe("empty_column_name");
  });

  test("empty_column_name: in the middle, at the end and at the start", () => {
    expect(tsvRefusal("a\t\tb\n1\t2\t3\n")).toBe("empty_column_name");
    expect(tsvRefusal("a\t\n1\t2\n")).toBe("empty_column_name");
    expect(tsvRefusal("\tb\n1\t2\n")).toBe("empty_column_name");
  });

  test("duplicate_column", () => {
    expect(tsvRefusal("a\tb\ta\n1\t2\t3\n")).toBe("duplicate_column");
    expect(tsvRefusal("a\ta\n")).toBe("duplicate_column");
    // Names that differ only in case, or by a trailing space, are different names.
    expect(tsvRefusal("a\tA\ta \n")).toBeNull();
  });

  test("ragged_row: too few cells, too many, a blank line, and a trailing blank line", () => {
    expect(tsvRefusal("a\tb\n1\n")).toBe("ragged_row");
    expect(tsvRefusal("a\tb\n1\t2\t3\n")).toBe("ragged_row");
    expect(tsvRefusal("a\tb\n\n1\t2\n")).toBe("ragged_row");
    expect(tsvRefusal("a\tb\n1\t2\n\n")).toBe("ragged_row");
    expect(tsvRefusal("a\tb\n1\t2\n3")).toBe("ragged_row");
  });

  test("quoted_cell: in the header, in a cell, in the first and in a later column", () => {
    expect(tsvRefusal('"a"\tb\n1\t2\n')).toBe("quoted_cell");
    expect(tsvRefusal('a\t"b\n1\t2\n')).toBe("quoted_cell");
    expect(tsvRefusal('a\tb\n"1"\t2\n')).toBe("quoted_cell");
    expect(tsvRefusal('a\tb\n1\t"2\n')).toBe("quoted_cell");
    expect(tsvRefusal('a\tb\n1\t2\n3\t"4 5"\n')).toBe("quoted_cell");
    expect(tsvRefusal("a\tb\n1\t2\n3\t'4'\n")).toBeNull();
  });

  test("a ragged row after the row cap is ragged_row: the first thing wrong wins over the count", () => {
    expect(tsvRefusal(`a\tb\n${"x\ty\n".repeat(SUMMARY_LIMITS.maxRows + 1)}p\n`)).toBe(
      "ragged_row",
    );
    expect(tsvRefusal(`a\tb\n${"x\ty\n".repeat(SUMMARY_LIMITS.maxRows + 1)}`)).toBe(
      "too_many_rows",
    );
    // The one-column rule is also decided before the row count: a blank last line wins.
    expect(tsvRefusal(`a\n${"x\n".repeat(SUMMARY_LIMITS.maxRows + 1)}\n`)).toBe("ragged_row");
  });

  test("too_many_rows: 200,001 data rows are refused and 200,000 are read", () => {
    const rows = (n: number) => `a\n${"x\n".repeat(n)}`;
    expect(tsvRefusal(rows(SUMMARY_LIMITS.maxRows))).toBeNull();
    expect(tsvRefusal(rows(SUMMARY_LIMITS.maxRows + 1))).toBe("too_many_rows");
  });

  test("no_round_trip: a serializer that loses a byte is caught by the guard, which would otherwise pass", () => {
    const bytes = enc("a\tb\n1\t2\n3\t4\n");
    const honest = parseTsv(bytes);
    expect(honest.ok).toBe(true);

    const dropsARow = parseTsvWith(bytes, (t) => serializeTsv({ ...t, rows: t.rows.slice(1) }));
    expect(dropsARow).toEqual({ ok: false, refusal: "no_round_trip" });

    const losesTheFinalNewline = parseTsvWith(bytes, (t) =>
      serializeTsv({ ...t, format: { ...t.format, finalNewline: false } }),
    );
    expect(losesTheFinalNewline).toEqual({ ok: false, refusal: "no_round_trip" });

    const losesOneByte = parseTsvWith(bytes, (t) => serializeTsv(t).slice(0, -1));
    expect(losesOneByte).toEqual({ ok: false, refusal: "no_round_trip" });

    const changesOneByte = parseTsvWith(bytes, (t) => {
      const out = serializeTsv(t).slice();
      out[0] = 0x58;
      return out;
    });
    expect(changesOneByte).toEqual({ ok: false, refusal: "no_round_trip" });

    // The guard is the last step: a file with an earlier fault keeps that fault's word.
    expect(parseTsvWith(enc("a\ta\n"), () => new Uint8Array(0))).toEqual({
      ok: false,
      refusal: "duplicate_column",
    });
  });

  test("the guard is handed the parsed table and a faithful serializer passes", () => {
    const bytes = enc("\u{FEFF}a\tb\r\n1\t2\n");
    let seen: Table | null = null;
    const parsed = parseTsvWith(bytes, (t) => {
      seen = t;
      return serializeTsv(t);
    });
    expect(parsed.ok).toBe(true);
    expect((seen as Table | null)?.header).toEqual(["a", "b"]);
    expect((seen as Table | null)?.format.bom).toBe(true);
  });

  test("when a file has several faults the first step to fail names it", () => {
    // NUL before invalid UTF-8 before bare CR before empty names before duplicates before ragged
    // rows before quoted cells.
    expect(tsvRefusal(Uint8Array.from([0xff, 0x00]))).toBe("nul_byte");
    expect(tsvRefusal(Uint8Array.from([0x22, 0x0d, 0xff]))).toBe("invalid_utf8");
    expect(tsvRefusal('"a"\t\r\n')).toBe("empty_column_name");
    expect(tsvRefusal('"a"\tb\r1\n')).toBe("bare_cr");
    expect(tsvRefusal('\ta\ta\n"1"\n')).toBe("empty_column_name");
    expect(tsvRefusal('a\ta\n"1"\n')).toBe("duplicate_column");
    expect(tsvRefusal('a\tb\n"1"\n')).toBe("ragged_row");
    expect(tsvRefusal(`a\n${"x\n".repeat(SUMMARY_LIMITS.maxRows)}"y\ty\n`)).toBe("ragged_row");
    expect(tsvRefusal(`a\n${"x\n".repeat(SUMMARY_LIMITS.maxRows + 1)}"y\n`)).toBe("too_many_rows");
  });
});

describe("serializeTsv and parseTsv round-trip every table the parser accepts", () => {
  test("hand-made files of every style come back byte for byte", () => {
    for (const text of [
      "a\tb\n1\t2\n",
      "a\tb\r\n1\t2\r\n",
      "a\tb\r\n1\t2\n3\t4\r\n",
      "a\tb\n1\t2",
      "a\tb\r\n1\t2",
      "a\tb",
      "a\n",
      "a\nb\n",
      "a",
      "\u{FEFF}a\tb\n1\t2\n",
      "\u{FEFF}a\tb\r\n1\t2",
      "a\tb\n\t\n\t",
      "\u{E9}\t\u{65E5}\u{672C}\n\u{1F600}\t\u{200B}\n",
      "a\u{FEFF}\tb\n1\t2\n",
    ]) {
      const bytes = enc(text);
      const parsed = parseTsv(bytes);
      if (!parsed.ok) throw new Error(`${JSON.stringify(text)} was refused as ${parsed.refusal}`);
      expect(dec(serializeTsv(parsed.value)), JSON.stringify(text)).toBe(text);
    }
  });

  test("a generated table of every style parses to its cells and serializes to its bytes", () => {
    const random = seeded(20261020);
    const cases = 3000;
    const seen = { bom: 0, lf: 0, crlf: 0, mixed: 0, none: 0, noFinal: 0, emptyCell: 0, wide: 0 };

    for (let n = 0; n < cases; n++) {
      const made = generateTable(random);
      const bytes = enc(made.text);
      const parsed = parseTsv(bytes);
      if (!parsed.ok) {
        throw new Error(`case ${n}: ${JSON.stringify(made.text)} refused as ${parsed.refusal}`);
      }

      expect(parsed.value.header, `case ${n}`).toEqual(made.header);
      expect(parsed.value.rows, `case ${n}`).toEqual(made.rows);
      expect(parsed.value.format, `case ${n}`).toEqual(made.format);
      expect(parsed.value.crByLine, `case ${n}`).toEqual(made.crByLine);

      const back = serializeTsv(parsed.value);
      expect(sameBytes(back, bytes), `case ${n}: ${JSON.stringify(made.text)}`).toBe(true);

      const again = parseTsv(back);
      expect(again.ok, `case ${n}`).toBe(true);
      if (again.ok) expect(again.value, `case ${n}`).toEqual(parsed.value);

      if (made.format.bom) seen.bom++;
      seen[made.format.eol]++;
      if (!made.format.finalNewline) seen.noFinal++;
      if (made.rows.some((row) => row.includes(""))) seen.emptyCell++;
      if (made.header.length >= 5) seen.wide++;
    }

    // The generator reaches every style, so the loop above is a test of all of them.
    for (const [style, count] of Object.entries(seen)) expect(count, style).toBeGreaterThan(50);
  });
});

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A small seeded generator (mulberry32), so a failing case can be reproduced from its number. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL_POOL = [
  "",
  "",
  "",
  " ",
  "n/a",
  "0",
  "-3",
  "1.5",
  "x",
  "word",
  "two words",
  "trailing ",
  " leading",
  "\u{E9}",
  "\u{65E5}\u{672C}",
  "\u{1F600}",
  'a"b',
  "it's",
  "\\",
  '{"k": 1}',
  "=1",
  "\u{200B}",
  "\u{A0}x",
  "a,b",
  ";",
  "\u{FEFF}",
  "a\u{FEFF}",
];

interface GeneratedTable extends Table {
  text: string;
}

/**
 * A table built from its cells, with the text WRITTEN BY THIS FUNCTION (not by `serializeTsv`), so
 * the parse is checked against an oracle that shares no code with the serializer: cells from a pool
 * that holds empty cells, non-ASCII and invisible characters and quotes that do not start a cell;
 * tabs only as separators; a byte order mark, LF, CRLF or per-line mixed endings, and a missing
 * final newline, each at random.
 */
function generateTable(random: () => number): GeneratedTable {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const columns = 1 + Math.floor(random() * 6);
  const header = Array.from(
    { length: columns },
    (_, i) => `${i}_${pick(["id", "name", "\u{E9}t\u{E9}", "x y"])}`,
  );
  const rowCount = Math.floor(random() * 9);
  const rows = Array.from({ length: rowCount }, () =>
    Array.from({ length: columns }, () => pick(CELL_POOL)),
  );

  const bom = random() < 0.35;
  const finalNewline = random() < 0.7;
  const style = pick(["lf", "crlf", "mixed"] as const);

  // A one-column table has no blank line (readers disagree about it, so it is refused), and an
  // unterminated last line holding only an empty cell is no line at all.
  if (columns === 1) {
    for (const row of rows) if (/^ *$/.test(row[0] ?? "")) row[0] = "x";
  }

  const lines = [header, ...rows];
  const crByLine: boolean[] = [];
  let text = bom ? "\u{FEFF}" : "";
  let terminated = 0;
  let crlf = 0;
  lines.forEach((cells, i) => {
    const ended = i < lines.length - 1 || finalNewline;
    const cr = ended && (style === "crlf" || (style === "mixed" && random() < 0.5));
    crByLine.push(cr);
    text += cells.join("\t") + (ended ? (cr ? "\r\n" : "\n") : "");
    if (ended) terminated++;
    if (cr) crlf++;
  });
  const eol =
    terminated === 0 ? "none" : crlf === 0 ? "lf" : crlf === terminated ? "crlf" : "mixed";
  const crPattern =
    eol === "mixed"
      ? crByLine
          .slice(0, terminated)
          .map((cr) => (cr ? "1" : "0"))
          .join("")
      : "";
  return { text, header, rows, crByLine, format: { bom, eol, crPattern, finalNewline } };
}

// ---------------------------------------------------------------------------------------------
// JSON documents
// ---------------------------------------------------------------------------------------------

/** The six-character text of a JSON escape: a backslash, a u and four hex digits. */
const uesc = (hex: string): string => `\\u${hex}`;

/** The refusal word a JSON text gets, or null when it parsed. */
function jsonRefusal(input: string | Uint8Array): SummaryRefusal | null {
  const parsed = parseJson(typeof input === "string" ? enc(input) : input);
  return parsed.ok ? null : parsed.refusal;
}

/** The value a JSON text parses to; a refusal fails the test with its word. */
function jsonValue(text: string): JsonValue {
  const parsed = parseJson(enc(text));
  if (!parsed.ok) throw new Error(`${JSON.stringify(text)} refused as ${parsed.refusal}`);
  return parsed.value.value;
}

/** A parsed value as a plain JavaScript value, for comparing against `JSON.parse`. */
function plain(v: JsonValue): unknown {
  switch (v.t) {
    case "null":
      return null;
    case "bool":
    case "str":
      return v.v;
    case "num":
      return Number(v.v);
    case "arr":
      return v.v.map(plain);
    case "obj":
      return Object.fromEntries(v.keys.map((key) => [key, plain(v.v.get(key) as JsonValue)]));
  }
}

describe("parseJson accepts RFC 8259 and describes it", () => {
  test("every kind of value, at the top and nested", () => {
    expect(jsonValue("null")).toEqual({ t: "null" });
    expect(jsonValue("true")).toEqual({ t: "bool", v: true });
    expect(jsonValue("false")).toEqual({ t: "bool", v: false });
    expect(jsonValue("12")).toEqual({ t: "num", v: "12" });
    expect(jsonValue('"x"')).toEqual({ t: "str", v: "x" });
    expect(jsonValue("[]")).toEqual({ t: "arr", v: [] });
    expect(jsonValue("{}")).toEqual({ t: "obj", keys: [], v: new Map() });
    expect(jsonValue('{"a":[1,{"b":null}],"c":"d"}')).toEqual({
      t: "obj",
      keys: ["a", "c"],
      v: new Map<string, JsonValue>([
        [
          "a",
          {
            t: "arr",
            v: [
              { t: "num", v: "1" },
              { t: "obj", keys: ["b"], v: new Map([["b", { t: "null" }]]) },
            ],
          },
        ],
        ["c", { t: "str", v: "d" }],
      ]),
    });
  });

  test("space, tab, LF and CR are whitespace anywhere between tokens", () => {
    expect(
      canonicalJson(
        jsonValue(
          ' \t\r\n{ \t\r\n"a" \t\r\n: \t\r\n[ \t\r\n1 \t\r\n, \t\r\n2 \t\r\n] \t\r\n} \t\r\n',
        ),
      ),
    ).toBe('{"a":[1,2]}');
  });

  test("a byte order mark is removed and recorded", () => {
    const parsed = parseJson(enc('\u{FEFF}{"a":1}'));
    expect(parsed.ok && parsed.value.format.bom).toBe(true);
    expect(parsed.ok && canonicalJson(parsed.value.value)).toBe('{"a":1}');
  });

  test("DEL and every non-ASCII character are allowed inside a string; only below U+0020 is not", () => {
    expect(jsonValue('"\u{7F}\u{E9}\u{1F600}\u{2028}"')).toEqual({
      t: "str",
      v: "\u{7F}\u{E9}\u{1F600}\u{2028}",
    });
  });
});

describe("parseJson records the layout", () => {
  const formatOf = (text: string) => {
    const parsed = parseJson(enc(text));
    if (!parsed.ok) throw new Error(`refused as ${parsed.refusal}`);
    return parsed.value.format;
  };

  test("no line break, LF, CRLF and a mixture", () => {
    expect(formatOf("{}")).toEqual({ bom: false, eol: "none", crPattern: "", finalNewline: false });
    expect(formatOf("{\n}\n")).toEqual({
      bom: false,
      eol: "lf",
      crPattern: "",
      finalNewline: true,
    });
    expect(formatOf("{\r\n}\r\n")).toEqual({
      bom: false,
      eol: "crlf",
      crPattern: "",
      finalNewline: true,
    });
    expect(formatOf("{\r\n\n}")).toEqual({
      bom: false,
      eol: "mixed",
      crPattern: "",
      finalNewline: false,
    });
    expect(formatOf("{\n}\r\n")).toEqual({
      bom: false,
      eol: "mixed",
      crPattern: "",
      finalNewline: true,
    });
  });

  test("a bare CR is a line break of its own kind, so the file is mixed", () => {
    expect(formatOf("{\r}").eol).toBe("mixed");
    expect(formatOf("{\r\r\n}").eol).toBe("mixed");
    expect(formatOf("[\r\n1,\r2]").eol).toBe("mixed");
  });

  test("the BOM and the final newline are read independently", () => {
    expect(formatOf("\u{FEFF}{}\n")).toEqual({
      bom: true,
      eol: "lf",
      crPattern: "",
      finalNewline: true,
    });
    expect(formatOf("\u{FEFF}{}")).toEqual({
      bom: true,
      eol: "none",
      crPattern: "",
      finalNewline: false,
    });
    expect(formatOf("{}\r\n").finalNewline).toBe(true);
    expect(formatOf("{}\r").finalNewline).toBe(false);
  });
});

describe("parseJson refuses, with one closed word per fault", () => {
  test("the byte checks are the table parser's: too_large, nul_byte, invalid_utf8", () => {
    expect(jsonRefusal(new Uint8Array(SUMMARY_LIMITS.maxBlobBytes + 1).fill(0x20))).toBe(
      "too_large",
    );
    expect(jsonRefusal('{"a":"\u{0}"}')).toBe("nul_byte");
    expect(jsonRefusal(Uint8Array.of(0x7b, 0x7d, 0x00))).toBe("nul_byte");
    expect(jsonRefusal(Uint8Array.from([0x22, 0xff, 0x22]))).toBe("invalid_utf8");
    expect(jsonRefusal(Uint8Array.from([0x5b, 0xc0, 0xaf, 0x5d]))).toBe("invalid_utf8");
    // A NUL written as an escape is just text.
    expect(jsonRefusal(String.raw`"\u0000"`)).toBeNull();
  });

  test("not_json: nothing, or only whitespace, or only a byte order mark", () => {
    for (const text of ["", " ", "\n\t\r", "\u{FEFF}", "\u{FEFF} "]) {
      expect(jsonRefusal(text), JSON.stringify(text)).toBe("not_json");
    }
  });

  test("not_json: NaN, Infinity and their cousins", () => {
    for (const text of ["NaN", "Infinity", "-Infinity", "[NaN]", '{"a":Infinity}', "undefined"]) {
      expect(jsonRefusal(text), text).toBe("not_json");
    }
  });

  test("not_json: trailing and leading commas, missing commas and colons, missing values", () => {
    for (const text of [
      "[1,]",
      "[,1]",
      "[,]",
      '{"a":1,}',
      '{,"a":1}',
      "[1 2]",
      '{"a":1 "b":2}',
      '{"a" 1}',
      '{"a"}',
      '{"a":}',
      "{a:1}",
      '{1:"a"}',
      "[1,,2]",
      "[",
      "{",
      "[1",
      '{"a":1',
      "]",
      "}",
      "[}",
      "{]",
    ]) {
      expect(jsonRefusal(text), text).toBe("not_json");
    }
  });

  test("not_json: comments", () => {
    for (const text of [
      "// c\n{}",
      "/* c */ {}",
      "{} // c",
      "{} /* c */",
      '{"a":1 /* c */}',
      "# c\n{}",
    ]) {
      expect(jsonRefusal(text), text).toBe("not_json");
    }
  });

  test("not_json: single quotes", () => {
    for (const text of ["'a'", "{'a':1}", "['a']", `{"a":'b'}`]) {
      expect(jsonRefusal(text), text).toBe("not_json");
    }
  });

  test("not_json: numbers that are not RFC 8259 numbers", () => {
    for (const text of [
      "01",
      "[01]",
      "-01",
      "00",
      "+1",
      ".5",
      "5.",
      "1.e5",
      "1e",
      "1e+",
      "-",
      "--1",
      "0x10",
      "1_000",
      "1.5.3",
      "0b1",
      "[1.]",
      "- 1",
    ]) {
      expect(jsonRefusal(text), text).toBe("not_json");
    }
  });

  test("not_json: literals spelled wrong or run into what follows", () => {
    for (const text of [
      "tru",
      "True",
      "nul",
      "NULL",
      "falsey",
      "[truefalse]",
      "nullnull",
      "[1true]",
      "{}x",
    ]) {
      expect(jsonRefusal(text), text).toBe("not_json");
    }
  });

  test("not_json: content after the value", () => {
    for (const text of [
      "{} {}",
      "[] ]",
      "1 2",
      '"a" "b"',
      "{}\u{0}".replace("\u{0}", "x"),
      "{},",
      "null,",
    ]) {
      expect(jsonRefusal(text), text).toBe("not_json");
    }
    expect(jsonRefusal("{}\n\n \r\t")).toBeNull();
  });

  test("not_json: a raw control character inside a string, and every one below U+0020", () => {
    expect(jsonRefusal('"a\nb"')).toBe("not_json");
    expect(jsonRefusal('"a\tb"')).toBe("not_json");
    expect(jsonRefusal('"a\rb"')).toBe("not_json");
    expect(jsonRefusal('"a\u{1}b"')).toBe("not_json");
    for (let code = 1; code < 0x20; code++) {
      expect(jsonRefusal(`["${String.fromCharCode(code)}"]`), `U+${code.toString(16)}`).toBe(
        "not_json",
      );
    }
    expect(jsonRefusal(String.raw`"a\nb"`)).toBeNull();
  });

  test("not_json: bad strings and escapes", () => {
    for (const text of [
      '"abc',
      '"',
      '"a\\"',
      String.raw`"\x41"`,
      String.raw`"\a"`,
      String.raw`"\'"`,
      String.raw`"\u12G4"`,
      String.raw`"\u12"`,
      String.raw`"\u"`,
      String.raw`"\U0041"`,
      String.raw`"\ `,
      '{"a":"b}',
    ]) {
      expect(jsonRefusal(text), text).toBe("not_json");
    }
  });

  test("not_json: whitespace that is not JSON whitespace (a BOM is only a BOM at the very start)", () => {
    expect(jsonRefusal("{}\u{FEFF}")).toBe("not_json");
    expect(jsonRefusal("[1,\u{FEFF}2]")).toBe("not_json");
    expect(jsonRefusal("\u{FEFF}\u{FEFF}{}")).toBe("not_json");
    for (const space of ["\u{A0}", "\u{2028}", "\u{2003}", "\u{B}", "\u{C}", "\u{85}"]) {
      expect(jsonRefusal(`${space}{}`), JSON.stringify(space)).toBe("not_json");
      expect(jsonRefusal(`{}${space}`), JSON.stringify(space)).toBe("not_json");
      expect(jsonRefusal(`[1,${space}2]`), JSON.stringify(space)).toBe("not_json");
    }
  });

  test("duplicate_key: at the top level, nested in an object, and inside an array element", () => {
    expect(jsonRefusal('{"a":1,"a":2}')).toBe("duplicate_key");
    expect(jsonRefusal('{"x":{"a":1,"a":2}}')).toBe("duplicate_key");
    expect(jsonRefusal('[{"a":1},{"b":1,"b":2}]')).toBe("duplicate_key");
    expect(jsonRefusal('{"a":[[{"k":1,"j":2,"k":3}]]}')).toBe("duplicate_key");
    expect(jsonRefusal('{"a":1,"b":2,"c":3,"a":4}')).toBe("duplicate_key");
  });

  test("duplicate_key: keys are compared decoded, and the same value twice is still a duplicate", () => {
    expect(jsonRefusal(`{"a":1,"${uesc("0061")}":1}`)).toBe("duplicate_key");
    expect(jsonRefusal(`{"${uesc("00e9")}":1,"\u{E9}":2}`)).toBe("duplicate_key");
    expect(jsonRefusal('{"a":1,"a":1}')).toBe("duplicate_key");
    expect(jsonRefusal('{"__proto__":1,"__proto__":2}')).toBe("duplicate_key");
  });

  test("the same key in different objects, or at different depths, is not a duplicate", () => {
    expect(jsonRefusal('{"a":{"a":{"a":1}}}')).toBeNull();
    expect(jsonRefusal('[{"a":1},{"a":2}]')).toBeNull();
    expect(jsonRefusal('{"a":1,"A":2,"a ":3}')).toBeNull();
  });

  test("too_deep: 64 nested arrays are read, 65 are refused", () => {
    const nested = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect(jsonRefusal(nested(SUMMARY_LIMITS.maxJsonDepth))).toBeNull();
    expect(jsonRefusal(nested(SUMMARY_LIMITS.maxJsonDepth + 1))).toBe("too_deep");
  });

  test("too_deep: objects count the same, and so does a mixture", () => {
    const objects = (n: number) => `${'{"a":'.repeat(n)}1${"}".repeat(n)}`;
    expect(jsonRefusal(objects(64))).toBeNull();
    expect(jsonRefusal(objects(65))).toBe("too_deep");
    const mixed = (n: number) => `${'[{"a":'.repeat(n)}1${"}]".repeat(n)}`;
    expect(jsonRefusal(mixed(32))).toBeNull();
    expect(jsonRefusal(mixed(33))).toBe("too_deep");
  });

  test("too_deep: a megabyte of opening brackets is refused at once, in linear time", () => {
    const bomb = new Uint8Array(1024 * 1024).fill(0x5b);
    const started = performance.now();
    expect(jsonRefusal(bomb)).toBe("too_deep");
    const braces = new Uint8Array(1024 * 1024).fill(0x7b);
    expect(jsonRefusal(braces)).toBe("not_json"); // a brace is followed by another brace, not a key
    expect(jsonRefusal(enc('{"a":'.repeat(200_000)))).toBe("too_deep");
    expect(jsonRefusal(enc("[".repeat(100_000) + "]".repeat(100_000)))).toBe("too_deep");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("too_many_nodes: 200,001 elements are refused, and the count includes the containers", () => {
    const array = (n: number) => `[${"0,".repeat(n - 1)}0]`;
    const started = performance.now();
    // 199,999 elements plus the array are exactly 200,000 values.
    expect(jsonRefusal(array(SUMMARY_LIMITS.maxJsonNodes - 1))).toBeNull();
    expect(jsonRefusal(array(SUMMARY_LIMITS.maxJsonNodes))).toBe("too_many_nodes");
    expect(jsonRefusal(array(SUMMARY_LIMITS.maxJsonNodes + 1))).toBe("too_many_nodes");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("too_many_nodes: object members and nested containers count too", () => {
    const members = `{${Array.from({ length: SUMMARY_LIMITS.maxJsonNodes }, (_, i) => `"k${i}":0`).join(",")}}`;
    expect(jsonRefusal(members)).toBe("too_many_nodes");
    expect(jsonRefusal(`[${"[],".repeat(SUMMARY_LIMITS.maxJsonNodes)}[]]`)).toBe("too_many_nodes");
    expect(jsonRefusal(`[${'"s",'.repeat(SUMMARY_LIMITS.maxJsonNodes)}"s"]`)).toBe(
      "too_many_nodes",
    );
  });

  test("when a document has several faults the first met in reading order names it", () => {
    expect(jsonRefusal('{"a":1,"a":2,}')).toBe("duplicate_key");
    expect(jsonRefusal('{"a":1,}"a"')).toBe("not_json");
    expect(jsonRefusal(`${"[".repeat(65)}x`)).toBe("too_deep");
    expect(jsonRefusal(`[x${"[".repeat(65)}`)).toBe("not_json");
  });
});

describe("parseJson keeps numbers as written and strings as decoded", () => {
  test("1.0, 1, 1e400, -0 and 1E+2 stay distinct tokens", () => {
    const value = jsonValue(
      "[1.0,1,1e400,-0,1E+2,1e2,100,0.0,-0.0,1.50,0,-1,12345678901234567890123]",
    );
    const tokens = (value as { v: readonly { v: string }[] }).v.map((item) => item.v);
    expect(tokens).toEqual([
      "1.0",
      "1",
      "1e400",
      "-0",
      "1E+2",
      "1e2",
      "100",
      "0.0",
      "-0.0",
      "1.50",
      "0",
      "-1",
      "12345678901234567890123",
    ]);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(canonicalJson(value)).toBe(
      "[1.0,1,1e400,-0,1E+2,1e2,100,0.0,-0.0,1.50,0,-1,12345678901234567890123]",
    );
  });

  test("the six-character escape of a capital A is a plain capital A after parsing", () => {
    const escapedA = `"${uesc("0041")}"`;
    expect(escapedA).toHaveLength(8); // quote, backslash, u, four digits, quote: it is spelled out
    expect(jsonValue(escapedA)).toEqual(jsonValue('"A"'));
    expect(jsonValue(escapedA)).toEqual({ t: "str", v: "A" });
    expect(jsonValue(`"${uesc("00e9")}"`)).toEqual(jsonValue('"\u{E9}"'));
    expect(jsonValue(`"${uesc("00E9")}"`)).toEqual(jsonValue('"\u{E9}"'));
    expect(jsonValue(`{"${uesc("0061")}":"${uesc("0062")}"}`)).toEqual(jsonValue('{"a":"b"}'));
  });

  test("all eight short escapes and a surrogate pair", () => {
    expect(jsonValue(String.raw`"\"\\\/\b\f\n\r\t"`)).toEqual({ t: "str", v: '"\\/\b\f\n\r\t' });
    expect(jsonValue(`"${uesc("d83d")}${uesc("de00")}"`)).toEqual({ t: "str", v: "\u{1F600}" });
  });

  test("a lone surrogate escape is a value, kept as the code unit, and printed back as an escape", () => {
    const value = jsonValue(String.raw`"\ud800"`);
    expect(value).toEqual({ t: "str", v: "\ud800" });
    expect(canonicalJson(value)).toBe(String.raw`"\ud800"`);
  });

  test("an escaped and an unescaped spelling of a document are the same tree", () => {
    const escaped = `{"na${uesc("006d")}e":"${uesc("0045")}EG","tag":"a\\/b"}`;
    const plainText = '{"name":"EEG","tag":"a/b"}';
    expect(jsonValue(escaped)).toEqual(jsonValue(plainText));
    expect(canonicalJson(jsonValue(escaped))).toBe(plainText);
  });
});

describe("parseJson keeps the order of keys, and a key named __proto__ is a key", () => {
  test("keys come back in source order, not sorted", () => {
    const value = jsonValue('{"b":1,"a":2,"c":3,"B":4}');
    expect(value.t === "obj" && value.keys).toEqual(["b", "a", "c", "B"]);
    expect(canonicalJson(value)).toBe('{"b":1,"a":2,"c":3,"B":4}');
  });

  test("__proto__ is held as an ordinary key and pollutes nothing", () => {
    const value = jsonValue('{"__proto__":{"polluted":true},"a":1,"constructor":2,"toString":3}');
    if (value.t !== "obj") throw new Error("not an object");
    expect(value.keys).toEqual(["__proto__", "a", "constructor", "toString"]);
    expect(value.v.get("__proto__")).toEqual({
      t: "obj",
      keys: ["polluted"],
      v: new Map([["polluted", { t: "bool", v: true }]]),
    });
    expect(value.v.get("constructor")).toEqual({ t: "num", v: "2" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(canonicalJson(value)).toBe(
      '{"__proto__":{"polluted":true},"a":1,"constructor":2,"toString":3}',
    );
  });
});

describe("canonicalJson", () => {
  test("no whitespace, source key order, strings re-encoded, numbers as written", () => {
    const text = `  { "b" : [ 1 , 2.50 , "A\\/${uesc("0041")}" , true , false , null ] ,
      "a" : { } , "c" : [ ] , "d${uesc("00e9")}" : "line\\nbreak\\t\\"q\\"" }  `;
    expect(canonicalJson(jsonValue(text))).toBe(
      `{"b":[1,2.50,"A/A",true,false,null],"a":{},"c":[],"d\u{E9}":"line\\nbreak\\t\\"q\\""}`,
    );
  });

  test("two spellings of the same document have one text, and a different value has another", () => {
    const a = canonicalJson(jsonValue('{"a": [1, 2], "b": "x"}'));
    const b = canonicalJson(jsonValue('{"a":[1,2],"b":"\\u0078"}'));
    expect(a).toBe(b);
    expect(canonicalJson(jsonValue('{"a":[1,2],"b":"y"}'))).not.toBe(a);
    expect(canonicalJson(jsonValue('{"b":"x","a":[1,2]}'))).not.toBe(a); // key order is data
    expect(canonicalJson(jsonValue('"1"'))).not.toBe(canonicalJson(jsonValue("1")));
    expect(canonicalJson(jsonValue("[1]"))).not.toBe(canonicalJson(jsonValue("1")));
  });

  test("parsing the canonical text gives the same tree and the same canonical text again", () => {
    const value = jsonValue('{"a":[1.0,{"b":"\\u00e9"}],"c":{"d":null}}');
    const text = canonicalJson(value);
    expect(jsonValue(text)).toEqual(value);
    expect(canonicalJson(jsonValue(text))).toBe(text);
  });
});

describe("parseJson agrees with JSON.parse wherever JSON.parse is strict", () => {
  const WHITESPACE = ["", "", " ", "\n", "\t", "\r\n", "  \n  "];
  const NUMBERS = [
    "0",
    "-0",
    "1",
    "-1",
    "10",
    "1.5",
    "-0.25",
    "1e5",
    "1E-5",
    "2.5e+10",
    "123456789012345678901234567890",
    "0.0001",
  ];
  const STRINGS = [
    "",
    "a",
    "a b",
    "\\n",
    "\\u0041",
    '\\"',
    "\\\\",
    "\\/",
    "\u{E9}",
    "\\ud83d\\ude00",
    "\\u00e9",
    "tab\\t",
    "{}[],:",
    "\u{1F600}",
  ];

  function generate(random: () => number, depth: number): string {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const ws = () => pick(WHITESPACE);
    const kind = Math.floor(random() * (depth >= 4 ? 5 : 7));
    switch (kind) {
      case 0:
        return "null";
      case 1:
        return random() < 0.5 ? "true" : "false";
      case 2:
        return pick(NUMBERS);
      case 3:
      case 4:
        return `"${pick(STRINGS)}"`;
      case 5: {
        const items = Array.from({ length: Math.floor(random() * 4) }, () =>
          generate(random, depth + 1),
        );
        return `[${ws()}${items.join(`${ws()},${ws()}`)}${ws()}]`;
      }
      default: {
        const members = Array.from(
          { length: Math.floor(random() * 4) },
          (_, i) =>
            `"k${i}${pick(["", "\\u0041", "\u{E9}"])}"${ws()}:${ws()}${generate(random, depth + 1)}`,
        );
        return `{${ws()}${members.join(`${ws()},${ws()}`)}${ws()}}`;
      }
    }
  }

  test("2,000 generated documents parse to what JSON.parse parses, and print back to a stable text", () => {
    const random = seeded(8259);
    for (let n = 0; n < 2000; n++) {
      const text = `${WHITESPACE[n % WHITESPACE.length]}${generate(random, 0)}${WHITESPACE[(n + 3) % WHITESPACE.length]}`;
      const value = jsonValue(text);
      expect(plain(value), `case ${n}: ${text}`).toEqual(JSON.parse(text));
      const canonical = canonicalJson(value);
      expect(canonicalJson(jsonValue(canonical)), `case ${n}`).toBe(canonical);
    }
  });

  test("4,000 one-character corruptions of those documents are refused exactly when JSON.parse refuses them", () => {
    const random = seeded(1);
    const pool = [..."[]{},:\"\\0189-.eEtfnx +/*'"].concat([
      "\n",
      "\t",
      "\r",
      "\u{A0}",
      "\u{E9}",
      "\u{FEFF}",
      "\u{1F600}",
    ]);
    let refused = 0;
    let read = 0;
    for (let n = 0; n < 4000; n++) {
      const original = generate(random, 0);
      const at = Math.floor(random() * (original.length + 1));
      const op = Math.floor(random() * 3);
      const ch = pool[Math.floor(random() * pool.length)] as string;
      // Work on code points, so a corruption never leaves half of a surrogate pair behind.
      const points = [...original];
      if (op === 0) points.splice(at, 0, ch);
      else if (op === 1) points.splice(at, 1);
      else points.splice(at, 1, ch);
      const text = points.join("");

      let strict: unknown;
      let strictOk = true;
      try {
        // A leading BOM is removed by the byte checks before the grammar sees the text.
        strict = JSON.parse(text.startsWith("\u{FEFF}") ? text.slice(1) : text);
      } catch {
        strictOk = false;
      }
      const parsed = parseJson(enc(text));
      if (strictOk) {
        // JSON.parse keeps the last of a repeated key; this parser refuses it and says so.
        if (!parsed.ok) expect(parsed.refusal, JSON.stringify(text)).toBe("duplicate_key");
        else expect(plain(parsed.value.value), JSON.stringify(text)).toEqual(strict);
        read++;
      } else {
        expect(parsed.ok, JSON.stringify(text)).toBe(false);
        refused++;
      }
    }
    // Both outcomes were exercised in quantity, so neither side of the comparison is vacuous.
    expect(refused).toBeGreaterThan(1000);
    expect(read).toBeGreaterThan(300);
  });
});
