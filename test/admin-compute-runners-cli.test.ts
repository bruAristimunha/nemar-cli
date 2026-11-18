/**
 * `nemar admin compute runners register|list|revoke` (portable compute, card DM-05), driven through the
 * real entry point against the REAL routes: the Worker's admin router behind its real authentication and
 * admin middleware, over real SQLite carrying every migration, served on a loopback port and reached
 * through TEST_API_URL. What the command prints is what the route answers.
 *
 * The properties, each with a test of its own:
 *  - `register` prints the id and the secret ONCE with the warning to keep it in a mode-0600 file, and the
 *    Worker stored only the hash; `list` never shows the secret or a hash; `--json` keeps standard output
 *    pure JSON, the secret included, and the failure goes to standard error;
 *  - a bad option (a pool, a count, a runtime, a name, no runtime) is refused BEFORE anything is sent, with
 *    the field named;
 *  - an administrator who is not an owner, a member and no key exit 1 and register nothing;
 *  - `list` prints the registrations and `revoke` ends one; a second revoke says it changed nothing; a
 *    malformed id is refused before anything is sent and an unknown one exits 1;
 *  - an answer with keys the CLI does not know is shown, not refused (the listing's schema is open);
 *  - `usage` (card S6) prints every runner's usage in the runners' own figures, marks partial usage, never
 *    prints a service unit, ends with its one fixed line, and is an administrator's, not only the owner's;
 *  - every subcommand's help has an "Exit codes:" block.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  computeEnv,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import { freshDb } from "../backend/test/helpers/d1";
import { ComputeRunnersUsageResponseSchema } from "../shared/contract/compute-admin";
import { RUNNER_SECRET_RE, RunnerRegisterResponseSchema } from "../shared/contract/compute-runner";
import { RunnerListResponseSchema } from "../src/lib/api/compute-runners";

/** A row or a JSON body read back by a test, whose fields the assertions name. */
// biome-ignore lint/suspicious/noExplicitAny: test rows and bodies are read field by field
type Loose = Record<string, any>;

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let db: Database;
let configDir: string;
/** Requests that reached the Worker's admin router since the last reset. */
let reached = 0;
/** When set, an answer with keys a newer Worker would add. */
let augment = false;
/** When set, every state count of a usage answer is text with a terminal control sequence in it. */
let hostile = false;

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    reached += 1;
    const res = await handle(req, computeEnv(db));
    if ((augment || hostile) && res.ok) {
      const body = (await res.json()) as Loose;
      if (augment) {
        body.future_top_level = { added: "by a newer worker" };
        for (const r of body.runners ?? []) r.future_field = 7;
      }
      if (hostile) {
        for (const r of body.runners ?? []) {
          for (const state of Object.keys(r.by_state ?? {})) {
            r.by_state[state] = "\u001b[31mred\u0007";
          }
        }
      }
      return Response.json(body, { status: res.status });
    }
    return res;
  },
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  await seedComputeUsers(db);
  reached = 0;
  augment = false;
  hostile = false;
  configDir = mkdtempSync(join(tmpdir(), "nemar-runners-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(who: ComputeWho | null, args: string[]): Promise<Ran> {
  if (who === null) {
    rmSync(join(configDir, "config.json"), { force: true });
  } else {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "runnerscli",
        accounts: { runnerscli: { apiKey: COMPUTE_KEYS[who] } },
      }),
    );
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", "runners", ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

const FLAGS = [
  "--pool",
  "cpu",
  "--cores",
  "16",
  "--memory-mb",
  "64000",
  "--scratch-gb",
  "500",
  "--runtime",
  "docker",
  "--arch",
  "amd64",
  "--site",
  "lab_a",
  "--trust",
  "lab",
];

const register = (who: ComputeWho | null, name = "lab_a_cpu", flags = FLAGS) =>
  runCli(who, ["register", name, ...flags]);

const runnerRows = () => db.query("SELECT * FROM compute_runners").all() as Array<Loose>;

describe("register", () => {
  test("prints the id and the secret once, with the mode-0600 warning, and the Worker stored only the hash", async () => {
    const r = await register("owner", "lab_a_cpu", [...FLAGS, "--runtime", "apptainer"]);
    expect(r.exitCode).toBe(0);
    const secret = r.stdout.match(/nmr_[0-9a-f]{64}/)?.[0];
    expect(secret).toMatch(RUNNER_SECRET_RE);
    expect(r.stdout).toMatch(/Registered runner rnr_[0-9a-f]{24} \(lab_a_cpu\)/);
    expect(r.stdout).toContain("ONCE");
    expect(r.stdout).toContain("mode 0600");
    expect(r.stdout.split(secret as string)).toHaveLength(2);
    expect(r.stderr).not.toContain(secret as string);
    const rows = runnerRows();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret as string);
    expect(JSON.parse(rows[0]?.runtimes)).toEqual(["docker", "apptainer"]);
    expect(rows[0]).toMatchObject({
      pool: "cpu",
      cores: 16,
      gpus: 0,
      backend: "local",
      accounting: "none",
    });
  });

  test("--json keeps standard output pure JSON, with the secret, and prints no prose", async () => {
    const r = await register("owner", "json_one", [...FLAGS, "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = RunnerRegisterResponseSchema.parse(JSON.parse(r.stdout));
    expect(parsed.secret).toMatch(RUNNER_SECRET_RE);
    expect(r.stderr).toBe("");
  });

  test("a bad option is refused BEFORE anything is sent, and the field is named", async () => {
    const without = (flag: string) => {
      const at = FLAGS.indexOf(flag);
      return [...FLAGS.slice(0, at), ...FLAGS.slice(at + 2)];
    };
    const cases: Array<[string, string, string[]]> = [
      ["a pool that is not one", "lab_a", ["--pool", "tpu", ...without("--pool")]],
      ["cores that are not a number", "lab_a", ["--cores", "many", ...without("--cores")]],
      ["cores out of range", "lab_a", ["--cores", "0", ...without("--cores")]],
      ["a runtime that is not one", "lab_a", [...FLAGS, "--runtime", "lxc"]],
      ["the same runtime twice", "lab_a", [...FLAGS, "--runtime", "docker"]],
      ["no runtime at all", "lab_a", without("--runtime")],
      ["a name that is not a word", "Bad Name", FLAGS],
      ["a site that is not a word", "lab_a", ["--site", "Lab A", ...without("--site")]],
      ["a trust that is not one", "lab_a", ["--trust", "cloud", ...without("--trust")]],
      ["no arch", "lab_a", without("--arch")],
    ];
    for (const [what, name, flags] of cases) {
      const before = reached;
      const r = await runCli("owner", ["register", name, ...flags]);
      expect([what, r.exitCode]).toEqual([what, 1]);
      expect([what, r.stderr, r.stdout].join("\n")).toContain("nothing was sent");
      expect([what, reached]).toEqual([what, before]);
    }
    expect(runnerRows()).toHaveLength(0);
  });

  test("an administrator who is not an owner, a member and no key exit 1 and register nothing", async () => {
    for (const who of ["admin", "member", null] as const) {
      const r = await register(who);
      expect([who, r.exitCode]).toEqual([who, 1]);
      expect(r.stdout).not.toMatch(/nmr_/);
    }
    expect(runnerRows()).toHaveLength(0);
  });

  test("a live name is refused, with the Worker's word, and exits 1", async () => {
    expect((await register("owner")).exitCode).toBe(0);
    const again = await register("owner");
    expect(again.exitCode).toBe(1);
    expect(again.stderr + again.stdout).toContain("already has that name");
    expect(runnerRows()).toHaveLength(1);
  });
});

describe("list", () => {
  test("lists the registrations without a secret or a hash, and --json is the Worker's answer", async () => {
    const reg = await register("owner", "first_one", [...FLAGS, "--json"]);
    const { secret } = RunnerRegisterResponseSchema.parse(JSON.parse(reg.stdout));
    await register(
      "owner",
      "second_one",
      [...FLAGS, "--backend", "slurm", "--trust", "hpc"].filter(
        (x, i, a) => !(x === "--trust" && a[i + 1] === "lab") && !(x === "lab"),
      ),
    );
    const r = await runCli("owner", ["list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("first_one");
    expect(r.stdout).toContain("second_one");
    expect(r.stdout).toContain("live, never seen");
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toMatch(/secret_hash|[0-9a-f]{64}/);
    const j = await runCli("owner", ["list", "--json"]);
    expect(RunnerListResponseSchema.parse(JSON.parse(j.stdout)).runners).toHaveLength(2);
    expect(j.stdout).not.toContain(secret);
  });

  test("an empty registry says so, and a non-owner exits 1", async () => {
    const r = await runCli("owner", ["list"]);
    expect([r.exitCode, r.stdout.trim()]).toEqual([0, "No runner is registered."]);
    for (const who of ["admin", "member", null] as const) {
      expect([who, (await runCli(who, ["list"])).exitCode]).toEqual([who, 1]);
    }
  });

  test("an answer with keys the CLI does not know is shown, not refused", async () => {
    await register("owner");
    augment = true;
    const r = await runCli("owner", ["list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("lab_a_cpu");
    const j = await runCli("owner", ["list", "--json"]);
    expect(JSON.parse(j.stdout).future_top_level).toEqual({ added: "by a newer worker" });
  });
});

describe("revoke", () => {
  test("ends a registration, and a second revoke says it changed nothing", async () => {
    await register("owner");
    const id = runnerRows()[0]?.id as string;
    const r = await runCli("owner", ["revoke", id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Revoked runner ${id}`);
    expect(runnerRows()[0]?.revoke_reason).toBe("owner_revoked");
    const again = await runCli("owner", ["revoke", id]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already revoked");
    const j = await runCli("owner", ["revoke", id, "--json"]);
    expect(JSON.parse(j.stdout)).toEqual({ runner_id: id, revoked: true, already_revoked: true });
    expect((await runCli("owner", ["list"])).stdout).toContain("revoked (owner_revoked)");
  });

  test("a malformed id is refused before anything is sent, an unknown one exits 1, and a non-owner cannot", async () => {
    await register("owner");
    const before = reached;
    const bad = await runCli("owner", ["revoke", "not-an-id"]);
    expect(bad.exitCode).toBe(1);
    expect(reached).toBe(before);
    const unknown = await runCli("owner", ["revoke", `rnr_${"0".repeat(24)}`]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr + unknown.stdout).toContain("no such runner");
    const id = runnerRows()[0]?.id as string;
    for (const who of ["admin", "member", null] as const) {
      expect([who, (await runCli(who, ["revoke", id])).exitCode]).toEqual([who, 1]);
    }
    expect(runnerRows()[0]?.revoked_at).toBeNull();
  });
});

describe("usage", () => {
  const FOOTER = "Runner-reported usage; never service units.";
  let made = 0;

  /** A runner job, written by SQL the table accepts (the pattern of the other suites that count jobs). */
  function runnerJob(
    runnerId: string,
    state: "finished" | "failed" | "created",
    usage: { wall: number; cpu: number; rss: number; partial: 0 | 1 | null } | null,
    createdAt = "2026-10-05 10:00:00",
  ) {
    db.run(
      `INSERT INTO compute_jobs
         (id, source, kind, state, app_id, app_version, spec_digest, partition, pool, nodes,
          cores_per_node, gpus, minutes, executor, accounting, runner_backend, runner_id,
          runner_claimed_at, runner_wall_seconds, runner_cpu_seconds, runner_max_rss_mb,
          runner_usage_partial, created_at, ended_at, settled_provisional_at, failure_code)
       VALUES (?, 'pipeline', 'batch', ?, 'nemar-launch', '1.0.0', ?, 'shared', 'cpu', 1, 4, 0, 60,
               'runner', 'none', 'local', ?, ?, ?, ?, ?, ?, ?,
               CASE WHEN ? IN ('finished', 'failed') THEN ? END,
               CASE WHEN ? IN ('finished', 'failed') THEN ? END,
               CASE WHEN ? = 'failed' THEN 'launch_failed' END)`,
      [
        `job_${(++made).toString(16).padStart(24, "0")}`,
        state,
        "a".repeat(64),
        runnerId,
        createdAt,
        usage?.wall ?? null,
        usage?.cpu ?? null,
        usage?.rss ?? null,
        usage?.partial ?? null,
        createdAt,
        state,
        createdAt,
        state,
        createdAt,
        state,
      ] as never[],
    );
  }

  /** Two registrations and the jobs of the first: a whole one, a partial one, and one not yet reported. */
  async function world() {
    await register("owner", "lab_a_cpu");
    await register(
      "owner",
      "lab_b_cpu",
      FLAGS.map((f) => (f === "lab_a" ? "lab_b" : f)),
    );
    const [first, second] = runnerRows().map((r) => r.id as string) as [string, string];
    runnerJob(first, "finished", { wall: 120, cpu: 400, rss: 2048, partial: 0 });
    runnerJob(first, "failed", { wall: 300, cpu: 7200, rss: 4096, partial: 1 });
    runnerJob(first, "created", null);
    return { first, second };
  }

  const RANGE = ["--from", "2026-10-01", "--to", "2026-10-31"];

  test("prints each registration's figures in the runner's own words, marks partial usage, and ends with its one line (MUTATION: drop the partial note, or drop the closing line)", async () => {
    const { first, second } = await world();
    const r = await runCli("admin", ["usage", ...RANGE]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Runner usage, jobs created 2026-10-01 to 2026-10-31:");
    const own = lines.find((l) => l.includes(first)) ?? "";
    expect(own).toContain("live: 3 job(s) (");
    expect(own).toContain("finished 1");
    expect(own).toContain("failed 1");
    expect(own).toContain("created 1");
    expect(own).toContain("wall 420 s, cpu 7600 s, 2.111 runner-reported core-hours");
    expect(own).toContain("max resident 4096 MB");
    expect(own).toContain("usage of 1 job(s) is a lower bound (partial: Docker or Podman)");
    const idle = lines.find((l) => l.includes(second)) ?? "";
    expect(idle).toContain(
      "live: 0 job(s), 0 with usage reported, wall 0 s, cpu 0 s, 0.000 runner-reported core-hours",
    );
    expect(idle).toContain("max resident none reported");
    expect(idle).not.toContain("partial");
    expect(lines.find((l) => l.startsWith("All runners:"))).toBe(
      "All runners: 3 job(s), 2 with usage reported, wall 420 s, cpu 7600 s, 2.111 runner-reported core-hours; " +
        "usage of 1 job(s) is a lower bound (partial: Docker or Podman)",
    );
    // The last line is the fixed one, and no service unit is printed anywhere.
    expect(lines[lines.length - 1]).toBe(FOOTER);
    expect(r.stdout.replace(FOOTER, "")).not.toMatch(/\bSU\b|service unit/i);
    expect(r.stderr.trim()).toBe("");
  });

  test("a whole figure carries no partial note, and a revoked registration is shown as revoked", async () => {
    await register("owner", "lab_a_cpu");
    const id = runnerRows()[0]?.id as string;
    runnerJob(id, "finished", { wall: 61, cpu: 240, rss: 100, partial: 0 });
    expect((await runCli("owner", ["revoke", id])).exitCode).toBe(0);
    const r = await runCli("admin", ["usage", ...RANGE]);
    expect(r.exitCode).toBe(0);
    const own = r.stdout.split("\n").find((l) => l.includes(id)) ?? "";
    expect(own).toContain(
      "revoked: 1 job(s) (finished 1), 1 with usage reported, wall 61 s, cpu 240 s, 0.066 runner-reported",
    );
    expect(r.stdout).not.toContain("partial");
  });

  test("--json is the Worker's answer and only that, and a newer Worker's extra keys are kept", async () => {
    const { first } = await world();
    augment = true;
    const r = await runCli("admin", ["usage", ...RANGE, "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    const parsed = ComputeRunnersUsageResponseSchema.parse(body);
    expect(parsed.runners.find((x) => x.id === first)).toMatchObject({
      jobs: 3,
      cpu_seconds: 7600,
      partial_jobs: 1,
    });
    expect(parsed.totals).toMatchObject({ jobs: 3, core_hours: 2.111, partial_jobs: 1 });
    expect(body.future_top_level).toEqual({ added: "by a newer worker" });
    expect(r.stdout).not.toContain(FOOTER);
    expect(r.stderr.trim()).toBe("");
    // The human view of the same answer is shown, not refused.
    const human = await runCli("admin", ["usage", ...RANGE]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(first);
  });

  test("a date that is not one is refused before anything is sent; a range the Worker refuses exits 1 with its sentence", async () => {
    await world();
    const before = reached;
    for (const args of [
      ["--from", "yesterday", "--to", "2026-10-31"],
      ["--from", "2026-10-01", "--to", "2026-13-01"],
    ]) {
      const r = await runCli("admin", ["usage", ...args]);
      expect([args, r.exitCode]).toEqual([args, 1]);
      expect(r.stdout + r.stderr).toContain("--from and --to are dates, YYYY-MM-DD");
    }
    expect((await runCli("admin", ["usage", "--from", "2026-10-01"])).exitCode).toBe(1);
    expect(reached).toBe(before);

    const long = await runCli("admin", ["usage", "--from", "2026-01-01", "--to", "2027-01-02"]);
    expect(long.exitCode).toBe(1);
    expect(long.stdout + long.stderr).toContain("a range is at most 366 days");
    const backwards = await runCli("admin", [
      "usage",
      "--from",
      "2026-10-31",
      "--to",
      "2026-10-01",
    ]);
    expect(backwards.exitCode).toBe(1);
    expect(backwards.stdout + backwards.stderr).toContain("from is after to");
    expect(reached).toBe(before + 2);
  });

  test("an administrator and an owner may read it; a member and no key may not", async () => {
    await world();
    for (const who of ["admin", "owner"] as const) {
      expect([who, (await runCli(who, ["usage", ...RANGE])).exitCode]).toEqual([who, 0]);
    }
    for (const who of ["member", null] as const) {
      const r = await runCli(who, ["usage", ...RANGE]);
      expect([who, r.exitCode]).toEqual([who, 1]);
      expect(r.stdout).not.toContain(FOOTER);
    }
  });

  test("a registration whose jobs have reported nothing says so instead of printing zeros (MUTATION: drop the reported count and the no-usage phrase)", async () => {
    await register("owner", "lab_a_cpu");
    const id = runnerRows()[0]?.id as string;
    runnerJob(id, "created", null);
    const r = await runCli("admin", ["usage", ...RANGE]);
    expect(r.exitCode).toBe(0);
    const own = r.stdout.split("\n").find((l) => l.includes(id)) ?? "";
    expect(own).toContain(
      "live: 1 job(s) (created 1), 0 with usage reported, no usage reported yet",
    );
    expect(own).not.toContain("wall 0 s");
    expect(r.stdout).toContain(
      "All runners: 1 job(s), 0 with usage reported, no usage reported yet",
    );
    expect(r.stdout).not.toContain("0.000");
  });

  test("usage with no mark (a job completed before the mark was stored) is counted as unknown, never as whole (MUTATION: drop the unmarked clause from runnerMarkNotes)", async () => {
    await register("owner", "lab_a_cpu");
    const id = runnerRows()[0]?.id as string;
    runnerJob(id, "finished", { wall: 61, cpu: 240, rss: 100, partial: null });
    runnerJob(id, "finished", { wall: 120, cpu: 400, rss: 2048, partial: 0 });
    const r = await runCli("admin", ["usage", ...RANGE]);
    expect(r.exitCode).toBe(0);
    const own = r.stdout.split("\n").find((l) => l.includes(id)) ?? "";
    expect(own).toContain("2 with usage reported");
    expect(own).toContain("; usage of 1 job(s) has no partial mark (partial: unknown)");
    expect(own).not.toContain("lower bound");
    expect(r.stdout).toContain(
      "All runners: 2 job(s), 2 with usage reported, wall 181 s, cpu 640 s, 0.177 runner-reported core-hours; usage of 1 job(s) has no partial mark (partial: unknown)",
    );
  });

  test("a state count the Worker sent is made plain before it is printed, and the help says the days are UTC (MUTATION: print the count unwrapped)", async () => {
    const { first } = await world();
    hostile = true;
    const r = await runCli("admin", ["usage", ...RANGE]);
    expect(r.exitCode).toBe(0);
    const own = r.stdout.split("\n").find((l) => l.includes(first)) ?? "";
    expect(own).toContain("finished");
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).not.toContain("\u0007");
    const help = await runCli("admin", ["usage", "--help-all"]);
    expect(help.stdout).toContain("UTC days: a job belongs to the day it was created, in UTC");
  });

  test("no registrations says so, and still ends with the fixed line", async () => {
    const r = await runCli("admin", ["usage", ...RANGE]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No runner is registered.");
    expect(r.stdout.trimEnd().split("\n").pop()).toBe(FOOTER);
  });
});

describe("help", () => {
  test("every subcommand's help has an Exit codes block, and register's names the secret rule", async () => {
    for (const sub of ["register", "list", "revoke", "usage"]) {
      const r = await runCli("owner", [sub, "--help-all"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Exit codes:");
    }
    const help = (await runCli("owner", ["register", "--help-all"])).stdout;
    expect(help).toContain("mode 0600");
    expect(help).toContain("ONCE");
  });
});
