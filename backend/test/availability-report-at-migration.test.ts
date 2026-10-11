/**
 * Integration test for the availability_report_at sweep stamp (epic #999
 * phase 2, #1001; storage collapsed into sweep_stamps by migration 0073,
 * #1183).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the schema matches production, then
 * asserting the backfill-sweep marker in its post-0073 home:
 *
 *   1. The stamp lives under sweep_stamps -> $.availability_report_at
 *      (the 0061 column itself is dropped by 0073).
 *   2. A fresh row (sweep_stamps NULL) reads the stamp back as NULL.
 *   3. The stamp round-trips through json_set / json_extract.
 *   4. The sweep's own candidate query (imported, not copied) selects
 *      unswept datasets; a stamped row drops out.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { availabilityReportSweepCandidateQuery } from "../src/services/availability-report";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function freshDb(): Database {
  const db = new Database(":memory:");
  for (const file of getMigrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function seedDataset(db: Database, datasetId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email, github_username, status) VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')",
  ).run();
  db.prepare(
    // A version DOI: the sweep only considers datasets that have a version.
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox, github_repo, latest_version_doi) VALUES (?, 1, ?, 'public', 0, ?, ?)",
  ).run(datasetId, datasetId, `nemarDatasets/${datasetId}`, `10.82901/nemar.${datasetId}.v1.0.0`);
}

function readStamp(db: Database, datasetId: string): string | null {
  return (
    db
      .prepare(
        "SELECT json_extract(sweep_stamps, '$.availability_report_at') AS at FROM datasets WHERE dataset_id = ?",
      )
      .get(datasetId) as { at: string | null }
  ).at;
}

describe("availability_report_at stamp (0061, collapsed by 0073)", () => {
  test("the 0061 column is collapsed into sweep_stamps", () => {
    const db = freshDb();
    const cols = tableColumns(db, "datasets");
    expect(cols).not.toContain("availability_report_at");
    expect(cols).toContain("sweep_stamps");
    db.close();
  });

  test("unpopulated datasets row reads back NULL (no sweep write yet)", () => {
    const db = freshDb();
    seedDataset(db, "nm000999");
    expect(readStamp(db, "nm000999")).toBeNull();
    db.close();
  });

  test("the stamp round-trips a stamped row", () => {
    const db = freshDb();
    seedDataset(db, "nm000132");
    db.prepare(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.availability_report_at', '2026-07-22T00:00:00Z') WHERE dataset_id = ?",
    ).run("nm000132");
    expect(readStamp(db, "nm000132")).toBe("2026-07-22T00:00:00Z");
    db.close();
  });

  test("the sweep's candidate query selects unswept datasets, stamped drops out", () => {
    const db = freshDb();
    seedDataset(db, "nm000001"); // never swept
    seedDataset(db, "nm000002"); // will be stamped
    db.prepare(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.availability_report_at', datetime('now')) WHERE dataset_id = ?",
    ).run("nm000002");
    const candidates = db.prepare(availabilityReportSweepCandidateQuery(false)).all(50) as {
      dataset_id: string;
    }[];
    expect(candidates.map((r) => r.dataset_id)).toEqual(["nm000001"]);
    db.close();
  });
});
