/**
 * The paths that make a dataset public, or private, and the owner's switch for the required
 * review (PR_REVIEW_AUTO_REQUIRE, ADR 0107).
 *
 * The production Worker already runs the review (PR_REVIEW_ENABLED), so without the switch each of
 * these paths would put the review ruleset on the dataset it publishes before the canary and the
 * calibration gate have run. Three real paths are driven here, each with the switch off and on:
 *
 *   - PATCH /admin/datasets/:id/visibility, the visibility service (public and private);
 *   - POST /datasets/:id/publish, the direct publish route;
 *   - POST /admin/publish/:id/approve, the publication orchestrator, run on a request whose other
 *     steps are done so that the one step under test (`repo_public`) is the step that runs.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration applied, the real routers
 * with their real auth, and two stand-ins reached over the wire. GitHub is the stateful ruleset
 * stand-in (helpers/github-rulesets.ts), so what is asserted is what a repository holds and which
 * writes reached it. S3 is a stand-in for the bucket-policy endpoint: the bucket policy is written
 * to a host that services/s3.ts hard-codes, so the fetch of an `*.amazonaws.com` host is sent to a
 * local server, as backend/test/doctor-fix-route.test.ts does, and every other host that is not
 * loopback is refused, so nothing in this file can reach a real GitHub or AWS.
 *
 * The enforce routes, the fourth and fifth automatic paths, are in review-ruleset-routes.test.ts.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { PUBLICATION_STEPS } from "../../shared/publication-steps";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import {
  type BucketPolicy,
  buildPublicAccessPolicy,
  isDatasetPrivate,
} from "../src/services/bucket-policy";
import {
  BRANCH_RULESET_NAME,
  REVIEW_RULESET_NAME,
  buildReviewRulesetPayload,
  ensureReviewRuleset,
} from "../src/services/github";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  REVIEW_APP_BINDINGS,
  type RulesetStandIn,
  dropStandInAppToken,
  seedStandInAppToken,
  startRulesetStandIn,
} from "./helpers/github-rulesets";
import { seedScreenedRequest, seedUser } from "./helpers/publication-review";

const ADMIN_KEY = "autoreq-admin-key-0123456789abcdef0123456789abcdef";
const PAT = "ghp_review_auto_require_paths";
// An invented bucket name, never the production bucket's. The bucket policy is written to a host that
// services/s3.ts hard-codes, which this file redirects to a stand-in; if that redirect ever failed
// to catch a request, a signed request for a bucket that does not exist is what would go out, and
// not one that names the real data.
const BUCKET = "nemar-review-auto-require-paths-test";
const REGION = "us-east-2";

// biome-ignore lint/suspicious/noExplicitAny: a response body is read field by field
type Json = Record<string, any>;

interface S3PolicyStandIn {
  url: string;
  /** The bucket policy it holds, or null when none is set (S3 answers 404 for that). */
  policy: BucketPolicy | null;
  /** Each request it received. `host` is the host the code addressed, before the redirect. */
  calls: S3Call[];
  reset(): void;
  stop(): void;
}

interface S3Call {
  method: string;
  path: string;
  search: string;
  host: string | null;
}

/**
 * The requests among `calls` that a test in this file has no business making: anything but a read
 * or a write of the bucket policy of THE test's bucket. The stand-in answers every other request
 * 404, which the code that made it could swallow, so the answer cannot be what tells a test.
 */
function unexpectedS3Calls(calls: readonly S3Call[]): S3Call[] {
  return calls.filter(
    (c) =>
      !(
        (c.method === "GET" || c.method === "PUT") &&
        c.path === "/" &&
        c.search === "?policy" &&
        c.host === `${BUCKET}.s3.${REGION}.amazonaws.com`
      ),
  );
}

/** Just enough of S3 for the bucket policy: GET and PUT of `/?policy`, kept between calls. */
function startS3PolicyStandIn(): S3PolicyStandIn {
  const standIn: S3PolicyStandIn = {
    url: "",
    policy: null,
    calls: [],
    reset() {
      standIn.policy = null;
      standIn.calls.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      standIn.calls.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        host: req.headers.get("x-original-host"),
      });
      if (url.pathname === "/" && url.search === "?policy") {
        if (req.method === "GET") {
          return standIn.policy
            ? Response.json(standIn.policy)
            : new Response("<Error><Code>NoSuchBucketPolicy</Code></Error>", { status: 404 });
        }
        if (req.method === "PUT") {
          standIn.policy = JSON.parse(await req.text()) as BucketPolicy;
          return new Response(null, { status: 204 });
        }
      }
      return new Response("no stand-in for this request", { status: 404 });
    },
  });
  standIn.url = `http://127.0.0.1:${server.port}`;
  return standIn;
}

/**
 * Send the fetch of an `*.amazonaws.com` host to the S3 stand-in, let loopback through (the GitHub
 * stand-in), and refuse everything else, naming the host in `refused` so that a test can say that
 * nothing tried, even where the code that tried would swallow the refusal. `restore` puts the real
 * `fetch` back.
 */
function routeOutboundTraffic(s3Url: string): { refused: string[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const refused: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith(".amazonaws.com")) {
      const forwarded = new Request(new URL(url.pathname + url.search, s3Url), req);
      // The stand-in cannot see the host the code addressed once it is redirected, so say it.
      forwarded.headers.set("x-original-host", url.hostname);
      return realFetch(forwarded);
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return realFetch(input as RequestInfo, init);
    }
    refused.push(url.hostname);
    return Promise.reject(new Error(`this test file does not reach ${url.hostname}`));
  }) as typeof fetch;
  return {
    refused,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let github: RulesetStandIn;
let s3: S3PolicyStandIn;
let outbound: ReturnType<typeof routeOutboundTraffic>;
let envOverrides: Partial<Bindings> = {};

beforeAll(() => {
  github = startRulesetStandIn();
  s3 = startS3PolicyStandIn();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = github.url;
  outbound = routeOutboundTraffic(s3.url);
  // The Worker signs in as the App (see REVIEW_APP_BINDINGS), and this is the token it finds.
  seedStandInAppToken(PAT);
});

afterAll(() => {
  outbound.restore();
  dropStandInAppToken();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  github.stop();
  s3.stop();
});

afterEach(() => {
  // Not one request left for a host that is not a stand-in, whether or not the code noticed.
  expect(outbound.refused).toEqual([]);
  // And of the ones the S3 stand-in did receive, only the bucket policy of the test's own bucket.
  expect(unexpectedS3Calls(s3.calls)).toEqual([]);
});

beforeEach(async () => {
  db = freshDb();
  github.reset();
  s3.reset();
  outbound.refused.length = 0;
  envOverrides = {};
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/datasets", datasetRoutes);
  await seedUser(db, "autoreqadmin", "admin", ADMIN_KEY);
});

/** The review is on, as in production; the owner's switch is off unless a test turns it on. */
function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: PAT,
    // The App this Worker posts the review check as, which is the one the ruleset requires it
    // from, with the key and installation it signs in with.
    ...REVIEW_APP_BINDINGS,
    PR_REVIEW_ENABLED: "1",
    S3_BUCKET: BUCKET,
    AWS_REGION: REGION,
    AWS_ACCESS_KEY_ID: "AKIATESTONLYNOTREAL",
    AWS_SECRET_ACCESS_KEY: "test-only-secret-not-real",
    ...envOverrides,
  } as Bindings;
}

const switchOn = () => {
  envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1" };
};

function seedDataset(
  id: string,
  o: { visibility?: "public" | "private"; first_published_at?: string | null } = {},
): void {
  const owner = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'autoreqadmin'")
    .get();
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo,
                           status, visibility, anonymous, first_published_at)
     VALUES (?, ?, ?, 0, ?, 'active', ?, 0, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      owner?.id,
      `nemarDatasets/${id}`,
      o.visibility ?? "private",
      o.first_published_at === undefined ? null : o.first_published_at,
    ],
  );
}

const rowOf = (id: string) =>
  db
    .query<{ visibility: string; first_published_at: string | null }, [string]>(
      "SELECT visibility, first_published_at FROM datasets WHERE dataset_id = ?",
    )
    .get(id);

const held = (repo: string) => (github.rulesets.get(repo) ?? []).map((r) => r.name).sort();

const reviewRulesetsOf = (repo: string) =>
  (github.rulesets.get(repo) ?? []).filter((x) => x.name === REVIEW_RULESET_NAME);

/**
 * The writes that created, replaced or deleted a REVIEW ruleset. The branch ruleset a public
 * repository gets is not counted. A delete carries no body, so it is told by the id it names.
 */
const reviewWrites = (ids: number[] = []) =>
  github
    .rulesetWrites()
    .filter(
      (c) =>
        c.body?.name === REVIEW_RULESET_NAME ||
        ids.some((id) => c.path.endsWith(`/rulesets/${id}`)),
    );

/** The `private` flag of every repository-visibility PATCH GitHub received, in order. */
const visibilityPatches = () =>
  github.calls
    .filter((c) => c.method === "PATCH" && c.body !== null && "private" in c.body)
    .map((c) => c.body?.private);

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "Content-Type": "application/json",
        "X-CLI-Version": "99.0.0",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env(),
  );
}

describe("the guard on what reaches the S3 stand-in", () => {
  const policyGet: S3Call = {
    method: "GET",
    path: "/",
    search: "?policy",
    host: `${BUCKET}.s3.${REGION}.amazonaws.com`,
  };

  test("takes a read and a write of the bucket policy of the test's bucket", () => {
    expect(unexpectedS3Calls([policyGet, { ...policyGet, method: "PUT" }])).toEqual([]);
  });

  test.each<[string, Partial<S3Call>]>([
    ["another method on the policy", { method: "DELETE" }],
    ["another path", { path: "/some/key" }],
    ["another sub-resource", { search: "?acl" }],
    ["a list of the bucket", { search: "?list-type=2" }],
    ["the production bucket's host", { host: `nemar.s3.${REGION}.amazonaws.com` }],
    ["a request that was not redirected from an S3 host", { host: null }],
  ])("refuses %s", (_name, change) => {
    const call = { ...policyGet, ...change };
    expect(unexpectedS3Calls([policyGet, call])).toEqual([call]);
  });
});

describe("PATCH /admin/datasets/:id/visibility (the visibility service)", () => {
  const ID = "nm000501";
  const flip = async (visibility: "public" | "private") => {
    const res = await request(`/admin/datasets/${ID}/visibility`, "PATCH", { visibility });
    return { status: res.status, body: (await res.json()) as Json };
  };

  /** A dataset with its S3 carve-out, as a private dataset has one. */
  function seedPrivate(): void {
    seedDataset(ID, { visibility: "private" });
    s3.policy = buildPublicAccessPolicy(BUCKET, [ID]);
  }

  /** A published dataset that is public in the bucket too. */
  function seedPublished(): void {
    seedDataset(ID, { visibility: "public", first_published_at: "2026-01-01 00:00:00" });
    s3.policy = buildPublicAccessPolicy(BUCKET, []);
  }

  test("off, making a reviewable dataset public writes no review ruleset and does the rest", async () => {
    seedPrivate();

    const r = await flip("public");

    expect(r.status).toBe(200);
    // The whole flip happened: GitHub, the bucket policy, the catalog, and the repository's spec.
    expect(visibilityPatches()).toEqual([false]);
    expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(false);
    expect(rowOf(ID)).toMatchObject({ visibility: "public" });
    expect(rowOf(ID)?.first_published_at).not.toBeNull();
    expect(held(ID)).toContain(BRANCH_RULESET_NAME);
    // And the review was left out of it.
    expect(r.body.spec_enforcement.review_ruleset).toBeUndefined();
    expect(reviewWrites()).toEqual([]);
    expect(held(ID)).not.toContain(REVIEW_RULESET_NAME);
  });

  test("on, the same flip creates the review ruleset, with the pinned payload", async () => {
    switchOn();
    seedPrivate();

    const r = await flip("public");

    expect(r.status).toBe(200);
    expect(r.body.spec_enforcement.review_ruleset).toEqual({ status: "ok", detail: "created" });
    const writes = reviewWrites();
    expect(writes.map((c) => c.method)).toEqual(["POST"]);
    expect(writes[0].body).toStrictEqual(buildReviewRulesetPayload());
    expect(held(ID)).toContain(REVIEW_RULESET_NAME);
  });

  // The switch gates the requirement being added and nothing else, so a dataset made private
  // while it is off does not keep a ruleset that nothing will satisfy.
  test("off, making a dataset private still takes the review ruleset off", async () => {
    seedPublished();
    await ensureReviewRuleset(ID, PAT);
    const ids = reviewRulesetsOf(ID).map((x) => x.id);
    github.calls.length = 0;

    const r = await flip("private");

    expect(r.status).toBe(200);
    expect(visibilityPatches()).toEqual([true]);
    expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(true);
    expect(r.body.spec_enforcement.review_ruleset).toEqual({ status: "ok", detail: "removed" });
    expect(reviewWrites(ids).map((c) => c.method)).toEqual(["DELETE"]);
    expect(reviewRulesetsOf(ID)).toEqual([]);
  });

  test("off, making a dataset private that has no review ruleset only reads the rulesets", async () => {
    seedPublished();
    github.calls.length = 0;

    const r = await flip("private");

    expect(r.status).toBe(200);
    expect(r.body.spec_enforcement.review_ruleset).toEqual({
      status: "ok",
      detail: "nothing to remove",
    });
    expect(reviewWrites()).toEqual([]);
    expect(reviewRulesetsOf(ID)).toEqual([]);
  });

  test("on, making a dataset private takes the review ruleset off", async () => {
    switchOn();
    seedPublished();
    await ensureReviewRuleset(ID, PAT);
    const ids = reviewRulesetsOf(ID).map((x) => x.id);
    github.calls.length = 0;

    const r = await flip("private");

    expect(r.status).toBe(200);
    expect(r.body.spec_enforcement.review_ruleset).toEqual({ status: "ok", detail: "removed" });
    expect(reviewWrites(ids).map((c) => c.method)).toEqual(["DELETE"]);
    expect(reviewRulesetsOf(ID)).toEqual([]);
  });
});

describe("POST /datasets/:id/publish (the direct publish route)", () => {
  const ID = "nm000502";
  const publish = async () => {
    const res = await request(`/datasets/${ID}/publish`, "POST");
    return { status: res.status, body: (await res.json()) as Json };
  };

  function seedUnpublished(): void {
    seedDataset(ID, { visibility: "private" });
    s3.policy = buildPublicAccessPolicy(BUCKET, [ID]);
  }

  test("off, publishing a dataset writes no review ruleset and does the rest", async () => {
    seedUnpublished();

    const r = await publish();

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(visibilityPatches()).toEqual([false]);
    expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(false);
    expect(rowOf(ID)).toMatchObject({ visibility: "public" });
    expect(held(ID)).toContain(BRANCH_RULESET_NAME);
    expect(r.body.spec_enforcement.review_ruleset).toBeUndefined();
    expect(reviewWrites()).toEqual([]);
    expect(held(ID)).not.toContain(REVIEW_RULESET_NAME);
  });

  test("on, publishing creates the review ruleset, with the pinned payload", async () => {
    switchOn();
    seedUnpublished();

    const r = await publish();

    expect(r.status).toBe(200);
    expect(r.body.spec_enforcement.review_ruleset).toEqual({ status: "ok", detail: "created" });
    const writes = reviewWrites();
    expect(writes.map((c) => c.method)).toEqual(["POST"]);
    expect(writes[0].body).toStrictEqual(buildReviewRulesetPayload());
    expect(held(ID)).toContain(REVIEW_RULESET_NAME);
  });
});

describe("POST /admin/publish/:id/approve (the publication orchestrator)", () => {
  const ID = "nm000503";

  /**
   * A request whose every step is done but `repo_public`, so the run is a resume that makes the
   * dataset public and does nothing else: the steps before it (the S3 flip among them) and after it
   * (the DOI among them) are the ones a run records as complete. A resume of a run that has started
   * publishing skips the identifier screen and the publication review, as it does for a real run.
   */
  function seedRunAtRepoPublic(): number {
    const { requestId } = seedScreenedRequest(db, { datasetId: ID, requestStatus: "approving" });
    db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
      JSON.stringify(PUBLICATION_STEPS.filter((s) => s !== "repo_public")),
      requestId,
    ]);
    return requestId;
  }

  const approve = async () => {
    const res = await request(`/admin/publish/${ID}/approve`, "POST", { resume: true });
    return { status: res.status, body: (await res.json()) as Json };
  };

  test("off, the run makes the dataset public and writes no review ruleset", async () => {
    const requestId = seedRunAtRepoPublic();

    const r = await approve();

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      message: "Dataset published successfully",
      status: "published",
    });
    // The step ran: the repository was made public, the row followed, and the request is closed.
    expect(visibilityPatches()).toEqual([false]);
    expect(rowOf(ID)).toMatchObject({ visibility: "public" });
    expect(rowOf(ID)?.first_published_at).not.toBeNull();
    expect(
      db
        .query<{ status: string }, [number]>("SELECT status FROM publication_requests WHERE id = ?")
        .get(requestId)?.status,
    ).toBe("published");
    expect(held(ID)).toContain(BRANCH_RULESET_NAME);
    // And the review was left out of it.
    expect(reviewWrites()).toEqual([]);
    expect(held(ID)).not.toContain(REVIEW_RULESET_NAME);
  });

  test("on, the same run creates the review ruleset, with the pinned payload", async () => {
    switchOn();
    seedRunAtRepoPublic();

    const r = await approve();

    expect(r.status).toBe(200);
    expect(r.body.status).toBe("published");
    const writes = reviewWrites();
    expect(writes.map((c) => c.method)).toEqual(["POST"]);
    expect(writes[0].body).toStrictEqual(buildReviewRulesetPayload());
    expect(held(ID)).toContain(REVIEW_RULESET_NAME);
  });
});

// The ruleset requires the check from the GitHub App with id 3679074. A Worker that posts it as
// another App would put a requirement on the repository that nothing can satisfy, so with the
// switch on it still requires nothing, and says why in the log. A removal needs no check to arrive,
// so it is not held back.
describe("a Worker that posts the review check as another GitHub App, with the switch on", () => {
  const ID = "nm000504";

  test("making a dataset public does the rest and writes no review ruleset", async () => {
    envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1", GITHUB_APP_ID: "1234567" };
    seedDataset(ID, { visibility: "private" });
    s3.policy = buildPublicAccessPolicy(BUCKET, [ID]);
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    let res: Response;
    try {
      res = await request(`/admin/datasets/${ID}/visibility`, "PATCH", { visibility: "public" });
    } finally {
      console.error = realError;
    }

    expect(res.status).toBe(200);
    expect(visibilityPatches()).toEqual([false]);
    expect(held(ID)).toContain(BRANCH_RULESET_NAME);
    expect(((await res.json()) as Json).spec_enforcement.review_ruleset).toBeUndefined();
    expect(reviewWrites()).toEqual([]);
    expect(held(ID)).not.toContain(REVIEW_RULESET_NAME);
    expect(logged.some((l) => l.includes("3679074") && l.includes("1234567"))).toBe(true);
  });

  test("making a dataset private still takes the review ruleset off", async () => {
    envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1", GITHUB_APP_ID: "1234567" };
    seedDataset(ID, { visibility: "public", first_published_at: "2026-01-01 00:00:00" });
    s3.policy = buildPublicAccessPolicy(BUCKET, []);
    await ensureReviewRuleset(ID, PAT);
    const ids = reviewRulesetsOf(ID).map((x) => x.id);
    github.calls.length = 0;

    const res = await request(`/admin/datasets/${ID}/visibility`, "PATCH", {
      visibility: "private",
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).spec_enforcement.review_ruleset).toEqual({
      status: "ok",
      detail: "removed",
    });
    expect(reviewWrites(ids).map((c) => c.method)).toEqual(["DELETE"]);
  });

  test("the right App is what lets the same flip require it", async () => {
    envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1", GITHUB_APP_ID: "3679074" };
    seedDataset(ID, { visibility: "private" });
    s3.policy = buildPublicAccessPolicy(BUCKET, [ID]);

    const res = await request(`/admin/datasets/${ID}/visibility`, "PATCH", {
      visibility: "public",
    });

    expect(res.status).toBe(200);
    expect(held(ID)).toContain(REVIEW_RULESET_NAME);
  });
});

// The right App id is not enough: the check is posted with an installation token for nemarDatasets,
// and a Worker without the App's private key or that installation id falls back to the personal
// access token, which GitHub does not let post a check run. So, like another App, it requires
// nothing on its own with the switch on, and says why in the log. A removal is not held back.
describe("a Worker with the right App id and no installation of it, with the switch on", () => {
  const ID = "nm000505";
  const NO_INSTALLATION = {
    PR_REVIEW_AUTO_REQUIRE: "1",
    GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined,
  };

  async function logging<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      return { result: await fn(), logged };
    } finally {
      console.error = realError;
    }
  }

  test("making a dataset public does the rest and writes no review ruleset", async () => {
    envOverrides = NO_INSTALLATION;
    seedDataset(ID, { visibility: "private" });
    s3.policy = buildPublicAccessPolicy(BUCKET, [ID]);

    const { result: res, logged } = await logging(() =>
      request(`/admin/datasets/${ID}/visibility`, "PATCH", { visibility: "public" }),
    );

    expect(res.status).toBe(200);
    expect(visibilityPatches()).toEqual([false]);
    expect(held(ID)).toContain(BRANCH_RULESET_NAME);
    expect(((await res.json()) as Json).spec_enforcement.review_ruleset).toBeUndefined();
    expect(reviewWrites()).toEqual([]);
    expect(held(ID)).not.toContain(REVIEW_RULESET_NAME);
    expect(logged.some((l) => l.includes(ID) && l.includes("GITHUB_APP_INSTALLATION_ID"))).toBe(
      true,
    );
  });

  test("making a dataset private still takes the review ruleset off", async () => {
    envOverrides = NO_INSTALLATION;
    seedDataset(ID, { visibility: "public", first_published_at: "2026-01-01 00:00:00" });
    s3.policy = buildPublicAccessPolicy(BUCKET, []);
    await ensureReviewRuleset(ID, PAT);
    const ids = reviewRulesetsOf(ID).map((x) => x.id);
    github.calls.length = 0;

    const res = await request(`/admin/datasets/${ID}/visibility`, "PATCH", {
      visibility: "private",
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).spec_enforcement.review_ruleset).toEqual({
      status: "ok",
      detail: "removed",
    });
    expect(reviewWrites(ids).map((c) => c.method)).toEqual(["DELETE"]);
  });

  test("the installation is what lets the same flip require it", async () => {
    envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1" };
    seedDataset(ID, { visibility: "private" });
    s3.policy = buildPublicAccessPolicy(BUCKET, [ID]);

    const res = await request(`/admin/datasets/${ID}/visibility`, "PATCH", {
      visibility: "public",
    });

    expect(res.status).toBe(200);
    expect(held(ID)).toContain(REVIEW_RULESET_NAME);
  });
});
