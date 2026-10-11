// Shared SQL for the user tombstone (soft delete), so the DELETE
// /admin/users/by-id/:id endpoint and its behavioral test exercise the EXACT
// same masking statement (no drift between the security logic and its test).
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
 * Single-statement PII mask + tombstone. Bind order: [maskedEmail, id].
 * `AND deleted_at IS NULL` makes it idempotent (a re-delete matches 0 rows).
 * Sets status='revoked' so existing status-pinned queries also treat the row as
 * dead, and stamps `deleted_at` (the canonical soft-delete discriminator every
 * auth/list query filters on).
 */
/**
 * The tombstone mask as a bound D1 statement. Wrapping it hides the positional
 * bind order (`[maskedEmail, id]`) so a caller can't accidentally reverse the
 * args and mask the wrong row (or 0 rows). This is the only way the endpoint
 * should issue the mask; the raw SQL constant stays exported for the behavioral
 * test (which runs it against bun:sqlite, a different driver API).
 */
export function tombstoneUserStatement(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(USER_TOMBSTONE_MASK_SQL).bind(maskedDeletedEmail(id), id);
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
