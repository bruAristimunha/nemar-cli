/**
 * The pre-screen of ADR 0014 hands over to the publication review (ADR 0102, section 10).
 *
 * With `PUBLICATION_REVIEW_ENABLED` exactly `1`, a publication request does not dispatch the
 * advisory pre-screen: the review replaces it, so the deploy that turns the review on is the one
 * that stops the pre-screen, with no gap and no overlap. With the flag off the pre-screen is
 * dispatched exactly as before. The identifier screen is dispatched either way, and
 * `PRESCREEN_CALLBACK_SECRET` keeps signing its token: the pre-screen's callback code and secret
 * are NOT removed here (Phase 5), only its dispatch is conditioned.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth
 * middleware and routes through Hono's `app.request()`. GitHub is a `Bun.serve()` stand-in that
 * answers the reads the request route makes and records each dispatch.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import webhooks from "../src/routes/webhooks";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { cleanScreenReportBody } from "./helpers/identifier-screen";
import { withFakeResend } from "./helpers/resend";

const SECRET = "handover-test-secret";
const OWNER_KEY = "handover-owner-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000455";

interface Dispatch {
  event_type: string;
  client_payload: Record<string, unknown>;
}

let server: Server;
let dispatches: Dispatch[] = [];

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let envOverrides: Partial<Bindings> = {};
let ownerId: number;

function b64(text: string): string {
  return btoa(text);
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (req.method === "POST" && p === "/repos/nemarDatasets/.github/dispatches") {
        dispatches.push((await req.json()) as Dispatch);
        return new Response(null, { status: 204 });
      }
      if (/\/contents\/\.github\/workflows\/bids-validation\.yml$/.test(p)) {
        return Response.json({ name: "bids-validation.yml" });
      }
      if (/\/actions\/workflows\/bids-validation\.yml\/runs$/.test(p)) {
        return Response.json({
          workflow_runs: [{ status: "completed", conclusion: "success", html_url: "x" }],
        });
      }
      if (/\/contents\/dataset_description\.json$/.test(p)) {
        return Response.json({
          encoding: "base64",
          content: b64(
            JSON.stringify({
              Name: "A sufficiently descriptive dataset title",
              Authors: ["Ada Lovelace"],
              EthicsApprovals: ["Approved by an institutional review board"],
            }),
          ),
        });
      }
      if (/\/contents\/README\.md$/.test(p)) {
        return Response.json({ encoding: "base64", content: b64("# README") });
      }
      return new Response("not found", { status: 404 });
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
  envOverrides = {};
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_handover_test",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    PRESCREEN_ENABLED: "true",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...envOverrides,
  } as Bindings;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  app.route("/webhooks", webhooks);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES ('handoverowner', 'handoverowner@example.org', 'x', 'approved', 'member', 1, 1, 1,
             'Ada', 'Lovelace')`,
  );
  ownerId = (
    db.query("SELECT id FROM users WHERE username = 'handoverowner'").get() as { id: number }
  ).id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    ownerId,
    await hashApiKey(OWNER_KEY),
    OWNER_KEY.slice(0, 8),
  );
  seedDataset(DATASET);
});

/** A private dataset of the owner's, native unless `over` makes it a mirror or an exemplar. */
function seedDataset(
  datasetId: string,
  over: { source?: string; isExemplar?: 0 | 1; isSandbox?: 0 | 1 } = {},
): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, source, is_exemplar)
     VALUES (?, ?, ?, 'active', 'private', ?, ?, ?, ?)`,
    [
      datasetId,
      `A sufficiently descriptive title for ${datasetId}`,
      ownerId,
      over.isSandbox ?? 0,
      `nemarDatasets/${datasetId}`,
      over.source ?? null,
      over.isExemplar ?? 0,
    ],
  );
}

function requestPublication(
  bindings: Bindings = env(),
  datasetId: string = DATASET,
): Promise<Response> {
  return app.request(
    `/datasets/${datasetId}/publish/request`,
    { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
    bindings,
  );
}

const events = () => dispatches.map((d) => d.event_type).sort();

function prescreenState(datasetId: string = DATASET) {
  return db
    .query(
      "SELECT prescreen_status, prescreen_nonce FROM publication_requests WHERE dataset_id = ?",
    )
    .get(datasetId) as { prescreen_status: string | null; prescreen_nonce: string | null };
}

describe("the request route and the pre-screen", () => {
  test("with the review off, the pre-screen and the screen are both dispatched, as before", async () => {
    const res = await requestPublication();
    expect(res.status).toBe(200);
    expect(events()).toEqual(["run-identifier-screen", "run-prescreen"]);
    expect(prescreenState()).toMatchObject({ prescreen_status: "pending" });
    expect(prescreenState().prescreen_nonce).not.toBeNull();
  });

  test("with the review on (the word 1), only the screen is dispatched and the pre-screen is not", async () => {
    envOverrides = { PUBLICATION_REVIEW_ENABLED: "1" };
    const res = await requestPublication();
    expect(res.status).toBe(200);
    expect(events()).toEqual(["run-identifier-screen"]);
    expect(prescreenState()).toEqual({ prescreen_status: null, prescreen_nonce: null });
  });

  test("only the word 1 hands over: every other value leaves the pre-screen running", async () => {
    for (const value of ["0", "", "true", " 1", "1 ", "yes", "ON"]) {
      db.run("DELETE FROM publication_requests");
      dispatches = [];
      envOverrides = { PUBLICATION_REVIEW_ENABLED: value };
      expect((await requestPublication()).status).toBe(200);
      expect(events(), JSON.stringify(value)).toEqual(["run-identifier-screen", "run-prescreen"]);
    }
  });

  test("with the pre-screen off the review's flag changes nothing: the screen is still dispatched", async () => {
    for (const flag of [undefined, "1"]) {
      db.run("DELETE FROM publication_requests");
      dispatches = [];
      envOverrides = { PRESCREEN_ENABLED: "false", PUBLICATION_REVIEW_ENABLED: flag };
      expect((await requestPublication()).status).toBe(200);
      expect(events()).toEqual(["run-identifier-screen"]);
    }
  });

  test("the callback secret still signs the screen's token, so the chain runs on to the review", async () => {
    // The pre-screen is out of the way, the secret it was named for is not: the screen's token is
    // signed with it, and the stored result starts the review, whose token it signs too.
    envOverrides = { PUBLICATION_REVIEW_ENABLED: "1" };
    await withFakeResend(async () => {
      expect((await requestPublication()).status).toBe(200);
      const screen = dispatches.find((d) => d.event_type === "run-identifier-screen");
      expect(screen).toBeDefined();
      const requestId = screen?.client_payload.request_id as number;
      const cb = await app.request(
        "/webhooks/identifier-screen-result",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Token": screen?.client_payload.callback_token as string,
          },
          body: JSON.stringify({
            dataset_id: DATASET,
            request_id: requestId,
            report: cleanScreenReportBody(DATASET),
          }),
        },
        env(),
      );
      expect(cb.status).toBe(200);
    });
    expect(events()).toEqual(["run-identifier-screen", "run-publication-review"]);
    const review = dispatches.find((d) => d.event_type === "run-publication-review");
    expect(review?.client_payload).toMatchObject({ dataset_id: DATASET, anonymous: false });
  });
});

describe("the pre-screen is handed over only where the review will run", () => {
  // With the flag on, the review replaces the pre-screen for the requests it covers: a native
  // dataset this Worker owns. A request it does not cover (an OpenNeuro mirror and an exemplar
  // passed an upstream review, and a dataset the other Worker owns is reviewed by that Worker, if
  // by anyone) would otherwise get neither, so the pre-screen runs for it exactly as before.
  const on = { PUBLICATION_REVIEW_ENABLED: "1" };

  test("a native dataset this Worker owns is covered: the pre-screen is skipped", async () => {
    envOverrides = on;
    expect((await requestPublication()).status).toBe(200);
    expect(events()).toEqual(["run-identifier-screen"]);
    expect(prescreenState()).toEqual({ prescreen_status: null, prescreen_nonce: null });
  });

  test("an OpenNeuro mirror is not covered: the pre-screen is dispatched", async () => {
    seedDataset("on000455", { source: "openneuro" });
    envOverrides = on;
    expect((await requestPublication(env(), "on000455")).status).toBe(200);
    expect(events()).toEqual(["run-identifier-screen", "run-prescreen"]);
    expect(prescreenState("on000455")).toMatchObject({ prescreen_status: "pending" });
    expect(prescreenState("on000455").prescreen_nonce).not.toBeNull();
  });

  test("an exemplar is not covered: the pre-screen is dispatched", async () => {
    // Exemplars publish only outside production, and the screen does not read a sandbox id.
    seedDataset("xx099900", { isExemplar: 1, isSandbox: 1 });
    envOverrides = { ...on, ENVIRONMENT: "development" };
    expect((await requestPublication(env(), "xx099900")).status).toBe(200);
    expect(events()).toEqual(["run-prescreen"]);
    expect(prescreenState("xx099900")).toMatchObject({ prescreen_status: "pending" });
  });

  test("a dataset the other Worker owns is not covered here: the pre-screen is dispatched", async () => {
    // Production does not own the dev fixture nm099998, and the dev Worker does not own nm000455.
    seedDataset("nm099998");
    envOverrides = on;
    expect((await requestPublication(env(), "nm099998")).status).toBe(200);
    expect(events()).toEqual(["run-identifier-screen", "run-prescreen"]);
    expect(prescreenState("nm099998")).toMatchObject({ prescreen_status: "pending" });

    db.run("DELETE FROM publication_requests");
    dispatches = [];
    envOverrides = { ...on, ENVIRONMENT: "development" };
    expect((await requestPublication()).status).toBe(200);
    expect(events()).toEqual(["run-identifier-screen", "run-prescreen"]);
    expect(prescreenState()).toMatchObject({ prescreen_status: "pending" });
  });

  test("the dev Worker covers a dataset it owns: the pre-screen is skipped there too", async () => {
    seedDataset("nm099998");
    envOverrides = { ...on, ENVIRONMENT: "development" };
    expect((await requestPublication(env(), "nm099998")).status).toBe(200);
    expect(events()).toEqual(["run-identifier-screen"]);
    expect(prescreenState("nm099998")).toEqual({ prescreen_status: null, prescreen_nonce: null });
  });
});
