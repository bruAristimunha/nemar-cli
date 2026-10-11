-- Keep the password hashes cleared after ADR 0097 retires password sign-in.
--
-- Migrations run before the Worker deploy, so the previous Worker can briefly
-- keep serving the old CLI signup route after 0093 clears existing hashes.
-- Reject its exact pending, unverified CLI-signup insert first, then clear any
-- hash that route wrote during the 0093-to-0094 window.
CREATE TRIGGER IF NOT EXISTS users_retired_password_signup_guard
BEFORE INSERT ON users
WHEN NEW.password_hash IS NOT NULL
 AND NEW.signup_source = 'cli'
 AND NEW.status = 'pending'
 AND NEW.email_verified = 0
 AND NEW.verification_token IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'password sign-in has been retired');
END;

UPDATE users SET password_hash = NULL WHERE password_hash IS NOT NULL;
