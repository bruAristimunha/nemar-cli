/**
 * The S3_ENDPOINT_URL seam is a test hook, and it must not be able to apply in
 * production.
 *
 * The reads it redirects (verifyDatasetVersionS3's LIST and manifest read, the
 * availability report's manifest read) decide `complete`, and through it
 * data_complete and the withdrawal rule (ADR 0064). A stray S3_ENDPOINT_URL on
 * the production Worker would point those verdicts at whatever answers there.
 * Two fences, both pinned here:
 *
 *  1. `testS3EndpointOverride` returns the override only in a recognized
 *     non-production environment, and fails closed on an unknown or unset
 *     ENVIRONMENT. The entry-point proof that the two read sites use it is in
 *     availability-report-never-creates-main.test.ts (a production env with the
 *     variable set still reaches the S3 host, not the stand-in).
 *  2. No `vars` block in backend/wrangler-sccn.toml, top level or under any
 *     `[env.*]`, declares S3_ENDPOINT_URL, so nothing deploys it. (A Worker
 *     secret would not appear in this file; the helper is what covers that.)
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testS3EndpointOverride } from "../src/services/environment";

const OVERRIDE = "http://127.0.0.1:9";

describe("testS3EndpointOverride", () => {
  for (const environment of ["development", "staging", "test", " Development "]) {
    test(`honors the override when ENVIRONMENT=${JSON.stringify(environment)}`, () => {
      expect(
        testS3EndpointOverride({
          ENVIRONMENT: environment as "development",
          S3_ENDPOINT_URL: OVERRIDE,
        }),
      ).toBe(OVERRIDE);
    });
  }

  for (const environment of ["production", "PRODUCTION", "", "prod", "unknown", undefined]) {
    test(`ignores the override when ENVIRONMENT=${JSON.stringify(environment)}`, () => {
      expect(
        testS3EndpointOverride({
          ENVIRONMENT: environment as "production",
          S3_ENDPOINT_URL: OVERRIDE,
        }),
      ).toBeUndefined();
    });
  }

  test("is undefined when no override is set, in any environment", () => {
    expect(testS3EndpointOverride({ ENVIRONMENT: "development" })).toBeUndefined();
    expect(testS3EndpointOverride({ ENVIRONMENT: "production" })).toBeUndefined();
  });
});

describe("backend/wrangler-sccn.toml", () => {
  type VarsBlock = Record<string, unknown>;
  const config = Bun.TOML.parse(
    readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
  ) as { vars?: VarsBlock; env?: Record<string, { vars?: VarsBlock }> };

  const blocks: Array<[string, VarsBlock | undefined]> = [
    ["[vars]", config.vars],
    ...Object.entries(config.env ?? {}).map(
      ([name, env]) => [`[env.${name}.vars]`, env.vars] as [string, VarsBlock | undefined],
    ),
  ];

  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  for (const [name, vars] of blocks) {
    test(`${name} does not declare S3_ENDPOINT_URL`, () => {
      expect(vars).toBeDefined();
      expect(Object.keys(vars ?? {})).not.toContain("S3_ENDPOINT_URL");
    });
  }
});
