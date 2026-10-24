/**
 * `nemar admin pr-reviews start` (ADR 0092, ADR 0093): review the pull requests that were already
 * open when the automated review was switched on, or start again one whose review ended without a
 * verdict. Driven through the real entry point (`bun run src/index.ts ...`) like its sibling suite.
 *
 * The NEMAR API is the REAL admin router over bun:sqlite with every migration applied, served on a
 * local port and reached through TEST_API_URL. GitHub is a `Bun.serve()` stand-in that answers the
 * search, the pull request reads and the dispatch, check and comment writes, and records every
 * request with the token it carried. Isolated NEMAR_CONFIG_DIR, no mocks.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
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
import { PR_REVIEW_DEADLINE_MINUTES } from "../backend/src/services/pr-review";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makePrQueueApp } from "../backend/test/helpers/pr-queue-app";
import { type PrSpec, SHA_A, prNode, seedReview } from "../backend/test/helpers/pr-queue-fixtures";
import { type GitHubStandin, WORKER_TOKEN, startGitHubStandin } from "./helpers/github-standin";

setDefaultTimeout(30_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "cli-start-admin-key-0123456789abcdef0123456789abcdef";
const CALLBACK_SECRET = "cli-start-callback-secret";

let gh: GitHubStandin;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
let envOverrides: Partial<Bindings> = {};
let handle: ReturnType<typeof makePrQueueApp>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: WORKER_TOKEN,
    PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
    PR_REVIEW_ENABLED: "1",
    API_BASE_URL: "https://api.test.nemar.org",
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
      return handle(req, env());
    },
  });
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  apiServer.stop(true);
  gh.stop();
});

function seedDataset(id: string) {
  db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
  );
  db.run(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo, first_published_at)
     VALUES (?, ?, 1, 'active', 'public', 0, ?, '2026-01-01 00:00:00')`,
    [id, `A sufficiently descriptive title for ${id}`, `nemarDatasets/${id}`],
  );
}

beforeEach(async () => {
  db = freshDb();
  envOverrides = {};
  gh.reset();
  configDir = mkdtempSync(join(tmpdir(), "nemar-pr-start-cli-"));
  for (const id of ["nm000201", "nm000202", "nm000203", "nm000204", "nm000205"]) seedDataset(id);
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES ('startadmin', 'startadmin@example.org', 'x', 'startadmin-gh', 'approved', 'admin',
             'cli', 1, 1)`,
  );
  const row = db.query("SELECT id FROM users WHERE username = 'startadmin'").get() as {
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
      activeAccount: "startadmin",
      accounts: { startadmin: { apiKey: ADMIN_KEY } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function cli(
  args: string[],
  apiUrl = `http://127.0.0.1:${apiServer.port}`,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_GITHUB_API_URL: gh.url,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(childEnv)) if (v !== undefined) clean[k] = v;
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: clean,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

const START = ["admin", "pr-reviews", "start"];

/** An open pull request: in the GraphQL search the queue lists, and as GitHub's REST record. */
function openPr(spec: PrSpec & { assoc?: string }) {
  const sha = spec.sha ?? SHA_A;
  gh.searchPages = [[...(gh.searchPages[0] ?? []), prNode({ ...spec, sha })]];
  gh.pulls[`${spec.ds}#${spec.n}`] = {
    sha,
    author: spec.author ?? "contributor",
    authorId: spec.authorId ?? 501,
    assoc: spec.assoc ?? "COLLABORATOR",
    draft: spec.draft ?? false,
  };
}

const dispatches = () =>
  gh.seen.filter(
    (s) => s.method === "POST" && s.path === "/repos/nemarDatasets/.github/dispatches",
  );
const rows = () =>
  db.query("SELECT * FROM pr_reviews ORDER BY id").all() as Array<Record<string, unknown>>;

describe("nemar admin pr-reviews start <dataset> <pr>", () => {
  test("starts the review of one open pull request, reading it from GitHub itself", async () => {
    openPr({ ds: "nm000201", n: 12, author: "alice", authorId: 42 });

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000201 #12");
    expect(r.stdout).toContain("started");
    expect(dispatches()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ dataset_id: "nm000201", pr_number: 12, author_id: 42 });
    // The Worker read the pull request with its own token, not the administrator's.
    const read = gh.seen.find((s) => s.method === "GET" && s.path.endsWith("/nm000201/pulls/12"));
    expect(read?.token).toBe(WORKER_TOKEN);
    // The administrator's start is not an approval or a merge.
    expect(
      gh.seen.filter((s) => s.path.endsWith("/reviews") || s.path.endsWith("/merge")),
    ).toHaveLength(0);
  });

  test("says why a pull request was not started, in words", async () => {
    openPr({ ds: "nm000201", n: 12 });
    await cli([...START, "nm000201", "12"]);

    const again = await cli([...START, "nm000201", "12"]);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already has a review");
    expect(dispatches()).toHaveLength(1);
  });

  test("a blocked contributor is named, with the command that lifts the block", async () => {
    db.run(
      "INSERT INTO pr_review_overrides (author_id, author_login, mode) VALUES (42, 'alice', 'block')",
    );
    openPr({ ds: "nm000201", n: 12, author: "alice", authorId: 42 });

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "not started: the contributor is blocked by an administrator (lift it with: nemar admin pr-reviews allow alice)",
    );
    expect(dispatches()).toHaveLength(0);
  });

  test("an owner's or administrator's pull request is not started, and the sentence says why", async () => {
    openPr({ ds: "nm000201", n: 12, author: "startadmin-gh", authorId: 4001 });

    const r = await cli([...START, "nm000201", "12"]);

    // An answer about a pull request, not a fault in the command.
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "not started: its author is a NEMAR owner or administrator, so it is not reviewed",
    );
    expect(dispatches()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    // Its check was posted, as skipped, by the Worker.
    const checks = gh.seen.filter((s) => s.method === "POST" && s.path.endsWith("/check-runs"));
    expect(checks).toHaveLength(1);
    expect(checks[0].body).toMatchObject({ status: "completed", conclusion: "skipped" });
  });

  test("an administrator's pull request whose title breaks the naming rule is not started, and its check fails", async () => {
    openPr({ ds: "nm000201", n: 12, author: "startadmin-gh", authorId: 4001 });
    const pull = gh.pulls["nm000201#12"];
    if (!pull) throw new Error("no pull request");
    pull.title = "Lee2019 EEG rename";

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "not started: its author is a NEMAR owner or administrator, and the naming rule refused its title or its new dataset name, so its check failed",
    );
    expect(dispatches()).toHaveLength(0);
    const checks = gh.seen.filter((s) => s.method === "POST" && s.path.endsWith("/check-runs"));
    expect(checks).toHaveLength(1);
    expect(checks[0].body).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  test("an administrator's pull request whose dataset name GitHub would not show is a fault: exit 1, and how to retry", async () => {
    openPr({ ds: "nm000201", n: 12, author: "startadmin-gh", authorId: 4001 });
    gh.naming.nm000201 = {
      files: ["dataset_description.json"],
      names: { [SHA_A]: 502 },
    };

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      "not started: its author is a NEMAR owner or administrator, and its dataset name could not be read to check the naming rule, so its check needs a person",
    );
    // Either GitHub did not answer or the file is unreadable: one more try, then the file, and
    // never a bare "again in a moment", which a file that cannot be read answers the same way.
    expect(r.stdout).toContain(
      "GitHub may not have answered, or dataset_description.json has no readable Name",
    );
    expect(r.stdout).toContain("run the same command once more");
    expect(r.stdout).toContain("fix dataset_description.json and push");
    expect(r.stdout).not.toContain("in a moment");
    expect(r.stdout).not.toContain("naming_unchecked");
    const checks = gh.seen.filter((s) => s.method === "POST" && s.path.endsWith("/check-runs"));
    expect(checks[0]?.body).toMatchObject({ conclusion: "action_required" });
  });

  test("an administrator's pull request whose naming problem was waived for this commit says so, exit 0", async () => {
    openPr({ ds: "nm000201", n: 12, author: "startadmin-gh", authorId: 4001 });
    const pull = gh.pulls["nm000201#12"];
    if (!pull) throw new Error("no pull request");
    pull.title = "Lee2019 EEG rename";
    db.run(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (1, 'pr_review_naming_waived', 'pr_review', 'nm000201#12', ?)`,
      [JSON.stringify({ head_sha: SHA_A, title: "author_year", name: null })],
    );

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "not started: its author is a NEMAR owner or administrator, and the naming rule was waived for this commit",
    );
    expect(dispatches()).toHaveLength(0);
  });

  test("the help says when a review that never came back may be started again, in the Worker's minutes", async () => {
    const r = await cli([...START, "--help-all"]);
    expect(r.exitCode).toBe(0);
    const help = r.stdout.replace(/\s+/g, " ");
    expect(help).toContain(
      `more than ${PR_REVIEW_DEADLINE_MINUTES} minutes ago that never came back`,
    );
    expect(help).toContain("up to two model calls");
    expect(help).not.toContain("one or two model calls");
    // A run the naming rule ends asked no model, so it is not a call either.
    expect(help).toContain("a run the naming rule ends makes none");
  });

  test("a pull request GitHub does not have is an error with a word", async () => {
    const r = await cli([...START, "nm000201", "99"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("GitHub has no such pull request");
    // An answer about a pull request, not a fault in the command: no invitation to file a bug.
    expect(r.stdout + r.stderr).not.toContain("--debug");
    expect(rows()).toHaveLength(0);
  });

  test("the review being off says so and starts nothing", async () => {
    envOverrides = { PR_REVIEW_ENABLED: undefined };
    openPr({ ds: "nm000201", n: 12 });

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("off");
    expect(dispatches()).toHaveLength(0);
  });

  test("arguments are checked before the API is asked", async () => {
    expect((await cli([...START, "not-a-dataset", "12"])).exitCode).toBe(1);
    expect((await cli([...START, "nm000201", "twelve"])).exitCode).toBe(1);
    expect((await cli([...START])).exitCode).toBe(1);
    expect((await cli([...START, "nm000201", "12", "--all"])).exitCode).toBe(1);
    expect(gh.seen).toHaveLength(0);
  });

  test("--json prints the Worker's answer and nothing else on stdout", async () => {
    openPr({ ds: "nm000201", n: 12 });

    const r = await cli([...START, "nm000201", "12", "--json"]);

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      dispatched: true,
      reason: "dispatched",
      environment: "production",
    });
  });
});

/** Four open pull requests to start (one with a stale error to restart), one reviewed, one draft. */
function queue() {
  openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });
  openPr({ ds: "nm000202", n: 2, author: "bob", authorId: 43 });
  // Already reviewed: left alone.
  openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
  seedReview(db, {
    ds: "nm000203",
    n: 3,
    sha: SHA_A,
    authorId: 44,
    state: "reported",
    verdict: "pass",
  });
  // A review that ended in an error: started again.
  openPr({ ds: "nm000204", n: 4, author: "dave", authorId: 45 });
  seedReview(db, {
    ds: "nm000204",
    n: 4,
    sha: SHA_A,
    authorId: 45,
    state: "errored",
    detail: "workflow_failed",
  });
  // A draft: not reviewed.
  openPr({ ds: "nm000205", n: 5, author: "erin", authorId: 46, draft: true });
}

describe("nemar admin pr-reviews start --all", () => {
  test("starts every open pull request without a completed review, and only those", async () => {
    queue();

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatches()).toHaveLength(3);
    const byPr = (n: number) => rows().find((x) => x.pr_number === n);
    expect(byPr(1)).toMatchObject({ state: "dispatched" });
    expect(byPr(2)).toMatchObject({ state: "dispatched" });
    expect(byPr(4)).toMatchObject({ state: "dispatched", detail: null });
    expect(byPr(3)).toMatchObject({ state: "reported" });
    expect(byPr(5)).toBeUndefined();
    expect(r.stdout).toContain("nm000201 #1");
    expect(r.stdout).toContain("nm000204 #4");
    expect(r.stdout).not.toContain("nm000203 #3");
    // A draft is left out before GitHub is asked about it.
    expect(r.stdout).not.toContain("nm000205 #5");
    expect(gh.seen.some((x) => x.path.includes("/nm000205/pulls/"))).toBe(false);
    expect(r.stdout).toMatch(/3 started/);
    expect(r.stdout).toMatch(/1 draft/);
  });

  test("--dry-run lists what would be started and starts nothing", async () => {
    queue();

    const r = await cli([...START, "--all", "--dry-run"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000201 #1");
    expect(r.stdout).toContain("nm000202 #2");
    expect(r.stdout).toContain("nm000204 #4");
    expect(r.stdout).toContain("dry run");
    expect(dispatches()).toHaveLength(0);
    expect(gh.seen.filter((s) => s.path.includes("/pulls/"))).toHaveLength(0);
  });

  test("asks before spending, and a closed stdin is a no", async () => {
    queue();

    const r = await cli([...START, "--all"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("--yes");
    expect(dispatches()).toHaveLength(0);
  });

  test("a blocked contributor is asked about and declined by the Worker, with the way out", async () => {
    queue();
    db.run(
      "INSERT INTO pr_review_overrides (author_id, author_login, mode) VALUES (42, 'alice', 'block')",
    );

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000201 #1");
    expect(r.stdout).toContain("not started: the contributor is blocked by an administrator");
    expect(r.stdout).toContain("nemar admin pr-reviews allow alice");
    expect(dispatches()).toHaveLength(2);
    expect(rows().find((x) => x.pr_number === 1)).toMatchObject({
      state: "declined",
      detail: "contributor_paused",
    });
  });

  test("after the block is lifted, the stored decline is started by --all", async () => {
    queue();
    seedReview(db, {
      ds: "nm000201",
      n: 1,
      sha: SHA_A,
      authorId: 42,
      login: "alice",
      state: "declined",
      detail: "contributor_paused",
    });
    // `allow` changes the contributor's standing, not the rows already written.
    db.run(
      "INSERT INTO pr_review_overrides (author_id, author_login, mode) VALUES (42, 'alice', 'allow')",
    );

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatches()).toHaveLength(3);
    expect(rows().find((x) => x.pr_number === 1)).toMatchObject({ state: "dispatched" });
  });

  test("a decline from a limit that no longer exists is started", async () => {
    for (let i = 0; i < 3; i++) {
      seedReview(db, {
        ds: "nm000203",
        n: 100 + i,
        sha: `${i}`.repeat(40),
        authorId: 700,
        login: "stranger",
        state: "dispatched",
      });
    }
    openPr({ ds: "nm000201", n: 1, author: "stranger", authorId: 700, assoc: "NONE" });
    seedReview(db, {
      ds: "nm000201",
      n: 1,
      sha: SHA_A,
      authorId: 700,
      login: "stranger",
      state: "declined",
      detail: "rate_limited",
    });

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatches()).toHaveLength(1);
    expect(rows().find((x) => x.pr_number === 1)).toMatchObject({ state: "dispatched" });
  });

  test("does not stop for the old daily pool: 400 reviews today change nothing", async () => {
    queue();
    for (let i = 0; i < 400; i++) {
      seedReview(db, {
        ds: "nm000203",
        n: 1000 + i,
        sha: `${i}`.padStart(40, "b"),
        authorId: 20_000 + i,
        state: "reported",
        verdict: "pass",
        // Inside the day the pool used to be counted over (a result seeded without a date is old).
        createdAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      });
    }

    const r = await cli([...START, "--all", "--yes"]);

    // Every one of the three is started, and nothing says some were not tried.
    expect(r.exitCode).toBe(0);
    expect(dispatches()).toHaveLength(3);
    expect(r.stdout).toMatch(/3 started/);
    expect(r.stdout).not.toContain("not tried");
    expect(r.stdout).not.toContain("daily");
  });

  test("a pull request that cannot be read is counted and the run goes on", async () => {
    queue();
    // The first one listed, so a run that stopped at the first failure would start none.
    Reflect.deleteProperty(gh.pulls, "nm000204#4");

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/1 failed/);
    expect(dispatches()).toHaveLength(2);
  });

  test("the review being off says so before anything else", async () => {
    envOverrides = { PR_REVIEW_ENABLED: undefined };
    queue();

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("off");
    expect(dispatches()).toHaveLength(0);
  });

  test("nothing to start is said, and is not an error", async () => {
    openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
    seedReview(db, {
      ds: "nm000203",
      n: 3,
      sha: SHA_A,
      authorId: 44,
      state: "reported",
      verdict: "pass",
    });

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Nothing to start: no open pull request is waiting for a review");
  });

  test("a list GitHub cut short is not called complete", async () => {
    openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
    seedReview(db, {
      ds: "nm000203",
      n: 3,
      sha: SHA_A,
      authorId: 44,
      state: "reported",
      verdict: "pass",
    });
    // GitHub's search says it has more than it returned.
    gh.searchPages = [gh.searchPages[0] ?? [], []];
    gh.searchTotal = 1500;

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.stdout).not.toContain("Nothing to start: no open pull request is waiting");
    expect(r.stdout).toContain("incomplete");
  });

  test("--json prints one result per pull request", async () => {
    queue();

    const r = await cli([...START, "--all", "--yes", "--json"]);

    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.results).toHaveLength(3);
    // The pool stop is gone, and so is the count of what it left untried.
    expect(out).not.toHaveProperty("not_tried");
    expect(out.results.every((x: { dispatched: boolean }) => x.dispatched)).toBe(true);
    expect(out.results.map((x: { reason: string }) => x.reason).sort()).toEqual([
      "dispatched",
      "dispatched",
      "redispatched",
    ]);
    expect(out.failed).toBe(0);
  });
});

describe("a commit capped by too many edits is started by name, never by --all", () => {
  /** One pull request whose review was refused at the cap, and an ordinary one waiting to be started. */
  function cappedAndOrdinary() {
    openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });
    seedReview(db, {
      ds: "nm000201",
      n: 1,
      sha: SHA_A,
      authorId: 42,
      state: "errored",
      detail: "edit_limit",
    });
    db.run("UPDATE pr_reviews SET edit_restarts = 5");
    openPr({ ds: "nm000202", n: 2, author: "bob", authorId: 43 });
  }

  test("--all leaves the capped commit out, says how to start it, and does not touch its row", async () => {
    cappedAndOrdinary();
    const before = rows().find((x) => x.pr_number === 1);

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    // Only the ordinary one was started, and the capped row is exactly as it was: still capped,
    // with its count, so a bulk start did not lift the cap.
    expect(dispatches()).toHaveLength(1);
    expect(rows().find((x) => x.pr_number === 1)).toEqual(before);
    expect(rows().find((x) => x.pr_number === 1)).toMatchObject({
      state: "errored",
      detail: "edit_limit",
      edit_restarts: 5,
    });
    expect(r.stdout).toMatch(/1 started/);
    // The list says which one is capped, why it is not started, and how to start it.
    expect(r.stdout).toContain("1 left out, capped by too many edits");
    expect(r.stdout).toContain("nm000201 #1");
    expect(r.stdout).toContain(
      "nm000201 #1  alice  capped: nemar admin pr-reviews start nm000201 1",
    );
    expect(r.stdout).toContain("lifts the cap");
  });

  test("--all with only a capped commit has nothing to start, and --json names it", async () => {
    openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });
    seedReview(db, {
      ds: "nm000201",
      n: 1,
      sha: SHA_A,
      authorId: 42,
      state: "errored",
      detail: "edit_limit",
    });

    const text = await cli([...START, "--all", "--yes"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Nothing to start");
    expect(text.stdout).toContain("capped: nemar admin pr-reviews start nm000201 1");
    expect(dispatches()).toHaveLength(0);

    const json = await cli([...START, "--all", "--dry-run", "--json"]);
    expect(json.exitCode).toBe(0);
    const out = JSON.parse(json.stdout);
    // Nothing is waiting, so the document is the empty result, and it still names what was left out.
    expect(out.results).toEqual([]);
    expect(out.capped).toEqual([{ dataset_id: "nm000201", pr_number: 1, author_login: "alice" }]);
  });

  test("started by name, it starts the review again and begins the count again", async () => {
    cappedAndOrdinary();

    const r = await cli([...START, "nm000201", "1"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("started again");
    expect(rows().find((x) => x.pr_number === 1)).toMatchObject({
      state: "dispatched",
      detail: null,
      edit_restarts: 0,
    });
    expect(dispatches()).toHaveLength(1);
  });

  test("the help says so", async () => {
    const r = await cli([...START, "--help-all"]);
    expect(r.stdout).toContain("left out of --all");
    expect(r.stdout).toContain("start it");
    expect(r.stdout).toContain("by name, which starts its review and lifts the cap");
  });
});

describe("nemar admin pr-reviews start --all --json", () => {
  test("a dry run lists what it would start, in the JSON too", async () => {
    openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });
    openPr({ ds: "nm000205", n: 5, author: "erin", authorId: 46, draft: true });

    const r = await cli([...START, "--all", "--dry-run", "--json"]);

    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.dry_run).toBe(true);
    expect(out.would_start).toEqual([
      expect.objectContaining({ dataset_id: "nm000201", pr_number: 1, author_login: "alice" }),
    ]);
    expect(out.drafts).toBe(1);
    expect(dispatches()).toHaveLength(0);
  });

  test("a pull request that failed is in the results with its error, not only in a count", async () => {
    openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });
    openPr({ ds: "nm000202", n: 2, author: "bob", authorId: 43 });
    Reflect.deleteProperty(gh.pulls, "nm000202#2");

    const r = await cli([...START, "--all", "--yes", "--json"]);

    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.failed).toBe(1);
    expect(out.results).toHaveLength(2);
    expect(out.results.find((x: { pr_number: number }) => x.pr_number === 2)).toMatchObject({
      dataset_id: "nm000202",
      error: "no_such_pull_request",
    });
  });

  test("declining the prompt prints no text on stdout", async () => {
    openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });

    const r = await cli([...START, "--all", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe("");
    expect(dispatches()).toHaveLength(0);
  });
});

describe("what must not start anything, and what a refused dispatch is", () => {
  test("a single start refuses --dry-run, which would spend a model call", async () => {
    openPr({ ds: "nm000201", n: 12 });

    const r = await cli([...START, "nm000201", "12", "--dry-run"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("--dry-run goes with --all");
    expect(gh.seen).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  test("--dry-run wins over --yes", async () => {
    queue();

    const r = await cli([...START, "--all", "--dry-run", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatches()).toHaveLength(0);
    // Only the two rows the fixture seeded: nothing was recorded, nothing was restarted.
    expect(rows().map((x) => [x.pr_number, x.state])).toEqual([
      [3, "reported"],
      [4, "errored"],
    ]);
  });

  test("--all with a dataset given is refused", async () => {
    queue();

    const r = await cli([...START, "nm000201", "--all", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(dispatches()).toHaveLength(0);
  });

  test("a dispatch GitHub refuses is a failure with a word, single", async () => {
    gh.dispatchStatus = 500;
    openPr({ ds: "nm000201", n: 12 });

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("did not accept the dispatch");
    expect(rows()[0]).toMatchObject({ state: "errored", detail: "dispatch_failed" });
  });

  test("a dispatch GitHub refuses is a failure in the JSON too", async () => {
    gh.dispatchStatus = 500;
    openPr({ ds: "nm000201", n: 12 });

    const r = await cli([...START, "nm000201", "12", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ dispatched: false, reason: "dispatch_failed" });
  });

  test("--all exits 1 when GitHub refused a dispatch, and the next start tries again", async () => {
    gh.dispatchStatus = 500;
    openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });

    const refused = await cli([...START, "--all", "--yes"]);

    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("did not accept the dispatch");

    gh.dispatchStatus = 204;
    const again = await cli([...START, "--all", "--yes"]);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/1 started/);
    expect(rows()[0]).toMatchObject({ state: "dispatched", detail: null });
  });

  test("a commit that was restarted reads as started again", async () => {
    openPr({ ds: "nm000204", n: 4, author: "dave", authorId: 45 });
    seedReview(db, {
      ds: "nm000204",
      n: 4,
      sha: SHA_A,
      authorId: 45,
      state: "errored",
      detail: "workflow_failed",
    });

    const r = await cli([...START, "nm000204", "4"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("started again");
  });

  test("a review that is running is not offered, and one handed over long ago is", async () => {
    openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
    seedReview(db, { ds: "nm000203", n: 3, sha: SHA_A, authorId: 44, state: "dispatched" });

    const running = await cli([...START, "--all", "--yes"]);

    expect(running.stdout).toContain("Nothing to start");
    expect(dispatches()).toHaveLength(0);

    db.run("UPDATE pr_reviews SET created_at = '2026-10-01 00:00:00'");
    const overdue = await cli([...START, "--all", "--yes"]);

    // What the list offers is what the start takes: no "already has a review" for an offered row.
    expect(overdue.exitCode).toBe(0);
    expect(overdue.stdout).toMatch(/1 started/);
    expect(overdue.stdout).not.toContain("already has a review");
    expect(dispatches()).toHaveLength(1);
  });
});

describe("nemar admin pr-reviews start --redo", () => {
  /** A finished review of the current commit, and a pull request still waiting for one. */
  function finishedAndWaiting() {
    openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
    seedReview(db, {
      ds: "nm000203",
      n: 3,
      sha: SHA_A,
      authorId: 44,
      state: "reported",
      verdict: "pass",
    });
    openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });
  }

  test("by name: a finished review is left alone without --redo and started again with it, on the same row", async () => {
    finishedAndWaiting();
    const before = rows().find((x) => x.pr_number === 3);

    const plain = await cli([...START, "nm000203", "3"]);
    expect(plain.stdout).toContain("already has a review");
    expect(dispatches()).toHaveLength(0);

    const r = await cli([...START, "nm000203", "3", "--redo"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("started again");
    expect(dispatches()).toHaveLength(1);
    expect(rows().find((x) => x.pr_number === 3)).toMatchObject({
      id: before?.id,
      state: "dispatched",
      verdict: null,
      attempts: 2,
    });
  });

  test("by name: a review that is running says so, and nothing is started", async () => {
    openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
    seedReview(db, { ds: "nm000203", n: 3, sha: SHA_A, authorId: 44, state: "dispatched" });

    const r = await cli([...START, "nm000203", "3", "--redo"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "a review of this commit is running, and a redo waits until it reports",
    );
    expect(dispatches()).toHaveLength(0);
  });

  test("by name, --json carries redo and the Worker's word", async () => {
    finishedAndWaiting();

    const r = await cli([...START, "nm000203", "3", "--redo", "--json"]);

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      dispatched: true,
      reason: "redispatched",
      redo: true,
    });
  });

  test("--all does not offer the finished review, --all --redo --dry-run does, and neither starts anything", async () => {
    finishedAndWaiting();

    const plain = await cli([...START, "--all", "--dry-run"]);
    expect(plain.stdout).toContain("nm000201 #1");
    expect(plain.stdout).not.toContain("nm000203 #3");

    const r = await cli([...START, "--all", "--redo", "--dry-run"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000201 #1");
    expect(r.stdout).toContain("nm000203 #3");
    expect(r.stdout).toContain("2 pull requests to start or redo (1 with a finished review");
    expect(r.stdout).toContain("dry run");
    expect(dispatches()).toHaveLength(0);
  });

  test("--all --redo leaves out a draft, a review in progress and a commit capped by edits", async () => {
    finishedAndWaiting();
    openPr({ ds: "nm000205", n: 5, author: "erin", authorId: 46, draft: true });
    openPr({ ds: "nm000202", n: 2, author: "bob", authorId: 43 });
    seedReview(db, { ds: "nm000202", n: 2, sha: SHA_A, authorId: 43, state: "dispatched" });
    openPr({ ds: "nm000204", n: 4, author: "dave", authorId: 45 });
    seedReview(db, {
      ds: "nm000204",
      n: 4,
      sha: SHA_A,
      authorId: 45,
      state: "errored",
      detail: "edit_limit",
    });
    db.run("UPDATE pr_reviews SET edit_restarts = 5 WHERE pr_number = 4");

    const r = await cli([...START, "--all", "--redo", "--dry-run", "--json"]);

    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      redo: boolean;
      would_start: Array<{ dataset_id: string; pr_number: number }>;
      capped: Array<{ pr_number: number }>;
    };
    expect(out.redo).toBe(true);
    expect(out.would_start.map((e) => e.pr_number).sort()).toEqual([1, 3]);
    expect(out.capped.map((e) => e.pr_number)).toEqual([4]);
  });

  test("--all --redo asks before spending, and a closed stdin is a no", async () => {
    finishedAndWaiting();

    const r = await cli([...START, "--all", "--redo"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("--yes");
    expect(dispatches()).toHaveLength(0);
  });

  test("--all --redo --yes starts the waiting one and redoes the finished one", async () => {
    finishedAndWaiting();

    const r = await cli([...START, "--all", "--redo", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatches()).toHaveLength(2);
    expect(r.stdout).toMatch(/2 started/);
    expect(rows().find((x) => x.pr_number === 3)).toMatchObject({
      state: "dispatched",
      verdict: null,
      attempts: 2,
    });
    expect(rows().find((x) => x.pr_number === 1)).toMatchObject({ state: "dispatched" });
  });

  test("--dry-run goes with --all, redo or not", async () => {
    const r = await cli([...START, "nm000203", "3", "--redo", "--dry-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("--dry-run goes with --all");
  });

  test("the help describes --redo, its cost and that a running review is not touched", async () => {
    const r = await cli([...START, "--help-all"]);
    expect(r.exitCode).toBe(0);
    const help = r.stdout.replace(/\s+/g, " ");
    expect(help).toContain("--redo");
    expect(help).toContain("is never started again, so a redo waits for it");
    expect(help).toContain("A blocked contributor's pull request is not redone");
    expect(help).toContain("A redo leaves the count of edits as it is");
    expect(help).toContain("costs a second run of up to two model calls");
    expect(help).toContain("cannot be resumed");
  });

  test("--dry-run marks the finished reviews, in the text and in the JSON, and only under --redo", async () => {
    finishedAndWaiting();
    // A fail and an uncertain review are finished too.
    openPr({ ds: "nm000202", n: 2, author: "bob", authorId: 43 });
    seedReview(db, {
      ds: "nm000202",
      n: 2,
      sha: SHA_A,
      authorId: 43,
      state: "reported",
      verdict: "fail",
    });
    openPr({ ds: "nm000204", n: 4, author: "dave", authorId: 45 });
    seedReview(db, {
      ds: "nm000204",
      n: 4,
      sha: SHA_A,
      authorId: 45,
      state: "reported",
      verdict: "uncertain",
    });

    const text = await cli([...START, "--all", "--redo", "--dry-run"]);
    expect(text.stdout).toMatch(/nm000203 #3 .*finished: pass/);
    expect(text.stdout).toMatch(/nm000202 #2 .*finished: fail/);
    expect(text.stdout).toMatch(/nm000204 #4 .*finished: uncertain/);
    expect(text.stdout).not.toMatch(/nm000201 #1 .*finished/);

    const json = await cli([...START, "--all", "--redo", "--dry-run", "--json"]);
    const out = JSON.parse(json.stdout) as {
      would_start: Array<{ pr_number: number; verdict?: string }>;
    };
    expect(out.would_start.find((e) => e.pr_number === 3)?.verdict).toBe("pass");
    expect(out.would_start.find((e) => e.pr_number === 2)?.verdict).toBe("fail");
    expect(out.would_start.find((e) => e.pr_number === 4)?.verdict).toBe("uncertain");
    expect(out.would_start.find((e) => e.pr_number === 1)?.verdict).toBe("not_reviewed");

    const plain = await cli([...START, "--all", "--dry-run", "--json"]);
    const plainOut = JSON.parse(plain.stdout) as { would_start: Array<Record<string, unknown>> };
    expect(plainOut.would_start.every((e) => !("verdict" in e))).toBe(true);
  });

  describe("a Worker that predates --redo ignores the flag, and the command says so", () => {
    let old: ReturnType<typeof Bun.serve>;
    let startCalls = 0;
    /** What the older Worker answers to a start: it never echoes `redo`. */
    let answer: { dispatched: boolean; reason: string } = {
      dispatched: false,
      reason: "duplicate",
    };
    beforeAll(() => {
      // The real router answers every read; only the start is the older Worker's.
      old = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/notices") return Response.json({ notices: [] });
          if (url.pathname === "/datasets/facets") return Response.json({});
          if (req.method === "POST" && url.pathname.endsWith("/start")) {
            startCalls++;
            return Response.json({
              environment: "production",
              review_id: 1,
              author_login: null,
              ...answer,
            });
          }
          return handle(req, env());
        },
      });
    });
    afterAll(() => old.stop(true));
    beforeEach(() => {
      startCalls = 0;
      answer = { dispatched: false, reason: "duplicate" };
    });
    const oldUrl = () => `http://127.0.0.1:${old.port}`;

    test("by name, a finished review: what the Worker said, then the explanation, exit 1, no bug-report hint", async () => {
      finishedAndWaiting();
      const r = await cli([...START, "nm000203", "3", "--redo"], oldUrl());
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("already has a review");
      expect(r.stdout).toContain("This Worker does not know --redo yet");
      expect(r.stdout + r.stderr).not.toContain("--debug");
    });

    test("by name, a commit with no review: the start the Worker made is reported, not hidden", async () => {
      answer = { dispatched: true, reason: "dispatched" };
      const r = await cli([...START, "nm000201", "1", "--redo"], oldUrl());
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("started");
      expect(r.stdout).toContain("This Worker does not know --redo yet");
      expect(r.stdout + r.stderr).not.toContain("--debug");
    });

    test("by name, --json keeps the Worker's answer and adds redo_ignored", async () => {
      answer = { dispatched: true, reason: "dispatched" };
      const r = await cli([...START, "nm000201", "1", "--redo", "--json"], oldUrl());
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({
        dispatched: true,
        reason: "dispatched",
        redo_ignored: true,
      });
    });

    test("--all --redo stops after the first answer, reports it, and says how many were not tried", async () => {
      finishedAndWaiting();
      const r = await cli([...START, "--all", "--redo", "--yes"], oldUrl());
      expect(r.exitCode).toBe(1);
      expect(startCalls).toBe(1);
      expect(r.stdout).toMatch(/already had a review|not started/);
      expect(r.stdout).toContain("This Worker does not know --redo yet");
      expect(r.stdout).toContain("1 pull request was not tried");
      expect(r.stdout + r.stderr).not.toContain("--debug");
    });

    test("by name, an older Worker's fault is reported with the ignored flag, and keeps its own hint", async () => {
      answer = { dispatched: false, reason: "dispatch_failed" };
      const r = await cli([...START, "nm000201", "1", "--redo"], oldUrl());
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GitHub did not accept the dispatch");
      expect(r.stdout).toContain("This Worker does not know --redo yet");
    });

    test("--all --redo with one entry does not say that 0 pull requests were not tried", async () => {
      openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
      seedReview(db, {
        ds: "nm000203",
        n: 3,
        sha: SHA_A,
        authorId: 44,
        state: "reported",
        verdict: "pass",
      });
      const r = await cli([...START, "--all", "--redo", "--yes"], oldUrl());
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("This Worker does not know --redo yet");
      expect(r.stdout).not.toContain("not tried");
    });

    test("--all --redo --json prints the one document with the answer it got and redo_ignored", async () => {
      finishedAndWaiting();
      const r = await cli([...START, "--all", "--redo", "--yes", "--json"], oldUrl());
      expect(r.exitCode).toBe(1);
      expect(startCalls).toBe(1);
      const out = JSON.parse(r.stdout) as { redo_ignored: boolean; results: unknown[] };
      expect(out.redo_ignored).toBe(true);
      expect(out.results).toHaveLength(1);
    });
  });
});
