/**
 * What `GET /admin/compute/status` answers (epic #2005 phase A4, #2009; ADR 0118): the owner's way to
 * check, once the secrets are set, that the Worker can reach and sign in to the Tapis tenant and
 * reach its storage, without a shell.
 *
 * BOOLEANS AND FIXED WORDS ONLY. Nothing here is a secret value, an address, a tenant name or a
 * username: each piece is `true` or `false`, the environment is one of three words, and the two
 * calls are `ok`, `unconfigured`, `skipped` or the KIND of the error they failed with
 * (`TapisError.kind`, never its message). The names of what is missing (`TAPIS_PASSWORD:missing`)
 * are the Worker's own binding names, which this repository publishes.
 *
 * ONE MINT AND ONE HEALTH CALL, made now: the token is minted afresh (`mintTapisToken`, which asks
 * Tapis whatever the cache holds and keeps nothing), so the answer is about the credential, not
 * about a cache; the health call is the unauthenticated `GET /v3/jobs/healthcheck`, so it says the
 * tenant can be reached, and the mint says the credential works. They run together, each with a short
 * timeout and a single attempt, so the route answers within a few seconds whatever Tapis does. This
 * route writes nothing.
 *
 * `prerequisites` says, as presence booleans, what every launch needs besides the credential and the
 * buckets; `reconciliation.paused` says the tenant sweep is off with the compute switch; `attention` is
 * a record of counts (one row of `ATTENTION_COUNTS` each).
 *
 * `runtime_image` (round 1 of #2041) says whether the owner has set `COMPUTE_RUNTIME_IMAGE`, whether
 * what is set is a digest-pinned reference, and its digest: a `python` job is not submitted until it is
 * `valid`. The reference itself is never echoed.
 */

import type { ComputeStatusResponse } from "../../../shared/contract/compute-admin";
import type { Bindings } from "../types/bindings";
import { CANCEL_PENDING_FAILED_SQL, COPY_ABANDONED_COUNT_SQL } from "./compute-lifecycle";
import { pipelinesAccountId } from "./compute-pipeline";
import { ComputePolicyUnreadable, getPolicy } from "./compute-policy";
import { RUNNER_ATTENTION_COUNTS } from "./compute-runner-queue";
import { readRuntimeImage } from "./compute-runtime-image";
import { computeS3 } from "./compute-s3";
import { computeEnabled, computePipelinesDispatchEnabled } from "./compute-switches";
import { type TenantFacts, tenantFacts, tenantOverCeiling } from "./compute-tenant";
import { mintTapisToken } from "./tapis/auth";
import { tapisHealth } from "./tapis/client";
import { tapisConfig } from "./tapis/config";
import { TapisError } from "./tapis/errors";
import { TAPIS_OWNER_RE } from "./tapis/schemas";

/** How long each of the two calls may take: short, so an admin's request is never held for long. */
export const STATUS_TIMEOUT_MS = 8000;

const present = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim() !== "";

/** The environment as one of three words, so an unexpected value is never echoed. */
function environmentWord(
  env: Pick<Bindings, "ENVIRONMENT">,
): "production" | "development" | "other" {
  return env.ENVIRONMENT === "production" || env.ENVIRONMENT === "development"
    ? env.ENVIRONMENT
    : "other";
}

/** A call's outcome as a fixed word: `ok`, or the kind it failed with. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (err) {
    if (err instanceof TapisError) return err.kind;
    // Not something Tapis said: log the class only (never a message), and report the call as not working.
    console.error(
      "[compute-status] unexpected failure:",
      err instanceof Error ? err.name : typeof err,
    );
    return "unavailable";
  }
}

/** Whether `COMPUTE_RUNTIME_IMAGE` is set, whether it is a digest-pinned reference, and its digest; never the reference. */
function runtimeImageStatus(env: Bindings): ComputeStatusResponse["runtime_image"] {
  const image = readRuntimeImage(env);
  return {
    set: image.state !== "unset",
    valid: image.state === "ok",
    digest: image.state === "ok" ? image.digest : null,
  };
}

/**
 * Counts that need a person to look. ONE ROW A COUNT: `[key, statement]`, the statement a single
 * `SELECT COUNT(*) AS n`; add a line and the Worker, the contract (a record of counts) and the CLI
 * (which prints every key) carry it. Fixed words as keys, never a value. Two more are derived from the owner's
 * policy and are added by `attentionCounts`: `tenant_over_ceiling` and `policy_unreadable`.
 */
const ATTENTION_COUNTS: ReadonlyArray<readonly [key: string, sql: string]> = [
  [
    "access_reports_failed",
    "SELECT COUNT(*) AS n FROM compute_access_reports WHERE state = 'failed'",
  ],
  // A recorded cancel still not carried out an hour after it was asked for (the cancel sweep retries it).
  ["cancel_pending_failed", CANCEL_PENDING_FAILED_SQL],
  // A terminal row whose copy of the launcher files was never made and no longer will be (flagged `mismatch`).
  ["copy_abandoned", COPY_ABANDONED_COUNT_SQL],
  // The same two for runner jobs (portable compute, ADR 0121): the Tapis counts above select Tapis rows only.
  ...RUNNER_ATTENTION_COUNTS,
];

async function attentionCounts(
  db: D1Database,
  tenant: TenantRead,
): Promise<Record<string, number>> {
  const counts = await Promise.all(
    ATTENTION_COUNTS.map(async ([key, sql]) => {
      const row = await db.prepare(sql).first<{ n: number }>();
      return [key, row?.n ?? 0] as const;
    }),
  );
  // The ceiling is the owner's policy and not a column, so this one is read from the tenant facts. A positive
  // count is a job NEMAR did not admit (one that skipped the reservation, an orphan) or a ceiling the owner
  // lowered below what is already live. Absent while the policy cannot be read.
  if (tenant.facts !== null) {
    counts.push(["tenant_over_ceiling", tenantOverCeiling(tenant.facts)] as const);
  }
  // A stored policy the strict reader cannot parse is a compute outage: every hold, run and limit reads it and
  // fails closed. Said here, because the tenant block is absent for the same reason.
  counts.push(["policy_unreadable", tenant.unreadable ? 1 : 0] as const);
  return Object.fromEntries(counts);
}

/** The tenant ceiling and its counts, and whether the owner's policy could not be read (then no facts). */
interface TenantRead {
  facts: TenantFacts | null;
  unreadable: boolean;
}

async function readTenant(db: D1Database): Promise<TenantRead> {
  try {
    return { facts: await tenantFacts(db, (await getPolicy(db)).policy), unreadable: false };
  } catch (err) {
    // Only an unreadable policy is a finding; a database fault is the route's own failure.
    if (!(err instanceof ComputePolicyUnreadable)) throw err;
    console.error("[compute-status] policy unreadable: version", err.version);
    return { facts: null, unreadable: true };
  }
}

/** Whether any pool of the platform's budget `key` has a grant: a hold on a person's job needs `people`. */
async function platformGranted(db: D1Database, key: "people" | "pipelines"): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS granted FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = ?1 AND granted_milli > 0 LIMIT 1",
    )
    .bind(key)
    .first();
  return row !== null;
}

export interface StatusOptions {
  /** The timeout of each call, at most the client's own 15 seconds. */
  timeoutMs?: number;
}

export async function computeStatus(
  env: Bindings,
  options: StatusOptions = {},
): Promise<ComputeStatusResponse> {
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  // Read ONCE: the source scan pins the places that read the switch, and the report and the paused
  // reconciliation must come from the same read.
  const computeOn = computeEnabled(env);
  const config = tapisConfig(env);

  // The user a token is minted for: the configured account under `password`, and under `service` the
  // NEMAR service identity when one is configured (without it the credential cannot be probed).
  let probeUser: string | undefined;
  if (!config.unconfigured) {
    probeUser = config.username;
    if (
      config.strategy === "service" &&
      probeUser !== undefined &&
      !TAPIS_OWNER_RE.test(probeUser)
    ) {
      probeUser = undefined;
    }
  }

  const [token, health] = await Promise.all([
    config.unconfigured
      ? "unconfigured"
      : probeUser === undefined
        ? "skipped"
        : outcome(() => mintTapisToken(env, { owner: probeUser as string, timeoutMs })),
    outcome(() => tapisHealth(env, { timeoutMs, maxAttempts: 1 })),
  ]);

  const [pipelinesAccount, policy, peopleGranted, pipelinesGranted, tenant] = await Promise.all([
    pipelinesAccountId(env.DB),
    env.DB.prepare("SELECT 1 AS present FROM compute_policy LIMIT 1").first(),
    platformGranted(env.DB, "people"),
    platformGranted(env.DB, "pipelines"),
    readTenant(env.DB),
  ]);
  const attention = await attentionCounts(env.DB, tenant);

  return {
    switches: {
      environment: environmentWord(env),
      compute_enabled: computeOn,
      pipelines_dispatch_enabled: computePipelinesDispatchEnabled(env),
    },
    tapis: {
      configured: !config.unconfigured,
      strategy: config.unconfigured ? null : config.strategy,
      problems: config.unconfigured ? [...config.problems] : [],
      token,
      health,
    },
    storage: {
      records_binding: Boolean(env.COMPUTE_RECORDS),
      results_binding: Boolean(env.COMPUTE_RESULTS),
      signing_configured: computeS3(env) !== null,
    },
    // PRESENCE ONLY, never a value. The ACCESS reports wait until BOTH are set (`accessReportConfig`), so
    // the answer says each: a key without a resource name must not read as "configured".
    access: {
      key_configured: present(env.ACCESS_GATEWAY_ATTRIBUTES_KEY),
      resource_name_configured: present(env.ACCESS_RESOURCE_NAME),
    },
    runtime_image: runtimeImageStatus(env),
    // PRESENCE ONLY. `buildLaunch` refuses a job `unconfigured` without the first two; the account, the
    // policy and the grants are what a pipeline run and a person's hold need.
    prerequisites: {
      callback_secret: present(env.PRESCREEN_CALLBACK_SECRET),
      api_base_url: present(env.API_BASE_URL),
      pipelines_account: pipelinesAccount !== null,
      policy_set: policy !== null,
      people_pool_granted: peopleGranted,
      pipelines_pool_granted: pipelinesGranted,
    },
    // The tenant sweep returns null while compute is off, which pauses what only it does.
    reconciliation: { paused: !computeOn },
    attention,
    ...(tenant.facts === null ? {} : { tenant: tenant.facts }),
  };
}
