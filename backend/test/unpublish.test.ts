/**
 * Unpublish (ADR 0125): `POST /admin/datasets/:id/unpublish`, driven through the real admin and
 * dataset routers against a real bun:sqlite D1 with every migration applied, and the same two
 * stand-ins review-auto-require-paths.test.ts uses (GitHub's ruleset API over the wire, and the
 * S3 bucket-policy endpoint); every other host is refused, so a call to EZID would fail the
 * afterEach below. That is how "the DOIs are never touched" is proven rather than assumed.
 *
 * The rows are nm000289 as it stood on 2026-11-17: owned by a member, a `published` request with
 * every step done, a concept DOI and a version DOI both `public`, `first_published_at` set, and
 * the visibility an administrator had flipped to private with the bare visibility route.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import { buildPublicAccessPolicy, isDatasetPrivate } from "../src/services/bucket-policy";
import type { BucketPolicy } from "../src/services/bucket-policy";
import { decideUnpublish } from "../src/services/unpublish";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  REVIEW_APP_BINDINGS,
  type RulesetStandIn,
  dropStandInAppToken,
  seedStandInAppToken,
  startRulesetStandIn,
} from "./helpers/github-rulesets";
import { seedUser } from "./helpers/publication-review";

const ADMIN_KEY = "unpub-admin-key-0123456789abcdef0123456789abcdef";
const OWNER_KEY = "unpub-owner-key-0123456789abcdef0123456789abcdef";
const COLLAB_KEY = "unpub-collab-key-0123456789abcdef0123456789abcdef";
const PAT = "ghp_unpublish_test";
const BUCKET = "nemar-unpublish-test";
const REGION = "us-east-2";
const ID = "nm000289";
const CONCEPT = "10.82901/nemar.nm000289";
const VERSION_DOI = "10.82901/nemar.nm000289.v1.0.1";

// biome-ignore lint/suspicious/noExplicitAny: a response body is read field by field
type Json = Record<string, any>;

interface S3PolicyStandIn {
  url: string;
  policy: BucketPolicy | null;
  /** Answer every policy PUT with a 500 (an S3 outage on writes). */
  failPuts: boolean;
  /** Every policy written, in order, so a transient "public" is visible after a revert. */
  puts: BucketPolicy[];
  calls: Array<{ method: string; path: string; search: string }>;
  reset(): void;
  stop(): void;
}

/** Just enough of S3 for the bucket policy: GET and PUT of `/?policy`, kept between calls. */
function startS3PolicyStandIn(): S3PolicyStandIn {
  const standIn: S3PolicyStandIn = {
    url: "",
    policy: null,
    failPuts: false,
    puts: [],
    calls: [],
    reset() {
      standIn.policy = null;
      standIn.failPuts = false;
      standIn.puts.length = 0;
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
      standIn.calls.push({ method: req.method, path: url.pathname, search: url.search });
      if (url.pathname === "/" && url.search === "?policy") {
        if (req.method === "GET") {
          return standIn.policy
            ? Response.json(standIn.policy)
            : new Response("<Error><Code>NoSuchBucketPolicy</Code></Error>", { status: 404 });
        }
        if (req.method === "PUT") {
          if (standIn.failPuts)
            return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
          standIn.policy = JSON.parse(await req.text()) as BucketPolicy;
          standIn.puts.push(standIn.policy);
          return new Response(null, { status: 204 });
        }
      }
      return new Response("no stand-in for this request", { status: 404 });
    },
  });
  standIn.url = `http://127.0.0.1:${server.port}`;
  return standIn;
}

/** S3 hosts go to the stand-in, loopback goes through, anything else (EZID) is refused and noted. */
function routeOutboundTraffic(s3Url: string): { refused: string[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const refused: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith(".amazonaws.com")) {
      return realFetch(new Request(new URL(url.pathname + url.search, s3Url), req));
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
let ownerId: number;

beforeAll(() => {
  github = startRulesetStandIn();
  s3 = startS3PolicyStandIn();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = github.url;
  outbound = routeOutboundTraffic(s3.url);
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
  // No request for EZID, or for any host that is not a stand-in, whether or not the code noticed.
  expect(outbound.refused).toEqual([]);
});

beforeEach(async () => {
  db = freshDb();
  github.reset();
  s3.reset();
  outbound.refused.length = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/datasets", datasetRoutes);
  await seedUser(db, "arnodelorme", "admin", ADMIN_KEY);
  ownerId = await seedUser(db, "kshahi", "member", OWNER_KEY);
  await seedUser(db, "collab", "member", COLLAB_KEY);
  const requester = await seedUser(
    db,
    "psong",
    "member",
    "unpub-psong-key-0123456789abcdef0123456789abcdef",
  );
  db.run("UPDATE users SET github_username = 'psong' WHERE id = ?", [requester]);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: PAT,
    ...REVIEW_APP_BINDINGS,
    S3_BUCKET: BUCKET,
    AWS_REGION: REGION,
    AWS_ACCESS_KEY_ID: "AKIATESTONLYNOTREAL",
    AWS_SECRET_ACCESS_KEY: "test-only-secret-not-real",
  } as Bindings;
}

async function call(
  path: string,
  key: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const res = await app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-CLI-Version": "99.0.0",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

const unpublish = (id: string, body: unknown, key = ADMIN_KEY) =>
  call(`/admin/datasets/${id}/unpublish`, key, "POST", body);

interface SeedOptions {
  visibility: "public" | "private";
  /** A `published` request, as publication leaves one. */
  publishedRequest?: boolean;
  doi?: boolean;
  source?: Record<string, string | number | null>;
}

function seedDataset(id: string, o: SeedOptions): void {
  const cols: Record<string, string | number | null> = {
    dataset_id: id,
    name: `Name of ${id}`,
    owner_user_id: ownerId,
    is_sandbox: 0,
    github_repo: `nemarDatasets/${id}`,
    status: "active",
    visibility: o.visibility,
    anonymous: 0,
    concept_doi: o.doi === false ? null : `10.82901/nemar.${id}`,
    ezid_status: o.doi === false ? null : "public",
    first_published_at: o.doi === false ? null : "2026-10-05 12:00:00",
    ...o.source,
  };
  const keys = Object.keys(cols);
  db.run(
    `INSERT INTO datasets (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    keys.map((k) => cols[k]) as never[],
  );
  github.repoPrivate.set(id, o.visibility === "private");
  if (o.doi !== false) {
    db.run(
      "INSERT INTO dataset_versions (dataset_id, version, doi, ezid_status) VALUES (?, 'v1.0.1', ?, 'public')",
      [id, `10.82901/nemar.${id}.v1.0.1`],
    );
  }
  if (o.publishedRequest) {
    db.run(
      `INSERT INTO publication_requests (dataset_id, requested_by, status, approved_at, steps_completed)
       VALUES (?, ?, 'published', '2026-10-05 12:00:00', '["repo_public"]')`,
      [id, ownerId],
    );
  }
}

/** nm000289 after `nemar admin repo private` on 2026-10-29: private everywhere, still "published". */
function seedMixedState(): void {
  seedDataset(ID, { visibility: "private", publishedRequest: true });
  s3.policy = buildPublicAccessPolicy(BUCKET, [ID]);
}

/** nm000289 as it was between 2026-10-05 and 2026-10-29: published and public. */
function seedPublished(): void {
  seedDataset(ID, { visibility: "public", publishedRequest: true });
  s3.policy = buildPublicAccessPolicy(BUCKET, []);
}

const row = () =>
  db
    .query<
      {
        visibility: string;
        concept_doi: string | null;
        ezid_status: string | null;
        first_published_at: string | null;
      },
      [string]
    >(
      "SELECT visibility, concept_doi, ezid_status, first_published_at FROM datasets WHERE dataset_id = ?",
    )
    .get(ID);

const requests = () =>
  db
    .query<{ status: string; unpublished_at: string | null }, [string]>(
      "SELECT status, unpublished_at FROM publication_requests WHERE dataset_id = ? ORDER BY id",
    )
    .all(ID);

const versions = () =>
  db
    .query<{ doi: string; ezid_status: string | null }, [string]>(
      "SELECT doi, ezid_status FROM dataset_versions WHERE dataset_id = ?",
    )
    .all(ID);

const visibilityPatches = () =>
  github.calls
    .filter((c) => c.method === "PATCH" && c.body !== null && "private" in c.body)
    .map((c) => c.body?.private);

describe("the incident: a bare private flip leaves a published record behind", () => {
  test("the half state reports a finished publication of a dataset nobody can reach", async () => {
    seedMixedState();

    // What the owner sees: the catalog row is private...
    expect(row()?.visibility).toBe("private");
    // ...but the publication record still says published, with DOIs and versions behind it.
    const status = await call(`/datasets/${ID}/publish/status`, OWNER_KEY);
    expect(status.body.status).toBe("published");
    expect(row()?.concept_doi).toBe(CONCEPT);
    expect(versions()).toEqual([{ doi: VERSION_DOI, ezid_status: "public" }]);
  });

  test("the owner, an administrator and a collaborator CAN read it (it was never a visibility bug)", async () => {
    seedMixedState();
    db.run(
      "INSERT INTO dataset_collaborators (dataset_id, user_id, granted_by, access_type) SELECT d.id, u.id, d.owner_user_id, 'invited' FROM datasets d, users u WHERE d.dataset_id = ? AND u.username = 'collab'",
      [ID],
    );

    for (const key of [OWNER_KEY, ADMIN_KEY, COLLAB_KEY]) {
      const info = await call(`/datasets/${ID}`, key);
      expect(info.status).toBe(200);
      expect(info.body.dataset.dataset_id).toBe(ID);
    }
    // The owner's own listing and an administrator's catalog listing both carry it.
    const mine = await call("/datasets?mine=true", OWNER_KEY);
    expect(mine.body.datasets.map((d: Json) => d.dataset_id)).toEqual([ID]);
    const adminList = await call("/datasets", ADMIN_KEY);
    expect(adminList.body.datasets.map((d: Json) => d.dataset_id)).toContain(ID);
    // The owner sees and can act on the pending access request.
    const pending = await call(`/datasets/${ID}/access-requests`, OWNER_KEY);
    expect(pending.status).toBe(200);
    // A stranger gets "not found", as for any private dataset.
    const anon = await app.request(`/datasets/${ID}`, {}, env());
    expect(anon.status).toBe(404);
  });

  test("the semantic search is public-only for everyone, owner and administrator included", async () => {
    seedMixedState();
    for (const key of [OWNER_KEY, ADMIN_KEY]) {
      const found = await call("/datasets/search?q=Name", key);
      expect(found.status).toBe(200);
      expect(found.body.results.map((r: Json) => r.dataset_id)).not.toContain(ID);
    }
  });
});

describe("unpublish a published, public dataset", () => {
  test("a dry run plans the change and writes nothing", async () => {
    seedPublished();

    const r = await unpublish(ID, {});

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dry_run: true,
      case: "published",
      visibility: { status: "planned" },
      publication_requests_reset: 1,
      dois_untouched: { concept: CONCEPT, versions: 1 },
    });
    expect(row()?.visibility).toBe("public");
    expect(requests()).toEqual([{ status: "published", unpublished_at: null }]);
    expect(github.writes()).toEqual([]);
    expect(s3.calls).toEqual([]);
  });

  test("execute makes it private everywhere, resets the record, and leaves every DOI alone", async () => {
    seedPublished();

    const r = await unpublish(ID, { reason: "authors asked to pull it back", dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dry_run: false,
      case: "published",
      visibility: { status: "ok" },
      publication_requests_reset: 1,
    });
    // GitHub, S3 and D1 agree.
    expect(visibilityPatches()).toEqual([true]);
    expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(true);
    expect(row()?.visibility).toBe("private");
    // The publication record is reset but kept: the request stays `published`, stamped.
    const [req] = requests();
    expect(req.status).toBe("published");
    expect(req.unpublished_at).not.toBeNull();
    // The DOIs and the publication stamp are exactly as they were. EZID was not called
    // (the afterEach checks no request left for a host that is not a stand-in).
    expect(row()).toMatchObject({
      concept_doi: CONCEPT,
      ezid_status: "public",
      first_published_at: "2026-10-05 12:00:00",
    });
    expect(versions()).toEqual([{ doi: VERSION_DOI, ezid_status: "public" }]);
    // The repository's branch lock is released for the owner: no branch ruleset is left.
    expect((github.rulesets.get(ID) ?? []).map((x) => x.name)).not.toContain("main-protection");
    // One audit row names the act and the reason.
    const audit = db
      .query<{ details: string; user_id: number }, []>(
        "SELECT details, user_id FROM audit_log WHERE action = 'dataset_unpublished'",
      )
      .all();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].details)).toMatchObject({
      reason: "authors asked to pull it back",
      case: "published",
      ezid_called: false,
    });
  });

  test("afterwards it is an ordinary unpublished dataset: findable, listed, and publishable again", async () => {
    seedPublished();
    // While published and public, a new request is refused.
    const before = await call(`/datasets/${ID}/publish/request`, OWNER_KEY, "POST", {});
    expect(before.status).toBe(409);
    expect(before.body.error).toBe("Dataset is already published");

    await unpublish(ID, { reason: "authors asked", dry_run: false });

    // `publish status` no longer reports a publication.
    const status = await call(`/datasets/${ID}/publish/status`, OWNER_KEY);
    expect(status.body.status).toBe("none");
    expect(status.body.unpublished_at).not.toBeNull();
    // The owner finds it, in `info` and in their own listing; an administrator in the catalog.
    expect((await call(`/datasets/${ID}`, OWNER_KEY)).status).toBe(200);
    const mine = await call("/datasets?mine=true", OWNER_KEY);
    expect(mine.body.datasets.map((d: Json) => d.dataset_id)).toEqual([ID]);
    const adminList = await call("/datasets", ADMIN_KEY);
    expect(adminList.body.datasets.map((d: Json) => d.dataset_id)).toContain(ID);
    // The anonymous public no longer sees it.
    expect((await app.request(`/datasets/${ID}`, {}, env())).status).toBe(404);
    // A new publication request is no longer refused as "already published". (What it does
    // next depends on GitHub's CI state, which the stand-in does not model.)
    const again = await call(`/datasets/${ID}/publish/request`, OWNER_KEY, "POST", {});
    expect(again.status).not.toBe(409);
    expect(again.body.error).not.toBe("Dataset is already published");
  });
});

describe("publish status of a dataset made public again", () => {
  test("a published request with unpublished_at is not reported as unpublished once the dataset is public (MUTATION: drop the visibility term)", async () => {
    seedPublished();
    await unpublish(ID, { reason: "authors asked", dry_run: false });
    expect((await call(`/datasets/${ID}/publish/status`, OWNER_KEY)).body.status).toBe("none");
    // `make-public` after an unpublish: public again, the request row still dated.
    db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?", [ID]);
    const status = await call(`/datasets/${ID}/publish/status`, OWNER_KEY);
    expect(status.body.status).toBe("published");
  });
});

describe("repair the half state nm000289 was left in", () => {
  test("a private dataset with a live published record is reset, and its visibility re-applied", async () => {
    seedMixedState();

    const dry = await unpublish(ID, {});
    expect(dry.body).toMatchObject({ case: "private-with-live-publication-record" });

    const r = await unpublish(ID, { reason: "repair of the 2026-10-29 bare flip", dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      case: "private-with-live-publication-record",
      visibility: { status: "ok" },
      publication_requests_reset: 1,
    });
    expect(requests()[0].unpublished_at).not.toBeNull();
    expect(row()).toMatchObject({
      visibility: "private",
      concept_doi: CONCEPT,
      ezid_status: "public",
    });
    expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(true);
    // Every surface was private already: nothing on GitHub or S3 is rewritten.
    expect(visibilityPatches()).toEqual([]);
    expect(s3.puts).toEqual([]);
    expect((await call(`/datasets/${ID}/publish/status`, OWNER_KEY)).body.status).toBe("none");
    expect(versions()).toEqual([{ doi: VERSION_DOI, ezid_status: "public" }]);
  });

  test("running it twice is safe: the second run finds nothing left to do", async () => {
    seedMixedState();
    await unpublish(ID, { reason: "first", dry_run: false });

    const second = await unpublish(ID, { reason: "second", dry_run: false });

    expect(second.status).toBe(200);
    expect(second.body.skipped).toContain("already private");
    expect(
      db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'dataset_unpublished'").get(),
    ).toEqual({ n: 1 });
  });
});

describe("a dataset that is public but was never published", () => {
  test("is simply made private (the old `repo private` case)", async () => {
    seedDataset(ID, { visibility: "public", doi: false });
    s3.policy = buildPublicAccessPolicy(BUCKET, []);

    const r = await unpublish(ID, { reason: "listed by mistake", dry_run: false });

    expect(r.body).toMatchObject({
      case: "public-never-published",
      visibility: { status: "ok" },
      publication_requests_reset: 0,
      dois_untouched: { concept: null, versions: 0 },
    });
    expect(row()?.visibility).toBe("private");
    expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(true);
  });
});

describe("what unpublish refuses", () => {
  test("a reason is required to execute", async () => {
    seedPublished();
    const r = await unpublish(ID, { dry_run: false });
    expect(r.status).toBe(400);
    expect(row()?.visibility).toBe("public");
  });

  test("only an administrator may call it", async () => {
    seedPublished();
    const r = await unpublish(ID, { reason: "x", dry_run: false }, OWNER_KEY);
    expect(r.status).toBe(403);
    expect(row()?.visibility).toBe("public");
  });

  test("an unknown dataset is a skip with a reason, not a crash", async () => {
    const r = await unpublish("nm000999", { reason: "x", dry_run: false });
    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe("Dataset not found");
  });

  test("a live dataset is never touched", async () => {
    seedDataset("nm000104", { visibility: "public", publishedRequest: true });
    const r = await unpublish("nm000104", { reason: "x", dry_run: false });
    expect(r.body.skipped).toContain("live dataset");
    expect(db.query("SELECT visibility FROM datasets WHERE dataset_id = 'nm000104'").get()).toEqual(
      { visibility: "public" },
    );
    expect(github.calls).toEqual([]);
  });

  test("a withdrawn dataset is pointed at restore", async () => {
    seedDataset(ID, {
      visibility: "private",
      publishedRequest: true,
      source: { withdrawn_at: "2026-10-01 00:00:00", withdrawn_reason: "broken" },
    });
    const r = await unpublish(ID, { reason: "x", dry_run: false });
    expect(r.body.skipped).toContain("repo restore");
    expect(requests()[0].unpublished_at).toBeNull();
  });

  test("an exemplar is permanent", async () => {
    seedDataset(ID, { visibility: "public", source: { is_exemplar: 1 } });
    const r = await unpublish(ID, { reason: "x", dry_run: false });
    expect(r.body.skipped).toContain("exemplar");
  });

  test("a private dataset with nothing to reset is a no-op", async () => {
    seedDataset(ID, { visibility: "private", doi: false });
    const r = await unpublish(ID, { reason: "x", dry_run: false });
    expect(r.body.skipped).toContain("nothing to unpublish");
    expect(github.calls).toEqual([]);
  });
});

describe("a failure at a visibility stage writes nothing else", () => {
  test("no repository: 400, the record is untouched and a retry starts from the same state", async () => {
    seedPublished();
    db.run("UPDATE datasets SET github_repo = NULL WHERE dataset_id = ?", [ID]);

    const r = await unpublish(ID, { reason: "x", dry_run: false });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Dataset has no GitHub repository");
    expect(r.body.visibility).toMatchObject({ status: "failed", stage: "no_repo" });
    expect(requests()).toEqual([{ status: "published", unpublished_at: null }]);
    expect(row()?.visibility).toBe("public");
    expect(
      db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'dataset_unpublished'").get(),
    ).toEqual({ n: 0 });
  });
});

/** Nothing in the call made the dataset public, even for a moment, on any surface. */
function expectNeverPublic(): void {
  expect(visibilityPatches()).not.toContain(false);
  expect(github.repoPrivate.get(ID)).toBe(true);
  for (const policy of s3.puts) expect(isDatasetPrivate(policy, BUCKET, ID)).toBe(true);
  expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(true);
}

describe("a failure never reverts a surface to public (the already-private repair)", () => {
  test("already private on every surface, S3 writes failing: nothing is written, nothing goes public", async () => {
    seedMixedState();
    s3.failPuts = true;

    const r = await unpublish(ID, { reason: "repair", dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body.visibility).toEqual({ status: "ok" });
    expectNeverPublic();
    expect(requests()[0].unpublished_at).not.toBeNull();
  });

  test("GitHub private but S3 and D1 still public, S3 write fails: GitHub is not reverted to public", async () => {
    seedDataset(ID, { visibility: "public", publishedRequest: true });
    s3.policy = buildPublicAccessPolicy(BUCKET, []);
    github.repoPrivate.set(ID, true);
    s3.failPuts = true;

    const r = await unpublish(ID, { reason: "repair", dry_run: false });

    expect(r.status).toBe(500);
    expect(r.body.visibility).toMatchObject({
      status: "failed",
      stage: "s3",
      githubReverted: true,
    });
    // GitHub was already private, so it was neither changed nor reverted.
    expect(visibilityPatches()).toEqual([]);
    expect(github.repoPrivate.get(ID)).toBe(true);
    expect(row()?.visibility).toBe("public");
    expect(requests()[0].unpublished_at).toBeNull();
  });

  test("GitHub private, S3 and D1 public, D1 write fails: S3 is put back to its prior state, GitHub is untouched", async () => {
    seedDataset(ID, { visibility: "public", publishedRequest: true });
    s3.policy = buildPublicAccessPolicy(BUCKET, []);
    github.repoPrivate.set(ID, true);
    db.run(
      `CREATE TRIGGER force_visibility_failure BEFORE UPDATE OF visibility ON datasets
       BEGIN SELECT RAISE(ABORT, 'forced D1 failure'); END`,
    );

    const r = await unpublish(ID, { reason: "repair", dry_run: false });

    expect(r.status).toBe(500);
    expect(r.body.visibility).toMatchObject({
      status: "failed",
      stage: "db",
      githubReverted: true,
      s3Reverted: true,
    });
    // GitHub: no write at all. S3: made private, then restored to what it was (public).
    expect(visibilityPatches()).toEqual([]);
    expect(github.repoPrivate.get(ID)).toBe(true);
    expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(false);
    expect(row()?.visibility).toBe("public");
  });

  test("a public dataset whose D1 write fails is restored to public on both surfaces it moved", async () => {
    seedPublished();
    db.run(
      `CREATE TRIGGER force_visibility_failure BEFORE UPDATE OF visibility ON datasets
       BEGIN SELECT RAISE(ABORT, 'forced D1 failure'); END`,
    );

    const r = await unpublish(ID, { reason: "x", dry_run: false });

    expect(r.status).toBe(500);
    expect(r.body.visibility).toMatchObject({
      stage: "db",
      githubReverted: true,
      s3Reverted: true,
    });
    expect(github.repoPrivate.get(ID)).toBe(false);
    expect(isDatasetPrivate(s3.policy, BUCKET, ID)).toBe(false);
  });

  test("already private on every surface, D1 forced to fail on the record reset: structured failure, nothing public", async () => {
    seedMixedState();
    db.run(
      `CREATE TRIGGER force_reset_failure BEFORE UPDATE ON publication_requests
       BEGIN SELECT RAISE(ABORT, 'forced D1 failure'); END`,
    );

    const r = await unpublish(ID, { reason: "repair", dry_run: false });

    expect(r.status).toBe(500);
    expect(r.body.error).toContain("publication record not reset");
    expect(r.body.error).toContain("re-run unpublish");
    expect(r.body.visibility).toEqual({ status: "ok" });
    expect(r.body.publication_requests_reset).toBe(0);
    expectNeverPublic();
    // The batch is atomic: the request is not stamped, and a re-run finishes the job.
    expect(requests()[0].unpublished_at).toBeNull();
    db.run("DROP TRIGGER force_reset_failure");
    const again = await unpublish(ID, { reason: "repair", dry_run: false });
    expect(again.status).toBe(200);
    expect(requests()[0].unpublished_at).not.toBeNull();
  });
});

describe("more refusals", () => {
  test.each(["requested", "approving", "blocked"])(
    "an open publication request (%s) is refused with the deny hint",
    async (status) => {
      seedDataset(ID, { visibility: "private", doi: false });
      db.run(
        "INSERT INTO publication_requests (dataset_id, requested_by, status) VALUES (?, ?, ?)",
        [ID, ownerId, status],
      );
      db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?", [ID]);

      const r = await unpublish(ID, { reason: "x", dry_run: false });

      expect(r.status).toBe(200);
      expect(r.body.skipped).toContain("publication request is open");
      expect(r.body.skipped).toContain("nemar admin repo publish deny");
      expect(github.calls).toEqual([]);
      expect(row()?.visibility).toBe("public");
    },
  );

  test.each(["nm099900", "nm099950", "nm099999", "xx099900", "xx099999"])(
    "the reserved fixture %s is never unpublished",
    async (id) => {
      seedDataset(id, { visibility: "public", doi: false });
      const r = await unpublish(id, { reason: "x", dry_run: false });
      expect(r.body.skipped).toContain("reserved fixture band");
      expect(github.calls).toEqual([]);
    },
  );

  test("an anonymous deposit is never unpublished", async () => {
    seedDataset(ID, { visibility: "public", doi: false, source: { anonymous: 1 } });
    github.repoPrivate.set(ID, true);
    const r = await unpublish(ID, { reason: "x", dry_run: false });
    expect(r.body.skipped).toContain("anonymous deposit");
    expect(github.writes()).toEqual([]);
    expect(row()?.visibility).toBe("public");
  });

  test("a body that fails the schema returns { error } as a string", async () => {
    seedPublished();
    const bad = await unpublish(ID, { dry_run: "yes" });
    expect(bad.status).toBe(400);
    expect(typeof bad.body.error).toBe("string");
    expect(bad.body.error).toContain("dry_run");
  });
});

describe("spec enforcement failures are surfaced as a warning", () => {
  test("a failed ruleset step appears in the result and the audit row", async () => {
    seedPublished();
    github.failNext("DELETE", /\/rulesets\/\d+$/, 403, 10);
    // Give the repository a branch ruleset for enforcement to remove (and fail to).
    github.rulesets.set(ID, [
      {
        id: 4242,
        name: "NEMAR branch protection",
        source_type: "Repository",
        body: { name: "NEMAR branch protection", target: "branch", enforcement: "active" },
      },
    ]);

    const r = await unpublish(ID, { reason: "x", dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body.visibility).toEqual({ status: "ok" });
    expect(r.body.warning).toContain("Repo-spec enforcement steps failed");
    const audit = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'dataset_unpublished'",
      )
      .get();
    expect(JSON.parse(audit?.details ?? "{}").spec_warning).toContain("steps failed");
  });
});

describe("decideUnpublish (the pure decision)", () => {
  const base = {
    datasetId: ID,
    visibility: "public",
    withdrawnAt: null,
    isExemplar: false,
    liveRequests: 1,
  };
  test.each([
    [{}, "published"],
    [{ liveRequests: 0 }, "public-never-published"],
    [{ visibility: "private" }, "private-with-live-publication-record"],
  ])("%j is %s", (over, expected) => {
    expect(decideUnpublish({ ...base, ...over })).toEqual({ case: expected as never });
  });
});
