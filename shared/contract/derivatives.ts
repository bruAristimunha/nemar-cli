/**
 * The derivative store's contract (portable compute, ADR 0123): the derivative KEY, the store
 * CONTENT DIGEST it is built from, the INPUT DIGEST, and the retention words. Pure and import-free,
 * like `../compute-recipes.ts`, so the Worker, the command-line interface, the recipes' Python and
 * the readers' conformance suite all hold one definition. SHA-256 comes from `crypto.subtle`, which
 * the Worker and Bun both provide; nothing else is imported.
 *
 * ONE DEFINITION, TWO LANGUAGES. Everything below is byte-exact and language-neutral: text is
 * hashed as its UTF-8 bytes, numbers as IEEE-754 binary64, lines end in a line feed (LF, U+000A). The
 * test vectors in `./derivatives-vectors.json` are reproduced by this module and by the recipes in
 * `nemarOrg/nemar-process`; a vector that moves is a change to the definition, which the maintainer
 * decides, and is never edited to make code pass.
 *
 * WHAT A DIGEST CAN AND CANNOT SAY. Until the converter writes each store's content digest at commit,
 * the recipe computes it from what it read and records it; the platform records it and cannot verify
 * it (ADR 0123 decision 7). `storeContentSha256` hashes the whole group in one `crypto.subtle` call,
 * so it is for vectors and for groups that fit in memory; a real recording is hashed by the recipe,
 * which streams. This module owns the definition, not the production of a digest at scale.
 *
 * REFUSAL, NEVER A GUESS. Anything the definition cannot carry unambiguously has no digest: the
 * function throws `DerivativeContractError`, or for the key fields the validator names the field. A
 * caller that meets one records "unkeyable" and moves on. The refusals are listed in ADR 0123
 * decisions 2 to 4 and held by `./derivatives-vectors.json` (`refused`) and the tests: a line feed or
 * carriage return in a label or unit, a lone surrogate in any text, a rate, scale, offset, digital
 * value or product that is not finite, fewer than one channel or sample, no stores, a repeated path,
 * an empty path or group, a tab in a path or group, a store digest that is not 64 lowercase
 * hexadecimal digits, and a key field outside its rule.
 *
 * WHICH FIELD. `DerivativeContractError.field` names what `inputDigest` refused, so a caller maps a
 * refusal to a fixed word without reading a message: `stores_content` (no rows, not a list, a row
 * that is not an object), `path`, `group` or `content_sha256` (that field of a row, or for `path` a
 * repeated one). The key functions carry the key field's name, as `validateDerivativeKeyFields`
 * does. Errors from the store content functions carry no field.
 *
 * VERSION 2 OF THE INPUT DIGEST (ADR 0123, amendment 2026-11-16). A recipe that hands electrode
 * positions to eegprep depends on them, and the store content digest holds none, so a Zarr input is
 * keyed by `inputDigestV2`: rows of four fields, the fourth a store's `nemar.store-locations.v1`
 * digest (`storeLocationsSha256`) or `none` when the recipe by design handed eegprep no positions
 * from that store. A Zarr derivative is keyed under version 2 only (the code that writes one
 * recomputes `inputDigestV2`), and version 1 stays defined, unchanged, because nemar-process records
 * written before the Python side of version 2 existed state a version 1 digest; no derivative was
 * ever keyed under version 1. The key keeps `nemar.derivative-key.v1` and its validator: a version 2
 * digest is a valid `sha256:` input digest, and the header line of each version makes a version 1
 * text and a version 2 text different bytes. The refusal field `locations` is `inputDigestV2`'s own.
 * Readers parse JSON integers as binary64: in Python, `json.loads(text, parse_int=float)`, which
 * gives the same values as `JSON.parse`, including -0.0 and inf. A plain `json.loads` raises
 * `ValueError` on an integer literal of more than 4300 digits, which `JSON.parse` reads as Infinity,
 * so a store root with one has a locations digest in TypeScript and cannot be read in Python.
 */

/** The first line of a store content header, and the name of the digest. */
export const STORE_CONTENT_FORMAT = "nemar.store-content.v1";

/** The first line of a store locations text, and the name of the digest. */
export const STORE_LOCATIONS_FORMAT = "nemar.store-locations.v1";

/** The first line of a version 2 input digest text, and the name of the digest. */
export const INPUT_DIGEST_V2_FORMAT = "nemar.input-digest.v2";

/**
 * The `locations` field of a version 2 input digest row when the recipe by design handed eegprep no
 * positions from that store. It never means that the store had none: a store without positions has
 * the digest of the text `storeLocationsText` writes for it.
 */
export const LOCATIONS_NONE = "none";

/** The first line of a derivative key's text, and the name of the key. */
export const DERIVATIVE_KEY_FORMAT = "nemar.derivative-key.v1";

/**
 * The retention classes. `canary` expires `CANARY_DAYS` after it is stored; `catalog` is kept until a
 * later `catalog` derivative of the same dataset, recipe, input and profile is promoted, then expires
 * `SUPERSEDED_GRACE_DAYS` after that; `published` never expires and only the owner sets it. Every
 * derivative starts as `canary`. No code path mints a Digital Object Identifier (DOI).
 */
export const RETENTION_CLASSES = Object.freeze(["canary", "catalog", "published"] as const);

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const CANARY_DAYS = 30;

export const SUPERSEDED_GRACE_DAYS = 30;

/**
 * The one sentence a `serving`-profile derivative carries about what it was computed on, declared
 * once. The serving copy is 16-bit and its rate is capped per modality (EEG and MEG at 250 Hz, iEEG
 * and EMG at 1000 Hz). This sentence names EEG only, which is true of every derivative the store can
 * take today: the one Zarr-input recipe reads only a store's EEG group. THE RULE: the change that
 * first lets a recipe read an iEEG, EMG or MEG group adds that modality's sentence here, with an
 * amendment to ADR 0123, before any such derivative is stored. The sentence is in no key or digest,
 * so adding one orphans nothing. The archived recordings' rate is never stated.
 */
export const SERVING_PROFILE_SENTENCE =
  "Computed on NEMAR's Zarr serving copy (EEG capped at 250 Hz, 16-bit), not on the archived recordings.";

/** A definition was given something it has no digest for. */
export class DerivativeContractError extends Error {
  /** The key field or input the refusal is about, when it is about one. */
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "DerivativeContractError";
    this.field = field;
  }
}

// --- Text ------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Whether a string holds a surrogate code unit that is not half of a pair. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/**
 * Text is hashed as its UTF-8 bytes exactly as given: no normalization, no trimming. A lone
 * surrogate is refused before any encoding, because `TextEncoder` would replace it with U+FFFD and
 * two different texts would then share a digest.
 */
function refuseLoneSurrogate(text: string, what: string, field?: string): void {
  if (hasLoneSurrogate(text)) {
    throw new DerivativeContractError(`${what} holds a lone surrogate and has no digest`, field);
  }
}

/**
 * The UTF-8 bytes of text already checked for lone surrogates. `TextEncoder` always backs its
 * result with an `ArrayBuffer`, but the Worker's and Bun's type definitions say so differently, and
 * `crypto.subtle.digest` accepts only the narrow type: the assertion is what both type sets share.
 */
function encodeText(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

/** Lowercase hexadecimal of bytes. */
function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 of bytes as 64 lowercase hexadecimal digits. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// --- Store content digest --------------------------------------------------------------------

/** A channel's label or unit as a store states it: text, empty, or absent. */
export type ChannelText = string | null | undefined;

export interface StoreContentHeaderInput {
  /** The number of channels, C. */
  channels: number;
  /** The number of samples per channel, S. */
  samples: number;
  /** The serving rate in hertz. */
  rate: number;
  /** One entry per channel, as the store states each channel's unit. */
  units: readonly ChannelText[];
  /** One entry per channel, as the store states each channel's label. */
  labels: readonly ChannelText[];
}

export interface StoreContentInput {
  /** C rows of S digital values, channel-major: `digital[c][s]`. */
  digital: readonly ArrayLike<number>[];
  /** One scale and one offset per channel. */
  scale: ArrayLike<number>;
  offset: ArrayLike<number>;
  rate: number;
  units: readonly ChannelText[];
  labels: readonly ChannelText[];
}

function nonEmpty(text: ChannelText): text is string {
  return typeof text === "string" && text.length > 0;
}

/** Whether every entry has text; a plain loop, so a hole in a sparse list counts as no text. */
function allNonEmpty(list: readonly ChannelText[]): boolean {
  for (let i = 0; i < list.length; i++) if (!nonEmpty(list[i])) return false;
  return true;
}

/** Whether every entry is exactly `text`, holes included. */
function allEqual(list: readonly ChannelText[], text: string): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] !== text) return false;
  return true;
}

/** One entry per channel, each text, empty or absent; anything else is refused. */
function channelTexts(list: readonly ChannelText[], channels: number, what: string) {
  if (!Array.isArray(list) || list.length !== channels) {
    throw new DerivativeContractError(`${what} must be a list with one entry per channel`);
  }
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (entry !== null && entry !== undefined && typeof entry !== "string") {
      throw new DerivativeContractError(`${what} holds an entry that is not text`);
    }
  }
}

/**
 * The text a header line may carry: refused when it holds a carriage return or line feed (the line
 * would end early) or a lone surrogate. Called only for text that enters the header.
 */
function headerText(text: string, what: string): string {
  if (/[\r\n]/.test(text)) {
    throw new DerivativeContractError(
      `${what} holds a carriage return or line feed and has no digest`,
    );
  }
  refuseLoneSurrogate(text, what);
  return text;
}

function sizeWord(value: number, what: string, least: number): void {
  if (!Number.isSafeInteger(value) || value < least) {
    throw new DerivativeContractError(`${what} must be an integer of at least ${least}`);
  }
}

/** The 16 lowercase hexadecimal digits of a rate as an IEEE-754 binary64, big-endian. */
function rateHex(rate: number): string {
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    throw new DerivativeContractError("the rate must be a finite number");
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, rate, false);
  return hex(new Uint8Array(view.buffer));
}

/**
 * The header of a store content digest, as text. The lines, each ending in a line feed:
 * the format name; `shape C S`; `rate H`; `unit` and the shared unit; one `label` line per channel;
 * `data float64-le`.
 *
 * Two rules decide the text, as eegprep-lean's `labels` and `unit` do. Labels are ALL OR NONE: the
 * lines carry labels only when every channel has a non-empty one, otherwise every line is `label`
 * alone. The unit is SHARED OR NONE: `unit` carries text only when every channel states the same
 * non-empty unit, otherwise `unit` alone, so an empty unit is no unit, never `unit` and a space.
 * The rules apply first; text they drop is never examined.
 */
export function storeContentHeader(input: StoreContentHeaderInput): string {
  sizeWord(input.channels, "the channel count", 1);
  sizeWord(input.samples, "the sample count", 1);
  channelTexts(input.units, input.channels, "units");
  channelTexts(input.labels, input.channels, "labels");

  const first = input.units[0];
  const sharedUnit = nonEmpty(first) && allEqual(input.units, first) ? first : "";
  const named = allNonEmpty(input.labels);

  const lines = [
    STORE_CONTENT_FORMAT,
    `shape ${input.channels} ${input.samples}`,
    `rate ${rateHex(input.rate)}`,
    sharedUnit === "" ? "unit" : `unit ${headerText(sharedUnit, "the unit")}`,
  ];
  for (let c = 0; c < input.channels; c++) {
    lines.push(named ? `label ${headerText(input.labels[c] as string, "a label")}` : "label");
  }
  lines.push("data float64-le");
  return `${lines.join("\n")}\n`;
}

/**
 * The store content digest: SHA-256 over the UTF-8 header and then the physical values, as 64
 * lowercase hexadecimal digits. The values are C times S binary64 numbers, little-endian,
 * channel-major (all of channel 0, then channel 1), each `digital * scale[c] + offset[c]` as two
 * separately rounded operations: JavaScript rounds each operation and does not fuse them, which is
 * what the definition requires of every language. A value that is not finite has no digest.
 */
export async function storeContentSha256(input: StoreContentInput): Promise<string> {
  const channels = Array.isArray(input.digital) ? input.digital.length : 0;
  sizeWord(channels, "the channel count", 1);
  const samples = input.digital[0]?.length;
  sizeWord(samples, "the sample count", 1);
  if (input.digital.some((row) => !row || row.length !== samples)) {
    throw new DerivativeContractError("every channel must hold the same number of samples");
  }
  if (!input.scale || input.scale.length !== channels) {
    throw new DerivativeContractError("scale must hold one number per channel");
  }
  if (!input.offset || input.offset.length !== channels) {
    throw new DerivativeContractError("offset must hold one number per channel");
  }

  const header = encoder.encode(
    storeContentHeader({
      channels,
      samples,
      rate: input.rate,
      units: input.units,
      labels: input.labels,
    }),
  );
  const bytes = new Uint8Array(header.length + channels * samples * 8);
  bytes.set(header, 0);
  const view = new DataView(bytes.buffer);
  let at = header.length;
  for (let c = 0; c < channels; c++) {
    const scale = input.scale[c];
    const offset = input.offset[c];
    const row = input.digital[c];
    if (typeof scale !== "number" || typeof offset !== "number") {
      throw new DerivativeContractError(`channel ${c} scale and offset must be numbers`);
    }
    for (let s = 0; s < samples; s++) {
      const digital = row[s];
      if (typeof digital !== "number") {
        throw new DerivativeContractError(`channel ${c} sample ${s} is not a number`);
      }
      const value = digital * scale + offset;
      if (!Number.isFinite(value)) {
        throw new DerivativeContractError(
          `channel ${c} sample ${s} is not a finite number and has no digest`,
        );
      }
      view.setFloat64(at, value, true);
      at += 8;
    }
  }
  return sha256Hex(bytes);
}

// --- Input digest ----------------------------------------------------------------------------

/**
 * One store whose group was read in full, as a row of a record's `stores_content`: the store's path,
 * the group read, and that group's store content digest (64 lowercase hexadecimal digits).
 */
export interface StoreContentRow {
  path: string;
  group: string;
  content_sha256: string;
}

const CONTENT_SHA256_RE = /^[0-9a-f]{64}$/;

/** Byte order of two UTF-8 encodings, which is code point order. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** A row's path or group: non-empty, one line, no tab (the separator), no lone surrogate. */
function rowText(text: unknown, what: string, field: string): string {
  if (typeof text !== "string" || text.length === 0) {
    throw new DerivativeContractError(`${what} must be non-empty text`, field);
  }
  if (/[\r\n\t]/.test(text)) {
    throw new DerivativeContractError(
      `${what} holds a tab, carriage return or line feed and has no digest`,
      field,
    );
  }
  refuseLoneSurrogate(text, what, field);
  return text;
}

/**
 * The input digest of a Zarr input: `sha256:` and the SHA-256 of the lines
 * `path TAB group TAB content_sha256 LF`, one per store whose group was read in full, sorted by path
 * in code point order. Code point order is the order of the paths' UTF-8 bytes, which Python's
 * `sorted` gives; JavaScript's default `sort` compares UTF-16 units and disagrees above U+FFFF, so
 * this compares bytes. The rows may arrive in any order. No rows, a repeated path, or a row whose
 * text or digest is outside its rule has no digest: the order of equal paths would not be defined,
 * and a tab in a path or group would let two different rows give one line. The refusal's `field`
 * is described at the top of this file.
 *
 * A BIDS input's digest is not computed here: it is `git:` and the 40 hexadecimal digits of the
 * source commit the dataset version names (`validateDerivativeKeyFields` checks its shape).
 *
 * Version 1: a Zarr derivative is keyed by `inputDigestV2` below, which also names the electrode
 * positions a recipe was handed. A row that is a list is read as an object with no path, so version 1
 * names the field `path` for it (the stamp rejects lists first, `no_stores_content`); version 2 names
 * `stores_content`.
 */
export async function inputDigest(rows: readonly StoreContentRow[]): Promise<string> {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DerivativeContractError("an input digest needs at least one store", "stores_content");
  }
  const lines = rows.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new DerivativeContractError(`row ${index} is not an object`, "stores_content");
    }
    const path = rowText(row.path, `row ${index} path`, "path");
    const group = rowText(row.group, `row ${index} group`, "group");
    if (typeof row.content_sha256 !== "string" || !CONTENT_SHA256_RE.test(row.content_sha256)) {
      throw new DerivativeContractError(
        `row ${index} content_sha256 must be 64 lowercase hexadecimal digits`,
        "content_sha256",
      );
    }
    return {
      path,
      pathBytes: encoder.encode(path),
      line: `${path}\t${group}\t${row.content_sha256}\n`,
    };
  });
  lines.sort((a, b) => compareBytes(a.pathBytes, b.pathBytes));
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].path === lines[i - 1].path) {
      throw new DerivativeContractError(`the path ${lines[i].path} appears in two rows`, "path");
    }
  }
  const text = lines.map((entry) => entry.line).join("");
  return `sha256:${await sha256Hex(encodeText(text))}`;
}

// --- Store locations digest (version 2 of the input digest names it) -------------------------

export interface StoreLocationsInput {
  /** The read group's channel labels in stored order, as `storeContentHeader` takes them. */
  labels: readonly ChannelText[];
  /** The store root's attribute object; three of its keys are read, see `storeLocationsText`. */
  attributes: unknown;
}

/** Whether a value is an object a JSON reader makes: not null, not a list, not a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An own property of an object, with null as absent; an inherited name is never read. */
function ownAttribute(attributes: Record<string, unknown>, key: string): unknown {
  const value = Object.hasOwn(attributes, key) ? attributes[key] : undefined;
  return value === null ? undefined : value;
}

/** A system or units value as text: a string as it is, anything else the empty string. */
function statedText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The three coordinates of a position entry: an array of exactly three numbers, each finite and none
 * a boolean (a number is `typeof` number; Python's `True` is an `int` and is excluded there too), or
 * nothing. A number that is not finite as a binary64 has no position: a NaN, an infinity, and an
 * integer literal so large that `JSON.parse` reads Infinity (Python's `float()` raises
 * `OverflowError` on it, which the Python side catches for the same answer).
 */
function coordinatesOf(entry: unknown): [number, number, number] | undefined {
  if (!Array.isArray(entry) || entry.length !== 3) return undefined;
  for (let i = 0; i < 3; i++) {
    const value: unknown = entry[i];
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  }
  return entry as [number, number, number];
}

/**
 * The 16 lowercase hexadecimal digits of a coordinate as an IEEE-754 binary64, big-endian, as
 * `rateHex` writes a rate. A zero is written as positive zero whatever its sign, because Python
 * reads the JSON number `-0` as the integer 0 and `-0.0` as negative zero, where `JSON.parse` reads
 * both as negative zero: without the rule one store would have two digests.
 */
function coordinateHex(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value === 0 ? 0 : value, false);
  return hex(new Uint8Array(view.buffer));
}

/**
 * The text of a store locations digest, `nemar.store-locations.v1`: what a reader handed eegprep for
 * one read group, as the store states it (before any unit change, axis change or recentering). The
 * lines, each ending in a line feed:
 * the format name; `system` and, after a space, the coordinate system text; `units` and the unit
 * text; one `position` line per channel in stored order, with after it a space and the 16
 * hexadecimal digits of each of x, y and z (see `coordinateHex`), or `position` alone.
 *
 * Reads exactly three keys of `attributes`, through own-property reads, and a key that is absent or
 * null is absent: `electrode_positions` (an object of label to `[x, y, z]`), `electrode_coordinate_system`
 * and `electrode_coordinate_units`. The system and units lines carry text only when positions are
 * present and the text is a non-empty string; a value that is not a string is the empty string. A
 * channel gets coordinates only when EVERY channel of the group has a non-empty label (the all-or-none
 * rule of the store content digest, so an unlabeled group joins nothing), positions are present, they
 * hold an OWN entry under exactly that label (no case fold, no trimming, no normalization, no
 * inherited name such as `constructor`), and that entry is three finite numbers (`coordinatesOf`).
 * Labels are not written: the store content digest of the same group fixes them and their order.
 *
 * Not hashed: `electrode_positions_source`, `electrode_positions_file`, `electrode_coordsystem_file`
 * (the converter's provenance), any other root attribute, and an entry under a label the group does
 * not have. They do not change what eegprep receives, so a recipe that branches on one must first
 * change this definition.
 *
 * Refused (`DerivativeContractError`, no field): `labels` not a list of at least one entry, or an
 * entry that is not text, null or undefined; `attributes` not a plain object; positions present and
 * not a plain object; a system or units text that enters the text and holds a carriage return, a
 * line feed or a lone surrogate. Text that is dropped is never examined.
 */
export function storeLocationsText(input: StoreLocationsInput): string {
  const labels = input?.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new DerivativeContractError("labels must be a list of at least one entry");
  }
  for (let i = 0; i < labels.length; i++) {
    const label: unknown = labels[i];
    if (label !== null && label !== undefined && typeof label !== "string") {
      throw new DerivativeContractError("labels holds an entry that is not text");
    }
  }
  const attributes = input.attributes;
  if (!isPlainObject(attributes)) {
    throw new DerivativeContractError("attributes must be an object");
  }
  const stated = ownAttribute(attributes, "electrode_positions");
  if (stated !== undefined && !isPlainObject(stated)) {
    throw new DerivativeContractError("electrode_positions must be an object");
  }
  const positions = stated as Record<string, unknown> | undefined;
  const system = statedText(ownAttribute(attributes, "electrode_coordinate_system"));
  const units = statedText(ownAttribute(attributes, "electrode_coordinate_units"));

  const lines = [
    STORE_LOCATIONS_FORMAT,
    positions !== undefined && system !== ""
      ? `system ${headerText(system, "the coordinate system")}`
      : "system",
    positions !== undefined && units !== ""
      ? `units ${headerText(units, "the coordinate units")}`
      : "units",
  ];
  const named = allNonEmpty(labels);
  for (let c = 0; c < labels.length; c++) {
    const label = labels[c] as string;
    const entry =
      positions !== undefined && named && Object.hasOwn(positions, label)
        ? positions[label]
        : undefined;
    const found = coordinatesOf(entry);
    lines.push(
      found
        ? `position ${coordinateHex(found[0])} ${coordinateHex(found[1])} ${coordinateHex(found[2])}`
        : "position",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The store locations digest: SHA-256 of `storeLocationsText` as 64 lowercase hexadecimal digits.
 * A store that states no position still has one (the text of a group with every `position` alone),
 * which is not `none`: `none` is for a store the recipe handed eegprep no positions from by design.
 */
export async function storeLocationsSha256(input: StoreLocationsInput): Promise<string> {
  return sha256Hex(encodeText(storeLocationsText(input)));
}

// --- Input digest, version 2 -----------------------------------------------------------------

/**
 * One store whose group was read in full, as a row of a record's `stores_content`: a
 * `StoreContentRow` and the store's locations digest, 64 lowercase hexadecimal digits, or exactly
 * `none` (`LOCATIONS_NONE`).
 */
export interface StoreRowV2 extends StoreContentRow {
  locations: string;
}

/**
 * The text a version 2 input digest hashes: `nemar.input-digest.v2` and a line feed, then one line
 * `path TAB group TAB content_sha256 TAB locations LF` per row, sorted by path in code point order
 * as in version 1 (`compareBytes`). `locations` is a store locations digest or exactly `none`: the
 * recipe by design handed eegprep no positions from that store, never "the store had none". The
 * header line means a version 1 text and a version 2 text are never the same bytes.
 *
 * Every refusal of `inputDigest` holds, with the same `field`, except that a row that is a list is
 * not an object here and is refused with the field `stores_content` (version 1 reads a list as an
 * object with no path and names `path`). A `locations` that is missing, not text, or neither shape
 * is refused with the field `locations` (checked after the other fields of its row). The rows may
 * arrive in any order.
 */
export function inputDigestV2Text(rows: readonly StoreRowV2[]): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DerivativeContractError("an input digest needs at least one store", "stores_content");
  }
  const lines = rows.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new DerivativeContractError(`row ${index} is not an object`, "stores_content");
    }
    const path = rowText(row.path, `row ${index} path`, "path");
    const group = rowText(row.group, `row ${index} group`, "group");
    if (typeof row.content_sha256 !== "string" || !CONTENT_SHA256_RE.test(row.content_sha256)) {
      throw new DerivativeContractError(
        `row ${index} content_sha256 must be 64 lowercase hexadecimal digits`,
        "content_sha256",
      );
    }
    if (
      typeof row.locations !== "string" ||
      (row.locations !== LOCATIONS_NONE && !CONTENT_SHA256_RE.test(row.locations))
    ) {
      throw new DerivativeContractError(
        `row ${index} locations must be none or 64 lowercase hexadecimal digits`,
        "locations",
      );
    }
    return {
      path,
      pathBytes: encoder.encode(path),
      line: `${path}\t${group}\t${row.content_sha256}\t${row.locations}\n`,
    };
  });
  lines.sort((a, b) => compareBytes(a.pathBytes, b.pathBytes));
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].path === lines[i - 1].path) {
      throw new DerivativeContractError(`the path ${lines[i].path} appears in two rows`, "path");
    }
  }
  return `${INPUT_DIGEST_V2_FORMAT}\n${lines.map((entry) => entry.line).join("")}`;
}

/**
 * The input digest of a Zarr input, version 2: `sha256:` and the SHA-256 of `inputDigestV2Text`. A
 * Zarr derivative is keyed by this and by no other input digest.
 */
export async function inputDigestV2(rows: readonly StoreRowV2[]): Promise<string> {
  return `sha256:${await sha256Hex(encodeText(inputDigestV2Text(rows)))}`;
}

// --- Derivative key --------------------------------------------------------------------------

/** The eight fields of a derivative key, in the order their lines appear. */
export const DERIVATIVE_KEY_FIELDS = Object.freeze([
  "dataset",
  "version",
  "recipe",
  "recipe_version",
  "engine",
  "input",
  "profile",
  "input_digest",
] as const);

export type DerivativeKeyField = (typeof DERIVATIVE_KEY_FIELDS)[number];

export type DerivativeKeyFields = Record<DerivativeKeyField, string>;

/** Each field's rule, anchored on the whole value. `input`, `profile` and `input_digest` pair up below. */
const KEY_FIELD_RULES: Readonly<Record<string, RegExp>> = Object.freeze({
  dataset: /^[a-z]{2}[0-9]{6}$/,
  version: /^[0-9A-Za-z._+-]{1,64}$/,
  recipe: /^[a-z0-9-]{1,64}$/,
  recipe_version: /^[0-9A-Za-z._+-]{1,64}$/,
  engine: /^[0-9A-Za-z._+@-]{1,64}$/,
});

/** The two inputs a derivative can be made from, each with its one profile and digest shape. */
const KEY_INPUTS: Readonly<Record<string, { profile: string; digest: RegExp }>> = Object.freeze({
  zarr: { profile: "serving", digest: /^sha256:[0-9a-f]{64}$/ },
  bids: { profile: "archive", digest: /^git:[0-9a-f]{40}$/ },
});

export type DerivativeKeyFieldsCheck =
  | { ok: true; fields: DerivativeKeyFields }
  | { ok: false; field: string; reason: string };

/**
 * Whether the eight key fields are inside their rules, and the validated copy when they are.
 * dataset `^[a-z]{2}[0-9]{6}$`; version and recipe_version `^[0-9A-Za-z._+-]{1,64}$`; recipe
 * `^[a-z0-9-]{1,64}$`; engine `^[0-9A-Za-z._+@-]{1,64}$`; input `zarr` with profile `serving` and a
 * `sha256:` digest, or input `bids` with profile `archive` and a `git:` digest. Any other value or
 * pairing is refused, and the refusal names the first field that fails.
 */
export function validateDerivativeKeyFields(fields: unknown): DerivativeKeyFieldsCheck {
  if (typeof fields !== "object" || fields === null) {
    return { ok: false, field: "fields", reason: "the key fields must be an object" };
  }
  const given = fields as Record<string, unknown>;
  for (const name of DERIVATIVE_KEY_FIELDS) {
    if (typeof given[name] !== "string") {
      return { ok: false, field: name, reason: `${name} must be text` };
    }
  }
  for (const [name, rule] of Object.entries(KEY_FIELD_RULES)) {
    if (!rule.test(given[name] as string)) {
      return { ok: false, field: name, reason: `${name} is outside its rule` };
    }
  }
  const input = Object.hasOwn(KEY_INPUTS, given.input as string)
    ? KEY_INPUTS[given.input as string]
    : undefined;
  if (!input) {
    return { ok: false, field: "input", reason: "input must be zarr or bids" };
  }
  if (given.profile !== input.profile) {
    return {
      ok: false,
      field: "profile",
      reason: `input ${given.input} takes the profile ${input.profile}`,
    };
  }
  if (!input.digest.test(given.input_digest as string)) {
    return {
      ok: false,
      field: "input_digest",
      reason: `input ${given.input} takes a digest of the shape ${input.digest.source}`,
    };
  }
  const checked = {} as DerivativeKeyFields;
  for (const name of DERIVATIVE_KEY_FIELDS) checked[name] = given[name] as string;
  return { ok: true, fields: checked };
}

/**
 * The text a derivative key hashes: `nemar.derivative-key.v1`, then the eight fields each as
 * `name SPACE value LF`, in order. The image digest is recorded with a derivative and is never part
 * of its key. A field outside its rule throws `DerivativeContractError`.
 */
export function derivativeKeyText(fields: DerivativeKeyFields): string {
  const checked = validateDerivativeKeyFields(fields);
  if (!checked.ok) throw new DerivativeContractError(checked.reason, checked.field);
  const lines = [DERIVATIVE_KEY_FORMAT];
  for (const name of DERIVATIVE_KEY_FIELDS) lines.push(`${name} ${checked.fields[name]}`);
  return `${lines.join("\n")}\n`;
}

/** The derivative key: SHA-256 of `derivativeKeyText`, 64 lowercase hexadecimal digits. */
export async function derivativeKey(fields: DerivativeKeyFields): Promise<string> {
  return sha256Hex(encodeText(derivativeKeyText(fields)));
}
