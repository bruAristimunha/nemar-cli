# ADR 0107: Dataset pull requests are screened on content, owners and administrators are exempt, and the review check is required on reviewable datasets

**Status:** proposed
**Date:** 2026-10-16
**Owner:** Seyed Yahya Shirazi

Partially supersedes [ADR 0092](0092-dataset-pull-requests-get-a-derived-verdict-from-a-worker-gated-model-review.md) and [ADR 0093](0093-pull-requests-awaiting-approval-are-managed-from-one-admin-command-and-an-approval-is-the-administrators-own.md).
What it replaces is listed under "What this supersedes".
The Worker as the gate, the per-commit row, the one-shot claim, the derived verdict and the administrator's own approval all stand.

Follows ADR 0048 (account kinds), ADR 0053 and ADR 0086 (unknown is never clear), ADR 0020 (a workflow edit reaches ~785 repositories at once).

This ADR records the decisions of epic #1813.
Built so far, on the epic branch: phases P1 to P6, all of them.
They are the exemption with the `exempt` queue verdict and its CLI wording (#1814); the removal of the counts, which is the caps, the platform's pool and the automatic tally pause, with a volume line in the admin list (#1815); readable pull request text from the CLI (#1818); the two-stage review with report version 2, the naming rule and its one override (#1816); the re-review of a pull request when its title, body or base is edited, or it is reopened or marked ready, with a cap of five such restarts for one commit (#1817); and the tooling for the required check, which is its ruleset, the routes and `nemar admin fleet require-review` that apply it, the drift report and the switch that keeps the automatic paths from adding it (#1819).
The required check is not switched on: the switch that lets the automatic paths add it, `PR_REVIEW_AUTO_REQUIRE`, is absent from the Worker's configuration file, and decision 6 says what has to be done before it is.
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
- **An exempt pull request gets one completed check and no review, and the naming rule (decision 3a) decides which check.**
  The check is `skipped` when the rule finds nothing on the commit, or when an administrator has waived it for that commit.
  The skipped title says the review is not required for an owner or administrator, and the text says skipped is not a pass.
  When the rule refuses the title or the dataset's new name the check is a failure, and when the dataset's name could not be read it is `action_required`, a check that needs a person and does not pass, whatever the title says: nothing can be waived while the name is unread, so the check, the answer of a start and the list's label all say that the name has to be read first.
  No row is stored, no model is called, nothing is dispatched, and no comment is made.
- **That applies only to a commit no review has touched.**
  A commit that has a row keeps what its review said, whoever acts on it next: a force-push back to it, or an administrator's start of a review that has a result (unless it is a `--redo`, [ADR 0093](0093-pull-requests-awaiting-approval-are-managed-from-one-admin-command-and-an-approval-is-the-administrators-own.md), amendment of 2026-10-24).
  The exceptions are the deliveries that change the text the review judged: an edit of the title, the body or the base, a reopening and a marking as ready restart the review of a commit that has a row, whoever caused them and an exempt author included (decision 4).
  What takes the place of the stored result is a review that runs again, never `skipped`.
  A row means someone put the commit through review (a stranger's push to an owner's branch, or an author who was not exempt yet), `skipped` counts as passing for a required check, and writing it over a failed or undecided review would erase a verdict nobody exempt gave.
  An exempt author who wants such a commit through pushes a new commit, which is exempt in its own right.
  An administrator's start of such a commit, and an exempt author's own redelivery of one whose dispatch failed, are handled like anyone's: a review is started again if the earlier one ended without a verdict (or has a result, for a `--redo`), and a block on the author holds it back.
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
  For the last 24 hours and the last 7 days it gives the review records created, the review runs they cost (`review_runs`: the sum of their attempts; a run makes up to two model calls), what they came to, and the declined ones by reason word.
  `review_runs` leaves out what is known not to have asked a model: a decline, a run the naming rule ended at the facts stage, a review handed to GitHub that no job has claimed, and an attempt GitHub never ran (`dispatch_failed`) or that was superseded before its claim (`stale_head`).
  It counts every other run as spent, and that is conservative: an errored run is counted whatever its reason, `auth_failed`, `evidence_unavailable`, `too_large` and `workflow_failed` among them, though a run that ended for one of those words may never have reached the model, because the row does not say whether a call was made.
  So the number can be higher than the calls made and never lower, which is the safe way for it to be wrong, since nothing decides on it.
  Each window also sums the tokens of each stage and an estimated cost in dollars at the list prices under Consequences, an estimate for orientation and not a bill.
  Only a version 2 report carries its usage, so only version 2 reports are counted, and the line says how many were: a refusal, a truncation, an earlier attempt of a restarted review and a report from before the screen cost tokens that are not in the sum.
  For example, 30,000 screen input tokens, 60,000 screen output tokens, 380,000 review input tokens and 35,000 review output tokens come to about $1.14 (30,000 x $0.10 + 60,000 x $0.50 + 380,000 x $2 + 35,000 x $10, per million tokens).
  It informs and never blocks: nothing reads it to decide whether a pull request is reviewed, and a volume that could not be read is said so and is never shown as zero.

### 3. Two model calls at the highest effort: a screen, then a review

The owner set the models, the budgets and the prompt on 2026-10-16, after a comparison of `claude-haiku-5-5` and `claude-sonnet-5-5` on labeled pull request text.

- **Stage 1, the screen, runs on `claude-haiku-5-5`.**
  It sees the pull request's text, fenced as untrusted, and the platform's account of which files changed, never a file's content.
  It may reject only spam: promotional content, content unrelated to the dataset, content with no purpose, or repeated links.
  Everything else proceeds, including placeholder or unreadable text, an empty or misleading description and an attempt to steer it, which stage 2 judges; when unsure it proceeds.
  A reject ends the run with a screen report; stage 2 is never called and no file's content is read beyond `dataset_description.json`.
- **Stage 2, the review, runs on `claude-sonnet-5-5`.**
  It reads the content, answers the three questions about the files (nothing lost, the revision advances, materially better), and judges the pull request's text with prompt v3's rules, copied word for word: whether the title and the description say what changed, whether the description misleads, and whether anything steers the reviewer (a claim that someone other than the author approved the change, or text that tells the reviewer what to answer).
- **Both stages run at effort `max` and streamed, the screen with `max_tokens` 32,000 and the review with 128,000 (amendment of 2026-10-20, below)**, each under a deadline for the whole stage (every attempt and the streamed answer together, through an abort signal).
  The screen's deadline is 4 minutes and the review's 30, each with a 5-second grace for the sign-in that takes no signal.
  The worst case adds the other steps, each at its budget: the setup steps 4 minutes (an allowance, because GitHub's own steps bound them and not the script), the evidence passes 3 minutes (60 seconds for the change list and the trees, 120 for the diffs and the change log), and the callback's four attempts of 60 seconds with pauses of 2, 4 and 8 seconds, 4 minutes 14 seconds.
  That is 4 + 3 + 4 min 5 s + 30 min 5 s + 4 min 14 s, which is 45.4 minutes, inside the job's 50, which is inside the Worker's 60-minute deadline (`PR_REVIEW_DEADLINE_MINUTES`); a test (`test/pr-review-workflow.test.ts`) reads the workflow and the script's budgets and checks the inequalities.
- **A refusal or a truncation at either stage is no verdict.** (A truncation of the review now tells the author to split the pull request: see the amendment of 2026-10-20.)
  The check is `action_required`, which does not pass a required check, and its text says a NEMAR administrator needs to look.
- **The verdict stays derived.**
  The model never writes it, a fact can lower an answer and never raise one, and a screen report can never pass.
- **A naming failure ends the review before any model is asked.**
  The review job decides the facts first.
  When the title, or the dataset's changed name, breaks the naming rule (3a), or the changed name cannot be read, the run ends at the `facts` stage: no model is called and no tokens are spent, `models` names none, all six criteria are not assessed, and the report says why in the rule's own sentences.
  The report stage is `facts`, and a facts report can never pass: the parser refuses one that names a model, assesses anything, spent a token, or has no naming fact to explain it.
  The check reads "Needs changes: the naming rule", or "Could not decide: the naming rule was not checked" when the name could not be read and the rule refused nothing, and the author edits the title, which runs the review again (decision 4, within its cap), or fixes the `Name` and pushes.
  The title, the copy under it and the CLI's reason line are all chosen by the naming fact (`factsStop`) and never by the verdict, so they agree: a version that did not advance fails the verdict of a facts report whose name was only unreadable, and that report still reads "not checked" everywhere.
  A refusal beside an unreadable name reads "Needs changes", because the rule found something.
- **A description is read up to 12,000 characters, and a longer one is recorded as cut.**
  Both models are shown the first 12,000 characters of the tidied description and the mark `[cut]`, and the evidence records `description_cut`.
  A cut description cannot pass: `description_not_misleading` is no better than unknown, because whether the rest misleads, or tries to instruct the reviewer, was not assessed.
  A steering finding on the part that was read still fails the review.
  The description is judged as the models read it, so one made of invisible characters is empty.
- **A new version needs a CHANGES entry, and that is a fact.**
  The evidence reader looks for a heading for the new version in the head's change log that the merge base's did not have (`changelog_entry`: `added`, `not_added`, `no_file` or `unknown_version`).
  When there is none (`not_added` or `no_file`) `advances_revision` fails with `changes_log_missing`, whatever a model said; an unknown new version is not this rule's to judge.
  A full report that says nothing about the log is refused, so the rule cannot be skipped by leaving it out.
- **The report is version 2:** its stage, both models, six criteria (the screen's `genuine_contribution`, the three questions, and the two text criteria), the facts, and the tokens each call used.
  The evidence carries exactly five fact keys, and they differ in when they are read and in what they do.
  Four are decided before any model is asked: `description_empty`, `description_cut`, and the naming rule's `title_problem` and `name_problem`.
  The fifth, `changelog_entry`, is read from git after the screen lets the pull request through, so it is null in a screen report and in a facts report, and a full report always has one.
  An empty description, a refused title or name, and a new version with no change-log entry each fail a criterion.
  A description that was cut and a changed name that could not be read only lower a criterion to unknown (`description_not_misleading` and `no_degradation`) and never fail it: nothing was found wrong, it was not assessed, and a person looks.
  A callback must carry version 2; a version 1 report sent by callback is refused as `report_invalid`, a check that needs a person.
  Rows stored before the screen keep their version 1 reports, which are read back by their own rules, so no stored verdict changes.

### 3a. The naming rule runs first, on every pull request

- **A pull request title, and the dataset's new name when a pull request changes it, may not hold a citation, an author and a year or a DOI, anywhere in it, or a naming-template token.**
  The rule refuses an author-year key anywhere in the text: a run of letters, of any case and script, directly followed by an optional single hyphen or underscore and a four-digit year from 1900 to 2099 that does not start a longer number (`Lee2019`, `Lee-2019-EEG`, `BNCI2014_001`, `Results from Zhou-2016 cohort`, `(Mainsah2025_L)`).
  It refuses a DOI anywhere in the text: the characters `10.`, four to nine digits and a slash, which covers a `doi.org` link, a bare `doi:10.1234/x` and a DOI that ends a name in parentheses.
  And it refuses a template token (`FirstAuthorSurname`, `paperDOI`, `{{x}}`, `${x}`, `<your title>`, `[describe the change]`).
  The three are asked in that order, as the closed words `author_year`, `doi` and `template_field`, and a text that breaks several is told about the first.
  An author-year key and a DOI are told to the author in the same plain words, "a citation (an author and a year, or a DOI)", with the advice to cite the paper in `ReferencesAndLinks` and the README instead.
  The letters of a key must touch the year, or the one separator before it, and that is a deliberate boundary: `Release 2019`, `Andreev 2012` and `Add 2019 recordings` are ordinary sentences, and a rule that read a word and a year across a space would refuse every title that mentions a year.
  The price is that a citation typed with a space (`Sawada 2022`) is not caught, and that letters attached to a year (`H2020`, `ses-2019`, `R2019b`) are refused wherever they stand.
  **A calendar version in a title is refused by the author-year rule.**
  `nemar dataset update` sends the author's title with the version after it, `Add subject 03 (v2020.1.1)`, and `nemar dataset release` sends `Release v2020.1.1`; in both, `v2020` is a letter touching a year.
  The CLI asks the rule about the title exactly as it will be sent, before it changes or pushes anything (before sign-in, when the clone's own `dataset_description.json` says which version `update` will release), and the message names that title; before this it asked only about the title as typed, and the review refused the sent one after the push.
  Whether a calendar version should be refused is a question for the owner, who decides if it is wanted: it is refused today because the rule has no exception for a version, and a dataset whose version starts with a year cannot have a pull request opened by the CLI until that is decided or its version changes.
  A description is not held to the rule, so it may cite the paper the way the paper is cited.
  The scan is linear in the length of the text, because a dataset `Name` can be long: it has no repetition that repeats another, and the tests that say so give it texts of hundreds of thousands of characters.
  The name is the `Name` field of `dataset_description.json` at the head, compared with the merge base: a name the pull request did not change is not its problem.
- **One pure function decides, in `shared/naming-rule.ts`**, which the CLI asks about the title it sends before it opens a pull request, the review job asks before any model call, and the Worker asks of a pull request it does not review.
  The CLI asks about the title and nothing else: it does not check a description, and it never asks about a changed dataset `Name`, which only the review job and the Worker read, so a `Name` that breaks the rule is first refused after the pull request is open.
  A refusal fails the verdict whatever a model says.
- **Owners and administrators are not exempt from it.**
  The exemption still skips the review, but the Worker applies the rule first: a refused title or name fails the check, and a name that cannot be read makes it a check that needs a person, never a skip, even when the title is also refused (the title's problem is stated in the check, and the unread name is what decides its conclusion).
- **A name that cannot be read is checked as `unchecked`, and unchecked cannot pass.**
  In the review job, a pull request that changes `dataset_description.json` and leaves a `Name` that is not text or shows a reader nothing (empty, blanks, or only characters nobody sees), or a file that is not JSON, has the finding `unchecked`: the run ends at the facts stage and the check does not pass.
  The Worker, for a pull request it does not review, compares the base with the head and, when the comparison says `dataset_description.json` may have changed, reads the file at the head and at the merge base.
  It asks for a page of 100 commits and believes the comparison's list of changed files only when the answer holds every commit of the comparison (`commits` as long as `total_commits`, both present); a longer comparison, or an answer without the counts, is treated as having no list, so both names are read.
  A head file that is not JSON, has no `Name` that is text and shows something, or is not found where the comparison does not list it as removed is `unchecked`, as in the job.
  A file the comparison lists as removed (or renamed to another name) has no name to refuse, and a removal is not a naming failure.
  The merge base is held to less: no file there, or one with no readable name, means the pull request gives the dataset its first name, and that name is checked.
- **The Worker's reads are bounded, and the bounds are unmeasured on large pull requests.**
  The comparison and the two file reads (made together) are each bounded to 3 seconds.
  GitHub may take longer to compute a comparison for a pull request with many commits or files, and that has not been measured.
  A read that times out makes the name `unchecked`: a check that needs a person, never a pass.
  The reads run inside the webhook's own request, and at their worst the permission lookups (two, 4 seconds each), the comparison (3), the file reads (3) and the check post (5) add up to more than the 10 seconds GitHub gives a delivery; the sum has not been measured either.
  GitHub does not retry a failed delivery by itself, so a delivery that times out or fails is recovered by redelivering it from the App's delivery log, and a redelivered exempt commit posts the same check again.
  The staging step of the rollout (decision 6) measures these durations before the required check is turned on; if they come near the limit, the reads move off the request.
- **The only way past the rule without a change is an explicit override**, `nemar admin pr-reviews allow <dataset> <pr> --admin --reason <why>`, which replaces the exemption for this rule.
  The Worker reads the pull request itself, refuses it for an author who is not exempt (their review includes the rule) and for a commit a review has touched, records the waiver in the audit log (who, the commit, what the rule found as closed words, the reason given; never the title or the name), and then posts a `skipped` check that says the rule was waived.
  The record comes first: if it cannot be written, nothing is posted, and a recorded waiver whose check did not land is posted by asking again.
  The reason is required, because it is what the record keeps: a request without one, or with one that has no plain words left once links, mentions and markup are removed (a letter or a digit must remain, so a link alone or punctuation alone is no reason), is a 400, and nothing is recorded or posted.
  The administrator may name the commit they looked at (`--commit`, the first 7 to 40 characters of its id).
  A pull request that has moved on from it is refused with `head_moved` (409), and nothing is recorded or posted; without a commit the current one is waived, and the answer and the record name it.
  The waiver is for that commit only: a new commit is checked again.
  A name that could not be read is not waived, because a waiver covers only what the rule found.
  Two things cause an unread name and they are cured differently, so every message about it (the check, the answer of a start or an override, and the list's label) says both: GitHub may not have answered, which one more start settles, or the file at the head has no readable `Name`, which the same start will find again, so the file has to be fixed and pushed.
  A contributor's pull request that the rule refuses is fixed by its author, or merged in the GitHub UI by an owner or administrator (decision 5).

### 4. Titles and descriptions must be meaningful, and an edit re-runs the review

- A placeholder or template title, a description that is gibberish or placeholder text, and a title that does not describe the change are blockers.
  An incomplete or slightly inaccurate description passes with a note, and a misleading one is a blocker the author fixes by editing it.
- Editing the title, the body or the base re-runs the review and supersedes a running one (built by phase P4, #1817).
  The Worker takes up an `edited` delivery only when its `changes` object names `title`, `body` or `base`; the keys are read, and what they hold (the text from before the edit) never is.
  Any other edit is ignored.
- **A commit that has a review is started again on the same row, from any state.**
  A running review and a stored result are both superseded.
  The row's nonce is replaced, so the superseded job's token no longer matches: its claim and its report are refused with the 401 any stale token gets, and its report is never stored.
  A job that has not claimed yet spends nothing.
  A job that had claimed is not stopped: it still makes its model calls before its report is refused, so superseding a claimed review costs that run in full.
  The row's verdict and report are cleared (the table keeps them only for a reported row), so the row says running, and the check is meant to go back to running with it, which is what stops an old fail or pass standing the moment the text changes.
  **That last step is unverified against GitHub.**
  The check goes back to running by updating the commit's completed check run to `in_progress`, a transition GitHub's documentation neither allows nor forbids, and no run of it has been read back.
  A restarted check that stays completed would leave the old pass on a required check until the job reports or the 60-minute watchdog decides.
  The Worker does not rely on the transition succeeding: a refused or timed-out update is tried again once, after one second, and if it fails again one error line is logged that names the review and says the old result may still stand on the check.
  The retry sits inside the webhook's own request, so a delivery whose first attempt failed spends at most that second plus the update's own 5-second bound more, and nothing is written to the row about it.
  The staging step (decision 6) settles it before the check is required.
  If GitHub refuses the transition, a restart has to create a new check run beside the completed one, which rests on the same unverified rule as the waiver (GitHub reading the newest run of a name, see Consequences).
  `attempts` goes up by one when the earlier run could have cost a model call, as for any restart, and the answer's reason word is `redispatched_after_edit`.
  A review that was handed to GitHub and never claimed could not have cost one, so several quick edits before the job starts are still one run.
  A contributor an administrator has blocked is declined again, as for any restart.
  An administrator's `start --redo` uses this same restart for a finished review (ADR 0093, amendment of 2026-10-24); it never supersedes a running one and leaves the count of a finished review as it is.
  The restart is tried against the row as it is now.
  If a result or the watchdog's verdict lands between the Worker's read of the row and its write, the write finds nothing to change, and the edit is tried again on a fresh read, up to three times in all, so it is not dropped for having lost that race.
  A reopening and a marking as ready are retried the same way.
  If the row moves under all three tries, which takes another writer moving it three times in a row, the stored result is restated and the change is dropped; that stays as designed, because the limit is what keeps a row that keeps moving from holding the webhook.
- **A reopening and a marking as ready restart it too.**
  An edit made while a pull request is closed or a draft is not taken up (it is not open, or is a draft, as for any delivery), so the stored review of its commit would keep judging text the pull request no longer has.
  The first delivery that follows is the reopening or the marking as ready.
  On a commit that has a row it restarts the review from any state, the same way an edit does, by anyone and an exempt author included, held to the same gate (a block still declines it) and counted toward the same cap below.
  Its reason word is the plain `redispatched`.
  Of the deliveries, only a push (a force-push back to a reviewed commit, say) changes no text, so it alone still restates what the review said.
- **A commit with no row is a new delivery, and a commit with a row is restarted.**
  An owner's or administrator's new delivery takes the exempt path: a new `skipped` check, or the naming rule's verdict on the new title, because the Worker reads that title from the delivery.
  Editing a refused title on such a pull request therefore posts a new `skipped` check beside the failed one.
  That clears the failure only if GitHub reads the newest check run of a name, which is GitHub's rule and is not verified (see Consequences).
  An edit made by someone who is not exempt is reviewed, the rule for any delivery someone else caused.
  An exempt author's edit on a commit someone else pushed is a commit with a row, so it restarts that review, as a reopening or a marking as ready does.
- **A base that is not `main` is not reviewed.**
  The delivery describes the pull request as it is after the edit, so a base moved off `main` is answered `not_main` and the commit's review is left as it was.
  An edit that moves the base onto `main` is handled like any other: a commit without a row is a new delivery, and a commit with a row is restarted.
- **The review judges the current text because the job reads it when it starts.**
  The workflow reads the pull request from the API when a run starts (`--pr-json`), and the title and the body come from that read, so the run an edit starts reviews the edited text and the one it superseded can no longer report.
  A redelivered edit starts the review once more, and counts.
- **Five restarts caused by a change of the text are allowed for one head commit, and the sixth is refused (the owner, 2026-10-19).**
  The count is `pr_reviews.edit_restarts` (migration 0099).
  It goes up by one at each restart an edit, a reopening or a marking as ready causes, from 0 at the commit's first row.
  A restart is counted in its own write, before its dispatch, so a restart whose dispatch then fails counts, and so does a redelivered edit: the conservative way to be wrong, and a race-safe one.
  What adds nothing is a commit with no row (a new delivery), a restart that lost a race and was tried again (it counts once), a restart a block declined (a decline is no run), and a push that restarts a review whose dispatch failed (it changes no text).
  A restart whose earlier run ended at the facts stage (a refused title) costs no model call, but it counts toward the five like any other, because the count is of changes of the text and not of calls.
  So an author who fixes a refused title in steps reaches the cap after five edits, and then needs a push or an administrator's start.
  That is the current behavior, and the owner decides whether naming refusals should be exempt from the count.
  An administrator's start resets the count to 0 when it starts the review again; a start that a block declines does not.
  `start --all` therefore leaves a capped commit out, because starting it lifts the cap, which a bulk start must not do unasked; an administrator starts it by name and so means it.
  Its text output lists the commits it left out, each with the command that starts it, and its JSON carries them in the `capped` array (the dataset, the pull request number and the author's login of each), beside `drafts` and `truncated`; `src/commands/admin-pr-reviews.ts` (`startAll`) builds both.
  A push is a new commit with a new row, so it starts at 0.
  The cap comes after the gate, so a blocked contributor is declined and is never told "too many edits".
  The sixth change is refused and not restarted, and the refusal fails closed.
  The row becomes an errored review with the detail `edit_limit`, whatever state it was in, a running review and a stored pass or fail included, because a result that judged the text from before the edit must not stand for the commit.
  Its check is the same one, now `action_required` and titled "Could not decide: too many edits", the comment says the same, and both name the way out: a push, or an administrator's start.
  Every later edit, reopening or marking as ready, and a repeated push of the commit, only restates the refusal, and nothing is dispatched.
  The word `edit_limit` is the Worker's alone, so a job's callback that names it is `workflow_failed`.
  A refusal whose publish fails is published again by the watchdog's sweep like any unpublished result, and is never marked `unreported`, because the sweep that does that looks only at running reviews.
  A reopening and a marking as ready are counted with edits because a close-and-reopen cycle costs what an edit does and would otherwise be unbounded.
  The owner's decision named edits, so counting them is a reading of it, which stands until the owner confirms or reverses it.
- **A publish is checked against the row once GitHub has answered, so a slow write cannot leave a stale check.**
  A callback can store a pass and start updating the check, the sixth edit can refuse the row and publish the refusal, and the callback's slower update can then land last, so GitHub would show a pass for a row that says a person is needed.
  After the check or the comment is acknowledged, the Worker reads the row again, and when it no longer stands for what was published (its state, decision time, verdict, reason or report moved) it publishes what the row says now, three publishes at most in all.
  `published_at` is stamped only while the row still has the state and decision time that were published, so a result that moved on is not marked as shown and the watchdog's republish sweep, which looks for the unstamped, corrects it; after the third publish the row is left unstamped for the same reason.
  Every publisher goes through that one function (the callback's store, the refusal, the running check, a decline and the sweep), so every one of them has it.
- **The comment can lag the check, and a superseded run is in no token total.**
  A running review publishes its check only (the comment is written when an outcome is decided), so the pull request's comment keeps the text of the last completed review until the new result lands, while the check already shows running.
  The check is what the commit shows and what a required check reads.
  The report of a superseded run is never stored, so the volume line's token and cost sums leave it out, as they leave out any earlier attempt of a restarted review (decision 2).
  Its run is in `review_runs`, through `attempts`, when it had claimed.
- **Re-review on an edit is a condition of the required check (decision 5).**
  Without it a pull request could be held by text it no longer has, or passed by text that has since changed, so it is built before the check can be turned on.
- An empty description is a blocker decided by a git-free fact, not by the model, and `nemar dataset update` requires a title and a description and writes the CHANGES entry for the version it creates.
  The owner confirmed both.

### 5. The review check is required on reviewable datasets, through its own ruleset

- **A separate ruleset, "NEMAR PR review required", requires the `NEMAR PR Review` check from the NEMAR App.**
  It is not a third required check inside "NEMAR branch protection": that ruleset is gated on BIDS validation, is missing on most public repositories, and adding the repository-admin role to its bypass would also bypass the BIDS and version checks.
- **The bypass is the NEMAR App (the enrichment workflow pushes to `main` with its token), organization administrators, and the repository `admin` role, and the id of that role is unverified.**
  Maintainers and outside collaborators get none.
  The `dataset-admin` team is the GitHub side of "admin"; org owners manage it and NEMAR code does not.
  The ruleset names the role by its id, 5, and GitHub's ruleset documentation lists no role ids.
  The 5 comes from the Terraform GitHub provider's documentation (admin 5, write 4, maintain 2) and nothing has read it back from GitHub, so which role the bypass reaches is not known.
  A wrong id would hand the bypass to Maintain or Write in place of Admin.
  The first apply, on a dev-owned exemplar and before any other repository gets the ruleset, reads it back: the ruleset is fetched through GraphQL and must show exactly one `RepositoryRole` bypass actor whose role name is `admin`.
  If it names another role, the ruleset is removed and the id is corrected before anything else is applied.
  The query is in the comment on `REPOSITORY_ADMIN_ROLE_ID` in `backend/src/services/github/branch-protection.ts`, which says the same.
- **It is applied to exactly the datasets the Worker reviews** (active, public, named, first-published), and removed when a dataset stops being one.
  Apart from the standing test fixtures, which the tooling never touches in either direction, only a live request to REQUIRE it is ever refused, and for three reasons.
  The review is off in this environment (`PR_REVIEW_ENABLED` is not `1`), so nothing would post the check and requiring it would block every merge (a 409, `review_disabled`).
  Or the Worker's GitHub App is not the one the ruleset names: the ruleset requires the check from App 3679074, and the Worker posts it as the App in its `GITHUB_APP_ID`, so unless that is exactly `3679074` the check never arrives (a 409, `review_app_mismatch`, in a sentence that names both ids and says whether the binding is unset, is not a number, or holds another id; a dry run prints them too).
  Or the Worker cannot sign in as that App for `nemarDatasets`: it posts the check with an installation token, and when the App's private key or its `nemarDatasets` installation id is missing or malformed it falls back to the administrator's personal access token, which GitHub does not let post a check run, so the check never arrives however right the id is (a 409, `review_app_not_configured`; a dry run says so too).
  A removal is never refused for any of these reasons, because taking the ruleset off is the way out.
  The test is the intent a dataset's row works out to and not the shape of the request: a live request for a private dataset is a removal and goes through, and a page of datasets applies its removals and refuses its require rows one by one.
- **The paths that act on their own wait for the owner's switch, `PR_REVIEW_AUTO_REQUIRE`, to ADD the requirement.**
  Publishing a dataset, a visibility change and the enforce routes put the review ruleset on a repository only while the switch is exactly `1`, `PR_REVIEW_ENABLED` is exactly `1` too, the App ids agree, and the Worker can sign in as the App.
  Otherwise a reviewed dataset's review ruleset is left as it is and they make no review-ruleset call for it (the branch and tag rulesets are written as before); when the Worker cannot post the check as the App they also log why.
  The switch does not gate a removal: a dataset that is not reviewed has the review ruleset taken off whatever the switches say, so a dataset made private while the switch is off does not keep a ruleset that nothing will satisfy.
  The review runs from the day the Worker is deployed, so without a switch of its own the first publication or enforce run after a deploy would require the check before the canary and the calibration gate.
  The owner turns it on when the fleet step starts, after both, and it is never on before; it is absent from every vars block of the Worker's configuration file until then, and a test says so.
  That test reads the file and nothing else: the switch can also be set as a Worker secret, which survives a deploy and does not show in the file.
  So the single and the bulk review-ruleset routes answer with `auto_require`, which is what the Worker itself reads, and a dry run of `nemar admin fleet require-review <dataset-id> --json` shows it.
  The explicit tools, the review-ruleset routes and `nemar admin fleet require-review`, do not read it: the canary and the fleet are applied with them, a dry run first.
  A fleet rollback has four steps, in this order, and a removal is allowed whatever the switches say.
  (a) Start the removal while the switch is still on: `nemar admin fleet require-review --all --remove --apply` does ONE page (25 datasets by default, 50 at most) and prints a `Next page:` line instead of looping, so repeat it with `--after` set to the last id of the page just done, until the output has no `Next page:` line.
  (b) Dry run the same pages (the same command without `--apply`) and expect no row that would remove.
  (c) Turn the switch off through a release: the next deploy replaces the Worker's variables with the ones in the configuration file, so a change made in the dashboard does not last.
  A switch that was ever set as a Worker secret is deleted as a secret instead, because a secret survives a deploy.
  (d) Repeat (a) and (b) once more, to catch the datasets that were published or changed between the first pass and the release, because the automatic paths can put the requirement back until the release lands.
  `PR_REVIEW_ENABLED` itself is not turned off while any repository carries the ruleset: every pull request there would wait for a check nothing posts.
- **A pull request whose required review failed is merged in the GitHub UI by an owner or administrator.**
  An owner does it through the organization administrator bypass; an administrator who is not an owner depends on the repository `admin` role's bypass, whose role id is unverified until the first apply is read back.
  The CLI never uses the bypass (ADR 0093 stands), and its message says so: it names what can block a merge (the BIDS validation, the version check, the review) and names the review check, and no other, as the one an owner or administrator can override in the GitHub UI, and only where its ruleset is in force.
  That is what the message names and not all that GitHub allows: an organization owner also bypasses the "NEMAR branch protection" ruleset, which carries the BIDS validation and the version check, and the message does not point anyone at it.

### 6. Rollout is its own gated step

- The workflow's timeout, wording and install order (after the token is minted, with `--ignore-scripts`, as the publication review's workflow does) change first and are mirrored to `nemarDatasets/.github`, because the parity test makes any edit a two-repository change.
  Every dispatch, staging included, runs `main`'s script, so the new reviewer cannot run on staging before a release.
- There is therefore no staging soak of the reviewer: its screen and its review first run on production, in an advisory shadow mode on production pull requests after the release, and the check is made required only after the shadow run and the calibration gate, with the re-review on an edit (decision 4, phase P4) built before either.
- The Worker's side is soaked on staging, as a rollout step of its own.
  The dev Worker deploys from `dev` with the epic, before the release, and the exempt path never dispatches, so a pull request opened by an administrator against a dev-owned exemplar exercises the naming rule's reads, the check posted for it and the override on staging.
  That step verifies three statements of this ADR and no others: how long the naming rule's GitHub reads take against the ten seconds GitHub gives a delivery (decision 3a); that GitHub reads the newest check run of a name, which is what lets a waiver release a required check (Consequences); and that GitHub lets a completed check run be updated back to `in_progress`, which is what a restart does to take an old result off the check (decision 4).
  The third is settled by restarting a review whose check run has completed on a dev-owned exemplar, with an edit of the title, and reading the check run back from GitHub.
  The first apply of the review ruleset, on a dev-owned exemplar, is done in the same step, and it reads the repository `admin` role's id back (decision 5); no other repository gets the ruleset before that read-back shows the role named `admin`.
  It is done before the check is made required, and until it is done the three statements and the role id stand as unverified.
- The calibration gate, approved by the owner: no false pass on a blocking problem; at most 10 percent false fails among the pull requests labeled pass; no stage-1 reject of a legitimate pull request; no steering flag on a legitimate pull request.
- The production canary is a data author's account named in the epic, and its pull requests exercise the gate first.
  No dataset is special-cased (more than 900 are live): every reviewable dataset is in scope, applied in batches, with a dry run as the default and an explicit apply flag.
- The workspace spend limit is $175 a month.
  Setting it is the owner's action in the Anthropic Console, and no phase assumes it is set without checking.

## Amendment of 2026-10-20: the review is given the model's whole output ceiling, and a change repeated across files is read once

**What was measured.**
The first day of the shadow run on production (the release of 0.10.20 was deployed at 2026-10-20 00:12 UTC) produced nine reviews on open pull requests of the canary account, read from GitHub's check runs.
Seven ended `model_truncated` ("the reviewing model ran out of room"), two failed correctly (the version had not advanced), and none passed.
The public log of a truncated run shows the review stage running for about five minutes before the error, which is 32,000 output tokens at roughly 100 tokens a second: the review's thinking at effort `max`, not its small JSON answer and not its input (the diffs are capped at 80,000 characters), filled the budget.
With the check required, a pull request in that state could not merge without an administrator's bypass, so the required check could not be turned on.

**Decisions.**

- **The review stage gets the model's whole output ceiling: `max_tokens` 128,000** (`claude-sonnet-5-5` allows 128,000 output tokens; 300,000 is not available as an output budget).
  The screen stays at 32,000: no screen has been seen to truncate, and its deadline is 4 minutes.
- **The deadlines grow to fit the ceiling.**
  At the one rate observed, about 100 tokens a second, 128,000 tokens take about 21 minutes.
  The review's deadline is 30 minutes, so the model can decode as slowly as about 71 tokens a second and still reach its ceiling (a test keeps the break-even rate under 75): a stage that runs out of time before it runs out of tokens ends `model_unavailable`, which names no size, advises no split and bills the tokens spent.
  The job's `timeout-minutes` is 50 (in both `nemarOrg/nemar-cli` and `nemarDatasets/.github`, where the parity test makes it a two-repository change) and the Worker's `PR_REVIEW_DEADLINE_MINUTES` is 60.
  The worst case is 45.4 minutes (decision 3), inside 50, inside 60; the fallback reporter, which runs only after the script has failed, adds up to about three more.
  A check can now stay `running` for up to 50 minutes on a pull request that uses all its room.
  A stage that runs out of time before it runs out of tokens still ends `model_unavailable`.
- **A review that still uses all of its room is told to the author as a pull request to split.**
  Its check is still `action_required` (nothing but a report decides success or failure, and an error is never a failure), titled "Could not decide: split this pull request", and says that the review used all the room it is given, which a large pull request is likely to cause, to split the pull request into smaller ones, by group of subjects or by kind of change, and that a NEMAR administrator can review it by hand.
  The words do not claim the pull request is large: the model's thinking, not the input, filled the budget, and the error names neither the stage nor a size.
  The owner asked for exactly this on 2026-10-20: make as much room as possible, and when that is not enough, ask for several pull requests.
- **A change that repeats across files is read once, exactly.**
  A bulk edit often makes the same change in every subject's sidecar, and it used the 40-file budget on 40 copies of one diff and left the rest unread, so `no_degradation` could never pass.
  A changed metadata file whose diff is identical to one already shown, line for line and at the same lines, with only the file's name different, is now counted on that diff (`Patch.same`) and not read again.
  It uses none of the file or character budget, covers its files exactly when the diff it rides on was shown in full (a cut diff covers nothing, and counts for itself alone in `files_read`).
  The match is exact: a hash of the diff's bytes (not their UTF-8 decoding) less the lines that name the file (`diff --git`, `---`, `+++` and the object ids of the `index` line), per status, with the file's mode kept, so it never masks a label or a number and never joins a symlink or an executable to a regular file: a change that differs in one byte, or names its own subject, is shown on its own.
  The model is told which diff stands for how many files, and the first three paths.
  Folding examines at most 500 files' diffs (`MAX_DIFFS_EXAMINED`), and, once the 40 patches are full, stops examining when less than 20 seconds of the content pass's 120 are left; the files not examined stay unread, which fails closed, instead of the pass timing out and taking the review with it.
  Measured by a reviewer on a full clone, 500 examined diffs cost about 5 seconds, against about 0.4 for the 40 read before; a partial clone is expected to be 2 to 3 times slower.
  No tool is given to the model for this (decision 3 stands: it has no tools); the platform does the matching, so the model cannot be steered into skipping a file.

**Consequences.**

- The review costs more when it uses its room: 128,000 output tokens is about $1.28 at $10 per million, against $0.32 for 32,000, plus the input at $2 per million.
  A pull request that truncates truncates again each time it is restarted (up to five times by edits, and by an administrator's start), so a run of them multiplies it.
  The output-tokens-per-minute limit of the workspace is estimated from `max_tokens` when a request starts, so a bulk `nemar admin pr-reviews start --all` reserves 128,000 tokens per review at once; the owner checks that limit before a bulk start, and `--concurrency <n>` paces the run to fit it (ADR 0093, the second amendment of 2026-10-24).
  Most reviews are expected to use far less, and the volume line of the admin list shows what they cost, but a run of large pull requests can spend the $175 monthly limit quickly, and the owner decides whether to raise it.
- The workflow file in `nemarDatasets/.github` has to carry `timeout-minutes: 50` before the release reaches `main`: the new script runs from `main` as soon as it is released, and a 28-minute job would be cancelled by GitHub in the middle of a long review.
- Folding changes what a bulk edit's evidence looks like, not what the Worker accepts: `files_read` never exceeds `files_changed`, and the report's other fields are the same.

## What this supersedes

- **ADR 0092, the second Decision bullet:** the hourly, daily and platform caps and the tally pause.
  The per-commit row and the administrator's block stay.
- **ADR 0092, the reviewer bullet and "The model has no tools and writes little":** effort `high`, one model, and a model that "answers three questions".
  Now two calls on two models (decision 3), five questions and the naming rule's facts, effort `max`.
- **ADR 0092, "Green and red are real; everything else needs a person":** plus `skipped`, for an exempt pull request alone.
- **ADR 0092, "The check is not required by any ruleset yet", and the Consequences that lean on it** ("acceptable only because the check is not required", "This is why the check is not required", "only matter once the check is required"): the check is required on reviewable datasets, and the risk that a model's false green lets a maintainer merge is accepted, bounded by facts, calibration and re-review on edit.
- **ADR 0092, the accepted risks "Many new accounts" and "Padding the tally":** replaced by the stage-1 cost bound and the workspace spend limit.
- **ADR 0092, the amendment of 2026-10-10:** the allowances and the pool (and so `start --all` stopping when the daily pool is spent), and "A new delivery of the same commit still restarts nothing but a dispatch GitHub did not run", which now has three more exceptions, an edit, a reopening and a marking as ready.
- **ADR 0093:** `allow` lifting the tally's pause (it now only clears a block); the queue verdicts gain `exempt` (built in phase P1); the two required checks it reads are joined by the review where its ruleset exists; and the `blocked` refusal, whose rule is unchanged, names the review.

## Consequences

- **An owner's or administrator's pull request is not held by the review, and anyone else's is reviewed on its content.**
  The queue calls the first `exempt (owner or admin)`, so nothing offers it to an administrator to review by hand, and a review of the current commit still wins over that word.
- **An exempt pull request has no row.**
  There is no history to show and nothing for the watchdog to publish again.
  A check that cannot be published is thrown and the webhook answers 500, so the delivery shows as failed in the App's delivery log and can be redelivered.
  A redelivery of an exempt commit posts a second check of the same name and the same conclusion, which is harmless.
  The only record that a commit was exempted is that check and a fixed-word log line (dataset, pull request, commit; no login).
- **A commit an owner pushes on top of a stranger's is the owner's.**
  The exemption judges who caused each delivery, not who wrote each commit, so an exempt account that pushes over someone else's earlier commits vouches for them.
  Those earlier commits may not have been reviewed at all: commits already on the branch when the owner opened the pull request, pushes made while it was a draft, and pushes whose review declined or errored.
  The same holds for an exempt author who marks a draft ready, and for an administrator's start of a pull request whose current commit has no review.
- **A demotion or a revocation does not retract a `skipped` check already posted.**
  It stays valid for its commit until the commit changes, and the next delivery reads the role afresh.
- **An edit holds the check running for as long as a run takes, and a restart may be one nobody wanted.**
  A maintainer's typo fix on a pull request that already had a result puts its check back to running for up to about 50 minutes (the job's own limit) and costs a run, if GitHub lets a completed check run go back to running (decision 4 says that is unverified).
  An exempt author's edit, reopening or marking as ready on a commit someone else pushed restarts that review, because the commit has a row and the exemption is judged only for a commit no review has touched.
  The cap bounds both at five restarts a commit.
- **An exempt push stores no row, so it does not supersede a review of the previous commit that is still running.**
  That review's late result can rewrite the pull request's review comment, which names the commit it is about; the check on the new commit is unaffected.
- **A review that starts for the same commit between the row read and the exempt publish leaves the commit with two checks of the same name.**
  The window is the length of the permission lookups, only an exempt actor can cause the exempt delivery, and which of the two checks a required check reads is GitHub's rule, not verified here.
- **The waiver depends on GitHub reading the newest check run of a name, and that is not yet verified.**
  A waiver posts a new `NEMAR PR Review` check run beside the failed one on the same commit, because a check run is created and an old one is never updated (an exempt pull request has no row to update).
  It releases a required check only if GitHub reads the newest run of a name, which is GitHub's rule and the same unverified rule as the two checks of the same name above.
  The staging step of the rollout (decision 6) verifies it with a first run of `allow --admin` against a required check on a dev-owned exemplar, and until that is done, a waiver is not known to release one.
- **The `exempt` label is inferred from who opened the pull request, not read from GitHub.**
  It does not prove the check was posted: a publish that fails answers 500 and shows in the App's delivery log.
  The one thing the list reads of that check is whether the newest `NEMAR PR Review` check run on the current commit failed or asks for a person, which the row says in `detail` (`naming_rule` or `naming_unchecked`) and the CLI prints as "exempt, naming rule failed: needs allow --admin" or "exempt, naming rule not checked: start once, else fix the file".
  A list of checks cut short, a check that is skipped or still running, and no check at all leave the plain label.
  It informs and decides nothing: a workflow job of the same name could make it wrong, and the row is still not marked as yours to act on.
- **GitHub's `author_association` is not a reason to exempt or to reject anyone.**
  It reads `CONTRIBUTOR` for a private organization member, so neither the exemption nor the screen uses it.
- **An exempt delivery makes up to five GitHub reads: the cross-check, then the naming rule's three.**
  The cross-check is one call per role-matched account, so two at most (the author's, and the sender's when someone other than the author caused the delivery and is role-matched too; one delivery asks about each account once), each bounded to 4 seconds.
  An administrator's start has no sender, so its cross-check is one call and its most is four reads.
  The naming rule then compares the base with the head and, only when that says `dataset_description.json` may have changed (it is listed, the list may have been cut at GitHub's 300 files, or there is no list that can be believed, see decision 3a), reads the file at the head and at the merge base, together; each read is bounded to 3 seconds.
  A delivery that is not exempt makes none of the three: the review job applies the rule to it.
  An admin queue request asks once per exempt author and dataset, a few at a time and within 20 seconds, and a pull request whose lookup did not run in time is listed as not exempt.
- **An installed CLI older than this change cannot read the standing answer.**
  It reads `thresholds`, which is gone, so `standing` and `show` fail, and `allow`, `block` and `clear` report a failure after the Worker has stored the change.
  A newer CLI against an older Worker shows a pause by the record as a plain pause and not as a block.
  The package publish and the Worker deploy are separate workflows, within minutes of each other, in either order (CHANGELOG, Deploy coupling), so either skew can happen for a few minutes.
  Both are administrators' tools, the Worker itself is unaffected, and the remedy is to upgrade the CLI; the two fields are not kept, because they would describe a rule that no longer exists.
- **The job and the Worker deploy separately, and a report that crosses the release is refused for a few minutes.**
  The job runs `main`'s script as soon as the release is on `main`, while the Worker is deployed by its own workflow (`deploy-backend.yml`), minutes before or after.
  In that gap a version 2 callback from the new script reaches a Worker that still has the old parser, which accepts version 1 only, and a version 1 callback from a job that started before the release reaches the new Worker, which accepts version 2 only; each is refused as `report_invalid`, and its check is `action_required` until a person starts the review again (a push, an edit of the text, or an administrator's start).
  No verdict is wrong and nothing but that review's run is lost, but it falls on the pull requests of authors in flight, where the skew above falls only on administrators' tools.
  The job and the Worker should therefore ship in the same release window: merge the release to `main`, wait for the Worker's deploy to finish, and then start any review that reads `report_invalid` with `nemar admin pr-reviews start`.
  On the staging Worker the skew does not end by itself, because it deploys from `dev` with the epic and every dispatch, staging included, runs `main`'s script until the release (decision 6); a review dispatched there reports version 1 and is refused the same way.
- **Until the screen ships, nothing bounds spend but the workspace limit.**
  Phase P2 removes the counts and phase P3 adds the screen, so the epic's branch must not be released with the first and without the second.
- **Without caps, cost is bounded by the screen and the spend limit, and the review on `claude-sonnet-5-5` is what costs.**
  At list prices ($0.10 and $0.50 per million input and output tokens for Haiku 5.5 on prompts under 100,000 tokens; $2 and $10 for Sonnet 5.5), the screen costs under a cent and the review is the bill.
  The first calibration run (2026-10-16, two public pull requests) measured $0.13 and $0.29 a full review, the review writing 11,000 and 28,000 output tokens; the earlier planning estimate of about a cent assumed Haiku for both stages.
  At the observed eligible volume of 7 to 167 reviews a day, that is roughly $1 to $50 a day, so the workspace spend limit of $175 a month (about $6 a day, some 20 to 45 full reviews) can trip on a busy day.
  When it trips the checks read "Could not decide" and required repositories wait for an administrator.
  The owner decides whether to raise the limit, before the check is required.
- **A long answer can run out of room.**
  The same run's second review used 28,000 of its 32,000 output tokens on a one-file pull request, and in the model comparison Haiku once used more than 32,000 on a text-only screen.
  The ceiling was too low for the review: see the amendment of 2026-10-20.
  Either is a truncation, which is no verdict and a check that needs a person; the calibration gate counts them.
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

- Epic #1813 and its phases #1814, #1815, #1816, #1817, #1818 and #1819.
- The two stages and report version 2 (#1816): `scripts/ci/pr-review.ts` (`STAGE_BUDGETS`, `callStage`, `reviewPullRequest`), `scripts/ci/pr-review-prompt.ts` (`SCREEN_SYSTEM_PROMPT`, `REVIEW_SYSTEM_PROMPT`, `V3_RULES`, `assembleReport`), `scripts/ci/pr-review-evidence.ts` (`gatherListing`, `gatherContent`), `shared/pr-review.ts` (`parsePrReviewReport`, `parseStoredPrReviewReport`).
- The naming rule and its override (#1816): `shared/naming-rule.ts` (`namingProblemOf`), `backend/src/services/pr-review-naming.ts`, `backend/src/services/pr-review-waiver.ts`, `src/commands/admin-pr-reviews.ts` (`allow --admin`).
- The calibration: `scripts/ci/pr-review-calibrate.ts`.
- Exemption: `backend/src/services/pr-review-exemption.ts`, `backend/src/services/pr-review.ts` (`isExemptDelivery`, `publishExempt`), `shared/pr-review.ts` (`exempt`, `skipped`).
- The gate and the removal of the counts (#1815): `backend/src/services/pr-review.ts` (`gateDecision`: exempt, then blocked, then reviewed), `shared/pr-review.ts` (`PRODUCED_DECLINE_REASONS`, `HISTORICAL_DECLINE_REASONS`, `standingOf`).
- The volume line: `backend/src/services/pr-review-queue.ts` (`readVolume`), `shared/contract/pr-review-admin.ts` (`QueueVolume`), `src/commands/admin-pr-reviews.ts` (`volumeLines`).
- The re-review on an edit, a reopening and a marking as ready, and its cap (#1817): `backend/src/services/pr-review.ts` (`readPullRequestEvent`, `handleRepeat`, `restartReview`, `refuseEdit`), `backend/src/db/migrations/0099_pr_review_edit_limit.sql`, `shared/pr-review.ts` (`PR_REVIEW_EDIT_CAP`, `WORKER_ONLY_RUN_ERRORS`).
- The required check's ruleset and its tooling (#1819): `backend/src/services/github/branch-protection.ts` (`REVIEW_RULESET_NAME`, `buildReviewRulesetPayload`, `ensureReviewRuleset`, `REPOSITORY_ADMIN_ROLE_ID`), `backend/src/services/pr-review-eligibility.ts` (`isReviewableRow`, `reviewIntentOf`, `automaticReviewIntent`), `backend/src/routes/admin/fleet.ts` (the review-ruleset routes), `backend/src/services/fleet-drift.ts` (`REVIEW_RULESET_MISSING`, `REVIEW_RULESET_STRAY`), `src/commands/admin.ts` (`nemar admin fleet require-review`).
- Queue and labels: `backend/src/services/pr-review-queue.ts`, `shared/contract/pr-review-admin.ts`, `src/commands/admin-pr-reviews.ts`.
- Tests: `backend/test/review-ruleset.test.ts`, `backend/test/review-ruleset-routes.test.ts`, `backend/test/pr-review-eligibility.test.ts`, `test/admin-fleet-require-review-cli.test.ts`, `backend/test/pr-review-exemption.test.ts`, `backend/test/pr-review-flow.test.ts`, `backend/test/pr-review-queue.test.ts`, `backend/test/pr-review-start.test.ts`, `backend/test/pr-review-edit-limit-migration.test.ts`, `test/pr-review.test.ts`, `test/pr-review-workflow.test.ts` (the budgets), `test/admin-pr-reviews-cli.test.ts`, `test/pr-reviews-render.unit.test.ts`.
