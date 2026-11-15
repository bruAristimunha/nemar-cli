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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vectors from "../shared/contract/derivatives-vectors.json";
import {
  CANARY_DAYS,
  type ChannelText,
  DERIVATIVE_KEY_FIELDS,
  DerivativeContractError,
  type DerivativeKeyFields,
  RETENTION_CLASSES,
  SERVING_PROFILE_SENTENCE,
  STORE_CONTENT_FORMAT,
  SUPERSEDED_GRACE_DAYS,
  type StoreContentRow,
  derivativeKey,
  derivativeKeyText,
  inputDigest,
  storeContentHeader,
  storeContentSha256,
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
      "derivative_key",
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
