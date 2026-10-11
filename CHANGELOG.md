# Changelog

What each release actually changed, for someone deciding whether to upgrade or trying to
explain a behavior change after the fact.

**Why this file exists.** The GitHub Release for every tag is generated from merged pull
request titles (`--generate-notes`, in `.github/workflows/auto-tag.yml`), which is accurate
and routinely misleading. Work that lands as one epic merge collapses into a single bullet,
and that bullet carries the epic's name rather than the name of the thing that changed; a
security fix found mid-epic gets no bullet at all. So the generated list stays the index of
what merged, and this file says what it meant.

Newest first. Dates are the tag's publication date, UTC. Backfilled from 0.9.16 onward;
earlier releases are described only by their generated notes.

## 0.10.16 - 2026-10-10

Epic #1671 (upload and integrity fixes) reaches `main` together with the automated review of
dataset pull requests and the admin command that works through it, publication requests that
wait for the BIDS check, chunked annex objects that are counted and served, admin account
search and edit, and the end of password sign-in. The automated review ships dark in
production and is on in the dev Worker for a trial; the steps that turn it on are listed under
Deploy coupling.

### Added

- **A pull request to a dataset is reviewed automatically, and the result is a green or red
  check (#1682, ADR 0092).** Once the NEMAR GitHub App is subscribed to Pull request events it
  delivers them to the Worker, which gates them (per-commit dedupe, the contributor tally, rate caps) and dispatches one
  central workflow, `run-pr-review.yml` in `nemarDatasets/.github`. Claude Haiku 5.5 at high
  effort, with no tools, answers three questions: is anything lost, does the revision advance
  the dataset, is the dataset materially better. The Worker derives the verdict from the report
  and from git facts and never reads it from the model; anything that is not a clear pass is
  `action_required`, never green. A contributor with more than 5 rejected pull requests and more
  than 10 percent of their decided ones is paused. Only pull requests whose base is `main` are
  reviewed, forks included, and nothing from a pull request is executed. **Off in production
  until its flag is exactly `1`; on in the dev Worker, which reviews only the datasets dev owns.**
- **`nemar admin pr-reviews` lists, explains and approves dataset pull requests (ADR 0093).**
  `list` (the default) joins one GitHub search of open pull requests to the stored reviews,
  `show <dataset> <pr>` explains one, `approve` makes the approval with the administrator's own
  GitHub login (no Worker code path approves), and `next` walks the queue one pull request at a
  time. `standing` shows a contributor's record; `allow`, `block` and `clear` set or remove an
  override of the tally. It works with the review switched off: a pull request with no review is
  `not_reviewed`.
- **`nemar admin pr-reviews start` reviews the pull requests that were already open (ADR 0092
  amendment).** The Worker reviews on events, and a pull request that was open before the review
  was switched on produced none. `start <dataset> <pr>` and `start --all` (with `--dry-run` and
  `--yes`) ask for one: the Worker reads the pull request from GitHub itself and runs it through
  the same gate, so the flag, the pause and the platform's daily pool still apply, while the
  per-contributor allowances do not hold back a review an administrator asked for by name. It
  also starts again a commit whose review was declined, ended in an error, never reported, or
  was handed to GitHub and not heard from for 30 minutes. A restart that follows an attempt
  which cost a model call counts as a second call against the pool. The redelivery of a failed
  dispatch goes through the same gate.
- **`nemar admin users` finds an account by any field and edits a closed set of fields (ADR 0096).**
  Search matches every word in any text field, ranks an exact hit first and offers close
  matches when nothing matches; `show` and `edit` work by account id, so web accounts without a
  username are reachable. Credentials are never searched or returned. Any administrator edits
  names, affiliation, city and country; changing who can act as the account is for owners only.
- **A publication request made while BIDS validation is still running is reported as waiting,
  not as an error (#1646, ADR 0086 amendment).** The route still records the request as blocked;
  `nemar dataset publish request` now shows it in the info style and exits 0, `publish status` shows it the same way, and a daily sweep releases
  the request when CI passes (or re-blocks it if a submission minimum fails). When the
  readiness check itself cannot run the route answers 503 `ci_check_unavailable`. The CLI says
  whether the requester is emailed, and `nemar dataset upload` names the CI and publish steps
  in its closing output.
- **Chunked git-annex objects are counted as present and served (#1565, #1695, ADR 0064
  amendment and ADR 0095).** A key stored as `-S<chunksize>-C<n>` chunks counts toward
  `data_complete` once its chunk set is complete (`shared/annex-key.ts`, one definition for
  the Worker and the CLI). Every `manifest.json` entry now points at its stable data-plane
  route, which checks the published dataset and version before touching S3, redirects only
  after a plain-object HEAD confirms the size, and streams a complete chunk set with bounded
  memory and single byte-range support. The manifest cache key moved to v2 so no stored
  manifest keeps a direct S3 URL.
- **Uploads survive long copies and large trees (epic #1671, #1642, #1455, ADR 0094 and the
  ADR 0031 amendment).** S3 credentials are renewed during a long server-side copy and the copy
  is verified; annex workers are bounded and validated; resumed uploads are batched by size;
  annex adds are fed paths in NUL-separated batches; the CLI warns when tracking or saving has
  been idle; recorded upload checks are bound to annex keys and to the S3 target. On a large
  tree (1 GiB of annexed data or more) the save skips re-reading files whose size and mtime
  still match the upload plan and puts the skip back on any failure or signal. The annex size
  threshold is 100,000 bytes, as git-annex reads `100kb`, and the CLI's selection is
  authoritative for upper-case data extensions.
- **`nemar` rejects an option an ancestor command would swallow (#1493).** `nemar dataset
  release <id> --version 2.0.0` used to print the CLI version and exit 0, so a scripted release
  did nothing. The pre-pass joins the value to the flag, and rejects a shadowed flag with no
  value or typed before its command.

### Changed

- **Password sign-in is removed (ADR 0097, migrations 0093 and 0094).** `POST /auth/signup` and
  `POST /auth/retrieve-key` answer 410 `password_sign_in_retired` and say to run `nemar auth
  login`; `nemar auth retrieve-key` stays as a hidden stub that exits 1; `bcryptjs` and
  `services/password.ts` are deleted. Every stored `password_hash` is set to NULL (not
  reversible; Time Travel keeps copies for up to 30 days, and exports and the hourly backup until
  they are deleted) and a trigger refuses the
  retired route's insert shape. API keys, `POST /auth/login`, `regenerate-key`, the device flow
  and the web code flow are unchanged.
- **`git init` falls back for a git older than 2.28.** `git init -b main` is tried first; on
  its usage-error status the CLI runs a plain `git init` and points an unborn `HEAD` at
  `main`.
- **Bun is pinned to 1.4.3 in every workflow and in `packageManager` (#1703).**

### Fixed

- **The availability report never creates `main`.** On a dataset that was created but had not
  pushed yet, the sweep's write created `main` as an unrelated root commit and the next upload
  failed after 12 attempts. The write now refuses with 409 when `main` is missing, and the sweep
  only considers datasets that have a version.
- **A git-annex repository no longer records the uploader's login, node and path
  (#1683).** `git annex init` is given a fixed description, and an upload replaces a default one
  left by an older CLI before anything is pushed. The old value stays in the history of an
  already-pushed `git-annex` branch (the back-catalogue is #1399).
- **An imported dataset's first push no longer stops on the source's own repository names.** The
  privacy gate added with #1683 refused any clone whose `uuid.log` held a `user@host:/path`
  description, and OpenNeuro's own repositories carry them (all of 20 older datasets checked, for
  example `root@93184394ac19:/datalad/ds000001`), so `nemar admin import prepare` stopped at the push. Before
  anything of the `git-annex` branch is published, another repository's description is replaced with
  `upstream` and the history is pruned again; this machine's own description is still refused, and the
  message now names the way out.
- **`--verbose` no longer prints a GitHub token.** The credential helper written for a push or a
  fleet clone, and the token `gh` returns for `nemar admin pr-reviews` and the fleet annex policy, could
  reach stderr, which people paste into issues. Only `nemar sandbox` turns that log on today.
- **`nemar dataset download` reports a file the manifest lists and storage lacks as absent.** The data
  plane answers 502 for it; the downloader retried three times and exited 1, where ADR 0005 treats a
  file the archive does not have as a reportable gap. Any other 502 is still a transport fault.
- **A retired command, or a refused `regenerate-key`, no longer asks for a bug report.**
- **A blocked-publication sweep that throws is an error in the audit tally**, not a run with nothing to
  do.
- **`bun run migrations:d1-check`** reads wrangler's catalog around the warning banner it prints when a
  proxy variable is set.

### Migrations

- `0092_pr_reviews.sql`: the review table, the contributor-override table and their CHECKs.
- `0093_clear_password_hashes.sql`: sets every stored password hash to NULL. Not reversible.
- `0094_guard_retired_password_signup.sql`: refuses the retired signup insert and clears any
  hash written between the two migrations.
- `0095_pr_review_attempts.sql`: adds `pr_reviews.attempts` (1 for every existing row), so the
  platform's daily pool counts model calls rather than rows. `bun run migrations:d1-check`
  passes.

### Deploy coupling

- Migrations run before the Worker deploys. The previous Worker serves the old signup route
  for a moment after 0093; 0094 closes that window.
- The CLI calls routes the old Worker does not have (`/admin/users/by-id/:id` and
  `/admin/pr-reviews`), so the Worker must be live before the package is installed.
- **Re-audit chunked datasets after the deploy:** `nemar admin data-integrity-sweep --reaudit`.
  A stored `data_complete = 0` stays 0 until something re-verifies the dataset (ADR 0064).
- **Trying the automated review** takes three steps outside this release: subscribe the NEMAR
  App to Pull request events (Pull requests: write); have the four `ANTHROPIC_*` organization
  variables on `nemarDatasets`; deploy `run-pr-review.yml` to `nemarDatasets/.github` (a change
  there reaches every dataset repository at once, ADR 0020) and wire its parity test with
  `NEMAR_PR_REVIEW_WORKFLOW_LIVE`. The flag is already on in the dev Worker's config, and the
  production Worker forwards events for the datasets dev owns (the `xx09*` datasets and the
  fixture `nm099998`) to it, so a throwaway pull request to a published `xx0999NN` exemplar runs
  the whole chain while production stays dark (`nm099998` is an anonymous deposit and `nm099999`
  is private and production's, so neither is ever reviewed). **Turning it on for real datasets**
  is adding the flag to the production block of `backend/wrangler-sccn.toml`, which ships in a
  later release, after that trial has passed. A pull request that is open at that moment
  produces no event; `nemar admin pr-reviews start --all` reviews those.
- Pages on `docs.nemar.org` that name `nemar auth retrieve-key` need the same edit as the CLI
  messages (ADR 0097): `cli/getting-started/authentication`, `cli/getting-started/quickstart`,
  `platform/api` and the help capture in `cli/commands/auth`. That repository is private.
- The hourly D1 backup (ADR 0004) keeps the password hashes in its git history. Clearing them in
  the database does not touch it; rewriting that history is a separate decision (ADR 0097).
- Do not run `nemar admin fleet key-registration --apply` on a chunked dataset until `git annex get`
  of a chunked key is shown to work (ADR 0064 and 0095).

### Known limitations

- The live model call, the workload identity exchange and a real run of `run-pr-review.yml`
  have not run on GitHub; everything around them is tested against real git, real SQLite and
  stand-ins for the two HTTP services.
- The `NEMAR PR Review` check is not required by any ruleset. Making it required waits until
  the false-fail rate is known.
- Manually redelivering an older commit's event makes it the latest and the newer commit's
  claim is refused; both end as "push again" (ADR 0092, accepted risk).
- Part of #1455 is addressed here and the issue stays open: acceptance against a real upload
  (files over 1 GiB, authenticated S3, a final save on NFS) and the persistence of the idle
  warnings are not settled. The S3 credential renewal and the multi-batch copy have no automated
  test against a real bucket (the loopback test was removed); run one real upload to a dev dataset
  before relying on them.
- Chunked files are served by the Worker from a stream, and workerd may drop the hand-set
  `Content-Length`; the chunk listing is bounded to 512 objects per backend and size. Read a chunked
  sample from staging before announcing it (ADR 0095, known limits).
- A recorded publication request whose latest BIDS run ends `cancelled`, `timed_out` or `skipped`
  stays waiting until another run starts, while the CLI says it continues automatically (ADR 0086).
- `nemar dataset update` does not clear stale assume-unchanged flags left by a save killed with
  SIGKILL; `nemar dataset commit` does (ADR 0094).
- Owner edits of an account's email and GitHub handle (ADR 0096, still proposed) do not end the old
  holder's keys and sessions, and the handle is not checked against GitHub.

## 0.10.15 - 2026-10-07

Epic #1610: identifier screening and an in-place scrub of published datasets. A third party
reported that EDF and BDF headers in a published dataset carried name-like strings and a date.
Sixteen datasets were corrected (old bytes deleted, DOIs and version numbers kept, a public
ledger of counts and fixed words per dataset); this release makes sure it cannot start again.

### Added

- **A publication request is screened for identifiers before an administrator is asked
  (#1628, ADR 0086).** The Worker dispatches the `run-identifier-screen` workflow of
  `nemarDatasets/.github`, which reads the dataset and posts a verdict bound to the commit it
  read; the administrator mail waits for it. A direct identifier blocks the request and tells
  the requester; `unchecked` (the workflow did not run, or the scan could not read
  everything) is never treated as clean. `nemar dataset publish status` and
  `nemar admin publish list` show the verdict by its fixed words. An accepted request is
  answered with a neutral four-line notice that names no finding (received; checking
  eligibility; an administrator is notified if every check passes; the `publish status`
  command, #1664).
- **`nemar dataset upload` screens on the uploader's machine first (#1635, ADR 0087).** It
  reads 256 bytes of every EDF and BDF header and the side files within limits, refuses
  direct identifiers (also under `--dry-run`, no override), and asks for an acknowledgment
  that names exactly what was found for anything lesser (`--acknowledge-identifier-preflight`;
  `--yes` never counts). Output is fixed words and counts, never a value or a path. The
  Worker re-screens at publication; what the CLI records is a note, not a verdict.
- **A scheduled sweep re-screens published datasets (#1636, ADR 0088).** Production only, at
  most three dispatches per 30-minute tick (a verdict counts for 28 days), on a cadence that
  does not depend on the verdict (the Actions run list is public). It reports, never repairs,
  files no issue and mails no requester. The weekly admin report (new `identifier_sweep` mail
  category) says what was not screened; `GET /admin/identifier-sweep` shows it on demand.
- **Imports from OpenNeuro are scrubbed in place before the push (#1639, ADR 0089).** Every
  recording header the copy will copy is read first; a header with an identifying string is
  patched in bytes 8 to 168 only, proven, annexed under a new SHA256E key, and the old key is
  retired. Finalize waits for the screen and approves only a clear verdict; a held import is
  not an import failure.
- **Acquisition dates (#1657, #1667, ADR 0090 and 0091).** A day-level acquisition date is a
  review finding that warns and never blocks, with one shared warning sentence shown to the
  uploader, the requester and the administrator. For NEW uploads and imports the date of an
  EDF or BDF header is set to 1 January of its year (the start date and the EDF+ `Startdate`
  slot); an import also sets inline `acq_time` values in scans tables, and an upload edits no
  table. On upload the change is made to the files in the uploader's own directory, after the
  final confirmation and by copy and rename, never in place; a file git tracks or ignores, a
  link, or a file the uploader cannot write keeps its dates and is warned about. Nothing already
  published is changed.
- **Operator tooling for the scrub (#1625 to #1640, ADR 0085).** `scripts/scrub/` (plan,
  assemble, verify, delete-old with batched `DeleteObjects`, Zarr stage, git rewrite and
  verify, ledger) and the runbook `.context/scrub-runbook.md`. It runs from an operator's
  machine only. The Worker does not use it; the CLI bundles three of its helper modules (the
  contract constants and key rules, the annex registry and location-log readers, and the
  ledger file) for the importer (ADR 0089), and none of its stages. Nothing in them runs at
  import.
- **A deterministic scanner and a fleet scan script (#1617).**

### Changed

- **The Zarr converter never writes subject information into a store (#1627).** It refuses to
  convert on a biosigIO that cannot leave it out; `biosigio>=1.2.11` is required.
- **`scrub-tools` CI is a 5-way shard with a gate job of the same name (#1665).** About ten
  minutes instead of 46. It runs only when the scrub toolchain, the scanner files it imports or
  the scrub suites change.

### Fixed

- **A `trial_type` longer than 128 code points is keyed by a digest form (#1660).** Counts
  stay per distinct value; a carried-over index entry is re-keyed at the next merge, so no
  store is reconverted.

### Migrations

None.

### Deploy coupling

- The Worker deploys with the merge to `main`; the npm package follows. The CLI calls routes
  the old Worker does not have, so the Worker must be live before the package is installed.
- `run-identifier-screen.yml` lives in `nemarDatasets/.github` and is pushed separately, after
  this release (the workflow runs `scripts/identifier-screen-ci.ts` from `main`). A workflow
  change there reaches every dataset repository at once (ADR 0020). Until it is pushed every
  publication request ends `unchecked` and the administrators get a "did not run" mail.
- Hallu's converter (cron `ZARR_DRIVER_REF=main`) picks up the new `generate_zarr.py` on its
  next tick and installs `biosigio>=1.2.11,<1.2.12` from `requirements.txt`; setup stops with
  a FATAL line, converting nothing, when the installed version is outside that range. The first
  tick runs the previous script body, which still caps biosigIO below 1.2.11, so it can install
  1.2.11 and then stop at that check; the next tick converts. Nothing is marked failed in the
  queue either way (the converter exits 78 when it cannot leave subject information out, and
  `hallu-zarr.sh` stops the drain on it).
- `nemarOrg/docs` pull request 64 describes all of the above and is merged with this release.

### Known limitations

- The screen reads EDF and BDF headers, JSON keys, tabular columns and file names. FIF,
  BrainVision, EEGLAB `.set`, GDF and other formats are not parsed and are reported as not
  screened, never as clean; images, video and documents are only flagged by file type.
- Datasets that were already public keep their day-level acquisition dates.
- The fleet strip of existing Zarr stores (#1626) and the scan of JSON-decoded strings in
  the scrub verify (#1630) are not in this release.

## 0.10.14 - 2026-10-07

### Fixed

- **Zarr conversion admits recordings against free scratch disk and reclaims what a killed
  worker leaves behind (#1638).** A very large recording could never finish: the conversion
  node's scratch volume filled, workers died with `No space left on device`, and the dead
  workers' scratch stayed on disk, so every recording queued behind them failed the same way.
  nm000276 (40 recordings, 3,031 GiB) stalled at 12 converted for that reason. Memory was not
  the cause. A recording is now charged 3 times its bytes when streamed (2 times otherwise)
  against free space plus what its in-flight recordings hold, minus 10 GiB, re-read every
  round, and one that does not fit yet is deferred rather than attempted. A deferral is neither
  an attempt nor a conversion: it keeps a published store whose index is current, counts as
  not attempted so the queue advances no retry round, and a run that defers everything and
  finds the index unchanged writes nothing to S3. Each recording gets its own memmap
  directory; after a broken worker pool its scratch is deleted, its orphaned `aws s3 cp`
  children are killed, and the free space before and after is logged. A killed worker's
  verdict now lists a full scratch disk among its possible causes, and a pool break warns
  about it, so a full volume is no longer read only as out of memory.
- **`generate_zarr.py --check-env` and a single settings check per run (#1638).**
  `hallu-zarr.sh` validates the `ZARR_SCRATCH_*` settings once before it dispatches anything,
  so a typo stops the run with the queue and D1 untouched instead of posting `failed` and
  burning an attempt for every dataset the drain visits.

### Known limitations

- The 3x factor is the measured float32 peak plus margin, so an int16 source can still hit
  `No space left on device`; this narrows the risk, it does not remove it.
- A recording that can never fit is still re-queued hourly (a metadata clone and the
  start-of-run signal, no publish), and its `ready` callback restamps `zarr_converted_at`.
  The start-of-run signal sets the dataset pending again each hour, and each `ready` callback
  clears its recording-stats stamp so that sweep picks it up again. An `unchanged` webhook
  status and a `scratch_deferred` field are the follow-up.
- nm000276's largest recording is charged about 532 GiB, and admission also keeps 10 GiB of
  headroom, so it needs about 542 GiB free with nothing else running and stays deferred until
  then. With `ZARR_SCRATCH_STREAM_FACTOR=2.9` it is charged about 514 GiB and needs about
  524 GiB free.

### Migrations

None.

### Deploy coupling

Merging to `main` makes the Hallu converter (the Zarr conversion host, cron `ZARR_DRIVER_REF=main`)
run this code on its next tick. The only other deploy-relevant changes are the versions:
`backend/package.json` moves, so the backend redeploys unchanged, and the root `package.json`
moves from 0.10.13 to a `0.10.14-devN` pre-release, so the merge also triggers `auto-tag.yml`,
which strips `-dev`, tags `v0.10.14` and publishes the identical CLI to npm as a new version.
A dataset already stuck on scratch space converts again only when it is queued:
`hallu-zarr.sh --dataset <id> --requeue done --execute`.

## 0.10.13 - 2026-10-05

### Added

- **NEMAR records for Neurobagel's federated search (epic #1586, ADR 0081 to ADR 0084).**
  [Neurobagel](https://neurobagel.org/) searches participant-level information across
  archives that each run a node. NEMAR now converts what its data plane already serves into
  Neurobagel records and serves them to a stock Neurobagel node, which pulls them. The
  parts, in the order data flows through them:
  - **One pure transform (`shared/neurobagel/`, ADR 0081).** It turns `metadata.json`,
    `participants.tsv` and `participants.json` into graph-mode JSON-LD, a Neurobagel data
    dictionary, a dataset description and a counts-only report. Identity comes only from
    `metadata.json`, and the transform refuses any input whose `anonymous` is not exactly
    `false`. Identifiers are version 5 UUIDs under one committed namespace, so they never
    churn between runs; the vocabulary is a pinned snapshot; output is byte-stable and
    validated before it is returned. A fact the rules cannot establish is left out and
    counted, never guessed. Only `eeg` and `meg` map to an imaging modality, because
    Neurobagel's vocabulary has no other. A column named `sex` is read as sex; a column
    with any other name is read as sex only when the dataset's own `participants.json`
    description says sex and does not mention gender (#1609), and numeric codes are never
    read without a reviewed annotation.
  - **Reviewed annotations (`shared/neurobagel/curation.json`, ADR 0083).** A strict,
    content-pinned file keyed by dataset id for what the automatic rules cannot read
    (assessment columns, group labels, a few sex and age columns). Terms come only from the
    pinned vocabulary, an entry applies only to the exact table it was reviewed against,
    one that no longer applies is skipped whole and the variables it names are withheld
    with a flag, and a dataset with an entry is never converted without it. Every entry
    records its source and reviewer. Twelve ship: six written and reviewed by the author,
    and six reused from annotations the Neurobagel community published for OpenNeuro
    datasets (MIT license), which are marked as not reviewed by NEMAR beyond the loader and
    binder checks.
  - **One eligibility predicate (ADR 0084).** A dataset is federated only when it is
    public, published and not anonymous, and is not withdrawn, deleted, tombstoned, a
    sandbox, a fixture or an exemplar. OpenNeuro mirrors (`on` ids) are included on
    purpose. The predicate is one list of named terms compiled to SQL and TypeScript from
    the same source, decided from the D1 row, and re-checked at every read.
    `anonymous: false` in the gathered metadata is a second, independent guard; its
    disagreement is an audit-log finding and writes nothing.
  - **A writer that never blocks a flow (ADR 0084).** A hook on publication and import
    callbacks (fire-and-forget through `waitUntil`) and a production-only daily reconcile
    on the existing 03:00 tick write each dataset's artifacts, then that dataset's entry
    in `index.json`, to a new private R2 bucket (binding `NEUROBAGEL`). A dataset is
    skipped when its fingerprint matches (row fields, latest version, manifest ETag,
    curation entry, transform version, vocabulary pin). The writer is **off unless
    `NEUROBAGEL_WRITER_ENABLED` is `1`**, counts its D1, R2 and HTTP operations at the
    bindings, stops with headroom, and defaults to 10 datasets a tick
    (`NEUROBAGEL_RECONCILE_MAX`, at most 50; a call is capped at 50). Measured: about 22
    operations for a rewritten dataset, 3 for an unchanged one. A dataset that stops being
    eligible leaves the index before its artifacts are deleted.
  - **A read route for the node.** `GET /neurobagel/index.json` and
    `GET /neurobagel/<name>`, behind the `NEUROBAGEL_READ_TOKEN` secret (a deployment
    secret, not an account credential). It answers 401 without the token, 404 for any
    name that is not an artifact of an eligible dataset, re-checks eligibility on every
    request and serves the index without a dataset that is no longer eligible. Every
    answer is `no-store` and served directly, never as a redirect.
  - **Admin surface.** `GET /admin/neurobagel/status`, `POST /admin/neurobagel/regenerate`
    (dry run by default) and `POST /admin/neurobagel/verify`, and the matching
    `nemar admin neurobagel status|regenerate|verify` commands. `status` and `verify` exit
    0 when healthy, 1 on an alarm and 2 when the answer could not be determined.
  - **A daily verification sweep (production only, reports and never repairs).** It checks
    the store against the predicate (residue, and datasets eligible but missing for 48
    hours), probes the node (`NEUROBAGEL_NODE_URL`), reads the registration state
    (`NEUROBAGEL_FEDERATION_URL`) and compares Neurobagel's release tags and vocabulary
    against the pins. Verdicts are `healthy`, `alarm`, `unknown` and `unchecked`, following
    ADR 0053 and ADR 0054: a check that could not run is never healthy, and a heartbeat is
    written even when the sweep throws. A new section of the weekly import report carries
    counts only. The anonymity sweep (ADR 0067, amended) gains the invariant
    `neurobagel_store_holds_deposit`: an object for an anonymous deposit in the store is
    an audit-log finding and a `dataset_anonymity` mail, never a GitHub issue.
  - **`session_modalities` in `bids_index` (ADR 0081, rule 6).** The `bids_index` block of
    `metadata.json` gains an optional `session_modalities`, which records which datatypes
    belong to which session (`no-session` for subjects with none). It is additive:
    readers that ignore unknown keys are unaffected, and an existing dataset gains it the
    next time its index is built.
  - **The node's deployment definition (`deploy/neurobagel/`, ADR 0082)** and the tools
    around the transform (`scripts/neurobagel/`: the gatherer, the vocabulary generator,
    the oracle that checks every golden against Neurobagel's own `bagel`, and the
    annotation reuse tool). Nothing in the API depends on the node.

### Deploy coupling

- The release carries a new R2 binding, `NEUROBAGEL`, in `backend/wrangler-sccn.toml`
  (bucket `nemar-neurobagel`; the dev environment has its own, `nemar-neurobagel-dev`).
  A deploy whose binding names a bucket that does not exist fails, so both buckets must
  exist first.
- Nothing federates until the owner opts in. With `NEUROBAGEL_WRITER_ENABLED` absent the
  writer, its hooks and the reconcile do nothing at all; the read route needs
  `NEUROBAGEL_READ_TOKEN` and answers 401 without it; the sweep's node and registration
  checks report `unchecked` until `NEUROBAGEL_NODE_URL` and `NEUROBAGEL_FEDERATION_URL`
  are set. The sweep itself needs no switch and writes only its heartbeat.
- After the writer is enabled, run `nemar admin neurobagel regenerate` once to backfill
  (it is a dry run until told to execute); the reconcile alone takes about 78 days to cover
  every dataset at 10 a tick.
- No D1 migration. Rolling the Worker back is safe: the store is a separate bucket, and
  the 0.10.12 Worker neither reads nor writes it.

### Known limitations

- Neurobagel's imaging-modality vocabulary has only EEG and MEG, so datasets of other
  kinds (intracranial EEG, EMG, NIRS, motion) are federated without a modality: 106 of 776
  datasets at the time of writing.
- Conditional writes and list paging are proven against the R2 simulator, not against
  real R2; the production Worker's timing and subrequest use on the 03:00 tick are
  unmeasured. The soak that follows the release records both.
- NEMAR is not registered with the public federation, and registration is a separate step
  gated on a soak and on Neurobagel's agreement.

## 0.10.12 - 2026-10-02

### Added

- **A session scope and a service-binding entrypoint for the private site (#1577, ADR 0078,
  ADR 0079).** The private site (`private.nemar.org`, which hosts access-controlled
  features) reaches the API through a service binding to a new `NemarApiRpc` entrypoint,
  not over HTTP. It has three methods: `resolvePrincipal` (a private-site session or an
  API key in, the account behind it out, with its live role and status),
  `exchangePrivateGrant` and `revokePrivateSession`. The public API gains exactly one
  route, `POST /auth/private/grant`, called server-side by the website's authorize page
  behind the app session and the NEMAR Origin allow-list. It answers 200 with
  `{ code, expires_in }`, 403 `Origin not allowed` for a missing or foreign Origin
  (checked first), 401 `unauthenticated` without a session, 429 past the per-account
  limit, 403 with the usual inactive-account body for an account that is not active, and
  400 `invalid_request` without a valid `state` (32 to 256 base64url characters). Every
  answer is `no-store`. A third `web_sessions` scope, `private`, is minted by the
  same one-time-grant handoff the docs host uses (a 60-second code, traded once) for any
  active account, not only admins, and lasts 8 hours with no remember-me. Unlike the docs
  handoff it binds the browser that starts a sign-in to the one that finishes it: the
  private site keeps a random `state` in a host-only cookie, the grant stores only its
  hash, and the exchange mints only when the same value comes back. The private site is a
  write surface, so without that an attacker could finish their own sign-in in a victim's
  browser and receive the victim's uploads. Grants are limited to ten a minute per
  account rather than by address, because every sign-in arrives from the website's few
  Cloudflare egress addresses (#1354). Maintenance mode applies to the entrypoint by the
  middleware's own rule: writes are refused in `read-only` and `full`, reads in `full`.
  The entrypoint has no CORS and no rate limit of its own, and any Worker deployed in the
  Cloudflare account can bind it, so the account's deploy permissions are part of this
  API's security and no method takes a bare user id as authority (ADR 0078).
  A method for dataset facts was drafted and left out on purpose, until a caller settles
  how anonymous deposits and archived rows are disclosed.
  `shared/contract/private-site.ts` is the contract the other repositories transcribe.
- **`POST /admin/publish/:id/approve-dispatch` hands a web approval to a workflow (#1578,
  ADR 0080).** Approval is sixteen steps, and S3 Object Lock (step 14, after the
  irreversible DOI publish) works in batches of 100 objects that the caller must keep
  requesting. The CLI loops; the website sent one `{}` and reloaded, so a dataset over
  100 files would stop at `approving` with its DOI public and nothing locked. The route
  (admin only, no body) claims the newest active request with one conditional update,
  records the clicking admin, clears `last_error`, and dispatches
  `repository_dispatch[approve-publication]` to `nemarDatasets/.github`, which runs
  `nemar admin publish approve` on a runner. It writes an `approval_dispatched` audit
  row and answers 202 `dispatched` with `dataset_id`, `request_id` and `resume` (true
  when the request was already `approving`), or 403 `origin_not_allowed` (a cookie
  request needs a NEMAR `Origin`; a bearer key does not), 404 `not_found`, 409
  `not_dispatchable` or `already_in_flight`, or 502 `dispatch_failed`,
  `dispatch_unconfigured` or `dispatch_unconfirmed`. The payload names an environment
  (`production` only for the production Worker, `dev` for anything else including an
  unset value) and never a URL or a credential. A dispatch whose answer is lost (a
  dropped connection, a timeout, or a 5xx from GitHub, which can follow an event it had
  already queued) keeps the lease and writes an `approval_dispatch_unconfirmed` audit
  row, so a retry answers 409 until the lease lapses (up to 15 minutes). Only a definite
  not-sent failure (a 4xx from GitHub, a token that cannot be minted, no credential)
  releases the claim, and it puts the cleared `last_error` back unless a run has begun
  since. The lease gates only this route: a terminal approval is never refused by it.
- **`GET /admin/publish/requests` reports `approval_requested_by`,
  `approval_dispatched_at` and `approval_in_flight` (#1578).** `approval_in_flight` comes
  from the same SQL the claim uses, so a page never offers a button the route would
  refuse. A run is in flight for 15 minutes after its dispatch or its last progress, a
  person's terminal run blocks a web launch, and a run that recorded an error stays in
  flight for a 60-second grace window (longer than the CLI's 10-second retry wait) and is
  stalled after it, so the page can offer Resume without waiting out the lease. Clients
  read the boolean and must not hard-code the minutes.

### Changed

- **A web approval is attributed to the admin who clicked, while their run is live
  (#1578).** The orchestrator reads `approval_requested_by` from the request it acts on
  and, while the time-only lease is live, records that admin in `approved_by`, the
  `dataset_published` audit row and the `notify_user_failed` audit row; the
  `dataset_published` details also keep the executing account as `executed_by`. A run
  that lapsed and was resumed by a different admin at a terminal records that admin, and
  a terminal approval outside a live lease is unchanged. A clicker who has since been
  demoted below admin, revoked or deleted is not recorded: the executing account stands
  in. `POST /admin/publish/:id/approve` keeps its request and response contract; each
  attempt now starts by clearing `last_error`, and the owner-name gate's walk-back to
  `blocked` clears the web claim. Two costs, stated in ADR 0080: a web run that sat
  quiet longer than the lease before its first `/approve` call is recorded under the
  executing key (its `approval_dispatched` audit row still names the clicker), and the
  fork is on the lease, not on who calls, so a person who runs `/approve` at a terminal
  inside a web run's live lease is recorded as its clicker, with themselves as
  `executed_by`.
- **Sign-out, an admin account revoke and the owner soft delete also end the account's
  private-site sessions and grants (#1577).** A role demotion leaves `private` sessions
  alone because `resolvePrincipal` reports the live role on every call, and an API key
  revocation leaves them alone because a private session is never minted from a key
  (ADR 0079 records both).
- **The Worker entry module is `backend/src/worker.ts` (#1577).** It re-exports the HTTP
  app and cron handler from `index.ts` unchanged and adds `NemarApiRpc`, so `index.ts`
  never imports `cloudflare:workers`. `wrangler-sccn.toml` `main` points at it for both
  environments.
- **The deploy workflow smoke-tests the private grant route on both environments
  (#1577).** After `/health` reports the new version, an anonymous
  `POST /auth/private/grant` with an allowed Origin must answer 401. A network error, a
  5xx and a 404 are retried, up to three attempts, because a request can land on an edge
  still serving the previous version for a few seconds; any other answer, or a 404 on the
  last attempt (the route is missing from what shipped), fails the job and prints the last
  response's headers and body. In maintenance mode every POST is a 503 and the check
  warns instead of failing.

### Security

- **Revoking an API key ends the account's docs sessions on every path (#1577).** A docs
  session can be minted from an API key (`POST /auth/docs/cli-session`), and two paths
  that revoke keys did not end it: an owner revoking a user's key
  (`DELETE /admin/users/:username/keys/:id`) and the key-regeneration confirmation link
  (`GET /auth/confirm-key-regeneration`). The docs session kept reading `/admin/*` for the
  rest of its fifteen minutes. Both now run the same best-effort cascade as self-service
  revocation, and it also runs when a by-id revoke loses a race to a concurrent one,
  whose own cascade may be the one that failed.
- **`optionalAuthMiddleware` no longer identifies an account from an expired API key
  (#1577).** Its private copy of the key lookup had no `expires_at` predicate, so an
  expired key still resolved to its account on every route that reads the caller
  optionally (`GET /notices`, the catalog reads and the manifest reads). It now shares the
  one lookup the rest of the API uses, still without the `last_used_at` write, so those
  routes stay pure reads. Such a key is now anonymous there: `GET /datasets?mine=true`
  and a non-public `GET /datasets/:id` answer 401 "Your API key was rejected". No
  `INSERT INTO tokens` in the backend sets `expires_at` today, so this closes a latent gap
  rather than one a live key could hit.

### Fixed

- **A failed logout revoke names the account in the log (#1577).** The batch is
  all-or-nothing, so the account id is what an operator needs to finish the job by hand.
- **The docs-session cascade after a key revoke names the account in its log (#1577).**
  The line is now `[docs-auth] failed to cascade key revocation into docs sessions for
  user <id>` (it was `[auth-keys] failed to cascade revocation into docs sessions`), so
  update any log search that matches the old text.

### Migrations

- `0089_private_site_sessions.sql` rebuilds `web_sessions` to widen
  `CHECK (scope IN ('app', 'docs'))` to include `'private'` (SQLite cannot alter a
  `CHECK`), and adds `private_grants` with a required `state_hash`. Every row and column
  is copied across and the two existing indexes are recreated, plus two new ones (a
  partial `idx_web_sessions_private_scope` and `idx_private_grants_expires`).
  `_rebuild_guard` aborts before the `DROP` if the copy is short or altered, provided the
  runner stops at the first failed statement: that holds for `wrangler --local` and
  Miniflare and is unverified for the remote apply. This is the one migration in the
  release that is not additive. Cloudflare does not document the remote apply as atomic,
  so the file's header records the window (a stop between the `DROP` and the `RENAME`
  leaves no `web_sessions` table, with every row safe in `web_sessions_new`, which must
  then be renamed, never dropped) and the recovery: D1 Time Travel to the start of the
  workflow's migration-apply step with the previous Worker redeployed first, or the
  remaining statements by hand, including the `d1_migrations` insert and the scratch
  table cleanup that the header spells out.
- `0090_approval_dispatch.sql` adds two nullable columns to `publication_requests`,
  `approval_requested_by INTEGER` and `approval_dispatched_at TEXT`, with no backfill and
  no index. It is additive, so rolling the Worker back is enough: the 0.10.11 Worker never
  reads either column, except that `GET /admin/publish/requests` returns both raw (its
  `SELECT pr.*`) and has no `approval_in_flight`, and its `/approve` does not attribute a
  web run to the admin who clicked.

### Deploy coupling

- Migration 0089 rebuilds `web_sessions` on production, the table every sign-in reads.
  Record a D1 Time Travel bookmark before the release; the migration's replay test
  asserts that every session row survives the rebuild.
- Rolling the Worker back to 0.10.11 is safe for the database, but once the private site
  is live it removes the `NemarApiRpc` export and the private site fails closed, so roll
  the private site back first. While 0.10.11 serves, its sign-out and key-revoke paths do
  not end `private` sessions or purge `private_grants`, so rolling forward within 8 hours
  revives the private sessions of accounts that signed out in between.
- The private site, the website's private-site authorize page and the website's
  web-approval button deploy after this release; none is live until then. Existing
  clients see only additive fields on the publish request list, plus the two `Security`
  changes above. The CLI itself does not change (its 10-second approve retry wait now
  comes from a shared constant).
- A web approval dispatches to `approve-publication.yml` in `nemarDatasets/.github`,
  which already exists on its default branch. A dispatch with no workflow would do
  nothing and the page would read "queued" until the lease lapsed.
- A failure inside the workflow before it reaches `/approve` (a missing secret, a failed
  install) is invisible to the backend: nothing is written and the lease lapses on its
  own, up to 15 minutes. So is a refusal inside the orchestrator before its step loop
  (the sandbox, no-repository, dataset-not-found and invalid-repository answers): the row
  is left `approving` with a fresh `updated_at` and no `last_error`, so the page reads
  "running" for the lease. Releasing it on failure is #1582.

### Known limitations

- **A resumed approval restarts S3 Object Lock at page 1 (#1580).** The continuation
  token lives only in the CLI process, so `--resume` or a new dispatch re-locks from the
  first batch. Already-locked objects answer 403 and count as success, so it is safe and
  only slow, but the workflow's job timeout is 350 minutes, so a dataset whose lock phase
  outlasts that cannot finish from the web. Approve a very large dataset from a terminal.
- **`nemar admin publish approve` exits 0 when an approval fails (#1581).** Automation
  cannot trust the exit code; the approve workflow reads `GET /datasets/:id/publish/status`
  back and fails unless the status is `published`.
- **`approve-dispatch` does not validate the dataset id before it claims the lease
  (#1583).** An id the workflow rejects (anything but `nm` or `on` plus six digits, or an
  `xx` id on production) claims the lease, fails in the workflow's Validate step, and
  leaves the website showing the approval as queued for 15 minutes.

## 0.10.11 - 2026-09-30

### Added

- **`data_papers` in `metadata.json` (#1572, ADR 0077).** The served
  `data.nemar.org/<id>/metadata.json` (and the `metadata` block of `page-bundle.json`)
  gains a top-level `data_papers` array: the papers the citation pipeline's judge
  confirmed as the dataset's own data paper, each `{ doi, title, year, venue,
  judge_model }`. `related_identifiers[].relation_type` is still only a hint; this key
  is the verdict, and it is the same one that decides whose citations count toward the
  dataset (nemarOrg/nemar-citations#250 and #251). An absent key means no statement
  (not judged yet); `[]` means judged, with no data paper. An entry can be a deposit of
  the same data (a figshare or Zenodo record), so there is no type field. Datasets
  deposited anonymously are served like any other (ADR 0077 records that decision). The
  daily Worker cron pulls `dashboard.nemar.org/citations/api/data-papers.json` into a
  new `datasets.data_papers` column. The writer is strict: a list over 10 papers or
  4096 bytes, or an invalid DOI, is refused whole, and a refused row clears that
  dataset's stored value rather than leaving a stale claim. A paper ADR 0075 never
  allows as a data paper (a standard, software or umbrella paper) is dropped from its
  list, and a non-empty list that empties this way is refused like any other. A
  duplicated dataset id in the manifest writes nothing, the fetched body is capped at 1 MiB and 5000 rows, and an
  unreachable or malformed manifest is logged and leaves every stored value untouched.
  The raw column is not exposed by `GET /datasets/:id`. A malformed stored value is
  omitted from the served document and logged, never a 500.
- **`latest_version_at` in the catalog (#1571).** The public list, `?mine=true`, the
  degraded fallback list and `GET /datasets/:id` serve the `created_at` of the newest
  `dataset_versions` row (SQLite UTC, `YYYY-MM-DD HH:MM:SS`), or `null` when a dataset has
  no version. It moves only when a version is released (or when an admin repair backfills
  a missing version row), unlike `updated_at`, which every reindex, finalize and DOI
  callback bumps: the 0.10.10 re-enrichment sweep made every
  swept dataset look freshly updated on the website. The website reads it from
  nemarOrg/website#384.

### Changed

- **`metadata.json` reports neuroschema 0.4.1.** The vendored bundle is updated and
  `schema_version` is `"0.4.1"` (was `"0.4.0"`). Consumers that compare the string
  exactly should accept the patch bump. Under the pre-1.0 policy from
  nemarOrg/neuroschema#14, additive optional fields such as `data_papers` are PATCH
  releases and breaking changes are MINOR. The schema sets `additionalProperties: false`,
  so a validator holding a 0.4.0 copy rejects documents that carry `data_papers`; refresh
  the copy. The live contract checks accept a deployed backend one PATCH behind the
  source; the pure tests still pin the exact version.

### Migrations

- `0088_data_papers.sql` adds one nullable column, `datasets.data_papers TEXT`, with
  `CHECK (data_papers IS NULL OR json_valid(data_papers))`. It is additive, so rolling the
  Worker back is enough: the 0.10.10 Worker ignores the column, except that
  `GET /datasets/:id` echoes it as a raw string (`null` until the first cron fills it,
  which is also what the old Worker serves there between the migration and the deploy). It brings the `datasets` column count to 84 of the
  97 ceiling that ADR 0034's budget test pins.

### Deploy coupling

- No dataset serves `data_papers` until the first daily cron after this deploy (03:00 UTC
  in production) has pulled the manifest. The dashboard already publishes it, so the
  first pull fills about 730 datasets, about 340 of them with at least one paper and the
  rest with `[]`. After that the key trails the citation pipeline's nightly run by about
  15 to 17 hours, and `page-bundle.json` can trail longer because its cache may be served
  stale for up to a day.
- The website's "Updated" badge reads `latest_version_at` and deliberately has no
  `updated_at` fallback. Promote website `staging` to `main` only after this release is
  live, or production cards lose the date.

## 0.10.10 - 2026-09-29

### Added

- **News posts (#1551, #1553, #1559).** The API stores and serves short news posts for the
  website (nemarOrg/website#371). `GET /news` lists published posts, newest first (10 by
  default, at most 50), and `GET /news/<slug>` returns one; a draft, or a post scheduled
  for later, answers 404 until its `published_at` passes. Admins create, edit and delete
  posts under `/admin/news`, and upload images with `POST /admin/news/media`: PNG, JPEG,
  WebP or GIF, checked by their leading bytes, at most 5 MiB, stored once under the
  SHA-256 of their bytes in a dedicated R2 bucket and never overwritten.
  `GET /news/media/<file>` serves them with the type their file name implies, a one-year
  immutable cache and `X-Content-Type-Options: nosniff`. Every post write and image upload
  leaves an audit-log row, written with the post change or before the image is stored.
  ADR 0076 records why images live in R2 and dataset bytes stay in S3, and how to recall
  an image uploaded by mistake.

### Changed

- **Dataset enrichment runs on Claude Sonnet 5.5 and reads what each DOI is before
  labeling it (#1549, #1550).** Enrichment, validation and correction move to
  `claude-sonnet-5-5`. The model used to see bare DOI strings, so it mislabeled them in
  both directions: nm000275's own Scientific Data paper was typed `References`, while
  MNE-BIDS, EEG-BIDS and MEG-BIDS were typed `IsDescribedBy` on dozens of datasets. Each
  run now resolves up to 15 DOIs (from the BIDS fields, the existing related identifiers
  and the README) through DataCite and Crossref, and gives the model each one's title,
  first author, year, venue and type. A deterministic guard then demotes known standards,
  software, platform and umbrella papers (the BIDS family, MNE, EEGLAB, FieldTrip, the
  Hierarchical Event Descriptors, OpenNeuro, NEMAR, the Healthy Brain Network program and
  others) from any data-describing relation to `References`, and drops a dataset's own
  `10.82901/nemar.<id>` DOI from its related identifiers.
  The model may write or promote `IsDerivedFrom` only for a DOI that DataCite types as
  `Dataset`; existing `IsDerivedFrom` entries are left as they are. ADR 0075 records the
  rules, and the list must stay in step with nemar-citations' never-anchor list. A
  dataset's `.nemar/metadata.json` changes only when it is next re-enriched (a reindex, or
  a push that changes `README.md` or `dataset_description.json`); a re-enrichment sweep of
  the catalog follows this release.
- **`nemar admin reindex` reports its DOI lookups and warnings, and gains `--json` (#1550,
  #1556).** Single and bulk reindex responses carry `doi_resolution` (`resolved`,
  `unresolved`, `failed`, `skipped`). A lookup that gets no registry answer (429, 5xx, a
  timeout, or the 25-second budget for the whole lookup stage running out) counts as
  `failed` and adds a warning saying to reindex the dataset again; the run still succeeds.
  DOIs past the 15-lookup cap are listed to the model as not looked up rather than left
  unmarked. The summary output now prints each result's warnings, including the DOI-sync
  skip (#1255), which it never showed before. The warning is raised on the reindex path
  only; an enrichment triggered by a push logs failed lookups to the Worker log. The
  enrichment service's own response also lists `demoted_dois` and `self_dois_dropped`
  when there are any; the reindex response does not pass them through. The bulk route
  still has no per-request dataset cap (#1555), so a large reindex is best driven one
  dataset at a time.

### Fixed

- **Zarr: a channels.tsv row that differs from the recording's label only in letter case
  now applies (#1552).** The converter requires biosigio 1.2.10, which matches such a row
  to its channel when the match is unambiguous, so its type and unit are applied
  (nm000110's `Fp1-F7` against the file's `FP1-F7`). The store index reports these
  matches as `units_report.matched_case_only` with at most five examples, rather than
  republishing biosigio's per-channel map, and an index carried forward with that map is
  repaired on its next merge. The engine stamp is not bumped (ADR 0033), so nothing
  requeues on its own: stores converted earlier keep the importer's units until they are
  requeued, and `find_collapsed_channel_stores.py --case-only` lists the datasets whose
  index reports `unmatched_case_only`.

- **Zarr: recordings stored as git-annex chunks convert (#1563).** A dataset uploaded with
  git-annex chunking keeps only chunked object names in the bucket (nm000276 stores a
  100 GB `.eeg` as 94 objects), so every recording failed as an unexplained infra error
  and was retried until `retry_exhausted`. The converter now asks for the plain object
  first, and on a 404 lists the key's chunks, downloads them in order, checks the total
  against the key's size and assembles the file. A bucket with no complete copy is
  reported as `annex_object_missing` for that recording, so the rest of the dataset still
  serves; a dataset whose every recording is missing stays retryable. A 404 is no longer
  retried four times; throttles, 5xx answers and timeouts are retried as before. The data
  plane still builds plain object URLs, so a chunked dataset's files do not download
  through `data.nemar.org` yet (#1565).
- **Zarr: EEGLAB `.set` headers count toward the channel-count gate (#1564).** For `.set`
  recordings the gate had only channels.tsv to compare a store with, so a subject-level
  channels.tsv inherited from MEG recordings (on003645: 404 MEG channels over 75-channel
  `.set` files) refused all 108 EEG recordings. The converter now reads `nbchan` from the
  header of classic MAT and MATLAB v7.3 files without reading the data, and trusts it only
  where it matches what the importer serves; an over-declaring channels.tsv is then
  disclosed as `channels_tsv_count_mismatch` and the store is published. An unreadable
  header falls back to the old, stricter check. The Zarr fidelity sweep accepts a short
  store that carries that disclosure.

### Migrations

- `0087_news_posts.sql` adds the `news_posts` table and an index on
  `(status, published_at DESC)`. It is additive (`CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`), so rolling the Worker back leaves the table unused.

### Deploy coupling

- The Worker binds the R2 bucket `NEWS_MEDIA` (`nemar-news-media` in production,
  `nemar-news-media-dev` on dev), and a deploy fails if its bucket does not exist. Both
  buckets were created before this release.
- Merging to `main` makes the Hallu converter use biosigio 1.2.10 on its next run. Stores
  already published are replaced only when requeued.
- The chunked-object fetch (#1563) lists `<id>/objects/` in the bucket, so the Hallu
  profile needs `s3:ListBucket` on those prefixes; without it a missing plain key answers
  403 and the dataset still ends `retry_exhausted`. nm000276 and on003645 convert only
  when requeued; requeue nm000276 on its own with a low `--jobs`, since its largest file
  is reassembled on the scratch disk (#1568).
- The re-enrichment sweep described in #1550 runs against production after this release,
  one dataset at a time.

## 0.10.9 - 2026-09-29

### Fixed

- **An archive request gives an honest answer for every version (#1539).**
  `GET /<id>/<version>.zip` now applies the size policy (ADR 0012) after the visibility and
  version checks, and before the latest-version check and any S3 request.
  A dataset over 100 GiB or 200,000 files answers 404 with `reason: "archive_skipped"` and
  the skip reason for every version, and a zip left in storage from before the policy is
  never served. Two such zips, of 120 GiB and 109 GiB, were downloadable until they were
  deleted by hand while this release was being prepared, together with two more
  over-policy zips (606 GiB and 102 GiB), 937 GiB in all.
  A version that was never published answers "Version not found" instead of "not the
  latest version", and a D1 database fault while checking an archive answers 503 instead
  of 500. The skip reason now says GiB, the unit it was always measured in, where it said
  GB; a reason already stored on a dataset keeps the old unit until its next skip write.
  A `ready` callback that carries no size no longer erases the recorded archive size.
- **Zarr: a store with fewer channels than its source file is refused (#1535, #1538).**
  Before biosigio 1.2.9, a channel label a recording repeats (CHB-MIT's `T8-P8`)
  overwrote the earlier channel, so every one of nm000110's 686 stores lost channels (22
  of 23 is the commonest case). The converter now requires biosigio 1.2.9, which renames
  repeats the way MNE does, and compares every store with the channel count in the file
  header, not only when `channels.tsv` disagrees. The header comparison applies to
  European Data Format (EDF) and BioSemi Data Format (BDF), BrainVision, and Functional
  Image File format (FIF) recordings; other formats still rely on `channels.tsv`.
  Channels a sidecar row did not match are listed in `units_report` instead of looking
  clean, through four new optional fields: `unmatched_channels`, `unmatched_case_only`,
  `unmatched_raw_label` and `unmatched_examples` (at most 5 examples). Renamed channels
  keep their electrode positions, and `scripts/zarr/find_collapsed_channel_stores.py`
  finds stores published before the fix. Stores already published stay served until they
  are requeued (see Deploy coupling).

### Migrations

None.

### Deploy coupling

Merging to `main` makes the Hallu converter (the Zarr conversion host) use the header gate
and biosigio 1.2.9 on its next run. That run converts only what is queued: a short store
already published keeps being served, and is replaced only by
`zarr_queue.py requeue --status done --dataset <id> --execute`.

## 0.10.8 - 2026-09-29

### Changed

- **Git-tracked files through data.nemar.org are cached (#1494, #1516, #1519).** The
  Worker keeps a Workers Cache API copy of each brokered file (sidecars, `events.tsv`,
  `channels.tsv`) for up to 7 days per data center. The visibility gate and the
  blob-SHA check against the current manifest still run on every request, so a dataset
  that goes private stops being served at once, and a rewritten manifest is never
  answered from a stale copy. Clients still receive `public, max-age=300`. ADR 0066
  records the decision.
- **The `data-ip` limit is 100,000 requests per minute per IP, up from 10,000, and
  cache misses have their own budget of 10,000 per minute (#1516).** A full download
  makes thousands of small requests; only the misses, which reach GitHub, are bounded
  separately. A file already in the cache is still served once the miss budget is spent.
- **The Worker runs with Smart Placement, and trusts a checked manifest for 60 seconds
  (#1494, #1526).** The `nemar.org` zone's traffic is answered from distant data centers
  (a client in Los Angeles was served from Dublin, Manchester and Sydney), so every D1
  read and S3 call crossed an ocean. Placement runs the Worker near its backends. A
  manifest confirmed against S3 within the last 60 seconds is used without asking again,
  and each isolate remembers resolved answers in a 4 MiB memo. Data-plane responses
  carry `Server-Timing` (gate, manifest, cache, upstream). ADR 0072 is amended.
- **`manifest.json` lists plain public S3 URLs for annexed files (#1522, #1529).** Every
  public dataset's objects are publicly readable, so the per-request signature added
  nothing. It made up 8.9 of nm000134's 16.1 MB and most of its ~10 s response, and
  expired after an hour, so a long download from one manifest failed partway. A dataset
  the bucket policy excludes still gets presigned URLs. Field names and order are
  unchanged. The document is cached behind the visibility gate, clients may keep it for
  300 seconds (60 when presigned), and the entry bound is 38,000 for unsigned manifests
  (30,000 when presigned). Code that parsed the `X-Amz-*` parameters or relied on the
  URL expiring must change. ADR 0074 records the decision.
- **Archive zips are named `<id>_v<version>.zip`, and only the latest version has one
  (#1491, #1518, #1521).** A download of `on002718` used to save as `v1.0.0.zip`. The
  backend reads the new name and falls back to the old one until the stored archives are
  renamed. An older version's archive request answers 404 with the latest version and a
  direct-download link instead of a failed download.

### Fixed

- **Oversized datasets no longer get an archive (#1514, #1520).** The size policy (100 GiB
  or 200,000 files, ADR 0012) was checked against a manifest the data plane only serves
  once a version is public, so an unpublished or private version built anyway; nm000284
  (512 GiB) produced a 345 GB zip. The dispatcher and both retry paths now apply the
  policy from the catalog row before dispatching, dispatches carry the size, a stale
  `ready` archive is no longer advertised for a newer version, and a `ready` callback for
  an older version no longer overwrites the latest version's archive fields. The
  workflow half is nemarDatasets/.github#121.
- **The anonymity sweep no longer reports a blinded Funding or Acknowledgements entry as
  naming someone (#1515, #1517).** Those fields reused the author-name placeholder rule,
  so wording such as "Redacted for double-blind review" was reported. Whole-entry
  redaction wording and no-funding declarations are now recognized; a real funder or
  name is still reported. ADR 0067 is amended.
- **Zarr: a FIF recording whose `channels.tsv` over-declares channels is served with a
  disclosure, and non-UTF-8 sidecars are read (#1527).** The channel gate reads the FIF
  header's channel count instead of refusing the store as truncated, and a Latin-1
  `channels.tsv` no longer retries forever.

### Added

- **`nemar dataset download --no-verify` and `nemar dataset get --no-verify` (#1523,
  #1525).** Opt-in: git-annex skips re-hashing each file it receives, a second full read of
  every byte downloaded. The CLI still checks every retrieved file's size
  against its annex key and marks a mismatch unavailable rather than downloaded. The
  default is unchanged, and a run with the flag says on stderr that verification was
  skipped. `--http` and OpenNeuro downloads already verify by size only, so the flag
  does nothing there.
- **Zarr: a reviewed per-dataset declaration for EEGLAB `.fdt` files kept away from their
  `.set` (#1528).** on004306 keeps its `.fdt` files under `derivatives/` with unrelated
  names, so its 15 raw recordings were unconvertible. Each declared pairing is checked
  against the header dimensions and the file size before and after staging, and nothing
  is matched by name. ADR 0073 records the decision.

## 0.10.7 - 2026-09-25

### Fixed

- **data.nemar.org answers datasets with very large manifests (#1502, #1505).** Every
  file, directory and HEAD request used to read the version's manifest whole and parse
  it. nm000281's is 43 MB (102,532 entries), so each request for it ended in
  `exceededMemory` (503) and took the rest of its isolate with it. The data plane now
  streams the manifest through a scanner that keeps only what the request needs: one
  entry for a file, one directory's children for a listing, totals and the BIDS index
  for `metadata.json`. Answers are unchanged. A manifest broken anywhere, even after
  the wanted entry, is still "Version not published", never a partial answer. ADR 0072
  records the decision.

### Changed

- **A version's `manifest.json` is refused with 413 above 30,000 entries.** It presigns
  every entry into one document, so no scan can bound it. The refusal carries
  `listing_url`, the version's `?format=json` listing, to read it through instead. Below
  the bound nothing changes. Every public dataset up to 26,410 files is under it; the
  seven above it start at 45,424 files.
- **The data plane keeps an edge copy of each manifest** and revalidates it with S3
  (`If-None-Match`), so a repeat request pays for a 304 rather than the whole body.
- **The CLI shows a refusal's reason for any status.** For the 413 above, `nemar
  dataset download --http` says it cannot fetch that version, and says to install
  git-annex and download without `--http`. It also shows the listing URL (#1506 tracks
  a `--http` path for these versions).

## 0.10.6 - 2026-09-24

### Added

- **`get_events` filters rows and columns (#1501).** Two optional inputs: `where`, a
  column name to the values to keep (compared as strings, every named column must
  match), and `columns`, the columns to return (`onset_s` and `sample_index` always
  come back). Every answer carries `columns_summary`, each column with its distinct and
  null counts and, when there are at most 50 short ones, its values, computed before
  `where`, so one call with `limit: 1` shows what a filter can ask for. A column the
  recording does not have is refused with the columns it has. For ERP CORE's N170
  recording, faces and scrambled faces with one column is about 10 KB instead of
  220 KB.

### Fixed

- **`get_events` answers recordings of a dataset whose `events.parquet` is large
  (#1499).** A file over the whole-file bound (16 MB or 100,000 rows) used to refuse
  every recording. It now reads only the row groups whose `store_path` statistics can
  hold the requested recording, and refuses only when those are over the bound too.
  nm000132 (ERP CORE, 153,722 rows) answers each of its 240 recordings.
- **The Zarr channel-count gate trusts the recording file (#1481).** It compared the
  converted channels with the BIDS sidecar; it now reads the EDF, BDF or BrainVision
  header's own count.
- **Zarr conversions fail less for memory, and retry what failed (#1484, #1485,
  #1486, #1488, #1489).** Each worker bounds its concurrency and allocator arenas; a
  memory failure is retried alone within the run and logged with the worker's memory
  at that moment; a retry round reconverts only pending recordings rather than the
  whole dataset; admission re-reads the node's available memory as it runs; and
  biosigio 1.2.8 writes each shard once rather than once per channel (110 s to 8.8 s
  and 5.1 GB to 1.8 GB on a 128-channel, 30-minute EDF).
- **Staging's catalog sweeps cover the exemplar fleet (#1497),** so test.nemar.org
  shows those datasets' Zarr tags and viewer filter as production shows the datasets
  they copy.

### Changed

- **The catalog sorts by when a dataset went public (#1478):** its first publication,
  else its publish date, else its creation, one definition read by every date-based
  ordering and filter. Catalog entries gain an optional `first_published_at`, null
  until a dataset is first published and absent from older backends.
- **`read_window`'s `python_browser` recipe leads with eegprep-lean's `read_window`
  (#1487),** which returns physical units with channel labels. It used to lead with
  `open_array`, whose stored digital counts plot as a figure that looks like EEG and is
  wrong. The recipe's `read_index(index_url=...)` needs eegprep-lean 0.1.0.dev2 or
  later.

## 0.10.5 - 2026-09-21

### Added

- **The catalog's whole filter surface is available over the Model Context Protocol
  (MCP) (#1429).** `search_datasets` advertised six filters and accepted thirty-three;
  an assistant could only reach the six it was told about, and a name it invented for
  the rest was accepted and silently ignored, so an unfiltered answer came back looking
  filtered. The parameters are now generated from `shared/facets.ts`, the one place the
  facets are declared, so the tool description and the server cannot disagree. Range
  syntax (`10..20`, `64..`, `..128`) and `include_unknown` are documented per parameter,
  because several facet columns are only partly populated and low recall there is a
  property of the data rather than a bug (ADR 0032). A call is capped at twenty filters
  (#1442).

  The underlying trap is narrowed, not closed: the schema still accepts an argument it
  does not declare and drops it. What changed is that the declared set is now exhaustive
  and generated, so there is far less reason to invent one, and the tool description
  says plainly that an undeclared name is ignored.

- **The top hundred ids of every allocating prefix are reserved for standing test
  fixtures (ADR 0068).** `RESERVED_FIXTURE_FLOOR = 99900`, so `nm099900`-`nm099999` and
  `xx099900`-`xx099999` are never returned by the allocator. Real datasets still
  allocate upward from the start of the prefix; fixtures are assigned downward from the
  top, by name. Reserved means **not allocatable, not invalid**: `isValidDatasetId` still
  accepts a reserved id and every route still serves one.

- **A non-production fixture can be created at its reserved id** (#1437, #1445), behind a
  gate with four separate conditions: not production, an admin caller, an id inside the
  reserved band, and a name on the declared dev-owned list. Each refusal carries its own
  machine-readable `error` code rather than one generic failure, so a caller can tell
  which condition it missed.

- **The read recipe has a browser lane** (#1469, ADR 0070). `read_window`'s `how_to`
  block gained `python_browser`, which names `eegprep-lean` and calls its asynchronous
  interface against the recipe's `array_path`. The lane that was labeled ready-to-run
  Python could not run in a browser, which is where compute runs by default (ADR 0049):
  the synchronous Zarr entry point starts an input/output thread, which Pyodide's main
  thread cannot, and the resulting error names threads rather than Zarr. All three lanes
  now say where they run.

### Changed

- **The standing anonymous fixture moved from `xx099907` to `nm099998`, and the way it is
  protected changed with it.** `xx099907` was an exemplar-band row guarded by a
  per-fixture code gate that made it structurally unpublishable: `isExemplarPublishAllowed`
  refused it server-side, so approving it by mistake was not possible. `nm099998` is a
  reserved `nm` id created through the ordinary anonymous-deposit path, which is the point,
  because the fixture now exercises the mechanism real depositors use rather than an
  exception carved around it.

  The consequence is worth stating plainly for whoever operates this: **there is no longer
  a per-fixture code gate.** An admin approving `nm099998`'s publication request as an
  ordinary, non-anonymous release will de-anonymize it and destroy the fixture
  permanently, exactly as that action would for a real depositor's anonymous dataset.
  Creating it is still heavily gated, by four separate conditions including
  not-production and admin; publishing it is guarded by the same care any anonymous
  deposit gets, and no more. `xx099907` itself is fully retired: no row, no repository,
  and the fleet loader now refuses an `anonymous` key outright.

- **The OSC surfaces can read Zarr chunks cross-origin** (#1466). `*.osc.earth` joins the
  NEMAR web properties on the Zarr host's allow-list. This does not change who can read
  the data, which is anonymous: cross-origin resource sharing is a browser instruction
  about which page may see a response, and a request without it still succeeds for any
  non-browser client. What it changes is whether in-browser code on those surfaces can
  use what it fetched.

### Fixed

- **The manifest canary probed a private repository anonymously** (#1452), so every blob
  it checked read as gone. It now authenticates with the installation token and reports
  a tri-state verdict: `present`, `absent`, or `unchecked`. `unchecked` is logged as
  itself rather than folded into the healthy line, because a run that could not check
  anything still writes a manifest and an operator reading `canary OK` would believe it
  was verified (ADR 0053). An authenticated `absent` seen on a first attempt survives a
  later `unchecked`, so a transient failure on retry cannot erase a real absence. The
  private repository it could not read is an anonymous deposit, which is a public row
  over a private repository by design (ADR 0065).

- **The anonymous exemplar could not take its anonymous release** (#1428), and the
  version identifiers minted during a blind stayed reserved with nothing to complete
  them afterward.

- **Upload's two environment questions are no longer one predicate** (#1445). Allocation
  asks whether this is literally production, and the named-id gate asks whether this is
  not a known non-production environment; they fail in deliberately opposite directions,
  so an unset environment variable cannot cause a real `nm` id to be allocated where a
  sandbox `xx` id was meant.

- **A sweep's SQL and its bind parameters are exported together** (#1445), rather than
  the query being hand-retyped in a test where a transposed parameter could stay green.

### Migrations

None. `0086_publication_request_anonymous.sql` appears in the diff, but only its comment
changed: it had named `version_doi` among the steps an anonymous release skips, which
#1447 stopped being true. No schema statement was touched, and the migration has already
run.

### Deploy coupling

**The Open Science Assistant's NEMAR prompt must ship with this release**
(OpenScience-Collective/osa#425). That prompt told the model `search_datasets`'s filters
are *exactly* the six it listed, that there is no participant-count filter, and to pass
only those six names. All three statements become false the moment this release reaches
production, and the third is the one that does damage: it instructs the model not to use
filters that now work, so a question about channel counts or participant numbers takes a
worse route or is declined, and nothing looks broken.

## 0.10.4 - 2026-09-16

### Added

- **A dataset can be deposited for double-blind review: readable, and not attributed until
  you say so (epic #1406).** `nemar dataset publish request <id> --anonymous` releases the
  data exactly as any public dataset is released -- listed, browsable, downloadable, at the
  ordinary dataset URL a reviewer can be pointed at -- while nothing NEMAR publishes names
  the depositor. The repository stays private, `datasets.authors` carries a blinded label
  rather than real names, `.nemar/metadata.json` is committed with authors, contributors,
  funding, geo-locations and related identifiers stripped, the DOI stays `reserved` with no
  DataCurator and is never harvested, and the catalog projects no owner. When the paper is
  accepted, restore the real `Authors` in `dataset_description.json` and request publication
  again WITHOUT the flag; that is what ends anonymity and publishes the record for real.
  Blind your own files first: NEMAR cannot scrub what the depositor wrote, and the sweep
  below reports what is left rather than editing it.

  Two limits are deliberate and worth knowing before you plan around them. Anonymity is
  available only BEFORE a dataset has ever been published, and the database enforces it:
  migration 0085 adds `first_published_at` and `anonymous` to `datasets` with triggers that
  refuse any row which is both, so the guarantee survives a route that forgets to check.
  Retracting an attribution that is already public is theater -- DataCite is harvested, the
  landing page is indexed, the git history is in every clone -- so publication is a one-way
  door rather than a toggle. And anonymity is toward the public, never toward the archive:
  admin and service reads resolve identity on purpose. See ADR 0065.

  Identity is withheld by the WRITER, not filtered by the reader, which is why the blind
  holds at surfaces a read-time filter would have missed: `datasets.authors` reaches the
  full-text index through a trigger, so a projection filter would have hidden names from the
  API while leaving them searchable. Two leaks that survived the first draft are closed at
  their own sites because neither is reachable from a `SELECT` list -- `GET /datasets/:id`
  served the raw `owner_user_id` beside the nulled username (a stable handle linking one
  depositor's several anonymous deposits), and `?owner=<username>` filtered on the real
  username, confirming authorship without ever projecting it.

- **`nemar admin anonymity-sweep` re-checks every anonymous deposit daily, and reports two
  different kinds of finding without letting one stand in for the other (#1409).**
  `severity: "invariant"` is a NEMAR bug -- repository public, real names in `authors`,
  `first_published_at` stamped, an EZID record that is not `reserved`, an owner projected, a
  Zarr index carrying attribution. `severity: "deposit"` is what the depositor left in their
  own files, addressed to them. The file checks are deterministic on purpose: they do not
  ask whether a string is a person's name, they ask whether a file contains THE DEPOSITOR --
  the real name, username, GitHub handle, email and ORCID iD already in the `users` row
  NEMAR is concealing -- plus any ORCID iD and any email address. No classifier, no
  false-positive budget, and a finding a depositor can reproduce without arguing with it.
  It reports and never repairs, because a disclosure cannot be undone by flipping a flag and
  an automatic fix would destroy the evidence that the guarantee had failed; it writes only
  `sweep_stamps`, and it files no GitHub issue precisely because `nemarDatasets` is
  public-facing. A check that could not run is `unchecked`, never clean. See ADR 0067.

- **The data plane serves a dataset's git-tracked files itself, instead of redirecting to
  GitHub (#1403).** `data.nemar.org/<id>/<version>/<path>` used to 302 metadata files to
  `raw.githubusercontent.com`; it now returns the bytes. That is what makes an anonymous
  deposit readable at all -- its repository is private, so every raw URL 404s for a reviewer
  -- and it removes a third-party host from the critical path for every other dataset too.
  The capability rules are the interesting part: the manifest is the capability list, the
  repository comes from the dataset row and never from the request, the visibility gate runs
  BEFORE the installation token is spent, the cache is keyed by request URL and never by
  blob SHA (two datasets sharing an identical file share its SHA, so a SHA-keyed hit would
  serve a private dataset's bytes to whoever asked second), and a refusal is 404 rather than
  403 because "exists but forbidden" is itself the disclosure. Responses are `max-age=300`
  and deliberately not `immutable`: the bytes are immutable, the authorization is not, and
  nothing purges the edge. A 32 MB per-file ceiling guards against an annex-policy slip; the
  largest git-tracked file measured across the catalog is 283 KB. See ADR 0066.

- **`nemar dataset download` no longer needs git-annex.** A missing git-annex used to be a hard
  exit, which is a poor answer to "I just want the files" when the data plane already serves
  every byte over plain HTTPS. The command now falls back to an HTTP download, announced rather
  than silent, and `--http` asks for it outright. One request to
  `<api>/data/<id>/<version>/manifest.json` returns every file's path, size, checksum and byte
  URL; a bounded worker pool (`-j`, default 4) fetches the selection. A file already on disk at
  its declared size is skipped, so an interrupted transfer resumes by re-running the command,
  and widening `--subjects`/`--tasks`/`--datatypes` later only fetches what is new. The BIDS
  filters mean exactly what they mean on the git-annex path, because both are derived from one
  declaration in `src/lib/bids-filter.ts` rather than two matchers that could disagree; dataset
  metadata is never filtered out, so what lands is still a readable BIDS root. What you get is a
  file snapshot, not a repository: there is no `.git`, so `nemar dataset commit`/`push`/`update`
  do not operate on it, and the command says so. `--update` and `--prune` are refused on this
  path rather than silently doing nothing. Useful well beyond the missing-git-annex case:
  containers, HPC login nodes and CI runners where installing git-annex is impractical.
  Every write is checked against the manifest's declared size, so a truncated body or an
  intercepting proxy's login page is an error rather than a file that looks fine; throttled and
  transient responses are retried with backoff, since most manifest entries fetch from a host
  that rate-limits by address; a transport, authentication or disk fault exits non-zero even
  without `--require-complete`, while content genuinely absent upstream stays a reported state
  (ADR 0005); and the target directory is refused if it is a git repository, holds a different
  dataset, or holds a different version of the same one -- the last because
  `dataset_description.json` is the same length across a patch bump, so resuming across versions
  would skip it and leave a tree that misreports its own version.

- **`nemar admin fleet content-recovery` copies back annexed content the bucket never
  received, and proves every copy (#1396).** Sixteen datasets finalized an import with
  12,039 keys, about 620 GB, for which `s3://nemar` holds no object, so the registration
  sweep could only report them: there was nothing to register. Recovery copies the bytes
  server-side from OpenNeuro's bucket, which means hundreds of gigabytes never pass through
  the operator's machine. A copy is only allowed from a source git-annex itself pinned (the
  S3 version id in `<key>.log.rmet`) or from exactly one distinct upstream object carrying
  the key's size, deduplicated by ETag; a path alone is never a source, because upstream
  rewrites paths and these imports are months old. S3 is asked to compute the SHA-256 of
  what it wrote and it is compared to the key's own hash before anything is registered, and
  an object that does not match is deleted rather than left in the bucket looking like
  content. Recovery writes no location log: `nemar admin fleet key-registration` does that
  afterwards, so one piece of code writes presence claims and it is the one that reads the
  log back. See ADR 0063.

- **`nemar admin docs <path...>` reads documentation pages, including the gated ones, without
  a browser.** `nemarOrg/docs` is private at source and `docs.nemar.org` is the retrieval
  surface, so a checkout is no longer how anyone opens an operations runbook. The command
  trades the stored API key at `POST /auth/docs/cli-session` for a fifteen-minute, read-only,
  documentation-scoped session and sends only that onward, so the long-lived key never reaches
  the documentation host or its logs. Pages come back as Markdown on stdout and diagnostics on
  stderr, so `nemar admin docs cli/commands > page.md` yields the page. Pass several paths at
  once: they share one session, which matters because the mint sits in the strict per-address
  rate-limit bucket. There is deliberately no flag that prints the session value, since a
  credential on stdout is one in a shell history.

- **`nemar admin fleet key-registration`** repairs the datasets the bug above already
  published. A fleet sweep of all 802 dataset repositories found 528 of 600 imported
  datasets with zero keys recorded at `nemar-s3`: 720,896 keys sitting in the bucket that
  no clone is told about. Those datasets are not broken for a user -- an imported
  repository carries OpenNeuro's `s3-PUBLIC` remote with `autoenable=true`, so
  `git annex get` still works -- but every clone fetches from upstream, and NEMAR's
  independence from OpenNeuro is not real while its own copy goes unadvertised.
  Presence is established by ONE `list-objects-v2` per dataset with credentials the API
  mints for it, never a HEAD per key: `s3://nemar` denies anonymous ListBucket, so a
  missing key answers 403, and 403 is equally what a private dataset, an expired session
  or a signature with no session token returns. A dataset with any key the bucket cannot
  account for is reported and skipped by default, because that is content which was never
  transferred (#1396) rather than a registration that was lost, and writing the remaining
  registrations would make it look repaired. Both rules are ADR 0061.

- **`nemar download <id>` and `nemar upload <path>` work from the root**, alongside the
  existing `login`/`logout`/`whoami` shortcuts. They are the same commands as
  `nemar dataset download`/`nemar dataset upload`, built from one factory, so every flag and
  every default is shared and the canonical two-word spellings are unchanged.

### Changed

- **`nemar admin --help` and `nemar dataset --help` lead with the commands people actually
  type.** `admin` had grown to 43 subcommands and `dataset` to 21, most of them one-off
  backfills, sweeps run from cron, or git-level escape hatches, and a flat alphabetical list
  gave `nemar admin approve` exactly as much prominence as `nemar admin recording-stats-sweep`.
  Plain `--help` now describes nine admin commands and six dataset commands and folds the rest
  onto a single comma-separated line; `--help-all` still lists everything with descriptions.
  Nothing is hidden in any other sense: a folded command still runs, still completes on TAB,
  and still has its own `--help`. The two lists are declared in `src/lib/help-groups.ts`, and a
  command absent from that file is folded rather than dropped.

### Fixed

- **A brokered git-tracked file now carries a `Content-Length`, and its length is checked
  against the manifest for real (#1419).** The broker asks GitHub's raw host for
  `Accept-Encoding: identity` so that upstream's declared length means what the manifest
  means. The Workers runtime owns that header: it never reaches GitHub, raw gzips anyway,
  and workerd strips `Content-Length` when it decodes. So the deployed data plane served
  every git-tracked file with no length at all, and the documented check that a moved tag
  cannot serve the wrong bytes had never once run in production -- the guard was inert while
  looking present, which is the failure mode worth naming.

  A first attempt set the header by hand and still did not work, which is worth recording
  because it is the same lesson twice: workerd sends a streamed body chunked and drops the
  header, so a length that reaches a client has to belong to a body whose length the runtime
  already knows. A brokered file at or below 8 MB is therefore read, checked and answered as
  bytes, which also makes a mismatch a clean 502 before anything is sent rather than a
  transfer aborted mid-flight. The read is bounded by the manifest's size and cancels
  upstream the moment it is exceeded, because both size gates test the number the MANIFEST
  claims and nothing bounds what GitHub actually sends: draining first would let a retagged
  recording fill a 128 MB isolate. Above the ceiling it degrades to a stream with a counter
  that errors on a short or overrun body: no declared length there, but still no
  wrong-length file that finishes looking healthy. For scale, the per-file ceiling is 32 MB
  and the largest git-tracked file measured across the catalog is 283 KB, so the buffered
  branch is what every real dataset takes.

  One bound worth knowing before relying on it: `Content-Length` describes the ENCODED body,
  and Cloudflare compresses this response for any client that accepts compression. Measured
  on one worker within one second: a default `fetch` negotiated zstd and got no
  `Content-Length` at all, while `Accept-Encoding: identity` got 1414, the manifest's number.
  What changed is that the origin now emits an accurate length instead of none, and an
  honest absence instead of a wrong number when the edge re-encodes. The manifest stays the
  authority on a file's decoded size for every client, which is what `nemar dataset download`
  has always checked against.

- **A brokered file is now checked for being the right bytes, not just the right number of
  them (#1419).** The broker fetches by git REF, not by blob SHA, so a moved tag serves
  whatever is at that path now. A same-size edit -- a BIDS version string bumped, one
  participant ID swapped for another -- passed every length check and was served as a 200
  whose `ETag` named the OLD blob, cacheable for five minutes. Having the complete bytes in
  hand makes the real check affordable: the buffered branch hashes them as a git blob and
  compares to the object name the manifest already records, so `ETag` now means what it
  says. ADR 0066 carries both corrections.

- **The withdrawn-datasets list now records a measured reason per dataset, and six entries
  were wrong (#1396).** It carried one filed reason each, 9 `upstream_403` and 2
  `no_source`, none of it measured per dataset. Trying every key against both routes
  OpenNeuro publishes found that six of the eleven were fetchable by the advertised route
  the whole time they sat private with tombstoned DOIs: `on004148`, `on007816`, `on007987`,
  `on008065`, `on005516` and `on005279`, now `reason: recovered`. Five were reinstated;
  `on007816` had never been published, so it needs a publish rather than a restore. The five
  still-withdrawn entries carry `data_keys_missing` / `data_keys_total` / `data_available` so
  the claim is checkable, and the reinstated ones carry `data_available` alone. A
  `withdrawn: false` flag keeps `withdraw --all` from taking a reinstated one down again, and
  the explicit-id path refuses one too without `--force`. The parser rejects the
  contradictions the shape allowed: `recovered` while still withdrawn, key counts given
  singly, missing above total, and a `data_available` that disagrees with them. A test
  asserts the two halves agree: everything still down is under the 90% threshold, and
  everything reinstated is at or above it.

- **NEMAR lists a dataset only when at least 90% of its DISTINCT ANNEXED DATA KEYS are
  available (ADR 0064, partially superseding ADR 0005).** `dataAvailability` and
  `MIN_DATA_AVAILABILITY` put the rule in one place, next to the presence predicate its
  numerator is defined in terms of, and the import publish gate calls it rather than
  recomputing the ratio. Enforcement of the withdrawal itself is still the operator running
  `nemar admin withdraw`; what ships here is the measurement, the gate, and the list. The denominator is data, never `total_files`: metadata is never annexed
  (ADR 0015), so it arrives from GitHub whether or not one recording survived and pulls every
  ratio toward 100%. `on008017` is missing 4.7% of its tracked files and 21.6% of its data,
  and `on004917` 11.8% against 25.4%, so a threshold on tracked files clears both. A
  metadata-only dataset measures 1 rather than dividing by zero. The threshold is applied only
  after recovery has reported what it cannot get: on 2026-09-15 three datasets that were
  not already withdrawn were under the threshold that morning and whole by the afternoon,
  and six more came off the withdrawn list the same day. A verdict read from a stale
  column would have tombstoned content that exists.

- **A publish-gate shortfall now files a labeled tracking issue (#1396).** The gate
  refuses when the bucket cannot back the keys a dataset's tree names, but its message
  matched no rule in the failure classifier, so the issue on `nemarDatasets/.github` was
  filed with no label and no severity. The gate emits `[nemar-data-unavailable]` with the
  availability figure and the classifier maps it to `data-unavailable`. It deliberately
  does NOT reuse the upstream marker: at that point nothing has established the content
  is gone at source, and recording that unmeasured is what put nine datasets on the
  withdrawn list wrongly. Both copies of the literal are pinned against each other by a
  test, like the upstream marker.

- **`nemar admin fleet key-registration --retract-false-claims` withdraws a claim the
  bucket cannot back (#1396, #967).** The sweep could already see this state -- a key
  recorded at NEMAR's remote with no object behind it, which is what a failed copy leaves --
  but only ever reported the missing content and skipped the dataset, so the false claim
  outlived every run and clones kept being told to fetch bytes we do not hold. The scan now
  names it (`falselyClaimed`), the skip note says how many of the missing keys are advertised
  anyway, and the flag retracts them and pushes. Off by default and deliberately: while the
  content is still recoverable the honest repair is to fetch it, which makes the claim true.
  Used on the 230 keys across `on003574`, `on004475`, `on004917`, `on005571` and
  `on005279` whose anatomical images OpenNeuro removed, verified afterwards by re-reading
  each dataset's location log from a fresh clone of origin. It edits the log and leaves the
  zero-byte objects, which are inert once nothing claims them but still read as damage to a
  size audit.

- **A presence claim NEMAR cannot honor can now be withdrawn (#1396).** `batchSetKeysAbsent`
  is the counterpart to the registration path: a failed copy leaves a zero-byte object
  under the right key name, every check that asks only whether the key exists counts it as
  content (#967), and the registration then tells every clone to fetch bytes we do not
  hold. Where recovery proves the content unrecoverable upstream the claim cannot be made
  true, so the repair is to retract it. The read-back is inverted rather than reused:
  success is the key no longer being recorded at the remote, and the assert-side check
  would have reported every retraction as a failure.

- **Content recovery refuses a wrong-sized source, and can recover a zero-length key
  (#1396).** Finishing `on004624` and `on006136` turned up `.log.rmet` pins that are simply
  wrong about content: a key declaring 0 bytes pinned to 2,075 bytes of the dataset README
  across four separate pins, and a key declaring 6,488,064 bytes pinned to an object one
  32 KiB block longer. ADR 0063's SHA-256 comparison caught both and both copies were
  deleted, so nothing wrong reached the bucket -- but the probe had issued its HEAD and read
  only the exit code, so a readable wrong-sized object counted as recoverable content and
  every apply spent a whole copy to be told no. The source's length is now compared to the
  key's declared size before the copy, on the dry-run path as well as the apply path. In
  both datasets the only tree path referencing the key is an OpenNeuro upload temp file
  committed into the dataset, so this is upstream debris rather than scientific data.

- **A multipart copy runs its parts concurrently (#1396).** Parts are independent
  server-side copies but were issued one at a time, so one oversized key copied at about
  6 MiB/s, hours for a single key, while eight ordinary keys in flight sustain 30 MiB/s. Eight parts now
  run at once and the completed list is still assembled in part order. The byte-range
  arithmetic moved into an exported `multipartRanges`, because that is where this can
  corrupt silently: S3 stitches whatever ranges it is handed, so a gap or an overlap yields
  an object of plausible length holding the wrong bytes, and the multipart path has no
  SHA-256 to catch it.

- **A multipart copy is now proven against its source, not just measured (#1396).** Above
  CopyObject's 5 GB limit the copy carries no SHA-256 to compare with the key, because S3
  refuses `--checksum-type FULL_OBJECT` for sha256, so such a copy passed on its size and
  its pin alone. It offers that whole-object checksum for CRC64 instead, and the copy now
  ASKS for one (`--checksum-algorithm CRC64NVME --checksum-type FULL_OBJECT`) rather than
  hoping S3 attaches it; OpenNeuro's large objects already carry one, so the two can be
  compared directly: an
  equal full-object CRC64 means the copy is the pinned version's bytes rather than any
  object of the right length. Recorded as `crc64-of-source`. It stays a fidelity check
  rather than an identity one, so an unpinned oversized source is still refused. Costs one
  extra HEAD, and only where there was nothing stronger to check.

- **`nemar admin import verify` no longer reports "0/0 object(s) missing" (#1396).** The
  backend answers `complete: false` with an empty expected set when there is no published
  manifest to compare against, which is the right refusal, but the CLI rendered it as an
  incompleteness with a count of zero over a total of zero. `on008003` reported that with
  759 objects sitting in its prefix. It now says the dataset is not verifiable and why, so
  an absent expectation stops reading as a verdict on the data (ADR 0054). Same fix in
  `admin import recover`'s per-target line.

- **Content recovery reads the pins of any path containing a space (#1396).** git-annex
  base64-encodes a metadata value it cannot write literally and marks it with `!`, which is
  what happens to every `.log.rmet` value whose object path holds a space. The parser
  required a literal `#` in the raw token, found none inside the base64, and reported those
  keys as having no recorded source at all: 1,808 pins in `on004148` and 1,378 in `on008003`
  were invisible. It mattered most above CopyObject's 5 GB limit, where an unpinned source
  is refused because a multipart copy cannot carry a SHA-256 -- `on008003`'s two 5.8 GB
  objects read as unrecoverable while both were sitting upstream, readable, at the version
  their own pin named.

- **Content recovery no longer treats a retracted S3 version as a place to copy from (#1396).**
  A `<key>.log.rmet` line marks its value `+` for set and `-` for unset, and the parser read
  the marker as escaping, so a retracted version reached the AWS CLI with a literal leading
  minus. Every one of `ds006110`'s five retractions came back as a bare `InvalidRequest`,
  which read as an upstream defect rather than our own misparse; honoring the retraction
  turns those five into two recoveries and three honest verdicts. The log is now replayed in
  timestamp order, so a retraction written out of position still wins over the entry it
  cancels.

- **An import can no longer finalize with content it never transferred (#1396).** The publish
  gate verified the import MANIFEST against the bucket, and a manifest is what the copy phase
  believed it transferred, so a partial manifest verified cleanly while the tree still
  referenced keys nothing had moved. Sixteen datasets published that way, and the location log
  then told every clone NEMAR had those keys. Finalize now asks the question of the tree: every
  annexed key must have an object at its declared size, or it refuses to register and says how
  many are outstanding.

- **Registering annexed keys no longer reports writes it never made** (#1392).
  `batchSetKeysPresent` ran fifty `git annex setpresentkey` processes at once and counted
  every exit-0 as a registration. They all exit 0; their writes to the shared git-annex
  branch journal do not all survive. An `onboard-openneuro` finalize logged "Registered
  117 files in git-annex", the pushed location log recorded none of them, and the dataset
  was published with a permanent concept DOI. It is now one `setpresentkey --batch`
  process per chunk of 5,000, and the result is read back out of the location log rather
  than inferred from exit codes -- the callers already aborted on a non-zero failure
  count, so they now abort on the truth, and name the keys that are missing.

- **Colored `--help` no longer wraps descriptions about twenty columns early.** Commander
  measures wrap width with `String.length`, which counts the ANSI escapes around a colored
  command name as if they took up columns, so `nemar dataset --help` in a terminal broke every
  description onto two or three lines while the same output piped through `cat` was fine. The
  wrap now runs on the visible text and the color is applied afterwards.

- **Rate limits now apply to the `/nemar` spelling of every route.** The API is mounted twice,
  at `/` and at `/nemar`, and the limiter matched paths against the full request path, so the
  strict per-address floor on the authentication routes (`/auth/login`, `/auth/code/request`,
  `/auth/keys`, the device-flow routes) matched nothing when the prefix was used and those
  requests fell to the general bucket. Both spellings are bucketed alike now. Low impact in
  practice, since Cloudflare's own per-address ceilings and the per-email limit on code
  requests both still applied, and this API is read-only for anyone without a key; recorded
  because it is a real change in how those routes are throttled.

- **An OpenNeuro import no longer leaves motion recordings in the git repository, and
  NEMAR's annex policy now actually governs an imported dataset.** Two separate holes,
  both closed in the import's prepare phase (#1159, ADR 0060). First, a `_motion.tsv`
  under OpenNeuro's ~1 MB bar arrived as a plain git blob and stayed one -- 893 of them,
  675 MB, in `ds007788` alone; those files are now annexed and their content uploaded
  from the clone, and an import that cannot upload them fails instead of publishing a
  pointer with nothing behind it. Second, and previously unnoticed: upstream ships a
  `.gitattributes` whose `annex.largefiles` setting **outranks** the one
  `configureLargefiles` writes, so ADR 0031's policy had no effect on any imported
  repository -- the next motion file added to one would have repeated the original bug.
  The inherited attribute is now replaced by NEMAR's own expression, which the import
  writes and then reads back before continuing: stripping alone would have been worse
  than leaving it, because with `annex.largefiles` set nowhere git-annex annexes
  everything, including the metadata a clone has to be able to read. This is a forward
  fix, so an imported repository does not shrink -- upstream's blobs stay in the
  history it came with. The 600 imported datasets that still carry upstream's
  attributes are tracked in #1374, and `on007788`'s own data migration in #1159.
- **`nemar admin annex-normalize <id>` applies the same fix to a dataset that already
  exists**, which is how `on007788`'s 893 git-resident recordings and the imported
  fleet get migrated. It is a forward fix by construction: a published version
  manifest addresses a git-resident file by its tag-pinned `raw.githubusercontent.com`
  URL, so history is never rewritten and those URLs keep resolving. `--dry-run`
  reports the plan; a clone left dirty by an interrupted attempt is refused rather
  than mistaken for a dataset with nothing left to migrate.
- **A dataset content write now names the branch it means, and a repository pointed at
  the wrong branch is repaired instead of renamed** (#1386). `createOrUpdateFile` left
  `branch` optional and omitted it from the request, so the GitHub Contents API wrote
  to whatever GitHub calls the repository's default branch, while `getFileContent`
  read `main`. Sixteen imported repositories have `default_branch = git-annex` --
  `createRepository` uses `auto_init: false`, so GitHub adopted whichever branch their
  first push happened to carry -- and on fourteen of them the publication
  orchestrator's two DOI writes therefore read `main` and wrote `git-annex`: those
  datasets still advertise OpenNeuro's DOI on `main` while NEMAR's concept DOI and its
  README badge sit on a branch nothing reads. Writes now default to `main` like reads,
  and the two publication sites name it explicitly. `ensureMainBranch` also stops
  renaming in the one case where renaming is wrong: when `main` already exists the
  repository is merely pointed elsewhere, so the default moves to it; renaming stays
  for the case it was written for, a dataset branch actually called `master`.
  The fourteen datasets were then repaired with
  `scripts/repair-doi-metadata.ts`, which applies the same rule against main's
  current content rather than copying June's stranded blobs: `DatasetDOI` became the
  concept DOI, the OpenNeuro DOI moved to `SourceDatasets`, and the badge went to the
  top of `README.md`. Two of the sixteen are absent from the catalog and were skipped
  rather than guessed at. Each repair was confirmed by reading `main` back, and all
  fourteen BIDS validations passed afterwards. The script requires **two** witnesses
  to agree before it writes: NEMAR's catalog and the value publish actually wrote,
  which for these repositories is the copy stranded on `git-annex`. A dataset where
  they disagree is reported and skipped, because a re-minted or rolled-back DOI would
  otherwise be written confidently onto published metadata and the post-write check,
  comparing `main` against the same catalog value, would agree with itself. For the
  same reason `--apply` refuses `--scan`: discovery is a sweep, and writing to
  published metadata is done one named dataset at a time.
  `ensureMainBranch` now reports which of the two things it did -- `repointed` when it
  moved the default to an existing `main`, `renamed` only when it renamed -- because
  both spellings reach an operator-facing audit trail, and one that says a branch was
  renamed when none was is the same class of misdirection that made this bug hard to
  find.
- **A dataset migration no longer hands git-annex a temporary key without its session
  token** (#1380). `normalize-dataset.ts` enabled the S3 remote with credentials minted
  for the dataset and then let the transfer inherit the environment, where there were
  none: git-annex fell back to the key and secret `enableremote` had cached, signed
  without the session token that makes them valid, and S3 refused every request with a
  bare 403 -- which was mistaken for the API's S3 identity not reaching imported
  (`on######`) prefixes. It does reach them: the identity covers the bucket and the
  per-request session policy is what narrows it, verified by HEAD on the same object
  with the same credentials returning 200 with the token and 403 without. The
  credentials are now threaded to the transfer; the branch that obtains them is the
  branch that states how the bytes move, so there is no default left to forget; a
  temporary key with no session token is refused before any transfer is attempted; and
  the migration probes the prefix before annexing anything, so a refusal costs one HEAD
  rather than an hour. `nemar admin s3 credential-check <id>` reports the same probe on
  demand. A dataset with no data to move now needs no credentials at all, and a policy
  that changed only the git-annex branch is pushed rather than left local.
- **A migration is no longer declared done on a check that cannot fail meaningfully**
  (#1380, #1392). The step that confirmed the uploaded content was
  `git annex fsck --from nemar-s3`, which is the one question git-annex cannot answer
  here: `enableremote` caches the key and secret with nowhere to put the session token,
  so fsck signs without one and S3 returns 403 -- the same 403 it returns for an object
  that is not there. A red result therefore did not mean the content was missing, and a
  green one would not have meant it was present. `on006979`'s migration is what surfaced
  it: the PDF was in the bucket and the location log recorded it, and the run still
  reported `fsck: 1 failed`. The check is now a HEAD carrying the credentials that moved
  the bytes, `absent` and `unconfirmed` are kept apart rather than collapsed, and it runs
  **before** the push instead of after -- a tree naming keys whose content never arrived
  is what stranded `on003490` and `on005121` behind a permanent DOI, and the clone is
  still re-runnable right up until it is pushed. For a remote whose credentials git-annex
  does hold in full, the verifier reads the location log after fsck has pruned it, since
  fsck only checks claims that were already made and an upload that moved nothing makes
  none.
- **The per-user IAM provisioning that STS replaced is gone from the backend** rather
  than sitting there with no callers (#1380). `generateS3PolicyDocument`,
  `generateAdminS3PolicyDocument`, `createIamUser`, `createAccessKey`, `putUserPolicy`
  and `generateIamUsername` had no call site outside their own module; the two
  generators are why #1380 was first read as an identity-policy gap, since they look
  like the code that would write one and nothing runs them. Revocation stays: an
  account provisioned under the old scheme still carries an `aws_iam_username` in D1
  and an IAM user in the account, and deleting it has to take both away.
- **`nemar admin fleet annex-policy` reports, and fixes, the datasets NEMAR's annex
  policy does not actually govern** (#1374). The sweep reads two things per repository
  straight from GitHub, without cloning it: every tracked `.gitattributes`, and the
  `annex.largefiles` the git-annex branch configures. Measured across the fleet on
  2026-09-13: of 600 imported (`on######`) datasets, 599 configure **no** expression at
  all and carry upstream's attributes instead (693 files, 6,094 rules), and one --
  `on007788`, migrated in #1159 -- is compliant. The 198 uploaded (`nm######`) datasets
  all configure one, but 195 configure a version written before `*_motion.tsv` joined
  the policy, and 29 of those predate the metadata exclusions entirely. So a motion
  recording added to almost any dataset in the fleet today would still land in git,
  which is #1158 with a wider blast radius than #1159 closed. The fix per repository is
  the import's own: strip the inherited attributes, write NEMAR's expression, one
  commit, no data moved and no S3 traffic. Three datasets (`on006979`, `nm000180`,
  `nm000228`) also keep data in git and are reported and skipped rather than
  half-fixed: those need the upload leg, which is `nemar admin annex-normalize <id>`.
  Read-only by default, `--apply` in batches (ADR 0020: a push per repository starts
  that repository's BIDS validation), and every applied dataset is verified by reading
  GitHub back.

### Migrations

`0085_anonymous_deposit` adds `datasets.first_published_at` and `datasets.anonymous`, two
`BEFORE INSERT` / `BEFORE UPDATE` triggers that abort any row which is simultaneously
anonymous and published, a partial index on `anonymous = 1`, and one backfill that stamps
`first_published_at` for every dataset with evidence of publication (a version row, a
concept DOI, a `publish_date`, or `visibility = 'public'`), earliest evidence first.
`0086_publication_request_anonymous` adds `publication_requests.anonymous` and re-opens the
requests an earlier build had parked with `block_reason = 'anonymous_deposit'`. Both
additive. `0083_docs_sessions` carries a comment-only correction (the docs gate is not
ORCID-backed); the file is already applied everywhere and `wrangler d1 migrations apply`
tracks by name, so nothing replays.

### Deploy coupling

**`nemarOrg/website#334` depends on this release and must ship after it.** The website's
README panel now fetches `data.nemar.org/<id>/<version>/README.md` instead of
`raw.githubusercontent.com`, and it drops `raw.githubusercontent.com` from `connect-src` in
the same change. Before this release the data plane answers that URL with a 302 to the raw
host, and a CSP applies to a redirect target, so shipping the website first would break the
README panel on every dataset page in production.

## 0.10.3 - 2026-09-10

### Security

- **The admin documentation was publicly readable, and is now gated.** Every page under
  `docs.nemar.org/admin/*` answered 200 to an anonymous request, and all twelve were listed
  in the public sitemap. The Cloudflare Access application believed to be protecting them
  covers that Pages project's preview deployments only and never covered the production
  hostname. Those pages now sit behind NEMAR's own ORCID-backed session with an admin-role
  check, handed to the documentation host through a sixty-second one-time code, so
  `users.role` in D1 stays the single source of truth for who is an admin (ADR 0056,
  #1345, #1355). Nothing confidential was exposed: procedures and identifiers in a public
  repository, never credential values.

### Fixed

- **Web sessions authenticated past their expiry, by up to a day.**
  `web_sessions.expires_at` was written as a JavaScript ISO string while every reader
  compares it against SQLite's `datetime('now')`. SQLite compares them as text, and byte 11
  decides it, so an expiry bearing the same calendar date as the comparison always won.
  Writes are SQL-side now, and migration 0084 rewrites the rows already stored. **If you
  were signed in to nemar.org you may be signed out when this deploys**; sign in again.
- **Revoking or demoting an account did not reach its browser credentials.** The session row
  survived, inert while the account was revoked, and a later re-approval handed it back to
  whichever browser still held the cookie. A revoke now clears every session and grant; a
  demotion clears the documentation credential and deliberately leaves the ordinary
  dashboard session alone, since a demoted account is still a legitimate user.
- **A documentation session could authenticate the management API.** Both credential scopes
  live in one table, and one of the two readers of it lacked the scope predicate. Caught in
  review, never deployed.
- **The import workflow's failure reporters posted nothing at all when the log held no
  failure marker.** Actions runs a `run:` step under `bash -e`, and the reporters add
  `pipefail`, so a `grep` that found nothing killed the step before its named fallback: an
  out-of-memory kill, an evicted runner or a cancellation reported the stage roll-up that
  this work replaced. Fixed in both copies of the workflow (#1366,
  `nemarDatasets/.github#116`).
- **The reconcile reported "no import row" for datasets that had one.** Row existence was
  derived from the unresolved slice rather than from the table, so an issue whose import had
  since completed or rolled back was named as untracked, and the human remedy for that
  finding then suppresses the issue from the report permanently (#1363).

### Changed

- **Signing out of nemar.org also ends the account's documentation sessions**, on every
  device, and destroys any outstanding one-time grant, in a single transaction (#1361).
- **Every unrouted path on `api.nemar.org` now answers with the JSON 404 body**
  `{"error":"Not Found","message":"Route <METHOD> <path> not found"}` instead of plain text.
  Route-level 404s are unchanged. Hono's `route()` copies a sub-app's routes and not its
  notFound handler, so the JSON body had only ever been served by the `data.nemar.org` fork.
- The role-change audit record gains `docs_sessions_revoked`.

### Added

- **The import pipeline records the real failure instead of a stage roll-up**, and classifies
  it, so an expired token no longer reads the same as a diverged branch (#1351).
- **`nemar admin import-issue-triage` reconciles failures against their tracking issues** and
  reports disagreement in both directions. Report-only: it files nothing (ADR 0055, #1353).
- `nemar admin import-coverage` and `import-weekly` no longer suggest filing a bug when they
  exit non-zero. Those exit codes are the verdict, and they have not changed (#1358).

### Migrations

`0083_docs_sessions` (a metadata-only `ADD COLUMN` with a CHECK, a partial index, and the
`docs_grants` table) and `0084_web_session_expiry_format` (one idempotent in-place `UPDATE`
over `web_sessions`). Both additive.

### Deploy coupling

`nemarOrg/docs#32` and `nemarOrg/website#328` depend on this release and must ship after it.
Before it, the documentation middleware maps an unrouted `verify` to a 503 on every
`/admin/*` page, and the website's authorize page reads the unrouted 404 as "not an admin"
and sends a real admin to `/404`.

### Known limitation

This release fixes the JavaScript-timestamp-versus-SQL-datetime comparison for web sessions
only. The same pattern remains in `auth_codes` and `orcid_link_intents`, so an emailed
sign-in code's ten-minute window is currently longer in practice than advertised; the codes
are still single-use and attempt-capped. Tracked in #1359.

## 0.10.2 - 2026-09-10

**The import pipeline reports its own health** (epic #1337). Before this, a failed OpenNeuro
import was visible only to whoever went looking in D1.

### Added

- The real failure reason is captured and classified rather than recorded as the stage that
  was running (#1325).
- Recovered imports close their own tracking issues, issues whose cause has changed are
  relabeled, and a burst rolls up into one issue instead of flooding the tracker (#1328,
  ADR 0052).
- A coverage sweep, so the pipeline reports its own silence: nothing arriving is only good
  news if there was work to do (#1331, ADR 0053).
- A weekly summary issue that arrives whether or not anything is wrong (#1333, ADR 0054).

### Fixed

- **Tests could sign in to production.** The default test target was the production API, so a
  test run authenticated against real accounts. It is the dev worker now (#1343).
- `nemar auth login -k ""` no longer stores an empty key (#1343).
- The `iam-removal` suite skips instead of failing when it has no live target (#1348).
- Two false failures in the MCP verification script (#1335).

### Changed

- CORS accepts the website's Pages preview hostnames, so a preview deployment can call the
  API (#1347).

## 0.10.1 - 2026-09-09

**The NEMAR MCP server** (epic #1065): agents reach the catalog through a typed tool surface
at `mcp.nemar.org` rather than by scraping the API.

### Added

- Host fork and discovery tools: `search_datasets`, `describe_dataset` (#1323).
- Recording tools: `list_recordings`, `get_events`, `render_overview` (#1326).
- A `read_window` recipe with a capped taste of the data, so a client can sample a recording
  without downloading it (#1327).
- A Python client verification, so the contract is exercised by something that is not this
  repository (#1330, ADR 0050).

### Changed

- ADR 0049 supersedes 0025 on compute locality (#1292).

## 0.10.0 - 2026-09-08

**ORCID-first CLI sign-in and service accounts** (epic #1272). A terminal cannot receive an
OAuth redirect, so `nemar auth login` now uses the device authorization grant (RFC 8628),
the pattern `gh auth login` uses.

### Added

- The backend device authorization flow, with the key minted only when the CLI collects it,
  never when the browser confirms (#1287, ADR 0047).
- `nemar auth login` and `signup` on that flow, with `-k`/`--key` kept as the explicit
  paste-a-key fallback for a headless host (#1289).
- Named API keys, one row per machine, so a new sign-in never revokes another machine's key,
  and `nemar auth keys` to manage them (#1287).
- Account kinds: `person`, `service`, `test`, set only by an owner and never inferred
  (#1290, ADR 0048).

### Fixed

- Admin notifications are gated to production, so a non-production job cannot email real
  people (#1305).
- The dev worker's email allow-list holds exact addresses as a secret, with no domain
  wildcards (#1319).
- Three live-tier device-flow test failures (#1301), and stale premises in the passwordless
  live tests (#1317).

### Changed

- OpenNeuro auto-import re-enabled on production (#1308).

## 0.9.16 - 2026-09-07

**Account tiers, upload access, and identity parity** (epic #1250). `verified` becomes a real
tier that needs no administrator, and upload access becomes a thing you ask for once.

### Added

- `verified` is the base tier: browse, dashboard, settings and sandbox need no admin
  (#1262, ADR 0040).
- Upload access is requested once, by the person who wants it, and each missing field is
  named in a typed refusal (#1265, ADR 0042).
- CLI self-service for identity fields, and CLI/web parity for what an account is told about
  itself (#1269, #1270, ADR 0045).
- `nemar --debug` writes a diagnostic bundle (#1257).
- Real-name DOI attribution (#1260).

### Changed

- Approval grants upload access rather than acting as the gate on everything (#1258).
- Identity uniqueness: an ORCID iD, an email or a GitHub handle backs at most one live
  account (#1264, ADR 0043).
- An unverified ORCID blocks the upload-access request (#1273).
