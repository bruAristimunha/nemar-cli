/**
 * Chunk-aware presence through the Worker entry points: compareManifestToListing
 * and computeVersionIntegrity (services/import-integrity.ts), which feed
 * `data_complete`, `bytes_present` and the availability report.
 *
 * nm000276 (chunk=1GiB) showed "incomplete" because its chunk objects never matched
 * a plain key (#1565). The grammar and the presence rules are shared with the CLI
 * and covered in test/annex-key.unit.test.ts; this file proves the Worker reaches
 * them, and pins what the Worker adds: which keys are missing, which are zero-byte,
 * and what the byte totals count.
 */

import { describe, expect, test } from "bun:test";
import {
  BASE_EEG,
  type Entries,
  GiB,
  LAST,
  MiB512,
  chunk,
  chunkAt,
  complete1G,
} from "../../test/helpers/chunked-keys";
import {
  compareManifestToListing,
  computeVersionIntegrity,
} from "../src/services/import-integrity";

/** BASE_EEG at 512 MiB, first two of five chunks: an attempt that stopped. */
const partial512 = (): Entries => [
  [chunkAt(2500000000, MiB512, 1), MiB512],
  [chunkAt(2500000000, MiB512, 2), MiB512],
];

describe("compareManifestToListing with chunked content", () => {
  test("a fully chunked dataset is complete", () => {
    const manifest = {
      "sub-01/ieeg/a.vhdr": { key: "SHA256E-s982--ba3d.vhdr", size: 982 },
      "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 },
      README: { key: "git:0123", size: 10 },
    };
    const existing = new Map<string, number>([
      ["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982],
      ...complete1G(),
    ]);
    const r = compareManifestToListing(manifest, existing);
    expect(r).toMatchObject({ complete: true, missingKeys: [], expectedCount: 2, presentCount: 2 });
  });

  test("a wrong-size plain object over complete chunks is missing, and zero-byte only at 0", () => {
    // A plain object that exists decides the answer, so the chunks beside it do not
    // rescue it, and the #967 zero-byte distinction is the plain object's own.
    const manifest = { "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 } };
    const cases: [number, string[]][] = [
      [0, [BASE_EEG]],
      [7, []],
      [2500000001, []],
    ];
    for (const [plainSize, zeroByteKeys] of cases) {
      const listing = new Map<string, number>([[BASE_EEG, plainSize], ...complete1G()]);
      expect(compareManifestToListing(manifest, listing)).toMatchObject({
        complete: false,
        missingKeys: [BASE_EEG],
        zeroByteKeys,
      });
    }
  });

  test("a dataset missing one chunk is still incomplete, naming the whole-file key", () => {
    const manifest = { "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 } };
    const existing = new Map([
      [chunk(1), GiB],
      [chunk(3), LAST],
    ]);
    const r = compareManifestToListing(manifest, existing);
    expect(r.complete).toBe(false);
    expect(r.missingKeys).toEqual([BASE_EEG]);
  });
});

describe("computeVersionIntegrity with a chunked listing", () => {
  const files = {
    "sub-01/ieeg/a.vhdr": { key: "SHA256E-s982--ba3d.vhdr", size: 982 },
    "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 },
    README: { key: "git:0123", size: 10 },
  };
  const vhdrChunk: Entries = [["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982]];

  test("a chunked dataset is complete, with every chunk byte counted as present", () => {
    const listing = new Map<string, number>([...vhdrChunk, ...complete1G()]);
    const r = computeVersionIntegrity({ version: "1.0.0", files }, listing);
    expect(r).toMatchObject({
      complete: true,
      expectedCount: 2,
      presentCount: 2,
      missingKeys: [],
      bytesPresent: 982 + 2500000000,
      declaredBytes: 982 + 2500000000 + 10,
      declaredFiles: 3,
    });
  });

  test("a missing chunk makes it incomplete; the chunks that are there still count as bytes", () => {
    const listing = new Map<string, number>([...vhdrChunk, ...complete1G().slice(0, 2)]);
    const r = computeVersionIntegrity({ version: "1.0.0", files }, listing);
    expect(r).toMatchObject({
      complete: false,
      expectedCount: 2,
      presentCount: 1,
      missingKeys: [BASE_EEG],
      bytesPresent: 982 + 2 * GiB,
    });
  });

  test("bytesPresent counts every stored byte, so two co-existing chunkings both count", () => {
    // INTENDED. bytesPresent is the physical content under <id>/objects/ (what the
    // bucket holds and bills), distinct from declaredBytes, the logical size. A
    // finished 1 GiB chunking beside an abandoned 512 MiB attempt stores both, so
    // both are counted. Completeness is a separate question and stays true.
    const listing = new Map<string, number>([...vhdrChunk, ...partial512(), ...complete1G()]);
    const r = computeVersionIntegrity({ version: "1.0.0", files }, listing);
    expect(r.complete).toBe(true);
    expect(r.bytesPresent).toBe(982 + 2 * MiB512 + 2500000000);
    expect(r.declaredBytes).toBe(982 + 2500000000 + 10);
  });
});
