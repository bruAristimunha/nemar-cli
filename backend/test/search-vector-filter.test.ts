/**
 * Search visibility in two layers. Layer 1 narrows the Vectorize query by the
 * `visibility` / `dataset_id` labels each vector carries; layer 2 re-checks
 * every hit against the live `datasets` row. Correctness rests on layer 2: a
 * stale "public" label on a dataset that has since gone private must never
 * leak it. The Vectorize binding is a minimal stand-in that applies the
 * filters to the labels it was given and records the filters it was asked for.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SearchDatasetsInput } from "../../shared/contract/mcp";
import { searchDatasetsTool } from "../src/mcp/tools/search-datasets";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import { drainEmbeddingDirty } from "../src/services/dataset-search";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;
type Filter = Record<string, unknown> | undefined;
type Stored = { id: string; metadata: Record<string, unknown> };

const OWNER_KEY = "owner-vecfilter-key-0123456789abcdef0123456789";
const ADMIN_KEY = "admin-vecfilter-key-0123456789abcdef0123456789";

function insertDataset(
  db: Database,
  datasetId: string,
  cols: Record<string, string | number | null> = {},
): void {
  const merged: Record<string, string | number | null> = {
    owner_user_id: -1,
    name: `Quokka ${datasetId}`,
    visibility: "public",
    status: "active",
    is_sandbox: 0,
    ...cols,
  };
  const keys = Object.keys(merged);
  db.query(
    `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
  ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
}

function vectorIndex(stored: Stored[], seen: Filter[]): VectorizeIndex {
  return {
    query: async (_v: unknown, opts: { filter?: Filter }) => {
      seen.push(opts.filter);
      const f = opts.filter;
      const hit = stored.filter((s) => {
        if (!f) return true;
        if ("visibility" in f) return s.metadata.visibility === f.visibility;
        return (f.dataset_id as { $in: string[] }).$in.includes(s.id);
      });
      return { matches: hit.map((s) => ({ id: s.id, score: 0.9 })) };
    },
  } as unknown as VectorizeIndex;
}

const ai = { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai;

describe("vector metadata filter (layer 1) and live re-check (layer 2)", () => {
  let db: Database;
  let app: App;
  let stored: Stored[];
  let seen: Filter[];

  async function run(key: string | null, flag: boolean, index?: VectorizeIndex): Promise<Response> {
    const env = {
      DB: realD1(db),
      ENVIRONMENT: "development",
      AI: ai,
      VECTORIZE: index ?? vectorIndex(stored, seen),
      ...(flag ? { VECTORIZE_VISIBILITY_FILTER: "1" } : {}),
    } as Bindings;
    return app.request(
      "/search?q=quokka&min_score=0",
      key ? { headers: { Authorization: `Bearer ${key}` } } : {},
      env,
    );
  }

  async function ids(key: string | null, flag: boolean, index?: VectorizeIndex): Promise<string[]> {
    const res = await run(key, flag, index);
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: { id: string }[] }).results.map((r) => r.id).sort();
  }

  beforeEach(async () => {
    db = freshDb();
    app = new Hono();
    registerCatalogRoutes(app);
    seen = [];
    const user = db.query(
      "INSERT INTO users (id, username, email, password_hash, status, role, email_verified) VALUES (?, ?, ?, 'x', 'approved', ?, 1)",
    );
    user.run(31, "ownertwo", "o2@example.org", "member");
    user.run(32, "admintwo", "a2@example.org", "admin");
    const token = db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)",
    );
    token.run(31, await hashApiKey(OWNER_KEY), OWNER_KEY.slice(0, 8));
    token.run(32, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));
    insertDataset(db, "nm520001");
    insertDataset(db, "nm520002", { visibility: "private", owner_user_id: 31 });
    insertDataset(db, "nm520003", { visibility: "private", owner_user_id: 99 });
    // nm520004 was public when embedded and is private now: its vector still
    // carries the stale label "public".
    insertDataset(db, "nm520004", { visibility: "private", owner_user_id: 99 });
    stored = [
      { id: "nm520001", metadata: { visibility: "public" } },
      { id: "nm520002", metadata: { visibility: "private" } },
      { id: "nm520003", metadata: { visibility: "private" } },
      { id: "nm520004", metadata: { visibility: "public" } },
    ];
  });

  test("anonymous queries ask for public vectors only, and a stale label does not leak", async () => {
    expect(await ids(null, true)).toEqual(["nm520001"]);
    expect(seen).toEqual([{ visibility: "public" }]);
  });

  test("a signed-in user's query adds the private ids they own", async () => {
    expect(await ids(OWNER_KEY, true)).toEqual(["nm520001", "nm520002"]);
    expect(seen).toContainEqual({ visibility: "public" });
    expect(seen).toContainEqual({ dataset_id: { $in: ["nm520002"] } });
  });

  test("an admin's vector query is unfiltered", async () => {
    expect(await ids(ADMIN_KEY, true)).toEqual(["nm520001", "nm520002", "nm520003", "nm520004"]);
    expect(seen).toEqual([undefined]);
  });

  test("with the filter off the query is unfiltered and the live check alone decides", async () => {
    expect(await ids(null, false)).toEqual(["nm520001"]);
    expect(seen).toEqual([undefined]);
    expect(await ids(OWNER_KEY, false)).toEqual(["nm520001", "nm520002"]);
  });

  test("a filter the index rejects falls back to an unfiltered query, still visibility-safe", async () => {
    const strict = {
      query: async (_v: unknown, opts: { filter?: Filter }) => {
        if (opts.filter) throw new Error("no metadata index");
        return { matches: stored.map((s) => ({ id: s.id, score: 0.9 })) };
      },
    } as unknown as VectorizeIndex;
    expect(await ids(null, true, strict)).toEqual(["nm520001"]);
  });

  test("a filtered query with zero matches retries unfiltered (missing metadata index), still visibility-safe", async () => {
    // A property with no metadata index matches nothing instead of erroring.
    const unindexed = {
      query: async (_v: unknown, opts: { filter?: Filter }) => {
        seen.push(opts.filter);
        return { matches: opts.filter ? [] : stored.map((s) => ({ id: s.id, score: 0.9 })) };
      },
    } as unknown as VectorizeIndex;
    expect(await ids(null, true, unindexed)).toEqual(["nm520001"]);
    expect(seen).toEqual([{ visibility: "public" }, undefined]);
    seen.length = 0;
    expect(await ids(OWNER_KEY, true, unindexed)).toEqual(["nm520001", "nm520002"]);
  });

  test("MCP search_datasets passes the public filter behind the flag, viewer anonymous", async () => {
    const outcomeIds = async (flag: boolean): Promise<string[]> => {
      const outcome = await searchDatasetsTool(
        {
          DB: realD1(db),
          AI: ai,
          VECTORIZE: vectorIndex(stored, seen),
          ...(flag ? { VECTORIZE_VISIBILITY_FILTER: "1" } : {}),
        },
        { query: "quokka", limit: 10 } as SearchDatasetsInput,
      );
      const text = (outcome.result.content as { text: string }[])[0].text;
      return (JSON.parse(text) as { results: { dataset_id: string }[] }).results.map(
        (r) => r.dataset_id,
      );
    };
    expect(await outcomeIds(true)).toEqual(["nm520001"]);
    expect(seen).toEqual([{ visibility: "public" }]);
    seen.length = 0;
    expect(await outcomeIds(false)).toEqual(["nm520001"]);
    expect(seen).toEqual([undefined]);
  });

  test("hits dropped for visibility are not reported as missing rows; genuinely missing ones are", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      // nm520003/4 are private (not visible to anonymous); nm529999 has no row.
      await ids(null, false);
      expect(warnings.filter((w) => w.includes("had no datasets row"))).toEqual([]);
      stored.push({ id: "nm529999", metadata: { visibility: "public" } });
      await ids(null, false);
    } finally {
      console.warn = original;
    }
    const missing = warnings.filter((w) => w.includes("had no datasets row"));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("1/5 vector ids had no datasets row");
    expect(missing[0]).toContain("3 more were not visible");
  });

  test("a visibility change marks the vector stale and re-embedding relabels it", async () => {
    db.run("UPDATE datasets SET embedding_dirty = 0");
    db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = 'nm520004'");
    expect(db.query("SELECT dataset_id FROM datasets WHERE embedding_dirty = 2").all()).toEqual([
      { dataset_id: "nm520004" },
    ]);
    const upserts: Stored[] = [];
    const vectorize = {
      upsert: async (v: Stored[]) => {
        upserts.push(...v);
      },
    } as unknown as VectorizeIndex;
    // An empty embed text is skipped, so give the row something to embed.
    db.run("UPDATE datasets SET description = 'x' WHERE dataset_id = 'nm520004'");
    await drainEmbeddingDirty(realD1(db), ai, vectorize);
    expect(upserts).toEqual([
      expect.objectContaining({
        id: "nm520004",
        metadata: { visibility: "public", dataset_id: "nm520004" },
      }),
    ]);
  });
});
