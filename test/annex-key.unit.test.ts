/**
 * shared/annex-key.ts: the git-annex key grammar and chunk-aware presence.
 *
 * Datasets uploaded through a chunked special remote (nm000276, chunk=1GiB) hold
 * only `<key with -S<size>-C<n>>` objects and never the plain key, which is what
 * made every presence check call them missing (#1565). Every input here is a real
 * `Map` or a real key string; the only subclass is a Map that counts its own scans
 * and probes, so the cost of a lookup can be asserted structurally, not by clock.
 *
 * The callers' entry points are covered where they live:
 * test/chunked-key-availability.unit.test.ts (the CLI) and
 * backend/test/import-integrity-chunked.test.ts (the Worker).
 */

import { describe, expect, test } from "bun:test";
import {
  annexChunkObjectPrefix,
  annexKeyDeclaredSize,
  annexKeyFieldSize,
  findCompleteChunkSet,
  isKeyPresentAtDeclaredSize,
  parseChunkKey,
} from "../shared/annex-key";
import {
  BASE_EEG,
  type Entries,
  GiB,
  LAST,
  MiB512,
  chunk,
  chunkAt,
  complete1G,
} from "./helpers/chunked-keys";

/** Presence of `key` in a listing made of `entries`. */
const present = (key: string, entries: Entries) =>
  isKeyPresentAtDeclaredSize(key, new Map(entries));

/** A real Map that counts how often it is scanned and how often it is probed. */
class CountingMap extends Map<string, number> {
  scans = 0;
  gets = 0;
  override get(key: string) {
    this.gets++;
    return super.get(key);
  }
  override keys() {
    this.scans++;
    return super.keys();
  }
  override values() {
    this.scans++;
    return super.values();
  }
  override entries() {
    this.scans++;
    return super.entries();
  }
  override [Symbol.iterator]() {
    this.scans++;
    return super[Symbol.iterator]();
  }
  override forEach(callback: (value: number, key: string, map: Map<string, number>) => void) {
    this.scans++;
    super.forEach(callback);
  }
}

describe("key grammar", () => {
  test("parseChunkKey recovers the whole-file key", () => {
    expect(parseChunkKey(chunk(3))).toEqual({ baseKey: BASE_EEG, chunkSize: GiB, chunkNumber: 3 });
    expect(parseChunkKey("SHA256E-s982-S1073741824-C1--ba3d.vhdr")).toEqual({
      baseKey: "SHA256E-s982--ba3d.vhdr",
      chunkSize: GiB,
      chunkNumber: 1,
    });
    expect(parseChunkKey("WORM-s5-m1700000000-S4-C2--name.edf")).toEqual({
      baseKey: "WORM-s5-m1700000000--name.edf",
      chunkSize: 4,
      chunkNumber: 2,
    });
    expect(parseChunkKey(BASE_EEG)).toBeNull();
    expect(parseChunkKey("git:abc")).toBeNull();
  });

  test("parseChunkKey reads only the fields before the first --", () => {
    // The same text inside the free-text name is not a chunk.
    expect(parseChunkKey("WORM-m17--x-s5-S4-C1--y")).toBeNull();
    expect(parseChunkKey("SHA256E-s5--a-S4-C1--b.edf")).toBeNull();
    // A zero chunk number or size is not a chunk.
    expect(parseChunkKey("SHA256E-s5-S4-C0--a")).toBeNull();
    expect(parseChunkKey("SHA256E-s5-S0-C1--a")).toBeNull();
    // A pair that is not the last field is not a chunk.
    expect(parseChunkKey("SHA256E-s5-S4-C1-m17--a")).toBeNull();
  });

  test("parseChunkKey rejects a size or number past the safe integers", () => {
    // 2^53 is the first integer parseInt cannot hold exactly.
    expect(parseChunkKey("SHA256E-s5-S9007199254740992-C1--a")).toBeNull();
    expect(parseChunkKey("SHA256E-s5-S4-C9007199254740992--a")).toBeNull();
    expect(parseChunkKey("SHA256E-s5-S99999999999999999999-C1--a")).toBeNull();
    // 2^53 - 1 is the last one it can.
    expect(parseChunkKey("SHA256E-s5-S9007199254740991-C1--a")).toEqual({
      baseKey: "SHA256E-s5--a",
      chunkSize: Number.MAX_SAFE_INTEGER,
      chunkNumber: 1,
    });
  });

  test("chunk discovery prefix and complete geometry match the annex key", () => {
    expect(annexChunkObjectPrefix(BASE_EEG)).toBe("SHA256E-s2500000000-S");
    expect(annexChunkObjectPrefix("git:abc")).toBeNull();
    expect(findCompleteChunkSet(BASE_EEG, new Map(complete1G()), 3)).toEqual({
      chunkSize: GiB,
      totalSize: 2_500_000_000,
      chunks: [
        { name: chunk(1), number: 1, offset: 0, size: GiB },
        { name: chunk(2), number: 2, offset: GiB, size: GiB },
        { name: chunk(3), number: 3, offset: 2 * GiB, size: LAST },
      ],
    });
    expect(findCompleteChunkSet(BASE_EEG, new Map(complete1G()), 2)).toBeNull();
  });

  test("a key whose name contains -- and chunk-shaped text is found by its chunks", () => {
    // The key is split at the FIRST --, and every chunk name is written back with
    // the whole name after it.
    const key = "SHA256E-s5--a--b-S2-C1--c.edf";
    const chunks: Entries = [
      ["SHA256E-s5-S4-C1--a--b-S2-C1--c.edf", 4],
      ["SHA256E-s5-S4-C2--a--b-S2-C1--c.edf", 1],
    ];
    expect(present(key, chunks)).toBe(true);
  });

  test("annexKeyFieldSize reads -s past -m, from the fields only", () => {
    expect(annexKeyFieldSize("SHA256E-s982--ba3d.vhdr")).toBe(982);
    expect(annexKeyFieldSize("WORM-s5-m17--x")).toBe(5);
    expect(annexKeyFieldSize("SHA256E-s0--e.edf")).toBe(0);
    // A -sN inside the free-text name is not a size.
    expect(annexKeyFieldSize("WORM-m17--sub-01-s5--x.edf")).toBeNull();
    expect(annexKeyFieldSize("git:abc")).toBeNull();
    expect(annexKeyFieldSize("SHA256E-s5")).toBeNull();
  });

  test("annexKeyFieldSize rejects a size past the safe integers", () => {
    expect(annexKeyFieldSize("SHA256E-s9007199254740991--a")).toBe(Number.MAX_SAFE_INTEGER);
    expect(annexKeyFieldSize("SHA256E-s9007199254740992--a")).toBeNull();
    expect(annexKeyFieldSize("SHA256E-s99999999999999999999--a")).toBeNull();
  });

  test("annexKeyDeclaredSize keeps its historical contract for a plain key", () => {
    expect(annexKeyDeclaredSize("SHA256E-s982--ba3d.vhdr")).toBe(982);
    // A simple key with an -m field returns null here, so a plain WORM object
    // stays present-if-listed; only the chunk path reads past -m.
    expect(annexKeyDeclaredSize("WORM-s5-m17--x")).toBeNull();
    expect(present("WORM-s5-m17--x", [["WORM-s5-m17--x", 99]])).toBe(true);
  });

  test("annexKeyDeclaredSize scans the whole key: a documented pre-existing exception", () => {
    // Pinned, NOT endorsed. annexKeyDeclaredSize does not stop at the first --, so
    // a -sN-- inside a free-text name is read as a size, where the fields-only
    // reader (the twin of annex_key_size in generate_zarr.py) says there is none.
    // Changing it needs an ADR-level decision and is out of scope for #1565.
    expect(annexKeyDeclaredSize("WORM-m17--sub-01-s5--x.edf")).toBe(5);
    expect(annexKeyFieldSize("WORM-m17--sub-01-s5--x.edf")).toBeNull();
    expect(annexKeyDeclaredSize("WORM-s5-m17--a-s9--b")).toBe(9);
    expect(annexKeyFieldSize("WORM-s5-m17--a-s9--b")).toBe(5);
  });
});

describe("presence of a chunked key (#1565, nm000276)", () => {
  test("a key stored only as complete chunks is present", () => {
    expect(present(BASE_EEG, complete1G())).toBe(true);
    // A one-chunk file (the .vhdr case from the issue).
    expect(
      present("SHA256E-s982--ba3d.vhdr", [["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982]]),
    ).toBe(true);
  });

  test("a chunked key with an -m field needs every chunk at its size", () => {
    const key = "WORM-s10-m1700000000--rec.edf";
    const c = (n: number) => `WORM-s10-m1700000000-S4-C${n}--rec.edf`;
    expect(
      present(key, [
        [c(1), 4],
        [c(2), 4],
        [c(3), 2],
      ]),
    ).toBe(true);
    // C2 missing, then a short last chunk.
    expect(
      present(key, [
        [c(1), 4],
        [c(3), 2],
      ]),
    ).toBe(false);
    expect(
      present(key, [
        [c(1), 4],
        [c(2), 4],
        [c(3), 1],
      ]),
    ).toBe(false);
  });

  test("a missing or short chunk makes the key absent", () => {
    expect(
      present(BASE_EEG, [
        [chunk(1), GiB],
        [chunk(3), LAST],
      ]),
    ).toBe(false);
    expect(
      present(BASE_EEG, [
        [chunk(1), GiB],
        [chunk(2), GiB - 1],
        [chunk(3), LAST],
      ]),
    ).toBe(false);
    expect(
      present(BASE_EEG, [
        [chunk(1), GiB],
        [chunk(2), GiB],
      ]),
    ).toBe(false);
  });

  test("an oversized chunk makes the key absent", () => {
    expect(
      present(BASE_EEG, [
        [chunk(1), GiB],
        [chunk(2), GiB + 1],
        [chunk(3), LAST],
      ]),
    ).toBe(false);
    expect(
      present(BASE_EEG, [
        [chunk(1), GiB],
        [chunk(2), GiB],
        [chunk(3), LAST + 1],
      ]),
    ).toBe(false);
  });

  test("an empty file is one empty chunk 1, not just some chunk of the key", () => {
    const key = "SHA256E-s0--e.edf";
    const at = (n: number) => `SHA256E-s0-S1048576-C${n}--e.edf`;
    expect(present(key, [[at(1), 0]])).toBe(true);
    // Only C2: there is no chunk 1, so the file cannot be reassembled.
    expect(present(key, [[at(2), 0]])).toBe(false);
    // A C1 that is not empty is not an empty file's chunk.
    expect(present(key, [[at(1), 1]])).toBe(false);
    // Nothing of this key at all.
    expect(present(key, [["SHA256E-s9-S4-C1--other.edf", 4]])).toBe(false);
  });

  test("a key with no declared size is never present through chunks", () => {
    const unsized = "SHA256E--nosize.edf";
    expect(present(unsized, [["SHA256E-S4-C1--nosize.edf", 4]])).toBe(false);
    // The plain-object contract for an unsized key is unchanged: present if listed.
    expect(present(unsized, [[unsized, 5]])).toBe(true);
    // A non-annex key absent from the listing is absent, with chunk objects around.
    expect(present("git:abc", [[chunk(1), GiB]])).toBe(false);
  });

  test("another key's chunks do not make this key present", () => {
    expect(present("SHA256E-s2500000000--other.eeg", complete1G())).toBe(false);
    expect(present("SHA256E-s2500000001--abc.eeg", complete1G())).toBe(false);
  });
});

describe("a plain object decides the answer whenever it exists", () => {
  // Chunks are consulted only when the plain object is absent. The data plane serves
  // the plain key, and a short plain object is served as a 200 with truncated
  // bytes, silently, where an absent plain key fails loudly.
  test("a truncated plain object is not rescued by a complete chunk set", () => {
    expect(present(BASE_EEG, [[BASE_EEG, 0], ...complete1G()])).toBe(false);
    expect(present(BASE_EEG, [[BASE_EEG, 7], ...complete1G()])).toBe(false);
    expect(present(BASE_EEG, [[BASE_EEG, 7]])).toBe(false);
  });

  test("an oversized plain object is not rescued by a complete chunk set either", () => {
    expect(present(BASE_EEG, [[BASE_EEG, 2500000001], ...complete1G()])).toBe(false);
  });

  test("a plain object at its declared size is present with or without chunks", () => {
    expect(present(BASE_EEG, [[BASE_EEG, 2500000000]])).toBe(true);
    expect(
      present(BASE_EEG, [
        [BASE_EEG, 2500000000],
        [chunk(1), GiB],
      ]),
    ).toBe(true);
  });
});

describe("chunk geometry", () => {
  test("a size that divides evenly ends in a full chunk, and needs no further one", () => {
    // 2 GiB at 1 GiB is exactly two chunks; there is no zero-byte third.
    const key = `SHA256E-s${2 * GiB}--abc.eeg`;
    const at = (n: number) => chunkAt(2 * GiB, GiB, n);
    expect(
      present(key, [
        [at(1), GiB],
        [at(2), GiB],
      ]),
    ).toBe(true);
    expect(present(key, [[at(1), GiB]])).toBe(false);
    expect(
      present(key, [
        [at(1), GiB],
        [at(2), GiB - 1],
      ]),
    ).toBe(false);
  });

  test("8 bytes at chunk size 4 is C1 and C2 at exactly 4 bytes each", () => {
    const key = "SHA256E-s8--abc.eeg";
    const c = (n: number) => `SHA256E-s8-S4-C${n}--abc.eeg`;
    expect(
      present(key, [
        [c(1), 4],
        [c(2), 4],
      ]),
    ).toBe(true);
    // A zero-byte "remainder" chunk is not what chunking gives an even split.
    expect(
      present(key, [
        [c(1), 4],
        [c(2), 0],
      ]),
    ).toBe(false);
    expect(
      present(key, [
        [c(1), 4],
        [c(2), 3],
      ]),
    ).toBe(false);
    expect(present(key, [[c(1), 4]])).toBe(false);
  });

  test("a chunk set without C1 is absent, whatever else is there", () => {
    expect(
      present(BASE_EEG, [
        [chunk(2), GiB],
        [chunk(3), LAST],
      ]),
    ).toBe(false);
  });

  test("a hole in the middle or a misplaced tail is absent", () => {
    // 3 GiB + 5 bytes at 1 GiB is four chunks: three full and a 5-byte tail.
    const size = 3 * GiB + 5;
    const key = `SHA256E-s${size}--abc.eeg`;
    const c = (n: number) => chunkAt(size, GiB, n);
    expect(
      present(key, [
        [c(1), GiB],
        [c(2), GiB],
        [c(3), GiB],
        [c(4), 5],
      ]),
    ).toBe(true);
    // C3 missing: C1, C2 and the C4 tail are not a file.
    expect(
      present(key, [
        [c(1), GiB],
        [c(2), GiB],
        [c(4), 5],
      ]),
    ).toBe(false);
    // The tail in C3's place, where a full chunk belongs.
    expect(
      present(key, [
        [c(1), GiB],
        [c(2), GiB],
        [c(3), 5],
        [c(4), 5],
      ]),
    ).toBe(false);
  });

  describe("nm000276: s100969566208 at 1 GiB is 95 chunks", () => {
    // The issue lists C1..C94, which is INCOMPLETE: 94 full chunks hold
    // 100,931,731,456 bytes and 37,834,752 remain for C95.
    const NM276 = 100969566208;
    const KEY = `SHA256E-s${NM276}--abc.eeg`;
    const TAIL = 37834752;
    const nm276 = (n: number) => chunkAt(NM276, GiB, n);
    const through = (last: number) =>
      new Map<string, number>(Array.from({ length: last }, (_, i) => [nm276(i + 1), GiB]));

    test("C1..C94 is incomplete, and C95 must be exactly the 37,834,752-byte remainder", () => {
      // Guard the constants, so the vector cannot drift from the issue's numbers.
      expect(94 * GiB + TAIL).toBe(NM276);
      expect(isKeyPresentAtDeclaredSize(KEY, through(94))).toBe(false);
      expect(isKeyPresentAtDeclaredSize(KEY, through(94).set(nm276(95), TAIL))).toBe(true);
      // Every chunk is the chunk size except the last, which holds what is left: a
      // full-size C95 and a C95 one byte short are both wrong.
      expect(isKeyPresentAtDeclaredSize(KEY, through(94).set(nm276(95), GiB))).toBe(false);
      expect(isKeyPresentAtDeclaredSize(KEY, through(94).set(nm276(95), TAIL - 1))).toBe(false);
      // An interior gap: C1..C93 and C95.
      expect(isKeyPresentAtDeclaredSize(KEY, through(93).set(nm276(95), TAIL))).toBe(false);
    });

    test("a chunk past the last is ignored, and does not stand in for it", () => {
      // Chunk C96 is outside the 95 the size calls for. Alongside a complete C1..C95
      // it changes nothing (generate_zarr.py's _complete_chunk_size reads only the
      // chunks the size calls for); without C95 it is no help.
      const stray = through(94).set(nm276(95), TAIL).set(nm276(96), GiB);
      expect(isKeyPresentAtDeclaredSize(KEY, stray)).toBe(true);
      const noTail = through(94).set(nm276(96), TAIL);
      expect(isKeyPresentAtDeclaredSize(KEY, noTail)).toBe(false);
    });
  });
});

describe("two chunk sizes for one key in one listing", () => {
  const SIZE = 2500000000;
  const key = `SHA256E-s${SIZE}--abc.eeg`;
  // 512 MiB chunking is 5 chunks: 4 full and a 352,516,352-byte tail.
  const TAIL512 = SIZE - 4 * MiB512;
  const partial512: Entries = [
    [chunkAt(SIZE, MiB512, 1), MiB512],
    [chunkAt(SIZE, MiB512, 2), MiB512],
  ];
  const complete512: Entries = [
    ...Array.from({ length: 4 }, (_, i): [string, number] => [
      chunkAt(SIZE, MiB512, i + 1),
      MiB512,
    ]),
    [chunkAt(SIZE, MiB512, 5), TAIL512],
  ];
  const partial1G: Entries = [[chunkAt(SIZE, GiB, 1), GiB]];

  test("a partial attempt and a complete set: present in either insertion order", () => {
    expect(present(key, [...partial512, ...complete1G()])).toBe(true);
    expect(present(key, [...complete1G(), ...partial512])).toBe(true);
    expect(present(key, [...partial1G, ...complete512])).toBe(true);
    expect(present(key, [...complete512, ...partial1G])).toBe(true);
  });

  test("two partial attempts: absent in either insertion order", () => {
    expect(present(key, [...partial512, ...partial1G])).toBe(false);
    expect(present(key, [...partial1G, ...partial512])).toBe(false);
  });
});

describe("the listing scan", () => {
  /** 200 distinct keys, none of them in `listing`, each with a declared size. */
  const absentKeys = (count: number) =>
    Array.from({ length: count }, (_, i) => `SHA256E-s${1000 + i}--absent${i}.edf`);

  test("a listing is scanned at most once, however many keys are absent", () => {
    const listing = new CountingMap([["SHA256E-s5--plain.edf", 5], ...complete1G()]);
    for (const key of absentKeys(200)) {
      expect(isKeyPresentAtDeclaredSize(key, listing)).toBe(false);
    }
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, listing)).toBe(true);
    expect(listing.scans).toBe(1);
  });

  test("a listing whose keys are all present as plain objects is never scanned", () => {
    const listing = new CountingMap([
      ["SHA256E-s5--a.edf", 5],
      ["SHA256E-s6--b.edf", 6],
    ]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s5--a.edf", listing)).toBe(true);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s6--b.edf", listing)).toBe(true);
    expect(listing.scans).toBe(0);
  });

  test("the cache belongs to one listing, not to a listing size", () => {
    // Two Maps of equal size. A cache keyed on the size would hand A's answer to B.
    const onlyHalfGiB = (): Entries => [
      [chunkAt(2500000000, MiB512, 1), MiB512],
      [chunkAt(2500000000, MiB512, 2), MiB512],
      [chunkAt(2500000000, MiB512, 3), MiB512],
    ];
    const a = new Map(onlyHalfGiB());
    const b = new Map(complete1G());
    expect(a.size).toBe(b.size);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, a)).toBe(false);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, b)).toBe(true);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, a)).toBe(false);
  });

  test("a chunking that appears after the first lookup is seen", () => {
    // After the first lookup the cache holds only the 512 MiB chunking. Growing the
    // listing with a complete 1 GiB set has to rescan; a cache that never
    // invalidates would nominate only 512 MiB and keep answering absent.
    const listing = new Map<string, number>([[chunkAt(2500000000, MiB512, 1), MiB512]]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, listing)).toBe(false);
    for (const [name, size] of complete1G()) listing.set(name, size);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, listing)).toBe(true);
  });

  test("an edit that keeps the size leaves a stale index, which never reads a key as present", () => {
    // The cache is revalidated by listing size, so swapping one name for another is
    // not noticed. The index only nominates chunk sizes; every chunk is then read
    // from the live Map, so the stale error runs one way: absent, never present.
    const listing = new Map(complete1G());
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, listing)).toBe(true);
    listing.delete(chunk(3));
    listing.set("SHA256E-s9--unrelated.edf", 9);
    expect(listing.size).toBe(3);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, listing)).toBe(false);
  });

  test("a listing with odd names is scanned without losing the chunked key", () => {
    const listing = new Map<string, number>([
      ["SHA256E-s5--plain.edf", 5],
      ["README", 10],
      ["not-an-annex-object", 3],
      // Chunk-shaped names whose size or number is not a safe integer.
      ["SHA256E-s5-S99999999999999999999-C1--x", 5],
      ["SHA256E-s5-S4-C99999999999999999999--x", 4],
      ...complete1G(),
    ]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, listing)).toBe(true);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s7--unrelated.edf", listing)).toBe(false);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s5--x", listing)).toBe(false);
  });

  test("fake chunk sizes minted in the bucket do not multiply the cost of missing keys", () => {
    // Anyone who can write under <id>/objects/ can mint chunk names. 5,000 distinct
    // sizes in the listing must not be 5,000 attempts for each of 5,000 missing keys.
    const listing = new CountingMap();
    for (let i = 1; i <= 5000; i++) listing.set(`SHA256E-s1-S${i}-C1--fake${i}.x`, 1);
    const missing = absentKeys(5000);
    for (const key of missing) {
      expect(isKeyPresentAtDeclaredSize(key, listing)).toBe(false);
    }
    // One probe of the plain key each, no chunk probes, and a single scan.
    expect(listing.gets).toBe(missing.length);
    expect(listing.scans).toBe(1);
  });

  test("the work for one key is bounded by that key's own chunk objects", () => {
    // The same attack aimed at a single key: 5,000 C1 objects of one file at 5,000
    // chunk sizes. That key pays for its own 5,000; no other key pays anything.
    const listing = new CountingMap();
    for (let i = 1; i <= 5000; i++) listing.set(`SHA256E-s1-S${i}-C1--target.x`, 2);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s1--target.x", listing)).toBe(false);
    expect(listing.gets).toBe(1 + 5000);
    const before = listing.gets;
    expect(isKeyPresentAtDeclaredSize("SHA256E-s1--bystander.x", listing)).toBe(false);
    expect(listing.gets - before).toBe(1);
  });
});
