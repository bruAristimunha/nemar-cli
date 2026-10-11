/**
 * Pins the webhooks router's route table across the #902/#905 webhooks.ts split.
 *
 * Hono's `.routes` lists one entry per handler in each registration chain.
 * Every webhook route is a single bare handler (auth is inline in each
 * handler body, not middleware), so every count is 1. Pinning the per-route
 * ENTRY COUNT catches a handler silently dropped or a middleware silently
 * added while code moves between files — not just a lost route.
 *
 * Counts are compared as an unordered map: the split regroups registrations
 * by trust model (routes/webhooks/github.ts vs routes/callbacks/*.ts), and
 * all webhook paths are distinct static paths, so registration order is not
 * load-bearing.
 *
 * Expected values were captured from webhooks.ts as of #905 commit 1, BEFORE
 * any code moved. If this test fails after an intentional route change,
 * update the map in the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import webhooks from "../backend/src/routes/webhooks";

const EXPECTED_ENTRIES: Record<string, number> = {
  // Version-DOI publish flow (bearer token)
  "POST /publish-version-doi": 1,
  "GET /version-doi-status": 1,

  // Central manifest workflow callbacks (MANIFEST_CALLBACK_SECRET token)
  "POST /manifest-ready": 1,
  "POST /manifest-failed": 1,

  // Publication prescreen callback (PRESCREEN_CALLBACK_SECRET token)
  "POST /prescreen-result": 1,

  // Publication identifier-screen callback (domain-tagged token, same secret)
  "POST /identifier-screen-result": 1,
  // Scheduled identifier sweep callback (epic #1610 phase 5, ADR 0088)
  "POST /identifier-sweep-result": 1,

  // Dataset pull-request review callback (domain-tagged token, same secret; ADR 0092)
  "POST /pr-review-claim": 1,
  "POST /pr-review-result": 1,

  // OpenNeuro import state callback (bearer token)
  "POST /import-state": 1,

  // LLM enrichment dispatch (bearer token)
  "POST /llm-enrich": 1,

  // The real GitHub webhook (HMAC signature)
  "POST /github": 1,

  // Artifact-build callbacks (bearer token)
  "POST /zarr-ready": 1,
  "POST /archive-ready": 1,
  "POST /records-ready": 1,
};

describe("webhooks route inventory", () => {
  test("route table matches the pre-split pin exactly", () => {
    const actual: Record<string, number> = {};
    for (const r of webhooks.routes) {
      const key = `${r.method} ${r.path}`;
      actual[key] = (actual[key] ?? 0) + 1;
    }
    expect(actual).toEqual(EXPECTED_ENTRIES);
  });

  test("entry total is pinned", () => {
    expect(webhooks.routes.length).toBe(15);
  });

  // The webhooks router has NO router-level middleware: every route does its
  // own auth inline (four distinct mechanisms across the routes). A `.use()`
  // sneaking in during the split would change auth semantics for all routes.
  test("no router-level middleware exists", () => {
    const star = webhooks.routes.filter((r) => r.method === "ALL");
    expect(star).toEqual([]);
  });
});
