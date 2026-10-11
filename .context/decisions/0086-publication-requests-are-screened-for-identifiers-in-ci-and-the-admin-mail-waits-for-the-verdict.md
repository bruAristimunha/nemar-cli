# ADR 0086: Publication requests are screened for identifiers in CI, and the admin mail waits for the verdict

**Status:** accepted
**Date:** 2026-10-05
**Owner:** Seyed Yahya Shirazi

Epic #1610, issue #1614.
Follows ADR 0085 (the scrub of published datasets) and builds on ADR 0020 (central workflows
with a callback), ADR 0053 and ADR 0054 (unknown is never healthy), ADR 0065 and ADR 0067
(report, never repair; no GitHub issue on a public-facing org).

## Context

Sixteen datasets reached the public bucket carrying patient names, birth dates and record
numbers in EDF and BDF headers.
Every one of them passed publication review, because review checked that a README and an
author list existed and never opened a recording.
The Data Contributor Terms put the duty on the depositor, and NEMAR is a publisher that is not
liable and is ethically responsible, so the check has to be a standing step of publication that
does not depend on anyone remembering to look.

The pre-screen workflow (ADR 0014, ADR 0026) is the model for how such a step is dispatched and
reports back, but it is advisory and it posts a judgment from a language model.
This check is mechanical, it reads bytes, and the answer decides whether a person's name goes
public.

Two facts shaped the design.
`repository_dispatch` answers 204 whether or not any workflow listens, so a dispatch that
"succeeded" proves nothing about a run.
And the Actions logs of `nemarDatasets/.github` are public, so the workflow must not print
anything that could be a value.

## Decision

**Requesting publication starts an identifier screen in `nemarDatasets/.github`
(`run-identifier-screen.yml`), and the admin publish-request email is sent when the screen
reports, stating the result.**
If the screen cannot be started, fails, or never reports, the admin gets the email anyway,
saying so.

- **The screen is a workflow, not the Worker.**
  It clones the dataset repository without file contents, reads every EDF and BDF header
  (256 bytes each, ranged reads of the S3 object through a presigned URL), the sidecars, the
  participants and scans tables, small code and text files, every path that ever existed on
  any ref, and the headers of recordings that earlier commits held and the current tree no
  longer does (their objects stay in the bucket and become public with the dataset).
  The Worker cannot make tens of thousands of subrequests; an Actions runner can.
  It runs the same scanner as the uploader preflight and the fleet scan
  (`shared/identifier-scan.ts`), so every surface asks one question.
- **The report is a closed vocabulary, enforced at the door.**
  `shared/identifier-screen-report.ts` parses what the workflow posts: only known finding kinds,
  only counts, only extension-shaped format names, only fixed-word reasons and errors.
  An unknown key, a string where a count belongs, or a kind nobody declared is refused with a
  fixed word that does not quote it, so a changed workflow cannot put a name into D1, an email or
  a status view.
  The same module produces the words shown to people (`describeScreen`), so the email, the
  status view and the CLI cannot disagree.
- **The email waits, and cannot be lost.**
  A held request has a state of its own (`pending`).
  The email is claimed with a five-minute lease before it is sent, marked sent only when at least
  one recipient accepted it, and released when none did, so a process that dies between claim and
  send, or a failed release, is retried.
  A production-only sweep on the half-hourly tick marks a screen that did not report within 50
  minutes (the workflow's own deadline is 35, its job timeout 45) as `unreported` and mails any
  result whose lease is free and whose mail has not gone.
  An `unreported` request keeps its one-shot token, so a late but valid report is still stored
  and mailed (a second mail, because the first said the screen did not report); a re-run
  replaces the token, so an earlier run's report is refused.
  Resend says the screen is still running instead of sending a mail that contradicts the gate.
  A request the BIDS sweep unblocks starts its screen then, so nothing waits on a person
  remembering to run it.
- **Unknown is never clear.**
  `screenGate` maps every state to what may happen next.
  A screen that did not run, did not report, or whose request predates the screen is `rerun`,
  never `clear`; a stored value that is not a state is `rerun` too.
- **Direct identifiers block, and are not acknowledged.**
  A direct finding sets the request to `blocked` (`identifier_screen_findings`), mails the
  requester the kinds and counts only, and has no override: the data is fixed and the screen run
  again.
  A finding of lesser severity, or a scan that could not cover everything (a recording format
  the scanner does not parse, an unreadable header), needs an admin to approve with a recorded
  reason, which is written to the request and the audit log.
  Acquisition dates alone are fine (2026-10-04 policy) and do not hold anything.
- **The gate is bound to a commit.**
  The report names the commit of `main` it screened, and approval refuses if `main` has moved or
  if GitHub cannot say where it is.
  Sandbox datasets (`xx`) never publish real data and are exempt.
- **Resuming an approval does not skip the gate until it has published.**
  A resumed or re-dispatched approval is gated like a fresh one (state and head) until a step at
  or after `s3_public_read`, the first mutation, is complete; before that, a failed check
  (BIDS validation red) followed by the depositor's fix would otherwise publish a commit nobody
  screened.
  A recorded acknowledgment satisfies a later run only for the same approver.
- **OpenNeuro mirrors are screened like any deposit.**
  Only well-formed `xx` ids are exempt.
  The importer requests and approves in one run and meets the gate; making it scrub in place and
  wait for the screen is Phase 7's work (#1618), and the epic is not released before it.
- **Nothing is repaired and nothing is filed.**
  The screen reports and gates; it never edits a dataset, and it opens no GitHub issue
  (`nemarDatasets` is public-facing).

## Consequences

- Publication review now reads recordings, deterministically, every time, and the admin sees the
  verdict in the same email that asks for the decision.
- A workflow outage no longer slows publication silently: it produces a "did not run" email and
  holds approval until a run succeeds (an admin can start one).
  The cost is that an extended outage holds publications; there is deliberately no break-glass
  in the approval path that approves an unscreened dataset.
  Two administrator tools can still make a dataset public without the screen
  (`POST /datasets/:id/publish`, `PATCH /admin/datasets/:id/visibility`); they are operations on
  datasets that already exist, they write audit rows, and each carries a comment pointing here.
- The check is best effort, and says what it did not read.
  It does not parse formats outside EDF and BDF, it does not read the contents of sidecars and
  tables in earlier commits, and it cannot judge free text it does not recognize as a name.
  A clean screen is not a certification; the policy text and the email say so.
- The workflow checks out `nemarOrg/nemar-cli` at `main` for the script, so the script must be
  released before the workflow can pass; until then the failure callback produces the
  "did not run" path, which is the designed degradation and not an outage.
- Reports are counts, so an admin who wants to see a finding opens the file; the report is a
  pointer to where to look, never a copy.

## Alternatives considered

- **Screen in the Worker.**
  Subrequest and CPU limits make a full header read impossible for the largest datasets, and a
  sample is exactly the weakness that let sixteen datasets through.
- **Send the email now and the screen later.**
  Simple, and it makes the screen advisory: an admin who has already been asked to decide does
  not wait.
  The point is that the decision is made with the result in hand.
- **Advisory only, like the pre-screen.**
  A language-model concern is a judgment; a name in a header is a fact.
  Advisory is how the review was bypassed before.
- **An override for direct identifiers.**
  A scanner false positive would justify it; so would a bug.
  The cost of publishing a person's name is larger than the cost of a delayed release, and a
  false positive is fixed in the scanner once, for every dataset.
- **Fail open when the screen is down.**
  Unknown would then read as healthy, which is the failure ADR 0053 forbids.

## Amendment 2026-10-06 (#1615): a second caller

The scheduled identifier sweep (ADR 0088) dispatches this workflow too, unchanged, with its own callback route and token kind and a `request_id` of 0.
Because a run's public log names the dataset it screens, the sweep's cadence never depends on what a screen found.
Everything above about the workflow, the contract and the public log holds for those runs as written.

## Receipts

- Report contract and its tests: `shared/identifier-screen-report.ts`, `test/identifier-screen-report.test.ts`.
- Scanner and fleet scan: ADR 0085 context, PR #1617.
- Epic #1610; this decision is Phase 4 (#1614).

## Amendment 2026-10-06 (#1618): the importer waits for the screen

The importer no longer requests and approves in one run: [ADR 0089](0089-an-import-scrubs-before-it-copies-and-waits-for-the-identifier-screen.md) scrubs the tree in prepare, and finalize waits for this screen's verdict and approves only a clear one, leaving any other for an admin.
Nothing in this ADR's gate changed; the importer is one more client of it.

## Amendment 2026-10-07 (#1616): acquisition dates are warned about

The 2026-10-04 policy above stands: an acquisition date alone is clear, and nothing in the gate changed.
[ADR 0090](0090-acquisition-dates-finer-than-year-and-month-are-warned-about-never-gated-or-rewritten.md) records the maintainer's choice of policy B and adds a fixed warning, produced by `describeScreen` from the report's counts whenever a date kind is counted.
The admin email, the status views and the requester's blocked-request mail therefore carry it; the report contract gained no field.

## Amendment 2026-10-07 (#1646): a CI-pending refusal is a state the CLI reports, not an error

A request made before the dataset's BIDS validation has concluded is refused with `bids_validation_pending` or `bids_validation_in_progress`, and that refusal is recorded: the request row is `blocked`, and the blocked-request sweep (`sweepBlockedBidsValidationRequests`) re-reads the latest run and unblocks it when CI passes.
Unblocking starts the identifier screen exactly as a re-request would, so the request carries on by itself.
The sweep runs today from the daily scheduled cleanup (03:00 UTC in production, per `backend/wrangler-sccn.toml`), so a recorded request can wait up to a day, and a run takes at most 50 rows and releases at most 10 requests, the rest waiting for the next run.
The cadence is the server's to change and is not part of this decision, which is why the CLI promises no time.
(The half-hourly sweep earlier in this ADR is another one: it covers screens that did not report.)

Both places that decide a request put it through the submission minimums of ADR 0026 and, for an anonymous request, the blind check of ADR 0065, with one function (`checkSubmissionGate`): the request route does so even when CI is the only thing blocking (a missing minimum then replaces the pending reason and is answered at once as `min_requirements_failed` with its reasons), and the sweep does so before it releases a request, because the depositor may have edited the data since.
A request that fails is re-blocked as `min_requirements_failed` and stops being a sweep candidate until the depositor requests again.
OpenNeuro imports and exemplars keep their exemption, except that an anonymous request is always checked.
The request route reads a README only when `EthicsApprovals` lists no approval, and one it cannot read counts as one with no statement; it never takes the Name and Authors rules with it.
A description it cannot read blocks an anonymous release and lets a native submission go on to the admin review (ADR 0026).

The sweep is a daily batch and reads more carefully.
Its reads never sleep or retry, and share a budget of 100 per run (the tally reports `gateReads` and `deferred`); a file it cannot read, native or anonymous, or a run that spends the budget, leaves the row untouched for the next run and counts it as an error or as deferred, and a verdict is never given from a partial look.
Every write it makes is conditional on the row being as it read it (status, anonymous flag, block reason and `updated_at`), so a request made again in the meantime, possibly anonymously, is never released or relabelled on a verdict reached for the old row; a write that finds the row changed is counted as skipped.
A row it looked at and left as it was moves to the back of the queue, so enough of them cannot fill every run and starve the ones behind.

The refusal means "recorded, waiting".
Printed as a failure with exit 1, it sent depositors into retry loops of their own.
That holds only when GitHub answered.
When the readiness check itself cannot run (no credential, a failed workflow deploy, an outage) the request is still recorded, but the route answers 503 `ci_check_unavailable` with no block reason instead of the pending 422, because the cause can be one the sweep does not cure: it reads the run list with the same credential and recovers when GitHub does, but it does not deploy the workflow, so a request recorded after a failed deploy waits for a run that nothing starts, and nothing promises that the request carries on.
The row is written with the pending reason, so `nemar dataset publish status` still shows it as waiting on validation; telling the two apart would take a stored marker, and is left as a follow-up.
The block-reason vocabulary is shared with the website and is not extended for it.

The maintainer decided that `nemar dataset publish request` reports a CI-pending refusal in the info style and exits 0, and that `nemar dataset publish status` shows a request in that state the same way.
A failed validation (`bids_validation_failed`), a missing minimum, a missing owner name, a request already open and every other refusal keep their text and exit 1.
An identifier finding is never a refusal of this command: the request is accepted, the screen runs after it, and a finding blocks the request later, which `nemar dataset publish status` and the requester's mail report.
The CLI does not wait, retry or poll: the server already records the request and owns the transition, and every re-request repeats the GitHub readiness check and rewrites the row, so a client-side loop (an earlier `--wait` re-requested every minute for up to 24 hours) is rejected.
The depositor checks validation with `nemar dataset ci <id>` and requests again if they would rather not wait for the sweep, and the upload's success output names both commands.
A re-request restates the anonymous flag, so the command printed for an anonymous depositor carries `--anonymous`, and a request that asked for anonymity and was not recorded as anonymous exits 1.
If validation fails, the sweep relabels the request `bids_validation_failed` and mails nobody; if a submission minimum fails when the sweep goes to release it, it re-blocks the request as `min_requirements_failed` and mails nobody either.
The text says where to look.

The pending state is `isCiPendingBlock` in `src/lib/publish-pending.ts`, guarded through the real CLI by `test/publish-pending-cli.test.ts` and `test/publish-status-pending-cli.test.ts`.

## Known gaps at release (review of 2026-10-10)

None blocks the release. Each is a place where the words promise a little more than the code does.

- **The request route and the sweep classify the latest run differently.** The route blocks on no runs,
  `failure` and an unfinished run, and lets every other conclusion through. The sweep releases only on
  `success` and keeps a recorded request blocked on `cancelled`, `timed_out` and `skipped`, "a later run
  decides" (its header says so). The shim run is about five seconds with a two-minute timeout, so the case
  is rare, but a request recorded as waiting whose latest run ends that way stays waiting until a push to
  the dataset starts another run, while the CLI says it continues automatically. A re-request passes.
  One shared classifier is the fix; the sweep's tally has no figure for requests that stay blocked, so
  these show as `errors=0`.
- **The 503 `ci_check_unavailable` cure is not the sweep's.** When the cause is a workflow that was never
  deployed, the sweep reads the run list, gets a 404 and counts an error each day; it does not deploy the
  workflow. The depositor's `publish status` still says the request continues automatically.
- **The notice promises mail that is sent once.** "You will be emailed if a check needs your attention"
  holds for the identifier-screen block mail, whose send failure is logged and dropped without a lease or a
  retry (the administrator mail has both).
- **A request released and then lost before the screen starts** (the Worker is killed between the sweep's
  release and `startScreenAndNotify`) is `requested` with no screen status, and no sweep looks for that.
- **An older installed CLI prints the bare word `ci_check_unavailable`** for the 503, because only this
  release's client leads with `message`.
