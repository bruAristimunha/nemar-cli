/**
 * Real POST /admin/imports/:id/verify route tests (issue #969, stamping #980).
 *
 * Scoped to the branches that never reach verifyDatasetVersionS3 -- same
 * constraint as data-integrity-sweep-route.test.ts: this file's env sets no
 * S3_ENDPOINT_URL, so the S3 listing it does (listObjectPages) would go to a
 * live `*.s3.*.amazonaws.com` host (the override is honored outside
 * production, by listObjectPages since #1514 and by verifyDatasetVersionS3
 * since #1643; this file does not use it), and this repo's no-mocks policy
 * rules out faking the network call. The route's post-verify stamping call --
 * `stampDatasetIntegrity(c.env.DB, datasetId, verified)` -- is the SAME
 * helper exercised end-to-end (both the complete, incomplete, and
 * unverifiable outcomes) against a real D1 in
 * stamp-dataset-integrity.test.ts; this file only covers what's left: the
 * route's own dispatch (404 when there's no import job for the dataset).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "verify-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('verifyadmin', 'verifyadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='verifyadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
}

function post(path: string): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/imports/:id/verify (real route, no import job -> zero S3 calls)", () => {
  test("404 when no import_jobs row exists for the dataset", async () => {
    const res = await post("/admin/imports/on999999/verify");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("No import job");
  });

  test("non-admin cannot force a verify", async () => {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('verifyuser', 'verifyuser@example.org', 'x', 'approved', 'member', 1)`,
    );
    const u = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='verifyuser'")
      .get();
    const userKey = "verify-user-key-0123456789abcdef0123456789abcdef";
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(u?.id ?? 0, await hashApiKey(userKey), userKey.slice(0, 8));
    const res = await app.request(
      "/admin/imports/on999999/verify",
      { method: "POST", headers: { Authorization: `Bearer ${userKey}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });
});
