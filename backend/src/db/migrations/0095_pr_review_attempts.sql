-- How many model calls a pull-request review row has cost (ADR 0092, amendment of 2026-10-10).
--
-- The platform's daily pool counted rows. A row is started again when an administrator asks (a
-- review that ended in an error, never reported, or was declined is tried once more), and the new
-- attempt reuses the row, so a review that had already spent a call was counted once however often
-- it was restarted. The pool now sums this column instead, and a restart of an attempt that spent a
-- call adds one when it is handed to GitHub.
--
-- Every existing row is one attempt, which is what it cost.
ALTER TABLE pr_reviews ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1);
