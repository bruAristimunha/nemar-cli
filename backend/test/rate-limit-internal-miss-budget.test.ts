/**
 * A request the Worker builds for itself spends no data-plane miss budget, driven
 * through the real data plane (#1709, ADR 0098).
 *
 * `rate-limit-internal.test.ts` shows that the Neurobagel gatherer marks its requests,
 * and calls `checkDataMissBudget` directly; neither shows the budget being reached by
 * a git-tracked file through the real `dataRoutes`. Here a real `Bun.serve()` stands in
 * for the raw content host and the manifest store, the route runs against a real D1,
 * and the miss budget is seeded at its cap for the caller with no address:
 * the marked request is served, the unmarked one is refused.
 *
 * The two cases use different files on purpose. The first served file fills the edge
 * cache, and a second fetch of the same file would be a hit that never reaches the
 * budget, which would make the refusal impossible to see.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { internalRequest } from "../src/lib/internal-request";
import { __limits } from "../src/middleware/rateLimit";
import { dataRoutes } from "../src/routes/data";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { T0, useRateLimitHarness } from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

/** The real `git hash-object` of each body: the route verifies the bytes it brokered. */
const FIRST = {
  path: "dataset_description.json",
  body: '{"Name":"A dataset","BIDSVersion":"1.11.0"}',
  sha: "8cb31ee475b57f9caf41c02a1e4de7862cde420c",
};
const SECOND = {
  path: "CHANGES.md",
  body: "nothing changed",
  sha: "f906b97310d39c554b0f699aea54901533f2076b",
};
const VERSION = "v1.0.0";
const ID = "nm000862";

let server: Server;
let base: string;
const upstream: string[] = [];

const manifest = JSON.stringify({
  dataset_id: ID,
  version: "1.0.0",
  doi: null,
  concept_doi: null,
  created: "2026-01-01T00:00:00Z",
  files: {
    [FIRST.path]: {
      key: `git:${FIRST.sha}`,
      size: FIRST.body.length,
      checksum: `git:${FIRST.sha}`,
    },
    [SECOND.path]: {
      key: `git:${SECOND.sha}`,
      size: SECOND.body.length,
      checksum: `git:${SECOND.sha}`,
    },
  },
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      upstream.push(pathname);
      if (pathname === `/${ID}/version/${VERSION}.json`) return new Response(manifest);
      for (const file of [FIRST, SECOND]) {
        if (pathname === `/nemarDatasets/${ID}/${VERSION}/${file.path}`) {
          return new Response(file.body, {
            headers: { "Content-Length": String(file.body.length) },
          });
        }
      }
      return new Response("no route", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function seedDataset(db: Database): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, 1, 'active', 'public', 0)`,
  ).run(ID, ID);
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
     VALUES (?, '1.0.0', '10.5072/FK2test', 'ezid', datetime('now'))`,
  ).run(ID);
}

function envOf(db: Database): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_RAW_BASE: base,
    S3_ENDPOINT_URL: base,
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "AKIATEST",
    AWS_SECRET_ACCESS_KEY: "secret",
    GITHUB_ADMIN_PAT: "test-pat",
  } as Bindings;
}

const app = () => {
  const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  hono.route("/", dataRoutes);
  return hono;
};

const urlOf = (file: { path: string }) => `http://localhost/${ID}/${VERSION}/${file.path}`;
const WINDOW_END = T0 + __limits.WINDOW_SIZE * 1000;

describe("the miss budget of the caller with no address, through the real data plane", () => {
  test("a marked request is served and spends nothing; an unmarked one is refused", async () => {
    const db = freshDb();
    seedDataset(db);
    const env = envOf(db);
    await h.seed("data-miss-ip:unattributed", {
      count: __limits.DATA_MISS_MAX_REQUESTS,
      warned: false,
      windowEnd: WINDOW_END,
    });

    // The Worker's own request: a real miss, served although the shared budget is spent.
    const marked = await app().fetch(internalRequest(new Request(urlOf(FIRST))), env);
    expect(marked.status).toBe(200);
    expect(await marked.text()).toBe(FIRST.body);
    expect(upstream).toContain(`/nemarDatasets/${ID}/${VERSION}/${FIRST.path}`);
    expect((await h.stored("data-miss-ip:unattributed"))?.count).toBe(
      __limits.DATA_MISS_MAX_REQUESTS,
    );

    // The same kind of request, unmarked and for a file that has not been served: refused,
    // by the miss budget, as the caller that named nobody.
    const unmarked = await app().fetch(new Request(urlOf(SECOND)), env);
    expect(unmarked.status).toBe(429);
    expect(unmarked.headers.get("X-RateLimit-Bucket")).toBe("data-miss-ip");
    expect(unmarked.headers.get("X-RateLimit-Caller")).toBe("unattributed");
    expect(upstream).not.toContain(`/nemarDatasets/${ID}/${VERSION}/${SECOND.path}`);
  });

  test("a marked request that carries an address spends that address's budget", async () => {
    const db = freshDb();
    seedDataset(db);
    const env = envOf(db);
    await h.seed("data-miss-ip:203.0.113.91", {
      count: __limits.DATA_MISS_MAX_REQUESTS,
      warned: false,
      windowEnd: WINDOW_END,
    });
    const res = await app().fetch(
      internalRequest(
        new Request(urlOf(SECOND), { headers: { "CF-Connecting-IP": "203.0.113.91" } }),
      ),
      env,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Caller")).toBe("edge");
  });
});
