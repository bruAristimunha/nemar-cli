/**
 * Admin Command Restructure Tests
 *
 * Tests the new admin subcommand groups: s3, repo, ci
 * and verifies backward compatibility of the regenerate-iam alias.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
const stripAnsi = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");

function setTestConfig(ctx: TestContext, config: Record<string, unknown>) {
  writeFileSync(ctx.configFile, JSON.stringify(config));
}

beforeEach(async () => {
  await sleep(300);
});

// ============================================================================
// Help output and command routing
// ============================================================================

describe("admin command restructure - help output", () => {
  test("admin --help shows s3, repo, ci subgroups", async () => {
    const { stdout, exitCode } = await runCli(["admin", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("s3");
    expect(stdout).toContain("repo");
    expect(stdout).toContain("ci");
    expect(stdout).toContain("doi");
  });

  test("admin s3 --help shows regenerate-iam", async () => {
    const { stdout, exitCode } = await runCli(["admin", "s3", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("regenerate-iam");
    expect(stdout).toContain("S3 and IAM credential management");
  });

  test("admin repo --help lists the lifecycle commands and no `private`", async () => {
    const { stdout, exitCode } = await runCli(["admin", "repo", "--help"]);
    expect(exitCode).toBe(0);
    const commands = stripAnsi(stdout)
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(commands).toContain("public");
    expect(commands).toContain("withdraw");
    expect(commands).toContain("restore");
    expect(stdout).toContain("visibility and lifecycle");
  });

  test.each([
    ["withdraw", "nemar admin repo withdraw"],
    ["restore", "nemar admin repo restore"],
  ])("the old `admin %s` fails loudly and points at its new home", async (name, replacement) => {
    const { stderr, exitCode } = await runCli(["admin", name, "nm000104", "--execute"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(replacement);
  });

  test("the old `admin withdraw` and `admin restore` are not listed in admin --help", async () => {
    const { stdout } = await runCli(["admin", "--help"]);
    const commandLines = stdout.split("\n").filter((l) => /^\s+(withdraw|restore)\s/.test(l));
    expect(commandLines).toEqual([]);
  });

  test("admin ci --help shows check, add, sync, and validate", async () => {
    const { stdout, exitCode } = await runCli(["admin", "ci", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("check");
    expect(stdout).toContain("add");
    expect(stdout).toContain("sync");
    // validate was added in #472 — guard against silent removal in refactors.
    expect(stdout).toContain("validate");
    expect(stdout).toContain("CI workflow management");
  });

  test("admin --help does not show regenerate-iam at top level", async () => {
    const { stdout } = await runCli(["admin", "--help"]);
    // The hidden alias should not appear in help output
    const lines = stdout.split("\n");
    const commandLines = lines.filter((l) => l.trim().startsWith("regenerate-iam"));
    expect(commandLines.length).toBe(0);
  });
});

// ============================================================================
// Authentication requirements
// ============================================================================

describe("admin commands - auth requirements", () => {
  test("admin repo public requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "repo", "public", "nm000104", "-y"], ctx);
    expect(stdout).toContain("Not authenticated");
  });

  test("admin ci check requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "ci", "check", "nm000104"], ctx);
    expect(stdout).toContain("Not authenticated");
  });

  test("admin ci add requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "ci", "add", "nm000104", "-y"], ctx);
    expect(stdout).toContain("Not authenticated");
  });

  test("admin s3 regenerate-iam requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "s3", "regenerate-iam", "testuser", "-y"], ctx);
    expect(stdout).toContain("Not authenticated");
  });
});

// ============================================================================
// Backward compatibility
// ============================================================================

describe("admin commands - backward compatibility", () => {
  test("admin regenerate-iam still works (hidden alias)", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "regenerate-iam", "testuser", "-y"], ctx);
    // Should show auth error (same as new path), not "unknown command"
    expect(stdout).toContain("Not authenticated");
    expect(stdout).not.toContain("unknown command");
  });
});

// ============================================================================
// Non-admin access (requires API key setup)
// ============================================================================

describe("admin commands - non-admin rejection", () => {
  test("non-admin user cannot use admin ci check", async () => {
    if (!TEST_CONFIG.userApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { stdout } = await runCli(["admin", "ci", "check", "nm000104"], ctx);
    // Should not show success output (CI Status section)
    expect(stdout).not.toContain("CI Status:");
  });

  test("non-admin user cannot use admin repo public", async () => {
    if (!TEST_CONFIG.userApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { stdout } = await runCli(["admin", "repo", "public", "nm000104", "-y"], ctx);
    // Should not show success output
    expect(stdout).not.toContain("is now public");
  });
});

// ============================================================================
// Admin operations (requires admin API key)
// ============================================================================

describe("admin commands - ci check with admin", () => {
  test("admin ci check on non-existent dataset returns 404", async () => {
    if (!TEST_CONFIG.adminApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout } = await runCli(["admin", "ci", "check", "nm999999"], ctx);
    expect(stdout).toContain("Dataset not found");
  });
});

describe("admin commands - repo visibility on non-existent dataset", () => {
  test("admin repo public on non-existent dataset returns 404", async () => {
    if (!TEST_CONFIG.adminApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout } = await runCli(["admin", "repo", "public", "nm999999", "-y"], ctx);
    expect(stdout).toContain("Dataset not found");
  });
});
