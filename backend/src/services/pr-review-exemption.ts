/**
 * Who the dataset pull-request review does not apply to (ADR 0107).
 *
 * A pull request opened by a NEMAR owner or administrator is not reviewed: the review stands in for
 * an administrator's judgment of someone else's change, and an administrator needs no stand-in for
 * their own. This module is the ONE place a NEMAR role is read for that purpose. Every caller (the
 * review gate, the admin queue) asks {@link isReviewExempt}; none of them knows a role, an account
 * kind or a login.
 *
 * **The rule is an identity match.** A GitHub login is exempt only when it is the `github_username`
 * of a live NEMAR account that is approved, holds the `owner` or `admin` role, and is a person or a
 * service account. The match ignores case, as GitHub does. An account of kind `test` is never
 * exempt (ADR 0048): a persona is not a real identity, whatever role it holds. No login is written
 * into this code, so adding or removing an owner or administrator changes who is exempt and nothing
 * else has to.
 *
 * **GitHub has to agree.** A NEMAR account can name a GitHub login nobody holds, or one its person
 * has since renamed, and the role match alone would then exempt whoever registers that name. So a
 * login that matches an account is also asked about at GitHub: it must hold the repository `admin`
 * role on THIS repository (an organization owner, or a member of a team with admin). The question is
 * asked only after a role match, and every way it can fail (no token, an error, a timeout, an answer
 * that is not the one expected) means not exempt, so the review runs, which is the safe side.
 *
 * **Nothing stores the answer.** No column holds it, and every call reads `users` again, so a
 * demotion, a revocation or a deleted account ends the exemption on the very next pull request.
 *
 * A database failure throws, like every read in the review's intake: the webhook answers 500 and
 * the delivery can be redelivered. A GitHub failure never throws here; it answers not exempt, and says so in the log.
 * A caller that must tell "not exempt" from "GitHub did not say" (an administrator's override, which
 * would otherwise be refused for a reason that is not true) asks {@link reviewExemption}.
 */

import type { AccountKind } from "../../../shared/contract/user.js";
import type { Bindings, UserRole } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";

/** The NEMAR roles whose pull requests are not reviewed. */
export const REVIEW_EXEMPT_ROLES = ["owner", "admin"] as const satisfies readonly UserRole[];

/**
 * The account kinds that can be exempt. `test` is not one of them (ADR 0048): a test persona is a
 * person's secondary account and not a real identity, so no role it is given makes its pull
 * requests skip the review.
 */
export const REVIEW_EXEMPT_KINDS = ["person", "service"] as const satisfies readonly AccountKind[];

/** A SQL list literal, rendered from a constant list (the same construction as `docs-auth.ts`). */
const sqlList = (words: readonly string[]): string => `(${words.map((w) => `'${w}'`).join(", ")})`;

/**
 * One live, approved owner or administrator whose GitHub login is the one asked about. Binds: login.
 *
 * The role and kind lists are rendered from the constants above rather than spelled beside them, so
 * the rule has one definition. The comparison carries `COLLATE NOCASE` so it is the same collation
 * as `idx_users_github` (unique, `github_username COLLATE NOCASE`) and the lookup is an index
 * search; a test reads the query plan. `deleted_at IS NULL` is there for the same reason it is
 * everywhere an account is looked up: a tombstoned row keeps no usable handle, and one that did must
 * not exempt anyone.
 */
export const REVIEW_EXEMPT_SQL = `SELECT 1 AS exempt FROM users
  WHERE github_username = ? COLLATE NOCASE
    AND role IN ${sqlList(REVIEW_EXEMPT_ROLES)}
    AND status = 'approved'
    AND deleted_at IS NULL
    AND account_kind IN ${sqlList(REVIEW_EXEMPT_KINDS)}
  LIMIT 1`;

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Whose pull request this is, and where. `repo` is the dataset id (the repository's name). */
export interface ReviewExemptSubject {
  login: string;
  repo: string;
}

/**
 * The longest the question to GitHub may take, in all, before it is abandoned and the answer is
 * "not exempt". It runs inside the webhook's own request, which GitHub gives ten seconds, and a
 * pusher other than the author is a second question.
 */
let permissionTimeoutMs = 4_000;

export function __setPermissionTimeoutForTests(ms: number | null): void {
  permissionTimeoutMs = ms ?? 4_000;
}

/** The repository role GitHub reports for a login: `role_name`, which is finer than `permission`. */
const ADMIN_ROLE = "admin";

/**
 * What GitHub says about this login on this repository: `admin` when it holds the `admin` role,
 * `not_admin` when GitHub answered and it does not (a login GitHub does not know, 404, is an answer
 * too), and `unknown` when GitHub did not say: a refusal, a throttle, a timeout, no token to ask
 * with, or a body that is not an object with a string `role_name`. Never throws. `role_name`, not
 * the legacy `permission` field: `permission` folds `maintain` into `write` and cannot tell a role
 * apart.
 *
 * The endpoint answers `read` for ANY login on a public repository, so only an explicit `admin`
 * means anything here.
 */
async function repositoryRole(
  env: Bindings,
  who: ReviewExemptSubject,
): Promise<"admin" | "not_admin" | "unknown"> {
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${encodeURIComponent(who.repo)}/collaborators/${encodeURIComponent(who.login)}/permission`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(permissionTimeoutMs) },
      { kind: "interactive", maxAttempts: 2, maxThrottleMs: 2_000, refreshTokenOn401: refresh },
    );
    if (!res.ok) {
      // A login GitHub does not know is an answer (an account that names a login nobody holds).
      // Anything else is GitHub or the credential failing, which every exempt account feels at
      // once, so it is logged as the fault it is.
      const line = `[pr-review-exempt] ${who.repo}: GitHub answered HTTP ${res.status} to the permission check; not exempt`;
      if (res.status === 404) {
        console.warn(line);
        return "not_admin";
      }
      console.error(line);
      return "unknown";
    }
    const body: unknown = await res.json().catch(() => null);
    const role =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).role_name
        : undefined;
    if (typeof role !== "string") {
      // The answer is not the shape this reads. If GitHub changed it, every exempt account is
      // reviewed from now on, and this line is the only sign of it.
      console.error(
        `[pr-review-exempt] ${who.repo}: the permission check answered with no usable role_name; not exempt`,
      );
      return "unknown";
    }
    return role === ADMIN_ROLE ? "admin" : "not_admin";
  } catch (err) {
    // Fixed words and the error's own message (a status or a timeout), never a token or a login.
    console.error(
      `[pr-review-exempt] ${who.repo}: the permission check failed (${err instanceof Error ? err.message.slice(0, 120) : "unknown"}); not exempt`,
    );
    return "unknown";
  }
}

/**
 * Whether this GitHub login is exempt from the review on this dataset: a live, approved owner or
 * administrator account holds it (the query), and GitHub agrees that it holds `admin` on the
 * repository. A login that is not shaped like one is never exempt and is not looked up, and
 * GitHub is asked only after the accounts have said yes. Nothing is remembered between calls.
 */
export async function isReviewExempt(env: Bindings, who: ReviewExemptSubject): Promise<boolean> {
  return (await reviewExemption(env, who)) === "exempt";
}

/**
 * {@link isReviewExempt}, with GitHub's silence kept apart: `unknown` when the accounts said yes
 * and GitHub did not answer the question. The review's own gate treats that as not exempt, which
 * is the safe side there; an administrator's override must not, because "the author is not an
 * owner or administrator" would be false.
 */
export async function reviewExemption(
  env: Bindings,
  who: ReviewExemptSubject,
): Promise<"exempt" | "not_exempt" | "unknown"> {
  if (!GITHUB_LOGIN.test(who.login)) return "not_exempt";
  const row = await env.DB.prepare(REVIEW_EXEMPT_SQL).bind(who.login).first<{ exempt: number }>();
  // `!row`, not `=== null`: anything but a row is "no account", whatever D1 answers with.
  if (!row) return "not_exempt";
  const role = await repositoryRole(env, who);
  return role === "admin" ? "exempt" : role === "not_admin" ? "not_exempt" : "unknown";
}
