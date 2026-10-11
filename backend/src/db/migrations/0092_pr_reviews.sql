-- The dataset pull-request review (ADR 0092).
--
-- When a pull request is opened or updated against `main` of a dataset repository, the Worker
-- (which the NEMAR GitHub App delivers pull_request events to once it is subscribed to them, forks
-- included) decides whether to review it, records the attempt here, and dispatches a workflow to
-- nemarDatasets/.github. That workflow first CLAIMS the review (the Worker accepts the one-shot
-- token and the row records the time), then reads the change as git data, asks a model three
-- questions (is anything lost or broken, does the revision advance, is the dataset materially
-- better) and posts a report back to /webhooks/pr-review-result. The Worker stores what
-- `parsePrReviewReport` accepted and publishes the result as a check-run and one pull-request
-- comment. The report's shape, and every word in it, is declared in `shared/pr-review.ts`.
--
-- One row per (dataset, pull request, head commit): a delivery GitHub repeats, or a second event
-- for the same commit, finds the row and does not review again, which is also what stops a
-- duplicate delivery from costing a second review.
--
--   * `state`: dispatched (handed to GitHub, waiting for a report), reported (a verdict is
--     stored), declined (not sent to the model: the contributor is paused, or a rate limit
--     applied), errored (no verdict: the run reported that it could not decide, the dispatch
--     failed, the dataset was ineligible, a newer delivery superseded it, or the report it posted
--     was refused),
--     unreported (the watchdog gave up waiting). The same list as `REVIEW_STATES`; a test keeps
--     them equal. A reader still must not trust the column.
--   * `verdict`: pass, fail or uncertain, DERIVED by `verdictOf` from the report and the git facts
--     and stored beside it so the tally is a query. Set exactly when `state` is 'reported'.
--   * `detail`: the closed word for a declined or errored row (`DECLINE_REASONS`, `RUN_ERRORS`).
--     Set exactly when `state` is 'declined' or 'errored', and a declined row holds a decline word
--     and an errored row a run-error word, so no row can publish the wrong sentence.
--   * `nonce`: signed into the callback token, the one-shot handshake the other callbacks use.
--     Cleared when a result is stored. KEPT when the watchdog marks a row 'unreported', so a late
--     but valid report is still accepted and then replaces the "could not decide" check.
--   * `claimed_at`: when the workflow claimed the review, before it spent anything on the model.
--     A dispatch nobody can claim (it carries no valid token) buys nothing.
--   * `author_id` / `author_login`: who opened the pull request. The numeric GitHub id is the key
--     (a login can be renamed or reused); the login is only for people to read. A fork's author is
--     whoever opened the pull request, not the fork's owner.
--   * `author_association`: GitHub's own relationship label, used only to choose a rate cap.
--   * `from_fork`: 1 when the head lives in another repository. The review is identical either
--     way, because the workflow reads `refs/pull/N/head` from the BASE repository and never runs
--     anything from the pull request.
--   * `report`: the parsed report, re-serialized JSON, never the raw callback body. Set exactly
--     when `state` is 'reported'.
--   * `check_run_id`: THIS commit's check-run, created as "in progress" and then updated to its
--     conclusion. `comment_id`: the pull request's one comment, created by the first review that
--     could publish it and reused by the reviews of later commits.
--   * `created_at`: when the commit was first seen; the rate windows count from it. `seen_at`:
--     when it was last delivered. "Latest commit" means the last one SEEN, so force-pushing back
--     to an earlier reviewed commit makes that commit's result the pull request's current one.
--   * `published_at` / `publish_attempts`: whether this row's final outcome reached GitHub as a
--     check-run. NULL means not yet: the watchdog republishes such rows, a few times, so a GitHub
--     outage cannot leave a check "in progress" for good.
--
-- The contributor tally is not stored. "Rejected" and "decided" are counted from this table by
-- `AUTHOR_TALLY_SQL` in services/pr-review.ts (ADR 0034: derive, don't store), so a re-run or a
-- later commit that passes corrects the tally by itself.
--
-- No FOREIGN KEY to `datasets` or `users`: deleting a dataset must not be blocked by, or cascade
-- into, its review history, and a contributor is a GitHub account that need not have a NEMAR one.

CREATE TABLE pr_reviews (
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
    'workflow_failed'
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

CREATE INDEX idx_pr_reviews_author ON pr_reviews (author_id, created_at);
CREATE INDEX idx_pr_reviews_pr ON pr_reviews (dataset_id, pr_number, seen_at);
CREATE INDEX idx_pr_reviews_state ON pr_reviews (state, created_at);

-- A maintainer's standing decision about one contributor. It wins over the tally in both
-- directions: 'allow' keeps reviewing someone the tally would pause, 'block' pauses someone it
-- would not. Set by an administrator with `nemar admin pr-reviews allow|block|clear` (ADR 0093).
CREATE TABLE pr_review_overrides (
  author_id INTEGER PRIMARY KEY,
  author_login TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('allow', 'block')),
  reason TEXT,
  set_by INTEGER,
  set_at TEXT NOT NULL DEFAULT (datetime('now'))
);
