/**
 * `nemar admin compute derivatives list|show|promote|sync` (portable compute, card V1b; ADR 0123), driven
 * through the real entry point against the REAL routes: the Worker's admin router behind its real
 * authentication and admin middleware, over real SQLite carrying every migration, served on a loopback port
 * and reached through TEST_API_URL. The derivatives bucket is Miniflare's R2 through the Worker's own
 * binding. What the command prints is what the route answers.
 *
 * The properties, each with a test of its own: a Worker whose store is not bound exits 1 with
 * `derivatives_unavailable` for every command; `list` prints, filters and prints pure JSON under `--json`;
 * `show` prints a row and says when it has no description yet; `promote` raises one step, an administrator is
 * refused `published` with `owner_only` and the owner is not, an unknown key and a class that is not one exit 1
 * with the word; `sync` prints its counts; wrong arguments are refused before anything is sent; a member's key
 * and no key exit 1.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { Miniflare } from "miniflare";
import type { Bindings } from "../backend/src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import {
  type LifecycleFixture,
  startLifecycleFixture,
} from "../backend/test/helpers/compute-lifecycle-fixture";
import { seedEegDataset } from "../backend/test/helpers/compute-pipeline-fixture";
import { retryInfrastructure } from "../backend/test/helpers/neurobagel-harness";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let fx: LifecycleFixture;
let host: Miniflare;
let derivatives: R2Bucket;
let configDir: string;
/** Requests the server saw (the `/notices` call of the CLI is not counted). */
let seen: string[] = [];
/** What the Worker's environment is for a request: the store bound, unless a test says. */
let workerEnv: Partial<Bindings> = {};

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    return handle(
      req,
      fx.env({
        ENVIRONMENT: "development",
        COMPUTE_DERIVATIVES: derivatives,
        COMPUTE_DERIVATIVES_BUCKET_NAME: "nemar-compute-derivatives",
        ...workerEnv,
      }),
    );
  },
});
const API = `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  const infra = await retryInfrastructure("miniflare", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2024-12-01",
      r2Buckets: ["COMPUTE_DERIVATIVES"],
    });
    try {
      const bucket = (await mf.getR2Bucket("COMPUTE_DERIVATIVES")) as unknown as R2Bucket;
      await bucket.list({ limit: 1 });
      return { mf, bucket };
    } catch (err) {
      await mf.dispose().catch(() => {});
      throw err;
    }
  });
  host = infra.mf;
  derivatives = infra.bucket;
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await host?.dispose();
  await fx?.dispose();
}, 30_000);

beforeEach(async () => {
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
  seen = [];
  workerEnv = {};
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-derivatives-cli-"));
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
  group: string[] = ["compute", "derivatives"],
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
    cmd: ["bun", "run", CLI_ENTRY, "admin", ...group, ...args],
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

const KEY = "a1".repeat(32);

/** A stored `canary` derivative of `nm000104`, written with SQL the table accepts. */
async function seedStored(key = KEY, dataset = "nm000104"): Promise<void> {
  // A derivative is kept only while its dataset is there: the promotions check it.
  await seedEegDataset(fx.env(), dataset);
  await fx
    .env()
    .DB.prepare(
      `INSERT INTO compute_derivatives
         (key, dataset_id, version, recipe, recipe_version, engine, input, profile, input_digest,
          image_digest, job_id, stamp_id, state, copied, object_count, bytes, stored_at, expires_at)
       VALUES (?1, ?2, 'v1.0.0', 'nemar-floor', '1.0.0', 'eegprep@0.5.0', 'zarr', 'serving', ?3, ?4,
               ?5, ?6, 'stored', 2, 2, 100, datetime('now'), datetime('now', '+30 days'))`,
    )
    .bind(
      key,
      dataset,
      `sha256:${"b2".repeat(32)}`,
      `sha256:${"c3".repeat(32)}`,
      `job_${key.slice(0, 24)}`,
      Math.floor(Math.random() * 1_000_000) + 1,
    )
    .run();
}

describe("a Worker whose store is not bound", () => {
  test("every command exits 1 with derivatives_unavailable", async () => {
    workerEnv = { COMPUTE_DERIVATIVES: undefined };
    for (const args of [["list"], ["show", KEY], ["promote", KEY], ["sync"]]) {
      const r = await runCli("admin", args);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("derivatives_unavailable");
    }
  });
});

describe("list and show", () => {
  test("list prints the derivative, filters by dataset, and prints pure JSON under --json", async () => {
    await seedStored();
    await seedStored("b7".repeat(32), "nm000105");
    const all = await runCli("admin", ["list"]);
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain(KEY);
    expect(all.stdout).toContain("nm000105");
    const one = await runCli("admin", ["list", "--dataset", "nm000105"]);
    expect(one.stdout).toContain("b7".repeat(32));
    expect(one.stdout).not.toContain(KEY);
    const json = await runCli("owner", ["list", "--json", "--limit", "1"]);
    expect(json.exitCode).toBe(0);
    expect((JSON.parse(json.stdout) as { derivatives: unknown[] }).derivatives).toHaveLength(1);
    expect((await runCli("admin", ["list", "--dataset", "nm099998"])).stdout).toContain(
      "No derivatives.",
    );
  });

  test("show prints a row, and says a stored one has no description until it is written", async () => {
    await seedStored();
    const r = await runCli("admin", ["show", KEY]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(KEY);
    expect(r.stdout).toContain("canary");
    expect(r.stdout).toContain("no description yet");
    await derivatives.put(
      `d/${KEY}/derivative.json`,
      JSON.stringify({
        Citation: "Derived from nm000104 version v1.0.0 by NEMAR's nemar-floor 1.0.0.",
      }),
    );
    const again = await runCli("admin", ["show", KEY]);
    expect(again.stdout).toContain("Derived from nm000104 version v1.0.0");
    const json = await runCli("admin", ["show", KEY, "--json"]);
    expect(
      (JSON.parse(json.stdout) as { description: { Citation: string } }).description.Citation,
    ).toContain("nemar-floor");
    const missing = await runCli("admin", ["show", "f".repeat(64)]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout + missing.stderr).toContain("derivative_not_found");
  });
});

describe("promote", () => {
  test("an administrator raises to catalog, is refused published, and the owner is not", async () => {
    await seedStored();
    const catalog = await runCli("admin", ["promote", KEY]);
    expect(catalog.exitCode).toBe(0);
    expect(catalog.stdout).toContain("raised to catalog");
    const refused = await runCli("admin", ["promote", KEY, "--to", "published", "--yes"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout + refused.stderr).toContain("owner_only");
    const owner = await runCli("owner", ["promote", KEY, "--to", "published", "--yes", "--json"]);
    expect(owner.exitCode).toBe(0);
    expect(
      (JSON.parse(owner.stdout) as { derivative: { retention: string; doi: null } }).derivative,
    ).toMatchObject({ retention: "published", doi: null });
    // No step back: the same request again is refused with its word.
    const again = await runCli("owner", ["promote", KEY, "--to", "published", "--yes"]);
    expect(again.exitCode).toBe(1);
    expect(again.stdout + again.stderr).toContain("not_promotable");
  });

  test("raising to published asks first, and without a yes sends nothing (MUTATION: skip the question)", async () => {
    await seedStored();
    expect((await runCli("admin", ["promote", KEY])).exitCode).toBe(0);
    seen = [];
    // Standard input is not a terminal here, so the question cannot be answered: nothing is changed.
    const asked = await runCli("owner", ["promote", KEY, "--to", "published"]);
    expect(asked.exitCode).toBe(1);
    expect(asked.stdout + asked.stderr).toContain("not answered yes");
    expect(seen).toEqual([]);
    const row = await fx
      .env()
      .DB.prepare("SELECT retention FROM compute_derivatives WHERE key = ?1")
      .bind(KEY)
      .first<{ retention: string }>();
    expect(row?.retention).toBe("catalog");
    // A catalog promotion needs no question.
    expect((await runCli("admin", ["promote", "--help"])).stdout).toContain("--yes");
  });

  test("the compute help names the derivative store and the sync help says what it bounds", async () => {
    const compute = await runCli("admin", ["--help"], ["compute"]);
    expect(compute.exitCode).toBe(0);
    expect(compute.stdout.replace(/\s+/g, " ")).toContain("derivative store");
    expect(compute.stdout).toContain("derivatives");
    const sync = await runCli("admin", ["sync", "--help"]);
    expect(sync.stdout.replace(/\s+/g, " ")).toContain("at most 150");
  });

  test("an unknown key exits 1 with its word", async () => {
    const r = await runCli("admin", ["promote", "e5".repeat(32)]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("derivative_not_found");
  });
});

describe("sync", () => {
  test("it prints the counts of one pass, and its JSON is the Worker's answer", async () => {
    const r = await runCli("admin", ["sync", "--max-objects", "5"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("examined 0: created 0");
    const json = await runCli("owner", ["sync", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, examined: 0, copied: 0 });
  });
});

describe("arguments and keys", () => {
  test("wrong arguments are refused before anything is sent", async () => {
    for (const args of [
      ["list", "--dataset", "nope"],
      ["list", "--limit", "0"],
      ["list", "--limit", "201"],
      ["show", "short"],
      ["promote", "short"],
      ["promote", KEY, "--to", "forever"],
      ["promote", KEY, "--to", "canary"],
      ["sync", "--max-objects", "0"],
      ["sync", "--max-objects", "151"],
      ["sync", "--max-objects", "201"],
    ]) {
      const r = await runCli("admin", args);
      expect(r.exitCode, args.join(" ")).toBe(1);
    }
    expect(seen).toEqual([]);
  });

  test("a member's key and no key exit 1", async () => {
    await seedStored();
    const member = await runCli("member", ["list"]);
    expect(member.exitCode).toBe(1);
    const none = await runCli(null, ["list"]);
    expect(none.exitCode).toBe(1);
    expect(seen.filter((s) => s.includes("derivatives")).length).toBeLessThanOrEqual(1);
  });
});
