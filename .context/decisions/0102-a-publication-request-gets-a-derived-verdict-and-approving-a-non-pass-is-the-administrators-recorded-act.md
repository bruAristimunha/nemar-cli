# ADR 0102: A publication request gets a derived verdict, and approving over a non-pass is the administrator's recorded act

**Status:** proposed
**Date:** 2026-10-12
**Owner:** Seyed Yahya Shirazi

Epic #1726, Phase 0 (#1727).
Takes the shape of Architecture Decision Record (ADR) 0092 (a derived verdict from a Worker-gated model review)
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
The identifier screen reads bytes in continuous integration (CI) and reports kinds and counts in a closed vocabulary (ADR 0086).
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
  The scanned string is the sent string.
  The job normalizes each document first: default-ignorable and invisible code points (variation selectors, Hangul fillers and the like) and lone surrogates are removed,
  the text is put into Unicode form NFKC (so a fullwidth slash or letter is seen as the person and the model read it),
  and the shared `tidy` cleans the rest.
  The input of that step is bounded, and a document with a run of more than 64 combining marks is withheld,
  because NFKC is quadratic on such a run and real text never has one.
  The job then applies `scanTextForLocalPaths` to each text file and `scanJsonKeys` to each JSON document,
  and for a JSON document to every key and every string one by one, with local rules for a `file:` URL, a drive path and a UNC path,
  over exactly the normalized bytes it is about to send.
  A file with any finding, a file it cannot read in full, a file that is not valid UTF-8 (a NUL byte is not text),
  a JSON document nested deeper than 32 levels,
  and a root document that is an annexed link or pointer rather than text in git
  are withheld from the model whole.
  A `dataset_description.json` with a NUL byte is the one exception to the NUL rule: it stays present, fails the ADR 0026 minimums as JSON that does not parse,
  and is not sent, so a depositor still hits the hard refusal and not an overridable one.
  The evidence says which file classes were withheld, and the counts by finding kind in the screen's own vocabulary;
  a question that needs a withheld file cannot be better than unknown.
  Only the pre-send function can produce the input type the prompt builder accepts
  (a branded `ClearedText`, as ADR 0092 brands a parsed report), a test keeps casts to it out of every other file,
  and the prompt builder also checks at run time that pre-send cleared each document string it is given
  (pre-send keeps a digest of each string it clears, never the text), because a lexical test cannot see a cast through a type predicate, a generic or `JSON.parse`.
- **What the pre-send check is, stated without overstatement.**
  The pre-send check applies the shared rules to the bytes sent.
  For README, CHANGES and LICENSE the only rule today is a local-user-path pattern that examines every match (#1737);
  the `file:`, drive and UNC forms are checked in JSON strings and keys only, so `C:/Users/x` in a README passes.
  Lookalikes that NFKC does not fold to ASCII (a division slash, a Cyrillic letter) are not seen in any document.
  It is a consistency control, not a privacy control.
  No rule recognizes a name, email address or date in prose.
  Extending the screen to the root documents is #1736.
  The input limit and the cost bound assume about four characters to a token; adversarial text can cost more,
  the application programming interface (API)'s refusal of an oversize call is `model_invalid`, and the daily caps bound the cost either way.
- **Why prose is sent at all.**
  Enrichment and the pre-screen already send this prose to a model in production,
  the depositor has asked for exactly this content to be made public,
  and the review's output is shown to administrators only.
  The policy pages must say that a model reads it (section 10 and the phase plan).

### 3. What the model is shown

- The root README, at most 24,000 characters, fenced; a longer file is cut and the cut is a fact.
  The README is the first present of `README.md`, `README`, `README.rst` and `README.txt`, the four forms BIDS allows, in that order (one shared list, `shared/readme-candidates.ts`);
  the format makes no difference to the review, and a `.rst` or `.txt` README is read as text like the others.
- The BIDS-defined top-level keys of `dataset_description.json`, re-serialized, at most 16,000 characters
  (these include `EthicsApprovals`, `License`, `Authors`, `Funding`, `ReferencesAndLinks` and `SourceDatasets`, the fields the questions below turn on);
  any other key is counted and not shown.
- CHANGES, at most 8,000 characters, and the root LICENSE, at most 4,000, to compare with the `License` field.
- `participants.json`, the column descriptions only, at most 8,000 characters:
  a count of columns and, for each column in the file's order, the string fields `LongName`, `Description` and `Units`, each capped,
  and never a column's name, a `Levels` value or any per-participant value;
  the system prompt names the block and says it holds column descriptions only.
  The whole file is withheld when a column name is a study code (`sub01`, `S01`, `P001`, `participant_01`, a pure number), is longer than 64 characters or names an identifier,
  and as unreadable when it holds more than 200 columns or is not an object of objects (a subject-keyed file).
- A structural summary the job computes from the tree, in counts and closed words only:
  subjects, sessions and recordings counted, the datatypes, the file formats folded into a closed list
  (the preflight's `KNOWN_FORMATS` plus `.edf` and `.bdf`, which the preflight counts as screened and so leaves out of that list; the rest `.other`),
  channel counts and sampling rates as deduplicated numbers read from a bounded sample of data sidecars,
  and whether `derivatives/`, `sourcedata/` and `code/` exist.
  No path, file name, subject label or task label is sent, so no path text reaches the model and a path finding withholds nothing.
- Never: any `.tsv` file, any raw sidecar value (a number derived from sidecars, as above, is a fact of the summary), recordings, the contents of `sourcedata/`, `derivatives/` or `code/`,
  any document file, the depositor's NEMAR account, and the screen's result.

For an anonymous release (ADR 0065) the model is told the release is anonymous and that `Authors` is blinded by design;
the authors half of its question is answered by the fact that ADR 0065's inverted Authors rule passed.

### 4. What the model answers

- **No tools, one call, a schema-constrained answer**, exactly as in ADR 0092.
  Dataset text is untrusted: it sits in blocks fenced by a per-run random nonce,
  the platform's facts sit outside any fence in a block tagged with the same nonce, and only that exact tag is trusted,
  so a facts-like block inside a document is text; an instruction found in the text sets `steering`.
  The model writes only a result per question, findings from a closed list, a short summary and the steering flag;
  it cannot write the evidence, the version, the model name, a reason or the verdict.
  Free text is reduced by `sanitizeNote`, and only its start is kept.
  Every finding the model returns is validated, and the steering and blocker rules apply to all of them before the list is cut to eight,
  with those findings kept first, so a steering attempt or a blocker buried past the cap still counts, and an invalid finding past the cap still refuses the output.
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
  They are what an earlier decision already made unconditional, one amendment of call 4, and the pending screen:
  - `request_blocked` (fail): the request's block reason is shown; the depositor fixes it and requests again;
  - `submission_minimum_failed` (fail): ADR 0026's minimums, evaluated by the review at the reviewed commit;
    the Worker then moves the request from `requested` to `blocked` with `min_requirements_failed`,
    the transition the blocked-request sweep already makes, so that the depositor can fix it and request again;
  - `identifier_screen_blocks` (fail): direct identifiers; the request is already blocked by ADR 0086;
  - `identifier_screen_not_run` and `identifier_screen_stale` (unknown): an administrator re-runs the screen;
  - `identifier_screen_pending` (unknown): the screen is still running; nothing clears it but its result,
    and the review starts when it reports;
  - `version_kept_after_anonymous_release` (fail): a named publication after an anonymous release of this dataset
    keeps the version the release used; the depositor bumps the version, which is cheap.
- **The screen's reason: cleared by ADR 0086's recorded acknowledgment, unchanged.**
  `identifier_screen_needs_acknowledgment` (unknown).
- **Every other reason: cleared by the administrator's override**,
  `--force` or the explicit confirmation in `next` and on the web page.
  - Fail class: `question_failed` (per question, with its findings), `steering_attempt`, `bids_failed_at_review`,
    `version_already_released` (a `dataset_versions` row exists for the version,
    or the tag `v<version>` exists and names a commit other than the reviewed head;
    a tag naming the reviewed head is a harmless re-run), `version_malformed` (not `X.Y.Z`),
    and `stored_verdict_fail` (the stored review concluded `fail` and its report no longer shows why;
    a person reads the review's record).
  - Unknown class: `review_not_started`, `review_running`, `review_did_not_report`, `review_limit_reached`,
    `review_could_not_run` (with the closed run-error word), `text_withheld`, `question_unknown`,
    `bids_unconcluded_at_review`, `version_missing` (the orchestrator would publish its default `1.0.0`,
    so the release row, the earlier anonymous release and the tag `v1.0.0` are looked up as for an explicit Version,
    and only a Version that is malformed has no tag to look up),
    and `doi_state_unexpected` (the row carries a concept Digital Object Identifier (DOI)
    that no earlier anonymous release of this dataset reserved).
- **Facts overrule the model, and can only lower it.**
  A withheld or cut file makes every question that needs it at best `unknown`.
  A missing README fails `complete_and_honest`; a missing `License` fails `authors_and_license`;
  a name under 25 characters fails `name_adequate`; a placeholder author on a named release fails `authors_and_license`;
  a summary that counts no recordings makes `complete_and_honest` at best `unknown`.
  A fact that lowers an answer says so in a closed word and a shared sentence (`readme_absent`, `text_not_seen_in_full`, `no_recordings`,
  `license_field_missing`, `name_too_short`, `placeholder_author`), shown in the detail view as `fact_notes`,
  so a failure the model did not give is never worded as the reviewer's own.
  A report agrees with itself in the safe direction, as in ADR 0092:
  a finding that names a steering attempt sets the flag, and a question passed with a blocker against it becomes `unknown`;
  a failed question keeps at least one finding to read, and parsing a stored report again gives the same report.
- **The verdict is stored when decided and re-derived when used.**
  The queue, the detail view and the gate re-derive it from the stored report and the live facts
  (the request's state, its screen and acknowledgment, the `dataset_versions` rows, the concept DOI)
  and use the STRICTER of the two, so either can lower a verdict and neither can raise it (ADR 0093's rule).
  A stored report that no longer parses, or whose echoed commit or release kind differs from its row's,
  reads as `review_could_not_run` (`report_invalid`), and as `stored_verdict_fail` as well when the column says `fail`.
  Live facts (a release row, a tag, the concept DOI, an earlier anonymous release) are read only for a request that is `requested`,
  for one that is `blocked` and is not a run the owner-name check walked back (amendment, item 6),
  and for an `approving` run that stopped before it published (only the validation-only steps completed), which the gate checks again when it resumes and which has written neither a version row nor a DOI:
  a run that has started publishing has written its own version row and DOI, whether it is `approving` or has been walked back to `blocked` by the owner-name check (judgment call 5; amendment, item 6),
  and a request that is over shows its stored review only.
  A request that is not assessed (the review is off and no row exists, the request is over and has no row, a mirror or an exemplar)
  has no outcome and no reasons on any surface.
  A review that cannot be read says so and is never a pass: with the review on, a list row reads `unreadable` (action required, no reasons, one fixed headline)
  and the detail view answers 500 with a fixed sentence; with the review off it reads as not assessed.
  A cure that says to start a review is shown only for a request that is `requested`, because the start refuses any other;
  for an `approving` or `blocked` request the same reason is worded without it, and the next command is the approval or none.
  The evidence's tag rule: a Version that is malformed has the tag state `not_applicable` and every other Version has the tag state of the version the approval would publish.
  A report stored under an earlier rule (a missing Version with `not_applicable`) would now read as `review_could_not_run`; none exists, because the review is dark.
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
  the screen is dispatched then; once the screen's callback has stored its result (`storeScreenResult`, in the callback route, which starts the review after the store and before the mail)
  or an administrator's re-run reports, the Worker starts the review for that head if section 2 allows it.
- **The admin email waits for the review, as it waits for the screen, and cannot be lost.**
  While the flag is on, ADR 0086's mail lease is taken only when the screen is not pending
  and no review of the screened head is `dispatched` and younger than the review deadline.
  The review row is written before the screen callback tries the mail, so the two cannot race.
  Storing a review result tries the mail.
  A review that never reports is marked `unreported` by the watchdog, which mails it as such,
  and a late report re-arms the mail, as a late screen report does in `storeScreenResult`.
  The mail reads the review at the deadline, which the other surfaces do not (section 7):
  the lease frees a request's mail 30 minutes after the dispatch, and the mail it then sends says the review did not report,
  whether or not the watchdog has marked the row, so a mail never says `running` about a review that is past its deadline
  and is not mailed again;
  a report that lands afterwards, on a row still `dispatched` or one the watchdog marked `unreported`, re-arms the mail.
  An administrator's `start` after a mail has gone sends no second mail:
  the administrator who started the review reads its result with `show`.
  The depositor's resend of the reminder carries the same section, and while the mail is held for a review in flight
  the resend does not mark the mail as sent, so the review's own mail still goes.
  The email gains one section, the review's headline and reasons in the shared words, with the next command.
  It carries no model-written text: not the summary and not a finding's note, which only the detail view shows.
  The worst case is the screen's 50 minutes, plus the review's 30, plus one 30-minute tick; the expected case is minutes.
- **A review starts again only from a new screen result, or by an administrator's `start`.**
  `start` restarts a row that was declined, errored, never reported, or is past its deadline,
  never one that is running or has a result.
- **No mail goes to the depositor about the review.**
  The depositor learns a decision from the denial or approval mail, as today.
  A typed comment from `next` (`c`) is the one new mail.
  It is a fixed frame around the administrator's words and nothing of the review:
  a greeting with the depositor's username, the dataset id, a fixed paragraph, the administrator's escaped words,
  and a closing sentence that says the request stays open and, when the Worker has a reply address, invites a reply.

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
  It follows `run-pr-review.yml` with one deliberate reordering, and its steps run in this order:
  mask the callback token; validate every payload field; claim before anything is installed, minted or read;
  check the federation configuration;
  mint a read-only token (contents and actions: read) for ONE dataset repository;
  fetch `main` as git data, shallow and blob-less, with `init` and `fetch` and never a checkout,
  handing the token to each git command for that command alone, never writing it into the clone and unsetting it from the step's environment afterwards,
  prefetching in one batch exactly the blobs the script reads (the root documents and the sampled sidecars,
  chosen from `git ls-tree -r -z` so that a path git would quote is still found, by the same rule as the reader),
  because the model step holds no credential and cannot read lazily: the reader runs with lazy fetching off,
  so a blob the prefetch missed reads as unreadable and never as a network fetch; the step then records the fetched commit;
  read the BIDS validation runs of that commit (the one other step that holds the dataset token, because it needs it);
  only THEN check out `nemarOrg/nemar-cli` at `main` for the script, set up the runtime, and install its dependencies
  with `--frozen-lockfile --ignore-scripts`;
  mint the OpenID Connect token last;
  run the review, which gives the model step the federated identity and the callback token and no GitHub credential,
  and whose script refuses as `stale_head`, before it calls the model, when the fetched commit is not the dispatched head;
  report a failure after the claim through a dependency-free `curl` step;
  pin every third-party action to a full commit SHA;
  use one concurrency group per run; and print ids and fixed words only, because the log is public.
  What the order closes: code planted before the mint, install-time scripts, and the dataset token sitting in a configuration file.
  What it does not close: the pinned actions' own code; the callback token, which the dispatch payload carries in the event file that every step can read
  (the model step needs it to post, as in the pull-request review); and the mint action's post step, which the dependency tree's runtime code in the model step could reach.
  A two-job split that hands the clone over as an artifact was rejected, because the central repository's logs and artifacts are public and the clone is private dataset text.
  The head is compared in the script, before the model call but after the checkout and the install that follow the fetch,
  so a push to `main` in that gap still costs one model call; the approval's own head check (ADR 0086) still refuses a stale approval.
  The prefetch downloads each selected blob whole, because a missing blob cannot be sized beforehand;
  the reader's ceilings (4 MiB a document, 1 MiB a sidecar) apply after the download, and the job's 20-minute timeout is the only bound before it.
- **Where it departs from the pull-request review.**
  There is no GitHub event: the Worker starts the review from the screen result, so the App needs no new subscription.
  There is no pull-request text and no fork: the job reads `main` at the screened commit.
  Nothing is written to a dataset repository, so there is no republish pass.
  The claim checks, in the same conditional update that claims, that the request is still `requested`,
  that its flag and screened head are still the row's, and that the screen's gate is still clear or acknowledge
  (the unique key on the request, the head and the flag makes that row the review in force);
  a claim that cannot settle closes the attempt as `stale_head`, as in ADR 0092.
  The callback origin comes from the workflow's own table keyed by the environment's NAME, never from the payload.
  The token domain is `publication-review`;
  the routes are `/webhooks/publication-review-claim` and `/webhooks/publication-review-result`.
- **The watchdog.** `sweepPublicationReviews`, on the 30-minute tick, PRODUCTION ONLY like every other watchdog:
  a row `dispatched` for more than 30 minutes becomes `unreported`, its nonce kept so that a late report still lands,
  and its request's mail is tried.
  It runs whatever the flag says.
  The dev Worker never ages a row, so every surface reads a row dispatched longer ago than the deadline plus one tick
  as `review_did_not_report`, as ADR 0093 does; the admin mail is the one exception and reads the deadline itself (section 6).
  A result that arrives as the watchdog fires is never dropped:
  the store, the re-block of a failed minimum and the mail re-arm are one atomic batch, and the two states a result may land on,
  `dispatched` and `unreported`, are tried in that order (a row only moves from the first to the second).
- **Caps.** A depositor's requests may cost 5 model calls in any 24 hours and the platform 50,
  counted from `attempts` after the insert so that concurrent starts cannot all slip under (ADR 0092's ranking).
  `attempts` is one slot per attempt, and a restart of an attempt that reached a model adds one,
  so nothing that happens to an attempt (a decline, a failed dispatch, the watchdog giving up) lowers what the calls before it cost.
  An attempt counts when it is still `dispatched`, has reported, or took its claim and did not end in a word that says no model was reached;
  one nobody claimed (the workflow undeployed, Actions down) held no model, because the claim precedes any model spend, and does not count.
  Over a cap the row is `declined`, with the detail `depositor_limit` or `platform_limit`, both shown as `review_limit_reached`.
  An administrator's `start` is held by the platform's cap only; the call still counts toward the depositor's tally,
  because it costs the platform and bounds the depositor's own next request.
  There is no contributor tally and no override table:
  depositors are approved accounts (ADR 0040), publication requests are rare, and the cap is enough.
- **The flag, and what it does not switch** (call 11, amended).
  `PUBLICATION_REVIEW_ENABLED = "1"` is set in `[env.dev.vars]` and absent from `[vars]` of `backend/wrangler-sccn.toml`,
  so production is dark, and turning it on is a reviewed change to that file.
  The flag switches the review: whether one is started, its gate, the admin mail's wait for it and its section,
  and the hand-over from the advisory pre-screen (with the flag on, the pre-screen of ADR 0014 is not dispatched for a dataset the review applies to,
  so the deploy that turns the review on is the one that stops it); it switches nothing else.
  The mechanical refusals ship unconditionally in Phase 2:
  a `blocked` request cannot be approved unless the owner-name check blocked a run that has started publishing (amendment, item 6), and the ADR 0026 minimums refuse wherever they are evaluated, whatever the flag says.
  With the flag off, no review is started, the claim route refuses a new claim so that no model call is spent,
  the result route still stores the result of a run that took its claim (the call was spent, and the record stays honest),
  the watchdog still closes rows, the mail does not wait for a review,
  and a stored review is shown as advice and gates nothing.
  A report is stored only for a run that took its claim, whatever the flag says, because a report implies a model call
  and the claim precedes any spend; an error word is recorded whether or not a claim was taken,
  so that a failure before the claim (a payload the job could not validate, a fetch that failed) can be diagnosed.
  A request that is not assessed (the review is off and no row exists, the request is over and has no row, a mirror or an exemplar)
  has no outcome and no reasons on any surface, and is never shown as a pass or as action required.
- **The administrator's start.** `POST /admin/publish/:id/review/start` is a thin adapter over the one start path a screen result also takes.
  It accepts a bearer key, or a session cookie only from a NEMAR origin (the rule of `approve-dispatch`, because the call spends the platform's money).
  It answers 202 when a review was handed over (`dispatched`, `redispatched`) or its run stands (`dispatch_claimed`),
  409 with a closed code for a request that cannot be started as it stands (`review_disabled`, `not_applicable`, `not_owned_here`,
  `request_not_requested`, `screen_not_ready`, `running`, `has_result`, `platform_limit`),
  502 when the hand-over failed (`dispatch_failed`, `dispatch_unconfigured`), and 500 for a database fault.
  It writes the audit row `publication_review_started` for a start that is going; a failed audit write is logged and never fails the start.
  There is no route for `start --all`: that is a loop in the command-line interface (Phase 2).
- **Environment fences.** The dev Worker starts reviews only for the datasets it owns (`isDevOwnedDatasetId`),
  and production never for those; each Worker answers only from its own D1.
  The review mails administrators only, under the production-only fence of `getAdminEmailsForCategory`,
  and makes no write to a dataset repository: the one call it makes to GitHub is the dispatch of the workflow to the central repository.
- **Credentials.** The only credential minted is the one-shot callback token,
  an HMAC over the review id and a nonce, spent by the result;
  it grants nothing beyond posting that review's report, and joins no revocation list (AGENTS.md).
- **Bounds, in one place.** A document is read up to 4 MiB (`DOCUMENT_BYTE_CEILING`) and a sidecar up to 1 MiB;
  the model sees at most the caps of section 3 after normalization, a `participants.json` column's fields are cut at 100, 500 and 50 characters,
  the job samples at most 64 data sidecars and reduces them to at most 8 distinct sampling rates and 8 distinct channel counts,
  the watchdog takes at most 20 rows a tick, the job times out at 20 minutes, and the deadline for a report is 30.
  A request's live facts are read only while it is `requested` or `blocked`, or `approving` and stopped before it published, and never for a run that has started publishing (section 5).

### 8. What the administrator sees and may do

`nemar admin publish` takes the shape of `nemar admin pr-reviews` (ADR 0093).

- **`list`** keeps its filters and shows the review's headline and its reason codes on a line of their own under the screen's;
  `--needs-me` keeps the requests an administrator can act on (the ones the list marks `*`), and `--json` prints the response and nothing else on standard output.
  A request that is not assessed has no review line in `list`, and `show` says why (`not reviewed` or `not applicable`).
  With the review on, a request whose current commit has no review reads `action required` with the reason `review_not_started`, which is not an error: `start` is its cure.
- **`show <dataset>`** prints the screen through `describeScreen`, then the review:
  the outcome, every reason with what clears it, the findings, the summary, the evidence counts,
  what the model was shown and what was withheld, the standing line, the model, the commit, the version, and the next command.
- **`start <dataset>`** and **`start --all`** start the review of the current screened commit,
  as ADR 0092's amendment of 2026-10-10 does; `--all` asks before spending and stops when the platform's cap is spent.
- **`approve <dataset>`** shows the screen, the review and the gate's state (`enforced`, `off` or `n/a`) before it asks.
  The review block carries the evidence an administrator decides from, ahead of the standing line:
  what the model was shown and what was withheld for findings (the lines `show` prints, from the same helpers), and a pointer to `show`.
  The model's own summary and notes stay in `show`, under their labels.
  A hard reason refuses and names its cure.
  A stopped approval (`approving`, not yet publishing) behind a hard reason that the depositor must fix is also told it cannot be resumed and is to be denied,
  because the move to `blocked` in section 5 takes only a `requested` request.
  The screen's reason needs `--acknowledge-identifier-screen "<reason>"`, as today.
  Every other non-pass needs `--force`.
  `--yes` skips the question, never the reason and never the force.
  The override is sent with the id of the review shown and the reasons shown, so it attaches to what was shown or to nothing.
  Every failure exits non-zero, and so does a declined or cancelled confirmation of `approve`, `deny` and `start --all` (#1581);
  `next` is the exception, because its walk is interactive (Phase 2 amendment, item 12).
- **`--skip-ci-check` keeps its meaning and gains a record.**
  It still skips the orchestrator's live `ci_check` step,
  and it is now written to the approval's audit row and to a row of its own when the step is skipped (`publication_ci_check_skipped`),
  because a resumed run's final row says only what the call that finished it asked for.
  It never clears a review reason: `bids_failed_at_review` and `bids_unconcluded_at_review` are about the reviewed commit,
  and need `--force`.
- **`next`** walks the requests that need a person, oldest first, one card each:
  dataset, depositor, release kind, version, the screen, a short read of the review,
  and, for a large dataset (5,000 files or more), the file count and the number of calls the lock step takes, at 100 objects a call;
  no duration is claimed, because none has been measured.
  `y` approves from this terminal and runs the same loop as `approve` (a stopped run continues with `approve --resume`);
  `n` denies with a typed reason, which the depositor is mailed as today;
  `c` mails the depositor a typed message and leaves the request open;
  `d` shows the whole review; `s` skips; `q` stops.
  `y` is not offered for a card with a hard reason, and asks for the acknowledgment for the screen's reason.
  For any other non-pass `y` is refused unless the run was started with `--force`,
  and then it shows the reasons again and asks one more question, defaulting to no, that names them.
  `next` has no `--yes`, and the question cannot be answered by type-ahead (Phase 2 amendment, item 10).
  This differs from ADR 0093 on purpose: there an uncertain or missing review only asks for confirmation,
  and here every non-pass needs the force path, because the act that follows publishes a DOI.
- **The web page shows the same reasons, in words a page can use.**
  The list route carries each request's review as a summary (a headline, a tone, the closed reason codes, whether a start is offered, and ids), not as sentences;
  the sentences, the cures and the next command come from `GET /admin/publish/:id/review`, which renders `describePublicationReview`.
  The page fetches that detail for the request being decided and prints the Worker's words; it does not transcribe the reasons
  (Phase 4 decided: see the Phase 4 amendment, item 1).
  The small fixed vocabulary the page needs is words and closed vocabularies, never logic, and is declared once in `shared/contract/publication-review-copy.ts`
  (Phase 4 decided: see the Phase 4 amendment, item 4).
  A non-pass needs the same explicit confirmation on the page,
  sent as the review id and the reasons shown in `approve-dispatch`'s body.
- **The Worker is the gate; the command-line tool explains.**
  `/approve` and `approve-dispatch` run the review gate after ADR 0086's screen gate and before the request is marked `approving`,
  and refuse with 409 `publication_review_not_clear` and the shared words.
  The gate is skipped for a resumed run that has already started publishing, as the screen gate is (`publishingStanding`).
  It refuses when the live reasons include one the recorded override was not given for,
  and it refuses when it cannot be evaluated (a read that fails, a fact it cannot establish), as `verifyScreenHead` does.
  The command-line interface (CLI) refuses earlier, with the same words, only when its caller would be the one deciding.
  It does not refuse when the Worker reports an override already recorded for the review in force,
  which is how the web executor's `--yes` run proceeds on the clicker's recorded confirmation,
  and it does not refuse a resume that has started publishing.
- **Records.**
  An override writes an audit row, `publication_review_overridden`, with the request, the review, the outcome and the reasons,
  as the screen acknowledgment does; `start` writes `publication_review_started`, as `pr_review_started` does.
  The audit row is best effort when the review row holds the override, and the only record when there is no row to hold it (a terminal's override of `review_not_started`),
  so there a failed audit write refuses the approval as `unverified`.
  The approval's audit row records `review_gate` (`enforced`, `off` or `n/a`) and whether `--skip-ci-check` was used.

### 9. Who approves

- **The approver of record is the administrator who passed the gate:**
  the one whose credential called `/approve` from a terminal, or the one who claimed the web dispatch.
  An override and a screen acknowledgment are recorded with that administrator's id and what they were shown,
  and satisfy a later run only when that run is attributed to the same administrator;
  a run attributed to anyone else passes the gate on its own or not at all.
  Only the override is recorded last, after every gate has passed;
  it can remain on its row, bound to that review, those reasons and its approver, when a later check or the dispatch then fails.
  The screen's acknowledgment is recorded when the screen gate passes and stands on its own, so an approval the review then refuses leaves it on the record, as intended.
- **No Worker code path decides an approval or a denial.**
  The review never calls `/approve` or `/deny`, and nothing is denied automatically.
  The only status a review changes is the mechanical `requested` to `blocked` of section 5, which ADR 0026 already makes.
  An executor never decides: it carries out a decision someone made.
- **"Attributed to" is exact: a per-claim dispatch token proves that a run belongs to its click (Phase 3, ADR 0105).**
  A web click's claim gets a token derived from the claim's own columns (the dataset, the request, the clicker and the instant of the claim),
  signed with the callback secret under its own domain tag; the Worker stores none of it and there is no migration.
  The executor presents it in the header `X-Approval-Dispatch-Token` on every `/approve` call of that run, one per batch and retry, so it cannot be single-use,
  and `approve-publication.yml` masks it as its first step, as `run-pr-review.yml` masks its token.
  The clicker is the approver only for a call that presents a valid token while the claim's lease is live.
  A call with no token is recorded as its caller, whatever the lease says, and its approval takes the claim over.
  A stale or expired token is refused (409 `dispatch_superseded`, `dispatch_expired`) and never quietly downgraded to the caller.
  A call that carries a token may carry no override, no screen acknowledgment and no skipped CI check (409 `decision_with_dispatch_token`),
  because the first two were recorded at the click, under the clicker's id, and the third is a decision the click never made.
  So an override is recorded only under the credential that sent it, or at the clicker's own dispatch, and the Phase 2 stop-gap refusal is gone.
  The token carries attribution and no authority, and joins no revocation list,
  because `resolveApprover` re-checks the clicker's role and status at each use.
  The `request_id` precondition of #1579 is a field of its own in the body, and the token binds the request as well;
  the release endpoint of #1582 is authenticated by the token alone.
  ADR 0105 records the change, because it partially supersedes ADR 0080's decision 5.

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
- **ADR 0080 stands, except that its decision 5 (the fork on the lease) is partly superseded by ADR 0105** (section 9).
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
| A cap is reached | `declined` / `depositor_limit` or `platform_limit` | `review_limit_reached`; `start` |
| The gate cannot read a live fact, or cannot record an override | nothing stored | `unverified`: a refusal that says the review could not be checked, and to try again (its `fact` field names the check, and no client reads it) |

## Consequences

- An administrator sees one outcome and its reasons for every request,
  in the same words in the email and the terminal, and the same reasons on the web page
  (worded for a page, not a terminal: see the Phase 4 amendment),
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
  and that holds whatever the flag says, because the mechanical refusals are unconditional;
  a request that has started publishing is the exception, and is resumed (judgment call 5).
- The email waits a few minutes longer while the flag is on.
- Accepted risks, stated so nobody rediscovers them:
  - **Prose that names a person.**
    No rule sees it, here or in the screen; the model is not asked; a person reading the README is the only check.
  - **A model wrong in the green direction.**
    A pass is a model's opinion that facts could not contradict, not a certification.
  - **Override fatigue.**
    A model that is often wrong teaches administrators to pass `--force`; the calibration and the soak measure it first.
  - **The interim attribution gap** of section 9 is closed in code by Phase 3 (ADR 0105);
    production stays dark until the executor's workflow sends the token and that is verified on staging ("Before it is switched on", item 7).
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
5. (Amended.) A `blocked` request cannot be approved from a terminal, unconditionally, unless it has started publishing and was blocked for the owner-name reason (amendment, item 6):
   the owner-name check walks a request back to `blocked` on every call of a run, so a depositor who clears their name mid-run blocks a half-published run,
   and that run is resumed once the name is back, with no gate asked, as an `approving` one is (the detail's `started_publishing` is true for it).
6. Haiku 5.5 at `high`, checked by an offline calibration before the soak (design note),
   and re-run on Sonnet 5.5 if more than one in five non-pass outcomes is judged wrong.
7. The mail waits for the review.
8. Depositors do not see the review in this epic.
9. Caps of 5 model calls per depositor and 50 per platform per day.
10. (Amended.) `y` in `next` runs the approval in the terminal, showing the file count and the number of lock calls first for a large dataset.
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
7. Verify the attribution that Phase 3 fixed in code (#1604, ADR 0105), which production must not be lit without:
   the executor's workflow carries the maintainer's edit (it masks the dispatch token first, exports it for the approve step's process alone and never through `GITHUB_ENV`, installs the CLI that matches the environment, and releases the claim on failure);
   the audit query on staging shows every web approval attributed to the administrator who clicked
   (the `approval_dispatched` audit rows joined to `publication_requests.approved_by` for published requests;
   a mismatch is a candidate to read, not a violation, because a deliberate terminal takeover or a re-dispatch by another administrator also differs);
   and the maintainer's decision on the open question of a clicker who is no longer an active administrator is recorded in ADR 0105
   (today it records the question and that it is undecided).
8. Ship Phases 3 and 4, then add `PUBLICATION_REVIEW_ENABLED = "1"` to `[vars]`,
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
  `backend/src/services/github/contents.ts` (`createTag`), `src/lib/api/publish.ts`.
- Phase 2: the gate, `backend/src/services/publication-review-gate.ts`; the comment route, `backend/src/routes/admin/publish-comment.ts`;
  the commands, `src/commands/admin-publish.ts` and its `admin-publish-*.ts` siblings (the `publish` group left `src/commands/admin.ts`);
  their rules, `src/lib/publication-review-approve.ts`, `-display.ts`, `-next.ts` and `-queue.ts`.

## Amendment 2026-10-13 (#1729): Phase 2, what the approval gate and the commands decided

Phase 2 built the Worker's approval gate and `nemar admin publish list|show|start|approve|next`.
The text above was corrected in place where the built behavior made a sentence false or stale
(sections 5, 7, 8 and 9, the consequences, judgment calls 5 and 10, the receipts, and "Before it is switched on", which gained its item 7);
this amendment states the decisions it does not otherwise carry.
Where the two differ, this is the later text.

1. **The gate is the Worker's, and a client that skips the CLI cannot publish over a non-pass.**
   `evaluateApprovalReviewGate` decides and `recordApprovalOverride` records;
   `/approve` (through `runPublicationApproval`) and `approve-dispatch` both call them, and nothing else decides.
   In `/approve` the order is:
   a request that is `blocked` and has not started publishing, in the sense of item 6 (409 `request_blocked`);
   the approver of record (ADR 0080);
   an override sent inside a web approval (409 `override_inside_web_approval`, item 5; Phase 3 changed this: see the Phase 3 amendment);
   the identifier screen's gate;
   the review gate (409 `publication_review_not_clear`);
   the recording of the override;
   and a conditional move to `approving`, which refuses with 409 `request_changed` when the request was denied or re-blocked while it was being checked, and so never overwrites that change.
   In `approve-dispatch` the review gate follows the screen's state check and precedes the claim, so a refusal claims nothing,
   and the override is recorded after the screened commit has been checked against `main`,
   so an override is recorded only after every gate has passed;
   it can remain on its row, bound to that review, those reasons and its approver, when a later check or the dispatch then fails.

2. **The gate answers in a fixed order, with six refusal words.**
   With the flag off it reads nothing and passes (`off`).
   Otherwise it reads the request (a read that fails, or a request that is gone, refuses `unverified`),
   passes a mirror or an exemplar (`n/a`),
   and derives the review exactly as the detail view does.
   A hard reason refuses `hard_reason`, whatever the body says.
   With no override-class reason standing it passes, and an override in the body is ignored and not recorded.
   Otherwise an override in the body must name the review in force (`review_changed`) and every override-class reason that stands (`override_not_covering`),
   and `approve-dispatch` refuses one that has no review row to hold it (`no_review_row`);
   with no override in the body, the one on record counts only when it is this approver's and covers every reason, and otherwise the refusal is `needs_override`.
   Anything that throws after the request was read refuses `unverified`.
   `unverified` means the check could not be completed, and its sentence says the review "could not be checked",
   because it covers a read that failed and the recording of an override that failed;
   its `fact` field names the check (`request` or `review`), and no client reads it.
   The words are `REVIEW_GATE_REFUSALS` in `shared/publication-review.ts`.
   A refusal of a review the gate read carries the review's headline and every live reason in the shared words;
   `unverified` carries no reasons and no outcome, and so does the `review_changed` refusal that falls back after a re-read that failed.
   `request_blocked`, `request_changed` and `override_inside_web_approval` are 409 codes of their own, not refusal words of the gate
   (Phase 3 changed this: see the Phase 3 amendment).
   The gate reads no GitHub, so `identifier_screen_stale` is never derived from the review's own read;
   whether the screened commit is still `main` stays the identifier screen's gate's, which runs first.

3. **With the flag off the gate reads nothing, and production changes only by what no flag controls.**
   Those are:
   a `blocked` request that has not started publishing, or that is blocked for a reason other than the owner's name (item 6), cannot be approved (409 `request_blocked`);
   a `blocked` request that has started publishing for the owner-name reason (item 6) and is approved with `--resume` passes neither the screen's gate nor the review's gate,
   where before the phase the screen's gate ran on it;
   the `dataset_published` audit row gains `review_gate` and `skip_ci_check`;
   a skipped CI check and an administrator's comment each write an audit row of their own (`publication_ci_check_skipped`, `publication_request_commented`);
   a request that changed while an approval was being checked is refused (409 `request_changed`);
   an override sent with a session cookie to `/approve`, or inside a web approval, is refused (item 5; Phase 3 changed this: see the Phase 3 amendment);
   and the comment route exists (item 11).
   `publication_review_overridden` is written only when the gate is enforced, so never with the flag off.

4. **The override is given by reason code, to one review, as it was read.**
   It names the review id in force (null when there was no review row) and the override-class reason codes shown.
   A code covers its reason whatever its detail word, so an override for `question_failed` covers every question that fails,
   and a reason that comes up after the administrator read the review is not covered.
   The Worker records exactly the override-class codes that stand, not every code the body lists,
   so a code listed beyond what stands does not pre-cover a reason that comes up later on the same row.
   It is recorded by one conditional statement that pins the review row as the gate read it (`RECORD_OVERRIDE_SQL`: its state, its creation time and its decision time),
   so it attaches only to the result the administrator was shown, and zero changes refuse `review_changed`.
   A restart of a review clears the recorded override, because a restart is a new attempt.
   The override columns hold one administrator's act: another administrator's override of the same review replaces it,
   but only the override that administrator was shown: the statement pins `override_by` as the gate read it,
   so a call that read no override cannot overwrite one that landed after its read, and is refused `review_changed`.
   A recorded override counts only for a run attributed to the administrator who recorded it,
   and the same override sent on every call of a run is recorded once when a review row holds it.
   With no review row (a terminal's override of `review_not_started`) nothing is written to the review table and the audit row is the only record,
   so a failed audit write refuses `unverified`;
   `approve-dispatch` refuses that case as `no_review_row`, because the executor that follows reads the clicker's override off the row.
   The override is recorded before the request is marked `approving`, and that mark can still refuse `request_changed`:
   the override then stays on its row, bound to that review, those reasons and its approver.

5. **Who may send an override, and whose it is.**
   `/approve` accepts an override only with an API key and answers a session cookie 403 `origin_not_allowed`,
   because a cookie rides along with any cross-site request a browser can be made to send;
   this is the one slice of #1603 that Phase 2 needs, and the rest of #1603 stays in Phase 3 (Phase 3 built it: see the Phase 3 amendment).
   `approve-dispatch` accepts one under its own Origin rule.
   ADR 0080's attribution is unchanged and the gate inherits it:
   its approver is the approver of record in `/approve` and the clicker in `approve-dispatch`
   (Phase 3 changed this: see the Phase 3 amendment).
   Until Phase 3 fixes #1604, an override sent inside a live web lease by anyone but the clicker is refused (`override_inside_web_approval`),
   so none is recorded under another administrator's name,
   and a terminal approval inside that lease still rides on the clicker's own recorded override
   (Phase 3 changed this: see the Phase 3 amendment).
   The executor's account sends no override.
   Production must not be switched on before #1604 is fixed ("Before it is switched on", item 7)
   (Phase 3 changed this: see the Phase 3 amendment).

6. **A dispatched review is read by time while a request can still be gated, and the gate derives as the detail does.**
   For a request that is `requested` or `approving`, a row that is `dispatched` reads as `review_running` until the overdue window and as `review_did_not_report` after it;
   for any other status it reads as one that did not report.
   An `approving` request that has not started publishing is gated again when it resumes, so its review can still report before then,
   and a run that has started publishing is never gated again, so its reasons decide nothing.
   The detail, the list and the gate read a row one way, because the gate derives through the detail's own read (`readReviewContext`, `derivePublicationReview`);
   the admin mail alone reads the deadline itself (section 6).
   A run that has started publishing is told so, in the shared words, and its next command is `nemar admin publish approve <dataset> --resume`.
   The detail's `started_publishing` is true for such a run, including one that the owner-name check has walked back to `blocked`.
   A `blocked` request counts as having started publishing only when its block reason is the owner-name one (`owner_name_missing`) and a step after the validation-only ones has completed.
   A `blocked` request with any other reason is refused `request_blocked` however stale its recorded steps,
   because a re-request keeps `steps_completed`, and a request blocked again by the screen or the review would otherwise be resumed past every gate.
   Clearing the steps on a re-request is left to a follow-up.

7. **One rule decides whether a start is offered, and the detail carries what the commands decide from.**
   `startOffered` (`shared/publication-review.ts`) is the rule behind the detail's next command and the list summary's `start_offered`:
   the request is `requested`, the row is one a start can create or restart, a reason's cure is a start, and no hard reason stands.
   The list route adds the screen's part (a clear or acknowledgeable result for a commit), so `start --all` offers only what `show` would;
   the platform's allowance and the Worker's ownership of the dataset are the start route's to refuse, with a 409 that writes nothing.
   The detail also carries the request's screen in the list's own words, the acknowledgment on record (who and when, never why),
   the block reason when it is a plain word, `started_publishing` and `datasets.total_files`,
   so that `approve` and `next` decide from one read.
   Each reason in it also carries `line`, the whole reason in the shared words (the sentence, the detail in words and the cure),
   which a client prints and composes nothing from `detail`, whose closed words are not words for a person.
   The field is additive and optional, so a client that meets a Worker without it falls back to the sentence and the cure.

8. **`show` and `start`.**
   `show` also prints the four questions' answers, the platform facts that lowered one, the acknowledgment and the override on record, and the history, and `--json` prints the detail.
   The model's findings and summary are printed under labels that say who wrote them and that the depositor's text can steer them,
   and every string from the network passes `plain()`, which removes control, zero-width and bidirectional-override characters.
   `start --all` takes the requests that are `requested` and whose summary offers a start, oldest first, so that the platform's allowance serves the request that has waited longest;
   it takes `--dry-run`, `--yes` and `--json`, stops at the first `platform_limit` and reports how many it did not try, and refuses when every request says the review is off.
   Exit status 0 means a review is going or exists (a start, a run that is already running, a review that has reported);
   1 means anything else: any other refusal, a hand-over that failed, and for `--all` a cancelled run or any request that was not started, failed or was not tried.

9. **`approve` decides before it asks, from the detail it showed.**
   `decideApproval` (`src/lib/publication-review-approve.ts`) runs ten steps over the one detail the command read and printed.
   It refuses only where the Worker would, or where a flag that is the administrator's own act is missing (`--force`, `--acknowledge-identifier-screen`, `--resume`),
   and it shares `hardReasonsOf` and `uncoveredByOverride` with the gate, so what is hard and what an override covers is one rule.
   `--yes` is the answer to the confirmation and nothing else: `decideApproval` has no input for it.
   The override it sends is built only from the detail shown, the review id in force and exactly the override-class codes shown, never from a second read, and it is sent on every call of the run.
   A run that has started publishing is refused without `--resume`, because the Worker would start it over.
   A review the CLI cannot read, or a Worker that has none, is said so, and the approval goes on to the Worker, which decides.
   A recorded override that covers the reasons proceeds without `--force`, which is how the executor's `--yes` run goes on;
   `--force` where the gate is `off` or `n/a` changes nothing, and says so.
   When the Worker refuses a run the CLI let through (a reason that came up after the read, a record that is another administrator's),
   the refusal's reasons are printed in the shared words, with the command that shows the review.
   The limits a command checks before it sends (a denial's reason of at most 2,000 characters, an acknowledgment of 10 to 500, and the shape of a dataset id) have one home,
   `shared/publication-limits.ts`, which the Worker and the commands both read.

10. **`next` is a walk whose rules are tested without a terminal.**
    It takes `--force`, `--once` and `--dataset <id>`, and has no `--all` and no `--yes`.
    Its queue is the requests an administrator can act on, oldest first, and it reads the review once per card,
    so the card, `d` and an override come from one read.
    `y` is offered where `approve` would proceed, with the screen's acknowledgment asked for on the spot;
    it is not offered for a blocked request, for a hard reason or, without `--force`, for a non-pass, and the card says why.
    The size line appears from 5,000 files and counts calls of 100 objects.
    In a terminal an answer is one line the person typed:
    what was typed before a card was shown is ignored,
    a reason or message that arrives with further lines is cancelled and sends nothing,
    and the extra question before approving over reasons cannot be answered by type-ahead;
    a piped run is a script, and its lines are its own answers, each lined up with the question it answers.
    The exit status is 0 when nothing failed;
    1 when an approval was refused or failed, a denial or a comment could not be sent, or the requests could not be read;
    and 130 after Ctrl+C.
    Skipping a request, leaving it open, declining the extra question and a `y` that the CLI itself refuses are not failures: they are the administrator's answers.

11. **The comment (`c`) is the administrator's words in a fixed frame.**
    `POST /admin/publish/:id/comment` takes `{ message }`, 1 to 2,000 characters once trimmed, and mails the depositor of the dataset's active request.
    The mail is a fixed frame around the escaped words (section 6) and carries nothing of the review, and the request stays as it is.
    The route is admin-only, accepts a session cookie only from a NEMAR origin because it mails a real person,
    and is not behind `PUBLICATION_REVIEW_ENABLED`, which switches the review and not a message an administrator types.
    The send goes through the environment's delivery fence, so outside production only an address on the allowlist is mailed, and a refusal is a failed send.
    A failed send is never answered as a success, and it is one of two kinds by what the Worker knows, both 502.
    `comment_not_sent` is for a send that certainly delivered nothing (the provider refused the message with a 4xx,
    the fence refused the recipient, the depositor has no address, or the depositor could not be read),
    and says so: "The message could not be mailed, so nothing was sent to the depositor."
    `comment_not_confirmed` is for a send that may have been accepted (a provider's server error, an unreachable host or a lost answer),
    and says that the mail may not have been sent and may also have arrived, and that the administrator is to check with the depositor before sending it again;
    it is never worded as "nothing was sent", because an administrator who read that might send it twice.
    The audit row, `publication_request_commented`, is written whichever way the send went,
    with the typed words and the outcome (`sent`, `not_sent` for the first kind of failure and `unknown` for the second), as a denial's reason is stored with its request.
    The classification is the one the identifier sweep's report makes of a failed send (`isCertainNonDelivery`).

12. **Every failure of the `publish` group exits non-zero.**
    That is #1581 for this group:
    `list`, `show`, `start`, `deny`, `screen`, `approve` and `next` exit 1 on any failure, including not being signed in, a refusal by the Worker and a network failure.
    `approve`, `deny` and `start --all` also exit 1 on a declined or cancelled confirmation, because they were asked to do one thing, nothing was done, and a script has to be able to tell.
    `next` does not: its walk is interactive, so a declined extra question, a skipped card and a `y` that the CLI itself refused are the administrator's answers, and it exits 0 for them (item 10).
    It exits 1 when an approval was refused or failed, a denial or a comment could not be sent, or the requests could not be read, and 130 after Ctrl+C.
    The hint to attach the log to a new issue is not printed where exit 1 is the command's own answer (a refusal the Worker made with a 4xx or a closed word, not being signed in, a declined confirmation),
    and is kept for a server error, a network failure and anything else that may be a bug.
    The other admin commands keep their exit-0 shape, which is left to a follow-up.

## Amendment 2026-10-13 (#1730): Phase 3, what changed for the review

Phase 3 made "attributed to" exact and guarded the approval path.
[ADR 0105](0105-a-web-approval-is-attributed-by-a-per-claim-dispatch-token-and-a-terminal-approval-takes-the-claim-over.md) records the decisions;
this amendment says what they changed for the review.
The text above was corrected in place where the built behavior made a sentence false
(section 9's last bullet, section 10, the accepted risk about attribution, and "Before it is switched on", item 7);
the statements of the Phase 2 amendment that Phase 3 replaced are marked and kept, so that its history stays readable.
Where the two differ, this is the later text.

1. **The stop-gap refusal is gone.**
   `override_inside_web_approval` is removed from the contract and nothing answers with it.
   Its guarantee, that an override is never recorded under another administrator's name, now comes from the attribution rule:
   an override or a screen acknowledgment is recorded only under the credential that sent it, or at the clicker's own dispatch.
   The ride on the clicker's recorded override, which Phase 2 left standing, is closed too.
   A terminal approval inside a live web claim presents no token, so it is recorded as its caller, needs its caller's own override,
   and once it has passed every gate it takes the claim over, so the executor the click dispatched is refused at its next call.
2. **The executor sends no decision, and the review's override reaches the run through the token.**
   A call that presents a valid token is recorded as the clicker, so the clicker's recorded override and acknowledgment count for it, as section 8 says of the executor's `--yes` run.
   Such a call may not carry a decision of its own: no override, no identifier screen acknowledgment and no skipped CI check.
   Any of the three is 409 `decision_with_dispatch_token`, and nothing is recorded.
   Only `skip_ci_check: true` counts: an explicit `false` is allowed, because the CLI sends it on every call.
   A skipped CI check is one of them because it is recorded under the approver, which for a token call is the clicker, and the click did not skip it.
   The executor workflow sends none of the three.
   `nemar admin publish approve` refuses `--force`, `--acknowledge-identifier-screen` and `--skip-ci-check` while `NEMAR_APPROVAL_DISPATCH_TOKEN` is set, before it sends anything.
   `next` never reads the variable.
3. **The order of the checks changes.**
   In `/approve` it is now: the outdated-client refusal (426), the request read (404), `request_mismatch`, `request_blocked`,
   the dispatch token (409 `dispatch_superseded`, `dispatch_expired`), the approver of record, `decision_with_dispatch_token`,
   then, for a run whose steps are all complete, the all-steps-done branch (item 6 below), which runs neither gate and records no override;
   for any other run, the identifier screen's gate, the review gate, the recording of the override, and the conditional mark.
   For a call with no token, the mark also clears the claim; for a call with a token, it marks only while the claim is still the one verified.
   In `approve-dispatch` it is: the dataset id for the environment (400 `invalid_dataset_id`), the body, the request read, `request_mismatch`,
   `not_dispatchable` for a blocked request, the screen's state, the review gate, the signing secret (502 `dispatch_unconfigured`), and then the claim;
   the override is still recorded last, after the head check.
4. **The words a client leads with grow.**
   The contract's list of approval refusals (`APPROVAL_REFUSAL_ERROR_CODES`) is now `publication_review_not_clear`, `request_blocked`, `request_changed`,
   `request_mismatch`, `dispatch_superseded`, `dispatch_expired`, `decision_with_dispatch_token`, `approval_in_flight`, `deny_after_publishing`, `invalid_dataset_id` and `approval_closed_during_run`,
   each with a sentence in the shared module.
   The 409 `approval_closed_during_run` is not `request_changed`: it says that the steps have run, and its sentence names the repair by hand.
5. **Deny's rules touch the review's states.**
   `/deny` takes the optional `request_id` and is refused while an approval is in flight, by the lease the dispatch route claims with:
   a web dispatch inside its fifteen minutes, or an `approving` request with a heartbeat inside them, unless it failed more than a minute ago (409 `approval_in_flight`).
   It is also refused once publishing has started, whatever the request's status or block reason (409 `deny_after_publishing`).
   That predicate is deliberately broader than the gate's `publishingStanding`, which will not trust the steps of a `requested` request or of a `blocked` one with another reason:
   the gate asks whether old steps may skip a check, and a denial asks whether anything irreversible has happened.
   So a `requested` request, with a review in any state, can be denied unless it carries steps beyond validation from an earlier approval (follow-up #1766);
   an `approving` request that stalled before it started publishing can be denied,
   which keeps the cure that section 8 names for a hard reason on a stopped approval;
   and a request that has started publishing cannot be denied.
   An `approving` one, and one the owner-name check walked back to `blocked`, is finished with `approve --resume`.
   A `requested` one may be finished by approving it, unless it carries every step: that is refused as closed (`approval_closed_during_run`) and repaired by hand.
   A `blocked` one with another reason waits for its depositor to fix what blocked it (follow-up #1766).
   The refusal's sentence promises none of these cures, and tells the administrator to check the dataset first.
   Started publishing means that a step beyond the validation-only ones has completed or is marked as the request's current step.
   The current step counts because a step is marked before it runs and stays marked when it fails or is interrupted, and the first mutation, `s3_public_read`, may have applied the bucket policy without a record.
   So a request whose first mutation failed stays undeniable until it is retried to completion or repaired by hand.
   The depositor's mail goes only after the denial is written.
6. **The final write is guarded, and a closed request is not marked published.**
   The write that ends an approval requires that the request is still `approving`.
   A run whose request was denied once its lease had lapsed, or was blocked again, answers 409 `approval_closed_during_run` and leaves one audit row, `approval_finished_on_closed_request`.
   A resumed run whose steps are all done follows the same rule, and refuses a request that is not `approving` before it runs any tail job, so a refusal never follows a write that cannot be taken back.
   When a tail job warns, that run leaves the request `approving`, so that approving again retries it,
   and answers `status: "approving"` with the warnings joined in the singular `warning`, the key the CLI prints.
   A missing `datasets` row, or a failed read of it, while the audit row is built is a warning and no row, never a guessed review gate.
   When none warns, it marks the request `published`, and only when that write changed the row it writes the `dataset_published` audit row, once, with the approver of record as its user (the clicker for a call under a token, with `executed_by` naming the caller) and the flag `finished_by_resume`.
   The step loop's closing path writes its `dataset_published` row on the same terms, only when its own write changed the request, so a publication has one row whichever call finished it.
   The step loop's own end has the same "approve again" dead end after a warning, which Phase 3 does not change: it is a known limit with a follow-up (ADR 0105, decision 12).
7. **None of this is behind the flag.**
   Item 3 of the Phase 2 amendment lists what production changes with `PUBLICATION_REVIEW_ENABLED` off.
   Phase 3 adds, also unconditionally: the dispatch token and the takeover, `request_id` on the three routes, the id rule of `approve-dispatch`,
   the token-authenticated release endpoint and `last_error` on the five early exits, the router-wide Origin guard, the deny rules and the guarded final write.
   The release notes say so.
8. **"Before it is switched on", item 7, is a verification, and one question stays open.**
   The code is fixed.
   What remains is the executor's workflow sending the token, which only the maintainer can change, and the staging audit query showing web approvals attributed to their clickers.
   A valid token whose clicker is no longer an active administrator falls back to the caller, as ADR 0080 decided, and the maintainer has not decided whether such a click should publish at all (ADR 0105).

## Amendment 2026-10-14 (#1731): Phase 4, what the web page decided

Phase 4 puts the review on the administrator's web approval page: the same reasons the command-line interface (CLI) prints, in words a reader with no terminal can act on.
The Worker half is in this repository and the page is in `nemarOrg/website`.
Section 8's bullet, which was titled "The web page shows the same words", was corrected in place and retitled, because it left the choice between fetching and transcribing to this phase
and promised the CLI's own words, which a page cannot print;
this amendment records the choice and what follows from it.
Where the two differ, this is the later text.
A sentence is called web-safe here when it names no terminal command, flag or placeholder and does not tell its reader to act in a terminal.

1. **The page fetches the detail and prints the Worker's words; it does not transcribe the reasons.**
   This is the choice section 8 left open.
   The cures change with the request (the dataset id, whether a start can reach it, the detail words of a failed question),
   so a transcription would be a second copy of every reason's sentence and of the rules that compose it, which is what ADR 0045's drift tests exist to catch,
   and `GET /admin/publish/:id/review` already derives them for one request in one read.
   The rule, in one line: **the page prints each reason's `statement` and `cure` (the `sentence` only as the fallback for an empty `statement`, which the Worker never sends), and never `command`, `line`, `description.lines`, `description.next` or a gate refusal's `message`.**
   The same holds for the words the Worker sends that are web-safe, which the page prints as they arrive:
   `description.headline`, the identifier screen's `headline` and `lines`, the facts' notes, the findings' labels,
   the `headline` of the 409 refusals of the review gate and of the identifier screen (printed above the page's own words for the refusal),
   the `message` of the five refusals that name no terminal step (`request_mismatch`, `invalid_dataset_id`, `origin_not_allowed`, `deny_after_publishing` and `approval_in_flight`),
   and the `error` of the review start's refusals.
   The model's own text is printed as text, never as markup, and only under its label.
   The page computes no verdict: whatever the Worker derived is what the page shows.

2. **A cure is a neutral sentence and, for eight reasons, a command; the split is additive.**
   `cureOf` and `REASONS[].cure` stay the terminal's text, byte for byte, because the CLI's output must not move.
   The neutral cure is a new function, `neutralCureOf`, which removes exactly the command and the `(--force)` flag;
   `commandOf` returns the command, and `reasonStatement` returns the reason in words, with the detail of the failed question.
   A first design made `cureOf` itself the neutral text; it was not used,
   because many existing tests read the composed terminal text through `cureOf` and `REASONS[].cure`, and the CLI's output must not move.
   Every existing test that pins that text stays green and unedited, except two old-Worker fixtures:
   the approve test for a hard reason (test 5) and the `next` test for a card that a Worker sent without a `line`.
   Both stand for a Worker that sent the terminal's text as `cure` and no `statement` or `command`, so they now rebuild their reasons that way with `cureOf`.
   The other test edits follow the one meaning that changed, or only add: the backend route tests that read `ReasonView.cure` on the wire now expect the neutral text,
   and a test helper and the depositor-mail test gain the new fields.
   On the wire, `ReasonView.cure` is neutral, which is the one meaning that changed;
   `command` and `statement` are added and are optional in the type, as `line` already is; `line` stays the CLI's text.
   A golden capture of the CLI's text, taken before the change, holds the terminal side.
   A web-safety test over the real producer of the detail holds the page's side, with one list of forbidden words (`test/helpers/terminal-words.ts`) in which `nemar ` is case-sensitive,
   because `NEMAR` appears legitimately in a reason sentence and in a screen line.
   A future caller who wants a sentence for a page and reaches for `cureOf` gets terminal text; the web-safety test over the producer is what guards that.

3. **The detail gains additive fields, and there is no migration.**
   They are `start_offered` (whether Start review is offered for this request), `screen_gate`, the reasons' `statement` and `command`, and a `label` and a `document_label` on the findings.
   `screen_gate` exists because with the review off `reasons` is empty while the identifier screen's gate still applies, which is production today;
   without it the page could not know whether an acknowledgment is needed.
   The two reason fields are tolerated as absent.
   A Worker that predates this phase sends the old `cure`, with a command inside it, and no `statement`;
   the page treats a missing `statement` as "this Worker predates the page" and withholds the reasons panel.
   It never prints `line` instead, because `line` is the CLI's text.
   The page treats the Worker as out of step with it, and withholds Approve and the reasons, for more than a missing `statement`:
   a missing `start_offered` or `screen_gate`, a `gate` or `screen_gate` word it does not know, a `request_id` that is not an integer, or an `anonymous` that is not a boolean.
   That is why `start_offered`, `screen_gate` and the finding labels are required in the contract's type while the website's copy of the type makes them optional:
   the website reads a Worker that may predate them, and this repository writes only the current one.

4. **The page-owned words are declared once, in `shared/contract/publication-review-copy.ts`, under ADR 0045's rules.**
   The table has 22 keys, in five groups: the review gate's six refusals (`gate.*`, by the `refusal` of a 409 `publication_review_not_clear`),
   the identifier screen's six refusals (`screen_gate.*`, by the `gate` of a 409 `identifier_screen_not_clear`),
   the approve control's four states (`approve.*`), the review's standing words and the labels on the model's text (`review.*`), and the three successes of a review start (`start.*`).
   A key exists only where the page cannot print the Worker's words: the Worker words a refusal for a terminal, or sends no sentence at all (the control's states, the standing words, the successes of a start).
   So the table does not repeat the words that are printed as they arrive and are pinned web-safe by the test of item 2;
   the refusals the page's existing friendly-message map already words (an unconfigured dispatch, an approval already running) stay there.
   A blocked request is not one of them: `not_dispatchable` is the mirrored key `approve.blocked`, and the map no longer carries it.
   Four Phase 3 codes have no key, `decision_with_dispatch_token`, `dispatch_superseded`, `dispatch_expired` and `approval_closed_during_run`:
   only `/approve` answers them and only the executor calls it, so a key would be copy with no reader.
   Every value is a complete sentence with no placeholder and no template, except the two labels on the model's text (`review.model_summary_label` and `review.model_findings_label`),
   which are phrases the page puts in parentheses after a heading.
   Each repository tests the same table against the other's copy, on the pattern of the account copy:
   here a test reads the website's file through an environment variable or a sibling checkout, with a strict mode when the variable is set and a visible skip when it is not,
   and tests the table against the code's own sentences and sets of words so that it cannot become dead copy.
   The strict mode is wired into the continuous integration workflow now that the website's file exists on its `staging` branch (#1787).

5. **What the page may do.**
   Approve, with the same explicit confirmation as the terminal: the review id and the reasons shown, sent in the body of `approve-dispatch`,
   and, when the screen's gate is `acknowledge`, a reason of 10 to 500 characters that is recorded with the administrator's account.
   Deny, and start the review.
   Approve and deny carry `request_id`, so a click is refused when the request it was for is no longer the active one.
   The start does not, because its route reads no body and acts on the request that is active;
   a start made after the request changed reviews the current request, which is harmless, and its own refusals cover a request that cannot be reviewed.
   The page offers no Approve for a hard reason, for a blocked request (even one walked back from a started run, because `approve-dispatch` refuses every blocked request),
   or when the screen's gate is `blocks`, `rerun` or `wait`.
   It never sends a body the route does not accept.

   Five choices of the page follow from that rule, each a decision of the page and not of the Worker.
   - **The acknowledgment is always asked for.**
     Whenever `screen_gate` is `acknowledge`, the page asks for the acknowledgment reason, even when this administrator's own acknowledgment is already on the row.
     The Worker would pass without it, and sending it again is accepted and recorded again;
     the page chooses a fresh recorded reason over inferring from the row what the Worker would accept.
   - **A stopped approval is offered as a fresh approve.**
     An `approving` request that stopped before it published is offered the typed confirmation, with an override or an acknowledgment when the gates need one,
     because the Worker gates a stopped run like a fresh one.
     The row's own button keeps its "Resume approval" label; only an approval that has started publishing is continued without the gates.
   - **No review row and no start: the page says so and offers no Approve.**
     When an override-class reason stands, no review row is on record to attach the override to, and the Worker offers no start (an `approving` request that never started publishing),
     the page prints its own line instead of the mirrored `gate.no_review_row`, which tells the reader to start a review.
     The case is rare, and the cure is a command-line step.
   - **A hard reason withholds Approve whatever the review's gate says.**
     The page withholds Approve for a reason that no override or acknowledgment clears, also when the review's gate is `off` or `n/a`.
     That is stricter than the Worker, which does not gate on an advice-only review.
     A reason whose `cleared_by` word the page does not know counts as hard, and an approval that has started publishing is exempt, because it passes no gate.
   - **There is no fallback to the old bodyless Approve.**
     When the detail cannot be read, or the API is older than the page, the page withholds Approve and says which of the two it is;
     it does not send the click the page sent before this phase.
     So the API deploys before the page, as item 3 requires.

6. **Staleness is learned from the refusals, not the detail.**
   The detail reads no GitHub, so it cannot say that the screen is stale;
   the page learns it from a 409 `identifier_screen_not_clear` with `gate: "stale"`, and learns that the review changed from `review_changed` and `request_mismatch`.
   Each gate or screen refusal is shown in the page's own words by item 4 (`request_mismatch` in the Worker's own sentence, which names no terminal),
   and the page reads the detail again by itself, so the administrator sees the current state without a reload.

7. **Left open.**
   The page has no control to run the identifier screen again; the Worker has the route, and an administrator uses the terminal for that one step.
   The `gate: "wait"` answer for an acknowledgment that lost a race says "wait" about a state that is not waiting, and `screen_gate.wait` is worded to cover both; a gate word of its own would widen a Phase 3 contract.
   Mailing the depositor a comment from the page is not done.
   The strict parity path was left out of the continuous integration workflow until the website file was on `staging`; it is there now (#1787).
   The executor workflow edit of Phase 3 stays the maintainer's, as the Phase 3 amendment says.
   `description.next` shows `nemar admin publish start <id>` for a clean sandbox (`xx`) request, although `start_offered` is false for it and the route refuses a start there.
   That is CLI behavior from before this phase, tracked in #1773, and the page never prints `description.next`.
   The neutral cure of a reason whose cure is "start it" has the same limit, because the cure and `command` decide from whether the request is `requested` alone, while `start_offered` also needs a restartable row, no hard reason standing, and a screen with a clear or acknowledgeable result and a head.
   So the cure can say to start the review while `start_offered` is false: beside any standing hard reason (the commonest case: `review_not_started` beside `submission_minimum_failed` or `identifier_screen_pending`), for a report that no longer parses (`review_could_not_run`, whose stored review is no longer restartable), for a sandbox request, and for a screen with no head.
   The page's Start button follows `start_offered` only, so it can print that cure beside no button.
   That is an intentional design choice: a code fix would give the neutral path its own input and leave `cureOf` byte for byte, a change this phase did not take on; it is also tracked in #1773.
   A sentence in AGENTS.md about the new copy file, beside the one on the account copy, is the maintainer's to write.
   The website is promoted to production only after the Worker that carries this phase, as item 3 requires.

## Amendment 2026-10-15 (#1726): what the integrated epic found in the review's own paths

Three reviews of the integrated branch found faults in how the review and the approval around it fail.
The text above was corrected in place only for the override's statement (section 9, item 4);
this amendment states what the rest changed.
Where the two differ, this is the later text.

1. **An override attaches to the override the administrator was shown, or to none.**
   `RECORD_OVERRIDE_SQL` pins `override_by` as the gate read it, beside the review's state, creation time and decision time.
   A call that read no override cannot overwrite one that landed after its read (a web click's, which its executor reads off the row), and is refused `review_changed`.
   An administrator who read another's override may still replace it on purpose, as a terminal approval takes a live claim over with its own override (ADR 0105, decision 6).
   The accepted residue is unchanged: an override recorded before a mark that then refuses stays on its row, bound to its review, reasons and approver.
2. **A claimed run cannot make its model call free.**
   `stale_head` means an attempt that never reached a model, and it gives the attempt's slot back to the caps.
   A job may post it, but only before it has claimed: the store of a result records `workflow_failed` in its place when `claimed_at` is set, in the same statement, so a claim that lands between the read and the write is seen.
   An unclaimed attempt keeps `stale_head` and stays free.
3. **A failed dispatch claim is released on every way out.**
   The web approval's claim is released if anything throws between the claim and the dispatch (a failed acknowledgment or override write, a failed read), not only on the failures the route names.
   From the moment the dispatch is attempted a throw keeps the claim, because the event may be queued.
4. **`nemar admin publish screen` exits 1 when the Worker answers 202 with status `error`.**
   The screen could not be started, nothing is running, and item 12 of the Phase 2 amendment (every failure exits non-zero) holds for it.
   The text no longer says the admins have been mailed this result as a fact about the call.
5. **An approval that leaves the request `approving` is not a success.**
   See ADR 0105, decision 12: `approve` exits 1 and `next` counts it as failed.

