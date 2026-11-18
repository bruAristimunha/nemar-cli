/**
 * GET /datasets/search returns what the CALLER can see, the rule GET
 * /datasets/:id enforces: anonymous sees public rows; a signed-in user also
 * sees datasets they own or collaborate on; an admin sees everything.
 *
 * Driven through the real registered route against a real bun:sqlite D1 (no
 * mocks of business logic). The semantic tier is exercised with a minimal
 * stand-in for the two Cloudflare bindings (Workers AI and Vectorize) that
 * hands back EVERY dataset id, private ones included: the only thing under
 * test there is that the live `datasets` row, not the index, decides who sees
 * a hit, so a visibility change takes effect on the very next search.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import { drainEmbeddingDirty } from "../src/services/dataset-search";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

const OWNER_KEY = "owner-visibility-key-0123456789abcdef0123456";
const COLLAB_KEY = "collab-visibility-key-0123456789abcdef012345";
const OTHER_KEY = "other-visibility-key-0123456789abcdef0123456";
const ADMIN_KEY = "admin-visibility-key-0123456789abcdef0123456";

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

/** Stand-ins for the two bindings: every dataset is a nearest neighbour. */
function bindings(db: Database, withVectors: boolean): Bindings {
  const base = { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
  if (!withVectors) return base;
  const ids = (db.query("SELECT dataset_id FROM datasets").all() as { dataset_id: string }[]).map(
    (r) => r.dataset_id,
  );
  return {
    ...base,
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
    VECTORIZE: {
      query: async () => ({ matches: ids.map((id) => ({ id, score: 0.9 })) }),
    } as unknown as VectorizeIndex,
  };
}

describe("GET /datasets/search caller visibility", () => {
  let db: Database;
  let app: App;

  beforeEach(async () => {
    db = freshDb();
    app = new Hono();
    registerCatalogRoutes(app);

    const user = db.query(
      "INSERT INTO users (id, username, email, password_hash, status, role, email_verified) VALUES (?, ?, ?, 'x', 'approved', ?, 1)",
    );
    user.run(21, "ownerone", "o1@example.org", "member");
    user.run(22, "collabone", "c1@example.org", "member");
    user.run(23, "otherone", "x1@example.org", "member");
    user.run(24, "adminone", "a1@example.org", "admin");
    const token = db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)",
    );
    for (const [id, key] of [
      [21, OWNER_KEY],
      [22, COLLAB_KEY],
      [23, OTHER_KEY],
      [24, ADMIN_KEY],
    ] as const) {
      token.run(id, await hashApiKey(key), key.slice(0, 8));
    }

    insertDataset(db, "nm500001"); // public
    insertDataset(db, "nm500002", { visibility: "private", owner_user_id: 21 }); // owner's private
    insertDataset(db, "nm500003", { visibility: "private", owner_user_id: 21 }); // shared private
    insertDataset(db, "nm500004", { visibility: "private", owner_user_id: 99 }); // someone else's
    insertDataset(db, "nm500005", {
      visibility: "private",
      owner_user_id: 21,
      status: "archived",
    }); // excluded by status
    const shared = db.query("SELECT id FROM datasets WHERE dataset_id = 'nm500003'").get() as {
      id: number;
    };
    db.query(
      "INSERT INTO dataset_collaborators (dataset_id, user_id, access_type) VALUES (?, 22, 'invited')",
    ).run(shared.id);
  });

  async function search(
    key: string | null,
    withVectors: boolean,
    q = "quokka",
  ): Promise<{ ids: string[]; res: Response; body: Record<string, unknown> }> {
    const res = await app.request(
      `/search?q=${q}&min_score=0`,
      key ? { headers: { Authorization: `Bearer ${key}` } } : {},
      bindings(db, withVectors),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string }[] } & Record<string, unknown>;
    return { ids: body.results.map((r) => r.id).sort(), res, body };
  }

  for (const withVectors of [false, true]) {
    const tier = withVectors ? "semantic + text" : "text";

    describe(`${tier} tier`, () => {
      test("anonymous sees public only", async () => {
        expect((await search(null, withVectors)).ids).toEqual(["nm500001"]);
      });

      test("an owner finds their own private datasets", async () => {
        expect((await search(OWNER_KEY, withVectors)).ids).toEqual([
          "nm500001",
          "nm500002",
          "nm500003",
        ]);
      });

      test("a collaborator finds the shared private dataset only", async () => {
        expect((await search(COLLAB_KEY, withVectors)).ids).toEqual(["nm500001", "nm500003"]);
      });

      test("an unrelated user sees public only", async () => {
        expect((await search(OTHER_KEY, withVectors)).ids).toEqual(["nm500001"]);
      });

      test("an admin sees every active private dataset", async () => {
        expect((await search(ADMIN_KEY, withVectors)).ids).toEqual([
          "nm500001",
          "nm500002",
          "nm500003",
          "nm500004",
        ]);
      });

      test("count and exact-id lookup follow the same rule", async () => {
        expect((await search(OWNER_KEY, withVectors)).body.count).toBe(3);
        expect((await search(OTHER_KEY, withVectors)).body.count).toBe(1);
        expect((await search(OWNER_KEY, withVectors, "nm500002")).ids).toEqual(["nm500002"]);
        expect((await search(OTHER_KEY, withVectors, "nm500002")).ids).not.toContain("nm500002");
        expect((await search(null, withVectors, "nm500002")).ids).not.toContain("nm500002");
        expect((await search(ADMIN_KEY, withVectors, "nm500004")).ids).toEqual(["nm500004"]);
      });
    });
  }

  test("a visibility change takes effect at once: no stale public marker", async () => {
    // Publish: the owner's private row becomes visible to everyone.
    db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = 'nm500002'");
    expect((await search(OTHER_KEY, true)).ids).toEqual(["nm500001", "nm500002"]);
    // Unpublish: the vector is still in the index, the row says private again.
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm500002'");
    expect((await search(OTHER_KEY, true)).ids).toEqual(["nm500001"]);
    expect((await search(null, true)).ids).toEqual(["nm500001"]);
    // Archive (or withdraw): gone for the owner too.
    db.run("UPDATE datasets SET status = 'archived' WHERE dataset_id = 'nm500002'");
    expect((await search(OWNER_KEY, true)).ids).toEqual(["nm500001", "nm500003"]);
  });

  test("a private dataset's README text never reaches a caller without access", async () => {
    db.run(
      "UPDATE datasets SET readme = 'confidential zebrafish protocol' WHERE dataset_id = 'nm500002'",
    );
    for (const key of [null, OTHER_KEY, COLLAB_KEY]) {
      const { body } = await search(key, true, "zebrafish");
      expect(JSON.stringify(body)).not.toContain("zebrafish protocol");
      expect((body.results as { id: string }[]).map((r) => r.id)).not.toContain("nm500002");
    }
    const owner = await search(OWNER_KEY, false, "zebrafish");
    expect(owner.ids).toEqual(["nm500002"]);
  });

  test("an anonymous deposit stays concealed, including to its owner's own search", async () => {
    insertDataset(db, "nm500006", {
      owner_user_id: 21,
      anonymous: 1,
      concept_doi: "10.0000/reserved",
      name: "Quokka anonymous deposit",
    });
    for (const key of [null, OWNER_KEY, ADMIN_KEY]) {
      const { body } = await search(key, false);
      const hit = (body.results as { id: string; doi: string }[]).find((r) => r.id === "nm500006");
      expect(hit).toBeDefined();
      expect(hit?.doi).toBe("");
      expect(JSON.stringify(body)).not.toContain("ownerone");
    }
    // The depositor's username is not a search key to the deposit.
    expect((await search(null, false, "ownerone")).ids).toEqual([]);
  });

  test("owner and collaborator count and excluded_unknown match the visible hydrated set", async () => {
    for (const [key, expected] of [
      [OWNER_KEY, ["nm500001", "nm500002", "nm500003"]],
      [COLLAB_KEY, ["nm500001", "nm500003"]],
    ] as const) {
      for (const withVectors of [false, true]) {
        const { ids, body } = await search(key, withVectors);
        expect(ids).toEqual([...expected]);
        expect(body.count).toBe(expected.length);
        expect(body.excluded_unknown ?? 0).toBe(0);
      }
    }
    // A facet leaves a dataset without that fact out; excluded_unknown counts
    // exactly the visible rows (never the other owner's nm500004 or the
    // archived nm500005).
    for (const [key, visible] of [
      [OWNER_KEY, 3],
      [COLLAB_KEY, 2],
    ] as const) {
      const res = await app.request(
        "/search?q=quokka&min_score=0&subjects=10..",
        { headers: { Authorization: `Bearer ${key}` } },
        bindings(db, false),
      );
      const body = (await res.json()) as {
        results: unknown[];
        count: number;
        excluded_unknown: number;
      };
      expect(body.results).toEqual([]);
      expect(body.count).toBe(0);
      expect(body.excluded_unknown).toBe(visible);
    }
  });

  test("a private anonymous deposit seen by a collaborator has a null DOI and no owner fields", async () => {
    insertDataset(db, "nm500007", {
      visibility: "private",
      owner_user_id: 21,
      anonymous: 1,
      concept_doi: "10.0000/reserved2",
      name: "Quokka private anonymous deposit",
    });
    const shared = db.query("SELECT id FROM datasets WHERE dataset_id = 'nm500007'").get() as {
      id: number;
    };
    db.query(
      "INSERT INTO dataset_collaborators (dataset_id, user_id, access_type) VALUES (?, 22, 'invited')",
    ).run(shared.id);
    const { body } = await search(COLLAB_KEY, false);
    const hit = (body.results as Record<string, unknown>[]).find((r) => r.id === "nm500007");
    expect(hit).toBeDefined();
    expect(hit?.doi === "" || hit?.doi == null).toBe(true);
    expect(JSON.stringify(hit)).not.toContain("ownerone");
    expect(JSON.stringify(hit)).not.toContain("owner");
    expect(JSON.stringify(body)).not.toContain("reserved2");
  });

  test("every response is no-store, anonymous and authenticated alike", async () => {
    for (const key of [null, OWNER_KEY, ADMIN_KEY]) {
      const { res } = await search(key, false);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    const missingQ = await app.request("/search", {}, bindings(db, false));
    expect(missingQ.status).toBe(400);
    expect(missingQ.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("embedding drain and the visibility flag (I1, I2)", () => {
  const ai = { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai;
  function recorder(): { upserted: string[]; vectorize: VectorizeIndex } {
    const upserted: string[] = [];
    const vectorize = {
      upsert: async (v: { id: string }[]) => {
        for (const x of v) upserted.push(x.id);
      },
    } as unknown as VectorizeIndex;
    return { upserted, vectorize };
  }
  function seed(): Database {
    const db = freshDb();
    insertDataset(db, "nm510001", { visibility: "private", owner_user_id: 99, description: "x" });
    insertDataset(db, "nm510002", { visibility: "private", status: "archived", description: "x" });
    insertDataset(db, "nm510003", { visibility: "public", description: "x" });
    db.run("UPDATE datasets SET embedding_dirty = 1");
    return db;
  }

  test("flag on: a dirty private dataset is embedded, an archived one is not", async () => {
    const db = seed();
    const { upserted, vectorize } = recorder();
    const out = await drainEmbeddingDirty(realD1(db), ai, vectorize, 50, true);
    expect(upserted.sort()).toEqual(["nm510001", "nm510003"]);
    expect(out.embedded).toBe(2);
  });

  test("flag off: only public datasets are embedded; private rows stay dirty", async () => {
    const db = seed();
    const { upserted, vectorize } = recorder();
    const out = await drainEmbeddingDirty(realD1(db), ai, vectorize);
    expect(upserted).toEqual(["nm510003"]);
    expect(out.embedded).toBe(1);
    const dirty = db.query("SELECT dataset_id FROM datasets WHERE embedding_dirty >= 1").all();
    expect(dirty).toContainEqual({ dataset_id: "nm510001" });
  });

  test("a freshly flipped row drains before an older backlog larger than the limit", async () => {
    const db = freshDb();
    for (let i = 0; i < 6; i++) {
      insertDataset(db, `nm53000${i}`, {
        description: "x",
        updated_at: `2026-0${i + 1}-01 00:00:00`,
      });
    }
    // The newest backlog row is dirty from a content edit (1); the oldest row
    // is then published, which makes it 2 although its updated_at is oldest.
    db.run("UPDATE datasets SET embedding_dirty = 1");
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm530000'");
    db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = 'nm530000'");
    const { upserted, vectorize } = recorder();
    await drainEmbeddingDirty(realD1(db), ai, vectorize, 2);
    expect(upserted).toHaveLength(2);
    expect(upserted).toContain("nm530000");
  });
});
