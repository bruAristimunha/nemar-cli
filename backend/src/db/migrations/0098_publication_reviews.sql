-- The publication review (ADR 0102).
--
-- When the identifier screen of a publication request reports for a commit and its gate is clear
-- or needs an acknowledgment, the Worker starts a review of that commit: it records the attempt
-- here and dispatches a workflow to nemarDatasets/.github. That workflow first CLAIMS the review
-- (the Worker accepts the one-shot token, checks the request is still the one it was dispatched
-- for, and records the time), then reads the dataset's root documents at the commit as git data,
-- examines each with the shared mechanical rules immediately before sending it, asks a model four
-- questions, and posts a report back to /webhooks/publication-review-result. The Worker stores
-- what `parsePublicationReviewReport` accepted and derives the verdict. The report's shape, and
-- every word in it, is declared in `shared/publication-review.ts`.
--
-- One row per (request, screened commit, kind of release): a second screen result for the same
-- commit and flag finds the row and does not review again, a new commit or a flipped anonymous
-- flag makes a new row, and a denied request asked for again is a new request with its own rows.
-- The review in force is the row whose `head_sha` is the request's screened head and whose
-- `anonymous` is the request's flag; the UNIQUE key makes that row unique, and every other row is
-- history.
--
--   * `request_id` / `dataset_id`: the publication request reviewed, and its dataset.
--   * `head_sha`: the commit of `main` the identifier screen reported (`ScreenReport.head`), so the
--     review and the screen always read the same commit.
--   * `anonymous`: the request's flag when the review started (ADR 0065); an anonymous release
--     asks different questions, so a flipped flag is a different review.
--   * `requested_by`: the depositor, for the depositor's daily cap. `started_by`: an administrator
--     who started or restarted it by name, or NULL for a review a screen result started.
--   * `state`: dispatched (handed to GitHub, waiting for a report), reported (a verdict is stored),
--     declined (not sent to the model: a daily cap applied), errored (no verdict: the run reported
--     why, the dispatch failed or was impossible, the request changed before the claim, the review
--     was switched off, or the report it posted was refused), unreported (the watchdog gave up
--     waiting). The same list as `PUBLICATION_REVIEW_STATES`; a test keeps them equal. A reader
--     still must not trust the column.
--   * `verdict`: pass, fail or action_required, DERIVED by `verdictOf` from the report's own
--     reasons and stored beside it. Set exactly when `state` is 'reported'. Every surface
--     re-derives the outcome from the report and the live facts and shows the stricter of the two.
--   * `detail`: the closed word for a declined or errored row (`PUBLICATION_DECLINE_DETAILS`,
--     `PUBLICATION_RUN_ERRORS`). Set exactly when `state` is 'declined' or 'errored', and a
--     declined row holds a cap word and an errored row a run-error word, so no row can say the
--     wrong sentence.
--   * `report`: the parsed report, re-serialized JSON, never the raw callback body. Set exactly
--     when `state` is 'reported'.
--   * `nonce`: signed into the callback token, the one-shot handshake the other callbacks use. It
--     exists exactly while the review may still be answered: always while 'dispatched', KEPT when
--     the watchdog marks a row 'unreported' so a late but valid report still lands, and cleared
--     when a result is stored or the row is declined or errored.
--   * `claimed_at`: when the workflow claimed the review, before it spent anything on the model.
--     A dispatch nobody can claim (it carries no valid token) buys nothing.
--   * `attempts`: one slot per attempt, the number of model calls the row may have cost. An insert
--     starts with one (the call it is about to make) and a restart of an attempt that reached a
--     model adds one, so the caps count calls rather than rows (as migration 0095 does). An
--     attempt that never reached a model gives its slot back when the caps are counted, not in the
--     column: a declined row has attempts = 1 and costs nothing.
--   * `override_by` / `override_at` / `override_reasons`: the administrator's recorded override
--     and the closed reason codes it was given for (written by the approval gate of a later
--     phase). Recorded whole or not at all, on the row it was given for, so it cannot reach
--     another commit's review.
--   * `created_at`: when the attempt was handed over; the caps and the deadline count from it, and
--     a restart moves it. `decided_at`: when the row left 'dispatched'.
--
-- The caps are not stored. How many model calls a depositor or the platform spent in the last
-- day is counted from this table at the moment a row is started (ADR 0034: derive, don't store).
--
-- No FOREIGN KEY to `publication_requests`, `datasets` or `users`: deleting a dataset or a request
-- must not be blocked by, or cascade into, its review history (migration 0092's reason). No column
-- is added to `datasets` or `publication_requests`: everything the review needs about a request
-- is read from the request and joined to this table.

CREATE TABLE publication_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  dataset_id TEXT NOT NULL,
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  anonymous INTEGER NOT NULL CHECK (anonymous IN (0, 1)),
  requested_by INTEGER NOT NULL,
  started_by INTEGER,
  state TEXT NOT NULL
    CHECK (state IN ('dispatched', 'reported', 'declined', 'errored', 'unreported')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'action_required')),
  detail TEXT CHECK (detail IS NULL OR detail IN (
    'depositor_limit', 'platform_limit',
    'evidence_unavailable', 'stale_head', 'auth_failed', 'model_unavailable', 'model_refused',
    'model_truncated', 'model_invalid', 'report_invalid', 'dispatch_failed',
    'dispatch_unconfigured', 'review_disabled', 'workflow_failed'
  )),
  report TEXT,
  nonce TEXT,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  override_by INTEGER,
  override_at TEXT,
  override_reasons TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  UNIQUE (request_id, head_sha, anonymous),
  -- A verdict, and a stored report, exist exactly when the review reported.
  CHECK ((state = 'reported') = (verdict IS NOT NULL)),
  CHECK ((state = 'reported') = (report IS NOT NULL)),
  -- A closed word exists exactly when the row was declined or errored, and it is a word of that kind.
  CHECK ((state IN ('declined', 'errored')) = (detail IS NOT NULL)),
  CHECK (state <> 'declined' OR detail IN ('depositor_limit', 'platform_limit')),
  CHECK (state <> 'errored' OR detail NOT IN ('depositor_limit', 'platform_limit')),
  -- A nonce exists exactly while the review may still be answered.
  CHECK (state IN ('dispatched', 'unreported') OR nonce IS NULL),
  CHECK (state <> 'dispatched' OR nonce IS NOT NULL),
  -- Decided exactly when it left 'dispatched'.
  CHECK ((state = 'dispatched') = (decided_at IS NULL)),
  -- An override is recorded whole or not at all.
  CHECK ((override_by IS NULL) = (override_at IS NULL)),
  CHECK ((override_by IS NULL) = (override_reasons IS NULL))
);

-- The depositor's daily cap. Every lookup by request uses the UNIQUE key's own index, whose first
-- column is `request_id`.
CREATE INDEX idx_publication_reviews_depositor ON publication_reviews (requested_by, created_at);
-- The watchdog's scan for dispatched rows past their deadline. The platform's daily cap does not
-- use it: that count ranks a row by `id <= ?` and reads the INTEGER PRIMARY KEY.
CREATE INDEX idx_publication_reviews_state ON publication_reviews (state, created_at);
