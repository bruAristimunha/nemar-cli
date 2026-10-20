/**
 * Remove identifier-named keys from the `attributes` of a Zarr `zarr.json`, editing the TEXT.
 *
 * The root group of every Zarr store the pipeline writes carries the recording's header fields
 * (`attributes.recording_metadata.patientcode`, `.birthdate`, `.technician`, ...), so the serving
 * copy repeats what the scrub removes from the EDF. Two rules decide which members go, and both
 * live here so that what the zarr stage removes, what it re-reads to prove, and what the public
 * check after publication looks for are one rule ({@link zarrIdentifierCount}):
 *
 *  - every key the scanner calls an identifier (`scanJsonKeys` in `shared/identifier-scan.ts`);
 *  - every member that mirrors an EDF identification field ({@link EDF_MIRROR_MEMBERS}).
 *
 * Why text and not parse-and-stringify: a re-serialized document changes more than the keys it
 * was asked to drop. `1.0` becomes `1`, an integer past 2^53 loses digits, `é` becomes `é`,
 * key order and indentation change, and a Zarr reader of that file would be reading something
 * nobody reviewed. Here every byte outside the removed members is the original byte: a scanner
 * walks the text once, records where each member of each object starts and ends, and the removed
 * members (with the one comma that joined them to their neighbor) are cut from the string.
 *
 * Nothing here ever returns, logs or throws a value from the document: errors are fixed words.
 */

import { canonical, hasContent, scanJsonKeys } from "../../../shared/identifier-scan";

/**
 * THE PRINCIPLE behind this list and {@link KNOWN_BENIGN} (maintainer decision, 2026-10-05):
 *
 * **A Zarr store holds the DATA and the EVENTS, plus channel names, types and units and
 * technical recording metadata. It says nothing about the SUBJECT. Subject and phenotype
 * information (age, sex or gender, patient code, birth date, name, additional patient text)
 * lives at DATASET scope; `participants.tsv` is the one canonical place for it, and agents and
 * people go there.** Operator and administrative free text copied from a recording header
 * (technician, administrative code, equipment, additional recording text) is not data, events or
 * channels either.
 *
 * So the members removed from a store are every subject field the converter mirrors from the
 * EDF/BDF patient identification, plus the operator and administrative free text from the
 * recording identification (this set), plus anything the scanner calls an identifier. And the
 * members a store's recording metadata may keep are exactly the technical ones
 * ({@link KNOWN_BENIGN}); any other name is refused until a person has looked at it and named it
 * with `--allow-member`, because a name nobody listed may hold header text.
 *
 * The EDF identification fields the converter copies into a store's root attributes, in the
 * scanner's canonical spelling (lowercase, no spaces, underscores or hyphens), so `patient_name`,
 * `PatientName` and `patient-name` are one name.
 *
 * Where they come from: biosigio's EDF importer (`biosigio/importers/edf.py`,
 * `_extract_metadata`) reads pyedflib's header dict into `recording_info` as `patientcode`,
 * `gender`, `birthdate`, `patient_name`, `patient_additional`, `admincode`, `technician`,
 * `equipment` and `recording_additional` (and `startdate`), then sets every non-empty one on the
 * recording's metadata, which the Zarr exporter writes as `attributes.recording_metadata`. The
 * converter in `scripts/zarr/` adds no spelling of its own. `equipment` is free text copied from
 * the header's recording field: not data, events or channels.
 *
 * `gender` is removed too (decision 2026-10-05): the scrubbed header's patient field is
 * `X X X X` (code, sex, birth date and name all unknown), and the store must say no more than the
 * header does; participants.tsv keeps sex.
 *
 * Measured on 2026-10-05 (names only): every one of nm000186's 88 store roots holds
 * `patientcode`, `birthdate`, `gender` and `equipment`, non-empty, and none of the other five;
 * nm000348's 153 hold none of them.
 */
export const EDF_MIRROR_MEMBERS: ReadonlySet<string> = new Set([
  "patientcode",
  "birthdate",
  "gender",
  "patientname",
  "patientadditional",
  "admincode",
  "technician",
  "equipment",
  "recordingadditional",
]);

/**
 * The members a store's recording metadata (`recording_metadata`, or biosigio's
 * `recording_info`) may keep, canonical spelling: recording-level technical metadata only.
 * Transcribed from the stores biosigio 1.2.10 (the converter's pin, scripts/zarr/requirements.txt)
 * wrote for nm000186 and nm000348 (census of 2026-10-05, names only): `startdate` (an
 * acquisition date does not gate, ADR 0085), `filetype`, `number_of_signals`, `file_duration`,
 * `datarecord_duration`, `source_file`, `source_format`, `streamed`, and `channels_tsv_units`
 * with whatever it holds (a units report). The converter's own notes name five more technical
 * flags a store can carry (`channel_labels_deduplicated`, `brainvision_header_recovered`,
 * `brainvision_dropped_bytes`, `eeglab_fdt_recovered`, `edf_tolerant_read`); they are NOT listed
 * here, so a store that has one is refused until `--allow-member` names it after a look.
 */
export const KNOWN_BENIGN: ReadonlySet<string> = new Set([
  "startdate",
  "filetype",
  "numberofsignals",
  "fileduration",
  "datarecordduration",
  "sourcefile",
  "sourceformat",
  "streamed",
  "channelstsvunits",
]);

/** Where a store keeps the recording's header fields: the converter's name, and biosigio's. */
export const RECORDING_OBJECTS: readonly string[] = ["recording_metadata", "recording_info"];

/** A zarr.json is a few KiB. Anything past this is not metadata and is not read. */
export const MAX_ZARR_JSON_BYTES = 16 * 1024 * 1024;

/** A store root: `<dataset>/zarr/<path>/<name>.zarr/zarr.json`, not a group or array inside it. */
export const STORE_ROOT = /\.zarr\/zarr\.json$/;

export class ZarrJsonError extends Error {
  constructor(readonly word: "zarr-json-malformed" | "zarr-json-bom") {
    super(word);
    this.name = "ZarrJsonError";
  }
}

/**
 * A zarr.json's bytes as text and as a parsed document, or a fixed word why not. Decoding is
 * fatal: a byte that is not UTF-8 would come back as U+FFFD, and a rewrite would then change bytes
 * that were never meant to change. A UTF-8 byte order mark is refused outright (`zarr-json-bom`):
 * a decoder drops it silently, so the rewrite would lose three bytes that were never cut, and the
 * claim that every byte outside the removed members is the original byte would be false.
 */
export function parseZarrJsonBytes(bytes: Uint8Array): { text: string; doc: unknown } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new ZarrJsonError("zarr-json-bom");
  }
  try {
    // ignoreBOM keeps a mark in the text rather than eating it, so even a BOM this check missed
    // would reach JSON.parse and be refused there.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const doc = JSON.parse(text) as unknown;
    // `JSON.parse` keeps the LAST of two members with one name, so `doc` would show the empty
    // one and hide the other from every count. The span scan refuses a repeated name.
    parseSpans(text);
    return { text, doc };
  } catch {
    throw new ZarrJsonError("zarr-json-malformed");
  }
}

interface Member {
  key: string;
  /** Offset of the key's opening quote. */
  start: number;
  /** Offset just past the end of the value. */
  end: number;
  value: Node;
}

type Node =
  | { kind: "object"; start: number; end: number; members: Member[] }
  | { kind: "array"; start: number; end: number; items: Node[] }
  | { kind: "scalar"; start: number; end: number };

/** Metadata is shallow; a document nested deeper than this is refused rather than recursed. */
const MAX_DEPTH = 128;

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Where every member of every object sits in `text`. `text` must already be valid JSON. */
function parseSpans(text: string): Node {
  let i = 0;
  const bad = (): never => {
    throw new ZarrJsonError("zarr-json-malformed");
  };
  const ws = () => {
    while (i < text.length && isSpace(text.charAt(i))) i++;
  };
  const string = (): string => {
    const start = i;
    if (text.charAt(i) !== '"') bad();
    i++;
    while (i < text.length && text.charAt(i) !== '"') {
      if (text.charAt(i) === "\\") i++;
      i++;
    }
    if (i >= text.length) bad();
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (depth: number): Node => {
    if (depth > MAX_DEPTH) bad();
    ws();
    const start = i;
    const c = text.charAt(i);
    if (c === "{") {
      i++;
      const members: Member[] = [];
      ws();
      if (text.charAt(i) === "}") {
        i++;
        return { kind: "object", start, end: i, members };
      }
      const names = new Set<string>();
      for (;;) {
        ws();
        const memberStart = i;
        const key = string();
        if (names.has(key)) bad();
        names.add(key);
        ws();
        if (text.charAt(i) !== ":") bad();
        i++;
        const v = value(depth + 1);
        members.push({ key, start: memberStart, end: v.end, value: v });
        ws();
        if (text.charAt(i) === ",") {
          i++;
          continue;
        }
        if (text.charAt(i) === "}") {
          i++;
          break;
        }
        bad();
      }
      return { kind: "object", start, end: i, members };
    }
    if (c === "[") {
      i++;
      const items: Node[] = [];
      ws();
      if (text.charAt(i) === "]") {
        i++;
        return { kind: "array", start, end: i, items };
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text.charAt(i) === ",") {
          i++;
          continue;
        }
        if (text.charAt(i) === "]") {
          i++;
          break;
        }
        bad();
      }
      return { kind: "array", start, end: i, items };
    }
    if (c === '"') {
      string();
      return { kind: "scalar", start, end: i };
    }
    while (i < text.length && !",]}".includes(text.charAt(i)) && !isSpace(text.charAt(i))) i++;
    if (i === start) bad();
    return { kind: "scalar", start, end: i };
  };
  const root = value(0);
  ws();
  if (i !== text.length) bad();
  return root;
}

const nameCache = new Map<string, boolean>();

/** True when a member of this name is removed whenever it holds something. */
function isRemovableName(key: string): boolean {
  let hit = nameCache.get(key);
  if (hit === undefined) {
    // The scanner flags an identifier name exactly when its value holds content, so asking with
    // a placeholder value asks about the name alone. A computed key defines an own property even
    // for `__proto__`.
    hit =
      EDF_MIRROR_MEMBERS.has(canonical(key)) ||
      scanJsonKeys({ [key]: "x" }).some((f) => f.severity === "identifier");
    nameCache.set(key, hit);
  }
  return hit;
}

/**
 * True when a member of this name holding this value is removed: the scanner calls the name an
 * identifier, or the name mirrors an EDF identification field, AND the value holds something. An
 * empty value (`""`, `null`, `[]`, `{}`) is never removed.
 */
export function isRemovableMember(key: string, value: unknown): boolean {
  return isRemovableName(key) && hasContent(value);
}

/**
 * How many members of a parsed document {@link isRemovableMember} would remove, at any depth and
 * anywhere in the document (not only under `attributes`), counting a removed member once however
 * much it holds. Zero is the only clean answer: the zarr stage, its re-read after a write, its
 * proof and the public check after publication all ask this one function.
 */
export function zarrIdentifierCount(doc: unknown): number {
  if (Array.isArray(doc)) return doc.reduce((n: number, item) => n + zarrIdentifierCount(item), 0);
  if (doc === null || typeof doc !== "object") return 0;
  let n = 0;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    n += isRemovableMember(key, value) ? 1 : zarrIdentifierCount(value);
  }
  return n;
}

/** True when the scanner knows a member of this name at all (an identifier or a review key). */
function isScannerKey(key: string): boolean {
  return scanJsonKeys({ [key]: "x" }).length > 0;
}

/**
 * The names of the members of a document's recording metadata (`attributes.recording_metadata`
 * or `attributes.recording_info`) that no list accounts for: not technical
 * ({@link KNOWN_BENIGN}), not removed ({@link isRemovableMember}'s names), not a key the scanner
 * knows, and not named by the operator (`allowed`, canonical spelling). Names only, never a value;
 * empty is the only answer that lets a store be called clean.
 */
export function unknownRecordingMembers(doc: unknown, allowed: ReadonlySet<string>): string[] {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [];
  const attributes = (doc as Record<string, unknown>).attributes;
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return [];
  const out: string[] = [];
  for (const name of RECORDING_OBJECTS) {
    const meta = (attributes as Record<string, unknown>)[name];
    if (meta === undefined) continue;
    // A recording-metadata member that is not an object holds something nobody can name.
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      if (hasContent(meta)) out.push(name);
      continue;
    }
    for (const key of Object.keys(meta as Record<string, unknown>)) {
      const c = canonical(key);
      if (KNOWN_BENIGN.has(c) || allowed.has(c) || isRemovableName(key) || isScannerKey(key)) {
        continue;
      }
      out.push(key);
    }
  }
  return out;
}

/**
 * The spans to cut so the members flagged in `gone` leave a valid object. A removed member takes
 * the comma after it; a run of removed members at the END takes the comma before the run instead,
 * because the last kept member must not be left with a trailing comma.
 */
function cutsFor(
  node: Extract<Node, { kind: "object" }>,
  gone: boolean[],
): Array<[number, number]> {
  const m = node.members;
  const removed = gone.filter(Boolean).length;
  if (removed === 0) return [];
  if (removed === m.length) return [[node.start + 1, node.end - 1]];
  let tail = m.length;
  while (tail > 0 && gone[tail - 1]) tail--;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < tail; i++) {
    if (gone[i]) out.push([(m[i] as Member).start, (m[i + 1] as Member).start]);
  }
  if (tail < m.length) out.push([(m[tail - 1] as Member).end, (m[m.length - 1] as Member).end]);
  return out;
}

export interface Removal {
  /** The document with the members cut out. Equal to the input when `removed` is 0. */
  text: string;
  /** Members cut out, counting a removed member once however much it held. */
  removed: number;
}

/**
 * Cut every member {@link isRemovableMember} names out of the `attributes` of a zarr.json, at any
 * depth, through objects and arrays. Members that merely contain one deeper are kept and searched.
 * Everything outside `attributes` is left alone, and so is every key the scanner reads as `review`
 * severity (an email, a phone).
 *
 * `text` must parse as JSON with an object at the top; anything else is `zarr-json-malformed`.
 */
export function removeIdentifierKeys(text: string): Removal {
  try {
    JSON.parse(text);
  } catch {
    throw new ZarrJsonError("zarr-json-malformed");
  }
  const root = parseSpans(text);
  if (root.kind !== "object") throw new ZarrJsonError("zarr-json-malformed");

  const cuts: Array<[number, number]> = [];
  let removed = 0;
  const walk = (node: Node): void => {
    if (node.kind === "array") {
      for (const item of node.items) walk(item);
      return;
    }
    if (node.kind !== "object") return;
    const gone = node.members.map(
      (m) =>
        isRemovableName(m.key) &&
        hasContent(JSON.parse(text.slice(m.value.start, m.value.end)) as unknown),
    );
    // A loop, not `cuts.push(...)`: the number of cuts is the document's to choose.
    for (const cutAt of cutsFor(node, gone)) cuts.push(cutAt);
    removed += gone.filter(Boolean).length;
    node.members.forEach((m, i) => {
      if (!gone[i]) walk(m.value);
    });
  };
  for (const m of root.members) if (m.key === "attributes") walk(m.value);

  cuts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [from, to] of cuts) {
    if (from < at) throw new ZarrJsonError("zarr-json-malformed");
    out += text.slice(at, from);
    at = to;
  }
  out += text.slice(at);
  return { text: out, removed };
}
