/**
 * Where the vector visibility filter's switch is set, and where it is not (ADR 0126).
 *
 * `VECTORIZE_VISIBILITY_FILTER` appears in no table of `backend/wrangler-sccn.toml`. It is the owner's:
 * turning it on lets non-public datasets into the vector index, so the owner adds it in a reviewed change
 * after the labels have been refreshed by the daily drain; a line added by any other change would turn it
 * on somewhere nobody decided it should be, and that is what this test refuses. It is pinned until that
 * change, which edits this test. The test reads the real file and walks every table of the parsed document;
 * it covers the file and nothing else (a Worker variable of the same name also takes effect).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type VarsBlock = Record<string, unknown>;

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { vars?: VarsBlock; env?: Record<string, { vars?: VarsBlock }> };

const NAMES = ["VECTORIZE_VISIBILITY_FILTER"] as const;

/** The dotted path of every key named in NAMES, anywhere in the parsed document. */
function pathsOfNames(node: unknown, path = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  const found: string[] = [];
  const entries: Array<[string, unknown]> = Array.isArray(node)
    ? node.map((v, i) => [`[${i}]`, v])
    : Object.entries(node);
  for (const [key, value] of entries) {
    const here = path === "" ? key : Array.isArray(node) ? `${path}${key}` : `${path}.${key}`;
    if ((NAMES as readonly string[]).includes(key)) found.push(here);
    found.push(...pathsOfNames(value, here));
  }
  return found;
}

describe("backend/wrangler-sccn.toml and the vector visibility filter switch", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
  });

  test("the walk sees a name wherever it is (the walk is not vacuous)", () => {
    expect(
      pathsOfNames({
        a: { b: [{ VECTORIZE_VISIBILITY_FILTER: "1" }] },
        VECTORIZE_VISIBILITY_FILTER: "1",
      }),
    ).toEqual(["a.b[0].VECTORIZE_VISIBILITY_FILTER", "VECTORIZE_VISIBILITY_FILTER"]);
  });

  test("the switch is not set in any table of the file", () => {
    expect(pathsOfNames(config)).toEqual([]);
  });
});
