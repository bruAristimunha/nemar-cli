# ADR 0093: Pull requests awaiting approval are managed from one admin command, and an approval is the administrator's own

**Status:** proposed
**Date:** 2026-10-08
**Owner:** Seyed Yahya Shirazi

Partially superseded by [ADR 0107](0107-dataset-pull-requests-are-screened-on-content-owners-and-administrators-are-exempt-and-the-review-check-is-required.md) (proposed with epic #1813; phases P1 to P6 are built on the epic branch, so the `exempt` verdict, the changes to `allow`, `start --all` and the list's volume line, and the review ruleset exist, and the required check is not switched on):
`allow` only clears an administrator's block, `start --all` no longer stops on a daily pool, the queue gains the verdict `exempt` and a volume line, and the review will join the required checks where its ruleset exists.
Its "What this supersedes" section lists what it replaces here.

Follows ADR 0092 (the review this command lists and acts on), ADR 0001 (published datasets are
PR-only), ADR 0054 and ADR 0086 (unknown is never zero, and never clear).

## Context

ADR 0092 records an automated review of every pull request to `main` of a dataset repository, but an
administrator still has to visit the repositories one at a time to find what is open, and the only
way to restore a contributor the tally has paused is a row written with `wrangler d1 execute`.

Four facts shape the answer. An approval is a person vouching for a change and GitHub records whose;
the Worker can act only as the NEMAR App or with the shared datasets token, and neither is a person.
GitHub knows which pull requests are open and what their checks say, the Worker knows what the review
concluded, and neither alone answers "what is waiting for me". The `nemarDatasets` organisation is
shared by production and dev while their D1 databases are not. And the title and branch name of a
pull request are written by whoever opened it, who may be anyone on a public dataset.

"Awaiting approval" is the maintainer's phrase for the work; ADR 0001 sets
`required_approving_review_count: 0` on a published dataset, so GitHub itself waits on no approval.
The command lists open pull requests and the review of each, and approving is something an
administrator chooses to do.

## Decision

**One command group, `nemar admin pr-reviews`, lists, explains and approves, and its approval is made
by the administrator, from their machine, with their own GitHub login.**

- **The queue is one search joined to the review table.** `GET /admin/pr-reviews` runs the GitHub
  search `org:nemarDatasets is:pr is:open base:main` as a paginated GraphQL query with the datasets
  token, which returns each pull request's head commit, fork, author id and required checks in the
  same call, then joins the reviews in `pr_reviews`. A pull request with no stored review is
  `not_reviewed`, not an error, so the command works with `PR_REVIEW_ENABLED` off. Anything that
  stops the read (a failed later page, a GraphQL `errors` array even with data beside it, a spent
  budget, a GitHub that does not answer) fails the whole read, because a partial queue that looks
  complete is worse than none. A result that cannot be read as a pull request is counted and shown,
  not dropped, and a field that is missing is never read as "not a dataset pull request" or "no
  longer open": only a node that says so is left out. The list is marked incomplete when the count
  GitHub reports changes between pages, because its cursors are positions and a pull request can
  be skipped when the pages shift.
- **A verdict belongs to the commit it read, and the review used is that commit's.** `pr_reviews` has
  one row per commit, and a redelivery of a commit refreshes its `seen_at`: "latest" means the last
  commit seen (ADR 0092), so a force-push back to a reviewed commit makes that commit's review the
  newest. A delivery can still be missed, so the queue and the detail view use the review of the pull
  request's current head whenever one exists, whatever its place in that order, and otherwise show
  the most recently seen review as `not_reviewed` with what it concluded as `stale_verdict`. When the
  current head cannot be established no verdict is asserted at all. The detail view shows the
  STRICTER of the stored column and the verdict re-derived from the stored report, so either source
  can lower a verdict and neither can raise it: an unreadable report is `could_not_decide` unless
  the column says `fail`, and a later change to the rules that would now pass an old rejection must
  not make it easier to approve. The list reads the column alone; the two differ only when a rule
  changed or a report is corrupt. A review handed to GitHub and not reported within the watchdog's
  deadline and one tick reads as `could_not_decide` (never reported), because the dev Worker never
  ages a row and a production sweep can fail; showing it as running would hide it from the people
  it is waiting for.
- **The checks shown are the ones the ruleset trusts.** The BIDS column applies the pinning branch
  protection applies: for a central-flow dataset only the check run posted by the NEMAR App counts,
  because anyone with push access can add a workflow job with the same name, and a commit status or
  another App's run does not; for the four legacy repositories (`nm000103`, `nm000105`, `nm000106`,
  `nm000107`) the check is `bids-validation` from any source, as their classic branch protection
  (they have no ruleset) has it; and `version-check` is never pinned. A same-named run whose App could not be read is not counted but
  makes the state `unknown` if it is the newest. The checks read are the head commit's; if the
  connection returns another commit, or a check node could not be read, they are `unknown`.
- **Approval is the administrator's act and does not pass through the Worker.** No Worker code path
  approves, and the Worker holds nothing that belongs to an individual administrator. The tokens it
  does hold (the App and the datasets token) could submit a review, which is why none is ever made
  with them. `approve` takes `GH_TOKEN`, or else the token `gh` holds (asked for with `GH_TOKEN` and
  `GITHUB_TOKEN` removed from its environment, because `gh` itself prefers them to its stored login).
  It refuses the token unless `GET /user` says it belongs to a person, and, when the administrator's
  NEMAR account is linked to a GitHub login, refuses it if the person is not that login. It submits
  the review with `commit_id` set to the head the administrator was shown and checks that GitHub
  recorded an approval, by that login, of that commit. If `gh` holds no signed-in account, or the
  token is an app or workflow token, it prints the pull request link and the `gh pr review --approve`
  command (and opens the link in a terminal); a token GitHub rejects, or a GitHub that cannot be
  reached, is reported without it.
- **The verdict gates the approval without taking the decision.** A pass shows no warning, and every
  approval still asks for confirmation unless `--yes`. An uncertain, undecided, missing or
  different-commit review shows its reason first; `--yes` skips the question, not the reason. A
  failing review, one still running, or one the NEMAR API could not be read for needs `--force`: an
  unknown verdict is never rendered as "not reviewed", because a stored rejection could be hiding
  behind it. That includes an answer the CLI cannot read (no verdict, a verdict word it does not
  know, or an answer about a different commit than the one GitHub reports), which is unread, not
  "could not decide". An error from the review read stops the approval unless it is one of the
  answers that mean the Worker cannot say (`not_owned_here`, `github_unavailable`,
  `no_such_pull_request`, the last because the administrator's own token just read the pull
  request). The reason a pull request is not reviewed (a paused or rate-limited contributor) is
  shown beside the verdict.
- **`next` walks the queue and asks one question per pull request.** It shows who opened it,
  whether the two required checks (BIDS and the version check) are green, and a short read of the
  review (only the report of THIS commit's review): its headline, the reviewer's sentence, whether
  the version went up, and any findings. Then it waits for one answer: `y` approves as the
  administrator and squash-merges, `n` closes with a comment, `c` comments and leaves it open, `d`
  shows the whole report and asks again, `s` leaves it, `q` stops. `y` is offered
  only when both required checks are green and GitHub reports the pull request `clean` (settled as
  for `approve --merge`, see the amendment of 2026-10-12), because the merge that follows would be
  refused otherwise, and a failing, running or unreadable review still needs `--force`, exactly as for
  `approve`; `--force` does not reach the mergeable state. A comment is typed by the administrator and posted as typed, and for `n` it is posted
  BEFORE the pull request is closed, so the author never meets a closed pull request with no
  reason; an empty comment cancels. Every write is made with the administrator's own token after
  the same identity checks as `approve`. A write whose outcome is unknown, or that recorded
  something other than what was asked, stops the run; a plain refusal is reported and the run
  goes on. Each run remembers the pull requests it has shown, because the search index trails a
  merge or a close and would show them again. A comment or a close is not pinned to a commit by
  GitHub, so the pull request is read again after the comment is typed and nothing is written if it
  is no longer open at the commit shown. In a terminal, lines typed before a card was shown (Enter
  pressed while the program was busy, or the rest of a pasted comment) are discarded, never
  answered to the next card; piped answers are a script and are all kept. "Nothing left that needs
  you" is said only when nothing was skipped, failed, left unknown or approved without a merge,
  and the list was read whole.
- **A merge is attempted only on request, and is a check, not an enforcement.** `--merge` (and `y`
  in `next`, which always squashes) is attempted once, only if GitHub reports the pull request `clean` (not `has_hooks`, which is a
  GitHub Enterprise Server value). That is read BEFORE anything is written: a state that is not
  `clean` writes no approval and no merge (amendment of 2026-10-12). It re-asks while GitHub is still
  working the state out, does not wait for pending checks, sends the approved `sha` so GitHub refuses
  a branch that moved, reads the state again just before the approval is written (amendment of
  2026-10-12) and once more after it in case it changed, and otherwise stops with the approval
  standing. GitHub has no approve-and-merge call, so these looks narrow the window to one request and
  do not close it. An administrator can be a
  bypass actor, so this does not attempt a merge GitHub reports as blocked; the ruleset enforces, and
  this code does not try to defeat it.
- **An outcome that is unknown is said to be unknown.** A write that gets no answer from GitHub, one
  answered with a 2xx that cannot be read, and one answered 5xx by a gateway may all have been
  applied, so each is reported as "outcome unknown, check the pull request", never as a refusal. A
  merge that was never sent (the read before it failed, the branch moved, GitHub did not say
  `clean`) says so and is not "may have merged". A review GitHub recorded that is not the approval
  asked for (another state, login or commit) is reported as that.
- **Overrides are keyed by GitHub's numeric id.** `allow`, `block` and `clear` ask GitHub who holds a
  login now, because a login can be renamed and reused. `allow` and `block` need GitHub's answer. The
  login an override stored is used only to `clear` a decision for an account GitHub no longer has or
  cannot answer for, and only when exactly one account stored it; failing that, `clear` may take the
  id from the review history, which deletes only a decision that already exists for that id. `allow` lifts the tally's pause and
  nothing else: the rate limits still apply. Each change writes an audit row, and the reason is
  reduced to plain words before it is stored.
- **Each Worker lists the datasets it owns.** The dev Worker answers for dev-owned datasets and
  production for the rest, the same fence the webhook applies, so the dev Worker never presents
  production's pull requests as unreviewed and never acts on a production repository.
- **Text a pull request's author controls is reduced twice.** The Worker passes titles through
  `sanitizeNote`, reduces branch names to a conservative character set, builds links from the dataset
  id and number, and never asks for a body. The CLI removes control characters again before printing.

## Consequences

- An administrator sees every open pull request in one table, with the ones they can act on first,
  works through them with `next`, and approves, merges, comments or closes from the same place
  under their own name. The `wrangler d1 execute` workaround in ADR
  0092 is retired.
- The approval is recorded by GitHub and nowhere in NEMAR. The Worker never sees it, so there is no
  NEMAR audit row for an approval; the review on the pull request is the record.
- `approve` needs a GitHub token. If the administrator's NEMAR account is linked to a GitHub login,
  the token must be that login's; if it is linked to none, nothing can be compared, so the login in
  use is shown, and `--yes` skips the question for them as for anyone.
- The list depends on GitHub's search index, which can lag behind a new pull request and
  returns at most 1000 results. The 1000-result cap, the page bound and a count that changed while
  reading are reported (`truncated`); the lag is only in the help text.
- The Worker's GitHub credential (the App's installation or the `GITHUB_ADMIN_PAT` fallback) is
  expected to need read access to pull requests, checks and commit statuses for the GraphQL query.
  That has not been run against GitHub from this change: a credential without it may be refused
  (the list then answers 502 or names the GraphQL error) or may read as a pull request with no
  checks, which is shown as `none`, not as passing. Run the list once against production before
  relying on the checks columns.
- The dev Worker cannot show a production review. `approve` against it treats the verdict as unknown
  and needs `--force`.
- A review that errored for a setup reason is started again with `start` (amendment below), after the
  setup is fixed; `approve` and `next` do not do it.

## Alternatives considered

- **Approve from the Worker with the App or the datasets token.** Puts the App's name on a judgment a
  person made, and turns the automated review into its own approval. Rejected.
- **Store a GitHub token per administrator in NEMAR.** A user-to-server credential that could approve
  for a person, with its own revocation cascade (AGENTS.md), for a command that runs on that person's
  machine where `gh` already holds the credential. Rejected.
- **Only print `gh pr review --approve`.** Kept as the fallback. It cannot pin the commit, check whose
  token it is, or put the verdict in front of the administrator first.
- **The REST search plus a read and a check lookup per pull request.** Several requests per pull
  request against a token every sweep shares, at a rate GitHub answers with a secondary limit.
  Rejected for one GraphQL search.
- **Merge after approving by default.** ADR 0001 lets an owner merge their own pull request; nothing
  here should make a merge the side effect of a review.
- **Show another commit's pass as a pass with a warning.** A pass about different code is the mistake
  this ADR exists to prevent. Rejected.
- **Use the newest review row for every purpose.** Simpler, and wrong whenever the delivery of a
  force-push back to a reviewed commit was missed: it downgrades a failure to a confirmation.
  Rejected.

## Receipts

- Contract: `shared/contract/pr-review-admin.ts`. Worker: `backend/src/services/pr-review-queue.ts`,
  `backend/src/routes/admin/pr-reviews.ts`. Tests: `backend/test/pr-review-queue.test.ts`.
- Command: `src/commands/admin-pr-reviews.ts`, `src/lib/pr-review-approve.ts`. Tests:
  `test/admin-pr-reviews-cli.test.ts`, `test/pr-review-approve.test.ts`,
  `test/pr-reviews-render.unit.test.ts`.

## Amendment 2026-10-10: `start`

`nemar admin pr-reviews start <dataset> <pr>` and `start --all` ask the Worker to review a pull request
that is already open, or to start again a commit whose review ended without a verdict. They are the one
subcommand here that makes the Worker act on a pull request, and the Worker's part is the same dispatch,
check and comment any review makes: it still does not approve or merge. The decision and its limits are
in [ADR 0092](0092-dataset-pull-requests-get-a-derived-verdict-from-a-worker-gated-model-review.md),
amendment of 2026-10-10.

## Amendment 2026-10-12: a merge that was asked for is checked before anything is approved

The release review of 0.10.16 found that `approve --merge`, and `y` in `next`, approved a pull request
and only then read GitHub's state and declined to merge it. The state was read after the approval,
and `y` was offered for every state but `dirty` and `behind`, so a pull request the automated
review holds was approved and then refused the merge. GitHub's `unstable` is a check or status that
is not required and is not passing or has not reported; the review's check is not required, so a held
review is expected to produce it (observed once, on 2026-10-12, on a pull request whose review check
was red; see the next amendment). The administrator was left with an
approval they asked for only as the first half of a pair. ADR 0092 recorded this as an open item.

The rule above does not change: a merge is attempted only when GitHub reports `clean`. What moves
is where it is checked. `--merge` and `y` ask for an approval AND a merge, so GitHub's state is read
before either is written, by one function (`checkMergeable`) for every place that asks:

- **`approve --merge`** reads the state first, asks again for a few seconds while it is `unknown`
  (GitHub works it out lazily), and writes nothing, no approval and no merge, unless it is `clean`.
  It says which state GitHub reported and why that blocks a merge, and then what to do. For a state
  that will not clear by itself that is to run `approve` without `--merge`, which approves without
  merging; for `unknown` or a read that failed, it is to run the same command again in a moment; for
  a head that is another commit than the one shown, to run it again to read the new one. `--dry-run
  --merge` gives the same answer, because it is what the real
  run would do. A state that is still `unknown`, one that cannot be read, a re-read that finds
  another head, a pull request that is no longer open, and a state this code has never heard of are
  not `clean`.
- **`y` in `next`** is offered only when both required checks are green and GitHub reports `clean`,
  settled the same way before the card is shown. When it is not offered the card says which state, or
  which failed read, and why, and names `nemar admin pr-reviews approve <dataset> <pr>` (without
  `--merge`); `n`, `c`, `d`, `s` and `q` are the answers that remain. Typing `y` anyway is refused
  with the reason and writes nothing. For a state that may clear, or a head that changed, the
  advice is that `s` skips the card and a fresh `next` run looks again, not that `y` can be tried
  again: a card is pinned to the head it was shown for, and `y` when it is not offered does not look
  again. `--force` is about the review's verdict and does not reach this.
- **The state is read again right before the approval is written**, by one helper
  (`recheckBeforeApproval`) that both commands call. The early check can be as old as the
  confirmation prompt or the time a card was on screen, and an approval cannot be taken back, so the
  state is read fresh (one extra request when it is clean) and a refusal says it came from that second
  look. The early check stays so the administrator is not asked to confirm what cannot be done.
  This narrows the window to one request and does not close it: GitHub has no approve-and-merge
  call, so this is narrowed, not atomic, and the look after the approval is what catches a check that
  starts or reports in the meantime.
- **The look after the approval stays.** A check can turn pending and a push can land between the
  second read and the merge, so the state is read once more right before the merge is sent, and the
  approval stands if it is no longer `clean`. That is now the exception, not the way a held pull
  request is handled.
- **An approval alone is unchanged.** `approve` without `--merge` approves whatever the state is,
  under the same verdict gate and `--force`, and when GitHub's state is one that will not clear by
  itself it says so instead of suggesting `--merge`.

A pull request the review holds is therefore approved with `approve` and merged on GitHub by the
administrator, as ADR 0092's second option put it. The first option (accept `unstable` when both
required checks pass) is not taken here: it changes the rule, and it is the maintainer's to decide.

One consequence is worth knowing. A repository whose protection required an approving review would
read `blocked` before the administrator's approval and `clean` after it, so `--merge` and `y` would
now refuse it where they used to approve and merge. The ruleset applied to a published dataset
requires none (`required_approving_review_count: 0`, ADR 0001), and the four legacy repositories use
classic branch protection that requires none, so nothing is refused today for this reason.

## Amendment 2026-10-12 (trial): `unstable` was observed once

The trial pull request recorded in ADR 0092's amendment of this date read `unstable` on GitHub's
`mergeable_state`, once it was closed.
That replaces "expected, not yet observed", here and in ADR 0092's open item, with one observation,
made on a pull request whose review check was red.
`unstable` is not `clean`, so it is a state `approve --merge` and `y` in `next` refuse before they write
anything.
The observation does not say what the state is for the held verdicts (`uncertain`, `declined`,
`errored`, which are `action_required`), and it does not settle whether `unstable` should be accepted
when both required checks pass: that stays the maintainer's decision, tracked in issue #1743.

## Amendment 2026-10-24: `start --redo`

A commit whose review has a result was never started again by an administrator: `start` answered `duplicate`, and a finished review ran again only when the pull request's title, body or base was edited, or it was reopened or marked ready, at most five times for one commit ([ADR 0107](0107-dataset-pull-requests-are-screened-on-content-owners-and-administrators-are-exempt-and-the-review-check-is-required.md), decision 4).
That is the right rule for a contributor, who must not be able to buy a second model call by resending the same commit.
It left the administrator without a way to re-judge the pull requests already reviewed after the rules or the prompt changed (release 0.10.23 changed both), which is the one time a second run is wanted.

`nemar admin pr-reviews start <dataset> <pr> --redo` asks for it by name, and `start --all --redo` asks for every open pull request whose current commit has a finished review (pass, fail or uncertain), behind the same cost question and `--dry-run` as `--all`, with each finished review marked in the list.
The Worker takes `?redo=1` on the start route and restarts the commit on its row through the restart that edits use: the nonce is replaced, so the superseded job's claim and report are refused, the verdict and report are cleared, the check goes back to running, and `attempts` goes up by one when the earlier run could have cost a call.
A redo is not an edit, so it leaves the row's count of edit restarts as it is: a bulk redo must not give a contributor who is one edit from the cap five more.
(Any other administrator's start, of a declined, errored, unreported or capped row, begins the count again, as before.)
Everything else a start is held to still applies: the dataset must be reviewable, the pull request is read from GitHub, and an owner's or administrator's pull request is not reviewed unless a review of its current commit is on record, in which case it is handled like anyone's, as [ADR 0107](0107-dataset-pull-requests-are-screened-on-content-owners-and-administrators-are-exempt-and-the-review-check-is-required.md) says of every start.
A block on the contributor answers `contributor_paused` and leaves the row's result alone: a redo does not change the text the review judged, so the finished review is not replaced by a decline (an edit does replace it, because the text changed).

Two further limits are part of the decision.
A review that is running is never started again, by a redo or by a plain start; the redo's answer is `review_running`.
A review is running while it was handed to GitHub less than the watchdog's 60 minutes ago, or while a job claimed it less than the workflow's 50 minutes ago.
The second test is new: the deadline counts from when the row was recorded and the job's limit from its claim, so a job that waited in GitHub's queue is still inside its limit when the watchdog has closed its row as `unreported`, and a second bulk redo must not supersede it.
`--all --redo` leaves out drafts, reviews in progress, exempt pull requests and the commits capped for edits, which are started by name, as `--all` does.
An administrator's start is tried against the row as it is now, up to three times, like a change of the text, so a redo that loses a race (the watchdog closing the row, a report stored) is not answered `duplicate`.

The Worker echoes `redo: true` in every answer to a start that asked for it.
A CLI that sent the flag and does not see the echo knows the Worker predates it: it reports what the Worker did, says the flag was ignored and exits 1, so an older Worker's `duplicate` is never read as "nothing to redo".
The word `review_running` is also a reason code of the publication review (ADR 0102); the vocabularies do not meet, and this one appears only in the answer of a start.

There is no migration: the restart is the SQL that already exists.
The cost is the administrator's to decide (a review is up to two model calls, and a bulk redo of about a hundred reviews is a hundred runs); nothing automatic redoes a review.
The first run's tokens leave the volume's token and cost sums when the report is cleared, as for any restart ([ADR 0107](0107-dataset-pull-requests-are-screened-on-content-owners-and-administrators-are-exempt-and-the-review-check-is-required.md) names this), while the run count keeps both.
A bulk redo cannot be resumed (running it again redoes the reviews that finished in between), and a `--limit` to stage it is not built.

## Amendment 2026-10-24 (second): `start --all --concurrency`

A bulk start began every review at once, and each review reserves its whole output budget (128,000 tokens) against the workspace's output-tokens-per-minute limit when its request begins ([ADR 0107](0107-dataset-pull-requests-are-screened-on-content-owners-and-administrators-are-exempt-and-the-review-check-is-required.md), Consequences), so about a hundred starts asked for a hundred budgets together and queued a hundred jobs in one repository.
`start --all [--redo] --concurrency <n>` paces it: at most `n` of the reviews that run started are in progress at any time, and the next one starts as each leaves `in_progress`.
It is a sliding window, not fixed batches, because a batch waits for its slowest review (one that truncates runs for half an hour) while the other slots sit idle.

The pacing is in the CLI alone.
While it waits it reads the admin list (`verdict=in_progress`) every 30 seconds, one request that answers for every pull request, and a started review counts as running while it is in that list.
Leaving the list is not proof of finishing: the list is built from GitHub's search of open pull requests, so a pull request that was closed or merged, or that the search leaves out for a moment, drops out of it while its job may still be running.
A review that left the list is therefore confirmed finished by a read of its stored review before its slot is freed, naming the commit the run started it for (without a commit the Worker judges the pull request's current head, and reads "not reviewed" whenever GitHub cannot be asked or the head has moved); a read that fails or takes longer than two minutes keeps the slot, and a pull request GitHub no longer has counts as finished.
No slot is held for ever: a job cannot outlive its limit, so a slot is freed after 100 minutes whatever the queue says (the Worker's 60-minute deadline plus 30 minutes of grace is 90, and the queue stops showing an overdue review as running after that).
A start that fails with a connection error, an unreadable response (the client reports both as status 0) or a 5xx may have reached the Worker before it failed, so it takes a slot until the queue shows it is not running; a refusal with a 4xx cannot have started anything and takes none.
An answer that is not a start (a blocked contributor, an exempt author, `review_running`) takes no slot.
Only the reviews this run started are counted: reviews that contributors' pushes started are running too, but counting them would let a busy hour stall the run for something it did not cause.

A list that is incomplete (GitHub returned fewer pull requests than exist, or some could not be read), a request that fails and a request that takes longer than two minutes cannot tell what finished, so it is never taken as "finished": the window stays full, the run says so, and ten such reads in a row (about five minutes) stop it, because it cannot keep its limit blind.

Ctrl-C ends any `--all` run, paced or not: it stops after the request in flight, lists the pull requests never started, as commands to continue by name for a redo (a rerun of `--all --redo` would redo the finished ones again), lists any start that failed so it can be checked, and exits 130.
A second Ctrl-C leaves at once, because a request in flight cannot be taken back, and says which start was in flight so it can be checked.
The same list is printed when ten reads fail (exit 1).
Reviews already started keep running on the Worker either way.
Without the flag the starts are unchanged, except that every `--all` run now ends on Ctrl-C this way, and above ten starts at once the list ends with a line naming the limit and the flag.
The administrator chooses `n` from the workspace's limit (`n` x 128,000 output tokens must fit it); the CLI does not read or guess that limit.
