/**
 * The change model of the mechanical change summary (design `.context/plans/pr-review-change-summary.md`
 * sections 4, 6.2 and 12): the vocabulary of a change, the relabel rules, the relocation pools, and the
 * table and JSON diffs. Pure: real bytes go through the real `parseTsv` and `parseJson`, and nothing
 * here touches git or a file.
 *
 * The bar for this module is that a diff is TOTAL (every row, column and leaf lands in exactly one
 * bucket) and that every doubtful pairing fails toward more visible change or a loss fact, never
 * toward hiding content. The tests are written against that bar: they pin what each rule accepts,
 * and, as importantly, what it must not.
 */

import { describe, expect, test } from "bun:test";
import {
  type Atom,
  CLASS_KINDS,
  type ClassKind,
  type FileDiff,
  type JsonCounts,
  type JsonLeaf,
  type JsonValue,
  type PoolFile,
  ROLE_OF,
  type RelabelRule,
  SUMMARY_LIMITS,
  type Table,
  type TableCounts,
  buildPools,
  diffJson,
  diffJsonWith,
  diffTable,
  diffTableWith,
  flattenJson,
  formatAtoms,
  isMissingCell,
  isMissingJson,
  leafKey,
  parseJson,
  parseTsv,
  relabelRule,
  ruleWords,
  sidecarApplies,
  verifyJsonCounts,
  verifyTableCounts,
} from "../scripts/ci/pr-review-summary";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A parsed JSON value, for the truth tables of `isMissingJson`. */
function json(text: string) {
  const parsed = parseJson(enc(text));
  if (!parsed.ok) throw new Error(`test input is not JSON (${parsed.refusal}): ${text}`);
  return parsed.value.value;
}

describe("the vocabulary of a change", () => {
  test("the kinds are the table of design section 4.1, in table order, each once", () => {
    expect([...CLASS_KINDS]).toEqual([
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
    ]);
    expect(new Set(CLASS_KINDS).size).toBe(CLASS_KINDS.length);
    for (const kind of CLASS_KINDS) expect(kind).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  test("every kind has a role, and the roles are the design's", () => {
    const roles = new Set(["loss", "relocated", "modification", "additive"]);
    for (const kind of CLASS_KINDS) expect(roles.has(ROLE_OF[kind]), kind).toBe(true);
    // The record has no key that is not a kind either.
    expect(Object.keys(ROLE_OF).sort()).toEqual([...CLASS_KINDS].sort());

    const byRole = (role: string): ClassKind[] => CLASS_KINDS.filter((k) => ROLE_OF[k] === role);
    expect(byRole("loss")).toEqual(["column_removed", "row_removed", "json_key_removed"]);
    expect(byRole("relocated")).toEqual(["row_relocated", "json_key_moved"]);
    expect(byRole("additive")).toEqual([
      "column_added",
      "row_added",
      "cell_filled",
      "json_key_added",
      "json_filled",
    ]);
    // Everything else is a modification, including the removal of a key that held nothing.
    expect(byRole("modification")).toEqual([
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
    ]);
  });
});

describe("isMissingCell and isMissingJson are deliberately narrow", () => {
  test("a table cell is missing exactly when it is empty or n/a", () => {
    expect(isMissingCell("")).toBe(true);
    expect(isMissingCell("n/a")).toBe(true);
    for (const present of [
      "N/A",
      "NA",
      "na",
      "None",
      "none",
      "unknown",
      "null",
      "nan",
      "0",
      " ",
      "n/a ",
      " n/a",
      "-",
      "n/a\u{200B}",
    ]) {
      expect(isMissingCell(present), JSON.stringify(present)).toBe(false);
    }
  });

  test("a JSON value is missing exactly when it is null, an empty string, n/a, [] or {}, or an array of those", () => {
    for (const missing of [
      "null",
      '""',
      '"n/a"',
      "[]",
      "{}",
      "[null]",
      '[""]',
      '["n/a"]',
      "[[]]",
      "[{}]",
      '[null, "", "n/a", [], {}]',
      '[["n/a"], [null, [""]]]',
    ]) {
      expect(isMissingJson(json(missing)), missing).toBe(true);
    }
    for (const present of [
      "0",
      "false",
      "true",
      '"None"',
      '"unknown"',
      '"NA"',
      '"N/A"',
      '" "',
      '"n/a "',
      '{"a": null}',
      '{"a": ""}',
      '[null, "x"]',
      '["n/a", 0]',
      "[false]",
      '[[], "x"]',
      "[0]",
      "-0",
      "0.0",
    ]) {
      expect(isMissingJson(json(present)), present).toBe(false);
    }
  });

  test("a JSON array's missing-ness is decided by every element, however deep", () => {
    expect(isMissingJson(json("[[[[[[]]]]]]"))).toBe(true);
    expect(isMissingJson(json('[[[[[["x"]]]]]]'))).toBe(false);
  });
});

/** A rule with the fields spelled out, so an expectation reads as the rule it is. */
function rule(
  kind: RelabelRule["kind"],
  gaps: readonly string[] = [],
  shape = "",
  repadded = false,
): RelabelRule {
  return { kind, gaps, shape, repadded };
}

describe("relabelRule: one assertion per rule kind", () => {
  const cells = { chars: false };

  test("case: equal once lower-cased", () => {
    expect(relabelRule("Cz", "CZ", cells)).toEqual(rule("case"));
    expect(relabelRule("fp1", "FP1", cells)).toEqual(rule("case"));
    expect(relabelRule("Left Arm", "left arm", cells)).toEqual(rule("case"));
    // Case wins even where a run rule would also hold.
    expect(relabelRule("A_b", "a_B", cells)).toEqual(rule("case"));
  });

  test("repad: only the zero padding of a number changed", () => {
    expect(relabelRule("A01", "A1", cells)).toEqual(rule("repad", [], "", true));
    expect(relabelRule("A1", "A001", cells)).toEqual(rule("repad", [], "", true));
    expect(relabelRule("sub-001_ses-02", "sub-1_ses-2", cells)).toEqual(
      rule("repad", [], "", true),
    );
  });

  test("wrap: text was added before or after the value", () => {
    expect(relabelRule("Fp1", "EEG Fp1-Ref", cells)).toEqual(rule("wrap", ["EEG ", "-Ref"]));
    expect(relabelRule("Fz", "EEG Fz", cells)).toEqual(rule("wrap", ["EEG ", ""]));
    expect(relabelRule("Fz", "Fz-Ref", cells)).toEqual(rule("wrap", ["", "-Ref"]));
  });

  test("strip: text was removed from around the value", () => {
    expect(relabelRule("EEG Fp1-Ref", "Fp1", cells)).toEqual(rule("strip", ["EEG ", "-Ref"]));
    expect(relabelRule("EEG Fz", "Fz", cells)).toEqual(rule("strip", ["EEG ", ""]));
  });

  test("insert: text was added between the parts of the value", () => {
    expect(relabelRule("GA01", "EEGGA_01REF", cells)).toEqual(
      rule("insert", ["EEG", "_", "REF"], "LD"),
    );
    expect(relabelRule("a-1", "a-X-1", cells)).toEqual(rule("insert", ["", "", "X-", ""], "LOD"));
  });

  test("delete: text was removed from between the parts of the value", () => {
    expect(relabelRule("EEGGA_01REF", "GA01", cells)).toEqual(
      rule("delete", ["EEG", "_", "REF"], "LD"),
    );
    expect(relabelRule("a-X-1", "a-1", cells)).toEqual(rule("delete", ["", "", "X-", ""], "LOD"));
  });

  test("an insertion or a deletion is anchored: the name with fewer runs must hold a digit run", () => {
    // Letters alone are no anchor: Cz is in FCz and Pz in POz, and each is another electrode.
    for (const [a, b] of [
      ["Cz", "FCz"],
      ["Pz", "POz"],
      ["a-b", "a-X-b"],
      ["Fp", "F-x-p"],
    ] as const) {
      expect(relabelRule(a, b, cells), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(b, a, cells), `${b} -> ${a}`).toBeNull();
    }
    // A superscript two is a number character, so it anchors, though it is compared as its text.
    expect(relabelRule("x\u{B2}", "EEGx_\u{B2}REF", cells)).toEqual(
      rule("insert", ["EEG", "_", "REF"], "LD"),
    );
    // The anchor matches only a whole digit run of the same value.
    expect(relabelRule("GA01", "EEGGA_02REF", cells)).toBeNull();
    expect(relabelRule("GA1", "EEGGA_12REF", cells)).toBeNull();
    // The anchor still works when the digit run is repadded, and the rule says so.
    const repadded = relabelRule("GA01", "EEGGA_1REF", cells);
    expect(repadded).toEqual(rule("insert", ["EEG", "_", "REF"], "LD", true));
    expect(ruleWords(repadded as RelabelRule)).toBe(
      'inserted "EEG" at the start, "_" after run 1 and "REF" after run 2 (runs kept: letters, digits), zero padding of numbers changed',
    );
  });

  test("a letter run is matched where a run of the other name starts and ends, if it can be", () => {
    // ab is inside abx and also whole after the hyphen; the whole one is the one the rule keeps.
    expect(relabelRule("ab1c", "abx-ab_1c", cells)).toEqual(
      rule("insert", ["abx-", "_", "", ""], "LDL"),
    );
    // Only a start on a boundary is not enough: the end must be one too.
    expect(relabelRule("ab1c", "xab-ab_1c", cells)).toEqual(
      rule("insert", ["xab-", "_", "", ""], "LDL"),
    );
  });

  test("the character rule exists only when asked for, and then describes the longer string exactly", () => {
    expect(relabelRule("DCEMBRACE", "DC EMBRACE-REF", cells)).toBeNull();
    expect(relabelRule("DCEMBRACE", "DCEMBRACE-REF", { chars: true })).toEqual(
      rule("wrap", ["", "-REF"]),
    );
    expect(relabelRule("DCEMBRACE", "DC EMBRACE-REF", { chars: true })).toEqual(
      rule("insert", ["", "", " ", "", "", "", "", "", "", "-REF"], "c9"),
    );
    expect(relabelRule("DC EMBRACE-REF", "DCEMBRACE", { chars: true })).toEqual(
      rule("delete", ["", "", " ", "", "", "", "", "", "", "-REF"], "c9"),
    );
  });

  test("the run rules come before the character rule: asking for characters never changes a run answer", () => {
    for (const [a, b] of [
      ["Cz", "CZ"],
      ["A01", "A1"],
      ["Fp1", "EEG Fp1-Ref"],
      ["EEG Fz", "Fz"],
      ["GA01", "EEGGA_01REF"],
    ] as const) {
      expect(relabelRule(a, b, { chars: true }), `${a} -> ${b}`).toEqual(
        relabelRule(a, b, { chars: false }),
      );
    }
  });
});

describe("relabelRule: the real pairs from the open pull requests", () => {
  const cells = { chars: false };

  test("A1 becomes POL A01: a prefix, and the number kept its value but gained a zero", () => {
    expect(relabelRule("A1", "POL A01", cells)).toEqual(rule("wrap", ["POL ", ""], "", true));
  });

  test("GA01 becomes EEGGA_01REF: letters and digits kept in order, text added around and between", () => {
    expect(relabelRule("GA01", "EEGGA_01REF", cells)).toEqual(
      rule("insert", ["EEG", "_", "REF"], "LD"),
    );
  });

  test("DCEMBRACE becomes DC EMBRACE-REF only by characters", () => {
    expect(relabelRule("DCEMBRACE", "DC EMBRACE-REF", cells)).toBeNull();
    const byCharacters = relabelRule("DCEMBRACE", "DC EMBRACE-REF", { chars: true });
    expect(byCharacters?.kind).toBe("insert");
    expect(byCharacters?.shape).toBe("c9");
  });

  test("a name quoted and padded with spaces loses the padding: a strip of four spaces", () => {
    expect(relabelRule("'G1'    ", "'G1'", cells)).toEqual(rule("strip", ["", "    "]));
    expect(relabelRule("'G1'", "'G1'    ", cells)).toEqual(rule("wrap", ["", "    "]));
  });

  test("64 becomes 640 and A1 becomes A10: a changed number is not a rule", () => {
    // Both sides are plain numbers.
    expect(relabelRule("64", "640", { chars: false })).toBeNull();
    expect(relabelRule("64", "640", { chars: true })).toBeNull();
    // 1 is not 10, so no run rule holds; and the 0 would join the run 1, so no character rule.
    for (const chars of [false, true]) {
      expect(relabelRule("A1", "A10", { chars })).toBeNull();
      expect(relabelRule("A10", "A1", { chars })).toBeNull();
    }
  });

  test("the character rule inserts or deletes whole runs only: a name that changed a run is another name", () => {
    for (const [a, b] of [
      ["A1", "A10"],
      ["sub-2", "sub-12"],
      ["sub-1", "sub-10"],
      ["Cz", "FCz"],
      ["Pz", "POz"],
      ["Fp1", "Fpz1"],
    ] as const) {
      expect(relabelRule(a, b, { chars: true }), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(b, a, { chars: true }), `${b} -> ${a}`).toBeNull();
    }
    // The real one keeps: a space and -REF are whole runs of the new name, in both directions.
    expect(relabelRule("DC EMBRACE-REF", "DCEMBRACE", { chars: true })?.shape).toBe("c9");
    // A run inserted between two others, even in the middle of letters, is whole.
    expect(relabelRule("AB", "A-B", { chars: true })).toEqual(rule("insert", ["", "-", ""], "c2"));
    // Runs are counted in characters: two astral letters are two characters, not four units.
    expect(relabelRule("\u{10400}\u{10401}AB", "\u{10400}\u{10401} AB-X", { chars: true })).toEqual(
      rule("insert", ["", "", " ", "", "-X"], "c4"),
    );
  });
});

describe("relabelRule: a number is never put in, taken out, split or merged", () => {
  test("no rule of any kind when the added or removed text holds a digit", () => {
    for (const [a, b] of [
      ["A1", "A1-A2"],
      ["A2", "A1-A2"],
      ["T3", "T3-T5"],
      ["Fp1", "Fp1-F7"],
      ["E1", "E1-1"],
      ["x", "x2"],
      ["Cz", "Cz2"],
    ] as const) {
      for (const chars of [false, true]) {
        expect(relabelRule(a, b, { chars }), `${a} -> ${b}`).toBeNull();
        expect(relabelRule(b, a, { chars }), `${b} -> ${a}`).toBeNull();
      }
    }
    // Any number character counts, not only ASCII digits: a superscript two is a number.
    expect(relabelRule("Cz", "Cz\u{B2}", { chars: true })).toBeNull();
    expect(relabelRule("Cz", "\u{661}-Cz", { chars: true })).toBeNull();
    // Text without a digit is still a rule, whatever the name holds.
    expect(relabelRule("A01", "POL A01", { chars: false })).toEqual(rule("wrap", ["POL ", ""]));
    expect(relabelRule("1", "sub-1", { chars: false })).toEqual(rule("wrap", ["sub-", ""]));
    expect(relabelRule("sub-1", "1", { chars: false })).toEqual(rule("strip", ["sub-", ""]));
    expect(relabelRule("GA01", "EEGGA_01REF", { chars: false })?.kind).toBe("insert");
    expect(relabelRule("DCEMBRACE", "DC EMBRACE-REF", { chars: true })?.shape).toBe("c9");
  });

  test("the character rule never puts text between two digits that were one number, or takes it out", () => {
    for (const [a, b] of [
      ["LA12", "LA1-2"],
      ["LA12", "LA1-LA2"],
      ["E10", "E1.0"],
      ["E12", "E1.2"],
      ["sub-12", "sub-1-2"],
      ["E101", "E1-01"],
      ["E11", "E1-1"],
      ["A12", "A1 2"],
      ["Ch12", "Ch1_2"],
    ] as const) {
      expect(relabelRule(a, b, { chars: true }), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(b, a, { chars: true }), `${b} -> ${a}`).toBeNull();
    }
    // Text with a digit on one side only is not inside a number: before a letter, after a letter.
    expect(relabelRule("DC1", "D C1", { chars: true })).toEqual(
      rule("insert", ["", " ", "", ""], "c3"),
    );
    expect(relabelRule("DC1E", "D C1 E", { chars: true })).toEqual(
      rule("insert", ["", " ", "", " ", ""], "c4"),
    );
    expect(relabelRule("DC1", "D C 1", { chars: true })).toEqual(
      rule("insert", ["", " ", " ", ""], "c3"),
    );
  });
});

describe("relabelRule: numbers and nothing-to-say pairs never get a rule", () => {
  test("a pair of plain numbers has no rule, whatever the numbers look like", () => {
    for (const [a, b] of [
      ["64", "640"],
      ["1", "01"],
      ["01", "1"],
      ["1.5", "1.50"],
      ["-1", "1"],
      ["+1", "1"],
      [".5", "0.5"],
      ["1e5", "1E5"],
      ["1e5", "10e4"],
      ["100", "1000"],
      ["3.", "3"],
    ] as const) {
      expect(relabelRule(a, b, { chars: false }), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(a, b, { chars: true }), `${a} -> ${b}`).toBeNull();
    }
  });

  test("one number and one word is not a numeric pair", () => {
    // 5 against five: neither a case nor a run rule; with characters, 5 is not a subsequence of five.
    expect(relabelRule("5", "five", { chars: true })).toBeNull();
    // A number with a unit around it is a wrap, not a changed number.
    expect(relabelRule("5", "5 mm", { chars: false })).toEqual(rule("wrap", ["", " mm"]));
  });

  test("equal strings, empty strings and a pair with nothing in common have no rule", () => {
    expect(relabelRule("A", "A", { chars: true })).toBeNull();
    expect(relabelRule("", "A", { chars: true })).toBeNull();
    expect(relabelRule("A", "", { chars: true })).toBeNull();
    expect(relabelRule("", "", { chars: true })).toBeNull();
    expect(relabelRule("Cz", "Pz", { chars: true })).toBeNull();
    expect(relabelRule("left", "right", { chars: false })).toBeNull();
  });

  test("a value that changed a letter is not a prefix, a case change or a padding", () => {
    expect(relabelRule("A1", "B1", { chars: true })).toBeNull();
    expect(relabelRule("good", "bad", { chars: true })).toBeNull();
    expect(relabelRule("Fp1", "Fp2", { chars: true })).toBeNull();
  });

  test("digits next to a decimal point or comma compare as text: 0.05 to 0.5 is not a padding", () => {
    for (const [a, b] of [
      ["A1.05", "A1.5"],
      ["0.05 Hz", "0.5 Hz"],
      ["1.05mV", "1.5mV"],
      ["v1,05", "v1,5"],
      ["05.A", "5.A"],
      ["2020-01-01T10:00:00.050", "2020-01-01T10:00:00.5"],
    ] as const) {
      expect(relabelRule(a, b, { chars: false }), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(b, a, { chars: false }), `${b} -> ${a}`).toBeNull();
    }
    // Any other neighbor leaves the value comparison in place.
    expect(relabelRule("A01-x", "A1-x", { chars: false })).toEqual(rule("repad", [], "", true));
    expect(relabelRule("A01 Hz", "A1 Hz", { chars: false })).toEqual(rule("repad", [], "", true));
  });

  test("a digit run joined to another by separators alone compares as text: 1 000 to 1 0 is not a padding", () => {
    // One number written with a separator: a space, an apostrophe, an underscore, a middle dot,
    // the Arabic decimal separator. Each pair is a change of magnitude, never "zero padding".
    for (const [a, b] of [
      ["5 000", "5 0"],
      ["1 000 Hz", "1 0 Hz"],
      ["1'000", "1'0000"],
      ["1_000", "1_0000"],
      ["1 000", "1 0000"],
      ["0\u{B7}05 Hz", "0\u{B7}5 Hz"],
      ["1\u{66B}05", "1\u{66B}5"],
    ] as const) {
      for (const chars of [false, true]) {
        const forward = relabelRule(a, b, { chars });
        const backward = relabelRule(b, a, { chars });
        expect(forward?.kind, `${a} -> ${b}`).not.toBe("repad");
        expect(backward?.kind, `${b} -> ${a}`).not.toBe("repad");
        expect(forward?.repadded ?? false, `${a} -> ${b}`).toBe(false);
        expect(backward?.repadded ?? false, `${b} -> ${a}`).toBe(false);
      }
    }
    // Several separators in a row still join, and so does a run at either end of the string.
    expect(relabelRule("x1 - 05", "x1 - 5", { chars: false })).toBeNull();
    expect(relabelRule("05 1", "5 1", { chars: false })).toBeNull();
  });

  test("a decimal mark in either string makes the pair compare every digit as text, even when the mark is in the added text", () => {
    for (const [a, b] of [
      ["05 Hz", ".5 Hz"],
      ["A05", "A.5"],
      ["x 05 Hz", "x .5 Hz"],
      ["0050 Hz", "50, Hz"],
      // The other number of the string holds the mark: the pair is still compared as text.
      ["05 a 1.5", "5 a 1.5"],
      ["05 a 1 2", "5 a 1 2"],
    ] as const) {
      for (const chars of [false, true]) {
        expect(relabelRule(a, b, { chars }), `${a} -> ${b}`).toBeNull();
        expect(relabelRule(b, a, { chars }), `${b} -> ${a}`).toBeNull();
      }
    }
    // Compared as text, a rule that rebuilds the string exactly is still found, and it never says
    // a padding changed: `07 Hz` gained the prefix `.`, which the class line says.
    expect(relabelRule("07 Hz", ".07 Hz", { chars: false })).toEqual(rule("wrap", [".", ""]));
    // Neither string holds a mark or a join: the digits are compared by value, as before.
    expect(relabelRule("05 a 1", "5 a 1", { chars: false })).toEqual(rule("repad", [], "", true));
  });

  test("digits are read by value only among the allowed neighbors: no other mark, wherever it stands, lets a pair claim a padding", () => {
    const hidden: (readonly [string, string])[] = [
      // A mark at the edge of both strings.
      ["\u{66B}05 Hz", "\u{66B}5 Hz"],
      ["\u{FF0E}05 Hz", "\u{FF0E}5 Hz"],
      // A mark only in the text a rule would add, alone or with an invisible or a space after it.
      ["05 Hz", "\u{FF0E}5 Hz"],
      ["005", "\u{B7}5"],
      ["05 Hz", ".\u{2060}5 Hz"],
      ["05 Hz", ".\u{200B}5 Hz"],
      ["05 Hz", ".\u{AD}5 Hz"],
      ["05 Hz", ".\u{301}5 Hz"],
      ["05 Hz", ". 5 Hz"],
      // A letter, or a letter-like mark, inside one number.
      ["0\u{A78F}05 Hz", "0\u{A78F}5 Hz"],
      ["1\u{2BC}000 Hz", "1\u{2BC}0000 Hz"],
      ["1\u{2CC}000", "1\u{2CC}0000"],
      ["res-0p05mm", "res-0p5mm"],
      ["1e05", "1e5"],
      ["1x000 Hz", "1x0000 Hz"],
      ["1E0100", "1E100"],
      // A digit with no value this module vouches for anywhere in the string, around a plain one.
      ["Fp\u{663} EEG05", "Fp\u{663} EEG5"],
      ["Fp\u{B2} EEG05", "Fp\u{B2} EEG5"],
    ];
    for (const [a, b] of hidden) {
      for (const chars of [false, true]) {
        for (const [x, y] of [
          [a, b],
          [b, a],
        ] as const) {
          const found = relabelRule(x, y, { chars });
          const label = JSON.stringify([x, y, chars, found]);
          expect(found?.kind === "repad" || found?.repadded === true, label).toBe(false);
        }
      }
    }
  });

  test("the allowed neighbors keep every real padding: an edge, a separator, or letters that are not one letter between numbers", () => {
    for (const [a, b] of [
      ["sub-01", "sub-1"],
      ["sub-01_ses-02", "sub-1_ses-2"],
      ["0100 Hz", "100 Hz"],
      ["EEG 001", "EEG 1"],
      ["x_02_y", "x_2_y"],
      ["E001", "E1"],
      ["ECOG1", "ECOG01"],
      ["Fp1", "Fp01"],
    ] as const) {
      for (const chars of [false, true]) {
        expect(relabelRule(a, b, { chars }), `${a} -> ${b}`).toEqual(rule("repad", [], "", true));
        expect(relabelRule(b, a, { chars }), `${b} -> ${a}`).toEqual(rule("repad", [], "", true));
      }
    }
  });

  test("a letter between two digit runs breaks the join: legitimate repads keep their rule", () => {
    for (const [a, b] of [
      ["sub-01", "sub-1"],
      ["0100 Hz", "100 Hz"],
      ["EEG 001", "EEG 1"],
      ["x_02_y", "x_2_y"],
      ["sub-01_ses-02", "sub-1_ses-2"],
      ["1 x 05", "1 x 5"],
    ] as const) {
      expect(relabelRule(a, b, { chars: false }), `${a} -> ${b}`).toEqual(
        rule("repad", [], "", true),
      );
      expect(relabelRule(b, a, { chars: false }), `${b} -> ${a}`).toEqual(
        rule("repad", [], "", true),
      );
    }
    // The join is a property of each string, so it holds inside a wrap too.
    expect(relabelRule("A01", "POL A1", { chars: false })).toEqual(
      rule("wrap", ["POL ", ""], "", true),
    );
    expect(relabelRule("1-01", "POL 1-1", { chars: false })).toBeNull();
  });

  test("digits compare by value only as ASCII digits: a superscript is the text it is", () => {
    // The superscript two is a number character but has no value this module vouches for.
    expect(relabelRule("A\u{B2}", "POL A\u{B2}", { chars: false })).toEqual(
      rule("wrap", ["POL ", ""]),
    );
    expect(relabelRule("A\u{B2}", "A2", { chars: false })).toBeNull();
    // Arabic-Indic digits are compared as text, so they do not repad against ASCII ones, and an
    // ASCII zero in front of one is not padding either.
    expect(relabelRule("A\u{661}", "A01", { chars: false })).toBeNull();
    expect(relabelRule("A00\u{661}", "A0\u{661}", { chars: false })).toBeNull();
  });
});

describe("relabelRule: the bounds", () => {
  test("a string over 128 characters or over 24 runs gets no rule of any kind", () => {
    const long = "A".repeat(129);
    expect(relabelRule(long, `${long}x`, { chars: true })).toBeNull();
    expect(relabelRule(long, long.toLowerCase(), { chars: true })).toBeNull();
    // Exactly at the limit is still a name.
    const edge = "A".repeat(128);
    expect(relabelRule(edge, edge.toLowerCase(), { chars: false })).toEqual(rule("case"));
    expect(relabelRule(edge, `${edge.slice(0, 120)}-xyz`, { chars: false })).toBeNull();

    // Letters and hyphens alternate, so n characters are n runs. 24 runs is the most a name may have.
    const runs = (n: number): string =>
      Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "a" : "-")).join("");
    expect(relabelRule(runs(23), `${runs(23)}-`, { chars: false })).toEqual(
      rule("wrap", ["", "-"]),
    );
    expect(relabelRule(runs(24), `${runs(24)}a`, { chars: false })).toBeNull();
    expect(relabelRule(runs(24), `${runs(24)}a`, { chars: true })).toBeNull();
    expect(relabelRule(runs(25), runs(25).toUpperCase(), { chars: true })).toEqual(rule("case"));
  });

  test("astral characters count as one character each, and no cut splits a pair", () => {
    // U+10400 is a letter outside the basic plane: 100 of them are one run of 100 characters that
    // take 200 UTF-16 units, so a length check in units alone would refuse a name that is allowed.
    const wide = "\u{10400}".repeat(100);
    expect(relabelRule(wide, `${wide}!`, { chars: false })).toEqual(rule("wrap", ["", "!"]));
    // 129 characters in only 158 units: still over the limit, however it is counted.
    const mixed = `${"a".repeat(100)}${"\u{10400}".repeat(29)}`;
    expect(mixed.length).toBeLessThan(2 * 128 + 1);
    expect(relabelRule(mixed, `${mixed}!`, { chars: false })).toBeNull();
    expect(relabelRule(mixed, `${mixed}!`, { chars: true })).toBeNull();
  });

  test("the length bound is checked on each side alone", () => {
    const edge = "A".repeat(128);
    // Within the bound these are a strip and a wrap.
    expect(relabelRule(`x-${edge.slice(2)}`, edge.slice(2), { chars: false })?.kind).toBe("strip");
    expect(relabelRule(edge.slice(2), `x-${edge.slice(2)}`, { chars: false })?.kind).toBe("wrap");
    // One character more on either side, and neither.
    expect(relabelRule(`x-${edge}`, edge, { chars: true })).toBeNull();
    expect(relabelRule(edge, `x-${edge}`, { chars: true })).toBeNull();
    // Lower-casing can change a length: U+0130 lower-cases to i and a combining dot. These two are
    // a case change of each other, but one of them is 129 characters, so it is not a name.
    const dotted = `\u{130}${"a".repeat(127)}`;
    const decomposed = `i\u{307}${"a".repeat(127)}`;
    expect(dotted.toLowerCase()).toBe(decomposed.toLowerCase());
    expect(relabelRule(decomposed, dotted, { chars: false })).toBeNull();
    expect(relabelRule(dotted, decomposed, { chars: false })).toBeNull();
    // At 128 characters the decomposed one is a name again, and the pair is a case change.
    expect(relabelRule(dotted.slice(0, -1), decomposed.slice(0, -1), { chars: false })).toEqual(
      rule("case"),
    );
  });
});

describe("ruleWords", () => {
  test("each kind reads as plain English, with the gap strings exactly as they are", () => {
    expect(ruleWords(rule("case"))).toBe("letter case changed");
    expect(ruleWords(rule("repad", [], "", true))).toBe("zero padding of numbers changed");
    expect(ruleWords(rule("wrap", ["POL ", ""], "", true))).toBe(
      'added prefix "POL ", zero padding of numbers changed',
    );
    expect(ruleWords(rule("wrap", ["EEG ", "-Ref"]))).toBe('added prefix "EEG " and suffix "-Ref"');
    expect(ruleWords(rule("wrap", ["", "-Ref"]))).toBe('added suffix "-Ref"');
    expect(ruleWords(rule("strip", ["", "    "]))).toBe('removed suffix "    "');
    expect(ruleWords(rule("strip", ["EEG ", "-Ref"]))).toBe(
      'removed prefix "EEG " and suffix "-Ref"',
    );
    expect(ruleWords(rule("insert", ["EEG", "_", "REF"], "LD"))).toBe(
      'inserted "EEG" at the start, "_" after run 1 and "REF" after run 2 (runs kept: letters, digits)',
    );
    expect(ruleWords(rule("delete", ["EEG", "_", "REF"], "LD"))).toBe(
      'deleted "EEG" at the start, "_" after run 1 and "REF" after run 2 (runs kept: letters, digits)',
    );
    expect(ruleWords(rule("insert", ["", "", " ", "", "", "", "", "", "", "-REF"], "c9"))).toBe(
      'inserted " " after character 2 and "-REF" after character 9 (characters kept: 9)',
    );
    expect(ruleWords(rule("insert", ["", "", "X-", ""], "LOL"))).toBe(
      'inserted "X-" after run 2 (runs kept: letters, a character, letters)',
    );
  });

  test("every rule the relabel function returns has words, and the words are deterministic", () => {
    const pairs: [string, string][] = [
      ["Cz", "CZ"],
      ["A01", "A1"],
      ["Fp1", "EEG Fp1-Ref"],
      ["EEG Fp1-Ref", "Fp1"],
      ["GA01", "EEGGA_01REF"],
      ["EEGGA_01REF", "GA01"],
      ["DCEMBRACE", "DC EMBRACE-REF"],
      ["'G1'    ", "'G1'"],
      ["A1", "POL A01"],
    ];
    for (const [a, b] of pairs) {
      const found = relabelRule(a, b, { chars: true }) as RelabelRule;
      expect(found, `${a} -> ${b}`).not.toBeNull();
      const words = ruleWords(found);
      expect(words.length).toBeGreaterThan(0);
      expect(ruleWords(found)).toBe(words);
    }
  });

  test("two different rules read differently unless they differ only in a text they hold", () => {
    const rules = [
      rule("case"),
      rule("repad", [], "", true),
      rule("wrap", ["a", ""]),
      rule("wrap", ["", "a"]),
      rule("wrap", ["a", "a"]),
      rule("strip", ["a", ""]),
      rule("wrap", ["a", ""], "", true),
      rule("insert", ["a", ""], "L"),
      rule("insert", ["", "a"], "L"),
      rule("delete", ["a", ""], "L"),
      rule("insert", ["a", ""], "D"),
      rule("insert", ["a", ""], "c1"),
      rule("insert", ["", "", "a"], "c2"),
    ];
    const words = rules.map(ruleWords);
    expect(new Set(words).size).toBe(words.length);
  });
});

/** A small seeded generator (mulberry32): the same seed gives the same sequence on every machine. */
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

/** Zero padding removed from every ASCII digit run: what "digits compared by value" means. */
function byValue(s: string): string {
  return s.replace(/[0-9]+/g, (digits) => digits.replace(/^0+(?=[0-9])/, ""));
}

/** The parts of a name, split independently of the module under test. */
function partsOf(s: string): string[] {
  return s.match(/\p{L}+|\p{N}+|[\s\S]/gu) ?? [];
}

/**
 * Whether a rule keeps the anchoring of design section 4.3: no added or removed text holds a digit;
 * an insertion or deletion of runs keeps a digit run of the shorter name; and a character rule
 * inserts or deletes only whole runs of the longer one, never between two digits of the shorter.
 * Every other kind holds trivially.
 */
function anchored(found: RelabelRule, before: string, after: string): boolean {
  if (found.gaps.some((gap) => /\p{N}/u.test(gap))) return false;
  if (found.kind !== "insert" && found.kind !== "delete") return true;
  const kept = found.kind === "insert" ? before : after;
  const whole = found.kind === "insert" ? after : before;
  if (!found.shape.startsWith("c")) return partsOf(kept).some((part) => /^\p{N}/u.test(part));
  const boundaries = new Set<number>([0]);
  let at = 0;
  for (const part of partsOf(whole)) {
    at += Array.from(part).length;
    boundaries.add(at);
  }
  const keptChars = Array.from(kept);
  let position = 0;
  for (const [i, gap] of found.gaps.entries()) {
    const width = Array.from(gap).length;
    if (width > 0 && !(boundaries.has(position) && boundaries.has(position + width))) return false;
    const between = i > 0 && i < keptChars.length;
    if (
      width > 0 &&
      between &&
      /^\p{N}$/u.test(keptChars[i - 1] as string) &&
      /^\p{N}$/u.test(keptChars[i] as string)
    ) {
      return false;
    }
    position += width + (i < found.gaps.length - 1 ? 1 : 0);
  }
  return true;
}

/**
 * Rebuild the longer string from the shorter one and the rule alone. This is the property that
 * makes a rule an exact description: if the rebuilt text is not the real one, the class line would
 * tell the model something the files do not say.
 */
function rebuilds(found: RelabelRule, before: string, after: string): boolean {
  switch (found.kind) {
    case "case":
      return before.toLowerCase() === after.toLowerCase();
    case "repad":
      return byValue(before) === byValue(after);
    case "wrap":
      return byValue(after) === byValue(`${found.gaps[0]}${before}${found.gaps[1]}`);
    case "strip":
      return byValue(before) === byValue(`${found.gaps[0]}${after}${found.gaps[1]}`);
    case "insert":
    case "delete": {
      const kept = found.kind === "insert" ? before : after;
      const whole = found.kind === "insert" ? after : before;
      const pieces = found.shape.startsWith("c") ? Array.from(kept) : partsOf(kept);
      if (found.gaps.length !== pieces.length + 1) return false;
      if (found.shape.startsWith("c")) {
        if (found.shape !== `c${pieces.length}`) return false;
      } else {
        const classes = pieces.map((p) =>
          /^\p{L}/u.test(p) ? "L" : /^\p{N}/u.test(p) ? "D" : "O",
        );
        if (found.shape !== classes.join("")) return false;
      }
      const interleaved = pieces.map((piece, i) => `${found.gaps[i]}${piece}`).join("");
      return byValue(`${interleaved}${found.gaps[pieces.length]}`) === byValue(whole);
    }
  }
}

describe("relabelRule: every rule it returns rebuilds the other string from one string and the rule", () => {
  test("3,000 generated pairs: a rule is exact, deterministic, never numeric, and never claims equal strings", () => {
    const random = seeded(4303);
    const alphabet = ["a", "B", "c", "Z", "0", "1", "2", "7", "-", "_", " ", "."];
    const word = (): string =>
      Array.from(
        { length: 1 + Math.floor(random() * 7) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join("");
    const mutate = (s: string): string => {
      switch (Math.floor(random() * 7)) {
        case 0:
          return `${word()}${s}`;
        case 1:
          return `${s}${word()}`;
        case 2: {
          const at = Math.floor(random() * (s.length + 1));
          return `${s.slice(0, at)}${word()}${s.slice(at)}`;
        }
        case 3:
          return s.length > 1 ? s.slice(1 + Math.floor(random() * (s.length - 1))) : s;
        case 4:
          return s.toUpperCase();
        case 5:
          return s.replace(/[0-9]+/g, (d) =>
            random() < 0.5 ? `0${d}` : d.replace(/^0+(?=[0-9])/, ""),
          );
        default:
          return word();
      }
    };

    const kinds = new Set<string>();
    let withRule = 0;
    for (let n = 0; n < 3000; n++) {
      const before = word();
      const after = mutate(before);
      for (const chars of [false, true]) {
        const found = relabelRule(before, after, { chars });
        expect(relabelRule(before, after, { chars }), `${before} -> ${after}`).toEqual(found);
        if (found === null) continue;
        withRule++;
        kinds.add(found.kind);
        expect(before === after, `equal strings ${before}`).toBe(false);
        expect(
          rebuilds(found, before, after),
          `${JSON.stringify([before, after, chars, found])}`,
        ).toBe(true);
        expect(anchored(found, before, after), JSON.stringify([before, after, found])).toBe(true);
        expect(ruleWords(found).length).toBeGreaterThan(0);
        const numeric = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
        expect(numeric.test(before) && numeric.test(after), `${before} -> ${after}`).toBe(false);
        if (!chars) expect(found.shape.startsWith("c")).toBe(false);
      }
    }
    // The generator reaches every kind of rule, so the property is not vacuous.
    expect([...kinds].sort()).toEqual(["case", "delete", "insert", "repad", "strip", "wrap"]);
    // 1,403 of the 6,000 tries find a rule (3,437 before digits were barred from inserted text,
    // which this generator, with four digits in a twelve-character alphabet, hits often). It was
    // 1,535 before a pair compared its digits by value only when every digit run of both strings
    // stands among the neighbors the allowlist names: 140 tries lost a rule then, each a padding
    // change in a string whose digits are now read as text (beside a `.`, a single letter with
    // digits beyond it, or another number), and 8 found an exact one by text that the old
    // reading, digit run by digit run, did not (`07` to `..07` is the prefix `..`).
    expect(withRule).toBeGreaterThan(1350);
  });
});

/**
 * An independent reading of the allowlist, written over characters rather than the module's runs:
 * a string is read as text when it holds a digit that is not ASCII, or when a maximal run of ASCII
 * digits has a side that is none of: the edge; a maximal run of letters that are all ASCII and are
 * not one letter with a digit beyond it; one space, hyphen or underscore with the edge or such
 * letters beyond it. When either string of a pair is read as text, every digit of the pair must
 * be compared as text.
 */
function readAsText(s: string): boolean {
  const chars = Array.from(s);
  const asciiDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const digit = (c: string | undefined) => c !== undefined && /^\p{N}$/u.test(c);
  const letter = (c: string | undefined) => c !== undefined && /^\p{L}$/u.test(c);
  if (chars.some((c) => digit(c) && !asciiDigit(c))) return true;
  // The letters from `at` outward (`step`): all ASCII, and more than one or no digit beyond.
  const lettersOk = (at: number, step: number): boolean => {
    let end = at;
    while (letter(chars[end])) end += step;
    const run = chars.slice(Math.min(at, end - step), Math.max(at, end - step) + 1);
    return run.every((c) => /^[A-Za-z]$/.test(c)) && (run.length > 1 || !digit(chars[end]));
  };
  const sideOk = (at: number, step: number): boolean => {
    const c = chars[at];
    if (c === undefined) return true;
    if (letter(c)) return lettersOk(at, step);
    if (c !== " " && c !== "-" && c !== "_") return false;
    const beyond = chars[at + step];
    return beyond === undefined || (letter(beyond) && lettersOk(at + step, step));
  };
  for (let i = 0; i < chars.length; ) {
    if (!asciiDigit(chars[i])) {
      i++;
      continue;
    }
    let end = i;
    while (asciiDigit(chars[end])) end++;
    if (!sideOk(i - 1, -1) || !sideOk(end, 1)) return true;
    i = end;
  }
  return false;
}

/**
 * An independent reading of when only the zero padding of numbers differs: neither string holds a
 * number written with a separator, the strings split into the same maximal letter runs and
 * letter-free stretches, letters are equal exactly, and each stretch is equal once its one digit
 * run is read by value.
 */
function onlyPaddingDiffers(before: string, after: string): boolean {
  const numeric = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  if (before === after || before === "" || after === "") return false;
  if (numeric.test(before) && numeric.test(after)) return false;
  // A case change is the rule that comes first; it is not a padding.
  if (before.toLowerCase() === after.toLowerCase()) return false;
  if (readAsText(before) || readAsText(after)) return false;
  const pieces = (s: string): string[] => s.match(/\p{L}+|[^\p{L}]+/gu) ?? [];
  const byValue = (piece: string): string =>
    piece.replace(/[0-9]+/g, (digits) => digits.replace(/^0+(?=[0-9])/, ""));
  const b = pieces(before);
  const a = pieces(after);
  return b.length === a.length && b.every((piece, i) => byValue(piece) === byValue(a[i] as string));
}

/** Whether a rule rebuilds the longer string from the shorter one by TEXT alone, digits included. */
function rebuildsByText(found: RelabelRule, before: string, after: string): boolean {
  switch (found.kind) {
    case "case":
      return before.toLowerCase() === after.toLowerCase();
    case "repad":
      return false;
    case "wrap":
      return after === `${found.gaps[0]}${before}${found.gaps[1]}`;
    case "strip":
      return before === `${found.gaps[0]}${after}${found.gaps[1]}`;
    case "insert":
    case "delete": {
      const kept = found.kind === "insert" ? before : after;
      const whole = found.kind === "insert" ? after : before;
      const pieces = found.shape.startsWith("c") ? Array.from(kept) : partsOf(kept);
      if (found.gaps.length !== pieces.length + 1) return false;
      const interleaved = pieces.map((piece, i) => `${found.gaps[i]}${piece}`).join("");
      return `${interleaved}${found.gaps[pieces.length]}` === whole;
    }
  }
}

/**
 * The alphabet of the padding property tests: digits and zeros, the three allowed separators,
 * letters, and the marks a number can be written with (the two decimal marks, an apostrophe, the
 * middle dot, the Arabic decimal separator, the fullwidth full stop, letter-like marks, a word
 * joiner, and `p`, a decimal in BIDS-style names), and an Arabic-Indic digit, which has no value
 * this module vouches for.
 */
const SEPARATOR_ALPHABET = [
  "0",
  "0",
  "0",
  "1",
  "5",
  " ",
  ".",
  ",",
  "'",
  "_",
  "-",
  "\u{B7}",
  "\u{66B}",
  "\u{FF0E}",
  "\u{A78F}",
  "\u{2BC}",
  "\u{2CC}",
  "\u{2060}",
  "\u{663}",
  "p",
  "a",
  "B",
  "Hz",
];

describe("relabelRule: a repad is exactly what an independent reading of the two strings allows", () => {
  /** A word over the separator alphabet, and its pick. */
  const wordFrom = (random: () => number) => (): string =>
    Array.from(
      { length: 1 + Math.floor(random() * 8) },
      () => SEPARATOR_ALPHABET[Math.floor(random() * SEPARATOR_ALPHABET.length)],
    ).join("");
  /** Every number's padding changed or kept, at random. */
  const repad = (random: () => number, s: string): string =>
    s.replace(/[0-9]+/g, (d) =>
      random() < 0.5 ? (random() < 0.5 ? `0${d}` : d.replace(/^0/, "")) : d,
    );
  const byValue = (s: string): string => s.replace(/[0-9]+/g, (d) => d.replace(/^0+(?=[0-9])/, ""));

  test("4,000 generated pairs over digits, zeros, separators and letters", () => {
    const random = seeded(1868);
    // Half the characters from the plain ones, so pairs that may repad stay common beside the marks.
    const plain = ["0", "01", "5", " ", "-", "_", "a", "Hz", "EEG", "Fp", "sub"];
    const marked = wordFrom(random);
    const word = (): string =>
      random() < 0.5
        ? Array.from(
            { length: 1 + Math.floor(random() * 8) },
            () => plain[Math.floor(random() * plain.length)],
          ).join("")
        : marked();
    // Mostly the padding of one or every number changed, so repads and near-repads are common.
    const mutate = (s: string): string => {
      const choice = random();
      if (choice < 0.7) return repad(random, s);
      if (choice < 0.85) {
        const at = Math.floor(random() * (s.length + 1));
        return `${s.slice(0, at)}0${s.slice(at)}`;
      }
      return word();
    };

    let repads = 0;
    let refused = 0;
    for (let n = 0; n < 4000; n++) {
      const before = word();
      const after = mutate(before);
      const expected = onlyPaddingDiffers(before, after);
      for (const chars of [false, true]) {
        const found = relabelRule(before, after, { chars });
        expect(found?.kind === "repad", JSON.stringify([before, after, chars])).toBe(expected);
      }
      if (expected) repads++;
      // A pair equal once every number is read by value, that is still no repad: a join or a
      // decimal mark decided it, which is what this test is about.
      const sameByValue = byValue(before) === byValue(after);
      if (!expected && sameByValue && before.toLowerCase() !== after.toLowerCase()) refused++;
    }
    // Not vacuous: the generator reaches both sides of the rule many times.
    expect(repads).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(300);
  });

  test("4,000 generated pairs with a decimal mark put anywhere: no rule says a number kept its value when either string holds one", () => {
    const random = seeded(18683);
    const word = wordFrom(random);
    // The padding changed or not, then one or two marks put anywhere, so a mark is often in the
    // text a rule would add (`05 Hz` to `.5 Hz`).
    const mutate = (s: string): string => {
      let out = random() < 0.8 ? repad(random, s) : s;
      for (let k = 1 + Math.floor(random() * 2); k > 0; k--) {
        const at = Math.floor(random() * (out.length + 1));
        out = `${out.slice(0, at)}${random() < 0.5 ? "." : ","}${out.slice(at)}`;
      }
      return out;
    };

    let separated = 0;
    let ruled = 0;
    let wouldHaveRepadded = 0;
    for (let n = 0; n < 4000; n++) {
      const before = word();
      const after = mutate(before);
      for (const [b, a] of [
        [before, after],
        [after, before],
      ] as const) {
        const expected = onlyPaddingDiffers(b, a);
        const strict = readAsText(b) || readAsText(a);
        if (strict) separated++;
        for (const chars of [false, true]) {
          const found = relabelRule(b, a, { chars });
          const label = JSON.stringify([b, a, chars, found]);
          expect(found?.kind === "repad", label).toBe(expected);
          if (!strict || found === null) continue;
          ruled++;
          expect(found.repadded, label).toBe(false);
          expect(rebuildsByText(found, b, a), label).toBe(true);
        }
        // The pairs this rule exists for: one string is the other with a number repadded and a
        // mark put beside it, so a comparison by value would have found a rule.
        if (strict && byValue(b.replace(/[.,]/g, "")) === byValue(a.replace(/[.,]/g, ""))) {
          wouldHaveRepadded++;
        }
      }
    }
    expect(separated).toBeGreaterThan(4000);
    expect(ruled).toBeGreaterThan(300);
    expect(wouldHaveRepadded).toBeGreaterThan(300);
  });
});

describe("relabelRule: the allowlist over every code point", () => {
  test("c05 Hz to c5 Hz claims a padding exactly for an ASCII letter, a space, a hyphen or an underscore; 0c05 never; 05 to c5 only as a real repad", () => {
    // A digit c is part of the number itself (`105`), so it is left out; every other code point,
    // the surrogates excepted, is tried in all three places.
    const allowed = (c: string) => /^[A-Za-z _-]$/.test(c);
    const claims = (found: RelabelRule | null) =>
      found?.kind === "repad" || found?.repadded === true;
    let tried = 0;
    let claimed = 0;
    const wrong: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (cp >= 0x30 && cp <= 0x39) continue;
      const c = String.fromCodePoint(cp);
      tried++;
      const edge = relabelRule(`${c}05 Hz`, `${c}5 Hz`, { chars: false });
      if (claims(edge) !== allowed(c)) wrong.push(`edge U+${cp.toString(16)}`);
      if (claims(relabelRule(`0${c}05 Hz`, `0${c}5 Hz`, { chars: false }))) {
        wrong.push(`joined U+${cp.toString(16)}`);
      }
      const added = relabelRule("05 Hz", `${c}5 Hz`, { chars: false });
      if (claims(added) !== allowed(c)) wrong.push(`added U+${cp.toString(16)}`);
      if (claims(added)) {
        claimed++;
        // A real repad: the text added holds no digit, and with it the number keeps its value.
        const gaps = added?.gaps ?? [];
        const rebuilt = `${gaps[0] ?? ""}05 Hz${gaps[1] ?? ""}`;
        const value = (s: string) => s.replace(/[0-9]+/g, (d) => d.replace(/^0+(?=[0-9])/, ""));
        if (gaps.some((gap) => /\p{N}/u.test(gap)) || value(rebuilt) !== value(`${c}5 Hz`)) {
          wrong.push(`added, not a repad: U+${cp.toString(16)}`);
        }
      }
    }
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(tried).toBe(0x110000 - 0x800 - 10);
    expect(claimed).toBe(52 + 3);
  }, 30_000);
});

/** A pool file from text; `before` is null for an added file. */
function pooled(path: string, before: string | null, after: string): PoolFile {
  return { path, before: before === null ? null : enc(before), after: enc(after) };
}

/** The leaves of a document no test here expects to be refused for a long path. */
function leavesOf(value: JsonValue): JsonLeaf[] {
  const found = flattenJson(value);
  if (found === null) throw new Error("a path over maxNameChars in a test document");
  return found;
}

describe("flattenJson: the leaves of a document", () => {
  const leaves = (text: string) =>
    leavesOf(json(text)).map((leaf) => [leaf.path, leaf.value] as const);

  test("objects recurse, scalars are leaves, and a list of scalars is one leaf", () => {
    expect(
      leaves('{"Name": "x", "Count": 3, "Nested": {"a": true, "b": null}, "List": [1, 2]}'),
    ).toEqual([
      [".Name", '"x"'],
      [".Count", "3"],
      [".Nested.a", "true"],
      [".Nested.b", "null"],
      [".List", "[1,2]"],
    ]);
  });

  test("an empty object and an empty array are leaves, and so is a scalar document", () => {
    expect(leaves('{"a": {}, "b": [], "c": [[]], "d": [{}]}')).toEqual([
      [".a", "{}"],
      [".b", "[]"],
      [".c[0]", "[]"],
      [".d[0]", "{}"],
    ]);
    expect(leaves("{}")).toEqual([["", "{}"]]);
    expect(leaves("[]")).toEqual([["", "[]"]]);
    expect(leaves("7")).toEqual([["", "7"]]);
    expect(leaves('"x"')).toEqual([["", '"x"']]);
  });

  test("an array with any container element recurses with index paths, scalars included", () => {
    expect(leaves('{"a": [1, {"b": 2}, "c"]}')).toEqual([
      [".a[0]", "1"],
      [".a[1].b", "2"],
      [".a[2]", '"c"'],
    ]);
    expect(leaves("[[1, 2], [3]]")).toEqual([
      ["[0]", "[1,2]"],
      ["[1]", "[3]"],
    ]);
  });

  test("a key that is not a bare name is written in brackets, JSON escaped, so no two places share a path", () => {
    const text = String.raw`{"a.b": 1, "a": {"b": 2}, "x y": 3, "1": 4, "q\"r": 5, "": 6, "caf\u00e9": 7}`;
    const found = leaves(text);
    expect(found.map(([path]) => path)).toEqual([
      '["a.b"]',
      ".a.b",
      '["x y"]',
      '["1"]',
      '["q\\"r"]',
      '[""]',
      '["caf\u{E9}"]',
    ]);
    expect(new Set(found.map(([path]) => path)).size).toBe(found.length);
    // A key "0" is not the index 0.
    expect(leaves('{"a": {"0": 1}}')).toEqual([['.a["0"]', "1"]]);
    expect(leaves('{"a": [1, {"k": 1}]}')).toEqual([
      [".a[0]", "1"],
      [".a[1].k", "1"],
    ]);
  });

  test("a leaf knows its parent, its name and whether it is a key", () => {
    const found = leavesOf(json('{"a": {"b": 1}, "c": [{"d": 2}, 3]}'));
    expect(found.map((l) => [l.path, l.parent, l.name, l.isKey])).toEqual([
      [".a.b", ".a", "b", true],
      [".c[0].d", ".c[0]", "d", true],
      [".c[1]", ".c", "[1]", false],
    ]);
  });

  test("values are canonical text: numbers as written, strings re-encoded, key order kept", () => {
    expect(leaves('{"n": 1.0, "m": 1, "s": "\u0041", "e": 1e400, "z": -0}')).toEqual([
      [".n", "1.0"],
      [".m", "1"],
      [".s", '"A"'],
      [".e", "1e400"],
      [".z", "-0"],
    ]);
  });

  test("a path of 1,024 code units is a leaf; one longer, built of short keys, leaves the document with none", () => {
    const max = SUMMARY_LIMITS.maxNameChars;
    // 64 nested objects (the deepest a document may be), each key 15 characters: a path of 64
    // segments of 16. The last key one character longer makes it 1,025.
    const deep = (last: number): string => {
      const keys = Array.from({ length: 63 }, (_, i) => `k${String(i).padStart(14, "0")}`);
      keys.push("z".repeat(last));
      return `${keys.map((k) => `{"${k}":`).join("")}1${"}".repeat(keys.length)}`;
    };
    const exact = leavesOf(json(deep(15)));
    expect(exact.length).toBe(1);
    expect(exact[0]?.path.length).toBe(max);
    expect(flattenJson(json(deep(16)))).toBeNull();
    // A key written in brackets counts as written, its quotes and brackets included.
    const bracketed = (n: number) => `{"${"x ".repeat(n / 2)}":1}`;
    expect(leavesOf(json(bracketed(max - 4)))[0]?.path.length).toBe(max);
    expect(flattenJson(json(bracketed(max - 2)))).toBeNull();
    // An index is a segment too, but a list of scalars is one leaf and adds none.
    const key = "y".repeat(max - 3);
    expect(flattenJson(json(`{"${key}":[[1],[2]]}`))).toBeNull();
    expect(leavesOf(json(`{"${key}":[1,2]}`))[0]?.path.length).toBe(max - 2);
  });
});

describe("buildPools: the rows and leaves a pull request adds", () => {
  const rowsOf = (pool: ReturnType<typeof buildPools>, path: string) => {
    const file = pool.rows.files.get(path);
    return file === undefined
      ? undefined
      : { header: file.header, rows: Object.fromEntries(file.rows) };
  };

  test("an added table contributes every row, with how many copies, under its own header", () => {
    const pool = buildPools([
      pooled("sourcedata/old/a_channels.tsv", null, "name\ttype\nA1\tEEG\nA2\tEEG\nA1\tEEG\n"),
    ]);
    expect(rowsOf(pool, "sourcedata/old/a_channels.tsv")).toEqual({
      header: "name\ttype",
      rows: { "A1\tEEG": 2, "A2\tEEG": 1 },
    });
  });

  test("a modified table with the same header contributes the multiset difference only", () => {
    const pool = buildPools([
      pooled(
        "x_channels.tsv",
        "name\ttype\nA1\tEEG\nA2\tEEG\nA2\tEEG\n",
        "name\ttype\nA2\tEEG\nA2\tEEG\nA2\tEEG\nA3\tEMG\nA3\tEMG\n",
      ),
    ]);
    // Before had A2 twice; after has it three times, so one copy is new, and A3 twice is new.
    expect(rowsOf(pool, "x_channels.tsv")).toEqual({
      header: "name\ttype",
      rows: { "A2\tEEG": 1, "A3\tEMG": 2 },
    });
  });

  test("a modified table with a different header contributes every row of its after side", () => {
    const pool = buildPools([
      pooled("x_channels.tsv", "name\ttype\nA1\tEEG\n", "type\tname\nEEG\tA1\nEMG\tA2\n"),
    ]);
    expect(rowsOf(pool, "x_channels.tsv")).toEqual({
      header: "type\tname",
      rows: { "EEG\tA1": 1, "EMG\tA2": 1 },
    });
    // The same columns in another order are a different header, so a row whose TEXT was there
    // before is still new: under the new header it says something else.
    expect(rowsOf(buildPools([pooled("y.tsv", "a\tb\n1\t2\n", "b\ta\n1\t2\n")]), "y.tsv")).toEqual({
      header: "b\ta",
      rows: { "1\t2": 1 },
    });
  });

  test("a file that adds nothing is not in the pool, and neither is one that only lost rows", () => {
    const pool = buildPools([
      pooled("same.tsv", "a\n1\n", "a\n1\n"),
      pooled("lost.tsv", "a\tb\n1\t2\n3\t4\n", "a\tb\n1\t2\n"),
      pooled("header_only.tsv", null, "a\tb\n"),
      pooled("same.json", '{"a": 1}', '{"a": 1}'),
      pooled("lost.json", '{"a": 1, "b": 2}', '{"a": 1}'),
      pooled("reindented.json", '{"a": 1}', '{\n  "a": 1\n}\n'),
    ]);
    expect([...pool.rows.files.keys()]).toEqual([]);
    expect([...pool.json.files.keys()]).toEqual([]);
    expect([...pool.json.byLeaf.keys()]).toEqual([]);
  });

  test("tables anywhere in the tree are pooled; only sourcedata/<one directory>/<F> is indexed, by F", () => {
    const pool = buildPools([
      pooled("sub-01/eeg/sub-01_channels.tsv", null, "name\nA1\n"),
      pooled("sourcedata/removed/sub-01/eeg/sub-01_channels.tsv", null, "name\nA1\n"),
      pooled("sourcedata/other/sub-02_channels.tsv", null, "name\nA2\n"),
      pooled("derivatives/x/sub-01_channels.tsv", null, "name\nA3\n"),
      pooled("notsourcedata/x/sub-01_channels.tsv", null, "name\nA4\n"),
      pooled("sourcedata/sub-03_channels.tsv", null, "name\nA5\n"),
    ]);
    expect([...pool.rows.files.keys()]).toEqual([
      "sub-01/eeg/sub-01_channels.tsv",
      "sourcedata/removed/sub-01/eeg/sub-01_channels.tsv",
      "sourcedata/other/sub-02_channels.tsv",
      "derivatives/x/sub-01_channels.tsv",
      "notsourcedata/x/sub-01_channels.tsv",
      "sourcedata/sub-03_channels.tsv",
    ]);
    // A sourcedata file keeps rows for the one path below its first directory, and for no other:
    // not for its own last segment (sub-01_channels.tsv), and sourcedata/<F> keeps rows for nothing.
    expect(Object.fromEntries(pool.rows.sourcedataFor)).toEqual({
      "sub-01/eeg/sub-01_channels.tsv": ["sourcedata/removed/sub-01/eeg/sub-01_channels.tsv"],
      "sub-02_channels.tsv": ["sourcedata/other/sub-02_channels.tsv"],
    });
  });

  test("several sourcedata copies of one file are listed in path order, whatever order they came in", () => {
    const files = [
      pooled("sourcedata/b/x_channels.tsv", null, "name\nA1\n"),
      pooled("sourcedata/a/x_channels.tsv", null, "name\nA1\n"),
      pooled("sourcedata/c/x_channels.tsv", null, "name\nA1\n"),
    ];
    const sorted = [
      "sourcedata/a/x_channels.tsv",
      "sourcedata/b/x_channels.tsv",
      "sourcedata/c/x_channels.tsv",
    ];
    expect(buildPools(files).rows.sourcedataFor.get("x_channels.tsv")).toEqual(sorted);
    expect(buildPools([...files].reverse()).rows.sourcedataFor.get("x_channels.tsv")).toEqual(
      sorted,
    );
  });

  test("files with other extensions are ignored, including a gzipped table", () => {
    const pool = buildPools([
      pooled("a.tsv.gz", null, "x\n1\n"),
      pooled("README.md", null, "x\n1\n"),
      pooled("a.TSV", null, "x\n1\n"),
      pooled("a.csv", null, "x\n1\n"),
    ]);
    expect(pool.rows.files.size).toBe(0);
    expect(pool.json.files.size).toBe(0);
  });

  test("a pool file that does not parse is SKIPPED, on either side, and never an error", () => {
    const ragged = "a\tb\n1\n";
    const bad = new Uint8Array([0x61, 0x09, 0x62, 0x0a, 0xff, 0x09, 0x31, 0x0a]);
    const files: PoolFile[] = [
      pooled("ragged_after.tsv", null, ragged),
      pooled("ragged_before.tsv", ragged, "a\tb\n1\t2\n"),
      { path: "binary_after.tsv", before: null, after: bad },
      { path: "binary_before.tsv", before: bad, after: enc("a\tb\n1\t2\n") },
      pooled("quoted.tsv", null, 'a\n"x"\n'),
      pooled("dup_key.json", null, '{"a": 1, "a": 2}'),
      pooled("bad_json_before.json", "{", '{"a": 1}'),
      pooled("bad_json_after.json", '{"a": 1}', "{"),
      pooled("not_json.json", null, "NaN"),
      pooled("good.tsv", null, "a\tb\n1\t2\n"),
      pooled("good.json", null, '{"a": 1}'),
    ];
    const pool = buildPools(files);
    expect([...pool.rows.files.keys()]).toEqual(["good.tsv"]);
    expect([...pool.json.files.keys()]).toEqual(["good.json"]);
  });

  test("every readable JSON file lists its top-level keys, and an unreadable one is named", () => {
    const pool = buildPools([
      pooled("task-x_eeg.json", '{"A": 1, "B": 2}', '{"A": 1, "B": 2, "C": 3}'),
      pooled("sub-01/sub-01_task-x_eeg.json", '{"A": 1}', '{"A": 5}'),
      pooled("unchanged_eeg.json", '{"A": 1}', '{"A": 1}'),
      pooled("list_eeg.json", null, "[1]"),
      pooled("bad_before_eeg.json", "{", '{"D": 1}'),
      pooled("bad_after_eeg.json", '{"A": 1}', "{"),
    ]);
    expect(Object.fromEntries(pool.json.byTopKey)).toEqual({
      A: ["task-x_eeg.json", "sub-01/sub-01_task-x_eeg.json", "unchanged_eeg.json"],
      B: ["task-x_eeg.json"],
      C: ["task-x_eeg.json"],
      D: ["bad_before_eeg.json"],
    });
    expect([...pool.json.unreadable]).toEqual(["bad_after_eeg.json"]);
    // Only the files that add a leaf are homes.
    expect([...pool.json.files.keys()]).toEqual([
      "task-x_eeg.json",
      "sub-01/sub-01_task-x_eeg.json",
      "list_eeg.json",
    ]);
  });

  test("a name or path over maxNameChars leaves a file out as a parse failure does, keeping its top-level keys", () => {
    const max = SUMMARY_LIMITS.maxNameChars;
    const long = "k".repeat(max);
    const pool = buildPools([
      // A path of 1,025 on the after side, then on the before side: no leaf is a home.
      pooled("task-x_eeg.json", null, `{"A":{"${long}":1}}`),
      pooled("sub-01/sub-01_task-x_eeg.json", `{"B":{"${long}":1}}`, '{"B":{"x":1}}'),
      // A key of 1,025 does not parse: the file is unreadable.
      pooled("sub-02/sub-02_task-x_eeg.json", null, `{"${long}k":1}`),
      // A column name of 1,025 does not parse either: no row of it is a copy.
      pooled("sourcedata/old/x.tsv", null, `a\t${long}k\n1\t2\n`),
    ]);
    expect(pool.json.files.size).toBe(0);
    expect(pool.json.byLeaf.size).toBe(0);
    expect(Object.fromEntries(pool.json.byTopKey)).toEqual({
      A: ["task-x_eeg.json"],
      B: ["sub-01/sub-01_task-x_eeg.json"],
    });
    expect([...pool.json.unreadable]).toEqual(["sub-02/sub-02_task-x_eeg.json"]);
    expect(pool.rows.files.size).toBe(0);
  });

  test("a JSON file contributes the leaves it has now and did not have, by path and value", () => {
    const pool = buildPools([
      pooled(
        "task-rest_eeg.json",
        '{"A": 1, "B": "x", "C": {"d": 1, "e": 2}, "L": [1, 2]}',
        '{"A": 1, "B": "y", "C": {"d": 1, "f": 3}, "L": [1, 2, 3], "N": null}',
      ),
      pooled("added.json", null, '{"Q": {"r": 1}}'),
    ]);
    expect(Object.fromEntries(pool.json.files.get("task-rest_eeg.json") ?? [])).toEqual({
      ".B": '"y"',
      ".C.f": "3",
      ".L": "[1,2,3]",
      ".N": "null",
    });
    expect(Object.fromEntries(pool.json.files.get("added.json") ?? [])).toEqual({ ".Q.r": "1" });
    expect(pool.json.byLeaf.get(leafKey(".B", '"y"'))).toEqual(["task-rest_eeg.json"]);
    // An unchanged leaf is not new, and neither is a leaf at the same path with a changed value at its OLD value.
    expect(pool.json.byLeaf.get(leafKey(".A", "1"))).toBeUndefined();
    expect(pool.json.byLeaf.get(leafKey(".B", '"x"'))).toBeUndefined();
  });

  test("the leaf key is injective: a path and a value never run into each other", () => {
    expect(leafKey(".a1", "2")).not.toBe(leafKey(".a", "12"));
    expect(leafKey('.a["b"]', '"c"')).not.toBe(leafKey(".a", '["b"]"c"'));
    expect(leafKey(".a", "1")).toBe(leafKey(".a", "1"));
  });

  test("several files adding one leaf are listed in the order given", () => {
    const pool = buildPools([
      pooled("b.json", null, '{"K": 1}'),
      pooled("a.json", '{"K": 2}', '{"K": 1}'),
      pooled("c.json", '{"K": 1}', '{"K": 1}'),
    ]);
    expect(pool.json.byLeaf.get(leafKey(".K", "1"))).toEqual(["b.json", "a.json"]);
  });

  test("a path listed twice contributes nothing, whichever entry comes first; a JSON one is unreadable", () => {
    const one = pooled("a.tsv", null, "x\n1\n");
    const two = pooled("a.tsv", null, "x\n2\n");
    const json = (value: string) => pooled("task-x_eeg.json", null, `{"K": ${value}}`);
    for (const files of [
      [one, two, json("1"), json("2")],
      [two, one, json("2"), json("1")],
    ]) {
      const pool = buildPools(files);
      expect(rowsOf(pool, "a.tsv")).toBeUndefined();
      expect(pool.rows.files.size).toBe(0);
      expect(pool.json.files.size).toBe(0);
      expect(pool.json.byLeaf.size).toBe(0);
      expect(pool.json.byTopKey.size).toBe(0);
      // Not left out: it may hold any key, so it blocks a move past it as an unreadable file does.
      expect([...pool.json.unreadable]).toEqual(["task-x_eeg.json"]);
    }
    // A path listed once beside them is pooled as usual.
    const pool = buildPools([one, two, pooled("b.tsv", null, "x\n3\n")]);
    expect(rowsOf(pool, "b.tsv")).toEqual({ header: "x", rows: { "3": 1 } });
  });

  test("nothing in the pool depends on the bytes being shared: a pool is its own copy", () => {
    const bytes = enc("a\n1\n");
    const pool = buildPools([{ path: "a.tsv", before: null, after: bytes }]);
    bytes[2] = 0x39;
    expect(rowsOf(pool, "a.tsv")).toEqual({ header: "a", rows: { "1": 1 } });
  });
});

// ---------------------------------------------------------------------------------------------
// The table change model
// ---------------------------------------------------------------------------------------------

/** A table from text, through the real parser. */
function table(text: string): Table {
  const parsed = parseTsv(enc(text));
  if (!parsed.ok) throw new Error(`test input is not a table (${parsed.refusal})`);
  return parsed.value;
}

/** Tab-separated text from rows of cells, with LF endings and a final newline. */
function tsv(...rows: string[][]): string {
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

/**
 * The diff of two table texts at a path, against a pool built from `files`. A fresh pool each call,
 * because a diff uses up the copies it relocates against.
 */
function diffText(
  path: string,
  before: string,
  after: string,
  files: PoolFile[] = [],
): FileDiff<TableCounts> {
  const result = diffTable(path, table(before), table(after), buildPools(files).rows);
  if (!result.ok) throw new Error(`diff refused: ${result.refusal}`);
  return result.value;
}

/** An atom as one line, for expectations that read like the class line a person would see. */
function line(atom: Atom): string {
  const parts: string[] = [atom.kind];
  if (atom.field !== null) parts.push(`field=${atom.field}`);
  if (atom.before !== null) parts.push(`before=${JSON.stringify(atom.before)}`);
  if (atom.after !== null) parts.push(`after=${JSON.stringify(atom.after)}`);
  if (atom.detail !== null) parts.push(`detail=${JSON.stringify(atom.detail)}`);
  if (atom.rule !== null) parts.push(`rule=${ruleWords(atom.rule)}`);
  return parts.join(" | ");
}

const lines = (diff: FileDiff): string[] => diff.atoms.map(line);
const kindsOf = (diff: FileDiff): ClassKind[] => diff.atoms.map((a) => a.kind);

describe("diffTable: the key column comes from the file name, and only if it identifies rows", () => {
  const same = (path: string, header: string[]) => {
    const text = tsv(
      header,
      header.map((_, i) => `v${i}`),
      header.map((_, i) => `w${i}`),
    );
    return diffText(path, text, text);
  };

  test("each key column of design section 2.2", () => {
    expect(same("participants.tsv", ["participant_id", "age"]).keyColumn).toBe("participant_id");
    expect(same("sub-01/eeg/sub-01_task-x_channels.tsv", ["name", "type"]).keyColumn).toBe("name");
    expect(same("sub-01/eeg/sub-01_electrodes.tsv", ["name", "x"]).keyColumn).toBe("name");
    expect(same("sub-01/sub-01_scans.tsv", ["filename", "acq_time"]).keyColumn).toBe("filename");
    expect(same("sub-01/sub-01_sessions.tsv", ["session_id", "age"]).keyColumn).toBe("session_id");
    expect(same("samples.tsv", ["sample_id", "type"]).keyColumn).toBe("sample_id");
  });

  test("any other table has no key, however key-like its first column", () => {
    expect(
      same("sub-01/eeg/sub-01_task-x_events.tsv", ["onset", "trial_type"]).keyColumn,
    ).toBeNull();
    expect(same("phenotype/iq.tsv", ["participant_id", "iq"]).keyColumn).toBeNull();
    // participants.tsv and samples.tsv are the ROOT files; one deeper is a different table.
    expect(same("sourcedata/participants.tsv", ["participant_id", "age"]).keyColumn).toBeNull();
    expect(same("derivatives/samples.tsv", ["sample_id", "type"]).keyColumn).toBeNull();
    // A name that merely ends like a channels file does not have the underscore of one.
    expect(same("channels.tsv", ["name", "type"]).keyColumn).toBeNull();
    expect(same("sub-01_xchannels.tsv", ["name", "type"]).keyColumn).toBeNull();
    expect(same("sub-01_xelectrodes.tsv", ["name", "x"]).keyColumn).toBeNull();
    expect(same("sub-01/sub-01_xscans.tsv", ["filename", "acq_time"]).keyColumn).toBeNull();
    expect(same("sub-01/scans.tsv", ["filename", "acq_time"]).keyColumn).toBeNull();
    expect(same("sub-01/sub-01_xsessions.tsv", ["session_id", "age"]).keyColumn).toBeNull();
    expect(same("sub-01/sessions.tsv", ["session_id", "age"]).keyColumn).toBeNull();
  });

  test("the key is used only when its values are non-empty, not n/a, and unique on BOTH sides", () => {
    const path = "sub-01_channels.tsv";
    const header = ["name", "type"];
    const good = tsv(header, ["A1", "EEG"], ["A2", "EEG"]);
    expect(diffText(path, good, good).keyColumn).toBe("name");
    for (const bad of [
      tsv(header, ["A1", "EEG"], ["A1", "EMG"]), // a repeated key
      tsv(header, ["A1", "EEG"], ["", "EEG"]), // an empty key
      tsv(header, ["A1", "EEG"], ["n/a", "EEG"]), // a missing key
    ]) {
      expect(diffText(path, bad, good).keyColumn, "bad before").toBeNull();
      expect(diffText(path, good, bad).keyColumn, "bad after").toBeNull();
    }
    // The key column in only one header: keyless.
    expect(diffText(path, good, tsv(["label", "type"], ["A1", "EEG"])).keyColumn).toBeNull();
    expect(diffText(path, tsv(["label", "type"], ["A1", "EEG"]), good).keyColumn).toBeNull();
    // A table with no rows has no key values to doubt.
    expect(diffText(path, tsv(header), tsv(header)).keyColumn).toBe("name");
  });
});

describe("diffTable: a table that did not change has nothing to say", () => {
  test("equal bytes give no atom, and every row is matched", () => {
    const text = tsv(["name", "type"], ["A1", "EEG"], ["A2", "EMG"]);
    for (const path of ["sub-01_channels.tsv", "events.tsv"]) {
      const diff = diffText(path, text, text);
      expect(diff.atoms).toEqual([]);
      expect(diff.family).toBe("tsv");
      expect(diff.counts).toMatchObject({
        beforeRows: 2,
        afterRows: 2,
        matched: 2,
        paired: 0,
        removed: 0,
        added: 0,
      });
    }
  });

  test("a header with no rows, and a table with only a header change", () => {
    expect(diffText("e.tsv", tsv(["a", "b"]), tsv(["a", "b"])).atoms).toEqual([]);
    expect(lines(diffText("e.tsv", tsv(["a", "b"]), tsv(["a", "c"])))).toEqual([
      'column_removed | field=b | detail="0"',
      "column_added | field=c",
    ]);
  });
});

describe("diffTable: columns", () => {
  test("a removed column carries how many non-missing values it held; n/a and empty do not count", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["onset", "note", "tag"], ["1", "x", "n/a"], ["2", "n/a", ""], ["3", "y", "None"]),
      tsv(["onset"], ["1"], ["2"], ["3"]),
    );
    expect(lines(diff)).toEqual([
      'column_removed | field=note | detail="2"',
      'column_removed | field=tag | detail="1"',
    ]);
    expect(diff.counts).toMatchObject({
      beforeColumns: 3,
      afterColumns: 1,
      commonColumns: 1,
      columnsRemoved: 2,
      columnsAdded: 0,
    });
  });

  test("an added column is an atom and its values are not compared", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["onset"], ["1"], ["2"]),
      tsv(["onset", "note"], ["1", "x"], ["2", "y"]),
    );
    expect(lines(diff)).toEqual(["column_added | field=note"]);
  });

  test("the order of the columns both versions have is one atom, naming both orders", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["a", "b", "c"], ["1", "2", "3"]),
      tsv(["c", "a", "b"], ["3", "1", "2"]),
    );
    expect(lines(diff)).toEqual(['columns_reordered | before="a\\tb\\tc" | after="c\\ta\\tb"']);
    // Adding a column between two that kept their order does not reorder them.
    expect(
      kindsOf(
        diffText("events.tsv", tsv(["a", "b"], ["1", "2"]), tsv(["a", "z", "b"], ["1", "9", "2"])),
      ),
    ).toEqual(["column_added"]);
  });

  test("a renamed column is a removal of the old and an addition of the new, never a quiet match", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["onset", "kind"], ["1", "go"]),
      tsv(["onset", "type"], ["1", "go"]),
    );
    expect(kindsOf(diff)).toEqual(["column_removed", "column_added"]);
    // A column name is its exact text: case and a trailing space make another column, whichever
    // side has the respelling.
    for (const renamed of ["Kind", "kind ", "KIND"]) {
      const respelled = diffText(
        "events.tsv",
        tsv(["onset", "kind"], ["1", "go"]),
        tsv(["onset", renamed], ["1", "go"]),
      );
      expect(lines(respelled), renamed).toEqual([
        'column_removed | field=kind | detail="1"',
        `column_added | field=${renamed}`,
      ]);
      const back = diffText(
        "events.tsv",
        tsv(["onset", renamed], ["1", "go"]),
        tsv(["onset", "kind"], ["1", "go"]),
      );
      expect(lines(back), renamed).toEqual([
        `column_removed | field=${renamed} | detail="1"`,
        "column_added | field=kind",
      ]);
    }
  });
});

describe("diffTable: cells of paired rows", () => {
  const cell = (before: string, after: string): string[] =>
    lines(diffText("events.tsv", tsv(["id", "v"], ["1", before]), tsv(["id", "v"], ["1", after])));

  test("a changed value, an emptied cell, a filled cell", () => {
    expect(cell("good", "bad")).toEqual(['cell_replaced | field=v | before="good" | after="bad"']);
    expect(cell("good", "n/a")).toEqual(['cell_emptied | field=v | before="good" | after="n/a"']);
    expect(cell("good", "")).toEqual(['cell_emptied | field=v | before="good" | after=""']);
    expect(cell("n/a", "good")).toEqual(['cell_filled | field=v | before="n/a" | after="good"']);
    expect(cell("", "good")).toEqual(['cell_filled | field=v | before="" | after="good"']);
  });

  test("n/a and empty are both missing, so one becoming the other is a replaced value, not a quiet pass", () => {
    expect(cell("n/a", "")).toEqual(['cell_replaced | field=v | before="n/a" | after=""']);
    expect(cell("", "n/a")).toEqual(['cell_replaced | field=v | before="" | after="n/a"']);
  });

  test("None, unknown and NA are values: overwriting one is a replacement, never a fill", () => {
    expect(cell("None", "F")).toEqual(['cell_replaced | field=v | before="None" | after="F"']);
    expect(cell("unknown", "n/a")).toEqual([
      'cell_emptied | field=v | before="unknown" | after="n/a"',
    ]);
    expect(cell("NA", "5")).toEqual(['cell_replaced | field=v | before="NA" | after="5"']);
  });

  test("a cell's letter case is part of its value: a case change in a cell is a replaced value", () => {
    // mV is millivolts and MV megavolts; a key's case only spells a name, a cell's can mean a unit.
    expect(cell("mV", "MV")).toEqual(['cell_replaced | field=v | before="mV" | after="MV"']);
    expect(cell("Cz", "CZ")).toEqual(['cell_replaced | field=v | before="Cz" | after="CZ"']);
  });

  test("a cell changed by wrap, strip or repad is a template with its rule", () => {
    expect(cell("A01", "A1")).toEqual([
      'cell_templated | field=v | before="A01" | after="A1" | rule=zero padding of numbers changed',
    ]);
    expect(cell("5", "5 mm")).toEqual([
      'cell_templated | field=v | before="5" | after="5 mm" | rule=added suffix " mm"',
    ]);
    expect(cell("'G1'    ", "'G1'")).toEqual([
      'cell_templated | field=v | before="\'G1\'    " | after="\'G1\'" | rule=removed suffix "    "',
    ]);
  });

  test("an insertion, a deletion and a character rule are for names: in a cell they are a replaced value", () => {
    expect(cell("GA01", "EEGGA_01REF")).toEqual([
      'cell_replaced | field=v | before="GA01" | after="EEGGA_01REF"',
    ]);
    expect(cell("EEGGA_01REF", "GA01")).toEqual([
      'cell_replaced | field=v | before="EEGGA_01REF" | after="GA01"',
    ]);
    expect(cell("DCEMBRACE", "DC EMBRACE-REF")).toEqual([
      'cell_replaced | field=v | before="DCEMBRACE" | after="DC EMBRACE-REF"',
    ]);
  });

  test("a cell that gains or loses text with a number in it is a replaced value, not a template", () => {
    expect(cell("A1", "A1-A2")).toEqual(['cell_replaced | field=v | before="A1" | after="A1-A2"']);
    expect(cell("5 mm", "5")).toEqual([
      'cell_templated | field=v | before="5 mm" | after="5" | rule=removed suffix " mm"',
    ]);
  });

  test("a changed number is a replaced value, not a suffix or a padding", () => {
    expect(cell("64", "640")).toEqual(['cell_replaced | field=v | before="64" | after="640"']);
    expect(cell("1", "01")).toEqual(['cell_replaced | field=v | before="1" | after="01"']);
    expect(cell("1.5", "1.50")).toEqual(['cell_replaced | field=v | before="1.5" | after="1.50"']);
  });

  test("whitespace is data: a cell gaining a trailing space is a change", () => {
    expect(cell("good", "good ")).toEqual([
      'cell_templated | field=v | before="good" | after="good " | rule=added suffix " "',
    ]);
  });

  test("a cell is compared in the column it is in, not at its position", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["id", "a", "b"], ["1", "x", "y"]),
      tsv(["b", "id", "a"], ["z", "1", "x"]),
    );
    expect(lines(diff)).toEqual(
      expect.arrayContaining(['cell_replaced | field=b | before="y" | after="z"']),
    );
    expect(kindsOf(diff)).toEqual(["columns_reordered", "cell_replaced"]);
  });
});

describe("diffTable: keyed rows", () => {
  const path = "sub-01_task-x_channels.tsv";
  const header = ["name", "type"];

  test("a row with a key only the before side has is removed, and one only the after side has is added", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["Z9", "EMG"]),
      tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["Q7", "EOG"]),
    );
    expect(lines(diff)).toEqual([
      'row_removed | field=name | before="Z9"',
      'row_added | field=name | after="Q7"',
    ]);
    expect(diff.counts).toMatchObject({
      matched: 2,
      removed: 1,
      added: 1,
      paired: 0,
      relocated: 0,
    });
  });

  test("a key kept is the same row: its other cells are compared, and moving it is a reorder", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A3", "EEG"]),
      tsv(header, ["A3", "EEG"], ["A1", "EMG"], ["A2", "EEG"]),
    );
    expect(lines(diff)).toEqual([
      'cell_replaced | field=type | before="EEG" | after="EMG"',
      "rows_reordered",
    ]);
  });

  test("rows that only moved are a reorder and nothing else", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"]),
      tsv(header, ["A2", "EEG"], ["A1", "EEG"]),
    );
    expect(lines(diff)).toEqual(["rows_reordered"]);
  });

  test("a removed row among kept rows does not make the others a reorder", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A3", "EEG"]),
      tsv(header, ["A1", "EEG"], ["A3", "EEG"]),
    );
    expect(lines(diff)).toEqual(['row_removed | field=name | before="A2"']);
  });

  test("the real prefix: every name gained POL, with the number's padding changed, other cells equal", () => {
    const before = tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A10", "EEG"]);
    const after = tsv(header, ["POL A01", "EEG"], ["POL A02", "EEG"], ["POL A10", "EEG"]);
    const diff = diffText(path, before, after);
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A01" | rule=added prefix "POL ", zero padding of numbers changed',
      'key_relabeled | field=name | before="A2" | after="POL A02" | rule=added prefix "POL ", zero padding of numbers changed',
      'key_relabeled | field=name | before="A10" | after="POL A10" | rule=added prefix "POL "',
    ]);
    expect(diff.counts).toMatchObject({ matched: 0, paired: 3, removed: 0, added: 0 });
  });

  test("the real wrap on both sides: EEG and -Ref around a name", () => {
    const diff = diffText(
      path,
      tsv(header, ["Fp1", "EEG"], ["Fz", "EEG"]),
      tsv(header, ["EEG Fp1-Ref", "EEG"], ["EEG Fz-Ref", "EEG"]),
    );
    expect(kindsOf(diff)).toEqual(["key_relabeled", "key_relabeled"]);
    expect((diff.atoms[0] as Atom).rule).toEqual({
      kind: "wrap",
      gaps: ["EEG ", "-Ref"],
      shape: "",
      repadded: false,
    });
  });

  test("the real insert: GA01 became EEGGA_01REF, found by position with every other cell equal", () => {
    const diff = diffText(
      path,
      tsv(header, ["GA01", "EEG"], ["GA02", "EEG"]),
      tsv(header, ["EEGGA_01REF", "EEG"], ["EEGGA_02REF", "EEG"]),
    );
    expect(kindsOf(diff)).toEqual(["key_relabeled", "key_relabeled"]);
    expect((diff.atoms[0] as Atom).rule).toEqual({
      kind: "insert",
      gaps: ["EEG", "_", "REF"],
      shape: "LD",
      repadded: false,
    });
    expect(diff.counts).toMatchObject({ paired: 2, removed: 0, added: 0 });
  });

  test("the real characters: DCEMBRACE became DC EMBRACE-REF, paired because every other cell is equal", () => {
    const diff = diffText(
      path,
      tsv(header, ["DCEMBRACE", "EEG"]),
      tsv(header, ["DC EMBRACE-REF", "EEG"]),
    );
    expect(kindsOf(diff)).toEqual(["key_relabeled"]);
    expect((diff.atoms[0] as Atom).rule?.shape).toBe("c9");
  });

  test("a character rule needs the other cells to be equal: with one changed, it is a removal and an addition", () => {
    const diff = diffText(
      path,
      tsv(header, ["DCEMBRACE", "EEG"]),
      tsv(header, ["DC EMBRACE-REF", "EMG"]),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
  });

  test("a key changed into something unrelated gets no rule: the old row is removed, the new one added", () => {
    const diff = diffText(path, tsv(header, ["A1", "EEG"]), tsv(header, ["Q7", "EEG"]));
    expect(lines(diff)).toEqual([
      'row_removed | field=name | before="A1"',
      'row_added | field=name | after="Q7"',
    ]);
  });

  test("a relabeled row whose other cells changed too shows the key and the cells", () => {
    // Lenient pairing: the name is a prefix, the type changed but the units did not, so the equal
    // cells (one) are at least as many as the changed ones (one).
    const three = ["name", "type", "units"];
    const diff = diffText(
      path,
      tsv(three, ["Fz", "EEG", "uV"]),
      tsv(three, ["EEG Fz", "EMG", "uV"]),
    );
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="Fz" | after="EEG Fz" | rule=added prefix "EEG "',
      'cell_replaced | field=type | before="EEG" | after="EMG"',
    ]);
  });

  test("a lenient relabel needs at least as many equal cells as changed ones, and at least one", () => {
    const three = ["name", "type", "units"];
    // The reviewer's pairs: a prefix, a suffix and an insertion each hold as a rule, but every other
    // cell changed, so the old channel is removed and the new one added.
    for (const [before, after] of [
      [
        ["Fz", "EEG", "uV"],
        ["EEG Fz", "MISC", "mV"],
      ],
      [
        ["FC3", "EEG", "uV"],
        ["FCC3h", "MISC", "mV"],
      ],
      [
        ["LA1", "SEEG", "uV"],
        ["LA1-LA2", "BIP", "mV"],
      ],
    ]) {
      expect(kindsOf(diffText(path, tsv(three, before), tsv(three, after))), `${before}`).toEqual([
        "row_removed",
        "row_added",
      ]);
    }
    // Two changed and one equal: still more change than evidence.
    const four = ["name", "type", "units", "low_cutoff"];
    expect(
      kindsOf(
        diffText(
          path,
          tsv(four, ["LA1", "SEEG", "uV", "0.5"]),
          tsv(four, ["LA1-LA2", "SEEG", "mV", "1"]),
        ),
      ),
    ).toEqual(["row_removed", "row_added"]);
    // An equal cell that is missing on both sides is no evidence.
    expect(
      kindsOf(
        diffText(path, tsv(three, ["Fz", "EEG", "n/a"]), tsv(three, ["EEG Fz", "EMG", "n/a"])),
      ),
    ).toEqual(["row_removed", "row_added"]);
  });

  test("a case or padding relabel needs no evidence: it changes how a key is spelled, not which key", () => {
    const three = ["name", "type", "units"];
    expect(
      kindsOf(diffText(path, tsv(three, ["Cz", "EEG", "uV"]), tsv(three, ["CZ", "MISC", "mV"]))),
    ).toEqual(["key_relabeled", "cell_replaced", "cell_replaced"]);
    expect(
      kindsOf(diffText(path, tsv(three, ["A1", "EEG", "uV"]), tsv(three, ["A01", "MISC", "mV"]))),
    ).toEqual(["key_relabeled", "cell_replaced", "cell_replaced"]);
  });

  test("names that are other channels never pair, whatever the other cells say", () => {
    const three = ["name", "type", "units"];
    for (const [before, after] of [
      ["A1", "A10"],
      ["A10", "A1"],
      ["Cz", "FCz"],
      ["Pz", "POz"],
      ["FCz", "Cz"],
    ]) {
      expect(
        kindsOf(
          diffText(
            path,
            tsv(three, [before as string, "EEG", "uV"]),
            tsv(three, [after as string, "EEG", "uV"]),
          ),
        ),
        `${before} -> ${after}`,
      ).toEqual(["row_removed", "row_added"]);
    }
  });

  test("a removed row among 500 relabeled rows is still a row_removed atom", () => {
    const names = Array.from({ length: 501 }, (_, i) => `A${i + 1}`);
    const before = tsv(header, ...names.map((n) => [n, "EEG"]));
    // The row for A250 is gone; every other name gained the prefix POL.
    const after = tsv(header, ...names.filter((n) => n !== "A250").map((n) => [`POL ${n}`, "EEG"]));
    const diff = diffText(path, before, after);
    const removed = diff.atoms.filter((a) => a.kind === "row_removed");
    expect(removed.map(line)).toEqual(['row_removed | field=name | before="A250"']);
    expect(diff.atoms.filter((a) => a.kind === "key_relabeled")).toHaveLength(500);
    expect(diff.counts).toMatchObject({ paired: 500, removed: 1, added: 0 });
    // Every relabel is the same rule, so they are one class; the removal is not among them.
    const rules = new Set(
      diff.atoms
        .filter((a) => a.kind === "key_relabeled")
        .map((a) => ruleWords(a.rule as RelabelRule)),
    );
    expect(rules.size).toBe(1);
  });

  test("a number split, merged, added or dropped is another channel, whatever the other cells say", () => {
    const seven = [
      "name",
      "type",
      "units",
      "sampling_frequency",
      "low_cutoff",
      "high_cutoff",
      "status",
    ];
    const row = (name: string) => [name, "SEEG", "uV", "1000", "0.1", "300", "good"];
    for (const [before, after] of [
      ["LA12", "LA1-LA2"],
      ["LA1-LA2", "LA12"],
      ["LA12", "LA1-2"],
      ["LA1-2", "LA12"],
      ["E10", "E1.0"],
      ["A1", "A1-A2"],
      ["A1-A2", "A2"],
    ]) {
      expect(
        kindsOf(
          diffText(
            path,
            tsv(seven, row("LA11"), row(before as string), row("LB1")),
            tsv(seven, row("LA11"), row(after as string), row("LB1")),
          ),
        ),
        `${before} -> ${after}`,
      ).toEqual(["row_removed", "row_added"]);
    }
    expect(
      kindsOf(
        diffText(
          "participants.tsv",
          tsv(["participant_id", "age"], ["sub-12", "30"]),
          tsv(["participant_id", "age"], ["sub-1-2", "30"]),
        ),
      ),
    ).toEqual(["row_removed", "row_added"]);
  });

  test("the real pairs still pair when every other cell is equal and says something", () => {
    const three = ["name", "type", "units"];
    for (const [before, after] of [
      ["DCEMBRACE", "DC EMBRACE-REF"],
      ["DC EMBRACE-REF", "DCEMBRACE"],
      ["A01", "POL A01"],
      ["GA01", "EEGGA_01REF"],
      ["Cz", "CZ"],
    ]) {
      expect(
        kindsOf(
          diffText(
            path,
            tsv(three, [before as string, "EEG", "uV"]),
            tsv(three, [after as string, "EEG", "uV"]),
          ),
        ),
        `${before} -> ${after}`,
      ).toEqual(["key_relabeled"]);
    }
    expect(
      kindsOf(
        diffText(
          "participants.tsv",
          tsv(["participant_id", "age"], ["sub-1", "30"]),
          tsv(["participant_id", "age"], ["sub-01", "30"]),
        ),
      ),
    ).toEqual(["key_relabeled"]);
  });

  test("a removed row whose key looks like a relabeled one is still removed when its cells differ and nothing is left to pair", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["B1", "EMG"]),
      tsv(header, ["POL A1", "EEG"]),
    );
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A1" | rule=added prefix "POL "',
      'row_removed | field=name | before="B1"',
    ]);
  });
});

describe("diffTable: the same change gives the same atoms whatever else is in the file", () => {
  const path = "sub-01_task-x_channels.tsv";
  const header = ["name", "type", "units"];

  test("different unrelated rows, offsets and row counts around one relabel, one removal and one cell edit", () => {
    const changed = (extra: string[][]) => {
      const before = tsv(
        header,
        ...extra,
        ["A1", "EEG", "uV"],
        ["B7", "EEG", "uV"],
        ["C3", "EEG", "uV"],
      );
      const after = tsv(header, ...extra, ["POL A01", "EEG", "uV"], ["C3", "EMG", "uV"]);
      return diffText(path, before, after).atoms;
    };
    const base = changed([]);
    expect(base.map(line)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A01" | rule=added prefix "POL ", zero padding of numbers changed',
      'row_removed | field=name | before="B7"',
      'cell_replaced | field=type | before="EEG" | after="EMG"',
    ]);
    expect(changed([["Z1", "EEG", "uV"]])).toEqual(base);
    expect(
      changed([
        ["Z1", "EEG", "uV"],
        ["Z2", "ECG", "mV"],
        ["Z3", "n/a", "n/a"],
      ]),
    ).toEqual(base);
    expect(changed(Array.from({ length: 40 }, (_, i) => [`Y${i}`, "EEG", "uV"]))).toEqual(base);
  });

  test("the same keyless edit in two files with different rows around it", () => {
    const edit = (rows: string[][]) =>
      diffText(
        "events.tsv",
        tsv(["onset", "duration", "trial_type"], ...rows, ["5", "1", "go"]),
        tsv(["onset", "duration", "trial_type"], ...rows, ["5", "1", "stop"]),
      ).atoms;
    const base = edit([]);
    expect(base.map(line)).toEqual([
      'cell_replaced | field=trial_type | before="go" | after="stop"',
    ]);
    expect(
      edit([
        ["1", "1", "x"],
        ["2", "1", "y"],
      ]),
    ).toEqual(base);
    expect(edit(Array.from({ length: 30 }, (_, i) => [String(i), "1", "z"]))).toEqual(base);
  });
});

describe("diffTable: a strict relabel needs a cell that says something, not just equal cells", () => {
  // Equal cells that are all missing, or no cell but the key, are equal vacuously. Pairing `sub-1`
  // removed with `sub-10` added on that ground would call a participant that is gone a renamed one
  // and raise no loss fact.
  test("a table of ids alone: sub-1 removed and sub-10 added are a removed row and an added one", () => {
    const diff = diffText(
      "participants.tsv",
      tsv(["participant_id"], ["sub-1"], ["sub-2"]),
      tsv(["participant_id"], ["sub-2"], ["sub-10"]),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
  });

  test("equal cells that are all missing are not evidence either", () => {
    const diff = diffText(
      "participants.tsv",
      tsv(["participant_id", "age"], ["sub-1", "n/a"], ["sub-2", "n/a"]),
      tsv(["participant_id", "age"], ["sub-2", "n/a"], ["sub-10", "n/a"]),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
  });

  test("an equal cell that says something is evidence: the same age under the new name is a relabel", () => {
    const diff = diffText(
      "participants.tsv",
      tsv(["participant_id", "age"], ["1", "30"], ["sub-2", "31"]),
      tsv(["participant_id", "age"], ["sub-2", "31"], ["sub-1", "30"]),
    );
    expect(lines(diff)).toEqual([
      'key_relabeled | field=participant_id | before="1" | after="sub-1" | rule=added prefix "sub-"',
      "rows_reordered",
    ]);
    // The same pair with no cell that says anything is a removal and an addition.
    expect(
      kindsOf(
        diffText(
          "participants.tsv",
          tsv(["participant_id"], ["1"]),
          tsv(["participant_id"], ["sub-1"]),
        ),
      ),
    ).toEqual(["row_removed", "row_added"]);
  });

  test("sub-1 and sub-10 are two participants, whatever the other cells say", () => {
    const diff = diffText(
      "participants.tsv",
      tsv(
        ["participant_id", "age", "sex", "handedness"],
        ["sub-1", "23", "M", "R"],
        ["sub-2", "30", "F", "R"],
      ),
      tsv(
        ["participant_id", "age", "sex", "handedness"],
        ["sub-2", "30", "F", "R"],
        ["sub-10", "23", "M", "R"],
      ),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
  });

  test("a rule that keeps the name's letters and digit values still pairs without cell evidence", () => {
    // Zero padding and case change a participant's spelling, not the participant.
    expect(
      kindsOf(
        diffText(
          "participants.tsv",
          tsv(["participant_id"], ["sub-1"]),
          tsv(["participant_id"], ["sub-01"]),
        ),
      ),
    ).toEqual(["key_relabeled"]);
    expect(
      kindsOf(
        diffText(
          "participants.tsv",
          tsv(["participant_id"], ["sub-a"]),
          tsv(["participant_id"], ["SUB-A"]),
        ),
      ),
    ).toEqual(["key_relabeled"]);
  });
});

describe("diffTable: the pairing order is strict relabel, then relocation, then lenient relabel", () => {
  const path = "sub-01_channels.tsv";
  const header = ["name", "v"];

  test("strict before lenient: the candidate whose other cells are equal is the one paired, not the first", () => {
    // Both Cz and cz are the case-only relabel of CZ; only cz has the same value, so only it is the
    // same row. Pairing the first in file order would call v 1 -> 2 an edit and remove the right row.
    const diff = diffText(path, tsv(header, ["Cz", "1"], ["cz", "2"]), tsv(header, ["CZ", "2"]));
    expect(lines(diff)).toEqual([
      'row_removed | field=name | before="Cz"',
      'key_relabeled | field=name | before="cz" | after="CZ" | rule=letter case changed',
    ]);
  });

  test("strict by position before lenient: the pair whose cells are equal wins over the nearer name", () => {
    const diff = diffText(
      path,
      tsv(header, ["GA01", "1"], ["GA02", "2"]),
      tsv(header, ["EEGGA_02REF", "2"], ["EEGGA_01REF", "1"]),
    );
    // Each new name is the relabel of BOTH old names' shapes; the equal value says which.
    expect(lines(diff)).toEqual([
      expect.stringContaining('before="GA01" | after="EEGGA_01REF"'),
      expect.stringContaining('before="GA02" | after="EEGGA_02REF"'),
      "rows_reordered",
    ]);
  });

  test("relocation before lenient relabel: a removed row found verbatim in sourcedata is not paired with a look-alike", () => {
    const three = ["name", "type", "v"];
    const copy = pooled(`sourcedata/removed/${path}`, null, tsv(three, ["A1", "EEG", "7"]));
    // A1 was removed and kept in sourcedata. POL A1 is a NEW row that happens to wrap the name.
    const before = tsv(three, ["A1", "EEG", "7"], ["B1", "EEG", "1"]);
    const after = tsv(three, ["B1", "EEG", "1"], ["POL A1", "EEG", "9"]);
    expect(lines(diffText(path, before, after, [copy]))).toEqual([
      'row_relocated | field=name | before="A1" | detail="sourcedata/removed/sub-*_channels.tsv"',
      'row_added | field=name | after="POL A1"',
    ]);
    // Without the copy the same rows are paired by the lenient pass: one equal cell, one changed.
    expect(lines(diffText(path, before, after))).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A1" | rule=added prefix "POL "',
      'cell_replaced | field=v | before="7" | after="9"',
      "rows_reordered",
    ]);
  });

  test("strict by position before relocation: a character relabel is paired even with a copy in sourcedata", () => {
    const three = ["name", "type", "units"];
    const copy = pooled(`sourcedata/removed/${path}`, null, tsv(three, ["DCEMBRACE", "EEG", "uV"]));
    const diff = diffText(
      path,
      tsv(three, ["DCEMBRACE", "EEG", "uV"]),
      tsv(three, ["DC EMBRACE-REF", "EEG", "uV"]),
      [copy],
    );
    expect(kindsOf(diff)).toEqual(["key_relabeled"]);
    expect(diff.counts.relocated).toBe(0);
  });

  test("strict relabel before relocation: a renamed row is paired even when an identical copy exists elsewhere", () => {
    // The first prototype relocated first and matched renamed rows to identical copies in other
    // subjects' files. Here the row is relabeled (every other cell equal), and the copy stays unused.
    const copies = [pooled(`sourcedata/removed/${path}`, null, tsv(header, ["A1", "7"]))];
    const diff = diffText(path, tsv(header, ["A1", "7"]), tsv(header, ["POL A1", "7"]), copies);
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A1" | rule=added prefix "POL "',
    ]);
    expect(diff.counts.relocated).toBe(0);
  });
});

describe("diffTable: the lookup passes find relabels the positional walk cannot", () => {
  const path = "sub-01_task-x_channels.tsv";
  const header = ["name", "type", "v"];
  const relabels = (diff: FileDiff): string[] =>
    diff.atoms.filter((a) => a.kind === "key_relabeled").map((a) => `${a.before} -> ${a.after}`);

  test("a case-only relabel in reversed order pairs every row", () => {
    const hdr = ["participant_id", "age"];
    const diff = diffText(
      "participants.tsv",
      tsv(hdr, ["sub-a", "30"], ["sub-b", "31"], ["sub-c", "32"]),
      tsv(hdr, ["SUB-C", "32"], ["SUB-B", "31"], ["SUB-A", "30"]),
    );
    expect(relabels(diff)).toEqual(["sub-a -> SUB-A", "sub-b -> SUB-B", "sub-c -> SUB-C"]);
    expect(kindsOf(diff).filter((k) => k !== "key_relabeled")).toEqual(["rows_reordered"]);
  });

  test("each added key's parts are looked up among the gone keys: a wrap in reversed order", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG", "x"], ["A2", "EEG", "y"], ["A3", "EEG", "z"]),
      tsv(header, ["POL A3", "EEG", "z"], ["POL A2", "EEG", "y"], ["POL A1", "EEG", "x"]),
    );
    expect(relabels(diff)).toEqual(["A1 -> POL A1", "A2 -> POL A2", "A3 -> POL A3"]);
  });

  test("the lookup reads digits by value: a wrap that also repads is found in reversed order", () => {
    // The positional walk cannot pair a reversed list; only the lookup can, and only when it
    // indexes `A1` and the `A01` inside `POL A01` as one form.
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG", "x"], ["A2", "EEG", "y"], ["A3", "EEG", "z"]),
      tsv(header, ["POL A03", "EEG", "z"], ["POL A02", "EEG", "y"], ["POL A01", "EEG", "x"]),
    );
    expect(relabels(diff)).toEqual(["A1 -> POL A01", "A2 -> POL A02", "A3 -> POL A03"]);
  });

  test("each gone key's parts are looked up among the added keys: a strip in reversed order", () => {
    const diff = diffText(
      path,
      tsv(header, ["POL A1", "EEG", "x"], ["POL A2", "EEG", "y"], ["POL A3", "EEG", "z"]),
      tsv(header, ["A3", "EEG", "z"], ["A2", "EEG", "y"], ["A1", "EEG", "x"]),
    );
    expect(relabels(diff)).toEqual(["POL A1 -> A1", "POL A2 -> A2", "POL A3 -> A3"]);
  });

  test("the strict lookup runs before relocation: out-of-order relabels keep their copy unused", () => {
    const copy = pooled(`sourcedata/removed/${path}`, null, tsv(header, ["A1", "EEG", "x"]));
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG", "x"], ["A2", "EEG", "y"], ["A3", "EEG", "z"]),
      tsv(header, ["POL A3", "EEG", "z"], ["POL A2", "EEG", "y"], ["POL A1", "EEG", "x"]),
      [copy],
    );
    expect(relabels(diff)).toEqual(["A1 -> POL A1", "A2 -> POL A2", "A3 -> POL A3"]);
    expect(diff.counts.relocated).toBe(0);
  });

  test("the lenient lookup pairs out of order when the evidence holds though a cell changed", () => {
    const four = ["name", "type", "units", "v"];
    const diff = diffText(
      path,
      tsv(four, ["A1", "EEG", "uV", "1"], ["A2", "EEG", "uV", "2"], ["A3", "EEG", "uV", "3"]),
      tsv(
        four,
        ["POL A3", "EEG", "uV", "30"],
        ["POL A2", "EEG", "uV", "20"],
        ["POL A1", "EEG", "uV", "10"],
      ),
    );
    expect(relabels(diff)).toEqual(["A1 -> POL A1", "A2 -> POL A2", "A3 -> POL A3"]);
    expect(
      diff.atoms.filter((a) => a.kind === "cell_replaced").map((a) => `${a.before}>${a.after}`),
    ).toEqual(["1>10", "2>20", "3>30"]);
  });

  test("a lookup never takes a row that is already paired", () => {
    // Both gone keys contain Fz; the first takes it, and the second must not claim it again (a
    // second claim would be a conflict and refuse the whole file).
    const diff = diffText(
      path,
      tsv(header, ["EEG Fz", "EEG", "x"], ["Fz-Ref", "EEG", "x"]),
      tsv(header, ["Fz", "EEG", "x"]),
    );
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="EEG Fz" | after="Fz" | rule=removed prefix "EEG "',
      'row_removed | field=name | before="Fz-Ref"',
    ]);
  });

  test("the longest part of a key is looked up first", () => {
    // EEG Fz Cz contains both Fz Cz and Fz; the longer is its old name.
    const diff = diffText(
      path,
      tsv(header, ["Fz", "EEG", "x"], ["Fz Cz", "EEG", "x"]),
      tsv(header, ["EEG Fz Cz", "EEG", "x"], ["EEG Fz", "EEG", "x"]),
    );
    expect(relabels(diff)).toEqual(["Fz -> EEG Fz", "Fz Cz -> EEG Fz Cz"]);
  });

  test("among parts of one length the leftmost is looked up first", () => {
    const diff = diffText(
      path,
      tsv(header, ["Fz", "EEG", "x"], ["Cz", "EEG", "x"]),
      tsv(header, ["Fz Cz", "EEG", "x"]),
    );
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="Fz" | after="Fz Cz" | rule=added suffix " Cz"',
      'row_removed | field=name | before="Cz"',
    ]);
  });

  test("a number added to or taken from a name is no relabel: A1 and A2 removed, A1-A2 added", () => {
    // This pair used to read as A1 relabeled to A1-A2 (suffix "-A2"), with A2 removed. A bipolar
    // derivation is a new channel, not A1 respelled, and the text added holds a number, so no rule
    // may describe it: both monopolar rows are removed (loss facts) and the bipolar one is added.
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG", "x"], ["A2", "EEG", "x"]),
      tsv(header, ["A1-A2", "EEG", "x"]),
    );
    expect(lines(diff)).toEqual([
      'row_removed | field=name | before="A1"',
      'row_removed | field=name | before="A2"',
      'row_added | field=name | after="A1-A2"',
    ]);
    // And back: A1-A2 removed with A2 added is not A1-A2 losing "A1-".
    expect(
      kindsOf(diffText(path, tsv(header, ["A1-A2", "EEG", "x"]), tsv(header, ["A2", "EEG", "x"]))),
    ).toEqual(["row_removed", "row_added"]);
  });

  test("a lookup looks at no more than 64 candidates, the paired ones included", () => {
    // 70 gone and 72 added case variants of one word share one lookup form; only the last of each
    // side have the same cells. Two unrelated added variants come first, so the walk by position
    // passes the pair by too. The strict lookup gives up after 64 candidates in each direction, so
    // the pair is never found by its cells, and the lenient pass pairs every gone variant by case
    // alone, in order, each with its changed cells shown. Without the bound the strict lookup would
    // have found the last two.
    const variant = (i: number): string =>
      [..."abcdefgh"].map((ch, b) => ((i >> b) & 1 ? ch.toUpperCase() : ch)).join("");
    const gone = Array.from({ length: 70 }, (_, i) => [
      variant(i),
      "EEG",
      i === 69 ? "m" : `v${i}`,
    ]);
    const added = Array.from({ length: 72 }, (_, i) => [
      variant(100 + i),
      "EEG",
      i === 71 ? "m" : `w${i}`,
    ]);
    const diff = diffText(path, tsv(header, ...gone), tsv(header, ...added));
    expect(relabels(diff)).not.toContain(`${variant(69)} -> ${variant(171)}`);
    expect(relabels(diff)).toContain(`${variant(69)} -> ${variant(169)}`);
    expect(diff.counts).toMatchObject({ paired: 70, removed: 0, added: 2 });
  });
});

describe("diffTable: a lookup passes the paired front of its list", () => {
  test("100 renamed case variants pair by their cells even when the walk by position is out of step", () => {
    // Seventy unrelated variants come first in the after table: the walk by position is seventy rows
    // out of step and pairs nothing, and a gone key's own lookup meets 64 of them before any row it
    // could pair with. The added keys' lookup still pairs every row with the one whose cells it has,
    // because it passes the paired front of its list instead of counting it toward the cap;
    // otherwise the 65th row on would be paired by case alone, in order, with the wrong rows.
    const header = ["name", "type", "v"];
    const variant = (i: number): string =>
      [..."abcdefghi"].map((ch, b) => ((i >> b) & 1 ? ch.toUpperCase() : ch)).join("");
    const gone = Array.from({ length: 100 }, (_, i) => [variant(i), "EEG", `v${i}`]);
    const unrelated = Array.from({ length: 70 }, (_, i) => [variant(200 + i), "EEG", `w${i}`]);
    const added = [
      ...unrelated,
      ...Array.from({ length: 100 }, (_, i) => [variant(100 + i), "EEG", `v${i}`]),
    ];
    const diff = diffText(
      "sub-01_task-x_channels.tsv",
      tsv(header, ...gone),
      tsv(header, ...added),
    );
    expect(
      diff.atoms.filter((a) => a.kind === "key_relabeled").map((a) => `${a.before} -> ${a.after}`),
    ).toEqual(Array.from({ length: 100 }, (_, i) => `${variant(i)} -> ${variant(100 + i)}`));
    expect(diff.atoms.filter((a) => a.kind === "row_added").map((a) => a.after)).toEqual(
      unrelated.map((row) => row[0]),
    );
  });
});

describe("diffTable: the positional walk finds insertions the lookup cannot", () => {
  const path = "sub-01_task-x_channels.tsv";
  const header = ["name", "type"];
  const relabeled = (before: string[][], after: string[][]): string[] =>
    diffText(path, tsv(header, ...before), tsv(header, ...after))
      .atoms.filter((a) => a.kind === "key_relabeled")
      .map((a) => `${a.before} -> ${a.after}`);

  test("an added key in the way is skipped", () => {
    expect(
      relabeled(
        [["GA01", "EEG"]],
        [
          ["Q3", "EEG"],
          ["EEGGA_01REF", "EEG"],
        ],
      ),
    ).toEqual(["GA01 -> EEGGA_01REF"]);
  });

  test("a gone key in the way is skipped", () => {
    expect(
      relabeled(
        [
          ["X1", "EEG"],
          ["GA01", "EEG"],
        ],
        [["EEGGA_01REF", "EEG"]],
      ),
    ).toEqual(["GA01 -> EEGGA_01REF"]);
  });

  test("when neither can be skipped both pointers move, and the pair after them still meets", () => {
    expect(
      relabeled(
        [
          ["X1", "EEG"],
          ["GA01", "EEG"],
        ],
        [
          ["Y2", "EEG"],
          ["Q3", "EEG"],
          ["EEGGA_01REF", "EEG"],
        ],
      ),
    ).toEqual(["GA01 -> EEGGA_01REF"]);
    expect(
      relabeled(
        [
          ["X1", "EEG"],
          ["Y1", "EEG"],
          ["GA01", "EEG"],
        ],
        [
          ["P2", "EEG"],
          ["EEGGA_01REF", "EEG"],
        ],
      ),
    ).toEqual(["GA01 -> EEGGA_01REF"]);
  });
});

describe("diffTable: keyless tables", () => {
  const path = "sub-01_task-x_events.tsv";
  const header = ["onset", "duration", "trial_type"];

  test("rows are a multiset on the common columns: order does not matter, duplicates count", () => {
    const diff = diffText(
      path,
      tsv(header, ["1", "1", "go"], ["1", "1", "go"], ["2", "1", "stop"]),
      tsv(header, ["2", "1", "stop"], ["1", "1", "go"]),
    );
    // One go was removed; the rest moved.
    expect(lines(diff)).toEqual(['row_removed | before="1\\t1\\tgo"', "rows_reordered"]);
    expect(diff.counts).toMatchObject({ matched: 2, removed: 1 });
  });

  test("a deleted event and an unrelated new event are a removal and an addition, not an edit", () => {
    const diff = diffText(
      path,
      tsv(header, ["1", "1", "go"], ["5", "1", "stop"]),
      tsv(header, ["1", "1", "go"], ["9", "2", "rest"]),
    );
    expect(lines(diff)).toEqual([
      'row_removed | before="5\\t1\\tstop"',
      'row_added | after="9\\t2\\trest"',
    ]);
  });

  test("a pair is accepted only when at most half the common columns differ", () => {
    const four = ["a", "b", "c", "d"];
    const run = (after: string[]) =>
      diffText("t.tsv", tsv(four, ["1", "2", "3", "4"]), tsv(four, after));
    // Two of four differ: exactly half, so one row, edited in two cells.
    expect(kindsOf(run(["1", "2", "x", "y"]))).toEqual(["cell_replaced", "cell_replaced"]);
    // Three of four differ: more than half, so removed and added.
    expect(kindsOf(run(["1", "x", "y", "z"]))).toEqual(["row_removed", "row_added"]);
    // One of two differs: half. One of one: more than half.
    expect(
      kindsOf(diffText("t.tsv", tsv(["a", "b"], ["1", "2"]), tsv(["a", "b"], ["1", "x"]))),
    ).toEqual(["cell_replaced"]);
    expect(kindsOf(diffText("t.tsv", tsv(["a"], ["1"]), tsv(["a"], ["x"])))).toEqual([
      "row_removed",
      "row_added",
    ]);
  });

  test("an edited onset pairs the row, and the cell is shown", () => {
    const diff = diffText(path, tsv(header, ["1", "1", "go"]), tsv(header, ["1.5", "1", "go"]));
    expect(lines(diff)).toEqual(['cell_replaced | field=onset | before="1" | after="1.5"']);
  });

  test("cells equal only because they are missing are no evidence that two rows are one", () => {
    const events = [
      "onset",
      "duration",
      "trial_type",
      "value",
      "response_time",
      "stim_file",
      "HED",
    ];
    // Two of seven differ (at most half), but every equal cell is n/a: a removal and an addition.
    const diff = diffText(
      path,
      tsv(events, ["1.0", "n/a", "go", "n/a", "n/a", "n/a", "n/a"]),
      tsv(events, ["9.3", "n/a", "stop", "n/a", "n/a", "n/a", "n/a"]),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
    // With two equal cells that say something, the same two changes are an edit.
    const edited = diffText(
      path,
      tsv(events, ["1.0", "2", "go", "7", "n/a", "n/a", "n/a"]),
      tsv(events, ["9.3", "2", "stop", "7", "n/a", "n/a", "n/a"]),
    );
    expect(kindsOf(edited)).toEqual(["cell_replaced", "cell_replaced"]);
    // One equal cell that says something against two changed: not enough.
    const thin = diffText(
      path,
      tsv(events, ["1.0", "2", "go", "n/a", "n/a", "n/a", "n/a"]),
      tsv(events, ["9.3", "2", "stop", "n/a", "n/a", "n/a", "n/a"]),
    );
    expect(kindsOf(thin)).toEqual(["row_removed", "row_added"]);
  });

  test("a row is its cells joined with a tab: a cell cannot run into its neighbor", () => {
    // Joined without a separator both rows would be "abc" and look unchanged.
    const diff = diffText("events.tsv", tsv(["a", "b"], ["ab", "c"]), tsv(["a", "b"], ["a", "bc"]));
    expect(lines(diff)).toEqual(['row_removed | before="ab\\tc"', 'row_added | after="a\\tbc"']);
  });

  test("a keyless row is projected by column name: reordered columns match the same rows", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["a", "b"], ["1", "2"], ["3", "4"]),
      tsv(["b", "a"], ["2", "1"], ["4", "3"]),
    );
    expect(kindsOf(diff)).toEqual(["columns_reordered"]);
    expect(diff.counts.matched).toBe(2);
  });

  test("pairing skips a row that belongs to nothing so the ones after it still pair", () => {
    const diff = diffText(
      path,
      tsv(header, ["1", "1", "go"], ["7", "7", "gone"], ["3", "1", "stop"]),
      tsv(header, ["1", "1", "go"], ["3", "1", "stop"]),
    );
    // The middle row matched nothing, but the others are kept; no spurious pairs.
    expect(lines(diff)).toEqual(['row_removed | before="7\\t7\\tgone"']);
    const edited = diffText(
      path,
      tsv(header, ["5", "1", "go"], ["7", "7", "gone"], ["3", "1", "stop"]),
      tsv(header, ["5.5", "1", "go"], ["3", "1", "stop"]),
    );
    expect(lines(edited)).toEqual([
      'cell_replaced | field=onset | before="5" | after="5.5"',
      'row_removed | before="7\\t7\\tgone"',
    ]);
  });

  test("a row paired as an edit counts toward the order: moving it is a reorder", () => {
    // 1 0.5 go matches exactly; 2 0.5 stop is paired with 2 0.5 STOP as an edit. The edited row
    // moved in front of the other, and that is a reorder too.
    expect(
      lines(
        diffText(
          path,
          tsv(header, ["1", "0.5", "go"], ["2", "0.5", "stop"]),
          tsv(header, ["2", "0.5", "STOP"], ["1", "0.5", "go"]),
        ),
      ),
    ).toEqual([
      'cell_replaced | field=trial_type | before="stop" | after="STOP"',
      "rows_reordered",
    ]);
  });

  test("the two pointers skip a gone row, skip an added row, or advance both", () => {
    // A gone row in the way: the next gone row is the added one's.
    expect(
      lines(
        diffText(
          path,
          tsv(header, ["1", "1", "go"], ["5", "9", "x"], ["7", "1", "stop"]),
          tsv(header, ["1", "1", "go"], ["7.5", "1", "stop"]),
        ),
      ),
    ).toEqual([
      'row_removed | before="5\\t9\\tx"',
      'cell_replaced | field=onset | before="7" | after="7.5"',
    ]);
    // An added row in the way: the next added row is the gone one's.
    expect(
      lines(
        diffText(
          path,
          tsv(header, ["1", "1", "go"], ["7", "1", "stop"]),
          tsv(header, ["1", "1", "go"], ["5", "9", "x"], ["7.5", "1", "stop"]),
        ),
      ),
    ).toEqual([
      'cell_replaced | field=onset | before="7" | after="7.5"',
      'row_added | after="5\\t9\\tx"',
    ]);
    // Neither: both pointers move, and the pair after them still meets.
    expect(
      lines(
        diffText(
          path,
          tsv(header, ["5", "9", "x"], ["6", "8", "y"], ["7", "1", "stop"]),
          tsv(header, ["2", "3", "p"], ["4", "5", "q"], ["7.5", "1", "stop"]),
        ),
      ),
    ).toEqual([
      'row_removed | before="5\\t9\\tx"',
      'row_removed | before="6\\t8\\ty"',
      'cell_replaced | field=onset | before="7" | after="7.5"',
      'row_added | after="2\\t3\\tp"',
      'row_added | after="4\\t5\\tq"',
    ]);
  });

  test("a column only one version has is not part of the row identity, and the column is reported", () => {
    const diff = diffText(
      path,
      tsv([...header, "note"], ["1", "1", "go", "x"]),
      tsv(header, ["1", "1", "go"]),
    );
    expect(lines(diff)).toEqual(['column_removed | field=note | detail="1"']);
  });

  test("a keyed file whose keys are not usable is diffed as a multiset and loses nothing", () => {
    const diff = diffText(
      "sub-01_channels.tsv",
      tsv(["name", "type"], ["A1", "EEG"], ["A1", "EMG"]),
      tsv(["name", "type"], ["A1", "EMG"]),
    );
    expect(diff.keyColumn).toBeNull();
    expect(lines(diff)).toEqual(['row_removed | before="A1\\tEEG"']);
  });
});

describe("diffTable: relocation is exact and corresponding", () => {
  const path = "sub-01/eeg/sub-01_channels.tsv";
  const header = ["name", "type"];
  const before = tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A3", "EEG"]);
  const after = tsv(header, ["A1", "EEG"]);
  const target = `sourcedata/removed/${path}`;

  test("a removed row found verbatim at the corresponding sourcedata path is relocated, naming the shape it went to", () => {
    const diff = diffText(path, before, after, [
      pooled(target, null, tsv(header, ["A2", "EEG"], ["A3", "EEG"])),
    ]);
    expect(lines(diff)).toEqual([
      'row_relocated | field=name | before="A2" | detail="sourcedata/removed/sub-*/eeg/sub-*_channels.tsv"',
      'row_relocated | field=name | before="A3" | detail="sourcedata/removed/sub-*/eeg/sub-*_channels.tsv"',
    ]);
    expect(diff.counts).toMatchObject({ matched: 1, relocated: 2, removed: 0 });
  });

  test("a copy that differs in one byte is not a relocation", () => {
    for (const changed of [
      ["A2", "EEG "],
      ["A2", "EEg"],
      ["a2", "EEG"],
      ["A2", "EEG\u{200B}"],
    ]) {
      const diff = diffText(path, before, after, [
        pooled(target, null, tsv(header, changed, ["A3", "EEG"])),
      ]);
      expect(kindsOf(diff), JSON.stringify(changed)).toEqual(["row_removed", "row_relocated"]);
    }
  });

  test("a copy in a file that was already there is not new, so it proves nothing", () => {
    const same = tsv(header, ["A2", "EEG"], ["A3", "EEG"]);
    const diff = diffText(path, before, after, [pooled(target, same, same)]);
    expect(kindsOf(diff)).toEqual(["row_removed", "row_removed"]);
  });

  test("a copy under a path that does not correspond is not a relocation", () => {
    const rows = tsv(header, ["A2", "EEG"], ["A3", "EEG"]);
    for (const elsewhere of [
      "sourcedata/removed/sub-01/eeg/sub-02_channels.tsv", // another subject's file
      "sourcedata/removed/sub-01/sub-01_channels.tsv", // a shorter path
      `sourcedata/removed/${path}.bak`, // a different name
      `sourcedata/removed/x${path}`, // the directory name differs
      "sourcedata/removed/channels.tsv",
      `sourcedata/${path}`, // the file's own path one level down: no directory of its own
      `sourcedata/a/b/${path}`, // deeper than one directory
      `sourcedata/a/b/c/${path}`,
      `sourcedata/removed/sourcedata/x/${path}`,
      "other/removed/sub-01/eeg/sub-01_channels.tsv", // not under sourcedata
      `derivatives/${path}`,
      `notsourcedata/removed/${path}`,
      `Sourcedata/removed/${path}`,
      path, // the file itself
    ]) {
      const diff = diffText(path, before, after, [pooled(elsewhere, null, rows)]);
      expect(kindsOf(diff), elsewhere).toEqual(["row_removed", "row_removed"]);
    }
  });

  test("exactly one directory under sourcedata, whatever its name, holds the corresponding path", () => {
    const rows = tsv(header, ["A2", "EEG"], ["A3", "EEG"]);
    for (const where of [
      `sourcedata/a/${path}`,
      `sourcedata/channels-removed-2026-10-18/${path}`,
      `sourcedata/x y/${path}`,
    ]) {
      const diff = diffText(path, before, after, [pooled(where, null, rows)]);
      expect(kindsOf(diff), where).toEqual(["row_relocated", "row_relocated"]);
    }
  });

  test("a copy under a different header is not a relocation, even when its row text is the same", () => {
    // Each copy holds the very text of the removed rows ("A2\tEEG"), so only the header can refuse it.
    for (const other of [
      tsv(["name", "kind"], ["A2", "EEG"], ["A3", "EEG"]),
      tsv(["type", "name"], ["A2", "EEG"], ["A3", "EEG"]),
      tsv(["Name", "type"], ["A2", "EEG"], ["A3", "EEG"]),
    ]) {
      const diff = diffText(path, before, after, [pooled(target, null, other)]);
      expect(kindsOf(diff), other.split("\n")[0]).toEqual(["row_removed", "row_removed"]);
    }
  });

  test("the copy must have the header the row had BEFORE, not the one the file has now", () => {
    // The file's columns were swapped. Its removed row was name A2, type EEG. The copy has the
    // file's new header, and a row whose text is "A2\tEEG": under that header it is type A2, name
    // EEG, a different row, so it is no copy of the removed one.
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"]),
      tsv(["type", "name"], ["EEG", "A1"]),
      [pooled(target, null, tsv(["type", "name"], ["A2", "EEG"]))],
    );
    expect(kindsOf(diff)).toEqual(["columns_reordered", "row_removed"]);
  });

  test("two identical removed rows and one copy give one relocated row and one removed", () => {
    const events = "sub-01_events.tsv";
    const hdr = ["onset", "trial_type"];
    const diff = diffText(
      events,
      tsv(hdr, ["1", "go"], ["1", "go"], ["2", "stop"]),
      tsv(hdr, ["2", "stop"]),
      [pooled(`sourcedata/removed/${events}`, null, tsv(hdr, ["1", "go"]))],
    );
    expect(kindsOf(diff)).toEqual(["row_relocated", "row_removed"]);
    expect(diff.counts).toMatchObject({ matched: 1, relocated: 1, removed: 1 });
    // Two copies: both relocated.
    const both = diffText(
      events,
      tsv(hdr, ["1", "go"], ["1", "go"], ["2", "stop"]),
      tsv(hdr, ["2", "stop"]),
      [pooled(`sourcedata/removed/${events}`, null, tsv(hdr, ["1", "go"], ["1", "go"]))],
    );
    expect(kindsOf(both)).toEqual(["row_relocated", "row_relocated"]);
  });

  test("a copy serves only the file its path names, so the order files are diffed in changes nothing", () => {
    const hdr = ["participant_id", "age"];
    const files = [
      pooled("sourcedata/x/phenotype/participants.tsv", null, tsv(hdr, ["sub-07", "33"])),
    ];
    const run = (order: string[]) => {
      const pool = buildPools(files).rows;
      return Object.fromEntries(
        order.map((at) => {
          const result = diffTable(
            at,
            table(tsv(hdr, ["sub-07", "33"], ["sub-01", "20"])),
            table(tsv(hdr, ["sub-01", "20"])),
            pool,
          );
          return [at, result.ok && kindsOf(result.value)];
        }),
      );
    };
    // Both paths end in participants.tsv, but the copy is at sourcedata/x/<phenotype/participants.tsv>.
    const expected: Record<string, false | ClassKind[]> = {
      "participants.tsv": ["row_removed"],
      "phenotype/participants.tsv": ["row_relocated"],
    };
    expect(run(["participants.tsv", "phenotype/participants.tsv"])).toEqual(expected);
    expect(run(["phenotype/participants.tsv", "participants.tsv"])).toEqual(expected);
  });

  test("a copy used is used up: a second diff against the same pool finds what is left", () => {
    // Two copies of one event row, and a file that removes two of them. A second diff of the same
    // path against the same pool (the only way another diff can reach those copies) finds none.
    const events = "sub-01/eeg/sub-01_task-x_events.tsv";
    const hdr = ["onset", "trial_type"];
    const pool = buildPools([
      pooled(`sourcedata/old/${events}`, null, tsv(hdr, ["1", "go"], ["1", "go"])),
    ]).rows;
    const removeTwo = () =>
      diffTable(
        events,
        table(tsv(hdr, ["1", "go"], ["1", "go"], ["2", "stop"])),
        table(tsv(hdr, ["2", "stop"])),
        pool,
      );
    const first = removeTwo();
    expect(first.ok && kindsOf(first.value)).toEqual(["row_relocated", "row_relocated"]);
    expect(pool.files.get(`sourcedata/old/${events}`)?.rows.get("1\tgo")).toBe(0);
    const second = removeTwo();
    expect(second.ok && kindsOf(second.value)).toEqual(["row_removed", "row_removed"]);
    // One copy used of two leaves one.
    const pool2 = buildPools([
      pooled(`sourcedata/old/${events}`, null, tsv(hdr, ["1", "go"], ["1", "go"])),
    ]).rows;
    const one = diffTable(
      events,
      table(tsv(hdr, ["1", "go"], ["2", "stop"])),
      table(tsv(hdr, ["2", "stop"])),
      pool2,
    );
    expect(one.ok && kindsOf(one.value)).toEqual(["row_relocated"]);
    expect(pool2.files.get(`sourcedata/old/${events}`)?.rows.get("1\tgo")).toBe(1);
  });

  test("a diff that is refused does not use up the copies it found", () => {
    const hdr = ["name", "type"];
    const pool = buildPools([pooled(`sourcedata/old/${path}`, null, tsv(hdr, ["A2", "EEG"]))]).rows;
    const refused = diffTableWith(path, table(before), table(after), pool, () => false);
    expect(refused).toEqual({ ok: false, refusal: "internal_mismatch" });
    expect(pool.files.get(`sourcedata/old/${path}`)?.rows.get("A2\tEEG")).toBe(1);
    const used = diffTable(path, table(before), table(after), pool);
    expect(used.ok && used.value.counts.relocated).toBe(1);
    expect(pool.files.get(`sourcedata/old/${path}`)?.rows.get("A2\tEEG")).toBe(0);
  });

  test("a keyless removed row is relocated by its whole row text", () => {
    const events = "sub-01_events.tsv";
    const hdr = ["onset", "trial_type"];
    const diff = diffText(events, tsv(hdr, ["1", "go"], ["2", "stop"]), tsv(hdr, ["1", "go"]), [
      pooled(`sourcedata/x/${events}`, null, tsv(hdr, ["2", "stop"])),
    ]);
    // A matched row is not relocated even when the pool holds a copy of it too.
    const kept = diffText(events, tsv(hdr, ["1", "go"]), tsv(hdr, ["1", "go"]), [
      pooled(`sourcedata/x/${events}`, null, tsv(hdr, ["1", "go"])),
    ]);
    expect(kept.atoms).toEqual([]);
    expect(lines(diff)).toEqual([
      'row_relocated | before="2\\tstop" | detail="sourcedata/x/sub-*_events.tsv"',
    ]);
  });
});

describe("diffTable: the layout of the file", () => {
  const same = tsv(["a", "b"], ["1", "2"]);

  test("a byte order mark, line endings and the final newline are one atom each, with both states", () => {
    expect(lines(diffText("e.tsv", same, `\u{FEFF}${same}`))).toEqual([
      'format | before="absent" | after="present" | detail="bom"',
    ]);
    expect(lines(diffText("e.tsv", same, same.replace(/\n/g, "\r\n")))).toEqual([
      'format | before="lf" | after="crlf" | detail="line_endings"',
    ]);
    expect(lines(diffText("e.tsv", same, same.slice(0, -1)))).toEqual([
      'format | before="present" | after="absent" | detail="final_newline"',
    ]);
  });

  test("mixed line endings: WHICH lines end in CRLF is a difference of its own", () => {
    const a = "a\tb\r\n1\t2\n3\t4\n";
    const b = "a\tb\n1\t2\r\n3\t4\n";
    expect(lines(diffText("e.tsv", a, b))).toEqual([
      'format | before="100" | after="010" | detail="line_ending_pattern"',
    ]);
    // Mixed to LF changes the class of ending and the pattern.
    expect(lines(diffText("e.tsv", a, "a\tb\n1\t2\n3\t4\n"))).toEqual([
      'format | before="mixed" | after="lf" | detail="line_endings"',
      'format | before="100" | after="" | detail="line_ending_pattern"',
    ]);
  });

  test("a layout change does not touch the rows: they stay matched", () => {
    const diff = diffText("e.tsv", same, `\u{FEFF}${same.replace(/\n/g, "\r\n")}`);
    expect(diff.atoms.map((a) => a.detail)).toEqual(["bom", "line_endings"]);
    expect(diff.counts.matched).toBe(1);
  });

  test("formatAtoms of equal layouts is empty and of every field differing is four atoms in a fixed order", () => {
    const base = { bom: false, eol: "lf", crPattern: "", finalNewline: true } as const;
    expect(formatAtoms(base, base)).toEqual([]);
    const all = formatAtoms(base, {
      bom: true,
      eol: "mixed",
      crPattern: "01",
      finalNewline: false,
    });
    expect(all.map((a) => a.detail)).toEqual([
      "bom",
      "line_endings",
      "line_ending_pattern",
      "final_newline",
    ]);
  });
});

describe("diffTable: the totality assertion", () => {
  const path = "sub-01_channels.tsv";
  const header = ["name", "type"];
  const before = table(tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A3", "EEG"]));
  const after = table(tsv(header, ["A1", "EMG"], ["Q9", "EEG"]));
  const emptyPool = buildPools([]).rows;

  test("a count check that fails turns the file into internal_mismatch, never into a summary", () => {
    expect(diffTableWith(path, before, after, emptyPool, () => false)).toEqual({
      ok: false,
      refusal: "internal_mismatch",
    });
    expect(diffTableWith(path, before, after, emptyPool, () => true).ok).toBe(true);
  });

  test("the check is handed the very diff that is returned, once, with the tallies of the pairing", () => {
    const seen: FileDiff<TableCounts>[] = [];
    const result = diffTableWith(path, before, after, emptyPool, (diff) => {
      seen.push(diff);
      return true;
    });
    expect(seen).toHaveLength(1);
    expect(result.ok && result.value).toBe(seen[0] as FileDiff<TableCounts>);
    expect(seen[0]?.counts).toEqual({
      beforeRows: 3,
      afterRows: 2,
      matched: 1,
      paired: 0,
      relocated: 0,
      removed: 2,
      afterMatched: 1,
      afterPaired: 0,
      added: 1,
      relabeled: 0,
      cellsChanged: 1,
      conflicts: 0,
      beforeColumns: 2,
      afterColumns: 2,
      commonColumns: 2,
      columnsRemoved: 0,
      columnsAdded: 0,
    });
  });

  test("the entry point is the real check, once per diff: on a corpus diffTable equals diffTableWith over verifyTableCounts", () => {
    const random = seeded(606);
    let calls = 0;
    const counting = (diff: FileDiff<TableCounts>): boolean => {
      calls++;
      return verifyTableCounts(diff);
    };
    let cases = 0;
    for (let n = 0; n < 300; n++) {
      const g = generateTables(random);
      const b = parseTsv(enc(g.before));
      const a = parseTsv(enc(g.after));
      if (!b.ok || !a.ok) continue;
      cases++;
      const viaEntry = diffTable(g.path, b.value, a.value, buildPools(g.pool).rows);
      const viaWith = diffTableWith(g.path, b.value, a.value, buildPools(g.pool).rows, counting);
      expect(viaEntry, `case ${n}`).toEqual(viaWith);
    }
    expect(cases).toBeGreaterThan(250);
    expect(calls).toBe(cases);
  });

  test("a table the parser would never produce reaches the guard through the entry point", () => {
    // parseTsv refuses a repeated column name; a Table built by hand can hold one. Two after
    // columns share a name, so only one of them can be common and the column tallies cannot add
    // up: the public diffTable must refuse the file, and it is the check that refuses it.
    const twice: Table = { ...after, header: ["type", "type"], rows: [["EEG", "EEG"]] };
    expect(diffTable("events.tsv", before, twice, emptyPool)).toEqual({
      ok: false,
      refusal: "internal_mismatch",
    });
    expect(diffTableWith("events.tsv", before, twice, emptyPool, () => true).ok).toBe(true);
  });

  /** Atoms that say exactly what a set of table tallies says, for the check's truth table. */
  const atomsFor = (c: TableCounts): Atom[] => {
    const atom = (kind: ClassKind): Atom => ({
      kind,
      field: null,
      rule: null,
      detail: null,
      before: null,
      after: null,
    });
    const many = (kind: ClassKind, count: number): Atom[] =>
      Array.from({ length: count }, () => atom(kind));
    return [
      ...many("column_removed", c.columnsRemoved),
      ...many("column_added", c.columnsAdded),
      atom("format"),
      ...many("key_relabeled", c.relabeled),
      ...many("cell_replaced", c.cellsChanged),
      ...many("row_relocated", c.relocated),
      ...many("row_removed", c.removed),
      ...many("row_added", c.added),
      atom("rows_reordered"),
      atom("columns_reordered"),
    ];
  };
  const good: TableCounts = {
    beforeRows: 10,
    afterRows: 9,
    matched: 4,
    paired: 3,
    relocated: 2,
    removed: 1,
    afterMatched: 4,
    afterPaired: 3,
    added: 2,
    relabeled: 3,
    cellsChanged: 2,
    conflicts: 0,
    beforeColumns: 5,
    afterColumns: 6,
    commonColumns: 4,
    columnsRemoved: 1,
    columnsAdded: 2,
  };
  const keyed = (c: TableCounts, atoms = atomsFor(c)): FileDiff<TableCounts> => ({
    family: "tsv",
    keyColumn: "name",
    atoms,
    counts: c,
  });

  test("the real check accepts a total diff whose atoms say what its tallies say", () => {
    expect(verifyTableCounts(keyed(good))).toBe(true);
    const keyless = { ...good, relabeled: 0 };
    expect(verifyTableCounts({ ...keyed(keyless), keyColumn: null })).toBe(true);
  });

  test("it rejects every way the tallies can fail to add up", () => {
    const broken: Partial<TableCounts>[] = [
      { beforeRows: 11 },
      { beforeRows: 9 },
      { afterRows: 10 },
      { afterRows: 8 },
      { conflicts: 1 },
      { beforeColumns: 6 },
      { afterColumns: 5 },
      { commonColumns: 5 },
    ];
    for (const change of broken) {
      expect(verifyTableCounts(keyed({ ...good, ...change })), JSON.stringify(change)).toBe(false);
    }
  });

  test("it rejects each one-to-one clause on its own, with every sum still holding", () => {
    // matched 5 and removed 0 keep the before sum; afterMatched 4 keeps the after sum; the atoms
    // follow the tallies. Only "matched = afterMatched" is left to fail.
    const matched = { ...good, matched: 5, removed: 0 };
    expect(matched.matched + matched.paired + matched.relocated + matched.removed).toBe(10);
    expect(verifyTableCounts(keyed(matched))).toBe(false);
    // The same for paired (and the relabels that go with keyed pairs).
    const paired = { ...good, paired: 4, relabeled: 4, removed: 0 };
    expect(verifyTableCounts(keyed(paired))).toBe(false);
    // And the relabels: a keyed pair is always a relabel, a keyless one never.
    expect(verifyTableCounts(keyed({ ...good, relabeled: 2 }))).toBe(false);
    expect(verifyTableCounts({ ...keyed(good), keyColumn: null })).toBe(false);
  });

  test("it rejects an atom dropped, added or of a kind a table diff never emits", () => {
    const base = atomsFor(good);
    const without = (kind: ClassKind): Atom[] => {
      const at = base.findIndex((atom) => atom.kind === kind);
      return base.filter((_, i) => i !== at);
    };
    const extra = (kind: ClassKind): Atom[] => [...base, { ...(base[0] as Atom), kind }];
    for (const kind of [
      "row_removed",
      "row_added",
      "row_relocated",
      "key_relabeled",
      "cell_replaced",
      "column_removed",
      "column_added",
    ] as ClassKind[]) {
      expect(verifyTableCounts(keyed(good, without(kind))), `without ${kind}`).toBe(false);
      expect(verifyTableCounts(keyed(good, extra(kind))), `extra ${kind}`).toBe(false);
    }
    for (const kind of [
      "cell_emptied",
      "cell_filled",
      "cell_templated",
      "rows_reordered",
      "columns_reordered",
      "json_key_removed",
      "json_value_changed",
      "json_key_added",
    ] as ClassKind[]) {
      expect(verifyTableCounts(keyed(good, extra(kind))), `extra ${kind}`).toBe(false);
    }
    // The order of the atoms is not what is checked.
    expect(verifyTableCounts(keyed(good, [...base].reverse()))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Generated tables: the diff is total, and it never hides a change
// ---------------------------------------------------------------------------------------------

interface Layout {
  bom: boolean;
  /** "lf", "crlf" or "mixed" (the first line CRLF, the rest LF). */
  eol: "lf" | "crlf" | "mixed";
  finalNewline: boolean;
}

/** Text from a header and rows in the given layout. */
function render(header: string[], rows: string[][], layout: Layout): string {
  const lines = [header, ...rows].map((cells) => cells.join("\t"));
  let text = "";
  lines.forEach((content, i) => {
    text += content;
    const last = i === lines.length - 1;
    if (!last || layout.finalNewline) {
      text += layout.eol === "crlf" || (layout.eol === "mixed" && i === 0) ? "\r\n" : "\n";
    }
  });
  return `${layout.bom ? "\u{FEFF}" : ""}${text}`;
}

/** A tool kit over a seeded generator: pick, chance, shuffle. */
function toolkit(random: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const chance = (p: number): boolean => random() < p;
  const int = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));
  const shuffled = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  return { pick, chance, int, shuffled };
}

const VALUES = [
  "EEG",
  "EMG",
  "uV",
  "n/a",
  "",
  "1",
  "01",
  "64",
  "640",
  "A1",
  "a1",
  "x y",
  "good",
  "bad",
  "None",
  "'G1'    ",
  "'G1'",
];
const NAMES = [
  "A1",
  "A2",
  "A01",
  "Cz",
  "cz",
  "CZ",
  "Fp1",
  "EEG Fp1-Ref",
  "POL A01",
  "GA01",
  "EEGGA_01REF",
  "DCEMBRACE",
  "DC EMBRACE-REF",
  "B7",
  "a1",
  "POL A1",
];
const TABLE_FILES: { path: string; key: string | null }[] = [
  { path: "sub-01/eeg/sub-01_task-x_channels.tsv", key: "name" },
  { path: "participants.tsv", key: "participant_id" },
  { path: "sub-01/sub-01_scans.tsv", key: "filename" },
  { path: "sub-01/eeg/sub-01_electrodes.tsv", key: "name" },
  { path: "sub-01/eeg/sub-01_task-x_events.tsv", key: null },
  { path: "phenotype/iq.tsv", key: null },
];
const OTHER_COLUMNS = ["type", "units", "onset", "duration", "status", "note", "x"];

interface GeneratedTables {
  path: string;
  before: string;
  after: string;
  pool: PoolFile[];
  beforeRows: string[][];
  afterRows: string[][];
  beforeHeader: string[];
  afterHeader: string[];
}

function generateTables(random: () => number): GeneratedTables {
  const { pick, chance, int, shuffled } = toolkit(random);
  const file = pick(TABLE_FILES);
  const keyName = file.key ?? "id";
  const extra = shuffled(OTHER_COLUMNS).slice(0, int(0, 4));
  const beforeHeader = chance(0.8) ? [keyName, ...extra] : shuffled([keyName, ...extra]);
  const cell = (column: string): string => (column === keyName ? pick(NAMES) : pick(VALUES));

  const count = int(0, 10);
  const duplicate = chance(0.12);
  const used = new Set<string>();
  const beforeRows: string[][] = [];
  for (let i = 0; i < count; i++) {
    const row = beforeHeader.map(cell);
    const at = beforeHeader.indexOf(keyName);
    while (!duplicate && used.has(row[at] as string)) row[at] = `${pick(NAMES)}-${int(0, 99)}`;
    used.add(row[at] as string);
    beforeRows.push(row);
  }

  // The after table: edit a copy of the before rows.
  let afterHeader = [...beforeHeader];
  if (chance(0.2) && afterHeader.length > 1) {
    const drop = pick(afterHeader.filter((c) => c !== keyName));
    afterHeader = afterHeader.filter((c) => c !== drop);
  }
  if (chance(0.2)) afterHeader.push("added_column");
  if (chance(0.05)) afterHeader[afterHeader.length - 1] = "renamed_column";
  if (chance(0.15)) afterHeader = shuffled(afterHeader);
  const mutateKey = (key: string): string => {
    switch (int(0, 4)) {
      case 0:
        return `POL ${key}`;
      case 1:
        return key.toUpperCase();
      case 2:
        return `EEG ${key}-Ref`;
      case 3:
        return key.replace(/[0-9]+/, (d) => `0${d}`);
      default:
        return `${key}x`;
    }
  };
  const removedForCopies: string[][] = [];
  let carried: string[][] = [];
  for (const row of beforeRows) {
    if (chance(0.2)) {
      removedForCopies.push(row);
      continue;
    }
    const next = [...row];
    const at = beforeHeader.indexOf(keyName);
    if (chance(0.25)) next[at] = mutateKey(next[at] as string);
    for (let i = 0; i < next.length; i++) if (i !== at && chance(0.15)) next[i] = pick(VALUES);
    carried.push(next);
    if (chance(0.05)) carried.push([...next]);
  }
  for (let i = int(0, 3); i > 0; i--)
    carried.push(beforeHeader.map((c) => (c === keyName ? `N${int(0, 999)}` : pick(VALUES))));
  if (chance(0.3)) carried = shuffled(carried);
  const afterRows = carried.map((row) =>
    afterHeader.map((column) => {
      const at = beforeHeader.indexOf(column);
      return at >= 0 ? (row[at] as string) : pick(VALUES);
    }),
  );

  const layout = (): Layout => ({
    bom: chance(0.1),
    eol: pick(["lf", "lf", "lf", "crlf", "mixed"] as const),
    finalNewline: chance(0.9),
  });
  const beforeLayout = layout();
  const afterLayout = chance(0.5) ? beforeLayout : layout();

  const pool: PoolFile[] = [];
  if (removedForCopies.length > 0 && chance(0.6)) {
    const copies = removedForCopies
      .filter(() => chance(0.7))
      .map((row) => (chance(0.25) ? row.map((c, i) => (i === 0 ? `${c}!` : c)) : row));
    pool.push(
      pooled(
        `sourcedata/removed/${file.path}`,
        null,
        render(beforeHeader, copies, { bom: false, eol: "lf", finalNewline: true }),
      ),
    );
  }
  if (chance(0.3))
    pool.push(
      pooled(
        `sourcedata/other/${file.path}`,
        null,
        render(beforeHeader, removedForCopies, { bom: false, eol: "lf", finalNewline: true }),
      ),
    );

  return {
    path: file.path,
    before: render(beforeHeader, beforeRows, beforeLayout),
    after: render(afterHeader, afterRows, afterLayout),
    pool,
    beforeRows,
    afterRows,
    beforeHeader,
    afterHeader,
  };
}

/** The rows projected on the columns both headers have, as a multiset keyed by text. */
function projected(header: string[], rows: string[][], columns: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const text = columns.map((c) => row[header.indexOf(c)]).join("\t");
    map.set(text, (map.get(text) ?? 0) + 1);
  }
  return map;
}

describe("diffTable on generated tables", () => {
  test("1,800 generated pairs: the diff is always total, its tallies match its atoms, and it is deterministic", () => {
    const random = seeded(2024);
    let checked = 0;
    let skipped = 0;
    const seen = new Set<ClassKind>();
    for (let n = 0; n < 1800; n++) {
      const g = generateTables(random);
      const b = parseTsv(enc(g.before));
      const a = parseTsv(enc(g.after));
      if (!b.ok || !a.ok) {
        skipped++;
        continue;
      }
      const result = diffTable(g.path, b.value, a.value, buildPools(g.pool).rows);
      if (!result.ok)
        throw new Error(`case ${n} refused: ${result.refusal}\n${g.before}\n---\n${g.after}`);
      const { atoms, counts } = result.value;
      checked++;
      for (const atom of atoms) seen.add(atom.kind);

      // Total: the real assertion, and the sums it is made of, against the real row counts.
      expect(verifyTableCounts(result.value), `case ${n}`).toBe(true);
      expect(counts.beforeRows, `case ${n}`).toBe(b.value.rows.length);
      expect(counts.afterRows, `case ${n}`).toBe(a.value.rows.length);
      expect(counts.matched + counts.paired + counts.relocated + counts.removed, `case ${n}`).toBe(
        b.value.rows.length,
      );
      expect(counts.afterMatched + counts.afterPaired + counts.added, `case ${n}`).toBe(
        a.value.rows.length,
      );

      // The tallies are the atoms.
      const tally = (kind: ClassKind): number => atoms.filter((x) => x.kind === kind).length;
      expect(tally("row_removed"), `case ${n}`).toBe(counts.removed);
      expect(tally("row_relocated"), `case ${n}`).toBe(counts.relocated);
      expect(tally("row_added"), `case ${n}`).toBe(counts.added);
      expect(tally("column_removed"), `case ${n}`).toBe(counts.columnsRemoved);
      expect(tally("column_added"), `case ${n}`).toBe(counts.columnsAdded);
      expect(tally("key_relabeled"), `case ${n}`).toBe(counts.relabeled);
      expect(counts.relabeled, `case ${n}`).toBe(
        result.value.keyColumn === null ? 0 : counts.paired,
      );

      // Deterministic: a second run against a fresh pool says the same.
      const again = diffTable(g.path, b.value, a.value, buildPools(g.pool).rows);
      expect(again.ok && again.value.atoms, `case ${n}`).toEqual(atoms);

      // Nothing is hidden: if the rows differ on the columns both versions have, a row atom says so.
      const common = g.beforeHeader.filter((c) => g.afterHeader.includes(c));
      const before = projected(g.beforeHeader, g.beforeRows, common);
      const after = projected(g.afterHeader, g.afterRows, common);
      const same =
        before.size === after.size && [...before].every(([text, k]) => after.get(text) === k);
      const rowKinds: ClassKind[] = [
        "row_removed",
        "row_relocated",
        "row_added",
        "key_relabeled",
        "cell_replaced",
        "cell_emptied",
        "cell_filled",
        "cell_templated",
      ];
      const rowAtoms = atoms.filter((x) => rowKinds.includes(x.kind));
      if (same) expect(rowAtoms, `case ${n}: equal rows, but ${rowAtoms.map(line)}`).toEqual([]);
      else
        expect(
          rowAtoms.length,
          `case ${n}: different rows, no atom\n${g.before}\n---\n${g.after}`,
        ).toBeGreaterThan(0);
    }
    expect(skipped).toBeLessThan(180);
    expect(checked).toBeGreaterThan(1500);
    // The generator reaches the interesting kinds, so the checks above are not vacuous.
    for (const kind of [
      "row_removed",
      "row_added",
      "row_relocated",
      "key_relabeled",
      "cell_replaced",
      "cell_emptied",
      "cell_filled",
      "cell_templated",
      "column_removed",
      "column_added",
      "columns_reordered",
      "rows_reordered",
      "format",
    ] as ClassKind[]) {
      expect(seen.has(kind), kind).toBe(true);
    }
  });

  test("a table diffed against itself has no atoms, however it is laid out", () => {
    const random = seeded(77);
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const g = generateTables(random);
      const parsed = parseTsv(enc(g.before));
      if (!parsed.ok) continue;
      const result = diffTable(g.path, parsed.value, parsed.value, buildPools(g.pool).rows);
      expect(result.ok && result.value.atoms, `case ${n}`).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  test("shuffled rows with unique keys are only a reorder; appended rows are only additions", () => {
    const random = seeded(31337);
    const { shuffled, int } = toolkit(random);
    let reordered = 0;
    for (let n = 0; n < 300; n++) {
      const header = ["name", "type"];
      const rows = Array.from({ length: int(2, 9) }, (_, i) => [
        `K${i}`,
        VALUES[i % VALUES.length] as string,
      ]);
      const layout: Layout = { bom: false, eol: "lf", finalNewline: true };
      const path = "sub-01_channels.tsv";
      const order = shuffled(rows);
      const moved = diffText(path, render(header, rows, layout), render(header, order, layout));
      const sameOrder = order.every((row, i) => row === rows[i]);
      expect(
        moved.atoms.map((a) => a.kind),
        `case ${n}`,
      ).toEqual(sameOrder ? [] : ["rows_reordered"]);
      if (!sameOrder) reordered++;
      const extra = Array.from({ length: int(1, 3) }, (_, i) => [`Z${i}`, "EEG"]);
      const grown = diffText(
        path,
        render(header, rows, layout),
        render(header, [...rows, ...extra], layout),
      );
      expect(
        grown.atoms.map((a) => a.kind),
        `case ${n}`,
      ).toEqual(extra.map(() => "row_added"));
    }
    expect(reordered).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------------------------
// The JSON change model
// ---------------------------------------------------------------------------------------------

/**
 * The diff of two JSON texts at a path, against a pool built from `files`, through the real parser.
 * JSON moves consume nothing, so the pool could be shared, but a fresh one per call keeps the tests
 * independent.
 */
function diffJsonText(
  path: string,
  before: string,
  after: string,
  files: PoolFile[] = [],
): FileDiff<JsonCounts> {
  const result = diffJson(path, json(before), json(after), buildPools(files).json);
  if (!result.ok) throw new Error(`diff refused: ${result.refusal}`);
  return result.value;
}

const jsonLines = (before: string, after: string, files: PoolFile[] = []): string[] =>
  diffJsonText("sub-01/eeg/sub-01_task-x_eeg.json", before, after, files).atoms.map(line);

describe("diffJson: leaves at the same path", () => {
  test("a path over maxNameChars on either side refuses the file too_large; one at the bound is diffed", () => {
    const max = SUMMARY_LIMITS.maxNameChars;
    const at = (key: string, value: number) => json(`{"a":{"${key}":${value}}}`);
    // `.a.` and the key: 3 + (max - 3) is exactly the bound.
    const fits = "k".repeat(max - 3);
    const over = "k".repeat(max - 2);
    const pool = buildPools([]).json;
    const diff = diffJson("x.json", at(fits, 1), at(fits, 2), pool);
    expect(diff.ok && diff.value.atoms.map((a) => [a.kind, a.field?.length])).toEqual([
      ["json_value_changed", max],
    ]);
    expect(diffJson("x.json", at(over, 1), at(fits, 1), pool)).toEqual({
      ok: false,
      refusal: "too_large",
    });
    expect(diffJson("x.json", at(fits, 1), at(over, 1), pool)).toEqual({
      ok: false,
      refusal: "too_large",
    });
  });

  test("a document that did not change has no atoms, whatever its layout", () => {
    const diff = diffJsonText(
      "a.json",
      '{"a": 1, "b": [1, 2], "c": {"d": null}}',
      '{\n  "a": 1,\n  "b": [1,2],\n  "c": {"d": null}\n}',
    );
    expect(diff.atoms).toEqual([]);
    expect(diff.family).toBe("json");
    expect(diff.keyColumn).toBeNull();
    expect(diff.counts).toMatchObject({ beforeLeaves: 3, afterLeaves: 3, unchanged: 3 });
  });

  test("a changed value of the same type, and a changed type", () => {
    expect(jsonLines('{"a": "x"}', '{"a": "y"}')).toEqual([
      'json_value_changed | field=.a | before="\\"x\\"" | after="\\"y\\""',
    ]);
    expect(jsonLines('{"a": 1}', '{"a": 2}')).toEqual([
      'json_value_changed | field=.a | before="1" | after="2"',
    ]);
    expect(jsonLines('{"a": "1"}', '{"a": 1}')).toEqual([
      'json_type_changed | field=.a | before="\\"1\\"" | after="1"',
    ]);
    expect(jsonLines('{"a": true}', '{"a": "true"}')).toEqual([
      'json_type_changed | field=.a | before="true" | after="\\"true\\""',
    ]);
    expect(jsonLines('{"a": 1}', '{"a": [1]}')).toEqual([
      'json_type_changed | field=.a | before="1" | after="[1]"',
    ]);
  });

  test("numbers are compared as written: 1.0 is not 1", () => {
    expect(jsonLines('{"a": 1}', '{"a": 1.0}')).toEqual([
      'json_value_changed | field=.a | before="1" | after="1.0"',
    ]);
    expect(jsonLines('{"a": 1e2}', '{"a": 100}')).toEqual([
      'json_value_changed | field=.a | before="1e2" | after="100"',
    ]);
  });

  test("a value that became missing is emptied; a missing one that got a value is filled", () => {
    for (const empty of ["null", '""', '"n/a"', "[]", "{}", "[null]"]) {
      expect(jsonLines('{"a": "x"}', `{"a": ${empty}}`), empty).toEqual([
        expect.stringContaining("json_emptied | field=.a"),
      ]);
      expect(jsonLines(`{"a": ${empty}}`, '{"a": "x"}'), empty).toEqual([
        expect.stringContaining("json_filled | field=.a"),
      ]);
    }
    // None and 0 are values: replacing one is a change, never a fill.
    expect(jsonLines('{"a": "None"}', '{"a": "x"}')).toEqual([
      expect.stringContaining("json_value_changed"),
    ]);
    expect(jsonLines('{"a": 0}', '{"a": "x"}')).toEqual([
      expect.stringContaining("json_type_changed"),
    ]);
    expect(jsonLines('{"a": "x"}', '{"a": "None"}')).toEqual([
      expect.stringContaining("json_value_changed"),
    ]);
  });

  test("a missing value replaced by another missing value is still a change, never a quiet pass", () => {
    expect(jsonLines('{"a": ""}', '{"a": "n/a"}')).toEqual([
      expect.stringContaining("json_value_changed | field=.a"),
    ]);
    expect(jsonLines('{"a": null}', '{"a": ""}')).toEqual([
      expect.stringContaining("json_type_changed | field=.a"),
    ]);
    expect(jsonLines('{"a": []}', '{"a": {}}')).toEqual([
      expect.stringContaining("json_type_changed | field=.a"),
    ]);
  });

  test("a list of scalars is one value: losing an element is a changed value shown whole", () => {
    expect(jsonLines('{"a": [1, 2, 3]}', '{"a": [1, 3]}')).toEqual([
      'json_value_changed | field=.a | before="[1,2,3]" | after="[1,3]"',
    ]);
    expect(jsonLines('{"a": ["x"]}', '{"a": ["x", "y"]}')).toEqual([
      expect.stringContaining('json_value_changed | field=.a | before="[\\"x\\"]"'),
    ]);
  });

  test("a list of objects is diffed per index", () => {
    expect(jsonLines('{"a": [{"k": 1}, {"k": 2}]}', '{"a": [{"k": 1}, {"k": 3}]}')).toEqual([
      'json_value_changed | field=.a[1].k | before="2" | after="3"',
    ]);
    // A removed element of a list of objects is a removed key under that list.
    expect(jsonLines('{"a": [{"k": 1}, {"k": 2}]}', '{"a": [{"k": 1}]}')).toEqual([
      'json_key_removed | field=.a[1] | before="2" | detail="k"',
    ]);
  });

  test("a key that needs brackets keeps its path through a change", () => {
    expect(jsonLines('{"a.b": 1}', '{"a.b": 2}')).toEqual([
      'json_value_changed | field=["a.b"] | before="1" | after="2"',
    ]);
  });

  test("a scalar document changes at the root", () => {
    expect(jsonLines("1", "2")).toEqual(['json_value_changed | field= | before="1" | after="2"']);
  });
});

describe("diffJson: added and removed keys", () => {
  test("an added key is additive and names its parent, its name and its value", () => {
    expect(jsonLines('{"a": 1}', '{"a": 1, "b": {"c": 2}}')).toEqual([
      'json_key_added | field=.b | after="2" | detail="c"',
    ]);
  });

  test("a removed key with a value is a removed key, shown as parent, name and value", () => {
    expect(jsonLines('{"a": 1, "b": {"c": 2, "d": "x"}}', '{"a": 1}')).toEqual([
      'json_key_removed | field=.b | before="2" | detail="c"',
      'json_key_removed | field=.b | before="\\"x\\"" | detail="d"',
    ]);
  });

  test("214 keys removed from one object share a parent, so they are one class's worth of atoms", () => {
    const keys = Array.from({ length: 214 }, (_, i) => [`HED${i}`, `tag ${i}`]);
    const before = JSON.stringify({ trial_type: Object.fromEntries(keys) });
    const diff = diffJsonText("task-x_events.json", before, JSON.stringify({ trial_type: {} }));
    // The object itself is still there, now empty.
    expect(diff.atoms.filter((a) => a.kind === "json_key_removed")).toHaveLength(214);
    expect(
      new Set(diff.atoms.filter((a) => a.kind === "json_key_removed").map((a) => a.field)),
    ).toEqual(new Set([".trial_type"]));
    expect(diff.counts).toMatchObject({ removed: 214, added: 1 });
  });

  test("a removed key whose value held nothing is a modification, not a loss", () => {
    for (const empty of ["null", '""', '"n/a"', "[]", "{}", '["n/a", null]']) {
      expect(jsonLines(`{"a": 1, "b": ${empty}}`, '{"a": 1}'), empty).toEqual([
        expect.stringContaining("json_empty_key_removed | field= | before="),
      ]);
    }
    // Zero, false and None are values.
    for (const value of ["0", "false", '"None"', '"unknown"', '{"x": 0}']) {
      expect(jsonLines(`{"a": 1, "b": ${value}}`, '{"a": 1}')[0], value).toContain(
        "json_key_removed",
      );
    }
  });

  test("a key replaced by a differently named key with another value is a removal and an addition", () => {
    expect(jsonLines('{"a": 1}', '{"b": 2}')).toEqual([
      'json_key_removed | field= | before="1" | detail="a"',
      'json_key_added | field= | after="2" | detail="b"',
    ]);
  });

  test("an object replaced by a scalar loses its children and gains a leaf", () => {
    expect(jsonLines('{"a": {"b": 1}}', '{"a": "x"}')).toEqual([
      'json_key_removed | field=.a | before="1" | detail="b"',
      'json_key_added | field= | after="\\"x\\"" | detail="a"',
    ]);
  });

  test("an empty object that grew children: the empty leaf is gone (it held nothing) and the children are new", () => {
    expect(jsonLines('{"a": {}}', '{"a": {"b": 1}}')).toEqual([
      'json_empty_key_removed | field= | before="{}" | detail="a"',
      'json_key_added | field=.a | after="1" | detail="b"',
    ]);
  });

  test("a key named __proto__ is an ordinary key", () => {
    expect(jsonLines('{"__proto__": 1, "a": 1}', '{"a": 1}')).toEqual([
      'json_key_removed | field= | before="1" | detail="__proto__"',
    ]);
  });
});

describe("diffJson: renamed keys", () => {
  test("a key respelled by case or punctuation, with the same value under the same parent, is a rename", () => {
    expect(jsonLines('{"MiscChannelCount": 3}', '{"MISCChannelCount": 3}')).toEqual([
      'json_key_renamed | field= | before="3" | after="3" | detail="MiscChannelCount -> MISCChannelCount"',
    ]);
    expect(jsonLines('{"Sampling_Frequency": 250}', '{"SamplingFrequency": 250}')).toEqual([
      expect.stringContaining('detail="Sampling_Frequency -> SamplingFrequency"'),
    ]);
    expect(jsonLines('{"a": {"x y": "v"}}', '{"a": {"X-Y": "v"}}')).toEqual([
      'json_key_renamed | field=.a | before="\\"v\\"" | after="\\"v\\"" | detail="x y -> X-Y"',
    ]);
  });

  test("a key renamed by a relabel rule is a rename", () => {
    expect(jsonLines('{"Fz": 1}', '{"EEG_Fz": 1}')).toEqual([
      expect.stringContaining('detail="Fz -> EEG_Fz"'),
    ]);
    expect(jsonLines('{"EEG_Fz": 1}', '{"Fz": 1}')).toEqual([
      expect.stringContaining('detail="EEG_Fz -> Fz"'),
    ]);
  });

  test("a rename needs the same value, and the same parent", () => {
    expect(jsonLines('{"MiscChannelCount": 3}', '{"MISCChannelCount": 4}')).toEqual([
      'json_key_removed | field= | before="3" | detail="MiscChannelCount"',
      'json_key_added | field= | after="4" | detail="MISCChannelCount"',
    ]);
    // Different parents: the key left .a and a key appeared in .b, so nothing is a rename.
    expect(jsonLines('{"a": {"Key": 3}, "b": {}}', '{"a": {}, "b": {"KEY": 3}}')).toEqual([
      'json_key_removed | field=.a | before="3" | detail="Key"',
      'json_empty_key_removed | field= | before="{}" | detail="b"',
      'json_key_added | field= | after="{}" | detail="a"',
      'json_key_added | field=.b | after="3" | detail="KEY"',
    ]);
  });

  test("punctuation between two digits is part of a number: 12 to 1.2 is not a respelling", () => {
    expect(
      jsonLines(
        '{"Levels": {"12": "twelve", "3": "three"}}',
        '{"Levels": {"1.2": "twelve", "3": "three"}}',
      ),
    ).toEqual([
      'json_key_removed | field=.Levels | before="\\"twelve\\"" | detail="12"',
      'json_key_added | field=.Levels | after="\\"twelve\\"" | detail="1.2"',
    ]);
    expect(jsonLines('{"Levels": {"0.5": "half"}}', '{"Levels": {"05": "half"}}')).toEqual([
      'json_key_removed | field=.Levels | before="\\"half\\"" | detail="0.5"',
      'json_key_added | field=.Levels | after="\\"half\\"" | detail="05"',
    ]);
    // Punctuation next to only one digit is still punctuation.
    expect(jsonLines('{"Channel_1": 3}', '{"channel1": 3}')).toEqual([
      expect.stringContaining('detail="Channel_1 -> channel1"'),
    ]);
    expect(jsonLines('{"Run1_Onset": 3}', '{"run1onset": 3}')).toEqual([
      expect.stringContaining('detail="Run1_Onset -> run1onset"'),
    ]);
  });

  test("two names that are not one name respelled are not a rename", () => {
    expect(jsonLines('{"Fz": 1}', '{"Pz": 1}')).toEqual([
      expect.stringContaining("json_key_removed"),
      expect.stringContaining("json_key_added"),
    ]);
    expect(jsonLines('{"count": 3}', '{"counts": 3}')).toEqual([
      expect.stringContaining("json_key_removed"),
      expect.stringContaining("json_key_added"),
    ]);
  });

  test("a shared value is no evidence of a rename: the value must be the only one of its parent on each side", () => {
    // go2 holds the same value as go, so go removed and go3 added are a removal and an addition.
    expect(
      jsonLines(
        '{"trial_type": {"Levels": {"go": "Go", "go2": "Go"}}}',
        '{"trial_type": {"Levels": {"go2": "Go", "go3": "Go"}}}',
      ),
    ).toEqual([
      'json_key_removed | field=.trial_type.Levels | before="\\"Go\\"" | detail="go"',
      'json_key_added | field=.trial_type.Levels | after="\\"Go\\"" | detail="go3"',
    ]);
    // Two old names that both fold to the new one: neither is the rename.
    expect(jsonLines('{"a_b": 1, "A-B": 1}', '{"AB": 1}')).toEqual([
      'json_key_removed | field= | before="1" | detail="a_b"',
      'json_key_removed | field= | before="1" | detail="A-B"',
      'json_key_added | field= | after="1" | detail="AB"',
    ]);
    // Two new names that both could be the old one: neither is.
    expect(jsonLines('{"x": 1}', '{"X": 1, "x_": 1}')).toEqual([
      'json_key_removed | field= | before="1" | detail="x"',
      'json_key_added | field= | after="1" | detail="X"',
      'json_key_added | field= | after="1" | detail="x_"',
    ]);
    // A value repeated under ANOTHER parent does not count against a rename.
    expect(
      jsonLines('{"a": {"Key": 1}, "b": {"z": 1}}', '{"a": {"KEY": 1}, "b": {"z": 1}}'),
    ).toEqual([expect.stringContaining('detail="Key -> KEY"')]);
  });

  test("several keys renamed at once, each with its own value, are each a rename", () => {
    expect(
      jsonLines(
        '{"Sampling_Frequency": 250, "Misc_Channel_Count": 3, "EEG_Reference": "Cz"}',
        '{"SamplingFrequency": 250, "MiscChannelCount": 3, "EEGReference": "Cz"}',
      ),
    ).toEqual([
      expect.stringContaining('detail="Sampling_Frequency -> SamplingFrequency"'),
      expect.stringContaining('detail="Misc_Channel_Count -> MiscChannelCount"'),
      expect.stringContaining('detail="EEG_Reference -> EEGReference"'),
    ]);
  });

  test("a value that moved to another key and was overwritten at its old key is a change, not a rename", () => {
    // b's old value 1 is now under a, but a was there before with another value: b is removed and
    // a changed, because the after leaf with value 1 is already the partner of a's change.
    expect(jsonLines('{"a": 2, "b": 1}', '{"a": 1}')).toEqual([
      'json_value_changed | field=.a | before="2" | after="1"',
      'json_key_removed | field= | before="1" | detail="b"',
    ]);
  });

  test("a leaf in a list of objects can be renamed under its element", () => {
    expect(jsonLines('{"a": [{"Key": 1}]}', '{"a": [{"key": 1}]}')).toEqual([
      expect.stringContaining('field=.a[0] | before="1" | after="1" | detail="Key -> key"'),
    ]);
  });

  test("an element of a list is not renamed even to a member named by its index", () => {
    // The list became an object whose key "1" holds what index 1 held. "[1]" and "1" fold alike,
    // but an index is not a key, so the element is removed and the member added.
    expect(jsonLines('{"a": [{"x": 1}, 5]}', '{"a": {"1": 5, "x": 1}}')).toEqual([
      'json_key_removed | field=.a[0] | before="1" | detail="x"',
      'json_key_removed | field=.a | before="5" | detail="[1]"',
      'json_key_added | field=.a | after="5" | detail="1"',
      'json_key_added | field=.a | after="1" | detail="x"',
    ]);
  });

  test("a member is not renamed to a list element named by its index either", () => {
    expect(jsonLines('{"a": {"1": 5, "x": 1}}', '{"a": [{"x": 1}, 5]}')).toEqual([
      'json_key_removed | field=.a | before="5" | detail="1"',
      'json_key_removed | field=.a | before="1" | detail="x"',
      'json_key_added | field=.a[0] | after="1" | detail="x"',
      'json_key_added | field=.a | after="5" | detail="[1]"',
    ]);
  });

  test("an element of a list is not a key and is never renamed", () => {
    // The two elements swapped places. Nothing is a rename, so the old places are removed keys and the
    // new places added ones: more change shown, never less.
    expect(jsonLines('{"a": [1, {"k": 1}]}', '{"a": [{"k": 1}, 1]}')).toEqual([
      'json_key_removed | field=.a | before="1" | detail="[0]"',
      'json_key_removed | field=.a[1] | before="1" | detail="k"',
      'json_key_added | field=.a[0] | after="1" | detail="k"',
      'json_key_added | field=.a | after="1" | detail="[1]"',
    ]);
  });

  test("thousands of keys renamed, each with its own value, rename in linear time; one shared value renames none", () => {
    const n = 4000;
    const before = JSON.stringify(
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, `v${i}`])),
    );
    const after = JSON.stringify(
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`KEY${i}`, `v${i}`])),
    );
    const started = performance.now();
    const diff = diffJsonText("a.json", before, after);
    expect(diff.counts).toMatchObject({ renamed: n, removed: 0, added: 0 });
    const shared = (prefix: string) =>
      JSON.stringify(
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, "x"])),
      );
    const unmatched = diffJsonText("a.json", shared("key"), shared("KEY"));
    expect(unmatched.counts).toMatchObject({ renamed: 0, removed: n, added: n });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("sidecarApplies: BIDS inheritance, as far as the change model reads it", () => {
  const file = "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-1_eeg.json";

  test("a sidecar in the file's directory or an ancestor, with the same suffix and extension and only entities the file has", () => {
    for (const sidecar of [
      "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_eeg.json",
      "sub-01/ses-02/eeg/sub-01_task-rest_eeg.json",
      "sub-01/ses-02/eeg/task-rest_eeg.json",
      "sub-01/task-rest_eeg.json",
      "task-rest_eeg.json",
      "eeg.json",
      "sub-01/ses-02/eeg/eeg.json",
      "sub-01/ses-02/eeg/run-1_eeg.json",
      "ses-02_eeg.json",
    ]) {
      expect(sidecarApplies(sidecar, file), sidecar).toBe(true);
    }
  });

  test("not another suffix, an entity the file does not have, another value, a sibling or deeper directory, or another extension", () => {
    for (const sidecar of [
      "task-rest_events.json", // another suffix
      "task-rest_channels.json",
      "task-sleep_eeg.json", // another value of an entity the file has
      "acq-hi_eeg.json", // an entity the file does not have
      "sub-01_task-rest_run-2_eeg.json",
      "sub-01_task-rest_acq-a_eeg.json",
      "sub-02/task-rest_eeg.json", // a sibling directory
      "sub-01/eeg/task-rest_eeg.json", // a sibling of the session directory
      "sub-01/ses-03/task-rest_eeg.json",
      "sub-01/ses-02/eeg/deeper/task-rest_eeg.json", // deeper than the file
      "sub-01/ses-02/eeg/task-rest_eeg.tsv", // another extension
      "sourcedata/task-rest_eeg.json",
      "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-1_eeg.json", // the file itself
      "sub-01/ses-02/eeg2/task-rest_eeg.json",
      "sub-0/task-rest_eeg.json", // a directory that is a prefix of nothing here
      "sub-01/ses-02/ee/task-rest_eeg.json",
    ]) {
      expect(sidecarApplies(sidecar, file), sidecar).toBe(false);
    }
  });

  test("the extension is everything after the first dot, as in BIDS", () => {
    expect(sidecarApplies("task-rest_eeg.x.json", "sub-01/sub-01_task-rest_eeg.x.json")).toBe(true);
    expect(sidecarApplies("task-rest_eeg.json", "sub-01/sub-01_task-rest_eeg.x.json")).toBe(false);
  });

  test("a name that is not a BIDS name applies to nothing and receives nothing", () => {
    expect(sidecarApplies("notes_eeg.json", file)).toBe(false); // a part before the suffix is not key-value
    expect(sidecarApplies("task-rest_eeg.json", "sub-01_notes_eeg.json")).toBe(false);
    expect(sidecarApplies("dataset_description.json", "x/dataset_description.json")).toBe(false);
    expect(sidecarApplies("task-rest.json", "sub-01_task-rest.json")).toBe(false); // no suffix
    expect(sidecarApplies("noextension", "sub-01_eeg.json")).toBe(false);
    // A single-part name is a suffix: the root eeg.json applies to every eeg sidecar below it.
    expect(sidecarApplies("eeg.json", "sub-01/sub-01_eeg.json")).toBe(true);
    expect(sidecarApplies("participants.json", "participants.json")).toBe(false);
  });
});

describe("diffJson: moved keys", () => {
  const target = "sub-01/eeg/sub-01_task-x_run-1_eeg.json";
  const before = '{"Manufacturer": "BioSemi", "Keep": 1}';
  const after = '{"Keep": 1}';
  const run = (files: PoolFile[], at = target) =>
    diffJsonText(at, before, after, files).atoms.map((a) => a.kind);

  test("a removed key found with the same path and value in a sidecar that applies is moved, not lost", () => {
    const moved = pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi"}');
    expect(run([moved])).toEqual(["json_key_moved"]);
    expect(diffJsonText(target, before, after, [moved]).atoms.map(line)).toEqual([
      'json_key_moved | field= | before="\\"BioSemi\\"" | detail="Manufacturer"',
    ]);
    expect(diffJsonText(target, before, after, [moved]).counts).toMatchObject({
      moved: 1,
      removed: 0,
    });
  });

  test("the sidecar may be new or modified, as long as it did not already have that leaf", () => {
    expect(
      run([pooled("eeg.json", '{"Other": 1}', '{"Other": 1, "Manufacturer": "BioSemi"}')]),
    ).toEqual(["json_key_moved"]);
    expect(
      run([pooled("eeg.json", '{"Manufacturer": "BioSemi"}', '{"Manufacturer": "BioSemi"}')]),
    ).toEqual(["json_key_removed"]);
    // It had the key with another value before: the new value is what it has now, so it counts.
    expect(
      run([pooled("eeg.json", '{"Manufacturer": "Other"}', '{"Manufacturer": "BioSemi"}')]),
    ).toEqual(["json_key_moved"]);
  });

  test("not when the value differs, the path differs, or the file is the file itself", () => {
    expect(run([pooled("task-x_eeg.json", null, '{"Manufacturer": "Biosemi"}')])).toEqual([
      "json_key_removed",
    ]);
    expect(run([pooled("task-x_eeg.json", null, '{"manufacturer": "BioSemi"}')])).toEqual([
      "json_key_removed",
    ]);
    expect(
      run([pooled("task-x_eeg.json", null, '{"Hardware": {"Manufacturer": "BioSemi"}}')]),
    ).toEqual(["json_key_removed"]);
    expect(run([pooled(target, null, '{"Manufacturer": "BioSemi"}')])).toEqual([
      "json_key_removed",
    ]);
  });

  test("not into a different suffix, an entity the file does not have, or a sibling directory", () => {
    const content = '{"Manufacturer": "BioSemi"}';
    expect(run([pooled("task-x_events.json", null, content)])).toEqual(["json_key_removed"]);
    expect(run([pooled("task-x_acq-hi_eeg.json", null, content)])).toEqual(["json_key_removed"]);
    expect(run([pooled("task-y_eeg.json", null, content)])).toEqual(["json_key_removed"]);
    expect(run([pooled("sub-02/task-x_eeg.json", null, content)])).toEqual(["json_key_removed"]);
    expect(run([pooled("sub-01/eeg/deeper/task-x_eeg.json", null, content)])).toEqual([
      "json_key_removed",
    ]);
    expect(run([pooled("sub-01/eeg/sub-01_task-x_run-2_eeg.json", null, content)])).toEqual([
      "json_key_removed",
    ]);
  });

  test("a sidecar that does not parse is skipped, so its keys are not found", () => {
    expect(
      run([pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi", "Manufacturer": "x"}')]),
    ).toEqual(["json_key_removed"]);
  });

  test("moves consume nothing: one sidecar can account for many files", () => {
    const files = [pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi"}')];
    const pool = buildPools(files).json;
    for (const at of [
      target,
      "sub-02/eeg/sub-02_task-x_eeg.json",
      "sub-03/eeg/sub-03_task-x_eeg.json",
    ]) {
      const result = diffJson(at, json(before), json(after), pool);
      expect(result.ok && result.value.atoms.map((a) => a.kind), at).toEqual(["json_key_moved"]);
    }
  });

  test("a nested leaf is not moved while this file keeps its top-level key: inheritance merges one level deep", () => {
    // The file still has trial_type, so its whole trial_type replaces the sidecar's: the level the
    // sidecar now holds does not reach this file.
    const file = "sub-01/eeg/sub-01_task-rest_events.json";
    const sidecar = pooled(
      "task-rest_events.json",
      '{"onset": {"Units": "s"}}',
      '{"onset": {"Units": "s"}, "trial_type": {"Levels": {"stop": "Stop trial"}}}',
    );
    const before = '{"trial_type": {"Levels": {"go": "Go trial", "stop": "Stop trial"}}}';
    expect(
      diffJsonText(file, before, '{"trial_type": {"Levels": {"go": "Go trial"}}}', [
        sidecar,
      ]).atoms.map(line),
    ).toEqual([
      'json_key_removed | field=.trial_type.Levels | before="\\"Stop trial\\"" | detail="stop"',
    ]);
    // Once the file drops trial_type altogether, the sidecar's applies, and the leaf is moved.
    expect(
      diffJsonText(file, before, '{"onset": {"Units": "s"}}', [
        pooled(
          "task-rest_events.json",
          "{}",
          '{"trial_type": {"Levels": {"go": "Go trial", "stop": "Stop trial"}}}',
        ),
      ]).atoms.map((a) => a.kind),
    ).toEqual(["json_key_moved", "json_key_moved", "json_key_added"]);
    // A list of objects is one top-level key too: an element moved out of a list the file keeps
    // is lost for this file.
    expect(
      diffJsonText(
        "sub-01/eeg/sub-01_task-x_eeg.json",
        '{"Arr": [{"a": 1}, {"a": 2}]}',
        '{"Arr": [{"a": 1}]}',
        [pooled("task-x_eeg.json", "{}", '{"Arr": [{"a": 9}, {"a": 2}]}')],
      ).atoms.map((a) => a.kind),
    ).toEqual(["json_key_removed"]);
  });

  test("nothing is moved out of a document that is not an object, or into one that is not", () => {
    const file = "sub-01/eeg/sub-01_task-x_eeg.json";
    // The file became a list: it has no top-level keys for a sidecar to merge under.
    expect(
      diffJsonText(file, '{"Manufacturer": "BioSemi"}', "[]", [
        pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi"}'),
      ]).atoms.map((a) => a.kind),
    ).toEqual(["json_key_removed", "json_key_added"]);
    // A scalar document's one leaf has no key at all.
    expect(
      diffJsonText(file, "5", '{"a": 1}', [pooled("task-x_eeg.json", null, "5")]).atoms.map(
        (a) => a.kind,
      ),
    ).toEqual(["json_key_removed", "json_key_added"]);
    // A sidecar that is a scalar holds no key a removed one could have moved to.
    expect(
      diffJsonText(file, '{"Manufacturer": "BioSemi", "K": 1}', '{"K": 1}', [
        pooled("task-x_eeg.json", null, '"BioSemi"'),
      ]).atoms.map((a) => a.kind),
    ).toEqual(["json_key_removed"]);
  });

  test("a nearer sidecar the pull request changed decides the value: a key moved past it is lost", () => {
    const file = "sub-01/eeg/sub-01_task-x_eeg.json";
    const before = '{"SamplingFrequency": 500, "x": 1}';
    const after = '{"x": 1}';
    const root = pooled("task-x_eeg.json", "{}", '{"SamplingFrequency": 500}');
    const kinds = (files: PoolFile[]) =>
      diffJsonText(file, before, after, files).atoms.map((a) => a.kind);
    // The root sidecar holds 500 now, but the subject one, nearer to the file, says 250.
    expect(
      kinds([root, pooled("sub-01/sub-01_task-x_eeg.json", "{}", '{"SamplingFrequency": 250}')]),
    ).toEqual(["json_key_removed"]);
    // Also when the nearer one already had the key and changed something else.
    expect(
      kinds([
        root,
        pooled(
          "sub-01/sub-01_task-x_eeg.json",
          '{"SamplingFrequency": 250, "Other": 1}',
          '{"SamplingFrequency": 250, "Other": 2}',
        ),
      ]),
    ).toEqual(["json_key_removed"]);
    // A nearer one that holds the same value as a new leaf is itself a home.
    expect(
      kinds([root, pooled("sub-01/sub-01_task-x_eeg.json", "{}", '{"SamplingFrequency": 500}')]),
    ).toEqual(["json_key_moved"]);
    // A nearer one without the key leaves the farther one deciding.
    expect(kinds([root, pooled("sub-01/sub-01_task-x_eeg.json", "{}", '{"Other": 1}')])).toEqual([
      "json_key_moved",
    ]);
    // A nearer one that cannot be read may hold anything.
    expect(kinds([root, pooled("sub-01/sub-01_task-x_eeg.json", "{}", "{")])).toEqual([
      "json_key_removed",
    ]);
    // One that does not apply (another subject) decides nothing.
    expect(
      kinds([root, pooled("sub-02/sub-02_task-x_eeg.json", "{}", '{"SamplingFrequency": 250}')]),
    ).toEqual(["json_key_moved"]);
  });

  test("nearest is the deepest directory, then the most entities; two equally near decide nothing", () => {
    const file = "sub-01/eeg/sub-01_task-x_run-1_eeg.json";
    const before = '{"SamplingFrequency": 500, "x": 1}';
    const after = '{"x": 1}';
    const kinds = (files: PoolFile[]) =>
      diffJsonText(file, before, after, files).atoms.map((a) => a.kind);
    const home = (path: string) => pooled(path, "{}", '{"SamplingFrequency": 500}');
    const other = (path: string) => pooled(path, "{}", '{"SamplingFrequency": 250}');
    // A deeper directory wins over more entities.
    expect(kinds([home("task-x_run-1_eeg.json"), other("sub-01/eeg.json")])).toEqual([
      "json_key_removed",
    ]);
    expect(kinds([other("task-x_run-1_eeg.json"), home("sub-01/eeg.json")])).toEqual([
      "json_key_moved",
    ]);
    // In one directory, more entities win.
    expect(kinds([home("sub-01/sub-01_eeg.json"), other("sub-01/sub-01_task-x_eeg.json")])).toEqual(
      ["json_key_removed"],
    );
    expect(kinds([other("sub-01/sub-01_eeg.json"), home("sub-01/sub-01_task-x_eeg.json")])).toEqual(
      ["json_key_moved"],
    );
    // Two in one directory with as many entities: BIDS gives no order, so nothing is moved.
    expect(
      kinds([home("sub-01/sub-01_task-x_eeg.json"), other("sub-01/sub-01_run-1_eeg.json")]),
    ).toEqual(["json_key_removed"]);
    expect(
      kinds([home("sub-01/sub-01_task-x_eeg.json"), home("sub-01/sub-01_run-1_eeg.json")]),
    ).toEqual(["json_key_removed"]);
  });

  test("a rename wins over a move: the key is still in this file", () => {
    const diff = diffJsonText(
      target,
      '{"Manufacturer": "BioSemi"}',
      '{"MANUFACTURER": "BioSemi"}',
      [pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi"}')],
    );
    expect(diff.atoms.map((a) => a.kind)).toEqual(["json_key_renamed"]);
  });
});

describe("diffJson: order", () => {
  test("keys that only changed order are a reorder and nothing else", () => {
    expect(jsonLines('{"a": 1, "b": 2}', '{"b": 2, "a": 1}')).toEqual(["json_keys_reordered"]);
    expect(jsonLines('{"x": {"a": 1, "b": 2}, "y": 1}', '{"x": {"b": 2, "a": 1}, "y": 1}')).toEqual(
      ["json_keys_reordered"],
    );
    expect(jsonLines('{"x": 1, "y": 2}', '{"y": 2, "x": 1}')).toEqual(["json_keys_reordered"]);
  });

  test("adding or removing a key does not make the others a reorder; a rename keeps its place", () => {
    expect(jsonLines('{"a": 1, "b": 2, "c": 3}', '{"a": 1, "c": 3, "d": 4}')).toEqual([
      expect.stringContaining("json_key_removed"),
      expect.stringContaining("json_key_added"),
    ]);
    expect(jsonLines('{"a": 1, "Bb": 2, "c": 3}', '{"a": 1, "BB": 2, "c": 3}')).toEqual([
      expect.stringContaining("json_key_renamed"),
    ]);
    expect(jsonLines('{"a": 1, "Bb": 2, "c": 3}', '{"c": 3, "BB": 2, "a": 1}')).toEqual([
      expect.stringContaining("json_key_renamed"),
      "json_keys_reordered",
    ]);
  });

  test("a reorder is reported next to the changes that came with it", () => {
    expect(jsonLines('{"a": 1, "b": 2}', '{"b": 3, "a": 1}')).toEqual([
      expect.stringContaining("json_value_changed | field=.b"),
      "json_keys_reordered",
    ]);
  });
});

describe("diffJson: the totality assertion", () => {
  const empty = buildPools([]).json;
  const before = json('{"a": 1, "b": 2, "c": {"d": 3}}');
  const after = json('{"a": 1, "b": 5, "e": 4}');

  test("a count check that fails turns the file into internal_mismatch", () => {
    expect(diffJsonWith("a.json", before, after, empty, () => false)).toEqual({
      ok: false,
      refusal: "internal_mismatch",
    });
    expect(diffJsonWith("a.json", before, after, empty, () => true).ok).toBe(true);
  });

  test("the check is handed the very diff that is returned, once, with the tallies of the fates", () => {
    const seen: FileDiff<JsonCounts>[] = [];
    const result = diffJsonWith("a.json", before, after, empty, (diff) => {
      seen.push(diff);
      return true;
    });
    expect(seen).toHaveLength(1);
    expect(result.ok && result.value).toBe(seen[0] as FileDiff<JsonCounts>);
    expect(seen[0]?.counts).toEqual({
      beforeLeaves: 3,
      afterLeaves: 3,
      unchanged: 1,
      changed: 1,
      emptied: 0,
      filled: 0,
      renamed: 0,
      afterRenamed: 0,
      moved: 0,
      removed: 1,
      emptyRemoved: 0,
      added: 1,
      afterUnchanged: 1,
      afterChanged: 1,
      afterEmptied: 0,
      afterFilled: 0,
      conflicts: 0,
    });
  });

  test("the entry point is the real check, once per diff: on a corpus diffJson equals diffJsonWith over verifyJsonCounts", () => {
    const random = seeded(707);
    let calls = 0;
    const counting = (diff: FileDiff<JsonCounts>): boolean => {
      calls++;
      return verifyJsonCounts(diff);
    };
    for (let n = 0; n < 300; n++) {
      const root = randomPlain(random, 0);
      const b = json(textOf(root));
      const a = json(textOf(mutatePlain(random, root)));
      expect(diffJson("a.json", b, a, empty), `case ${n}`).toEqual(
        diffJsonWith("a.json", b, a, empty, counting),
      );
    }
    expect(calls).toBe(300);
  });

  test("a document the parser would never produce reaches the guard through the entry point", () => {
    // parseJson refuses a repeated key; a value built by hand can hold one. Two before leaves then
    // share one path, both claim the one after leaf there, and the second claim is a conflict.
    const one = json("1");
    const twice: JsonValue = { t: "obj", keys: ["a", "a"], v: new Map([["a", one]]) };
    expect(diffJson("a.json", twice, json('{"a": 1}'), empty)).toEqual({
      ok: false,
      refusal: "internal_mismatch",
    });
    expect(diffJsonWith("a.json", twice, json('{"a": 1}'), empty, () => true).ok).toBe(true);
  });

  /** Atoms that say exactly what a set of JSON tallies says, for the check's truth table. */
  const atomsFor = (c: JsonCounts): Atom[] => {
    const many = (kind: ClassKind, count: number): Atom[] =>
      Array.from({ length: count }, () => ({
        kind,
        field: "",
        rule: null,
        detail: "k",
        before: "1",
        after: null,
      }));
    return [
      ...many("json_value_changed", c.changed - 1),
      ...many("json_type_changed", 1),
      ...many("json_emptied", c.emptied),
      ...many("json_filled", c.filled),
      ...many("json_key_renamed", c.renamed),
      ...many("json_key_moved", c.moved),
      ...many("json_key_removed", c.removed),
      ...many("json_empty_key_removed", c.emptyRemoved),
      ...many("json_key_added", c.added),
      ...many("json_keys_reordered", 1),
    ];
  };
  const good: JsonCounts = {
    beforeLeaves: 12,
    afterLeaves: 9,
    unchanged: 3,
    changed: 2,
    emptied: 1,
    filled: 1,
    renamed: 1,
    afterRenamed: 1,
    moved: 1,
    removed: 2,
    emptyRemoved: 1,
    added: 1,
    afterUnchanged: 3,
    afterChanged: 2,
    afterEmptied: 1,
    afterFilled: 1,
    conflicts: 0,
  };
  const diffOf = (c: JsonCounts, atoms = atomsFor(c)): FileDiff<JsonCounts> => ({
    family: "json",
    keyColumn: null,
    atoms,
    counts: c,
  });

  test("the real check accepts a total diff whose atoms say what its tallies say", () => {
    expect(verifyJsonCounts(diffOf(good))).toBe(true);
    expect(verifyJsonCounts(diffOf(good, [...atomsFor(good)].reverse()))).toBe(true);
  });

  test("it rejects every way the tallies can fail to add up", () => {
    const broken: Partial<JsonCounts>[] = [
      { beforeLeaves: 13 },
      { beforeLeaves: 11 },
      { afterLeaves: 10 },
      { afterLeaves: 8 },
      { afterRenamed: 2 },
      { afterChanged: 1 },
      { afterUnchanged: 4 },
      { afterEmptied: 0 },
      { afterFilled: 2 },
      { conflicts: 1 },
    ];
    for (const change of broken) {
      expect(verifyJsonCounts(diffOf({ ...good, ...change })), JSON.stringify(change)).toBe(false);
    }
  });

  test("it rejects each of the five one-to-one clauses on its own, with every sum still holding", () => {
    // Each moves one before leaf from removed to the fate under test, so the before sum holds, and
    // takes one after leaf from the after side of that fate to `added`, so the after sum holds.
    for (const [fate, afterFate] of [
      ["unchanged", "afterUnchanged"],
      ["changed", "afterChanged"],
      ["emptied", "afterEmptied"],
      ["filled", "afterFilled"],
      ["renamed", "afterRenamed"],
    ] as const) {
      const c: JsonCounts = {
        ...good,
        [fate]: good[fate] + 1,
        removed: good.removed - 1,
        [afterFate]: good[afterFate] - 1,
        added: good.added + 1,
      };
      expect(
        c.unchanged +
          c.changed +
          c.emptied +
          c.filled +
          c.renamed +
          c.moved +
          c.removed +
          c.emptyRemoved,
      ).toBe(c.beforeLeaves);
      expect(
        c.afterUnchanged +
          c.afterChanged +
          c.afterEmptied +
          c.afterFilled +
          c.afterRenamed +
          c.added,
      ).toBe(c.afterLeaves);
      expect(verifyJsonCounts(diffOf(c)), fate).toBe(false);
    }
  });

  test("it rejects an atom dropped, added or of a kind a JSON diff never emits", () => {
    const base = atomsFor(good);
    for (const kind of [
      "json_value_changed",
      "json_type_changed",
      "json_emptied",
      "json_filled",
      "json_key_renamed",
      "json_key_moved",
      "json_key_removed",
      "json_empty_key_removed",
      "json_key_added",
    ] as ClassKind[]) {
      const at = base.findIndex((atom) => atom.kind === kind);
      expect(
        verifyJsonCounts(
          diffOf(
            good,
            base.filter((_, i) => i !== at),
          ),
        ),
        `without ${kind}`,
      ).toBe(false);
      expect(verifyJsonCounts(diffOf(good, [...base, { ...(base[0] as Atom), kind }])), kind).toBe(
        false,
      );
    }
    for (const kind of [
      "json_keys_reordered",
      "row_removed",
      "cell_replaced",
      "format",
    ] as ClassKind[]) {
      expect(verifyJsonCounts(diffOf(good, [...base, { ...(base[0] as Atom), kind }])), kind).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Generated JSON: the diff is total, and every leaf is accounted for
// ---------------------------------------------------------------------------------------------

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

const JSON_KEYS = [
  "Name",
  "name",
  "MiscChannelCount",
  "MISCChannelCount",
  "Sampling_Frequency",
  "SamplingFrequency",
  "a",
  "b",
  "c",
  "EEGReference",
  "EEG_Reference",
  "x y",
  "a.b",
  "0",
  "K1",
  "K2",
  "__proto__",
];
const JSON_STRINGS = ["", "n/a", "x", "good", "None", "A1", "1", "BioSemi", " "];

function randomPlain(random: () => number, depth: number): Plain {
  const { pick, chance, int } = toolkit(random);
  const scalar = (): Plain => {
    switch (int(0, 5)) {
      case 0:
        return null;
      case 1:
        return chance(0.5);
      case 2:
        return int(0, 3);
      default:
        return pick(JSON_STRINGS);
    }
  };
  if (depth >= 3 || chance(0.4)) return scalar();
  if (chance(0.25)) {
    // A list: of scalars, or of objects.
    const length = int(0, 3);
    if (chance(0.5)) return Array.from({ length }, scalar);
    return Array.from({ length }, () => randomPlain(random, depth + 1));
  }
  const object: { [key: string]: Plain } = {};
  for (let i = int(0, 4); i > 0; i--)
    Object.defineProperty(object, pick(JSON_KEYS), {
      value: randomPlain(random, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return object;
}

/** Every container of a value, so a mutation can pick one. */
function containers(value: Plain, out: (Plain[] | { [key: string]: Plain })[] = []) {
  if (value !== null && typeof value === "object") {
    out.push(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) containers(child, out);
  }
  return out;
}

function clone(value: Plain): Plain {
  return JSON.parse(JSON.stringify(value)) as Plain;
}

/** JSON text for a plain value; `JSON.stringify` keeps a `__proto__` key defined with defineProperty. */
const textOf = (value: Plain): string => JSON.stringify(value);

function mutatePlain(random: () => number, root: Plain): Plain {
  const { pick, chance, int, shuffled } = toolkit(random);
  let value = clone(root);
  for (let step = int(0, 5); step > 0; step--) {
    const nodes = containers(value);
    if (nodes.length === 0) {
      value = randomPlain(random, 1);
      continue;
    }
    const node = pick(nodes);
    if (Array.isArray(node)) {
      if (node.length > 0 && chance(0.5)) node[int(0, node.length - 1)] = randomPlain(random, 2);
      else node.push(randomPlain(random, 2));
      continue;
    }
    const keys = Object.keys(node);
    const target = keys.length > 0 ? pick(keys) : undefined;
    switch (int(0, 6)) {
      case 0:
        if (target !== undefined) delete node[target];
        break;
      case 1:
        Object.defineProperty(node, pick(JSON_KEYS), {
          value: randomPlain(random, 2),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        break;
      case 2:
        if (target !== undefined) node[target] = randomPlain(random, 2);
        break;
      case 3: {
        // Rename a key in place, to a respelling or to another name.
        if (target === undefined) break;
        const renamed = pick([
          target.toUpperCase(),
          `${target}_`,
          `EEG_${target}`,
          target.replace(/_/g, ""),
          pick(JSON_KEYS),
        ]);
        if (renamed === target || renamed in node) break;
        const entries = Object.entries(node).map(
          ([k, v]) => [k === target ? renamed : k, v] as const,
        );
        for (const k of keys) delete node[k];
        for (const [k, v] of entries)
          Object.defineProperty(node, k, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        break;
      }
      case 4: {
        const entries = shuffled(Object.entries(node));
        for (const k of keys) delete node[k];
        for (const [k, v] of entries)
          Object.defineProperty(node, k, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        break;
      }
      case 5:
        if (target !== undefined) node[target] = pick([null, "", "n/a", [], {}]);
        break;
      default:
        if (target !== undefined) node[target] = pick(["filled", 7, true]);
    }
  }
  return value;
}

describe("diffJson on generated documents", () => {
  test("1,800 generated pairs: the diff is total, every leaf has exactly one account, and it is deterministic", () => {
    const random = seeded(8675309);
    const { pick, chance } = toolkit(random);
    const seen = new Set<ClassKind>();
    let checked = 0;
    for (let n = 0; n < 1800; n++) {
      const root: Plain = { ...(randomPlain(random, 0) as object), Keep: 1 };
      const next = mutatePlain(random, root);
      const beforeText = textOf(root);
      const afterText = textOf(next);
      const b = parseJson(enc(beforeText));
      const a = parseJson(enc(afterText));
      if (!b.ok || !a.ok)
        throw new Error(`generated text is not JSON: ${beforeText} / ${afterText}`);

      // A sidecar that holds some of the removed top-level keys, applying to the file or not.
      const file = "sub-01/eeg/sub-01_task-x_eeg.json";
      const files: PoolFile[] = [];
      if (chance(0.5) && root !== null && typeof root === "object" && !Array.isArray(root)) {
        const kept: { [key: string]: Plain } = {};
        for (const [key, value] of Object.entries(root))
          if (chance(0.5))
            Object.defineProperty(kept, key, {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        const where = pick([
          "task-x_eeg.json",
          "eeg.json",
          "sub-01/task-x_eeg.json",
          "task-y_eeg.json",
          "task-x_events.json",
          "sub-02/task-x_eeg.json",
        ]);
        files.push(pooled(where, null, textOf(kept)));
      }
      const pool = buildPools(files).json;
      const result = diffJson(file, b.value.value, a.value.value, pool);
      if (!result.ok)
        throw new Error(`case ${n} refused: ${result.refusal}\n${beforeText}\n${afterText}`);
      checked++;
      const { atoms, counts } = result.value;
      for (const atom of atoms) seen.add(atom.kind);

      expect(verifyJsonCounts(result.value), `case ${n}`).toBe(true);
      const beforeLeaves = leavesOf(b.value.value);
      const afterLeaves = leavesOf(a.value.value);
      expect(counts.beforeLeaves).toBe(beforeLeaves.length);
      expect(counts.afterLeaves).toBe(afterLeaves.length);

      // Every before leaf that is not identical in the after document has exactly one account.
      const afterPairs = new Set(afterLeaves.map((leaf) => leafKey(leaf.path, leaf.value)));
      const beforePaths = new Set(beforeLeaves.map((leaf) => leaf.path));
      const lost = beforeLeaves.filter(
        (leaf) => !afterPairs.has(leafKey(leaf.path, leaf.value)),
      ).length;
      const accounts: ClassKind[] = [
        "json_value_changed",
        "json_type_changed",
        "json_emptied",
        "json_filled",
        "json_key_renamed",
        "json_key_moved",
        "json_key_removed",
        "json_empty_key_removed",
      ];
      expect(
        atoms.filter((x) => accounts.includes(x.kind)).length,
        `case ${n}\n${beforeText}\n${afterText}`,
      ).toBe(lost);
      // Every after leaf at a new path is an addition or the new name of a rename.
      const fresh = afterLeaves.filter((leaf) => !beforePaths.has(leaf.path)).length;
      expect(
        atoms.filter((x) => x.kind === "json_key_added" || x.kind === "json_key_renamed").length,
        `case ${n}`,
      ).toBe(fresh);
      // The tallies are the atoms.
      const tally = (kind: ClassKind): number => atoms.filter((x) => x.kind === kind).length;
      expect(tally("json_key_removed"), `case ${n}`).toBe(counts.removed);
      expect(tally("json_key_moved"), `case ${n}`).toBe(counts.moved);
      expect(tally("json_empty_key_removed"), `case ${n}`).toBe(counts.emptyRemoved);
      expect(tally("json_key_added"), `case ${n}`).toBe(counts.added);
      expect(tally("json_key_renamed"), `case ${n}`).toBe(counts.renamed);

      // The same leaves give no atom but possibly a reorder.
      if (lost === 0 && fresh === 0)
        expect(
          atoms.every((x) => x.kind === "json_keys_reordered"),
          `case ${n}`,
        ).toBe(true);

      const again = diffJson(file, b.value.value, a.value.value, buildPools(files).json);
      expect(again.ok && again.value.atoms, `case ${n}`).toEqual(atoms);
    }
    expect(checked).toBe(1800);
    for (const kind of [
      "json_value_changed",
      "json_type_changed",
      "json_emptied",
      "json_filled",
      "json_key_renamed",
      "json_key_moved",
      "json_key_removed",
      "json_empty_key_removed",
      "json_key_added",
      "json_keys_reordered",
    ] as ClassKind[]) {
      expect(seen.has(kind), kind).toBe(true);
    }
  });

  test("a document diffed against itself, however it is laid out, has no atoms", () => {
    const random = seeded(5);
    for (let n = 0; n < 300; n++) {
      const value = randomPlain(random, 0);
      const compact = parseJson(enc(JSON.stringify(value)));
      const spread = parseJson(enc(JSON.stringify(value, null, n % 3 === 0 ? 2 : "\t")));
      if (!compact.ok || !spread.ok) throw new Error("generated text is not JSON");
      const result = diffJson(
        "a.json",
        compact.value.value,
        spread.value.value,
        buildPools([]).json,
      );
      expect(result.ok && result.value.atoms, `case ${n}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Bounded time: no input makes one file's diff take more than a few seconds
// ---------------------------------------------------------------------------------------------

describe("the diffs are bounded in time on large and hostile input", () => {
  const channels = "sub-01/eeg/sub-01_task-x_channels.tsv";
  const noPool = buildPools([]);
  /** A case variant of a word: bit b of i upper-cases letter b. */
  const variant = (word: string, i: number): string =>
    [...word].map((ch, b) => ((i >> b) & 1 ? ch.toUpperCase() : ch)).join("");
  const timed = <T>(run: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = run();
    return { value, ms: performance.now() - started };
  };
  const kindCount = (diff: FileDiff, kind: ClassKind): number =>
    diff.atoms.filter((a) => a.kind === kind).length;
  const big = (lines: string[]): Table => table(`${lines.join("\n")}\n`);

  test("100,000 case variants of one word, in order and reversed, relabel in well under 3 seconds", () => {
    const n = 100_000;
    const word = "abcdefghijklmnopqr";
    const gone = ["name\ttype"];
    const added = ["name\ttype"];
    const reversed = ["name\ttype"];
    for (let i = 0; i < n; i++) gone.push(`${variant(word, 2 * i)}\tEEG`);
    for (let i = 0; i < n; i++) added.push(`${variant(word, 2 * i + 1)}\tEEG`);
    for (let i = n - 1; i >= 0; i--) reversed.push(`${variant(word, 2 * i + 1)}\tEEG`);
    for (const after of [added, reversed]) {
      const { value, ms } = timed(() => diffTable(channels, big(gone), big(after), noPool.rows));
      expect(value.ok).toBe(true);
      if (!value.ok) return;
      expect(kindCount(value.value, "key_relabeled")).toBe(n);
      expect(ms).toBeLessThan(3000);
    }
  }, 30_000);

  test("a gone row that never pairs, in front of 100,000 that do, does not make the lookup quadratic", () => {
    // Every lookup meets the first gone row, unpaired, before the ones already paired; counting
    // those toward the cap is what keeps each lookup bounded.
    const n = 100_000;
    const word = "abcdefghijklmnopqr";
    const gone = ["name\ttype"];
    const added = ["name\ttype"];
    for (let i = 0; i < n; i++) gone.push(`${variant(word, 2 * i)}\t${i === 0 ? "EMG" : "EEG"}`);
    for (let i = 0; i < n; i++) added.push(`${variant(word, 2 * i + 1)}\tEEG`);
    const { value, ms } = timed(() => diffTable(channels, big(gone), big(added), noPool.rows));
    expect(value.ok && kindCount(value.value, "key_relabeled")).toBe(n);
    expect(ms).toBeLessThan(3000);
  }, 30_000);

  test("a keyless table of 65,000 rows, all different or all edited, diffs in well under 3 seconds", () => {
    const n = 65_000;
    const header = "onset\tduration\ttrial_type";
    const before = [header];
    const unrelated = [header];
    const edited = [header];
    for (let i = 0; i < n; i++) before.push(`${i}\t1\tgo`);
    for (let i = 0; i < n; i++) unrelated.push(`${i}.5\tn/a\tstop`);
    for (let i = 0; i < n; i++) edited.push(`${i}.5\t1\tgo`);
    const events = "sub-01/eeg/sub-01_task-x_events.tsv";
    const first = timed(() => diffTable(events, big(before), big(unrelated), noPool.rows));
    expect(first.value.ok && kindCount(first.value.value, "row_removed")).toBe(n);
    expect(first.ms).toBeLessThan(3000);
    const second = timed(() => diffTable(events, big(before), big(edited), noPool.rows));
    expect(second.value.ok && kindCount(second.value.value, "cell_replaced")).toBe(n);
    expect(second.ms).toBeLessThan(3000);
  }, 30_000);

  test("90,000 removed and 90,000 added JSON keys sharing one value diff in well under 3 seconds", () => {
    const n = 90_000;
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let i = 0; i < n; i++) before[`k${"a".repeat(40)}${i}`] = "n/a";
    for (let i = 0; i < n; i++) after[`K${"a".repeat(40)}-${i}x`] = "n/a";
    const b = json(JSON.stringify(before));
    const a = json(JSON.stringify(after));
    const { value, ms } = timed(() => diffJson("x_eeg.json", b, a, noPool.json));
    expect(value.ok && value.value.counts).toMatchObject({ renamed: 0, emptyRemoved: n, added: n });
    expect(ms).toBeLessThan(3000);
  }, 30_000);

  test("candidate pairs on many-run keys are charged by their run pairs, and the worst stays fast", () => {
    // 100,000 keys of 23 runs against keys of 24 runs: every pair tried matches run against run and
    // then tries characters, and fails at the last digit. Charged one step per 8 pairs of runs, the
    // tries spend the budget midway through the walk by position, in well under 3 seconds (about
    // 0.75 s measured), so the nine real insertions at the end, which only that walk finds, stay a
    // removal and an addition. Charged by characters alone the budget would last and they would pair.
    const tag = (i: number): string => {
      let out = "";
      for (let k = 0, n = i; k < 4; k++, n = Math.floor(n / 26))
        out += String.fromCharCode(97 + (n % 26));
      return out;
    };
    const before = ["name\ttype"];
    const after = ["name\ttype"];
    for (let i = 0; i < 100_000; i++) {
      before.push(`${"x1".repeat(10)}x9${tag(i)}\tE`);
      after.push(`${"xxxxx1".repeat(10)}xxxxx8-${tag(i)}Q\tE`);
    }
    for (let i = 1; i <= 9; i++) {
      before.push(`GA0${i}\tE`);
      after.push(`EEGGA_0${i}REF\tE`);
    }
    const { value, ms } = timed(() => diffTable(channels, big(before), big(after), noPool.rows));
    expect(ms).toBeLessThan(3000);
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    expect(kindCount(value.value, "key_relabeled")).toBe(0);
    expect(
      value.value.atoms.filter((a) => a.kind === "row_removed").map((a) => a.before),
    ).toContain("GA01");
    // The same nine insertions alone pair, so it is the budget that stopped them.
    const alone = diffText(
      channels,
      tsv(["name", "type"], ...Array.from({ length: 9 }, (_, i) => [`GA0${i + 1}`, "E"])),
      tsv(["name", "type"], ...Array.from({ length: 9 }, (_, i) => [`EEGGA_0${i + 1}REF`, "E"])),
    );
    expect(kindCount(alone, "key_relabeled")).toBe(9);
  }, 30_000);

  test("candidate pairs on long keys are charged by size, so they spend the budget too", () => {
    // 7,000 added keys each look up a 100-letter word that 1,000 gone keys share, and try 64 of them;
    // every try fails on its cells. Charged by the size of the keys, those tries spend the whole
    // budget, so the nine real renames that come last are never tried and stay a removal and an
    // addition. Were a try charged one step, the budget would last and they would pair.
    const word = `abcdefghij${"k".repeat(90)}`;
    const variant = (i: number): string =>
      [...word].map((ch, b) => (b < 10 && (i >> b) & 1 ? ch.toUpperCase() : ch)).join("");
    const before = ["name\ttype"];
    const after = ["name\ttype"];
    for (let i = 0; i < 1000; i++) before.push(`${variant(i)}\tx${i}`);
    for (let j = 0; j < 7000; j++)
      after.push(`${variant(j % 1000)}-q${Math.floor(j / 1000)}\ty${j}`);
    for (let i = 1; i <= 9; i++) {
      before.push(`A${i}\tEEG`);
      after.push(`POL A${i}\tEEG`);
    }
    const { value, ms } = timed(() => diffTable(channels, big(before), big(after), noPool.rows));
    expect(ms).toBeLessThan(3000);
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    expect(kindCount(value.value, "key_relabeled")).toBe(0);
    expect(
      value.value.atoms.filter((a) => a.kind === "row_removed").map((a) => a.before),
    ).toContain("A1");
  }, 30_000);

  test("a table that spends the whole pairing budget stops pairing: what is left is removed and added, the same on every run", () => {
    // 60,000 gone keys of every length up to 110 letters, and as many added keys of 24 runs whose
    // every part is looked up and never found: the lookup alone would need far more steps than
    // the budget allows. Nine renamed rows come last, after the budget is gone, so they stay a
    // removal and an addition even though each is a strict relabel with every cell equal.
    const n = 60_000;
    const header = "name\ttype";
    const before = [header];
    const after = [header];
    for (let i = 0; i < n; i++) before.push(`${"z".repeat((i % 110) + 1)}${i}\tx${i}`);
    for (let i = 0; i < n; i++) {
      const parts = Array.from({ length: 12 }, (_, k) => "q".repeat(((i + k * 7) % 9) + 1));
      after.push(`${parts.join("-")}${i}\ty${i}`);
    }
    for (let i = 1; i <= 9; i++) {
      before.push(`A${i}\tEEG`);
      after.push(`POL A${i}\tEEG`);
    }
    const b = big(before);
    const a = big(after);
    const first = timed(() => diffTable(channels, b, a, noPool.rows));
    expect(first.ms).toBeLessThan(3000);
    expect(first.value.ok).toBe(true);
    if (!first.value.ok) return;
    expect(kindCount(first.value.value, "key_relabeled")).toBe(0);
    expect(first.value.value.counts).toMatchObject({ removed: n + 9, added: n + 9 });
    const again = diffTable(channels, b, a, noPool.rows);
    expect(again.ok && again.value.atoms).toEqual(first.value.value.atoms);
    // The budget is per file: the nine renamed rows alone pair as they should.
    const alone = diffText(
      channels,
      tsv(["name", "type"], ...Array.from({ length: 9 }, (_, i) => [`A${i + 1}`, "EEG"])),
      tsv(["name", "type"], ...Array.from({ length: 9 }, (_, i) => [`POL A${i + 1}`, "EEG"])),
    );
    expect(kindCount(alone, "key_relabeled")).toBe(9);
  }, 30_000);

  test("a legitimate relabel of 200,000 rows stays well inside the budget", () => {
    const n = 200_000;
    const before = ["name\ttype"];
    const after = ["name\ttype"];
    for (let i = 0; i < n; i++) {
      before.push(`EEG A${i}-Ref\tEEG`);
      after.push(`A${i}\tEEG`);
    }
    const { value, ms } = timed(() => diffTable(channels, big(before), big(after), noPool.rows));
    expect(value.ok && kindCount(value.value, "key_relabeled")).toBe(n);
    expect(ms).toBeLessThan(3000);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Reconstruction oracles: the before side must be recoverable from the after side and the atoms
// ---------------------------------------------------------------------------------------------
//
// The tallies say every row and leaf landed in one bucket; these say the atoms are the TRUTH about
// the buckets. An oracle written apart from the module takes the after version of a file and the
// atoms of its diff, undoes every atom, and must get the before version back: the rows as a
// multiset (a keyed table by key, a keyless one up to which row became which), the leaves path by
// path. A relocation must be a verbatim copy that the pool really holds, a relabel must stand on
// the evidence of design section 4.4, and a rename or move on the conditions of section 4.6 and
// 4.7. The generators draw from small alphabets where names collide (A1, A10, a1, sub-1, sub-01),
// so the diff is forced to choose, and each oracle proves it is not vacuous by catching a diff
// with one atom dropped.

/** A multiset of strings. */
function bag(items: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}
function sameBag(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, n] of a) if (b.get(k) !== n) return false;
  return true;
}
/** Take one of `item` from the bag, or say there was none. */
function takeOne(from: Map<string, number>, item: string): boolean {
  const n = from.get(item) ?? 0;
  if (n <= 0) return false;
  from.set(item, n - 1);
  return true;
}
const missingCell = (v: string): boolean => v === "" || v === "n/a";

/** Every ordering of 0..n-1 (n is at most 7 here). */
function* orderings(n: number): Generator<number[]> {
  const a = Array.from({ length: n }, (_, i) => i);
  const c = new Array<number>(n).fill(0);
  yield [...a];
  let i = 0;
  while (i < n) {
    if ((c[i] as number) < i) {
      const k = i % 2 === 0 ? 0 : (c[i] as number);
      [a[k], a[i]] = [a[i] as number, a[k] as number];
      yield [...a];
      c[i] = (c[i] as number) + 1;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

/** A table side as the oracle holds it: a header and rows of cells. */
interface Sheet {
  header: string[];
  rows: string[][];
}

/** The rows a pool file adds, read from its text with nothing of the module: the oracle's own pool. */
function oraclePoolRows(file: PoolFile): { header: string; rows: Map<string, number> } | null {
  const read = (bytes: Uint8Array | null): Sheet | null => {
    if (bytes === null) return null;
    const lines = new TextDecoder().decode(bytes).split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const [head, ...body] = lines;
    if (head === undefined) return null;
    return { header: head.split("\t"), rows: body.map((line) => line.split("\t")) };
  };
  const after = read(file.after);
  if (after === null) return null;
  const before = read(file.before);
  const known =
    before !== null && before.header.join("\t") === after.header.join("\t")
      ? bag(before.rows.map((r) => r.join("\t")))
      : new Map<string, number>();
  const rows = new Map<string, number>();
  for (const row of after.rows) {
    const text = row.join("\t");
    if (!takeOne(known, text)) rows.set(text, (rows.get(text) ?? 0) + 1);
  }
  return { header: after.header.join("\t"), rows };
}

/** EQ (equal and not missing) and DIFF over the named columns of two rows. */
function evidenceOf(
  b: Sheet,
  br: string[],
  a: Sheet,
  ar: string[],
  columns: string[],
): { equal: number; differ: number } {
  let equal = 0;
  let differ = 0;
  for (const column of columns) {
    const x = br[b.header.indexOf(column)] as string;
    const y = ar[a.header.indexOf(column)] as string;
    if (x !== y) differ++;
    else if (!missingCell(x)) equal++;
  }
  return { equal, differ };
}

/** Whether only the zero padding of digit runs that do not touch a `.` or `,` differs. */
function onlyStandalonePadding(b: string, a: string): boolean {
  const pb = partsOf(b);
  const pa = partsOf(a);
  if (pb.length !== pa.length) return false;
  for (let i = 0; i < pb.length; i++) {
    if (pb[i] === pa[i]) continue;
    if (!/^[0-9]+$/.test(pb[i] as string) || !/^[0-9]+$/.test(pa[i] as string)) return false;
    if (byValue(pb[i] as string) !== byValue(pa[i] as string)) return false;
    for (const near of [pb[i - 1], pb[i + 1], pa[i - 1], pa[i + 1]]) {
      if (near === "." || near === ",") return false;
    }
  }
  return true;
}

/**
 * Everything the oracle finds wrong with a table diff, as words. `available` is the oracle's own
 * account of the pool copies left for this file, and is used up by the relocations it checks.
 */
function tableViolations(
  path: string,
  b: Sheet,
  a: Sheet,
  atoms: readonly Atom[],
  keyColumn: string | null,
  available: Map<string, Map<string, number>>,
): string[] {
  const out: string[] = [];
  const common = b.header.filter((c) => a.header.includes(c));
  // Columns.
  for (const column of b.header) {
    if (a.header.includes(column)) continue;
    const present = b.rows.filter(
      (r) => !missingCell(r[b.header.indexOf(column)] as string),
    ).length;
    const found = atoms.filter((x) => x.kind === "column_removed" && x.field === column);
    if (found.length !== 1 || found[0]?.detail !== String(present)) out.push("column_removed");
  }
  const addedColumns = a.header.filter((c) => !b.header.includes(c));
  if (
    !sameBag(
      bag(addedColumns),
      bag(atoms.filter((x) => x.kind === "column_added").map((x) => x.field as string)),
    )
  )
    out.push("column_added");
  if (atoms.some((x) => x.kind === "column_removed" && a.header.includes(x.field as string)))
    out.push("column_removed_still_there");

  // Cell atoms: their kind must match what the two values are.
  const cellAtoms = atoms.filter((x) => x.kind.startsWith("cell_"));
  for (const x of cellAtoms) {
    const before = x.before as string;
    const after = x.after as string;
    const expected =
      !missingCell(before) && missingCell(after)
        ? "cell_emptied"
        : missingCell(before) && !missingCell(after)
          ? "cell_filled"
          : null;
    if (expected !== null && x.kind !== expected) out.push("cell_kind");
    if (expected === null && (x.kind === "cell_emptied" || x.kind === "cell_filled"))
      out.push("cell_kind");
    if (x.kind === "cell_templated") {
      const rule = x.rule as RelabelRule;
      if (!["wrap", "strip", "repad"].includes(rule.kind) || !rebuilds(rule, before, after))
        out.push("cell_template_rule");
    }
  }
  const cellBag = bag(cellAtoms.map((x) => JSON.stringify([x.field, x.before, x.after])));

  // Relocations: each a verbatim, unused copy at sourcedata/<one directory>/<path>, under the
  // header the row had before.
  const fullRowOf = (x: Atom): string | null => {
    if (keyColumn === null) return x.before;
    const row = b.rows.find((r) => r[b.header.indexOf(keyColumn)] === x.before);
    return row === undefined ? null : row.join("\t");
  };
  for (const x of atoms.filter((y) => y.kind === "row_relocated")) {
    const text = fullRowOf(x);
    let found = false;
    for (const [target, rows] of available) {
      const middle = target.slice("sourcedata/".length, target.length - path.length - 1);
      const corresponds =
        target.startsWith("sourcedata/") &&
        target.endsWith(`/${path}`) &&
        middle.length > 0 &&
        !middle.includes("/");
      if (!corresponds || text === null) continue;
      if (takeOne(rows, `${b.header.join("\t")}\u{0}${text}`)) {
        found = true;
        break;
      }
    }
    if (!found) out.push("relocated_without_copy");
  }

  if (keyColumn !== null) {
    const ki = b.header.indexOf(keyColumn);
    const ka = a.header.indexOf(keyColumn);
    const beforeByKey = new Map(b.rows.map((r) => [r[ki] as string, r]));
    const afterByKey = new Map(a.rows.map((r) => [r[ka] as string, r]));
    const addedKeys = new Set(
      atoms.filter((x) => x.kind === "row_added").map((x) => x.after as string),
    );
    const relabels = atoms.filter((x) => x.kind === "key_relabeled");
    const relabelTargets = new Set(relabels.map((x) => x.after as string));
    // Undo: every after key that is not new and not a relabel's target was its own before key.
    const pairsOf = new Map<string, string>();
    for (const key of afterByKey.keys())
      if (!addedKeys.has(key) && !relabelTargets.has(key)) pairsOf.set(key, key);
    for (const x of relabels) pairsOf.set(x.before as string, x.after as string);
    const gone = atoms
      .filter((x) => x.kind === "row_removed" || x.kind === "row_relocated")
      .map((x) => x.before as string);
    const rebuilt = [...pairsOf.keys(), ...gone].sort();
    const truth = [...beforeByKey.keys()].sort();
    if (JSON.stringify(rebuilt) !== JSON.stringify(truth)) {
      out.push("keyed_keys");
      return out;
    }
    const others = common.filter((c) => c !== keyColumn);
    const expected: string[] = [];
    for (const [bk, ak] of pairsOf) {
      const br = beforeByKey.get(bk);
      const ar = afterByKey.get(ak);
      if (br === undefined || ar === undefined) {
        out.push("keyed_pair_missing");
        continue;
      }
      for (const c of others) {
        const x = br[b.header.indexOf(c)] as string;
        const y = ar[a.header.indexOf(c)] as string;
        if (x !== y) expected.push(JSON.stringify([c, x, y]));
      }
    }
    if (!sameBag(bag(expected), cellBag)) out.push("keyed_cells");
    // Every relabel is exact, anchored, and stands on its evidence.
    for (const x of relabels) {
      const rule = x.rule as RelabelRule;
      const before = x.before as string;
      const after = x.after as string;
      if (!rebuilds(rule, before, after) || !anchored(rule, before, after))
        out.push("relabel_rule");
      if (rule.kind === "repad" && !onlyStandalonePadding(before, after)) out.push("repad_decimal");
      const br = beforeByKey.get(before);
      const ar = afterByKey.get(after);
      if (br === undefined || ar === undefined) continue;
      const { equal, differ } = evidenceOf(b, br, a, ar, others);
      if (rule.kind !== "case" && rule.kind !== "repad" && (equal < 1 || equal < differ))
        out.push("relabel_without_evidence");
      if (rule.shape.startsWith("c") && differ > 0) out.push("character_rule_not_strict");
    }
  } else {
    if (atoms.some((x) => x.kind === "key_relabeled")) out.push("keyless_relabel");
    const left = bag(b.rows.map((r) => r.join("\t")));
    for (const x of atoms.filter((y) => y.kind === "row_removed" || y.kind === "row_relocated"))
      if (!takeOne(left, x.before as string)) out.push("keyless_removed_absent");
    const right = bag(a.rows.map((r) => r.join("\t")));
    for (const x of atoms.filter((y) => y.kind === "row_added"))
      if (!takeOne(right, x.after as string)) out.push("keyless_added_absent");
    const expand = (m: Map<string, number>): string[][] =>
      [...m].flatMap(([text, n]) => Array.from({ length: n }, () => text.split("\t")));
    const pb = expand(left);
    const pa = expand(right);
    if (pb.length !== pa.length) {
      out.push("keyless_counts");
      return out;
    }
    // Some one-to-one pairing of what is left explains the cell atoms exactly, and every pair in
    // it that differs at all is near (design section 4.5).
    let explained = false;
    for (const order of orderings(pb.length)) {
      const cells: string[] = [];
      let near = true;
      pb.forEach((br, i) => {
        const ar = pa[order[i] as number] as string[];
        const { equal, differ } = evidenceOf(b, br, a, ar, common);
        if (differ > 0 && (differ * 2 > common.length || equal < differ)) near = false;
        for (const c of common) {
          const x = br[b.header.indexOf(c)] as string;
          const y = ar[a.header.indexOf(c)] as string;
          if (x !== y) cells.push(JSON.stringify([c, x, y]));
        }
      });
      if (near && sameBag(bag(cells), cellBag)) {
        explained = true;
        break;
      }
    }
    if (!explained) out.push("keyless_not_reconstructible");
  }
  return out;
}

const ORACLE_KEYS = [
  "A1",
  "A10",
  "a1",
  "POL A1",
  "sub-1",
  "sub-01",
  "sub-10",
  "A01",
  "Cz",
  "FCz",
  "CZ",
  "A1-A2",
  "EEG A1",
  "x",
  "A2",
  "GA01",
  "EEGGA_01REF",
  "DCEMBRACE",
  "DC EMBRACE-REF",
  "A1.05",
  "A1.5",
];
const ORACLE_CELLS = ["n/a", "", "0", "1", "x", "EEG", "X", "1.0"];
const ORACLE_FILES: { path: string; key: string | null }[] = [
  { path: "sub-01/eeg/sub-01_task-x_channels.tsv", key: "name" },
  { path: "participants.tsv", key: "participant_id" },
  { path: "sub-01/sub-01_scans.tsv", key: "filename" },
  { path: "sub-01/sub-01_sessions.tsv", key: "session_id" },
  { path: "sub-01/eeg/sub-01_task-x_events.tsv", key: null },
  { path: "phenotype/iq.tsv", key: null },
];

interface OracleTableFile {
  path: string;
  before: Sheet;
  after: Sheet;
}

/** One generated case: one or two files, sometimes the same path twice, and one shared pool. */
function generateOracleTables(random: () => number): {
  files: OracleTableFile[];
  pool: PoolFile[];
  traits: Set<string>;
} {
  const { pick, chance, int, shuffled } = toolkit(random);
  const traits = new Set<string>();
  const pool: PoolFile[] = [];
  const files: OracleTableFile[] = [];
  const count = chance(0.25) ? 2 : 1;
  for (let f = 0; f < count; f++) {
    const sameAgain = f === 1 && chance(0.3);
    const spec = sameAgain
      ? (ORACLE_FILES.find((x) => x.path === files[0]?.path) ?? pick(ORACLE_FILES))
      : pick(ORACLE_FILES);
    if (f === 1) traits.add(sameAgain ? "same_path_twice" : "two_files_one_pool");
    const keyName = spec.key ?? "name";
    let header = [
      ...(chance(0.9) ? [keyName] : []),
      ...["type", "units", "c", "d"].filter(() => chance(0.45)),
    ];
    if (header.length === 0) header = ["c"];
    if (chance(0.15)) header = shuffled(header);
    if (header.length === 1) traits.add("one_column");
    const keyAt = header.indexOf(keyName);
    const uniqueKeys = chance(0.6);
    const used = new Set<string>();
    const rows: string[][] = [];
    const total = chance(0.08) ? 0 : int(1, 6);
    if (total === 0) traits.add("header_only");
    for (let i = 0; i < total; i++) {
      if (rows.length > 0 && chance(0.2)) {
        rows.push([...(pick(rows) as string[])]);
        traits.add("whole_row_duplicate");
        continue;
      }
      const row = header.map(() => pick(ORACLE_CELLS));
      if (keyAt >= 0) {
        let key = chance(0.06) ? pick(["", "n/a"]) : pick(ORACLE_KEYS);
        if (uniqueKeys) for (let t = 0; t < 20 && used.has(key); t++) key = pick(ORACLE_KEYS);
        if (key === "" || key === "n/a") traits.add("missing_key");
        if (used.has(key)) traits.add("duplicate_key");
        used.add(key);
        row[keyAt] = key;
      }
      rows.push(row);
    }
    let afterHeader = [...header];
    if (chance(0.15) && afterHeader.length > 1) {
      afterHeader.splice(int(0, afterHeader.length - 1), 1);
      traits.add("column_removed");
    }
    if (chance(0.15)) {
      const extra = pick(["e", "type", "units", keyName]);
      if (!afterHeader.includes(extra)) {
        afterHeader.push(extra);
        traits.add("column_added");
      }
    }
    if (chance(0.15)) {
      afterHeader = shuffled(afterHeader);
      traits.add("columns_shuffled");
    }
    const afterRows: string[][] = [];
    const relocated: string[][] = [];
    let renamed = 0;
    for (const row of rows) {
      const op = random();
      if (op < 0.2) continue; // deleted
      if (op < 0.4) {
        relocated.push(row);
        continue;
      }
      const cells = new Map(header.map((h, i) => [h, row[i] as string]));
      if (op < 0.55 && keyAt >= 0) {
        cells.set(keyName, pick(ORACLE_KEYS));
        renamed++;
      }
      if (chance(0.3)) {
        const h = pick(afterHeader);
        if (h !== keyName) cells.set(h, pick(ORACLE_CELLS));
      }
      afterRows.push(afterHeader.map((h) => cells.get(h) ?? pick(ORACLE_CELLS)));
    }
    if (renamed > 1) traits.add("several_renames");
    for (let i = int(0, 3); i > 0; i--) {
      if (afterRows.length > 0 && chance(0.2)) afterRows.push([...(pick(afterRows) as string[])]);
      else
        afterRows.push(
          afterHeader.map((h) => (h === keyName ? pick(ORACLE_KEYS) : pick(ORACLE_CELLS))),
        );
    }
    const finalRows = chance(0.3) ? shuffled(afterRows) : afterRows;
    files.push({
      path: spec.path,
      before: { header, rows },
      after: { header: afterHeader, rows: finalRows },
    });
    // The copies: under the corresponding path, sometimes broken, sometimes elsewhere.
    if (relocated.length > 0 || chance(0.2)) {
      const mode = random();
      const where =
        mode < 0.7
          ? `sourcedata/${pick(["removed", "old", "x y"])}/${spec.path}`
          : mode < 0.8
            ? `sourcedata/${spec.path}`
            : mode < 0.9
              ? `sourcedata/a/b/${spec.path}`
              : `derivatives/old/${spec.path}`;
      if (
        !where.startsWith("sourcedata/removed") &&
        !where.startsWith("sourcedata/old") &&
        !where.startsWith("sourcedata/x y")
      )
        traits.add("copy_elsewhere");
      let copyHeader = header;
      let copies = relocated.map((r) => [...r]);
      if (chance(0.1) && header.length > 1) {
        copyHeader = [...header].reverse();
        traits.add("copy_other_header");
      }
      if (chance(0.15) && copies.length > 0) {
        const r = pick(copies);
        r[0] = `${r[0]}!`;
        traits.add("copy_one_byte_off");
      }
      if (chance(0.15) && rows.length > 0) {
        copies.push([...(pick(rows) as string[])]);
        traits.add("copy_of_kept_row");
      }
      if (chance(0.2)) copies = [...copies, ...copies];
      if (!pool.some((p) => p.path === where))
        pool.push(pooled(where, null, tsv(copyHeader, ...copies)));
    }
  }
  return { files, pool, traits };
}

describe("reconstruction oracle: tables", () => {
  test("6,000 generated cases: the before rows are recovered from the after rows and the atoms, and every relocation is a verbatim unused copy", () => {
    const random = seeded(20261020);
    const traits = new Map<string, number>();
    const seen = new Set<ClassKind>();
    let diffs = 0;
    let skipped = 0;
    let selfTests = 0;
    const violations: string[] = [];
    for (let n = 0; n < 6000; n++) {
      const generated = generateOracleTables(random);
      const tables = generated.files.map((f) => ({
        f,
        b: parseTsv(enc(tsv(f.before.header, ...f.before.rows))),
        a: parseTsv(enc(tsv(f.after.header, ...f.after.rows))),
      }));
      if (tables.some((t) => !t.b.ok || !t.a.ok)) {
        skipped++;
        continue;
      }
      for (const trait of generated.traits) traits.set(trait, (traits.get(trait) ?? 0) + 1);
      const pool = buildPools(generated.pool).rows;
      // The oracle's own account of the copies, keyed by header and row text, per target.
      const available = new Map<string, Map<string, number>>();
      for (const file of generated.pool) {
        const rows = oraclePoolRows(file);
        if (rows === null) continue;
        const keyed = new Map<string, number>();
        for (const [text, k] of rows.rows) keyed.set(`${rows.header}\u{0}${text}`, k);
        available.set(file.path, keyed);
      }
      for (const { f, b, a } of tables) {
        if (!b.ok || !a.ok) continue;
        const result = diffTable(f.path, b.value, a.value, pool);
        if (!result.ok) {
          violations.push(`case ${n}: refused ${result.refusal}`);
          continue;
        }
        diffs++;
        const diff = result.value;
        for (const atom of diff.atoms) seen.add(atom.kind);
        if (!verifyTableCounts(diff)) violations.push(`case ${n}: counts`);
        if (diff.atoms.some((x) => x.kind === "row_relocated"))
          traits.set("relocated", (traits.get("relocated") ?? 0) + 1);
        if (diff.keyColumn === null && diff.atoms.some((x) => x.kind.startsWith("cell_")))
          traits.set("keyless_edit", (traits.get("keyless_edit") ?? 0) + 1);
        const snapshot = new Map([...available].map(([k, v]) => [k, new Map(v)]));
        const found = tableViolations(
          f.path,
          f.before,
          f.after,
          diff.atoms,
          diff.keyColumn,
          available,
        );
        for (const v of found)
          violations.push(
            `case ${n} ${f.path}: ${v}\n${JSON.stringify(f)}\n${JSON.stringify(generated.pool.map((p) => p.path))}\n${diff.atoms.map(line).join("\n")}`,
          );

        // The oracle is not vacuous: with any one accounted atom dropped it must object.
        const accounted = diff.atoms
          .map((x, i) => [x, i] as const)
          .filter(
            ([x]) =>
              [
                "row_removed",
                "row_added",
                "row_relocated",
                "key_relabeled",
                "column_removed",
                "column_added",
              ].includes(x.kind) || x.kind.startsWith("cell_"),
          );
        if (accounted.length > 0) {
          const [, drop] = accounted[Math.floor(random() * accounted.length)] as readonly [
            Atom,
            number,
          ];
          const fewer = diff.atoms.filter((_, i) => i !== drop);
          const caught = tableViolations(
            f.path,
            f.before,
            f.after,
            fewer,
            diff.keyColumn,
            snapshot,
          );
          selfTests++;
          if (caught.length === 0)
            violations.push(
              `case ${n}: dropping ${diff.atoms[drop]?.kind} went unnoticed\n${JSON.stringify(f)}`,
            );
        }
      }
    }
    expect(violations.slice(0, 3)).toEqual([]);
    expect(skipped).toBeLessThan(600);
    expect(diffs).toBeGreaterThan(6000);
    expect(selfTests).toBeGreaterThan(4000);
    // The distribution reaches the shapes where a diff can go wrong.
    for (const [trait, least] of [
      ["whole_row_duplicate", 300],
      ["missing_key", 100],
      ["duplicate_key", 300],
      ["two_files_one_pool", 400],
      ["same_path_twice", 150],
      ["several_renames", 300],
      ["one_column", 150],
      ["header_only", 200],
      ["column_removed", 300],
      ["column_added", 300],
      ["columns_shuffled", 300],
      ["copy_elsewhere", 200],
      ["copy_other_header", 100],
      ["copy_one_byte_off", 100],
      ["copy_of_kept_row", 100],
      ["relocated", 500],
      ["keyless_edit", 200],
    ] as const) {
      expect(traits.get(trait) ?? 0, trait).toBeGreaterThanOrEqual(least);
    }
    for (const kind of [
      "row_removed",
      "row_added",
      "row_relocated",
      "key_relabeled",
      "cell_replaced",
      "cell_emptied",
      "cell_filled",
      "cell_templated",
      "column_removed",
      "column_added",
      "columns_reordered",
      "rows_reordered",
    ] as ClassKind[]) {
      expect(seen.has(kind), kind).toBe(true);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------

/** A leaf as the JSON oracle reads it, from the plain value and nothing of the module. */
interface OracleLeaf {
  value: string;
  parent: string;
  name: string;
  top: string | null;
}

const ORACLE_BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const oracleSegment = (key: string): string =>
  ORACLE_BARE.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;

function oracleCanonical(v: Plain): string {
  if (Array.isArray(v)) return `[${v.map(oracleCanonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .map((k) => `${JSON.stringify(k)}:${oracleCanonical(v[k] as Plain)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

function oracleLeaves(root: Plain): Map<string, OracleLeaf> {
  const out = new Map<string, OracleLeaf>();
  const walk = (v: Plain, path: string, parent: string, name: string, top: string | null): void => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      for (const k of Object.keys(v))
        walk(v[k] as Plain, path + oracleSegment(k), path, k, path === "" ? k : top);
      return;
    }
    if (Array.isArray(v) && v.some((x) => x !== null && typeof x === "object")) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, path, `[${i}]`, top));
      return;
    }
    out.set(path, { value: oracleCanonical(v), parent, name, top });
  };
  walk(root, "", "", "", null);
  return out;
}

function oracleMissing(v: Plain): boolean {
  if (v === null || v === "" || v === "n/a") return true;
  if (Array.isArray(v)) return v.every(oracleMissing);
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}
/** Case and punctuation folded, except punctuation with a digit on both sides (design section 4.7). */
function oracleFold(name: string): string {
  const chars = [...name.toLowerCase()];
  const word = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const digit = (c: string | undefined): boolean => c !== undefined && /\p{N}/u.test(c);
  return chars
    .filter((ch, i) => {
      if (word(ch)) return true;
      let before = i - 1;
      while (before >= 0 && !word(chars[before])) before--;
      let after = i + 1;
      while (after < chars.length && !word(chars[after])) after++;
      return digit(chars[before]) && digit(chars[after]);
    })
    .join("");
}
const typeWord = (v: Plain): string => (v === null ? "null" : Array.isArray(v) ? "arr" : typeof v);

/** The JSON files a generated case may put moved keys in, and whether each applies to which file. */
const ORACLE_SIDECARS: { path: string; appliesTo: readonly string[]; nearness: number }[] = [
  {
    path: "task-x_eeg.json",
    appliesTo: ["sub-01/eeg/sub-01_task-x_eeg.json", "sub-02/eeg/sub-02_task-x_eeg.json"],
    nearness: 0,
  },
  {
    path: "sub-01/sub-01_task-x_eeg.json",
    appliesTo: ["sub-01/eeg/sub-01_task-x_eeg.json"],
    nearness: 1,
  },
  { path: "sub-02/eeg/sub-02_task-x_eeg.json", appliesTo: [], nearness: 2 },
  { path: "task-x_channels.json", appliesTo: [], nearness: 0 },
  { path: "sub-01/eeg/sub-01_task-x_run-1_eeg.json", appliesTo: [], nearness: 2 },
];

/** Everything the oracle finds wrong with a JSON diff. */
function jsonViolations(
  path: string,
  before: Plain,
  after: Plain,
  atoms: readonly Atom[],
  sidecars: { path: string; before: Plain | null; after: Plain }[],
): string[] {
  const out: string[] = [];
  const bl = oracleLeaves(before);
  const al = oracleLeaves(after);
  // The path a key atom names, resolved against the side that has it: a key named "[0]" and the
  // index 0, and the root and a key named "", are told apart by which one that side holds.
  const resolve = (leaves: Map<string, OracleLeaf>, parent: string, name: string): string => {
    const candidates = [parent + oracleSegment(name)];
    if (/^\[[0-9]+\]$/.test(name)) candidates.push(parent + name);
    if (parent === "" && name === "") candidates.push("");
    return candidates.find((c) => leaves.has(c)) ?? (candidates[0] as string);
  };
  const rebuilt = new Map([...al].map(([p, leaf]) => [p, leaf.value]));
  for (const x of atoms) {
    switch (x.kind) {
      case "json_key_added": {
        const p = resolve(al, x.field as string, x.detail as string);
        if (rebuilt.get(p) !== x.after || bl.has(p)) out.push("added");
        rebuilt.delete(p);
        break;
      }
      case "json_value_changed":
      case "json_type_changed":
      case "json_emptied":
      case "json_filled": {
        const p = x.field as string;
        if (rebuilt.get(p) !== x.after) out.push("changed_after");
        rebuilt.set(p, x.before as string);
        const was = JSON.parse(x.before as string) as Plain;
        const now = JSON.parse(x.after as string) as Plain;
        const kind =
          !oracleMissing(was) && oracleMissing(now)
            ? "json_emptied"
            : oracleMissing(was) && !oracleMissing(now)
              ? "json_filled"
              : typeWord(was) !== typeWord(now)
                ? "json_type_changed"
                : "json_value_changed";
        if (kind !== x.kind) out.push(`kind ${x.kind} should be ${kind}`);
        break;
      }
      case "json_key_renamed": {
        const [oldName, newName] = (x.detail as string).split(" -> ") as [string, string];
        const np = resolve(al, x.field as string, newName);
        const op = resolve(bl, x.field as string, oldName);
        if (rebuilt.get(np) !== x.after || x.before !== x.after) out.push("renamed_after");
        rebuilt.delete(np);
        if (rebuilt.has(op)) out.push("renamed_over");
        rebuilt.set(op, x.before as string);
        const shared = (leaves: Map<string, OracleLeaf>) =>
          [...leaves.values()].filter((l) => l.parent === x.field && l.value === x.before).length;
        if (shared(bl) !== 1 || shared(al) !== 1) out.push("renamed_shared_value");
        if (
          oracleFold(oldName) !== oracleFold(newName) &&
          relabelRule(oldName, newName, { chars: false }) === null
        )
          out.push("renamed_unrelated_names");
        break;
      }
      case "json_key_removed":
      case "json_key_moved":
      case "json_empty_key_removed": {
        const p = resolve(bl, x.field as string, x.detail as string);
        if (rebuilt.has(p)) out.push("removed_still_there");
        rebuilt.set(p, x.before as string);
        const missing = oracleMissing(JSON.parse(x.before as string) as Plain);
        if (x.kind === "json_empty_key_removed" && !missing) out.push("empty_removed_had_value");
        if (x.kind === "json_key_removed" && missing) out.push("removed_held_nothing");
        if (x.kind === "json_key_moved") {
          const top = bl.get(p)?.top ?? null;
          const keepsTop =
            after === null ||
            typeof after !== "object" ||
            Array.isArray(after) ||
            top === null ||
            Object.prototype.hasOwnProperty.call(after, top);
          if (keepsTop) out.push("moved_but_shadowed");
          // The nearest applying sidecar that has the top-level key must be the one holding the
          // leaf as new; the oracle's sidecars differ in nearness, so there is no tie to decide.
          const deciding = sidecars
            .map((sc) => ({ sc, spec: ORACLE_SIDECARS.find((o) => o.path === sc.path) }))
            .filter(
              ({ sc, spec }) =>
                (spec?.appliesTo.includes(path) ?? false) &&
                top !== null &&
                sc.after !== null &&
                typeof sc.after === "object" &&
                !Array.isArray(sc.after) &&
                Object.prototype.hasOwnProperty.call(sc.after, top),
            )
            .sort((m, n) => (n.spec?.nearness ?? 0) - (m.spec?.nearness ?? 0))[0]?.sc;
          const now = deciding === undefined ? undefined : oracleLeaves(deciding.after).get(p);
          const then =
            deciding === undefined || deciding.before === null
              ? undefined
              : oracleLeaves(deciding.before).get(p);
          if (now?.value !== x.before || then?.value === x.before) out.push("moved_not_by_nearest");
        }
        break;
      }
      case "json_keys_reordered":
        break;
      default:
        out.push(`foreign ${x.kind}`);
    }
  }
  const same =
    rebuilt.size === bl.size && [...bl].every(([p, leaf]) => rebuilt.get(p) === leaf.value);
  if (!same) out.push("not_reconstructible");
  return out;
}

const ORACLE_JSON_KEYS = [
  "Name",
  "name",
  "na-me",
  "a",
  "A",
  "b",
  "x1",
  "x10",
  "x01",
  "go",
  "go2",
  "Level",
  "K1",
  "a.b",
  "0",
  "[0]",
];
const ORACLE_JSON_SCALARS: Plain[] = [0, false, "None", null, "n/a", "", "x", 1, "1", " ", "Go"];

function oracleValue(random: () => number, depth: number): Plain {
  const { pick, chance, int } = toolkit(random);
  if (depth >= 3 || chance(0.45)) return pick(ORACLE_JSON_SCALARS);
  if (chance(0.3)) {
    const nested = chance(0.5);
    return Array.from({ length: int(0, 3) }, () =>
      nested && chance(0.6) ? oracleObject(random, depth + 1) : pick(ORACLE_JSON_SCALARS),
    );
  }
  return oracleObject(random, depth + 1);
}
function oracleObject(random: () => number, depth: number): { [key: string]: Plain } {
  const { pick, int } = toolkit(random);
  const o: { [key: string]: Plain } = {};
  for (let i = int(0, 4); i > 0; i--) o[pick(ORACLE_JSON_KEYS)] = oracleValue(random, depth);
  return o;
}

describe("reconstruction oracle: JSON", () => {
  test("6,000 generated cases: the before leaves are recovered from the after leaves and the atoms, and every rename and move stands", () => {
    const random = seeded(4242);
    const { pick, chance, int } = toolkit(random);
    const traits = new Map<string, number>();
    const note = (trait: string): void => {
      traits.set(trait, (traits.get(trait) ?? 0) + 1);
    };
    const seen = new Set<ClassKind>();
    const violations: string[] = [];
    let diffs = 0;
    let selfTests = 0;
    const targets = ["sub-01/eeg/sub-01_task-x_eeg.json", "sub-02/eeg/sub-02_task-x_eeg.json"];
    for (let n = 0; n < 6000; n++) {
      // One or two files share one pool of sidecars.
      const files = chance(0.3) ? targets : [pick(targets)];
      if (files.length === 2) note("shared_pool");
      const sidecarAfter = new Map<string, { [key: string]: Plain }>();
      const cases: { path: string; before: Plain; after: Plain }[] = [];
      for (const path of files) {
        let before: Plain;
        if (chance(0.08)) {
          before = chance(0.5)
            ? pick(ORACLE_JSON_SCALARS)
            : [pick(ORACLE_JSON_SCALARS), oracleObject(random, 1)];
          note("non_object_root");
        } else before = oracleObject(random, 0);
        let after: Plain = JSON.parse(JSON.stringify(before)) as Plain;
        if (after !== null && typeof after === "object" && !Array.isArray(after)) {
          const doc = after;
          let renames = 0;
          for (const key of Object.keys(doc)) {
            const op = random();
            if (op < 0.15) {
              delete doc[key];
            } else if (op < 0.38) {
              const respelled = pick([
                key.toUpperCase(),
                `${key}_`,
                `EEG_${key}`,
                key.replace(/-/g, ""),
                pick(ORACLE_JSON_KEYS),
              ]);
              if (respelled !== key && !(respelled in doc)) {
                const value = doc[key] as Plain;
                delete doc[key];
                doc[respelled] = value;
                renames++;
              }
            } else if (op < 0.46) {
              doc[key] = oracleValue(random, 1);
              note("value_changed");
            } else if (op < 0.58) {
              // Moved whole to a sidecar.
              const where = pick(ORACLE_SIDECARS).path;
              const side = sidecarAfter.get(where) ?? {};
              side[key] = doc[key] as Plain;
              sidecarAfter.set(where, side);
              delete doc[key];
              note("moved_whole");
            } else if (op < 0.68) {
              // A nested leaf moved while this file keeps the top-level key: shadowed.
              const value = doc[key];
              if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const inner = Object.keys(value);
                if (inner.length > 0) {
                  const sub = pick(inner);
                  const where = pick(ORACLE_SIDECARS).path;
                  const side = sidecarAfter.get(where) ?? {};
                  side[key] = { [sub]: value[sub] as Plain };
                  sidecarAfter.set(where, side);
                  delete value[sub];
                  note("nested_move_shadowed");
                }
              }
            } else if (op < 0.74) {
              doc[key] = pick([null, "", "n/a", [], {}]);
              note("emptied");
            }
          }
          if (renames > 1) note("several_renames");
          for (let i = int(0, 2); i > 0; i--) {
            const key = pick(ORACLE_JSON_KEYS);
            if (!(key in doc)) doc[key] = chance(0.3) ? "Go" : oracleValue(random, 1);
          }
          // A value shared by siblings, so a respelled key has a look-alike.
          if (chance(0.15)) {
            const values = Object.values(doc);
            if (values.length > 0) {
              doc[pick(ORACLE_JSON_KEYS)] = pick(values) as Plain;
              note("shared_value");
            }
          }
        } else {
          after = chance(0.5) ? oracleObject(random, 0) : oracleValue(random, 1);
        }
        if (typeWord(before) !== typeWord(after)) note("root_type_changed");
        cases.push({ path, before, after });
      }
      // A nearer sidecar that also sets a moved key, to the same value or another one.
      const farther = sidecarAfter.get("task-x_eeg.json");
      if (farther !== undefined) {
        const near = "sub-01/sub-01_task-x_eeg.json";
        for (const key of Object.keys(farther)) {
          if (!chance(0.7)) continue;
          const side = sidecarAfter.get(near) ?? {};
          side[key] = chance(0.4) ? (farther[key] as Plain) : oracleValue(random, 1);
          sidecarAfter.set(near, side);
          note("nearer_sets_moved_key");
        }
      }
      const sidecars = [...sidecarAfter].map(([path, value]) => ({
        path,
        before: chance(0.5) ? null : ({} as Plain),
        after: chance(0.2) ? ({ ...value, ...oracleObject(random, 1) } as Plain) : (value as Plain),
      }));
      const pool = buildPools(
        sidecars.map((s) =>
          pooled(s.path, s.before === null ? null : textOf(s.before), textOf(s.after)),
        ),
      ).json;
      for (const c of cases) {
        const result = diffJson(c.path, json(textOf(c.before)), json(textOf(c.after)), pool);
        if (!result.ok) {
          violations.push(`case ${n}: refused ${result.refusal}`);
          continue;
        }
        diffs++;
        const atoms = result.value.atoms;
        for (const atom of atoms) seen.add(atom.kind);
        if (atoms.filter((x) => x.kind === "json_key_renamed").length > 1)
          note("several_renames_found");
        if (atoms.some((x) => x.field?.includes("[") ?? false)) note("array_paths");
        if (!verifyJsonCounts(result.value)) violations.push(`case ${n}: counts`);
        for (const v of jsonViolations(c.path, c.before, c.after, atoms, sidecars))
          violations.push(
            `case ${n} ${c.path}: ${v}\n${textOf(c.before)}\n${textOf(c.after)}\n${JSON.stringify(sidecars)}\n${atoms.map(line).join("\n")}`,
          );
        const droppable = atoms
          .map((x, i) => [x, i] as const)
          .filter(([x]) => x.kind !== "json_keys_reordered");
        if (droppable.length > 0) {
          const [, drop] = droppable[Math.floor(random() * droppable.length)] as readonly [
            Atom,
            number,
          ];
          selfTests++;
          if (
            jsonViolations(
              c.path,
              c.before,
              c.after,
              atoms.filter((_, i) => i !== drop),
              sidecars,
            ).length === 0
          )
            violations.push(`case ${n}: dropping ${atoms[drop]?.kind} went unnoticed`);
        }
      }
    }
    expect(violations.slice(0, 3)).toEqual([]);
    expect(diffs).toBeGreaterThan(7000);
    expect(selfTests).toBeGreaterThan(4500);
    for (const [trait, least] of [
      ["shared_pool", 1000],
      ["non_object_root", 300],
      ["root_type_changed", 150],
      ["several_renames", 200],
      ["several_renames_found", 40],
      ["moved_whole", 1000],
      ["nested_move_shadowed", 300],
      ["nearer_sets_moved_key", 200],
      ["shared_value", 500],
      ["emptied", 500],
      ["value_changed", 1000],
      ["array_paths", 300],
    ] as const) {
      expect(traits.get(trait) ?? 0, trait).toBeGreaterThanOrEqual(least);
    }
    for (const kind of [
      "json_value_changed",
      "json_type_changed",
      "json_emptied",
      "json_filled",
      "json_key_renamed",
      "json_key_moved",
      "json_key_removed",
      "json_empty_key_removed",
      "json_key_added",
      "json_keys_reordered",
    ] as ClassKind[]) {
      expect(seen.has(kind), kind).toBe(true);
    }
  }, 60_000);
});
