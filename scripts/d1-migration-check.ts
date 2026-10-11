#!/usr/bin/env bun
/**
 * Replay every D1 migration through REAL D1 and diff the result against
 * bun:sqlite (#1254 review; ADR 0043).
 *
 * NOT SAFE TO RUN CONCURRENTLY in one worktree: every invocation wipes and
 * rebuilds the local D1 state under backend/.wrangler/state/v3/d1, so two
 * overlapping runs race each other and fail on unrelated early migrations
 * ("no such table"). Run it sequentially; a spurious failure clears by
 * deleting that directory and rerunning.
 *
 * WHY THIS EXISTS. Every migration test in this repo runs on bun:sqlite, and
 * bun:sqlite is more permissive than the SQLite build D1 ships. Migration 0077
 * was written with one character-class GLOB per digit -- 79 characters -- which
 * bun:sqlite executes happily and D1 rejects with
 * `LIKE or GLOB pattern too complex: SQLITE_ERROR`. Every test was green and
 * the deploy would have aborted mid-file, after the ALTER had already landed.
 *
 * D1's compile-time limits found so far, both verified with
 * `wrangler d1 execute --local`:
 *   * LIKE/GLOB pattern: 50 characters (51 fails).
 *   * Compound SELECT terms: a 7-branch `UNION ALL` fails with
 *     `too many terms in compound SELECT`.
 * There are more. The point of this script is not to enumerate them but to
 * stop guessing: if D1 will not run it, this fails before a deploy does.
 *
 * WHAT IT DOES
 *   1. Wipes the local D1 state and replays every migration in order through
 *      `wrangler d1 execute --local --file`, one file at a time, so a failure
 *      names the file that broke.
 *   2. Builds the same schema with bun:sqlite and diffs the two catalogs:
 *      the object inventory (`sqlite_master` type + name) and every table's
 *      COLUMNS (`PRAGMA table_info`).
 *
 * The column comparison is deliberately structural rather than a diff of the
 * stored DDL text, because the two SQLite builds legitimately disagree about
 * that text and neither is wrong. `ALTER TABLE ... RENAME` regenerates the
 * stored `CREATE` statement, and D1's newer SQLite drops the original comments
 * and rewrites a renamed table's FK targets (`REFERENCES users_new(id)` ->
 * `REFERENCES "users"(id)`) where bun:sqlite's older one leaves both alone.
 * Migration 0026 documents that rewrite as the thing it relies on -- so a text
 * diff here would fail forever on a difference that is not a defect.
 *
 * FULL-LINE COMMENTS ARE STRIPPED before the SQL reaches wrangler, and that is
 * a workaround for wrangler, not for D1: wrangler scans the file text for
 * `BEGIN TRANSACTION` / `COMMIT` and refuses "a file containing several
 * transactions" -- including when those words appear only inside a `--`
 * comment, which is the case in 0021, 0031, 0063, 0064, 0071, 0075 and 0077.
 * Stripping only whole-line comments keeps every statement byte-identical, and
 * the schema diff in step 2 is what proves it.
 *
 * USAGE
 *   bun run migrations:d1-check
 *
 * Roughly a minute (one wrangler invocation per migration), so it is a release
 * check rather than a per-PR CI job. See AGENTS.md.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BACKEND = join(REPO_ROOT, "backend");
const MIGRATIONS_DIR = join(BACKEND, "src/db/migrations");
const WRANGLER = join(BACKEND, "node_modules/.bin/wrangler");
const CONFIG = "wrangler-sccn.toml";
const DB_NAME = "nemar-db";
const LOCAL_STATE = join(BACKEND, ".wrangler/state/v3/d1");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Drop whole-line `--` comments; every statement is left byte-identical.
 *
 * INVARIANT: no migration may contain a multi-line string literal whose
 * continuation line starts with `--`. Such a line would be stripped as a
 * comment and silently corrupt the string VALUE, and the catalog diff below
 * would not catch it -- that compares schema, not the data a migration writes.
 */
function stripFullLineComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

interface MasterRow {
  type: string;
  name: string;
}

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Objects a migration created, as `type name`.
 *
 * `sqlite_autoindex_*` are unnamed constraint indexes SQLite invents, and
 * `_cf_METADATA` / `d1_migrations` are D1's own bookkeeping tables -- none come
 * from a migration file, so none belong in a cross-engine diff.
 */
function objectInventory(rows: MasterRow[]): string[] {
  return rows
    .filter(
      (r) =>
        !r.name.startsWith("sqlite_autoindex_") &&
        r.name !== "_cf_METADATA" &&
        r.name !== "d1_migrations",
    )
    .map((r) => `${r.type} ${r.name}`)
    .sort();
}

/** One table's columns, flattened so a diff names the column that moved. */
function columnSignature(cols: ColumnRow[]): string {
  return cols
    .map((c) => `${c.name}:${c.type}:notnull=${c.notnull}:default=${c.dflt_value ?? ""}:pk=${c.pk}`)
    .join(" | ");
}

function bunSqliteCatalog(): { objects: string[]; columns: Map<string, string> } {
  const db = new Database(":memory:");
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  const master = db.query<MasterRow, []>("SELECT type, name FROM sqlite_master").all();
  const columns = new Map<string, string>();
  for (const row of master) {
    if (row.type !== "table" || row.name.startsWith("sqlite_")) continue;
    const cols = db.query<ColumnRow, []>(`PRAGMA table_info("${row.name}")`).all();
    columns.set(row.name, columnSignature(cols));
  }
  db.close();
  return { objects: objectInventory(master), columns };
}

async function wrangler(args: string[]): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn({
    cmd: [WRANGLER, "d1", ...args],
    cwd: BACKEND,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, output: `${stdout}\n${stderr}` };
}

async function main(): Promise<void> {
  if (!existsSync(WRANGLER)) {
    console.error(`wrangler not found at ${WRANGLER}. Run 'bun install' in backend/ first.`);
    process.exit(1);
  }

  console.log("Wiping local D1 state...");
  rmSync(LOCAL_STATE, { recursive: true, force: true });

  const tmp = mkdtempSync(join(tmpdir(), "nemar-d1-check-"));
  const files = migrationFiles();
  console.log(`Replaying ${files.length} migrations through real D1...`);

  for (const file of files) {
    const stripped = stripFullLineComments(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
    const path = join(tmp, file);
    writeFileSync(path, stripped);
    const res = await wrangler(["execute", DB_NAME, "-c", CONFIG, "--local", "--file", path, "-y"]);
    if (!res.ok) {
      console.error(`\nFAILED on ${file}\n`);
      console.error(res.output.trim());
      console.error(
        "\nThis SQL runs on bun:sqlite and NOT on D1. Rewrite the statement; do not " +
          "relax the check. See the header of 0077_identity_uniqueness.sql for the " +
          "GLOB-length case.",
      );
      rmSync(tmp, { recursive: true, force: true });
      process.exit(1);
    }
    process.stdout.write(".");
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log("\nAll migrations applied on real D1.");

  // Cross-engine catalog diff. A mismatch means the two SQLite builds
  // disagreed about what the same files produce.
  const bun = bunSqliteCatalog();
  const tableNames = [...bun.columns.keys()].sort();

  // One file: the object inventory, then `PRAGMA table_info` per table in a
  // fixed order, so the result sets can be zipped back to table names.
  const queryPath = join(tmpdir(), "nemar-d1-catalog.sql");
  writeFileSync(
    queryPath,
    [
      "SELECT type, name FROM sqlite_master;",
      ...tableNames.map((t) => `PRAGMA table_info("${t}");`),
    ].join("\n"),
  );
  const dump = await wrangler([
    "execute",
    DB_NAME,
    "-c",
    CONFIG,
    "--local",
    "--file",
    queryPath,
    "--json",
    "-y",
  ]);
  rmSync(queryPath, { force: true });
  if (!dump.ok) {
    console.error("Could not read the resulting D1 catalog:\n", dump.output.trim());
    process.exit(1);
  }
  // The JSON array is the part between a line that is just `[` and the last line that is just
  // `]`. `wrangler()` joins stdout and stderr, and wrangler prints a `[WARNING]` banner (with
  // ANSI colour codes) around the array when, for example, a proxy variable is set; slicing from
  // the first `[` or to the end of the text hands that banner to JSON.parse.
  const jsonStart = dump.output.search(/^\[\s*$/m);
  const jsonEnd = dump.output.search(/^\]\s*$(?![\s\S]*^\]\s*$)/m);
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    console.error(
      "Could not find the JSON catalog in wrangler's output:\n",
      dump.output.slice(0, 2000),
    );
    process.exit(1);
  }
  const resultSets = JSON.parse(dump.output.slice(jsonStart, jsonEnd + 1)) as {
    results: unknown[];
  }[];
  if (resultSets.length !== tableNames.length + 1) {
    console.error(
      `Expected ${tableNames.length + 1} result sets from D1, got ${resultSets.length}.`,
    );
    process.exit(1);
  }

  let failed = false;

  const d1Objects = objectInventory(resultSets[0].results as MasterRow[]);
  for (const o of bun.objects) {
    if (!d1Objects.includes(o)) {
      console.error(`  only in bun:sqlite: ${o}`);
      failed = true;
    }
  }
  for (const o of d1Objects) {
    if (!bun.objects.includes(o)) {
      console.error(`  only in D1: ${o}`);
      failed = true;
    }
  }

  tableNames.forEach((table, i) => {
    const d1Cols = columnSignature(resultSets[i + 1].results as ColumnRow[]);
    const bunCols = bun.columns.get(table) as string;
    if (d1Cols !== bunCols) {
      console.error(`  columns differ: ${table}\n    bun: ${bunCols}\n    d1 : ${d1Cols}`);
      failed = true;
    }
  });

  if (failed) {
    console.error("\nCatalog MISMATCH between real D1 and bun:sqlite.");
    process.exit(1);
  }
  console.log(
    `Catalog matches bun:sqlite (${bun.objects.length} objects, ${tableNames.length} tables). OK.`,
  );
}

await main();
