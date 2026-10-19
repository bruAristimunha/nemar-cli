/**
 * The naming rule (`shared/naming-rule.ts`, ADR 0107): one pure function the CLI, the review job and
 * the Worker all ask, so a title or a dataset name is refused the same way wherever it is checked.
 * The rule's cases are tested in depth through the CLI's own refusals (`pr-text.unit.test.ts`);
 * this file checks that there is ONE copy of it, that the review's question gives the same answers,
 * where in a text an author-year key or a DOI is found and where it is not, and that the rule reads
 * a long text once.
 */

import { describe, expect, test } from "bun:test";
import { namingFactsFor } from "../backend/src/services/pr-review-naming";
import type { Bindings } from "../backend/src/types/bindings";
import { textFactsOf } from "../scripts/ci/pr-review";
import type { Listing } from "../scripts/ci/pr-review-evidence";
import { MAX_BODY_CHARS } from "../scripts/ci/pr-review-prompt";
import {
  NAMING_PROBLEMS,
  TEMPLATE_FIELDS,
  findAuthorYearKey,
  findDoi,
  findTemplateField,
  hasVisibleText,
  namingProblemOf,
  withoutInvisible,
} from "../shared/naming-rule";
import * as cli from "../src/lib/pr-text";

/**
 * Two real texts the owner pointed at, each with an author-year key and a DOI at the end, in
 * parentheses. The second is the Name of nm000536. Both are quoted as they were written.
 */
const SAWADA =
  "Mapping effective connectivity of human amygdala with intracranial stimulation - es-TT evoked potentials (Sawada-2022-mapping-10.1038/s41467-022-32644-y)";
const SAGGIO =
  "Epidynamics: single-channel intracranial seizure recordings from 7 centres with onset/offset dynamotype metadata (Saggio-2020-taxonomy-10.7910/...)";
/** A pull request title as it is written in the field, with the key at the end of it. */
const MAINSAH = "sourcedata: add the validation files the MOABB loader reads (Mainsah2025_L)";

/**
 * The fields of a listing the text facts read: the dataset's name at the base and at the head, and
 * whether the pull request changes the description and leaves no readable name in it.
 */
const listing = (nameBefore: string | null, nameAfter: string | null, nameUnreadable = false) =>
  ({ nameBefore, nameAfter, nameUnreadable }) as Listing;

describe("there is one copy of the rule", () => {
  test("the CLI's exports are the shared rule's own functions, not copies", () => {
    expect(cli.findAuthorYearKey).toBe(findAuthorYearKey);
    expect(cli.findDoi).toBe(findDoi);
  });

  test("the review job's facts are the rule's answers, on the title and on a changed name", () => {
    for (const title of [
      "Lee2019 EEG dataset",
      "Fix {{title}}",
      "Add three EEG recordings",
      MAINSAH,
      "Add 2019 recordings",
      "Described in 10.1038/s41597-020-0532-5",
    ]) {
      expect(textFactsOf({ title, body: "x" }, listing("A", "A")).titleProblem, title).toBe(
        namingProblemOf(title),
      );
    }
    expect(textFactsOf({ title: "t", body: "x" }, listing("A", "Lee2019 X")).nameProblem).toBe(
      "author_year",
    );
    // A key anywhere in a changed name is the name's problem, as it is anywhere in a title's.
    expect(textFactsOf({ title: "t", body: "x" }, listing("A", SAGGIO)).nameProblem).toBe(
      "author_year",
    );
    // A DOI is the name's problem too, and it has its own word.
    expect(
      textFactsOf({ title: "t", body: "x" }, listing("A", "EEG of 7 centres 10.7910/DVN/ABC"))
        .nameProblem,
    ).toBe("doi");
    // The name is the pull request's problem only when it changes the name.
    expect(
      textFactsOf({ title: "t", body: "x" }, listing("Lee2019 X", "Lee2019 X")).nameProblem,
    ).toBeNull();
    // An empty description, in each form GitHub sends one: null (never written), an empty string,
    // and blanks only. Anything with a word in it is not empty.
    for (const body of [null, undefined, "", "  \n\t "]) {
      expect(
        textFactsOf({ title: "t", body }, listing(null, null)).descriptionEmpty,
        `${body}`,
      ).toBe(true);
    }
    expect(
      textFactsOf({ title: "t", body: "Adds sub-03." }, listing(null, null)).descriptionEmpty,
    ).toBe(false);
  });

  test("a title that is not text fails closed, as the Worker's intake refuses it", () => {
    // Read as an empty title it would be clean: a pass for text nobody read.
    for (const title of [undefined, null, 42, ["Lee2019"], { text: "Lee2019" }]) {
      expect(() => textFactsOf({ title, body: "x" }, listing("A", "A")), `${title}`).toThrow(
        "evidence_unavailable",
      );
    }
    // The empty string is text, and has no problem with the rule.
    expect(textFactsOf({ title: "", body: "x" }, listing("A", "A")).titleProblem).toBeNull();
  });

  test("a changed description with no readable name is unchecked, never clean", () => {
    const facts = (l: Listing) => textFactsOf({ title: "t", body: "x" }, l).nameProblem;
    expect(facts(listing("A", null, true))).toBe("unchecked");
    expect(facts(listing(null, null, true))).toBe("unchecked");
    // A name that was read is the rule's to judge, and the flag never replaces its answer.
    expect(facts(listing("A", "Lee2019 X", true))).toBe("author_year");
    expect(facts(listing("A", "Resting EEG", true))).toBeNull();
    // A description the pull request does not touch is not asked about.
    expect(facts(listing("A", null, false))).toBeNull();
    expect(facts(listing(null, null, false))).toBeNull();
  });

  test("a description is empty when the models read it as blank, and not otherwise", () => {
    // `tidy` turns each control and invisible format character into a space before a model reads
    // the text, so a body of zero-width spaces and soft hyphens is blank to them. `trim` alone
    // does not remove them, and called such a body a description.
    const listed = listing(null, null);
    const empty = (body: unknown) => textFactsOf({ title: "t", body }, listed).descriptionEmpty;
    for (const body of [
      "\u200b\u00ad",
      "\u200b \u00ad\n\ufeff\t",
      "\u0007",
      "\u{e0020}\u2060",
      // However long: a run of blanks past the models' cut is still nothing.
      `${" ".repeat(MAX_BODY_CHARS + 1_000)}\u200b`,
    ]) {
      expect(empty(body), JSON.stringify(body.slice(0, 12))).toBe(true);
    }
    // A word anywhere in it is a description, however much invisible text surrounds the word.
    for (const body of [
      "\u200b\u00adAdds sub-03.\u200b",
      `${" ".repeat(MAX_BODY_CHARS + 1_000)}Adds sub-03.`,
      "\u200b.\u00ad",
    ]) {
      expect(empty(body), JSON.stringify(body.slice(0, 12))).toBe(false);
    }
  });
});

describe("the Worker asks the same rule of an exempt pull request", () => {
  test("its title fact is the rule's answer; a name it cannot compare is unchecked, never fine", async () => {
    const subject = { datasetId: "nm000460", prNumber: 7, headSha: "a".repeat(40), baseSha: null };
    for (const title of [
      "Lee2019 EEG dataset",
      "Fix ${TITLE}",
      "Add three EEG recordings",
      MAINSAH,
      "Add 2019 recordings",
      "Described in 10.1038/s41597-020-0532-5",
    ]) {
      const facts = await namingFactsFor({} as Bindings, { ...subject, title });
      expect(facts.title, title).toBe(namingProblemOf(title));
      expect(facts.name, title).toBe("unchecked");
    }
  });
});

describe("namingProblemOf", () => {
  test("an author-year key is author_year, at the start of the text and anywhere else in it", () => {
    for (const text of [
      // At the start, as the rule first read it.
      "Lee2019 EEG dataset",
      "Lee-2019-EEG",
      "BNCI2014_001",
      "lee2019 eeg",
      "BNCI2014_001 motor imagery",
      // In the middle, and at the end, of a longer text.
      "Results from Zhou-2016 cohort",
      "Add the Lee2019 recordings",
      "Rename the dataset to Lee-2019-EEG",
      MAINSAH,
      // The two texts the owner pointed at: the key and a DOI, in parentheses at the end.
      SAWADA,
      SAGGIO,
    ]) {
      expect(namingProblemOf(text), text).toBe("author_year");
    }
  });

  test("the key is what is found: the letters, the separator and the year, as typed", () => {
    const found: Array<[string, string]> = [
      ["Lee2019 EEG dataset", "Lee2019"],
      ["Lee-2019-EEG", "Lee-2019"],
      ["Lee_2019_EEG", "Lee_2019"],
      ["BNCI2014_001 motor imagery", "BNCI2014"],
      ["Results from Zhou-2016 cohort", "Zhou-2016"],
      [MAINSAH, "Mainsah2025"],
      [SAWADA, "Sawada-2022"],
      [SAGGIO, "Saggio-2020"],
      // The first of several keys, and the letters that touch the year when a name has more parts.
      ["Lee2019 and Zhou-2016", "Lee2019"],
      ["O'Brien2019 recordings", "Brien2019"],
      ["Smith-Jones_2020 EEG", "Jones_2020"],
      // Letters that are not ASCII, with a combining mark, and one beyond the basic plane.
      ["Mu\u0308ller2021 EEG", "Mu\u0308ller2021"],
      ["M\u{fc}ller-2021 EEG", "M\u{fc}ller-2021"],
      ["Add \u{20000}2019 recordings", "\u{20000}2019"],
      ["Add \u{20000}-2019 recordings", "\u{20000}-2019"],
    ];
    for (const [text, key] of found) {
      expect(findAuthorYearKey(text), JSON.stringify(text)).toBe(key);
    }
  });

  test("a space between the letters and the year is a deliberate boundary: it is not a key", () => {
    // The letters must touch the year, or the one hyphen or underscore before it. A rule that read a
    // word and a year across a space would refuse every title that mentions a year.
    for (const text of [
      "Release 2019 notes",
      "Add 2019 recordings",
      "Andreev 2012 is not refused",
      "Release\u00a02019",
      "2019-2020 study",
      "Add the 2019 recordings of Lee",
      // A digit, a dot, a colon or a second separator stands between the letters and the year.
      "Study2-2019 recordings added",
      "Lee.2019 EEG",
      "Lee:2019 EEG",
      "Lee--2019 EEG",
      "Lee-_2019 EEG",
      // A year is four digits from 1900 to 2099 that do not start a longer number.
      "Lee1899 EEG",
      "Lee2100 EEG",
      "Lee201 EEG",
      "Lee20195 EEG",
      "Lee12019 EEG",
    ]) {
      expect(findAuthorYearKey(text), JSON.stringify(text)).toBeNull();
      expect(namingProblemOf(text), JSON.stringify(text)).toBeNull();
    }
  });

  test("a naming-template token or an unfilled template field anywhere is template_field", () => {
    for (const text of [
      "Rename dataset to FirstAuthorSurname-year-keyword-paperDOI",
      "Add the paperDOI to the README",
      "Fix {{title}}",
      "Fix ${TITLE}",
      "<your title here>",
      "Update [describe the change]",
    ]) {
      expect(namingProblemOf(text), text).toBe("template_field");
    }
  });

  test("a naming-template token is refused beside a letter, a digit or an underscore, in any case", () => {
    // `_` and digits are word characters, so a pattern bounded by `\b` passes every one of these:
    // a template is filled in by joining its parts, not by spacing them out.
    for (const text of [
      "FirstAuthorSurname_year_keyword_paperDOI",
      "Rename to Lee_paperDOI",
      "paperDOI10.1234",
      "xFirstAuthorSurnamex",
      "Rename to firstauthorsurname-keyword",
      "Add the PAPERDOI",
      "PaperDoi",
    ]) {
      expect(namingProblemOf(text), text).toBe("template_field");
    }
    // The field is reported as it appears, whatever its case and whatever it is joined to.
    expect(findTemplateField("Lee_firstAuthorSURNAME_2019")).toBe("firstAuthorSURNAME");
    expect(findTemplateField("paperDOI10.1234")).toBe("paperDOI");
    // Joined to a year, the token is also an author-year key, and the rule asks about that first:
    // the text is refused either way, and the token is still found.
    expect(findTemplateField("Rename to firstauthorsurname-2019")).toBe("firstauthorsurname");
    expect(namingProblemOf("Rename to firstauthorsurname-2019")).toBe("author_year");
  });

  test("an ordinary title or name is not refused", () => {
    for (const text of [
      "Add three EEG recordings",
      "Release 2019 recordings",
      "2019 release notes",
      "Motor imagery EEG of 52 volunteers",
      "Fix sub-<label>_task-<label>_eeg.edf naming",
      "Recordings of 10.5 Hz tones",
      "",
    ]) {
      expect(namingProblemOf(text), text).toBeNull();
    }
  });

  test("what no reader sees before the text does not hide a name and a year", () => {
    // The review's models read these as spaces and a person sees nothing, so a title that opens
    // with one is a title that opens with the name. `String.prototype.trimStart` skips only the
    // first two of them.
    const invisible: Array<[string, string]> = [
      ["a zero-width space", "\u200b"],
      ["a soft hyphen", "\u00ad"],
      ["a byte-order mark", "\ufeff"],
      ["a word joiner", "\u2060"],
      ["a left-to-right mark", "\u200e"],
      ["a bell, a control character", "\u0007"],
      ["a tag space, a format character outside the basic plane", "\u{e0020}"],
      ["a mix of blanks and invisible characters", " \u200b\u00ad\t\ufeff "],
    ];
    for (const [what, lead] of invisible) {
      expect(namingProblemOf(`${lead}Lee2019 EEG dataset`), what).toBe("author_year");
      expect(findAuthorYearKey(`${lead}Lee-2019-EEG`), what).toBe("Lee-2019");
      // The same lead before an ordinary title changes nothing about it.
      expect(namingProblemOf(`${lead}Add three EEG recordings`), what).toBeNull();
      expect(namingProblemOf(`${lead}2019 release notes`), what).toBeNull();
    }
  });

  test("what no reader sees does not hide a template token or a name anywhere in the text", () => {
    // The character draws nothing, so a person reads the refused text: `paper\u00adDOI` is
    // `paperDOI`. A rule that cleared only the start of the text passed every one of these. Each
    // class of the rule has a row that only it covers: a soft hyphen is a format character AND
    // default-ignorable, so the combining grapheme joiner (a mark) and the Hangul filler (a letter)
    // stand for the default-ignorable class, the Arabic number sign for the format class alone.
    const templateField = [
      "paper\u00adDOI", // a soft hyphen
      "First\u200bAuthorSurname", // a zero-width space
      "Rename to First\u2060Author\u200dSurname-year", // a word joiner and a joiner
      "paper\u034fDOI", // a combining grapheme joiner: default-ignorable, not a format character
      "First\u3164AuthorSurname", // a Hangul filler: default-ignorable, and a letter
      "paper\u0600DOI", // a format character that is not default-ignorable
      "paper\u0007DOI", // a control character
      "paper\u2800DOI", // the braille blank
      "{\u200b{title}}",
      "<you\u200br title here>",
    ];
    for (const text of templateField) {
      expect(namingProblemOf(text), JSON.stringify(text)).toBe("template_field");
    }
    const authorYear = [
      "Le\u200be2019 EEG", // a zero-width space inside the name
      "Lee\u00ad2019 EEG", // a soft hyphen between the name and the year
      "Lee-\u200d2019-EEG", // a joiner after the hyphen
      "Le\u0007e2019 EEG", // a control character
      "Le\u2800e2019 EEG", // the braille blank
      "\u2800Lee2019 EEG", // a braille blank in front, which is a symbol, not a blank
      "\u2800\u2800 \u200b\u2800Lee-2019-EEG", // and a run of them with blanks between
      "Add the Le\u200be2019 recordings", // anywhere in the text, not only at its start
      "Results from Zhou\u00ad-2016 cohort", // a soft hyphen between the letters and the separator
      "Results from Zhou-\u200d2016 cohort", // a joiner between the separator and the year
    ];
    for (const text of authorYear) {
      expect(namingProblemOf(text), JSON.stringify(text)).toBe("author_year");
    }
    // What is reported is what a reader sees: the answer holds no invisible character.
    expect(findAuthorYearKey("Le\u200be-\u00ad2019 EEG")).toBe("Lee-2019");
    expect(findTemplateField("Add the paper\u00adDOI to the README")).toBe("paperDOI");
  });

  test("a blank is never removed: it ends a word, and the instruction bracket still reads it", () => {
    // A space, a tab and a newline separate words, so removing one would glue `Release 2019` into a
    // name and a year, and `<your\ntitle>` into a word that asks nothing.
    for (const text of [
      "Release 2019",
      "Lee 2019 EEG",
      "Lee\t2019 EEG",
      "Lee\n2019 EEG",
      "Lee\r2019",
    ]) {
      expect(namingProblemOf(text), JSON.stringify(text)).toBeNull();
    }
    for (const text of [
      "<your\ntitle here>",
      "Update [describe\tthe change]",
      "[write\r\nthe change]",
    ]) {
      expect(namingProblemOf(text), JSON.stringify(text)).toBe("template_field");
    }
  });

  test("invisible characters in an ordinary text do not make it a problem", () => {
    for (const text of [
      "2019 release notes",
      "Add three EEG recordings",
      // An emoji joined by a zero-width joiner, and one with a variation selector.
      "\u{1F469}\u200d\u{1F4BB} Add three EEG recordings",
      "Add \u{1F468}\u200d\u{1F469}\u200d\u{1F467} family recordings",
      "Fix \u2764\ufe0f in the README",
      // Invisible characters between ordinary words, and ahead of a year that has no name before it.
      "Add\u200b three\u00ad EEG recordings",
      "\u2800\u200b2019 release notes",
      "\u00a0Release 2019",
    ]) {
      expect(namingProblemOf(text), JSON.stringify(text)).toBeNull();
    }
  });

  test("withoutInvisible removes, never replaces, and leaves every blank alone", () => {
    expect(withoutInvisible("a\u200bb\u00adc\u2800d\u0007e\u{e0020}f")).toBe("abcdef");
    const blanks = "a b\u00a0c\td\ne\rf\u3000g";
    expect(withoutInvisible(blanks)).toBe(blanks);
    expect(withoutInvisible("")).toBe("");
  });

  test("hasVisibleText is false only for a text a reader sees nothing in", () => {
    for (const text of ["", "   ", "\u200b", "\u200b \u00ad\n\ufeff\t", "\u2800", "\u2060\u200d"]) {
      expect(hasVisibleText(text), JSON.stringify(text)).toBe(false);
    }
    for (const text of ["a", ".", "0", "\u200ba\u200b", "\u2800 x"]) {
      expect(hasVisibleText(text), JSON.stringify(text)).toBe(true);
    }
  });

  test("a text that breaks both is author_year, the first of the two the rule asks", () => {
    expect(namingProblemOf("Lee2019 FirstAuthorSurname")).toBe("author_year");
  });

  test("an invisible character does not make a space into a key, or a key into a space", () => {
    // Removing what no reader sees can only join what the reader already sees side by side: a space
    // that is drawn stays between the letters and the year, so it is never glued into a key.
    for (const text of [
      "Release\u200b 2019 notes",
      "Release \u00ad2019 notes",
      "Release\u2800 2019 notes",
      "Andreev\u200d 2012 is not refused",
    ]) {
      expect(namingProblemOf(text), JSON.stringify(text)).toBeNull();
    }
  });

  test("its words are the closed list the report carries", () => {
    expect(NAMING_PROBLEMS).toEqual(["author_year", "doi", "template_field"]);
    expect(findTemplateField("Fix {{a}} and ${b}")).toBe("{{a}}");
    expect(findTemplateField("Nothing to fill")).toBeNull();
    expect(TEMPLATE_FIELDS.length).toBe(4);
  });
});

describe("a DOI is refused anywhere in a text", () => {
  test("a DOI is doi wherever it stands in a title or a name, and however it is written", () => {
    const found: Array<[string, string]> = [
      ["Described in 10.1038/s41597-020-0532-5", "10.1038/"],
      ["Data from https://doi.org/10.7910/DVN/ABC123", "10.7910/"],
      ["See doi:10.1234/abc", "10.1234/"],
      // At the start, and joined to the text before it by a hyphen.
      ["10.5281/zenodo.1234567 recordings", "10.5281/"],
      ["Add recordings (taxonomy-10.7910/...)", "10.7910/"],
      // Four digits and nine digits, the shortest and the longest registrant code.
      ["10.1000/182", "10.1000/"],
      ["10.123456789/x", "10.123456789/"],
      // The first of several.
      ["10.1234/a and 10.5678/b", "10.1234/"],
    ];
    for (const [text, doi] of found) {
      expect(findDoi(text), text).toBe(doi);
      expect(namingProblemOf(text), text).toBe("doi");
    }
  });

  test("a number with a dot is no DOI without its four to nine digits and its slash", () => {
    for (const text of [
      "Recordings of 10.5 Hz tones",
      "Version 10.2019 notes",
      "Fix 10.1234 in the README",
      // Three digits, ten digits, and a slash that is not the next character.
      "Add 10.123/day recordings",
      "Add 10.1234567890/x",
      "Add 10.1234 /x",
      // The slash is the DOI's own: an encoded one is not read as it.
      "Described in 10.1038%2Fs41597",
    ]) {
      expect(findDoi(text), text).toBeNull();
      expect(namingProblemOf(text), text).toBeNull();
    }
  });

  test("an invisible character does not hide a DOI, and the DOI is found as a reader sees it", () => {
    for (const text of [
      "Described in 10.\u200b1038/s41597",
      "Described in 10\u00ad.1038/s41597",
      "Described in 10.1038\u2060/s41597",
      "Described in 1\u200d0.1038/s41597",
      "Described in 10.\u2800\u{e0020}1038/s41597",
    ]) {
      expect(findDoi(text), JSON.stringify(text)).toBe("10.1038/");
      expect(namingProblemOf(text), JSON.stringify(text)).toBe("doi");
    }
    // A blank stays: it ends the number, so a DOI with a space inside it is not one.
    expect(findDoi("Described in 10.1038 /s41597")).toBeNull();
    expect(findDoi("Described in 10. 1038/s41597")).toBeNull();
  });

  test("a text that breaks several rules is the first the rule asks about", () => {
    // The order is author_year, doi, template_field, as in the closed list the report carries.
    expect(namingProblemOf("Lee2019 10.1234/x FirstAuthorSurname")).toBe("author_year");
    expect(namingProblemOf("10.1234/x FirstAuthorSurname")).toBe("doi");
    expect(namingProblemOf("FirstAuthorSurname-paperDOI10.1234/x")).toBe("doi");
    expect(namingProblemOf("FirstAuthorSurname")).toBe("template_field");
    // The two real texts hold both an author-year key and a DOI: the key is the first problem, and
    // the DOI is found in them all the same.
    for (const [text, key, doi] of [
      [SAWADA, "Sawada-2022", "10.1038/"],
      [SAGGIO, "Saggio-2020", "10.7910/"],
    ]) {
      expect(findAuthorYearKey(text), text).toBe(key);
      expect(findDoi(text), text).toBe(doi);
      expect(namingProblemOf(text), text).toBe("author_year");
    }
  });
});

describe("the rule reads a long text once", () => {
  // A dataset name or a pull request title is whatever was pasted, so the rule must not be
  // quadratic in its length. Nothing here asserts a duration, which fails on a loaded runner. Each
  // text is long enough that a scan which restarts at every letter, or looks back from every
  // position, cannot get through this file's test timeout: it would take a minute or more for the
  // letters, against a few milliseconds for the rule. A regression to such a scan fails these tests
  // by timeout, and a longer text would only make it fail later.
  test("300,000 letters with no year are read once", () => {
    const hostile = "a".repeat(300_000);
    expect(findAuthorYearKey(hostile)).toBeNull();
    expect(namingProblemOf(hostile)).toBeNull();
  });

  test("300,000 characters of letter-hyphen pairs with no year are read once", () => {
    const hostile = "a-".repeat(150_000);
    expect(hostile).toHaveLength(300_000);
    expect(findAuthorYearKey(hostile)).toBeNull();
    expect(namingProblemOf(hostile)).toBeNull();
  });

  test("a million characters of DOI prefixes with no slash are read once", () => {
    // Every `10.` is the start of a candidate; none is followed by four digits and a slash. The
    // text is long enough that a scan which reads on from every candidate to the end of the text
    // takes a minute or more, against a few milliseconds here.
    for (const unit of ["10.", "10.123456789", "10.1234"]) {
      const hostile = unit.repeat(Math.ceil(1_000_000 / unit.length));
      expect(findDoi(hostile), unit).toBeNull();
      expect(namingProblemOf(hostile), unit).toBeNull();
    }
    // And one that ends a long text is found.
    expect(findDoi(`${"10.".repeat(100_000)}1234/x`)).toBe("10.1234/");
  });

  test("many years that are not keys, and a long run of letters that ends in one, are read once", () => {
    // Fifty thousand years, each after a digit and a hyphen: none has a letter before it.
    expect(findAuthorYearKey("1-2019 ".repeat(50_000))).toBeNull();
    // The run is walked once, to where the key starts, and the key is the whole of it.
    const letters = "a".repeat(300_000);
    expect(findAuthorYearKey(`${letters}2019`)).toBe(`${letters}2019`);
    expect(findAuthorYearKey(`Add ${letters}-2019 recordings`)).toBe(`${letters}-2019`);
  });
});
