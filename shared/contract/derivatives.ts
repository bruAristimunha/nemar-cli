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
 * `nemarOrg/nemar-process`; a change to either side that moves a vector is a change to the ADR.
 *
 * WHAT A DIGEST CAN AND CANNOT SAY. Until the converter writes each store's content digest at commit,
 * the recipe computes it from what it read and records it; the platform records it and cannot verify
 * it (ADR 0123 decision 7). `storeContentSha256` hashes the whole group in one `crypto.subtle` call,
 * so it is for vectors and for groups that fit in memory; a real recording is hashed by the recipe,
 * which streams. This module owns the definition, not the production of a digest at scale.
 *
 * REFUSAL, NEVER A GUESS. Text the definition cannot carry unambiguously (a line feed or carriage
 * return in a label or unit, a lone surrogate in any text, a value outside a key field's rule) has no
 * digest: the function throws `DerivativeContractError`, or for the key fields the validator names
 * the field. A caller that meets one records "unkeyable" and moves on.
 */

/** The first line of a store content header, and the name of the digest. */
export const STORE_CONTENT_FORMAT = "nemar.store-content.v1";

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
 * once. The serving copy is capped at 250 Hz and 16-bit; the archived recordings' rate is never
 * stated.
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
function refuseLoneSurrogate(text: string, what: string): void {
  if (hasLoneSurrogate(text)) {
    throw new DerivativeContractError(`${what} holds a lone surrogate and has no digest`);
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
function rowText(text: unknown, what: string): string {
  if (typeof text !== "string" || text.length === 0) {
    throw new DerivativeContractError(`${what} must be non-empty text`);
  }
  if (/[\r\n\t]/.test(text)) {
    throw new DerivativeContractError(
      `${what} holds a tab, carriage return or line feed and has no digest`,
    );
  }
  refuseLoneSurrogate(text, what);
  return text;
}

/**
 * The input digest of a Zarr input: `sha256:` and the SHA-256 of the lines
 * `path TAB group TAB content_sha256 LF`, one per store whose group was read in full, sorted by path
 * in code point order. Code point order is the order of the paths' UTF-8 bytes, which Python's
 * `sorted` gives; JavaScript's default `sort` compares UTF-16 units and disagrees above U+FFFF, so
 * this compares bytes. The rows may arrive in any order. No rows, a repeated path, or a row whose
 * text or digest is outside its rule has no digest: the order of equal paths would not be defined.
 *
 * A BIDS input's digest is not computed here: it is `git:` and the 40 hexadecimal digits of the
 * source commit the dataset version names (`validateDerivativeKeyFields` checks its shape).
 */
export async function inputDigest(rows: readonly StoreContentRow[]): Promise<string> {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DerivativeContractError("an input digest needs at least one store");
  }
  const lines = rows.map((row, index) => {
    const path = rowText(row?.path, `row ${index} path`);
    const group = rowText(row?.group, `row ${index} group`);
    if (typeof row.content_sha256 !== "string" || !CONTENT_SHA256_RE.test(row.content_sha256)) {
      throw new DerivativeContractError(
        `row ${index} content_sha256 must be 64 lowercase hexadecimal digits`,
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
      throw new DerivativeContractError(`the path ${lines[i].path} appears in two rows`);
    }
  }
  const text = lines.map((entry) => entry.line).join("");
  return `sha256:${await sha256Hex(encodeText(text))}`;
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
