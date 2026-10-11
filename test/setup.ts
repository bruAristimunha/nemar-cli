/**
 * Test Setup
 *
 * Loads test environment and provides test utilities.
 *
 * Two fences live here rather than in each suite, because the opt-in version of
 * both had already failed: a live tier that defaulted to production, and a CLI
 * that could reach for a browser. See `test/live-target.ts` for what that cost.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedTargetMessage, decideLiveTarget } from "./live-target";

// Force every test process to use an isolated config dir before any module
// (notably src/lib/config.ts) can capture the user's real ~/.config/nemar/
// path at import time. Tests that explicitly need a different dir override
// NEMAR_CONFIG_DIR locally; the shared default just keeps the developer's
// real config out of the blast radius.
if (!process.env.NEMAR_CONFIG_DIR) {
  process.env.NEMAR_CONFIG_DIR = mkdtempSync(join(tmpdir(), "nemar-test-cfg-"));
}

// Load test environment variables
const envPath = join(import.meta.dir, ".env.test");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=");
      if (key && value) {
        process.env[key] = value;
      }
    }
  }
}

/**
 * No test may reach for a browser unless it says so.
 *
 * `openInBrowser` (src/lib/browser.ts) honours `NEMAR_NO_BROWSER=1`, and the two
 * tests that exercise the opener on purpose set it to `undefined` in the child env
 * -- which deletes it for that child -- and put a fake `open`/`xdg-open` first on
 * PATH. So this default costs those tests nothing, and it means a NEW test that
 * happens to reach a browser-opening code path cannot take over the developer's
 * screen or start a sign-in. Set before any suite can spawn the CLI.
 */
// Empty counts as unset, matching the two other empty-means-unset rules this file
// relies on (an undeclared target, an empty NEMAR_API_KEY). Guarding on `undefined`
// alone left an ambient `NEMAR_NO_BROWSER=""` in place, and the consumer requires
// exactly "1" -- so browser attempts came back on from a value that looks like it
// switched them off.
if ((process.env.NEMAR_NO_BROWSER ?? "").trim() === "") {
  process.env.NEMAR_NO_BROWSER = "1";
}

/**
 * Which backend the live tier may talk to, and the enforcement.
 *
 * When blocked, `TEST_API_URL` is REWRITTEN to a dead loopback address before any
 * suite runs. That is what actually stops the traffic: every CLI-spawning suite
 * inherits the variable, and `getApiUrl()` (src/lib/api/client.ts) prefers it over
 * both the stored config and the production default, so no child process can reach
 * production even though none of them asked to be protected.
 *
 * `TEST_CONFIG.apiUrl` deliberately keeps the DECLARED url, so the suites that check
 * the target themselves keep seeing what was asked for rather than the substitute.
 *
 * The rewrite protects children that INHERIT the variable, which is all of them bar
 * one: `test/manifest.test.ts` clears it on purpose so the CLI falls back to the
 * stored config, whose schema default is production. That file pins its own urls, so
 * it is safe -- but the rewrite is not a universal guarantee, and a new suite that
 * overrides `TEST_API_URL` for its children is outside it.
 */
const liveTarget = decideLiveTarget({
  testApiUrl: process.env.TEST_API_URL,
  allowProd: process.env.TEST_ALLOW_PROD,
  defaultApiUrl: "https://api.nemar.org",
});

if (liveTarget.blocked) {
  process.env.TEST_API_URL = liveTarget.effectiveApiUrl;
  console.warn(blockedTargetMessage(liveTarget.declaredApiUrl));
}

/** True when a live request must not be made: the target is production and
 *  `TEST_ALLOW_PROD` was not set. A live suite should `describe.skipIf` on this
 *  (test/contract-live.test.ts is the pattern) rather than fail against the dead
 *  address the harness substitutes. */
export const LIVE_TARGET_BLOCKED = liveTarget.blocked;

// Test configuration
export const TEST_CONFIG = {
  apiUrl: liveTarget.declaredApiUrl,
  adminApiKey: process.env.TEST_ADMIN_API_KEY || "",
  userApiKey: process.env.TEST_USER_API_KEY || "",
  bypassToken: process.env.TEST_BYPASS_TOKEN || "",
  /** Optional (epic #1272 phase 4, #1284; ADR 0048): an OWNER-role token,
   *  distinct from `adminApiKey` (an admin, not an owner). Only the owner-only
   *  routes this phase adds (`POST /admin/users/:username/kind`,
   *  `POST /admin/users/:username/keys`) need it, and only one live suite
   *  reads it (admin-owner-key-mint-flow.test.ts) -- it probe-skips its
   *  owner-path cases when this is unset rather than failing the run. */
  ownerApiKey: process.env.TEST_OWNER_API_KEY || "",
};

/**
 * S3 bucket the backend under test issues credentials for.
 *
 * Production serves `nemar`; every non-production worker serves the dedicated
 * `nemar-dev` bucket (epic #923 gave dev/staging its own bucket so a dev action
 * can never touch real data). Derived from `apiUrl` rather than hardcoded, so a
 * live-backend test asserting on the bucket stays correct whichever environment
 * `TEST_API_URL` points at.
 */
export const IS_PRODUCTION_TARGET = (() => {
  // Not a bare `new URL(...)`: an unparseable target (a scheme-less
  // `host:port`, say) is routed into the BLOCKED path two lines up and then used
  // to be handed to the URL constructor here, which threw -- so every suite that
  // imports this file failed to LOAD rather than skipping, turning a
  // misconfiguration into a broken run.
  try {
    return (
      new URL(TEST_CONFIG.apiUrl).hostname.toLowerCase().replace(/\.$/, "") === "api.nemar.org"
    );
  } catch {
    // Unreadable: not the production API, and the bucket expectation below should
    // be the non-production one. The live tier is blocked in this case anyway.
    return false;
  }
})();

export const EXPECTED_S3_BUCKET = IS_PRODUCTION_TARGET ? "nemar" : "nemar-dev";

/** Exemplar fleet id band (epic #923). Only ever populated outside production. */
export const EXEMPLAR_ID_RE = /^xx0999\d{2}$/;

// Validate test config
if (!TEST_CONFIG.adminApiKey || !TEST_CONFIG.userApiKey) {
  console.warn("Warning: Test API keys not configured. Some tests may fail.");
  console.warn("Create test/.env.test with TEST_ADMIN_API_KEY and TEST_USER_API_KEY");
}

/**
 * Make a test API request
 */
export async function testRequest<T>(
  path: string,
  options: RequestInit = {},
  apiKey?: string,
): Promise<{ status: number; data: T }> {
  // Throw rather than quietly hitting the dead loopback address: a suite that
  // reaches here is one that has no skip guard, and `ECONNREFUSED` × 36 does not
  // tell anyone why. The message names both ways out.
  if (LIVE_TARGET_BLOCKED) {
    throw new Error(blockedTargetMessage(liveTarget.declaredApiUrl));
  }

  // The EFFECTIVE target, not the declared one. Unreachable today because the throw
  // above covers the only case where they differ -- belt and braces, so a future
  // caller that swallows the throw still cannot reach production through here.
  const url = `${liveTarget.effectiveApiUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  // Add rate limit bypass header for tests
  if (TEST_CONFIG.bypassToken) {
    headers["X-Test-Bypass"] = TEST_CONFIG.bypassToken;
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const data = (await response.json()) as T;
  return { status: response.status, data };
}

/**
 * Generate a unique test username
 */
export function uniqueUsername(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Cleanup function to remove test data
 */
export async function cleanupTestUser(username: string, adminApiKey: string): Promise<void> {
  // This would call the admin revoke endpoint
  // For now, test users are cleaned up manually or via scripts
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rate-limited test request (adds delay to avoid 429)
 */
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // 100ms between requests

export async function rateLimitedRequest<T>(
  path: string,
  options: RequestInit = {},
  apiKey?: string,
): Promise<{ status: number; data: T }> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
  }

  lastRequestTime = Date.now();
  return testRequest<T>(path, options, apiKey);
}
