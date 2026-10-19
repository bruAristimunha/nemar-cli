/**
 * Migration 0098 (`publication_reviews`) and the row module that reads it (ADR 0102).
 *
 * Real engines only: every migration applied in order to bun:sqlite (`freshDb`), and the SQL
 * fragments the claim and the mail lease will share run again on Miniflare's D1, the
 * implementation `wrangler --local` runs, because bun:sqlite is more lenient than D1. What is
 * pinned is what the later phases rely on: the columns, a CHECK for every pairing a state must not
 * have, vocabularies equal to the shared module's, no column added to `datasets` or
 * `publication_requests`, and fragments that select exactly the rows their names promise.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { DATASET_STATUSES, type ScreenState } from "../../shared/identifier-screen-report";
import {
  PUBLICATION_DECLINE_DETAILS,
  PUBLICATION_OUTCOMES,
  PUBLICATION_REVIEW_STATES,
  PUBLICATION_RUN_ERRORS,
  parsePublicationReviewReport,
  reportReasons,
  verdictOf,
} from "../../shared/publication-review";
import * as screen from "../src/services/identifier-screen";
import * as stored from "../src/services/identifier-screen-stored";
import {
  MAX_HISTORY_ROWS,
  REVIEWABLE_SCREEN_STATES,
  REVIEWABLE_SCREEN_STATES_SQL,
  ROW_COLUMNS,
  listReviewsOfRequest,
  readReview,
  readReviewByKey,
  reviewInFlightSql,
  rowViewOf,
  screenedHeadSql,
  toRow,
} from "../src/services/publication-review-rows";
import { freshDb, realD1 } from "./helpers/d1";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import {
  SCREENED_HEAD,
  evidenceFor,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
} from "./helpers/publication-review";

const SQL = readFileSync(join(MIGRATIONS_DIR, "0098_publication_reviews.sql"), "utf8");
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Every migration before 0098, applied in order: the schema this migration starts from. */
function dbBefore0098(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < "0098")
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

describe("0098 publication_reviews: columns", () => {
  const db = freshDb();
  const info = db.query("PRAGMA table_info(publication_reviews)").all() as ColumnInfo[];

  const COLUMNS: Record<string, { type: string; notnull: 0 | 1; dflt: string | null }> = {
    id: { type: "INTEGER", notnull: 0, dflt: null },
    request_id: { type: "INTEGER", notnull: 1, dflt: null },
    dataset_id: { type: "TEXT", notnull: 1, dflt: null },
    head_sha: { type: "TEXT", notnull: 1, dflt: null },
    anonymous: { type: "INTEGER", notnull: 1, dflt: null },
    requested_by: { type: "INTEGER", notnull: 1, dflt: null },
    started_by: { type: "INTEGER", notnull: 0, dflt: null },
    state: { type: "TEXT", notnull: 1, dflt: null },
    verdict: { type: "TEXT", notnull: 0, dflt: null },
    detail: { type: "TEXT", notnull: 0, dflt: null },
    report: { type: "TEXT", notnull: 0, dflt: null },
    nonce: { type: "TEXT", notnull: 0, dflt: null },
    claimed_at: { type: "TEXT", notnull: 0, dflt: null },
    attempts: { type: "INTEGER", notnull: 1, dflt: "1" },
    override_by: { type: "INTEGER", notnull: 0, dflt: null },
    override_at: { type: "TEXT", notnull: 0, dflt: null },
    override_reasons: { type: "TEXT", notnull: 0, dflt: null },
    created_at: { type: "TEXT", notnull: 1, dflt: "datetime('now')" },
    decided_at: { type: "TEXT", notnull: 0, dflt: null },
  };

  test("exactly the declared columns, types, NOT NULLs and defaults", () => {
    expect(info.map((c) => c.name)).toEqual(Object.keys(COLUMNS));
    for (const c of info) {
      expect({ [c.name]: [c.type, c.notnull, c.dflt_value] }).toEqual({
        [c.name]: [COLUMNS[c.name].type, COLUMNS[c.name].notnull, COLUMNS[c.name].dflt],
      });
    }
    expect(info.find((c) => c.name === "id")?.pk).toBe(1);
  });

  test("no foreign key, so a deleted dataset or request neither blocks nor cascades", () => {
    expect(db.query("PRAGMA foreign_key_list(publication_reviews)").all()).toEqual([]);
  });

  test("the depositor and state indexes exist beside the UNIQUE key's own", () => {
    const names = (db.query("PRAGMA index_list(publication_reviews)").all() as { name: string }[])
      .map((i) => i.name)
      .sort();
    expect(names).toContain("idx_publication_reviews_depositor");
    expect(names).toContain("idx_publication_reviews_state");
    const unique = names.filter((n) => n.startsWith("sqlite_autoindex_publication_reviews"));
    expect(unique).toHaveLength(1);
    const cols = (db.query(`PRAGMA index_info(${unique[0]})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(["request_id", "head_sha", "anonymous"]);
  });
});

describe("0098 adds one table and two indexes, and no column anywhere else", () => {
  test("datasets and publication_requests have the columns they had before 0098", () => {
    const before = dbBefore0098();
    const after = freshDb();
    for (const table of ["datasets", "publication_requests", "users", "dataset_versions"]) {
      const cols = (db: Database) =>
        (db.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).map((c) => c.name);
      expect({ [table]: cols(after) }).toEqual({ [table]: cols(before) });
    }
  });

  test("the only new schema objects are the table and its indexes", () => {
    const objects = (db: Database) =>
      new Set(
        (db.query("SELECT type, name FROM sqlite_master").all() as { type: string; name: string }[])
          .filter((o) => !o.name.startsWith("sqlite_"))
          .map((o) => `${o.type}:${o.name}`),
      );
    const before = objects(dbBefore0098());
    const added = [...objects(freshDb())].filter((o) => !before.has(o)).sort();
    expect(added).toEqual([
      "index:idx_publication_reviews_depositor",
      "index:idx_publication_reviews_state",
      "table:publication_reviews",
    ]);
  });
});

describe("0098: the vocabularies of the migration and the code are the same lists", () => {
  const listAfter = (re: RegExp): string[] => {
    const m = SQL.match(re);
    if (!m) throw new Error(`no match for ${re}`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };

  test("state, verdict and detail", () => {
    expect(listAfter(/state TEXT NOT NULL\s+CHECK \(state IN \(([^)]*)\)/)).toEqual([
      ...PUBLICATION_REVIEW_STATES,
    ]);
    expect(listAfter(/verdict TEXT CHECK \(verdict IS NULL OR verdict IN \(([^)]*)\)/)).toEqual([
      ...PUBLICATION_OUTCOMES,
    ]);
    expect(listAfter(/detail TEXT CHECK \(detail IS NULL OR detail IN \(([^)]*)\)/)).toEqual([
      ...PUBLICATION_DECLINE_DETAILS,
      ...PUBLICATION_RUN_ERRORS,
    ]);
  });

  test("the declined and errored kinds name exactly the decline details", () => {
    expect(listAfter(/state <> 'declined' OR detail IN \(([^)]*)\)/)).toEqual([
      ...PUBLICATION_DECLINE_DETAILS,
    ]);
    expect(listAfter(/state <> 'errored' OR detail NOT IN \(([^)]*)\)/)).toEqual([
      ...PUBLICATION_DECLINE_DETAILS,
    ]);
  });
});

describe("0098: a CHECK for every pairing a row must not have", () => {
  const db = freshDb();
  let n = 0;
  /** Insert a row: a valid dispatched one, with `over` applied. Each gets its own request. */
  const insert = (over: Record<string, string | number | null> = {}) => {
    n += 1;
    const row: Record<string, string | number | null> = {
      request_id: n,
      dataset_id: "nm000470",
      head_sha: SCREENED_HEAD,
      anonymous: 0,
      requested_by: 1,
      state: "dispatched",
      verdict: null,
      detail: null,
      report: null,
      nonce: "n",
      decided_at: null,
      ...over,
    };
    const keys = Object.keys(row);
    db.query(
      `INSERT INTO publication_reviews (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ).run(...(Object.values(row) as never[]));
  };
  const decided = { decided_at: "2026-10-13 00:00:00", nonce: null };
  const reported = { state: "reported", verdict: "pass", report: "{}", ...decided };

  test("the valid shape of every state is accepted", () => {
    expect(() => insert()).not.toThrow();
    expect(() => insert(reported)).not.toThrow();
    expect(() =>
      insert({ state: "declined", detail: "depositor_limit", ...decided }),
    ).not.toThrow();
    expect(() => insert({ state: "declined", detail: "platform_limit", ...decided })).not.toThrow();
    for (const error of PUBLICATION_RUN_ERRORS) {
      expect(() => insert({ state: "errored", detail: error, ...decided })).not.toThrow();
    }
    expect(() => insert({ state: "unreported", decided_at: "2026-10-13 00:00:00" })).not.toThrow();
    expect(() => insert({ state: "unreported", ...decided })).not.toThrow();
  });

  test("words outside the vocabularies, a short head, a bad flag, no attempt", () => {
    expect(() => insert({ state: "running" })).toThrow();
    expect(() => insert({ ...reported, verdict: "uncertain" })).toThrow();
    expect(() => insert({ state: "errored", detail: "too_large", ...decided })).toThrow();
    expect(() => insert({ head_sha: SCREENED_HEAD.slice(1) })).toThrow();
    expect(() => insert({ head_sha: `${SCREENED_HEAD}0` })).toThrow();
    expect(() => insert({ anonymous: 2 })).toThrow();
    expect(() => insert({ attempts: 0 })).toThrow();
  });

  test("a verdict and a report exist exactly when the review reported", () => {
    expect(() => insert({ ...reported, verdict: null })).toThrow();
    expect(() => insert({ ...reported, report: null })).toThrow();
    expect(() => insert({ verdict: "pass" })).toThrow();
    expect(() => insert({ report: "{}" })).toThrow();
    expect(() =>
      insert({ state: "errored", detail: "workflow_failed", verdict: "fail", ...decided }),
    ).toThrow();
  });

  test("a closed word exists exactly when declined or errored, and of the right kind", () => {
    expect(() => insert({ state: "declined", ...decided })).toThrow();
    expect(() => insert({ state: "errored", ...decided })).toThrow();
    expect(() => insert({ detail: "stale_head" })).toThrow();
    expect(() => insert({ ...reported, detail: "report_invalid" })).toThrow();
    expect(() => insert({ state: "declined", detail: "workflow_failed", ...decided })).toThrow();
    expect(() => insert({ state: "errored", detail: "depositor_limit", ...decided })).toThrow();
    expect(() => insert({ state: "errored", detail: "platform_limit", ...decided })).toThrow();
  });

  test("a nonce exists exactly while the review may still be answered", () => {
    expect(() => insert({ nonce: null })).toThrow();
    expect(() => insert({ ...reported, nonce: "n" })).toThrow();
    expect(() =>
      insert({ state: "declined", detail: "platform_limit", ...decided, nonce: "n" }),
    ).toThrow();
    expect(() =>
      insert({ state: "errored", detail: "stale_head", ...decided, nonce: "n" }),
    ).toThrow();
  });

  test("decided exactly when it left dispatched", () => {
    expect(() => insert({ decided_at: "2026-10-13 00:00:00" })).toThrow();
    expect(() => insert({ ...reported, decided_at: null })).toThrow();
    expect(() => insert({ state: "unreported", decided_at: null })).toThrow();
  });

  test("an override is recorded whole or not at all", () => {
    expect(() => insert({ ...reported, override_by: 2 })).toThrow();
    expect(() =>
      insert({ ...reported, override_by: 2, override_at: "2026-10-13 00:00:00" }),
    ).toThrow();
    expect(() =>
      insert({ ...reported, override_at: "2026-10-13 00:00:00", override_reasons: "[]" }),
    ).toThrow();
    expect(() =>
      insert({
        ...reported,
        override_by: 2,
        override_at: "2026-10-13 00:00:00",
        override_reasons: '["question_failed"]',
      }),
    ).not.toThrow();
  });

  test("one row per request, commit and kind of release", () => {
    insert({ request_id: 9001 });
    expect(() => insert({ request_id: 9001 })).toThrow();
    expect(() => insert({ request_id: 9001, ...reported })).toThrow();
    expect(() => insert({ request_id: 9001, anonymous: 1 })).not.toThrow();
    expect(() => insert({ request_id: 9001, head_sha: OTHER_HEAD })).not.toThrow();
  });
});

describe("the reviewable screen states come from screenGate", () => {
  test("they are the clear and acknowledge states, as words safe to splice into SQL", () => {
    expect([...REVIEWABLE_SCREEN_STATES].sort()).toEqual(
      [
        "clean",
        "dates-only",
        "no-recordings",
        "review",
        "unchecked",
        "not-screened",
        "clean-edf-only-others-unscreened",
      ].sort(),
    );
    for (const s of ["pending", "direct-identifiers", "error", "unreported"]) {
      expect(REVIEWABLE_SCREEN_STATES as readonly string[]).not.toContain(s);
    }
    // Every scanner verdict is accounted for one way or the other.
    for (const s of DATASET_STATUSES) {
      expect(REVIEWABLE_SCREEN_STATES.includes(s) || s === "direct-identifiers").toBe(true);
    }
    expect(REVIEWABLE_SCREEN_STATES_SQL).toBe(
      REVIEWABLE_SCREEN_STATES.map((s) => `'${s}'`).join(", "),
    );
  });
});

describe("the SQL fragments select what their names promise (bun:sqlite)", () => {
  const db = freshDb();
  const ids: Record<string, number> = {};
  const seed = (name: string, req: Parameters<typeof seedScreenedRequest>[1]) => {
    ids[name] = seedScreenedRequest(db, req).requestId;
  };
  // In flight: dispatched, young, of the screened head and the request's flag.
  seed("inFlight", { datasetId: "nm000471" });
  // Each of these differs from it in one term.
  seed("old", { datasetId: "nm000472" });
  seed("otherHead", { datasetId: "nm000473" });
  seed("otherFlag", { datasetId: "nm000474", anonymous: true });
  seed("reported", { datasetId: "nm000475" });
  seed("unreported", { datasetId: "nm000476" });
  seed("noRow", { datasetId: "nm000477" });
  seed("justInside", { datasetId: "nm000478" });
  seed("pending", { datasetId: "nm000479", status: "pending" });
  seedPublicationReview(db, {
    requestId: ids.inFlight,
    datasetId: "nm000471",
    state: "dispatched",
  });
  seedPublicationReview(db, {
    requestId: ids.old,
    datasetId: "nm000472",
    state: "dispatched",
    createdMinutesAgo: 31,
  });
  seedPublicationReview(db, {
    requestId: ids.otherHead,
    datasetId: "nm000473",
    head: OTHER_HEAD,
    state: "dispatched",
  });
  seedPublicationReview(db, {
    requestId: ids.otherFlag,
    datasetId: "nm000474",
    anonymous: false,
    state: "dispatched",
  });
  seedPublicationReview(db, { requestId: ids.reported, datasetId: "nm000475", state: "reported" });
  seedPublicationReview(db, {
    requestId: ids.unreported,
    datasetId: "nm000476",
    state: "unreported",
    createdMinutesAgo: 5,
  });
  seedPublicationReview(db, {
    requestId: ids.justInside,
    datasetId: "nm000478",
    state: "dispatched",
    createdMinutesAgo: 29,
  });

  test("reviewInFlightSql holds exactly the request whose screened head and flag are in flight", () => {
    const held = db
      .query(
        `SELECT pr.id FROM publication_requests AS pr WHERE ${reviewInFlightSql("pr")} ORDER BY pr.id`,
      )
      .all() as { id: number }[];
    expect(held.map((r) => r.id)).toEqual([ids.inFlight, ids.justInside]);
  });

  test("it works on the bare table name, inside the UPDATE a lease is", () => {
    const changed = db
      .query(
        `UPDATE publication_requests SET identifier_screen_mail_claimed_at = datetime('now')
          WHERE id IN (?, ?) AND NOT ${reviewInFlightSql("publication_requests")}`,
      )
      .run(ids.inFlight, ids.old);
    expect(changed.changes).toBe(1);
    const claimed = db
      .query(
        "SELECT id FROM publication_requests WHERE identifier_screen_mail_claimed_at IS NOT NULL",
      )
      .all() as { id: number }[];
    expect(claimed.map((r) => r.id)).toEqual([ids.old]);
  });

  test("screenedHeadSql reads the stored report's head, and nothing for a screen with no report", () => {
    const head = (id: number) =>
      (
        db
          .query(
            `SELECT ${screenedHeadSql("pr")} AS head FROM publication_requests AS pr WHERE pr.id = ?`,
          )
          .get(id) as {
          head: string | null;
        }
      ).head;
    expect(head(ids.inFlight)).toBe(SCREENED_HEAD);
    expect(head(ids.pending)).toBeNull();
    expect(
      stored.readStoredReport(
        (
          db
            .query("SELECT identifier_screen_report AS r FROM publication_requests WHERE id = ?")
            .get(ids.inFlight) as { r: string }
        ).r,
      )?.head,
    ).toBe(SCREENED_HEAD);
  });

  test("an alias that is not a plain name is refused rather than spliced", () => {
    expect(() => reviewInFlightSql("pr; DROP TABLE publication_reviews")).toThrow();
    expect(() => screenedHeadSql("pr.x")).toThrow();
    expect(() => screenedHeadSql("")).toThrow();
  });
});

describe("the SQL fragments on Miniflare D1", () => {
  let mf: Miniflare;
  beforeAll(() => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
      compatibilityDate: "2024-12-01",
      d1Databases: ["DB1"],
    });
  });
  afterAll(async () => {
    await mf?.dispose();
  });

  test("json_extract and EXISTS inside a conditional UPDATE behave as on bun:sqlite", async () => {
    const d1 = (await mf.getD1Database("DB1")) as unknown as D1Database;
    await applyMigrations(d1, migrationFiles());
    // D1 enforces the requests' foreign key to users, which bun:sqlite leaves off.
    await d1
      .prepare(
        `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
         VALUES (1, 'd1owner', 'd1owner@example.org', 'x', 'approved', 'member', 1)`,
      )
      .run();
    const report = JSON.stringify({
      version: 1,
      scanner: "identifier-scan@abcdef1",
      head: SCREENED_HEAD,
    });
    await d1
      .prepare(
        `INSERT INTO publication_requests (id, dataset_id, requested_by, status, anonymous,
                                           identifier_screen_status, identifier_screen_report)
         VALUES (1, 'nm000471', 1, 'requested', 0, 'clean', ?1),
                (2, 'nm000472', 1, 'requested', 0, 'clean', ?1),
                (3, 'nm000473', 1, 'requested', 1, 'clean', ?1)`,
      )
      .bind(report)
      .run();
    await d1
      .prepare(
        `INSERT INTO publication_reviews (request_id, dataset_id, head_sha, anonymous, requested_by,
                                          state, nonce, created_at)
         VALUES (1, 'nm000471', ?1, 0, 1, 'dispatched', 'n1', datetime('now')),
                (2, 'nm000472', ?1, 0, 1, 'dispatched', 'n2', datetime('now', '-31 minutes')),
                (3, 'nm000473', ?1, 0, 1, 'dispatched', 'n3', datetime('now'))`,
      )
      .bind(SCREENED_HEAD)
      .run();
    const held = await d1
      .prepare(
        `SELECT pr.id FROM publication_requests AS pr WHERE ${reviewInFlightSql("pr")} ORDER BY pr.id`,
      )
      .all<{ id: number }>();
    expect(held.results.map((r) => r.id)).toEqual([1]);
    const lease = await d1
      .prepare(
        `UPDATE publication_requests SET identifier_screen_mail_claimed_at = datetime('now')
          WHERE status = 'requested' AND identifier_screen_status IN (${REVIEWABLE_SCREEN_STATES_SQL})
            AND NOT ${reviewInFlightSql("publication_requests")}
          RETURNING id`,
      )
      .all<{ id: number }>();
    expect(lease.results.map((r) => r.id).sort()).toEqual([2, 3]);
    // A CHECK that only bun:sqlite enforced would not protect production.
    await expect(
      d1
        .prepare(
          `INSERT INTO publication_reviews (request_id, dataset_id, head_sha, anonymous, requested_by, state)
           VALUES (4, 'nm000474', ?, 0, 1, 'dispatched')`,
        )
        .bind(SCREENED_HEAD)
        .run(),
    ).rejects.toThrow();
  }, 60_000);
});

describe("the row module", () => {
  test("a read never carries the nonce, and the row has exactly its declared fields", async () => {
    const db = freshDb();
    const { requestId } = seedScreenedRequest(db, { datasetId: "nm000480" });
    const id = seedPublicationReview(db, {
      requestId,
      datasetId: "nm000480",
      state: "dispatched",
      nonce: "secret-nonce-value",
    });
    expect(ROW_COLUMNS.split(",").map((c) => c.trim())).not.toContain("nonce");
    const raw = db
      .query(`SELECT ${ROW_COLUMNS} FROM publication_reviews WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    expect(Object.keys(raw)).not.toContain("nonce");
    const row = await readReview(realD1(db), id);
    expect(JSON.stringify(row)).not.toContain("secret-nonce-value");
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "id",
        "requestId",
        "datasetId",
        "headSha",
        "anonymous",
        "requestedBy",
        "startedBy",
        "state",
        "verdict",
        "detail",
        "report",
        "claimedAt",
        "attempts",
        "overrideBy",
        "overrideAt",
        "overrideReasons",
        "createdAt",
        "decidedAt",
      ].sort(),
    );
    expect(row).toMatchObject({
      id,
      requestId,
      datasetId: "nm000480",
      headSha: SCREENED_HEAD,
      anonymous: false,
      state: "dispatched",
      attempts: 1,
      decidedAt: null,
    });
    expect(await readReview(realD1(db), id + 1000)).toBeNull();
  });

  test("by key, the flag is part of the key; a request's history is newest first and bounded", async () => {
    const db = freshDb();
    const { requestId, userId } = seedScreenedRequest(db, { datasetId: "nm000481" });
    const named = seedPublicationReview(db, {
      requestId,
      datasetId: "nm000481",
      state: "reported",
    });
    const anonymous = seedPublicationReview(db, {
      requestId,
      datasetId: "nm000481",
      anonymous: true,
      state: "declined",
      detail: "depositor_limit",
    });
    const older = seedPublicationReview(db, {
      requestId,
      datasetId: "nm000481",
      head: OTHER_HEAD,
      state: "errored",
      detail: "stale_head",
    });
    const d1 = realD1(db);
    expect((await readReviewByKey(d1, requestId, SCREENED_HEAD, false))?.id).toBe(named);
    expect((await readReviewByKey(d1, requestId, SCREENED_HEAD, true))?.id).toBe(anonymous);
    expect(await readReviewByKey(d1, requestId, "0".repeat(40), false)).toBeNull();
    expect((await readReview(d1, named))?.requestedBy).toBe(userId);
    expect((await listReviewsOfRequest(d1, requestId, 20)).map((r) => r.id)).toEqual([
      older,
      anonymous,
      named,
    ]);
    expect(await listReviewsOfRequest(d1, requestId, 2)).toHaveLength(2);
    expect(await listReviewsOfRequest(d1, requestId, 0)).toHaveLength(1);
    expect(await listReviewsOfRequest(d1, requestId, Number.NaN)).toHaveLength(1);
    expect(MAX_HISTORY_ROWS).toBe(200);
  });

  test("rowViewOf reads every state, re-parses the report, and ages a dispatched row by time", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    const { requestId } = seedScreenedRequest(db, { datasetId: "nm000482" });
    const view = async (seed: Parameters<typeof seedPublicationReview>[1]) => {
      const id = seedPublicationReview(db, { requestId, datasetId: "nm000482", ...seed });
      const row = await readReview(d1, id);
      if (!row) throw new Error("no row");
      return rowViewOf(row, Date.now());
    };
    let head = 0;
    const nextHead = () => (head++).toString(16).padStart(40, "0");
    expect(await view({ head: nextHead(), state: "dispatched", createdMinutesAgo: 59 })).toEqual({
      kind: "dispatched",
      overdue: false,
    });
    expect(await view({ head: nextHead(), state: "dispatched", createdMinutesAgo: 61 })).toEqual({
      kind: "dispatched",
      overdue: true,
    });
    expect(await view({ head: nextHead(), state: "unreported" })).toEqual({ kind: "unreported" });
    expect(await view({ head: nextHead(), state: "declined", detail: "platform_limit" })).toEqual({
      kind: "declined",
      detail: "platform_limit",
    });
    expect(await view({ head: nextHead(), state: "errored", detail: "model_refused" })).toEqual({
      kind: "errored",
      detail: "model_refused",
    });
    const h = nextHead();
    const reported = await view({
      head: h,
      state: "reported",
      report: goodPublicationReport({ evidence: evidenceFor(h) }),
    });
    expect(reported.kind).toBe("reported");
    if (reported.kind === "reported") {
      expect(reported.stored).toBe("pass");
      expect(reported.report?.evidence.head).toBe(h);
    }
    expect(
      await view({ head: nextHead(), state: "reported", rawReport: "{not json", verdict: "fail" }),
    ).toEqual({ kind: "reported", report: null, stored: "fail" });
    expect(
      await view({ head: nextHead(), state: "reported", rawReport: '{"v":2}', verdict: "pass" }),
    ).toEqual({ kind: "reported", report: null, stored: "pass" });
  });

  test("a row whose words do not read back is a review that could not run, never a pass", () => {
    const base = {
      id: 1,
      request_id: 1,
      dataset_id: "nm000483",
      head_sha: SCREENED_HEAD,
      anonymous: 0,
      requested_by: 1,
      started_by: null,
      verdict: null,
      detail: null,
      report: null,
      claimed_at: null,
      attempts: 1,
      override_by: null,
      override_at: null,
      override_reasons: null,
      created_at: "2026-10-13 00:00:00",
      decided_at: null,
    };
    const now = Date.parse("2026-10-13T00:10:00Z");
    const couldNotRun = { kind: "errored", detail: "report_invalid" };
    expect(rowViewOf(toRow({ ...base, state: "running" }), now)).toEqual(couldNotRun);
    expect(rowViewOf(toRow({ ...base, state: "declined", detail: "daily_limit" }), now)).toEqual(
      couldNotRun,
    );
    expect(rowViewOf(toRow({ ...base, state: "errored", detail: "too_large" }), now)).toEqual(
      couldNotRun,
    );
    expect(rowViewOf(toRow({ ...base, state: "dispatched" }), now)).toEqual({
      kind: "dispatched",
      overdue: false,
    });
    expect(
      rowViewOf(toRow({ ...base, state: "dispatched", created_at: "yesterday" }), now),
    ).toEqual({ kind: "dispatched", overdue: true });
    const report = JSON.stringify(parsePublicationReviewReport(goodPublicationReport()));
    expect(
      rowViewOf(toRow({ ...base, state: "reported", report, verdict: "maybe" }), now),
    ).toMatchObject({ kind: "reported", stored: "action_required" });
  });
});

describe("the helpers write what production would", () => {
  test("every screen state seeds a stored screen the gate's readers accept", () => {
    const db = freshDb();
    const states: ScreenState[] = ["pending", ...DATASET_STATUSES, "error", "unreported"];
    states.forEach((status, i) => {
      const datasetId = `nm0005${String(i).padStart(2, "0")}`;
      const { requestId } = seedScreenedRequest(db, { datasetId, status });
      const row = db
        .query(
          "SELECT identifier_screen_status AS s, identifier_screen_report AS r FROM publication_requests WHERE id = ?",
        )
        .get(requestId) as { s: string; r: string | null };
      expect(stored.readStoredState(row.s)).toBe(status);
      if (status === "pending") expect(row.r).toBeNull();
      else {
        const report = stored.readStoredReport(row.r);
        expect(report).not.toBeNull();
        expect(report?.head).toBe(
          status === "error" || status === "unreported" ? null : SCREENED_HEAD,
        );
      }
    });
  });

  test("a seeded report is the parser's output and its verdict is the one the Worker derives", () => {
    const db = freshDb();
    const { requestId } = seedScreenedRequest(db, { datasetId: "nm000484" });
    const body = goodPublicationReport({
      questions: {
        complete_and_honest: "pass",
        meets_standards: "fail",
        authors_and_license: "pass",
        name_adequate: "pass",
      },
      summary: "@someone [x](https://example.org) plain",
    });
    const id = seedPublicationReview(db, {
      requestId,
      datasetId: "nm000484",
      state: "reported",
      report: body,
    });
    const row = db
      .query("SELECT verdict, report FROM publication_reviews WHERE id = ?")
      .get(id) as {
      verdict: string;
      report: string;
    };
    const parsed = parsePublicationReviewReport(body);
    expect(row.report).toBe(JSON.stringify(parsed));
    expect(row.verdict).toBe(verdictOf(reportReasons(parsed)));
    expect(row.verdict).toBe("fail");
    expect(row.report).not.toContain("@someone");
  });

  test("a body the parser refuses throws in the test that asked for it", () => {
    expect(() => goodPublicationReport({ model: "another-model" })).toThrow();
  });
});

describe("the stored-screen readers moved without changing who can import them", () => {
  test("identifier-screen.ts re-exports the same functions", () => {
    expect(screen.readStoredState).toBe(stored.readStoredState);
    expect(screen.readStoredReport).toBe(stored.readStoredReport);
    expect(screen.isScreenExempt).toBe(stored.isScreenExempt);
  });

  test("the stored-screen module imports the shared contract and one leaf module, and nothing that can cycle", () => {
    const importsOf = (file: string) =>
      [
        ...readFileSync(join(import.meta.dir, "../src/services", file), "utf8").matchAll(
          /from "([^"]+)"/g,
        ),
      ].map((m) => m[1]);
    // The leaf is `datasetId.ts`, for the sandbox exemption; it imports nothing itself, so the
    // review can import this module without importing `identifier-screen.ts`.
    expect(importsOf("identifier-screen-stored.ts")).toEqual([
      "../../../shared/identifier-screen-report.js",
      "./datasetId.js",
    ]);
    expect(importsOf("datasetId.ts")).toEqual([]);
  });
});
