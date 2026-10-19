/**
 * The words a pull request opened by the CLI carries (`nemar dataset update`, `nemar dataset push
 * --pr`), and the CHANGES entry `update` writes for the version it releases.
 *
 * Three layers, each driven the way production reaches it:
 *
 *  1. The text checks and builders, on strings a person really types: each refusal with the
 *     sentences that trigger it, and beside it the ordinary sentences that must still pass. The
 *     real title of nemarDatasets/nm000456 pull request 1 (a naming rule where the new name
 *     belonged) is one of the refused strings.
 *  2. The parsers and the CHANGES writer, on output from the REAL git. "The entry is one the
 *     review recognizes" is the review's own reader answering (`gatherGitFacts`, the function the
 *     review job runs), not this file's regular expression.
 *  3. The commands, through the real entry point (`bun run src/index.ts`) in a real git
 *     repository with a local bare remote. Only the two boundaries are stood in: the GitHub CLI (a
 *     script that records the arguments of `pr create` and prints a URL) and the NEMAR API (a local
 *     `Bun.serve` answering the reads `update` makes). The CLI runs with a clean environment, no
 *     GitHub token, an empty `gh` configuration directory and the stand-in `gh` first on its PATH,
 *     so a mistake in a test cannot reach a real repository; the repository the stand-in API names
 *     is not there either.
 *
 * CI TIER: unit-pure. Everything is local and offline.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import { gatherGitFacts } from "../scripts/ci/pr-review-evidence";
import {
  DOI_PATTERN,
  TEMPLATE_FIELDS,
  YEAR_PATTERN,
  findTemplateField,
} from "../shared/naming-rule";
import {
  type ChangedFile,
  MAX_NAMED_FILES,
  MAX_TITLE_LENGTH,
  TEXT_PROBLEMS,
  type TextKind,
  type TextProblemCode,
  addChangelogEntry,
  buildReleaseTitle,
  buildUpdateBody,
  buildUpdateTitle,
  cleanPrText,
  describeChangelogWrite,
  describeSentTitleProblem,
  describeTextProblem,
  describeUnopenedPullRequest,
  findAuthorYearKey,
  findDoi,
  findSentTitleProblem,
  findTextProblem,
  hasChangelogHeading,
  inspectChangelog,
  localIsoDate,
  normalizeTitle,
  parsePorcelainPaths,
  parseStagedChanges,
  summarizeChangedFiles,
  writeChangelogEntry,
} from "../src/lib/pr-text";

// Each command test starts the CLI (a transpile) and git, and the interactive ones wait on prompts.
setDefaultTimeout(60_000);

/**
 * Whether a regular expression's source repeats a part that itself repeats (`(a+)+`, `(?:\s*x)*`),
 * the shape that makes a backtracking engine try a long input in more than polynomially many ways.
 * Escapes and character classes are skipped as the atoms they are; `?` makes a part optional and is
 * not a repetition. A small reader for the patterns this file checks, not a full parser.
 */
function nestedRepetition(source: string): boolean {
  // One frame per open group: whether its body holds a repetition so far.
  const frames: boolean[] = [false];
  const repeats = (at: number): boolean =>
    source[at] === "*" ||
    source[at] === "+" ||
    (source[at] === "{" &&
      /^\{\d+,\d*\}/.test(source.slice(at)) &&
      !/^\{\d+,1\}/.test(source.slice(at)));
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      // An escape, with the braces of \u{...} and \p{...} when it has them.
      if (source[i + 2] === "{" && /[upP]/.test(source[i + 1] ?? "")) i = source.indexOf("}", i);
      else i++;
      if (repeats(i + 1)) frames[frames.length - 1] = true;
      continue;
    }
    if (c === "[") {
      for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
      if (repeats(i + 1)) frames[frames.length - 1] = true;
      continue;
    }
    if (c === "(") {
      frames.push(false);
      continue;
    }
    if (c === ")") {
      const inner = frames.pop() ?? false;
      if (repeats(i + 1)) {
        if (inner) return true;
        frames[frames.length - 1] = true;
      } else if (inner) {
        frames[frames.length - 1] = true;
      }
      continue;
    }
    if (c !== "*" && c !== "+" && c !== "?" && c !== "{" && c !== "|" && c !== "^" && c !== "$") {
      if (repeats(i + 1)) frames[frames.length - 1] = true;
    }
  }
  return false;
}

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------------------------
// 1. The text checks
// ---------------------------------------------------------------------------------------------

/** The title of nemarDatasets/nm000456 pull request 1: the rule's pattern, not the new name. */
const NM000456_TITLE =
  "Rename dataset to the atlas naming rule FirstAuthorSurname-year-keyword-paperDOI (v1.0.1)";
const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/**
 * Every refusal, with the sentences that trigger it, and the ordinary sentences that must still
 * pass beside it. `passes` is run as a title AND as a description. The keys are checked against
 * `TEXT_PROBLEMS`, so a refusal added without a case here fails the suite.
 */
const CASES: Record<TextProblemCode, { refused: [TextKind, string][]; passes: string[] }> = {
  empty: {
    refused: [
      ["title", ""],
      ["title", "   \n\t "],
      ["description", ""],
      ["description", "\n \n"],
    ],
    passes: ["Fixed typo."],
  },
  machine_output: {
    refused: [
      ["title", SHA256],
      ["title", "a1b2c3d"],
      ["title", `sha256:${SHA256}`],
      ["description", '{"Name": "Resting EEG", "Version": "1.0.1"}'],
      ["title", "[1, 2, 3]"],
    ],
    passes: [
      `Fix checksum ${SHA256} mismatch`,
      "Defaced", // only hex letters: a word, not a digest
      '"Fix the thing"', // a JSON string is a sentence in quotes
      "[Fix] typos in [participants.tsv]", // brackets at both ends, and not JSON
    ],
  },
  placeholder: {
    refused: [
      ["title", "Save changes"],
      ["title", "SAVE CHANGES."],
      ["title", "Update from branch update/nm000456-mvauf3hk"],
      ["title", "Update nm000104 to v1.0.1"],
      ["description", "Update xx090001 to 2.0.0"],
      ["title", "TBD"],
      ["description", "n/a"],
      ["description", "Lorem ipsum dolor sit amet"],
      ["title", "title"],
      // Each word that stands in for text has a case of its own.
      ["title", "todo"],
      ["title", "FIXME"],
      ["title", "tba"],
      ["description", "N/A"],
      ["title", "na"],
      ["title", "none"],
      ["title", "null"],
      ["title", "undefined"],
      ["title", "untitled"],
      ["description", "placeholder"],
      ["description", "description"],
      ["title", "message"],
      ["description", "summary"],
      ["description", "text"],
      ["title", "test"],
      ["title", "testing"],
      ["title", "asdf"],
      ["title", "XXXX"],
      ["title", "Update from branch"],
    ],
    passes: [
      "Save changes to the channel locations after re-digitizing",
      "Update nm000104 documentation after the reanalysis",
      "Update from the original recordings, which fixes the sampling rate",
      "Test the new epoching parameters on sub-01",
    ],
  },
  template_field: {
    refused: [
      ["title", NM000456_TITLE],
      ["title", "Add {{title}} data"],
      ["title", "Add ${N} subjects"],
      ["title", "<your title here>"],
      ["title", "[describe the change]"],
      ["title", "[Describe your change]"],
      ["title", "[Fill in the description]"],
      ["title", "<insert title>"],
      ["title", "FirstAuthorSurname"],
      ["title", "Rename it to year-keyword-paperDOI"],
      ["title", "paperDOI"],
      // The tokens joined to other text by an underscore or a digit, and in another case.
      ["title", "FirstAuthorSurname_year_keyword_paperDOI"],
      ["title", "paperDOI10.1234"],
      ["title", "Rename it to firstauthorsurname-keyword"],
    ],
    passes: [
      // BIDS field and label names are CamelCase by specification: the vocabulary of an update.
      "Set PowerLineFrequency to 50 in every EEG sidecar",
      "Add DatasetDOI to dataset_description.json",
      "Rename task-RestingStateEyesClosed to task-restEC in all events files",
      // Brackets that name a BIDS label do not ask the reader to write anything.
      "Rename files to sub-<label>_task-<label>_eeg.edf",
      "[WIP] Add sub-21 recordings",
      "Remove the {} left in the README",
      // A key name, or the text of a Markdown link, is not a field left unfilled.
      "Press <Enter> to continue; the task prompt now says <Write> before each trial.",
      "Fix: [Replace] stale checksum values",
      "Added the [Enter] key to the response mapping",
      "Follows [your lab's data policy](https://example.org/policy) for the new recordings.",
      "Adds the [Your lab](https://example.org) link to the README.",
      "Details are in the [Write-up](https://example.org/writeup.pdf).",
      "See [your lab][1] for the protocol.",
    ],
  },
  author_year: {
    refused: [
      // The three shapes the rule was written for.
      ["title", "Lee2019 EEG dataset"],
      ["title", "Lee-2019-EEG"],
      ["title", "Smith2020"],
      // A dataset's own name is refused whatever its case: an acronym, capitals, lower case.
      ["title", "MOVING2024 release"],
      ["title", "BNCI2014_001 recordings"],
      ["title", "LEE2019 EEG dataset"],
      ["title", "lee2019 eeg"],
      // An underscore may join the name and the year, and what follows the year does not matter.
      ["title", "Lee_2019_EEG"],
      ["title", "Lee2019EEG dataset"],
      ["title", "Lee2019a"],
      // An apostrophe or a hyphen inside the name.
      ["title", "O'Brien2019 recordings"],
      ["title", "O\u{2019}Brien-2019 recordings"],
      ["title", "Smith-Jones2019 EEG"],
      ["title", "Smith-Jones-2019-EEG"],
      // Letters that are not ASCII: an umlaut whole and as a mark after the u, and another script.
      ["title", "M\u{fc}ller2021 EEG"],
      ["title", "Mu\u{308}ller2021 EEG"],
      ["title", "\u{418}\u{432}\u{430}\u{43d}\u{43e}\u{432}2019 EEG"],
      // Judged as the one trimmed line the title becomes.
      ["title", "  Lee2019 EEG dataset  "],
      ["title", "\nLee-2019-EEG"],
      // And with what no reader sees in front of it: a zero-width space, a soft hyphen, a byte-order mark.
      ["title", "\u{200b}Lee2019 EEG dataset"],
      ["title", "\u{ad}\u{feff} Lee-2019-EEG"],
      // Wherever it stands in the title, not only at its start: the middle, the end, in parentheses.
      ["title", "Add the Lee2019 recordings"],
      ["title", "Add the BNCI2014_001 recordings"],
      ["title", "Rename the dataset to Lee-2019-EEG"],
      ["title", "Results from Zhou-2016 cohort"],
      ["title", "sourcedata: add the validation files the MOABB loader reads (Mainsah2025_L)"],
      // A template token joined to a year is also a key, and the key is asked about first.
      ["title", "Rename it to firstauthorsurname-2019"],
      // The key is the letters that touch the year: an underscore or a doubled hyphen before them
      // does not hide it.
      ["title", "Lee_Brien2019 EEG"],
      ["title", "Lee--Brien2019 EEG"],
    ],
    passes: [
      // A year, or a name, in an ordinary sentence. A space ends a key: the letters must touch the
      // year or the one separator before it.
      "Add 2019 recordings",
      "2019 release notes",
      "Release 2019",
      "Andreev 2012 is not refused",
      "2019-2020 study",
      "Update Lee dataset",
      "Save changes to the channel locations",
      "Add three EEG recordings",
      // A digit before the separator means it is not a name: a study number, not an author.
      "Study2-2019 recordings added",
    ],
  },
  doi: {
    refused: [
      // A DOI as a link, as a bare prefix, at the start, joined by a hyphen, and with an invisible
      // character inside its prefix.
      ["title", "Described in 10.1038/s41597-020-0532-5"],
      ["title", "Add the recordings from https://doi.org/10.7910/DVN/ABC123"],
      ["title", "See doi:10.1234/abc"],
      ["title", "10.5281/zenodo.1234567 recordings"],
      ["title", "Add recordings (taxonomy-10.7910/x)"],
      ["title", "Described in 10.\u{200b}1038/s41597"],
    ],
    passes: [
      // A number with a dot is no DOI without its four to nine digits and its slash.
      "Recordings of 10.5 Hz tones",
      "Version 10.2019 notes",
      "Add 10.123/day recordings",
      "Described in the README, which links doi.org",
    ],
  },
  no_words: {
    refused: [
      ["title", "..."],
      ["title", "v1.0.1"],
      ["description", "12345"],
      ["title", "x y z"],
      ["description", "🙂🙂🙂"],
    ],
    passes: ["Fixes #12", "更新数据", "Añadir doce sujetos"],
  },
  too_long: {
    refused: [["title", "Add recordings ".repeat(14)]],
    passes: ["Add twelve subjects with resting-state EEG recordings"],
  },
};

describe("findTextProblem", () => {
  test("every refusal has a case here", () => {
    expect(Object.keys(CASES).sort()).toEqual([...TEXT_PROBLEMS].sort());
  });

  for (const [code, { refused, passes }] of Object.entries(CASES) as [
    TextProblemCode,
    (typeof CASES)[TextProblemCode],
  ][]) {
    describe(code, () => {
      for (const [kind, text] of refused) {
        test(`refuses the ${kind} ${JSON.stringify(text.slice(0, 50))}`, () => {
          expect(findTextProblem(kind, text)?.code).toBe(code);
        });
      }
      for (const text of passes) {
        test(`passes the ordinary sentence ${JSON.stringify(text.slice(0, 60))}`, () => {
          expect(findTextProblem("title", text)).toBeNull();
          expect(findTextProblem("description", text)).toBeNull();
        });
      }
    });
  }

  test("text that was never given is empty", () => {
    expect(findTextProblem("title", undefined)?.code).toBe("empty");
    expect(findTextProblem("description", undefined)?.code).toBe("empty");
  });

  test("a title is judged as the one line it becomes", () => {
    // Two lines that are each fine are one title; two that read as a placeholder once joined are
    // refused as one.
    expect(findTextProblem("title", "Add twelve subjects\nwith EEG recordings")).toBeNull();
    expect(findTextProblem("title", "Save\nchanges")?.code).toBe("placeholder");
    expect(findTextProblem("title", "Update from branch\nmain")?.code).toBe("placeholder");
    expect(normalizeTitle("  Add   twelve\nsubjects\t(v2) ")).toBe("Add twelve subjects (v2)");
  });

  describe("cleanPrText", () => {
    test("a title is one line and a description is trimmed with its paragraphs kept", () => {
      expect(cleanPrText("title", "  Add   twelve\nsubjects\t(v2) ")).toBe(
        "Add twelve subjects (v2)",
      );
      expect(cleanPrText("description", "  Adds sub-21.\n\nEach has one run.  \n")).toBe(
        "Adds sub-21.\n\nEach has one run.",
      );
      expect(cleanPrText("title", undefined)).toBe("");
      expect(cleanPrText("description", undefined)).toBe("");
    });

    test("what is judged is what is stored", () => {
      // Padded, split and refused variants: judging the raw text and judging the cleaned text must
      // agree, so a text that passes is the text that goes to git, to GitHub and into CHANGES.
      const raws = [
        "  Add   twelve\nsubjects ",
        "Save\nchanges",
        "  \n  ",
        "Update from branch\n main ",
        "  {{title}}  ",
        "  Lee2019\n EEG dataset ",
        "\tFixed typo.\n",
        `  ${SHA256}  `,
      ];
      for (const kind of ["title", "description"] as const) {
        for (const raw of raws) {
          expect(findTextProblem(kind, raw)?.code).toBe(
            findTextProblem(kind, cleanPrText(kind, raw))?.code,
          );
        }
      }
    });
  });

  test("a title may be exactly as long as the limit and no longer", () => {
    // 39 four-letter words and a space after each, then a last word that decides the length.
    const stem = "word ".repeat(39);
    const atLimit = `${stem}${"w".repeat(MAX_TITLE_LENGTH - stem.length)}`;
    expect(atLimit).toHaveLength(MAX_TITLE_LENGTH);
    expect(findTextProblem("title", atLimit)).toBeNull();
    const over = `${atLimit}w`;
    expect(over).toHaveLength(MAX_TITLE_LENGTH + 1);
    expect(findTextProblem("title", over)?.code).toBe("too_long");
  });

  test("a description has no length limit", () => {
    expect(findTextProblem("description", "Adds new recordings. ".repeat(500))).toBeNull();
  });

  test("a very long run of punctuation is judged, and trimmed, without error", () => {
    // Trimming it with `/[\s.!:;,]+$/` is quadratic, because the run is tried again from every
    // start: 160,000 characters took ten seconds. The trim is now a loop over the end of the text,
    // which looks at each character once. Nothing here is timed (a wall-clock bound fails on a
    // loaded runner). The run is the shortest one the quadratic trim cannot get through inside this
    // file's test timeout, about a minute and a half of work against sixty seconds, while the loop
    // takes a few milliseconds: a regression fails this test by timeout, and a longer run would only
    // make it fail later.
    const hostile = `${".".repeat(500_000)}a`;
    expect(findTextProblem("description", hostile)?.code).toBe("no_words");
    // A title is judged on the same trim, so a shorter run is enough to check its answer.
    expect(findTextProblem("title", `${".".repeat(20_000)}a`)?.code).toBe("no_words");
    // The trailing run is really trimmed: what it hides is found under it.
    expect(findTextProblem("title", `Save changes${".!:;, ".repeat(2_000)}`)?.code).toBe(
      "placeholder",
    );
  });

  test("an unclosed instruction bracket and a long run of blanks is judged without error", () => {
    // `\s+` and the characters after it overlap on blanks, so an unclosed `[your` or `<insert`
    // followed by tens of thousands of them was tried as every split of the run: 64,000 took
    // seconds. A description is only trimmed, so its whitespace reaches the rule. What keeps it
    // linear is the pattern's shape, and the next test is the one that fails when the shape goes:
    // a run long enough to push the old pattern past this file's test timeout would take minutes to
    // fail, so these are the answers on runs that are long for a pull request and short for a test.
    for (const opener of ["[your", "<insert", "[fill in"]) {
      for (const blank of [" ", " \t", "\n"]) {
        const hostile = `Adds data.\n\n${opener}${blank.repeat(30_000 / blank.length)}x`;
        // The rule itself: a description is not held to it, and a title has its blanks collapsed.
        expect(findTemplateField(hostile)).toBeNull();
      }
    }
  });

  test("the instruction-bracket pattern gives a run of blanks one way to match", () => {
    // Checked on the pattern itself, not by timing a hostile text (which flakes with the machine).
    // The run of blanks after the asking word is followed by a lookahead that refuses a blank, so
    // the run must end where the blanks do and cannot be shared with the words after it; the match
    // can only begin at a bracket; and no repetition repeats another.
    const bracket = TEMPLATE_FIELDS.find((re) => re.source.includes("your|insert"));
    if (!bracket)
      throw new Error("the instruction-bracket pattern is gone from the template fields");
    expect(bracket.source).toContain("\\s+(?=[^\\s");
    expect(bracket.source.startsWith("[<[]")).toBe(true);
    for (const re of TEMPLATE_FIELDS) {
      expect(nestedRepetition(re.source), re.source).toBe(false);
    }
    // The checker is not blind: it sees the shapes that are quadratic or worse.
    expect(nestedRepetition("(a+)+$")).toBe(true);
    expect(nestedRepetition("(?:\\s*x)*y")).toBe(true);
    expect(nestedRepetition("[(a+)]*")).toBe(false);
  });

  test("a bracket that is closed after blanks is still a template", () => {
    expect(findTemplateField(`[your${" ".repeat(50_000)}title]`)).not.toBeNull();
    // No words inside, so nothing is asked of the reader: not a template.
    expect(findTemplateField("Adds data. [your   ]")).toBeNull();
  });

  describe("a description is not held to the naming rule", () => {
    // The rule is for the title (and, in the review, the dataset's Name). A description may show a
    // template token or an unfilled field as an example, so the CLI does not refuse it for one.
    const TOKENS = [
      "Renames the dataset to FirstAuthorSurname-year-keyword-paperDOI as the atlas rule asks.",
      "Replaces {{old_name}} with the new task name in every events file.",
      "Documents the ${LAB_PREFIX} variable that the conversion script reads.",
      "Fills in the <your title here> line of the README template.",
      "Removes the [describe the change] line left in CHANGES.",
    ];

    test("a description with a template token is accepted", () => {
      for (const text of TOKENS) {
        expect(findTextProblem("description", text), text).toBeNull();
      }
    });

    test("the same text is refused as a title", () => {
      for (const text of TOKENS) {
        expect(findTextProblem("title", text)?.code, text).toBe("template_field");
      }
    });
  });

  test("a placeholder is refused as a description too, and says which text it saw", () => {
    const problem = findTextProblem("description", "Save changes");
    expect(problem?.code).toBe("placeholder");
    if (!problem) throw new Error("expected a problem");
    expect(describeTextProblem("The description (--description)", problem)).toBe(
      'The description (--description) is placeholder text ("Save changes"); say what actually changed.',
    );
  });

  test("the nm000456 title names the field it left unfilled", () => {
    const problem = findTextProblem("title", NM000456_TITLE);
    expect(problem?.reason).toContain('"FirstAuthorSurname"');
  });

  describe("a title with an author-year key in it", () => {
    test("is refused as a title and left alone in a description", () => {
      for (const text of [
        "Lee2019 EEG dataset",
        "Lee-2019-EEG",
        "Smith2020",
        "MOVING2024 release",
        "Add the Lee2019 recordings",
        "Results from Zhou-2016 cohort",
      ]) {
        expect(findTextProblem("title", text)?.code, text).toBe("author_year");
        expect(findTextProblem("description", text), text).toBeNull();
      }
      // A description may cite a paper the way the paper is cited.
      expect(
        findTextProblem("description", "Lee2019 recorded these sessions with a 64-channel cap."),
      ).toBeNull();
    });

    test("says what it found and what to write instead", () => {
      for (const [title, found] of [
        ["Lee-2019-EEG", "Lee-2019"],
        ["MOVING2024 release", "MOVING2024"],
        ["Results from Zhou-2016 cohort", "Zhou-2016"],
      ] as const) {
        const problem = findTextProblem("title", title);
        expect(problem?.code).toBe("author_year");
        if (!problem) throw new Error("expected a problem");
        expect(describeTextProblem("The title (--message)", problem)).toBe(
          `The title (--message) has a citation (an author and a year, or a DOI) in it ("${found}"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.`,
        );
      }
      // The title it offers is one that is accepted.
      expect(findTextProblem("title", "Add three EEG recordings")).toBeNull();
    });

    test("the letters are any letters: an acronym, capitals, one letter or lower case is refused too", () => {
      // Dataset names (MOVING2024, BNCI2014_001), codes (H2020, R2019b) and labels (ses-2019) are
      // not told from a surname. The key stops where the year ends.
      const refused: [string, string][] = [
        ["MOVING2024 release", "MOVING2024"],
        ["BNCI2014_001 recordings", "BNCI2014"],
        ["BNCI2003_IVa recordings", "BNCI2003"],
        ["LEE2019 EEG dataset", "LEE2019"],
        ["H2020 funding added", "H2020"],
        ["R2019b exports", "R2019"],
        ["lee2019 eeg", "lee2019"],
        ["ses-2019 sidecars fixed", "ses-2019"],
      ];
      for (const [title, found] of refused) {
        expect(findAuthorYearKey(title), title).toBe(found);
        expect(findTextProblem("title", title)?.code, title).toBe("author_year");
      }
    });

    test("a name made only of hexadecimal letters is a name, not a hash", () => {
      // Dee2019 is seven hex digits and Decade2020 is ten, so the digest check would call them
      // hashes. They are names somebody typed.
      for (const title of ["Dee2019", "Decade2020", "ACE2019", "Facade2019"]) {
        expect(findTextProblem("title", title)?.code, title).toBe("author_year");
      }
      // Text that really is only a digest is still one.
      expect(findTextProblem("title", "a1b2c3d")?.code).toBe("machine_output");
      expect(findTextProblem("title", SHA256)?.code).toBe("machine_output");
    });

    test("the year is four digits from 1900 to 2099 and not the start of a longer number", () => {
      const code = (title: string) => findTextProblem("title", title)?.code;
      // Each range end, from the inside and from the outside.
      expect(code("Lee1900 EEG")).toBe("author_year");
      expect(findTextProblem("title", "Lee1899 EEG")).toBeNull();
      expect(code("Lee2099 EEG")).toBe("author_year");
      expect(findTextProblem("title", "Lee2100 EEG")).toBeNull();
      expect(findTextProblem("title", "Lee201 EEG")).toBeNull(); // three digits
      expect(findTextProblem("title", "Lee20195 EEG")).toBeNull(); // five digits: a number, not a year
    });

    test("the year follows the letters directly or after one hyphen or underscore, and nothing else", () => {
      // A dot, a colon and a doubled or mixed separator each stand between the letters and the year,
      // so what is left is an ordinary sentence.
      for (const title of ["Lee.2019 EEG", "Lee:2019 EEG", "Lee--2019 EEG", "Lee-_2019 EEG"]) {
        expect(findTextProblem("title", title), title).toBeNull();
      }
      // An underscore or a doubled hyphen inside a longer name ends a run of letters, and the
      // letters that touch the year are the key: it is found, wherever the name began.
      for (const title of ["Lee_Brien2019 EEG", "Lee--Brien2019 EEG"]) {
        expect(findAuthorYearKey(title), title).toBe("Brien2019");
        expect(findTextProblem("title", title)?.code, title).toBe("author_year");
      }
    });

    test("findAuthorYearKey gives the first key in the text, as typed, or null", () => {
      expect(findAuthorYearKey("Lee2019 EEG dataset")).toBe("Lee2019");
      expect(findAuthorYearKey("Lee-2019-EEG")).toBe("Lee-2019");
      // The key is the letters that touch the year: a hyphen or an apostrophe ends a run of letters.
      expect(findAuthorYearKey("Smith-Jones_2020 EEG")).toBe("Jones_2020");
      expect(findAuthorYearKey("  \n O'Brien2019")).toBe("Brien2019");
      // Anywhere in the text, and the first key of several.
      expect(findAuthorYearKey("Results from Zhou-2016 cohort")).toBe("Zhou-2016");
      expect(findAuthorYearKey("Lee2019 and Zhou-2016")).toBe("Lee2019");
      expect(findAuthorYearKey("Add 2019 recordings")).toBeNull();
      expect(findAuthorYearKey("2019 release notes")).toBeNull();
      expect(findAuthorYearKey("")).toBeNull();
    });

    test("a very long word is judged without error, and its last run of letters is the key", () => {
      // A long run of letters with hyphens and apostrophes inside it is the shape a pasted word
      // could have. Nothing here is timed: naming-rule.unit.test.ts runs inputs a quadratic scan
      // cannot finish inside the test timeout.
      for (const unit of ["a", "a-", "a'", "ab-c'"]) {
        const word = unit.repeat(100_000);
        for (const tail of ["20", "-20", "x"]) {
          expect(findAuthorYearKey(`${word}${tail}`)).toBeNull();
        }
        // A year after a run of letters completes a key made of that run alone: the whole word when
        // it is all letters, and the letters after its last hyphen or apostrophe otherwise.
        const completes = `${word}a2019`;
        expect(findAuthorYearKey(`${completes} EEG`)).toBe(unit === "a" ? completes : "a2019");
      }
    });

    test("the year and DOI patterns keep the shape that makes the rule linear", () => {
      // The pattern runs on whatever a person pastes. A backtracking engine stays linear on it
      // because it has no unbounded repetition at all, so nothing is tried in more than one way, and
      // no repetition repeats another. Timing a hostile text says the same and flakes with the
      // machine, so the shape is what is checked.
      for (const { source } of [YEAR_PATTERN, DOI_PATTERN]) {
        expect(source).not.toMatch(/[*+]|\{\d+,\}/);
        expect(nestedRepetition(source), source).toBe(false);
      }
      // The pattern is exactly the year: 19 or 20 and two digits, and not the start of a number.
      expect(YEAR_PATTERN.test("1900")).toBe(true);
      expect(YEAR_PATTERN.test("2099")).toBe(true);
      expect(YEAR_PATTERN.test("1899")).toBe(false);
      expect(YEAR_PATTERN.test("2100")).toBe(false);
      expect(YEAR_PATTERN.test("20195")).toBe(false);
      // The DOI pattern is exactly `10.`, four to nine digits and a slash.
      expect(DOI_PATTERN.test("10.1234/")).toBe(true);
      expect(DOI_PATTERN.test("10.123456789/")).toBe(true);
      expect(DOI_PATTERN.test("10.123/")).toBe(false);
      expect(DOI_PATTERN.test("10.1234567890/")).toBe(false);
      expect(DOI_PATTERN.test("10.1234")).toBe(false);
    });
  });

  describe("a title with a DOI in it", () => {
    test("is refused as a title and left alone in a description", () => {
      for (const text of [
        "Described in 10.1038/s41597-020-0532-5",
        "Add recordings (taxonomy-10.7910/x)",
      ]) {
        expect(findTextProblem("title", text)?.code, text).toBe("doi");
        expect(findTextProblem("description", text), text).toBeNull();
      }
      // A description may cite a paper by its DOI, the way the paper is cited.
      expect(
        findTextProblem("description", "Recorded for https://doi.org/10.1038/s41597-020-0532-5."),
      ).toBeNull();
    });

    test("says what it found, in the words an author and a year are told", () => {
      for (const [title, found] of [
        ["Described in 10.1038/s41597-020-0532-5", "10.1038/"],
        ["Add the recordings from https://doi.org/10.7910/DVN/ABC123", "10.7910/"],
      ] as const) {
        expect(findDoi(title), title).toBe(found);
        const problem = findTextProblem("title", title);
        expect(problem?.code).toBe("doi");
        if (!problem) throw new Error("expected a problem");
        expect(describeTextProblem("The title (--message)", problem)).toBe(
          `The title (--message) has a citation (an author and a year, or a DOI) in it ("${found}"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.`,
        );
      }
      // The same sentence as for a key, apart from what was found.
      const key = findTextProblem("title", "Results from Zhou-2016 cohort");
      const doi = findTextProblem("title", "Results from 10.1234/x cohort");
      expect(key?.reason.replace('"Zhou-2016"', "FOUND")).toBe(
        doi?.reason.replace('"10.1234/"', "FOUND"),
      );
    });

    test("a title with both an author and a year and a DOI is told about the author and the year", () => {
      // The first of the two the rule asks about, as namingProblemOf orders them.
      const title =
        "Mapping effective connectivity (Sawada-2022-mapping-10.1038/s41467-022-32644-y)";
      expect(findTextProblem("title", title)?.code).toBe("author_year");
      expect(findDoi(title)).toBe("10.1038/");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Real git, for everything that reads or writes a repository
// ---------------------------------------------------------------------------------------------

let root: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** git's output untouched: `-z` output has meaning in its NULs and its leading spaces. */
function gitRaw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function git(dir: string, ...args: string[]): string {
  return gitRaw(dir, ...args).trim();
}

function write(dir: string, rel: string, content: string) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function desc(version: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    { Name: "Resting EEG of volunteers", BIDSVersion: "1.9.0", Version: version, ...extra },
    null,
    2,
  )}\n`;
}

let counter = 0;
function fresh(prefix: string): string {
  counter += 1;
  return join(root, `${prefix}-${counter}`);
}

/** A repository on `main` with one commit holding `files`. */
function makeRepo(files: Record<string, string>): string {
  const dir = fresh("repo");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pr-text-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the title as it will be sent", () => {
  const TYPED = "Add subject 03";

  test("a calendar version makes an author-year key of the suffix, though the typed title passes", () => {
    expect(findTextProblem("title", TYPED)).toBeNull();
    const sent = buildUpdateTitle(TYPED, "2020.1.1");
    expect(sent).toBe("Add subject 03 (v2020.1.1)");
    const problem = findSentTitleProblem(sent);
    expect(problem?.code).toBe("author_year");
    if (!problem) throw new Error("expected a problem");
    // The message names the title exactly as it will be sent, and the key it found in it.
    expect(describeSentTitleProblem(sent, problem)).toBe(
      'The title as it will be sent, "Add subject 03 (v2020.1.1)", has an author and a year in it ("v2020"): the version added to the title starts with a year, as a calendar version such as 2020.1.0 does, and the review refuses a title that reads that way.',
    );
  });

  test("an ordinary version is not read as a year, whatever its digits", () => {
    for (const version of [
      "1.0.1",
      "2.3.4",
      "10.2.3",
      "0.2020.0",
      "1.2019.1",
      "19.0.0",
      "2.0.20",
    ]) {
      expect(findSentTitleProblem(buildUpdateTitle(TYPED, version)), version).toBeNull();
    }
  });

  test("a version that starts with a year is refused, wherever the year sits in the date range", () => {
    for (const version of ["1900.1.0", "2019.12.1", "2020.1.0", "2099.0.0"]) {
      expect(findSentTitleProblem(buildUpdateTitle(TYPED, version))?.code, version).toBe(
        "author_year",
      );
    }
  });

  test("a release is titled by its version alone, and the same rule is asked of it", () => {
    expect(buildReleaseTitle("2.0.0")).toBe("Release v2.0.0");
    expect(findSentTitleProblem(buildReleaseTitle("2.0.0"))).toBeNull();
    expect(findSentTitleProblem(buildReleaseTitle("2020.1.1"))?.code).toBe("author_year");
  });

  test("the citation and the template rules are asked of the sent title in their own words", () => {
    expect(findSentTitleProblem("Described in 10.1038/s41597 (v1.0.1)")?.code).toBe("doi");
    expect(findSentTitleProblem("Add {{title}} data (v1.0.1)")?.code).toBe("template_field");
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The parsers, on what git really prints
// ---------------------------------------------------------------------------------------------

describe("the changed-file parsers", () => {
  test("the first changed path keeps its first character (nm000456 pull request 1)", () => {
    const dir = makeRepo({ "dataset_description.json": desc("1.0.0"), "README.md": "# x\n" });
    // A change in the work tree only: git reports it as " M dataset_description.json".
    write(dir, "dataset_description.json", desc("1.0.0", { Name: "Renamed" }));

    const raw = gitRaw(dir, "status", "--porcelain", "-z");
    expect(raw.startsWith(" M dataset_description.json\0")).toBe(true);
    expect(parsePorcelainPaths(raw)).toEqual(["dataset_description.json"]);

    // The reading this replaced, on this very repository: it trimmed the output as a block, which
    // removed the leading space of the first line only, and cut every line at its third character.
    // Kept to show the fixture is the case that broke it, so this test can fail.
    const replaced = gitRaw(dir, "status", "--porcelain")
      .trim()
      .split("\n")
      .map((line) => line.substring(3).trim());
    expect(replaced).toEqual(["ataset_description.json"]);
  });

  test("porcelain paths: modified, staged, untracked, deleted, renamed, odd names", () => {
    const dir = makeRepo({
      "dataset_description.json": desc("1.0.0"),
      "participants.tsv": "participant_id\nsub-01\n",
      "old name.tsv": "a\n",
      "gone.tsv": "b\n",
    });
    write(dir, "dataset_description.json", desc("1.0.0", { Name: "Renamed" })); // unstaged
    git(dir, "mv", "old name.tsv", "été run.tsv"); // staged rename
    rmSync(join(dir, "gone.tsv")); // unstaged delete
    write(dir, "sub-02/eeg/sub-02_task-rest_eeg.json", "{}\n"); // untracked, in a new directory
    write(dir, "new file.tsv", "c\n");
    git(dir, "add", "new file.tsv"); // staged add

    const paths = parsePorcelainPaths(gitRaw(dir, "status", "--porcelain", "-z")).sort();
    expect(paths).toEqual(
      ["dataset_description.json", "gone.tsv", "new file.tsv", "sub-02/", "été run.tsv"].sort(),
    );
    // A rename is the new path once: its original is not a changed path of its own.
    expect(paths).not.toContain("old name.tsv");
  });

  test("staged changes: added, modified and removed, with names git would quote", () => {
    const dir = makeRepo({
      "dataset_description.json": desc("1.0.0"),
      "gone.tsv": "b\n",
      "kept.tsv": "k\n",
    });
    write(dir, "dataset_description.json", desc("1.0.1"));
    rmSync(join(dir, "gone.tsv"));
    write(dir, "sub-03/été run.tsv", "x\n");
    write(dir, "CHANGES", "1.0.1 2026-10-16\n");
    git(dir, "add", "-A");

    const staged = parseStagedChanges(
      gitRaw(dir, "diff", "--cached", "--name-status", "-z", "--no-renames"),
    );
    expect([...staged].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { status: "added", path: "CHANGES" },
      { status: "modified", path: "dataset_description.json" },
      { status: "removed", path: "gone.tsv" },
      { status: "added", path: "sub-03/été run.tsv" },
    ]);
  });

  test("a rename reported with its two paths reads as the file that exists now", () => {
    const dir = makeRepo({
      "participants.tsv": "participant_id\nsub-01\nsub-02\n",
      "a.tsv": "z\n",
    });
    git(dir, "mv", "participants.tsv", "participants_v2.tsv");
    // No `--no-renames`: git pairs the two paths and prints "R100", the old path, the new path.
    const raw = gitRaw(dir, "diff", "--cached", "--name-status", "-z");
    expect(raw.startsWith("R100\0participants.tsv\0participants_v2.tsv\0")).toBe(true);
    expect(parseStagedChanges(raw)).toEqual([{ status: "modified", path: "participants_v2.tsv" }]);
  });

  test("nothing staged is no files", () => {
    expect(parseStagedChanges("")).toEqual([]);
    expect(parsePorcelainPaths("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The text the CLI builds around the author's
// ---------------------------------------------------------------------------------------------

function filesNamed(status: ChangedFile["status"], paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ status, path }));
}

describe("the changed-file summary", () => {
  test("a short list is named, with what happened to each file", () => {
    const files: ChangedFile[] = [
      { status: "modified", path: "participants.tsv" },
      { status: "added", path: "CHANGES" },
      { status: "removed", path: "sub-01/eeg/old.tsv" },
    ];
    expect(summarizeChangedFiles(files)).toBe(
      [
        "- `CHANGES` (added)",
        "- `participants.tsv` (modified)",
        "- `sub-01/eeg/old.tsv` (removed)",
      ].join("\n"),
    );
  });

  test("up to the limit is named; one more is a summary", () => {
    const paths = Array.from({ length: MAX_NAMED_FILES + 1 }, (_, i) => `sub-01/f${i}.tsv`);
    const atLimit = summarizeChangedFiles(filesNamed("added", paths.slice(0, MAX_NAMED_FILES)));
    expect(atLimit.split("\n")).toHaveLength(MAX_NAMED_FILES);
    expect(atLimit).toContain("`sub-01/f0.tsv` (added)");

    const over = summarizeChangedFiles(filesNamed("added", paths));
    expect(over).toContain("21 files changed: 21 added.");
    expect(over).not.toContain("f0.tsv");
  });

  test("a long list is a total, the files at the root by name, and a count per folder", () => {
    const files: ChangedFile[] = [
      ...filesNamed(
        "added",
        Array.from({ length: 30 }, (_, i) => `sub-01/eeg/sub-01_run-${i}_eeg.edf`),
      ),
      ...filesNamed(
        "modified",
        Array.from({ length: 5 }, (_, i) => `sub-02/eeg/sub-02_ch-${i}_channels.tsv`),
      ),
      { status: "modified", path: "dataset_description.json" },
      { status: "added", path: "CHANGES" },
    ];
    const summary = summarizeChangedFiles(files);
    expect(summary).toBe(
      [
        "37 files changed: 31 added, 6 modified.",
        "",
        "- `CHANGES` (added)",
        "- `dataset_description.json` (modified)",
        "- `sub-01/`: 30 files (30 added)",
        "- `sub-02/`: 5 files (5 modified)",
      ].join("\n"),
    );
    // Never the paths inside a folder: a bulk change must not bury the author's sentence.
    expect(summary).not.toContain("run-");
  });

  test("hundreds of folders stay a few lines", () => {
    const paths = Array.from({ length: 300 }, (_, i) => `sub-${String(i).padStart(3, "0")}/x.tsv`);
    const lines = summarizeChangedFiles(filesNamed("added", paths)).split("\n");
    expect(lines[0]).toBe("300 files changed: 300 added.");
    expect(lines[2]).toBe("- `sub-000/`: 1 file (1 added)");
    expect(lines[11]).toBe("- `sub-009/`: 1 file (1 added)");
    expect(lines[12]).toBe("- and 290 more folders (290 files)");
    expect(lines).toHaveLength(13);
  });

  test("files at the root beyond the limit are counted, not dumped", () => {
    const root25 = Array.from({ length: 25 }, (_, i) => `file-${String(i).padStart(2, "0")}.txt`);
    const summary = summarizeChangedFiles([
      ...filesNamed("added", root25),
      ...filesNamed("added", ["sub-01/a.tsv"]),
    ]);
    expect(summary).toContain("`file-19.txt` (added)");
    expect(summary).not.toContain("file-20.txt");
    expect(summary).toContain("- and 5 more files at the dataset root");
  });

  test("a change of four hundred thousand files in one folder is summarized whole", () => {
    // Copying the folder's array on every file is quadratic: a hundred thousand took six seconds,
    // after the branch was pushed and while the pull request spinner showed. Each file is now added
    // to its folder's list once. Nothing is timed. This is the smallest change the copying cannot
    // get through inside this file's test timeout, about ninety seconds of work against sixty, while
    // the list takes a fraction of a second: a regression fails this test by timeout.
    const paths = Array.from({ length: 400_000 }, (_, i) => `sub-01/eeg/run-${i}_eeg.json`);
    const summary = summarizeChangedFiles(filesNamed("added", paths));
    expect(summary).toBe(
      "400000 files changed: 400000 added.\n\n- `sub-01/`: 400000 files (400000 added)",
    );
  });

  test("a path cannot break out of its code span or its line", () => {
    const summary = summarizeChangedFiles([{ status: "added", path: "odd`name\nsecond line.tsv" }]);
    expect(summary).toBe("- `odd?name?second line.tsv` (added)");
  });
});

describe("the pull request title and body of an update", () => {
  test("the text of a pull request that could not be opened is shown indented, blank lines kept", () => {
    expect(describeUnopenedPullRequest("Add x (v1.0.1)", "First.\r\n\r\nSecond.")).toEqual([
      "  The pull request text, to paste into the GitHub page or `gh pr create`:",
      "  Title: Add x (v1.0.1)",
      "  Body:",
      "    First.",
      "",
      "    Second.",
    ]);
  });

  test("the title is the author's, then the version", () => {
    expect(buildUpdateTitle("Add twelve subjects", "1.0.1")).toBe("Add twelve subjects (v1.0.1)");
  });

  test("the body is the author's words, the version, and the accurate file list", () => {
    const body = buildUpdateBody({
      description: "  Adds sub-03 with a resting-state recording.  ",
      datasetId: "nm000456",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      files: [
        { status: "modified", path: "dataset_description.json" },
        { status: "added", path: "CHANGES" },
      ],
    });
    // Exactly this: so neither what that body said before (a heading, "## Dataset Update", that
    // says nothing) nor its path missing the first letter can be in it.
    expect(body).toBe(
      [
        "Adds sub-03 with a resting-state recording.",
        "",
        "Bumps nm000456 from 1.0.0 to 1.0.1.",
        "",
        "### Changed files",
        "",
        "- `CHANGES` (added)",
        "- `dataset_description.json` (modified)",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The CHANGES entry
// ---------------------------------------------------------------------------------------------

describe("hasChangelogHeading", () => {
  const headings = [
    "1.0.1 2026-10-16",
    "## 1.0.1",
    "[1.0.1] - 2026-10-16",
    "## [1.0.1]",
    "v1.0.1",
    "Version 1.0.1:",
    "release 1.0.1",
    "  1.0.1",
  ];
  const notHeadings = [
    "  - 1.0.1 fixed the sidecars",
    "1.0.10 2026-10-16",
    "1.0.1-beta",
    "1.0.1.2",
    "released 1.0.1 yesterday",
    "2026-10-16",
    "version history",
  ];
  for (const line of headings) {
    test(`${JSON.stringify(line)} is a heading for 1.0.1`, () => {
      expect(hasChangelogHeading(`1.0.0 2026-01-01\n${line}\n`, "1.0.1")).toBe(true);
    });
  }
  for (const line of notHeadings) {
    test(`${JSON.stringify(line)} is not a heading for 1.0.1`, () => {
      expect(hasChangelogHeading(`1.0.0 2026-01-01\n${line}\n`, "1.0.1")).toBe(false);
    });
  }
});

describe("addChangelogEntry", () => {
  const add = (existing: string | null) =>
    addChangelogEntry(existing, "1.0.1", "Add subject 03", "2026-10-16");

  test("a new log is the heading, a blank line and the author's title", () => {
    expect(add(null)).toBe("1.0.1 2026-10-16\n\n  - Add subject 03\n");
    expect(add("")).toBe("1.0.1 2026-10-16\n\n  - Add subject 03\n");
    expect(add("\n \n")).toBe("1.0.1 2026-10-16\n\n  - Add subject 03\n");
  });

  test("the newest entry goes first and the older ones are untouched", () => {
    expect(add("1.0.0 2026-01-01\n  - Initial release\n")).toBe(
      "1.0.1 2026-10-16\n\n  - Add subject 03\n\n1.0.0 2026-01-01\n  - Initial release\n",
    );
  });

  test("a title line above the entries stays above them", () => {
    expect(add("Revision history for the dataset\n\n1.0.0 2026-01-01\n  - Initial release\n")).toBe(
      "Revision history for the dataset\n\n1.0.1 2026-10-16\n\n  - Add subject 03\n\n1.0.0 2026-01-01\n  - Initial release\n",
    );
  });

  test("a log with no version heading gets the entry on top and keeps its text", () => {
    expect(add("Notes from the lab\n")).toBe(
      "1.0.1 2026-10-16\n\n  - Add subject 03\n\nNotes from the lab\n",
    );
  });

  test("a log with Windows line endings keeps them", () => {
    expect(add("1.0.0 2026-01-01\r\n  - Initial release\r\n")).toBe(
      "1.0.1 2026-10-16\r\n\r\n  - Add subject 03\r\n\r\n1.0.0 2026-01-01\r\n  - Initial release\r\n",
    );
  });

  test("the date is the author's calendar day", () => {
    expect(localIsoDate(new Date(2026, 9, 16, 23, 59, 59))).toBe("2026-10-16");
    expect(localIsoDate(new Date(2026, 0, 5, 0, 0, 1))).toBe("2026-01-05");
  });
});

describe("writeChangelogEntry", () => {
  function dirWith(files: Record<string, string>): string {
    const dir = fresh("changes");
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    return dir;
  }
  const entry = (dir: string) => writeChangelogEntry(dir, "1.0.1", "Add subject 03", "2026-10-16");

  test("creates CHANGES when the dataset has none", () => {
    const dir = dirWith({ "README.md": "# x\n" });
    expect(entry(dir)).toEqual({ file: "CHANGES", outcome: "created" });
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(
      "1.0.1 2026-10-16\n\n  - Add subject 03\n",
    );
  });

  test("adds to the CHANGES that is there", () => {
    const dir = dirWith({ CHANGES: "1.0.0 2026-01-01\n  - Initial release\n" });
    expect(entry(dir)).toEqual({ file: "CHANGES", outcome: "added" });
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(
      "1.0.1 2026-10-16\n\n  - Add subject 03\n\n1.0.0 2026-01-01\n  - Initial release\n",
    );
  });

  test("writes into CHANGES.md when that is the dataset's change log, and creates nothing else", () => {
    const dir = dirWith({ "CHANGES.md": "## 1.0.0\n- Initial release\n" });
    expect(entry(dir)).toEqual({ file: "CHANGES.md", outcome: "added" });
    expect(existsSync(join(dir, "CHANGES"))).toBe(false);
    expect(readFileSync(join(dir, "CHANGES.md"), "utf8").startsWith("1.0.1 2026-10-16\n")).toBe(
      true,
    );
  });

  test("prefers CHANGES to CHANGELOG.md when a dataset has both", () => {
    const dir = dirWith({ CHANGES: "1.0.0 2026-01-01\n", "CHANGELOG.md": "# Log\n" });
    expect(entry(dir).file).toBe("CHANGES");
  });

  test("an entry the author already wrote is left exactly as it is", () => {
    const authored = "1.0.1 2026-10-15\n\n  - Added subject 03 myself.\n\n1.0.0 2026-01-01\n";
    const dir = dirWith({ CHANGES: authored });
    expect(entry(dir)).toEqual({ file: "CHANGES", outcome: "present" });
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(authored);
  });

  test("an entry in any change log counts, as the review reads them all as one", () => {
    const dir = dirWith({ CHANGES: "1.0.0 2026-01-01\n", "CHANGELOG.md": "## 1.0.1\n- Done.\n" });
    // The line the author reads names the file that HAS the entry, not the one that would be written.
    expect(entry(dir)).toEqual({ file: "CHANGELOG.md", outcome: "present" });
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe("1.0.0 2026-01-01\n");
  });

  test("refuses a change log that is a directory, rather than writing beside it", () => {
    const dir = dirWith({ "CHANGES/keep.txt": "x\n" });
    expect(() => entry(dir)).toThrow("CHANGES exists but is not a regular file");
  });

  test("refuses a change log that is a symbolic link, rather than writing through it", () => {
    const dir = dirWith({ "target.txt": "1.0.0 2026-01-01\n" });
    symlinkSync(join(dir, "target.txt"), join(dir, "CHANGES"));
    expect(() => entry(dir)).toThrow("CHANGES exists but is not a regular file");
    expect(readFileSync(join(dir, "target.txt"), "utf8")).toBe("1.0.0 2026-01-01\n");
  });

  test("a directory beside a regular change log is ignored, as the review ignores it", () => {
    const dir = dirWith({ CHANGES: "1.0.0 2026-01-01\n", "CHANGELOG/keep.txt": "x\n" });
    expect(entry(dir)).toEqual({ file: "CHANGES", outcome: "added" });
  });

  test("refuses a change log that is not valid UTF-8, and leaves its bytes alone", () => {
    const dir = dirWith({});
    const latin1 = Buffer.from("1.0.0 2026-01-01\n  - Caf\xe9 data by Ren\xe9\n", "latin1");
    writeFileSync(join(dir, "CHANGES"), latin1);
    expect(() => entry(dir)).toThrow("CHANGES is not valid UTF-8");
    expect(readFileSync(join(dir, "CHANGES")).equals(latin1)).toBe(true);
  });

  test("refuses a change log that starts with a byte order mark, and leaves it alone", () => {
    // The review reads a heading behind the mark as plain text, so an entry written above the
    // old headings would not count, and one written below them would sit under the wrong release.
    const withMark = "\uFEFF1.0.0 2026-01-01\n  - Initial release\n\n0.9.0 2025-01-01\n  - Older\n";
    const dir = dirWith({ CHANGES: withMark });
    expect(() => entry(dir)).toThrow("CHANGES starts with a byte order mark");
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(withMark);
  });

  test("an encoding it would not write into is no reason to refuse when the entry is there", () => {
    const dir = dirWith({
      CHANGES: "\uFEFF1.0.0 2026-01-01\n",
      "CHANGELOG.md": "## 1.0.1\n- Done.\n",
    });
    expect(entry(dir)).toEqual({ file: "CHANGELOG.md", outcome: "present" });
  });

  test("inspectChangelog reads the state and writes nothing", () => {
    const dir = dirWith({ CHANGES: "1.0.0 2026-01-01\n", "CHANGES.md": "## 1.0.1\n" });
    expect(inspectChangelog(dir, "1.0.1")).toEqual({
      file: "CHANGES",
      text: "1.0.0 2026-01-01\n",
      presentIn: "CHANGES.md",
    });
    expect(inspectChangelog(dir, "1.0.2").presentIn).toBeNull();
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe("1.0.0 2026-01-01\n");

    const none = dirWith({ "README.md": "# x\n" });
    expect(inspectChangelog(none, "1.0.1")).toEqual({ file: null, text: null, presentIn: null });
    expect(existsSync(join(none, "CHANGES"))).toBe(false);
  });

  test("says in a line what it did", () => {
    expect(describeChangelogWrite({ file: "CHANGES", outcome: "created" }, "1.0.1")).toBe(
      "Created CHANGES with an entry for 1.0.1",
    );
    expect(describeChangelogWrite({ file: "CHANGES", outcome: "added" }, "1.0.1")).toBe(
      "Added an entry for 1.0.1 to CHANGES",
    );
    expect(describeChangelogWrite({ file: "CHANGES.md", outcome: "present" }, "1.0.1")).toBe(
      "CHANGES.md already has an entry for 1.0.1; left as it is",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The review reads what the writer wrote
// ---------------------------------------------------------------------------------------------

describe("the review's own reader on a pull request update would open", () => {
  /** What `update` does to a clone on `main`: branch, bump, write the entry, stage, commit. */
  function updateAsTheCliDoes(dir: string): { base: string; head: string } {
    const base = git(dir, "rev-parse", "main");
    git(dir, "checkout", "-q", "-b", "update/x");
    write(dir, "dataset_description.json", desc("1.0.1"));
    writeChangelogEntry(dir, "1.0.1", "Add subject 03", "2026-10-16");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Add subject 03");
    return { base, head: git(dir, "rev-parse", "HEAD") };
  }

  const base = { "dataset_description.json": desc("1.0.0"), "README.md": "# x\n" };

  const scenarios: [string, Record<string, string>][] = [
    ["no change log at all", base],
    ["an empty CHANGES", { ...base, CHANGES: "" }],
    [
      "a CHANGES with earlier entries",
      { ...base, CHANGES: "1.0.0 2026-01-01\n - Initial release\n" },
    ],
    ["only a CHANGES.md", { ...base, "CHANGES.md": "## 1.0.0\n- Initial release\n" }],
    [
      "a title above the entries",
      { ...base, CHANGES: "Revision history\n\n1.0.0 2026-01-01\n  - Initial release\n" },
    ],
    ["Windows line endings", { ...base, CHANGES: "1.0.0 2026-01-01\r\n  - Initial release\r\n" }],
  ];

  for (const [name, files] of scenarios) {
    test(`${name}: the review sees a new heading for the version`, () => {
      const dir = makeRepo(files);
      const { base: baseSha, head } = updateAsTheCliDoes(dir);
      const facts = gatherGitFacts(dir, baseSha, head);
      expect(facts.changelogEntry).toBe("added");
      expect(facts.changelogTouched).toBe(true);
      expect(facts.versionBefore).toBe("1.0.0");
      expect(facts.versionAfter).toBe("1.0.1");
    });
  }

  test("an entry the author wrote first is the one the review sees", () => {
    const dir = makeRepo({ ...base, CHANGES: "1.0.0 2026-01-01\n  - Initial release\n" });
    const baseSha = git(dir, "rev-parse", "main");
    git(dir, "checkout", "-q", "-b", "update/x");
    const authored = "1.0.1 2026-10-15\n\n  - Added subject 03 myself.\n\n1.0.0 2026-01-01\n";
    write(dir, "CHANGES", authored);
    write(dir, "dataset_description.json", desc("1.0.1"));
    expect(writeChangelogEntry(dir, "1.0.1", "Add subject 03", "2026-10-16").outcome).toBe(
      "present",
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Add subject 03");
    const facts = gatherGitFacts(dir, baseSha, git(dir, "rev-parse", "HEAD"));
    expect(facts.changelogEntry).toBe("added");
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(authored);
  });

  test("control: without the entry the same review says it is missing", () => {
    // The reader is not saying "added" for everything: bump the version and write nothing.
    const withLog = makeRepo({ ...base, CHANGES: "1.0.0 2026-01-01\n  - Initial release\n" });
    const withoutLog = makeRepo(base);
    for (const [dir, expected] of [
      [withLog, "not_added"],
      [withoutLog, "no_file"],
    ] as const) {
      const baseSha = git(dir, "rev-parse", "main");
      git(dir, "checkout", "-q", "-b", "update/x");
      write(dir, "dataset_description.json", desc("1.0.1"));
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "bump");
      expect(gatherGitFacts(dir, baseSha, git(dir, "rev-parse", "HEAD")).changelogEntry).toBe(
        expected,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The commands, through the real entry point
// ---------------------------------------------------------------------------------------------

const DATASET_ID = "xx000000"; // two letters and six digits, and in no band a dataset is given
const STANDIN_REPO = "nemar-pr-text-standin/xx000000"; // a repository that is not there

let binDir: string;
let ghRecord: string;
let api: ReturnType<typeof Bun.serve>;
let apiPaths: string[] = [];
/** The version the stand-in API reports as the dataset's current one, for `release`. */
let releaseCurrentVersion = "v1.0.0";

const GH_STANDIN = `#!/bin/sh
# Stands in for the GitHub CLI: answers the version probe, records \`pr create\`, prints a URL.
if [ "$1" = "--version" ]; then echo "gh version 0.0.0 (stand-in)"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\0' "$@" > "$STANDIN_GH_RECORD"
  if [ -n "$STANDIN_GH_FAIL" ]; then echo "stand-in gh: the pull request was refused" >&2; exit 1; fi
  echo "https://github.invalid/standin/pull/1"
  exit 0
fi
echo "stand-in gh: unexpected arguments: $*" >&2
exit 2
`;

beforeAll(() => {
  binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "gh"), GH_STANDIN);
  chmodSync(join(binDir, "gh"), 0o755);
  ghRecord = join(root, "gh-record");

  api = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      apiPaths.push(path);
      if (path === "/notices") return Response.json({ notices: [] });
      if (path === `/datasets/${DATASET_ID}`) {
        return Response.json({
          dataset: {
            id: 1,
            dataset_id: DATASET_ID,
            name: "A dataset the stand-in API describes",
            description: null,
            owner_username: "standin",
            status: "active",
            visibility: "public",
            github_repo: STANDIN_REPO,
            concept_doi: null,
            created_at: "2026-01-01",
          },
        });
      }
      if (path === `/datasets/${DATASET_ID}/versions`) {
        return Response.json({
          dataset_id: DATASET_ID,
          current_version: releaseCurrentVersion,
          versions: [],
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  api.stop(true);
});

function apiUrl(): string {
  return api.url.toString().replace(/\/$/, "");
}

/** A configuration directory: signed in as a stand-in account, or pointing at the stand-in API only. */
function configDir(signedIn: boolean): string {
  const dir = fresh("config");
  mkdirSync(dir, { recursive: true });
  const account = signedIn
    ? { apiKey: "standin-key-0123456789abcdef", apiUrl: apiUrl() }
    : { apiUrl: apiUrl() };
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ activeAccount: "standin", accounts: { standin: account } }),
  );
  return dir;
}

/** The zone this process computes dates in, which a child must share to agree on the day. */
function zoneOfThisProcess(): string {
  const set = process.env.TZ;
  return set && set !== "undefined" ? set : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** What the CLI is run with: nothing inherited that could point it at a real service or account. */
function cleanEnv(
  config: string,
  term = "dumb",
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? root,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NEMAR_CONFIG_DIR: config,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    TERM: term,
    // The CHANGES date is the author's calendar day. Other suites in a shared `bun test` process
    // change this process's zone, so the child is given the zone the test computes its dates in.
    TZ: zoneOfThisProcess(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.org",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.org",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GH_CONFIG_DIR: join(root, "gh-config"),
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    STANDIN_GH_RECORD: ghRecord,
    ...extra,
  };
}

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The CLI, with no terminal on stdin, as a script or CI runs it. */
async function runNemar(
  args: string[],
  cwd: string,
  config = configDir(true),
  extraEnv: Record<string, string> = {},
): Promise<Run> {
  rmSync(ghRecord, { force: true });
  apiPaths = [];
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd,
    env: cleanEnv(config, "dumb", extraEnv),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** The arguments the stand-in `gh` was run with for `pr create`, or null if it never was. */
function ghArgs(): string[] | null {
  if (!existsSync(ghRecord)) return null;
  return readFileSync(ghRecord, "utf8").split("\0").slice(0, -1);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

/** A dataset clone on `main` at 1.0.0, with a local bare remote named like a dataset repository. */
function newClone(): { work: string; remote: string } {
  const base = fresh("clone");
  const remote = join(base, "remote", `${DATASET_ID}.git`);
  const work = join(base, "work");
  mkdirSync(remote, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  write(work, "dataset_description.json", desc("1.0.0"));
  write(work, "README.md", "# Resting EEG\n");
  write(work, "participants.tsv", "participant_id\nsub-01\nsub-02\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "-u", "origin", "main");
  return { work, remote };
}

const GOOD_TITLE = "Add subject 03 and rename the dataset";
const GOOD_DESCRIPTION =
  "Adds sub-03 with a resting-state recording and gives the dataset its final name.";

describe("nemar dataset update shows the new options", () => {
  test("--help names the title and the description as required", async () => {
    const { stdout, exitCode } = await runNemar(["dataset", "update", "--help"], REPO_ROOT);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-m, --message <title>");
    expect(stdout).toContain("--description <text>");
    expect(stdout).toContain("(required)");
  });
});

describe("nemar dataset update refuses before it does anything", () => {
  const signedOut = () => configDir(false);

  /** Output as a person would see it: stdout and stderr together. */
  const said = (r: Run) => r.stdout + r.stderr;

  test("refuses to run under --yes without a description", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(["dataset", "update", "--yes", "-m", GOOD_TITLE], cwd, signedOut());
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("needs a pull request title and description; missing --description.");
    // No terminal and --yes: both are true, and the line says so.
    expect(said(r)).toContain(
      "--yes does not stand in for them, and without a terminal nothing can ask for them: pass both.",
    );
    expect(said(r)).toContain('Example: nemar dataset update -m "');
    // Refused first: not "Not authenticated", not a repository error, and no request but the notice.
    expect(said(r)).not.toContain("Not authenticated");
    expect(said(r)).not.toContain("Not a git repository");
    expect(apiPaths.filter((p) => p !== "/notices")).toEqual([]);
    // A refusal of what was typed is not a bug, so no invitation to file one.
    expect(r.stderr).not.toContain("attach the log");
  });

  test("refuses under --yes without a title", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "--description", GOOD_DESCRIPTION],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("missing --message.");
  });

  test("names both when both are missing", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(["dataset", "update", "--yes"], cwd, signedOut());
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("missing --message and --description.");
  });

  test("refuses without a terminal even when --yes is not given", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(["dataset", "update"], cwd, signedOut());
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("missing --message and --description.");
    // Without --yes the only reason is the missing terminal, so --yes is not blamed.
    expect(said(r)).toContain("Without a terminal nothing can ask for them: pass both.");
    expect(said(r)).not.toContain("--yes does not stand in");
  });

  test("refuses the CLI's own placeholder, and says so", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", "Save changes", "--description", GOOD_DESCRIPTION],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      'The title (--message) is placeholder text ("Save changes"); say what actually changed.',
    );
    expect(said(r)).not.toContain("The description");
  });

  test("refuses the title of nm000456 pull request 1", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", NM000456_TITLE, "--description", GOOD_DESCRIPTION],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain('still has an unfilled template field ("FirstAuthorSurname")');
  });

  test("refuses a title that has a name and a year in it, and says what to write", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "-m",
        "Lee2019 EEG dataset",
        "--description",
        GOOD_DESCRIPTION,
      ],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      'The title (--message) has a citation (an author and a year, or a DOI) in it ("Lee2019"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.',
    );
    expect(said(r)).not.toContain("The description");
    // Refused before sign-in, like every other refusal of the text.
    expect(said(r)).not.toContain("Not authenticated");
  });

  test("refuses a dataset's own name and a year too, an acronym among them", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "-m",
        "BNCI2014_001 recordings",
        "--description",
        GOOD_DESCRIPTION,
      ],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      'The title (--message) has a citation (an author and a year, or a DOI) in it ("BNCI2014"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.',
    );
    expect(said(r)).not.toContain("Not authenticated");
  });

  test("refuses the same name later in a title too, before sign-in", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "-m",
        "Add the BNCI2014_001 recordings",
        "--description",
        GOOD_DESCRIPTION,
      ],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      'The title (--message) has a citation (an author and a year, or a DOI) in it ("BNCI2014"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.',
    );
    expect(said(r)).not.toContain("Not authenticated");
  });

  test("refuses a DOI in the title in the same words, before sign-in", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "-m",
        "Described in 10.1038/s41597-020-0532-5",
        "--description",
        GOOD_DESCRIPTION,
      ],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      'The title (--message) has a citation (an author and a year, or a DOI) in it ("10.1038/"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.',
    );
    expect(said(r)).not.toContain("Not authenticated");
  });

  test("control: a number with a dot is no DOI, so it meets sign-in", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "-m",
        "Add recordings of 10.5 Hz tones",
        "--description",
        GOOD_DESCRIPTION,
      ],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("Not authenticated");
    expect(said(r)).not.toContain("has a citation");
  });

  test("control: a year after a space is a sentence, so it meets sign-in", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "-m",
        "Add the 2019 recordings",
        "--description",
        GOOD_DESCRIPTION,
      ],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("Not authenticated");
    expect(said(r)).not.toContain("has a citation");
  });

  test("an empty description is text that was given and got wrong, not text left out", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", GOOD_TITLE, "--description", ""],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("The description (--description) is empty");
    expect(said(r)).not.toContain("missing");
  });

  test("control: readable text gets past the check and meets the next one, sign-in", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", GOOD_TITLE, "--description", GOOD_DESCRIPTION],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("Not authenticated");
    expect(said(r)).not.toContain("pull request title and description");
  });

  test("a description with a template token is accepted and meets sign-in", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "-m",
        GOOD_TITLE,
        "--description",
        "Documents the ${LAB_PREFIX} variable and the FirstAuthorSurname-year naming template.",
      ],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("Not authenticated");
    expect(said(r)).not.toContain("The description");
  });

  describe("the title as it will be sent, with the version after it", () => {
    /** A clone whose version is `version`, with a change for `update` to describe. */
    function cloneAt(version: string): string {
      const { work } = newClone();
      write(work, "dataset_description.json", desc(version));
      return work;
    }
    const update = (cwd: string, title = "Add subject 03") =>
      runNemar(
        ["dataset", "update", "--yes", "-m", title, "--description", GOOD_DESCRIPTION],
        cwd,
        signedOut(),
      );

    test("a calendar version is refused before sign-in, and the message names the title as sent", async () => {
      const work = cloneAt("2020.1.0");
      const r = await update(work);
      expect(r.exitCode).toBe(1);
      expect(said(r)).toContain(
        'The title as it will be sent, "Add subject 03 (v2020.1.1)", has an author and a year in it ("v2020")',
      );
      expect(said(r)).toContain("Nothing was changed.");
      expect(said(r)).not.toContain("Not authenticated");
      // Nothing was pushed, committed or branched: the clone is as it was.
      expect(ghArgs()).toBeNull();
      expect(git(work, "branch", "--list", "update/*")).toBe("");
      expect(git(work, "log", "-1", "--format=%s")).toBe("initial");
    });

    test("the version the bump gives is the one in the message", async () => {
      const work = cloneAt("2020.1.0");
      const r = await runNemar(
        [
          "dataset",
          "update",
          "--yes",
          "--bump",
          "minor",
          "-m",
          "Add subject 03",
          "--description",
          GOOD_DESCRIPTION,
        ],
        work,
        signedOut(),
      );
      expect(r.exitCode).toBe(1);
      expect(said(r)).toContain('"Add subject 03 (v2020.2.0)"');
    });

    test("control: an ordinary version, and the same title, meets sign-in", async () => {
      const work = cloneAt("2.0.3");
      const r = await update(work);
      expect(r.exitCode).toBe(1);
      expect(said(r)).toContain("Not authenticated");
      expect(said(r)).not.toContain("as it will be sent");
    });

    test("a clone whose version cannot be read is left to the later steps, which say so", async () => {
      const { work } = newClone();
      write(work, "dataset_description.json", '{"Name": "No version here"}\n');
      const r = await update(work);
      expect(r.exitCode).toBe(1);
      expect(said(r)).not.toContain("as it will be sent");
      expect(said(r)).toContain("Not authenticated");
    });
  });
});

describe("nemar dataset release asks about the title it sends", () => {
  const said = (r: Run) => r.stdout + r.stderr;

  test("a calendar version is refused before anything is changed", async () => {
    const { work } = newClone();
    releaseCurrentVersion = "v2020.1.0";
    try {
      const r = await runNemar(
        ["dataset", "release", DATASET_ID, "--version", "2020.1.1", "--dir", work, "--yes"],
        work,
      );
      expect(r.exitCode).toBe(1);
      expect(said(r)).toContain(
        'The title as it will be sent, "Release v2020.1.1", has an author and a year in it ("v2020")',
      );
      expect(said(r)).toContain("Nothing was changed.");
      expect(ghArgs()).toBeNull();
      expect(git(work, "branch", "--list", "release/*")).toBe("");
    } finally {
      releaseCurrentVersion = "v1.0.0";
    }
  });

  test("control: an ordinary version opens the pull request with the same title", async () => {
    const { work } = newClone();
    const r = await runNemar(
      ["dataset", "release", DATASET_ID, "--version", "2.0.0", "--dir", work, "--yes"],
      work,
    );
    expect(r.exitCode, said(r)).toBe(0);
    expect(valueAfter(ghArgs() ?? [], "--title")).toBe("Release v2.0.0");
    expect(said(r)).not.toContain("as it will be sent");
  });
});

describe("nemar dataset update opens a pull request a person can read", () => {
  test("title, CHANGES entry, commit and body all carry the author's words", async () => {
    const { work, remote } = newClone();
    // A change in the work tree only comes first in git's list: the case that lost a letter.
    write(work, "dataset_description.json", desc("1.0.0", { Name: "Resting EEG, final name" }));
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');

    const before = localIsoDate(new Date());
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "--branch",
        "update/pr-text-test",
        "-m",
        GOOD_TITLE,
        "--description",
        GOOD_DESCRIPTION,
      ],
      work,
    );
    const after = localIsoDate(new Date());
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);

    // The file list the person sees before confirming has every path whole.
    expect(r.stdout).toMatch(/^ {4}dataset_description\.json$/m);
    expect(r.stdout).not.toMatch(/^ {4}ataset_description\.json$/m);
    expect(r.stdout).toContain("Created CHANGES with an entry for 1.0.1");
    expect(r.stdout).toContain("https://github.invalid/standin/pull/1");

    // The pull request, as the GitHub CLI was asked to open it.
    const args = ghArgs();
    expect(args?.slice(0, 2)).toEqual(["pr", "create"]);
    expect(valueAfter(args ?? [], "--repo")).toBe(STANDIN_REPO);
    expect(valueAfter(args ?? [], "--head")).toBe("update/pr-text-test");
    expect(valueAfter(args ?? [], "--base")).toBe("main");
    expect(valueAfter(args ?? [], "--title")).toBe(`${GOOD_TITLE} (v1.0.1)`);
    expect(valueAfter(args ?? [], "--body")).toBe(
      [
        GOOD_DESCRIPTION,
        "",
        `Bumps ${DATASET_ID} from 1.0.0 to 1.0.1.`,
        "",
        "### Changed files",
        "",
        "- `CHANGES` (added)",
        "- `dataset_description.json` (modified)",
        "- `sub-03/eeg/sub-03_task-rest_eeg.json` (added)",
      ].join("\n"),
    );

    // The branch is on the remote, with the author's title as the commit and the entry in CHANGES.
    expect(git(remote, "rev-parse", "--verify", "refs/heads/update/pr-text-test")).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(git(work, "log", "-1", "--format=%s", "update/pr-text-test")).toBe(GOOD_TITLE);
    const changes = git(work, "show", "update/pr-text-test:CHANGES");
    const dated = changes.match(/^1\.0\.1 (\d{4}-\d{2}-\d{2})\n\n {2}- (.*)$/);
    expect(dated?.[2]).toBe(GOOD_TITLE);
    // The author's calendar day, which may roll over between `before` and `after` at midnight.
    expect([before, after].includes(dated?.[1] ?? "")).toBe(true);
    const written = JSON.parse(git(work, "show", "update/pr-text-test:dataset_description.json"));
    expect(written.Version).toBe("1.0.1");
    expect(written.Name).toBe("Resting EEG, final name");

    // And the review's own reader finds the entry.
    const facts = gatherGitFacts(
      work,
      git(work, "rev-parse", "main"),
      git(work, "rev-parse", "update/pr-text-test"),
    );
    expect(facts.changelogEntry).toBe("added");
  });

  test("a padded, two-line title is one line in the commit, in CHANGES and in the pull request", async () => {
    const { work } = newClone();
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "--branch",
        "update/pr-text-title",
        "-m",
        "  Add  subject 03\nand rename the dataset ",
        "--description",
        GOOD_DESCRIPTION,
      ],
      work,
    );
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(git(work, "log", "-1", "--format=%s", "update/pr-text-title")).toBe(GOOD_TITLE);
    expect(git(work, "show", "update/pr-text-title:CHANGES")).toContain(`  - ${GOOD_TITLE}`);
    expect(valueAfter(ghArgs() ?? [], "--title")).toBe(`${GOOD_TITLE} (v1.0.1)`);
  });

  test("a bulk change is summarized by folder, not dumped as paths", async () => {
    const { work } = newClone();
    for (let i = 0; i < 25; i++) {
      write(work, `sub-04/eeg/sub-04_run-${i}_eeg.json`, "{}\n");
    }
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "--branch",
        "update/pr-text-bulk",
        "-m",
        "Add subject 04",
        "--description",
        "Adds the 25 runs of sub-04.",
      ],
      work,
    );
    expect(r.exitCode).toBe(0);
    const body = valueAfter(ghArgs() ?? [], "--body") ?? "";
    expect(body).toContain("27 files changed: 26 added, 1 modified.");
    expect(body).toContain("- `CHANGES` (added)");
    expect(body).toContain("- `dataset_description.json` (modified)");
    expect(body).toContain("- `sub-04/`: 25 files (25 added)");
    expect(body).not.toContain("run-");
  });
});

describe("nemar dataset update looks at the change log before it changes anything", () => {
  const said = (r: Run) => r.stdout + r.stderr;

  /** A clone whose change log is made by `make`, with a README edit for `update` to describe. */
  function cloneWithChangelog(make: (work: string) => void): { work: string; remote: string } {
    const clone = newClone();
    make(clone.work);
    git(clone.work, "add", "-A");
    git(clone.work, "commit", "-q", "-m", "add the change log");
    git(clone.work, "push", "-q", "origin", "main");
    write(clone.work, "README.md", "# Resting EEG, revised\n");
    return clone;
  }

  async function refusedWithNothingChanged(work: string, remote: string, why: string) {
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "--branch",
        "update/pr-text-changelog",
        "-m",
        GOOD_TITLE,
        "--description",
        GOOD_DESCRIPTION,
      ],
      work,
    );
    expect(r.exitCode, said(r)).toBe(1);
    expect(said(r)).toContain(why);
    expect(said(r)).toContain("Nothing was changed.");
    // The work tree is as the author left it: no branch, no version bump, no push, no pull request.
    expect(git(work, "branch", "--show-current")).toBe("main");
    const written = JSON.parse(readFileSync(join(work, "dataset_description.json"), "utf8"));
    expect(written.Version).toBe("1.0.0");
    expect(gitRaw(work, "status", "--porcelain")).toBe(" M README.md\n");
    expect(git(remote, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
      "refs/heads/main",
    );
    expect(ghArgs()).toBeNull();
    // A verdict about the dataset, not a bug in the CLI: no invitation to file one.
    expect(r.stderr).not.toContain("attach the log");
  }

  test("a change log that is a link stops the command before it branches or bumps", async () => {
    const { work, remote } = cloneWithChangelog((w) => {
      write(w, "target.txt", "1.0.0 2026-01-01\n");
      symlinkSync("target.txt", join(w, "CHANGES"));
    });
    await refusedWithNothingChanged(work, remote, "CHANGES exists but is not a regular file");
  });

  test("a change log in another encoding stops the command, and its bytes stay as they were", async () => {
    const latin1 = Buffer.from("1.0.0 2026-01-01\n  - Caf\xe9 data by Ren\xe9\n", "latin1");
    const { work, remote } = cloneWithChangelog((w) => writeFileSync(join(w, "CHANGES"), latin1));
    await refusedWithNothingChanged(work, remote, "CHANGES is not valid UTF-8");
    expect(readFileSync(join(work, "CHANGES")).equals(latin1)).toBe(true);
  });

  test("a change log that starts with a byte order mark stops the command", async () => {
    const { work, remote } = cloneWithChangelog((w) =>
      write(w, "CHANGES", "\uFEFF1.0.0 2026-01-01\n  - Initial release\n"),
    );
    await refusedWithNothingChanged(work, remote, "CHANGES starts with a byte order mark");
  });
});

describe("when the pull request cannot be opened, the text is not lost", () => {
  const said = (r: Run) => r.stdout + r.stderr;
  const refused = { STANDIN_GH_FAIL: "1" };

  test("update shows the title and the body it could not send", async () => {
    const { work } = newClone();
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", GOOD_TITLE, "--description", GOOD_DESCRIPTION],
      work,
      undefined,
      refused,
    );
    expect(said(r)).toContain("Failed to create PR");
    expect(said(r)).toContain("Create the PR manually.");
    expect(said(r)).toContain(`  Title: ${GOOD_TITLE} (v1.0.1)`);
    expect(said(r)).toContain(`    ${GOOD_DESCRIPTION}`);
    expect(said(r)).toContain("    ### Changed files");
  });

  test("push --pr shows the title and the body it could not send, and exits non-zero", async () => {
    const { work } = newAnnexFeatureClone();
    const r = await runNemar(
      ["dataset", "push", "--pr", "--no-s3", "-t", GOOD_TITLE, "-b", GOOD_DESCRIPTION],
      work,
      undefined,
      refused,
    );
    expect(r.exitCode, said(r)).toBe(1);
    expect(said(r)).toContain("Failed to create pull request");
    expect(said(r)).toContain(`  Title: ${GOOD_TITLE}`);
    expect(said(r)).toContain(`    ${GOOD_DESCRIPTION}`);
  });
});

/** A git-annex clone on a feature branch with one commit nobody has pushed, and an empty remote. */
function newAnnexFeatureClone(): { work: string; remote: string } {
  const base = fresh("annex");
  const remote = join(base, "remote");
  const work = join(base, "work");
  mkdirSync(remote, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  git(work, "annex", "init", "test-repo");
  write(work, "README.md", "# Resting EEG\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", remote);
  git(work, "checkout", "-q", "-b", "feature/new-recordings");
  write(work, "participants.tsv", "participant_id\nsub-01\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "add participants");
  return { work, remote };
}

describe("nemar dataset push shows the new options", () => {
  test("--help names the title and the body as required with --pr", async () => {
    const { stdout, exitCode } = await runNemar(["dataset", "push", "--help"], REPO_ROOT);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-t, --title <title>");
    expect(stdout).toContain("-b, --body <body>");
    expect(stdout).toContain("required");
  });
});

describe("nemar dataset push --pr settles the text before it pushes", () => {
  const said = (r: Run) => r.stdout + r.stderr;
  const pushed = (remote: string) => git(remote, "for-each-ref", "refs/heads");

  test("refuses without a title and a body, and pushes nothing", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(["dataset", "push", "--pr", "--no-s3"], work);
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      "nemar dataset push --pr needs a pull request title and description; missing --title and --body.",
    );
    expect(said(r)).toContain("Without a terminal nothing can ask for them: pass both.");
    expect(pushed(remote)).toBe("");
    expect(ghArgs()).toBeNull();
  });

  test("refuses the placeholder title this command used to write", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(
      [
        "dataset",
        "push",
        "--pr",
        "--no-s3",
        "-t",
        "Update from branch feature/new-recordings",
        "-b",
        GOOD_DESCRIPTION,
      ],
      work,
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("The title (--title) is placeholder text");
    expect(pushed(remote)).toBe("");
    expect(ghArgs()).toBeNull();
  });

  test("refuses a title that has a name and a year in it, and pushes nothing", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(
      ["dataset", "push", "--pr", "--no-s3", "-t", "Lee-2019-EEG", "-b", GOOD_DESCRIPTION],
      work,
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      'The title (--title) has a citation (an author and a year, or a DOI) in it ("Lee-2019"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.',
    );
    expect(pushed(remote)).toBe("");
    expect(ghArgs()).toBeNull();
  });

  test("refuses a title with a DOI in it, and pushes nothing", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(
      [
        "dataset",
        "push",
        "--pr",
        "--no-s3",
        "-t",
        "Add the recordings from doi:10.7910/DVN/ABC123",
        "-b",
        GOOD_DESCRIPTION,
      ],
      work,
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      'The title (--title) has a citation (an author and a year, or a DOI) in it ("10.7910/"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.',
    );
    expect(pushed(remote)).toBe("");
    expect(ghArgs()).toBeNull();
  });

  test("an empty body is refused, not sent", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(
      ["dataset", "push", "--pr", "--no-s3", "-t", GOOD_TITLE, "-b", ""],
      work,
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("The description (--body) is empty");
    expect(pushed(remote)).toBe("");
  });

  test("opens the pull request with exactly the text it was given", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(
      ["dataset", "push", "--pr", "--no-s3", "-t", GOOD_TITLE, "-b", GOOD_DESCRIPTION],
      work,
    );
    expect(r.exitCode).toBe(0);
    expect(pushed(remote)).toContain("refs/heads/feature/new-recordings");
    expect(ghArgs()).toEqual(["pr", "create", "--title", GOOD_TITLE, "--body", GOOD_DESCRIPTION]);
    expect(ghArgs()?.join(" ")).not.toContain("Update from branch");
  });

  test("on main there is no pull request to describe, so no text is asked for", async () => {
    const { work, remote } = newAnnexFeatureClone();
    git(work, "checkout", "-q", "main");
    const r = await runNemar(["dataset", "push", "--pr", "--no-s3"], work);
    expect(r.exitCode).toBe(0);
    expect(said(r)).toContain("Skipping PR: already on main branch");
    expect(pushed(remote)).toContain("refs/heads/main");
    expect(ghArgs()).toBeNull();
  });

  test("on master, as on main, there is no pull request to describe", async () => {
    const { work, remote } = newAnnexFeatureClone();
    git(work, "checkout", "-q", "-b", "master");
    const r = await runNemar(["dataset", "push", "--pr", "--no-s3"], work);
    expect(r.exitCode, said(r)).toBe(0);
    expect(said(r)).toContain("Skipping PR: already on main branch");
    expect(pushed(remote)).toContain("refs/heads/master");
    expect(ghArgs()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// At a terminal, the command asks
// ---------------------------------------------------------------------------------------------

interface Terminal {
  /** What the person would see so far, with control sequences removed. */
  seen(): string;
  type(text: string): void;
  /** Wait until `needle` appears after everything already waited for. */
  until(needle: string): Promise<void>;
  exited: Promise<number>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control sequences
const CONTROL_SEQUENCES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[=>]|\r/g;

/** The CLI on a pseudo-terminal, so `process.stdin.isTTY` is true and its prompts are real. */
function onTerminal(args: string[], cwd: string, config = configDir(true)): Terminal {
  rmSync(ghRecord, { force: true });
  apiPaths = [];
  let raw = "";
  const proc = Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    cwd,
    env: cleanEnv(config, "xterm-256color"),
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal: unknown, chunk: Uint8Array) {
        raw += new TextDecoder().decode(chunk);
      },
    },
  } as never) as unknown as {
    terminal: { write(text: string): void };
    exited: Promise<number>;
    kill(): void;
  };
  const seen = () => raw.replace(CONTROL_SEQUENCES, "");
  let from = 0;
  const giveUp = setTimeout(() => proc.kill(), 50_000);
  return {
    seen,
    type: (text) => proc.terminal.write(text),
    async until(needle) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const at = seen().indexOf(needle, from);
        if (at >= 0) {
          from = at + needle.length;
          return;
        }
        await Bun.sleep(25);
      }
      throw new Error(`Timed out waiting for ${JSON.stringify(needle)}. Seen so far:\n${seen()}`);
    },
    exited: proc.exited.finally(() => clearTimeout(giveUp)),
  };
}

describe("nemar dataset update at a terminal asks for what the command line left out", () => {
  test("asks for a title and a description, and asks again after a refusal", async () => {
    const { work } = newClone();
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');

    const term = onTerminal(["dataset", "update", "--branch", "update/pr-text-pty"], work);
    await term.until("Title (one line saying what changed):");
    term.type("Save changes\r");
    await term.until('That is placeholder text ("Save changes"); say what actually changed.');
    // Asked again on a fresh line, so the person is never left to delete what was refused.
    await term.until("Title (one line saying what changed):");
    // A name and a year is refused the same way, with what to write instead.
    term.type("Lee2019 EEG dataset\r");
    await term.until(
      'That has a citation (an author and a year, or a DOI) in it ("Lee2019"); describe the change in plain words, such as "Add three EEG recordings", and cite the paper in ReferencesAndLinks and the README instead.',
    );
    await term.until("Title (one line saying what changed):");
    // Typed with padding and doubled spaces: the stored title is the one-line form of it.
    term.type("  Add  subject 03 and   rename the dataset  \r");
    await term.until("Description (what changed and why):");
    term.type("\r");
    await term.until("That is empty; say in plain words what changed.");
    await term.until("Description (what changed and why):");
    term.type(`${GOOD_DESCRIPTION}\r`);
    await term.until("Create update PR for xx000000?");
    term.type("y\r");
    const exitCode = await term.exited;
    expect(exitCode, term.seen()).toBe(0);

    const args = ghArgs() ?? [];
    expect(valueAfter(args, "--title")).toBe(`${GOOD_TITLE} (v1.0.1)`);
    expect(valueAfter(args, "--body")?.startsWith(`${GOOD_DESCRIPTION}\n\nBumps`)).toBe(true);
    expect(git(work, "show", "update/pr-text-pty:CHANGES")).toContain(`  - ${GOOD_TITLE}`);
  });

  test("a title typed at the prompt is asked about as sent, before anything is changed", async () => {
    // No title on the command line, so the version cannot be put after it until it is typed.
    const { work } = newClone();
    write(work, "dataset_description.json", desc("2020.1.0"));
    const term = onTerminal(["dataset", "update", "--branch", "update/pr-text-calendar"], work);
    await term.until("Title (one line saying what changed):");
    term.type("Add subject 03\r");
    await term.until("Description (what changed and why):");
    term.type(`${GOOD_DESCRIPTION}\r`);
    const exitCode = await term.exited;
    // The data of a pseudo terminal can arrive a moment after the process has exited.
    await term.until("Nothing was changed.");
    expect(exitCode, term.seen()).toBe(1);
    expect(term.seen()).toContain(
      'The title as it will be sent, "Add subject 03 (v2020.1.1)", has an author and a year in it ("v2020")',
    );
    expect(term.seen()).not.toContain("Create update PR");
    expect(git(work, "branch", "--list", "update/*")).toBe("");
    expect(ghArgs()).toBeNull();
  });

  test("does not ask what the command line already said", async () => {
    const { work } = newClone();
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');
    const term = onTerminal(
      ["dataset", "update", "--branch", "update/pr-text-pty2", "-m", GOOD_TITLE],
      work,
    );
    await term.until("Description (what changed and why):");
    term.type(`${GOOD_DESCRIPTION}\r`);
    await term.until("Create update PR for xx000000?");
    term.type("y\r");
    expect(await term.exited, term.seen()).toBe(0);
    expect(term.seen()).not.toContain("Title (one line saying what changed):");
  });

  test("does not ask when there is nothing to describe", async () => {
    const { work } = newClone();
    const term = onTerminal(["dataset", "update", "--branch", "update/pr-text-none"], work);
    const exitCode = await term.exited;
    await term.until("No changes detected.");
    expect(exitCode).toBe(0);
    expect(term.seen()).not.toContain("Title (one line saying what changed):");
  });

  test("does not ask a person who is not signed in", async () => {
    const { work } = newClone();
    write(work, "README.md", "# Resting EEG, revised\n");
    const term = onTerminal(["dataset", "update"], work, configDir(false));
    const exitCode = await term.exited;
    await term.until("Not authenticated");
    expect(exitCode).toBe(1);
    expect(term.seen()).not.toContain("Title (one line saying what changed):");
  });

  test("--yes at a terminal still refuses: it stands in for a confirmation, not for words", async () => {
    const { work } = newClone();
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');
    const term = onTerminal(["dataset", "update", "--yes"], work);
    const exitCode = await term.exited;
    // The data of a pseudo terminal can arrive a moment after the process has exited.
    await term.until("or pass both.");
    expect(exitCode).toBe(1);
    expect(term.seen()).toContain("missing --message and --description.");
    // A terminal IS attached, so the reason is --yes alone, and the way out is to drop it.
    expect(term.seen()).toContain(
      "--yes does not stand in for them: drop it to be asked for them here, or pass both.",
    );
    expect(term.seen()).not.toContain("without a terminal");
    expect(term.seen()).not.toContain("Title (one line saying what changed):");
  });
});

describe("nemar dataset push --pr at a terminal asks before anything is pushed", () => {
  test("the prompts come first and nothing has left the machine until they are answered", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const term = onTerminal(["dataset", "push", "--pr", "--no-s3"], work);
    await term.until("Title (one line saying what changed):");
    // The prompt is on screen and nothing has left the machine.
    expect(git(remote, "for-each-ref", "refs/heads")).toBe("");
    term.type(`${GOOD_TITLE}\r`);
    await term.until("Description (what changed and why):");
    expect(git(remote, "for-each-ref", "refs/heads")).toBe("");
    term.type(`${GOOD_DESCRIPTION}\r`);
    expect(await term.exited, term.seen()).toBe(0);
    expect(git(remote, "for-each-ref", "refs/heads")).toContain(
      "refs/heads/feature/new-recordings",
    );
    expect(ghArgs()).toEqual(["pr", "create", "--title", GOOD_TITLE, "--body", GOOD_DESCRIPTION]);
  });
});
