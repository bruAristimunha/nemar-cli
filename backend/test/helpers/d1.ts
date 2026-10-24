// Shared real-engine test DB helpers for backend unit tests (#904).
//
// `freshDb()` applies every migration in order to an in-memory bun:sqlite
// database, so tests run against the production schema. `realD1()` is a
// thin D1-shaped passthrough over that database: not a mock — no canned
// responses; every result comes from SQLite executing the production SQL.
// Mirrors the per-file copies in hed-write.test.ts and the CLI package test/catalog-dual-write.test.ts
// (extracting those to this helper is deliberately out of scope for #904).

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../../src/db/migrations");

function migrate(db: Database): Database {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

// Migrating a database costs ~43 ms (every migration is re-read and re-run), and a suite calls
// the helpers below hundreds of times. The migrated schema is built once per process, lazily, and
// every call gets its own independent copy deserialized from those bytes (~0.04 ms). The result is
// the same production schema, not a stand-in: a copy is a real, writable SQLite database.
let template: Uint8Array | undefined;
let templateWithForeignKeys: Uint8Array | undefined;

export function freshDb(): Database {
  template ??= migrate(new Database(":memory:")).serialize();
  return Database.deserialize(template);
}

/**
 * {@link freshDb} with foreign keys ENFORCED while the migrations run and afterwards, as D1 does.
 * The difference is visible in the schema: SQLite rewrites the `REFERENCES` clauses of child
 * tables when a parent is renamed only if foreign keys are on at that moment, so migration 0026's
 * rename of `users_new` leaves every child pointing at a table that no longer exists in the
 * default `freshDb()` (and any write to one then fails), and converges to `users(id)` here, as it
 * does in D1 (probed on Miniflare). For a test of what a foreign key refuses.
 */
export function freshDbWithForeignKeys(): Database {
  if (!templateWithForeignKeys) {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    templateWithForeignKeys = migrate(db).serialize();
  }
  // The pragma is a connection setting, not part of the serialized bytes.
  const db = Database.deserialize(templateWithForeignKeys);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function realD1(db: Database): D1Database {
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
        // Internal-only: what `batch()` below actually calls. Not part of
        // the public D1PreparedStatement surface, so it is not typed on the
        // return value -- `batch()` reaches it directly on this closure.
        __execForBatch() {
          // Real D1 runs every statement in a batch as if `.all()` had been
          // called on it (Cloudflare's own documented behavior), REGARDLESS
          // of whether the statement is a read or a write -- a `D1Result`
          // always carries `results` (rows, empty for a write with no
          // RETURNING clause) alongside `meta`. bun:sqlite's `.all()` on an
          // INSERT/UPDATE/DELETE executes it exactly once (same as `.run()`
          // would) and simply returns `[]`; calling `.run()` afterward would
          // be a SECOND execution and must never happen. `changes()` /
          // `last_insert_rowid()` are read as a follow-up SQL query on the
          // same connection -- both reflect the statement that just ran,
          // for a write or a read alike, so this works uniformly for every
          // statement in a batch, not just the ones this test suite happens
          // to put first.
          const results = stmt.all(...(bound as never[]));
          const meta = db
            .query("SELECT changes() AS changes, last_insert_rowid() AS last_row_id")
            .get() as { changes: number; last_row_id: number };
          return {
            success: true,
            results,
            meta: { changes: meta.changes, last_row_id: meta.last_row_id },
          };
        },
      };
      return api;
    },
    // D1 batch = one implicit transaction; mirror that so route code using
    // db.batch() (e.g. relinkIdentity, #913; the device-auth mint pair,
    // #1281) keeps its all-or-nothing semantics AND its read-back semantics
    // (a SELECT queued alongside a write sees that write's row) under this
    // passthrough too.
    async batch(stmts: { __execForBatch(): unknown }[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of stmts) results.push(s.__execForBatch());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

/**
 * Wrap a D1 so `before(sql, binds)` runs, and is awaited, ahead of every
 * statement executes; `binds` are the values the statement was bound with, so
 * a fault can be aimed at one row's statement and not at every row's. Statements
 * built by the wrapper keep `__execForBatch`, so `batch()` still works through it.
 */
export function wrapD1(
  d1: D1Database,
  before: (sql: string, binds: readonly unknown[]) => void | Promise<void>,
): D1Database {
  return {
    prepare(sql: string) {
      const inner = d1.prepare(sql) as unknown as {
        bind(...p: unknown[]): unknown;
        run(): Promise<unknown>;
        first(): Promise<unknown>;
        all(): Promise<unknown>;
        __execForBatch(): unknown;
      };
      let binds: readonly unknown[] = [];
      const api = {
        bind(...p: unknown[]) {
          binds = p;
          inner.bind(...p);
          return api;
        },
        async run() {
          await before(sql, binds);
          return inner.run();
        },
        async first() {
          await before(sql, binds);
          return inner.first();
        },
        async all() {
          await before(sql, binds);
          return inner.all();
        },
        __execForBatch() {
          return inner.__execForBatch();
        },
      };
      return api;
    },
    batch: (stmts: unknown[]) => (d1 as unknown as { batch(s: unknown[]): unknown }).batch(stmts),
  } as unknown as D1Database;
}

/**
 * A D1 whose every statement waits a macrotask before it runs.
 *
 * `realD1` executes each statement synchronously, so two requests started
 * together run one after the other and a read-then-write that is NOT atomic
 * still appears to be. Real D1 is a network round trip per statement, so
 * concurrent requests interleave BETWEEN a route's statements. Yielding here
 * puts that gap back: a test that races two requests through this wrapper
 * fails for a non-atomic claim, which the synchronous shim cannot show.
 */
export function yieldingD1(d1: D1Database): D1Database {
  return wrapD1(d1, () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/**
 * A D1 that runs `hook(sql)` before each statement, to land another writer
 * exactly between a route's read and its write (a request that gets published
 * after the route read it, or a claim another clicker takes). The hook writes
 * through the real database, so the interleaving is real, only deterministic.
 */
export function interceptingD1(
  d1: D1Database,
  hook: (sql: string, binds: readonly unknown[]) => void | Promise<void>,
): D1Database {
  return wrapD1(d1, hook);
}
