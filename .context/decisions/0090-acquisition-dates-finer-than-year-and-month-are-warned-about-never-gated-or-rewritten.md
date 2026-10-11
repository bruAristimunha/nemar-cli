# ADR 0090: Acquisition dates finer than year and month are warned about, and never gated or rewritten (policy B)

**Status:** accepted
**Date:** 2026-10-07
**Owner:** Seyed Yahya Shirazi

Epic #1610, issue #1616 (Phase 6).
Follows ADR 0085 (what gates and what a correction costs), ADR 0086 (the publication screen and its report contract) and ADR 0087 (the upload preflight), and records the maintainer's decision of 2026-10-07 on the policy those three state in one line each (the 2026-10-04 policy).

## Context

The scanner reports a recording's acquisition date at review severity and it never gates.
The date kinds are `edf-startdate`, `edf-recording-startdate` and `acq-time-dated` (`DATE_KINDS`, `shared/identifier-scan.ts`).
That was settled on 2026-10-04, in the Contributor Terms and in the scanner, and nothing about the gate changes here.

What was missing is that nobody is told.
The dataset owner of the platform states that an acquisition date finer than year and month can identify a participant when it is linked to other information, such as a clinic schedule or a diary.
The people who put data on NEMAR are the ones who can coarsen a date before it is copied anywhere, and until now neither the upload nor the publication request said a word about dates.
The verdict of a dataset with dates only is `dates-only`, which the gate treats as clear, so an uploader sees "clean" and an administrator is not asked anything.

Two policies were on the table.
Policy A coarsens every such date to year and month, in the scrub and in the importer.
Policy B keeps the date as it is and tells people.
The maintainer chose B on 2026-10-07 and asked that the warning be shown to the uploader, to the person who requests publication and to the administrator.

## Decision

**Policy B: a date finer than year and month stays a review-level finding that never gates and that nothing rewrites, and a fixed warning, produced from one definition, is shown wherever the finding's counts are shown.**

- **Nothing about a verdict changes.**
  `classifyDataset`, `screenGate`, the acknowledgment rules of ADR 0087 and the admin's recorded reason of ADR 0086 are untouched.
  A dataset with dates only is still `dates-only`, still `clear`, and still needs no acknowledgment: the warning is printed and the upload goes on.
  A dataset with dates and a finding of another kind is still `review` and needs the acknowledgment it needed.
  The warning is words beside the counts and decides nothing.
- **Nothing is rewritten.**
  No scrub rule, importer rule or scanner rule changes, and no dataset is edited.
  A rewrite of dates would change data content, and it would not be a privacy correction of a public record that anyone had asked for.
  The Data Contributor Terms put the duty to keep identifying information out of a deposit on the depositor (ADR 0086), and the warning is how the depositor is told about a kind of date that can identify.
- **One definition.**
  `dateWarningLines` in `shared/identifier-screen-report.ts` returns the warning from a scan, and nothing else in the repository spells the sentences.
  The first line states the count, the next four are fixed words:

  > Warning: acquisition dates finer than year and month were found in recording headers or scans tables (N entries).
  > NEMAR does not change them.
  > A date can help identify a participant when it is combined with other information.
  > Remove or coarsen any date that could identify someone before uploading or requesting publication.
  > Administrators are told of these findings when publication is requested.

  `N` is the sum of the counts of the date kinds, and `1 entry` in the singular; a scan that was incomplete read less than it could, so its count is a lower bound and says `at least N entries`.
  It is the only number, and the only variable part.
  The warning never carries a date, a value, a file name or a path, so it adds nothing to the kind and count lines beside it that those do not already show to the same readers (the report contract of ADR 0086, and the preflight of ADR 0087 for the uploader's own pipeline).
  The screen workflow's log in `nemarDatasets/.github` is public and prints no verdict by design, so that workflow does not print the warning either: it posts a report and the Worker words it.
  The last sentence says "told" and not "reviews": a publication request is mailed to the administrators with the warning, but nothing forces a person to read it, and an OpenNeuro import is approved by its own finalize step when the verdict is clear (see Consequences).
- **Only when there is one.**
  The warning appears exactly when at least one date-kind finding is counted, whatever the verdict: `dates-only`, `review`, `direct-identifiers`, or `unchecked`.
  A scan with no date finding prints no warning, and a count that is not a non-negative integer is ignored rather than added.
  One case stands in for a count: a `dates-only` verdict IS the scanner saying a date was found, so a `dates-only` state whose report does not read back, or whose counts were lost, still warns, with the count left out (`... scans tables.`).
  Silence there would be a depositor or an administrator not told, with nothing saying so.
  A stored report that does not read back is also logged by the Worker, in the parser's fixed word and never its text.
- **Where it is shown.**
  It is part of `describeScreen` and `describePreflight`, which are already the one place the screen's words are made, so it appears wherever those words do and nowhere else:
  1. The uploader: the identifier preflight of `nemar dataset upload` (and `--dry-run`), printed under the verdict, and printed again if the second screen, right before the create call, counts a different number of dates than the first.
  2. The person who requests publication: `nemar dataset publish status`, which prints the request's screen as stored, and the mail that tells a requester a direct identifier blocked the request.
  3. The administrator: the publication-request email, including a resend, and `nemar admin publish list`.
  The terminal prints the warning's lines in the warning color; which lines they are comes from `isDateWarningLine`, in the same module.
  No mail category, table or column is added.
- **The weekly report is unchanged.**
  The sweep's report (ADR 0088) already names date findings by their fixed kind words and counts for every dataset it lists, and counts the datasets whose verdict is `dates-only`.
  It is not a place a depositor reads, and a warning to administrators in a mail they get weekly adds nothing to what the kind words say.

## Consequences

- An uploader whose headers carry dates is told so every time, at no cost to the upload: no flag, no prompt.
  A pipeline that printed nothing for dates now prints five more lines.
- The requester learns of the finding when the screen has reported, not when the request is made: at request time the screen has not run, so there is no count and, by this decision, no warning.
  The requester is mailed only when the request is blocked, so for a request that is not blocked the place to see the warning is `nemar dataset publish status`, as for every other result.
  A mail to the requester for every result would be a new notification, and is left to the maintainer.
- The count is of findings, so a recording whose recording-identification field also holds a date counts twice, and a scans-table row counts once.
  It is a size, not a number of recordings.
- The scanner's test for "year only" is "1 January", so a date on the first of another month is counted, though it may already be coarsened to a month.
  The warning therefore errs toward saying more, and the advice in it ("coarsen") does not clear it for a depositor who coarsens to year and month: only a date of 1 January of its year stops being counted, and an EDF start-date field cannot hold a month alone.
  Changing the test, so that the first of any month counts as month precision, is a scanner change and the maintainer's call.
- The OpenNeuro importer approves any clear verdict itself (ADR 0089), and `dates-only` is clear, so a mirror whose headers carry dates is published with no person reading them.
  The administrators are mailed with the warning when the screen reports, concurrently with that approval, so for a mirror nobody can act first.
  Whether finalize should hold `dates-only` mirrors for an administrator is a gate change and needs an ADR of its own; this decision does not make it.
- The warning covers what the scanner reads: EDF and BDF headers and `_scans.tsv`.
  Its absence is not evidence that no date exists in BrainVision, EEGLAB or FIF headers, in sessions tables or in sidecars, which are counted as not screened and not read.
- A swap between kinds with the same total (a date removed from a header and one added to a scans table) is not warned about again by the second screen; only a different total is.
- The Worker deploys before the CLI is published: a new CLI against a Worker that predates this prints the preflight warning (it is made locally) but not the one in `publish status` or `admin publish list`, which come from the Worker's lines.
  An older CLI against a newer Worker prints the same lines in dim, as it prints every line.
- What an administrator can list today:
  the publication mail and `nemar admin publish list` name the date kinds and counts of each request;
  the weekly report and `GET /admin/identifier-sweep` list every dataset whose last verdict is `review` with its kinds and counts, date kinds included (the first 50 by id in the mail, all in the route), and count the datasets that are `dates-only` without naming them.
  Naming the `dates-only` datasets, for example in the route's facts, is a small addition when it is wanted; the triage of the sixteen scrubbed datasets is done outside the repository.
- The wording lives on `docs.nemar.org` too, in pages that are in a private repository and are not edited here; the pull request lists them.
- If the maintainer later chooses policy A, which coarsens dates to year and month, that is a new ADR: the scanner's date test, the scrub rules, the importer and the meaning of `dates-only` would change together, and this decision's warning would be reviewed with them.

## Alternatives considered

- **Policy A: coarsen dates to year and month.**
  It changes data that depositors own and that analyses may depend on, in every version, and it needs the scrub's machinery for every dataset with a date.
  The maintainer chose to inform first; A stays available.
- **Make `dates-only` need an acknowledgment.**
  An acknowledgment that ends in a flag in a pipeline is not a reading of the warning, and it would stop every pipeline for a finding that has never gated.
  The warning is printed every time instead, and the administrator's decision on the publication request is where a person answers.
- **A fixed notice at request time with no count.**
  It would appear whether or not a date exists, and the request is made before the screen has looked.
- **A new mail to the requester, or a new category for administrators.**
  The warning travels in the mail and the views that already exist, and a new mail needs a sending policy that this does not have.
- **Words in each surface.**
  Five hand-written copies of a sentence about privacy drift apart, which is the failure ADR 0086 closed for the verdicts.

## Receipts

- Definition and tests: `shared/identifier-screen-report.ts` (`dateWarningLines`), `test/identifier-screen-report.test.ts`.
- Surfaces: `test/upload-identifier-preflight-cli.test.ts`, `test/identifier-screen-cli.test.ts`, `backend/test/identifier-screen-flow.test.ts`, `backend/test/identifier-sweep-report.test.ts`.
- The policy of 2026-10-04: the scanner header comment and `DATE_KINDS`; ADR 0085 ("What gates").
- Epic #1610; this decision is Phase 6 (#1616).

## Amendment 2026-10-07 (#1616): what an accepted request is told

The maintainer decided that a publication request, once accepted, is answered with a neutral notice that names no finding, no verdict and no date warning: "Your request was received. NEMAR is checking publication eligibility. If every check passes, an administrator is notified to approve it. Run 'nemar dataset publish status <id>' to see where it stands."
It is `publicationRequestNotice` in `shared/identifier-screen-report.ts`, one sentence per line and the only place the sentences are spelled.
`nemar dataset publish request` prints it, and `POST /datasets/:id/publish/request` returns the same lines as `request_notice`, for a new request and for the re-request of a blocked one (the open row is reused), whatever state the screen is in when the answer is written.
A request refused up front (400, 403, 404, 409, 422) keeps its own text and carries no notice, and so does the 409 for a request that is already open: it is a refusal, and by then the screen may have reported, so the notice could be stale.

This is not the "fixed notice at request time" rejected above, which would have been about dates.
The date warning still stays out of the request: the screen runs after it, its verdict is bound to a commit, and a result shown now could mislead.
The requester learns the outcome, with the warning if a date was counted, from `nemar dataset publish status` or the mail, as before.

The notice replaces two CLI lines, "Admins will be notified when the identifier screen finishes" and "Admins have been notified", which depended on the screen's state.
The CLI prints the notice from the shared definition and does not read `request_notice`, so any Worker that accepts the request gets the same words.

Two consequences the maintainer chose by asking for one answer whatever the state.
"If every check passes" is true and not complete: the admins are mailed for every reported result, including a request a direct finding blocks (the requester is mailed too), a review or incomplete result, and a screen that did not run.
And in the two states where nothing is running, a screen that could not be started and an exempt sandbox exemplar, the notice sits beside the Phase 4 headline that says so ("DID NOT RUN", "not applicable (sandbox)") and the admins have already been mailed.

## Amendment 2026-10-07 (Phase 9): new data has its dates set, and this warning covers what remains

The maintainer decided on 2026-10-07 that the day-level acquisition date of NEW uploads and imports is removed automatically, with no warning or acknowledgment for what the tool fixes; ADR 0091 records the rule.
For new data, "Nothing is rewritten" above no longer holds: a first import sets the dates the scanner reads in EDF and BDF headers and in inline scans tables to 1 January of their year, and `nemar dataset upload` does the same for headers it can change safely, printing one count line.
Everything else in this decision stands.
The gate, the verdicts and the acknowledgment rules are unchanged; the warning, its one definition and its surfaces are unchanged; and datasets already on NEMAR keep their dates and this warning.
The warning now appears only for date findings that remain after ADR 0091's rule (a layout the rule leaves, a recording the upload could not change, an upload's scans table, a dataset published before), so "NEMAR does not change them" is said only of dates NEMAR did not change.

## Amendment 2026-10-07 (#1646): the notice says when the requester is emailed

The maintainer added one sentence to the notice, between the administrator sentence and the status pointer: "You will be emailed if a check needs your attention, and when an administrator decides."
`publicationRequestNotice` spells it, and `request_notice` carries it, so the notice has five lines: the four above, with that one inserted before "Run 'nemar dataset publish status <id>' to see where it stands."

The sentence promises only the mail the requester gets.
The identifier screen mails the requester when it blocks the request (`sendIdentifierScreenBlockedEmail`), and the approval and denial paths mail the requester when an administrator decides (`sendPublicationApprovedEmail`, `sendPublicationDeniedEmail`).
A clean screen mails the administrators and not the requester, so the notice does not say the requester is told when the checks complete.
The approval mail goes to the dataset owner, who is the requester except when an administrator requests on the owner's behalf.
