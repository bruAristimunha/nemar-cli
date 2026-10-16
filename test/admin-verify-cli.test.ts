/**
 * CLI `nemar admin verify <id>` (owner force verify), driven through the real
 * entry point against a real local HTTP server via TEST_API_URL, isolated
 * NEMAR_CONFIG_DIR, no mocks. Harness mirrors test/admin-kind-cli.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-verify-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "verifycliowner",
      accounts: { verifycliowner: { apiKey: "test-owner-key" } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function startServer(body: unknown, status = 200) {
  const requests: { method: string; path: string }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push({ method: req.method, path: url.pathname });
      return Response.json(body, { status });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

async function runCli(args: string[], testApiUrl: string) {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: testApiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("nemar admin verify", () => {
  test("posts to the id-keyed verify route and reports the server's message", async () => {
    const server = startServer({
      message: "User id 80 verified",
      user: { id: 80, status: "verified" },
    });
    try {
      const result = await runCli(["admin", "verify", "80", "-y"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toContainEqual({
        method: "POST",
        path: "/admin/users/by-id/80/verify",
      });
      expect(result.stdout + result.stderr).toContain("User id 80 verified");
    } finally {
      server.stop();
    }
  });

  test("a non-numeric id exits 1 without any request", async () => {
    const server = startServer({});
    try {
      const result = await runCli(["admin", "verify", "80abc", "-y"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid user id");
      expect(server.requests.some((r) => r.path.includes("/verify"))).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a 409 refusal is reported with its hint and exits 1", async () => {
    const server = startServer({ error: "User is not pending" }, 409);
    try {
      const result = await runCli(["admin", "verify", "80", "-y"], server.url);
      const output = result.stdout + result.stderr;
      expect(output).toContain("User is not pending");
      expect(output).toContain("Only a pending account can be force-verified");
      expect(output).not.toContain("User id 80 verified");
      // A script driving this command must be able to tell a refusal from a success.
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a 403 refusal exits 1 too", async () => {
    const server = startServer({ error: "Owner access required" }, 403);
    try {
      const result = await runCli(["admin", "verify", "80", "-y"], server.url);
      expect(result.stdout + result.stderr).toContain("Owner access required");
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });
});
