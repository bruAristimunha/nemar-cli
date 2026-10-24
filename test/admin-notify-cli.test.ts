/**
 * CLI `nemar admin notify`: the queued result and `--status` (epic #1893 phase 2), driven
 * through the real entry point against a real local HTTP server via TEST_API_URL, with an
 * isolated NEMAR_CONFIG_DIR. Same harness as test/admin-approve-tier-cli.test.ts.
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
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-notify-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "notifycliadmin",
      accounts: { notifycliadmin: { apiKey: "test-admin-key" } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function startServer(routes: Record<string, unknown>) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(`${req.method} ${url.pathname}`);
      const body = routes[`${req.method} ${url.pathname}`];
      return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
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
  return { stdout, stderr, exitCode: await proc.exited };
}

const STATUS_BODY = {
  id: 7,
  status: "queued",
  subject: "Maintenance window",
  recipient_group: "all",
  queued_count: 10,
  delivered_count: 6,
  failure_count: 1,
  unknown_count: 1,
  failed_recipients: ["a***@nemar.test"],
  sent_at: "2026-10-23 12:00:00",
};

describe("nemar admin notify", () => {
  test("a queued result prints the count, the ID and the status command", async () => {
    const server = startServer({
      "POST /admin/notify": {
        broadcast_id: 7,
        status: "queued",
        recipient_count: 10,
        failure_count: 0,
        failed_recipients: [],
        suppressed_count: 3,
      },
    });
    try {
      const r = await runCli(
        ["admin", "notify", "--to", "all", "--subject", "S", "--body", "B", "--yes"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain(
        "Queued 10 announcement(s) (ID 7); check progress with: nemar admin notify --status 7",
      );
      expect(r.stdout).toContain("3 recipient(s) withheld");
    } finally {
      server.stop();
    }
  });

  test("an inline result keeps the existing wording", async () => {
    const server = startServer({
      "POST /admin/notify": {
        broadcast_id: 8,
        status: "sent",
        recipient_count: 2,
        failure_count: 0,
        failed_recipients: [],
        suppressed_count: 0,
      },
    });
    try {
      const r = await runCli(
        ["admin", "notify", "--to", "all", "--subject", "S", "--body", "B", "--yes"],
        server.url,
      );
      expect(r.stderr).toContain("Broadcast sent to 2 recipient(s) (ID: 8)");
      expect(r.stdout).not.toContain("withheld");
    } finally {
      server.stop();
    }
  });

  test("a 200 queue_enqueue_failed body shows the ID and both counts", async () => {
    const server = startServer({
      "POST /admin/notify": {
        broadcast_id: 9,
        status: "queued",
        recipient_count: 100,
        failure_count: 50,
        failed_recipients: [],
        suppressed_count: 0,
        error: "queue_enqueue_failed",
      },
    });
    try {
      const r = await runCli(
        ["admin", "notify", "--to", "all", "--subject", "S", "--body", "B", "--yes"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("Enqueue failed (ID 9): 100 queued, 50 not queued");
      expect(r.stderr).toContain("nemar admin notify --status 9");
    } finally {
      server.stop();
    }
  });

  test("--status prints the counts without needing --subject", async () => {
    const server = startServer({ "GET /admin/notify/7": STATUS_BODY });
    try {
      const r = await runCli(["admin", "notify", "--status", "7"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.requests).toContain("GET /admin/notify/7");
      expect(r.stdout).toContain("Announcement 7 queued");
      expect(r.stdout).toContain("Queued: 10");
      expect(r.stdout).toContain("Delivered: 6");
      expect(r.stdout).toContain("Failed: 1");
      expect(r.stdout).toContain("Unconfirmed: 1");
      expect(r.stdout).toContain("Pending: 2");
      expect(r.stdout).toContain("shown redacted and may not be unique");
      expect(r.stdout).toContain("a***@nemar.test");
    } finally {
      server.stop();
    }
  });

  test("--status --json prints the raw body", async () => {
    const server = startServer({ "GET /admin/notify/7": STATUS_BODY });
    try {
      const r = await runCli(["admin", "notify", "--status", "7", "--json"], server.url);
      expect(JSON.parse(r.stdout)).toEqual(STATUS_BODY);
    } finally {
      server.stop();
    }
  });

  test("--status with a bad ID exits 1 before any request", async () => {
    const server = startServer({});
    try {
      const r = await runCli(["admin", "notify", "--status", "abc"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Invalid announcement ID");
      expect(server.requests).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("sending without --subject is refused", async () => {
    const server = startServer({});
    try {
      const r = await runCli(
        ["admin", "notify", "--to", "all", "--body", "B", "--yes"],
        server.url,
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("subject required");
    } finally {
      server.stop();
    }
  });
});
