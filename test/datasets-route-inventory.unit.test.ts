/**
 * Pins the datasets router's route table across the #902/#906 datasets.ts split.
 *
 * Hono's `.routes` lists one entry per handler in each registration chain, so
 * a route registered with extra middleware (authMiddleware, cliVersionGuard,
 * zValidator, ...) appears once per handler. Three properties are pinned:
 *
 * 1. ENTRY COUNTS per "METHOD /path" — catches a dropped route and a dropped
 *    validator/middleware (not just a lost route).
 * 2. MIDDLEWARE IDENTITY per chain slot — a swap of same-arity middleware
 *    (authMiddleware -> optionalAuthMiddleware is a silent auth downgrade)
 *    keeps counts and keys unchanged, passes the typechecker (same Hono
 *    MiddlewareHandler signature), and no HTTP-level test drives this router,
 *    so identity must be pinned explicitly (found by #917 review fault
 *    injection).
 * 3. REGISTRATION ORDER for GET /search before GET /:id. This is the one
 *    same-method pair whose paths can both match a request. Hono's
 *    RegExpRouter rejects this static/param overlap (UnsupportedPathError),
 *    so SmartRouter silently falls back to TrieRouter, where FIRST
 *    REGISTRATION WINS: registering /:id first swallows /search as
 *    id="search" (verified empirically against the pinned Hono version).
 *    Both routes live in catalog.ts in monolith order; this assert keeps a
 *    future regrouping from separating them. All other cross-file
 *    same-method pairs are structurally disjoint (different segment counts
 *    or distinct static segments), so cross-file registration order is
 *    otherwise not load-bearing.
 *
 * Expected values were captured from datasets.ts as of #906 commit 1, BEFORE
 * any code moved. If this test fails after an intentional route change, update
 * the maps in the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import { authMiddleware, optionalAuthMiddleware } from "../backend/src/middleware/auth";
import { cliVersionGuard } from "../backend/src/middleware/cliVersion";
import { datasetRoutes } from "../backend/src/routes/datasets";

const EXPECTED_ENTRIES: Record<string, number> = {
  // Create & upload lifecycle
  "POST /": 4,
  // Epic #1610 phase 3 (ADR 0087): a resume from the CLI's local config records its attestation
  // and identifier preflight here, since it never reaches POST /.
  "PUT /:id/attestation": 4,
  "POST /:id/upload-urls": 3,
  "POST /:id/upload-credentials": 4,
  "POST /:id/download-credentials": 3,
  "POST /:id/finalize": 2,

  // Catalog / search / discovery
  "GET /": 2,
  "GET /search": 2,
  // Epic #1144 phase 5a (#1170): no middleware -- the response never depends
  // on auth (see catalog.ts's GET /facets doc comment), so there is only one
  // handler in the chain, unlike every other GET here.
  "GET /facets": 1,
  "GET /resolve/:sourceId": 2,
  "GET /:id": 2,

  // Collaborators / access requests
  "POST /:id/request-access": 2,
  "POST /:id/invite": 3,
  "GET /:id/access-requests": 2,
  "POST /:id/access-requests/:username/approve": 2,
  "POST /:id/access-requests/:username/deny": 2,
  "GET /:id/collaborators": 2,
  "DELETE /:id/collaborators/:username": 2,

  // Draft deletion
  "DELETE /:id": 2,

  // Publication workflow
  "POST /:id/publish/request": 2,
  "GET /:id/publish/status": 2,
  "POST /:id/publish/resend": 2,
  "POST /:id/publish/withdraw": 2,
  "GET /:id/ci/status": 2,
  "POST /:id/publish": 2,

  // Version manifests
  "GET /:id/manifest": 2,
  "GET /:id/manifest/:version": 2,
  "GET /:id/versions": 2,
};

// Handler-chain identity labels per route, in registration order. "handler"
// covers slots that are not one of the three shared middlewares (zValidator
// instances and the route handler itself — both anonymous, so identity
// can't be import-compared; their presence is still pinned by position and
// by the entry counts above).
const EXPECTED_CHAINS: Record<string, string[]> = {
  "POST /": ["auth", "cliVersionGuard", "handler", "handler"],
  "PUT /:id/attestation": ["auth", "cliVersionGuard", "handler", "handler"],
  "POST /:id/upload-urls": ["auth", "handler", "handler"],
  "POST /:id/upload-credentials": ["auth", "cliVersionGuard", "handler", "handler"],
  "POST /:id/download-credentials": ["auth", "handler", "handler"],
  "POST /:id/finalize": ["auth", "handler"],
  "GET /": ["optionalAuth", "handler"],
  "GET /search": ["optionalAuth", "handler"],
  "GET /facets": ["handler"],
  "GET /resolve/:sourceId": ["optionalAuth", "handler"],
  "GET /:id": ["optionalAuth", "handler"],
  "POST /:id/request-access": ["auth", "handler"],
  "POST /:id/invite": ["auth", "handler", "handler"],
  "GET /:id/access-requests": ["auth", "handler"],
  "POST /:id/access-requests/:username/approve": ["auth", "handler"],
  "POST /:id/access-requests/:username/deny": ["auth", "handler"],
  "GET /:id/collaborators": ["auth", "handler"],
  "DELETE /:id/collaborators/:username": ["auth", "handler"],
  "DELETE /:id": ["auth", "handler"],
  "POST /:id/publish/request": ["auth", "handler"],
  "GET /:id/publish/status": ["auth", "handler"],
  "POST /:id/publish/resend": ["auth", "handler"],
  "POST /:id/publish/withdraw": ["auth", "handler"],
  "GET /:id/ci/status": ["auth", "handler"],
  "POST /:id/publish": ["auth", "handler"],
  "GET /:id/manifest": ["optionalAuth", "handler"],
  "GET /:id/manifest/:version": ["optionalAuth", "handler"],
  "GET /:id/versions": ["auth", "handler"],
};

function labelOf(handler: unknown): string {
  if (handler === authMiddleware) return "auth";
  if (handler === optionalAuthMiddleware) return "optionalAuth";
  if (handler === cliVersionGuard) return "cliVersionGuard";
  return "handler";
}

describe("datasets route inventory", () => {
  test("route table matches the pre-split pin exactly", () => {
    const actual: Record<string, number> = {};
    for (const r of datasetRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      actual[key] = (actual[key] ?? 0) + 1;
    }
    expect(actual).toEqual(EXPECTED_ENTRIES);
  });

  test("entry total is pinned", () => {
    expect(datasetRoutes.routes.length).toBe(64);
  });

  test("middleware identity per chain slot is pinned", () => {
    const actual: Record<string, string[]> = {};
    for (const r of datasetRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      (actual[key] ??= []).push(labelOf(r.handler));
    }
    expect(actual).toEqual(EXPECTED_CHAINS);
  });

  test("GET /search registers before GET /:id (TrieRouter first-match)", () => {
    const gets = datasetRoutes.routes.filter((r) => r.method === "GET").map((r) => r.path);
    expect(gets.indexOf("/search")).toBeGreaterThanOrEqual(0);
    expect(gets.indexOf("/search")).toBeLessThan(gets.indexOf("/:id"));
  });

  // Epic #1144 phase 5a (#1170), D1: the SECOND instance of the same
  // static-vs-param overlap trap as /search above -- /facets is also one
  // path segment, so it collides with /:id under TrieRouter's first-match
  // semantics and must stay registered first.
  test("GET /facets registers before GET /:id (TrieRouter first-match)", () => {
    const gets = datasetRoutes.routes.filter((r) => r.method === "GET").map((r) => r.path);
    expect(gets.indexOf("/facets")).toBeGreaterThanOrEqual(0);
    expect(gets.indexOf("/facets")).toBeLessThan(gets.indexOf("/:id"));
  });

  // The datasets router deliberately has NO router-level middleware — auth is
  // wired per-route (authMiddleware or optionalAuthMiddleware as the first
  // handler). Guard against a `.use()` sneaking in during the split.
  test("no router-level middleware", () => {
    const star = datasetRoutes.routes.filter((r) => r.method === "ALL");
    expect(star).toEqual([]);
  });
});
