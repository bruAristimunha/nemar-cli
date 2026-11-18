/**
 * The compute gateway's three dark switches (epic #2005 phase A4, #2009; ADR 0118 decision 8; the third is
 * portable compute's, card DM-05).
 *
 * Nothing here acts. These readers say whether a Worker job may act, and each job that reads them
 * reads at CALL time (a binding changed in a test changes the answer; nothing is cached at module
 * load). The rules, each one deliberate:
 *
 *  - Compute runs only in exactly `production` or exactly `development`. No trim, no case fold, and an
 *    unset binding is neither, so a binding that went missing or was misspelled can never turn
 *    compute on. Development is allowed so staging can run compute against a development tenant with
 *    its own credentials; every compute SCHEDULE stays production-only (the cron allowlist), and in
 *    development a job advances by its webhook, by a read, and by an administrator's command.
 *  - A switch is on only as the exact string `"1"` (as `AUTO_REPULL_ENABLED`). `"true"`, `" 1"`, `"yes"`,
 *    an unset binding, and a value that only converts to it (the number 1, `true`, `["1"]`) are off.
 *  - The pipelines switch acts only while the compute switch is also on, so turning compute off stops
 *    NEMAR's own dispatch whatever the second switch says.
 *  - The runners switch (portable compute, D7) is the third, and acts the same way: a registered runner
 *    can exchange its secret and use its access token only while compute is on AND this is exactly `"1"`.
 *
 * All three names are absent from every table of `backend/wrangler-sccn.toml`; the owner adds them in a
 * reviewed change (`compute-switches-flag.test.ts` pins that).
 */

import type { Bindings } from "../types/bindings";

/** The environments compute may run in: exactly these two words. */
const COMPUTE_ENVIRONMENTS = ["production", "development"] as const;

/**
 * Whether a binding is the STRING `"1"`, and nothing that merely converts to it. A variable set in the
 * wrangler configuration as a TOML integer arrives as the number 1, and `1 == "1"`, `String(1) === "1"`
 * and `["1"] == "1"` are all true in JavaScript: none of them may turn a dark switch on. This is a
 * refactor with NO change of behaviour (the code was already a strict `=== "1"`); what it adds is a
 * name for the rule and the tests that pin it against those conversions.
 */
function isOne(value: unknown): boolean {
  return typeof value === "string" && value === "1";
}

/** Whether `ENVIRONMENT` is exactly `production` or exactly `development`. */
export function isComputeEnvironment(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  return (COMPUTE_ENVIRONMENTS as readonly unknown[]).includes(env.ENVIRONMENT);
}

/** Compute may run: production or development, and the switch exactly `"1"`. */
export function computeEnabled(env: Pick<Bindings, "ENVIRONMENT" | "COMPUTE_ENABLED">): boolean {
  return isComputeEnvironment(env) && isOne(env.COMPUTE_ENABLED);
}

/** NEMAR's own pipelines may be dispatched: compute is on, and this switch is exactly `"1"`. */
export function computePipelinesDispatchEnabled(
  env: Pick<Bindings, "ENVIRONMENT" | "COMPUTE_ENABLED" | "COMPUTE_PIPELINES_DISPATCH_ENABLED">,
): boolean {
  return computeEnabled(env) && isOne(env.COMPUTE_PIPELINES_DISPATCH_ENABLED);
}

/** Registered runners may exchange a secret and use an access token: compute is on, and this switch is exactly `"1"`. */
export function computeRunnersEnabled(
  env: Pick<Bindings, "ENVIRONMENT" | "COMPUTE_ENABLED" | "COMPUTE_RUNNERS_ENABLED">,
): boolean {
  return computeEnabled(env) && isOne(env.COMPUTE_RUNNERS_ENABLED);
}
