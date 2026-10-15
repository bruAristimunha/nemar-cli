import { DOCS_GRANTS_PURGE_SQL } from "../services/docs-auth";
import { PRIVATE_GRANTS_PURGE_SQL } from "../services/private-auth";

// Shared SQL for the user tombstone (soft delete), so the DELETE
// /admin/users/by-id/:id endpoint, the scheduled sweep of the live-test accounts
// (services/test-account-sweep.ts) and their behavioral tests exercise the EXACT
// same masking statement and credential cascade (no drift between the security
// logic and its test, or between its two callers). Both callers go through
// tombstoneUserCascade at the foot of this file.
//
// The mask is the load-bearing mechanism for three guarantees:
//   1. PII erasure — email is replaced with a non-PII placeholder; username,
//      github, password, orcid, description, AWS creds, verification tokens and
//      email prefs are nulled; email_verified and orcid_verified are zeroed.
//   2. Re-signup freedom — nulling username/github and rewriting email FREES
//      those UNIQUE values so the original owner can sign up again later. (The
//      values are freed by this mask, not by ignoring deleted rows in the
//      checks.)
//   3. Access erasure — the upload grant and the request behind it are cleared,
//      the same four columns POST /admin/revoke clears (ADR 0040/0042), so a
//      tombstoned row cannot sit at status='revoked' still holding the grant.

/**
 * Masked email for a tombstoned user. Embeds the AUTOINCREMENT primary key,
 * which is globally unique and never reused, so two tombstones can never collide
 * on the `email` UNIQUE constraint. `.invalid` (RFC 6761) is un-routable, so the
 * address can never be real or receive mail.
 */
export function maskedDeletedEmail(id: number): string {
  return `deleted+${id}@deleted.invalid`;
}

/**
 * The tombstone mask as a bound D1 statement. Wrapping it hides the positional
 * bind order (`[maskedEmail, id]`) so a caller can't accidentally reverse the
 * args and mask the wrong row (or 0 rows). Callers outside this module should
 * go through {@link tombstoneUserCascade}, which issues it with the credential
 * revocations that must commit with it; the raw SQL constant stays exported for
 * the behavioral tests (which run it against bun:sqlite, a different driver API).
 *
 * With `onlyIfEmail` the statement also requires the row to still carry that
 * address (`AND email = ?`), so a caller that chose the row by its address
 * cannot mask a row whose address changed since it looked.
 *
 * `AND deleted_at IS NULL` makes it idempotent (a re-delete matches 0 rows).
 * It sets status='revoked' so existing status-pinned queries also treat the row
 * as dead, and stamps `deleted_at` (the canonical soft-delete discriminator
 * every auth/list query filters on).
 */
export function tombstoneUserStatement(
  db: D1Database,
  id: number,
  onlyIfEmail?: string,
): D1PreparedStatement {
  if (onlyIfEmail === undefined) {
    return db.prepare(USER_TOMBSTONE_MASK_SQL).bind(maskedDeletedEmail(id), id);
  }
  return db
    .prepare(`${USER_TOMBSTONE_MASK_SQL} AND email = ?`)
    .bind(maskedDeletedEmail(id), id, onlyIfEmail);
}

export const USER_TOMBSTONE_MASK_SQL = `UPDATE users
   SET email = ?,
       username = NULL,
       github_username = NULL,
       password_hash = NULL,
       orcid = NULL,
       -- Cleared WITH users.orcid, not left behind (#1254, ADR 0043). A row
       -- with orcid = NULL and orcid_verified = 1 claims to have proven an iD
       -- it no longer has, which is a lie in the audit trail and the exact
       -- half-state that produced production rows 42/43 in the first place --
       -- there via unlink, observed again here after row 42 was soft-deleted.
       -- Every writer of one now writes the other: this statement, the unlink
       -- route, and linkIdentity/relinkIdentity.
       orcid_verified = 0,
       description = NULL,
       email_preferences = NULL,
       email_verified = 0,
       verification_token = NULL,
       verification_expires_at = NULL,
       aws_iam_username = NULL,
       aws_access_key_id_encrypted = NULL,
       aws_secret_access_key_encrypted = NULL,
       -- The upload grant and the request that asked for it, cleared exactly as
       -- POST /admin/revoke clears them (ADR 0040: revoke is the eraser of what
       -- approval wrote; ADR 0042: an open request is a requested_at stamp with
       -- no grant). A tombstone is a harder stop than a revocation, so leaving
       -- service_access = 1 on a row that is force-flipped to 'revoked' would
       -- put a deleted account back on the granted side of the invariant, and a
       -- surviving upload_access_requested_at would keep it in the admin review
       -- queue with no user left to review.
       service_access = 0,
       service_access_granted_at = NULL,
       service_access_granted_by = NULL,
       upload_access_requested_at = NULL,
       status = 'revoked',
       revoked_at = COALESCE(revoked_at, datetime('now')),
       deleted_at = datetime('now'),
       updated_at = datetime('now')
   WHERE id = ? AND deleted_at IS NULL`;

/** What {@link tombstoneUserCascade} reports. */
export interface TombstoneCascadeResult {
  /** True when the mask UPDATE changed a row. False means nothing was tombstoned. */
  tombstoned: boolean;
  /** Live keys ended. */
  tokensRevoked: number;
  /** Live sessions (every scope) ended. */
  sessionsRevoked: number;
}

/**
 * The PII mask, the `deleted_at` stamp and every credential revocation of a
 * tombstone, in ONE `db.batch()`. The batch is the guarantee: D1 runs it as a
 * single transaction, so the mask and the stamp can never half-apply and leave
 * an auth-resolvable row. It rejects (and rolls back) on any failure; the
 * caller decides how to report that.
 *
 * `originalEmail` must be captured BEFORE the call (the mask rewrites it): it
 * is used only to expire the outstanding passwordless login codes, which are
 * keyed by the original address.
 *
 * `onlyIfEmail` is for a caller that selected the row by its address (the
 * scheduled sweep of the live tests' accounts). The mask then also requires
 * `email = onlyIfEmail`, and EVERY other statement is conditional on the mask
 * having applied to this row, so a row whose address changed since it was read
 * loses nothing: no key, session, grant or collaboration is touched, and the
 * result says `tombstoned: false`. Without it (the owner-only route) the
 * statements are exactly the unconditional ones they always were.
 *
 * What it does NOT do, because both are network calls with their own failure
 * modes and only the owner-only route wants them: remove GitHub collaborators
 * and revoke legacy IAM keys. A caller that skips those must have established
 * that there are none to remove (the sweep's predicate does).
 *
 * web_sessions are revoked explicitly because a soft delete does NOT trigger
 * their ON DELETE CASCADE; the collaborator and S3-permission rows likewise.
 * The session revoke covers every scope (no `scope` predicate, on purpose), but
 * a docs or private GRANT is a separate row and a separate 60-second licence to
 * mint a new session, and `docs_grants.user_id` / `private_grants.user_id`
 * cascade on DELETE, which a tombstone is not, so nothing else reaches them.
 */
export async function tombstoneUserCascade(
  db: D1Database,
  id: number,
  originalEmail: string | null,
  onlyIfEmail?: string,
): Promise<TombstoneCascadeResult> {
  // True once the row carries its masked address: the mask above has just applied to
  // it, or an earlier tombstone did. For the latter every statement keyed by user_id
  // is a no-op (nothing live is left to end), and the one keyed by ADDRESS, the login
  // code expiry, has its own extra condition below.
  const MASK_APPLIED = " AND EXISTS (SELECT 1 FROM users WHERE id = ? AND email = ?)";
  const guarded = onlyIfEmail !== undefined;
  const step = (sql: string, ...binds: unknown[]): D1PreparedStatement =>
    guarded
      ? db.prepare(sql + MASK_APPLIED).bind(...binds, id, maskedDeletedEmail(id))
      : db.prepare(sql).bind(...binds);

  const batch = await db.batch([
    tombstoneUserStatement(db, id, onlyIfEmail),
    step(
      "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
      id,
    ),
    step(
      "UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
      id,
    ),
    step(DOCS_GRANTS_PURGE_SQL, id),
    step(PRIVATE_GRANTS_PURGE_SQL, id),
    step("DELETE FROM dataset_collaborators WHERE user_id = ?", id),
    step("DELETE FROM user_s3_permissions WHERE user_id = ?", id),
    // Expire any outstanding passwordless login codes for the original email so
    // a code issued just before deletion can't be submitted (it would otherwise
    // be consumed and then cleanly denied; this avoids even that round-trip).
    //
    // Guarded callers add one more condition: no OTHER user holds that address now. If an
    // earlier tombstone masked this row and the address was then registered again, the
    // outstanding codes belong to the new holder, and expiring them would be this
    // call's only effect on a row it did not tombstone.
    guarded
      ? db
          .prepare(
            `UPDATE auth_codes SET used_at = datetime('now') WHERE email = ? AND used_at IS NULL${MASK_APPLIED}
               AND NOT EXISTS (SELECT 1 FROM users WHERE email = ? AND id <> ?)`,
          )
          .bind(originalEmail, id, maskedDeletedEmail(id), originalEmail, id)
      : step(
          "UPDATE auth_codes SET used_at = datetime('now') WHERE email = ? AND used_at IS NULL",
          originalEmail,
        ),
  ]);
  return {
    tombstoned: (batch[0]?.meta.changes ?? 0) > 0,
    tokensRevoked: batch[1]?.meta.changes ?? 0,
    sessionsRevoked: batch[2]?.meta.changes ?? 0,
  };
}
