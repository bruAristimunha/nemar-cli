/**
 * Integration test for migration 0099_pr_review_edit_limit.sql (ADR 0107, decision 4).
 *
 * Real engines, no mocks. Every migration BEFORE 0099 is applied, then `pr_reviews` is seeded at the
 * 0098 schema with a row in every state and every reason word it can hold today (a running review
 * claimed and not, each verdict, a decline for each of its three words, each run error, an
 * unreported one), with a gap left by a hard delete and a sequence ahead of the highest surviving
 * id. Then 0099 is applied and the table is compared with what was there before.
 *
 * The migration is a table REBUILD (SQLite cannot alter a CHECK), so the property that matters
 * most is the boring one: nothing about an existing review changes. A dropped column, a reordered
 * copy or a lost index would all leave every other test in the suite green, because `freshDb()`
 * builds an empty table and never sees a row cross the rebuild.
 *
 * TWO ENGINES, FOR TWO DIFFERENT QUESTIONS, as `private-sessions-migration.test.ts` does for 0089.
 *   * bun:sqlite, with 0099 applied ONE STATEMENT AT A TIME. bun's multi-statement `exec()` returns
 *     without throwing when a statement fails and runs the rest, so feeding it the whole file would
 *     let a failing guard be ignored and a DROP run anyway. One statement at a time is also the
 *     shape a runner that is NOT transactional would give the file, which is exactly what the guard
 *     is for: it must stop the DROP by itself, with no rollback to lean on.
 *   * Miniflare's D1, the implementation `wrangler --local` runs, with the file in one call, the way
 *     a migration reaches D1. There a failing guard aborts the call and everything rolls back.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { DECLINE_REASONS, RUN_ERRORS } from "../../shared/pr-review";
import {
  MIGRATIONS_DIR,
  applyMigrations,
  migrationCall,
  migrationFiles,
} from "./helpers/miniflare-d1";

const TARGET = "0099_pr_review_edit_limit.sql";
const TARGET_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8");
const BEFORE_TARGET = migrationFiles().filter((f) => f < TARGET);

/** The file's statements, in order. Full-line comments dropped first (0099 has no inline ones and
 *  no semicolon inside a statement, which the count test below pins). */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A row the old table never had, slipped into the copy. */
const EXTRA_ROW =
  "INSERT INTO pr_reviews_new (dataset_id, pr_number, head_sha, author_id, author_login, state) VALUES ('nm000999', 1, 'sha-extra', 1, 'x', 'dispatched');";

/** Insert `extra` immediately before the first guard statement. */
function withInjection(sql: string, extra: string): string {
  const marker = "INSERT INTO _rebuild_guard";
  const at = sql.indexOf(marker);
  if (at < 0) throw new Error("no guard statement to inject before");
  return `${sql.slice(0, at)}${extra}\n${sql.slice(at)}`;
}

/** Apply 0099 (or a variant) statement by statement; throws on the first failure. */
function applyByStatement(db: Database, sql = TARGET_SQL): void {
  for (const statement of statements(sql)) db.run(statement);
}

function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of BEFORE_TARGET) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

// --------------------------------------------------------------------------
// Seeding, shared by both engines as plain SQL
// --------------------------------------------------------------------------

type Cell = string | number | null;

interface Shape {
  sha: string;
  state: string;
  verdict?: string | null;
  detail?: string | null;
  nonce?: string | null;
  report?: string | null;
  claimed?: boolean;
  published?: boolean;
  attempts?: number;
  fork?: number;
  assoc?: string | null;
}

const STORED = '{"v":2,"stage":"full"}';

const SHAPES: Shape[] = [
  // A review handed to GitHub, not claimed yet, and one a job has claimed.
  { sha: "h-dispatched", state: "dispatched", nonce: "n-1" },
  { sha: "h-claimed", state: "dispatched", nonce: "n-2", claimed: true, attempts: 2 },
  // Removed below, so the ids have a gap where it was.
  { sha: "h-gap", state: "dispatched", nonce: "n-4" },
  // A result of each verdict, published and not.
  {
    sha: "h-pass",
    state: "reported",
    verdict: "pass",
    report: STORED,
    claimed: true,
    published: true,
  },
  { sha: "h-fail", state: "reported", verdict: "fail", report: STORED, claimed: true, attempts: 3 },
  { sha: "h-uncertain", state: "reported", verdict: "uncertain", report: STORED, claimed: true },
  // A decline for each of the three words a declined row can hold.
  ...(["contributor_paused", "rate_limited", "daily_limit"] as const).map((detail) => ({
    sha: `h-declined-${detail}`,
    state: "declined",
    detail,
    published: true,
    fork: 1,
    assoc: "NONE",
  })),
  // An errored row for every run error the table accepted before this file.
  ...RUN_ERRORS.filter((word) => word !== "edit_limit").map((detail, i) => ({
    sha: `h-errored-${detail}`,
    state: "errored",
    detail,
    claimed: i % 2 === 0,
    attempts: 1 + (i % 3),
  })),
  // The watchdog gave up and kept the nonce, so a late report is still accepted.
  { sha: "h-unreported", state: "unreported", nonce: "n-3", claimed: true },
  // Removed below: two tail rows, so the AUTOINCREMENT sequence sits ahead of the highest surviving
  // id and the reseed is observable.
  { sha: "h-tail-1", state: "dispatched", nonce: "n-5" },
  { sha: "h-tail-2", state: "dispatched", nonce: "n-6" },
];

function lit(value: Cell): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value}'`;
}

function seedStatements(): string[] {
  const rows = SHAPES.map((shape, i) => {
    const day = String((i % 27) + 1).padStart(2, "0");
    const when = `2026-10-${day} 09:00:00`;
    // Every column is set explicitly, defaults included, so a copy that fell back to a default
    // instead of the stored value is visible.
    const values: Cell[] = [
      `nm0004${String(60 + (i % 3))}`,
      i + 1,
      shape.sha,
      500 + (i % 5),
      `author-${i % 5}`,
      shape.assoc === undefined ? "COLLABORATOR" : shape.assoc,
      shape.fork ?? 0,
      shape.state,
      shape.verdict ?? null,
      shape.detail ?? null,
      shape.nonce ?? null,
      shape.report ?? null,
      100 + i,
      200 + (i % 3),
      shape.claimed ? `2026-10-${day} 09:01:00` : null,
      shape.published ? `2026-10-${day} 09:05:00` : null,
      i % 4,
      when,
      `2026-10-${day} 09:30:00.123`,
      shape.state === "dispatched" ? null : `2026-10-${day} 09:04:00`,
      shape.attempts ?? 1,
    ];
    return `INSERT INTO pr_reviews
       (dataset_id, pr_number, head_sha, author_id, author_login, author_association, from_fork,
        state, verdict, detail, nonce, report, check_run_id, comment_id, claimed_at, published_at,
        publish_attempts, created_at, seen_at, decided_at, attempts)
     VALUES (${values.map(lit).join(", ")})`;
  });
  return [...rows, "DELETE FROM pr_reviews WHERE head_sha IN ('h-gap', 'h-tail-1', 'h-tail-2')"];
}

const SURVIVORS = SHAPES.length - 3;

// --------------------------------------------------------------------------
// Catalog readers
// --------------------------------------------------------------------------

function allRows(db: Database): Record<string, unknown>[] {
  // `prepare`, not `query`: `query` caches the statement, and a cached `SELECT *` keeps the column
  // names it was first prepared with, so a read before the rebuild would hide the new column after it.
  const statement = db.prepare("SELECT * FROM pr_reviews ORDER BY id");
  try {
    return statement.all() as Record<string, unknown>[];
  } finally {
    statement.finalize();
  }
}

/** A row without the column this migration adds. */
function withoutNewColumn(row: Record<string, unknown>): Record<string, unknown> {
  const { edit_restarts: _count, ...rest } = row;
  return rest;
}

function columns(db: Database, table: string): unknown[] {
  return db.query(`PRAGMA table_info(${table})`).all();
}

function storedSql(db: Database, name: string): string | null {
  return (
    db
      .query<{ sql: string | null }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name)?.sql ?? null
  );
}

/** Every index on a table as SQLite describes it: name, unique, origin, partial, and each one's
 *  full column list (`index_xinfo`). */
function indexes(db: Database, table: string) {
  const list = db
    .query<{ name: string; unique: number; origin: string; partial: number }, []>(
      `PRAGMA index_list(${table})`,
    )
    .all()
    .map(({ name, unique, origin, partial }) => ({
      name,
      unique,
      origin,
      partial,
      columns: db.query(`PRAGMA index_xinfo(${name})`).all(),
    }));
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function sequence(db: Database): number | null {
  return (
    db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'pr_reviews'").get()
      ?.seq ?? null
  );
}

interface Snapshot {
  rows: Record<string, unknown>[];
  columns: unknown[];
  indexes: ReturnType<typeof indexes>;
  indexSql: Record<string, string | null>;
  sequence: number | null;
  maxId: number;
}

function snapshot(db: Database): Snapshot {
  const idx = indexes(db, "pr_reviews");
  return {
    rows: allRows(db),
    columns: columns(db, "pr_reviews"),
    indexes: idx,
    indexSql: Object.fromEntries(idx.map((i) => [i.name, storedSql(db, i.name)])),
    sequence: sequence(db),
    maxId: db.query<{ m: number }, []>("SELECT MAX(id) AS m FROM pr_reviews").get()?.m ?? 0,
  };
}

function seeded(): Database {
  const db = dbBeforeTarget();
  for (const statement of seedStatements()) db.run(statement);
  return db;
}

function migrated(): { db: Database; before: Snapshot } {
  const db = seeded();
  const before = snapshot(db);
  // D1 enforces foreign keys, so the rebuild runs with them on here too: the DROP and RENAME must
  // hold up under the same rules production applies.
  db.run("PRAGMA foreign_keys = ON");
  applyByStatement(db);
  return { db, before };
}

/** A row to insert after the rebuild, with only what the table requires and a state. */
function insertRow(
  db: Database,
  sha: string,
  state: string,
  detail: string | null,
  restarts?: number,
): void {
  const cols = restarts === undefined ? "" : ", edit_restarts";
  const vals = restarts === undefined ? "" : ", ?";
  db.run(
    `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state, detail${cols})
     VALUES ('nm000460', 900, ?, 1, 'a', ?, ?${vals})`,
    restarts === undefined ? [sha, state, detail] : [sha, state, detail, restarts],
  );
}

// --------------------------------------------------------------------------
// bun:sqlite, one statement at a time
// --------------------------------------------------------------------------

describe("migration 0099: the file itself", () => {
  test("the splitter sees every statement, so the per-statement runs below run all of it", () => {
    expect(statements(TARGET_SQL)).toHaveLength(12);
  });

  test("the seed holds a row of every kind the table can hold before this file", () => {
    const db = seeded();
    const states = db.query("SELECT DISTINCT state FROM pr_reviews").all();
    expect(states).toHaveLength(5);
    const words = db
      .query<{ detail: string }, []>(
        "SELECT DISTINCT detail FROM pr_reviews WHERE detail IS NOT NULL",
      )
      .all()
      .map((r) => r.detail)
      .sort();
    expect(words).toEqual(
      [...DECLINE_REASONS, ...RUN_ERRORS].filter((w) => w !== "edit_limit").sort(),
    );
  });
});

describe("migration 0099: the rebuild changes no existing review", () => {
  test("every row survives with every column value, ids included, and a count of 0", () => {
    const { db, before } = migrated();
    expect(before.rows).toHaveLength(SURVIVORS);
    const after = allRows(db);
    expect(after.map(withoutNewColumn)).toEqual(before.rows);
    // None of them was ever restarted by an edit, which is what 0 says.
    expect(after.map((r) => r.edit_restarts)).toEqual(before.rows.map(() => 0));
  });

  test("the columns keep their order, types, defaults and nullability, and the new one is last", () => {
    const { db, before } = migrated();
    const after = columns(db, "pr_reviews") as { cid: number; name: string }[];
    expect(after.slice(0, -1)).toEqual(before.columns as typeof after);
    expect(after.at(-1)).toMatchObject({
      cid: after.length - 1,
      name: "edit_restarts",
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
      pk: 0,
    });
  });

  test("the table is still AUTOINCREMENT, with the same key and constraints", () => {
    const { db } = migrated();
    const sql = storedSql(db, "pr_reviews") ?? "";
    expect(sql).toMatch(/id INTEGER PRIMARY KEY AUTOINCREMENT/);
    expect(sql).toMatch(/UNIQUE \(dataset_id, pr_number, head_sha\)/);
    expect(sql).toMatch(/attempts INTEGER NOT NULL DEFAULT 1 CHECK \(attempts >= 1\)/);
  });

  test("every index survives, identical in shape and stored SQL, and none is added", () => {
    // `index_list` (unique, origin, partial) and `index_xinfo` (every column, key or not, with its
    // collation and order) for each index, plus the stored CREATE text byte for byte.
    const { db, before } = migrated();
    const after = snapshot(db);
    expect(after.indexes).toEqual(before.indexes);
    for (const [name, sql] of Object.entries(before.indexSql)) {
      expect({ name, sql: after.indexSql[name] }).toEqual({ name, sql });
    }
    expect(before.indexes.map((i) => i.name)).toEqual([
      "idx_pr_reviews_author",
      "idx_pr_reviews_pr",
      "idx_pr_reviews_state",
      "sqlite_autoindex_pr_reviews_1",
    ]);
  });

  test("the sequence is reseeded at the highest surviving id, so a new row's id is above every copied one", () => {
    const { db, before } = migrated();
    // The seed left the sequence three ahead of the surviving rows (the gap and two tail rows)...
    expect(before.sequence).toBe(before.maxId + 2);
    // ...and the copy reseeds it at the highest copied id.
    expect(sequence(db)).toBe(before.maxId);
    insertRow(db, "h-new", "dispatched", null);
    const fresh = db
      .query<{ id: number }, []>("SELECT id FROM pr_reviews WHERE head_sha = 'h-new'")
      .get();
    expect(fresh?.id).toBe(before.maxId + 1);
    expect(fresh?.id).toBeGreaterThan(Math.max(...before.rows.map((r) => Number(r.id))));
  });

  test("the commit's key is still unique", () => {
    const { db } = migrated();
    expect(() => insertRow(db, "h-pass", "dispatched", null)).not.toThrow();
    const dup = db
      .query("SELECT dataset_id, pr_number, head_sha FROM pr_reviews LIMIT 1")
      .get() as {
      dataset_id: string;
      pr_number: number;
      head_sha: string;
    };
    expect(() =>
      db.run(
        "INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state) VALUES (?, ?, ?, 1, 'a', 'dispatched')",
        [dup.dataset_id, dup.pr_number, dup.head_sha],
      ),
    ).toThrow(/UNIQUE/);
  });

  test("nothing else names the table: only it and its indexes carry its name", () => {
    const { db } = migrated();
    const named = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE sql LIKE '%pr_reviews%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(named).toEqual([
      "idx_pr_reviews_author",
      "idx_pr_reviews_pr",
      "idx_pr_reviews_state",
      "pr_reviews",
    ]);
    expect(db.query("PRAGMA foreign_key_list(pr_reviews)").all()).toEqual([]);
  });

  test("the scratch objects are gone", () => {
    const { db } = migrated();
    const leftovers = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name IN ('pr_reviews_new', '_rebuild_guard')",
      )
      .all();
    expect(leftovers).toEqual([]);
  });
});

describe("migration 0099: the guard stops the DROP on its own", () => {
  // No transaction to fall back on here: each statement lands as it runs, the way a
  // non-transactional runner would apply the file.
  for (const [what, injection] of [
    ["short (a row missing)", "DELETE FROM pr_reviews_new WHERE head_sha = 'h-fail';"],
    [
      "altered (same count, one value changed)",
      "UPDATE pr_reviews_new SET attempts = 9 WHERE head_sha = 'h-fail';",
    ],
    [
      "altered (a NULL made a value)",
      "UPDATE pr_reviews_new SET claimed_at = '2026-10-01 00:00:00' WHERE head_sha = 'h-dispatched';",
    ],
    // The third direction: a row the old table never had. Only the count and the new-EXCEPT-old row
    // see it, so this is what keeps those two honest.
    ["padded (an extra row)", EXTRA_ROW],
  ] as const) {
    test(`a copy that is ${what} fails the guard before the DROP`, () => {
      const db = seeded();
      const before = allRows(db);
      db.run("PRAGMA foreign_keys = ON");
      expect(() => applyByStatement(db, withInjection(TARGET_SQL, injection))).toThrow(
        /CHECK constraint failed/,
      );
      // The live table was never dropped, and every row in it is as it was.
      expect(allRows(db)).toEqual(before);
      expect(storedSql(db, "pr_reviews_new")).not.toBeNull();
    });
  }
});

describe("migration 0099: the guard compares every column it copies", () => {
  // One alteration per column of the old table, so a guard that leaves any one out of its
  // comparison lets that column be damaged by the copy and still pass. The columns come from the
  // table the migration builds, and the one it adds (`edit_restarts`, which the old table has no
  // value for) is the only one left out.
  const copied = (
    migrated().db.query("PRAGMA table_info(pr_reviews)").all() as {
      name: string;
      type: string;
    }[]
  ).filter((c) => c.name !== "edit_restarts");

  /** Where an alteration of a column is made and what it makes, when the plain one would be refused
   *  by a constraint of the table itself (which would stop the file for a reason that is not the guard). */
  const SPECIAL: Record<string, { set: string; where: string }> = {
    id: { set: "id = id + 1000", where: "head_sha = 'h-pass'" },
    from_fork: { set: "from_fork = 1 - from_fork", where: "head_sha = 'h-pass'" },
    state: { set: "state = 'unreported'", where: "head_sha = 'h-dispatched'" },
    verdict: { set: "verdict = 'fail'", where: "head_sha = 'h-pass'" },
    detail: { set: "detail = 'too_large'", where: "head_sha = 'h-errored-stale_head'" },
  };

  /** The statement that changes one column of one copied row, and nothing else. */
  function alteration({ name, type }: { name: string; type: string }): string {
    const { set, where } = SPECIAL[name] ?? {
      set:
        type === "INTEGER"
          ? `${name} = COALESCE(${name}, 0) + 1`
          : `${name} = COALESCE(${name}, '') || 'x'`,
      where: "head_sha = 'h-pass'",
    };
    return `UPDATE pr_reviews_new SET ${set} WHERE ${where};`;
  }

  test("the columns are the 21 the old table had and `attempts`, and none is skipped", () => {
    expect(copied).toHaveLength(22);
    expect(copied.map((c) => c.name)).toContain("report");
    expect(copied.map((c) => c.name)).toContain("attempts");
  });

  for (const column of copied) {
    test(`a copy altered in ${column.name} fails the guard itself, before the DROP`, () => {
      const db = seeded();
      const before = allRows(db);
      db.run("PRAGMA foreign_keys = ON");
      // The guard's own CHECK (`ok = 1`), not a constraint of the new table, which the altered
      // value does not break: the file has to stop at the comparison.
      expect(() => applyByStatement(db, withInjection(TARGET_SQL, alteration(column)))).toThrow(
        /CHECK constraint failed: ok = 1/,
      );
      expect(allRows(db)).toEqual(before);
      expect(storedSql(db, "pr_reviews_new")).not.toBeNull();
    });
  }
});

describe("migration 0099: the new word and the new count", () => {
  test("an errored row can hold edit_limit, with a count", () => {
    const { db } = migrated();
    expect(() => insertRow(db, "h-edit-limit", "errored", "edit_limit", 5)).not.toThrow();
    const row = db
      .query<{ state: string; detail: string; edit_restarts: number }, []>(
        "SELECT state, detail, edit_restarts FROM pr_reviews WHERE head_sha = 'h-edit-limit'",
      )
      .get();
    expect(row).toEqual({ state: "errored", detail: "edit_limit", edit_restarts: 5 });
  });

  test("no other kind of row can hold it: a declined, a dispatched, a reported or an unreported one", () => {
    const { db } = migrated();
    // `edit_limit` is not a declined word, so the table's own CHECK on declined rows refuses it.
    expect(() => insertRow(db, "h-x1", "declined", "edit_limit")).toThrow(/CHECK/);
    // A reason exists exactly when the row was declined or errored.
    expect(() => insertRow(db, "h-x2", "dispatched", "edit_limit")).toThrow(/CHECK/);
    expect(() => insertRow(db, "h-x3", "unreported", "edit_limit")).toThrow(/CHECK/);
    expect(() =>
      db.run(
        `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state, verdict, detail, report)
         VALUES ('nm000460', 901, 'h-x4', 1, 'a', 'reported', 'pass', 'edit_limit', '{}')`,
      ),
    ).toThrow(/CHECK/);
  });

  test("a word that is in no list is still refused, and every earlier word is still accepted", () => {
    const { db } = migrated();
    expect(() => insertRow(db, "h-bogus", "errored", "not_a_word")).toThrow(/CHECK/);
    for (const [i, word] of RUN_ERRORS.entries()) {
      expect(() => insertRow(db, `h-run-${i}`, "errored", word), word).not.toThrow();
    }
    for (const [i, word] of DECLINE_REASONS.entries()) {
      expect(() => insertRow(db, `h-decline-${i}`, "declined", word), word).not.toThrow();
    }
  });

  test("a count below zero is refused, and an unspecified count is 0", () => {
    const { db } = migrated();
    expect(() => insertRow(db, "h-neg", "errored", "edit_limit", -1)).toThrow(/CHECK/);
    insertRow(db, "h-default", "dispatched", null);
    const row = db
      .query<{ edit_restarts: number }, []>(
        "SELECT edit_restarts FROM pr_reviews WHERE head_sha = 'h-default'",
      )
      .get();
    expect(row?.edit_restarts).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Miniflare D1, the file in one call
// --------------------------------------------------------------------------

describe("migration 0099 on Miniflare D1", () => {
  let mf: Miniflare;

  /** A fresh database per test, migrated to 0098 and seeded. */
  let counter = 0;
  async function seededD1(): Promise<D1Database> {
    counter += 1;
    const d1 = (await mf.getD1Database(`DB${counter}`)) as unknown as D1Database;
    await applyMigrations(d1, BEFORE_TARGET);
    for (const statement of seedStatements()) await d1.prepare(statement).run();
    return d1;
  }

  async function rows(d1: D1Database): Promise<unknown[]> {
    return (await d1.prepare("SELECT * FROM pr_reviews ORDER BY id").all()).results;
  }

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
      compatibilityDate: "2024-12-01",
      // One fresh database per test below.
      d1Databases: ["DB1", "DB2", "DB3", "DB4"],
    });
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  for (const [what, injection] of [
    ["a short", "DELETE FROM pr_reviews_new WHERE head_sha = 'h-fail';"],
    ["an altered", "UPDATE pr_reviews_new SET attempts = 9 WHERE head_sha = 'h-fail';"],
    ["a padded", EXTRA_ROW],
  ] as const) {
    test(`${what} copy fails the file with the guard's CHECK, and pr_reviews is untouched`, async () => {
      const d1 = await seededD1();
      const before = await rows(d1);
      await expect(
        d1.prepare(migrationCall(withInjection(TARGET_SQL, injection))).run(),
      ).rejects.toThrow(/CHECK constraint failed/);
      expect(await rows(d1)).toEqual(before);
      // The whole call rolled back: not even the scratch tables remain.
      const scratch = await d1
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('pr_reviews_new', '_rebuild_guard')",
        )
        .all();
      expect(scratch.results).toEqual([]);
    });
  }

  test("the unaltered file applies, every row survives with a count of 0, and the new word is accepted", async () => {
    const d1 = await seededD1();
    const before = (await rows(d1)) as Record<string, unknown>[];
    expect(before).toHaveLength(SURVIVORS);
    await d1.prepare(migrationCall(TARGET_SQL)).run();
    const after = (await rows(d1)) as Record<string, unknown>[];
    expect(after.map(withoutNewColumn)).toEqual(before);
    expect(after.every((r) => r.edit_restarts === 0)).toBe(true);
    // The word and the count work in D1 itself, not only in bun:sqlite.
    await d1
      .prepare(
        `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state, detail, edit_restarts)
         VALUES ('nm000460', 900, 'h-d1', 1, 'a', 'errored', 'edit_limit', 5)`,
      )
      .run();
    await expect(
      d1
        .prepare(
          `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state, detail)
           VALUES ('nm000460', 901, 'h-d1-declined', 1, 'a', 'declined', 'edit_limit')`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
