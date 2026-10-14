-- A pending account never holds a verified email (ADR 0103).
--
-- ADR 0040: `pending` means the inbox is not proved yet, and proving it is what
-- moves an account to `verified`. The email-change route used to stamp
-- `email_verified = 1` without moving the status, stranding the account: the
-- verify endpoint answers `already_verified` and no other road leaves `pending`.
--
-- Repair first: every live row in that state has proved its inbox, so it takes
-- the base tier it was owed. `approved_at` and the upload grant are untouched;
-- upload access still has exactly one writer, admin approval. Each repair leaves
-- the same `email_verified` audit row the code flow writes, marked with the
-- migration as its route.
INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
SELECT id, 'email_verified', 'user', CAST(id AS TEXT),
       '{"via":"migration_0096","status":"verified"}'
  FROM users
 WHERE status = 'pending'
   AND email_verified = 1
   AND deleted_at IS NULL;

UPDATE users
   SET status = 'verified',
       updated_at = datetime('now')
 WHERE status = 'pending'
   AND email_verified = 1
   AND deleted_at IS NULL;

-- Then refuse the state, so the next writer that forgets the transition fails
-- loudly in its own batch instead of stranding someone. UPDATE only: an INSERT
-- of such a row is not a transition and no route writes one.
CREATE TRIGGER IF NOT EXISTS users_pending_email_verified_guard
BEFORE UPDATE OF status, email_verified ON users
WHEN NEW.status = 'pending'
 AND NEW.email_verified = 1
 AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a pending account cannot have a verified email; promote it to verified');
END;
