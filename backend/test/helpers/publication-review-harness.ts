// The publication review's write path, driven through the real routes (ADR 0102).
//
// What a review test needs and none of it replaces a rule: a real bun:sqlite database with every
// migration (`freshDb`, behind `realD1`), the real Hono `/webhooks`, `/admin` and `/datasets`
// routers behind their real auth middleware, real WebCrypto tokens, and a `Bun.serve()` stand-in
// for api.github.com (`NEMAR_GITHUB_API_URL`) that records each call and answers the few reads the
// admin approval and the publication request make. The stand-in is the only fake, and it sits at
// the GitHub boundary. Resend is the shared real-boundary capture (`helpers/resend.ts`) in the
// tests that read mail.
//
// `createHarness()` registers its hooks where it is called, so call it once at the top of a test
// file. The database and the app are rebuilt before every test.

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../../src/routes/admin";
import { datasetRoutes } from "../../src/routes/datasets";
import webhooks from "../../src/routes/webhooks";
import { signIdentifierScreenCallbackToken } from "../../src/services/github";
import { signPublicationReviewCallbackToken } from "../../src/services/github/callback-tokens";
import type { Bindings, Variables } from "../../src/types/bindings";
import { freshDb, realD1 } from "./d1";
import { SCREENED_HEAD, mainRefAnswer } from "./identifier-screen";
import { evidenceFor, goodPublicationReport, screenReportBodyFor } from "./publication-review";

export const CALLBACK_SECRET = "publication-review-callback-secret";
export const GITHUB_PAT = "ghp_publication_review_test";
/** A dataset the production Worker owns. */
export const PROD_DATASET = "nm000480";
/** A reserved fixture the dev Worker owns. */
export const DEV_DATASET = "nm099998";

export interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export interface DispatchBody {
  event_type: string;
  client_payload: Record<string, unknown>;
}

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

export interface Harness {
  readonly db: Database;
  readonly app: App;
  calls: Recorded[];
  /** What the stand-in answers a dispatch with. Reset to 204 after every test. */
  dispatchStatus: number;
  /**
   * Runs inside the stand-in while it answers a dispatch (whatever it answers it with), before it
   * answers.
   */
  duringDispatch: (() => Promise<void>) | null;
  /** Merged over the default bindings; reset after every test. */
  envOverrides: Partial<Bindings>;
  /**
   * When set to a list, every request carries an execution context whose `waitUntil` pushes to it,
   * as the Workers runtime keeps work alive after the answer; a test awaits the list to let that
   * work finish. When null (the default) a request has no context, and a route that would defer
   * its work awaits it instead. Reset after every test.
   */
  deferred: Promise<unknown>[] | null;
  env(over?: Partial<Bindings>): Bindings;
  dispatches(): DispatchBody[];
  reviews(): Record<string, unknown>[];
  review(id: number): Record<string, unknown>;
  requestRow(id: number): Record<string, unknown>;
  /** The nonce of a review's live attempt, which only a test may read. */
  nonceOf(reviewId: number): string | null;
  tokenFor(reviewId: number, datasetId?: string): Promise<string>;
  /** Post a screen result for a request whose screen is pending, as the screen job would. */
  screenResult(
    requestId: number,
    datasetId: string,
    o?: { status?: string; head?: string; bindings?: Bindings },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Put a request's screen back to pending with the nonce `screenResult` signs, as a re-run does. */
  rearmScreen(requestId: number): void;
  claim(
    reviewId: number,
    token?: string,
    bindings?: Bindings,
    datasetId?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  result(
    reviewId: number,
    body: Record<string, unknown>,
    token?: string,
    bindings?: Bindings,
    datasetId?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

const b64 = (text: string) => btoa(text);

/**
 * The reads the stand-in answers: the screened commit as the repository's `main` (the approval's
 * head check), and a repository that is ready to be requested (its validation workflow present and
 * passing, a dataset description and a README that meet the submission minimums). Anything else
 * is not found, so a route that reads more than these says so.
 */
function readsAnswer(req: Request, path: string): Response | null {
  const ref = mainRefAnswer(req);
  if (ref) return ref;
  if (req.method !== "GET") return null;
  if (/\/contents\/\.github\/workflows\/bids-validation\.yml$/.test(path)) {
    return Response.json({ name: "bids-validation.yml" });
  }
  if (/\/actions\/workflows\/bids-validation\.yml\/runs$/.test(path)) {
    return Response.json({
      workflow_runs: [{ status: "completed", conclusion: "success", html_url: "x" }],
    });
  }
  if (/\/contents\/dataset_description\.json$/.test(path)) {
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
  if (/\/contents\/README\.md$/.test(path)) {
    return Response.json({ encoding: "base64", content: b64("# README") });
  }
  return null;
}

/** A route's answer as an object: its JSON, or `{ raw }` for a body that is not JSON (a bare 500). */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

export function createHarness(): Harness {
  let server: Server;
  let db: Database;
  let app: App;

  const ctx = (): ExecutionContext | undefined =>
    h.deferred
      ? ({
          waitUntil: (task: Promise<unknown>) => void h.deferred?.push(task),
          passThroughOnException: () => {},
        } as unknown as ExecutionContext)
      : undefined;

  const h: Harness = {
    get db() {
      return db;
    },
    get app() {
      return app;
    },
    calls: [],
    dispatchStatus: 204,
    duringDispatch: null,
    envOverrides: {},
    deferred: null,
    env(over = {}) {
      return {
        DB: realD1(db),
        ENVIRONMENT: "production",
        GITHUB_ADMIN_PAT: GITHUB_PAT,
        PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
        PUBLICATION_REVIEW_ENABLED: "1",
        API_BASE_URL: "https://api.test.nemar.org",
        RESEND_API_KEY: "re_test",
        FROM_EMAIL: "NEMAR <noreply@nemar.org>",
        ...h.envOverrides,
        ...over,
      } as Bindings;
    },
    dispatches() {
      return h.calls
        .filter((c) => c.method === "POST" && c.path === "/repos/nemarDatasets/.github/dispatches")
        .map((c) => c.body as unknown as DispatchBody);
    },
    reviews() {
      return db.query("SELECT * FROM publication_reviews ORDER BY id").all() as Record<
        string,
        unknown
      >[];
    },
    review(id) {
      return db.query("SELECT * FROM publication_reviews WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
    },
    requestRow(id) {
      return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
    },
    nonceOf(reviewId) {
      const row = db.query("SELECT nonce FROM publication_reviews WHERE id = ?").get(reviewId) as {
        nonce: string | null;
      } | null;
      return row?.nonce ?? null;
    },
    async tokenFor(reviewId, datasetId = PROD_DATASET) {
      const nonce = h.nonceOf(reviewId);
      if (nonce === null) throw new Error(`review ${reviewId} has no live nonce`);
      return signPublicationReviewCallbackToken({ datasetId, reviewId, nonce }, CALLBACK_SECRET);
    },
    async screenResult(requestId, datasetId, o = {}) {
      const token = await signIdentifierScreenCallbackToken(
        { datasetId, requestId, nonce: "n" },
        CALLBACK_SECRET,
      );
      const res = await app.request(
        "/webhooks/identifier-screen-result",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
          body: JSON.stringify({
            dataset_id: datasetId,
            request_id: requestId,
            report: screenReportBodyFor(datasetId, o.status ?? "clean", o.head ?? SCREENED_HEAD),
          }),
        },
        o.bindings ?? h.env(),
        ctx(),
      );
      return { status: res.status, body: await bodyOf(res) };
    },
    rearmScreen(requestId) {
      db.run(
        `UPDATE publication_requests
            SET identifier_screen_status = 'pending', identifier_screen_nonce = 'n',
                identifier_screen_dispatched_at = datetime('now'), identifier_screen_report = NULL,
                identifier_screen_emailed_at = NULL, identifier_screen_mail_claimed_at = NULL
          WHERE id = ?`,
        [requestId],
      );
    },
    async claim(reviewId, token, bindings, datasetId = PROD_DATASET) {
      const res = await app.request(
        "/webhooks/publication-review-claim",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Token": token ?? (await h.tokenFor(reviewId, datasetId)),
          },
          body: JSON.stringify({ review_id: reviewId, dataset_id: datasetId }),
        },
        bindings ?? h.env(),
        ctx(),
      );
      return { status: res.status, body: await bodyOf(res) };
    },
    async result(reviewId, body, token, bindings, datasetId = PROD_DATASET) {
      const res = await app.request(
        "/webhooks/publication-review-result",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Token": token ?? (await h.tokenFor(reviewId, datasetId)),
          },
          body: JSON.stringify({ review_id: reviewId, dataset_id: datasetId, ...body }),
        },
        bindings ?? h.env(),
        ctx(),
      );
      return { status: res.status, body: await bodyOf(res) };
    },
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as never);
        h.calls.push({ method: req.method, path: url.pathname, body });
        if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
          if (h.duringDispatch) await h.duringDispatch();
          return new Response(h.dispatchStatus < 300 ? null : "{}", { status: h.dispatchStatus });
        }
        return readsAnswer(req, url.pathname) ?? new Response("not found", { status: 404 });
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
    h.calls = [];
    h.dispatchStatus = 204;
    h.duringDispatch = null;
    h.envOverrides = {};
    h.deferred = null;
  });

  beforeEach(() => {
    db = freshDb();
    app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/admin", adminRoutes);
    app.route("/datasets", datasetRoutes);
    app.route("/webhooks", webhooks);
  });

  return h;
}

/** A report body for a request of `head` and release kind, which the production parser accepts. */
export function reportFor(
  head: string,
  anonymous: boolean,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return goodPublicationReport({ evidence: evidenceFor(head, anonymous), ...over });
}

/** What {@link hookedD1} runs, and when. */
export interface D1Hooks {
  /**
   * Before every statement, whether it runs alone or inside a batch (`inBatch`). It is
   * synchronous because a batched statement runs inside the transaction, which a hook cannot wait
   * out. A hook that throws fails that statement (and so the whole batch, which D1 rolls back).
   */
  statement?: (sql: string, inBatch: boolean) => void;
  /** Before a batch begins, with the SQL of every statement in it, ahead of its transaction. */
  batch?: (sqls: string[]) => void | Promise<void>;
}

/**
 * A D1 that runs {@link D1Hooks} around the real database, so a test can land another writer
 * exactly where the route is exposed to one (between its statements, or just before its batch) or
 * make a named statement fail. The hooks write through the real database; nothing is canned.
 * `interceptingD1` of `helpers/d1.ts` cannot do this for the statements of a batch, which are
 * executed through `__execForBatch` and never through `run`.
 */
export function hookedD1(inner: D1Database, hooks: D1Hooks): D1Database {
  return {
    prepare(sql: string) {
      const stmt = inner.prepare(sql) as unknown as {
        bind(...p: unknown[]): unknown;
        run(): Promise<unknown>;
        first(): Promise<unknown>;
        all(): Promise<unknown>;
        __execForBatch(): unknown;
      };
      const api = {
        sql,
        bind(...p: unknown[]) {
          stmt.bind(...p);
          return api;
        },
        run() {
          hooks.statement?.(sql, false);
          return stmt.run();
        },
        first() {
          hooks.statement?.(sql, false);
          return stmt.first();
        },
        all() {
          hooks.statement?.(sql, false);
          return stmt.all();
        },
        __execForBatch() {
          hooks.statement?.(sql, true);
          return stmt.__execForBatch();
        },
      };
      return api;
    },
    async batch(stmts: { sql: string }[]) {
      await hooks.batch?.(stmts.map((s) => s.sql));
      return (inner as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(stmts);
    },
  } as unknown as D1Database;
}

/**
 * Await a request that must answer without waiting for work that should follow its answer, and
 * fail with that reason instead of hanging until the test times out when it does wait.
 */
export function answersWithin<T>(request: Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([
    request,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("the answer waited on work that should follow it")), ms),
    ),
  ]);
}
