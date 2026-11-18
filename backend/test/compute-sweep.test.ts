/**
 * The tenant sweep (epic #2005 phase A7, #2012; ADR 0118; design
 * section 6). Real migrations, the real ledger with its triggers, Miniflare's R2, and the Tapis stand-in
 * (a real HTTP server built from Tapis's published specifications; NO response of it was recorded from a
 * real tenant, and whether a tenant administrator lists more than its own and shared jobs is UNVERIFIED,
 * so the tests list the jobs the service identity owns or created).
 *
 * THE SWEEP. An untagged job is cancelled, indexed `unreserved` and charged to the `tenant` partner pool,
 * NEVER to an account pool; an owner that maps to no active account is `unattributed`; a job tagged for
 * an existing row binds the submit race and is not cancelled; a second job under a row's tag is a
 * duplicate, cancelled and never indexed; a NEMAR job (a pipeline's included) that a row owns is left
 * alone; a Tapis that cannot be listed changes nothing; nothing runs outside production or with compute
 * off; the row is written before the cancel, so a cancel that fails leaves a row to finish.
 *
 * The open points A5 left for this phase are `compute-lifecycle-rotation.test.ts`'s.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sendAccessReport } from "../src/services/access-attributes";
import { runComputeAdvanceCron, sweepComputeCancellations } from "../src/services/compute-advance";
import {
  advanceComputeJob,
  recordOrphan,
  requestComputeCancel,
  submitComputeJob,
} from "../src/services/compute-lifecycle";
import {
  TENANT_NEW_PER_RUN,
  sweepTenantJobs,
  tenantLogLine,
} from "../src/services/compute-tenant-sweep";
import type { Bindings } from "../src/types/bindings";
import { endedJob } from "./helpers/compute-ended";
import {
  type LifecycleFixture,
  MINUTE,
  iso,
  makeJob,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundPlatform, seedUser, setPolicy } from "./helpers/compute-seed";
import { hookedDb } from "./helpers/db-hooks";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const env = (over: Partial<Bindings> = {}): Bindings => fx.env(over);

/** Thirty minutes of four cores is 2 SU; the stand-in ends a cancelled job when it is cancelled, a second or two later. */
const near2000 = (n: unknown) => typeof n === "number" && n >= 2000 && n < 2100;

// --- Tapis jobs nobody at NEMAR made ---------------------------------------------------------------------

async function tapisToken(): Promise<string> {
  const res = await fetch(`${fx.tapis.url}/v3/oauth2/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      username: fx.tapis.username,
      password: fx.tapis.password,
    }),
  });
  const body = (await res.json()) as { result: { access_token: { access_token: string } } };
  return body.result.access_token.access_token;
}

interface Foreign {
  tags?: string[];
  owner?: string;
  queue?: string;
  /** Run: started this long ago (QUEUED then RUNNING). Omitted, the job is PENDING. */
  startedMsAgo?: number;
  /** Then finish it, this long ago, and say when it was created. */
  finished?: boolean;
  createdMsAgo?: number;
}

/** A job submitted to the tenant by anyone but NEMAR's lifecycle: no reservation, whatever it carries. */
async function foreign(over: Foreign = {}): Promise<string> {
  const token = await tapisToken();
  const res = await fetch(`${fx.tapis.url}/v3/jobs/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tapis-Token": token },
    body: JSON.stringify({
      name: "someone else's job",
      appId: "partner-app",
      appVersion: "2.1.0",
      owner: over.owner,
      execSystemLogicalQueue: over.queue ?? "shared",
      nodeCount: 1,
      coresPerNode: 4,
      memoryMB: 8000,
      maxMinutes: 60,
      tags: over.tags ?? [],
    }),
  });
  const body = (await res.json()) as { result: { uuid: string } };
  const uuid = body.result.uuid;
  if (over.startedMsAgo !== undefined) {
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    if (over.finished) fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(
      fx,
      uuid,
      over.startedMsAgo,
      over.finished ? over.startedMsAgo - 10 * MINUTE : null,
    );
  }
  if (over.createdMsAgo !== undefined) {
    const record = fx.tapis.jobs.get(uuid)?.record;
    if (record) record.created = iso(Date.now() - over.createdMsAgo);
  }
  return uuid;
}

const row = (uuid: string) =>
  fx.harness.db.query("SELECT * FROM compute_jobs WHERE tapis_uuid = ?").get(uuid) as Record<
    string,
    unknown
  > | null;

const cancels = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel");

const total = (table: string) =>
  (fx.harness.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Every pool of an account, as `holder_kind:holder_ref:pool -> charged`. */
const poolCharges = () =>
  Object.fromEntries(
    (
      fx.harness.db
        .query("SELECT holder_kind, holder_ref, pool, charged_milli FROM compute_pools")
        .all() as Array<{
        holder_kind: string;
        holder_ref: string;
        pool: string;
        charged_milli: number;
      }>
    ).map((p) => [`${p.holder_kind}:${p.holder_ref}:${p.pool}`, p.charged_milli]),
  );

describe("a job that skipped the reservation", () => {
  test("is cancelled, indexed `unreserved` and charged to the tenant pool, never to an account pool", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ indexed: 1, unattributed: 1, cancelled: 1, finished: 1 });

    expect(cancels()).toHaveLength(1);
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    const r = row(uuid);
    expect(r).toMatchObject({
      source: "partner",
      client_id: "tenant",
      state: "cancelled",
      cancel_reason: "unattributed",
      flag_unreserved: 1,
      flag_unattributed: 1,
      flag_overrun: 0,
      account_id: null,
      held_milli: 0,
    });
    expect(near2000(r?.charged_milli)).toBe(true);
    expect(r?.spec_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r?.settled_provisional_at).not.toBeNull();
    expect(r?.retention_until).not.toBeNull();

    // The use is the tenant pool's, counted against the people budget; no account's pool moved.
    const charges = poolCharges();
    expect(charges["partner:tenant:cpu"]).toBe(r?.charged_milli as number);
    expect(charges["platform:people:cpu"]).toBe(r?.charged_milli as number);
    for (const [pool, charged] of Object.entries(charges)) {
      if (pool.startsWith("account:")) expect([pool, charged]).toEqual([pool, 0]);
    }
    const entries = fx.harness.db
      .query("SELECT kind, reason, charged_delta_milli FROM compute_ledger WHERE job_id = ?")
      .all(r?.id) as Array<{ kind: string; reason: string; charged_delta_milli: number }>;
    expect(entries).toEqual([
      {
        kind: "overrun",
        reason: "unreserved_usage",
        charged_delta_milli: r?.charged_milli as number,
      },
    ]);
  });

  test("whose owner maps to an active account is `unreserved`, carries the account for the record, and STILL charges the tenant pool", async () => {
    const person = await seedUser(env().DB);
    const pseudonym = "gw_abcdefghijklmnopqrst";
    fx.harness.db.run(
      "INSERT INTO compute_gateway_users (account_id, gateway_user) VALUES (?, ?)",
      [person, pseudonym],
    );
    const uuid = await foreign({ owner: pseudonym, startedMsAgo: 30 * MINUTE });
    await sweepTenantJobs(env(), "live");
    expect(row(uuid)).toMatchObject({
      cancel_reason: "unreserved",
      flag_unreserved: 1,
      flag_unattributed: 0,
      account_id: person,
    });
    expect(near2000(row(uuid)?.charged_milli)).toBe(true);
    const charges = poolCharges();
    expect(near2000(charges["partner:tenant:cpu"])).toBe(true);
    expect(charges[`account:${person}:cpu`] ?? 0).toBe(0);
  });

  test("whose owner's account is deleted or not approved is unattributed", async () => {
    const gone = await seedUser(env().DB, { deleted_at: "2026-01-01 00:00:00" });
    const pending = await seedUser(env().DB, { status: "pending" });
    const names = ["gw_aaaaaaaaaaaaaaaaaaaa", "gw_bbbbbbbbbbbbbbbbbbbb"];
    fx.harness.db.run(
      "INSERT INTO compute_gateway_users (account_id, gateway_user) VALUES (?, ?)",
      [gone, names[0]],
    );
    fx.harness.db.run(
      "INSERT INTO compute_gateway_users (account_id, gateway_user) VALUES (?, ?)",
      [pending, names[1]],
    );
    const a = await foreign({ owner: names[0] });
    const b = await foreign({ owner: names[1] });
    await sweepTenantJobs(env(), "live");
    for (const uuid of [a, b]) {
      expect(row(uuid)).toMatchObject({
        cancel_reason: "unattributed",
        flag_unattributed: 1,
        account_id: null,
      });
    }
  });

  const reports = () =>
    fx.harness.db
      .query(
        "SELECT r.job_id, r.state, r.last_error_code, j.gateway_user, j.tapis_uuid FROM compute_access_reports r JOIN compute_jobs j ON j.id = r.job_id",
      )
      .all() as Array<{
      job_id: string;
      state: string;
      last_error_code: string | null;
      gateway_user: string | null;
      tapis_uuid: string;
    }>;

  const accessEnv = () =>
    env({
      ACCESS_GATEWAY_ATTRIBUTES_KEY: "access-test-key-0123456789abcdef",
      ACCESS_RESOURCE_NAME: "example-resource-name",
    });

  test("an indexed job whose record shows a Slurm id owes an ACCESS report under its account's pseudonym (decision 9)", async () => {
    const person = await seedUser(env().DB);
    const pseudonym = "gw_abcdefghijklmnopqrst";
    fx.harness.db.run(
      "INSERT INTO compute_gateway_users (account_id, gateway_user) VALUES (?, ?)",
      [person, pseudonym],
    );
    const uuid = await foreign({ owner: pseudonym, startedMsAgo: 30 * MINUTE });
    await sweepTenantJobs(env(), "live");
    expect(reports()).toEqual([
      expect.objectContaining({ tapis_uuid: uuid, state: "pending", gateway_user: pseudonym }),
    ]);
    // Running the sweep again adds nothing.
    await sweepTenantJobs(env(), "week");
    expect(reports()).toHaveLength(1);
  });

  test("the report is owed from the moment the row is written, not only when it closes: a row still live has it", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 1);
    await sweepTenantJobs(env(), "live");
    expect(row(uuid)).toMatchObject({ state: "running" });
    expect(reports()).toEqual([expect.objectContaining({ tapis_uuid: uuid, state: "pending" })]);
  });

  test("a partner job that maps to no account is reported `no_gateway_user`, so the gap is visible", async () => {
    const uuid = await foreign({ owner: "someone-elses-user", startedMsAgo: 30 * MINUTE });
    await sweepTenantJobs(env(), "live");
    const [only] = reports();
    expect(only).toMatchObject({ tapis_uuid: uuid, state: "pending", gateway_user: null });
    expect(await sendAccessReport(accessEnv(), only?.job_id as string)).toBe("no_gateway_user");
    expect(reports()[0]).toMatchObject({ state: "failed", last_error_code: "no_gateway_user" });
  });

  test("a Slurm id that first shows at the END of the row's life still owes its report (the close makes it)", async () => {
    const uuid = await foreign();
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 1);
    await sweepTenantJobs(env(), "live");
    expect(row(uuid)?.slurm_job_id).toBeNull();
    expect(reports()).toHaveLength(0);
    const record = fx.tapis.jobs.get(uuid)?.record;
    if (record) record.remoteJobId = "4242424";
    await sweepTenantJobs(env(), "live");
    expect(row(uuid)).toMatchObject({ state: "cancelled", slurm_job_id: "4242424" });
    expect(reports()).toEqual([expect.objectContaining({ tapis_uuid: uuid, state: "pending" })]);
  });

  test("a job that never started is cancelled and recorded, and used nothing", async () => {
    const uuid = await foreign();
    await sweepTenantJobs(env(), "live");
    expect(row(uuid)).toMatchObject({ state: "cancelled", charged_milli: 0 });
    expect(total("compute_ledger WHERE job_id IS NOT NULL")).toBe(0);
  });

  test("running the sweep again indexes it once, and charges it once", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    await sweepTenantJobs(env(), "live");
    await sweepTenantJobs(env(), "live");
    await sweepTenantJobs(env(), "week");
    expect(
      fx.harness.db.query("SELECT COUNT(*) AS n FROM compute_jobs WHERE tapis_uuid = ?").get(uuid),
    ).toEqual({ n: 1 });
    expect(near2000(poolCharges()["partner:tenant:cpu"])).toBe(true);
    expect(total("compute_ledger WHERE job_id IS NOT NULL")).toBe(1);
  });

  test("the row is written BEFORE the cancel: a cancel Tapis could not take leaves a row that the next run finishes", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 1);
    const first = await sweepTenantJobs(env(), "live");
    expect(first).toMatchObject({ indexed: 1, finished: 0 });
    // The row was written; the first cancel failed; the follow step asked again (Tapis took it) but has
    // not read the end yet, so the row is still live and Tapis shows the job cancelled.
    expect(row(uuid)).toMatchObject({ state: "running", flag_unreserved: 1 });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(cancels()).toHaveLength(2);
    // The next run closes it and charges what it used.
    await sweepTenantJobs(env(), "live");
    expect(row(uuid)).toMatchObject({ state: "cancelled" });
    expect(near2000(row(uuid)?.charged_milli)).toBe(true);
  });

  test("its row is the sweep's own: the tick, a read-back and an administrator's advance leave it alone", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 1);
    await sweepTenantJobs(env(), "live");
    const id = row(uuid)?.id as string;
    const reads = () => fx.tapis.log.filter((r) => r.path.includes(uuid)).length;
    const before = reads();
    const tick = await runComputeAdvanceCron(env());
    expect(tick?.examined).toBe(0);
    expect((await advanceComputeJob(env(), id)).outcome).toBe("nothing_to_do");
    await requestComputeCancel(env(), id, "admin");
    expect(reads()).toBe(before);
    expect(row(uuid)?.state).toBe("running");
  });

  test("a row another run closed first is not counted as finished (MUTATION: count every close)", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 1);
    await sweepTenantJobs(env(), "live");
    const id = row(uuid)?.id as string;
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    const hook = hookedDb(env().DB);
    // Another writer closes the row after this run read it and before it writes.
    hook.armAfterFirst("FROM compute_policy", () => {
      fx.harness.db.run(
        "UPDATE compute_jobs SET state = 'cancelled', ended_at = datetime('now'), settled_provisional_at = datetime('now') WHERE id = ?",
        [id],
      );
    });
    const result = await sweepTenantJobs(env({ DB: hook.db }), "live");
    expect(result?.finished).toBe(0);
    expect(total("compute_ledger WHERE job_id IS NOT NULL")).toBe(0);
  });

  test("a transient failure on an old row does not close it; a week of failures does (MUTATION: age from creation)", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 2);
    await sweepTenantJobs(env(), "live");
    const id = row(uuid)?.id as string;
    // Created eight days ago, but a read found the job a minute ago.
    fx.harness.db.run(
      "UPDATE compute_jobs SET created_at = datetime('now', '-8 days'), tapis_synced_at = datetime('now', '-1 minutes') WHERE id = ?",
      [id],
    );
    fx.tapis.fail("GET /v3/jobs/:uuid", 503, 100);
    const transient = await sweepTenantJobs(env(), "live");
    expect(transient?.gaveUp).toBe(0);
    expect(row(uuid)?.state).toBe("running");
    // No good read for eight days: closed, flagged, charged nothing.
    fx.harness.db.run(
      "UPDATE compute_jobs SET tapis_synced_at = datetime('now', '-8 days') WHERE id = ?",
      [id],
    );
    const repeated = await sweepTenantJobs(env(), "live");
    expect(repeated?.gaveUp).toBe(1);
    expect(row(uuid)).toMatchObject({ state: "cancelled", flag_mismatch: 1, charged_milli: 0 });
  });

  test("a good read of a live row refreshes the clock the week is counted from", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 2);
    await sweepTenantJobs(env(), "live");
    const id = row(uuid)?.id as string;
    fx.harness.db.run(
      "UPDATE compute_jobs SET tapis_synced_at = datetime('now', '-3 days') WHERE id = ?",
      [id],
    );
    await sweepTenantJobs(env(), "live");
    const synced = row(uuid)?.tapis_synced_at as string;
    expect(Date.now() - Date.parse(`${synced.replace(" ", "T")}Z`)).toBeLessThan(60_000);
  });

  test("a give-up another run closed first, and a second run over a closed row, count once in all (MUTATION: always count the give-up)", async () => {
    const closeAfterRead = async (uuid: string) => {
      const id = row(uuid)?.id as string;
      const hook = hookedDb(env().DB);
      // Another writer closes the row between this run's read and its write.
      hook.armAfterFirst("FROM compute_policy", () => {
        fx.harness.db.run(
          "UPDATE compute_jobs SET state = 'cancelled', ended_at = datetime('now'), settled_provisional_at = datetime('now') WHERE id = ?",
          [id],
        );
      });
      return sweepTenantJobs(env({ DB: hook.db }), "live");
    };
    // The race: the record is gone, but the row was closed by someone else first.
    const raced = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 2);
    await sweepTenantJobs(env(), "live");
    fx.tapis.jobs.delete(raced);
    expect((await closeAfterRead(raced))?.gaveUp).toBe(0);
    // The ordinary case: the first run gives up once, and a second run over the closed row counts nothing.
    const plain = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 2);
    await sweepTenantJobs(env(), "live");
    fx.tapis.jobs.delete(plain);
    const first = await sweepTenantJobs(env(), "live");
    const second = await sweepTenantJobs(env(), "live");
    expect((first?.gaveUp ?? 0) + (second?.gaveUp ?? 0)).toBe(1);
    expect(second?.gaveUp).toBe(0);
  });

  test("whose Tapis record is gone is closed after the sweep reads it: flagged, charged nothing", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 1);
    await sweepTenantJobs(env(), "live");
    fx.tapis.jobs.delete(uuid);
    const result = await sweepTenantJobs(env(), "live");
    expect(result?.gaveUp).toBe(1);
    expect(row(uuid)).toMatchObject({ state: "cancelled", flag_mismatch: 1, charged_milli: 0 });
    expect(total("compute_ledger WHERE job_id IS NOT NULL")).toBe(0);
  });
});

describe("a cancel that fails", () => {
  const cancelLines = async (status: number) => {
    await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", status, 1);
    return logged(async () => {
      await sweepTenantJobs(env(), "live");
    });
  };

  test("a 400 and a 403 are failures, logged, not `over` (MUTATION: treat every `rejected` as over)", async () => {
    expect((await cancelLines(400)).some((l) => l.includes("cancel_failed kind=rejected"))).toBe(
      true,
    );
    await fx.reset();
    expect(
      (await cancelLines(403)).some((l) => l.includes("cancel_failed kind=unauthorized")),
    ).toBe(true);
  });

  test("only a 409 means the job is over, and says nothing", async () => {
    expect((await cancelLines(409)).some((l) => l.includes("cancel_failed"))).toBe(false);
  });
});

describe("a job that NEMAR made", () => {
  test("tagged for a row with no Tapis job yet is bound to it, not cancelled, and not indexed (the submit race)", async () => {
    const made = await makeJob(fx);
    const uuid = await foreign({ tags: [`nemar_job:${made.job.id}`] });
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ raced: 1, indexed: 0, cancelled: 0 });
    expect(cancels()).toHaveLength(0);
    expect(total("compute_jobs")).toBe(1);
    expect(await reread(made.env, made.job.id)).toMatchObject({
      tapis_uuid: uuid,
      state: "submitted",
    });
  });

  test("bound to a row by its uuid is left alone: a person's job and a pipeline's alike", async () => {
    await fundPlatform(env().DB, "pipelines", 10_000_000);
    const person = await makeJob(fx);
    const pipeline = await makeJob(fx, { source: "pipeline" });
    for (const m of [person, pipeline]) {
      expect(await submitComputeJob(m.env, m.job.id)).toEqual({ ok: true, outcome: "submitted" });
    }
    const before = [await reread(env(), person.job.id), await reread(env(), pipeline.job.id)];
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ bound: 2, indexed: 0, cancelled: 0, duplicates: 0 });
    expect(cancels()).toHaveLength(0);
    const after = [await reread(env(), person.job.id), await reread(env(), pipeline.job.id)];
    expect(after.map((j) => [j.state, j.flag_mismatch, j.cancel_requested_at])).toEqual(
      before.map((j) => [j.state, j.flag_mismatch, j.cancel_requested_at]),
    );
    expect(after[1]?.gateway_user).toBe("nemar-pipelines");
  });

  test("a SECOND job under a row's tag is a duplicate: cancelled, the row flagged, and never indexed or charged", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    const mine = (await reread(made.env, made.job.id)).tapis_uuid as string;
    const extra = await foreign({ tags: [`nemar_job:${made.job.id}`], startedMsAgo: 30 * MINUTE });
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ duplicates: 1, indexed: 0, bound: 1 });
    expect(fx.tapis.jobs.get(extra)?.status).toBe("CANCELLED");
    expect(fx.tapis.jobs.get(mine)?.status).not.toBe("CANCELLED");
    expect(total("compute_jobs")).toBe(1);
    expect((await reread(made.env, made.job.id)).flag_mismatch).toBe(1);
    expect(poolCharges()["partner:tenant:cpu"]).toBeUndefined();
  });

  test("a job the submitter binds AFTER the sweep took its snapshot is neither flagged nor cancelled (MUTATION: skip the check of the row's uuid)", async () => {
    const made = await makeJob(fx);
    const uuid = await foreign({ tags: [`nemar_job:${made.job.id}`] });
    const hook = hookedDb(env().DB);
    // Between the sweep's read of which Tapis jobs are bound and its read of this one, the submitter binds it.
    hook.armAfterAll("SELECT tapis_uuid FROM compute_jobs WHERE tapis_uuid IN", () => {
      fx.harness.db.run(
        "UPDATE compute_jobs SET tapis_uuid = ?, state = 'submitted', tapis_status = 'PENDING' WHERE id = ?",
        [uuid, made.job.id],
      );
    });
    const result = await sweepTenantJobs(env({ DB: hook.db }), "live");
    expect(result).toMatchObject({ bound: 1, duplicates: 0, indexed: 0, cancelled: 0 });
    expect(cancels()).toHaveLength(0);
    expect(fx.tapis.jobs.get(uuid)?.status).not.toBe("CANCELLED");
    expect((await reread(made.env, made.job.id)).flag_mismatch).toBe(0);
  });

  test("each bound job is counted once: one bound at the snapshot and one bound after it make `bound` 2, and the log line says so", async () => {
    const early = await makeJob(fx);
    await submitComputeJob(early.env, early.job.id);
    const late = await makeJob(fx);
    const lateUuid = await foreign({ tags: [`nemar_job:${late.job.id}`] });
    const hook = hookedDb(env().DB);
    hook.armAfterAll("SELECT tapis_uuid FROM compute_jobs WHERE tapis_uuid IN", () => {
      fx.harness.db.run(
        "UPDATE compute_jobs SET tapis_uuid = ?, state = 'submitted', tapis_status = 'PENDING' WHERE id = ?",
        [lateUuid, late.job.id],
      );
    });
    const result = await sweepTenantJobs(env({ DB: hook.db }), "live");
    expect(result).toMatchObject({ listed: 2, bound: 2, duplicates: 0, indexed: 0, cancelled: 0 });
    expect(result && tenantLogLine(result)).toBeNull();
    const withOne = result && tenantLogLine({ ...result, indexed: 1 });
    expect(withOne?.line).toContain("bound=2");
  });

  test("an insert that does nothing because a row has the job cancels it only if the row is the sweep's own (MUTATION: cancel after a conflicting insert)", async () => {
    const mine = await makeJob(fx);
    const untagged = await foreign({});
    const hook = hookedDb(env().DB);
    // A NEMAR row takes the job between the snapshot and the sweep's insert.
    hook.armAfterAll("SELECT tapis_uuid FROM compute_jobs WHERE tapis_uuid IN", () => {
      fx.harness.db.run(
        "UPDATE compute_jobs SET tapis_uuid = ?, state = 'submitted' WHERE id = ?",
        [untagged, mine.job.id],
      );
    });
    const first = await sweepTenantJobs(env({ DB: hook.db }), "live");
    expect(first).toMatchObject({ indexed: 0, cancelled: 0 });
    expect(cancels()).toHaveLength(0);
    expect(total("compute_jobs")).toBe(1);
    expect((await reread(mine.env, mine.job.id)).state).toBe("submitted");
  });

  // A SIMULATED interleaving, not a real one: the hook gives the second run the empty snapshot it would
  // have taken before the first run's row existed. Two concurrent runs over the round-trip database
  // would interleave differently on every execution, so the order this test needs cannot be forced from
  // outside; what is real here is the second run's conflicting insert, and the decision it must make.
  test("the sweep's own row, found again by a second run's conflicting insert, is still cancelled", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 2);
    await sweepTenantJobs(env(), "live");
    expect(cancels()).toHaveLength(2);
    const hook = hookedDb(env().DB);
    // A second run took its snapshot before the first run's row existed: the snapshot it gets is empty.
    hook.armAfterAll("SELECT tapis_uuid FROM compute_jobs WHERE tapis_uuid IN", () => ({
      results: [],
    }));
    const again = await sweepTenantJobs(env({ DB: hook.db }), "live");
    expect(again?.indexed).toBe(0);
    expect(total("compute_jobs")).toBe(1);
    expect(row(uuid)?.flag_unreserved).toBe(1);
    expect(cancels()).toHaveLength(3);
  });

  test("a foreign job that carries a NEMAR-looking tag is not a duplicate: it is unreserved, recorded and charged (MUTATION: trust the tag on any owner)", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    const mine = (await reread(made.env, made.job.id)).tapis_uuid as string;
    const uuid = await foreign({
      owner: "someone-else",
      tags: [`nemar_job:${made.job.id}`],
      startedMsAgo: 30 * MINUTE,
    });
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ duplicates: 0, indexed: 1 });
    expect(row(uuid)).toMatchObject({ flag_unreserved: 1, state: "cancelled" });
    expect(near2000(row(uuid)?.charged_milli)).toBe(true);
    // The NEMAR job the tag named is untouched, and not flagged by a stranger's tag.
    expect((await reread(made.env, made.job.id)).flag_mismatch).toBe(0);
    expect(fx.tapis.jobs.get(mine)?.status).not.toBe("CANCELLED");
  });

  test("a tag for a row that does not exist is no reservation: the job is unreserved", async () => {
    const uuid = await foreign({ tags: ["nemar_job:job_0123456789abcdef01234567"] });
    await sweepTenantJobs(env(), "live");
    expect(row(uuid)).toMatchObject({ flag_unreserved: 1 });
  });
});

describe("the tenant ceiling in the live pass (issue #2121, phase P2)", () => {
  test("a live pass reports the live jobs of its listing and NEMAR's own count against the ceiling", async () => {
    await foreign({ startedMsAgo: 30 * MINUTE });
    const result = await sweepTenantJobs(env(), "live");
    // One live job in the listing; the sweep indexed and canceled it, but both numbers are read BEFORE it did
    // (`readTenantSlots` runs ahead of the loop), so `occupied` is what NEMAR held when the sweep looked.
    expect(result).toMatchObject({ mode: "live", indexed: 1, tenantLive: 1, ceiling: 20 });
    const log = result ? tenantLogLine(result) : null;
    expect(log?.level).toBe("info");
    expect(log?.line).toContain("tenant_live=1");
    expect(log?.line).toContain(`occupied=${result?.occupied}/20`);
    // The other counts and words are as they were.
    expect(log?.line).toContain("indexed=1");
    expect(log?.line).toContain("errors=none");
  });

  test("more live jobs in the tenant than the ceiling is a warning, even when the sweep did nothing else", async () => {
    // Two live jobs made through `createJob`, then the owner lowers the ceiling to 1: the tenant holds more
    // than the ceiling, and they are bound to rows, so the sweep leaves them alone.
    const first = await makeJob(fx);
    const second = await makeJob(fx, { env: first.env });
    await submitComputeJob(first.env, first.job.id);
    await submitComputeJob(second.env, second.job.id);
    await setPolicy(env().DB, fx.ownerId, {
      tenant: { maxLiveJobs: 1, reserved: { people: 0, pipelines: 0, partner: 0 } },
    });
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ indexed: 0, bound: 2, tenantLive: 2, ceiling: 1 });
    const log = result ? tenantLogLine(result) : null;
    expect(log?.level).toBe("warn");
    expect(log?.line).toContain("tenant_live=2");
    expect(log?.line).toContain("occupied=2/1");
  });

  test("within the ceiling and with nothing done, there is still no line", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ tenantLive: 1, ceiling: 20 });
    expect(result && tenantLogLine(result)).toBeNull();
  });

  test("the daily pass has no tenant numbers: its listing is a week, not what is live", async () => {
    await foreign({ startedMsAgo: 30 * MINUTE });
    const result = await sweepTenantJobs(env(), "week");
    expect(result).toMatchObject({ tenantLive: null, occupied: null, ceiling: null });
    const log = result ? tenantLogLine(result) : null;
    expect(log?.line).not.toContain("tenant_live");
  });
});

describe("the daily pass", () => {
  test("looks at the last seven days, ended jobs included; the live pass looks only at what has not ended", async () => {
    const recent = await foreign({
      startedMsAgo: 3 * 24 * 60 * MINUTE,
      finished: true,
      createdMsAgo: 2 * 24 * 60 * MINUTE,
    });
    const old = await foreign({
      startedMsAgo: 9 * 24 * 60 * MINUTE,
      finished: true,
      createdMsAgo: 9 * 24 * 60 * MINUTE,
    });
    expect((await sweepTenantJobs(env(), "live"))?.indexed).toBe(0);
    const week = await sweepTenantJobs(env(), "week");
    expect(week?.indexed).toBe(1);
    expect(row(recent)).toMatchObject({ flag_unreserved: 1, state: "finished" });
    expect(row(old)).toBeNull();
    // It ended before NEMAR saw it, so it is not cancelled again; its use is charged.
    expect(cancels()).toHaveLength(0);
    expect((row(recent)?.charged_milli as number) > 0).toBe(true);
  });

  test("a week pass leaves a bound job alone and reports the ACCESS reports that failed, by word", async () => {
    fx.harness.db.run(
      `INSERT INTO compute_access_reports (job_id, state, last_error_code)
       VALUES ('job_0123456789abcdef01234567', 'failed', 'outcome_unknown'),
              ('job_0123456789abcdef01234568', 'failed', 'outcome_unknown'),
              ('job_0123456789abcdef01234569', 'failed', 'no_gateway_user'),
              ('job_0123456789abcdef0123456a', 'pending', NULL)`,
    );
    const result = await sweepTenantJobs(env(), "week");
    expect(result?.accessFailed).toEqual({ no_gateway_user: 1, outcome_unknown: 2 });
    const log = result ? tenantLogLine(result) : null;
    expect(log?.level).toBe("error");
    expect(log?.line).toContain("access_outcome_unknown=2");
    expect(log?.line).toContain("access_no_gateway_user=1");
    // The live pass does not read them.
    expect((await sweepTenantJobs(env(), "live"))?.accessFailed).toEqual({});
  });
});

describe("the listing", () => {
  const listCalls = () => fx.tapis.log.filter((r) => r.route === "GET /v3/jobs/list");

  test("asks for the newest first, 1,000 a page, through ALL_JOBS", async () => {
    await foreign();
    await sweepTenantJobs(env(), "live");
    const query = new URL(`http://x${listCalls()[0]?.path}`).searchParams;
    expect(query.get("orderBy")).toBe("created(desc)");
    expect(query.get("listType")).toBe("ALL_JOBS");
    expect(query.get("limit")).toBe("1000");
    expect(query.get("skip")).toBe("0");
  });

  /** Five full pages of ended jobs; `liveOnLast` replaces one of the last page's jobs by the given record. */
  function fivePages(liveOnLast?: { uuid: string; status: string }) {
    const ended = (page: number) =>
      Array.from({ length: 1000 }, (_, i) => ({
        uuid: `00000000-0000-0000-${String(page).padStart(4, "0")}-${String(i).padStart(12, "0")}-007`,
        status: "FINISHED",
        owner: fx.tapis.username,
        created: new Date().toISOString(),
      }));
    for (let page = 0; page < 5; page++) {
      const jobs = ended(page);
      if (page === 4 && liveOnLast) {
        jobs[999] = { ...jobs[999], ...liveOnLast } as (typeof jobs)[number];
      }
      fx.tapis.respond("GET /v3/jobs/list", 200, {
        status: "success",
        message: "ok",
        version: "1",
        result: jobs,
      });
    }
  }

  test("five full pages are read and no more, and nothing past the cut is invented (MUTATION: read on past five)", async () => {
    fivePages();
    const result = await sweepTenantJobs(env(), "live");
    expect(listCalls()).toHaveLength(5);
    expect(listCalls().map((c) => new URL(`http://x${c.path}`).searchParams.get("skip"))).toEqual([
      "0",
      "1000",
      "2000",
      "3000",
      "4000",
    ]);
    expect(result).toMatchObject({ listed: 5000, truncated: true, indexed: 0 });
  }, 30_000);

  test("a live pass cut off over ended jobs only is not a problem: no live job can hide behind it (MUTATION: raise on every cut)", async () => {
    fivePages();
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ truncated: true, liveMayHide: false });
    expect(result ? tenantLogLine(result) : "missing").toBeNull();
  }, 30_000);

  test("a live pass whose last page still holds a job that has not ended says so at error level, since an older live job could hide (MUTATION: ignore the last page)", async () => {
    const made = await makeJob(fx);
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fivePages({ uuid, status: "RUNNING" });
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ truncated: true, liveMayHide: true, errors: [] });
    const log = result ? tenantLogLine(result) : null;
    expect(log?.level).toBe("error");
    expect(log?.line).toContain("truncated=1");
    expect(log?.line).toContain("live_may_hide=1");
  }, 30_000);

  test("a week pass cut off is a problem whatever the last page holds: a job of the week may be missing", async () => {
    fivePages();
    const result = await sweepTenantJobs(env(), "week");
    expect(result).toMatchObject({ truncated: true, liveMayHide: false });
    const log = result ? tenantLogLine(result) : null;
    expect(log?.level).toBe("error");
    expect(log?.line).toContain("truncated=1");
  }, 30_000);

  test("a last page with fewer than 1,000 ends the listing", async () => {
    fx.tapis.respond("GET /v3/jobs/list", 200, {
      status: "success",
      message: "ok",
      version: "1",
      result: [],
    });
    const result = await sweepTenantJobs(env(), "live");
    expect(result).toMatchObject({ listed: 0, truncated: false });
    expect(listCalls()).toHaveLength(1);
  });
});

describe("what the sweep will not do", () => {
  test("with Tapis unreachable it changes nothing at all", async () => {
    await foreign({ startedMsAgo: 30 * MINUTE });
    const made = await makeJob(fx);
    const before = {
      jobs: total("compute_jobs"),
      ledger: total("compute_ledger"),
      audit: total("audit_log"),
      pools: poolCharges(),
    };
    fx.tapis.down();
    const result = await sweepTenantJobs(env(), "live");
    fx.tapis.up();
    expect(result?.errors).toEqual(["list_failed"]);
    expect({
      jobs: total("compute_jobs"),
      ledger: total("compute_ledger"),
      audit: total("audit_log"),
      pools: poolCharges(),
    }).toEqual(before);
    expect(cancels()).toHaveLength(0);
    expect((await reread(made.env, made.job.id)).state).toBe("created");
  });

  test("a week pass with Tapis unreachable settles nothing against Expanse's figures either; with Tapis back it does (MUTATION: carry on after a failed listing)", async () => {
    const j = await endedJob(fx, 30);
    fx.harness.db.run(
      `INSERT INTO compute_sacct_rows (slurm_job_id, run_id, partition, state, elapsed_seconds, alloc_nodes, alloc_cpus, alloc_gpus, alloc_mem_mb, charged_milli)
       VALUES (?, '11111111-2222-3333-4444-555555555555', 'shared', 'COMPLETED', 1800, 1, 4, 0, 8000, 2200)`,
      [j.job.slurm_job_id],
    );
    fx.tapis.down();
    const down = await sweepTenantJobs(env(), "week");
    fx.tapis.up();
    expect(down).toMatchObject({ errors: ["list_failed"], settledFinal: 0 });
    expect((await reread(j.env, j.job.id)).settled_final_at).toBeNull();
    const up = await sweepTenantJobs(env(), "week");
    expect(up?.settledFinal).toBe(1);
    expect((await reread(j.env, j.job.id)).charged_milli).toBe(2200);
  });

  test("a job that cannot be recorded is not cancelled: the row is written before the cancel (MUTATION: cancel first)", async () => {
    const uuid = await foreign({ startedMsAgo: 30 * MINUTE });
    const real = env().DB;
    const failing = new Proxy(real, {
      get(target, prop) {
        if (prop !== "prepare") {
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.startsWith("INSERT INTO compute_jobs")) return statement;
          const broken: Record<string, unknown> = {
            bind: () => broken,
            run: async () => {
              throw new Error("D1 refused the write");
            },
          };
          return broken;
        };
      },
    });
    const result = await sweepTenantJobs(env({ DB: failing }), "live");
    expect(result?.errors).toContain("job_failed");
    expect(result?.indexed).toBe(0);
    expect(cancels()).toHaveLength(0);
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("RUNNING");
    expect(total("compute_jobs")).toBe(0);
    // And the next run, with the database back, indexes and cancels it.
    expect((await sweepTenantJobs(env(), "live"))?.indexed).toBe(1);
    expect(cancels()).toHaveLength(1);
  });

  test("a listing Tapis refuses is the same: a fixed word and nothing written", async () => {
    await foreign();
    fx.tapis.fail("GET /v3/jobs/list", 500, 3);
    const result = await sweepTenantJobs(env(), "live");
    expect(result?.errors).toEqual(["list_failed"]);
    expect(total("compute_jobs")).toBe(0);
    expect(cancels()).toHaveLength(0);
  });

  test("outside exact production, or with compute off, it returns before it reads anything", async () => {
    await foreign({ startedMsAgo: 30 * MINUTE });
    const requests = fx.tapis.log.length;
    expect(await sweepTenantJobs(env({ ENVIRONMENT: "development" }), "live")).toBeNull();
    expect(await sweepTenantJobs(env({ ENVIRONMENT: "staging" }), "week")).toBeNull();
    expect(await sweepTenantJobs(env({ COMPUTE_ENABLED: undefined }), "live")).toBeNull();
    expect(await sweepTenantJobs(env({ COMPUTE_ENABLED: "true" }), "live")).toBeNull();
    expect(fx.tapis.log.length).toBe(requests);
    expect(total("compute_jobs")).toBe(0);
  });

  test("with Tapis unconfigured it says so and does nothing", async () => {
    const result = await sweepTenantJobs(env({ TAPIS_AUTH_STRATEGY: undefined }), "live");
    expect(result?.errors).toEqual(["unconfigured"]);
  });

  test("more unbound jobs than a run handles are deferred, loudly, and taken next run", async () => {
    for (let i = 0; i < TENANT_NEW_PER_RUN + 2; i++) await foreign();
    const first = await sweepTenantJobs(env(), "live");
    expect(first?.indexed).toBe(TENANT_NEW_PER_RUN);
    expect(first?.deferred).toBe(2);
    const log = first ? tenantLogLine(first) : null;
    expect(log?.level).toBe("error");
    expect(log?.line).toContain("deferred=2");
    const second = await sweepTenantJobs(env(), "live");
    expect(second?.indexed).toBe(2);
    expect(total("compute_jobs")).toBe(TENANT_NEW_PER_RUN + 2);
  }, 60_000);

  test("its log line names counts and fixed words, never an owner, a uuid or a job", async () => {
    const uuid = await foreign({ owner: "private-owner-name", startedMsAgo: 30 * MINUTE });
    const lines = await logged(async () => {
      const r = await sweepTenantJobs(env(), "live");
      const log = r ? tenantLogLine(r) : null;
      if (log) console.log(log.line);
    });
    const joined = lines.join("\n");
    expect(joined).toContain("[compute-tenant]");
    for (const secret of ["private-owner-name", uuid, row(uuid)?.id as string, fx.tapis.password]) {
      expect(joined.includes(secret)).toBe(false);
    }
    // A run that found nothing and failed at nothing says nothing at all.
    const quiet = await sweepTenantJobs(env(), "live");
    expect(quiet && tenantLogLine(quiet)).toBeNull();
  });
});
