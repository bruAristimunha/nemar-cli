-- A limit on the restarts a pull request's text can cause, and the word that says it was reached
-- (ADR 0107, decision 4).
--
-- WHAT THIS IS FOR. An edit of a pull request's title, description or base starts the review of its
-- commit again, and so does a reopening or a marking as ready (phase P4). Each is a run, and nothing
-- else bounds how many one commit can cost. The owner set the bound on 2026-10-19: five restarts a
-- head commit, counted here, and a sixth is refused. This file adds the count and the word.
--
--   * `edit_restarts`: how many times an edit, a reopening or a marking as ready has restarted the
--     review of this commit. A commit's row starts at 0 and a push is a new row, so the count is per
--     head commit. An administrator's start resets it to 0. Every existing row is 0, which is true:
--     none was ever restarted by an edit, because nothing restarted one before this.
--   * `detail = 'edit_limit'`: the closed word for an errored row whose review was refused for that
--     reason. It is added to the list of words the column accepts, so an errored row can hold it. It
--     is not a declined word, so the table's two CHECKs on declined and errored rows are unchanged
--     and a declined row still cannot hold it. `RUN_ERRORS` in `shared/pr-review.ts` lists it too and
--     a test keeps the two lists equal.
--
-- WHY A REBUILD. SQLite cannot alter a CHECK, and the list of words is one. So the table is rebuilt,
-- the way 0089 rebuilt `web_sessions`: every column is copied in its current order with its current
-- type, default and constraint (the columns and CHECKs of 0092, then `attempts` of 0095), the new
-- column goes last, and every index the table has today is recreated with its current definition.
-- The indexes are the three 0092 declared, `idx_pr_reviews_author`, `idx_pr_reviews_pr` and
-- `idx_pr_reviews_state`; no later migration adds or drops one (checked 2026-10-19: no migration
-- other than 0092 and 0095 mentions `pr_reviews` at all), so these three are all there is, and
-- none is added here.
--
-- FOREIGN KEYS AND DEPENDENTS. Nothing references `pr_reviews` and nothing depends on it: no
-- migration declares a `REFERENCES` clause, a trigger or a view that names it (the search above),
-- and 0092 says why it declares no foreign key of its own. So DROP TABLE's implicit DELETE has no
-- child to cascade onto and no `PRAGMA defer_foreign_keys` is needed. The ids are copied verbatim.
-- Copying them into the AUTOINCREMENT table reseeds `sqlite_sequence` at the highest surviving id,
-- and RENAME carries that entry to the new name, so a new row's id is above every copied one. The
-- sequence can be lower than before only if the newest rows were deleted, and nothing stores a
-- review id beyond the callback token of a review that is running, which names a row that exists.
-- There is no BEGIN/COMMIT: D1 refuses them (error 7500, recorded in 0021 and 0063).
--
-- THE GUARD AND THE ORDER, as in 0089 (read its header for the whole account, which this file does
-- not repeat). `_rebuild_guard` aborts the file BEFORE the DROP if the copy is short, altered or
-- padded: inserting a false comparison violates CHECK (ok = 1) and fails that statement. Everything
-- before the DROP is non-destructive; a failure there leaves `pr_reviews` untouched plus the two
-- scratch tables, which a re-run trips over loudly. Once `SELECT COUNT(*) FROM pr_reviews` shows
-- the table intact, clear them and re-run the deploy job:
--   DROP TABLE IF EXISTS _rebuild_guard;
--   DROP TABLE IF EXISTS pr_reviews_new;
-- Never run the second one when `pr_reviews` is missing: it is then the only copy of the rows, and
-- must be renamed, not dropped. The window is DROP -> RENAME -> CREATE INDEX: stopping after the
-- DROP leaves no `pr_reviews`, so every review read and write fails until the rename. Recovery is D1
-- Time Travel to the start of the deploy workflow's migration-apply step.
--
-- NO `IF NOT EXISTS` in the rebuild, on purpose: a blind re-run after a partial failure must fail
-- loudly rather than skip steps (0071's rule).

CREATE TABLE _rebuild_guard (ok INTEGER NOT NULL CHECK (ok = 1));

CREATE TABLE pr_reviews_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  author_login TEXT NOT NULL,
  author_association TEXT,
  from_fork INTEGER NOT NULL DEFAULT 0 CHECK (from_fork IN (0, 1)),
  state TEXT NOT NULL
    CHECK (state IN ('dispatched', 'reported', 'declined', 'errored', 'unreported')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'uncertain')),
  detail TEXT CHECK (detail IS NULL OR detail IN (
    'contributor_paused', 'rate_limited', 'daily_limit',
    'evidence_unavailable', 'stale_head', 'too_large', 'auth_failed', 'model_unavailable',
    'model_refused', 'model_truncated', 'model_invalid', 'report_invalid', 'dispatch_failed',
    'workflow_failed', 'edit_limit'
  )),
  nonce TEXT,
  report TEXT,
  check_run_id INTEGER,
  comment_id INTEGER,
  claimed_at TEXT,
  published_at TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  decided_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  edit_restarts INTEGER NOT NULL DEFAULT 0 CHECK (edit_restarts >= 0),
  UNIQUE (dataset_id, pr_number, head_sha),
  -- A verdict exists exactly when the review reported one.
  CHECK ((state = 'reported') = (verdict IS NOT NULL)),
  -- A reason exists exactly when the row was declined or errored, and it is a reason of that kind.
  CHECK ((state IN ('declined', 'errored')) = (detail IS NOT NULL)),
  CHECK (state <> 'declined' OR detail IN ('contributor_paused', 'rate_limited', 'daily_limit')),
  CHECK (state <> 'errored' OR detail NOT IN ('contributor_paused', 'rate_limited', 'daily_limit')),
  -- A stored report exists exactly when the review reported.
  CHECK ((state = 'reported') = (report IS NOT NULL))
);

INSERT INTO pr_reviews_new
  (id, dataset_id, pr_number, head_sha, author_id, author_login, author_association, from_fork,
   state, verdict, detail, nonce, report, check_run_id, comment_id, claimed_at, published_at,
   publish_attempts, created_at, seen_at, decided_at, attempts)
SELECT id, dataset_id, pr_number, head_sha, author_id, author_login, author_association, from_fork,
       state, verdict, detail, nonce, report, check_run_id, comment_id, claimed_at, published_at,
       publish_attempts, created_at, seen_at, decided_at, attempts
  FROM pr_reviews;

-- The copy is exact before anything is destroyed: the same number of rows, no row of the old table
-- missing from or different in the new one, and no row in the new table that the old one lacks.
-- `EXCEPT` compares every named column, NULLs included, so "short or altered" means exactly that.
-- The three rows overlap on purpose (rows are distinct by id, so the count plus either direction
-- already forces equality); each reads as one plain question.
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM pr_reviews_new) = (SELECT COUNT(*) FROM pr_reviews);
INSERT INTO _rebuild_guard
SELECT COUNT(*) = 0 FROM (
  SELECT id, dataset_id, pr_number, head_sha, author_id, author_login, author_association,
         from_fork, state, verdict, detail, nonce, report, check_run_id, comment_id, claimed_at,
         published_at, publish_attempts, created_at, seen_at, decided_at, attempts
    FROM pr_reviews
  EXCEPT
  SELECT id, dataset_id, pr_number, head_sha, author_id, author_login, author_association,
         from_fork, state, verdict, detail, nonce, report, check_run_id, comment_id, claimed_at,
         published_at, publish_attempts, created_at, seen_at, decided_at, attempts
    FROM pr_reviews_new
);
INSERT INTO _rebuild_guard
SELECT COUNT(*) = 0 FROM (
  SELECT id, dataset_id, pr_number, head_sha, author_id, author_login, author_association,
         from_fork, state, verdict, detail, nonce, report, check_run_id, comment_id, claimed_at,
         published_at, publish_attempts, created_at, seen_at, decided_at, attempts
    FROM pr_reviews_new
  EXCEPT
  SELECT id, dataset_id, pr_number, head_sha, author_id, author_login, author_association,
         from_fork, state, verdict, detail, nonce, report, check_run_id, comment_id, claimed_at,
         published_at, publish_attempts, created_at, seen_at, decided_at, attempts
    FROM pr_reviews
);

DROP TABLE pr_reviews;

ALTER TABLE pr_reviews_new RENAME TO pr_reviews;

-- The three indexes the table has today, definitions verbatim from 0092.
CREATE INDEX idx_pr_reviews_author ON pr_reviews (author_id, created_at);
CREATE INDEX idx_pr_reviews_pr ON pr_reviews (dataset_id, pr_number, seen_at);
CREATE INDEX idx_pr_reviews_state ON pr_reviews (state, created_at);

DROP TABLE _rebuild_guard;
