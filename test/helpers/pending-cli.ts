/**
 * The harness shared by the CLI tests of the pending-validation output
 * (test/publish-pending-cli.test.ts and test/publish-status-pending-cli.test.ts):
 * a stand-in backend, an isolated config directory, and a way to run the real
 * CLI against them.
 *
 * The CLI is a real subprocess (`bun run src/index.ts ...`) pointed at the
 * stand-in through config.json (the account's apiUrl) with a placeholder key.
 * The stand-in answers the two calls every invocation makes on its own (the
 * notices banner and the facets refresh) and the routes under test. It is the
 * HTTP condition the CLIENT is checked against, not a replacement for any CLI
 * logic. The bodies it sends have the key sets the real route sends, which
 * backend/test/publish-request-ci-pending.test.ts pins from the route itself.
 * Nothing here may reach the network, the real API or a real repository: the
 * child gets a dead proxy for everything except loopback.
 *
 * This file is outside the `test/*.test.ts` glob, so it is not sorted into a CI
 * tier itself; the test files that import it must still avoid the names test.yml
 * greps for (the live-backend environment variable, the request helper and the
 * CLI-runner helper), comments included.
 */

import { afterAll, afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { SUBMISSION_POLICY_URL } from "../../backend/src/services/submission-minimums";
import { OWNER_NAME_MISSING_MESSAGE } from "../../backend/src/services/uploader-identity";
import { describeScreen } from "../../shared/identifier-screen-report";
import { ciPendingHint } from "../../src/lib/publish-pending";

export { OWNER_NAME_MISSING_MESSAGE, SUBMISSION_POLICY_URL };

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");
export const DATASET_ID = "nm099999";
export const CI_URL = `https://github.com/nemarDatasets/${DATASET_ID}/actions`;
const SPAWN_KILL_MS = 20_000;
export const SPAWN_TEST_TIMEOUT_MS = 30_000;
// Variables dropped from the child: color forcing would change the text the
// tests read (the tests that WANT color ask for it explicitly), and any proxy
// setting of the parent would send a request somewhere the test did not plan.
const SCRUBBED_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FORCE_COLOR",
  "CLICOLOR_FORCE",
  "NO_COLOR",
];
// A proxy nothing listens on, with loopback exempt: the stand-in is reached
// directly, and a request to anywhere else (the real API, if the config shape
// ever drifted and the CLI fell back to its default URL) fails instead of
// leaving the machine.
const DEAD_PROXY = "http://127.0.0.1:9";

// ANSI sequences for red text, in the forms a 16-, 256- and true-color terminal
// get: the error styling the pending state must not carry.
export const RED =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
  /\u001b\[(?:[0-9;]*;)?(?:31|91)m|\u001b\[38;5;(?:1|9|160|196)m|\u001b\[38;2;2[0-9]{2};/;
export const FAIL_MARK = /[✖×]/;

// The bodies POST /datasets/:id/publish/request sends. The sentences are the
// server's; the key sets are pinned against the route in
// backend/test/publish-request-ci-pending.test.ts.
export const PENDING_BODY = {
  status: "blocked",
  block_reason: "bids_validation_pending",
  message:
    "BIDS validation has not run yet. Your request is recorded and continues automatically once validation passes.",
  dataset_id: DATASET_ID,
  anonymous: false,
  ci_url: CI_URL,
};
export const IN_PROGRESS_BODY = {
  ...PENDING_BODY,
  block_reason: "bids_validation_in_progress",
  message:
    "BIDS validation is currently running. Your request is recorded and continues automatically once validation passes.",
};
export const FAILED_BODY = {
  ...PENDING_BODY,
  block_reason: "bids_validation_failed",
  message:
    "BIDS validation is failing on your dataset. Please check the repository CI and fix validation errors, then re-request publication.",
};
export const MINIMUM_REASONS = [
  "Dataset Name must be a descriptive title of at least 25 characters (currently 5).",
  "An ethics approval statement is required: fill the EthicsApprovals field of dataset_description.json, or add an ethics/IRB statement to the README.",
];
export const MINIMUMS_BODY = {
  ...PENDING_BODY,
  block_reason: "min_requirements_failed",
  message:
    "The dataset does not meet the minimum submission requirements. Fix the stated items and re-request publication.",
  reasons: MINIMUM_REASONS,
  policy_url: SUBMISSION_POLICY_URL,
  details: { reasons: MINIMUM_REASONS, policy_url: SUBMISSION_POLICY_URL },
};
export const OWNER_NAME_BODY = {
  ...PENDING_BODY,
  block_reason: "owner_name_missing",
  message: OWNER_NAME_MISSING_MESSAGE,
};
export const ACCEPTED_BODY = {
  message: "Publication request submitted",
  dataset_id: DATASET_ID,
  status: "requested",
  anonymous: false,
  identifier_screen: {
    state: "pending",
    headline: "Identifier screen: running",
    tone: "note",
    lines: [],
  },
  request_notice: [],
};
// The 503 the route sends when it could not check validation status at all.
export const CI_UNAVAILABLE_BODY = {
  error: "ci_check_unavailable",
  message:
    "NEMAR could not check BIDS validation status right now (a temporary GitHub or credential problem). Your request is recorded; try again later or contact an administrator.",
  dataset_id: DATASET_ID,
  anonymous: false,
  ci_url: CI_URL,
};

/** The body of GET /datasets/:id/publish/status for a blocked request. */
export function statusBody(over: Record<string, unknown> = {}) {
  const screen = describeScreen(null, null);
  return {
    dataset_id: DATASET_ID,
    status: "blocked",
    requested_at: "2026-10-07 20:00:00",
    requested_by: "someone",
    approved_at: null,
    denied_at: null,
    denied_reason: null,
    block_reason: "bids_validation_pending",
    message: PENDING_BODY.message,
    ci_url: CI_URL,
    anonymous: false,
    identifier_screen: {
      state: null,
      headline: screen.headline,
      tone: screen.tone,
      lines: screen.lines,
    },
    steps_completed: [],
    current_step: null,
    last_error: null,
    updated_at: "2026-10-07 20:00:00",
    ...over,
  };
}

export interface Reply {
  status: number;
  body: unknown;
}

export interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The stand-in backend: what it answers, and what it was asked. */
export interface StandIn {
  url: string;
  /** Every request seen (the two start-up calls excluded), as "METHOD /path". */
  hits: string[];
  /** The body of each request in `hits`. */
  bodies: string[];
  /** The answer to POST /datasets/<id>/publish/request. */
  reply: Reply;
  /** The answer to GET /datasets/<id>/publish/status. */
  statusReply: Reply;
  /** Forget what was asked and go back to answering an accepted request and a pending status. */
  reset: () => void;
  stop: () => void;
}

export function startStandIn(): StandIn {
  const standIn: StandIn = {
    url: "",
    hits: [],
    bodies: [],
    reply: { status: 200, body: ACCEPTED_BODY },
    statusReply: { status: 200, body: statusBody() },
    reset: () => {
      standIn.hits.length = 0;
      standIn.bodies.length = 0;
      standIn.reply = { status: 200, body: ACCEPTED_BODY };
      standIn.statusReply = { status: 200, body: statusBody() };
    },
    stop: () => {},
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      // The two calls every invocation makes on its own: the notices banner
      // (a preAction hook) and a fire-and-forget facets refresh.
      if (pathname === "/notices") return Response.json({ notices: [] });
      if (pathname === "/datasets/facets") return Response.json({});
      standIn.hits.push(`${req.method} ${pathname}`);
      standIn.bodies.push(await req.text());
      if (pathname === `/datasets/${DATASET_ID}/publish/request`) {
        return Response.json(standIn.reply.body, { status: standIn.reply.status });
      }
      if (pathname === `/datasets/${DATASET_ID}/publish/status`) {
        return Response.json(standIn.statusReply.body, { status: standIn.statusReply.status });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  standIn.url = `http://127.0.0.1:${server.port}`;
  standIn.stop = () => server.stop(true);
  return standIn;
}

/** A config directory whose only account points at `apiUrl` with a placeholder key. */
export function makeConfigDir(apiUrl: string): string {
  const configDir = mkdtempSync(join(tmpdir(), "nemar-publish-pending-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "pending-cli",
      accounts: { "pending-cli": { apiUrl, apiKey: "placeholder-key" } },
    }),
  );
  return configDir;
}

export function removeConfigDir(configDir: string): void {
  rmSync(configDir, { recursive: true, force: true });
}

/**
 * Run `cmd` in the repository root as a subprocess against `configDir`, with the
 * environment of this process scrubbed of everything that could reroute it and a
 * dead proxy for everything but loopback. `env` adds variables to the child.
 */
export async function spawnBun(
  cmd: string[],
  configDir: string,
  opts: { color?: boolean; env?: Record<string, string> } = {},
): Promise<Run> {
  // Drop every TEST_* variable and the scrubbed set (matched in any case), so
  // nothing ambient can override the config.json URL or reroute the request.
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("TEST_") && !SCRUBBED_ENV.includes(key.toUpperCase()),
    ),
  );
  env.NEMAR_CONFIG_DIR = configDir;
  env.NEMAR_NO_UPDATE_CHECK = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) env[name] = DEAD_PROXY;
  env.NO_PROXY = "127.0.0.1,localhost";
  if (opts.color) env.FORCE_COLOR = "1";
  else env.NO_COLOR = "1";
  Object.assign(env, opts.env);
  const proc = spawn({
    cmd,
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: SPAWN_KILL_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Bun's timeout ends the process with SIGTERM. A command that waits or polls
  // would end up here, which is the failure to report as itself.
  if (proc.signalCode) {
    throw new Error(`${cmd.join(" ")} was ended by ${proc.signalCode} after ${SPAWN_KILL_MS}ms`);
  }
  return { stdout, stderr, exitCode };
}

export function spawnCli(
  configDir: string,
  args: string[],
  opts: { color?: boolean } = {},
): Promise<Run> {
  return spawnBun(["bun", "run", CLI_ENTRY, ...args], configDir, opts);
}

/**
 * The hooks every test file of the pending-validation CLI output repeats: one
 * stand-in backend for the file, reset before each test, and a fresh config
 * directory pointed at it for each. `run` spawns the real CLI against them.
 * Also gives each test the time a subprocess needs.
 */
export function usePendingCliHarness(): {
  standIn: StandIn;
  run: (args: string[], opts?: { color?: boolean }) => Promise<Run>;
} {
  setDefaultTimeout(SPAWN_TEST_TIMEOUT_MS);
  const standIn = startStandIn();
  let configDir = "";
  afterAll(() => standIn.stop());
  beforeEach(() => {
    standIn.reset();
    configDir = makeConfigDir(standIn.url);
  });
  afterEach(() => removeConfigDir(configDir));
  return { standIn, run: (args, opts) => spawnCli(configDir, args, opts) };
}

/**
 * What a pending `publish request` prints on stdout: the hint, then the CI link
 * when the refusal carried one. The headline is on stderr.
 */
export function pendingStdout(anonymous = false, ciUrl: string | null = CI_URL): string {
  const lines = [...ciPendingHint(DATASET_ID, anonymous), ...(ciUrl ? [`  CI: ${ciUrl}`] : [])];
  return `${lines.join("\n")}\n`;
}

/** The text of both streams, for assertions that do not care which one a line is on. */
export const all = (r: Run): string => `${r.stdout}\n${r.stderr}`;
