/**
 * The CLI says how many calls locking a large dataset takes (`nemar admin publish next`'s size
 * line, ADR 0102), and it counts them at `OBJECTS_PER_LOCK_CALL` objects a call. The Worker locks
 * that many per call: `OBJECT_LOCK_BATCH_SIZE`, the default of `applyObjectLockBatch`'s
 * `batchSize`. The CLI does not import the backend, so the number is declared on both sides, and
 * this test is what stops them drifting: changing either alone turns it red.
 */

import { describe, expect, test } from "bun:test";
import { OBJECT_LOCK_BATCH_SIZE } from "../backend/src/services/s3";
import { OBJECTS_PER_LOCK_CALL, sizeLine } from "../src/lib/publication-review-next";

describe("the lock batch size the CLI quotes is the one the Worker uses", () => {
  test("OBJECTS_PER_LOCK_CALL equals the Worker's OBJECT_LOCK_BATCH_SIZE", () => {
    expect(OBJECTS_PER_LOCK_CALL).toBe(OBJECT_LOCK_BATCH_SIZE);
  });

  test("the number is a positive whole count of objects, and the size line divides by it", () => {
    expect(Number.isInteger(OBJECT_LOCK_BATCH_SIZE)).toBe(true);
    expect(OBJECT_LOCK_BATCH_SIZE).toBeGreaterThan(0);
    const files = OBJECT_LOCK_BATCH_SIZE * 60 + 1;
    expect(sizeLine(files)).toContain(`${files.toLocaleString("en-US")} files`);
    expect(sizeLine(files)).toContain("about 61 calls");
  });
});
