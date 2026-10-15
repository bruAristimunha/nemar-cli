/**
 * CLI-level tests for the --debug diagnostic bundle (issue #1256, epic
 * #1250 phase 6): the failure hint (and its --json / usage-error
 * suppression), the debug log's redacted content, and log rotation.
 *
 * All driven through the real `nemar` entry point via Bun.spawn, following
 * the pattern already used across test/ (e.g. test/manifest.test.ts,
 * test/search-color.unit.test.ts): NEMAR_CONFIG_DIR isolates config/logs
 * per test, TEST_API_URL points network calls at either a deliberately
 * unreachable address (127.0.0.1:1, reserved+unused -- test/rate-limit-retry.test.ts's
 * precedent) or a real local Bun.serve stub. Subprocess isolation also
 * sidesteps the shared-module-state risk that would come from touching
 * src/lib/debug-log.ts's or src/lib/config.ts's module-level state
 * in-process (see MEMORY: bun-test-shared-process-root-and-backend).
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

// Every test here spawns a real `nemar` subprocess, several of which (the
// `doctor`/`--report`/`--debug` ones) themselves spawn five MORE subprocesses
// to probe external tools. Under the full suite's parallel load this can
// blow past bun:test's 5s default even though each spawn is fast in
// isolation -- test/cli.test.ts sets the same 30s budget for the same reason
// (a `doctor --report` run was observed to take just over 5s under full-suite
// contention and get killed mid-test, which showed up as both a failed test
// and an "Unhandled error between tests" from the orphaned subprocess).
setDefaultTimeout(30000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const UNREACHABLE = "http://127.0.0.1:1";
const HINT_URL = "https://github.com/nemarOrg/nemar-cli/issues/new?template=bug_report.yml";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "nemar-debug-cli-"));
}

function writeConfig(configDir: string, config: Record<string, unknown>): void {
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

async function runCli(
  args: string[],
  configDir: string,
  testApiUrl: string | undefined,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: testApiUrl ?? "",
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      ...extraEnv,
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

describe("failure hint (#1256)", () => {
  test("prints the hint on a real failing command", async () => {
    const configDir = makeConfigDir();
    writeConfig(configDir, { apiKey: "fake-key", apiUrl: UNREACHABLE, username: "test" });
    const result = await runCli(["dataset", "manifest", "-d", "nm000104"], configDir, UNREACHABLE);
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(HINT_URL);
  });

  test("--json suppresses the hint", async () => {
    const configDir = makeConfigDir();
    writeConfig(configDir, { apiKey: "fake-key", apiUrl: UNREACHABLE, username: "test" });
    const result = await runCli(
      ["dataset", "manifest", "-d", "nm000104", "--json"],
      configDir,
      UNREACHABLE,
    );
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(HINT_URL);
  });

  test("a Commander usage error suppresses the hint", async () => {
    const configDir = makeConfigDir();
    const result = await runCli(
      ["dataset", "manifest", "--this-flag-does-not-exist"],
      configDir,
      undefined,
    );
    rmSync(configDir, { recursive: true, force: true });

    // Commander's own usage-error exit; it already explained itself.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error:");
    expect(result.stderr).not.toContain(HINT_URL);
  });

  test("NEMAR_DEBUG=1 (no --debug flag) also prints the log path", async () => {
    const configDir = makeConfigDir();
    writeConfig(configDir, { apiKey: "fake-key", apiUrl: UNREACHABLE, username: "test" });
    const result = await runCli(["dataset", "manifest", "-d", "nm000104"], configDir, UNREACHABLE, {
      NEMAR_DEBUG: "1",
    });
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(HINT_URL);
    expect(result.stderr).toContain("Debug log:");
  });

  test("--debug prints the log path instead of the generic hint", async () => {
    const configDir = makeConfigDir();
    writeConfig(configDir, { apiKey: "fake-key", apiUrl: UNREACHABLE, username: "test" });
    const result = await runCli(
      ["--debug", "dataset", "manifest", "-d", "nm000104"],
      configDir,
      UNREACHABLE,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(HINT_URL);
    expect(result.stderr).toContain("Debug log:");

    const logPath = result.stderr
      .split("\n")
      .find((line) => line.startsWith("Debug log:"))
      ?.replace("Debug log:", "")
      .trim();
    expect(logPath).toBeTruthy();
    const content = readFileSync(logPath as string, "utf8");
    expect(content).toContain("Exit code: 1");
    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("--debug log content is redacted (real request, real failure)", () => {
  test("request body, response body, and the command line are redacted", async () => {
    const configDir = makeConfigDir();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            valid: true,
            user: {
              username: "alice",
              email: "alice@example.com",
              github_username: "alice-gh",
              role: "member",
              sandbox_completed: false,
            },
            aws_secret_access_key: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
            note: "Bearer abcDEF123456.token-part",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const apiUrl = `http://localhost:${server.port}`;
    const fakeApiKey = "sk-fake-cli-test-secret-0123456789";

    const result = await runCli(["--debug", "login", "-k", fakeApiKey], configDir, apiUrl);
    server.stop(true);

    // A successful login exits 0, so the failure hint (and the log-path
    // line that replaces it) never fires -- the log is still written
    // unconditionally whenever --debug is on, so read it directly.
    expect(result.exitCode).toBe(0);
    const logsDir = join(configDir, "logs");
    const logFiles = readdirSync(logsDir);
    expect(logFiles.length).toBe(1);

    // Item 20 (CRITICAL, reviewer-reproduced): the FILENAME itself used to
    // leak the key, since `nemar login -k <key>` is only one word before
    // the flag and the key became buildCommandLabel's second "non-flag
    // token" -- and this is the exact file the issue form tells users to
    // drag onto GitHub. Must never appear in the filename, on ANY exit
    // (this one is a successful login, exit 0).
    expect(logFiles[0]).not.toContain(fakeApiKey);
    expect(logFiles[0]).toContain("-login.log");

    const content = readFileSync(join(logsDir, logFiles[0]), "utf8");

    // Command line: the -k value must never appear in the clear.
    expect(content).not.toContain(fakeApiKey);
    expect(content).toContain("Command: nemar --debug login -k [REDACTED]");

    // Request body: {"api_key": "<fakeApiKey>"} -> key fully redacted.
    expect(content).toContain('"api_key":"[REDACTED]"');

    // Response body: email masked, AWS secret masked, Bearer token masked.
    expect(content).not.toContain("alice@example.com");
    expect(content).toContain("a***@example.com");
    expect(content).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
    expect(content).not.toContain("Bearer abcDEF123456.token-part");
    expect(content).toContain("Bearer [REDACTED]");

    // Non-sensitive fields survive.
    expect(content).toContain("alice-gh");

    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("--debug never writes the approval dispatch token (ADR 0105 decision 2)", () => {
  // The executor of a web approval hands the CLI a per-claim token (env var, then a header on
  // every `/approve` call). The token is not the API key, so the log's header redaction did not
  // know it, and the debug log is the file users are told to drag onto a public issue. This runs
  // the real client and the real log writer in a real process: a request that carries the header
  // against a real local server, in debug mode, and then reads the file back. The CLI command
  // that sends the header at its call site is covered where that command is.
  test("the header is redacted in the log file, and the rest of the request still is there", async () => {
    const configDir = makeConfigDir();
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("x-approval-dispatch-token") ?? "");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const token = "5ecb4c0ffee0123456789abcdef0123456789abcdef0123456789abcdefd1ce";
    const script = `
      const { enableDebug, writeDebugLogSync } = await import(${JSON.stringify(join(REPO_ROOT, "src/lib/debug-log"))});
      const { request } = await import(${JSON.stringify(join(REPO_ROOT, "src/lib/api/client"))});
      enableDebug();
      await request("/admin/publish/nm000123/approve", {
        method: "POST",
        headers: { "X-Approval-Dispatch-Token": process.env.DEBUG_PROBE_TOKEN },
        body: JSON.stringify({ resume: true }),
      }, false);
      console.log(writeDebugLogSync(["admin", "publish", "approve", "nm000123"], 0));
    `;
    const proc = spawn({
      cmd: ["bun", "-e", script],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NEMAR_CONFIG_DIR: configDir,
        TEST_API_URL: `http://localhost:${server.port}`,
        DEBUG_PROBE_TOKEN: token,
        NEMAR_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    server.stop(true);

    // Debug mode narrates each exchange on stderr, so the live output must not hold it either.
    expect(stderr).not.toContain(token);
    expect(exitCode).toBe(0);
    // The control: the server received the real token, so the request is the one that was logged.
    expect(seen).toEqual([token]);
    const logPath = stdout.trim().split("\n").pop() as string;
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("POST ");
    expect(content).toContain("/admin/publish/nm000123/approve");
    expect(content).not.toContain(token);
    expect(content).toMatch(/"X-Approval-Dispatch-Token":"\[REDACTED\]"/);
    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("--debug redacts attached-value flag spellings (#1257 item 24)", () => {
  // CRITICAL, reviewer-reproduced: redactArgv/stripSecretFlagValues matched
  // SECRET_FLAGS by exact token equality, so the two attached-value
  // spellings Commander itself accepts for `-k`/`--key` slipped through
  // untouched and put the raw key in the "Command:" line (the filename was
  // never at risk from these two spellings -- see item 20's test for why).
  function makeLoginOkServer() {
    return Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            valid: true,
            user: {
              username: "carol",
              email: "carol@example.com",
              github_username: "carol-gh",
              role: "member",
              sandbox_completed: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
  }

  test("--key=<value> never appears, in the log content or the filename", async () => {
    const configDir = makeConfigDir();
    const server = makeLoginOkServer();
    const apiUrl = `http://localhost:${server.port}`;
    const fakeApiKey = "sk-fake-eq-spelling-secret-0123456789";

    const result = await runCli(["--debug", "login", `--key=${fakeApiKey}`], configDir, apiUrl);
    server.stop(true);

    expect(result.exitCode).toBe(0);
    const logsDir = join(configDir, "logs");
    const logFiles = readdirSync(logsDir);
    expect(logFiles.length).toBe(1);
    expect(logFiles[0]).not.toContain(fakeApiKey);

    const content = readFileSync(join(logsDir, logFiles[0]), "utf8");
    expect(content).not.toContain(fakeApiKey);
    expect(content).toContain("Command: nemar --debug login --key=[REDACTED]");

    rmSync(configDir, { recursive: true, force: true });
  });

  test("-k<value> (no separator) never appears, in the log content or the filename", async () => {
    const configDir = makeConfigDir();
    const server = makeLoginOkServer();
    const apiUrl = `http://localhost:${server.port}`;
    const fakeApiKey = "sk-fake-attached-spelling-secret-0123456789";

    const result = await runCli(["--debug", "login", `-k${fakeApiKey}`], configDir, apiUrl);
    server.stop(true);

    expect(result.exitCode).toBe(0);
    const logsDir = join(configDir, "logs");
    const logFiles = readdirSync(logsDir);
    expect(logFiles.length).toBe(1);
    expect(logFiles[0]).not.toContain(fakeApiKey);

    const content = readFileSync(join(logsDir, logFiles[0]), "utf8");
    expect(content).not.toContain(fakeApiKey);
    expect(content).toContain("Command: nemar --debug login -k[REDACTED]");

    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("nemar doctor --report", () => {
  test("prints the environment section with no HTTP trace", async () => {
    const configDir = makeConfigDir();
    const result = await runCli(["doctor", "--report"], configDir, undefined);
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CLI version:");
    expect(result.stdout).toContain("External tools:");
    expect(result.stdout).not.toContain("HTTP requests:");
  });

  // Item D11: an authenticated account's username/role show up, and the
  // key never does -- this is the whole point of the "no credential" rule.
  //
  // Written directly in the nested `accounts` shape (rather than the flat
  // legacy shape migrateConfig() upgrades), since `role` is new in this
  // phase and was never part of that legacy flat shape -- there is nothing
  // for a migration path to carry over.
  test("authenticated: shows username and role, never the API key", async () => {
    const configDir = makeConfigDir();
    const fakeApiKey = "sk-fake-doctor-report-secret-999";
    writeConfig(configDir, {
      activeAccount: "alice",
      accounts: {
        alice: {
          apiKey: fakeApiKey,
          apiUrl: "https://example.invalid",
          username: "alice",
          role: "admin",
        },
      },
    });
    const result = await runCli(["doctor", "--report"], configDir, undefined);
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Username: alice");
    expect(result.stdout).toContain("Role: admin");
    expect(result.stdout).not.toContain(fakeApiKey);
  });

  // Item 22: a config predating the `role` field (this phase's own addition)
  // must still load without crashing, and simply omit the Role line.
  test("a pre-existing config without `role` loads fine and omits the Role line", async () => {
    const configDir = makeConfigDir();
    writeConfig(configDir, {
      apiKey: "fake-key",
      apiUrl: "https://example.invalid",
      username: "legacy-user",
      // no `role` field -- this is the shape every account had before #1257
    });
    const result = await runCli(["doctor", "--report"], configDir, undefined);
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Username: legacy-user");
    expect(result.stdout).not.toContain("Role:");
  });
});

describe("unwritable log directory (#1257 item D12)", () => {
  test("a failing command still exits with its own code; write failure is reported, not a crash", async () => {
    const configDir = makeConfigDir();
    // Create a FILE named "logs" so mkdirSync({recursive:true}) fails with
    // ENOTDIR/EEXIST rather than the log directory ever existing.
    writeFileSync(join(configDir, "logs"), "not a directory");
    writeConfig(configDir, { apiKey: "fake-key", apiUrl: UNREACHABLE, username: "test" });

    const result = await runCli(
      ["--debug", "dataset", "manifest", "-d", "nm000104"],
      configDir,
      UNREACHABLE,
    );
    rmSync(configDir, { recursive: true, force: true });

    // The wrapped command's own exit code is unaffected by the diagnostic
    // machinery failing to write its own log.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(HINT_URL);
    // Item 6: the failure reason is surfaced, not swallowed by a bare catch
    // -- both in the final hint line and as its own [debug] line naming the
    // exact path that couldn't be created.
    expect(result.stderr).toMatch(/Debug log could not be written \(.+\)/);
    expect(result.stderr).toContain(
      `[debug] could not create log directory ${join(configDir, "logs")}`,
    );
  });
});

describe("role persistence (#1257 item 22)", () => {
  test("nemar login writes the account's role into config.json", async () => {
    const configDir = makeConfigDir();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            valid: true,
            user: {
              username: "bob",
              email: "bob@example.com",
              github_username: "bob-gh",
              role: "owner",
              sandbox_completed: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const apiUrl = `http://localhost:${server.port}`;

    const result = await runCli(["login", "-k", "sk-fake-role-test-key"], configDir, apiUrl);
    server.stop(true);

    expect(result.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(config.accounts.bob.role).toBe("owner");
  });
});

describe("a failed login exits non-zero (#1257 item 23)", () => {
  // Before this fix, `spinner.fail(...); return;` (three separate places in
  // loginAction) left the default exit code (0) in place -- a failed login,
  // for the very command a brand-new user runs first, looked like a success
  // to the debug bundle (`Exit code: 0`, `Failing step: (none recorded)`)
  // and never triggered the failure hint at all.
  //
  // TEST_API_URL (not a "NEMAR_API_URL" -- no such env var exists; apiUrl
  // only ever comes from the active account's config or DEFAULT_API_URL) is
  // enough here because there is no pre-existing account for a fresh `login`
  // to read an apiUrl from in the first place -- the same fake-server
  // pattern the role-persistence test above already uses.
  function makeInvalidKeyServer() {
    return Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: "Invalid API key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
  }

  test("a 401 from /auth/login exits 1 and prints the failure hint", async () => {
    const configDir = makeConfigDir();
    const server = makeInvalidKeyServer();
    const apiUrl = `http://localhost:${server.port}`;

    const result = await runCli(
      ["login", "-k", "sk-fake-bad-key-0000000000000000"],
      configDir,
      apiUrl,
    );
    server.stop(true);
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(HINT_URL);
  });

  test("--debug records the failing step and the real exit code", async () => {
    const configDir = makeConfigDir();
    const server = makeInvalidKeyServer();
    const apiUrl = `http://localhost:${server.port}`;

    const result = await runCli(
      ["--debug", "login", "-k", "sk-fake-bad-key-0000000000000000"],
      configDir,
      apiUrl,
    );
    server.stop(true);

    expect(result.exitCode).toBe(1);
    const logsDir = join(configDir, "logs");
    const logFiles = readdirSync(logsDir);
    expect(logFiles.length).toBe(1);
    const content = readFileSync(join(logsDir, logFiles[0]), "utf8");
    expect(content).toContain("Exit code: 1");
    expect(content).toContain("Failing step: Invalid API key");

    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("log rotation (#1256)", () => {
  test("keeps only the 10 most recent debug logs", async () => {
    const configDir = makeConfigDir();
    const logsDir = join(configDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    // Seed 10 pre-existing logs, oldest to newest by name (ISO-prefixed
    // names sort chronologically -- see debug-log.ts's pruneLogsDir).
    for (let i = 0; i < 10; i++) {
      const ms = String(i).padStart(3, "0");
      writeFileSync(join(logsDir, `nemar-2020-01-01T00-00-00-${ms}Z-fake.log`), `seed log ${i}\n`);
    }
    expect(readdirSync(logsDir).length).toBe(10);

    // doctor needs no auth/network and always exits 0 -- a clean, fast way
    // to drive one more real write through the actual entry point.
    const result = await runCli(["--debug", "doctor"], configDir, undefined);
    expect(result.exitCode).toBe(0);

    const remaining = readdirSync(logsDir);
    expect(remaining.length).toBe(10);
    // The very oldest seeded file must be the one pruned.
    expect(remaining).not.toContain("nemar-2020-01-01T00-00-00-000Z-fake.log");
    expect(remaining).toContain("nemar-2020-01-01T00-00-00-009Z-fake.log");
    expect(remaining.some((name) => name.endsWith("-doctor.log"))).toBe(true);

    rmSync(configDir, { recursive: true, force: true });
  });
});
