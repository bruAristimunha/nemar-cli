/**
 * What the relocation pools of the change summary hold, worked out from the rule `buildPools`
 * states (design section 4.6) rather than read from a pool, and JSON documents built to hold a
 * chosen amount: the measure the `maxPoolChars` tests set their inputs by.
 *
 * The rule: a table holds its header and each distinct new row, as the cells joined with tabs; a
 * JSON document holds its top-level keys and, for each new leaf, its path, its value and its key in
 * `byLeaf`. Everything is counted in UTF-16 code units.
 */

import {
  type PoolFile,
  flattenJson,
  leafKey,
  parseJson,
  parseTsv,
} from "../../scripts/ci/pr-review-summary";

/**
 * What `file` holds in the pools on its own. Only for files that parse, as every test input does.
 */
export function poolChars(file: PoolFile): number {
  if (file.path.endsWith(".tsv")) {
    const after = parseTsv(file.after);
    const before = file.before === null ? null : parseTsv(file.before);
    if (!after.ok || (before !== null && !before.ok)) throw new Error(`not a table: ${file.path}`);
    const known = new Map<string, number>();
    if (before?.ok && before.value.header.join("\t") === after.value.header.join("\t")) {
      for (const row of before.value.rows) {
        const text = row.join("\t");
        known.set(text, (known.get(text) ?? 0) + 1);
      }
    }
    const fresh = new Set<string>();
    for (const row of after.value.rows) {
      const text = row.join("\t");
      const have = known.get(text) ?? 0;
      if (have > 0) known.set(text, have - 1);
      else fresh.add(text);
    }
    if (fresh.size === 0) return 0;
    let chars = after.value.header.join("\t").length;
    for (const text of fresh) chars += text.length;
    return chars;
  }
  const after = parseJson(file.after);
  const before = file.before === null ? null : parseJson(file.before);
  if (!after.ok || (before !== null && !before.ok)) throw new Error(`not JSON: ${file.path}`);
  const root = after.value.value;
  let chars = 0;
  if (root.t === "obj") for (const key of root.keys) chars += key.length;
  const had = new Map<string, string>();
  for (const leaf of before?.ok ? (flattenJson(before.value.value) ?? []) : []) {
    had.set(leaf.path, leaf.value);
  }
  const leaves = flattenJson(root);
  if (leaves === null) throw new Error(`a path over maxNameChars: ${file.path}`);
  for (const leaf of leaves) {
    if (had.get(leaf.path) === leaf.value) continue;
    chars += leaf.path.length + leaf.value.length + leafKey(leaf.path, leaf.value).length;
  }
  return chars;
}

/**
 * `{<first>"K...K":{"0":0,"1":0,...}}`: one long key over `leaves` tiny children, the shape that
 * made a few hundred kilobytes of JSON hold hundreds of megabytes. Each leaf repeats the key in its
 * path, so a document holds about 2,000 code units per child for a key of 1,000.
 */
export function longKeyDocument(leaves: number, first = "", key = "K".repeat(1000)): string {
  const children = Array.from({ length: leaves }, (_, i) => `"${i}":0`).join(",");
  return `{${first}"${key}":{${children}}}`;
}

/**
 * An added document that holds exactly `target` code units: a {@link longKeyDocument} of `leaves`
 * children and one padding string, each of whose characters is held twice (in its value and in
 * its `byLeaf` key). The padding key is `P` or `PP`, whichever leaves an even remainder.
 */
export function documentHolding(path: string, target: number, leaves: number): PoolFile {
  for (const name of ["P", "PP"]) {
    const make = (pad: number): PoolFile => ({
      path,
      before: null,
      after: new TextEncoder().encode(longKeyDocument(leaves, `"${name}":"${"x".repeat(pad)}",`)),
    });
    const base = poolChars(make(0));
    if (target < base) throw new Error(`${leaves} children already hold ${base} > ${target}`);
    if ((target - base) % 2 !== 0) continue;
    const file = make((target - base) / 2);
    if (poolChars(file) !== target) throw new Error("the padding is not held twice per character");
    return file;
  }
  throw new Error("unreachable: P and PP differ by an odd amount");
}
