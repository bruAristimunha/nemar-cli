/**
 * Migrations 0117_compute_pipeline_stamps.sql (epic #2005 phase A6, #2011; ADR 0118) and
 * 0141_compute_pipeline_stamps_input.sql (portable compute, card Q0b; plan D12 and D14), on two engines:
 * bun:sqlite and Miniflare's D1, the implementation `wrangler --local` runs. bun:sqlite is more
 * permissive than the SQLite D1 ships, so a CHECK or an index proven only on the first is not proven.
 *
 * What is pinned: the states in the file are the shared words; every CHECK refuses its violating row by
 * name and accepts its valid one; the live index lets exactly one `dispatched` or `succeeded` row hold a
 * tuple (and input) while a `failed` or `refused` row never blocks a retry; attempt numbers of a tuple are
 * distinct; a failed or refused stamp always says why and the other two never carry a word; a success has
 * its job and a refusal has none; no column is named for a person; and the files' GLOB patterns are within
 * D1's 50 characters. The second migration: the input column and the three fields of what a run read, each
 * CHECK refusing its bad values; a `bids` and a `zarr` stamp of one dataset version coexist and two of the
 * same input do not; and a database that holds rows when the migration lands (a `nemar-floor-zarr` stamp, a
 * `nemar-floor` stamp of the same dataset version, a hold, a failed history) ends with them renamed and
 * their other columns untouched.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import {
  PIPELINE_LIVE_STAMP_STATES,
  PIPELINE_STAMP_STATES,
  RECIPE_INPUTS,
} from "../../shared/compute-recipes";
import { HOLD_TUPLE_SQL, TUPLE_HELD_SQL } from "../src/services/compute-pipeline";
import { type Engine, startEngines } from "./helpers/compute-engines";
import {
  MIGRATIONS_DIR,
  applyMigrations,
  migrationCall,
  migrationFiles,
} from "./helpers/miniflare-d1";

const FILE = "0117_compute_pipeline_stamps.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");
const INPUT_FILE = "0141_compute_pipeline_stamps_input.sql";
const INPUT_SQL = readFileSync(join(MIGRATIONS_DIR, INPUT_FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 100;
const next = () => ++seq;
const jobId = () => `job_${next().toString(16).padStart(24, "0")}`;

const ENGINES: Engine[] = [];
let dispose: () => Promise<void>;

beforeAll(async () => {
  const started = await startEngines();
  ENGINES.push(...started.engines);
  dispose = started.dispose;
}, 60_000);

afterAll(async () => {
  await dispose?.();
}, 30_000);

function onEveryEngine(name: string, body: (e: Engine) => Promise<void>) {
  test(name, async () => {
    expect(ENGINES).toHaveLength(2);
    for (const e of ENGINES) {
      try {
        await body(e);
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

/** A valid `dispatched` row of a tuple of its own (each case makes its own dataset id). */
function stamp(over: Row = {}): Row {
  return {
    dataset_id: `nm${String(next()).padStart(6, "0")}`,
    version: "v1.0.0",
    recipe: "nemar-floor",
    recipe_version: "1.0.0",
    engine: "eegprep@0.5.0",
    attempt: 1,
    ...over,
  };
}

async function insertStamp(e: Engine, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO compute_pipeline_stamps (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);
const UNIQUE = /UNIQUE constraint failed/;

describe("the file says the shared words", () => {
  test("the states are PIPELINE_STAMP_STATES, in its order", () => {
    const m = /CONSTRAINT compute_pipeline_stamps_state CHECK \(\s*state IN\s*\(([^)]*)\)/.exec(
      SQL,
    );
    expect([...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])).toEqual([
      ...PIPELINE_STAMP_STATES,
    ]);
  });

  test("the live index holds exactly the live states", () => {
    const m = /compute_pipeline_stamps_live[\s\S]*?WHERE state IN \(([^)]*)\)/.exec(SQL);
    expect([...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])).toEqual([
      ...PIPELINE_LIVE_STAMP_STATES,
    ]);
  });

  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    for (const text of [SQL, INPUT_SQL]) {
      const patterns = [...text.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
      expect(patterns.length).toBeGreaterThan(3);
      for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
    }
  });

  test("the table has no foreign key and nothing cascades into it", () => {
    for (const text of [SQL, INPUT_SQL]) {
      expect(text).not.toMatch(/REFERENCES/i);
      expect(text).not.toMatch(/ON DELETE/i);
    }
  });

  test("the inputs in the file are RECIPE_INPUTS, in its order", () => {
    const m = /CONSTRAINT compute_pipeline_stamps_input CHECK \(input IN \(([^)]*)\)\)/.exec(
      INPUT_SQL,
    );
    expect([...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])).toEqual([
      ...RECIPE_INPUTS,
    ]);
  });

  test("the recreated live index holds exactly the live states and names the input after the engine", () => {
    const m =
      /CREATE UNIQUE INDEX compute_pipeline_stamps_live\s+ON compute_pipeline_stamps \(([^)]*)\)\s+WHERE state IN \(([^)]*)\)/.exec(
        INPUT_SQL,
      );
    expect([...(m?.[2] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])).toEqual([
      ...PIPELINE_LIVE_STAMP_STATES,
    ]);
    expect((m?.[1] ?? "").split(",").map((c) => c.trim())).toEqual([
      "dataset_id",
      "version",
      "recipe",
      "recipe_version",
      "engine",
      "input",
    ]);
    const a =
      /CREATE UNIQUE INDEX compute_pipeline_stamps_attempt\s+ON compute_pipeline_stamps \(([^)]*)\)/.exec(
        INPUT_SQL,
      );
    expect((a?.[1] ?? "").split(",").map((c) => c.trim())).toEqual([
      "dataset_id",
      "version",
      "recipe",
      "recipe_version",
      "engine",
      "input",
      "attempt",
    ]);
  });

  test("the old name keeps its rows: the migration sets input on them and never renames a stamp (MUTATION: rename them to nemar-floor)", () => {
    const updates = [...INPUT_SQL.matchAll(/^UPDATE compute_pipeline_stamps[^;]*;/gm)].map(
      (m) => m[0],
    );
    expect(updates).toEqual([
      "UPDATE compute_pipeline_stamps SET input = 'zarr' WHERE recipe = 'nemar-floor-zarr';",
    ]);
    expect(INPUT_SQL).not.toMatch(/SET\s+recipe\s*=/);
  });

  test("the old indexes are dropped and the new ones created after the update", () => {
    const at = (needle: string) => INPUT_SQL.indexOf(needle);
    expect(at("DROP INDEX compute_pipeline_stamps_live")).toBeGreaterThan(-1);
    expect(at("DROP INDEX compute_pipeline_stamps_attempt")).toBeGreaterThan(-1);
    const update = at("UPDATE compute_pipeline_stamps SET input = 'zarr'");
    expect(update).toBeGreaterThan(at("DROP INDEX compute_pipeline_stamps_live"));
    expect(update).toBeGreaterThan(at("DROP INDEX compute_pipeline_stamps_attempt"));
    expect(at("CREATE UNIQUE INDEX compute_pipeline_stamps_live")).toBeGreaterThan(update);
    expect(at("CREATE UNIQUE INDEX compute_pipeline_stamps_attempt")).toBeGreaterThan(update);
  });
});

describe("the table", () => {
  onEveryEngine("the tuple alone is a valid row, with the defaults the design names", async (e) => {
    const row = stamp();
    expect(await insertStamp(e, row)).toBeNull();
    const [got] = await e.all<Row>(
      "SELECT * FROM compute_pipeline_stamps WHERE dataset_id = ?",
      row.dataset_id,
    );
    expect(got).toMatchObject({
      state: "dispatched",
      job_id: null,
      refusal_code: null,
      attempt: 1,
      input: "bids",
      reader: null,
      input_engine: null,
      input_digest: null,
    });
    expect(String(got?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(String(got?.updated_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  onEveryEngine("each tuple column is checked by shape and refuses what it is not", async (e) => {
    const cases: Array<[string, string, unknown[]]> = [
      [
        "compute_pipeline_stamps_dataset",
        "dataset_id",
        ["", "nm00001", "NM000001", "nm00000a", "nm0000011"],
      ],
      ["compute_pipeline_stamps_version", "version", ["", "v 1", "v1/0", "x".repeat(65)]],
      [
        "compute_pipeline_stamps_recipe",
        "recipe",
        ["", "Nemar-Floor", "nemar_floor", "x".repeat(65)],
      ],
      ["compute_pipeline_stamps_recipe_version", "recipe_version", ["", "1 0", "1/0"]],
      ["compute_pipeline_stamps_engine", "engine", ["", "eegprep 0.5", "eeg/prep", "x".repeat(65)]],
    ];
    for (const [name, column, values] of cases) {
      for (const value of values) {
        expect([column, value, await insertStamp(e, stamp({ [column]: value }))]).toEqual([
          column,
          value,
          expect.stringMatching(NAMED(name)),
        ]);
      }
    }
    // The engine takes an `@`, the version does not.
    expect(await insertStamp(e, stamp({ engine: "eegprep@0.5.0" }))).toBeNull();
    expect(await insertStamp(e, stamp({ version: "v1@0" }))).toMatch(
      NAMED("compute_pipeline_stamps_version"),
    );
  });

  onEveryEngine("the input is bids or zarr, and nothing else", async (e) => {
    for (const input of ["", "BIDS", "parquet", "bids ", "zarr1", 1]) {
      expect([input, await insertStamp(e, stamp({ input }))]).toEqual([
        input,
        expect.stringMatching(NAMED("compute_pipeline_stamps_input")),
      ]);
    }
    for (const input of RECIPE_INPUTS) {
      expect([input, await insertStamp(e, stamp({ input }))]).toEqual([input, null]);
    }
    // NOT NULL, with the default the existing rows took.
    expect(await insertStamp(e, stamp({ input: null }))).toMatch(/NOT NULL constraint failed/);
  });

  onEveryEngine(
    "what a run read is checked by shape: the reader and the engine, and the input digest",
    async (e) => {
      const sha = `sha256:${"0123456789abcdef".repeat(4)}`;
      const git = `git:${"0123456789abcdef0123456789abcdef01234567"}`;
      const words: Array<[string, string, unknown[], unknown[]]> = [
        [
          "compute_pipeline_stamps_reader",
          "reader",
          ["", "x".repeat(129), "eegprep lean", "a/b", "é", "a\nb"],
          ["eegprep-lean@0.3.1+0123456789abcdef0123456789abcdef01234567", "x".repeat(128), "a"],
        ],
        [
          "compute_pipeline_stamps_input_engine",
          "input_engine",
          ["", "x".repeat(129), "0.4 2", "0/4", "é"],
          ["0.4.2", "zarr-python@3.1.0", "x".repeat(128)],
        ],
        [
          "compute_pipeline_stamps_input_digest",
          "input_digest",
          [
            "",
            sha.toUpperCase(),
            sha.slice(1),
            `${sha}0`,
            `sha256:${"g".repeat(64)}`,
            `sha256:${"A".repeat(64)}`,
            `sha512:${"a".repeat(64)}`,
            git.slice(1),
            `${git}0`,
            `git:${"G".repeat(40)}`,
            `git:${"A".repeat(40)}`,
            `GIT:${"a".repeat(40)}`,
            `sha256:${"a".repeat(40)}`,
            `git:${"a".repeat(64)}`,
            "0123456789abcdef".repeat(4),
          ],
          [sha, git],
        ],
      ];
      for (const [name, column, bad, good] of words) {
        for (const value of bad) {
          expect([column, value, await insertStamp(e, stamp({ [column]: value }))]).toEqual([
            column,
            value,
            expect.stringMatching(NAMED(name)),
          ]);
        }
        for (const value of good) {
          expect([column, value, await insertStamp(e, stamp({ [column]: value }))]).toEqual([
            column,
            value,
            null,
          ]);
        }
        // Absent is allowed: a stamp that has not succeeded, or whose record did not say.
        expect(await insertStamp(e, stamp({ [column]: null }))).toBeNull();
      }
    },
  );

  onEveryEngine("the attempt is a whole number from 1", async (e) => {
    for (const attempt of [0, -1, 1.5, "x", 1_000_001]) {
      expect([attempt, await insertStamp(e, stamp({ attempt }))]).toEqual([
        attempt,
        expect.stringMatching(NAMED("compute_pipeline_stamps_attempt")),
      ]);
    }
  });

  onEveryEngine("the state is one of the four words", async (e) => {
    for (const state of ["done", "SUCCEEDED", "", "queued"]) {
      expect([state, await insertStamp(e, stamp({ state }))]).toEqual([
        state,
        expect.stringMatching(NAMED("compute_pipeline_stamps_state")),
      ]);
    }
  });

  onEveryEngine("the job id is job_ and 24 lowercase hex digits, or none", async (e) => {
    for (const job_id of [
      "",
      "job_",
      `job_${"a".repeat(23)}`,
      `JOB_${"a".repeat(24)}`,
      `job_${"g".repeat(24)}`,
    ]) {
      expect([job_id, await insertStamp(e, stamp({ job_id }))]).toEqual([
        job_id,
        expect.stringMatching(NAMED("compute_pipeline_stamps_job")),
      ]);
    }
    expect(await insertStamp(e, stamp({ job_id: jobId() }))).toBeNull();
  });

  onEveryEngine("the word is a fixed word: lowercase, digits and underscore", async (e) => {
    for (const refusal_code of ["", "Bad Word", "a-b", "a.b", "x".repeat(65), "é"]) {
      expect([
        refusal_code,
        await insertStamp(e, stamp({ state: "failed", refusal_code })),
      ]).toEqual([refusal_code, expect.stringMatching(NAMED("compute_pipeline_stamps_word"))]);
    }
  });

  onEveryEngine("a failed or refused stamp says why, and no other carries a word", async (e) => {
    const named = expect.stringMatching(NAMED("compute_pipeline_stamps_word_iff"));
    expect(await insertStamp(e, stamp({ state: "failed" }))).toEqual(named);
    expect(await insertStamp(e, stamp({ state: "refused" }))).toEqual(named);
    expect(await insertStamp(e, stamp({ state: "dispatched", refusal_code: "oops" }))).toEqual(
      named,
    );
    expect(
      await insertStamp(e, stamp({ state: "succeeded", job_id: jobId(), refusal_code: "oops" })),
    ).toEqual(named);
    expect(await insertStamp(e, stamp({ state: "failed", refusal_code: "no_job" }))).toBeNull();
    expect(
      await insertStamp(e, stamp({ state: "refused", refusal_code: "insufficient_balance" })),
    ).toBeNull();
  });

  onEveryEngine("a success has its job, and a refusal has none", async (e) => {
    expect(await insertStamp(e, stamp({ state: "succeeded" }))).toMatch(
      NAMED("compute_pipeline_stamps_succeeded_has_job"),
    );
    expect(await insertStamp(e, stamp({ state: "succeeded", job_id: jobId() }))).toBeNull();
    expect(
      await insertStamp(e, stamp({ state: "refused", refusal_code: "suspended", job_id: jobId() })),
    ).toMatch(NAMED("compute_pipeline_stamps_refused_has_no_job"));
    // A failed stamp may have a job (the job failed) or none (the claim was never followed).
    expect(
      await insertStamp(
        e,
        stamp({ state: "failed", refusal_code: "tapis_error", job_id: jobId() }),
      ),
    ).toBeNull();
  });
});

describe("the rule: one live or succeeded stamp per tuple", () => {
  onEveryEngine("a second dispatched or succeeded row for a tuple is refused", async (e) => {
    const t = stamp();
    expect(await insertStamp(e, t)).toBeNull();
    expect(await insertStamp(e, { ...t, attempt: 2 })).toMatch(UNIQUE);
    expect(await insertStamp(e, { ...t, attempt: 3, state: "succeeded", job_id: jobId() })).toMatch(
      UNIQUE,
    );
  });

  onEveryEngine(
    "a failed or refused attempt never blocks a retry, and history stays",
    async (e) => {
      const t = stamp();
      expect(await insertStamp(e, { ...t, state: "failed", refusal_code: "no_job" })).toBeNull();
      expect(
        await insertStamp(e, { ...t, attempt: 2, state: "refused", refusal_code: "suspended" }),
      ).toBeNull();
      expect(await insertStamp(e, { ...t, attempt: 3 })).toBeNull();
      expect(
        (await e.all("SELECT 1 FROM compute_pipeline_stamps WHERE dataset_id = ?", t.dataset_id))
          .length,
      ).toBe(3);
      // Succeeded holds the tuple as well.
      const u = stamp();
      expect(await insertStamp(e, { ...u, state: "succeeded", job_id: jobId() })).toBeNull();
      expect(await insertStamp(e, { ...u, attempt: 2 })).toMatch(UNIQUE);
    },
  );

  onEveryEngine("the rule is per tuple: any one column differing is another tuple", async (e) => {
    const t = stamp();
    expect(await insertStamp(e, t)).toBeNull();
    for (const over of [
      { version: "v1.0.1" },
      { recipe: "nemar-ica" },
      { recipe_version: "1.0.1" },
      { engine: "eegprep@0.6.0" },
      { input: "zarr" },
    ]) {
      expect([over, await insertStamp(e, { ...t, ...over })]).toEqual([over, null]);
    }
  });

  onEveryEngine(
    "a bids and a zarr stamp of one dataset version coexist, and two of one input do not (MUTATION: leave input out of the live index)",
    async (e) => {
      const t = stamp();
      expect(await insertStamp(e, { ...t, input: "bids" })).toBeNull();
      expect(await insertStamp(e, { ...t, input: "zarr" })).toBeNull();
      expect(await insertStamp(e, { ...t, input: "zarr", attempt: 2 })).toMatch(UNIQUE);
      expect(await insertStamp(e, { ...t, input: "bids", attempt: 2 })).toMatch(UNIQUE);
      expect(
        await insertStamp(e, {
          ...t,
          input: "zarr",
          attempt: 3,
          state: "succeeded",
          job_id: jobId(),
        }),
      ).toMatch(UNIQUE);
      // A failed attempt of either never blocks it, and a succeeded one blocks only its own input.
      expect(
        await insertStamp(e, {
          ...t,
          input: "zarr",
          attempt: 2,
          state: "failed",
          refusal_code: "x",
        }),
      ).toBeNull();
      const u = stamp();
      expect(
        await insertStamp(e, { ...u, input: "bids", state: "succeeded", job_id: jobId() }),
      ).toBeNull();
      expect(await insertStamp(e, { ...u, input: "zarr" })).toBeNull();
      expect(await insertStamp(e, { ...u, input: "bids", attempt: 2 })).toMatch(UNIQUE);
    },
  );

  onEveryEngine("an attempt number is used once per tuple and input", async (e) => {
    const t = stamp();
    expect(
      await insertStamp(e, { ...t, input: "bids", state: "failed", refusal_code: "no_job" }),
    ).toBeNull();
    // The other input starts at 1 too: its attempts are its own.
    expect(
      await insertStamp(e, { ...t, input: "zarr", state: "failed", refusal_code: "no_job" }),
    ).toBeNull();
    expect(
      await insertStamp(e, { ...t, input: "zarr", state: "failed", refusal_code: "no_job" }),
    ).toMatch(UNIQUE);
  });

  onEveryEngine("an attempt number of a tuple is used once, whatever became of it", async (e) => {
    const t = stamp();
    expect(await insertStamp(e, { ...t, state: "failed", refusal_code: "no_job" })).toBeNull();
    expect(await insertStamp(e, { ...t, state: "failed", refusal_code: "no_job" })).toMatch(UNIQUE);
  });

  onEveryEngine(
    "a stamp moving to succeeded meets the live index like an insert does",
    async (e) => {
      const t = stamp();
      expect(await insertStamp(e, { ...t, state: "succeeded", job_id: jobId() })).toBeNull();
      expect(
        await insertStamp(e, { ...t, attempt: 2, state: "failed", refusal_code: "x" }),
      ).toBeNull();
      expect(
        await e.run(
          "UPDATE compute_pipeline_stamps SET state = 'dispatched', refusal_code = NULL WHERE dataset_id = ? AND attempt = 2",
          t.dataset_id,
        ),
      ).toMatch(UNIQUE);
    },
  );

  onEveryEngine("the open stamps are served by a partial index", async (e) => {
    const plan = await e.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT id FROM compute_pipeline_stamps WHERE state = 'dispatched' ORDER BY updated_at LIMIT 10",
    );
    expect(plan.map((p) => p.detail).join("\n")).toContain("compute_pipeline_stamps_open");
    const partial = await e.all<{ name: string; partial: number }>(
      "SELECT name, partial FROM pragma_index_list('compute_pipeline_stamps') WHERE name IN ('compute_pipeline_stamps_open', 'compute_pipeline_stamps_live', 'compute_pipeline_stamps_job')",
    );
    expect(partial.map((p) => p.partial)).toEqual([1, 1, 1]);
  });

  onEveryEngine("no column is named for a person", async (e) => {
    const cols = (
      await e.all<{ name: string }>("SELECT name FROM pragma_table_info('compute_pipeline_stamps')")
    ).map((c) => c.name);
    expect(cols.sort()).toEqual(
      [
        "attempt",
        "created_at",
        "dataset_id",
        "engine",
        "id",
        "input",
        "input_digest",
        "input_engine",
        "job_id",
        "reader",
        "recipe",
        "recipe_version",
        "refusal_code",
        "state",
        "updated_at",
        "version",
      ].sort(),
    );
    for (const c of cols) expect(c).not.toMatch(/name|email|orcid|country|affiliation|user/i);
  });
});

// --- A database that holds rows when the migration lands -------------------------------------------------

/**
 * Both engines with every migration BEFORE 0141 applied, so a case can write rows the way the Worker wrote them
 * before inputs existed and then run the migration file as D1 would: bun:sqlite from the file's text,
 * Miniflare's D1 through the same call the other migrations reach it by.
 */
interface Pre extends Engine {
  /** Apply migration 0141 to this engine; the error text when it was refused. */
  migrate(): Promise<string | null>;
}

async function preMigrationEngines(): Promise<{ engines: Pre[]; dispose(): Promise<void> }> {
  const before = migrationFiles().filter((f) => f < INPUT_FILE);
  const db = new Database(":memory:");
  for (const f of before) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  const d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, before);
  const engines: Pre[] = [
    {
      name: "bun:sqlite",
      d1: undefined as never,
      async run(sql, ...binds) {
        try {
          db.prepare(sql).run(...(binds as never[]));
          return null;
        } catch (err) {
          return String(err);
        }
      },
      async all<T>(sql: string, ...binds: unknown[]) {
        return db.prepare(sql).all(...(binds as never[])) as T[];
      },
      async migrate() {
        try {
          db.exec(INPUT_SQL);
          return null;
        } catch (err) {
          return String(err);
        }
      },
    },
    {
      name: "Miniflare D1",
      d1,
      async run(sql, ...binds) {
        try {
          await d1
            .prepare(sql)
            .bind(...binds)
            .run();
          return null;
        } catch (err) {
          return String(err);
        }
      },
      async all<T>(sql: string, ...binds: unknown[]) {
        return (
          await d1
            .prepare(sql)
            .bind(...binds)
            .all<T>()
        ).results;
      },
      async migrate() {
        try {
          await d1.prepare(migrationCall(INPUT_SQL)).run();
          return null;
        } catch (err) {
          return String(err);
        }
      },
    },
  ];
  return { engines, dispose: () => mf.dispose() };
}

describe("migration 0141 over rows that exist", () => {
  const ROW_JOB = (n: number) => `job_${n.toString(16).padStart(24, "0")}`;
  const D = "nm000104";
  const base = (over: Row) => ({
    dataset_id: D,
    version: "v1.0.0",
    recipe: "nemar-floor",
    recipe_version: "1.0.0",
    engine: "eegprep@0.5.0",
    attempt: 1,
    ...over,
  });
  /** What the Worker wrote before inputs: no input, reader, engine or digest column. */
  const before: Row[] = [
    // The Zarr transition name, live: a runner job in flight.
    base({ recipe: "nemar-floor-zarr", state: "dispatched", job_id: ROW_JOB(1) }),
    // The same dataset version, recipe version and engine under the BIDS recipe, succeeded.
    base({ recipe: "nemar-floor", state: "succeeded", job_id: ROW_JOB(2) }),
    // Failed history of the Zarr name: attempt numbers 2 and 3 of its tuple.
    base({ recipe: "nemar-floor-zarr", attempt: 2, state: "failed", refusal_code: "no_job" }),
    base({ recipe: "nemar-floor-zarr", attempt: 3, state: "refused", refusal_code: "suspended" }),
    // A hold the Zarr name had (a result named another tuple): it holds the old name and nothing else.
    base({
      dataset_id: "nm000105",
      recipe: "nemar-floor-zarr",
      state: "failed",
      job_id: ROW_JOB(3),
      refusal_code: "tuple_mismatch",
    }),
    // A recipe the migration does not touch.
    base({ dataset_id: "nm000106", recipe: "nemar-ica", state: "dispatched", job_id: ROW_JOB(4) }),
    // A demo-era success under the Zarr name: it must not occupy the live slot of a nemar-floor Zarr run.
    base({
      dataset_id: "nm000108",
      recipe: "nemar-floor-zarr",
      state: "succeeded",
      job_id: ROW_JOB(6),
    }),
  ];

  let started: Awaited<ReturnType<typeof preMigrationEngines>>;
  beforeAll(async () => {
    started = await preMigrationEngines();
  }, 60_000);
  afterAll(async () => {
    await started?.dispose();
  }, 30_000);

  const insert = (e: Engine, row: Row) => {
    const cols = Object.keys(row);
    return e.run(
      `INSERT INTO compute_pipeline_stamps (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ...cols.map((c) => row[c]),
    );
  };

  test("a pre-migration nemar-floor-zarr row keeps its name and gets input zarr, every other column untouched (MUTATION: drop the UPDATE, or rename the rows)", async () => {
    expect(started.engines).toHaveLength(2);
    for (const e of started.engines) {
      try {
        for (const row of before) expect(await insert(e, row)).toBeNull();
        const readAll = () => e.all<Row>("SELECT * FROM compute_pipeline_stamps ORDER BY id");
        const was = await readAll();
        expect(was).toHaveLength(before.length);
        expect(was.every((r) => !("input" in r))).toBe(true);

        // The migration lands over those rows.
        expect(await e.migrate()).toBeNull();

        const now = await readAll();
        expect(now).toHaveLength(was.length);
        expect(now.map((r) => [r.recipe, r.input])).toEqual([
          ["nemar-floor-zarr", "zarr"],
          ["nemar-floor", "bids"],
          ["nemar-floor-zarr", "zarr"],
          ["nemar-floor-zarr", "zarr"],
          ["nemar-floor-zarr", "zarr"],
          ["nemar-ica", "bids"],
          ["nemar-floor-zarr", "zarr"],
        ]);
        // Nothing else moved, the recipe name included: ids, tuples, attempts, states, jobs, words and both
        // timestamps are as they were, and the new columns are empty (nothing had said what it read).
        for (const [i, row] of now.entries()) {
          const old = was[i] as Row;
          for (const c of Object.keys(old)) expect([i, c, row[c]]).toEqual([i, c, old[c]]);
          expect([row.reader, row.input_engine, row.input_digest]).toEqual([null, null, null]);
        }

        // The recreated indexes hold the rule: the succeeded BIDS stamp of nm000104 refuses a second BIDS
        // stamp of its tuple, and attempt numbers of one tuple and input are distinct.
        const t = base({});
        expect(await insert(e, { ...t, input: "bids", attempt: 9 })).toMatch(UNIQUE);
        expect(
          await insert(e, { ...t, input: "bids", attempt: 1, state: "failed", refusal_code: "x" }),
        ).toMatch(UNIQUE);
        // The old name's own tuple is held by its own live stamp, per input.
        const old = { ...t, recipe: "nemar-floor-zarr", input: "zarr" };
        expect(await insert(e, { ...old, attempt: 9 })).toMatch(UNIQUE);
        expect(await insert(e, { ...old, attempt: 3, state: "failed", refusal_code: "x" })).toMatch(
          UNIQUE,
        );
        expect(
          await insert(e, { ...old, attempt: 4, state: "failed", refusal_code: "x" }),
        ).toBeNull();
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  test("an old nemar-floor-zarr stamp, live or succeeded, does not block a nemar-floor zarr claim (MUTATION: rename the rows)", async () => {
    for (const e of started.engines) {
      // nm000104 holds a LIVE old-name stamp and a succeeded BIDS stamp; nm000108 a succeeded old-name one.
      for (const [dataset, attempt] of [
        [D, 1],
        ["nm000108", 1],
      ] as const) {
        const claim = base({ dataset_id: dataset, input: "zarr", attempt, state: "dispatched" });
        expect([e.name, dataset, await insert(e, claim)]).toEqual([e.name, dataset, null]);
        // ... and now the live slot of that nemar-floor zarr tuple is taken, as it must be.
        expect(await insert(e, { ...claim, attempt: 2 })).toMatch(UNIQUE);
      }
    }
  });

  test("a hold under the old name holds the old name only: nemar-floor is not held on either input, through the Worker's own statements", async () => {
    for (const e of started.engines) {
      const asked = async (recipe: string, input: string) =>
        (await e.all(TUPLE_HELD_SQL, recipe, "1.0.0", "eegprep@0.5.0", input)).length;
      // The row is still there, under the name it was written with, and the registry cannot ask for that name.
      expect([e.name, await asked("nemar-floor-zarr", "zarr")]).toEqual([e.name, 1]);
      expect([
        e.name,
        await asked("nemar-floor", "zarr"),
        await asked("nemar-floor", "bids"),
      ]).toEqual([e.name, 0, 0]);
      // A new hold is written for the claimed input, with the input's own next attempt number.
      const none = await e.run(
        HOLD_TUPLE_SQL,
        "nm000107",
        "v1.0.0",
        "nemar-floor",
        "1.0.0",
        "eegprep@0.5.0",
        ROW_JOB(5),
        "bids",
      );
      expect([e.name, none]).toEqual([e.name, null]);
      expect([
        e.name,
        await asked("nemar-floor", "bids"),
        await asked("nemar-floor", "zarr"),
      ]).toEqual([e.name, 1, 0]);
    }
  });
});
