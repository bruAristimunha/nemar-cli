/**
 * Who a publication is recorded as approved by (ADR 0080).
 *
 * Attribution forks. A terminal approval records the account that called
 * `/approve`, as it always has. A web approval is executed by a workflow that
 * authenticates with its own service key, so recording the caller would name the
 * bot for every one of them; instead the admin who clicked Approve on the
 * website, whom the dispatch route stored in `approval_requested_by`, is the
 * approver, and the executing account is kept as `executed_by` in the audit
 * details.
 *
 * Driven through the real routes, not the helper: `/approve` runs the resume
 * path (only the two logged no-op steps remain, as in
 * publication-approve-golden.test.ts) so no external service is touched, and one
 * case chains the real dispatch route into it. Real engine only: bun:sqlite
 * behind realD1 with every migration applied, the real auth middleware, and a
 * `Bun.serve()` stand-in for api.github.com for the one dispatch.
 *
 * Each request carries a clean identifier screen of the commit the stand-in
 * reports as `main` (epic #1610 phase 4), because the gate runs before the
 * approver is recorded; the gate itself is pinned in
 * identifier-screen-gate.test.ts.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { PUBLICATION_STEPS } from "../../shared/publication-steps.js";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { mainRefAnswer, markDatasetScreensClean } from "./helpers/identifier-screen";

const EXECUTOR_KEY = "attrib-executor-key-0123456789abcdef0123456789abcdef";
const CLICKER_KEY = "attrib-clicker-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm098765";

// Everything done except the two no-op steps, so a resumed run reaches the
// finalize block (approved_by, the dataset_published audit row) with no network.
const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

let server: Server;
let dispatched = 0;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;
let ownerId: number;
let executorId: number;
let clickerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      // The identifier screen gate's read of `main` is not a dispatch.
      const ref = mainRefAnswer(req);
      if (ref) return ref;
      dispatched += 1;
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
  /** The admin who clicked Approve on the website, if the approval was queued there. */
  clickedBy?: number | null;
  stepsDone?: readonly string[];
  /** SQLite modifier such as "-1 minutes" for when the dispatch was claimed. A web
   *  approval is live when this is within the 15 minute lease. */
  dispatchedAt?: string;
  status?: string;
  updatedAt?: string;
  lastError?: string;
}

/** A pending request whose approval was (or was not) queued from the web. */
function seedRequest(seed: RequestSeed = {}): void {
  const modifier = (m: string | undefined) => (m ? `datetime('now', '${m}')` : "NULL");
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES (?, 'Attribution Dataset', ?, ?, 'private')`,
    [DATASET, ownerId, `nemarDatasets/${DATASET}`],
  );
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, steps_completed,
        approval_requested_by, approval_dispatched_at, last_error)
     VALUES (?, ?, ?, datetime('now', '-3 hours'),
             ${seed.updatedAt ? modifier(seed.updatedAt) : "datetime('now')"},
             ?, ?, ${modifier(seed.dispatchedAt)}, ?)`,
    [
      DATASET,
      seed.status ?? "requested",
      ownerId,
      JSON.stringify(seed.stepsDone ?? DONE),
      seed.clickedBy ?? null,
      seed.lastError ?? null,
    ],
  );
  markDatasetScreensClean(db, DATASET);
}

/** A web approval that was dispatched a minute ago: the clicker's lease is live. */
const LIVE = "-1 minutes";

function approveAs(key: string): Promise<Response> {
  return app.request(
    `/admin/publish/${DATASET}/approve`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resume: true }),
    },
    env,
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

function approvedBy(): number | null {
  return (
    db
      .query<{ approved_by: number | null }, [string]>(
        "SELECT approved_by FROM publication_requests WHERE dataset_id = ?",
      )
      .get(DATASET)?.approved_by ?? null
  );
}

beforeEach(async () => {
  db = freshDb();
  dispatched = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  env = {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "test-pat",
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
});

describe("a web-queued approval", () => {
  test("is recorded as approved by the admin who clicked, not the executing key", async () => {
    seedRequest({ clickedBy: clickerId, dispatchedAt: LIVE });
    const res = await approveAs(EXECUTOR_KEY);
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
  });

  test("end to end: the real dispatch route queues it, the real /approve run records the clicker", async () => {
    seedRequest();
    const dispatch = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      { method: "POST", headers: { Authorization: `Bearer ${CLICKER_KEY}` } },
      env,
    );
    expect(dispatch.status).toBe(202);
    expect(dispatched).toBe(1);

    // What the workflow does next: call /approve with the executor's own key.
    const run = await approveAs(EXECUTOR_KEY);
    expect(run.status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
    expect(publishedAudit()?.userId).toBe(clickerId);
  });

  test("a clicker who is also the caller has no separate executor to record", async () => {
    seedRequest({ clickedBy: clickerId, dispatchedAt: LIVE });
    const res = await approveAs(CLICKER_KEY);
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
    seedRequest({ clickedBy: nameless, dispatchedAt: LIVE });
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(nameless);
    expect(publishedAudit()?.details.approved_by).toBe("nameless@example.org");
  });

  test("a clicker whose account is gone does not fail the publication: the caller stands in", async () => {
    const gone = await seedAdmin("vanished", "vanished@example.org", null);
    seedRequest({ clickedBy: gone, dispatchedAt: LIVE });
    db.run("DELETE FROM users WHERE id = ?", [gone]);

    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(executorId);
    expect(publishedAudit()?.userId).toBe(executorId);
  });

  // A run carries on after its clicker's access ends. The executing key is who
  // actually finishes it, so that is who is recorded; the dispatch's own audit
  // row still names the clicker by id.
  const AFTER_ACCESS_ENDED = [
    ["demoted to member", "UPDATE users SET role = 'member' WHERE id = ?"],
    ["revoked", "UPDATE users SET status = 'revoked' WHERE id = ?"],
    ["soft-deleted", "UPDATE users SET deleted_at = datetime('now') WHERE id = ?"],
  ] as const;

  for (const [label, update] of AFTER_ACCESS_ENDED) {
    test(`a clicker who has since been ${label} is not recorded: the caller stands in`, async () => {
      const clicker = await seedAdmin("lapsedclicker", "lapsedclicker@example.org", null);
      seedRequest({ clickedBy: clicker, dispatchedAt: LIVE });
      db.run(update, [clicker]);

      const res = await approveAs(EXECUTOR_KEY);
      expect(res.status).toBe(200);
      expect(approvedBy()).toBe(executorId);
      expect(publishedAudit()?.userId).toBe(executorId);
    });
  }

  test("an owner who clicked is still honored: owner meets the admin requirement", async () => {
    const owner = await seedAdmin("ownerclicker", "ownerclicker@example.org", null);
    db.run("UPDATE users SET role = 'owner' WHERE id = ?", [owner]);
    seedRequest({ clickedBy: owner, dispatchedAt: LIVE });

    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(owner);
  });
});

describe("the clicker is honored only while their run is live", () => {
  // `approval_requested_by` is never cleared, so without this a run that lapsed
  // and was later resumed by a different admin at a terminal would be recorded
  // as the original clicker's approval.
  test("a lapsed lease: the admin who actually runs it at a terminal is recorded, not the stale clicker", async () => {
    // Dispatched 20 minutes ago, quiet since: the executor never ran, or died.
    seedRequest({ clickedBy: clickerId, dispatchedAt: "-20 minutes", updatedAt: "-20 minutes" });
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
  });

  test("a run that died partway and is resumed by another admin at a terminal records that admin", async () => {
    // The scenario the rule exists for: approving, quiet for 20 minutes, a stale
    // click on the row. The lease is read BEFORE this call's heartbeat bump; read
    // after it, the bump itself would make the run look live and hand the
    // approval to someone who never saw it finish.
    seedRequest({
      clickedBy: clickerId,
      dispatchedAt: "-2 hours",
      status: "approving",
      updatedAt: "-20 minutes",
    });
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(executorId);
    expect(publishedAudit()?.userId).toBe(executorId);
  });

  test("a live lease: the clicker is recorded", async () => {
    seedRequest({ clickedBy: clickerId, dispatchedAt: "-14 minutes" });
    expect((await approveAs(EXECUTOR_KEY)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });

  test("a later batch of a long web run still resolves to the clicker", async () => {
    // Dispatched two hours ago, but every batch of the S3 lock loop bumps
    // updated_at, so the call arrives with a fresh heartbeat. The lease is read
    // BEFORE this call's own bump; a stale click would look live after it.
    seedRequest({
      clickedBy: clickerId,
      dispatchedAt: "-2 hours",
      status: "approving",
      updatedAt: "-1 minutes",
    });
    expect((await approveAs(EXECUTOR_KEY)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });

  test("the retry of a failed step still resolves to the clicker", async () => {
    // The CLI retries ten seconds after a failure. The failure-aware in-flight
    // predicate would call this row stalled once its grace passes, but the
    // retry that finishes the run is still the clicker's, so attribution reads
    // the time-only lease.
    seedRequest({
      clickedBy: clickerId,
      dispatchedAt: "-2 hours",
      status: "approving",
      updatedAt: "-10 seconds",
      lastError: "EZID 503",
    });
    expect((await approveAs(EXECUTOR_KEY)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });

  test("a resume minutes after a failure, past the grace but inside the lease, is still the clicker's", async () => {
    // Past FAILED_RUN_GRACE_SECONDS the failure-aware in-flight predicate calls
    // this run stalled, and a web Resume would be allowed. A rerun of the
    // workflow's job, or a retry after a long rate-limit wait, then resumes it:
    // that is still the clicker's run, which is why attribution reads the
    // time-only lease and not the failure-aware one.
    seedRequest({
      clickedBy: clickerId,
      dispatchedAt: "-2 hours",
      status: "approving",
      updatedAt: "-5 minutes",
      lastError: "EZID 503",
    });
    expect((await approveAs(EXECUTOR_KEY)).status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
  });

  test("a web run that sat quiet past the lease before its first call is recorded under the executing key", async () => {
    // The cost of the rule, pinned so it stays a stated one: the clicker is lost
    // when the executor starts more than 15 minutes after the dispatch, and
    // executed_by is absent only because there is then nothing to fork.
    seedRequest({ clickedBy: clickerId, dispatchedAt: "-16 minutes", updatedAt: "-16 minutes" });
    expect((await approveAs(EXECUTOR_KEY)).status).toBe(200);
    expect(approvedBy()).toBe(executorId);
  });
});

describe("a failed owner notification", () => {
  // notify_user is non-fatal: the DOI is already minted, so an email failure is
  // audited and the publication stands. A non-production Worker refuses mail to
  // a recipient off its allow-list, and the step treats that refusal as a
  // failure, which reaches the audit row with nothing faked.
  test("is audited under the approver, not the executing key", async () => {
    seedRequest({
      clickedBy: clickerId,
      dispatchedAt: LIVE,
      stepsDone: DONE.filter((s) => s !== "notify_user"),
    });
    const res = await approveAs(EXECUTOR_KEY);
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
