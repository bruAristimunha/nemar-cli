/**
 * `nemar dataset publish request --anonymous` (#1408, epic #1406), driven
 * through the real CLI entry point.
 *
 * Same harness as test/has-zarr-cli-flag.test.ts: a real subprocess
 * (`bun run src/index.ts ...`) pointed at a real local HTTP server via
 * TEST_API_URL, so the recorded body is what the CLI's own `fetch()` actually
 * sent rather than a re-implementation of it.
 *
 * What makes this worth writing: the flag's entire job is to reach the wire.
 * An ordinary publication request posts NO body at all, and a `--anonymous`
 * request that silently lost its flag would look identical from the terminal
 * -- the depositor would be told their release was requested and would be
 * published under their own name instead. Both directions are asserted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface Recorded {
  pathname: string;
  body: string;
}

interface CaptureServer {
  url: string;
  requests: Recorded[];
  stop: () => void;
}

function startCaptureServer(body: unknown, status = 200): CaptureServer {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Every real `nemar` invocation fires a `GET /notices` preAction hook,
      // and commands can fire a fire-and-forget facets refresh. Both are
      // genuine traffic this server must answer, and neither is what this
      // test checks.
      if (url.pathname === "/notices") {
        return Response.json({ notices: [] });
      }
      if (url.pathname === "/datasets/facets") {
        return Response.json({});
      }
      requests.push({ pathname: url.pathname, body: await req.text() });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-publish-anon-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "anoncli",
      accounts: { anoncli: { apiKey: "test-anon-key" } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  testApiUrl: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

const ACCEPTED = {
  message: "Publication requested",
  dataset_id: "nm000104",
  status: "requested",
};

describe("nemar dataset publish request --anonymous", () => {
  test("sends anonymous: true in the request body", async () => {
    // Answered with the confirmation a real backend sends. Without it the
    // release is unconfirmed, which exits 1 (see the tests below).
    const server = startCaptureServer({ ...ACCEPTED, anonymous: true });
    try {
      const result = await runCli(
        ["dataset", "publish", "request", "nm000104", "--anonymous"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      const posted = server.requests.filter((r) => r.pathname.endsWith("/publish/request"));
      expect(posted.length).toBe(1);
      expect(JSON.parse(posted[0].body)).toEqual({ anonymous: true });
    } finally {
      server.stop();
    }
  });

  test("without the flag the request carries no body at all", async () => {
    // The control, and it also pins a compatibility fact: an ordinary
    // publication request has always been a bodyless POST, and it stays one.
    const server = startCaptureServer(ACCEPTED);
    try {
      const result = await runCli(["dataset", "publish", "request", "nm000104"], server.url);
      expect(result.exitCode).toBe(0);
      const posted = server.requests.filter((r) => r.pathname.endsWith("/publish/request"));
      expect(posted.length).toBe(1);
      expect(posted[0].body).toBe("");
    } finally {
      server.stop();
    }
  });

  test("a confirmed anonymous release says so, from the SERVER's answer", async () => {
    // The distinction that matters is not "the word anonymous appears" -- the
    // spinner prints that from the flag that was TYPED, so it appears even
    // when the backend recorded an ordinary publication. What has to be
    // printed is what came back. Asserted with the negative, because an
    // earlier version of this test passed in both states and therefore
    // exercised only one of them.
    const server = startCaptureServer({ ...ACCEPTED, anonymous: true });
    try {
      const result = await runCli(
        ["dataset", "publish", "request", "nm000104", "--anonymous"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Your identity will be withheld");
      expect(result.stdout).not.toContain("did not confirm");
    } finally {
      server.stop();
    }
  });

  test("a flag that did not reach the backend is a WARNING, not a success", async () => {
    // The case the echo exists for: a stripped body, a proxy that rewrote it,
    // an older backend. Without this the depositor is told their release was
    // requested and finds out at publication, under their own name.
    const server = startCaptureServer(ACCEPTED);
    try {
      const result = await runCli(
        ["dataset", "publish", "request", "nm000104", "--anonymous"],
        server.url,
      );
      expect(result.stdout).toContain("did not confirm");
      expect(result.stdout).not.toContain("Your identity will be withheld");
      // A script must not go on as if the release were blind: it would be
      // published under the real name.
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("an explicit anonymous: false is the same warning", async () => {
    // Distinguished from the absent case only in that the backend answered.
    // Both mean the depositor asked to be concealed and was not.
    const server = startCaptureServer({ ...ACCEPTED, anonymous: false });
    try {
      const result = await runCli(
        ["dataset", "publish", "request", "nm000104", "--anonymous"],
        server.url,
      );
      expect(result.stdout).toContain("did not confirm");
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("an ordinary request says nothing about anonymity", async () => {
    // The control. A depositor who did not ask for concealment must not be
    // shown either line.
    const server = startCaptureServer({ ...ACCEPTED, anonymous: false });
    try {
      const result = await runCli(["dataset", "publish", "request", "nm000104"], server.url);
      expect(result.stdout).not.toContain("did not confirm");
      expect(result.stdout).not.toContain("Your identity will be withheld");
    } finally {
      server.stop();
    }
  });
});

describe("nemar dataset publish status reports the recorded intent", () => {
  const REQUESTED = {
    dataset_id: "nm000104",
    status: "requested",
    requested_at: "2026-01-01T00:00:00Z",
    requested_by: "depositor",
    steps_completed: [],
    current_step: null,
    last_error: null,
    updated_at: "2026-01-01T00:00:00Z",
  };

  test("an anonymous release is named, with what it means", async () => {
    // The one surface between `--anonymous` and an admin's approval where a
    // depositor can check what was actually recorded.
    const server = startCaptureServer({ ...REQUESTED, anonymous: true });
    try {
      const result = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Anonymous: yes/);
      expect(result.stdout).toContain("repository stays private");
    } finally {
      server.stop();
    }
  });

  test("an ordinary request says so rather than staying silent", async () => {
    // Printed on BOTH values deliberately: a depositor re-requesting a normal
    // publication needs to see that a stale flag from an earlier request is
    // not about to conceal them.
    const server = startCaptureServer({ ...REQUESTED, anonymous: false });
    try {
      const result = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(result.stdout).toMatch(/Anonymous: no/);
      expect(result.stdout).not.toMatch(/Anonymous: yes/);
    } finally {
      server.stop();
    }
  });

  test("an older backend that sends no flag prints no line", async () => {
    // Absent means UNKNOWN, never "no". Printing "Anonymous: no" from a
    // missing field would state a fact the backend never asserted.
    const server = startCaptureServer(REQUESTED);
    try {
      const result = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(result.stdout).not.toContain("Anonymous:");
    } finally {
      server.stop();
    }
  });
});

describe("nemar dataset status reports the state", () => {
  function statusServer(anonymous: number | null): CaptureServer {
    return startCaptureServer({
      dataset: {
        dataset_id: "nm000104",
        name: "A study of something",
        status: "active",
        visibility: "public",
        created_at: "2026-01-01T00:00:00Z",
        github_repo: "nemarDatasets/nm000104",
        concept_doi: "10.82901/reserved-test",
        anonymous,
      },
    });
  }

  test("an anonymous deposit is named as such, and its repository is not offered", async () => {
    // `visibility: public` with no authors reads as an incomplete record
    // unless the state is stated. And the repository is PRIVATE, so printing
    // its URL offers a link that 404s while disclosing the repo exists.
    const server = statusServer(1);
    try {
      const result = await runCli(["dataset", "status", "nm000104"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Anonymous:\s+identity withheld until publication/);
      expect(result.stdout).toContain("without --anonymous");
      expect(result.stdout).not.toContain("github.com/nemarDatasets/nm000104");
      // The reserved identifier does not resolve, so it must not be offered as
      // a bare link a depositor could paste into a blinded submission. The
      // landing page is what they cite during review.
      expect(result.stdout).toMatch(/DOI:.*\(reserved\)/);
      expect(result.stdout).toMatch(/Cite:\s+https:\/\/\S*nemar\.org\/dataset\/nm000104/);
    } finally {
      server.stop();
    }
  });

  test("an ordinary dataset shows its repository and no anonymity line", async () => {
    // The control: the same payload minus the flag must behave as it always has.
    const server = statusServer(0);
    try {
      const result = await runCli(["dataset", "status", "nm000104"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("github.com/nemarDatasets/nm000104");
      expect(result.stdout).not.toContain("Anonymous:");
      // The control: a published DOI is still offered as a plain link.
      expect(result.stdout).toContain("https://doi.org/10.82901/reserved-test");
      expect(result.stdout).not.toContain("(reserved)");
    } finally {
      server.stop();
    }
  });
});
