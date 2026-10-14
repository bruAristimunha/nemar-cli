/**
 * `GET /admin/publish/requests` after a web click never carries the dispatch token (ADR 0103
 * decision 2).
 *
 * The list selects `pr.*`, so every column of `publication_requests` reaches the wire unless a
 * strip names it (the two callback nonces, the stored screen report). The dispatch token is a
 * credential-shaped value derived from the claim's own columns, and the list is read by every
 * administrator's page and printed by `nemar admin publish list`: a token in it would be the
 * clicker's attribution handed to whoever reads the queue. No column holds the token, so nothing
 * strips it; this guard pins that NOTHING token-shaped leaves the list, by value (the token minted
 * for the claim, which is the one the dispatch carries) and by shape (no 64-hex string in any
 * field, which is what an HMAC digest, a stored nonce or a hash of one would look like).
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real admin router, the
 * real auth middleware, and GitHub as a `Bun.serve()` stand-in whose dispatch the click sends.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database and a local stand-in.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { signApprovalDispatchToken } from "../src/services/github/callback-tokens";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { mainRefAnswer } from "./helpers/identifier-screen";
import { seedScreenedRequest, seedUser } from "./helpers/publication-review";

const ADMIN_KEY = "listguard-admin-key-0123456789abcdef0123456789abcdef";
const CALLBACK_SECRET = "list-guard-callback-secret-do-not-use-in-prod";
const DATASET = "nm098764";

let server: Server;
let dispatches: { client_payload: Record<string, unknown> }[] = [];
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const ref = mainRefAnswer(request);
      if (ref) return ref;
      dispatches.push(await request.json());
      return new Response(null, { status: 204 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

afterEach(() => {
  dispatches = [];
});

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedUser(db, "listguardadmin", "admin", ADMIN_KEY);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "ghp_list_guard_test_token",
    PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
  } as Bindings;
}

/** Every string in a parsed JSON value, keys and values, however deep. */
function everyString(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) everyString(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      everyString(v, out);
    }
  }
  return out;
}

describe("the admin list after a web click", () => {
  test("shows the claim and the in-flight flag, and carries no token and no 64-hex value anywhere", async () => {
    const { requestId } = seedScreenedRequest(db, { datasetId: DATASET });
    const click = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(click.status).toBe(202);
    expect(dispatches).toHaveLength(1);

    const claim = db
      .query<{ approval_requested_by: number; approval_dispatched_at: string }, [number]>(
        "SELECT approval_requested_by, approval_dispatched_at FROM publication_requests WHERE id = ?",
      )
      .get(requestId);
    expect(claim?.approval_requested_by).toBe(adminId);
    expect(claim?.approval_dispatched_at).toBeTruthy();

    // The token the claim derives, minted exactly as the dispatch route mints it from the row's
    // own columns, and the one the dispatch carried: the same 64 hex characters.
    const derived = await signApprovalDispatchToken(
      {
        datasetId: DATASET,
        requestId,
        clickerId: adminId,
        claimedAt: claim?.approval_dispatched_at as string,
      },
      CALLBACK_SECRET,
    );
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    const sent = dispatches[0].client_payload.dispatch_token;
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).toBe(derived);

    const res = await app.request(
      "/admin/publish/requests",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { requests: Record<string, unknown>[]; count: number };

    // The control: this IS the row of the click, with its claim visible as it always was.
    expect(body.count).toBe(1);
    const [listed] = body.requests;
    expect(listed.id).toBe(requestId);
    expect(listed.approval_requested_by).toBe(adminId);
    expect(listed.approval_dispatched_at).toBe(claim?.approval_dispatched_at);
    expect(listed.approval_in_flight).toBe(true);

    expect(text).not.toContain(derived);
    const strings = everyString(body);
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) expect(s).not.toMatch(/[0-9a-f]{64}/i);
    // No field is named for a token, a nonce, a signature or a secret. The callback nonces the
    // route strips are columns of the same table, so a new one must be stripped the same way.
    for (const key of Object.keys(listed)) {
      expect(key).not.toMatch(/token|nonce|signature|secret|mac$/i);
    }
  });
});
