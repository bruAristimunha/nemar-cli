/**
 * The pre-send boundary of the publication review (ADR 0102, section 2).
 *
 * **This is the only file that mints `ClearedText`.** The prompt builder accepts nothing else, and
 * `test/publication-review-contract.test.ts` fails if any other source file casts to the type. So
 * the one place that decides what a model may read is this file, and it is short enough to read
 * whole. The brand is checked by the compiler and by a lexical test, and neither can see a type
 * predicate, an assertion function, a generic cast, `JSON.parse` or a suppressed error, so the
 * prompt builder also asks {@link isCleared}, at run time, about every string it sends.
 *
 * The rule: every document is examined by the shared mechanical rules (`shared/identifier-scan.ts`)
 * immediately before it is sent, over exactly the string that will be sent, and text is cleared
 * only when the rules found nothing in it. A document the rules found something in, that could not
 * be read in full, that is not UTF-8, that is an annexed link or pointer rather than text in git,
 * or that is JSON that does not parse is withheld WHOLE and gets a closed state; it is never
 * sent, and never sent in part.
 *
 * The principle: normalize first, then examine the normalized thing, then send EXACTLY the string
 * that was examined. Four rules fix what that means:
 *
 *  1. Every string is normalized before any rule looks at it (`normalizeText`): code points that
 *     render as nothing (variation selectors, the Hangul fillers, the combining grapheme joiner and
 *     the other default-ignorable ones) and any half of a surrogate pair are removed, Unicode
 *     compatibility normalization (NFKC) makes a fullwidth solidus a slash and a fullwidth letter
 *     its letter, and control and format characters are replaced by spaces (`tidy`). A document with
 *     a NUL byte is not text and is withheld as not UTF-8. For a JSON document the same
 *     normalization is applied to every key and every string value of the parsed structure, so the
 *     rules see the key the model will read (`patient<zero-width space>name` is `patient name` to it).
 *     The work is bounded: a run of more than 64 combining marks (which no text has, and which
 *     makes compatibility normalization quadratic) withholds the document as unreadable, the
 *     compatibility step sees at most four caps of text, and JSON nesting past 32 levels is refused.
 *  2. The string is then built in full and cut: the prose text, or the serialized normalized
 *     structure (the shown keys of `dataset_description.json`; for `participants.json` a count and
 *     the column descriptions, which are only `LongName`, `Description` and `Units`, each cut
 *     short, and never a column's name),
 *     cut to its cap on a character boundary. The text rule runs over THAT string, so a finding in
 *     the part a cut removes does not withhold prose whose sent bytes are clean, and no byte the
 *     rules did not see is ever sent.
 *  3. For the two JSON documents the rules also run over the normalized structure: the key rule
 *     (`participants.json`: the whole file, which is at least what is sent, so it can only be
 *     stricter), and the path rules over EACH string value and EACH key on its own. Over the
 *     serialized text a newline or tab inside a string is two characters, and the shared rule's
 *     lookbehind then skips a path that, as the parsed string, starts a line.
 *  4. Anything the rules cannot clear, or that throws, is withheld, never sent.
 *
 * What the rules can and cannot see is stated in ADR 0102: for prose the only rule is a local
 * user path, so this is a consistency control, not a privacy control. It never decides anything
 * about names, email addresses or dates in prose.
 *
 * A document that makes the examination itself fail (a JSON value nested so deeply that walking it
 * overflows the stack) is withheld as unreadable: nothing here fails open.
 *
 * Nothing in this file prints anything. The findings it sees are counted by kind and returned;
 * neither a finding's value nor a byte of a document leaves the function.
 */

import { createHash } from "node:crypto";
import {
  type Finding,
  type FindingKind,
  countByKind,
  scanJsonKeys,
  scanTableColumns,
  scanTextForLocalPaths,
  shapeOf,
} from "../../shared/identifier-scan";
import {
  type ClearedDocuments,
  type ClearedText,
  DESCRIPTION_KEYS_SHOWN,
  DOCUMENT_CHAR_CAPS,
  type DocumentState,
  type PreSend,
  type PreSendResult,
  REVIEW_DOCUMENTS,
  type RawDocument,
  type ReviewDocument,
} from "../../shared/publication-review";
import { tidy } from "../../shared/untrusted-text";

/** A document that has no text to examine, or text that is ready to be. */
type Prepared =
  | { kind: "no-text"; state: DocumentState }
  | {
      kind: "text";
      /** The exact string that would be sent. */
      sent: string;
      /** The document was longer than its cap and `sent` is its start. */
      cut: boolean;
      /**
       * What the rules that run on the normalized structure of a JSON document found in it (its
       * keys and every string in it); none for prose, which has no structure.
       */
      findings: Finding[];
      /** Shown and not-shown top-level keys; both 0 for anything but the description. */
      keysShown: number;
      keysNotShown: number;
    };

/**
 * The fields of a participants.json column the model is shown, and the most characters of each
 * (a column description is a short name, a sentence or two, and a unit).
 */
export const PARTICIPANT_FIELD_CAPS = { LongName: 100, Description: 500, Units: 50 } as const;
/**
 * A participants.json of more columns than this is keyed by participant, not by variable: it is
 * withheld as unreadable. Real files have a few dozen columns.
 */
export const PARTICIPANT_MAX_COLUMNS = 200;
/** A column name longer than this is not a variable name (it is a phrase, or a person). */
export const PARTICIPANT_KEY_MAX = 64;
/**
 * What a study code looks like (`sub01`, `S01`, `P001`, `participant_01`, `subject-01`): the shared
 * rule's own pattern, `SUBJECT_LABEL` in `shared/identifier-scan.ts`, which does not export it. A
 * test reads that file and fails if the two differ, so the copy cannot drift.
 */
export const PARTICIPANT_LABEL = /^(sub|subj|subject|s|p|pt|participant)[-_ ]?\d+$/i;
const PARTICIPANT_NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/;

/**
 * The deepest nesting a JSON document may have, counting the object at its root as level 1. Real
 * metadata is a handful of levels deep; pretty-printing indents every level, so a value nested n deep
 * serializes to about n squared characters, and walking it recursively can overflow the stack. The
 * limit is checked, iteratively, before the structure is normalized or serialized.
 */
export const MAX_JSON_DEPTH = 32;

/** Whether `value` is nested deeper than `max`, walked with a stack of its own and stopping at once. */
function nestedDeeperThan(value: unknown, max: number): boolean {
  const pending: [unknown, number][] = [[value, 1]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, depth] = next;
    if (typeof node !== "object" || node === null) continue;
    if (depth > max) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      pending.push([child, depth + 1]);
    }
  }
  return false;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Three ways to write a path on someone's machine that the shared rule does not read, because it
 * knows `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` only: a `file:` URL (the
 * `GeneratedBy` entry's `CodeURL` is where one turns up), a Windows drive path in either slash
 * (`D:/lab`, `C:/Users/<name>`), and a UNC path (`\\server\share`). None of them is a thing a
 * published description needs to say.
 *
 * A form counts where it starts a string or follows anything but a letter or digit, so `profile:`
 * and `https://` are not drive paths or file URLs. These rules run over the JSON strings and keys
 * only; prose keeps the shared rule alone, which ADR 0102 describes as a consistency control.
 */
const LOCAL_PATH_FORMS: readonly RegExp[] = [
  /(?<![A-Za-z0-9+.-])file:(?:[\\/]|[A-Za-z]:)/i,
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/,
  /(?<![A-Za-z0-9\\])\\\\(?=[^\\\s])/,
];

/** One finding when the text holds one of {@link LOCAL_PATH_FORMS}, shaped from the match alone. */
export function scanLocalPathForms(text: string): Finding[] {
  for (const form of LOCAL_PATH_FORMS) {
    const m = form.exec(text);
    if (m !== null) {
      return [{ kind: "local-user-path", severity: "review", field: "text", shape: shapeOf(m[0]) }];
    }
  }
  return [];
}

/**
 * Every string and every key of a normalized JSON value, each examined ON ITS OWN by the shared
 * path rule and by {@link scanLocalPathForms}. Over the serialized text a newline or a tab inside a
 * string is the two characters backslash and `n` or `t`, so the shared rule's lookbehind sees a
 * letter before a path that, in the string the model reads, starts a line. At most one finding is
 * returned: a document with a path in it is withheld, and one finding says so.
 */
function scanStructureForPaths(value: unknown): Finding[] {
  if (typeof value === "string") {
    const found = scanTextForLocalPaths(value);
    return found.length > 0 ? found : scanLocalPathForms(value);
  }
  const children = Array.isArray(value)
    ? value
    : isPlainObject(value)
      ? Object.entries(value).flat()
      : [];
  for (const child of children) {
    const found = scanStructureForPaths(child);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * A parsed JSON value with {@link normalizeBounded} applied to every string AND every key, to any
 * depth. The model is sent the cleaned text, so the rules must look at the cleaned structure: a key
 * `patient<zero-width space>name` is the key `patient name` to the model, and `scanJsonKeys` would
 * not have matched the first. Each string is cut to the document's cap with the cut mark (a string
 * longer than the cap makes the serialization longer than it, so the document is `sent_cut` by the
 * ordinary cut and no flag is needed). Built with `Object.fromEntries`, which defines each key as
 * data, so a key named `__proto__` is kept and examined instead of becoming a prototype.
 */
function normalizeStructure(value: unknown, cap: number): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return normalizeBounded(v, cap).text;
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      return Object.fromEntries(
        Object.entries(v).map(([k, child]) => [normalizeBounded(k, cap).text, walk(child)]),
      );
    }
    return v;
  };
  return walk(value);
}

/**
 * Code points that render as nothing, or as a blank letter, and that the control-character cleaning
 * does not touch: the Unicode property `Default_Ignorable_Code_Point` less the format characters
 * (`Cf`), which `tidy` turns into spaces. That is the combining grapheme joiner (U+034F), the
 * Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the Khmer inherent vowels (U+17B4, U+17B5), the
 * variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF) and Mongolian free variation
 * selectors (U+180B to U+180D, U+180F), and the unassigned default-ignorable code points. They are
 * REMOVED, not spaced: a reader sees no gap where one stands, so a path or a key split by one is,
 * to the reader and to the model, the whole path or key, and the rules must see it whole.
 *
 * Not in the set, on purpose: the zero-width joiner and non-joiner and the other format characters
 * stay as `tidy` leaves them (a space), so nothing here changes how text in the scripts that use
 * them is read; and the braille blank is handled apart, see {@link BRAILLE_BLANK}.
 */
const INVISIBLE = /(?!\p{Cf})\p{Default_Ignorable_Code_Point}/gu;
/**
 * U+2800, the braille pattern with no dots. It is not invisible: it has the width of a cell and is
 * the word space of braille text, so a reader sees a gap. It becomes a space, which keeps braille
 * words apart and gives a path no way past the rule that an ordinary space does not.
 */
const BRAILLE_BLANK = /\u2800/g;
/** In unicode mode this matches only a surrogate that is not half of a pair. */
const LONE_SURROGATE = /\p{Cs}/gu;

/** The longest run of combining marks real text has; a longer one is refused. */
export const MAX_COMBINING_RUN = 64;
/**
 * The compatibility step sees at most this many caps of text. NFKC reorders combining marks, which
 * is quadratic in the length of a run of marks of mixed classes, and it used to run on the whole
 * raw document before any cut.
 */
const COMPATIBILITY_INPUT_CAPS = 4;
const MARK_RUN = /\p{M}+/gu;

/** Whether `run` is more than `limit` code points, without spreading a long one. */
function longerThan(run: string, limit: number): boolean {
  if (run.length <= limit) return false;
  if (run.length > 2 * limit) return true;
  let n = 0;
  for (const _ of run) n++;
  return n > limit;
}

/** The linear part of the normalization: everything that removes or replaces, and no NFKC. */
function strip(text: string): string {
  return text.replace(INVISIBLE, "").replace(LONE_SURROGATE, "").replace(BRAILLE_BLANK, " ");
}

/** Throws on a run of more than {@link MAX_COMBINING_RUN} combining marks, which no text has. */
function refuseLongMarkRuns(text: string): void {
  for (const m of text.matchAll(MARK_RUN)) {
    if (longerThan(m[0], MAX_COMBINING_RUN))
      throw new Error("a run of combining marks no text has");
  }
}

/** The part of the normalization that needs a bounded input: compatibility form, then `tidy`. */
function settle(text: string): string {
  return tidy(text.normalize("NFKC"), Number.MAX_SAFE_INTEGER);
}

/**
 * The one normalization every string goes through before any rule looks at it, and the string the
 * model is sent: invisible code points and any half of a surrogate pair removed, the braille blank
 * made a space, Unicode compatibility normalization (NFKC: a fullwidth solidus is `/`, a fullwidth
 * letter its ASCII letter, a ligature its letters, a superscript its digit, an accent and its
 * letter one character), and control and format characters replaced by spaces (`tidy`).
 *
 * The order is what makes the result a fixed point (normalizing it again changes nothing, which a
 * test sweeps): the removals come BEFORE the compatibility normalization, so characters that were
 * only apart because a mark stood between them compose, and the two code points that normalize INTO
 * the removed set (U+3164 and U+FFA0, both to U+1160) are removed before they can. Exported so that
 * test can reach it; nothing else imports it. It is NOT bounded: see {@link normalizeBounded}.
 */
export function normalizeText(text: string): string {
  return settle(strip(text));
}

/**
 * {@link normalizeText} with its cost bounded, and the text cut to `cap` characters with the mark.
 * The removals run first (they are linear), then a run of more than {@link MAX_COMBINING_RUN}
 * combining marks anywhere in the text throws (the caller withholds the document as unreadable),
 * then the text is cut to a bounded prefix on a character boundary before the compatibility step
 * sees it, and then to the cap. A cut at either step is a cut: `cut` says so, and the mark is there
 * even when the normalized prefix happens to be shorter than the cap. `inputCaps` is a parameter
 * only so a test can make that last case reachable: composition shrinks text by at most about three
 * to one, so with the real factor of four a bounded prefix always normalizes to more than the cap.
 */
export function normalizeBounded(
  text: string,
  cap: number,
  inputCaps: number = COMPATIBILITY_INPUT_CAPS,
): { text: string; cut: boolean } {
  const stripped = strip(text);
  refuseLongMarkRuns(stripped);
  const bound = inputCaps * cap;
  const bounded = stripped.length > bound;
  const normalized = settle(bounded ? cutAtBoundary(stripped, bound) : stripped);
  const result = cutTo(normalized, cap);
  if (bounded && !result.cut) return { text: `${normalized}\n[cut]`, cut: true };
  return result;
}

/** The first `n` characters of `text`, never ending in the first half of a surrogate pair. */
function cutAtBoundary(text: string, n: number): string {
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/**
 * `text` cut to `cap` characters with a visible mark, never in the middle of a character: a cut
 * that would leave the first half of a surrogate pair at the end stops one unit sooner.
 */
function cutTo(text: string, cap: number): { text: string; cut: boolean } {
  if (text.length <= cap) return { text, cut: false };
  const last = text.charCodeAt(cap - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap;
  return { text: `${text.slice(0, end)}\n[cut]`, cut: true };
}

/**
 * The string a document is sent as: normalized (bounded), then cut to `cap` characters. Whether it
 * was cut is judged on the normalized text, because a control character outside the Basic
 * Multilingual Plane is replaced by one space and so shortens the text.
 */
function toSent(text: string, cap: number): { sent: string; cut: boolean } {
  const { text: sent, cut } = normalizeBounded(text, cap);
  return { sent, cut };
}

/** Build the string a document would be sent as, or say why there is none. */
function prepare(document: ReviewDocument, raw: RawDocument): Prepared {
  switch (raw.state) {
    case "present":
      break;
    case "absent":
      return { kind: "no-text", state: "absent" };
    case "annexed":
      return { kind: "no-text", state: "withheld_annexed" };
    case "not_utf8":
      return { kind: "no-text", state: "withheld_not_utf8" };
    default:
      // "unreadable", and any word this function does not know: nothing is sent on a guess.
      return { kind: "no-text", state: "withheld_unreadable" };
  }
  if (typeof raw.text !== "string") return { kind: "no-text", state: "withheld_unreadable" };
  // A NUL means these bytes were not text (UTF-16 with no byte-order mark decodes as UTF-8 with a
  // NUL between letters, and the cleaning below would turn each into a space). The reader says so
  // already; this is the boundary's own check, for a caller that is not the reader.
  if (raw.text.includes("\u0000")) return { kind: "no-text", state: "withheld_not_utf8" };
  const cap = DOCUMENT_CHAR_CAPS[document];

  if (document !== "dataset_description" && document !== "participants_json") {
    return { kind: "text", ...toSent(raw.text, cap), findings: [], keysShown: 0, keysNotShown: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { kind: "no-text", state: "withheld_not_json" };
  }
  if (!isPlainObject(parsed)) return { kind: "no-text", state: "withheld_not_json" };

  if (document === "participants_json") return prepareParticipants(parsed, cap);

  const kept: Record<string, unknown> = {};
  let keysShown = 0;
  for (const key of DESCRIPTION_KEYS_SHOWN) {
    if (Object.hasOwn(parsed, key)) {
      kept[key] = parsed[key];
      keysShown++;
    }
  }
  if (nestedDeeperThan(kept, MAX_JSON_DEPTH))
    return { kind: "no-text", state: "withheld_unreadable" };
  // Normalize first, then examine the normalized structure, then send that same structure.
  const object = normalizeStructure(kept, cap);
  return {
    kind: "text",
    ...toSent(JSON.stringify(object, null, 2), cap),
    findings: [...scanJsonKeys(object), ...scanStructureForPaths(object)],
    keysShown,
    keysNotShown: Object.keys(parsed).length - keysShown,
  };
}

/** A top-level key that is a subject label, as the model would read it. */
const SUBJECT_LABEL_KEY = /^\s*sub-/i;

/**
 * participants.json, reduced to what ADR 0102 says the model is shown: the column descriptions, and
 * not the columns' names. What is sent is `{ column_count, columns }`: for each top-level column, in
 * file order and with no key, its `LongName`, `Description` and `Units` where they are strings, each
 * cut to {@link PARTICIPANT_FIELD_CAPS}, and nothing else (no levels, links, other keys or values of
 * any participant). The key of a column is never sent: a file keyed by participant (`sub01`, `S01`,
 * `Jane Doe`) would send every label.
 *
 * Withheld as unreadable: not an object of objects, more than {@link PARTICIPANT_MAX_COLUMNS}
 * columns, nested too deep. Withheld with a finding: a key that is a study code (the shared
 * `SUBJECT_LABEL` pattern, or `sub-` followed by anything), a number, longer than
 * {@link PARTICIPANT_KEY_MAX}, or named for an identifier (read by the JSON key rule and the
 * participants table's column rule whatever the column holds, because a column called `name` or
 * `email` is the finding even when it is empty). Every key
 * of the file is read as it would be normalized. The key rule also reads the keys inside each
 * column, and the path rules read what is sent.
 */
function prepareParticipants(parsed: Record<string, unknown>, cap: number): Prepared {
  const entries = Object.entries(parsed);
  if (
    entries.length > PARTICIPANT_MAX_COLUMNS ||
    !entries.every(([, column]) => isPlainObject(column)) ||
    nestedDeeperThan(parsed, MAX_JSON_DEPTH)
  ) {
    return { kind: "no-text", state: "withheld_unreadable" };
  }
  // Every column kept, in order: an object keyed by the normalized names would lose one of two
  // names that normalize alike, and the count would be wrong.
  const columns = entries.map(([key, column]) => ({
    key: normalizeBounded(key, cap).text,
    value: normalizeStructure(column, cap) as Record<string, unknown>,
  }));

  const findings: Finding[] = [];
  const labelled = columns.some(({ key }) => {
    const bare = key.trim();
    return (
      SUBJECT_LABEL_KEY.test(key) || PARTICIPANT_LABEL.test(bare) || PARTICIPANT_NUMBER.test(bare)
    );
  });
  if (labelled) {
    findings.push({
      kind: "path-subject-label",
      severity: "review",
      field: "participants-key",
      shape: shapeOf("sub-"),
    });
  }
  if (columns.some(({ key }) => key.length > PARTICIPANT_KEY_MAX)) {
    findings.push({
      kind: "participants-identifier-column",
      severity: "review",
      field: "participants-key",
      shape: shapeOf("long"),
    });
  }
  for (const { key, value } of columns) {
    // The name of the column, by the two shared rules that know names: the JSON key rule (given a
    // value, because it looks for content, so that it reads the name only) and the participants
    // table's column rule (`name`, `email`, `dob`, ...). One finding per column at most. Then the
    // keys inside the column.
    const named = scanJsonKeys({ [key]: "x" });
    findings.push(...(named.length > 0 ? named : scanTableColumns(key)), ...scanJsonKeys(value));
  }

  let fieldCut = false;
  const descriptions = columns.map(({ value }) => {
    const fields: Record<string, string> = {};
    for (const field of Object.keys(
      PARTICIPANT_FIELD_CAPS,
    ) as (keyof typeof PARTICIPANT_FIELD_CAPS)[]) {
      const text = Object.hasOwn(value, field) ? value[field] : undefined;
      if (typeof text !== "string") continue;
      const { text: kept, cut } = cutTo(text, PARTICIPANT_FIELD_CAPS[field]);
      fields[field] = kept;
      fieldCut ||= cut;
    }
    return fields;
  });
  findings.push(...scanStructureForPaths(descriptions));

  const sent = toSent(
    JSON.stringify({ column_count: descriptions.length, columns: descriptions }, null, 2),
    cap,
  );
  return {
    kind: "text",
    sent: sent.sent,
    cut: sent.cut || fieldCut,
    findings,
    keysShown: 0,
    keysNotShown: 0,
  };
}

/**
 * What this module has cleared, as SHA-256 digests of the document and the exact string, in a set no
 * one else can reach. The brand on `ClearedText` is a compile-time property: a type predicate, an
 * assertion function, a generic cast, `JSON.parse` or a suppressed error all produce "cleared" text
 * the compiler accepts. This is the run-time half: the prompt builder asks {@link isCleared} for
 * every document it is about to send and throws on a string this module did not clear.
 *
 * A set of digests, not of strings: the same guarantee by value, a fixed 32 bytes per entry however
 * long the document, and no copy of a depositor's text kept in module state for the life of the
 * process. It is per document, because the rules differ (a string cleared as prose is not what the
 * JSON rules cleared), and it is the process's, not a call's: nothing in a job calls presend twice,
 * and a registry that forgot would make a legitimate result from an earlier call throw.
 */
const clearedDigests = new Set<string>();

function digestOf(document: ReviewDocument, text: string): string {
  return createHash("sha256").update(document).update("\0").update(text, "utf8").digest("hex");
}

/**
 * Whether pre-send cleared exactly `text` as the `document`. The only thing exported about the
 * registry: nothing outside this file can add to it.
 */
export function isCleared(document: ReviewDocument, text: unknown): boolean {
  return typeof text === "string" && clearedDigests.has(digestOf(document, text));
}

/**
 * The pre-send check. Examines each document with the shared rules over the string that will be
 * sent, and returns that string, branded, for the documents the rules found nothing in. See the
 * file header for the rules, and `PreSendResult` for what each state means.
 */
export const presend: PreSend = (docs): PreSendResult => {
  const cleared: ClearedDocuments = {};
  const states = {} as Record<ReviewDocument, DocumentState>;
  const withheldFindings: Partial<Record<FindingKind, number>> = {};
  let keysShown = 0;
  let keysNotShown = 0;

  for (const document of REVIEW_DOCUMENTS) {
    try {
      const prepared = prepare(document, docs[document]);
      if (prepared.kind === "no-text") {
        states[document] = prepared.state;
        continue;
      }
      const findings: Finding[] = [...prepared.findings];
      // The rule over the whole string that will be sent. For a JSON document the structure's own
      // finding already says a path is there, and one finding per document is what is counted.
      if (!findings.some((f) => f.kind === "local-user-path")) {
        findings.push(...scanTextForLocalPaths(prepared.sent));
      }
      if (findings.length > 0) {
        states[document] = "withheld_finding";
        for (const [kind, n] of Object.entries(countByKind(findings))) {
          withheldFindings[kind as FindingKind] = (withheldFindings[kind as FindingKind] ?? 0) + n;
        }
        continue;
      }
      // The one cast of the repository: this string was examined, byte for byte, and nothing was
      // found in it.
      cleared[document] = prepared.sent as ClearedText;
      clearedDigests.add(digestOf(document, prepared.sent));
      states[document] = prepared.cut ? "sent_cut" : "sent";
      keysShown += prepared.keysShown;
      keysNotShown += prepared.keysNotShown;
    } catch {
      // The examination itself failed: whatever this document is, it is not cleared.
      delete cleared[document];
      states[document] = "withheld_unreadable";
    }
  }
  return {
    cleared,
    states,
    withheld_findings: withheldFindings,
    description_keys_shown: keysShown,
    description_keys_not_shown: keysNotShown,
  };
};
