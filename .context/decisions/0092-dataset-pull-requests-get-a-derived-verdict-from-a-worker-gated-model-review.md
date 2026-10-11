# ADR 0092: Dataset pull requests get a derived verdict from a Worker-gated model review

**Status:** proposed
**Date:** 2026-10-08
**Owner:** Seyed Yahya Shirazi

Follows ADR 0001 (published datasets are PR-only), ADR 0020 (central workflows, callback), ADR 0053
and ADR 0086 (unknown is never clear), ADR 0026 (adequacy judgments stay advisory).

## Context

A pull request to a published dataset is reviewed by an administrator by hand. The required checks
say the BIDS validator passed and the version went up. They do not say whether the change lost
anything, whether the revision is honestly described, or whether the dataset is better afterwards.

Three facts shape any automation here. Every approved user, and on a public dataset every GitHub
user, can open a pull request, from a fork if need be, so the text of a pull request is hostile by
default and each review costs money. A workflow in a dataset repository can be edited on a branch by
anyone with push access, and the federation rule that lets a job use the NEMAR Anthropic account
trusts a repository, so the identity must only ever be minted where an author cannot edit the
workflow. And `neutral` and `skipped` count as passing for a required check on GitHub, so "could not
decide" cannot be expressed with either.

## Decision

**The Worker is the gate, one central workflow is the reviewer, and the verdict is derived.**

- **The trigger is the GitHub App's `pull_request` delivery to the Worker**, for pull requests
  against `main` (not drafts, not bots). No workflow in any dataset repository takes part, so there
  is nothing in a dataset repository to edit and nothing to roll out to ~785 repositories (ADR
  0020). Before storing or dispatching a review, the Worker requires the dataset row to be active,
  public, named (`anonymous = 0`) and published (`first_published_at` is set). A private upload,
  anonymous deposit, archived row or unpublished dataset cannot send pull-request text or metadata
  to the model. A fork is reviewed exactly like a branch: the job reads `refs/pull/N/head` from the
  BASE repository and never fetches from the fork.
- **The Worker decides whether a review is dispatched, and the claim makes that binding.** It
  records one row per (dataset, pull request, head commit) in `pr_reviews`, so a repeated delivery
  is free. It pauses a contributor who has had more than 5 pull requests rejected AND more than 10
  percent of their decided pull requests rejected (the later of the two thresholds), counted from
  the table, not stored: a pull request counts once, by its latest decided review, so fixing it
  clears it. `pr_review_overrides` lets a maintainer allow or block a contributor outright. A
  stranger gets 3 reviews an hour and 6 a day, a collaborator 20 an hour and 100 a day, and the
  platform 400 a day. The caps are ranked after the insert, so concurrent deliveries cannot all
  slip under them.
- **The workflow claims the review before it spends anything.** The dispatch carries a one-shot
  token the Worker signed for that review. The workflow's first real act is `POST
  /webhooks/pr-review-claim`; the Worker accepts the token once and checks that the review is still
  its latest recorded delivery and that the dataset is still an active, named public publication in
  the same conditional update that claims it. A superseded review or dataset that becomes
  ineligible is recorded as `stale_head`. If the claim and refusal cannot settle across two
  conditional attempts, the Worker closes the same unclaimed attempt as `stale_head`; it never
  leaves that dispatch pending for the watchdog or allows it to spend without a claim.
  The workflow later compares both the fetched pull ref and the current GitHub API head against the
  dispatched SHA before it sends anything to the model. A dispatch that
  cannot claim (forged by someone who holds a dataset repository's workflow credentials, replayed,
  or superseded by a newer Worker-recorded delivery) stops before anything is installed, minted or
  sent to a model, ends green and costs nothing. Without the claim the caps would bind only reviews
  the Worker itself dispatched, and the dispatch is an API anyone with those credentials can call.
- **A failed dispatch only fails its own unclaimed attempt.** The dispatch-failure update is fenced
  by the row's nonce and `claimed_at IS NULL`. If GitHub accepted a dispatch before its response was
  lost and the workflow claimed it, the Worker preserves that claim and accepts its callback rather
  than turning a valid run into a retry.
- **The reviewer is `run-pr-review.yml` in `nemarDatasets/.github`**, authored in this repository
  and deployed by whole-file copy like the onboarding workflow. The Anthropic identity is minted
  there and nowhere else, by workload identity federation (`claude-haiku-5-5`, effort `high`). Each
  step is given only what it uses: the step that calls the model has the federated identity and the
  callback token in its environment and no GitHub credential in it, and the read-only token for ONE
  repository (contents and pull requests, an hour at most) is passed to the two steps that read it.
  The fetch step also leaves that token in the clone's git config, because the clone is blob-less
  and the model step's git reads fetch blobs lazily; so the model step can use the read-only token
  through git, though it cannot print it, send it anywhere or write with it. The job has no
  credential that writes to GitHub or NEMAR beyond the one-shot callback token, which can post one
  report for one review. Nothing from the pull request is executed: the repository is fetched with
  `init` and `fetch`, never checked out.
- **Every dispatch has a distinct Actions concurrency group.** The group is keyed by GitHub's
  workflow run id and attempt, never by the untrusted event payload. GitHub retains one pending run
  per group, so payload-derived groups could let a forged dispatch replace a legitimate pending
  review.
- **The callback token is masked before anything can print it.** `nemarDatasets/.github` is public
  and Actions prints a step's `env:` in its header, so a token in job-level env would sit in every
  public log. The first step registers it as a secret with no env of its own, and only the steps that
  use it carry it. A job that fails after the claim reports through a dependency-free `curl` step
  written during validation, so it needs nothing the failure may have been about.
- **The model has no tools and writes little.** It answers three questions (is anything lost or
  broken, does the revision advance, is the dataset materially better) as pass, fail or unknown,
  with findings from a closed list. Untrusted text sits in a per-run, nonce-fenced block. It cannot
  write the evidence block, the version, the model name or a verdict.
- **The verdict is derived** by `verdictOf` from those answers and from facts computed from git. A
  fact overrules the model: no changed file cannot be an improvement, an unchanged version cannot
  advance the revision, a truncated list cannot certify that nothing was lost, any removed file
  needs a person, and a steering attempt fails the review. The parser also makes a report agree
  with itself in the safe direction: a finding that names a steering attempt sets the steering flag,
  and a criterion the model passed while filing a blocker against it becomes unknown. The report is
  a closed vocabulary; free text is sanitised to plain words, and only the start of a long note is
  ever read.
- **Every change is accounted for.** The report carries exact per-area counts, the version and
  subject change, how much content the model read, and a file list. The Worker refuses a report whose
  areas do not add up to its file total.
- **Green and red are real; everything else needs a person.** `pass` is a `success` check,
  `fail` a `failure`, and an uncertain, declined, errored or never-reported review is
  `action_required`. The Worker publishes the check-run and one pull-request comment, edited in place
  per commit, and a watchdog republishes a result whose check never reached GitHub. A human still
  approves and merges.
- **The check is not required by any ruleset yet.** Making it required is a separate decision, made
  with the observed false-fail rate in hand, through `nemar admin fleet enforce`.

## Consequences

- An administrator opens a pull request that already says what changed, in counts, and what a
  reviewer found, with a pass or fail beside the BIDS check.
- A model is now red or green on a pull request. That departs from ADR 0026, which keeps adequacy
  judgments advisory, and is acceptable only because the check is not required and a fact can lower
  the model's answer but the model can never raise a fact.
- A contributor can be paused by the tally. The way back is a row in `pr_review_overrides`, which
  `nemar admin pr-reviews allow|block|clear` writes (ADR 0093); it was a `wrangler d1 execute` until then.
- The tally and the rate caps live in D1 on the production Worker. The dev Worker answers only for
  repositories it owns, and the watchdog is production-only.
- A workflow that cannot reach the Worker at the claim, or is answered with an error, fails its
  job after three tries, so the failure is visible in the Actions tab. Only a refusal that proves the
  dispatch is not this review's to run (HTTP 401 or 409) ends green.
- Anything that stops a review after it was claimed (a missing org variable, a federation rule that
  does not match this workflow, an unreadable file) shows as a check that needs a person, never as a
  pass. A missing App permission for the comment is the exception: the check still lands, the
  comment's refusal is logged, and the stored verdict is kept.
- The review sees names, counts and the content of a few metadata files, not recordings. It says so.
- Green means the model found nothing wrong AND git found nothing it could not clear: no removed
  file, a version that went up, a change list that fits. A pull request that deletes anything needs a
  person even when the deletion is right, which costs some noise and keeps a mass deletion from
  riding on a model's word.
- Accepted risks, stated so nobody has to rediscover them:
  - **Many new accounts.** The per-author caps and the tally are keyed on the GitHub account id, so
    someone who opens accounts can buy reviews. The platform cap of 400 a day bounds the cost, and
    it is one shared pool: a flood from strangers can starve a trusted contributor of a review that
    day (the check says so, and the pull request is reviewed by hand as it was before).
  - **Padding the tally.** A contributor can open many easy passing pull requests to stay under the
    10 percent threshold. The thresholds are a rate limiter, not a reputation system.
  - **Attribution when a maintainer edits.** The author of record is whoever opened the pull
    request; commits a maintainer pushes to it count against that author.
  - **A redelivered older commit.** The latest commit is the last one SEEN. If the delivery for
    commit A fails and B is processed, a manual redelivery of A makes A the latest, B's claim is
    refused as superseded and A's job finds the pull request at B. Neither reaches the model; a new
    delivery for the current head may be needed. It fails safe and wastes one review; ordering by
    the payload's `updated_at` would fix it and is not done.
  - **Reviews are not atomic with GitHub.** A retried check-run create can leave an orphan
    "in progress" check if the response was lost; a repeat decline for a new commit is suppressed
    without a check of its own; a claim whose answer was lost is refused on retry and the review is
    later reported as not finished. All end as "needs a person" or as no check, never as a pass, and
    only matter once the check is required.
  - **A new sidecar can override an inherited one.** Added files do not mark the evidence as
    incomplete, though under BIDS inheritance a new sidecar can change what a recording means. The
    model sees added metadata files it was given; it does not see every one.
  - **The OIDC token is short-lived.** The workflow fetches it just before the model step; whether
    it outlives a long review is unverified, and a failure to exchange it reports `auth_failed`.
  - **A model can be wrong in the green direction.** Facts cover what git can establish (nothing
    changed, version not advanced, files or subjects lost, a truncated list); a plausible-looking but
    harmful change in a sidecar value is not one of them. This is why the check is not required.
- A review that ended in an error for a setup reason (a missing organization variable, a federation
  rule that does not match) is not repeated for the same commit, because the row for that commit
  exists. A new push re-runs it, and an administrator can start it again by name (the amendment of
  2026-10-10 below).

## Alternatives considered

- **The Claude GitHub App or `claude-code-action` in each dataset repository.** Needs a workflow in
  every dataset repository that a collaborator can edit on a branch, a federation rule that trusts
  all of them, an agent with tools in front of hostile text, and a rollout to every repository.
  Rejected. The app can still be installed for `@claude` on pull requests; it is not the gate.
- **A `pull_request` workflow per dataset that calls the central one.** The shims already do this for
  validation. Rejected for a model call: an author controls that workflow's text on their branch.
- **Neutral for "could not decide".** Counts as passing for a required check. Rejected.
- **Let the model return the verdict.** The one field an injected instruction would target.
- **Count every push as a rejection.** Punishes iteration; one bad pull request pushed five times
  would be five strikes.

## Before it is switched on

1. Subscribe the NEMAR App to Pull request events, and grant Pull requests: write (for the comment).
   Until then no event arrives, so the feature is inert whatever `PR_REVIEW_ENABLED` says.
2. Set the four `ANTHROPIC_*` organization variables on `nemarDatasets`, and check the federation
   rule accepts only `repo:nemarDatasets/.github:ref:refs/heads/main` for this workflow.
3. Deploy `run-pr-review.yml`, then add it to the `unit-pure` sparse checkout with
   `NEMAR_PR_REVIEW_WORKFLOW_LIVE` so the parity test stops skipping.
4. Release this change to production. The flag is already on in `[env.dev.vars]` of
   `backend/wrangler-sccn.toml` (the soak target) and absent from `[vars]`, so production is dark. Once
   the soak below has passed, add `PR_REVIEW_ENABLED = "1"` to `[vars]`; that is a change to the file, so
   it ships in the next release. The variable lives in that file and not in the dashboard, so a deploy
   never drops it and turning the review on is a reviewed change. The flag stops new reviews only: the
   watchdog and the republish pass run regardless, so switching it off never strands a check that is
   already in flight.
5. The first live run is made on the dev Worker alone. The production Worker forwards `pull_request`
   events for the datasets dev owns (the `xx09*` datasets and the fixture `nm099998`) to it before its
   own handler runs (`DEV_WEBHOOK_MIRROR_URL`). A dataset is reviewed only while it is public, named and
   first-published, so the target is a published `xx0999NN` exemplar of the dev fleet (check that its
   `first_published_at` is set); `nm099998` is an anonymous deposit and `nm099999` is private and
   production's, so neither is ever reviewed. With the workflow deployed and the App subscribed, a
   throwaway pull request to such an exemplar exercises the claim, the federated identity, the model call
   and the check, and production stays dark. Read the Actions log of that run (`nemarDatasets/.github` is
   public) before turning anything on for real datasets.
6. A pull request that is already open when the review is switched on produces no event, so the Worker
   never sees it until its author pushes again. `nemar admin pr-reviews start --all` starts those (and
   `start <dataset> <pr>` one), see the amendment below. Run it once, after the trial has passed.

## Open items found in the release review (2026-10-10)

None blocks shipping the review switched off. Decide the first two before it is switched on.

- **The administrator's merge refuses a pull request this check holds.** ADR 0093 attempts a merge only
  when GitHub reports `clean`. The `NEMAR PR Review` check is not required, and a non-required check
  that is not passing is expected to be reported as `unstable` (from GitHub's definition of the state;
  not yet observed). So for an `uncertain`, `declined` or `errored` review, `approve --merge` and `y`
  in `next` would record the approval and then print "Not merged: GitHub says it cannot be merged
  cleanly (a check is failing). The approval stands." Either accept `unstable` when both required checks
  pass (the merge call still enforces the ruleset, and no bypass is used) or say in ADR 0093 that these
  are merged by hand.
- **`nemar dataset update --monitor` waits for every check**, this one included, and stops on a non-pass.
  That is the right signal for a contributor, but it means a pull request the review holds is not offered
  the merge. Installed older CLIs behave the same.
- **Declines are check and comment writes on the datasets token without a cap of their own.** Past the
  allowances every pull request from a stranger gets a decline check, and a flood from many accounts is a
  proportional number of writes on the token that publication and enrichment also use.
- **An administrator's own pull request cannot be approved from `next`.** GitHub refuses a self-approval
  with 422; `y` is offered, fails and is counted as failed.

## Amendment 2026-10-10: a review can be started by name, and a restart is held to the gate

The Worker reviews on events, and a pull request that was open before the review was switched on
produced none. `POST /admin/pr-reviews/:dataset/:pr/start` (`nemar admin pr-reviews start`) asks for
one. The Worker reads the pull request from GitHub with the datasets token, so nothing about it comes
from the caller, shapes it as the `pull_request` delivery it would have been, and hands it to the one
gate every delivery goes through: the flag, the "public, named, first-published" test, the per-commit
dedupe, the contributor pause and the platform's daily pool all apply. Two things differ, both the
administrator's choice made by name. The per-contributor hourly and daily allowances do not hold that
review back (they exist to bound outsiders). And a commit whose review ended without a verdict
(declined, errored, never reported, or handed to GitHub more than `PR_REVIEW_DEADLINE_MINUTES` ago and
never answered) is started again; one that is running or has a result is not. A new delivery of the
same commit still restarts nothing but a dispatch GitHub did not run.

A restart is held to the gate like a new row. A contributor who is paused is declined, and the
platform's pool is asked again with the row ranked as the newest: it keeps its old id, which the cap
queries (`id <= ?`) would otherwise count ahead of every later row. The redelivery of a failed
dispatch goes through the same restart, so it is held to the pause and the allowances too.

The pool counts model calls, not rows. Migration 0095 adds `pr_reviews.attempts` (1 for every existing
row), the pool sums it, and a restart of an attempt that had already spent a call adds one when the
restart is handed to GitHub. A decline, a stale head and a dispatch GitHub never ran spent none. So a
review restarted three times is three calls against the pool, not one.

A start that is handed to GitHub writes an audit row (`pr_review_started`), best effort: a review that
is already running is not reported as an error because its audit row could not be written. A start the
gate declines changed nothing and writes none. The start cannot approve or merge: it makes the same
dispatch, check and comment calls any review makes, and a test asserts that no other GitHub call is
made.

`start --all` lists the open pull requests with no review of their current commit (the queue's
`not_reviewed` and `could_not_decide`), leaves drafts out, asks before spending (each is one model
call), and starts them one at a time. A paused contributor's pull request is declined by the Worker
like any other and said so in the output; `allow` lifts the pause and the same command then starts it.
It stops when the daily pool is spent and exits 1, so a script knows some were not tried.
Run it once, in the environment where the review is on, after the trial has passed.

## Receipts

- Contract and tests: `shared/pr-review.ts`, `test/pr-review.test.ts`.
- Worker: `backend/src/services/pr-review.ts`, `backend/src/routes/callbacks/pr-review.ts`,
  migration 0092, `backend/test/pr-review-flow.test.ts`.
- Job: `scripts/ci/pr-review*.ts`, `.github/dataset-workflows/run-pr-review.yml`,
  `test/pr-review-evidence.test.ts`, `test/pr-review-workflow.test.ts`.
