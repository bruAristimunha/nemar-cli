---
name: pr-review-three-faults-behind-no-review
description: "On dev the dataset PR review showed nothing for three separate reasons (webhook secret drift, org secrets instead of variables, a federation subject mismatch); how each looks and how to check it"
metadata:
  type: project
---

Found 2026-10-12 while trialling the review of ADR 0092 on dev. Each fault looked the same from outside, "no review appeared", and each was only visible after the one before it was fixed.

**1. The two Workers held different webhook secrets.**
For a dataset the dev Worker owns, the production Worker forwards GitHub's delivery to `api-test.nemar.org/webhooks/github` with GitHub's own signature, and the dev Worker verifies it with its own `GITHUB_WEBHOOK_SECRET`.
The values differed, so dev answered 401 `invalid signature`.
Production logs only a `warn` for a failed or non-2xx forward and still answers GitHub 200 (`forwarded: true`), so the delivery shows green on the GitHub side and nothing alarms.
The oracle for secret equality: send a signed `ping` (`X-GitHub-Event: ping`, `X-Hub-Signature-256: sha256=<HMAC-SHA-256 of the raw body>`) to `/webhooks/github` on each Worker.
The route verifies the signature before it looks at the event, so a Worker answers 200 `event_ignored` only when its secret verifies the signature you made, and 401 otherwise.
Sign with the value you hold, from the environment and never printed; both Workers must answer 200.
Both Workers must hold the same value, so set it on each.

**2. The four `ANTHROPIC_*` identifiers were organization secrets.**
`run-pr-review.yml` reads them as `vars.*`, so they must be organization VARIABLES visible to the `.github` repository.
Created as organization secrets they arrive empty in `vars`, and the job stops with `the ANTHROPIC_* organization variables are not all set`.
`gh api repos/nemarDatasets/.github/actions/organization-variables` lists the variables that repository can see.

**3. The Anthropic federation rule did not accept the job's subject.**
The rule must accept `repo:nemarDatasets/.github:ref:refs/heads/main`.
The console's audit event for the failed exchange names the condition that failed (for example `match_subject_prefix`).
The rule should also pin `job_workflow_ref` to `nemarDatasets/.github/.github/workflows/run-pr-review.yml@refs/heads/main`, so that no other workflow on `main` can mint the identity.
The review reports `auth_failed` as a check that needs a person.

**Why it matters:** a review that ended in an error for a setup reason is not repeated for the same commit, because its row exists (ADR 0092).
After fixing a fault, push a new commit or run `nemar admin pr-reviews start <dataset> <pr>`, or you will keep reading the old result.

**How to apply:** when a trial pull request gets no check, find where the chain stopped before touching anything (see [[debug-pr-review-chain-with-two-tails]]), and expect more than one fault.
