/**
 * `nemar dataset publish request` right after an upload: the two block reasons
 * that mean "BIDS validation has not concluded", as opposed to "it failed".
 *
 * A refusal for either one is a pending state, not an error, so the unit tests
 * here pin which refusals count and what is said about them. The commands'
 * behavior (exit code, streams, text) is driven through the real CLI in
 * test/publish-pending-cli.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api/errors";
import {
  CI_PENDING_BLOCK_REASONS,
  ciPendingHeadline,
  ciPendingHint,
  ciUrlOf,
  isCiPendingBlock,
  isCiPendingReason,
} from "../src/lib/publish-pending";

/** A refusal as the client builds it from a 422 body. */
function refusal(
  reason: string | undefined,
  opts: { status?: number; body?: Record<string, unknown> } = {},
): ApiError {
  const error = new ApiError(
    opts.status ?? 422,
    "BIDS validation has not run yet.",
    undefined,
    undefined,
    reason,
  );
  error.rawBody = opts.body ?? { status: "blocked", block_reason: reason };
  return error;
}

describe("isCiPendingReason", () => {
  test("only the two CI-not-concluded reasons", () => {
    expect(isCiPendingReason("bids_validation_pending")).toBe(true);
    expect(isCiPendingReason("bids_validation_in_progress")).toBe(true);
    for (const other of [
      "bids_validation_failed",
      "min_requirements_failed",
      "owner_name_missing",
      "identifier_screen_findings",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(isCiPendingReason(other)).toBe(false);
    }
  });

  test("the declared set is exactly the two pending reasons", () => {
    expect([...CI_PENDING_BLOCK_REASONS].sort()).toEqual([
      "bids_validation_in_progress",
      "bids_validation_pending",
    ]);
  });
});

describe("isCiPendingBlock", () => {
  test("a recorded 422 block with a pending reason counts", () => {
    expect(isCiPendingBlock(refusal("bids_validation_pending"))).toBe(true);
    expect(isCiPendingBlock(refusal("bids_validation_in_progress"))).toBe(true);
  });

  test("any other reason, status or error does not", () => {
    expect(isCiPendingBlock(refusal("bids_validation_failed"))).toBe(false);
    expect(isCiPendingBlock(refusal("min_requirements_failed"))).toBe(false);
    expect(isCiPendingBlock(refusal("identifier_screen_findings"))).toBe(false);
    expect(isCiPendingBlock(refusal(undefined))).toBe(false);
    expect(isCiPendingBlock(new ApiError(409, "already requested"))).toBe(false);
    expect(isCiPendingBlock(new Error("x"))).toBe(false);
    expect(isCiPendingBlock(undefined)).toBe(false);
  });

  test("the HTTP status matters as well as the reason", () => {
    // The same word on a server fault is not the refusal this recognizes, so it
    // keeps its error treatment and its exit code.
    expect(isCiPendingBlock(refusal("bids_validation_pending", { status: 500 }))).toBe(false);
    expect(isCiPendingBlock(refusal("bids_validation_in_progress", { status: 403 }))).toBe(false);
  });

  test("the body must say it is a recorded block", () => {
    // A 422 that carries a pending-sounding reason but is not a recorded block
    // (no status, or some other status) is not promised a continuation.
    const pending = "bids_validation_pending";
    expect(isCiPendingBlock(refusal(pending, { body: { block_reason: pending } }))).toBe(false);
    expect(
      isCiPendingBlock(refusal(pending, { body: { status: "requested", block_reason: pending } })),
    ).toBe(false);
    const bare = new ApiError(422, "x", undefined, undefined, pending);
    expect(isCiPendingBlock(bare)).toBe(false);
  });
});

describe("ciUrlOf", () => {
  test("returns the link only when it is a plain https URL", () => {
    const link = "https://github.com/nemarDatasets/nm000358/actions";
    expect(ciUrlOf(refusal("bids_validation_pending", { body: { ci_url: link } }))).toBe(link);
    for (const bad of [
      undefined,
      42,
      "",
      "javascript:alert(1)",
      "http://insecure",
      "https://a b",
    ]) {
      expect(
        ciUrlOf(refusal("bids_validation_pending", { body: { ci_url: bad } })),
      ).toBeUndefined();
    }
  });
});

describe("ciPendingHeadline", () => {
  test("says it is recorded, and tells not-started from running in one clause", () => {
    expect(ciPendingHeadline("bids_validation_pending")).toBe(
      "Request recorded: BIDS validation has not started yet.",
    );
    expect(ciPendingHeadline("bids_validation_in_progress")).toBe(
      "Request recorded: BIDS validation is still running.",
    );
  });
});

describe("ciPendingHint", () => {
  test("the full text for a plain request", () => {
    expect(ciPendingHint("nm000358")).toEqual([
      "  Your request is recorded. NEMAR re-checks it automatically and continues once validation passes.",
      "  If you would rather not wait for that, check validation with: nemar dataset ci nm000358",
      "  Once it has passed, request again: nemar dataset publish request nm000358",
      "  If it says a request already exists, nothing more is needed.",
      "  If validation fails or a submission minimum fails, the request stays blocked and nothing is emailed:",
      "  check nemar dataset ci nm000358 or nemar dataset publish status nm000358.",
    ]);
  });

  test("an anonymous request gets the flag back on the one command that is a request", () => {
    // Asking again without --anonymous is a normal publication request, so the
    // flag is on the request command and on no other line.
    const lines = ciPendingHint("nm000358", true);
    expect(lines[2]).toBe(
      "  Once it has passed, request again: nemar dataset publish request nm000358 --anonymous",
    );
    expect(lines.filter((line) => line.includes("--anonymous"))).toHaveLength(1);
    expect(ciPendingHint("nm000358", false)).toEqual(ciPendingHint("nm000358"));
  });

  test("it starts by saying a request exists, and promises no time", () => {
    // The headline is on stderr and these lines on stdout, so the first line
    // has to carry that a request exists on its own.
    const lines = ciPendingHint("nm000358");
    expect(lines[0]).toContain("Your request is recorded.");
    expect(lines.join("\n")).not.toMatch(
      /\b(\d+\s*(s|sec|seconds?|min|minutes?|hours?)|daily|hourly)\b/i,
    );
    expect(lines.join("\n")).not.toContain("--wait");
  });
});
