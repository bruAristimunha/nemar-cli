/**
 * The pure half of Part B (design `.context/plans/pr-review-change-summary.md`, sections B1 to B7):
 * what a pull request changed of the README, CHANGES and author fields the original authors
 * published. Bytes and strings in, counts and closed words out; nothing here touches git or a file.
 * Every part's blob id is the real git id of its bytes, so a test that says two parts are one blob
 * means it.
 */

import { describe, expect, test } from "bun:test";
import { classifyPath } from "../scripts/ci/pr-review-evidence";
import {
  ALTERS_PARTICIPANT_VALUE,
  ANCHOR_LOOKUPS,
  ARRAY_VALUED_KEYS,
  AUTHOR_OWNED_KEYS,
  type AlignOp,
  type AuthorFieldFacts,
  type AuthorOwnedKey,
  type DescriptionSide,
  type DocumentKind,
  type DocumentPart,
  type DocumentResult,
  MINOR_EDIT_KEYS,
  ORIGINAL_ABANDONED,
  ORIGINAL_LIMITS,
  type OriginalContentFacts,
  type OriginalContentInput,
  PARTICIPANT_FILES,
  PROSE_REFUSALS,
  type PointerProbe,
  type ProseDocument,
  type ProseFacts,
  type ProseRead,
  type ProseRefusal,
  REVIEW_LEFT_OUT_DIRS,
  type RecordingChange,
  type RecordingFacts,
  type VersionTag,
  alignLines,
  annexSide,
  assembleDocument,
  authorFieldFacts,
  authorFieldsAltered,
  chooseAnchor,
  decodeProse,
  hidesText,
  inReviewedScope,
  isDocumentName,
  isMinorEdit,
  levenshteinWithin,
  minorBound,
  minorEditHides,
  normalizeProse,
  originalContentFacts,
  parseVersionTags,
  participantValuesAltered,
  proseAltered,
  proseFacts,
  protectedMask,
  recordingFacts,
} from "../scripts/ci/pr-review-original";
import {
  ABANDONED_SUMMARY,
  CLASS_KINDS,
  type ChangeSummary,
  type ClassKind,
  EMPTY_SUMMARY,
  ROLE_OF,
  summarizeChanges,
} from "../scripts/ci/pr-review-summary";

const encoder = new TextEncoder();

/** A seeded generator (mulberry32), so a random test fails the same way every time it fails. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One element of `items`, chosen by `random`. */
function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** `count` distinct lines that share nothing with another prefix's. */
function distinctLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
}

/** `count` lines of `length` random letters from `seed`: no two are a minor edit of each other. */
function farLines(count: number, length: number, seed: number): string[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () =>
    Array.from({ length }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join(""),
  );
}

/** The id git gives a blob of these bytes. */
function gitOid(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`blob ${bytes.length}\0`);
  hasher.update(bytes);
  return hasher.digest("hex");
}

/** A regular file of the document with this text or these bytes. */
function part(name: string, content: string | Uint8Array, mode = "100644"): DocumentPart {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  return { name, mode, oid: gitOid(bytes), content: bytes };
}

/** The document a side assembles to, or a failed expectation naming the refusal. */
function assembled(read: ProseRead<ProseDocument>): ProseDocument {
  if (!read.ok) throw new Error(`refused: ${read.refusal}`);
  return read.value;
}

const NO_SKIP: ReadonlySet<string> = new Set();

describe("the limits and the refusal words", () => {
  test("the limits are the approved numbers, and every one is a positive integer", () => {
    expect(ORIGINAL_LIMITS).toEqual({
      maxDocumentBytes: 4 * 1024 * 1024,
      maxDocumentParts: 16,
      maxDocumentLines: 20_000,
      maxEditDistance: 2_000,
      maxMinorPairs: 4_096,
      maxMinorPairCodePoints: 4 * 1024 * 1024,
      minorFloor: 3,
      minorCeiling: 20,
      pointerMaxBytes: 1_023,
      maxTagsTried: 32,
    });
    for (const [name, value] of Object.entries(ORIGINAL_LIMITS)) {
      expect(Number.isInteger(value) && value > 0, name).toBe(true);
    }
  });

  test("the refusal words are a closed list, each once and in snake case", () => {
    expect([...PROSE_REFUSALS]).toEqual([
      "too_large",
      "too_many_parts",
      "too_many_lines",
      "binary",
      "not_regular",
      "unreadable",
      "edit_distance_cap",
    ]);
    expect(new Set(PROSE_REFUSALS).size).toBe(PROSE_REFUSALS.length);
    for (const word of PROSE_REFUSALS) expect(word).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
  });
});

describe("document names", () => {
  test("every root README form is one README document, whatever its case or extension", () => {
    for (const name of [
      "README",
      "README.md",
      "README.rst",
      "README.txt",
      "readme.md",
      "ReadMe.TXT",
      "README.markdown",
      "README.pdf",
    ]) {
      expect(isDocumentName("readme", name), name).toBe(true);
      expect(isDocumentName("changes", name), name).toBe(false);
    }
  });

  test("a README below the root, with two extensions or with anything else in its name is not one", () => {
    for (const name of [
      "docs/README.md",
      "sub-01/README",
      "README.md.bak",
      "README.",
      "README-old.md",
      "READMEmd",
      "README.m-d",
      " README",
      "README.md/",
    ]) {
      expect(isDocumentName("readme", name), name).toBe(false);
    }
  });

  test("CHANGES and CHANGELOG are one document, bare or as Markdown, text or reStructuredText", () => {
    for (const name of [
      "CHANGES",
      "CHANGES.md",
      "changes.txt",
      "CHANGELOG",
      "Changelog.rst",
      "CHANGELOG.MD",
    ]) {
      expect(isDocumentName("changes", name), name).toBe(true);
      expect(isDocumentName("readme", name), name).toBe(false);
    }
    for (const name of [
      "CHANGES.json",
      "CHANGES.md.orig",
      "derivatives/CHANGES",
      "CHANGES_old",
      "CHANGE",
      "CHANGELOGS",
    ]) {
      expect(isDocumentName("changes", name), name).toBe(false);
    }
  });
});

describe("decodeProse", () => {
  test("UTF-8 is read as UTF-8, and a leading byte order mark is dropped", () => {
    expect(decodeProse(encoder.encode("caf\u{E9} \u{2603} \u{1D49C}"))).toEqual({
      text: "caf\u{E9} \u{2603} \u{1D49C}",
      notUtf8: false,
    });
    expect(decodeProse(encoder.encode("\u{FEFF}Title"))).toEqual({
      text: "Title",
      notUtf8: false,
    });
    // Only one is a byte order mark; a second U+FEFF is text.
    expect(decodeProse(encoder.encode("\u{FEFF}\u{FEFF}x")).text).toBe("\u{FEFF}x");
  });

  test("bytes that are not UTF-8 are ISO-8859-1, not windows-1252, and say so", () => {
    const decoded = decodeProse(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x9f]));
    expect(decoded.notUtf8).toBe(true);
    // windows-1252 would read 0x80 as the euro sign and 0x9F as Y with a diaeresis.
    expect(decoded.text).toBe("caf\u{E9} \u{80}\u{9F}");
    expect(decoded.text).not.toContain("\u{20AC}");
  });

  test("a lone 0xEF that does not start a byte order mark is a character of an ISO-8859-1 text", () => {
    expect(decodeProse(new Uint8Array([0xef, 0x41, 0xe9]))).toEqual({
      text: "\u{EF}A\u{E9}",
      notUtf8: true,
    });
    expect(decodeProse(new Uint8Array([0xef, 0xbb, 0x41]))).toEqual({
      text: "\u{EF}\u{BB}A",
      notUtf8: true,
    });
  });

  test("a byte order mark before bytes that are not UTF-8 is still dropped", () => {
    expect(decodeProse(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xe9]))).toEqual({
      text: "A\u{E9}",
      notUtf8: true,
    });
  });

  test("a long ISO-8859-1 text is decoded whole, byte for byte", () => {
    const bytes = new Uint8Array(70_001).map((_, i) => (i % 3 === 0 ? 0xe9 : 0x41 + (i % 26)));
    const decoded = decodeProse(bytes);
    expect(decoded.notUtf8).toBe(true);
    expect(decoded.text.length).toBe(bytes.length);
    for (const i of [0, 1, 0x1fff, 0x2000, 0x2001, 70_000]) {
      expect(decoded.text.charCodeAt(i), String(i)).toBe(bytes[i] as number);
    }
  });
});

describe("normalizeProse", () => {
  test("LF, CRLF and a lone CR each end a line, and the kind of break is named", () => {
    expect(normalizeProse("a\nb\n").breaks).toBe("lf");
    expect(normalizeProse("a\r\nb\r\n").breaks).toBe("crlf");
    expect(normalizeProse("a\rb\r").breaks).toBe("cr");
    expect(normalizeProse("a\r\nb\nc").breaks).toBe("mixed");
    expect(normalizeProse("a\rb\nc").breaks).toBe("mixed");
    expect(normalizeProse("one line").breaks).toBe("none");
    for (const text of ["a\nb\n", "a\r\nb\r\n", "a\rb\r", "a\r\nb\rc", "a\nb"]) {
      const texts = normalizeProse(text).lines.map((line) => line.text);
      expect(texts[0], JSON.stringify(text)).toBe("a");
      expect(texts[1], JSON.stringify(text)).toBe("b");
      for (const line of texts) expect(line).not.toContain("\r");
    }
  });

  test("the same text with CRLF, LF or CR breaks normalizes to the same lines", () => {
    const lf = normalizeProse("# Title\n\nFirst line\nsecond line\n\nNext\n").lines;
    expect(
      normalizeProse("# Title\r\n\r\nFirst line\r\nsecond line\r\n\r\nNext\r\n").lines,
    ).toEqual(lf);
    expect(normalizeProse("# Title\r\rFirst line\rsecond line\r\rNext").lines).toEqual(lf);
  });

  test("trailing spaces and tabs go; leading indentation, inner spacing, case and NBSP stay", () => {
    const { lines } = normalizeProse("  indented \t \nInner  two\u{A0}spaces\t\nCASE\n");
    expect(lines.map((line) => line.text)).toEqual([
      "  indented",
      "Inner  two\u{A0}spaces",
      "CASE",
    ]);
    // A no-break space at the end of a line is a character, not trailing space.
    expect(normalizeProse("x\u{A0}").lines[0]?.text).toBe("x\u{A0}");
  });

  test("a blank line, or one of only spaces and tabs, is dropped and starts the next paragraph", () => {
    const { lines } = normalizeProse("First\nsame paragraph\n\nSecond\n \t \nThird\nmore\n");
    expect(lines).toEqual([
      { text: "First", paragraphStart: true },
      { text: "same paragraph", paragraphStart: false },
      { text: "Second", paragraphStart: true },
      { text: "Third", paragraphStart: true },
      { text: "more", paragraphStart: false },
    ]);
  });

  test("the first line kept starts a paragraph even after leading blank lines", () => {
    expect(normalizeProse("\n\n  \nStart\nnext").lines).toEqual([
      { text: "Start", paragraphStart: true },
      { text: "next", paragraphStart: false },
    ]);
  });

  test("whether the text ends with a break is kept, so a final newline added can be told", () => {
    expect(normalizeProse("a\nb").endsWithBreak).toBe(false);
    expect(normalizeProse("a\nb\n").endsWithBreak).toBe(true);
    expect(normalizeProse("a\r\n").endsWithBreak).toBe(true);
    expect(normalizeProse("a\r").endsWithBreak).toBe(true);
    expect(normalizeProse("").endsWithBreak).toBe(false);
    expect(normalizeProse("a\nb").lines).toEqual(normalizeProse("a\nb\n").lines);
  });

  test("a last line with no line break is counted against the bound too", () => {
    expect(normalizeProse("a\nb\nc", 2).overLimit).toBe(true);
    expect(normalizeProse("a\nb", 2).overLimit).toBe(false);
    const limit = ORIGINAL_LIMITS.maxDocumentLines;
    expect(normalizeProse(`${"a\n".repeat(limit)}z`, limit).overLimit).toBe(true);
    expect(normalizeProse(`${"a\n".repeat(limit - 1)}z`, limit).overLimit).toBe(false);
  });

  test("reading stops at the bound: two million short lines are read only up to line 20,001", () => {
    const limit = ORIGINAL_LIMITS.maxDocumentLines;
    const text = "a\n".repeat(2 * 1024 * 1024);
    const meter = { units: 0 };
    expect(normalizeProse(text, limit, meter).overLimit).toBe(true);
    // Line 20,001 ends at code unit 40,001: nothing after it is read.
    expect(meter.units).toBe(2 * (limit + 1));
    const whole = { units: 0 };
    normalizeProse("a\nb\n", limit, whole);
    expect(whole.units).toBe(4);
  });

  test("a heading, the line after it and a list item start a paragraph; nothing else of Markdown is read", () => {
    const flags = (text: string) => normalizeProse(text).lines.map((line) => line.paragraphStart);
    expect(flags("Intro.\n## Methods\nText.\nMore text.\n")).toEqual([true, true, true, false]);
    expect(flags("Intro.\n#\nText.\n")).toEqual([true, true, true]);
    expect(flags("Items:\n- a\n* b\n+ c\n1. d\n22) e\ncontinued\n")).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    // Not a heading or a list item: no blank after the marker, four spaces, seven #, ten digits.
    expect(flags("Text.\n#hashtag\n    # code\n####### seven\n-dash\n1234567890. big\n")).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    // Setext headings, block quotes, fences and tables are not read: blank lines alone govern them.
    expect(flags("Title\n=====\n> quote\n```\n| a | b |\n")).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    // Up to three spaces before a marker it is a list item; four make the line the paragraph's
    // text. micromark with GFM renders `Text.` then `   - a` as a paragraph and a list, and with
    // four spaces as one paragraph; the same for `1.`.
    for (const marker of ["-", "1."]) {
      for (const indent of [0, 1, 2, 3]) {
        expect(flags(`Text.\n${" ".repeat(indent)}${marker} a\n`), `${indent} ${marker}`).toEqual([
          true,
          true,
        ]);
      }
      for (const indent of [4, 5, 8]) {
        expect(flags(`Text.\n${" ".repeat(indent)}${marker} a\n`), `${indent} ${marker}`).toEqual([
          true,
          false,
        ]);
      }
    }
    // Inside a list too: micromark renders `- a` then `    2. c` as one item whose text holds both.
    expect(flags("- a\n    2. c\n")).toEqual([true, false]);
  });

  test("an ordered marker other than 1, or a marker with nothing after it, starts no paragraph inside one", () => {
    const flags = (text: string) => normalizeProse(text).lines.map((line) => line.paragraphStart);
    // micromark with GFM renders each of these as one paragraph: CommonMark lets only a bullet, or
    // exactly 1. or 1), with text after it interrupt a paragraph.
    expect(flags("Line one.\n2. INSERTED.\nLine two.\n")).toEqual([true, false, false]);
    expect(flags("The study began in\n2019. The study enrolled forty adults.\n")).toEqual([
      true,
      false,
    ]);
    expect(flags("foo\n01. bar\n")).toEqual([true, false]);
    expect(flags("foo\n1.\nbar\n")).toEqual([true, false, false]);
    expect(flags("foo\n*\nbar\n")).toEqual([true, false, false]);
    expect(flags("foo\n2. a\n3. b\n")).toEqual([true, false, false]);
    // A bullet, or 1) or 1., with text after it does interrupt one.
    expect(flags("foo\n1) bar\n")).toEqual([true, true]);
    expect(flags("foo\n1. bar\n2. baz\n")).toEqual([true, true, true]);
    expect(flags("foo\n-\tbar\n")).toEqual([true, true]);
    // Where no paragraph is open the others start one too: on the first line, after a blank line
    // or a heading, after an item, or after a line that continues an item with no blank line.
    expect(flags("2. x\n")).toEqual([true]);
    expect(flags("Text.\n\n2. x\n")).toEqual([true, true]);
    expect(flags("# H\n2. x\n")).toEqual([true, true]);
    expect(flags("Items:\n- a\n2019. b\n")).toEqual([true, true, true]);
    expect(flags("Items:\n1. a\nb\nc\n2. d\n")).toEqual([true, true, false, false, true]);
    // A blank line or a heading closes the list: a plain line after it opens a paragraph again.
    expect(flags("1. a\n\nfoo\n2. b\n")).toEqual([true, true, false]);
    expect(flags("- a\n# H\nText.\n2. b\n")).toEqual([true, true, true, false]);
  });

  test("the block flags cost one pass over 4 MiB of headings, list items or a hostile line", () => {
    const size = 4 * 1024 * 1024;
    const fill = (unit: string): string => unit.repeat(Math.ceil(size / unit.length));
    for (const text of [
      fill("#\n"),
      fill("- \n"),
      fill("1) x\n"),
      `#${" ".repeat(size)}x`,
      fill("   1234567890"),
    ]) {
      const started = performance.now();
      normalizeProse(text);
      expect(performance.now() - started, text.slice(0, 6)).toBeLessThan(10_000);
    }
  });

  test("a single break is named too: one LF is lf, one CRLF is crlf", () => {
    expect(normalizeProse("a\n").breaks).toBe("lf");
    expect(normalizeProse("a\r\n").breaks).toBe("crlf");
    expect(normalizeProse("one\ntwo").breaks).toBe("lf");
    expect(normalizeProse("one\r\ntwo").breaks).toBe("crlf");
  });

  test("with a line bound, reading stops at the first line past it", () => {
    expect(normalizeProse("a\nb\n", 2).overLimit).toBe(false);
    expect(normalizeProse("a\nb\n").overLimit).toBe(false);
    const over = normalizeProse("a\nb\nc\n", 2);
    expect(over.overLimit).toBe(true);
    expect(over.lines.map((line) => line.text)).toEqual(["a", "b", "c"]);
    // Blank lines are not lines: they never bring a text over the bound.
    expect(normalizeProse("a\n\n\n\nb\n", 2).overLimit).toBe(false);
    // 4 MiB of two-byte lines holds two million lines; only the bound and one more are built.
    const flood = normalizeProse("a\n".repeat(2 * 1024 * 1024), ORIGINAL_LIMITS.maxDocumentLines);
    expect(flood.overLimit).toBe(true);
    expect(flood.lines.length).toBe(ORIGINAL_LIMITS.maxDocumentLines + 1);
  });

  test("a hostile megabyte of spaces before a letter is normalized in linear time", () => {
    const spaces = " ".repeat(1024 * 1024);
    const started = performance.now();
    const { lines } = normalizeProse(`${spaces}x${spaces}\n${spaces}\nend`);
    // A backtracking expression for trailing blanks takes hours here; the loop takes milliseconds.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(lines).toEqual([
      { text: `${spaces}x`, paragraphStart: true },
      { text: "end", paragraphStart: true },
    ]);
  });
});

describe("assembleDocument", () => {
  test("parts are read in code-unit order of their names, each starting a paragraph", () => {
    const doc = assembled(
      assembleDocument(
        "readme",
        [part("README.rst", "rst\n"), part("readme.txt", "lower\n"), part("README", "a\nb\n")],
        NO_SKIP,
      ),
    );
    // Upper case sorts before lower case in code units, whatever a locale would say.
    expect(doc.lines).toEqual([
      { text: "a", paragraphStart: true, part: "README" },
      { text: "b", paragraphStart: false, part: "README" },
      { text: "rst", paragraphStart: true, part: "README.rst" },
      { text: "lower", paragraphStart: true, part: "readme.txt" },
    ]);
  });

  test("the end of one part and the start of the next are never one paragraph", () => {
    // Without a final newline the two files would read as one line run if they were joined as text.
    const doc = assembled(
      assembleDocument(
        "readme",
        [part("README", "end of one"), part("README.md", "start")],
        NO_SKIP,
      ),
    );
    expect(doc.lines.map((line) => line.paragraphStart)).toEqual([true, true]);
  });

  test("a part that is not a regular file is not_regular; an executable file is regular", () => {
    for (const mode of ["120000", "160000", "040000", "100664"]) {
      expect(assembleDocument("readme", [part("README.md", "x", mode)], NO_SKIP), mode).toEqual({
        ok: false,
        refusal: "not_regular",
      });
    }
    expect(assembleDocument("readme", [part("README.md", "x", "100755")], NO_SKIP).ok).toBe(true);
  });

  test("a part the caller could not read is unreadable, never an empty part", () => {
    const missing: DocumentPart = {
      name: "README",
      mode: "100644",
      oid: "0".repeat(40),
      content: "unreadable",
    };
    expect(assembleDocument("readme", [part("README.md", "x"), missing], NO_SKIP)).toEqual({
      ok: false,
      refusal: "unreadable",
    });
  });

  test("the refusal word depends on the parts, not on the order they are listed", () => {
    const link = part("README", "target", "120000");
    const missing: DocumentPart = {
      name: "README.md",
      mode: "100644",
      oid: "0".repeat(40),
      content: "unreadable",
    };
    for (const parts of [
      [link, missing],
      [missing, link],
    ]) {
      expect(assembleDocument("readme", parts, NO_SKIP)).toEqual({
        ok: false,
        refusal: "not_regular",
      });
    }
  });

  test("more than sixteen parts is too_many_parts; sixteen are read", () => {
    const names = Array.from({ length: 17 }, (_, i) => `README.x${i}`);
    const parts = names.map((name) => part(name, `${name}\n`));
    expect(assembleDocument("readme", parts, NO_SKIP)).toEqual({
      ok: false,
      refusal: "too_many_parts",
    });
    expect(assembled(assembleDocument("readme", parts.slice(0, 16), NO_SKIP)).lines.length).toBe(
      16,
    );
  });

  test("more than 4 MiB over every part of a side is too_large; exactly 4 MiB is read", () => {
    const half = ORIGINAL_LIMITS.maxDocumentBytes / 2;
    const exact = [part("README", "a".repeat(half)), part("README.md", "b".repeat(half))];
    expect(assembleDocument("readme", exact, NO_SKIP).ok).toBe(true);
    const over = [part("README", "a".repeat(half)), part("README.md", "b".repeat(half + 1))];
    expect(assembleDocument("readme", over, NO_SKIP)).toEqual({ ok: false, refusal: "too_large" });
  });

  test("a NUL byte is binary, unless the part is the same blob on both sides and is skipped", () => {
    const pdf = part("README.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x41]));
    const text = part("README.md", "# Title\n");
    expect(assembleDocument("readme", [text, pdf], NO_SKIP)).toEqual({
      ok: false,
      refusal: "binary",
    });
    const doc = assembled(assembleDocument("readme", [text, pdf], new Set([pdf.oid])));
    expect(doc.lines).toEqual([{ text: "# Title", paragraphStart: true, part: "README.md" }]);
    // The skip set holds ids of blobs found on both sides; a text part in it is still read.
    expect(assembled(assembleDocument("readme", [text], new Set([text.oid]))).lines.length).toBe(1);
  });

  test("more than 20,000 normalized lines is too_many_lines; blank lines are not counted", () => {
    const limit = ORIGINAL_LIMITS.maxDocumentLines;
    const atLimit = part("CHANGES", "entry\n\n".repeat(limit));
    expect(assembled(assembleDocument("changes", [atLimit], NO_SKIP)).lines.length).toBe(limit);
    const over = [part("CHANGES", "entry\n".repeat(limit)), part("CHANGELOG", "one more\n")];
    expect(assembleDocument("changes", over, NO_SKIP)).toEqual({
      ok: false,
      refusal: "too_many_lines",
    });
    // The bound is the side's, shared by its parts in order.
    const split = (second: number) => [
      part("CHANGELOG", "a\n".repeat(limit - 5_000)),
      part("CHANGES", "b\n".repeat(second)),
    ];
    expect(assembleDocument("changes", split(5_000), NO_SKIP).ok).toBe(true);
    expect(assembleDocument("changes", split(5_001), NO_SKIP)).toEqual({
      ok: false,
      refusal: "too_many_lines",
    });
    // 4 MiB of two-byte lines, within the byte bound, is refused by its lines.
    const flood = part("CHANGES", "a\n".repeat(2 * 1024 * 1024));
    expect(assembleDocument("changes", [flood], NO_SKIP)).toEqual({
      ok: false,
      refusal: "too_many_lines",
    });
  });

  test("line breaks are named over every part together, and a part not UTF-8 is said", () => {
    const lf = part("README", "a\nb\n");
    const crlf = part("README.md", "c\r\n");
    const none = part("README.txt", "d");
    expect(assembled(assembleDocument("readme", [lf, none], NO_SKIP)).breaks).toBe("lf");
    expect(assembled(assembleDocument("readme", [lf, crlf], NO_SKIP)).breaks).toBe("mixed");
    expect(assembled(assembleDocument("readme", [none], NO_SKIP)).breaks).toBe("none");
    expect(assembled(assembleDocument("readme", [lf, crlf], NO_SKIP)).notUtf8).toBe(false);
    const latin = part("README.rst", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const doc = assembled(assembleDocument("readme", [lf, latin], NO_SKIP));
    expect(doc.notUtf8).toBe(true);
    expect(doc.lines.map((line) => line.text)).toEqual(["a", "b", "caf\u{E9}"]);
  });

  test("whether each part that is not empty ends with a break is kept by name", () => {
    const doc = assembled(
      assembleDocument(
        "readme",
        [part("README", "a\nb"), part("README.md", "c\n"), part("README.txt", "")],
        NO_SKIP,
      ),
    );
    expect([...doc.finalBreak]).toEqual([
      ["README", false],
      ["README.md", true],
    ]);
  });

  test("no part at all is an empty document, not a refusal", () => {
    expect(assembled(assembleDocument("changes", [], NO_SKIP))).toEqual({
      lines: [],
      breaks: "none",
      notUtf8: false,
      finalBreak: new Map(),
    });
  });

  test("a part that is not the document's, or a name given twice, is a defect and throws", () => {
    expect(() => assembleDocument("readme", [part("CHANGES", "x")], NO_SKIP)).toThrow();
    expect(() => assembleDocument("changes", [part("docs/CHANGES", "x")], NO_SKIP)).toThrow();
    expect(() =>
      assembleDocument("readme", [part("README", "x"), part("README", "y")], NO_SKIP),
    ).toThrow();
  });
});

/** The Levenshtein distance over code points, every cell computed: the oracle for the banded one. */
function fullLevenshtein(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) {
      next[j] = Math.min(
        (row[j - 1] as number) + (x[i - 1] === y[j - 1] ? 0 : 1),
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
      );
    }
    row = next;
  }
  return row[y.length] as number;
}

/** A string of `count` code points, each one from `alphabet`. */
function randomText(random: () => number, alphabet: readonly string[], count: number): string {
  return Array.from({ length: count }, () => pick(random, alphabet)).join("");
}

describe("minorBound and isMinorEdit", () => {
  test("the bound is a tenth of the longer line in code points, never under 3 or over 20", () => {
    const table: [number, number][] = [
      [0, 3],
      [1, 3],
      [29, 3],
      [39, 3],
      [40, 4],
      [49, 4],
      [50, 5],
      [99, 9],
      [100, 10],
      [199, 19],
      [200, 20],
      [201, 20],
      [10_000, 20],
    ];
    for (const [length, bound] of table) {
      expect(minorBound("a".repeat(length), "b"), String(length)).toBe(bound);
      expect(minorBound("b", "a".repeat(length)), String(length)).toBe(bound);
    }
  });

  test("an astral character is one code point of the length, not two code units", () => {
    // Forty astral characters are eighty UTF-16 code units, which would give a bound of 8.
    expect(minorBound("\u{1D49C}".repeat(40), "")).toBe(4);
    expect(minorBound("e\u{301}".repeat(20), "")).toBe(4);
  });

  test("an edit exactly at the bound is minor, and one more is not", () => {
    for (const length of [30, 100, 150, 1_000]) {
      const line = "a".repeat(length);
      const bound = minorBound(line, line);
      const edited = (count: number) => "b".repeat(count) + line.slice(count);
      expect(isMinorEdit(line, edited(bound)), String(length)).toBe(true);
      expect(isMinorEdit(line, edited(bound + 1)), String(length)).toBe(false);
    }
  });

  test("a typo fix is minor; a rewritten sentence and a case change of a sentence are not", () => {
    const fixed = "Participants were recruited from the community and gave written consent.";
    expect(
      isMinorEdit("Participants were recruted from the comunity and gave writen consent.", fixed),
    ).toBe(true);
    expect(isMinorEdit(fixed, "Volunteers came from a hospital and consented verbally.")).toBe(
      false,
    );
    expect(isMinorEdit(fixed, fixed.toUpperCase())).toBe(false);
  });

  test("a short negation in a line of forty characters is within the bound: the accepted cost", () => {
    // The owner kept minor edits as information the model judges (design B2, Owner Question B2).
    expect(
      isMinorEdit(
        "The recordings in this dataset are valid.",
        "The recordings in this dataset are not valid.",
      ),
    ).toBe(true);
    expect(isMinorEdit("The data are valid.", "The data are not valid.")).toBe(false);
  });
});

describe("levenshteinWithin", () => {
  test("the distance when it is at most k, and k + 1 when it is more", () => {
    expect(levenshteinWithin("kitten", "sitting", 3)).toBe(3);
    expect(levenshteinWithin("kitten", "sitting", 20)).toBe(3);
    expect(levenshteinWithin("kitten", "sitting", 2)).toBe(3);
    expect(levenshteinWithin("kitten", "sitting", 0)).toBe(1);
    expect(levenshteinWithin("same", "same", 0)).toBe(0);
    expect(levenshteinWithin("", "abc", 5)).toBe(3);
    expect(levenshteinWithin("", "abc", 1)).toBe(2);
    expect(levenshteinWithin("abc", "", 3)).toBe(3);
  });

  test("an astral character is one edit and a combining mark is one edit of its own", () => {
    expect(levenshteinWithin("\u{1F600}", "a", 5)).toBe(1);
    expect(levenshteinWithin("\u{1D49C}b", "b", 5)).toBe(1);
    expect(levenshteinWithin("\u{1F600}x", "\u{1F603}x", 5)).toBe(1);
    // A precomposed letter against a letter and a combining accent: one replaced, one removed.
    expect(levenshteinWithin("\u{E9}", "e\u{301}", 5)).toBe(2);
  });

  test("it equals the full distance capped at k + 1 over seeded random strings", () => {
    const random = mulberry32(0x1859);
    const alphabet = ["a", "b", "c", "\u{301}", "\u{E9}", "\u{1F600}", "\u{1F603}", "\u{1D49C}"];
    for (let trial = 0; trial < 400; trial++) {
      const a = randomText(random, alphabet, Math.floor(random() * 24));
      const b =
        random() < 0.5
          ? randomText(random, alphabet, Math.floor(random() * 24))
          : Array.from(a)
              .map((ch) => (random() < 0.15 ? pick(random, alphabet) : ch))
              .join("");
      const full = fullLevenshtein(a, b);
      for (const k of [0, 1, 2, 3, 5, 10, 20]) {
        expect(levenshteinWithin(a, b, k), `${JSON.stringify(a)} ${JSON.stringify(b)} ${k}`).toBe(
          Math.min(full, k + 1),
        );
      }
    }
  });

  test("a megabyte line costs nothing against a short one and one linear pass against another", () => {
    const body = "a".repeat(1024 * 1024);
    let started = performance.now();
    expect(levenshteinWithin(body, "short", 20)).toBe(21);
    expect(performance.now() - started).toBeLessThan(2_000);
    // Different first and last characters, so no prefix or suffix can be cut: the band is walked.
    started = performance.now();
    expect(levenshteinWithin(`x${body}y`, `z${body}w`, 20)).toBe(2);
    expect(levenshteinWithin(`x${body}y`, `${body}`, 20)).toBe(2);
    expect(performance.now() - started).toBeLessThan(20_000);
  });
});

/** The length of a longest common subsequence, every cell computed: the oracle for alignLines. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const next = [0];
    for (let j = 1; j <= b.length; j++) {
      next[j] =
        a[i - 1] === b[j - 1]
          ? (row[j - 1] as number) + 1
          : Math.max(row[j] as number, next[j - 1] as number);
    }
    row = next;
  }
  return row[b.length] as number;
}

/** `b` rebuilt from `a` and a script, or a thrown error where the script is not one for them. */
function replay(a: readonly string[], b: readonly string[], ops: readonly AlignOp[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "equal") {
      if (a[i] !== b[j] || i >= a.length)
        throw new Error(`equal op on different lines at ${i}, ${j}`);
      out.push(a[i] as string);
      i++;
      j++;
    } else if (op === "delete") i++;
    else out.push(b[j++] as string);
  }
  if (i !== a.length || j !== b.length) throw new Error("the script does not cover both sides");
  return out;
}

/** Whether nothing is left of one side once the common prefix and suffix are matched. */
function oneSided(a: readonly string[], b: readonly string[]): boolean {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    prefix + suffix < a.length &&
    prefix + suffix < b.length &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return prefix + suffix === a.length || prefix + suffix === b.length;
}

/** The same items in a seeded random order (Fisher-Yates). */
function shuffled<T>(lines: readonly T[], random: () => number): T[] {
  const out = [...lines];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe("alignLines", () => {
  test("the script is a shortest one, against an independent LCS over seeded random sequences", () => {
    const random = mulberry32(0x7353);
    for (let trial = 0; trial < 600; trial++) {
      const alphabet = "abcdef".slice(0, 1 + Math.floor(random() * 6)).split("");
      const a = Array.from({ length: Math.floor(random() * 30) }, () => pick(random, alphabet));
      const b = Array.from({ length: Math.floor(random() * 30) }, () => pick(random, alphabet));
      const label = `${a.join("")} ${b.join("")}`;
      const alignment = alignLines(a, b, a.length + b.length);
      if (alignment === null) throw new Error(`capped below its own size: ${label}`);
      expect(replay(a, b, alignment.ops), label).toEqual(b);
      const lcs = lcsLength(a, b);
      expect(alignment.distance, label).toBe(a.length + b.length - 2 * lcs);
      expect(alignment.ops.filter((op) => op === "equal").length, label).toBe(lcs);
      // At its own distance the script is found; one less is over the cap unless a side is empty.
      expect(alignLines(a, b, alignment.distance), label).toEqual(alignment);
      if (alignment.distance > 0) {
        expect(alignLines(a, b, alignment.distance - 1) === null, label).toBe(!oneSided(a, b));
      }
    }
  });

  test("the tie-break is pinned, so the same pull request always pairs the same lines", () => {
    expect(alignLines(["x"], ["y"])?.ops).toEqual(["delete", "insert"]);
    expect(alignLines(["a", "b"], ["b", "a"])?.ops).toEqual(["delete", "equal", "insert"]);
    expect(alignLines(["b", "a"], ["c", "b"])?.ops).toEqual(["insert", "equal", "delete"]);
    expect(alignLines(["a", "a"], ["b", "a", "c"])?.ops).toEqual([
      "insert",
      "equal",
      "delete",
      "insert",
    ]);
  });

  test("lines are compared exactly, with no normalization of their own", () => {
    expect(alignLines(["a "], ["a"])?.distance).toBe(2);
    expect(alignLines(["A"], ["a"])?.distance).toBe(2);
  });

  test("an edit distance of exactly 2,000 is aligned and 2,001 is capped", () => {
    const aligned = alignLines(distinctLines("old", 1000), distinctLines("new", 1000));
    expect(aligned?.distance).toBe(2000);
    expect(alignLines(distinctLines("old", 1001), distinctLines("new", 1000))).toBeNull();
    // The same boundary at a small cap, where it is easy to read.
    expect(alignLines(["a"], ["b"], 2)?.distance).toBe(2);
    expect(alignLines(["a"], ["b"], 1)).toBeNull();
  });

  test("pure insertion or pure removal is never capped, however long", () => {
    const base = distinctLines("original", 10);
    const appended = [...base, ...distinctLines("new section", 5_000)];
    const end = alignLines(base, appended);
    expect(end?.distance).toBe(5_000);
    expect(end?.ops.slice(0, 10)).toEqual(new Array(10).fill("equal"));
    const middle = [...base.slice(0, 5), ...distinctLines("inserted", 5_000), ...base.slice(5)];
    expect(alignLines(base, middle, 0)?.distance).toBe(5_000);
    expect(alignLines(appended, base, 0)?.distance).toBe(5_000);
  });

  test("20,000 shuffled lines stop at the cap after a bounded number of steps", () => {
    const random = mulberry32(0x20000);
    const lines = distinctLines("line", 20_000);
    const meter = { steps: 0 };
    const started = performance.now();
    expect(alignLines(lines, shuffled(lines, random), undefined, meter)).toBeNull();
    const elapsed = performance.now() - started;
    const maxD = ORIGINAL_LIMITS.maxEditDistance;
    // One step per diagonal tried at each distance up to the cap, and at most one per matching
    // cell: with distinct lines a line matches exactly one other, so 20,000 cells at most.
    expect(meter.steps).toBeLessThanOrEqual(((maxD + 1) * (maxD + 2)) / 2 + lines.length);
    expect(meter.steps).toBeGreaterThan(((maxD + 1) * (maxD + 2)) / 2 - 1);
    expect(elapsed).toBeLessThan(10_000);
  });

  test("a two-line alphabet, the most matches per diagonal, stays within the O((N + M) D) bound", () => {
    const random = mulberry32(0x2);
    const a = Array.from({ length: 20_000 }, () => (random() < 0.5 ? "0" : "1"));
    const b = Array.from({ length: 20_000 }, () => (random() < 0.5 ? "0" : "1"));
    const meter = { steps: 0 };
    const started = performance.now();
    expect(alignLines(a, b, undefined, meter)).toBeNull();
    const maxD = ORIGINAL_LIMITS.maxEditDistance;
    // A diagonal's furthest point only moves forward, so each of the 2D + 1 diagonals walks at most
    // N matching lines in all.
    expect(meter.steps).toBeLessThanOrEqual(
      ((maxD + 1) * (maxD + 2)) / 2 + (2 * maxD + 1) * a.length,
    );
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

/** A document's parts, from file names to texts or bytes. */
type Files = Record<string, string | Uint8Array>;

function parts(files: Files): DocumentPart[] {
  return Object.entries(files).map(([name, content]) => part(name, content));
}

/** The facts of a document, or a failed expectation naming the refusal. */
function factsOf(
  document: DocumentKind,
  base: Files,
  head: Files,
  anchor: Files | null = null,
): ProseFacts {
  const result = proseFacts({
    document,
    base: parts(base),
    head: parts(head),
    anchor: anchor === null ? null : parts(anchor),
  });
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  return result.facts;
}

const readme = (base: Files, head: Files, anchor: Files | null = null): ProseFacts =>
  factsOf("readme", base, head, anchor);

/** A README as original authors publish one: a title and three paragraphs under headings. */
const ORIGINAL_LINES = [
  "# Visual oddball EEG", // 0
  "",
  "This dataset contains EEG recordings from 24 healthy adults", // 2
  "performing a visual oddball task with 20% rare targets.", // 3
  "",
  "## Participants", // 5
  "",
  "Participants were recruited from the university community", // 7
  "and gave written informed consent before the session.", // 8
  "",
  "## Recording", // 10
  "",
  "Data were recorded with a 64-channel system at 512 Hz.", // 12
];
const ORIGINAL = `${ORIGINAL_LINES.join("\n")}\n`;
const ORIGINAL_PROTECTED = 8;

/** The original README with its raw lines (blank ones included, numbered above) edited. */
function edited(edit: (lines: string[]) => void, text = ORIGINAL): string {
  const lines = text.replace(/\n$/, "").split("\n");
  edit(lines);
  return `${lines.join("\n")}\n`;
}

/** The facts of a README whose every protected line is kept and nothing else happened. */
function untouched(protectedLines: number, overrides: Partial<ProseFacts> = {}): ProseFacts {
  return {
    document: "readme",
    anchor: "merge_base",
    preserved: true,
    protectedLines,
    protectedAltered: 0,
    minorEdits: 0,
    laterAltered: 0,
    moved: false,
    movedLines: 0,
    insertedInsideParagraph: 0,
    joinedInsertedRuns: 0,
    insertedLines: 0,
    lineEndingsChanged: false,
    finalNewlineAdded: false,
    notUtf8: false,
    partsBefore: 1,
    partsAfter: 1,
    hidingMarkupInserted: 0,
    shownPartReplaced: false,
    ...overrides,
  };
}

describe("protectedMask", () => {
  test("every CHANGES line is protected, with an anchor or without one", () => {
    expect(protectedMask("changes", ["a", "b", "a"], null)).toEqual([true, true, true]);
    expect(protectedMask("changes", ["a", "b", "a"], [])).toEqual([true, true, true]);
  });

  test("with no anchor every README line at the merge base is protected", () => {
    expect(protectedMask("readme", ["a", "b"], null)).toEqual([true, true]);
  });

  test("a README line is protected when its text is in the anchor, every copy of it", () => {
    expect(protectedMask("readme", ["a", "new", "b"], ["a", "b"])).toEqual([true, false, true]);
    // Copies are not counted: one copy at the anchor protects every copy at the base.
    expect(protectedMask("readme", ["a", "x", "a"], ["a"])).toEqual([true, false, true]);
    expect(protectedMask("readme", ["a"], ["a", "a"])).toEqual([true]);
    expect(protectedMask("readme", ["a", "a", "a"], ["a", "a"])).toEqual([true, true, true]);
  });

  test("an original line minor-edited since the tag is protected, paired within its hunk", () => {
    const anchor = ["# Methods", "Each recording lasted ten minutes."];
    expect(
      protectedMask(
        "readme",
        ["# Methods", "Each recordng lasted ten minutes.", "A later line."],
        anchor,
      ),
    ).toEqual([true, true, false]);
    // Pairs are made inside a hunk, not by line number: a line added above shifts every index.
    expect(
      protectedMask(
        "readme",
        ["A new first line.", "# Methods", "Each recordng lasted ten minutes."],
        anchor,
      ),
    ).toEqual([false, true, true]);
    // Edits that add up past the minor bound against the anchor line leave it unprotected.
    expect(
      protectedMask("readme", ["# Methods", "Each recordng lastd tn minuts."], anchor),
    ).toEqual([true, false]);
  });

  test("an anchor with no line, or too far from the base to align, protects every base line", () => {
    expect(protectedMask("readme", ["a", "b"], [])).toEqual([true, true]);
    expect(
      protectedMask("readme", distinctLines("base", 1000), distinctLines("anchor", 1001)),
    ).toEqual(new Array(1000).fill(true));
    // Twenty thousand lines against the same lines shuffled: capped after bounded work.
    const random = mulberry32(0x1882);
    const lines = distinctLines("line", 20_000);
    const meter = { steps: 0 };
    const started = performance.now();
    const mask = protectedMask("readme", shuffled(lines, random), lines, meter);
    expect(mask.every(Boolean)).toBe(true);
    const maxD = ORIGINAL_LIMITS.maxEditDistance;
    expect(meter.steps).toBeLessThanOrEqual(((maxD + 1) * (maxD + 2)) / 2 + lines.length);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test("a typo merged after the tag does not let a second pull request rewrite the line", () => {
    const anchor = "# Methods\n\nEach recording lasted ten minutes.\nThe room was dark.\n";
    const afterTypo = anchor.replace("recording", "recordng");
    const rewritten = anchor.replace(
      "Each recording lasted ten minutes.",
      "Recordings were of variable length.",
    );
    // Step two, with step one merged: the rewrite of the minor-edited line still fails.
    const twoStep = readme(
      { "README.md": afterTypo },
      { "README.md": rewritten },
      { "README.md": anchor },
    );
    expect(twoStep.protectedAltered).toBe(1);
    expect(twoStep.laterAltered).toBe(0);
    expect(proseAltered(twoStep)).toBe(true);
    // The control: the same rewrite without step one fails too.
    const direct = readme(
      { "README.md": anchor },
      { "README.md": rewritten },
      { "README.md": anchor },
    );
    expect(direct.protectedAltered).toBe(1);
    // A line added after the tag stays later text: rewriting it is information.
    const noted = `${anchor}\n## Notes\n\nA note added later.\n`;
    const later = readme(
      { "README.md": noted },
      { "README.md": noted.replace("A note added later.", "Another note.") },
      { "README.md": anchor },
    );
    expect(later.laterAltered).toBe(1);
    expect(later.protectedAltered).toBe(0);
    expect(proseAltered(later)).toBe(false);
  });

  test("the original copy is protected even when a later copy was added above it", () => {
    // The anchor holds b then a; a copy of a was added above b later. Removing the original a
    // (the last line) is an alteration, never later text: counting copies protected the wrong one.
    const facts = readme(
      { "README.md": "a\n\nb\n\na\n" },
      { "README.md": "a\n\nb\n" },
      { "README.md": "b\n\na\n" },
    );
    expect(facts.protectedLines).toBe(3);
    expect(facts.protectedAltered).toBe(1);
    expect(facts.laterAltered).toBe(0);
    expect(facts.preserved).toBe(false);
    expect(proseAltered(facts)).toBe(true);
  });
  // Lines far from one another (random letters, never a minor edit of each other), and one edit.
  const FAR = farLines(70, 60, 0x1882);
  const typo = (line: string, at = 3): string =>
    `${line.slice(0, at)}${line[at] === "Z" ? "Y" : "Z"}${line.slice(at + 1)}`;
  const TOP = "# Methods";
  const END = "## Recording";

  test("an edited original line next to a new line of its hunk is protected", () => {
    const anchor = [TOP, "Each recording lasted ten minutes.", END];
    // The hunk removes the anchor line and inserts two: a new sentence, then the edited line.
    const base = [TOP, "A sentence merged later.", "Each recordng lasted ten minutes.", END];
    expect(protectedMask("readme", base, anchor)).toEqual([true, false, true, true]);
    // New lines at both ends of a hunk of two edited lines.
    const [a, b] = FAR as [string, string];
    expect(
      protectedMask(
        "readme",
        [TOP, "New first.", typo(a), typo(b), "New last.", END],
        [TOP, a, b, END],
      ),
    ).toEqual([true, false, true, true, false, true]);
  });

  test("a typo merged beside a new line still keeps a later rewrite of the line from passing", () => {
    const anchor = "# Methods\n\nEach recording lasted ten minutes.\nThe room was dark.\n";
    // Merged after the tag: a new sentence above the line, and a typo in it.
    const merged = anchor.replace("Each recording", "A sentence merged later.\nEach recordng");
    const rewritten = merged.replace(
      "Each recordng lasted ten minutes.",
      "Recordings were of variable length.",
    );
    const facts = readme(
      { "README.md": merged },
      { "README.md": rewritten },
      { "README.md": anchor },
    );
    expect(facts.anchor).toBe("first_version_tag");
    expect(facts.protectedAltered).toBe(1);
    expect(facts.laterAltered).toBe(0);
    expect(proseAltered(facts)).toBe(true);
  });

  test("one anchor line protects every edited copy of it; a line near two anchor lines is protected", () => {
    const [a] = FAR as [string];
    // The line copied and each copy edited in its own place.
    expect(protectedMask("readme", [TOP, typo(a, 3), typo(a, 40), END], [TOP, a, END])).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // The anchor holding the line twice, the base once, edited.
    expect(protectedMask("readme", [TOP, typo(a), END], [TOP, a, a, END])).toEqual([
      true,
      true,
      true,
    ]);
    const ten = "Each recording lasted ten minutes.";
    const two = "Each recording lasted two minutes.";
    const near = "Each recording lasted tn minutes.";
    expect(isMinorEdit(ten, near) && isMinorEdit(two, near)).toBe(true);
    expect(protectedMask("readme", [TOP, near, END], [TOP, ten, two, END])).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("an anchor line removed in one hunk does not shift the pairs of the next", () => {
    const [a, b, c, d] = FAR as [string, string, string, string];
    // Two hunks: b removed on its own, then d edited.
    expect(protectedMask("readme", [a, c, typo(d)], [a, b, c, d])).toEqual([true, true, true]);
  });

  test("past the pair cap a hunk is paired from its start and from its end", () => {
    const lines = FAR.slice(0, 65);
    const edits = lines.map((line) => typo(line));
    const anchor = [TOP, ...lines, END];
    expect(lines.length * (lines.length + 1)).toBeGreaterThan(ORIGINAL_LIMITS.maxMinorPairs);
    const all = edits.map(() => true);
    // A new line above the edited ones: the pairs from the end find every edit.
    expect(protectedMask("readme", [TOP, "New first.", ...edits, END], anchor)).toEqual([
      true,
      false,
      ...all,
      true,
    ]);
    // A new line below them: the pairs from the start do.
    expect(protectedMask("readme", [TOP, ...edits, "New last.", END], anchor)).toEqual([
      true,
      ...all,
      false,
      true,
    ]);
    // New lines at both ends: neither does, the accepted limit.
    expect(
      protectedMask("readme", [TOP, "New first.", ...edits, "New last.", END], anchor),
    ).toEqual([true, false, ...edits.map(() => false), false, true]);
    // Under the cap the same shape has every pair tried, and every edit is found.
    const fewer = lines.slice(0, 60);
    expect(fewer.length * (fewer.length + 2)).toBeLessThanOrEqual(ORIGINAL_LIMITS.maxMinorPairs);
    expect(
      protectedMask(
        "readme",
        [TOP, "New first.", ...fewer.map((line) => typo(line)), "New last.", END],
        [TOP, ...fewer, END],
      ),
    ).toEqual([true, false, ...fewer.map(() => true), false, true]);
  });

  // Two long lines of random letters, each a thousand-letter block repeated `blocks` times.
  const longPair = (seed: number, blocks: number): [string, string] => {
    const [x, y] = farLines(2, 1_000, seed) as [string, string];
    return [x.repeat(blocks), y.repeat(blocks)];
  };

  test("a hunk whose pairs would take more code points than the budget is paired from its ends", () => {
    const budget = ORIGINAL_LIMITS.maxMinorPairCodePoints;
    // Four pairs of 1.1 million code points each are past the budget, so the edits between two
    // new lines are not found.
    const [x, y] = longPair(1, 1_100);
    expect(4 * x.length).toBeGreaterThan(budget);
    expect(
      protectedMask(
        "readme",
        [TOP, "New first.", typo(x), typo(y), "New last.", END],
        [TOP, x, y, END],
      ),
    ).toEqual([true, false, false, false, false, true]);
    // Half as long, the hunk is within it: every pair is tried.
    const [u, v] = longPair(2, 550);
    expect(4 * u.length).toBeLessThanOrEqual(budget);
    expect(
      protectedMask(
        "readme",
        [TOP, "New first.", typo(u), typo(v), "New last.", END],
        [TOP, u, v, END],
      ),
    ).toEqual([true, false, true, true, false, true]);
  });

  test("the budget is spent across hunks: a later hunk past what is left is paired from its ends", () => {
    const [u, v] = longPair(3, 550);
    const [w, z] = longPair(4, 550);
    // Each hunk is within the budget alone, not both together.
    expect(4 * u.length).toBeLessThanOrEqual(ORIGINAL_LIMITS.maxMinorPairCodePoints);
    expect(8 * u.length).toBeGreaterThan(ORIGINAL_LIMITS.maxMinorPairCodePoints);
    const base = [TOP, "N1.", typo(u), typo(v), "N2.", END, "N3.", typo(w), typo(z), "N4.", TOP];
    expect(protectedMask("readme", base, [TOP, u, v, END, w, z, TOP])).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  test("hostile hunks stay bounded in steps and time", () => {
    const maxD = ORIGINAL_LIMITS.maxEditDistance;
    // Two thousand lines against two thousand others: past the alignment's cap, every base line
    // protected and no pair tried.
    let meter = { steps: 0 };
    let started = performance.now();
    const capped = protectedMask("readme", farLines(2_000, 60, 5), farLines(2_000, 60, 6), meter);
    expect(capped.every(Boolean)).toBe(true);
    expect(meter.steps).toBeLessThanOrEqual(((maxD + 1) * (maxD + 2)) / 2 + 4_000);
    expect(performance.now() - started).toBeLessThan(10_000);
    // A thousand edited lines: the largest hunk the alignment takes, past the pair cap, every
    // edit found by the pairs from the start.
    const thousand = farLines(1_000, 60, 7);
    meter = { steps: 0 };
    started = performance.now();
    const paired = protectedMask(
      "readme",
      thousand.map((line) => typo(line)),
      thousand,
      meter,
    );
    expect(paired.every(Boolean)).toBe(true);
    expect(meter.steps).toBeLessThanOrEqual(((maxD + 1) * (maxD + 2)) / 2 + 2_000);
    expect(performance.now() - started).toBeLessThan(10_000);
    // Sixty-four against sixty-four lines of 65,535 code points, near copies of one line that differ
    // in 22 places spread along them, so no pair is a minor edit and no banded distance stops
    // early: past the budget, paired from the start only (as many lines on each side).
    const random = mulberry32(0x40);
    const length = 65_535;
    const shared = Array.from({ length }, () =>
      String.fromCharCode(97 + Math.floor(random() * 26)),
    );
    const copy = (tag: number): string => {
      const letters = [...shared];
      letters[0] = String.fromCharCode(0x100 + tag);
      for (let e = 0; e < 21; e++) {
        letters[Math.floor(((e + 0.5) * length) / 21)] = String.fromCharCode(0x4e00 + tag * 32 + e);
      }
      return letters.join("");
    };
    const anchor = Array.from({ length: 64 }, (_, i) => copy(i));
    const base = Array.from({ length: 64 }, (_, i) => copy(i + 64));
    started = performance.now();
    expect(protectedMask("readme", base, anchor).some(Boolean)).toBe(false);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test("an anchor too far from the base to align, or with no line, leaves the facts on the merge base", () => {
    const base = `${farLines(1_100, 60, 8).join("\n\n")}\n`;
    const head = `${base}\nA new line.\n`;
    const far = readme(
      { "README.md": base },
      { "README.md": head },
      {
        "README.md": `${farLines(1_100, 60, 9).join("\n\n")}\n`,
      },
    );
    expect(far.anchor).toBe("merge_base");
    expect(far.protectedLines).toBe(1_100);
    const blank = readme({ "README.md": base }, { "README.md": head }, { "README.md": "\n\n" });
    expect(blank.anchor).toBe("merge_base");
    // The control: the base as its own anchor aligns.
    expect(readme({ "README.md": base }, { "README.md": head }, { "README.md": base }).anchor).toBe(
      "first_version_tag",
    );
  });
});

describe("proseFacts: the cases of design B7", () => {
  test("a README whose last line gains a final newline and a new section is preserved (on005398)", () => {
    const base = ORIGINAL.replace(/\n$/, "");
    const head = `${base}\n\n## Changes in 1.0.1\n\nEvent codes were corrected; see CHANGES.\n`;
    const facts = readme({ "README.md": base }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, { insertedLines: 2, finalNewlineAdded: true }),
    );
    expect(proseAltered(facts)).toBe(false);
  });

  test("a README turned from CRLF to LF with a section appended is preserved and says so (on004703)", () => {
    const base = ORIGINAL.replaceAll("\n", "\r\n");
    const head = `${ORIGINAL}\n## Derivatives\n\nNone yet.\n`;
    const facts = readme({ README: base }, { README: head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, { insertedLines: 2, lineEndingsChanged: true }),
    );
    expect(proseAltered(facts)).toBe(false);
  });

  test("removing an original paragraph is an alteration", () => {
    const head = edited((lines) => lines.splice(7, 3));
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        protectedAltered: 2,
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  const CURATION =
    "\n## NEMAR curation changes (2026-05-21)\n\n- Events were re-aligned to the photodiode.\n- Channel labels were made BIDS compliant.\n";
  const CURATION_REWORDED =
    "\n## NEMAR curation changes (2026-05-21)\n\n- Onsets now come from light sensor timestamps, not triggers.\n- Every electrode name follows the BIDS label rules now.\n";

  test("rewording a section added after the version tag is information, not an alteration (on002578)", () => {
    const facts = readme(
      { "README.md": ORIGINAL + CURATION },
      { "README.md": ORIGINAL + CURATION_REWORDED },
      { "README.md": ORIGINAL },
    );
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        anchor: "first_version_tag",
        laterAltered: 2,
        insertedLines: 2,
      }),
    );
    expect(proseAltered(facts)).toBe(false);
  });

  test("with no version tag every merge-base line is protected, later sections included", () => {
    const facts = readme(
      { "README.md": ORIGINAL + CURATION },
      { "README.md": ORIGINAL + CURATION_REWORDED },
    );
    expect(facts.anchor).toBe("merge_base");
    expect(facts.protectedLines).toBe(ORIGINAL_PROTECTED + 3);
    expect(facts.protectedAltered).toBe(2);
    expect(facts.laterAltered).toBe(0);
    expect(proseAltered(facts)).toBe(true);
  });

  test("an anchor with no README part, or one that cannot be read, protects every base line", () => {
    const base = { "README.md": ORIGINAL + CURATION };
    const head = { "README.md": ORIGINAL + CURATION_REWORDED };
    const strict = readme(base, head);
    const anchors: Files[] = [
      {},
      { "README.md": new Uint8Array([0x41, 0x00]) }, // binary, and not a blob of either side
      { "README.md": "" }, // a README with no line at all
      { "README.md": "\n  \n\t\n" }, // only blank lines
    ];
    for (const anchor of anchors) {
      expect(readme(base, head, anchor)).toEqual(strict);
    }
    const link = proseFacts({
      document: "readme",
      base: parts(base),
      head: parts(head),
      anchor: [part("README.md", "target", "120000")],
    });
    expect(link).toEqual({ ok: true, facts: strict });
  });

  test("a typo fixed within the minor bound is information; a sentence rewritten is altered", () => {
    const typo = edited((lines) => {
      lines[7] = "Participants were recruted from the univeristy community";
    });
    const fixed = readme({ "README.md": typo }, { "README.md": ORIGINAL });
    expect(fixed).toEqual(
      untouched(ORIGINAL_PROTECTED, { preserved: false, minorEdits: 1, insertedLines: 1 }),
    );
    expect(proseAltered(fixed)).toBe(false);
    const rewritten = edited((lines) => {
      lines[7] = "Volunteers answered an advertisement in the local newspaper";
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": rewritten });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        protectedAltered: 1,
        joinedInsertedRuns: 1,
        insertedLines: 1,
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("a line inserted between two lines of an original paragraph is an alteration", () => {
    const head = edited((lines) => lines.splice(8, 0, "Consent forms were later lost."));
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        insertedInsideParagraph: 1,
        joinedInsertedRuns: 1,
        insertedLines: 1,
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("a new paragraph between original ones is preserved", () => {
    const head = edited((lines) => lines.splice(9, 0, "", "Consent forms are kept by the lab."));
    expect(readme({ "README.md": ORIGINAL }, { "README.md": head })).toEqual(
      untouched(ORIGINAL_PROTECTED, { insertedLines: 1 }),
    );
  });

  test("a sentence added at the end of a paragraph without a blank line is left to the model", () => {
    // The base line after it starts a paragraph, so no original paragraph is split.
    const head = edited((lines) => lines.splice(9, 0, "Consent forms are kept by the lab."));
    expect(readme({ "README.md": ORIGINAL }, { "README.md": head })).toEqual(
      untouched(ORIGINAL_PROTECTED, { joinedInsertedRuns: 1, insertedLines: 1 }),
    );
  });

  test("a line inserted after a minor edit inside a paragraph is still inside the paragraph", () => {
    const head = edited((lines) => {
      lines[7] = "Participants were recruited from the University community";
      lines.splice(8, 0, "(most of them were psychology students)");
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        minorEdits: 1,
        insertedInsideParagraph: 1,
        joinedInsertedRuns: 1,
        insertedLines: 2,
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("a hunk pairs its j-th removed line of any kind with its j-th inserted line", () => {
    // The later line before the original one is paired too, so the original line's partner is its
    // own edited form; pairing only protected lines would give it the later line's replacement.
    const base = edited((lines) => lines.splice(12, 0, "A line added after the tag."));
    const head = edited((lines) => {
      lines.splice(
        12,
        1,
        "A later line, reworded.",
        "Data were recorded with a 64-channel system at 500 Hz.",
      );
    });
    const facts = readme({ "README.md": base }, { "README.md": head }, { "README.md": ORIGINAL });
    expect(facts.laterAltered).toBe(1);
    expect(facts.minorEdits).toBe(1);
    expect(facts.protectedAltered).toBe(0);
    expect(proseAltered(facts)).toBe(false);
  });

  test("a paragraph line rewritten as two lines is one alteration, not also an insertion inside", () => {
    // The extra line follows a line that did not survive, so it is counted once, as the alteration.
    const head = edited((lines) => {
      lines.splice(7, 1, "Volunteers answered an advertisement in the paper", "and were paid.");
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        protectedAltered: 1,
        joinedInsertedRuns: 1,
        insertedLines: 2,
      }),
    );
  });

  test("an original section moved below a new one is moved, and moved fails", () => {
    const head = edited((lines) => {
      const recording = lines.splice(10, 3);
      lines.splice(5, 0, ...recording, "");
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        moved: true,
        movedLines: 2,
        insertedLines: 2,
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("one protected line moved and nothing else changed is moved, and moved fails", () => {
    // The title goes from the top to a paragraph of its own at the end.
    const head = `${edited((lines) => lines.splice(0, 2))}\n${ORIGINAL_LINES[0]}\n`;
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        moved: true,
        movedLines: 1,
        insertedLines: 1,
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("a single LF turned into a single CRLF is a line-ending change", () => {
    const facts = readme({ README: "one\ntwo" }, { README: "one\r\ntwo" });
    expect(facts).toEqual(untouched(2, { lineEndingsChanged: true }));
  });

  test("Markdown headings rewritten as reStructuredText are minor edits and new underlines", () => {
    // Design B6.6: the heading lines lose their `#` within the minor bound, and each underline is a
    // new line joined to its heading. Nothing is altered; the model is shown the minor edits.
    const markdown = "# Title\n\nFirst paragraph.\n\n## Section\n\nSecond paragraph.\n";
    const rst = "Title\n=====\n\nFirst paragraph.\n\nSection\n-------\n\nSecond paragraph.\n";
    const facts = readme({ "README.md": markdown }, { "README.rst": rst });
    expect(facts).toEqual(
      untouched(4, {
        preserved: false,
        minorEdits: 2,
        joinedInsertedRuns: 2,
        insertedLines: 4,
      }),
    );
    expect(proseAltered(facts)).toBe(false);
  });

  test("a list item reflowed onto one line is still an alteration", () => {
    const base =
      "## Notes\n\n- The recordings of the second session were made\n  with a different amplifier.\n";
    const head =
      "## Notes\n\n- The recordings of the second session were made with a different amplifier.\n";
    const facts = readme({ "README.md": base }, { "README.md": head });
    expect(facts.protectedAltered).toBeGreaterThan(0);
    expect(proseAltered(facts)).toBe(true);
  });

  test("README.md renamed to README.rst, or README to README.md, with the same text is preserved", () => {
    expect(readme({ "README.md": ORIGINAL }, { "README.rst": ORIGINAL })).toEqual(
      untouched(ORIGINAL_PROTECTED),
    );
    expect(readme({ README: ORIGINAL }, { "README.md": ORIGINAL })).toEqual(
      untouched(ORIGINAL_PROTECTED),
    );
  });

  const CHANGES =
    "1.0.1 2024-03-01\n  - Fixed event onsets.\n\n1.0.0 2023-11-15\n  - Initial release.\n";

  test("a new CHANGES entry at the top is fine; editing an old entry, even by one letter, fails", () => {
    const top = factsOf(
      "changes",
      { CHANGES },
      { CHANGES: `1.0.2 2026-10-01\n  - Added a derivative.\n\n${CHANGES}` },
    );
    expect(top).toEqual(untouched(4, { document: "changes", insertedLines: 2 }));
    expect(proseAltered(top)).toBe(false);
    const typo = factsOf(
      "changes",
      { CHANGES },
      { CHANGES: CHANGES.replace("Fixed event onsets.", "Fixed event onset.") },
    );
    expect(typo).toEqual(
      untouched(4, {
        document: "changes",
        preserved: false,
        protectedAltered: 1,
        // The edited entry is a list item: a block of its own, joined to no paragraph.
        joinedInsertedRuns: 0,
        insertedLines: 1,
      }),
    );
    expect(proseAltered(typo)).toBe(true);
  });

  test("CHANGES ignores an anchor: its whole history at the merge base is protected", () => {
    const facts = factsOf("changes", { CHANGES }, { CHANGES }, { CHANGES: "1.0.0\n" });
    expect(facts.anchor).toBe("merge_base");
    expect(facts.protectedLines).toBe(4);
  });

  test("an entry put between CHANGES lines with no blank line between them is not an alteration", () => {
    const tight = "1.0.1 fixed onsets\n1.0.0 initial release\n";
    const facts = factsOf(
      "changes",
      { "CHANGES.md": tight },
      { "CHANGES.md": "1.0.1 fixed onsets\n1.0.0.1 a backport\n1.0.0 initial release\n" },
    );
    expect(facts.insertedInsideParagraph).toBe(1);
    expect(facts.preserved).toBe(false);
    expect(proseAltered(facts)).toBe(false);
  });
});

describe("proseFacts: a run is inside a paragraph only when no blank line sets it off", () => {
  /** The facts of a README pull request, and whether they are an alteration. */
  const judged = (base: string, head: string) => {
    const facts = readme({ "README.md": base }, { "README.md": head });
    return { facts, altered: proseAltered(facts) };
  };

  test("a section set off by blank lines before a heading the README never separated is an addition", () => {
    const base = "## Methods\nEEG at 500 Hz.\n## License\nCC0\n";
    const head =
      "## Methods\nEEG at 500 Hz.\n\n## Acknowledgments\n\nThanks to the lab.\n\n## License\nCC0\n";
    const { facts, altered } = judged(base, head);
    expect(facts.insertedInsideParagraph).toBe(0);
    expect(facts.joinedInsertedRuns).toBe(0);
    expect(facts.preserved).toBe(true);
    expect(altered).toBe(false);
  });

  test("a list item appended, then a blank line before the heading that followed the list, is an addition", () => {
    const base = "## Sessions\n- rest\n- task\n## License\nCC0\n";
    const head = "## Sessions\n- rest\n- task\n- recovery\n\n## License\nCC0\n";
    const { facts, altered } = judged(base, head);
    expect(facts.insertedInsideParagraph).toBe(0);
    // A list item is a block of its own: joined to no paragraph.
    expect(facts.joinedInsertedRuns).toBe(0);
    expect(altered).toBe(false);
  });

  test("a new section before a heading with no blank line above it is an addition", () => {
    const base = "# Title\n\nIntro text.\n## License\nCC0\n";
    const head = "# Title\n\nIntro text.\n\n## Funding\n\nFunded by a grant.\n## License\nCC0\n";
    const { facts, altered } = judged(base, head);
    expect(facts.insertedInsideParagraph).toBe(0);
    // The heading below it starts a block, so the new text joins no original paragraph.
    expect(facts.joinedInsertedRuns).toBe(0);
    expect(altered).toBe(false);
  });

  test("a paragraph put between two sentences of a one-sentence-per-line README, set off by blank lines, is an addition", () => {
    const base = "Sentence one.\nSentence two.\nSentence three.\nSentence four.\n";
    const head =
      "Sentence one.\nSentence two.\n\nA new paragraph.\n\nSentence three.\nSentence four.\n";
    const { facts, altered } = judged(base, head);
    expect(facts).toEqual(untouched(4, { insertedLines: 1 }));
    expect(altered).toBe(false);
  });

  test("a sentence put between two lines of a paragraph with no blank line is still inside, and altered", () => {
    const base = "Sentence one.\nSentence two.\nSentence three.\n";
    const head = "Sentence one.\nA new sentence.\nSentence two.\nSentence three.\n";
    const { facts, altered } = judged(base, head);
    expect(facts.insertedInsideParagraph).toBe(1);
    expect(altered).toBe(true);
    // A blank line on one side only: joined to the other side, information.
    const oneSide = judged(
      base,
      "Sentence one.\nA new sentence.\n\nSentence two.\nSentence three.\n",
    );
    expect(oneSide.facts.insertedInsideParagraph).toBe(0);
    expect(oneSide.facts.joinedInsertedRuns).toBe(1);
    expect(oneSide.altered).toBe(false);
  });

  test("a run after a minor edit, joined on both sides, is inside", () => {
    const base = "First original sentence of the paragraph.\nSecond original sentence of it.\n";
    const head =
      "First original sentence of the paragrapH.\nAn added sentence.\nSecond original sentence of it.\n";
    const { facts, altered } = judged(base, head);
    expect(facts.minorEdits).toBe(1);
    expect(facts.insertedInsideParagraph).toBe(1);
    expect(altered).toBe(true);
  });

  test("in a README with no blank lines, a section or a list item added before a heading is not inside", () => {
    const dense = "## Methods\nEEG at 500 Hz.\n## License\nCC0\n";
    const section = judged(
      dense,
      "## Methods\nEEG at 500 Hz.\n## Acknowledgments\nThanks to the lab.\n## License\nCC0\n",
    );
    expect(section.facts.insertedInsideParagraph).toBe(0);
    expect(section.facts.joinedInsertedRuns).toBe(0);
    expect(section.altered).toBe(false);
    const list = "## Sessions\n- rest\n- task\n## License\nCC0\n";
    const item = judged(list, "## Sessions\n- rest\n- task\n- recovery\n## License\nCC0\n");
    expect(item.facts.insertedInsideParagraph).toBe(0);
    expect(item.altered).toBe(false);
  });

  test("list items added to a dense list, at its end or between its items, are not inside", () => {
    const base = "Sessions:\n- rest\n- task\n- recovery\n";
    for (const head of [
      "Sessions:\n- rest\n- task\n- recovery\n- follow-up\n- debrief\n",
      "Sessions:\n- rest\n- practice\n- task\n- recovery\n",
      "Sessions:\n- rest\n1. practice\n- task\n- recovery\n",
    ]) {
      const { facts, altered } = judged(base, head);
      expect(facts.insertedInsideParagraph, head).toBe(0);
      expect(altered, head).toBe(false);
    }
  });

  test("a line opening with 2. or a year inside an original paragraph is in it, and altered", () => {
    const base = "Line one of the text.\nLine two of the text.\n";
    const numbered = judged(base, "Line one of the text.\n2. INSERTED.\nLine two of the text.\n");
    expect(numbered.facts.insertedInsideParagraph).toBe(1);
    expect(numbered.altered).toBe(true);
    // An original line opening with a year is in its paragraph: a line put above it is inside.
    const year = "The study began in\n2019. The study enrolled forty adults.\n";
    const above = judged(
      year,
      "The study began in\nA new line.\n2019. The study enrolled forty adults.\n",
    );
    expect(above.facts.insertedInsideParagraph).toBe(1);
    expect(above.altered).toBe(true);
    // The control: a bullet with text after it is a block of its own, between the two lines.
    const bullet = judged(base, "Line one of the text.\n- INSERTED.\nLine two of the text.\n");
    expect(bullet.facts.insertedInsideParagraph).toBe(0);
  });

  test("a line put right under a heading the README never separated is joined, not inside", () => {
    // The line after a heading starts a paragraph: micromark with GFM renders the heading, then the
    // new line and the original one as one paragraph.
    const { facts, altered } = judged(
      "## Methods\nEEG at 500 Hz.\n",
      "## Methods\nA new line.\nEEG at 500 Hz.\n",
    );
    expect(facts.insertedInsideParagraph).toBe(0);
    expect(facts.joinedInsertedRuns).toBe(1);
    expect(altered).toBe(false);
  });

  test("a heading put between two lines of an original paragraph is a new block, joined to the line below", () => {
    const base = "Line one of the text.\nLine two of the text.\nLine three of the text.\n";
    const { facts, altered } = judged(
      base,
      "Line one of the text.\nLine two of the text.\n## Notes\nA note.\nLine three of the text.\n",
    );
    expect(facts.insertedInsideParagraph).toBe(0);
    // The heading is a block of its own; the note after it reads as one paragraph with the
    // original third line: one joined run, information.
    expect(facts.joinedInsertedRuns).toBe(1);
    expect(altered).toBe(false);
    // Plain text with no heading or list marker is still inside, and altered.
    const plain = judged(
      base,
      "Line one of the text.\nLine two of the text.\nA note.\nLine three of the text.\n",
    );
    expect(plain.facts.insertedInsideParagraph).toBe(1);
    expect(plain.altered).toBe(true);
  });

  test("CHANGES written as list items takes a new entry anywhere, and an edited entry still fails", () => {
    const changes = "- 1.0.1 fixed event onsets\n- 1.0.0 initial release\n";
    for (const head of [
      `- 1.0.2 added a derivative\n${changes}`,
      "- 1.0.1 fixed event onsets\n- 1.0.0.1 a backport\n- 1.0.0 initial release\n",
    ]) {
      const facts = factsOf("changes", { CHANGES: changes }, { CHANGES: head });
      expect(facts.insertedInsideParagraph, head).toBe(0);
      expect(proseAltered(facts), head).toBe(false);
    }
    const edited = factsOf(
      "changes",
      { CHANGES: changes },
      { CHANGES: changes.replace("onsets", "onset") },
    );
    expect(edited.protectedAltered).toBe(1);
    expect(proseAltered(edited)).toBe(true);
  });

  test("a run that starts a new part in the head is never inside the paragraph it came between", () => {
    // B moved into a new part after the new line: at the base A and B were one paragraph, but in
    // the head the new line opens README.md, so a paragraph break sets it off.
    const facts = readme(
      { README: "Line A of the paragraph.\nLine B of the paragraph.\n" },
      {
        README: "Line A of the paragraph.\n",
        "README.md": "A new line.\nLine B of the paragraph.\n",
      },
    );
    expect(facts.protectedAltered + facts.movedLines).toBe(0);
    expect(facts.insertedInsideParagraph).toBe(0);
  });
});

describe("proseFacts: the adversarial cases of design B6", () => {
  test("trailing whitespace and line endings cleaned up everywhere is preserved", () => {
    const messy = ORIGINAL_LINES.map((line, i) => (i % 2 === 0 ? `${line} \t` : line)).join("\r\n");
    const facts = readme({ "README.md": messy }, { "README.md": ORIGINAL });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, { lineEndingsChanged: true, finalNewlineAdded: true }),
    );
  });

  test("indentation is significant: a small change is a minor edit", () => {
    const head = edited((lines) => {
      lines[12] = `    ${lines[12]}`;
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts.minorEdits).toBe(1);
    expect(facts.preserved).toBe(false);
    expect(proseAltered(facts)).toBe(false);
  });

  test("case is significant: one letter is a minor edit, a whole sentence is an alteration", () => {
    const one = edited((lines) => {
      lines[12] = "Data were recorded with a 64-Channel system at 512 Hz.";
    });
    expect(readme({ "README.md": ORIGINAL }, { "README.md": one }).minorEdits).toBe(1);
    const all = edited((lines) => {
      lines[12] = (lines[12] as string).toUpperCase();
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": all });
    expect(facts.protectedAltered).toBe(1);
    expect(proseAltered(facts)).toBe(true);
  });

  test("a README re-encoded from ISO-8859-1 to UTF-8 with a byte order mark compares its text", () => {
    const latin = new Uint8Array([...encoder.encode("Caf"), 0xe9, ...encoder.encode(" study\n")]);
    const facts = readme({ README: latin }, { README: "\u{FEFF}Caf\u{E9} study\n" });
    expect(facts).toEqual(untouched(1, { notUtf8: true }));
  });

  test("a README removed, with its text moved below the root, is every protected line altered", () => {
    const facts = readme({ "README.md": ORIGINAL }, {});
    expect(facts.protectedAltered).toBe(ORIGINAL_PROTECTED);
    expect(facts.partsAfter).toBe(0);
    expect(proseAltered(facts)).toBe(true);
  });

  test("a README added where there was none is only insertion", () => {
    const facts = readme({}, { "README.md": ORIGINAL });
    expect(facts).toEqual(untouched(0, { partsBefore: 0, insertedLines: ORIGINAL_PROTECTED }));
  });

  test("a later copy of an original line is protected too, so removing it is an alteration", () => {
    // The original line appears once at the tag and twice at the base. Which copy is the original
    // cannot be told from the text, so both are protected: removing the later one fails, the rare
    // false fail on the conservative side.
    const repeated = `${ORIGINAL}\n## Notes\n\n${ORIGINAL_LINES[12]}\n`;
    const head = `${ORIGINAL}\n## Notes\n\nSee the recording section.\n`;
    const facts = readme(
      { "README.md": repeated },
      { "README.md": head },
      { "README.md": ORIGINAL },
    );
    expect(facts.protectedLines).toBe(ORIGINAL_PROTECTED + 1);
    expect(facts.protectedAltered).toBe(1);
    expect(facts.laterAltered).toBe(0);
    expect(proseAltered(facts)).toBe(true);
  });

  test("two copies of a protected line removed and one put back elsewhere: one moved, one altered", () => {
    // Both copies of line 2 go (with the Notes heading), and one copy comes back as a new paragraph:
    // one copy found elsewhere is moved, and the other has nothing left to be found as.
    const twice = `${ORIGINAL}\n## Notes\n\n${ORIGINAL_LINES[2]}\n`;
    const head = edited((lines) => {
      lines.splice(9, 0, "", ORIGINAL_LINES[2] as string);
      lines.splice(2, 1, "A new opening sentence.");
    });
    const facts = readme({ "README.md": twice }, { "README.md": head });
    expect(facts.movedLines).toBe(1);
    expect(facts.protectedAltered).toBe(2);
    expect(proseAltered(facts)).toBe(true);
  });

  test("a line inserted at the end of one part is not inside the paragraph of the next part", () => {
    const base = {
      README: "First part, line one\nfirst part, line two\n",
      "README.md": "Second\npart\n",
    };
    const head = {
      README: "First part, line one\nfirst part, line two\nan added third line\n",
      "README.md": "Second\npart\n",
    };
    const facts = readme(base, head);
    expect(facts).toEqual(
      untouched(4, { partsBefore: 2, partsAfter: 2, joinedInsertedRuns: 1, insertedLines: 1 }),
    );
  });

  test("a final newline added to a renamed part is not one added to the same part", () => {
    const base = ORIGINAL.replace(/\n$/, "");
    expect(readme({ README: base }, { "README.md": ORIGINAL }).finalNewlineAdded).toBe(false);
    expect(readme({ README: base }, { README: ORIGINAL }).finalNewlineAdded).toBe(true);
  });
});

describe("proseFacts: the tripwires", () => {
  test("original paragraphs wrapped in an HTML comment are preserved but trip the markup fact", () => {
    const head = edited((lines) => {
      lines.splice(9, 0, "-->");
      lines.splice(7, 0, "<!--");
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts.protectedAltered + facts.movedLines + facts.minorEdits).toBe(0);
    expect(facts.hidingMarkupInserted).toBe(2);
    // Each marker touches the paragraph it wraps, with no blank line between.
    expect(facts.joinedInsertedRuns).toBe(2);
    // Not an alteration by itself: what the tripwire does is the caller's to decide.
    expect(proseAltered(facts)).toBe(false);
  });

  test("a details block around an original section trips the markup fact", () => {
    const head = edited((lines) => {
      lines.splice(10, 0, "<details><summary>Old notes</summary>", "");
      lines.push("", "</details>");
    });
    expect(readme({ "README.md": ORIGINAL }, { "README.md": head }).hidingMarkupInserted).toBe(2);
  });

  test("hiding markup put into original lines by minor edits trips the markup fact too", () => {
    const head = edited((lines) => {
      lines[2] = `<!-- ${lines[2]}`;
      lines[3] = `${lines[3]} -->`;
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts.minorEdits).toBe(2);
    // The two edited lines are next to each other: one run, read as one text, and each edit adds
    // a `<` or a `>`, so each counts once more on its own.
    expect(facts.hidingMarkupInserted).toBe(3);
    expect(facts.joinedInsertedRuns).toBe(0);
  });

  test("a paragraph made the open title of a link definition is joined and trips the markup fact", () => {
    // `[x]: <> "` right before the paragraph and `"` right after it, no blank line between: the
    // rendered README shows nothing of the paragraph, while every protected line is verbatim.
    const head = edited((lines) => {
      lines.splice(9, 0, '"');
      lines.splice(7, 0, '[x]: <> "');
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts.preserved).toBe(true);
    expect(facts.insertedInsideParagraph).toBe(0);
    expect(facts.joinedInsertedRuns).toBe(2);
    expect(facts.hidingMarkupInserted).toBe(1);
    expect(proseAltered(facts)).toBe(false);
  });

  test("a paragraph made the open title attribute of a link is joined and trips the markup fact", () => {
    const head = edited((lines) => {
      lines.splice(9, 0, '"></a>');
      lines.splice(7, 0, '<a title="');
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts.joinedInsertedRuns).toBe(2);
    expect(facts.hidingMarkupInserted).toBe(1);
  });

  test("the same title opened and closed by two minor edits trips the markup fact", () => {
    const first =
      "The recordings were made in a quiet, electrically shielded room at the university hospital.";
    const second = "Each session lasted about ninety minutes, with breaks between the blocks.";
    const base = `# Methods\n\n${first}\n${second}\n`;
    const head = `# Methods\n\n[x]:<>"${first}\n${second}"\n`;
    const facts = readme({ "README.md": base }, { "README.md": head });
    expect(facts.minorEdits).toBe(2);
    // The new text of a minor edit is no inserted run of its own, but it is read for markup: the
    // run once, and the first edit once more, being a definition that adds brackets.
    expect(facts.joinedInsertedRuns).toBe(0);
    expect(facts.hidingMarkupInserted).toBe(2);
    expect(proseAltered(facts)).toBe(false);
  });

  // One original paragraph of two long lines, every line protected (no tag): each attack below
  // makes the paragraph render as nothing (a footnote definition, a link definition, an image, a
  // tag around it) with edits inside the minor bound, so no other fact moves.
  const LINE_ONE = "The participants completed both sessions of the oddball task on separate days.";
  const LINE_TWO = "Sessions were scheduled at least one week apart, at the same time of the day.";
  const TWO_LINES = `# Methods\n\n${LINE_ONE}\n${LINE_TWO}\n`;

  test("the attacks rest on two lines of 78 and 77 characters, all within the minor bound", () => {
    expect([LINE_ONE.length, LINE_TWO.length]).toEqual([78, 77]);
  });

  for (const [label, head, hiding] of [
    [
      "a footnote definition before the first line",
      `# Methods\n\n[^a]: ${LINE_ONE}\n${LINE_TWO}\n`,
      1,
    ],
    [
      "a link definition around each line",
      `# Methods\n\n[a]: <${LINE_ONE}>\n[b]: <${LINE_TWO}>\n`,
      2,
    ],
    ["an image around each line", `# Methods\n\n![${LINE_ONE}]()\n![${LINE_TWO}]()\n`, 2],
    ["a tag around the first line", `# Methods\n\n<a ${LINE_ONE}>\n${LINE_TWO}\n`, 1],
  ] as [string, string, number][]) {
    test(`minor edits that make an original paragraph ${label} trip the markup fact`, () => {
      const facts = readme({ "README.md": TWO_LINES }, { "README.md": head });
      expect(facts.protectedAltered + facts.movedLines).toBe(0);
      expect(facts.minorEdits).toBeGreaterThan(0);
      expect(proseAltered(facts)).toBe(false);
      expect(facts.hidingMarkupInserted).toBe(hiding);
    });
  }

  test("a minor edit adding no bracket or angle bracket, an exclamation mark or a parenthesis, does not", () => {
    const head = `# Methods\n\n${LINE_ONE.replace("both", "(both)")}\n${LINE_TWO.replace(".", "!")}\n`;
    const facts = readme({ "README.md": TWO_LINES }, { "README.md": head });
    expect(facts.minorEdits).toBe(2);
    expect(facts.hidingMarkupInserted).toBe(0);
    expect(minorEditHides("see [1] and x", "see x and [1]")).toBe(false);
    expect(minorEditHides("a < b", "a < c")).toBe(false);
    for (const added of ["a [b", "a b]", "a <b", "a b>"]) {
      expect(minorEditHides("a b", added), added).toBe(true);
    }
    expect(minorEditHides("[x]: /a", "[x]: /b")).toBe(true);
    expect(minorEditHides("![a](b)", "![a](c)")).toBe(true);
  });

  test("a definition, a footnote, an image, a badge or a table in a new paragraph is not hiding", () => {
    for (const line of [
      "[1]: https://example.org/x",
      "[^1]: A note on the montage.",
      '<img src="montage.png" alt="Montage">',
      "[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.1.svg)](https://doi.org/10.5281/zenodo.1)",
      "![Montage](montage.png)",
      "<table><tr><td>Session</td><td>1</td></tr></table>",
    ]) {
      const head = `${ORIGINAL}\n## References\n\n${line}\n`;
      const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
      expect(facts.hidingMarkupInserted, line).toBe(0);
      expect(facts.preserved, line).toBe(true);
    }
    // All of them together in one new section, as a real README has them.
    const section = `${ORIGINAL}\n## References\n\n[1]: https://example.org/x\n[^1]: A note.\n\n<img src="m.png">\n`;
    expect(readme({ "README.md": ORIGINAL }, { "README.md": section }).hidingMarkupInserted).toBe(
      0,
    );
  });

  test("next to an original paragraph a footnote definition hides it; a complete link definition or an image does not", () => {
    // Directly above the Participants paragraph, with no blank line between.
    const above = (line: string) =>
      readme(
        { "README.md": ORIGINAL },
        { "README.md": edited((lines) => lines.splice(7, 0, line)) },
      );
    expect(above("[^1]: A note on the montage.").hidingMarkupInserted).toBe(1);
    for (const line of [
      "[1]: https://example.org/x",
      "[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.1.svg)](https://doi.org/10.5281/zenodo.1)",
      "![Montage](montage.png)",
    ]) {
      const facts = above(line);
      expect(facts.hidingMarkupInserted, line).toBe(0);
      expect(facts.joinedInsertedRuns, line).toBe(1);
    }
    // An open title or destination still hides, attached or not.
    expect(above('[1]: <> "an open title').hidingMarkupInserted).toBe(1);
    expect(above("[1]: <https://example.org").hidingMarkupInserted).toBe(1);
  });

  // Original paragraphs that open with a parenthesis, a double quote and a single quote: a link
  // definition right above one takes that line, to its closing mark, as the definition's title,
  // which renders as nothing. micromark with GFM renders each head below without the line.
  const OPENED = [
    "# Notes",
    "",
    "(Recorded at the university hospital between 2018 and 2019.)", // 2
    "The montage followed the international 10-20 system.",
    "",
    '"The tasks were explained to each participant in their own language."', // 5
    "",
    "'The rare targets were shown on one trial in five.'", // 7
  ].join("\n");
  const DEFINED = "[x]: https://example.org/x";

  test("a complete link definition right above an original line opening a title hides it", () => {
    for (const at of [2, 5, 7]) {
      const head = edited((lines) => lines.splice(at, 0, DEFINED), OPENED);
      const facts = readme({ "README.md": OPENED }, { "README.md": head });
      expect(facts.preserved, head).toBe(true);
      expect(facts.joinedInsertedRuns, head).toBe(1);
      expect(facts.hidingMarkupInserted, head).toBe(1);
    }
  });

  test("the same definition after a blank line, or above a plain line, does not", () => {
    const facts = (head: string) => readme({ "README.md": OPENED }, { "README.md": head });
    // A blank line ends the definition: the line after it is a paragraph of its own.
    expect(
      facts(edited((lines) => lines.splice(2, 0, DEFINED, ""), OPENED)).hidingMarkupInserted,
    ).toBe(0);
    // A new plain line between: the definition takes nothing, and the two lines below render as
    // one paragraph.
    const between = edited((lines) => lines.splice(2, 0, DEFINED, "See the notes below."), OPENED);
    expect(facts(between).hidingMarkupInserted).toBe(0);
    // Right above the plain second line of the first paragraph: no title, and a definition cannot
    // interrupt a paragraph, so it renders as text.
    expect(facts(edited((lines) => lines.splice(3, 0, DEFINED), OPENED)).hidingMarkupInserted).toBe(
      0,
    );
    // Right below the first paragraph, a blank line before the quoted one: the definition stays in
    // the first paragraph as text and the quoted paragraph renders.
    expect(facts(edited((lines) => lines.splice(4, 0, DEFINED), OPENED)).hidingMarkupInserted).toBe(
      0,
    );
  });

  test("a title closed before the end of its line is none, and still counts: the safe side", () => {
    // micromark renders this line: the definition ends at its destination. The fact counts it.
    const base = "# Notes\n\n(Smith 2020) found the same effect in older adults.\n";
    const head = `# Notes\n\n${DEFINED}\n(Smith 2020) found the same effect in older adults.\n`;
    expect(readme({ "README.md": base }, { "README.md": head }).hidingMarkupInserted).toBe(1);
  });

  test("a title line put under a kept link definition hides the original line it takes", () => {
    const base =
      "# Notes\n\n[1]: https://doi.org/10.1000/a\nThe montage followed the 10-20 system.\n";
    // An inserted opening parenthesis and an inserted closing one: the original line between is
    // the definition's title.
    const wrapped = base
      .replace("The montage", "(\nThe montage")
      .replace("system.\n", "system.\n)\n");
    const facts = readme({ "README.md": base }, { "README.md": wrapped });
    // The opening line falls between the definition and the line, both kept: that alone alters.
    expect(facts.insertedInsideParagraph).toBe(1);
    expect(facts.hidingMarkupInserted).toBe(1);
    // A minor edit that opens the original line with a parenthesis: nothing else moves, and no
    // bracket is added, so only the run counts.
    const opened = base.replace(
      "The montage followed the 10-20 system.",
      "(The montage followed the 10-20 system.)",
    );
    const edit = readme({ "README.md": base }, { "README.md": opened });
    expect(edit.protectedAltered + edit.insertedInsideParagraph + edit.joinedInsertedRuns).toBe(0);
    expect(edit.minorEdits).toBe(1);
    expect(edit.hidingMarkupInserted).toBe(1);
    // The same line opened with no definition above it is ordinary.
    const plain = "# Notes\n\nThe montage followed the 10-20 system.\n";
    const free = readme(
      { "README.md": plain },
      { "README.md": plain.replace("The", "(The").replace("system.", "system.)") },
    );
    expect(free.minorEdits).toBe(1);
    expect(free.hidingMarkupInserted).toBe(0);
  });

  test("a reference appended to an original reference block, or a badge under the title, is ordinary", () => {
    const references = "# Title\n\n## References\n\n[1]: https://doi.org/10.1000/a\n";
    const appended = `${references}[2]: https://doi.org/10.1000/b\n`;
    const facts = readme({ "README.md": references }, { "README.md": appended });
    expect(facts.hidingMarkupInserted).toBe(0);
    expect(proseAltered(facts)).toBe(false);
    const badged =
      "# Title\n[![DOI](https://zenodo.org/badge/x.svg)](https://doi.org/x)\n\nText.\n";
    const badge = readme({ "README.md": "# Title\n\nText.\n" }, { "README.md": badged });
    expect(badge.hidingMarkupInserted).toBe(0);
    expect(proseAltered(badge)).toBe(false);
  });

  test("a less-than sign before a letter reads as an open tag, in code too; p < 0.05 and closed tags do not", () => {
    const hidingOf = (line: string) =>
      readme(
        { "README.md": ORIGINAL },
        { "README.md": edited((lines) => lines.splice(9, 0, line)) },
      ).hidingMarkupInserted;
    // Flagged, the safe side: a person looks.
    expect(hidingOf("Use `a<b` to compare.")).toBe(1);
    expect(hidingOf("Use a<b to compare.")).toBe(1);
    const fenced = `${ORIGINAL}\n\`\`\`\nif a<b\n\`\`\`\n`;
    expect(readme({ "README.md": ORIGINAL }, { "README.md": fenced }).hidingMarkupInserted).toBe(1);
    // Not a tag at all, or a tag that closes and hides nothing.
    for (const line of [
      "p < 0.05 in all sessions.",
      "Pick a <label>name</label> for it.",
      "A List<String> of names.",
    ]) {
      expect(hidingOf(line), line).toBe(0);
    }
  });

  test("the four code-span attacks around an original paragraph are hiding", () => {
    // (a) an escaped backtick, then a comment opened above the paragraph and closed below it.
    const a = edited((lines) => {
      lines.splice(9, 0, "\\` --> \\`");
      lines.splice(7, 0, "\\` <!-- \\`");
    });
    // (b) details between escaped backticks, as a paragraph of its own above the original text.
    const b = edited((lines) => lines.splice(7, 0, "\\` <details> \\`", ""));
    // (c) a backtick paired across a line break, leaving details live.
    const c = edited((lines) => lines.splice(7, 0, "Note: `", "x` <details> `"));
    // (d) a backtick inside an attribute value.
    const d = edited((lines) => lines.splice(7, 0, '<span title="`"><details>`">'));
    for (const [label, head] of [
      ["a", a],
      ["b", b],
      ["c", c],
      ["d", d],
    ] as const) {
      const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
      expect(facts.hidingMarkupInserted, label).toBeGreaterThanOrEqual(1);
    }
  });

  test("a joined run counts once however many protected lines it touches, and a blank line unjoins it", () => {
    // Between two paragraphs, touching both: one run.
    const both = edited((lines) => lines.splice(9, 1, "A bridge sentence."));
    expect(readme({ "README.md": ORIGINAL }, { "README.md": both }).joinedInsertedRuns).toBe(1);
    // The same sentence as a paragraph of its own: not joined.
    const apart = edited((lines) => lines.splice(9, 0, "", "A paragraph of its own."));
    expect(readme({ "README.md": ORIGINAL }, { "README.md": apart }).joinedInsertedRuns).toBe(0);
    // A sentence right after the last original line, with no blank line, is joined to it too.
    const appended = `${ORIGINAL}More text after the last line.\n`;
    expect(readme({ "README.md": ORIGINAL }, { "README.md": appended }).joinedInsertedRuns).toBe(1);
  });

  test("hiding markup on the very first head line is read, alone or split across two lines", () => {
    const first = readme({ "README.md": ORIGINAL }, { "README.md": `<div hidden>\n${ORIGINAL}` });
    expect(first.hidingMarkupInserted).toBe(1);
    const split = readme({ "README.md": ORIGINAL }, { "README.md": `<div\nhidden>\n${ORIGINAL}` });
    expect(split.hidingMarkupInserted).toBe(1);
  });

  test("a run beyond a later line joined to an original paragraph is joined too", () => {
    // The tag has the title, L1 and L2, and a second paragraph. A later line X was added directly
    // above L1. A footnote definition put directly above X makes X, L1 and L2 its text: the run
    // touches only X, which is not protected, but it sits in the paragraph that holds L1 and L2.
    const anchor = "# Title\n\nFirst original line.\nSecond original line.\n\nSecond paragraph.\n";
    const base =
      "# Title\n\nA later line.\nFirst original line.\nSecond original line.\n\nSecond paragraph.\n";
    const head =
      "# Title\n\n[^1]: note\nA later line.\nFirst original line.\nSecond original line.\n\nSecond paragraph.\n";
    const facts = readme({ "README.md": base }, { "README.md": head }, { "README.md": anchor });
    expect(facts.preserved).toBe(true);
    expect(facts.joinedInsertedRuns).toBe(1);
    expect(facts.hidingMarkupInserted).toBe(1);
  });

  test("a run at the start of the document joins the first paragraph; a new part starts its own", () => {
    const plain = "First original line.\nSecond original line.\n";
    const top = `New first line.\n${plain}`;
    expect(readme({ "README.md": plain }, { "README.md": top }).joinedInsertedRuns).toBe(1);
    // Above a heading it is no part of the heading's block: not joined.
    const aboveHeading = `New first line.\n${ORIGINAL}`;
    expect(
      readme({ "README.md": ORIGINAL }, { "README.md": aboveHeading }).joinedInsertedRuns,
    ).toBe(0);
    // A part's first line starts a paragraph: a new part's lines join no original paragraph.
    const facts = readme(
      { README: "Original line one.\nOriginal line two.\n" },
      { README: "Original line one.\nOriginal line two.\n", "README.txt": "A new line.\n" },
    );
    expect(facts.joinedInsertedRuns).toBe(0);
    // Two new paragraphs between original ones, one of them two lines long: none joined.
    const between = edited((lines) =>
      lines.splice(9, 0, "", "New one.", "New two.", "", "New three."),
    );
    expect(readme({ "README.md": ORIGINAL }, { "README.md": between }).joinedInsertedRuns).toBe(0);
    // A run that is cut by a paragraph start counts once per paragraph it is in.
    const split = edited((lines) => lines.splice(9, 0, "Joined line.", "", "Own paragraph."));
    expect(readme({ "README.md": ORIGINAL }, { "README.md": split }).joinedInsertedRuns).toBe(1);
    // And the other way round: its own paragraph first, then a line joined to the original line
    // below it (above a heading it would join nothing: a heading starts a block).
    const reverse = edited((lines) => lines.splice(12, 0, "Own paragraph.", "", "Joined line."));
    expect(readme({ "README.md": ORIGINAL }, { "README.md": reverse }).joinedInsertedRuns).toBe(1);
  });

  test("a run joined only to lines added after the tag is not counted", () => {
    const later = `${ORIGINAL}\n## Notes\n\nA later note.\n`;
    const head = `${ORIGINAL}\n## Notes\n\nA later note.\nA sentence added to it.\n`;
    const facts = readme({ "README.md": later }, { "README.md": head }, { "README.md": ORIGINAL });
    expect(facts.joinedInsertedRuns).toBe(0);
    // Without the tag the note is protected, and the same sentence is joined to it.
    expect(readme({ "README.md": later }, { "README.md": head }).joinedInsertedRuns).toBe(1);
  });

  test("a new README.md beside the original README hides it from the shown README", () => {
    const facts = readme(
      { README: ORIGINAL },
      { README: ORIGINAL, "README.md": "# Visual oddball EEG\n\nSee the new documentation.\n" },
    );
    // Read whole, the document is the original plus an appended part: preserved.
    expect(facts.preserved).toBe(true);
    expect(facts.shownPartReplaced).toBe(true);
    expect(proseAltered(facts)).toBe(false);
  });

  test("the original moved from the shown README.md into a README beside it is shadowed too", () => {
    const facts = readme(
      { "README.md": ORIGINAL },
      { README: ORIGINAL, "README.md": "# A rewritten introduction\n" },
    );
    expect(facts.shownPartReplaced).toBe(true);
  });

  test("a protected line kept by a minor edit, moved out of the shown README, trips it too", () => {
    // The only original line survives as a minor edit, in README, which README.md now shadows.
    const line = "The recordings were made in a quiet, electrically shielded room.";
    const facts = readme(
      { "README.md": `${line}\n` },
      { README: `${line.replace("quiet", "quite")}\n`, "README.md": "# A new introduction\n" },
    );
    expect(facts.minorEdits).toBe(1);
    expect(facts.protectedAltered + facts.movedLines).toBe(0);
    expect(facts.shownPartReplaced).toBe(true);
  });

  test("a shown README renamed to a name the platform does not show is a shown part lost", () => {
    for (const name of ["readme.md", "README.MD", "Readme.md", "readme"]) {
      const facts = readme({ "README.md": ORIGINAL }, { [name]: ORIGINAL });
      expect(facts.preserved, name).toBe(true);
      expect(facts.shownPartReplaced, name).toBe(true);
    }
    expect(readme({ README: ORIGINAL }, { "readme.txt": ORIGINAL }).shownPartReplaced).toBe(true);
    // A README removed altogether has lost its shown part too.
    expect(readme({ "README.md": ORIGINAL }, {}).shownPartReplaced).toBe(true);
  });

  test("a rename keeps the shown part, and a lowercase readme is never the shown part", () => {
    expect(readme({ README: ORIGINAL }, { "README.md": ORIGINAL }).shownPartReplaced).toBe(false);
    expect(
      readme({ "readme.md": ORIGINAL }, { "readme.md": `${ORIGINAL}\nMore.\n` }).shownPartReplaced,
    ).toBe(false);
    // With no README the platform shows at the base, every base part counts as shown.
    expect(
      readme({ "readme.md": ORIGINAL }, { "readme.md": ORIGINAL, "README.md": "# New\n" })
        .shownPartReplaced,
    ).toBe(true);
  });

  test("only a protected line kept in a part no longer shown trips it", () => {
    // The later note stays verbatim but moves into README.txt, which the platform does not show.
    const base = { "README.md": `${ORIGINAL}\nLater note.\n` };
    const head = { "README.md": ORIGINAL, "README.txt": "Later note.\n" };
    const tagged = readme(base, head, { "README.md": ORIGINAL });
    expect(tagged.preserved).toBe(true);
    expect(tagged.shownPartReplaced).toBe(false);
    // Without a tag the note is protected, and the same pull request hides a protected line.
    expect(readme(base, head).shownPartReplaced).toBe(true);
  });
});

describe("hidesText", () => {
  test("markup between backticks is read like any text: four ways CommonMark leaves it live", () => {
    // micromark with GFM renders each of these with the comment or the details element live
    // (an escaped backtick is a literal one; a backtick pairs across a line break; one inside an
    // attribute value is no code span), so none may be blanked as inline code.
    expect(hidesText(["\\` <!-- \\`"])).toBe(true);
    expect(hidesText(["\\` <details> \\`"])).toBe(true);
    expect(hidesText(["Note: `", "x` <details> `"])).toBe(true);
    expect(hidesText(['<span title="`"><details>`">'])).toBe(true);
  });

  test("hostile 4 MiB runs of backticks and markup are read in one pass", () => {
    const size = 4 * 1024 * 1024;
    const fill = (unit: string): string => unit.repeat(Math.ceil(size / unit.length));
    for (const text of [fill("` `` ``` "), fill("`a<b` "), fill("``x` "), fill("`"), fill("x`")]) {
      const started = performance.now();
      hidesText([text]);
      expect(performance.now() - started, text.slice(0, 8)).toBeLessThan(5_000);
    }
  });

  test("comments, hiding elements and hiding attributes are markup that hides", () => {
    for (const line of [
      "<!--",
      "text <!-- hidden",
      "-->",
      "<details>",
      "</DETAILS>",
      "<details open>",
      "<script>x</script>",
      "<style>",
      "<template>",
      "<noscript>",
      "<textarea>",
      "<iframe src=x>",
      "<object data=x>",
      "<dialog open>",
      "<title>",
      "<datalist>",
      "<noembed>",
      "<noframes>",
      "<video src=x>",
      "<audio>",
      "<canvas>",
      "<map name=x>",
      "<div hidden>",
      '<p class="x" hidden="">',
      '<span style="display:none">',
      '<div style="display : none">',
      '<span style="visibility: hidden">',
    ]) {
      expect(hidesText([line]), line).toBe(true);
    }
  });

  test("a processing instruction, a declaration, a bogus comment and CDATA hide what follows", () => {
    for (const line of ["<?php", "a <? b", "<!DOCTYPE html>", "<!x", "<![CDATA[", "x <![if]>"]) {
      expect(hidesText([line]), line).toBe(true);
    }
  });

  test("a tag or a quoted attribute left open at the end of a run takes what follows into the tag", () => {
    for (const line of ["<div", "<div\thidden", '<a title="', "<a title='x", "text <span"]) {
      expect(hidesText([line]), line).toBe(true);
    }
  });

  test("a run is read as one text: a tag split across lines is one tag", () => {
    expect(hidesText(["<div", "hidden>"])).toBe(true);
    expect(hidesText(['<span style="display:', 'none">'])).toBe(true);
    // Closed on the next line with nothing that hides: the run as a whole hides nothing.
    expect(hidesText(["<div", 'class="note">'])).toBe(false);
  });

  test("a link reference definition whose title is left open hides the lines after it", () => {
    for (const line of [
      '[x]: <> "',
      "[x]: /url 'open",
      "[x]: /url (open",
      '   [label]: <https://example.org> "a title that goes on',
      "[x]:",
      "[x]:   ",
      "[x]: <",
    ]) {
      expect(hidesText([line]), JSON.stringify(line)).toBe(true);
    }
    // On any line of the run, not only the first.
    expect(hidesText(["a new sentence.", '[x]: <> "'])).toBe(true);
  });

  test("other markup, closed definitions, a code span and plain words are not", () => {
    for (const line of [
      "`<s>`",
      "<s>struck</s>",
      "<strong>bold</strong>",
      "<sub>2</sub>",
      "<summary>Notes</summary>",
      "<objects>",
      "<detailsx>",
      "<details2>",
      "<detailsfoo>",
      "<mapping>",
      "<titles>",
      '<a href="https://example.org">a link</a>',
      "<br/>",
      "p<0.05 and 5 < 6",
      "This was hidden in plain sight.",
      "a < b and hidden > c",
      "Set display: none in the stylesheet.",
      "<br> hidden",
      '[x]: /url "a closed title"',
      "[x]: /url",
      "[x]: <https://example.org> (closed)",
      '    [x]: <> "',
      "",
    ]) {
      expect(hidesText([line]), JSON.stringify(line)).toBe(false);
    }
  });

  test("an open quote swallows the closing bracket, and names and labels are read whole", () => {
    expect(hidesText(['<a title="x>'])).toBe(true);
    expect(hidesText(["<a title='x>"])).toBe(true);
    for (const line of ["<details9>", "<detailsZ>", "<details-x>", "<x-details>", "<my-map>"]) {
      expect(hidesText([line]), line).toBe(false);
    }
    // A tab after the colon is a blank like a space; an empty label is read as a definition too.
    expect(hidesText(['[x]:\t<> "'])).toBe(true);
    expect(hidesText(['[]: <> "'])).toBe(true);
    expect(hidesText(["[]: /url"])).toBe(false);
  });

  test("hostile runs of 4 MiB are each read in one pass", () => {
    const size = 4 * 1024 * 1024;
    // Whole units only, so a closed tag is never cut in half at the end.
    const fill = (unit: string): string => unit.repeat(Math.ceil(size / unit.length));
    const cases: [string, boolean][] = [
      [fill("<a "), true],
      [fill("<a>"), false],
      [fill("<b x=1>"), false],
      [`<a title="${fill("x")}`, true],
      [`[${fill("a")}`, false],
      [`[x]: <${fill("a")}`, true],
      [`<a ${fill("display  ")}>`, false],
      [`<a ${fill("hidde ")}>`, false],
      [fill("< "), false],
      [fill("<!"), false],
    ];
    for (const [text, hides] of cases) {
      const started = performance.now();
      expect(hidesText([text]), text.slice(0, 12)).toBe(hides);
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(2_000);
    }
  });
});

describe("proseFacts: bounds and refusals", () => {
  test("two sides more than 2,000 lines apart are refused, never half compared", () => {
    const base = `${distinctLines("old", 1001).join("\n")}\n`;
    const head = `${distinctLines("new", 1000).join("\n")}\n`;
    expect(
      proseFacts({
        document: "readme",
        base: parts({ README: base }),
        head: parts({ README: head }),
        anchor: null,
      }),
    ).toEqual({ ok: false, refusal: "edit_distance_cap" });
  });

  test("5,000 lines appended are compared, however far past the cap", () => {
    const head = `${ORIGINAL}\n${distinctLines("appended", 5_000).join("\n")}\n`;
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(untouched(ORIGINAL_PROTECTED, { insertedLines: 5_000 }));
  });

  test("a binary part that changed refuses the document; one that did not is skipped", () => {
    const pdfBefore = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x41]);
    const pdfAfter = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x42]);
    const changed = proseFacts({
      document: "readme",
      base: parts({ "README.md": ORIGINAL, "README.pdf": pdfBefore }),
      head: parts({ "README.md": ORIGINAL, "README.pdf": pdfAfter }),
      anchor: null,
    });
    expect(changed).toEqual({ ok: false, refusal: "binary" });
    const facts = readme(
      { "README.md": ORIGINAL, "README.pdf": pdfBefore },
      { "README.md": `${ORIGINAL}\nAdded.\n`, "README.pdf": pdfBefore },
    );
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, { partsBefore: 2, partsAfter: 2, insertedLines: 1 }),
    );
  });

  test("a side's refusal is the document's refusal", () => {
    const link = proseFacts({
      document: "readme",
      base: parts({ "README.md": ORIGINAL }),
      head: [part("README.md", "elsewhere", "120000")],
      anchor: null,
    });
    expect(link).toEqual({ ok: false, refusal: "not_regular" });
  });
});

/** Whether `needle` is a subsequence of `hay`, taking the first match each time. */
function isSubsequence(needle: readonly string[], hay: readonly string[]): boolean {
  let k = 0;
  for (const line of hay) if (k < needle.length && line === needle[k]) k++;
  return k === needle.length;
}

/** A random README: paragraphs of one to four lines drawn from a small vocabulary, so lines repeat. */
function randomReadme(random: () => number): string[][] {
  const vocabulary = distinctLines("Sentence", 9);
  return Array.from({ length: 1 + Math.floor(random() * 6) }, () =>
    Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(random, vocabulary)),
  );
}

/** The text of paragraphs, a blank line between each two. */
function joinParagraphs(paragraphs: readonly (readonly string[])[]): string {
  return `${paragraphs.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}

describe("proseFacts: properties over seeded random READMEs", () => {
  test("new paragraphs inserted between original ones always leave the README preserved", () => {
    const random = mulberry32(0x5398);
    for (let trial = 0; trial < 300; trial++) {
      const paragraphs = randomReadme(random);
      const anchor = random() < 0.5 ? null : { README: joinParagraphs(paragraphs.slice(0, 2)) };
      const head: string[][] = [];
      let added = 0;
      for (const lines of [...paragraphs, null]) {
        if (random() < 0.4) {
          const fresh = distinctLines(`New ${trial} ${added}`, 1 + Math.floor(random() * 3));
          head.push(fresh);
          added += fresh.length;
        }
        if (lines) head.push(lines);
      }
      const label = `${trial}: ${JSON.stringify(head)}`;
      const facts = readme(
        { README: joinParagraphs(paragraphs) },
        { README: joinParagraphs(head) },
        anchor,
      );
      expect(facts.preserved, label).toBe(true);
      expect(facts.insertedLines, label).toBe(added);
      expect(facts.laterAltered + facts.insertedInsideParagraph, label).toBe(0);
      expect(facts.joinedInsertedRuns, label).toBe(0);
    }
  });

  test("a line inserted between two lines of one original paragraph is always inside it", () => {
    const random = mulberry32(0x4703);
    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const paragraphs = randomReadme(random);
      const at = paragraphs.findIndex((lines) => lines.length >= 2);
      if (at < 0) continue;
      const head = paragraphs.map((lines) => [...lines]);
      (head[at] as string[]).splice(1, 0, `Inserted ${trial}`);
      const facts = readme(
        { README: joinParagraphs(paragraphs) },
        { README: joinParagraphs(head) },
      );
      expect(facts.insertedInsideParagraph, JSON.stringify(head)).toBe(1);
      expect(proseAltered(facts)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("whenever the protected lines are no longer a subsequence of the head, something is reported", () => {
    const random = mulberry32(0x2578);
    let reported = 0;
    for (let trial = 0; trial < 400; trial++) {
      const paragraphs = randomReadme(random);
      const baseLines = paragraphs.flat();
      const anchorLines = random() < 0.5 ? null : baseLines.filter(() => random() < 0.7);
      const head = paragraphs.map((lines) => [...lines]);
      const deleteOnly = random() < 0.5;
      for (let edit = 0; edit < 1 + Math.floor(random() * 3); edit++) {
        const lines = pick(random, head);
        const at = Math.floor(random() * lines.length);
        if (deleteOnly || random() < 0.4) lines.splice(at, 1);
        else if (random() < 0.5) lines.splice(at, 0, pick(random, baseLines));
        else lines.splice(at, 1, `Replacement ${edit}`);
      }
      const remaining = head.filter((lines) => lines.length > 0);
      // Protection recomputed here as the definition states it, not with the module's helper: a
      // base line is protected when its text is anywhere in the anchor, and every line is when
      // there is no anchor or the anchor has no line.
      const protectedTexts = baseLines.filter(
        (line) => anchorLines === null || anchorLines.length === 0 || anchorLines.includes(line),
      );
      const headLines = remaining.flat();
      const facts = readme(
        { README: joinParagraphs(paragraphs) },
        { README: remaining.length > 0 ? joinParagraphs(remaining) : "" },
        anchorLines === null ? null : { README: `${anchorLines.join("\n")}\n` },
      );
      const label = `${trial}: ${JSON.stringify(paragraphs)} -> ${JSON.stringify(remaining)}`;
      if (!isSubsequence(protectedTexts, headLines)) {
        expect(facts.preserved, label).toBe(false);
        expect(facts.protectedAltered + facts.movedLines + facts.minorEdits, label).toBeGreaterThan(
          0,
        );
        if (deleteOnly) expect(facts.protectedAltered, label).toBeGreaterThan(0);
        reported++;
      }
    }
    expect(reported).toBeGreaterThan(150);
  });
});

/** A dataset description as a contributor's tool writes it: indented JSON. */
function description(fields: Record<string, unknown>): Uint8Array {
  return encoder.encode(`${JSON.stringify(fields, null, 2)}\n`);
}

/** Facts with nothing changed, for tests to override. */
function noFieldChange(overrides: Partial<AuthorFieldFacts> = {}): AuthorFieldFacts {
  return {
    altered: [],
    removed: [],
    minor: [],
    grown: [],
    added: [],
    unparsed: false,
    ...overrides,
  };
}

const DESCRIPTION = {
  Name: "Visual oddball EEG",
  BIDSVersion: "1.8.0",
  DatasetType: "raw",
  License: "CC-BY-4.0",
  Authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper"],
  Funding: [
    "This work was supported by the National Institute of Mental Health grant R01MH000000 to the lab.",
  ],
  ReferencesAndLinks: ["https://example.org/paper"],
  DatasetDOI: "doi:10.18112/openneuro.ds000000.v1.0.0",
  GeneratedBy: [{ Name: "a converter", Version: "1.0" }],
};

/** The description with some fields replaced (`undefined` deletes a key). */
function changed(fields: Record<string, unknown>): Uint8Array {
  const out: Record<string, unknown> = { ...DESCRIPTION };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return description(out);
}

describe("author-owned fields: the closed lists", () => {
  test("the nine author-owned keys and the five that take a minor edit, none with an underscore", () => {
    expect([...AUTHOR_OWNED_KEYS]).toEqual([
      "Name",
      "Authors",
      "License",
      "ReferencesAndLinks",
      "Funding",
      "Acknowledgements",
      "HowToAcknowledge",
      "DatasetDOI",
      "EthicsApprovals",
    ]);
    expect([...MINOR_EDIT_KEYS]).toEqual([
      "Funding",
      "Acknowledgements",
      "HowToAcknowledge",
      "EthicsApprovals",
      "ReferencesAndLinks",
    ]);
    for (const key of AUTHOR_OWNED_KEYS) expect(key).toMatch(/^[A-Za-z]+$/);
    for (const key of ["Name", "Authors", "License", "DatasetDOI"] as const) {
      expect(MINOR_EDIT_KEYS.includes(key), key).toBe(false);
    }
  });
});

describe("authorFieldFacts", () => {
  test("empty placeholders removed are not an alteration (on004022)", () => {
    const before = description({
      ...DESCRIPTION,
      Acknowledgements: "",
      HowToAcknowledge: "",
      Funding: [""],
      EthicsApprovals: [],
    });
    const after = changed({ Funding: undefined });
    const facts = authorFieldFacts(before, after);
    expect(facts).toEqual(noFieldChange());
    expect(authorFieldsAltered(facts)).toBe(false);
  });

  test('an empty placeholder normalized from [""] to [] is not an alteration (on004855)', () => {
    const facts = authorFieldFacts(
      changed({ ReferencesAndLinks: [""] }),
      changed({ ReferencesAndLinks: [] }),
    );
    expect(facts).toEqual(noFieldChange());
  });

  test("a link removed from ReferencesAndLinks is removed, and removed fails (on006126)", () => {
    for (const after of [
      changed({ ReferencesAndLinks: [] }),
      changed({ ReferencesAndLinks: undefined }),
    ]) {
      const facts = authorFieldFacts(description(DESCRIPTION), after);
      expect(facts).toEqual(noFieldChange({ removed: ["ReferencesAndLinks"] }));
      expect(authorFieldsAltered(facts)).toBe(true);
    }
  });

  test("a Funding typo fixed within the minor bound is minor (on007353)", () => {
    const fixed = DESCRIPTION.Funding[0] as string;
    const typo =
      "This work was suported by the Natinal Institue of Mentl Helth grant R01MH00000 to the lab";
    expect(levenshteinWithin(typo, fixed, 20)).toBe(7);
    const facts = authorFieldFacts(changed({ Funding: [typo] }), description(DESCRIPTION));
    expect(facts).toEqual(noFieldChange({ minor: ["Funding"] }));
    expect(authorFieldsAltered(facts)).toBe(false);
    // The same fix as a lone string is minor too, and a rewritten sentence is not.
    expect(authorFieldFacts(changed({ Funding: typo }), changed({ Funding: fixed })).minor).toEqual(
      ["Funding"],
    );
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({ Funding: ["Funded by a private donor."] }),
      ).altered,
    ).toEqual(["Funding"]);
  });

  test("License changed by one character fails: it takes no minor edit", () => {
    const facts = authorFieldFacts(description(DESCRIPTION), changed({ License: "CC-BY-4.1" }));
    expect(facts).toEqual(noFieldChange({ altered: ["License"] }));
    expect(authorFieldsAltered(facts)).toBe(true);
  });

  test("an author appended is grown; reordered, inserted in the middle or respelled is altered", () => {
    const [ada, alan, grace] = DESCRIPTION.Authors as [string, string, string];
    const appended = authorFieldFacts(
      description(DESCRIPTION),
      changed({ Authors: [ada, alan, grace, "Katherine Johnson"] }),
    );
    expect(appended).toEqual(noFieldChange({ grown: ["Authors"] }));
    expect(authorFieldsAltered(appended)).toBe(false);
    for (const authors of [
      [alan, ada, grace],
      [ada, "Katherine Johnson", alan, grace],
      ["Katherine Johnson", ada, alan, grace],
      [ada, alan, "Grace B. Hopper"],
      [ada, alan],
    ]) {
      const facts = authorFieldFacts(description(DESCRIPTION), changed({ Authors: authors }));
      expect(facts, JSON.stringify(authors)).toEqual(noFieldChange({ altered: ["Authors"] }));
    }
  });

  test("missing elements are dropped before an array is compared", () => {
    const [ada, alan, grace] = DESCRIPTION.Authors as [string, string, string];
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({ Authors: [ada, "", alan, "n/a", grace] }),
      ),
    ).toEqual(noFieldChange());
    expect(
      authorFieldFacts(
        changed({ Authors: ["", ada, alan, grace] }),
        changed({ Authors: [ada, alan, grace, "Katherine Johnson"] }),
      ),
    ).toEqual(noFieldChange({ grown: ["Authors"] }));
  });

  test("an array grown and with an element minor-edited is both, in a minor-edit key", () => {
    const fixed = DESCRIPTION.Funding[0] as string;
    const facts = authorFieldFacts(
      changed({ Funding: [fixed.replace("supported", "suported")] }),
      changed({ Funding: [fixed, "A second grant."] }),
    );
    expect(facts).toEqual(noFieldChange({ minor: ["Funding"], grown: ["Funding"] }));
  });

  test("for an array-valued key a lone string is an array of one, both ways", () => {
    expect(ARRAY_VALUED_KEYS).toEqual([
      "Authors",
      "Funding",
      "EthicsApprovals",
      "ReferencesAndLinks",
    ]);
    expect(
      authorFieldFacts(
        changed({ Authors: "Ada Lovelace" }),
        changed({ Authors: ["Ada Lovelace"] }),
      ),
    ).toEqual(noFieldChange());
    expect(
      authorFieldFacts(
        changed({ Authors: "Ada Lovelace" }),
        changed({ Authors: ["Ada Lovelace", "Alan Turing"] }),
      ),
    ).toEqual(noFieldChange({ grown: ["Authors"] }));
    // An array of one that became its string is no change either.
    expect(
      authorFieldFacts(changed({ Funding: ["Grant 1"] }), changed({ Funding: "Grant 1" })),
    ).toEqual(noFieldChange());
    expect(
      authorFieldFacts(
        changed({ EthicsApprovals: "IRB 1" }),
        changed({ EthicsApprovals: ["IRB 1", "IRB 2"] }),
      ),
    ).toEqual(noFieldChange({ grown: ["EthicsApprovals"] }));
  });

  test("for any other key a change of JSON type is altered, a string grown into a list included", () => {
    for (const key of ["Name", "License", "DatasetDOI", "Acknowledgements", "HowToAcknowledge"]) {
      expect(
        authorFieldFacts(changed({ [key]: "CC0" }), changed({ [key]: ["CC0", "CC-BY-NC-4.0"] })),
        key,
      ).toEqual(noFieldChange({ altered: [key as AuthorOwnedKey] }));
      expect(authorFieldFacts(changed({ [key]: ["CC0"] }), changed({ [key]: "CC0" })), key).toEqual(
        noFieldChange({ altered: [key as AuthorOwnedKey] }),
      );
    }
    const facts = authorFieldFacts(
      changed({ License: "CC0" }),
      changed({ License: ["CC0", "CC-BY-NC-4.0"] }),
    );
    expect(authorFieldsAltered(facts)).toBe(true);
  });

  test("a scalar field never grows: an array that gained an element is altered", () => {
    for (const key of ["Name", "License", "DatasetDOI", "Acknowledgements", "HowToAcknowledge"]) {
      expect(
        authorFieldFacts(changed({ [key]: ["CC0"] }), changed({ [key]: ["CC0", "CC-BY-NC-4.0"] })),
        key,
      ).toEqual(noFieldChange({ altered: [key as AuthorOwnedKey] }));
    }
    // An element minor-edited inside an array is no minor edit for a scalar field either.
    const thanks = "We thank the participants and the staff of the clinical research unit.";
    expect(
      authorFieldFacts(
        changed({ Acknowledgements: [thanks] }),
        changed({ Acknowledgements: [thanks.replace("staff", "stuff")] }),
      ),
    ).toEqual(noFieldChange({ altered: ["Acknowledgements"] }));
    // The string itself still takes a minor edit, and missing to a value is still added.
    expect(
      authorFieldFacts(
        changed({ Acknowledgements: thanks }),
        changed({ Acknowledgements: thanks.replace("staff", "stuff") }),
      ),
    ).toEqual(noFieldChange({ minor: ["Acknowledgements"] }));
    expect(authorFieldFacts(changed({ License: [""] }), changed({ License: ["CC0"] }))).toEqual(
      noFieldChange({ added: ["License"] }),
    );
    // An array-valued key still grows.
    const [ada, alan, grace] = DESCRIPTION.Authors as [string, string, string];
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({ Authors: [ada, alan, grace, "Mary Jackson"] }),
      ),
    ).toEqual(noFieldChange({ grown: ["Authors"] }));
  });

  test("a number beside an array, or an object beside a string, is altered for any key", () => {
    for (const key of ["Name", "License"] as const) {
      expect(authorFieldFacts(changed({ [key]: 5 }), changed({ [key]: [5] })), key).toEqual(
        noFieldChange({ altered: [key] }),
      );
      expect(
        authorFieldFacts(changed({ [key]: { id: "x" } }), changed({ [key]: "x" })),
        key,
      ).toEqual(noFieldChange({ altered: [key] }));
    }
    expect(authorFieldFacts(changed({ Funding: 5 }), changed({ Funding: [5] }))).toEqual(
      noFieldChange({ altered: ["Funding"] }),
    );
    expect(authorFieldFacts(changed({ Funding: [5] }), changed({ Funding: 5 }))).toEqual(
      noFieldChange({ altered: ["Funding"] }),
    );
    expect(
      authorFieldFacts(changed({ Funding: { grant: "Grant 1" } }), changed({ Funding: "Grant 1" })),
    ).toEqual(noFieldChange({ altered: ["Funding"] }));
    expect(
      authorFieldFacts(changed({ Funding: "Grant 1" }), changed({ Funding: { grant: "Grant 1" } })),
    ).toEqual(noFieldChange({ altered: ["Funding"] }));
    expect(authorFieldFacts(changed({ Name: "Study" }), changed({ Name: 7 }))).toEqual(
      noFieldChange({ altered: ["Name"] }),
    );
  });

  test("a key added where there was none, or a missing value replaced, is added", () => {
    const facts = authorFieldFacts(
      changed({ HowToAcknowledge: "" }),
      changed({ HowToAcknowledge: "Please cite the paper.", EthicsApprovals: ["IRB 2020-01"] }),
    );
    expect(facts).toEqual(noFieldChange({ added: ["HowToAcknowledge", "EthicsApprovals"] }));
    expect(authorFieldsAltered(facts)).toBe(false);
  });

  test("Name and DatasetDOI changed are altered; tool-managed keys and nested names are not looked at", () => {
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({
          Name: "Visual oddball EEG (revised)",
          DatasetDOI: "doi:10.18112/openneuro.ds000000.v1.0.1",
        }),
      ),
    ).toEqual(noFieldChange({ altered: ["Name", "DatasetDOI"] }));
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({
          BIDSVersion: "1.9.0",
          GeneratedBy: [{ Name: "another tool" }],
          DatasetType: "derivative",
        }),
      ),
    ).toEqual(noFieldChange());
  });

  test("key order and whitespace are no change, and the lists follow the closed order", () => {
    const reversed = Object.fromEntries(Object.entries(DESCRIPTION).reverse());
    expect(
      authorFieldFacts(description(DESCRIPTION), encoder.encode(JSON.stringify(reversed))),
    ).toEqual(noFieldChange());
    const facts = authorFieldFacts(
      description(DESCRIPTION),
      description({ ...reversed, License: "CC0", Name: "Other" }),
    );
    expect(facts.altered).toEqual(["Name", "License"]);
  });

  test("a description added is every value added; one deleted is every value removed", () => {
    expect(authorFieldFacts("absent", description(DESCRIPTION))).toEqual(
      noFieldChange({
        added: ["Name", "Authors", "License", "ReferencesAndLinks", "Funding", "DatasetDOI"],
      }),
    );
    const deleted = authorFieldFacts(description(DESCRIPTION), "absent");
    expect(deleted).toEqual(
      noFieldChange({
        removed: ["Name", "Authors", "License", "ReferencesAndLinks", "Funding", "DatasetDOI"],
      }),
    );
    expect(authorFieldsAltered(deleted)).toBe(true);
    expect(authorFieldFacts("absent", "absent")).toEqual(noFieldChange());
  });

  test("a side that cannot be read, does not parse or is not an object is unparsed, never clean", () => {
    const unparsed = noFieldChange({ unparsed: true });
    for (const [label, bad] of [
      ["unreadable", "unreadable"],
      ["trailing comma", encoder.encode('{"Name": "x",}')],
      ["duplicate key", encoder.encode('{"License": "CC0", "License": "CC-BY-4.0"}')],
      ["not UTF-8", new Uint8Array([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d])],
      ["array root", encoder.encode('["Name"]')],
      ["string root", encoder.encode('"Name"')],
    ] as [string, DescriptionSide][]) {
      expect(authorFieldFacts(description(DESCRIPTION), bad), label).toEqual(unparsed);
      expect(authorFieldFacts(bad, description(DESCRIPTION)), label).toEqual(unparsed);
    }
    // Unknown is not an alteration here: the caller says what unknown does.
    expect(authorFieldsAltered(unparsed)).toBe(false);
  });
});

/** A side of a changed path: its mode, its blob id and what the caller read of it. */
interface Side {
  mode: string;
  oid: string;
  probe: PointerProbe;
}

const SYMLINK = "120000";
const REGULAR = "100644";
const SUBMODULE = "160000";

/** A side holding these bytes, with the git id of those bytes; the probe is the bytes themselves. */
function sideOf(mode: string, content: string | Uint8Array): Side {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  return { mode, oid: gitOid(bytes), probe: bytes };
}

/** The target git-annex writes for `key`, with `depth` directories above the root of the dataset. */
function annexTarget(key: string, depth = 1): string {
  return `${"../".repeat(depth)}.git/annex/objects/Xj/9P/${key}/${key}`;
}

/** A locked annexed file: a symlink to the key. */
const locked = (key: string, depth = 1): Side => sideOf(SYMLINK, annexTarget(key, depth));
/** An unlocked annexed file: a regular blob holding a pointer. */
const unlocked = (key: string): Side => sideOf(REGULAR, `/annex/objects/${key}\n`);
/** A regular file git holds, as a probe of its bytes, or of `large` when the caller never read it. */
const plain = (content: string, probe: PointerProbe | null = null): Side => ({
  ...sideOf(REGULAR, content),
  probe: probe ?? encoder.encode(content),
});

/** The key of the n-th recording: the same n gives the same key, a different n a different one. */
const keyOf = (n: number): string => `SHA256E-s${1000 + n}--${n.toString(16).padStart(8, "0")}.edf`;

/** The first three characters of a git mode name its file type. */
const typeOfMode = (mode: string): string => mode.slice(0, 3);

/**
 * One changed path, its status and zero ids as `git diff --raw` would write them. Whether the path
 * is in the reviewed scope comes from the module's own predicate, as a caller takes it.
 */
function recording(
  path: string,
  was: Side | null,
  now: Side | null,
  recordingArea = false,
): RecordingChange {
  const status =
    was === null
      ? "added"
      : now === null
        ? "removed"
        : typeOfMode(was.mode) !== typeOfMode(now.mode)
          ? "typechange"
          : "modified";
  return {
    path,
    status,
    modeBefore: was?.mode ?? "000000",
    modeAfter: now?.mode ?? "000000",
    oidBefore: was?.oid ?? "0".repeat(40),
    oidAfter: now?.oid ?? "0".repeat(40),
    recordingArea,
    inReviewedScope: inReviewedScope(path),
    before: was?.probe ?? null,
    after: now?.probe ?? null,
  };
}

/** The recording facts of nothing changed, for tests to override. */
function noRecordingChange(
  overrides: Partial<RecordingFacts & { unread: number }> = {},
): RecordingFacts & { unread: number } {
  return { replaced: 0, typeChanged: 0, moved: 0, unread: 0, ...overrides };
}

describe("annexSide", () => {
  test("a git-annex symlink is annexed, and its key is the last component of its target", () => {
    const key = "SHA256E-s10--abc.edf";
    const target = `../../.git/annex/objects/xx/yy/${key}/${key}`;
    expect(annexSide(SYMLINK, encoder.encode(target))).toEqual({ kind: "annexed", key });
    // The key grammar: a backend, size-style fields, two hyphens and a name that is not empty.
    for (const name of [
      "MD5E-s1048576-S1048576-C1--0123456789abcdef.nii.gz",
      "URL--https&c%%example.org%data.edf",
      "WORM-s10-m1700000000--sub-01_task-x_eeg.edf",
    ]) {
      expect(
        annexSide(SYMLINK, encoder.encode(`.git/annex/objects/ab/cd/${name}/${name}`)),
      ).toEqual({ kind: "annexed", key: name });
    }
  });

  test("a link that is not into the annex objects, or does not end in a key, is a plain link", () => {
    for (const target of [
      "../shared/data.edf",
      "sub-01/eeg/data.edf",
      "../.git/annex/objects/", // nothing after the objects directory
      "../.git/annex/objects", // the objects directory itself
      "../.git/annex/objects/Xj/9P/SHA256E-s10--abc.edf/", // empty last component
      "../.git/annex/objects/Xj/9P/sha256e-s10--abc.edf", // lower-case backend
      "../.git/annex/objects/Xj/9P/SHA256E-s10-abc.edf", // one hyphen, not two
      "../.git/annex/objects/Xj/9P/SHA256E-s10--", // no name after the hyphens
      "../.git/xannex/objects/Xj/9P/SHA256E-s10--abc.edf", // not the component `annex`
      "../.git/annex/objectsx/Xj/9P/SHA256E-s10--abc.edf",
      "../.git/annex/other/SHA256E-s10--abc.edf",
      "SHA256E-s10--abc.edf/annex/objects", // the key is not last
    ]) {
      expect(annexSide(SYMLINK, encoder.encode(target)), target).toEqual({ kind: "link" });
    }
  });

  // How git-annex itself reads a link target or a pointer, measured with git-annex 10.20261006: a
  // scratch repository (`git annex init`, one file added), then blobs written with
  // `git hash-object -w` and committed with `git update-index --cacheinfo`, and
  // `git annex find --branch HEAD --include='*' --format='${file} ${key}\n'` to list what it calls
  // annexed. Measured annexed: a pointer `/annex/objects/KEY` with or without a final LF, with CRLF
  // (key without the CR), with a deeper path, with `x/`, a leading space or a BOM before
  // `/annex/objects/`, or with later lines that each hold `/annex/`; a key holding a space; a link
  // target with `x/` or `/` before `annex/objects/`, a final LF, or a final CR (key without it).
  // Measured NOT annexed: a pointer with `onset\tduration` after it, with a blank line after it,
  // with a blank line BEFORE it, or with a later line without `/annex/`; bytes that are not UTF-8;
  // a pointer or a link target `annex/objects/KEY` (no slash before `annex`); a link target with
  // anything after a line break. git-annex also accepted a NUL or a CR inside a key, which this
  // module reads as no key (the side is then a plain file, which flags the change).

  test("a pointer is the whole blob: its first line names the key and every later line holds /annex/", () => {
    const key = "SHA256E-s10--abc.edf";
    for (const mode of [REGULAR, "100755"]) {
      expect(annexSide(mode, encoder.encode(`/annex/objects/${key}\n`)), mode).toEqual({
        kind: "annexed",
        key,
      });
    }
    for (const text of [
      `/annex/objects/${key}`,
      `/annex/objects/${key}\r\n`,
      `/annex/objects/Xj/9P/${key}/${key}\n`,
      `x/annex/objects/${key}\n`,
      ` /annex/objects/${key}\n`,
      `../.git/annex/objects/Xj/9P/${key}/${key}\n`,
      `/annex/objects/${key}\n/annex/other\n`,
      `/annex/objects/${key}\nsomething /annex/ here\n`,
      `/annex/objects/${key}\r\n/annex/x\r\n`,
    ]) {
      expect(annexSide(REGULAR, encoder.encode(text)), JSON.stringify(text)).toEqual({
        kind: "annexed",
        key,
      });
    }
    expect(
      annexSide(
        REGULAR,
        new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(`/annex/objects/${key}\n`)]),
      ),
    ).toEqual({ kind: "annexed", key });
  });

  test("a blank line before a pointer, or bytes that are not UTF-8, make a git file", () => {
    const key = "SHA256E-s10--abc.edf";
    expect(annexSide(REGULAR, encoder.encode(`\n/annex/objects/${key}`))).toEqual({ kind: "git" });
    expect(annexSide(REGULAR, new Uint8Array([0xff, 0xfe, 0x41, 0x0a]))).toEqual({ kind: "git" });
    expect(annexSide("100755", new Uint8Array([0xff, 0xfe, 0x41, 0x0a]))).toEqual({ kind: "git" });
    // A space inside a key is part of it, as git-annex reads it.
    const spaced = "SHA256E-s14--a b.edf";
    expect(annexSide(REGULAR, encoder.encode(`/annex/objects/${spaced}\n`))).toEqual({
      kind: "annexed",
      key: spaced,
    });
  });

  test("a pointer with data appended, a blank line after it, or no slash before annex is git", () => {
    const key = "SHA256E-s10--abc.edf";
    for (const text of [
      // Content that replaced a recording by the pointer and new rows is not the recording.
      `/annex/objects/${key}\nonset\tduration\n`,
      `/annex/objects/${key}\n\n`,
      `/annex/objects/${key}\n/annex/x\nplain\n`,
      `/annex/objects/${key}\n\n/annex/x\n`,
      `annex/objects/${key}\n`,
      "/annex/objects/\n",
      "/annex/objects/readme.txt\n",
      "# not a pointer\n/annex/objects/SHA256E-s10--abc.edf\n",
      "",
    ]) {
      expect(annexSide(REGULAR, encoder.encode(text)), JSON.stringify(text)).toEqual({
        kind: "git",
      });
    }
  });

  test("a link target is one line: a final LF or CR is dropped, anything after a line break is no key", () => {
    const key = "SHA256E-s10--abc.edf";
    for (const target of [
      `../.git/annex/objects/Xj/9P/${key}/${key}\n`,
      `../.git/annex/objects/Xj/9P/${key}/${key}\r`,
      `x/annex/objects/${key}`,
      `/annex/objects/${key}`,
    ]) {
      expect(annexSide(SYMLINK, encoder.encode(target)), JSON.stringify(target)).toEqual({
        kind: "annexed",
        key,
      });
    }
    for (const target of [
      // No slash before `annex`, and no `.git` above it: not an annex link.
      `annex/objects/${key}`,
      `../.git/annex/objects/Xj/9P/${key}/${key}\n/annex/more`,
      `../.git/annex/objects/Xj/9P/${key}/${key}\r\nextra`,
      `.git/annex/objects/Xj/9P/${key}/${key}\nextra`,
    ]) {
      expect(annexSide(SYMLINK, encoder.encode(target)), JSON.stringify(target)).toEqual({
        kind: "link",
      });
    }
  });

  test("a submodule is other, an unknown mode is other, and a regular file is git", () => {
    expect(annexSide(SUBMODULE, "large")).toEqual({ kind: "other" });
    expect(annexSide(SUBMODULE, encoder.encode("/annex/objects/SHA256E-s10--abc.edf"))).toEqual({
      kind: "other",
    });
    // A submodule has no blob to read, so a failed read of it is not a failed read of content.
    expect(annexSide(SUBMODULE, "unreadable")).toEqual({ kind: "other" });
    for (const mode of ["040000", "000000", "100664", "120001", ""]) {
      expect(annexSide(mode, encoder.encode(annexTarget("SHA256E-s10--abc.edf"))), mode).toEqual({
        kind: "other",
      });
    }
    expect(annexSide(REGULAR, encoder.encode("onset\tduration\n"))).toEqual({ kind: "git" });
  });

  test("a probe that could not be read is unreadable, never large and never git", () => {
    for (const mode of [SYMLINK, REGULAR, "100755"]) {
      expect(annexSide(mode, "unreadable"), mode).toEqual({ kind: "unreadable" });
    }
  });

  test("a large probe is not decoded: a regular file is git, a symlink a link", () => {
    expect(annexSide(REGULAR, "large")).toEqual({ kind: "git" });
    expect(annexSide("100755", "large")).toEqual({ kind: "git" });
    expect(annexSide(SYMLINK, "large")).toEqual({ kind: "link" });
  });

  test("bytes over the pointer bound are large, whatever they say", () => {
    const key = "SHA256E-s10--abc.edf";
    const head = `/annex/objects/${key}\n/annex/`;
    const atBound = encoder.encode(`${head}${"x".repeat(1_023 - head.length)}`);
    expect(atBound.length).toBe(ORIGINAL_LIMITS.pointerMaxBytes);
    expect(annexSide(REGULAR, atBound)).toEqual({ kind: "annexed", key });
    const over = encoder.encode(`${head}${"x".repeat(1_024 - head.length)}`);
    expect(annexSide(REGULAR, over)).toEqual({ kind: "git" });
    // A megabyte that ends in a valid annex link is still not read.
    const megabyte = encoder.encode(
      `${"../".repeat(350_000)}.git/annex/objects/xx/yy/${key}/${key}`,
    );
    expect(megabyte.length).toBeGreaterThan(1024 * 1024);
    expect(annexSide(SYMLINK, megabyte)).toEqual({ kind: "link" });
  });

  test("hostile key text: a control character or malformed UTF-8 is no key", () => {
    const key = "SHA256E-s10--abc.edf";
    // A NUL, a CR inside, or a second CR at the end: git-annex accepts these, this module does not.
    for (const target of [
      `.git/annex/objects/xx/yy/${key}\0/${key}\0`,
      `.git/annex/objects/xx/yy/${key}/${key}\0x`,
      `.git/annex/objects/xx/yy/${key}/${key}\rextra`,
      `.git/annex/objects/xx/yy/${key}/${key}\r\r`,
      `.git/annex/objects/xx/yy/${key}/${key}\u{7F}`,
    ]) {
      expect(annexSide(SYMLINK, encoder.encode(target)), JSON.stringify(target)).toEqual({
        kind: "link",
      });
    }
    for (const text of [`/annex/objects/${key}\0`, `/annex/objects/${key}\ronset\n`]) {
      expect(annexSide(REGULAR, encoder.encode(text)), JSON.stringify(text)).toEqual({
        kind: "git",
      });
    }
    // A malformed byte is not replaced by U+FFFD: it would let two different keys read as one.
    const bad = new Uint8Array([
      ...encoder.encode(`.git/annex/objects/xx/yy/${key}/SHA256E-s1--a`),
      0xff,
    ]);
    expect(annexSide(SYMLINK, bad)).toEqual({ kind: "link" });
    // `KEY\nextra`: a forged second line never extends a key, in a link or in a pointer.
    const forged = `${key}\nSHA256E-s99--forged.edf`;
    expect(annexSide(SYMLINK, encoder.encode(`.git/annex/objects/xx/yy/${forged}`))).toEqual({
      kind: "link",
    });
    expect(annexSide(REGULAR, encoder.encode(`/annex/objects/${forged}`))).toEqual({
      kind: "git",
    });
  });
});

describe("recordingFacts: the shapes of set A", () => {
  test("59 annexed recordings with a new key are 59 replaced (on003343)", () => {
    const changes = Array.from({ length: 59 }, (_, n) =>
      recording(
        `sub-${n}/eeg/sub-${n}_task-x_eeg.edf`,
        locked(keyOf(n)),
        locked(keyOf(1000 + n)),
        true,
      ),
    );
    expect(recordingFacts(changes)).toEqual(noRecordingChange({ replaced: 59 }));
  });

  test("41 annexed recordings that became regular git files are 41 type changes (on003029)", () => {
    const changes = Array.from({ length: 41 }, (_, n) => {
      const path = `sub-${n}/eeg/sub-${n}_task-x_eeg.edf`;
      const now = plain(`recording ${n}`);
      const change = recording(path, locked(keyOf(n)), now, true);
      expect(change.status).toBe("typechange");
      return change;
    });
    expect(recordingFacts(changes)).toEqual(noRecordingChange({ typeChanged: 41 }));
  });

  test("5 annexed events files that became regular files count by kind, outside the recordings area (on004703)", () => {
    const changes = Array.from({ length: 5 }, (_, n) =>
      recording(
        `sub-${n}/eeg/sub-${n}_task-x_events.tsv`,
        locked(keyOf(n)),
        plain("onset\tduration\n"),
        false,
      ),
    );
    expect(recordingFacts(changes)).toEqual(noRecordingChange({ typeChanged: 5 }));
  });

  test("15 links removed from derivatives and added in the raw tree with equal keys are 15 moved (on004306)", () => {
    const changes: RecordingChange[] = [];
    for (let n = 0; n < 15; n++) {
      changes.push(
        recording(`derivatives/eeglab/sub-${n}/sub-${n}_eeg.fdt`, locked(keyOf(n), 4), null),
      );
      changes.push(recording(`sub-${n}/eeg/sub-${n}_eeg.fdt`, null, locked(keyOf(n), 3), true));
    }
    expect(changes[0]?.inReviewedScope).toBe(false);
    expect(changes[1]?.inReviewedScope).toBe(true);
    expect(recordingFacts(changes)).toEqual(noRecordingChange({ moved: 15 }));
  });
});

describe("recordingFacts: the reviewed scope", () => {
  test("the scope agrees with the evidence module's own areas for every kind of path", () => {
    for (const path of [
      "sub-01/eeg/sub-01_task-x_eeg.edf",
      "sub-01/eeg/sub-01_task-x_events.tsv",
      "README",
      "CHANGES",
      "dataset_description.json",
      "participants.tsv",
      "sourcedata/raw/sub-01.bdf",
      "derivatives/eeglab/sub-01.set",
      "code/run.py",
      "sub-01/derivatives/x.edf",
      "sourcedata.tsv",
      "codebook.json",
      "derivatives",
      "code",
      "Derivatives/x.edf",
    ]) {
      const area = classifyPath(path);
      expect(inReviewedScope(path), path).toBe(
        area !== "sourcedata" && area !== "derivatives" && area !== "code",
      );
    }
  });

  test("the scope leaves out exactly sourcedata/, derivatives/ and code/ at the top", () => {
    expect([...REVIEW_LEFT_OUT_DIRS]).toEqual(["sourcedata", "derivatives", "code"]);
    for (const path of ["sourcedata/raw/x.bdf", "derivatives/a/b.edf", "code/run.py"]) {
      expect(inReviewedScope(path), path).toBe(false);
    }
    for (const path of [
      "sub-01/eeg/x.edf",
      "README",
      "sub-01/derivatives/x.edf",
      "sourcedata.tsv",
      "codebook.json",
      "Derivatives/x.edf",
    ]) {
      expect(inReviewedScope(path), path).toBe(true);
    }
  });

  test("a pointer moved from derivatives/ into the recordings area is moved and nothing else", () => {
    const key = keyOf(30);
    expect(
      recordingFacts([
        recording("derivatives/pipeline/sub-01_eeg.fdt", locked(key, 3), null),
        recording("sub-01/eeg/sub-01_eeg.fdt", null, locked(key, 2), true),
      ]),
    ).toEqual(noRecordingChange({ moved: 1 }));
  });

  test("a pointer moved from the recordings area into derivatives/ is moved too", () => {
    const key = keyOf(31);
    expect(
      recordingFacts([
        recording("sub-01/eeg/sub-01_eeg.fdt", locked(key, 2), null, true),
        recording("derivatives/pipeline/sub-01_eeg.fdt", null, unlocked(key)),
      ]),
    ).toEqual(noRecordingChange({ moved: 1 }));
  });

  test("an annexed file replaced under derivatives/ or sourcedata/ is not replaced", () => {
    expect(
      recordingFacts([
        recording("derivatives/pipeline/sub-01_eeg.edf", locked(keyOf(32)), locked(keyOf(33))),
        recording("sourcedata/raw/sub-01.bdf", locked(keyOf(34)), unlocked(keyOf(35))),
        recording("sourcedata/raw/sub-02.bdf", plain("old", "large"), plain("new", "large"), true),
      ]),
    ).toEqual(noRecordingChange());
    // The same change in the raw tree is a replacement.
    expect(
      recordingFacts([
        recording("sub-01/eeg/sub-01_eeg.edf", locked(keyOf(32)), locked(keyOf(33)), true),
      ]),
    ).toEqual(noRecordingChange({ replaced: 1 }));
  });

  test("a type change under code/ is not a type change of a recording", () => {
    expect(
      recordingFacts([recording("code/fixtures/sample.edf", locked(keyOf(36)), plain("inline"))]),
    ).toEqual(noRecordingChange());
    expect(
      recordingFacts([
        recording("sub-01/eeg/sample.edf", locked(keyOf(36)), plain("inline"), true),
      ]),
    ).toEqual(noRecordingChange({ typeChanged: 1 }));
  });

  test("a side that could not be read is unread in any area", () => {
    expect(
      recordingFacts([
        recording("sourcedata/raw/sub-01.bdf", { ...locked(keyOf(37)), probe: "unreadable" }, null),
        recording("derivatives/x/sub-01.edf", locked(keyOf(38)), {
          ...plain("x"),
          probe: "unreadable",
        }),
      ]),
    ).toEqual(noRecordingChange({ unread: 2 }));
  });
});

describe("recordingFacts: what is a replacement and what is not", () => {
  test("a link that only changed its depth is the same object: no replacement", () => {
    const key = keyOf(1);
    expect(recordingFacts([recording("a_eeg.edf", locked(key, 1), locked(key, 3), true)])).toEqual(
      noRecordingChange(),
    );
    expect(recordingFacts([recording("a_eeg.edf", locked(key, 4), locked(key, 0), true)])).toEqual(
      noRecordingChange(),
    );
  });

  test("a locked file made an unlocked pointer with the same key, and the reverse, is no change", () => {
    const key = keyOf(2);
    expect(recordingFacts([recording("a_eeg.edf", locked(key), unlocked(key), true)])).toEqual(
      noRecordingChange(),
    );
    expect(recordingFacts([recording("a_eeg.edf", unlocked(key), locked(key), true)])).toEqual(
      noRecordingChange(),
    );
    // With a different key it is a replacement, whichever way the file is held.
    expect(
      recordingFacts([recording("a_eeg.edf", locked(keyOf(2)), unlocked(keyOf(3)), true)]),
    ).toEqual(noRecordingChange({ replaced: 1 }));
    expect(
      recordingFacts([recording("a_eeg.edf", unlocked(keyOf(2)), unlocked(keyOf(3)), true)]),
    ).toEqual(noRecordingChange({ replaced: 1 }));
  });

  test("an unlocked pointer replaced by its content is a type change though git calls it modified", () => {
    const change = recording("a_eeg.edf", unlocked(keyOf(4)), plain("the data itself"), true);
    expect(change.status).toBe("modified");
    expect(recordingFacts([change])).toEqual(noRecordingChange({ typeChanged: 1 }));
    const reverse = recording("a_eeg.edf", plain("the data itself"), unlocked(keyOf(4)), true);
    expect(reverse.status).toBe("modified");
    expect(recordingFacts([reverse])).toEqual(noRecordingChange({ typeChanged: 1 }));
  });

  test("annexed to a plain link, to a submodule, or the reverse, is a type change", () => {
    const stray: Side = sideOf(SYMLINK, "../shared/data.edf");
    const submodule: Side = { mode: SUBMODULE, oid: "1".repeat(40), probe: "large" };
    for (const [was, now] of [
      [locked(keyOf(5)), stray],
      [stray, locked(keyOf(5))],
      [locked(keyOf(5)), submodule],
      [submodule, unlocked(keyOf(5))],
    ] as [Side, Side][]) {
      expect(recordingFacts([recording("a_eeg.edf", was, now)])).toEqual(
        noRecordingChange({ typeChanged: 1 }),
      );
    }
  });

  test("a path out of scope listed first does not stop the count of the paths after it", () => {
    expect(
      recordingFacts([
        recording("code/run.py", plain("print(1)"), plain("print(2)")),
        recording("sub-01/eeg/x_eeg.edf", locked(keyOf(40)), locked(keyOf(41)), true),
      ]),
    ).toEqual(noRecordingChange({ replaced: 1 }));
  });

  test("the same blob turned from a file into a link is a change of kind, so replaced", () => {
    // A regular file holding `../shared/a.edf` and a symlink to `../shared/a.edf` are one blob id.
    const file = sideOf(REGULAR, "../shared/a.edf");
    const link = sideOf(SYMLINK, "../shared/a.edf");
    expect(file.oid).toBe(link.oid);
    expect(recordingFacts([recording("sub-01/eeg/x_eeg.edf", file, link, true)])).toEqual(
      noRecordingChange({ replaced: 1 }),
    );
    expect(recordingFacts([recording("sub-01/eeg/x_eeg.edf", link, file, true)])).toEqual(
      noRecordingChange({ replaced: 1 }),
    );
  });

  test("in the recordings area, a plain link, a submodule or a git file that changed is replaced", () => {
    const a = sideOf(SYMLINK, "../shared/a.edf");
    const b = sideOf(SYMLINK, "../shared/b.edf");
    const file = plain("recorded bytes", "large");
    const submodule: Side = { mode: SUBMODULE, oid: "1".repeat(40), probe: "large" };
    const later: Side = { mode: SUBMODULE, oid: "2".repeat(40), probe: "large" };
    for (const [label, was, now] of [
      ["link to a link with another target", a, b],
      ["git file to a plain link", file, a],
      ["plain link to a git file", a, file],
      ["git file to a submodule", file, submodule],
      ["submodule at a new commit", submodule, later],
    ] as [string, Side, Side][]) {
      expect(recordingFacts([recording("sub-01/eeg/x_eeg.edf", was, now, true)]), label).toEqual(
        noRecordingChange({ replaced: 1 }),
      );
      // Outside the recordings area the same change is no recording fact.
      expect(recordingFacts([recording("sub-01/x_notes.txt", was, now)]), label).toEqual(
        noRecordingChange(),
      );
    }
    // The same link, and a link only added or removed, are nothing.
    expect(recordingFacts([recording("x_eeg.edf", a, { ...a }, true)])).toEqual(
      noRecordingChange(),
    );
    expect(recordingFacts([recording("x_eeg.edf", a, null, true)])).toEqual(noRecordingChange());
    expect(recordingFacts([recording("x_eeg.edf", null, a, true)])).toEqual(noRecordingChange());
  });

  test("git to git is a replacement only in the recordings area, and only with new content", () => {
    const old = plain("old recording", "large");
    const fresh = plain("new recording", "large");
    expect(recordingFacts([recording("a_eeg.edf", old, fresh, true)])).toEqual(
      noRecordingChange({ replaced: 1 }),
    );
    // Outside the area (a README, a sidecar), a regular file edited is the business of Part A.
    expect(recordingFacts([recording("README", old, fresh, false)])).toEqual(noRecordingChange());
    // Inside it but the same blob, as when only the mode changed: nothing is replaced.
    expect(recordingFacts([recording("a_eeg.edf", old, { ...old, mode: "100755" }, true)])).toEqual(
      noRecordingChange(),
    );
    // Small files are probed as bytes and large ones are not; both are git to git.
    expect(
      recordingFacts([recording("a_eeg.edf", plain("small"), plain("smaller"), true)]),
    ).toEqual(noRecordingChange({ replaced: 1 }));
  });

  test("an added or removed recording is not a replacement, a type change or a move by itself", () => {
    expect(
      recordingFacts([
        recording("new_eeg.edf", null, locked(keyOf(6)), true),
        recording("gone_eeg.edf", locked(keyOf(7)), null, true),
        recording("plain_eeg.edf", null, plain("data", "large"), true),
        recording("plain2_eeg.edf", plain("data", "large"), null, true),
      ]),
    ).toEqual(noRecordingChange());
  });

  test("a key moved to a path that also changed another way is one move and one other fact", () => {
    // `a` leaves, and `b` gains its key; `c` is replaced. The move is not also a replacement.
    expect(
      recordingFacts([
        recording("a_eeg.edf", locked(keyOf(8)), null, true),
        recording("b_eeg.edf", null, unlocked(keyOf(8)), true),
        recording("c_eeg.edf", locked(keyOf(9)), locked(keyOf(10)), true),
      ]),
    ).toEqual(noRecordingChange({ moved: 1, replaced: 1 }));
  });

  test("keys are matched as a multiset: one added path takes one removed path", () => {
    const key = keyOf(11);
    // Two removed with one key and one added with it: one move, whichever way they are listed.
    const twoGone = [
      recording("a_eeg.edf", locked(key), null, true),
      recording("b_eeg.edf", locked(key), null, true),
      recording("c_eeg.edf", null, locked(key), true),
    ];
    expect(recordingFacts(twoGone)).toEqual(noRecordingChange({ moved: 1 }));
    expect(recordingFacts([...twoGone].reverse())).toEqual(noRecordingChange({ moved: 1 }));
    // One removed and two added: one move again.
    expect(
      recordingFacts([
        recording("a_eeg.edf", locked(key), null, true),
        recording("b_eeg.edf", null, locked(key), true),
        recording("c_eeg.edf", null, unlocked(key), true),
      ]),
    ).toEqual(noRecordingChange({ moved: 1 }));
    // Two and two: two moves.
    expect(
      recordingFacts([
        recording("a_eeg.edf", locked(key), null, true),
        recording("b_eeg.edf", locked(key), null, true),
        recording("c_eeg.edf", null, locked(key), true),
        recording("d_eeg.edf", null, locked(key), true),
      ]),
    ).toEqual(noRecordingChange({ moved: 2 }));
  });

  test("a removed key that is not added, or a path added by another key, is not moved", () => {
    expect(
      recordingFacts([
        recording("a_eeg.edf", locked(keyOf(12)), null, true),
        recording("b_eeg.edf", null, locked(keyOf(13)), true),
        // A key that exists on both sides of one path is not a removal.
        recording("c_eeg.edf", locked(keyOf(14)), locked(keyOf(14)), true),
        recording("d_eeg.edf", null, locked(keyOf(14)), true),
      ]),
    ).toEqual(noRecordingChange());
  });

  test("the answer does not depend on the order the paths are listed in", () => {
    const random = mulberry32(5);
    const changes: RecordingChange[] = [];
    for (let n = 0; n < 40; n++) {
      changes.push(recording(`p${n}_eeg.edf`, locked(keyOf(n)), locked(keyOf(n + 100)), true));
      changes.push(recording(`q${n}_eeg.edf`, locked(keyOf(n + 200)), null, true));
      changes.push(recording(`r${n}_eeg.edf`, null, locked(keyOf(n + 200)), true));
      changes.push(recording(`s${n}_eeg.edf`, unlocked(keyOf(n)), plain(`v${n}`), true));
    }
    const expected = noRecordingChange({ replaced: 40, moved: 40, typeChanged: 40 });
    expect(recordingFacts(changes)).toEqual(expected);
    for (let round = 0; round < 5; round++) {
      expect(recordingFacts(shuffled(changes, random))).toEqual(expected);
    }
  });
});

describe("recordingFacts: sides that could not be read", () => {
  test("an unreadable side is counted as unread and adds nothing else", () => {
    const key = keyOf(20);
    expect(
      recordingFacts([
        recording("a_eeg.edf", { ...locked(key), probe: "unreadable" }, locked(keyOf(21)), true),
        recording("b_eeg.edf", locked(keyOf(22)), { ...plain("x"), probe: "unreadable" }, true),
      ]),
    ).toEqual(noRecordingChange({ unread: 2 }));
    // Both sides of one path unreadable is one path, counted once.
    expect(
      recordingFacts([
        recording(
          "c_eeg.edf",
          { ...locked(key), probe: "unreadable" },
          { ...locked(key), probe: "unreadable" },
          true,
        ),
      ]),
    ).toEqual(noRecordingChange({ unread: 1 }));
  });

  test("an unreadable side takes no part in matching moves", () => {
    const key = keyOf(23);
    // The removed path is readable and the added one is not: its key is unknown, so no move.
    expect(
      recordingFacts([
        recording("a_eeg.edf", locked(key), null, true),
        recording("b_eeg.edf", null, { ...locked(key), probe: "unreadable" }, true),
      ]),
    ).toEqual(noRecordingChange({ unread: 1 }));
    // Nor does an unreadable path hide a replacement elsewhere.
    expect(
      recordingFacts([
        recording("a_eeg.edf", { ...locked(key), probe: "unreadable" }, locked(keyOf(24)), true),
        recording("b_eeg.edf", locked(keyOf(25)), locked(keyOf(26)), true),
      ]),
    ).toEqual(noRecordingChange({ unread: 1, replaced: 1 }));
  });

  test("a large probe is a fact about the blob: a large file on both sides is git, not unread", () => {
    // A recording of gigabytes that is a regular file in git is `git`, and its id decides.
    const old = plain("a", "large");
    const fresh = plain("b", "large");
    expect(recordingFacts([recording("a_eeg.edf", old, fresh, true)])).toEqual(
      noRecordingChange({ replaced: 1 }),
    );
    // And the same large file against an annex link is a type change.
    expect(recordingFacts([recording("a_eeg.edf", locked(keyOf(27)), old, true)])).toEqual(
      noRecordingChange({ typeChanged: 1 }),
    );
  });

  test("nothing changed is nothing", () => {
    expect(recordingFacts([])).toEqual(noRecordingChange());
  });
});

/** A 40-hex object id for the n-th object of a test. */
const sha = (n: number): string => n.toString(16).padStart(40, "0");

/** The text `git ls-remote --tags` writes for these `[id, ref]` lines. */
function lsRemote(...lines: [string, string][]): string {
  return `${lines.map(([id, ref]) => `${id}\t${ref}`).join("\n")}\n`;
}

/** An annotated tag's two lines: the tag object, then the commit it peels to. */
function annotated(name: string, tagObject: string, commit: string): [string, string][] {
  return [
    [tagObject, `refs/tags/${name}`],
    [commit, `refs/tags/${name}^{}`],
  ];
}

/** The tag named `vA.B.C` with this commit, as `parseVersionTags` returns it. */
function versionTag(a: string, b: string, c: string, commit: string): VersionTag {
  return { name: `v${a}.${b}.${c}`, version: [a, b, c], commit };
}

/** An ancestor check that answers from a table and records the commits it was asked about. */
function asking(answers: Record<string, boolean | null>): {
  isAncestor: (commit: string) => boolean | null;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    isAncestor: (commit) => {
      asked.push(commit);
      const answer = answers[commit];
      if (answer === undefined) throw new Error(`unexpected commit ${commit}`);
      return answer;
    },
  };
}

describe("parseVersionTags", () => {
  test("version tags are listed lowest first, and the order is by value, not by text", () => {
    const tags = parseVersionTags(
      lsRemote(
        [sha(1), "refs/tags/v2.0.0"],
        [sha(2), "refs/tags/v1.10.0"],
        [sha(3), "refs/tags/v1.9.0"],
        [sha(4), "refs/tags/v1.9.10"],
        [sha(5), "refs/tags/v1.9.2"],
        [sha(6), "refs/tags/v0.12.0"],
        [sha(7), "refs/tags/v10.0.0"],
      ),
    );
    expect(tags.map((tag) => tag.name)).toEqual([
      "v0.12.0",
      "v1.9.0",
      "v1.9.2",
      "v1.9.10",
      "v1.10.0",
      "v2.0.0",
      "v10.0.0",
    ]);
    expect(tags[4]).toEqual({ name: "v1.10.0", version: ["1", "10", "0"], commit: sha(2) });
  });

  test("leading zeros do not count: v1.0009.0 is below v1.10.0 and v1.0010.0 above v1.9.0", () => {
    const tags = parseVersionTags(
      lsRemote(
        [sha(1), "refs/tags/v1.10.0"],
        [sha(2), "refs/tags/v1.0009.0"],
        [sha(3), "refs/tags/v1.0010.0"],
        [sha(4), "refs/tags/v1.9.0"],
      ),
    );
    // 1.9 (twice, told apart by name) below 1.10 (twice, told apart by name).
    expect(tags.map((tag) => tag.name)).toEqual(["v1.0009.0", "v1.9.0", "v1.0010.0", "v1.10.0"]);
  });

  test("an annotated tag's commit is its peeled id, whichever line comes first", () => {
    const commit = sha(100);
    const tagObject = sha(200);
    for (const lines of [
      annotated("v1.0.0", tagObject, commit),
      [...annotated("v1.0.0", tagObject, commit)].reverse(),
    ]) {
      expect(parseVersionTags(lsRemote(...lines))).toEqual([versionTag("1", "0", "0", commit)]);
    }
    // A lightweight tag names the commit itself, and a peeled line alone is enough.
    expect(parseVersionTags(lsRemote([commit, "refs/tags/v1.0.0"]))).toEqual([
      versionTag("1", "0", "0", commit),
    ]);
    expect(parseVersionTags(lsRemote([commit, "refs/tags/v1.0.0^{}"]))).toEqual([
      versionTag("1", "0", "0", commit),
    ]);
  });

  test("a name given two different ids is dropped; the same id twice is one tag", () => {
    expect(
      parseVersionTags(
        lsRemote(
          [sha(1), "refs/tags/v1.0.0"],
          [sha(2), "refs/tags/v1.0.0"],
          [sha(3), "refs/tags/v1.1.0"],
          [sha(3), "refs/tags/v1.1.0"],
        ),
      ),
    ).toEqual([versionTag("1", "1", "0", sha(3))]);
    // Two different peeled commits for one name are as ambiguous as two plain ids.
    expect(
      parseVersionTags(
        lsRemote(
          [sha(1), "refs/tags/v1.0.0"],
          [sha(2), "refs/tags/v1.0.0^{}"],
          [sha(3), "refs/tags/v1.0.0^{}"],
        ),
      ),
    ).toEqual([]);
    // One plain id and one peeled id are an annotated tag, not a conflict.
    expect(
      parseVersionTags(lsRemote([sha(1), "refs/tags/v1.0.0"], [sha(2), "refs/tags/v1.0.0^{}"])),
    ).toEqual([versionTag("1", "0", "0", sha(2))]);
  });

  test("a line that is not exactly an id, a tab and a version tag is ignored", () => {
    const good = `${sha(1)}\trefs/tags/v1.0.0`;
    const garbage = [
      `${sha(2)}\trefs/tags/v1.0.0-rc1`,
      `${sha(2)}\trefs/tags/V1.0.0`,
      `${sha(2)}\trefs/tags/1.0.0`,
      `${sha(2)}\trefs/tags/v1.0`,
      `${sha(2)}\trefs/tags/v1.0.0.1`,
      `${sha(2)}\trefs/tags/v1.0.x`,
      `${sha(2)}\trefs/tags/v1.0.0^{}^{}`,
      `${sha(2)}\trefs/tags/v1.0.0^{}x`,
      `${sha(2)}\trefs/tags/release/v1.0.0`,
      `${sha(2)}\trefs/tags/v-1.0.0`,
      `${sha(2)}\trefs/tags/v\u{661}.\u{660}.\u{660}`,
      `${sha(2)}\trefs/heads/v1.0.0`,
      `${sha(2)}\trefs/remotes/origin/v1.0.0`,
      `${sha(2)}\tHEAD`,
      `${sha(2)} refs/tags/v1.0.0`,
      `${sha(2)}\t\trefs/tags/v1.0.0`,
      `${sha(2)}\trefs/tags/v1.0.0 `,
      ` ${sha(2)}\trefs/tags/v1.0.0`,
      `${sha(0xabcdef).toUpperCase()}\trefs/tags/v1.0.0`,
      `${sha(2).slice(1)}\trefs/tags/v1.0.0`,
      `${"a".repeat(64)}\trefs/tags/v1.0.0`,
      `${sha(2)}0\trefs/tags/v1.0.0`,
      "refs/tags/v1.0.0",
      "",
      "\t",
      "not a ref at all",
    ];
    expect(parseVersionTags([...garbage, good, ...garbage].join("\n"))).toEqual([
      versionTag("1", "0", "0", sha(1)),
    ]);
    expect(parseVersionTags(garbage.join("\n"))).toEqual([]);
    expect(parseVersionTags("")).toEqual([]);
  });

  test("a CRLF-terminated line is not a match, so the listing is read as LF only", () => {
    const text = `${sha(1)}\trefs/tags/v1.0.0\r\n${sha(2)}\trefs/tags/v1.1.0\n`;
    expect(parseVersionTags(text)).toEqual([versionTag("1", "1", "0", sha(2))]);
  });

  test("leading zeros do not change a version's value, and the name breaks the tie", () => {
    const tags = parseVersionTags(
      lsRemote(
        [sha(1), "refs/tags/v1.2.3"],
        [sha(2), "refs/tags/v1.02.3"],
        [sha(3), "refs/tags/v01.2.3"],
        [sha(4), "refs/tags/v1.2.03"],
        [sha(5), "refs/tags/v1.009.0"],
        [sha(6), "refs/tags/v1.8.0"],
        [sha(7), "refs/tags/v00.000.0"],
        [sha(8), "refs/tags/v0.0.0"],
      ),
    );
    expect(tags.map((tag) => tag.name)).toEqual([
      "v0.0.0",
      "v00.000.0",
      "v01.2.3",
      "v1.02.3",
      "v1.2.03",
      "v1.2.3",
      "v1.8.0",
      "v1.009.0",
    ]);
    // The numbers are kept as written.
    expect(tags.find((tag) => tag.name === "v1.02.3")?.version).toEqual(["1", "02", "3"]);
  });

  test("a version number of ten thousand digits parses and sorts, with no conversion to a Number", () => {
    const huge = "9".repeat(10_000);
    const larger = `1${"0".repeat(10_000)}`; // 10,001 digits
    const nearlyLarger = `1${"0".repeat(9_999)}`; // 10,000 digits
    const paddedSeven = `${"0".repeat(5_000)}7`;
    const tags = parseVersionTags(
      lsRemote(
        [sha(1), `refs/tags/v1.${larger}.0`],
        [sha(2), `refs/tags/v1.${huge}.0`],
        [sha(3), `refs/tags/v1.${nearlyLarger}.0`],
        [sha(4), `refs/tags/v1.${paddedSeven}.0`],
        [sha(5), "refs/tags/v1.7.0"],
        [sha(6), `refs/tags/v${huge}.0.0`],
      ),
    );
    // 7, then 7 again (the padded spelling is the lower name), then 10,000 digits starting with 1,
    // 10,000 nines, 10,001 digits, and last the huge major version.
    expect(tags.map((tag) => tag.commit)).toEqual([sha(4), sha(5), sha(3), sha(2), sha(1), sha(6)]);
    expect(tags[4]?.version[1]).toBe(larger);
  });
});

describe("chooseAnchor", () => {
  const v100 = versionTag("1", "0", "0", sha(1));
  const v110 = versionTag("1", "1", "0", sha(2));
  const v200 = versionTag("2", "0", "0", sha(3));

  test("the lowest tag that is an ancestor is chosen, not the highest", () => {
    const { isAncestor, asked } = asking({ [sha(1)]: true, [sha(2)]: true, [sha(3)]: true });
    expect(chooseAnchor([v100, v110, v200], isAncestor)).toEqual({
      anchor: "first_version_tag",
      tag: v100,
      commit: sha(1),
    });
    // The search stops at the first answer, and asks about the commit, not the name.
    expect(asked).toEqual([sha(1)]);
  });

  test("the lowest version is tried first, whatever order the tags are given in", () => {
    const { isAncestor, asked } = asking({ [sha(1)]: false, [sha(2)]: true, [sha(3)]: true });
    for (const tags of [
      [v200, v110, v100],
      [v110, v200, v100],
      [v100, v200, v110],
    ]) {
      asked.length = 0;
      expect(chooseAnchor(tags, isAncestor)).toEqual({
        anchor: "first_version_tag",
        tag: v110,
        commit: sha(2),
      });
      expect(asked).toEqual([sha(1), sha(2)]);
    }
    // v1.10.0 is above v1.9.0, so the order is by value here too.
    const nine = versionTag("1", "9", "0", sha(4));
    const ten = versionTag("1", "10", "0", sha(5));
    const both = asking({ [sha(4)]: true, [sha(5)]: true });
    expect(chooseAnchor([ten, nine], both.isAncestor)).toMatchObject({ commit: sha(4) });
  });

  test("a tag that is not an ancestor is skipped for the next one", () => {
    const { isAncestor, asked } = asking({ [sha(1)]: false, [sha(2)]: false, [sha(3)]: true });
    expect(chooseAnchor([v100, v110, v200], isAncestor)).toEqual({
      anchor: "first_version_tag",
      tag: v200,
      commit: sha(3),
    });
    expect(asked).toEqual([sha(1), sha(2), sha(3)]);
  });

  test("a check that could not be answered stops the search; it is not read as not an ancestor", () => {
    // `null` first: the lowest tag could not be checked, so no later tag is tried.
    const first = asking({ [sha(1)]: null, [sha(2)]: true, [sha(3)]: true });
    expect(chooseAnchor([v100, v110, v200], first.isAncestor)).toEqual({
      anchor: "merge_base",
      reason: "check_failed",
    });
    expect(first.asked).toEqual([sha(1)]);
    // `null` after a `false`: the answer is still check_failed, and the search ends there.
    const later = asking({ [sha(1)]: false, [sha(2)]: null, [sha(3)]: true });
    expect(chooseAnchor([v100, v110, v200], later.isAncestor)).toEqual({
      anchor: "merge_base",
      reason: "check_failed",
    });
    expect(later.asked).toEqual([sha(1), sha(2)]);
  });

  test("no tag is no_tag, and every tag tried and not an ancestor is no_ancestor", () => {
    expect(chooseAnchor([], () => true)).toEqual({ anchor: "merge_base", reason: "no_tag" });
    const { isAncestor, asked } = asking({ [sha(1)]: false, [sha(2)]: false, [sha(3)]: false });
    expect(chooseAnchor([v100, v110, v200], isAncestor)).toEqual({
      anchor: "merge_base",
      reason: "no_ancestor",
    });
    expect(asked).toEqual([sha(1), sha(2), sha(3)]);
  });

  test("thirty-two tags none of which is an ancestor are no_ancestor; thirty-three are too_many_tags", () => {
    const many = (count: number): VersionTag[] =>
      Array.from({ length: count }, (_, n) => versionTag("1", String(n), "0", sha(n + 1)));
    const never = (log: string[]) => (commit: string) => {
      log.push(commit);
      return false;
    };
    const at32: string[] = [];
    expect(chooseAnchor(many(ORIGINAL_LIMITS.maxTagsTried), never(at32))).toEqual({
      anchor: "merge_base",
      reason: "no_ancestor",
    });
    expect(at32).toHaveLength(32);
    const at33: string[] = [];
    expect(chooseAnchor(many(ORIGINAL_LIMITS.maxTagsTried + 1), never(at33))).toEqual({
      anchor: "merge_base",
      reason: "too_many_tags",
    });
    // The 33rd tag is never asked about, so the number of checks is bounded.
    expect(at33).toHaveLength(32);
    const bounded: string[] = [];
    expect(chooseAnchor(many(5_000), never(bounded))).toEqual({
      anchor: "merge_base",
      reason: "too_many_tags",
    });
    expect(bounded).toHaveLength(32);
  });

  test("an ancestor among the first thirty-two is found, and one past them is not looked for", () => {
    const many = Array.from({ length: 40 }, (_, n) => versionTag("1", String(n), "0", sha(n + 1)));
    const last = asking(Object.fromEntries(many.map((tag, n) => [tag.commit, n === 31])));
    expect(chooseAnchor(many, last.isAncestor)).toMatchObject({
      anchor: "first_version_tag",
      commit: sha(32),
    });
    // The only ancestor is the 33rd tag: it is never tried.
    const beyond = asking(Object.fromEntries(many.map((tag, n) => [tag.commit, n === 32])));
    expect(chooseAnchor(many, beyond.isAncestor)).toEqual({
      anchor: "merge_base",
      reason: "too_many_tags",
    });
  });

  test("a listing goes through both functions: the peeled commit is asked about", () => {
    const text = lsRemote(
      ...annotated("v1.0.0", sha(900), sha(1)),
      ...annotated("v1.1.0", sha(901), sha(2)),
      [sha(3), "refs/tags/v2.0.0"],
      [sha(4), "refs/tags/v2.0.0-rc1"],
      [sha(5), "refs/heads/main"],
    );
    const { isAncestor, asked } = asking({ [sha(1)]: false, [sha(2)]: true, [sha(3)]: true });
    const choice = chooseAnchor(parseVersionTags(text), isAncestor);
    expect(choice).toEqual({
      anchor: "first_version_tag",
      tag: versionTag("1", "1", "0", sha(2)),
      commit: sha(2),
    });
    expect(asked).toEqual([sha(1), sha(2)]);
  });
});

/** Tab-separated text from rows of cells, with LF endings and a final newline. */
function tsv(...rows: string[][]): string {
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

/** A JSON document as a contributor's tool writes it: indented, with a final newline. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A file whose text changed, as the change summary is asked about it. */
interface Edit {
  path: string;
  before: string;
  after: string;
}

/** The real change summary of these edits: the real parsers, diffs and classes, on real bytes. */
function summaryOf(edits: readonly Edit[]): ChangeSummary {
  return summarizeChanges({
    candidates: edits.map(({ path, before, after }) => ({
      path,
      before: encoder.encode(before),
      after: encoder.encode(after),
    })),
    pool: [],
    deadline: null,
  });
}

/** The files of `edits` as the change list names them: all modified. */
const modifiedFiles = (edits: readonly Edit[]): { path: string; status: string }[] =>
  edits.map(({ path }) => ({ path, status: "modified" }));

/** The participant values altered by these edits, all modified and none cosmetic. */
function alteredBy(edits: readonly Edit[]): number | null {
  return participantValuesAltered(summaryOf(edits), modifiedFiles(edits), new Set());
}

const PARTICIPANTS_TSV = "participants.tsv";
const PARTICIPANTS_JSON = "participants.json";
const NO_COSMETIC: ReadonlySet<string> = new Set();

/** A participants table of subjects with a `sex` column, one row per value. */
const sexTable = (...values: string[]): string =>
  tsv(["participant_id", "sex"], ...values.map((value, i) => [`sub-0${i + 1}`, value]));

describe("which kinds alter a participant value", () => {
  test("the participant files are the two root names", () => {
    expect([...PARTICIPANT_FILES]).toEqual(["participants.tsv", "participants.json"]);
  });

  test("the table has an entry for every kind, and exactly the seven value kinds are true", () => {
    expect(Object.keys(ALTERS_PARTICIPANT_VALUE).sort()).toEqual([...CLASS_KINDS].sort());
    const altering = CLASS_KINDS.filter((kind) => ALTERS_PARTICIPANT_VALUE[kind]);
    const expected: ClassKind[] = [
      "cell_replaced",
      "cell_templated",
      "key_relabeled",
      "cell_emptied",
      "json_value_changed",
      "json_emptied",
      "json_type_changed",
    ];
    expect([...altering].sort()).toEqual(expected.sort());
    for (const kind of CLASS_KINDS) {
      expect(typeof ALTERS_PARTICIPANT_VALUE[kind], kind).toBe("boolean");
    }
  });

  test("a value kind is a modification, and no loss, relocated or additive kind is one", () => {
    for (const kind of CLASS_KINDS) {
      if (ALTERS_PARTICIPANT_VALUE[kind]) expect(ROLE_OF[kind], kind).toBe("modification");
      if (ROLE_OF[kind] !== "modification")
        expect(ALTERS_PARTICIPANT_VALUE[kind], kind).toBe(false);
    }
  });
});

describe("participantValuesAltered: participants.tsv", () => {
  test("None changed to F is one value per changed cell", () => {
    const one: Edit = {
      path: PARTICIPANTS_TSV,
      before: sexTable("None", "M"),
      after: sexTable("F", "M"),
    };
    expect(summaryOf([one]).classes.map((c) => c.kind)).toEqual(["cell_replaced"]);
    expect(alteredBy([one])).toBe(1);
    expect(
      alteredBy([
        {
          path: PARTICIPANTS_TSV,
          before: sexTable("None", "None", "None"),
          after: sexTable("F", "F", "F"),
        },
      ]),
    ).toBe(3);
  });

  test("n/a changed to F, or an empty cell filled, adds a value and alters none", () => {
    for (const missing of ["n/a", ""]) {
      const edit: Edit = {
        path: PARTICIPANTS_TSV,
        before: sexTable(missing, "M"),
        after: sexTable("F", "M"),
      };
      expect(
        summaryOf([edit]).classes.map((c) => c.kind),
        missing,
      ).toEqual(["cell_filled"]);
      expect(alteredBy([edit]), missing).toBe(0);
    }
  });

  test("a value emptied counts, because the author's value is gone", () => {
    const edit: Edit = {
      path: PARTICIPANTS_TSV,
      before: sexTable("F", "M"),
      after: sexTable("n/a", "M"),
    };
    expect(summaryOf([edit]).classes.map((c) => c.kind)).toEqual(["cell_emptied"]);
    expect(alteredBy([edit])).toBe(1);
  });

  test("a participant id re-padded counts: the row is the same person under another name", () => {
    const edit: Edit = {
      path: PARTICIPANTS_TSV,
      before: tsv(["participant_id", "sex"], ["sub-1", "F"], ["sub-2", "M"]),
      after: tsv(["participant_id", "sex"], ["sub-01", "F"], ["sub-02", "M"]),
    };
    expect(summaryOf([edit]).classes.map((c) => c.kind)).toEqual(["key_relabeled"]);
    expect(alteredBy([edit])).toBe(2);
  });

  test("cells rewritten by one rule count, one per cell", () => {
    const edit: Edit = {
      path: PARTICIPANTS_TSV,
      before: tsv(["participant_id", "site"], ["sub-01", "S1"], ["sub-02", "S2"], ["sub-03", "S3"]),
      after: tsv(
        ["participant_id", "site"],
        ["sub-01", "S01"],
        ["sub-02", "S02"],
        ["sub-03", "S03"],
      ),
    };
    expect(summaryOf([edit]).classes.map((c) => c.kind)).toEqual(["cell_templated"]);
    expect(alteredBy([edit])).toBe(3);
  });

  test("a new row and a new column add values and alter none", () => {
    const edit: Edit = {
      path: PARTICIPANTS_TSV,
      before: sexTable("F"),
      after: tsv(["participant_id", "sex", "age"], ["sub-01", "F", "30"], ["sub-02", "M", "31"]),
    };
    expect(
      summaryOf([edit])
        .classes.map((c) => c.kind)
        .sort(),
    ).toEqual(["column_added", "row_added"]);
    expect(alteredBy([edit])).toBe(0);
  });

  test("a removal is Part A's loss fact and not counted here", () => {
    const edit: Edit = {
      path: PARTICIPANTS_TSV,
      before: tsv(["participant_id", "sex", "age"], ["sub-01", "F", "3"], ["sub-02", "M", "4"]),
      after: tsv(["participant_id", "sex"], ["sub-01", "F"]),
    };
    expect(
      summaryOf([edit])
        .classes.map((c) => c.kind)
        .sort(),
    ).toEqual(["column_removed", "row_removed"]);
    expect(alteredBy([edit])).toBe(0);
  });

  test("a reorder or a layout change keeps every value", () => {
    const rows = tsv(["participant_id", "sex"], ["sub-01", "F"], ["sub-02", "M"]);
    const reordered = tsv(["participant_id", "sex"], ["sub-02", "M"], ["sub-01", "F"]);
    const crlf = rows.replace(/\n/g, "\r\n");
    for (const after of [reordered, crlf]) {
      const edit: Edit = { path: PARTICIPANTS_TSV, before: rows, after };
      expect(summaryOf([edit]).classes.length).toBe(1);
      expect(alteredBy([edit])).toBe(0);
    }
  });

  test("a cell replaced and a value added in one file count only the replaced one", () => {
    expect(
      alteredBy([
        {
          path: PARTICIPANTS_TSV,
          before: sexTable("None", "n/a", "M"),
          after: sexTable("F", "F", "M"),
        },
      ]),
    ).toBe(1);
  });
});

describe("participantValuesAltered: participants.json", () => {
  const levels = (female: string, male: string): string =>
    json({ sex: { Description: "sex", Levels: { M: male, F: female } } });

  test("a Levels entry rewritten counts", () => {
    const edit: Edit = {
      path: PARTICIPANTS_JSON,
      before: levels("female", "male"),
      after: levels("female", "Male"),
    };
    expect(summaryOf([edit]).classes.map((c) => c.kind)).toEqual(["json_value_changed"]);
    expect(alteredBy([edit])).toBe(1);
    expect(
      alteredBy([
        {
          path: PARTICIPANTS_JSON,
          before: levels("female", "male"),
          after: levels("Female", "Male"),
        },
      ]),
    ).toBe(2);
  });

  test("a value whose type changed counts", () => {
    const edit: Edit = {
      path: PARTICIPANTS_JSON,
      before: json({ age: { Units: "years", MinValue: 0 } }),
      after: json({ age: { Units: "years", MinValue: "0" } }),
    };
    expect(summaryOf([edit]).classes.map((c) => c.kind)).toEqual(["json_type_changed"]);
    expect(alteredBy([edit])).toBe(1);
  });

  test("a description emptied counts", () => {
    const edit: Edit = {
      path: PARTICIPANTS_JSON,
      before: json({ age: { Description: "age in years" } }),
      after: json({ age: { Description: "" } }),
    };
    expect(summaryOf([edit]).classes.map((c) => c.kind)).toEqual(["json_emptied"]);
    expect(alteredBy([edit])).toBe(1);
  });

  test("a value filled, a key added, a key removed or renamed, and a reorder do not count", () => {
    const edits: [ClassKind, Edit][] = [
      [
        "json_filled",
        {
          path: PARTICIPANTS_JSON,
          before: json({ age: { Description: "" } }),
          after: json({ age: { Description: "age in years" } }),
        },
      ],
      [
        "json_key_added",
        {
          path: PARTICIPANTS_JSON,
          before: json({ age: { Description: "age" } }),
          after: json({ age: { Description: "age", Units: "years" } }),
        },
      ],
      [
        "json_key_removed",
        {
          path: PARTICIPANTS_JSON,
          before: json({ age: { Description: "age", Units: "years" } }),
          after: json({ age: { Description: "age" } }),
        },
      ],
      [
        "json_key_renamed",
        {
          path: PARTICIPANTS_JSON,
          before: json({ sex: { Levels: { M: "male" } } }),
          after: json({ sex: { Levels: { m: "male" } } }),
        },
      ],
      [
        "json_empty_key_removed",
        {
          path: PARTICIPANTS_JSON,
          before: json({ age: { Description: "age", Units: "" } }),
          after: json({ age: { Description: "age" } }),
        },
      ],
      [
        "json_keys_reordered",
        {
          path: PARTICIPANTS_JSON,
          before: json({ a: { Description: "x" }, b: { Description: "y" } }),
          after: json({ b: { Description: "y" }, a: { Description: "x" } }),
        },
      ],
    ];
    for (const [kind, edit] of edits) {
      expect(
        summaryOf([edit]).classes.map((c) => c.kind),
        kind,
      ).toEqual([kind]);
      expect(alteredBy([edit]), kind).toBe(0);
    }
  });
});

describe("participantValuesAltered: which files and which summaries", () => {
  const tsvEdit: Edit = {
    path: PARTICIPANTS_TSV,
    before: sexTable("None", "M"),
    after: sexTable("F", "M"),
  };
  const jsonEdit: Edit = {
    path: PARTICIPANTS_JSON,
    before: json({ sex: { Levels: { M: "male" } } }),
    after: json({ sex: { Levels: { M: "Male" } } }),
  };

  test("both files together are summed, and a nested participants file is not a root file", () => {
    const nested: Edit = { ...tsvEdit, path: "sub-01/participants.tsv" };
    const both = [tsvEdit, jsonEdit];
    expect(alteredBy(both)).toBe(2);
    // The nested file's class has another shape and adds nothing.
    const summary = summaryOf([...both, nested]);
    expect(summary.classes.map((c) => c.shape).sort()).toEqual([
      "participants.json",
      "participants.tsv",
      "sub-*/participants.tsv",
    ]);
    expect(participantValuesAltered(summary, modifiedFiles([...both, nested]), NO_COSMETIC)).toBe(
      2,
    );
    expect(alteredBy([nested])).toBe(0);
    // Other tables named like it, or below another directory, are not root files either.
    for (const path of [
      "Participants.tsv",
      "participants_old.tsv",
      "ses-01/participants.tsv",
      "derivatives/participants.tsv",
      "participants.json.tsv",
    ]) {
      expect(alteredBy([{ ...tsvEdit, path }]), path).toBe(0);
    }
    for (const path of ["Participants.json", "derivatives/participants.json"]) {
      expect(alteredBy([{ ...jsonEdit, path }]), path).toBe(0);
    }
  });

  test("a nested participants file is not one the summary has to have seen", () => {
    const changes = [{ path: "sub-01/participants.tsv", status: "modified" }];
    expect(participantValuesAltered(EMPTY_SUMMARY, changes, NO_COSMETIC)).toBe(0);
    const typechange = [{ path: "sub-01/participants.tsv", status: "typechange" }];
    expect(participantValuesAltered(EMPTY_SUMMARY, typechange, NO_COSMETIC)).toBe(0);
  });

  test("a participants file the summary refused is unknown, not zero", () => {
    const ragged: Edit = {
      path: PARTICIPANTS_TSV,
      before: sexTable("F"),
      after: "participant_id\tsex\nsub-01\tF\textra\n",
    };
    const summary = summaryOf([ragged]);
    expect(summary.files.map((f) => f.refusal)).toEqual(["ragged_row"]);
    expect(participantValuesAltered(summary, modifiedFiles([ragged]), NO_COSMETIC)).toBeNull();
    // A JSON file that does not parse is refused the same way.
    const broken: Edit = { path: PARTICIPANTS_JSON, before: json({ a: 1 }), after: '{"a": 1,}' };
    expect(alteredBy([broken])).toBeNull();
    // One refused file makes the count unknown even when the other file's count is clear.
    expect(alteredBy([tsvEdit, broken])).toBeNull();
    // A refusal elsewhere is not a participants file's: it does not make the count unknown.
    const elsewhere: Edit = { path: "events.tsv", before: "a\tb\n1\t2\n", after: "a\tb\n1\n" };
    const withOther = summaryOf([tsvEdit, elsewhere]);
    expect(withOther.files.map((f) => f.refusal)).toContain("ragged_row");
    expect(participantValuesAltered(withOther, modifiedFiles([tsvEdit]), NO_COSMETIC)).toBe(1);
  });

  test("a participants file modified twice in one list is refused whole, and so unknown", () => {
    const summary = summaryOf([tsvEdit, tsvEdit]);
    expect(summary.files.map((f) => f.refusal)).toEqual(["internal_mismatch", "internal_mismatch"]);
    expect(participantValuesAltered(summary, modifiedFiles([tsvEdit]), NO_COSMETIC)).toBeNull();
  });

  test("two outcomes for one participants file, one of them refused, are unknown", () => {
    // Built from two real summaries, so each outcome is one the summary really gives: the file read
    // once cleanly and once refused. Any refusal among a path's outcomes makes the count unknown.
    const clean = summaryOf([tsvEdit]);
    const ragged = summaryOf([
      {
        path: PARTICIPANTS_TSV,
        before: sexTable("F"),
        after: "participant_id\tsex\nsub-01\tF\tx\n",
      },
    ]);
    expect(clean.files.map((f) => f.refusal)).toEqual([null]);
    expect(ragged.files.map((f) => f.refusal)).toEqual(["ragged_row"]);
    for (const files of [
      [...clean.files, ...ragged.files],
      [...ragged.files, ...clean.files],
    ]) {
      const both: ChangeSummary = { ...clean, files };
      expect(participantValuesAltered(both, modifiedFiles([tsvEdit]), NO_COSMETIC)).toBeNull();
    }
  });

  test("an abandoned summary is unknown, however it was made", () => {
    const past = summarizeChanges({
      candidates: [
        {
          path: PARTICIPANTS_TSV,
          before: encoder.encode(tsvEdit.before),
          after: encoder.encode(tsvEdit.after),
        },
      ],
      pool: [],
      deadline: 0,
      now: () => 0,
    });
    expect(past.abandoned).toBe(true);
    expect(participantValuesAltered(past, modifiedFiles([tsvEdit]), NO_COSMETIC)).toBeNull();
    expect(
      participantValuesAltered(ABANDONED_SUMMARY, modifiedFiles([tsvEdit]), NO_COSMETIC),
    ).toBeNull();
    // Even a pull request that touches no participants file has no count from a summary not made.
    expect(participantValuesAltered(ABANDONED_SUMMARY, [], NO_COSMETIC)).toBeNull();
    expect(participantValuesAltered(past, [], new Set([PARTICIPANTS_TSV]))).toBeNull();
  });

  test("a participants file the summary never saw is unknown, unless it is cosmetic", () => {
    for (const path of PARTICIPANT_FILES) {
      const changes = [{ path, status: "modified" }];
      // The summary holds no outcome for it: it was not a candidate, or not read.
      expect(participantValuesAltered(EMPTY_SUMMARY, changes, NO_COSMETIC), path).toBeNull();
      expect(
        participantValuesAltered(
          summaryOf([{ ...tsvEdit, path: "events.tsv" }]),
          changes,
          NO_COSMETIC,
        ),
        path,
      ).toBeNull();
      // The platform proved it differs only in layout: there is nothing to count.
      expect(participantValuesAltered(EMPTY_SUMMARY, changes, new Set([path])), path).toBe(0);
    }
    // One file seen and the other not is unknown; with the other cosmetic it is the seen count.
    const seen = summaryOf([tsvEdit]);
    const both = [
      { path: PARTICIPANTS_TSV, status: "modified" },
      { path: PARTICIPANTS_JSON, status: "modified" },
    ];
    expect(participantValuesAltered(seen, both, NO_COSMETIC)).toBeNull();
    expect(participantValuesAltered(seen, both, new Set([PARTICIPANTS_JSON]))).toBe(1);
    // A cosmetic path that is not a participants file excuses nothing.
    expect(participantValuesAltered(seen, both, new Set(["events.tsv"]))).toBeNull();
  });

  test("a cosmetic file is zero even if the summary refused it", () => {
    const ragged: Edit = {
      path: PARTICIPANTS_TSV,
      before: "participant_id\tsex\nsub-01\tF\textra\n",
      after: "participant_id\tsex\r\nsub-01\tF\textra\r\n",
    };
    const summary = summaryOf([ragged]);
    expect(summary.files[0]?.refusal).not.toBeNull();
    const changes = modifiedFiles([ragged]);
    expect(participantValuesAltered(summary, changes, new Set([PARTICIPANTS_TSV]))).toBe(0);
    expect(participantValuesAltered(summary, changes, NO_COSMETIC)).toBeNull();
  });

  test("a type change of a root participants file is unknown, cosmetic or not", () => {
    const seen = summaryOf([jsonEdit]);
    for (const path of PARTICIPANT_FILES) {
      const changes = [{ path, status: "typechange" }];
      expect(participantValuesAltered(seen, changes, NO_COSMETIC), path).toBeNull();
      expect(participantValuesAltered(seen, changes, new Set([path])), path).toBeNull();
    }
  });

  test("a participants file added or removed alters no recorded value, and is never unknown for it", () => {
    for (const status of ["added", "removed"]) {
      for (const path of PARTICIPANT_FILES) {
        expect(
          participantValuesAltered(EMPTY_SUMMARY, [{ path, status }], NO_COSMETIC),
          `${status} ${path}`,
        ).toBe(0);
      }
    }
    // Beside a modified file that was summarized, the count is that file's alone.
    const changes = [
      { path: PARTICIPANTS_TSV, status: "modified" },
      { path: PARTICIPANTS_JSON, status: "removed" },
    ];
    expect(participantValuesAltered(summaryOf([tsvEdit]), changes, NO_COSMETIC)).toBe(1);
  });

  test("nothing changed in any participants file is zero, whatever else the pull request did", () => {
    const events: Edit = { path: "events.tsv", before: "a\tb\n1\t2\n", after: "a\tb\n1\t3\n" };
    const summary = summaryOf([events]);
    expect(summary.classes.length).toBeGreaterThan(0);
    expect(participantValuesAltered(summary, modifiedFiles([events]), NO_COSMETIC)).toBe(0);
    expect(participantValuesAltered(EMPTY_SUMMARY, [], NO_COSMETIC)).toBe(0);
  });
});

/** The builder's input for a pull request that changed nothing, for each test to fill in. */
function contentInput(over: Partial<OriginalContentInput> = {}): OriginalContentInput {
  return {
    changes: [],
    documents: { readme: { base: [], head: [] }, changes: { base: [], head: [] } },
    anchor: null,
    anchorLookup: "not_needed",
    description: { before: "absent", after: "absent" },
    recordings: [],
    summary: EMPTY_SUMMARY,
    cosmetic: NO_COSMETIC,
    ...over,
  };
}

/** One changed path as the content pass lists it. */
const modified = (path: string): { path: string; status: RecordingChange["status"] } => ({
  path,
  status: "modified",
});

/** The facts a compared document holds, or a failed expectation naming what it was instead. */
function comparedFacts(result: DocumentResult): ProseFacts {
  if (result.status !== "compared") throw new Error(`not compared: ${result.status}`);
  return result.facts;
}

describe("originalContentFacts: the documents", () => {
  const base = parts({ "README.md": ORIGINAL });
  const removed = parts({ "README.md": edited((lines) => lines.splice(7, 2)) });

  test("a document no part of which changed is unchanged and never read, whatever its parts hold", () => {
    // Parts that could not be read, and would be refused if they were compared.
    const unreadable: DocumentPart[] = [
      { name: "README.md", mode: "100644", oid: "a".repeat(40), content: "unreadable" },
    ];
    const facts = originalContentFacts(
      contentInput({
        changes: [modified("sub-01/eeg/sub-01_task-rest_eeg.json"), modified("docs/README.md")],
        documents: {
          readme: { base: unreadable, head: unreadable },
          changes: { base: unreadable.map((p) => ({ ...p, name: "CHANGES" })), head: [] },
        },
      }),
    );
    expect(facts.readme).toEqual({ status: "unchanged" });
    expect(facts.changes).toEqual({ status: "unchanged" });
    // The same parts, with the README changed: compared, so refused.
    const changed = originalContentFacts(
      contentInput({
        changes: [modified("README.md")],
        documents: {
          readme: { base: unreadable, head: unreadable },
          changes: { base: [], head: [] },
        },
      }),
    );
    expect(changed.readme).toEqual({ status: "refused", refusal: "unreadable" });
    expect(changed.changes).toEqual({ status: "unchanged" });
  });

  test("a changed document is compared once, from the merge base to the head, as proseFacts compares it", () => {
    const facts = originalContentFacts(
      contentInput({
        changes: [modified("README.md")],
        documents: { readme: { base, head: removed }, changes: { base: [], head: [] } },
      }),
    );
    const direct = proseFacts({ document: "readme", base, head: removed, anchor: null });
    expect(direct.ok).toBe(true);
    expect(facts.readme).toEqual({
      status: "compared",
      facts: direct.ok ? direct.facts : untouched(0),
    });
    expect(comparedFacts(facts.readme).protectedAltered).toBe(2);
    expect(facts.abandoned).toBe(false);
  });

  test("a part added or removed beside an unchanged one changes the document", () => {
    const head = [...base, part("README.txt", "A note added beside the README.\n")];
    const facts = originalContentFacts(
      contentInput({
        changes: [{ path: "README.txt", status: "added" }],
        documents: { readme: { base, head }, changes: { base: [], head: [] } },
      }),
    );
    expect(comparedFacts(facts.readme)).toMatchObject({ partsBefore: 1, partsAfter: 2 });
  });

  test("a refused document says its closed word", () => {
    const binary = parts({ "README.md": new Uint8Array([0x61, 0x00, 0x62]) });
    const cases: [DocumentPart[], DocumentPart[], ProseRefusal][] = [
      [base, binary, "binary"],
      [base, [{ ...(base[0] as DocumentPart), mode: "120000" }], "not_regular"],
      [[{ ...(base[0] as DocumentPart), content: "unreadable" }], removed, "unreadable"],
    ];
    for (const [before, after, refusal] of cases) {
      const facts = originalContentFacts(
        contentInput({
          changes: [modified("README.md")],
          documents: { readme: { base: before, head: after }, changes: { base: [], head: [] } },
        }),
      );
      expect(facts.readme, refusal).toEqual({ status: "refused", refusal });
    }
  });

  test("the anchor protects the README alone: CHANGES keeps every merge-base line", () => {
    // Lines 7 and 8 were added after the anchor: removing them is later text, not original text.
    const anchor = parts({ "README.md": edited((lines) => lines.splice(6, 3)) });
    const changesBase = parts({ CHANGES: "1.1.0\n - Added sub-03\n1.0.0\n - Initial release\n" });
    const changesHead = parts({ CHANGES: "1.1.0\n - Added sub-03\n1.0.0\n" });
    const input = contentInput({
      changes: [modified("README.md"), modified("CHANGES")],
      documents: {
        readme: { base, head: removed },
        changes: { base: changesBase, head: changesHead },
      },
      anchor,
      anchorLookup: "first_version_tag",
    });
    const facts = originalContentFacts(input);
    expect(facts.anchorLookup).toBe("first_version_tag");
    expect(comparedFacts(facts.readme)).toMatchObject({
      anchor: "first_version_tag",
      protectedAltered: 0,
      laterAltered: 2,
    });
    expect(comparedFacts(facts.changes)).toMatchObject({
      anchor: "merge_base",
      protectedLines: 4,
      protectedAltered: 1,
    });
    // With no anchor the same README removal is original text.
    const strict = originalContentFacts({ ...input, anchor: null, anchorLookup: "no_tag" });
    expect(strict.anchorLookup).toBe("no_tag");
    expect(comparedFacts(strict.readme)).toMatchObject({
      anchor: "merge_base",
      protectedAltered: 2,
      laterAltered: 0,
    });
    expect(strict.changes).toEqual(facts.changes);
    expect(facts.paths).toEqual({ readme: "README.md", changes: "CHANGES", participants: null });
  });

  test("a finding's README is the part the platform showed at the merge base; CHANGES its first part", () => {
    const head = (names: string[]) => names.map((name) => part(name, "Text.\n"));
    const pathsOf = (base: string[], changesBase: string[], changed: string[]) =>
      originalContentFacts(
        contentInput({
          changes: changed.map(modified),
          documents: {
            readme: { base: head(base), head: head(base) },
            changes: { base: head(changesBase), head: head(changesBase) },
          },
        }),
      ).paths;
    // README.md comes before README in the platform's order, whatever the code-unit order says.
    expect(
      pathsOf(["README", "README.md"], ["CHANGES.md", "CHANGELOG"], ["README", "CHANGES.md"]),
    ).toEqual({ readme: "README.md", changes: "CHANGELOG", participants: null });
    // A README the platform does not show (a lower-case name) is still the README: its first part
    // is named, never CHANGES.
    expect(pathsOf(["readme.md"], ["CHANGES"], ["readme.md"])).toEqual({
      readme: "readme.md",
      changes: null,
      participants: null,
    });
    expect(pathsOf(["readme.txt", "readme.md"], [], ["readme.txt"]).readme).toBe("readme.md");
    // No README part at the merge base at all: nothing to point at.
    expect(pathsOf([], [], ["README.md"]).readme).toBeNull();
    // A document that did not change names nothing, even when it has parts.
    expect(pathsOf(["README.md"], ["CHANGES"], ["sub-01/eeg/x.json"])).toEqual({
      readme: null,
      changes: null,
      participants: null,
    });
  });
});

describe("originalContentFacts: every lookup word protects", () => {
  test("whatever the tag lookup came to, a changed README and CHANGES are compared from the merge base when there is no anchor", () => {
    const base = parts({ "README.md": ORIGINAL });
    const removed = parts({ "README.md": edited((lines) => lines.splice(7, 2)) });
    const changesBase = parts({ CHANGES: "1.1.0\n - Added sub-03\n1.0.0\n - Initial release\n" });
    const changesHead = parts({ CHANGES: "1.1.0\n - Added sub-03\n1.0.0\n - First release\n" });
    const texts = contentInput({
      changes: [modified("README.md"), modified("CHANGES")],
      documents: {
        readme: { base, head: removed },
        changes: { base: changesBase, head: changesHead },
      },
    });
    // A lookup that found no tag at all is no exception: no word lifts the protection.
    for (const word of ANCHOR_LOOKUPS) {
      const facts = originalContentFacts({ ...texts, anchorLookup: word });
      expect([facts.readme.status, facts.changes.status], word).toEqual(["compared", "compared"]);
      expect(comparedFacts(facts.readme), word).toMatchObject({
        anchor: "merge_base",
        protectedAltered: 2,
      });
      expect(comparedFacts(facts.changes).protectedAltered, word).toBe(1);
    }
  });
});

describe("originalContentFacts: the description, the participants and the recordings", () => {
  const before = description(DESCRIPTION);
  const renamed = changed({ Name: "A new name" });

  test("the author fields are compared only when dataset_description.json changed", () => {
    const sides = { before, after: renamed };
    expect(originalContentFacts(contentInput({ description: sides })).authorFields).toBeNull();
    expect(
      originalContentFacts(
        contentInput({ changes: [modified("dataset_description.json")], description: sides }),
      ).authorFields,
    ).toEqual(noFieldChange({ altered: ["Name"] }));
    // Added, with nothing before it: every key it holds is added.
    expect(
      originalContentFacts(
        contentInput({
          changes: [{ path: "dataset_description.json", status: "added" }],
          description: { before: "absent", after: before },
        }),
      ).authorFields,
    ).toEqual(authorFieldFacts("absent", before));
    // A side that could not be read is unparsed, never clean.
    expect(
      originalContentFacts(
        contentInput({
          changes: [modified("dataset_description.json")],
          description: { before: "unreadable", after: renamed },
        }),
      ).authorFields,
    ).toEqual(noFieldChange({ unparsed: true }));
  });

  test("an abandoned summary with no participants file changed counts 0, not unknown", () => {
    const facts = originalContentFacts(
      contentInput({
        changes: [modified("README.md"), { path: PARTICIPANTS_TSV, status: "added" }],
        documents: {
          readme: { base: parts({ "README.md": "a\n" }), head: parts({ "README.md": "a\nb\n" }) },
          changes: { base: [], head: [] },
        },
        summary: ABANDONED_SUMMARY,
      }),
    );
    expect(facts.participantValues).toBe(0);
    // The module's own count would be unknown for the same summary: the guard is the builder's.
    expect(participantValuesAltered(ABANDONED_SUMMARY, [], NO_COSMETIC)).toBeNull();
  });

  test("a root participants file modified or changed type is counted, and unknown when it cannot be", () => {
    for (const path of PARTICIPANT_FILES) {
      for (const status of ["modified", "typechange"] as const) {
        const facts = originalContentFacts(
          contentInput({ changes: [{ path, status }], summary: ABANDONED_SUMMARY }),
        );
        expect(facts.participantValues, `${status} ${path}`).toBeNull();
      }
      // Removed: Part A's loss fact, and no value is asked about.
      expect(
        originalContentFacts(
          contentInput({ changes: [{ path, status: "removed" }], summary: ABANDONED_SUMMARY }),
        ).participantValues,
      ).toBe(0);
    }
    // The first participants file modified or retyped is the one a finding names.
    expect(
      originalContentFacts(
        contentInput({
          changes: [
            { path: PARTICIPANTS_TSV, status: "added" },
            { path: PARTICIPANTS_JSON, status: "typechange" },
          ],
        }),
      ).paths.participants,
    ).toBe(PARTICIPANTS_JSON);
    expect(
      originalContentFacts(
        contentInput({ changes: [modified(PARTICIPANTS_JSON), modified(PARTICIPANTS_TSV)] }),
      ).paths.participants,
    ).toBe(PARTICIPANTS_TSV);
    // A summary that read the file counts its changed values.
    const edit: Edit = {
      path: PARTICIPANTS_TSV,
      before: sexTable("None", "M"),
      after: sexTable("F", "M"),
    };
    expect(
      originalContentFacts(
        contentInput({ changes: [modified(PARTICIPANTS_TSV)], summary: summaryOf([edit]) }),
      ).participantValues,
    ).toBe(1);
    // One the platform proved cosmetic has nothing to count, even unread.
    expect(
      originalContentFacts(
        contentInput({
          changes: [modified(PARTICIPANTS_TSV)],
          cosmetic: new Set([PARTICIPANTS_TSV]),
        }),
      ).participantValues,
    ).toBe(0);
    // A nested participants file is no root file: not asked, so 0 even from an abandoned summary.
    expect(
      originalContentFacts(
        contentInput({
          changes: [modified(`sub-01/${PARTICIPANTS_TSV}`)],
          summary: ABANDONED_SUMMARY,
        }),
      ).participantValues,
    ).toBe(0);
  });

  test("a finding names the participants file whose values were counted, not the first modified", () => {
    // participants.tsv only gains a row (nothing counted); participants.json has a value changed.
    const tsvRowAdded: Edit = {
      path: PARTICIPANTS_TSV,
      before: sexTable("M"),
      after: sexTable("M", "F"),
    };
    const jsonValue: Edit = {
      path: PARTICIPANTS_JSON,
      before: json({ sex: { Description: "sex" } }),
      after: json({ sex: { Description: "biological sex" } }),
    };
    const facts = originalContentFacts(
      contentInput({
        changes: [modified(PARTICIPANTS_TSV), modified(PARTICIPANTS_JSON)],
        summary: summaryOf([tsvRowAdded, jsonValue]),
      }),
    );
    expect(facts.participantValues).toBe(1);
    expect(facts.paths.participants).toBe(PARTICIPANTS_JSON);
  });

  test("the file named is a participants file even when a class of another file comes first", () => {
    // Two events files with the same cell replaced: one class over two files, which the summary
    // orders before the participants class of one file.
    const events = (subject: string): Edit => ({
      path: `${subject}/eeg/${subject}_task-x_events.tsv`,
      before: tsv(["onset", "trial_type"], ["1", "go"]),
      after: tsv(["onset", "trial_type"], ["1", "stop"]),
    });
    const tsvValue: Edit = {
      path: PARTICIPANTS_TSV,
      before: sexTable("None", "M"),
      after: sexTable("F", "M"),
    };
    const summary = summaryOf([events("sub-01"), events("sub-02"), tsvValue]);
    const first = summary.classes[0];
    expect(first?.shape).not.toBe(PARTICIPANTS_TSV);
    expect(first !== undefined && ALTERS_PARTICIPANT_VALUE[first.kind]).toBe(true);
    const facts = originalContentFacts(
      contentInput({
        changes: [modified(PARTICIPANTS_TSV), modified("sub-01/eeg/sub-01_task-x_events.tsv")],
        summary,
      }),
    );
    expect(facts.participantValues).toBe(1);
    expect(facts.paths.participants).toBe(PARTICIPANTS_TSV);
  });

  test("the recordings are recordingFacts of every changed path", () => {
    const recordings = [
      recording("sub-01/eeg/sub-01_task-x_eeg.edf", locked(keyOf(1)), locked(keyOf(2)), true),
      recording("derivatives/x/sub-02_eeg.edf", locked(keyOf(3)), null),
      recording("sub-02/eeg/sub-02_task-x_eeg.edf", null, locked(keyOf(3)), true),
      recording("sub-03/eeg/sub-03_task-x_eeg.edf", locked(keyOf(4)), plain("x", "unreadable")),
    ];
    const facts = originalContentFacts(
      contentInput({
        changes: recordings.map(({ path, status }) => ({ path, status })),
        recordings,
      }),
    );
    expect(facts.recordings).toEqual(noRecordingChange({ replaced: 1, moved: 1, unread: 1 }));
    expect(facts.recordings).toEqual(recordingFacts(recordings));
  });

  test("a pull request that changed nothing Part B reads has nothing to say", () => {
    expect(originalContentFacts(contentInput())).toEqual({
      abandoned: false,
      anchorLookup: "not_needed",
      readme: { status: "unchanged" },
      changes: { status: "unchanged" },
      authorFields: null,
      participantValues: 0,
      recordings: noRecordingChange(),
      paths: { readme: null, changes: null, participants: null },
    });
  });
});

describe("the facts of an abandoned pass", () => {
  test("ORIGINAL_ABANDONED holds nothing and says the anchor was never looked for", () => {
    expect(ORIGINAL_ABANDONED).toEqual({
      abandoned: true,
      anchorLookup: "not_looked_up",
      readme: { status: "unchanged" },
      changes: { status: "unchanged" },
      authorFields: null,
      participantValues: 0,
      recordings: noRecordingChange(),
      paths: { readme: null, changes: null, participants: null },
    });
  });

  test("it is frozen at every level, so no reader can change it for the next", () => {
    expect(Object.isFrozen(ORIGINAL_ABANDONED)).toBe(true);
    expect(Object.isFrozen(ORIGINAL_ABANDONED.readme)).toBe(true);
    expect(Object.isFrozen(ORIGINAL_ABANDONED.changes)).toBe(true);
    expect(Object.isFrozen(ORIGINAL_ABANDONED.recordings)).toBe(true);
    expect(Object.isFrozen(ORIGINAL_ABANDONED.paths)).toBe(true);
    const writable = ORIGINAL_ABANDONED as { -readonly [K in keyof OriginalContentFacts]: unknown };
    expect(() => {
      writable.abandoned = false;
    }).toThrow(TypeError);
    expect(() => {
      (ORIGINAL_ABANDONED.recordings as { unread: number }).unread = 1;
    }).toThrow(TypeError);
    expect(ORIGINAL_ABANDONED.abandoned).toBe(true);
    expect(ORIGINAL_ABANDONED.recordings.unread).toBe(0);
  });

  test("the anchor words are a closed list that holds every reason chooseAnchor gives", () => {
    expect(new Set(ANCHOR_LOOKUPS).size).toBe(ANCHOR_LOOKUPS.length);
    const reasons = [
      chooseAnchor([], () => true),
      chooseAnchor([versionTag("1", "0", "0", sha(1))], () => false),
      chooseAnchor([versionTag("1", "0", "0", sha(1))], () => null),
      chooseAnchor(
        Array.from({ length: ORIGINAL_LIMITS.maxTagsTried + 1 }, (_, i) =>
          versionTag("1", "0", String(i), sha(i + 1)),
        ),
        () => false,
      ),
    ].map((choice) => (choice.anchor === "merge_base" ? choice.reason : choice.anchor));
    expect(reasons).toEqual(["no_tag", "no_ancestor", "check_failed", "too_many_tags"]);
    for (const reason of reasons) expect(ANCHOR_LOOKUPS as readonly string[]).toContain(reason);
    expect(ANCHOR_LOOKUPS).toContain("first_version_tag");
    // Words a log prints: lower case and underscores only.
    for (const word of ANCHOR_LOOKUPS) expect(word).toMatch(/^[a-z_]+$/);
  });
});
