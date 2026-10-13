# ADR 0102: A publication request gets a derived verdict, and approving over a non-pass is the administrator's recorded act

**Status:** proposed
**Date:** 2026-10-12
**Owner:** Seyed Yahya Shirazi

Epic #1726, Phase 0 (#1727).
Takes the shape of ADR 0092 (a derived verdict from a Worker-gated model review)
and of ADR 0093 (an administrator queue, and an approval that is the administrator's own).
Builds on ADR 0086 (the identifier screen, its gate, its mail and its binding to a commit),
ADR 0026 (mechanical submission minimums), ADR 0080 (the web approval executor),
ADR 0065 (anonymous releases), and ADR 0053 and ADR 0054 (unknown is never green).
Retires the advisory pre-screen of ADR 0014, and narrows the "adequacy stays advisory" clause of ADR 0026 (section 10).
Prerequisite issues: #1737 before Phase 1; #1736 tracked beside this epic.
The analysis, the comparison with the pull-request review, the cost arithmetic,
the full vocabularies and the refined phase plan are in [`.context/publication-review-design.md`](../publication-review-design.md);
this ADR is the verdict.

The maintainer accepted the twelve recommendations of the first draft on 2026-10-12,
and amended calls 4 and 11 after an independent review (comments on #1726); this text records the amended decisions.

## Context

A publication request is checked today by parts that do not meet.
The submission minimums hard-block at request time (ADR 0026).
A request waits for its Brain Imaging Data Structure (BIDS) validation run before it is recorded as `requested`
(ADR 0086, amendment of 2026-10-07).
The identifier screen reads bytes in CI and reports kinds and counts in a closed vocabulary (ADR 0086).
An advisory pre-screen (ADR 0014) asks a model about the README, the name and the authors, and its result is shown to administrators.
The administrator then gets one email and approves or denies,
from a terminal or from a web button that dispatches an executor (ADR 0080).
Nothing combines those results into one answer, and nothing stops an approval that one of them would have questioned.

Six facts, each checked on 2026-10-12, shape the answer.

- **The identifier screen does not read the files a reviewer reads (#1736).**
  Its text rule runs only on text files under `sourcedata/` and `code/`,
  and its JSON key rule skips `dataset_description.json`, `participants.json`, and BIDS sidecars outside `sourcedata/`
  (`readCandidates` and `JSON_EXCLUDED` in `scripts/identifier-fleet-lib.ts`).
  The root README, CHANGES and LICENSE are seen only as paths.
  So "text the screen has cleared" does not include a byte of the text a model would be asked to judge.
- **The shared rules for prose are one pattern, and it examines only its first match (#1737).**
  For free text, `shared/identifier-scan.ts` has a single rule, a local user path,
  and `scanTextForLocalPaths` stops at the first match, so a generic account early in a text hides a real one later.
  No rule recognizes a name, an email address or a date in prose.
- **The pre-screen is live in production.**
  It is advisory, and it is switched on in production by a Worker secret that this repository does not record;
  the configuration file enables it only for the dev Worker.
  Its design is the reason it is replaced rather than extended:
  its callback address is taken from the dispatch payload, the text it sends is not fenced by a nonce,
  its output is free text, and it is dispatched at the same moment as the identifier screen, before any screen has reported.
- **Models already read submission prose.**
  Enrichment sends the README to a model, and so does the pre-screen; the output of both reaches people.
- **Approving a publication is not a GitHub act.**
  A pull request is approved on GitHub with the administrator's own token (ADR 0093).
  A publication is approved by calling `POST /admin/publish/:id/approve`,
  which runs the sixteen-step orchestrator, and its `publish_doi` step cannot be undone.
  The web executor (`approve-publication.yml`) runs `nemar admin publish approve <id> --yes`,
  so any gate has to live where `/approve` is answered, not only in a client.
- **The surfaces disagree already.**
  `nemar admin publish approve` lists its steps but not the screen before its prompt,
  so a screen refusal arrives after the administrator confirmed, and it exits 0 when an approval fails (#1581).
  The website sends a fixed empty body and shows no screen,
  so it can approve a request whose screen needs an acknowledgment only if the same administrator recorded that reason from a terminal first.

A publication request differs from a pull request in one more way.
ADR 0092 refuses to send a pull request on an unpublished or anonymous dataset to a model.
A publication request is the depositor asking that this exact content become public,
and that request, with the precedent of enrichment and the pre-screen, is what this ADR relies on to let a model read it.

## Decision

**Each publication request gets one verdict, derived by the Worker from the mechanical gates
and from a no-tools model review that runs only after the identifier screen has reported for the same commit,
and only on bytes the shared mechanical rules have just examined.
A non-pass needs the administrator's recorded override, a hard reason cannot be overridden,
nothing is denied automatically, and unknown is never green.**

### 1. What a review belongs to

- **A review is bound to the request, the commit and the kind of release.**
  `publication_reviews` holds one row per (`request_id`, `head_sha`, `anonymous`).
  `head_sha` is the commit of `main` the identifier screen reported (`ScreenReport.head`),
  so the review and the screen always read the same commit.
  `anonymous` is the request's flag at that time, because an anonymous release asks different questions.
  The version being published is the `Version` the review job reads from `dataset_description.json` at `head_sha`.
- **A verdict belongs to what it read, and is never carried over.**
  A push to `main` makes the screen stale, and ADR 0086's head check refuses approval then;
  re-running the screen reports a new head, which starts a new review row.
  A re-request resets the screen (`RESET_SCREEN_COLUMNS_SQL`),
  and its new result finds the existing row only when the commit and the flag are both unchanged.
  A denied request that is requested again is a new request and gets a new review.
  An override is recorded on the review row it was given for, so it cannot reach another commit's review.
- **The review in force is the newest row of the request
  whose `head_sha` equals the request's screened head and whose `anonymous` equals the request's flag.**
  Any other row is history, shown as such, never as the verdict.

### 2. The rule on what a model may receive

This rule is not negotiable, and nothing in this ADR or a later phase may weaken it.

- **The identifier screen stays mechanical.**
  `shared/identifier-scan.ts`, the closed vocabulary of `shared/identifier-screen-report.ts` and `describeScreen`
  remain the only judge of identifiers.
  Delegating any part of the identifier review to a model is out of scope.
- **A model never receives a header value, an identifier finding, a screen report, or data content.**
  Data content means recordings, any byte of a signal header, and every table file:
  no `.tsv` file reaches the model at all, header row included.
  The model is not told the screen's state, kinds or counts,
  and is not asked about privacy, identifiers or the depositors at all; its findings vocabulary has no such code.
- **The review starts only from a screen result, for that result's commit.**
  It is never dispatched at request time, in parallel with the screen, or before the screen reports.
  It runs when the screen's gate (`screenGate`) is `clear` or `acknowledge`;
  it does not run when the gate is `blocks` (the request is blocked), `wait`, or `rerun`.
- **Every byte sent to the model is examined by the shared mechanical rules immediately before it is sent.**
  Because the screen does not read the files the model reads, screen-first is the ORDERING rule,
  and a pre-send check is the CONTENT rule.
  The review job applies `scanTextForLocalPaths` to each text file and `scanJsonKeys` to each JSON document,
  over exactly the bytes it is about to send.
  A file with any finding, a file it cannot read in full, a file that is not valid UTF-8,
  and a root document that is an annexed link or pointer rather than text in git
  are withheld from the model whole.
  The evidence says which file classes were withheld, and the counts by finding kind in the screen's own vocabulary;
  a question that needs a withheld file cannot be better than unknown.
  Only the pre-send function can produce the input type the prompt builder accepts
  (a branded `ClearedText`, as ADR 0092 brands a parsed report), and a test keeps casts to it out of every other file.
- **What the pre-send check is, stated without overstatement.**
  The pre-send check applies the shared rules to the bytes sent.
  For README, CHANGES and LICENSE the only rule today is a local-user-path pattern that examines the first match only (#1737).
  It is a consistency control, not a privacy control.
  No rule recognizes a name, email address or date in prose.
  Fixing #1737 is a prerequisite of Phase 1; extending the screen to the root documents is #1736.
- **Why prose is sent at all.**
  Enrichment and the pre-screen already send this prose to a model in production,
  the depositor has asked for exactly this content to be made public,
  and the review's output is shown to administrators only.
  The policy pages must say that a model reads it (section 10 and the phase plan).

### 3. What the model is shown

- The root README, at most 24,000 characters, fenced; a longer file is cut and the cut is a fact.
  The README is the first present of `README.md`, `README`, `README.rst` and `README.txt`, the four forms BIDS allows, in the order `submission-gate.ts` already uses;
  the format makes no difference to the review, and a `.rst` or `.txt` README is read as text like the others.
- The BIDS-defined top-level keys of `dataset_description.json`, re-serialized, at most 16,000 characters
  (these include `EthicsApprovals`, `License`, `Authors`, `Funding`, `ReferencesAndLinks` and `SourceDatasets`, the fields the questions below turn on);
  any other key is counted and not shown.
- CHANGES, at most 8,000 characters, and the root LICENSE, at most 4,000, to compare with the `License` field.
- `participants.json`, the column descriptions, at most 8,000 characters.
- A structural summary the job computes from the tree, in counts and closed words only:
  subjects, sessions and recordings counted, the datatypes, the file formats folded into the preflight's closed list
  (`KNOWN_FORMATS`, the rest `.other`), and whether `derivatives/`, `sourcedata/` and `code/` exist.
  No path, file name, subject label or task label is sent, so no path text reaches the model and a path finding withholds nothing.
- Never: any `.tsv` file, any sidecar value, recordings, the contents of `sourcedata/`, `derivatives/` or `code/`,
  any document file, the depositor's NEMAR account, and the screen's result.

For an anonymous release (ADR 0065) the model is told the release is anonymous and that `Authors` is blinded by design;
the authors half of its question is answered by the fact that ADR 0065's inverted Authors rule passed.

### 4. What the model answers

- **No tools, one call, a schema-constrained answer**, exactly as in ADR 0092.
  Dataset text is untrusted: it sits in blocks fenced by a per-run random nonce,
  the platform's facts sit outside any fence, and an instruction found in the text sets `steering`.
  The model writes only a result per question, findings from a closed list, a short summary and the steering flag;
  it cannot write the evidence, the version, the model name, a reason or the verdict.
  Free text is reduced by `sanitizeNote`, and only its start is kept.
- **Four questions, each answered `pass`, `fail` or `unknown`:**
  - `complete_and_honest`: the README says what the data is, how it was collected and how to use it,
    and what it claims agrees with the structural summary;
  - `meets_standards`: the README, the description and the ethics statement meet the published submission standards
    beyond the mechanical floor, the ethics statement stating an approval or exemption (naming the approving body or a reference) rather than boilerplate,
    and the data's origin stated: when it derives from another dataset, a paper or a public archive, the source is named (`SourceDatasets`, `ReferencesAndLinks` or the README), and a license that conflicts with a named source is a finding;
  - `authors_and_license`: the authors are real people or named bodies, consistent between files,
    and the license is a recognized one, consistent between `License` and `LICENSE`;
  - `name_adequate`: the name describes this dataset (ADR 0014's adequacy question, above ADR 0026's 25-character floor).
- **Findings come from a closed list** declared in `shared/publication-review.ts`; the initial list is in the design note.
- **The model is `claude-haiku-5-5` at effort `high`**, named in a closed list so that a change is a reviewed code change,
  and checked by an offline calibration before the soak (design note).
  At the list prices checked on 2026-10-12 a typical review costs about $0.002 and the worst case about $0.01;
  the platform cap below bounds a day's worst case to about $0.50.

### 5. The derived verdict

- **Three outcomes.**
  `pass`: every input is clean, the model ran and passed every question, and no fact lowered an answer.
  `fail`: at least one reason of the fail class (below).
  `action_required`: any other reason, including a review that is running, did not run,
  did not report, could not read what it needed, or could not decide.
  There is no neutral outcome, and a review that could not run is never clean (ADR 0053, ADR 0054).
- **Every non-pass carries reasons from a closed vocabulary.**
  Each reason has a class, fail or unknown, which sets the outcome, and says what clears it.
  The table lives in `shared/publication-review.ts` with the words every surface shows.
- **Hard reasons: nothing clears them, and the approval is refused with the cure named.**
  They are exactly what an earlier decision already made unconditional, plus one amendment of call 4:
  - `request_blocked` (fail): the request's block reason is shown; the depositor fixes it and requests again;
  - `submission_minimum_failed` (fail): ADR 0026's minimums, evaluated by the review at the reviewed commit;
    the Worker then moves the request from `requested` to `blocked` with `min_requirements_failed`,
    the transition the blocked-request sweep already makes, so that the depositor can fix it and request again;
  - `identifier_screen_blocks` (fail): direct identifiers; the request is already blocked by ADR 0086;
  - `identifier_screen_not_run` and `identifier_screen_stale` (unknown): an administrator re-runs the screen;
  - `version_kept_after_anonymous_release` (fail): a named publication after an anonymous release of this dataset
    keeps the version the release used; the depositor bumps the version, which is cheap.
- **The screen's reason: cleared by ADR 0086's recorded acknowledgment, unchanged.**
  `identifier_screen_needs_acknowledgment` (unknown).
- **Every other reason: cleared by the administrator's override**,
  `--force` or the explicit confirmation in `next` and on the web page.
  - Fail class: `question_failed` (per question, with its findings), `steering_attempt`, `bids_failed_at_review`,
    `version_already_released` (a `dataset_versions` row exists for the version,
    or the tag `v<version>` exists and names a commit other than the reviewed head;
    a tag naming the reviewed head is a harmless re-run), and `version_malformed` (not `X.Y.Z`).
  - Unknown class: `review_not_started`, `review_running`, `review_did_not_report`, `review_limit_reached`,
    `review_could_not_run` (with the closed run-error word), `text_withheld`, `question_unknown`,
    `bids_unconcluded_at_review`, `version_missing` (the orchestrator would publish its default `1.0.0`),
    and `doi_state_unexpected` (the row carries a concept Digital Object Identifier (DOI)
    that no earlier anonymous release of this dataset reserved).
- **Facts overrule the model, and can only lower it.**
  A withheld or cut file makes every question that needs it at best `unknown`.
  A missing README fails `complete_and_honest`; a missing `License` fails `authors_and_license`;
  a name under 25 characters fails `name_adequate`; a placeholder author on a named release fails `authors_and_license`;
  a summary that counts no recordings makes `complete_and_honest` at best `unknown`.
  A report agrees with itself in the safe direction, as in ADR 0092:
  a finding that names a steering attempt sets the flag, and a question passed with a blocker against it becomes `unknown`.
- **The verdict is stored when decided and re-derived when used.**
  The queue, the detail view and the gate re-derive it from the stored report and the live facts
  (the request's state, its screen and acknowledgment, the `dataset_versions` rows, the concept DOI)
  and use the STRICTER of the two, so either can lower a verdict and neither can raise it (ADR 0093's rule).
  A stored report that no longer parses reads as `review_could_not_run` unless the column says `fail`.
- **Every rendering of a review carries one standing line:** "Not assessed: whether the text names the depositors."
  ADR 0065 leaves README, Funding, Acknowledgements and EthicsApprovals to the depositor to scrub, and the model is not asked.
- **Requests the submission gate exempts are not reviewed.**
  OpenNeuro mirrors and exemplars passed an upstream review (ADR 0014, ADR 0026),
  so the review is "not applicable" for them: no row, no gate, and ADR 0089's importer is unchanged.
  The predicate is a named wrapper, `publicationReviewApplies`, over `requiresUploaderName`,
  so that a change to the name rule cannot silently change the review's scope.

### 6. Order, triggers and the mail

- **The chain is request, BIDS, screen, review, mail.**
  A request is recorded `requested` only after BIDS validation and the minimums pass;
  the screen is dispatched then; when its result is stored (`storeScreenResult`) or an administrator's re-run reports,
  the Worker starts the review for that head if section 2 allows it.
- **The admin email waits for the review, as it waits for the screen, and cannot be lost.**
  While the flag is on, ADR 0086's mail lease is taken only when the screen is not pending
  and no review of the screened head is `dispatched` and younger than the review deadline.
  The review row is written before the screen callback tries the mail, so the two cannot race.
  Storing a review result tries the mail.
  A review that never reports is marked `unreported` by the watchdog, which mails it as such,
  and a late report re-arms the mail, as a late screen report does in `storeScreenResult`.
  The email gains one section, the review's headline and reasons in the shared words, with the next command.
  The worst case is the screen's 50 minutes, plus the review's 30, plus one 30-minute tick; the expected case is minutes.
- **A review starts again only from a new screen result, or by an administrator's `start`.**
  `start` restarts a row that was declined, errored, never reported, or is past its deadline,
  never one that is running or has a result.
- **No mail goes to the depositor about the review.**
  The depositor learns a decision from the denial or approval mail, as today.
  A typed comment from `next` (`c`) is the one new mail, and it carries only the administrator's words.

### 7. Store, workflow and limits

- **The table.** `publication_reviews`, one row per (`request_id`, `head_sha`, `anonymous`),
  with its state (`dispatched`, `reported`, `declined`, `errored`, `unreported`),
  its verdict (set exactly when decided), a closed `detail` word for a declined or errored row,
  the parsed report (never the callback body), the one-shot nonce and claim time, `attempts`,
  the override (who, when, and the reasons it was given for), and the timestamps.
  CHECK constraints in the manner of migration 0092 keep a state from being paired with the wrong kind of word.
  No foreign keys, as for `pr_reviews`; no column is added to `datasets` (ADR 0034).
  The column list is in the design note.
- **The contract.** `shared/publication-review.ts` declares the report and its branded parser,
  the evidence, the questions, the findings, the reasons with their class and what clears each, `verdictOf`,
  and `describePublicationReview`, which produces every sentence the surfaces show.
  The Worker parses at the door, before a byte is stored; the job validates with the same parser before it posts.
- **The reviewer.** `run-publication-review.yml` in `nemarDatasets/.github`,
  authored in this repository and deployed by whole-file copy,
  holds the only federated Anthropic identity for this review.
  It follows `run-pr-review.yml` step for step:
  mask the callback token first; validate every payload field; claim before anything is installed, minted or read;
  check out `nemarOrg/nemar-cli` at `main` for the script;
  mint a read-only token (contents and actions: read) for ONE dataset repository;
  fetch `main` as git data, shallow and blob-less, with `init` and `fetch` and never a checkout;
  refuse as `stale_head` when the fetched `main` is not the dispatched head;
  mint the OpenID Connect token last;
  give the model step the federated identity and the callback token, and no GitHub credential;
  report a failure after the claim through a dependency-free `curl` step;
  use one concurrency group per run; and print ids and fixed words only, because the log is public.
- **Where it departs from the pull-request review.**
  There is no GitHub event: the Worker starts the review from the screen result, so the App needs no new subscription.
  There is no pull-request text and no fork: the job reads `main` at the screened commit.
  Nothing is written to GitHub, so there is no republish pass.
  The claim checks, in the same conditional update that claims, that the review is the newest of its request,
  that the request is still `requested`, and that its screened head and flag are still the row's;
  a claim that cannot settle closes the attempt as `stale_head`, as in ADR 0092.
  The callback origin comes from the workflow's own table keyed by the environment's NAME, never from the payload.
  The token domain is `publication-review`;
  the routes are `/webhooks/publication-review-claim` and `/webhooks/publication-review-result`.
- **The watchdog.** `sweepPublicationReviews`, on the 30-minute tick, PRODUCTION ONLY like every other watchdog:
  a row `dispatched` for more than 30 minutes becomes `unreported`, its nonce kept so that a late report still lands,
  and its request's mail is tried.
  It runs whatever the flag says.
  The dev Worker never ages a row, so every surface reads a row dispatched longer ago than the deadline plus one tick
  as `review_did_not_report`, as ADR 0093 does.
- **Caps.** A depositor's requests may cost 5 model calls in any 24 hours and the platform 50,
  counted from `attempts` after the insert so that concurrent starts cannot all slip under (ADR 0092's ranking).
  Over a cap the row is `declined` (`review_limit_reached`).
  An administrator's `start` is held by the platform's cap only.
  There is no contributor tally and no override table:
  depositors are approved accounts (ADR 0040), publication requests are rare, and the cap is enough.
- **The flag, and what it does not switch** (call 11, amended).
  `PUBLICATION_REVIEW_ENABLED = "1"` is set in `[env.dev.vars]` and absent from `[vars]` of `backend/wrangler-sccn.toml`,
  so production is dark, and turning it on is a reviewed change to that file.
  The flag switches the model review and its gate, nothing else.
  The mechanical refusals ship unconditionally in Phase 2:
  a `blocked` request cannot be approved, and the ADR 0026 minimums refuse wherever they are evaluated, whatever the flag says.
  With the flag off, no review is started, the claim route refuses a new claim so that no model call is spent,
  the result route still stores a result whose run was already claimed (the call was spent, and the record stays honest),
  the watchdog still closes rows, the mail does not wait for a review,
  and a stored review is shown as advice and gates nothing.
- **Environment fences.** The dev Worker starts reviews only for the datasets it owns (`isDevOwnedDatasetId`),
  and production never for those; each Worker answers only from its own D1.
  The review mails administrators only, under the production-only fence of `getAdminEmailsForCategory`,
  and makes no write to `nemarDatasets`.
- **Credentials.** The only credential minted is the one-shot callback token,
  an HMAC over the review id and a nonce, spent by the result;
  it grants nothing beyond posting that review's report, and joins no revocation list (AGENTS.md).

### 8. What the administrator sees and may do

`nemar admin publish` takes the shape of `nemar admin pr-reviews` (ADR 0093).

- **`list`** keeps its filters and shows the review's outcome, or its state, beside the screen's headline;
  `--needs-me` keeps the requests an administrator can act on.
  A request with no review of its current commit reads `not reviewed`, which is not an error.
- **`show <dataset>`** prints the screen through `describeScreen`, then the review:
  the outcome, every reason with what clears it, the findings, the summary, the evidence counts,
  what the model was shown and what was withheld, the standing line, the model, the commit, the version, and the next command.
- **`start <dataset>`** and **`start --all`** start the review of the current screened commit,
  as ADR 0092's amendment of 2026-10-10 does; `--all` asks before spending and stops when the platform's cap is spent.
- **`approve <dataset>`** shows the screen, the review and the gate's state (`enforced`, `off` or `n/a`) before it asks.
  A hard reason refuses and names its cure.
  The screen's reason needs `--acknowledge-identifier-screen "<reason>"`, as today.
  Every other non-pass needs `--force`.
  `--yes` skips the question, never the reason and never the force.
  The override is sent with the id of the review shown and the reasons shown, so it attaches to what was shown or to nothing.
  Every failure exits non-zero (#1581).
- **`--skip-ci-check` keeps its meaning and gains a record.**
  It still skips the orchestrator's live `ci_check` step, and it is now written to the approval's audit row.
  It never clears a review reason: `bids_failed_at_review` and `bids_unconcluded_at_review` are about the reviewed commit,
  and need `--force`.
- **`next`** walks the requests that need a person, oldest first, one card each:
  dataset, depositor, release kind, version, the screen, a short read of the review,
  and, for a large dataset, the object count and the expected duration of the lock step.
  `y` approves from this terminal and runs the same loop as `approve` (a stopped run continues with `approve --resume`);
  `n` denies with a typed reason, which the depositor is mailed as today;
  `c` mails the depositor a typed message and leaves the request open;
  `d` shows the whole review; `s` skips; `q` stops.
  `y` is not offered for a card with a hard reason, and asks for the acknowledgment for the screen's reason.
  For any other non-pass `y` is refused unless the run was started with `--force`,
  and then it shows the reasons again and asks one more question, defaulting to no, that names them; `--yes` never answers it.
  This differs from ADR 0093 on purpose: there an uncertain or missing review only asks for confirmation,
  and here every non-pass needs the force path, because the act that follows publishes a DOI.
- **The web page shows the same words.**
  The Worker serves the review rendered by `describePublicationReview` beside `identifier_screen`
  in `GET /admin/publish/requests`, so the page renders the server's sentences.
  The small fixed vocabulary the page needs to decide by itself is declared once in `shared/contract/publication-review-copy.ts`,
  transcribed into `nemarOrg/website` and pinned by a drift test on each side (ADR 0045's pattern).
  A non-pass needs the same explicit confirmation on the page,
  sent as the review id and the reasons shown in `approve-dispatch`'s body.
- **The Worker is the gate; the command-line tool explains.**
  `/approve` and `approve-dispatch` run the review gate after ADR 0086's screen gate and before the request is marked `approving`,
  and refuse with 409 `publication_review_not_clear` and the shared words.
  The gate is skipped for a resumed run that has already started publishing, as the screen gate is (`hasStartedPublishing`).
  It refuses when the live reasons include one the recorded override was not given for,
  and it refuses when it cannot be evaluated (a read that fails, a fact it cannot establish), as `verifyScreenHead` does.
  The command-line interface (CLI) refuses earlier, with the same words, only when its caller would be the one deciding.
  It does not refuse when the Worker reports an override already recorded for the review in force,
  which is how the web executor's `--yes` run proceeds on the clicker's recorded confirmation,
  and it does not refuse a resume that has started publishing.
- **Records.**
  An override writes an audit row, `publication_review_overridden`, with the request, the review, the outcome and the reasons,
  as the screen acknowledgment does; `start` writes `publication_review_started`, as `pr_review_started` does.
  The approval's audit row records `review_gate` (`enforced`, `off` or `n/a`) and whether `--skip-ci-check` was used.

### 9. Who approves

- **The approver of record is the administrator who passed the gate:**
  the one whose credential called `/approve` from a terminal, or the one who claimed the web dispatch.
  An override and a screen acknowledgment are recorded with that administrator's id and what they were shown,
  and satisfy a later run only when that run is attributed to the same administrator;
  a run attributed to anyone else passes the gate on its own or not at all.
- **No Worker code path decides an approval or a denial.**
  The review never calls `/approve` or `/deny`, and nothing is denied automatically.
  The only status a review changes is the mechanical `requested` to `blocked` of section 5, which ADR 0026 already makes.
  An executor never decides: it carries out a decision someone made.
- **Making "attributed to" exact is Phase 3's, and its shape is set here.**
  Until then ADR 0080's lease-based attribution stands, with the gap #1604 describes:
  a terminal approval inside a live web lease is recorded as the clicker's, and could ride on the clicker's recorded override.
  The proposed fix is a dispatch token minted per claim and valid only while that claim's lease is live.
  The executor presents it on every `/approve` call of that run, one per batch and retry, so it cannot be single-use,
  and `approve-publication.yml` masks it as its first step, as `run-pr-review.yml` masks its token.
  The clicker is the approver only for a run that carries it; every other caller is recorded as themselves.
  It carries attribution and no authority, and joins no revocation list,
  because `resolveApprover` already re-checks the clicker's role and status at each use.
  The same token carries the `request_id` precondition of #1579 and authenticates the release endpoint of #1582.
  Phase 3 records the change in its own ADR, because it changes ADR 0080's decision 5.

### 10. Relations to earlier decisions

- **ADR 0014's pre-screen stays as it is until the review replaces it, and then retires.**
  Phase 1 dispatches the pre-screen only while `PUBLICATION_REVIEW_ENABLED` is off,
  so the deploy that turns the review on is the one that stops the pre-screen, with no gap and no overlap.
  Then, without waiting for the end of the epic, the operator deletes the production Worker secret `PRESCREEN_ENABLED`
  and disables `run-prescreen.yml` in `nemarDatasets/.github`.
  Removing the line from the configuration file alone would not turn production off, because production is lit by the secret.
  `PRESCREEN_CALLBACK_SECRET` stays, because it also signs the callback tokens
  of the identifier screen, the identifier sweep and the pull-request review.
  The pre-screen's callback handling and its dispatch code are removed once its workflow is gone;
  the `prescreen_*` columns stay for the rows that have them.
  On acceptance, ADR 0014's banner gains a note that its surviving advisory half is retired here.
- **ADR 0026 stands, narrowed in one clause.**
  Its minimums stay hard blocks, at the request and now also at the reviewed commit.
  "Adequacy stays LLM-advisory" becomes "adequacy is judged by the model review, and a non-pass needs the administrator's override",
  a speed bump the administrator can pass, never a denial.
  On acceptance ADR 0026 gains a note pointing here.
- **ADR 0086 stands.**
  Its gate, acknowledgment, binding and mail lease are unchanged;
  the mail now also waits for the review, which ADR 0086 gains as an amendment on acceptance.
- **ADR 0080 stands until Phase 3** (section 9).
- **ADR 0092 and ADR 0093 are the template**; section 7 lists where this departs from them.

### Failure modes, and what the administrator sees

Every one of these is `action_required` or a refusal, never a pass,
and each has a closed word and a sentence in the shared module.

| Where the chain stops | Recorded as | The administrator sees |
|---|---|---|
| The flag is off | no row | "not reviewed (the automated review is off)"; no review gate |
| The screen is pending, did not run, did not report, or is stale | no row | the screen's words and cure; the screen gate refuses |
| The screen blocks | no row; request `blocked` | `request_blocked`, `identifier_screen_blocks`; refused |
| A credential or the secret is missing | `errored` / `dispatch_unconfigured` | `review_could_not_run`; `start` once fixed |
| GitHub refuses or drops the dispatch | `errored` / `dispatch_failed`, fenced by nonce and `claimed_at IS NULL` | `review_could_not_run`; `start` |
| The dispatch is accepted and nothing runs | `unreported` after 30 minutes, or by time on dev | `review_did_not_report`; the mail says so |
| A newer review, a changed request or a moved head at the claim | `errored` / `stale_head`, not counted against the caps | the current row's state, or the screen's staleness |
| The claim answer is lost, or the Worker answers 5xx | the job fails after three tries; the row ages | `review_did_not_report` |
| Federation is refused or misconfigured | `errored` / `auth_failed` | `review_could_not_run` |
| `main` cannot be fetched, or a file cannot be read | `errored` / `evidence_unavailable`, or the file is withheld | `review_could_not_run`, or `text_withheld` |
| The model is unavailable, refuses, runs out of room, or returns nothing usable | `errored` / `model_*` | `review_could_not_run` |
| The report fails the parser | `errored` / `report_invalid` | `review_could_not_run` |
| The job fails after the claim | `errored` / `workflow_failed` | `review_could_not_run` |
| A cap is reached | `declined` / `review_limit_reached` | `review_limit_reached`; `start` |
| The gate cannot read a live fact | nothing stored | a refusal that names the fact, and says to try again |

## Consequences

- An administrator sees one outcome and its reasons for every request,
  in the same words in the email, the terminal and the web page,
  and cannot approve over a non-pass without saying so on the record.
- A model is in the approval path of every native publication as a gate the administrator can pass,
  never as a judge of identifiers and never as the last word,
  in place of the advisory pre-screen that is there today.
- The README, the description, CHANGES, LICENSE and `participants.json` of every native request
  go to a model before a person reads them, after the pre-send check, which for prose is a weak control.
  The policy pages must say so before the flag is on in production.
- Every dataset with a recording format the screen cannot parse (BrainVision, EEGLAB, FIF and others, ADR 0087)
  carries the screen's acknowledgment reason;
  the model still reviews it, and one recorded reason clears that reason without `--force`.
  How large a share of native requests that is has not been measured.
- A terminal can no longer approve a `blocked` request after re-running its screen, which it can today,
  and that holds whatever the flag says, because the mechanical refusals are unconditional.
- The email waits a few minutes longer while the flag is on.
- Accepted risks, stated so nobody rediscovers them:
  - **Prose that names a person.**
    No rule sees it, here or in the screen; the model is not asked; a person reading the README is the only check.
  - **A model wrong in the green direction.**
    A pass is a model's opinion that facts could not contradict, not a certification.
  - **Override fatigue.**
    A model that is often wrong teaches administrators to pass `--force`; the calibration and the soak measure it first.
  - **The interim attribution gap** of section 9, closed by Phase 3, which is why production stays dark until Phase 3 ships.
  - **The allow path is not exercised live before production.**
    The soak denies every request it makes, so the first live approval through the gate happens in production.

## Alternatives considered

- **Read a verdict from the model.**
  The one field an injected instruction would target, refused by ADR 0092 for the same reason.
- **A workflow in each dataset repository.**
  A collaborator can edit it on a branch, the federation rule would have to trust every repository,
  and it would be rolled out to about 785 of them (ADR 0020).
- **Let the model review the identifier findings, or ask it about privacy.**
  Out of scope; and a model's silence about privacy would read as a clean bill.
- **Trust the screen's verdict as clearing the text (the literal screen-first option).**
  The screen does not read those files, so the rule would be true by name only;
  it is kept as the ordering rule and replaced as the content rule.
- **Run the model only when the screen is `clear`.**
  Would leave every dataset in a format the screen cannot parse without a review,
  while protecting nothing the pre-send check does not.
- **Keep the pre-screen beside the review, or extend it.**
  Two model calls about the same text, one of them outside every rule of section 2, and two answers that can disagree;
  its weaknesses (Context) are why it is replaced.
- **Deny automatically on a model fail or a hard fact.**
  A model can be wrong, and a hard fact already refuses approval.
  A failed minimum re-blocks the request mechanically, which is what lets the depositor fix it and request again,
  and a screen that did not run or is stale is re-run by an administrator; nothing is denied.
- **Enforce the gate in the CLI only, as ADR 0093 does for pull requests.**
  A pull-request approval happens on GitHub with the administrator's own token;
  a publication approval is answered by the Worker, which the web path and any other client reach without the CLI.
- **Show another commit's verdict with a warning.**
  A pass about other content is the mistake ADR 0093 exists to prevent.
- **A tally and an override table per depositor.**
  Depositors are approved accounts and requests are rare; the cap bounds spend.
- **Mail at the screen and again at the review.**
  Two mails per request, and the first asks for a decision before its information is in.

## Decided judgment calls

The maintainer decided all twelve on 2026-10-12, as recommended, and amended calls 4 and 11 after the review.

1. The model also runs when the screen needs an acknowledgment.
2. README and description prose is sent to a model, behind the pre-send check, with a notice on the policy pages;
   the basis is section 2's "Why prose is sent at all", not the strength of the check.
3. One recorded screen acknowledgment clears the screen's reason without `--force`.
4. (Amended.) The version facts need `--force`,
   except that a named publication after an anonymous release that keeps its version is hard;
   `version_already_released` fires only for a version row, or for a tag that names another commit than the reviewed head.
5. A `blocked` request cannot be approved from a terminal, unconditionally.
6. Haiku 5.5 at `high`, checked by an offline calibration before the soak (design note),
   and re-run on Sonnet 5.5 if more than one in five non-pass outcomes is judged wrong.
7. The mail waits for the review.
8. Depositors do not see the review in this epic.
9. Caps of 5 model calls per depositor and 50 per platform per day.
10. `y` in `next` runs the approval in the terminal, showing the object count and expected duration first for a large dataset.
11. (Amended.) The flag turns off the model review and its gate; the mechanical refusals do not depend on it.
12. Production is turned on only after Phases 3 and 4 have shipped.

## Before it is switched on

1. Fix #1737 before Phase 1 builds on it.
2. Create a federation rule and a service account of the review's own,
   accepting only `repo:nemarDatasets/.github:ref:refs/heads/main`
   with `job_workflow_ref` `nemarDatasets/.github/.github/workflows/run-publication-review.yml@refs/heads/main`,
   and named by organization variables of their own
   (`ANTHROPIC_PUBLICATION_REVIEW_FEDERATION_RULE_ID`, `ANTHROPIC_PUBLICATION_REVIEW_SERVICE_ACCOUNT_ID`);
   the organization and workspace variables are shared.
3. Release DARK to production first.
   The workflow checks its script out of `nemarOrg/nemar-cli` `main`, and the screen's design forbids a ref chosen by the payload,
   so the script must be on `main` before any run, the dev Worker's included.
   The same release declares the soak fixture in `DEV_OWNED_FIXTURE_IDS`, so production stops claiming it before it exists.
4. Deploy `run-publication-review.yml` by whole-file copy, and add it to the parity test's sparse checkout.
5. Soak against the dev Worker, on a native, named, private fixture that dev owns
   (ADR 0068 names `nm099997` as the next one; created only after step 3, and never approved under a name).
   A fix to the script found by the soak reaches the soak only through another production release.
6. Add the review's statement to the policy pages, after the separate docs change that corrects them for current practice.
7. Ship Phases 3 and 4, then add `PUBLICATION_REVIEW_ENABLED = "1"` to `[vars]`,
   delete the `PRESCREEN_ENABLED` secret and disable `run-prescreen.yml` (section 10),
   and run `nemar admin publish start --all` once for the requests already open.

## Receipts

- Epic #1726 and this phase, #1727; the decisions and amendments in the epic's comments of 2026-10-12;
  prerequisites #1736 and #1737;
  approval issues #1579, #1581, #1582, #1583, #1603, #1604, and their neighbours #1580 and #1584.
- The screen's coverage: `readCandidates` and `JSON_EXCLUDED` in `scripts/identifier-fleet-lib.ts`;
  the rules in `shared/identifier-scan.ts`.
- The template: `shared/pr-review.ts`, `backend/src/services/pr-review.ts`, `backend/src/routes/callbacks/pr-review.ts`,
  migrations 0092 and 0095, `.github/dataset-workflows/run-pr-review.yml`, `scripts/ci/pr-review*.ts`,
  `src/commands/admin-pr-reviews.ts`, `src/lib/pr-review-*.ts`.
- The approval path: `backend/src/routes/admin/publish.ts`, `backend/src/services/publication-orchestrator.ts`,
  `backend/src/services/identifier-screen.ts`, `backend/src/services/approval-dispatch.ts`,
  `backend/src/services/github/contents.ts` (`createTag`), `src/commands/admin.ts`, `src/lib/api/publish.ts`.
