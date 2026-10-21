/**
 * Golden coverage for `shared/bytes.ts`'s `formatBytesTrimmed` (moved from
 * `src/lib/bids-validator.ts`'s module-private `formatBytes` in the epic
 * #1225 phase 4 consolidation, issue #1227).
 *
 * `formatBytesTrimmed` has no dedicated CLI entry point of its own, so per
 * .rules/testing.md ("test the entry point, not the piece") this drives it
 * through the real consumer, `formatValidationResult`, and reads the
 * "Size:" line of the rendered report exactly as `nemar dataset validate`
 * prints it.
 *
 * The expected strings below were computed independently against a verbatim
 * copy of the pre-consolidation formatter and cross-checked by running the
 * real function in this worktree before any implementation change landed --
 * see the phase 4 implementation brief on issue #1227 for the full
 * six-formatter table this is one column of.
 *
 * The 1 PiB case pins a real bug that this phase fixes (issue #1227 step
 * 3): the pre-consolidation formatter had no index clamp, so at 1 PiB and
 * above `sizes[i]` was `undefined` and the line read "Size: 1 undefined".
 * This is a golden expectation this phase's consolidation commit is allowed
 * to change (the sanctioned exception the implementation brief calls out)
 * -- it now pins the FIXED, clamped value. Every value below 1 PiB is
 * unaffected by the fix and unchanged from the first commit.
 *
 * The +Infinity bad-input case ALSO changes, as a side effect of the same
 * clamp, and was not called out by the brief -- discovered by running this
 * test after the fix landed. `Math.min(Infinity, maxIndex)` clamps to
 * `maxIndex` (unlike `Math.min(NaN, maxIndex)`, which stays `NaN`), so
 * +Infinity moves from "NaN undefined" to "Infinity TB", matching
 * `formatBytesCli`'s (unchanged) +Infinity behavior. See the dedicated test
 * below for the full explanation; reported in the PR body.
 */

import { describe, expect, test } from "bun:test";
import type { BidsValidationResult } from "../src/lib/bids-validator";
import { formatValidationResult } from "../src/lib/bids-validator";

function resultWithSize(size: number): BidsValidationResult {
  return {
    valid: true,
    issues: [],
    codeMessages: {},
    summary: {
      sessions: [],
      subjects: [],
      tasks: [],
      modalities: [],
      totalFiles: 1,
      size,
      dataProcessed: true,
      schemaVersion: "1.0.0",
    },
    errorCount: 0,
    warningCount: 0,
    validatorVersion: "3.0.2",
  };
}

/** Extract the "Size: X" summary line rendered by formatValidationResult. */
function sizeLine(size: number): string {
  const text = formatValidationResult(resultWithSize(size), false);
  const line = text.split("\n").find((l) => l.startsWith("  Size:"));
  if (line === undefined) throw new Error("Size line not found in report");
  return line.replace("  Size: ", "");
}

describe("formatBytesTrimmed (via formatValidationResult)", () => {
  test("golden vector — phase 4 pinned magnitudes (issue #1227)", () => {
    expect(sizeLine(0)).toBe("0 B");
    expect(sizeLine(1)).toBe("1 B");
    expect(sizeLine(512)).toBe("512 B");
    expect(sizeLine(1023)).toBe("1023 B");
    expect(sizeLine(1024)).toBe("1 KB");
    expect(sizeLine(1536)).toBe("1.5 KB");
    expect(sizeLine(1048576)).toBe("1 MB");
    expect(sizeLine(1073741824)).toBe("1 GB");
    expect(sizeLine(4628000000)).toBe("4.31 GB");
    expect(sizeLine(24000000000)).toBe("22.35 GB");
    expect(sizeLine(1099511627776)).toBe("1 TB");
  });

  test("1 PiB: index clamp fix (issue #1227 step 3)", () => {
    // 1024**5. The pre-consolidation formatter had no clamp and produced
    // "1 undefined" here (see git history / the phase 4 first commit).
    // formatBytesTrimmed clamps like every other formatter in
    // shared/bytes.ts, so this now matches formatFileSize's clamped 1 PiB
    // value ("1024 TB").
    expect(sizeLine(1024 ** 5)).toBe("1024 TB");
  });

  test("+Infinity: also picks up the clamp, matching formatBytesCli", () => {
    // A second, non-obvious consequence of the same clamp: Math.log(Infinity)
    // is Infinity (not NaN), so Math.min(Infinity, maxIndex) clamps to
    // maxIndex instead of staying Infinity. Pre-fix this produced
    // "NaN undefined" (bytes / BASE**Infinity = Infinity / Infinity = NaN);
    // post-fix bytes / BASE**4 stays a finite-looking Infinity, so the line
    // now reads "Infinity TB" -- exactly what formatBytesCli already
    // produced for +Infinity before this phase (it always had this same
    // clamp). This was discovered by this golden test, not predicted by the
    // implementation brief; called out explicitly in the PR body.
    expect(sizeLine(Number.POSITIVE_INFINITY)).toBe("Infinity TB");
  });

  test("bad inputs (unaffected by the clamp fix)", () => {
    // Math.min(NaN, ...) is NaN, so the clamp added for the 1 PiB fix does
    // not touch these -- pinned here so a future change is visible.
    expect(sizeLine(-1)).toBe("NaN undefined");
    expect(sizeLine(Number.NaN)).toBe("NaN undefined");
  });
});
