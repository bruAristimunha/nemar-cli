-- Runner registrations, their access tokens, and the executor columns of a job (portable compute,
-- card DM-05; decisions D1, D2, D4, D5 and D6 of the plan).
--
-- WHAT THIS IS FOR. A job may be run by a RUNNER (`nemar-runner` on a workstation or a cluster) that
-- polls NEMAR, instead of by Tapis. An owner REGISTERS a runner and is shown its secret once; the
-- secret buys a 15-minute access token; revoking the registration (or ending the owner) ends the
-- tokens and the runner's work in one batch (services/compute-runners.ts). Two tables hold that, and
-- twelve columns of `compute_jobs` record who runs a job and how it is accounted for.
--
-- WORDS. Each IN list below is copied from `shared/compute-state.ts` and `shared/contract/compute-runner.ts`
-- and a test (`compute-runners-migration.test.ts`) compares it with the declared list, so a word
-- added there fails until it is added here. A shape that a later epic may extend is checked by SHAPE.
-- A CHECK passes on NULL, so a term over a column that may be NULL is written `col IS NULL OR (...)`
-- and no term reads a NULLable column bare. No foreign key, and none cascades: `registered_by` and
-- `runner_id` are plain values, so deleting an account never reaches these rows (the cascade is a
-- statement, `runnerEndStatements`) and a job keeps naming the runner that ran it. Every CHECK is
-- named so a test can say which one refused a row. D1 rejects SQL that bun:sqlite accepts, so every
-- GLOB is at most 50 characters. A numeric column is checked with `typeof(...) = 'integer'`.
--
-- compute_runners, column by column (one row per registration; a revoked row stays for the record):
--   * `id`: `rnr_` and 24 lowercase hex digits (RUNNER_ID_RE).
--   * `name`: a fixed word chosen at registration (letters, digits, underscore, up to 64); unique among
--     registrations that are not revoked (the partial index below), so a name can be used again.
--   * `pool` (cpu, gpu), `cores`, `memory_mb`, `gpus`, `scratch_gb`: the capacity the runner declares
--     (the bounds of RunnerRegisterRequestSchema), `backend` (local, slurm), `runtimes`: a JSON array
--     of one to three container runtimes (apptainer, docker, podman), `arch` (amd64, arm64).
--   * `accounting`: `su` or `none`. Registration answers `none` only today; `su` is the later phase's.
--   * `site`: a fixed word naming where it runs (letters, digits, underscore, up to 32); `trust`: `lab`
--     is a workstation its owner controls, `hpc` a shared cluster.
--   * `secret_hash`: the SHA-256 of the secret (64 lowercase hex digits), unique. The secret itself is
--     never stored and is shown once, at registration.
--   * `registered_by`: the account id of the owner who registered it, which the cascade is keyed by.
--   * `registered_at`: on D1's clock. `revoked_at` and `revoke_reason`: set together or both NULL; the
--     reason is a fixed word.
--   * `last_seen_at`: the last token exchange. `runner_version`: the version it reported then.
--
-- compute_runner_tokens: one row per live access token, keyed by the SHA-256 of the token (64 lowercase
-- hex digits). `runner_id` is the registration; `expires_at` and `created_at` are on D1's clock, in
-- SQLite's text form, and a token is accepted only while `expires_at` is in the future. Revoking a
-- registration deletes its rows, so a token stops working at once and not at its expiry.
--
-- compute_jobs gains, in this order:
--   * `executor`: `tapis` (default) or `runner`; a runner runs NEMAR's own pipeline jobs only, so a job
--     of any other `source` is `tapis` (the second CHECK). `accounting`: `su` (default) or `none`; a Tapis job is
--     always `su` (the second CHECK). Mechanics select the executor, money and tenancy the accounting.
--   * `runner_backend`: where a runner job executes; only a runner job names one.
--   * `runner_id`, `runner_claimed_at`, `lease_id`, `lease_expires_at`: the claim. A waiting runner job is
--     `created` with `runner_claimed_at` NULL (no new state). `lease_id` is 32 lowercase hex digits.
--   * `claim_attempts`: how many times the job was claimed.
--   * `runner_remote_id`: what the runner calls the job (a scheduler's job id), a short word-like value.
--   * `runner_wall_seconds`, `runner_cpu_seconds`, `runner_max_rss_mb`: what the runner measured, in whole
--     numbers; NULL until it reports.
-- No `admitted_at`: that column is the tenant admitter's (issue #2121), so either migration can land first.

CREATE TABLE compute_runners (
  id TEXT PRIMARY KEY NOT NULL CONSTRAINT compute_runners_id CHECK (
    length(id) = 28 AND substr(id, 1, 4) = 'rnr_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CONSTRAINT compute_runners_name CHECK (
    length(name) BETWEEN 1 AND 64 AND name NOT GLOB '*[^a-z0-9_]*'),
  pool TEXT NOT NULL CONSTRAINT compute_runners_pool CHECK (pool IN ('cpu', 'gpu')),
  cores INTEGER NOT NULL CONSTRAINT compute_runners_cores CHECK (
    typeof(cores) = 'integer' AND cores BETWEEN 1 AND 256),
  memory_mb INTEGER NOT NULL CONSTRAINT compute_runners_memory CHECK (
    typeof(memory_mb) = 'integer' AND memory_mb BETWEEN 1 AND 16777216),
  gpus INTEGER NOT NULL CONSTRAINT compute_runners_gpus CHECK (
    typeof(gpus) = 'integer' AND gpus BETWEEN 0 AND 8),
  scratch_gb INTEGER NOT NULL CONSTRAINT compute_runners_scratch CHECK (
    typeof(scratch_gb) = 'integer' AND scratch_gb BETWEEN 1 AND 100000),
  backend TEXT NOT NULL CONSTRAINT compute_runners_backend CHECK (backend IN ('local', 'slurm')),
  runtimes TEXT NOT NULL CONSTRAINT compute_runners_runtimes CHECK (
    json_valid(runtimes) AND json_type(runtimes) = 'array'
    AND json_array_length(runtimes) BETWEEN 1 AND 3
    AND runtimes NOT GLOB '*[^][,"a-z]*'),
  arch TEXT NOT NULL CONSTRAINT compute_runners_arch CHECK (arch IN ('amd64', 'arm64')),
  accounting TEXT NOT NULL CONSTRAINT compute_runners_accounting CHECK (accounting IN ('su', 'none')),
  site TEXT NOT NULL CONSTRAINT compute_runners_site CHECK (
    length(site) BETWEEN 1 AND 32 AND site NOT GLOB '*[^a-z0-9_]*'),
  trust TEXT NOT NULL CONSTRAINT compute_runners_trust CHECK (trust IN ('lab', 'hpc')),
  secret_hash TEXT NOT NULL UNIQUE CONSTRAINT compute_runners_secret_hash CHECK (
    length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  registered_by INTEGER NOT NULL CONSTRAINT compute_runners_registered_by CHECK (
    typeof(registered_by) = 'integer' AND registered_by >= 1),
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  revoke_reason TEXT CONSTRAINT compute_runners_revoke_reason CHECK (
    revoke_reason IS NULL OR (length(revoke_reason) BETWEEN 1 AND 64
      AND revoke_reason NOT GLOB '*[^a-z0-9_]*')),
  last_seen_at TEXT,
  runner_version TEXT CONSTRAINT compute_runners_version CHECK (
    runner_version IS NULL OR (length(runner_version) BETWEEN 1 AND 32
      AND runner_version NOT GLOB '*[^0-9A-Za-z.+-]*')),
  CONSTRAINT compute_runners_revoked_together CHECK (
    (revoked_at IS NULL) = (revoke_reason IS NULL))
);

-- One live registration per name; a revoked name is free again.
CREATE UNIQUE INDEX compute_runners_live_name ON compute_runners (name) WHERE revoked_at IS NULL;

-- The cascade finds an owner's live registrations.
CREATE INDEX compute_runners_owner ON compute_runners (registered_by) WHERE revoked_at IS NULL;

CREATE TABLE compute_runner_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL CONSTRAINT compute_runner_tokens_hash CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  runner_id TEXT NOT NULL CONSTRAINT compute_runner_tokens_runner CHECK (
    length(runner_id) = 28 AND substr(runner_id, 1, 4) = 'rnr_'
    AND substr(runner_id, 5) NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX compute_runner_tokens_runner ON compute_runner_tokens (runner_id);

ALTER TABLE compute_jobs ADD COLUMN executor TEXT NOT NULL DEFAULT 'tapis'
  CONSTRAINT compute_jobs_executor CHECK (executor IN ('tapis', 'runner'))
  CONSTRAINT compute_jobs_executor_source CHECK (executor = 'tapis' OR source = 'pipeline');

ALTER TABLE compute_jobs ADD COLUMN accounting TEXT NOT NULL DEFAULT 'su'
  CONSTRAINT compute_jobs_accounting CHECK (accounting IN ('su', 'none'))
  CONSTRAINT compute_jobs_accounting_executor CHECK (executor = 'runner' OR accounting = 'su');

ALTER TABLE compute_jobs ADD COLUMN runner_backend TEXT
  CONSTRAINT compute_jobs_runner_backend CHECK (
    runner_backend IS NULL OR (executor = 'runner' AND runner_backend IN ('local', 'slurm')));

ALTER TABLE compute_jobs ADD COLUMN runner_id TEXT
  CONSTRAINT compute_jobs_runner_id CHECK (
    runner_id IS NULL OR (executor = 'runner' AND length(runner_id) = 28
      AND substr(runner_id, 1, 4) = 'rnr_' AND substr(runner_id, 5) NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE compute_jobs ADD COLUMN runner_claimed_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN lease_id TEXT
  CONSTRAINT compute_jobs_lease_id CHECK (
    lease_id IS NULL OR (length(lease_id) = 32 AND lease_id NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE compute_jobs ADD COLUMN lease_expires_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN claim_attempts INTEGER NOT NULL DEFAULT 0
  CONSTRAINT compute_jobs_claim_attempts CHECK (
    typeof(claim_attempts) = 'integer' AND claim_attempts >= 0);

ALTER TABLE compute_jobs ADD COLUMN runner_remote_id TEXT
  CONSTRAINT compute_jobs_runner_remote_id CHECK (
    runner_remote_id IS NULL OR (length(runner_remote_id) BETWEEN 1 AND 64
      AND runner_remote_id NOT GLOB '*[^0-9A-Za-z_+.:-]*'));

ALTER TABLE compute_jobs ADD COLUMN runner_wall_seconds INTEGER
  CONSTRAINT compute_jobs_runner_wall CHECK (
    runner_wall_seconds IS NULL OR (typeof(runner_wall_seconds) = 'integer'
      AND runner_wall_seconds BETWEEN 0 AND 9007199254740991));

ALTER TABLE compute_jobs ADD COLUMN runner_cpu_seconds INTEGER
  CONSTRAINT compute_jobs_runner_cpu CHECK (
    runner_cpu_seconds IS NULL OR (typeof(runner_cpu_seconds) = 'integer'
      AND runner_cpu_seconds BETWEEN 0 AND 9007199254740991));

ALTER TABLE compute_jobs ADD COLUMN runner_max_rss_mb INTEGER
  CONSTRAINT compute_jobs_runner_rss CHECK (
    runner_max_rss_mb IS NULL OR (typeof(runner_max_rss_mb) = 'integer'
      AND runner_max_rss_mb BETWEEN 0 AND 9007199254740991));

-- The cascade's statements select a runner's jobs by `runner_id` (a revoke, or an owner's end), so they
-- must not scan the job table.
CREATE INDEX compute_jobs_runner ON compute_jobs (runner_id) WHERE runner_id IS NOT NULL;

-- The jobs a runner may claim: waiting (`created`), unclaimed, in a pool. A query uses the index only if
-- it states the same terms.
CREATE INDEX compute_jobs_runner_waiting ON compute_jobs (pool, created_at)
  WHERE executor = 'runner' AND state = 'created' AND runner_claimed_at IS NULL;
