/**
 * The availability report must never create `main` (issue #1643), proven
 * through the real entry points: the single-dataset route
 * (`POST /admin/datasets/:id/availability-report`), the sweep route
 * (`POST /admin/datasets/availability-report-sweep`), and the exported
 * `writeAvailabilityReport` where an error's `cause` is the point.
 *
 * nm000358 (2026-10-07): the sweep committed the report through the Contents
 * API to a repository nothing had been pushed to yet. That PUT created `main`
 * as an unrelated ROOT commit, and every push of the depositor's upload was
 * then rejected as non-fast-forward. What matters is therefore not a return
 * value but what GitHub is asked to do: with no `main`, the number of PUTs it
 * receives is ZERO, and a lookup that failed or could not be trusted is not
 * read as "no main" either way.
 *
 * Two real local servers stand in for the outside world, no mocks:
 *
 *  - GitHub, through the `NEMAR_GITHUB_API_URL` override the other
 *    GitHub-facing suites use. Its ref lookup answers the shapes a dataset
 *    repository can have: `main` present, absent (404), an empty repository
 *    (409 `{"message":"Git Repository is empty."}`, which is what
 *    api.github.com returns for one; observed on two empty public repositories
 *    on 2026-10-07, not in GitHub's reference), and the faults a lookup can
 *    meet (403, 401, a 2xx that is not a ref, 500, a 409 that is not an empty
 *    repository, a repository NEMAR cannot see).
 *  - S3, through `S3_ENDPOINT_URL`, answering the LIST and the version
 *    manifest read that `verifyDatasetVersionS3` makes.
 *
 * Both write into ONE ordered event log, so the ORDER is observable: a refused
 * row must not have paid for the S3 walk, the most expensive thing a sweep row
 * does, and the PUT must come after it.
 */

import type { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import {
  AvailabilityReportError,
  writeAvailabilityReport,
} from "../src/services/availability-report";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { rejection } from "./helpers/rejection";

const ADMIN_KEY = "avail-nomain-admin-key-0123456789abcdef0123456789abcdef";

/** What the stand-in's ref lookup answers for each state a repository's `main`
 *  can be in. The state names are derived from the keys, so a table below can
 *  only name a state that exists. */
const REF_ANSWERS = {
  present: () => Response.json({ ref: "refs/heads/main", object: { sha: "a".repeat(40) } }),
  absent: () => Response.json({ message: "Not Found" }, { status: 404 }),
  empty: () => Response.json({ message: "Git Repository is empty." }, { status: 409 }),
  conflict: () => Response.json({ message: "Reference update conflict" }, { status: 409 }),
  forbidden: () =>
    Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
  unauthorized: () => Response.json({ message: "Bad credentials" }, { status: 401 }),
  junk: () => new Response("<html><body>Sign in to continue</body></html>", { status: 200 }),
  "server-error": () => Response.json({ message: "Server Error" }, { status: 500 }),
} satisfies Record<string, () => Response>;

type RefState = keyof typeof REF_ANSWERS;

interface Event {
  source: "github" | "s3";
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  /** Parsed JSON body of a PUT; `null` for anything else. */
  body: { content?: string; message?: string; branch?: string; sha?: string } | null;
}

let github: Server;
let s3: Server;
/** Every request either stand-in received, in arrival order. */
let events: Event[];
const refState = new Map<string, RefState>();
const repoVisible = new Map<string, boolean>();
let previousGithubUrl: string | undefined;

/** One complete object, so a successful report has something real to compare. */
const ANNEX_KEY = "SHA256E-s5--abc.edf";

/** A stable label per request kind: the unit the ordering assertions use. */
function label(e: Event): string {
  if (e.source === "s3") return e.search.includes("list-type=2") ? "s3 LIST" : "s3 GET manifest";
  if (/\/git\/ref\/heads\//.test(e.path)) return "github GET ref";
  if (/\/contents\//.test(e.path)) return `github ${e.method} contents`;
  return `github ${e.method} repo`;
}

const trace = () => events.map(label);
const githubEvents = () => events.filter((e) => e.source === "github");
const s3Events = () => events.filter((e) => e.source === "s3");
const puts = () => githubEvents().filter((e) => e.method === "PUT");

beforeAll(() => {
  previousGithubUrl = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  github = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body =
        req.method === "PUT" ? ((await req.json().catch(() => null)) as Event["body"]) : null;
      events.push({
        source: "github",
        method: req.method,
        path: url.pathname,
        search: url.search,
        authorization: req.headers.get("authorization"),
        body,
      });

      const ref = /^\/repos\/nemarDatasets\/([^/]+)\/git\/ref\/heads\/main$/.exec(url.pathname);
      if (ref && req.method === "GET") {
        return REF_ANSWERS[refState.get(ref[1] ?? "") ?? "absent"]();
      }
      if (/^\/repos\/nemarDatasets\/[^/]+\/contents\//.test(url.pathname)) {
        if (req.method === "PUT") {
          return Response.json({ content: { sha: "c".repeat(40) } }, { status: 201 });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      // The repository probe branchExists makes after a 404 on the ref.
      const repo = /^\/repos\/nemarDatasets\/([^/]+)$/.exec(url.pathname);
      if (repo && req.method === "GET") {
        if (repoVisible.get(repo[1] ?? "") === false) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        return Response.json({ full_name: `nemarDatasets/${repo[1]}` });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${github.port}`;

  s3 = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      events.push({
        source: "s3",
        method: req.method,
        path: url.pathname,
        search: url.search,
        authorization: req.headers.get("authorization"),
        body: null,
      });
      if (url.pathname === "/" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Contents><Key>${prefix}${ANNEX_KEY}</Key><Size>5</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
          { status: 200 },
        );
      }
      if (/^\/[^/]+\/version\/v1\.0\.0\.json$/.test(url.pathname)) {
        return Response.json({ files: { "sub-01/eeg/a.edf": { key: ANNEX_KEY, size: 5 } } });
      }
      return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    },
  });
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = previousGithubUrl;
  github.stop(true);
  s3.stop(true);
});

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    GITHUB_ADMIN_PAT: "test-pat",
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    S3_ENDPOINT_URL: `http://127.0.0.1:${s3.port}`,
    ...overrides,
  } as Bindings;
}

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('nomainadmin', 'nomainadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='nomainadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

/** A dataset row. By default reportable: public, non-sandbox, with a repo and
 *  a version DOI. `version: "none"` is a dataset with no DOI and no
 *  dataset_versions row. */
function seedDataset(
  id: string,
  opts: { githubRepo?: string | null; version?: "doi" | "none" } = {},
): void {
  const githubRepo = opts.githubRepo === undefined ? `nemarDatasets/${id}` : opts.githubRepo;
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox, latest_version_doi)
     VALUES (?, ?, 1, ?, 0, ?)`,
  ).run(id, id, githubRepo, opts.version === "none" ? null : `10.82901/nemar.${id}.v1.0.0`);
}

function post(path: string, overrides: Partial<Bindings> = {}): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(overrides),
  );
}

interface SweepBody {
  processed: number;
  written: number;
  errors: { dataset_id: string; error: string; status: number }[];
  remaining: number | null;
}

async function sweep(query = ""): Promise<SweepBody> {
  const res = await post(`/admin/datasets/availability-report-sweep${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as SweepBody;
}

function stamp(id: string): string | null {
  return (
    db
      .query(
        "SELECT json_extract(sweep_stamps, '$.availability_report_at') AS at FROM datasets WHERE dataset_id = ?",
      )
      .get(id) as { at: string | null }
  ).at;
}

beforeEach(async () => {
  db = freshDb();
  events = [];
  refState.clear();
  repoVisible.clear();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

/**
 * The single-dataset route refuses with `status` and a message containing
 * `fragment`, asks GitHub exactly `githubTrace` (so: no S3 request, no PUT, and
 * the lookups in that order), and says nothing was written. Returns the message
 * for any further assertion.
 */
async function expectRouteRefusal(
  id: string,
  status: number,
  fragment: string,
  githubTrace: string[],
): Promise<string> {
  const res = await post(`/admin/datasets/${id}/availability-report`);

  expect(res.status).toBe(status);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain(fragment);
  expect(error).toContain("Nothing was written");
  // The line under test: the Contents API is never asked to write, so it cannot
  // create `main` as a root commit; and the refusal precedes the S3 walk.
  expect(puts()).toEqual([]);
  expect(s3Events()).toEqual([]);
  expect(trace()).toEqual(githubTrace);
  return error;
}

/**
 * A one-candidate sweep records `id` as a single error entry with `status` and a
 * message containing `fragment`, writes nothing and reads no S3, and leaves the
 * row unstamped (so it stays a candidate and is retried).
 */
async function expectSweepRefusal(id: string, status: number, fragment: string): Promise<void> {
  const body = await sweep();

  expect(body.processed).toBe(1);
  expect(body.written).toBe(0);
  expect(body.errors).toEqual([
    { dataset_id: id, error: expect.stringContaining(fragment), status },
  ]);
  expect(puts()).toEqual([]);
  expect(s3Events()).toEqual([]);
  expect(stamp(id)).toBeNull();
  expect(body.remaining).toBe(1);
}

// ---------------------------------------------------------------------------
// main is absent from a repository NEMAR can see: a refusal (409)
// ---------------------------------------------------------------------------

const REFUSAL_CASES: ReadonlyArray<{ label: string; state: RefState; githubTrace: string[] }> = [
  {
    label: "main absent (ref lookup 404, repository visible)",
    state: "absent",
    // The 404 is followed by the one repository probe that makes it an answer.
    githubTrace: ["github GET ref", "github GET repo"],
  },
  {
    label: "empty repository (ref lookup 409 'Git Repository is empty')",
    state: "empty",
    githubTrace: ["github GET ref"],
  },
];

for (const { label: caseLabel, state, githubTrace } of REFUSAL_CASES) {
  describe(`${caseLabel}: the report is refused, not written`, () => {
    beforeEach(() => {
      seedDataset("nm000358");
      refState.set("nm000358", state);
    });

    test("single-dataset route answers 409 naming the missing branch, before any S3 work", async () => {
      const error = await expectRouteRefusal("nm000358", 409, "has no main branch", githubTrace);

      expect(error).toContain("nemarDatasets/nm000358");
      // The repository was confirmed visible, so the message must not suggest
      // it was not.
      expect(error).not.toContain("not visible");
    });

    test("the sweep reports a 409 entry and leaves the row unstamped", async () => {
      await expectSweepRefusal("nm000358", 409, "has no main branch");
    });
  });
}

test("one refused dataset does not stop a later one with main from being written", async () => {
  seedDataset("nm000358");
  seedDataset("nm000360");
  refState.set("nm000358", "absent");
  refState.set("nm000360", "present");

  const body = await sweep();

  expect(body.processed).toBe(2);
  expect(body.written).toBe(1);
  expect(puts().map((e) => e.path)).toEqual([
    "/repos/nemarDatasets/nm000360/contents/.nemar/availability-report.json",
  ]);
  expect(stamp("nm000358")).toBeNull();
  expect(stamp("nm000360")).not.toBeNull();
  expect(body.remaining).toBe(1);
});

// ---------------------------------------------------------------------------
// The lookup failed or could not be trusted: a fault (500), never "no main"
// ---------------------------------------------------------------------------

const LOOKUP_FAULTS: ReadonlyArray<{
  label: string;
  state: RefState;
  repoVisible?: false;
  fragment: string;
  githubTrace: string[];
}> = [
  {
    label: "403 forbidden (plain body, so it returns at once)",
    state: "forbidden",
    fragment: "HTTP 403",
    githubTrace: ["github GET ref"],
  },
  {
    label: "401 unauthorized",
    state: "unauthorized",
    fragment: "HTTP 401",
    githubTrace: ["github GET ref"],
  },
  {
    label: "2xx that is not a ref (a proxy page)",
    state: "junk",
    fragment: "Unexpected response format",
    githubTrace: ["github GET ref"],
  },
  {
    label: "500 (one attempt, no retry)",
    state: "server-error",
    fragment: "HTTP 500",
    githubTrace: ["github GET ref"],
  },
  {
    label: "409 that is not an empty repository",
    state: "conflict",
    fragment: "HTTP 409",
    githubTrace: ["github GET ref"],
  },
  {
    label: "404 on the ref AND on the repository (not visible to NEMAR)",
    state: "absent",
    repoVisible: false,
    fragment: "repository not visible to NEMAR",
    githubTrace: ["github GET ref", "github GET repo"],
  },
];

for (const fault of LOOKUP_FAULTS) {
  describe(`ref lookup fault, ${fault.label}: a 500, nothing written`, () => {
    beforeEach(() => {
      seedDataset("nm000368");
      refState.set("nm000368", fault.state);
      if (fault.repoVisible === false) repoVisible.set("nm000368", false);
    });

    test("single-dataset route answers 500 (not the 409 refusal), no PUT, no S3", async () => {
      await expectRouteRefusal("nm000368", 500, fault.fragment, fault.githubTrace);
    });

    test("the sweep reports a 500 entry and leaves the row unstamped", async () => {
      await expectSweepRefusal("nm000368", 500, fault.fragment);
    });

    test("writeAvailabilityReport throws a 500 AvailabilityReportError carrying the original error as its cause", async () => {
      const err = await rejection(writeAvailabilityReport(env(), "nm000368"));

      expect(err).toBeInstanceOf(AvailabilityReportError);
      expect((err as AvailabilityReportError).statusCode).toBe(500);
      const cause = (err as AvailabilityReportError).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toContain(fault.fragment);
    });
  });
}

// ---------------------------------------------------------------------------
// main present: the report is written exactly once
// ---------------------------------------------------------------------------

describe("main present: the report is written exactly once", () => {
  test("single-dataset route: ref lookup first, then the S3 walk, then exactly one PUT", async () => {
    seedDataset("nm000360");
    refState.set("nm000360", "present");

    const res = await post("/admin/datasets/nm000360/availability-report");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { written: boolean }).written).toBe(true);

    const order = trace();
    expect(order[0]).toBe("github GET ref");
    expect(order.at(-1)).toBe("github PUT contents");
    // The S3 walk happens for a row that passes the cheap check, and strictly
    // between the lookup and the write.
    const list = order.indexOf("s3 LIST");
    expect(list).toBeGreaterThan(0);
    expect(list).toBeLessThan(order.indexOf("github PUT contents"));
    expect(order.filter((l) => l === "github PUT contents")).toHaveLength(1);
    // Every S3 request (LIST and both manifest reads) comes after the lookup.
    expect(order.indexOf("github GET ref")).toBeLessThan(order.indexOf("s3 GET manifest"));
  });

  test("the PUT carries the real report: dataset, version, completeness, message, branch, no sha", async () => {
    seedDataset("nm000360");
    refState.set("nm000360", "present");

    await post("/admin/datasets/nm000360/availability-report");

    expect(puts()).toHaveLength(1);
    const put = puts()[0];
    expect(put?.path).toBe(
      "/repos/nemarDatasets/nm000360/contents/.nemar/availability-report.json",
    );
    expect(put?.body?.branch).toBe("main");
    expect(put?.body?.message).toBe("Update NEMAR availability report");
    // A create: the file did not exist, so no blob sha is sent.
    expect(put?.body).not.toHaveProperty("sha");
    const report = JSON.parse(atob(put?.body?.content ?? "")) as {
      dataset_id: string;
      version: string | null;
      complete: boolean;
      completeness: { files_present: number; files_declared: number };
    };
    expect(report.dataset_id).toBe("nm000360");
    // version and complete come from the manifest the second S3 read parses:
    // without that read the report degrades to version null / complete false.
    expect(report.version).toBe("1.0.0");
    expect(report.complete).toBe(true);
    expect(report.completeness.files_present).toBe(1);
    expect(report.completeness.files_declared).toBe(1);
  });

  test("the lookups and the write carry the GitHub token", async () => {
    seedDataset("nm000360");
    seedDataset("nm000361");
    refState.set("nm000360", "present");
    refState.set("nm000361", "absent");

    await post("/admin/datasets/nm000361/availability-report");
    await post("/admin/datasets/nm000360/availability-report");

    // The ref GET, the repository probe after a 404, and the contents GET/PUT.
    // A dropped header makes GitHub answer 404 for a private repository, which
    // would refuse every dataset with a plausible-looking 409.
    expect(githubEvents().length).toBeGreaterThanOrEqual(5);
    for (const e of githubEvents()) {
      expect(e.authorization).toBe("Bearer test-pat");
    }
  });

  test("the sweep writes exactly one PUT and stamps the row", async () => {
    seedDataset("nm000360");
    refState.set("nm000360", "present");

    const body = await sweep();

    expect(body).toEqual({ processed: 1, written: 1, errors: [], remaining: 0 });
    expect(puts()).toHaveLength(1);
    expect(stamp("nm000360")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Paths that never need GitHub's branch, and the checks that moved earlier
// ---------------------------------------------------------------------------

describe("paths that never need GitHub's branch", () => {
  test("?dry_run=1 on a dataset with no main still returns the report and makes no GitHub request", async () => {
    seedDataset("nm000358");
    refState.set("nm000358", "empty");

    const res = await post("/admin/datasets/nm000358/availability-report?dry_run=1");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { dataset_id: string }).dataset_id).toBe("nm000358");
    expect(githubEvents()).toEqual([]);
    expect(s3Events().length).toBeGreaterThan(0);
  });
});

describe("the write-path checks that now run before the S3 walk", () => {
  test("a dataset with no github_repo is refused 400 before any S3 or GitHub request", async () => {
    seedDataset("ds000303", { githubRepo: null });

    const res = await post("/admin/datasets/ds000303/availability-report");

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no GitHub repository");
    expect(events).toEqual([]);
  });

  for (const githubRepo of ["nemarDatasets", "nemarDatasets/"]) {
    test(`an invalid github_repo (${JSON.stringify(githubRepo)}) is refused 400 before any S3 or GitHub request`, async () => {
      seedDataset("nm000380", { githubRepo });

      const res = await post("/admin/datasets/nm000380/availability-report");

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        "Invalid github_repo format",
      );
      expect(events).toEqual([]);
    });
  }

  test("a token-resolution failure is a 500 before any S3 or GitHub request", async () => {
    seedDataset("nm000381");

    const res = await post("/admin/datasets/nm000381/availability-report", {
      GITHUB_ADMIN_PAT: undefined,
    });

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Failed to resolve GitHub auth",
    );
    expect(events).toEqual([]);
  });

  test("a token-resolution failure keeps its cause", async () => {
    seedDataset("nm000381");

    const err = await rejection(
      writeAvailabilityReport(env({ GITHUB_ADMIN_PAT: undefined }), "nm000381"),
    );

    expect(err).toBeInstanceOf(AvailabilityReportError);
    expect((err as AvailabilityReportError).statusCode).toBe(500);
    expect((err as AvailabilityReportError).cause).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Server logging on the single-dataset route
// ---------------------------------------------------------------------------

describe("the single-dataset route logs a 5xx and only a 5xx", () => {
  const FAILED = "[availability-report] Failed for";
  let errorLog: ReturnType<typeof spyOn<Console, "error">>;

  beforeEach(() => {
    errorLog = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  const failures = () =>
    errorLog.mock.calls.filter((call) => typeof call[0] === "string" && call[0].startsWith(FAILED));

  test("a token-resolution failure (500) leaves a server log naming the dataset and keeping the error", async () => {
    seedDataset("nm000381");

    const res = await post("/admin/datasets/nm000381/availability-report", {
      GITHUB_ADMIN_PAT: undefined,
    });

    expect(res.status).toBe(500);
    expect(failures()).toHaveLength(1);
    expect(failures()[0]?.[0]).toBe(`${FAILED} nm000381:`);
    expect(failures()[0]?.[1]).toBeInstanceOf(AvailabilityReportError);
  });

  test("a failed ref lookup (500) is logged", async () => {
    seedDataset("nm000368");
    refState.set("nm000368", "forbidden");

    await post("/admin/datasets/nm000368/availability-report");

    expect(failures()).toHaveLength(1);
  });

  test("a refusal (409) is not a fault and is not logged", async () => {
    seedDataset("nm000358");
    refState.set("nm000358", "empty");

    const res = await post("/admin/datasets/nm000358/availability-report");

    expect(res.status).toBe(409);
    expect(failures()).toEqual([]);
  });

  test("a 400 is not logged", async () => {
    seedDataset("ds000303", { githubRepo: null });

    const res = await post("/admin/datasets/ds000303/availability-report");

    expect(res.status).toBe(400);
    expect(failures()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Candidacy and the LIMIT window, through the sweep route
// ---------------------------------------------------------------------------

describe("sweep candidacy through the route", () => {
  test("a dataset with no version DOI and no version row is not a candidate: no work, no requests", async () => {
    seedDataset("nm000358", { version: "none" });
    refState.set("nm000358", "empty");

    const body = await sweep();

    expect(body).toEqual({ processed: 0, written: 0, errors: [], remaining: 0 });
    expect(events).toEqual([]);
  });

  // Characterizes the KNOWN LIMITATION documented on
  // AVAILABILITY_REPORT_SWEEP_BASE_WHERE (tracked as a follow-up to #1643), so
  // it is a decision and not an accident. If this test fails because refused
  // rows are now stamped, skipped or ordered last, that is the fix landing:
  // update it, that doc, and the `remaining` doc on AvailabilityReportSweepResult.
  test("KNOWN LIMITATION: a refused row sorted first holds the only LIMIT slot, so the valid row behind it is never reached", async () => {
    seedDataset("nm000358"); // sorts first, main absent: refused every pass
    seedDataset("nm000360"); // valid
    refState.set("nm000358", "absent");
    refState.set("nm000360", "present");

    const first = await sweep("?limit=1");
    const second = await sweep("?limit=1");

    for (const pass of [first, second]) {
      expect(pass.processed).toBe(1);
      expect(pass.written).toBe(0);
      expect(pass.errors.map((e) => e.dataset_id)).toEqual(["nm000358"]);
      // Both rows are still unstamped, so both still count as remaining.
      expect(pass.remaining).toBe(2);
    }
    expect(puts()).toEqual([]);
    expect(stamp("nm000360")).toBeNull();
    // The valid row was never even looked at.
    expect(githubEvents().some((e) => e.path.includes("/nm000360/"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The S3_ENDPOINT_URL seam applies outside production only
// ---------------------------------------------------------------------------

describe("S3_ENDPOINT_URL is honored outside production only", () => {
  const realFetch = globalThis.fetch;
  let direct: string[];
  let aws: string[];

  beforeEach(() => {
    direct = [];
    aws = [];
    // Reroute any request addressed to an AWS host onto the S3 stand-in and
    // record that it was addressed there. This is a network-boundary probe, not
    // a stand-in for business logic: the stand-in still does all the answering.
    // It is what lets a production-environment run be observed without ever
    // reaching real AWS: the code under test addresses either the stand-in
    // directly (the override applied) or an AWS host (it did not).
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname.endsWith(".amazonaws.com")) {
        aws.push(url.hostname);
        return realFetch(
          new Request(`http://127.0.0.1:${s3.port}${url.pathname}${url.search}`, request),
        );
      }
      if (url.port === String(s3.port)) direct.push(`${url.pathname}${url.search}`);
      return realFetch(request);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // The positive control: without it, "never addressed the stand-in" could be
  // true because the probe saw nothing at all.
  test("development: the LIST and both manifest reads address the stand-in directly", async () => {
    seedDataset("nm000360");

    const res = await post("/admin/datasets/nm000360/availability-report?dry_run=1");

    expect(res.status).toBe(200);
    expect(aws).toEqual([]);
    expect(direct.filter((p) => p.includes("list-type=2"))).toHaveLength(1);
    expect(direct.filter((p) => p.includes("/version/v1.0.0.json"))).toHaveLength(2);
  });

  test("production with S3_ENDPOINT_URL set: every S3 read addresses the AWS host, none the override", async () => {
    seedDataset("nm000360");

    const res = await post("/admin/datasets/nm000360/availability-report?dry_run=1", {
      ENVIRONMENT: "production",
    });

    expect(res.status).toBe(200);
    // LIST + manifest in verifyDatasetVersionS3, and the report's own manifest
    // read: three reads, at the two sites the override is fenced at.
    expect(direct).toEqual([]);
    expect(aws).toHaveLength(3);
    expect(new Set(aws)).toEqual(new Set(["nemar.s3.us-east-2.amazonaws.com"]));
  });
});
