/**
 * Environment classification (epic #923).
 *
 * Allow-list, fail-CLOSED helpers over the `ENVIRONMENT` binding. The type says
 * ENVIRONMENT is one of production|development|staging|test, but at runtime it's
 * whatever wrangler passes (or undefined if misconfigured). Anything that gates
 * information disclosure or destructive/prod-only behavior must treat an unknown
 * value as production, not "not production" — matching the established
 * convention in auth-web.ts (isDevOrTest), email.ts, and admin/doi.ts.
 */

import type { Bindings } from "../types/bindings.js";

const NON_PRODUCTION = new Set(["development", "staging", "test"]);

/** True only for a recognized non-production environment; unknown/unset -> false. */
export function isNonProductionEnv(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  return NON_PRODUCTION.has((env.ENVIRONMENT ?? "").trim().toLowerCase());
}

/**
 * The S3 origin override (`S3_ENDPOINT_URL`), or `undefined` in anything but a
 * recognized non-production environment. It exists so a test can point S3 reads
 * at a local server; it is fenced because the reads it redirects decide
 * `data_complete` and, through it, the withdrawal rule (ADR 0064), so a stray
 * value in production must not be able to redirect them. Fail-closed: an
 * unknown or unset ENVIRONMENT counts as production.
 */
export function testS3EndpointOverride(
  env: Pick<Bindings, "ENVIRONMENT" | "S3_ENDPOINT_URL">,
): string | undefined {
  return isNonProductionEnv(env) ? env.S3_ENDPOINT_URL : undefined;
}

/** Prod defaults for the two env-resolved origins below. Duplicated as literals
 *  in datacite-constants.ts (landing) and data-router.ts (bytes) so those files
 *  stay usable without an env; keep the three in sync. */
const DEFAULT_LANDING_BASE = "https://nemar.org";
const DEFAULT_DATA_ORIGIN = "https://data.nemar.org";
/** Prod default for {@link appBase}. */
const DEFAULT_APP_BASE = "https://app.nemar.org";

/** Strip trailing slash(es) and surrounding whitespace from an origin. */
function normalizeOrigin(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Base origin for DOI landing URLs (`<base>/dataset/<id>`, epic #923). Prefers an
 * explicit DATASET_LANDING_BASE_URL, then FRONTEND_URL, then the prod apex. Prod
 * is unchanged (FRONTEND_URL is https://nemar.org there); staging resolves to the
 * -test website. Never returns a trailing slash.
 *
 * Both fields are optional (Partial) so partial EzidEnv literals type-check;
 * unlike resolveDataBaseOrigin there is no non-prod warn because FRONTEND_URL is a
 * required, per-environment Bindings field — a real caller always has a correct
 * intermediate, so the pure prod default is unreachable except for a literal that
 * omits both, which the type still admits but no live call site does.
 */
export function resolveDatasetLandingBase(
  env: Partial<Pick<Bindings, "DATASET_LANDING_BASE_URL" | "FRONTEND_URL">>,
): string {
  return normalizeOrigin(
    env.DATASET_LANDING_BASE_URL?.trim() || env.FRONTEND_URL?.trim() || DEFAULT_LANDING_BASE,
  );
}

/**
 * Base origin for data-plane bytes_url links (epic #923). Defaults to the prod
 * data host so served manifests are byte-identical on prod; staging sets
 * DATA_BASE_URL to the -test data host. Never returns a trailing slash.
 */
export function resolveDataBaseOrigin(
  env: Pick<Bindings, "DATA_BASE_URL" | "ENVIRONMENT">,
): string {
  const override = env.DATA_BASE_URL?.trim();
  if (!override && isNonProductionEnv(env)) {
    // Non-prod with no DATA_BASE_URL override: served manifests will embed prod
    // data.nemar.org links, which 404 for dev-bucket-only datasets. Surface the
    // dropped staging override rather than masking it as broken downloads.
    console.warn(
      "[data-router] DATA_BASE_URL unset in a non-production environment; bytes_url will point at the prod data host (data.nemar.org).",
    );
  }
  return normalizeOrigin(override || DEFAULT_DATA_ORIGIN);
}

/** Authenticated app origin for OAuth redirects + post-login landings. Uses
 *  APP_BASE_URL, NOT FRONTEND_URL: the latter is the marketing apex
 *  (https://nemar.org), but the ORCID redirect_uri and the session/pending
 *  cookies are scoped to the app host (https://app.nemar.org).
 *
 *  Hoisted here from routes/auth-orcid.ts (#1281, epic #1272 phase 1): the
 *  device-authorization routes (routes/auth-device.ts) need the same origin
 *  for `verification_uri`, and a helper earns a shared home once it has a
 *  second real consumer rather than living duplicated in each caller. */
export function appBase(env: Pick<Bindings, "APP_BASE_URL">): string {
  return (env.APP_BASE_URL?.trim() || DEFAULT_APP_BASE).replace(/\/+$/, "");
}
