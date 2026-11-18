/**
 * NEMAR's tenant-wide ceiling on live jobs (issue #2121, phase P2; ADR 0118, amendment of 2026-11-10).
 *
 * The cluster account has a fixed number of slots and NEMAR shares them among everything it runs. The
 * owner's policy (`tenant`, `shared/contract/compute.ts`) names a ceiling below that number and a floor
 * for each class of occupant; this file is the one place that counts the occupants, decides a job's
 * admission and reads the facts for a refusal and for the administrator's view.
 *
 * THE RULE. A job of class K is admitted when
 *
 *     occupied + 1 + SUM over the classes L other than K of max(0, floor[L] - occupied[L])  <=  ceiling
 *
 * That is: the job takes one slot, and the slots still owed to the OTHER classes' floors are not
 * available to it. A floor is unconditional (a floor slot is never lent to another class) and is only
 * what a class is owed, not what it is limited to: with the defaults (ceiling 20, floors 8 and 2 and 0)
 * the pipelines can burst to 12 and people to 18. The rule is the guard of the hold's own statement
 * (`tenantGuard`), counted in the same statement that writes the hold, so two requests racing for the
 * last slot cannot both win; it is a guard and not a clamp.
 *
 * THE CLASSES, by the job's `source` (the front doors that submit are on other branches of the
 * gateway; the function is by the word so each works when it lands):
 *   people     `cli` and `web`
 *   pipelines  `pipeline`
 *   partner    `partner`, reserved through the gateway (`flag_unreserved = 0`)
 *   other      everything else: a job the tenant sweep found that skipped the reservation
 *              (`flag_unreserved = 1`), and an orphan (below). No floor and no way to be admitted: NEMAR
 *              did not admit them, it only counts them.
 *
 * WHAT OCCUPIES A SLOT. Every `accounting = 'su'` row in a live state (`created` included: it is about to hold
 * one; a runner job is `accounting = 'none'`, holds no Tapis slot and is not counted, ADR 0121), and
 * one slot more for EVERY row that records an orphaned platform job (`orphan_tapis_uuid`), live or not: a
 * Tapis job NEMAR made that no row owns is still running until the cancel is known to have worked. A live
 * row can carry one in two ways, and holds two slots then, its own and the orphan's: a duplicate of the job
 * the row owns (found when a second submit is bound), and a row that is still live with a cancel pending
 * (`created` or `uploading`, `cancel_requested_at` set) whose Tapis job turned up after the cancel was asked
 * for: `bindTapisJob` then records the SAME job as the row's `tapis_uuid` and as its orphan, so that one
 * job counts twice until `cancelOrphan` succeeds or the row ends (it lasts only while the cancel keeps
 * failing, costs one slot, and the row also shows in `cancel_pending_failed` after an hour). The count errs toward too many, not too few, for what NEMAR has
 * recorded; a platform job nothing has recorded is not in it, and neither is a second orphan of one row (the
 * row has one orphan slot): that is what the ceiling's headroom is for. It is NEMAR's view.
 *
 * COST. The live count is answered from a partial index of the live rows, as the person's and the
 * pipelines' counts are. The orphan term is a scan of `compute_jobs`: no index serves it, so every hold pays
 * one scan of the table (one row per job, small). It is written as a plain `orphan_tapis_uuid IS NOT NULL`
 * so that a partial index on exactly that predicate will serve it; the index needs a migration, which P2 does
 * not have, and is filed for the queue phase's (#2131).
 */

import type { ComputeSource } from "../../../shared/compute-state.js";
import {
  type ComputePolicy,
  type ComputeTenantPolicy,
  tenantPolicyOf,
} from "../../../shared/contract/compute.js";
import type { HoldGuard } from "./compute-ledger.js";
import { LIVE_STATES_SQL } from "./compute-state-sql.js";

/** The classes a slot is counted in, the first three with a floor. */
export const TENANT_CLASSES = ["people", "pipelines", "partner", "other"] as const;
export type TenantClass = (typeof TENANT_CLASSES)[number];

/** The classes the owner reserves a floor for (the rest has none). */
export const TENANT_FLOOR_CLASSES = ["people", "pipelines", "partner"] as const;
export type TenantFloorClass = (typeof TENANT_FLOOR_CLASSES)[number];

/** The class a job of this source is admitted as: the one place a source is mapped to a class. */
export function tenantClassOf(source: ComputeSource): TenantFloorClass {
  switch (source) {
    case "cli":
    case "web":
      return "people";
    case "pipeline":
      return "pipelines";
    case "partner":
      return "partner";
  }
}

/**
 * The slots each class holds and the total, one row, every column a number (an empty table is zeros).
 * The class of a row is decided once, in the inner CASE, so a row is counted in exactly one class:
 * a row the sweep flagged as having skipped the reservation is `other` whatever its source says.
 * The first leg is the live rows (the states written LITERALLY so the partial index serves it); the
 * second is the orphan term, every row that records an orphaned platform job.
 */
export const TENANT_COUNTS_SQL = `SELECT
    COALESCE(SUM(c = 'people'), 0) AS people,
    COALESCE(SUM(c = 'pipelines'), 0) AS pipelines,
    COALESCE(SUM(c = 'partner'), 0) AS partner,
    COALESCE(SUM(c = 'other'), 0) AS other,
    COALESCE(COUNT(c), 0) AS occupied
  FROM (
    SELECT CASE
             WHEN flag_unreserved = 1 THEN 'other'
             WHEN source IN ('cli', 'web') THEN 'people'
             WHEN source = 'pipeline' THEN 'pipelines'
             WHEN source = 'partner' THEN 'partner'
             ELSE 'other'
           END AS c
      FROM compute_jobs WHERE state IN (${LIVE_STATES_SQL}) AND accounting = 'su'
    UNION ALL
    SELECT 'other' FROM compute_jobs
     WHERE orphan_tapis_uuid IS NOT NULL
  )`;

/**
 * The guard of the hold for a job of `cls`: the rule above as a boolean expression with plain `?`
 * placeholders (the ledger's `HoldGuard`). The statement differs by class only in which floors it owes,
 * so a class never owes its own; the binds are the other classes' floors in the order of
 * {@link TENANT_FLOOR_CLASSES}, then the ceiling. The job being admitted is not counted yet (its row is
 * written after the hold, in the same batch), hence the `+ 1`.
 */
export function tenantGuard(cls: TenantFloorClass, tenant: ComputeTenantPolicy): HoldGuard {
  const others = TENANT_FLOOR_CLASSES.filter((l) => l !== cls);
  const owed = others.map((l) => ` + MAX(0, ? - t.${l})`).join("");
  return {
    sql: `(SELECT t.occupied + 1${owed} <= ? FROM (${TENANT_COUNTS_SQL}) t)`,
    binds: [...others.map((l) => tenant.reserved[l]), tenant.maxLiveJobs],
  };
}

/** What the tenant ceiling looks like right now: the owner's numbers and the counts. */
export type TenantFacts = {
  ceiling: number;
  occupied: number;
  by_class: Record<TenantClass, number>;
  reserved: Record<TenantFloorClass, number>;
};

interface CountsRow {
  people: number;
  pipelines: number;
  partner: number;
  other: number;
  occupied: number;
}

/** Read the counts once, under the policy's ceiling (or the default when the policy has none). */
export async function tenantFacts(db: D1Database, policy: ComputePolicy): Promise<TenantFacts> {
  const tenant = tenantPolicyOf(policy);
  const row = await db.prepare(TENANT_COUNTS_SQL).first<CountsRow>();
  const by_class: Record<TenantClass, number> = {
    people: row?.people ?? 0,
    pipelines: row?.pipelines ?? 0,
    partner: row?.partner ?? 0,
    other: row?.other ?? 0,
  };
  return {
    ceiling: tenant.maxLiveJobs,
    occupied: row?.occupied ?? 0,
    by_class,
    reserved: { ...tenant.reserved },
  };
}

/**
 * The slots a job of `cls` could take right now, from facts already read: the ceiling less what is
 * occupied less what the OTHER classes' floors are still owed, never below 0. It is the guard's own
 * arithmetic (a job is admitted exactly when this is at least 1), so a dry run and a run's clamp read what
 * the hold will decide; the hold remains the decision, because the facts can move after they are read.
 */
export function tenantRoom(facts: TenantFacts, cls: TenantFloorClass): number {
  let owed = 0;
  for (const l of TENANT_FLOOR_CLASSES) {
    if (l !== cls) owed += Math.max(0, facts.reserved[l] - facts.by_class[l]);
  }
  return Math.max(0, facts.ceiling - facts.occupied - owed);
}

/**
 * Slots occupied beyond the ceiling (0 when within). Two things cause it: a job NEMAR did not admit (one that
 * skipped the reservation, an orphan), or a ceiling the owner lowered below what is already live.
 */
export const tenantOverCeiling = (facts: TenantFacts): number =>
  Math.max(0, facts.occupied - facts.ceiling);
