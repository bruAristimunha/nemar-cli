/**
 * What skips the limiter, and only that (#1709).
 *
 * Exactly three things do: `ENVIRONMENT=development`, a correct `X-Test-Bypass`
 * against a configured `TEST_BYPASS_TOKEN`, and (for the middleware) an admin
 * token or the Worker's own requests. Everything near them must still be
 * counted: a staging or "test" environment, a wrong or missing token, a token that
 * is not configured, an empty string. The per-route budgets honor the same two
 * environment-level bypasses and nothing more.
 */

import { describe, expect, test } from "bun:test";
import {
  __limits,
  checkDataMissBudget,
  checkPrivateGrantBudget,
} from "../src/middleware/rateLimit";
import type { Bindings } from "../src/types/bindings";
import {
  PROD_ENV,
  T0,
  buildApp,
  edge,
  hit,
  useRateLimitHarness,
} from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const ADDRESS = "203.0.113.150";
type BudgetEnv = Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">;

describe("only ENVIRONMENT=development skips the limiter", () => {
  test.each(["test", "staging", "production", "", undefined, "Development", "dev"])(
    "ENVIRONMENT=%j still counts",
    async (environment) => {
      const env = { ...PROD_ENV, ENVIRONMENT: environment } as unknown as Bindings;
      const res = await hit(buildApp(), edge(ADDRESS), "/datasets", env);
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
    },
  );

  test("development counts nothing", async () => {
    const env = { ...PROD_ENV, ENVIRONMENT: "development" } as unknown as Bindings;
    const res = await hit(buildApp(), edge(ADDRESS), "/datasets", env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
    expect(await h.stored(`ip:${ADDRESS}`)).toBeUndefined();
  });

  test("the budgets agree", async () => {
    await h.seed(`data-miss-ip:${ADDRESS}`, {
      count: __limits.DATA_MISS_MAX_REQUESTS,
      warned: false,
      windowEnd: T0 + 30_000,
    });
    for (const environment of ["test", "staging", "", undefined, "Development"]) {
      const outcome = await checkDataMissBudget(
        { ENVIRONMENT: environment } as unknown as BudgetEnv,
        new Request("http://localhost/data/x", { headers: edge(ADDRESS) }),
        undefined,
      );
      expect(outcome.allowed).toBe(false);
    }
  });
});

describe("X-Test-Bypass on the middleware", () => {
  const withToken = { ...PROD_ENV, TEST_BYPASS_TOKEN: "right-token" } as unknown as Bindings;
  const without = { ...PROD_ENV, TEST_BYPASS_TOKEN: undefined } as unknown as Bindings;

  test("the right token is not counted", async () => {
    const res = await hit(
      buildApp(),
      { ...edge(ADDRESS), "X-Test-Bypass": "right-token" },
      "/datasets",
      withToken,
    );
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
  });

  test.each([["wrong-token"], [""], ["Right-Token"]])("%j is counted", async (value) => {
    const res = await hit(
      buildApp(),
      { ...edge(ADDRESS), "X-Test-Bypass": value },
      "/datasets",
      withToken,
    );
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
  });

  test("with no token configured no value passes, not even one that is set", async () => {
    const res = await hit(
      buildApp(),
      { ...edge(ADDRESS), "X-Test-Bypass": "anything" },
      "/datasets",
      without,
    );
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
  });
});

describe("the budgets' own bypasses", () => {
  const exhaust = () =>
    h.seed(`data-miss-ip:${ADDRESS}`, {
      count: __limits.DATA_MISS_MAX_REQUESTS,
      warned: false,
      windowEnd: T0 + 30_000,
    });
  const ask = (env: Partial<Bindings>, headers: Record<string, string>) =>
    checkDataMissBudget(
      env as BudgetEnv,
      new Request("http://localhost/data/x", { headers: { ...edge(ADDRESS), ...headers } }),
      undefined,
    );

  test("the right test token passes an exhausted budget; a wrong or absent one does not", async () => {
    await exhaust();
    const env = { ENVIRONMENT: "production", TEST_BYPASS_TOKEN: "right-token" };
    expect((await ask(env, { "X-Test-Bypass": "right-token" })).allowed).toBe(true);
    expect((await ask(env, { "X-Test-Bypass": "wrong-token" })).allowed).toBe(false);
    expect((await ask(env, {})).allowed).toBe(false);
  });

  test("with no token configured, no header value passes", async () => {
    await exhaust();
    const env = { ENVIRONMENT: "production" };
    expect((await ask(env, { "X-Test-Bypass": "anything" })).allowed).toBe(false);
  });

  test("development passes an exhausted budget", async () => {
    await exhaust();
    expect((await ask({ ENVIRONMENT: "development" }, {})).allowed).toBe(true);
  });

  test("the private-grant budget has the same three", async () => {
    const env = { ENVIRONMENT: "production", TEST_BYPASS_TOKEN: "right-token" } as BudgetEnv;
    for (let i = 0; i < __limits.PRIVATE_GRANT_MAX_REQUESTS; i++) {
      await checkPrivateGrantBudget(env, new Request("http://localhost/x"), 9, undefined);
    }
    const again = (e: BudgetEnv, headers: Record<string, string>) =>
      checkPrivateGrantBudget(e, new Request("http://localhost/x", { headers }), 9, undefined);
    expect((await again(env, {})).allowed).toBe(false);
    expect((await again(env, { "X-Test-Bypass": "wrong" })).allowed).toBe(false);
    expect((await again(env, { "X-Test-Bypass": "right-token" })).allowed).toBe(true);
    expect((await again({ ENVIRONMENT: "development" } as BudgetEnv, {})).allowed).toBe(true);
  });
});

describe("a Worker with no Cache API at all", () => {
  test("still serves the request, says nothing it did not count, and logs the fault", async () => {
    (globalThis as { caches?: unknown }).caches = undefined;
    const res = await hit(buildApp(), edge(ADDRESS));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
    const fault = h.error.mock.calls.find((c) => c[0] === "[rate-limit] cache failure");
    expect(fault?.[1]).toMatchObject({ keyKind: "ip", phase: "match" });
  });
});
