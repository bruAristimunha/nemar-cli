/**
 * `nemar admin pr-reviews` (ADR 0093, following ADR 0092), driven through the real entry point
 * (`bun run src/index.ts ...`) the way its sibling admin CLI suites are.
 *
 * The NEMAR API is the REAL admin and user routers over bun:sqlite with every migration applied,
 * served on a local port and reached through TEST_API_URL. GitHub is a `Bun.serve()` stand-in that
 * answers `GET /user` by token and records every request with the token it carried, which is what
 * lets this file say the thing that matters: the review the administrator submits is made with
 * THEIR token, and the Worker's token never reached a review or merge endpoint.
 * Isolated NEMAR_CONFIG_DIR, no mocks.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server;
 * it touches no live backend and holds no secret, so it also passes offline.
 */

import type { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makePrQueueApp } from "../backend/test/helpers/pr-queue-app";
import {
  type PrSpec,
  SHA_A,
  SHA_B,
  bidsOk,
  goodReport,
  prNode,
  seedReview,
  versionOk,
} from "../backend/test/helpers/pr-queue-fixtures";
import type { PrReviewDetail, QueueResponse } from "../shared/contract/pr-review-admin";
import {
  ADMIN_TOKEN,
  APP_TOKEN,
  type GitHubStandin,
  OTHER_TOKEN,
  WORKER_TOKEN,
  startGitHubStandin,
} from "./helpers/github-standin";

// Each test starts the CLI two to six times; the default 5 seconds is too thin on a slow runner.
setDefaultTimeout(30_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "cli-queue-admin-key-0123456789abcdef0123456789abcdef";

let gh: GitHubStandin;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
let emptyPath: string;
let envOverrides: Partial<Bindings> = {};
/** Answers a request itself, ahead of the real routes, to stand in for a proxy or an older backend. */
let apiOverride: ((req: Request) => Response | null) | null = null;
/** Every request the NEMAR API received, `METHOD /path?query`. */
let apiRequests: string[] = [];
let handle: ReturnType<typeof makePrQueueApp>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: WORKER_TOKEN,
    PR_REVIEW_ENABLED: "1",
    ...envOverrides,
  } as Bindings;
}

beforeAll(() => {
  gh = startGitHubStandin();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = gh.url;
  handle = makePrQueueApp();
  apiServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      apiRequests.push(`${req.method} ${url.pathname}${url.search}`);
      return apiOverride?.(req) ?? handle(req, env());
    },
  });
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  apiServer.stop(true);
  gh.stop();
});

beforeEach(async () => {
  db = freshDb();
  envOverrides = {};
  apiOverride = null;
  apiRequests = [];
  gh.reset();
  configDir = mkdtempSync(join(tmpdir(), "nemar-pr-reviews-cli-"));
  emptyPath = mkdtempSync(join(tmpdir(), "nemar-no-gh-"));
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES ('queueadmin', 'queueadmin@example.org', 'x', 'queueadmin-gh', 'approved', 'admin',
             'cli', 1, 1)`,
  );
  const row = db.query("SELECT id FROM users WHERE username = 'queueadmin'").get() as {
    id: number;
  };
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "queueadmin",
      accounts: { queueadmin: { apiKey: ADMIN_KEY } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(emptyPath, { recursive: true, force: true });
});

/** The environment a command runs in: this suite's API, GitHub stand-in and configuration. */
function cliEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: `http://127.0.0.1:${apiServer.port}`,
    NEMAR_GITHUB_API_URL: gh.url,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    GH_TOKEN: ADMIN_TOKEN,
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
    ...extra,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(childEnv)) if (v !== undefined) clean[k] = v;
  return clean;
}

/** What a command on a terminal shows and how a person answers it. */
interface Terminal {
  type(text: string): void;
  /** Wait until the transcript holds `text` after offset `after`; returns where it ended. */
  waitFor(text: string, after?: number): Promise<number>;
}

/**
 * Run a command on a real pseudo-terminal (`process.stdin.isTTY` is true, so the type-ahead and
 * paste rules of a person's terminal apply), driven by `drive`. Returns the transcript (line ends
 * as LF) and the exit code. A command that stops listening fails the test rather than hanging it.
 */
async function cliOnTerminal(
  args: string[],
  drive: (t: Terminal) => Promise<void>,
): Promise<{ transcript: string; exitCode: number }> {
  const env = { ...cliEnv({ TERM: "xterm-256color", CI: undefined }) };
  const decoder = new TextDecoder();
  let raw = "";
  const view = () => raw.replaceAll("\r\n", "\n");
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    terminal: {
      cols: 200,
      rows: 50,
      data(_t, chunk) {
        raw += decoder.decode(chunk, { stream: true });
      },
    },
  });
  const t: Terminal = {
    type: (text) => {
      proc.terminal?.write(text);
    },
    async waitFor(text, after = 0) {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const at = view().indexOf(text, after);
        if (at >= 0) return at + text.length;
        if (Date.now() > deadline) {
          proc.kill();
          throw new Error(`no ${JSON.stringify(text)} in time; the terminal shows:\n${view()}`);
        }
        await Bun.sleep(25);
      }
    },
  };
  try {
    await drive(t);
  } catch (error) {
    proc.kill();
    throw error;
  }
  const hung = setTimeout(() => proc.kill(), 20_000);
  const exitCode = await proc.exited;
  clearTimeout(hung);
  await Bun.sleep(100);
  return { transcript: view(), exitCode };
}

async function cli(
  args: string[],
  opts: { env?: Record<string, string | undefined>; input?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const clean = cliEnv(opts.env);
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: clean,
    // Typed answers, for the commands that ask. Without any, stdin is closed.
    stdin: opts.input === undefined ? "ignore" : new Blob([opts.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const PR = ["admin", "pr-reviews"];
const nodes = (...specs: PrSpec[]) => {
  gh.searchPages = [specs.map(prNode)];
};
const seed = (r: Parameters<typeof seedReview>[1]) => seedReview(db, r);
const reviewPosts = () => gh.seen.filter((s) => s.method === "POST" && s.path.endsWith("/reviews"));
const mergePuts = () => gh.seen.filter((s) => s.method === "PUT" && s.path.endsWith("/merge"));
/** Everything the administrator's own token wrote to GitHub: an approval, a merge, a comment, a close. */
const adminWrites = () => gh.seen.filter((s) => s.method !== "GET" && s.token === ADMIN_TOKEN);

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

describe("nemar admin pr-reviews (list)", () => {
  function seedQueue() {
    nodes(
      { ds: "nm000201", n: 12, author: "alice", authorId: 42, branch: "fix-readme" },
      {
        ds: "nm000202",
        n: 3,
        author: "bob",
        authorId: 43,
        forkOwner: "bobfork",
        branch: "add-subjects",
        checks: [{ ...bidsOk("nm000202"), conclusion: "FAILURE" }, versionOk],
      },
      { ds: "nm000203", n: 4, author: "carol", authorId: 44 },
    );
    seed({
      ds: "nm000201",
      n: 12,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    seed({ ds: "nm000202", n: 3, authorId: 43, login: "bob", state: "reported", verdict: "fail" });
  }

  test("is the default: one line per pull request with everything an administrator asks first", async () => {
    seedQueue();
    const r = await cli(PR);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n");
    const row = (ds: string) => lines.find((l) => l.includes(ds)) ?? "";

    const pass = row("nm000201");
    expect(pass).toMatch(
      /^\* nm000201\s+#12\s+alice\s+branch fix-readme\s+pass\s+ok\s+ok\s+\d+d\s+https:\/\/github\.com\/nemarDatasets\/nm000201\/pull\/12$/,
    );
    const fail = row("nm000202");
    expect(fail).toMatch(
      /^ {2}nm000202\s+#3\s+bob\s+fork bobfork:add-subjects\s+fail\s+FAIL\s+ok\s+\d+d\s+https:\/\//,
    );
    expect(row("nm000203")).toMatch(
      /^\* nm000203\s+#4\s+carol\s+branch update-metadata\s+not reviewed\s+ok\s+ok/,
    );

    // What you can act on first: the pass, then the one nobody has decided for you, then the fail.
    expect(lines.findIndex((l) => l.includes("nm000201"))).toBeLessThan(
      lines.findIndex((l) => l.includes("nm000203")),
    );
    expect(lines.findIndex((l) => l.includes("nm000203"))).toBeLessThan(
      lines.findIndex((l) => l.includes("nm000202")),
    );
    expect(r.stdout).toContain("3 open pull requests, 2 you can act on.");
  });

  test("`list` and no subcommand are the same, and options pass through to the default", async () => {
    seedQueue();
    const bare = await cli([...PR, "--needs-me"]);
    const named = await cli([...PR, "list", "--needs-me"]);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toBe(named.stdout);
    expect(bare.stdout).not.toContain("nm000202"); // a fail is the author's to fix
    expect(bare.stdout).toContain("2 of 3 open pull requests");
  });

  test("filters by verdict, dataset and author, and sends them to the API", async () => {
    seedQueue();
    const byVerdict = await cli([...PR, "--verdict", "fail,not-reviewed"]);
    expect(byVerdict.stdout).toContain("nm000202");
    expect(byVerdict.stdout).toContain("nm000203");
    expect(byVerdict.stdout).not.toContain("nm000201");
    expect(
      apiRequests.some(
        (x) => x.includes("verdict=fail%2Cnot_reviewed") || x.includes("verdict=fail,not_reviewed"),
      ),
    ).toBe(true);

    const repeated = await cli([...PR, "--verdict", "pass", "--verdict", "fail"]);
    expect(repeated.stdout).toContain("nm000201");
    expect(repeated.stdout).toContain("nm000202");
    expect(repeated.stdout).not.toContain("nm000203");

    const byDataset = await cli([...PR, "--dataset", "nm000203"]);
    expect(byDataset.exitCode).toBe(0);
    expect(byDataset.stdout).toContain("nm000203");
    expect(byDataset.stdout).not.toContain("nm000201");
    const byAuthor = await cli([...PR, "--author", "ALICE"]);
    expect(byAuthor.exitCode).toBe(0);
    expect(byAuthor.stdout).toContain("nm000201");
    expect(byAuthor.stdout).not.toContain("nm000202");
    const none = await cli([...PR, "--author", "nobody"]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain("No pull requests match (3 open in all).");
  });

  test("an owner's or administrator's pull request reads exempt (owner or admin) and is not marked as yours", async () => {
    // The seeded administrator opened one, and so did a stranger.
    nodes(
      { ds: "nm000201", n: 5, author: "queueadmin-gh", authorId: 4001 },
      { ds: "nm000203", n: 4, author: "carol", authorId: 44 },
    );
    const r = await cli(PR);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n");
    const row = (ds: string) => lines.find((l) => l.includes(ds)) ?? "";
    expect(row("nm000201")).toMatch(
      /^ {2}nm000201\s+#5\s+queueadmin-gh\s+branch update-metadata\s+exempt \(owner or admin\)\s+ok\s+ok/,
    );
    expect(row("nm000203")).toMatch(/^\* nm000203\s+#4\s+carol\s+.*not reviewed/);
    expect(r.stdout).toContain("2 open pull requests, 1 you can act on.");

    // The word can be asked for, with the dash spelling the other words have.
    const only = await cli([...PR, "--verdict", "exempt"]);
    expect(only.exitCode).toBe(0);
    expect(only.stdout).toContain("nm000201");
    expect(only.stdout).not.toContain("nm000203");
    expect((await cli([...PR, "--needs-me"])).stdout).not.toContain("nm000201");
  });

  test("an exempt pull request the naming rule holds says it waits for allow --admin, and the plain one does not", async () => {
    const reviewCheck = (conclusion: string) => ({
      type: "run" as const,
      name: "NEMAR PR Review",
      status: "COMPLETED",
      conclusion,
    });
    nodes(
      {
        ds: "nm000201",
        n: 5,
        author: "queueadmin-gh",
        authorId: 4001,
        checks: [bidsOk("nm000201"), versionOk, reviewCheck("FAILURE")],
      },
      {
        ds: "nm000202",
        n: 6,
        author: "queueadmin-gh",
        authorId: 4001,
        checks: [bidsOk("nm000202"), versionOk, reviewCheck("ACTION_REQUIRED")],
      },
      {
        ds: "nm000203",
        n: 7,
        author: "queueadmin-gh",
        authorId: 4001,
        checks: [bidsOk("nm000203"), versionOk, reviewCheck("SKIPPED")],
      },
    );
    const r = await cli(PR);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n");
    const row = (ds: string) => lines.find((l) => l.includes(ds)) ?? "";
    expect(row("nm000201")).toMatch(/exempt, naming rule failed: needs allow --admin\s+ok\s+ok/);
    expect(row("nm000202")).toMatch(
      /exempt, naming rule not checked: start once, else fix the file\s+ok\s+ok/,
    );
    expect(row("nm000203")).toMatch(/exempt \(owner or admin\)\s+ok\s+ok/);
    // The word reaches the JSON as a closed word, not a sentence.
    const json = JSON.parse((await cli([...PR, "--json"])).stdout) as QueueResponse;
    expect(json.entries.map((e) => [e.dataset_id, e.verdict, e.detail])).toEqual([
      ["nm000201", "exempt", "naming_rule"],
      ["nm000202", "exempt", "naming_unchecked"],
      ["nm000203", "exempt", null],
    ]);
  });

  test("a bad filter is refused before anything is asked of the API", async () => {
    for (const [args, message] of [
      [["--verdict", "great"], "is not a verdict"],
      [["--dataset", "nm1"], "is not a dataset id"],
      [["--author", "-x-"], "is not a GitHub login"],
    ] as const) {
      apiRequests = [];
      const r = await cli([...PR, ...args]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain(message);
      expect(apiRequests.filter((x) => x.includes("/admin/"))).toHaveLength(0);
    }
  });

  test("--json is the raw response and nothing else on stdout", async () => {
    seedQueue();
    const r = await cli([...PR, "--json"]);
    expect(r.exitCode).toBe(0);
    const q = JSON.parse(r.stdout) as QueueResponse;
    expect(q.entries.map((e) => e.dataset_id)).toEqual(["nm000201", "nm000203", "nm000202"]);
    expect(q.entries[0]).toMatchObject({ verdict: "pass", needs_you: true, bids: "pass" });
  });

  test("works while the review is off, and says so", async () => {
    seedQueue();
    envOverrides = { PR_REVIEW_ENABLED: undefined };
    const r = await cli(PR);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("The automated review is off in this environment");
  });

  test("an empty queue is said to be empty only when nothing could have been missed", async () => {
    gh.searchPages = [];
    const empty = await cli(PR);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("No open pull requests to main.");
  });

  test("when the search cannot be read it says so and exits 1, never the empty-queue message", async () => {
    envOverrides = { GITHUB_ADMIN_PAT: undefined };
    const r = await cli(PR);
    expect(r.exitCode).toBe(1);
    // The spinner reports the failure on stderr, as it does for every admin command.
    expect(r.stdout + r.stderr).toContain("NEMAR could not get a GitHub token");
    expect(r.stdout).not.toContain("No open pull requests");
  });

  test("with --json an error goes to stderr and stdout stays empty", async () => {
    envOverrides = { GITHUB_ADMIN_PAT: undefined };
    const r = await cli([...PR, "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("NEMAR could not get a GitHub token");
    const bad = await cli([...PR, "--verdict", "great", "--json"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toBe("");
  });

  test("a list that may be incomplete says so, and an empty one is not a green all-clear", async () => {
    // Twenty-five pages of one pull request each: the Worker stops at its page bound.
    gh.searchPages = Array.from({ length: 25 }, (_, i) => [prNode({ ds: "nm000201", n: i + 1 })]);
    const truncated = await cli(PR);
    expect(truncated.exitCode).toBe(0);
    expect(truncated.stdout).toContain("this list is incomplete");

    // Only a pull request the other environment's Worker owns: not "no open pull requests".
    gh.searchPages = [[prNode({ ds: "xx090001", n: 1 })]];
    const foreign = await cli(PR);
    expect(foreign.stdout).toContain("No open pull requests found in what this Worker can see.");
    expect(foreign.stdout).not.toContain("No open pull requests to main.");
    expect(foreign.stdout).toContain("1 pull request(s) belong to the other environment's Worker");

    // A result that could not be read as a pull request.
    gh.searchPages = [[prNode({ ds: "nm000201", n: 1 }), { __typename: "Issue", number: 5 }]];
    const unreadable = await cli(PR);
    expect(unreadable.stdout).toContain("1 search result(s) could not be read as pull requests");
  });

  test("--json keeps stdout machine-readable and still says when the list may be incomplete", async () => {
    const queue: QueueResponse = {
      environment: "production",
      review_enabled: true,
      entries: [],
      total_open: 0,
      truncated: true,
      skipped: { not_a_dataset: 0, not_owned_here: 0, unreadable: 2 },
      filters: { verdicts: [], dataset: null, author: null, needs_me: false },
      volume: null,
    };
    apiOverride = (req) =>
      new URL(req.url).pathname === "/admin/pr-reviews" ? Response.json(queue) : null;
    const r = await cli([...PR, "list", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ truncated: true });
    expect(r.stderr).toContain("this list is incomplete");
    expect(r.stderr).toContain("2 search result(s) could not be read");
  });

  test("--json sends the not-signed-in message to stderr, so stdout is never half a sentence", async () => {
    const r = await cli([...PR, "list", "--json"], { env: { NEMAR_CONFIG_DIR: emptyPath } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Not authenticated");
  });

  describe("the review volume", () => {
    const hoursAgo = (h: number) =>
      new Date(Date.now() - h * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

    /** Four records in the last day (one a decline) and one three days ago. */
    function seedVolume() {
      nodes({ ds: "nm000203", n: 4, author: "carol", authorId: 44 });
      const at = (n: number, hours: number, r: Omit<Parameters<typeof seed>[0], "ds" | "n">) =>
        seed({ ds: "nm000301", n, authorId: 42, login: "alice", createdAt: hoursAgo(hours), ...r });
      at(1, 1, { state: "reported", verdict: "pass" });
      at(2, 1, { state: "reported", verdict: "pass" });
      at(3, 1, { state: "reported", verdict: "fail" });
      at(4, 1, { state: "declined", detail: "contributor_paused" });
      at(5, 72, { state: "reported", verdict: "pass" });
    }

    test("is printed after the list, in sentences, and says it is only information", async () => {
      seedVolume();
      const r = await cli(PR);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(
        [
          "Review volume, for information only (no count limits reviews):",
          "  Last 24 hours: 4 reviews recorded, 3 review runs; 2 pass, 1 fail, 1 not reviewed (1 contributor paused).",
          "  Last 7 days:   5 reviews recorded, 4 review runs; 3 pass, 1 fail, 1 not reviewed (1 contributor paused).",
        ].join("\n"),
      );
      // Sentences, not a dump: no JSON, no quoted keys, no underscored words.
      const block = r.stdout.slice(r.stdout.indexOf("Review volume"));
      expect(block).not.toMatch(/[{}"]|_/);
    });

    test("is in the --json answer as counts, and the list still prints without it being asked", async () => {
      seedVolume();
      const q = JSON.parse((await cli([...PR, "--json"])).stdout) as QueueResponse;
      expect(q.volume?.last_24_hours).toMatchObject({
        reviews: 4,
        review_runs: 3,
        by_verdict: { pass: 2, fail: 1, not_reviewed: 1 },
        declines: { contributor_paused: 1, rate_limited: 0, daily_limit: 0 },
      });
      expect(q.volume?.last_7_days.reviews).toBe(5);
    });

    test("adds the tokens of the reports that carry them, with an estimate in dollars", async () => {
      seedVolume();
      const usage = (screen: [number, number], review: [number, number]) =>
        JSON.stringify({
          v: 2,
          stage: "full",
          usage: {
            screen: { input_tokens: screen[0], output_tokens: screen[1] },
            review: { input_tokens: review[0], output_tokens: review[1] },
          },
        });
      seed({
        ds: "nm000302",
        n: 1,
        authorId: 42,
        login: "alice",
        createdAt: hoursAgo(1),
        state: "reported",
        verdict: "pass",
        report: usage([3000, 1200], [20000, 8000]),
      });
      const r = await cli(PR);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(
        "  Tokens, 24 hours: 23,000 in and 9,200 out over 1 report (screen 3,000 in, 1,200 out; review 20,000 in, 8,000 out), about $0.12 at list prices; runs that ended without a report are not counted.",
      );
      const block = r.stdout.slice(r.stdout.indexOf("Review volume"));
      expect(block).not.toMatch(/[{}"]|_/);
    });

    test("says when the Worker could not read it, and prints nothing for a server that sends none", async () => {
      const base: QueueResponse = {
        environment: "production",
        review_enabled: true,
        entries: [],
        total_open: 0,
        truncated: false,
        skipped: { not_a_dataset: 0, not_owned_here: 0, unreadable: 0 },
        filters: { verdicts: [], dataset: null, author: null, needs_me: false },
        volume: null,
      };
      apiOverride = (req) =>
        new URL(req.url).pathname === "/admin/pr-reviews" ? Response.json(base) : null;
      const unread = await cli(PR);
      expect(unread.exitCode).toBe(0);
      expect(unread.stdout).toContain("The review volume could not be read this time.");

      const { volume: _unsent, ...older } = base;
      apiOverride = (req) =>
        new URL(req.url).pathname === "/admin/pr-reviews" ? Response.json(older) : null;
      const none = await cli(PR);
      expect(none.exitCode).toBe(0);
      expect(none.stdout).not.toContain("Review volume");
      expect(none.stdout).not.toContain("could not be read this time");
    });
  });

  test("a hostile title, branch or login cannot put a control sequence on the terminal", async () => {
    const esc = String.fromCharCode(27);
    nodes({ ds: "nm000201", n: 1, branch: `x${esc}[2Jy`, title: `${esc}[31mred` });
    const r = await cli(PR);
    expect(r.stdout.includes(esc)).toBe(false);
  });

  test("a member is told it needs admin privileges", async () => {
    db.run("UPDATE users SET role = 'member', status = 'verified'");
    const r = await cli(PR);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("requires admin privileges");
  });
});

// ---------------------------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------------------------

function livePull(
  sha = SHA_A,
  over: Partial<{
    state: "open" | "closed";
    draft: boolean;
    base: string;
    merged: boolean;
    mergeableState: string;
  }> = {},
) {
  gh.pulls["nm000201#7"] = { sha, author: "alice", ...over };
}

describe("the REVIEW column legend", () => {
  test("says what a pass needs: the three questions, and for a version 2 report a clear title and description", async () => {
    const r = await cli([...PR, "--help-all"]);
    expect(r.exitCode).toBe(0);
    const help = r.stdout.replace(/\s+/g, " ");
    expect(help).toContain(
      "pass nothing lost, the revision advances, the dataset is materially better (a version 2 report also needs a clear title and description)",
    );
  });

  test("says what the words on an exempt row mean, and how to release one", async () => {
    const r = await cli([...PR, "--help-all"]);
    const help = r.stdout.replace(/\s+/g, " ");
    expect(help).toContain('"naming rule failed: needs allow --admin"');
    expect(help).toContain('"naming rule not checked: start once, else fix the file"');
    // And why the label does not say to wait: a file with no readable Name is found unreadable again.
    expect(help).toContain("a file with no readable Name has to be fixed and pushed");
    expect(help).toContain("allow <dataset> <pr> --admin --reason <why>");
  });
});

describe("nemar admin pr-reviews allow and block say an owner or administrator is exempt", () => {
  test("in their detailed help, so a block is not read as holding one back", async () => {
    for (const verb of ["allow", "block"]) {
      // The detailed help: `--help` itself keeps to the options and points at `--help-all`.
      const r = await cli([...PR, verb, "--help-all"]);
      expect(r.exitCode, verb).toBe(0);
      expect(r.stdout.replace(/\s+/g, " "), verb).toContain(
        "A NEMAR owner or administrator is exempt from the review whatever is decided here",
      );
    }
  });
});

describe("nemar admin pr-reviews allow <dataset> <pr> --admin: the naming rule's one override", () => {
  /** The dataset the pull request is in, as a live, named publication the review applies to. */
  function reviewable(id: string) {
    db.run(
      `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
    );
    db.run(
      `INSERT INTO datasets
         (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo, first_published_at)
       VALUES (?, 'A dataset', 1, 'active', 'public', 0, ?, '2026-01-01 00:00:00')`,
      [id, `nemarDatasets/${id}`],
    );
  }
  /** The reason every waiver here is given, because the command requires one. */
  const REASON = "Kept until the rename";
  const waivers = () =>
    db
      .query("SELECT details FROM audit_log WHERE action = 'pr_review_naming_waived'")
      .all() as Array<{
      details: string;
    }>;

  test("waives it for an administrator's pull request at its current commit, and says so in sentences", async () => {
    reviewable("nm000201");
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "queueadmin-gh", title: "Lee2019 EEG rename" };
    const r = await cli([
      ...PR,
      "allow",
      "nm000201",
      "7",
      "--admin",
      "--reason",
      "Kept until the rename",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Waived the naming rule for nm000201 #7 at ${SHA_A.slice(0, 7)}.`);
    expect(r.stdout).toContain(
      "The rule found: the title has a citation (an author and a year, or a DOI).",
    );
    expect(r.stdout).toContain("it is for this commit only: a new commit is checked again");
    expect(r.stdout).not.toMatch(/[{}"]|author_year|_waived/);
    expect(waivers()).toHaveLength(1);
    expect(JSON.parse(waivers()[0]?.details ?? "{}")).toMatchObject({
      head_sha: SHA_A,
      reason: "Kept until the rename",
    });
    const check = gh.seen.find((x) => x.method === "POST" && x.path.endsWith("/check-runs"));
    expect(check?.body).toMatchObject({ conclusion: "skipped" });
  });

  test("waives a DOI in the title the same way: the record holds the closed word, the terminal does not", async () => {
    reviewable("nm000201");
    gh.pulls["nm000201#7"] = {
      sha: SHA_A,
      author: "queueadmin-gh",
      title: "Add the recordings described in 10.1038/s41597-020-0532-5",
    };
    const r = await cli([
      ...PR,
      "allow",
      "nm000201",
      "7",
      "--admin",
      "--reason",
      "Kept until the rename",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Waived the naming rule for nm000201 #7 at ${SHA_A.slice(0, 7)}.`);
    expect(r.stdout).toContain(
      "The rule found: the title has a citation (an author and a year, or a DOI).",
    );
    expect(r.stdout).not.toMatch(/[{}"]|\bdoi\b|_waived/);
    expect(waivers()).toHaveLength(1);
    expect(JSON.parse(waivers()[0]?.details ?? "{}")).toMatchObject({
      head_sha: SHA_A,
      title: "doi",
      name: null,
    });
    const check = gh.seen.find((x) => x.method === "POST" && x.path.endsWith("/check-runs"));
    expect(check?.body).toMatchObject({ conclusion: "skipped" });
  });

  describe("--commit", () => {
    const checkPosts = () =>
      gh.seen.filter((x) => x.method === "POST" && x.path.endsWith("/check-runs"));

    test("waives the commit named, and the success text names its first seven characters", async () => {
      reviewable("nm000201");
      gh.pulls["nm000201#7"] = { sha: SHA_A, author: "queueadmin-gh", title: "Lee2019 EEG rename" };
      const r = await cli([
        ...PR,
        "allow",
        "nm000201",
        "7",
        "--admin",
        "--commit",
        SHA_A.slice(0, 9),
        "--reason",
        "Kept until the rename",
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`Waived the naming rule for nm000201 #7 at ${SHA_A.slice(0, 7)}.`);
      // The request carried the commit, and the Worker recorded the commit it waived in full.
      const sent = apiRequests.filter((x) => x === "POST /admin/pr-reviews/nm000201/7/allow");
      expect(sent).toHaveLength(1);
      expect(JSON.parse(waivers()[0]?.details ?? "{}")).toMatchObject({ head_sha: SHA_A });
    });

    test("a pull request pushed to since is not waived: the command says so, exits 1, and nothing is recorded or posted", async () => {
      reviewable("nm000201");
      gh.pulls["nm000201#7"] = { sha: SHA_B, author: "queueadmin-gh", title: "Lee2019 EEG rename" };
      const r = await cli([
        ...PR,
        "allow",
        "nm000201",
        "7",
        "--admin",
        "--commit",
        SHA_A.slice(0, 7),
        "--reason",
        "Looked at it",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("no longer at that commit");
      expect(r.stdout + r.stderr).toContain(SHA_B.slice(0, 7));
      expect(r.stdout + r.stderr).not.toContain("--debug");
      expect(waivers()).toHaveLength(0);
      expect(checkPosts()).toHaveLength(0);
    });

    test("a head_moved sentence longer than the Worker's own is cut, whoever sent it", async () => {
      reviewable("nm000201");
      apiOverride = (req) =>
        new URL(req.url).pathname === "/admin/pr-reviews/nm000201/7/allow"
          ? Response.json(
              {
                error: `The pull request is no longer at that commit. ${"x".repeat(5000)}`,
                code: "head_moved",
              },
              { status: 409 },
            )
          : null;
      const r = await cli([
        ...PR,
        "allow",
        "nm000201",
        "7",
        "--admin",
        "--commit",
        SHA_A.slice(0, 7),
        "--reason",
        "Looked at it",
      ]);
      expect(r.exitCode).toBe(1);
      const said = (r.stdout + r.stderr)
        .split("\n")
        .find((l) => l.includes("no longer at that commit"));
      expect(said).toBeDefined();
      expect(said?.length).toBeLessThan(400);
      expect(said).toContain("…");
      expect(r.stdout + r.stderr).not.toContain("x".repeat(400));
    });

    test("is refused before the API is asked when it is not a commit prefix, or when --admin is missing", async () => {
      for (const bad of ["abc12", "not-a-sha-at-all", "a".repeat(41)]) {
        apiRequests = [];
        const r = await cli([
          ...PR,
          "allow",
          "nm000201",
          "7",
          "--admin",
          "--commit",
          bad,
          "--reason",
          "x",
        ]);
        expect(r.exitCode, bad).toBe(1);
        expect(r.stdout, bad).toContain("is not a commit id");
        // The command it offers to run instead is a whole one: --reason is required with --admin.
        expect(r.stdout, bad).toContain("--admin --commit 1a2b3c4 --reason");
        expect(
          apiRequests.filter((x) => x.includes("/admin/")),
          bad,
        ).toHaveLength(0);
      }
      apiRequests = [];
      const noAdmin = await cli([...PR, "allow", "alice", "--commit", SHA_A.slice(0, 7)]);
      expect(noAdmin.exitCode).toBe(1);
      expect(noAdmin.stdout).toContain("--commit goes with --admin");
      expect(noAdmin.stdout).toContain("--admin --commit 1a2b3c4 --reason");
      expect(apiRequests.filter((x) => x.includes("/admin/"))).toHaveLength(0);
    });
  });

  test("refuses a contributor's pull request, says why, and exits 1", async () => {
    reviewable("nm000201");
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "alice", title: "Lee2019 EEG rename" };
    const r = await cli([...PR, "allow", "nm000201", "7", "--admin", "--reason", REASON]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not waived: the author of nm000201 #7");
    expect(r.stdout).toContain("is not a NEMAR owner or administrator");
    expect(waivers()).toHaveLength(0);
  });

  test("with --json the answer is the Worker's, and a clean title has nothing to waive (exit 0)", async () => {
    reviewable("nm000201");
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "queueadmin-gh", title: "Add three recordings" };
    const r = await cli([...PR, "allow", "nm000201", "7", "--admin", "--reason", REASON, "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ waived: false, reason: "nothing_to_waive" });
  });

  test("a pull request GitHub does not have says so, and exits 1", async () => {
    reviewable("nm000201");
    const r = await cli([...PR, "allow", "nm000201", "99", "--admin", "--reason", REASON]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("GitHub has no such pull request");
    expect(r.stdout + r.stderr).not.toContain("--debug");
    expect(waivers()).toHaveLength(0);
  });

  test("a dataset name GitHub would not show is not waived: it says so in words, and exits 1", async () => {
    reviewable("nm000201");
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "queueadmin-gh", title: "Lee2019 EEG rename" };
    gh.naming.nm000201 = { files: ["dataset_description.json"], names: { [SHA_A]: 502 } };
    const r = await cli([...PR, "allow", "nm000201", "7", "--admin", "--reason", REASON]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      `Not waived: the dataset name of nm000201 #7 at ${SHA_A.slice(0, 7)} could not be read, so there is nothing definite to waive.`,
    );
    // Either GitHub did not answer or the file is unreadable: one more try, then the file.
    expect(r.stdout).toContain(
      "GitHub may not have answered, or dataset_description.json has no readable Name",
    );
    expect(r.stdout).toContain(
      "Run the same command once more; if it says the same, fix dataset_description.json and push",
    );
    expect(r.stdout).not.toContain("in a moment");
    expect(r.stdout).not.toMatch(/naming_unchecked|unchecked/);
    expect(waivers()).toHaveLength(0);
  });

  test("--admin needs a pull request, and a login takes none", async () => {
    const missing = await cli([...PR, "allow", "nm000201", "--admin"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("give a dataset and a pull request number");
    const stray = await cli([...PR, "allow", "alice", "7"]);
    expect(stray.exitCode).toBe(1);
    expect(stray.stdout).toContain("To waive the naming rule for a pull request, add --admin.");
  });

  test("the detailed help says what the override does and what it is refused for", async () => {
    const r = await cli([...PR, "allow", "--help-all"]);
    expect(r.exitCode).toBe(0);
    const help = r.stdout.replace(/\s+/g, " ");
    expect(help).toContain("allow <dataset> <pr> --admin");
    // The one-line description names the whole command, reason included.
    expect(help).toContain("(allow <dataset> <pr> --admin --reason <why>)");
    expect(help).toContain("waives the rule for the pull request's CURRENT commit");
    expect(help).toContain("records the waiver");
    // The reason it records is required, and the help says so where the option and the override are.
    expect(help).toContain("Required with --admin");
    expect(help).toContain("and your --reason, which is required");
  });

  describe("--reason", () => {
    test("is required: without one, or with a blank one, nothing is asked of the API and nothing is waived", async () => {
      reviewable("nm000201");
      gh.pulls["nm000201#7"] = { sha: SHA_A, author: "queueadmin-gh", title: "Lee2019 EEG rename" };
      for (const extra of [[], ["--reason", ""], ["--reason", "   "]]) {
        apiRequests = [];
        const r = await cli([...PR, "allow", "nm000201", "7", "--admin", ...extra]);
        expect(r.exitCode, extra.join(" ")).toBe(1);
        expect(r.stdout, extra.join(" ")).toContain("--admin needs --reason");
        expect(r.stdout, extra.join(" ")).toContain("recorded with the waiver");
        expect(apiRequests.filter((x) => x.includes("/admin/"))).toHaveLength(0);
        expect(waivers()).toHaveLength(0);
        expect(gh.seen.some((x) => x.path.endsWith("/check-runs"))).toBe(false);
      }
    });

    test("is not needed to lift a block, which has no waiver to record it with", async () => {
      gh.users.alice = { id: 77, login: "alice", type: "User" };
      expect((await cli([...PR, "block", "alice"])).exitCode).toBe(0);
      const r = await cli([...PR, "allow", "alice"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Allowed alice");
    });
  });
});

describe("nemar admin pr-reviews show", () => {
  test("prints the stored report in the words of the pull-request comment", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Passes: nothing lost, revision advances, materially better");
    expect(r.stdout).toContain("Adds two subjects and corrects the task description.");
    expect(r.stdout).toContain("| Dataset description | 0 | 1 | 0 |");
    expect(r.stdout).toContain("| Recordings and data files | 2 | 0 | 0 |");
    expect(r.stdout).toContain("Version 1.0.0 to 1.1.0.");
    expect(r.stdout).toContain("Changed files (1 of 3)");
    expect(r.stdout).toContain("changed `dataset_description.json`");
    expect(r.stdout).toContain("Reviewed with claude-haiku-5-5.");
    // HTML wrappers are for GitHub, not for a terminal.
    expect(r.stdout).not.toMatch(/<\/?(details|summary)>/);
    // The report keeps its layout: a table is one row per line, not one run-on line.
    expect(r.stdout).toMatch(/^\| Area \| Added \| Changed \| Removed \|$/m);
    expect(r.stdout).toMatch(/^\| --- \| ---: \| ---: \| ---: \|$/m);
    expect(r.stdout).toMatch(/^\| Dataset description \| 0 \| 1 \| 0 \|$/m);
    expect(r.stdout).toMatch(/^- changed `dataset_description.json`$/m);
    expect(r.stdout).toMatch(/^Changed files \(1 of 3\)$/m);
    // The author's record rides along.
    expect(r.stdout).toContain("0 of 1 decided pull request rejected (0.0%)");
  });

  test("says plainly that an owner's or administrator's pull request is not reviewed, and is not a pass", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "queueadmin-gh", authorId: 4001 };
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Review:    exempt (owner or admin)");
    expect(r.stdout).toContain("no automated review is required");
    expect(r.stdout).toContain("is posted as skipped, which is not a pass");
    expect(r.stdout).toContain("this view does not verify that it was");
    expect(r.stdout).not.toContain("not reviewed");
    expect(r.stdout).not.toContain("No automated review has been recorded");
    // The author's record is not shown beside it: an exempt pull request is not held to it, and
    // "not paused: reviewed automatically" would be the opposite of what happens.
    expect(r.stdout).not.toContain("Standing:");
    expect(r.stdout).not.toContain("decided pull request");
  });

  test("an earlier commit's review is named as that commit's, not shown as this one's report", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_B, author: "queueadmin-gh", authorId: 4001 };
    seed({
      ds: "nm000201",
      n: 7,
      sha: SHA_A,
      authorId: 4001,
      login: "queueadmin-gh",
      state: "reported",
      verdict: "fail",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.stdout).toContain("Review:    exempt (owner or admin)");
    expect(r.stdout).toContain("An earlier commit (aaaaaaa) was reviewed and read fail");
    expect(r.stdout).toContain("this commit was not reviewed");
    // The old report is not printed as if it were about this commit.
    expect(r.stdout).not.toContain("Needs changes");
    expect(r.stdout).not.toContain("a DIFFERENT commit");
  });

  test("says plainly when the review read an earlier commit", async () => {
    livePull(SHA_B);
    seed({
      ds: "nm000201",
      n: 7,
      sha: SHA_A,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.stdout).toContain("not reviewed (other commit)");
    expect(r.stdout).toContain("a DIFFERENT commit");
    expect(r.stdout).toContain("it does not apply to the current commit");
  });

  test("a failing review lists its findings", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "fail",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.stdout).toContain("Needs changes");
    expect(r.stdout).toContain("Findings");
  });

  test("a pull request with no review is not reviewed, with the reason it can give", async () => {
    livePull();
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("not reviewed");
    expect(r.stdout).toContain("No automated review has been recorded");

    envOverrides = { PR_REVIEW_ENABLED: undefined };
    const off = await cli([...PR, "show", "nm000201", "7"]);
    expect(off.stdout).toContain("The automated review is off in this environment");
  });

  test("a declined review shows the reason in the comment's words", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "declined",
      detail: "contributor_paused",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.stdout).toContain("Not reviewed");
    expect(r.stdout).toContain(
      "Automated review was paused for this contributor when this commit arrived",
    );
  });

  test("--json is the raw detail", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    const r = await cli([...PR, "show", "nm000201", "7", "--json"]);
    const d = JSON.parse(r.stdout) as PrReviewDetail;
    expect(d).toMatchObject({
      dataset_id: "nm000201",
      pr_number: 7,
      verdict: "pass",
      review_current: true,
    });
  });

  test("refuses ids that are not a dataset and a number, and reports a pull request that does not exist", async () => {
    expect((await cli([...PR, "show", "nm1", "7"])).exitCode).toBe(1);
    expect((await cli([...PR, "show", "nm000201", "seven"])).exitCode).toBe(1);
    const missing = await cli([...PR, "show", "nm000201", "99"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout + missing.stderr).toContain("has no pull request #99");
  });
});

// ---------------------------------------------------------------------------------------------
// allow / block / clear / standing
// ---------------------------------------------------------------------------------------------

describe("who is reviewed", () => {
  function seedRecord(rejected: number, passed: number) {
    let n = 100;
    for (let i = 0; i < rejected; i++) {
      seed({
        ds: "nm000301",
        n: n++,
        authorId: 77,
        login: "alice",
        state: "reported",
        verdict: "fail",
      });
    }
    for (let i = 0; i < passed; i++) {
      seed({
        ds: "nm000301",
        n: n++,
        authorId: 77,
        login: "alice",
        state: "reported",
        verdict: "pass",
      });
    }
  }

  test("standing shows the record as information, and says nothing pauses on it", async () => {
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    seedRecord(6, 4);
    const r = await cli([...PR, "standing", "alice"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("6 of 10 decided pull requests rejected (60.0%)");
    expect(r.stdout).toContain("does not pause anyone's reviews, only a block does");
    expect(r.stdout).toContain("not paused: reviewed automatically");
    expect(r.stdout).toContain("Decision:  none");
    // The rule that used to pause on this record is not described any more.
    expect(r.stdout).not.toContain("MORE than");
    expect(r.stdout).not.toContain("paused by the record");
  });

  test("allow lifts a block and says so, and clear removes the decision", async () => {
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    seedRecord(6, 4);
    expect((await cli([...PR, "block", "alice"])).exitCode).toBe(0);
    const allow = await cli([...PR, "allow", "alice", "--reason", "Vetted by hand"]);
    expect(allow.exitCode).toBe(0);
    expect(allow.stdout).toContain("Allowed alice");
    expect(allow.stdout).toContain("reviewed automatically");
    expect(allow.stdout).toContain("by queueadmin");
    expect(allow.stdout).toContain("Vetted by hand");
    // What happens to a pull request that is already open, now that an edit, a reopening and a
    // marking as ready review it as a push does, and an administrator's start does too.
    expect(allow.stdout).toContain("pushed to, edited, reopened or marked ready for review");
    expect(allow.stdout).toContain("an administrator starts its review");
    expect(allow.stdout).not.toContain("until their next push");
    expect(db.query("SELECT mode, set_by FROM pr_review_overrides").get()).toMatchObject({
      mode: "allow",
    });

    const clear = await cli([...PR, "clear", "alice"]);
    expect(clear.stdout).toContain("Removed the allow for alice");
    expect(clear.stdout).toContain("reviewed automatically");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });

    const again = await cli([...PR, "clear", "alice"]);
    expect(again.stdout).toContain("had no allow or block");
  });

  test("block pauses a contributor, and says an administrator did", async () => {
    gh.users.dave = { id: 88, login: "dave", type: "User" };
    const r = await cli([...PR, "block", "@dave", "--reason", "Spam"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Blocked dave");
    expect(r.stdout).toContain("paused by an administrator's block");
    // "Not re-reviewed" means nothing for a contributor who is not reviewed at all.
    expect(r.stdout).not.toContain("re-reviewed");
    expect(db.query("SELECT mode, author_id FROM pr_review_overrides").get()).toEqual({
      mode: "block",
      author_id: 88,
    });
  });

  test("a reason longer than the Worker keeps is refused, not cut without a word", async () => {
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    const r = await cli([...PR, "allow", "alice", "--reason", "x".repeat(201)]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("200 is the most that is kept");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });

  test("block refuses a reason longer than the Worker keeps, before anything is asked of the API, and takes exactly that many", async () => {
    gh.users.dave = { id: 88, login: "dave", type: "User" };
    apiRequests = [];
    const tooLong = await cli([...PR, "block", "dave", "--reason", "x".repeat(201)]);
    expect(tooLong.exitCode).toBe(1);
    expect(tooLong.stdout).toContain("The reason is 201 characters; 200 is the most that is kept.");
    expect(apiRequests.filter((x) => x.includes("/admin/"))).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });

    const exact = await cli([...PR, "block", "dave", "--reason", "x".repeat(200)]);
    expect(exact.exitCode).toBe(0);
    expect(db.query("SELECT mode, reason FROM pr_review_overrides").get()).toEqual({
      mode: "block",
      reason: "x".repeat(200),
    });
  });

  test("allow --admin refuses a reason longer than the Worker keeps, and waives nothing", async () => {
    // (The same check as above, on the other command that records a reason; it runs before the
    // pull request is looked at, so nothing needs to be set up on GitHub.)
    apiRequests = [];
    const r = await cli([...PR, "allow", "nm000201", "7", "--admin", "--reason", "y".repeat(201)]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("The reason is 201 characters; 200 is the most that is kept.");
    expect(apiRequests.filter((x) => x.includes("/admin/"))).toHaveLength(0);
  });

  test("a login GitHub does not know, and a malformed one, are refused", async () => {
    const unknown = await cli([...PR, "block", "nobody"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout + unknown.stderr).toContain("GitHub has no user called nobody");
    expect((await cli([...PR, "allow", "-bad-"])).exitCode).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });

  test("--json on each is the raw response", async () => {
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    const set = JSON.parse((await cli([...PR, "block", "alice", "--json"])).stdout);
    expect(set).toMatchObject({
      previous: null,
      standing: { author_id: 77, standing: { paused: true } },
    });
    const st = JSON.parse((await cli([...PR, "standing", "alice", "--json"])).stdout);
    expect(st.override.mode).toBe("block");
    const cleared = JSON.parse((await cli([...PR, "clear", "alice", "--json"])).stdout);
    expect(cleared.removed).toBe("block");
  });

  test("on the non-production Worker it says it changes nothing in production", async () => {
    envOverrides = { ENVIRONMENT: "staging" };
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    const r = await cli([...PR, "allow", "alice"]);
    expect(r.stdout).toContain("non-production Worker");
    expect(r.stdout).toContain("does not change what production reviews");
  });
});

// ---------------------------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------------------------

describe("nemar admin pr-reviews approve", () => {
  function reviewed(verdict: "pass" | "fail" | "uncertain" = "pass", sha = SHA_A) {
    livePull(SHA_A);
    seed({ ds: "nm000201", n: 7, sha, authorId: 42, login: "alice", state: "reported", verdict });
  }
  const approve = (extra: string[] = [], opts: Parameters<typeof cli>[1] = {}) =>
    cli([...PR, "approve", "nm000201", "7", "--yes", ...extra], opts);

  test("approves as the administrator's own login, on the commit shown, and does not merge", async () => {
    reviewed("pass");
    const r = await approve();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Approve nm000201 #7");
    expect(r.stdout).toContain("Commit:   aaaaaaa");
    expect(r.stdout).toContain("You are:  @queueadmin-gh (linked to your NEMAR account)");
    expect(r.stdout).toContain("Approved nm000201 #7 at aaaaaaa as @queueadmin-gh.");
    expect(r.stdout).toContain("It is not merged.");

    expect(reviewPosts()).toHaveLength(1);
    expect(reviewPosts()[0].token).toBe(ADMIN_TOKEN);
    expect(reviewPosts()[0].body).toMatchObject({ commit_id: SHA_A, event: "APPROVE" });
    expect(mergePuts()).toHaveLength(0);
    // The NEMAR Worker's own token wrote nothing to the pull request.
    expect(
      gh.seen.filter(
        (s) => s.token === WORKER_TOKEN && s.method !== "GET" && s.path !== "/graphql",
      ),
    ).toHaveLength(0);
  });

  test("uses the administrator's message when given one", async () => {
    reviewed("pass");
    await approve(["--message", "Checked the participants table by hand."]);
    expect((reviewPosts()[0].body as { body: string }).body).toBe(
      "Checked the participants table by hand.",
    );
  });

  test("without --yes and without a terminal, nothing is approved", async () => {
    reviewed("pass");
    const r = await cli([...PR, "approve", "nm000201", "7"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("use --yes or --no");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("an owner's or administrator's pull request asks first and says the review did not run", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "queueadmin-gh", authorId: 4001 };
    const r = await cli([...PR, "approve", "nm000201", "7", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Review:   exempt (owner or admin)");
    expect(r.stdout).toContain("The automated review did not run");
    expect(r.stdout).toContain("Dry run: nothing was approved or merged.");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("--dry-run does every check and approves nothing", async () => {
    reviewed("pass");
    const r = await cli([...PR, "approve", "nm000201", "7", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Dry run: nothing was approved or merged.");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("--dry-run with --merge and --force sends nothing at all to GitHub but reads", async () => {
    reviewed("fail");
    const r = await cli([
      ...PR,
      "approve",
      "nm000201",
      "7",
      "--dry-run",
      "--merge",
      "--force",
      "--yes",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Then:     merge (merge) if GitHub reports it clean");
    expect(r.stdout).toContain("Dry run: nothing was approved or merged.");
    expect(gh.seen.filter((s) => s.token === ADMIN_TOKEN && s.method !== "GET")).toHaveLength(0);
  });

  test("the default text of the approval claims only what is known", async () => {
    reviewed("pass");
    await approve();
    expect((reviewPosts()[0].body as { body: string }).body).toBe(
      "Approved with nemar admin pr-reviews approve. Automated review of this commit: pass.",
    );
  });

  test("an approval GitHub records on a different commit than asked is not reported as done, and nothing is merged", async () => {
    reviewed("pass");
    gh.reviewCommit = SHA_B;
    const r = await approve(["--merge"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("not the approval that was asked for");
    expect(mergePuts()).toHaveLength(0);
  });

  test("an app token is not accepted as a person, and the way to do it by hand is printed", async () => {
    reviewed("pass");
    const r = await approve([], { env: { GH_TOKEN: APP_TOKEN } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("app or workflow token cannot approve for you");
    expect(r.stdout).toContain("https://github.com/nemarDatasets/nm000201/pull/7");
    expect(r.stdout).toContain("gh pr review 7 --repo nemarDatasets/nm000201 --approve");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("another person's token than the login linked to the NEMAR account is refused, and says where the token came from", async () => {
    reviewed("pass");
    const r = await approve([], { env: { GH_TOKEN: OTHER_TOKEN } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      "GH_TOKEN belongs to @someone-else, but your NEMAR account is linked to @queueadmin-gh",
    );
    expect(r.stdout).toContain("Unset GH_TOKEN");
    expect(r.stdout).not.toContain("gh auth switch"); // that would not help: the environment wins
    expect(reviewPosts()).toHaveLength(0);
  });

  test("an account that names no GitHub login is shown the login being used, and cannot be checked", async () => {
    reviewed("pass");
    db.run("UPDATE users SET github_username = NULL");
    const r = await approve();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "your NEMAR account names no GitHub login, so this cannot be checked",
    );
    expect(reviewPosts()).toHaveLength(1);
  });

  test("with no token at all, it opens nothing and says how to do it as yourself", async () => {
    reviewed("pass");
    const r = await approve([], { env: { GH_TOKEN: undefined, PATH: emptyPath } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Cannot approve from here: The GitHub CLI (gh) is not installed.");
    expect(r.stdout).toContain("https://github.com/nemarDatasets/nm000201/pull/7");
    expect(r.stdout).toContain("gh pr review 7 --repo nemarDatasets/nm000201 --approve");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("a failing review needs --force, and says to read it first", async () => {
    reviewed("fail");
    const refused = await approve();
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("The automated review says this pull request needs changes");
    expect(refused.stdout).toContain("--force");
    expect(reviewPosts()).toHaveLength(0);

    const forced = await approve(["--force"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Approving anyway (--force).");
    expect(reviewPosts()).toHaveLength(1);
  });

  test("a review still running needs --force too", async () => {
    livePull();
    seed({ ds: "nm000201", n: 7, authorId: 42, login: "alice", state: "dispatched" });
    const refused = await approve();
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("still running");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("an uncertain review, a missing one and a stale one each say so before they are approved", async () => {
    reviewed("uncertain");
    const uncertain = await approve();
    expect(uncertain.exitCode).toBe(0);
    expect(uncertain.stdout).toContain("could not decide whether this is a good change");

    gh.reset();
    db.run("DELETE FROM pr_reviews");
    livePull();
    const missing = await approve();
    expect(missing.stdout).toContain("has not read this commit");

    gh.reset();
    db.run("DELETE FROM pr_reviews");
    reviewed("pass", SHA_B); // reviewed an earlier commit; the pull request is now at SHA_A
    const stale = await approve();
    expect(stale.exitCode).toBe(0);
    expect(stale.stdout).toContain("read a different commit of this pull request (it said: pass)");
    expect(stale.stdout).toContain("not reviewed (other commit)");
    // The approval is on the commit the administrator was shown, not the one that was reviewed.
    expect(reviewPosts().pop()?.body).toMatchObject({ commit_id: SHA_A });
  });

  test("a Worker that cannot see the review leaves its verdict UNKNOWN, which needs --force and is never read as 'not reviewed'", async () => {
    reviewed("pass");
    envOverrides = { ENVIRONMENT: "staging" }; // the non-production Worker holds no production review
    const refused = await approve();
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("The automated review could not be read");
    expect(refused.stdout).toContain("belongs to the production Worker");
    expect(refused.stdout).toContain("--force");
    expect(reviewPosts()).toHaveLength(0);

    const forced = await approve(["--force"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("unknown (nm000201 belongs to the production Worker");
    expect(forced.stdout).not.toContain("has not read this commit");
    expect((reviewPosts()[0].body as { body: string }).body).toBe(
      "Approved with nemar admin pr-reviews approve. Automated review of this commit: unknown.",
    );
  });

  test("a stored rejection cannot be hidden behind a failed read of it", async () => {
    // The Worker holds a `fail` for this commit. Each way of not hearing it must stop the approval.
    reviewed("fail");

    // The Worker fails reading its own reviews (a 500), while authentication still works.
    db.run("ALTER TABLE pr_reviews RENAME TO pr_reviews_gone");
    const down = await approve();
    expect(down.exitCode).toBe(1);
    expect(reviewPosts()).toHaveLength(0);
    // --force is for a verdict that is unknown, not for an error that is not one of the two
    // answers meaning "the Worker cannot say".
    const forcedDown = await approve(["--force"]);
    expect(forcedDown.exitCode).toBe(1);
    expect(reviewPosts()).toHaveLength(0);
    db.run("ALTER TABLE pr_reviews_gone RENAME TO pr_reviews");

    // The account is not an administrator (a 403), however the key got there.
    db.run("UPDATE users SET role = 'member', status = 'verified'");
    const member = await approve();
    expect(member.exitCode).toBe(1);
    expect(member.stdout).toContain("requires admin privileges");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("an answer that is not the Worker's own cannot stand in for 'there is no review'", async () => {
    // A stored rejection exists, and what comes back is a 404 with no error word (a backend older
    // than this CLI, which lacks the route) or a bare 502 from an edge in front of the Worker.
    reviewed("fail");
    for (const answer of [
      new Response('{"error":"Not found"}', { status: 404 }),
      new Response("Bad gateway", { status: 502 }),
    ]) {
      apiOverride = (req) =>
        new URL(req.url).pathname.startsWith("/admin/pr-reviews") ? answer.clone() : null;
      const r = await approve(["--force"]);
      expect(r.exitCode).toBe(1);
      expect(reviewPosts()).toHaveLength(0);
    }
  });

  test("the review is asked about the commit that was read, not whatever the head is a moment later", async () => {
    // The Worker holds a rejection of A. A push lands after the CLI read A and before the Worker
    // reads the head; asked about the head it would find B, which nobody reviewed, and show A's
    // rejection as another commit's.
    livePull(SHA_A);
    gh.pulls["nm000201#7"].headAfterFirstRead = SHA_B;
    seed({
      ds: "nm000201",
      n: 7,
      sha: SHA_A,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "fail",
    });
    const r = await approve();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("The automated review says this pull request needs changes");
    expect(reviewPosts()).toHaveLength(0);
    expect(apiRequests.some((x) => x.includes(`?head=${SHA_A}`))).toBe(true);
  });

  test("GitHub unreadable by the Worker, with no stored review, is unknown too", async () => {
    livePull();
    envOverrides = { GITHUB_ADMIN_PAT: undefined }; // the Worker cannot ask GitHub, and holds no row
    const r = await approve();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("The automated review could not be read");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("an account that cannot be read is not an account that names no GitHub login", async () => {
    reviewed("pass");
    apiOverride = (req) =>
      new URL(req.url).pathname === "/users/me"
        ? Response.json({ error: "Database unavailable" }, { status: 500 })
        : null;
    // GH_TOKEN is someone else's: if the failure read as "unlinked" it would be used.
    const r = await approve(["--force"], { env: { GH_TOKEN: OTHER_TOKEN } });
    expect(r.exitCode).toBe(1);
    expect(reviewPosts()).toHaveLength(0);
    expect(gh.seen.filter((s) => s.method !== "GET" && s.token !== WORKER_TOKEN)).toHaveLength(0);
  });

  test("a closed, merged, draft or non-main pull request is refused", async () => {
    for (const [over, words] of [
      [{ state: "closed" as const }, "closed"],
      [{ merged: true, state: "closed" as const }, "already merged"],
      [{ draft: true }, "draft"],
      [{ base: "dev" }, "not main"],
    ] as const) {
      gh.reset();
      livePull(SHA_A, over);
      const r = await approve();
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain(words);
      expect(reviewPosts()).toHaveLength(0);
    }
  });

  test("GitHub refusing the approval is reported and nothing is merged", async () => {
    reviewed("pass");
    gh.reviewStatus = 422;
    const r = await approve(["--merge"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not approved: Can not approve your own pull request");
    expect(mergePuts()).toHaveLength(0);
  });

  test("an approval GitHub answers with a gateway error, or whose answer cannot be read, is unknown and not repeated", async () => {
    reviewed("pass");
    gh.reviewStatus = 502;
    const gateway = await approve();
    expect(gateway.exitCode).toBe(1);
    expect(gateway.stdout).toContain("Outcome unknown: GitHub may have recorded the approval");
    expect(gateway.stdout).not.toContain("Not approved");

    gh.reset();
    db.run("DELETE FROM pr_reviews");
    reviewed("pass");
    gh.unreadableAnswers = true; // the approval is recorded; only the answer is unreadable
    const unreadable = await approve(["--merge"]);
    expect(unreadable.exitCode).toBe(1);
    expect(unreadable.stdout).toContain("Outcome unknown: GitHub may have recorded the approval");
    expect(unreadable.stdout).not.toContain("Not approved");
    expect(reviewPosts()).toHaveLength(1);
    expect(mergePuts()).toHaveLength(0);
  });

  test("a review that is not the approval asked for is reported as that, with the pull request to check", async () => {
    reviewed("pass");
    gh.reviewState = "COMMENTED";
    const r = await approve();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      "GitHub recorded a review, but not the approval that was asked for (state COMMENTED)",
    );
    expect(r.stdout).toContain("Check https://github.com/nemarDatasets/nm000201/pull/7");
    expect(r.stdout).not.toContain("Outcome unknown");
  });

  test("an answer the CLI cannot read as THIS commit's review is unknown: --yes does not skip it, --force does", async () => {
    reviewed("pass");
    const answers: Array<[string, Record<string, unknown>]> = [
      ["a verdict word this CLI does not know", { verdict: "brilliant", head_sha: SHA_A }],
      ["no verdict", { head_sha: SHA_A }],
      ["a review of another commit", { verdict: "pass", head_sha: SHA_B }],
    ];
    for (const [label, body] of answers) {
      apiOverride = (req) =>
        new URL(req.url).pathname.startsWith("/admin/pr-reviews") ? Response.json(body) : null;
      const refused = await approve();
      expect(refused.exitCode, label).toBe(1);
      expect(refused.stdout, label).toContain("The automated review could not be read");
      expect(refused.stdout, label).not.toContain("ended without a verdict");
      expect(reviewPosts(), label).toHaveLength(0);
    }
    const forced = await approve(["--force"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("unknown (");
    expect(reviewPosts()).toHaveLength(1);
  });

  test("a Worker that cannot find the pull request the administrator just read leaves the verdict unknown", async () => {
    livePull();
    apiOverride = (req) =>
      new URL(req.url).pathname.startsWith("/admin/pr-reviews")
        ? Response.json(
            { error: "nm000201 has no pull request #7.", code: "no_such_pull_request" },
            { status: 404 },
          )
        : null;
    const refused = await approve();
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("could not find this pull request on GitHub");
    expect(refused.stdout).toContain("--force");
    expect(reviewPosts()).toHaveLength(0);
    expect((await approve(["--force"])).exitCode).toBe(0);
  });

  test("a contributor who was not reviewed says why, because that is what the approver most needs", async () => {
    livePull(SHA_A);
    seed({
      ds: "nm000201",
      n: 7,
      sha: SHA_A,
      authorId: 42,
      login: "alice",
      state: "declined",
      detail: "contributor_paused",
    });
    db.run(
      "INSERT INTO pr_review_overrides (author_id, author_login, mode, reason) VALUES (42, 'alice', 'block', 'spam')",
    );
    const r = await approve();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("not reviewed (contributor paused)");
    expect(r.stdout).toContain("not reviewed automatically (paused by an administrator's block)");
  });

  describe("merging", () => {
    test("a merge answered by a gateway error says its outcome is unknown, and a refusal does not", async () => {
      reviewed("pass");
      gh.mergeStatus = 502;
      const unknown = await approve(["--merge"]);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stdout).toContain("Approved nm000201 #7");
      expect(unknown.stdout).toContain("Outcome unknown: GitHub may have merged it");

      gh.reset();
      db.run("DELETE FROM pr_reviews");
      reviewed("pass");
      gh.mergeStatus = 405;
      const refused = await approve(["--merge"]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).not.toContain("Outcome unknown");
    });

    /** A pull request the automated review holds: `uncertain` leaves its check at action_required, which GitHub reports as unstable. */
    function held(verdict: "uncertain" | "fail" = "uncertain") {
      reviewed(verdict);
      gh.pulls["nm000201#7"].mergeableState = "unstable";
    }

    test("--merge on a pull request the review holds (unstable) writes nothing, and says which state and why", async () => {
      held();
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GitHub reports this pull request as 'unstable'");
      expect(r.stdout).toContain(
        "a check or status that is not required is not passing or has not reported",
      );
      expect(r.stdout).toContain("so a merge would not be attempted");
      expect(r.stdout).toContain("Nothing was approved or merged.");
      // Refused by the early check, before the card is shown, not by the look right before the write.
      expect(r.stdout).not.toContain("Checked again just before approving");
      expect(r.stdout).not.toContain("Approve nm000201 #7");
      // The way to approve without merging is named.
      expect(r.stdout).toContain("without --merge");
      // The assertions that matter: no approval was recorded and no merge was asked for.
      expect(r.stdout).not.toContain("Approved nm000201");
      expect(reviewPosts()).toHaveLength(0);
      expect(mergePuts()).toHaveLength(0);
      expect(adminWrites()).toHaveLength(0);
    });

    test("it refuses before asking for confirmation, so the question is not put for something that cannot be done", async () => {
      held();
      // Without --yes the confirmation is asked for, and with no terminal it answers "Not
      // approved." (see confirm). The refusal about the merge comes first, so it is what is said.
      const r = await cli([...PR, "approve", "nm000201", "7", "--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Nothing was approved or merged.");
      expect(r.stdout).not.toContain("Not approved.");
      expect(adminWrites()).toHaveLength(0);
    });

    test("--dry-run --merge reports the same refusal, because it is what the real run would do", async () => {
      held();
      const r = await approve(["--merge", "--dry-run"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GitHub reports this pull request as 'unstable'");
      expect(r.stdout).not.toContain("Dry run: nothing was approved or merged.");
      expect(adminWrites()).toHaveLength(0);
    });

    test("approve alone on a pull request the review holds still approves, and says --merge would not be tried", async () => {
      held();
      const r = await approve();
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Approved nm000201 #7");
      expect(r.stdout).toContain("It is not merged.");
      expect(r.stdout).toContain("GitHub reports this pull request as 'unstable'");
      expect(r.stdout).toContain("so a merge would not be attempted");
      expect(r.stdout).not.toContain("Run approve again with --merge");
      expect(reviewPosts()).toHaveLength(1);
      expect(reviewPosts()[0].token).toBe(ADMIN_TOKEN);
      expect(mergePuts()).toHaveLength(0);
    });

    test("approve alone while GitHub has not said still offers --merge again, because that state may clear", async () => {
      reviewed("pass");
      gh.pulls["nm000201#7"].unknownReads = 99;
      const r = await approve();
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Approved nm000201 #7");
      expect(r.stdout).toContain("Run approve again with --merge");
      expect(r.stdout).not.toContain("a merge would not be attempted");
    });

    test("approve alone on a held pull request whose review FAILED still needs --force, and with it approves", async () => {
      held("fail");
      const refused = await approve();
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toContain("--force");
      expect(reviewPosts()).toHaveLength(0);

      const forced = await approve(["--force"]);
      expect(forced.exitCode).toBe(0);
      expect(forced.stdout).toContain("Approved nm000201 #7");
      expect(reviewPosts()).toHaveLength(1);
      expect(mergePuts()).toHaveLength(0);
    });

    test("--merge --force on a held pull request whose review FAILED still refuses: --force is about the verdict, not the state", async () => {
      held("fail");
      const r = await approve(["--merge", "--force"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GitHub reports this pull request as 'unstable'");
      expect(r.stdout).toContain("Nothing was approved or merged.");
      // The EARLY check refused it, before the card was shown: not the late one, which would also
      // have written nothing but only after "Approve nm000201 #7" and the confirmation.
      expect(r.stdout).not.toContain("Checked again just before approving");
      expect(r.stdout).not.toContain("Approve nm000201 #7");
      expect(adminWrites()).toHaveLength(0);
    });

    test("an answer that carries no mergeable_state is not clean: it reads as unknown, and nothing is written", async () => {
      reviewed("pass");
      gh.pulls["nm000201#7"].omitMergeableState = true;
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GitHub reports this pull request as 'unknown'");
      expect(r.stdout).toContain("Nothing was approved or merged.");
      expect(adminWrites()).toHaveLength(0);
    });

    test("every state but clean refuses --merge before anything is written, whatever the verdict", async () => {
      // `has_hooks` is a GitHub Enterprise Server value and the last is one nobody has heard of:
      // neither is clean. `draft` is GitHub's own word for a pull request still marked as one.
      for (const state of ["blocked", "behind", "dirty", "draft", "has_hooks", "brand_new_state"]) {
        gh.reset();
        db.run("DELETE FROM pr_reviews");
        reviewed("pass");
        gh.pulls["nm000201#7"].mergeableState = state;
        const r = await approve(["--merge"]);
        expect(r.exitCode, state).toBe(1);
        expect(r.stdout, state).toContain(`GitHub reports this pull request as '${state}'`);
        expect(r.stdout, state).toContain("Nothing was approved or merged.");
        expect(adminWrites(), state).toHaveLength(0);
      }
    });

    test("a state GitHub never settles is treated as not clean, never as clean", async () => {
      reviewed("pass");
      gh.pulls["nm000201#7"].unknownReads = 99;
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GitHub reports this pull request as 'unknown'");
      expect(r.stdout).toContain("Nothing was approved or merged.");
      // A state that may clear by itself is not met with "approve without --merge".
      expect(r.stdout).toContain("again in a moment");
      expect(r.stdout).not.toContain("without --merge");
      expect(adminWrites()).toHaveLength(0);
    });

    test("when asking again fails, or finds the branch moved, nothing is written and the reason is said", async () => {
      // The first read says unknown, so the state is asked about again; that second read is the
      // one that cannot be trusted to say clean.
      for (const [later, said, advice] of [
        // A failed read may clear: wait a moment and run it again.
        [{ status: 502 }, "Could not check whether it can be merged", "again in a moment"],
        // A moved head will not clear by waiting: a fresh run reads the new commit.
        [
          { sha: SHA_B },
          "The pull request changed since it was read.",
          "again to read it as it is now",
        ],
      ] as const) {
        gh.reset();
        db.run("DELETE FROM pr_reviews");
        reviewed("pass");
        Object.assign(gh.pulls["nm000201#7"], { unknownReads: 1, adminReadsAfterFirst: later });
        const r = await approve(["--merge"]);
        expect(r.exitCode, said).toBe(1);
        expect(r.stdout, said).toContain(said);
        expect(r.stdout, said).toContain(advice);
        expect(r.stdout, said).not.toContain("without --merge");
        expect(r.stdout, said).not.toContain("Approved nm000201");
        expect(adminWrites(), said).toHaveLength(0);
      }
    });

    test("a pull request closed or merged while it was being checked is refused, with nothing to retry", async () => {
      for (const [later, word] of [
        [{ state: "closed" }, "closed"],
        [{ state: "closed", merged: true }, "merged"],
      ] as const) {
        gh.reset();
        db.run("DELETE FROM pr_reviews");
        reviewed("pass");
        Object.assign(gh.pulls["nm000201#7"], { unknownReads: 1, adminReadsAfterFirst: later });
        const r = await approve(["--merge"]);
        expect(r.exitCode, word).toBe(1);
        expect(r.stdout, word).toContain(`The pull request is no longer open (it was ${word}).`);
        expect(r.stdout, word).toContain("Nothing was approved or merged.");
        expect(r.stdout, word).not.toContain("in a moment");
        expect(r.stdout, word).not.toContain("without --merge");
        expect(adminWrites(), word).toHaveLength(0);
      }
    });

    test("a state GitHub is still working out is asked about again, and a clean answer then merges", async () => {
      reviewed("pass");
      gh.pulls["nm000201#7"].unknownReads = 2;
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Approved nm000201 #7");
      expect(r.stdout).toContain("Merged nm000201 #7 (merge).");
      expect(reviewPosts()).toHaveLength(1);
      expect(mergePuts()).toHaveLength(1);
    });

    /** The administrator's own reads of the pull request: the first is the card, the rest are looks at the state. */
    const adminPullReads = () =>
      gh.seen.filter(
        (s) => s.method === "GET" && s.path.endsWith("/pulls/7") && s.token === ADMIN_TOKEN,
      );

    test("the state is read again right before the approval: one that stopped being clean after the first look writes nothing", async () => {
      // Clean when the pull request was read and checked, unstable by the time the approval would
      // be written (a check started, or the review reported). The early check alone would pass.
      reviewed("pass");
      gh.pulls["nm000201#7"].adminReadsAfterFirst = { mergeableState: "unstable" };
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Checked again just before approving:");
      expect(r.stdout).toContain("GitHub reports this pull request as 'unstable'");
      expect(r.stdout).toContain("Nothing was approved or merged.");
      expect(r.stdout).not.toContain("Approved nm000201");
      expect(adminWrites()).toHaveLength(0);
    });

    test("the late look refuses a read that fails, a branch that moved and a pull request that closed, too", async () => {
      for (const [later, said] of [
        [{ status: 502 }, "Could not check whether it can be merged"],
        [{ sha: SHA_B }, "The pull request changed since it was read."],
        [{ state: "closed" }, "The pull request is no longer open (it was closed)."],
      ] as const) {
        gh.reset();
        db.run("DELETE FROM pr_reviews");
        reviewed("pass");
        gh.pulls["nm000201#7"].adminReadsAfterFirst = later;
        const r = await approve(["--merge"]);
        expect(r.exitCode, said).toBe(1);
        expect(r.stdout, said).toContain(`Checked again just before approving: ${said}`);
        expect(adminWrites(), said).toHaveLength(0);
      }
    });

    test("the late look costs one more read when the state is clean, and nothing for an approval alone", async () => {
      reviewed("pass");
      const merged = await approve(["--merge"]);
      expect(merged.exitCode).toBe(0);
      // The first read, the look right before the approval, and the look right before the merge.
      expect(adminPullReads()).toHaveLength(3);

      gh.reset();
      db.run("DELETE FROM pr_reviews");
      reviewed("pass");
      const alone = await approve();
      expect(alone.exitCode).toBe(0);
      expect(adminPullReads()).toHaveLength(1);
    });

    test("the late look comes after the confirmation: when it is not given there is no second read", async () => {
      reviewed("pass");
      // No --yes and no terminal, so the confirmation is not given. A look taken before it would
      // reopen the whole interactive window the look exists to close.
      const r = await cli([...PR, "approve", "nm000201", "7", "--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Not approved.");
      expect(adminPullReads()).toHaveLength(1); // the first read only
      expect(adminWrites()).toHaveLength(0);
    });

    test("a clean pull request is approved first and merged second, both with the administrator's token", async () => {
      // The other direction of the precheck: it must not refuse what it should let through.
      reviewed("pass");
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Merged nm000201 #7 (merge).");
      expect(adminWrites().map((w) => `${w.method} ${w.path.split("/").pop()}`)).toEqual([
        "POST reviews",
        "PUT merge",
      ]);
      expect(adminWrites().every((w) => w.token === ADMIN_TOKEN)).toBe(true);
    });

    test("happens only with --merge, only on the approved commit, and with the chosen method", async () => {
      reviewed("pass");
      const r = await approve(["--merge", "--method", "squash"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Merged nm000201 #7 (squash).");
      expect(mergePuts()).toHaveLength(1);
      expect(mergePuts()[0].token).toBe(ADMIN_TOKEN);
      expect(mergePuts()[0].body).toEqual({ sha: SHA_A, merge_method: "squash" });
    });

    test("is never done around the ruleset: a pull request that stops being clean after the approval stays approved and unmerged", async () => {
      // The precheck passed (clean when read), then a check turned pending: the second look,
      // right before the merge, is the one that holds.
      reviewed("pass");
      gh.pulls["nm000201#7"].mergeableStateAfterReview = "blocked";
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Approved nm000201 #7");
      expect(r.stdout).toContain("a required check or review is not satisfied");
      expect(r.stdout).toContain(
        "this tool names the NEMAR PR Review check, and no other, as one an owner or administrator can override in the GitHub UI, and only where its ruleset is in force",
      );
      expect(r.stdout).toContain("The approval stands.");
      expect(mergePuts()).toHaveLength(0);
    });

    test("is skipped when the branch moved after the approval", async () => {
      reviewed("pass");
      gh.pulls["nm000201#7"].movesToAfterReview = SHA_B;
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("changed after it was approved");
      expect(mergePuts()).toHaveLength(0);
    });

    test("an unknown merge method is refused before anything is sent to GitHub", async () => {
      reviewed("pass");
      const r = await approve(["--merge", "--method", "fast-forward"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("is not a merge method");
      expect(gh.seen.filter((s) => s.token === ADMIN_TOKEN)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// next
// ---------------------------------------------------------------------------------------------

describe("nemar admin pr-reviews next", () => {
  /** A pull request that needs you: open on GitHub, reviewed `verdict` at SHA_A, checks green. */
  function ready(ds: string, n: number, over: Partial<PrSpec> = {}, verdict = "pass") {
    gh.pulls[`${ds}#${n}`] = { sha: SHA_A, author: "alice" };
    seed({
      ds,
      n,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: verdict as "pass" | "fail" | "uncertain",
    });
    return { ds, n, author: "alice", authorId: 42, title: `Update ${ds}`, ...over };
  }
  const next = (input: string, extra: string[] = [], opts: Parameters<typeof cli>[1] = {}) =>
    cli([...PR, "next", ...extra], { ...opts, input });
  const writes = () => gh.seen.filter((s) => s.method !== "GET" && s.token === ADMIN_TOKEN);

  test("on a terminal, a pasted comment of several lines is cancelled and nothing is sent", async () => {
    // A pasted paragraph is one line plus lines that would answer the next cards. On a terminal
    // the first line is not the answer: the walk waits a moment for the rest of the paste (the
    // second line comes a few milliseconds behind the first, as a real paste does), drops it, says
    // so and writes nothing to GitHub. With no wait the first line would be posted.
    nodes(ready("nm000201", 7));

    const r = await cliOnTerminal([...PR, "next"], async (t) => {
      const shown = await t.waitFor("c comment");
      t.type("c\n");
      const asked = await t.waitFor("Comment (empty cancels): ", shown);
      t.type("The first line of a pasted paragraph\n");
      await Bun.sleep(10);
      t.type("and a second line that would answer the next question\n");
      await t.waitFor("Nothing was sent.", asked);
      await t.waitFor("q quit > ", asked);
      t.type("q\n");
    });

    expect(r.exitCode).toBe(0);
    expect(r.transcript).toContain("A comment is one line; 1 more line(s) arrived with it.");
    expect(adminWrites()).toEqual([]);
  });

  test("shows who, the review's summary and the checks, then y approves as you and squash-merges", async () => {
    nodes(ready("nm000201", 7, { title: "Add two subjects" }));
    const r = await next("y\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[1 of 1] nm000201 #7");
    expect(r.stdout).toContain("Title:    Add two subjects");
    expect(r.stdout).toContain("Author:   @alice");
    expect(r.stdout).toContain("Review:   pass");
    expect(r.stdout).toContain("BIDS ok");
    expect(r.stdout).toContain("version ok");
    expect(r.stdout).toContain("Passes: nothing lost, revision advances, materially better");
    expect(r.stdout).toContain("Adds two subjects and corrects the task description.");
    expect(r.stdout).toContain("Version:  1.0.0 to 1.1.0   revision advances: yes");
    expect(r.stdout).toContain("Approved nm000201 #7 at aaaaaaa as @queueadmin-gh.");
    expect(r.stdout).toContain("Merged nm000201 #7 (squash).");
    expect(r.stdout).toContain("Nothing left that needs you.");
    expect(r.stdout).toContain("Done: 1 merged.");

    expect(reviewPosts()).toHaveLength(1);
    expect(reviewPosts()[0].token).toBe(ADMIN_TOKEN);
    expect(reviewPosts()[0].body).toMatchObject({ commit_id: SHA_A, event: "APPROVE" });
    expect(mergePuts()).toHaveLength(1);
    expect(mergePuts()[0].body).toEqual({ sha: SHA_A, merge_method: "squash" });
    expect(
      gh.seen.filter(
        (s) => s.token === WORKER_TOKEN && s.method !== "GET" && s.path !== "/graphql",
      ),
    ).toHaveLength(0);
  });

  test("the card is short: the reviewer's sentence and the version, not the whole report", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("q\n");
    expect(r.stdout).toContain("Version:  1.0.0 to 1.1.0   revision advances: yes");
    expect(r.stdout).not.toContain("| Question | Answer |");
    expect(r.stdout).not.toContain("Changed files");
    expect(r.stdout).toContain("d details");
  });

  test("d shows the whole report and asks again, and sends nothing", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("d\nq\n");
    expect(r.stdout).toContain("| Question | Answer |");
    expect(r.stdout).toContain("Changed files (1 of 3)");
    expect(r.stdout.match(/ > /g)?.length).toBeGreaterThanOrEqual(2);
    expect(writes()).toHaveLength(0);
  });

  test("d on a pull request with no report for this commit says so", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "alice" };
    nodes({ ds: "nm000201", n: 7, author: "alice", authorId: 42 });
    const r = await next("d\nq\n");
    expect(r.stdout).toContain("This commit has not been reviewed.");
  });

  test("d on an exempt pull request says it is not reviewed, and not that a report could not be read", async () => {
    // The queue's own administrator opened it, so it is exempt; --all shows what needs nobody.
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "queueadmin-gh", authorId: 4001 };
    nodes({ ds: "nm000201", n: 7, author: "queueadmin-gh", authorId: 4001 });
    const r = await next("d\nq\n", ["--all"]);
    expect(r.stdout).toContain("exempt (owner or admin)");
    expect(r.stdout).toContain(
      "A NEMAR owner or administrator opened this pull request, so it is not reviewed.",
    );
    expect(r.stdout).not.toContain("could not be read");
    expect(r.stdout).not.toContain("has not been reviewed");
    expect(writes()).toHaveLength(0);
  });

  test("a version that did not go up is said so in red words, and the version check agrees or not", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "alice" };
    const report = goodReport({ advances_revision: "fail" });
    report.evidence.version_after = "1.0.0";
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "fail",
      report,
    });
    nodes({
      ds: "nm000201",
      n: 7,
      author: "alice",
      authorId: 42,
      checks: [bidsOk("nm000201"), { ...versionOk, conclusion: "FAILURE" }],
    });
    const r = await next("q\n", ["--all"]);
    expect(r.stdout).toContain("Version:  1.0.0 to 1.0.0   revision advances: NO");
    expect(r.stdout).toContain("version FAIL");
    expect(r.stdout).toContain("Findings:");
    expect(r.stdout).toContain("blocker");
  });

  test("n asks for a comment, posts it, and only then closes the pull request", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("n\nPlease add a CHANGES entry.\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Closed nm000201 #7, with your comment.");
    expect(r.stdout).toContain("Done: 1 closed.");
    expect(gh.comments).toEqual([
      { dataset: "nm000201", number: 7, body: "Please add a CHANGES entry.", token: ADMIN_TOKEN },
    ]);
    const order = writes().map((w) => `${w.method} ${w.path.split("/").slice(-2).join("/")}`);
    expect(order).toEqual(["POST 7/comments", "PATCH pulls/7"]);
    expect(gh.pulls["nm000201#7"].state).toBe("closed");
    expect(reviewPosts()).toHaveLength(0);
    expect(mergePuts()).toHaveLength(0);
  });

  test("c is just a comment: the pull request stays open and nothing else is sent", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("c\nCould you say which task the new subjects ran?\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Commented on nm000201 #7.");
    expect(r.stdout).toContain("Done: 1 commented.");
    expect(gh.comments.map((c) => c.body)).toEqual([
      "Could you say which task the new subjects ran?",
    ]);
    expect(writes()).toHaveLength(1);
    expect(gh.pulls["nm000201#7"].state).toBeUndefined();
  });

  test("an empty comment cancels the n or c and asks again, so nothing is closed by accident", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("n\n\nc\n   \nq\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.match(/Cancelled\. Nothing was sent\./g)).toHaveLength(2);
    expect(writes()).toHaveLength(0);
    expect(r.stdout).toContain("Nothing was changed.");
  });

  test("s leaves it for now, q stops, and neither sends anything", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3));
    const r = await next("s\nq\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[1 of 2] nm000201 #7");
    expect(r.stdout).toContain("[2 of 2] nm000202 #3");
    expect(r.stdout).toContain("Done: 1 skipped.");
    expect(writes()).toHaveLength(0);
  });

  test("goes through the queue: each answer is about the pull request on screen", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3), ready("nm000203", 4));
    const r = await next("y\nc\nThanks, merging the rest later.\nn\nThis duplicates nm000201.\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Merged nm000201 #7 (squash).");
    expect(r.stdout).toContain("Commented on nm000202 #3.");
    expect(r.stdout).toContain("Closed nm000203 #4, with your comment.");
    expect(r.stdout).toContain("Done: 1 merged, 1 closed, 1 commented.");
    expect(gh.comments.map((c) => [c.dataset, c.number])).toEqual([
      ["nm000202", 3],
      ["nm000203", 4],
    ]);
    expect(reviewPosts().map((p) => p.path)).toEqual([
      "/repos/nemarDatasets/nm000201/pulls/7/reviews",
    ]);
    expect(gh.pulls["nm000202#3"].state).toBeUndefined();
    expect(gh.pulls["nm000203#4"].state).toBe("closed");
  });

  test("--once handles one pull request and stops", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3));
    const r = await next("s\ny\n", ["--once"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("nm000202");
    expect(writes()).toHaveLength(0);
  });

  test("y is not offered when a required check is not green, and nothing is approved", async () => {
    nodes({
      ...ready("nm000201", 7),
      checks: [{ ...bidsOk("nm000201"), conclusion: "FAILURE" }, versionOk],
    });
    const r = await next("y\nq\n", ["--force"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("BIDS FAIL");
    expect(r.stdout).toContain("y is not available: A required check is not green (BIDS failing");
    expect(r.stdout).toContain("Not approved: A required check is not green");
    expect(writes()).toHaveLength(0);
  });

  test("n and c still work on a pull request whose checks are red", async () => {
    nodes({
      ...ready("nm000201", 7),
      checks: [{ ...bidsOk("nm000201"), conclusion: "FAILURE" }, versionOk],
    });
    const r = await next("n\nThe BIDS validation fails on sub-03.\n");
    expect(r.stdout).toContain("Closed nm000201 #7, with your comment.");
  });

  test("a failing review is not in the queue unless --all, and then y needs --force", async () => {
    nodes(ready("nm000201", 7, {}, "fail"));
    const hidden = await next("q\n");
    expect(hidden.stdout).toContain("Nothing left that needs you.");

    const shown = await next("y\nq\n", ["--all"]);
    expect(shown.stdout).toContain("Review:   fail");
    expect(shown.stdout).toContain("y is not available:");
    expect(shown.stdout).toContain("--force");
    expect(writes()).toHaveLength(0);

    const forced = await next("y\n", ["--all", "--force"]);
    expect(forced.stdout).toContain("Merged nm000201 #7 (squash).");
  });

  test("another commit's report is not shown as this commit's", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "alice" };
    seed({
      ds: "nm000201",
      n: 7,
      sha: SHA_B,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    nodes({ ds: "nm000201", n: 7, author: "alice", authorId: 42 });
    const r = await next("q\n");
    expect(r.stdout).toContain("not reviewed (other commit)");
    expect(r.stdout).toContain("read a different commit of this pull request");
    expect(r.stdout).not.toContain("Adds two subjects and corrects the task description.");
  });

  test("checks the list read for another commit are not trusted for the one now on GitHub", async () => {
    // The search named SHA_B as the head; the administrator's own read finds SHA_A.
    nodes({ ...ready("nm000201", 7), sha: SHA_B });
    const r = await next("y\nq\n");
    expect(r.stdout).toContain("changed since the list was read");
    expect(r.stdout).toContain("BIDS ?");
    expect(r.stdout).toContain("y is not available: A required check is not green (BIDS unknown");
    expect(writes()).toHaveLength(0);
  });

  test("a pull request the search index has not caught up on is skipped with a note", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3));
    gh.pulls["nm000201#7"].state = "closed";
    gh.pulls["nm000201#7"].merged = true;
    const r = await next("y\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000201 #7: skipped, This pull request is already merged.");
    expect(r.stdout).toContain("Merged nm000202 #3 (squash).");
  });

  test("a draft is never shown, with or without --all", async () => {
    nodes(ready("nm000201", 7, { draft: true }));
    for (const extra of [[], ["--all"]]) {
      const r = await next("y\n", extra);
      expect(r.stdout).toContain("Nothing left that needs you.");
      expect(r.stdout).not.toContain("[1 of");
    }
    expect(writes()).toHaveLength(0);
  });

  test("a refused approval is reported and the run goes on to the next", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3));
    gh.reviewStatus = 422;
    const r = await next("y\ns\n");
    // A refusal is reported and the run goes on, but the run did not do what it was asked.
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not approved: Can not approve your own pull request");
    expect(r.stdout).toContain("[2 of 2] nm000202 #3");
    expect(r.stdout).toContain("1 skipped, 1 failed");
    expect(mergePuts()).toHaveLength(0);
  });

  test("an approval whose outcome is unknown stops the run before the next pull request", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3));
    gh.reviewStatus = 502;
    const r = await next("y\ny\n");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Outcome unknown: GitHub may have recorded the approval");
    expect(r.stdout).not.toContain("[2 of 2]");
    expect(reviewPosts()).toHaveLength(1);
  });

  test("a comment that is posted but a close that is refused says the comment stands", async () => {
    nodes(ready("nm000201", 7));
    gh.closeStatus = 403;
    const r = await next("n\nClosing, superseded.\n");
    expect(r.stdout).toContain("The comment was posted.");
    expect(r.stdout).toContain("Not closed:");
    expect(r.stdout).not.toContain("Outcome unknown");
    expect(gh.comments).toHaveLength(1);
    expect(r.stdout).toContain("1 failed");
  });

  test("a merge GitHub will not do leaves the approval standing and goes on", async () => {
    // Clean when the card was shown (so y was offered), blocked by the time of the merge.
    nodes(ready("nm000201", 7), ready("nm000202", 3));
    gh.pulls["nm000201#7"].mergeableStateAfterReview = "blocked";
    const r = await next("y\ns\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Approved nm000201 #7");
    expect(r.stdout).toContain("a required check or review is not satisfied");
    expect(r.stdout).not.toContain("Not merged: Not merged");
    expect(r.stdout).toContain("1 approved but not merged");
    expect(mergePuts()).toHaveLength(0);
  });

  test("a merge whose outcome is unknown is counted as unknown, not as 'approved but not merged'", async () => {
    nodes(ready("nm000201", 7));
    gh.mergeStatus = 502;
    const r = await next("y\n");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Outcome unknown: GitHub may have merged it");
    expect(r.stdout).toContain("Done: 1 with an unknown outcome (check the pull request).");
    expect(r.stdout).not.toContain("approved but not merged");
  });

  test("a close whose outcome is unknown says the comment was posted and that the close may have happened", async () => {
    nodes(ready("nm000201", 7));
    gh.closeStatus = 502;
    const r = await next("n\nClosing, superseded.\n");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("The comment was posted.");
    expect(r.stdout).toContain("Outcome unknown: GitHub may have closed it");
    expect(r.stdout).not.toContain("is not closed");
    expect(r.stdout).toContain("1 with an unknown outcome");
    expect(gh.comments).toHaveLength(1);
  });

  test("a comment whose answer cannot be read is unknown too, and stops the run", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3));
    gh.unreadableAnswers = true;
    const r = await next("c\nHello.\nq\n");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Outcome unknown: GitHub may have posted the comment");
    expect(r.stdout).not.toContain("[2 of 2]");
  });

  test("'nothing left' is only said when it is known: skipped and failed pull requests still need you", async () => {
    nodes(ready("nm000201", 7));
    const skipped = await next("s\n");
    expect(skipped.stdout).not.toContain("Nothing left that needs you.");
    expect(skipped.stdout).toContain(
      "No more pull requests to show, but 1 still needs you (skipped, failed, with an unknown outcome, or approved and not merged).",
    );
    const clean = await next("y\n");
    expect(clean.stdout).toContain("Nothing left that needs you.");
  });

  test("'nothing left' is qualified when the list was incomplete, or part of it belongs to the other Worker", async () => {
    gh.searchPages = [[prNode(ready("nm000201", 7)), prNode({ ds: "xx090001", n: 1 })]];
    const r = await next("y\n");
    expect(r.stdout).toContain("Merged nm000201 #7 (squash).");
    expect(r.stdout).not.toContain("Nothing left that needs you.");
    expect(r.stdout).toContain("belong to the other environment's Worker and are not shown");

    const queue: QueueResponse = {
      environment: "production",
      review_enabled: true,
      entries: [],
      total_open: 0,
      truncated: true,
      skipped: { not_a_dataset: 0, not_owned_here: 0, unreadable: 0 },
      filters: { verdicts: [], dataset: null, author: null, needs_me: true },
      volume: null,
    };
    apiOverride = (req) =>
      new URL(req.url).pathname === "/admin/pr-reviews" ? Response.json(queue) : null;
    const truncated = await next("");
    expect(truncated.stdout).not.toContain("Nothing left that needs you.");
    expect(truncated.stdout).toContain("this list is incomplete");
  });

  test("a comment or a close is not written if the pull request changed while the card was open", async () => {
    nodes(ready("nm000201", 7));
    // The administrator's read finds SHA_A; every read after it finds a push.
    gh.pulls["nm000201#7"].headAfterFirstRead = SHA_B;
    const r = await next("n\nThis does not pass.\n");
    expect(r.stdout).toContain("This pull request changed while it was open here");
    expect(r.stdout).toContain("Nothing was sent.");
    expect(gh.comments).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(r.stdout).toContain("1 skipped");
  });

  test("a pull request this token cannot see is skipped with a note, counted, and the run goes on", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3));
    Reflect.deleteProperty(gh.pulls, "nm000201#7"); // GitHub answers 404
    const r = await next("y\n");
    expect(r.stdout).toContain("nm000201 #7: skipped,");
    expect(r.stdout).toContain("Merged nm000202 #3 (squash).");
    expect(r.stdout).toContain("1 merged, 1 failed");
    expect(r.exitCode).toBe(1);
  });

  test("a pull request with merge conflicts is shown as such and y is not offered", async () => {
    nodes(ready("nm000201", 7));
    gh.pulls["nm000201#7"].mergeableState = "dirty";
    const r = await next("y\nq\n");
    expect(r.stdout).toContain("Merge:    it has merge conflicts");
    expect(r.stdout).toContain("y is not available:");
    expect(r.stdout).toContain("'dirty' (it has merge conflicts)");
    expect(writes()).toHaveLength(0);
  });

  /** The prompt line for a card: `y` is in it only when `y` will be accepted. */
  const PROMPT_WITH_Y = "\ny approve + squash merge, n close, c comment";
  const PROMPT_WITHOUT_Y = "\nn close, c comment, d details, s skip, q quit > ";

  test("a pull request the review holds (unstable) is not offered y, and answering y writes nothing", async () => {
    nodes(ready("nm000201", 7, {}, "uncertain"));
    gh.pulls["nm000201#7"].mergeableState = "unstable";
    const r = await next("y\nq\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "Merge:    a check or status that is not required is not passing or has not reported",
    );
    expect(r.stdout).toContain("(GitHub: unstable)");
    expect(r.stdout).toContain(
      "y is not available: GitHub reports this pull request as 'unstable'",
    );
    expect(r.stdout).toContain("so a merge would not be attempted");
    // The way to approve without merging, and what can be done here instead.
    expect(r.stdout).toContain("nemar admin pr-reviews approve nm000201 7");
    expect(r.stdout).toContain("without --merge");
    // y is not on the prompt, and typing it anyway is refused with the reason, not obeyed.
    expect(r.stdout).toContain(PROMPT_WITHOUT_Y);
    expect(r.stdout).not.toContain(PROMPT_WITH_Y);
    expect(r.stdout).toContain("Not approved: GitHub reports this pull request as 'unstable'");
    // The assertions that matter: nothing was approved, nothing was merged, nothing was written.
    expect(r.stdout).not.toContain("Approved nm000201");
    expect(reviewPosts()).toHaveLength(0);
    expect(mergePuts()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  test("a clean pull request is approved and merged, and the held one after it is refused y and can still be commented on", async () => {
    // The queue lists a pass before a review that is not one, so the clean card comes first.
    nodes(ready("nm000201", 7, {}, "uncertain"), ready("nm000202", 3));
    gh.pulls["nm000201#7"].mergeableState = "unstable";
    const r = await next("y\ny\nc\nWaiting for the review.\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Not approved: GitHub reports this pull request as 'unstable'");
    expect(r.stdout).toContain("Commented on nm000201 #7.");
    expect(r.stdout).toContain("Merged nm000202 #3 (squash).");
    expect(r.stdout).toContain("Done: 1 merged, 1 commented.");
    // Only the clean one was approved and merged, by the administrator's token.
    expect(reviewPosts().map((p) => p.path)).toEqual([
      "/repos/nemarDatasets/nm000202/pulls/3/reviews",
    ]);
    expect(mergePuts().map((p) => p.path)).toEqual(["/repos/nemarDatasets/nm000202/pulls/3/merge"]);
    expect(writes().every((w) => w.token === ADMIN_TOKEN)).toBe(true);
  });

  test("y reads the state again right before approving: one that stopped being clean after the card was shown writes nothing", async () => {
    nodes(ready("nm000201", 7));
    // Clean when the card was built, so y is offered; unstable when y is answered.
    gh.pulls["nm000201#7"].adminReadsAfterFirst = { mergeableState: "unstable" };
    const r = await next("y\nq\n");
    expect(r.stdout).toContain(PROMPT_WITH_Y);
    expect(r.stdout).toContain(
      "Not approved: Checked again just before approving: GitHub reports this pull request as 'unstable'",
    );
    expect(r.stdout).not.toContain("Approved nm000201");
    expect(writes()).toHaveLength(0);
  });

  test("the late look in next refuses a read that fails, a branch that moved and a pull request that closed, too", async () => {
    for (const [later, said] of [
      [{ status: 502 }, "Could not check whether it can be merged"],
      [{ sha: SHA_B }, "The pull request changed since it was read."],
      [{ state: "closed" }, "The pull request is no longer open (it was closed)."],
    ] as const) {
      gh.reset();
      db.run("DELETE FROM pr_reviews");
      nodes(ready("nm000201", 7));
      gh.pulls["nm000201#7"].adminReadsAfterFirst = later;
      const r = await next("y\ny\nq\n");
      expect(r.stdout, said).toContain(
        `Not approved: Checked again just before approving: ${said}`,
      );
      // Typing y again takes the late look again against the head the card was shown for, so for a
      // moved head it refuses every time: the advice is never "try y again".
      expect(r.stdout, said).not.toContain("Try y again");
      const again = "run 'nemar admin pr-reviews next' again to look again.";
      if (said.includes("no longer open")) expect(r.stdout, said).not.toContain(again);
      else expect(r.stdout, said).toContain(again);
      expect(writes(), said).toHaveLength(0);
    }
  });

  test("the late look in next is taken when y is answered, not when the card is shown", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("q\n");
    expect(r.stdout).toContain(PROMPT_WITH_Y);
    // The card's own read only: nothing looked again before an answer was given.
    expect(
      gh.seen.filter(
        (s) => s.method === "GET" && s.path.endsWith("/pulls/7") && s.token === ADMIN_TOKEN,
      ),
    ).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  test("the late look in next costs one more read when the state is clean", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("y\n");
    expect(r.stdout).toContain("Merged nm000201 #7 (squash).");
    // The card, the look right before the approval, and the look right before the merge.
    expect(
      gh.seen.filter(
        (s) => s.method === "GET" && s.path.endsWith("/pulls/7") && s.token === ADMIN_TOKEN,
      ),
    ).toHaveLength(3);
  });

  test("a clean pull request is still offered y, approved first and merged second", async () => {
    // The other direction: the state check must not take y away from a pull request that can merge.
    nodes(ready("nm000201", 7));
    const r = await next("y\n");
    expect(r.stdout).toContain(PROMPT_WITH_Y);
    expect(r.stdout).not.toContain("y is not available");
    expect(writes().map((w) => `${w.method} ${w.path.split("/").pop()}`)).toEqual([
      "POST reviews",
      "PUT merge",
    ]);
  });

  test("every state but clean takes y away, whatever --force says", async () => {
    for (const state of ["blocked", "behind", "dirty", "draft", "has_hooks", "brand_new_state"]) {
      gh.reset();
      db.run("DELETE FROM pr_reviews");
      nodes(ready("nm000201", 7));
      gh.pulls["nm000201#7"].mergeableState = state;
      const r = await next("y\nq\n", ["--force"]);
      expect(r.stdout, state).toContain(
        `y is not available: GitHub reports this pull request as '${state}'`,
      );
      expect(r.stdout, state).not.toContain(PROMPT_WITH_Y);
      expect(writes(), state).toHaveLength(0);
    }
  });

  test("an answer that carries no mergeable_state is not clean: y is not offered and nothing is written", async () => {
    nodes(ready("nm000201", 7));
    gh.pulls["nm000201#7"].omitMergeableState = true;
    const r = await next("y\nq\n");
    expect(r.stdout).toContain("y is not available: GitHub reports this pull request as 'unknown'");
    expect(r.stdout).not.toContain(PROMPT_WITH_Y);
    expect(writes()).toHaveLength(0);
  });

  test("a state GitHub never settles is not clean: y is not offered and nothing is written", async () => {
    nodes(ready("nm000201", 7));
    gh.pulls["nm000201#7"].unknownReads = 99;
    const r = await next("y\nq\n");
    expect(r.stdout).toContain("y is not available: GitHub reports this pull request as 'unknown'");
    // y is not offered, so typing it again does not look again: the advice is to run next again.
    expect(r.stdout).toContain(
      "s skips it; run 'nemar admin pr-reviews next' again to look again.",
    );
    expect(r.stdout).not.toContain("Try y again");
    expect(r.stdout).not.toContain(PROMPT_WITH_Y);
    expect(writes()).toHaveLength(0);
  });

  test("when asking again fails or finds the branch moved, the card says which, and y is not offered", async () => {
    for (const [later, card, said] of [
      [{ status: 502 }, "could not be checked (", "Could not check whether it can be merged ("],
      [
        { sha: SHA_B },
        "the pull request changed since it was read",
        "The pull request changed since it was read.",
      ],
    ] as const) {
      gh.reset();
      db.run("DELETE FROM pr_reviews");
      nodes(ready("nm000201", 7));
      Object.assign(gh.pulls["nm000201#7"], { unknownReads: 1, adminReadsAfterFirst: later });
      const r = await next("y\nq\n");
      expect(r.stdout, said).toContain(`Merge:    ${card}`);
      expect(r.stdout, said).toContain(`y is not available: ${said}`);
      // Not the sentence for a state GitHub did not give: nothing of the kind happened.
      expect(r.stdout, said).not.toContain("has not said whether it can be merged");
      expect(r.stdout, said).toContain(
        "s skips it; run 'nemar admin pr-reviews next' again to look again.",
      );
      expect(r.stdout, said).not.toContain("Try y again");
      expect(r.stdout, said).not.toContain(PROMPT_WITH_Y);
      expect(writes(), said).toHaveLength(0);
    }
  });

  test("a pull request closed or merged while its card was being prepared is not offered y", async () => {
    for (const [later, word] of [
      [{ state: "closed" }, "closed"],
      [{ state: "closed", merged: true }, "merged"],
    ] as const) {
      gh.reset();
      db.run("DELETE FROM pr_reviews");
      nodes(ready("nm000201", 7));
      Object.assign(gh.pulls["nm000201#7"], { unknownReads: 1, adminReadsAfterFirst: later });
      const r = await next("y\nq\n");
      expect(r.stdout, word).toContain("Merge:    the pull request is no longer open");
      expect(r.stdout, word).toContain(
        `y is not available: The pull request is no longer open (it was ${word}).`,
      );
      expect(r.stdout, word).not.toContain("in a moment");
      expect(r.stdout, word).not.toContain(PROMPT_WITH_Y);
      expect(writes(), word).toHaveLength(0);
    }
  });

  test("a state GitHub is still working out is asked about again before the card is shown", async () => {
    nodes(ready("nm000201", 7));
    gh.pulls["nm000201#7"].unknownReads = 1;
    const r = await next("y\n");
    expect(r.stdout).toContain(PROMPT_WITH_Y);
    expect(r.stdout).toContain("Merged nm000201 #7 (squash).");
    expect(reviewPosts()).toHaveLength(1);
    expect(mergePuts()).toHaveLength(1);
  });

  test("--force says on the card that y will approve against the review", async () => {
    nodes(ready("nm000201", 7, {}, "fail"));
    const r = await next("q\n", ["--all", "--force"]);
    expect(r.stdout).toContain(
      "--force: y will approve although the review says it needs changes.",
    );
  });

  test("the stored verdict and the report disagreeing is said on the card, with the stricter used", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "alice" };
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "fail",
      report: goodReport(), // the report alone would pass
    });
    nodes({ ds: "nm000201", n: 7, author: "alice", authorId: 42 });
    const r = await next("q\n", ["--all"]);
    expect(r.stdout).toContain("Review:   fail");
    expect(r.stdout).toContain("The stored verdict is fail; the report below would now read pass.");
    expect(r.stdout).toContain("y is not available:");
  });

  test("d says a report could not be read when it could not, and not that there is none", async () => {
    nodes(ready("nm000201", 7));
    apiOverride = (req) =>
      new URL(req.url).pathname.startsWith("/admin/pr-reviews/")
        ? Response.json(
            { error: "nm000201 belongs to the dev Worker.", code: "not_owned_here" },
            { status: 404 },
          )
        : null;
    const r = await next("d\nq\n", ["--force"]);
    expect(r.stdout).toContain("The report could not be read (");
    expect(r.stdout).not.toContain("There is no report");
    expect(r.stdout).not.toContain("has not been reviewed");
  });

  test("input that ends stops the run without sending anything", async () => {
    nodes(ready("nm000201", 7));
    const none = await next("");
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain("Input ended; stopping.");
    expect(writes()).toHaveLength(0);
    const closed = await cli([...PR, "next"]); // stdin closed, as under cron or a pipe that ended
    expect(closed.exitCode).toBe(0);
    expect(writes()).toHaveLength(0);
  });

  test("an answer that is not one of the five is not guessed at", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("approve it\nmaybe\nq\n");
    expect(r.stdout.match(/Type y, n, c, d, s or q\./g)).toHaveLength(2);
    expect(writes()).toHaveLength(0);
  });

  test("a token that is not yours is refused before any pull request is shown", async () => {
    nodes(ready("nm000201", 7));
    const r = await next("y\n", [], { env: { GH_TOKEN: OTHER_TOKEN } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("GH_TOKEN belongs to @someone-else");
    expect(r.stdout).not.toContain("[1 of 1]");
    expect(writes()).toHaveLength(0);
  });

  test("--dataset and --author narrow what is shown", async () => {
    nodes(ready("nm000201", 7), ready("nm000202", 3, { author: "bob", authorId: 43 }));
    const r = await next("q\n", ["--dataset", "nm000202"]);
    expect(r.stdout).toContain("nm000202 #3");
    expect(r.stdout).not.toContain("nm000201 #7");
    const bob = await next("q\n", ["--author", "bob"]);
    expect(bob.stdout).toContain("nm000202 #3");
    expect((await next("q\n", ["--dataset", "nm1"])).exitCode).toBe(1);
  });

  test("with the list incomplete it says so before the first pull request", async () => {
    gh.searchPages = [[prNode(ready("nm000201", 7))]];
    const queue: QueueResponse = {
      environment: "production",
      review_enabled: true,
      entries: [],
      total_open: 0,
      truncated: true,
      skipped: { not_a_dataset: 0, not_owned_here: 0, unreadable: 0 },
      filters: { verdicts: [], dataset: null, author: null, needs_me: true },
      volume: null,
    };
    apiOverride = (req) =>
      new URL(req.url).pathname === "/admin/pr-reviews" ? Response.json(queue) : null;
    const r = await next("");
    expect(r.stdout).toContain("this list is incomplete");
  });
});

// ---------------------------------------------------------------------------------------------
// The token gh holds, and what a token that is not usable looks like
// ---------------------------------------------------------------------------------------------

describe("the GitHub credential", () => {
  /** A `gh` on PATH that runs `script`, so the real subprocess path is the one under test. */
  function withGh<T>(script: string, run: (path: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "nemar-gh-shim-"));
    writeFileSync(join(dir, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  function reviewedPass() {
    livePull(SHA_A);
    seed({
      ds: "nm000201",
      n: 7,
      sha: SHA_A,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
  }
  const approveWith = (extra: Record<string, string | undefined>, path?: string) =>
    cli([...PR, "approve", "nm000201", "7", "--yes"], {
      env: { GH_TOKEN: undefined, ...(path ? { PATH: path } : {}), ...extra },
    });

  // Emulates gh's own precedence: it answers GH_TOKEN, then GITHUB_TOKEN, before the login it stores.
  const GH_LIKE =
    'if [ -n "$GH_TOKEN" ]; then echo "$GH_TOKEN"; elif [ -n "$GITHUB_TOKEN" ]; then echo "$GITHUB_TOKEN"; else echo gho_admin_own_token; fi';

  test("asks gh for the account it is signed in as, not whatever GITHUB_TOKEN is in the environment", async () => {
    reviewedPass();
    await withGh(GH_LIKE, async (path) => {
      // GITHUB_TOKEN is another person's. gh would answer it; the command must not let it.
      const r = await approveWith({ GITHUB_TOKEN: OTHER_TOKEN }, path);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Approved nm000201 #7 at aaaaaaa as @queueadmin-gh.");
      expect(reviewPosts()[0].token).toBe(ADMIN_TOKEN);
    });
  });

  test("a mismatch with the token gh holds says to switch accounts in gh", async () => {
    reviewedPass();
    await withGh(`echo ${OTHER_TOKEN}`, async (path) => {
      const r = await approveWith({}, path);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain(
        "gh is signed in as @someone-else, but your NEMAR account is linked to @queueadmin-gh",
      );
      expect(r.stdout).toContain("gh auth switch");
      expect(reviewPosts()).toHaveLength(0);
    });
  });

  test("a gh that is signed out falls back to the link and the command", async () => {
    reviewedPass();
    await withGh('echo "You are not logged into any GitHub hosts." >&2; exit 1', async (path) => {
      const r = await approveWith({}, path);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain(
        "Cannot approve from here: gh has no signed-in account for github.com (You are not logged into any GitHub hosts.)",
      );
      expect(r.stdout).toContain("gh pr review 7 --repo nemarDatasets/nm000201 --approve");
      expect(reviewPosts()).toHaveLength(0);
    });
  });

  test("a rejected token says where it came from, and how to use gh's own", async () => {
    reviewedPass();
    const r = await approveWith({ GH_TOKEN: "expired-token" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("GitHub rejected this token.");
    expect(r.stdout).toContain("(the token came from GH_TOKEN)");
    expect(r.stdout).toContain("Unset GH_TOKEN");
    // A rejected token is not an app token: no "do it by hand" fallback for it.
    expect(r.stdout).not.toContain("Approve it on GitHub with your own account");
  });

  test("a GitHub outage is not reported as a verdict on the token", async () => {
    reviewedPass();
    gh.userStatus = 503;
    const outage = await approveWith({ GH_TOKEN: ADMIN_TOKEN });
    expect(outage.exitCode).toBe(1);
    expect(outage.stdout).toContain("answered HTTP 503");
    expect(outage.stdout).not.toContain("cannot approve for you");
    expect(outage.stdout).not.toContain("Approve it on GitHub with your own account");

    gh.userStatus = 403;
    gh.userMessage = "You have exceeded a secondary rate limit.";
    const limited = await approveWith({ GH_TOKEN: ADMIN_TOKEN });
    expect(limited.stdout).toContain("answered HTTP 403");
    expect(limited.stdout).not.toContain("cannot approve for you");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("a rejected GITHUB_API URL is an error, not a quiet use of the real GitHub", async () => {
    reviewedPass();
    const r = await approveWith({
      GH_TOKEN: ADMIN_TOKEN,
      NEMAR_GITHUB_API_URL: "https://evil.test",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("NEMAR_GITHUB_API_URL is set but is not");
    expect(gh.seen).toHaveLength(0);
  });
});

describe("show, when GitHub cannot be read", () => {
  test("a stored pass is not presented as the current commit's", async () => {
    // The Worker holds a pass, and GitHub has no answer for the pull request.
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    envOverrides = { GITHUB_ADMIN_PAT: undefined }; // the Worker cannot ask GitHub at all
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("GitHub could not be read");
    expect(r.stdout).toContain("whether that is the current commit is unknown");
    expect(r.stdout).not.toMatch(/Review:\s+pass of/);

    const json = JSON.parse((await cli([...PR, "show", "nm000201", "7", "--json"])).stdout);
    expect(json).toMatchObject({
      verdict: "not_reviewed",
      stale_verdict: "pass",
      review_current: null,
      live: null,
      live_status: "unreadable",
    });
  });

  test("a pull request GitHub answers 404 for is said to be missing, which is not 'could not be read'", async () => {
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("GitHub says this pull request does not exist");
    expect(r.stdout).not.toContain("GitHub could not be read");
    const json = JSON.parse((await cli([...PR, "show", "nm000201", "7", "--json"])).stdout);
    expect(json).toMatchObject({ live: null, live_status: "missing" });
  });

  test("a review that never reported says so instead of 'still running'", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "dispatched",
      createdAt: "2026-09-01 00:00:00",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.stdout).toContain("No report has arrived for this review");
    expect(r.stdout).not.toContain("still running");
    expect(r.stdout).toContain("could not decide (never reported)");
  });
});
