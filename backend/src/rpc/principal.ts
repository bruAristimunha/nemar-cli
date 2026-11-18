/**
 * `resolvePrincipal`: whose credential is this (ADR 0078).
 *
 * The one question the private site asks on every request, answered by the
 * same readers the HTTP API uses rather than by a copy of them:
 * `findSessionByCookieId` for a private-site session, `resolveApiKeyUser` for
 * an API key. A second copy of either SELECT is how a surface ends up
 * honouring a credential the API would refuse (ADR 0056's review found
 * exactly that), so this file owns only the mapping onto `Principal`, and one
 * mapping, `toPrincipal`, serves both kinds.
 *
 * It takes a credential and returns an account. It never takes an account and
 * returns anything, which is ADR 0078's first rule: no method acts for a user
 * without that user's credential or a one-time grant.
 */

import type {
  Principal,
  PrincipalAccountKind,
  PrincipalRole,
  PrincipalStatus,
  ResolvePrincipalResult,
} from "../../../shared/contract/private-site.js";
import type { AccountKind } from "../../../shared/contract/user.js";
import { resolveApiKeyUser } from "../middleware/auth";
import { maintenanceRefuses } from "../middleware/maintenance";
import { type ActiveAccountStatus, isActiveAccountStatus } from "../services/account-tier";
import { type BackgroundContext, findSessionByCookieId } from "../services/web-session";
import type { Bindings, UserRole } from "../types/bindings";
import { MAX_CREDENTIAL_LENGTH, boundedString } from "./input";

/**
 * Compile-time drift guards between this repository's vocabularies and the
 * contract's literal unions. The contract spells its unions out because other
 * repositories read it as text; these assignments fail the typecheck the day
 * a role, an active status or an account kind is added here and not there.
 */
const asRole = (role: UserRole): PrincipalRole => role;
const asStatus = (status: ActiveAccountStatus): PrincipalStatus => status;
const asKind = (kind: AccountKind): PrincipalAccountKind => kind;

const INVALID: ResolvePrincipalResult = { ok: false, error: "invalid_credential" };

/** The account fields both readers produce, in their own spelling. */
interface PrincipalSource {
  id: number;
  username: string | null;
  orcid: string | null;
  orcid_verified: boolean;
  given_name: string | null;
  family_name: string | null;
  email: string;
  email_verified: boolean;
  account_kind: AccountKind;
}

/** The one mapping onto `Principal`, for a session and a key alike. */
function toPrincipal(
  source: PrincipalSource,
  role: UserRole,
  status: ActiveAccountStatus,
): Principal {
  return {
    userId: source.id,
    username: source.username,
    orcid: source.orcid,
    orcidVerified: source.orcid_verified,
    givenName: source.given_name,
    familyName: source.family_name,
    email: source.email,
    emailVerified: source.email_verified,
    role: asRole(role),
    status: asStatus(status),
    accountKind: asKind(source.account_kind),
  };
}

/**
 * Resolve a private-site session value to its account.
 *
 * Exported for `exchangePrivateGrant`, which reads a freshly minted session
 * back through this function so that its answer and every later
 * `resolvePrincipal` for the same value cannot disagree.
 *
 * THE STATUS RULE IS APPLIED HERE, NOT INHERITED. `findSessionByCookieId`
 * stops at `u.status != 'revoked'` because it must (a `pending` account
 * reaches Settings through it to fix the address that made it pending), while
 * the mint admits only `ACTIVE_ACCOUNT_STATUSES`. Without this check the
 * standing check would be looser than the entry check, the shape
 * `/auth/docs/verify` was fixed for: a live session whose account became
 * pending would keep resolving.
 */
export async function resolveSessionPrincipal(
  env: Bindings,
  value: string,
  ctx?: BackgroundContext,
): Promise<ResolvePrincipalResult> {
  // "private" is the whole separation: an app or docs session value presented
  // here matches no row, because every reader names the scope it wants. A
  // revoked account matches no row either, which is why it is
  // `invalid_credential` on this kind.
  const found = await findSessionByCookieId(env, value, "private", ctx);
  if (!found) return INVALID;
  const { status, role } = found.user;
  if (!isActiveAccountStatus(status)) return { ok: false, error: "inactive_account" };
  if (role === null) return { ok: false, error: "unresolved_account" };
  return { ok: true, principal: toPrincipal(found.user, role, status) };
}

/**
 * Resolve a credential the private site holds to the account behind it.
 *
 * Every refusal is a value, never a throw, `unresolved_account` included; a
 * throw means D1 or the runtime failed, and the caller fails closed on it
 * (ADR 0078).
 *
 * A read, for maintenance mode: `full` answers `unavailable`, as the HTTP API
 * refuses every read then; `read-only` keeps answering, as it keeps serving
 * a `GET`.
 */
export async function resolvePrincipal(
  env: Bindings,
  credential: unknown,
  ctx?: BackgroundContext,
): Promise<ResolvePrincipalResult> {
  if (maintenanceRefuses(env.MAINTENANCE_MODE, "read")) {
    return { ok: false, error: "unavailable" };
  }
  if (typeof credential !== "object" || credential === null) return INVALID;
  const { kind, value: raw } = credential as { kind?: unknown; value?: unknown };
  const value = boundedString(raw, MAX_CREDENTIAL_LENGTH);
  if (value === null) return INVALID;

  if (kind === "session") return resolveSessionPrincipal(env, value, ctx);

  if (kind === "api_key") {
    // The HTTP API's own lookup, `expires_at` predicate included, with its
    // `last_used_at` touch awaited inside it.
    const resolved = await resolveApiKeyUser(env, value, { withProfile: true });
    switch (resolved.kind) {
      // An OpenID Connect token names no principal here (ADR 0119 rule 4).
      case "oidc_token":
      case "runner_credential":
      case "malformed":
      case "unknown":
        return INVALID;
      case "inactive":
        // A revoked account is `invalid_credential` here as it is for a
        // session, whose SELECT filters it out; `inactive_account` means only
        // "not active yet".
        return resolved.status === "revoked" ? INVALID : { ok: false, error: "inactive_account" };
      case "misconfigured":
        return { ok: false, error: "unresolved_account" };
      case "user":
        return {
          ok: true,
          principal: toPrincipal(
            { ...resolved.profile, id: resolved.user.id, email: resolved.user.email },
            resolved.user.role,
            resolved.profile.status,
          ),
        };
    }
  }

  return INVALID;
}
