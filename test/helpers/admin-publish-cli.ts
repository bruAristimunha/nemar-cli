/**
 * The real `nemar` binary against the real NEMAR API, for the tests of `nemar admin publish`.
 *
 * What is real: the command (`bun run src/index.ts ...` as a child process, with its own
 * configuration directory), and the NEMAR API, which is the backend's own admin, dataset and
 * webhook routers behind their real auth middleware and token checks, over bun:sqlite with every
 * migration applied, served on a local port and reached through TEST_API_URL. A test seeds rows and
 * keys the way the backend's own tests do and reads the database after the command ran.
 *
 * What is a stand-in, and only at the boundary of a service this repository does not run: GitHub
 * (a `Bun.serve()` answering what the approval's gates read and recording every call, reached
 * through `NEMAR_GITHUB_API_URL`) and Resend (`withFakeResend`, which redirects api.resend.com to a
 * local server for the duration of each command). No NEMAR answer is ever canned, so a refusal a
 * test sees is a refusal the Worker made.
 *
 * Usage, once per test file:
 *
 *   const h = startPublishCli();
 *   afterAll(() => h.stop());
 *   beforeEach(async () => {
 *     h.reset();
 *     await h.admin("alice", "alice-key-0123456789abcdef");
 *     seedScreenedRequest(h.db, { datasetId: "nm000460" });
 *   });
 *   test("...", async () => {
 *     const r = await h.cli(["admin", "publish", "list"]);
 *     expect(r.exitCode).toBe(0);
 *   });
 *
 * Nothing here reaches a real user, host or credential: the keys are seeded into the in-memory
 * database, every depositor and administrator is an example.org address, and a mail sent by the
 * Worker lands in the stand-in, never at Resend.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import type { Bindings } from "../../backend/src/types/bindings";
import { freshDb, realD1 } from "../../backend/test/helpers/d1";
import { SCREENED_HEAD, mainRefAnswer } from "../../backend/test/helpers/identifier-screen";
import { seedUser } from "../../backend/test/helpers/publication-review";
import { makePublicationReviewApp } from "../../backend/test/helpers/publication-review-app";
import { type D1Hooks, hookedD1 } from "../../backend/test/helpers/publication-review-harness";
import {
  type CapturedEmail,
  type FakeResendOptions,
  withFakeResend,
} from "../../backend/test/helpers/resend";

/** How long a command driven on a terminal may keep running once its driver has finished. */
const EXIT_WAIT_MS = 20_000;
/**
 * How long after a command exits the terminal may take to deliver the rest of what it wrote: its
 * end of file normally comes within a few milliseconds, so this only bounds a platform that never
 * reports one.
 */
const DRAIN_WAIT_MS = 5_000;

/** Variables of the runner's own environment that change what the command does, so no command inherits them. */
const AMBIENT_NOT_INHERITED = ["NEMAR_APPROVAL_DISPATCH_TOKEN", "NEMAR_DEBUG"];

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The token the Worker presents to the GitHub stand-in, so a test can tell it from a person's. */
export const WORKER_GITHUB_TOKEN = "ghp_publish_cli_worker_token";
const CALLBACK_SECRET = "publish-cli-callback-secret";

/** One call the GitHub stand-in received. */
export interface GitHubCall {
  method: string;
  path: string;
  /** The `Authorization` credential without its scheme, or null. */
  token: string | null;
  /** The JSON body of a write, or null. */
  body: Record<string, unknown> | null;
}

/** A repository dispatch the Worker sent, as the workflow would receive it. */
export interface Dispatch {
  event_type: string;
  client_payload: Record<string, unknown>;
}

/** One request the NEMAR API served (the notices and facets calls every command makes excluded). */
export interface ApiCall {
  method: string;
  path: string;
  status: number;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A command run on a real terminal (a pseudo-terminal, so `process.stdin.isTTY` is true and a
 * person's type-ahead behaves as it does for a person). Standard output and standard error share
 * the terminal, so the result's `stdout` is the whole transcript (line ends as `\n`) and `stderr`
 * is empty.
 */
export interface TerminalSession {
  /** Everything the command has written to its terminal so far. */
  transcript(): string;
  /** Type `text` as a person would; `\n` is the Enter key. */
  type(text: string): void;
  /**
   * Wait until the transcript contains `text`, looking only at what was written after the first
   * `after` characters, and return where the match ended. Rejects, killing the command, when it has
   * not appeared in `timeoutMs` (default 20 seconds), so a command that stopped listening fails a
   * test and does not hang it.
   */
  waitFor(text: string, opts?: { after?: number; timeoutMs?: number }): Promise<number>;
}

export interface CliOptions {
  /** Piped to the command's standard input. Without it the command has no input at all. */
  input?: string;
  /** Run on a terminal and drive it with this function instead of piping `input`. */
  terminal?: (session: TerminalSession) => Promise<void>;
  /**
   * With `terminal`: standard output is a pipe (read from a file, as `cmd --json | jq` does at a
   * prompt) while standard input and standard error stay the terminal. The result's `stdout` is then
   * what went down the pipe and its `stderr` is the terminal's transcript.
   */
  pipeStdout?: boolean;
  /** The username of a seeded account to run as. Default: the last account seeded. */
  as?: string;
  /** Run with no account signed in. */
  signedOut?: boolean;
  /** How the Resend stand-in answers for this run (a refusal, a lost answer). */
  resend?: FakeResendOptions;
  /**
   * Point the command at another API address than the real backend's (`PublishCli.apiUrl`): how a
   * test runs it against a Worker of another version that sits in front of the real one
   * (`startOldWorker` in `old-worker.ts`).
   */
  apiUrl?: string;
  /**
   * Extra environment variables for the command, e.g. `NEMAR_APPROVE_RETRY_DELAY_MS` so a test of
   * the retry does not sleep. The harness's own variables (the configuration directory, the API and
   * GitHub addresses, the colour switches) always win over these.
   */
  env?: Record<string, string>;
}

export interface PublishCli {
  /** The backend's database: every migration applied, rebuilt by `reset()`. */
  readonly db: Database;
  /** Where the real backend answers, for a stand-in that forwards to it. */
  readonly apiUrl: string;
  /** The bindings the next request is answered with. */
  env(): Bindings;
  /** Merge `over` into the bindings until the next `reset()`, e.g. `{ PUBLICATION_REVIEW_ENABLED: "1" }`. */
  setEnv(over: Partial<Bindings>): void;
  /** What the GitHub stand-in answers for `git/ref/heads/main`: the head the screen must have read. */
  mainHead: { value: string };
  /** What the stand-in's BIDS validation workflow run concluded (`success` unless a test says). */
  bidsConclusion: { value: string };
  /**
   * How long the GitHub stand-in waits before it answers each call, in milliseconds (0 unless a
   * test says): how a test makes an approval slow enough to interrupt. Reset to 0 by `reset()`.
   */
  githubDelayMs: { value: number };
  /** What the GitHub stand-in saw and what the Worker dispatched; cleared in place by `reset()`. */
  github: { seen: GitHubCall[]; dispatches: Dispatch[] };
  /** Every request the NEMAR API served for a command; cleared in place by `reset()`. */
  requests: ApiCall[];
  /**
   * The JSON body of every write the NEMAR API received, in order; cleared in place by `reset()`.
   * `dispatchToken` is whether the request carried the `X-Approval-Dispatch-Token` header (never its
   * value: a test that needs the value has the dispatch payload), so a test can say which calls of a
   * run presented the executor's proof.
   */
  posted: Array<{ path: string; body: Record<string, unknown> | null; dispatchToken: boolean }>;
  /**
   * The value of the `X-Approval-Dispatch-Token` header, as the API received it, of each write that
   * carried one, in order; cleared in place by `reset()`. For a test of what the command did to a
   * value before it sent it (a test-minted token, never a real credential), so one that only needs
   * to know whether a call carried the proof reads `posted[].dispatchToken`.
   */
  dispatchTokenValues: string[];
  /** The command's configuration directory, where `--debug` writes its `logs/` (a test reads them back). */
  readonly configDir: string;
  /** Every mail the Worker sent through Resend during a command; cleared in place by `reset()`. */
  mail: CapturedEmail[];
  /** A fresh database, no accounts, and every knob above back at its default. Call it before each test. */
  reset(): void;
  /** Seed an account with `role` and an API key, and make it a signed-in account; returns its id. */
  user(username: string, role: string, key: string): Promise<number>;
  /** `user(username, "admin", key)`. */
  admin(username: string, key: string): Promise<number>;
  /**
   * Run `nemar ...args` (the arguments after the program name) against this API and wait for it.
   * The mail and the deferred work the request left behind are finished before it returns.
   */
  cli(args: string[], opts?: CliOptions): Promise<CliResult>;
  /**
   * Run `hook` once, after the API has answered the next request whose `METHOD path` equals
   * `match` and before the command can send its next one: how a test changes the database between
   * a command's read and its write. Cleared by `reset()`.
   */
  after(match: string, hook: () => void): void;
  /** Wrap the API's database with `hookedD1`, e.g. to fail every read of a table. Cleared by `reset()`. */
  hookDb(hooks: D1Hooks): void;
  /**
   * Change the JSON body of every answer to `METHOD path` (e.g. `GET /admin/publish/nm000460/review`)
   * with `change`, which edits it in place or returns a replacement; the status and headers are
   * kept. For what a Worker of another version might send and this one never does: the answer is
   * still the real route's, with one field gone or altered. Cleared by `reset()`.
   */
  rewrite(match: string, change: (body: Record<string, unknown>) => unknown): void;
  /** Wait for everything the Worker deferred after an answer. */
  settled(): Promise<void>;
  /** Stop both servers, remove the configuration directory and put the global back. */
  stop(): void;
}

type GlobalWithGitHub = { NEMAR_GITHUB_API_URL?: string };

/** The reads of an approval's gates and checks that the stand-in answers; null for any other. */
function readsAnswer(req: Request, path: string, bidsConclusion: string): Response | null {
  if (req.method !== "GET") return null;
  if (/\/contents\/\.github\/workflows\/bids-validation\.yml$/.test(path)) {
    return Response.json({ name: "bids-validation.yml" });
  }
  if (/\/actions\/workflows\/bids-validation\.yml\/runs$/.test(path)) {
    return Response.json({
      workflow_runs: [{ status: "completed", conclusion: bidsConclusion, html_url: "x" }],
    });
  }
  if (/\/contents\/dataset_description\.json$/.test(path)) {
    return Response.json({
      encoding: "base64",
      content: btoa(
        JSON.stringify({
          Name: "A sufficiently descriptive dataset title",
          Authors: ["Ada Lovelace"],
          EthicsApprovals: ["Approved by an institutional review board"],
        }),
      ),
    });
  }
  if (/\/contents\/README\.md$/.test(path)) {
    return Response.json({ encoding: "base64", content: btoa("# README") });
  }
  return null;
}

export function startPublishCli(): PublishCli {
  const app = makePublicationReviewApp();
  const configDir = mkdtempSync(join(tmpdir(), "nemar-publish-cli-"));
  const globals = globalThis as GlobalWithGitHub;
  const previousGitHubUrl = globals.NEMAR_GITHUB_API_URL;

  let db = freshDb();
  let envOver: Partial<Bindings> = {};
  let d1Hooks: D1Hooks | null = null;
  let afterHooks: Array<{ match: string; hook: () => void }> = [];
  let rewrites: Array<{ match: string; change: (body: Record<string, unknown>) => unknown }> = [];
  let active: string | null = null;
  let running = false;
  const keys = new Map<string, string>();

  const mainHead = { value: SCREENED_HEAD };
  const bidsConclusion = { value: "success" };
  const githubDelayMs = { value: 0 };
  const github: PublishCli["github"] = { seen: [], dispatches: [] };
  const requests: ApiCall[] = [];
  const posted: PublishCli["posted"] = [];
  const dispatchTokenValues: string[] = [];
  const mail: CapturedEmail[] = [];

  const githubServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization");
      const body =
        req.method === "GET"
          ? null
          : ((await req.json().catch(() => null)) as Record<string, unknown> | null);
      github.seen.push({
        method: req.method,
        path,
        token: auth ? auth.replace(/^\S+\s+/, "") : null,
        body,
      });
      if (githubDelayMs.value > 0) await Bun.sleep(githubDelayMs.value);
      const ref = mainRefAnswer(req, mainHead.value);
      if (ref) return ref;
      if (req.method === "POST" && path === "/repos/nemarDatasets/.github/dispatches") {
        github.dispatches.push(body as unknown as Dispatch);
        return new Response(null, { status: 204 });
      }
      return (
        readsAnswer(req, path, bidsConclusion.value) ?? new Response("not found", { status: 404 })
      );
    },
  });
  globals.NEMAR_GITHUB_API_URL = `http://127.0.0.1:${githubServer.port}`;

  function env(): Bindings {
    const real = realD1(db);
    return {
      DB: d1Hooks ? hookedD1(real, d1Hooks) : real,
      ENVIRONMENT: "production",
      GITHUB_ADMIN_PAT: WORKER_GITHUB_TOKEN,
      PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
      API_BASE_URL: "https://api.test.nemar.org",
      RESEND_API_KEY: "re_publish_cli_test",
      FROM_EMAIL: "NEMAR <noreply@nemar.org>",
      ...envOver,
    } as Bindings;
  }

  const apiServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Every command asks for the system notices first, and some refresh the facets. Neither is
      // what a test of the publication commands is about, so the harness answers them itself.
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (req.method !== "GET") {
        const body = await req
          .clone()
          .json()
          .catch(() => null);
        posted.push({
          path: url.pathname,
          body,
          dispatchToken: req.headers.has("x-approval-dispatch-token"),
        });
        const proof = req.headers.get("x-approval-dispatch-token");
        if (proof !== null) dispatchTokenValues.push(proof);
      }
      const res = await app.handle(req, env());
      requests.push({ method: req.method, path: url.pathname, status: res.status });
      const at = afterHooks.findIndex((h) => h.match === `${req.method} ${url.pathname}`);
      if (at >= 0) {
        const [{ hook }] = afterHooks.splice(at, 1);
        hook();
      }
      const rewrite = rewrites.find((r) => r.match === `${req.method} ${url.pathname}`);
      if (rewrite) {
        const body = (await res.clone().json()) as Record<string, unknown>;
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(rewrite.change(body) ?? body), {
          status: res.status,
          headers,
        });
      }
      return res;
    },
  });

  function writeConfig(as: string | null): void {
    const accounts: Record<string, { apiKey: string }> = {};
    for (const [name, apiKey] of keys) accounts[name] = { apiKey };
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(as === null ? {} : { activeAccount: as, accounts }),
    );
  }

  async function runOnTerminal(
    args: string[],
    baseEnv: Record<string, string>,
    drive: (session: TerminalSession) => Promise<void>,
    pipeStdout: boolean,
  ): Promise<CliResult> {
    // What a person's terminal has: a terminal type, and no CI variable, which turns the spinner
    // (and with it the spinner's handling of standard input) off.
    const env: Record<string, string> = { ...baseEnv, TERM: "xterm-256color" };
    Reflect.deleteProperty(env, "CI");
    // A command whose standard output is a pipe: the shell opens the file the way `> file` does,
    // and `exec` hands its terminal (standard input and standard error) to the command.
    const stdoutFile = join(configDir, `stdout-${process.pid}-${Date.now()}.txt`);
    const cmd = [process.execPath, "run", CLI_ENTRY, ...args];
    if (pipeStdout) env.NEMAR_TEST_STDOUT = stdoutFile;
    const decoder = new TextDecoder();
    let raw = "";
    // A terminal ends a line with CR LF; the transcript, and every offset in it, uses LF.
    const view = () => raw.replaceAll("\r\n", "\n");
    let wake: Array<() => void> = [];
    let exited = false;
    let closeTerminal: () => void = () => undefined;
    const terminalClosed = new Promise<void>((resolve) => {
      closeTerminal = resolve;
    });
    const proc = spawn({
      cmd: pipeStdout ? ["/bin/sh", "-c", 'exec "$0" "$@" > "$NEMAR_TEST_STDOUT"', ...cmd] : cmd,
      cwd: REPO_ROOT,
      env,
      terminal: {
        cols: 200,
        rows: 50,
        data(_terminal, chunk) {
          raw += decoder.decode(chunk, { stream: true });
          for (const w of wake.splice(0)) w();
        },
        // The terminal's end of file: nothing more can arrive after it.
        exit() {
          closeTerminal();
        },
      },
    });
    // The command has exited AND its terminal has delivered everything it wrote. The exit alone is
    // not enough: the last chunk can still be on its way, and a transcript read at the exit loses
    // its last line under load.
    const drained = proc.exited.then(() =>
      Promise.race([terminalClosed, Bun.sleep(DRAIN_WAIT_MS)]),
    );
    void proc.exited.then(() => {
      exited = true;
      for (const w of wake.splice(0)) w();
    });
    const session: TerminalSession = {
      transcript: view,
      type: (text) => {
        proc.terminal?.write(text);
      },
      async waitFor(text, o = {}) {
        const from = o.after ?? 0;
        const deadline = Date.now() + (o.timeoutMs ?? 20_000);
        let drainedOnce = false;
        for (;;) {
          const at = view().indexOf(text, from);
          if (at >= 0) return at + text.length;
          // The command ended without the text: what its terminal had not yet delivered is read
          // once before the text is declared absent.
          if (exited && !drainedOnce) {
            drainedOnce = true;
            await drained;
            continue;
          }
          const left = deadline - Date.now();
          if (exited || left <= 0) {
            proc.kill();
            throw new Error(
              `the command ${exited ? "ended" : "wrote"} no ${JSON.stringify(text)}${exited ? "" : " in time"}; its terminal shows:\n${view()}`,
            );
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(left, 250));
            wake.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      },
    };
    let failure: unknown;
    const driven = drive(session).catch((error: unknown) => {
      failure = error;
      proc.kill();
    });
    // Once the driver is done the command has to finish by itself: one that stopped reading its
    // terminal would otherwise hang the test.
    await driven;
    const hung = setTimeout(() => {
      failure = new Error(
        `the command was still running ${EXIT_WAIT_MS / 1000} seconds after its terminal was driven; it shows:\n${view()}`,
      );
      proc.kill();
    }, EXIT_WAIT_MS);
    const exitCode = await proc.exited;
    clearTimeout(hung);
    await drained;
    wake = [];
    let piped = "";
    if (pipeStdout) {
      piped = existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf8") : "";
      rmSync(stdoutFile, { force: true });
    }
    if (failure !== undefined) throw failure;
    return pipeStdout
      ? { stdout: piped, stderr: view(), exitCode }
      : { stdout: view(), stderr: "", exitCode };
  }

  async function run(args: string[], opts: CliOptions): Promise<CliResult> {
    // What the runner's own shell happens to hold is not what a test meant to run with: a stale
    // dispatch token would turn a person's approval into an executor's, and a debug switch would
    // write logs nobody asked for. A test that wants either passes it in `opts.env`.
    const ambient: Record<string, string | undefined> = { ...process.env };
    for (const name of AMBIENT_NOT_INHERITED) Reflect.deleteProperty(ambient, name);
    const childEnv: Record<string, string | undefined> = {
      ...ambient,
      ...opts.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: opts.apiUrl ?? `http://127.0.0.1:${apiServer.port}`,
      NEMAR_GITHUB_API_URL: `http://127.0.0.1:${githubServer.port}`,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
      // A key from the environment would sign the command in as somebody the test did not seed.
      NEMAR_API_KEY: undefined,
    };
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(childEnv)) if (v !== undefined) clean[k] = v;
    if (opts.terminal) return runOnTerminal(args, clean, opts.terminal, opts.pipeStdout === true);
    const proc = spawn({
      cmd: [process.execPath, "run", CLI_ENTRY, ...args],
      cwd: REPO_ROOT,
      env: clean,
      stdin: opts.input === undefined ? "ignore" : new Blob([opts.input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, exitCode: await proc.exited };
  }

  const h: PublishCli = {
    get db() {
      return db;
    },
    configDir,
    apiUrl: `http://127.0.0.1:${apiServer.port}`,
    env,
    setEnv(over) {
      envOver = { ...envOver, ...over };
    },
    mainHead,
    bidsConclusion,
    githubDelayMs,
    github,
    requests,
    posted,
    dispatchTokenValues,
    mail,
    reset() {
      db = freshDb();
      envOver = {};
      d1Hooks = null;
      afterHooks = [];
      rewrites = [];
      active = null;
      keys.clear();
      mainHead.value = SCREENED_HEAD;
      bidsConclusion.value = "success";
      githubDelayMs.value = 0;
      github.seen.length = 0;
      github.dispatches.length = 0;
      requests.length = 0;
      posted.length = 0;
      dispatchTokenValues.length = 0;
      mail.length = 0;
      writeConfig(null);
    },
    async user(username, role, key) {
      const id = await seedUser(db, username, role, key);
      keys.set(username, key);
      active = username;
      return id;
    },
    admin(username, key) {
      return h.user(username, "admin", key);
    },
    async cli(args, opts = {}) {
      // `withFakeResend` swaps the process-wide fetch for the length of a run, so two runs at once
      // would restore each other's. A test that needs two commands awaits one before the other.
      if (running) throw new Error("h.cli() runs one command at a time");
      const as = opts.signedOut ? null : (opts.as ?? active);
      if (as !== null && !keys.has(as)) {
        throw new Error(`h.cli(): no account "${as}" was seeded (use h.user or h.admin first)`);
      }
      writeConfig(as);
      running = true;
      try {
        return await withFakeResend(async (calls) => {
          try {
            const result = await run(args, opts);
            await app.settled();
            return result;
          } finally {
            mail.push(...calls);
          }
        }, opts.resend);
      } finally {
        running = false;
      }
    },
    after(match, hook) {
      afterHooks.push({ match, hook });
    },
    hookDb(hooks) {
      d1Hooks = hooks;
    },
    rewrite(match, change) {
      rewrites.push({ match, change });
    },
    settled: () => app.settled(),
    stop() {
      apiServer.stop(true);
      githubServer.stop(true);
      globals.NEMAR_GITHUB_API_URL = previousGitHubUrl;
      rmSync(configDir, { recursive: true, force: true });
    },
  };
  h.reset();
  return h;
}
