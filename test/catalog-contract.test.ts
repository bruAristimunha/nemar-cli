/**
 * Phase 6 contract tests (#646 / #652): nemar_catalog is dropped and `datasets`
 * is the single source of truth. The legacy ingest folds into `datasets` only,
 * with no nemar_catalog table present, and marks rows embedding_dirty=1 for the
 * scheduled re-embed. Source pins assert the flag-off code + the cache are gone.
 * Real bun:sqlite, no mocks.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importCatalogRecords } from "../backend/src/services/catalog-sync";

const ROOT = join(import.meta.dir, "..");
const MIG = join(ROOT, "backend/src/db/migrations");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function realD1(db: Database): D1Database {
  const make = (q: string) => {
    const stmt = db.query(q);
    let bound: unknown[] = [];
    const api = {
      bind(...p: unknown[]) {
        bound = p;
        return api;
      },
      run() {
        const r = stmt.run(...(bound as never[]));
        return Promise.resolve({
          success: true,
          meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
        });
      },
      first<T>() {
        return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
      },
      all<T>() {
        return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
      },
    };
    return api;
  };
  return {
    prepare: make,
    batch: (stmts: Array<{ run: () => Promise<unknown> }>) =>
      Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
}

// Schema WITHOUT nemar_catalog -- the fold must not need it after the drop.
const SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT NOT NULL UNIQUE,
  password_hash TEXT, github_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','approved','revoked')),
  email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  signup_source TEXT NOT NULL DEFAULT 'cli' CHECK (signup_source IN ('cli','web')));
CREATE TABLE datasets (id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT, owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  github_repo TEXT, concept_doi TEXT, latest_version_doi TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  enrichment_json TEXT, source TEXT, source_id TEXT, nemar_sync_status TEXT,
  subject_count INTEGER, modalities TEXT, age_min REAL, age_max REAL, file_size INTEGER,
  total_files INTEGER, tasks TEXT, FOREIGN KEY (owner_user_id) REFERENCES users(id));
CREATE TABLE catalog_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT, records_synced INTEGER DEFAULT 0, records_indexed INTEGER DEFAULT 0, errors TEXT,
  status TEXT NOT NULL DEFAULT 'running');
CREATE TABLE dataset_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL,
  version TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

// A representative excerpt of the production single-table GET /datasets list
// SELECT (routes/datasets.ts) so a regression in the alias mapping (the
// highest-risk part of #652: subject_count->participants, the COALESCE
// defaults, the sentinel source_type discriminator, COALESCE(uploader,username))
// is caught. NOT exhaustive: it intentionally omits later additive columns whose
// mapping is a plain COALESCE pass-through (e.g. license #653, the #804 citation
// counts) — assertions below use partial (toMatchObject) matching.
const LIST_SELECT = `
  SELECT d.dataset_id, d.dataset_id AS id, d.name, d.description, d.status, d.visibility,
         d.github_repo, d.concept_doi, d.concept_doi AS doi, d.created_at, d.updated_at,
         COALESCE(d.uploader, u.username) AS owner_username, d.nemar_sync_status,
         d.source, d.source_id,
         COALESCE(d.modalities, '') AS modalities,
         COALESCE(d.subject_count, 0) AS participants,
         COALESCE(d.tasks, '') AS tasks,
         COALESCE(d.authors, '') AS authors,
         COALESCE(d.file_size, 0) AS file_size,
         COALESCE(d.file_size_formatted, '') AS file_size_formatted,
         CASE WHEN d.owner_user_id = -1 THEN 'catalog' ELSE 'managed' END AS source_type,
         (
           SELECT version FROM dataset_versions dv
           WHERE dv.dataset_id = d.dataset_id
           ORDER BY created_at DESC LIMIT 1
         ) AS latest_version
  FROM datasets d
  LEFT JOIN users u ON d.owner_user_id = u.id
  WHERE d.status = 'active' AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
  ORDER BY d.dataset_id`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // 0027 adds the consolidation columns (uploader, readme, bids_version,
  // sessions_count, embedding_dirty, ...) + the sentinel user.
  db.exec(readFileSync(join(MIG, "0029_consolidation_columns_and_sentinel.sql"), "utf8"));
  // 0034 adds license_tier, which the fold INSERT now writes (#653).
  db.exec(readFileSync(join(MIG, "0034_license_tier.sql"), "utf8"));
  return db;
}

// biome-ignore lint/suspicious/noExplicitAny: minimal NemarCatalogRecord for tests
function rec(id: string): any {
  return {
    id,
    name: `Catalog ${id}`,
    created: "2022-01-01",
    uploader: "OpenNeuro",
    latestSnapshot: "1.0.0",
    publishDate: "2022-02-02",
    sessionsNum: 1,
    file_size: 100,
    byte_size_format: "100 B",
    totalFiles: 5,
    participants: 9,
    age_min: 0,
    age_max: 0,
    BIDSVersion: "1.8.0",
    License: "CC0",
    Authors: "Author",
    DatasetDOI: "doi:10/x",
    tasks: "rest",
    modalities: "eeg",
    readme: "readme",
    local_dataset: 0,
    processed: 0,
  };
}

describe("legacy ingest folds into datasets (no nemar_catalog table)", () => {
  test("importCatalogRecords folds under the sentinel owner and marks embedding_dirty", async () => {
    const db = freshDb();
    const result = await importCatalogRecords(realD1(db), [rec("ds000111")]);
    expect(result.recordsSynced).toBe(1); // counts rows folded into datasets

    const row = db
      .query("SELECT owner_user_id, embedding_dirty FROM datasets WHERE dataset_id='ds000111'")
      .get() as { owner_user_id: number; embedding_dirty: number } | null;
    expect(row?.owner_user_id).toBe(-1); // sentinel-owned folded catalog row
    expect(row?.embedding_dirty).toBe(1); // queued for the re-embed cron
  });

  test("a record colliding with an active managed dataset does NOT fold (recordsSynced=0)", async () => {
    const db = freshDb();
    db.run("INSERT INTO users (id, username, email) VALUES (10, 'alice', 'alice@example.org')");
    db.run(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility) VALUES ('ds000222','Managed',10,'active','public')",
    );
    const result = await importCatalogRecords(realD1(db), [rec("ds000222")]);
    expect(result.recordsSynced).toBe(0); // the ON CONFLICT WHERE owner=-1 guard no-ops it
    const owner = db
      .query("SELECT owner_user_id FROM datasets WHERE dataset_id='ds000222'")
      .get() as { owner_user_id: number };
    expect(owner.owner_user_id).toBe(10); // managed row + ownership untouched
  });
});

describe("single-table list query: byte-stable alias mapping", () => {
  test("managed + folded rows project the right participants/source_type/owner_username", () => {
    const db = freshDb();
    db.run("INSERT INTO users (id, username, email) VALUES (10, 'alice', 'alice@example.org')");
    // Managed row: owner=alice, subject_count -> participants, uploader NULL.
    db.run(
      `INSERT INTO datasets
         (dataset_id, name, owner_user_id, status, visibility, subject_count, modalities,
          file_size, file_size_formatted, concept_doi)
       VALUES ('nm000300','Managed EEG',10,'active','public',12,'eeg',1024,'1 KB','doi:10/m')`,
    );
    db.run("INSERT INTO dataset_versions (dataset_id, version) VALUES ('nm000300','1.0.0')");
    // Folded catalog row: sentinel owner, human name preserved in uploader.
    db.run(
      `INSERT INTO datasets
         (dataset_id, name, owner_user_id, status, visibility, subject_count, modalities, uploader)
       VALUES ('ds000400','Folded EEG',-1,'active','public',7,'emg','OpenNeuro')`,
    );

    const rows = db.query(LIST_SELECT).all() as Array<{
      id: string;
      participants: number;
      modalities: string;
      file_size_formatted: string;
      source_type: string;
      owner_username: string;
      latest_version: string | null;
    }>;
    const by = new Map(rows.map((r) => [r.id, r]));

    expect(by.get("nm000300")).toMatchObject({
      participants: 12, // d.subject_count AS participants
      modalities: "eeg",
      file_size_formatted: "1 KB",
      source_type: "managed",
      owner_username: "alice", // COALESCE(uploader, username) -> username
      latest_version: "1.0.0",
    });
    expect(by.get("ds000400")).toMatchObject({
      participants: 7,
      modalities: "emg",
      file_size_formatted: "", // COALESCE(NULL, '') default
      source_type: "catalog", // sentinel discriminator
      owner_username: "OpenNeuro", // COALESCE(uploader, ...) -> uploader
      latest_version: null,
    });
  });
});

describe("contract: the cache, the flag, and the dead writers are gone", () => {
  test("migration 0033 drops nemar_catalog", () => {
    const m = readFileSync(join(MIG, "0033_drop_nemar_catalog.sql"), "utf8");
    expect(m).toMatch(/DROP TABLE IF EXISTS nemar_catalog/i);
  });

  test("the READ_FROM_DATASETS flag plumbing is removed", () => {
    expect(existsSync(join(ROOT, "backend/src/lib/flags.ts"))).toBe(false);
    expect(read("backend/src/types/bindings.ts")).not.toContain("READ_FROM_DATASETS");
    expect(read("backend/wrangler-sccn.toml")).not.toContain("READ_FROM_DATASETS");
  });

  test("the dead catalog modules / functions are removed", () => {
    expect(existsSync(join(ROOT, "backend/src/services/catalog-from-local.ts"))).toBe(false);
    const catalogSync = read("backend/src/services/catalog-sync.ts");
    expect(catalogSync).not.toContain("syncToVectorize");
    expect(catalogSync).not.toContain("INSERT OR REPLACE INTO nemar_catalog");
    expect(read("backend/src/services/dataset-metadata-columns.ts")).not.toContain(
      "syncNemarCatalogFromEnrichment",
    );
    expect(read("backend/src/routes/admin.ts")).not.toContain("/catalog/sync-local");
  });

  test("read paths no longer reference nemar_catalog (except the permanent fallback)", () => {
    // The only surviving mention is the missing-table fallback net in datasets.ts.
    expect(read("backend/src/services/page-bundle.ts")).not.toContain("nemar_catalog");
    const searchSrc = read("backend/src/services/dataset-search.ts");
    expect(searchSrc).not.toContain("FROM nemar_catalog");
    expect(searchSrc).not.toContain('returnMetadata: "all"');
  });

  test("vectors are id-only (the reembed upsert carries empty metadata)", () => {
    expect(read("backend/src/services/dataset-search.ts")).toContain("metadata: {}");
  });
});
