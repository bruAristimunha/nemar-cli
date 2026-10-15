/**
 * The pre-send boundary of the publication review (ADR 0102, section 2), exercised with the REAL
 * shared rules (`scanTextForLocalPaths`, `scanJsonKeys`) over documents shaped the way git hands
 * them over.
 *
 * What is pinned here is the one property the model's input rests on: text becomes `ClearedText`
 * only when the shared rules found nothing in exactly the string that will be sent; every other
 * document is withheld whole, with a closed state, and no byte of it is anywhere in the result.
 * `test/publication-review-evidence.test.ts` drives the same module through real git repositories
 * and the whole job; this file is the module's own specification.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_COMBINING_RUN,
  MAX_JSON_DEPTH,
  PARTICIPANT_FIELD_CAPS,
  PARTICIPANT_KEY_MAX,
  PARTICIPANT_LABEL,
  PARTICIPANT_MAX_COLUMNS,
  normalizeBounded,
  normalizeText,
  presend,
  scanLocalPathForms,
} from "../scripts/ci/publication-review-presend";
import { scanJsonKeys, scanTextForLocalPaths } from "../shared/identifier-scan";
import {
  DESCRIPTION_KEYS_SHOWN,
  DOCUMENT_CHAR_CAPS,
  DOCUMENT_STATES,
  REVIEW_DOCUMENTS,
  type RawDocument,
  type ReviewDocument,
} from "../shared/publication-review";

const present = (text: string, name = "README.md"): RawDocument => ({
  name,
  state: "present",
  text,
});
const absent = (): RawDocument => ({ name: "", state: "absent", text: null });

const DESCRIPTION = JSON.stringify({
  Name: "Resting EEG of healthy volunteers, eyes open and closed",
  BIDSVersion: "1.9.0",
  License: "CC0",
  Authors: ["Ada Lovelace", "Alan Turing"],
  EthicsApprovals: ["IRB 2024-0001, University X"],
  Version: "1.0.0",
});

/** Five clean documents; each test overrides what it is about. */
function docs(over: Partial<Record<ReviewDocument, RawDocument>> = {}) {
  return {
    readme: present("# Resting EEG\n\nTwo conditions, thirty volunteers.\n"),
    dataset_description: present(DESCRIPTION, "dataset_description.json"),
    changes: present("1.0.0 2026-01-01\n - Initial release\n", "CHANGES"),
    license: present("Creative Commons Zero\n", "LICENSE"),
    participants_json: present(
      JSON.stringify({ participant_id: { Description: "Unique label" }, age: { Units: "years" } }),
      "participants.json",
    ),
    ...over,
  } as Record<ReviewDocument, RawDocument>;
}

const REAL_PATH = "/Users/jsmith/projects/eeg";

describe("a clean set of documents is sent, exactly as it will be fenced", () => {
  test("every document is sent and its cleared text is the string the model will read", () => {
    const input = docs();
    const r = presend(input);
    expect(Object.values(r.states)).toEqual(REVIEW_DOCUMENTS.map(() => "sent"));
    expect(r.withheld_findings).toEqual({});
    // Prose is sent as written; the two JSON documents as their re-serialized shown content.
    expect(r.cleared.readme as string).toBe(input.readme.text as string);
    expect(r.cleared.changes as string).toBe(input.changes.text as string);
    expect(r.cleared.license as string).toBe(input.license.text as string);
    // participants.json is sent as a count and its column descriptions, without the column names.
    expect(r.cleared.participants_json as string).toBe(
      JSON.stringify(
        { column_count: 2, columns: [{ Description: "Unique label" }, { Units: "years" }] },
        null,
        2,
      ),
    );
    expect(r.cleared.dataset_description as string).toBe(
      JSON.stringify(
        {
          Name: "Resting EEG of healthy volunteers, eyes open and closed",
          BIDSVersion: "1.9.0",
          License: "CC0",
          Authors: ["Ada Lovelace", "Alan Turing"],
          EthicsApprovals: ["IRB 2024-0001, University X"],
        },
        null,
        2,
      ),
    );
  });

  test("the result is the same on a second call and the input is untouched", () => {
    const input = docs();
    const frozen = JSON.stringify(input);
    expect(presend(input)).toEqual(presend(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  test("a withheld document does not withhold the others", () => {
    const r = presend(docs({ changes: present(`history: ${REAL_PATH}`, "CHANGES") }));
    expect(r.states.changes).toBe("withheld_finding");
    expect(r.states.readme).toBe("sent");
    expect(r.states.license).toBe("sent");
    expect(r.states.dataset_description).toBe("sent");
    expect(Object.keys(r.cleared).sort()).toEqual(
      ["readme", "license", "dataset_description", "participants_json"].sort(),
    );
  });
});

describe("a document with no text to examine is a closed state and is never sent", () => {
  test.each([
    ["absent", "absent"],
    ["annexed", "withheld_annexed"],
    ["unreadable", "withheld_unreadable"],
    ["not_utf8", "withheld_not_utf8"],
  ] as const)("%s is %s", (state, word) => {
    const raw: RawDocument = { name: "README.md", state, text: null };
    const r = presend(docs({ readme: raw }));
    expect(r.states.readme).toBe(word);
    expect(r.cleared.readme).toBeUndefined();
  });

  test("a document marked present with no text is unreadable, not empty", () => {
    const r = presend(docs({ readme: { name: "README.md", state: "present", text: null } }));
    expect(r.states.readme).toBe("withheld_unreadable");
    expect(r.cleared.readme).toBeUndefined();
  });

  test("text on a document that says it was not read is ignored, never sent", () => {
    // The state is the reader's word for what it could not do; a stray text must not override it.
    const r = presend(
      docs({ readme: { name: "README.md", state: "annexed", text: `leaked ${REAL_PATH}` } }),
    );
    expect(r.states.readme).toBe("withheld_annexed");
    expect(JSON.stringify(r)).not.toContain("leaked");
  });
});

describe("prose: the local-user-path rule, over exactly the string that is sent", () => {
  test("a local user path withholds the whole document and only the kind is counted", () => {
    const r = presend(docs({ readme: present(`# Study\nScripts in ${REAL_PATH}\n`) }));
    expect(r.states.readme).toBe("withheld_finding");
    expect(r.cleared.readme).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
    // No byte of the document is in the result: not the path, not the name, not the heading.
    const serialized = JSON.stringify(r);
    for (const leak of ["jsmith", "Scripts in", "# Study"]) expect(serialized).not.toContain(leak);
  });

  test("a generic account does not hide a real one after it (#1737)", () => {
    const text = "Run from /home/user/code, then /Users/alice/data.\n";
    const r = presend(docs({ readme: present(text) }));
    expect(r.states.readme).toBe("withheld_finding");
    expect(r.cleared.readme).toBeUndefined();
  });

  test("a generic account alone is not a finding", () => {
    const text = "Run from /home/user/code or /Users/username/code.\n";
    const r = presend(docs({ readme: present(text) }));
    expect(r.states.readme).toBe("sent");
    expect(r.cleared.readme as string).toBe(text);
  });

  test("a Windows profile path is a finding", () => {
    const r = presend(docs({ license: present("see C:\\Users\\bob\\Desktop\\x", "LICENSE") }));
    expect(r.states.license).toBe("withheld_finding");
  });

  test("findings are counted by kind across documents, never by value", () => {
    const r = presend(
      docs({
        readme: present(`a ${REAL_PATH}`),
        changes: present(`b ${REAL_PATH}`, "CHANGES"),
        license: present("c /home/carol/x", "LICENSE"),
      }),
    );
    expect(r.withheld_findings).toEqual({ "local-user-path": 3 });
  });

  test("the string examined is the string sent: a finding in the part a cut removes does not count", () => {
    const cap = DOCUMENT_CHAR_CAPS.readme;
    const tail = ` ${REAL_PATH}`;
    const r = presend(docs({ readme: present("a".repeat(cap) + tail) }));
    expect(r.states.readme).toBe("sent_cut");
    expect(r.cleared.readme as string).not.toContain("jsmith");
    expect(r.withheld_findings).toEqual({});
  });

  test("a finding inside the part that is sent withholds a cut document too", () => {
    const cap = DOCUMENT_CHAR_CAPS.readme;
    const r = presend(docs({ readme: present(`${REAL_PATH} ${"a".repeat(cap)}`) }));
    expect(r.states.readme).toBe("withheld_finding");
    expect(r.cleared.readme).toBeUndefined();
  });

  test("a path that a cut would split in half is still seen when its start is sent", () => {
    // "/Users/al" survives the cut; the rule matches "al" as the account, a non-generic name.
    const cap = DOCUMENT_CHAR_CAPS.changes;
    const text = `${"b".repeat(cap - 10)} /Users/alice/x`;
    const r = presend(docs({ changes: present(text, "CHANGES") }));
    expect(r.states.changes).toBe("withheld_finding");
  });
});

describe("the cut: a longer document is cut and the cut is a fact", () => {
  for (const document of ["readme", "changes", "license"] as const) {
    test(`${document}: exactly its cap is sent whole, one more character is cut`, () => {
      const cap = DOCUMENT_CHAR_CAPS[document];
      const whole = presend(docs({ [document]: present("x".repeat(cap)) }));
      expect(whole.states[document]).toBe("sent");
      expect((whole.cleared[document] as string).length).toBe(cap);

      const cut = presend(docs({ [document]: present("x".repeat(cap + 1)) }));
      expect(cut.states[document]).toBe("sent_cut");
      const sent = cut.cleared[document] as string;
      expect(sent.startsWith("x".repeat(cap))).toBe(true);
      expect(sent.endsWith("[cut]")).toBe(true);
      expect(sent.length).toBe(cap + "\n[cut]".length);
    });
  }

  test("a JSON document is cut after it is re-serialized, and says so", () => {
    const big = { Acknowledgements: "d".repeat(DOCUMENT_CHAR_CAPS.dataset_description) };
    const r = presend(
      docs({ dataset_description: present(JSON.stringify(big), "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("sent_cut");
    expect((r.cleared.dataset_description as string).endsWith("[cut]")).toBe(true);
  });

  test("participants.json is cut after it is reduced, when its columns alone are longer than the cap", () => {
    const columns = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`column_${i}`, { Description: "d".repeat(400) }]),
    );
    const r = presend(
      docs({ participants_json: present(JSON.stringify(columns), "participants.json") }),
    );
    expect(r.states.participants_json).toBe("sent_cut");
    const sent = r.cleared.participants_json as string;
    expect(sent.endsWith("\n[cut]")).toBe(true);
    expect(sent.length).toBe(DOCUMENT_CHAR_CAPS.participants_json + "\n[cut]".length);
  });
});

describe("control characters are removed from what is sent, before the rules look", () => {
  test("bells, escapes and bidirectional overrides become spaces; newlines and tabs stay", () => {
    const text = "ok\u0007 bell\u001b[31m red \u202eevil\u200b zero\n\tindented\n";
    const r = presend(docs({ readme: present(text) }));
    expect(r.states.readme).toBe("sent");
    const sent = r.cleared.readme as string;
    const stray = [...sent].filter((c) => /[\p{Cc}\p{Cf}]/u.test(c) && c !== "\n" && c !== "\t");
    expect(stray).toEqual([]);
    expect(sent).toContain("\n\tindented\n");
  });

  test("an invisible character cannot hide a path from the rule or join one for it", () => {
    // Removal would turn this into /Users/alice; replacement by a space keeps what was written, so
    // the rule examines the text the model will read.
    const split = presend(docs({ readme: present("/Us\u200bers/alice/x") }));
    expect(split.states.readme).toBe("sent");
    expect(split.cleared.readme as string).toBe("/Us ers/alice/x");
    const inside = presend(docs({ readme: present("/Users/ali\u200bce/x") }));
    expect(inside.states.readme).toBe("withheld_finding");
  });
});

describe("variation selectors are removed before the rules look (#1728)", () => {
  // Variation selectors are marks that render as nothing. They survive the control-character
  // cleaning, so text can be hidden from a person reading the README while the model reads it, and
  // a path split by one is invisible to the rule. They are removed, and the rule runs on what is left.
  const SELECTORS = [
    ["U+FE00", "\uFE00"],
    ["U+FE0F", "\uFE0F"],
    ["U+E0100", "\u{E0100}"],
    ["U+E01EF", "\u{E01EF}"],
    ["U+180B", "\u180B"],
    ["U+180C", "\u180C"],
    ["U+180D", "\u180D"],
    ["U+180F", "\u180F"],
  ] as const;

  test.each(SELECTORS)("%s is removed from every prose document", (_name, selector) => {
    for (const document of ["readme", "changes", "license"] as const) {
      const r = presend(docs({ [document]: present(`Hi${selector}there${selector}`) }));
      expect(r.states[document]).toBe("sent");
      expect(r.cleared[document] as string).toBe("Hithere");
    }
  });

  test.each(SELECTORS)(
    "a path split by %s is found, because the rule sees what is left",
    (_name, selector) => {
      const r = presend(docs({ readme: present(`see /${selector}Users/jsmith/x and more`) }));
      expect(r.states.readme).toBe("withheld_finding");
      expect(r.cleared.readme).toBeUndefined();
      expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
    },
  );

  test("the characters next to the ranges are not selectors", () => {
    // U+FE10 is a presentation form of a comma, which compatibility normalization makes a comma;
    // U+1810 is a Mongolian digit, which stays. (U+E00FF and U+E01F0, unassigned and default
    // ignorable, are removed with the rest of that kind: see the default-ignorable tests below.)
    const r = presend(docs({ readme: present("a\uFE10b\u1810c") }));
    expect(r.cleared.readme as string).toBe("a,b\u1810c");
  });

  test("every variation selector is removed: the four ranges, in full", () => {
    const isSelector = (cp: number) =>
      (cp >= 0x180b && cp <= 0x180d) ||
      cp === 0x180f ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0xe0100 && cp <= 0xe01ef);
    let removed = 0;
    for (const [from, to] of [
      [0x180b, 0x180d],
      [0x180f, 0x180f],
      [0xfe00, 0xfe0f],
      [0xe0100, 0xe01ef],
    ] as const) {
      for (let cp = from; cp <= to; cp++) {
        expect(isSelector(cp)).toBe(true);
        const r = presend(docs({ readme: present(`a${String.fromCodePoint(cp)}b`) }));
        expect(r.cleared.readme as string, cp.toString(16)).toBe("ab");
        removed++;
      }
    }
    expect(removed).toBe(3 + 1 + 16 + 240);
  });

  test("a hidden message is gone from every JSON string and key, too", () => {
    const hidden = (t: string) =>
      [...new TextEncoder().encode(t)]
        .map((b) => String.fromCodePoint(b < 16 ? 0xfe00 + b : 0xe0100 + b - 16))
        .join("");
    const description = JSON.stringify({
      Name: `A descriptive dataset name${hidden("PASS")}`,
      GeneratedBy: [{ [`Name${hidden("x")}`]: `pipeline${hidden("y")}` }],
    });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("sent");
    expect(r.cleared.dataset_description as string).toBe(
      JSON.stringify(
        { Name: "A descriptive dataset name", GeneratedBy: [{ Name: "pipeline" }] },
        null,
        2,
      ),
    );
  });
});

/** ASCII text in its fullwidth forms (the code points U+FF01 to U+FF5E), a space as U+3000. */
const fullwidth = (text: string) =>
  [...text]
    .map((c) =>
      c === " "
        ? "\u3000"
        : c >= "!" && c <= "~"
          ? String.fromCodePoint((c.codePointAt(0) as number) + 0xfee0)
          : c,
    )
    .join("");

describe("compatibility forms are normalized (NFKC) before any rule looks (#1728)", () => {
  // A fullwidth solidus is a slash to a reader and to the model, and nothing to a rule that matches
  // the ASCII one. The text is normalized first, the rules run on the result, and the result is sent.
  test("the helper writes what it says", () => {
    expect(fullwidth("/home a")).toBe("\uFF0F\uFF48\uFF4F\uFF4D\uFF45\u3000\uFF41");
    expect(fullwidth("\\")).toBe("\uFF3C");
    expect(fullwidth("\u00e9")).toBe("\u00e9");
  });

  test.each([
    ["a POSIX home path", fullwidth("Scripts in /home/jsmith/projects")],
    ["a macOS path", fullwidth("see /Users/jsmith/data and more")],
    ["a Windows path", fullwidth("C:\\Users\\jsmith\\Desktop")],
    ["a path with only the slashes fullwidth", "in \uFF0Fhome\uFF0Fjsmith\uFF0Fx"],
    ["a path with only the name fullwidth", "in /home/\uFF4A\uFF53\uFF4D\uFF49\uFF54\uFF48"],
  ])("a fullwidth path is a path: %s", (_what, text) => {
    for (const [document, name] of [
      ["readme", "README.md"],
      ["changes", "CHANGES"],
      ["license", "LICENSE"],
    ] as const) {
      const r = presend(docs({ [document]: present(text, name) }));
      expect(r.states[document], document).toBe("withheld_finding");
      expect(r.cleared[document]).toBeUndefined();
      expect(r.withheld_findings, document).toEqual({ "local-user-path": 1 });
    }
  });

  test("a fullwidth path inside a JSON string, or as a JSON key, is a path", () => {
    const d = presend(
      docs({
        dataset_description: present(
          JSON.stringify({ Funding: [fullwidth("/Users/jsmith/grant.pdf")] }),
          "dataset_description.json",
        ),
      }),
    );
    expect(d.states.dataset_description).toBe("withheld_finding");
    expect(d.withheld_findings).toEqual({ "local-user-path": 1 });
    const p = presend(
      docs({
        participants_json: present(
          JSON.stringify({ age: { Description: fullwidth("Collected by /home/jsmith/forms") } }),
          "participants.json",
        ),
      }),
    );
    expect(p.states.participants_json).toBe("withheld_finding");
    const k = presend(
      docs({
        dataset_description: present(
          JSON.stringify({ GeneratedBy: [{ Name: "x", [fullwidth("/home/jsmith/x")]: "v" }] }),
          "dataset_description.json",
        ),
      }),
    );
    expect(k.states.dataset_description).toBe("withheld_finding");
  });

  test.each([
    ["patient name", "patient name"],
    ["birthdate", "birthdate"],
    ["email", "email"],
  ])("a fullwidth identifier key is an identifier key: %s", (_what, key) => {
    const r = presend(
      docs({
        dataset_description: present(
          JSON.stringify({
            Name: "A descriptive dataset name that is long enough",
            GeneratedBy: [{ Name: "pipeline", [fullwidth(key)]: "Jane Q Doe" }],
          }),
          "dataset_description.json",
        ),
      }),
    );
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
    expect(JSON.stringify(r)).not.toContain("Jane");
  });

  test("a fullwidth column of participants.json is read as what it says", () => {
    const named = presend(
      docs({
        participants_json: present(
          JSON.stringify({
            participant_id: { Description: "label" },
            [fullwidth("birthdate")]: { Units: "x" },
          }),
          "participants.json",
        ),
      }),
    );
    expect(named.states.participants_json).toBe("withheld_finding");
    expect(named.withheld_findings).toEqual({ "json-identifier-key": 1 });
    const keyed = presend(
      docs({
        participants_json: present(
          JSON.stringify({ [fullwidth("sub-01")]: { Description: "x" } }),
          "participants.json",
        ),
      }),
    );
    expect(keyed.states.participants_json).toBe("withheld_finding");
    expect(keyed.withheld_findings).toEqual({ "path-subject-label": 1 });
  });

  test("what is sent is the normalized text, in prose and in JSON keys and values", () => {
    const text =
      "\uFB01le \u2460 \u00B2 \u2122 \u338F \uFF21\uFF22\uFF23 e\u0301 \u00A0| \u212B \u2026";
    const expected = "file 1 2 TM kg ABC \u00E9  | \u00C5 ...";
    const r = presend(docs({ readme: present(text), changes: present(text, "CHANGES") }));
    expect(r.cleared.readme as string).toBe(expected);
    expect(r.cleared.changes as string).toBe(expected);
    const json = presend(
      docs({
        dataset_description: present(
          JSON.stringify({
            Name: text,
            GeneratedBy: [{ [`${fullwidth("Name")}\u2460`]: text }],
          }),
          "dataset_description.json",
        ),
      }),
    );
    expect(JSON.parse(json.cleared.dataset_description as string)).toEqual({
      Name: expected,
      GeneratedBy: [{ Name1: expected }],
    });
  });

  test("normalizing what was sent changes nothing, even where removing a mark composes its neighbours", () => {
    // The combining-grapheme joiner between "a" and an acute accent is removed, and the two then
    // compose: the result must already be what a second look would make of it.
    const first = presend(
      docs({ readme: present("a\u034F\u0301 \uFFA0\u0301 e\u034F\u0323\u0301") }),
    );
    const sent = first.cleared.readme as string;
    expect(sent).toBe("\u00E1 \u0301 \u1EB9\u0301");
    const second = presend(docs({ readme: present(sent) }));
    expect(second.cleared.readme as string).toBe(sent);
  });

  test("the normalization is a fixed point: every code point, alone and between marks, settles in one pass", () => {
    // What the rules scanned is what is sent, and the sent JSON is normalized once more as text, so
    // a second pass must change nothing. Removing a mark can bring its neighbours together to
    // compose, and two code points normalize into the removed set; the order of the steps handles both.
    const contexts = [
      (c: string) => c,
      (c: string) => `a${c}`,
      (c: string) => `a${c}\u0301`,
      (c: string) => `e\u034F${c}\u0323\u0301`,
      (c: string) => `${c}\u0301${c}`,
      (c: string) => `\u1100${c}\u1161`,
    ];
    let checked = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x3200 || (cp >= 0xf900 && cp < 0x10000) ? 1 : 5) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      for (const context of contexts) {
        const once = normalizeText(context(ch));
        if (normalizeText(once) !== once) {
          throw new Error(`not a fixed point at U+${cp.toString(16)}`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100_000);
    // And the cases the order exists for.
    expect(normalizeText("a\u034F\u0301")).toBe("\u00E1");
    expect(normalizeText("\uFFA0")).toBe("");
    expect(normalizeText("\u3164\uFF21")).toBe("A");
  });

  test("a form that expands is cut after it expands, so the cap is of what is sent", () => {
    const cap = DOCUMENT_CHAR_CAPS.readme;
    // U+FDFA is one character that becomes eighteen.
    const r = presend(docs({ readme: present("\uFDFA".repeat(cap / 10)) }));
    expect(r.states.readme).toBe("sent_cut");
    expect((r.cleared.readme as string).length).toBe(cap + "\n[cut]".length);
  });
});

describe("default-ignorable characters are removed, so a path split by one is a path (#1728)", () => {
  // Characters that render as nothing, or as a blank letter, and that the control-character cleaning
  // does not touch (it turns the format characters into spaces; these are not format characters).
  const STRIPPED: [number, number][] = [
    [0x034f, 0x034f], // combining grapheme joiner
    [0x115f, 0x1160], // Hangul choseong and jungseong fillers
    [0x17b4, 0x17b5], // Khmer inherent vowels
    [0x180b, 0x180d], // Mongolian free variation selectors
    [0x180f, 0x180f],
    [0x2065, 0x2065], // unassigned, default ignorable
    [0x3164, 0x3164], // Hangul filler
    [0xfe00, 0xfe0f], // variation selectors
    [0xffa0, 0xffa0], // halfwidth Hangul filler
    [0xfff0, 0xfff8], // unassigned, default ignorable
    [0xe0000, 0xe0000],
    [0xe0002, 0xe001f],
    [0xe0080, 0xe0fff], // the rest of the tag block and the variation selector supplement
  ];
  const isStripped = (cp: number) => STRIPPED.some(([a, b]) => cp >= a && cp <= b);
  const SAMPLES = [
    0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0, 0x2065, 0xfff0, 0xfff8, 0xe0000,
    0xe0002, 0xe001f, 0xe0080, 0xe00ff, 0xe01f0, 0xe0fff, 0xfe0f,
  ];

  test("every code point of the set is removed, and the ones beside it are not", () => {
    let removed = 0;
    const windows: [number, number][] = [
      [0x0340, 0x0355],
      [0x1158, 0x1163],
      [0x17b0, 0x17b8],
      [0x2060, 0x206a],
      [0x3160, 0x3168],
      [0xffa0 - 3, 0xffa0 + 3],
      [0xffe0, 0xfffd],
      [0xe0000, 0xe0004],
      [0xe001c, 0xe0022],
      [0xe007c, 0xe0084],
      [0xe0ffa, 0xe1004],
    ];
    for (const [from, to] of windows) {
      for (let cp = from; cp <= to; cp++) {
        const ch = String.fromCodePoint(cp);
        const sent = presend(docs({ readme: present(`a${ch}b`) })).cleared.readme as string;
        if (isStripped(cp)) {
          expect(sent, cp.toString(16)).toBe("ab");
          removed++;
        } else {
          expect(sent, cp.toString(16)).not.toBe("ab");
        }
      }
    }
    // 1 + 2 + 2 + 1 + 1 + 1 + 9 + 4 + 4 + 5 + 6, counted by hand from the windows above.
    expect(removed).toBe(36);
  });

  test.each(SAMPLES.map((cp) => [`U+${cp.toString(16).toUpperCase()}`, String.fromCodePoint(cp)]))(
    "a path split by %s is found",
    (_name, mark) => {
      for (const text of [
        `/Us${mark}ers/jsmith/x`,
        `/${mark}Users/jsmith/x`,
        `/Users/${mark}jsmith`,
      ]) {
        const r = presend(docs({ readme: present(`see ${text} and more`) }));
        expect(r.states.readme, text).toBe("withheld_finding");
        expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
      }
      const json = presend(
        docs({
          dataset_description: present(
            JSON.stringify({ Acknowledgements: `Data at ${mark}/home/js${mark}mith/x` }),
            "dataset_description.json",
          ),
        }),
      );
      expect(json.states.dataset_description).toBe("withheld_finding");
    },
  );

  test("an identifier key split by one is an identifier key", () => {
    for (const mark of ["\u3164", "\u034F", "\u115F", "\uFFA0"]) {
      const r = presend(
        docs({
          dataset_description: present(
            JSON.stringify({ GeneratedBy: [{ Name: "x", [`patient${mark}name`]: "Jane" }] }),
            "dataset_description.json",
          ),
        }),
      );
      expect(r.states.dataset_description, mark).toBe("withheld_finding");
    }
  });

  test("the zero-width joiner and non-joiner are format characters: they become spaces, as before", () => {
    // Removing them would join what the writer separated in the scripts where they matter, and the
    // cleaning already replaces them with a space; nothing here changes that.
    const r = presend(docs({ readme: present("a\u200Db\u200Cc\u200Bd") }));
    expect(r.cleared.readme as string).toBe("a b c d");
  });

  test("the braille blank is a blank cell: it becomes a space, and no other braille cell changes", () => {
    // It has width, a reader sees a gap, and in braille it is the word space; so it is a space.
    const r = presend(docs({ readme: present("a\u2800b \u2801\u2802") }));
    expect(r.cleared.readme as string).toBe("a b \u2801\u2802");
  });
});

describe("normalization is bounded: no input makes it quadratic (#1728)", () => {
  // NFKC reorders combining marks, which is quadratic in the length of a run of marks of mixed
  // classes: 32,000 marks took a second, 256 KB of them eighteen, and it ran on the whole raw
  // document before any cut. The input of the compatibility step is bounded, and a run of marks no
  // text has is refused.
  const marks = (n: number) => "\u0316\u0301".repeat(n / 2).padEnd(n, "\u0316");
  const run = (n: number) => `a${marks(n)}b`;
  const cap = DOCUMENT_CHAR_CAPS.readme;

  test("the limit is 64 marks in a row, counted after the invisible characters are removed", () => {
    expect(MAX_COMBINING_RUN).toBe(64);
    // A run of exactly 64 is text (it only has to be canonically ordered), one more is not.
    expect(presend(docs({ readme: present(run(64)) })).states.readme).toBe("sent");
    for (const document of ["readme", "changes", "license"] as const) {
      const r = presend(docs({ [document]: present(run(65)) }));
      expect(r.states[document], document).toBe("withheld_unreadable");
      expect(r.cleared[document]).toBeUndefined();
      expect(r.withheld_findings).toEqual({});
    }
    // Invisible characters between the marks do not break the run: they are removed first.
    const hidden = `a${marks(40)}\u3164${marks(40)}b`;
    expect(presend(docs({ readme: present(hidden) })).states.readme).toBe("withheld_unreadable");
    // A visible separator does.
    const apart = `a${marks(40)} ${marks(40)}b`;
    expect(presend(docs({ readme: present(apart) })).states.readme).toBe("sent");
  });

  test("the same limit holds for every string and key of a JSON document", () => {
    const base = { Name: "A descriptive dataset name that is long enough" };
    for (const object of [
      { ...base, Acknowledgements: run(65) },
      { ...base, GeneratedBy: [{ Name: "x", [`k${marks(65)}`]: "v" }] },
    ]) {
      const r = presend(
        docs({
          dataset_description: present(JSON.stringify(object), "dataset_description.json"),
        }),
      );
      expect(r.states.dataset_description).toBe("withheld_unreadable");
    }
    const column = presend(
      docs({
        participants_json: present(
          JSON.stringify({ age: { Description: run(65) } }),
          "participants.json",
        ),
      }),
    );
    expect(column.states.participants_json).toBe("withheld_unreadable");
    const ok = presend(
      docs({
        dataset_description: present(
          JSON.stringify({ ...base, Acknowledgements: run(64) }),
          "dataset_description.json",
        ),
      }),
    );
    expect(ok.states.dataset_description).toBe("sent");
  });

  test("a hostile README of two million marks is refused in well under two seconds", () => {
    const started = performance.now();
    const r = presend(docs({ readme: present(`a${"\u0316\u0301".repeat(1_000_000)}`) }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(r.states.readme).toBe("withheld_unreadable");
  });

  test("two megabytes of the longest legal runs are cut before normalization, and are fast", () => {
    const text = `a${marks(64)}`.repeat(30_000);
    expect(text.length).toBeGreaterThan(1_900_000);
    const started = performance.now();
    const r = presend(docs({ readme: present(text) }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(r.states.readme).toBe("sent_cut");
    expect((r.cleared.readme as string).length).toBe(cap + "\n[cut]".length);
  });

  test("a hostile JSON string is bounded the same way, and a long one is cut and says so", () => {
    const base = { Name: "A descriptive dataset name that is long enough" };
    const started = performance.now();
    const hostile = presend(
      docs({
        dataset_description: present(
          JSON.stringify({ ...base, Acknowledgements: `a${"\u0316\u0301".repeat(1_000_000)}` }),
          "dataset_description.json",
        ),
      }),
    );
    const longLegal = presend(
      docs({
        dataset_description: present(
          JSON.stringify({ ...base, Acknowledgements: `a${marks(64)}`.repeat(30_000) }),
          "dataset_description.json",
        ),
      }),
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(hostile.states.dataset_description).toBe("withheld_unreadable");
    expect(longLegal.states.dataset_description).toBe("sent_cut");
    const capJson = DOCUMENT_CHAR_CAPS.dataset_description;
    expect((longLegal.cleared.dataset_description as string).length).toBe(
      capJson + "\n[cut]".length,
    );
  });

  test("a JSON string longer than the document's cap is cut with the mark, and the state says so", () => {
    const capJson = DOCUMENT_CHAR_CAPS.dataset_description;
    // Two shown strings, each longer than the cap: each is cut where it stands, and the document
    // says it was cut even though its serialization would otherwise be short enough.
    const r = presend(
      docs({
        dataset_description: present(
          JSON.stringify({
            Name: "A descriptive dataset name that is long enough",
            Acknowledgements: "x".repeat(capJson * 5),
          }),
          "dataset_description.json",
        ),
      }),
    );
    expect(r.states.dataset_description).toBe("sent_cut");
    const sent = r.cleared.dataset_description as string;
    expect(
      sent.startsWith('{\n  "Name": "A descriptive dataset name that is long enough",\n'),
    ).toBe(true);
    expect(sent.endsWith("\n[cut]")).toBe(true);
    // The string was cut where it stood (to the cap), not read whole: 5 caps of text never got here.
    expect(sent.length).toBe(capJson + "\n[cut]".length);
  });

  test("a long string that is not sent does not make participants.json look cut", () => {
    const r = presend(
      docs({
        participants_json: present(
          JSON.stringify({
            age: {
              Description: "Age at recording",
              Levels: { a: "y".repeat(DOCUMENT_CHAR_CAPS.participants_json * 6) },
            },
          }),
          "participants.json",
        ),
      }),
    );
    expect(r.states.participants_json).toBe("sent");
  });

  test("normalizeBounded: the compatibility step sees at most four caps, and a drop is a cut", () => {
    expect(normalizeBounded("x".repeat(100), 30)).toEqual({
      text: `${"x".repeat(30)}\n[cut]`,
      cut: true,
    });
    expect(normalizeBounded("x".repeat(30), 30)).toEqual({ text: "x".repeat(30), cut: false });
    // The mark run is checked on the WHOLE input, even the part the bound would drop.
    expect(() => normalizeBounded(`${"x".repeat(1000)}a${marks(65)}`, 30)).toThrow();
    // The bound: only the first four caps reach the compatibility step. Text past them cannot
    // change the result, so a fullwidth letter there is never normalized (it is never sent).
    const past = normalizeBounded(`${"x".repeat(120)}\uFF21`, 30);
    expect(past).toEqual({ text: `${"x".repeat(30)}\n[cut]`, cut: true });
  });

  test("normalizeBounded: text the bound drops is a cut even when what is left is shorter than the cap", () => {
    // Composition shrinks text, so a prefix bounded at one cap can normalize to less than the cap.
    // With the real factor of four that cannot happen; the factor is a parameter so it is tested.
    const dropped = normalizeBounded("e\u0301".repeat(40), 30, 1);
    expect(dropped.cut).toBe(true);
    expect(dropped.text).toBe(`${"\u00E9".repeat(15)}\n[cut]`);
    // And the bound never ends in half of a surrogate pair.
    const pair = normalizeBounded(`${"x".repeat(9)}\u{1F600}${"y".repeat(5)}`, 10, 1);
    expect(pair).toEqual({ text: `${"x".repeat(9)}\n[cut]`, cut: true });
  });

  test.each([
    [
      "Vietnamese, precomposed and with several marks",
      "Vi\u1EC7t Nam, \u1EA1\u0309 \u1EA5 \u1EAD \u1EB1 \u1EF3 \u1EF9",
    ],
    [
      "Arabic with harakat and shadda",
      "\u0627\u0644\u0633\u064E\u0651\u0644\u064E\u0627\u0645\u064F \u0639\u064E\u0644\u064E\u064A\u0652\u0643\u064F\u0645\u0652",
    ],
    ["Tibetan stacks", "\u0F66\u0FA1\u0FB2\u0F74\u0F42 \u0F45\u0FB1\u0F72\u0F7C"],
    [
      "Hebrew with points and cantillation",
      "\u05D1\u05B0\u05BC\u05E8\u05B5\u05D0\u05E9\u05B4\u05C1\u05D9\u05EA \u05D1\u05B8\u05BC\u05E8\u05B8\u05D0",
    ],
    [
      "Devanagari with signs",
      "\u0915\u094D\u0937\u093F \u0928\u093F\u0903 \u0938\u0902\u0938\u094D\u0915\u0943\u0924\u092E\u094D",
    ],
    ["Thai with tone marks", "\u0E19\u0E49\u0E32 \u0E01\u0E34\u0E19 \u0E0A\u0E48\u0E27\u0E22"],
  ])(
    "legitimate text with several combining marks per letter is not touched: %s",
    (_what, text) => {
      // Already in the form normalization leaves it, so the sent text is the text.
      expect(text.normalize("NFKC")).toBe(text);
      const r = presend(docs({ readme: present(text) }));
      expect(r.states.readme).toBe("sent");
      expect(r.cleared.readme as string).toBe(text);
      const json = presend(
        docs({
          dataset_description: present(JSON.stringify({ Name: text }), "dataset_description.json"),
        }),
      );
      expect(JSON.parse(json.cleared.dataset_description as string).Name).toBe(text);
    },
  );

  test("text that is not yet in canonical order is reordered, as before, and is still fast", () => {
    const r = presend(docs({ readme: present("a\u0301\u0316 a\u0316\u0301") }));
    // Reordered (the lower class first), after which the accent composes with its base.
    expect(r.cleared.readme as string).toBe("\u00E1\u0316 \u00E1\u0316");
  });
});

describe("the cut is on a character boundary and no half of one is sent (#1728)", () => {
  const cap = DOCUMENT_CHAR_CAPS.readme;
  const wellFormed = (text: string) =>
    // A lone surrogate is a half of a character: neither paired with its other half nor a whole one.
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

  test("a document cut in the middle of an emoji ends before the whole emoji, not in half of it", () => {
    const r = presend(docs({ readme: present(`${"a".repeat(cap - 1)}\u{1F600} and the rest`) }));
    expect(r.states.readme).toBe("sent_cut");
    const sent = r.cleared.readme as string;
    expect(wellFormed(sent)).toBe(true);
    expect(sent).toBe(`${"a".repeat(cap - 1)}\n[cut]`);
  });

  test("an emoji that fits whole at the cap is kept", () => {
    const r = presend(docs({ readme: present(`${"a".repeat(cap - 2)}\u{1F600} and the rest`) }));
    expect(r.states.readme).toBe("sent_cut");
    expect(r.cleared.readme as string).toBe(`${"a".repeat(cap - 2)}\u{1F600}\n[cut]`);
  });

  test("a lone surrogate anywhere in prose is removed", () => {
    const prose = presend(docs({ readme: present("ab\uD83Dcd\uDE00ef") }));
    expect(prose.cleared.readme as string).toBe("abcdef");
  });

  test("a JSON document cut in the middle of an emoji is cut before it", () => {
    const at = (value: string) =>
      JSON.stringify({ Acknowledgements: value }, null, 2).indexOf(value);
    const capJson = DOCUMENT_CHAR_CAPS.dataset_description;
    // Pad so that the high half of the emoji is the last character the cap allows.
    const pad = "a".repeat(capJson - 1 - at("\u{1F600}"));
    const description = JSON.stringify({ Acknowledgements: `${pad}\u{1F600} and the rest` });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("sent_cut");
    const sent = r.cleared.dataset_description as string;
    expect(sent.length).toBe(capJson - 1 + "\n[cut]".length);
    expect(wellFormed(sent)).toBe(true);
  });
});

describe("dataset_description.json: the shown keys, re-serialized", () => {
  test("only the BIDS keys the questions turn on are sent, and the others are counted", () => {
    const r = presend(docs());
    expect(r.description_keys_shown).toBe(5);
    expect(r.description_keys_not_shown).toBe(1);
    const sent = JSON.parse(r.cleared.dataset_description as string);
    expect(Object.keys(sent).sort()).toEqual(
      ["Name", "BIDSVersion", "License", "Authors", "EthicsApprovals"].sort(),
    );
  });

  test("every shown key is sent when present, and in the declared order", () => {
    const all = Object.fromEntries(DESCRIPTION_KEYS_SHOWN.map((k) => [k, `value of ${k}`]));
    const reversed = Object.fromEntries(Object.entries(all).reverse());
    const r = presend(
      docs({ dataset_description: present(JSON.stringify(reversed), "dataset_description.json") }),
    );
    expect(r.description_keys_shown).toBe(DESCRIPTION_KEYS_SHOWN.length);
    expect(r.description_keys_not_shown).toBe(0);
    expect(Object.keys(JSON.parse(r.cleared.dataset_description as string))).toEqual([
      ...DESCRIPTION_KEYS_SHOWN,
    ]);
  });

  test("an identifier key INSIDE a shown key withholds the document", () => {
    const description = JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      GeneratedBy: [{ Name: "pipeline", email: "a.person@example.org" }],
    });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.cleared.dataset_description).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
    expect(r.description_keys_shown).toBe(0);
    expect(JSON.stringify(r)).not.toContain("a.person");
  });

  test("an identifier-named key OUTSIDE the shown set is not sent, so it withholds nothing", () => {
    const description = JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      Version: "1.0.0",
      PatientName: "Someone",
      Extra: { email: "x@example.org" },
    });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("sent");
    expect(r.description_keys_shown).toBe(1);
    expect(r.description_keys_not_shown).toBe(3);
    const sent = r.cleared.dataset_description as string;
    for (const leak of ["PatientName", "Someone", "x@example.org", "Version"]) {
      expect(sent).not.toContain(leak);
    }
  });

  test("a local user path inside a shown string value withholds it (the key rule alone would not)", () => {
    const description = JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      Funding: [`Grant letter at ${REAL_PATH}/letter.pdf`],
    });
    const input = docs({ dataset_description: present(description, "dataset_description.json") });
    expect(scanJsonKeys(JSON.parse(description))).toEqual([]);
    const r = presend(input);
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
  });

  test("a local user path in a key that is not shown does not matter", () => {
    const description = JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      Notes: REAL_PATH,
    });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("sent");
    expect(r.cleared.dataset_description as string).not.toContain("jsmith");
  });

  test("JSON that does not parse, or is not an object, is withheld as not JSON", () => {
    for (const text of ["{ not json", "[1, 2]", "42", "null", '"a string"', ""]) {
      const r = presend(docs({ dataset_description: present(text, "dataset_description.json") }));
      expect(r.states.dataset_description, text).toBe("withheld_not_json");
      expect(r.cleared.dataset_description).toBeUndefined();
      expect(r.description_keys_shown).toBe(0);
      expect(r.description_keys_not_shown).toBe(0);
    }
  });

  test("the counts are of what was sent: a withheld description counts nothing", () => {
    const description = JSON.stringify({ Name: "n", Version: "1.0.0", Funding: [REAL_PATH] });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.description_keys_shown).toBe(0);
    expect(r.description_keys_not_shown).toBe(0);
  });
});

describe("a JSON document is normalized first; every rule runs on what is sent (#1728)", () => {
  // The model receives the cleaned text. A key the key rule saw as "patient\u200bname" is read by the
  // model as "patient name", so the rules must look at the cleaned key, not the one that was parsed.
  const withKey = (key: string) =>
    JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      GeneratedBy: [{ Name: "pipeline", [key]: "Jane Q Doe" }],
    });
  const sendDescription = (text: string) =>
    presend(docs({ dataset_description: present(text, "dataset_description.json") }));

  test("the plain identifier key is withheld (the control)", () => {
    const r = sendDescription(withKey("patientname"));
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
  });

  test.each([
    ["a zero-width space", "patient\u200bname"],
    ["a soft hyphen", "patient\u00adname"],
    ["a bidirectional override", "patient\u202ename"],
    ["a bell", "patient\u0007name"],
    ["a word joiner", "pa\u2060tient\u2060name"],
    ["a variation selector", "patient\uFE0Fname"],
    ["a tag character", "patient\u{E0001}name"],
  ])("an identifier key spelled with %s is still an identifier key", (_what, key) => {
    const r = sendDescription(withKey(key));
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.cleared.dataset_description).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
    expect(JSON.stringify(r)).not.toContain("Jane");
  });

  test("the keys and values that are sent are the cleaned ones", () => {
    const description = JSON.stringify({
      Name: "A descriptive\u200b dataset\u0007 name",
      GeneratedBy: [{ "Name\u200b": "pipe\u00adline", Version: "1\u200b.0" }],
    });
    const r = sendDescription(description);
    expect(r.states.dataset_description).toBe("sent");
    expect(JSON.parse(r.cleared.dataset_description as string)).toEqual({
      Name: "A descriptive  dataset  name",
      GeneratedBy: [{ "Name ": "pipe line", Version: "1 .0" }],
    });
  });

  test("a lone surrogate written as a JSON escape is removed from keys and values", () => {
    const text =
      '{"Name":"A descriptive dataset name \\ud83d here","GeneratedBy":[{"a\\ude00b":"c"}]}';
    const r = sendDescription(text);
    expect(r.states.dataset_description).toBe("sent");
    expect(JSON.parse(r.cleared.dataset_description as string)).toEqual({
      Name: "A descriptive dataset name  here",
      GeneratedBy: [{ ab: "c" }],
    });
    expect(r.cleared.dataset_description as string).not.toMatch(/\\ud[89a-f]/i);
  });

  test("a key named __proto__ is data, not a prototype, and survives to be examined", () => {
    const text =
      '{"Name":"A descriptive dataset name that is long enough","GeneratedBy":[{"__proto__":{"email":"a@example.org"}}]}';
    const r = sendDescription(text);
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
  });

  test("participants.json is normalized the same way", () => {
    const text = JSON.stringify({
      participant_id: { Description: "label" },
      "patient\u200bname": { Description: "x" },
    });
    const r = presend(docs({ participants_json: present(text, "participants.json") }));
    expect(r.states.participants_json).toBe("withheld_finding");
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
  });
});

describe("a path in a JSON string is found as the person who reads the string would read it (#1728)", () => {
  // The path rule runs over the sent text, where a newline or a tab inside a JSON string is the two
  // characters backslash and n (or t), and the rule skips a path that follows a letter. Every string
  // and every key is also examined on its own, as the parsed string the model reads.
  const description = (extra: Record<string, unknown>) =>
    JSON.stringify({ Name: "A descriptive dataset name that is long enough", ...extra });
  const sendDescription = (extra: Record<string, unknown>) =>
    presend(docs({ dataset_description: present(description(extra), "dataset_description.json") }));

  const IN_A_VALUE: [string, Record<string, unknown>][] = [
    ["after a newline", { HowToAcknowledge: "Data in:\n/home/jsmith/raw" }],
    ["after a tab", { Funding: ["\t/Users/jsmith/grant.pdf"] }],
    ["at the start of a value", { Acknowledgements: "/Users/jsmith/data" }],
    ["after a carriage return", { Acknowledgements: "a\r/home/jsmith/x" }],
    ["after a line separator", { Acknowledgements: "a\u2028/home/jsmith/x" }],
    ["as a Windows profile path", { Acknowledgements: "C:\\Users\\jsmith\\data" }],
    [
      "in a nested array",
      { GeneratedBy: [{ Name: "x", Description: ["a", "b\n/home/jsmith/c"] }] },
    ],
    ["as a file URL", { GeneratedBy: [{ Name: "x", CodeURL: "file:///home/jsmith/pipeline" }] }],
    [
      "as a file URL in capitals",
      { GeneratedBy: [{ Name: "x", CodeURL: "FILE:///home/jsmith/p" }] },
    ],
    [
      "as a file URL with one slash",
      { GeneratedBy: [{ Name: "x", CodeURL: "file:/home/jsmith/p" }] },
    ],
    [
      "as a file URL with a drive",
      { GeneratedBy: [{ Name: "x", CodeURL: "file:C:/Users/jsmith/p" }] },
    ],
    [
      "as a drive path with slashes",
      { GeneratedBy: [{ Name: "x", CodeURL: "C:/Users/jsmith/pipeline" }] },
    ],
    ["as any drive path", { Acknowledgements: "D:\\lab\\raw" }],
    ["as a lower-case drive path", { Acknowledgements: "c:/data" }],
    ["after whitespace, a drive path", { Acknowledgements: "Raw data are on C:\\data" }],
    ["after whitespace, a file URL", { Acknowledgements: "Code at file:///srv/code" }],
    ["after a quote, a drive path", { Acknowledgements: 'see "C:\\data"' }],
    ["as a UNC path", { Acknowledgements: "\\\\fileserver\\share\\sub" }],
    ["after whitespace, a UNC path", { Acknowledgements: "Data on \\\\fileserver\\share" }],
    ["after a newline, a UNC path", { Acknowledgements: "Data on:\n\\\\fileserver\\share" }],
  ];

  test.each(IN_A_VALUE)("in dataset_description.json, %s", (_where, extra) => {
    const r = sendDescription(extra);
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.cleared.dataset_description).toBeUndefined();
    // One finding for the document, of the path kind, and no value in the result.
    expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
    expect(JSON.stringify(r)).not.toMatch(/jsmith|fileserver|lab.raw|srv|pipeline/);
  });

  test("a key that is a path is found too", () => {
    for (const key of [
      "/home/jsmith/x",
      "file:///home/jsmith/x",
      "C:/Users/jsmith",
      "\\\\srv\\share",
    ]) {
      const r = sendDescription({ GeneratedBy: [{ Name: "x", [key]: "v" }] });
      expect(r.states.dataset_description, key).toBe("withheld_finding");
      expect(r.withheld_findings, key).toEqual({ "local-user-path": 1 });
    }
  });

  test.each([
    ["after a newline", { age: { Description: "Collected by\n/home/jsmith/forms" } }],
    ["after a tab", { age: { Units: "\t/Users/jsmith/units" } }],
    ["as a file URL", { age: { LongName: "file:///home/jsmith/age" } }],
    ["as a drive path", { age: { Description: "C:/Users/jsmith/age.txt" } }],
  ])("in participants.json, %s", (_where, object) => {
    const r = presend(
      docs({ participants_json: present(JSON.stringify(object), "participants.json") }),
    );
    expect(r.states.participants_json).toBe("withheld_finding");
    expect(r.cleared.participants_json).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
  });

  test.each([
    ["a generic account", { Acknowledgements: "Run from\n/home/user/code or /Users/username/x" }],
    ["a web address", { ReferencesAndLinks: ["https://example.org/a/b", "http://example.org/c"] }],
    ["a doi", { DatasetDOI: "doi:10.18112/openneuro.ds000001.v1.0.0" }],
    ["the word file", { Acknowledgements: "Open the file: README.md, or the profile: none" }],
    ["a ratio and a time", { Acknowledgements: "Ratio 3:1 at 10:30, section A: results" }],
    ["a slash after a word", { Acknowledgements: "and/or either/or" }],
    ["a single backslash", { Acknowledgements: "a\\b c\\d" }],
    ["a path in a key that is not shown", { Notes: "/Users/jsmith/x" }],
  ])("a clean value is not withheld: %s", (_what, extra) => {
    const r = sendDescription(extra);
    expect(r.states.dataset_description).toBe("sent");
    expect(r.withheld_findings).toEqual({});
  });

  test("the forms are a rule of their own: what scanLocalPathForms reads, by itself", () => {
    for (const text of [
      "file:///x",
      "FILE:/x",
      "x file:\\x",
      "C:\\x",
      "z:/x",
      "q \\\\h\\s",
      "\\\\h",
    ]) {
      expect(scanLocalPathForms(text), text).toHaveLength(1);
      expect(scanLocalPathForms(text)[0]?.kind).toBe("local-user-path");
    }
    for (const text of [
      "",
      "file: x",
      "profile:/x",
      "https://a/b",
      "a:b",
      "3:/4",
      "x\\y",
      "dir/file",
    ]) {
      expect(scanLocalPathForms(text), text).toEqual([]);
    }
  });
});

describe("participants.json: the column descriptions only, and never a column's name (#1728)", () => {
  // ADR 0102, section 3: "participants.json, the column descriptions". A column description is
  // LongName, Description and Units. Everything else a participants.json can hold (the levels of a
  // categorical column, links, per-participant values someone typed in) is not sent, and neither is
  // the key of a column: a file keyed by participant (`sub01`, `S01`, `Jane Doe`) would send every
  // label. What is sent is a count and the descriptions in file order, with no key.
  const sendParticipants = (object: unknown) =>
    presend(docs({ participants_json: present(JSON.stringify(object), "participants.json") }));
  const sentOf = (object: unknown) =>
    JSON.parse(sendParticipants(object).cleared.participants_json as string);

  test("an identifier-named column key with content withholds it", () => {
    const text = JSON.stringify({
      participant_id: { Description: "label" },
      patientname: { Description: "name of the patient" },
    });
    const r = presend(docs({ participants_json: present(text, "participants.json") }));
    expect(r.states.participants_json).toBe("withheld_finding");
    expect(r.cleared.participants_json).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
  });

  test.each([
    ["an empty object", {}],
    ["an empty description", { Description: "" }],
    ["levels only", { Levels: { a: "b" } }],
    ["a description", { Description: "Full name of the participant" }],
  ])("an identifier-named column is withheld whatever it holds: %s", (_what, value) => {
    for (const key of ["name", "email", "birthdate", "patientname", "Phone"]) {
      const r = sendParticipants({ participant_id: { Description: "label" }, [key]: value });
      expect(r.states.participants_json, key).toBe("withheld_finding");
      // One finding for the one column, of the JSON key kind or the table-column kind.
      expect(
        Object.values(r.withheld_findings).reduce((a, b) => a + (b ?? 0), 0),
        key,
      ).toBe(1);
    }
  });

  test("a key inside a column is still read by the key rule", () => {
    const r = sendParticipants({
      participant_id: { Description: "label", Levels: { email: "a@example.org" } },
    });
    expect(r.states.participants_json).toBe("withheld_finding");
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
    const cut = sendParticipants({
      participant_id: { Description: "f".repeat(DOCUMENT_CHAR_CAPS.participants_json) },
      birthdate: { Description: "d" },
    });
    expect(cut.states.participants_json).toBe("withheld_finding");
  });

  test("a count and the descriptions in file order are sent: LongName, Description, Units, no key", () => {
    const r = sendParticipants({
      participant_id: {
        Units: "n/a",
        TermURL: "https://example.org/term/SENTINEL_TERM",
        Levels: { "sub-01": "SENTINEL_LEVEL" },
        Description: "Unique label",
        LongName: "Participant",
        SENTINEL_KEY: "SENTINEL_VALUE",
      },
      sex: { Levels: { M: "male", F: "female" } },
      age: { Description: "Age at recording", Units: "years", Minimum: 18, Maximum: 89 },
    });
    expect(r.states.participants_json).toBe("sent");
    const sent = r.cleared.participants_json as string;
    expect(sent).toBe(
      JSON.stringify(
        {
          column_count: 3,
          columns: [
            { LongName: "Participant", Description: "Unique label", Units: "n/a" },
            {},
            { Description: "Age at recording", Units: "years" },
          ],
        },
        null,
        2,
      ),
    );
    // No column key, and nothing else of the file.
    for (const leak of [
      "participant_id",
      '"sex"',
      '"age"',
      "SENTINEL",
      "sub-01",
      "male",
      "TermURL",
    ]) {
      expect(sent).not.toContain(leak);
    }
  });

  test("the keys are never sent, whatever they look like", () => {
    const keys = [
      "Jane Doe",
      "visual_acuity",
      "handedness",
      "x".repeat(60),
      "p300_amplitude",
      "colonne é",
    ];
    const sent = sendParticipants(
      Object.fromEntries(keys.map((k, i) => [k, { Description: `column ${i}` }])),
    ).cleared.participants_json as string;
    for (const key of keys) expect(sent).not.toContain(key);
    expect(JSON.parse(sent).columns).toHaveLength(keys.length);
  });

  test("a column named for a person is not a name in the sent text, only its description is", () => {
    const sent = sentOf({ "Jane Doe": { Description: "age 34, right-handed" } });
    expect(sent).toEqual({ column_count: 1, columns: [{ Description: "age 34, right-handed" }] });
  });

  test("a field that is not a string is not sent", () => {
    expect(
      sentOf({
        a: { LongName: 5, Description: ["x", "y"], Units: { u: "years" } },
        b: { LongName: null, Description: true, Units: "years" },
      }),
    ).toEqual({ column_count: 2, columns: [{}, { Units: "years" }] });
  });

  test("each field is cut to its own short cap, and a cut is a fact", () => {
    const r = sendParticipants({
      col: {
        LongName: "L".repeat(PARTICIPANT_FIELD_CAPS.LongName + 1),
        Description: "D".repeat(PARTICIPANT_FIELD_CAPS.Description + 1),
        Units: "U".repeat(PARTICIPANT_FIELD_CAPS.Units + 1),
      },
      whole: {
        LongName: "L".repeat(PARTICIPANT_FIELD_CAPS.LongName),
        Description: "D".repeat(PARTICIPANT_FIELD_CAPS.Description),
        Units: "U".repeat(PARTICIPANT_FIELD_CAPS.Units),
      },
    });
    expect(r.states.participants_json).toBe("sent_cut");
    const sent = JSON.parse(r.cleared.participants_json as string);
    for (const field of ["LongName", "Description", "Units"] as const) {
      const cap = PARTICIPANT_FIELD_CAPS[field];
      expect(sent.columns[0][field]).toBe(`${field[0]?.repeat(cap)}\n[cut]`);
      expect(sent.columns[1][field]).toBe(field[0]?.repeat(cap));
    }
    // And a column nothing was cut from says nothing of the kind.
    const clean = sendParticipants({ col: { Units: "years" } });
    expect(clean.states.participants_json).toBe("sent");
  });

  test("a cut between the halves of an emoji ends before it", () => {
    const cap = PARTICIPANT_FIELD_CAPS.Description;
    expect(
      sentOf({ col: { Description: `${"a".repeat(cap - 1)}\u{1F600}b` } }).columns[0].Description,
    ).toBe(`${"a".repeat(cap - 1)}\n[cut]`);
  });

  test.each([
    ["sub-01", "sub-01"],
    ["sub01", "sub01"],
    ["sub_01", "sub_01"],
    ["S01", "S01"],
    ["P001", "P001"],
    ["pt7", "pt7"],
    ["participant_01", "participant_01"],
    ["subject-01", "subject-01"],
    ["subj 12", "subj 12"],
    ["in capitals", "SUB-02"],
    ["mixed case", "Sub-jsmith"],
    ["after a space", " sub-03"],
    ["after an invisible character", "\u200bsub-04"],
    ["after a variation selector", "\uFE0Fsub-05"],
    ["fullwidth", fullwidth("sub01")],
  ])("a column named like a participant label withholds the whole file: %s", (_what, key) => {
    const r = sendParticipants({
      participant_id: { Description: "label" },
      [key]: { Description: "x", Units: "y" },
    });
    expect(r.states.participants_json).toBe("withheld_finding");
    expect(r.cleared.participants_json).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "path-subject-label": 1 });
    expect(JSON.stringify(r)).not.toMatch(/jsmith|sub-0|S01|P001/i);
  });

  test.each(["01", "1", "123", "-4", "12.5", "007"])(
    "a column that is a number is a label: %s",
    (key) => {
      const r = sendParticipants({ [key]: { Description: "x" } });
      expect(r.states.participants_json).toBe("withheld_finding");
      expect(r.withheld_findings).toEqual({ "path-subject-label": 1 });
    },
  );

  test("a key longer than 64 characters is not a column name, and withholds the file", () => {
    const ok = sendParticipants({ [`${"c".repeat(PARTICIPANT_KEY_MAX)}`]: { Description: "x" } });
    expect(ok.states.participants_json).toBe("sent");
    const long = sendParticipants({
      [`${"c".repeat(PARTICIPANT_KEY_MAX + 1)}`]: { Description: "x" },
    });
    expect(long.states.participants_json).toBe("withheld_finding");
    expect(long.withheld_findings).toEqual({ "participants-identifier-column": 1 });
  });

  test("a file keyed by subject is one finding, however many subjects", () => {
    const keyed = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`sub-${i}`, { age: 30 }]),
    );
    expect(sendParticipants(keyed).withheld_findings).toEqual({ "path-subject-label": 1 });
    const numbers = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`${i}`, { age: 30 }]));
    expect(sendParticipants(numbers).withheld_findings).toEqual({ "path-subject-label": 1 });
  });

  test("two columns whose names normalize alike are two columns, and are counted as two", () => {
    // As keys of one object they would be one; the count and the list follow the file.
    const text =
      '{"a\\u200b":{"Description":"first"},"a ":{"Description":"second"},"b":{"Units":"u"}}';
    const r = presend(docs({ participants_json: present(text, "participants.json") }));
    expect(JSON.parse(r.cleared.participants_json as string)).toEqual({
      column_count: 3,
      columns: [{ Description: "first" }, { Description: "second" }, { Units: "u" }],
    });
  });

  test("a word that begins like a label is a column: subject_group, subtype, a hyphenated sub", () => {
    const r = sendParticipants({
      subject_group: { Description: "g" },
      subtype: { Description: "t" },
      "pre-sub-": { Description: "x" },
      participant_id: { Description: "label" },
      age: { Units: "years" },
    });
    expect(r.states.participants_json).toBe("sent");
  });

  test("the shared rule's own pattern is the one used here (the shared constant is not exported)", () => {
    const shared = readFileSync(
      join(import.meta.dir, "..", "shared", "identifier-scan.ts"),
      "utf8",
    );
    expect(shared).toContain(`const SUBJECT_LABEL = ${PARTICIPANT_LABEL.toString()};`);
  });

  test("more than 200 columns is a file keyed by participant: unreadable, not sent", () => {
    const columns = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`col${i}x`, { Description: "x" }]));
    expect(PARTICIPANT_MAX_COLUMNS).toBe(200);
    // 200 is the limit and is read: its column_count is 200 whether or not the text is cut.
    expect(sentOf(columns(200)).column_count).toBe(200);
    expect(sentOf(columns(100)).column_count).toBe(100);
    const r = sendParticipants(columns(201));
    expect(r.states.participants_json).toBe("withheld_unreadable");
    expect(r.cleared.participants_json).toBeUndefined();
    expect(r.withheld_findings).toEqual({});
  });

  test("a __proto__ column is a column, and its description is read", () => {
    const text = '{"__proto__":{"Description":"/Users/jsmith/x"}}';
    const r = presend(docs({ participants_json: present(text, "participants.json") }));
    expect(r.states.participants_json).toBe("withheld_finding");
    expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
  });

  test("a path in a description is still a path, whatever the column is called", () => {
    for (const key of ["age", "Jane Doe", "visual_acuity"]) {
      const r = sendParticipants({ [key]: { Description: "Collected by /home/jsmith/forms" } });
      expect(r.states.participants_json, key).toBe("withheld_finding");
      expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
    }
  });

  test.each([
    ["a string", { age: "years" }],
    ["a number", { age: 5 }],
    ["null", { age: null }],
    ["an array", { age: ["a"] }],
    ["one column among objects", { participant_id: { Description: "d" }, age: "years" }],
  ])("a file that is not an object of objects is unreadable, not sent: %s", (_what, object) => {
    const r = sendParticipants(object);
    expect(r.states.participants_json).toBe("withheld_unreadable");
    expect(r.cleared.participants_json).toBeUndefined();
    expect(r.withheld_findings).toEqual({});
  });

  test("an empty object is a file with no columns, and is sent as a count of none", () => {
    const r = sendParticipants({});
    expect(r.states.participants_json).toBe("sent");
    expect(JSON.parse(r.cleared.participants_json as string)).toEqual({
      column_count: 0,
      columns: [],
    });
  });

  test("an array, or text that is not JSON, is withheld as not JSON", () => {
    for (const text of ["[]", "{ broken", "name\tage\n"]) {
      const r = presend(docs({ participants_json: present(text, "participants.json") }));
      expect(r.states.participants_json, text).toBe("withheld_not_json");
    }
  });
});

describe("nesting deeper than the limit is refused before anything is re-serialized (#1728)", () => {
  // Pretty-printing indents every level, so a value nested n deep serializes to about n squared
  // characters: a 54 KB description nested 27,000 deep took gigabytes before it was withheld.
  const arrays = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;
  const objects = (n: number) => `${'{"a":'.repeat(n)}1${"}".repeat(n)}`;
  const description = (extra: string) =>
    `{"Name":"A descriptive dataset name that is long enough",${extra}}`;
  const sendDescription = (text: string) =>
    presend(docs({ dataset_description: present(text, "dataset_description.json") }));

  test("the limit is 32 levels, counting the object that holds the shown keys", () => {
    expect(MAX_JSON_DEPTH).toBe(32);
    // The shown keys' object is level 1, so the arrays may add 31 more.
    expect(sendDescription(description(`"Funding":${arrays(31)}`)).states.dataset_description).toBe(
      "sent",
    );
    for (const text of [
      description(`"Funding":${arrays(32)}`),
      description(`"GeneratedBy":${objects(32)}`),
    ]) {
      const r = sendDescription(text);
      expect(r.states.dataset_description).toBe("withheld_unreadable");
      expect(r.cleared.dataset_description).toBeUndefined();
      expect(r.withheld_findings).toEqual({});
    }
  });

  test("participants.json is held to the same limit, whatever part of it is sent", () => {
    const ok = presend(
      docs({
        participants_json: present(`{"age":{"Levels":${arrays(30)}}}`, "participants.json"),
      }),
    );
    expect(ok.states.participants_json).toBe("sent");
    const deep = presend(
      docs({
        participants_json: present(`{"age":{"Levels":${arrays(31)}}}`, "participants.json"),
      }),
    );
    expect(deep.states.participants_json).toBe("withheld_unreadable");
  });

  test("a very deep value is refused fast, and a hidden key that is not shown is never walked", () => {
    const depth = 27_000;
    for (const text of [
      description(`"Funding":${arrays(depth)}`),
      description(`"GeneratedBy":${objects(depth)}`),
    ]) {
      const started = performance.now();
      const r = sendDescription(text);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(r.states.dataset_description).toBe("withheld_unreadable");
    }
    const started = performance.now();
    const deepParticipants = presend(
      docs({
        participants_json: present(`{"age":{"Levels":${arrays(depth)}}}`, "participants.json"),
      }),
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(deepParticipants.states.participants_json).toBe("withheld_unreadable");
    // Not a shown key: it is dropped before it is walked, so it costs nothing and withholds nothing.
    const hidden = performance.now();
    const r = sendDescription(description(`"Extra":${arrays(depth)}`));
    expect(performance.now() - hidden).toBeLessThan(1000);
    expect(r.states.dataset_description).toBe("sent");
  });

  test("the other documents are untouched by one that is refused", () => {
    const r = presend(
      docs({
        dataset_description: present(
          description(`"Funding":${arrays(40)}`),
          "dataset_description.json",
        ),
      }),
    );
    expect(r.states.readme).toBe("sent");
    expect(r.states.participants_json).toBe("sent");
  });
});

describe("a NUL byte means the bytes were not text, whatever decoder accepted them (#1728)", () => {
  // UTF-16 text with no byte-order mark and only ASCII characters IS valid UTF-8, with a NUL
  // between every letter. The cleaning replaces each NUL with a space, which would turn
  // "/Users/jsmith" into "/ U s e r s / j s m i t h" and take it past the path rule.
  const spaced = (text: string) =>
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "utf16le"));

  test("the premise: UTF-16 ASCII without a byte-order mark decodes as UTF-8", () => {
    expect(spaced("ab")).toBe("a\u0000b\u0000");
  });

  test.each([
    ["readme", "README.md"],
    ["changes", "CHANGES"],
    ["license", "LICENSE"],
    ["dataset_description", "dataset_description.json"],
    ["participants_json", "participants.json"],
  ] as const)(
    "%s with a NUL is withheld as not UTF-8 and nothing of it is sent",
    (document, name) => {
      const text = spaced(`{"Name":"x","Description":"see ${REAL_PATH}"}`);
      const r = presend(docs({ [document]: present(text, name) }));
      expect(r.states[document]).toBe("withheld_not_utf8");
      expect(r.cleared[document]).toBeUndefined();
      // No byte of it anywhere, and the others are untouched.
      expect(JSON.stringify(r)).not.toMatch(/jsmith|j s m i t h/);
      for (const other of REVIEW_DOCUMENTS)
        if (other !== document) expect(r.states[other]).toBe("sent");
    },
  );

  test("a NUL anywhere in a long document is enough, even past the cut", () => {
    const cap = DOCUMENT_CHAR_CAPS.readme;
    const r = presend(docs({ readme: present(`${"a".repeat(cap + 100)}\u0000`) }));
    expect(r.states.readme).toBe("withheld_not_utf8");
  });
});

describe("nothing here fails open", () => {
  test("a state this module does not know withholds the document, whatever text came with it", () => {
    const odd = { name: "README.md", state: "weird", text: `fine text ${REAL_PATH}` } as never;
    const clean = { name: "README.md", state: "weird", text: "fine text" } as never;
    for (const readme of [odd, clean]) {
      const r = presend(docs({ readme }));
      expect(r.states.readme).toBe("withheld_unreadable");
      expect(r.cleared.readme).toBeUndefined();
    }
  });

  test("a document missing from the input is withheld, not thrown and not sent", () => {
    const input = docs();
    // biome-ignore lint/performance/noDelete: the property must be absent, not undefined
    delete (input as Partial<typeof input>).changes;
    const r = presend(input);
    expect(r.states.changes).toBe("withheld_unreadable");
    expect(r.cleared.changes).toBeUndefined();
    expect(r.states.readme).toBe("sent");
  });

  test("whether a document was cut is judged on what is sent: a control character outside the BMP shortens it", () => {
    const cap = DOCUMENT_CHAR_CAPS.readme;
    // One character longer than the cap as read, exactly the cap once the two-unit tag character
    // is replaced by one space: it is sent whole, with no cut mark, and says so.
    const text = `${"a".repeat(cap - 2)}\u{E0001}b`;
    expect(text.length).toBe(cap + 1);
    const r = presend(docs({ readme: present(text) }));
    expect(r.states.readme).toBe("sent");
    expect((r.cleared.readme as string).length).toBe(cap);
    expect(r.cleared.readme as string).not.toContain("[cut]");
  });

  test("JSON nested so deeply that walking it fails is withheld, not thrown and not sent", () => {
    const depth = 300_000;
    const text = `{"participant_id":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    const r = presend(docs({ participants_json: present(text, "participants.json") }));
    expect(["withheld_not_json", "withheld_unreadable"]).toContain(r.states.participants_json);
    expect(r.cleared.participants_json).toBeUndefined();
    expect(r.states.readme).toBe("sent");
  });

  test("every state is a member of the closed list", () => {
    const r = presend(
      docs({
        readme: { name: "README.md", state: "annexed", text: null },
        changes: absent(),
        license: present(REAL_PATH, "LICENSE"),
        participants_json: present("{", "participants.json"),
      }),
    );
    for (const d of REVIEW_DOCUMENTS) {
      expect(DOCUMENT_STATES as readonly string[]).toContain(r.states[d]);
    }
  });
});

describe("the invariant: cleared text is text the shared rules found nothing in", () => {
  const PATHS = [
    "/Users/alice/x",
    "/home/bob/y",
    "C:\\Users\\carol\\z",
    "/home/user/ok",
    "/Users/me/ok",
    "file:///home/dave/x",
    "C:/Users/erin/z",
    "\\\\srv\\share",
  ];
  const PADS = ["", "x", "x ".repeat(40), "\n\n", "\u200b", "\u0007", "\t", "a\r\n", "word:\n"];

  /** Every key and string of a parsed JSON value. */
  const everyString = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(everyString)
        : value !== null && typeof value === "object"
          ? Object.entries(value).flatMap(([k, v]) => [k, ...everyString(v)])
          : [];

  /** A spread of documents: a path at every position relative to the cap, among several paddings. */
  function corpus(): Record<ReviewDocument, RawDocument>[] {
    const out: Record<ReviewDocument, RawDocument>[] = [];
    for (const path of PATHS) {
      for (const pad of PADS) {
        for (const document of ["readme", "changes", "license"] as const) {
          const cap = DOCUMENT_CHAR_CAPS[document];
          for (const at of [0, 7, cap - 20, cap - 5, cap, cap + 40]) {
            const body = "w".repeat(Math.max(0, at));
            out.push(docs({ [document]: present(`${pad}${body} ${path} ${pad}tail`) }));
          }
        }
        out.push(
          docs({
            dataset_description: present(
              JSON.stringify({
                Name: "A descriptive dataset name that is long enough",
                Funding: [`${pad}${path}`],
              }),
              "dataset_description.json",
            ),
            participants_json: present(
              JSON.stringify({ participant_id: { Description: `${pad}${path}` } }),
              "participants.json",
            ),
          }),
        );
      }
    }
    return out;
  }

  test("for every document of every case, a cleared string has no finding and a withheld one has one", () => {
    const cases = corpus();
    expect(cases.length).toBeGreaterThan(500);
    let cleared = 0;
    let withheld = 0;
    for (const input of cases) {
      const r = presend(input);
      for (const d of REVIEW_DOCUMENTS) {
        const text = r.cleared[d];
        if (text !== undefined) {
          cleared++;
          expect(scanTextForLocalPaths(text), `${d} cleared with a finding`).toEqual([]);
          if (d === "dataset_description" || d === "participants_json") {
            if (r.states[d] === "sent") {
              expect(scanJsonKeys(JSON.parse(text))).toEqual([]);
              // Every string and key, ON ITS OWN, as the model reads it (not as escaped text).
              for (const each of everyString(JSON.parse(text))) {
                expect(scanTextForLocalPaths(each), `${d} string`).toEqual([]);
                expect(scanLocalPathForms(each), `${d} string`).toEqual([]);
              }
            }
          }
        } else if (r.states[d] === "withheld_finding") {
          withheld++;
        }
      }
    }
    // Guards the guard: a corpus that cleared or withheld nothing would pass vacuously.
    expect(cleared).toBeGreaterThan(1000);
    expect(withheld).toBeGreaterThan(100);
  });
});

describe("this file is the only one that mints cleared text", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "scripts", "ci", "publication-review-presend.ts"),
    "utf8",
  );

  test("it holds exactly one cast to ClearedText", () => {
    expect(source.match(/\bas\s+ClearedText\b/g)).toHaveLength(1);
  });

  test("the cast sits after the rules ran and only on the findings-free path", () => {
    const cast = source.indexOf("as ClearedText");
    const scan = source.indexOf("scanTextForLocalPaths(prepared.sent)");
    const gate = source.indexOf("if (findings.length > 0)");
    expect(scan).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(scan);
    expect(cast).toBeGreaterThan(gate);
  });

  test("the rules it applies are the shared ones, not a copy", () => {
    expect(source).toContain('from "../../shared/identifier-scan"');
    expect(source).toContain("scanTextForLocalPaths");
    expect(source).toContain("scanJsonKeys");
  });
});
