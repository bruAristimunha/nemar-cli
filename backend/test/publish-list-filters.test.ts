/**
 * Filters on GET /admin/publish/requests (#1774, #1775): a status list, and a
 * search that matches the dataset id, the requester and the dataset name.
 *
 * Real engine only: bun:sqlite behind realD1, the real auth middleware and the
 * real route via Hono app.request(), as in approval-in-flight.test.ts.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "listfilter-admin-key-0123456789abcdef0123456789ab";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;
let aliceId: number;

function seed(datasetId: string, status: string, requestedBy: number, name?: string) {
  db.run(
    `INSERT INTO publication_requests (dataset_id, status, requested_by)
     VALUES ('${datasetId}', '${status}', ${requestedBy})`,
  );
  if (name) {
    db.query("INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES (?, ?, ?)").run(
      datasetId,
      name,
      requestedBy,
    );
  }
}

async function get(query: string): Promise<{ status: number; ids: string[]; body: unknown }> {
  const res = await app.request(
    `/admin/publish/requests${query}`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}`, "X-CLI-Version": "99.0.0" } },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
  const body = (await res.json()) as { requests?: Array<{ dataset_id: string }> };
  return { status: res.status, ids: (body.requests ?? []).map((r) => r.dataset_id), body };
}

function userId(username: string): number {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`seed: ${username} missing`);
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  for (const [name, role] of [
    ["listadmin", "admin"],
    ["alice", "user"],
  ]) {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('${name}', '${name}@example.org', 'x', 'approved', '${role}', 1)`,
    );
  }
  adminId = userId("listadmin");
  aliceId = userId("alice");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  seed("nm000104", "requested", aliceId, "Motor imagery");
  seed("nm0001041", "approving", adminId, "Sleep study");
  seed("nm000105", "blocked", aliceId, "100%_sure");
  seed("nm000106", "published", adminId, "Old data");
  seed("nm000107", "denied", aliceId);
  seed("nm000108", "requested", adminId, "back\\slash");
});

describe("status filter", () => {
  test("no status lists every request", async () => {
    expect((await get("")).ids.sort()).toEqual(
      ["nm000104", "nm0001041", "nm000105", "nm000106", "nm000107", "nm000108"].sort(),
    );
  });

  test("a comma-separated list is a union", async () => {
    const { ids } = await get("?status=requested,approving,blocked");
    expect(ids.sort()).toEqual(["nm000104", "nm0001041", "nm000105", "nm000108"].sort());
  });

  test("one status narrows to it", async () => {
    expect((await get("?status=denied")).ids).toEqual(["nm000107"]);
  });

  test("an unknown status is a 400, not an empty list", async () => {
    const r = await get("?status=requested,bogus");
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("bogus");
  });
});

describe("search", () => {
  test("matches a dataset id", async () => {
    expect((await get("?search=nm000106")).ids).toEqual(["nm000106"]);
  });

  test("matches the requester's username, case-insensitively", async () => {
    expect((await get("?search=ALICE")).ids.sort()).toEqual(
      ["nm000104", "nm000105", "nm000107"].sort(),
    );
  });

  test("matches the dataset name", async () => {
    expect((await get("?search=sleep")).ids).toEqual(["nm0001041"]);
  });

  test("an exact dataset id is listed before longer ids that contain it", async () => {
    // The longer id is the NEWER request, so the default newest-first order
    // alone would list it first; only the exact-match term puts nm000104 ahead.
    db.run(
      "UPDATE publication_requests SET requested_at = '2026-10-01 00:00:00' WHERE dataset_id = 'nm000104'",
    );
    db.run(
      "UPDATE publication_requests SET requested_at = '2026-10-02 00:00:00' WHERE dataset_id = 'nm0001041'",
    );
    expect((await get("?search=nm000104")).ids).toEqual(["nm000104", "nm0001041"]);
    // The match is case-insensitive, like the search itself.
    expect((await get("?search=NM000104")).ids).toEqual(["nm000104", "nm0001041"]);
  });

  test("composes with the status filter", async () => {
    expect((await get("?status=denied&search=alice")).ids).toEqual(["nm000107"]);
    expect((await get("?status=published&search=alice")).ids).toEqual([]);
  });

  test("percent and underscore match literally", async () => {
    expect((await get("?search=%25")).ids).toEqual(["nm000105"]);
    expect((await get("?search=_")).ids).toEqual(["nm000105"]);
    expect((await get("?search=nm_00104")).ids).toEqual([]);
  });

  test("a backslash matches itself, and does not escape the next character", async () => {
    expect((await get("?search=%5C")).ids).toEqual(["nm000108"]);
    // "\%" is a literal backslash then a literal percent: nothing has that.
    expect((await get("?search=%5C%25")).ids).toEqual([]);
  });

  test("a quote is just text", async () => {
    expect((await get("?search='%20OR%201=1")).ids).toEqual([]);
  });

  test("a search whose pattern exceeds D1's limit is a 400 that says so", async () => {
    const r = await get(`?search=${"a".repeat(49)}`);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/at most 50 bytes/);
  });

  test("the response carries the dataset name", async () => {
    const r = await get("?search=nm000104");
    const first = (r.body as { requests: Array<{ dataset_name: string | null }> }).requests[0];
    expect(first.dataset_name).toBe("Motor imagery");
  });
});

/**
 * D1 refuses a LIKE pattern over 50 BYTES ("LIKE or GLOB pattern too complex:
 * SQLITE_ERROR"), and bun:sqlite does not, so these boundaries cannot be found
 * by running the query here: the route has to refuse them itself. The pattern
 * is "%" + the escaped text + "%", an escaped "_", "%" or "\" is two bytes, and
 * the engine counts UTF-8 bytes, not characters.
 *
 * The limit was measured against the real engine on 2026-10-14 with
 * `wrangler d1 execute nemar-db -c wrangler-sccn.toml --local` (local D1 on
 * workerd): a 50-byte pattern ran, a 51-byte one failed with the error above;
 * 24 two-byte letters ran and 25 failed; 24 escaped underscores ran and 25
 * failed.
 */
describe("search length is bounded by D1's LIKE pattern limit", () => {
  const encoded = (text: string) => encodeURIComponent(text);

  test("48 plain characters make a 50-byte pattern and work", async () => {
    expect((await get(`?search=${"a".repeat(48)}`)).status).toBe(200);
  });

  test("49 plain characters make a 51-byte pattern and are refused", async () => {
    expect((await get(`?search=${"a".repeat(49)}`)).status).toBe(400);
  });

  test("an escaped underscore counts twice", async () => {
    expect((await get(`?search=${"_".repeat(24)}`)).status).toBe(200);
    expect((await get(`?search=${"_".repeat(25)}`)).status).toBe(400);
  });

  test("an escaped percent counts twice", async () => {
    expect((await get(`?search=${"%".repeat(24).replaceAll("%", "%25")}`)).status).toBe(200);
    expect((await get(`?search=${"%25".repeat(25)}`)).status).toBe(400);
  });

  test("an escaped backslash counts twice", async () => {
    expect((await get(`?search=${"%5C".repeat(24)}`)).status).toBe(200);
    expect((await get(`?search=${"%5C".repeat(25)}`)).status).toBe(400);
  });

  test("a two-byte character counts two", async () => {
    expect((await get(`?search=${encoded("\u00e9".repeat(24))}`)).status).toBe(200);
    expect((await get(`?search=${encoded("\u00e9".repeat(25))}`)).status).toBe(400);
  });

  test("a three-byte character counts three", async () => {
    expect((await get(`?search=${encoded("\u65e5".repeat(16))}`)).status).toBe(200);
    expect((await get(`?search=${encoded("\u65e5".repeat(17))}`)).status).toBe(400);
  });

  test("a four-byte character counts four", async () => {
    expect((await get(`?search=${encoded("\u{1F9E0}".repeat(12))}`)).status).toBe(200);
    expect((await get(`?search=${encoded("\u{1F9E0}".repeat(13))}`)).status).toBe(400);
  });

  test("surrounding whitespace is not part of the pattern", async () => {
    expect((await get(`?search=%20%20${"a".repeat(48)}%20`)).status).toBe(200);
  });
});
