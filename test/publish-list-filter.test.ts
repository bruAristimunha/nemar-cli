/**
 * The flag-to-status rule behind `nemar admin publish list` (#1774), and the
 * command itself through the real CLI entry point: what it asks the server for
 * and what it says when nothing matches.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { describeListScope, resolveListStatuses } from "../src/lib/publish-list-filter";

describe("resolveListStatuses", () => {
  test("defaults to the active statuses", () => {
    expect(resolveListStatuses({})).toEqual(["requested", "approving", "blocked"]);
  });

  test("--all means no filter", () => {
    expect(resolveListStatuses({ all: true })).toBeUndefined();
  });

  test("--all wins over a state flag", () => {
    expect(resolveListStatuses({ all: true, denied: true })).toBeUndefined();
  });

  test("a state flag narrows to that state", () => {
    expect(resolveListStatuses({ denied: true })).toEqual(["denied"]);
  });

  test("several state flags give their union", () => {
    expect(resolveListStatuses({ published: true, denied: true })).toEqual(["published", "denied"]);
  });

  test("--status is one exact status, as it was before the state flags", () => {
    expect(resolveListStatuses({ status: "denied" })).toEqual(["denied"]);
  });

  test("--status takes a comma-separated list and ignores spacing", () => {
    expect(resolveListStatuses({ status: "published, denied" })).toEqual(["published", "denied"]);
  });

  test("--status and the state flags give their union without repeats", () => {
    expect(resolveListStatuses({ status: "denied", denied: true, published: true })).toEqual([
      "published",
      "denied",
    ]);
  });

  test("--all wins over --status", () => {
    expect(resolveListStatuses({ all: true, status: "denied" })).toBeUndefined();
  });

  test("an empty --status is not a choice", () => {
    expect(resolveListStatuses({ status: "" })).toEqual(["requested", "approving", "blocked"]);
  });

  test("a false flag is not a choice", () => {
    expect(resolveListStatuses({ denied: false })).toEqual(["requested", "approving", "blocked"]);
  });
});

describe("describeListScope", () => {
  test("names what is being shown", () => {
    expect(describeListScope({})).toBe("active requests");
    expect(describeListScope({ all: true })).toBe("all requests");
    expect(describeListScope({ published: true, denied: true })).toBe(
      "requests with status published or denied",
    );
  });

  test("a single state reads as a status, not as 'requested requests'", () => {
    expect(describeListScope({ requested: true })).toBe("requests with status requested");
    expect(describeListScope({ status: "denied" })).toBe("requests with status denied");
  });
});

const REPO_ROOT = join(import.meta.dir, "..");
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-publist-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "publist", accounts: { publist: { apiKey: "k" } } }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function startServer(requests: unknown[]) {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname !== "/admin/publish/requests") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      seen.push(url.search);
      return Response.json({ requests, count: requests.length });
    },
  });
  return { url: `http://localhost:${server.port}`, seen, stop: () => server.stop(true) };
}

async function runCli(args: string[], apiUrl: string) {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", join(REPO_ROOT, "src/index.ts"), ...args],
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

const ROW = {
  id: 1,
  dataset_id: "nm000104",
  status: "requested",
  requested_at: "2026-10-05 12:00:00",
  requested_by_username: "alice",
  requested_by_email: "alice@example.org",
  dataset_name: "Motor imagery",
  steps_completed: [],
  current_step: null,
  last_error: null,
};

describe("nemar admin publish list", () => {
  test("asks for the active statuses by default", async () => {
    const server = startServer([ROW]);
    try {
      const r = await runCli(["admin", "publish", "list"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toEqual(["?status=requested%2Capproving%2Cblocked"]);
      expect(r.stdout).toContain("active requests");
      expect(r.stdout).toContain("Motor imagery");
    } finally {
      server.stop();
    }
  });

  test("--all sends no status", async () => {
    const server = startServer([ROW]);
    try {
      await runCli(["admin", "publish", "list", "--all"], server.url);
      expect(server.seen).toEqual([""]);
    } finally {
      server.stop();
    }
  });

  test("state flags and --search become the query", async () => {
    const server = startServer([ROW]);
    try {
      await runCli(
        ["admin", "publish", "list", "--published", "--denied", "--search", "nm0001"],
        server.url,
      );
      expect(server.seen).toEqual(["?status=published%2Cdenied&search=nm0001"]);
    } finally {
      server.stop();
    }
  });

  test("a depositor-controlled name and username cannot carry terminal escapes", async () => {
    const hostile = {
      ...ROW,
      dataset_name: "Clean\u001b[2J\u001b]0;pwned\u0007 name\u009b31m\r\nspoofed line",
      requested_by_username: "al\u001b[31mice",
    };
    const server = startServer([hostile]);
    try {
      const r = await runCli(["admin", "publish", "list"], server.url);
      expect(r.exitCode).toBe(0);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars is the point
      expect(r.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(r.stdout).toContain("Clean");
      expect(r.stdout).toContain("spoofed line");
    } finally {
      server.stop();
    }
  });

  test("an empty default list says how to widen it", async () => {
    const server = startServer([]);
    try {
      const r = await runCli(["admin", "publish", "list", "--search", "zzz"], server.url);
      expect(r.stdout).toContain('No active requests found matching "zzz"');
      expect(r.stdout).toContain("--all");
    } finally {
      server.stop();
    }
  });

  test("a search over D1's pattern limit is refused before any request", async () => {
    const server = startServer([ROW]);
    try {
      const r = await runCli(["admin", "publish", "list", "--search", "a".repeat(49)], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("at most 50 bytes");
      expect(server.seen).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("a search of exactly the limit is sent", async () => {
    const server = startServer([ROW]);
    try {
      const r = await runCli(["admin", "publish", "list", "--search", "a".repeat(48)], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("the limit counts escaped characters and UTF-8 bytes", async () => {
    const server = startServer([ROW]);
    try {
      for (const text of ["_".repeat(25), "\u00e9".repeat(25)]) {
        const r = await runCli(["admin", "publish", "list", "--search", text], server.url);
        expect(r.exitCode).toBe(1);
      }
      expect(server.seen).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("--status keeps its old meaning: one exact status", async () => {
    const server = startServer([ROW]);
    try {
      const r = await runCli(["admin", "publish", "list", "--status", "denied"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toEqual(["?status=denied"]);
    } finally {
      server.stop();
    }
  });

  test("-s is still --status, not the search", async () => {
    const server = startServer([ROW]);
    try {
      const r = await runCli(["admin", "publish", "list", "-s", "denied"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toEqual(["?status=denied"]);
    } finally {
      server.stop();
    }
  });

  test("--status combines with --search and the state flags", async () => {
    const server = startServer([ROW]);
    try {
      await runCli(
        ["admin", "publish", "list", "-s", "published", "--denied", "--search", "alice"],
        server.url,
      );
      expect(server.seen).toEqual(["?status=published%2Cdenied&search=alice"]);
    } finally {
      server.stop();
    }
  });

  test("--search has no short form", async () => {
    const server = startServer([ROW]);
    try {
      const r = await runCli(["admin", "publish", "list", "--search", "nm000104"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toEqual(["?status=requested%2Capproving%2Cblocked&search=nm000104"]);
      const help = await runCli(["admin", "publish", "list", "--help"], server.url);
      expect(help.stdout).toContain("-s, --status <status>");
      expect(help.stdout).toContain("--search <text>");
      expect(help.stdout).not.toContain("-s, --search");
    } finally {
      server.stop();
    }
  });

  test("an empty --requested list does not say 'requested requests'", async () => {
    const server = startServer([]);
    try {
      const r = await runCli(["admin", "publish", "list", "--requested"], server.url);
      expect(r.stdout).toContain("No requests with status requested found.");
      expect(r.stdout).not.toContain("requested requests");
      expect(r.stdout).not.toContain("--all");
    } finally {
      server.stop();
    }
  });

  test("an empty --status list is not told to widen either", async () => {
    const server = startServer([]);
    try {
      const r = await runCli(["admin", "publish", "list", "-s", "denied"], server.url);
      expect(r.stdout).toContain("No requests with status denied found.");
      expect(r.stdout).not.toContain("--all");
    } finally {
      server.stop();
    }
  });
});
