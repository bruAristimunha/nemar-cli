/**
 * Pins the compute router's route table (epic #2005 phase A5, #2010; ADR 0118), the way
 * `test/webhooks-route-inventory.unit.test.ts` pins the webhooks router.
 *
 * Hono's `.routes` lists one entry per handler (a route's own middleware included). Pinning the per-route
 * ENTRY COUNT and the router's middleware catches a handler silently dropped, a route added with no test
 * to answer for it, and a `use("*")` slipping in front of the launcher's callbacks (which have no
 * account: a session middleware there would refuse every launcher).
 *
 * THE TRUST MODEL of each route is stated beside it: the three callbacks carry a per-job token and no
 * session, and each route that has a person behind it declares its own authentication on the route.
 */

import { describe, expect, test } from "bun:test";
import { computeRoutes } from "../src/routes/compute";
import { computeRunnerRoutes } from "../src/routes/compute-runners";

const EXPECTED_ENTRIES: Record<string, number> = {
  // The launcher's callbacks: one handler each, authenticated inline by the `X-Compute-Job-Token`
  // header (a domain-tagged HMAC over the job and its nonce), with one refusal for every failure.
  "POST /jobs/:id/bundle": 1,
  "POST /jobs/:id/outputs": 1,
  "POST /jobs/:id/outputs/complete": 1,
  // The job's owner, signed in: `authMiddleware` (bearer first, then the session cookie), then
  // `cookieOriginGuard` (a write made with a session cookie must come from a NEMAR page), then the
  // handler. Any account that is not the owner is answered `job_not_found`.
  "POST /jobs/:id/cancel": 3,
  "POST /jobs/:id/links": 3,
  // The observer (phase A7, #2012): one handler, no session, authenticated inline by the
  // `Authorization: Bearer` header (an HMAC over a run id and the run's own nonce, one run, one post),
  // with one refusal for every failure.
  "POST /observer": 1,
};

const tableOf = () => {
  const actual: Record<string, number> = {};
  for (const r of computeRoutes.routes) {
    const key = `${r.method} ${r.path}`;
    actual[key] = (actual[key] ?? 0) + 1;
  }
  return actual;
};

describe("compute route inventory", () => {
  test("the route table is exactly the pinned one", () => {
    expect(tableOf()).toEqual(EXPECTED_ENTRIES);
  });

  test("entry total is pinned", () => {
    expect(computeRoutes.routes.length).toBe(10);
  });

  test("no router-level middleware exists: the launcher's callbacks have no session", () => {
    expect(computeRoutes.routes.filter((r) => r.method === "ALL")).toEqual([]);
  });

  test("each person's route carries its own authentication, and the launcher's carry none", () => {
    const handlersOf = (path: string) =>
      computeRoutes.routes.filter((r) => r.path === path).map((r) => r.handler.name || "handler");
    for (const path of ["/jobs/:id/cancel", "/jobs/:id/links"]) {
      expect(handlersOf(path)).toEqual(["authMiddleware", "cookieOriginGuard", "handler"]);
    }
    for (const path of [
      "/jobs/:id/bundle",
      "/jobs/:id/outputs",
      "/jobs/:id/outputs/complete",
      "/observer",
    ]) {
      expect(handlersOf(path)).toHaveLength(1);
      expect(handlersOf(path)).not.toContain("authMiddleware");
    }
  });

  test("every pinned route is a POST (the launcher and the person both write)", () => {
    for (const key of Object.keys(EXPECTED_ENTRIES)) expect(key.startsWith("POST ")).toBe(true);
  });
});

/**
 * The runner's own router (portable compute, card DM-05), mounted at `/compute/runners` by `index.ts` (the
 * registry test's `worker.fetch` case proves the mount). Its trust model: the exchange is authenticated
 * inline, by the runner's secret, with one answer for every failure; `/me` carries `runnerAccess`, the one
 * door an access token opens. No session, no API key, and no router-level middleware.
 */
describe("runner route inventory", () => {
  const tableOfRunners = () => {
    const actual: Record<string, number> = {};
    for (const r of computeRunnerRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      actual[key] = (actual[key] ?? 0) + 1;
    }
    return actual;
  };

  test("the route table is exactly the pinned one", () => {
    expect(tableOfRunners()).toEqual({
      "POST /token": 1,
      "GET /me": 2,
      // DM-07: the queue's three calls, each behind `runnerAccess` and then its handler.
      "POST /claim": 2,
      "POST /heartbeat": 2,
      "POST /complete": 2,
    });
    expect(computeRunnerRoutes.routes.length).toBe(9);
  });

  test("no router-level middleware exists, the exchange carries none, and /me carries runnerAccess only", () => {
    expect(computeRunnerRoutes.routes.filter((r) => r.method === "ALL")).toEqual([]);
    const handlersOf = (path: string) =>
      computeRunnerRoutes.routes
        .filter((r) => r.path === path)
        .map((r) => r.handler.name || "handler");
    expect(handlersOf("/token")).toHaveLength(1);
    expect(handlersOf("/token")).not.toContain("runnerAccess");
    expect(handlersOf("/me")).toEqual(["runnerAccess", "handler"]);
    for (const path of ["/claim", "/heartbeat", "/complete"]) {
      expect(handlersOf(path)).toEqual(["runnerAccess", "handler"]);
    }
  });

  test("neither a person's authentication nor a launcher's token guards a runner route", () => {
    for (const r of computeRunnerRoutes.routes) {
      expect(["authMiddleware", "cookieOriginGuard", "adminMiddleware"]).not.toContain(
        r.handler.name,
      );
    }
  });

  test("the compute router itself holds no runner route (they live in their own router)", () => {
    expect(computeRoutes.routes.filter((r) => r.path.startsWith("/runners"))).toEqual([]);
  });
});
