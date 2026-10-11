/**
 * `nemar auth login`/`signup`/`logout`/`keys` over the device authorization
 * grant (RFC 8628; epic #1272 phase 3, #1283; ADR 0047), driven through the
 * real entry point (`bun run src/index.ts ...`).
 *
 * Real subprocess CLI, real on-disk config store, an isolated
 * `NEMAR_CONFIG_DIR`, and a local `Bun.serve()` standing in for the backend
 * -- no mocks. `startDeviceServer` types every response body from the
 * shared contract (`shared/contract/device-auth.ts`) rather than hand-typed
 * JSON, so a wire-shape drift here fails the same way a real client would
 * fail against it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  type ApiKeySummary,
  DEVICE_AUTH_MESSAGES,
  DEVICE_GRANT_MESSAGES,
  type DeviceAuthRefusalCode,
  type DeviceTokenSuccess,
} from "../shared/contract/device-auth";
import { type UserMeResponse, userMeResponseSchema } from "../shared/contract/user";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// The device-flow stand-in
// ---------------------------------------------------------------------------

/** One poll's answer. `"hold"` never resolves until the request aborts --
 *  the SIGINT test's target. */
type TokenReply =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "success" }
  | { kind: "expired" | "denied" | "invalid"; reason: DeviceAuthRefusalCode; message?: string }
  /** An arbitrary status/body pair -- a 500, a 200 that fails
   *  `deviceTokenSuccessSchema`, or a 400 with an `error` this build
   *  doesn't recognize. */
  | { kind: "raw"; status: number; body: unknown }
  | "hold";

interface Recorded {
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

interface PollRecord {
  deviceCode: string;
  at: number;
  aborted: boolean;
}

type DeviceUser = DeviceTokenSuccess["user"];

interface DeviceServerOptions {
  interval?: number;
  expiresIn?: number;
  /** Bind a specific port instead of an OS-assigned one -- only the
   *  "server comes back" test needs this, to resume on the port the CLI
   *  is already polling. */
  port?: number;
  /** Consumed in order per device code; the last entry repeats once
   *  exhausted. A function receives (pollIndexForThisCode, deviceCode). */
  token: TokenReply[] | ((pollIndex: number, deviceCode: string) => TokenReply);
  user?: DeviceUser;
  key?: Partial<ApiKeySummary>;
  apiKey?: string;
  /** `POST /auth/login` (the --key / stale-probe path). */
  login?: (apiKey: string) => { status: number; body: unknown };
  /** `GET /users/me` -- for `nemar auth signup`/`status --refresh`. Typed
   *  from the contract (`UserMeResponse`) and re-validated against
   *  `userMeResponseSchema` before being served, so a body a test wrote
   *  BEFORE a contract change fails this file loudly instead of quietly
   *  serving a shape the real backend could no longer send. A function is
   *  called per request so a test can change the answer across calls (e.g.
   *  after a PATCH). */
  me?: UserMeResponse | ((callIndex: number) => UserMeResponse);
  keysList?: { keys: ApiKeySummary[] };
  keysCreate?: (name: string) => { status: number; body: unknown };
  keysRevoke?: (id: string, headers: Record<string, string>) => { status: number; body: unknown };
  /** Any other path this suite needs (`PATCH /auth/profile`,
   *  `/users/me/upload-access/request`, `/auth/profile/username-suggestion`),
   *  keyed as `"METHOD path"`. */
  replies?: Record<
    string,
    { status: number; body: unknown } | ((body: unknown) => { status: number; body: unknown })
  >;
}

interface DeviceServer {
  url: string;
  starts: { machineName: string; at: number }[];
  polls: PollRecord[];
  calls: Recorded[];
  /** Resolves the first time ANY device code is polled. */
  firstPoll: Promise<void>;
  stop: () => void;
}

function defaultUser(overrides: Partial<DeviceUser> = {}): DeviceUser {
  return {
    username: "ada",
    email: "ada@example.org",
    github_username: "ada-gh",
    role: "member",
    sandbox_completed: true,
    // A returning trained account, not a fresh one: the default fixture
    // must not hide a caller that forgets to cache sandbox_dataset_id.
    sandbox_dataset_id: "xx090001",
    ...overrides,
  };
}

function defaultKey(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: 7,
    name: "test-machine",
    prefix: "nm_test_",
    created_at: "2026-03-01T00:00:00Z",
    last_used_at: null,
    current: true,
    ...overrides,
  };
}

function startDeviceServer(options: DeviceServerOptions): DeviceServer {
  const starts: { machineName: string; at: number }[] = [];
  const polls: PollRecord[] = [];
  const calls: Recorded[] = [];
  const pollIndexByCode = new Map<string, number>();
  let deviceCodeCounter = 0;
  let firstPollResolve: () => void = () => {};
  let firstPollResolved = false;
  const firstPoll = new Promise<void>((resolve) => {
    firstPollResolve = resolve;
  });

  const server = Bun.serve({
    port: options.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;

      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});

      if (url.pathname === "/auth/device/start" && method === "POST") {
        const rawText = await req.text();
        const parsed = rawText ? JSON.parse(rawText) : {};
        deviceCodeCounter += 1;
        const deviceCode = `device-code-${deviceCodeCounter}`;
        const userCode = `BCDF-GHJ${deviceCodeCounter}`;
        starts.push({ machineName: parsed.machine_name ?? "", at: Date.now() });
        return Response.json({
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: "https://app.nemar.org/cli/authorize",
          verification_uri_complete: `https://app.nemar.org/cli/authorize?code=${encodeURIComponent(userCode)}`,
          expires_in: options.expiresIn ?? 600,
          interval: options.interval ?? 1,
        });
      }

      if (url.pathname === "/auth/device/token" && method === "POST") {
        const { device_code: deviceCode } = (await req.json()) as { device_code: string };
        const pollIndex = pollIndexByCode.get(deviceCode) ?? 0;
        pollIndexByCode.set(deviceCode, pollIndex + 1);
        const record: PollRecord = { deviceCode, at: Date.now(), aborted: false };
        polls.push(record);
        req.signal.addEventListener("abort", () => {
          record.aborted = true;
        });
        if (!firstPollResolved) {
          firstPollResolved = true;
          firstPollResolve();
        }

        const reply = Array.isArray(options.token)
          ? (options.token[Math.min(pollIndex, options.token.length - 1)] ?? { kind: "pending" })
          : options.token(pollIndex, deviceCode);

        if (reply === "hold") {
          await new Promise<void>((resolve) => {
            req.signal.addEventListener("abort", () => resolve());
          });
          return new Response(null, { status: 499 });
        }
        if (reply.kind === "raw") {
          return Response.json(reply.body, { status: reply.status });
        }
        if (reply.kind === "pending") {
          return Response.json(
            {
              error: "authorization_pending",
              message: DEVICE_GRANT_MESSAGES.authorization_pending,
            },
            { status: 400 },
          );
        }
        if (reply.kind === "slow_down") {
          return Response.json(
            { error: "slow_down", message: DEVICE_GRANT_MESSAGES.slow_down },
            { status: 400 },
          );
        }
        if (reply.kind === "success") {
          const body: DeviceTokenSuccess = {
            api_key: options.apiKey ?? "nm_test_devicekey1234567890abcdef",
            key: defaultKey(options.key),
            user: options.user ?? defaultUser(),
          };
          return Response.json(body);
        }
        const errorCode =
          reply.kind === "expired"
            ? "expired_token"
            : reply.kind === "denied"
              ? "access_denied"
              : "invalid_grant";
        return Response.json(
          {
            error: errorCode,
            reason: reply.reason,
            message: reply.message ?? DEVICE_AUTH_MESSAGES[reply.reason],
          },
          { status: 400 },
        );
      }

      if (url.pathname === "/auth/login" && method === "POST") {
        const { api_key: apiKey } = (await req.json()) as { api_key: string };
        const result = options.login?.(apiKey) ?? {
          status: 200,
          body: { valid: true, user: options.user ?? defaultUser() },
        };
        return Response.json(result.body, { status: result.status });
      }

      if (url.pathname === "/users/me" && method === "GET") {
        if (!options.me) return Response.json({ user: {} });
        const me = typeof options.me === "function" ? options.me(calls.length) : options.me;
        // Re-parsed, not merely typed: a test fixture written against an
        // OLDER contract shape still type-checks against a stale local
        // `.d.ts` cache, but fails this at runtime the moment the schema
        // actually changes.
        return Response.json(userMeResponseSchema.parse(me));
      }

      if (url.pathname === "/auth/keys" && method === "GET") {
        return Response.json(options.keysList ?? { keys: [] });
      }
      if (url.pathname === "/auth/keys" && method === "POST") {
        const body = (await req.json()) as { name: string };
        calls.push({ path: url.pathname, method, body, headers: Object.fromEntries(req.headers) });
        const result = options.keysCreate?.(body.name) ?? {
          status: 200,
          body: {
            api_key: "nm_created_key_0123456789abcdef",
            key: defaultKey({ name: body.name }),
          },
        };
        return Response.json(result.body, { status: result.status });
      }
      const keyIdMatch = url.pathname.match(/^\/auth\/keys\/(.+)$/);
      if (keyIdMatch && method === "DELETE") {
        const headers = Object.fromEntries(req.headers);
        calls.push({ path: url.pathname, method, body: null, headers });
        const result = options.keysRevoke?.(keyIdMatch[1], headers) ?? {
          status: 200,
          body: { ok: true },
        };
        return Response.json(result.body, { status: result.status });
      }

      const key = `${method} ${url.pathname}`;
      const configured = options.replies?.[key];
      if (configured) {
        const rawText = await req.text();
        const body = rawText ? JSON.parse(rawText) : undefined;
        calls.push({ path: url.pathname, method, body, headers: Object.fromEntries(req.headers) });
        const result = typeof configured === "function" ? configured(body) : configured;
        return Response.json(result.body, { status: result.status });
      }
      if (method === "PATCH" || method === "POST") {
        const rawText = await req.text();
        const body = rawText ? JSON.parse(rawText) : undefined;
        calls.push({ path: url.pathname, method, body, headers: Object.fromEntries(req.headers) });
        return Response.json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    starts,
    polls,
    calls,
    firstPoll,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-auth-device-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

interface RunOptions {
  allowBrowser?: boolean;
  pathPrefix?: string;
  debug?: boolean;
  /** A Blob is the whole of stdin, for the one prompt a test needs to answer. */
  stdin?: "ignore" | "inherit" | Blob;
  /** Extra child env, applied last so it can override the defaults above. A value of
   *  `""` is passed through as present-and-empty (what the empty-`NEMAR_API_KEY` case
   *  needs); `undefined` DELETES the key, even if the parent had it. */
  env?: Record<string, string | undefined>;
}

function runCli(args: string[], apiUrl: string, options: RunOptions = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    NEMAR_NO_BROWSER: options.allowBrowser ? undefined : "1",
  };
  if (options.pathPrefix) env.PATH = `${options.pathPrefix}:${process.env.PATH ?? ""}`;
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  if (options.env) Object.assign(env, options.env);
  return spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args, ...(options.debug ? ["--debug"] : [])],
    cwd: REPO_ROOT,
    env,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collect(proc: ReturnType<typeof runCli>) {
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, out: `${stdout}${stderr}`, exitCode };
}

async function run(args: string[], apiUrl: string, options: RunOptions = {}) {
  return collect(runCli(args, apiUrl, options));
}

function configPath(): string {
  return join(configDir, "config.json");
}

function storedAccounts(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(configPath(), "utf8")).accounts ?? {};
}

function activeAccount(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(configPath(), "utf8"));
  return raw.accounts[raw.activeAccount];
}

function seedConfig(config: unknown, mode?: number): void {
  writeFileSync(configPath(), JSON.stringify(config));
  if (mode !== undefined) chmodSync(configPath(), mode);
}

/** Fake `open`/`xdg-open` on PATH, recording the URL they were called with
 *  (test/auth-profile-self-service-cli.test.ts's pattern). */
function makeFakeOpener(): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "nemar-fake-opener-"));
  const marker = join(dir, "opened.txt");
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "$1" >> "${marker}"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, marker };
}

async function markerAppears(marker: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (existsSync(marker)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1-2: printed URL/code, the browser attempt
// ---------------------------------------------------------------------------

describe("nemar auth login: an empty --key is refused, not a silent browser sign-in", () => {
  /**
   * `-k ""` used to be indistinguishable from no `-k` at all
   * (`options.key || process.env.NEMAR_API_KEY` treats `""` as absent), so it fell
   * through to the device flow: a browser opened and an account sign-in began that
   * nobody asked for.
   *
   * This was not hypothetical. `test/cli.test.ts` passes `TEST_CONFIG.adminApiKey`,
   * which is `""` when `test/.env.test` is absent -- and because the harness also
   * defaulted `TEST_API_URL` to production, the suite minted a real device code on
   * the live backend and opened the developer's browser on production's authorize
   * page, which asks for an ORCID sign-in. Two fences now, independently: this one,
   * and `test/live-target.ts`.
   *
   * The properties: no device flow is STARTED, nothing is OPENED, and the exit code
   * is 1. Not "no request at all" -- the root command's preAction hook does an
   * unconditional anonymous `GET /notices` before any action runs, which is outside
   * `loginAction` entirely.
   *
   * Only `-k ""` reached the device flow before the fix. `-k "   "` and `-k "\t"` are
   * truthy, so they took the pasted-key path and were rejected by the backend; the
   * guard turns those into a local refusal too, which is an improvement rather than
   * the same hazard.
   */
  for (const empty of ["", "   ", "\t"]) {
    test(`--key ${JSON.stringify(empty)} exits 1 without starting a device flow`, async () => {
      const opener = makeFakeOpener();
      const server = startDeviceServer({ token: [{ kind: "success" }] });
      try {
        const result = await run(["auth", "login", "-k", empty], server.url, {
          // Browser deliberately ALLOWED, so the test proves the refusal is what
          // stops the opener rather than the suite's own NEMAR_NO_BROWSER default.
          allowBrowser: true,
          pathPrefix: opener.dir,
        });
        expect(result.exitCode).toBe(1);
        expect(result.out).toContain("--key was given but is empty");
        // The two things that must not have happened. `starts`/`polls`, NOT `calls`:
        // the stub records /auth/device/start into `starts` and /auth/device/token
        // into `polls` only, so asserting an empty `calls` passed even with the fix
        // reverted -- it was watching a collection the device flow never writes to.
        expect(server.starts).toEqual([]);
        expect(server.polls).toEqual([]);
        expect(await markerAppears(opener.marker)).toBe(false);
      } finally {
        server.stop();
        rmSync(opener.dir, { recursive: true, force: true });
      }
    }, 40000);
  }

  test("it says how to proceed, both ways", async () => {
    const server = startDeviceServer({ token: [{ kind: "success" }] });
    try {
      const result = await run(["auth", "login", "-k", ""], server.url);
      expect(result.out).toContain("Pass the key itself");
      expect(result.out).toContain("drop --key");
    } finally {
      server.stop();
    }
  });

  test("an empty NEMAR_API_KEY still falls through to the browser flow", async () => {
    // Deliberately different from the flag: an empty env var is conventionally the
    // same as an unset one, and someone with `NEMAR_API_KEY=` exported in a shell
    // profile must still be able to sign in. Only an explicit flag is an error.
    const server = startDeviceServer({ token: [{ kind: "success" }] });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url, {
        env: { NEMAR_API_KEY: "" },
      });
      expect(result.exitCode).toBe(0);
      expect(server.starts.length).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("NEMAR_API_KEY with a real value signs in, per the documented equivalence", async () => {
    // `--key (alternative: NEMAR_API_KEY)` is in the command's own help text, and
    // nothing tested the env half -- so the carve-out that keeps an EMPTY env var
    // falling through was guarding a path with no coverage at all.
    const server = startDeviceServer({ token: [{ kind: "success" }] });
    try {
      const result = await run(["auth", "login"], server.url, {
        env: { NEMAR_API_KEY: "nm_env_key_456" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Welcome back");
      expect(server.starts.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a non-empty --key is unaffected", async () => {
    // The guard must not eat the path it is guarding.
    const server = startDeviceServer({ token: [{ kind: "success" }] });
    try {
      const result = await run(["auth", "login", "-k", "nm_a_real_looking_key"], server.url);
      expect(result.out).not.toContain("--key was given but is empty");
      // Positively: the key was VALIDATED and the account written. The earlier
      // version asserted only a missing string and an empty `starts`, both of which
      // held even with the guard absent, so it proved nothing about this path.
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Welcome back");
      expect(server.starts.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar switch: an empty account name is refused, not the interactive picker", () => {
  /**
   * The same falsy-empty class as `-k ""`, one command over: `if (identifier)` is
   * false for `""`, so `nemar switch "$VAR"` with an unset VAR skipped the
   * "Account not found" branch and opened the INTERACTIVE PICKER -- a hanging prompt
   * in a script, where a wrong-but-non-empty name correctly refuses and exits.
   *
   * No server: the guard runs before any network call, which is part of the point.
   */
  function seedTwoAccounts(): void {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_ada_key_0123456789abcdefgh", username: "ada" },
        grace: { apiKey: "nm_grace_key_0123456789abcdef", username: "grace" },
      },
    });
  }

  for (const argv of [
    ["switch", ""],
    ["auth", "switch", ""],
  ]) {
    test(`\`nemar ${argv.join(" ")}\` exits 1 and names the fix`, async () => {
      seedTwoAccounts();
      const result = await run(argv, "http://127.0.0.1:1");
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("Account name was given but is empty");
      // Crucially NOT the picker, which would sit there waiting for input.
      expect(result.out).not.toContain("Select an account");
    });
  }

  test("a wrong-but-non-empty name still refuses by name, and no account changes", async () => {
    seedTwoAccounts();
    const result = await run(["switch", "nobody"], "http://127.0.0.1:1");
    expect(result.exitCode).not.toBe(0);
    expect(result.out).toContain("nobody");
    expect(JSON.parse(readFileSync(configPath(), "utf8")).activeAccount).toBe("ada");
  });
});

describe("nemar auth login: the device-flow prompt", () => {
  test("--no-open: URL line, then the code line, then the 'if the page asks' note", async () => {
    const server = startDeviceServer({ token: [{ kind: "success" }] });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      const urlLine = result.stdout.indexOf("https://app.nemar.org/cli/authorize");
      const codeLine = result.stdout.indexOf("Code:");
      const noteLine = result.stdout.indexOf("if the page asks for it");
      expect(urlLine).toBeGreaterThan(-1);
      expect(codeLine).toBeGreaterThan(urlLine);
      expect(noteLine).toBeGreaterThan(codeLine);
    } finally {
      server.stop();
    }
  });

  test("the browser is tried unless --no-open or NEMAR_NO_BROWSER=1", async () => {
    const opener = makeFakeOpener();
    try {
      // Under --no-open: never tried.
      const suppressed = startDeviceServer({ token: [{ kind: "success" }] });
      try {
        const result = await run(["auth", "login", "--no-open"], suppressed.url, {
          allowBrowser: true,
          pathPrefix: opener.dir,
        });
        expect(result.out).not.toContain("trying to open your browser");
        expect(await markerAppears(opener.marker)).toBe(false);
      } finally {
        suppressed.stop();
      }

      // Under NEMAR_NO_BROWSER=1 (default runCli behavior): never tried.
      const underEnvVar = startDeviceServer({ token: [{ kind: "success" }] });
      try {
        const result = await run(["auth", "login"], underEnvVar.url, { pathPrefix: opener.dir });
        expect(result.out).not.toContain("trying to open your browser");
        expect(await markerAppears(opener.marker)).toBe(false);
      } finally {
        underEnvVar.stop();
      }

      // Otherwise: attempted, and holds the printed URL.
      const attempted = startDeviceServer({ token: [{ kind: "success" }] });
      try {
        const result = await run(["auth", "login"], attempted.url, {
          allowBrowser: true,
          pathPrefix: opener.dir,
        });
        expect(result.out).toContain("trying to open your browser");
        expect(await markerAppears(opener.marker)).toBe(true);
        expect(readFileSync(opener.marker, "utf8")).toContain("cli/authorize?code=");
      } finally {
        attempted.stop();
      }
    } finally {
      rmSync(opener.dir, { recursive: true, force: true });
    }
  }, 40000);
});

// ---------------------------------------------------------------------------
// 3: polling cadence
// ---------------------------------------------------------------------------

describe("nemar auth login: polling cadence", () => {
  test("pending, slow_down, success: three polls with the right gaps", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "pending" }, { kind: "slow_down" }, { kind: "success" }],
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.polls.length).toBe(3);
      const gap12 = server.polls[1].at - server.polls[0].at;
      const gap23 = server.polls[2].at - server.polls[1].at;
      expect(gap12).toBeLessThan(3000);
      // Loose on purpose: this only needs to show the slow_down step
      // actually widened the gap, not pin the exact scheduling jitter of a
      // subprocess under test-suite load.
      expect(gap23 > gap12 * 2 && gap23 - gap12 >= 4000).toBe(true);
    } finally {
      server.stop();
    }
  }, 40000);
});

// ---------------------------------------------------------------------------
// 4: terminal answers
// ---------------------------------------------------------------------------

describe("nemar auth login: terminal answers", () => {
  test("expired_token prints the contract sentence verbatim and writes no config", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "expired", reason: "device_code_expired" }],
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(DEVICE_AUTH_MESSAGES.device_code_expired);
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("access_denied/device_code_denied prints the contract sentence, from reason not error", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "denied", reason: "device_code_denied" }],
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(DEVICE_AUTH_MESSAGES.device_code_denied);
      expect(result.out).not.toContain("access_denied");
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("access_denied/account_pending prints the account_pending sentence", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "denied", reason: "account_pending" }],
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(DEVICE_AUTH_MESSAGES.account_pending);
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a terminal code with a body that fails the contract schema still ends the poll", async () => {
    const server = startDeviceServer({
      interval: 1,
      // No `reason`, no `message` -- fails deviceTokenErrorSchema even
      // though `error` is a grant code this build recognizes.
      token: [{ kind: "raw", status: 400, body: { error: "expired_token" } }],
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(DEVICE_GRANT_MESSAGES.expired_token);
      expect(server.polls.length).toBe(1);
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a terminal code with an unrecognized reason still ends the poll, using the body's own message", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [
        {
          kind: "raw",
          status: 400,
          body: {
            error: "access_denied",
            reason: "some_future_reason",
            message: "custom sentence from the body",
          },
        },
      ],
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("custom sentence from the body");
      expect(server.polls.length).toBe(1);
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("invalid_grant/too_many_keys prints the contract sentence and exits 1", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "invalid", reason: "too_many_keys" }],
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(DEVICE_AUTH_MESSAGES.too_many_keys);
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 5: success writes the account
// ---------------------------------------------------------------------------

describe("nemar auth login: success writes the account", () => {
  test("username: null is keyed by email, keySource device, mode 0600", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser({ username: null }),
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      const accounts = storedAccounts();
      expect(Object.keys(accounts)).toEqual(["ada@example.org"]);
      const account = accounts["ada@example.org"];
      expect(account.keySource).toBe("device");
      expect(account.keyId).toBe(7);
      expect(account.keyName).toBe("test-machine");
      if (process.platform !== "win32") {
        expect(statSync(configPath()).mode & 0o777).toBe(0o600);
      }

      const status = await run(["auth", "status"], "http://127.0.0.1:1");
      expect(status.stdout).toContain("ada@example.org");
      expect(status.stdout).toContain("Key:");
      expect(status.stdout).toContain("test-machine");
    } finally {
      server.stop();
    }
  });

  test("a username keys the entry by that name, welcomes, and prints profile gaps", async () => {
    const server = startDeviceServer({ interval: 1, token: [{ kind: "success" }] });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      expect(Object.keys(storedAccounts())).toEqual(["ada"]);
      expect(result.stdout).toContain("Welcome, ada!");
      // Not the --key path's "Welcome back": the device flow is the new
      // first-time-or-returning browser greeting.
      expect(result.stdout).not.toContain("Welcome back");
      expect(result.stdout).toContain("Profile");
    } finally {
      server.stop();
    }
  });

  test("a returning trained account's sandbox_dataset_id is cached", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser({ sandbox_completed: true, sandbox_dataset_id: "xx090001" }),
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      expect(activeAccount().sandboxDatasetId).toBe("xx090001");
    } finally {
      server.stop();
    }
  });

  test("a config write failure after a successful device login revokes the new key and reports it", async () => {
    seedConfig({});
    const revokeCalls: { id: string; headers: Record<string, string> }[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: (id, headers) => {
        revokeCalls.push({ id, headers });
        return { status: 200, body: { ok: true } };
      },
    });
    // Readable, not writable: the store's initial read succeeds and every
    // write (upsertAccount's) fails -- the same pattern
    // test/auth-profile-self-service-cli.test.ts uses.
    chmodSync(configDir, 0o500);
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("Could not save your credentials");
      expect(result.out).toContain("The new key was revoked");
      expect(result.out).toContain(configPath());
      // Revoked with the NEW key as its own bearer -- nothing was ever
      // stored to authenticate the ordinary way.
      expect(revokeCalls.length).toBe(1);
      expect(revokeCalls[0].id).toBe("7");
      expect(revokeCalls[0].headers.authorization).toBe("Bearer nm_test_devicekey1234567890abcdef");
    } finally {
      chmodSync(configDir, 0o700);
      server.stop();
    }
  }, 40000);
});

// ---------------------------------------------------------------------------
// 6: stale-probe re-login merges and revokes the old device key
// ---------------------------------------------------------------------------

describe("nemar auth login: stale-probe re-login", () => {
  test("merges into the existing entry, keeps cached fields, revokes the old device key", async () => {
    seedConfig(
      {
        activeAccount: "ada",
        accounts: {
          ada: {
            apiKey: "nm_old_dead_key_0123456789abcdef",
            apiUrl: "https://api.nemar.org",
            username: "ada",
            email: "ada@example.org",
            keySource: "device",
            keyId: 99,
            keyName: "old-laptop",
            dismissedNoticeIds: [1, 2],
            profileGaps: [{ field: "city", blocks: ["upload_access"], set_on: ["web", "cli"] }],
          },
        },
      },
      0o644,
    );

    const revokedIds: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      login: () => ({ status: 401, body: { error: "Invalid or expired API key" } }),
      keysRevoke: (id) => {
        revokedIds.push(id);
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("browser");
      expect(result.out).not.toContain("enter your key");

      const accounts = storedAccounts();
      expect(Object.keys(accounts)).toEqual(["ada"]);
      const account = accounts.ada;
      expect(account.dismissedNoticeIds).toEqual([1, 2]);
      expect(account.profileGaps).toEqual([
        { field: "city", blocks: ["upload_access"], set_on: ["web", "cli"] },
      ]);
      expect(account.keyId).toBe(7);
      if (process.platform !== "win32") {
        expect(statSync(configPath()).mode & 0o777).toBe(0o600);
      }
      expect(revokedIds).toEqual(["99"]);
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 7: active-account re-login
// ---------------------------------------------------------------------------

describe("nemar auth login: an already-active account", () => {
  test("prints one notice, asks nothing, and a different email lands as a second entry", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: {
          apiKey: "nm_active_key_0123456789abcdef",
          apiUrl: "https://api.nemar.org",
          username: "ada",
          email: "ada@example.org",
        },
      },
    });

    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      login: () => ({ status: 200, body: { valid: true, user: defaultUser() } }),
      user: defaultUser({ username: "bob", email: "bob@example.org" }),
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Already signed in as ada");
      expect(result.out).not.toContain("Add a different account?");
      expect(Object.keys(storedAccounts()).sort()).toEqual(["ada", "bob"]);
    } finally {
      server.stop();
    }
  });

  test("a live (not stale) device key: the revoke still fires and prints the replaced-key confirmation", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: {
          apiKey: "nm_live_device_key_0123456789ab",
          username: "ada",
          email: "ada@example.org",
          keySource: "device",
          keyId: 99,
          keyName: "old-laptop",
          keyCreatedAt: "2025-01-01T00:00:00Z",
        },
      },
    });

    const revokedIds: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      // The preflight probe reports the STORED key as still VALID (active,
      // not stale) -- the revoke below must fire and the confirmation must
      // print regardless, since a re-login on the SAME machine always
      // replaces its own key.
      login: () => ({ status: 200, body: { valid: true, user: defaultUser() } }),
      user: defaultUser(),
      keysRevoke: (id) => {
        revokedIds.push(id);
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Already signed in as ada");
      expect(result.out).toContain("(replaced this machine's previous key)");
      expect(revokedIds).toEqual(["99"]);
      const account = storedAccounts().ada;
      expect(account.keyId).toBe(7);
      expect(account.apiKey).toBe("nm_test_devicekey1234567890abcdef");
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 8: SIGINT cancels the poll cleanly
// ---------------------------------------------------------------------------

describe("nemar auth login: Ctrl-C during the poll", () => {
  test("exits 130, prints the cancel sentence, aborts the held request, writes no config", async () => {
    const server = startDeviceServer({ interval: 1, token: () => "hold" });
    try {
      const proc = runCli(["auth", "login", "--no-open"], server.url);
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      await server.firstPoll;
      proc.kill("SIGINT");

      const stdout = await stdoutPromise;
      const stderr = await stderrPromise;
      const exitCode = await proc.exited;

      expect(exitCode).toBe(130);
      expect(stdout + stderr).toContain("Sign-in canceled. Run `nemar auth login` to try again.");
      expect(server.polls[0]?.aborted).toBe(true);
      expect(existsSync(configPath())).toBe(false);
      expect(stdout + stderr).not.toContain("Run again with --debug");
    } finally {
      server.stop();
    }
  }, 20000);

  test("with a seeded config, the file is byte-identical before and after", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_untouched_key_0123456789ab", username: "ada", email: "ada@example.org" },
      },
    });
    const before = readFileSync(configPath());
    const server = startDeviceServer({ interval: 1, token: () => "hold" });
    try {
      const proc = runCli(["auth", "login", "--no-open"], server.url);
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      await server.firstPoll;
      proc.kill("SIGINT");

      await stdoutPromise;
      await stderrPromise;
      const exitCode = await proc.exited;

      expect(exitCode).toBe(130);
      const after = readFileSync(configPath());
      expect(after.equals(before)).toBe(true);
    } finally {
      server.stop();
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// 9: two independent logins
// ---------------------------------------------------------------------------

describe("nemar auth login: two parallel logins", () => {
  test("independent device codes; one succeeds, the other expires; config holds the winner only", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: (_pollIndex, deviceCode) =>
        deviceCode === "device-code-1"
          ? { kind: "success" }
          : { kind: "expired", reason: "device_code_expired" },
      user: defaultUser({ username: "winner", email: "winner@example.org" }),
    });
    try {
      const [a, b] = await Promise.all([
        run(["auth", "login", "--no-open"], server.url),
        run(["auth", "login", "--no-open"], server.url),
      ]);
      const results = [a, b];
      const succeeded = results.filter((r) => r.exitCode === 0);
      const failed = results.filter((r) => r.exitCode !== 0);
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(Object.keys(storedAccounts())).toEqual(["winner"]);
    } finally {
      server.stop();
    }
  }, 40000);
});

// ---------------------------------------------------------------------------
// 10: unreachable mid-poll, then recovers
// ---------------------------------------------------------------------------
//
// The deadline-reached "unreachable" GIVE UP outcome itself (as opposed to
// the retry note below) is NOT covered here: this stand-in always answers
// SOMETHING once it is up, and the real grace window is minutes long, so
// reaching that branch through this entry point would mean actually
// waiting it out. test/device-login.unit.test.ts covers it directly against
// `pollForDeviceToken`, with the grace window shrunk to 0 via its
// `graceSeconds` option.
// ---------------------------------------------------------------------------

describe("nemar auth login: the server goes away mid-poll and comes back", () => {
  test("prints the unreachable note, then succeeds once the server returns", async () => {
    let server = startDeviceServer({ interval: 1, token: [{ kind: "pending" }] });
    const port = Number(new URL(server.url).port);
    const proc = runCli(["auth", "login", "--no-open"], server.url);
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    await server.firstPoll;
    server.stop();

    // Re-bind on the EXACT same port the CLI was already told about, once
    // the OS actually releases it -- a short retry loop rather than a fixed
    // sleep, since how long that takes is a kernel/OS detail, not something
    // this test should have to guess a duration for.
    server = await retryUntilPortFree(port, () =>
      startDeviceServer({ port, interval: 1, token: [{ kind: "success" }] }),
    );
    try {
      const stdout = await stdoutPromise;
      const stderr = await stderrPromise;
      const exitCode = await proc.exited;
      expect(stdout + stderr).toContain("NEMAR is unreachable; retrying...");
      expect(exitCode).toBe(0);
    } finally {
      server.stop();
    }
  }, 40000);
});

/** Retry `attempt` until it stops throwing (an `EADDRINUSE`-shaped failure
 *  while the OS still holds the just-stopped server's port) or the deadline
 *  passes. Used only by the "server comes back" test. */
async function retryUntilPortFree(
  port: number,
  attempt: () => DeviceServer,
): Promise<DeviceServer> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return attempt();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// ---------------------------------------------------------------------------
// 11: the poll loop gives up after repeated non-network errors
// ---------------------------------------------------------------------------

describe("nemar auth login: repeated poll errors give up", () => {
  test("three consecutive 500s: the give-up sentence, exit 1, no config", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: () => ({ kind: "raw", status: 500, body: { error: "internal" } }),
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(
        "NEMAR keeps answering with an error (HTTP 500). Try again in a few minutes",
      );
      expect(server.polls.length).toBe(3);
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  }, 40000);

  test("a 200 that fails the success schema three times: same give-up, no config", async () => {
    const server = startDeviceServer({
      interval: 1,
      // Missing `api_key`/`key`/`user` -- fails deviceTokenSuccessSchema, so
      // `request()` throws an ApiError with statusCode 200, not 400.
      token: () => ({ kind: "raw", status: 200, body: { ok: true } }),
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(
        "NEMAR keeps answering with an error (HTTP 200). Try again in a few minutes",
      );
      expect(server.polls.length).toBe(3);
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  }, 40000);

  test("a 400 with an error code this build doesn't recognize: same give-up, no config", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: () => ({
        kind: "raw",
        status: 400,
        body: { error: "some_future_grant_code", message: "not in this build's vocabulary" },
      }),
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(
        "NEMAR keeps answering with an error (HTTP 400). Try again in a few minutes",
      );
      expect(server.polls.length).toBe(3);
      expect(existsSync(configPath())).toBe(false);
    } finally {
      server.stop();
    }
  }, 40000);

  test("a success after two errors resets the count: no give-up, config written", async () => {
    let calls = 0;
    const server = startDeviceServer({
      interval: 1,
      token: () => {
        calls += 1;
        if (calls <= 2) return { kind: "raw", status: 500, body: { error: "internal" } };
        return { kind: "success" };
      },
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).not.toContain("NEMAR keeps answering with an error");
      expect(existsSync(configPath())).toBe(true);
    } finally {
      server.stop();
    }
  }, 40000);
});

// ---------------------------------------------------------------------------
// 12: --key (the paste-key fallback)
// ---------------------------------------------------------------------------

describe("nemar auth login --key", () => {
  test("a bad key: exit 1, the credential hint, no config, no device start", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      login: () => ({ status: 200, body: { valid: false } }),
    });
    try {
      const result = await run(
        ["auth", "login", "--key", "nm_bad_key_0123456789abcdefgh"],
        server.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("Check that your API key is correct");
      expect(existsSync(configPath())).toBe(false);
      expect(server.starts.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a good key with username: null is keyed by email, keySource paste", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      login: () => ({ status: 200, body: { valid: true, user: defaultUser({ username: null }) } }),
    });
    try {
      const result = await run(
        ["auth", "login", "--key", "nm_good_key_0123456789abcdefgh"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      // The --key/NEMAR_API_KEY path keeps the pre-phase-3 greeting: a
      // person pasting a key already holds an account.
      expect(result.stdout).toContain("Welcome back");
      const accounts = storedAccounts();
      expect(Object.keys(accounts)).toEqual(["ada@example.org"]);
      expect(accounts["ada@example.org"].keySource).toBe("paste");
      expect(accounts["ada@example.org"].keyId).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("pasting a key over an existing device-sourced account clears its stale key fields", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: {
          apiKey: "nm_stale_device_key_0123456789",
          username: "ada",
          email: "ada@example.org",
          keySource: "device",
          keyId: 42,
          keyName: "old-laptop",
          keyCreatedAt: "2025-01-01T00:00:00Z",
        },
      },
    });
    const server = startDeviceServer({
      interval: 1,
      // The preflight probe (called with the OLD stored key) must fail so
      // this routes through the no-confirmation "stale" path rather than
      // "active", which would otherwise block on an "Add a different
      // account?" prompt this test never answers.
      login: (apiKey) =>
        apiKey === "nm_pasted_key_0123456789abcdef"
          ? { status: 200, body: { valid: true, user: defaultUser() } }
          : { status: 401, body: { error: "Invalid or expired API key" } },
    });
    try {
      const result = await run(
        ["auth", "login", "--key", "nm_pasted_key_0123456789abcdef"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      const account = storedAccounts().ada;
      expect(account.keySource).toBe("paste");
      expect(account.keyId).toBeUndefined();
      expect(account.keyName).toBeUndefined();
      expect(account.keyCreatedAt).toBeUndefined();
      expect(account.apiKey).toBe("nm_pasted_key_0123456789abcdef");
    } finally {
      server.stop();
    }
  });

  test("a returning trained account's sandbox_dataset_id is cached", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      login: () => ({
        status: 200,
        body: {
          valid: true,
          user: defaultUser({ sandbox_completed: true, sandbox_dataset_id: "xx090001" }),
        },
      }),
    });
    try {
      const result = await run(
        ["auth", "login", "--key", "nm_good_key_0123456789abcdefgh"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(activeAccount().sandboxDatasetId).toBe("xx090001");
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 13: status -- file mode migration, rename on refresh
// ---------------------------------------------------------------------------

describe("nemar auth status", () => {
  test("a 0644 config file is left at 0600 after a run", async () => {
    if (process.platform === "win32") return;
    seedConfig(
      {
        activeAccount: "ada",
        accounts: {
          ada: { apiKey: "nm_key_0123456789abcdefghij", username: "ada", email: "ada@example.org" },
        },
      },
      0o644,
    );
    const result = await run(["auth", "status"], "http://127.0.0.1:1");
    expect(result.exitCode).toBe(0);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  test("--refresh renames an email-keyed entry once the server reports a username", async () => {
    seedConfig({
      activeAccount: "ada@example.org",
      accounts: {
        "ada@example.org": { apiKey: "nm_key_0123456789abcdefghij", email: "ada@example.org" },
      },
    });
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      me: {
        user: {
          id: 1,
          username: "ada",
          email: "ada@example.org",
          github_username: null,
          role: "member",
          status: "verified",
          email_verified: true,
          sandbox_completed: true,
        },
      },
    });
    try {
      const result = await run(["auth", "status", "--refresh"], server.url);
      expect(result.exitCode).toBe(0);
      expect(Object.keys(storedAccounts())).toEqual(["ada"]);
    } finally {
      server.stop();
    }
  });

  test("a password-era flat config is migrated in place; status reads it and shows the password-era Key: line", async () => {
    // No "accounts" key at all -- the shape a pre-multi-account build wrote.
    seedConfig({
      apiKey: "nm_flat_key_0123456789abcdefgh",
      username: "ada",
      apiUrl: "https://api.nemar.org",
      email: "ada@example.org",
    });
    const result = await run(["auth", "status"], "http://127.0.0.1:1");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("ada");
    expect(result.out).toContain(
      "password-era key; run `nemar auth login` to replace it with a machine-named key",
    );
    const accounts = storedAccounts();
    expect(Object.keys(accounts)).toEqual(["ada"]);
    expect(accounts.ada.apiKey).toBe("nm_flat_key_0123456789abcdefgh");
  });

  test("auth login --no-open on a password-era flat config merges into the migrated entry", async () => {
    seedConfig({
      apiKey: "nm_flat_key_0123456789abcdefgh",
      username: "ada",
      apiUrl: "https://api.nemar.org",
      email: "ada@example.org",
    });
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      // The preflight probe reports the flat-config key dead, routing
      // through the no-confirmation "stale" path straight to the device
      // flow.
      login: () => ({ status: 401, body: { error: "Invalid or expired API key" } }),
      user: defaultUser(),
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      // ONE entry, not two: the device login's user (same username/email)
      // must find and merge into the migrated flat account rather than
      // creating a second one keyed differently.
      expect(Object.keys(storedAccounts())).toEqual(["ada"]);
      expect(storedAccounts().ada.keySource).toBe("device");
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 14: logout
// ---------------------------------------------------------------------------

function readRawAccounts(): Record<string, Record<string, unknown>> {
  if (!existsSync(configPath())) return {};
  const raw = JSON.parse(readFileSync(configPath(), "utf8"));
  return raw.accounts ?? {};
}

describe("nemar auth logout", () => {
  test("a device key sends DELETE /auth/keys/current and clears the account", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_device_key_0123456789abcdef", username: "ada", keySource: "device" },
      },
    });
    const revokes: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: (id) => {
        revokes.push(id);
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const result = await run(["auth", "logout", "-y"], server.url);
      expect(result.exitCode).toBe(0);
      expect(revokes).toEqual(["current"]);
      expect(readRawAccounts().ada).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("a pasted/legacy key sends nothing and says where to revoke it", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_paste_key_0123456789abcdef", username: "ada", keySource: "paste" },
      },
    });
    const revokes: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: (id) => {
        revokes.push(id);
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const result = await run(["auth", "logout", "-y"], server.url);
      expect(result.exitCode).toBe(0);
      expect(revokes).toEqual([]);
      expect(result.out).toContain("nemar auth keys revoke");
      expect(readRawAccounts().ada).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("--revoke-key forces a revoke of a pasted key", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_paste_key_0123456789abcdef", username: "ada", keySource: "paste" },
      },
    });
    const revokes: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: (id) => {
        revokes.push(id);
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const result = await run(["auth", "logout", "-y", "--revoke-key"], server.url);
      expect(result.exitCode).toBe(0);
      expect(revokes).toEqual(["current"]);
    } finally {
      server.stop();
    }
  });

  test("--no-revoke-key skips a device key's revoke", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_device_key_0123456789abcdef", username: "ada", keySource: "device" },
      },
    });
    const revokes: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: (id) => {
        revokes.push(id);
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const result = await run(["auth", "logout", "-y", "--no-revoke-key"], server.url);
      expect(result.exitCode).toBe(0);
      expect(revokes).toEqual([]);
      expect(readRawAccounts().ada).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("an unreachable API warns and still clears the local account", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_device_key_0123456789abcdef", username: "ada", keySource: "device" },
      },
    });
    const result = await run(["auth", "logout", "-y"], "http://127.0.0.1:1");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("stays valid");
    expect(readRawAccounts().ada).toBeUndefined();
  });

  test("--all revokes each stored account with its own bearer", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_ada_device_key_0123456789ab", username: "ada", keySource: "device" },
        bob: { apiKey: "nm_bob_device_key_0123456789ab", username: "bob", keySource: "device" },
      },
    });
    const bearers: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: (id, headers) => {
        bearers.push(headers.authorization ?? "");
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const result = await run(["auth", "logout", "-y", "--all"], server.url);
      expect(result.exitCode).toBe(0);
      expect(bearers.sort()).toEqual(
        ["Bearer nm_ada_device_key_0123456789ab", "Bearer nm_bob_device_key_0123456789ab"].sort(),
      );
      expect(Object.keys(readRawAccounts())).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("--all reaches an email-keyed account too, not just ones whose key equals their username", async () => {
    // A regression fixture on purpose: an entry keyed by EMAIL (no username)
    // alongside one keyed by username, so a loop that switches by
    // `account.username` instead of the accounts-map key silently skips the
    // first one -- `switchAccount(undefined)` finds nothing, its key is
    // never revoked, and it survives in accounts.json after "logged out".
    seedConfig({
      activeAccount: "ada@example.org",
      accounts: {
        "ada@example.org": {
          apiKey: "nm_ada_device_key_0123456789ab",
          email: "ada@example.org",
          keySource: "device",
        },
        bob: { apiKey: "nm_bob_device_key_0123456789ab", username: "bob", keySource: "device" },
      },
    });
    const bearers: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: (id, headers) => {
        bearers.push(headers.authorization ?? "");
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const result = await run(["auth", "logout", "-y", "--all"], server.url);
      expect(result.exitCode).toBe(0);
      expect(bearers.sort()).toEqual(
        ["Bearer nm_ada_device_key_0123456789ab", "Bearer nm_bob_device_key_0123456789ab"].sort(),
      );
      expect(Object.keys(readRawAccounts())).toEqual([]);
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 15: keys group
// ---------------------------------------------------------------------------

describe("nemar auth keys", () => {
  test("list marks the current key '(this machine)'", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: { ada: { apiKey: "nm_key_0123456789abcdefghij", username: "ada" } },
    });
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysList: {
        keys: [
          defaultKey({ id: 1, name: "laptop", current: true }),
          defaultKey({ id: 2, name: null, current: false }),
        ],
      },
    });
    try {
      const result = await run(["auth", "keys"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("laptop");
      expect(result.stdout).toContain("(this machine)");
      const laptopLine = result.stdout.split("\n").find((l) => l.includes("laptop"));
      expect(laptopLine).toContain("(this machine)");
      const unnamedLine = result.stdout.split("\n").find((l) => l.includes("(unnamed)"));
      expect(unnamedLine).not.toContain("(this machine)");
    } finally {
      server.stop();
    }
  });

  test("create posts { name } and prints the paste hint", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: { ada: { apiKey: "nm_key_0123456789abcdefghij", username: "ada" } },
    });
    let created: { status: number; body: unknown } | null = null;
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysCreate: (name) => {
        created = {
          status: 200,
          body: { api_key: "nm_created_0123456789abcdef", key: defaultKey({ name }) },
        };
        return created;
      },
    });
    try {
      const result = await run(["auth", "keys", "create", "build-box"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("nm_created_0123456789abcdef");
      expect(result.out).toContain("nemar auth login --key");
    } finally {
      server.stop();
    }
  });

  test("revoke by id and revoke current", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: { ada: { apiKey: "nm_key_0123456789abcdefghij", username: "ada" } },
    });
    const revoked: string[] = [];
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: (id) => {
        revoked.push(id);
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const byId = await run(["auth", "keys", "revoke", "12"], server.url);
      expect(byId.exitCode).toBe(0);
      const current = await run(["auth", "keys", "revoke", "current"], server.url);
      expect(current.exitCode).toBe(0);
      expect(revoked).toEqual(["12", "current"]);
    } finally {
      server.stop();
    }
  });

  test("revoke 99 prints the key_not_found sentence and exits 1", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: { ada: { apiKey: "nm_key_0123456789abcdefghij", username: "ada" } },
    });
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      keysRevoke: () => ({
        status: 404,
        body: {
          error: "key_not_found",
          message: DEVICE_AUTH_MESSAGES.key_not_found,
        },
      }),
    });
    try {
      const result = await run(["auth", "keys", "revoke", "99"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(DEVICE_AUTH_MESSAGES.key_not_found);
    } finally {
      server.stop();
    }
  });

  test("a bad revoke argument is refused at the Commander boundary", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: { ada: { apiKey: "nm_key_0123456789abcdefghij", username: "ada" } },
    });
    const result = await run(["auth", "keys", "revoke", "not-a-number"], "http://127.0.0.1:1");
    expect(result.exitCode).not.toBe(0);
    expect(result.out).toContain("Expected a key id");
  });
});

// ---------------------------------------------------------------------------
// 16: signup completion
// ---------------------------------------------------------------------------

function gapsMe(fields: string[], overrides: Record<string, unknown> = {}): UserMeResponse {
  return {
    user: {
      id: 12,
      username: fields.includes("username") ? null : "ada",
      email: "ada@example.org",
      github_username: fields.includes("github_username") ? null : "ada-gh",
      role: "member",
      orcid: "0000-0002-1825-0097",
      orcid_verified: false,
      status: "verified",
      email_verified: true,
      given_name: "Ada",
      family_name: "Lovelace",
      sandbox_completed: true,
      username_auto_assigned: false,
      city: fields.includes("city") ? null : "Boston",
      country: fields.includes("country") ? null : "USA",
      profile_gaps: fields.map((field) => ({
        field,
        blocks: ["upload_access"],
        set_on: ["web", "cli"],
      })),
      ...overrides,
    },
    token: null,
  };
}

const WHY = "Depositing our lab's 64-channel EEG study of motor imagery, 40 participants.";

describe("nemar auth signup", () => {
  test("flags produce one PATCH with the four fields and the upload-access POST", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser({ username: null }),
      me: gapsMe(["username", "github_username", "city", "country"]),
      replies: {
        "GET /auth/profile/username-suggestion": {
          status: 200,
          body: { suggestion: null, based_on: "unavailable" },
        },
      },
    });
    try {
      const result = await run(
        [
          "auth",
          "signup",
          "--no-open",
          "--username",
          "alovelace",
          "--github",
          "adalove-gh",
          "--city",
          "Cambridge",
          "--country",
          "UK",
          "--why",
          WHY,
        ],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      const patchCalls = server.calls.filter(
        (c) => c.path === "/auth/profile" && c.method === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
      expect(patchCalls[0].body).toEqual({
        username: "alovelace",
        github_username: "adalove-gh",
        city: "Cambridge",
        country: "UK",
      });
      const uploadCalls = server.calls.filter((c) => c.path === "/users/me/upload-access/request");
      expect(uploadCalls.length).toBe(1);
      expect(uploadCalls[0].body).toEqual({ why: WHY });
    } finally {
      server.stop();
    }
  });

  test("no flags with a closed stdin names them and exits 1 before any PATCH", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser({ username: null }),
      me: gapsMe(["username", "github_username", "city", "country"]),
    });
    try {
      const result = await run(["auth", "signup", "--no-open"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("--username");
      expect(result.out).toContain("--github");
      expect(result.out).toContain("--city");
      expect(result.out).toContain("--country");
      const patchCalls = server.calls.filter((c) => c.path === "/auth/profile");
      expect(patchCalls.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("--no-upload-access skips the upload-access request", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser({ username: null }),
      me: gapsMe(["username"]),
    });
    try {
      const result = await run(
        ["auth", "signup", "--no-open", "--username", "alovelace", "--no-upload-access"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      const uploadCalls = server.calls.filter((c) => c.path === "/users/me/upload-access/request");
      expect(uploadCalls.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a complete account prints 'Nothing outstanding'", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser(),
      me: gapsMe([]),
    });
    try {
      const result = await run(["auth", "signup", "--no-open", "--why", WHY], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Nothing outstanding");
    } finally {
      server.stop();
    }
  });

  test("an auto-assigned username is kept without a suggestion call", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser({ username: "jsmith2" }),
      me: gapsMe([], { username: "jsmith2", username_auto_assigned: true }),
      replies: {
        "GET /auth/profile/username-suggestion": {
          status: 200,
          body: { suggestion: "jsmith3", based_on: "name" },
        },
      },
    });
    try {
      const result = await run(["auth", "signup", "--no-open", "-y", "--why", WHY], server.url);
      expect(result.exitCode).toBe(0);
      const patchCalls = server.calls.filter((c) => c.path === "/auth/profile");
      expect(patchCalls.length).toBe(0);
      const suggestionCalls = server.calls.filter(
        (c) => c.path === "/auth/profile/username-suggestion",
      );
      expect(suggestionCalls.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a PATCH 409 prints the sentence and skips the upload request", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser({ username: null }),
      me: gapsMe(["username"]),
      replies: {
        "PATCH /auth/profile": {
          status: 409,
          body: {
            error: "username_taken",
            message: 'That username, "alovelace", is already taken.',
          },
        },
      },
    });
    try {
      const result = await run(
        ["auth", "signup", "--no-open", "--username", "alovelace", "--why", WHY],
        server.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("already taken");
      const uploadCalls = server.calls.filter((c) => c.path === "/users/me/upload-access/request");
      expect(uploadCalls.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 17: the password command is gone (ADR 0097)
// ---------------------------------------------------------------------------

describe("password sign-in is retired", () => {
  test("retrieve-key says it is gone and names the command to run, instead of 'unknown command'", async () => {
    // The mail sent when an account verified its email, and pages outside this
    // repository, told people to run it. It must prompt for nothing.
    // NEMAR_DEBUG turns the nudge into a log path, which would make the check below vacuous.
    const result = await run(["auth", "retrieve-key"], "http://127.0.0.1:1", {
      env: { NEMAR_DEBUG: undefined },
    });
    expect(result.exitCode).toBe(1);
    expect(result.out).toContain("'nemar auth retrieve-key' no longer exists");
    expect(result.out).toContain("nemar auth login");
    expect(result.out).not.toMatch(/unknown command/i);
    expect(result.out).not.toContain("Password:");
    expect(result.out).not.toContain("Email address:");
    // A command that was retired on purpose is not a crash to report.
    expect(result.out).not.toContain("--debug");
  }, 15000);

  test("retrieve-key ignores flags and arguments an old habit might add", async () => {
    const result = await run(
      ["auth", "retrieve-key", "--email", "a@b.co", "extra"],
      "http://127.0.0.1:1",
    );
    expect(result.exitCode).toBe(1);
    expect(result.out).toContain("nemar auth login");
  }, 15000);

  test("auth --help does not list the retired command and names no password", async () => {
    const result = await run(["auth", "--help"], "http://127.0.0.1:1");
    expect(result.out).not.toContain("retrieve-key");
    expect(result.out).not.toMatch(/password/i);
  }, 15000);

  test("regenerate-key still warns that it revokes every machine's key, without a deprecation line", async () => {
    const result = await run(["auth", "regenerate-key"], "http://127.0.0.1:1");
    expect(result.out).not.toContain("Password sign-in is deprecated");
    expect(result.out).toContain("EVERY machine");
    expect(result.out).toContain("nemar auth keys revoke");
  }, 15000);

  test("regenerate-key tells the person to paste the new key with -k, not to run a bare login", async () => {
    // A bare `nemar auth login` starts the browser flow and ignores the key,
    // so the regenerated key would be orphaned and another one minted.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/notices") return Response.json({ notices: [] });
        if (url.pathname === "/auth/request-key-regeneration" && req.method === "POST") {
          return Response.json({
            message:
              "If an active account exists with this email, a verification link will be sent",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await run(["auth", "regenerate-key"], `http://localhost:${server.port}`, {
        stdin: new Blob(["ada@example.org\n"]),
      });
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("nemar auth login -k <new-key>");
    } finally {
      server.stop(true);
    }
  }, 15000);

  test("regenerate-key exits non-zero when the request fails", async () => {
    // It is the only way to replace a lost key without a signed-in machine, so
    // a failure has to reach a script and not only a person reading the output.
    const result = await run(["auth", "regenerate-key"], "http://127.0.0.1:1", {
      stdin: new Blob(["ada@example.org\n"]),
    });
    expect(result.exitCode).toBe(1);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 18: root shortcuts
// ---------------------------------------------------------------------------

describe("root shortcuts accept the same flags as their auth subcommands", () => {
  test("nemar login --no-open", async () => {
    const server = startDeviceServer({ interval: 1, token: [{ kind: "success" }] });
    try {
      const result = await run(["login", "--no-open"], server.url);
      expect(result.exitCode).toBe(0);
      expect(Object.keys(storedAccounts())).toEqual(["ada"]);
    } finally {
      server.stop();
    }
  });

  test("nemar signup with completion flags", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      user: defaultUser({ username: null }),
      me: gapsMe(["username"]),
    });
    try {
      const result = await run(
        ["signup", "--no-open", "--username", "alovelace", "--why", WHY],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      const patchCalls = server.calls.filter((c) => c.path === "/auth/profile");
      expect(patchCalls.length).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("nemar logout -y", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: { apiKey: "nm_paste_key_0123456789abcdef", username: "ada", keySource: "paste" },
      },
    });
    const result = await run(["logout", "-y"], "http://127.0.0.1:1");
    expect(result.exitCode).toBe(0);
    expect(readRawAccounts().ada).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 19: --debug never leaks a secret
// ---------------------------------------------------------------------------

function findDebugLog(): string {
  const logsDir = join(configDir, "logs");
  const files = readdirSync(logsDir);
  const logFile = files.find((f) => f.endsWith(".log"));
  if (!logFile) throw new Error(`no debug log written in ${logsDir}`);
  return readFileSync(join(logsDir, logFile), "utf8");
}

describe("--debug", () => {
  test("the log contains neither the device_code value nor the api_key", async () => {
    const server = startDeviceServer({
      interval: 1,
      token: [{ kind: "success" }],
      apiKey: "nm_secretkey_0123456789abcdef",
    });
    try {
      const result = await run(["auth", "login", "--no-open"], server.url, { debug: true });
      expect(result.exitCode).toBe(0);
      const log = findDebugLog();
      expect(log).not.toContain("nm_secretkey_0123456789abcdef");
      expect(log).not.toContain("device-code-1");
      expect(log).toContain("[REDACTED]");
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// confirm()'s non-interactive guard: the --key path is the only one that
// still asks a question, so it is the one place a removed isTTY guard would
// surface as an inquirer crash under a closed stdin instead of a graceful
// decline.
// ---------------------------------------------------------------------------

describe("nemar auth login --key: the 'add a different account?' prompt", () => {
  test("a closed stdin declines gracefully instead of crashing inquirer", async () => {
    seedConfig({
      activeAccount: "ada",
      accounts: {
        ada: {
          apiKey: "nm_active_key_0123456789abcdef",
          username: "ada",
          email: "ada@example.org",
        },
      },
    });
    // Unreachable on purpose: the preflight probe fails, which still routes
    // to the "active account" branch (decideLoginPreflight's "unknown" case)
    // and reaches the same confirm() prompt -- no stand-in server needed.
    const result = await run(
      ["auth", "login", "--key", "nm_new_key_0123456789abcdefgh"],
      "http://127.0.0.1:1",
    );
    expect(result.out).toContain("Interactive prompt unavailable; use --yes or --no");
    expect(activeAccount().apiKey).toBe("nm_active_key_0123456789abcdef");
  });
});
