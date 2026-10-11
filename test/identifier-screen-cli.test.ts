/**
 * The identifier screen in the terminal (epic #1610, phase 4), driven through
 * the real CLI entry point.
 *
 * Same harness as test/publish-anonymous-cli.test.ts: a real subprocess
 * (`bun run src/index.ts ...`) pointed at a local HTTP server that answers with
 * the backend's response shape, so what is asserted is what a person would read.
 * The CLI derives nothing about the screen: it prints the backend's
 * `describeScreen` words, so these tests check that the words arrive, and that
 * an older backend that sends no screen is not printed as a screen that failed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import chalk from "chalk";
import {
  dateWarningLines,
  describeScreen,
  parseScreenReport,
} from "../shared/identifier-screen-report";
import { identifierScreenLines } from "../src/lib/identifier-screen-display";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface Recorded {
  method: string;
  pathname: string;
  body: string;
}

function startServer(routes: Record<string, { status?: number; body: unknown }>) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push({ method: req.method, pathname: url.pathname, body: await req.text() });
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(route.body, { status: route.status ?? 200 });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-screen-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "screencli", accounts: { screencli: { apiKey: "k" } } }),
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

const FOUND = {
  state: "direct-identifiers",
  headline: "Identifier screen: FOUND IDENTIFIERS",
  tone: "stop",
  lines: [
    "Findings by kind: edf-patient-name x4.",
    "Scanner identifier-scan@abcdef1; commit 0123456789ab.",
  ],
};

describe("nemar dataset publish status", () => {
  test("prints the screen's headline and every line", async () => {
    const server = startServer({
      "GET /datasets/nm000104/publish/status": {
        body: {
          dataset_id: "nm000104",
          status: "blocked",
          block_reason: "identifier_screen_findings",
          message: "The identifier screen found direct identifiers.",
          identifier_screen: FOUND,
        },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Identifier screen: FOUND IDENTIFIERS");
      expect(r.stdout).toContain("Findings by kind: edf-patient-name x4.");
      expect(r.stdout).toContain("commit 0123456789ab");
    } finally {
      server.stop();
    }
  });

  test("an older backend that sends no screen prints no screen line at all", async () => {
    const server = startServer({
      "GET /datasets/nm000104/publish/status": {
        body: { dataset_id: "nm000104", status: "requested" },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("Identifier screen");
    } finally {
      server.stop();
    }
  });
});

describe("nemar dataset publish request", () => {
  const PENDING = {
    state: "pending",
    headline: "Identifier screen: running",
    tone: "note",
    lines: [],
  };
  const accepted = (id: string, over: Record<string, unknown> = {}) => ({
    message: "Publication request submitted",
    dataset_id: id,
    status: "requested",
    anonymous: false,
    identifier_screen: PENDING,
    ...over,
  });
  const key = (id: string) => `POST /datasets/${id}/publish/request`;
  const flat = (text: string) => text.replace(/\s+/g, " ");
  // The maintainer's wording of the notice, spelled out here on purpose: the
  // test must fail if the shared definition changes, so it cannot import it.
  const NOTICE = (id: string) =>
    `Your request was received. NEMAR is checking publication eligibility. If every check passes, an administrator is notified to approve it. You will be emailed if a check needs your attention, and when an administrator decides. Run 'nemar dataset publish status ${id}' to see where it stands.`;
  const CHECKING = "NEMAR is checking publication eligibility";

  test("an accepted request is told, in neutral words, what happens next", async () => {
    const server = startServer({ [key("nm000321")]: { body: accepted("nm000321") } });
    try {
      const r = await runCli(["dataset", "publish", "request", "nm000321"], server.url);
      expect(r.exitCode).toBe(0);
      // One sentence per line, indented like the screen block above it.
      expect(r.stdout).toContain(
        [
          "  Your request was received.",
          "  NEMAR is checking publication eligibility.",
          "  If every check passes, an administrator is notified to approve it.",
          "  You will be emailed if a check needs your attention, and when an administrator decides.",
          "  Run 'nemar dataset publish status nm000321' to see where it stands.",
          "",
        ].join("\n"),
      );
      expect(flat(r.stdout)).toContain(NOTICE("nm000321"));
      expect(r.stdout).toContain("Identifier screen: running");
      // The two lines this replaces depended on the screen's state ("Admins
      // will be notified when the identifier screen finishes" / "Admins have
      // been notified"). The notice is one answer whatever the state is.
      expect(r.stdout).not.toContain("Admins will be notified when the identifier screen");
      expect(r.stdout).not.toContain("Admins have been notified");
    } finally {
      server.stop();
    }
  });

  test("it is the same five lines whatever screen state the backend sent, and nothing follows it", async () => {
    // The screen runs after the request and its verdict is bound to a commit,
    // so the notice must not depend on what the screen holds. The block ABOVE
    // it is the backend's own words for the state (the date warning cannot be
    // in it: no count exists before the screen has reported).
    const states: Array<[string, unknown]> = [
      ["pending", PENDING],
      [
        "did not run",
        {
          state: "error",
          headline: "Identifier screen: DID NOT RUN",
          tone: "stop",
          lines: ["Cause: GitHub refused to start the screen workflow."],
        },
      ],
      [
        "exempt",
        {
          state: "exempt",
          headline: "Identifier screen: not applicable (sandbox)",
          tone: "note",
          lines: [],
        },
      ],
      ["an older backend that sends no screen", undefined],
    ];
    for (const [label, screen] of states) {
      const id = "xx099901";
      const server = startServer({
        [key(id)]: { body: accepted(id, { identifier_screen: screen }) },
      });
      try {
        const r = await runCli(["dataset", "publish", "request", id], server.url);
        expect(r.exitCode, label).toBe(0);
        expect(flat(r.stdout), label).toContain(NOTICE(id));
        expect(r.stdout, label).not.toContain("Admins have been notified");
        // Everything from the notice on is the notice and nothing else, so a
        // line added after it (a banner, an old "Admins have been notified")
        // fails here; no verdict word, count or date warning is in it.
        const after = r.stdout.slice(r.stdout.indexOf("Your request was received."));
        expect(after, label).not.toMatch(
          /\b(clean|found|findings?|warning|acquisition|dates?|review)\b/i,
        );
        expect(after.trim().split("\n"), label).toHaveLength(5);
      } finally {
        server.stop();
      }
    }
  });

  test("an anonymous release is told the same, beside the line about its identity", async () => {
    const server = startServer({
      [key("nm000321")]: {
        body: accepted("nm000321", { message: "Anonymous release requested", anonymous: true }),
      },
    });
    try {
      const r = await runCli(
        ["dataset", "publish", "request", "nm000321", "--anonymous"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Your identity will be withheld");
      expect(flat(r.stdout)).toContain(NOTICE("nm000321"));
    } finally {
      server.stop();
    }
  });

  test("the command the sentence tells the requester to run is a real one", async () => {
    // A pointer to a command that does not exist is the failure this catches:
    // take the command from what was PRINTED and run it.
    const id = "nm000321";
    const server = startServer({
      [key(id)]: { body: accepted(id) },
      [`GET /datasets/${id}/publish/status`]: {
        body: { dataset_id: id, status: "requested", anonymous: false },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "request", id], server.url);
      const printed = r.stdout.match(/Run '(nemar dataset publish status [^']+)'/);
      expect(printed).not.toBeNull();
      const [bin, ...args] = (printed?.[1] ?? "").split(" ");
      expect(bin).toBe("nemar");
      const s = await runCli(args, server.url);
      expect(s.exitCode).toBe(0);
      expect(s.stdout).toContain(`Publication Status: ${id}`);
    } finally {
      server.stop();
    }
  });

  describe("a request refused up front keeps its own text and gets no notice", () => {
    const refusals: Array<{
      label: string;
      status: number;
      body: Record<string, unknown>;
      text: string[];
    }> = [
      {
        label: "one is already open (409)",
        status: 409,
        body: {
          error: "A publication request already exists",
          status: "requested",
          message: "Use 'resend' to remind admins",
        },
        text: ["A publication request already exists", "nemar dataset publish resend"],
      },
      {
        label: "not the owner (403)",
        status: 403,
        body: { error: "Only the dataset owner can request publication" },
        text: ["Only the dataset owner can request publication"],
      },
      {
        label: "already published (409)",
        status: 409,
        body: { error: "Dataset is already published" },
        text: ["Dataset is already published"],
      },
      {
        label: "blocked by the submission minimums (422)",
        status: 422,
        body: {
          status: "blocked",
          block_reason: "min_requirements_failed",
          message: "The dataset does not meet the minimum submission requirements.",
          reasons: ["The README is missing."],
          policy_url: "https://example.org/policy",
          details: {
            reasons: ["The README is missing."],
            policy_url: "https://example.org/policy",
          },
        },
        text: ["Not accepted for publication:", "The README is missing."],
      },
    ];
    for (const refusal of refusals) {
      test(refusal.label, async () => {
        const server = startServer({
          [key("nm000321")]: { status: refusal.status, body: refusal.body },
        });
        try {
          const r = await runCli(["dataset", "publish", "request", "nm000321"], server.url);
          expect(r.exitCode).toBe(1);
          const out = r.stdout + r.stderr;
          for (const text of refusal.text) expect(out).toContain(text);
          expect(out).not.toContain(CHECKING);
          expect(out).not.toContain("Your request was received");
          expect(out).not.toContain("to see where it stands");
        } finally {
          server.stop();
        }
      });
    }

    test("a re-request that is then accepted is told, and the refusal before it was not", async () => {
      // The depositor fixes what blocked the request and asks again: the
      // backend reuses the open row and answers like any accepted request.
      const id = "nm000321";
      const routes: Record<string, { status?: number; body: unknown }> = {
        [key(id)]: {
          status: 422,
          body: {
            status: "blocked",
            block_reason: "bids_validation_failed",
            message: "BIDS validation is failing on your dataset.",
          },
        },
      };
      const server = startServer(routes);
      try {
        const first = await runCli(["dataset", "publish", "request", id], server.url);
        expect(first.exitCode).toBe(1);
        expect(first.stdout + first.stderr).not.toContain(CHECKING);

        routes[key(id)] = { body: accepted(id) };
        const second = await runCli(["dataset", "publish", "request", id], server.url);
        expect(second.exitCode).toBe(0);
        expect(flat(second.stdout)).toContain(NOTICE(id));
      } finally {
        server.stop();
      }
    });
  });
});

describe("nemar dataset publish resend", () => {
  test("a running screen is refused with the backend's sentence, not its code", async () => {
    const server = startServer({
      "POST /datasets/nm000104/publish/resend": {
        status: 409,
        body: {
          error: "identifier_screen_pending",
          message:
            "The identifier screen is still running. The admins are mailed when it finishes, with its result, so there is nothing to resend yet.",
        },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "resend", "nm000104"], server.url);
      expect(r.exitCode).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).toContain("The identifier screen is still running");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin publish list", () => {
  test("prints each request's screen under it", async () => {
    const server = startServer({
      "GET /admin/publish/requests": {
        body: {
          count: 1,
          requests: [
            {
              id: 1,
              dataset_id: "nm000104",
              status: "blocked",
              requested_at: "2026-10-05 12:00:00",
              requested_by_username: "alice",
              requested_by_email: "alice@example.org",
              steps_completed: [],
              current_step: null,
              last_error: null,
              identifier_screen: FOUND,
            },
          ],
        },
      },
    });
    try {
      const r = await runCli(["admin", "publish", "list"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("nm000104");
      expect(r.stdout).toContain("Identifier screen: FOUND IDENTIFIERS");
      expect(r.stdout).toContain("edf-patient-name x4");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin publish approve --acknowledge-identifier-screen", () => {
  const routes = {
    "GET /datasets/nm000104/publish/status": {
      body: { dataset_id: "nm000104", status: "requested", anonymous: false },
    },
    "POST /admin/publish/nm000104/approve": {
      body: { message: "Dataset published successfully", dataset_id: "nm000104" },
    },
  };

  test("sends the reason, trimmed, with the approval", async () => {
    const server = startServer(routes);
    try {
      const r = await runCli(
        [
          "admin",
          "publish",
          "approve",
          "nm000104",
          "--yes",
          "--acknowledge-identifier-screen",
          "  Free text is a device serial number.  ",
        ],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      const posted = server.requests.filter((q) => q.pathname.endsWith("/approve"));
      expect(posted).toHaveLength(1);
      expect(JSON.parse(posted[0].body).acknowledge_identifier_screen).toBe(
        "Free text is a device serial number.",
      );
    } finally {
      server.stop();
    }
  });

  test("without the flag the approval carries no acknowledgment", async () => {
    const server = startServer(routes);
    try {
      const r = await runCli(["admin", "publish", "approve", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(0);
      const posted = server.requests.filter((q) => q.pathname.endsWith("/approve"));
      expect("acknowledge_identifier_screen" in JSON.parse(posted[0].body)).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a reason under 10 characters is refused before anything is sent", async () => {
    const server = startServer(routes);
    try {
      const r = await runCli(
        [
          "admin",
          "publish",
          "approve",
          "nm000104",
          "--yes",
          "--acknowledge-identifier-screen",
          "ok",
        ],
        server.url,
      );
      expect(r.exitCode).toBe(1);
      expect(server.requests.filter((q) => q.pathname.endsWith("/approve"))).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("a refusal by the screen prints the backend's sentence", async () => {
    const server = startServer({
      ...routes,
      "POST /admin/publish/nm000104/approve": {
        status: 409,
        body: {
          error: "identifier_screen_not_clear",
          gate: "rerun",
          headline: "Identifier screen: DID NOT RUN",
          message:
            "Identifier screen: DID NOT RUN. Approval waits for a screen that produced a verdict: run it again with nemar admin publish screen nm000104.",
        },
      },
    });
    try {
      const r = await runCli(["admin", "publish", "approve", "nm000104", "--yes"], server.url);
      expect(r.stdout + r.stderr).toContain("nemar admin publish screen nm000104");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin publish screen", () => {
  test("posts the re-run and says the admins are mailed when it reports", async () => {
    const server = startServer({
      "POST /admin/publish/nm000104/identifier-screen": {
        status: 202,
        body: {
          dataset_id: "nm000104",
          request_id: 7,
          status: "pending",
          identifier_screen: {
            state: "pending",
            headline: "Identifier screen: running",
            tone: "note",
            lines: [],
          },
        },
      },
    });
    try {
      const r = await runCli(["admin", "publish", "screen", "nm000104"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.requests.map((q) => `${q.method} ${q.pathname}`)).toContain(
        "POST /admin/publish/nm000104/identifier-screen",
      );
      expect(r.stdout + r.stderr).toContain("mailed when it reports");
    } finally {
      server.stop();
    }
  });

  test("a screen that could not start shows the result the admins were mailed", async () => {
    const server = startServer({
      "POST /admin/publish/nm000104/identifier-screen": {
        status: 202,
        body: {
          dataset_id: "nm000104",
          request_id: 7,
          status: "error",
          identifier_screen: {
            state: "error",
            headline: "Identifier screen: DID NOT RUN",
            tone: "stop",
            lines: ["Cause: GitHub refused to start the screen workflow."],
          },
        },
      },
    });
    try {
      const r = await runCli(["admin", "publish", "screen", "nm000104"], server.url);
      const out = r.stdout + r.stderr;
      expect(out).toContain("Identifier screen: DID NOT RUN");
      expect(out).toContain("GitHub refused to start the screen workflow");
    } finally {
      server.stop();
    }
  });
});

// The words below are made by the real `describeScreen` from a parsed report, not typed here, so
// what is asserted is what the backend would send and the terminal would print.
describe("the acquisition-date warning in the terminal (ADR 0090)", () => {
  const DATED = parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: "0123456789abcdef0123456789abcdef01234567",
    scan: {
      id: "nm000104",
      version: null,
      scanned_at: "2026-10-07T12:00:00.000Z",
      manifest_source: "clone",
      status: "dates-only",
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
      findings_by_kind: { "edf-startdate": 4, "acq-time-dated": 2 },
      edf_bdf_files_flagged: 0,
      unscreened_formats: {},
    },
  });
  const view = { state: "dates-only", ...describeScreen("dates-only", DATED) };
  const WARNING = dateWarningLines({
    findings_by_kind: { "edf-startdate": 4, "acq-time-dated": 2 },
  });

  test("the view carries the warning, whole, from one definition", () => {
    expect(WARNING).toHaveLength(5);
    expect(view.lines).toEqual(expect.arrayContaining(WARNING));
    expect(WARNING[0]).toContain("(6 entries)");
  });

  test("nemar dataset publish status prints it under the verdict, in order", async () => {
    const server = startServer({
      "GET /datasets/nm000104/publish/status": {
        body: { dataset_id: "nm000104", status: "requested", identifier_screen: view },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Identifier screen: clean (acquisition dates only)");
      const at = WARNING.map((line) => r.stdout.indexOf(line));
      expect(at.every((i) => i > 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(at[0]).toBeGreaterThan(r.stdout.indexOf("Findings by kind:"));
    } finally {
      server.stop();
    }
  });

  test("nemar admin publish list prints it under each request that has dates", async () => {
    const server = startServer({
      "GET /admin/publish/requests": {
        body: {
          count: 1,
          requests: [
            {
              id: 1,
              dataset_id: "nm000104",
              status: "requested",
              requested_at: "2026-10-07 12:00:00",
              requested_by_username: "alice",
              requested_by_email: "alice@example.org",
              steps_completed: [],
              current_step: null,
              last_error: null,
              identifier_screen: view,
            },
          ],
        },
      },
    });
    try {
      const r = await runCli(["admin", "publish", "list"], server.url);
      expect(r.exitCode).toBe(0);
      for (const line of WARNING) expect(r.stdout).toContain(line);
      expect(r.stdout).toContain("edf-startdate x4, acq-time-dated x2");
    } finally {
      server.stop();
    }
  });

  test("a screen with no date finding prints no warning", async () => {
    const server = startServer({
      "GET /datasets/nm000104/publish/status": {
        body: { dataset_id: "nm000104", status: "blocked", identifier_screen: FOUND },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(r.stdout).not.toContain("Warning: acquisition dates");
    } finally {
      server.stop();
    }
  });

  test("the terminal sets the warning apart in the warning color, and no count line", () => {
    const before = chalk.level;
    chalk.level = 1;
    try {
      const printed = identifierScreenLines(view, 2);
      const YELLOW = "\u001b[33m";
      const DIM = "\u001b[2m";
      const warned = printed.filter((line) => line.includes(YELLOW));
      expect(warned).toHaveLength(5);
      for (const line of WARNING) expect(warned.some((w) => w.includes(line))).toBe(true);
      const counts = printed.find((line) => line.includes("Findings by kind:"));
      expect(counts).toContain(DIM);
      expect(counts).not.toContain(YELLOW);
    } finally {
      chalk.level = before;
    }
  });
});
