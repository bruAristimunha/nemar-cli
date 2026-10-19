/**
 * Where the owner's switch for the automatic review requirement is set, and where it is not
 * (ADR 0107).
 *
 * `PR_REVIEW_AUTO_REQUIRE` is absent from `[vars]` and from every `[env.*.vars]` block, so this
 * file turns it on nowhere. The owner turns it on, in a reviewed change to this file, when the
 * fleet step of the rollout starts; until then no automatic path puts the review ruleset on a
 * repository. A line added to a vars block by any other change would turn it on somewhere nobody
 * decided it should be, and that is what this test refuses.
 *
 * The test reads the real file and parses it with Bun's TOML parser, as
 * publication-review-flag.test.ts does, so a misplaced line (under another table) fails here.
 * It covers the file and nothing else. The switch can also be set as a Worker secret: a secret
 * survives `wrangler deploy` and does not show in the file, so this test cannot see one, and a
 * green run is not proof that the switch is off in an environment. What the Worker reads is the
 * `auto_require` field of the review-ruleset answers (`nemar admin fleet require-review
 * <dataset-id> --json`, a dry run). A variable set only in the Cloudflare dashboard is the one
 * the next deploy drops, which is why the owner's change is made in this file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAutoRequireEnabled } from "../src/services/pr-review-eligibility";

type VarsBlock = Record<string, unknown>;

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { vars?: VarsBlock; env?: Record<string, { vars?: VarsBlock }> };

const SWITCH = "PR_REVIEW_AUTO_REQUIRE";

/** Every vars block the file declares, named as wrangler names it. */
function varsBlocks(): Array<[string, VarsBlock | undefined]> {
  return [
    ["[vars]", config.vars],
    ...Object.entries(config.env ?? {}).map(
      ([name, env]) => [`[env.${name}.vars]`, env.vars] as [string, VarsBlock | undefined],
    ),
  ];
}

describe("backend/wrangler-sccn.toml and the automatic requirement switch", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
    expect(varsBlocks().map(([name]) => name)).toContain("[env.dev.vars]");
  });

  // PR_REVIEW_ENABLED is deliberately not pinned here. The last step of a rollback switches the
  // review off (ADR 0107), and a pin would fail this test, and so the deploy's test gate, on the
  // change that does it. The checks above already keep the guard from being vacuous.

  test("the switch is in no vars block, so the file turns it on nowhere", () => {
    const setIn = varsBlocks()
      .filter(([, vars]) => Object.keys(vars ?? {}).includes(SWITCH))
      .map(([name]) => name);
    expect(setIn).toEqual([]);
  });

  test("the Worker reads an absent switch as off", () => {
    for (const [name, vars] of varsBlocks()) {
      expect(
        isAutoRequireEnabled({ PR_REVIEW_AUTO_REQUIRE: vars?.[SWITCH] as string | undefined }),
        name,
      ).toBe(false);
    }
  });
});
