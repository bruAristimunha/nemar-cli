# Publication review: design analysis and phase plan

> **STATUS: ANALYSIS, NOT A RULING.**
> [ADR 0102](decisions/0102-a-publication-request-gets-a-derived-verdict-and-approving-a-non-pass-is-the-administrators-recorded-act.md) is the verdict.
> Where this note and the ADR disagree, the ADR wins.
> This note keeps what was read, the comparisons, the arithmetic, the initial vocabularies and the refined plan for epic #1726.
> Written 2026-10-12 for Phase 0 (#1727) against the epic branch at `9cc6586f`,
> and revised the same day after an independent review of #1735 and the maintainer's amendments (comments on #1726).
> Pull request #1720 (the 2026-10-12 amendments to ADR 0092 and ADR 0093) has since merged into `dev`,
> and the epic branch was brought up to date with `dev` on 2026-10-13.
> The Phase 1 sections below keep the plan as written; where the build departed from it, the ADR states what was built
> (the workflow's step order, the participants file, the normalization before the pre-send rules, the cap accounting,
> the mail at the deadline).
> The Phase 3 block and the attribution risk were rewritten as built on 2026-10-13 (ADR 0103).
> The Phase 4 block was rewritten as built on 2026-10-14 (ADR 0102 Phase 4 amendment).

## 1. What was read

Decision records, in full: the index; ADR 0014, 0026, 0040, 0065 (the decision and the anonymous-release sections),
0080, 0086 (with every amendment and the known gaps of 2026-10-10), 0087, 0089,
0092 (with the amendment of 2026-10-10 and the open items), 0093 (with the amendment of 2026-10-10),
and the 2026-10-12 amendments to 0092 and 0093 from #1720.

The pull-request review, as the model to follow:
`shared/pr-review.ts`;
`backend/src/services/pr-review.ts`;
`backend/src/routes/callbacks/pr-review.ts`;
migrations `0092_pr_reviews.sql` and `0095_pr_review_attempts.sql`;
`.github/dataset-workflows/run-pr-review.yml`;
`scripts/ci/pr-review.ts`, `pr-review-prompt.ts`, and the head of `pr-review-evidence.ts`;
and, through a read-only survey, `src/commands/admin-pr-reviews.ts`, `src/lib/pr-review-approve.ts`,
`src/lib/pr-review-next.ts`, `shared/contract/pr-review-admin.ts` and their tests.

The publication path:
`backend/src/routes/datasets/publication.ts` (the request route);
`backend/src/routes/admin/publish.ts` (list, deny, approve, approve-dispatch, the screen re-run);
`backend/src/services/identifier-screen.ts` (start, store, mail lease, watchdog, gate);
`backend/src/services/publication-orchestrator.ts` (the approve entry, the screen gate call, the version tag);
`backend/src/services/approval-dispatch.ts` (`ACTIVE_REQUEST_TAIL_SQL`, `resolveApprover`);
`backend/src/services/github/contents.ts` (`createTag`);
`backend/src/services/submission-minimums.ts` and `submission-gate.ts`;
the publication migrations (0005, 0028, 0045, 0086, 0090, 0091);
`shared/identifier-screen-report.ts`,
and the coverage rules in `shared/identifier-scan.ts` and `scripts/identifier-fleet-lib.ts`;
`backend/wrangler-sccn.toml` for the flags.
Through a read-only survey: `src/commands/admin.ts` (`nemar admin publish`) and `src/lib/api/publish.ts`.

Deployed workflows in `nemarDatasets/.github`, read through the API on 2026-10-12:
`run-prescreen.yml`, `run-identifier-screen.yml`, `approve-publication.yml`.

The website (`nemarOrg/website`, local checkout, read only):
`src/pages/admin/publication-requests.astro`, `src/components/PublicationRequestRow.astro`,
`src/lib/publication-queue.ts`, `src/lib/admin-api.ts`, `src/lib/publication-block.ts`,
`src/lib/account-copy.ts`, and the drift tests under `test/`.

Repository rules: AGENTS.md's hard rules, `.rules/documentation.md`, `.memory/README.md`,
and the notes on sentinels, tri-state fetches, make versus take, plan claims and the epic branch's continuous integration (CI).

Issues #1579, #1580, #1581, #1582, #1583, #1584, #1603, #1604, and the prerequisites #1736 and #1737.

## 2. Facts that shaped the design

Each was checked against the code, or, where marked, reported by the review of #1735.

1. **The identifier screen does not read the documents a reviewer reads (#1736).**
   `readCandidates` (`scripts/identifier-fleet-lib.ts`) sends to the text rule (`scanTextForLocalPaths`)
   only `.py .m .r .txt .md .yml .yaml .xml .iml .cfg .ini` files under `sourcedata/` or `code/`,
   and to the JSON key rule (`scanJsonKeys`) only JSON that is neither a Brain Imaging Data Structure (BIDS) sidecar outside `sourcedata/`
   nor `dataset_description.json`, `participants.json` or `genetic_info.json` (`JSON_EXCLUDED`).
   The root README, CHANGES and LICENSE are therefore seen only as paths, by `scanPaths`; their content is never read.
   So a screen verdict of `clean` says nothing about the bytes of the files the review sends to the model.
   This is what turned "screen first" from a content rule into an ordering rule, with a pre-send check as the content rule.
2. **The shared text rules are narrow, and the one for prose examines one match (#1737).**
   For free text there is one rule, a local user path (`/Users/<name>`, `C:\Users\<name>`),
   and `LOCAL_USER_PATH` has no global flag, so `scanTextForLocalPaths` stops at the first match.
   For JSON there is a key rule over a closed set of key names
   (`patientname`, `birthdate`, `mrn` and others at identifier severity; `email`, `contact`, `phone`, `address` and others at review severity).
   No rule recognizes a person's name, an email address or a date in prose.
3. **The pre-screen is live in production.**
   `PRESCREEN_ENABLED = "true"` appears only in `[env.dev.vars]` of the configuration file,
   but production has a Worker secret of that name, and the deployed `run-prescreen.yml` runs for production requests
   (verified by the maintainer's session, 2026-10-12).
   It is advisory, and its result is shown to administrators (`nemar admin publish list` prints a concern).
   Its design is why it is replaced rather than extended:
   its callback address comes from the dispatch payload, the text it sends is not fenced by a nonce,
   its output is free text, and the request route dispatches it at the same moment as the identifier screen.
   `PRESCREEN_CALLBACK_SECRET`, despite its name, also signs the callback tokens of the identifier screen,
   the identifier sweep and the pull-request review (`backend/src/services/identifier-screen.ts`,
   `identifier-sweep.ts`, `pr-review.ts`), so retiring the pre-screen must not delete it.
4. **Models already read submission prose.**
   Enrichment reads the README (`backend/src/services/enrich-dataset.ts`) and sends it to a model (`llm-enrich.ts`).
5. **Approval is answered by the Worker.**
   `POST /admin/publish/:id/approve` runs `runPublicationApproval`,
   which reads the newest request in `requested`, `approving` or `blocked` (`ACTIVE_REQUEST_TAIL_SQL`),
   runs the screen gate (`checkApprovalScreenGate`) unless a resumed run has already started publishing,
   and then marks the request `approving`.
   Nothing in that path refuses a `blocked` request; the screen gate refuses one whose screen was reset by the block,
   and `nemar admin publish screen` re-runs the screen on a `blocked` request (`RERUN_GUARD_SQL`).
   So, by reading the code (not exercised), a terminal can approve a request blocked for `min_requirements_failed`
   once its screen has been re-run and is clear. `approve-dispatch` refuses a `blocked` request (`not_dispatchable`).
6. **The request route cannot re-open a `requested` request.**
   `POST /datasets/:id/publish/request` answers 409 when the newest active request exists and is not `blocked`,
   so a hard reason on a `requested` request needs a transition to `blocked` before the depositor can request again.
   The sweep already makes that transition for a failed minimum (ADR 0086, amendment of 2026-10-07).
7. **The version published is read at approval time, and an existing tag does not stop the run.**
   `getVersionTag` reads `Version` from `dataset_description.json` and defaults to `1.0.0`;
   `create_tag` tags the current head of `main` with `v<version>`.
   `createTag` treats a 422 on the ref, an existing tag, as success:
   the old tag stays where it was, and the new content is published under it.
   `dataset_versions` is unique on `(dataset_id, version)`.
8. **The web executor runs the command-line interface (CLI) with `--yes` and no `--force`.**
   `approve-publication.yml` runs `nemar admin publish approve <id> --yes [--resume]` with a service key per environment,
   so a gate that only the CLI enforced would refuse every web approval of a non-pass.
9. **The CLI's approve command shows the steps but not the screen before its prompt, sends no request id,
   and exits 0 on every failure** except a bad `--acknowledge-identifier-screen` length (#1581).
   `--skip-ci-check` skips the orchestrator's `ci_check` step and leaves only a log line.
10. **The screen workflow never lets a dispatch payload choose the code that runs.**
    Its `nemar_cli_ref` input exists for a manual run only; a dispatched run checks the script out of `main`.
    The pull-request review does the same, and so will the publication review,
    which is why its script must be released to `main` before any run, the dev Worker's included.
11. **The website's approval page renders none of the screen.**
    `PublicationRequest` in `src/lib/admin-api.ts` declares no `identifier_screen`; `approveDispatch` sends the literal body `{}`;
    its error map has no `identifier_screen_not_clear`; and its transcription of the block reasons (`src/lib/publication-block.ts`)
    has six values where nemar-cli's `publicationBlockReasonSchema` has seven (it lacks `identifier_screen_findings`).
    The website's drift tests check out nemar-cli `dev`, so a new contract file is visible to them only once it is on `dev`.
12. **The pull-request review never sends an unpublished dataset to a model** (`REVIEWABLE_DATASET_PREDICATE` requires `first_published_at`).
    A publication review is always about an unpublished dataset, so its licence to read is stated in ADR 0102:
    the depositor's request to publish this content, with the precedent of enrichment and the pre-screen.
13. **Cron.** Production runs `0 3 * * *` and `*/30 * * * *`; dev runs only `0 4 * * *`.
    Every watchdog is production-only, which is why ADR 0093's surfaces age a dispatched row by time.
14. **The policy pages need correcting for current practice (reported by the review of #1735).**
    The privacy page's list of service providers names no AI provider;
    the AI-use page says enrichment runs when a dataset is published, while the code runs it on qualifying pushes of unpublished datasets too;
    and it says participant-level data files are never sent to a model.
    The maintainer has a separate docs change in flight; this epic adds the review's own statement when it is switched on.
    The last point is why the review sends no `.tsv` file at all, the `participants.tsv` header included.

## 3. Pull-request review and publication review, side by side

| Concern | Pull-request review (ADR 0092, 0093) | Publication review (ADR 0102) |
|---|---|---|
| What starts it | The App's `pull_request` delivery | The stored screen result, or an administrator's `start` |
| Unit | (dataset, pull request, head commit) | (request, screened commit, anonymous flag) |
| Who wrote the text | Anyone on GitHub, forks included | The depositor, an approved account |
| Eligible | Active, public, named, first-published | Native submissions; mirrors and exemplars not applicable |
| Ordering | Independent of the BIDS and version checks | After the BIDS wait and the screen, for the screen's commit |
| Model input | Diffs of changed metadata, title, body, commit subjects | README, description keys, CHANGES, LICENSE, `participants.json`, counts |
| Pre-send rule | None (the content is already public) | Shared rules over the bytes sent; a flagged file is withheld |
| Questions | 3 | 4 |
| Outcomes | `pass`, `fail`, `uncertain` | `pass`, `fail`, `action_required` |
| Result goes to | A check-run and one pull-request comment, and D1 | D1, the admin email, the CLI and the web page |
| Republish pass | Yes | None (nothing written to GitHub) |
| Claim predicate | Latest delivery; dataset still eligible | Newest review of the request; request `requested`; head and flag unchanged |
| Callback origin | The workflow's table by environment name | The same |
| Read token | Contents and pull requests: read | Contents and actions: read |
| Watchdog | Production, 30 minutes, then republish | Production, 30 minutes, then the request's mail |
| Spend control | Tally and overrides; per-author and platform caps | 5 per depositor and 50 per platform per day |
| Flag | Stops new reviews only | Stops new reviews and the model gate; mechanical refusals stay |
| Gate lives in | The CLI (a GitHub review) | The Worker; the CLI refuses earlier when its caller decides |
| A non-pass | Fail, running or unread needs `--force` | Every non-pass needs the force path, except hard reasons |
| Approver | The administrator's own GitHub login | The administrator who passed the gate |

## 4. Data flow

```
depositor: nemar dataset publish request
   |
   v
POST /datasets/:id/publish/request -- minimums fail / owner unnamed / CI failed --> 422 blocked
   |                                  CI pending --> blocked; the sweep releases it later
   v status = requested
   |-- flag off and pre-screen secret set --> pre-screen dispatched (advisory, until retired)
startScreenAndNotify --> repository_dispatch[run-identifier-screen] --> the screen reads bytes
   |                                                                    |
   |                    POST /webhooks/identifier-screen-result <--------
   v
storeScreenResult (state, head H)
   |-- gate blocks --> request blocked, depositor mailed (unchanged)
   |-- gate wait or rerun --> no review; the admin mail says so (unchanged)
   |-- not applicable (mirror, exemplar) or flag off --> admin mail now (unchanged)
   v gate clear or acknowledge, flag on, native submission
startPublicationReview(request, H, anonymous)
   |-- a row exists for (request, H, anonymous) --> reuse it
   |-- over a cap --> declined (review_limit_reached) --> admin mail
   v insert the dispatched row, then dispatch
repository_dispatch[run-publication-review] {dataset_id, request_id, review_id, head_sha, anonymous, environment, callback_token}
   |
   v the workflow (nemarDatasets/.github, main only)
mask the token -> validate -> POST /webhooks/publication-review-claim (one shot)
   |-- 401 or 409 --> stop green, nothing spent
   v claimed
federation check -> read-only token (one repository)
-> git init + shallow, blob-less fetch of main, prefetching the blobs the script reads (token per command, never in the clone)
-> the BIDS validation runs of the fetched commit
-> check out nemar-cli main -> set up bun -> install (no install scripts) -> OpenID Connect token
-> the script: fetched main == H, or stale_head -> read the files at H -> normalize, then the pre-send check (shared rules)
-> withhold flagged files -> ClearedText -> evidence: counts, version, minimums, tag lookup
-> one model call (no tools, JSON schema)
-> assemble and parse the report -> POST /webhooks/publication-review-result
   |                                     (failure after the claim: curl reports workflow_failed)
   v
Worker: parse at the door -> store the report and verdict
   |-- a minimum failed at H --> requested -> blocked (min_requirements_failed)
   v
admin mail: the screen section and the review section
   (production watchdog: unreported after 30 minutes, then mail; a late report re-arms it)
   |
   v
nemar admin publish list | show | next | approve        website approval page
   |                                                      |
   v                                                      v
POST /admin/publish/:id/approve  <-------------- approve-dispatch (override recorded) -> executor --yes -> /approve
   screen gate (ADR 0086) -> blocked refusal (always) -> review gate (when the flag is on) -> approving -> 16 steps
```

## 5. Screen first: the options weighed

The brief named a strong option: run the model only on content the screen has cleared for the commit,
and otherwise record `action_required`. Three readings were weighed.

- **A. The model runs only when the screen's state is `clear`.**
  It protects nothing the model sees, because the screen did not read those files (fact 1).
  It costs the review for every dataset with a recording format the screen cannot parse
  (BrainVision, EEGLAB, FIF and others, ADR 0087; most mirrors, ADR 0089),
  a share of native requests that has not been measured. Rejected as stated.
- **B. The model runs after the screen reports for the same commit, when its gate is `clear` or `acknowledge`,
  and only on bytes the shared rules examine immediately before sending.** Chosen.
  It makes the model's input enumerated and consistent with the screen's rules.
  It is not a privacy control: for prose the only rule is one pattern, and #1737 must be fixed first.
- **C. Extend the screen to read the root documents, and trust its verdict.**
  The same rules over the same files, but a change to the scanner that the upload preflight and the fleet scan share,
  with new findings on published datasets; tracked as #1736, outside this epic.

- **D. A reviewer that runs code: an agent with tools (Claude Code, in Actions or in the cloud) that opens the images, tables and recordings.**
  Suggested by the maintainer on 2026-10-12; recommended against for the automated path, on three grounds.
  (1) It sends participant-level content to a model: anatomical images carry faces, `participants.tsv` and event tables carry values, and the AI-use page says participant-level data files are never sent to a model;
  the identifier screen exists because those bytes are the risk, and ADR 0102's hard constraint is that the model receives none.
  (2) The depositor writes the README, so a tool-using agent reading it is the prompt-injection arrangement:
  a no-tools call can be steered into a wrong verdict, which a person still sees and which the code never reads from the model;
  an agent holding a shell, a read token and an Anthropic identity in the runner can be steered into acting.
  (3) It is dearer by one to two orders of magnitude, not reproducible, and its answer cannot be re-derived by the administrator who must approve from it.
  What the idea is after, a reviewer that checks the prose against the data, is done by code instead:
  the job already runs in a checkout and computes the structural summary, the minimums, the BIDS result and the counts,
  and Phase 1 widens that summary to the numbers a README states (subjects, sessions, channels, sampling rates, recording formats, modalities),
  so `readme_mismatch` compares prose with facts the platform computed, and the model is shown the numbers and never the values.
  A richer, administrator-run look at a local clone with their own tools stays the administrator's own act (ADR 0093) and is not built here.
  The maintainer confirmed on 2026-10-13 that it is not built: the review stays a no-tools call over cleared prose, with the checks moved into code.
  Reopening it would amend ADR 0102's hard constraint and the policy statement, not just the job.

Under B the ordering still matters:
a request with direct identifiers in its headers, which the screen blocks, never reaches a model,
and a review is never about another commit than the screen's.

## 6. Cost estimate

Prices were checked on the live pricing page on 2026-10-12:

| Model | Input per million tokens | Output per million tokens | Batch (input / output) |
|---|---|---|---|
| Haiku 5.5, prompts up to 100,000 tokens | $0.10 | $0.50 | $0.05 / $0.25 |
| Sonnet 5.5 | $2 | $10 | $1 / $5 |
| Opus 5.5 | $4 | $20 | $2 / $10 |

The Haiku to Sonnet ratio of about 1 to 20 is what the page states.
These are first-party rates; the pull-request review's federation audience is the first-party API, and the publication review uses the same.
Thinking is billed as output and counts toward `max_tokens`.
Token counts use four characters per token; nothing here was measured with `count_tokens`.
Accepted (second adversarial review): rare characters can cost more tokens than four to the character, so an adversarial document may cost more than this estimate and exceed the model's input limit; the API's refusal of an over-long input maps to `model_invalid`, which fails closed, and the daily caps bound the spend.

Input, worst case: the system prompt and schema about 1,500 tokens; the facts about 1,000;
the README 24,000 characters (6,000 tokens); the description 16,000 (4,000); CHANGES 8,000 (2,000);
LICENSE 4,000 (1,000); `participants.json` 8,000 (2,000). Total about 17,500 tokens.
Input, typical: about 5,000 tokens. Output: `max_tokens` 16,000 is the ceiling; a typical answer is assumed at 3,000.

| Model | Typical call | Worst call | Worst day at the cap (50) |
|---|---|---|---|
| Haiku 5.5 | 5,000 x 0.10/1e6 + 3,000 x 0.50/1e6 = **$0.002** | 17,500 x 0.10/1e6 + 16,000 x 0.50/1e6 = **$0.00975** | **$0.49** |
| Sonnet 5.5 | $0.010 + $0.030 = **$0.040** | $0.035 + $0.160 = **$0.195** | **$9.75** |
| Opus 5.5 | $0.020 + $0.060 = **$0.080** | $0.070 + $0.320 = **$0.390** | **$19.50** |

At a realistic volume (assumed, not measured: a handful of native requests a day, restarts included),
Haiku 5.5 costs cents a month and Sonnet 5.5 a few dollars.
Each review also takes an assumed two to four minutes of Actions time on `nemarDatasets/.github`.

## 7. Calibration before the soak

A soak on one fixture yields about six reviews; it can find broken links, and it cannot measure a one-in-five false-fail rate or choose a model.
So Phase 1 ends with an offline calibration, as ADR 0014's decision rested on a measured scan.

- **Corpus.** The README, `dataset_description.json`, CHANGES, LICENSE and `participants.json` of published datasets,
  which are public; for example 200 of them, sampled across modalities and sizes,
  each through the same pre-send check and prompt as production.
- **Bad cases.** About 50 mutated copies of corpus entries, each with one known defect:
  a stub README, an ethics statement removed or reduced to boilerplate, placeholder authors, a `License` that disagrees with LICENSE,
  a name that does not describe the data, a README that contradicts the counts, and an embedded instruction to the reviewer.
- **What is measured.** For the good cases, the share of non-pass outcomes an administrator judges wrong;
  for the bad cases, the share caught, by question.
  Call 6's threshold (more than one in five non-pass outcomes judged wrong) is applied here, and the same set is re-run on Sonnet 5.5 if it is crossed.
- **Cost.** About 250 reviews: about $0.50 on Haiku 5.5 and about $10 on Sonnet 5.5 at the list prices above,
  half that through the batch interface.
- **Where it runs.** From an operator's machine, through the same script with a calibration entry point that posts nothing;
  the results are recorded in a research note under `.context/`, in counts only.

## 8. Initial vocabularies

These are the starting lists for `shared/publication-review.ts`; Phase 1 may refine them, and the ADR binds only their shape.

- **Questions:** `complete_and_honest`, `meets_standards`, `authors_and_license`, `name_adequate`.
- **Findings:** `readme_missing_or_stub`, `readme_mismatch`, `description_incomplete`, `ethics_statement_missing`,
  `ethics_statement_inadequate`, `authors_placeholder`, `authors_inconsistent`, `license_missing`, `license_inconsistent`,
  `name_not_descriptive`, `changes_inconsistent`, `provenance_unclear`, `source_license_conflict`, `evidence_incomplete`, `steering_attempt`, `other`.
- **Run errors:** `evidence_unavailable`, `stale_head`, `auth_failed`, `model_unavailable`, `model_refused`, `model_truncated`,
  `model_invalid`, `report_invalid`, `dispatch_failed`, `dispatch_unconfigured`, `review_disabled`, `workflow_failed`.
- **Reasons, by what clears them and their class:**

  | Reason | Class | Cleared by |
  |---|---|---|
  | `request_blocked` | fail | nothing |
  | `submission_minimum_failed` | fail | nothing (the request is re-blocked) |
  | `identifier_screen_blocks` | fail | nothing |
  | `identifier_screen_not_run`, `identifier_screen_stale` | unknown | nothing (re-run the screen) |
  | `version_kept_after_anonymous_release` | fail | nothing (bump the version) |
  | `identifier_screen_needs_acknowledgment` | unknown | the screen's recorded acknowledgment |
  | `question_failed`, `steering_attempt`, `bids_failed_at_review`, `version_already_released`, `version_malformed` | fail | override |
  | `review_not_started`, `review_running`, `review_did_not_report`, `review_limit_reached`, `review_could_not_run` | unknown | override |
  | `text_withheld`, `question_unknown`, `bids_unconcluded_at_review`, `version_missing`, `doi_state_unexpected` | unknown | override |

- **Columns of `publication_reviews`:** `id`, `request_id`, `dataset_id`, `head_sha`, `anonymous`,
  `requested_by` (the depositor, for the cap), `started_by` (an administrator who started it by name, or NULL),
  `state`, `verdict`, `detail`, `report`, `nonce`, `claimed_at`, `attempts`,
  `override_by`, `override_at`, `override_reasons` (the closed reason codes shown), `created_at`, `decided_at`;
  `UNIQUE (request_id, head_sha, anonymous)`.
- **Exports of `shared/publication-review.ts`:** the report type and its branded parser, the evidence type,
  `ClearedText` and the pre-send function's signature (the function lives with the job), the four lists above,
  `verdictOf`, `reasonsOf`, `describePublicationReview`, and the standing line
  "Not assessed: whether the text names the depositors."
- **Admin API:** `publication_review` on each row of `GET /admin/publish/requests`; `GET /admin/publish/:id/review`;
  `POST /admin/publish/:id/review/start`; `override_publication_review: { review_id, reasons }` on `/approve` and `approve-dispatch`;
  `POST /admin/publish/:id/comment`; 409 `publication_review_not_clear`.

## 9. Refined phase plan

The epic's order holds, with these changes from the first draft and the review:
the server-side gate lands in Phase 2 together with the CLI that can pass it;
#1581 moves into Phase 2; #1737 is fixed before Phase 1;
the epic is finalized into `dev` after the nemar-cli half of Phase 4 (this was first planned for after Phase 3; see Phase 4's order),
so that the website's drift test can see the contract on `dev` and the code reaches a live environment before the soak;
and Phase 5 is release dark, soak, then switch on.

### Before Phase 1: #1737

Fix `scanTextForLocalPaths` so that it examines every match, with the test the issue describes, as its own change into `dev`.
Phase 1 builds on it.

### Phase 1 (#1728): store, contract, workflow, mail, calibration

Files:

- `shared/publication-review.ts` and `shared/contract/publication-review-admin.ts` (section 8).
- `shared/submission-minimums.ts`: the pure rules moved out of `backend/src/services/submission-minimums.ts`, which re-exports them,
  so the review job and the Worker evaluate one function.
- `shared/untrusted-text.ts`: `fence`, `tidy`, `tidyPath` and `sanitizeNote` moved out of the pull-request review, which imports them back.
- `shared/readme-candidates.ts`: one `README_CANDIDATES` (`README.md`, `README`, `README.rst`, `README.txt`), which the review job, `backend/src/services/submission-gate.ts` and `anonymity-sweep.ts` import.
  Three other places disagree with it today and are not changed by this epic, so each is filed as its own issue: enrichment (`enrich-dataset.ts`: `README.md`, `README`, `readme.md`, so a `.rst` or `.txt` README is "No README found"),
  the reindex (`dataset-reindex.ts`: `README`, `README.md`) and the webhook's trigger list (`routes/webhooks/github.ts`: `README.md`).
  Publishing renames a `.rst` or `.txt` README to `README.md` (`publication-orchestrator.ts`, step `update_readme`); the review reads the file as the depositor wrote it.
- Migration `0096_publication_reviews.sql` (the next free number at the time; check `ls backend/src/db/migrations`).
- `backend/src/services/publication-review.ts`: start (from `storeScreenResult` and an admin start), the applicability wrapper
  `publicationReviewApplies`, caps ranked after insert, dispatch, claim, store, the re-block on a failed minimum, the production-only watchdog,
  and the flag-off behaviour of section 7 of the ADR.
- `backend/src/routes/callbacks/publication-review.ts`, under the `publication-review` token domain in `backend/src/services/github/callback-tokens.ts`.
- `backend/src/services/github/dispatch.ts`: `triggerPublicationReviewRun`.
- `backend/src/services/identifier-screen.ts`: the mail lease waits for an in-flight review while the flag is on,
  and a late review report re-arms it; the email gains the review section (`backend/src/services/email.ts`).
- `backend/src/routes/admin/publish.ts`: `publication_review` on each list row;
  `backend/src/routes/admin/publication-review.ts`: `GET /admin/publish/:id/review` and
  `POST /admin/publish/:id/review/start` (with the cookie Origin rule), and its audit row.
- `backend/src/index.ts`: the watchdog on the 30-minute tick, production only.
- `backend/wrangler-sccn.toml`: `PUBLICATION_REVIEW_ENABLED = "1"` in `[env.dev.vars]` only.
- `backend/src/routes/datasets/publication.ts`: the pre-screen skipped only when the review will run for the dataset
  (the flag is on, the review applies to it and this Worker owns it), and dispatched as before otherwise.
- `backend/src/services/datasetId.ts`: `nm099997` declared in `DEV_OWNED_FIXTURE_IDS`, with its guard test,
  so that the dark release carries the declaration before the fixture exists.
- `.github/dataset-workflows/run-publication-review.yml`, `scripts/ci/publication-review.ts` (with a calibration entry point that posts nothing),
  `scripts/ci/publication-review-evidence.ts` (git reads at the commit, the counts, the pre-send check producing `ClearedText`,
  the minimums, the tag lookup, the BIDS run), `scripts/ci/publication-review-prompt.ts`.
- `.context/research-publication-review-calibration.md`: the calibration's results (section 7), in counts.

Tests (real D1 through `backend/test/helpers/d1.ts` with every migration, the real Hono routes, real git repositories, no mocks of business logic):

- `test/publication-review-contract.test.ts`: the parser refuses unknown keys, values outside the closed sets and counts that do not add up;
  every reason has a class and a clearer; facts only lower; the report agrees with itself in the safe direction;
  no file outside the pre-send module constructs `ClearedText`.
- `backend/test/publication-review-flow.test.ts`: a stored screen result starts exactly one review;
  `blocks`, `wait` and `rerun` start none; the flag off starts none, refuses claims, stores an already-claimed result,
  and leaves the mail as before; mirrors and exemplars start none; the dedupe key; a re-request with the other flag starts a new row;
  caps under concurrent starts; dispatch failure fenced by nonce and `claimed_at IS NULL`;
  a forged, replayed or stale claim refused; an unsettled claim closed as `stale_head`;
  the watchdog marks `unreported` and keeps the nonce; a late report lands and re-arms the mail;
  a failed minimum re-blocks the request; the dev Worker refuses a dataset it does not own, and production refuses one dev owns.
- `backend/test/publication-review-mail.test.ts`: the mail waits for an in-flight review and goes when it reports, errs or is marked unreported.
- `test/publication-review-evidence.test.ts`, on real git repositories: a README with a local user path after a generic one is withheld;
  a `dataset_description.json` with an identifier key is withheld; a file that is not UTF-8, or over its cap, is withheld or cut and says so;
  a root README that is an annexed link is withheld, never judged a stub; the built prompt contains no `.tsv` content,
  no path, no subject label and no task label.
- `test/publication-review-workflow.test.ts`: the workflow's shell steps against a stand-in Worker, as `test/pr-review-workflow.test.ts` does.
- `backend/test/prescreen-handover.test.ts`: the pre-screen is dispatched with the review flag off and not with it on.
- A README in each of the four forms is read, and a request with only a `README.rst` is never judged `readme_missing_or_stub`.
- Mutation checks in the dangerous direction: removing the pre-send check, the screen-head predicate in the claim,
  the flag check, or the re-block must turn a test red.

Must not: add the approval gate (Phase 2's); write anything to GitHub; send any `.tsv` content, header byte or screen report to the model;
change `shared/identifier-scan.ts` beyond the #1737 fix; change the screen's verdicts;
dispatch from the dev Worker for a dataset it does not own; read the screen's state or head differently from ADR 0086's gate.

### Phase 2 (#1729): the CLI and the gate

Files, with the move of the `publish` group out of `src/commands/admin.ts` into `src/commands/admin-publish.ts` as its own commit first:

- `src/commands/admin-publish.ts`: `list` (review column, `--needs-me`), `show`, `start`, `start --all`, `next`,
  and `approve` showing the screen, the review and the gate's state before its prompt; the object count and expected lock duration in `next`.
- `src/lib/api/publish.ts`: the review view, `start`, the override field, the comment route; `test/api-export-surface.unit.test.ts` updated.
- `src/lib/publication-review-gate.ts` (the CLI's early refusal from the shared reasons table, skipped when an override is already recorded
  or a resume has started publishing) and `src/lib/publication-review-next.ts` (`parseChoice`, `approveAllowed`).
- `backend/src/services/publication-orchestrator.ts`: the unconditional refusal of a `blocked` request, then `checkApprovalReviewGate`
  after `checkApprovalScreenGate`, before `approving`; `approveSchema` gains `override_publication_review`;
  the `dataset_published` audit row records `review_gate` and `skip_ci_check`.
- `backend/src/routes/admin/publish.ts`: `approve-dispatch` takes the same override and records it at the claim, with its audit row;
  `POST /admin/publish/:id/comment` for `c` (the administrator's words mailed to the depositor, audited).
- `shared/contract/publication-review-copy.ts`: the fixed vocabulary the website needs (plain string literals, the account-copy rules).
- #1581: every failure path of `approve`, `list` and `deny` exits non-zero; what a declined confirmation returns is decided and tested.

Tests:

- `test/admin-publish-cli.test.ts`: the real binary against the real backend app on `Bun.serve` over real D1
  (the shape of `backend/test/helpers/pr-queue-app.ts`): list, show, start, approve over each reason class,
  `--yes` never skipping a reason, the override bound to the review and reasons shown (a reason added in between is refused),
  the executor's `--yes` run proceeding on a recorded override, and `next` with typed answers.
- `test/publication-review-next.unit.test.ts`: answer parsing, when `y` is offered, the extra confirmation under `--force`, type-ahead discard.
- `backend/test/publication-review-gate.test.ts`: the gate on `/approve` and `approve-dispatch`;
  a `blocked` request refused with the flag off and on; hard reasons refused even with an override;
  one administrator's override not satisfying another's run; a gate that cannot read a live fact refusing;
  flag off meaning no review gate; mirrors and exemplars not gated;
  the importer's approve path (`src/lib/import-publication.ts`) still passing for a mirror.
- Exit-code tests for each failure path of `approve`.

Must not: let the Worker approve or deny anything; let `--yes` stand in for `--force` or for the screen's reason;
change the orchestrator's steps; change ADR 0080's attribution (Phase 3's).

### Phase 3 (#1730): approval robustness (as built; the verdict is ADR 0103)

Built: a per-claim dispatch token (#1604), a keyed hash of the dataset, the request, the clicker and the claim's own `approval_dispatched_at`,
signed with the callback secret under its own domain tag, with no stored column and so no migration (the Worker stores none of it).
The executor presents it in `X-Approval-Dispatch-Token` on every `/approve` call (the CLI reads `NEMAR_APPROVAL_DISPATCH_TOKEN`, only in `approve`).
The clicker is the approver only for a valid token; a call with no token is recorded as its caller and its approval takes the claim over;
a stale or expired token is refused (`dispatch_superseded`, `dispatch_expired`);
and a call that carries a token may carry no override, no acknowledgment and no skipped CI check (`decision_with_dispatch_token`; only `skip_ci_check: true` counts), which replaces the Phase 2 refusal `override_inside_web_approval`.

Around it: an optional `request_id` on approve, approve-dispatch and deny (#1579); the dataset id rule per environment before the claim (#1583);
a release endpoint that the token alone authenticates, and `last_error` on the five early exits before the step loop (#1582);
one router-wide cookie Origin guard in place of four per-route copies (#1603, #1584),
whose refusal body carries the word in `error` and `code` and the sentence in `message`;
`/deny` gated by the lease and refused once a step beyond validation has run or is marked current (so a failed first mutation stays undeniable);
and the final write guarded by the request's status, with a request closed during a run refused before any tail job writes.
A resumed run whose steps are all done leaves the request `approving` when a tail job warned, because the warning's remedy is to approve again,
and answers `status: "approving"` with the warnings joined in the singular `warning`, which the CLI prints,
and when it closes the request it writes a `dataset_published` row that names who finished it (`finished_by_resume`);
the step loop's closing path writes its row only when its own write changed the request, so a publication has one row.
The step loop's own end keeps the same dead end after a warning, a known limit with a follow-up (ADR 0103, decision 12).
Two more limits of that branch (a tail-job warning that approving again cannot clear, and no write that settles the claim) and the deny rule's reliance on a best-effort current-step write are stated, each with its trigger and effect, in ADR 0103, decisions 11 and 12.
#1580 (persist the lock continuation token) is deferred: a restart at page 1 also locks objects added meanwhile, and the benefit is unmeasured.

The executor's workflow is in the central workflow repository and is changed by the maintainer: mask the token first, export it for the approve step's process alone and never through `GITHUB_ENV`, install the CLI that matches the environment, release on failure.
The rollout order, with the skew table, is in the ADR: the workflow edit before Phase 3 reaches `dev`, a staging check, then npm `latest` before the production Worker deploy.
One question is left open: a valid token whose clicker is no longer an active administrator falls back to the caller.
A clicker whose session or API key ends mid-run does not end the token, which is a deliberate exclusion (ADR 0103, "Left open").

Must not (kept): weaken the lease; let a dispatch token approve anything by itself.

### Finalize the epic into `dev`

After the nemar-cli half of Phase 4 (first planned for after Phase 3), finalize the epic branch into `dev`, so that the dev Worker runs the new code
and the next `dev` to `main` release carries it to production dark.
That release changes one thing in production with the flag off: a `blocked` request can no longer be approved from a terminal.
Its release notes say so.

### Phase 4 (#1731): the web page (as built; the verdict is the ADR 0102 Phase 4 amendment)

The page, in `nemarOrg/website`, fetches `GET /admin/publish/:id/review` for the request being decided and prints the Worker's words.
It does not transcribe the reasons: the cures change with the request, and a transcription would be a second copy of the sentences and of the rules that compose them.
The rule in one line: the page prints each reason's `statement` and `cure` (the `sentence` only as the fallback for an empty `statement`, which the Worker never sends), and never `command`, `line`, `description.lines`, `description.next` or a gate refusal's `message`.

The nemar-cli half:

- **The cure split.** `cureOf` and `REASONS[].cure` stay the terminal's text, byte for byte.
  `neutralCureOf` is the cure without its command and without `(--force)`, `commandOf` is the command, `reasonStatement` is the reason in words.
  On the wire `ReasonView.cure` is neutral, and `command` and `statement` are additive and optional in the type; `line` stays the CLI's.
  A first design made `cureOf` itself neutral; it was not used, because many existing tests read the composed terminal text through `cureOf` and `REASONS[].cure`, and the CLI's output must not move.
  Every such test stays green and unedited, except two old-Worker fixtures (the approve test for a hard reason and the `next` test for a card without a `line`).
- **Additive detail fields, no migration:** `start_offered`, `screen_gate`, the two reason fields, and `label` and `document_label` on the findings.
  `screen_gate` is there because with the review off `reasons` is empty while the screen's gate still applies.
  A Worker that predates the phase sends no `statement`; the page then withholds the reasons panel and never prints `line`.
  A missing `start_offered` or `screen_gate`, an unknown gate word, or a `request_id` or `anonymous` of the wrong type also mean the Worker is out of step, and Approve is withheld.
- **The page-owned words:** `shared/contract/publication-review-copy.ts`, 22 keys (the gate's six refusals, the screen's six, four approve states, three review words, three start successes),
  with a parity test on each side on the pattern of the account copy.
  The words the Worker sends that are web-safe are printed as they arrive and pinned by a web-safety test over the real producer, with one list of forbidden terminal words.
  The Phase 3 codes that only the executor reaches have no key.
- **What the page may do:** approve (the review id and the reasons shown, and a reason of 10 to 500 characters when the screen's gate is `acknowledge`), deny and start.
  Approve and deny carry `request_id`; the start does not, because its route reads no body and acts on the request that is active.
  Staleness comes from the refusals (`gate: "stale"`, `review_changed`, `request_mismatch`), because the detail reads no GitHub; the page then reads the detail again by itself.
- **Left open:** a control to run the identifier screen again (the Worker has the route; an administrator uses the terminal), the `gate: "wait"` answer for an acknowledgment that lost a race,
  mailing the depositor from the page, wiring the strict parity path into the continuous integration workflow once the website's file is on its `staging` branch,
  a sentence in AGENTS.md about the new copy file, and the production promotion.
  Also left open (#1773): a neutral cure that says to start the review can stand while `start_offered` is false (any standing hard reason, the commonest case; a report that no longer parses, a sandbox request, a screen with no head);
  the page's Start button follows `start_offered` only, which is intended.

Order: the nemar-cli half merges into the epic, then the executor workflow edit and the finalize into `dev`;
the website pull request stays a draft until the epic is on `dev`, then Phase 5.
This supersedes the earlier plan to finalize after Phase 3: the website's copy of the contract needs the Worker half on `dev` first,
and the Worker half of Phase 4 is what the page reads.

Must not (kept): compute a verdict in the browser; offer Approve for a hard reason; send a body the route does not accept.

### Phase 5 (#1732): release dark, soak, switch on

1. **Release dark.** The `dev` to `main` release after finalization carries the script, the declaration of `nm099997`,
   and the review with its flag off in production. Deploy `run-publication-review.yml`, and create its federation rule, service account and organization variables.
2. **Soak against the dev Worker.** Create `nm099997` as a native, named, private deposit owned by a test account.
   Run the scenarios: a request that passes, one the model holds, one the screen holds, one with failing BIDS,
   one whose commit changes after the review, one over the depositor cap, and one with the flag turned off mid-review.
   Record what each link did: dispatch, claim, federation, model call, callback, stored verdict, the CLI and the web page.
   Deny every request after reading it, and approve none under a name.
   A fix to the Worker deploys to dev from `dev`; a fix to the script reaches the soak only through another `dev` to `main` release,
   which is a full release cycle each time, so script fixes are batched.
3. **Switch on.** After Phases 3 and 4 have shipped and the website is promoted, and after the docs change and the review's statement on the policy pages,
   add `PUBLICATION_REVIEW_ENABLED = "1"` to `[vars]` in a release; that same deploy stops the pre-screen.
   Then delete the production `PRESCREEN_ENABLED` secret, disable `run-prescreen.yml`,
   remove the pre-screen's dispatch and callback code in the next change, and run `nemar admin publish start --all` once.
   The release notes say how it is turned on and what to read first (`nemar admin publish list`, then `show` on one request).

Must not: approve `nm099997` under a name; delete `PRESCREEN_CALLBACK_SECRET`.

## 10. Risks

1. **Prose that names a person reaches a model.** The pre-send rules cannot see it (fact 2), and the screen does not read the file (fact 1).
   Mitigated only by the policy statement, by #1737 and #1736, and by a person reading the README before approving.
2. **Override fatigue.** A model that is often wrong teaches administrators to pass `--force`; the calibration measures it before the soak.
3. **The mail is later.** Bounded by the screen's 50 minutes, the review's 30 and a tick.
4. **Dev never ages a row.** Every surface must read a dispatched row past its deadline as not reported.
5. **The interim attribution gap.** Closed in code by Phase 3 (a per-claim dispatch token, ADR 0103);
   what remains is the executor's workflow sending the token, and production stays dark until that is verified on staging.
6. **The web page cannot pass the gate until Phase 4.** So the flag stays off in production until Phase 4 is promoted.
7. **A script fix costs a release.** The workflow runs `main`'s script for every environment, so each fix to it found in the soak needs a `dev` to `main` release.
8. **The allow path is not exercised live before production.** The soak denies everything it requests, so the first live approval through the gate is a production one;
   the gate's allow path is covered by the Phase 2 tests only.
9. **A behaviour change ships dark.** The unconditional refusal of a `blocked` request reaches production with the first release after finalization.
10. **Two copies of the fence and sanitizer helpers.** Phase 1 moves them to one shared module.
11. **The ADR number.** Pull request #1722 merged first and took 0100, and the zarr slots work took 0101 on `dev`, so this decision is 0102 (renumbered twice on 2026-10-13, before it merged).
12. **The `c` comment is a new mail type.** It must carry only the administrator's typed words, never the review's text.
13. **Unmeasured volume.** The caps are guesses until Phase 5 counts native requests.
14. **A model change** moves the cost table by a factor of about twenty.

## 11. What this note could not verify

- What `version_doi` and the manifest callback do with a version that already has a `dataset_versions` row;
  `createTag` is known to keep the old tag (fact 7).
- The exact columns that record a concept Digital Object Identifier (DOI)'s status, for `doi_state_unexpected`; Phase 1 defines the predicate against the schema.
- The policy pages' current text (fact 14 is the review's report, not this note's reading).
- The number of native publication requests per day, and the share whose screen needs an acknowledgment.
- Model latency and token counts on real READMEs; the calibration measures them.
- Whether `git fetch` of a shallow, blob-less `main` is enough for the tag lookup, or the tags need a separate `ls-remote`.
