/**
 * `nemar admin compute status` (epic #2005 phase A4, #2009; ADR 0118), driven through the real entry
 * point against the REAL route: the Worker's admin router behind its real authentication and admin
 * middleware, over real SQLite carrying every migration, served on a loopback port and reached
 * through TEST_API_URL, with the Tapis stand-in behind it (which recorded nothing from a real tenant).
 * What the command prints is what the route answers.
 *
 * The properties, each with a test of its own:
 *  - an unconfigured Worker prints `unconfigured` and exits 0, and `--json` prints the Worker's answer
 *    and nothing else on standard output;
 *  - a configured one prints the strategy, the token step and the health step as fixed words;
 *  - no secret value, no tenant address and no username is in any output, in either form;
 *  - an answer with keys the CLI does not know is shown, not refused (the schema is open);
 *  - a member's key and no key at all exit 1.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { putPolicy } from "../backend/src/services/compute-policy";
import { __resetTapisTokenCacheForTests } from "../backend/src/services/tapis/auth";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  computeEnv,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { type TapisStandin, startTapisStandin } from "../backend/test/helpers/tapis-standin";
import { DEFAULT_COMPUTE_POLICY } from "../shared/contract/compute";
import { ComputeStatusResponseSchema } from "../shared/contract/compute-admin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let db: Database;
let configDir: string;
let standin: TapisStandin;
let previousOverride: string | undefined;
/** The bindings the Worker the command talks to has. */
let workerEnv: Record<string, unknown> = {};
/** When set, the route's answer gets keys a newer Worker would add. */
let augment = false;
/** When set, the route's answer lacks the field a Worker from before it would not send. */
let olderWorker = false;

const SECRETS = {
  password: "cli-password-mark-4410",
  serviceToken: "cli-service-token-mark-4410",
  username: "cli-username-mark-4410",
  tenant: "cli-tenant-mark-4410",
  access: "cli-access-key-mark-4410",
  accessResource: "cli-access-resource-mark-4410",
};

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    const res = await handle(req, computeEnv(db, workerEnv as never));
    if (augment && res.ok) {
      const body = (await res.json()) as Record<string, any>;
      body.future_top_level = { added: "by a newer worker" };
      body.tapis.future_nested = 7;
      return Response.json(body, { status: res.status });
    }
    if (olderWorker && res.ok) {
      const body = (await res.json()) as Record<string, any>;
      body.access.resource_name_configured = undefined;
      body.prerequisites = undefined;
      body.reconciliation = undefined;
      body.attention = undefined;
      body.tenant = undefined;
      return Response.json(body, { status: res.status });
    }
    return res;
  },
});
const API = `http://127.0.0.1:${server.port}`;

beforeAll(() => {
  standin = startTapisStandin({
    tenantId: SECRETS.tenant,
    username: SECRETS.username,
    password: SECRETS.password,
    serviceToken: SECRETS.serviceToken,
  });
  previousOverride = (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL;
});

afterAll(() => {
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = previousOverride;
  standin.stop();
  server.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  await seedComputeUsers(db);
  workerEnv = {};
  augment = false;
  olderWorker = false;
  standin.reset();
  __resetTapisTokenCacheForTests();
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = undefined;
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-status-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function configuredWorker(over: Record<string, unknown> = {}) {
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = standin.url;
  workerEnv = {
    TAPIS_AUTH_STRATEGY: "password",
    TAPIS_BASE_URL: `https://${SECRETS.tenant}.invalid`,
    TAPIS_TENANT_ID: SECRETS.tenant,
    TAPIS_USERNAME: SECRETS.username,
    TAPIS_PASSWORD: SECRETS.password,
    ACCESS_GATEWAY_ATTRIBUTES_KEY: SECRETS.access,
    ACCESS_RESOURCE_NAME: SECRETS.accessResource,
    ...over,
  };
}

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
    // Set by the harness that runs this suite, and a warning on standard error when NO_COLOR is also set.
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", ...args],
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

function expectNoSecrets(r: Ran) {
  const all = r.stdout + r.stderr;
  for (const value of Object.values(SECRETS)) expect(all).not.toContain(value);
  expect(all).not.toContain(standin.url);
  expect(all).not.toContain(`127.0.0.1:${new URL(standin.url).port}`);
  expect(all).not.toContain(".invalid");
}

describe("status", () => {
  /** A live job of `source` straight into the Worker's database (the columns a row needs). */
  const liveJob = (n: number, source: string, extra = "") => {
    const owner = (
      db.query("SELECT id FROM users WHERE username = 'cmp-owner'").get() as { id: number }
    ).id;
    db.run(
      `INSERT INTO compute_jobs (id, account_id, source, kind, app_id, app_version, spec_digest,
                                 partition, pool, nodes, cores_per_node, minutes, state ${extra.split("=>")[0]})
       VALUES (?, ?, ?, 'batch', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1, 'running' ${extra.split("=>")[1] ?? ""})`,
      [`job_${String(n).padStart(24, "0")}`, owner, source, "a".repeat(64)],
    );
  };

  test("prints the tenant ceiling: occupied of the ceiling, by class", async () => {
    liveJob(1, "pipeline");
    liveJob(2, "pipeline");
    liveJob(3, "cli");
    liveJob(4, "web");
    liveJob(5, "partner", ", flag_unreserved=>, 1");
    const r = await runCli("admin", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Tenant: 5/20 (people 2, pipelines 2, partner 0, other 1)");
    expect(r.stdout).not.toContain("tenant_over_ceiling");
    const j = await runCli("admin", ["status", "--json"]);
    expect(JSON.parse(j.stdout).tenant).toEqual({
      ceiling: 20,
      occupied: 5,
      by_class: { people: 2, pipelines: 2, partner: 0, other: 1 },
      reserved: { people: 8, pipelines: 2, partner: 0 },
    });
  });

  test("a count above the owner's ceiling is an attention line", async () => {
    const owner = (
      db.query("SELECT id FROM users WHERE username = 'cmp-owner'").get() as { id: number }
    ).id;
    const put = await putPolicy(
      realD1(db),
      owner,
      {
        ...DEFAULT_COMPUTE_POLICY,
        tenant: { maxLiveJobs: 1, reserved: { people: 0, pipelines: 0, partner: 0 } },
      },
      null,
    );
    expect(put.ok).toBe(true);
    liveJob(1, "pipeline");
    liveJob(2, "partner", ", flag_unreserved=>, 1");
    const r = await runCli("admin", ["status"]);
    expect(r.stdout).toContain("Tenant: 2/1 (people 0, pipelines 1, partner 0, other 1)");
    expect(r.stdout).toContain("Attention: tenant_over_ceiling 1");
  });

  test("an unreadable owner policy is said, with what it means, and the Tenant line is absent", async () => {
    const owner = (
      db.query("SELECT id FROM users WHERE username = 'cmp-owner'").get() as { id: number }
    ).id;
    db.run("INSERT INTO compute_policy (policy_json, set_by) VALUES (?, ?)", [
      JSON.stringify({
        ...DEFAULT_COMPUTE_POLICY,
        tenant: { maxLiveJobs: 1, reserved: { people: 1, pipelines: 1, partner: 1 } },
      }),
      owner,
    ]);
    const r = await runCli("admin", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "Attention: policy_unreadable 1 (the stored owner policy cannot be read",
    );
    expect(r.stdout).not.toContain("Tenant:");
  });

  test("a Worker from before the tenant block prints no Tenant line", async () => {
    olderWorker = true;
    const r = await runCli("admin", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("Tenant:");
  });

  test("an unconfigured Worker prints `unconfigured` and exits 0", async () => {
    const r = await runCli("admin", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("environment: production");
    expect(r.stdout).toContain("compute switch: off");
    expect(r.stdout).toContain("pipelines dispatch switch: off");
    expect(r.stdout).toContain("token: unconfigured");
    expect(r.stdout).toContain("health: unconfigured");
    expect(r.stdout).toContain("configured: no");
    expect(r.stdout).toContain("TAPIS_AUTH_STRATEGY:missing");
    expect(r.stdout).toContain("records binding: no");
    expect(r.stdout).toContain("ACCESS key: no");
    expect(r.stdout).toContain("ACCESS resource name: no");
    expect(r.stdout).toContain("ACCESS reports wait until both are set");
    expect(r.stdout).toContain("Runtime image");
    expect(r.stdout).toContain("set: no (a python job stays created until it is)");
    expect(standin.log).toHaveLength(0);
    expectNoSecrets(r);
  });

  test("--json prints the Worker's answer, and only that, on standard output", async () => {
    const r = await runCli("admin", ["status", "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(ComputeStatusResponseSchema.safeParse(body).success).toBe(true);
    expect(body.tapis).toMatchObject({ configured: false, token: "unconfigured" });
    expect(body.switches).toEqual({
      environment: "production",
      compute_enabled: false,
      pipelines_dispatch_enabled: false,
    });
    expect(r.stderr.trim()).toBe("");
  });

  test("a configured Worker prints the strategy and both steps as fixed words, and no secret", async () => {
    configuredWorker({ COMPUTE_ENABLED: "1" });
    const r = await runCli("owner", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("compute switch: on");
    expect(r.stdout).toContain("configured: yes (strategy password)");
    expect(r.stdout).toContain("token: ok");
    expect(r.stdout).toContain("health: ok");
    expect(r.stdout).toContain("ACCESS key: yes");
    expect(r.stdout).toContain("ACCESS resource name: yes");
    expect(r.stdout).not.toContain("ACCESS reports wait");
    expectNoSecrets(r);
    const j = await runCli("owner", ["status", "--json"]);
    expect(JSON.parse(j.stdout).tapis).toEqual({
      configured: true,
      strategy: "password",
      problems: [],
      token: "ok",
      health: "ok",
    });
    expectNoSecrets(j);
  });

  test("a key without a resource name is not `configured`: the command says the reports wait, by name, and never the values", async () => {
    configuredWorker({ ACCESS_RESOURCE_NAME: undefined });
    const r = await runCli("owner", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ACCESS key: yes");
    expect(r.stdout).toContain("ACCESS resource name: no");
    expect(r.stdout).toContain("ACCESS reports wait until both are set");
    expectNoSecrets(r);
    const j = await runCli("owner", ["status", "--json"]);
    expect(JSON.parse(j.stdout).access).toEqual({
      key_configured: true,
      resource_name_configured: false,
    });
    expectNoSecrets(j);
  });

  test("a Worker from before `resource_name_configured` is shown as unknown, never as not set", async () => {
    olderWorker = true;
    configuredWorker();
    const r = await runCli("owner", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ACCESS key: yes");
    expect(r.stdout).toContain("ACCESS resource name: unknown (this Worker does not report it)");
    expect(r.stdout).not.toContain("ACCESS reports wait");
    // The same older Worker has no prerequisites, no reconciliation line and no counts: unknown, not "no".
    expect(r.stdout).toContain("unknown (this Worker does not report them)");
    expect(r.stdout).not.toContain("Reconciliation paused");
    expectNoSecrets(r);
  });

  test("the prerequisites are printed as yes or no (never a value), and a paused reconciliation and a failed ACCESS report are said", async () => {
    configuredWorker({
      PRESCREEN_CALLBACK_SECRET: "callback-secret-mark-5521",
      API_BASE_URL: "https://api-base-mark-5521.invalid",
    });
    db.run(
      `INSERT INTO compute_access_reports (job_id, state, attempts, last_error_code)
       VALUES ('job_00000000000000000000000a', 'failed', 3, 'outcome_unknown')`,
    );
    const r = await runCli("owner", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("callback secret: yes");
    expect(r.stdout).toContain("API base address: yes");
    expect(r.stdout).toContain("pipelines service account: no");
    expect(r.stdout).toContain("owner policy: not set (the default applies)");
    expect(r.stdout).toContain("people pool granted: no");
    expect(r.stdout).toContain("pipelines pool granted: no");
    expect(r.stdout).toContain("Reconciliation paused: compute is off");
    expect(r.stdout).toContain("Attention: access_reports_failed 1");
    expect(r.stdout + r.stderr).not.toContain("mark-5521");
    // With compute on, the reconciliation line is gone.
    configuredWorker({ COMPUTE_ENABLED: "1" });
    const on = await runCli("owner", ["status"]);
    expect(on.stdout).not.toContain("Reconciliation paused");
    expect(on.stdout).toContain("callback secret: no");
    expectNoSecrets(r);
  });

  test("a cancel stuck for an hour and an abandoned copy are printed as attention counts, and a quiet Worker prints neither", async () => {
    configuredWorker({});
    const quiet = await runCli("owner", ["status"]);
    expect(quiet.stdout).not.toContain("cancel_pending_failed");
    expect(quiet.stdout).not.toContain("copy_abandoned");
    const owner = db.query("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as {
      id: number;
    };
    const insert = (id: string, cols: string, vals: string) =>
      db.run(
        `INSERT INTO compute_jobs (id, account_id, source, kind, app_id, app_version, spec_digest, partition, pool, nodes, cores_per_node, minutes, ${cols})
         VALUES (?, ?, 'cli', 'batch', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1, ${vals})`,
        [id, owner.id, "a".repeat(64)],
      );
    insert(
      "job_0000000000000000000000d1",
      "state, tapis_uuid, cancel_requested_at",
      "'running', 'u-d1', datetime('now', '-3 hours')",
    );
    insert(
      "job_0000000000000000000000d2",
      "state, ended_at, settled_provisional_at",
      "'finished', datetime('now', '-5 days'), datetime('now', '-5 days')",
    );
    const r = await runCli("owner", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Attention: cancel_pending_failed 1");
    expect(r.stdout).toContain("Attention: copy_abandoned 1");
    expect(r.stdout).not.toContain("Attention: access_reports_failed");
  });

  test("the two runner attention words are printed with what they mean when positive, and not otherwise (MUTATION: drop either hint, or the executor term of the Worker's count)", async () => {
    configuredWorker({});
    const quiet = await runCli("owner", ["status"]);
    expect(quiet.stdout).not.toContain("runner_cancel_pending_failed");
    expect(quiet.stdout).not.toContain("runner_copy_abandoned");
    const insert = (id: string, cols: string, vals: string) =>
      db.run(
        `INSERT INTO compute_jobs (id, source, kind, app_id, app_version, spec_digest, partition, pool, nodes, cores_per_node, minutes, executor, accounting, ${cols})
         VALUES (?, 'pipeline', 'batch', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1, 'runner', 'none', ${vals})`,
        [id, "a".repeat(64)],
      );
    insert(
      "job_0000000000000000000000e1",
      "state, cancel_requested_at",
      "'running', datetime('now', '-61 minutes')",
    );
    insert(
      "job_0000000000000000000000e2",
      "state, ended_at, settled_provisional_at",
      "'finished', datetime('now', '-5 days'), datetime('now', '-5 days')",
    );
    insert(
      "job_0000000000000000000000e3",
      "state, created_at",
      "'created', datetime('now', '-130 minutes')",
    );
    const r = await runCli("owner", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "Attention: runner_records_unwritten 1 (a waiting runner job's records never landed",
    );
    expect(r.stdout).toContain(
      "Attention: runner_cancel_pending_failed 1 (a runner job's recorded cancel",
    );
    expect(r.stdout).toContain(
      "Attention: runner_copy_abandoned 1 (a terminal runner job's launcher files",
    );
    // The Tapis words are about Tapis rows only.
    expect(r.stdout).not.toContain("Attention: cancel_pending_failed");
    expect(r.stdout).not.toContain("Attention: copy_abandoned");
  });

  test("the runtime image: its digest when valid, a plain word when set to something that is not a pinned reference, and never the reference", async () => {
    const hex = "5".repeat(64);
    configuredWorker({
      COMPUTE_RUNTIME_IMAGE: `ghcr.io/example-owner/example-image@sha256:${hex}`,
    });
    const valid = await runCli("owner", ["status"]);
    expect(valid.exitCode).toBe(0);
    expect(valid.stdout).toContain(`set: yes, digest sha256:${hex}`);
    expect(valid.stdout).not.toContain("example-owner");
    expect(JSON.parse((await runCli("owner", ["status", "--json"])).stdout).runtime_image).toEqual({
      set: true,
      valid: true,
      digest: `sha256:${hex}`,
    });

    configuredWorker({ COMPUTE_RUNTIME_IMAGE: "ghcr.io/example-owner/example-image:latest" });
    const invalid = await runCli("owner", ["status"]);
    expect(invalid.stdout).toContain(
      "set: yes, but not a digest-pinned reference (a python job stays created)",
    );
    expect(invalid.stdout).not.toContain("example-owner");
  });

  test("a credential Tapis refuses prints `unauthorized`, and still exits 0", async () => {
    configuredWorker({ TAPIS_PASSWORD: "not-the-password" });
    const r = await runCli("admin", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("token: unauthorized");
    expect(r.stdout).toContain("health: ok");
    expectNoSecrets(r);
  });

  test("a server that is down prints `unavailable` for both steps", async () => {
    configuredWorker();
    standin.down();
    try {
      const r = await runCli("admin", ["status"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("token: unavailable");
      expect(r.stdout).toContain("health: unavailable");
      expectNoSecrets(r);
    } finally {
      standin.up();
    }
  });

  test("an answer with keys the CLI does not know is shown, not refused", async () => {
    augment = true;
    const r = await runCli("admin", ["status", "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.future_top_level).toEqual({ added: "by a newer worker" });
    expect(body.tapis.future_nested).toBe(7);
    const human = await runCli("admin", ["status"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("token: unconfigured");
  });

  test("a member's key and no key at all exit 1, and print no status", async () => {
    const member = await runCli("member", ["status"]);
    expect(member.exitCode).toBe(1);
    expect(member.stdout).not.toContain("compute switch");
    const none = await runCli(null, ["status", "--json"]);
    expect(none.exitCode).toBe(1);
    expect(none.stdout.trim()).toBe("");
  });
});
