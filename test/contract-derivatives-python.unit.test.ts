/**
 * The version 2 digests of the derivative store (ADR 0123, amendment 2026-11-16), checked against a
 * SECOND implementation written in Python. `nemar.store-locations.v1` and `nemar.input-digest.v2`
 * are language-neutral definitions that nemar-process reproduces in Python (`common/zarr_input.py`),
 * and the two languages read JSON differently: Python reads the number `-0` as the integer 0 and a
 * 400-digit integer as an `int` that `float()` refuses, where `JSON.parse` reads negative zero and
 * Infinity, and Python's `True` is an `int`. So a vector file both languages read is not enough: the
 * Python side has to run, for the vectors and for the edge cases below.
 *
 * One `uv run --no-project --python 3.12 python -I -c HARNESS` call per run. HARNESS is written in
 * this file with only `json`, `struct`, `hashlib`, `math` and `re` and imports no repository code. It
 * reads the vectors file itself with Python's `json` and a table of extra cases on stdin, which this
 * file writes as JSON TEXT and never through `JSON.stringify` (which writes negative zero as `0`).
 * It answers each text, digest and refusal; this file requires every answer to equal the module's
 * and, for a vector, the file's.
 *
 * The suite is skipped on a machine without `uv` and FAILS where `NEMAR_REQUIRE_SCRUB_TOOLS=1` (CI's
 * `unit-pure-shard` job sets it and installs `uv`). Needs network when `uv` has no Python 3.12.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DerivativeContractError,
  type StoreRowV2,
  inputDigestV2,
  inputDigestV2Text,
  storeLocationsSha256,
  storeLocationsText,
} from "../shared/contract/derivatives.js";
import { toolOrFail } from "./scrub/helpers/require-tools";

const VECTORS_PATH = join(import.meta.dir, "../shared/contract/derivatives-vectors.json");

/** Read with `JSON.parse`, as the unit test does: `__proto__` is an own key in one vector. */
const FILE = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as {
  store_locations: Array<{
    name: string;
    labels: unknown;
    attributes: unknown;
    text: string;
    sha256: string;
    also_with?: Array<{ labels?: unknown; attributes?: unknown }>;
  }>;
  input_digest_v2: Array<{ name: string; rows: unknown; text: string; digest: string }>;
  refused: {
    store_locations: Array<{ name: string; labels: unknown; attributes: unknown }>;
    input_digest_v2: Array<{ name: string; field: string; rows: unknown }>;
  };
};

/**
 * The second implementation of items 1 and 2 of the definition: independent code, standard library
 * only. `String.raw` keeps the Python backslashes as written. Anything but a refusal that the
 * harness itself raises is reported as a `crash` answer, so a missing guard shows as a differing
 * answer for that case and not as a dead process.
 */
const HARNESS = String.raw`
import hashlib, json, math, re, struct, sys

class Refused(Exception):
    def __init__(self, message, field=None):
        super().__init__(message)
        self.field = field

DIGEST = re.compile(r"[0-9a-f]{64}")

def lone_surrogate(text):
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)

def header_text(text):
    if "\r" in text or "\n" in text or lone_surrogate(text):
        raise Refused("text that enters the text holds a line feed, carriage return or lone surrogate")
    return text

def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)

def hex64(value):
    if value == 0:
        value = 0.0
    return struct.pack(">d", value).hex()

def coordinates(entry):
    if not isinstance(entry, list) or len(entry) != 3:
        return None
    out = []
    for value in entry:
        if not is_number(value):
            return None
        try:
            as_float = float(value)
        except OverflowError:
            return None
        if not math.isfinite(as_float):
            return None
        out.append(as_float)
    return out

def locations_text(labels, attributes):
    if not isinstance(labels, list) or len(labels) == 0:
        raise Refused("labels must be a list of at least one entry")
    for entry in labels:
        if entry is not None and not isinstance(entry, str):
            raise Refused("a label is not text")
    if not isinstance(attributes, dict):
        raise Refused("attributes must be an object")
    positions = attributes.get("electrode_positions")
    if positions is not None and not isinstance(positions, dict):
        raise Refused("electrode_positions must be an object")

    def stated(key):
        value = attributes.get(key)
        return value if isinstance(value, str) else ""

    system = stated("electrode_coordinate_system")
    units = stated("electrode_coordinate_units")
    lines = ["nemar.store-locations.v1"]
    lines.append("system " + header_text(system) if positions is not None and system != "" else "system")
    lines.append("units " + header_text(units) if positions is not None and units != "" else "units")
    named = positions is not None and all(isinstance(entry, str) and entry != "" for entry in labels)
    for label in labels:
        found = coordinates(positions.get(label)) if named else None
        lines.append("position " + " ".join(hex64(v) for v in found) if found else "position")
    return "\n".join(lines) + "\n"

def row_text(value, field):
    if not isinstance(value, str) or value == "":
        raise Refused(field + " must be non-empty text", field)
    if "\r" in value or "\n" in value or "\t" in value or lone_surrogate(value):
        raise Refused(field + " holds a tab, carriage return, line feed or lone surrogate", field)
    return value

def digest_text(rows):
    if not isinstance(rows, list) or len(rows) == 0:
        raise Refused("an input digest needs at least one store", "stores_content")
    entries = []
    for row in rows:
        if not isinstance(row, dict):
            raise Refused("a row is not an object", "stores_content")
        path = row_text(row.get("path"), "path")
        group = row_text(row.get("group"), "group")
        content = row.get("content_sha256")
        if not isinstance(content, str) or DIGEST.fullmatch(content) is None:
            raise Refused("content_sha256 must be 64 lowercase hexadecimal digits", "content_sha256")
        locations = row.get("locations")
        if not isinstance(locations, str) or not (locations == "none" or DIGEST.fullmatch(locations)):
            raise Refused("locations must be none or 64 lowercase hexadecimal digits", "locations")
        entries.append((path.encode("utf-8"), path, group, content, locations))
    entries.sort(key=lambda entry: entry[0])
    for first, second in zip(entries, entries[1:]):
        if first[1] == second[1]:
            raise Refused("a path appears in two rows", "path")
    return "nemar.input-digest.v2\n" + "".join("\t".join(entry[1:]) + "\n" for entry in entries)

def sha256_of(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def answer_locations(case):
    try:
        text = locations_text(case.get("labels"), case.get("attributes"))
    except Refused:
        return {"refused": True}
    except Exception as error:
        return {"crash": type(error).__name__ + ": " + str(error)}
    return {"text": text, "sha256": sha256_of(text)}

def answer_digest(rows):
    try:
        text = digest_text(rows)
    except Refused as error:
        return {"refused": True, "field": error.field}
    except Exception as error:
        return {"crash": type(error).__name__ + ": " + str(error)}
    return {"text": text, "digest": "sha256:" + sha256_of(text)}

with open(sys.argv[1], encoding="utf-8") as handle:
    vectors = json.load(handle)
extra = json.load(sys.stdin)
locations = vectors["store_locations"]
out = {
    "locations": [answer_locations(v) for v in locations],
    "variants": [[answer_locations({**v, **w}) for w in v.get("also_with", [])] for v in locations],
    "digests": [answer_digest(v["rows"]) for v in vectors["input_digest_v2"]],
    "refused_locations": [answer_locations(v) for v in vectors["refused"]["store_locations"]],
    "refused_digests": [answer_digest(v["rows"]) for v in vectors["refused"]["input_digest_v2"]],
    "extra_locations": [answer_locations(c) for c in extra["locations"]],
    "extra_digests": [answer_digest(c["rows"]) for c in extra["digests"]],
}
json.dump(out, sys.stdout)
`;

// Integers at the edge of binary64: the least that rounds to infinity (the midpoint, ties to even)
// and the one below it, which rounds to the largest double. JSON text, so the digits stay exact.
const OVERFLOWS = (2n ** 1024n - 2n ** 970n).toString();
const LARGEST = (2n ** 1024n - 2n ** 970n - 1n).toString();
const FOUR_HUNDRED_DIGITS = `1${"0".repeat(399)}`;

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CAP = String.raw`"electrode_coordinate_system": "CapTrak", "electrode_coordinate_units": "mm"`;

/** One extra locations case as JSON text: the positions object text, then the attribute tail. */
function locationsCase(name: string, labels: string, attributes: string): string {
  return `{"name": ${JSON.stringify(name)}, "labels": ${labels}, "attributes": ${attributes}}`;
}

/** One extra input digest case as JSON text. */
function digestCase(name: string, rows: string): string {
  return `{"name": ${JSON.stringify(name)}, "rows": ${rows}}`;
}

/** A row as JSON text, with the locations field as text or left out when `undefined`. */
function row(
  path: string,
  locations: string | undefined,
  group = '"eeg"',
  content = HEX_A,
): string {
  const items = [
    `"path": ${path}`,
    `"group": ${group}`,
    `"content_sha256": ${JSON.stringify(content)}`,
  ];
  if (locations !== undefined) items.push(`"locations": ${locations}`);
  return `{${items.join(", ")}}`;
}

const EXTRA_LOCATIONS: string[] = [
  locationsCase(
    "every spelling of zero",
    '["A", "B", "C", "D"]',
    `{"electrode_positions": {"A": [-0, -0.0, 0], "B": [0e0, -0e0, -0.0e5], "C": [-1e-400, 1e-400, 0.0], "D": [0, 0, 0]}, ${CAP}}`,
  ),
  locationsCase(
    "float edges",
    '["A", "B", "C", "D"]',
    `{"electrode_positions": {"A": [5e-324, -5e-324, 2.2250738585072014e-308], "B": [1.7976931348623157e308, -1.7976931348623157e308, 0.1], "C": [-1.5e-7, 4.35, 1e22], "D": [123456.789e3, 1E2, 1e+2]}, ${CAP}}`,
  ),
  locationsCase(
    "integers beyond 2 to the 53",
    '["A", "B"]',
    `{"electrode_positions": {"A": [9007199254740993, -9007199254740993, 123456789012345678901234567890], "B": [1, 2, 3]}, ${CAP}}`,
  ),
  locationsCase(
    "the least integer that rounds to infinity",
    '["A", "B", "C"]',
    `{"electrode_positions": {"A": [${OVERFLOWS}, 1, 1], "B": [${LARGEST}, 1, 1], "C": [-${OVERFLOWS}, 1, 1]}, ${CAP}}`,
  ),
  locationsCase(
    "integers and floats beyond binary64",
    '["A", "B", "C", "D"]',
    `{"electrode_positions": {"A": [${FOUR_HUNDRED_DIGITS}, 1, 1], "B": [1, -${FOUR_HUNDRED_DIGITS}, 1], "C": [1, 1, 1e400], "D": [1, 1, -1E+999]}, ${CAP}}`,
  ),
  locationsCase(
    "a boolean beside numbers",
    '["A", "B", "C", "D"]',
    `{"electrode_positions": {"A": [true, 1, 1], "B": [1, false, 1], "C": [1, 1, true], "D": [1, 1, 1]}, ${CAP}}`,
  ),
  locationsCase(
    "values that are not numbers",
    '["A", "B", "C", "D", "E"]',
    `{"electrode_positions": {"A": ["1", 1, 1], "B": [null, 1, 1], "C": [[1], 1, 1], "D": [{"x": 1}, 1, 1], "E": [1, 1, 1]}, ${CAP}}`,
  ),
  locationsCase(
    "two channels with one label",
    '["A", "A"]',
    `{"electrode_positions": {"A": [1, 2, 3]}, ${CAP}}`,
  ),
  locationsCase(
    "an empty label",
    '["A", "", "C"]',
    `{"electrode_positions": {"A": [1, 2, 3], "": [4, 5, 6], "C": [7, 8, 9]}, ${CAP}}`,
  ),
  locationsCase(
    "labels joined by exact text",
    '["\\u00e9", "E", "e\\u0301", "e"]',
    `{"electrode_positions": {"\\u00e9": [1, 2, 3], "e\\u0301": [4, 5, 6], "e": [7, 8, 9]}, ${CAP}}`,
  ),
  locationsCase("positions an empty object", '["A"]', `{"electrode_positions": {}, ${CAP}}`),
  locationsCase("no attributes at all", '["A"]', "{}"),
  locationsCase("positions a number", '["A"]', `{"electrode_positions": 5, ${CAP}}`),
  locationsCase("positions true", '["A"]', `{"electrode_positions": true, ${CAP}}`),
  locationsCase("positions false", '["A"]', `{"electrode_positions": false, ${CAP}}`),
  locationsCase("positions a string", '["A"]', `{"electrode_positions": "A", ${CAP}}`),
  locationsCase("positions an empty array", '["A"]', `{"electrode_positions": [], ${CAP}}`),
  locationsCase(
    "a system that is not text",
    '["A"]',
    '{"electrode_positions": {"A": [1, 2, 3]}, "electrode_coordinate_system": 5, "electrode_coordinate_units": ["mm"]}',
  ),
  locationsCase(
    "a system of whitespace",
    '["A"]',
    '{"electrode_positions": {"A": [1, 2, 3]}, "electrode_coordinate_system": " ", "electrode_coordinate_units": "\\t"}',
  ),
  locationsCase(
    "a system with a line feed and no positions",
    '["A"]',
    '{"electrode_coordinate_system": "Cap\\nTrak", "electrode_coordinate_units": "m\\rm"}',
  ),
  locationsCase(
    "a system with a lone surrogate and no positions",
    '["A"]',
    '{"electrode_positions": null, "electrode_coordinate_system": "\\ud800", "electrode_coordinate_units": "\\udc00"}',
  ),
  locationsCase(
    "a system with a carriage return",
    '["A"]',
    '{"electrode_positions": {"A": [1, 2, 3]}, "electrode_coordinate_system": "Cap\\rTrak", "electrode_coordinate_units": "mm"}',
  ),
  locationsCase(
    "units with a lone surrogate",
    '["A"]',
    '{"electrode_positions": {"A": [1, 2, 3]}, "electrode_coordinate_system": "CapTrak", "electrode_coordinate_units": "m\\ud800"}',
  ),
  locationsCase(
    "a system that is a valid surrogate pair",
    '["A"]',
    '{"electrode_positions": {"A": [1, 2, 3]}, "electrode_coordinate_system": "\\ud83d\\ude00", "electrode_coordinate_units": "mm"}',
  ),
  locationsCase(
    "provenance and other attributes",
    '["A"]',
    `{"electrode_positions": {"A": [1, 2, 3]}, ${CAP}, "electrode_positions_source": "dataset", "electrode_positions_file": "electrodes.tsv", "electrode_coordsystem_file": "coordsystem.json", "sampling_frequency": 250}`,
  ),
  locationsCase("attributes null", '["A"]', "null"),
  locationsCase("attributes a string", '["A"]', '"electrode_positions"'),
  locationsCase("attributes a number", '["A"]', "5"),
  locationsCase("labels empty", "[]", `{"electrode_positions": {"A": [1, 2, 3]}, ${CAP}}`),
  locationsCase("labels null", "null", `{"electrode_positions": {"A": [1, 2, 3]}, ${CAP}}`),
  locationsCase("labels a string", '"A"', `{"electrode_positions": {"A": [1, 2, 3]}, ${CAP}}`),
  locationsCase(
    "a label that is a number",
    '["A", 1]',
    `{"electrode_positions": {"A": [1, 2, 3]}, ${CAP}}`,
  ),
  locationsCase(
    "a label that is a list",
    '["A", ["B"]]',
    `{"electrode_positions": {"A": [1, 2, 3]}, ${CAP}}`,
  ),
  locationsCase(
    "a label that is a boolean",
    '["A", false]',
    `{"electrode_positions": {"A": [1, 2, 3]}, ${CAP}}`,
  ),
  locationsCase(
    "labels with a line feed that is never written",
    '["A\\nB", "C"]',
    `{"electrode_positions": {"C": [1, 2, 3]}, ${CAP}}`,
  ),
  locationsCase(
    "three labels and two entries",
    '["A", "B", "C"]',
    `{"electrode_positions": {"A": [1, 2, 3], "C": [7, 8, 9]}, ${CAP}}`,
  ),
];

const EXTRA_DIGESTS: string[] = [
  digestCase("none", `[${row('"a"', '"none"')}]`),
  digestCase("a digest", `[${row('"a"', JSON.stringify(HEX_B))}]`),
  digestCase("locations NONE", `[${row('"a"', '"NONE"')}]`),
  digestCase("locations None", `[${row('"a"', '"None"')}]`),
  digestCase("locations none and a line feed", `[${row('"a"', '"none\\n"')}]`),
  digestCase("locations a leading space", `[${row('"a"', '" none"')}]`),
  digestCase("locations empty", `[${row('"a"', '""')}]`),
  digestCase("locations 63 digits", `[${row('"a"', JSON.stringify("b".repeat(63)))}]`),
  digestCase("locations 65 digits", `[${row('"a"', JSON.stringify("b".repeat(65)))}]`),
  digestCase("locations uppercase digits", `[${row('"a"', JSON.stringify("B".repeat(64)))}]`),
  digestCase(
    "locations 64 digits and a line feed",
    `[${row('"a"', JSON.stringify(`${HEX_B}\n`))}]`,
  ),
  digestCase("locations prefixed", `[${row('"a"', JSON.stringify(`sha256:${HEX_B}`))}]`),
  digestCase("locations missing", `[${row('"a"', undefined)}]`),
  digestCase("locations null", `[${row('"a"', "null")}]`),
  digestCase("locations a number", `[${row('"a"', "5")}]`),
  digestCase("locations true", `[${row('"a"', "true")}]`),
  digestCase("locations a list", `[${row('"a"', '["none"]')}]`),
  digestCase("locations an object", `[${row('"a"', '{"none": true}')}]`),
  digestCase("no rows", "[]"),
  digestCase("rows null", "null"),
  digestCase("rows a string", '"rows"'),
  digestCase("a row null", `[${row('"a"', '"none"')}, null]`),
  digestCase("a row a number", "[1]"),
  digestCase("a row a list", "[[]]"),
  digestCase("a row a list of four", `[["a", "eeg", "${HEX_A}", "none"]]`),
  digestCase("a row a list beside a good row", `[${row('"a"', '"none"')}, []]`),
  digestCase(
    "path missing",
    `[{"group": "eeg", "content_sha256": "${HEX_A}", "locations": "none"}]`,
  ),
  digestCase("path empty", `[${row('""', '"none"')}]`),
  digestCase("path a number", `[${row("5", '"none"')}]`),
  digestCase("path with a tab", `[${row('"a\\tb"', '"none"')}]`),
  digestCase("path with a line feed", `[${row('"a\\nb"', '"none"')}]`),
  digestCase("path with a carriage return", `[${row('"a\\rb"', '"none"')}]`),
  digestCase("path with a lone surrogate", `[${row('"a\\ud800"', '"none"')}]`),
  digestCase("group empty", `[${row('"a"', '"none"', '""')}]`),
  digestCase("group with a tab", `[${row('"a"', '"none"', '"e\\teg"')}]`),
  digestCase("group with a lone surrogate", `[${row('"a"', '"none"', '"e\\udc00"')}]`),
  digestCase("content uppercase", `[${row('"a"', '"none"', '"eeg"', "A".repeat(64))}]`),
  digestCase("content 63 digits", `[${row('"a"', '"none"', '"eeg"', "a".repeat(63))}]`),
  digestCase(
    "a repeated path",
    `[${row('"a"', '"none"')}, ${row('"a"', JSON.stringify(HEX_B), '"meg"')}]`,
  ),
  digestCase(
    "two fields wrong: the first in order is named",
    `[${row('"a"', '"NONE"', '""', "x")}]`,
  ),
  digestCase(
    "content and locations wrong: content is named",
    `[${row('"a"', '"NONE"', '"eeg"', "x")}]`,
  ),
  digestCase(
    "paths in code point order, given out of order",
    `[${row('"ab"', '"none"', '"eeg"', HEX_B)}, ${row('"a b"', JSON.stringify(HEX_B), '"eeg"', HEX_A)}, ${row('"a/b"', '"none"')}, ${row('"a\\u00e9"', '"none"', '"eeg"', HEX_B)}, ${row('"a"', JSON.stringify(HEX_A))}, ${row('"\\uff61"', '"none"')}, ${row('"\\ud83d\\ude00"', '"none"')}, ${row('"\\ue000"', '"none"')}]`,
  ),
];

const EXTRA_JSON = `{"locations": [${EXTRA_LOCATIONS.join(",\n")}], "digests": [${EXTRA_DIGESTS.join(",\n")}]}`;

interface ExtraCase {
  name: string;
  labels?: unknown;
  attributes?: unknown;
  rows?: unknown;
}

const EXTRA = JSON.parse(EXTRA_JSON) as { locations: ExtraCase[]; digests: ExtraCase[] };

type LocationsAnswer = { text: string; sha256: string } | { refused: true } | { crash: string };

type DigestAnswer =
  | { text: string; digest: string }
  | { refused: true; field: string | undefined }
  | { crash: string };

interface Answers {
  locations: LocationsAnswer[];
  variants: LocationsAnswer[][];
  digests: DigestAnswer[];
  refused_locations: LocationsAnswer[];
  refused_digests: DigestAnswer[];
  extra_locations: LocationsAnswer[];
  extra_digests: DigestAnswer[];
}

/** The module's answer, in the harness's shape. A refusal is a `DerivativeContractError`, nothing else. */
async function moduleLocations(input: {
  labels?: unknown;
  attributes?: unknown;
}): Promise<LocationsAnswer> {
  const given = input as Parameters<typeof storeLocationsText>[0];
  try {
    const text = storeLocationsText(given);
    return { text, sha256: await storeLocationsSha256(given) };
  } catch (error) {
    if (error instanceof DerivativeContractError) return { refused: true };
    throw error;
  }
}

async function moduleDigest(rows: unknown): Promise<DigestAnswer> {
  const given = rows as StoreRowV2[];
  try {
    const text = inputDigestV2Text(given);
    return { text, digest: await inputDigestV2(given) };
  } catch (error) {
    if (error instanceof DerivativeContractError) return { refused: true, field: error.field };
    throw error;
  }
}

const uvAvailable = toolOrFail("uv", spawnSync("uv", ["--version"]).status === 0);

describe.skipIf(!uvAvailable)(
  "the Python implementation agrees on every vector and edge case",
  () => {
    let python: Answers;

    beforeAll(() => {
      const run = spawnSync(
        "uv",
        ["run", "--no-project", "--python", "3.12", "python", "-I", "-c", HARNESS, VECTORS_PATH],
        { input: EXTRA_JSON, encoding: "utf8", timeout: 300_000 },
      );
      if (run.status !== 0) {
        throw new Error(`the Python harness failed (status ${run.status}): ${run.stderr}`);
      }
      python = JSON.parse(run.stdout) as Answers;
    }, 310_000);

    FILE.store_locations.forEach((vector, index) => {
      test(`store locations ${vector.name}: Python, the module and the file give one text and digest`, async () => {
        expect(python.locations[index]).toEqual({ text: vector.text, sha256: vector.sha256 });
        expect(python.locations[index]).toEqual(await moduleLocations(vector));
        // The vector's variants (an empty label for a null one, units that are not text) give the same text.
        const variants = vector.also_with ?? [];
        expect(python.variants[index].length).toBe(variants.length);
        for (const answer of python.variants[index]) {
          expect(answer).toEqual({ text: vector.text, sha256: vector.sha256 });
        }
      });
    });

    FILE.refused.store_locations.forEach((vector, index) => {
      test(`store locations refused, ${vector.name}: Python and the module both refuse`, async () => {
        expect(python.refused_locations[index]).toEqual({ refused: true });
        expect(await moduleLocations(vector)).toEqual({ refused: true });
      });
    });

    FILE.input_digest_v2.forEach((vector, index) => {
      test(`input digest v2 ${vector.name}: Python, the module and the file give one text and digest`, async () => {
        expect(python.digests[index]).toEqual({ text: vector.text, digest: vector.digest });
        expect(python.digests[index]).toEqual(await moduleDigest(vector.rows));
      });
    });

    FILE.refused.input_digest_v2.forEach((vector, index) => {
      test(`input digest v2 refused, ${vector.name}: both refuse with the field ${vector.field}`, async () => {
        expect(python.refused_digests[index]).toEqual({ refused: true, field: vector.field });
        expect(await moduleDigest(vector.rows)).toEqual({ refused: true, field: vector.field });
      });
    });

    EXTRA.locations.forEach((extra, index) => {
      test(`extra locations case, ${extra.name}: Python and the module answer alike`, async () => {
        const answer = python.extra_locations[index];
        expect(answer).not.toHaveProperty("crash");
        expect(answer).toEqual(await moduleLocations(extra));
      });
    });

    EXTRA.digests.forEach((extra, index) => {
      test(`extra input digest case, ${extra.name}: Python and the module answer alike`, async () => {
        const answer = python.extra_digests[index];
        expect(answer).not.toHaveProperty("crash");
        expect(answer).toEqual(await moduleDigest(extra.rows));
      });
    });

    test("the extra cases are not vacuous: the cases that must be accepted and refused are", () => {
      const refusedLocations = EXTRA.locations
        .filter((_, index) => "refused" in python.extra_locations[index])
        .map((extra) => extra.name);
      const acceptedLocations = EXTRA.locations
        .filter((_, index) => "text" in python.extra_locations[index])
        .map((extra) => extra.name);
      expect(refusedLocations).toEqual([
        "positions a number",
        "positions true",
        "positions false",
        "positions a string",
        "positions an empty array",
        "a system with a carriage return",
        "units with a lone surrogate",
        "attributes null",
        "attributes a string",
        "attributes a number",
        "labels empty",
        "labels null",
        "labels a string",
        "a label that is a number",
        "a label that is a list",
        "a label that is a boolean",
      ]);
      expect(acceptedLocations.length + refusedLocations.length).toBe(EXTRA.locations.length);
      expect(acceptedLocations).toContain("a system with a line feed and no positions");
      expect(acceptedLocations).toContain("a system with a lone surrogate and no positions");
      expect(acceptedLocations).toContain("a system that is a valid surrogate pair");
      const acceptedDigests = EXTRA.digests
        .filter((_, index) => "text" in python.extra_digests[index])
        .map((extra) => extra.name);
      expect(acceptedDigests).toEqual([
        "none",
        "a digest",
        "paths in code point order, given out of order",
      ]);
    });

    test("Python reads the vectors' hard cases as the definition says", () => {
      const at = (name: string) => FILE.store_locations.findIndex((vector) => vector.name === name);
      const zeros = python.locations[at("zeros and integers")];
      expect("text" in zeros && zeros.text).not.toContain("8000000000000000");
      const entries = python.locations[at("entries with no position")];
      expect(
        "text" in entries && entries.text.split("\n").filter((l) => l !== "position").length,
      ).toBe(
        // the header, system, units, one located channel, and the empty last line
        5,
      );
      const huge = python.locations[at("an integer too large for binary64")];
      expect("text" in huge && huge.text.split("\n").slice(3, 5)).toEqual([
        "position",
        "position 3ff8000000000000 4004000000000000 400c000000000000",
      ]);
    });
  },
);
