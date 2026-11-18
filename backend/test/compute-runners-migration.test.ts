/**
 * Migration 0140_compute_runners.sql (portable compute, card DM-05; decisions D1, D2, D5 and D6), on two
 * engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation `wrangler
 * --local` runs. bun:sqlite is more permissive than the SQLite D1 ships, so a CHECK or an index proven
 * only on the first is not proven. Both carry every real migration; nothing is stood in for.
 *
 * What is pinned: every fixed-word IN list of the file equals the list `shared/compute-state.ts` and
 * `shared/contract/compute-runner.ts` declare (a word added there fails here until it is added to the
 * file); each CHECK of the two new tables refuses a bad value by its own name; a revoked registration
 * stores its reason and time together or not at all; a live name is unique and a revoked name is free;
 * the secret's hash is unique; the job table's twelve new columns exist with their defaults, a Tapis job
 * is always `su`, only a runner job names a runner, a backend or an `none` accounting, and a row of the
 * previous shape is still a valid row; the partial index serves the waiting runner jobs and only a query
 * that states its predicate; no column is named for a person; and the file's GLOB patterns are within
 * D1's 50 characters and it touches nothing it did not say.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTE_ACCOUNTING, COMPUTE_EXECUTORS, RUNNER_BACKENDS } from "../../shared/compute-state";
import { COMPUTE_POOLS } from "../../shared/contract/compute";
import { RUNNER_ARCHES, RUNNER_RUNTIMES, RUNNER_TRUST } from "../../shared/contract/compute-runner";
import { runnerEndStatements, runnerRevokeStatements } from "../src/services/compute-runners";
import { type Engine, startEngines } from "./helpers/compute-engines";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0140_compute_runners.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 40_000;
const next = () => ++seq;
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
const runnerId = () => `rnr_${hex(next(), 24)}`;
const jobId = () => `job_${hex(next(), 24)}`;
const hash64 = () => hex(next(), 64);

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

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);

function runner(over: Row = {}): Row {
  const n = next();
  return {
    id: runnerId(),
    name: `lab_${n}`,
    pool: "cpu",
    cores: 8,
    memory_mb: 32_000,
    gpus: 0,
    scratch_gb: 100,
    backend: "local",
    runtimes: '["docker"]',
    arch: "amd64",
    accounting: "none",
    site: "lab_a",
    trust: "lab",
    secret_hash: hash64(),
    registered_by: 1,
    ...over,
  };
}

async function insert(e: Engine, table: string, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

const insertRunner = (e: Engine, over: Row = {}) => insert(e, "compute_runners", runner(over));

function job(over: Row = {}): Row {
  return {
    id: jobId(),
    source: "cli",
    kind: "batch",
    app_id: "nemar-launch",
    app_version: "1.0.0",
    spec_digest: hash64(),
    partition: "shared",
    pool: "cpu",
    nodes: 1,
    cores_per_node: 4,
    minutes: 60,
    ...over,
  };
}

/** A runner job: only NEMAR's own pipeline jobs are run by a runner. */
const RUNNER_JOB = { executor: "runner", source: "pipeline" };

const insertJob = (e: Engine, over: Row = {}) => insert(e, "compute_jobs", job(over));

/** The words of an `IN (...)` list that follows `column` in the file, in order. */
function inList(column: string, from = 0): string[] {
  const re = new RegExp(`${column} IN \\(([^)]*)\\)`, "g");
  re.lastIndex = from;
  const m = re.exec(SQL);
  if (!m) throw new Error(`no IN list for ${column}`);
  return [...(m[1] as string).matchAll(/'([^']*)'/g)].map((x) => x[1] as string);
}

describe("the words", () => {
  test("every IN list of the file is the declared list, in order", () => {
    const table = SQL.slice(SQL.indexOf("CREATE TABLE compute_runners"));
    const at = (needle: string) => SQL.indexOf(needle, SQL.indexOf("CREATE TABLE compute_runners"));
    expect(inList("pool", at("pool TEXT"))).toEqual([...COMPUTE_POOLS]);
    expect(inList("backend", at("backend TEXT"))).toEqual([...RUNNER_BACKENDS]);
    expect(inList("arch", at("arch TEXT"))).toEqual([...RUNNER_ARCHES]);
    expect(inList("accounting", at("accounting TEXT"))).toEqual([...COMPUTE_ACCOUNTING]);
    expect(inList("trust", at("trust TEXT"))).toEqual([...RUNNER_TRUST]);
    expect(inList("executor", at("ALTER TABLE compute_jobs ADD COLUMN executor"))).toEqual([
      ...COMPUTE_EXECUTORS,
    ]);
    expect(inList("accounting", at("ALTER TABLE compute_jobs ADD COLUMN accounting"))).toEqual([
      ...COMPUTE_ACCOUNTING,
    ]);
    expect(inList("runner_backend", at("ADD COLUMN runner_backend"))).toEqual([...RUNNER_BACKENDS]);
    expect(table.length).toBeGreaterThan(0);
  });

  test("the runtimes the shape admits are the declared ones (the check admits letters, and the route the words)", () => {
    // The file checks the runtimes' alphabet and count; the three words themselves are the contract's.
    expect([...RUNNER_RUNTIMES]).toEqual(["apptainer", "docker", "podman"]);
    expect(SQL).toContain("json_array_length(runtimes) BETWEEN 1 AND 3");
    expect(RUNNER_RUNTIMES).toHaveLength(3);
  });
});

describe("compute_runners", () => {
  onEveryEngine("a valid registration is stored, and never-NULL columns refuse NULL", async (e) => {
    expect(await insertRunner(e)).toBeNull();
    for (const col of [
      "name",
      "pool",
      "cores",
      "memory_mb",
      "gpus",
      "scratch_gb",
      "backend",
      "runtimes",
      "arch",
      "accounting",
      "site",
      "trust",
      "secret_hash",
      "registered_by",
    ]) {
      const got = await insertRunner(e, { [col]: null });
      expect([col, got === null]).toEqual([col, false]);
    }
  });

  onEveryEngine("each fixed-word column refuses a word that is not declared", async (e) => {
    for (const [col, check] of [
      ["pool", "compute_runners_pool"],
      ["backend", "compute_runners_backend"],
      ["arch", "compute_runners_arch"],
      ["accounting", "compute_runners_accounting"],
      ["trust", "compute_runners_trust"],
    ] as const) {
      expect([col, await insertRunner(e, { [col]: "other" })]).toEqual([
        col,
        expect.stringMatching(NAMED(check)),
      ]);
    }
  });

  onEveryEngine("an id, a name, a site and a hash have their shapes", async (e) => {
    for (const bad of ["rnr_", `rnr_${"A".repeat(24)}`, `rnr_${hex(1, 23)}`, `xnr_${hex(1, 24)}`]) {
      expect([bad, await insertRunner(e, { id: bad })]).toEqual([
        bad,
        expect.stringMatching(NAMED("compute_runners_id")),
      ]);
    }
    for (const bad of ["", "Lab", "a b", "a-b", "x".repeat(65)]) {
      expect([bad, await insertRunner(e, { name: bad })]).toEqual([
        bad,
        expect.stringMatching(NAMED("compute_runners_name")),
      ]);
    }
    for (const bad of ["", "Lab", "a b", "x".repeat(33)]) {
      expect([bad, await insertRunner(e, { site: bad })]).toEqual([
        bad,
        expect.stringMatching(NAMED("compute_runners_site")),
      ]);
    }
    for (const bad of ["abc", hash64().toUpperCase().replace("0", "G"), `${hash64()}0`]) {
      expect([bad, await insertRunner(e, { secret_hash: bad })]).toEqual([
        bad,
        expect.stringMatching(NAMED("compute_runners_secret_hash")),
      ]);
    }
  });

  onEveryEngine(
    "capacity is a whole number in the bounds of the registration request",
    async (e) => {
      const bounds: Array<[string, string, number, number]> = [
        ["cores", "compute_runners_cores", 1, 256],
        ["memory_mb", "compute_runners_memory", 1, 16_777_216],
        ["gpus", "compute_runners_gpus", 0, 8],
        ["scratch_gb", "compute_runners_scratch", 1, 100_000],
      ];
      for (const [col, check, lo, hi] of bounds) {
        for (const ok of [lo, hi])
          expect([col, ok, await insertRunner(e, { [col]: ok })]).toEqual([col, ok, null]);
        for (const bad of [lo - 1, hi + 1, 1.5]) {
          expect([col, bad, await insertRunner(e, { [col]: bad })]).toEqual([
            col,
            bad,
            expect.stringMatching(NAMED(check)),
          ]);
        }
      }
    },
  );

  onEveryEngine(
    "the runtimes are a JSON array of one to three words of lowercase letters",
    async (e) => {
      for (const ok of [
        '["docker"]',
        '["apptainer","docker"]',
        '["apptainer","docker","podman"]',
      ]) {
        expect([ok, await insertRunner(e, { runtimes: ok })]).toEqual([ok, null]);
      }
      for (const bad of [
        "[]",
        "docker",
        '{"a":1}',
        '["Docker"]',
        '["x y"]',
        '["a","b","c","d"]',
        "[1]",
      ]) {
        expect([bad, await insertRunner(e, { runtimes: bad })]).toEqual([
          bad,
          expect.stringMatching(NAMED("compute_runners_runtimes")),
        ]);
      }
    },
  );

  onEveryEngine("a revocation stores its time and its reason together, or neither", async (e) => {
    expect(
      await insertRunner(e, { revoked_at: "2026-11-13 10:00:00", revoke_reason: "owner_revoked" }),
    ).toBeNull();
    for (const half of [
      { revoked_at: "2026-11-13 10:00:00", revoke_reason: null },
      { revoked_at: null, revoke_reason: "owner_revoked" },
    ]) {
      expect(await insertRunner(e, half)).toMatch(NAMED("compute_runners_revoked_together"));
    }
    expect(
      await insertRunner(e, { revoked_at: "2026-11-13 10:00:00", revoke_reason: "Owner Revoked" }),
    ).toMatch(NAMED("compute_runners_revoke_reason"));
  });

  onEveryEngine(
    "a live name is unique, a revoked name is free, and a hash is unique",
    async (e) => {
      const name = `uniq_${next()}`;
      expect(await insertRunner(e, { name })).toBeNull();
      expect(await insertRunner(e, { name })).toMatch(/UNIQUE constraint failed/);
      expect(
        await insertRunner(e, {
          name,
          revoked_at: "2026-11-13 10:00:00",
          revoke_reason: "owner_revoked",
        }),
      ).toBeNull();
      // A revoked row does not hold the name: the live one is revoked, and the name is free again.
      const secret = hash64();
      expect(await insertRunner(e, { secret_hash: secret })).toBeNull();
      expect(await insertRunner(e, { secret_hash: secret })).toMatch(/UNIQUE constraint failed/);
      await e.run(
        "UPDATE compute_runners SET revoked_at = datetime('now'), revoke_reason = 'owner_revoked' WHERE name = ? AND revoked_at IS NULL",
        name,
      );
      expect(await insertRunner(e, { name })).toBeNull();
    },
  );

  onEveryEngine("a version is a short word of letters, digits and . + -, or NULL", async (e) => {
    for (const ok of [null, "0.1.0", "1.2.3-rc.1+build5"]) {
      expect([ok, await insertRunner(e, { runner_version: ok })]).toEqual([ok, null]);
    }
    for (const bad of ["", "a b", "x".repeat(33), "1;2"]) {
      expect([bad, await insertRunner(e, { runner_version: bad })]).toEqual([
        bad,
        expect.stringMatching(NAMED("compute_runners_version")),
      ]);
    }
  });
});

describe("compute_runner_tokens", () => {
  onEveryEngine("a token row has its shapes, and the hash is the key", async (e) => {
    const row = { token_hash: hash64(), runner_id: runnerId(), expires_at: "2026-11-13 10:15:00" };
    expect(await insert(e, "compute_runner_tokens", row)).toBeNull();
    expect(await insert(e, "compute_runner_tokens", row)).toMatch(/UNIQUE constraint failed/);
    expect(await insert(e, "compute_runner_tokens", { ...row, token_hash: "abc" })).toMatch(
      NAMED("compute_runner_tokens_hash"),
    );
    expect(
      await insert(e, "compute_runner_tokens", {
        ...row,
        token_hash: hash64(),
        runner_id: "rnr_x",
      }),
    ).toMatch(NAMED("compute_runner_tokens_runner"));
    expect(
      await insert(e, "compute_runner_tokens", { ...row, token_hash: hash64(), expires_at: null }),
    ).not.toBeNull();
    const [made] = await e.all<Row>(
      "SELECT created_at FROM compute_runner_tokens WHERE token_hash = ?",
      row.token_hash,
    );
    expect(typeof made?.created_at).toBe("string");
  });
});

const NEW_JOB_COLUMNS = [
  "executor",
  "accounting",
  "runner_backend",
  "runner_id",
  "runner_claimed_at",
  "lease_id",
  "lease_expires_at",
  "claim_attempts",
  "runner_remote_id",
  "runner_wall_seconds",
  "runner_cpu_seconds",
  "runner_max_rss_mb",
] as const;

describe("compute_jobs", () => {
  onEveryEngine(
    "the twelve columns exist, in order, and `admitted_at` is not among them",
    async (e) => {
      expect(
        [...SQL.matchAll(/ALTER TABLE compute_jobs ADD COLUMN (\w+)/g)].map((m) => m[1]),
      ).toEqual([...NEW_JOB_COLUMNS]);
      const cols = (
        await e.all<{ name: string }>("SELECT name FROM pragma_table_info('compute_jobs')")
      ).map((c) => c.name);
      for (const c of NEW_JOB_COLUMNS) expect([c, cols.includes(c)]).toEqual([c, true]);
      expect(cols).not.toContain("admitted_at");
    },
  );

  onEveryEngine(
    "a row of the previous shape is still valid: a Tapis job, in SUs, nothing claimed",
    async (e) => {
      const id = jobId();
      expect(await insertJob(e, { id })).toBeNull();
      const [row] = await e.all<Row>("SELECT * FROM compute_jobs WHERE id = ?", id);
      expect(row?.executor).toBe("tapis");
      expect(row?.accounting).toBe("su");
      expect(row?.claim_attempts).toBe(0);
      for (const c of NEW_JOB_COLUMNS.filter(
        (c) => !["executor", "accounting", "claim_attempts"].includes(c),
      )) {
        expect([c, row?.[c]]).toEqual([c, null]);
      }
    },
  );

  onEveryEngine(
    "executor and accounting are declared words, and a Tapis job is always `su`",
    async (e) => {
      expect(await insertJob(e, { executor: "other" })).toMatch(NAMED("compute_jobs_executor"));
      expect(await insertJob(e, { accounting: "other" })).toMatch(NAMED("compute_jobs_accounting"));
      expect(await insertJob(e, { ...RUNNER_JOB, accounting: "none" })).toBeNull();
      expect(await insertJob(e, { ...RUNNER_JOB, accounting: "su" })).toBeNull();
      expect(await insertJob(e, { executor: "tapis", accounting: "su" })).toBeNull();
      expect(await insertJob(e, { executor: "tapis", accounting: "none" })).toMatch(
        NAMED("compute_jobs_accounting_executor"),
      );
      expect(await insertJob(e, { accounting: "none" })).toMatch(
        NAMED("compute_jobs_accounting_executor"),
      );
    },
  );

  onEveryEngine(
    "only a pipeline job may have a runner executor (a person's, a partner's and the others' are Tapis)",
    async (e) => {
      for (const source of ["cli", "web", "partner"]) {
        expect([
          source,
          await insertJob(e, { source, executor: "runner", accounting: "none" }),
        ]).toEqual([source, expect.stringMatching(NAMED("compute_jobs_executor_source"))]);
        expect(await insertJob(e, { source, executor: "tapis" })).toBeNull();
      }
      expect(
        await insertJob(e, { source: "pipeline", executor: "runner", accounting: "none" }),
      ).toBeNull();
      expect(await insertJob(e, { source: "pipeline", executor: "tapis" })).toBeNull();
    },
  );

  onEveryEngine(
    "only a runner job names a runner or a backend, in the declared shapes",
    async (e) => {
      const claimed = { ...RUNNER_JOB, accounting: "none" };
      expect(
        await insertJob(e, { ...claimed, runner_id: runnerId(), runner_backend: "local" }),
      ).toBeNull();
      expect(await insertJob(e, { ...claimed, runner_backend: "slurm" })).toBeNull();
      expect(await insertJob(e, { runner_id: runnerId() })).toMatch(
        NAMED("compute_jobs_runner_id"),
      );
      expect(await insertJob(e, { runner_backend: "local" })).toMatch(
        NAMED("compute_jobs_runner_backend"),
      );
      expect(await insertJob(e, { ...claimed, runner_backend: "other" })).toMatch(
        NAMED("compute_jobs_runner_backend"),
      );
      expect(await insertJob(e, { ...claimed, runner_id: "rnr_x" })).toMatch(
        NAMED("compute_jobs_runner_id"),
      );
    },
  );

  onEveryEngine(
    "a lease is 32 lowercase hex digits, and the counters are whole numbers",
    async (e) => {
      expect(await insertJob(e, { lease_id: hex(next(), 32) })).toBeNull();
      for (const bad of ["abc", hex(1, 32).toUpperCase().replace("0", "G"), hex(1, 33)]) {
        expect([bad, await insertJob(e, { lease_id: bad })]).toEqual([
          bad,
          expect.stringMatching(NAMED("compute_jobs_lease_id")),
        ]);
      }
      for (const [col, check] of [
        ["runner_wall_seconds", "compute_jobs_runner_wall"],
        ["runner_cpu_seconds", "compute_jobs_runner_cpu"],
        ["runner_max_rss_mb", "compute_jobs_runner_rss"],
      ] as const) {
        for (const ok of [null, 0, 1, Number.MAX_SAFE_INTEGER]) {
          expect([col, ok, await insertJob(e, { [col]: ok })]).toEqual([col, ok, null]);
        }
        for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
          expect([col, bad, await insertJob(e, { [col]: bad })]).toEqual([
            col,
            bad,
            expect.stringMatching(NAMED(check)),
          ]);
        }
      }
      for (const bad of [-1, 1.5, null]) {
        expect([bad, await insertJob(e, { claim_attempts: bad })]).not.toEqual([bad, null]);
      }
      for (const bad of ["", "a b", "x".repeat(65), "x;y"]) {
        expect([bad, await insertJob(e, { runner_remote_id: bad })]).toEqual([
          bad,
          expect.stringMatching(NAMED("compute_jobs_runner_remote_id")),
        ]);
      }
      expect(await insertJob(e, { runner_remote_id: "slurm:123_4.batch" })).toBeNull();
    },
  );
});

describe("the indexes and the file", () => {
  onEveryEngine(
    "the waiting index serves a waiting runner job query, and only one that states its predicate",
    async (e) => {
      const waiting = await e.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT id FROM compute_jobs
        WHERE executor = 'runner' AND state = 'created' AND runner_claimed_at IS NULL AND pool = 'cpu'
        ORDER BY created_at LIMIT 1`,
      );
      expect(waiting.map((r) => r.detail).join(" ")).toContain("compute_jobs_runner_waiting");
      const without = await e.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id FROM compute_jobs WHERE pool = 'cpu' ORDER BY created_at LIMIT 1",
      );
      expect(without.map((r) => r.detail).join(" ")).not.toContain("compute_jobs_runner_waiting");
      // The predicate is all three terms: a query that leaves one out cannot use it.
      for (const missing of [
        "executor = 'runner' AND state = 'created' AND pool = 'cpu'",
        "executor = 'runner' AND runner_claimed_at IS NULL AND pool = 'cpu'",
        "state = 'created' AND runner_claimed_at IS NULL AND pool = 'cpu'",
      ]) {
        const plan = await e.all<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT id FROM compute_jobs WHERE ${missing} ORDER BY created_at LIMIT 1`,
        );
        expect([
          missing,
          plan
            .map((r) => r.detail)
            .join(" ")
            .includes("compute_jobs_runner_waiting"),
        ]).toEqual([missing, false]);
      }
    },
  );

  onEveryEngine(
    "no column of either new table or of the new job columns is named for a person",
    async (e) => {
      const PERSONAL =
        /(^|_)(email|mail|country|orcid|affiliation|city|given|family|username|login|phone|address|ip|sub|description|github)(_|$)/;
      for (const table of ["compute_runners", "compute_runner_tokens"]) {
        const cols = (
          await e.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
        ).map((c) => c.name);
        expect(cols.length).toBeGreaterThan(0);
        for (const c of cols) expect([table, c, PERSONAL.test(c)]).toEqual([table, c, false]);
      }
      for (const c of NEW_JOB_COLUMNS) expect([c, PERSONAL.test(c)]).toEqual([c, false]);
    },
  );

  onEveryEngine(
    "the cascade's statements find a runner's jobs through the runner_id index, not a scan of the job table",
    async (e) => {
      const statements = [
        ...runnerRevokeStatements(runnerId(), "owner_revoked"),
        ...runnerEndStatements(7, "account_revoked"),
      ].filter((s) => s.sql.includes("compute_jobs"));
      expect(statements).toHaveLength(4);
      for (const s of statements) {
        const plan = await e.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${s.sql}`, ...s.binds);
        const detail = plan.map((r) => r.detail).join(" | ");
        expect([/USING INDEX compute_jobs_runner\b/.test(detail), detail]).toEqual([true, detail]);
        expect(detail).not.toMatch(/SCAN compute_jobs(?! USING)/);
      }
    },
  );

  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });

  test("the file creates two tables, five indexes and twelve columns, and touches nothing else", () => {
    expect([...SQL.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1])).toEqual([
      "compute_runners",
      "compute_runner_tokens",
    ]);
    expect([...SQL.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((m) => m[1])).toEqual([
      "compute_runners_live_name",
      "compute_runners_owner",
      "compute_runner_tokens_runner",
      "compute_jobs_runner",
      "compute_jobs_runner_waiting",
    ]);
    const code = SQL.split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/DROP |DELETE FROM|INSERT INTO|UPDATE |FOREIGN KEY|REFERENCES/);
  });
});
