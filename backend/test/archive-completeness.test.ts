/**
 * Tests for migration 0065_archive_completeness.sql and the completeness half
 * of the /webhooks/archive-ready 'ready' path (#1041):
 *   - the new columns and their CHECK domain
 *   - deriveArchiveCompleteness, the pure payload -> columns mapping
 *   - the COALESCE semantics that stop a tally-less callback from blanking a
 *     previously-recorded completeness
 *
 * Real in-memory SQLite via bun:sqlite (no mocks); applies every migration so
 * the `datasets` table matches production. Mirrors archive-skip-migration.test.ts.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ARCHIVE_READY_UPDATE_SQL,
  deriveArchiveCompleteness,
} from "../src/routes/callbacks/archive-ready.js";
import {
  AVAILABILITY_REPORT_SWEEP_MAX,
  availabilityReportSweepCandidateQuery,
  availabilityReportSweepRemainingQuery,
} from "../src/services/availability-report.js";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  ).run();
  return db;
}

function insertDataset(db: Database, datasetId: string): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox)
     VALUES (?, 1, ?, 'public', 0)`,
  ).run(datasetId, datasetId);
}

// The route's own UPDATE (ARCHIVE_READY_UPDATE_SQL), imported rather than
// copied so the test cannot drift from what production runs.
const READY_SQL = ARCHIVE_READY_UPDATE_SQL;

interface CompletenessRow {
  archive_complete: number | null;
  archive_absent_files: number | null;
  archive_declared_files: number | null;
  archive_status: string | null;
}

function readRow(db: Database, datasetId: string): CompletenessRow {
  return db
    .prepare(
      `SELECT archive_complete, archive_absent_files, archive_declared_files, archive_status
       FROM datasets WHERE dataset_id = ?`,
    )
    .get(datasetId) as CompletenessRow;
}

describe("migration 0065: archive completeness columns", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("columns exist and default to NULL (not assessed, NOT incomplete)", () => {
    insertDataset(db, "on004624");
    const row = readRow(db, "on004624");
    expect(row.archive_complete).toBeNull();
    expect(row.archive_absent_files).toBeNull();
    expect(row.archive_declared_files).toBeNull();
  });

  test("archive_complete CHECK admits 0, 1 and NULL", () => {
    insertDataset(db, "on004624");
    for (const value of [0, 1, null]) {
      db.prepare("UPDATE datasets SET archive_complete = ? WHERE dataset_id = ?").run(
        value,
        "on004624",
      );
      expect(readRow(db, "on004624").archive_complete).toBe(value as number | null);
    }
  });

  test("archive_complete CHECK rejects a value outside the 0/1 domain", () => {
    insertDataset(db, "on004624");
    expect(() =>
      db
        .prepare("UPDATE datasets SET archive_complete = ? WHERE dataset_id = ?")
        .run(2, "on004624"),
    ).toThrow();
  });

  test("the completeness index exists", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_datasets_archive_complete");
    expect(idx).toBeTruthy();
  });
});

describe("deriveArchiveCompleteness", () => {
  test("counts present and zero -> complete", () => {
    expect(
      deriveArchiveCompleteness({
        dataset_id: "on004624",
        absent: 0,
        unreadable: 0,
        declared: 66427,
      }),
    ).toEqual({ complete: 1, absent: 0, declared: 66427, unreadable: 0, malformed: [] });
  });

  test("one absent file of 66k -> partial, not complete", () => {
    const got = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 1,
      unreadable: 0,
      declared: 66426,
    });
    expect(got.complete).toBe(0);
    expect(got.absent).toBe(1);
  });

  test("counts win over a contradictory `complete` flag", () => {
    // The flag is a convenience the workflow computes; the counts are the facts.
    const got = deriveArchiveCompleteness({
      dataset_id: "on004624",
      complete: true,
      absent: 5,
      unreadable: 0,
      declared: 100,
    });
    expect(got.complete).toBe(0);
  });

  test("a lone `complete` flag is NOT honoured without counts", () => {
    // Honouring it would write a fresh archive_complete=1 next to
    // COALESCE-preserved absent/declared counts from an older build, producing
    // a row that contradicts itself. No counts means no verdict.
    expect(
      deriveArchiveCompleteness({ dataset_id: "on004624", complete: true }).complete,
    ).toBeNull();
    expect(
      deriveArchiveCompleteness({ dataset_id: "on004624", complete: false }).complete,
    ).toBeNull();
  });

  test("an empty payload is 'not assessed', all null, nothing malformed", () => {
    expect(deriveArchiveCompleteness({ dataset_id: "on004624" })).toEqual({
      complete: null,
      absent: null,
      declared: null,
      unreadable: null,
      malformed: [],
    });
  });

  test("malformed counts are rejected rather than persisted as fact", () => {
    const got = deriveArchiveCompleteness({
      dataset_id: "on004624",
      // A payload that lost its types somewhere must not poison the columns.
      absent: "3" as unknown as number,
      unreadable: -1,
      declared: 1.5,
    });
    expect(got.absent).toBeNull();
    expect(got.unreadable).toBeNull();
    expect(got.declared).toBeNull();
    expect(got.complete).toBeNull();
  });

  test("present-but-unparseable is reported distinctly from simply absent", () => {
    // Both leave the columns null and COALESCE-preserved, so the persisted row
    // cannot distinguish them. This is the only signal that a real build's
    // tally arrived broken rather than never being sent.
    const broken = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: "3" as unknown as number,
      unreadable: -1,
      declared: 1.5,
    });
    expect(broken.malformed.sort()).toEqual(["absent", "declared", "unreadable"]);

    const skipped = deriveArchiveCompleteness({ dataset_id: "on004624" });
    expect(skipped.malformed).toEqual([]);

    // A partially broken payload names only the offending field.
    const partial = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 0,
      unreadable: 0,
      declared: Number.NaN,
    });
    expect(partial.malformed).toEqual(["declared"]);
    // The two good counts still yield a verdict; only `declared` is lost.
    expect(partial.complete).toBe(1);
    expect(partial.declared).toBeNull();
  });

  test("a partial tally (some counts missing) is flagged, not mistaken for no-tally", () => {
    // The producer emits the three counts together from one stats file, so
    // some-but-not-all means a workflow edit dropped a field. Without this
    // signal that regression reads exactly like the legitimate no-tally skip
    // path and the feature silently reports "not assessed" forever.
    const got = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 0,
      declared: 10,
    });
    expect(got.complete).toBeNull();
    expect(got.malformed).toEqual(["unreadable missing"]);
  });

  test("a mangled annexed count is flagged but does not block the verdict", () => {
    // annexed is validated with its siblings but not load-bearing: the
    // verdict derives from absent+unreadable alone.
    const got = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 0,
      unreadable: 0,
      declared: 10,
      annexed: -5,
    });
    expect(got.complete).toBe(1);
    expect(got.malformed).toEqual(["annexed"]);
  });

  test("unreadable>0 counts as not complete", () => {
    // Should be unreachable on a 'ready' callback, but if the build's
    // classification ever drifts, the archive must not read as complete.
    expect(
      deriveArchiveCompleteness({
        dataset_id: "on004624",
        absent: 0,
        unreadable: 2,
        declared: 10,
      }).complete,
    ).toBe(0);
  });
});

describe("archive-ready 'ready' UPDATE persists completeness", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    insertDataset(db, "on004624");
  });

  test("a partial build records absent and declared and flips complete to 0", () => {
    const { complete, absent, declared } = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 1,
      unreadable: 0,
      declared: 66426,
    });
    db.prepare(READY_SQL).run(20720795648, complete, absent, declared, "on004624");
    const row = readRow(db, "on004624");
    expect(row.archive_status).toBe("ready");
    expect(row.archive_complete).toBe(0);
    expect(row.archive_absent_files).toBe(1);
    expect(row.archive_declared_files).toBe(66426);
  });

  test("a tally-less callback preserves a previously recorded completeness", () => {
    // First build records a partial.
    db.prepare(READY_SQL).run(1024, 0, 7, 100, "on004624");
    // The idempotent skip path re-fires the callback with no tally: the stream
    // script never ran, so it knows nothing. It must not blank what we know.
    const { complete, absent, declared } = deriveArchiveCompleteness({ dataset_id: "on004624" });
    expect(complete).toBeNull();
    db.prepare(READY_SQL).run(1024, complete, absent, declared, "on004624");
    const row = readRow(db, "on004624");
    expect(row.archive_complete).toBe(0);
    expect(row.archive_absent_files).toBe(7);
    expect(row.archive_declared_files).toBe(100);
  });

  test("a later complete rebuild clears the partial verdict", () => {
    db.prepare(READY_SQL).run(1024, 0, 7, 100, "on004624");
    const { complete, absent, declared } = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 0,
      unreadable: 0,
      declared: 100,
    });
    db.prepare(READY_SQL).run(2048, complete, absent, declared, "on004624");
    const row = readRow(db, "on004624");
    expect(row.archive_complete).toBe(1);
    // COALESCE takes the new 0 because 0 is not NULL -- the guard is against
    // NULL specifically, not against falsy values.
    expect(row.archive_absent_files).toBe(0);
  });

  test("'ready' persists the archive_checked_at stamp on a fresh row (sweep_stamps NULL)", () => {
    // insertDataset leaves sweep_stamps NULL -- the post-0073 fresh-row
    // shape on which a missing COALESCE makes json_set return NULL and
    // silently drop the stamp, turning the row into a permanent
    // archive-sweep candidate (#1183).
    db.prepare(READY_SQL).run(1024, 1, 0, 10, "on004624");
    const row = db
      .prepare(
        "SELECT json_extract(sweep_stamps, '$.archive_checked_at') AS at FROM datasets WHERE dataset_id = ?",
      )
      .get("on004624") as { at: string | null };
    expect(row.at).not.toBeNull();
  });

  test("'ready' marks the availability report stale so the sweep regenerates it", () => {
    // json_extract(sweep_stamps, '$.availability_report_at') IS NULL is the
    // sweep's candidacy predicate (availabilityReportSweepWhere), so removing
    // the key here is the entire enqueue (#1183). Verified against the sweep's
    // own imported predicate below rather than just asserting NULL, so this
    // breaks if the sweep ever changes how it selects candidates.
    db.prepare(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.availability_report_at', ?) WHERE dataset_id = ?",
    ).run("2026-07-23 00:00:00", "on004624");
    db.prepare(READY_SQL).run(1024, 0, 3, 100, "on004624");

    const stamp = db
      .prepare(
        "SELECT json_extract(sweep_stamps, '$.availability_report_at') AS at FROM datasets WHERE dataset_id = ?",
      )
      .get("on004624") as { at: string | null };
    expect(stamp.at).toBeNull();

    // The dataset must now actually be selected by the sweep's own predicate.
    // An archived dataset has a version, which the sweep requires.
    db.prepare(
      "UPDATE datasets SET github_repo = ?, latest_version_doi = ? WHERE dataset_id = ?",
    ).run("nemarDatasets/on004624", "10.82901/nemar.on004624.v1.0.0", "on004624");
    const candidate = db.prepare(availabilityReportSweepCandidateQuery(false)).all(50) as Array<{
      dataset_id: string;
    }>;
    expect(candidate.map((r) => r.dataset_id)).toContain("on004624");
  });

  test("enqueue and drain close the loop: stale -> candidate -> stamped -> not a candidate", () => {
    // The whole point of clearing the stamp is that the daily sweep picks the
    // row up and eventually puts it back. Exercise both halves against the
    // sweep's own exported SQL so this breaks if either side changes.
    // An archived dataset has a version, which the sweep requires.
    db.prepare(
      "UPDATE datasets SET github_repo = ?, latest_version_doi = ? WHERE dataset_id = ?",
    ).run("nemarDatasets/on004624", "10.82901/nemar.on004624.v1.0.0", "on004624");
    // Already reported at some point in the past -> not a candidate.
    db.prepare(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.availability_report_at', ?) WHERE dataset_id = ?",
    ).run("2026-07-23 00:00:00", "on004624");
    const candidates = () =>
      (
        db.prepare(availabilityReportSweepCandidateQuery(false)).all(50) as Array<{
          dataset_id: string;
        }>
      ).map((r) => r.dataset_id);
    expect(candidates()).not.toContain("on004624");

    // A new archive lands -> enqueued.
    db.prepare(READY_SQL).run(1024, 0, 2, 50, "on004624");
    expect(candidates()).toContain("on004624");
    expect(
      (db.prepare(availabilityReportSweepRemainingQuery(false)).get() as { n: number }).n,
    ).toBeGreaterThan(0);

    // The sweep stamps on success -> drained, and it does not come back.
    db.prepare(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.availability_report_at', datetime('now')) WHERE dataset_id = ?",
    ).run("on004624");
    expect(candidates()).not.toContain("on004624");
  });

  test("the sweep stays bounded per invocation", () => {
    // 30 is safe only because the loop is sequential and each iteration is
    // dominated by an S3 LIST plus a manifest walk, which paces the two GitHub
    // writes per candidate. If the loop is ever parallelised, or given a fast
    // path that skips the S3 verify, that pacing disappears and this has to
    // come back down -- the bound is what stops a secondary-rate-limit burst
    // on the shared PAT.
    expect(AVAILABILITY_REPORT_SWEEP_MAX).toBe(30);
  });

  test("'ready' still clears a stale skip reason and resets the retry count", () => {
    db.prepare(
      "UPDATE datasets SET archive_skip_reason = 'too big', archive_retry_count = 3 WHERE dataset_id = ?",
    ).run("on004624");
    db.prepare(READY_SQL).run(1024, 1, 0, 10, "on004624");
    const row = db
      .prepare("SELECT archive_skip_reason, archive_retry_count FROM datasets WHERE dataset_id = ?")
      .get("on004624") as { archive_skip_reason: string | null; archive_retry_count: number };
    expect(row.archive_skip_reason).toBeNull();
    expect(row.archive_retry_count).toBe(0);
  });
});
