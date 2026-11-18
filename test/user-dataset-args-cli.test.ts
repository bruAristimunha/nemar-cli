/**
 * `nemar dataset invite|access approve|access deny` refuse a pair with no dataset id locally,
 * driven through the real entry point. A real local server records any request: there must be none.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let configDir: string;
let requests: string[];
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-user-dataset-args-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "argsclitest",
      accounts: { argsclitest: { apiKey: "test-key" } },
    }),
  );
  requests = [];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/notices") return Response.json({ notices: [] });
      if (path === "/datasets/facets") return Response.json({});
      requests.push(path);
      return Response.json({ message: "ok" });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: `http://localhost:${server.port}`,
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
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("user and dataset id arguments", () => {
  for (const cmd of [
    ["dataset", "invite"],
    ["dataset", "access", "approve"],
    ["dataset", "access", "deny"],
  ]) {
    test(`${cmd.join(" ")} with no dataset id fails locally`, async () => {
      const r = await runCli([...cmd, "alice", "bob"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("Expected <username> <dataset-id>");
      expect(r.stdout + r.stderr).not.toContain("new issue");
      expect(requests).toEqual([]);
    });
  }

  test("a swapped pair reaches the API with the dataset id in the path", async () => {
    await runCli(["dataset", "invite", "nm000289", "alice"]);
    expect(requests.some((p) => p.includes("nm000289"))).toBe(true);
    expect(requests.some((p) => p.includes("alice") && !p.includes("nm000289"))).toBe(false);
  });
});
