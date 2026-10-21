/**
 * The change classes of the mechanical change summary (design `.context/plans/pr-review-change-summary.md`
 * sections 4.2, 5, 6, 7 and 8): how the atoms of every file are grouped into classes, ordered,
 * rendered within their bounds, judged complete, and turned into the files the summary accounts
 * for and the loss facts. Pure: real bytes go through the real parsers and diffs, and nothing here
 * touches git or a file.
 *
 * The bar is the one the required check stands on: a file is accounted for only if everything a
 * reader needs to judge every non-additive change in it was rendered completely. A lenient error
 * here is a false pass, so the tests pin what must NOT be accounted for as carefully as what must.
 */

import { describe, expect, test } from "bun:test";
import {
  type Atom,
  CLASS_KINDS,
  type ChangeClass,
  type ChangeSummary,
  type ClassDisplay,
  type ClassKind,
  DISPLAY_OF,
  EMPTY_SUMMARY,
  type FileAtoms,
  type FileOutcome,
  KIND_WORDS,
  type LossFacts,
  NO_LOSS,
  type PoolFile,
  ROLE_OF,
  SUMMARY_LIMITS,
  type SummaryCandidate,
  accountedFiles,
  buildPools,
  canonicalJson,
  classKeyOf,
  classTable,
  classify,
  diffJson,
  diffTable,
  entityPattern,
  foldIndices,
  formatAtoms,
  lossFactsOf,
  parseJson,
  parseTsv,
  renderClasses,
  renderValue,
  ruleWords,
  stripJsonSpace,
  summarizeChanges,
  summarizeChangesWith,
  summaryFacts,
  verifyJsonCounts,
  verifyTableCounts,
} from "../scripts/ci/pr-review-summary";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Tab-separated text from rows of cells, with LF endings and a final newline. */
function tsv(...rows: string[][]): string {
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

/** A pool file from text; `before` is null for an added file. */
function pooled(path: string, before: string | null, after: string): PoolFile {
  return { path, before: before === null ? null : enc(before), after: enc(after) };
}

/**
 * The atoms of several table and JSON files diffed in the order given against one pool, through
 * the real parsers: what the summary groups. Throws on a refusal, which no test here expects.
 */
function atomsOf(
  files: readonly { path: string; before: string; after: string }[],
  poolFiles: readonly PoolFile[] = [],
): FileAtoms[] {
  const pools = buildPools(poolFiles);
  return files.map((file) => {
    if (file.path.endsWith(".tsv")) {
      const b = parseTsv(enc(file.before));
      const a = parseTsv(enc(file.after));
      if (!b.ok || !a.ok) throw new Error(`test input is not a table: ${file.path}`);
      const diff = diffTable(file.path, b.value, a.value, pools.rows);
      if (!diff.ok) throw new Error(`diff refused: ${diff.refusal}`);
      return { path: file.path, atoms: diff.value.atoms };
    }
    const b = parseJson(enc(file.before));
    const a = parseJson(enc(file.after));
    if (!b.ok || !a.ok) throw new Error(`test input is not JSON: ${file.path}`);
    const diff = diffJson(file.path, b.value.value, a.value.value, pools.json);
    if (!diff.ok) throw new Error(`diff refused: ${diff.refusal}`);
    return { path: file.path, atoms: diff.value.atoms };
  });
}

/** A class as one line, for expectations a person can read. */
function brief(c: ChangeClass): string {
  const parts = [c.kind, c.shape];
  if (c.field !== null) parts.push(`field=${c.field}`);
  if (c.detail !== null) parts.push(`detail=${c.detail}`);
  if (c.rule !== null) parts.push(`rule=${c.rule.kind}:${JSON.stringify(c.rule.gaps)}`);
  parts.push(`${c.items} in ${c.files.size}`);
  return parts.join(" | ");
}

/** The pairs of a class as `before -> after xN` lines, the separator made visible. */
function pairLines(c: ChangeClass): string[] {
  return [...c.pairs].map(([pair, n]) => `${pair.replace("\u{0}", " -> ")} x${n}`);
}

const CHANNELS = ["name", "type", "units"];

describe("the vocabulary of a class", () => {
  test("every kind has words, no two kinds share them, and they are plain platform words", () => {
    const words = CLASS_KINDS.map((kind) => KIND_WORDS[kind]);
    expect(words.every((w) => typeof w === "string" && w.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(CLASS_KINDS.length);
    for (const w of words) expect(w).toMatch(/^[a-z][a-z ]*[a-z]$/);
    expect(Object.keys(KIND_WORDS).sort()).toEqual([...CLASS_KINDS].sort());
  });

  test("the words the design's example uses", () => {
    expect(KIND_WORDS.row_removed).toBe("rows removed");
    expect(KIND_WORDS.key_relabeled).toBe("rows relabeled");
    expect(KIND_WORDS.rows_reordered).toBe("row order changed");
    expect(KIND_WORDS.row_added).toBe("rows added");
    expect(KIND_WORDS.row_relocated).toBe(
      "rows removed and found verbatim in a row this pull request adds",
    );
  });

  test("the paired kinds are exactly the design's, and additive display is additive role", () => {
    const shownBy = (display: string): string[] =>
      CLASS_KINDS.filter((kind) => DISPLAY_OF[kind] === display).sort();
    expect(shownBy("pairs")).toEqual(
      [
        "cell_replaced",
        "cell_emptied",
        "json_value_changed",
        "json_type_changed",
        "json_emptied",
      ].sort(),
    );
    expect(shownBy("removals")).toEqual(
      ["json_key_removed", "json_empty_key_removed", "row_removed"].sort(),
    );
    expect(shownBy("rule")).toEqual(
      [
        "key_relabeled",
        "cell_templated",
        "json_key_renamed",
        "row_relocated",
        "json_key_moved",
        "column_removed",
        "rows_reordered",
        "columns_reordered",
        "json_keys_reordered",
        "format",
      ].sort(),
    );
    for (const kind of CLASS_KINDS) {
      expect(DISPLAY_OF[kind] === "additive", kind).toBe(ROLE_OF[kind] === "additive");
    }
  });
});

describe("foldIndices: a JSON path with every index written [*]", () => {
  test("indices fold at any depth, names stay", () => {
    expect(foldIndices(".a[0].b[12]")).toBe(".a[*].b[*]");
    expect(foldIndices("[3]")).toBe("[*]");
    expect(foldIndices("[0][1].x")).toBe("[*][*].x");
    expect(foldIndices(".HED.go")).toBe(".HED.go");
    expect(foldIndices("")).toBe("");
  });

  test("a key in brackets is passed over whole: a key that reads [0] is not an index", () => {
    expect(foldIndices('.a["[0]"]')).toBe('.a["[0]"]');
    expect(foldIndices('["x\\"[1]"][2]')).toBe('["x\\"[1]"][*]');
    expect(foldIndices('["0"][0]')).toBe('["0"][*]');
    expect(foldIndices('["a\\\\"][7]')).toBe('["a\\\\"][*]');
  });
});

describe("classify: one class per kind, shape, field, rule and detail", () => {
  const path1 = "sub-01/ses-01/ieeg/sub-01_ses-01_task-sleep_run-01_channels.tsv";
  const path2 = "sub-02/ses-01/ieeg/sub-02_ses-01_task-rest_run-02_channels.tsv";

  test("the same logical change in files with different unrelated rows and offsets is one class", () => {
    const files = atomsOf([
      {
        path: path1,
        before: tsv(CHANNELS, ["Z9", "EEG", "uV"], ["A1", "SEEG", "uV"], ["B2", "SEEG", "uV"]),
        after: tsv(CHANNELS, ["Z9", "EEG", "uV"], ["POL A1", "SEEG", "uV"], ["B2", "SEEG", "mV"]),
      },
      {
        path: path2,
        before: tsv(
          CHANNELS,
          ["Q1", "ECG", "uV"],
          ["Q2", "ECG", "uV"],
          ["Q3", "ECG", "uV"],
          ["C7", "EEG", "uV"],
          ["D4", "EEG", "uV"],
        ),
        after: tsv(
          CHANNELS,
          ["Q1", "ECG", "uV"],
          ["Q2", "ECG", "uV"],
          ["Q3", "ECG", "uV"],
          ["POL C7", "EEG", "uV"],
          ["D4", "EEG", "mV"],
        ),
      },
    ]);
    const classes = classify(files);
    // Two classes of 2 items in 2 files each: the tie is broken by the class key.
    expect(classes.map(brief)).toEqual([
      "cell_replaced | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=units | 2 in 2",
      'key_relabeled | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | rule=wrap:["POL ",""] | 2 in 2',
    ]);
    expect(pairLines(classes[0] as ChangeClass)).toEqual(["uV -> mV x2"]);
  });

  test("a different rule, field, shape or kind is another class", () => {
    const electrodes = "sub-01/ieeg/sub-01_electrodes.tsv";
    const files = atomsOf([
      {
        path: path1,
        before: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["E1", "SEEG", "uV"], ["B1", "SEEG", "uV"]),
        after: tsv(
          CHANNELS,
          ["POL A1", "SEEG", "uV"],
          ["EEG E1-Ref", "SEEG", "uV"],
          ["B1", "MISC", "mV"],
        ),
      },
      {
        path: electrodes,
        before: tsv(["name", "x", "units"], ["A1", "1", "uV"]),
        after: tsv(["name", "x", "units"], ["A1", "1", "mV"]),
      },
    ]);
    expect(classify(files).map(brief)).toEqual([
      "cell_replaced | sub-*/ieeg/sub-*_electrodes.tsv | field=units | 1 in 1",
      "cell_replaced | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=type | 1 in 1",
      "cell_replaced | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=units | 1 in 1",
      'key_relabeled | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | rule=wrap:["EEG ","-Ref"] | 1 in 1',
      'key_relabeled | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | rule=wrap:["POL ",""] | 1 in 1',
    ]);
  });

  test("items counts atoms and files counts each file once, however many atoms it holds", () => {
    const files = atomsOf([
      {
        path: path1,
        before: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["A2", "SEEG", "uV"], ["A3", "SEEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "SEEG", "mV"], ["A2", "SEEG", "mV"], ["A3", "SEEG", "V"]),
      },
    ]);
    const [units] = classify(files);
    expect(units?.items).toBe(3);
    expect(units?.files.size).toBe(1);
    expect(pairLines(units as ChangeClass)).toEqual(["uV -> mV x2", "uV -> V x1"]);
  });

  test("the class key is the JSON text of [kind, shape, field, rule, detail], and it is what classify groups by", () => {
    const [file] = atomsOf([
      {
        path: path1,
        before: tsv(CHANNELS, ["A1", "SEEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "SEEG", "uV"]),
      },
    ]);
    const atom = file?.atoms[0] as Atom;
    const id = classKeyOf(path1, atom);
    expect(id.key).toBe(
      JSON.stringify([
        "key_relabeled",
        "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv",
        "name",
        ["wrap", ["POL ", ""], "", false],
        null,
      ]),
    );
    // A rule built with its fields in another order is the same key.
    const reordered = {
      ...atom,
      rule: { repadded: false, shape: "", gaps: ["POL ", ""], kind: "wrap" },
    };
    expect(classKeyOf(path1, reordered as Atom).key).toBe(id.key);
  });

  test("a removed column's count of values is not part of the key: the column removed is the class", () => {
    const files = atomsOf([
      {
        path: path1,
        before: tsv(
          [...CHANNELS, "notes"],
          ["A1", "SEEG", "uV", "bad"],
          ["A2", "SEEG", "uV", "ok"],
        ),
        after: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["A2", "SEEG", "uV"]),
      },
      {
        path: path2,
        before: tsv([...CHANNELS, "notes"], ["A1", "SEEG", "uV", "n/a"]),
        after: tsv(CHANNELS, ["A1", "SEEG", "uV"]),
      },
    ]);
    const classes = classify(files);
    expect(classes.map(brief)).toEqual([
      "column_removed | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=notes | 2 in 2",
    ]);
    expect(classes[0]?.detail).toBeNull();
    expect(classes[0]?.pairs.size).toBe(0);
  });

  test("a relocated row's target shape, a rename's names and a format word are part of the key", () => {
    const poolFiles = [
      pooled(`sourcedata/older/${path1}`, null, tsv(CHANNELS, ["R1", "SEEG", "uV"])),
      pooled(`sourcedata/old/${path2}`, null, tsv(CHANNELS, ["R1", "SEEG", "uV"])),
    ];
    const files = atomsOf(
      [
        {
          path: path1,
          before: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["R1", "SEEG", "uV"]),
          after: `\u{FEFF}${tsv(CHANNELS, ["A1", "SEEG", "uV"])}`,
        },
        {
          path: path2,
          before: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["R1", "SEEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "SEEG", "uV"]).replace(/\n$/, ""),
        },
        {
          path: "task-sleep_ieeg.json",
          before: '{"MiscChannelCount": 2, "EEGReference": "Cz"}',
          after: '{"MISCChannelCount": 2, "eeg_reference": "Cz"}',
        },
      ],
      poolFiles,
    );
    expect(classify(files).map(brief)).toEqual([
      "row_relocated | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | detail=sourcedata/old/sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | 1 in 1",
      "row_relocated | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | detail=sourcedata/older/sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | 1 in 1",
      "format | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | detail=bom | 1 in 1",
      "format | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | detail=final_newline | 1 in 1",
      "json_key_renamed | task-*_ieeg.json | field= | detail=EEGReference -> eeg_reference | 1 in 1",
      "json_key_renamed | task-*_ieeg.json | field= | detail=MiscChannelCount -> MISCChannelCount | 1 in 1",
    ]);
  });

  test("JSON: a value kind is keyed by its leaf path and a key kind by its parent, indices folded to [*]", () => {
    const files = atomsOf([
      {
        path: "sub-01/eeg/sub-01_task-x_events.json",
        before: JSON.stringify({
          trials: [
            { onset: 1, kind: "go" },
            { onset: 2, kind: "go" },
          ],
          HED: { a: "x", b: "y", c: "z" },
        }),
        after: JSON.stringify({
          trials: [
            { onset: 1, kind: "stop" },
            { onset: 2, kind: "stop" },
          ],
          HED: { a: "x" },
        }),
      },
      {
        path: "sub-02/eeg/sub-02_task-x_events.json",
        before: JSON.stringify({ trials: [{ kind: "go" }], HED: { q: "1" } }),
        after: JSON.stringify({ trials: [{ kind: "stop" }], HED: {} }),
      },
    ]);
    const classes = classify(files);
    expect(classes.map(brief)).toEqual([
      "json_key_removed | sub-*/eeg/sub-*_task-*_events.json | field=.HED | 3 in 2",
      "json_value_changed | sub-*/eeg/sub-*_task-*_events.json | field=.trials[*].kind | 3 in 2",
      // `HED` emptied whole in the second file: `{}` is a leaf at a path the before side did
      // not have (it had `.HED.q`), so it is an added key under the root.
      "json_key_added | sub-*/eeg/sub-*_task-*_events.json | field= | 1 in 1",
    ]);
    // A key kind's pairs are `name = value`; the key names are pairs, never the key of the class.
    expect(pairLines(classes[0] as ChangeClass)).toEqual([
      'b = "y" ->  x1',
      'c = "z" ->  x1',
      'q = "1" ->  x1',
    ]);
    expect(pairLines(classes[1] as ChangeClass)).toEqual(['"go" -> "stop" x3']);
  });

  test("JSON key kinds fold the array indices of their parent path: the same edit under [0] and under [1] is one class", () => {
    const files = atomsOf([
      {
        path: "sub-01/eeg/sub-01_task-x_events.json",
        before: JSON.stringify({ trials: [{ go: 1, drop: 2 }] }),
        after: JSON.stringify({ trials: [{ GO: 1, add: 3 }] }),
      },
      {
        path: "sub-02/eeg/sub-02_task-x_events.json",
        before: JSON.stringify({ trials: [{ go: 1 }, { go: 1, drop: 2 }] }),
        after: JSON.stringify({ trials: [{ go: 1 }, { GO: 1, add: 3 }] }),
      },
    ]);
    const classes = classify(files);
    expect(classes.map((c) => `${c.kind} ${c.field} ${c.items} in ${c.files.size}`).sort()).toEqual(
      [
        "json_key_added .trials[*] 2 in 2",
        "json_key_removed .trials[*] 2 in 2",
        "json_key_renamed .trials[*] 2 in 2",
      ],
    );
    const { text } = renderClasses(classes);
    expect(text).toContain(
      'C1 | "sub-*/eeg/sub-*_task-*_events.json" | under ".trials[*]" | keys removed',
    );
    expect(text).not.toContain("[0]");
    expect(text).not.toContain("[1]");
  });

  test("a table's column name is the author's text and is never folded: columns x[0] and x[1] are two classes", () => {
    const columns = ["name", "x[0]", "x[1]"];
    const files = atomsOf([
      {
        path: path1,
        before: tsv(columns, ["A1", "1", "1"]),
        after: tsv(columns, ["A1", "2", "2"]),
      },
    ]);
    const classes = classify(files);
    expect(classes.map((c) => `${c.kind} ${c.field} ${c.items}`)).toEqual([
      "cell_replaced x[0] 1",
      "cell_replaced x[1] 1",
    ]);
    const lines = renderClasses(classes)
      .text.split("\n")
      .filter((line) => line.startsWith("C"));
    expect(lines.map((line) => line.split(" | ")[2])).toEqual(['column "x[0]"', 'column "x[1]"']);
  });

  test("the class key holds the shape and the kind: the same column edit under another shape, or of another kind, is another class", () => {
    const files = atomsOf([
      {
        path: "sub-01/eeg/sub-01_task-x_channels.tsv",
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
        // One cell replaced and one emptied, both in the column `units` of one file.
        after: tsv(CHANNELS, ["A1", "EEG", "mV"], ["A2", "EEG", "n/a"]),
      },
      {
        path: "sub-01/eeg/sub-01_task-x_events.tsv",
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
      },
    ]);
    const classes = classify(files);
    expect(classes.map((c) => `${c.kind} ${c.shape} ${c.field} ${c.items}`).sort()).toEqual([
      "cell_emptied sub-*/eeg/sub-*_task-*_channels.tsv units 1",
      "cell_replaced sub-*/eeg/sub-*_task-*_channels.tsv units 1",
      "cell_replaced sub-*/eeg/sub-*_task-*_events.tsv units 1",
    ]);
    expect(new Set(classes.map((c) => c.key)).size).toBe(3);
  });

  test("a keyless table's removed rows are paired by their whole row text", () => {
    const events = "sub-01/eeg/sub-01_task-x_events.tsv";
    const files = atomsOf([
      {
        path: events,
        before: tsv(["onset", "trial_type"], ["1.0", "go"], ["2.0", "stop"], ["3.0", "go"]),
        after: tsv(["onset", "trial_type"], ["1.0", "go"]),
      },
    ]);
    const [removed] = classify(files);
    expect(brief(removed as ChangeClass)).toBe(
      "row_removed | sub-*/eeg/sub-*_task-*_events.tsv | 2 in 1",
    );
    expect(pairLines(removed as ChangeClass)).toEqual(["2.0\tstop ->  x1", "3.0\tgo ->  x1"]);
  });
});

describe("classify: examples", () => {
  const shape = (n: number) => `sub-0${n}/eeg/sub-0${n}_task-x_channels.tsv`;

  test("the first atom of each of the first two files, in the order the files were given", () => {
    const files = atomsOf(
      [3, 1, 2].map((n) => ({
        path: shape(n),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "EEG", "uV"], ["POL A2", "EEG", "uV"]),
      })),
    );
    const [relabel] = classify(files);
    expect(relabel?.examples).toEqual([
      `"${shape(3)}" row "A1" -> "POL A1"`,
      `"${shape(1)}" row "A1" -> "POL A1"`,
    ]);
  });

  test("a class in one file shows its first two atoms there", () => {
    const files = atomsOf([
      {
        path: shape(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"], ["A3", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"], ["A2", "EEG", "V"], ["A3", "EEG", "mV"]),
      },
    ]);
    expect(classify(files)[0]?.examples).toEqual([
      `"${shape(1)}" "uV" -> "mV"`,
      `"${shape(1)}" "uV" -> "V"`,
    ]);
  });

  test("only the first 120 classes in render order have examples; the rest are never shown and have none", () => {
    const columns = Array.from({ length: 125 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    const classes = classify(
      atomsOf([
        {
          path: shape(1),
          before: tsv(["name", ...columns], ["A1", ...columns.map(() => "1")]),
          after: tsv(["name", ...columns], ["A1", ...columns.map(() => "2")]),
        },
      ]),
    );
    expect(classes.length).toBe(125);
    const withExamples = classes.map((c) => c.examples.length);
    expect(withExamples.slice(0, SUMMARY_LIMITS.maxClasses).every((n) => n === 1)).toBe(true);
    expect(withExamples.slice(SUMMARY_LIMITS.maxClasses)).toEqual([0, 0, 0, 0, 0]);
    expect(classes[0]?.examples).toEqual([`"${shape(1)}" "1" -> "2"`]);
  });

  test("a removed column's count is printed as written when it is a whole number, and as unknown otherwise", () => {
    const removed = (detail: string | null, field: string): Atom => ({
      kind: "column_removed",
      field,
      rule: null,
      detail,
      before: null,
      after: null,
    });
    const details: (string | null)[] = ["0", "12", null, "", "abc", "-1", "1.5", " 3"];
    const classes = classify([
      { path: "a.tsv", atoms: details.map((d, i) => removed(d, `c${i}`)) },
    ]);
    const printed = new Map(classes.map((c) => [c.field, c.examples[0]]));
    expect(details.map((_, i) => printed.get(`c${i}`))).toEqual([
      '"a.tsv" (0 non-missing values)',
      '"a.tsv" (12 non-missing values)',
      '"a.tsv" (unknown non-missing values)',
      '"a.tsv" (unknown non-missing values)',
      '"a.tsv" (unknown non-missing values)',
      '"a.tsv" (unknown non-missing values)',
      '"a.tsv" (unknown non-missing values)',
      '"a.tsv" (unknown non-missing values)',
    ]);
  });

  test("examples are rendered: a key, a row, a column count, a layout change, a JSON key", () => {
    const files = atomsOf([
      {
        path: shape(1),
        before: tsv([...CHANNELS, "notes"], ["A1", "EEG", "uV", "x"], ["R1", "EEG", "uV", "y"]),
        after: `${tsv(CHANNELS, ["A1", "EEG", "uV"], ["New\u{200B}", "EEG", "uV"])}`.replaceAll(
          "\n",
          "\r\n",
        ),
      },
      {
        path: "task-x_eeg.json",
        before: '{"PowerLineFrequency": 50, "Notes": "x"}',
        after: '{"PowerLineFrequency": 60}',
      },
    ]);
    const examples = classify(files).flatMap((c) => c.examples);
    expect(examples).toEqual([
      `"${shape(1)}" (2 non-missing values)`,
      '"task-x_eeg.json" key "Notes"',
      `"${shape(1)}" row "R1"`,
      `"${shape(1)}" (lf to crlf)`,
      '"task-x_eeg.json" key ".PowerLineFrequency"',
      `"${shape(1)}" row "New\\u{200B}"`,
    ]);
  });
});

describe("classify: the order a class renders in (design section 5.1)", () => {
  test("loss, then relocated, then modification, then additive", () => {
    const path = "sub-01/eeg/sub-01_task-x_channels.tsv";
    const files = atomsOf(
      [
        {
          path,
          before: tsv(
            CHANNELS,
            ["A1", "EEG", "uV"],
            ["GONE", "EEG", "uV"],
            ["KEPT", "EEG", "uV"],
            ["B1", "EEG", "uV"],
          ),
          after: tsv(CHANNELS, ["POL A1", "EEG", "uV"], ["B1", "EEG", "mV"], ["NEW", "EEG", "uV"]),
        },
      ],
      [pooled(`sourcedata/old/${path}`, null, tsv(CHANNELS, ["KEPT", "EEG", "uV"]))],
    );
    expect(classify(files).map((c) => `${ROLE_OF[c.kind]} ${c.kind}`)).toEqual([
      "loss row_removed",
      "relocated row_relocated",
      "modification cell_replaced",
      "modification key_relabeled",
      "additive row_added",
    ]);
  });

  test("within a role, more files first, then more items, then the class key in code-unit order", () => {
    const at = (n: number) => `sub-0${n}/eeg/sub-0${n}_task-x_channels.tsv`;
    const files = atomsOf([
      {
        path: at(1),
        before: tsv(
          ["name", "a", "b", "c", "d"],
          ["A1", "1", "1", "1", "1"],
          ["A2", "1", "1", "1", "1"],
        ),
        after: tsv(
          ["name", "a", "b", "c", "d"],
          ["A1", "2", "2", "2", "2"],
          ["A2", "1", "2", "2", "1"],
        ),
      },
      {
        path: at(2),
        before: tsv(["name", "a", "b", "c", "d"], ["A1", "1", "1", "1", "1"]),
        after: tsv(["name", "a", "b", "c", "d"], ["A1", "1", "2", "1", "1"]),
      },
    ]);
    // b: 3 items in 2 files; c: 2 items in 1 file; a and d: 1 item in 1 file each, by key.
    expect(classify(files).map((c) => `${c.field} ${c.items}/${c.files.size}`)).toEqual([
      "b 3/2",
      "c 2/1",
      "a 1/1",
      "d 1/1",
    ]);
  });

  test("the order is a function of the classes alone: files given in another order give the same classes in the same order", () => {
    const specs = [1, 2, 3, 4].map((n) => ({
      path: `sub-0${n}/eeg/sub-0${n}_task-x_channels.tsv`,
      before: tsv(CHANNELS, ["A1", "EEG", "uV"], [`X${n}`, "EEG", "uV"]),
      after: tsv(CHANNELS, ["A1", n % 2 === 0 ? "EOG" : "EEG", "mV"]),
    }));
    const forward = classify(atomsOf(specs)).map((c) => [c.key, c.items, c.files.size]);
    const backward = classify(atomsOf([...specs].reverse())).map((c) => [
      c.key,
      c.items,
      c.files.size,
    ]);
    expect(backward).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------------------------
// Rendering, bounds and completeness
// ---------------------------------------------------------------------------------------------

/** The fenced block of some files, classified and rendered. */
function rendered(
  files: readonly { path: string; before: string; after: string }[],
  poolFiles: readonly PoolFile[] = [],
) {
  const classes = classify(atomsOf(files, poolFiles));
  return { classes, ...renderClasses(classes) };
}

/** A channel table at sub-0n, from rows of [name, type, units]. */
const channels = (n: number) => `sub-0${n}/eeg/sub-0${n}_task-x_channels.tsv`;

/**
 * Every line of a block is one of the platform's own: a class line, an indented line under it, or
 * the last line that counts the classes left out. Nothing a value holds can start a line.
 */
const LINE =
  /^(C[0-9]+ \| | {4}(?:"|\(|e\.g\. )|\(1 more change class not shown\)$|\([0-9]+ more change classes not shown\)$)/;

describe("renderClasses: what a class looks like", () => {
  test("a class line, its pairs with their counts, and its examples", () => {
    const { text, shown, complete, cut } = rendered(
      [1, 2].map((n) => ({
        path: channels(n),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["B1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "EEG", "uV"], ["B1", "EEG", "mV"]),
      })),
    );
    expect(text).toBe(
      [
        'C1 | "sub-*/eeg/sub-*_task-*_channels.tsv" | column "units" | cells replaced',
        '    "uV" -> "mV" x2',
        `    e.g. "${channels(1)}" "uV" -> "mV"`,
        `    e.g. "${channels(2)}" "uV" -> "mV"`,
        'C2 | "sub-*/eeg/sub-*_task-*_channels.tsv" | column "name" | rows relabeled: added prefix "POL "',
        `    e.g. "${channels(1)}" row "A1" -> "POL A1"`,
        `    e.g. "${channels(2)}" row "A1" -> "POL A1"`,
      ].join("\n"),
    );
    expect(shown.size).toBe(2);
    expect(complete.size).toBe(2);
    expect(cut).toBe(0);
  });

  test("a removal shows one side: a keyed row's key, a keyless row's cells, a JSON key's name = value", () => {
    const { text } = rendered([
      {
        path: "participants.tsv",
        before: tsv(["participant_id", "age"], ["sub-01", "30"], ["sub-02", "40"]),
        after: tsv(["participant_id", "age"], ["sub-01", "30"]),
      },
      {
        path: "sub-01/eeg/sub-01_task-x_events.tsv",
        before: tsv(["onset", "trial_type"], ["1.0", "go"], ["2.0", "stop"]),
        after: tsv(["onset", "trial_type"], ["1.0", "go"]),
      },
      {
        path: "task-x_events.json",
        before: '{"HED": {"go": "Press", "stop": "Halt"}}',
        after: '{"HED": {"go": "Press"}}',
      },
    ]);
    expect(text).toBe(
      [
        'C1 | "task-*_events.json" | under ".HED" | keys removed',
        '    "stop = \\"Halt\\"" x1',
        '    e.g. "task-x_events.json" key "stop"',
        'C2 | "participants.tsv" | column "participant_id" | rows removed',
        '    "sub-02" x1',
        '    e.g. "participants.tsv" row "sub-02"',
        'C3 | "sub-*/eeg/sub-*_task-*_events.tsv" | rows removed',
        '    "2.0\\tstop" x1',
        '    e.g. "sub-01/eeg/sub-01_task-x_events.tsv" row "2.0\\tstop"',
      ].join("\n"),
    );
  });

  test("a removed JSON key that holds U+0000 is shown whole: a pair splits at its LAST U+0000, never the key's", () => {
    // `JSON.stringify` writes the NUL as \u0000, which the parser reads back as the character.
    const keys = { "a\u0000b": "secret value", "\u0000": "v3", "c\u0000": "v2" };
    const { text, complete, classes } = rendered([
      {
        path: "x.json",
        before: JSON.stringify({ ...keys, keep: 1 }),
        after: JSON.stringify({ keep: 1 }),
      },
    ]);
    expect(Object.keys(keys).every((key) => key.includes("\u0000"))).toBe(true);
    expect(text).toBe(
      [
        'C1 | "x.json" | top level | keys removed',
        '    "\\u0000 = \\"v3\\"" x1',
        '    "a\\u0000b = \\"secret value\\"" x1',
        '    "c\\u0000 = \\"v2\\"" x1',
        '    e.g. "x.json" key "a\\u0000b"',
        '    e.g. "x.json" key "\\u0000"',
      ].join("\n"),
    );
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(true);
    const summary = summarize([
      candidate("x.json", JSON.stringify({ ...keys, keep: 1 }), JSON.stringify({ keep: 1 })),
    ]);
    expect([...summary.accounted]).toEqual(["x.json"]);
  });

  test("rule kinds name their rule: a relocation's target, a rename, a layout change, a templated cell", () => {
    const path = channels(1);
    const { text, complete } = rendered(
      [
        {
          path,
          before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"], ["B1", "ECOG1", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"], ["B1", "ECOG01", "uV"]).replaceAll(
            "\n",
            "\r\n",
          ),
        },
        {
          path: "task-x_eeg.json",
          before: '{"MiscChannelCount": 2}',
          after: '{"MISCChannelCount": 2}',
        },
      ],
      [pooled(`sourcedata/old/${path}`, null, tsv(CHANNELS, ["R1", "EEG", "uV"]))],
    );
    expect(text).toBe(
      [
        'C1 | "sub-*/eeg/sub-*_task-*_channels.tsv" | column "name" | rows removed and found verbatim in a row this pull request adds: to "sourcedata/old/sub-*/eeg/sub-*_task-*_channels.tsv"',
        `    e.g. "${path}" row "R1"`,
        'C2 | "sub-*/eeg/sub-*_task-*_channels.tsv" | column "type" | cells changed by a rule: zero padding of numbers changed',
        `    e.g. "${path}" "ECOG1" -> "ECOG01"`,
        'C3 | "sub-*/eeg/sub-*_task-*_channels.tsv" | file layout changed: line endings changed',
        `    e.g. "${path}" (lf to crlf)`,
        'C4 | "task-*_eeg.json" | top level | keys renamed: "MiscChannelCount -> MISCChannelCount"',
        '    e.g. "task-x_eeg.json" key "MiscChannelCount -> MISCChannelCount"',
      ].join("\n"),
    );
    expect(complete.size).toBe(4);
  });

  test("a filled JSON value is a value kind too: it names its leaf path, and a scalar document is the whole document", () => {
    const { text, complete } = rendered([
      { path: "x.json", before: '{"a": {"b": ""}}', after: '{"a": {"b": "set"}}' },
      { path: "y.json", before: '""', after: '"set"' },
    ]);
    expect(text.split("\n").filter((l) => l.startsWith("C"))).toEqual([
      'C1 | "x.json" | key ".a.b" | values filled',
      'C2 | "y.json" | the whole document | values filled',
    ]);
    expect(complete.size).toBe(2);
  });

  test("a JSON value class names its leaf path, and a scalar document is the whole document", () => {
    const { text } = rendered([
      {
        path: "dataset_description.json",
        before: '{"Authors": ["A"], "Funding": [{"id": 1}, {"id": 2}]}',
        after: '{"Authors": ["B"], "Funding": [{"id": 3}, {"id": 4}]}',
      },
      { path: "x.json", before: "1", after: '"1"' },
    ]);
    expect(text.split("\n").filter((l) => l.startsWith("C"))).toEqual([
      'C1 | "dataset_description.json" | key ".Funding[*].id" | values changed',
      'C2 | "x.json" | the whole document | value types changed',
      'C3 | "dataset_description.json" | key ".Authors" | values changed',
    ]);
    expect(text).toContain('    "[\\"A\\"]" -> "[\\"B\\"]" x1');
    expect(text).toContain('    "1" -> "\\"1\\"" x1\n    e.g. "x.json"\n');
  });
});

describe("renderClasses: the bounds", () => {
  /** One channel file whose `units` cell takes `n` distinct new values, and its class. */
  const distinctValues = (n: number) =>
    rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...Array.from({ length: n }, (_, i) => [`A${i + 1}`, "EEG", "uV"])),
        after: tsv(CHANNELS, ...Array.from({ length: n }, (_, i) => [`A${i + 1}`, "EEG", `v${i}`])),
      },
    ]);

  test("12 distinct pairs are all shown and the class is complete", () => {
    const { text, complete, classes } = distinctValues(12);
    expect(text.split("\n").filter((l) => l.includes(" -> ") && !l.includes("e.g.")).length).toBe(
      12,
    );
    expect(text).not.toContain("more distinct value");
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(true);
  });

  test("one distinct pair left out is counted in the singular, and the class is incomplete", () => {
    const { text, complete, classes } = distinctValues(13);
    expect(text).toContain("\n    (1 more distinct value not shown)\n");
    expect(text).not.toContain("more distinct values");
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(false);
  });

  test("more than 12 distinct pairs show 12, then how many more, and the class is incomplete", () => {
    const { text, complete, shown, classes } = distinctValues(15);
    const pairs = text.split("\n").filter((l) => /^ {4}"uV" -> /.test(l));
    expect(pairs.length).toBe(SUMMARY_LIMITS.maxPairsPerClass);
    expect(text).toContain("\n    (3 more distinct values not shown)\n");
    const key = (classes[0] as ChangeClass).key;
    expect(shown.has(key)).toBe(true);
    expect(complete.has(key)).toBe(false);
  });

  test("the pairs shown are the most frequent, then by text: a function of the class alone", () => {
    const { text } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...Array.from({ length: 14 }, (_, i) => [`A${i}`, "EEG", "uV"])),
        after: tsv(
          CHANNELS,
          ...Array.from({ length: 14 }, (_, i) => [`A${i}`, "EEG", i < 3 ? "zz" : `v${i}`]),
        ),
      },
    ]);
    const pairs = text.split("\n").filter((l) => /^ {4}"uV" -> /.test(l));
    expect(pairs[0]).toBe('    "uV" -> "zz" x3');
    expect(pairs.slice(1, 3)).toEqual(['    "uV" -> "v10" x1', '    "uV" -> "v11" x1']);
  });

  test("a value over 300 characters is cut, marked after its closing quote, and the class is incomplete", () => {
    const long = "x".repeat(301);
    const { text, complete, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", long]),
        after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
      },
    ]);
    expect(text).toContain(`    "${"x".repeat(300)}"...(cut) -> "uV" x1`);
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(false);
  });

  test("a value over 300 characters on the AFTER side is cut too, and leaves the class incomplete and its file unaccounted for", () => {
    // A cell, and a JSON value (whose text is its canonical form: the quotes are two of the 300).
    const cases = [
      {
        file: (value: string) =>
          candidate(
            channels(1),
            tsv(CHANNELS, ["A1", "EEG", "uV"]),
            tsv(CHANNELS, ["A1", "EEG", value]),
          ),
        kind: "cell_replaced",
        shown: (value: string) => `"uV" -> "${value}"`,
        lengths: [300, 301],
      },
      {
        file: (value: string) => candidate("x.json", '{"a":"uV"}', JSON.stringify({ a: value })),
        kind: "json_value_changed",
        shown: (value: string) => `"\\"uV\\"" -> "\\"${value}\\""`,
        lengths: [298, 299],
      },
    ] as const;
    for (const { file, kind, shown, lengths } of cases) {
      for (const [i, length] of lengths.entries()) {
        const whole = i === 0;
        const value = "m".repeat(length);
        const summary = summarize([file(value)]);
        expect(
          summary.classes.map((c) => c.kind),
          `${kind} ${length}`,
        ).toEqual([kind]);
        const pair = summary.text.split("\n")[1] as string;
        // The after side is the one that ends the pair, so its cut marker is the last thing before `x1`.
        expect(pair.includes('"...(cut) x1'), `${kind} ${length}: ${pair.length}`).toBe(!whole);
        if (whole) expect(pair).toBe(`    ${shown(value)} x1`);
        expect(summary.complete.size, `${kind} ${length}`).toBe(whole ? 1 : 0);
        expect(summary.accounted.size, `${kind} ${length}`).toBe(whole ? 1 : 0);
        expect(
          summary.facts.classes[0]?.endsWith(whole ? "| in full" : "| not shown in full"),
        ).toBe(true);
      }
    }
  });

  test("a value of exactly 300 characters, astral ones counted as one, is not cut", () => {
    for (const value of ["x".repeat(300), "\u{1F600}".repeat(300)]) {
      const { text, complete, classes } = rendered([
        {
          path: channels(1),
          before: tsv(CHANNELS, ["A1", "EEG", value]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        },
      ]);
      expect(text).not.toContain("...(cut)");
      expect(complete.has((classes[0] as ChangeClass).key)).toBe(true);
    }
  });

  test("a removal whose row text is cut is incomplete too", () => {
    const { complete, classes } = rendered([
      {
        path: "sub-01/eeg/sub-01_task-x_events.tsv",
        before: tsv(["onset", "note"], ["1", "ok"], ["2", "y".repeat(400)]),
        after: tsv(["onset", "note"], ["1", "ok"]),
      },
    ]);
    expect(classes[0]?.kind).toBe("row_removed");
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(false);
  });

  test("at most 120 classes are shown; the rest are counted on the last line", () => {
    const columns = Array.from({ length: 121 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    const { text, shown, cut, classes } = rendered([
      {
        path: channels(1),
        before: tsv(["name", ...columns], ["A1", ...columns.map(() => "1")]),
        after: tsv(["name", ...columns], ["A1", ...columns.map(() => "2")]),
      },
    ]);
    expect(classes.length).toBe(121);
    expect(shown.size).toBe(SUMMARY_LIMITS.maxClasses);
    expect(cut).toBe(1);
    expect([...shown]).toEqual(classes.slice(0, 120).map((c) => c.key));
    expect(text.endsWith("\n(1 more change class not shown)")).toBe(true);
    expect(text).not.toContain("change classes not shown");
    expect(text).toContain('\nC120 | "sub-*/eeg/sub-*_task-*_channels.tsv" | column "c119" |');
    expect(text).not.toContain("C121");
  });

  test("the block never exceeds 30,000 characters, and what is shown is a prefix: rendering stops at the first class that does not fit", () => {
    // Six classes of twelve long pairs each (about 7,000 characters apiece), then a short one.
    const big = (k: number, side: string) =>
      Array.from({ length: 12 }, (_, i) => ({ v: `${side}${k}-${i}-${"w".repeat(280)}` }));
    const before: Record<string, unknown> = { small: "a" };
    const after: Record<string, unknown> = { small: "b" };
    for (let k = 0; k < 6; k++) {
      before[`k${k}`] = big(k, "old");
      after[`k${k}`] = big(k, "new");
    }
    const { text, shown, cut, classes } = rendered([
      { path: "x.json", before: JSON.stringify(before), after: JSON.stringify(after) },
    ]);
    expect(classes.map((c) => c.field)).toEqual([
      ".k0[*].v",
      ".k1[*].v",
      ".k2[*].v",
      ".k3[*].v",
      ".k4[*].v",
      ".k5[*].v",
      ".small",
    ]);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_LIMITS.maxSummaryChars);
    expect(shown.size).toBe(4);
    expect([...shown]).toEqual(classes.slice(0, 4).map((c) => c.key));
    expect(cut).toBe(3);
    expect(text.endsWith("\n(3 more change classes not shown)")).toBe(true);
    // The short class would have fit in what was left; it is still not shown, because the one
    // before it was not.
    const alone = renderClasses([classes[6] as ChangeClass]).text;
    expect(text.length + alone.length + 1).toBeLessThan(SUMMARY_LIMITS.maxSummaryChars);
    expect(shown.has((classes[6] as ChangeClass).key)).toBe(false);
  });

  test("the block grows one character at a time through 30,000 and never passes it: the edge is exact with and without the count line", () => {
    // Four classes of twelve pairs of 260 characters, a fifth of twelve whose after values the
    // sweep grows, and a short class (`.small`) last. Only ONE value changes per step, by ONE
    // character (a value is shown to 300 characters, so the twelve take turns, 280 each), so the
    // block's length moves one character at a time. The edge is met in two places: the fifth class
    // is the last that fits only with the room kept for the count line `(1 more change class not
    // shown)`, and the short one fits at the very end with none kept.
    const pairs = (k: number, side: string, lengths: readonly number[]) =>
      lengths.map((length, i) => ({ v: `${side}${k}-${i}-${"w".repeat(length)}` }));
    const slot = 280;
    const grown = (grow: number): number[] =>
      Array.from({ length: 12 }, (_, i) => Math.max(0, Math.min(slot, grow - i * slot)));
    const block = (grow: number, small: boolean) => {
      const before: Record<string, unknown> = { k4: pairs(4, "old", Array(12).fill(0)) };
      const after: Record<string, unknown> = { k4: pairs(4, "new", grown(grow)) };
      if (small) {
        before.small = "a";
        after.small = "b";
      }
      for (let k = 0; k < 4; k++) {
        before[`k${k}`] = pairs(k, "old", Array(12).fill(260));
        after[`k${k}`] = pairs(k, "new", Array(12).fill(260));
      }
      return rendered([
        { path: "x.json", before: JSON.stringify(before), after: JSON.stringify(after) },
      ]);
    };
    // The five long classes alone, which fit, and what each character of growth adds to them.
    const base = block(0, false).text.length;
    expect(block(0, false).shown.size).toBe(5);
    for (const grow of [1, 137, 280, 281, 560, 1000]) {
      expect(block(grow, false).text.length, `grow ${grow}`).toBe(base + grow);
    }
    const max = SUMMARY_LIMITS.maxSummaryChars;
    const steps: { grow: number; length: number; shown: number }[] = [];
    // From 250 characters under the edge of the fifth class to 250 over the short class's.
    for (let grow = max - 250 - base; grow <= max + 250 - base; grow++) {
      expect(grow, "the twelve slots are enough").toBeLessThanOrEqual(12 * slot);
      const { text, shown } = block(grow, true);
      expect(text.length, `grow ${grow}`).toBeLessThanOrEqual(max);
      steps.push({ grow, length: text.length, shown: shown.size });
    }
    expect(steps.length).toBeGreaterThanOrEqual(400);
    // The length moves one character at a time through 29,990 to 30,010 ...
    const lengths = steps.map((step) => step.length);
    for (const [i, step] of steps.entries()) {
      const next = steps[i + 1];
      if (next !== undefined && step.shown === next.shown && step.shown >= 5) {
        expect(next.length - step.length, `grow ${step.grow}`).toBe(1);
      }
    }
    expect(lengths.filter((n) => n === max).length).toBe(2);
    expect(Math.max(...lengths)).toBe(max);
    // ... and a class is dropped only when it does not fit: the last step with each count of
    // shown classes is exactly on the bound, so nothing is held back that would have fitted.
    expect([...new Set(steps.map((step) => step.shown))]).toEqual([6, 5, 4]);
    for (const shown of [6, 5]) {
      expect(steps.filter((step) => step.shown === shown).at(-1)?.length, `${shown} shown`).toBe(
        max,
      );
    }
  });

  test("with two or three classes after the edge, the room kept is the plural count line's, to the character", () => {
    // The same five long classes, then two or three short ones. The fifth fits exactly when the
    // block plus `(N more change classes not shown)` is 30,000: one character more and it is left
    // out. A count line two characters short (the singular word) would let it through and pass
    // the bound.
    const pairs = (k: number, side: string, lengths: readonly number[]) =>
      lengths.map((length, i) => ({ v: `${side}${k}-${i}-${"w".repeat(length)}` }));
    const slot = 280;
    const grown = (grow: number): number[] =>
      Array.from({ length: 12 }, (_, i) => Math.max(0, Math.min(slot, grow - i * slot)));
    const block = (grow: number, trailing: number) => {
      const before: Record<string, unknown> = { k4: pairs(4, "old", Array(12).fill(0)) };
      const after: Record<string, unknown> = { k4: pairs(4, "new", grown(grow)) };
      for (let t = 0; t < trailing; t++) {
        before[`small${t}`] = "a";
        after[`small${t}`] = "b";
      }
      for (let k = 0; k < 4; k++) {
        before[`k${k}`] = pairs(k, "old", Array(12).fill(260));
        after[`k${k}`] = pairs(k, "new", Array(12).fill(260));
      }
      return rendered([
        { path: "x.json", before: JSON.stringify(before), after: JSON.stringify(after) },
      ]);
    };
    const base = block(0, 0).text.length;
    const max = SUMMARY_LIMITS.maxSummaryChars;
    for (const trailing of [2, 3]) {
      const count = `(${trailing} more change classes not shown)`;
      const edge = max - 1 - count.length - base;
      for (let grow = edge - 20; grow <= edge + 20; grow++) {
        const { text, shown, cut } = block(grow, trailing);
        expect(text.length, `${trailing} after, grow ${grow}`).toBeLessThanOrEqual(max);
        expect(shown.size, `${trailing} after, grow ${grow}`).toBe(grow <= edge ? 5 : 4);
        expect(cut).toBe(grow <= edge ? trailing : trailing + 1);
        if (grow === edge) {
          expect(text.length).toBe(max);
          expect(text.endsWith(`\n${count}`)).toBe(true);
        }
      }
    }
  });

  test("a first class too large to fit leaves the block with the count alone", () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({ v: `${i}${"\u{200B}".repeat(299)}` }));
    const bigBefore = { a: pairs, b: pairs, c: pairs, d: pairs, e: pairs, f: pairs };
    const shifted = (k: number) =>
      Array.from({ length: 12 }, (_, i) => ({ v: `${i + k}${"\u{200C}".repeat(299)}` }));
    const bigAfter = {
      a: shifted(100),
      b: shifted(200),
      c: shifted(300),
      d: shifted(400),
      e: shifted(500),
      f: shifted(600),
    };
    // One class: `.a[*].v`... six of them; each line escapes 299 characters to 10 each.
    const { text, shown, cut } = rendered([
      { path: "x.json", before: JSON.stringify(bigBefore), after: JSON.stringify(bigAfter) },
    ]);
    expect(shown.size).toBe(0);
    expect(cut).toBe(6);
    expect(text).toBe("(6 more change classes not shown)");
  });
});

describe("renderClasses: completeness by kind (design section 5.3)", () => {
  test("a rule class is complete when its line is shown, however many items it holds", () => {
    const rows = Array.from({ length: 500 }, (_, i) => [`A${i}`, "EEG", "uV"]);
    const { complete, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...rows),
        after: tsv(CHANNELS, ...rows.map(([n, t, u]) => [`POL ${n}`, t as string, u as string])),
      },
    ]);
    expect(classes.map((c) => `${c.kind} ${c.items}`)).toEqual(["key_relabeled 500"]);
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(true);
  });

  test("a relocation whose target path is cut is incomplete: the reader cannot see where the rows went", () => {
    const path = channels(1);
    const far = `sourcedata/${"d".repeat(290)}/${path}`;
    const near = `sourcedata/old/${channels(2)}`;
    const { complete, classes, accounted } = account(
      [
        {
          path,
          before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        },
        {
          path: channels(2),
          before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        },
      ],
      {
        pool: [
          pooled(far, null, tsv(CHANNELS, ["R1", "EEG", "uV"])),
          pooled(near, null, tsv(CHANNELS, ["R1", "EEG", "uV"])),
        ],
      },
    );
    expect(classes.map((c) => c.kind)).toEqual(["row_relocated", "row_relocated"]);
    expect(classes.filter((c) => complete.has(c.key)).map((c) => c.detail)).toEqual([
      "sourcedata/old/sub-*/eeg/sub-*_task-*_channels.tsv",
    ]);
    expect([...accounted]).toEqual([channels(2)]);
  });

  test("a class whose line was cut is incomplete, whatever its kind: a long column name, a long path", () => {
    const longColumn = "c".repeat(301);
    const longDir = "d".repeat(301);
    const { complete, shown, classes } = rendered([
      {
        path: channels(1),
        before: tsv(["name", longColumn, "units"], ["A1", "1", "uV"]),
        after: tsv(["name", "units"], ["A1", "uV"]),
      },
      {
        path: `${longDir}/sub-01_channels.tsv`,
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "EEG", "uV"]),
      },
    ]);
    expect(classes.map((c) => c.kind).sort()).toEqual(["column_removed", "key_relabeled"]);
    // Both were rendered (a class that never rendered is not complete either): they were cut.
    expect(shown.size).toBe(2);
    expect(complete.size).toBe(0);
  });

  describe("a cut in any one token of the class line leaves the class incomplete, whichever token it is", () => {
    /**
     * Nested keys whose JSON path (`.k0xx.k1xx...`) is exactly `length` code units, each key 5 to
     * 60 long: a path past the 300 of a cut that stays far under the 1,024 a name may have.
     */
    const keysOfPath = (length: number): string[] => {
      const count = Math.ceil(length / 61);
      return Array.from({ length: count }, (_, i) => {
        const size = Math.floor(length / count) + (i < length % count ? 1 : 0);
        return `k${i}`.padEnd(size - 1, "x");
      });
    };
    const pathOf = (keys: readonly string[]): string => keys.map((key) => `.${key}`).join("");
    /** `{k0: {k1: ... inner}}`, the innermost key last. */
    const nested = (keys: readonly string[], inner: unknown): unknown =>
      keys.reduceRight((value, key) => ({ [key]: value }), inner);
    const summaryOf = (before: unknown, after: unknown): ChangeSummary =>
      summarize([candidate("x.json", JSON.stringify(before), JSON.stringify(after))]);

    /** The one class a file made, its line, and the line the facts table has for it. */
    const lineOf = (summary: ChangeSummary, kind: ClassKind) => {
      expect(summary.classes.map((c) => c.kind)).toEqual([kind]);
      return {
        line: summary.text.split("\n")[0] as string,
        fact: summary.facts.classes[0] as string,
        accounted: summary.accounted.size,
      };
    };

    test("a rename's names: the pair 'old -> new' is cut at 300 code points", () => {
      // The detail is `old -> new`, so names of 148 make it exactly 300 and 149 make it 302.
      for (const [size, whole] of [
        [148, true],
        [149, false],
        [310, false],
      ] as const) {
        const upper = "K".repeat(size);
        const { line, fact, accounted } = lineOf(
          summaryOf({ [upper]: 1 }, { [upper.toLowerCase()]: 1 }),
          "json_key_renamed",
        );
        expect(line.includes('"...(cut)'), `${size} line ${line.length}`).toBe(!whole);
        expect(fact, `${size}`).toBe(
          `C1 keys renamed | 1 item in 1 file | ${whole ? "in full" : "not shown in full"}`,
        );
        expect(accounted, `${size}`).toBe(whole ? 1 : 0);
      }
    });

    test("a value's leaf path: the 'key' token is cut at 300 code units", () => {
      for (const [length, whole] of [
        [300, true],
        [301, false],
        [310, false],
      ] as const) {
        const keys = keysOfPath(length);
        expect(pathOf(keys).length).toBe(length);
        const { line, fact, accounted } = lineOf(
          summaryOf(nested(keys, "go"), nested(keys, "stop")),
          "json_value_changed",
        );
        expect(line.includes('"...(cut)'), `${length}`).toBe(!whole);
        expect(line.startsWith('C1 | "x.json" | key "'), `${length}`).toBe(true);
        expect(fact, `${length}`).toBe(
          `C1 values changed | 1 item in 1 file | ${whole ? "in full" : "not shown in full"}`,
        );
        expect(accounted, `${length}`).toBe(whole ? 1 : 0);
      }
    });

    test("a key kind's parent path: the 'under' token is cut at 300 code units", () => {
      for (const [length, whole] of [
        [300, true],
        [301, false],
        [310, false],
      ] as const) {
        const keys = keysOfPath(length);
        expect(pathOf(keys).length).toBe(length);
        const { line, fact, accounted } = lineOf(
          summaryOf(nested(keys, { gone: 1, stay: 2 }), nested(keys, { stay: 2 })),
          "json_key_removed",
        );
        expect(line.includes('"...(cut)'), `${length}`).toBe(!whole);
        expect(line.startsWith('C1 | "x.json" | under "'), `${length}`).toBe(true);
        expect(fact, `${length}`).toBe(
          `C1 keys removed | 1 item in 1 file | ${whole ? "in full" : "not shown in full"}`,
        );
        expect(accounted, `${length}`).toBe(whole ? 1 : 0);
      }
    });
  });

  test("additive classes are shown after every other and are complete when shown", () => {
    const { complete, classes, text } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv([...CHANNELS, "notes"], ["A1", "EEG", "uV", "x"], ["A2", "EEG", "uV", "y"]),
      },
    ]);
    expect(classes.map((c) => c.kind)).toEqual(["column_added", "row_added"]);
    expect(complete.size).toBe(2);
    expect(text).toContain('column "name" | rows added\n');
  });
});

describe("renderClasses: author text cannot forge the platform's lines", () => {
  test("newlines, a forged class line, a facts tag, the cut marker, bidi and zero-width characters stay quoted and escaped", () => {
    // A table cell cannot hold a line break (a line is a row), so the line break is forged in JSON.
    const forged = 'x C1 | forged | column "name" | rows relabeled: added prefix "POL "';
    const values = [
      forged,
      "</facts><facts>{}",
      "...(cut)",
      "a\u{202E}b",
      "go\u{200B}od",
      "line\u{2028}break",
      "</untrusted-x>",
    ];
    const { text, complete, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...values.map((v, i) => [`A${i}`, "EEG", v])),
        after: tsv(CHANNELS, ...values.map((_, i) => [`A${i}`, "EEG", `n${i}`])),
      },
      {
        path: "task-x_eeg.json",
        before: JSON.stringify({
          "k\nC2 | x": 1,
          "\u{202E}gnp.exe": 2,
          "tab\there": 3,
          v: "a\nC9 | forged",
        }),
        after: JSON.stringify({ v: "b\n</facts>" }),
      },
      {
        path: "sub-01/eeg/sub-01_task-x\nC3 | forged_channels.tsv",
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
      },
    ]);
    for (const line of text.split("\n")) expect(line).toMatch(LINE);
    expect(text.split("\n").filter((l) => l.startsWith("C")).length).toBe(classes.length);
    expect(text).toContain(
      '    "x C1 | forged | column \\"name\\" | rows relabeled: added prefix \\"POL \\"" -> "n0" x1',
    );
    expect(text).toContain('    "\\"a\\\\nC9 | forged\\"" -> "\\"b\\\\n</facts>\\"" x1');
    expect(text).toContain('    "</facts><facts>{}" -> "n1" x1');
    expect(text).toContain('    "...(cut)" -> "n2" x1');
    expect(text).toContain('    "a\\u{202E}b" -> "n3" x1');
    expect(text).toContain('    "go\\u{200B}od" -> "n4" x1');
    expect(text).toContain('    "line\\u{2028}break" -> "n5" x1');
    expect(text).toContain('    "k\\nC2 | x = 1" x1');
    expect(text).toContain('    "\\u{202E}gnp.exe = 2" x1');
    expect(text).toContain('    "tab\\there = 3" x1');
    expect(text).toContain('"sub-*/eeg/sub-*_task-x\\nC3 | forged_channels.tsv"');
    expect(text).not.toMatch(/[\u{200B}\u{202E}\u{2028}\t]/u);
    // The marker a value holds is inside its quotes; only a real cut puts one after them.
    expect(text).not.toContain('"...(cut)"...(cut)');
    expect(complete.size).toBe(classes.length);
  });

  test("format, private-use and unassigned characters that are not default-ignorable are escaped too, never shown raw", () => {
    // The Arabic number sign, the Arabic pound mark above, an interlinear annotation anchor and
    // the Kaithi number sign are format characters (\p{Cf}) that Unicode does NOT make
    // default-ignorable, so only the category itself keeps them out of the block; a private-use
    // character (\p{Co}) and a noncharacter (\p{Cn}, unassigned for good) are in the same case.
    const chars = ["\u{600}", "\u{890}", "\u{FFF9}", "\u{110BD}", "\u{E000}", "\u{FFFE}"];
    for (const ch of chars) {
      expect(/^[\p{Cf}\p{Co}\p{Cn}]$/u.test(ch), ch.codePointAt(0)?.toString(16)).toBe(true);
      expect(/^\p{Default_Ignorable_Code_Point}$/u.test(ch), ch.codePointAt(0)?.toString(16)).toBe(
        false,
      );
    }
    const { text, complete, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...chars.map((ch, i) => [`A${i}`, "EEG", `a${ch}b`])),
        after: tsv(CHANNELS, ...chars.map((_, i) => [`A${i}`, "EEG", `n${i}`])),
      },
    ]);
    for (const [i, ch] of chars.entries()) {
      const hex = (ch.codePointAt(0) as number).toString(16).toUpperCase();
      expect(text, hex).toContain(`    "a\\u{${hex}}b" -> "n${i}" x1\n`);
      expect(text.includes(ch), `${hex} raw`).toBe(false);
    }
    expect(complete.size).toBe(classes.length);
  });

  test("a rule's added text is escaped like a value: a zero-width prefix and its spelled-out escape are two classes that read differently", () => {
    const { text, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["B1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["\u{FEFF}A1", "EEG", "uV"], ["\\u{FEFF}B1", "EEG", "uV"]),
      },
    ]);
    const lines = text.split("\n").filter((l) => l.startsWith("C"));
    expect(classes.length).toBe(2);
    expect(lines).toEqual([
      'C1 | "sub-*/eeg/sub-*_task-*_channels.tsv" | column "name" | rows relabeled: added prefix "\\\\u{FEFF}"',
      'C2 | "sub-*/eeg/sub-*_task-*_channels.tsv" | column "name" | rows relabeled: added prefix "\\u{FEFF}"',
    ]);
  });

  /** A class line read by the grammar: its number, its shape as one quoted token, and the rest. */
  const classLine = (line: string) => {
    const head = /^C([0-9]+) \| /.exec(line);
    if (head === null) return null;
    const shape = readQuoted(line, head[0].length);
    if (shape === null) return null;
    return { shape: shape.value, cut: shape.cut, rest: line.slice(shape.end) };
  };

  test("a path that reads like a class line is one quoted token: it adds no field and no line", () => {
    const forged = 'sub-01/x | column "name" | rows added | y_channels.tsv';
    const { text } = rendered([
      {
        path: forged,
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
      },
    ]);
    const lines = text.split("\n");
    for (const line of lines) expect(line).toMatch(LINE);
    expect(lines[0]).toBe(
      'C1 | "sub-*/x | column \\"name\\" | rows added | y_channels.tsv" | column "units" | cells replaced',
    );
    const read = classLine(lines[0] as string);
    expect(read?.shape).toBe(entityPattern(forged));
    expect(read?.rest).toBe(' | column "units" | cells replaced');
    expect(lines[2]).toBe(
      '    e.g. "sub-01/x | column \\"name\\" | rows added | y_channels.tsv" "uV" -> "mV"',
    );
  });

  test("a relocation target that holds a line break and a forged class line stays one quoted token", () => {
    const path = channels(1);
    const where = `sourcedata/evil\nC9 | forged | rows added/${path}`;
    const { text, classes, complete } = rendered(
      [
        {
          path,
          before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        },
      ],
      [pooled(where, null, tsv(CHANNELS, ["R1", "EEG", "uV"]))],
    );
    expect(classes.map((c) => c.kind)).toEqual(["row_relocated"]);
    const lines = text.split("\n");
    for (const line of lines) expect(line).toMatch(LINE);
    expect(lines.filter((l) => l.startsWith("C")).length).toBe(1);
    const read = classLine(lines[0] as string);
    const target =
      ' | column "name" | rows removed and found verbatim in a row this pull request adds: to ';
    expect(read?.rest.startsWith(target)).toBe(true);
    const to = readQuoted(read?.rest ?? "", target.length);
    expect(to?.value).toBe(entityPattern(where));
    expect((read?.rest.length ?? 0) - (to?.end ?? 0)).toBe(0);
    expect(complete.size).toBe(1);
  });

  test("a relocation target of 300 code points is shown whole; one of 301 is cut, and its class is incomplete", () => {
    const path = channels(1);
    for (const [length, whole] of [
      [300, true],
      [301, false],
    ] as const) {
      // The target is the shape of `sourcedata/<d..>/<path>`; a run of `d` is no entity.
      const dirs = "d".repeat(length - "sourcedata//".length - entityPattern(path).length);
      const where = `sourcedata/${dirs}/${path}`;
      expect(entityPattern(where).length).toBe(length);
      const summary = summarize(
        [
          candidate(
            path,
            tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"]),
            tsv(CHANNELS, ["A1", "EEG", "uV"]),
          ),
        ],
        [pooled(where, null, tsv(CHANNELS, ["R1", "EEG", "uV"]))],
      );
      expect(summary.classes.map((c) => c.kind)).toEqual(["row_relocated"]);
      const line = summary.text.split("\n")[0] as string;
      const target = readQuoted(line, line.lastIndexOf(": to ") + ": to ".length);
      expect(target?.cut, `${length}`).toBe(!whole);
      expect(target?.value, `${length}`).toBe(entityPattern(where).slice(0, 300));
      expect(target?.end, `${length}`).toBe(line.length);
      expect(summary.complete.size, `${length}`).toBe(whole ? 1 : 0);
      expect(summary.accounted.size, `${length}`).toBe(whole ? 1 : 0);
    }
  });

  test("invisible characters in a path are escaped, in the shape, the target and the examples", () => {
    const odd = "\u{3164}\u{2800}\u{34F}\u{A0}";
    const path = `sub-01/eeg${odd}/sub-01_task-x_channels.tsv`;
    const { text } = rendered(
      [
        {
          path,
          before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        },
      ],
      [pooled(`sourcedata/kept${odd}/${path}`, null, tsv(CHANNELS, ["R1", "EEG", "uV"]))],
    );
    const escaped = "\\u{3164}\\u{2800}\\u{34F}\\u{A0}";
    expect(text).toBe(
      [
        `C1 | "sub-*/eeg${escaped}/sub-*_task-*_channels.tsv" | column "name" | rows removed and found verbatim in a row this pull request adds: to "sourcedata/kept${escaped}/sub-*/eeg${escaped}/sub-*_task-*_channels.tsv"`,
        `    e.g. "sub-01/eeg${escaped}/sub-01_task-x_channels.tsv" row "R1"`,
      ].join("\n"),
    );
    for (const ch of odd) expect(text.includes(ch), ch.codePointAt(0)?.toString(16)).toBe(false);
  });

  test("a cut in the second example's path alone makes the class incomplete, and accounts for nothing", () => {
    // Two files of one shape: the first example's path is short, the second's is over 300.
    const long = "L".repeat(150);
    const short = "sub-01/eeg/sub-01_task-x_channels.tsv";
    const longPath = `sub-${long}/eeg/sub-${long}_task-x_channels.tsv`;
    expect(entityPattern(longPath)).toBe(entityPattern(short));
    const before = tsv(["name", "type"], ["Fp1", "EEG"], ["Fp2", "EEG"]);
    const after = tsv(["name", "type"], ["Fp1", "EOG"], ["Fp2", "EEG"]);
    const summary = summarize([
      candidate(short, before, after),
      candidate(longPath, before, after),
    ]);
    expect(summary.classes.map((c) => `${c.kind} ${c.files.size}`)).toEqual(["cell_replaced 2"]);
    const examples = summary.text.split("\n").filter((l) => l.startsWith("    e.g. "));
    expect(examples.length).toBe(2);
    expect(readQuoted(examples[0] as string, "    e.g. ".length)?.cut).toBe(false);
    expect(readQuoted(examples[1] as string, "    e.g. ".length)?.cut).toBe(true);
    expect(summary.classes[0]?.examplePathCut).toBe(true);
    expect(summary.complete.size).toBe(0);
    expect(summary.facts.classes).toEqual([
      "C1 cells replaced | 2 items in 2 files | not shown in full",
    ]);
    expect(summary.accounted.size).toBe(0);
  });

  test("a path of 300 code points is shown whole; one of 301 is cut, and its class is incomplete", () => {
    // `sub-<id>/eeg/sub-01_task-x_channels.tsv` is 35 characters and the id; its shape stays short.
    const at = (length: number) => `sub-${"1".repeat(length - 35)}/eeg/sub-01_task-x_channels.tsv`;
    for (const [length, whole] of [
      [300, true],
      [301, false],
    ] as const) {
      const path = at(length);
      expect(path.length).toBe(length);
      const summary = summarize([
        candidate(path, tsv(CHANNELS, ["A1", "EEG", "uV"]), tsv(CHANNELS, ["A1", "EEG", "mV"])),
      ]);
      const example = summary.text.split("\n")[2] as string;
      const token = readQuoted(example, "    e.g. ".length);
      expect(token?.cut, `${length}`).toBe(!whole);
      expect(token?.value, `${length}`).toBe(path.slice(0, 300));
      expect(summary.complete.size, `${length}`).toBe(whole ? 1 : 0);
      expect(summary.accounted.size, `${length}`).toBe(whole ? 1 : 0);
      expect(summary.facts.classes[0]?.endsWith(whole ? "| in full" : "| not shown in full")).toBe(
        true,
      );
    }
    // The shape at the same bound (a relocation target's is tested above, with its own path).
    for (const [length, whole] of [
      [300, true],
      [301, false],
    ] as const) {
      // A directory that is no entity: the shape is the path itself.
      const fit = `${"d".repeat(length - "/x_channels.tsv".length)}/x_channels.tsv`;
      expect(fit.length).toBe(length);
      const { complete, text } = rendered([
        {
          path: fit,
          before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
        },
      ]);
      // The shape token of the class line itself is cut at the same place as the example's path.
      const shape = readQuoted(text, "C1 | ".length);
      expect(shape?.cut, `shape ${length}`).toBe(!whole);
      expect(shape?.value, `shape ${length}`).toBe(fit.slice(0, 300));
      expect(complete.size, `shape ${length}`).toBe(whole ? 1 : 0);
    }
  });

  test("a cut shape leaves its class incomplete by itself, with no example path to share the cut", () => {
    // Through `classify` a shape is never longer than the path of an example (an entity value
    // becomes one `*`), so a cut shape always comes with a cut example. `renderClasses` holds the
    // shape to the rule on its own: the same real class, with its examples taken away.
    for (const [length, whole] of [
      [300, true],
      [301, false],
    ] as const) {
      const path = `${"d".repeat(length - "/x_channels.tsv".length)}/x_channels.tsv`;
      const [cls] = classify(
        atomsOf([
          {
            path,
            before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
            after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
          },
        ]),
      );
      const bare: ChangeClass = { ...(cls as ChangeClass), examples: [], examplePathCut: false };
      const { text, complete } = renderClasses([bare]);
      expect(readQuoted(text, "C1 | ".length)?.cut, `${length}`).toBe(!whole);
      expect(complete.size, `${length}`).toBe(whole ? 1 : 0);
    }
  });

  test("a cut never splits a surrogate pair: an astral character at the bound is kept or left out whole", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // Code points 299 and 300 are astral, then 301 and 302: the cut falls between two pairs.
    const base = "sub-01/eeg/";
    for (const astral of [299, 300, 301]) {
      const name = `${"a".repeat(astral - 1 - base.length)}\u{1F600}\u{1F600}_channels.tsv`;
      const path = `${base}${name}`;
      const { text } = rendered([
        {
          path,
          before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
        },
      ]);
      expect(lone.test(text), `${astral}`).toBe(false);
      const example = text.split("\n").find((l) => l.startsWith("    e.g. ")) as string;
      const token = readQuoted(example, "    e.g. ".length);
      expect(token?.cut).toBe(true);
      expect([...(token?.value ?? "")].length).toBe(300);
    }
  });
});

describe("renderClasses: pairs that may look alike are annotated with their first difference", () => {
  /** The pair line of one cell changed from `before` to `after`. */
  const pairLine = (before: string, after: string): string => {
    const { text } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", before]),
        after: tsv(CHANNELS, ["A1", "EEG", after]),
      },
    ]);
    return text.split("\n")[1] as string;
  };

  test("equal after NFC but not byte for byte", () => {
    expect(pairLine("\u{E9}", "e\u{301}")).toBe(
      '    "\u{E9}" -> "e\u{301}" x1 (first difference at character 1: U+00E9 to U+0065)',
    );
  });

  test("differing only in escaped characters: a zero-width space, a no-break space, a control character", () => {
    expect(pairLine("good", "go\u{200B}od")).toBe(
      '    "good" -> "go\\u{200B}od" x1 (first difference at character 3: U+006F to U+200B)',
    );
    expect(pairLine("a b", "a\u{A0}b")).toBe(
      '    "a b" -> "a\\u{A0}b" x1 (first difference at character 2: U+0020 to U+00A0)',
    );
    expect(pairLine("ab", "a\u{7}b")).toBe(
      '    "ab" -> "a\\u0007b" x1 (first difference at character 2: U+0062 to U+0007)',
    );
  });

  test("a look-alike from another script", () => {
    expect(pairLine("a", "\u{430}")).toBe(
      '    "a" -> "\u{430}" x1 (first difference at character 1: U+0061 to U+0430)',
    );
  });

  test("two values cut at the same place render alike, and the note says where they differ", () => {
    const stem = "s".repeat(300);
    expect(pairLine(`${stem}A`, `${stem}B`)).toBe(
      `    "${stem}"...(cut) -> "${stem}"...(cut) x1 (first difference at character 301: U+0041 to U+0042)`,
    );
  });

  // `differenceNote` keeps the design's NFC condition although the last one (a first difference
  // outside ASCII) covers it: two values equal after NFC cannot first differ at an ASCII character
  // on both sides. That was checked, not only argued, by a brute force in the phase 3 review over
  // 400,000 generated strings: 187 pairs were equal after NFC but not byte for byte, and in none of
  // them did the values first differ at ASCII on both sides (0 violations), so the NFC condition
  // annotates no pair the last one would not. Which condition annotates such a pair is therefore
  // not observable, and the tests here pin the pairs, not the branch.
  test("equal after NFC with both sides outside ASCII: the Angstrom sign and the letter A with a ring", () => {
    expect(pairLine("\u{212B}", "\u{C5}")).toBe(
      '    "\u{212B}" -> "\u{C5}" x1 (first difference at character 1: U+212B to U+00C5)',
    );
  });

  test("an ordinary change gets no note", () => {
    expect(pairLine("uV", "mV")).toBe('    "uV" -> "mV" x1');
    expect(pairLine("1", "10")).toBe('    "1" -> "10" x1');
  });

  test("JSON values are compared as their canonical text", () => {
    const { text } = rendered([
      { path: "x.json", before: '{"a": "x y"}', after: '{"a": "x\\u00a0y"}' },
    ]);
    expect(text.split("\n")[1]).toBe(
      '    "\\"x y\\"" -> "\\"x\\u{A0}y\\"" x1 (first difference at character 3: U+0020 to U+00A0)',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Coverage, loss facts and the facts block
// ---------------------------------------------------------------------------------------------

/** The outcome of a file that parsed and diffed: its class keys. */
function outcomesOf(files: readonly FileAtoms[]): FileOutcome[] {
  return files.map((f) => ({
    path: f.path,
    family: f.path.endsWith(".tsv") ? "tsv" : "json",
    refusal: null,
    keyColumn: null,
    classKeys: new Set(f.atoms.map((a) => classKeyOf(f.path, a).key)),
  }));
}

/** Classify, render and account for some files, with optional refused outcomes beside them. */
function account(
  files: readonly { path: string; before: string; after: string }[],
  options: {
    pool?: readonly PoolFile[];
    refused?: readonly FileOutcome[];
  } = {},
) {
  const atoms = atomsOf(files, options.pool ?? []);
  const classes = classify(atoms);
  const r = renderClasses(classes);
  const outcomes = [...outcomesOf(atoms), ...(options.refused ?? [])];
  return {
    atoms,
    classes,
    outcomes,
    ...r,
    accounted: accountedFiles(outcomes, classes, r.complete),
  };
}

/** One channel table at sub-0n whose listed columns change from 1 to 2. */
function changedColumns(n: number, columns: readonly string[]) {
  return {
    path: channels(n),
    before: tsv(["name", ...columns], ["A1", ...columns.map(() => "1")]),
    after: tsv(["name", ...columns], ["A1", ...columns.map(() => "2")]),
  };
}

const COLUMNS_120 = Array.from({ length: 120 }, (_, i) => `c${String(i).padStart(3, "0")}`);

describe("accountedFiles: a file is accounted for only when every non-additive class of it was shown completely", () => {
  test("a file whose classes were all shown completely is accounted for, and so is a file with no atom", () => {
    const { accounted } = account([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["B1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "EEG", "uV"], ["B1", "EEG", "mV"]),
      },
      { path: "x.json", before: '{"a": 1}', after: '{ "a" : 1 }' },
    ]);
    expect([...accounted].sort()).toEqual([channels(1), "x.json"]);
  });

  test("additive classes are never needed: a file whose only class was cut is still accounted for when that class is additive", () => {
    const { accounted, cut, classes, shown } = account([
      changedColumns(1, COLUMNS_120),
      {
        path: channels(2),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
      },
    ]);
    expect(cut).toBe(1);
    const left = classes.find((c) => !shown.has(c.key));
    expect(left?.kind).toBe("row_added");
    expect([...accounted].sort()).toEqual([channels(1), channels(2)]);
  });

  test("a modification class left out leaves its file unaccounted for", () => {
    const { accounted, cut } = account([
      changedColumns(1, COLUMNS_120),
      changedColumns(2, ["c999"]),
    ]);
    expect(cut).toBe(1);
    expect([...accounted]).toEqual([channels(1)]);
  });

  test("a loss class left out leaves its file unaccounted for", () => {
    const removing = (n: number, columns: readonly string[]) => ({
      path: channels(n),
      before: tsv(["name", ...columns], ["A1", ...columns.map(() => "1")]),
      after: tsv(["name"], ["A1"]),
    });
    const { accounted, cut, classes, shown } = account([
      removing(1, COLUMNS_120),
      removing(2, ["c999"]),
    ]);
    expect(cut).toBe(1);
    expect(classes.find((c) => !shown.has(c.key))?.kind).toBe("column_removed");
    expect([...accounted]).toEqual([channels(1)]);
  });

  test("a class with pairs not shown leaves EVERY file it is in unaccounted for", () => {
    const units = (n: number, from: number) => ({
      path: channels(n),
      before: tsv(CHANNELS, ...Array.from({ length: 7 }, (_, i) => [`A${i}`, "EEG", "uV"])),
      after: tsv(
        CHANNELS,
        ...Array.from({ length: 7 }, (_, i) => [`A${i}`, "EEG", `v${from + i}`]),
      ),
    });
    const { accounted } = account([
      units(1, 0),
      units(2, 100),
      {
        path: channels(3),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EOG", "uV"]),
      },
    ]);
    expect([...accounted]).toEqual([channels(3)]);
  });

  test("a value cut at 300 characters leaves its file unaccounted for, a removal's as much as a pair's", () => {
    const { accounted } = account([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "u".repeat(301)]),
        after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
      },
      {
        path: "sub-01/eeg/sub-01_task-x_events.tsv",
        before: tsv(["onset", "note"], ["1", "ok"], ["2", "n".repeat(301)]),
        after: tsv(["onset", "note"], ["1", "ok"]),
      },
      {
        path: channels(2),
        before: tsv(CHANNELS, ["A1", "EEG", "u".repeat(300)]),
        after: tsv(CHANNELS, ["A1", "EOG", "u".repeat(300)]),
      },
    ]);
    expect([...accounted]).toEqual([channels(2)]);
  });

  test("a rule class of any size is enough, when its line is shown", () => {
    const rows = Array.from({ length: 400 }, (_, i) => [`A${i}`, "EEG", "uV"]);
    const { accounted } = account([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...rows),
        after: tsv(
          CHANNELS,
          ...[...rows].reverse().map(([a, b, c]) => [`POL ${a}`, b as string, c as string]),
        ),
      },
    ]);
    expect([...accounted]).toEqual([channels(1)]);
  });

  // An abandoned pass accounts for nothing; that is summarizeChanges's to decide, and the deadline
  // tests below prove it with an injected clock.
  test("a refused file accounts for nothing", () => {
    const refused: FileOutcome = {
      path: channels(3),
      family: "tsv",
      refusal: "ragged_row",
      keyColumn: null,
      classKeys: new Set(),
    };
    const files = [
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
      },
    ];
    expect([...account(files, { refused: [refused] }).accounted]).toEqual([channels(1)]);
  });

  test("a refusal is never accounted for, even when its class keys would all be complete", () => {
    const { outcomes, classes, complete } = account([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
      },
    ]);
    const withRefusal = outcomes.map((o) => ({ ...o, refusal: "internal_mismatch" as const }));
    expect(accountedFiles(withRefusal, classes, complete).size).toBe(0);
  });

  test("a class the function does not know, or a path listed twice with different fates, accounts for nothing", () => {
    const { outcomes, classes, complete } = account([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
      },
    ]);
    const unknown = outcomes.map((o) => ({ ...o, classKeys: new Set([...o.classKeys, "[]"]) }));
    expect(accountedFiles(unknown, classes, complete).size).toBe(0);
    const twice = [
      ...outcomes,
      {
        ...(outcomes[0] as FileOutcome),
        refusal: "too_large" as const,
        classKeys: new Set<string>(),
      },
    ];
    expect(accountedFiles(twice, classes, complete).size).toBe(0);
  });
});

describe("lossFactsOf: the loss and relocation facts of every summarized file", () => {
  const sidecar = "task-x_eeg.json";
  const run = () =>
    atomsOf(
      [
        {
          path: channels(2),
          before: tsv(
            [...CHANNELS, "notes", "empty"],
            ["A1", "EEG", "uV", "bad", "n/a"],
            ["A2", "EEG", "uV", "ok", ""],
            ["A3", "EEG", "uV", "ok", "n/a"],
            ["R1", "EEG", "uV", "ok", "n/a"],
          ),
          after: tsv(CHANNELS, ["A1", "EEG", "n/a"]),
        },
        {
          path: channels(1),
          before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        },
        {
          path: "sub-01/eeg/sub-01_task-x_eeg.json",
          before: '{"PowerLineFrequency": 50, "Notes": "x", "More": [1], "Empty": "", "Ref": "Cz"}',
          after: '{"Ref": ""}',
        },
      ],
      [
        pooled(
          `sourcedata/old/${channels(2)}`,
          null,
          tsv([...CHANNELS, "notes", "empty"], ["R1", "EEG", "uV", "ok", "n/a"]),
        ),
        pooled(sidecar, null, '{"PowerLineFrequency": 50}'),
      ],
    );

  test("each count is its own kind, and a file counts once toward the files", () => {
    expect(lossFactsOf(run())).toEqual({
      rowsRemoved: 3,
      rowsRemovedFiles: 2,
      rowsRelocated: 1,
      // `notes` held values; `empty` held only n/a and empty cells, which is no loss.
      columnsRemoved: 1,
      keysRemoved: 2,
      keysRemovedFiles: 1,
      keysMoved: 1,
      // A cell (`uV` to `n/a`) and a JSON value (`Cz` to "").
      valuesEmptied: 2,
      firstBlockingPath: channels(1),
    });
  });

  test("the first blocking path is the first in code-unit order, whatever order the files came in", () => {
    const files = run();
    expect(lossFactsOf([...files].reverse()).firstBlockingPath).toBe(channels(1));
  });

  test("an additive or relocated atom, an empty removed column or an emptied value does not block", () => {
    const files = atomsOf([
      {
        path: "a.tsv",
        before: tsv(["x", "y"], ["1", "n/a"]),
        after: tsv(["x"], ["1"], ["2"]),
      },
      {
        path: "b.json",
        before: '{"a": "x", "b": null}',
        after: '{"a": "", "c": 1}',
      },
      {
        path: "c.tsv",
        before: tsv(["x"], ["1"], ["2"]),
        after: tsv(["x"], ["1"]),
      },
    ]);
    const facts = lossFactsOf(files);
    expect(facts.firstBlockingPath).toBe("c.tsv");
    expect(facts.columnsRemoved).toBe(0);
    expect(facts.valuesEmptied).toBe(1);
    expect(lossFactsOf(files.slice(0, 2))).toEqual({ ...NO_LOSS, valuesEmptied: 1 });
  });

  test("a removed column held nothing only when its count is exactly 0: a missing or unreadable count is a loss", () => {
    const removed = (detail: string | null): Atom => ({
      kind: "column_removed",
      field: "notes",
      rule: null,
      detail,
      before: null,
      after: null,
    });
    const facts = (detail: string | null) =>
      lossFactsOf([{ path: "a.tsv", atoms: [removed(detail)] }]);
    for (const detail of [null, "", " ", "abc", "1", "00"]) {
      expect(facts(detail).columnsRemoved, JSON.stringify(detail)).toBe(1);
      expect(facts(detail).firstBlockingPath, JSON.stringify(detail)).toBe("a.tsv");
    }
    expect(facts("0")).toEqual(NO_LOSS);
  });

  test("relocated and moved content is counted apart from what was lost", () => {
    const facts = lossFactsOf(run());
    expect([facts.rowsRelocated, facts.keysMoved]).toEqual([1, 1]);
  });
});

describe("the facts block: numbers and the class table, the platform's words only", () => {
  test("one line per shown class, numbered as the block numbers them, with its completeness", () => {
    const { classes, shown, complete } = account([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...Array.from({ length: 13 }, (_, i) => [`A${i}`, "EEG", "uV"])),
        after: tsv(
          CHANNELS,
          ...Array.from({ length: 13 }, (_, i) => [`POL A${i}`, "EEG", `v${i}`]),
          ["NEW", "EEG", "uV"],
        ),
      },
    ]);
    expect(classTable(classes, shown, complete)).toEqual([
      "C1 cells replaced | 13 items in 1 file | not shown in full",
      "C2 rows relabeled | 13 items in 1 file | in full",
      "C3 rows added | 1 item in 1 file | in full",
    ]);
  });

  test("only a SHOWN class has a line: the classes the 120 bound leaves out are in no table", () => {
    const columns = [...COLUMNS_120, "c120"];
    const { classes, shown, complete, cut } = account([changedColumns(1, columns)]);
    expect(classes.length).toBe(121);
    expect(cut).toBe(1);
    const table = classTable(classes, shown, complete);
    expect(table.length).toBe(SUMMARY_LIMITS.maxClasses);
    expect(table[0]).toBe("C1 cells replaced | 1 item in 1 file | in full");
    expect(table.at(-1)).toBe("C120 cells replaced | 1 item in 1 file | in full");
    expect(table.some((line) => line.startsWith("C121 "))).toBe(false);
    // The facts of a whole summary are the same table, and count the class that was left out.
    const summary = summarize([
      candidate(
        channels(1),
        tsv(["name", ...columns], ["A1", ...columns.map(() => "1")]),
        tsv(["name", ...columns], ["A1", ...columns.map(() => "2")]),
      ),
    ]);
    expect(summary.facts.classes).toEqual(table);
    expect(summary.facts.classes_shown).toBe(120);
    expect(summary.facts.classes_cut).toBe(1);
  });

  test("the numbers come from the outcomes, the accounted files, the render and the loss facts", () => {
    const a = account([changedColumns(1, COLUMNS_120), changedColumns(2, ["c999"])], {
      refused: [
        {
          path: "z.tsv",
          family: "tsv",
          refusal: "ragged_row",
          keyColumn: null,
          classKeys: new Set(),
        },
      ],
    });
    const loss = lossFactsOf(a.atoms);
    expect(
      summaryFacts({
        abandoned: false,
        outcomes: a.outcomes,
        accounted: a.accounted,
        shown: a.shown.size,
        cut: a.cut,
        loss,
      }),
    ).toEqual({
      abandoned: false,
      files_summarized: 2,
      files_not_summarized: 1,
      files_accounted_for: 1,
      classes_shown: 120,
      classes_cut: 1,
      rows_removed_not_found_elsewhere: 0,
      rows_removed_found_verbatim_in_sourcedata: 0,
      columns_with_values_removed: 0,
      keys_removed_not_found_elsewhere: 0,
      keys_moved_to_an_inherited_sidecar: 0,
      values_emptied: 0,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// summarizeChanges: a pull request's candidates, end to end
// ---------------------------------------------------------------------------------------------

const candidate = (path: string, before: string, after: string): SummaryCandidate => ({
  path,
  before: enc(before),
  after: enc(after),
});

const summarize = (
  candidates: readonly SummaryCandidate[],
  pool: readonly PoolFile[] = [],
): ChangeSummary => summarizeChanges({ candidates, pool, deadline: null });

const refusals = (summary: ChangeSummary): string[] =>
  summary.files.map((f) => `${f.path} ${f.refusal ?? "ok"}`);

describe("summarizeChanges: one outcome per candidate, in path order", () => {
  test("a refusal is recorded on its file and accounts for nothing; other extensions are left out", () => {
    const summary = summarize([
      candidate("z.tsv", tsv(["a"], ["1"]), tsv(["a"], ["2"])),
      candidate("README.md", "a", "b"),
      candidate("a.json", '{"a": 1}', '{"a": 2}'),
      candidate("m.tsv", "a\tb\n1\n", tsv(["a", "b"], ["1", "2"])),
      candidate("b.json", '{"a": 1}', '{"a": 1, "a": 2}'),
      candidate("c.tsv.gz", "x", "y"),
      { path: "d.tsv", before: new Uint8Array([0x61, 0x0a, 0xff, 0x0a]), after: enc("a\n1\n") },
    ]);
    expect(refusals(summary)).toEqual([
      "a.json ok",
      "b.json duplicate_key",
      "d.tsv invalid_utf8",
      "m.tsv ragged_row",
      "z.tsv ok",
    ]);
    expect([...summary.accounted]).toEqual(["a.json", "z.tsv"]);
    expect(summary.facts.files_summarized).toBe(2);
    expect(summary.facts.files_not_summarized).toBe(3);
    expect(summary.files.find((f) => f.path === "b.json")?.classKeys.size).toBe(0);
  });

  test("the before side's refusal is the one recorded, and a table's key column is kept", () => {
    const summary = summarize([
      candidate("x.tsv", '"q"\n', "a\tb\n1\n"),
      candidate(
        channels(1),
        tsv(CHANNELS, ["A1", "EEG", "uV"]),
        tsv(CHANNELS, ["A1", "EEG", "mV"]),
      ),
    ]);
    expect(refusals(summary)).toEqual([`${channels(1)} ok`, "x.tsv quoted_cell"]);
    expect(summary.files[0]?.keyColumn).toBe("name");
    expect(summary.files[0]?.family).toBe("tsv");
  });

  test("a path given twice is refused every time it appears, and takes nothing from the pool", () => {
    const path = channels(1);
    const before = tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"]);
    const after = tsv(CHANNELS, ["A1", "EEG", "uV"]);
    const summary = summarize(
      [candidate(path, before, after), candidate(path, before, after)],
      [pooled(`sourcedata/old/${path}`, null, tsv(CHANNELS, ["R1", "EEG", "uV"]))],
    );
    expect(refusals(summary)).toEqual([`${path} internal_mismatch`, `${path} internal_mismatch`]);
    expect(summary.accounted.size).toBe(0);
    expect(summary.loss).toEqual(NO_LOSS);
  });

  test("a diff its totality check rejects is internal_mismatch: no class, no loss fact, not accounted", () => {
    const input = {
      candidates: [
        candidate(
          channels(1),
          tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
          tsv(CHANNELS, ["A1", "EEG", "uV"]),
        ),
        candidate("task-x_eeg.json", '{"a": 1, "b": 2}', '{"a": 1}'),
      ],
      pool: [],
      deadline: null,
    };
    const failingTable = summarizeChangesWith(input, {
      table: () => false,
      json: verifyJsonCounts,
    });
    expect(refusals(failingTable)).toEqual([
      `${channels(1)} internal_mismatch`,
      "task-x_eeg.json ok",
    ]);
    expect(failingTable.loss.rowsRemoved).toBe(0);
    expect(failingTable.loss.keysRemoved).toBe(1);
    expect([...failingTable.accounted]).toEqual(["task-x_eeg.json"]);
    expect(failingTable.classes.map((c) => c.kind)).toEqual(["json_key_removed"]);

    const failingJson = summarizeChangesWith(input, {
      table: verifyTableCounts,
      json: () => false,
    });
    expect(refusals(failingJson)).toEqual([
      `${channels(1)} ok`,
      "task-x_eeg.json internal_mismatch",
    ]);
    expect(failingJson.loss.keysRemoved).toBe(0);
    expect([...failingJson.accounted]).toEqual([channels(1)]);

    // The real checks pass both, and summarizeChanges is summarizeChangesWith over them.
    const real = summarizeChanges(input);
    expect(refusals(real)).toEqual([`${channels(1)} ok`, "task-x_eeg.json ok"]);
    expect(real.text).toBe(
      summarizeChangesWith(input, { table: verifyTableCounts, json: verifyJsonCounts }).text,
    );
  });

  test("a column name, a JSON key or a JSON path over 1,024 code units refuses its file too_large; at 1,024 it is summarized", () => {
    const max = SUMMARY_LIMITS.maxNameChars;
    const column = (n: number) =>
      candidate(
        `c${n}.tsv`,
        tsv(["a", "n".repeat(n)], ["1", "x"]),
        tsv(["a", "n".repeat(n)], ["1", "y"]),
      );
    const key = (n: number) =>
      candidate(`k${n}.json`, `{"${"k".repeat(n)}":1}`, `{"${"k".repeat(n)}":2}`);
    // A deep path made of short keys: 64 levels of 16, the last key setting the length.
    const deep = (last: number) => {
      const keys = Array.from({ length: 63 }, (_, i) => `k${String(i).padStart(14, "0")}`);
      keys.push("z".repeat(last));
      const doc = (v: number) => `${keys.map((k) => `{"${k}":`).join("")}${v}${"}".repeat(64)}`;
      return candidate(`d${last}.json`, doc(1), doc(2));
    };
    // A key of 1,024 parses (the parser's own test), but at the top level its path is `.` and the
    // key, 1,025 units, so the path refuses it; 1,023 is the longest top-level key summarized.
    const summary = summarize([
      column(max),
      column(max + 1),
      key(max - 1),
      key(max),
      key(max + 1),
      deep(15),
      deep(16),
    ]);
    expect(refusals(summary)).toEqual([
      `c${max}.tsv ok`,
      `c${max + 1}.tsv too_large`,
      "d15.json ok",
      "d16.json too_large",
      `k${max - 1}.json ok`,
      `k${max}.json too_large`,
      `k${max + 1}.json too_large`,
    ]);
    // What is summarized carries its name whole; its class line is cut at 300 characters, so it
    // is shown but not accounted for.
    const fields = summary.classes.map((c) => c.field?.length);
    expect(fields.sort()).toEqual([max, max, max]);
    expect(summary.accounted.size).toBe(0);
    expect(summary.classes.length).toBe(3);
  });

  test("once the bytes read would pass maxTotalBytes, that file and every later one is refused too_large", () => {
    // One buffer for both sides of the large file: half the cap plus one byte each.
    const half = new Uint8Array(SUMMARY_LIMITS.maxTotalBytes / 2 + 1);
    const small = (path: string) => candidate(path, tsv(["a"], ["1"]), tsv(["a"], ["2"]));
    const summary = summarize([
      small("a.tsv"),
      { path: "b.tsv", before: half, after: half },
      small("c.tsv"),
      small("d.tsv"),
    ]);
    expect(refusals(summary)).toEqual([
      "a.tsv ok",
      "b.tsv too_large",
      "c.tsv too_large",
      "d.tsv too_large",
    ]);
    expect([...summary.accounted]).toEqual(["a.tsv"]);
  });
});

describe("summarizeChanges: the total bytes read are capped exactly", () => {
  // Both sides of a file are one zero-filled buffer, which a table refuses `nul_byte` at its first
  // byte: a file the budget admits shows that word, and one it does not shows `too_large`.
  const side = new Uint8Array(SUMMARY_LIMITS.maxBlobBytes / 2);
  const file = (path: string): SummaryCandidate => ({ path, before: side, after: side });
  const cap = SUMMARY_LIMITS.maxTotalBytes;
  const files = Array.from({ length: cap / (2 * side.length) }, (_, i) =>
    file(`f${String(i).padStart(2, "0")}.tsv`),
  );

  test("a total of exactly maxTotalBytes is read in full", () => {
    expect(files.reduce((sum, f) => sum + f.before.length + f.after.length, 0)).toBe(cap);
    expect(refusals(summarize(files))).toEqual(files.map((f) => `${f.path} nul_byte`));
  });

  test("one byte more refuses that file and every later one too_large, however small", () => {
    const summary = summarize([
      ...files,
      { path: "g.tsv", before: new Uint8Array(1), after: new Uint8Array(0) },
      candidate("h.tsv", tsv(["a"], ["1"]), tsv(["a"], ["2"])),
      candidate("i.json", '{"a": 1}', '{"a": 2}'),
    ]);
    expect(refusals(summary)).toEqual([
      ...files.map((f) => `${f.path} nul_byte`),
      "g.tsv too_large",
      "h.tsv too_large",
      "i.json too_large",
    ]);
    expect(summary.accounted.size).toBe(0);
  });
});

describe("summarizeChanges: the deadline abandons the whole summary", () => {
  const files = () => [
    candidate(
      channels(1),
      tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
      tsv(CHANNELS, ["A1", "EEG", "uV"]),
    ),
    candidate(channels(2), tsv(CHANNELS, ["A1", "EEG", "uV"]), tsv(CHANNELS, ["A1", "EEG", "mV"])),
    candidate(channels(3), tsv(CHANNELS, ["A1", "EEG", "uV"]), tsv(CHANNELS, ["A1", "EOG", "uV"])),
  ];

  const abandonedShape = (summary: ChangeSummary) => {
    expect(summary.abandoned).toBe(true);
    expect(summary.accounted.size).toBe(0);
    expect(summary.text).toBe("");
    expect(summary.classes).toEqual([]);
    expect(summary.files).toEqual([]);
    expect(summary.shown.size + summary.complete.size).toBe(0);
    expect(summary.loss).toEqual(NO_LOSS);
    expect(summary.facts).toEqual({
      ...EMPTY_SUMMARY.facts,
      abandoned: true,
    });
  };

  /** A clock that gives `times` in order, then the last one again, and counts its reads. */
  const clock = (times: readonly number[]) => {
    let reads = 0;
    return {
      now: () => times[Math.min(reads++, times.length - 1)] as number,
      reads: () => reads,
    };
  };

  test("reached at the check before a file: the run is abandoned there, loss facts included", () => {
    // Before the first file, after its fold, before the second.
    const c = clock([0, 0, 10]);
    const summary = summarizeChanges({ candidates: files(), pool: [], deadline: 10, now: c.now });
    expect(c.reads()).toBe(3);
    abandonedShape(summary);
  });

  test("reached at the check after a file's fold: the run is abandoned before the next file", () => {
    const c = clock([0, 10]);
    const summary = summarizeChanges({ candidates: files(), pool: [], deadline: 10, now: c.now });
    expect(c.reads()).toBe(2);
    abandonedShape(summary);
  });

  test("reached only at the check after the last file: the run is still abandoned, before rendering", () => {
    // Three files: before and after each, then the last check.
    const c = clock([0, 0, 0, 0, 0, 0, 10]);
    const summary = summarizeChanges({ candidates: files(), pool: [], deadline: 10, now: c.now });
    expect(c.reads()).toBe(7);
    abandonedShape(summary);
  });

  /**
   * Candidates that record when the summary first reads their bytes, and a clock that reads that
   * record: the deadline is reached only while `touched` holds `from` and not `until`. Only a check
   * made in that state can see it, whichever checks come before or after.
   */
  const watched = (
    specs: readonly { path: string; before: string; after: string }[],
    from: string,
    until: string | null,
  ) => {
    const touched = new Set<string>();
    const candidates: SummaryCandidate[] = specs.map((spec) => ({
      path: spec.path,
      get before() {
        touched.add(spec.path);
        return enc(spec.before);
      },
      after: enc(spec.after),
    }));
    const now = () => (touched.has(from) && (until === null || !touched.has(until)) ? 10 : 0);
    return summarizeChanges({ candidates, pool: [], deadline: 10, now });
  };
  const ragged = { path: "a.tsv", before: "a\tb\n1\n", after: "a\n" };
  const changed = (path: string) => ({
    path,
    before: tsv(["a"], ["1"]),
    after: tsv(["a"], ["2"]),
  });

  test("only the check before a file sees the time between a refused file and the next: it abandons", () => {
    // `a.tsv` is refused, so no fold and no check follow it; `b.tsv`'s bytes are read right after
    // the check before it. The deadline holds only between the two.
    abandonedShape(watched([ragged, changed("b.tsv")], "a.tsv", "b.tsv"));
    // Not vacuous: with the state never reached, nothing is abandoned.
    expect(watched([ragged, changed("b.tsv")], "c.tsv", null).abandoned).toBe(false);
  });

  test("only the check after the last file sees the time after a refused last file: it abandons", () => {
    // `z.tsv` is last and refused, so no fold follows it: only the check after the loop is made
    // once its bytes were read.
    abandonedShape(watched([changed("b.tsv"), { ...ragged, path: "z.tsv" }], "z.tsv", null));
  });

  // The check after a fold has no state of its own: nothing happens between it and the check that
  // comes next (before the next file, or after the loop), so no clock can trip it alone. The read
  // counts below are what pin it.

  test("a deadline already reached abandons before the first file", () => {
    const c = clock([5]);
    abandonedShape(summarizeChanges({ candidates: files(), pool: [], deadline: 5, now: c.now }));
    expect(c.reads()).toBe(1);
  });

  test("a deadline never reached, or none, changes nothing; the clock is read twice per file and once after", () => {
    const c = clock([9]);
    const timed = summarizeChanges({ candidates: files(), pool: [], deadline: 10, now: c.now });
    expect(c.reads()).toBe(7);
    const untimed = clock([1e12]);
    const free = summarizeChanges({
      candidates: files(),
      pool: [],
      deadline: null,
      now: untimed.now,
    });
    expect(untimed.reads()).toBe(0);
    for (const summary of [timed, free]) {
      expect(summary.abandoned).toBe(false);
      expect(summary.accounted.size).toBe(3);
      expect(summary.loss.rowsRemoved).toBe(1);
    }
    expect(timed.text).toBe(free.text);
    // A refused file is not folded, so it is read for once, before it.
    const refused = clock([9]);
    summarizeChanges({
      candidates: [...files(), candidate("broken.tsv", "a\tb\n1\n", "a\n")],
      pool: [],
      deadline: 10,
      now: refused.now,
    });
    expect(refused.reads()).toBe(8);
  });

  test("the empty summary is not abandoned and holds nothing", () => {
    expect(EMPTY_SUMMARY.abandoned).toBe(false);
    expect(EMPTY_SUMMARY.text).toBe("");
    expect(EMPTY_SUMMARY.facts).toEqual({
      abandoned: false,
      files_summarized: 0,
      files_not_summarized: 0,
      files_accounted_for: 0,
      classes_shown: 0,
      classes_cut: 0,
      rows_removed_not_found_elsewhere: 0,
      rows_removed_found_verbatim_in_sourcedata: 0,
      columns_with_values_removed: 0,
      keys_removed_not_found_elsewhere: 0,
      keys_moved_to_an_inherited_sidecar: 0,
      values_emptied: 0,
      classes: [],
    });
    expect(summarize([]).facts).toEqual(EMPTY_SUMMARY.facts);
  });

  test("the empty summary is one shared object, so it is frozen: a caller cannot change it for the next", () => {
    for (const summary of [
      EMPTY_SUMMARY,
      summarizeChanges({ candidates: files(), pool: [], deadline: 0, now: () => 0 }),
    ]) {
      expect(Object.isFrozen(summary)).toBe(true);
      expect(Object.isFrozen(summary.facts)).toBe(true);
      expect(Object.isFrozen(summary.facts.classes)).toBe(true);
      expect(Object.isFrozen(summary.loss)).toBe(true);
      expect(Object.isFrozen(summary.files)).toBe(true);
      expect(Object.isFrozen(summary.classes)).toBe(true);
    }
    expect(() => {
      (EMPTY_SUMMARY.facts.classes as string[]).push("C1 forged");
    }).toThrow();
    expect(() => {
      (EMPTY_SUMMARY as { text: string }).text = "forged";
    }).toThrow();
    expect(EMPTY_SUMMARY.facts.classes).toEqual([]);
    expect(EMPTY_SUMMARY.text).toBe("");
  });

  test("the empty summary's sets cannot be filled through a cast; a run's own summary keeps ordinary sets", () => {
    for (const set of [EMPTY_SUMMARY.shown, EMPTY_SUMMARY.complete, EMPTY_SUMMARY.accounted]) {
      const writable = set as Set<string>;
      expect(() => writable.add("sub-01/x.tsv")).toThrow();
      expect(() => writable.delete("sub-01/x.tsv")).toThrow();
      expect(() => writable.clear()).toThrow();
      expect(set.size).toBe(0);
      expect(set.has("sub-01/x.tsv")).toBe(false);
    }
    expect([...EMPTY_SUMMARY.accounted]).toEqual([]);
    // An abandoned summary is made for its run alone: nothing is shared, so nothing refuses.
    const abandoned = summarizeChanges({
      candidates: files(),
      pool: [],
      deadline: 0,
      now: () => 0,
    });
    (abandoned.accounted as Set<string>).add("sub-01/x.tsv");
    expect(abandoned.accounted.size).toBe(1);
    expect(EMPTY_SUMMARY.accounted.size).toBe(0);
  });
});

describe("summarizeChanges: a change of magnitude is never a rule class", () => {
  test("1 000 Hz to 1 0 Hz is shown as its pair, beside two real repads that stay a rule", () => {
    const header = ["name", "type", "units", "high_cutoff"];
    const summary = summarize(
      [1, 2, 3].map((n) =>
        candidate(
          channels(n),
          tsv(header, ["Cz", "EEG", "uV", n === 3 ? "1 000 Hz" : "0100 Hz"]),
          tsv(header, ["Cz", "EEG", "uV", n === 3 ? "1 0 Hz" : "100 Hz"]),
        ),
      ),
    );
    expect(summary.classes.map((c) => `${c.kind} ${c.items}/${c.files.size}`)).toEqual([
      "cell_templated 2/2",
      "cell_replaced 1/1",
    ]);
    expect(summary.text).toContain('\n    "1 000 Hz" -> "1 0 Hz" x1\n');
    const third = summary.files.find((f) => f.path === channels(3)) as FileOutcome;
    const kinds = summary.classes.filter((c) => third.classKeys.has(c.key)).map((c) => c.kind);
    expect(kinds).toEqual(["cell_replaced"]);
    for (const kind of kinds) expect(DISPLAY_OF[kind]).toBe("pairs");
  });
});

describe("summarizeChanges: a decimal mark in the added text is never a padding", () => {
  test("every number written with a mark outside the allowlist is shown as its pair, beside 80 real repads that stay a rule", () => {
    // Sixteen ways to hide a tenfold change behind "zero padding changed", eight in each column,
    // each in a row of its own among 40 rows whose padding really changed.
    const hidden: (readonly [string, string])[] = [
      ["\u{66B}05 Hz", "\u{66B}5 Hz"],
      ["\u{FF0E}05 Hz", "\u{FF0E}5 Hz"],
      ["05 Hz", "\u{FF0E}5 Hz"],
      ["005", "\u{B7}5"],
      ["05 Hz", ".\u{2060}5 Hz"],
      ["05 Hz", ".\u{200B}5 Hz"],
      ["05 Hz", ".\u{AD}5 Hz"],
      ["05 Hz", ". 5 Hz"],
      ["0\u{A78F}05 Hz", "0\u{A78F}5 Hz"],
      ["1\u{2BC}000 Hz", "1\u{2BC}0000 Hz"],
      ["1\u{2CC}000", "1\u{2CC}0000"],
      ["res-0p05mm", "res-0p5mm"],
      ["1e05", "1e5"],
      ["1x000 Hz", "1x0000 Hz"],
      ["1E0100", "1E100"],
      ["05 Hz", ".\u{301}5 Hz"],
    ];
    const header = ["name", "low_cutoff", "high_cutoff"];
    const before: string[][] = [];
    const after: string[][] = [];
    for (let i = 0; i < 40; i++) {
      before.push([`E${i}`, `00${(i % 9) + 1} Hz`, `0${(i % 9) + 1}00 Hz`]);
      after.push([`E${i}`, `${(i % 9) + 1} Hz`, `${(i % 9) + 1}00 Hz`]);
    }
    for (const [i, [b, a]] of hidden.entries()) {
      const low = i < 8;
      before.push([`H${i}`, low ? b : "1 Hz", low ? "300 Hz" : b]);
      after.push([`H${i}`, low ? a : "1 Hz", low ? "300 Hz" : a]);
    }
    const summary = summarize([
      candidate(channels(1), tsv(header, ...before), tsv(header, ...after)),
    ]);
    expect(summary.classes.map((c) => `${c.kind} ${c.field} ${c.items}`).sort()).toEqual([
      "cell_replaced high_cutoff 8",
      "cell_replaced low_cutoff 8",
      "cell_templated high_cutoff 40",
      "cell_templated low_cutoff 40",
    ]);
    for (const [b, a] of hidden) {
      const line = `\n    ${renderValue(b).text} -> ${renderValue(a).text} x1`;
      expect(summary.text.includes(line), line).toBe(true);
    }
    // Every class shown in full: the file is accounted for, and nothing in it reads as padding.
    expect(summary.facts.classes.every((line) => line.endsWith("| in full"))).toBe(true);
    expect([...summary.accounted]).toEqual([channels(1)]);
  });

  test("05 Hz to .5 Hz is a pair shown in full, and A05 to A.5 is a removed and an added row", () => {
    const header = ["name", "type", "units", "high_cutoff"];
    const summary = summarize([
      candidate(
        channels(1),
        tsv(header, ["Cz", "EEG", "uV", "05 Hz"]),
        tsv(header, ["Cz", "EEG", "uV", ".5 Hz"]),
      ),
      candidate(
        channels(2),
        tsv(header, ["A05", "EEG", "uV", "1 Hz"]),
        tsv(header, ["A.5", "EEG", "uV", "1 Hz"]),
      ),
      // Beside them, a real padding in both places keeps its rule.
      candidate(
        channels(3),
        tsv(header, ["A05", "EEG", "uV", "0100 Hz"]),
        tsv(header, ["A5", "EEG", "uV", "100 Hz"]),
      ),
    ]);
    const kindsOf = (path: string) => {
      const keys = (summary.files.find((f) => f.path === path) as FileOutcome).classKeys;
      return summary.classes
        .filter((c) => keys.has(c.key))
        .map((c) => c.kind)
        .sort();
    };
    expect(kindsOf(channels(1))).toEqual(["cell_replaced"]);
    expect(kindsOf(channels(2))).toEqual(["row_added", "row_removed"]);
    expect(kindsOf(channels(3))).toEqual(["cell_templated", "key_relabeled"]);
    expect(summary.text).toContain('\n    "05 Hz" -> ".5 Hz" x1\n');
    expect(summary.text).toContain('\n    "A05" x1\n');
    expect(summary.loss.rowsRemoved).toBe(1);
    expect(summary.loss.firstBlockingPath).toBe(channels(2));
  });
});

describe("summarizeChanges: a file that would pass maxTrackedClasses is refused, and the run goes on", () => {
  /** A channel table at sub-0n whose listed columns all change: one class per column. */
  const columnsChanged = (n: number, columns: readonly string[]) =>
    candidate(
      channels(n),
      tsv(["name", ...columns], ["A1", ...columns.map(() => "1")]),
      tsv(["name", ...columns], ["A1", ...columns.map(() => "2")]),
    );
  const named = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => `c${String(from + i).padStart(5, "0")}`);
  /** A small file after the large ones in path order, with one class of its own. */
  const later = candidate(
    "zz.tsv",
    tsv(["onset", "trial_type"], ["1", "go"]),
    tsv(["onset", "trial_type"], ["1", "stop"]),
  );

  test("5,000 distinct classes in one file are summarized", () => {
    const max = SUMMARY_LIMITS.maxTrackedClasses;
    const kept = summarize([columnsChanged(1, named(max))]);
    expect(kept.abandoned).toBe(false);
    expect(refusals(kept)).toEqual([`${channels(1)} ok`]);
    expect(kept.classes.length).toBe(max);
    expect(kept.facts.classes_shown + kept.facts.classes_cut).toBe(max);
  });

  test("5,001 in one file refuse that file too_large: nothing of it is kept, and a later small file is summarized and accounted for", () => {
    const max = SUMMARY_LIMITS.maxTrackedClasses;
    const summary = summarize([
      columnsChanged(1, named(max + 1)),
      later,
      // A removal in the refused file would be a loss fact if any of it were kept.
      candidate(
        channels(2),
        tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
        tsv(CHANNELS, ["A1", "EEG", "uV"]),
      ),
    ]);
    expect(summary.abandoned).toBe(false);
    expect(refusals(summary)).toEqual([
      `${channels(1)} too_large`,
      `${channels(2)} ok`,
      "zz.tsv ok",
    ]);
    expect(summary.files[0]?.classKeys.size).toBe(0);
    expect(summary.classes.map((c) => c.kind).sort()).toEqual(["cell_replaced", "row_removed"]);
    expect([...summary.accounted].sort()).toEqual([channels(2), "zz.tsv"]);
    expect(summary.loss.rowsRemoved).toBe(1);
    expect(summary.facts.files_not_summarized).toBe(1);
  });

  test("two files that pass the bound together: the second in path order is refused, the first kept whole", () => {
    const max = SUMMARY_LIMITS.maxTrackedClasses;
    const first = columnsChanged(1, named(max - 10));
    const second = columnsChanged(2, named(20, max));
    const summary = summarize([second, first, later]);
    expect(refusals(summary)).toEqual([
      `${channels(1)} ok`,
      `${channels(2)} too_large`,
      "zz.tsv ok",
    ]);
    // The first file's classes and the later file's one: 4,991. The second file added none.
    expect(summary.classes.length).toBe(max - 9);
    expect(summary.classes.every((c) => !c.files.has(channels(2)))).toBe(true);
    // Its classes shared with the first file would not have counted: one that adds no class fits.
    const shared = columnsChanged(2, named(20));
    const both = summarize([first, shared]);
    expect(refusals(both)).toEqual([`${channels(1)} ok`, `${channels(2)} ok`]);
  });

  test("which file is refused depends on path order alone: shuffled candidates give the same summary", () => {
    const max = SUMMARY_LIMITS.maxTrackedClasses;
    const candidates = [
      columnsChanged(1, named(max - 10)),
      columnsChanged(2, named(20, max)),
      columnsChanged(3, named(5, 2 * max)),
      later,
    ];
    const reference = summarize(candidates);
    const random = seeded(51);
    for (let trial = 0; trial < 5; trial++) {
      const shuffled = candidates
        .map((c) => [random(), c] as const)
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => c);
      const again = summarize(shuffled);
      expect(refusals(again)).toEqual(refusals(reference));
      expect(again.classes.map((c) => c.key)).toEqual(reference.classes.map((c) => c.key));
      expect(again.text).toBe(reference.text);
      expect(again.facts).toEqual(reference.facts);
    }
    expect(refusals(reference)).toEqual([
      `${channels(1)} ok`,
      `${channels(2)} too_large`,
      `${channels(3)} ok`,
      "zz.tsv ok",
    ]);
  });

  test("a class in many files is one class: the bound counts classes, never atoms or files", () => {
    const max = SUMMARY_LIMITS.maxTrackedClasses;
    const summary = summarize([1, 2, 3].map((n) => columnsChanged(n, named(max))));
    expect(summary.abandoned).toBe(false);
    expect(summary.classes.length).toBe(max);
    expect(summary.classes.every((c) => c.files.size === 3 && c.items === 3)).toBe(true);
  });
});

describe("summarizeChanges: layout and respelling", () => {
  const formatDetails = (summary: ChangeSummary) =>
    summary.classes.filter((c) => c.kind === "format").map((c) => `${c.detail} ${c.items}`);

  test("a table's layout changes come from its diff, once each", () => {
    const summary = summarize([
      candidate(
        channels(1),
        tsv(CHANNELS, ["A1", "EEG", "uV"]),
        `\u{FEFF}${tsv(CHANNELS, ["A1", "EEG", "uV"]).replaceAll("\n", "\r\n")}`,
      ),
    ]);
    expect(formatDetails(summary)).toEqual(["bom 1", "line_endings 1"]);
    expect([...summary.accounted]).toEqual([channels(1)]);
  });

  test("a JSON document's layout changes are atoms too: byte order mark, line endings, final newline", () => {
    const summary = summarize([candidate("x.json", '{"a": 1}', '\u{FEFF}{\r\n  "a": 1\r\n}\r\n')]);
    expect(formatDetails(summary)).toEqual(["bom 1", "final_newline 1", "line_endings 1"]);
    expect(summary.text).toContain("file layout changed: line endings changed");
  });

  test("equal trees whose text differs beyond whitespace are json_respelled, and shown", () => {
    const summary = summarize([candidate("x.json", '{"a": "A/b"}', '{"a":"\\u0041\\/b"}')]);
    expect(formatDetails(summary)).toEqual(["json_respelled 1"]);
    expect(summary.text).toBe(
      'C1 | "x.json" | file layout changed: same values, string escapes spelled differently\n    e.g. "x.json"',
    );
    expect([...summary.accounted]).toEqual(["x.json"]);
  });

  test("a reindent, a reorder or a changed value is not a respelling", () => {
    expect(formatDetails(summarize([candidate("x.json", '{"a":"A"}', '{ "a" : "A" }')]))).toEqual(
      [],
    );
    expect(
      formatDetails(summarize([candidate("x.json", '{"a":"A"}', '{\n  "a": "A"\n}\n')])),
    ).toEqual(["final_newline 1", "line_endings 1"]);
    const reordered = summarize([candidate("x.json", '{"a":1,"b":2}', '{"b":2,"a":1}')]);
    expect(reordered.classes.map((c) => c.kind)).toEqual(["json_keys_reordered"]);
    const changed = summarize([candidate("x.json", '{"a":"A","b":1}', '{"a":"\\u0041","b":2}')]);
    expect(changed.classes.map((c) => c.kind)).toEqual(["json_value_changed"]);
  });

  test("stripJsonSpace removes whitespace between tokens and keeps strings exactly", () => {
    expect(stripJsonSpace('{ "a b" :\t[ 1 ,\r\n "x\\" y\\\\" ] }')).toBe(
      '{"a b":[1,"x\\" y\\\\"]}',
    );
    expect(stripJsonSpace('"  "')).toBe('"  "');
    expect(stripJsonSpace(" 1 ")).toBe("1");
  });
});

describe("summarizeChanges: order, determinism and loss facts", () => {
  /** A mixed run: relabels, a relocation, removals, JSON keys, and a refused file. */
  const mixed = (): { candidates: SummaryCandidate[]; pool: PoolFile[] } => {
    const candidates = [1, 2, 3].map((n) =>
      candidate(
        channels(n),
        tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"], [`G${n}`, "EEG", "uV"]),
        tsv(CHANNELS, ["POL A1", "EEG", "mV"], ["NEW", "EEG", "uV"]),
      ),
    );
    candidates.push(
      candidate(
        "sub-01/eeg/sub-01_task-x_eeg.json",
        '{"PowerLineFrequency": 50, "Notes": "x"}',
        "{}",
      ),
      candidate("broken.tsv", "a\tb\n1\n", "a\n"),
    );
    const pool = [
      pooled(`sourcedata/old/${channels(1)}`, null, tsv(CHANNELS, ["R1", "EEG", "uV"])),
      pooled(`sourcedata/old/${channels(3)}`, null, tsv(CHANNELS, ["R1", "EEG", "uV"])),
      pooled("task-x_eeg.json", null, '{"PowerLineFrequency": 50}'),
    ];
    return { candidates, pool };
  };

  test("shuffled candidates and pool give the same outcomes, classes, text and facts", () => {
    const { candidates, pool } = mixed();
    const reference = summarize(candidates, pool);
    const random = seeded(7);
    for (let trial = 0; trial < 20; trial++) {
      const shuffle = <T>(items: readonly T[]): T[] =>
        items
          .map((item) => [random(), item] as const)
          .sort((a, b) => a[0] - b[0])
          .map(([, item]) => item);
      const again = summarize(shuffle(candidates), shuffle(pool));
      expect(again.text).toBe(reference.text);
      expect(again.classes.map((c) => c.key)).toEqual(reference.classes.map((c) => c.key));
      expect(again.files).toEqual(reference.files);
      expect(again.facts).toEqual(reference.facts);
      expect([...again.accounted]).toEqual([...reference.accounted]);
    }
  });

  test("a pool path listed twice relocates nothing, in either order, and the summaries are identical", () => {
    const path = channels(1);
    const where = `sourcedata/old/${path}`;
    const input = [
      candidate(
        path,
        tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"], ["R2", "EEG", "uV"]),
        tsv(CHANNELS, ["A1", "EEG", "uV"]),
      ),
    ];
    // Each copy holds one of the removed rows: with the first entry kept, the row relocated would
    // depend on which entry came first.
    const first = pooled(where, null, tsv(CHANNELS, ["R1", "EEG", "uV"]));
    const second = pooled(where, null, tsv(CHANNELS, ["R2", "EEG", "uV"]));
    const forward = summarize(input, [first, second]);
    const backward = summarize(input, [second, first]);
    for (const summary of [forward, backward]) {
      expect(summary.loss.rowsRemoved).toBe(2);
      expect(summary.loss.rowsRelocated).toBe(0);
      expect(summary.classes.map((c) => c.kind)).toEqual(["row_removed"]);
    }
    expect(backward.text).toBe(forward.text);
    expect(backward.facts).toEqual(forward.facts);
    expect(backward.loss).toEqual(forward.loss);
    expect(backward.files).toEqual(forward.files);
  });

  test("a nearer sidecar listed twice still stops a move past it: the key stays removed, in either order", () => {
    const path = "sub-01/eeg/sub-01_task-x_eeg.json";
    const input = [candidate(path, '{"SamplingFrequency": 500, "A": 1}', '{"A": 1}')];
    // The root sidecar gains the removed value; the subject sidecar, nearer, sets the key to 250.
    const root = pooled("task-x_eeg.json", "{}", '{"SamplingFrequency": 500}');
    const near = pooled("sub-01/sub-01_task-x_eeg.json", "{}", '{"SamplingFrequency": 250}');
    const once = summarize(input, [root, near]);
    expect(once.loss.keysRemoved).toBe(1);
    expect(once.loss.keysMoved).toBe(0);
    for (const pool of [
      [root, near, { ...near }],
      [near, { ...near }, root],
      [{ ...near }, root, near],
    ]) {
      const twice = summarize(input, pool);
      expect(twice.loss).toEqual(once.loss);
      expect(twice.classes.map((c) => c.kind)).toEqual(["json_key_removed"]);
      expect(twice.text).toBe(once.text);
    }
  });

  test("the loss facts count every summarized file, accounted or not, and never a refused one", () => {
    const { candidates, pool } = mixed();
    const summary = summarize(candidates, pool);
    // G1, G2 and G3 are removed everywhere; R1 has a copy for sub-01 and sub-03 only. The refused
    // `broken.tsv` counts for nothing.
    expect(summary.loss).toEqual({
      rowsRemoved: 4,
      rowsRemovedFiles: 3,
      rowsRelocated: 2,
      columnsRemoved: 0,
      keysRemoved: 1,
      keysRemovedFiles: 1,
      keysMoved: 1,
      valuesEmptied: 0,
      firstBlockingPath: channels(1),
    });
    expect(summary.files.find((f) => f.path === "broken.tsv")?.refusal).toBe("ragged_row");
    expect(summary.facts.rows_removed_not_found_elsewhere).toBe(4);
    expect(summary.facts.rows_removed_found_verbatim_in_sourcedata).toBe(2);
    expect(summary.facts.keys_moved_to_an_inherited_sidecar).toBe(1);

    // A removal whose class was left out is still a loss fact.
    const crowded = summarize([
      candidate(
        channels(1),
        tsv(["name", ...COLUMNS_120], ["A1", ...COLUMNS_120.map(() => "1")]),
        tsv(["name"], ["A1"]),
      ),
      candidate(
        channels(2),
        tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
        tsv(CHANNELS, ["A1", "EEG", "uV"]),
      ),
    ]);
    expect(crowded.facts.classes_cut).toBe(1);
    expect(crowded.accounted.has(channels(2))).toBe(false);
    expect(crowded.loss.rowsRemoved).toBe(1);
    expect(crowded.loss.columnsRemoved).toBe(120);
    expect(crowded.loss.firstBlockingPath).toBe(channels(1));
  });

  test("the facts' class table numbers the classes as the block does", () => {
    const { candidates, pool } = mixed();
    const summary = summarize(candidates, pool);
    const numbers = summary.text
      .split("\n")
      .filter((l) => /^C[0-9]+ \| /.test(l))
      .map((l) => l.slice(0, l.indexOf(" ")));
    expect(summary.facts.classes.map((l) => l.slice(0, l.indexOf(" ")))).toEqual(numbers);
    expect(summary.facts.classes_shown).toBe(numbers.length);
    for (const line of summary.facts.classes) {
      expect(line).toMatch(
        /^C[0-9]+ [a-z ]+ \| [0-9]+ items? in [0-9]+ files? \| (in full|not shown in full)$/,
      );
    }
  });
});

describe("code-unit order is the only order, never the locale's", () => {
  // Each pair is ordered one way by code units and the other by a locale's collation: an upper
  // case letter before a lower case one, `-` (45) before `_` (95), and a character outside the
  // basic plane (a surrogate pair, 0xD835 first) before a fullwidth one (0xFF01).
  const PAIRS = [
    ["B", "a"],
    ["-", "_"],
    ["\u{1D400}", "\uFF01"],
  ] as const;
  const changed = (path: string) => candidate(path, tsv(["a"], ["1"]), tsv(["a"], ["2"]));

  test("candidates are processed, and their outcomes listed, in code-unit order of their paths", () => {
    for (const [low, high] of PAIRS) {
      for (const order of [
        [low, high],
        [high, low],
      ]) {
        const summary = summarize(order.map((name) => changed(`${name}.tsv`)));
        expect(
          summary.files.map((f) => f.path),
          `${low} ${high}`,
        ).toEqual([`${low}.tsv`, `${high}.tsv`]);
      }
    }
  });

  test("the first examples of a class are those of the first files in code-unit order", () => {
    const at = (id: string) => `sub-${id}/eeg/sub-${id}_task-x_channels.tsv`;
    for (const order of [
      ["B1", "a1", "c1"],
      ["c1", "a1", "B1"],
    ]) {
      const summary = summarize(
        order.map((id) =>
          candidate(at(id), tsv(CHANNELS, ["A1", "EEG", "uV"]), tsv(CHANNELS, ["A1", "EEG", "mV"])),
        ),
      );
      // `B` (66) is before `a` (97) and `c` (99): the examples are B1 then a1.
      expect(summary.classes[0]?.examples).toEqual([
        `"${at("B1")}" "uV" -> "mV"`,
        `"${at("a1")}" "uV" -> "mV"`,
      ]);
    }
  });

  test("the pairs of equal count are listed in code-unit order of their text", () => {
    const afters = ["a", "B", "_", "-", "\u{1D400}", "\uFF01"];
    const { text } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...afters.map((_, i) => [`A${i}`, "EEG", "x"])),
        after: tsv(CHANNELS, ...afters.map((after, i) => [`A${i}`, "EEG", after])),
      },
    ]);
    const shown = text
      .split("\n")
      .filter((line) => line.startsWith('    "'))
      .map((line) => {
        const before = readQuoted(line, 4) as { end: number };
        return (readQuoted(line, before.end + 4) as { value: string }).value;
      });
    expect(shown).toEqual(["-", "B", "_", "a", "\u{1D400}", "\uFF01"]);
  });

  test("the first blocking path is the least in code-unit order, in either order of the files", () => {
    for (const [low, high] of PAIRS) {
      const removed = (name: string) => ({
        path: `${name}.tsv`,
        before: tsv(["x"], ["1"], ["2"]),
        after: tsv(["x"], ["1"]),
      });
      for (const order of [
        [low, high],
        [high, low],
      ]) {
        const facts = lossFactsOf(atomsOf(order.map(removed)));
        expect(facts.firstBlockingPath, `${low} ${high}`).toBe(`${low}.tsv`);
      }
    }
  });

  test("of two copies of a removed row, the one at the least path in code-unit order names the relocation", () => {
    const path = channels(1);
    for (const [low, high] of PAIRS) {
      for (const order of [
        [low, high],
        [high, low],
      ]) {
        const summary = summarize(
          [
            candidate(
              path,
              tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"]),
              tsv(CHANNELS, ["A1", "EEG", "uV"]),
            ),
          ],
          order.map((dir) =>
            pooled(`sourcedata/${dir}/${path}`, null, tsv(CHANNELS, ["R1", "EEG", "uV"])),
          ),
        );
        expect(
          summary.classes.map((c) => c.detail),
          `${low} ${high}`,
        ).toEqual([entityPattern(`sourcedata/${low}/${path}`)]);
      }
    }
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

/**
 * A pull request shaped like `nemarDatasets/on004551` #1 (design section 8.3): channel tables whose
 * names gain `POL `, some names wrapped in `EEG ` and `-Ref`, a few rows moved verbatim to
 * `sourcedata/channels-removed-2026-10-18/<same path>`, the kept rows reordered, and rows added.
 */
function on004551(
  files: number,
  rows: number,
): { candidates: SummaryCandidate[]; pool: PoolFile[] } {
  const header = ["name", "type", "units", "low_cutoff", "high_cutoff", "status"];
  const row = (name: string) => [name, "SEEG", "uV", "0.1", "300", "good"];
  const candidates: SummaryCandidate[] = [];
  const pool: PoolFile[] = [];
  for (let s = 1; s <= files; s++) {
    const sub = String(s).padStart(3, "0");
    const path = `sub-${sub}/ses-01/ieeg/sub-${sub}_ses-01_task-sleep_run-01_channels.tsv`;
    const relocated = s % 2 === 0 ? ["B13", "B14", "B15"] : [];
    const wrapped = s < files ? ["Fp1", "Fp2", "C3", "C4"] : [];
    const prefixed = Array.from(
      { length: rows - relocated.length - wrapped.length },
      (_, i) => `A${i + 1}`,
    );
    const before = [...prefixed, ...wrapped, ...relocated].map(row);
    const after = [
      ...[...wrapped].reverse().map((n) => row(`EEG ${n}-Ref`)),
      ...[...prefixed].reverse().map((n) => row(`POL ${n}`)),
      row("POL E"),
      row("POL DC"),
    ];
    candidates.push(candidate(path, tsv(header, ...before), tsv(header, ...after)));
    if (relocated.length > 0) {
      pool.push(
        pooled(
          `sourcedata/channels-removed-2026-10-18/${path}`,
          null,
          tsv(header, ...relocated.map(row)),
        ),
      );
    }
  }
  return { candidates, pool };
}

describe("summarizeChanges: a bulk relabel shaped like on004551 #1", () => {
  test("30 channel tables are five classes, every file is accounted for, and the text is short", () => {
    const { candidates, pool } = on004551(30, 40);
    const summary = summarize(candidates, pool);
    expect(summary.classes.map((c) => `${c.kind} ${c.items}/${c.files.size}`)).toEqual([
      "row_relocated 45/15",
      "key_relabeled 1039/30",
      "rows_reordered 30/30",
      "key_relabeled 116/29",
      "row_added 60/30",
    ]);
    expect(summary.facts.classes).toEqual([
      "C1 rows removed and found verbatim in a row this pull request adds | 45 items in 15 files | in full",
      "C2 rows relabeled | 1039 items in 30 files | in full",
      "C3 row order changed | 30 items in 30 files | in full",
      "C4 rows relabeled | 116 items in 29 files | in full",
      "C5 rows added | 60 items in 30 files | in full",
    ]);
    expect(summary.accounted.size).toBe(30);
    expect(summary.loss).toEqual({ ...NO_LOSS, rowsRelocated: 45 });
    expect(summary.text.length).toBeLessThan(10_000);
    const shape = '"sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv"';
    const target =
      '"sourcedata/channels-removed-2026-10-18/sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv"';
    expect(summary.text.split("\n").filter((l) => l.startsWith("C"))).toEqual([
      `C1 | ${shape} | column "name" | rows removed and found verbatim in a row this pull request adds: to ${target}`,
      `C2 | ${shape} | column "name" | rows relabeled: added prefix "POL "`,
      `C3 | ${shape} | row order changed`,
      `C4 | ${shape} | column "name" | rows relabeled: added prefix "EEG " and suffix "-Ref"`,
      `C5 | ${shape} | column "name" | rows added`,
    ]);
  });

  test("125 channel tables of 200 rows each are summarized in under 2 seconds", () => {
    const { candidates, pool } = on004551(125, 200);
    const started = performance.now();
    const summary = summarize(candidates, pool);
    const elapsed = performance.now() - started;
    expect(summary.accounted.size).toBe(125);
    expect(summary.classes.length).toBe(5);
    expect(elapsed).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------------------------
// The hidden-loss round-trip oracle
// ---------------------------------------------------------------------------------------------
//
// Written apart from the module's classify, render and coverage code. It diffs every generated
// candidate itself (with the Phase 1 and 2 parsers and diffs, whose own oracles live in
// `pr-review-change-model.unit.test.ts`), computes the class line each atom must appear under from
// its own copy of the rendering rules, then reads the RENDERED text back: every pair line is
// decoded to its raw values and count. A file the summary accounts for must have every non-additive
// atom recoverable from the text (its class line shown whole, and for a paired kind its exact pair,
// with the exact count, among the class's pairs, with no pair left unshown and no value cut), and a
// file whose atoms are all recoverable must be accounted for. Every rendered class's pairs must be
// exactly the atoms' pairs. Then one pair line is deleted, and the oracle must object.

const ORACLE_UNSEEN = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u{2800}]/gu;

/** A value as the text shows it when it is not cut: the oracle's own copy of the rule. */
function oracleQuote(v: string): string {
  return JSON.stringify(v).replace(ORACLE_UNSEEN, (ch) =>
    ch === " " ? ch : `\\u{${(ch.codePointAt(0) as number).toString(16).toUpperCase()}}`,
  );
}

const ORACLE_SIMPLE: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Read a quoted value back from `line` at `at`: its raw text, where it ends, and whether it was cut. */
function readQuoted(line: string, at: number): { value: string; end: number; cut: boolean } | null {
  if (line[at] !== '"') return null;
  let value = "";
  let i = at + 1;
  for (;;) {
    if (i >= line.length) return null;
    const c = line[i] as string;
    if (c === '"') {
      i++;
      break;
    }
    if (c !== "\\") {
      value += c;
      i++;
      continue;
    }
    const e = line[i + 1] as string;
    if (e === "u" && line[i + 2] === "{") {
      const close = line.indexOf("}", i + 3);
      if (close < 0) return null;
      value += String.fromCodePoint(Number.parseInt(line.slice(i + 3, close), 16));
      i = close + 1;
    } else if (e === "u") {
      value += String.fromCharCode(Number.parseInt(line.slice(i + 2, i + 6), 16));
      i += 6;
    } else {
      const simple = ORACLE_SIMPLE[e];
      if (simple === undefined) return null;
      value += simple;
      i += 2;
    }
  }
  const cut = line.startsWith("...(cut)", i);
  return { value, end: cut ? i + "...(cut)".length : i, cut };
}

const oracleShape = (path: string): string =>
  path.replace(/(^|[/_])([a-zA-Z]+)-[a-zA-Z0-9]+(?=[/_.])/g, "$1$2-*");

/** A JSON path with every index written [*], by its own tokenizer. */
function oracleFold(path: string): string {
  let out = "";
  let i = 0;
  while (i < path.length) {
    if (path.startsWith('["', i)) {
      let j = i + 2;
      while (path[j] !== '"') j += path[j] === "\\" ? 2 : 1;
      out += path.slice(i, j + 2);
      i = j + 2;
    } else if (path[i] === "[") {
      out += "[*]";
      i = path.indexOf("]", i) + 1;
    } else {
      out += path[i];
      i++;
    }
  }
  return out;
}

const ORACLE_FORMAT_WORDS: Readonly<Record<string, string>> = {
  bom: "byte order mark added or removed",
  line_endings: "line endings changed",
  line_ending_pattern: "which lines end in CRLF changed",
  final_newline: "final newline added or removed",
  json_respelled: "same values, string escapes spelled differently",
};
const ORACLE_VALUE_KINDS = new Set([
  "json_value_changed",
  "json_type_changed",
  "json_emptied",
  "json_filled",
]);

/** The class line, after `C<n> | `, that an atom of `path` must be shown under. */
function expectedHeader(path: string, atom: Atom): string {
  const parts = [oracleQuote(oracleShape(path))];
  if (atom.field !== null) {
    if (!atom.kind.startsWith("json_")) parts.push(`column ${oracleQuote(atom.field)}`);
    else {
      const f = oracleFold(atom.field);
      if (ORACLE_VALUE_KINDS.has(atom.kind)) {
        parts.push(f === "" ? "the whole document" : `key ${oracleQuote(f)}`);
      } else parts.push(f === "" ? "top level" : `under ${oracleQuote(f)}`);
    }
  }
  let rule: string | null = null;
  if ((atom.kind === "key_relabeled" || atom.kind === "cell_templated") && atom.rule !== null) {
    rule = ruleWords({
      ...atom.rule,
      gaps: atom.rule.gaps.map((g) => oracleQuote(g).slice(1, -1)),
    });
  } else if (atom.kind === "row_relocated") rule = `to ${oracleQuote(atom.detail ?? "")}`;
  else if (atom.kind === "json_key_renamed") rule = oracleQuote(atom.detail ?? "");
  else if (atom.kind === "format") rule = ORACLE_FORMAT_WORDS[atom.detail ?? ""] ?? "?";
  parts.push(rule === null ? KIND_WORDS[atom.kind] : `${KIND_WORDS[atom.kind]}: ${rule}`);
  return parts.join(" | ");
}

/** The pair an atom must be shown as: [before, after], after null for a removal; null for no pair. */
function expectedPair(atom: Atom): [string, string | null] | null {
  const display: ClassDisplay = DISPLAY_OF[atom.kind];
  if (display === "pairs") return [atom.before ?? "", atom.after ?? ""];
  if (display === "removals") {
    return [
      atom.kind === "row_removed" ? (atom.before ?? "") : `${atom.detail} = ${atom.before}`,
      null,
    ];
  }
  return null;
}

interface ShownPair {
  before: string;
  after: string | null;
  count: number;
  cut: boolean;
}
interface ShownBlock {
  n: number;
  header: string;
  pairs: ShownPair[];
  more: number;
  /** An example's path, its first token, was cut: the class line is then not whole. */
  exampleCut: boolean;
}

/** The text read back into class blocks, by the grammar of the fenced block alone. */
function readBack(text: string): { blocks: ShownBlock[]; trailing: number; errors: string[] } {
  const blocks: ShownBlock[] = [];
  const errors: string[] = [];
  let trailing = 0;
  if (text === "") return { blocks, trailing, errors };
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const head = /^C([0-9]+) \| (.*)$/.exec(line);
    if (head !== null) {
      blocks.push({
        n: Number(head[1]),
        header: head[2] as string,
        pairs: [],
        more: 0,
        exampleCut: false,
      });
      continue;
    }
    const tail = /^\(([0-9]+) more change class(?:es)? not shown\)$/.exec(line);
    if (tail !== null) {
      if (i !== lines.length - 1) errors.push("a count line that is not the last");
      trailing = Number(tail[1]);
      continue;
    }
    const block = blocks[blocks.length - 1];
    if (block === undefined || !line.startsWith("    ")) {
      errors.push(`a line no grammar allows: ${JSON.stringify(line)}`);
      continue;
    }
    if (line.startsWith("    e.g. ")) {
      // An example starts with its file's path, one quoted token.
      const where = readQuoted(line, "    e.g. ".length);
      if (where === null)
        errors.push(`an example whose path does not read: ${JSON.stringify(line)}`);
      else if (where.cut) block.exampleCut = true;
      continue;
    }
    const more = /^ {4}\(([0-9]+) more distinct values? not shown\)$/.exec(line);
    if (more !== null) {
      block.more = Number(more[1]);
      continue;
    }
    const b = readQuoted(line, 4);
    if (b === null) {
      errors.push(`a pair line that does not read: ${JSON.stringify(line)}`);
      continue;
    }
    let at = b.end;
    let after: string | null = null;
    let cut = b.cut;
    if (line.startsWith(" -> ", at)) {
      const a = readQuoted(line, at + 4);
      if (a === null) {
        errors.push(`a pair line whose after side does not read: ${JSON.stringify(line)}`);
        continue;
      }
      after = a.value;
      cut ||= a.cut;
      at = a.end;
    }
    const count =
      /^ x([0-9]+)(?: \(first difference at character [0-9]+: (?:U\+[0-9A-F]{4,6}|end) to (?:U\+[0-9A-F]{4,6}|end)\))?$/.exec(
        line.slice(at),
      );
    if (count === null) {
      errors.push(`a pair line with no count: ${JSON.stringify(line)}`);
      continue;
    }
    block.pairs.push({ before: b.value, after, count: Number(count[1]), cut });
  }
  return { blocks, trailing, errors };
}

/** JSON text with whitespace outside strings removed: the oracle's own, by a regular expression. */
const oracleStrip = (text: string): string =>
  text.replace(/("(?:[^"\\]|\\.)*")|[ \t\n\r]+/g, (_m, str: string | undefined) => str ?? "");

interface OracleCase {
  candidates: SummaryCandidate[];
  pool: PoolFile[];
}

/** The oracle's own reading of each candidate: its atoms, or null for a file it refuses. */
function oracleAtoms(c: OracleCase): Map<string, Atom[] | null> {
  const sorted = [...c.candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const times = new Map<string, number>();
  for (const f of sorted) times.set(f.path, (times.get(f.path) ?? 0) + 1);
  const pools = buildPools(
    [...c.pool].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  const out = new Map<string, Atom[] | null>();
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/^\u{FEFF}/u, "");
  for (const f of sorted) {
    if ((times.get(f.path) ?? 0) > 1) {
      out.set(f.path, null);
      continue;
    }
    if (f.path.endsWith(".tsv")) {
      const b = parseTsv(f.before);
      const a = b.ok ? parseTsv(f.after) : b;
      const d = b.ok && a.ok ? diffTable(f.path, b.value, a.value, pools.rows) : null;
      out.set(f.path, d?.ok ? d.value.atoms : null);
    } else if (f.path.endsWith(".json")) {
      const b = parseJson(f.before);
      const a = b.ok ? parseJson(f.after) : b;
      if (!b.ok || !a.ok) {
        out.set(f.path, null);
        continue;
      }
      const d = diffJson(f.path, b.value.value, a.value.value, pools.json);
      if (!d.ok) {
        out.set(f.path, null);
        continue;
      }
      const atoms = [...d.value.atoms, ...formatAtoms(b.value.format, a.value.format)];
      if (
        canonicalJson(b.value.value) === canonicalJson(a.value.value) &&
        oracleStrip(text(f.before)) !== oracleStrip(text(f.after))
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
      out.set(f.path, atoms);
    }
  }
  return out;
}

/** Everything the oracle finds wrong with a summary whose fenced block is `text`. */
function oracleViolations(c: OracleCase, summary: ChangeSummary, text: string): string[] {
  const out: string[] = [];
  const own = oracleAtoms(c);
  for (const f of summary.files) {
    if ((f.refusal === null) !== (own.get(f.path) != null)) {
      out.push(`${f.path}: the summary says ${f.refusal ?? "summarized"}, the oracle disagrees`);
    }
  }
  if (
    summary.files.length !== [...c.candidates].filter((f) => /\.(tsv|json)$/.test(f.path)).length
  ) {
    out.push("an outcome missing or extra");
  }

  // What each class line must hold: every pair of every summarized file's atoms under it.
  const expected = new Map<string, { kind: ClassKind; pairs: Map<string, number> }>();
  for (const [path, atoms] of own) {
    for (const atom of atoms ?? []) {
      const header = expectedHeader(path, atom);
      let entry = expected.get(header);
      if (entry === undefined) {
        entry = { kind: atom.kind, pairs: new Map() };
        expected.set(header, entry);
      }
      if (entry.kind !== atom.kind) out.push(`two kinds under one line: ${header}`);
      const pair = expectedPair(atom);
      if (pair !== null) {
        const id = JSON.stringify(pair);
        entry.pairs.set(id, (entry.pairs.get(id) ?? 0) + 1);
      }
    }
  }

  const read = readBack(text);
  out.push(...read.errors);
  if (text.length > SUMMARY_LIMITS.maxSummaryChars) out.push("the block is over its bound");
  // Nothing the platform escapes may be shown raw (control, format, separator, private-use,
  // unassigned and default-ignorable characters, the Braille blank); only the line breaks between
  // lines and U+0020 are the block's own. `search` ignores the global flag's lastIndex.
  if (text.replaceAll("\n", "").replaceAll(" ", "").search(ORACLE_UNSEEN) >= 0) {
    out.push("an invisible character is shown raw");
  }
  if (read.blocks.length > SUMMARY_LIMITS.maxClasses) out.push("more classes than the bound");
  if (read.trailing !== expected.size - read.blocks.length) {
    out.push(
      `the count line says ${read.trailing}, ${expected.size - read.blocks.length} were left out`,
    );
  }
  const complete = new Set<string>();
  const shownAt = new Map<string, ShownBlock>();
  for (const [i, block] of read.blocks.entries()) {
    if (block.n !== i + 1) out.push(`class ${block.n} numbered out of order`);
    const e = expected.get(block.header);
    if (e === undefined) {
      // Only a line that was cut may name no class: it can be no class's whole line.
      if (!/\.\.\.\(cut\)/.test(block.header))
        out.push(`a class line no atom has: ${block.header}`);
      continue;
    }
    if (shownAt.has(block.header)) out.push(`a class line shown twice: ${block.header}`);
    shownAt.set(block.header, block);
    const display = DISPLAY_OF[e.kind];
    let whole = block.more === 0 && !block.exampleCut;
    if (display === "pairs" || display === "removals") {
      for (const p of block.pairs) {
        if (p.cut) {
          whole = false;
          const fits = [...e.pairs].some(([id, n]) => {
            const [eb, ea] = JSON.parse(id) as [string, string | null];
            const prefix = (full: string, shown: string) => full.startsWith(shown);
            return (
              n === p.count &&
              prefix(eb, p.before) &&
              (ea === null ? p.after === null : p.after !== null && prefix(ea, p.after))
            );
          });
          if (!fits) out.push(`a cut pair that is no atom's: ${block.header}`);
          continue;
        }
        const n = e.pairs.get(JSON.stringify([p.before, p.after]));
        if (n !== p.count)
          out.push(
            `${block.header}: ${JSON.stringify([p.before, p.after])} x${p.count}, the atoms say x${n ?? 0}`,
          );
      }
      // Two different pairs cut at the same place read alike; two uncut lines never may.
      const uncut = block.pairs.filter((p) => !p.cut);
      if (new Set(uncut.map((p) => JSON.stringify([p.before, p.after]))).size !== uncut.length) {
        out.push(`a pair shown twice: ${block.header}`);
      }
      if (block.pairs.length > SUMMARY_LIMITS.maxPairsPerClass)
        out.push(`over 12 pairs: ${block.header}`);
      if (block.pairs.length + block.more !== e.pairs.size) {
        out.push(
          `${block.header}: ${block.pairs.length} pairs shown and ${block.more} more, the atoms have ${e.pairs.size}`,
        );
      }
    } else if (block.pairs.length > 0 || block.more > 0)
      out.push(`pairs under a rule class: ${block.header}`);
    if (whole) complete.add(block.header);
  }

  // The facts' table says what the oracle read: one line per shown class, and its completeness.
  if (summary.facts.classes.length !== read.blocks.length)
    out.push("the facts' class table has another length");
  for (const [i, block] of read.blocks.entries()) {
    const e = expected.get(block.header);
    const line = summary.facts.classes[i] ?? "";
    const full = complete.has(block.header);
    if (e !== undefined && !line.startsWith(`C${i + 1} ${KIND_WORDS[e.kind]} | `))
      out.push(`facts line ${i + 1} names another kind`);
    if (line.endsWith("| in full") !== full)
      out.push(`facts line ${i + 1} says ${line}, the text says ${full ? "whole" : "not whole"}`);
  }

  // Accounted for exactly when every non-additive atom is recoverable from the text.
  for (const [path, atoms] of own) {
    let recoverable = atoms !== null;
    for (const atom of atoms ?? []) {
      if (ROLE_OF[atom.kind] === "additive") continue;
      const header = expectedHeader(path, atom);
      const block = shownAt.get(header);
      const pair = expectedPair(atom);
      const found =
        block !== undefined &&
        complete.has(header) &&
        (pair === null ||
          block.pairs.some(
            (p) => !p.cut && p.before === pair[0] && p.after === pair[1] && p.count >= 1,
          ));
      if (!found) recoverable = false;
      if (!found && summary.accounted.has(path)) {
        out.push(
          `${path} is accounted for, but its ${atom.kind} ${JSON.stringify(pair)} cannot be read from the text`,
        );
      }
    }
    if (recoverable && !summary.accounted.has(path))
      out.push(`${path}: everything is shown, yet it is not accounted for`);
  }
  for (const path of summary.accounted)
    if (!own.has(path)) out.push(`${path}: accounted for, and no candidate`);

  // The loss facts, counted by the oracle from its own atoms.
  const loss: LossFacts = { ...NO_LOSS };
  for (const [path, atoms] of [...own].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (atoms === null) continue;
    const n = (kind: ClassKind) => atoms.filter((a) => a.kind === kind).length;
    const columns = atoms.filter((a) => a.kind === "column_removed" && a.detail !== "0").length;
    loss.rowsRemoved += n("row_removed");
    loss.rowsRemovedFiles += n("row_removed") > 0 ? 1 : 0;
    loss.rowsRelocated += n("row_relocated");
    loss.columnsRemoved += columns;
    loss.keysRemoved += n("json_key_removed");
    loss.keysRemovedFiles += n("json_key_removed") > 0 ? 1 : 0;
    loss.keysMoved += n("json_key_moved");
    loss.valuesEmptied += n("cell_emptied") + n("json_emptied");
    if (loss.firstBlockingPath === null && n("row_removed") + n("json_key_removed") + columns > 0) {
      loss.firstBlockingPath = path;
    }
  }
  if (JSON.stringify(loss) !== JSON.stringify(summary.loss)) {
    out.push(
      `loss facts ${JSON.stringify(summary.loss)}, the oracle counts ${JSON.stringify(loss)}`,
    );
  }
  return out;
}

// The generated pull requests: small alphabets that collide, so classes share shapes and fields,
// pairs repeat across files, relabels and relocations happen, and values look alike.

const O_KEYS = [
  "A1",
  "A10",
  "a1",
  "POL A1",
  "sub-1",
  "sub-01",
  "A01",
  "Cz",
  "FCz",
  "A1-A2",
  "EEG A1-Ref",
  "x",
  "A2",
  "GA01",
  "EEGGA_01REF",
  "\u{430}1",
  "A1\u{200B}",
];
const O_CELLS = [
  "n/a",
  "",
  "0",
  "1",
  "x",
  "EEG",
  "A1",
  "A01",
  "POL A1",
  "uV",
  "\u{B5}V",
  "a",
  "\u{430}",
  "\u{E9}",
  "e\u{301}",
  "go\u{200B}od",
  "good",
  "x\u{A0}y",
  "\u{202E}evil",
  "...(cut)",
  // Format characters that are not default-ignorable: only the category keeps them out of the text.
  "\u{600}",
  "\u{890}",
  "\u{FFF9}",
  "\u{110BD}",
];
const O_TABLES: { path: string; key: string }[] = [
  { path: "sub-01/eeg/sub-01_task-x_channels.tsv", key: "name" },
  { path: "sub-02/eeg/sub-02_task-y_channels.tsv", key: "name" },
  { path: "participants.tsv", key: "participant_id" },
  { path: "sub-01/eeg/sub-01_task-x_events.tsv", key: "name" },
  { path: "sub-02/eeg/sub-02_task-x_events.tsv", key: "name" },
];
const O_JSON = [
  "sub-01/eeg/sub-01_task-x_eeg.json",
  "sub-02/eeg/sub-02_task-x_eeg.json",
  "task-x_events.json",
  "dataset_description.json",
];
const O_JSON_KEYS = [
  "Name",
  "name",
  "a",
  "A",
  "b",
  "x1",
  "go",
  "go2",
  "Level",
  "a.b",
  "0",
  "k\u{200B}",
  "a\u{0}b",
];
type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
const O_SCALARS: Plain[] = [
  0,
  1,
  "1",
  "x",
  "Go",
  "good",
  "go\u{200B}od",
  "\u{E9}",
  "e\u{301}",
  "a",
  "\u{430}",
  null,
  "",
  "n/a",
  true,
  "A",
];

function kit(random: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const chance = (p: number): boolean => random() < p;
  const int = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));
  return { pick, chance, int };
}

/** A generated table pair, with the copies its removals left in the pool. */
function oracleTable(
  random: () => number,
  spec: { path: string; key: string },
  pool: PoolFile[],
  traits: Set<string>,
): SummaryCandidate {
  const { pick, chance, int } = kit(random);
  if (chance(0.04)) {
    traits.add("refused");
    return candidate(spec.path, "a\tb\n1\n", tsv(["a", "b"], ["1", "2"]));
  }
  let header = [spec.key, ...["type", "units", "c"].filter(() => chance(0.6))];
  const longColumn = chance(0.02);
  if (longColumn) {
    header = [...header, "L".repeat(305)];
    traits.add("long_field");
  }
  const wide = chance(0.06);
  const rows: string[][] = [];
  const total = wide ? 14 : int(1, 6);
  const used = new Set<string>();
  for (let i = 0; i < total; i++) {
    const row = header.map(() => pick(O_CELLS));
    let key = wide ? `W${i}` : pick(O_KEYS);
    for (let t = 0; t < 10 && used.has(key); t++) key = pick(O_KEYS);
    used.add(key);
    row[0] = key;
    if (wide && header.includes("units")) row[header.indexOf("units")] = "uV";
    rows.push(row);
  }
  if (chance(0.04) && header.length > 1 && rows.length > 0) {
    (rows[0] as string[])[1] = "v".repeat(301 + int(0, 4));
    traits.add("long_value");
  }
  let afterHeader = [...header];
  if (chance(0.12) && afterHeader.length > 1) afterHeader.splice(int(1, afterHeader.length - 1), 1);
  if (chance(0.12) && !afterHeader.includes("e")) afterHeader.push("e");
  if (chance(0.1)) afterHeader = [afterHeader[0] as string, ...afterHeader.slice(1).reverse()];
  const afterRows: string[][] = [];
  const relocated: string[][] = [];
  for (const [i, row] of rows.entries()) {
    const cells = new Map(header.map((h, j) => [h, row[j] as string]));
    if (wide && cells.has("units")) {
      cells.set("units", `w${i}`);
      traits.add("wide");
    } else {
      const op = random();
      if (op < 0.15) continue;
      if (op < 0.3) {
        relocated.push(row);
        continue;
      }
      if (op < 0.45) cells.set(spec.key, pick(O_KEYS));
      if (chance(0.4)) {
        const h = pick(afterHeader);
        if (h !== spec.key) cells.set(h, pick(O_CELLS));
      }
    }
    afterRows.push(afterHeader.map((h) => cells.get(h) ?? pick(O_CELLS)));
  }
  for (let i = int(0, 2); i > 0; i--) {
    afterRows.push(afterHeader.map((h) => (h === spec.key ? pick(O_KEYS) : pick(O_CELLS))));
  }
  if (chance(0.25)) afterRows.reverse();
  if (relocated.length > 0 && chance(0.8)) {
    const copies = relocated.map((r) => [...r]);
    if (chance(0.15)) (copies[0] as string[])[0] = `${copies[0]?.[0]}!`;
    pool.push(
      pooled(`sourcedata/${pick(["old", "removed"])}/${spec.path}`, null, tsv(header, ...copies)),
    );
    traits.add("relocation_offered");
  }
  let after = tsv(afterHeader, ...afterRows);
  if (chance(0.06)) {
    after = after.replaceAll("\n", "\r\n");
    traits.add("layout");
  }
  if (chance(0.04)) {
    after = `\u{FEFF}${after}`;
    traits.add("layout");
  }
  return candidate(spec.path, tsv(header, ...rows), after);
}

function oracleValue(random: () => number, depth: number): Plain {
  const { pick, chance, int } = kit(random);
  if (depth >= 3 || chance(0.5)) return pick(O_SCALARS);
  if (chance(0.35)) {
    return Array.from({ length: int(0, 3) }, () =>
      chance(0.6) ? oracleObject(random, depth + 1) : pick(O_SCALARS),
    );
  }
  return oracleObject(random, depth + 1);
}
function oracleObject(random: () => number, depth: number): { [key: string]: Plain } {
  const { pick, int } = kit(random);
  const o: { [key: string]: Plain } = {};
  for (let i = int(0, 4); i > 0; i--) o[pick(O_JSON_KEYS)] = oracleValue(random, depth);
  return o;
}

/** A generated JSON pair; moved keys go to the root sidecar in `sidecar`. */
function oracleJson(
  random: () => number,
  path: string,
  sidecar: { [key: string]: Plain },
  traits: Set<string>,
): SummaryCandidate {
  const { pick, chance, int } = kit(random);
  if (chance(0.03)) {
    traits.add("refused");
    return candidate(path, '{"a": 1}', '{"a": 1, "a": 2}');
  }
  if (chance(0.01)) {
    traits.add("many_classes");
    const keys = Array.from({ length: 125 }, (_, i) => `k${i}`);
    return candidate(
      path,
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, "1"]))),
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, "2"]))),
    );
  }
  const before = oracleObject(random, 0);
  if (chance(0.05)) {
    before.arr = Array.from({ length: 14 }, (_, i) => ({ v: `a${i}` }));
    traits.add("wide");
  }
  if (chance(0.03)) {
    before.long = "q".repeat(301 + int(0, 3));
    traits.add("long_value");
  }
  if (chance(0.06)) {
    const text = JSON.stringify(before);
    if (text.includes('"A')) {
      traits.add("respelled");
      return candidate(path, text, text.replace('"A', '"\\u0041'));
    }
  }
  const after = JSON.parse(JSON.stringify(before)) as { [key: string]: Plain };
  for (const key of Object.keys(after)) {
    const op = random();
    if (key === "arr")
      after.arr = (after.arr as { v: string }[]).map((x, i) => ({ v: `${x.v}-${i}` }));
    else if (key === "long") after.long = "changed";
    else if (op < 0.15) delete after[key];
    else if (op < 0.3) {
      const respelled = pick([key.toUpperCase(), `${key}_`, `EEG_${key}`, pick(O_JSON_KEYS)]);
      if (respelled !== key && !(respelled in after)) {
        after[respelled] = after[key] as Plain;
        delete after[key];
      }
    } else if (op < 0.45) after[key] = oracleValue(random, 1);
    else if (op < 0.55) after[key] = pick([null, "", "n/a", [], {}]);
    else if (op < 0.65 && path.endsWith("_eeg.json")) {
      sidecar[key] = after[key] as Plain;
      delete after[key];
      traits.add("move_offered");
    }
  }
  for (let i = int(0, 2); i > 0; i--) {
    const key = pick(O_JSON_KEYS);
    if (!(key in after)) after[key] = oracleValue(random, 1);
  }
  let text = JSON.stringify(after);
  if (chance(0.08)) {
    text = `${JSON.stringify(after, null, 2)}\r\n`;
    traits.add("layout");
  }
  return candidate(path, JSON.stringify(before), text);
}

function generateOracleCase(random: () => number, traits: Set<string>): OracleCase {
  const { pick, chance, int } = kit(random);
  const candidates: SummaryCandidate[] = [];
  const pool: PoolFile[] = [];
  const sidecar: { [key: string]: Plain } = {};
  const taken = new Set<string>();
  for (let f = int(1, 4); f > 0; f--) {
    if (chance(0.6)) {
      const spec = pick(O_TABLES);
      if (taken.has(spec.path)) continue;
      taken.add(spec.path);
      candidates.push(oracleTable(random, spec, pool, traits));
    } else {
      const path = pick(O_JSON);
      if (taken.has(path)) continue;
      taken.add(path);
      candidates.push(oracleJson(random, path, sidecar, traits));
    }
  }
  if (Object.keys(sidecar).length > 0) {
    pool.push(pooled("task-x_eeg.json", chance(0.5) ? null : "{}", JSON.stringify(sidecar)));
  }
  if (chance(0.02) && candidates.length > 0) {
    candidates.push({ ...(candidates[0] as SummaryCandidate) });
    traits.add("duplicate_path");
  }
  // The candidates come in any order: the summary sorts them.
  return { candidates: candidates.reverse(), pool };
}

describe("the hidden-loss round-trip oracle", () => {
  test("lossFactsOf over the summarized files' atoms is the summary's own count, file by file, on 1,000 generated pull requests", () => {
    const random = seeded(1868);
    let lossy = 0;
    for (let n = 0; n < 1000; n++) {
      const c = generateOracleCase(random, new Set());
      const summary = summarizeChanges({ candidates: c.candidates, pool: c.pool, deadline: null });
      const files = [...oracleAtoms(c)].flatMap(([path, atoms]) =>
        atoms === null ? [] : [{ path, atoms }],
      );
      expect(lossFactsOf(files), `case ${n}`).toEqual(summary.loss);
      expect(lossFactsOf([...files].reverse()), `case ${n}`).toEqual(summary.loss);
      const { rowsRemoved, keysRemoved, columnsRemoved } = summary.loss;
      if (rowsRemoved + keysRemoved + columnsRemoved > 0) lossy++;
    }
    expect(lossy).toBeGreaterThan(300);
  });

  test("4,500 generated pull requests: what an accounted file lost or changed is recoverable from the text, and nothing else is accounted for", () => {
    const random = seeded(20261020);
    const counts = new Map<string, number>();
    const note = (trait: string, by = 1): void => {
      counts.set(trait, (counts.get(trait) ?? 0) + by);
    };
    const seen = new Set<ClassKind>();
    const violations: string[] = [];
    let selfTests = 0;
    for (let n = 0; n < 4500; n++) {
      const traits = new Set<string>();
      const c = generateOracleCase(random, traits);
      for (const trait of traits) note(trait);
      const summary = summarizeChanges({ candidates: c.candidates, pool: c.pool, deadline: null });
      for (const cls of summary.classes) seen.add(cls.kind);
      note("files", summary.files.length);
      note("accounted", summary.accounted.size);
      note("summarized_unaccounted", summary.facts.files_summarized - summary.accounted.size);
      if (summary.facts.classes_cut > 0) note("classes_cut");
      if (summary.complete.size < summary.shown.size) note("incomplete_class");
      if (summary.loss.rowsRelocated > 0) note("relocated");
      if (summary.loss.keysMoved > 0) note("moved");
      if (summary.text.includes("(first difference")) note("annotated");
      for (const v of oracleViolations(c, summary, summary.text)) {
        violations.push(`case ${n}: ${v}\n${summary.text}`);
      }
      // Not vacuous: with one pair line of a class the oracle can name deleted, it must object.
      const lines = summary.text.split("\n");
      let header = "";
      const deletable: number[] = [];
      const known = new Set<string>();
      for (const [path, atoms] of oracleAtoms(c))
        for (const a of atoms ?? []) known.add(expectedHeader(path, a));
      for (const [i, line] of lines.entries()) {
        if (/^C[0-9]+ \| /.test(line)) header = line.slice(line.indexOf(" | ") + 3);
        else if (line.startsWith('    "') && known.has(header)) deletable.push(i);
      }
      if (deletable.length > 0) {
        const drop = deletable[Math.floor(random() * deletable.length)] as number;
        const fewer = lines.filter((_, i) => i !== drop).join("\n");
        selfTests++;
        if (oracleViolations(c, summary, fewer).length === 0) {
          violations.push(`case ${n}: deleting line ${drop} went unnoticed\n${summary.text}`);
        }
      }
    }
    expect(violations.slice(0, 3)).toEqual([]);
    expect(selfTests).toBeGreaterThan(2500);
    for (const [trait, least] of [
      ["files", 8000],
      ["accounted", 4000],
      ["summarized_unaccounted", 300],
      ["refused", 200],
      ["wide", 200],
      ["long_value", 150],
      ["long_field", 30],
      ["layout", 300],
      ["respelled", 30],
      ["many_classes", 15],
      ["duplicate_path", 50],
      ["classes_cut", 15],
      ["incomplete_class", 300],
      ["relocated", 300],
      ["moved", 200],
      ["annotated", 300],
    ] as const) {
      expect(counts.get(trait) ?? 0, trait).toBeGreaterThanOrEqual(least);
    }
    for (const kind of CLASS_KINDS) expect(seen.has(kind), kind).toBe(true);
  }, 120_000);
});
