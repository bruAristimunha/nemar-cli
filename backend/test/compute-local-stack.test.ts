/**
 * The local control-plane stack (portable compute, card DM-08): `backend/scripts/compute-local-stack.ts`
 * run for real, over a temporary state directory, with NEMAR's REAL admin, compute, runner and webhook
 * routers, a real migrated SQLite file and Miniflare's R2 behind the S3 stand-in. Nothing of NEMAR is
 * stood in for. The one external stand-in is a `Bun.serve` that answers as the public API's dataset
 * record does (for `--seed-from-catalog`, so no case needs the network).
 *
 * What is pinned, each with a test of its own:
 *  - the stack binds loopback only (its API and its S3 stand-in are unreachable on the machine's other
 *    address), refuses any other host, a tag instead of a digest, and a live or reserved dataset id
 *    before it creates anything;
 *  - the state is private: every file is mode 0600 and every directory 0700, `s3.json` holds two random
 *    values and not the test stand-in's public defaults, and the banner prints no key;
 *  - an owner registers a runner through the real admin route with the stored owner key, a registration
 *    secret buys an access token, `GET /compute/runners/me` answers, and after a restart over the same
 *    state the runner is still registered, a new token still opens `/me`, the keys still work, the seeds
 *    are not repeated and an R2 object is still there;
 *  - a migration the database lacks is applied at the next start and no row is lost; a database that is
 *    not this stack's is refused;
 *  - `outputs` downloads a finished job's results through the real links route (the second page by the
 *    `after` cursor), prints names and sizes only, and refuses a job that is not the pipelines account's;
 *  - the command line: `serve` prints the banner and answers `/health`, refuses `--host` other than loopback and a
 *    missing value.
 * MUTATIONS, each run alone: bind the API or the S3 stand-in without `hostname`; drop the `hostname` guard;
 * drop `umask` or the `chmod` of a secret; let `s3Credentials` fall back to the public defaults; apply a
 * migration without recording it (or record without applying); drop the idempotency key of a seed grant;
 * drop the `after` cursor of `downloadOutputs`; drop the path-escape check of `downloadOutputs`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { resultsOutputKey } from "../../shared/contract/compute-launch";
import {
  RunnerRegisterResponseSchema,
  RunnerTokenResponseSchema,
} from "../../shared/contract/compute-runner";
import {
  FIXTURE_DATASET_ID,
  FIXTURE_SOURCE_COMMIT,
  type LocalStack,
  catalogRefusal,
  downloadOutputs,
  hardenTree,
  isInside,
  startLocalStack,
  treeModes,
  usableSecret,
} from "../scripts/compute-local-stack";
import { createJob } from "../src/services/compute-jobs";
import { recordKey } from "../src/services/compute-records";
import { declaredKey, declaredText } from "../src/services/compute-verify";
import { launchableSpec } from "./helpers/compute-lifecycle-fixture";
import { loopbackHostAllowed, startComputeS3Standin } from "./helpers/compute-s3-standin";
import { sha256Hex } from "./helpers/compute-seed";
import { APPLIED_MIGRATIONS_TABLE, openMigratedDb } from "./helpers/d1";
import { migrationFiles } from "./helpers/miniflare-d1";

const SCRIPT = join(import.meta.dir, "..", "scripts", "compute-local-stack.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const IMAGE = `ghcr.io/example/nemar-python@sha256:${"a".repeat(64)}`;
const encoder = new TextEncoder();

// biome-ignore lint/suspicious/noExplicitAny: bodies are read field by field
type Loose = Record<string, any>;

const scratch: string[] = [];
const fresh = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `nemar-local-stack-${label}-`));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** An address of this machine that is not loopback, or null when it has none. */
function otherAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const { family, internal, address } of list ?? []) {
      if (family === "IPv4" && !internal) return address;
    }
  }
  return null;
}

/**
 * The addresses something in this process listens on at `port`, read from the operating system
 * (`lsof`), as `127.0.0.1` or `*` (every interface); empty when `lsof` is not available.
 */
async function listeningOn(port: number): Promise<string[]> {
  try {
    const proc = spawn({
      cmd: ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out
      .split("\n")
      .filter((l) => l.startsWith("n"))
      .map((l) => l.slice(1).replace(new RegExp(`:${port}$`), ""));
  } catch {
    return [];
  }
}

/** Whether something answers a TCP connection at `host:port` within a second. */
async function reachable(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) });
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function call(
  base: string,
  method: string,
  path: string,
  o: { bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: Loose; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(o.bearer ? { Authorization: `Bearer ${o.bearer}` } : {}),
      ...(o.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  let body: Loose = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, text };
}

/**
 * One HTTP request over a raw socket, so the `Host` header is exactly what the test says (or absent, which
 * HTTP/1.0 allows and `fetch` cannot send). Returns the status code and the body.
 */
function rawGet(
  port: number,
  path: string,
  host: string | null,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolveReply, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("no answer"));
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
      resolveReply({ status, body: data.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
    });
    const lines = [`GET ${path} ${host === null ? "HTTP/1.0" : "HTTP/1.1"}`];
    if (host !== null) lines.push(`Host: ${host}`);
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    socket.write(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`);
  });
}

/** The hosts a guarded loopback server must refuse, and the spellings it must serve, for `port`. */
function hostCases(port: number) {
  return {
    refused: [
      `evil.example:${port}`,
      "evil.example",
      `2130706434:${port}`,
      `[::1]:${port}`,
      `[::]:${port}`,
      `127.0.0.1:${port + 1}`,
      `localhost:${port + 1}`,
      "127.0.0.1",
      "localhost",
      `127.0.0.1.evil.example:${port}`,
      "",
    ],
    served: [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`],
  };
}

const REGISTRATION = {
  name: "lab_a_cpu",
  pool: "cpu",
  cores: 16,
  memory_mb: 64_000,
  gpus: 0,
  scratch_gb: 500,
  backend: "local",
  runtimes: ["docker"],
  arch: "amd64",
  accounting: "none",
  site: "lab_a",
  trust: "lab",
};
const RUN_BODY = { protocol: "nemar.runner.v1", runner_version: "0.1.0" };

const count = (stack: LocalStack, sql: string, ...binds: unknown[]) =>
  (stack.db.query(sql).get(...(binds as never[])) as { n: number }).n;

// --- The helpers this card changed ----------------------------------------------------------------------

describe("the persistent database", () => {
  test("a missing migration is applied at the next open, and nothing is reset", () => {
    const dir = fresh("db");
    const path = join(dir, "stack.sqlite");
    const files = migrationFiles();
    const first = openMigratedDb(path, files.slice(0, -1));
    expect(first.applied).toEqual(files.slice(0, -1));
    const usersBefore = (first.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number })
      .n;
    first.db.run(
      "INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, service_access, account_kind) VALUES ('kept', 'kept@example.test', 'x', 'approved', 'member', 'cli', 1, 0, 'person')",
    );
    first.db.close();

    const second = openMigratedDb(path);
    expect(second.applied).toEqual(files.slice(-1));
    expect((second.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(
      usersBefore + 1,
    );
    expect(second.db.query("SELECT 1 FROM users WHERE username = 'kept'").get()).not.toBeNull();
    const recorded = (
      second.db.query(`SELECT COUNT(*) AS n FROM ${APPLIED_MIGRATIONS_TABLE}`).get() as {
        n: number;
      }
    ).n;
    expect(recorded).toBe(files.length);
    second.db.close();

    const third = openMigratedDb(path);
    expect(third.applied).toEqual([]);
    third.db.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a database this function did not make is refused, and left alone", () => {
    const dir = fresh("foreign");
    const path = join(dir, "other.sqlite");
    const { db } = openMigratedDb(path, []);
    db.exec(`DROP TABLE ${APPLIED_MIGRATIONS_TABLE}; CREATE TABLE somebody_elses (x INTEGER)`);
    db.close();
    expect(() => openMigratedDb(path)).toThrow(/no migration record/);
  });
});

describe("the S3 stand-in", () => {
  // The address a server listens on is not asserted here: under `bun test` a preload makes loopback the
  // default of every `Bun.serve`, so a missing `hostname` would pass in this process. The spawned `serve`
  // case below asks the operating system instead.
  test("takes the credentials and the port it is given", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    const standin = startComputeS3Standin({
      buckets: {},
      accessKeyId: "given-access-key",
      secretAccessKey: "given-secret-key",
      port,
    });
    try {
      expect(standin.url).toBe(`http://127.0.0.1:${port}`);
      expect(standin.accessKeyId).toBe("given-access-key");
      expect(standin.secretAccessKey).toBe("given-secret-key");
      expect(await reachable("127.0.0.1", port)).toBe(true);
    } finally {
      standin.stop();
    }
  });

  test("with hostGuard it serves only the two loopback spellings of its own port", async () => {
    const standin = startComputeS3Standin({ buckets: {}, port: 0, hostGuard: true });
    const port = Number(new URL(standin.url).port);
    const open = startComputeS3Standin({ buckets: {}, port: 0 });
    try {
      const cases = hostCases(port);
      for (const host of cases.refused) {
        const got = await rawGet(port, "/anything", host === "" ? null : host);
        expect({ host, status: got.status }).toEqual({ host, status: 421 });
        expect(got.body).toBe('{"error":"host_not_allowed"}');
      }
      for (const host of cases.served) {
        // Past the guard the stand-in answers its own way (an unsigned request is a 403), never the refusal.
        const got = await rawGet(port, "/bucket/key", host);
        expect({ host, status: got.status }).toEqual({ host, status: 403 });
      }
      expect(standin.log.length).toBe(cases.served.length);
      // Off by default: another Host is answered like any other request.
      const openPort = Number(new URL(open.url).port);
      expect((await rawGet(openPort, "/bucket/key", "evil.example")).status).toBe(403);
      expect(loopbackHostAllowed(null, port)).toBe(false);
    } finally {
      standin.stop();
      open.stop();
    }
  });
});

// --- The stack ----------------------------------------------------------------------------------------

describe("refusals that come before anything is created", () => {
  test("another host, a tag, a live dataset and a reserved id", async () => {
    const state = join(fresh("refuse"), "state");
    const base = { state, image: IMAGE, port: 0, s3Port: 0 };
    await expect(startLocalStack({ ...base, host: "::" })).rejects.toThrow(
      /binds 127\.0\.0\.1 only/,
    );
    await expect(
      startLocalStack({ ...base, image: "ghcr.io/example/nemar-python:latest" }),
    ).rejects.toThrow(/digest-pinned/);
    for (const id of ["nm000103", "nm000107", "nm099900", "nm099999", "nm099998"]) {
      await expect(startLocalStack({ ...base, seedFromCatalog: [id] })).rejects.toThrow(
        /live dataset|reserved fixture band/,
      );
    }
    await expect(startLocalStack({ ...base, seedFromCatalog: ["xx000001"] })).rejects.toThrow(
      /not a dataset id/,
    );
    // The fixture's own id lies in the live allocation range: it is never read from the catalog.
    await expect(
      startLocalStack({ ...base, seedFromCatalog: [FIXTURE_DATASET_ID] }),
    ).rejects.toThrow(/local fixture dataset/);
    expect(catalogRefusal(FIXTURE_DATASET_ID)).toMatch(/--seed-fixture/);
    expect(() => statSync(state)).toThrow();
    expect(catalogRefusal("nm000274")).toBeNull();
    expect(catalogRefusal("nm000102")).toBeNull();
    expect(catalogRefusal("nm000108")).toBeNull();
  });
});

describe("stored secrets that this stack could not have made", () => {
  const good = "0123456789abcdef".repeat(4);
  const other = "fedcba9876543210".repeat(4);

  test("usableSecret refuses the public defaults, short, constant and repeated values", () => {
    expect(usableSecret(good)).toBe(true);
    for (const bad of [
      "STANDINKEYID",
      "standin-secret-access-key",
      "0".repeat(64),
      "a".repeat(32),
      "ab".repeat(32),
      "abcd".repeat(16),
      "short",
      "",
      null,
      42,
    ]) {
      expect(usableSecret(bad)).toBe(false);
    }
  });

  test("a start refuses an s3.json, secret or keys.json holding one, and writes nothing over it", async () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        "s3.json",
        JSON.stringify({
          accessKeyId: "STANDINKEYID",
          secretAccessKey: "standin-secret-access-key",
        }),
        /s3\.json.*not usable/,
      ],
      [
        "s3.json",
        JSON.stringify({ accessKeyId: "0".repeat(64), secretAccessKey: other }),
        /s3\.json.*not usable/,
      ],
      [
        "s3.json",
        JSON.stringify({ accessKeyId: "ab".repeat(32), secretAccessKey: other }),
        /s3\.json.*not usable/,
      ],
      [
        "s3.json",
        JSON.stringify({ accessKeyId: good, secretAccessKey: good }),
        /s3\.json.*not usable/,
      ],
      ["secret", `${"0".repeat(64)}\n`, /secret.*not usable/],
      [
        "keys.json",
        JSON.stringify({ owner: good, admin: other, pipelines: "1".repeat(40) }),
        /keys\.json.*not usable/,
      ],
    ];
    for (const [file, text, message] of cases) {
      const state = join(fresh("badsecret"), "state");
      mkdirSync(state, { mode: 0o700 });
      writeFileSync(join(state, file), text, { mode: 0o600 });
      await expect(
        startLocalStack({ state, image: IMAGE, port: 0, s3Port: 0, log: () => {} }),
      ).rejects.toThrow(message);
      expect(readFileSync(join(state, file), "utf-8")).toBe(text);
    }
  }, 120_000);
});

describe("one state directory, started, restarted", () => {
  const state = join(fresh("stack"), "state");
  const lines: string[] = [];
  let stack: LocalStack;
  let runner: { runner_id: string; secret: string };
  let firstToken: string;

  const start = () =>
    startLocalStack({
      state,
      image: IMAGE,
      port: 0,
      s3Port: 0,
      seedFixture: true,
      log: (l) => lines.push(l),
    });

  beforeAll(async () => {
    stack = await start();
  }, 120_000);
  afterAll(async () => {
    await stack?.stop();
  }, 30_000);

  test("answers /health on loopback, and refuses every Host that is not its own", async () => {
    const health = await call(stack.url, "GET", "/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
    expect(new URL(stack.url).hostname).toBe("127.0.0.1");
    expect(new URL(stack.s3Url).hostname).toBe("127.0.0.1");
    // DNS rebinding: the same fixed refusal on a public route, an authenticated one and a runner one, for
    // a name, an IP literal, a missing Host and a port that is not the stack's.
    const cases = hostCases(stack.port);
    for (const path of ["/health", "/admin/compute/runners", "/compute/runners/me"]) {
      for (const host of cases.refused) {
        const got = await rawGet(
          stack.port,
          path,
          host === "" ? null : host,
          path === "/admin/compute/runners" ? { Authorization: `Bearer ${stack.keys.owner}` } : {},
        );
        expect({ path, host, status: got.status, body: got.body }).toEqual({
          path,
          host,
          status: 421,
          body: '{"error":"host_not_allowed"}',
        });
      }
    }
    for (const host of cases.served) {
      expect((await rawGet(stack.port, "/health", host)).status).toBe(200);
    }
    // The owner's key opens the admin route only with an accepted Host.
    const owner = { Authorization: `Bearer ${stack.keys.owner}` };
    expect(
      (await rawGet(stack.port, "/admin/compute/runners", `localhost:${stack.port}`, owner)).status,
    ).toBe(200);
    // The S3 stand-in is guarded on its own port, and the stack's own signer still reaches it.
    for (const host of hostCases(stack.s3Port).refused) {
      expect((await rawGet(stack.s3Port, "/x", host === "" ? null : host)).status).toBe(421);
    }
    expect((await rawGet(stack.s3Port, "/x", `127.0.0.1:${stack.s3Port}`)).status).toBe(403);
  });

  test("the state directory is private and the S3 credentials are random, not the public defaults", async () => {
    const modes = treeModes(state);
    const wrong = modes.filter(([path, mode]) =>
      statSync(path).isDirectory() ? mode !== "700" : mode !== "600",
    );
    expect(wrong).toEqual([]);
    for (const name of ["stack.sqlite", "s3.json", "secret", "keys.json"]) {
      expect(modes.some(([p]) => p.endsWith(`/${name}`))).toBe(true);
    }
    const s3 = JSON.parse(readFileSync(join(state, "s3.json"), "utf-8"));
    expect(readFileSync(join(state, "s3.json"), "utf-8")).not.toContain("STANDINKEYID");
    expect(s3.accessKeyId).toMatch(/^[0-9a-f]{64}$/);
    expect(s3.secretAccessKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s3.accessKeyId).not.toBe(s3.secretAccessKey);
    expect(stack.standin.accessKeyId).toBe(s3.accessKeyId);
    expect(stack.env.COMPUTE_R2_ACCESS_KEY_ID).toBe(s3.accessKeyId);
    expect(readFileSync(join(state, "secret"), "utf-8").trim()).toMatch(/^[0-9a-f]{64}$/);
    // The environment the routes see is the one the card names.
    expect(stack.env.ENVIRONMENT).toBe("development");
    expect(stack.env.COMPUTE_ENABLED).toBe("1");
    expect(stack.env.COMPUTE_RUNNERS_ENABLED).toBe("1");
    expect(stack.env.COMPUTE_RUNTIME_IMAGE).toBe(IMAGE);
    expect(stack.env.API_BASE_URL).toBe(stack.url);
    expect(stack.env.PRESCREEN_CALLBACK_SECRET).toBe(
      readFileSync(join(state, "secret"), "utf-8").trim(),
    );
    // No key is in anything the stack logged.
    for (const key of Object.values(stack.keys)) {
      expect(lines.join("\n")).not.toContain(key);
    }
  });

  test("the seeds are there: an owner, an administrator, the pipelines account, a policy, the pools", async () => {
    const roles = stack.db
      .query("SELECT username, role, account_kind FROM users ORDER BY username")
      .all();
    expect(roles).toEqual([
      { username: "local-admin", role: "admin", account_kind: "person" },
      { username: "local-owner", role: "owner", account_kind: "person" },
      { username: "nemar-pipelines", role: "member", account_kind: "service" },
      // Made by a migration, not by the stack.
      { username: "nemar-system", role: "member", account_kind: "person" },
    ]);
    expect(count(stack, "SELECT COUNT(*) AS n FROM compute_policy")).toBe(1);
    expect(
      count(
        stack,
        "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key = 'local-stack-seed-pipelines'",
      ),
    ).toBe(1);
    expect(
      count(
        stack,
        "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key = 'local-stack-seed-people'",
      ),
    ).toBe(1);
    expect(
      count(stack, "SELECT COUNT(*) AS n FROM datasets WHERE dataset_id = ?", FIXTURE_DATASET_ID),
    ).toBe(1);
    // Each key opens its own account.
    const me = await call(stack.url, "GET", "/admin/compute/runners", { bearer: stack.keys.owner });
    expect(me.status).toBe(200);
    expect(
      (await call(stack.url, "GET", "/admin/compute/runners", { bearer: stack.keys.admin })).status,
    ).toBe(403);
    expect(
      (await call(stack.url, "GET", "/admin/compute/runners", { bearer: "nm_not-a-key" })).status,
    ).toBe(401);
  });

  test("the owner registers a runner, the secret buys a token, and the token opens /me", async () => {
    const registered = await call(stack.url, "POST", "/admin/compute/runners", {
      bearer: stack.keys.owner,
      body: REGISTRATION,
    });
    expect(registered.status).toBe(201);
    runner = RunnerRegisterResponseSchema.parse(registered.body);
    const exchanged = await call(stack.url, "POST", "/compute/runners/token", {
      bearer: runner.secret,
      body: RUN_BODY,
    });
    expect(exchanged.status).toBe(200);
    firstToken = RunnerTokenResponseSchema.parse(exchanged.body).access_token;
    const me = await call(stack.url, "GET", "/compute/runners/me", { bearer: firstToken });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      runner_id: runner.runner_id,
      name: "lab_a_cpu",
      backend: "local",
    });
    // The webhook router is mounted too: an unsigned delivery is refused by it, and is not a 404.
    const hook = await call(stack.url, "POST", "/webhooks/github", { body: {} });
    expect(hook.status).not.toBe(404);
  });

  test("a restart over the same state keeps the runner, the keys, the seeds and the bucket", async () => {
    await stack.env.COMPUTE_RESULTS.put("persist-probe", encoder.encode("still here"));
    const keysBefore = readFileSync(join(state, "keys.json"), "utf-8");
    const s3Before = readFileSync(join(state, "s3.json"), "utf-8");
    await stack.stop();

    stack = await start();
    expect(readFileSync(join(state, "keys.json"), "utf-8")).toBe(keysBefore);
    expect(readFileSync(join(state, "s3.json"), "utf-8")).toBe(s3Before);
    expect(lines.filter((l) => l.startsWith("applied "))).toHaveLength(1);

    // The same registration, a new token, and the old token has not been carried over by anything but D1.
    const listed = await call(stack.url, "GET", "/admin/compute/runners", {
      bearer: stack.keys.owner,
    });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(runner.runner_id);
    const exchanged = await call(stack.url, "POST", "/compute/runners/token", {
      bearer: runner.secret,
      body: RUN_BODY,
    });
    expect(exchanged.status).toBe(200);
    const second = RunnerTokenResponseSchema.parse(exchanged.body).access_token;
    expect(second).not.toBe(firstToken);
    const me = await call(stack.url, "GET", "/compute/runners/me", { bearer: second });
    expect(me.status).toBe(200);
    expect(me.body.runner_id).toBe(runner.runner_id);

    // Seeds were repaired in place, not repeated.
    expect(count(stack, "SELECT COUNT(*) AS n FROM users")).toBe(4);
    expect(
      count(stack, "SELECT COUNT(*) AS n FROM tokens WHERE api_key_prefix NOT LIKE 'nmra%'"),
    ).toBe(3);
    expect(count(stack, "SELECT COUNT(*) AS n FROM compute_policy")).toBe(1);
    expect(
      count(
        stack,
        "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key LIKE 'local-stack-seed-%'",
      ),
    ).toBe(2);
    expect(count(stack, "SELECT COUNT(*) AS n FROM datasets")).toBe(1);

    // The bucket outlived the process, and the stand-in's new port serves the same store.
    const got = await stack.env.COMPUTE_RESULTS.get("persist-probe");
    expect(await got?.text()).toBe("still here");
    expect(stack.standin.accessKeyId).toBe(JSON.parse(s3Before).accessKeyId);
    expect(
      treeModes(state).filter(([p, m]) => (statSync(p).isDirectory() ? m !== "700" : m !== "600")),
    ).toEqual([]);
  });

  test("outputs downloads a finished job's results through the real links route, names and sizes only", async () => {
    const pipelinesId = (
      stack.db.query("SELECT id FROM users WHERE username = 'nemar-pipelines'").get() as {
        id: number;
      }
    ).id;
    const made = await createJob(stack.env, {
      source: "pipeline",
      accountId: pipelinesId,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: launchableSpec({ datasets: [{ id: FIXTURE_DATASET_ID, version: "1.0.0" }] }),
    });
    if (!made.ok) throw new Error(`could not make a job: ${made.code}`);
    const jobId = made.job.id;
    const files = [
      { path: "qc/table.tsv", content: "a\tb\n1\t2\n" },
      { path: "report.txt", content: "the report" },
      { path: "z-last.txt", content: "last" },
    ];
    const declared = [];
    for (const f of files) {
      const bytes = encoder.encode(f.content);
      await stack.env.COMPUTE_RESULTS.put(resultsOutputKey(jobId, f.path), bytes);
      declared.push({ path: f.path, size: bytes.length, sha256: await sha256Hex(bytes) });
    }
    await stack.env.COMPUTE_RESULTS.put(declaredKey(jobId), declaredText(jobId, declared, []));
    stack.db.run(
      "UPDATE compute_jobs SET state = 'finished', results_verified_at = datetime('now') WHERE id = ?",
      [jobId],
    );

    const to = fresh("outputs");
    const got = await downloadOutputs({
      state,
      job: jobId,
      to,
      port: stack.port,
      s3Port: stack.s3Port,
    });
    // Files the buckets made while the stack ran (no start or stop has hardened them since) are private
    // too: that is the process's umask, which Miniflare's own process inherits.
    expect(
      treeModes(state).filter(([p, m]) => (statSync(p).isDirectory() ? m !== "700" : m !== "600")),
    ).toEqual([]);
    expect(got).toEqual([
      { path: "qc/table.tsv", size: 8 },
      { path: "report.txt", size: 10 },
      { path: "z-last.txt", size: 4 },
    ]);
    expect(readFileSync(join(to, "qc/table.tsv"), "utf-8")).toBe("a\tb\n1\t2\n");
    expect(readFileSync(join(to, "report.txt"), "utf-8")).toBe("the report");
    expect(
      treeModes(to).filter(
        ([p, m]) => p !== to && (statSync(p).isDirectory() ? m !== "700" : m !== "600"),
      ),
    ).toEqual([]);

    // The command line prints names and sizes, and no address.
    const ran = spawn({
      cmd: [
        "bun",
        SCRIPT,
        "outputs",
        "--state",
        state,
        "--job",
        jobId,
        "--to",
        fresh("cli"),
        "--port",
        String(stack.port),
        "--s3-port",
        String(stack.s3Port),
      ],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(ran.stdout).text();
    expect(await ran.exited).toBe(0);
    expect(out).toBe("qc/table.tsv\t8\nreport.txt\t10\nz-last.txt\t4\n");
    expect(out).not.toContain("http");
    expect(out).not.toContain("X-Amz");

    // A job that is not there is refused without a download.
    await expect(
      downloadOutputs({
        state,
        job: "job_000000000000000000000000",
        to: fresh("none"),
        port: stack.port,
        s3Port: stack.s3Port,
      }),
    ).rejects.toThrow(/job_not_found|404/);
  });

  test("a second page is followed by the cursor", async () => {
    const pipelinesId = (
      stack.db.query("SELECT id FROM users WHERE username = 'nemar-pipelines'").get() as {
        id: number;
      }
    ).id;
    const made = await createJob(stack.env, {
      source: "pipeline",
      accountId: pipelinesId,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: launchableSpec({ datasets: [{ id: FIXTURE_DATASET_ID, version: "1.0.0" }] }),
    });
    if (!made.ok) throw new Error(`could not make a job: ${made.code}`);
    const jobId = made.job.id;
    // 1,001 outputs: the route answers 1,000 and a `next_after`.
    const declared = [];
    const bytes = encoder.encode("x");
    const sha = await sha256Hex(bytes);
    for (let i = 0; i < 1001; i++) {
      const path = `many/f${String(i).padStart(4, "0")}.txt`;
      await stack.env.COMPUTE_RESULTS.put(resultsOutputKey(jobId, path), bytes);
      declared.push({ path, size: 1, sha256: sha });
    }
    await stack.env.COMPUTE_RESULTS.put(declaredKey(jobId), declaredText(jobId, declared, []));
    stack.db.run(
      "UPDATE compute_jobs SET state = 'finished', results_verified_at = datetime('now') WHERE id = ?",
      [jobId],
    );
    const to = fresh("pages");
    const got = await downloadOutputs({
      state,
      job: jobId,
      to,
      port: stack.port,
      s3Port: stack.s3Port,
    });
    expect(got).toHaveLength(1001);
    expect(new Set(got.map((g) => g.path)).size).toBe(1001);
    expect(readdirSync(join(to, "many"))).toHaveLength(1001);
  }, 120_000);

  /**
   * A stand-in for the links route's ANSWER (a link whose path or address the real route would never
   * mint cannot be made through it), and a stand-in for the S3 origin the link points at, so what
   * `downloadOutputs` does with a hostile answer is shown. `links` is given the S3 origin's port.
   */
  async function hostile(
    links: (s3Port: number) => Array<{ path: string; size: number; url: string }>,
    s3: (req: Request) => Response,
  ) {
    const hits: string[] = [];
    const s3Server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        hits.push(new URL(req.url).pathname);
        return s3(req);
      },
    });
    const route = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ links: links(s3Server.port as number), next_after: null }),
    });
    const run = (to: string) =>
      downloadOutputs({
        state,
        job: "job_000000000000000000000001",
        to,
        port: route.port as number,
        s3Port: s3Server.port as number,
      });
    return {
      run,
      hits,
      stop() {
        route.stop(true);
        s3Server.stop(true);
      },
    };
  }

  test("a path that would leave --to is refused", async () => {
    const h = await hostile(
      (p) => [{ path: "../escaped.txt", size: 1, url: `http://127.0.0.1:${p}/x` }],
      () => new Response("x"),
    );
    try {
      const parent = fresh("escape");
      await expect(h.run(join(parent, "to"))).rejects.toThrow(/outside --to/);
      expect(() => statSync(join(parent, "escaped.txt"))).toThrow();
      expect(h.hits).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("a symbolic link inside --to, to a directory or to a file, is not written through", async () => {
    const outside = fresh("outside");
    const to = fresh("symlinks");
    symlinkSync(outside, join(to, "dir"));
    writeFileSync(join(outside, "victim.txt"), "original");
    symlinkSync(join(outside, "victim.txt"), join(to, "file.txt"));
    // A link to a file that does not exist yet: a write would create it outside.
    symlinkSync(join(outside, "created.txt"), join(to, "dangling.txt"));
    const h = await hostile(
      (p) => [{ path: "dir/new.txt", size: 1, url: `http://127.0.0.1:${p}/x` }],
      () => new Response("x"),
    );
    const g = await hostile(
      (p) => [{ path: "file.txt", size: 1, url: `http://127.0.0.1:${p}/x` }],
      () => new Response("x"),
    );
    const d = await hostile(
      (p) => [{ path: "dangling.txt", size: 1, url: `http://127.0.0.1:${p}/x` }],
      () => new Response("x"),
    );
    try {
      await expect(h.run(to)).rejects.toThrow(/outside --to/);
      await expect(g.run(to)).rejects.toThrow(/outside --to/);
      await expect(d.run(to)).rejects.toThrow(/symbolic link/);
      expect(readdirSync(outside)).toEqual(["victim.txt"]);
      expect(readFileSync(join(outside, "victim.txt"), "utf-8")).toBe("original");
    } finally {
      h.stop();
      g.stop();
      d.stop();
    }
  });

  test("--to may itself be reached through a symbolic link, and the root is a legal target", async () => {
    const real = fresh("real-to");
    const parent = fresh("link-parent");
    const via = join(parent, "via");
    symlinkSync(real, via);
    const h = await hostile(
      (p) => [{ path: "a/b.txt", size: 1, url: `http://127.0.0.1:${p}/x` }],
      () => new Response("x"),
    );
    try {
      expect(await h.run(via)).toEqual([{ path: "a/b.txt", size: 1 }]);
      expect(readFileSync(join(real, "a", "b.txt"), "utf-8")).toBe("x");
    } finally {
      h.stop();
    }
    // The containment test never throws, at the root or at a name that merely starts with dots.
    expect(isInside("/", "/etc/x")).toBe(true);
    expect(isInside("/", "/")).toBe(true);
    expect(isInside("/a", "/ab")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(true);
    expect(isInside("/a", "/a/..b")).toBe(true);
    expect(isInside("/a", "/a/../b")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });

  test("a link must be on the stack's S3 origin, and a redirect is not followed", async () => {
    const decoyHits = { n: 0 };
    const counted = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        decoyHits.n++;
        return new Response("x");
      },
    });
    const other = await hostile(
      () => [{ path: "a.txt", size: 1, url: `http://127.0.0.1:${counted.port}/x` }],
      () => new Response("x"),
    );
    const named = await hostile(
      (p) => [{ path: "a.txt", size: 1, url: `http://localhost:${p}/x` }],
      () => new Response("x"),
    );
    const bad = await hostile(
      () => [{ path: "a.txt", size: 1, url: "not an address" }],
      () => new Response("x"),
    );
    const redirecting = await hostile(
      (p) => [{ path: "a.txt", size: 1, url: `http://127.0.0.1:${p}/x` }],
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: `http://127.0.0.1:${counted.port}/x` },
        }),
    );
    try {
      await expect(other.run(fresh("o1"))).rejects.toThrow(/not on the stack's S3 origin/);
      await expect(named.run(fresh("o2"))).rejects.toThrow(/not on the stack's S3 origin/);
      await expect(bad.run(fresh("o3"))).rejects.toThrow(/not an address/);
      await expect(redirecting.run(fresh("o4"))).rejects.toThrow(/redirect/);
      expect(decoyHits.n).toBe(0);
      expect(named.hits).toEqual([]);
    } finally {
      counted.stop(true);
      for (const h of [other, named, bad, redirecting]) h.stop();
    }
  });
});

// --- The catalog seed ---------------------------------------------------------------------------------

describe("--seed-from-catalog", () => {
  /** The public record's shape (fields as `GET /datasets/<id>` serves them), for one made-up dataset. */
  const record = {
    dataset_id: "nm000500",
    name: "A public EEG dataset",
    description: "PROSE-NOT-COPIED",
    readme: "README-NOT-COPIED",
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-08-14 10:44:06",
    withdrawn_at: null,
    ezid_status: "public",
    is_sandbox: 0,
    is_exemplar: 0,
    modalities: "eeg",
    zarr_source_commit: "64feed5210ebea128a8484acd3027f9551ff2d7e",
    latest_version: "v1.0.5",
    latest_version_at: "2026-08-20 19:21:09",
    latest_version_doi: "10.82901/nemar.nm000500.v1.0.5",
    total_files: 157,
    owner_username: "NOT-COPIED",
  };
  let seen: { path: string; agent: string | null }[] = [];
  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, agent: req.headers.get("user-agent") });
      if (url.pathname === "/datasets/nm000500") return Response.json({ dataset: record });
      // The serving host's index of the one dataset that has a serving copy (the Zarr source check's `S`).
      if (url.pathname === "/zarr-index/nm000500/zarr/index.json") {
        return Response.json({ source_commit: record.zarr_source_commit, store_count: 4 });
      }
      if (url.pathname === "/datasets/nm000503") {
        return Response.json({
          dataset: { ...record, dataset_id: "nm000503", zarr_source_commit: null },
        });
      }
      if (url.pathname === "/datasets/nm000501") {
        const { modalities, ...without } = record;
        return Response.json({ dataset: { ...without, dataset_id: "nm000501" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  afterAll(() => api.stop(true));

  const catalogState = join(fresh("catalog"), "state");

  test("copies the predicate's values and the version, nothing else, and says which", async () => {
    seen = [];
    const lines: string[] = [];
    const stack = await startLocalStack({
      state: catalogState,
      image: IMAGE,
      port: 0,
      s3Port: 0,
      seedFromCatalog: ["nm000500"],
      catalogBase: `http://127.0.0.1:${api.port}`,
      zarrIndexBase: `http://127.0.0.1:${api.port}/zarr-index`,
      log: (l) => lines.push(l),
    });
    try {
      // The public record, then the serving host's index (the copy's store count for the Zarr source check).
      expect(seen).toEqual([
        { path: "/datasets/nm000500", agent: "nemar-local-stack/0" },
        { path: "/zarr-index/nm000500/zarr/index.json", agent: "nemar-local-stack/0" },
      ]);
      const row = stack.db
        .query("SELECT * FROM datasets WHERE dataset_id = 'nm000500'")
        .get() as Loose;
      expect(row).toMatchObject({
        name: "A public EEG dataset",
        status: "active",
        visibility: "public",
        anonymous: 0,
        modalities: "eeg",
        zarr_source_commit: record.zarr_source_commit,
        // The public record carries neither value; the index says the copy is there and how many stores it has.
        zarr_status: "ready",
        zarr_store_count: 4,
      });
      expect(row.description).toBeNull();
      expect(JSON.stringify(row)).not.toContain("NOT-COPIED");
      const version = stack.db
        .query("SELECT * FROM dataset_versions WHERE dataset_id = 'nm000500'")
        .get() as Loose;
      expect(version).toMatchObject({
        version: "v1.0.5",
        doi: "10.82901/nemar.nm000500.v1.0.5",
        created_at: "2026-08-20 19:21:09",
        total_files: 157,
      });
      const said = lines.join("\n");
      expect(said).toContain("copied dataset_id, name, status, visibility, anonymous");
      expect(said).toContain(
        "zarr_source_commit, latest_version, latest_version_at, latest_version_doi, total_files",
      );
      expect(said).toContain("zarr_status, zarr_store_count");
      expect(said).toContain("nm000500: eligible for a pipeline run");
    } finally {
      await stack.stop();
    }
  }, 120_000);

  test("the Zarr source check reads the public serving host and leaves GitHub at its public API (MUTATION: set the GitHub override; drop the index base)", async () => {
    seen = [];
    const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
    expect(seams.NEMAR_ZARR_INDEX_BASE).toBeUndefined();
    // nm000503's record has no serving copy, so no index is read and no case needs the network.
    const stack = await startLocalStack({
      state: join(fresh("catalog-default-base"), "state"),
      image: IMAGE,
      port: 0,
      s3Port: 0,
      seedFromCatalog: ["nm000503"],
      catalogBase: `http://127.0.0.1:${api.port}`,
      log: () => {},
    });
    try {
      expect(seams.NEMAR_ZARR_INDEX_BASE).toBe("https://zarr.nemar.org");
      expect(seams.NEMAR_GITHUB_API_URL).toBeUndefined();
      expect(seen.map((r) => r.path)).toEqual(["/datasets/nm000503"]);
      const row = stack.db
        .query("SELECT zarr_status, zarr_store_count FROM datasets WHERE dataset_id = 'nm000503'")
        .get() as Loose;
      expect(row).toEqual({ zarr_status: null, zarr_store_count: null });
    } finally {
      await stack.stop();
    }
    expect(seams.NEMAR_ZARR_INDEX_BASE).toBeUndefined();
  }, 120_000);

  test("--seed-fixture and --seed-from-catalog are not combined", async () => {
    await expect(
      startLocalStack({
        state: join(fresh("catalog-and-fixture"), "state"),
        image: IMAGE,
        port: 0,
        s3Port: 0,
        seedFixture: true,
        seedFromCatalog: ["nm000500"],
        catalogBase: `http://127.0.0.1:${api.port}`,
        log: () => {},
      }),
    ).rejects.toThrow(/not combined/);
  }, 120_000);

  test("a restart over the same state leaves the dataset it already holds alone", async () => {
    seen = [];
    const lines: string[] = [];
    const stack = await startLocalStack({
      state: catalogState,
      image: IMAGE,
      port: 0,
      s3Port: 0,
      seedFromCatalog: ["nm000500"],
      catalogBase: `http://127.0.0.1:${api.port}`,
      zarrIndexBase: `http://127.0.0.1:${api.port}/zarr-index`,
      log: (l) => lines.push(l),
    });
    try {
      expect(seen).toEqual([]);
      expect(lines).toContain("nm000500: already in the state database, left as it is");
      expect(count(stack, "SELECT COUNT(*) AS n FROM datasets WHERE dataset_id = 'nm000500'")).toBe(
        1,
      );
      expect(
        count(stack, "SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id = 'nm000500'"),
      ).toBe(1);
    } finally {
      await stack.stop();
    }
  }, 120_000);

  test("a plain restart over a state holding a catalog dataset points the index read at the serving host, and a fixture start over it is refused (MUTATION: follow the flags)", async () => {
    const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
    const stack = await startLocalStack({
      state: catalogState,
      image: IMAGE,
      port: 0,
      s3Port: 0,
      zarrIndexBase: `http://127.0.0.1:${api.port}/zarr-index`,
      log: () => {},
    });
    try {
      // No seed flag at all: the state holds nm000500, so the seam is there.
      expect(seams.NEMAR_ZARR_INDEX_BASE).toBe(`http://127.0.0.1:${api.port}/zarr-index`);
      expect(seams.NEMAR_GITHUB_API_URL).toBeUndefined();
    } finally {
      await stack.stop();
    }
    await expect(
      startLocalStack({
        state: catalogState,
        image: IMAGE,
        port: 0,
        s3Port: 0,
        seedFixture: true,
        log: () => {},
      }),
    ).rejects.toThrow(/both the fixture and a catalog dataset/);
    expect(seams.NEMAR_ZARR_INDEX_BASE).toBeUndefined();
  }, 120_000);

  test("a field the public record does not serve stops the seed and names it", async () => {
    await expect(
      startLocalStack({
        state: join(fresh("catalog-missing"), "state"),
        image: IMAGE,
        port: 0,
        s3Port: 0,
        seedFromCatalog: ["nm000501"],
        catalogBase: `http://127.0.0.1:${api.port}`,
        zarrIndexBase: `http://127.0.0.1:${api.port}/zarr-index`,
        log: () => {},
      }),
    ).rejects.toThrow(/does not serve modalities/);
    await expect(
      startLocalStack({
        state: join(fresh("catalog-404"), "state"),
        image: IMAGE,
        port: 0,
        s3Port: 0,
        seedFromCatalog: ["nm000502"],
        catalogBase: `http://127.0.0.1:${api.port}`,
        zarrIndexBase: `http://127.0.0.1:${api.port}/zarr-index`,
        log: () => {},
      }),
    ).rejects.toThrow(/answered 404/);
  }, 120_000);
});

// --- The Zarr source check on the fixture -----------------------------------------------------------------

describe("--seed-fixture: a Zarr recipe is dispatched with the exact verdict", () => {
  test("the stand-in names the fixture version's commit as the tag's and the index's, through the real route (MUTATION: another commit for the index)", async () => {
    const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
    expect([seams.NEMAR_GITHUB_API_URL, seams.NEMAR_ZARR_INDEX_BASE]).toEqual([
      undefined,
      undefined,
    ]);
    const stack = await startLocalStack({
      state: join(fresh("fixture-zarr"), "state"),
      image: IMAGE,
      port: 0,
      s3Port: 0,
      seedFixture: true,
      log: () => {},
    });
    try {
      // Loopback only: the stack never reaches GitHub or the serving host for its fixture.
      expect(new URL(seams.NEMAR_GITHUB_API_URL as string).hostname).toBe("127.0.0.1");
      expect(new URL(seams.NEMAR_ZARR_INDEX_BASE as string).hostname).toBe("127.0.0.1");
      const row = stack.db
        .query(
          "SELECT zarr_source_commit, zarr_status, zarr_store_count FROM datasets WHERE dataset_id = ?1",
        )
        .get(FIXTURE_DATASET_ID) as Loose;
      expect(row).toEqual({
        zarr_source_commit: FIXTURE_SOURCE_COMMIT,
        zarr_status: "ready",
        zarr_store_count: 1,
      });
      const made = await call(stack.url, "POST", "/admin/compute/pipeline/run", {
        bearer: stack.keys.admin,
        body: { recipe: "nemar-floor", dataset: FIXTURE_DATASET_ID, executor: "runner" },
      });
      expect(made.status).toBe(201);
      const jobId = made.body.results[0].job_id as string;
      const spec = await (
        (await stack.env.COMPUTE_RECORDS.get(recordKey(jobId, "spec.json"))) as R2ObjectBody
      ).text();
      const args = JSON.parse(spec).args as string[];
      expect(args.slice(args.indexOf("--source-commit"), args.indexOf("--image-digest"))).toEqual([
        "--source-commit",
        FIXTURE_SOURCE_COMMIT,
        "--tag-commit",
        FIXTURE_SOURCE_COMMIT,
        "--commit-equivalence",
        "exact",
      ]);
    } finally {
      await stack.stop();
    }
    expect([seams.NEMAR_GITHUB_API_URL, seams.NEMAR_ZARR_INDEX_BASE]).toEqual([
      undefined,
      undefined,
    ]);
  }, 120_000);
});

describe("the Zarr source check's seams follow the state database", () => {
  const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
  const base = (state: string) => ({ state, image: IMAGE, port: 0, s3Port: 0, log: () => {} });

  test("a plain restart over a state holding the fixture starts the stand-in again; a catalog seed over it is refused (MUTATION: follow the flags)", async () => {
    const state = join(fresh("seams-fixture"), "state");
    const first = await startLocalStack({ ...base(state), seedFixture: true });
    await first.stop();
    const again = await startLocalStack(base(state));
    try {
      expect(new URL(seams.NEMAR_GITHUB_API_URL as string).hostname).toBe("127.0.0.1");
      expect(new URL(seams.NEMAR_ZARR_INDEX_BASE as string).hostname).toBe("127.0.0.1");
      const made = await call(again.url, "POST", "/admin/compute/pipeline/run", {
        bearer: again.keys.admin,
        body: { recipe: "nemar-floor", dataset: FIXTURE_DATASET_ID, executor: "runner" },
      });
      expect(made.status).toBe(201);
    } finally {
      await again.stop();
    }
    await expect(
      startLocalStack({
        ...base(state),
        seedFromCatalog: ["nm000500"],
        catalogBase: "http://127.0.0.1:1",
      }),
    ).rejects.toThrow(/both the fixture and a catalog dataset/);
    expect([seams.NEMAR_GITHUB_API_URL, seams.NEMAR_ZARR_INDEX_BASE]).toEqual([
      undefined,
      undefined,
    ]);
  }, 180_000);

  test("a state holding another dataset of the live range is refused, never read from the network (MUTATION: drop the check)", async () => {
    const state = join(fresh("seams-live"), "state");
    const first = await startLocalStack(base(state));
    first.db.run(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility) VALUES ('nm000104', 'x', 1, 'active', 'public')",
    );
    await first.stop();
    await expect(startLocalStack(base(state))).rejects.toThrow(
      /state holds nm000104: a live dataset/,
    );
    expect([seams.NEMAR_GITHUB_API_URL, seams.NEMAR_ZARR_INDEX_BASE]).toEqual([
      undefined,
      undefined,
    ]);
  }, 120_000);
});

// --- The command line ---------------------------------------------------------------------------------

describe("the command line", () => {
  /** A process that never outlives its test: killed after `ms` (and the test then fails on its exit code). */
  async function run(args: string[], ms = 30_000) {
    const proc = spawn({
      cmd: ["bun", SCRIPT, ...args],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), ms);
    try {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { out, err, code: await proc.exited };
    } finally {
      clearTimeout(timer);
      proc.kill("SIGKILL");
    }
  }

  /** A spawned `serve` with its banner read; `finish` ends it (a signal) and is also called if a case throws. */
  async function serve(state: string, extra: string[] = []) {
    const proc = spawn({
      cmd: [
        "bun",
        SCRIPT,
        "serve",
        "--state",
        state,
        "--image",
        IMAGE,
        "--port",
        "0",
        "--s3-port",
        "0",
        ...extra,
      ],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const decoder = new TextDecoder();
    let text = "";
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + 90_000;
    while (!/\n.*S3 stand-in/.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const banner = text.split("\n").find((l) => l.startsWith("NEMAR local")) ?? "";
    const m =
      /^NEMAR local compute stack \(not a deployment\) at http:\/\/127\.0\.0\.1:(\d+), (\S+)@([0-9a-f]{7,40}|unknown)$/.exec(
        banner,
      );
    const s3Port = /S3 stand-in on http:\/\/127\.0\.0\.1:(\d+);/.exec(text)?.[1];
    let ended = false;
    return {
      proc,
      text,
      banner: m,
      port: Number(m?.[1]),
      s3Port: Number(s3Port),
      async finish(signal: "SIGTERM" | "SIGINT" | "SIGHUP" | "SIGKILL" = "SIGKILL") {
        if (!ended) proc.kill(signal);
        ended = true;
        const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
        try {
          return await proc.exited;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  test("serve prints the banner, answers /health on the printed port, and binds loopback", async () => {
    const state = join(fresh("serve"), "state");
    const s = await serve(state, ["--seed-fixture"]);
    try {
      expect(s.banner).not.toBeNull();
      // The spawned process is not under this suite's loopback preload for `Bun.serve`: what it listens on
      // is what the stack itself asked for, read from the operating system.
      for (const port of [s.port, s.s3Port]) {
        const bound = await listeningOn(port);
        if (Bun.which("lsof")) expect(bound.length).toBeGreaterThan(0);
        for (const address of bound) expect(address).toBe("127.0.0.1");
        const lan = otherAddress();
        if (lan !== null) expect(await reachable(lan, port)).toBe(false);
      }
      const health = await call(`http://127.0.0.1:${s.port}`, "GET", "/health");
      expect(health.status).toBe(200);
      expect(health.body.status).toBe("ok");
      expect((await rawGet(s.port, "/health", "evil.example")).status).toBe(421);
      const keys = JSON.parse(readFileSync(join(state, "keys.json"), "utf-8")) as Record<
        string,
        string
      >;
      for (const key of Object.values(keys)) expect(s.text).not.toContain(key);
    } finally {
      await s.finish("SIGTERM");
    }
    expect(
      treeModes(state).filter(([p, mode]) =>
        statSync(p).isDirectory() ? mode !== "700" : mode !== "600",
      ),
    ).toEqual([]);
  }, 120_000);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} stops it with exit 0`, async () => {
      const s = await serve(join(fresh("signal"), "state"));
      expect(s.banner).not.toBeNull();
      expect(await s.finish(signal)).toBe(0);
    }, 120_000);
  }

  test("SIGHUP (a dropped ssh session) closes the servers and exits 0, and a restart reuses the state", async () => {
    const state = join(fresh("hup"), "state");
    const first = await serve(state, ["--seed-fixture"]);
    let runnerId = "";
    let keysBefore = "";
    try {
      expect(first.banner).not.toBeNull();
      keysBefore = readFileSync(join(state, "keys.json"), "utf-8");
      const owner = (JSON.parse(keysBefore) as Record<string, string>).owner as string;
      const reg = await call(`http://127.0.0.1:${first.port}`, "POST", "/admin/compute/runners", {
        bearer: owner,
        body: REGISTRATION,
      });
      expect(reg.status).toBe(201);
      runnerId = reg.body.runner_id as string;
    } finally {
      expect(await first.finish("SIGHUP")).toBe(0);
    }
    // Closed: nothing answers on the old ports.
    expect(await reachable("127.0.0.1", first.port)).toBe(false);
    expect(await reachable("127.0.0.1", first.s3Port)).toBe(false);

    const second = await serve(state);
    try {
      expect(second.banner).not.toBeNull();
      expect(second.text).not.toContain("applied ");
      expect(readFileSync(join(state, "keys.json"), "utf-8")).toBe(keysBefore);
      const owner = (JSON.parse(keysBefore) as Record<string, string>).owner as string;
      const listed = await call(
        `http://127.0.0.1:${second.port}`,
        "GET",
        "/admin/compute/runners",
        {
          bearer: owner,
        },
      );
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).toContain(runnerId);
    } finally {
      expect(await second.finish("SIGTERM")).toBe(0);
    }
    expect(
      treeModes(state).filter(([p, mode]) =>
        statSync(p).isDirectory() ? mode !== "700" : mode !== "600",
      ),
    ).toEqual([]);
  }, 180_000);

  test("another host, a missing image and an unknown argument are refused", async () => {
    const state = join(fresh("cli-refuse"), "state");
    // `run` kills a process that does not exit, so a stack that wrongly started would fail this fast.
    const host = await run(
      ["serve", "--state", state, "--image", IMAGE, "--host", "localhost"],
      15_000,
    );
    expect(host.code).toBe(1);
    expect(host.err).toContain("binds 127.0.0.1 only");
    const noImage = await run(["serve", "--state", state]);
    expect(noImage.code).toBe(1);
    expect(noImage.err).toContain("--image is required");
    const unknown = await run(["serve", "--state", state, "--bogus"]);
    expect(unknown.code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect(() => statSync(state)).toThrow();
  }, 90_000);
});

describe("hardenTree", () => {
  test("makes what a tool left wide private again", () => {
    const dir = fresh("harden");
    writeFileSync(join(dir, "loose.txt"), "x", { mode: 0o644 });
    hardenTree(dir);
    expect(statSync(join(dir, "loose.txt")).mode & 0o777).toBe(0o600);
  });
});
