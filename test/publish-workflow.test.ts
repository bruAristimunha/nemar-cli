/**
 * Publication Workflow Tests
 *
 * Tests the user-facing publish commands (request, status, resend)
 * and admin publish commands (list, deny, approve).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { ABSENT_DATASET_ID } from "../backend/src/services/datasetId";
import { TEST_CONFIG, sleep } from "./setup";

interface TestContext {
  configDir: string;
  configFile: string;
}

function createTestContext(): TestContext {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const configDir = join(import.meta.dir, ".test-configs", uniqueId);
  mkdirSync(configDir, { recursive: true });
  const configFile = join(configDir, "config.json");
  return { configDir, configFile };
}

async function runCli(
  args: string[],
  ctx?: TestContext,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", "src/index.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      ...(ctx ? { NEMAR_CONFIG_DIR: ctx.configDir } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

function setTestConfig(ctx: TestContext, config: Record<string, unknown>) {
  writeFileSync(ctx.configFile, JSON.stringify(config));
}

beforeEach(async () => {
  await sleep(300);
});

// ============================================================================
// Help output and command routing
// ============================================================================

describe("publish workflow - help output", () => {
  test("dataset publish --help shows request, status, resend", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "publish", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("request");
    expect(stdout).toContain("status");
    expect(stdout).toContain("resend");
    expect(stdout).toContain("Publication workflow management");
  });

  test("admin publish --help shows list, deny, approve", async () => {
    const { stdout, exitCode } = await runCli(["admin", "publish", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list");
    expect(stdout).toContain("deny");
    expect(stdout).toContain("approve");
    expect(stdout).toContain("Publication workflow management");
  });

  test("admin --help shows publish subgroup", async () => {
    const { stdout, exitCode } = await runCli(["admin", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("publish");
  });
});

// ============================================================================
// Authentication requirements
// ============================================================================

describe("publish workflow - auth requirements", () => {
  test("dataset publish request requires auth", async () => {
    const ctx = createTestContext();
    const { stdout, exitCode } = await runCli(["dataset", "publish", "request", "nm000104"], ctx);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not authenticated");
  });

  test("dataset publish status requires auth", async () => {
    const ctx = createTestContext();
    const { stdout, exitCode } = await runCli(["dataset", "publish", "status", "nm000104"], ctx);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not authenticated");
  });

  test("dataset publish resend requires auth", async () => {
    const ctx = createTestContext();
    const { stdout, exitCode } = await runCli(["dataset", "publish", "resend", "nm000104"], ctx);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not authenticated");
  });

  test("admin publish list requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "publish", "list"], ctx);
    expect(stdout).toContain("Not authenticated");
  });

  test("admin publish deny requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(
      ["admin", "publish", "deny", "nm000104", "-r", "test", "-y"],
      ctx,
    );
    expect(stdout).toContain("Not authenticated");
  });

  test("admin publish approve requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "publish", "approve", "nm000104", "-y"], ctx);
    expect(stdout).toContain("Not authenticated");
  });
});

// ============================================================================
// Non-admin user rejection (requires API key)
// ============================================================================

describe("publish workflow - non-admin rejection", () => {
  test("non-admin cannot list publish requests", async () => {
    if (!TEST_CONFIG.userApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { stdout } = await runCli(["admin", "publish", "list"], ctx);
    // Should not show request list (gets 403)
    expect(stdout).not.toContain("Publication Requests");
  });

  test("non-admin cannot approve publication", async () => {
    if (!TEST_CONFIG.userApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { stdout } = await runCli(["admin", "publish", "approve", "nm000104", "-y"], ctx);
    // Should not show success output
    expect(stdout).not.toContain("published successfully");
  });
});

// ============================================================================
// User publish operations (requires user API key)
// ============================================================================

describe("publish workflow - user operations", () => {
  test("publish status for non-existent dataset returns error", async () => {
    if (!TEST_CONFIG.userApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { stdout, exitCode } = await runCli(["dataset", "publish", "status", "nm999999"], ctx);
    // Backend may return "Dataset not found" (JSON 404) or generic 404 if route not deployed
    expect(stdout.includes("not found") || stdout.includes("404")).toBe(true);
    // Must exit non-zero so scripts/CI can detect the failure (issue #94)
    expect(exitCode).toBe(1);
  });

  test("publish request for non-existent dataset returns error", async () => {
    if (!TEST_CONFIG.userApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { stdout, exitCode } = await runCli(["dataset", "publish", "request", "nm999999"], ctx);
    expect(stdout.includes("not found") || stdout.includes("404")).toBe(true);
    // Must exit non-zero so scripts/CI can detect the failure (issue #94)
    expect(exitCode).toBe(1);
  });

  test("publish resend for non-existent dataset returns error", async () => {
    if (!TEST_CONFIG.userApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { stdout, exitCode } = await runCli(["dataset", "publish", "resend", "nm999999"], ctx);
    expect(stdout.includes("not found") || stdout.includes("404")).toBe(true);
    // Must exit non-zero so scripts/CI can detect the failure (issue #94)
    expect(exitCode).toBe(1);
  });

  test("publish status with invalid api key exits non-zero (issue #94)", async () => {
    // Uses a config with a clearly-invalid api key so isAuthenticated()
    // passes but the API call fails. Verifies the catch block exits
    // non-zero so callers (CI scripts) can detect the failure.
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: "nemar_invalid_key_for_exit_code_test_xxxxxxxxxxxx",
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { exitCode } = await runCli(["dataset", "publish", "status", "nm099999"], ctx);
    expect(exitCode).toBe(1);
  });

  test("publish request with invalid api key exits non-zero (issue #94)", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: "nemar_invalid_key_for_exit_code_test_xxxxxxxxxxxx",
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { exitCode } = await runCli(["dataset", "publish", "request", "nm099999"], ctx);
    expect(exitCode).toBe(1);
  });

  test("publish resend with invalid api key exits non-zero (issue #94)", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: "nemar_invalid_key_for_exit_code_test_xxxxxxxxxxxx",
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { exitCode } = await runCli(["dataset", "publish", "resend", "nm099999"], ctx);
    expect(exitCode).toBe(1);
  });
});

// ============================================================================
// Admin publish operations (requires admin API key)
// ============================================================================

describe("publish workflow - admin operations", () => {
  test("admin publish list returns response", async () => {
    if (!TEST_CONFIG.adminApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout } = await runCli(["admin", "publish", "list"], ctx);
    // Should show requests, empty state, or 404 if endpoint not yet deployed
    expect(
      stdout.includes("Publication Requests") ||
        stdout.includes("No active requests found") ||
        stdout.includes("404"),
    ).toBe(true);
  });

  test("admin publish deny non-existent request returns error", async () => {
    if (!TEST_CONFIG.adminApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout, stderr } = await runCli(
      ["admin", "publish", "deny", ABSENT_DATASET_ID, "-r", "test reason", "-y"],
      ctx,
    );
    // ABSENT_DATASET_ID, not nm999999: that id is outside the 0-99999 cap, so the
    // id check (#1583) now refuses it before any lookup. Backend returns
    // "No active publication request found" or generic 404
    // Error message appears in stderr (via ora spinner.fail) or stdout
    const output = stdout + stderr;
    expect(
      output.includes("not found") ||
        output.includes("No active publication request") ||
        output.includes("404"),
    ).toBe(true);
  });

  test("admin publish approve non-existent request returns error", async () => {
    if (!TEST_CONFIG.adminApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout, stderr } = await runCli(
      ["admin", "publish", "approve", ABSENT_DATASET_ID, "-y"],
      ctx,
    );
    // Error message appears in stderr (via ora spinner.fail) or stdout
    const output = stdout + stderr;
    expect(
      output.includes("not found") ||
        output.includes("No active publication request") ||
        output.includes("404"),
    ).toBe(true);
  });

  test("admin publish list with status filter returns response", async () => {
    if (!TEST_CONFIG.adminApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout } = await runCli(["admin", "publish", "list", "--requested"], ctx);
    expect(
      stdout.includes("Publication Requests") ||
        stdout.includes("No requests with status requested found") ||
        stdout.includes("404"),
    ).toBe(true);
  });
});
