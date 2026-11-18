/**
 * The compute gateway's two dark switches, and where they are NOT set (epic #2005 phase A4, #2009;
 * ADR 0118 decision 8).
 *
 * `COMPUTE_ENABLED`, `COMPUTE_PIPELINES_DISPATCH_ENABLED` and (portable compute, card DM-05)
 * `COMPUTE_RUNNERS_ENABLED` appear in no table of
 * `backend/wrangler-sccn.toml`, so the file turns compute on nowhere. The owner adds them in a
 * reviewed change after the first real job has run by hand; a line added by any other change would
 * turn compute on somewhere nobody decided it should be, and that is what this test refuses. It is
 * pinned until that change, which edits this test.
 *
 * The Tapis credentials and the tenant they name are not in the file either: a tenant name is not
 * public, so they are Worker secrets or owner-set variables, and the file's comment block lists their
 * names only (comments are not parsed, so a name in a comment passes). The same walk covers them.
 *
 * The test reads the real file and parses it with Bun's TOML parser, then walks every table of the
 * parsed document, not only the vars blocks, so a name misplaced under another table (a binding, an
 * observability block) fails here too. It covers the file and nothing else: a Worker secret of the
 * same name also takes effect and does not show in the file, so a green run here is not proof that a
 * switch is off in an environment; `GET /admin/compute/status` reports what the Worker reads.
 *
 * It also pins the switch rule itself, through the real functions: a switch reads as on only as the
 * exact string "1", and only in exactly `production` or `development`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeEnabled,
  computePipelinesDispatchEnabled,
  computeRunnersEnabled,
} from "../src/services/compute-switches";
import type { Bindings } from "../src/types/bindings";

type VarsBlock = Record<string, unknown>;

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { vars?: VarsBlock; env?: Record<string, { vars?: VarsBlock }> };

const SWITCH_NAMES = [
  "COMPUTE_ENABLED",
  "COMPUTE_PIPELINES_DISPATCH_ENABLED",
  // Portable compute (card DM-05, D7): registered runners may exchange a secret and use a token.
  "COMPUTE_RUNNERS_ENABLED",
] as const;

/** The credentials and addresses of the Tapis tenant (and the ACCESS key): secrets, never file text. */
const SECRET_NAMES = [
  "TAPIS_BASE_URL",
  "TAPIS_TENANT_ID",
  "TAPIS_AUTH_STRATEGY",
  "TAPIS_USERNAME",
  "TAPIS_PASSWORD",
  "TAPIS_SERVICE_TOKEN",
  "ACCESS_GATEWAY_ATTRIBUTES_KEY",
  // Epic #2005 phase A8 (#2013): the resource name the ACCESS gateway-attributes interface knows the
  // cluster by, an owner-set value and never a line of the file.
  "ACCESS_RESOURCE_NAME",
  // Epic #2005 phase A5 (#2010): NEMAR's own runtime image for a `python` job, a digest-pinned
  // reference the owner sets, like the Tapis names, and never a line of the file.
  "COMPUTE_RUNTIME_IMAGE",
] as const;

/** The dotted path of every key named in `names`, anywhere in the parsed document. */
function pathsOfNames(names: readonly string[], node: unknown, path = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  const found: string[] = [];
  const entries: Array<[string, unknown]> = Array.isArray(node)
    ? node.map((v, i) => [`[${i}]`, v])
    : Object.entries(node);
  for (const [key, value] of entries) {
    const here = path === "" ? key : Array.isArray(node) ? `${path}${key}` : `${path}.${key}`;
    if (names.includes(key)) found.push(here);
    found.push(...pathsOfNames(names, value, here));
  }
  return found;
}

describe("backend/wrangler-sccn.toml and the compute switches", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
  });

  test("the walk sees a name wherever it is (the walk is not vacuous)", () => {
    expect(
      pathsOfNames(SWITCH_NAMES, {
        a: { b: [{ COMPUTE_ENABLED: "1" }] },
        COMPUTE_PIPELINES_DISPATCH_ENABLED: "1",
        c: { COMPUTE_RUNNERS_ENABLED: "1" },
        COMPUTE_RECORDS_BUCKET_NAME: "not a switch",
      }),
    ).toEqual([
      "a.b[0].COMPUTE_ENABLED",
      "COMPUTE_PIPELINES_DISPATCH_ENABLED",
      "c.COMPUTE_RUNNERS_ENABLED",
    ]);
  });

  test("no switch is set in any table of the file", () => {
    expect(pathsOfNames(SWITCH_NAMES, config)).toEqual([]);
  });

  test("no Tapis credential, tenant address, ACCESS key, ACCESS resource name or runtime image is set in any table of the file", () => {
    expect(pathsOfNames(SECRET_NAMES, config)).toEqual([]);
  });

  test("the compute buckets' names are still set (the same walk finds a name that is there)", () => {
    expect(pathsOfNames(["COMPUTE_RECORDS_BUCKET_NAME"], config)).toEqual([
      "vars.COMPUTE_RECORDS_BUCKET_NAME",
      "env.dev.vars.COMPUTE_RECORDS_BUCKET_NAME",
    ]);
  });
});

/** A binding set as the Worker would read it; `over` replaces a field, `undefined` unsets it. */
function env(over: Record<string, unknown>): Bindings {
  return { ...over } as unknown as Bindings;
}

describe("computeEnabled", () => {
  test("is true only for exactly '1' in exactly production or development", () => {
    expect(computeEnabled(env({ ENVIRONMENT: "production", COMPUTE_ENABLED: "1" }))).toBe(true);
    expect(computeEnabled(env({ ENVIRONMENT: "development", COMPUTE_ENABLED: "1" }))).toBe(true);
  });

  test.each([["true"], [" 1"], ["1 "], ["01"], ["yes"], ["on"], ["0"], [""], ["TRUE"], ["1\n"]])(
    "is false for the switch %p",
    (value) => {
      expect(computeEnabled(env({ ENVIRONMENT: "production", COMPUTE_ENABLED: value }))).toBe(
        false,
      );
      expect(computeEnabled(env({ ENVIRONMENT: "development", COMPUTE_ENABLED: value }))).toBe(
        false,
      );
    },
  );

  test("is false for a value that only converts to '1' (a TOML integer arrives as a number)", () => {
    const converts: unknown[] = [1, true, ["1"], [1], new String("1"), { toString: () => "1" }, 1n];
    for (const value of converts) {
      expect(computeEnabled(env({ ENVIRONMENT: "production", COMPUTE_ENABLED: value }))).toBe(
        false,
      );
      expect(computeEnabled(env({ ENVIRONMENT: "development", COMPUTE_ENABLED: value }))).toBe(
        false,
      );
    }
  });

  test("is false when the switch is unset", () => {
    expect(computeEnabled(env({ ENVIRONMENT: "production" }))).toBe(false);
    expect(computeEnabled(env({ ENVIRONMENT: "production", COMPUTE_ENABLED: undefined }))).toBe(
      false,
    );
  });

  test.each([
    [undefined],
    [""],
    ["staging"],
    ["test"],
    ["Production"],
    ["PRODUCTION"],
    [" production"],
    ["production "],
    ["prod"],
    ["Development"],
    ["development "],
    ["dev"],
  ])("is false for the environment %p even with the switch on", (environment) => {
    expect(computeEnabled(env({ ENVIRONMENT: environment, COMPUTE_ENABLED: "1" }))).toBe(false);
  });

  test("is read at call time, so a changed binding changes the answer", () => {
    const bindings = env({ ENVIRONMENT: "production" });
    expect(computeEnabled(bindings)).toBe(false);
    (bindings as unknown as Record<string, string>).COMPUTE_ENABLED = "1";
    expect(computeEnabled(bindings)).toBe(true);
    (bindings as unknown as Record<string, string>).ENVIRONMENT = "staging";
    expect(computeEnabled(bindings)).toBe(false);
  });
});

describe("computePipelinesDispatchEnabled", () => {
  test("needs the compute switch AND its own, each exactly '1'", () => {
    const on = { ENVIRONMENT: "production", COMPUTE_ENABLED: "1" };
    expect(
      computePipelinesDispatchEnabled(env({ ...on, COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" })),
    ).toBe(true);
    expect(
      computePipelinesDispatchEnabled(
        env({
          ENVIRONMENT: "development",
          COMPUTE_ENABLED: "1",
          COMPUTE_PIPELINES_DISPATCH_ENABLED: "1",
        }),
      ),
    ).toBe(true);
    // Its own switch alone does nothing: turning compute off stops dispatch whatever it says.
    expect(
      computePipelinesDispatchEnabled(
        env({ ENVIRONMENT: "production", COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" }),
      ),
    ).toBe(false);
    expect(
      computePipelinesDispatchEnabled(
        env({
          ENVIRONMENT: "production",
          COMPUTE_ENABLED: "true",
          COMPUTE_PIPELINES_DISPATCH_ENABLED: "1",
        }),
      ),
    ).toBe(false);
    // Compute alone does not dispatch.
    expect(computePipelinesDispatchEnabled(env(on))).toBe(false);
  });

  test.each([["true"], [" 1"], ["yes"], [""], ["0"]])("is false for its own switch %p", (value) => {
    expect(
      computePipelinesDispatchEnabled(
        env({
          ENVIRONMENT: "production",
          COMPUTE_ENABLED: "1",
          COMPUTE_PIPELINES_DISPATCH_ENABLED: value,
        }),
      ),
    ).toBe(false);
  });

  test("is false for a value that only converts to '1', in either switch", () => {
    const converts: unknown[] = [1, true, ["1"], new String("1"), { toString: () => "1" }];
    for (const value of converts) {
      // The compute switch is the string "1"; only the dispatch switch is the odd value.
      expect(
        computePipelinesDispatchEnabled(
          env({
            ENVIRONMENT: "production",
            COMPUTE_ENABLED: "1",
            COMPUTE_PIPELINES_DISPATCH_ENABLED: value,
          }),
        ),
      ).toBe(false);
      // And the dispatch switch is the string "1": only the compute switch is the odd value.
      expect(
        computePipelinesDispatchEnabled(
          env({
            ENVIRONMENT: "production",
            COMPUTE_ENABLED: value,
            COMPUTE_PIPELINES_DISPATCH_ENABLED: "1",
          }),
        ),
      ).toBe(false);
    }
  });

  test("is false outside production and development whatever both switches say", () => {
    for (const environment of [undefined, "staging", "test", "Production"]) {
      expect(
        computePipelinesDispatchEnabled(
          env({
            ENVIRONMENT: environment,
            COMPUTE_ENABLED: "1",
            COMPUTE_PIPELINES_DISPATCH_ENABLED: "1",
          }),
        ),
      ).toBe(false);
    }
  });
});

describe("computeRunnersEnabled", () => {
  const compute = { ENVIRONMENT: "production", COMPUTE_ENABLED: "1" };

  test("needs the compute switch AND its own, each exactly '1', in production or development", () => {
    expect(computeRunnersEnabled(env({ ...compute, COMPUTE_RUNNERS_ENABLED: "1" }))).toBe(true);
    expect(
      computeRunnersEnabled(
        env({ ENVIRONMENT: "development", COMPUTE_ENABLED: "1", COMPUTE_RUNNERS_ENABLED: "1" }),
      ),
    ).toBe(true);
    // Its own switch alone does nothing: turning compute off stops the runners whatever it says.
    expect(
      computeRunnersEnabled(env({ ENVIRONMENT: "production", COMPUTE_RUNNERS_ENABLED: "1" })),
    ).toBe(false);
    expect(computeRunnersEnabled(env({ ...compute }))).toBe(false);
    expect(computeRunnersEnabled(env({ ...compute, COMPUTE_RUNNERS_ENABLED: undefined }))).toBe(
      false,
    );
  });

  test.each([["true"], [" 1"], ["1 "], ["01"], ["yes"], ["0"], [""], [1], [true], [["1"]]])(
    "is false for the switch %p",
    (value) => {
      expect(computeRunnersEnabled(env({ ...compute, COMPUTE_RUNNERS_ENABLED: value }))).toBe(
        false,
      );
    },
  );

  test.each([["staging"], ["test"], ["Production"], [undefined]])(
    "is false for the environment %p even with both switches on",
    (environment) => {
      expect(
        computeRunnersEnabled(
          env({ ENVIRONMENT: environment, COMPUTE_ENABLED: "1", COMPUTE_RUNNERS_ENABLED: "1" }),
        ),
      ).toBe(false);
    },
  );

  test("is read at call time, so a changed binding changes the answer", () => {
    const bindings = env({ ...compute });
    expect(computeRunnersEnabled(bindings)).toBe(false);
    (bindings as unknown as Record<string, string>).COMPUTE_RUNNERS_ENABLED = "1";
    expect(computeRunnersEnabled(bindings)).toBe(true);
    (bindings as unknown as Record<string, string>).COMPUTE_ENABLED = "0";
    expect(computeRunnersEnabled(bindings)).toBe(false);
  });
});
