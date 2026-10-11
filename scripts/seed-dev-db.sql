-- Dev Database Seed
-- Idempotent: safe to run multiple times (uses INSERT OR IGNORE)
-- Run with: npx wrangler@latest d1 execute nemar-db-dev --remote --env dev -c backend/wrangler.toml --file scripts/seed-dev-db.sql

-- Test users. None has a password: NEMAR has no password sign-in (ADR 0097), so
-- these rows carry none and sign in by API key or, on the web, by email code.
--
-- `service_access` is explicit on every 'approved' row and only on those, to
-- hold ADR 0040's invariant: status = 'approved' <=> service_access = 1.
-- Migration 0075 established it over the catalog and the approve/revoke routes
-- maintain it, but a seed INSERT bypasses both -- an approved row seeded with
-- the column's 0 default would be exactly the #1249 shape the ADR exists to
-- remove, and 'test-user' would 403 on the E2E upload to nm099999.
-- 'test-verified' is the base-tier fixture: verified, no grant, so it can
-- authenticate and be refused by the upload gate rather than by the
-- middleware. It deliberately holds no token row. Its account_kind is 'test'
-- (set further down), which the device flow refuses, so a key for it is minted
-- by an owner with `nemar admin keys create`; the first-key-from-'verified'
-- path of the device flow itself is covered by backend/test/device-auth-routes
-- .test.ts, not by this fixture.
--
-- INSERT OR IGNORE means a re-run is a no-op for rows that already exist, so
-- adding the column here does NOT backfill an existing dev row: migration
-- 0075 rule (a) is what grants service_access to the approved rows already in
-- the database. This is for a database seeded fresh AFTER 0075 ran, where
-- nothing else would.
INSERT OR IGNORE INTO users (username, email, github_username, status, role, email_verified, approved_at, revoked_at, service_access)
VALUES ('test-owner', 'testOwner@nemar.org', 'test-owner-gh', 'approved', 'owner', 1, datetime('now'), NULL, 1);

INSERT OR IGNORE INTO users (username, email, github_username, status, role, email_verified, approved_at, revoked_at, service_access)
VALUES ('test-admin', 'testAdmin@nemar.org', 'test-admin-gh', 'approved', 'admin', 1, datetime('now'), NULL, 1);

INSERT OR IGNORE INTO users (username, email, github_username, status, role, email_verified, approved_at, revoked_at, service_access)
VALUES ('test-user', 'test-user@nemar.test', 'test-user-gh', 'approved', 'member', 1, datetime('now'), NULL, 1);

-- Shared web-QA account (#1008): a normal member used to exercise upload and
-- other researcher flows on test.nemar.org. It is on the non-production
-- email-code allowlist and gets dev_code echoed, so anyone on the team can
-- sign in without an inbox. Distinct from 'test-user' on purpose:
-- test/api.test.ts authenticates with test-user@nemar.test and must not change.
INSERT OR IGNORE INTO users (username, email, github_username, status, role, email_verified, approved_at, revoked_at, service_access)
VALUES ('test-web', 'test@nemar.org', 'test-web-gh', 'approved', 'member', 1, datetime('now'), NULL, 1);

INSERT OR IGNORE INTO users (username, email, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-pending', 'test-pending@nemar.test', 'test-pending-gh', 'pending', 'member', 0, NULL, NULL);

INSERT OR IGNORE INTO users (username, email, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-verified', 'test-verified@nemar.test', 'test-verified-gh', 'verified', 'member', 1, NULL, NULL);

INSERT OR IGNORE INTO users (username, email, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-revoked', 'test-revoked@nemar.test', 'test-revoked-gh', 'revoked', 'member', 1, NULL, datetime('now'));

-- API tokens (SHA-256 hashes of TEST_ADMIN_API_KEY, TEST_OWNER_API_KEY, and
-- TEST_USER_API_KEY from test/.env.test)
INSERT OR IGNORE INTO tokens (user_id, api_key_hash, api_key_prefix)
SELECT id, '95cd31011dac1cddee0bfdd6e2f01d231b6885908194b4c94c6657396e0c038e', 'nemar_test_9f57c' FROM users WHERE username = 'test-admin';

-- test-owner's token (epic #1272 phase 4, #1284): the owner-role sibling of
-- test-admin's, needed so test/admin-owner-key-mint-flow.test.ts's owner-path
-- cases stop skipping. Same columns and conventions as the test-admin row.
INSERT OR IGNORE INTO tokens (user_id, api_key_hash, api_key_prefix)
SELECT id, 'fba69d2c7b8fe60b2c8379ef6226da23dae488905c1414078b96a63aad1f7839', 'nemar_test_53576' FROM users WHERE username = 'test-owner';

INSERT OR IGNORE INTO tokens (user_id, api_key_hash, api_key_prefix)
SELECT id, '7cd087c94ae729fafa05243282163c993306b173cfd88b83b32dd92c27ce14f9', 'nemar_test_aeef8' FROM users WHERE username = 'test-user';

-- Test dataset nm099999
INSERT OR IGNORE INTO datasets (dataset_id, name, description, owner_user_id, status, github_repo, visibility, is_sandbox)
SELECT 'nm099999', 'E2E Test Dataset', 'Persistent test dataset for E2E testing',
       id, 'active', 'nemarDatasets/nm099999', 'private', 0
FROM users WHERE username = 'test-admin';

-- S3 permissions for test users on nm099999
INSERT OR IGNORE INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by)
SELECT id, 'nm099999', 'read_write', id FROM users WHERE username = 'test-admin';

INSERT OR IGNORE INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by)
SELECT id, 'nm099999', 'read_write', id FROM users WHERE username = 'test-user';

-- Collaborator access for test-user on nm099999.
-- The upload/download-credentials endpoints authorize a non-owner/non-admin by
-- requiring BOTH a dataset_collaborators row AND a user_s3_permissions row, so
-- the user_s3_permissions grant above is not sufficient on its own. Without
-- this row the iam-removal collaborator tests 403 (test/iam-removal.test.ts).
INSERT OR IGNORE INTO dataset_collaborators (dataset_id, user_id, granted_by, access_type)
SELECT d.id, u.id, owner.id, 'invited'
FROM datasets d
JOIN users u ON u.username = 'test-user'
JOIN users owner ON owner.username = 'test-admin'
WHERE d.dataset_id = 'nm099999';

-- Service access (ADR 0010 / #1013): grant the upload-capable test users
-- service access + sandbox completion so E2E upload flows keep working after the
-- upload gate lands. Idempotent UPDATE so re-running fixes pre-existing rows
-- (INSERT OR IGNORE above never updates an existing row). test-web (the shared
-- base-access QA account) is intentionally left WITHOUT service access so it
-- exercises the base tier.
UPDATE users
   SET service_access = 1,
       service_access_granted_at = COALESCE(service_access_granted_at, datetime('now')),
       sandbox_completed = 1,
       sandbox_completed_at = COALESCE(sandbox_completed_at, datetime('now'))
 WHERE username IN ('test-owner', 'test-admin', 'test-user');

-- Account kinds (epic #1272 phase 4, #1284; ADR 0048; migration 0082's data
-- half repeated here for a database seeded fresh AFTER that migration ran,
-- same reasoning as the service_access UPDATE above). test-owner and
-- test-admin are operational fixtures with no ORCID and never will be;
-- test-user/test-pending/test-verified/test-revoked are a human's secondary
-- persona. test-web stays 'person' (the default): it is the shared web-QA
-- account (#1008) that has to reach the ORCID authorize page and the
-- Settings key form like a real person.
--
-- Marker comments below (#1284 review) let
-- backend/test/seed-dev-db-account-kind.test.ts slice out exactly these two
-- statements with readFileSync and run them for real, rather than
-- retyping them (.rules/testing.md).
-- ACCOUNT-KIND-SEED:BEGIN
UPDATE users
   SET account_kind = 'service'
 WHERE username IN ('test-owner', 'test-admin') AND account_kind = 'person';

UPDATE users
   SET account_kind = 'test'
 WHERE username IN ('test-user', 'test-pending', 'test-verified', 'test-revoked')
   AND account_kind = 'person';
-- ACCOUNT-KIND-SEED:END

-- Verification: confirm seed data exists (check counts manually if unexpected)
SELECT 'users' AS tbl, COUNT(*) AS n FROM users WHERE username LIKE 'test-%';
SELECT 'tokens' AS tbl, COUNT(*) AS n FROM tokens WHERE api_key_prefix LIKE 'nemar_test_%';
SELECT 'datasets' AS tbl, COUNT(*) AS n FROM datasets WHERE dataset_id = 'nm099999';
SELECT 'permissions' AS tbl, COUNT(*) AS n FROM user_s3_permissions WHERE s3_prefix = 'nm099999';
SELECT 'collaborators' AS tbl, COUNT(*) AS n FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE d.dataset_id = 'nm099999';
