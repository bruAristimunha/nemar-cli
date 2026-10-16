# ADR 0107: Dataset pull requests are screened on content, owners and administrators are exempt, and the review check is required on reviewable datasets

**Status:** proposed
**Date:** 2026-10-16
**Owner:** Seyed Yahya Shirazi

Partially supersedes [ADR 0092](0092-dataset-pull-requests-get-a-derived-verdict-from-a-worker-gated-model-review.md) and [ADR 0093](0093-pull-requests-awaiting-approval-are-managed-from-one-admin-command-and-an-approval-is-the-administrators-own.md).
What it replaces is listed under "What this supersedes".
The Worker as the gate, the per-commit row, the one-shot claim, the derived verdict and the administrator's own approval all stand.

Follows ADR 0048 (account kinds), ADR 0053 and ADR 0086 (unknown is never clear), ADR 0020 (a workflow edit reaches ~785 repositories at once).

This ADR records the decisions of epic #1813.
Two phases are built so far: the exemption with the `exempt` queue verdict and its CLI wording (#1814), and the removal of the counts, which is the caps, the platform's pool and the automatic tally pause, with a volume line in the admin list (#1815).
The rest is decided here and built by the later phases; until they ship, the three-question review of ADR 0092 is what runs.
The removal of the counts is released only together with the stage-1 screen, so that spend is never left without a bound.

## Context

The automated review of ADR 0092 was built to be advisory, and it is about to become a required check.
Three findings from the epic's planning pass (read-only queries of production D1 and GitHub on 2026-10-16, not re-measured when this ADR was written) say it cannot become one as it stands.

- **It declines the people it should never decline.**
  A pull request opened by an operational administrator account was declined on the per-author daily cap (production review 208).
  That account's organization membership is private, which GitHub reports to the App as `author_association` `CONTRIBUTOR`, so it sat on the stranger tier (3 an hour, 6 a day) and not the trusted one.
  The membership being private was re-checked against the organization's public members list; the decline was read from the production table.
- **The tally pause would lock out a main data author.**
  The queries found a prolific data author paused by the tally, with 163 `contributor_paused` declines against 6 reported reviews.
  With the check required, a paused contributor could never merge.
- **The false-fail question ADR 0092 left open is real.**
  The same queries found 2 of 36 reported reviews passing, and nearly every fail was `advances_revision` (a CHANGES entry missing or the version not advanced).
  The code side of that was checked in the source: `nemar dataset update` writes no CHANGES entry.

Two more facts shape the exemption.
The planning pass found an operational account in production that names a GitHub login no one has registered (GitHub answers 404 for it, re-checked), so a login match alone would exempt whoever registers it.
And the review only ever sees a pull request's text and metadata, so a count of how many someone opened says nothing about whether this one is spam.

## Decision

**A pull request is judged on what it changes and what it says, not on how many its author has opened; NEMAR owners and administrators are exempt by identity; and the review check is required on every reviewable dataset.**

### 1. Owners and administrators are exempt, by identity

- **A GitHub login is exempt when it is the `github_username` of one live NEMAR account that is approved, holds the role `owner` or `admin`, and is of kind `person` or `service`.**
  The match ignores case, as GitHub does.
  Kind `test` is never exempt (ADR 0048): a test persona is a person's secondary account and not a real identity, so no role it is given makes its pull requests skip the review.
  One function, `isReviewExempt` in `backend/src/services/pr-review-exemption.ts`, decides, and no login is written anywhere in the code.
  Nothing stores the answer: every delivery reads `users` again, so a demotion, a revocation or a deletion ends the exemption on the next pull request.
- **The exemption also requires GitHub to report `admin` permission for that login on that repository.**
  It is asked only after a role match, and any error, timeout or missing permission means not exempt, so the review runs, which is safe.
  A NEMAR account can name a login nobody holds or a login the person has since renamed, and the role match alone would then exempt a stranger.
  It is the only part of the rule that calls GitHub.
- **A delivery is exempt only when the pull request's author is exempt AND whoever caused the delivery is the author or exempt in their own right.**
  GitHub names that person as the event's `sender`.
  It applies to a push, a reopening and a marking as ready alike: anyone with write access can push to an owner's branch, close and reopen the pull request, or take a draft out of draft, and what they put in front of the review must not pass because the pull request carries another name.
  A delivery that names no usable sender is reviewed.
  An administrator's start has no sender (its payload is GitHub's own record of the pull request, built by the Worker) and is judged on the author alone.
  The owner confirmed this check for a push, and on 2026-10-16 confirmed applying it to every action.
- **An exempt pull request gets one completed `skipped` check and no review.**
  The title says the review is not required for an owner or administrator, and the text says skipped is not a pass.
  No row is stored, no model is called, nothing is dispatched, and no comment is made.
- **That applies only to a commit no review has touched.**
  A commit that has a row keeps what its review said, whoever acts on it next: the author reopening the pull request, a force-push back to it, or an administrator's start.
  A row means someone put the commit through review (a stranger's push to an owner's branch, or an author who was not exempt yet), `skipped` counts as passing for a required check, and writing it over a failed or undecided review would erase a verdict nobody exempt gave.
  An exempt author who wants such a commit through pushes a new commit, which is exempt in its own right.
  An administrator's start of such a commit, and an exempt author's own redelivery of one whose dispatch failed, are handled like anyone's: a review is started again if the earlier one ended without a verdict, and a block on the author holds it back.
- **`skipped` does not break "unknown is never green" (ADR 0092, ADR 0053, ADR 0086).**
  GitHub counts `skipped` as passing for a required check, which is why ADR 0092 kept it out of `conclusionOf`.
  It is now the conclusion of exactly one outcome, `exempt`, and of no other, and a test pins that.
  An exempt pull request has no unknown in it: nothing was asked of a review.
  A review that ran and could not decide is still `action_required`.

### 2. No count decides whether a review is spent

- **The per-author hourly and daily allowances and the platform's daily pool are removed as reasons to decline a pull request.**
  A stage-1 screen (below) bounds the cost of spam instead, and an Anthropic workspace spend limit is the hard backstop.
  The historical words `rate_limited` and `daily_limit` stay readable in stored rows and are never produced again; no migration.
  A stored row with one of them renders as "Not reviewed" with a sentence that says the limit no longer exists and what to do now: push a new commit, or ask an administrator to start the review.
  `start --all` no longer stops when a daily pool is spent, and its JSON no longer carries `not_tried`.
- **An administrator's explicit `block` still declines, and `allow` only clears a block.**
  The tally stays as information in `standing`.
  A delivery is judged in this order: exempt, then a block, then the review.
  A block on an owner's or administrator's account therefore changes nothing for a commit no review has touched, and a restart of a review already on record is held to the block like anyone's.
- **The automatic tally pause (more than 5 rejected and more than 10 percent) is removed.**
  The owner confirmed this, and phase P2 removed it.
  `contributor_paused` is still the word a block writes.
  Rows written while the pause was automatic hold the same word, so its copy does not say who paused the contributor.
  The standing answer no longer carries `by_record` or `thresholds`, which described the rule that is gone.
- **The admin list carries a volume line.**
  For the last 24 hours and the last 7 days it gives the review records created, the model calls they cost (the sum of their attempts, leaving out a decline and a run that never reached the model), what they came to, and the declined ones by reason word.
  It informs and never blocks: nothing reads it to decide whether a pull request is reviewed, and a volume that could not be read is said so and is never shown as zero.

### 3. Two model calls, at the highest effort Haiku 5.5 offers

- **Stage 1 sees metadata only**, with the pull request's text fenced as untrusted, and can reject only spam, vandalism or a change with no plausible purpose.
  When unsure it proceeds.
  A reject, or a steering attempt, ends the run with a screen report; stage 2 is never called and no file content is read.
- **Stage 2 reads the content and answers five questions**: nothing lost, the revision advances, materially better, a clear title and description, and a description that is not misleading.
- **The verdict stays derived.**
  The model never writes it, a fact can lower an answer and never raise one, and a screen report can never pass.
  Both calls use `claude-haiku-5-5` at effort `max`, streamed, with per-stage token budgets and a job timeout that sits inside the Worker's deadline; a test checks the inequality.

### 4. Titles and descriptions must be meaningful, and an edit re-runs the review

- A placeholder or template title, a description that is gibberish or placeholder text, and a title that does not describe the change are blockers.
  An incomplete or slightly inaccurate description passes with a note, and a misleading one is a blocker the author fixes by editing it.
- Editing the title, the body or the base re-runs the review and supersedes a running one.
- An empty description is a blocker decided by a git-free fact, not by the model, and `nemar dataset update` requires a title and a description and writes the CHANGES entry for the version it creates.
  The owner confirmed both.

### 5. The review check is required on reviewable datasets, through its own ruleset

- **A separate ruleset, "NEMAR PR review required", requires the `NEMAR PR Review` check from the NEMAR App.**
  It is not a third required check inside "NEMAR branch protection": that ruleset is gated on BIDS validation, is missing on most public repositories, and adding the repository-admin role to its bypass would also bypass the BIDS and version checks.
- **The bypass is the NEMAR App (the enrichment workflow pushes to `main` with its token), organization administrators, and the repository `admin` role.**
  Maintainers and outside collaborators get none.
  The `dataset-admin` team is the GitHub side of "admin"; org owners manage it and NEMAR code does not.
- **It is applied to exactly the datasets the Worker reviews** (active, public, named, first-published), removed when a dataset stops being one, and refused while `PR_REVIEW_ENABLED` is not `1`.
- **A pull request whose required review failed is merged in the GitHub UI by an owner or administrator.**
  The CLI never uses the bypass (ADR 0093 stands), and its message says so.

### 6. Rollout is its own gated step

- The workflow's timeout, wording and install order (after the token is minted, with `--ignore-scripts`, as the publication review's workflow does) change first and are mirrored to `nemarDatasets/.github`, because the parity test makes any edit a two-repository change.
  Every dispatch, staging included, runs `main`'s script, so the new reviewer cannot run on staging before a release.
- There is therefore no staging soak.
  After the release the new review runs in an advisory shadow mode on production pull requests, and the check is made required only after the shadow run and the calibration gate.
- The calibration gate, approved by the owner: no false pass on a blocking problem; at most 10 percent false fails among the pull requests labeled pass; no stage-1 reject of a legitimate pull request; no steering flag on a legitimate pull request.
- The production canary is a data author's account named in the epic, and its pull requests exercise the gate first.
  No dataset is special-cased (more than 900 are live): every reviewable dataset is in scope, applied in batches, with a dry run as the default and an explicit apply flag.
- The workspace spend limit is $175 a month.
  Setting it is the owner's action in the Anthropic Console, and no phase assumes it is set without checking.

## What this supersedes

- **ADR 0092, the second Decision bullet:** the hourly, daily and platform caps and the tally pause.
  The per-commit row and the administrator's block stay.
- **ADR 0092, the reviewer bullet and "The model has no tools and writes little":** effort `high`, and a model that "answers three questions".
  Now two calls, five questions, effort `max`.
- **ADR 0092, "Green and red are real; everything else needs a person":** plus `skipped`, for an exempt pull request alone.
- **ADR 0092, "The check is not required by any ruleset yet", and the Consequences that lean on it** ("acceptable only because the check is not required", "This is why the check is not required", "only matter once the check is required"): the check is required on reviewable datasets, and the risk that a model's false green lets a maintainer merge is accepted, bounded by facts, calibration and re-review on edit.
- **ADR 0092, the accepted risks "Many new accounts" and "Padding the tally":** replaced by the stage-1 cost bound and the workspace spend limit.
- **ADR 0092, the amendment of 2026-10-10:** the allowances and the pool (and so `start --all` stopping when the daily pool is spent), and "A new delivery of the same commit still restarts nothing but a dispatch GitHub did not run", which now has one more exception, an edit.
- **ADR 0093:** `allow` lifting the tally's pause (it now only clears a block); the queue verdicts gain `exempt` (built in phase P1); the two required checks it reads are joined by the review where its ruleset exists; and the `blocked` refusal, whose rule is unchanged, names the review.

## Consequences

- **An owner's or administrator's pull request is not held by the review, and anyone else's is reviewed on its content.**
  The queue calls the first `exempt (owner or admin)`, so nothing offers it to an administrator to review by hand, and a review of the current commit still wins over that word.
- **An exempt pull request has no row.**
  There is no history to show and nothing for the watchdog to publish again.
  A check that cannot be published is thrown and the webhook answers 500, so the delivery shows as failed in the App's delivery log and can be redelivered.
  A redelivery of an exempt commit posts a second `skipped` check of the same name, which is harmless.
  The only record that a commit was exempted is that check and a fixed-word log line (dataset, pull request, commit; no login).
- **A commit an owner pushes on top of a stranger's is the owner's.**
  The exemption judges who caused each delivery, not who wrote each commit, so an exempt account that pushes over someone else's earlier commits vouches for them.
  Those earlier commits may not have been reviewed at all: commits already on the branch when the owner opened the pull request, pushes made while it was a draft, and pushes whose review declined or errored.
  The same holds for an exempt author who marks a draft ready, and for an administrator's start of a pull request whose current commit has no review.
- **A demotion or a revocation does not retract a `skipped` check already posted.**
  It stays valid for its commit until the commit changes, and the next delivery reads the role afresh.
- **An exempt push stores no row, so it does not supersede a review of the previous commit that is still running.**
  That review's late result can rewrite the pull request's review comment, which names the commit it is about; the check on the new commit is unaffected.
- **A review that starts for the same commit between the row read and the exempt publish leaves the commit with two checks of the same name.**
  The window is the length of the permission lookups, only an exempt actor can cause the exempt delivery, and which of the two checks a required check reads is GitHub's rule, not verified here.
- **The `exempt` label is inferred from who opened the pull request, not read from GitHub.**
  It does not prove the check was posted: a publish that fails answers 500 and shows in the App's delivery log, and the queue says nothing about a check it does not read.
- **GitHub's `author_association` is not a reason to exempt or to reject anyone.**
  It reads `CONTRIBUTOR` for a private organization member, so neither the exemption nor the screen uses it.
- **The cross-check costs one GitHub call per role-matched account on a delivery** (two when someone other than the author caused it; one delivery asks about each account once), each bounded to a few seconds.
  An admin queue request asks once per exempt author and dataset, a few at a time and within 20 seconds, and a pull request whose lookup did not run in time is listed as not exempt.
- **An installed CLI older than this change cannot read the standing answer.**
  It reads `thresholds`, which is gone, so `standing` and `show` fail, and `allow`, `block` and `clear` report a failure after the Worker has stored the change.
  A newer CLI against an older Worker shows a pause by the record as a plain pause and not as a block.
  The package publish and the Worker deploy are separate workflows, within minutes of each other, in either order (CHANGELOG, Deploy coupling), so either skew can happen for a few minutes.
  Both are administrators' tools, the Worker itself is unaffected, and the remedy is to upgrade the CLI; the two fields are not kept, because they would describe a rule that no longer exists.
- **Until the screen ships, nothing bounds spend but the workspace limit.**
  Phase P2 removes the counts and phase P3 adds the screen, so the epic's branch must not be released with the first and without the second.
- **Without caps, cost is bounded by the screen and the spend limit.**
  One account pushing every minute to a pull request that passes stage 1 could cost up to about $70 a day at $0.10 and $0.50 per million input and output tokens (the planning pass's estimate, which assumes prompts under 100,000 tokens: above that the price is five times higher, and the review's input caps keep it below).
  Spam that fails stage 1 costs under one cent a pull request.
  The workspace spend limit ($175 a month, the owner's Console action) is what makes that a bound and not an estimate, and when it trips the checks read "Could not decide" and required repositories wait for an administrator.
- **The production canary exercises the gate because it is not exempt.**
  An exempt account cannot, so the canary is a data author whose pull requests are reviewed.
- **A wrong identity match would exempt the wrong person.**
  The tests cover every combination of role, kind, status and deletion, the cross-check closes the unregistered-login hole, and the role is never cached.

## Alternatives considered

- **Exempt by `author_association` (`OWNER`, `MEMBER`).** A private organization member reads `CONTRIBUTOR`, which is the failure this ADR starts from.
- **A list of exempt logins in code or configuration.** It drifts from the accounts, and the dev Worker shares production's users, so a name in code would exempt that name everywhere.
- **Check the sender only on a push.** A reopening keeps the head commit and a draft takes pushes unreviewed, so someone else's commit could be passed by closing and reopening an owner's pull request.
- **Let an exempt author's event turn a reviewed commit's check into `skipped`.** It was the first design, so that a commit reviewed before its author became exempt would carry one current result. A collaborator's push to an owner's branch is reviewed too, and the owner reopening the pull request (or an administrator's start) would then erase its failed review.
- **Store a row for an exempt pull request.** It would put a pull request nobody reviewed into the tally, the queue and the platform's counts, for the one benefit of a watchdog retry.
- **`neutral` for an exempt pull request.** A required check accepts it too, and `skipped` is the truer word: the review did not run.
- **Keep the caps and raise the trusted tier.** It keeps a count deciding whether a person is reviewed, and the count was wrong about who is trusted.
- **Require the review through the existing ruleset.** See decision 5.

## Receipts

- Epic #1813 and its first two phases, #1814 and #1815.
- Exemption: `backend/src/services/pr-review-exemption.ts`, `backend/src/services/pr-review.ts` (`isExemptDelivery`, `publishExempt`), `shared/pr-review.ts` (`exempt`, `skipped`).
- The gate and the removal of the counts (#1815): `backend/src/services/pr-review.ts` (`gateDecision`: exempt, then blocked, then reviewed), `shared/pr-review.ts` (`PRODUCED_DECLINE_REASONS`, `HISTORICAL_DECLINE_REASONS`, `standingOf`).
- The volume line: `backend/src/services/pr-review-queue.ts` (`readVolume`), `shared/contract/pr-review-admin.ts` (`QueueVolume`), `src/commands/admin-pr-reviews.ts` (`volumeLines`).
- Queue and labels: `backend/src/services/pr-review-queue.ts`, `shared/contract/pr-review-admin.ts`, `src/commands/admin-pr-reviews.ts`.
- Tests: `backend/test/pr-review-exemption.test.ts`, `backend/test/pr-review-flow.test.ts`, `backend/test/pr-review-queue.test.ts`, `backend/test/pr-review-start.test.ts`, `test/pr-review.test.ts`, `test/admin-pr-reviews-cli.test.ts`.
