/**
 * Real POST /admin/datasets/:id/availability-report route tests (epic #999
 * Phase 1, #1000).
 *
 * Scoped to the branches that never reach verifyDatasetVersionS3 -- same
 * constraint as data-integrity-sweep-route.test.ts and
 * imports-verify-route.test.ts: this file's env sets no S3_ENDPOINT_URL, so
 * the S3 listing it does (listObjectPages) would go to a live
 * `*.s3.*.amazonaws.com` host, and this repo's no-mocks policy rules out
 * faking the network call. The report-shape assertions (missing[]/completeness
 * for a resolved manifest, and the minimal honest report when there is none)
 * live in availability-report.test.ts against the pure buildAvailabilityReport
 * builder instead. The write path, including the createOrUpdateFile commit,
 * is driven through this route and the sweep route against local GitHub and
 * S3 stand-ins in availability-report-never-creates-main.test.ts. This file
 * covers what's left: the route's own dispatch (404 for an unknown dataset,
 * before any S3/GitHub call; admin gating).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "avail-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('availadmin', 'availadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='availadmin'").get();
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

describe("POST /admin/datasets/:id/availability-report (real route, unknown dataset -> zero S3 calls)", () => {
  test("?dry_run=1 -> 404 when the dataset does not exist, before any S3 call", async () => {
    const res = await post("/admin/datasets/nm999999/availability-report?dry_run=1");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("nm999999");
  });

  test("without ?dry_run -> also 404 for an unknown dataset (the not-found check runs before the write branch)", async () => {
    const res = await post("/admin/datasets/nm999999/availability-report");
    expect(res.status).toBe(404);
  });

  test("non-admin cannot generate an availability report", async () => {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('availuser', 'availuser@example.org', 'x', 'approved', 'member', 1)`,
    );
    const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='availuser'").get();
    const userKey = "avail-user-key-0123456789abcdef0123456789abcdef";
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(u?.id ?? 0, await hashApiKey(userKey), userKey.slice(0, 8));
    const res = await app.request(
      "/admin/datasets/nm999999/availability-report?dry_run=1",
      { method: "POST", headers: { Authorization: `Bearer ${userKey}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });
});
