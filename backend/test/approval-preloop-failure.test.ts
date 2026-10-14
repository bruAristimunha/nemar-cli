/**
 * The four answers of `/approve` that return before its step loop say why on the row (#1582, ADR
 * 0103 decision 9).
 *
 * `runPublicationApproval` marks the request `approving` and refreshes `updated_at`, then four
 * checks can still refuse it before any step records anything: the dataset is missing, it is a
 * sandbox dataset, it has no repository, or its repository is not `owner/name`. Each answered
 * with a body and left the row with no `last_error`, and `approvalInFlightSql` reads a row with
 * no `last_error` as a run that has not failed, so a run that stopped there looked in flight for
 * the rest of the fifteen-minute lease and a second click was refused with nothing running. Each
 * now writes the sentence its answer carries; the answers themselves (status and body) are
 * unchanged, and a failure to write never changes them. A fifth exit, a failure to mint the GitHub
 * token for the dataset repositories, throws after the same mark: it writes a fixed sentence and
 * rethrows, so the status and the claim are as they were.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real routes and
 * the real auth middleware through Hono's `app.request()`. The run is seeded mid-flight (a step
 * past the validation ones is done) so the gates, which a resumed run that has started publishing
 * skips, do not stand between the call and the answer under test.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { PRE_LOOP_FAILURE_SQL } from "../src/services/publication-orchestrator";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { seedScreenedRequest, seedUser, webClaim } from "./helpers/publication-review";

const ADMIN_KEY = "preloop-admin-key-0123456789abcdef0123456789abcdef";
const CALLBACK_SECRET = "preloop-callback-secret";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedUser(db, "preloopadmin", "admin", ADMIN_KEY);
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_preloop_test_token",
    PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
    ...over,
  } as Bindings;
}

interface Row {
  status: string;
  last_error: string | null;
  updated_at: string;
}

function requestRow(id: number): Row {
  return db
    .query<Row, [number]>(
      "SELECT status, last_error, updated_at FROM publication_requests WHERE id = ?",
    )
    .get(id) as Row;
}

async function inFlight(id: number): Promise<boolean> {
  const res = await app.request(
    "/admin/publish/requests",
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
  const body = (await res.json()) as {
    requests: { id: number; approval_in_flight: boolean }[];
  };
  const listed = body.requests.find((r) => r.id === id);
  if (!listed) throw new Error(`request ${id} is not in the list`);
  return listed.approval_in_flight;
}

describe("an approval that stops before its step loop", () => {
  /** A request mid-run: `approving`, a step past the validation ones done, quiet for 20 minutes. */
  async function seedRun(
    datasetId: string,
    shape: (id: string) => void,
  ): Promise<{ datasetId: string; requestId: number }> {
    const { requestId } = seedScreenedRequest(db, { datasetId, requestStatus: "approving" });
    db.run(
      `UPDATE publication_requests
          SET steps_completed = '["s3_public_read"]', updated_at = datetime('now', '-20 minutes')
        WHERE id = ?`,
      [requestId],
    );
    shape(datasetId);
    return { datasetId, requestId };
  }

  function approve(datasetId: string, bindings: Bindings, token?: string): Promise<Response> {
    return app.request(
      `/admin/publish/${datasetId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          "Content-Type": "application/json",
          ...(token === undefined ? {} : { "X-Approval-Dispatch-Token": token }),
        },
        body: JSON.stringify({ resume: true }),
      },
      bindings,
    );
  }

  /** Run `act` with the console captured, so a test reads what the Worker logged. */
  async function logged<T>(act: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const lines: string[] = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    const keep = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    console.log = keep;
    console.warn = keep;
    console.error = keep;
    try {
      return { result: await act(), lines };
    } finally {
      console.log = real.log;
      console.warn = real.warn;
      console.error = real.error;
    }
  }

  interface PreLoop {
    name: string;
    dataset: string;
    shape: (id: string) => void;
    status: number;
    body: Record<string, unknown>;
    /** What `last_error` must say: the sentence the answer carries. */
    sentence: string;
  }

  const cases: PreLoop[] = [
    {
      name: "a dataset with no row",
      dataset: "nm098781",
      shape: (id) => void db.run("DELETE FROM datasets WHERE dataset_id = ?", [id]),
      status: 404,
      body: { error: "Dataset not found" },
      sentence: "Dataset not found",
    },
    {
      name: "a sandbox dataset on a production Worker",
      dataset: "xx098782",
      shape: () => undefined,
      status: 400,
      body: {
        error: "Cannot publish sandbox datasets",
        message: "Sandbox datasets (xx-prefix) are for testing only and cannot be published.",
        dataset_id: "xx098782",
      },
      sentence: "Sandbox datasets (xx-prefix) are for testing only and cannot be published.",
    },
    {
      name: "a dataset with no repository",
      dataset: "nm098783",
      shape: (id) =>
        void db.run("UPDATE datasets SET github_repo = NULL WHERE dataset_id = ?", [id]),
      status: 400,
      body: { error: "Dataset has no GitHub repository" },
      sentence: "Dataset has no GitHub repository",
    },
    {
      name: "a dataset whose repository is not owner/name",
      dataset: "nm098784",
      shape: (id) =>
        void db.run("UPDATE datasets SET github_repo = 'no-slash-here' WHERE dataset_id = ?", [id]),
      status: 500,
      body: { error: "Invalid repository format" },
      sentence: "Invalid repository format",
    },
  ];

  for (const c of cases) {
    test(`${c.name}: the answer is unchanged, the row says why, and the run reads as stalled once the grace has passed`, async () => {
      const { requestId } = await seedRun(c.dataset, c.shape);
      expect(await inFlight(requestId)).toBe(false);

      // The heartbeat as the request-start UPDATE left it, read when the error is about to be
      // written: the write must not move it, because the grace counts from it.
      let heartbeat: string | null = null;
      const watched = env({
        ENVIRONMENT: "production",
        DB: interceptingD1(realD1(db), (sql) => {
          if (sql === PRE_LOOP_FAILURE_SQL) heartbeat = requestRow(requestId).updated_at;
        }),
      });
      const res = await approve(c.dataset, watched);
      expect(res.status).toBe(c.status);
      expect(await res.json()).toEqual(c.body);

      const row = requestRow(requestId);
      expect(row.status).toBe("approving");
      expect(row.last_error).toBe(c.sentence);
      expect(heartbeat).not.toBeNull();
      expect(row.updated_at).toBe(heartbeat as unknown as string);
      // Inside the grace window the run still reads as running: a retry is about to start.
      expect(await inFlight(requestId)).toBe(true);
      // Past it, with the error on the row, it is stalled. Without the error it would read as in
      // flight for the rest of the lease, with nothing running.
      db.run(
        "UPDATE publication_requests SET updated_at = datetime('now', '-2 minutes') WHERE id = ?",
        [requestId],
      );
      expect(await inFlight(requestId)).toBe(false);
    });

    test(`${c.name}: a failure to record the error never changes the answer`, async () => {
      const { requestId } = await seedRun(c.dataset, c.shape);
      let attempted = false;
      const bindings = env({
        ENVIRONMENT: "production",
        DB: interceptingD1(realD1(db), (sql) => {
          if (sql === PRE_LOOP_FAILURE_SQL) {
            attempted = true;
            throw new Error("D1 is down");
          }
        }),
      });
      const res = await approve(c.dataset, bindings);
      expect(attempted).toBe(true);
      expect(res.status).toBe(c.status);
      expect(await res.json()).toEqual(c.body);
      expect(requestRow(requestId).last_error).toBeNull();
    });
  }

  test("a request that was denied while the answer was being made is not given an error", async () => {
    const { requestId } = await seedRun("nm098785", (id) =>
      db.run("UPDATE datasets SET github_repo = NULL WHERE dataset_id = ?", [id]),
    );
    let attempted = false;
    const bindings = env({
      ENVIRONMENT: "production",
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql === PRE_LOOP_FAILURE_SQL) {
          attempted = true;
          db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [requestId]);
        }
      }),
    });
    const res = await approve("nm098785", bindings);
    expect(attempted).toBe(true);
    expect(res.status).toBe(400);
    const row = requestRow(requestId);
    expect(row.status).toBe("denied");
    expect(row.last_error).toBeNull();
  });

  test("a failure to record the error is logged with its cause and the request id", async () => {
    const { requestId } = await seedRun("nm098786", (id) =>
      db.run("UPDATE datasets SET github_repo = NULL WHERE dataset_id = ?", [id]),
    );
    const bindings = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql === PRE_LOOP_FAILURE_SQL) throw new Error("D1 is down for the write");
      }),
    });
    const { result: res, lines } = await logged(() => approve("nm098786", bindings));
    expect(res.status).toBe(400);
    const line = lines.find((l) => l.includes("could not record the early refusal"));
    expect(line).toBeDefined();
    expect(line).toContain(`request ${requestId}`);
    expect(line).toContain("D1 is down for the write");
  });

  describe("when the GitHub token cannot be minted", () => {
    // Neither a GitHub App nor a PAT is configured: `getDatasetsToken` throws after the request
    // was marked `approving` and before any step ran. The answer stays the Worker's own 500; the
    // row says why, so it does not read as a run in flight for the rest of the lease.
    const NO_GITHUB_AUTH = { GITHUB_ADMIN_PAT: undefined } as Partial<Bindings>;

    test("the answer stays 500, the row says why, and the run reads as stalled once the grace has passed", async () => {
      const { requestId } = await seedRun("nm098787", () => undefined);
      const res = await approve("nm098787", env(NO_GITHUB_AUTH));
      expect(res.status).toBe(500);

      const row = requestRow(requestId);
      expect(row.status).toBe("approving");
      expect(row.last_error).toBe("Could not get a GitHub token for the dataset repository");
      expect(await inFlight(requestId)).toBe(true);
      db.run(
        "UPDATE publication_requests SET updated_at = datetime('now', '-2 minutes') WHERE id = ?",
        [requestId],
      );
      expect(await inFlight(requestId)).toBe(false);
    });

    test("a web run's claim is left standing for the release step", async () => {
      const { requestId } = await seedRun("nm098788", () => undefined);
      const token = await webClaim(db, {
        requestId,
        clickerId: adminId,
        secret: CALLBACK_SECRET,
      });
      const claimOf = () =>
        db
          .query<{ by: number | null; at: string | null }, [number]>(
            "SELECT approval_requested_by AS by, approval_dispatched_at AS at FROM publication_requests WHERE id = ?",
          )
          .get(requestId);
      const before = claimOf();
      expect(before?.by).toBe(adminId);

      const res = await approve("nm098788", env(NO_GITHUB_AUTH), token);
      expect(res.status).toBe(500);
      expect(requestRow(requestId).last_error).toBe(
        "Could not get a GitHub token for the dataset repository",
      );
      // The release step of the workflow ends the claim; a failure here does not.
      expect(claimOf()).toEqual(before);
    });
  });
});
