/**
 * E2E Sandbox Tests
 *
 * These tests install the CLI from npm and run real commands against
 * sandbox datasets. They validate CLI integrity after each release.
 *
 * Environment variables required:
 * - TEST_API_URL: Backend API URL
 * - TEST_USER_API_KEY: API key for test user
 * - NPM_TAG: npm tag to install (e.g., PR24, dev, latest)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test configuration
const TEST_API_URL = process.env.TEST_API_URL || "https://nemar-api-dev.sccn-org.workers.dev";
const TEST_USER_API_KEY = process.env.TEST_USER_API_KEY;
const NPM_TAG = process.env.NPM_TAG || "dev";
const TEST_DIR = join(tmpdir(), `nemar-e2e-${Date.now()}`);
// Conf library uses projectName "nemar", so config is at XDG_CONFIG_HOME/nemar/
const CONFIG_DIR = join(TEST_DIR, ".config", "nemar");

// Skip if no API key
const shouldSkip = !TEST_USER_API_KEY;

function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const env = {
    ...process.env,
    HOME: TEST_DIR,
    XDG_CONFIG_HOME: join(TEST_DIR, ".config"),
    // Use NEMAR_CONFIG_DIR for direct config path override (from src/lib/config.ts)
    NEMAR_CONFIG_DIR: CONFIG_DIR,
    NEMAR_API_URL: TEST_API_URL,
    ...options.env,
  };

  try {
    const result = execSync(`nemar ${args.join(" ")}`, {
      cwd: options.cwd || TEST_DIR,
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: result, stderr: "", exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      status?: number | null;
      signal?: string | null;
      message?: string;
    };
    // A spawn error, a timeout or a kill by signal leaves stdout and stderr empty, so what
    // the caller prints would be nothing at all. Say what execSync reported.
    const stderr = execError.stderr || "";
    const reason = `[execSync failed: ${execError.message ?? "no message"}; status ${execError.status ?? "none"}; signal ${execError.signal ?? "none"}]`;
    return {
      stdout: execError.stdout || "",
      stderr: stderr ? `${stderr}\n${reason}` : reason,
      exitCode: execError.status || 1,
    };
  }
}

function setupTestConfig(): void {
  // Create config directory
  mkdirSync(CONFIG_DIR, { recursive: true });

  // Write test config
  // Note: Field names must match src/lib/config.ts schema
  const config = {
    apiKey: TEST_USER_API_KEY,
    apiUrl: TEST_API_URL,
    sandboxCompleted: true, // Skip sandbox requirement for tests
    username: "testuser", // Needed for --mine filter
  };

  writeFileSync(join(CONFIG_DIR, "config.json"), JSON.stringify(config, null, 2));
}

describe("E2E Sandbox Tests", () => {
  beforeAll(() => {
    if (shouldSkip) {
      console.log("Skipping E2E tests: TEST_USER_API_KEY not set");
      return;
    }

    console.log(`Installing nemar-cli@${NPM_TAG}...`);

    // Create test directory
    mkdirSync(TEST_DIR, { recursive: true });

    // Install CLI globally from npm
    try {
      execSync(`bun install -g nemar-cli@${NPM_TAG}`, {
        stdio: "inherit",
        env: { ...process.env, HOME: TEST_DIR },
      });
    } catch (error) {
      console.error("Failed to install CLI:", error);
      throw error;
    }

    // Setup test config
    setupTestConfig();

    console.log("CLI installed and configured");
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `Could not clean up ${TEST_DIR}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  });

  describe("Basic CLI Commands", () => {
    test.skipIf(shouldSkip)("nemar --version returns version", () => {
      const result = runCli(["--version"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    test.skipIf(shouldSkip)("nemar --help shows available commands", () => {
      const result = runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("auth");
      expect(result.stdout).toContain("dataset");
    });

    test.skipIf(shouldSkip)("nemar auth status shows logged in", () => {
      const result = runCli(["auth", "status"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toMatch(/logged in|authenticated/);
    });
  });

  describe("Dataset Validation", () => {
    const sampleDatasetDir = join(TEST_DIR, "sample-bids");

    beforeAll(() => {
      if (shouldSkip) return;

      // Create a minimal valid BIDS dataset for validation
      // Note: A minimal valid BIDS dataset only needs dataset_description.json and README
      // Adding subjects with sidecars but no data files will cause validation to fail
      mkdirSync(sampleDatasetDir, { recursive: true });

      // dataset_description.json - required
      writeFileSync(
        join(sampleDatasetDir, "dataset_description.json"),
        JSON.stringify(
          {
            Name: "Test Dataset",
            BIDSVersion: "1.9.0",
            DatasetType: "raw",
          },
          null,
          2,
        ),
      );

      // README - required by BIDS
      writeFileSync(
        join(sampleDatasetDir, "README"),
        "Test dataset for E2E testing\n\nThis is a minimal BIDS dataset.",
      );

      // CHANGES - optional but common
      writeFileSync(join(sampleDatasetDir, "CHANGES"), "1.0.0 - Initial release");

      // Note: We intentionally don't add subject directories with partial data
      // because sidecar files without corresponding data files fail validation
    });

    test.skipIf(shouldSkip)(
      "nemar dataset validate works on valid BIDS dataset",
      () => {
        const result = runCli(["dataset", "validate", sampleDatasetDir]);
        // A minimal BIDS dataset (just description + README) should pass validation
        // It may have warnings about empty dataset, but should exit 0
        if (result.exitCode !== 0) {
          console.log("Validation failed with stdout:", result.stdout);
          console.log("Validation failed with stderr:", result.stderr);
        }
        expect(result.exitCode).toBe(0);
      },
      { timeout: 60000 }, // BIDS validation via Deno may need to download validator on first run
    );

    test.skipIf(shouldSkip)("nemar dataset validate fails on invalid path", () => {
      const result = runCli(["dataset", "validate", "/nonexistent/path"]);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("Sandbox Training", () => {
    test.skipIf(shouldSkip)("nemar sandbox --help shows sandbox commands", () => {
      const result = runCli(["sandbox", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("training");
    });
  });

  describe("Dataset Listing", () => {
    test.skipIf(shouldSkip)("nemar dataset list works", () => {
      const result = runCli(["dataset", "list"]);
      // Should succeed even if no datasets
      if (result.exitCode !== 0) {
        // Same report as `--mine` below: this test failed once in CI after 5.0 s with only
        // "Expected: 0, Received: 1" in the log, which cannot tell a slow staging backend
        // from a broken CLI (run 38490725411).
        console.log("List failed with stdout:", result.stdout);
        console.log("List failed with stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
    });

    test.skipIf(shouldSkip)("nemar dataset list --mine shows user datasets", () => {
      const result = runCli(["dataset", "list", "--mine"]);
      if (result.exitCode !== 0) {
        console.log("List --mine failed with stdout:", result.stdout);
        console.log("List --mine failed with stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
    });
  });
});
