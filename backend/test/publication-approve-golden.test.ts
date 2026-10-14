/**
 * Golden characterization tests for POST /admin/publish/:id/approve (#904).
 *
 * Written against the CURRENT inline handler BEFORE the orchestrator
 * extraction and kept green through every extraction commit: they pin the
 * pre-loop (426 gate, request lookup, all-completed short-circuit (which ends like the loop,
 * ADR 0103 decision 12: published for an `approving` request, refused for any other),
 * the 'approving' transition), resume filtering, the two no-op steps' recording
 * quirks, the finalize block (visibility self-heal, 'published' write, audit
 * row), and the exact response contract.
 *
 * Real engine only: bun:sqlite behind the realD1 shim, the real auth
 * middleware (seeded users/tokens rows, real SHA-256 key hashing), and the
 * real route via Hono app.request(). The golden path resumes with only
 * `upload_to_zenodo` + `sync_nemar` remaining — both logged no-ops — so no
 * external service is touched (getDatasetsToken resolves from
 * GITHUB_ADMIN_PAT without network).
 *
 * The identifier screen gate (epic #1610 phase 4) runs before any of this, so
 * each seeded request carries a clean screen of the commit a `Bun.serve()`
 * stand-in reports as `main`: the one GitHub read the gate makes. The gate
 * itself is pinned in identifier-screen-gate.test.ts.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { APPROVAL_CLOSED_DURING_RUN_MESSAGE } from "../../shared/contract/publication.js";
import { PUBLICATION_STEPS } from "../../shared/publication-steps.js";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { mainRefAnswer, markDatasetScreensClean } from "./helpers/identifier-screen";

const ADMIN_KEY = "golden-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm098765";

// The canonical order; test/publish-progress.test.ts pins the literal content.
const ALL_STEPS = PUBLICATION_STEPS;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;
let github: Server;

beforeAll(() => {
  github = Bun.serve({
    port: 0,
    fetch: (req) => mainRefAnswer(req) ?? new Response("not found", { status: 404 }),
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${github.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  github.stop(true);
});

async function seed(
  stepsCompleted: readonly string[],
  opts: { datasetId?: string; githubRepo?: string | null; isExemplar?: boolean } = {},
): Promise<void> {
  const datasetId = opts.datasetId ?? DATASET;
  const githubRepo = opts.githubRepo === undefined ? `nemarDatasets/${datasetId}` : opts.githubRepo;
  // given_name/family_name are load-bearing since #1255: approval mints a DOI
  // that cites the owner by real name, and an owner without one is refused
  // before the step loop. This fixture is about the step machinery, so it
  // gives the owner a name and leaves the name gate to
  // backend/test/uploader-real-name-doi.test.ts.
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('goldadmin', 'goldadmin@example.org', 'x', 'approved', 'admin', 1,
             'Gold', 'Admin')`,
  );
  const userId = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='goldadmin'")
    .get();
  if (!userId) throw new Error("seed: user insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    userId.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility, is_exemplar)
     VALUES (?, 'Golden Dataset', ?, ?, 'private', ?)`,
  ).run(datasetId, userId.id, githubRepo, opts.isExemplar ? 1 : 0);
  db.query(
    `INSERT INTO publication_requests (dataset_id, status, requested_by, requested_at, steps_completed)
     VALUES (?, 'requested', ?, datetime('now'), ?)`,
  ).run(datasetId, userId.id, JSON.stringify(stepsCompleted));
  markDatasetScreensClean(db, datasetId);
}

function approve(body: Record<string, unknown>, id = DATASET): Promise<Response> {
  return app.request(
    `/admin/publish/${id}/approve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

function requestRow() {
  return db
    .query<
      {
        status: string;
        approved_by: number | null;
        approved_at: string | null;
        current_step: string | null;
        last_error: string | null;
        steps_completed: string;
      },
      [string]
    >(
      "SELECT status, approved_by, approved_at, current_step, last_error, steps_completed FROM publication_requests WHERE dataset_id = ?",
    )
    .get(DATASET);
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  env = {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "test-pat-never-used-on-this-path",
  } as Bindings;
});

describe("POST /admin/publish/:id/approve (golden characterization)", () => {
  test("golden resume path: only the two no-op steps remain", async () => {
    const done = ALL_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");
    await seed(done);

    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.message).toBe("Dataset published successfully");
    expect(body.dataset_id).toBe(DATASET);
    expect(body.status).toBe("published");
    // Quirk pin: the terminal success body reports the STATIC full step
    // list, not the runtime-completed array.
    expect(body.steps_completed).toEqual([...ALL_STEPS]);
    // Only the steps that actually ran this invocation get step_results.
    const results = body.step_results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.step)).toEqual(["upload_to_zenodo", "sync_nemar"]);
    for (const r of results) {
      expect(r.status).toBe("completed");
      expect(r.attempts).toBe(1);
      // Stale-duration quirk: no startStep precedes these no-ops, so
      // duration_ms is elapsed-since-run-start — a number, not undefined.
      expect(typeof r.duration_ms).toBe("number");
      expect(r.error).toBeUndefined();
    }
    // No s3_lock ran this invocation.
    expect(body.s3_lock_total).toBeUndefined();
    expect(body.s3_lock_batch_count).toBeUndefined();
    expect(body.warning).toBeUndefined();

    // D1 finalize effects.
    const row = requestRow();
    expect(row?.status).toBe("published");
    expect(row?.current_step).toBeNull();
    expect(row?.last_error).toBeNull();
    expect(row?.approved_by).not.toBeNull();
    expect(row?.approved_at).not.toBeNull();
    // Quirk pin: D1 steps_completed preserves completion order — the seeded
    // 14 steps first, then the two resumed no-ops appended at the END (it is
    // NOT re-sorted into canonical step order).
    expect(JSON.parse(row?.steps_completed ?? "[]")).toEqual([
      ...done,
      "upload_to_zenodo",
      "sync_nemar",
    ]);

    // Visibility self-heal: repo_public was skipped via resume, so the
    // finalize consistency check flips 'private' -> 'public'.
    const ds = db
      .query<{ visibility: string }, [string]>(
        "SELECT visibility FROM datasets WHERE dataset_id = ?",
      )
      .get(DATASET);
    expect(ds?.visibility).toBe("public");

    // Audit row.
    const audit = db
      .query<{ action: string; resource_id: string; user_id: number }, []>(
        "SELECT action, resource_id, user_id FROM audit_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(audit?.action).toBe("dataset_published");
    expect(audit?.resource_id).toBe(DATASET);
  });

  test("all-completed short-circuit on a requested request: refused, the request is not touched", async () => {
    await seed(ALL_STEPS);

    const res = await approve({ resume: true });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("approval_closed_during_run");
    expect(body.message).toBe(APPROVAL_CLOSED_DURING_RUN_MESSAGE);

    // The short-circuit still fires BEFORE the 'approving' transition, and it writes nothing to
    // the request: the row stays exactly as seeded, and is no longer reported as published (it
    // used to answer 200 `published` for a request it left `requested`). The refusal leaves one
    // audit row that names the status it found.
    const row = requestRow();
    expect(row?.status).toBe("requested");
    expect(row?.approved_by).toBeNull();
    expect(row?.approved_at).toBeNull();
    const audit = db
      .query<{ action: string; details: string }, []>(
        "SELECT action, details FROM audit_log WHERE action = 'approval_finished_on_closed_request'",
      )
      .all();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details ?? "null")).toMatchObject({ request_status: "requested" });
  });

  test("all-completed short-circuit on an approving request: marked published, as the loop's end would", async () => {
    await seed(ALL_STEPS);
    db.run("UPDATE publication_requests SET status = 'approving' WHERE dataset_id = ?", [DATASET]);

    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      message: "All steps already completed",
      dataset_id: DATASET,
      status: "published",
    });

    // The answer is as it always was; the row now says so too.
    const row = requestRow();
    expect(row?.status).toBe("published");
    expect(row?.approved_at).not.toBeNull();
    expect(row?.current_step).toBeNull();
    expect(row?.last_error).toBeNull();
  });

  test("404 when no active publication request exists", async () => {
    await seed(ALL_STEPS); // seeded for a different dataset id than queried
    const res = await approve({ resume: true }, "nm000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No active publication request found");
  });

  test("426 for pre-0.8.5 CLI sending s3_lock_offset without a continuation token", async () => {
    await seed([]);
    const res = await approve({ resume: true, s3_lock_offset: 100 });
    expect(res.status).toBe(426);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain("Outdated nemar-cli");
  });

  test("warn-only enrichment_check runs for real (D1-only step) and completes", async () => {
    // Everything done except enrichment_check + the two no-ops: exercises a
    // REAL step body (the enrichment D1 read; dataset has no enrichment_json,
    // which warns to logs but never fails the step) plus the finalize block.
    const done = ALL_STEPS.filter(
      (s) => !["enrichment_check", "upload_to_zenodo", "sync_nemar"].includes(s),
    );
    await seed(done);

    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("published");
    const results = body.step_results as Array<Record<string, unknown>>;
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ["enrichment_check", "completed"],
      ["upload_to_zenodo", "completed"],
      ["sync_nemar", "completed"],
    ]);
    expect(requestRow()?.status).toBe("published");
  });

  test("pre-loop abort: dataset without a GitHub repo gets 400 before any step", async () => {
    await seed([], { githubRepo: null });
    const res = await approve({ resume: false });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Dataset has no GitHub repository");
    // The 'approving' transition already happened (it precedes the dataset
    // guards); no step ran and no finalize fired.
    const row = requestRow();
    expect(row?.status).toBe("approving");
    expect(JSON.parse(row?.steps_completed ?? "[]")).toEqual([]);
  });

  test("pre-loop abort: xx-prefix sandbox datasets are blocked with 400", async () => {
    await seed([], { datasetId: "xx098765" });
    const res = await approve({ resume: false }, "xx098765");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Cannot publish sandbox datasets");
  });

  test("pre-loop: an exemplar xx dataset bypasses the sandbox block (epic #923)", async () => {
    // is_exemplar=1 under a non-production env (ENVIRONMENT='test') makes
    // isExemplarPublishAllowed() true, so the xx block is skipped and the NEXT
    // guard fires. Seeding no github_repo lets that next guard (400 "no GitHub
    // repository") stand in for "got past the sandbox block" without running the
    // full step loop or touching any external service.
    await seed([], { datasetId: "xx099900", githubRepo: null, isExemplar: true });
    const res = await approve({ resume: false }, "xx099900");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Dataset has no GitHub repository");
    expect(body.error).not.toBe("Cannot publish sandbox datasets");
  });

  test("mid-loop abort: doi_create's non-production gate short-circuits the step loop", async () => {
    // Exercises the runner's `if (out) return out` propagation through a REAL
    // step body: doi_create aborts on D1 state alone (no concept_doi, not
    // sandbox, ENVIRONMENT != production) before any external call.
    const done = ALL_STEPS.filter(
      (s) => !["doi_create", "upload_to_zenodo", "sync_nemar"].includes(s),
    );
    await seed(done);

    const res = await approve({ resume: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Production DOI creation blocked in non-production environment");
    expect(body.step).toBe("doi_create");
    expect(body.steps_completed).toEqual([...done]);

    // The abort left the request mid-flight: 'approving', current_step parked
    // on the failed step, failed step NOT appended to steps_completed.
    const row = requestRow();
    expect(row?.status).toBe("approving");
    expect(row?.current_step).toBe("doi_create");
    expect(row?.last_error).toBe("Production DOI blocked in non-production");
    expect(JSON.parse(row?.steps_completed ?? "[]")).toEqual([...done]);
  });

  test("skip_ci_check completes ci_check without any CI probe", async () => {
    const done = ALL_STEPS.filter(
      (s) => !["ci_check", "upload_to_zenodo", "sync_nemar"].includes(s),
    );
    await seed(done);

    const res = await approve({ resume: true, skip_ci_check: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("published");
    const results = body.step_results as Array<Record<string, unknown>>;
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ["ci_check", "completed"],
      ["upload_to_zenodo", "completed"],
      ["sync_nemar", "completed"],
    ]);
  });
});
