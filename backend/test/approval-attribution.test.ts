/**
 * Who a publication is recorded as approved by (ADR 0080, and ADR 0105 decisions 1 to 6, #1604).
 *
 * Attribution forks on whether the call proves it belongs to a web click. A terminal approval
 * records the account that called `/approve`, as it always has. A web approval is executed by a
 * workflow that authenticates with its own service key, so recording the caller would name the bot
 * for every one of them; instead the admin who clicked Approve on the website, whom the dispatch
 * route stored in `approval_requested_by`, is the approver, and the executing account is kept as
 * `executed_by` in the audit details. The call proves it belongs to that click by presenting the
 * click's dispatch token (the `X-Approval-Dispatch-Token` header), a MAC over the claim's own
 * columns: a call with no token is the caller's own act, whatever claim is on the row, and a call
 * whose token is stale or lapsed is refused and changes nothing.
 *
 * Driven through the real routes, not the helper: `/approve` runs the resume path (only the two
 * logged no-op steps remain, as in publication-approve-golden.test.ts) so no external service is
 * touched, and one case chains the real dispatch route into it. Real engine only: bun:sqlite behind
 * realD1 with every migration applied, the real auth middleware, and a `Bun.serve()` stand-in for
 * api.github.com for the one dispatch. A claim and its token come from `webClaim`, which signs with
 * the production signer over the row as stored.
 *
 * Each request carries a clean identifier screen of the commit the stand-in reports as `main`
 * (epic #1610 phase 4), because the gate runs before the approver is recorded; the gate itself is
 * pinned in identifier-screen-gate.test.ts.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import {
  APPROVAL_REFUSAL_ERROR_CODES,
  DECISION_WITH_DISPATCH_TOKEN_MESSAGE,
  DISPATCH_EXPIRED_MESSAGE,
  DISPATCH_SUPERSEDED_MESSAGE,
  REQUEST_CHANGED_MESSAGE,
  REQUEST_MISMATCH_MESSAGE,
} from "../../shared/contract/publication.js";
import { PUBLICATION_STEPS } from "../../shared/publication-steps.js";
import { adminRoutes } from "../src/routes/admin";
import { signApprovalDispatchToken } from "../src/services/github/callback-tokens";
import { IDENTIFIER_SCREEN_BLOCK_REASON } from "../src/services/identifier-screen";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { mainRefAnswer, markDatasetScreensClean } from "./helpers/identifier-screen";
import { WEB_CLAIM_SECRET, webClaim } from "./helpers/publication-review";

const EXECUTOR_KEY = "attrib-executor-key-0123456789abcdef0123456789abcdef";
const CLICKER_KEY = "attrib-clicker-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm098765";

// Everything done except the two no-op steps, so a resumed run reaches the
// finalize block (approved_by, the dataset_published audit row) with no network.
const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

let server: Server;
let dispatched = 0;
/** The `client_payload` of every dispatch the stand-in received. */
let payloads: Record<string, unknown>[] = [];
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;
let ownerId: number;
let executorId: number;
let clickerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      // The identifier screen gate's read of `main` is not a dispatch.
      const ref = mainRefAnswer(req);
      if (ref) return ref;
      dispatched += 1;
      const sent = (await req.json().catch(() => null)) as {
        client_payload?: Record<string, unknown>;
      } | null;
      if (sent?.client_payload) payloads.push(sent.client_payload);
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

async function seedAdmin(
  username: string | null,
  email: string,
  key: string | null,
): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES (?, ?, 'x', 'approved', 'admin', 1, 'Test', 'Admin')`,
    [username, email],
  );
  const u = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!u) throw new Error(`seed: ${email} insert failed`);
  if (key) {
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      u.id,
      await hashApiKey(key),
      key.slice(0, 8),
    );
  }
  return u.id;
}

interface RequestSeed {
  stepsDone?: readonly string[];
  status?: string;
  /** SQLite modifier such as "-1 minutes" for the request's last sign of life; default now. */
  updatedAt?: string;
  lastError?: string;
}

/** A pending request, with no claim on it: a click's claim is made with {@link claim}. */
function seedRequest(seed: RequestSeed = {}): number {
  const modifier = (m: string | undefined) => (m ? `datetime('now', '${m}')` : "NULL");
  db.run(
    `INSERT OR IGNORE INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES (?, 'Attribution Dataset', ?, ?, 'private')`,
    [DATASET, ownerId, `nemarDatasets/${DATASET}`],
  );
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, steps_completed, last_error)
     VALUES (?, ?, ?, datetime('now', '-3 hours'),
             ${seed.updatedAt ? modifier(seed.updatedAt) : "datetime('now')"}, ?, ?)`,
    [
      DATASET,
      seed.status ?? "requested",
      ownerId,
      JSON.stringify(seed.stepsDone ?? DONE),
      seed.lastError ?? null,
    ],
  );
  const id = db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
  markDatasetScreensClean(db, DATASET);
  return id;
}

/** A web approval that was dispatched a minute ago: the clicker's lease is live. */
const LIVE = "-1 minutes";

/** A click's claim on request `id` and the token its dispatch carried (the production signer). */
const claim = (id: number, clicker: number, dispatchedAt = LIVE): Promise<string> =>
  webClaim(db, { requestId: id, clickerId: clicker, dispatchedAt });

function approveAs(
  key: string,
  token?: string | null,
  bindings: Bindings = env,
  body: Record<string, unknown> = { resume: true },
): Promise<Response> {
  return app.request(
    `/admin/publish/${DATASET}/approve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(token === undefined || token === null ? {} : { "X-Approval-Dispatch-Token": token }),
      },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function publishedAudit() {
  const row = db
    .query<{ user_id: number; details: string }, []>(
      "SELECT user_id, details FROM audit_log WHERE action = 'dataset_published'",
    )
    .get();
  return row ? { userId: row.user_id, details: JSON.parse(row.details) } : null;
}

function approvedBy(id?: number): number | null {
  return (
    db
      .query<{ approved_by: number | null }, [string]>(
        `SELECT approved_by FROM publication_requests WHERE dataset_id = ? ${
          id === undefined ? "" : `AND id = ${id}`
        } ORDER BY id DESC LIMIT 1`,
      )
      .get(DATASET)?.approved_by ?? null
  );
}

type Row = Record<string, unknown>;

/** Everything on the request row and in the audit log: what a refused call must leave as it was. */
function everything(id: number): { request: Row; audit: Row[]; reviews: Row[] } {
  return {
    request: db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Row,
    audit: db.query("SELECT * FROM audit_log ORDER BY id").all() as Row[],
    reviews: db.query("SELECT * FROM publication_reviews ORDER BY id").all() as Row[],
  };
}

function claimOf(id: number): { by: number | null; at: string | null } {
  const row = db
    .query<
      { approval_requested_by: number | null; approval_dispatched_at: string | null },
      [number]
    >("SELECT approval_requested_by, approval_dispatched_at FROM publication_requests WHERE id = ?")
    .get(id);
  return { by: row?.approval_requested_by ?? null, at: row?.approval_dispatched_at ?? null };
}

/** A refusal of a token: 409, the code and its sentence, and nothing changed anywhere. */
async function expectRefusedUntouched(
  res: Response,
  id: number,
  error: "dispatch_superseded" | "dispatch_expired",
  before: ReturnType<typeof everything>,
): Promise<void> {
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error,
    message: error === "dispatch_expired" ? DISPATCH_EXPIRED_MESSAGE : DISPATCH_SUPERSEDED_MESSAGE,
  });
  expect(everything(id)).toEqual(before);
  expect(publishedAudit()).toBeNull();
  expect(approvedBy(id)).toBeNull();
}

beforeEach(async () => {
  db = freshDb();
  dispatched = 0;
  payloads = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  env = {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "test-pat",
    PRESCREEN_CALLBACK_SECRET: WEB_CLAIM_SECRET,
  } as Bindings;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('attribowner', 'attribowner@example.org', 'x', 'approved', 'member', 1, 'Owen', 'Owner')`,
  );
  ownerId = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='attribowner'").get()
    ?.id as number;
  executorId = await seedAdmin("approvebot", "approvebot@example.org", EXECUTOR_KEY);
  clickerId = await seedAdmin("webclicker", "webclicker@example.org", CLICKER_KEY);
});

describe("a terminal approval", () => {
  test("is recorded as approved by the account that called /approve, with the audit row unchanged", async () => {
    seedRequest();
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);

    expect(approvedBy()).toBe(executorId);
    const audit = publishedAudit();
    expect(audit?.userId).toBe(executorId);
    // What it was before attribution forked, no executed_by key, plus the two fields ADR 0102 adds
    // to every approval's row: the review gate is off here (the flag is unset), and no CI skip.
    expect(audit?.details).toEqual({
      approved_by: "approvebot",
      steps: [...PUBLICATION_STEPS],
      review_gate: "off",
      skip_ci_check: false,
    });
  });

  test("inside a live web claim, with no token, is the caller's own act: recorded as the caller, and it takes the claim over", async () => {
    // The rule (#1604): no token, no clicker, whatever the lease says. The mark that starts the run
    // also ends the click's claim, so the executor that the click dispatched is refused from here on.
    const id = seedRequest();
    await claim(id, clickerId);
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);

    expect(approvedBy()).toBe(executorId);
    expect(publishedAudit()?.userId).toBe(executorId);
    // The caller is the approver, so there is no separate executor to name.
    expect(publishedAudit()?.details).not.toHaveProperty("executed_by");
    expect(claimOf(id)).toEqual({ by: null, at: null });
  });
});

describe("a web-queued approval: the call that carries the click's token", () => {
  test("is recorded as approved by the admin who clicked, not the executing key", async () => {
    const id = seedRequest();
    const token = await claim(id, clickerId);
    const res = await approveAs(EXECUTOR_KEY, token);
    expect(res.status).toBe(200);

    expect(approvedBy()).toBe(clickerId);
    const audit = publishedAudit();
    expect(audit?.userId).toBe(clickerId);
    expect(audit?.details).toEqual({
      approved_by: "webclicker",
      executed_by: "approvebot",
      steps: [...PUBLICATION_STEPS],
      review_gate: "off",
      skip_ci_check: false,
    });
    expect(executorId).not.toBe(clickerId);
  });

  test("end to end: the real dispatch route mints the token, the real /approve run presents it and records the clicker", async () => {
    seedRequest();
    const dispatch = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      { method: "POST", headers: { Authorization: `Bearer ${CLICKER_KEY}` } },
      env,
    );
    expect(dispatch.status).toBe(202);
    expect(dispatched).toBe(1);
    const token = payloads[0]?.dispatch_token;
    expect(typeof token).toBe("string");

    // What the workflow does next: call /approve with the executor's own key and the token it was handed.
    const run = await approveAs(EXECUTOR_KEY, token as string);
    expect(run.status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
    expect(publishedAudit()?.userId).toBe(clickerId);
    expect(publishedAudit()?.details).toMatchObject({
      approved_by: "webclicker",
      executed_by: "approvebot",
    });
  });

  test("end to end: the same run with no token is the executor's own act, and the claim is taken over", async () => {
    // An executor that predates the token (the rollout window, ADR 0105): it is a
    // terminal caller, recorded as itself, and the click's claim ends with its first mark.
    const id = seedRequest();
    const dispatch = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      { method: "POST", headers: { Authorization: `Bearer ${CLICKER_KEY}` } },
      env,
    );
    expect(dispatch.status).toBe(202);
    expect(claimOf(id).by).toBe(clickerId);

    const run = await approveAs(EXECUTOR_KEY);
    expect(run.status).toBe(200);
    expect(approvedBy()).toBe(executorId);
    expect(claimOf(id)).toEqual({ by: null, at: null });
  });

  test("a clicker who is also the caller has no separate executor to record", async () => {
    const id = seedRequest();
    const token = await claim(id, clickerId);
    const res = await approveAs(CLICKER_KEY, token);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
    expect(publishedAudit()?.details).toEqual({
      approved_by: "webclicker",
      steps: [...PUBLICATION_STEPS],
      review_gate: "off",
      skip_ci_check: false,
    });
  });

  test("a clicker with no username is named by email", async () => {
    // Web-only accounts may have no username until onboarded.
    const nameless = await seedAdmin(null, "nameless@example.org", null);
    const id = seedRequest();
    const token = await claim(id, nameless);
    const res = await approveAs(EXECUTOR_KEY, token);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(nameless);
    expect(publishedAudit()?.details.approved_by).toBe("nameless@example.org");
  });

  test("a clicker whose account is gone does not fail the publication: the caller stands in", async () => {
    const gone = await seedAdmin("vanished", "vanished@example.org", null);
    const id = seedRequest();
    const token = await claim(id, gone);
    db.run("DELETE FROM users WHERE id = ?", [gone]);

    const res = await approveAs(EXECUTOR_KEY, token);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(executorId);
    expect(publishedAudit()?.userId).toBe(executorId);
  });

  // A run carries on after its clicker's access ends. The executing key is who
  // actually finishes it, so that is who is recorded; the dispatch's own audit
  // row still names the clicker by id. The token is genuine here: it is the
  // clicker's role and status that are re-checked, at each use.
  const AFTER_ACCESS_ENDED = [
    ["demoted to member", "UPDATE users SET role = 'member' WHERE id = ?"],
    ["revoked", "UPDATE users SET status = 'revoked' WHERE id = ?"],
    ["soft-deleted", "UPDATE users SET deleted_at = datetime('now') WHERE id = ?"],
  ] as const;

  for (const [label, update] of AFTER_ACCESS_ENDED) {
    test(`a clicker who has since been ${label} is not recorded, though the token is genuine: the caller stands in`, async () => {
      const clicker = await seedAdmin("lapsedclicker", "lapsedclicker@example.org", null);
      const id = seedRequest();
      const token = await claim(id, clicker);
      db.run(update, [clicker]);

      const res = await approveAs(EXECUTOR_KEY, token);
      expect(res.status).toBe(200);
      expect(approvedBy()).toBe(executorId);
      expect(publishedAudit()?.userId).toBe(executorId);
    });
  }

  test("an owner who clicked is still honored: owner meets the admin requirement", async () => {
    const owner = await seedAdmin("ownerclicker", "ownerclicker@example.org", null);
    db.run("UPDATE users SET role = 'owner' WHERE id = ?", [owner]);
    const id = seedRequest();
    const token = await claim(id, owner);

    const res = await approveAs(EXECUTOR_KEY, token);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(owner);
  });

  for (const [label, header] of [
    ["empty", ""],
    ["blank", "   "],
  ] as const) {
    test(`the ${label} token header is no token: the caller is recorded, and the claim is taken over`, async () => {
      const id = seedRequest();
      await claim(id, clickerId);

      const res = await app.request(
        `/admin/publish/${DATASET}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${EXECUTOR_KEY}`,
            "Content-Type": "application/json",
            "X-Approval-Dispatch-Token": header,
          },
          body: JSON.stringify({ resume: true }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(approvedBy()).toBe(executorId);
      expect(claimOf(id)).toEqual({ by: null, at: null });
    });
  }
});

describe("the token is honored only while its run is live", () => {
  // A call with no token is the caller's own act, so the lease no longer decides who it is; the
  // lease only decides whether a token is still good.
  test("a lapsed lease, no token: the admin who actually runs it at a terminal is recorded, not the stale clicker", async () => {
    // Dispatched 20 minutes ago, quiet since: the executor never ran, or died.
    const id = seedRequest({ updatedAt: "-20 minutes" });
    await claim(id, clickerId, "-20 minutes");
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);

    expect(approvedBy()).toBe(executorId);
    expect(publishedAudit()?.userId).toBe(executorId);
    // The ordinary terminal shape: no executed_by, because there is no fork.
    expect(publishedAudit()?.details).toEqual({
      approved_by: "approvebot",
      steps: [...PUBLICATION_STEPS],
      review_gate: "off",
      skip_ci_check: false,
    });
    expect(claimOf(id)).toEqual({ by: null, at: null });
  });

  test("a run that died partway and is resumed by another admin at a terminal records that admin", async () => {
    // The scenario the rule exists for: approving, quiet for 20 minutes, a stale
    // click on the row. Nobody who did not call is ever recorded.
    const id = seedRequest({ status: "approving", updatedAt: "-20 minutes" });
    await claim(id, clickerId, "-2 hours");
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(executorId);
    expect(publishedAudit()?.userId).toBe(executorId);
  });

  test("a live lease and the token: the clicker is recorded", async () => {
    const id = seedRequest();
    const token = await claim(id, clickerId, "-14 minutes");
    expect((await approveAs(EXECUTOR_KEY, token)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });

  test("a later batch of a long web run still resolves to the clicker", async () => {
    // Dispatched two hours ago, but every batch of the S3 lock loop bumps
    // updated_at, so the call arrives with a fresh heartbeat. The lease is read
    // BEFORE this call's own bump; the token is checked against it.
    const id = seedRequest({ status: "approving", updatedAt: "-1 minutes" });
    const token = await claim(id, clickerId, "-2 hours");
    expect((await approveAs(EXECUTOR_KEY, token)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });

  test("the retry of a failed step still resolves to the clicker", async () => {
    // The CLI retries ten seconds after a failure. The failure-aware in-flight
    // predicate would call this row stalled once its grace passes, but the
    // retry that finishes the run is still the clicker's, so the token is read
    // against the time-only lease.
    const id = seedRequest({
      status: "approving",
      updatedAt: "-10 seconds",
      lastError: "EZID 503",
    });
    const token = await claim(id, clickerId, "-2 hours");
    expect((await approveAs(EXECUTOR_KEY, token)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });

  test("a resume minutes after a failure, past the grace but inside the lease, is still the clicker's", async () => {
    // Past FAILED_RUN_GRACE_SECONDS the failure-aware in-flight predicate calls
    // this run stalled, and a web Resume would be allowed. A rerun of the
    // workflow's job, or a retry after a long rate-limit wait, then resumes it:
    // that is still the clicker's run, which is why the token reads the time-only
    // lease and not the failure-aware one.
    const id = seedRequest({ status: "approving", updatedAt: "-5 minutes", lastError: "EZID 503" });
    const token = await claim(id, clickerId, "-2 hours");
    expect((await approveAs(EXECUTOR_KEY, token)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });

  test("a web run that sat quiet past the lease before its first call is refused as expired, and nothing is recorded", async () => {
    // The cost of the rule, now a refusal and not a silent change of name (#1604): a click made
    // more than 15 minutes ago is not honored for work done now. The page shows the stalled run, and
    // clicking again claims afresh. It was recorded under the executing key before the token.
    const id = seedRequest({ updatedAt: "-16 minutes" });
    const token = await claim(id, clickerId, "-16 minutes");
    const before = everything(id);
    const res = await approveAs(EXECUTOR_KEY, token);
    await expectRefusedUntouched(res, id, "dispatch_expired", before);
  });

  test("an approving run that has been quiet past the lease is expired too, whatever its claim says", async () => {
    const id = seedRequest({
      status: "approving",
      updatedAt: "-16 minutes",
      lastError: "EZID 503",
    });
    const token = await claim(id, clickerId, "-2 hours");
    const before = everything(id);
    const res = await approveAs(EXECUTOR_KEY, token);
    await expectRefusedUntouched(res, id, "dispatch_expired", before);
  });

  test("an expired token is not downgraded to the caller: a fresh click mints a token that works", async () => {
    const id = seedRequest({ updatedAt: "-16 minutes" });
    const stale = await claim(id, clickerId, "-16 minutes");
    expect((await approveAs(EXECUTOR_KEY, stale)).status).toBe(409);
    // The admin clicks again: the claim is made afresh, and its token is the clicker's.
    db.run("UPDATE publication_requests SET updated_at = datetime('now') WHERE id = ?", [id]);
    const fresh = await claim(id, clickerId, "-5 seconds");
    expect(fresh).not.toBe(stale);
    expect((await approveAs(EXECUTOR_KEY, fresh)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });
});

describe("a token that is not the claim's is refused, and never downgraded to the caller", () => {
  test("a newer click replaced the claim: the older run's token is superseded", async () => {
    const id = seedRequest();
    const older = await claim(id, clickerId, "-10 minutes");
    // A second click, by another administrator, claimed the request afresh.
    const second = await seedAdmin("secondclicker", "secondclicker@example.org", null);
    const newer = await claim(id, second, "-1 minutes");
    expect(newer).not.toBe(older);
    const before = everything(id);

    await expectRefusedUntouched(
      await approveAs(EXECUTOR_KEY, older),
      id,
      "dispatch_superseded",
      before,
    );
    // The newer claim is intact and its own run is the second administrator's.
    expect(claimOf(id).by).toBe(second);
    expect((await approveAs(EXECUTOR_KEY, newer)).status).toBe(200);
    expect(approvedBy()).toBe(second);
  });

  test("a re-claim by the SAME administrator at another instant supersedes the first token too", async () => {
    const id = seedRequest();
    const first = await claim(id, clickerId, "-10 minutes");
    await claim(id, clickerId, "-1 minutes");
    const before = everything(id);
    await expectRefusedUntouched(
      await approveAs(EXECUTOR_KEY, first),
      id,
      "dispatch_superseded",
      before,
    );
  });

  test("a claim that is gone (released, or taken over) leaves the token superseded", async () => {
    const id = seedRequest();
    const token = await claim(id, clickerId);
    db.run(
      "UPDATE publication_requests SET approval_requested_by = NULL, approval_dispatched_at = NULL WHERE id = ?",
      [id],
    );
    const before = everything(id);
    await expectRefusedUntouched(
      await approveAs(EXECUTOR_KEY, token),
      id,
      "dispatch_superseded",
      before,
    );
  });

  test("a token for another request is refused: the claim columns copied to the newest request do not carry it", async () => {
    // The binding to the request, proven by moving everything else: request A's click, its claim
    // columns copied by SQL onto request B (the newest active request of the dataset), A's token
    // presented. The MAC covers the request id, so only a token minted for B would verify.
    const a = seedRequest();
    const token = await claim(a, clickerId);
    db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [a]);
    const b = seedRequest();
    db.run(
      `UPDATE publication_requests
          SET approval_requested_by = (SELECT approval_requested_by FROM publication_requests WHERE id = ?),
              approval_dispatched_at = (SELECT approval_dispatched_at FROM publication_requests WHERE id = ?)
        WHERE id = ?`,
      [a, a, b],
    );
    expect(claimOf(b)).toEqual(claimOf(a));
    const before = everything(b);

    await expectRefusedUntouched(
      await approveAs(EXECUTOR_KEY, token),
      b,
      "dispatch_superseded",
      before,
    );
    // The control: a token minted for B itself, from B's own row, verifies.
    const own = await signApprovalDispatchToken(
      {
        datasetId: DATASET,
        requestId: b,
        clickerId,
        claimedAt: claimOf(b).at as string,
      },
      WEB_CLAIM_SECRET,
    );
    expect((await approveAs(EXECUTOR_KEY, own)).status).toBe(200);
    expect(approvedBy(b)).toBe(clickerId);
  });

  test("a token for another clicker, another dataset or signed with another key is not the claim's", async () => {
    const id = seedRequest();
    await claim(id, clickerId);
    const claimedAt = claimOf(id).at as string;
    const sign = (over: Partial<{ datasetId: string; clickerId: number }>, secret: string) =>
      signApprovalDispatchToken(
        { datasetId: DATASET, requestId: id, clickerId, claimedAt, ...over },
        secret,
      );
    const forged = [
      await sign({ clickerId: executorId }, WEB_CLAIM_SECRET),
      await sign({ datasetId: "nm000999" }, WEB_CLAIM_SECRET),
      await sign({}, "another-workers-secret"),
      "not-a-token",
      "0".repeat(64),
    ];
    for (const token of forged) {
      const before = everything(id);
      await expectRefusedUntouched(
        await approveAs(EXECUTOR_KEY, token),
        id,
        "dispatch_superseded",
        before,
      );
    }
  });

  test("a Worker that has no secret cannot check a token, so it honors none", async () => {
    const id = seedRequest();
    const token = await claim(id, clickerId);
    const before = everything(id);
    const res = await approveAs(EXECUTOR_KEY, token, {
      ...env,
      PRESCREEN_CALLBACK_SECRET: undefined,
    } as Bindings);
    await expectRefusedUntouched(res, id, "dispatch_superseded", before);
  });

  const article = (word: string) => (/^[aeiou]/.test(word) ? "an" : "a");
  // The order of the checks (ADR 0105, decision 4): the request the run names and the request's own
  // block are decided BEFORE the token, so a call that is wrong about the request is told so even
  // when its token is stale too, and neither word depends on the claim.
  for (const [name, setup] of [
    [
      "superseded",
      async (id: number) => {
        const stale = await claim(id, clickerId, "-10 minutes");
        await claim(id, clickerId, "-1 minutes");
        return stale;
      },
    ],
    [
      "expired",
      async (id: number) => {
        db.run("UPDATE publication_requests SET updated_at = datetime('now', '-20 minutes')");
        return claim(id, clickerId, "-20 minutes");
      },
    ],
  ] as const) {
    test(`${article(name)} ${name} token on a request the run did not name is request_mismatch, not the token's refusal`, async () => {
      const id = seedRequest();
      const stale = await setup(id);
      const before = everything(id);

      const res = await approveAs(EXECUTOR_KEY, stale, env, { resume: true, request_id: id + 100 });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body).toEqual({ error: "request_mismatch", message: REQUEST_MISMATCH_MESSAGE });
      expect(APPROVAL_REFUSAL_ERROR_CODES).toContain(body.error);
      expect(everything(id)).toEqual(before);
    });

    test(`${article(name)} ${name} token on a blocked request is request_blocked, not the token's refusal`, async () => {
      const id = seedRequest();
      const stale = await setup(id);
      db.run(
        "UPDATE publication_requests SET status = 'blocked', block_reason = 'min_requirements_failed' WHERE id = ?",
        [id],
      );
      const before = everything(id);

      const res = await approveAs(EXECUTOR_KEY, stale);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; block_reason?: string };
      expect(body.error).toBe("request_blocked");
      expect(body.block_reason).toBe("min_requirements_failed");
      expect(APPROVAL_REFUSAL_ERROR_CODES).toContain(body.error);
      expect(everything(id)).toEqual(before);
    });
  }

  test("the refusals are in the contract the client leads with the sentence for", () => {
    expect(APPROVAL_REFUSAL_ERROR_CODES).toContain("dispatch_superseded");
    expect(APPROVAL_REFUSAL_ERROR_CODES).toContain("dispatch_expired");
  });
});

describe("the token is a secret on /approve too", () => {
  test("no answer and no log line of a valid, a stale or an expired call carries it", async () => {
    const lines: string[] = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    const keep = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    const answers: string[] = [];
    const tokens: string[] = [];
    try {
      console.log = keep;
      console.warn = keep;
      console.error = keep;

      const live = seedRequest();
      tokens.push(await claim(live, clickerId));
      answers.push(await (await approveAs(EXECUTOR_KEY, tokens[0])).text());

      db.run("DELETE FROM publication_requests");
      const lapsed = seedRequest({ updatedAt: "-16 minutes" });
      tokens.push(await claim(lapsed, clickerId, "-16 minutes"));
      answers.push(await (await approveAs(EXECUTOR_KEY, tokens[1])).text());

      db.run("DELETE FROM publication_requests");
      const replaced = seedRequest();
      tokens.push(await claim(replaced, clickerId, "-10 minutes"));
      await claim(replaced, clickerId, "-1 minutes");
      answers.push(await (await approveAs(EXECUTOR_KEY, tokens[2])).text());
    } finally {
      console.log = real.log;
      console.warn = real.warn;
      console.error = real.error;
    }
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) {
      expect(lines.join("\n")).not.toContain(token);
      for (const answer of answers) expect(answer).not.toContain(token);
    }
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("the mark is conditional on the claim the call proved", () => {
  /** Run `act` once, just before the mark that starts the run: another writer, between the check and the mark. */
  function raceBeforeMark(act: () => void): Bindings {
    let done = false;
    return {
      ...env,
      DB: interceptingD1(realD1(db), (sql) => {
        if (!done && sql.includes("SET status = 'approving'")) {
          done = true;
          act();
        }
      }),
    } as Bindings;
  }

  test("a claim replaced after the token was checked refuses the mark: superseded, nothing marked", async () => {
    const id = seedRequest();
    const token = await claim(id, clickerId, "-10 minutes");
    const second = await seedAdmin("secondclicker", "secondclicker@example.org", null);
    let newer = "";
    const bindings = raceBeforeMark(() => {
      // A newer click by another administrator, landing between the call's read and its mark.
      db.run(
        `UPDATE publication_requests
            SET approval_requested_by = ?, approval_dispatched_at = datetime('now', '-1 minutes')
          WHERE id = ?`,
        [second, id],
      );
      newer = claimOf(id).at as string;
    });

    const res = await approveAs(EXECUTOR_KEY, token, bindings);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "dispatch_superseded",
      message: DISPATCH_SUPERSEDED_MESSAGE,
    });
    const row = db
      .query<{ status: string; approved_by: number | null }, [number]>(
        "SELECT status, approved_by FROM publication_requests WHERE id = ?",
      )
      .get(id);
    expect(row).toEqual({ status: "requested", approved_by: null });
    // The newer click's claim is exactly as it landed, and no approval was recorded under anybody.
    expect(claimOf(id)).toEqual({ by: second, at: newer });
    expect(publishedAudit()).toBeNull();
  });

  test("a claim released after the token was checked refuses the mark too", async () => {
    const id = seedRequest();
    const token = await claim(id, clickerId);
    const bindings = raceBeforeMark(() => {
      db.run(
        "UPDATE publication_requests SET approval_requested_by = NULL, approval_dispatched_at = NULL WHERE id = ?",
        [id],
      );
    });

    const res = await approveAs(EXECUTOR_KEY, token, bindings);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("dispatch_superseded");
    expect(
      db
        .query<{ status: string }, [number]>("SELECT status FROM publication_requests WHERE id = ?")
        .get(id)?.status,
    ).toBe("requested");
    expect(publishedAudit()).toBeNull();
  });

  test("a request that changed under an intact claim is request_changed, not a replaced claim", async () => {
    // The claim is the click's still; it is the REQUEST that moved (the identifier screen blocked
    // it between the check and the mark), so "your click was replaced" would be false and the
    // sentence is the one every other approval gets for the same change. The statement is the shape
    // of the screen's block (`blockForFindings`, services/identifier-screen.ts): the one writer that
    // blocks a request and leaves a live claim standing. The publication review's re-block clears
    // the claim, so a token call racing it is answered `dispatch_superseded` instead.
    const id = seedRequest();
    const token = await claim(id, clickerId);
    const bindings = raceBeforeMark(() => {
      db.run(
        "UPDATE publication_requests SET status = 'blocked', block_reason = ?, updated_at = datetime('now') WHERE id = ? AND status = 'requested'",
        [IDENTIFIER_SCREEN_BLOCK_REASON, id],
      );
    });

    const res = await approveAs(EXECUTOR_KEY, token, bindings);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "request_changed",
      message: REQUEST_CHANGED_MESSAGE,
    });
    expect(
      db
        .query<{ status: string }, [number]>("SELECT status FROM publication_requests WHERE id = ?")
        .get(id)?.status,
    ).toBe("blocked");
    expect(claimOf(id).by).toBe(clickerId);
  });

  test("a read that fails after the mark changed nothing answers 500, which the caller retries, never a false dispatch_superseded", async () => {
    // The mark changed nothing, and the read that tells a replaced claim from a changed request
    // then fails. Nothing proved the claim was replaced, so the answer is the retryable one: the
    // CLI does not retry a 409, and a false "your click was replaced" would end a live run for good.
    const id = seedRequest();
    const token = await claim(id, clickerId);
    const claimBefore = claimOf(id);
    let marked = false;
    const bindings = {
      ...env,
      DB: interceptingD1(realD1(db), (sql) => {
        if (!marked && sql.includes("SET status = 'approving'")) {
          marked = true;
          // A denial between the check and the mark, so the mark finds nothing to change.
          db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [id]);
        } else if (marked && /^SELECT approval_dispatched_at FROM publication_requests/.test(sql)) {
          throw new Error("D1 read failed for the test");
        }
      }),
    } as Bindings;

    const lines: string[] = [];
    const real = { warn: console.warn, error: console.error };
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    let res: Response;
    try {
      res = await approveAs(EXECUTOR_KEY, token, bindings);
    } finally {
      console.warn = real.warn;
      console.error = real.error;
    }

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("dispatch_superseded");
    // The failure is on the record, by words and ids, with its cause and never the token.
    const line = lines.find((l) => l.includes("could not tell"));
    expect(line).toBeDefined();
    expect(line).toContain(`request ${id}`);
    expect(line).toContain("D1 read failed for the test");
    expect(lines.join("\n")).not.toContain(token);
    // Nothing was marked or recorded, and the click's claim is as it was.
    expect(approvedBy(id)).toBeNull();
    expect(publishedAudit()).toBeNull();
    expect(claimOf(id)).toEqual(claimBefore);
  });

  test("a call with no token has no claim to prove, so the same race does not refuse it: it takes whatever claim is there", async () => {
    const id = seedRequest();
    await claim(id, clickerId, "-10 minutes");
    const second = await seedAdmin("secondclicker", "secondclicker@example.org", null);
    const bindings = raceBeforeMark(() => {
      db.run(
        `UPDATE publication_requests
            SET approval_requested_by = ?, approval_dispatched_at = datetime('now', '-1 minutes')
          WHERE id = ?`,
        [second, id],
      );
    });

    const res = await approveAs(EXECUTOR_KEY, null, bindings);

    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(executorId);
    expect(claimOf(id)).toEqual({ by: null, at: null });
  });
});

describe("a decision does not travel with a token", () => {
  // The full matrix is in publication-review-gate.test.ts, where a review needs the override. Here:
  // the refusal comes before any write, and a token-bearing call that sends no decision is unaffected.
  test("an acknowledgment in the body of a call that carries the token is refused, with nothing written", async () => {
    const id = seedRequest();
    const token = await claim(id, clickerId);
    const before = everything(id);
    const res = await approveAs(EXECUTOR_KEY, token, env, {
      resume: true,
      acknowledge_identifier_screen: "Read the recording formats by hand, nothing to remove",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "decision_with_dispatch_token",
      message: DECISION_WITH_DISPATCH_TOKEN_MESSAGE,
    });
    expect(everything(id)).toEqual(before);
    expect(APPROVAL_REFUSAL_ERROR_CODES).toContain("decision_with_dispatch_token");
  });
});

describe("a failed owner notification", () => {
  // notify_user is non-fatal: the DOI is already minted, so an email failure is
  // audited and the publication stands. A non-production Worker refuses mail to
  // a recipient off its allow-list, and the step treats that refusal as a
  // failure, which reaches the audit row with nothing faked.
  test("is audited under the approver, not the executing key", async () => {
    const id = seedRequest({ stepsDone: DONE.filter((s) => s !== "notify_user") });
    const token = await claim(id, clickerId);
    const res = await approveAs(EXECUTOR_KEY, token);
    expect(res.status).toBe(200);

    const failed = db
      .query<{ user_id: number }, []>(
        "SELECT user_id FROM audit_log WHERE action = 'notify_user_failed'",
      )
      .get();
    expect(failed?.user_id).toBe(clickerId);
  });
});

describe("the request the run reads", () => {
  test("is the newest active one: an older request's clicker is not used", async () => {
    // An older, since-denied request carries another admin's click. The run acts
    // on the newest ACTIVE request only, so that stale click must not leak in.
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
       VALUES (?, 'Attribution Dataset', ?, ?, 'private')`,
      [DATASET, ownerId, `nemarDatasets/${DATASET}`],
    );
    db.run(
      `INSERT INTO publication_requests
         (dataset_id, status, requested_by, requested_at, steps_completed, approval_requested_by)
       VALUES (?, 'denied', ?, datetime('now', '-2 days'), '[]', ?)`,
      [DATASET, ownerId, clickerId],
    );
    db.run(
      `INSERT INTO publication_requests
         (dataset_id, status, requested_by, requested_at, steps_completed)
       VALUES (?, 'requested', ?, datetime('now'), ?)`,
      [DATASET, ownerId, JSON.stringify(DONE)],
    );
    markDatasetScreensClean(db, DATASET);

    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(publishedAudit()?.userId).toBe(executorId);
  });
});
