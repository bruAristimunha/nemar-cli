/**
 * Does the fix-it text actually reach the terminal? (#1255 review items 17, 19.)
 *
 * The owner_name_missing refusals carry a short label in `error` and the
 * ACTIONABLE sentence in `message`. The CLI's client preferred `error`, so all
 * a user saw was "Owner has no researcher name on file" -- true, and useless.
 * Worse, `nemar admin repo publish approve` pinned the fixed 422 hint "Fix the CI
 * issues and retry with --resume" onto this case, sending an admin to look at
 * a workflow run that is perfectly healthy.
 *
 * These drive the REAL client (`request()` from src/lib/api/client.ts) against
 * a local `Bun.serve()` returning the REAL response bodies the three paths
 * emit, and assert on the ApiError a command would render. The config
 * directory is redirected to a temp dir (NEMAR_CONFIG_DIR), and the client's
 * URL override (TEST_API_URL) is pinned to the local server too: CI sorts any
 * file that names that variable into the live-backend tier, where the variable
 * points at staging and takes precedence over the config file, so without the
 * pin these tests silently ran against a backend that does not have the
 * routes yet (epic #1250 phase 5 follow-up).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNER_NAME_MISSING_MESSAGE,
  OWNER_NAME_MISSING_REASON,
} from "../backend/src/services/uploader-identity";
import { request } from "../src/lib/api/client";
import { ApiError } from "../src/lib/api/errors";

let server: ReturnType<typeof Bun.serve>;
let configDir: string;
let previousConfigDir: string | undefined;
let previousApiUrl: string | undefined;
let next: { status: number; body: Record<string, unknown> };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  configDir = mkdtempSync(join(tmpdir(), "nemar-block-surfacing-"));
  // The multi-account store shape getConfig() actually reads.
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "tester",
      accounts: { tester: { apiUrl: `http://localhost:${server.port}` } },
    }),
  );
  previousConfigDir = process.env.NEMAR_CONFIG_DIR;
  process.env.NEMAR_CONFIG_DIR = configDir;
  previousApiUrl = process.env.TEST_API_URL;
  process.env.TEST_API_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  // Guarded restore (#1175): assigning undefined stringifies to "undefined"
  // and poisons the var for every later test in this shared process.
  if (previousConfigDir === undefined) delete process.env.NEMAR_CONFIG_DIR;
  else process.env.NEMAR_CONFIG_DIR = previousConfigDir;
  if (previousApiUrl === undefined) delete process.env.TEST_API_URL;
  else process.env.TEST_API_URL = previousApiUrl;
  rmSync(configDir, { recursive: true, force: true });
  server.stop(true);
});

async function call(status: number, body: Record<string, unknown>): Promise<ApiError> {
  next = { status, body };
  try {
    await request("/anything");
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the request to throw");
}

/** The three bodies the backend really emits for this refusal. */
const PUBLISH_REQUEST_BODY = {
  status: "blocked",
  block_reason: OWNER_NAME_MISSING_REASON,
  message: OWNER_NAME_MISSING_MESSAGE,
  dataset_id: "nm000282",
};
const PUBLISH_APPROVE_BODY = {
  status: "blocked",
  block_reason: OWNER_NAME_MISSING_REASON,
  message: OWNER_NAME_MISSING_MESSAGE,
  dataset_id: "nm000282",
};
const DOI_CONCEPT_BODY = {
  error: "Owner has no researcher name on file",
  block_reason: OWNER_NAME_MISSING_REASON,
  message: OWNER_NAME_MISSING_MESSAGE,
  dataset_id: "nm000282",
  owner_username: "zqxuploader7",
};

describe("owner_name_missing reaches the user on every path", () => {
  test("publish request: the actionable sentence is the error message", async () => {
    const err = await call(422, PUBLISH_REQUEST_BODY);
    expect(err.message).toBe(OWNER_NAME_MISSING_MESSAGE);
    expect(err.message).toContain("ORCID");
    expect(err.blockReason).toBe(OWNER_NAME_MISSING_REASON);
  });

  test("publish approve: same, not the bare label", async () => {
    const err = await call(422, PUBLISH_APPROVE_BODY);
    expect(err.message).toBe(OWNER_NAME_MISSING_MESSAGE);
    expect(err.blockReason).toBe(OWNER_NAME_MISSING_REASON);
  });

  test("admin doi create: `message` wins over `error` when a block_reason is present", async () => {
    // This body still carries `error` for API clients that key on it; the
    // human-facing surface must not be the one-liner.
    const err = await call(422, DOI_CONCEPT_BODY);
    expect(err.message).toBe(OWNER_NAME_MISSING_MESSAGE);
    expect(err.message).not.toBe("Owner has no researcher name on file");
    expect(err.blockReason).toBe(OWNER_NAME_MISSING_REASON);
  });

  test("the username is not what the user is told to fix", async () => {
    const err = await call(422, DOI_CONCEPT_BODY);
    expect(err.message).not.toContain("zqxuploader7");
  });

  test("an ordinary error body still prefers `error`, unchanged", async () => {
    // The preference flips ONLY for bodies carrying a block_reason; every
    // other endpoint keeps the historical behaviour.
    const err = await call(400, { error: "Dataset not found", message: "some detail" });
    expect(err.message).toBe("Dataset not found");
    expect(err.blockReason).toBeUndefined();
  });

  test("a CI block still reads as a CI block", async () => {
    const err = await call(422, {
      status: "blocked",
      block_reason: "bids_validation_failed",
      message: "BIDS validation is failing on your dataset.",
    });
    expect(err.blockReason).toBe("bids_validation_failed");
    expect(err.message).toContain("BIDS validation");
  });
});
