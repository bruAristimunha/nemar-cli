/**
 * `nemar dataset publish withdraw`, and how a withdrawn request reads in
 * `publish status` and `admin publish list`, through the real CLI entry point.
 *
 * The HTTP server here is a stand-in that answers with the backend's response
 * shape. .rules/testing.md discourages stub services; this follows the sibling
 * precedent of test/identifier-screen-cli.test.ts and test/publish-anonymous-cli.test.ts,
 * where the CLI's own behaviour (what it sends, what a person reads) is the
 * subject and a real Worker plus D1 cannot be started from a `bun test`
 * subprocess. The backend's own rules (who may withdraw, when it is too late)
 * are tested against the REAL route and database in
 * backend/test/publish-withdraw.test.ts, which also pins the exact error bodies
 * the stand-in below reproduces, so the two cannot drift apart unseen.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const REPO_ROOT = join(import.meta.dir, "..");

interface Route {
  status?: number;
  body: unknown;
}

function startServer(routes: Record<string, Route>) {
  const seen: string[] = [];
  const queries: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      seen.push(`${req.method} ${url.pathname}`);
      queries.push(url.search);
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(route.body, { status: route.status ?? 200 });
    },
  });
  return { url: `http://localhost:${server.port}`, seen, queries, stop: () => server.stop(true) };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-withdraw-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "wdcli", accounts: { wdcli: { apiKey: "k" } } }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

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

const WITHDRAW = "POST /datasets/nm000104/publish/withdraw";

describe("nemar dataset publish withdraw", () => {
  test("--yes withdraws and says how to request again", async () => {
    const server = startServer({
      [WITHDRAW]: { body: { message: "Publication request withdrawn", dataset_id: "nm000104" } },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toEqual(["POST /datasets/nm000104/publish/withdraw"]);
      expect(r.stdout + r.stderr).toContain("Publication request withdrawn for nm000104");
      expect(r.stdout).toContain("nemar dataset publish request nm000104");
    } finally {
      server.stop();
    }
  });

  test("--no sends nothing", async () => {
    const server = startServer({ [WITHDRAW]: { body: {} } });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--no"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toEqual([]);
      expect(r.stdout).toContain("Skipped");
    } finally {
      server.stop();
    }
  });

  test("too late: the backend's words reach the terminal, with a plain line, and the exit code is 1", async () => {
    const server = startServer({
      [WITHDRAW]: {
        status: 409,
        body: {
          error:
            "Publishing this dataset has already started, so the request can no longer be withdrawn.",
          code: "withdraw_too_late",
        },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("already started");
      expect(r.stdout + r.stderr).toContain("Your request was left as it was");
    } finally {
      server.stop();
    }
  });

  test("a 409 without the too-late code gets no too-late line", async () => {
    const server = startServer({
      [WITHDRAW]: { status: 409, body: { error: "Something else is wrong" } },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("Something else is wrong");
      expect(r.stdout + r.stderr).not.toContain("left as it was");
    } finally {
      server.stop();
    }
  });

  test("a missing dataset does not get the no-active-request hint", async () => {
    const server = startServer({
      [WITHDRAW]: { status: 404, body: { error: "Dataset not found" } },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("Dataset not found");
      expect(r.stdout + r.stderr).not.toContain("There is no active publication request");
    } finally {
      server.stop();
    }
  });

  test("no active request: says so and exits 1", async () => {
    const server = startServer({
      [WITHDRAW]: {
        status: 404,
        body: { error: "No active publication request found", code: "no_active_request" },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("There is no active publication request");
    } finally {
      server.stop();
    }
  });

  test("the no-request line follows the code, not the wording", async () => {
    // The same sentence without the code (an older or different backend) gets no
    // hint; the sentence itself is still printed.
    const server = startServer({
      [WITHDRAW]: { status: 404, body: { error: "No active publication request found" } },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("No active publication request found");
      expect(r.stdout + r.stderr).not.toContain("There is no active publication request for this");
    } finally {
      server.stop();
    }
  });
});

describe("the help text", () => {
  test("withdraw says whose command it is and that it is not the dataset-level one", async () => {
    const r = await runCli(["dataset", "publish", "withdraw", "--help-all"], "http://localhost:1");
    expect(r.exitCode).toBe(0);
    const out = r.stdout.replace(/\s+/g, " ");
    expect(out).toContain("withdrawn request");
    expect(out).toContain("Only the dataset owner can withdraw the request");
    expect(out).toContain(
      "an administrator may file a publication request on someone else's dataset",
    );
    expect(out).toContain("nemar admin publish deny");
    expect(out).toContain("not 'nemar admin withdraw'");
  });

  test("status lists denied, and says a withdrawn request is stored as denied", async () => {
    const r = await runCli(["dataset", "publish", "status", "--help-all"], "http://localhost:1");
    expect(r.exitCode).toBe(0);
    // No line offers `withdrawn` as a status value of its own.
    expect(r.stdout).not.toMatch(/^\s+withdrawn\s+-/m);
    expect(r.stdout.replace(/\s+/g, " ")).toContain("is stored as denied too");
  });
});

describe("how a withdrawal reads", () => {
  test("publish status says withdrawn and how to request again", async () => {
    const server = startServer({
      "GET /datasets/nm000104/publish/status": {
        body: {
          dataset_id: "nm000104",
          status: "denied",
          withdrawn: true,
          withdrawn_at: "2026-10-14 18:00:00",
          denied_reason: null,
          requested_at: "2026-10-14 12:00:00",
          requested_by: "alice",
          steps_completed: [],
          current_step: null,
          last_error: null,
          anonymous: false,
        },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(r.stdout).toContain("Status: withdrawn");
      expect(r.stdout).not.toContain("Status: denied");
      expect(r.stdout).toContain("nemar dataset publish request nm000104");
    } finally {
      server.stop();
    }
  });

  test("an ordinary denial still reads as denied, with its reason", async () => {
    const server = startServer({
      "GET /datasets/nm000104/publish/status": {
        body: {
          dataset_id: "nm000104",
          status: "denied",
          withdrawn: false,
          denied_reason: "incomplete",
          steps_completed: [],
        },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(r.stdout).toContain("Status: denied");
      expect(r.stdout).toContain("incomplete");
    } finally {
      server.stop();
    }
  });

  const LIST_BODY = {
    count: 2,
    requests: [
      {
        id: 1,
        dataset_id: "nm000104",
        dataset_name: "Motor imagery",
        status: "denied",
        withdrawn_at: "2026-10-14 18:00:00",
        requested_at: "2026-10-14 12:00:00",
        requested_by_username: "alice",
        requested_by_email: "alice@example.org",
        steps_completed: [],
        current_step: null,
        last_error: null,
      },
      {
        id: 2,
        dataset_id: "nm000105",
        dataset_name: "Sleep study",
        status: "denied",
        withdrawn_at: null,
        requested_at: "2026-10-14 12:00:00",
        requested_by_username: "bob",
        requested_by_email: "bob@example.org",
        steps_completed: [],
        current_step: null,
        last_error: null,
      },
    ],
  };

  // A withdrawn request is stored as `denied`, so it is listed wherever `denied`
  // is in scope and nowhere else: the default (active) list never asks for it,
  // and `withdrawn` is not a status the server accepts. What the CLI owes is to
  // send the right filter and to label the row.
  for (const [name, args, query] of [
    ["--denied", ["--denied"], "?status=denied"],
    ["-s denied", ["-s", "denied"], "?status=denied"],
    ["--published --denied", ["--published", "--denied"], "?status=published%2Cdenied"],
    ["--all", ["--all"], ""],
    [
      "--search with --denied",
      ["--denied", "--search", "nm00010"],
      "?status=denied&search=nm00010",
    ],
  ] as const) {
    test(`admin publish list ${name} labels a withdrawn request as withdrawn and a denial as denied`, async () => {
      const server = startServer({ "GET /admin/publish/requests": { body: LIST_BODY } });
      try {
        const r = await runCli(["admin", "publish", "list", ...args], server.url);
        expect(r.exitCode).toBe(0);
        expect(server.queries).toEqual([query]);
        expect(r.stdout).toMatch(/nm000104\s+withdrawn\s+by alice\s+\S+ \S+\s+Motor imagery/);
        expect(r.stdout).toMatch(/nm000105\s+denied\s+by bob\s+\S+ \S+\s+Sleep study/);
      } finally {
        server.stop();
      }
    });
  }

  test("admin publish list by default asks only for the active states, so no withdrawn row is requested", async () => {
    const server = startServer({
      "GET /admin/publish/requests": { body: { count: 0, requests: [] } },
    });
    try {
      const r = await runCli(["admin", "publish", "list"], server.url);
      expect(r.exitCode).toBe(0);
      // The union first; its empty answer is then confirmed once per active status (a Worker
      // that cannot take a comma list answers the union with nothing). A withdrawn request is
      // stored as `denied`, which no question here names.
      expect(server.queries).toEqual([
        "?status=requested%2Capproving%2Cblocked",
        "?status=requested",
        "?status=approving",
        "?status=blocked",
      ]);
      expect(r.stdout).toContain("Use --all to include every state");
    } finally {
      server.stop();
    }
  });
});
