/**
 * The identifier screen, end to end through the real routes (epic #1610, phase 4).
 *
 * A publication request dispatches the screen and mails the admins only when its
 * report lands, stating it. Every way of NOT getting a report still mails them,
 * and says so; nothing a workflow wrote reaches the database, a mail, a log line
 * or an API response except through `parseScreenReport` / `describeScreen`.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the
 * real auth middleware, the real routes (`/datasets`, `/admin`, `/webhooks`)
 * through Hono's `app.request()`. GitHub is a `Bun.serve()` stand-in for
 * api.github.com (NEMAR_GITHUB_API_URL) that answers the reads the request
 * route makes and records each dispatch; Resend is the shared real-boundary
 * capture (`helpers/resend.ts`), so the mail checked is the mail that would go.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import webhooks from "../src/routes/webhooks";
import {
  signIdentifierScreenCallbackToken,
  signPrescreenCallbackToken,
} from "../src/services/github";
import {
  SCREEN_REPORT_DEADLINE_MINUTES,
  isScreenExempt,
  notifyAdminsOfScreen,
  sweepIdentifierScreens,
} from "../src/services/identifier-screen";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1, yieldingD1 } from "./helpers/d1";
import { SCREENED_HEAD, cleanScreenReportBody, markScreen } from "./helpers/identifier-screen";
import { type CapturedEmail, type ResendSendBody, asSend, withFakeResend } from "./helpers/resend";

const SECRET = "screen-test-secret";
const OWNER_KEY = "screen-owner-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "screen-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000450";
const OTHER = "nm000451";
const ADMIN_EMAIL = "screenadmin@example.org";
const OWNER_EMAIL = "screenowner@example.org";
const LEAK = "SMITH";

interface Dispatch {
  event_type: string;
  client_payload: {
    dataset_id: string;
    ref: string;
    request_id: number;
    callback_token: string;
    callback_url: string;
  };
}

let server: Server;
let dispatches: Dispatch[] = [];
let dispatchStatus = 204;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let envOverrides: Partial<Bindings> = {};

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
        const body = (await req.json()) as Dispatch;
        if (dispatchStatus < 300) dispatches.push(body);
        return new Response(dispatchStatus < 300 ? null : '{"message":"refused"}', {
          status: dispatchStatus,
        });
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
  dispatchStatus = 204;
  envOverrides = {};
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_screen_test",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...envOverrides,
  } as Bindings;
}

async function seedUser(username: string, role: string, email: string, key: string) {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, 'Ada', 'Lovelace')`,
    [username, email, role],
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

let ownerId: number;

function seedDataset(id: string, opts: { githubRepo?: string | null; exemplar?: boolean } = {}) {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, is_exemplar)
     VALUES (?, ?, ?, 'active', 'private', 0, ?, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      ownerId,
      opts.githubRepo === undefined ? `nemarDatasets/${id}` : opts.githubRepo,
      opts.exemplar ? 1 : 0,
    ],
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  app.route("/admin", adminRoutes);
  app.route("/webhooks", webhooks);
  ownerId = await seedUser("screenowner", "member", OWNER_EMAIL, OWNER_KEY);
  await seedUser("screenadmin", "admin", ADMIN_EMAIL, ADMIN_KEY);
  seedDataset(DATASET);
  seedDataset(OTHER);
});

function requestPublication(id = DATASET, bindings: Bindings = env()): Promise<Response> {
  return app.request(
    `/datasets/${id}/publish/request`,
    { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
    bindings,
  );
}

function postCallback(body: unknown, token: string, bindings: Bindings = env()) {
  return app.request(
    "/webhooks/identifier-screen-result",
    {
      method: "POST",
      headers: { "X-Webhook-Token": token, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    bindings,
  );
}

interface ScreenRow {
  id: number;
  status: string;
  block_reason: string | null;
  identifier_screen_status: string | null;
  identifier_screen_nonce: string | null;
  identifier_screen_dispatched_at: string | null;
  identifier_screen_at: string | null;
  identifier_screen_report: string | null;
  identifier_screen_emailed_at: string | null;
  identifier_screen_mail_claimed_at: string | null;
  identifier_screen_ack_by: number | null;
  identifier_screen_ack_reason: string | null;
  identifier_screen_ack_at: string | null;
}

function row(id = DATASET): ScreenRow {
  return db
    .query<ScreenRow, [string]>(
      `SELECT id, status, block_reason, identifier_screen_status, identifier_screen_nonce,
              identifier_screen_dispatched_at, identifier_screen_at, identifier_screen_report,
              identifier_screen_emailed_at, identifier_screen_mail_claimed_at,
              identifier_screen_ack_by,
              identifier_screen_ack_reason, identifier_screen_ack_at
         FROM publication_requests WHERE dataset_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(id) as ScreenRow;
}

function sendsTo(calls: CapturedEmail[], to: string): ResendSendBody[] {
  return calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((b) => b.to.includes(to));
}

/** Put a request's screen back to pending under a nonce the test chooses, and sign for it. */
async function armPending(requestId: number, datasetId: string, nonce: string): Promise<string> {
  db.run(
    `UPDATE publication_requests
        SET identifier_screen_status = 'pending', identifier_screen_nonce = ?,
            identifier_screen_dispatched_at = datetime('now'), identifier_screen_report = NULL,
            identifier_screen_at = NULL, identifier_screen_emailed_at = NULL
      WHERE id = ?`,
    [nonce, requestId],
  );
  return signIdentifierScreenCallbackToken({ datasetId, requestId, nonce }, SECRET);
}

// ============================================================================

describe("a dispatched screen holds the admin email until its report lands", () => {
  test("dispatch, no mail, then one mail stating the result; a replay is refused", async () => {
    await withFakeResend(async (calls) => {
      const res = await requestPublication();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { identifier_screen: { state: string; headline: string } };
      expect(body.identifier_screen.state).toBe("pending");

      // One dispatch, the documented payload, the callback under API_BASE_URL.
      expect(dispatches).toHaveLength(1);
      const d = dispatches[0];
      expect(d.event_type).toBe("run-identifier-screen");
      const r0 = row();
      expect(d.client_payload).toMatchObject({
        dataset_id: DATASET,
        ref: "main",
        request_id: r0.id,
        callback_url: "https://api.test.nemar.org/webhooks/identifier-screen-result",
      });
      expect(r0.identifier_screen_status).toBe("pending");
      expect(r0.identifier_screen_nonce).not.toBeNull();
      expect(r0.identifier_screen_dispatched_at).not.toBeNull();
      // The admins hear nothing yet.
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(0);

      const report = cleanScreenReportBody(DATASET);
      const cb = await postCallback(
        { dataset_id: DATASET, request_id: r0.id, workflow_run_id: "12345", report },
        d.client_payload.callback_token,
      );
      expect(cb.status).toBe(200);
      const r1 = row();
      expect(r1.identifier_screen_status).toBe("clean");
      expect(r1.identifier_screen_nonce).toBeNull();
      expect(JSON.parse(r1.identifier_screen_report ?? "null")).toEqual(report);
      expect(r1.identifier_screen_emailed_at).not.toBeNull();

      const mails = sendsTo(calls, ADMIN_EMAIL);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe(
        `[NEMAR] Publication request: ${DATASET} by screenowner - IDENTIFIER SCREEN: clean`,
      );
      expect(mails[0].html).toContain("Identifier screen: clean");

      // The same callback again: the screen is no longer pending, so 401, and
      // nothing is stored or mailed a second time.
      const replay = await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report },
        d.client_payload.callback_token,
      );
      expect(replay.status).toBe(401);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
      expect(row().identifier_screen_status).toBe("clean");
    });
  });

  test("an anonymous release's mail, sent when the screen lands, still says it is anonymous", async () => {
    // The mail waits for the screen, so the flag is read back off the request
    // row rather than from the request that asked for it.
    await withFakeResend(async (calls) => {
      const res = await app.request(
        `/datasets/${DATASET}/publish/request`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ anonymous: true }),
        },
        env(),
      );
      // The blind check reads Authors; the stand-in names a person, so the
      // anonymous release is refused there. Re-run it with a blinded file.
      expect(res.status).toBe(422);
    });
    db.run(
      `UPDATE publication_requests SET status = 'requested', block_reason = NULL, anonymous = 1,
              identifier_screen_status = 'pending', identifier_screen_nonce = 'anon-nonce',
              identifier_screen_dispatched_at = datetime('now') WHERE dataset_id = ?`,
      [DATASET],
    );
    const r0 = row();
    const token = await signIdentifierScreenCallbackToken(
      { datasetId: DATASET, requestId: r0.id, nonce: "anon-nonce" },
      SECRET,
    );
    await withFakeResend(async (calls) => {
      await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
        token,
      );
      const mail = sendsTo(calls, ADMIN_EMAIL)[0];
      expect(mail.subject).toBe(
        `[NEMAR] Anonymous release request: ${DATASET} by screenowner - IDENTIFIER SCREEN: clean`,
      );
      expect(mail.html).toContain("Anonymous release.");
    });
  });

  test("a finding is mailed with its kind and count in the subject's verdict", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      const report = cleanScreenReportBody(DATASET, SCREENED_HEAD, "review");
      (report.scan as Record<string, unknown>).findings_by_kind = { "edf-patient-freetext": 3 };
      await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report },
        dispatches[0].client_payload.callback_token,
      );
      const mail = sendsTo(calls, ADMIN_EMAIL)[0];
      expect(mail.subject).toEndWith("IDENTIFIER SCREEN: needs review");
      expect(mail.html).toContain("edf-patient-freetext x3");
      expect(mail.html).toContain("--acknowledge-identifier-screen");
    });
  });
});

describe("every way of not getting a report still mails the admins, and says so", () => {
  for (const [label, override] of [
    ["no callback secret", { PRESCREEN_CALLBACK_SECRET: undefined }],
    ["no GitHub credential", { GITHUB_ADMIN_PAT: undefined }],
    ["no API base URL", { API_BASE_URL: "" }],
  ] as const) {
    test(`dispatch impossible (${label}): error, dispatch-unconfigured, mailed at once`, async () => {
      envOverrides = override as Partial<Bindings>;
      await withFakeResend(async (calls) => {
        // Without a credential the CI readiness check cannot run and blocks
        // first (a recorded request, answered 503 because nothing promises it
        // continues); the screen cases that reach the dispatch are the other
        // two. Both are asserted on what the row and the mail say.
        const res = await requestPublication();
        if (label === "no GitHub credential") {
          expect(res.status).toBe(503);
          expect(((await res.json()) as { error: string }).error).toBe("ci_check_unavailable");
          expect(row().status).toBe("blocked");
          expect(row().identifier_screen_status).toBeNull();
          return;
        }
        expect(res.status).toBe(200);
        expect(dispatches).toHaveLength(0);
        const r = row();
        expect(r.identifier_screen_status).toBe("error");
        expect(JSON.parse(r.identifier_screen_report ?? "{}").error).toBe("dispatch-unconfigured");
        const mails = sendsTo(calls, ADMIN_EMAIL);
        expect(mails).toHaveLength(1);
        expect(mails[0].subject).toEndWith("IDENTIFIER SCREEN: DID NOT RUN");
        expect(mails[0].html).toContain("Approval is held until the screen is re-run");
        expect(r.identifier_screen_emailed_at).not.toBeNull();
      });
    });
  }

  test("dispatch impossible (no repository): error, dispatch-unconfigured, mailed at once", async () => {
    db.run("UPDATE datasets SET github_repo = NULL WHERE dataset_id = ?", [DATASET]);
    await withFakeResend(async (calls) => {
      const res = await requestPublication();
      expect(res.status).toBe(200);
      expect(row().identifier_screen_status).toBe("error");
      expect(JSON.parse(row().identifier_screen_report ?? "{}").error).toBe(
        "dispatch-unconfigured",
      );
      expect(sendsTo(calls, ADMIN_EMAIL)[0]?.subject).toEndWith("DID NOT RUN");
    });
  });

  test("dispatch refused by GitHub: error, dispatch-failed, mailed at once", async () => {
    dispatchStatus = 422;
    await withFakeResend(async (calls) => {
      const res = await requestPublication();
      expect(res.status).toBe(200);
      const r = row();
      expect(r.identifier_screen_status).toBe("error");
      expect(r.identifier_screen_nonce).toBeNull();
      expect(JSON.parse(r.identifier_screen_report ?? "{}").error).toBe("dispatch-failed");
      const mail = sendsTo(calls, ADMIN_EMAIL)[0];
      expect(mail.subject).toEndWith("IDENTIFIER SCREEN: DID NOT RUN");
      expect(mail.html).toContain("GitHub refused to start the screen workflow");
    });
  });

  test("the workflow reports an error: stored, never clear, mailed", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      await postCallback(
        {
          dataset_id: DATASET,
          request_id: r0.id,
          report: { version: 1, scanner: null, head: null, error: "clone-failed" },
        },
        dispatches[0].client_payload.callback_token,
      );
      expect(row().identifier_screen_status).toBe("error");
      const mail = sendsTo(calls, ADMIN_EMAIL)[0];
      expect(mail.subject).toEndWith("IDENTIFIER SCREEN: DID NOT RUN");
      expect(mail.html).toContain("could not read the dataset repository");
    });
  });

  test("a report outside the contract is stored as workflow-failed and mailed", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      const res = await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report: { version: 1, verdict: "fine" } },
        dispatches[0].client_payload.callback_token,
      );
      expect(res.status).toBe(200);
      const r = row();
      expect(r.identifier_screen_status).toBe("error");
      expect(JSON.parse(r.identifier_screen_report ?? "{}")).toEqual({
        version: 1,
        scanner: null,
        head: null,
        error: "workflow-failed",
      });
      expect(sendsTo(calls, ADMIN_EMAIL)[0].subject).toEndWith("DID NOT RUN");
    });
  });

  test("a scan of a different dataset is stored as workflow-failed, never as that scan", async () => {
    await withFakeResend(async () => {
      await requestPublication();
      const r0 = row();
      await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(OTHER) },
        dispatches[0].client_payload.callback_token,
      );
      expect(row().identifier_screen_status).toBe("error");
      expect(JSON.parse(row().identifier_screen_report ?? "{}").error).toBe("workflow-failed");
    });
  });

  test("the workflow never reports: the watchdog marks it unreported and mails it; a late report still lands", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      // Inside the deadline: the watchdog leaves it alone.
      let result = await sweepIdentifierScreens(env());
      expect(result.timedOut).toBe(0);
      expect(row().identifier_screen_status).toBe("pending");

      db.run(
        `UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-${
          SCREEN_REPORT_DEADLINE_MINUTES + 1
        } minutes') WHERE id = ?`,
        [r0.id],
      );
      result = await sweepIdentifierScreens(env());
      expect(result).toMatchObject({ timedOut: 1, emailed: 1, errors: 0, skipped: false });
      const r = row();
      expect(r.identifier_screen_status).toBe("unreported");
      // The nonce is kept, so the run can still answer.
      expect(r.identifier_screen_nonce).toBe(r0.identifier_screen_nonce);
      expect(JSON.parse(r.identifier_screen_report ?? "{}").error).toBe("no-report-in-time");
      const mail = sendsTo(calls, ADMIN_EMAIL);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toEndWith("IDENTIFIER SCREEN: DID NOT REPORT");

      // The next tick does not mail it again.
      result = await sweepIdentifierScreens(env());
      expect(result.emailed + result.timedOut).toBe(0);

      // A late but valid report is the run's own answer: stored, and mailed,
      // because the mail already sent said it did not report.
      const late = await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
        dispatches[0].client_payload.callback_token,
      );
      expect(late.status).toBe(200);
      expect(row().identifier_screen_status).toBe("clean");
      expect(row().identifier_screen_nonce).toBeNull();
      const mails = sendsTo(calls, ADMIN_EMAIL);
      expect(mails).toHaveLength(2);
      expect(mails[1].subject).toEndWith("IDENTIFIER SCREEN: clean");

      // And a replay of it is refused.
      const replay = await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
        dispatches[0].client_payload.callback_token,
      );
      expect(replay.status).toBe(401);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(2);
    });
  });

  test("the watchdog's deadline outlasts the workflow's own 45-minute job timeout", () => {
    // Overtaking a run that is merely slow mails a false DID NOT REPORT; the
    // late report would still land, but the admin would have been told wrong.
    expect(SCREEN_REPORT_DEADLINE_MINUTES).toBeGreaterThan(45);
  });

  test("a pending row with no dispatch time is overdue, not stuck forever", async () => {
    await withFakeResend(async () => {
      await requestPublication();
      db.run(
        "UPDATE publication_requests SET identifier_screen_dispatched_at = NULL WHERE dataset_id = ?",
        [DATASET],
      );
      const result = await sweepIdentifierScreens(env());
      expect(result.timedOut).toBe(1);
      expect(row().identifier_screen_status).toBe("unreported");
    });
  });
});

describe("the email is sent at most once per result, and never lost", () => {
  test("a send that reached nobody is released, and the watchdog delivers it once", async () => {
    await requestPublication();
    const r0 = row();
    const token = dispatches[0].client_payload.callback_token;
    // Resend refuses every send: the claim is released.
    await withFakeResend(
      async () => {
        const res = await postCallback(
          { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
          token,
        );
        expect(res.status).toBe(200);
      },
      { status: 500 },
    );
    expect(row().identifier_screen_status).toBe("clean");
    expect(row().identifier_screen_emailed_at).toBeNull();
    expect(row().identifier_screen_mail_claimed_at).toBeNull();

    await withFakeResend(async (calls) => {
      // Too fresh: the path that stored it gets its chance first.
      let result = await sweepIdentifierScreens(env());
      expect(result.emailed).toBe(0);
      db.run(
        "UPDATE publication_requests SET identifier_screen_at = datetime('now', '-10 minutes') WHERE id = ?",
        [r0.id],
      );
      result = await sweepIdentifierScreens(env());
      expect(result.emailed).toBe(1);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
      expect(row().identifier_screen_emailed_at).not.toBeNull();
      result = await sweepIdentifierScreens(env());
      expect(result.emailed).toBe(0);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });

  test("two triggers racing for one result send it once", async () => {
    await requestPublication();
    const r0 = row();
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = 'clean',
              identifier_screen_report = ?, identifier_screen_nonce = NULL WHERE id = ?`,
      [JSON.stringify(cleanScreenReportBody(DATASET)), r0.id],
    );
    await withFakeResend(async (calls) => {
      // Statements interleave as on real D1: the claim must be atomic.
      const racing = { ...env(), DB: yieldingD1(realD1(db)) } as Bindings;
      const outcomes = await Promise.all([
        notifyAdminsOfScreen(racing, r0.id),
        notifyAdminsOfScreen(racing, r0.id),
        notifyAdminsOfScreen(racing, r0.id),
      ]);
      expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "not-claimed")).toHaveLength(2);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });

  test("a report racing the watchdog is still stored, and mailed after the DID NOT REPORT mail", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      const token = dispatches[0].client_payload.callback_token;
      db.run(
        "UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-2 hours') WHERE id = ?",
        [r0.id],
      );
      // The real watchdog runs between the callback's verified read and its
      // write, the gap real D1 leaves between two statements.
      let fired = false;
      const racing = {
        ...env(),
        DB: interceptingD1(realD1(db), async (sql) => {
          if (
            !fired &&
            sql.includes("SET identifier_screen_status = ?, identifier_screen_report = ?")
          ) {
            fired = true;
            await sweepIdentifierScreens(env());
          }
        }),
      } as Bindings;
      const res = await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
        token,
        racing,
      );
      expect(fired).toBe(true);
      expect(res.status).toBe(200);
      expect(row().identifier_screen_status).toBe("clean");
      const mails = sendsTo(calls, ADMIN_EMAIL);
      expect(mails.map((m) => m.subject.split(" - ")[1])).toEqual([
        "IDENTIFIER SCREEN: DID NOT REPORT",
        "IDENTIFIER SCREEN: clean",
      ]);
    });
  });

  test("two copies of one callback store once and mail once", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      const token = dispatches[0].client_payload.callback_token;
      const racing = { ...env(), DB: yieldingD1(realD1(db)) } as Bindings;
      const body = {
        dataset_id: DATASET,
        request_id: r0.id,
        report: cleanScreenReportBody(DATASET),
      };
      const [a, b] = await Promise.all([
        postCallback(body, token, racing),
        postCallback(body, token, racing),
      ]);
      const texts = [await a.text(), await b.text()];
      // One stores; the other loses the conditional UPDATE (or finds the nonce gone).
      expect(texts.filter((t) => t.includes('"state":"clean"'))).toHaveLength(1);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });

  test("a sender that died after its claim: the lease holds, then expires, and the watchdog mails", async () => {
    await requestPublication();
    const r0 = row();
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = 'clean',
              identifier_screen_report = ?, identifier_screen_nonce = NULL,
              identifier_screen_at = datetime('now', '-10 minutes'),
              identifier_screen_mail_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
        WHERE id = ?`,
      [JSON.stringify(cleanScreenReportBody(DATASET)), r0.id],
    );
    await withFakeResend(async (calls) => {
      // A live lease: nobody else sends.
      expect(await notifyAdminsOfScreen(env(), r0.id)).toBe("not-claimed");
      expect((await sweepIdentifierScreens(env())).emailed).toBe(0);
      expect(calls).toHaveLength(0);

      // The lease outlives its holder: the watchdog takes it and sends.
      db.run(
        `UPDATE publication_requests
            SET identifier_screen_mail_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-6 minutes')
          WHERE id = ?`,
        [r0.id],
      );
      expect((await sweepIdentifierScreens(env())).emailed).toBe(1);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
      expect(row().identifier_screen_emailed_at).not.toBeNull();
      expect(row().identifier_screen_mail_claimed_at).toBeNull();
    });
  });

  test("a send that reached some admins counts as sent and is not retried", async () => {
    // Outside production, only an allowlisted address is delivered to: one of
    // the two admins receives it, the other is fenced.
    const SECOND = "screenadmin2@example.org";
    await seedUser(
      "screenadmin2",
      "admin",
      SECOND,
      "screen-admin2-key-0123456789abcdef0123456789ab",
    );
    envOverrides = {
      ENVIRONMENT: "staging",
      DEV_ADMIN_NOTIFICATIONS: "1",
      DEV_EMAIL_ALLOWLIST: ADMIN_EMAIL,
    } as Partial<Bindings>;
    await requestPublication();
    const r0 = row();
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = 'clean',
              identifier_screen_report = ?, identifier_screen_nonce = NULL WHERE id = ?`,
      [JSON.stringify(cleanScreenReportBody(DATASET)), r0.id],
    );
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), r0.id)).toBe("sent");
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
      expect(sendsTo(calls, SECOND)).toHaveLength(0);
      expect(row().identifier_screen_emailed_at).not.toBeNull();
      expect(await notifyAdminsOfScreen(env(), r0.id)).toBe("not-claimed");
    });
  });

  test("a screen start that throws before anything is recorded still mails NOT RUN", async () => {
    // The database refuses the pending claim: no screen row exists, but the
    // request does, and the admins must hear about it.
    const failing = {
      ...env(),
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql.includes("identifier_screen_status = 'pending', identifier_screen_nonce = ?")) {
          throw new Error("D1_ERROR: simulated");
        }
      }),
    } as Bindings;
    await withFakeResend(async (calls) => {
      const res = await requestPublication(DATASET, failing);
      expect(res.status).toBe(200);
      expect(dispatches).toHaveLength(0);
      const mail = sendsTo(calls, ADMIN_EMAIL);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toEndWith("IDENTIFIER SCREEN: NOT RUN for this request");
      expect(mail[0].html).toContain("Approval is held until the screen is re-run");
    });
  });

  test("a screen that is running is never claimed for the admin mail", async () => {
    await requestPublication();
    const r0 = row();
    expect(r0.identifier_screen_status).toBe("pending");
    await withFakeResend(async (calls) => {
      // The race this is for: a re-run replaces a stored result while its mail is on the way.
      expect(await notifyAdminsOfScreen(env(), r0.id)).toBe("not-claimed");
      expect(calls).toHaveLength(0);
    });
    expect(row().identifier_screen_mail_claimed_at).toBeNull();
  });

  test("a result on a request that is no longer active is not mailed", async () => {
    await requestPublication();
    const r0 = row();
    db.run(
      `UPDATE publication_requests SET status = 'denied', identifier_screen_status = 'clean',
              identifier_screen_report = ? WHERE id = ?`,
      [JSON.stringify(cleanScreenReportBody(DATASET)), r0.id],
    );
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), r0.id)).toBe("not-claimed");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("the callback admits only the token minted for that row", () => {
  test("a pre-screen token for the same request and nonce is refused", async () => {
    await requestPublication();
    const r0 = row();
    const forged = await signPrescreenCallbackToken(
      { datasetId: DATASET, requestId: r0.id, nonce: r0.identifier_screen_nonce as string },
      SECRET,
    );
    const res = await postCallback(
      { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
      forged,
    );
    expect(res.status).toBe(401);
    expect(row().identifier_screen_status).toBe("pending");
  });

  test("one request's token does not store a result on another request's row", async () => {
    await requestPublication(DATASET);
    await requestPublication(OTHER);
    const a = row(DATASET);
    const b = row(OTHER);
    const tokenA = dispatches.find((d) => d.client_payload.dataset_id === DATASET)?.client_payload
      .callback_token as string;
    // A's token, B's row: the nonce recovered is B's, so the token does not verify.
    const crossed = await postCallback(
      { dataset_id: OTHER, request_id: b.id, report: cleanScreenReportBody(OTHER) },
      tokenA,
    );
    expect(crossed.status).toBe(401);
    // A's token, A's dataset, B's request id: no pending row matches that pair.
    const mismatched = await postCallback(
      { dataset_id: DATASET, request_id: b.id, report: cleanScreenReportBody(DATASET) },
      tokenA,
    );
    expect(mismatched.status).toBe(401);
    expect(row(OTHER).identifier_screen_status).toBe("pending");
    expect(row(DATASET).identifier_screen_status).toBe("pending");
    expect(a.id).not.toBe(b.id);
  });

  test("a stored result is not reopened even by a valid token for a nonce still on the row", async () => {
    // The nonce is cleared on store, so this row shape needs a hand edit; it
    // isolates the route's OTHER guard, the `pending` filter on its lookup.
    await requestPublication();
    const r0 = row();
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = 'review',
              identifier_screen_nonce = 'kept-nonce' WHERE id = ?`,
      [r0.id],
    );
    const token = await signIdentifierScreenCallbackToken(
      { datasetId: DATASET, requestId: r0.id, nonce: "kept-nonce" },
      SECRET,
    );
    const res = await postCallback(
      { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
      token,
    );
    expect(res.status).toBe(401);
    expect(row().identifier_screen_status).toBe("review");
  });

  test("no in-flight screen and a bad token are refused with the same bytes", async () => {
    await requestPublication();
    const r0 = row();
    const body = { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) };
    const badToken = await postCallback(body, "0".repeat(64));
    const noScreen = await postCallback({ ...body, request_id: r0.id + 1000 }, "0".repeat(64));
    expect(badToken.status).toBe(401);
    expect(noScreen.status).toBe(401);
    expect(await badToken.text()).toBe(await noScreen.text());
  });

  test("a body over 256 KB is refused before it is parsed, by its declared and its real length", async () => {
    await requestPublication();
    const r0 = row();
    const token = dispatches[0].client_payload.callback_token;
    const huge = JSON.stringify({
      dataset_id: DATASET,
      request_id: r0.id,
      report: cleanScreenReportBody(DATASET),
      pad: "x".repeat(300 * 1024),
    });
    expect((await postCallback(huge, token)).status).toBe(413);
    // A declared length that lies low does not let it through either.
    const lying = await app.request(
      "/webhooks/identifier-screen-result",
      {
        method: "POST",
        headers: {
          "X-Webhook-Token": token,
          "Content-Type": "application/json",
          "Content-Length": "100",
        },
        body: huge,
      },
      env(),
    );
    expect(lying.status).toBe(413);
    expect(row().identifier_screen_status).toBe("pending");
  });

  test("no token, or the wrong one, is 401", async () => {
    await requestPublication();
    const r0 = row();
    const body = { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) };
    expect((await postCallback(body, "")).status).toBe(401);
    expect((await postCallback(body, "0".repeat(64))).status).toBe(401);
    expect(row().identifier_screen_status).toBe("pending");
  });
});

describe("no value reaches D1, a mail, a log line or a response except through the parser", () => {
  test("a hostile callback carrying a name in every field it can", async () => {
    const logged: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture =
      (sink: string[]) =>
      (...args: unknown[]) =>
        sink.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    const responses: string[] = [];
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      console.log = capture(logged);
      console.warn = capture(logged);
      console.error = capture(logged);
      try {
        // The identifying fields themselves: refused before anything is read.
        for (const body of [
          { dataset_id: `JOHN ${LEAK}`, request_id: r0.id, report: {} },
          { dataset_id: DATASET, request_id: `JOHN ${LEAK}`, report: {} },
          `{"dataset_id": "JOHN ${LEAK}"`,
        ]) {
          const res = await postCallback(body, `token-${LEAK}`);
          responses.push(await res.text());
          expect(res.status).toBe(400);
        }
        // A wrong token named after a person.
        const wrong = await postCallback(
          { dataset_id: DATASET, request_id: r0.id, report: {} },
          `JOHN-${LEAK}`,
        );
        responses.push(await wrong.text());
        expect(wrong.status).toBe(401);

        // A verified callback whose report smuggles the name through each field
        // the report has. Each is stored as workflow-failed and mailed.
        const scan = cleanScreenReportBody(DATASET).scan as Record<string, unknown>;
        const reports: unknown[] = [
          { ...cleanScreenReportBody(DATASET), patient: `JOHN ${LEAK}` },
          { ...cleanScreenReportBody(DATASET), scanner: `JOHN ${LEAK}` },
          { ...cleanScreenReportBody(DATASET), scan: { ...scan, id: `JOHN ${LEAK}` } },
          {
            ...cleanScreenReportBody(DATASET),
            scan: { ...scan, findings_by_kind: { [`JOHN ${LEAK}`]: 1 } },
          },
          {
            ...cleanScreenReportBody(DATASET),
            scan: { ...scan, unscreened_formats: { [`${LEAK}.edf`]: 1 } },
          },
          {
            ...cleanScreenReportBody(DATASET),
            scan: { ...scan, finding_fields: [`edf-patient-name:JOHN ${LEAK}`] },
          },
          {
            ...cleanScreenReportBody(DATASET),
            scan: { ...scan, incomplete_reasons: [`JOHN ${LEAK}`] },
          },
          { ...cleanScreenReportBody(DATASET), scan: { ...scan, files: { total: `${LEAK}` } } },
          // Lowercase, hyphenated: the shape a pattern-based vocabulary let through.
          {
            ...cleanScreenReportBody(DATASET),
            scan: {
              ...scan,
              status: "unchecked",
              incomplete: true,
              incomplete_reasons: [`john-${LEAK.toLowerCase()}`],
            },
          },
          {
            ...cleanScreenReportBody(DATASET),
            scan: { ...scan, read_failures: { [`edf/john-${LEAK.toLowerCase()}`]: 1 } },
          },
          // A status cleaner than its own counts: "clean" with a name finding.
          {
            ...cleanScreenReportBody(DATASET),
            scan: {
              ...scan,
              findings_by_kind: { "edf-patient-name": 3 },
              edf_bdf_files_flagged: 3,
            },
          },
          { version: 1, scanner: null, head: null, error: `JOHN ${LEAK}` },
          `JOHN ${LEAK}`,
        ];
        let n = 0;
        for (const report of reports) {
          n++;
          const token = await armPending(r0.id, DATASET, `nonce-${n}`);
          const res = await postCallback(
            {
              dataset_id: DATASET,
              request_id: r0.id,
              workflow_run_id: `JOHN ${LEAK} 1971`,
              patient: `JOHN ${LEAK}`,
              report,
            },
            token,
          );
          responses.push(await res.text());
          expect(res.status).toBe(200);
          expect(row().identifier_screen_status).toBe("error");
          expect(JSON.parse(row().identifier_screen_report ?? "{}").error).toBe("workflow-failed");
        }
        expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(reports.length);
      } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
      }

      // The status views, as owner and admin.
      for (const [path, key] of [
        [`/datasets/${DATASET}/publish/status`, OWNER_KEY],
        ["/admin/publish/requests", ADMIN_KEY],
      ] as const) {
        const res = await app.request(path, { headers: { Authorization: `Bearer ${key}` } }, env());
        responses.push(await res.text());
      }

      const everything = [
        JSON.stringify(db.query("SELECT * FROM publication_requests").all()),
        JSON.stringify(db.query("SELECT * FROM audit_log").all()),
        JSON.stringify(calls),
        logged.join("\n"),
        responses.join("\n"),
      ].join("\n");
      expect(everything).not.toContain(LEAK);
      expect(everything).not.toContain(`john-${LEAK.toLowerCase()}`);
      // The control: the capture did see the traffic it claims to have checked.
      expect(logged.join("\n")).toContain("outside the contract");
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe("status surfaces show describeScreen's words and nothing stored", () => {
  test("the owner's status view and the admin list carry the headline, never the nonce or report", async () => {
    await withFakeResend(async () => {
      await requestPublication();
      const nonce = row().identifier_screen_nonce as string;

      const status = await app.request(
        `/datasets/${DATASET}/publish/status`,
        { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(),
      );
      const statusText = await status.text();
      const s = JSON.parse(statusText) as { identifier_screen: Record<string, unknown> };
      expect(s.identifier_screen).toEqual({
        state: "pending",
        headline: "Identifier screen: running",
        tone: "note",
        lines: [],
      });
      expect(statusText).not.toContain(nonce);

      const list = await app.request(
        "/admin/publish/requests",
        { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env(),
      );
      const listText = await list.text();
      const l = JSON.parse(listText) as { requests: Record<string, unknown>[] };
      const keys = Object.keys(l.requests[0]);
      for (const withheld of [
        "identifier_screen_nonce",
        "identifier_screen_report",
        "prescreen_nonce",
      ]) {
        expect(keys).not.toContain(withheld);
      }
      expect(listText).not.toContain(nonce);
      expect((l.requests[0].identifier_screen as { headline: string }).headline).toBe(
        "Identifier screen: running",
      );
    });
  });

  test("the uploader's status never carries an admin's acknowledgment", async () => {
    await requestPublication();
    const REASON = "Reviewed by the curator: the free text is a device serial.";
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = 'review',
              identifier_screen_report = ?, identifier_screen_ack_by = 2,
              identifier_screen_ack_reason = ?, identifier_screen_ack_at = datetime('now')
        WHERE dataset_id = ?`,
      [JSON.stringify(cleanScreenReportBody(DATASET, SCREENED_HEAD, "review")), REASON, DATASET],
    );
    const res = await app.request(
      `/datasets/${DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(),
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("needs review");
    expect(text).not.toContain(REASON);
    expect(text).not.toContain("identifier_screen_ack");
  });

  test("a stored value that is not a state reads as NOT RUN, never clean", async () => {
    await requestPublication();
    db.run(
      "UPDATE publication_requests SET identifier_screen_status = 'CLEAN' WHERE dataset_id = ?",
      [DATASET],
    );
    const res = await app.request(
      `/datasets/${DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(),
    );
    const s = (await res.json()) as { identifier_screen: { state: unknown; headline: string } };
    expect(s.identifier_screen.state).toBeNull();
    expect(s.identifier_screen.headline).toContain("NOT RUN");
  });
});

// ============================================================================

/** The warning ADR 0090 words, for a count of `n`: one definition, restated here to pin it. */
const WARNING = (n: number) => [
  `Warning: acquisition dates finer than year and month were found in recording headers or scans tables (${n} ${n === 1 ? "entry" : "entries"}).`,
  "NEMAR does not change them.",
  "A date can help identify a participant when it is combined with other information.",
  "Remove or coarsen any date that could identify someone before uploading or requesting publication.",
  "Administrators are told of these findings when publication is requested.",
];

/** A scan report with the given verdict and finding counts, as the workflow would post it. */
function reportWith(status: string, kinds: Record<string, number>, flagged = 0) {
  const report = cleanScreenReportBody(DATASET, SCREENED_HEAD, status);
  Object.assign(report.scan as Record<string, unknown>, {
    findings_by_kind: kinds,
    edf_bdf_files_flagged: flagged,
  });
  return report;
}

describe("acquisition dates are warned about, in every place the screen's counts are shown (ADR 0090)", () => {
  test("dates only: the admin mail, the owner's status and the admin list carry the warning; nothing else changes", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      const cb = await postCallback(
        {
          dataset_id: DATASET,
          request_id: r0.id,
          report: reportWith("dates-only", { "edf-startdate": 3, "acq-time-dated": 1 }),
        },
        dispatches[0].client_payload.callback_token,
      );
      expect(cb.status).toBe(200);

      // The verdict, the request and the next step are what they were for a dates-only screen.
      expect(row().identifier_screen_status).toBe("dates-only");
      expect(row().status).toBe("requested");
      const mails = sendsTo(calls, ADMIN_EMAIL);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe(
        `[NEMAR] Publication request: ${DATASET} by screenowner - IDENTIFIER SCREEN: clean (acquisition dates only)`,
      );
      expect(mails[0].html).not.toContain("--acknowledge-identifier-screen");
      expect(sendsTo(calls, OWNER_EMAIL)).toHaveLength(0);

      // The admin is told, with the kinds and counts beside it.
      for (const line of WARNING(4)) expect(mails[0].html).toContain(line);
      expect(mails[0].html).toContain("edf-startdate x3, acq-time-dated x1");

      // The person who requested sees it where the result is shown to them.
      const status = await app.request(
        `/datasets/${DATASET}/publish/status`,
        { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(),
      );
      const s = (await status.json()) as {
        status: string;
        identifier_screen: { state: string; headline: string; tone: string; lines: string[] };
      };
      expect(s.status).toBe("requested");
      expect(s.identifier_screen.state).toBe("dates-only");
      expect(s.identifier_screen.headline).toBe(
        "Identifier screen: clean (acquisition dates only)",
      );
      expect(s.identifier_screen.tone).toBe("ok");
      expect(s.identifier_screen.lines).toEqual(expect.arrayContaining(WARNING(4)));

      // And the admin's list.
      const list = await app.request(
        "/admin/publish/requests",
        { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env(),
      );
      const l = (await list.json()) as {
        requests: { identifier_screen: { lines: string[] } }[];
      };
      expect(l.requests[0].identifier_screen.lines).toEqual(expect.arrayContaining(WARNING(4)));
    });
  });

  test("a resend carries the stored warning to the admins again", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      await postCallback(
        {
          dataset_id: DATASET,
          request_id: r0.id,
          report: reportWith("dates-only", { "edf-recording-startdate": 2 }),
        },
        dispatches[0].client_payload.callback_token,
      );
      db.run(
        "UPDATE publication_requests SET updated_at = datetime('now', '-2 hours') WHERE id = ?",
        [r0.id],
      );
      const res = await app.request(
        `/datasets/${DATASET}/publish/resend`,
        { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(),
      );
      expect(res.status).toBe(200);
      const mails = sendsTo(calls, ADMIN_EMAIL);
      expect(mails).toHaveLength(2);
      for (const mail of mails) for (const line of WARNING(2)) expect(mail.html).toContain(line);
    });
  });

  test("a direct identifier beside dates: the depositor's blocked-request mail carries the warning too", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      await postCallback(
        {
          dataset_id: DATASET,
          request_id: r0.id,
          report: reportWith(
            "direct-identifiers",
            { "edf-patient-name": 4, "edf-startdate": 4 },
            4,
          ),
        },
        dispatches[0].client_payload.callback_token,
      );
      expect(row().status).toBe("blocked");
      const owner = sendsTo(calls, OWNER_EMAIL);
      expect(owner).toHaveLength(1);
      expect(owner[0].subject).toBe(
        `Publication on hold: ${DATASET} - identifying information found`,
      );
      for (const line of WARNING(4)) expect(owner[0].html).toContain(line);
      const admin = sendsTo(calls, ADMIN_EMAIL);
      expect(admin).toHaveLength(1);
      for (const line of WARNING(4)) expect(admin[0].html).toContain(line);
    });
  });

  test("a screen with no date finding warns nobody, and says nothing about dates", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      await postCallback(
        {
          dataset_id: DATASET,
          request_id: r0.id,
          report: reportWith("review", { "tooling-debris": 1, "edf-startdate-unparsed": 2 }),
        },
        dispatches[0].client_payload.callback_token,
      );
      const mail = sendsTo(calls, ADMIN_EMAIL)[0];
      expect(mail.html).toContain("tooling-debris x1");
      expect(mail.html).not.toContain("Warning: acquisition dates");
      expect(mail.html).not.toContain("NEMAR does not change them");
      const status = await app.request(
        `/datasets/${DATASET}/publish/status`,
        { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(),
      );
      expect(await status.text()).not.toContain("acquisition dates");
    });
  });

  test("a dates-only verdict whose stored report does not read back still warns, and is not silent", async () => {
    await requestPublication();
    const HAND_EDITED = `{"scan":{"id":"${LEAK} 1985-03-15"}}`;
    db.run(
      `UPDATE publication_requests
          SET identifier_screen_status = 'dates-only', identifier_screen_report = ?
        WHERE dataset_id = ?`,
      [HAND_EDITED, DATASET],
    );
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    let body: { identifier_screen: { headline: string; lines: string[] } };
    try {
      const res = await app.request(
        `/datasets/${DATASET}/publish/status`,
        { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(),
      );
      body = (await res.json()) as typeof body;
    } finally {
      console.warn = warn;
    }
    expect(body.identifier_screen.headline).toBe(
      "Identifier screen: clean (acquisition dates only)",
    );
    // The verdict is on the row, so the warning is, with its count left out.
    expect(body.identifier_screen.lines).toEqual([
      "Warning: acquisition dates finer than year and month were found in recording headers or scans tables.",
      ...WARNING(1).slice(1),
    ]);
    // And the unreadable report is said once, in the parser's word, never its text.
    const said = warnings.filter((w) => w.includes("a stored report does not read back"));
    expect(said.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(w).not.toContain(LEAK);
      expect(w).not.toContain("1985");
    }
  });

  test("a hostile count never reaches the warning: the report is refused, and no date is mailed", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      const report = reportWith("dates-only", {});
      (report.scan as Record<string, unknown>).findings_by_kind = {
        "edf-startdate": "SMITH 1985-03-15",
      };
      await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report },
        dispatches[0].client_payload.callback_token,
      );
      expect(row().identifier_screen_status).toBe("error");
      const mail = sendsTo(calls, ADMIN_EMAIL)[0];
      expect(mail.html).not.toContain("1985");
      expect(mail.html).not.toContain(LEAK);
      expect(mail.html).not.toContain("Warning: acquisition dates");
    });
  });
});

describe("resend", () => {
  test("is refused while the screen runs, and carries the stored result after", async () => {
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      const resend = () =>
        app.request(
          `/datasets/${DATASET}/publish/resend`,
          { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
          env(),
        );
      const pending = await resend();
      expect(pending.status).toBe(409);
      expect(((await pending.json()) as { error: string }).error).toBe("identifier_screen_pending");

      await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
        dispatches[0].client_payload.callback_token,
      );
      db.run(
        "UPDATE publication_requests SET updated_at = datetime('now', '-2 hours') WHERE id = ?",
        [r0.id],
      );
      const ok = await resend();
      expect(ok.status).toBe(200);
      const mails = sendsTo(calls, ADMIN_EMAIL);
      expect(mails).toHaveLength(2);
      expect(mails[1].subject).toEndWith("IDENTIFIER SCREEN: clean");
    });
  });

  test("a request that predates the screen resends as NOT RUN for this request", async () => {
    db.run(
      `INSERT INTO publication_requests (dataset_id, requested_by, status, requested_at, updated_at)
       VALUES (?, ?, 'requested', datetime('now', '-3 hours'), datetime('now', '-3 hours'))`,
      [DATASET, ownerId],
    );
    await withFakeResend(async (calls) => {
      const res = await app.request(
        `/datasets/${DATASET}/publish/resend`,
        { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(),
      );
      expect(res.status).toBe(200);
      const mail = sendsTo(calls, ADMIN_EMAIL)[0];
      expect(mail.subject).toEndWith("IDENTIFIER SCREEN: NOT RUN for this request");
    });
  });
});

describe("re-requesting a blocked request resets the screen", () => {
  test("a stale clean result, its acknowledgment and its email claim do not carry over", async () => {
    db.run(
      `INSERT INTO publication_requests
         (dataset_id, requested_by, status, block_reason,
          identifier_screen_status, identifier_screen_report, identifier_screen_at,
          identifier_screen_emailed_at, identifier_screen_ack_by, identifier_screen_ack_reason,
          identifier_screen_ack_at, identifier_screen_nonce)
       VALUES (?, ?, 'blocked', 'bids_validation_failed', 'review', ?, datetime('now'),
               datetime('now'), ?, 'looked at it already', datetime('now'), 'old-nonce')`,
      [DATASET, ownerId, JSON.stringify(cleanScreenReportBody(DATASET)), ownerId],
    );
    await withFakeResend(async () => {
      const res = await requestPublication();
      expect(res.status).toBe(200);
    });
    const r = row();
    expect(r.status).toBe("requested");
    expect(r.identifier_screen_status).toBe("pending");
    expect(r.identifier_screen_nonce).not.toBe("old-nonce");
    expect(r.identifier_screen_report).toBeNull();
    expect(r.identifier_screen_emailed_at).toBeNull();
    expect(r.identifier_screen_ack_by).toBeNull();
    expect(r.identifier_screen_ack_reason).toBeNull();
    expect(r.identifier_screen_ack_at).toBeNull();
    expect(dispatches).toHaveLength(1);
  });

  test("the reset is in the unblocking UPDATE itself, not left to the dispatch", async () => {
    // A sandbox exemplar is never dispatched, so nothing after the unblock
    // touches the screen columns: only the unblocking statement can clear them.
    const XX = "xx099951";
    seedDataset(XX, { exemplar: true });
    envOverrides = { ENVIRONMENT: "staging" } as Partial<Bindings>;
    db.run(
      `INSERT INTO publication_requests
         (dataset_id, requested_by, status, block_reason, identifier_screen_status,
          identifier_screen_ack_by, identifier_screen_ack_at, identifier_screen_emailed_at)
       VALUES (?, ?, 'blocked', 'bids_validation_failed', 'clean', ?, datetime('now'), datetime('now'))`,
      [XX, ownerId, ownerId],
    );
    const res = await requestPublication(XX);
    expect(res.status).toBe(200);
    const r = row(XX);
    expect(r.status).toBe("requested");
    expect(r.identifier_screen_status).toBeNull();
    expect(r.identifier_screen_ack_by).toBeNull();
    expect(r.identifier_screen_ack_at).toBeNull();
    expect(r.identifier_screen_emailed_at).toBeNull();
  });
});

/** The notice of ADR 0090 (amendment "what an accepted request is told"), spelled out so a change to the shared words fails here. */
const NOTICE = (id: string) => [
  "Your request was received.",
  "NEMAR is checking publication eligibility.",
  "If every check passes, an administrator is notified to approve it.",
  "You will be emailed if a check needs your attention, and when an administrator decides.",
  `Run 'nemar dataset publish status ${id}' to see where it stands.`,
];

type RequestBody = {
  request_notice?: string[];
  identifier_screen?: { state: string };
  error?: string;
  message?: string;
  status?: string;
};

describe("an accepted request answers with the neutral notice (ADR 0090, what an accepted request is told)", () => {
  test("a new request: the notice, for this dataset, beside a screen that is still running", async () => {
    await withFakeResend(async () => {
      const res = await requestPublication();
      expect(res.status).toBe(200);
      const body = (await res.json()) as RequestBody;
      expect(body.request_notice).toEqual(NOTICE(DATASET));
      expect(body.identifier_screen?.state).toBe("pending");
      // A second dataset gets its own id in the pointer, not a fixed one.
      const other = (await (await requestPublication(OTHER)).json()) as RequestBody;
      expect(other.request_notice).toEqual(NOTICE(OTHER));
    });
  });

  test("it does not depend on the screen: one that could not start and an exempt sandbox get the same words", async () => {
    // The screen runs after the request. Whatever state it is in when the
    // answer is written, the requester is told the same thing.
    await withFakeResend(async () => {
      dispatchStatus = 500;
      const failed = (await (await requestPublication()).json()) as RequestBody;
      expect(failed.identifier_screen?.state).toBe("error");
      expect(failed.request_notice).toEqual(NOTICE(DATASET));
    });
    const XX = "xx099952";
    seedDataset(XX, { exemplar: true });
    envOverrides = { ENVIRONMENT: "staging" } as Partial<Bindings>;
    const exempt = (await (await requestPublication(XX)).json()) as RequestBody;
    expect(exempt.identifier_screen?.state).toBe("exempt");
    expect(exempt.request_notice).toEqual(NOTICE(XX));
  });

  test("re-requesting a blocked request reuses its row and is told the same", async () => {
    // The open row is reused. It carries a stale dates-only result: the answer
    // shows the screen as running again, and its date warning (which belongs
    // to `publish status` and the mail) is not in the answer anywhere.
    db.run(
      `INSERT INTO publication_requests (dataset_id, requested_by, status, block_reason)
       VALUES (?, ?, 'blocked', 'bids_validation_failed')`,
      [DATASET, ownerId],
    );
    markScreen(db, row().id, DATASET, { status: "dates-only", findings: { "edf-startdate": 3 } });
    await withFakeResend(async () => {
      const res = await requestPublication();
      expect(res.status).toBe(200);
      const body = (await res.json()) as RequestBody;
      expect(body.request_notice).toEqual(NOTICE(DATASET));
      expect(body.identifier_screen?.state).toBe("pending");
      expect(JSON.stringify(body)).not.toMatch(/edf-startdate|acquisition dates/);
      // Still the one row, now requested.
      const count = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM publication_requests WHERE dataset_id = ?",
        )
        .get(DATASET)?.n;
      expect(count).toBe(1);
      expect(row().status).toBe("requested");
    });
  });
});

describe("a request refused up front keeps its own text and carries no notice", () => {
  const STRANGER_KEY = "screen-stranger-key-0123456789abcdef0123456789abcdef";

  /** Assert a refusal: its status, its own words, and no part of the notice. */
  async function refused(
    res: Response,
    status: number,
    expected: { error?: string; message?: string },
  ) {
    expect(res.status).toBe(status);
    const text = await res.text();
    const body = JSON.parse(text) as RequestBody;
    if (expected.error !== undefined) expect(body.error).toBe(expected.error);
    if (expected.message !== undefined) expect(body.message).toBe(expected.message);
    expect(body.request_notice).toBeUndefined();
    expect(text).not.toContain("checking publication eligibility");
    expect(text).not.toContain("Your request was received");
  }

  test("a dataset that does not exist, a requester who does not own it, a malformed flag", async () => {
    await seedUser("screenstranger", "member", "stranger@example.org", STRANGER_KEY);
    await withFakeResend(async () => {
      await refused(await requestPublication("nm000999"), 404, { error: "Dataset not found" });
      const notOwner = await app.request(
        `/datasets/${DATASET}/publish/request`,
        { method: "POST", headers: { Authorization: `Bearer ${STRANGER_KEY}` } },
        env(),
      );
      await refused(notOwner, 403, { error: "Only the dataset owner can request publication" });
      const malformed = await app.request(
        `/datasets/${DATASET}/publish/request`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ anonymous: "true" }),
        },
        env(),
      );
      await refused(malformed, 400, { error: "invalid_anonymous" });
      expect(dispatches).toHaveLength(0);
    });
  });

  test("a dataset that is already published", async () => {
    db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?", [DATASET]);
    await refused(await requestPublication(), 409, { error: "Dataset is already published" });
  });

  test("a request that is already open: 'requested' says resend, 'approving' says in progress", async () => {
    db.run(
      "INSERT INTO publication_requests (dataset_id, requested_by, status) VALUES (?, ?, 'requested')",
      [DATASET, ownerId],
    );
    await refused(await requestPublication(), 409, {
      error: "A publication request already exists",
      message: "Use 'resend' to remind admins",
    });
    db.run("UPDATE publication_requests SET status = 'approving' WHERE dataset_id = ?", [DATASET]);
    await refused(await requestPublication(), 409, {
      error: "A publication request already exists",
      message: "Publication is in progress",
    });
    expect(dispatches).toHaveLength(0);
  });

  test("a request blocked up front (the owner has no citable name)", async () => {
    db.run("UPDATE users SET given_name = NULL, family_name = NULL WHERE id = ?", [ownerId]);
    await refused(await requestPublication(), 422, {});
    expect(row().status).toBe("blocked");
    expect(dispatches).toHaveLength(0);
  });
});

describe("what the screen exempts", () => {
  test("only a well-formed xx id is exempt; OpenNeuro mirrors are screened", () => {
    // `on` datasets are screened like any other. The importer requests and
    // approves in one run and will meet the gate; making it scrub in place and
    // wait for the screen is Phase 7's (#1618), not an exemption here.
    expect(isScreenExempt("xx000001")).toBe(true);
    expect(isScreenExempt("xx099950")).toBe(true);
    for (const id of [
      "on000001",
      "nm000001",
      "xx00001",
      "xxx00001",
      "xx0000011",
      "XX000001",
      "nmxx0001",
      "",
    ]) {
      expect(isScreenExempt(id)).toBe(false);
    }
  });
});

describe("dev and staging safety", () => {
  test("outside production a result mails nobody unless admin mail is opted in", async () => {
    envOverrides = { ENVIRONMENT: "staging" } as Partial<Bindings>;
    await withFakeResend(async (calls) => {
      await requestPublication();
      const r0 = row();
      const res = await postCallback(
        { dataset_id: DATASET, request_id: r0.id, report: cleanScreenReportBody(DATASET) },
        dispatches[0].client_payload.callback_token,
      );
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(0);
      // Not mailed, so not marked mailed.
      expect(row().identifier_screen_emailed_at).toBeNull();
    });
  });

  test("the watchdog does nothing outside production", async () => {
    await requestPublication();
    db.run(
      "UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-3 hours')",
    );
    for (const environment of ["staging", "development", "test"]) {
      const result = await sweepIdentifierScreens({
        ...env(),
        ENVIRONMENT: environment,
      } as Bindings);
      expect(result.skipped).toBe(true);
      expect(row().identifier_screen_status).toBe("pending");
    }
    // The control: in production the same row IS swept.
    await withFakeResend(async () => {
      expect((await sweepIdentifierScreens(env())).timedOut).toBe(1);
    });
  });

  test("a sandbox exemplar is not screened, and is mailed at once as not applicable", async () => {
    const XX = "xx099950";
    seedDataset(XX, { exemplar: true });
    envOverrides = {
      ENVIRONMENT: "staging",
      DEV_ADMIN_NOTIFICATIONS: "1",
      DEV_EMAIL_ALLOWLIST: ADMIN_EMAIL,
    } as Partial<Bindings>;
    await withFakeResend(async (calls) => {
      const res = await requestPublication(XX);
      expect(res.status).toBe(200);
      expect(dispatches).toHaveLength(0);
      const r = row(XX);
      expect(r.identifier_screen_status).toBeNull();
      expect(r.identifier_screen_nonce).toBeNull();
      const mail = sendsTo(calls, ADMIN_EMAIL)[0];
      expect(mail.subject).toEndWith("IDENTIFIER SCREEN: not applicable (sandbox)");
    });
  });
});
