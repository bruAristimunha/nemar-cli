/**
 * The five points phase A5 left open for phase A7 (epic #2005 phase A7, #2012; ADR 0118), each with a test
 * that fails on the old behavior. Real migrations, the real ledger, Miniflare's R2 and the Tapis
 * stand-in (nothing from which was recorded from a real tenant).
 *
 *  - the two terminal repair lists, the orphan list and the cancel list ROTATE: a row that cannot make
 *    progress goes to the back, and the eleventh row is reached on the second tick;
 *  - a row has one orphan slot, and a second orphan is logged and flagged, not lost silently (the tenant
 *    sweep cancels any duplicate it lists, which `compute-sweep.test.ts` pins);
 *  - a terminal row whose Tapis record is gone, or has been unreadable for a week, is settled without it;
 *  - a cancel recorded on staging is carried out by `advance` (the cancel sweep is production-only).
 *
 * The sixth point, that the 30-minute tick equals the default reservation wait, is not changed: it is the
 * owner's policy (`reservationWaitMinutes`), and a value under two ticks gives a `created` job one retry;
 * the PR and the implementation notes say so.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runComputeAdvanceCron, sweepComputeCancellations } from "../src/services/compute-advance";
import {
  advanceComputeJob,
  recordOrphan,
  requestComputeCancel,
  submitComputeJob,
} from "../src/services/compute-lifecycle";
import type { Bindings } from "../src/types/bindings";
import {
  type LifecycleFixture,
  makeJob,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { setPolicy } from "./helpers/compute-seed";
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

const cancels = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel");

describe("the repair lists rotate (open point: terminal repair lists ordered by age with no rotation)", () => {
  /** A failed job with its hold still open and a Tapis job the (unconfigured) Worker cannot read: it can never be repaired. */
  async function stuck(i: number) {
    const made = await makeJob(fx);
    fx.harness.db.run(
      `UPDATE compute_jobs SET state = 'failed', failure_code = 'tapis_error', tapis_status = 'FAILED',
              tapis_uuid = ?, ended_at = datetime('now', ?) WHERE id = ?`,
      [`stuck-${i}`, `-${60 + i} minutes`, made.job.id],
    );
    return made.job.id;
  }
  const examined = (ids: string[]) =>
    ids.filter(
      (id) =>
        (
          fx.harness.db.query("SELECT examined_at FROM compute_jobs WHERE id = ?").get(id) as {
            examined_at: string | null;
          }
        ).examined_at !== null,
    ).length;

  test("twelve settlements that fail on every attempt are all reached in two ticks, not the oldest ten twice (MUTATION: order by age again)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await stuck(i));
    const unconfigured = env({ TAPIS_AUTH_STRATEGY: undefined });
    await runComputeAdvanceCron(unconfigured);
    expect(examined(ids)).toBe(10);
    await runComputeAdvanceCron(unconfigured);
    expect(examined(ids)).toBe(12);
  });

  test("the copy list rotates the same way", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const made = await makeJob(fx);
      fx.harness.db.run(
        `UPDATE compute_jobs SET state = 'failed', failure_code = 'tapis_error', ended_at = datetime('now', ?),
                settled_provisional_at = datetime('now'), tapis_uuid = ? WHERE id = ?`,
        [`-${60 + i} minutes`, `copy-${i}`, made.job.id],
      );
      ids.push(made.job.id);
    }
    const unconfigured = env({ TAPIS_AUTH_STRATEGY: undefined });
    await runComputeAdvanceCron(unconfigured);
    expect(examined(ids)).toBe(10);
    await runComputeAdvanceCron(unconfigured);
    expect(examined(ids)).toBe(12);
  });
});

describe("the orphan list and the cancel list rotate (open points)", () => {
  test("eleven orphans whose cancel fails are all tried in two ticks (MUTATION: do not stamp the orphan row)", async () => {
    const ids: string[] = [];
    // Eleven live jobs that each record an orphan hold 22 slots (an orphan counts, issue #2121): more than the
    // default tenant ceiling, which is not what this case is about.
    await setPolicy(env().DB, fx.ownerId, {
      tenant: { maxLiveJobs: 1000, reserved: { people: 0, pipelines: 0, partner: 0 } },
    });
    for (let i = 0; i < 11; i++) {
      const made = await makeJob(fx);
      fx.harness.db.run("UPDATE compute_jobs SET orphan_tapis_uuid = ? WHERE id = ?", [
        `orphan-${i}`,
        made.job.id,
      ]);
      ids.push(made.job.id);
    }
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 100);
    // Every orphan's cancel failed, and each failure is counted (an orphan still running spends the pool).
    expect(await sweepComputeCancellations(env())).toMatchObject({ cancel_failed: 10 });
    const stamped = () =>
      ids.filter(
        (id) =>
          (
            fx.harness.db.query("SELECT examined_at FROM compute_jobs WHERE id = ?").get(id) as {
              examined_at: string | null;
            }
          ).examined_at !== null,
      ).length;
    expect(stamped()).toBe(10);
    await sweepComputeCancellations(env());
    expect(stamped()).toBe(11);
    // None was cleared: every cancel failed, and the orphans are still owed.
    expect(
      fx.harness.db
        .query("SELECT COUNT(*) AS n FROM compute_jobs WHERE orphan_tapis_uuid IS NOT NULL")
        .get(),
    ).toEqual({ n: 11 });
  });

  test("eleven cancels Tapis cannot take are all attempted in two ticks, not the oldest ten twice (MUTATION: order by the request time only)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const made = await makeJob(fx);
      await submitComputeJob(made.env, made.job.id);
      fx.harness.db.run(
        "UPDATE compute_jobs SET cancel_requested_at = datetime('now', ?), cancel_reason = 'account_ended' WHERE id = ?",
        [`-${30 - i} minutes`, made.job.id],
      );
      ids.push(made.job.id);
    }
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 100);
    await sweepComputeCancellations(env());
    const attempted = () =>
      ids.filter(
        (id) =>
          (
            fx.harness.db
              .query("SELECT cancel_attempted_at FROM compute_jobs WHERE id = ?")
              .get(id) as {
              cancel_attempted_at: string | null;
            }
          ).cancel_attempted_at !== null,
      ).length;
    expect(attempted()).toBe(10);
    await sweepComputeCancellations(env());
    expect(attempted()).toBe(11);
  });
});

describe("a row has one orphan slot, and a second orphan is not lost silently", () => {
  test("the second is logged, the row is flagged, and the first stays", async () => {
    const made = await makeJob(fx);
    expect(await recordOrphan(made.env, made.job.id, "first-uuid")).toBe(true);
    let result = true;
    const lines = await logged(async () => {
      result = await recordOrphan(made.env, made.job.id, "second-uuid");
    });
    expect(result).toBe(false);
    expect(lines.some((l) => l.includes("orphan_slot_taken") && l.includes(made.job.id))).toBe(
      true,
    );
    const after = await reread(made.env, made.job.id);
    expect(after.orphan_tapis_uuid).toBe("first-uuid");
    expect(after.flag_mismatch).toBe(1);
    // The same uuid again is not a second orphan.
    expect(await recordOrphan(made.env, made.job.id, "first-uuid")).toBe(true);
  });
});

describe("an orphan's cancel clears the record only when the orphan is known to be over", () => {
  /** A row that owes the cancel of a Tapis job NEMAR made, which is a REAL job in the stand-in unless `uuid` says otherwise. */
  async function orphanOf(uuid?: string) {
    const made = await makeJob(fx);
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    const real = (await reread(made.env, made.job.id)).tapis_uuid as string;
    // The row ends elsewhere; the Tapis job it made is the orphan.
    fx.harness.db.run("UPDATE compute_jobs SET orphan_tapis_uuid = ? WHERE id = ?", [
      uuid ?? real,
      made.job.id,
    ]);
    return { made, real };
  }
  const orphanOn = (id: string) =>
    (
      fx.harness.db.query("SELECT orphan_tapis_uuid FROM compute_jobs WHERE id = ?").get(id) as {
        orphan_tapis_uuid: string | null;
      }
    ).orphan_tapis_uuid;

  test("a 400 or a 403 is a failure: the orphan stays marked, asked again, and counted (MUTATION: clear on any `rejected`)", async () => {
    for (const status of [400, 403]) {
      const { made, real } = await orphanOf();
      fx.tapis.fail("POST /v3/jobs/:uuid/cancel", status);
      await sweepComputeCancellations(env());
      expect([status, orphanOn(made.job.id)]).toEqual([status, real]);
    }
  });

  test("a 409 means it is over: the record is cleared", async () => {
    const { made } = await orphanOf();
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 409);
    await sweepComputeCancellations(env());
    expect(orphanOn(made.job.id)).toBeNull();
  });

  test("a refusal clears the record when a read shows the job has ENDED (a 400 for cancelling a finished job), and not while it runs (MUTATION: never read after a refusal)", async () => {
    const { made, real } = await orphanOf();
    fx.tapis.advance(real, "FINISHED");
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 400);
    await sweepComputeCancellations(env());
    expect(orphanOn(made.job.id)).toBeNull();
    // The same refusal for a job that is still running keeps the alarm.
    const live = await orphanOf();
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 400);
    const swept = await sweepComputeCancellations(env());
    expect(orphanOn(live.made.job.id)).toBe(live.real);
    expect(swept).toMatchObject({ cancel_failed: 1 });
  });

  test("a 404 clears the record only when a read of the job confirms it is gone", async () => {
    // Gone: the cancel and the read both answer 404.
    const gone = await orphanOf("00000000-gone-gone-gone-000000000000");
    await sweepComputeCancellations(env());
    expect(orphanOn(gone.made.job.id)).toBeNull();
    // A cancel that answers 404 for a job the read still finds is not gone.
    const there = await orphanOf();
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 404);
    await sweepComputeCancellations(env());
    expect(orphanOn(there.made.job.id)).toBe(there.real);
  });
});

describe("a terminal row whose Tapis record is unreadable is settled without it (open point)", () => {
  async function terminalUnsettled(uuid: string, endedAgo: string) {
    const made = await makeJob(fx);
    fx.harness.db.run(
      `UPDATE compute_jobs SET state = 'failed', failure_code = 'tapis_error', tapis_status = 'FAILED',
              tapis_uuid = ?, ended_at = datetime('now', ?) WHERE id = ?`,
      [uuid, endedAgo, made.job.id],
    );
    return made;
  }

  test("a job Tapis no longer has is settled at once: released (nothing shows it ran), flagged", async () => {
    const made = await terminalUnsettled("00000000-gone-gone-gone-000000000000", "-5 minutes");
    await advanceComputeJob(made.env, made.job.id);
    const after = await reread(made.env, made.job.id);
    expect(after.settled_provisional_at).not.toBeNull();
    expect(after.flag_mismatch).toBe(1);
    const kinds = (
      fx.harness.db
        .query("SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id")
        .all(made.job.id) as Array<{ kind: string }>
    ).map((k) => k.kind);
    expect(kinds).toEqual(["hold", "release"]);
  });

  test("one Tapis merely cannot answer for stays owed for a week, then is settled the same way (MUTATION: retry for ever)", async () => {
    const recent = await terminalUnsettled("recent-recent-recent", "-1 day");
    const old = await terminalUnsettled("old-old-old-old-old", "-8 days");
    fx.tapis.fail("GET /v3/jobs/:uuid", 503, 100);
    await advanceComputeJob(recent.env, recent.job.id);
    await advanceComputeJob(old.env, old.job.id);
    expect((await reread(recent.env, recent.job.id)).settled_provisional_at).toBeNull();
    const settled = await reread(old.env, old.job.id);
    expect(settled.settled_provisional_at).not.toBeNull();
    expect(settled.flag_mismatch).toBe(1);
  });
});

describe("staging carries out a recorded cancel (open point: the cancel sweep is production-only)", () => {
  test("`advance` on development drives a cancel that Tapis could not take when it was asked", async () => {
    const dev = env({ ENVIRONMENT: "development" });
    const made = await makeJob(fx, { env: dev });
    expect(await submitComputeJob(dev, made.job.id)).toEqual({ ok: true, outcome: "submitted" });
    const uuid = (await reread(dev, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 1);
    await requestComputeCancel(dev, made.job.id, "admin");
    expect((await reread(dev, made.job.id)).state).not.toBe("cancelled");
    expect(cancels()).toHaveLength(1);
    // The production-only sweep does nothing on staging; the administrator's advance does.
    expect(await sweepComputeCancellations(dev)).toBeNull();
    await advanceComputeJob(dev, made.job.id);
    expect(cancels()).toHaveLength(2);
    expect((await reread(dev, made.job.id)).state).toBe("cancelled");
  });
});
