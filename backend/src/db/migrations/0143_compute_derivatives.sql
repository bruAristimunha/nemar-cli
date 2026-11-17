-- The derivative store's index (portable compute, card V1b; ADR 0123 as amended 2026-11-16; plan D14).
--
-- WHAT THIS IS FOR. A finished pipeline job's product is copied, server side, into a private derivatives
-- bucket under `d/<key>/`, where `<key>` is the derivative key of `shared/contract/derivatives.ts`: the
-- SHA-256 of the eight fields below. This table is the index of those derivatives: one row per key, with
-- the job and the stamp that made it, its retention class and where its copy stands. Nothing here is a
-- credential, a path a job wrote or a name: a dataset id, a version tag, fixed words, digests, counts
-- and times.
--
-- ONE ROW PER KEY. `key` is the primary key and the code inserts with `ON CONFLICT(key) DO NOTHING`, so a
-- second job that reads the same thing adds nothing: the first derivative stands (ADR 0123, Consequences).
-- `stamp_id` is unique too: one stamp makes at most one row.
--
-- THE EIGHT KEY FIELDS are `dataset_id`, `version`, `recipe`, `recipe_version`, `engine`, `input`,
-- `profile` and `input_digest`, each under the rule of `validateDerivativeKeyFields` (the same shapes the
-- stamp table holds), and `input` takes its one profile and its one digest shape: `zarr` goes with `serving`
-- and a `sha256:` digest, `bids` with `archive` and a `git:` digest. `image_digest` is provenance and is
-- never part of the key.
--
-- STATES. `copying`: the row is made and its files are being copied, `copied` of `object_count` so far.
-- `stored`: every file is copied and checked and `derivative.json` is written (`stored_at` is set).
-- `failed`: the copy could not be trusted, and `failure` says which word; the objects it had copied are
-- deleted and `copied` is set back to 0 once none is left. `expired`: the objects are gone and the row stays
-- for the record.
--
-- RETENTION. `canary` (the start of every row) expires 30 days after `stored_at`; `catalog` is kept until a
-- later `catalog` row of the same dataset, recipe, input and profile is promoted, then `superseded_at` is set
-- and it expires 30 days after that; `published` never expires and only the owner sets it. `expires_at` is
-- NULL while a row has no date. No code path lowers a class, and none deletes a row. `doi` is NULL on every
-- row: no code writes it (ADR 0123 decision 5), and the CHECK says only a `published` row could ever hold one.
-- A `published` row is deliberately NOT forbidden an `expires_at`: the code that expires rows never touches a
-- `published` one, and the guard in it is held by a test that gives a `published` row a past date.
--
-- THE SCAN CURSOR. A succeeded stamp that cannot be keyed (its record states no digest, or fails a check of
-- the ADR) writes no row, so a candidate query that asks for "stamps with no row" would meet it again at every
-- call, and a wall of them (every record written before the recipe computed version 2 of the input digest)
-- would use the whole subrequest budget of a call and starve the stamps behind it. `compute_derivative_scan`
-- is one row that holds the highest stamp id the scan has decided; a stamp whose records could not be read
-- (a transient fault) is not decided and is met again. Resetting the cursor is a statement an owner runs.
--
-- Every CHECK is named, a numeric column is checked with `typeof(...) = 'integer'`, every term is TRUE or
-- FALSE and never NULL (as 0117 requires: a CHECK passes on NULL), and every GLOB is at most 50 characters
-- (D1 refuses longer). No foreign key: deleting a dataset expires its `canary` and `catalog` rows in the
-- deletion's batch (services/deletion.ts) and keeps its `published` ones.

CREATE TABLE compute_derivatives (
  key TEXT PRIMARY KEY NOT NULL CONSTRAINT compute_derivatives_key CHECK (
    length(key) = 64 AND key NOT GLOB '*[^0-9a-f]*'),
  dataset_id TEXT NOT NULL CONSTRAINT compute_derivatives_dataset CHECK (
    length(dataset_id) = 8 AND substr(dataset_id, 1, 2) NOT GLOB '*[^a-z]*'
    AND substr(dataset_id, 3) NOT GLOB '*[^0-9]*'),
  version TEXT NOT NULL CONSTRAINT compute_derivatives_version CHECK (
    length(version) BETWEEN 1 AND 64 AND version NOT GLOB '*[^0-9A-Za-z._+-]*'),
  recipe TEXT NOT NULL CONSTRAINT compute_derivatives_recipe CHECK (
    length(recipe) BETWEEN 1 AND 64 AND recipe NOT GLOB '*[^a-z0-9-]*'),
  recipe_version TEXT NOT NULL CONSTRAINT compute_derivatives_recipe_version CHECK (
    length(recipe_version) BETWEEN 1 AND 64 AND recipe_version NOT GLOB '*[^0-9A-Za-z._+-]*'),
  engine TEXT NOT NULL CONSTRAINT compute_derivatives_engine CHECK (
    length(engine) BETWEEN 1 AND 64 AND engine NOT GLOB '*[^0-9A-Za-z._+@-]*'),
  input TEXT NOT NULL CONSTRAINT compute_derivatives_input CHECK (input IN ('zarr', 'bids')),
  profile TEXT NOT NULL CONSTRAINT compute_derivatives_profile CHECK (
    profile IN ('serving', 'archive')),
  input_digest TEXT NOT NULL CONSTRAINT compute_derivatives_input_digest CHECK (
    (length(input_digest) = 71 AND substr(input_digest, 1, 7) = 'sha256:'
      AND substr(input_digest, 8) NOT GLOB '*[^0-9a-f]*')
    OR (length(input_digest) = 44 AND substr(input_digest, 1, 4) = 'git:'
      AND substr(input_digest, 5) NOT GLOB '*[^0-9a-f]*')),
  image_digest TEXT NOT NULL CONSTRAINT compute_derivatives_image_digest CHECK (
    length(image_digest) = 71 AND substr(image_digest, 1, 7) = 'sha256:'
    AND substr(image_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  job_id TEXT NOT NULL CONSTRAINT compute_derivatives_job CHECK (
    length(job_id) = 28 AND substr(job_id, 1, 4) = 'job_'
    AND substr(job_id, 5) NOT GLOB '*[^0-9a-f]*'),
  stamp_id INTEGER NOT NULL CONSTRAINT compute_derivatives_stamp CHECK (
    typeof(stamp_id) = 'integer' AND stamp_id >= 1),
  state TEXT NOT NULL DEFAULT 'copying' CONSTRAINT compute_derivatives_state CHECK (
    state IN ('copying', 'stored', 'failed', 'expired')),
  retention TEXT NOT NULL DEFAULT 'canary' CONSTRAINT compute_derivatives_retention CHECK (
    retention IN ('canary', 'catalog', 'published')),
  failure TEXT CONSTRAINT compute_derivatives_failure CHECK (
    failure IS NULL OR (length(failure) BETWEEN 1 AND 64 AND failure NOT GLOB '*[^a-z0-9_]*')),
  copied INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_derivatives_copied CHECK (
    typeof(copied) = 'integer' AND copied >= 0),
  object_count INTEGER NOT NULL CONSTRAINT compute_derivatives_object_count CHECK (
    typeof(object_count) = 'integer' AND object_count BETWEEN 1 AND 1000000),
  bytes INTEGER NOT NULL CONSTRAINT compute_derivatives_bytes CHECK (
    typeof(bytes) = 'integer' AND bytes >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  stored_at TEXT CONSTRAINT compute_derivatives_stored_at CHECK (
    stored_at IS NULL OR length(stored_at) = 19),
  superseded_at TEXT CONSTRAINT compute_derivatives_superseded_at CHECK (
    superseded_at IS NULL OR length(superseded_at) = 19),
  expires_at TEXT CONSTRAINT compute_derivatives_expires_at CHECK (
    expires_at IS NULL OR length(expires_at) = 19),
  doi TEXT CONSTRAINT compute_derivatives_doi_shape CHECK (
    doi IS NULL OR length(doi) BETWEEN 1 AND 255),
  -- An input takes its one profile and its one digest shape (the key's own pairing).
  CONSTRAINT compute_derivatives_input_pairing CHECK (
    (input = 'zarr' AND profile = 'serving' AND substr(input_digest, 1, 7) = 'sha256:')
    OR (input = 'bids' AND profile = 'archive' AND substr(input_digest, 1, 4) = 'git:')),
  -- A failed row says why, and no other row carries a word.
  CONSTRAINT compute_derivatives_failure_iff CHECK ((state = 'failed') = (failure IS NOT NULL)),
  -- A stored row has its time and every file copied; a row never copied more than it has.
  CONSTRAINT compute_derivatives_stored_has_time CHECK (state <> 'stored' OR stored_at IS NOT NULL),
  CONSTRAINT compute_derivatives_stored_is_whole CHECK (state <> 'stored' OR copied = object_count),
  CONSTRAINT compute_derivatives_copied_within CHECK (copied <= object_count),
  -- No code writes a DOI; the row that could ever hold one is a published one.
  CONSTRAINT compute_derivatives_doi_published CHECK (doi IS NULL OR retention = 'published')
);

-- One stamp makes at most one row.
CREATE UNIQUE INDEX compute_derivatives_stamp ON compute_derivatives (stamp_id);

-- A dataset's derivatives, and the catalog class of a dataset, recipe, input and profile (the supersede rule).
CREATE INDEX compute_derivatives_dataset ON compute_derivatives (dataset_id, created_at);
CREATE INDEX compute_derivatives_catalog ON compute_derivatives (dataset_id, recipe, input, profile)
  WHERE retention = 'catalog';

-- What the sync works on: rows still copying, rows due, and failed rows with objects left to delete.
CREATE INDEX compute_derivatives_copying ON compute_derivatives (created_at) WHERE state = 'copying';
CREATE INDEX compute_derivatives_due ON compute_derivatives (expires_at)
  WHERE expires_at IS NOT NULL AND state IN ('copying', 'stored');
CREATE INDEX compute_derivatives_cleanup ON compute_derivatives (created_at)
  WHERE state = 'failed' AND copied > 0;

-- The scan cursor: one row, the highest succeeded-stamp id the scan has decided (see above).
CREATE TABLE compute_derivative_scan (
  id INTEGER PRIMARY KEY NOT NULL CONSTRAINT compute_derivative_scan_id CHECK (id = 1),
  stamp_id INTEGER NOT NULL CONSTRAINT compute_derivative_scan_stamp CHECK (
    typeof(stamp_id) = 'integer' AND stamp_id >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO compute_derivative_scan (id, stamp_id) VALUES (1, 0);
