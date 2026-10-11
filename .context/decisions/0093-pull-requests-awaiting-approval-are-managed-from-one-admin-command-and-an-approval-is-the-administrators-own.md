# ADR 0093: Pull requests awaiting approval are managed from one admin command, and an approval is the administrator's own

**Status:** proposed
**Date:** 2026-10-08
**Owner:** Seyed Yahya Shirazi

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
  `nm000107`) the check is `bids-validation` from any source, as their ruleset has it; and
  `version-check` is never pinned. A same-named run whose App could not be read is not counted but
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
  only when both required checks are green, because the merge that follows would be refused
  otherwise, and a failing, running or unreadable review still needs `--force`, exactly as for
  `approve`. A comment is typed by the administrator and posted as typed, and for `n` it is posted
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
  GitHub Enterprise Server value); it re-asks while GitHub is still
  working the state out, does not wait for pending checks, sends the approved `sha` so GitHub refuses
  a branch that moved, and otherwise stops with the approval standing. An administrator can be a
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
