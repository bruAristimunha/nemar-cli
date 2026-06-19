/**
 * Unit tests for syncCitationCounts (#804).
 *
 * Runs against a real in-memory SQLite via bun:sqlite behind a thin D1 shim
 * (no mocks — every result comes from SQLite executing the real statement).
 * Covers: match by dataset_id (catalog + legacy ds-*), skip rows not in the
 * catalog, citations_updated_at stamping, never-insert, and idempotency.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  type CitationCountRow,
  syncCitationCounts,
} from "../backend/src/services/citation-counts-sync";

// Real-engine D1 shim with batch(): forwards to bun:sqlite.
function realD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.query(sql);
      let bound: unknown[] = [];
      const api = {
        bind(...p: unknown[]) {
          bound = p;
          return api;
        },
        run() {
          const r = stmt.run(...(bound as never[]));
          return Promise.resolve({ success: true, meta: { changes: r.changes } });
        },
      };
      return api;
    },
    batch(stmts: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  } as unknown as D1Database;
}

// Minimal datasets schema with the columns 0048 adds (the migration test
// asserts the real ADD COLUMNs; this isolates the sync logic).
const SCHEMA = `
CREATE TABLE datasets (
  dataset_id TEXT NOT NULL UNIQUE,
  source_id TEXT,
  name TEXT NOT NULL,
  num_citations INTEGER NOT NULL DEFAULT 0,
  num_dataset_citations INTEGER NOT NULL DEFAULT 0,
  num_datapaper_citations INTEGER NOT NULL DEFAULT 0,
  citations_updated_at TEXT
);`;

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  for (const id of ["on005964", "nm000207", "ds007000", "ds999999"]) {
    db.query("INSERT INTO datasets (dataset_id, name) VALUES (?, ?)").run(id, `Dataset ${id}`);
  }
});

const ROWS: CitationCountRow[] = [
  {
    dataset_id: "on005964",
    num_citations: 10,
    num_dataset_citations: 3,
    num_datapaper_citations: 7,
  },
  {
    dataset_id: "nm000207",
    num_citations: 5,
    num_dataset_citations: 1,
    num_datapaper_citations: 4,
  },
  {
    dataset_id: "ds007000",
    num_citations: 8,
    num_dataset_citations: 8,
    num_datapaper_citations: 0,
  }, // legacy ds-*, matches by dataset_id
  {
    dataset_id: "ds999999",
    num_citations: 2,
    num_dataset_citations: 0,
    num_datapaper_citations: 2,
  },
  {
    dataset_id: "ds111111",
    num_citations: 99,
    num_dataset_citations: 9,
    num_datapaper_citations: 90,
  }, // not in catalog
];

function counts(id: string): Record<string, number> {
  return db
    .query(
      "SELECT num_citations, num_dataset_citations, num_datapaper_citations FROM datasets WHERE dataset_id = ?",
    )
    .get(id) as Record<string, number>;
}

describe("syncCitationCounts", () => {
  test("updates matched datasets by dataset_id; skips unknown ids", async () => {
    const res = await syncCitationCounts(realD1(db), ROWS);
    expect(res.updated).toBe(4);
    expect(res.skipped).toBe(1); // ds111111 not in catalog

    expect(counts("on005964")).toEqual({
      num_citations: 10,
      num_dataset_citations: 3,
      num_datapaper_citations: 7,
    });
    expect(counts("nm000207").num_citations).toBe(5);
    expect(counts("ds007000")).toEqual({
      num_citations: 8,
      num_dataset_citations: 8,
      num_datapaper_citations: 0,
    });
    expect(counts("ds999999").num_citations).toBe(2);
  });

  test("stamps citations_updated_at on updated rows", async () => {
    await syncCitationCounts(realD1(db), ROWS);
    const stamped = db
      .query("SELECT citations_updated_at FROM datasets WHERE dataset_id = 'on005964'")
      .get() as { citations_updated_at: string | null };
    expect(stamped.citations_updated_at).not.toBeNull();
  });

  test("never inserts a row for an unknown dataset", async () => {
    await syncCitationCounts(realD1(db), ROWS);
    const present = db.query("SELECT 1 FROM datasets WHERE dataset_id = 'ds111111'").get();
    expect(present).toBeNull();
  });

  test("is idempotent on re-run", async () => {
    await syncCitationCounts(realD1(db), ROWS);
    const res = await syncCitationCounts(realD1(db), ROWS);
    expect(res.updated).toBe(4);
    expect(counts("on005964").num_citations).toBe(10);
  });

  test("empty manifest is a no-op", async () => {
    const res = await syncCitationCounts(realD1(db), []);
    expect(res).toEqual({ updated: 0, skipped: 0 });
  });
});
