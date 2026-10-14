/**
 * `POST /admin/publish/:id/deny` is lease-gated and conditional, and the final publish write is
 * guarded by the status it expects (#1603, ADR 0103 decisions 11 and 12).
 *
 * A denial used to be one unconditional UPDATE after a read, so it overwrote whatever the request
 * had become in between: a run still writing its steps, a request a run had just published, a
 * request an approval had started publishing (the DOI may already be public, and the depositor
 * would be told "denied" for a public dataset). Now the route reads the newest active request,
 * refuses by the shared words (a `request_id` that is not it, a run that started publishing, a
 * run that is in flight) and then denies with ONE conditional write whose terms are the lease
 * predicate and the `updated_at` it read, so a request that moved after the read is refused
 * rather than overwritten, and the answer names the true reason. The depositor's mail goes only
 * after that write has changed a row.
 *
 * The other half is the end of a run: `runPublicationApproval` marks the request `published` last,
 * and that write is now `AND status = 'approving'`. A request closed while the run ran (denied
 * once its lease had lapsed, or blocked again) is not published over: the run answers 409
 * `approval_closed_during_run` (a word of its own, because `request_changed` means nothing ran)
 * with its own sentence and leaves an audit row of ids and words; a request a concurrent finisher
 * already published is carried on as before. A run whose steps are ALL done ends the same way
 * (it used to answer 200 `published` and write nothing): an `approving` request is marked
 * published by the same guarded write, and any other status is refused with the same answer.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real admin router
 * behind its real auth middleware, GitHub as a `Bun.serve()` stand-in for the one read of `main`
 * the run makes, and Resend moved to a local server (helpers/resend.ts) with the real mail builder
 * and the real delivery fence, so "no mail" is read off what a real send would have posted. The
 * interleavings land a real write through `interceptingD1` exactly between the route's read and
 * its write; nothing is canned. Ages are SQLite's own `datetime('now', '-N minutes')` and sit well
 * clear of the 15 minute lease and the 60 second grace.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database and local stand-ins.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import {
  APPROVAL_CLOSED_DURING_RUN_MESSAGE,
  APPROVAL_IN_FLIGHT_MESSAGE,
  APPROVAL_REFUSAL_ERROR_CODES,
  DENY_AFTER_PUBLISHING_MESSAGE,
  REQUEST_MISMATCH_MESSAGE,
} from "../../shared/contract/publication.js";
import { OWNER_NAME_MISSING_REASON, PUBLICATION_STEPS } from "../../shared/publication-steps.js";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { mainRefAnswer, markDatasetScreensClean } from "./helpers/identifier-screen";
import { type CapturedEmail, sendsTo, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "deny-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000491";
const REQUESTER_EMAIL = "denyrequester@example.org";
const NOT_FOUND = { error: "No active publication request found" };

/** A step the run finished that changed something: it has started publishing. */
const STARTED = ["ci_check", "enrichment_check", "s3_public_read", "repo_public"];

// Everything done except the two logged no-op steps, so a resumed run reaches the final write
// with no network beyond the one GitHub read of `main` the identifier-screen gate makes.
const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

let server: Server;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;
let otherAdminId: number;
let requesterId: number;
let ownerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const ref = mainRefAnswer(req);
      if (ref) return ref;
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
  db.close();
});

/** `production` for the denial's mail (the delivery fence), `test` for a run of the approval. */
function env(d1: D1Database = realD1(db), environment = "production"): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: environment,
    GITHUB_ADMIN_PAT: "ghp_deny_test",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

function seedUser(username: string, role: string, email: string): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, 'Ada', 'Lovelace')`,
    [username, email, role],
  );
  return db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username)
    ?.id as number;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  ownerId = seedUser("denyowner", "member", "denyowner@example.org");
  requesterId = seedUser("denyrequester", "member", REQUESTER_EMAIL);
  adminId = seedUser("denyadmin", "admin", "denyadmin@example.org");
  otherAdminId = seedUser("denyother", "admin", "denyother@example.org");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
});

interface Seed {
  status?: string;
  steps?: readonly string[];
  /** SQLite modifier for `updated_at`, such as "-16 minutes". Defaults to long ago. */
  updatedAt?: string;
  /** SQLite modifier for the web claim's `approval_dispatched_at`; omitted is no claim. */
  dispatchedAt?: string;
  lastError?: string;
  blockReason?: string;
  /** The step the run set before it ran one: it stays set when the step fails or is cut off. */
  currentStep?: string;
}

/** A request made by `requesterId`; returns its id. */
function seedRequest(seed: Seed = {}): number {
  const claimed = seed.dispatchedAt !== undefined;
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, steps_completed,
        approval_requested_by, approval_dispatched_at, last_error, block_reason, current_step)
     VALUES (?, ?, ?, datetime('now', '-3 hours'), datetime('now', ?), ?,
             ?, ${claimed ? `datetime('now', '${seed.dispatchedAt}')` : "NULL"}, ?, ?, ?)`,
    [
      DATASET,
      seed.status ?? "requested",
      requesterId,
      seed.updatedAt ?? "-3 hours",
      JSON.stringify(seed.steps ?? []),
      claimed ? adminId : null,
      seed.lastError ?? null,
      seed.blockReason ?? null,
      seed.currentStep ?? null,
    ],
  );
  return db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
}

function row(id: number): Record<string, unknown> {
  return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

function deny(
  body: Record<string, unknown> = { reason: "Not ready for publication." },
  bindings: Bindings = env(),
): Promise<Response> {
  return app.request(
    `/admin/publish/${DATASET}/deny`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

/** What the depositor was mailed: every send to the requester, as the fence let it through. */
const mailedTo = (calls: CapturedEmail[]) => sendsTo(calls, REQUESTER_EMAIL);

/** An environment whose database lands `effect` once, just before the denial's own write. */
function raceBeforeDenyWrite(effect: () => void): Bindings {
  let fired = false;
  return env(
    interceptingD1(realD1(db), (sql) => {
      if (!fired && sql.includes("SET status = 'denied'")) {
        fired = true;
        effect();
      }
    }),
  );
}

/**
 * A refusal's body, read after checking that its word is one the contract declares
 * (`APPROVAL_REFUSAL_ERROR_CODES`), so a word renamed here and in the route but not there fails.
 */
async function refusalBody(res: Response): Promise<{ error: string }> {
  const body = (await res.json()) as { error: string };
  expect(APPROVAL_REFUSAL_ERROR_CODES).toContain(body.error);
  return body;
}

/** A denial that must be refused: its status, its body, an untouched row and no mail. */
async function expectRefused(
  id: number,
  respond: (calls: CapturedEmail[]) => Promise<Response>,
  expected: { status: number; body: Record<string, unknown> },
): Promise<void> {
  const before = row(id);
  await withFakeResend(async (calls) => {
    const res = await respond(calls);
    expect(res.status).toBe(expected.status);
    expect(await refusalBody(res)).toEqual(expected.body);
    expect(calls).toHaveLength(0);
  });
  expect(row(id)).toEqual(before);
}

const IN_FLIGHT = { error: "approval_in_flight", message: APPROVAL_IN_FLIGHT_MESSAGE };
const AFTER_PUBLISHING = { error: "deny_after_publishing", message: DENY_AFTER_PUBLISHING_MESSAGE };

describe("a request an approval is running for is not denied", () => {
  test("a fresh terminal approval (approving, heartbeat a few seconds old)", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-5 seconds", steps: ["ci_check"] });
    await expectRefused(id, () => deny(), { status: 409, body: IN_FLIGHT });
  });

  test("a dispatched claim inside the lease, before the executor's first call", async () => {
    const id = seedRequest({ status: "requested", dispatchedAt: "-5 minutes" });
    await expectRefused(id, () => deny(), { status: 409, body: IN_FLIGHT });
  });

  test("a failed run inside the 60 second grace, which the CLI's retry is about to resume", async () => {
    const id = seedRequest({
      status: "approving",
      updatedAt: "-20 seconds",
      lastError: "ci_check failed",
      steps: ["ci_check"],
    });
    await expectRefused(id, () => deny(), { status: 409, body: IN_FLIGHT });
  });
});

describe("a request nothing is running for is denied, and the depositor is told once", () => {
  async function denied(id: number): Promise<void> {
    await withFakeResend(async (calls) => {
      const res = await deny({ reason: "The README does not describe the setup." });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "Publication request denied",
        dataset_id: DATASET,
        reason: "The README does not describe the setup.",
      });
      const sent = mailedTo(calls);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toBe(`Publication request denied: ${DATASET}`);
      expect(sent[0]?.html).toContain("The README does not describe the setup.");
      expect(calls).toHaveLength(1);
    });
    const after = row(id);
    expect(after.status).toBe("denied");
    expect(after.denied_by).toBe(adminId);
    expect(after.denied_reason).toBe("The README does not describe the setup.");
    expect(after.denied_at).not.toBeNull();
  }

  test("a stalled approving request that has not started publishing (the lease lapsed)", async () => {
    const id = seedRequest({
      status: "approving",
      updatedAt: "-16 minutes",
      dispatchedAt: "-2 hours",
      steps: ["ci_check"],
    });
    await denied(id);
    // Nothing is running for it, so the lapsed claim goes with the denial: a denied request keeps
    // no claim that could be read as a run (the dispatch audit row still names the clicker).
    expect(row(id).approval_requested_by).toBeNull();
    expect(row(id).approval_dispatched_at).toBeNull();
  });

  test("a failed run past the 60 second grace", async () => {
    const id = seedRequest({
      status: "approving",
      updatedAt: "-5 minutes",
      lastError: "ci_check failed",
      steps: ["ci_check"],
    });
    await denied(id);
  });

  test("a requested request", async () => {
    await denied(seedRequest({ status: "requested" }));
  });

  test("a requested request whose dispatch lapsed unanswered", async () => {
    await denied(seedRequest({ status: "requested", dispatchedAt: "-16 minutes" }));
  });

  test("a requested request that has done only the validation-only steps", async () => {
    // `ci_check` and `enrichment_check` change nothing: the request is still deniable.
    await denied(seedRequest({ status: "requested", steps: ["ci_check", "enrichment_check"] }));
  });

  test("a blocked request that has done only the validation-only steps", async () => {
    await denied(
      seedRequest({
        status: "blocked",
        blockReason: "min_requirements_failed",
        steps: ["ci_check", "enrichment_check"],
      }),
    );
  });
});

describe("a request that has started publishing is never denied, whatever its status", () => {
  test("a stalled approving request with a step done outside the validation-only ones", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-16 minutes", steps: STARTED });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  test("that refusal comes before the in-flight one: a live run that started publishing", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-5 seconds", steps: STARTED });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  test("the owner-name walk-back: blocked with the steps of a half-published run", async () => {
    const id = seedRequest({
      status: "blocked",
      blockReason: OWNER_NAME_MISSING_REASON,
      steps: STARTED,
    });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  // The steps of a request are that request's own irreversible acts. The owner's re-request
  // (`routes/datasets/publication.ts`) moves the row back to `requested`, or on to a block of the
  // screen's or the minimum's, and KEEPS `steps_completed` (follow-up #1766 tracks that). The
  // gate must not trust those steps (it would skip the gates for content that never passed them),
  // but the denial asks another question: has anything irreversible happened? The S3 objects made
  // public-read and the repository made public by the first life are still public, so the
  // depositor must not be told "denied". Hence this refusal ignores the status and the reason.
  test("a requested request whose steps are those of an owner-name run, filed again", async () => {
    const id = seedRequest({ status: "requested", steps: STARTED });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  test("a blocked request (minimum failed) that carries the steps of an earlier life", async () => {
    const id = seedRequest({
      status: "blocked",
      blockReason: "min_requirements_failed",
      steps: STARTED,
    });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  test("a blocked request with no reason at all that carries those steps", async () => {
    const id = seedRequest({ status: "blocked", steps: STARTED });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  test("a requested request with a claim in flight and those steps: started publishing comes first", async () => {
    const id = seedRequest({ status: "requested", dispatchedAt: "-5 minutes", steps: STARTED });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });
});

describe("a first mutation that did not finish is not a denial either", () => {
  // `s3_public_read` is the first step that changes anything, and it is the one whose write may
  // have landed without being acknowledged: a run cut off inside it, or one that failed it, has
  // only validation steps recorded and a `current_step` naming it, while the bucket policy may
  // already make the data public. `steps_completed` alone cannot say so, so the refusal reads the
  // step the run set as well (ADR 0103 decision 11).
  test("a stalled run cut off inside s3_public_read: only validation steps are recorded", async () => {
    const id = seedRequest({
      status: "approving",
      updatedAt: "-16 minutes",
      steps: ["ci_check", "enrichment_check"],
      currentStep: "s3_public_read",
    });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  test("a run that failed s3_public_read, past the 60 second grace", async () => {
    const id = seedRequest({
      status: "approving",
      updatedAt: "-5 minutes",
      lastError: "s3_public_read failed",
      steps: ["ci_check", "enrichment_check"],
      currentStep: "s3_public_read",
    });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  test("a step that comes after it is just as much a mutation", async () => {
    const id = seedRequest({
      status: "approving",
      updatedAt: "-16 minutes",
      steps: ["ci_check", "enrichment_check"],
      currentStep: "repo_public",
    });
    await expectRefused(id, () => deny(), { status: 409, body: AFTER_PUBLISHING });
  });

  test("a run cut off inside a validation step is still deniable", async () => {
    for (const step of ["ci_check", "enrichment_check"]) {
      db.run("DELETE FROM publication_requests");
      const id = seedRequest({
        status: "approving",
        updatedAt: "-16 minutes",
        steps: [],
        currentStep: step,
      });
      await withFakeResend(async (calls) => {
        const res = await deny();
        expect(res.status).toBe(200);
        expect(mailedTo(calls)).toHaveLength(1);
      });
      expect(row(id).status).toBe("denied");
    }
  });

  test("a run starts s3_public_read in between: the re-read refuses by the same rule", async () => {
    const id = seedRequest({
      status: "approving",
      updatedAt: "-16 minutes",
      steps: ["ci_check", "enrichment_check"],
      currentStep: "enrichment_check",
    });
    const bindings = raceBeforeDenyWrite(() =>
      db.run(
        `UPDATE publication_requests SET current_step = 's3_public_read', updated_at = datetime('now')
          WHERE id = ?`,
        [id],
      ),
    );
    await withFakeResend(async (calls) => {
      const res = await deny(undefined, bindings);
      expect(res.status).toBe(409);
      expect(await refusalBody(res)).toEqual(AFTER_PUBLISHING);
      expect(calls).toHaveLength(0);
    });
    expect(row(id).status).toBe("approving");
    expect(row(id).denied_at).toBeNull();
  });
});

describe("a request that moves between the read and the write is not overwritten", () => {
  test("published in between: the answer is that no request is active, and it stays published", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-16 minutes", steps: ["ci_check"] });
    const bindings = raceBeforeDenyWrite(() =>
      db.run("UPDATE publication_requests SET status = 'published' WHERE id = ?", [id]),
    );
    await withFakeResend(async (calls) => {
      const res = await deny(undefined, bindings);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
      expect(calls).toHaveLength(0);
    });
    const after = row(id);
    expect(after.status).toBe("published");
    expect(after.denied_at).toBeNull();
    expect(after.denied_by).toBeNull();
    expect(after.denied_reason).toBeNull();
  });

  test("denied by another administrator in between: their denial stands, no second mail", async () => {
    const id = seedRequest({ status: "requested" });
    const bindings = raceBeforeDenyWrite(() =>
      db.run(
        `UPDATE publication_requests
            SET status = 'denied', denied_by = ?, denied_reason = 'first', denied_at = datetime('now')
          WHERE id = ?`,
        [otherAdminId, id],
      ),
    );
    await withFakeResend(async (calls) => {
      const res = await deny(undefined, bindings);
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });
    expect(row(id).denied_by).toBe(otherAdminId);
    expect(row(id).denied_reason).toBe("first");
  });

  test("a run marks the request approving in between: it is in flight, and not denied", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-16 minutes", steps: ["ci_check"] });
    const bindings = raceBeforeDenyWrite(() =>
      db.run("UPDATE publication_requests SET updated_at = datetime('now') WHERE id = ?", [id]),
    );
    await withFakeResend(async (calls) => {
      const res = await deny(undefined, bindings);
      expect(res.status).toBe(409);
      expect(await refusalBody(res)).toEqual(IN_FLIGHT);
      expect(calls).toHaveLength(0);
    });
    expect(row(id).status).toBe("approving");
    expect(row(id).denied_at).toBeNull();
  });

  test("a run starts publishing in between: the refusal that names it", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-16 minutes", steps: ["ci_check"] });
    const bindings = raceBeforeDenyWrite(() =>
      db.run(
        `UPDATE publication_requests SET steps_completed = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify(STARTED), id],
      ),
    );
    await withFakeResend(async (calls) => {
      const res = await deny(undefined, bindings);
      expect(res.status).toBe(409);
      expect(await refusalBody(res)).toEqual(AFTER_PUBLISHING);
      expect(calls).toHaveLength(0);
    });
    expect(row(id).status).toBe("approving");
  });

  test("a requested request gains started steps in between: the re-read refuses by the same rule", async () => {
    const id = seedRequest({ status: "requested" });
    const bindings = raceBeforeDenyWrite(() =>
      db.run(
        `UPDATE publication_requests SET steps_completed = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify(STARTED), id],
      ),
    );
    await withFakeResend(async (calls) => {
      const res = await deny(undefined, bindings);
      expect(res.status).toBe(409);
      expect(await refusalBody(res)).toEqual(AFTER_PUBLISHING);
      expect(calls).toHaveLength(0);
    });
    expect(row(id).status).toBe("requested");
    expect(row(id).denied_at).toBeNull();
  });

  test("a web click claims it in between (the claim leaves updated_at alone): in flight, claim intact", async () => {
    // The dispatch route's claim does not touch `updated_at`, so the heartbeat term cannot see it:
    // only the lease predicate inside the denial's own WHERE can.
    const id = seedRequest({ status: "requested" });
    const bindings = raceBeforeDenyWrite(() =>
      db.run(
        `UPDATE publication_requests
            SET approval_requested_by = ?, approval_dispatched_at = datetime('now'), last_error = NULL
          WHERE id = ?`,
        [otherAdminId, id],
      ),
    );
    await withFakeResend(async (calls) => {
      const res = await deny(undefined, bindings);
      expect(res.status).toBe(409);
      expect(await refusalBody(res)).toEqual(IN_FLIGHT);
      expect(calls).toHaveLength(0);
    });
    const after = row(id);
    expect(after.status).toBe("requested");
    expect(after.approval_requested_by).toBe(otherAdminId);
    expect(after.approval_dispatched_at).not.toBeNull();
    expect(after.denied_at).toBeNull();
  });

  test("the row moves in a way that leaves nothing running: refused, never denied on what was read", async () => {
    // The heartbeat the denial read is part of its WHERE, so a request that was touched since
    // (a callback landing while the administrator decided) is read again rather than overwritten.
    const id = seedRequest({ status: "requested", updatedAt: "-3 hours" });
    const bindings = raceBeforeDenyWrite(() =>
      db.run(
        "UPDATE publication_requests SET updated_at = datetime('now', '-2 hours') WHERE id = ?",
        [id],
      ),
    );
    await withFakeResend(async (calls) => {
      const res = await deny(undefined, bindings);
      expect(res.status).toBe(409);
      expect(calls).toHaveLength(0);
    });
    expect(row(id).status).toBe("requested");
    expect(row(id).denied_at).toBeNull();
  });
});

describe("which request a denial is for", () => {
  test("a denied request cannot be denied again, and the depositor is not mailed twice", async () => {
    seedRequest({ status: "requested" });
    await withFakeResend(async (calls) => {
      expect((await deny()).status).toBe(200);
      const again = await deny();
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual(NOT_FOUND);
      expect(mailedTo(calls)).toHaveLength(1);
    });
  });

  test("a request_id that is not the newest active request is refused: the request was filed again", async () => {
    const old = seedRequest({ status: "denied" });
    const current = seedRequest({ status: "requested" });
    expect(current).not.toBe(old);
    await expectRefused(current, () => deny({ reason: "No.", request_id: old }), {
      status: 409,
      body: { error: "request_mismatch", message: REQUEST_MISMATCH_MESSAGE },
    });
  });

  test("the request_id of the newest active request denies it", async () => {
    seedRequest({ status: "denied" });
    const current = seedRequest({ status: "requested" });
    await withFakeResend(async (calls) => {
      const res = await deny({ reason: "No.", request_id: current });
      expect(res.status).toBe(200);
      expect(mailedTo(calls)).toHaveLength(1);
    });
    expect(row(current).status).toBe("denied");
  });

  test("no active request is 404 whatever request_id says, before any mismatch", async () => {
    const old = seedRequest({ status: "denied" });
    const res = await deny({ reason: "No.", request_id: old + 5 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  test("the in-flight refusal still comes after the mismatch: a stale id never learns about a run", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-5 seconds", steps: ["ci_check"] });
    await expectRefused(id, () => deny({ reason: "No.", request_id: id + 1 }), {
      status: 409,
      body: { error: "request_mismatch", message: REQUEST_MISMATCH_MESSAGE },
    });
  });

  test("a request_id that is not a positive integer is a 400 and changes nothing", async () => {
    const id = seedRequest({ status: "requested" });
    for (const bad of [0, -1, 1.5, "7", null]) {
      const res = await deny({ reason: "No.", request_id: bad });
      expect(res.status).toBe(400);
    }
    expect(row(id).status).toBe("requested");
  });
});

describe("the final publish write is guarded by the status it expects", () => {
  function seedRun(): number {
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
       VALUES (?, 'Deny Dataset', ?, ?, 'private')`,
      [DATASET, ownerId, `nemarDatasets/${DATASET}`],
    );
    const id = seedRequest({
      status: "approving",
      updatedAt: "-16 minutes",
      steps: DONE,
    });
    markDatasetScreensClean(db, DATASET);
    return id;
  }

  /** An environment whose database lands `effect` once, just before the run's final write. */
  function raceBeforeFinalWrite(effect: () => void | Promise<void>): Bindings {
    let fired = false;
    return env(
      interceptingD1(realD1(db), async (sql) => {
        if (!fired && /UPDATE publication_requests\s+SET status = 'published'/.test(sql)) {
          fired = true;
          await effect();
        }
      }),
      "test",
    );
  }

  function approve(bindings: Bindings): Promise<Response> {
    return app.request(
      `/admin/publish/${DATASET}/approve`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      },
      bindings,
    );
  }

  const auditRows = (action: string) =>
    db
      .query<{ user_id: number | null; resource_id: string | null; details: string }, [string]>(
        "SELECT user_id, resource_id, details FROM audit_log WHERE action = ?",
      )
      .all(action);

  test.each([
    {
      label: "denied once its lease had lapsed",
      effect: (id: number) =>
        db.run(
          `UPDATE publication_requests
              SET status = 'denied', denied_by = ?, denied_reason = 'late', denied_at = datetime('now')
            WHERE id = ?`,
          [otherAdminId, id],
        ),
      closedAs: "denied",
    },
    {
      label: "blocked again by a result that arrived mid-run",
      effect: (id: number) =>
        db.run(
          `UPDATE publication_requests
              SET status = 'blocked', block_reason = 'min_requirements_failed'
            WHERE id = ?`,
          [id],
        ),
      closedAs: "blocked",
    },
  ])(
    "a request $label is not published over: 409, an audit row, status kept",
    async ({ effect, closedAs }) => {
      const id = seedRun();
      const res = await approve(raceBeforeFinalWrite(() => effect(id)));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "approval_closed_during_run",
        message: APPROVAL_CLOSED_DURING_RUN_MESSAGE,
      });
      const after = row(id);
      expect(after.status).toBe(closedAs);
      expect(after.approved_at).toBeNull();

      // Ids and words only: the request, and the status it was found in.
      const audit = auditRows("approval_finished_on_closed_request");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.resource_id).toBe(DATASET);
      expect(audit[0]?.user_id).toBe(adminId);
      expect(JSON.parse(audit[0]?.details ?? "null")).toEqual({
        request_id: id,
        request_status: closedAs,
      });
      // The run did not report a publication it did not record.
      expect(auditRows("dataset_published")).toHaveLength(0);
    },
  );

  test("a concurrent finisher that already published it is carried on: 200, as today", async () => {
    const id = seedRun();
    const res = await approve(
      raceBeforeFinalWrite(() =>
        db.run(
          `UPDATE publication_requests
              SET status = 'published', approved_at = datetime('now'), approved_by = ?
            WHERE id = ?`,
          [otherAdminId, id],
        ),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; dataset_id: string };
    expect(body.status).toBe("published");
    expect(body.dataset_id).toBe(DATASET);
    expect(row(id).status).toBe("published");
    expect(auditRows("approval_finished_on_closed_request")).toHaveLength(0);
    // One row per publication (ADR 0103 decision 12): the call that changes the request records
    // it. This finisher is a bare statement that records nothing, and the run that found the
    // request already published does not write a row of its own on top of it.
    expect(auditRows("dataset_published")).toHaveLength(0);
  });

  test("a terminal resume that closes the request first leaves exactly one dataset_published row", async () => {
    const id = seedRun();
    // The resume finds every step done (the run has recorded the last of them), closes the
    // request and records the publication, all before the run's own closing write.
    const res = await approve(
      raceBeforeFinalWrite(async () => {
        const resumed = await approve(env(realD1(db), "test"));
        expect(resumed.status).toBe(200);
        expect(row(id).status).toBe("published");
      }),
    );

    expect(res.status).toBe(200);
    expect(row(id).status).toBe("published");
    const rows = auditRows("dataset_published");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.details ?? "null")).toMatchObject({ finished_by_resume: true });
  });

  test("a run nothing interrupts still publishes, with the guard in place", async () => {
    const id = seedRun();
    const res = await approve(env(realD1(db), "test"));
    expect(res.status).toBe(200);
    expect(row(id).status).toBe("published");
    expect(row(id).approved_at).not.toBeNull();
    expect(auditRows("approval_finished_on_closed_request")).toHaveLength(0);
  });

  // A run whose steps are ALL done never reaches the step loop or the final write above: it
  // answered 200 `published` and wrote nothing, so a `denied` row was invisible to it, an owner-name
  // `blocked` row resumed into it and was told "published" while it stayed blocked, and an
  // `approving` row whose last call died before its final write stayed `approving` for good.
  describe("a resumed run whose steps are all done", () => {
    function seedAllDone(seed: Seed): number {
      db.run(
        `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
         VALUES (?, 'Deny Dataset', ?, ?, 'private')`,
        [DATASET, ownerId, `nemarDatasets/${DATASET}`],
      );
      const id = seedRequest({ updatedAt: "-16 minutes", ...seed, steps: PUBLICATION_STEPS });
      markDatasetScreensClean(db, DATASET);
      return id;
    }

    const CLOSED = {
      error: "approval_closed_during_run",
      message: APPROVAL_CLOSED_DURING_RUN_MESSAGE,
    };

    /** The refusal, an untouched row and the one audit row that says which status it found. */
    async function expectClosed(id: number, foundAs: string, res: Response): Promise<void> {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(CLOSED);
      expect(row(id).status).toBe(foundAs);
      expect(row(id).approved_at).toBeNull();
      const audit = auditRows("approval_finished_on_closed_request");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.resource_id).toBe(DATASET);
      expect(audit[0]?.user_id).toBe(adminId);
      expect(JSON.parse(audit[0]?.details ?? "null")).toEqual({
        request_id: id,
        request_status: foundAs,
      });
      // A closed request is never reported as a publication.
      expect(auditRows("dataset_published")).toHaveLength(0);
    }

    test("an approving request is marked published by the guarded write, and the answer is as before", async () => {
      const id = seedAllDone({ status: "approving" });
      const res = await approve(env(realD1(db), "test"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "All steps already completed",
        dataset_id: DATASET,
        status: "published",
      });
      const after = row(id);
      expect(after.status).toBe("published");
      expect(after.approved_at).not.toBeNull();
      expect(after.current_step).toBeNull();
      expect(after.last_error).toBeNull();
      expect(auditRows("approval_finished_on_closed_request")).toHaveLength(0);
    });

    test("an owner-name blocked request resumed with every step done is refused, not called published", async () => {
      const id = seedAllDone({ status: "blocked", blockReason: OWNER_NAME_MISSING_REASON });
      const res = await approve(env(realD1(db), "test"));
      await expectClosed(id, "blocked", res);
      expect(row(id).block_reason).toBe(OWNER_NAME_MISSING_REASON);
    });

    test("a requested request that carries every step is refused too", async () => {
      const id = seedAllDone({ status: "requested" });
      await expectClosed(id, "requested", await approve(env(realD1(db), "test")));
    });

    test("a request denied between the read and the write is not published over", async () => {
      const id = seedAllDone({ status: "approving" });
      const res = await approve(
        raceBeforeFinalWrite(() =>
          db.run(
            `UPDATE publication_requests
                SET status = 'denied', denied_by = ?, denied_reason = 'late', denied_at = datetime('now')
              WHERE id = ?`,
            [otherAdminId, id],
          ),
        ),
      );
      await expectClosed(id, "denied", res);
      expect(row(id).denied_by).toBe(otherAdminId);
    });

    test("a concurrent finisher that already published it is carried on: 200, no closed audit row", async () => {
      const id = seedAllDone({ status: "approving" });
      const res = await approve(
        raceBeforeFinalWrite(() =>
          db.run(
            `UPDATE publication_requests
                SET status = 'published', approved_at = datetime('now'), approved_by = ?
              WHERE id = ?`,
            [otherAdminId, id],
          ),
        ),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("published");
      expect(row(id).status).toBe("published");
      expect(auditRows("approval_finished_on_closed_request")).toHaveLength(0);
    });
  });
});
