/**
 * What the Worker's own mark exempts, and what it does not (#1709, ADR 0098).
 *
 * `internalRequest()` marks a request this Worker built for itself. The mark lets
 * it past the data plane's two buckets (`data-ip` and the miss budget) and nothing
 * else: a request marked by mistake and sent to the strict, token, anonymous,
 * Neurobagel or private-grant budget is counted by its headers like any other
 * caller, and, having none, as one with no address, which is loud. The data-plane
 * half is `rate-limit-internal.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { internalRequest } from "../src/lib/internal-request";
import { __limits, checkPrivateGrantBudget } from "../src/middleware/rateLimit";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import {
  PROD_ENV,
  T0,
  buildApp,
  edge,
  useRateLimitHarness,
  viaBinding,
} from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const ADDRESS = "203.0.113.90";
const WINDOW_END = T0 + __limits.WINDOW_SIZE * 1000;

const app = buildApp();
/** The request the Worker would hand its own sub-app: marked, whatever it carries. */
const marked = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(internalRequest(new Request(`http://localhost${path}`, { headers })), PROD_ENV);
const noticed = () =>
  h.warn.mock.calls.filter((c) => String(c[0]).includes("neither CF-Connecting-IP"));

describe("a marked request outside the data plane is counted like any other", () => {
  test("by its address on the strict bucket", async () => {
    const res = await marked("/auth/login", edge(ADDRESS));
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("auth-ip");
    expect(res.headers.get("X-RateLimit-Caller")).toBe("edge");
    expect((await h.stored(`auth-ip:${ADDRESS}`))?.count).toBe(1);
  });

  test("and refused at the strict cap", async () => {
    await h.seed(`auth-ip:${ADDRESS}`, {
      count: __limits.AUTH_MAX_REQUESTS,
      warned: false,
      windowEnd: WINDOW_END,
    });
    const res = await marked("/auth/login", edge(ADDRESS));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("auth-ip");
  });

  test("by its forwarded visitor on the anonymous bucket", async () => {
    const res = await marked("/datasets", viaBinding(ADDRESS));
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-ip");
    expect(res.headers.get("X-RateLimit-Caller")).toBe("site");
    expect((await h.stored(`site-ip:site:${ADDRESS}`))?.count).toBe(1);
  });

  test("in the shared bucket, with a warning, when it names nobody", async () => {
    const res = await marked("/datasets");
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-unattributed");
    expect(res.headers.get("X-RateLimit-Caller")).toBe("unattributed");
    expect((await h.stored("site-unattributed:unattributed"))?.count).toBe(1);
    expect(noticed().length).toBe(1);
  });

  test("in the token bucket when it carries a token", async () => {
    const key = `token-${"t".repeat(40)}`;
    const res = await marked("/admin/users", { ...edge(ADDRESS), Authorization: `Bearer ${key}` });
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("token");
    expect((await h.stored(`token:${await hashApiKey(key)}`))?.count).toBe(1);
  });

  test("on the Neurobagel bucket", async () => {
    const res = await marked("/neurobagel/index.json");
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("neurobagel-ip");
    expect((await h.stored("neurobagel-ip:unattributed"))?.count).toBe(1);
  });
});

describe("a marked request on the private-grant budget", () => {
  const env = { ENVIRONMENT: "production" } as Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">;

  test("is counted, and refused at the cap, like any other", async () => {
    const ask = () =>
      checkPrivateGrantBudget(
        env,
        internalRequest(new Request("http://localhost/x", { headers: viaBinding(ADDRESS) })),
        31,
        undefined,
      );
    for (let i = 0; i < __limits.PRIVATE_GRANT_MAX_REQUESTS; i++) {
      expect((await ask()).allowed).toBe(true);
    }
    expect((await h.stored("private-grant-account:user-31"))?.count).toBe(
      __limits.PRIVATE_GRANT_MAX_REQUESTS,
    );
    const refused = await ask();
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.response.headers.get("X-RateLimit-Caller")).toBe("site");
  });
});
