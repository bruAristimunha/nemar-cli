/**
 * Where the publication review's flag is set, and where it is not (ADR 0102).
 *
 * `PUBLICATION_REVIEW_ENABLED` is `1` in `[env.dev.vars]` and absent from `[vars]`, so production is
 * dark and turning it on is a reviewed change to the configuration file. It is never a Worker
 * secret in this file's sense, and `wrangler deploy` replaces the Worker's variables with the ones
 * here, so a dashboard-only value would be dropped by the next deploy.
 *
 * The test reads the real file and parses it with Bun's TOML parser, so a misplaced line (under
 * another table, or commented out) fails here.
 *
 * Production must not be lit until #1604 is fixed in Phase 3: a terminal approval inside a live web
 * lease is attributed to the administrator who clicked (ADR 0080), and has to be attributed to its
 * own caller. Until then the Worker refuses an override sent inside a web approval
 * (`override_inside_web_approval`), which keeps an override from being recorded under another
 * administrator's name but is not the fix.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewEnabled } from "../src/services/publication-review-view";

type VarsBlock = Record<string, unknown>;

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { vars?: VarsBlock; env?: Record<string, { vars?: VarsBlock }> };

describe("backend/wrangler-sccn.toml", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
  });

  test("the flag is on for the dev Worker", () => {
    expect(config.env?.dev?.vars?.PUBLICATION_REVIEW_ENABLED).toBe("1");
    expect(reviewEnabled({ PUBLICATION_REVIEW_ENABLED: "1" })).toBe(true);
  });

  test("the flag is NOT in [vars], so production is dark", () => {
    expect(Object.keys(config.vars ?? {})).not.toContain("PUBLICATION_REVIEW_ENABLED");
    expect(
      reviewEnabled({
        PUBLICATION_REVIEW_ENABLED: config.vars?.PUBLICATION_REVIEW_ENABLED as string | undefined,
      }),
    ).toBe(false);
  });

  test("the flag is in no other environment's vars either", () => {
    // Any other `[env.*.vars]` would turn the review on somewhere nobody decided it should be.
    const where = Object.entries(config.env ?? {})
      .filter(([, env]) => Object.keys(env.vars ?? {}).includes("PUBLICATION_REVIEW_ENABLED"))
      .map(([name]) => name);
    expect(where).toEqual(["dev"]);
  });

  test("the review's flag is a different variable from the pull-request review's", () => {
    // Two flags, two decisions: switching one on must not switch the other.
    expect(Object.keys(config.env?.dev?.vars ?? {})).toContain("PR_REVIEW_ENABLED");
    expect(Object.keys(config.env?.dev?.vars ?? {})).toContain("PUBLICATION_REVIEW_ENABLED");
  });
});

describe("reviewEnabled", () => {
  test("is the word 1 and nothing else", () => {
    for (const value of ["0", "", "true", " 1", "1 ", "yes", "ON", "01", undefined]) {
      expect(reviewEnabled({ PUBLICATION_REVIEW_ENABLED: value }), String(value)).toBe(false);
    }
    expect(reviewEnabled({ PUBLICATION_REVIEW_ENABLED: "1" })).toBe(true);
  });
});
