/**
 * Authentication middleware
 *
 * Validates API keys from Authorization header and sets user context.
 *
 * The bearer-token path is the CLI's authentication mechanism and remains
 * unchanged. As of #572 the same middleware ALSO accepts the
 * `nemar_session` cookie issued by the passwordless flow (#569) so the
 * dashboard at app.nemar.org can call the user-scoped /datasets, /users
 * and /admin routes without a separate API token. Bearer wins when both
 * are present.
 */

import type { Context, Next } from "hono";
import type { OriginNotAllowedBody } from "../../../shared/contract/publication-review-admin.js";
import type { AccountKind } from "../../../shared/contract/user.js";
import {
  type ActiveAccountStatus,
  inactiveAccountBody,
  isActiveAccountStatus,
} from "../services/account-tier";
import { hashApiKey } from "../services/token";
import {
  COOKIE_NAME,
  hashCookieId,
  isAllowedOrigin,
  parseCookieHeader,
} from "../services/web-session";
import {
  type AuthUser,
  type Bindings,
  type Variables,
  hasRole,
  parseRole,
} from "../types/bindings";

type AuthContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * The three things a `nemar_session` cookie can mean. A bare `null` used to
 * cover all of them, which made a signed-in user whose account is not active
 * indistinguishable from a browser carrying no cookie at all: `authMiddleware`
 * answered "Missing Authorization header", which is both untrue and
 * unactionable for someone looking at a dashboard they are signed into. The
 * `inactive` case now carries the status so the caller can say what to do
 * about it — the same answer the bearer path gives.
 *
 * `unresolved` is the genuinely anonymous case AND the degraded one (a D1
 * hiccup, an unreadable role): both mean "this request has no cookie identity
 * we can use", and neither is something to explain to the caller.
 */
type CookieAuthResult =
  | { kind: "user"; user: AuthUser }
  | { kind: "unresolved" }
  | { kind: "inactive"; status: string };

/**
 * Resolve a `nemar_session` cookie to a full AuthUser row.
 *
 * The `user` shape mirrors the bearer-token lookup so downstream routes can
 * `c.get("user")` without caring which auth path succeeded.
 *
 * `verified` is accepted as of ADR 0040 phase 2: it is the base tier, and
 * the dashboard's own routes (dataset list, /users/me) are part of it. What
 * a base-tier account still cannot do is upload — every real-upload entry
 * point routes through services/upload-gate.ts, which reads `service_access`
 * and never `status`, so widening this does not widen upload. `pending` is
 * still rejected, but LOUDLY (see CookieAuthResult): an unverified inbox has
 * proved nothing, and the caller is told to go verify it.
 */
async function resolveCookieUser(c: AuthContext): Promise<CookieAuthResult> {
  const cookieHeader = c.req.header("Cookie");
  const cookieIdRaw = parseCookieHeader(cookieHeader, COOKIE_NAME);
  if (!cookieIdRaw) return { kind: "unresolved" };

  // Wrap the D1 lookup in a try/catch so a transient backend failure
  // degrades to "no cookie auth" instead of bubbling a 500 through
  // `api.onError`. Without this, a brief D1 hiccup turns
  // `GET /datasets` into a 500 for every browser that happens to be
  // carrying a `nemar_session` cookie — even though the route has a
  // valid anonymous branch. Mirrors `webSessionMiddleware`.
  try {
    const cookieHash = await hashCookieId(cookieIdRaw);

    // `ws.scope = 'app'` below is load-bearing. This is the SECOND place
    // `web_sessions` is read by cookie hash; the other is
    // `findSessionByCookieId` in `services/web-session.ts`. Epic #1336 phase 0
    // added a `scope` column (migration 0083) for the docs-site credential and
    // put the predicate on that reader only, and review found the consequence
    // here: the docs cookie authenticated every route behind this middleware,
    // `/admin/*` included, so a read-only documentation session was an
    // owner-grade API session. A scope column is worth nothing unless every
    // reader names the scope it wants. A third reader needs this line too, or
    // better, should go through `findSessionByCookieId`.
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.email, u.github_username, u.role, u.orcid, u.status
         FROM web_sessions ws
         JOIN users u ON u.id = ws.user_id
        WHERE ws.cookie_id_hash = ?
          AND ws.scope = 'app'
          AND ws.revoked_at IS NULL
          AND ws.expires_at > datetime('now')
          AND u.deleted_at IS NULL
        LIMIT 1`,
    )
      .bind(cookieHash)
      .first<{
        id: number;
        username: string | null;
        email: string;
        github_username: string | null;
        role: string | null;
        orcid: string | null;
        status: string;
      }>();
    if (!row) return { kind: "unresolved" };
    if (!isActiveAccountStatus(row.status)) return { kind: "inactive", status: row.status };

    const role = parseRole(row.role, row.username ?? row.email);
    if (role === null) return { kind: "unresolved" };

    return {
      kind: "user",
      user: {
        id: row.id,
        // Web-only signups (#569) may have NULL username / github_username
        // until admin onboarding lifts them to a full account. Routes
        // that only need `id` / `role` / `email` work as-is; routes that
        // strictly require a GitHub login (e.g. repo creation) will
        // fail naturally when they reach the GitHub API call.
        username: row.username ?? "",
        email: row.email,
        github_username: row.github_username ?? "",
        role,
        orcid: row.orcid || undefined,
      },
    };
  } catch (err) {
    console.error("[auth] resolveCookieUser: cookie lookup failed", err);
    return { kind: "unresolved" };
  }
}

/**
 * What an `Authorization` header resolved to.
 *
 * `absent` is "no header at all" and is the only outcome a caller may fall
 * through on: every other failure is a deliberate answer (a malformed header,
 * a dead key, an inactive account) that must reach the client verbatim rather
 * than being retried as anonymous.
 */
export type BearerAuthResult =
  | { kind: "absent" }
  | { kind: "refused"; response: Response }
  | { kind: "user"; user: AuthUser };

/**
 * What an API key resolved to, before any HTTP response is built around it.
 *
 * `malformed` is a value too short to be a key, `unknown` is no live token
 * (never issued, revoked, expired, or its account deleted), `inactive` is a
 * live token whose account may not authenticate, and `misconfigured` is an
 * account whose `role` column holds a value `parseRole` rejects. `profile` is
 * present only when the caller asked for it.
 */
export type ApiKeyResolution<Profile = undefined> =
  | { kind: "malformed" }
  | { kind: "unknown" }
  | { kind: "inactive"; status: string }
  | { kind: "misconfigured" }
  | { kind: "user"; user: AuthUser; profile: Profile };

/**
 * The account fields the service-binding entrypoint's `Principal` needs
 * beyond `AuthUser` (ADR 0078). Read in the SAME SELECT as the rest when asked
 * for, so the two can never describe different moments.
 */
export interface ApiKeyProfile {
  /** Only ever an active status: an inactive account never reaches `user`. */
  status: ActiveAccountStatus;
  /** Honest about NULL, unlike `AuthUser.username`, which keeps the typing
   *  every route has always relied on. */
  username: string | null;
  orcid: string | null;
  given_name: string | null;
  family_name: string | null;
  orcid_verified: boolean;
  email_verified: boolean;
  account_kind: AccountKind;
}

/**
 * The profile columns, appended to the lookup only when a caller asks.
 *
 * Opt-in rather than always selected so the HTTP path's SELECT stays exactly
 * what it was: several route tests build their schema from a prefix of the
 * migrations, before some of these columns existed, and a lookup that named
 * them would fail every bearer request those tests make.
 */
const API_KEY_PROFILE_COLUMNS = `,
        u.given_name,
        u.family_name,
        u.orcid_verified,
        u.email_verified,
        u.account_kind`;

/**
 * `touch: false` skips the `last_used_at` write, for a caller that must stay a
 * pure read (`optionalAuthMiddleware`). Every other caller keeps the awaited
 * touch.
 */
export interface ApiKeyLookupOptions {
  touch?: boolean;
}

/**
 * Resolve a raw API key to its account: the ONE API-key lookup.
 *
 * Extracted from `resolveBearerUser` so a caller that is not an HTTP route
 * gets exactly the rule the API applies -- same length floor, same hashing,
 * same revoked / `expires_at` / `deleted_at` filter, same active-account
 * rule, same awaited `last_used_at` touch -- without an `Authorization`
 * header or a Hono context. `resolveBearerUser` maps each outcome onto the
 * response it has always sent.
 *
 * `optionalAuthMiddleware` reads keys through it too, so there is no second
 * copy of this SELECT left to drift; it passes `touch: false`, because a
 * public read must not write (see there).
 */
export async function resolveApiKeyUser(
  env: Bindings,
  apiKey: string,
  opts?: ApiKeyLookupOptions,
): Promise<ApiKeyResolution>;
export async function resolveApiKeyUser(
  env: Bindings,
  apiKey: string,
  opts: ApiKeyLookupOptions & { withProfile: true },
): Promise<ApiKeyResolution<ApiKeyProfile>>;
export async function resolveApiKeyUser(
  env: Bindings,
  apiKey: string,
  opts?: ApiKeyLookupOptions & { withProfile?: true },
): Promise<ApiKeyResolution<ApiKeyProfile | undefined>> {
  if (!apiKey || apiKey.length < 32) return { kind: "malformed" };

  // Hash the key for lookup
  const hashedKey = await hashApiKey(apiKey);

  // Find token and associated user
  const result = await env.DB.prepare(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.github_username,
        u.role,
        u.orcid,
        u.status${opts?.withProfile ? API_KEY_PROFILE_COLUMNS : ""},
        t.id as token_id
      FROM tokens t
      JOIN users u ON t.user_id = u.id
      WHERE t.api_key_hash = ?
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
        AND u.deleted_at IS NULL
    `,
  )
    .bind(hashedKey)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      role: string | null;
      orcid: string | null;
      status: string;
      token_id: number;
      // Present only with `withProfile`.
      given_name?: string | null;
      family_name?: string | null;
      // NOT NULL DEFAULT 0 in D1 (0050 and 0001), so plain numbers.
      orcid_verified?: number;
      email_verified?: number;
      // Closed by migration 0082's CHECK constraint (ADR 0048).
      account_kind?: AccountKind;
    }>();

  if (!result) return { kind: "unknown" };

  // ADR 0040 phase 2: `verified` is the base tier and holds a usable API
  // key, so the token is accepted here and the upload gate — not this
  // middleware — is what a base-tier account runs into.
  if (!isActiveAccountStatus(result.status)) return { kind: "inactive", status: result.status };

  // Validate role from DB
  const role = parseRole(result.role, result.username);
  if (role === null) return { kind: "misconfigured" };

  // Update last_used_at for the token, unless the caller must not write.
  if (opts?.touch !== false) {
    await env.DB.prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?")
      .bind(result.token_id)
      .run();
  }

  return {
    kind: "user",
    user: {
      id: result.id,
      username: result.username,
      email: result.email,
      github_username: result.github_username,
      role,
      orcid: result.orcid || undefined,
    },
    profile: opts?.withProfile
      ? {
          // Narrowed by the `isActiveAccountStatus` check above.
          status: result.status,
          username: result.username ?? null,
          orcid: result.orcid,
          given_name: result.given_name ?? null,
          family_name: result.family_name ?? null,
          orcid_verified: result.orcid_verified === 1,
          email_verified: result.email_verified === 1,
          account_kind: result.account_kind as AccountKind,
        }
      : undefined,
  };
}

/**
 * Resolve `Authorization: Bearer <api_key>` to a full AuthUser.
 *
 * Extracted from `authMiddleware` for #1266 so the CLI-facing self-service
 * routes in auth-web.ts / auth-orcid.ts accept a token through the SAME
 * lookup the rest of the API uses. That lookup is {@link resolveApiKeyUser};
 * this function owns only the header parsing and the HTTP shape of each
 * refusal. A second copy of the SELECT is how a route ends up honouring a
 * token the middleware would have refused.
 */
export async function resolveBearerUser(c: AuthContext): Promise<BearerAuthResult> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return { kind: "absent" };

  if (!authHeader.startsWith("Bearer ")) {
    return {
      kind: "refused",
      response: c.json(
        { error: "Invalid Authorization header format. Use: Bearer <api_key>" },
        401,
      ),
    };
  }

  const resolved = await resolveApiKeyUser(c.env, authHeader.substring(7));
  switch (resolved.kind) {
    case "malformed":
      return { kind: "refused", response: c.json({ error: "Invalid API key format" }, 401) };
    case "unknown":
      return { kind: "refused", response: c.json({ error: "Invalid or expired API key" }, 401) };
    case "inactive":
      return { kind: "refused", response: c.json(inactiveAccountBody(resolved.status), 403) };
    case "misconfigured":
      return {
        kind: "refused",
        response: c.json({ error: "Account configuration error. Contact an administrator." }, 500),
      };
    case "user":
      return { kind: "user", user: resolved.user };
  }
}

/**
 * Middleware to require authentication via either a bearer API token or
 * the web-dashboard `nemar_session` cookie (#572).
 *
 * Resolution order:
 *  1. `Authorization: Bearer <api_key>` — CLI path, unchanged.
 *  2. `Cookie: nemar_session=…` — dashboard path, added for #572.
 *  3. Neither resolves -> 401 with the same shape we returned before
 *     cookies existed.
 *
 * Sets `c.var.user` with the resolved AuthUser regardless of which path
 * matched, so route handlers don't need to branch.
 */
export async function authMiddleware(c: AuthContext, next: Next) {
  // -------------------------------------------------------------------
  // Path 1: Authorization: Bearer <api_key>
  // -------------------------------------------------------------------
  const bearer = await resolveBearerUser(c);
  if (bearer.kind === "refused") return bearer.response;
  if (bearer.kind === "user") {
    c.set("user", bearer.user);
    c.set("authMethod", "token");
    await next();
    return;
  }

  // -------------------------------------------------------------------
  // Path 2: nemar_session cookie (#572)
  // -------------------------------------------------------------------
  const cookieAuth = await resolveCookieUser(c);
  if (cookieAuth.kind === "user") {
    c.set("user", cookieAuth.user);
    c.set("authMethod", "cookie");
    await next();
    return;
  }
  // A real session for an account that cannot use the API yet. Falling
  // through to the 401 below would tell a signed-in browser it sent no
  // credentials at all; answer with the same 403 body the bearer path uses,
  // which names the step that unblocks them.
  if (cookieAuth.kind === "inactive") {
    return c.json(inactiveAccountBody(cookieAuth.status), 403);
  }

  // -------------------------------------------------------------------
  // Path 3: nothing — refuse with the original 401 shape so older
  // clients that pattern-match the error string keep working.
  // -------------------------------------------------------------------
  return c.json({ error: "Missing Authorization header" }, 401);
}

/**
 * The account acting on a self-service route, whichever credential it used.
 *
 * Only the three fields those routes actually need off the credential: the id
 * every write is scoped by, the current address the email change compares
 * against, and the current GitHub handle `githubHandleChanged` compares
 * against. Everything else is re-read from `users` inside the handler, which
 * is what lets ONE handler serve both credentials without caring which one
 * arrived (#1266).
 */
export interface ActingAccount {
  id: number;
  email: string;
  github_username: string | null;
  via: "cookie" | "token";
}

export type ActingAccountResolution =
  | { ok: true; actor: ActingAccount }
  | { ok: false; response: Response };

/**
 * Resolve the account acting on a route that accepts EITHER the CLI's bearer
 * token or the dashboard's `nemar_session` cookie (#1266, ADR 0044).
 *
 * Deliberately NOT `authMiddleware` mounted on these routes, for one reason
 * that only shows up on the cookie half: `authMiddleware`'s cookie path
 * refuses a `pending` account (403, ADR 0040), while `webSessionMiddleware`
 * admits it. An account that typed its address wrong at sign-up is `pending`
 * BECAUSE the address is wrong, and the email change is the one thing it must
 * still be able to do. So the cookie path keeps `webSessionMiddleware`'s
 * acceptance byte for byte, and the token path uses the shared
 * `resolveBearerUser` above — which, being the standard token rule, admits
 * only an active account. A `pending` CLI account has no token to present
 * anyway: the key is issued after verification.
 *
 * The Origin allow-list applies to the COOKIE path only, and that is the whole
 * point of it: a cookie rides along with any cross-site request the browser is
 * tricked into making, and a bearer token does not. Requiring an Origin header
 * a CLI has no reason to send would refuse every terminal.
 *
 * Bearer wins when both are present, matching `authMiddleware`.
 *
 * Requires `webSessionMiddleware` to have run for the cookie half.
 */
export async function resolveActingAccount(c: AuthContext): Promise<ActingAccountResolution> {
  const bearer = await resolveBearerUser(c);
  if (bearer.kind === "refused") return { ok: false, response: bearer.response };
  if (bearer.kind === "user") {
    c.set("user", bearer.user);
    c.set("authMethod", "token");
    return {
      ok: true,
      actor: {
        id: bearer.user.id,
        email: bearer.user.email,
        github_username: bearer.user.github_username || null,
        via: "token",
      },
    };
  }

  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return { ok: false, response: c.json({ error: "Origin not allowed" }, 403) };
  }
  const webUser = c.var.webUser;
  if (!webUser) {
    return { ok: false, response: c.json({ error: "Authentication required" }, 401) };
  }
  c.set("authMethod", "cookie");
  return {
    ok: true,
    actor: {
      id: webUser.id,
      email: webUser.email,
      github_username: webUser.github_username,
      via: "cookie",
    },
  };
}

/**
 * Middleware to require admin role
 *
 * Must be used after authMiddleware
 */
export async function adminMiddleware(c: AuthContext, next: Next) {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  if (!hasRole(user.role, "admin")) {
    return c.json({ error: "Admin access required" }, 403);
  }

  await next();
}

/**
 * The sentence of a refused cookie write. The contract (`publication-review-admin.ts`) lists the
 * code `origin_not_allowed` and holds no sentence; this one is shared only with
 * `PUBLICATION_COMMENT_SENTENCES.origin_not_allowed`, and the review route has no sentence table
 * for it.
 */
export const ORIGIN_NOT_ALLOWED_MESSAGE =
  "This request did not come from a NEMAR page, so it was not accepted.";

/** The methods that only read. Every other method, a lowercase spelling included, is a write. */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Middleware: a write made with a session cookie must come from a NEMAR page (#1603, #1584; ADR
 * 0105, decision 10).
 *
 * A session cookie rides along with any cross-site request a browser can be tricked into making,
 * and a write on the admin router publishes datasets, mails real people and spends the platform's
 * money. A bearer key cannot be forged cross-site and a terminal sends no Origin, so it is not
 * asked for one. This is the one rule for the whole admin router; four routes used to carry a
 * private copy and every other write had none.
 *
 * Phrased as "not a token" rather than "is a cookie", so that an `authMethod` nothing set fails
 * closed. The methods are the read-only ones by name, so a method this does not know is a write.
 * Reads pass: a cross-site page can send one but cannot read its answer (CORS).
 *
 * Must be used after authMiddleware, which sets `authMethod`. The body carries `code` as well as
 * `error`: the publication review's and the depositor comment's contracts read the code of a
 * refusal there, and approve-dispatch's contract reads it in `error`.
 */
export async function cookieOriginGuard(c: AuthContext, next: Next) {
  if (READ_ONLY_METHODS.has(c.req.method)) {
    await next();
    return;
  }
  if (c.get("authMethod") !== "token" && !isAllowedOrigin(c.req.header("Origin"))) {
    // Typed with the contract's body, so a field renamed here or there breaks the build and not
    // only a test (ADR 0105, decision 10).
    const refusal: OriginNotAllowedBody = {
      error: "origin_not_allowed",
      code: "origin_not_allowed",
      message: ORIGIN_NOT_ALLOWED_MESSAGE,
    };
    return c.json(refusal, 403);
  }
  await next();
}

/**
 * Middleware to require owner role
 *
 * Must be used after authMiddleware
 */
export async function ownerMiddleware(c: AuthContext, next: Next) {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  if (user.role !== "owner") {
    return c.json({ error: "Owner access required" }, 403);
  }

  await next();
}

/**
 * Optional auth middleware - sets user if authenticated, but doesn't require it.
 *
 * When an Authorization: Bearer header is provided but the token cannot be
 * resolved to an active user (revoked, expired, malformed, email not yet
 * verified, etc.), the middleware sets `authAttempted=true` so downstream
 * routes that require auth on a flag (e.g., `GET /datasets?mine=true`) can
 * return a token-specific 401 instead of a generic "Authentication required"
 * — which is indistinguishable from "no header sent" to a confused CLI user
 * who thinks they're logged in (see nemarOrg/nemar-cli#447).
 *
 * As of #572 this also resolves the `nemar_session` cookie when no
 * bearer header is present. A failing cookie does NOT trip
 * `authAttempted` — the cookie is opaque to the dashboard user and
 * there's no actionable error to surface; routes simply fall back to
 * their anonymous branch.
 */
export async function optionalAuthMiddleware(c: AuthContext, next: Next) {
  const authHeader = c.req.header("Authorization");

  // Case-sensitive: "bearer" (lowercase) is treated as no auth attempted.
  // The CLI always sends "Bearer" (capital B, src/lib/api.ts), so this is
  // not a practical concern, but proxies that lowercase headers will silently
  // degrade to unauthenticated rather than triggering the stale-token path.
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // No bearer header — try the cookie before going anonymous. An inactive
    // cookie is treated exactly like no cookie here: this middleware never
    // refuses a request, so the route's anonymous branch is the right
    // outcome, and `authAttempted` stays reserved for bearer tokens (a
    // cookie is opaque to the dashboard user; there is nothing to surface).
    const cookieAuth = await resolveCookieUser(c);
    if (cookieAuth.kind === "user") {
      c.set("user", cookieAuth.user);
    }
    await next();
    return;
  }

  // The caller clearly intended to authenticate, whatever the key turns out
  // to be, so a route can answer "your key is invalid or expired" rather
  // than the anonymous branch's "sign in".
  c.set("authAttempted", true);

  // The ONE API-key lookup, the same `resolveBearerUser` uses, so a key the
  // API refuses (revoked, EXPIRED, on an inactive or deleted account, or with
  // an unrecognised role) is no identity here either. This middleware used to
  // carry its own copy of that SELECT, and the copy had no `expires_at`
  // predicate, so an expired key still identified its account on every route
  // behind it. It never refuses: anything but a user is the anonymous branch.
  //
  // `touch: false`, as the old copy never wrote either. These are public
  // reads: an awaited write would turn a failed UPDATE into a 500 on a route
  // that has an anonymous answer, and `/notices` is served even in `full`
  // maintenance mode, when nothing should write.
  const resolved = await resolveApiKeyUser(c.env, authHeader.substring(7), { touch: false });
  if (resolved.kind === "user") {
    c.set("user", resolved.user);
  }

  await next();
}
