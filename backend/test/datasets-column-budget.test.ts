/**
 * The datasets column budget (#1182).
 *
 * D1 caps a table at 100 columns; local SQLite allows 2000, so no local run
 * can ever reproduce the cap that blocked every deploy when
 * 0071_signal_defaults (now 0072) failed to apply in production. This
 * numeric pin IS the tripwire: the next migration that widens `datasets`
 * past the ceiling fails here, in CI, instead of at deploy time.
 *
 * The exact-count pin (=== 81) is deliberate alongside the ceiling (<= 97):
 * an unexpected column count in EITHER direction means a migration changed
 * the table shape without this file being updated to acknowledge it. Raise
 * the pin consciously with each widening migration; never past the ceiling.
 * The ceiling sits at 97, not 99, to keep headroom for an emergency ALTER
 * on a table that is expensive to rebuild.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { freshDb } from "./helpers/d1";

let db: Database;

beforeAll(() => {
  db = freshDb();
});

describe("datasets column budget", () => {
  test("exactly 84 columns after all migrations", () => {
    // 92 after 0072; 0073 collapses the 12 sweep stamps into one
    // sweep_stamps JSON column (#1183): 92 + 1 - 12 = 81. 0085 adds
    // first_published_at and anonymous (#1407): 81 + 2 = 83. Neither is
    // derivable at read time -- see the migration header for why the
    // obvious substitute (concept_doi IS NULL) is unsound. 0088 adds
    // data_papers (ADR 0077): 83 + 1 = 84, a judge verdict from an external
    // pipeline that nothing in this database can recompute.
    const count = db.query("SELECT COUNT(*) AS n FROM pragma_table_info('datasets')").get() as {
      n: number;
    };
    expect(count.n).toBe(84);
  });

  test("data_papers is a nullable TEXT column that only accepts valid JSON", () => {
    const col = db
      .query(
        "SELECT type, \"notnull\" AS required FROM pragma_table_info('datasets') WHERE name = 'data_papers'",
      )
      .get() as { type: string; required: number } | null;
    expect(col).toEqual({ type: "TEXT", required: 0 });
    db.run(
      "INSERT INTO datasets (dataset_id, owner_user_id, name, data_papers) VALUES ('nm088001', -1, 'ok', '[]')",
    );
    expect(() =>
      db.run(
        "INSERT INTO datasets (dataset_id, owner_user_id, name, data_papers) VALUES ('nm088002', -1, 'bad', 'not json')",
      ),
    ).toThrow();
  });

  test("stays under the 97-column ceiling (D1 hard cap is 100)", () => {
    const count = db.query("SELECT COUNT(*) AS n FROM pragma_table_info('datasets')").get() as {
      n: number;
    };
    expect(count.n).toBeLessThanOrEqual(97);
  });

  test("index set is exactly the 23 after 0085", () => {
    const names = (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'datasets' AND sql IS NOT NULL ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([
      "idx_datasets_anonymous",
      "idx_datasets_archive_complete",
      "idx_datasets_archive_status",
      "idx_datasets_data_complete",
      "idx_datasets_electrode_system",
      "idx_datasets_embedding_dirty",
      "idx_datasets_has_hed",
      "idx_datasets_id",
      "idx_datasets_is_exemplar",
      "idx_datasets_license_tier",
      "idx_datasets_modalities",
      "idx_datasets_n_channels",
      "idx_datasets_owner",
      "idx_datasets_publish_date",
      "idx_datasets_records_status",
      "idx_datasets_sandbox",
      "idx_datasets_source_id",
      "idx_datasets_status",
      "idx_datasets_subject_count",
      "idx_datasets_visibility",
      "idx_datasets_zarr_failed_at",
      "idx_datasets_zarr_status",
      "idx_datasets_zenodo_concept",
    ]);
  });

  test("trigger set is exactly the 7 after 0145", () => {
    const names = (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'datasets' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([
      // 0085 adds the two that refuse `anonymous = 1` on a dataset that has
      // ever been published. The invariant is in the database on purpose:
      // a rule that lives only in a service is one a future route can forget.
      "datasets_anonymous_unpublished_ai",
      "datasets_anonymous_unpublished_au",
      "datasets_embed_dirty_au",
      // 0145: a visibility or status change marks the vector stale.
      "datasets_embed_dirty_visibility_au",
      "datasets_fts_ad",
      "datasets_fts_ai",
      "datasets_fts_au",
    ]);
  });
});
