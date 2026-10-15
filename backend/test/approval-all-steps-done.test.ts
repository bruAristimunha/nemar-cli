/**
 * An approval whose steps are all complete (ADR 0105, decision 12; issue #1730).
 *
 * `runPublicationApproval` has a branch for a run that has nothing left to do: a web run that died
 * after its last step and is resumed, or the retry its own warnings ask for. The branch runs the two
 * tail jobs of a de-anonymization (the Zarr rebuild stamp and the completion of the version
 * identifiers a concealed release left reserved), then ends the run with the write every approval
 * ends with. Three things are pinned here, each with real rows:
 *
 *   1. A tail job that warns tells the administrator to "approve the request again to retry", so
 *      the request must stay `approving` for that to be true: closing it would make the retry a
 *      404. Only a run with no warning closes the request.
 *   2. A request that is not `approving` (a `requested` row that carries the steps of an earlier
 *      life, or an owner-name `blocked` one) is refused BEFORE the tail jobs, so a refusal that
 *      reads as "nothing happened" has written no stamp and published no identifier.
 *   3. The call that closes the request writes the `dataset_published` audit row, naming the
 *      account that finished it, and only that call: a concurrent finisher or a second resume
 *      writes none.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth
 * middleware and routes. No external service is reached: the tail job that warns does so because
 * the dataset has no concept identifier to relate a reserved version to, which is decided from
 * rows alone.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  APPROVAL_CLOSED_DURING_RUN_MESSAGE,
  APPROVAL_REFUSAL_ERROR_CODES,
} from "../../shared/contract/publication";
import { OWNER_NAME_MISSING_REASON, PUBLICATION_STEPS } from "../../shared/publication-steps";
import { adminRoutes } from "../src/routes/admin";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import {
  WEB_CLAIM_SECRET,
  seedScreenedRequest,
  seedUser,
  webClaim,
} from "./helpers/publication-review";
import { hookedD1 } from "./helpers/publication-review-harness";

const TERMINAL_KEY = "all-done-terminal-0123456789abcdef0123456789abcdef";
const EXECUTOR_KEY = "all-done-executor-0123456789abcdef0123456789abcdef";
const CLICKER_KEY = "all-done-clicker-0123456789abcdef0123456789abcdef";
const DATASET = "nm098771";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let terminalId: number;
let clickerId: number;

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  terminalId = await seedUser(db, "allDoneTerminal", "admin", TERMINAL_KEY);
  await seedUser(db, "allDoneExecutor", "admin", EXECUTOR_KEY);
  clickerId = await seedUser(db, "allDoneClicker", "admin", CLICKER_KEY);
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_all_done_test",
    PRESCREEN_CALLBACK_SECRET: WEB_CLAIM_SECRET,
    ...over,
  } as Bindings;
}

function approve(o: { key?: string; token?: string; bindings?: Bindings } = {}): Promise<Response> {
  return app.request(
    `/admin/publish/${DATASET}/approve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${o.key ?? TERMINAL_KEY}`,
        "Content-Type": "application/json",
        ...(o.token === undefined ? {} : { "X-Approval-Dispatch-Token": o.token }),
      },
      body: JSON.stringify({ resume: true }),
    },
    o.bindings ?? env(),
  );
}

/** A request with every step done, in `status`. */
function seedAllDone(
  status: "requested" | "approving" | "blocked" = "approving",
  blockReason: string | null = null,
): number {
  const { requestId } = seedScreenedRequest(db, {
    datasetId: DATASET,
    requestStatus: status,
    blockReason,
  });
  db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(PUBLICATION_STEPS),
    requestId,
  ]);
  return requestId;
}

/**
 * Give the dataset a concealed era whose completion warns: an earlier request for the blind, and a
 * recorded version with no concept identifier to relate it to. Both tail jobs then have something
 * to do, the Zarr stamp writes `sweep_stamps` and the version job warns (and writes an audit row),
 * with no network.
 */
function seedConcealedEraWithWarning(): void {
  db.run(
    `INSERT INTO publication_requests (dataset_id, requested_by, status, anonymous, requested_at)
     VALUES (?, (SELECT owner_user_id FROM datasets WHERE dataset_id = ?), 'denied', 1,
             datetime('now', '-10 days'))`,
    [DATASET, DATASET],
  );
  db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
    DATASET,
    "10.5072/FK2all-done",
  ]);
}

/** The concealed era's warning is gone: the recorded version is repaired by hand. */
function repairConcealedEra(): void {
  db.run("DELETE FROM dataset_versions WHERE dataset_id = ?", [DATASET]);
}

type Row = Record<string, unknown>;

function requestRow(id: number): Row {
  return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Row;
}

function sweepStamps(): unknown {
  return (
    db
      .query<{ sweep_stamps: string | null }, [string]>(
        "SELECT sweep_stamps FROM datasets WHERE dataset_id = ?",
      )
      .get(DATASET)?.sweep_stamps ?? null
  );
}

function auditRows(action: string): { user_id: number | null; details: Record<string, unknown> }[] {
  return (
    db.query("SELECT user_id, details FROM audit_log WHERE action = ? ORDER BY id").all(action) as {
      user_id: number | null;
      details: string;
    }[]
  ).map((r) => ({ user_id: r.user_id, details: JSON.parse(r.details) }));
}

describe("a tail job that warns leaves the request approving, so approving again is the retry it asks for", () => {
  test("the warning is returned, the request stays approving, nothing is recorded as published, and a repaired run closes it", async () => {
    const id = seedAllDone("approving");
    seedConcealedEraWithWarning();

    const first = await approve();
    expect(first.status).toBe(200);
    const body = (await first.json()) as Record<string, unknown>;
    expect(body.message).toBe("All steps already completed");
    // The answer says what the row says: a request the call did not close is `approving`, and the
    // warning is under the one key every other answer of this route and the CLI read, `warning`
    // (ADR 0105 decision 12), never a plural one that nothing prints.
    expect(body.status).toBe("approving");
    expect(body).not.toHaveProperty("warnings");
    expect(body.warning).toContain("Approve the request again to retry");
    expect(requestRow(id).status).toBe("approving");
    expect(requestRow(id).approved_at).toBeNull();
    expect(auditRows("dataset_published")).toHaveLength(0);

    // The remedy the warning names is real: approving again finds the request (a published one
    // would be a 404), runs the tail jobs again, and warns again while the cause stands.
    const again = await approve();
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { status: string; warning?: string };
    expect(againBody.status).toBe("approving");
    expect(againBody.warning).toContain("Approve the request again to retry");
    expect(requestRow(id).status).toBe("approving");

    // Once the cause is repaired, the next approval has nothing to warn about and closes the request.
    repairConcealedEra();
    const closing = await approve();
    expect(closing.status).toBe(200);
    expect(await closing.json()).toEqual({
      message: "All steps already completed",
      dataset_id: DATASET,
      status: "published",
    });
    expect(requestRow(id).status).toBe("published");
    expect(requestRow(id).approved_at).not.toBeNull();
    expect(auditRows("dataset_published")).toHaveLength(1);
  });

  test("two tail jobs that warn in one call are joined with ' | ' under the one key, as the step loop joins its own", async () => {
    const id = seedAllDone("approving");
    seedConcealedEraWithWarning();
    const failingStamp = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (/UPDATE datasets\s+SET sweep_stamps/.test(sql)) throw new Error("the stamp is refused");
      }),
    });

    const res = await approve({ bindings: failingStamp });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; warning?: string };
    expect(body.status).toBe("approving");
    const parts = (body.warning ?? "").split(" | ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("the stamp is refused");
    expect(parts[1]).toContain("Approve the request again to retry");
    expect(requestRow(id).status).toBe("approving");
  });
});

describe("a closed request is refused before the tail jobs write anything", () => {
  for (const [name, status, reason] of [
    ["a requested request that carries every step", "requested", null],
    [
      "an owner-name blocked request resumed with every step done",
      "blocked",
      OWNER_NAME_MISSING_REASON,
    ],
  ] as const) {
    test(`${name}: 409 approval_closed_during_run, no stamp, no version identifier work, one audit row`, async () => {
      const id = seedAllDone(status, reason);
      seedConcealedEraWithWarning();
      const stampsBefore = sweepStamps();
      const requestBefore = requestRow(id);

      const res = await approve();

      expect(res.status).toBe(409);
      const refused = (await res.json()) as { error: string };
      expect(refused).toEqual({
        error: "approval_closed_during_run",
        message: APPROVAL_CLOSED_DURING_RUN_MESSAGE,
      });
      expect(APPROVAL_REFUSAL_ERROR_CODES).toContain(refused.error);
      // The refusal reads as "nothing was published", and so nothing the tail jobs do was done.
      expect(sweepStamps()).toEqual(stampsBefore);
      expect(auditRows("concealed_era_version_doi_incomplete")).toHaveLength(0);
      expect(auditRows("zarr_requeue_request_failed")).toHaveLength(0);
      expect(auditRows("dataset_published")).toHaveLength(0);
      expect(requestRow(id)).toEqual(requestBefore);
      const logged = auditRows("approval_finished_on_closed_request");
      expect(logged).toHaveLength(1);
      expect(logged[0].details).toEqual({ request_id: id, request_status: status });
    });
  }

  test("the control: the same concealed era on an approving request does run the tail jobs", async () => {
    seedAllDone("approving");
    seedConcealedEraWithWarning();
    expect(sweepStamps()).toBeNull();

    const res = await approve();

    expect(res.status).toBe(200);
    expect(sweepStamps()).not.toBeNull();
    expect(auditRows("concealed_era_version_doi_incomplete")).toHaveLength(1);
  });
});

describe("the call that closes an all-steps-done request writes the dataset_published row, once", () => {
  test("a web run that died after its last step, resumed by a terminal administrator, is recorded under that administrator", async () => {
    const id = seedAllDone("approving");
    // The click's claim is still on the row, long lapsed: the run that held it is gone.
    await webClaim(db, { requestId: id, clickerId, dispatchedAt: "-3 hours" });

    const res = await approve({ key: TERMINAL_KEY });

    expect(res.status).toBe(200);
    expect(requestRow(id).status).toBe("published");
    const rows = auditRows("dataset_published");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(terminalId);
    expect(rows[0].details).toMatchObject({
      approved_by: "allDoneTerminal",
      steps: [...PUBLICATION_STEPS],
      review_gate: "off",
      skip_ci_check: false,
      finished_by_resume: true,
    });
    expect(rows[0].details).not.toHaveProperty("executed_by");

    // A second resume finds no active request, and writes nothing.
    const second = await approve({ key: TERMINAL_KEY });
    expect(second.status).toBe(404);
    expect(auditRows("dataset_published")).toHaveLength(1);
  });

  test("an executor carrying the click's token finishes it as the clicker, with itself as the executor", async () => {
    const id = seedAllDone("approving");
    const token = await webClaim(db, { requestId: id, clickerId });

    const res = await approve({ key: EXECUTOR_KEY, token });

    expect(res.status).toBe(200);
    const rows = auditRows("dataset_published");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(clickerId);
    expect(rows[0].details).toMatchObject({
      approved_by: "allDoneClicker",
      executed_by: "allDoneExecutor",
      finished_by_resume: true,
    });
  });

  test("the audit row is written with the closing write: a fault on the row leaves the request approving, and a retry closes it once", async () => {
    // The two writes are one batch (ADR 0105, decision 12), so a publication has its row exactly
    // when the request is `published`: a fault between them cannot leave a published request with
    // no row, because there is no gap. The fault is aimed at the row's statement inside the batch.
    const id = seedAllDone("approving");
    let armed = true;
    const failing = env({
      DB: hookedD1(realD1(db), {
        statement: (sql, inBatch) => {
          if (armed && inBatch && /INSERT INTO audit_log/.test(sql) && /changes\(\)/.test(sql)) {
            throw new Error("the audit table is unwritable");
          }
        },
      }),
    });

    const res = await approve({ bindings: failing });

    expect(res.status).toBe(500);
    // Neither write took effect: the request is still the one an approval can retry.
    expect(requestRow(id).status).toBe("approving");
    expect(auditRows("dataset_published")).toHaveLength(0);

    armed = false;
    const retry = await approve({ bindings: failing });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { status: string }).status).toBe("published");
    expect(requestRow(id).status).toBe("published");
    expect(auditRows("dataset_published")).toHaveLength(1);

    // A call after the close finds no active request and writes no second row.
    expect((await approve()).status).toBe(404);
    expect(auditRows("dataset_published")).toHaveLength(1);
  });

  // The row records the review gate's state for the dataset, read from the dataset's row. A run
  // that never read the row reads it here, and a row it cannot read (the read failed, or the
  // dataset is gone) is a warning and no audit row, never a row with a gate state made up for it
  // (ADR 0105 decision 12).
  describe("the dataset row the audit row is built from cannot be read", () => {
    const readFailing = () =>
      env({
        DB: interceptingD1(realD1(db), (sql) => {
          if (/SELECT source, is_exemplar FROM datasets/.test(sql)) {
            throw new Error("the dataset read is refused");
          }
        }),
      });

    for (const [name, arrange, bindings, cause] of [
      ["the read fails", () => {}, readFailing, "the dataset read is refused"],
      [
        "the dataset row is gone",
        () => db.run("DELETE FROM datasets WHERE dataset_id = ?", [DATASET]),
        () => env(),
        "no dataset row",
      ],
    ] as const) {
      test(`${name}: a warning in the answer, no dataset_published row, and the request is still closed`, async () => {
        const id = seedAllDone("approving");
        arrange();

        const res = await approve({ bindings: bindings() });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; warning?: string };
        expect(body.status).toBe("published");
        expect(body.warning).toContain("Audit log write failed");
        expect(body.warning).toContain(cause);
        expect(requestRow(id).status).toBe("published");
        expect(auditRows("dataset_published")).toHaveLength(0);
      });
    }
  });

  test("a finisher that lost the race to a concurrent call writes no row of its own", async () => {
    const id = seedAllDone("approving");
    const racing = env({
      DB: hookedD1(realD1(db), {
        statement: (sql) => {
          // The concurrent call of the same run closes the request between this call's read and
          // its own closing write (a statement of the batch), which then finds it already
          // published, and whose audit insert, guarded on that write, writes nothing.
          if (/SET status = 'published'/.test(sql)) {
            db.run("UPDATE publication_requests SET status = 'published' WHERE id = ?", [id]);
          }
        },
      }),
    });

    const res = await approve({ bindings: racing });

    expect(res.status).toBe(200);
    expect(requestRow(id).status).toBe("published");
    expect(auditRows("dataset_published")).toHaveLength(0);
  });
});
