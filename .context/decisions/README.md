# Architecture Decision Records

Architecture Decision Records (ADRs) capture significant decisions that shape the project: choice of stack, structural patterns, trade-offs accepted, alternatives rejected. Tuck them all in here so they are easy to find later.

## Convention

- One file per decision: `NNNN-short-kebab-title.md`, zero-padded to four digits.
- `0000-template.md` is the template; copy it to start a new ADR. Do not edit `0000-template.md` itself.
- Number sequentially. The next ADR after `0007-...` is `0008-...`.
- Status flows `proposed` -> `accepted` -> (later) `superseded by ADR-NNNN`. Never delete an ADR; supersede it.
- An `Amendment YYYY-MM-DD:` block inside an accepted ADR is for a CLARIFICATION that leaves the
  verdict standing -- naming a mechanism the decision always implied, correcting a stale file path,
  recording what the decision turned out to cost. Anything that changes what was decided is a new
  ADR that supersedes this one, not an amendment: an amended verdict is invisible to anyone who
  read the ADR before, and the whole point of the `Status` line is that the verdict is findable.
- Keep each ADR short. If it grows past two screens, you are probably writing a design doc, not a decision.

## When to write an ADR

Write one when a decision:
- Will be hard or expensive to reverse.
- Cuts off other reasonable paths a future contributor might wonder about.
- Has been argued about more than once.
- Embeds a constraint (legal, performance, schedule) that is not obvious from the code.

Do not write one for routine choices that are obvious from reading the code.

## Index

Add new entries here as you create ADRs. **This list is enforced, not decorative:**
`test/adr-index.unit.test.ts` fails the build if an ADR on disk is missing from it, if an entry
points at a file that no longer exists, if the numbering has a gap or duplicate, or if an ADR
carries a `Status` outside `proposed | accepted | superseded by ADR-NNNN`. A superseded ADR must
name a target that exists.

The index is the entry point AGENTS.md tells readers to start from, so an unlisted ADR is an
invisible one — which is why it is checked rather than trusted.

- ADR 0000 - template (do not edit)
- [ADR 0001](0001-dataset-changes-go-through-pull-requests.md) - Published datasets are PR-only; private datasets stay open
- [ADR 0002](0002-access-control-via-github-collaboration.md) - Access control rides on GitHub collaboration, not a NEMAR permission layer
- [ADR 0003](0003-datasets-is-the-single-table-of-record.md) - `datasets` is the single table of record; FTS5 for lexical, id-only Vectorize
- [ADR 0004](0004-d1-backup-to-a-private-repo-hourly.md) - Back up production D1 hourly to a private git repo, in plaintext
- [ADR 0005](0005-availability-is-reported-never-a-precondition-for-serving.md) - Availability is reported, never a precondition for serving
- [ADR 0006](0006-upstream-re-pull-is-a-major-version-bump.md) - Every upstream re-pull is a major version bump
- [ADR 0007](0007-ezid-is-the-sole-doi-provider.md) - EZID is the sole DOI provider; Zenodo is retired
- [ADR 0008](0008-cloudflare-runs-in-the-sccn-account-only.md) - All Cloudflare infrastructure lives in the SCCN account
- [ADR 0009](0009-non-production-d1-is-not-a-production-mirror.md) - Non-production D1 is a fixture set, not a production mirror
- [ADR 0010](0010-imports-use-server-side-s3-copy.md) - Imports use server-side S3 copy, never a client stream

- [ADR 0011](0011-dataset-ids-are-backend-assigned-in-reserved-bands.md) - Dataset IDs are assigned by the backend, in reserved bands
- [ADR 0012](0012-oversized-datasets-skip-the-zip-and-use-direct-download.md) - Oversized datasets skip the zip and steer users to direct download
- [ADR 0013](0013-the-importer-stays-in-nemar-cli-with-registry-plus-family-adapters.md) - The multi-archive importer stays in nemar-cli (proposed)
- [ADR 0014](0014-submission-minimums-are-llm-judged-not-regex-gated.md) - Submission minimums are LLM-judged and advisory; regexes do not gate (**superseded**)
- [ADR 0015](0015-git-annex-annexes-data-only-metadata-stays-in-git.md) - git-annex takes data files only; metadata stays in plain git
- [ADR 0016](0016-release-versioning-is-owned-by-ci.md) - CI owns version bumping and tagging
- [ADR 0017](0017-dataset-visibility-is-filtered-server-side.md) - Dataset visibility is enforced server-side
- [ADR 0018](0018-metadata-must-be-validated-before-a-doi-is-minted.md) - Metadata must reach `validated` before a DOI is minted

- [ADR 0019](0019-every-user-gets-push-to-every-repo.md) - Every approved user gets push to every repo (**superseded**)
- [ADR 0020](0020-dataset-automation-runs-from-central-shared-workflows.md) - Dataset automation runs from central shared workflows
- [ADR 0021](0021-the-api-token-is-the-master-credential.md) - The API token is the master credential; revocation cascades
- [ADR 0022](0022-orcid-relink-requires-post-minted-intent.md) - ORCID relink intent is minted only by an authenticated same-origin POST
- [ADR 0023](0023-clean-zarr-rebuilds-reconcile-instead-of-wiping.md) - A `--clean` Zarr rebuild reconciles the serving copy instead of erasing it first
- [ADR 0024](0024-deposit-attestation-is-recorded-not-assumed.md) - Deposit attestation is recorded on the dataset row, never assumed from `--yes`
- [ADR 0025](0025-inference-compute-runs-on-device-mcp-is-a-stateless-broker.md) - Inference compute runs on the user's device; the MCP is a stateless recipe-first broker (**superseded**)
- [ADR 0026](0026-mechanical-submission-minimums-hard-gate-native-publication.md) - Mechanical submission minimums hard-gate native publication; adequacy stays LLM-advisory
- [ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md) - The Zarr dispatch gate is raw-only; derivatives/sourcedata/code never trigger
- [ADR 0028](0028-maxshield-meg-is-sss-filtered-before-serving-or-declined.md) - MaxShield MEG is Signal-Space Separation filtered before serving, or declined
- [ADR 0029](0029-the-zarr-conversion-engine-lives-with-the-cli.md) - The Zarr conversion engine lives in nemar-cli, not the Actions repo
- [ADR 0030](0030-bounded-streaming-is-the-default-conversion-path.md) - Bounded streaming is the default conversion path; in-memory is the exception
- [ADR 0031](0031-the-annex-policy-has-one-source-and-data-may-wear-a-metadata-extension.md) - The annex policy has one source, and data may wear a metadata extension (amendment 2026-10-07: the size threshold is 100,000 bytes, not 102,400; the CLI's selection is authoritative for case variants of data names, which the tracking step forces into the annex with `--force-large`; and the save annexes by size too, a gap the post-save check against the remote now catches)
- [ADR 0032](0032-facet-filters-are-declared-once-and-report-what-they-exclude.md) - Facet filters are declared once in a shared table, and report what they exclude
- [ADR 0033](0033-the-zarr-queue-stamps-the-engine-that-converted-each-dataset.md) - The Zarr queue stamps the engine that converted each dataset; pre-existing rows are declared current
- [ADR 0034](0034-datasets-stays-one-table-under-a-column-budget.md) - `datasets` stays one table, under an enforced column budget
- [ADR 0035](0035-sweep-stamps-live-in-one-json-column.md) - Sweep bookkeeping stamps live in one JSON column
- [ADR 0036](0036-operational-rows-carry-counts-and-pointers-not-per-file-lists.md) - Operational rows carry counts and pointers, not per-file lists
- [ADR 0037](0037-make-versus-take-is-decided-explicitly-in-both-directions.md) - Make versus take is decided explicitly, in both directions
- [ADR 0038](0038-byte-size-formatting-stays-bespoke.md) - Byte-size formatting stays bespoke; pretty-bytes is declined
- [ADR 0039](0039-the-update-check-stays-bespoke.md) - The CLI update check stays bespoke; update-notifier is declined
- [ADR 0040](0040-approval-is-the-single-writer-of-upload-access.md) - Admin approval is the single writer of upload access; `verified` is the base tier
- [ADR 0041](0041-dois-cite-the-uploader-by-real-name-or-not-at-all.md) - DOIs cite the uploader by real name, or not at all
- [ADR 0042](0042-upload-access-is-requested-once-by-the-person-who-wants-it.md) - Upload access is requested once, by the person who wants it
- [ADR 0043](0043-one-person-one-account.md) - One person, one account: ORCID, email and GitHub each back at most one live account
- [ADR 0044](0044-identity-self-service-reaches-the-cli.md) - Identity self-service reaches the CLI, and ORCID does it through the browser
- [ADR 0045](0045-the-cli-and-the-web-say-one-thing-about-an-account.md) - The CLI and the web say one thing about an account: one matrix, one copy table, one gap function
- [ADR 0046](0046-cross-repo-parity-compares-pre-release-branches.md) - Cross-repo parity compares pre-release branches, never `main`
- [ADR 0047](0047-cli-sign-in-is-the-device-authorization-grant.md) - CLI sign-in is the device authorization grant, layered on the web ORCID session
- [ADR 0048](0048-account-kinds-are-explicit.md) - Account kinds are explicit: person, service, test
- [ADR 0049](0049-compute-runs-in-the-browser-osa-owns-the-runtime-only-hpc-is-gated.md) - Compute runs in the browser by default, OSA owns the execution runtime, and only HPC submission is gated
- [ADR 0050](0050-no-wasm-in-the-worker-bundle.md) - No WebAssembly in the MCP Worker bundle, and real workerd is the only gate that proves it
- [ADR 0051](0051-a-specific-import-error-is-never-overwritten-by-a-generic-one.md) - A specific import error is never overwritten by a generic one
- [ADR 0052](0052-a-tracking-issue-closes-on-verified-state-and-a-burst-rolls-up.md) - An import-failure tracking issue closes on verified state, and a burst rolls up
- [ADR 0053](0053-silence-is-only-evidence-of-a-problem-when-there-was-work-to-do.md) - Silence is only evidence of a problem when there was work to do
- [ADR 0054](0054-the-weekly-report-arrives-whether-or-not-anything-is-wrong.md) - The weekly report arrives whether or not anything is wrong, and unknown is not zero
- [ADR 0055](0055-a-reconcile-reports-a-disagreement-and-files-nothing.md) - A reconcile reports a disagreement and files nothing, and coverage is looser than ownership
- [ADR 0056](0056-the-admin-docs-are-gated-by-nemars-own-session.md) - The admin docs are gated by NEMAR's own session, handed to the docs host by a one-time code
- [ADR 0057](0057-docs-are-the-canonical-surface-and-gated-content-is-private-at-source.md) - Docs are the canonical surface, and gated content is private at source
- [ADR 0058](0058-what-moves-to-the-private-side.md) - What moves to the private side, and what deliberately does not
- [ADR 0059](0059-one-docs-repo-private-at-source-public-at-the-url.md) - One docs repo, private at source, public at the URL
- [ADR 0060](0060-an-imported-tree-is-brought-onto-nemars-annex-policy-in-prepare.md) - An imported tree is brought onto NEMAR's annex policy in prepare, and inherited `.gitattributes` governance is stripped
- [ADR 0061](0061-a-registration-is-read-back-and-an-incomplete-dataset-is-not-partly-repaired.md) - A registration is read back from the location log, and a dataset the bucket cannot account for is never partly repaired
- [ADR 0062](0062-a-missing-git-annex-degrades-to-a-snapshot.md) - A missing git-annex degrades to an HTTP snapshot, and a snapshot is not a repository
- [ADR 0063](0063-recovered-content-is-pinned-or-proven-and-never-trusted-for-its-provenance.md) - Recovered content is pinned or proven, and an unproven copy is deleted rather than kept
- [ADR 0064](0064-a-dataset-missing-more-than-a-tenth-of-its-data-is-withdrawn.md) - NEMAR lists a dataset only when at least 90% of its DATA KEYS are available, and metadata never counts toward that (partially supersedes 0005)
- [ADR 0065](0065-anonymity-is-available-before-first-publication-and-never-after.md) - Anonymity is available before first publication and never after, and it is withheld by the writer
- [ADR 0066](0066-the-data-plane-brokers-git-tracked-files-under-manifest-capability.md) - The data plane brokers git-tracked files, and the manifest is the capability list
- [ADR 0067](0067-anonymity-is-verified-on-a-schedule-and-reported-never-repaired.md) - Anonymity is verified on a schedule, and reported, never repaired
- [ADR 0068](0068-test-fixtures-are-assigned-from-the-top-of-the-id-band-downward.md) - Test fixtures are assigned from the top of the id band downward, and real datasets allocate upward
- [ADR 0069](0069-the-browser-runtime-is-its-own-package-and-eegprep-stays-whole.md) - The browser runtime is its own package, and eegprep stays whole
- [ADR 0070](0070-the-browser-recipe-names-eegprep-lean-and-carries-no-install-line.md) - The browser recipe names eegprep-lean and carries no install line
- [ADR 0071](0071-the-browser-recipe-leads-with-the-read-in-physical-units.md) - The browser recipe leads with the read in physical units
- [ADR 0072](0072-the-data-plane-streams-a-manifest-and-revalidates-its-edge-copy.md) - The data plane streams a manifest, answers one question per read, and trusts its edge copy for 60 seconds before revalidating it against S3 again
- [ADR 0073](0073-a-declared-fdt-outside-the-raw-tree-is-fetched-never-discovered.md) - A declared `.fdt` outside the raw tree is fetched for its `.set`, verified by header, size and annex key, and never discovered (refines 0027)
- [ADR 0074](0074-manifest-json-emits-unsigned-public-urls.md) - Superseded by ADR 0095: `manifest.json` used unsigned public S3 URLs for public-read datasets and presigned URLs for bucket-policy exclusions
- [ADR 0075](0075-standards-papers-are-never-a-data-paper.md) - Standards, software, platform, and umbrella papers are never a dataset's data paper; relation types are chosen from resolved DOIs
- [ADR 0076](0076-news-images-live-in-their-own-r2-bucket.md) - News images live in their own R2 bucket and are served by the Worker; dataset bytes stay in S3
- [ADR 0077](0077-data-papers-in-metadata-json.md) - `metadata.json` serves `data_papers`, the citations judge's verdict, pulled from the dashboard into one D1 column
- [ADR 0078](0078-the-api-exposes-a-service-binding-entrypoint.md) - The API exposes the `NemarApiRpc` service-binding entrypoint; no method acts without the user's credential or a one-time grant, and the Cloudflare account is the trust boundary
- [ADR 0079](0079-the-private-site-holds-a-session-scope-of-its-own.md) - The private site holds a `private` session scope of its own, minted for any active account through a grant bound to the browser's `state`, ended by sign-out, revoke and delete but not by demotion or key revocation
- [ADR 0080](0080-a-web-approval-is-dispatched-to-an-executor.md) - A web approval is dispatched to an executor and never run by the page or the Worker: `/approve` stays the contract, a 15-minute lease allows one run at a time (a terminal run included), the payload names an environment and never a URL or credential, and the approver is the admin who clicked
- [ADR 0081](0081-nemar-emits-neurobagel-artifacts-by-one-pure-transform.md) - NEMAR emits Neurobagel artifacts by one pure transform over data-plane documents: identity only from `metadata.json`, `anonymous` must be exactly `false`, identifiers are uuid5 under one committed namespace, the vocabulary is a pinned snapshot, and a fact the rules cannot establish is left out and counted
- [ADR 0082](0082-the-neurobagel-node-runs-stock-on-nemaring-under-hard-limits-and-is-fed-by-pull.md) - The Neurobagel node runs stock on nemaring under hard resource limits, as one compose project over a pinned recipes release, and is fed by pull; reload is a measured, locked, verified, reversible operation
- [ADR 0083](0083-curated-neurobagel-annotations-are-a-reviewed-content-pinned-file.md) - Curated Neurobagel annotations are a reviewed, content-pinned file keyed by dataset id: terms only from the pinned vocabulary, a strict loader that fails closed and returns an entry the transform trusts only if the loader made it, git blob pins computed from the bytes converted, an entry that does not apply is skipped whole and the variables it names are withheld with a flag, a load failure stops conversion, and never generated at build time
- [ADR 0084](0084-federation-eligibility-is-one-predicate-decided-from-the-row-and-re-checked-at-read-time.md) - Federation eligibility is one predicate (SQL and TypeScript from one list of named terms) decided from the D1 row and re-checked at every read, with `anonymous: false` in the gathered metadata as a second independent guard whose disagreement is an audit-log finding only; `on` mirrors are included; a dataset that stops being eligible leaves the index before its artifacts are deleted; the writer is a hook that never fails, blocks or delays a flow, off unless `NEUROBAGEL_WRITER_ENABLED` is `1`, with a production-only bounded reconcile behind it; and the read token is a deployment secret, not an account credential
- [ADR 0085](0085-a-privacy-correction-scrubs-every-version-in-place.md) - A privacy correction scrubs every version in place, NEMAR keeps the history of each correction, and the scrub is a step in the import and publication workflows
- [ADR 0086](0086-publication-requests-are-screened-for-identifiers-in-ci-and-the-admin-mail-waits-for-the-verdict.md) - A publication request starts an identifier screen in `nemarDatasets/.github` and the admin mail waits for its verdict: the report is a closed vocabulary parsed at the door, a screen that did not run or report is mailed as such and never read as clear, a direct identifier blocks with no override, lesser findings need a recorded admin reason, the gate is bound to the screened commit, and the check is best effort and says what it did not read; a publication request made while BIDS validation is pending or running is recorded, the CLI reports it as a state and exits 0 without waiting or polling, and the submission minimums and the anonymity blind check run through one function for both the request route and the sweep that releases it (amendment 2026-10-07)
- [ADR 0087](0087-the-upload-preflight-screens-locally-refuses-direct-identifiers-and-is-never-trusted.md) - `nemar dataset upload` screens the dataset on the uploader's machine before anything is sent, with the publication screen's scan and words: direct identifiers refuse with no override (also under `--dry-run`), a lesser verdict proceeds only on a prompt or a flag that names every condition found (`--yes` never counts, no free text), the tree is screened again right before the create call, and the verdict is recorded inside the deposit attestation, parsed at the door, served nowhere, and never trusted
- [ADR 0088](0088-published-datasets-are-re-screened-on-a-verdict-free-cycle-and-the-weekly-report-says-what-was-not.md) - Published datasets are re-screened by the same workflow on a production-only, 30-minute tick, a few at a time, on a cadence that never depends on the verdict (the run list is public); a verdict counts for 28 days and only for the version it was dispatched for, a failure moves the attempt and never the verdict, and a weekly admin email under its own category says what was screened, what was not and why, and which datasets carry findings, sent once by an atomic claim that fails closed
- [ADR 0089](0089-an-import-scrubs-before-it-copies-and-waits-for-the-identifier-screen.md) - An OpenNeuro import scrubs the cloned tree in prepare with ADR 0085's rules before anything is copied (flagged headers downloaded, patched, annexed as SHA256E, uploaded, old keys retired; identifier JSON values blanked; images and documents held for the screen), refuses before the push what it cannot read, verify or move, cuts the copy manifest to the committed tree minus dead keys so a re-import cannot copy back a replaced key, and finalize waits for the identifier screen and approves only a clear verdict; a held publication is not a failed import, and a forward fix of git-tracked content is never approved automatically
- [ADR 0090](0090-acquisition-dates-finer-than-year-and-month-are-warned-about-never-gated-or-rewritten.md) - Policy B for acquisition dates (maintainer, 2026-10-07): a date finer than year and month stays a review-level finding that never gates and that nothing rewrites, and a fixed warning from one definition (`dateWarningLines`, a count and fixed words, never a value) is shown wherever the screen's counts are: the upload preflight, the publication status and the blocked-request mail, and the admin publication mail and list; no verdict or acknowledgment changes, and policy A (coarsen to year and month) would be a new ADR; an accepted publication request is told one neutral notice (`publicationRequestNotice`) that names no finding, verdict or date warning and says when the requester is emailed (amendments 2026-10-07)
- [ADR 0091](0091-a-new-recordings-acquisition-dates-are-set-to-1-january-and-nothing-published-is-changed.md) - New data has its acquisition dates set to 1 January of their year (maintainer, 2026-10-07): one shared rule, `normalizeEdfDates`, separate from ADR 0085's scrub, sets the EDF/BDF header start date and the EDF+ `Startdate` slot (`dd-MMM-yyyy`) by the scanner's own reading, all or nothing per header, keeping the year, the time and every other byte, proven by `verifyDateNormalization`; a first import applies it through the scrub's key replacement and sets inline `_scans.tsv` `acq_time` values, and a date by itself never refuses (a date-only recording it cannot fetch or prove keeps its date); `nemar dataset upload` plans before the preflight and sets headers after the final confirmation by copy and rename, leaving files git tracks, ignores or holds in a nested repository, links, unwritable or changed files, and every table; ADR 0090's warning covers only what remains, and nothing already published is changed
- [ADR 0092](0092-dataset-pull-requests-get-a-derived-verdict-from-a-worker-gated-model-review.md) - A pull request to a dataset is reviewed by Haiku 5.5 (high effort) through a Worker gate (proposed, maintainer, 2026-10-08): only active, named, public datasets with `first_published_at` set are eligible and that eligibility is rechecked atomically at claim; the Worker receives the App's `pull_request` delivery, forks included, dedupes per commit, applies the contributor tally (paused after more than 5 rejected pull requests AND more than 10 percent of their decided ones, a maintainer override wins) and the rate caps, and dispatches one central workflow in `nemarDatasets/.github` that reads the change as git data with no checkout and holds the only federated Anthropic identity; the verdict is derived from the report and git facts, never read from the model, every change is accounted for in exact counts, the one-shot claim checks the latest Worker-recorded delivery atomically and the workflow checks the GitHub head before the model call, an unsettled claim is closed as `stale_head`, dispatch failure cannot erase a claimed attempt, each Actions run has its own concurrency group, and the result is a success, failure or `action_required` check plus one edited-in-place comment, with the check not yet required by any ruleset
- [ADR 0093](0093-pull-requests-awaiting-approval-are-managed-from-one-admin-command-and-an-approval-is-the-administrators-own.md) - Pull requests awaiting approval are managed from one admin command, `nemar admin pr-reviews` (proposed, maintainer, 2026-10-08): the list is one GraphQL search of `org:nemarDatasets is:pr is:open base:main` joined to `pr_reviews`, a verdict belongs to the commit it read and the review of the current commit is the one used (another commit's pass is shown as not reviewed), the BIDS column applies the ruleset's own check pinning, and an approval is the administrator's own act made from their machine with their own GitHub login (a token that is not a person's, or not the login linked to their NEMAR account when one is linked, is refused), pinned to the commit they were shown, needing `--force` when the review failed, is running or could not be read, never merged without `--merge` or a `y` in `next`, and a merge is attempted only when GitHub reports the pull request clean; `next` walks the queue asking y (approve and squash-merge, only with both required checks green), n (close, with a comment posted first) or c (comment); a write whose result is unknown is said to be unknown; no Worker code path approves
- [ADR 0094](0094-the-save-step-skips-re-reading-annexed-content-only-on-large-unchanged-trees.md) - The upload's save step skips re-reading annexed content (`assume-unchanged`) only when the recorded annexed bytes reach 1 GiB, only for a file whose size and mtime still match the plan's record (valid because `git annex add` leaves them unchanged), and only while it can take the skip back: a changed file fails the save, stale flags are cleared at every save entry and at the start of the upload steps and a failure to clear them fails the step, a signal clears them best effort and prints the recovery if it cannot, and the first `git status` afterwards re-reads the content once (accepted); the S3 step before it, when it copies, asks the remote about every recorded file (one request each, announced above 5,000 files, skipped for 6 hours after a passed check over the same path/key set and effective target, no opt-out flag)
- [ADR 0095](0095-manifest-urls-are-stable-data-plane-routes.md) - Every served `manifest.json` entry uses the stable per-file data-plane URL for plain and chunked storage, after the existing visibility/version/path gates; plain objects require an exact-size HEAD, missing plain objects fall back only to a bounded, complete chunk set streamed with single-range support, and clients cache the result for at most 300 seconds
- [ADR 0096](0096-admins-find-an-account-by-any-field-and-edit-a-closed-set-of-fields.md) - Admins find an account by any field and edit a closed set of fields (proposed, maintainer, 2026-10-09): `GET /admin/users?q=` needs every word in any text field, ranks hits (exact identifier, name, prefix, substring) with the exact-hit rule on the server, and offers up to 20 typo and accent near misses only when nothing matches; one column classification (`USER_COLUMN_ROLES`) keeps credentials out of search and detail, and the older username-keyed detail route now selects only non-secret columns; `PATCH /admin/users/by-id/:id` lets any admin edit name, affiliation and location and only an owner edit username, email or GitHub handle (never an owner's account), voids stale verification links and notifies the old address, with the sign-in takeover risk that remains recorded as open
- [ADR 0097](0097-password-sign-in-is-retired-and-its-stored-hashes-are-cleared.md) - Password sign-in is retired (accepted, maintainer, 2026-10-09): `POST /auth/signup` and `POST /auth/retrieve-key` answer 410 with a sentence naming `nemar auth login` (so an installed CLI is told where to go, not that the server lacks the command), `nemar auth retrieve-key` is a hidden stub that does the same, the bcrypt service and `bcryptjs` are removed, mail and pages that named `retrieve-key` name `nemar auth login`, and migration 0093 clears stored `users.password_hash` values while 0094 clears any migration-window writes and blocks the retired signup insert; the column stays nullable and classified `secret`, API keys, `POST /auth/login` (an API-key check), email verification, emailed key regeneration and the device flow are untouched, and ADR 0047's deprecation promise is fulfilled by this removal

## Backfill note (2026-07-31)

ADRs 0001-0021 were written retroactively from decisions that had accumulated across
`.context/` design docs, plans, and research notes. Where a decision now lives in an ADR,
the originating document keeps its analysis and points here rather than restating the
choice, so there is exactly one place that says what was decided.

The originals remain the record of *how* a decision was reached; the ADR is the record of
*what* was decided and why. Dates on backfilled ADRs are the original decision dates where
known, not the date they were written down.
