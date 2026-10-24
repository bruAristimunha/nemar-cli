import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { freshDb, freshDbWithForeignKeys } from "./d1";

const MIGRATIONS_DIR = join(import.meta.dir, "../../src/db/migrations");

function schema(db: Database): unknown[] {
  return db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
}

function migratedFromScratch(foreignKeys: boolean): Database {
  const db = new Database(":memory:");
  if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
  return db;
}

describe("freshDb template copies", () => {
  test("schema equals a database migrated from scratch", () => {
    expect(schema(freshDb())).toEqual(schema(migratedFromScratch(false)));
    expect(schema(freshDbWithForeignKeys())).toEqual(schema(migratedFromScratch(true)));
  });

  test("copies are writable and independent", () => {
    const a = freshDb();
    const b = freshDb();
    a.exec("CREATE TABLE scratch_t (x INTEGER)");
    a.exec("INSERT INTO scratch_t VALUES (1)");
    expect(a.query("SELECT count(*) AS n FROM scratch_t").get()).toEqual({ n: 1 });
    expect(b.query("SELECT name FROM sqlite_master WHERE name = 'scratch_t'").get()).toBeNull();
    expect(
      freshDb().query("SELECT name FROM sqlite_master WHERE name = 'scratch_t'").get(),
    ).toBeNull();
  });

  test("foreign keys are enforced on each copy and not on freshDb", () => {
    expect(freshDbWithForeignKeys().query("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(freshDbWithForeignKeys().query("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(freshDb().query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
  });
});
