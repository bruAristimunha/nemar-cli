/**
 * SQL and helpers for the docs admin gate (epic #1336 phase 0, issue #1338).
 * Routes live in `routes/auth-docs.ts`; the shared literals are in
 * `shared/contract/docs-auth.ts`.
 *
 * TWO RULES THIS FILE EXISTS TO HOLD.
 *
 * **Every gate is re-checked at MINT time, in the statement that mints.** The
 * grant records who asked; it decides nothing. `DOCS_MINT_INSERT_SQL` re-reads
 * role, status and `deleted_at` from `users` in its own WHERE clause, so an
 * account demoted or revoked inside the grant's sixty seconds gets a zero-row
 * insert instead of a session. This is the same shape as
 * `DEVICE_MINT_INSERT_SQL`, for the same reason: state can change between the
 * two halves of a handoff, and only the half that creates the credential is in
 * a position to say no.
 *
 * **Every timestamp is SQL-side.** `datetime('now', ...)` throughout, never a
 * JS `toISOString()` value. The two compare unequally on the same day and
 * silently break expiry, which is the trap ADR 0047 records for the device
 * flow. That rule is not local to this file, and reviewing this one found where
 * it was already broken: `web_sessions.expires_at` was written from JS, so an
 * app session stayed live until the next UTC midnight past its expiry -- and
 * `DOCS_GRANT_INSERT_SQL` below leans on exactly that column. Fixed in
 * `services/web-session.ts` with migration 0084 for the rows already written.
 */

import { DOCS_ADMIN_ROLES } from "../../../shared/contract/docs-auth.js";
import { ACTIVE_ACCOUNT_STATUS_SQL_LIST } from "./account-tier";
import { generateCookieId, hashCookieId } from "./web-session";

/**
 * `DOCS_ADMIN_ROLES` as a SQL list, rendered from the constant rather than
 * hand-spelled beside it -- the same construction (and the same reason)
 * as `ACTIVE_ACCOUNT_STATUS_SQL_LIST`.
 *
 * The two spellings agreed when this was written, so this is about the drift
 * rather than a live bug, and the drift is unusually nasty: adding a role to the
 * constant while the SQL kept the old pair would make `grant` mint a code (200)
 * that `exchange` then refuses (400 `invalid_grant`) -- a dead end with nothing
 * in either answer to explain it. The values are compile-time constants from a
 * contract module, never user input.
 */
const DOCS_ADMIN_ROLES_SQL_LIST = `(${DOCS_ADMIN_ROLES.map((role) => `'${role}'`).join(", ")})`;

/** A one-time grant code: 256 random bits, URL-safe. Reuses the cookie-id
 *  generator rather than introducing a second random-token primitive, since
 *  the requirement is identical (unguessable, URL-safe, no padding). */
export function generateGrantCode(): string {
  return generateCookieId();
}

/** Unkeyed SHA-256 hex of a grant code, for storage. Unkeyed is right here for
 *  the same reason it is for cookie ids: the code has 256 bits of entropy, so
 *  there is no dictionary to defend against, unlike the six-digit email codes
 *  that do get a keyed HMAC. */
export function hashGrantCode(code: string): Promise<string> {
  return hashCookieId(code);
}

/**
 * Delete grants more than an hour past expiry. Run opportunistically by
 * `grant`, which is the same prune-instead-of-cron idea as `device_codes`
 * (migration 0081) and `orcid_link_intents` (0078).
 *
 * An hour rather than the 24 hours a device code keeps: nobody polls a grant,
 * so no expired row needs to survive in order to explain itself. The browser
 * simply asks for another.
 */
export const DOCS_GRANT_PRUNE_SQL = `DELETE FROM docs_grants
   WHERE expires_at < datetime('now', '-1 hour')`;

/**
 * Mint a grant from a live app session, or insert nothing.
 * Binds: codeHash, ttlSeconds, appSessionId.
 *
 * `INSERT ... SELECT` off `web_sessions` rather than binding the user id the
 * route already has, for two reasons. It re-proves the app session inside the
 * statement that writes -- the route resolved that session a few lines earlier,
 * and this closes the gap -- and it copies `auth_method` across, so the docs
 * session the exchange later mints records that the identity behind it was
 * proven by ORCID rather than resetting that history at the host boundary.
 *
 * The re-proof is only ever as strong as the row it reads, which is why the
 * expiry-format fix in `services/web-session.ts` belongs to this feature and not
 * to some tidy-up later: while that column held JS ISO strings, `ws.expires_at >
 * datetime('now')` was satisfied by an app session that had expired earlier the
 * same day, and this statement would mint a fresh eight-hour docs session off
 * it.
 *
 * `ws.scope = 'app'` is load-bearing: without it a docs session could be used
 * to mint another docs session, which would let one eight-hour grant renew
 * itself indefinitely without ever revisiting the app host.
 *
 * The TTL is applied SQL-side through a concatenated modifier, so the row's
 * expiry is measured by the database's clock, the only clock the consuming
 * statement compares against.
 */
export const DOCS_GRANT_INSERT_SQL = `INSERT INTO docs_grants (code_hash, user_id, auth_method, expires_at)
   SELECT ?, ws.user_id, ws.auth_method, datetime('now', '+' || ? || ' seconds')
     FROM web_sessions ws
    WHERE ws.id = ?
      AND ws.scope = 'app'
      AND ws.revoked_at IS NULL
      AND ws.expires_at > datetime('now')`;

/**
 * Mint the docs session from a live grant, or insert nothing.
 * Binds: cookieIdHash, ttlSeconds, userAgent, ipHash, codeHash.
 *
 * `INSERT ... SELECT` rather than a read followed by an insert: the gates and
 * the write are then one statement, so there is no window between checking and
 * creating. Zero rows inserted IS the refusal, and the caller reads
 * `meta.changes` to see it.
 *
 * The gates, and why each is here rather than in the route:
 *   - `dg.expires_at > datetime('now')` - the grant is still claimable.
 *   - `u.role IN ${DOCS_ADMIN_ROLES_SQL_LIST}` - re-read at mint, not trusted
 *                                         from the grant, and rendered from the
 *                                         one declaration of that rule.
 *   - `u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}` plus `deleted_at IS NULL`
 *     - the SAME status rule the API's own cookie path applies
 *     (`isActiveAccountStatus` in `middleware/auth.ts`), not a hand-rolled
 *     `!= 'revoked'`. The looser spelling admitted `pending`, which the API
 *     refuses, and an admin-only surface must never be easier to enter than the
 *     API it documents.
 *
 * `remember` is hard-coded 0: a docs session is never a remember-me session.
 * `scope` is hard-coded 'docs' so this statement cannot mint an app session
 * even if someone edits the bindings.
 */
export const DOCS_MINT_INSERT_SQL = `INSERT INTO web_sessions
     (user_id, cookie_id_hash, remember, expires_at, user_agent, ip_hash, auth_method, scope)
   SELECT dg.user_id,
          ?,
          0,
          datetime('now', '+' || ? || ' seconds'),
          ?,
          ?,
          dg.auth_method,
          'docs'
     FROM docs_grants dg
     JOIN users u ON u.id = dg.user_id
    WHERE dg.code_hash = ?
      AND dg.expires_at > datetime('now')
      AND u.role IN ${DOCS_ADMIN_ROLES_SQL_LIST}
      AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}
      AND u.deleted_at IS NULL`;

/**
 * Mint a docs session straight from an account, for the CLI. Binds:
 * cookieIdHash, ttlSeconds, userAgent, ipHash, userId.
 *
 * THERE IS NO GRANT ON THIS PATH, and the reason is worth stating rather than
 * leaving as an asymmetry someone later "fixes". The grant exists because the
 * browser flow crosses two hosts: the website proves the session and the docs
 * host mints the cookie, so a one-time code has to travel between them through
 * a URL. A CLI call crosses nothing. The caller presents a long-lived API key
 * to the one host that can validate it and gets the credential back in the same
 * response, so there is no window to protect and nothing to put in a URL.
 *
 * WHAT IS NOT DROPPED is every gate the grant path applies at mint time: role,
 * status and `deleted_at` are re-read in the statement that writes. BUT THE
 * REASON IS WEAKER HERE THAN THERE, and the first draft of this comment claimed
 * otherwise, so be precise. {@link DOCS_MINT_INSERT_SQL} closes a real window:
 * a grant row is up to sixty seconds old and carries only `user_id`, so without
 * the re-read an account demoted inside that minute still mints. On this path
 * `resolveBearerUser` re-reads role and status from `users` in the same request,
 * microseconds earlier, and the route refuses a non-admin before reaching this
 * statement. So these gates close no window the caller leaves open; they are
 * redundant by construction.
 *
 * They are kept anyway, for two reasons worth stating rather than leaving to be
 * rediscovered. The statement then holds its own contract -- "mints or inserts
 * nothing" -- independently of who runs it, so a second caller added later
 * cannot weaken it by forgetting a check. And the two mint paths stay
 * symmetrical, which is what makes it obvious that a rule added to one belongs
 * in the other. Proving this layer needs a test that runs the statement
 * DIRECTLY: removing either gate alone leaves the route's behavior unchanged,
 * because the other layer absorbs it (measured, not assumed -- see
 * `backend/test/docs-auth-routes.test.ts`).
 *
 * `auth_method` is the literal `'api_key'` rather than a value copied from
 * somewhere, because that is the truth about this session: the identity behind
 * it was proven by a key, not by ORCID or an email code. The column is
 * free-text (0050, 0083) and no route surfaces it, so this widens no response
 * shape.
 *
 * `scope` is hard-coded `'docs'` and `remember` is hard-coded 0, both for the
 * same reason they are in {@link DOCS_MINT_INSERT_SQL}: a bindings mistake must
 * not be able to turn this into an app session.
 */
export const DOCS_CLI_MINT_INSERT_SQL = `INSERT INTO web_sessions
     (user_id, cookie_id_hash, remember, expires_at, user_agent, ip_hash, auth_method, scope)
   SELECT u.id,
          ?,
          0,
          datetime('now', '+' || ? || ' seconds'),
          ?,
          ?,
          'api_key',
          'docs'
     FROM users u
    WHERE u.id = ?
      AND u.role IN ${DOCS_ADMIN_ROLES_SQL_LIST}
      AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}
      AND u.deleted_at IS NULL`;

/**
 * Consume the grant, in the same `db.batch()` as {@link DOCS_MINT_INSERT_SQL}.
 * Binds: codeHash, cookieIdHash.
 *
 * Gated on `EXISTS` against the cookie hash the INSERT just wrote, and NEVER
 * on `last_insert_rowid()`, which is stale after a zero-row `INSERT ... SELECT`
 * on both D1 and bun:sqlite -- the lesson `DEVICE_MINT_CONSUME_SQL` already
 * carries. So a refused mint leaves the grant in place to expire on its own,
 * which is harmless because it can never mint anything, and a successful mint
 * removes it before any second exchange can see it.
 */
export const DOCS_MINT_CONSUME_SQL = `DELETE FROM docs_grants
   WHERE code_hash = ?
     AND EXISTS (SELECT 1 FROM web_sessions WHERE cookie_id_hash = ? AND scope = 'docs')`;

/**
 * Revoke every docs session belonging to one account. Binds: userId.
 *
 * THREE CALLERS: `/auth/logout`, an admin role demotion, and
 * {@link revokeDocsCredentials} below, which runs after an API key is revoked
 * because a docs session can be minted from a key
 * (`POST /auth/docs/cli-session`). Without it, signing out of nemar.org
 * would leave docs access live for up to eight hours, which is not what anyone
 * means by signing out, and it is the specific failure the core principle
 * about revocation cascading to linked credentials is meant to prevent.
 *
 * The two paths that end EVERY credential do NOT use this one, and should not:
 * `finalizeRevocation` and the tombstone cascade revoke every session of
 * every scope for the account, which is a superset. This statement is for the
 * cases where the app session legitimately survives.
 */
export const DOCS_REVOKE_ALL_SQL = `UPDATE web_sessions
      SET revoked_at = datetime('now')
    WHERE user_id = ?
      AND scope = 'docs'
      AND revoked_at IS NULL`;

/**
 * Delete every outstanding grant for one account. Binds: userId.
 *
 * Revoking live sessions is not enough on its own: a grant is a 60-second
 * licence to create a new eight-hour session, held by whoever has the code, and
 * the mint checks the ACCOUNT rather than the app session that authorized it. So
 * a code captured from the callback URL (browser history, a `Referer`, a log)
 * survived sign-out and could still be spent. Ending access has to end what can
 * still create access, not only the access that exists.
 *
 * FIVE CALLERS, and the count is the point: every path that ends or downgrades
 * this credential runs this statement -- `/auth/logout`, `finalizeRevocation`, a
 * role demotion, the tombstone cascade (`tombstoneUserCascade`, the one
 * function both the owner-only soft delete and the scheduled sweep of
 * live-test accounts run, so it counts once), and {@link revokeDocsCredentials}
 * (every route that revokes keys without ending every session; it lists them).
 * The FK's `ON DELETE CASCADE` covers none of them, because none of them
 * deletes the `users` row. A sixth path that ends a credential needs this line
 * too.
 * The private site's grants have their own table and their own count
 * (`PRIVATE_GRANTS_PURGE_SQL` in `services/private-auth.ts`).
 */
export const DOCS_GRANTS_PURGE_SQL = "DELETE FROM docs_grants WHERE user_id = ?";

/**
 * End every docs session and outstanding docs grant this account holds, after
 * one of its API keys is revoked.
 *
 * WHY IT EXISTS. `POST /auth/docs/cli-session` mints a docs credential FROM an
 * API key, so every path that revokes a key is a path that ends a credential,
 * and needs {@link DOCS_REVOKE_ALL_SQL} and {@link DOCS_GRANTS_PURGE_SQL}. The
 * first of those paths shipped without them, and revoking the key left the
 * docs session reading `/admin/*` for the rest of its fifteen minutes.
 *
 * ITS CALLERS: every route that revokes keys WITHOUT ending every session --
 * self-service `DELETE /auth/keys/:id` and `/auth/keys/current`
 * (`routes/auth-keys.ts`), the owner's `DELETE /admin/users/:username/keys/:id`
 * (`routes/admin/user-keys.ts`), and the emailed
 * `GET /auth/confirm-key-regeneration` (`routes/auth.ts`), which revokes every
 * key on the account. A new route of that kind calls this too. The three paths
 * that revoke keys and ALSO end the docs credential in their own batch do not
 * need it: a role demotion, `finalizeRevocation` and the tombstone cascade.
 *
 * The by-id routes also run it when their revoke changed nothing (a
 * concurrent revoke of the same key won the race), because it is idempotent
 * and the other request's cascade may have been the one that failed.
 *
 * WHY IT REVOKES ALL OF THEM rather than the one that key minted: the session
 * row records no minting token, so there is nothing to revoke precisely. Adding
 * a column to make this surgical would buy very little -- a docs session is
 * read-only and short-lived, and the CLI silently mints another on the next
 * command -- so the blunt version is the right trade. The grants purge rides
 * along for the same reason it does elsewhere: a grant is a licence to create a
 * new session, and ending access has to end what can still create access.
 *
 * The private site's sessions are deliberately NOT ended here: one is never
 * minted from a key, so a key's end has nothing of that scope to reach (ADR
 * 0079, `PRIVATE_REVOKE_ALL_SQL`).
 *
 * BEST EFFORT, DELIBERATELY. The key is already revoked by the time this runs;
 * a failure here must not turn a successful revocation into an error, which
 * would leave the caller believing the key still works. It is logged instead.
 */
export async function revokeDocsCredentials(db: D1Database, userId: number): Promise<void> {
  try {
    await db.batch([
      db.prepare(DOCS_REVOKE_ALL_SQL).bind(userId),
      db.prepare(DOCS_GRANTS_PURGE_SQL).bind(userId),
    ]);
  } catch (err) {
    // The account id is what an operator needs to finish the job by hand.
    console.error(
      `[docs-auth] failed to cascade key revocation into docs sessions for user ${userId}`,
      err,
    );
  }
}
