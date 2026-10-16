/**
 * The administrator's pull-request review queue, end to end through the real admin routes
 * (ADR 0093, following ADR 0092).
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real Hono admin
 * router with its real auth middleware and a real hashed token, and GitHub as a `Bun.serve()`
 * stand-in for api.github.com (NEMAR_GITHUB_API_URL) that speaks the GraphQL search and the REST
 * calls the queue makes and records each request it receives.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import type {
  ClearOverrideResponse,
  ContributorStanding,
  PrReviewDetail,
  QueueResponse,
  SetOverrideResponse,
  VolumeWindow,
} from "../../shared/contract/pr-review-admin";
import { renderCheck } from "../../shared/pr-review";
import { adminRoutes } from "../src/routes/admin";
import {
  __resetRateLimitStateForTests,
  __seedRateLimitStateForTests,
} from "../src/services/github/transport";
import { handlePullRequestEvent } from "../src/services/pr-review";
import { REVIEW_EXEMPT_SQL } from "../src/services/pr-review-exemption";
import {
  __setExemptLookupBudgetForTests,
  __setGraphqlTimeoutForTests,
  checkStateOf,
  classify,
  filterQueue,
  readCheckContext,
  readVolume,
  sortQueue,
} from "../src/services/pr-review-queue";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";
import {
  type PermissionAnswer,
  isPermissionPath,
  permissionResponse,
} from "./helpers/github-permission";
import { projectOnto } from "./helpers/graphql-select";
import {
  type PrSpec,
  SHA_A,
  SHA_B,
  SHA_C,
  bidsOk,
  goodReport,
  prNode,
  seedReview as seedReviewRow,
  versionOk,
} from "./helpers/pr-queue-fixtures";

const ADMIN_KEY = "queue-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "queue-member-key-0123456789abcdef0123456789abcdef";
const PAT = "ghp_queue_test_token";

// ---------------------------------------------------------------------------------------------
// The GitHub stand-in
// ---------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

let server: Server;
let calls: Recorded[] = [];
/** Pages of search nodes, in order; the cursor is the index of the next page. */
let searchPages: unknown[][] = [];
let issueCount: number | null = null;
/** The `issueCount` each page reports, when a test needs it to change between pages. */
let pageCounts: number[] | null = null;
let graphqlResponder: ((attempt: number) => Response | null | Promise<Response | null>) | null =
  null;
let graphqlAttempts = 0;
let usersById: Record<string, { id: number; login: string; type: string } | number> = {};
let pulls: Record<string, Record<string, unknown> | number> = {};
/** What GitHub says each login holds on a repository (see helpers/github-permission.ts). */
let permissions: Record<string, PermissionAnswer> = {};
/** How many permission questions were being answered at once, now and at most. */
let permissionInFlight = 0;
let permissionMaxInFlight = 0;

/** A failing answer that tells the retry transport not to wait, so a test of a failure is not slow. */
function failing(status: number): Response {
  return new Response("{}", { status, headers: { "Retry-After": "0" } });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as never);
      calls.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization"),
        body,
      });
      if (req.method === "POST" && url.pathname === "/graphql") {
        graphqlAttempts++;
        const forced = await graphqlResponder?.(graphqlAttempts);
        if (forced) return forced;
        const after = (body as { variables?: { after?: string | null } } | null)?.variables?.after;
        const index = after ? Number(after) : 0;
        const nodes = searchPages[index] ?? [];
        const seen = searchPages.flat().length;
        // Only what the query asks for, as GitHub sends it: a field dropped from the query is a
        // field the reader never sees.
        return Response.json({
          data: projectOnto(String((body as { query?: unknown } | null)?.query ?? ""), {
            search: {
              issueCount: pageCounts?.[index] ?? issueCount ?? seen,
              pageInfo: {
                hasNextPage: index + 1 < searchPages.length,
                endCursor: String(index + 1),
              },
              nodes,
            },
          }),
        });
      }
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        return new Response(null, { status: 204 });
      }
      const user = url.pathname.match(/^\/users\/([^/]+)$/);
      if (req.method === "GET" && user) {
        const hit = usersById[user[1].toLowerCase()];
        if (typeof hit === "number") return failing(hit);
        return hit ? Response.json(hit) : new Response("{}", { status: 404 });
      }
      const pull = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/pulls\/(\d+)$/);
      if (req.method === "GET" && pull) {
        const hit = pulls[`${pull[1]}#${pull[2]}`];
        if (typeof hit === "number") return failing(hit);
        return hit ? Response.json(hit) : new Response("{}", { status: 404 });
      }
      if (req.method === "GET" && isPermissionPath(url.pathname)) {
        permissionInFlight++;
        permissionMaxInFlight = Math.max(permissionMaxInFlight, permissionInFlight);
        try {
          return (
            (await permissionResponse(url, permissions)) ?? new Response("{}", { status: 404 })
          );
        } finally {
          permissionInFlight--;
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

// ---------------------------------------------------------------------------------------------
// Worker, database, seeds
// ---------------------------------------------------------------------------------------------

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let envOverrides: Partial<Bindings> = {};
let adminId = 0;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: PAT,
    PR_REVIEW_ENABLED: "1",
    ...envOverrides,
  } as Bindings;
}

async function seedUser(username: string, role: string, status: string, key: string) {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (?, ?, 'x', ?, ?, ?, 'cli', 1, 0)`,
    [username, `${username}@example.org`, `${username}-gh`, status, role],
  );
  const row = db.query("SELECT id FROM users WHERE username = ?").get(username) as { id: number };
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedUser("queueadmin", "admin", "approved", ADMIN_KEY);
  await seedUser("queuemember", "member", "verified", MEMBER_KEY);
  __resetRateLimitStateForTests();
});

afterEach(() => {
  calls = [];
  searchPages = [];
  issueCount = null;
  pageCounts = null;
  graphqlResponder = null;
  graphqlAttempts = 0;
  usersById = {};
  pulls = {};
  permissions = {};
  permissionInFlight = 0;
  permissionMaxInFlight = 0;
  __setExemptLookupBudgetForTests(null);
  envOverrides = {};
  __resetRateLimitStateForTests();
});

async function get(path: string, key = ADMIN_KEY) {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${key}` } }, env());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function send(method: "PUT" | "DELETE", path: string, payload?: unknown, key = ADMIN_KEY) {
  const res = await app.request(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const queue = async (qs = "") => {
  const r = await get(`/admin/pr-reviews${qs}`);
  return { status: r.status, body: r.body as unknown as QueueResponse };
};

/** What the webhook would hand the review for an opened pull request. */
function openPullRequest(authorId: number, login: string, number: number, headSha: string) {
  return handlePullRequestEvent(
    { ...env(), PRESCREEN_CALLBACK_SECRET: "queue-test-callback-secret" } as Bindings,
    {
      action: "opened",
      number,
      repository: {
        name: "nm000301",
        full_name: "nemarDatasets/nm000301",
        owner: { login: "nemarDatasets" },
      },
      pull_request: {
        number,
        state: "open",
        draft: false,
        merged: false,
        author_association: "COLLABORATOR",
        user: { id: authorId, login, type: "User" },
        base: { ref: "main" },
        head: { sha: headSha, repo: { full_name: "nemarDatasets/nm000301" } },
      },
    },
  );
}

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

const seedReview = (r: Parameters<typeof seedReviewRow>[1]) => seedReviewRow(db, r);

const nodes = (...specs: PrSpec[]) => {
  searchPages = [specs.map(prNode)];
};

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

describe("the pure rules", () => {
  test("the newest run of a re-run check wins, and a missing check is only missing if the list was whole", () => {
    const failed = readCheckContext({
      __typename: "CheckRun",
      name: "version-check",
      status: "COMPLETED",
      conclusion: "FAILURE",
      startedAt: "2026-10-01T00:00:00Z",
    });
    const passed = readCheckContext({
      __typename: "CheckRun",
      name: "version-check",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-10-01T01:00:00Z",
    });
    expect(
      checkStateOf(
        [passed, failed].filter((x) => x !== null),
        ["version-check"],
        true,
      ),
    ).toBe("pass");
    expect(checkStateOf([], ["version-check"], true)).toBe("missing");
    expect(checkStateOf([], ["version-check"], false)).toBe("unknown");
  });

  test("only SUCCESS is a pass; neutral, skipped and an unknown shape are not", () => {
    const run = (conclusion: string | null, status = "COMPLETED") =>
      readCheckContext({ __typename: "CheckRun", name: "x", status, conclusion })?.state;
    expect(run("SUCCESS")).toBe("pass");
    expect(run("NEUTRAL")).toBe("unknown");
    expect(run("SKIPPED")).toBe("unknown");
    expect(run("TIMED_OUT")).toBe("fail");
    expect(run("CANCELLED")).toBe("fail");
    expect(run(null, "IN_PROGRESS")).toBe("pending");
    expect(
      readCheckContext({ __typename: "StatusContext", context: "x", state: "EXPECTED" })?.state,
    ).toBe("pending");
    expect(readCheckContext({ __typename: "Mystery" })).toBeNull();
  });

  test("a verdict is never carried over to a commit it did not read", () => {
    const row = {
      id: 1,
      dataset_id: "nm000201",
      pr_number: 1,
      head_sha: SHA_A,
      author_id: 1,
      author_login: "x",
      from_fork: 0,
      state: "reported",
      verdict: "pass",
      detail: null,
      created_at: "",
      decided_at: null,
    };
    expect(classify(row, SHA_A).verdict).toBe("pass");
    const stale = classify(row, SHA_B);
    expect(stale.verdict).toBe("not_reviewed");
    expect(stale.review_current).toBe(false);
    expect(stale.stale_verdict).toBe("pass");
    expect(classify(null, SHA_A)).toMatchObject({ verdict: "not_reviewed", review_current: null });
    // With no head to compare against, nothing is asserted about the current commit: the stored
    // verdict rides along as what the review concluded of ITS commit, and currency is unknown.
    const unknownHead = classify(row, null);
    expect(unknownHead).toMatchObject({
      verdict: "not_reviewed",
      review_current: null,
      reviewed_sha: SHA_A,
      stale_verdict: "pass",
    });
    // An older review that gave no verdict has no verdict to carry.
    expect(classify({ ...row, state: "declined", verdict: null }, SHA_B).stale_verdict).toBeNull();
    // A column nobody can stand behind is "could not decide", not a pass.
    expect(classify({ ...row, verdict: "great" }, SHA_A).verdict).toBe("could_not_decide");
  });

  test("filters compose, and an author matches regardless of case", () => {
    const base = {
      dataset_id: "nm000201",
      pr_number: 1,
      author_login: "Alice",
      draft: false,
      needs_you: true,
      verdict: "pass",
    };
    const entries = [
      base,
      { ...base, pr_number: 2, verdict: "fail", needs_you: false },
      { ...base, pr_number: 3, author_login: "bob" },
    ] as never[];
    const none = { verdicts: [], dataset: null, author: null, needs_me: false };
    expect(filterQueue(entries, { ...none, author: "alice" })).toHaveLength(2);
    expect(filterQueue(entries, { ...none, needs_me: true })).toHaveLength(2);
    expect(filterQueue(entries, { ...none, verdicts: ["fail"] })).toHaveLength(1);
    expect(filterQueue(entries, { ...none, verdicts: ["pass"], author: "bob" })).toHaveLength(1);
  });

  test("sorting puts a draft last, whatever its verdict", () => {
    const e = (over: Record<string, unknown>) =>
      ({
        dataset_id: "nm000201",
        pr_number: 1,
        created_at: "2026-10-01T00:00:00Z",
        bids: "pass",
        version: "pass",
        draft: false,
        verdict: "pass",
        ...over,
      }) as never;
    const sorted = sortQueue([
      e({ pr_number: 1, draft: true, verdict: "pass" }),
      e({ pr_number: 2, verdict: "fail" }),
    ]) as Array<{ pr_number: number }>;
    expect(sorted.map((x) => x.pr_number)).toEqual([2, 1]);
  });
});

// ---------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------

describe("GET /admin/pr-reviews", () => {
  test("joins every open pull request with its latest review, ordered so what you can act on is first", async () => {
    nodes(
      { ds: "nm000201", n: 1, created: "2026-10-03T00:00:00Z" }, // pass
      { ds: "nm000202", n: 2, created: "2026-10-03T00:00:00Z" }, // fail
      { ds: "nm000203", n: 3, created: "2026-10-03T00:00:00Z" }, // uncertain
      { ds: "nm000204", n: 4, created: "2026-10-02T00:00:00Z" }, // no row
      { ds: "nm000205", n: 5, created: "2026-10-03T00:00:00Z" }, // in progress
      { ds: "nm000206", n: 6, created: "2026-10-03T00:00:00Z" }, // errored
      { ds: "nm000207", n: 7, created: "2026-10-01T00:00:00Z" }, // declined
      { ds: "nm000208", n: 8, created: "2026-10-03T00:00:00Z" }, // reviewed an older commit
      { ds: "nm000209", n: 9, created: "2026-09-01T00:00:00Z", draft: true }, // draft
    );
    seedReview({ ds: "nm000201", n: 1, state: "reported", verdict: "pass" });
    seedReview({ ds: "nm000202", n: 2, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000203", n: 3, state: "reported", verdict: "uncertain" });
    seedReview({ ds: "nm000205", n: 5, state: "dispatched" });
    seedReview({ ds: "nm000206", n: 6, state: "errored", detail: "model_unavailable" });
    seedReview({ ds: "nm000207", n: 7, state: "declined", detail: "contributor_paused" });
    seedReview({ ds: "nm000208", n: 8, sha: SHA_B, state: "reported", verdict: "pass" });

    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.environment).toBe("production");
    expect(body.review_enabled).toBe(true);
    expect(body.total_open).toBe(9);
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e]));

    expect(by.nm000201).toMatchObject({ verdict: "pass", needs_you: true, review_current: true });
    expect(by.nm000202).toMatchObject({ verdict: "fail", needs_you: false });
    expect(by.nm000203.verdict).toBe("uncertain");
    expect(by.nm000204).toMatchObject({
      verdict: "not_reviewed",
      detail: null,
      review_current: null,
    });
    expect(by.nm000205).toMatchObject({ verdict: "in_progress", needs_you: false });
    expect(by.nm000206).toMatchObject({ verdict: "could_not_decide", detail: "model_unavailable" });
    expect(by.nm000207).toMatchObject({ verdict: "not_reviewed", detail: "contributor_paused" });
    expect(by.nm000208).toMatchObject({
      verdict: "not_reviewed",
      review_current: false,
      reviewed_sha: SHA_B,
      stale_verdict: "pass",
    });
    expect(by.nm000209).toMatchObject({ draft: true, needs_you: false });

    // Pass, then a closer look, then could-not-decide, then not-reviewed (oldest first), then the
    // ones waiting on a machine or an author, and the draft after everything.
    expect(body.entries.map((e) => e.dataset_id)).toEqual([
      "nm000201",
      "nm000203",
      "nm000206",
      "nm000207",
      "nm000204",
      "nm000208",
      "nm000205",
      "nm000202",
      "nm000209",
    ]);
  });

  test("a pull request with no review row is not reviewed, and the review being off changes nothing about the list", async () => {
    nodes({ ds: "nm000201", n: 1 });
    envOverrides = { PR_REVIEW_ENABLED: undefined };
    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.review_enabled).toBe(false);
    expect(body.entries[0]).toMatchObject({ verdict: "not_reviewed", needs_you: true });
  });

  test("reports fork or branch, the author's id, and a link built from the dataset and number", async () => {
    nodes(
      { ds: "nm000201", n: 12, branch: "fix-readme", author: "alice", authorId: 42 },
      {
        ds: "nm000202",
        n: 3,
        forkOwner: "bobfork",
        branch: "add-subjects",
        author: "bob",
        authorId: 43,
      },
      { ds: "nm000203", n: 4, forkOwner: null, author: null },
    );
    const { body } = await queue();
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e]));
    expect(by.nm000201).toMatchObject({
      from_fork: false,
      head_label: "fix-readme",
      author_login: "alice",
      author_id: 42,
      url: "https://github.com/nemarDatasets/nm000201/pull/12",
    });
    expect(by.nm000202).toMatchObject({ from_fork: true, head_label: "bobfork:add-subjects" });
    // A deleted fork and a deleted account are named as such, not dropped or guessed.
    expect(by.nm000203).toMatchObject({
      from_fork: true,
      head_label: "(deleted fork):update-metadata",
      author_login: "(unknown)",
      author_id: null,
    });
  });

  test("reads BIDS validation and the version check from the required checks", async () => {
    nodes(
      { ds: "nm000201", n: 1 },
      {
        ds: "nm000202",
        n: 2,
        checks: [
          { ...bidsOk("nm000202"), conclusion: "FAILURE" },
          { ...versionOk, status: "IN_PROGRESS", conclusion: null },
        ],
      },
      { ds: "nm000203", n: 3, checks: null },
      { ds: "nm000204", n: 4, checks: [bidsOk("nm000204")], moreChecks: true },
      // A legacy inline repository names its BIDS check differently.
      { ds: "nm000103", n: 5, checks: [bidsOk("nm000103"), versionOk] },
      // A status (not a check run) posted under the same name counts the same way.
      {
        ds: "nm000205",
        n: 6,
        checks: [{ type: "status", name: "version-check", state: "FAILURE" }, bidsOk("nm000205")],
      },
    );
    const { body } = await queue();
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e]));
    expect([by.nm000201.bids, by.nm000201.version]).toEqual(["pass", "pass"]);
    expect([by.nm000202.bids, by.nm000202.version]).toEqual(["fail", "pending"]);
    expect([by.nm000203.bids, by.nm000203.version]).toEqual(["missing", "missing"]);
    // The list of checks was cut short, so an absent check is not known to be absent.
    expect([by.nm000204.bids, by.nm000204.version]).toEqual(["pass", "unknown"]);
    expect([by.nm000103.bids, by.nm000103.version]).toEqual(["pass", "pass"]);
    expect([by.nm000205.bids, by.nm000205.version]).toEqual(["pass", "fail"]);
  });

  test("filters by verdict, dataset, author and needs-me", async () => {
    nodes(
      { ds: "nm000201", n: 1, author: "Alice", authorId: 1 },
      { ds: "nm000202", n: 2, author: "bob", authorId: 2 },
      { ds: "nm000203", n: 3, author: "alice", authorId: 1 },
    );
    seedReview({ ds: "nm000201", n: 1, state: "reported", verdict: "pass" });
    seedReview({ ds: "nm000202", n: 2, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000203", n: 3, state: "reported", verdict: "uncertain" });

    expect((await queue("?verdict=fail")).body.entries.map((e) => e.dataset_id)).toEqual([
      "nm000202",
    ]);
    expect((await queue("?verdict=pass,uncertain")).body.entries).toHaveLength(2);
    expect((await queue("?verdict=could-not-decide")).body.entries).toHaveLength(0);
    expect((await queue("?dataset=nm000203")).body.entries).toHaveLength(1);
    expect((await queue("?author=ALICE")).body.entries).toHaveLength(2);
    expect((await queue("?needs_me=1")).body.entries.map((e) => e.dataset_id)).toEqual([
      "nm000201",
      "nm000203",
    ]);
    const filtered = await queue("?verdict=pass&author=alice&needs_me=true");
    expect(filtered.body.entries.map((e) => e.dataset_id)).toEqual(["nm000201"]);
    expect(filtered.body.total_open).toBe(3);

    for (const bad of ["?verdict=great", "?dataset=nm1", "?author=-bad-"]) {
      const r = await queue(bad);
      expect(r.status).toBe(400);
    }
  });

  test("searches the organisation once per page with the datasets token and reads pages one after another", async () => {
    searchPages = [
      [prNode({ ds: "nm000201", n: 1 }), prNode({ ds: "nm000202", n: 2 })],
      [prNode({ ds: "nm000203", n: 3 }), prNode({ ds: "nm000202", n: 2 })], // a repeat as pages shift
    ];
    issueCount = 3; // GitHub counts distinct pull requests
    const { body } = await queue();
    expect(body.entries.map((e) => e.dataset_id).sort()).toEqual([
      "nm000201",
      "nm000202",
      "nm000203",
    ]);
    expect(body.truncated).toBe(false);

    const searches = calls.filter((c) => c.path === "/graphql");
    expect(searches).toHaveLength(2);
    expect(searches.every((c) => c.auth === `Bearer ${PAT}`)).toBe(true);
    const vars = (searches[0].body as { variables: { q: string; after: unknown } }).variables;
    expect(vars.q).toBe("org:nemarDatasets is:pr is:open base:main");
    expect(vars.after).toBeNull();
    expect((searches[1].body as { variables: { after: string } }).variables.after).toBe("1");
    // Nothing else was needed: no call per pull request.
    expect(calls.filter((c) => c.path !== "/graphql")).toHaveLength(0);
  });

  test("says so when GitHub holds more results than were read", async () => {
    searchPages = [[prNode({ ds: "nm000201", n: 1 })]];
    issueCount = 1500;
    const { body } = await queue();
    expect(body.truncated).toBe(true);
    expect(body.entries).toHaveLength(1);
  });

  test("a pull request in a repository that is not a dataset is counted, not listed", async () => {
    searchPages = [
      [
        prNode({ ds: "nm000201", n: 1 }),
        {
          ...prNode({ ds: "nm000202", n: 2 }),
          repository: { name: ".github", owner: { login: "nemarDatasets" } },
        },
        prNode({ ds: "nm000203", n: 3, repoOwner: "someoneElse" }),
      ],
    ];
    const { body } = await queue();
    expect(body.entries).toHaveLength(1);
    expect(body.skipped.not_a_dataset).toBe(2);
    expect(body.truncated).toBe(false);
  });

  test("production leaves the dev Worker's datasets alone, and the dev Worker lists only its own", async () => {
    nodes(
      { ds: "nm000201", n: 1 },
      { ds: "xx090001", n: 2 }, // a dev ephemeral sandbox id
      { ds: "nm099998", n: 3 }, // the declared dev-owned fixture
    );
    const prod = await queue();
    expect(prod.body.entries.map((e) => e.dataset_id)).toEqual(["nm000201"]);
    expect(prod.body.skipped.not_owned_here).toBe(2);

    envOverrides = { ENVIRONMENT: "staging" };
    const dev = await queue();
    expect(dev.body.environment).toBe("non-production");
    expect(dev.body.entries.map((e) => e.dataset_id).sort()).toEqual(["nm099998", "xx090001"]);
    expect(dev.body.skipped.not_owned_here).toBe(1);
  });

  test("author-controlled text never reaches the response as markup, a mention, or a control character", async () => {
    const esc = String.fromCharCode(27);
    nodes({
      ds: "nm000201",
      n: 1,
      title: `${esc}[2J@everyone ![x](http://evil.test/a.png) <script>alert(1)</script> #12 hello`,
      branch: `feat/${esc}[31mred\u202eevil name;rm -rf`,
      forkOwner: "bob",
    });
    const res = await app.request(
      "/admin/pr-reviews",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    const raw = await res.text();
    expect(raw.includes(esc)).toBe(false);
    expect(raw.includes("\u202e")).toBe(false);
    const entry = (JSON.parse(raw) as QueueResponse).entries[0];
    // No mention, tag, issue reference, link or image survives; what is left is plain words.
    expect(entry.title).not.toMatch(/[@<>#[\]]|http/);
    expect(entry.title).toContain("hello");
    expect(entry.head_label).toMatch(/^[A-Za-z0-9._\-/:?…]+$/);
    expect(entry.url).toBe("https://github.com/nemarDatasets/nm000201/pull/1");
  });

  test("a pull request's body is never asked for, so it cannot be returned", async () => {
    nodes({ ds: "nm000201", n: 1, extra: { body: "@everyone SECRET-BODY-TEXT" } });
    const res = await app.request(
      "/admin/pr-reviews",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(await res.text()).not.toContain("SECRET-BODY-TEXT");
    const query = String(
      (calls.find((c) => c.path === "/graphql")?.body as { query: string }).query,
    );
    expect(query).not.toMatch(/\bbody\b/);
  });

  test("waits out a secondary rate limit and answers", async () => {
    nodes({ ds: "nm000201", n: 1 });
    graphqlResponder = (attempt) =>
      attempt === 1
        ? new Response('{"message":"You have exceeded a secondary rate limit."}', {
            status: 403,
            headers: { "Retry-After": "0" },
          })
        : null;
    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(graphqlAttempts).toBe(2);
  });

  test("a nearly spent REST budget does not stop the search: GraphQL spends a different one", async () => {
    nodes({ ds: "nm000201", n: 1 });
    // Publishing and the sweeps share this token and spend the `core` bucket; the search does not.
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 3,
      resetEpoch: Math.floor(Date.now() / 1000) + 600,
    });
    const r = await queue();
    expect(r.status).toBe(200);
    expect(r.body.entries).toHaveLength(1);
  });

  test("a spent GraphQL budget is a 503 that says so, not a vague failure", async () => {
    nodes({ ds: "nm000201", n: 1 });
    graphqlResponder = () =>
      Response.json({
        data: null,
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation" }],
      });
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("github_rate_limited");
    expect(String(r.body.error)).toContain("Try again later");
  });

  test("a GraphQL error fails the whole read: a partial queue that looks whole is worse than none", async () => {
    nodes({ ds: "nm000201", n: 1 });
    graphqlResponder = () =>
      Response.json({
        data: {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [prNode({ ds: "nm000201", n: 1 })],
          },
        },
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
      });
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("github_graphql_error");
    expect(r.body.entries).toBeUndefined();
  });

  test("GitHub refusing the search is a 502, not an empty queue", async () => {
    graphqlResponder = () => new Response("{}", { status: 500, headers: { "Retry-After": "0" } });
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("github_refused");
  });

  test("is admin-only", async () => {
    nodes({ ds: "nm000201", n: 1 });
    expect((await get("/admin/pr-reviews", MEMBER_KEY)).status).toBe(403);
    const anonymous = await app.request("/admin/pr-reviews", {}, env());
    expect(anonymous.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// One pull request
// ---------------------------------------------------------------------------------------------

function livePull(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: "open",
    merged: false,
    draft: false,
    title: "Add subjects",
    html_url: "https://github.com/nemarDatasets/nm000201/pull/7",
    user: { login: "contributor", id: 501, type: "User" },
    base: { ref: "main" },
    head: {
      sha: SHA_A,
      ref: "add-subjects",
      repo: { full_name: "nemarDatasets/nm000201", owner: { login: "nemarDatasets" } },
    },
    ...over,
  };
}

const detail = async (ds: string, n: number) => {
  const r = await get(`/admin/pr-reviews/${ds}/${n}`);
  return {
    status: r.status,
    body: r.body as unknown as PrReviewDetail & { error?: string; code?: string },
  };
};

describe("GET /admin/pr-reviews/:dataset/:pr", () => {
  test("returns the stored report in the words the pull-request comment uses", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    const { status, body } = await detail("nm000201", 7);
    expect(status).toBe(200);
    expect(body).toMatchObject({ verdict: "pass", review_current: true });
    expect(body.review?.outcome?.kind).toBe("reported");
    // The renderer is the shared one, so the CLI and the comment cannot say different things.
    if (body.review?.outcome) {
      const rendered = renderCheck(body.review.outcome);
      expect(rendered.title).toBe("Passes: nothing lost, revision advances, materially better");
      expect(rendered.summary).toContain("| Dataset description | 0 | 1 | 0 |");
    }
    expect(body.live).toMatchObject({ state: "open", head_sha: SHA_A, from_fork: false });
    expect(body.author?.tally).toEqual({ decided: 1, rejected: 0 });
  });

  test("a review of an earlier commit is not this commit's verdict", async () => {
    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull({
      head: {
        sha: SHA_C,
        ref: "x",
        repo: { full_name: "nemarDatasets/nm000201", owner: { login: "nemarDatasets" } },
      },
    });
    const { body } = await detail("nm000201", 7);
    expect(body.verdict).toBe("not_reviewed");
    expect(body.review_current).toBe(false);
    expect(body.review?.verdict).toBe("pass");
    expect(body.review?.head_sha).toBe(SHA_B);
  });

  test("lists the history newest first", async () => {
    seedReview({ ds: "nm000201", n: 7, sha: SHA_A, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    const { body } = await detail("nm000201", 7);
    expect(body.history.map((h) => [h.head_sha[0], h.verdict])).toEqual([
      ["b", "pass"],
      ["a", "fail"],
    ]);
  });

  test("a stored report that no longer parses is could-not-decide, whatever its column says", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass", report: "{not json" });
    pulls["nm000201#7"] = livePull();
    const { body } = await detail("nm000201", 7);
    expect(body.verdict).toBe("could_not_decide");
    expect(body.review?.outcome).toEqual({ kind: "error", error: "report_invalid" });
  });

  test("an unreadable report never makes a stored rejection easier to approve", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "fail", report: "{not json" });
    pulls["nm000201#7"] = livePull();
    const { body } = await detail("nm000201", 7);
    expect(body.verdict).toBe("fail");
    expect(body.review?.outcome).toEqual({ kind: "error", error: "report_invalid" });
  });

  test("shows a decline, an error and an unreported review by their closed words", async () => {
    pulls["nm000201#7"] = livePull();
    seedReview({ ds: "nm000201", n: 7, state: "declined", detail: "rate_limited" });
    let { body } = await detail("nm000201", 7);
    expect(body.review?.outcome).toEqual({ kind: "declined", reason: "rate_limited" });
    expect(body.verdict).toBe("not_reviewed");

    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "unreported" });
    pulls["nm000201#7"] = livePull({
      head: {
        sha: SHA_B,
        ref: "x",
        repo: { full_name: "nemarDatasets/nm000201", owner: { login: "nemarDatasets" } },
      },
    });
    ({ body } = await detail("nm000201", 7));
    expect(body.review?.outcome).toEqual({ kind: "unreported" });
    expect(body.verdict).toBe("could_not_decide");
  });

  test("a pull request with no review is not reviewed, and an in-progress one has no outcome yet", async () => {
    pulls["nm000201#7"] = livePull();
    let r = await detail("nm000201", 7);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ verdict: "not_reviewed", review: null, review_current: null });
    expect(r.body.author?.login).toBe("contributor");

    seedReview({ ds: "nm000201", n: 7, state: "dispatched" });
    r = await detail("nm000201", 7);
    expect(r.body.verdict).toBe("in_progress");
    expect(r.body.review?.outcome).toBeNull();
  });

  test("with a stored review but no answer from GitHub, it still answers and does not guess currency", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = 500;
    const { status, body } = await detail("nm000201", 7);
    expect(status).toBe(200);
    expect(body.live).toBeNull();
    expect(body.review_current).toBeNull();
    // No current commit to compare with, so no verdict is asserted about it: the stored pass is
    // what the review concluded of ITS commit, not of this one.
    expect(body).toMatchObject({ verdict: "not_reviewed", stale_verdict: "pass", head_sha: null });
    expect(body.review?.verdict).toBe("pass");
  });

  test("with the REST budget nearly spent it still answers from what it stored, and says GitHub was not read", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 3,
      resetEpoch: Math.floor(Date.now() / 1000) + 600,
    });
    const { status, body } = await detail("nm000201", 7);
    expect(status).toBe(200);
    expect(body.live).toBeNull();
    expect(body.review_current).toBeNull();
    expect(body.review?.verdict).toBe("pass");
    expect(calls).toHaveLength(0);
  });

  test("distinguishes a pull request that does not exist from GitHub not answering", async () => {
    const missing = await detail("nm000201", 99);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("no_such_pull_request");

    pulls["nm000201#98"] = 500;
    const unknown = await detail("nm000201", 98);
    expect(unknown.status).toBe(502);
  });

  test("refuses ids that are not a dataset and a pull request number", async () => {
    expect((await detail("nm1", 7)).status).toBe(400);
    const r = await get("/admin/pr-reviews/nm000201/abc");
    expect(r.status).toBe(400);
  });

  test("another environment's dataset is not answered here", async () => {
    envOverrides = { ENVIRONMENT: "staging" };
    const r = await detail("nm000201", 7);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("not_owned_here");
  });
});

// ---------------------------------------------------------------------------------------------
// Contributors
// ---------------------------------------------------------------------------------------------

function seedHistory(authorId: number, login: string, rejected: number, passed: number) {
  let n = 100;
  for (let i = 0; i < rejected; i++) {
    seedReview({ ds: "nm000301", n: n++, authorId, login, state: "reported", verdict: "fail" });
  }
  for (let i = 0; i < passed; i++) {
    seedReview({ ds: "nm000301", n: n++, authorId, login, state: "reported", verdict: "pass" });
  }
}

const standing = async (login: string) => {
  const r = await get(`/admin/pr-review-authors/${login}`);
  return { status: r.status, body: r.body as unknown as ContributorStanding & { code?: string } };
};

describe("contributor standing", () => {
  test("shows the record and the standing, and a bad record pauses nobody", async () => {
    usersById.alice = { id: 77, login: "Alice", type: "User" };
    seedHistory(77, "alice", 6, 4);
    const { status, body } = await standing("alice");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      login: "Alice",
      author_id: 77,
      tally: { rejected: 6, decided: 10 },
      standing: { paused: false },
      resolved_from: "github",
    });
    expect(body.override).toBeNull();
    expect(body.recent).toHaveLength(10);
    // The rule that used to turn the record into a pause is gone from the answer, not just unused.
    expect(Object.keys(body).sort()).toEqual([
      "author_id",
      "login",
      "override",
      "recent",
      "resolved_from",
      "standing",
      "tally",
    ]);
  });

  test("a contributor whose every pull request was rejected is reviewed at the real gate", async () => {
    usersById.carol = { id: 78, login: "carol", type: "User" };
    seedHistory(78, "carol", 12, 0);
    seedDataset("nm000301");
    expect((await standing("carol")).body.standing).toEqual({ paused: false });
    expect(await openPullRequest(78, "carol", 1, SHA_A)).toMatchObject({
      dispatched: true,
      reason: "dispatched",
    });
  });

  test("falls back to the review history when GitHub cannot say, and says so", async () => {
    usersById.alice = 500;
    seedHistory(77, "alice", 2, 2);
    const { status, body } = await standing("alice");
    expect(status).toBe(200);
    expect(body).toMatchObject({ author_id: 77, resolved_from: "history" });
  });

  test("a login GitHub has never heard of is a 404; one it could not be asked about is not", async () => {
    expect((await standing("ghost")).status).toBe(404);
    // GitHub failing and the Worker knowing nothing is "cannot tell", which is not "no such user".
    usersById.ghost2 = 500;
    const unknown = await standing("ghost2");
    expect(unknown.status).toBe(502);
    expect(unknown.body.code).toBe("github_unavailable");
    expect((await standing("-bad-")).status).toBe(400);
  });
});

describe("PUT and DELETE /admin/pr-review-authors/:login", () => {
  test("block pauses the contributor at the real review gate, and says who did it", async () => {
    usersById.alice = { id: 77, login: "Alice", type: "User" };
    const res = await send("PUT", "/admin/pr-review-authors/alice", {
      mode: "block",
      reason: "Spam @everyone <b>now</b> https://evil.test",
    });
    expect(res.status).toBe(200);
    const body = res.body as unknown as SetOverrideResponse;
    expect(body.previous).toBeNull();
    expect(body.standing).toMatchObject({
      author_id: 77,
      standing: { paused: true, because: "maintainer" },
      override: { mode: "block", set_by: "queueadmin" },
    });
    // Free text is reduced to plain words before it is stored.
    expect(body.standing.override?.reason).not.toMatch(/[@<>]|http/);

    const stored = db.query("SELECT * FROM pr_review_overrides").all() as Array<
      Record<string, unknown>
    >;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      author_id: 77,
      author_login: "Alice",
      mode: "block",
      set_by: adminId,
    });

    // The decision is read by the gate the webhook uses: a pull request from this contributor is
    // declined, and the row says why.
    seedDataset("nm000301");
    const gated = await openPullRequest(77, "Alice", 1, SHA_A);
    expect(gated).toMatchObject({ dispatched: false, reason: "contributor_paused" });
    expect(db.query("SELECT state, detail FROM pr_reviews WHERE pr_number = 1").get()).toEqual({
      state: "declined",
      detail: "contributor_paused",
    });

    const audit = db
      .query("SELECT * FROM audit_log WHERE action = 'pr_review_override_set'")
      .all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      user_id: adminId,
      resource_type: "pr_review_author",
      resource_id: "77",
    });
  });

  test("allow lifts a block, and a second call replaces the first", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    seedDataset("nm000301");
    await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    expect((await standing("alice")).body.standing.paused).toBe(true);
    // Blocked: the gate declines a new pull request.
    expect(await openPullRequest(77, "alice", 1, SHA_A)).toMatchObject({
      dispatched: false,
      reason: "contributor_paused",
    });

    const allowed = await send("PUT", "/admin/pr-review-authors/alice", { mode: "allow" });
    expect((allowed.body as unknown as SetOverrideResponse).previous).toBe("block");
    expect((allowed.body as unknown as SetOverrideResponse).standing.standing).toEqual({
      paused: false,
    });
    // Allowed: the same gate now lets the next one through to the reviewer.
    expect(await openPullRequest(77, "alice", 2, SHA_B)).toMatchObject({ dispatched: true });

    const blocked = await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    expect((blocked.body as unknown as SetOverrideResponse).previous).toBe("allow");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 1 });
  });

  test("an allow changes nothing for someone with a bad record: it is only the word for lifting a block", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    seedHistory(77, "alice", 6, 4);
    seedDataset("nm000301");
    const before = await openPullRequest(77, "alice", 1, SHA_A);
    await send("PUT", "/admin/pr-review-authors/alice", { mode: "allow" });
    const after = await openPullRequest(77, "alice", 2, SHA_B);
    expect([before.dispatched, after.dispatched]).toEqual([true, true]);
  });

  test("clearing a block brings the contributor back to review", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    seedDataset("nm000301");
    await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    const cleared = await send("DELETE", "/admin/pr-review-authors/alice");
    expect(cleared.status).toBe(200);
    const body = cleared.body as unknown as ClearOverrideResponse;
    expect(body.removed).toBe("block");
    expect(body.standing.standing).toEqual({ paused: false });
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
    // The real gate reviews them again, not only the standing that is reported.
    expect(await openPullRequest(77, "alice", 31, sha(31))).toMatchObject({ dispatched: true });
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pr_review_override_clear'")
        .get(),
    ).toEqual({ n: 1 });

    // Nothing left to remove is a quiet answer, and writes no audit row.
    const again = await send("DELETE", "/admin/pr-review-authors/alice");
    expect((again.body as unknown as ClearOverrideResponse).removed).toBeNull();
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pr_review_override_clear'")
        .get(),
    ).toEqual({ n: 1 });
  });

  test("an override can still be removed for an account GitHub no longer has", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    usersById = {}; // the account is gone
    const cleared = await send("DELETE", "/admin/pr-review-authors/alice");
    expect(cleared.status).toBe(200);
    expect((cleared.body as unknown as ClearOverrideResponse).removed).toBe("block");
  });

  test("writes only against an id GitHub confirms", async () => {
    // GitHub is unreachable: the history is good enough to READ a standing, not to bind a decision.
    seedHistory(77, "alice", 1, 1);
    usersById.alice = 500;
    const unreachable = await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    expect(unreachable.status).toBe(502);

    const unknown = await send("PUT", "/admin/pr-review-authors/nobody", { mode: "block" });
    expect(unknown.status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });

  test("an organisation or a bot is not a contributor, and a refusal writes nothing, not even an audit row", async () => {
    usersById.acme = { id: 900, login: "acme", type: "Organization" };
    const r = await send("PUT", "/admin/pr-review-authors/acme", { mode: "block" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("not_a_user");
    // The sentence says what applies to whom, and no longer talks of reviews counted per person.
    expect(String(r.body.error)).toContain("acme is a GitHub Organization, not a person.");
    expect(String(r.body.error)).toContain("A block or an allow applies to a person's account.");
    expect(String(r.body.error)).not.toContain("counted");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
    usersById.helper = { id: 901, login: "helper", type: "Bot" };
    const bot = await send("PUT", "/admin/pr-review-authors/helper", { mode: "block" });
    expect(bot.status).toBe(422);
    expect(bot.body.code).toBe("not_a_user");
    expect(
      db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'pr_review_override%'").get(),
    ).toEqual({ n: 0 });
  });

  test("the body is strict: an unknown mode or an extra key is refused, not read as intent", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    expect((await send("PUT", "/admin/pr-review-authors/alice", { mode: "ignore" })).status).toBe(
      400,
    );
    expect(
      (await send("PUT", "/admin/pr-review-authors/alice", { mode: "block", extra: 1 })).status,
    ).toBe(400);
    expect((await send("PUT", "/admin/pr-review-authors/alice", {})).status).toBe(400);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });

  test("a member cannot change who is reviewed", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    const r = await send("PUT", "/admin/pr-review-authors/alice", { mode: "allow" }, MEMBER_KEY);
    expect(r.status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// Which review counts for a commit
// ---------------------------------------------------------------------------------------------

const liveAt = (sha: string) =>
  livePull({
    head: {
      sha,
      ref: "x",
      repo: { full_name: "nemarDatasets/nm000201", owner: { login: "nemarDatasets" } },
    },
  });

/** A commit id that is not one of the named ones, numbered so a test can seed many. */
const sha = (n: number) => n.toString(16).padStart(40, "0");

describe("which review counts for a commit", () => {
  test("after a force-push back to a reviewed commit, that commit's own review counts, not the newest row", async () => {
    // Models a MISSED delivery: A was never seen again after B, so the newest row is B's although
    // the branch is back at A. (When the delivery arrives it refreshes A's seen_at, and A is the
    // newest; the next test covers that.)
    seedReview({ ds: "nm000201", n: 7, sha: SHA_A, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "reported", verdict: "pass" });

    nodes({ ds: "nm000201", n: 7, sha: SHA_A });
    const atA = (await queue()).body.entries[0];
    expect(atA).toMatchObject({
      verdict: "fail",
      review_current: true,
      reviewed_sha: SHA_A,
      stale_verdict: null,
      needs_you: false,
    });

    nodes({ ds: "nm000201", n: 7, sha: SHA_B });
    expect((await queue()).body.entries[0]).toMatchObject({ verdict: "pass", needs_you: true });
  });

  test("a push that is reviewed and rejected replaces an earlier pass", async () => {
    seedReview({ ds: "nm000201", n: 7, sha: SHA_A, state: "reported", verdict: "pass" });
    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "reported", verdict: "fail" });
    nodes({ ds: "nm000201", n: 7, sha: SHA_B });
    expect((await queue()).body.entries[0]).toMatchObject({ verdict: "fail", needs_you: false });
  });

  test("a commit nobody reviewed shows the NEWEST review as another commit's, with what it said", async () => {
    seedReview({ ds: "nm000201", n: 7, sha: SHA_A, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "reported", verdict: "pass" });
    nodes({ ds: "nm000201", n: 7, sha: SHA_C });
    expect((await queue()).body.entries[0]).toMatchObject({
      verdict: "not_reviewed",
      review_current: false,
      reviewed_sha: SHA_B,
      stale_verdict: "pass",
    });
  });

  test("'newest' means the last commit SEEN, as the review's own tally defines it, not the highest row id", async () => {
    // A was delivered again after B (a force-push back), so A is the one most recently seen even
    // though B has the higher row id.
    seedReview({
      ds: "nm000201",
      n: 7,
      sha: SHA_A,
      state: "reported",
      verdict: "fail",
      seenAt: "2026-10-03 00:00:00.000",
    });
    seedReview({
      ds: "nm000201",
      n: 7,
      sha: SHA_B,
      state: "reported",
      verdict: "pass",
      seenAt: "2026-10-02 00:00:00.000",
    });
    nodes({ ds: "nm000201", n: 7, sha: SHA_C });
    expect((await queue()).body.entries[0]).toMatchObject({
      reviewed_sha: SHA_A,
      stale_verdict: "fail",
    });
    pulls["nm000201#7"] = liveAt(SHA_C);
    const { body } = await detail("nm000201", 7);
    expect(body.history.map((h) => h.head_sha[0])).toEqual(["a", "b"]);
    expect(body.review?.head_sha).toBe(SHA_A);
  });

  test("the detail view picks the same review, and `?head=` asks about the commit the caller holds", async () => {
    seedReview({ ds: "nm000201", n: 7, sha: SHA_A, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = liveAt(SHA_A);

    const live = await detail("nm000201", 7);
    expect(live.body).toMatchObject({ verdict: "fail", head_sha: SHA_A, review_current: true });
    expect(live.body.review?.head_sha).toBe(SHA_A);

    // The caller names a commit; the answer is about THAT one, whatever GitHub says the head is.
    const asked = await get(`/admin/pr-reviews/nm000201/7?head=${SHA_B}`);
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ verdict: "pass", head_sha: SHA_B, review_current: true });

    const unreviewed = await get(`/admin/pr-reviews/nm000201/7?head=${SHA_C}`);
    expect(unreviewed.body).toMatchObject({
      verdict: "not_reviewed",
      review_current: false,
      stale_verdict: "pass",
    });
  });

  test("`?head=` names a commit or is refused", async () => {
    pulls["nm000201#7"] = livePull();
    for (const bad of ["nope", "ABC", "a".repeat(39), `${"a".repeat(40)}0`]) {
      const r = await get(`/admin/pr-reviews/nm000201/7?head=${bad}`);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("bad_head");
    }
  });

  test("a head whose review is older than the history shown is still found", async () => {
    // 22 reviews; the pull request's current head is the OLDEST of them.
    for (let i = 1; i <= 22; i++) {
      seedReview({
        ds: "nm000201",
        n: 7,
        sha: sha(i),
        state: "reported",
        verdict: i === 1 ? "pass" : "fail",
      });
    }
    pulls["nm000201#7"] = liveAt(sha(1));
    const { body } = await detail("nm000201", 7);
    expect(body.verdict).toBe("pass");
    expect(body.review?.head_sha).toBe(sha(1));
    expect(body.history).toHaveLength(20);
    expect(body.history_truncated).toBe(true);
  });

  test("the history says when it is complete", async () => {
    seedReview({ ds: "nm000201", n: 7, sha: SHA_A, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    expect((await detail("nm000201", 7)).body.history_truncated).toBe(false);
  });

  test("an author's standing is labelled by where the login came from", async () => {
    // From a stored review: the Worker's own record. From the live pull request alone: GitHub.
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    expect((await detail("nm000201", 7)).body.author?.resolved_from).toBe("history");
    pulls["nm000202#3"] = livePull({ user: { login: "newcomer", id: 612, type: "User" } });
    const fresh = await get("/admin/pr-reviews/nm000202/3");
    expect((fresh.body as unknown as PrReviewDetail).author).toMatchObject({
      login: "newcomer",
      resolved_from: "github",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The GitHub search, when it goes wrong or lies
// ---------------------------------------------------------------------------------------------

describe("the GitHub search", () => {
  test("a page that fails after the first one succeeded fails the whole read", async () => {
    searchPages = [[prNode({ ds: "nm000201", n: 1 })], [prNode({ ds: "nm000202", n: 2 })]];
    graphqlResponder = (attempt) =>
      attempt >= 2 ? new Response("{}", { status: 500, headers: { "Retry-After": "0" } }) : null;
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(502);
    expect(r.body.entries).toBeUndefined();
  });

  test("an answer that is not a search result is an error, not an empty queue", async () => {
    graphqlResponder = () => new Response("<html>gateway</html>", { status: 200 });
    const notJson = await get("/admin/pr-reviews");
    expect(notJson.status).toBe(502);
    expect(notJson.body.code).toBe("github_bad_response");

    graphqlResponder = () => Response.json({ data: { search: null } });
    const empty = await get("/admin/pr-reviews");
    expect(empty.status).toBe(502);
    expect(empty.body.code).toBe("github_bad_response");
  });

  test("stops at the page bound and says the list is incomplete", async () => {
    searchPages = Array.from({ length: 25 }, (_, i) => [prNode({ ds: "nm000201", n: i + 1 })]);
    const { body } = await queue();
    expect(graphqlAttempts).toBe(20);
    expect(body.truncated).toBe(true);
    expect(body.entries).toHaveLength(20);
  });

  test("a next page with no cursor to ask for is an incomplete list, not a complete one", async () => {
    graphqlResponder = () =>
      Response.json({
        data: {
          search: {
            issueCount: 2,
            pageInfo: { hasNextPage: true, endCursor: null },
            nodes: [prNode({ ds: "nm000201", n: 1 })],
          },
        },
      });
    const { body } = await queue();
    expect(body.truncated).toBe(true);
    expect(graphqlAttempts).toBe(1);
  });

  test("a result that cannot be read as a pull request is counted, not silently dropped", async () => {
    searchPages = [
      [
        prNode({ ds: "nm000201", n: 1 }),
        prNode({ ds: "nm000202", n: 2, sha: "not-a-sha" }),
        prNode({ ds: "nm000203", n: 0 }),
        { __typename: "Issue", number: 5 },
      ],
    ];
    const { body } = await queue();
    expect(body.entries.map((e) => e.dataset_id)).toEqual(["nm000201"]);
    expect(body.skipped.unreadable).toBe(3);
    // Reading fewer than the count is what makes a list incomplete; these were read and counted.
    expect(body.truncated).toBe(false);
  });

  test("a pull request the search index has not caught up on is left out and not counted as unreadable", async () => {
    searchPages = [
      [
        prNode({ ds: "nm000201", n: 1 }),
        prNode({ ds: "nm000202", n: 2, prState: "MERGED" }),
        prNode({ ds: "nm000203", n: 3, baseRef: "dev" }),
      ],
    ];
    const { body } = await queue();
    expect(body.entries.map((e) => e.dataset_id)).toEqual(["nm000201"]);
    expect(body.skipped.unreadable).toBe(0);
    expect(body.truncated).toBe(false);
  });

  test("checks that belong to a different commit than the head are not read as the head's", async () => {
    nodes({ ds: "nm000201", n: 1, commitOid: SHA_B }); // the head is SHA_A
    const e = (await queue()).body.entries[0];
    expect([e.bids, e.version]).toEqual(["unknown", "unknown"]);
  });

  test("the BIDS column counts only the NEMAR App's check, because the ruleset does", async () => {
    // A workflow job anyone with push access can add, with the same name, passing.
    const spoof = { ...bidsOk("nm000201"), appId: 15368 };
    nodes(
      // The App's real check is absent; only the spoof exists.
      { ds: "nm000201", n: 1, checks: [spoof, versionOk] },
      // The App's real check failed after the spoof started.
      {
        ds: "nm000202",
        n: 2,
        checks: [
          { ...bidsOk("nm000202"), conclusion: "FAILURE", at: "2026-10-01T00:00:00Z" },
          { ...spoof, name: "Run BIDS Validation", at: "2026-10-01T01:00:00Z" },
          versionOk,
        ],
      },
      // A commit status named like the check is not the App's check run either.
      {
        ds: "nm000203",
        n: 3,
        checks: [{ type: "status", name: "Run BIDS Validation", state: "SUCCESS" }, versionOk],
      },
    );
    const by = Object.fromEntries((await queue()).body.entries.map((e) => [e.dataset_id, e]));
    expect(by.nm000201.bids).toBe("missing");
    expect(by.nm000202.bids).toBe("fail");
    expect(by.nm000203.bids).toBe("missing");
    // `version-check` is not pinned (the ruleset accepts it from any source), so it still counts.
    expect(by.nm000201.version).toBe("pass");
  });

  test("a re-run that is queued, with no start time, is the newest run", async () => {
    nodes({
      ds: "nm000201",
      n: 1,
      checks: [
        bidsOk("nm000201"),
        { ...versionOk, conclusion: "FAILURE", at: "2026-10-01T00:00:00Z" },
        { ...versionOk, status: "QUEUED", conclusion: null },
      ],
    });
    const e = (await queue()).body.entries[0];
    expect(e.version).toBe("pending");
  });

  test("a GitHub that accepts the connection and never answers is an error within a bound", async () => {
    __setGraphqlTimeoutForTests(150);
    try {
      graphqlResponder = () => new Promise<Response>(() => {});
      const started = Date.now();
      const r = await get("/admin/pr-reviews");
      expect(r.status).toBe(502);
      expect(r.body.code).toBe("github_timeout");
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      __setGraphqlTimeoutForTests(null);
    }
    // Three attempts and two one-second back-offs: well past bun's default 5 seconds on a slow runner.
  }, 20_000);

  test("with no GitHub token configured it says so instead of listing nothing", async () => {
    envOverrides = { GITHUB_ADMIN_PAT: undefined };
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("github_unavailable");
  });
});

describe("the order of the queue", () => {
  test("pull requests with the same verdict are ordered by their required checks, then age, then id", async () => {
    nodes(
      { ds: "nm000204", n: 4, created: "2026-10-02T00:00:00Z" },
      {
        ds: "nm000203",
        n: 3,
        created: "2026-10-01T00:00:00Z",
        checks: [{ ...bidsOk("nm000203"), conclusion: "FAILURE" }, versionOk],
      },
      { ds: "nm000202", n: 9, created: "2026-10-02T00:00:00Z" },
      { ds: "nm000202", n: 2, created: "2026-10-02T00:00:00Z" },
      { ds: "nm000201", n: 1, created: "2026-10-03T00:00:00Z" },
    );
    // All "not reviewed". The failing-check one sinks below the rest even though it is the oldest;
    // among the passing ones the oldest comes first, and equal ages fall back to dataset then number.
    expect((await queue()).body.entries.map((e) => `${e.dataset_id}#${e.pr_number}`)).toEqual([
      "nm000202#2",
      "nm000202#9",
      "nm000204#4",
      "nm000201#1",
      "nm000203#3",
    ]);
  });

  test("a review that could not decide is something a person must look at", async () => {
    nodes({ ds: "nm000201", n: 1 });
    seedReview({ ds: "nm000201", n: 1, state: "errored", detail: "model_unavailable" });
    const e = (await queue()).body.entries[0];
    expect(e).toMatchObject({ verdict: "could_not_decide", needs_you: true });
    expect((await queue("?needs_me=1")).body.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Contributors: the details
// ---------------------------------------------------------------------------------------------

describe("contributor decisions, in detail", () => {
  function overrideRow(id: number, login: string, mode: "allow" | "block") {
    db.run(
      "INSERT INTO pr_review_overrides (author_id, author_login, mode, set_by) VALUES (?, ?, ?, ?)",
      [id, login, mode, adminId],
    );
  }

  test("`clear` follows who holds a login NOW, so a reused name does not clear the old owner's decision", async () => {
    // Account 77 was `alice` when it was blocked, and has since been renamed. Account 99 is `alice` now.
    overrideRow(77, "alice", "block");
    usersById.alice = { id: 99, login: "alice", type: "User" };
    const r = await send("DELETE", "/admin/pr-review-authors/alice");
    expect(r.status).toBe(200);
    const body = r.body as unknown as ClearOverrideResponse;
    expect(body.removed).toBeNull();
    expect(body.standing.author_id).toBe(99);
    expect(db.query("SELECT author_id FROM pr_review_overrides").all()).toEqual([
      { author_id: 77 },
    ]);
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pr_review_override_clear'")
        .get(),
    ).toEqual({ n: 0 });
  });

  test("with GitHub unable to say, two accounts that once used the name are not guessed between", async () => {
    overrideRow(77, "alice", "block");
    overrideRow(99, "alice", "allow");
    usersById.alice = 500;
    const r = await send("DELETE", "/admin/pr-review-authors/alice");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ambiguous_login");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 2 });
  });

  test("the audit row says who, what, and what it replaced", async () => {
    usersById.alice = { id: 77, login: "Alice", type: "User" };
    await send("PUT", "/admin/pr-review-authors/alice", { mode: "allow", reason: "Vetted" });
    await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    await send("DELETE", "/admin/pr-review-authors/alice");
    const rows = db
      .query(
        "SELECT action, details FROM audit_log WHERE action LIKE 'pr_review_override%' ORDER BY id",
      )
      .all() as Array<{ action: string; details: string }>;
    expect(rows.map((r) => [r.action, JSON.parse(r.details)])).toEqual([
      [
        "pr_review_override_set",
        { login: "Alice", mode: "allow", previous: null, reason: "Vetted" },
      ],
      [
        "pr_review_override_set",
        { login: "Alice", mode: "block", previous: "allow", reason: null },
      ],
      ["pr_review_override_clear", { login: "Alice", removed: "block" }],
    ]);
  });

  test("the record shows the most recent decided pull requests once each, newest first", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    // Twelve pull requests; the LAST one to be seen failed and was then fixed, so it counts once,
    // as a pass, and it is the newest. (Seeded first it would be cut off by the limit of ten and
    // the once-each rule would never be exercised.)
    for (let n = 101; n <= 111; n++) {
      seedReview({
        ds: "nm000301",
        n,
        authorId: 77,
        login: "alice",
        sha: sha(n),
        state: "reported",
        verdict: "pass",
      });
    }
    seedReview({
      ds: "nm000301",
      n: 100,
      authorId: 77,
      login: "alice",
      sha: SHA_A,
      state: "reported",
      verdict: "fail",
    });
    seedReview({
      ds: "nm000301",
      n: 100,
      authorId: 77,
      login: "alice",
      sha: SHA_B,
      state: "reported",
      verdict: "pass",
    });
    const { body } = await standing("alice");
    expect(body.tally).toEqual({ rejected: 0, decided: 12 });
    expect(body.recent).toHaveLength(10);
    expect(body.recent[0]).toMatchObject({ pr_number: 100, verdict: "pass", head_sha: SHA_B });
    expect(new Set(body.recent.map((r) => r.pr_number)).size).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------
// Second-round review: what the search stand-in sends, and what is never read as "nothing"
// ---------------------------------------------------------------------------------------------

describe("the search stand-in sends only what the query asks for", () => {
  test("a field the query does not select is not in the answer", () => {
    const data = {
      search: {
        issueCount: 1,
        nodes: [
          {
            __typename: "PullRequest",
            number: 1,
            secret: "x",
            commits: { nodes: [{ commit: { oid: "a", extra: 1 } }] },
          },
          { __typename: "Issue", number: 2 },
        ],
      },
    };
    const query =
      "query Q($q: String!) { search(query: $q, first: 5) { issueCount nodes { __typename ... on PullRequest { number commits(last: 1) { nodes { commit { oid } } } } } } }";
    expect(projectOnto(query, data)).toEqual({
      search: {
        issueCount: 1,
        nodes: [
          { __typename: "PullRequest", number: 1, commits: { nodes: [{ commit: { oid: "a" } }] } },
          { __typename: "Issue" },
        ],
      },
    });
  });

  test("the real query selects the check suite's App, which the BIDS pin depends on", async () => {
    nodes({ ds: "nm000201", n: 1 });
    await queue();
    const query = String(
      (calls.find((c) => c.path === "/graphql")?.body as { query: string }).query,
    );
    const sent = projectOnto(query, { search: { nodes: [prNode({ ds: "nm000201", n: 1 })] } }) as {
      search: { nodes: Array<{ commits: { nodes: Array<{ commit: unknown }> } }> };
    };
    expect(JSON.stringify(sent)).toContain('"databaseId"');
    expect(JSON.stringify(sent)).toContain('"statusCheckRollup"');
  });
});

describe("a search node is left out only when it SAYS it is not ours", () => {
  test("a node with no state, no base branch or no repository is unreadable, not 'no longer open'", async () => {
    const noState = prNode({ ds: "nm000201", n: 1 });
    noState.state = undefined;
    const noBase = prNode({ ds: "nm000202", n: 2 });
    noBase.baseRefName = undefined;
    const noRepo = prNode({ ds: "nm000203", n: 3 });
    noRepo.repository = null;
    const noRepoName = prNode({ ds: "nm000204", n: 4 });
    noRepoName.repository = { owner: { login: "nemarDatasets" } };
    searchPages = [[noState, noBase, noRepo, noRepoName]];
    const { body } = await queue();
    expect(body.entries).toHaveLength(0);
    expect(body.skipped).toEqual({ not_a_dataset: 0, not_owned_here: 0, unreadable: 4 });
    expect(body.truncated).toBe(false);
  });
});

describe("a list that may not be the whole list says so", () => {
  test("a count that changes between pages is reported, because the pages may have shifted", async () => {
    searchPages = [
      [prNode({ ds: "nm000201", n: 1 }), prNode({ ds: "nm000202", n: 2 })],
      [prNode({ ds: "nm000203", n: 3 })],
    ];
    pageCounts = [4, 3]; // one closed while reading: the one that moved up was skipped
    expect((await queue()).body.truncated).toBe(true);
    pageCounts = [3, 3];
    expect((await queue()).body.truncated).toBe(false);
  });

  test("a pull request listed twice does not stand in for one that was missed", async () => {
    searchPages = [
      [prNode({ ds: "nm000201", n: 1 }), prNode({ ds: "nm000202", n: 2 })],
      [prNode({ ds: "nm000202", n: 2 })], // seen again; nm000203 was never returned
    ];
    issueCount = 3;
    const { body } = await queue();
    expect(body.entries).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });
});

describe("when GitHub refuses the search, the cause is kept", () => {
  test("a rate limit that outlasts the retries is a 503, not a permission problem", async () => {
    nodes({ ds: "nm000201", n: 1 });
    graphqlResponder = () =>
      new Response('{"message":"You have exceeded a secondary rate limit."}', {
        status: 403,
        headers: { "Retry-After": "0" },
      });
    const limited = await get("/admin/pr-reviews");
    expect(limited.status).toBe(503);
    expect(limited.body.code).toBe("github_rate_limited");

    graphqlResponder = () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } });
    expect((await get("/admin/pr-reviews")).body.code).toBe("github_rate_limited");
  });

  test("a missing permission is a 502 that says what GitHub said", async () => {
    nodes({ ds: "nm000201", n: 1 });
    graphqlResponder = () =>
      new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("github_refused");
    expect(String(r.body.error)).toContain("Resource not accessible by integration");
  });
});

describe("the checks columns do not read an unreadable check as 'none'", () => {
  test("a node that could not be read makes a missing check unknown", async () => {
    const node = prNode({ ds: "nm000201", n: 1, checks: [versionOk] });
    const rollup = (
      node.commits as {
        nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: unknown[] } } } }>;
      }
    ).nodes[0].commit.statusCheckRollup.contexts;
    rollup.nodes.push(null); // a check node GitHub did not give us
    searchPages = [[node]];
    const { body } = await queue();
    expect(body.entries[0]).toMatchObject({ bids: "unknown", version: "pass" });
  });

  test("a same-named run whose App could not be read is not counted, and is not ignored", () => {
    const pinned = 15368;
    const mine = {
      name: "Run BIDS Validation",
      kind: "run",
      state: "pass",
      at: "2026-10-01T00:00:00Z",
      appId: pinned,
    } as const;
    const unattributed = {
      ...mine,
      state: "fail",
      at: "2026-10-02T00:00:00Z",
      appId: null,
    } as const;
    const status = { ...unattributed, kind: "status" } as const;
    const names = ["Run BIDS Validation"];
    // Newer than what was found: the answer is not known.
    expect(checkStateOf([mine, unattributed], names, true, pinned)).toBe("unknown");
    expect(checkStateOf([unattributed], names, true, pinned)).toBe("unknown");
    // Older than what was found: the pinned App's run decides.
    expect(
      checkStateOf([{ ...unattributed, at: "2026-09-01T00:00:00Z" }, mine], names, true, pinned),
    ).toBe("pass");
    // A commit status never carries an App, and was never counted.
    expect(checkStateOf([mine, status], names, true, pinned)).toBe("pass");
    expect(checkStateOf([status], names, true, pinned)).toBe("missing");
  });
});

describe("a review that will not finish is not shown as running", () => {
  const long = "2026-10-01 00:00:00";

  test("a dispatched review past the deadline and one tick reads as never reported, and needs you", async () => {
    nodes({ ds: "nm000201", n: 1 }, { ds: "nm000202", n: 2 });
    seedReview({ ds: "nm000201", n: 1, state: "dispatched" }); // dated now: still running
    seedReview({ ds: "nm000202", n: 2, state: "dispatched", createdAt: long });
    const { body } = await queue();
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e]));
    expect(by.nm000201).toMatchObject({ verdict: "in_progress", needs_you: false });
    expect(by.nm000202).toMatchObject({
      verdict: "could_not_decide",
      detail: "unreported",
      needs_you: true,
    });
  });

  test("the detail view and its history agree", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "dispatched", createdAt: long });
    pulls["nm000201#7"] = livePull();
    const { body } = await detail("nm000201", 7);
    expect(body).toMatchObject({ verdict: "could_not_decide", detail: "unreported" });
    expect(body.review).toMatchObject({ verdict: "could_not_decide", detail: "unreported" });
    expect(body.review?.outcome).toBeNull();
    expect(body.history[0].verdict).toBe("could_not_decide");
  });
});

describe("the detail view never makes a rejection easier to approve than the list does", () => {
  const cases: Array<[string, "pass" | "fail" | "uncertain", Record<string, string>, string]> = [
    ["a stored fail whose report would now pass", "fail", {}, "fail"],
    ["a stored pass whose report fails", "pass", { no_degradation: "fail" }, "fail"],
    ["a stored uncertain whose report would now pass", "uncertain", {}, "uncertain"],
    [
      "a stored pass whose report is uncertain",
      "pass",
      { material_improvement: "unknown" },
      "uncertain",
    ],
    ["a stored pass whose report passes", "pass", {}, "pass"],
    ["a stored fail whose report fails", "fail", { no_degradation: "fail" }, "fail"],
  ];
  for (const [label, stored, criteria, shown] of cases) {
    test(label, async () => {
      seedReview({
        ds: "nm000201",
        n: 7,
        state: "reported",
        verdict: stored,
        report: goodReport(criteria),
      });
      pulls["nm000201#7"] = livePull();
      const { body } = await detail("nm000201", 7);
      expect(body.verdict).toBe(shown);
      expect(body.review?.verdict).toBe(shown);
    });
  }
});

describe("the review history is read in chunks D1 allows", () => {
  test("more datasets than one query can bind (over 100) are all joined to their reviews", async () => {
    const wide = Array.from({ length: 105 }, (_, i) => `nm${String(300 + i).padStart(6, "0")}`);
    searchPages = [wide.map((ds, i) => prNode({ ds, n: i + 1 }))];
    for (const [i, ds] of wide.entries()) {
      seedReview({ ds, n: i + 1, state: "reported", verdict: "pass" });
    }
    const real = realD1(db);
    envOverrides = {
      DB: wrapD1(real, (sql) => {
        // D1 refuses a statement with more than 100 bound parameters.
        if ((sql.match(/\?/g) ?? []).length > 100) throw new Error("too many SQL variables");
      }),
    };
    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(105);
    expect(body.entries.every((e) => e.verdict === "pass")).toBe(true);
  });
});

describe("the detail view says why it has no live pull request", () => {
  test("found, missing and unreadable are told apart", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    expect((await detail("nm000201", 7)).body).toMatchObject({ live_status: "found" });
    pulls["nm000201#7"] = 404;
    expect((await detail("nm000201", 7)).body).toMatchObject({
      live: null,
      live_status: "missing",
    });
    pulls["nm000201#7"] = 500;
    expect((await detail("nm000201", 7)).body).toMatchObject({
      live: null,
      live_status: "unreadable",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The volume line (ADR 0107)
// ---------------------------------------------------------------------------------------------

describe("the volume of reviews in the list: information, never a gate", () => {
  /** A stored timestamp `hours` ago, as D1 writes them. */
  const ago = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const withAttempts = (n: number, attempts: number) =>
    db.run("UPDATE pr_reviews SET attempts = ? WHERE dataset_id = 'nm000201' AND pr_number = ?", [
      attempts,
      n,
    ]);
  const seedAt = (
    n: number,
    hours: number,
    r: Omit<Parameters<typeof seedReview>[0], "ds" | "n" | "createdAt">,
  ) => seedReview({ ...r, ds: "nm000201", n, createdAt: ago(hours) });

  function seedWeek() {
    // The last 24 hours: ten records.
    seedAt(1, 2, { state: "reported", verdict: "pass" });
    seedAt(2, 2, { state: "reported", verdict: "fail" });
    withAttempts(2, 2); // restarted once: two model calls
    seedAt(3, 2, { state: "reported", verdict: "uncertain" });
    seedAt(4, 2, { state: "declined", detail: "contributor_paused" });
    seedAt(5, 2, { state: "errored", detail: "model_unavailable" });
    seedAt(6, 2, { state: "errored", detail: "stale_head" });
    seedAt(7, 2, { state: "errored", detail: "dispatch_failed" });
    seedAt(8, 0, { state: "dispatched" });
    seedAt(9, 2, { state: "unreported" });
    // Handed over three hours ago and never reported: the list reads it as could not decide.
    seedAt(10, 3, { state: "dispatched" });
    // Just over a day ago, and three days ago: inside the week, outside the day.
    seedAt(16, 30, { state: "reported", verdict: "fail" });
    seedAt(11, 72, { state: "reported", verdict: "pass" });
    seedAt(12, 72, { state: "declined", detail: "rate_limited" });
    seedAt(13, 72, { state: "declined", detail: "daily_limit" });
    seedAt(14, 72, { state: "declined", detail: "daily_limit" });
    // A week and a half ago: just outside the week.
    seedAt(15, 180, { state: "reported", verdict: "pass" });
  }

  const day: VolumeWindow = {
    reviews: 10,
    // pass 1 + fail 2 + uncertain 1 + model_unavailable 1 + running 1 + unreported 1 + overdue 1:
    // a decline and the two runs that never reached the model cost none.
    model_calls: 8,
    by_verdict: {
      pass: 1,
      fail: 1,
      uncertain: 1,
      could_not_decide: 5,
      in_progress: 1,
      not_reviewed: 1,
    },
    declines: { contributor_paused: 1, rate_limited: 0, daily_limit: 0 },
  };
  const week: VolumeWindow = {
    reviews: 15,
    model_calls: 10,
    by_verdict: {
      pass: 2,
      fail: 2,
      uncertain: 1,
      could_not_decide: 5,
      in_progress: 1,
      not_reviewed: 4,
    },
    declines: { contributor_paused: 1, rate_limited: 1, daily_limit: 2 },
  };

  test("the list carries the records and model calls of the last day and week, with verdicts and declines", async () => {
    seedWeek();
    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.volume).toEqual({ last_24_hours: day, last_7_days: week });
  });

  test("it is the platform's, whatever the list is filtered to, and it is there when the list is empty", async () => {
    seedWeek();
    const filtered = await queue("?author=nobody&verdict=pass");
    expect(filtered.body.entries).toEqual([]);
    expect(filtered.body.volume).toEqual({ last_24_hours: day, last_7_days: week });
  });

  test("an empty history is zeros, which is a count, and not an unread volume", async () => {
    const { body } = await queue();
    expect(body.volume?.last_24_hours.reviews).toBe(0);
    expect(body.volume?.last_7_days.model_calls).toBe(0);
    expect(Object.values(body.volume?.last_7_days.by_verdict ?? {})).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Object.values(body.volume?.last_7_days.declines ?? {})).toEqual([0, 0, 0]);
  });

  test("a restart that spent a second call is counted as two calls and one record", async () => {
    seedAt(2, 1, { state: "reported", verdict: "fail" });
    withAttempts(2, 3);
    const volume = await readVolume(realD1(db));
    expect(volume.last_24_hours).toMatchObject({ reviews: 1, model_calls: 3 });
  });

  test("it never holds up the list: when it cannot be read the list is answered and says null, not zero", async () => {
    seedWeek();
    nodes({ ds: "nm000201", n: 1 });
    envOverrides = {
      DB: wrapD1(realD1(db), (sql) => {
        if (sql.includes("AS in_day")) throw new Error("D1 is unavailable");
      }),
    };
    const quiet = console.error;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const { status, body } = await queue();
      expect(status).toBe(200);
      expect(body.entries).toHaveLength(1);
      expect(body.volume).toBeNull();
    } finally {
      console.error = quiet;
    }
    expect(logged.join("\n")).toContain("[pr-queue] the volume could not be read");
  });

  test("the answer carries no author, title or text: counts and the fixed words only", async () => {
    seedWeek();
    const { body } = await queue();
    expect(JSON.stringify(body.volume)).not.toMatch(/contributor"|alice|github\.com|nm0002/);
    expect(Object.keys(body.volume ?? {}).sort()).toEqual(["last_24_hours", "last_7_days"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Owners and administrators (ADR 0107)
// ---------------------------------------------------------------------------------------------

describe("an owner's or administrator's pull request is exempt (ADR 0107)", () => {
  /** The seeded administrator's GitHub login, as `seedUser` stores it. */
  const ADMIN_GH = "queueadmin-gh";
  /** An approved member, as `seedUser` stores it: the same account in everything but the role. */
  const MEMBER_GH = "queuemember-gh";

  test("it reads exempt, is not yours to act on, and sorts after everything else", async () => {
    seedReview({ ds: "nm000203", n: 3, state: "reported", verdict: "fail", authorId: 700 });
    nodes(
      { ds: "nm000201", n: 1, author: ADMIN_GH, authorId: 4001, created: "2026-09-01T00:00:00Z" },
      { ds: "nm000202", n: 2, author: "stranger", authorId: 700 },
      { ds: "nm000203", n: 3, author: "stranger", authorId: 700 },
    );
    const { body } = await queue();
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e]));
    expect(by.nm000201).toMatchObject({
      verdict: "exempt",
      detail: null,
      needs_you: false,
      reviewed_sha: null,
      review_current: null,
      stale_verdict: null,
    });
    // The control: a stranger's pull request with no review is still asking for a person.
    expect(by.nm000202).toMatchObject({ verdict: "not_reviewed", needs_you: true });
    // Not reviewed, then a failure, then the exempt one, though it was opened first.
    expect(body.entries.map((e) => e.dataset_id)).toEqual(["nm000202", "nm000203", "nm000201"]);
  });

  test("an owner and an administrator are both exempt, a member and a test persona are not", async () => {
    await seedUser(
      "queueowner",
      "owner",
      "approved",
      "queue-owner-key-0123456789abcdef0123456789ab",
    );
    db.run(
      `INSERT INTO users (username, email, github_username, status, role, email_verified, account_kind)
       VALUES ('persona', 'persona@example.org', 'persona-gh', 'approved', 'admin', 1, 'test')`,
    );
    nodes(
      { ds: "nm000201", n: 1, author: "queueowner-gh", authorId: 4002 },
      { ds: "nm000202", n: 2, author: ADMIN_GH, authorId: 4001 },
      { ds: "nm000203", n: 3, author: MEMBER_GH, authorId: 4003 },
      { ds: "nm000204", n: 4, author: "persona-gh", authorId: 4004 },
    );
    const { body } = await queue();
    const verdicts = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e.verdict]));
    expect(verdicts).toEqual({
      nm000201: "exempt",
      nm000202: "exempt",
      nm000203: "not_reviewed",
      nm000204: "not_reviewed",
    });
  });

  test("a review of the current commit stands: a push by someone who is not exempt was reviewed", async () => {
    seedReview({
      ds: "nm000201",
      n: 1,
      sha: SHA_A,
      state: "reported",
      verdict: "fail",
      authorId: 4001,
      login: ADMIN_GH,
    });
    nodes({ ds: "nm000201", n: 1, sha: SHA_A, author: ADMIN_GH, authorId: 4001 });
    const { body } = await queue();
    expect(body.entries[0]).toMatchObject({ verdict: "fail", review_current: true });
  });

  test("a review of another commit is not carried over, and does not stop it being exempt", async () => {
    seedReview({
      ds: "nm000201",
      n: 1,
      sha: SHA_B,
      state: "reported",
      verdict: "pass",
      authorId: 4001,
      login: ADMIN_GH,
    });
    nodes({ ds: "nm000201", n: 1, sha: SHA_A, author: ADMIN_GH, authorId: 4001 });
    const { body } = await queue();
    expect(body.entries[0]).toMatchObject({
      verdict: "exempt",
      review_current: false,
      reviewed_sha: SHA_B,
      stale_verdict: "pass",
      needs_you: false,
    });
  });

  test("a bot, or an author GitHub has no user for, is never exempt, whatever its name", async () => {
    nodes(
      { ds: "nm000201", n: 1, author: ADMIN_GH, authorType: "Bot" },
      { ds: "nm000202", n: 2, author: null },
    );
    const { body } = await queue();
    expect(body.entries.map((e) => e.verdict)).toEqual(["not_reviewed", "not_reviewed"]);
  });

  test("an account whose GitHub role is not admin on the dataset is not exempt, in the list or the detail", async () => {
    permissions = { "nm000201#queueadmin-gh": "write" };
    nodes(
      { ds: "nm000201", n: 1, author: ADMIN_GH, authorId: 4001 },
      { ds: "nm000202", n: 2, author: ADMIN_GH, authorId: 4001 },
    );
    const { body } = await queue();
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e.verdict]));
    expect(by).toEqual({ nm000201: "not_reviewed", nm000202: "exempt" });

    pulls["nm000201#7"] = livePull({ user: { login: ADMIN_GH, id: 4001, type: "User" } });
    expect((await detail("nm000201", 7)).body.verdict).toBe("not_reviewed");
  });

  /** Twenty pull requests opened by one administrator, in twenty datasets. */
  const twentyDatasets = () =>
    Array.from({ length: 20 }, (_, i) => ({
      ds: `nm0002${String(i).padStart(2, "0")}`,
      n: i + 1,
      author: ADMIN_GH,
      authorId: 4001,
    }));

  test("the lookups run a few at a time: not one after another, and not all at once", async () => {
    permissions = { [ADMIN_GH]: { delayMs: 60 } };
    nodes(...twentyDatasets());
    const { body } = await queue();
    expect(body.entries).toHaveLength(20);
    expect(body.entries.every((e) => e.verdict === "exempt")).toBe(true);
    expect(calls.filter((c) => isPermissionPath(c.path))).toHaveLength(20);
    expect(permissionMaxInFlight).toBeGreaterThanOrEqual(4);
    expect(permissionMaxInFlight).toBeLessThanOrEqual(6);
  });

  test("a list never waits longer than its budget for lookups: the rest read as not exempt", async () => {
    // Each answer takes 150 ms and the whole list may wait 100: the first few lookups start, then
    // no more do, and the list is still answered.
    __setExemptLookupBudgetForTests(100);
    permissions = { [ADMIN_GH]: { delayMs: 150 } };
    nodes(...twentyDatasets());
    const started = Date.now();
    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(20);
    const exempt = body.entries.filter((e) => e.verdict === "exempt").length;
    const unasked = body.entries.filter((e) => e.verdict === "not_reviewed").length;
    expect(exempt).toBeGreaterThan(0);
    expect(unasked).toBeGreaterThan(0);
    expect(exempt + unasked).toBe(20);
    // Far fewer than twenty questions were asked, and the list did not take their sum.
    expect(calls.filter((c) => isPermissionPath(c.path)).length).toBeLessThan(20);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("a database failure on a lookup fails the list and stops the lookups that were still to start", async () => {
    nodes(...twentyDatasets());
    let lookups = 0;
    const failing = wrapD1(realD1(db), (sql) => {
      if (sql !== REVIEW_EXEMPT_SQL) return;
      lookups++;
      if (lookups === 1) throw new Error("D1 unavailable");
    });
    const res = await app.request(
      "/admin/pr-reviews",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      { ...env(), DB: failing } as Bindings,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code?: string }).code).toBe("internal");
    // The workers that were already running may still finish; none starts another lookup for a
    // list that has already failed. Give a worker that would keep going time to show it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lookups).toBeLessThanOrEqual(6);
  });

  test("a GitHub that cannot say is not exempt, and the list is still answered", async () => {
    permissions = { [ADMIN_GH]: 500 };
    nodes({ ds: "nm000201", n: 1, author: ADMIN_GH, authorId: 4001 });
    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.entries[0]).toMatchObject({ verdict: "not_reviewed", needs_you: true });
  });

  test("the verdict can be asked for, and --needs-me leaves it out", async () => {
    nodes(
      { ds: "nm000201", n: 1, author: ADMIN_GH, authorId: 4001 },
      { ds: "nm000202", n: 2, author: "stranger", authorId: 700 },
    );
    const only = await queue("?verdict=exempt");
    expect(only.status).toBe(200);
    expect(only.body.entries.map((e) => e.dataset_id)).toEqual(["nm000201"]);
    const mine = await queue("?needs_me=1");
    expect(mine.body.entries.map((e) => e.dataset_id)).toEqual(["nm000202"]);
    const both = await queue("?verdict=exempt,not-reviewed");
    expect(both.body.entries).toHaveLength(2);
  });

  test("the role is read once per dataset and author for a request, and again for the next", async () => {
    // A second administrator, so demoting one does not take away the caller's own access.
    await seedUser(
      "queueother",
      "admin",
      "approved",
      "queue-other-key-0123456789abcdef0123456789ab",
    );
    const other = "queueother-gh";
    nodes(
      { ds: "nm000201", n: 1, author: other, authorId: 4005 },
      { ds: "nm000201", n: 2, author: other.toUpperCase(), authorId: 4005 },
      { ds: "nm000201", n: 3, author: other, authorId: 4005 },
      { ds: "nm000202", n: 4, author: other, authorId: 4005 },
    );
    let lookups = 0;
    const counting = wrapD1(realD1(db), (sql) => {
      if (sql === REVIEW_EXEMPT_SQL) lookups++;
    });
    const res = await app.request(
      "/admin/pr-reviews",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      { ...env(), DB: counting } as Bindings,
    );
    const body = (await res.json()) as unknown as QueueResponse;
    expect(body.entries.every((e) => e.verdict === "exempt")).toBe(true);
    // Two datasets, one author: two lookups for four pull requests, not four.
    expect(lookups).toBe(2);

    // Nothing is kept: a demotion is seen by the very next request.
    db.run("UPDATE users SET role = 'member' WHERE github_username = ?", [other]);
    const demoted = await queue();
    expect(demoted.body.entries).toHaveLength(4);
    expect(demoted.body.entries.every((e) => e.verdict === "not_reviewed")).toBe(true);
  });

  test("the detail of one pull request says exempt on the same terms, and not for a member", async () => {
    pulls["nm000201#7"] = livePull({ user: { login: ADMIN_GH, id: 4001, type: "User" } });
    const exempt = await detail("nm000201", 7);
    expect(exempt.status).toBe(200);
    expect(exempt.body).toMatchObject({
      verdict: "exempt",
      detail: null,
      review: null,
      review_current: null,
    });

    pulls["nm000201#8"] = livePull({
      number: 8,
      user: { login: MEMBER_GH, id: 4003, type: "User" },
    });
    expect((await detail("nm000201", 8)).body.verdict).toBe("not_reviewed");

    // A review of the current commit is still the verdict.
    seedReview({ ds: "nm000201", n: 9, state: "reported", verdict: "uncertain", authorId: 4001 });
    pulls["nm000201#9"] = livePull({
      number: 9,
      user: { login: ADMIN_GH, id: 4001, type: "User" },
    });
    expect((await detail("nm000201", 9)).body).toMatchObject({
      verdict: "uncertain",
      review_current: true,
    });
  });
});
