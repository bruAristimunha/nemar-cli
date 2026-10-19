/**
 * The naming rule: what a pull request title and a dataset name may not be (ADR 0107).
 *
 * A dataset is named after its paper (the atlas naming rule, FirstAuthorSurname-year-keyword-paperDOI),
 * and a pull request title says what a change does, so the two are kept apart: a citation (an author
 * and a year, or a DOI) is refused anywhere in a title or a dataset name, and the paper is cited in
 * ReferencesAndLinks and the README instead. A naming template left unfilled is never a title or a
 * name either. The rule is one pure function, used by the CLI before it opens a pull request, by the
 * review job before it asks any model, and by the Worker on a pull request it does not review (an
 * owner's or an administrator's), so all three refuse the same text.
 */

/**
 * Every way the rule refuses a text, as a closed word, in the order the rule asks about them:
 *  - `author_year`: the text holds an author-year key anywhere in it, a run of letters directly
 *    followed by an optional hyphen or underscore and a year from 1900 to 2099 (`Lee2019`,
 *    `Lee-2019-EEG`, `BNCI2014_001`, and in the middle of a text `Results from Zhou-2016 cohort`);
 *  - `doi`: the text holds a DOI anywhere in it, the characters `10.`, four to nine digits and a
 *    slash (`10.1038/s41597-020-0532-5`, `https://doi.org/10.7910/DVN/ABC`, `doi:10.1234/x`);
 *  - `template_field`: the text still holds a naming-template token or an unfilled template field
 *    (`FirstAuthorSurname`, `paperDOI`, `{{x}}`, `${x}`, `<your title>`, `[describe the change]`).
 */
export const NAMING_PROBLEMS = ["author_year", "doi", "template_field"] as const;
export type NamingProblem = (typeof NAMING_PROBLEMS)[number];

/**
 * A template field left where its value belongs. The first three are syntax: the shapes an
 * unfilled template, or a shell that did not expand a variable, leaves behind. The fourth is the
 * one real instance this was written for: a dataset's rename PR was titled with the naming rule
 * "FirstAuthorSurname-year-keyword-paperDOI" instead of the name that rule produces.
 *
 * The two tokens of that rule are matched anywhere in the text, in any case, with no word boundary.
 * A template is filled in by joining its parts, and `_` and digits are word characters, so a
 * boundary would pass `FirstAuthorSurname_year_keyword_paperDOI` and `paperDOI10.1234` untouched.
 * They are matched in the text a reader sees ({@link INVISIBLE}), so a soft hyphen or a zero-width
 * space inside `paperDOI` does not hide it.
 *
 * There is deliberately NO rule for "a long CamelCase word". BIDS field names are CamelCase by
 * specification (`PowerLineFrequency`, `DatasetDOI`, `ReferencesAndLinks`), as are task labels
 * (`task-RestingStateEyesClosed`), and they are the vocabulary of an ordinary dataset update.
 *
 * A bracket asks the reader to write something only when its first word is one that asks (your,
 * insert, enter, describe, write, fill in, replace) and more words follow inside it, and it is not
 * the text of a Markdown link. `<your title here>` and `[describe the change]` are refused;
 * `<Enter>`, `[Replace]`, `[Write-up](url)`, `[your lab](url)` and
 * `sub-<label>_task-<label>_eeg.edf` stay ordinary text.
 *
 * The lookahead after the whitespace is not decoration: without it `\s+` and the characters after
 * it overlap on blanks, and an unclosed `[your` followed by a long run of them is tried as every
 * split of the run, which is quadratic. With it the run has one way to match.
 */
export const TEMPLATE_FIELDS: readonly RegExp[] = [
  /\{\{[^{}]*\}\}/, // {{title}}
  /\$\{[^{}]*\}/, // ${TITLE}
  /[<[]\s*(?:your|insert|enter|describe|write|fill in|replace)\s+(?=[^\s<>[\]])[^<>[\]]*[>\]](?![([])/i, // <your title>
  /FirstAuthorSurname|paperDOI/i,
];

/**
 * A year from 1900 to 2099 that is not the start of a longer number. {@link findAuthorYearKey}
 * reads every year of a text with it, so it is one pattern with no unbounded repetition at all, let
 * alone one that repeats another. A test checks its source for that, which is why it is exported;
 * no test asserts a duration.
 */
export const YEAR_PATTERN = /(?:19|20)\d{2}(?!\d)/u;

/**
 * The start of a DOI: `10.`, four to nine digits and a slash, as {@link findDoi} reads it. One
 * pattern whose only repetition is bounded, so it is read once in linear time; a test checks its
 * source for that, which is why it is exported.
 */
export const DOI_PATTERN = /10\.\d{4,9}\//u;

/** One character that is a letter of any script, or a combining mark that goes with one. */
const LETTER = /^[\p{L}\p{M}]$/u;

/**
 * What no reader sees, wherever it is in a text and not only at its start:
 *  - every default-ignorable code point (a soft hyphen, a zero-width space, joiner or non-joiner, a
 *    directional mark, a word joiner, a variation selector, a Hangul filler, a tag character);
 *  - every other format character (`\p{Cf}`) and every control character (`\p{Cc}`), except the
 *    five that are blanks to a reader: tab, line feed, vertical tab, form feed and carriage return;
 *  - U+2800, the braille blank, which is a symbol (so no class above covers it) that draws as a space.
 *
 * They are REMOVED, not replaced: nothing is drawn where they are, so `paper\u00adDOI` reads
 * `paperDOI` and `Le\u200be2019` reads `Lee2019`. (The review's models are shown each control and
 * format character as a space, `tidy` in `shared/untrusted-text.ts`; a rule that judged only that
 * view could be passed by a character a person cannot see.) The five blanks stay, because they
 * separate words as a space does, and the patterns that read a blank (the `\s+` after the asking
 * word of `<your title>`) need them. One character class under one lookahead, applied by a global
 * replace, so it is read once, in linear time.
 */
const INVISIBLE = /(?![\t-\r])[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\u2800]/gu;

/**
 * `text` as a reader sees it: {@link INVISIBLE} removed at every position. Blanks and ordinary
 * spaces are never touched here.
 */
export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/**
 * Whether `text` shows a reader anything: false for an empty text, for blanks, and for a text of
 * nothing but what {@link INVISIBLE} removes. A dataset name that shows nothing is no name to ask
 * the rule about, so the readers of `dataset_description.json` treat it as unreadable.
 */
export function hasVisibleText(text: string): boolean {
  return withoutInvisible(text).trim() !== "";
}

/**
 * Where the run of letters that ends at `end` begins, or `end` itself when the character before it
 * is no letter. It walks left one code point at a time (a surrogate pair is one letter, never two
 * halves) and stops at the first character that is not a letter.
 */
function lettersStart(text: string, end: number): number {
  let start = end;
  while (start > 0) {
    const low = text.charCodeAt(start - 1);
    const high = start >= 2 ? text.charCodeAt(start - 2) : 0;
    const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
    const from = pair ? start - 2 : start - 1;
    if (!LETTER.test(text.slice(from, start))) break;
    start = from;
  }
  return start;
}

/**
 * The first author-year key in `text`, as it was typed less what no reader sees (`Lee-2019` for
 * `Lee-2019-EEG`, `Zhou-2016` for `Results from Zhou-2016 cohort`), or null. That is how a dataset is
 * named after its paper (the atlas naming rule is FirstAuthorSurname-year-keyword-paperDOI), and a
 * pull request title says what the change does, not which paper the data came from, so a key is
 * refused wherever it stands in a title or a dataset name: `Lee2019 EEG dataset`, `Lee-2019-EEG`,
 * `O'Brien_2020`, `Add the Lee2019 recordings` and `sourcedata: add the validation files the MOABB
 * loader reads (Mainsah2025_L)` all hold one. The function is pure and exported so that the CLI, the
 * pull request review and any check on a dataset name ask the same question.
 *
 * A key is a run of letters (any script, with their combining marks) directly followed by an
 * optional single hyphen or underscore, then a year from 1900 to 2099 that is not the start of a
 * longer number. Whatever comes after the year does not matter. What is returned is the letters,
 * the separator and the year, so `O'Brien2019` gives `Brien2019`: an apostrophe or a hyphen inside a
 * name ends the run of letters.
 *
 * **The letters must touch the separator or the year, and that is a deliberate boundary.** A space
 * ends a key before it starts, so `Andreev 2012`, `Release 2019` and `Add 2019 recordings` are
 * ordinary sentences: a rule that read a word and a year across a space would refuse every title
 * that mentions a year. So are a title that begins with the year (`2019 release notes`), a year
 * range (`2019-2020 study`), and a year that follows a digit, a dot, a colon or a doubled separator
 * (`Study2-2019`, `Lee.2019`, `Lee--2019`). The price is that a citation typed with a space
 * (`Sawada 2022`) is not caught.
 *
 * Nothing here can tell a surname from any other letters, so an acronym such as `BNCI2014_001`, a
 * funding code such as `H2020`, a BIDS label such as `ses-2019` and a software release such as
 * `R2019b` are refused too, wherever they stand in the text.
 *
 * The text is judged as a reader sees it ({@link INVISIBLE}), at every position: `Le\u200be2019
 * EEG` and `Lee\u00ad2019 EEG` hold the key `Lee2019`. A blank is never removed, so `Lee\t2019 EEG`
 * is a sentence like `Lee 2019 EEG`.
 *
 * **It is linear in the length of the text.** The years are read in order by {@link YEAR_PATTERN}.
 * For each one the character before it is looked at once, for the separator, and the character
 * before that once more, for a letter; only a year that has a letter there makes the letters be
 * walked, once, to find where the key starts, and then the function returns. So a year without a
 * letter costs a constant, a walk happens at most once, and a text with no year (however long a run
 * of letters or of letters and hyphens it holds) is read once by the pattern and never walked.
 */
export function findAuthorYearKey(text: string): string | null {
  const seen = withoutInvisible(text);
  for (const year of seen.matchAll(new RegExp(YEAR_PATTERN, "gu"))) {
    const at = year.index;
    const before = seen.charAt(at - 1);
    const end = before === "-" || before === "_" ? at - 1 : at;
    const start = lettersStart(seen, end);
    if (start < end) return seen.slice(start, at + year[0].length);
  }
  return null;
}

/**
 * The start of the first DOI in `text`, as it was typed less what no reader sees (`10.1038/` for
 * `Described in 10.1038/s41597-020-0532-5`), or null. A DOI is the characters `10.`, then four to
 * nine digits, then a slash: the prefix every DOI begins with and the slash that opens its suffix.
 * That covers a `doi.org` link, a bare `doi:10.1234/x`, and a DOI that ends a name in parentheses
 * (`Saggio-2020-taxonomy-10.7910/...`), wherever it stands in a title or a dataset name. The paper a
 * dataset comes from is cited in ReferencesAndLinks and the README, not in its title or its name.
 *
 * What is returned is `10.`, the digits and the slash, which is enough to find the DOI in a text
 * and short enough to show. A DOI's suffix may hold almost any character, so where it ends is not
 * a thing to guess, and it is not asked for.
 *
 * The slash is part of what is asked for, so `Recordings of 10.5 Hz tones`, `Version 10.2019` and a
 * bare `10.1234` are not DOIs. Nothing is asked of the character before the `10`, as the template
 * tokens ask nothing of theirs: a DOI is as often joined to the text before it by a hyphen as set
 * off by a space, and `2010.1234/x` is refused with the rest. A DOI whose slash is written `%2F` is
 * not read as one.
 *
 * The text is judged as a reader sees it ({@link INVISIBLE}), so `10.\u200b1038/x` is a DOI.
 * The scan is linear: {@link DOI_PATTERN} has no unbounded repetition, so each position costs at
 * most the thirteen characters of a longest match.
 */
export function findDoi(text: string): string | null {
  return withoutInvisible(text).match(DOI_PATTERN)?.[0] ?? null;
}

/**
 * The first template field `text` still holds, as a reader sees it there ({@link INVISIBLE} is not
 * part of it), or null: the first of {@link TEMPLATE_FIELDS}, in their order, that matches anywhere
 * in the text.
 */
export function findTemplateField(text: string): string | null {
  const seen = withoutInvisible(text);
  for (const re of TEMPLATE_FIELDS) {
    const field = seen.match(re)?.[0];
    if (field !== undefined) return field;
  }
  return null;
}

/**
 * How `text` breaks the naming rule, or null when it does not: an author-year key anywhere in it
 * (`author_year`, {@link findAuthorYearKey}), a DOI anywhere in it (`doi`, {@link findDoi}), or a
 * naming-template token or unfilled template field anywhere in it (`template_field`,
 * {@link findTemplateField}), asked in that order, so a text that breaks several is the first of
 * them. The one question the CLI asks of a title, the review job asks of a title and of a changed
 * dataset name before any model, and the Worker asks of an owner's or administrator's pull request.
 */
export function namingProblemOf(text: string): NamingProblem | null {
  if (findAuthorYearKey(text) !== null) return "author_year";
  if (findDoi(text) !== null) return "doi";
  if (findTemplateField(text) !== null) return "template_field";
  return null;
}
