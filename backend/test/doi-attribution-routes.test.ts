/**
 * What actually reaches EZID from the three DOI paths that were untested
 * (#1255 review item 13): the concept metadata refresh, its per-version loop,
 * and the exemplar re-mint.
 *
 * These are the paths that rebuild a DataCite document from live database
 * state. They are the ones where a username could leak into a permanent
 * record, and -- since #1255 -- the ones where a nameless owner could strip
 * an existing DataCurator off a record that already has one. Nothing below
 * asserts on an intermediate helper: each test drives the real Hono route and
 * inspects the bytes the Worker PUT to EZID.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration, the
 * real admin router with real auth middleware and hashed tokens, and two
 * local `Bun.serve()` upstreams standing in for GitHub and EZID (the latter
 * via NEMAR_EZID_API_URL, added for this). Both speak the real wire formats
 * -- GitHub's git/trees + blobs JSON, EZID's ANVL -- so the production
 * request/parse path runs end to end.
 *
 * ONE COVERAGE GAP, and it is not fixable from here: the metadata refresh's
 * happy path needs a REAL `getTreeAtRef`, and
 * backend/test/manifest-small-root-files.test.ts installs a process-wide
 * `mock.module("../src/services/github", ...)` whose `getTreeAtRef` returns
 * an empty array. `mock.module` is permanent for the process (neither
 * `mock.restore()` nor re-registering the real namespace undoes it) and
 * `test/` + `backend/test/` share one, so every later file sees an empty
 * tree. A refresh test asserting on the rebuilt XML therefore passes alone
 * and fails in a full run. The equivalent assertion -- real name in, username
 * nowhere -- is made instead on the two paths that do NOT need a tree: the
 * concept mint and the exemplar re-mint. The refresh's own SKIP behaviour,
 * which is the new logic, needs no tree and is asserted directly below.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "attrib-admin-key-0123456789abcdef0123456789abc";
const OWNER_USERNAME = "zqxcurator9";
const DATASET_ID = "nm000282";
const EXEMPLAR_ID = "xx099901";
const ORCID = "0000-0002-1825-0097";

/** Every ANVL body the Worker PUT/POSTed to EZID, newest last. */
let ezidWrites: { path: string; body: string }[] = [];
let servers: ReturnType<typeof Bun.serve>[] = [];
let ghBase: string;
let ezidBase: string;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

const BIDS = JSON.stringify({
  Name: "A dataset with a long enough descriptive name",
  Authors: ["Smith, John"],
  License: "CC0",
});

/** The DataCite XML from the most recent EZID write, or null. */
function lastDataciteXml(): string | null {
  const last = ezidWrites.at(-1);
  if (!last) return null;
  // ANVL escapes newlines as %0A within a value; decode enough to read it.
  const line = last.body.split("\n").find((l) => l.startsWith("datacite:"));
  return line ? decodeURIComponent(line.slice("datacite:".length).trim()) : null;
}

beforeAll(() => {
  const gh = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // getTreeAtRef resolves the ref to a commit first.
      if (url.pathname.includes("/commits/main")) {
        return Response.json({ sha: "commitsha", commit: { tree: { sha: "treesha" } } });
      }
      // Tree listing for the dataset repo.
      if (url.pathname.includes("/git/trees/")) {
        return Response.json({
          tree: [{ path: "dataset_description.json", sha: "descsha", type: "blob" }],
        });
      }
      // Blob content, base64 like the real API.
      if (url.pathname.includes("/git/blobs/descsha")) {
        return Response.json({ content: btoa(BIDS), encoding: "base64" });
      }
      if (url.pathname.endsWith("/contents/dataset_description.json")) {
        return Response.json({ content: btoa(BIDS), encoding: "base64" });
      }
      // The enrichment route commits `.nemar/metadata.json`. The tree walk
      // above reports no `.bidsignore`, so `.nemar/` is added and the commit
      // takes BATCHED mode: resolve the branch ref, read its commit, create a
      // tree, create a commit, move the ref. Then a PUT for the single-file
      // fallback, which the batched path does not reach but which costs one
      // line to support.
      if (url.pathname.endsWith("/branches/main")) {
        return Response.json({
          commit: { sha: "commitsha", commit: { tree: { sha: "treesha" } } },
        });
      }
      if (req.method === "POST" && url.pathname.endsWith("/git/trees")) {
        return Response.json({ sha: "newtreesha" });
      }
      if (req.method === "POST" && url.pathname.endsWith("/git/commits")) {
        return Response.json({ sha: "newcommitsha" });
      }
      if (req.method === "PATCH" && url.pathname.includes("/git/refs/heads/main")) {
        return Response.json({ object: { sha: "newcommitsha" } });
      }
      if (req.method === "PUT" && url.pathname.includes("/contents/")) {
        return Response.json({ content: { sha: "newsha" }, commit: { sha: "commitsha" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const ezid = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? "" : await req.text();
      if (req.method !== "GET") ezidWrites.push({ path: url.pathname, body });
      const id = decodeURIComponent(url.pathname.replace(/^\/id\//, ""));
      // ANVL: a status line, then the record's fields.
      return new Response(
        `success: ${id}\n_status: reserved\n_target: https://nemar.org/dataset/${DATASET_ID}\n_profile: datacite\n_created: 1700000000\n_updated: 1700000000\n`,
        { status: 200, headers: { "Content-Type": "text/plain" } },
      );
    },
  });
  servers = [gh, ezid];
  ghBase = `http://localhost:${gh.port}`;
  ezidBase = `http://localhost:${ezid.port}`;
});

/**
 * GitHub is intercepted by PATCHING `globalThis.fetch` for the duration of a
 * call, not by the NEMAR_GITHUB_API_URL global.
 *
 * `test/` and `backend/test/` share one bun process, and several files patch
 * `globalThis.fetch` themselves. A leftover patch from an earlier file
 * answers `api.github.com` before the URL override is ever consulted, which
 * showed up as this file passing alone and failing in a full-suite run with
 * "dataset_description.json not found" while our fixture server logged zero
 * hits. Patching per call puts us at the FRONT of that chain -- we capture
 * whatever `fetch` currently is, intercept only GitHub, delegate the rest,
 * and restore in `finally` so we do not become the next file's problem.
 *
 * EZID keeps the NEMAR_EZID_API_URL seam: nothing else in the suite touches
 * that host.
 */
async function withFakeGithub<T>(fn: () => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.github.com") {
      const local = new URL(url.pathname + url.search, ghBase);
      return previousFetch(new Request(local, req));
    }
    return previousFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

afterAll(() => {
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = undefined;
  for (const s of servers) s.stop(true);
});

async function seedAdmin() {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('attribadmin', 'attribadmin@example.org', 'x', 'approved', 'admin', 1, 'Root', 'Admin')`,
  ).run();
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='attribadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function seedOwner(given: string | null, family: string | null) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, orcid)
     VALUES (?, ?, 'x', 'approved', 'member', 1, ?, ?, ?)`,
  ).run(OWNER_USERNAME, `${OWNER_USERNAME}@example.org`, given, family, ORCID);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(OWNER_USERNAME);
  if (!u) throw new Error("seed: owner insert failed");
  ownerId = u.id;
}

function seedDataset(
  id: string,
  opts: {
    conceptDoi?: string | null;
    isExemplar?: number;
    isSandbox?: number;
    source?: string | null;
    anonymous?: number;
  } = {},
) {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox, visibility,
                           status, concept_doi, is_exemplar, source, ezid_status, anonymous)
     VALUES (?, 'Attribution Fixture Dataset', ?, ?, ?, 'public', 'active', ?, ?, ?, 'reserved', ?)`,
  ).run(
    id,
    ownerId,
    `nemarDatasets/${id}`,
    opts.isSandbox ?? 0,
    opts.conceptDoi ?? null,
    opts.isExemplar ?? 0,
    opts.source ?? null,
    opts.anonymous ?? 0,
  );
}

function seedVersion(id: string, version: string, doi: string) {
  db.query(
    "INSERT INTO dataset_versions (dataset_id, version, doi, created_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(id, version, doi);
}

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "test-pat",
    EZID_USERNAME: "ezid-user",
    EZID_PASSWORD: "ezid-pass",
    EZID_SANDBOX_USERNAME: "ezid-sandbox-user",
    EZID_SANDBOX_PASSWORD: "ezid-sandbox-pass",
    FRONTEND_URL: "https://nemar.org",
  } as Bindings;
}

function post(path: string, body: unknown): Promise<Response> {
  return withFakeGithub(() =>
    app.request(
      path,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      env(),
    ),
  );
}

beforeEach(async () => {
  // Claimed per test: another file's afterAll may have cleared it.
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = ezidBase;
  db = freshDb();
  ezidWrites = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/datasets/:id/doi/concept (the mint)", () => {
  test("cites the owner by real name, and the username never reaches EZID", async () => {
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID);

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, {
      sandbox: true,
      skip_enrichment_check: true,
    });
    expect(res.status).toBe(200);

    const xml = lastDataciteXml();
    expect(xml).toContain('<contributor contributorType="DataCurator">');
    expect(xml).toContain("Doe, Jane");
    expect(xml).toContain("<givenName>Jane</givenName>");
    expect(xml).toContain("<familyName>Doe</familyName>");
    expect(xml).toContain(ORCID);
    expect(xml).not.toContain(OWNER_USERNAME);
  });

  test("an exempt deposit with a nameless owner mints unattributed, not by username", async () => {
    seedOwner(null, null);
    seedDataset(DATASET_ID, { source: "openneuro" });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, {
      sandbox: true,
      skip_enrichment_check: true,
    });
    expect(res.status).toBe(200);

    const xml = lastDataciteXml();
    expect(xml).not.toContain("DataCurator");
    expect(xml).not.toContain(OWNER_USERNAME);
    expect(xml).toContain("HostingInstitution");
  });
});

describe("the mint of an anonymous deposit names nobody (#1408)", () => {
  // The single irreversible write in this feature. A DataCite record is
  // harvested and snapshotted, so a creator or DataCurator that reaches EZID
  // here cannot be recalled by de-anonymizing later. `createConceptDoi` takes
  // one boolean to decide it (`doi.ts`: `const curator =
  // options.anonymousDeposit ? null : ...`), and until now nothing asserted
  // what that boolean does to the bytes.

  test("no curator, no name, no ORCID, no username reaches EZID", async () => {
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { anonymous: 1 });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, {
      sandbox: true,
      skip_enrichment_check: true,
    });
    expect(res.status).toBe(200);

    const xml = lastDataciteXml();
    expect(xml).not.toContain("DataCurator");
    expect(xml).not.toContain("Doe, Jane");
    expect(xml).not.toContain("Jane");
    expect(xml).not.toContain("Doe");
    expect(xml).not.toContain(ORCID);
    expect(xml).not.toContain(OWNER_USERNAME);
    // ADR 0041's "not at all" branch: the record still has a hosting
    // institution, so it is a valid DataCite document, just an unattributed
    // one.
    expect(xml).toContain("HostingInstitution");
  });

  test("the identifier stays RESERVED, which is what keeps it unharvested", async () => {
    // `reserved` means registered but not advertised: it does not resolve and
    // DataCite does not harvest it. That is the whole reason a blinded deposit
    // may hold an identifier at all (ADR 0065).
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { anonymous: 1 });
    await post(`/admin/datasets/${DATASET_ID}/doi/concept`, {
      sandbox: true,
      skip_enrichment_check: true,
    });
    expect(ezidWrites.at(-1)?.body).toContain("_status: reserved");
  });

  test("the SAME owner on a non-anonymous dataset is cited in full", async () => {
    // The control, and the only thing that makes the assertions above mean
    // something: the difference is one column, not a missing fixture.
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { anonymous: 0 });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, {
      sandbox: true,
      skip_enrichment_check: true,
    });
    expect(res.status).toBe(200);
    const xml = lastDataciteXml();
    expect(xml).toContain('<contributor contributorType="DataCurator">');
    expect(xml).toContain("Doe, Jane");
    expect(xml).toContain(ORCID);
  });
});

describe("the update route refuses to publish or rebuild a concealed record", () => {
  test("status: public is refused, and NOTHING is sent to EZID", async () => {
    // The zero-writes assertion is the point: a guard that ran after the write
    // would satisfy a status-code-only test while the record was already
    // public and harvested.
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282", anonymous: 1 });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/update`, { status: "public" });
    expect(res.status).toBe(409);
    expect(ezidWrites.length).toBe(0);
  });

  test("refresh_metadata is refused, and NOTHING is sent to EZID", async () => {
    // A refresh rebuilds the whole document from `resolveOwnerIdentity` -- the
    // real person -- so it is the other way the name reaches a permanent
    // record.
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282", anonymous: 1 });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/update`, { refresh_metadata: true });
    expect(res.status).toBe(409);
    expect(ezidWrites.length).toBe(0);
  });

  test("the same two calls on a non-anonymous dataset are not refused", async () => {
    // The control. Without it a route that 409'd every update would pass.
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282", anonymous: 0 });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/update`, { status: "public" });
    expect(res.status).not.toBe(409);
    expect(ezidWrites.length).toBeGreaterThan(0);
  });
});

describe("the admin enrichment route blinds what it CACHES, not only what it commits", () => {
  // `admin/doi.ts` is the second writer of `.nemar/metadata.json`: it accepts
  // a document from an admin and commits it to the same publicly-served path
  // the pipeline writes. Both halves matter and they are separate writes --
  // the committed file, and `datasets.enrichment_json`, which `GET
  // /datasets/:id` serves raw. A blind applied to one and not the other leaves
  // the depositor named on whichever surface was missed, which is why the
  // route builds ONE value and uses it twice. Asserted here on the D1 half,
  // which is the one a test can read back.
  const NAMED = {
    version: "2.0",
    title: "A dataset with a long enough descriptive name",
    authors: { "Doe, Jane": { orcid: ORCID } },
    funding_references: [{ funder_name: "A Named Foundation", award_number: "GRANT-1" }],
    geo_locations: [{ place: "La Jolla, California" }],
    contributors: [{ name: "Doe, Jane", contributor_type: "DataCurator" }],
  };

  function cached(): string | null {
    return (
      db
        .query<{ enrichment_json: string | null }, [string]>(
          "SELECT enrichment_json FROM datasets WHERE dataset_id = ?",
        )
        .get(DATASET_ID)?.enrichment_json ?? null
    );
  }

  test("an anonymous deposit caches no author, funder or place", async () => {
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { anonymous: 1 });

    const res = await post(`/admin/datasets/${DATASET_ID}/enrichment`, NAMED);
    expect(res.status).toBe(200);

    // Asserted on the stored BYTES rather than a parsed shape: a name that
    // survived under an unexpected key would still be served.
    const stored = cached();
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("Doe, Jane");
    expect(stored).not.toContain(ORCID);
    expect(stored).not.toContain("A Named Foundation");
    expect(stored).not.toContain("La Jolla");
  });

  test("the same document on a non-anonymous dataset is cached in full", async () => {
    // The control. Without it a route that stored an empty document for
    // everything would satisfy the assertions above.
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { anonymous: 0 });

    const res = await post(`/admin/datasets/${DATASET_ID}/enrichment`, NAMED);
    expect(res.status).toBe(200);
    const stored = cached();
    expect(stored).toContain("Doe, Jane");
    expect(stored).toContain(ORCID);
    expect(stored).toContain("A Named Foundation");
    expect(stored).toContain("La Jolla");
  });
});

describe("POST /admin/datasets/:id/doi/update (metadata refresh)", () => {
  test("a nameless owner SKIPS the refresh instead of stripping the curator", async () => {
    // The regression this test exists for: rebuilding from a nameless owner
    // produces a record with no DataCurator, and pushing it deletes the
    // curator from a permanent DOI.
    seedOwner(null, null);
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282" });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/update`, {
      refresh_metadata: true,
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      metadata_refresh: { status: string; reason: string };
    };
    expect(body.metadata_refresh).toEqual({
      status: "skipped",
      reason: "owner_name_missing",
    });
    // Nothing was sent to EZID at all.
    expect(ezidWrites).toHaveLength(0);
  });

  test("the per-version loop is skipped too, so version DOIs keep their curator", async () => {
    seedOwner(null, null);
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282" });
    seedVersion(DATASET_ID, "1.0.0", "10.82901/NEMAR.NM000282.V1.0.0");
    seedVersion(DATASET_ID, "1.1.0", "10.82901/NEMAR.NM000282.V1.1.0");

    await post(`/admin/datasets/${DATASET_ID}/doi/update`, { refresh_metadata: true });

    expect(ezidWrites).toHaveLength(0);
  });

  test("a status-only change still proceeds, and reports the skipped refresh", async () => {
    seedOwner(null, null);
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282" });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/update`, {
      refresh_metadata: true,
      status: "public",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata_refreshed: boolean;
      metadata_refresh?: { status: string; reason: string };
    };
    expect(body.metadata_refreshed).toBe(false);
    expect(body.metadata_refresh?.reason).toBe("owner_name_missing");
    // The status write happened; no `datacite` payload rode along with it.
    expect(ezidWrites.length).toBeGreaterThan(0);
    expect(ezidWrites.every((w) => !w.body.includes("datacite:"))).toBe(true);
  });
});

describe("POST /admin/datasets/:id/exemplar/remint-dois", () => {
  test("a named owner is cited by real name, never by username", async () => {
    seedOwner("Jane", "Doe");
    seedDataset(EXEMPLAR_ID, { isExemplar: 1, isSandbox: 1 });

    const res = await post(`/admin/datasets/${EXEMPLAR_ID}/exemplar/remint-dois`, {});
    expect(res.status).toBe(200);

    const xml = lastDataciteXml();
    expect(xml).toContain("DataCurator");
    expect(xml).toContain("Doe, Jane");
    expect(xml).not.toContain(OWNER_USERNAME);
  });

  test("a nameless owner mints with NO DataCurator and no username", async () => {
    // Exemplars are exempt from the block (their owner is a service account
    // on the sandbox shoulder), so this must still mint -- unattributed
    // rather than attributed to a login handle.
    seedOwner(null, null);
    seedDataset(EXEMPLAR_ID, { isExemplar: 1, isSandbox: 1 });

    const res = await post(`/admin/datasets/${EXEMPLAR_ID}/exemplar/remint-dois`, {});
    expect(res.status).toBe(200);

    const xml = lastDataciteXml();
    expect(xml).not.toBeNull();
    expect(xml).not.toContain("DataCurator");
    expect(xml).not.toContain(OWNER_USERNAME);
    // The rest of the record is intact.
    expect(xml).toContain("HostingInstitution");
  });
});
