/**
 * `nemar admin compute jobs` (cancel and advance: phase A5, #2010; list, record, report, access-report,
 * hold, release-hold and the ACCESS re-queue: phase A7, #2012; ADR 0118), driven through the
 * real entry point against the REAL routes: the Worker's admin router behind its real authentication and
 * admin middleware, over real SQLite carrying every migration, Miniflare's R2 through the Worker's own
 * bindings and the Tapis stand-in behind it (which recorded nothing from a real tenant), served on a
 * loopback port and reached through TEST_API_URL. What the command prints is what the route answers.
 *
 * The properties, each with a test of its own: `advance` submits a created job and says so; `--json`
 * prints the Worker's answer and nothing else on standard output; `cancel` ends a job that never started;
 * a platform failure is shown as an information flag, never a refund; a malformed id is refused before
 * anything is sent; an unknown job, a member's key and no key at all exit 1; an answer with keys the CLI
 * does not know is shown, not refused (the schema is open); and no token, address or identity is printed.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { recordKey } from "../backend/src/services/compute-records";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import { endedJob } from "../backend/test/helpers/compute-ended";
import {
  type LifecycleFixture,
  MINUTE,
  jobTokenSeenByTapis,
  launchSpecEnvSeenByTapis,
  makeJob,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "../backend/test/helpers/compute-lifecycle-fixture";
import { launchSecretForms } from "../backend/test/helpers/launch-secret-forms";
import { RECORDS_RESULT_MANIFEST_FILE, formatSu } from "../shared/contract/compute";
import {
  ComputeJobAdminResponseSchema,
  ComputeRecordResponseSchema,
} from "../shared/contract/compute-admin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let fx: LifecycleFixture;
let configDir: string;
/** Requests the server saw (the `/notices` call of the CLI is not counted). */
let seen: string[] = [];
let augment = false;

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    seen.push(`${req.method} ${url.pathname}`);
    const res = await handle(req, fx.env());
    if (augment && res.ok) {
      const body = (await res.json()) as Record<string, any>;
      body.future_top_level = { added: "by a newer worker" };
      if (body.job) body.job.future_nested = 7;
      return Response.json(body, { status: res.status });
    }
    return res;
  },
});
const API = `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await fx?.dispose();
}, 30_000);

beforeEach(async () => {
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
  seen = [];
  augment = false;
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-jobs-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  who: ComputeWho | null,
  args: string[],
  group: string[] = ["jobs"],
): Promise<Ran> {
  if (who === null) {
    rmSync(join(configDir, "config.json"), { force: true });
  } else {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "computecli",
        accounts: { computecli: { apiKey: COMPUTE_KEYS[who] } },
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
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", ...group, ...args],
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

describe("advance", () => {
  test("its help says the submit is refused while compute is switched off, and what stays", async () => {
    const r = await runCli("admin", ["advance", "--help-all"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("The submit is refused while compute is switched off");
    expect(r.stdout).toContain("compute_disabled");
  });

  test("it submits a created job and prints the job as the Worker shows it", async () => {
    const made = await makeJob(fx);
    const r = await runCli("admin", ["advance", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("outcome: submitted (submit: submitted)");
    expect(r.stdout).toContain(`job ${made.job.id}`);
    expect(r.stdout).toContain("state: submitted (Tapis PENDING)");
    expect(r.stdout).toContain("held 4 SU, charged 0 SU, not settled");
    expect(r.stdout).toContain("flags: none");
    expect((await reread(made.env, made.job.id)).state).toBe("submitted");
    expect(seen).toEqual([`POST /admin/compute/jobs/${made.job.id}/advance`]);
  });

  test("--json prints the Worker's answer, and only that, on standard output", async () => {
    const made = await makeJob(fx);
    const r = await runCli("admin", ["advance", made.job.id, "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(ComputeJobAdminResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ ok: true, outcome: "submitted", job: { state: "submitted" } });
    expect(r.stderr.trim()).toBe("");
  });

  test("a platform failure is shown as an information flag, with its charge, and no refund", async () => {
    const made = await makeJob(fx);
    await runCli("admin", ["advance", made.job.id]);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    await runCli("admin", ["advance", made.job.id]);
    fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const r = await runCli("admin", ["advance", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("failure: launch_failed");
    expect(r.stdout).toContain(
      "platform failure: yes (NEMAR caused it; compensate by a manual grant if warranted)",
    );
    expect(r.stdout).toContain("held 4 SU, charged 2 SU, settled");
    expect(r.stdout.toLowerCase()).not.toContain("refund");
  });

  test("an answer with keys the CLI does not know is shown, not refused", async () => {
    const made = await makeJob(fx);
    augment = true;
    const r = await runCli("admin", ["advance", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("outcome: submitted");
  });
});

describe("cancel", () => {
  test("it ends a job that never started, and says so", async () => {
    const made = await makeJob(fx);
    const r = await runCli("owner", ["cancel", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("outcome: cancel_requested");
    expect(r.stdout).toContain("state: cancelled");
    expect((await reread(made.env, made.job.id)).cancel_reason).toBe("admin");
  });

  test("a job that has already ended otherwise exits 1", async () => {
    const made = await makeJob(fx);
    await runCli("admin", ["advance", made.job.id]);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await runCli("admin", ["advance", made.job.id]);
    const r = await runCli("admin", ["cancel", made.job.id]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("already ended");
  });
});

describe("refusals", () => {
  test("a malformed id is refused before anything is sent", async () => {
    for (const id of ["nope", "job_XYZ", "JOB_0123456789ABCDEF01234567"]) {
      for (const verb of ["cancel", "advance"]) {
        const r = await runCli("admin", [verb, id]);
        expect([id, verb, r.exitCode]).toEqual([id, verb, 1]);
        expect(r.stdout + r.stderr).toContain("not a job id");
      }
    }
    expect(seen).toEqual([]);
  });

  test("an unknown job, a member's key and no key at all exit 1", async () => {
    const made = await makeJob(fx);
    for (const verb of ["cancel", "advance"]) {
      expect((await runCli("admin", [verb, "job_000000000000000000000000"])).exitCode).toBe(1);
      expect((await runCli("member", [verb, made.job.id])).exitCode).toBe(1);
      expect((await runCli(null, [verb, made.job.id])).exitCode).toBe(1);
    }
    expect((await reread(made.env, made.job.id)).state).toBe("created");
  });
});

describe("what is printed", () => {
  test("no token, address, specification or identity is on standard output or standard error", async () => {
    const made = await makeJob(fx);
    const first = await runCli("admin", ["advance", made.job.id]);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    const token = jobTokenSeenByTapis(fx, uuid);
    // The value Tapis holds carries the token, and the plain token is not a substring of it.
    const launchValue = launchSpecEnvSeenByTapis(fx, uuid);
    fx.tapis.advance(uuid, "RUNNING");
    const second = await runCli("admin", ["advance", made.job.id, "--json"]);
    const user = fx.harness.db
      .query("SELECT username, email FROM users WHERE id = ?")
      .get(made.accountId) as { username: string; email: string };
    for (const out of [first, second]) {
      const all = out.stdout + out.stderr;
      for (const word of [
        ...launchSecretForms(token, launchValue),
        fx.tapis.url,
        "NEMAR_LAUNCH_SPEC",
        "analyse",
        user.email,
        user.username,
      ]) {
        expect([word, all.includes(word)]).toEqual([word, false]);
      }
    }
  });
});

// --- Phase A7 (#2012): reporting, holds, ACCESS reports and the observer --------------------------------------------

const sql = {
  one: <T>(q: string, ...p: unknown[]) => fx.harness.db.query(q).get(...(p as never[])) as T,
  all: <T>(q: string, ...p: unknown[]) => fx.harness.db.query(q).all(...(p as never[])) as T[],
  run: (q: string, ...p: unknown[]) => fx.harness.db.run(q, p as never[]),
};

/** What the seeded people carry that no administrator's command may print. */
const IDENTITY = [
  "Ada",
  "Lovelace",
  "@example.org",
  "0000-0002",
  "Freedonia",
  "Analytical Engines",
];
const clean = (out: Ran) => {
  for (const word of IDENTITY)
    expect([word, (out.stdout + out.stderr).includes(word)]).toEqual([word, false]);
};

describe("list", () => {
  test("filters by flag and prints one line a job with its flags, and nothing that names a person", async () => {
    const a = await makeJob(fx);
    const b = await makeJob(fx);
    sql.run("UPDATE compute_jobs SET flag_unreserved = 1 WHERE id = ?", b.job.id);
    const flagged = await runCli("admin", ["list", "--flag", "unreserved"]);
    expect(flagged.exitCode).toBe(0);
    expect(flagged.stdout).toContain(b.job.id);
    expect(flagged.stdout).not.toContain(a.job.id);
    expect(flagged.stdout).toContain("[unreserved]");
    clean(flagged);
    const all = await runCli("admin", ["list"]);
    expect(all.stdout.indexOf(b.job.id)).toBeLessThan(all.stdout.indexOf(a.job.id));
    clean(all);
    expect(seen).toEqual(["GET /admin/compute/jobs", "GET /admin/compute/jobs"]);
  });

  test("--json prints the Worker's answer and only that; a page names the cursor that continues it", async () => {
    await makeJob(fx);
    await makeJob(fx);
    const r = await runCli("admin", ["list", "--limit", "1", "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.jobs).toHaveLength(1);
    expect(body.next_after).not.toBeNull();
    expect(r.stderr.trim()).toBe("");
    const text = await runCli("admin", ["list", "--limit", "1"]);
    expect(text.stdout).toContain(`More: --after ${body.next_after}`);
  });

  test("an option that is not valid is refused before anything is sent", async () => {
    for (const args of [
      ["--flag", "weird"],
      ["--state", "nope"],
      ["--limit", "0"],
      ["--limit", "201"],
      ["--account", "x"],
      ["--after", "-1"],
    ]) {
      const r = await runCli("admin", ["list", ...args]);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
    }
    expect(seen).toEqual([]);
  });

  test("--unmatched lists Expanse's rows that no job claims", async () => {
    sql.run(
      `INSERT INTO compute_sacct_rows (slurm_job_id, run_id, partition, state, elapsed_seconds, alloc_nodes, alloc_cpus, alloc_gpus, alloc_mem_mb)
       VALUES ('88001', '11111111-2222-3333-4444-555555555555', 'shared', 'COMPLETED', 600, 1, 4, 0, 8000)`,
    );
    const r = await runCli("admin", ["list", "--unmatched"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 row(s) of Expanse's accounting match no job");
    expect(r.stdout).toContain("88001");
  });

  test("a member and no key at all exit 1", async () => {
    expect((await runCli("member", ["list"])).exitCode).toBe(1);
    expect((await runCli(null, ["list"])).exitCode).toBe(1);
  });
});

describe("record", () => {
  test("shows a job by its NEMAR id, its Tapis uuid and its Slurm id, the same job each time", async () => {
    const j = await endedJob(fx, 30);
    const outs = [];
    for (const ref of [j.job.id, j.uuid, j.job.slurm_job_id as string]) {
      const r = await runCli("admin", ["record", ref]);
      expect([ref, r.exitCode]).toEqual([ref, 0]);
      outs.push(r.stdout);
      expect(r.stdout).toContain(`job ${j.job.id}`);
      expect(r.stdout).toContain("ledger:");
      expect(r.stdout).toContain("hold");
      expect(r.stdout).toContain("provenance: {");
      expect(r.stdout).toContain("manifest: 1 file(s), 8 bytes");
      clean(r);
    }
    expect(new Set(outs.map((o) => o.length)).size).toBe(1);
  });

  test("a missing record, an unreadable one and an empty one are printed as three different things", async () => {
    // No records yet: both are missing, and the line says so (it used to say `none` for every cause).
    const bare = await makeJob(fx);
    const missing = await runCli("admin", ["record", bare.job.id]);
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout).toContain("provenance: missing");
    expect(missing.stdout).toContain("manifest: missing");

    // Present but broken: not JSON for provenance, not an object for the manifest.
    const broken = await endedJob(fx, 30);
    await fx.harness.records.put(recordKey(broken.job.id, "provenance.json"), "not json {");
    await fx.harness.records.put(recordKey(broken.job.id, RECORDS_RESULT_MANIFEST_FILE), "[1, 2]");
    const unreadable = await runCli("admin", ["record", broken.job.id]);
    expect(unreadable.stdout).toContain("provenance: unreadable");
    expect(unreadable.stdout).toContain("manifest: unreadable");
    expect(unreadable.stdout).not.toContain("provenance: none");

    // Present and empty is a value, not an absence.
    const empty = await endedJob(fx, 30);
    await fx.harness.records.put(recordKey(empty.job.id, "provenance.json"), "{}");
    await fx.harness.records.put(
      recordKey(empty.job.id, RECORDS_RESULT_MANIFEST_FILE),
      JSON.stringify({ files: [] }),
    );
    const present = await runCli("admin", ["record", empty.job.id]);
    expect(present.stdout).toContain("manifest: 0 file(s), 0 bytes");
    expect(present.stdout).not.toContain("provenance: missing");
    expect(present.stdout).not.toContain("provenance: unreadable");
    // The launcher's file names ride along, and the answer parses.
    expect(present.stdout).toContain("launcher files:");
    const asJson = await runCli("admin", ["record", broken.job.id, "--json"]);
    expect(ComputeRecordResponseSchema.safeParse(JSON.parse(asJson.stdout)).success).toBe(true);
    expect(JSON.parse(asJson.stdout)).toMatchObject({
      provenance_status: "unreadable",
      manifest_status: "unreadable",
    });
  });

  test("--identity refuses an administrator, needs a reason, and for the owner prints the snapshot (MUTATION: let an administrator read it)", async () => {
    const made = await makeJob(fx);
    const noReason = await runCli("owner", ["record", made.job.id, "--identity"]);
    expect(noReason.exitCode).toBe(1);
    expect(noReason.stdout + noReason.stderr).toContain("--reason is required");
    expect(seen).toEqual([]);
    const shortReason = await runCli("owner", [
      "record",
      made.job.id,
      "--identity",
      "--reason",
      "short",
    ]);
    expect(shortReason.exitCode).toBe(1);
    expect(seen).toEqual([]);

    const admin = await runCli("admin", [
      "record",
      made.job.id,
      "--identity",
      "--reason",
      "an administrator asking",
    ]);
    expect(admin.exitCode).toBe(1);
    expect(admin.stdout + admin.stderr).toContain("Only an owner");
    clean(admin);
    expect(
      sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.record.read'",
      ).n,
    ).toBe(0);

    const owner = await runCli("owner", [
      "record",
      made.job.id,
      "--identity",
      "--reason",
      "subject access request",
    ]);
    expect(owner.exitCode).toBe(0);
    expect(JSON.parse(owner.stdout)).toMatchObject({
      name: "Ada Lovelace",
      account_id: made.accountId,
    });
    expect(
      sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.record.read'",
      ).n,
    ).toBe(1);
    const spec = await runCli("owner", [
      "record",
      made.job.id,
      "--spec",
      "--reason",
      "checking the request",
      "--json",
    ]);
    expect(JSON.parse(spec.stdout)).toMatchObject({ name: "spec.json", kind: "bytes" });
  });

  test("--identity and --spec together, and a reason with neither, are refused before anything is sent", async () => {
    const made = await makeJob(fx);
    expect(
      (
        await runCli("owner", [
          "record",
          made.job.id,
          "--identity",
          "--spec",
          "--reason",
          "a perfectly fine reason",
        ])
      ).exitCode,
    ).toBe(1);
    expect(
      (await runCli("owner", ["record", made.job.id, "--reason", "a perfectly fine reason"]))
        .exitCode,
    ).toBe(1);
    expect(seen).toEqual([]);
  });

  test("an unknown reference exits 1", async () => {
    const r = await runCli("admin", ["record", "job_000000000000000000000000"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("no such job");
  });

  test("an answer with keys the CLI does not know is shown, not refused (the parse is open)", async () => {
    const made = await makeJob(fx);
    augment = true;
    const r = await runCli("admin", ["record", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`job ${made.job.id}`);
  });
});

describe("report and access-report", () => {
  test("report totals an account in a range, and --csv prints comma-separated values and nothing else", async () => {
    const a = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET charged_milli = 1500, created_at = '2026-10-05 10:00:00' WHERE id = ?",
      a.job.id,
    );
    const text = await runCli("admin", [
      "report",
      "--account",
      String(a.accountId),
      "--from",
      "2026-10-01",
      "--to",
      "2026-10-31",
    ]);
    expect(text.exitCode).toBe(0);
    // The header counts SU jobs, and says so (the pool line below repeats the figure, so it is anchored here).
    expect(text.stdout).toContain("2026-10-31: 1 SU job(s), 1.5 SU charged");
    // The job is held and unsettled: the total says so, so a running account does not look cheaper.
    expect(text.stdout).toMatch(
      /1 SU job\(s\), 1\.5 SU charged, 1 not settled \([0-9.]+ SU still held\)/,
    );
    expect(text.stdout).toContain("(not settled,");
    clean(text);
    const csv = await runCli("admin", [
      "report",
      "--account",
      String(a.accountId),
      "--from",
      "2026-10-01",
      "--to",
      "2026-10-31",
      "--csv",
    ]);
    const lines = csv.stdout.trim().split("\n");
    expect(lines[0]).toBe(
      "id,created_at,ended_at,state,partition,pool,source,su_charged,settled,su_held,flags," +
        "executor,accounting,runner_id,runner_wall_seconds,runner_cpu_seconds,runner_max_rss_mb," +
        "runner_usage_partial",
    );
    const held = sql.one<{ h: number }>(
      "SELECT held_milli AS h FROM compute_jobs WHERE id = ?",
      a.job.id,
    ).h;
    expect(held).toBeGreaterThan(0);
    expect(lines[1]).toBe(
      `${a.job.id},2026-10-05 10:00:00,,created,shared,cpu,cli,1.5,no,${formatSu(held)},,tapis,su,,,,,`,
    );
    expect(lines).toHaveLength(2);
    expect(csv.stderr.trim()).toBe("");
  });

  test("report refuses a bad account, bad dates, and --csv with --json, before anything is sent", async () => {
    for (const args of [
      ["--account", "x", "--from", "2026-10-01", "--to", "2026-10-31"],
      ["--account", "1", "--from", "Oct", "--to", "2026-10-31"],
      ["--account", "1", "--from", "2026-10-01", "--to", "2026-10-31", "--csv", "--json"],
    ]) {
      expect([args.join(" "), (await runCli("admin", ["report", ...args])).exitCode]).toEqual([
        args.join(" "),
        1,
      ]);
    }
    expect(
      (await runCli("admin", ["report", "--from", "2026-10-01", "--to", "2026-10-31"])).exitCode,
    ).toBe(1);
    expect(seen).toEqual([]);
  });

  test("access-report counts a person once however many jobs, and --csv ends with a total", async () => {
    const a = await makeJob(fx);
    const a2 = await makeJob(fx);
    const b = await makeJob(fx);
    const gateway = sql.one<{ gateway_user: string }>(
      "SELECT gateway_user FROM compute_jobs WHERE id = ?",
      a.job.id,
    ).gateway_user;
    sql.run(
      "UPDATE compute_jobs SET gateway_user = ?, account_id = ? WHERE id = ?",
      gateway,
      a.accountId,
      a2.job.id,
    );
    for (const [i, j] of [a, a2, b].entries())
      sql.run(
        "UPDATE compute_jobs SET slurm_job_id = ?, remote_submitted_at = '2026-11-15 12:00:00' WHERE id = ?",
        `${6000 + i}`,
        j.job.id,
      );
    const text = await runCli("admin", ["access-report", "--quarter", "2026Q4"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("2026Q4: 2 distinct user(s), 3 job(s)");
    expect(text.stdout).not.toContain("gw_");
    const csv = await runCli("admin", ["access-report", "--quarter", "2026Q4", "--csv"]);
    expect(csv.stdout.trim().split("\n")).toEqual([
      "quarter,partition,source,distinct_users,jobs",
      "2026Q4,shared,cli,2,3",
      "2026Q4,total,total,2,3",
    ]);
    for (const q of ["2026Q5", "2026", "x"]) {
      expect((await runCli("admin", ["access-report", "--quarter", q])).exitCode).toBe(1);
    }
  });
});

describe("holds", () => {
  test("the owner places and releases one on a job; an administrator is refused; the target is checked locally", async () => {
    const made = await makeJob(fx);
    const target = `job:${made.job.id}`;
    const refused = await runCli("admin", ["hold", target, "--reason", "legal_request"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout + refused.stderr).toContain("Only an owner");
    const placed = await runCli("owner", ["hold", target, "--reason", "legal_request"]);
    expect(placed.exitCode).toBe(0);
    expect(placed.stdout).toContain(`placed on ${target}`);
    const second = await runCli("owner", ["hold", target, "--reason", "legal_request"]);
    expect(second.exitCode).toBe(1);
    expect(second.stdout + second.stderr).toContain("already under a hold");
    const listed = await runCli("admin", ["holds"]);
    expect(listed.stdout).toContain(`job:${made.job.id}`);
    expect((await runCli("admin", ["release-hold", target])).exitCode).toBe(1);
    const released = await runCli("owner", ["release-hold", target]);
    expect(released.exitCode).toBe(0);
    expect(released.stdout).toContain("released");
    expect((await runCli("owner", ["release-hold", target])).exitCode).toBe(1);
    expect((await runCli("admin", ["holds"])).stdout).toContain("No active holds.");
    seen = [];
    for (const bad of ["job:nope", "account:0", "account:abc", "team:1", "job", "account:1:2"]) {
      expect([
        bad,
        (await runCli("owner", ["hold", bad, "--reason", "legal_request"])).exitCode,
      ]).toEqual([bad, 1]);
      expect((await runCli("owner", ["release-hold", bad])).exitCode).toBe(1);
    }
    expect((await runCli("owner", ["hold", target, "--reason", "Not A Word"])).exitCode).toBe(1);
    expect(seen).toEqual([]);
  });

  test("an account hold is placed by number", async () => {
    const made = await makeJob(fx);
    const r = await runCli("owner", [
      "hold",
      `account:${made.accountId}`,
      "--reason",
      "legal_request",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hold).toMatchObject({
      scope: "account",
      ref: String(made.accountId),
    });
  });
});

describe("holds listing", () => {
  test("a list that is cut says so and a list that is not does not", async () => {
    const none = await runCli("admin", ["holds"]);
    expect(none.stdout).toContain("No active holds.");
    expect(none.stdout).not.toContain("The list is cut");
    for (let i = 1; i <= 201; i++) {
      sql.run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', ?, 'legal_request', 1)",
        String(i),
      );
    }
    const cut = await runCli("admin", ["holds"]);
    expect(cut.exitCode).toBe(0);
    expect(cut.stdout).toContain("The list is cut at the oldest 200 active holds");
    expect(cut.stdout.trim().split("\n")).toHaveLength(201);
    const asJson = await runCli("admin", ["holds", "--json"]);
    expect(JSON.parse(asJson.stdout).truncated).toBe(true);
  }, 60_000);
});

describe("ACCESS reports", () => {
  const FAILED = "job_00000000000000000000000a";
  function seed() {
    sql.run(
      `INSERT INTO compute_access_reports (job_id, state, attempts, last_error_code) VALUES
         (?, 'failed', 1, 'outcome_unknown'), ('job_00000000000000000000000b', 'failed', 0, 'no_gateway_user'),
         ('job_00000000000000000000000c', 'pending', 0, NULL)`,
      FAILED,
    );
  }

  test("the failed ones are listed with their fixed word and counted by word", async () => {
    seed();
    const r = await runCli("admin", ["access-reports"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("failed ACCESS reports: no_gateway_user 1, outcome_unknown 1");
    expect(r.stdout).toContain(`${FAILED}  failed  attempts 1  outcome_unknown`);
    expect(r.stdout).not.toContain("job_00000000000000000000000c");
    expect((await runCli("admin", ["access-reports", "--state", "weird"])).exitCode).toBe(1);
  });

  test("the re-queue needs --confirmed-not-recorded (nothing is sent without it), the owner, and a failed report", async () => {
    seed();
    const missing = await runCli("owner", ["requeue-access-report", FAILED]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout + missing.stderr).toContain("--confirmed-not-recorded");
    expect(seen).toEqual([]);
    const admin = await runCli("admin", [
      "requeue-access-report",
      FAILED,
      "--confirmed-not-recorded",
    ]);
    expect(admin.exitCode).toBe(1);
    expect(admin.stdout + admin.stderr).toContain("Only an owner");
    expect(
      sql.one<{ state: string }>(
        "SELECT state FROM compute_access_reports WHERE job_id = ?",
        FAILED,
      ).state,
    ).toBe("failed");
    const ok = await runCli("owner", ["requeue-access-report", FAILED, "--confirmed-not-recorded"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("pending again");
    expect(ok.stdout).toContain("outcome_unknown");
    expect(
      sql.one<{ state: string }>(
        "SELECT state FROM compute_access_reports WHERE job_id = ?",
        FAILED,
      ).state,
    ).toBe("pending");
    // A report that is not failed has nothing to re-queue.
    const again = await runCli("owner", [
      "requeue-access-report",
      FAILED,
      "--confirmed-not-recorded",
    ]);
    expect(again.exitCode).toBe(1);
    expect(
      (await runCli("owner", ["requeue-access-report", "nope", "--confirmed-not-recorded"]))
        .exitCode,
    ).toBe(1);
  });
});

describe("observer mint", () => {
  test("prints the run and the token once, and the token is not stored", async () => {
    const r = await runCli("admin", ["mint"], ["observer"]);
    expect(r.exitCode).toBe(0);
    const token = /token (\S+)/.exec(r.stdout)?.[1] ?? "";
    expect(token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
    expect(JSON.stringify(sql.all("SELECT * FROM compute_observer_runs"))).not.toContain(
      token.split(".")[1] as string,
    );
    const json = await runCli("admin", ["mint", "--json"], ["observer"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ expires_in_minutes: 60 });
    expect((await runCli("member", ["mint"], ["observer"])).exitCode).toBe(1);
  });
});

describe("a runner job", () => {
  async function runnerRow(): Promise<string> {
    const env = fx.env();
    const id = `job_${"1".repeat(24)}`;
    await env.DB.prepare(
      `INSERT INTO compute_jobs
         (id, source, kind, app_id, app_version, spec_digest, partition, pool, nodes, cores_per_node, gpus,
          minutes, executor, accounting, runner_backend, runner_id, runner_claimed_at, runner_wall_seconds,
          runner_cpu_seconds, runner_max_rss_mb)
       VALUES (?1, 'pipeline', 'batch', 'nemar-launch', '1.0.0', ?2, 'shared', 'cpu', 1, 4, 0, 60,
               'runner', 'none', 'local', ?3, datetime('now'), 61, 240, 4096)`,
    )
      .bind(id, "a".repeat(64), `rnr_${"c".repeat(24)}`)
      .run();
    return id;
  }

  test("is shown with its executor, accounting and runner-reported usage, not as held SU (MUTATION: drop the runner branch)", async () => {
    const id = await runnerRow();
    const r = await runCli("owner", ["cancel", id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("executor: runner, accounting: none (no hold, no service units)");
    expect(r.stdout).toContain(`runner: rnr_${"c".repeat(24)} (local), claimed `);
    expect(r.stdout).toContain("runner-reported: wall 61 s, cpu 240 s, max resident 4096 MB");
    expect(r.stdout).not.toContain("held 0 SU");
    expect(r.stdout).not.toContain("not settled");
  });

  test("is listed with its runner and its runner-reported usage, and no SU figure", async () => {
    const id = await runnerRow();
    const r = await runCli("admin", ["list"]);
    expect(r.exitCode).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.includes(id)) ?? "";
    expect(line).toContain(`runner rnr_${"c".repeat(24)}, runner-reported wall 61 s, cpu 240 s`);
    expect(line).not.toContain("SU");
    expect(line).not.toContain("not settled");
    // The row has usage and no mark (it was seeded as a completion from before the mark was stored): its
    // figures are never shown as whole, and never as partial either: unknown.
    expect(line).toContain("cpu 240 s (partial: unknown)");
  });
});

/** Runner jobs for the S6 reporting views, written by SQL the table accepts (the pattern above). */
describe("runner reporting (card S6)", () => {
  const RUNNER_A = `rnr_${"a".repeat(24)}`;
  const RUNNER_B = `rnr_${"b".repeat(24)}`;
  let made = 0;

  function runnerJob(over: {
    account?: number | null;
    runnerId?: string | null;
    state?: string;
    usage?: { wall: number; cpu: number; rss: number; partial: 0 | 1 | null } | null;
    createdAt?: string;
    /** `su` writes a runner job accounted in service units (a later phase's; the table accepts it). */
    accounting?: "su" | "none";
    chargedMilli?: number;
  }): string {
    const id = `job_${(++made).toString(16).padStart(24, "0")}`;
    const u = over.usage ?? null;
    sql.run(
      `INSERT INTO compute_jobs
         (id, account_id, source, kind, state, app_id, app_version, spec_digest, partition, pool, nodes,
          cores_per_node, gpus, minutes, executor, accounting, charged_milli, runner_backend, runner_id,
          runner_claimed_at, runner_wall_seconds, runner_cpu_seconds, runner_max_rss_mb,
          runner_usage_partial, created_at, ended_at, settled_provisional_at, failure_code,
          cancel_reason, cancel_requested_at)
       VALUES (?1, ?2, 'pipeline', 'batch', ?3, 'nemar-launch', '1.0.0', ?4, 'shared', 'cpu', 1, 4, 0, 60,
               'runner', ?12, ?13, 'local', ?5, ?6, ?7, ?8, ?9, ?10, ?11,
               CASE WHEN ?3 IN ('finished', 'failed', 'cancelled') THEN ?11 END,
               CASE WHEN ?3 IN ('finished', 'failed', 'cancelled') THEN ?11 END,
               CASE WHEN ?3 = 'failed' THEN 'launch_failed' END,
               CASE WHEN ?3 = 'cancelled' THEN 'admin' END,
               CASE WHEN ?3 = 'cancelled' THEN ?11 END)`,
      id,
      over.account ?? null,
      over.state ?? "created",
      "a".repeat(64),
      over.runnerId ?? null,
      over.runnerId ? "2026-10-05 10:00:00" : null,
      u?.wall ?? null,
      u?.cpu ?? null,
      u?.rss ?? null,
      u?.partial ?? null,
      over.createdAt ?? "2026-10-05 10:00:00",
      over.accounting ?? "none",
      over.chargedMilli ?? 0,
    );
    return id;
  }

  /** One account: a Tapis job, a whole runner job, a partial one, and a claimed one that has not reported. */
  async function world() {
    const tapis = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET charged_milli = 1500, created_at = '2026-10-05 10:00:00' WHERE id = ?",
      tapis.job.id,
    );
    const account = tapis.accountId;
    const whole = runnerJob({
      account,
      runnerId: RUNNER_A,
      state: "finished",
      usage: { wall: 120, cpu: 400, rss: 2048, partial: 0 },
    });
    const partial = runnerJob({
      account,
      runnerId: RUNNER_A,
      state: "failed",
      usage: { wall: 300, cpu: 7200, rss: 4096, partial: 1 },
    });
    const waiting = runnerJob({ account, runnerId: RUNNER_B });
    return { tapis: tapis.job.id, account, whole, partial, waiting };
  }

  const lineOf = (out: string, id: string) => out.split("\n").find((l) => l.includes(id)) ?? "";

  test("list --executor, --accounting and --runner each narrow the page to what the Worker filtered", async () => {
    const w = await world();
    const ids = (out: string) =>
      [w.tapis, w.whole, w.partial, w.waiting].filter((id) => out.includes(id)).sort();

    const byExecutor = await runCli("admin", ["list", "--executor", "runner"]);
    expect(byExecutor.exitCode).toBe(0);
    expect(ids(byExecutor.stdout)).toEqual([w.whole, w.partial, w.waiting].sort());
    expect(ids((await runCli("admin", ["list", "--executor", "tapis"])).stdout)).toEqual([w.tapis]);
    expect(ids((await runCli("admin", ["list", "--accounting", "su"])).stdout)).toEqual([w.tapis]);
    expect(ids((await runCli("admin", ["list", "--accounting", "none"])).stdout)).toEqual(
      [w.whole, w.partial, w.waiting].sort(),
    );
    expect(ids((await runCli("admin", ["list", "--runner", RUNNER_A])).stdout)).toEqual(
      [w.whole, w.partial].sort(),
    );
    expect(ids((await runCli("admin", ["list", "--runner", RUNNER_B])).stdout)).toEqual([
      w.waiting,
    ]);
    expect(seen.every((p) => p === "GET /admin/compute/jobs")).toBe(true);
  });

  test("list marks a partial row and no other, and shows a job that has not reported as such (MUTATION: drop the partial note from the list row)", async () => {
    const w = await world();
    const r = await runCli("admin", ["list", "--executor", "runner"]);
    expect(lineOf(r.stdout, w.partial)).toContain(
      `runner ${RUNNER_A}, runner-reported wall 300 s, cpu 7200 s (partial: Docker or Podman)`,
    );
    expect(lineOf(r.stdout, w.whole)).toContain("runner-reported wall 120 s, cpu 400 s");
    expect(lineOf(r.stdout, w.whole)).not.toContain("partial");
    expect(lineOf(r.stdout, w.waiting)).toContain(`runner ${RUNNER_B}, no usage reported yet`);
    // No SU is printed next to a runner job, in any of its rows.
    for (const id of [w.whole, w.partial, w.waiting])
      expect(lineOf(r.stdout, id)).not.toContain("SU");
    clean(r);
  });

  test("list refuses an executor, an accounting class or a runner id that is not one, before anything is sent", async () => {
    await world();
    for (const args of [
      ["--executor", "gpu"],
      ["--accounting", "free"],
      ["--runner", "rnr_short"],
      ["--runner", `rnr_${"A".repeat(24)}`],
    ]) {
      const r = await runCli("admin", ["list", ...args]);
      expect([args, r.exitCode]).toEqual([args, 1]);
    }
    expect(seen).toEqual([]);
  });

  test("list --json prints the Worker's rows, the partial mark included, and nothing else", async () => {
    const w = await world();
    const r = await runCli("admin", ["list", "--executor", "runner", "--json"]);
    expect(r.exitCode).toBe(0);
    const rows = new Map<string, Record<string, unknown>>(
      (JSON.parse(r.stdout).jobs as Array<Record<string, unknown>>).map((j) => [String(j.id), j]),
    );
    expect(rows.get(w.partial)).toMatchObject({ runner_usage_partial: true });
    expect(rows.get(w.whole)).toMatchObject({ runner_usage_partial: false });
    expect(rows.get(w.waiting)).toMatchObject({ runner_usage_partial: null });
    expect(r.stderr.trim()).toBe("");
  });

  test("record marks partial usage on the runner-reported line (MUTATION: drop the partial note from the record view)", async () => {
    const w = await world();
    const partial = await runCli("admin", ["record", w.partial]);
    expect(partial.exitCode).toBe(0);
    expect(partial.stdout).toContain(
      "runner-reported: wall 300 s, cpu 7200 s, max resident 4096 MB (partial: Docker or Podman)",
    );
    const whole = await runCli("admin", ["record", w.whole]);
    expect(whole.stdout).toContain("runner-reported: wall 120 s, cpu 400 s, max resident 2048 MB");
    expect(whole.stdout).not.toContain("partial");
  });

  test("report keeps the SU totals to the Tapis job and gives the runner jobs a line of their own, in runner-reported core-hours (MUTATION: drop the runner branch of the report's job lines, the runner totals line, or the SU word in the report header or pool line)", async () => {
    const w = await world();
    const r = await runCli("admin", [
      "report",
      "--account",
      String(w.account),
      "--from",
      "2026-10-01",
      "--to",
      "2026-10-31",
    ]);
    expect(r.exitCode).toBe(0);
    // The SU line is the Tapis job's alone.
    expect(r.stdout).toContain("2026-10-31: 1 SU job(s), 1.5 SU charged, 1 not settled");
    expect(r.stdout).toContain("  cpu: 1 SU job(s), 1.5 SU charged");
    // The runner jobs, apart: 7600 CPU seconds is 2.111 runner-reported core-hours, one job partial.
    expect(r.stdout).toContain(
      "runner jobs (runner-reported, never service units): 3 job(s), 2 with usage reported, wall 420 s, cpu 7600 s, " +
        "2.111 runner-reported core-hours; usage of 1 job(s) is a lower bound (partial: Docker or Podman)",
    );
    // Each runner job's line carries its usage and no SU; only the Tapis job's line has SU.
    expect(lineOf(r.stdout, w.partial)).toContain(
      `runner ${RUNNER_A}, runner-reported wall 300 s, cpu 7200 s (partial: Docker or Podman)`,
    );
    expect(lineOf(r.stdout, w.whole)).toContain("runner-reported wall 120 s, cpu 400 s");
    expect(lineOf(r.stdout, w.whole)).not.toContain("partial");
    expect(lineOf(r.stdout, w.waiting)).toContain("no usage reported yet");
    for (const id of [w.whole, w.partial, w.waiting])
      expect(lineOf(r.stdout, id)).not.toContain("SU");
    expect(lineOf(r.stdout, w.tapis)).toContain("1.5 SU");
    clean(r);
  });

  test("report --csv leaves a runner job's SU cells empty and adds its runner columns", async () => {
    const w = await world();
    const r = await runCli("admin", [
      "report",
      "--account",
      String(w.account),
      "--from",
      "2026-10-01",
      "--to",
      "2026-10-31",
      "--csv",
    ]);
    expect(r.exitCode).toBe(0);
    const cell = (id: string) => lineOf(r.stdout, id).split(",");
    // su_charged, settled and su_held (indexes 7, 8, 9) are empty for a runner job.
    expect(cell(w.partial).slice(0, 4)).toEqual([
      w.partial,
      "2026-10-05 10:00:00",
      "2026-10-05 10:00:00",
      "failed",
    ]);
    expect(cell(w.partial).slice(7, 10)).toEqual(["", "", ""]);
    expect(cell(w.partial).slice(11)).toEqual([
      "runner",
      "none",
      RUNNER_A,
      "300",
      "7200",
      "4096",
      "yes",
    ]);
    expect(cell(w.whole).slice(11)).toEqual([
      "runner",
      "none",
      RUNNER_A,
      "120",
      "400",
      "2048",
      "no",
    ]);
    expect(cell(w.waiting).slice(11)).toEqual(["runner", "none", RUNNER_B, "", "", "", ""]);
    // The Tapis job keeps its SU cells.
    expect(cell(w.tapis)[7]).toBe("1.5");
    expect(cell(w.tapis).slice(11)).toEqual(["tapis", "su", "", "", "", "", ""]);
    expect(r.stderr.trim()).toBe("");
  });

  test("report --json carries runner_totals and each row's runner usage as the Worker answered", async () => {
    const w = await world();
    const r = await runCli("admin", [
      "report",
      "--account",
      String(w.account),
      "--from",
      "2026-10-01",
      "--to",
      "2026-10-31",
      "--json",
    ]);
    const body = JSON.parse(r.stdout);
    expect(body.totals).toMatchObject({ jobs: 1, charged_milli: 1500 });
    expect(body.runner_totals).toEqual({
      jobs: 3,
      wall_seconds: 420,
      cpu_seconds: 7600,
      core_hours: 2.111,
      reported_jobs: 2,
      partial_jobs: 1,
      unmarked_jobs: 0,
    });
    expect(r.stderr.trim()).toBe("");
  });

  const REPORT_ARGS = (account: number) => [
    "report",
    "--account",
    String(account),
    "--from",
    "2026-10-01",
    "--to",
    "2026-10-31",
  ];

  test("cancel on a runner job that ended canceled after its runner reported prints the mark, in text and in JSON (MUTATION: drop the partial note from the record line, or the mark from the cancel answer)", async () => {
    const partial = runnerJob({
      runnerId: RUNNER_A,
      state: "cancelled",
      usage: { wall: 300, cpu: 7200, rss: 4096, partial: 1 },
    });
    const whole = runnerJob({
      runnerId: RUNNER_A,
      state: "cancelled",
      usage: { wall: 120, cpu: 400, rss: 2048, partial: 0 },
    });
    const text = await runCli("admin", ["cancel", partial]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("outcome: already_cancelled");
    expect(text.stdout).toContain(
      "runner-reported: wall 300 s, cpu 7200 s, max resident 4096 MB (partial: Docker or Podman)",
    );
    const json = await runCli("admin", ["cancel", partial, "--json"]);
    expect(JSON.parse(json.stdout).job).toMatchObject({ runner_usage_partial: true });
    const complete = await runCli("admin", ["cancel", whole]);
    expect(complete.stdout).toContain(
      "runner-reported: wall 120 s, cpu 400 s, max resident 2048 MB",
    );
    expect(complete.stdout).not.toContain("partial");
    expect(
      JSON.parse((await runCli("admin", ["cancel", whole, "--json"])).stdout).job,
    ).toMatchObject({ runner_usage_partial: false });
  });

  test("usage with no mark is shown as (partial: unknown) in every view, and in the CSV, never as whole (MUTATION: drop the unknown note from partialNote, or the unknown word from the CSV)", async () => {
    const w = await world();
    const unmarked = runnerJob({
      account: w.account,
      runnerId: RUNNER_A,
      state: "finished",
      usage: { wall: 61, cpu: 240, rss: 100, partial: null },
    });
    const list = await runCli("admin", ["list", "--runner", RUNNER_A]);
    expect(lineOf(list.stdout, unmarked)).toContain("cpu 240 s (partial: unknown)");
    expect(lineOf(list.stdout, w.whole)).not.toContain("partial");
    const record = await runCli("admin", ["record", unmarked]);
    expect(record.stdout).toContain("max resident 100 MB (partial: unknown)");
    const report = await runCli("admin", REPORT_ARGS(w.account));
    expect(lineOf(report.stdout, unmarked)).toContain("cpu 240 s (partial: unknown)");
    expect(report.stdout).toContain(
      "; usage of 1 job(s) is a lower bound (partial: Docker or Podman)" +
        "; usage of 1 job(s) has no partial mark (partial: unknown)",
    );
    const csv = await runCli("admin", [...REPORT_ARGS(w.account), "--csv"]);
    const cells = lineOf(csv.stdout, unmarked).split(",");
    expect(cells.slice(11)).toEqual(["runner", "none", RUNNER_A, "61", "240", "100", "unknown"]);
    // The job that has not reported has no usage and no note, and the whole one has a plain "no".
    expect(lineOf(csv.stdout, w.waiting).split(",").slice(17)).toEqual([""]);
    expect(lineOf(csv.stdout, w.whole).split(",").slice(17)).toEqual(["no"]);
  });

  test("a runner total over jobs that have not reported says so instead of printing zeros (MUTATION: drop the reported count and the no-usage phrase from the runner totals line)", async () => {
    const tapis = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET created_at = '2026-10-05 10:00:00' WHERE id = ?",
      tapis.job.id,
    );
    runnerJob({ account: tapis.accountId, runnerId: RUNNER_B });
    const r = await runCli("admin", REPORT_ARGS(tapis.accountId));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "runner jobs (runner-reported, never service units): 1 job(s), 0 with usage reported, no usage reported yet",
    );
    expect(r.stdout).not.toContain("wall 0 s");
    expect(r.stdout).not.toContain("0.000");
  });

  test("a job is shown in service units by its accounting, not its executor, in the CSV, the list and the report lines (MUTATION: key the CSV's SU cells on the executor)", async () => {
    const tapis = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET created_at = '2026-10-05 10:00:00' WHERE id = ?",
      tapis.job.id,
    );
    // A runner job accounted in service units has an SU figure; its runner figures come with it.
    const accounted = runnerJob({
      account: tapis.accountId,
      runnerId: RUNNER_A,
      state: "finished",
      usage: { wall: 120, cpu: 400, rss: 2048, partial: 0 },
      accounting: "su",
      chargedMilli: 2000,
    });
    const csv = await runCli("admin", [...REPORT_ARGS(tapis.accountId), "--csv"]);
    const cells = lineOf(csv.stdout, accounted).split(",");
    expect(cells.slice(7, 10)).toEqual(["2", "yes", "0"]);
    expect(cells.slice(11)).toEqual(["runner", "su", RUNNER_A, "120", "400", "2048", "no"]);
    const report = await runCli("admin", REPORT_ARGS(tapis.accountId));
    expect(lineOf(report.stdout, accounted)).toContain(
      `2 SU, runner ${RUNNER_A}, runner-reported wall 120 s, cpu 400 s`,
    );
    const list = await runCli("admin", ["list", "--runner", RUNNER_A]);
    expect(lineOf(list.stdout, accounted)).toContain(
      `2 SU, runner ${RUNNER_A}, runner-reported wall 120 s, cpu 400 s`,
    );
  });
});
