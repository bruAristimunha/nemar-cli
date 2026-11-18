-- Whether the usage a runner reported for a job is PARTIAL (portable compute, card S6; ADR 0121 item 6 and
-- its consequence that a runner-reported core-hour is never added to a service-unit total; risk K14).
--
-- WHAT THIS IS FOR. A runner measures a job's wall time, CPU time and resident memory itself. Under Docker
-- or Podman it cannot always read all three for the whole job (the container runtime hides some of them), so
-- its completion says `usage_partial: true`. The completion body has always carried that word
-- (`shared/contract/compute-runner.ts`), but nothing stored it, so a report could not say that a figure was
-- a lower bound. This column stores it, and every report that shows a runner's figures marks the row.
--
-- `runner_usage_partial`: 1 when the runner marked its usage partial, 0 when it did not, NULL for every Tapis
-- job (a Tapis job has no runner usage) and for a runner job that has not completed. It is written with the
-- other three usage columns, once, under the lease (`RECORD_USAGE_SQL`). A CHECK passes on NULL, so the term
-- is written `col IS NULL OR (...)`.

ALTER TABLE compute_jobs ADD COLUMN runner_usage_partial INTEGER
  CONSTRAINT compute_jobs_runner_usage_partial CHECK (
    runner_usage_partial IS NULL OR runner_usage_partial IN (0, 1));
