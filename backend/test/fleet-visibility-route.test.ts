/**
 * PATCH /admin/datasets/:id/visibility is refused in both directions.
 *
 * A bare flip made the half states: `private` on a published dataset left it
 * published but unreachable (nm000289), and `public` made a dataset public with
 * no publication. Each direction has its own operation that moves the catalog
 * row, the publication record and the repository together (the publication
 * flow, and unpublish). Real route, real adminRoutes, realD1, seeded admin token.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "vis-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('visadmin', 'visadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='visadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function seedDataset(datasetId: string, githubRepo: string | null): void {
  db.prepare(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox, github_repo) VALUES (?, 1, ?, 'public', 0, ?)",
  ).run(datasetId, datasetId, githubRepo);
}

function env(): Bindings {
  return { DB: realD1(db) } as Bindings;
}

function patch(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("PATCH /admin/datasets/:id/visibility is refused", () => {
  test.each(["private", "public"] as const)(
    "%s is refused with a pointer, and changes nothing",
    async (visibility) => {
      seedDataset("on008115", "nemarDatasets/on008115");
      const before = db
        .query("SELECT visibility FROM datasets WHERE dataset_id = 'on008115'")
        .get();
      const res = await patch("/admin/datasets/on008115/visibility", { visibility });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; publish: string; unpublish: string };
      expect(body.code).toBe("visibility_change_refused");
      expect(body.publish).toBe("/admin/publish/on008115/approve");
      expect(body.unpublish).toBe("/admin/datasets/on008115/unpublish");
      expect(
        db.query("SELECT visibility FROM datasets WHERE dataset_id = 'on008115'").get(),
      ).toEqual(before);
    },
  );

  test("an unknown dataset gets the same refusal, not a 404 that invites a retry", async () => {
    const res = await patch("/admin/datasets/on999999/visibility", { visibility: "private" });
    expect(res.status).toBe(409);
  });
});
