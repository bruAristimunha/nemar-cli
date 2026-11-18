/**
 * The derivative store's shared contract (portable compute, ADR 0123): the store content digest, the
 * input digest and the derivative key, held to the vectors in
 * `shared/contract/derivatives-vectors.json`. The vectors are byte-exact and language-neutral: the
 * recipes in `nemarOrg/nemar-process` reproduce the same ones in Python, so a drift on either side
 * fails here or there. Never change a vector to make code pass: the maintainer decides whether the
 * vector or the code is wrong.
 *
 * Real code, no mocks: the module is pure, so every test calls it.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vectors from "../shared/contract/derivatives-vectors.json";
import {
  CANARY_DAYS,
  type ChannelText,
  DERIVATIVE_KEY_FIELDS,
  DerivativeContractError,
  type DerivativeKeyFields,
  INPUT_DIGEST_V2_FORMAT,
  LOCATIONS_NONE,
  RETENTION_CLASSES,
  SERVING_PROFILE_SENTENCE,
  STORE_CONTENT_FORMAT,
  STORE_LOCATIONS_FORMAT,
  SUPERSEDED_GRACE_DAYS,
  type StoreContentRow,
  type StoreRowV2,
  derivativeKey,
  derivativeKeyText,
  inputDigest,
  inputDigestV2,
  inputDigestV2Text,
  storeContentHeader,
  storeContentSha256,
  storeLocationsSha256,
  storeLocationsText,
  validateDerivativeKeyFields,
} from "../shared/contract/derivatives.js";

// Built from code points, never typed: a formatter or editor may fold look-alike characters
// (and Biome rewrites `\u` escapes into the characters themselves).
const UNIT_MICRO_SIGN = `${String.fromCodePoint(0x00b5)}V`; // U+00B5
const UNIT_GREEK_MU = `${String.fromCodePoint(0x03bc)}V`; // U+03BC
const E_PRECOMPOSED = String.fromCodePoint(0x00e9);
const E_DECOMPOSED = `e${String.fromCodePoint(0x0301)}`;
const HALFWIDTH_FULL_STOP = String.fromCodePoint(0xff61);
const GRINNING_FACE = String.fromCodePoint(0x1f600);

/** A store content vector as the file states it; the optional keys belong to one entry each. */
interface StoreVector {
  name: string;
  note?: string;
  digital: number[][];
  scale: number[];
  offset: number[];
  rate: number;
  units: ChannelText[];
  labels: ChannelText[];
  header: string;
  sha256: string;
  also_equal_to?: string;
  also_with?: Array<{ units: ChannelText[]; labels: ChannelText[] }>;
  fused_sha256?: string;
}

const STORE_VECTORS: StoreVector[] = vectors.store_content;

/** The store content vector named `name`, as the inputs of `storeContentSha256`. */
function storeVector(name: string): StoreVector {
  const vector = STORE_VECTORS.find((entry) => entry.name === name);
  if (!vector) throw new Error(`no store content vector named ${name}`);
  return vector;
}

/** `storeContentSha256` of a vector's values with other units and labels. */
function digestWith(units: ChannelText[], labels: ChannelText[]): Promise<string> {
  const base = storeVector("labeled with a unit");
  return storeContentSha256({
    digital: base.digital,
    scale: base.scale,
    offset: base.offset,
    rate: base.rate,
    units,
    labels,
  });
}

/** The vectors' key fields, which the refusal tests change one at a time. */
const KEY_FIELDS: DerivativeKeyFields = vectors.derivative_key[0].fields;

async function rejects(promise: Promise<unknown>): Promise<DerivativeContractError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DerivativeContractError);
    return error as DerivativeContractError;
  }
  throw new Error("expected a DerivativeContractError and none was thrown");
}

function refused(call: () => unknown): DerivativeContractError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(DerivativeContractError);
    return error as DerivativeContractError;
  }
  throw new Error("expected a DerivativeContractError and none was thrown");
}

/** A store locations vector as the file states it (read with `JSON.parse`, see `FILE`). */
interface LocationsVector {
  name: string;
  note?: string;
  labels: ChannelText[];
  attributes: unknown;
  text: string;
  sha256: string;
  also_equal_to?: string;
  also_with?: Array<{ labels?: ChannelText[]; attributes?: unknown }>;
}

interface DigestV2Vector {
  name: string;
  note?: string;
  rows: StoreRowV2[];
  text: string;
  digest: string;
}

interface VectorFile {
  store_locations: LocationsVector[];
  input_digest_v2: DigestV2Vector[];
  refused: {
    store_locations: Array<{ name: string; labels: ChannelText[]; attributes: unknown }>;
    input_digest_v2: Array<{ name: string; field: string; rows: unknown }>;
  };
}

const VECTORS_PATH = join(import.meta.dir, "../shared/contract/derivatives-vectors.json");

/**
 * The vectors file read as text and parsed with `JSON.parse`, which the version 2 vectors need:
 * `__proto__` is an own key in the vector named `inherited names`, and the integer of `an integer too
 * large for binary64` has 400 digits. Loaders disagree on such input, so the new tests never use the
 * module-style import above.
 */
const FILE = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorFile;

const LOCATIONS_VECTORS = FILE.store_locations;

const DIGEST_V2_VECTORS = FILE.input_digest_v2;

/** The store locations vector named `name`. */
function locationsVector(name: string): LocationsVector {
  const vector = LOCATIONS_VECTORS.find((entry) => entry.name === name);
  if (!vector) throw new Error(`no store locations vector named ${name}`);
  return vector;
}

/** SHA-256 of text as 64 lowercase hexadecimal digits, from `node:crypto` and not the module. */
function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("the vector file", () => {
  test("holds the eight vectors, so a pass cannot be vacuous", () => {
    expect(STORE_VECTORS.map((v) => v.name)).toEqual([
      "labeled with a unit",
      "no unit and no labels",
      "partly labeled",
      "two roundings, never fused",
    ]);
    expect(vectors.input_digest.map((v) => v.name)).toEqual(["one store", "code point order"]);
    expect(vectors.derivative_key.map((v) => v.name)).toEqual(["zarr serving", "bids archive"]);
    expect(Object.keys(vectors.refused)).toEqual([
      "store_content",
      "input_digest",
      "store_locations",
      "input_digest_v2",
      "derivative_key",
    ]);
  });

  test("holds the version 2 vectors, so a pass cannot be vacuous", () => {
    expect(LOCATIONS_VECTORS.map((v) => v.name)).toEqual([
      "declared",
      "no positions attribute",
      "positions null",
      "unlabeled group",
      "zeros and integers",
      "zeros and integers as floats",
      "entries with no position",
      "an integer too large for binary64",
      "non-finite coordinates",
      "inherited names",
      "exact labels only",
      "system without units",
      "provenance is not hashed",
    ]);
    expect(DIGEST_V2_VECTORS.map((v) => v.name)).toEqual([
      "one store",
      "none",
      "code point order",
      "a store with positions beside one without",
    ]);
    expect(FILE.refused.store_locations.map((v) => v.name)).toEqual([
      "positions an array",
      "positions a string",
      "a system holding a line feed",
      "units holding a carriage return",
      "a system holding a lone surrogate",
      "attributes an array",
      "no labels",
      "a label that is not text",
    ]);
    expect(FILE.refused.input_digest_v2.map((v) => v.name)).toEqual([
      "locations NONE",
      "locations of 63 hexadecimal digits",
      "locations missing",
      "a row that is a list",
    ]);
  });
});

describe("store content digest (vectors 1 to 3 and the two roundings)", () => {
  for (const vector of STORE_VECTORS) {
    test(`${vector.name}: header text and digest`, async () => {
      const input = {
        digital: vector.digital,
        scale: vector.scale,
        offset: vector.offset,
        rate: vector.rate,
        units: vector.units,
        labels: vector.labels,
      };
      expect(
        storeContentHeader({
          channels: vector.digital.length,
          samples: vector.digital[0].length,
          rate: vector.rate,
          units: vector.units,
          labels: vector.labels,
        }),
      ).toBe(vector.header);
      expect(await storeContentSha256(input)).toBe(vector.sha256);
    });
  }

  test("the header opens with the format name and ends in a line feed", () => {
    for (const vector of STORE_VECTORS) {
      expect(vector.header.startsWith(`${STORE_CONTENT_FORMAT}\n`)).toBe(true);
      expect(vector.header.endsWith("data float64-le\n")).toBe(true);
    }
  });

  test("the rate is written as a big-endian binary64: 250.0 is 406f400000000000", () => {
    const header = storeContentHeader({
      channels: 1,
      samples: 1,
      rate: 250,
      units: [null],
      labels: [null],
    });
    expect(header).toContain("\nrate 406f400000000000\n");
    expect(
      storeContentHeader({ channels: 1, samples: 1, rate: -0, units: [null], labels: [null] }),
    ).toContain("\nrate 8000000000000000\n");
  });

  test("typed arrays give the same digest as plain lists", async () => {
    const vector = storeVector("labeled with a unit");
    const digest = await storeContentSha256({
      digital: vector.digital.map((row) => Int16Array.from(row)),
      scale: Float64Array.from(vector.scale),
      offset: Float64Array.from(vector.offset),
      rate: vector.rate,
      units: vector.units,
      labels: vector.labels,
    });
    expect(digest).toBe(vector.sha256);
  });

  test("the two roundings vector tells a fused multiply-add from two separate roundings", () => {
    // The first three vectors have exact products, so they cannot tell the two apart; this one can.
    // Computed with Python (struct, hashlib; math.fma for the fused value).
    const vector = storeVector("two roundings, never fused");
    expect(vector.sha256).toBe("2aa312ed5d306f1f4e3331f7eff09a23972ae2b8bf8792732a79c6e156c3cb0b");
    expect(vector.fused_sha256).toBe(
      "ebb90d19f4a23ee757676711f168ad69e2564e98267005d526941eb49dffc536",
    );
    expect(vector.fused_sha256).not.toBe(vector.sha256);
  });

  test("values are channel-major: swapping the channels changes the digest", async () => {
    const vector = storeVector("no unit and no labels");
    const swapped = await storeContentSha256({
      digital: [vector.digital[1], vector.digital[0]],
      scale: [vector.scale[1], vector.scale[0]],
      offset: [vector.offset[1], vector.offset[0]],
      rate: vector.rate,
      units: vector.units,
      labels: vector.labels,
    });
    expect(swapped).not.toBe(vector.sha256);
  });

  test("the rate is part of the digest", async () => {
    const vector = storeVector("no unit and no labels");
    const other = await storeContentSha256({
      digital: vector.digital,
      scale: vector.scale,
      offset: vector.offset,
      rate: 500,
      units: vector.units,
      labels: vector.labels,
    });
    expect(other).not.toBe(vector.sha256);
  });
});

describe("labels are all or none, the unit is shared or none (vector 3)", () => {
  test("partly labeled: every label line is bare, never `label Fz` beside `label`", () => {
    const vector = storeVector("partly labeled");
    expect(vector.header).toContain(`\nunit ${UNIT_MICRO_SIGN}\nlabel\nlabel\ndata float64-le\n`);
    expect(vector.header).not.toContain("label Fz");
  });

  test("the cases that carry no text give the digest of the vector with none", async () => {
    const plain = storeVector("no unit and no labels").sha256;
    const partly = storeVector("partly labeled");
    expect(partly.also_equal_to).toBe("no unit and no labels");
    expect(partly.also_with?.length).toBe(2);
    for (const variant of partly.also_with ?? []) {
      expect(await digestWith(variant.units, variant.labels)).toBe(plain);
    }
  });

  test("an empty unit is no unit: the line is `unit` alone, never `unit` and a space", () => {
    const header = storeContentHeader({
      channels: 2,
      samples: 3,
      rate: 250,
      units: ["", ""],
      labels: [null, null],
    });
    expect(header).toContain("\nunit\nlabel\n");
    expect(header).not.toContain("unit \n");
  });

  test("absent and empty text are the same: null, undefined and an empty string", async () => {
    const plain = storeVector("no unit and no labels").sha256;
    expect(await digestWith([undefined, undefined], [undefined, null])).toBe(plain);
    expect(await digestWith(["", null], ["", undefined])).toBe(plain);
  });

  test("a unit stated by one channel only is no unit", async () => {
    const plain = storeVector("no unit and no labels").sha256;
    expect(await digestWith([UNIT_MICRO_SIGN, null], [null, null])).toBe(plain);
    expect(await digestWith([null, UNIT_MICRO_SIGN], [null, null])).toBe(plain);
  });

  test("labels given for every channel are carried, in stored order", () => {
    const header = storeContentHeader({
      channels: 3,
      samples: 1,
      rate: 250,
      units: [null, null, null],
      labels: ["Cz", "Fz", "Pz"],
    });
    expect(header).toContain("\nlabel Cz\nlabel Fz\nlabel Pz\n");
  });

  test("a hole in a sparse list is absent text, not skipped", () => {
    const sparse = new Array<ChannelText>(2);
    const header = storeContentHeader({
      channels: 2,
      samples: 1,
      rate: 250,
      units: sparse,
      labels: sparse,
    });
    expect(header).toContain("\nunit\nlabel\nlabel\n");
  });
});

describe("text is hashed exactly as given", () => {
  test("U+00B5 and U+03BC are different units with different digests", async () => {
    const micro = await digestWith([UNIT_MICRO_SIGN, UNIT_MICRO_SIGN], ["Fz", "Cz"]);
    const mu = await digestWith([UNIT_GREEK_MU, UNIT_GREEK_MU], ["Fz", "Cz"]);
    expect(micro).toBe(storeVector("labeled with a unit").sha256);
    expect(mu).not.toBe(micro);
  });

  test("no Unicode normalization: a precomposed and a decomposed label differ", async () => {
    const precomposed = await digestWith([null, null], [E_PRECOMPOSED, "Cz"]);
    const decomposed = await digestWith([null, null], [E_DECOMPOSED, "Cz"]);
    expect(decomposed).not.toBe(precomposed);
  });

  test("no trimming: a label or unit with a space is not the one without", async () => {
    const bare = await digestWith([UNIT_MICRO_SIGN, UNIT_MICRO_SIGN], ["Fz", "Cz"]);
    expect(await digestWith([UNIT_MICRO_SIGN, UNIT_MICRO_SIGN], [" Fz", "Cz"])).not.toBe(bare);
    expect(await digestWith([` ${UNIT_MICRO_SIGN}`, ` ${UNIT_MICRO_SIGN}`], ["Fz", "Cz"])).not.toBe(
      bare,
    );
    // A unit of one space is text, not the absence of one.
    const spaced = storeContentHeader({
      channels: 1,
      samples: 1,
      rate: 250,
      units: [" "],
      labels: [null],
    });
    expect(spaced).toContain("\nunit  \n");
  });

  test("a label that is a valid surrogate pair is accepted", async () => {
    expect(await digestWith([null, null], [GRINNING_FACE, "Cz"])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("text with no digest is refused, never guessed", () => {
  test("a label holding a line feed or carriage return that enters the header is refused", async () => {
    for (const bad of ["Fz\nCz", "Fz\rCz", "\n", "\r\n"]) {
      const error = await rejects(digestWith([null, null], [bad, "Cz"]));
      expect(error.message).toContain("a label");
      expect(error.message).toContain("line feed");
    }
  });

  test("the same label beside an absent one is never examined", async () => {
    const plain = storeVector("no unit and no labels").sha256;
    expect(await digestWith([null, null], ["Fz\nCz", null])).toBe(plain);
    expect(await digestWith([null, null], ["Fz\nCz", ""])).toBe(plain);
    expect(await digestWith([null, null], ["Fz\rCz", undefined])).toBe(plain);
  });

  test("a unit holding a line feed is refused when shared, never examined when dropped", async () => {
    const plain = storeVector("no unit and no labels").sha256;
    const shared = await rejects(digestWith(["a\nb", "a\nb"], [null, null]));
    expect(shared.message).toContain("the unit");
    expect(await digestWith(["a\nb", "c"], [null, null])).toBe(plain);
    expect(await digestWith(["a\nb", null], [null, null])).toBe(plain);
  });

  test("a lone surrogate that enters the header is refused, in either half, anywhere", async () => {
    for (const bad of ["\ud800", "\udc00", "Fz\ud800", "\ud800Fz", "a\udc00b", "\ud83d"]) {
      const label = await rejects(digestWith([null, null], [bad, "Cz"]));
      expect(label.message).toContain("lone surrogate");
      const unit = await rejects(digestWith([bad, bad], [null, null]));
      expect(unit.message).toContain("lone surrogate");
    }
  });

  test("a high surrogate followed by a code unit that is not a low surrogate is lone", async () => {
    // U+E000 and U+FFFF sit just above the low surrogate range: a pair needs 0xDC00 to 0xDFFF.
    for (const next of [0xe000, 0xffff, 0xdbff, 0x0041]) {
      const bad = `Fz\ud800${String.fromCodePoint(next)}`;
      const label = await rejects(digestWith([null, null], [bad, "Cz"]));
      expect(label.message).toContain("lone surrogate");
    }
    // The last low surrogate completes a pair, so this label is accepted.
    expect(await digestWith([null, null], [`\ud800${String.fromCharCode(0xdfff)}`, "Cz"])).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test("a lone surrogate the two rules drop is never examined", async () => {
    const plain = storeVector("no unit and no labels").sha256;
    expect(await digestWith([null, null], ["\ud800", null])).toBe(plain);
    expect(await digestWith(["\ud800", "mV"], [null, null])).toBe(plain);
  });

  test("a list that is not one entry per channel, or an entry that is not text, is refused", async () => {
    await rejects(digestWith([UNIT_MICRO_SIGN], ["Fz", "Cz"]));
    await rejects(digestWith([UNIT_MICRO_SIGN, UNIT_MICRO_SIGN], ["Fz"]));
    await rejects(digestWith([UNIT_MICRO_SIGN, UNIT_MICRO_SIGN], ["Fz", "Cz", "Pz"]));
    await rejects(digestWith([1 as unknown as string, null], [null, null]));
    await rejects(digestWith(null as unknown as string[], [null, null]));
    await rejects(digestWith([null, null], undefined as unknown as string[]));
    expect(() =>
      storeContentHeader({ channels: 2, samples: 1, rate: 250, units: [], labels: [] }),
    ).toThrow(DerivativeContractError);
  });

  test("a value, rate or shape that has no digest is refused", async () => {
    const vector = storeVector("no unit and no labels");
    const base = {
      digital: vector.digital,
      scale: vector.scale,
      offset: vector.offset,
      rate: vector.rate,
      units: vector.units,
      labels: vector.labels,
    };
    await rejects(storeContentSha256({ ...base, rate: Number.NaN }));
    await rejects(storeContentSha256({ ...base, rate: Number.POSITIVE_INFINITY }));
    await rejects(storeContentSha256({ ...base, scale: [Number.NaN, 0.25] }));
    await rejects(storeContentSha256({ ...base, offset: [0, Number.POSITIVE_INFINITY] }));
    // Finite scale and digital whose product overflows.
    await rejects(
      storeContentSha256({
        ...base,
        scale: [1e308, 0.25],
        digital: [
          [1e10, 1, 1],
          [1, 1, 1],
        ],
      }),
    );
    await rejects(
      storeContentSha256({
        ...base,
        digital: [
          [1, 2],
          [1, 2, 3],
        ],
      }),
    );
    // One scale and one offset per channel: too short, too long, and absent, for each list.
    // The message is checked too: a short list would otherwise be caught later, by its missing number.
    for (const wrong of [[0.1], [0.1, 0.25, 0.5], [], undefined]) {
      const error = await rejects(storeContentSha256({ ...base, scale: wrong as number[] }));
      expect(error.message).toBe("scale must hold one number per channel");
    }
    for (const wrong of [[0], [0, 0, 0], [], undefined]) {
      const error = await rejects(storeContentSha256({ ...base, offset: wrong as number[] }));
      expect(error.message).toBe("offset must hold one number per channel");
    }
    await rejects(storeContentSha256({ ...base, digital: [] }));
    await rejects(storeContentSha256({ ...base, digital: [[], []] }));
    await rejects(
      storeContentSha256({
        ...base,
        digital: [
          ["1" as unknown as number, 2, 3],
          [1, 2, 3],
        ],
      }),
    );
  });
});

describe("input digest (vectors 4 and 5)", () => {
  for (const vector of vectors.input_digest) {
    // The rows are given in either order: a digest that depended on the arrival order is wrong.
    test(`${vector.name}, given in either order`, async () => {
      expect(await inputDigest(vector.rows)).toBe(vector.digest);
      expect(await inputDigest([...vector.rows].reverse())).toBe(vector.digest);
    });
  }

  test("the code point vector separates code point order from UTF-16 order", () => {
    // If JavaScript's default sort gave code point order this vector would prove nothing.
    // The file stores U+1F600 first, so one pass catches a missing sort and a UTF-16 sort alike.
    const [high, low] = vectors.input_digest[1].rows.map((row) => row.path);
    expect(low).toBe(`sub-01/${HALFWIDTH_FULL_STOP}`);
    expect(high).toBe(`sub-01/${GRINNING_FACE}`);
    expect([low, high].sort()[0]).toBe(high);
    expect(new TextEncoder().encode(low)[7]).toBeLessThan(new TextEncoder().encode(high)[7]);
  });

  test("a different group, path or digest is a different input digest", async () => {
    const row = vectors.input_digest[0].rows[0];
    const base = await inputDigest([row]);
    expect(await inputDigest([{ ...row, group: "meg" }])).not.toBe(base);
    expect(await inputDigest([{ ...row, path: "sub-02/eeg/sub-02_task-rest_eeg.edf" }])).not.toBe(
      base,
    );
    expect(await inputDigest([{ ...row, content_sha256: "0".repeat(64) }])).not.toBe(base);
  });

  test("more than one store: every row counts and the line feed ends each", async () => {
    const [a, b] = [
      { path: "b/eeg.edf", group: "eeg", content_sha256: "a".repeat(64) },
      { path: "a/eeg.edf", group: "eeg", content_sha256: "b".repeat(64) },
    ];
    const both = await inputDigest([a, b]);
    expect(both).toBe(await inputDigest([b, a]));
    expect(both).not.toBe(await inputDigest([a]));
    expect(both).not.toBe(await inputDigest([b]));
  });

  test("a path that is a byte prefix of another sorts first, whatever order the rows come in", async () => {
    // Computed with Python: the lines `a`, then `a/b`; the other order would give 83675576...
    const short = { path: "a", group: "eeg", content_sha256: "a".repeat(64) };
    const long = { path: "a/b", group: "eeg", content_sha256: "b".repeat(64) };
    const expected = "sha256:64dd089953b9a23a8e1dbeb794257d64c81efdde7a6a5bfa94fdfcb5c976289a";
    expect(await inputDigest([short, long])).toBe(expected);
    expect(await inputDigest([long, short])).toBe(expected);
  });

  test("each refusal names the field a caller maps to a fixed word", async () => {
    const row: StoreContentRow = vectors.input_digest[0].rows[0];
    const fieldOf = async (rows: unknown) =>
      (await rejects(inputDigest(rows as StoreContentRow[]))).field;
    for (const rows of [[], null, undefined, "rows", [null], ["row"], [1], [row, null]]) {
      expect(await fieldOf(rows)).toBe("stores_content");
    }
    const { path: _path, ...noPath } = row;
    const { group: _group, ...noGroup } = row;
    const { content_sha256: _digest, ...noDigest } = row;
    expect(await fieldOf([noPath])).toBe("path");
    expect(await fieldOf([noGroup])).toBe("group");
    expect(await fieldOf([noDigest])).toBe("content_sha256");
    for (const path of ["", "a\tb", "a\nb", "a\rb", "a\ud800"]) {
      expect(await fieldOf([{ ...row, path }])).toBe("path");
    }
    expect(await fieldOf([row, row])).toBe("path");
    for (const group of ["", "e\teg", "e\neg", "e\reg", "eeg\udc00"]) {
      expect(await fieldOf([{ ...row, group }])).toBe("group");
    }
    for (const content_sha256 of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), 5]) {
      expect(await fieldOf([{ ...row, content_sha256 }])).toBe("content_sha256");
    }
  });

  test("version 1 reads a row that is a list as an object with no path and names `path`", async () => {
    // Pinned so that nobody copies it: version 2 names `stores_content` for the same row. The stamp
    // rejects a list before any digest is computed, so no record reaches this answer.
    for (const rows of [[[]], [["sub-01/eeg.edf", "eeg"]], [vectors.input_digest[0].rows[0], []]]) {
      const error = await rejects(inputDigest(rows as unknown as StoreContentRow[]));
      expect(error.field).toBe("path");
    }
  });

  test("a row set with no digest is refused", async () => {
    const row: StoreContentRow = vectors.input_digest[0].rows[0];
    await rejects(inputDigest([]));
    await rejects(inputDigest(null as unknown as StoreContentRow[]));
    await rejects(inputDigest([row, row]));
    await rejects(inputDigest([row, { ...row, group: "meg" }]));
    for (const path of ["a\tb", "a\nb", "a\rb", "", "a\ud800"]) {
      await rejects(inputDigest([{ ...row, path }]));
    }
    for (const group of ["e\teg", "e\neg", "", "eeg\udc00"]) {
      await rejects(inputDigest([{ ...row, group }]));
    }
    for (const content_sha256 of [
      "",
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
    ]) {
      await rejects(inputDigest([{ ...row, content_sha256 }]));
    }
    await rejects(inputDigest([null as unknown as StoreContentRow]));
  });
});

/** `storeLocationsText` of a vector's inputs. */
function textOfVector(vector: Pick<LocationsVector, "labels" | "attributes">): string {
  return storeLocationsText({ labels: vector.labels, attributes: vector.attributes });
}

/** The 16 lowercase hexadecimal digits of a binary64, big-endian, written here and not by the module. */
function binary64(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return Array.from(new Uint8Array(view.buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A coordinate triple as the text writes it. */
function positionLine(x: number, y: number, z: number): string {
  return `position ${binary64(x)} ${binary64(y)} ${binary64(z)}`;
}

/** Leaves a key out of `attributesWith` (an argument of `undefined` would take the default). */
const OMIT = Symbol("omit");

/**
 * The attributes a converter writes, with only what a test changes: no `electrode_positions` key
 * when `positions` is undefined, and the system and units `CapTrak` and `mm` unless given or `OMIT`.
 */
function attributesWith(
  positions: unknown,
  system: unknown = "CapTrak",
  units: unknown = "mm",
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  if (positions !== undefined) attributes.electrode_positions = positions;
  if (system !== OMIT) attributes.electrode_coordinate_system = system;
  if (units !== OMIT) attributes.electrode_coordinate_units = units;
  return attributes;
}

/** The attributes of a vector as an object the tests may read. */
function attributesOf(vector: LocationsVector): Record<string, unknown> {
  return vector.attributes as Record<string, unknown>;
}

describe("store locations digest (version 2 vectors)", () => {
  for (const vector of LOCATIONS_VECTORS) {
    test(`${vector.name}: text and digest`, async () => {
      const input = { labels: vector.labels, attributes: vector.attributes };
      expect(storeLocationsText(input)).toBe(vector.text);
      expect(await storeLocationsSha256(input)).toBe(vector.sha256);
      // The digest is the SHA-256 of the text, by a hash that is not the module's.
      expect(vector.sha256).toBe(sha256Of(vector.text));
      for (const variant of vector.also_with ?? []) {
        expect(
          textOfVector({
            labels: variant.labels ?? vector.labels,
            attributes: variant.attributes ?? vector.attributes,
          }),
        ).toBe(vector.text);
      }
      if (vector.also_equal_to) {
        expect(vector.sha256).toBe(locationsVector(vector.also_equal_to).sha256);
      }
    });
  }

  test("every text opens with the format name and ends each line with a line feed", () => {
    expect(STORE_LOCATIONS_FORMAT).toBe("nemar.store-locations.v1");
    for (const vector of LOCATIONS_VECTORS) {
      expect(vector.text.startsWith(`${STORE_LOCATIONS_FORMAT}\nsystem`)).toBe(true);
      expect(vector.text.endsWith("\n")).toBe(true);
      expect(vector.text).not.toContain("\r");
      const lines = vector.text.split("\n");
      expect(lines[1]).toMatch(/^system( |$)/);
      expect(lines[2]).toMatch(/^units( |$)/);
      expect(lines.length).toBe(3 + vector.labels.length + 1);
    }
  });

  test("declared: Fz and Cz have positions in stored order, Pz has none and Oz is nowhere", () => {
    const vector = locationsVector("declared");
    expect(vector.text.split("\n")).toEqual([
      STORE_LOCATIONS_FORMAT,
      "system CapTrak",
      "units mm",
      positionLine(0.5, 62.1, 79.3),
      positionLine(0.25, -1.5, 95.75),
      "position",
      "",
    ]);
    // Oz is an electrode the group lacks: its entry never enters the text.
    expect(vector.text).not.toContain(binary64(-84));
    expect(textOfVector(vector)).toBe(vector.text);
  });

  test("an entry under a label the group lacks changes nothing", () => {
    const vector = locationsVector("declared");
    const stated = attributesOf(vector).electrode_positions as Record<string, number[]>;
    const { Oz: _oz, ...group } = stated;
    const changed = { ...group, Oz: [9, 9, 9], Extra: [1, 2, 3] };
    for (const positions of [stated, group, changed]) {
      expect(
        storeLocationsText({ labels: vector.labels, attributes: attributesWith(positions) }),
      ).toBe(vector.text);
    }
  });

  test("no positions attribute: system and units are bare although stated, every position alone", () => {
    const vector = locationsVector("no positions attribute");
    expect(attributesOf(vector).electrode_coordinate_system).toBe("CapTrak");
    expect(attributesOf(vector).electrode_coordinate_units).toBe("mm");
    expect(vector.text.split("\n")).toEqual([
      STORE_LOCATIONS_FORMAT,
      "system",
      "units",
      "position",
      "position",
      "position",
      "",
    ]);
  });

  test("unlabeled group: the stated system and units stay, no channel joins a position", () => {
    const vector = locationsVector("unlabeled group");
    expect(vector.labels).toEqual(["Fz", null, "Pz"]);
    expect(vector.text.split("\n")).toEqual([
      STORE_LOCATIONS_FORMAT,
      "system CapTrak",
      "units mm",
      "position",
      "position",
      "position",
      "",
    ]);
    // Undefined, a hole and the empty string are no label either.
    const sparse = new Array<ChannelText>(3);
    sparse[0] = "Fz";
    sparse[2] = "Pz";
    for (const labels of [["Fz", undefined, "Pz"], sparse, ["Fz", "", "Pz"]]) {
      expect(storeLocationsText({ labels, attributes: vector.attributes })).toBe(vector.text);
    }
  });

  test("zeros and integers: every zero is positive zero, 12 and 12.0 are one number", () => {
    const vector = locationsVector("zeros and integers");
    const positions = attributesOf(vector).electrode_positions as Record<string, number[]>;
    // The file really holds negative zero for JSON.parse, so the vector exercises the rule.
    expect(Object.is(positions.Fz[0], -0)).toBe(true);
    expect(Object.is(positions.Fz[2], -0)).toBe(true);
    expect(Object.is(positions.Cz[2], -0)).toBe(true);
    expect(vector.text).not.toContain("8000000000000000");
    expect(vector.text).toContain(positionLine(0, 0, 0));
    expect(vector.text).toContain(positionLine(12, 12, 0));
    expect(vector.text).toContain(positionLine(0, 12, 0));
  });

  test("entries with no position: only Cz, an array of exactly three numbers, gets one", () => {
    const vector = locationsVector("entries with no position");
    const lines = vector.text.split("\n");
    expect(lines.slice(3, -1)).toEqual([
      ...Array.from({ length: vector.labels.length - 1 }, () => "position"),
      positionLine(1.5, 2.5, 3.5),
    ]);
    expect(vector.labels.at(-1)).toBe("Cz");
    const positions = attributesOf(vector).electrode_positions as Record<string, unknown>;
    // A boolean is a coordinate nobody wrote: it is a boolean, whatever it would count as.
    expect(positions["boolean coordinate"]).toEqual([true, 2, 3]);
    expect(positions["boolean coordinate last"]).toEqual([1, 2, false]);
  });

  test("an integer too large for binary64 is read as no position, never refused", async () => {
    const vector = locationsVector("an integer too large for binary64");
    const positions = attributesOf(vector).electrode_positions as Record<string, number[]>;
    // JSON.parse reads a 400-digit integer as Infinity; Python reads an int that float() refuses.
    expect(positions.Fz[2]).toBe(Number.POSITIVE_INFINITY);
    expect(vector.text.split("\n").slice(3, 5)).toEqual(["position", positionLine(1.5, 2.5, 3.5)]);
    expect(
      await storeLocationsSha256({ labels: vector.labels, attributes: vector.attributes }),
    ).toBe(vector.sha256);
  });

  test("non-finite coordinates are no position, finite ones beside them stay", () => {
    const vector = locationsVector("non-finite coordinates");
    const positions = attributesOf(vector).electrode_positions as Record<string, number[]>;
    expect(positions.Fz[0]).toBe(Number.POSITIVE_INFINITY);
    expect(positions.Cz[1]).toBe(Number.NEGATIVE_INFINITY);
    expect(vector.text.split("\n").slice(3, 6)).toEqual([
      "position",
      "position",
      positionLine(1, 2, 3),
    ]);
    // Numbers that are not JSON numbers cannot arrive from a file, but a caller may hand them in.
    const handed = attributesWith({ Fz: [Number.NaN, 0, 0], Cz: [0, 0, 0] });
    expect(storeLocationsText({ labels: ["Fz", "Cz"], attributes: handed }).split("\n")[3]).toBe(
      "position",
    );
  });

  test("the largest finite integer keeps its position and the first one that overflows has none", () => {
    // 2^1024 - 2^970 is the least integer that rounds to infinity; one less rounds to the largest double.
    const overflow = (2n ** 1024n - 2n ** 970n).toString();
    const largest = (2n ** 1024n - 2n ** 970n - 1n).toString();
    const parse = (n: string) => JSON.parse(`{"Fz": [${n}, 1, 1], "Cz": [${largest}, 1, 1]}`);
    expect(parse(overflow).Fz[0]).toBe(Number.POSITIVE_INFINITY);
    expect(parse(overflow).Cz[0]).toBe(Number.MAX_VALUE);
    const text = storeLocationsText({
      labels: ["Fz", "Cz"],
      attributes: attributesWith(parse(overflow)),
    });
    expect(text.split("\n").slice(3, 5)).toEqual([
      "position",
      positionLine(Number.MAX_VALUE, 1, 1),
    ]);
  });

  test("inherited names: only own entries join, and the file's own __proto__ is read", () => {
    const vector = locationsVector("inherited names");
    const positions = attributesOf(vector).electrode_positions as Record<string, unknown>;
    // JSON.parse made __proto__ an own key; an object literal would have set a prototype instead.
    expect(Object.hasOwn(positions, "__proto__")).toBe(true);
    expect(Object.hasOwn(positions, "constructor")).toBe(false);
    // The own `hasOwnProperty` entry is an array, so a call of positions.hasOwnProperty would throw.
    expect(Array.isArray(positions.hasOwnProperty)).toBe(true);
    expect(vector.text.split("\n").slice(3, 6)).toEqual([
      "position",
      positionLine(1, 2, 3),
      positionLine(4, 5, 6),
    ]);
    // Names every object inherits join nothing when there is no own entry.
    const labels = ["toString", "valueOf", "isPrototypeOf", "constructor", "__proto__"];
    const plain = storeLocationsText({ labels, attributes: attributesWith({ Fz: [1, 2, 3] }) });
    expect(plain.split("\n").slice(3, -1)).toEqual(labels.map(() => "position"));
  });

  test("exact labels only: no case fold, no trimming, no normalization", () => {
    const vector = locationsVector("exact labels only");
    expect(vector.text.split("\n").slice(3, -1)).toEqual(["position", "position", "position"]);
    const positions = attributesOf(vector).electrode_positions as Record<string, unknown>;
    expect(Object.keys(positions)).toEqual(["fz", "Cz ", `e${String.fromCodePoint(0x0301)}`]);
    expect(vector.labels[2]).toBe(E_PRECOMPOSED);
  });

  test("only own properties are read, even when Object.prototype carries the same names", () => {
    const withUnits =
      '"electrode_coordinate_system": "CapTrak", "electrode_coordinate_units": "mm"';
    // JSON.parse'd, so these objects have no own `Fz` or `electrode_positions` unless the text says so.
    const noPositions = JSON.parse(`{${withUnits}}`);
    const emptyPositions = JSON.parse(`{"electrode_positions": {}, ${withUnits}}`);
    const polluted = (name: string, value: unknown) =>
      Object.defineProperty(Object.prototype, name, {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    let withoutOwnPositions = "";
    let withoutOwnEntry = "";
    try {
      polluted("Fz", [1, 2, 3]);
      polluted("electrode_positions", { Fz: [1, 2, 3] });
      withoutOwnPositions = storeLocationsText({ labels: ["Fz"], attributes: noPositions });
      withoutOwnEntry = storeLocationsText({ labels: ["Fz"], attributes: emptyPositions });
    } finally {
      Reflect.deleteProperty(Object.prototype, "Fz");
      Reflect.deleteProperty(Object.prototype, "electrode_positions");
    }
    // The inherited positions are not the store's: system and units are bare, no channel joins.
    expect(withoutOwnPositions).toBe(`${STORE_LOCATIONS_FORMAT}\nsystem\nunits\nposition\n`);
    // The inherited `Fz` is not an own entry of the store's own positions.
    expect(withoutOwnEntry).toBe(`${STORE_LOCATIONS_FORMAT}\nsystem CapTrak\nunits mm\nposition\n`);
    // And the prototype is clean again.
    expect(Object.hasOwn(Object.prototype, "Fz")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "electrode_positions")).toBe(false);
  });

  test("system without units: the empty text, a missing one and one that is not text are all bare", () => {
    const vector = locationsVector("system without units");
    expect(vector.text.split("\n").slice(1, 3)).toEqual(["system MNI305", "units"]);
    expect(vector.also_with?.length).toBe(3);
    const positions = { Fz: [1, 2, 3], Cz: [4, 5, 6] };
    for (const notText of [null, OMIT, 5, true, ["mm"], { unit: "mm" }]) {
      const text = storeLocationsText({
        labels: vector.labels,
        attributes: attributesWith(positions, "MNI305", notText),
      });
      expect(text.split("\n")[2]).toBe("units");
    }
    for (const notText of [null, OMIT, 5, false, ["CapTrak"], {}]) {
      const text = storeLocationsText({
        labels: vector.labels,
        attributes: attributesWith(positions, notText, "mm"),
      });
      expect(text.split("\n")[1]).toBe("system");
    }
  });

  test("a system or units of whitespace is text, kept exactly", () => {
    const text = storeLocationsText({
      labels: ["Fz"],
      attributes: attributesWith({ Fz: [1, 2, 3] }, " ", "\t"),
    });
    expect(text.split("\n").slice(1, 3)).toEqual(["system  ", "units \t"]);
  });

  test("provenance is not hashed: the converter's attributes and any other root attribute change nothing", async () => {
    const vector = locationsVector("provenance is not hashed");
    const attributes = attributesOf(vector);
    expect(Object.keys(attributes)).toEqual(
      expect.arrayContaining([
        "electrode_positions_source",
        "electrode_positions_file",
        "electrode_coordsystem_file",
      ]),
    );
    expect(vector.text).toBe(locationsVector("declared").text);
    expect(vector.text).not.toContain("subject");
    const more = { ...attributes, electrode_positions_source: "dataset", sampling_frequency: 250 };
    expect(await storeLocationsSha256({ labels: vector.labels, attributes: more })).toBe(
      vector.sha256,
    );
  });

  test("the coordinates are hashed as stated: the units and the numbers each move the digest", async () => {
    const base = locationsVector("declared");
    const digestOf = (attributes: unknown) =>
      storeLocationsSha256({ labels: base.labels, attributes });
    const original = attributesOf(base);
    const positions = original.electrode_positions as Record<string, number[]>;
    const meters = { ...original, electrode_coordinate_units: "m" };
    expect(await digestOf(meters)).not.toBe(base.sha256);
    // Same numbers under another unit name differ only in the units line; no unit change is applied.
    expect(
      textOfVector({ labels: base.labels, attributes: meters }).replace("units m\n", "units mm\n"),
    ).toBe(base.text);
    expect(await digestOf({ ...original, electrode_coordinate_system: "MNI305" })).not.toBe(
      base.sha256,
    );
    // One unit in the last place of one coordinate is a different digest.
    const nudged = {
      ...positions,
      Fz: [positions.Fz[0], positions.Fz[1], positions.Fz[2] + 2 ** -46],
    };
    expect(nudged.Fz[2]).not.toBe(positions.Fz[2]);
    expect(await digestOf({ ...original, electrode_positions: nudged })).not.toBe(base.sha256);
    // Swapping two channels' positions is a different digest: the order is the stored order.
    const swapped = { ...positions, Fz: positions.Cz, Cz: positions.Fz };
    expect(await digestOf({ ...original, electrode_positions: swapped })).not.toBe(base.sha256);
    // So is a channel order that differs, the entries being the same.
    const reordered = await storeLocationsSha256({
      labels: ["Cz", "Fz", "Pz"],
      attributes: original,
    });
    expect(reordered).not.toBe(base.sha256);
  });

  test("two channels with one label both join that label's entry", () => {
    const text = storeLocationsText({
      labels: ["Fz", "Fz"],
      attributes: attributesWith({ Fz: [1, 2, 3] }),
    });
    expect(text.split("\n").slice(3, 5)).toEqual([positionLine(1, 2, 3), positionLine(1, 2, 3)]);
  });

  test("a label's own text is never examined, because no label enters the text", () => {
    const labels = ["Fz\nCz", "a\ud800b", "Pz"];
    const text = storeLocationsText({ labels, attributes: attributesWith({ Pz: [1, 2, 3] }) });
    expect(text.split("\n").slice(3, 6)).toEqual(["position", "position", positionLine(1, 2, 3)]);
  });

  test("text that is dropped is never examined: a line feed beside no positions is accepted", () => {
    const bare = storeLocationsText({
      labels: ["Fz"],
      attributes: attributesWith(undefined, "", ""),
    });
    for (const system of ["Cap\nTrak", "Cap\rTrak", "Cap\ud800Trak"]) {
      expect(
        storeLocationsText({
          labels: ["Fz"],
          attributes: attributesWith(undefined, system, system),
        }),
      ).toBe(bare);
      expect(
        storeLocationsText({ labels: ["Fz"], attributes: attributesWith(null, system, system) }),
      ).toBe(bare);
    }
  });

  test("a system or units text that enters the text and holds a line feed, carriage return or lone surrogate is refused", () => {
    for (const bad of ["a\nb", "a\rb", "\n", "a\ud800", "\udc00b", "a\ud83d"]) {
      const positions = { Fz: [1, 2, 3] };
      refused(() =>
        storeLocationsText({ labels: ["Fz"], attributes: attributesWith(positions, bad, "mm") }),
      );
      refused(() =>
        storeLocationsText({
          labels: ["Fz"],
          attributes: attributesWith(positions, "CapTrak", bad),
        }),
      );
    }
    // A valid surrogate pair is text.
    const pair = storeLocationsText({
      labels: ["Fz"],
      attributes: attributesWith({ Fz: [1, 2, 3] }, GRINNING_FACE, "mm"),
    });
    expect(pair).toContain(`system ${GRINNING_FACE}\n`);
  });

  test("positions that are not an object are refused, null is absent", () => {
    for (const positions of [[[1, 2, 3]], [], "Fz 1 2 3", 5, true, new Map()]) {
      refused(() => storeLocationsText({ labels: ["Fz"], attributes: attributesWith(positions) }));
    }
    const none = storeLocationsText({ labels: ["Fz"], attributes: attributesWith(null) });
    expect(none).toBe(
      storeLocationsText({ labels: ["Fz"], attributes: attributesWith(undefined) }),
    );
  });

  test("attributes that are not a plain object, and labels that are not a list of text, are refused", () => {
    for (const attributes of [[], null, undefined, "attributes", 5, true, new Map()]) {
      refused(() => storeLocationsText({ labels: ["Fz"], attributes }));
    }
    for (const labels of [[], null, undefined, "Fz", 5, { length: 1 }]) {
      refused(() =>
        storeLocationsText({
          labels: labels as unknown as string[],
          attributes: attributesWith({}),
        }),
      );
    }
    for (const bad of [5, true, {}, ["Fz"]]) {
      refused(() =>
        storeLocationsText({
          labels: ["Fz", bad as unknown as string],
          attributes: attributesWith({}),
        }),
      );
    }
    // A null-prototype object is plain.
    const bare = Object.assign(Object.create(null), attributesWith({ Fz: [1, 2, 3] }));
    expect(storeLocationsText({ labels: ["Fz"], attributes: bare })).toContain("position 3ff0");
  });

  test("each refused vector has no digest, from the text and from the digest function", async () => {
    for (const entry of FILE.refused.store_locations) {
      const input = { labels: entry.labels, attributes: entry.attributes };
      refused(() => storeLocationsText(input));
      await rejects(storeLocationsSha256(input));
    }
  });

  test("the digest is 64 lowercase hexadecimal digits", async () => {
    for (const vector of LOCATIONS_VECTORS) {
      expect(await storeLocationsSha256(vector)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

/** A store row of version 2 with a given locations field. */
function rowV2(overrides: Partial<Record<keyof StoreRowV2, unknown>> = {}): StoreRowV2 {
  return {
    path: "sub-01/eeg/sub-01_task-rest_eeg.edf",
    group: "eeg",
    content_sha256: "0c268ca3444e5c884afb5475ae13b6bc3170869776b2e4b0118205f2f08f84cd",
    locations: LOCATIONS_NONE,
    ...overrides,
  } as StoreRowV2;
}

describe("input digest, version 2 (rows of four fields)", () => {
  for (const vector of DIGEST_V2_VECTORS) {
    test(`${vector.name}: text and digest, given in either order`, async () => {
      expect(inputDigestV2Text(vector.rows)).toBe(vector.text);
      expect(inputDigestV2Text([...vector.rows].reverse())).toBe(vector.text);
      expect(await inputDigestV2(vector.rows)).toBe(vector.digest);
      expect(await inputDigestV2([...vector.rows].reverse())).toBe(vector.digest);
      expect(vector.digest).toBe(`sha256:${sha256Of(vector.text)}`);
    });
  }

  test("the text opens with the format name, then one tab-separated line per row", () => {
    expect(INPUT_DIGEST_V2_FORMAT).toBe("nemar.input-digest.v2");
    expect(LOCATIONS_NONE).toBe("none");
    for (const vector of DIGEST_V2_VECTORS) {
      // The file's text and the text the module writes for the same rows are both checked.
      for (const text of [vector.text, inputDigestV2Text(vector.rows)]) {
        const lines = text.split("\n");
        expect(lines[0]).toBe(INPUT_DIGEST_V2_FORMAT);
        expect(lines.at(-1)).toBe("");
        expect(lines.length).toBe(vector.rows.length + 2);
        for (const line of lines.slice(1, -1)) expect(line.split("\t").length).toBe(4);
      }
    }
  });

  test("the vectors reuse version 1's rows and the declared locations digest", () => {
    const [one, none, order] = DIGEST_V2_VECTORS;
    const v1 = vectors.input_digest;
    expect(one.rows[0]).toEqual({
      ...v1[0].rows[0],
      locations: locationsVector("declared").sha256,
    });
    expect(none.rows[0]).toEqual({ ...v1[0].rows[0], locations: "none" });
    expect(order.rows.map((r) => r.path)).toEqual(v1[1].rows.map((r) => r.path));
    expect(order.rows.map((r) => r.locations)).toEqual(["none", "none"]);
  });

  test("a version 1 text and a version 2 text of the same stores are different bytes and digests", async () => {
    for (const vector of DIGEST_V2_VECTORS) {
      const rowsV1 = vector.rows.map(({ path, group, content_sha256 }) => ({
        path,
        group,
        content_sha256,
      }));
      expect(await inputDigestV2(vector.rows)).not.toBe(await inputDigest(rowsV1));
      // The version 2 text is the header and then each row's version 1 line with a field added: the
      // header is what keeps the two from ever being the same bytes, and without it the first line
      // of a version 2 text would be a row.
      const v2Lines = inputDigestV2Text(vector.rows).split("\n");
      expect(v2Lines[0]).toBe("nemar.input-digest.v2");
      const v1Text = v2Lines
        .slice(1)
        .map((line) => line.split("\t").slice(0, 3).join("\t"))
        .join("\n");
      expect(`sha256:${sha256Of(v1Text)}`).toBe(await inputDigest(rowsV1));
      expect(inputDigestV2Text(vector.rows)).not.toBe(v1Text);
    }
    // Version 1 does not read a locations field at all.
    const one = DIGEST_V2_VECTORS[0].rows[0];
    expect(await inputDigest([one])).toBe(vectors.input_digest[0].digest);
  });

  test("the locations field is part of the digest: a digest and none and another digest all differ", async () => {
    const declared = locationsVector("declared").sha256;
    const without = locationsVector("no positions attribute").sha256;
    expect(without).not.toBe(declared);
    const digests = await Promise.all(
      [declared, without, LOCATIONS_NONE].map((locations) => inputDigestV2([rowV2({ locations })])),
    );
    expect(new Set(digests).size).toBe(3);
  });

  test("a locations digest is exactly 64 lowercase hexadecimal digits or exactly none", async () => {
    const hex = "ab".repeat(32);
    expect(await inputDigestV2([rowV2({ locations: hex })])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await inputDigestV2([rowV2({ locations: "none" })])).toMatch(/^sha256:[0-9a-f]{64}$/);
    const bad: unknown[] = [
      "NONE",
      "None",
      "none ",
      " none",
      "none\n",
      "",
      "no",
      `${"ab".repeat(31)}a`,
      "ab".repeat(33),
      "AB".repeat(32),
      "g".repeat(64),
      `${hex}\n`,
      `sha256:${hex}`,
      null,
      5,
      true,
      ["none"],
      { none: true },
    ];
    for (const locations of bad) {
      const error = await rejects(inputDigestV2([rowV2({ locations })]));
      expect(error.field).toBe("locations");
    }
    const { locations: _locations, ...missing } = rowV2();
    const error = await rejects(inputDigestV2([missing as StoreRowV2]));
    expect(error.field).toBe("locations");
  });

  test("every refusal of version 1 holds, with the same field", async () => {
    const fieldOf = async (rows: unknown) =>
      (await rejects(inputDigestV2(rows as StoreRowV2[]))).field;
    for (const rows of [[], null, undefined, "rows", [null], ["row"], [1], [rowV2(), null]]) {
      expect(await fieldOf(rows)).toBe("stores_content");
    }
    const { path: _path, ...noPath } = rowV2();
    const { group: _group, ...noGroup } = rowV2();
    const { content_sha256: _digest, ...noDigest } = rowV2();
    expect(await fieldOf([noPath])).toBe("path");
    expect(await fieldOf([noGroup])).toBe("group");
    expect(await fieldOf([noDigest])).toBe("content_sha256");
    for (const path of ["", "a\tb", "a\nb", "a\rb", "a\ud800"]) {
      expect(await fieldOf([rowV2({ path })])).toBe("path");
    }
    expect(await fieldOf([rowV2(), rowV2()])).toBe("path");
    expect(await fieldOf([rowV2(), rowV2({ group: "meg" })])).toBe("path");
    for (const group of ["", "e\teg", "e\neg", "e\reg", "eeg\udc00"]) {
      expect(await fieldOf([rowV2({ group })])).toBe("group");
    }
    for (const content_sha256 of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), 5]) {
      expect(await fieldOf([rowV2({ content_sha256 })])).toBe("content_sha256");
    }
    // A row with two bad fields names the first in the order path, group, content, locations.
    expect(await fieldOf([rowV2({ content_sha256: "x", locations: "NONE" })])).toBe(
      "content_sha256",
    );
    expect(await fieldOf([rowV2({ group: "", locations: "NONE" })])).toBe("group");
  });

  test("a row that is a list is not an object: refused with the field stores_content", async () => {
    // Version 1 names `path` for the same rows (pinned in the version 1 tests): the one difference.
    const lists: unknown[][] = [
      [[]],
      [["sub-01/eeg.edf", "eeg", "a".repeat(64), "none"]],
      [rowV2(), []],
      [[], rowV2()],
    ];
    for (const rows of lists) {
      const error = await rejects(inputDigestV2(rows as StoreRowV2[]));
      expect(error.field).toBe("stores_content");
      expect(refused(() => inputDigestV2Text(rows as StoreRowV2[])).field).toBe("stores_content");
    }
  });

  test("a different group, path, content or locations is a different digest", async () => {
    const row = rowV2();
    const base = await inputDigestV2([row]);
    expect(await inputDigestV2([{ ...row, group: "meg" }])).not.toBe(base);
    expect(await inputDigestV2([{ ...row, path: "sub-02/eeg.edf" }])).not.toBe(base);
    expect(await inputDigestV2([{ ...row, content_sha256: "0".repeat(64) }])).not.toBe(base);
    expect(await inputDigestV2([{ ...row, locations: "1".repeat(64) }])).not.toBe(base);
  });

  test("a path that is a byte prefix of another sorts first, whatever order the rows come in", async () => {
    const short = rowV2({ path: "a", content_sha256: "a".repeat(64) });
    const long = rowV2({ path: "a/b", content_sha256: "b".repeat(64) });
    expect(
      inputDigestV2Text([long, short])
        .split("\n")
        .slice(1, 3)
        .map((l) => l.split("\t")[0]),
    ).toEqual(["a", "a/b"]);
    expect(await inputDigestV2([short, long])).toBe(await inputDigestV2([long, short]));
  });

  test("a version 2 digest is a valid input digest of a zarr key, and the key stays version 1", async () => {
    const digest = DIGEST_V2_VECTORS[0].digest;
    const fields = { ...KEY_FIELDS, input_digest: digest };
    expect(validateDerivativeKeyFields(fields).ok).toBe(true);
    expect(derivativeKeyText(fields).split("\n")[0]).toBe("nemar.derivative-key.v1");
    expect(derivativeKeyText(fields)).toContain(`\ninput_digest ${digest}\n`);
    expect(await derivativeKey(fields)).not.toBe(vectors.derivative_key[0].key);
    // And it is not valid for a bids input, whose digest is a commit.
    expect(
      validateDerivativeKeyFields({ ...vectors.derivative_key[1].fields, input_digest: digest }).ok,
    ).toBe(false);
  });

  test("each refused vector has no digest and names the field", async () => {
    for (const entry of FILE.refused.input_digest_v2) {
      const error = await rejects(inputDigestV2(entry.rows as StoreRowV2[]));
      expect(error.field).toBe(entry.field);
      // The locations rows name `locations`; a row that is a list is not an object.
      expect(entry.field).toBe(
        entry.name === "a row that is a list" ? "stores_content" : "locations",
      );
    }
  });
});

describe("derivative key (vectors 6 and 7)", () => {
  for (const vector of vectors.derivative_key) {
    test(`${vector.name}: text and key`, async () => {
      expect(derivativeKeyText(vector.fields)).toBe(vector.text);
      expect(await derivativeKey(vector.fields)).toBe(vector.key);
    });
  }

  test("the vectors' input digest for the zarr key is vector 4's", () => {
    expect(vectors.derivative_key[0].fields.input_digest).toBe(vectors.input_digest[0].digest);
  });

  test("the key is 64 lowercase hexadecimal digits and the text names the fields in order", async () => {
    expect(await derivativeKey(KEY_FIELDS)).toMatch(/^[0-9a-f]{64}$/);
    expect(derivativeKeyText(KEY_FIELDS).split("\n")).toEqual([
      "nemar.derivative-key.v1",
      ...DERIVATIVE_KEY_FIELDS.map((name) => `${name} ${KEY_FIELDS[name]}`),
      "",
    ]);
    expect([...DERIVATIVE_KEY_FIELDS]).toEqual([
      "dataset",
      "version",
      "recipe",
      "recipe_version",
      "engine",
      "input",
      "profile",
      "input_digest",
    ]);
  });

  test("every field is part of the key", async () => {
    const base = await derivativeKey(KEY_FIELDS);
    const changes: Record<string, string> = {
      dataset: "xx099998",
      version: "v1.0.1",
      recipe: "nemar-ica",
      recipe_version: "1.0.1",
      engine: "eegprep@0.5.1",
      input_digest: `sha256:${"0".repeat(64)}`,
    };
    for (const [name, value] of Object.entries(changes)) {
      expect(await derivativeKey({ ...KEY_FIELDS, [name]: value })).not.toBe(base);
    }
    expect(await derivativeKey(vectors.derivative_key[1].fields)).not.toBe(base);
  });

  test("a stamp's other columns, such as the image digest, never enter the key", async () => {
    const extra = { ...KEY_FIELDS, image_digest: `sha256:${"1".repeat(64)}`, job_id: "j" };
    expect(await derivativeKey(extra)).toBe(vectors.derivative_key[0].key);
    const checked = validateDerivativeKeyFields(extra);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(Object.keys(checked.fields)).toEqual([...DERIVATIVE_KEY_FIELDS]);
  });
});

describe("the key fields are validated", () => {
  const BAD: Array<[string, string]> = [
    ["dataset", "XX099999"],
    ["dataset", "x099999"],
    ["dataset", "xx99999"],
    ["dataset", "xx0999990"],
    ["dataset", "xx09999a"],
    ["dataset", "xx099999\n"],
    ["dataset", ""],
    ["version", ""],
    ["version", "v1 0"],
    ["version", "v1/0"],
    ["version", "v".repeat(65)],
    ["version", "v1.0.0\n"],
    ["recipe", "Nemar-Floor"],
    ["recipe", "nemar_floor"],
    ["recipe", "nemar floor"],
    ["recipe", ""],
    ["recipe", "r".repeat(65)],
    ["recipe_version", "1.0.0 "],
    ["recipe_version", "1.0.0@x"],
    ["recipe_version", ""],
    ["engine", "eegprep 0.5.0"],
    ["engine", "eegprep@0.5.0\n"],
    ["engine", "e".repeat(65)],
    ["engine", ""],
    ["input", "ZARR"],
    ["input", "edf"],
    ["input", "constructor"],
    ["input", ""],
    ["profile", "Serving"],
    ["profile", "archive"],
    ["input_digest", ""],
    ["input_digest", `sha256:${"A".repeat(64)}`],
    ["input_digest", `sha256:${"a".repeat(63)}`],
    ["input_digest", `sha256:${"a".repeat(65)}`],
    ["input_digest", `${"a".repeat(64)}`],
    ["input_digest", `git:${"a".repeat(40)}`],
    ["input_digest", `sha256:${"a".repeat(64)}\n`],
  ];

  for (const [field, value] of BAD) {
    test(`${field} ${JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}...` : value)} is refused`, async () => {
      const fields = { ...KEY_FIELDS, [field]: value };
      const checked = validateDerivativeKeyFields(fields);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.field).toBe(field);
      expect(refused(() => derivativeKeyText(fields as DerivativeKeyFields)).field).toBe(field);
      await rejects(derivativeKey(fields as DerivativeKeyFields));
    });
  }

  test("a refused pairing: zarr with archive, bids with serving, either digest on the other input", async () => {
    const zarr = vectors.derivative_key[0].fields;
    const bids = vectors.derivative_key[1].fields;
    const pairings: DerivativeKeyFields[] = [
      { ...zarr, profile: "archive" },
      { ...bids, profile: "serving" },
      { ...zarr, input_digest: bids.input_digest },
      { ...bids, input_digest: zarr.input_digest },
      { ...zarr, input: "bids" },
      { ...bids, input: "zarr" },
    ];
    for (const fields of pairings) {
      expect(validateDerivativeKeyFields(fields).ok).toBe(false);
      await rejects(derivativeKey(fields));
    }
    const profile = validateDerivativeKeyFields({ ...zarr, profile: "archive" });
    expect(profile.ok === false && profile.field).toBe("profile");
  });

  test("a field that is missing, or not text, or fields that are not an object", () => {
    for (const name of DERIVATIVE_KEY_FIELDS) {
      const { [name]: _dropped, ...rest } = KEY_FIELDS;
      const missing = validateDerivativeKeyFields(rest);
      expect(missing.ok === false && missing.field).toBe(name);
      const number = validateDerivativeKeyFields({ ...KEY_FIELDS, [name]: 1 });
      expect(number.ok === false && number.field).toBe(name);
    }
    for (const bad of [null, undefined, "text", 3]) {
      const checked = validateDerivativeKeyFields(bad);
      expect(checked.ok).toBe(false);
    }
  });

  test("the values the rules allow are accepted at their edges", () => {
    const edge = {
      dataset: "ab000000",
      version: `${"V".repeat(60)}._+-`,
      recipe: `${"a0".repeat(32)}`,
      recipe_version: "0",
      engine: `${"E".repeat(60)}._+@`,
      input: "bids",
      profile: "archive",
      input_digest: `git:${"0123456789abcdef".repeat(2)}01234567`,
    };
    expect(validateDerivativeKeyFields(edge).ok).toBe(true);
  });
});

describe("a bids input's git digest is exactly 40 lowercase hexadecimal digits", () => {
  const bids = vectors.derivative_key[1].fields;

  test("39 or 41 digits, uppercase digits, or nothing after `git:` are refused", () => {
    for (const bad of [
      `git:${"a".repeat(39)}`,
      `git:${"a".repeat(41)}`,
      `git:${"A".repeat(40)}`,
      `git:${"a".repeat(39)}A`,
      `git:${"a".repeat(39)}g`,
      "git:",
      `GIT:${"a".repeat(40)}`,
      `git: ${"a".repeat(40)}`,
      `git:${"a".repeat(40)}\n`,
      "a".repeat(40),
      `sha256:${"a".repeat(64)}`,
    ]) {
      const checked = validateDerivativeKeyFields({ ...bids, input_digest: bad });
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.field).toBe("input_digest");
    }
    expect(
      validateDerivativeKeyFields({
        ...bids,
        input_digest: `git:${"0123456789abcdef".repeat(2)}01234567`,
      }).ok,
    ).toBe(true);
  });
});

describe("the vectors' refused list: every entry has no digest", () => {
  for (const entry of vectors.refused.store_content) {
    test(`store content: ${entry.name}`, async () => {
      // JSON cannot hold a NaN, so the file writes the string NaN.
      const rate = entry.rate === "NaN" ? Number.NaN : Number(entry.rate);
      await rejects(storeContentSha256({ ...entry, rate }));
    });
  }

  for (const entry of vectors.refused.input_digest) {
    test(`input digest: ${entry.name}`, async () => {
      await rejects(inputDigest(entry.rows));
    });
  }

  for (const entry of vectors.refused.derivative_key) {
    test(`derivative key: ${entry.name}`, async () => {
      expect(validateDerivativeKeyFields(entry.fields).ok).toBe(false);
      await rejects(derivativeKey(entry.fields));
    });
  }
});

describe("ADR 0123 states what the module does", () => {
  const adr = readFileSync(
    join(
      import.meta.dir,
      "../.context/decisions/0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md",
    ),
    "utf8",
  );

  test("the serving sentence is the module's, word for word", () => {
    expect(adr).toContain(SERVING_PROFILE_SENTENCE);
  });

  test("the refusals beyond a line feed and a lone surrogate are written down", () => {
    for (const phrase of [
      "not finite",
      "fewer than one channel or one sample",
      "no rows, a repeated path, an empty path or group",
      "a tab, carriage return, line feed or lone surrogate in a path or group",
      "64 lowercase hexadecimal digits",
      "re.fullmatch",
    ]) {
      expect(adr).toContain(phrase);
    }
  });

  test("an image change that can change a value must change a version", () => {
    expect(adr).toContain(
      "an image change that can change a value must change `recipe_version` or `engine`",
    );
  });

  test("the amendment names both new formats, what `none` means and what is not hashed", () => {
    for (const phrase of [
      STORE_LOCATIONS_FORMAT,
      INPUT_DIGEST_V2_FORMAT,
      `\`${LOCATIONS_NONE}\``,
      "not hashed",
      "electrode_positions_source",
      "electrode_positions_file",
      "electrode_coordsystem_file",
    ]) {
      expect(adr).toContain(phrase);
    }
  });

  test("the amendment says what it refuses, what it accepts and what it departs from", () => {
    // A null label is accepted (the group is then unlabeled), so the refusal is neither text nor null.
    expect(adr).toContain("an entry that is neither text nor null");
    // A row that is a list is refused as stores_content in version 2, where version 1 names path.
    expect(adr).toContain(
      "a row that is a list is not an object and is refused with the field `stores_content`",
    );
    // The amendment is the one exception to the Consequences sentence, and says so.
    expect(adr).toContain("This amendment is the single exception to the Consequences sentence");
    expect(adr).toContain("it keeps the new format names");
  });

  test("the amendment is a dated section after the receipts, every later section is a later amendment, and decision 3 keeps its 2026-11-14 text", () => {
    const heading =
      "## Amendment 2026-11-16 (owner decision Q49, D3): the Zarr input digest names the positions a recipe was handed";
    const at = adr.indexOf(heading);
    const receipts = adr.indexOf("## Receipts");
    expect(receipts).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(receipts);
    // Amendments are appended, never interleaved: every section after the receipts, this one included, is
    // an amendment dated no earlier than the one before it, so a section of any other kind or an amendment
    // out of order fails here.
    const after = adr.slice(receipts + "## Receipts".length).match(/^## .*$/gm) ?? [];
    let previous = "0000-00-00";
    for (const section of after) {
      const date = /^## Amendment (\d{4}-\d{2}-\d{2}) \(/.exec(section)?.[1] ?? "";
      expect([section, date !== "" && date >= previous]).toEqual([section, true]);
      previous = date;
    }
    // The 2026-11-14 sentences of decision 3, word for word, in their order.
    const original = [
      "3. **The input digest names what was read, not what was indexed.**",
      "   For a `zarr` input it is `sha256:` and the SHA-256 of the lines `path`, tab, `group`, tab, `content_sha256`, LF, one per store whose group was read in full, sorted by path in code point order",
      "   Keying on the index would orphan derivatives at every reconversion; a content digest changes only when a value the recipe read changes.",
    ];
    let from = 0;
    for (const sentence of original) {
      const found = adr.indexOf(sentence, from);
      expect(found).toBeGreaterThanOrEqual(from);
      from = found;
    }
    expect(adr).toContain(
      "Amended 2026-11-16: a `zarr` input is keyed by `nemar.input-digest.v2`, which adds each store's `nemar.store-locations.v1` digest (see the amendment).",
    );
    // Version 1 stays defined, and the amendment says why it is an amendment and what governs a later change.
    expect(adr).toContain("version 1 stays defined");
    expect(adr).toContain("a new format name and a new ADR");
  });
});

describe("retention words and the serving sentence", () => {
  test("three classes, canary first and published last, none added silently", () => {
    expect([...RETENTION_CLASSES]).toEqual(["canary", "catalog", "published"]);
    expect(Object.isFrozen(RETENTION_CLASSES)).toBe(true);
  });

  test("a canary lives 30 days and a superseded catalog derivative 30 days more", () => {
    expect(CANARY_DAYS).toBe(30);
    expect(SUPERSEDED_GRACE_DAYS).toBe(30);
  });

  test("the serving sentence is declared once, and never states an archived recording's rate", () => {
    expect(SERVING_PROFILE_SENTENCE).toBe(
      "Computed on NEMAR's Zarr serving copy (EEG capped at 250 Hz, 16-bit), not on the archived recordings.",
    );
    expect(SERVING_PROFILE_SENTENCE.match(/\d+ Hz/g)).toEqual(["250 Hz"]);
  });
});
