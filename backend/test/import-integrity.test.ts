/**
 * Tests for the per-key S3 integrity primitive (epic #967 Phase 2, #969):
 * annexKeyDeclaredSize / isKeyPresentAtDeclaredSize (re-exports of the one
 * definition in shared/annex-key.ts, which the CLI's src/lib/s3-server-copy.ts
 * shares) and the pure manifest-vs-listing comparison, compareManifestToListing.
 * No mocks -- these are pure functions over plain data. Chunked keys are covered
 * in import-integrity-chunked.test.ts and test/annex-key.unit.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  annexKeyDeclaredSize,
  compareManifestToListing,
  computeVersionIntegrity,
  isKeyPresentAtDeclaredSize,
  parseManifestFiles,
} from "../src/services/import-integrity";

describe("annexKeyDeclaredSize", () => {
  test("extracts the declared size from an annex key", () => {
    expect(annexKeyDeclaredSize("SHA256E-s10565888--abc123.edf")).toBe(10565888);
    expect(annexKeyDeclaredSize("MD5E-s42--deadbeef.tsv")).toBe(42);
  });

  test("returns 0 (not null) for a genuinely-declared-empty file", () => {
    expect(annexKeyDeclaredSize("SHA256E-s0--abc123.json")).toBe(0);
  });

  test("returns null for a git-backed (non-annex) key", () => {
    expect(annexKeyDeclaredSize("git:abcdef1234567890")).toBeNull();
  });

  test("returns null for a key with no size pattern", () => {
    expect(annexKeyDeclaredSize("not-a-key")).toBeNull();
  });
});

describe("isKeyPresentAtDeclaredSize", () => {
  test("true when present at the exact declared size", () => {
    const existing = new Map([["SHA256E-s100--abc.edf", 100]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s100--abc.edf", existing)).toBe(true);
  });

  test("false when absent entirely", () => {
    expect(isKeyPresentAtDeclaredSize("SHA256E-s100--abc.edf", new Map())).toBe(false);
  });

  test("false when present but 0 bytes with a nonzero declared size (the #967 bug)", () => {
    const existing = new Map([["SHA256E-s100--abc.edf", 0]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s100--abc.edf", existing)).toBe(false);
  });

  test("false when present at the wrong (truncated) size", () => {
    const existing = new Map([["SHA256E-s100--abc.edf", 63]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s100--abc.edf", existing)).toBe(false);
  });

  test("true for a declared-0 file present at 0 bytes (not flagged)", () => {
    const existing = new Map([["SHA256E-s0--abc.json", 0]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s0--abc.json", existing)).toBe(true);
  });

  test("presence alone suffices for a git-backed key (no declared size)", () => {
    const existing = new Map([["git:abcdef", 512]]);
    expect(isKeyPresentAtDeclaredSize("git:abcdef", existing)).toBe(true);
  });
});

describe("compareManifestToListing", () => {
  // `expectedCount: 0` alongside `complete: false` is the wire signal for "there
  // was nothing to check", and `nemar admin import verify` branches on exactly
  // that to say "not verifiable" rather than "0/0 objects missing", which reads
  // as a verdict on the data (ADR 0054). Keep the pair intact.
  test("expected null (no published manifest) -> conservatively not complete", () => {
    const result = compareManifestToListing(null, new Map([["a", 1]]));
    expect(result).toEqual({
      complete: false,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 0,
      presentCount: 1,
    });
  });

  test("everything present at declared size -> complete", () => {
    const expected = {
      "sub-01/eeg/data.edf": { key: "SHA256E-s100--aaa.edf", size: 100 },
      "dataset_description.json": { key: "git:deadbeef", size: 42 },
    };
    const existing = new Map([["SHA256E-s100--aaa.edf", 100]]);
    const result = compareManifestToListing(expected, existing);
    expect(result.complete).toBe(true);
    expect(result.missingKeys).toEqual([]);
    expect(result.zeroByteKeys).toEqual([]);
    expect(result.expectedCount).toBe(1); // git: entry excluded from the annex-expected set
    expect(result.presentCount).toBe(1);
  });

  test("a 0-byte present key with nonzero declared size is missing AND zero-byte", () => {
    const expected = { "sub-01/eeg/data.edf": { key: "SHA256E-s100--aaa.edf", size: 100 } };
    const existing = new Map([["SHA256E-s100--aaa.edf", 0]]);
    const result = compareManifestToListing(expected, existing);
    expect(result.complete).toBe(false);
    expect(result.missingKeys).toEqual(["SHA256E-s100--aaa.edf"]);
    expect(result.zeroByteKeys).toEqual(["SHA256E-s100--aaa.edf"]);
  });

  test("an absent key is missing but NOT zero-byte (never landed at all)", () => {
    const expected = { "sub-01/eeg/data.edf": { key: "SHA256E-s100--aaa.edf", size: 100 } };
    const result = compareManifestToListing(expected, new Map());
    expect(result.complete).toBe(false);
    expect(result.missingKeys).toEqual(["SHA256E-s100--aaa.edf"]);
    expect(result.zeroByteKeys).toEqual([]);
  });

  test("a wrong-size (truncated, nonzero) present key is missing but not zero-byte", () => {
    const expected = { "sub-01/eeg/data.edf": { key: "SHA256E-s100--aaa.edf", size: 100 } };
    const existing = new Map([["SHA256E-s100--aaa.edf", 63]]);
    const result = compareManifestToListing(expected, existing);
    expect(result.missingKeys).toEqual(["SHA256E-s100--aaa.edf"]);
    expect(result.zeroByteKeys).toEqual([]);
  });

  test("a declared-0 file present at 0 bytes is complete, not flagged", () => {
    const expected = { "sub-01/eeg/empty.json": { key: "SHA256E-s0--aaa.json", size: 0 } };
    const existing = new Map([["SHA256E-s0--aaa.json", 0]]);
    const result = compareManifestToListing(expected, existing);
    expect(result.complete).toBe(true);
    expect(result.missingKeys).toEqual([]);
    expect(result.zeroByteKeys).toEqual([]);
  });

  test("git:-keyed entries never appear in expectedCount/missingKeys even when 'missing'", () => {
    const expected = { "README.md": { key: "git:deadbeef", size: 12 } };
    const result = compareManifestToListing(expected, new Map());
    expect(result.expectedCount).toBe(0);
    expect(result.complete).toBe(true); // nothing annex-keyed to check
    expect(result.missingKeys).toEqual([]);
  });

  test("mixed manifest: only the missing annex keys are reported", () => {
    const expected = {
      "sub-01/eeg/a.edf": { key: "SHA256E-s10--a.edf", size: 10 },
      "sub-02/eeg/b.edf": { key: "SHA256E-s20--b.edf", size: 20 },
      "sub-03/eeg/c.edf": { key: "SHA256E-s0--c.edf", size: 0 },
      "README.md": { key: "git:cafebabe", size: 5 },
    };
    const existing = new Map([
      ["SHA256E-s10--a.edf", 10],
      ["SHA256E-s20--b.edf", 0], // corrupt leftover
      ["SHA256E-s0--c.edf", 0], // genuinely empty, fine
    ]);
    const result = compareManifestToListing(expected, existing);
    expect(result.complete).toBe(false);
    expect(result.expectedCount).toBe(3);
    expect(result.presentCount).toBe(2);
    expect(result.missingKeys).toEqual(["SHA256E-s20--b.edf"]);
    expect(result.zeroByteKeys).toEqual(["SHA256E-s20--b.edf"]);
  });
});

describe("parseManifestFiles", () => {
  test("returns the files map when present", () => {
    const json = JSON.stringify({
      dataset_id: "on000001",
      files: { "sub-01/eeg/a.edf": { key: "SHA256E-s10--a.edf", size: 10 } },
    });
    expect(parseManifestFiles(json)).toEqual({
      "sub-01/eeg/a.edf": { key: "SHA256E-s10--a.edf", size: 10 },
    });
  });

  test("returns null for unparseable JSON (not {})", () => {
    expect(parseManifestFiles("not json")).toBeNull();
    expect(parseManifestFiles("")).toBeNull();
  });

  test("returns null for a manifest that parses but has no 'files' key (not {}) -- the bug this guards", () => {
    // Before the fix, `parsed.files ?? {}` turned this into an empty expected
    // set, which compareManifestToListing reports as complete:true --
    // exactly wrong for a malformed manifest.
    const json = JSON.stringify({ dataset_id: "on000001", version: "1.0.0" });
    expect(parseManifestFiles(json)).toBeNull();
  });

  test("returns null when files is explicitly null", () => {
    const json = JSON.stringify({ dataset_id: "on000001", files: null });
    expect(parseManifestFiles(json)).toBeNull();
  });

  test("returns {} when files is explicitly an empty object (genuinely zero files, distinct from missing)", () => {
    const json = JSON.stringify({ dataset_id: "on000001", files: {} });
    expect(parseManifestFiles(json)).toEqual({});
  });
});

describe("computeVersionIntegrity (#970, epic #967 Phase 3)", () => {
  test("declaredBytes/declaredFiles sum EVERY manifest entry, annex AND git:-keyed", () => {
    // The honest logical size must include git:-keyed text files too --
    // compareManifestToListing's expectedCount excludes them (they're never
    // copied to S3), but the size total is the full dataset content.
    const files = {
      "sub-01/eeg/a.edf": { key: "SHA256E-s100--aaa.edf", size: 100 },
      "sub-02/eeg/b.edf": { key: "SHA256E-s200--bbb.edf", size: 200 },
      "dataset_description.json": { key: "git:deadbeef", size: 42 },
    };
    const existing = new Map([
      ["SHA256E-s100--aaa.edf", 100],
      ["SHA256E-s200--bbb.edf", 200],
    ]);
    const result = computeVersionIntegrity({ version: "1.0.0", files }, existing);
    expect(result.declaredBytes).toBe(342);
    expect(result.declaredFiles).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.version).toBe("1.0.0");
  });

  test("bytesPresent sums the live S3 listing regardless of declared-size match", () => {
    const files = { "sub-01/eeg/a.edf": { key: "SHA256E-s100--aaa.edf", size: 100 } };
    // Present at the wrong (truncated) size -- still counted in bytesPresent,
    // even though it fails the declared-size completeness check.
    const existing = new Map([["SHA256E-s100--aaa.edf", 63]]);
    const result = computeVersionIntegrity({ version: "1.0.0", files }, existing);
    expect(result.bytesPresent).toBe(63);
    expect(result.complete).toBe(false);
  });

  test("a 0-byte object makes data_complete (complete) false via the declared-size mismatch", () => {
    const files = { "sub-01/eeg/a.edf": { key: "SHA256E-s100--aaa.edf", size: 100 } };
    const existing = new Map([["SHA256E-s100--aaa.edf", 0]]);
    const result = computeVersionIntegrity({ version: "1.0.0", files }, existing);
    expect(result.complete).toBe(false);
    expect(result.zeroByteKeys).toEqual(["SHA256E-s100--aaa.edf"]);
    expect(result.bytesPresent).toBe(0);
  });

  test("a declared-0 file present at 0 bytes is NOT flagged and stays complete", () => {
    const files = { "sub-01/eeg/empty.json": { key: "SHA256E-s0--aaa.json", size: 0 } };
    const existing = new Map([["SHA256E-s0--aaa.json", 0]]);
    const result = computeVersionIntegrity({ version: "1.0.0", files }, existing);
    expect(result.complete).toBe(true);
    expect(result.missingKeys).toEqual([]);
    expect(result.zeroByteKeys).toEqual([]);
    expect(result.declaredBytes).toBe(0);
    expect(result.declaredFiles).toBe(1);
  });

  test("no manifest (null) -> version:null, zero declared totals, so callers fall back to the S3 sum", () => {
    const result = computeVersionIntegrity(null, new Map([["a", 100]]));
    expect(result.version).toBeNull();
    expect(result.declaredBytes).toBe(0);
    expect(result.declaredFiles).toBe(0);
    // bytesPresent still reflects the real listing -- only the "honest size"
    // half is withheld, not the presence data.
    expect(result.bytesPresent).toBe(100);
    expect(result.complete).toBe(false); // conservative default from compareManifestToListing
  });

  test("version is echoed back only when a manifest object was actually passed", () => {
    const files = { a: { key: "git:x", size: 1 } };
    const withManifest = computeVersionIntegrity({ version: "2.0.0", files }, new Map());
    expect(withManifest.version).toBe("2.0.0");
    const withoutManifest = computeVersionIntegrity(null, new Map());
    expect(withoutManifest.version).toBeNull();
  });

  test("empty dataset (files: {} -- genuinely zero files) is complete with zero totals", () => {
    const result = computeVersionIntegrity({ version: "1.0.0", files: {} }, new Map());
    expect(result.complete).toBe(true);
    expect(result.declaredBytes).toBe(0);
    expect(result.declaredFiles).toBe(0);
    expect(result.version).toBe("1.0.0");
  });
});
