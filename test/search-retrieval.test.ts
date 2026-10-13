/**
 * Search retrieval correctness (#1145, epic #1144 phase 1).
 *
 * Real bun:sqlite + the ACTUAL migrations 0031 (FTS5 external-content index)
 * and 0056 (has_hed columns). No mocks (.rules/testing.md); mirrors the
 * harness style of test/data-complete-filter.test.ts and
 * test/has-hed-filter.test.ts.
 *
 * Scope note: `executeDatasetSearch` is the extracted GET /datasets/search
 * orchestration (dataset-search.ts) -- the actual handler is a thin wrapper
 * that parses query-string params and calls it, so calling it directly here
 * exercises the real tier-selection/count/pagination logic, not a bypass of
 * it. This repo has no Miniflare/Worker-runtime harness, so the thin
 * query-string-parsing wrapper itself stays untested here (has-hed-filter.test.ts
 * and data-complete-filter.test.ts note the same boundary); passing `ai`/
 * `vectorize` as `undefined` drives the "text" (FTS-only) leg, one of the
 * five preserved `method` values reachable without those bindings (the other
 * four -- "exact_id", "semantic", "text_fallback", "unavailable" -- are
 * covered by the lower-level function tests below and, for "unavailable",
 * would need a dropped FTS table).
 *
 * IMPORTANT: a test that calls a pure function (e.g. `countSearchMatches`) in
 * a loop over a parameter that function does not accept cannot detect a
 * regression in how the CALLER derives its inputs from that parameter. The
 * count-drifts-with-page-size bug lived in `executeDatasetSearch`'s
 * orchestration (deriving the candidate window from `limit`), so the
 * regression test below drives `executeDatasetSearch` itself across `limit`,
 * not `countSearchMatches` in isolation.
 *
 * Harness gotcha (0031 is FTS5 external-content, content='datasets',
 * content_rowid='id'): the base schema must declare `datasets` with an
 * integer `id` plus all seven columns migration 0031 populates from
 * (name, description, authors, tasks, modalities, readme) BEFORE the
 * migration applies, and rows must be inserted AFTER so the AFTER INSERT
 * trigger (not the migration's one-time populate, which would see an empty
 * table) fires and keeps the index in sync.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSearchPagination } from "../backend/src/routes/datasets/catalog";
import { parseFacetFilters } from "../backend/src/services/dataset-facets";
import { buildFtsMatch } from "../backend/src/services/dataset-filters";
import {
  MAX_BOUND_PARAMS,
  SEARCH_CANDIDATE_CEILING,
  SEMANTIC_TOPK,
  assertBoundParamBudget,
  countSearchMatches,
  datasetIdListParam,
  executeDatasetSearch,
  ftsSearch,
  hydrateDatasetsByIds,
  lookupDatasetById,
} from "../backend/src/services/dataset-search";

const MIG = join(import.meta.dir, "..", "backend/src/db/migrations");
const sql = (f: string) => readFileSync(join(MIG, f), "utf8");

// Base schema: everything 0031's FTS5 populate/triggers and 0056's ALTER
// TABLE need to already exist. Columns beyond that (status/visibility/
// is_sandbox/is_exemplar/source_id/subject_count/concept_doi) are what every
// retrieval function's WHERE clause reads.
const BASE_SCHEMA = `
CREATE TABLE datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,
  source_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  authors TEXT,
  tasks TEXT,
  modalities TEXT,
  readme TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  visibility TEXT NOT NULL DEFAULT 'public',
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  is_exemplar INTEGER NOT NULL DEFAULT 0,
  subject_count INTEGER,
  concept_doi TEXT,
  -- Migration 0085. The search projections withhold a concealed deposit's
  -- reserved identifier through CONCEPT_DOI_SQL, so this hand-built schema
  -- needs the column the real one has; NOT NULL DEFAULT 0 matches production.
  anonymous INTEGER NOT NULL DEFAULT 0,
  -- lookupDatasetById orders managed rows (owner != -1, the legacy-catalog
  -- sentinel) ahead of a shadow row on a tie; every seeded row here is a
  -- normal managed row.
  owner_user_id INTEGER NOT NULL DEFAULT 10,
  embedding_dirty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT, version TEXT, doi TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

interface SeedRow {
  dataset_id: string;
  name: string;
  description?: string | null;
  modalities?: string | null;
  has_hed?: number | null;
  source_id?: string | null;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(BASE_SCHEMA);
  db.exec(sql("0031_datasets_fts.sql"));
  db.exec(sql("0056_hed_columns.sql"));
  return db;
}

function insertRow(db: Database, row: SeedRow): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, description, modalities, has_hed, source_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.dataset_id,
    row.name,
    row.description ?? null,
    row.modalities ?? null,
    row.has_hed ?? null,
    row.source_id ?? null,
  );
}

/** Minimal D1Database shim over bun:sqlite, matching the pattern used by
 *  test/license-tier.test.ts's realD1 -- a real prepared statement underneath,
 *  not a mock of query behavior. */
function realD1(db: Database): D1Database {
  return {
    prepare(q: string) {
      const stmt = db.query(q);
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
        first<T>() {
          return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
        },
        all<T>() {
          return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

// --- EEG regression fixture: 30 rows all matched by the FTS query "eeg", ---
// --- split 12/9/9 across has_hed = 1/0/NULL. -------------------------------
const HAS_HED_MATCH_COUNT = 12;
const EEG_ROW_COUNT = 30;

function eegRows(): SeedRow[] {
  return Array.from({ length: EEG_ROW_COUNT }, (_, i) => {
    const n = i + 1;
    const hasHed = n <= 12 ? 1 : n <= 21 ? 0 : null;
    return {
      dataset_id: `nm${String(100000 + n).padStart(6, "0")}`,
      name: `EEG study ${n}`,
      // Vary repetition count per row so bm25 scores are distinct (avoids
      // order ties across repeated identical queries, which would make the
      // paging test's row-for-row comparison flaky).
      description: `An EEG recording dataset. ${"eeg ".repeat((n % 6) + 1)}`,
      modalities: "eeg",
      has_hed: hasHed,
    };
  });
}

function seedEegFixture(db: Database): void {
  for (const row of eegRows()) insertRow(db, row);
}

describe("setup sanity: datasets_fts is actually populated", () => {
  test("a seeded row is found via FTS MATCH (a silently empty index would make every count test pass for the wrong reason)", () => {
    const db = freshDb();
    seedEegFixture(db);
    const match = buildFtsMatch("eeg");
    expect(match).not.toBeNull();
    const rows = db
      .query("SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?")
      .all(match as string) as Array<{ rowid: number }>;
    expect(rows.length).toBe(EEG_ROW_COUNT);
    db.close();
  });
});

describe("unavailable branch: missing datasets_fts (#1145 review C2)", () => {
  // Deliberately skips migration 0031 (no datasets_fts table at all), so
  // ftsSearch's query against it throws "no such table: datasets_fts" and
  // executeDatasetSearch's outer catch degrades to `method: "unavailable"`.
  // A reviewer replaced buildEnvelope's unavailable branch with the literal
  // pre-#1145 shape ({results: [], count: 0, method: "unavailable"} --
  // dropping min_score/offset/limit/candidate_ceiling/returned/truncated)
  // and every existing test still passed, because none of them actually
  // exercised this branch.
  function dbWithoutFtsIndex(): Database {
    const db = new Database(":memory:");
    db.exec(BASE_SCHEMA);
    db.exec(sql("0056_hed_columns.sql"));
    return db;
  }

  test("executeDatasetSearch degrades to the FULL envelope shape, not the old bare literal", async () => {
    const db = dbWithoutFtsIndex();
    insertRow(db, { dataset_id: "nm000201", name: "Some dataset", modalities: "eeg" });
    const d1 = realD1(db);
    const envelope = await executeDatasetSearch(d1, undefined, undefined, {
      query: "eeg",
      filters: {},
      limit: 20,
      offset: 0,
      minScore: 0.42,
    });
    expect(envelope.method).toBe("unavailable");
    expect(envelope.results).toEqual([]);
    expect(envelope.count).toBe(0);
    // The fields the pre-#1145 literal silently dropped.
    expect(envelope.returned).toBe(0);
    expect(envelope.offset).toBe(0);
    expect(envelope.limit).toBe(20);
    expect(envelope.candidate_ceiling).toBe(0);
    expect(envelope.truncated).toBe(false);
    expect(envelope.min_score).toBe(0.42);
    db.close();
  });
});

describe("count is stable across limit (the regression this epic fixes)", () => {
  // ai/vectorize are `undefined` throughout this describe block, which forces
  // executeDatasetSearch down the "text" (FTS-only) leg -- the same
  // orchestration path, with the same SEARCH_CANDIDATE_CEILING window and
  // countSearchMatches call, that the real handler hits whenever the Worker
  // has no AI/VECTORIZE bindings configured.
  const MIN_SCORE = 0.65;

  test("executeDatasetSearch for q=eeg&has_hed=1 reports the same count at limit 5/10/20/50/100", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);

    for (const limitRaw of ["5", "10", "20", "50", "100"]) {
      const { limit, offset } = parseSearchPagination(limitRaw, undefined);
      // This drives the actual orchestration function, not countSearchMatches
      // in isolation -- countSearchMatches has no `limit` parameter, so
      // calling it in a loop over `limit` is a tautology that cannot fail
      // against the old, broken code (see the file header comment).
      const envelope = await executeDatasetSearch(d1, undefined, undefined, {
        query: "eeg",
        filters: { hasHed: true },
        limit,
        offset,
        minScore: MIN_SCORE,
      });

      expect(envelope.method).toBe("text");
      // The fix: `count` (the true total) never moves with `limit`...
      expect(envelope.count).toBe(HAS_HED_MATCH_COUNT);
      // ...while `returned` (the page) tracks `limit`, exactly as the old,
      // buggy code conflated the two (`count: filtered.length` WAS the page
      // size). At limit=5/10 the page is smaller than the true total; from
      // limit=20 on the whole match set fits on one page.
      expect(envelope.returned).toBe(Math.min(limit, HAS_HED_MATCH_COUNT));
      expect(envelope.results.length).toBe(envelope.returned);
    }
    db.close();
  });

  // The invariant, stated directly rather than as a table of specific
  // limits, so a future filter (Phase 3/4 adds roughly a dozen more through
  // this same handler) that reintroduces a limit-derived candidate window
  // trips this immediately: count must not depend on limit at all, for a
  // query whose match set (12 rows) is bigger than the smallest page (5).
  test("count is independent of limit whenever the match set exceeds the smallest page", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const base = { query: "eeg", filters: { hasHed: true }, offset: 0, minScore: MIN_SCORE };

    const smallPage = await executeDatasetSearch(d1, undefined, undefined, { ...base, limit: 5 });
    const largePage = await executeDatasetSearch(d1, undefined, undefined, { ...base, limit: 100 });

    expect(smallPage.count).toBe(largePage.count);
    expect(smallPage.count).toBe(HAS_HED_MATCH_COUNT);
    // Sanity that the two calls actually exercised different page sizes
    // (otherwise the count-equality assertion above would be vacuous).
    expect(smallPage.returned).toBeLessThan(largePage.returned);
    db.close();
  });
});

describe("count is exact", () => {
  test("countSearchMatches equals a direct SELECT COUNT(*) over the same predicate", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const match = buildFtsMatch("eeg");

    const count = await countSearchMatches(d1, match, [], { hasHed: true });

    const direct = db
      .query(
        `SELECT COUNT(*) AS total FROM datasets d
         WHERE d.status = 'active' AND d.visibility = 'public'
           AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
           AND (d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?))
           AND d.has_hed = 1`,
      )
      .get(match as string) as { total: number };

    expect(count).toBe(direct.total);
    expect(count).toBe(HAS_HED_MATCH_COUNT);
    db.close();
  });

  test("countSearchMatches is 0 when both the FTS match and semantic ids are empty", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    // Punctuation-only query -> buildFtsMatch returns null -> no FTS disjunct.
    expect(buildFtsMatch("!!")).toBeNull();
    const count = await countSearchMatches(d1, null, [], {});
    expect(count).toBe(0);
    db.close();
  });
});

describe("countSearchMatches' semantic-id disjunct (#1145 review I8)", () => {
  // Every existing call site (in executeDatasetSearch) either passes `[]`
  // for semanticIds (text/text_fallback) or passes real ids assembled by
  // production code the tests never inspected directly. Disabling the
  // semantic-id disjunct entirely (`if (false && semanticIds.length > 0)`)
  // passed every existing test, because none of them called
  // countSearchMatches with a non-empty semanticIds array and checked a
  // hand-computed expectation.
  function seedCountFixture(db: Database): void {
    // "eeg" (as an indexed word/token) appears only in 300001/300002/300005.
    insertRow(db, {
      dataset_id: "nm300001",
      name: "EEG alpha",
      description: "eeg waves",
      modalities: "eeg",
    });
    insertRow(db, {
      dataset_id: "nm300002",
      name: "EEG beta",
      description: "eeg waves",
      modalities: "eeg",
    });
    insertRow(db, {
      dataset_id: "nm300003",
      name: "fMRI gamma",
      description: "functional imaging data",
      modalities: "func",
    });
    insertRow(db, {
      dataset_id: "nm300004",
      name: "MEG delta",
      description: "magnetic recordings",
      modalities: "meg",
    });
    insertRow(db, {
      dataset_id: "nm300005",
      name: "EEG epsilon",
      description: "eeg recording",
      modalities: "eeg",
    });
  }

  test("semantic-only ids (no FTS match): count equals the size of the (filtered) semantic id set", async () => {
    const db = freshDb();
    seedCountFixture(db);
    const d1 = realD1(db);
    // A punctuation-only query has no FTS match expression (ftsMatch=null),
    // isolating the semantic-id disjunct entirely.
    const count = await countSearchMatches(d1, null, ["nm300003", "nm300004"], {});
    expect(count).toBe(2);
    db.close();
  });

  test("FTS + semantic ids, overlapping: count is the union, not the sum", async () => {
    const db = freshDb();
    seedCountFixture(db);
    const d1 = realD1(db);
    const match = buildFtsMatch("eeg"); // matches nm300001, nm300002, nm300005
    // Semantic ids overlap one of those three (nm300001) and add one FTS
    // doesn't match (nm300003).
    const count = await countSearchMatches(d1, match, ["nm300001", "nm300003"], {});
    // Union: {nm300001, nm300002, nm300005} ∪ {nm300001, nm300003} = 4 rows,
    // NOT 3 + 2 = 5 -- proving this is OR/union semantics, not double-counting.
    expect(count).toBe(4);
    // Hand-computed ground truth via a direct SQL union count.
    const direct = db
      .query(
        `SELECT COUNT(*) AS total FROM datasets d
         WHERE d.status = 'active' AND d.visibility = 'public'
           AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
           AND (d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?)
                OR d.dataset_id IN (?, ?))`,
      )
      .get(match as string, "nm300001", "nm300003") as { total: number };
    expect(count).toBe(direct.total);
    db.close();
  });

  test("FTS + semantic ids, fully disjoint: count is the sum", async () => {
    const db = freshDb();
    seedCountFixture(db);
    const d1 = realD1(db);
    const match = buildFtsMatch("eeg"); // matches nm300001, nm300002, nm300005 (3 rows)
    const count = await countSearchMatches(d1, match, ["nm300003", "nm300004"], {});
    expect(count).toBe(5); // 3 FTS-matched + 2 disjoint semantic ids, no overlap
    db.close();
  });
});

describe("paging: page1 + page2 equals one double-width page", () => {
  // Drives executeDatasetSearch itself (ai/vectorize undefined -> "text"
  // leg), not a hand-rolled reimplementation of its fetch-then-slice logic --
  // a helper that called ftsSearch + sliced locally would test the test's own
  // arithmetic, not the production windowing/slicing it's supposed to guard.
  async function fetchPage(
    db: D1Database,
    query: string,
    limitRaw: string | undefined,
    offsetRaw: string | undefined,
  ): Promise<string[]> {
    const { limit, offset } = parseSearchPagination(limitRaw, offsetRaw);
    const envelope = await executeDatasetSearch(db, undefined, undefined, {
      query,
      filters: {},
      limit,
      offset,
      minScore: 0.65,
    });
    return envelope.results.map((r) => r.id);
  }

  test("no duplicates, no gaps, across two half-width pages vs one double-width page", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);

    const page1 = await fetchPage(d1, "eeg", "10", "0");
    const page2 = await fetchPage(d1, "eeg", "10", "10");
    const doubleWide = await fetchPage(d1, "eeg", "20", "0");

    expect(page1.length).toBe(10);
    expect(page2.length).toBe(10);
    expect(doubleWide.length).toBe(20);
    expect([...page1, ...page2]).toEqual(doubleWide);
    // No duplicates within the combined pages.
    expect(new Set([...page1, ...page2]).size).toBe(20);
    db.close();
  });

  test("paging past the true match count yields an empty page, not an error", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const page = await fetchPage(d1, "eeg", "10", "9999");
    expect(page).toEqual([]);
    db.close();
  });

  // The window-derived-from-limit regression only bites when offset > limit:
  // under the old `limit * 2` window, limit=5/offset=15 needs candidate
  // index 15..19, but the window is only 10 rows wide, so `slice(15, 20)`
  // silently returns an empty page while `count` still reports the true
  // total. limit=10/offset=10 (the test above) can't catch this: its windows
  // (20, 40 under the old bug) always cover the requested slice.
  test("deep page (offset > limit) returns the correct rows, not an empty page", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);

    const full = await fetchPage(d1, "eeg", String(EEG_ROW_COUNT), "0");
    const deep = await fetchPage(d1, "eeg", "5", "15");

    expect(deep.length).toBe(5);
    expect(deep).toEqual(full.slice(15, 20));
    db.close();
  });

  // The invariant, stated directly: for any offset strictly less than
  // `count`, and within `candidate_ceiling`, the page must not be empty.
  // That asymmetry -- a truthful, non-zero `count` alongside an empty page
  // well inside it -- is the user-visible symptom of a limit-derived window.
  test("no empty page for any offset strictly less than count, within candidate_ceiling", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const limit = 5;

    for (const offset of [0, 5, 10, 15, 20, 25, EEG_ROW_COUNT - 1]) {
      const envelope = await executeDatasetSearch(d1, undefined, undefined, {
        query: "eeg",
        filters: {},
        limit,
        offset,
        minScore: 0.65,
      });
      expect(envelope.count).toBe(EEG_ROW_COUNT);
      expect(offset).toBeLessThan(envelope.count);
      expect(envelope.results.length).toBeGreaterThan(0);
    }
    db.close();
  });
});

describe("candidate_ceiling boundary", () => {
  // A dedicated fixture bigger than SEARCH_CANDIDATE_CEILING so the true
  // total (`count`) genuinely exceeds the candidate window -- otherwise
  // "offset at the ceiling" is indistinguishable from ordinary
  // past-the-true-total paging, and the ceiling-specific behaviour (count
  // stays truthful; the page goes empty anyway because nothing past the
  // window was ever fetched) is not actually pinned.
  const BIG_ROW_COUNT = SEARCH_CANDIDATE_CEILING + 5;

  function seedBigEegFixture(db: Database): void {
    for (let i = 1; i <= BIG_ROW_COUNT; i++) {
      insertRow(db, {
        dataset_id: `nm${String(900000 + i).padStart(6, "0")}`,
        name: `EEG bulk ${i}`,
        description: "eeg",
        modalities: "eeg",
      });
    }
  }

  test("offset at and just past the ceiling: empty page, count still truthful", async () => {
    const db = freshDb();
    seedBigEegFixture(db);
    const d1 = realD1(db);
    const run = (offset: number) =>
      executeDatasetSearch(d1, undefined, undefined, {
        query: "eeg",
        filters: {},
        limit: 5,
        offset,
        minScore: 0.65,
      });

    const justInside = await run(SEARCH_CANDIDATE_CEILING - 5);
    expect(justInside.results.length).toBeGreaterThan(0);
    // Even "just inside" the pageable window, the true population (305) still
    // exceeds it (300) -- `truncated` reflects the population, not the
    // current page.
    expect(justInside.truncated).toBe(true);

    const atCeiling = await run(SEARCH_CANDIDATE_CEILING);
    expect(atCeiling.results).toEqual([]);
    expect(atCeiling.returned).toBe(0);
    // count is exact (countSearchMatches has no window), so it stays
    // truthful -- and bigger than candidate_ceiling -- even though the page
    // fetched from the (capped) candidate window is empty.
    expect(atCeiling.count).toBe(BIG_ROW_COUNT);
    expect(atCeiling.count).toBeGreaterThan(SEARCH_CANDIDATE_CEILING);
    // candidate_ceiling (#1145 review S6) is the ACTUAL candidate pool this
    // response drew from (lexical.length), capped at the SQL LIMIT -- here
    // that's exactly SEARCH_CANDIDATE_CEILING, since the true match count
    // (305) exceeds it.
    expect(atCeiling.candidate_ceiling).toBe(SEARCH_CANDIDATE_CEILING);
    expect(atCeiling.truncated).toBe(true);

    const pastCeiling = await run(SEARCH_CANDIDATE_CEILING + 10);
    expect(pastCeiling.results).toEqual([]);
    expect(pastCeiling.count).toBe(BIG_ROW_COUNT);
    expect(pastCeiling.truncated).toBe(true);
    db.close();
  });
});

describe("envelope fields reflect the actual call (#1145 review I9)", () => {
  // Existing assertions elsewhere in this file read `results`/`returned`/
  // `count`, which are derived from the closure's `offset`/`limit` variables
  // during slicing -- they would still be numerically correct even if the
  // literal `offset`/`limit`/`candidate_ceiling`/`min_score` FIELDS on the
  // returned envelope were hardcoded to something else entirely. Nothing
  // else in this file reads those fields directly, so this is the one place
  // that would catch that.
  test("offset/limit/min_score/candidate_ceiling/truncated on the envelope match the call, not a hardcoded literal", async () => {
    const db = freshDb();
    seedEegFixture(db); // 30 real matches, well under any ceiling
    const d1 = realD1(db);
    const envelope = await executeDatasetSearch(d1, undefined, undefined, {
      query: "eeg",
      filters: {},
      limit: 7,
      offset: 3,
      minScore: 0.42,
    });

    expect(envelope.offset).toBe(3);
    expect(envelope.limit).toBe(7);
    expect(envelope.min_score).toBe(0.42);
    // candidate_ceiling is the actual pool size (S6): with only 30 true
    // matches (well under SEARCH_CANDIDATE_CEILING), it is 30, not 300.
    expect(envelope.candidate_ceiling).toBe(EEG_ROW_COUNT);
    expect(envelope.count).toBe(EEG_ROW_COUNT);
    expect(envelope.truncated).toBe(false);
    expect(envelope.returned).toBe(7);
    expect(envelope.results).toHaveLength(7);
    db.close();
  });
});

describe("parseSearchPagination clamping", () => {
  test("limit: negative, zero, non-numeric, huge, and absent", () => {
    expect(parseSearchPagination("-5", undefined).limit).toBe(1);
    expect(parseSearchPagination("0", undefined).limit).toBe(1);
    expect(parseSearchPagination("abc", undefined).limit).toBe(20);
    expect(parseSearchPagination("99999", undefined).limit).toBe(100);
    expect(parseSearchPagination(undefined, undefined).limit).toBe(20);
  });

  test("offset: negative, non-numeric, and absent", () => {
    expect(parseSearchPagination(undefined, "-1").offset).toBe(0);
    expect(parseSearchPagination(undefined, "abc").offset).toBe(0);
    expect(parseSearchPagination(undefined, undefined).offset).toBe(0);
  });

  test("valid limit/offset pass through clamped to their own bounds only", () => {
    expect(parseSearchPagination("42", "7")).toEqual({ limit: 42, offset: 7 });
    expect(parseSearchPagination("100", "0")).toEqual({ limit: 100, offset: 0 });
  });

  // Regression fixed by this phase: the old inline parse did
  // `Math.min(Number.parseInt(limit || "20", 10), 100)` with no lower bound
  // and no NaN guard, so `limit=-5` fell through to `results.slice(0, -5)`
  // (silently dropping the last five rows) and `limit=abc` produced
  // `slice(0, NaN)` (an empty list either way).
  test("negative and NaN limits no longer produce slice(0, negative) or slice(0, NaN)", () => {
    const negative = parseSearchPagination("-5", undefined);
    expect(negative.limit).toBeGreaterThan(0);
    const nan = parseSearchPagination("abc", undefined);
    expect(Number.isNaN(nan.limit)).toBe(false);
  });
});

// Real modality vocabulary from the catalog (#1145 plan). Includes the
// substring collision (`ieeg` contains `eeg`) that #1145 deliberately carried
// over from the old JS `.includes()` and that #1711 then removed.
const MODALITY_VOCAB = [
  "eeg",
  "anat",
  "ieeg",
  "beh",
  "meg",
  "func",
  "nirs",
  "fmap",
  "emg",
  "dwi",
  "motion",
  "perf",
];

describe("SQL modality filter matches a whole modality token (#1711)", () => {
  const rowId = (i: number) => `nm${String(200000 + i).padStart(6, "0")}`;
  const allIds = MODALITY_VOCAB.map((_, i) => rowId(i));

  function seedModalityFixture(db: Database): void {
    MODALITY_VOCAB.forEach((mod, i) => {
      insertRow(db, { dataset_id: rowId(i), name: `${mod} dataset`, modalities: mod });
    });
  }

  // Each fixture row carries ONE modality, so a whole-token match for a filter
  // term is exactly the row whose modality equals it. Written as that
  // equality, not as the SQL under test: the old `.includes()` oracle here
  // pinned the bug, and an oracle that mirrors the implementation can only
  // ever agree with it.
  const tokenMatch = (filterMod: string): Set<string> =>
    new Set(
      MODALITY_VOCAB.map((rowMod, i) => ({ rowMod, i }))
        .filter(({ rowMod }) => rowMod === filterMod.toLowerCase())
        .map(({ i }) => rowId(i)),
    );

  test("every filter term across the vocabulary returns exactly the rows holding that token", async () => {
    const db = freshDb();
    seedModalityFixture(db);
    const d1 = realD1(db);

    for (const filterMod of MODALITY_VOCAB) {
      // Exercise via hydrateDatasetsByIds, the same SQL-filtering path the
      // search endpoint's semantic/exact-id tiers use.
      const hydrated = await hydrateDatasetsByIds(d1, allIds, { modality: filterMod });
      expect(new Set(hydrated.map((r) => r.id))).toEqual(tokenMatch(filterMod));
      expect(hydrated).toHaveLength(1);
    }
    db.close();
  });

  test("eeg no longer returns the ieeg row, and ieeg does not return the eeg row", async () => {
    const db = freshDb();
    seedModalityFixture(db);
    const d1 = realD1(db);
    const eeg = await hydrateDatasetsByIds(d1, allIds, { modality: "eeg" });
    // Row 0 is "eeg" itself; row 2 is "ieeg", which holds no eeg token.
    expect(eeg.map((r) => r.id)).toEqual([rowId(0)]);
    const ieeg = await hydrateDatasetsByIds(d1, allIds, { modality: "ieeg" });
    expect(ieeg.map((r) => r.id)).toEqual([rowId(2)]);
    db.close();
  });
});

describe("hasHed excludes both 0 and NULL through the search retrieval path", () => {
  test("ftsSearch with { hasHed: true } returns only has_hed = 1 rows", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const results = await ftsSearch(d1, "eeg", SEARCH_CANDIDATE_CEILING, { hasHed: true });
    expect(results.length).toBe(HAS_HED_MATCH_COUNT);
    for (const r of results) {
      expect(r.has_hed).toBe(1);
    }
    db.close();
  });

  test("ftsSearch with no hasHed filter returns every matching row (has_hed 1, 0, and NULL)", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const results = await ftsSearch(d1, "eeg", SEARCH_CANDIDATE_CEILING, {});
    expect(results.length).toBe(EEG_ROW_COUNT);
    db.close();
  });
});

describe("exact-id tier respects filters (#1145 behaviour change)", () => {
  function seedExactIdFixture(db: Database): void {
    insertRow(db, { dataset_id: "nm000111", name: "MEG study", modalities: "meg" });
  }

  test("lookupDatasetById returns the hit when it matches the filter", async () => {
    const db = freshDb();
    seedExactIdFixture(db);
    const d1 = realD1(db);
    const hit = await lookupDatasetById(d1, "nm000111", { modality: "meg" });
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe("nm000111");
    db.close();
  });

  test("lookupDatasetById returns null when the hit fails the filter", async () => {
    const db = freshDb();
    seedExactIdFixture(db);
    const d1 = realD1(db);
    const hit = await lookupDatasetById(d1, "nm000111", { modality: "eeg" });
    expect(hit).toBeNull();
    db.close();
  });

  test("lookupDatasetById with no filters still finds the row (unfiltered behaviour unchanged)", async () => {
    const db = freshDb();
    seedExactIdFixture(db);
    const d1 = realD1(db);
    const hit = await lookupDatasetById(d1, "nm000111", {});
    expect(hit).not.toBeNull();
    db.close();
  });

  test("lookupDatasetById respects hasHed too", async () => {
    const db = freshDb();
    db.query(
      "INSERT INTO datasets (dataset_id, name, modalities, has_hed) VALUES (?, ?, ?, ?)",
    ).run("nm000112", "HED-annotated study", "eeg", 1);
    const d1 = realD1(db);
    expect((await lookupDatasetById(d1, "nm000112", { hasHed: true }))?.id).toBe("nm000112");
    expect(await lookupDatasetById(d1, "nm000112", { hasHed: false })).not.toBeNull();
    db.close();
  });
});

describe("exact-id tier through executeDatasetSearch (#1145 review C1)", () => {
  // The block above drives lookupDatasetById directly, which only proves the
  // SQL clause is correct in isolation. A reviewer dropped `filters` from the
  // executeDatasetSearch call site -- reintroducing the real pre-#1145 bug --
  // and every test in this file still passed (34/0), because none of them
  // drove the exact-id tier through the actual orchestration. This is the
  // third instance of the same root cause (count, paging, now exact-id):
  // testing the callee instead of the caller that derives its inputs.
  function seedExactIdFixture(db: Database): void {
    insertRow(db, { dataset_id: "nm000111", name: "MEG study", modalities: "meg" });
  }

  test("exact id hit matching the filter: method exact_id, count 1", async () => {
    const db = freshDb();
    seedExactIdFixture(db);
    const d1 = realD1(db);
    const envelope = await executeDatasetSearch(d1, undefined, undefined, {
      query: "nm000111",
      filters: { modality: "meg" },
      limit: 20,
      offset: 0,
      minScore: 0.65,
    });
    expect(envelope.method).toBe("exact_id");
    expect(envelope.count).toBe(1);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.results[0]?.id).toBe("nm000111");
    db.close();
  });

  test("exact id hit failing the filter falls through to the text tier, not an empty exact_id envelope", async () => {
    const db = freshDb();
    seedExactIdFixture(db);
    const d1 = realD1(db);
    const envelope = await executeDatasetSearch(d1, undefined, undefined, {
      query: "nm000111",
      filters: { modality: "eeg" },
      limit: 20,
      offset: 0,
      minScore: 0.65,
    });
    // The id hit fails the modality filter, so it falls through instead of
    // short-circuiting under `exact_id`. "nm000111" isn't indexed text (no
    // seeded row's name/description/etc. contains that literal token), so the
    // FTS tier this falls through to genuinely finds nothing -- a real,
    // empty text search, not a leftover exact_id envelope wearing a different
    // method label.
    expect(envelope.method).toBe("text");
    expect(envelope.count).toBe(0);
    expect(envelope.results).toEqual([]);
    db.close();
  });
});

describe("search stays within D1's bound-parameter ceiling (#1193)", () => {
  // The semantic leg used to bind one parameter per id, so a text search sat
  // at ~SEMANTIC_TOPK parameters before any filter and a single facet pushed
  // it over D1's limit: every faceted text search 500'd in production while
  // the catalog-list path (no semantic leg) kept working. The ids now travel
  // as ONE json_each parameter, so the count no longer scales with
  // SEMANTIC_TOPK.
  test("a full semantic leg costs exactly one bound parameter", () => {
    const ids = Array.from({ length: SEMANTIC_TOPK }, (_, i) => `on${String(i).padStart(6, "0")}`);
    const params = [datasetIdListParam(ids)];
    expect(params).toHaveLength(1);
    expect(JSON.parse(params[0] as string)).toHaveLength(SEMANTIC_TOPK);
  });

  // The regression test proper: drive the REAL query builder with a full
  // semantic leg AND facet filters, the combination that 500'd in production.
  // Binding the ids one-per-parameter overflows D1's ceiling here, so this
  // fails if the json_each collapse is ever undone. It calls
  // countSearchMatches directly (not executeDatasetSearch) because the defect
  // lives in how THAT function binds its own inputs, and because the semantic
  // leg comes from Vectorize, which no local test can populate -- which is
  // precisely why nothing caught #1193.
  test("a full semantic leg plus facet filters stays within the ceiling", async () => {
    const db = realD1(freshDb());
    const ids = Array.from({ length: SEMANTIC_TOPK }, (_, i) => `on${String(i).padStart(6, "0")}`);
    // `subjects` alone is enough to prove it: with the ids bound one-per-id
    // this statement carries SEMANTIC_TOPK + 1 fts + 2 range params, past the
    // ceiling; with json_each it carries four. (Only facets whose columns
    // exist in BASE_SCHEMA can be used here.)
    const facets = parseFacetFilters((k) => (k === "subjects" ? "50..100" : undefined));
    expect(Object.keys(facets).length).toBeGreaterThan(0);
    await expect(countSearchMatches(db, "sleep", ids, { facets })).resolves.toBeGreaterThanOrEqual(
      0,
    );
  });

  // Second of the three converted sites. countSearchMatches is covered above;
  // this covers the one that hydrates the rows users actually see, so a
  // regression in just this site cannot ship green (#1195 review I4).
  test("hydrateDatasetsByIds carries a full semantic leg within the ceiling", async () => {
    const db = realD1(freshDb());
    const ids = Array.from({ length: SEMANTIC_TOPK }, (_, i) => `on${String(i).padStart(6, "0")}`);
    const facets = parseFacetFilters((k) => (k === "subjects" ? "50..100" : undefined));
    await expect(hydrateDatasetsByIds(db, ids, { facets })).resolves.toEqual([]);
  });

  // The third converted site, countWidenedWithBreakdown, is deliberately NOT
  // covered here and cannot be with the current seams: it is module-private,
  // and its only caller (computeExcludedUnknownCount) wraps it in try/catch to
  // degrade the excluded_unknown diff rather than fail the search. So a
  // parameter-count regression there would be SWALLOWED, not surfaced --
  // stated rather than left for the next reader to discover.

  test("assertBoundParamBudget throws before D1 would", () => {
    expect(() => assertBoundParamBudget(new Array(MAX_BOUND_PARAMS).fill(0), "ok")).not.toThrow();
    expect(() => assertBoundParamBudget(new Array(MAX_BOUND_PARAMS + 1).fill(0), "over")).toThrow(
      /exceeds D1's limit/,
    );
  });

  test("SEMANTIC_TOPK is positive", () => {
    expect(SEMANTIC_TOPK).toBeGreaterThan(0);
  });

  test("SEARCH_CANDIDATE_CEILING is a positive, sane SQL LIMIT", () => {
    expect(SEARCH_CANDIDATE_CEILING).toBeGreaterThan(0);
  });
});
