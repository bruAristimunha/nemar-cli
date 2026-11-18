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

## Unreleased

### Staging

- **Staging semantic search has the vector visibility filter on too (ADR 0126).**
  `VECTORIZE_VISIBILITY_FILTER = "1"` is set in `[env.dev.vars]`, after the dev index got the `visibility` and `dataset_id` metadata indexes and its public vectors were relabeled; production is unchanged (on since 0.10.35).

## 0.10.35 - 2026-11-18

Release 0.10.35 is small: a CLI fix and the owner's switch for private-dataset semantic search.
It has no migrations and adds one Worker variable, `VECTORIZE_VISIBILITY_FILTER`, in production only.

### Production behavior changes

- **Semantic search narrows by visibility labels, and private datasets get embedded (#2211, ADR 0126, now accepted).**
  `VECTORIZE_VISIBILITY_FILTER = "1"` is set in production `[vars]`; staging stays off until its index is relabeled.
  The metadata indexes and the relabel of all 910 public vectors were done on 2026-11-18, before this release.
  Results stay limited to what the caller may see: every hit is still checked against the live `datasets` row.

### CLI

- **`nemar dataset invite`, `nemar dataset access approve` and `nemar dataset access deny` accept the username and the dataset id in either order (#2208).**
  Before, `nemar dataset invite nm000289 alice` sent `alice` as the dataset id and failed with a misleading "Dataset not found".
  The id is matched case-insensitively against the same bounded rule as the other admin commands; when neither argument is a dataset id, the CLI stops before calling the API and says what it expected.

### Owner steps after release

1. Run `POST /admin/vectorize/reindex-all` (keyset-paged with `after` and `last_id`) until `has_more` is false, to embed the private datasets; read `failed` in each answer and retry any failed id with `{"limit": 1, "after": "<the id before it>"}`.
   Until it runs, the daily drain embeds them 50 at a time.
   Then close #2200.

## 0.10.34 - 2026-11-18

Release 0.10.34 carries three blocks of work.
The first is a repair of the dataset publication lifecycle (#2199, ADR 0125): a published dataset can now be pulled back to unpublished, and the commands that could leave one half published are gone.
The second is search that returns every dataset the caller may see, private ones included (#2201, ADR 0126).
The third is portable compute: a tenant-wide ceiling on live compute jobs (#2126, phase P2 of issue #2121) and workstation runners, a derivative store and runner reporting (epic #2145, ADR 0121 to ADR 0124).
Two smaller fixes and a plan document ride along (#2139, #2163, #2197).
The release has six migrations, 0140 to 0145, and sets no Worker variable or secret; the one change to the Worker configuration is the derivative store's bucket binding (see Deploy coupling).
Compute stays dark in production: no job can be created while `COMPUTE_ENABLED` is absent, and no runner can claim work while `COMPUTE_RUNNERS_ENABLED` is absent.

### Production behavior changes

- **The administrator's publication and visibility commands moved under `nemar admin repo`, and two of them are gone (#2199, ADR 0125).**
  `nemar admin repo publish` (with `list`, `show`, `start`, `next`, `approve`, `deny` and `screen`, options unchanged), `nemar admin repo unpublish`, `nemar admin repo withdraw` and `nemar admin repo restore` are the lifecycle commands.
  The old top-level `nemar admin publish`, `nemar admin withdraw` and `nemar admin restore` are hidden stubs that do nothing and exit 1 with a pointer to the new name, so a script or runbook that calls one fails loudly until it is updated.
  `nemar admin repo public` and `nemar admin repo private` are removed, because a bare visibility flip is how a dataset ends up public or private while its publication record says the opposite.
  `nemar dataset publish` (the author's side) is unchanged.
- **`PATCH /admin/datasets/:id/visibility` answers 409 in both directions (#2199).**
  The route stays so that an old script gets a sentence naming `admin repo publish approve` or `admin repo unpublish`, not a bare 404.
  Nothing changes visibility through it any more.
- **Publication mail names the new command.**
  The administrator notification that a publication request is waiting now says `nemar admin repo publish ...`.
- **`GET /datasets/search` returns the datasets the caller can see (#2201, ADR 0126).**
  An anonymous caller gets public datasets only, as before.
  A signed-in caller also gets the private datasets they own or collaborate on, and an administrator or owner gets every dataset, the rule `GET /datasets/:id` already enforces.
  Status, sandbox, exemplar and anonymous-deposit concealment are unchanged, and every search response stays `no-store`.
  Private datasets are keyword-searchable for the people entitled to them as soon as this deploys; semantic search for them waits on the owner's rollout steps below.
  The MCP `search_datasets` tool stays public: it never returns a private dataset.
- **Three things run in production with no switch in the portable compute block.**
  The runner lease sweep (`sweepRunnerLeases`) runs on the 30-minute scheduled tick; a credential that starts with `nmr_` or `nmra_` is refused by `resolveApiKeyUser` as a runner credential and never read as an API key; and `runnerEndStatements` ends a person's runners in the account deletion, account revocation and role demotion paths.
  With no runner registered they have nothing to act on.
- **The derivative store's daily pass runs in production,** because the bucket is now bound (see Deploy coupling).
  It reads no switch, and it copies nothing until a pipeline job dispatched while `COMPUTE_ENABLED` is on has finished.
- **Links to files whose names contain a reserved character now resolve (#2139).**
  See Fixed.

### Added

- **`nemar admin repo unpublish` (#2199, ADR 0125, migration 0144).**
  It takes a published dataset back to an ordinary unpublished private dataset: private on GitHub and S3 and in D1, with the publication request that published it stamped with the new column `publication_requests.unpublished_at` (the request's status is not rewritten, so the record that the dataset was once published stays).
  It is a dry run by default; `--execute --reason <text>` applies it after a confirmation, and `--json` is available.
  The route is `POST /admin/datasets/:id/unpublish`, and the reason is written to the audit log as `dataset_unpublished`.
  It never calls EZID, so the concept and version DOIs stay as they were, and it leaves `first_published_at` (anonymity stays unavailable), collaborators, access requests, version records and the tag ruleset alone.
  The author's `nemar dataset publish status` reads a stamped request as none, and the dataset can be published again.
  It repairs the half state a bare flip leaves: a dataset already private whose request still says `published`.
  It refuses the live datasets nm000103 to nm000107, the reserved fixture band, exemplars, anonymous deposits, withdrawn datasets (use `restore`) and a dataset with an open publication request (deny it first).
  A public dataset that was never published is simply made private.
  `withdraw` is the other way back: it is for a broken or removed dataset, and it tombstones the DOIs.
  After an execute the command prints one line: search reflects the change at once, while the public dataset page and catalog list are cached at the edge and can keep showing the dataset for several minutes.
  `nemar dataset publish status` reports a dataset that is public again (for example after `make-public`) by its request's own status, not as unpublished.
- **Search follows the viewer, with two layers of protection (#2201, ADR 0126, migration 0145).**
  One shared predicate, `buildViewerVisibilitySql`, decides what a caller sees in every tier: exact identifier, full-text, literal match, vector-hit hydration, reranker text, counts and `excluded_unknown`.
  Layer 2, always on: every hit is checked against the live `datasets` row, so a stale label never decides visibility.
  Layer 1, behind `VECTORIZE_VISIBILITY_FILTER=1`: vectors carry two routing labels, `visibility` and `dataset_id`, and a vector query is narrowed by them (anonymous asks for public; a signed-in user adds the private datasets they own or collaborate on; administrators are unfiltered).
  A rejected filter, or a filtered query with no match, falls back to an unfiltered query with a warning.
  With the flag off, only public datasets are embedded, as before, and the labels are still written to public vectors.
  With it on, the daily drain and `POST /admin/vectorize/reindex-all` embed private datasets too.
  Migration 0145 adds a trigger that marks a dataset's embedding stale (`embedding_dirty = 2`) when its visibility or status changes, and the drain takes the highest value first, so a dataset just published or unpublished is relabeled ahead of any backlog.
- **The fixture id `nm099996` is declared dev-owned (#2163),** so production stops claiming pushes to a repository by that name before anyone creates it.
- **A ceiling on the live jobs of the whole tenant, checked in the statement that takes each job's hold, whoever submits it (#2126).**
  The owner's `tenant` policy key sets the ceiling and a floor of slots kept for people, for the pipelines and for partners; the schema refuses floors that add up to more than the ceiling, and a stored policy without the key falls back to the defaults, never to unlimited.
  A job that would take a slot owed to another class, or pass the ceiling, is refused with the new word `platform_busy` (409).
  It is not queued; a queue is a later phase.
  The defaults are a ceiling of 20 with floors of 8 for people, 2 for the pipelines and 0 for partners, which leaves NEMAR's own pipelines their current room of 12 only while nothing else occupies a slot (an orphaned job, a job that skipped the reservation, or people holding more than their floor take it from them).
  `platform_busy` stops a pipeline run and ends the daily dispatcher's run; `pipeline run` and its dry run are clamped to the tenant room.
  `nemar admin compute status` prints the occupied slots by class and the attention count `tenant_over_ceiling`, and the live tenant sweep logs `tenant_live` and `occupied` and warns when the live count passes the ceiling.
  The ceiling is checked on both database engines in tests (bun:sqlite and Miniflare D1), with racing requests for the last slots.
  It carries no migration and sets no variable or secret.
- **Workstation runners (epic #2145, ADR 0121 and ADR 0122, migration 0140).**
  An owner registers a runner (`nemar admin compute runners register|list|revoke`), is shown its secret once, and the runner exchanges the secret for a 15-minute access token and pulls pipeline jobs over HTTPS (`/compute/runners/token`, `me`, `claim`, `heartbeat`, `complete`).
  Migration 0140 adds the runner registry tables and twelve executor, accounting and lease columns on `compute_jobs`: a job records its executor (`tapis` or a runner) and its accounting class, and a runner job writes no ledger entry, because a runner-reported core-hour is never added to a service-unit total.
  Leases expire and are swept, revoking a registration or ending its owner ends the runner's tokens and work in one batch, and a pipeline dispatch checks the Zarr copy's source commit first.
  Creating a runner job and every runner claim stay behind the dark switch `COMPUTE_RUNNERS_ENABLED`; an owner can register a runner while it is off, and the registration does nothing until the switch is on.
  A Tapis-executor pipeline run is refused `tapis_unconfigured` (503) before any write while Tapis is unconfigured, so `COMPUTE_ENABLED` may be set for runner jobs alone (ADR 0118 amendment, #2176); the Tapis go-live stays parked.
  ADR 0122 records one container image that runs under Apptainer or Docker from one digest; Podman is unsupported.
- **A waiting runner job that can never be claimed is ended by the lease sweep.**
  When its dataset is deleted or no longer passes the pipeline eligibility predicate (unpublished, withdrawn, anonymous, tombstoned), the job ends `runner_lost` with the new detail `dataset_ineligible`, so it stops holding a `runners.maxLiveJobs` slot; a job whose dataset is still eligible is untouched.
  A runner job that has waited unclaimed for over a day is counted as the attention word `runner_waiting_stale`.
  The runner routes other than the secret exchange are rate limited by client address, not by bearer, so a made-up bearer mints no bucket.
- **One `nemar-floor` recipe with two inputs (#2177, migration 0141).**
  The recipe registry lists `nemar-floor` with inputs `bids` (on Tapis) and `zarr` (on a runner), and `nemar-floor-zarr` is removed.
  A pipeline stamp now records the input, the reader, the engine and the digest of what the run read.
  A dispatch whose input does not match its executor is refused `invalid_spec` with `field: "input"`.
  A BIDS run's command and arguments are unchanged; a Zarr run's command is `nemar-recipe run nemar-floor --input zarr`.
  The migration renames existing `nemar-floor-zarr` stamps to `nemar-floor` with input `zarr` and rebuilds the two live-stamp indexes; production holds no such stamps.
- **Reports separate runner usage from service units (#2179, migration 0142).**
  `nemar admin compute jobs list` takes `--executor`, `--accounting` and `--runner`; `jobs report` and `jobs record` show runner-reported usage, marked partial when the runner could not measure all of it, and never beside a service-unit figure.
  `GET /admin/compute/report` counts service-unit jobs only in `totals` and `by_pool` and carries runner jobs in a separate `runner_totals`.
  `nemar admin compute runners usage --from --to` (route `GET /admin/compute/reports/runners`, at most 366 days) reports each runner's jobs by state and its summed wall time, CPU time and largest resident memory.
  Migration 0142 adds `compute_jobs.runner_usage_partial`.
- **The derivative store (#2178, #2180, #2191, #2193, #2194, ADR 0123, migration 0143).**
  A finished pipeline job's product is copied server side from the results bucket into a private derivatives bucket under `d/<key>/`, with a `derivative.json` that names what produced it, the source datasets (with the version DOI when one exists), the profile and every file with its size and SHA-256 digest.
  A dataset that stopped being eligible after its job finished (unpublished, withdrawn, anonymous or tombstoned) is neither keyed, copied nor promoted.
  The key is the SHA-256 of eight fields (dataset, version, recipe, recipe version, engine, input, profile and input digest), computed by `shared/contract/derivatives.ts`, which is import-free and has shared test vectors that a Python implementation reproduces.
  A Zarr input's digest covers the electrode positions its recipe was handed (`nemar.input-digest.v2`), so a reconversion that changes only positions gets a new key.
  Retention is by class: `canary` expires 30 days after it is stored, `catalog` is kept until a later catalog derivative of the same dataset, recipe, input and profile is promoted (then 30 days), and `published` is never expired, superseded or deleted by code and has no DOI minted by code.
  Migration 0143 adds `compute_derivatives` and a skip log.
  `nemar admin compute derivatives list|show|promote|sync` (routes under `/admin/compute/derivatives`; `published` is the owner's) manage it, and one daily production pass frees what is due and copies at most 100 objects.
- **Architecture records and plans:** ADR 0121 to ADR 0124 (executor and accounting class, one image under two container runtimes, the keyed derivative store, reader conformance), the ADR 0118 amendment of 2026-11-14 on runner-only deployments (#2176), and the Brainlife indexing plan (#2197, documentation only).

### Changed

- **The Zarr converter records where a store's electrode positions came from (#2190).**
  A store's root gains `electrode_positions_source` (`subject` or `dataset`), `electrode_positions_file` and, when one resolved, `electrode_coordsystem_file`, written only when positions are written.
  Neither word means measured, and no template is ever written.
  An `_electrodes.tsv` or `_coordsystem.json` named with the `space` entity now applies, and when the most specific files hold more than one `space` value the recording gets no positions and one warning names the files.
  The change is in the converter script only: nothing is reconverted by this release, and a store carries the new attributes after its next conversion.
- **Help text, README and the `repo` group description now use the new command names** ("Dataset publication lifecycle: publish, unpublish, withdraw, restore").

### Fixed

- **Files whose names contain a reserved character no longer 404 on `data.nemar.org` (#2139).**
  `manifest.json` URLs encode each path segment, and the route decoded only part of the escapes, so `%2B`, `%23`, `%26` and the like never matched the manifest key (nm000454 v1.0.2 has 177 FreeSurfer `*+aseg.mgz` files that failed this way).
  The route now decodes the pathname once per segment before the lookup; a literal `+` still resolves and decoded `..` segments are still refused.
  Compact-manifest URLs have the same form and are fixed too.
  The `/<id>/qa/*` route reads the path the same way and is not changed here.
- **Converter defects found while adding provenance (#2190).**
  A coordinate that parses to `NaN` or infinity (including an overflowing `1e999`) is skipped like `n/a`, where before it wrote a bare `NaN` token into the store's root `zarr.json`, which `JSON.parse` refuses.
  An electrodes file that cannot be read now prints one warning naming it, instead of looking like a dataset that declares none.

### Deploy coupling

- **Migrations 0140 to 0145 apply with the Worker deploy,** before the Worker is deployed.
  0140 adds the runner tables and `compute_jobs` columns, 0141 adds the stamp input columns and rebuilds two indexes, 0142 adds `runner_usage_partial`, 0143 adds the derivative tables and triggers, 0144 adds `publication_requests.unpublished_at`, and 0145 adds the trigger that marks an embedding stale when visibility or status changes.
  Migrations 0131 to 0139 are unused; numbering continues above 0130 so a fresh replay and production agree.
- **The derivative bucket `nemar-compute-derivatives` must exist before the release deploys** (it exists), or the Worker deploy fails after the migrations have applied and 0.10.33 keeps serving.
  The dev Worker binds its own `nemar-compute-derivatives-dev`.
  The production configuration gains the binding `COMPUTE_DERIVATIVES` and the variable `COMPUTE_DERIVATIVES_BUCKET_NAME`, and nothing else; no switch, secret or other variable changes.
  The store reuses the compute token that already covers the other two compute buckets.
- **The central approval workflow change (nemarDatasets/.github#155) must merge before this release.**
- **Update scripts and runbooks that call `nemar admin publish`, `admin withdraw`, `admin restore`, `admin repo public` or `admin repo private`, or `PATCH /admin/datasets/:id/visibility`,** before or with the release.
- **No website release is required.**
  The website does not call the changed administrator commands, and search keeps its response shape.
- **Run `bun run migrations:d1-check` before the release pull request.**
- **Rolling back.**
  The migrations add tables, columns, indexes and triggers that the 0.10.33 Worker ignores, so a rollback is safe for the schema.
  Rolling a Worker back to a build from before the tenant block makes a stored policy that has the `tenant` key unreadable, and a build from before the runners block does the same for the `runners` key (the reader is strict and fails closed); turn runners off and drain them, and write a policy without the keys, before any rollback across them.
  Concretely, once the owner has run `nemar admin compute policy set` with the new `tenant` or `runners` keys, the older Worker reads the policy as unavailable: roll back only before the first policy set, or revert the policy first.
  After a Worker rollback, rows with `embedding_dirty = 2` wait until the release is deployed again, since the older drain does not read that value.

### Owner steps after release

None of these is done by the release.

1. Repair nm000289, which a bare private flip on 2026-10-29 left private and still recorded as published.
   Run `nemar admin repo unpublish nm000289` first (a dry run that changes nothing), then `nemar admin repo unpublish nm000289 --execute --reason "<why>"`.
   Check `nemar dataset publish status nm000289` (no request, unpublished by an administrator) and `nemar dataset status nm000289` (found, DOIs still listed).
   Then approve the pending access request with `nemar dataset access approve <user> nm000289`; `nemar dataset access list nm000289` shows it.
   If the dataset is still not found, check that the CLI points at production (`nemar auth status`; unset any test API URL in the shell).
2. Roll out semantic search for private datasets, after the deploy.
   Done on 2026-11-18: the Vectorize metadata indexes `visibility` (string) and `dataset_id` (string) were created, and `POST /admin/vectorize/reindex-all` relabeled all 910 public vectors (7 transient failures retried one by one).
   `VECTORIZE_VISIBILITY_FILTER=1` is set in production `[vars]` by #2211, so it takes effect with the release that carries that pull request.
   After that release deploys, run `reindex-all` again (keyset-paged until `has_more` is false) to embed the private datasets; otherwise the daily drain embeds them 50 at a time.
3. Verify re-publishing an unpublished dataset end to end on `nm099999` (#2202): unpublish, file a request, approve, and check the version and concept DOIs.
4. `curl -s https://api.nemar.org/health | jq -r .version` prints `0.10.34`, and `nemar admin compute status --json | jq '.switches, .storage'` shows the compute switches false and the three bucket bindings true.

### Known limits

- After an unpublish or a withdraw, search reflects the change at once, but the anonymous dataset page and the public catalog list are cached at the edge and can keep showing the dataset for several minutes.
- Vector labels refresh on the daily drain, so with `VECTORIZE_VISIBILITY_FILTER=1` on (production, from the release carrying #2211), anonymous semantic search can miss a just-published dataset until then; keyword search finds it at once.
- The list and facet endpoints show private datasets only to administrators; owners and collaborators do not yet see their own private rows there (#2203).
- Re-publishing an unpublished dataset has not been exercised end to end: the orchestrator reuses the existing concept and version DOIs and handles an existing DOI, but a second publish of the same version number was not run against EZID (#2202).
- `nemar admin make-public` is still a bare public flip with no publication request, the same class of half state that `repo public` was; it is not changed here.
- Query spelling correction uses only the public vocabulary, so a misspelled word that appears only in private datasets is not corrected.
- Counting the orphaned platform jobs scans `compute_jobs` once per hold, because an index for it would need a migration.
- The pipelines' daily cap is still read before a run and not checked in the hold's statement (see 0.10.33).
- The derivative store copies nothing in production until a pipeline job succeeds, which needs the compute switches the owner has not set.

## 0.10.33 - 2026-11-11

NEMAR can now act as an OpenID Connect provider (epic #2014), and the first-party half of the compute gateway is in the code (epic #2005).
The sign-in flow and compute stay dark in production until the owner switches them on.
The OpenID Connect discovery document, key set and owner routes answer 404 until `OIDC_SECRET` is set (the owner sets it before the release, so they answer at deploy, with an empty key set), and the whole sign-in flow (authorize, consent, token, userinfo, revocation and introspection) stays dark until `HOST_PREFIXED_SESSION_COOKIE` is also `"1"`.
No job can be submitted and no pipeline is dispatched while the two compute switches are absent.
Nothing contacts the job scheduler's tenant except an administrator's `nemar admin compute status`, which mints one token and makes one health call when the tenant's credentials are set.
The release has twelve migrations, 0114 to 0119 (compute), 0120 to 0124 (OpenID Connect) and 0130 (compute anonymization).
Migration 0114 adds the four platform pools (pipelines and people, CPU and GPU) with nothing granted.
Migration 0120 gives every existing user, deleted accounts included, a permanent `sub` and adds triggers that keep it unchanged.
Restoring the database to a point before 0120 and replaying it gives every account a new `sub`.
That is harmless until the first client is registered; after that, restore only to a point after 0120, or tell every client.
It sets no Worker secret.
The production Worker configuration gains the two private compute buckets as bindings and their names as variables; the buckets already exist.
The CLI gains no runtime dependency: `jose`, `oauth4webapi` and `openid-client` are development dependencies that one test uses.
Third-party compute (`nemar compute`) and the partner contract are not in this release.

### Production behavior changes

- **The ORCID sign-in flow's two short-lived cookies change name at deploy (ADR 0119 rule 10).**
  `nemar_oauth_state` and `nemar_orcid_pending` become `__Host-nemar_oauth_state` and `__Host-nemar_orcid_pending`, which a sibling host cannot set.
  They live for minutes, so a person who starts an ORCID sign-in just before the deploy and finishes it just after may need to start again.
  The change is not behind a flag, and the website must already accept the new pending-cookie name (see Deploy coupling).
- **A plain ORCID sign-in no longer links the iD to the account already signed in (ADR 0119 rule 10).**
  `GET /auth/orcid/start` starts a sign-in whatever its `mode` says; only the form POST from Settings, which checks the Origin and needs a session, starts a link or a relink.
  A sign-in signs in the account the iD names, or starts a sign-up for an iD no account holds, and always issues a fresh session.
  Website 0.2.37 carries the form POST; a website older than that starts a sign-up instead of a link (see Deploy coupling).
- **Email-code sign-in is closed outside development and test (#2112).**
  `/auth/code/request` answers the same masked success without issuing a code, and `/auth/code/verify` answers 401, so nothing can obtain or redeem a sign-in code in production.
  The codes that confirm or change an email address for a signed-in account are separate and unchanged.
  ORCID is the only upstream identity; the code path stays in the repository, dormant.
- **Usernames starting with `nmu_` are reserved, and credentials starting with `nmo_` are never read as API keys.**
  A profile edit, the person's own (`PATCH /auth/profile`) or an owner's (`nemar admin users edit`), refuses a username that starts with `nmu_` in any case (`username_reserved`), and `GET /auth/check-username` reports one as unavailable, because that prefix is the form of the OpenID Connect `sub`.
  An existing username is not changed.
  Outside the provider's own routes (discovery, the key set and the four `/oauth` endpoints), a bearer credential starting with `nmo_` is refused before any lookup.
  A route that needs a signed-in caller answers 401 `oidc_token_not_accepted`, and a route with an anonymous answer gives that answer, as it does for an unknown key.
- **`compute.nemar.org` is no longer treated as a NEMAR page (ADR 0119 decision 9).**
  The API sends it no CORS headers and refuses a cookie-authenticated write from it, although it ends in `.nemar.org`, because a partner runs it.
- **The OpenID Connect back-channel logout retry runs on the 30-minute production tick from deploy.**
  It reads no switch, and with no client registered it has nothing to send.
  While `OIDC_SECRET` is set in the wrong form it writes nothing and logs `[oidc-logout] skipped reason=oidc_secret_malformed` at warning level on every tick, and once after each admin revocation, soft delete, kind change, manual account merge, `nemar admin oidc` grant ending, ORCID unlink or relink and test-account sweep; an absent secret is silent.
- **Every cached `manifest.json` is rebuilt on its first request after deploy,** because the cache key moves to `v3` (see Fixed).
- **The session cookie is unchanged.**
  `__Host-nemar_session` is written only when the owner sets `HOST_PREFIXED_SESSION_COOKIE` to `"1"`, after both releases are out; the legacy `nemar_session` name keeps being read for at least 31 days after that.

### Added

- **NEMAR as an OpenID Connect provider (epic #2014, ADR 0119).**
  Authorization code flow with Proof Key for Code Exchange (PKCE), discovery and signing keys, authorization and consent pages, token, userinfo, revocation and introspection, refresh rotation, and back-channel logout that is queued and retried.
  A person is identified by a stable `sub` (`nmu_` and 32 hexadecimal digits), never an email address or an ORCID iD.
  `nemar admin oidc` registers and manages clients and keys, and ends an account's grants.
  Discovery, the key set and the owner routes answer 404 until `OIDC_SECRET` is set, and the secret must have the `nmsso-` form (#2074).
  Authorize, consent, token, userinfo, revocation and introspection also need `HOST_PREFIXED_SESSION_COOKIE` to be `"1"`, so the whole flow is dark or lit together.
  Admin revocation, an owner soft delete and a manual account merge end an account's grants and queue a back-channel logout to each client.
  Unlinking or relinking ORCID, and changing an account's kind away from person, end only the grants of clients that require a proven ORCID iD.
  No compute suspension exists yet, so none ends a grant.
  Signing out, revoking an API key and demoting a role deliberately leave grants alone, and every token use re-checks the account against the client's sign-in rule.
  Discovery and the key set are exempt from the rate limiter, and a read of them from maintenance mode.
  The token, revocation and introspection endpoints share a limit of 2,000 requests a minute per address (`oauth-ip`), and the authorization check and consent share a limit of 30 a minute per account.
  In read-only maintenance mode userinfo and introspection still answer and the token endpoint and revocation are refused, so a partner's sessions lapse within the access token's 15 minutes.
  The protocol is documented at docs.nemar.org under Sign in with NEMAR; the operator runbook is in the gated administrator section.
- **The compute gateway's first-party half (epic #2005, ADR 0118).**
  An allocation ledger and owner policy in service units (SU), job records with two private storage buckets, a client for the job scheduler, tested against a stand-in, the job lifecycle with webhooks, settlement and results, revocation that freezes a person's pools, and NEMAR's own processing pipelines dispatched by an administrator.
  `nemar admin compute` covers the policy, pools, status, jobs (including legal holds and the ACCESS reports), the observer token and `pipeline run|status`.
  Nothing runs until the owner sets `COMPUTE_ENABLED` and `COMPUTE_PIPELINES_DISPATCH_ENABLED`, which are absent from the production configuration and pinned absent by a test; every compute cron is production-only.
  The tenant sweep waits for `COMPUTE_ENABLED`, and the pipeline dispatcher waits for both switches.
  Five run without a switch: job advance, cancellation retry, the ACCESS gateway-attribute reporter, retention and the OpenID Connect logout retry.
  Job advance checks `COMPUTE_ENABLED` at one step only, just before it would create a job at the scheduler, so a live job is always read back and a job that has not been submitted waits.
  The four compute ones act only on jobs and pools that exist, so they have nothing to do until the first job, and turning compute off never strands a live job.
  NEMAR's own pipelines obey their caps on every path, fixed before this release (#2122, from issue #2121): the live cap per pool is checked inside the statement that takes each pipeline job's hold, and an administrator's `pipeline run --eligible` also stops at what is left of the daily cap and dispatches at most 10 per invocation, reporting the room it had.
  One named dataset is refused when its pool is full and counts toward the daily cap without being refused by it.
  The daily dispatcher's counts and words are unchanged unless it races an administrator's run.
  When the daily cap ended a `pipeline run --eligible`, the run reports the new word `daily_cap_reached` as its `stopped_by`; the word is declared with status 409, and no path returns it as an error status.
  In read-only maintenance mode the launcher's three job callbacks stay open, so a job already running can still deliver its results; `full` refuses them.
- **A development target for the OpenID Connect conformance workflow (#2075).**
  The suite can run against the deployed development system; the default is unchanged.

### Changed

- **`--debug` redacts `client_secret`.**
  The client secret that `nemar admin oidc clients add` and `rotate-secret` print once is written as `[REDACTED]` in a `--debug` log, like an API key.
- **The Worker's request log writes the token of a Tapis webhook address as `[redacted]`.**
  Its lines are otherwise unchanged: method, path with its query string, status and time, at the same volume.
- **CI: the test workflow checks out `nemarOrg/nemar-process` at its epic branch, and the OpenID Connect conformance workflow is new on `main`.**
  The checkout (`feature/issue-1-epic-process`) supplies the observation schema, its fixtures and the queue-memory template to the drift tests, with `NEMAR_REQUIRE_PROCESS_OBSERVATION_DRIFT` and `NEMAR_REQUIRE_PROCESS_QUEUES` set to `1`, so the tests fail, not skip, if that branch or its files are gone.
  Move the checkout to that repository's `main` when its epic merges; until then, deleting the branch breaks CI on `main`.
  `oidc-conformance.yml` runs by manual dispatch only.

### Fixed

- **A file whose name has no dot no longer gets that name appended to its checksum in `manifest.json` (#2118).**
  Some keys in the published datasets were written upstream (OpenNeuro tooling), not by git-annex, with the tail of a dotless file name straight after the digest: `COR-001` has the key `SHA256E-s65536--<64 hex>COR-001`, where git-annex itself would write the bare digest.
  The central manifest generator wrote the stored manifest from those keys and had the same parse; this change makes the Worker's own reader and builder correct, and the generator now cuts the digest the same way (nemarDatasets/.github #152).
  The parse took every hex character after `--` as the digest, and the leading `C` of `COR-001` and the `01` of `01_brain_surface` came along: 260 entries in the manifest of `on003104` at `v1.0.0` carried 65 or 66 characters instead of 64.
  The compute launcher verifies manifest checksums and would refuse those files.
  The digest is now cut to the backend's length, for every git-annex hash backend whose key the parser identifies (SHA256, SHA512, MD5, SHA1, the SHA3, SKEIN and BLAKE2 families, with or without the `E` suffix), and the backend name now accepts `_` and a size-less key, so `SHA3_512E` keys are no longer read as `sha256`.
  A key of any other backend (`URL`, `WORM`, one the parser does not know) is read as before.
  The served `manifest.json` re-derives the value from the stored key when a stored value has the wrong shape for its algorithm, so manifests already published are served correctly with no regeneration.
  The cached `manifest.json` documents are keyed anew (`v3`), because the old ones are only revalidated against the source manifest's ETag and would otherwise keep serving the old digest for up to seven days.
  Valid entries and `git` entries are served as before.
  A value that cannot be repaired is served as stored.
  Each build of a `manifest.json` that repaired a value or met one it could not repair logs one error-level line, `[data] MANIFEST CHECKSUM: dataset=<id> version=<version> repaired=<n> malformed=<n>`, with the first unrepairable path when there is one.
  `bun scripts/audit-manifest-checksums.ts` reads every public manifest from the data host, with GET requests only and no credential, and lists each version whose checksums have the wrong shape for their algorithm.
  It lists the manifests too large for `manifest.json` (413) without failing on them, and exits 1 when it finds a wrong-shaped checksum or cannot read a version.
  The in-Worker manifest builder never refuses a manifest over a digest: it carries the value as found and logs once per build (dataset, version, path and backend, no checksum value) when an identified backend has a digest of the wrong length.

### Deploy coupling

- **Release the website first (0.2.37), and let its deploy finish.**
  Its `staging` carries the reader for the `__Host-` session cookie and for the ORCID pending cookie under either name (website #499), the authorization page, the Settings "Connect your ORCID" form POST and the proxy's refusal of `/auth/oidc/*` (#501), and the cross-site form exemption for the authorization request (#503).
  If this API reaches production first, every brand-new ORCID sign-up fails at the email step, because the released website looks only for `nemar_orcid_pending`.
  "Connect your ORCID" in Settings then starts a sign-up instead of a link, because the released website sends it as a link this API no longer honors.
  The released API accepts everything the new website sends, so the website can go first with no gap.
- **Before merging, check that the two compute buckets exist, and put `OIDC_SECRET` in the `nmsso-` form.**
  The deploy applies the migrations before it deploys the Worker, so a missing bucket fails the Worker deploy after the schema has changed, and 0.10.32 keeps serving.
  A valid `OIDC_SECRET` lights discovery, the key set and the owner routes at deploy; the key set is empty until `nemar admin oidc keys rotate`.
- **Merging the release pull request deploys it twice,** the merge commit under its `-devN` version and then the tagged `0.10.33`; the first deploy applies the twelve migrations.
- **Then check ORCID sign-in end to end, turn `HOST_PREFIXED_SESSION_COOKIE` on, and check sign-in again.**
  The flag is a Worker secret, or a `[vars]` entry added by a reviewed change that edits `backend/test/session-cookie-name.test.ts`; a dashboard variable is dropped by the next deploy.
  Turning the cookie flag on before the website reads the new name logs everyone out of the website.
  Before turning it on, count the active accounts that have no verified ORCID iD (a read-only query on `users`, `orcid_verified = 0`).
  With the flag on, a session read under the legacy `nemar_session` name is no longer slid and cannot start an ORCID link, and email-code sign-in is closed, so such an account can connect an iD only with `nemar auth profile orcid link` or through an owner's edit; ask those people to connect while the flag is off, or tell them how.
- **Rolling back.**
  The migrations add tables and indexes, one column on an existing table (`users.oidc_subject`, filled for every user), triggers (0130 replaces two) and four empty pools, and the 0.10.32 Worker reads none of them, so a rollback to 0.10.32 is safe while the cookie flag is off; ORCID sign-ins in flight fail once, as at deploy.
  Once the flag is on, a rollback below 0.10.33 signs out everyone who signed in since, because 0.10.32 does not read `__Host-nemar_session`.
- **Run `bun run migrations:d1-check` before the release pull request.**
  The twelve migrations replay on real D1; one of them (0130) replaces two append-only triggers, one on the pools and one on the ledger.

### Owner steps after release

None of these is done by the release.

1. `curl -s https://api.nemar.org/health | jq -r .version` prints `0.10.33`.
2. `nemar admin compute status --json | jq '.switches, .storage'` shows `compute_enabled` and `pipelines_dispatch_enabled` false and both bucket bindings true.
3. `curl -s -o /dev/null -w '%{http_code}\n' https://api.nemar.org/.well-known/openid-configuration` prints 200 with a valid `OIDC_SECRET` and 404 without, and the same with `-X POST https://api.nemar.org/oauth/token` prints 404 until the cookie flag is on.
4. `curl -s -H 'Authorization: Bearer nmo_at_x' https://api.nemar.org/users/me` answers 401 with `"code":"oidc_token_not_accepted"`, and `nemar auth whoami` still answers with a CLI key.
5. Sign in with ORCID at https://nemar.org/login, and connect ORCID from Settings with an account that has none, if one is at hand.
6. `bun scripts/audit-manifest-checksums.ts` reports no wrong-shaped checksum and lists the manifests that answer 413.

### Known limits

- The pipelines' daily cap is read before a run and not checked in the hold's statement, so two runs at the same moment can together pass it; an atomic daily guard is planned beside the tenant ceiling (#2126, phase P2, from issue #2121).
- The `manifest.json` reader repairs a wrong stored digest at read time, and the central generator now writes the right digest for new manifests.
  The one stored manifest known to carry wrong digests (`on003104` at `v1.0.0`) has been regenerated, and the per-file `ETag` of those files changed once.
  If the audit finds another stored manifest written before the generator fix, it is served repaired and stays wrong in storage until it is regenerated.
- Migration numbers 0125 to 0129 are unused and 0130 is applied; a later migration must be numbered above 0130, or production applies it in a different order from a fresh replay.
- The authorization flow has run in tests and, without a sign-in, against the development system (34 of the 35 modules of the conformance suite's Basic plan); its first production use is the check.

## 0.10.32 - 2026-11-09

A re-pull merged with GitHub's merge button using the merge method, which makes a two-parent commit, can now be accepted.
It changes the Worker's acceptance route and the CLI; it carries no migration, sets no Worker variable or secret, and leaves the re-pull switches and caps as they were.

### Fixed

- **`--accept-merge-trailers` takes a plain merge commit of the re-pull's own pull request (#2108).**
  The first use of the acceptance, on on000117 (re-pull #5), met a merge made with the merge method: two parents, the record's base and the pull request's head.
  The CLI and the Worker both refused it as `merge-not-squash`, so the record stayed at `merged` and the dataset failed the fresh-clone privacy proof with no way to finish.
  Both now accept one parent, or two with the merged head second, through one predicate, `classifyMergeParents`.
  Every other check is unchanged: the pull request, the base, the head, the tree outside `.nemar/**` and `.github/**`, the effect on the privacy ledger, and the administrator-only rule.
  Three or more parents stay `merge-not-squash`, and two parents whose second is not the merged head are the new `merge-second-parent-foreign`.
  The acceptance line keeps the verification word `squash-merge-verified` for both shapes, because a ledger validator already deployed accepts that word and no other.
  ADR 0111 has an amendment section for it.

## 0.10.31 - 2026-11-08

CI and release tooling only, brought from `dev` so that `main` stops needing an administrator override and stops being slower than `dev`.
It carries no migration, no change to the Worker or the CLI, sets no variable or secret, and leaves the re-pull switches as they were.

### Changed

- **`main` has `dev`'s CI workflows (#2106 and the work before it on `dev`).**
  `integration-dev` runs as six shards balanced by `test/integration-timings.json` (the unsharded job took 26 minutes), and the production deploy gate runs the same six `unit-pure` shards as the pull request check plus a static leg for typecheck, lint and the process tier, so a test that depends on file order fails the pull request and not the release (what stopped 0.10.28's deploy).
  The `process-tier` job and its lister, `scripts/ci/process-files.sh`, now exist on `main`, so every required check of branch protection runs on a pull request to `main`; until now `process-tier` did not, and each of 0.10.28 to 0.10.30 had to be merged with an override.
  The two composite actions `install-git-annex` and `german-locale` and the classifier scripts come with them.
  `oidc-conformance.yml` and its scripts stay on `dev` with the sign-in epic.
- **`sync-dev` resolves a hotfix's version conflict (#2106).**
  A hotfix released from `main` conflicts with `dev` on `package.json` and `backend/package.json`.
  `scripts/ci/sync-dev-merge.sh` now resolves a conflict whose every conflicting hunk is a `"version"` line to `main`'s side with a three-way merge, which keeps what `dev` changed elsewhere in those files, and aborts for a person on anything else.

## 0.10.30 - 2026-11-08

The first two production re-pulls met a second fault in the release step, one the stand-ins' tags hid.
It carries no migration, sets no Worker variable or secret, and leaves the re-pull switches and caps off.

### Fixed

- **Release sends the commit an annotated tag names, not the tag object (#2101).**
  After 0.10.28 the Worker could read the tag, and `nemar admin repull resume` was then refused as `tag-mismatch`: `git ls-remote origin refs/tags/v2.0.0` lists only the annotated tag's own object, and shows the peeled commit line only when `refs/tags/v2.0.0^{}` is also asked for by name.
  The release read and the upstream-tag check in the executor now ask for both.
  The test world's tags are annotated now, as the dataset workflow's are, so the suites read the peeled line.
  An automatic re-pull runs the published CLI, so this release is the one that has to ship before the switches go on.

## 0.10.29 - 2026-11-08

0.10.28's production deploy stopped at its test gate, so this release carries the same fix with the gate made passable.
It carries no migration, sets no Worker variable or secret, and leaves the re-pull switches and caps off.

### Fixed

- **The re-pull help test no longer depends on test file order (#2104).**
  `src/lib/help.ts` replaces every "after" help text with a one-line hint once it is loaded, so the deploy gate, which runs the pure tier in one process and loads that module first, failed four cases of `test/repull-command-text.unit.test.ts` that the sharded pull request run passed.
  The test now reads each help through the real entry point in its own process with `--help-all`.
  There is no change to the CLI or the Worker beyond a comment on the tag read; 0.10.28's fix (the tag is read by its full ref) is what this release deploys.

## 0.10.28 - 2026-11-08

A one-fix release, cut from `main` and not from `dev`, so that the first two production re-pulls can be released.
It carries no migration, sets no Worker variable or secret, and leaves the re-pull switches and caps as they were (off and at their defaults).
It also carries the sign-in consent copy strings that the website's `staging` branch already holds (below), because the release check compares the two repositories' copy tables and fails a pull request to `main` until they agree (ADR 0046).

### Fixed

- **A merged re-pull can be released: the tag is read by its full ref (#2101, #2102).**
  The release step read the tag's commit at `commits/tags/<tag>`, and GitHub answers 422 to that spelling, so `nemar admin repull resume` refused every merged re-pull with `tag-missing` although the tag existed and pointed at the merge commit.
  It happened to on003645 and on004362, whose records stopped at `merged`.
  The read is now `commits/refs/tags/<tag>`.
  Both re-pull GitHub stand-ins had accepted the short form, which is why the suites passed; they now refuse it as GitHub does, and a direct test on each pins that.
  Until this release an automatic re-pull would have merged, minted a version DOI, and then failed to release.

### Changed

- **The account copy table mirrors the website's sign-in copy (ADR 0119, from the sign-in epic #2014).**
  `shared/contract/account-copy.ts` gains the `oidc.consent.*`, `oidc.rule.*` and `oidc.error.*` strings and the `{client}` and `{redirect_host}` placeholders, taken unchanged from `dev`.
  Nothing on `main` reads them yet, so no behavior changes; the sign-in feature itself ships with the release that carries the epic.

## 0.10.27 - 2026-10-29

The production canary and the first production re-pulls found three faults that this release fixes, and the release carries the phrase-search rework with them.
A re-pull's S3 copy no longer fails on the upstream bucket's tag denial; a re-pull merged outside NEMAR's tools can be accepted on evidence instead of stranding the record; and a re-pull's own pull request is no longer failed by the automated review of contributor changes.
Search stops answering a phrase with most of the catalog (ADR 0116).
The release has one migration, 0113, which creates one table and changes nothing that exists.
It sets no Worker variable or secret, and the four re-pull switches and caps stay absent from the wrangler configuration.

### Changed

- **A re-pull's single-object S3 copy sends `--tagging-directive REPLACE` (#1991, #1992).**
  Upstream's bucket denies reading the tags of its newer, tagged objects (ADR 0063), and a plain cross-bucket `copy-object` reads them, so the canary's first run failed at the copy step with an access denial, and a re-pull of such an object would have failed there.
  The write guard now refuses a `copy-object` that does not carry exactly `REPLACE`, and the production canary and the S3 stand-in follow the real buckets.
  The multipart path carries no tags and is unchanged.
- **A re-pull merged outside NEMAR's tools can be accepted on evidence (#1996, #1997; ADR 0111, amendment of 2026-10-29).**
  The merge gate writes a re-pull's squash message so that its last paragraph holds the commit's trailers, because the privacy ledger's fresh-clone proof reads the merge as the re-pull's own commit only then.
  A merge made with GitHub's button has no trailers, the release refuses it as `merge-trailers`, and the record used to stay at `merged` for good.
  `nemar admin repull resume <dataset> --accept-merge-trailers "<reason>"` (10 to 500 characters, recorded for the administrator who gives it) now verifies, from GitHub, that the merge is the squash merge of the record's own pull request, that its tree is the record's commit outside `.nemar/` and `.github/`, and that its parent is the record's base or a descendant that enrichment moved.
  The Worker repeats every check with its own credential at the new route `POST /admin/repulls/:id/merge-trailers/accept`, records the acceptance in `upstream_repull_merge_acceptances` (migration 0113), and, when the merge appended a `repull-scrubbed` line beside other files, appends one `repull-merge-accepted` line to `.nemar/corrections.jsonl` on `main`.
  The line holds the full merge commit id, the plan digest, the version, the scanner and a fixed verification word, and never the reason.
  The fresh-clone proof vouches for exactly that commit when it is a first-parent commit of a tip and not carried only by a tag.
  Only the administrator who opened the re-pull can accept its merge (`accept-not-yours`), and a re-pull the automatic path opened is never accepted (`accept-automatic`); the release's `merge-trailers` refusal now says so instead of advising the flag, and a Worker that has no acceptance route is named as such.
  A lost, timed-out or rate-limited answer exits 3 (run it again); a refusal exits 1.
  The runbook gains the check an administrator runs before any history rewrite.
- **A re-pull's own pull request is waived from the automated review (#1998, #2000; ADR 0117).**
  The review judges a change by contributor-protection rules, and a re-pull's pull request is upstream's delta built by the platform, so it failed, GitHub read the pull request as `unstable`, and `nemar admin repull resume` waited for `clean` while `merge --force` answered `not-ready`.
  One pure rule decides the waiver from NEMAR's own record: an open record of the same dataset names the pull request as its N.0.0 or N.0.1, in the dataset's own repository, from the record's branch into `main`, at the record's head, with the record at `pr_open`, `gates_clear`, `patch_synthesized` or `patch_gates_clear`.
  The Worker posts one `skipped` check run titled "Waived: upstream re-pull" and writes a `pr_review_waived` audit row; it creates no review row, dispatches no workflow and calls no model.
  The waiver is decided before the administrator exemption, a block or a restart.
  The queue shows a derived verdict `waived`, offers it for merge and leaves it out of `start --all`; `approvalGate` returns `confirm`, so no `--force` is needed.
  The Worker's own review of the App's re-pull pull request is retired.
  An existing failed check is updated in place, and a new run is posted when GitHub refuses the update; on the automatic path the tick republishes a waiver GitHub holds back for an N.0.0 pull request, and the 30-minute sweep retries stored review rows and gives up on one after five tries, about two and a half hours.
  A waiver with no stored row that fails to publish is retried by neither; an administrator's `nemar admin pr-reviews start` or a webhook redelivery publishes it.
  Findings the review would have raised are listed as recommended issues, none filed automatically.
- **Phrase search is judged for relevance (#1999; ADR 0116, proposed).**
  A phrase of two or more content words draws at most 30 candidates from each of the lexical, semantic and name/authors/tasks legs, and `@cf/baai/bge-reranker-base` on Workers AI scores the pool; a dataset is kept when the cross-encoder endorses it, or both retrieval legs found it and the cross-encoder does not strongly reject it, or every informative query word is literally in its name, authors or tasks.
  Words found in more than 25% of public datasets no longer decide a lexical match, bm25 weights name and description above the README, and the vector and the cross-encoder read one text (name, abstract, keywords, modalities, tasks).
  A query word that matches no public dataset is replaced by a catalog word one typo away and the response says so (`corrected_query`); a modality named in the query is listed first by whole token (`modality_boost`); filters are applied after relevance.
  Any model failure, or more than four seconds, serves the fused list as before.

### Production behavior changes

- **Search answers fewer, more relevant datasets for a phrase, and `GET /datasets/search` gains fields.**
  `reranked: true` marks a cut list; `count` of a phrase is then the number judged relevant and `min_score` is not applied to it.
  `corrected_query` and `modality_boost` appear when they apply, and the CLI prints "Showing results for ..." and a modality line.
  The website calls the same endpoint, so its "N results" shows a smaller number.
  One word is not cut.
- **A re-pull pull request no longer gets the automated review.**
  An existing `NEMAR PR Review` failure on a re-pull's pull request clears with `nemar admin pr-reviews start <dataset> <pr>`, which updates the check in place or posts a new run; the automatic path's tick does the same on its own.
- **`nemar admin repull resume` names the review check when it waits on a pull request that is not `clean`, and says which other check does not pass.**
- **The privacy-correction runbook gains item 8 under "Before each dataset".**
  It checks that the ledger names no merge a re-pull accepted before any history rewrite, because the rewrite gives that merge a new id and the proof would then fail closed.

### Deploy coupling

- The migration is applied by the release's deploy. 0113 is one new table, `upstream_repull_merge_acceptances`, keyed by its primary key; `deleteDatasetCascade` deletes its rows explicitly.
- The flag `--accept-merge-trailers` works only against a Worker that has the new route, so install the CLI after the Worker deploys.
- Search needs no deploy step of its own beyond the vector rebuild below, and the Workers AI binding (`[ai]`) is already in the production configuration.

### Owner steps after release

None of these is done by the release.

1. Rebuild the search vectors: `POST /admin/vectorize/reindex-all` with the body `{"after": "<last_id of the previous answer>"}` (200 datasets per call; `limit` goes to 500) until `has_more` is false, and read `failed` in each answer.
   Without `after` every call re-reads the first page.
   Whether 500 per call stays inside the Worker's subrequest limit is not established, so use the default if a call reports failures.
   Until it finishes the semantic leg searches README-based vectors, which work with lower recall.
2. In the first deploy's Worker logs, find `[search] rerank raw scores: ... read as logits` and a sane `rerank_ms`.
   Workers AI latency and the score scale were never measured live.
3. For a re-pull that is waiting on the review check, run `nemar admin pr-reviews start <dataset> <pr>`, then `nemar admin repull resume <dataset>`, then `nemar admin repull merge <dataset>` (the merge mints a version DOI and needs the administrator's go).
4. For a re-pull merged outside NEMAR's tools, run `nemar admin repull resume <dataset> --accept-merge-trailers "<reason>"` once the tag exists on `main`, then confirm the release locked the copied objects and the version DOI resolves.
5. Run the fleet backfill, `nemar admin upstream-backfill`, as a dry run and then with `--execute`, after the first re-pulls finish.

### Known limits

- Not verified against GitHub yet: that a `skipped` check leaves a pull request `clean`, and that `mergeable_state` reads the newest run of a check name.
  The first waiver in production shows both; if GitHub keeps the old failure, the pull request stays `unstable` and the record waits.
- A stamped `skipped` check stays if the record later ends with the pull request still open; closing the pull request is the remedy.
- The accept path's ledger write is leased on the ledger blob, not on `main`'s head, so a concurrent push to `main` can make the write retry.
  The Worker re-reads `main` before every write.
- The accept path was tested against a GitHub stand-in only; its first production use is the check.
- The waiver cannot tell a human-written `.nemar/` file from an enrichment file on a re-pull's branch, because commit identities are forgeable and the push sender is not recorded.
  The identifier screen, the BIDS check, the administrator's confirmation and push access to the branch are the mitigations; whether to add a filename allowlist is the owner's decision.
- An administrator-origin record whose waiver was abandoned after five tries, or never had a stored row, needs `nemar admin pr-reviews start` by hand.
- A re-pull the automatic path opened and that is merged with GitHub's button stays at `merged`, and no command moves it on: the Worker's own merge carries the trailers, so only the button can cause it, and the acceptance is refused for it (`accept-automatic`).
  Only the administrator who opened a re-pull can accept its merge (`accept-not-yours`).
- A plan made before its record exists changes digest once the record is created, because creating it writes the version row's lineage and the plan's `from_tag_basis` then reads `version-row`; a `resume` with the original plan stops as `plan-stale`, and the way on is `abandon`, a fresh `plan`, then `execute` (#1994, open).
- The phrase search's calibration truth sets read the same fields the cross-encoder reads, so its benchmark favors the cross-encoder; the held-out gap is the part that does not.

## 0.10.26 - 2026-10-28

An OpenNeuro mirror can be moved to a newer upstream snapshot as its next major version, through a reviewed pull request that an administrator drives by hand or, once the owner turns it on, the automatic path drives (epic #1046; Architecture Decision Record (ADR) 0111).
The release has four migrations, 0104, 0105, 0106 and 0112, each of which adds a column, a table or an index and drops nothing.
It sets no Worker variable or secret: the four re-pull switches and caps are absent from the wrangler configuration, so the automatic path is off unless a Worker secret of the same name turns it on (`GET /admin/repulls/switches` reports what the Worker reads).

### Changed

- **Phase 2 (#1908): every version records the upstream snapshot it mirrors.**
  `dataset_versions` gains `source_version` (the OpenNeuro tag) and `source_version_basis` (`doi`, `lineage` or `unknown`; both NULL means never examined).
  Each version insert of an `on` dataset reads the tagged `dataset_description.json` once through the raw content delivery network (CDN), under a time bound, and records the snapshot; a failed read leaves the row unexamined and never fails the insert.
  One parser, `sourceSnapshotOf`, reads the dataset's own `SourceDatasets` entry; signals that disagree give `unknown`, and a tag is never guessed.
  `nemar admin upstream-backfill` records it for versions published before the columns (a dry run unless `--execute`); it writes `unknown` for a missing file only after a control read proves the 404 is about the tag and not the credential.
- **Phase 3 (#1909): an import is pinned to an upstream snapshot tag, never the mirror's default HEAD (ADR 0111 decision 10).**
  The auto-import dispatches the tag discovery found (`client_payload.openneuro_tag`, also in its `auto_import_dispatch` audit row), `nemar admin import-openneuro --tag <tag>` names one for a single dataset, and with neither, prepare asks OpenNeuro's GraphQL for `latestSnapshot.tag` when it runs, which is what a retry gets: the retry engine dispatches no tag.
  The clone's branch is reset to `refs/tags/<tag>` before anything else happens.
  When an explicit tag is not OpenNeuro's latest, prepare warns: the import's copy still takes the object currently at each upstream path (a re-pull's copy pins the object version).
  A tag not yet on the GitHub mirror, or a latest tag OpenNeuro cannot name, refuses with `[openneuro-mirror-lag]` before the dataset record is created.
  The classifier calls it `mirror_lag`; recovery quarantines it as `mirror_lag` rather than `not_found_dataset`, sends no mail and files no issue; the retry engine retries it and, once its 14-day window has passed, parks it as `mirror_lag` and files its one admin issue.
  A re-import of a released mirror whose upstream moved refuses with `[openneuro-upstream-moved]` before any reset, Simple Storage Service (S3) setup or push (#993); moving a released mirror is a re-pull's job.
  The tag `origin/main` records is read from its `SourceDatasets` entries naming the dataset's own `ds` (their `Version`, Digital Object Identifier (DOI) or uniform resource locator (URL), never NEMAR's top-level `Version`).
  The refusal names `nemar admin repull plan <id>` and the repair that passes the guard, `nemar admin import-openneuro <ds> --tag <recorded tag>`.
  An unreleased import is moved to the new tag instead, as a fast-forward of `origin/main` (`git reset --soft`), which drops `.github/` until finalize deploys it again; it is refused instead when origin's privacy ledger holds a recorded correction (ADR 0085), or an import scrub that changed git, whose originals origin's history still holds (ADR 0089).
  An unrecorded tag, or the same one, takes the same-version hard reset as before, and an unreadable or missing record is printed as a warning, because the guard cannot fire then.
  An origin whose `main` cannot be fetched now stops prepare instead of reading as a first import.
  The #1320 preflight compares the bucket's `annex-uuid` with the `nemar-s3` uuids the git-annex branch records, before the remote is configured, and refuses a disagreement with `[nemar-annex-uuid-conflict]`, both uuids and the recovery that fits.
  When the comparison is incomplete (Step 4b failed, git cannot read the branch, the bucket cannot be asked, or origin's git-annex branch records no `nemar-s3`), it warns and configures the remote as before.
  Recovery has no rule for `upstream_moved` or `annex_uuid_conflict`, so a failure usually quarantines the row by the dataset's state first; the retry engine's park, in both wordings of the annex conflict, is the backstop for a `failed` or `incomplete` row that carries one, and an operator restarts a parked annex conflict by hand after fixing the bucket marker.
  A refusal in a run that persists staging (the workflow's `--phase prepare`) clears the dataset's `staging/` prefix before it exits; the copy and finalize jobs still run under `if: !cancelled()`, and fail at once on the missing manifest instead of acting on one an earlier attempt left.
  A refusal also removes a work directory the run created, never one named with `--dir`.
  A first import, and a retargeted one, records the snapshot it mirrors as a `SourceDatasets` entry `{DOI: doi:10.18112/openneuro.<ds>.v<tag>, URL, Version: <tag>}`, all from the tag and kept in git; it is not written after a same-version hard reset, or when an entry already records a tag for the dataset, and an untagged entry naming the dataset alone is completed in place instead of joined by a second.
  The tag is read with Phase 2's parser, `sourceSnapshotOf`, by the guard and by the record alike, and a record that parser would not read as the tag (an entry for the dataset carrying another tag or naming another dataset too, or a tag such as `2.1.0-rc1` that is not numeric) is not written; prepare warns instead.
  DataCite gets one `IsDerivedFrom` for it, the DOI: the OpenNeuro page of the same dataset is not a second relation.
  Publication no longer adds upstream's `DatasetDOI` as a second source when it is the same DOI spelled another way, or another version of a dataset an entry already names (the parser's `isOwnSourceEntry`), so the recorded tag never disagrees with itself.
- **Phase 4 (#1910): which mirrors are behind upstream.**
  `GET /admin/upstream-status` (read-only, admin-only) puts each managed mirror in one of eleven states (`current`, `stale_ready`, `mirror_lag`, `stale_unverified`, `anomaly`, `unknown`, `not_examined`, `unpublished`, `in_progress`, `parked`, `unchecked`); upstream's creation order decides which tag is newer, not the number, and `unknown` is never current and never stale.
  `nemar admin upstream-status` walks it and exits 0 when nothing was unseen (stale is a finding, not a failure), 2 when the pass could not see, 1 when a request failed; `--measure` totals what a re-pull of each stale mirror would carry and estimates the DOI volume, and unknown is never counted as zero.
  The Monday import report gains `## Upstream freshness`, counts only, with no dataset named.
- **Phase 5 (#1911): `nemar admin repull plan <id>` plans a re-pull and writes nothing to the mirror, S3, D1 or the NEMAR Application Programming Interface (API).**
  It writes a plan file (mode 0600, under `$NEMAR_CONFIG_DIR/repull/<id>/`) identified by a digest, and prints counts and that file's location, never a path, key or content of the dataset.
  Exit 0 means executable, 3 that a plan was made and is not executable, 1 that nothing was planned.
  The one exception to "writes nothing" is the central workflow's unattended run, `plan --automatic-dispatch` (Phase 7): it reports its dispatch to the Worker, which stores `started` and then `refused` or `failed` if the run ends so.
  NEMAR's standard edits are recognized and re-applied as functions, never merged as text, and an unexplained path is a conflict or a correction.
- **Phase 6 (#1912): an administrator takes a re-pull from its plan to a released version.**
  A re-pull's state is a row of `upstream_repulls` (migration 0105; 17 states, one row per attempt, one open row per dataset), never `import_jobs`; outside production only `xx` datasets are re-pulled, and an anonymous dataset is refused with no override.
  `nemar admin repull execute <plan-file>` prepares the delta (scrubbed on its own paths, before anything is copied), copies the objects it needs at their pinned S3 `versionId`, registers them, pushes `release/vN.0.0` and opens the pull request; it never merges.
  `status` and `resume` take it on through the identifier screen, the gates, the release and the lock; the screen is bound to the row and the pull request's head (`upstream_repull_screens`, migration 0106) and its callback sends no mail.
  `merge` goes through one gate, which `nemar admin pr-reviews` shares for a re-pull's pull request: it reads the record, the review, the screen and GitHub's `clean`, ends the squash message with the two trailers, and claims one unit of `REPULL_DAILY_MERGE_CAP` before it merges, because every merge mints one version DOI.
  N.0.1 replays NEMAR's corrections after N.0.0 is merged and tagged (`--take-ours`, `--keep-upstream` for conflicts), `abandon` ends an open re-pull, `execute --supersede` replaces one for a newer tag, and `nemar admin exemplar create <xx> --source <on> --mirror <ds>` makes a staging rehearsal fixture.
  `bun run scripts/repull-canary.ts` checks the copy's S3 calls against the real buckets (a dry run unless `--execute`); it is a script in a checkout, not a subcommand, since the epic cleanup (#1976) moved it out of the shipped command-line interface (CLI).
- **Phase 7 (#1913): the automatic path, built and off.**
  `AUTO_REPULL_ENABLED` and `AUTO_REPULL_MERGE_ENABLED` are on only as the exact string `"1"`, and only in production; `REPULL_DAILY_OPEN_CAP` (default 2) and `REPULL_DAILY_MERGE_CAP` (default 5) read 0 when set to anything but one or two digits no larger than 20.
  `GET /admin/repulls/switches` reports what the Worker reads.
  A daily scheduler, which runs in production at 03:00 Coordinated Universal Time (UTC), dispatches the central workflow `run-upstream-repull.yml` for `stale_ready` mirrors within the open cap, at most once per dataset in 30 days and not before the first two re-pulls were run by an administrator; a 30-minute tick holds, gates and resumes the pull requests it opened.
  The unattended run plans once and hands the plan file to `execute` with a digest-checked handoff (the epic cleanup, #1976), opens the pull request as the GitHub App, `nemar-bot[bot]`, and never merges; its public log carries only counts and fixed words.
  The Worker merges only a machine-clean re-pull pull request the automatic path opened (zero unexplained paths, a `clear` identifier screen, Brain Imaging Data Structure (BIDS) validation and `version-check` green, an ADR 0107 review of that head that passes, the head equal to the screened commit, GitHub `clean`, the merge cap not exhausted), approves nothing, and a finish run then takes the re-pull to `complete`.
  An administrator may merge a re-pull they opened over a failed BIDS validation (`nemar admin repull merge --bids-failure-reason`, only while GitHub says `unstable` and no other check or status of the head fails); `resume` records the gates of such a pull request, which GitHub never reports `clean` while the validation fails.
  The ADR 0107 review admits one bot's pull request, the App's automatic re-pull, and only when the Worker starts it.
  The Monday report gains `## Upstream re-pulls`, `GET /admin/repulls/dispatches` lists the dispatches, and `nemar admin repull auto` shows the switches, the scheduler, the open automatic re-pulls (filtered by origin since the epic cleanup, #1976) and the recent dispatches.
  The dispatch record is migration 0112, numbered after `dev` took 0111 (the epic cleanup, #1976).
- **Phase 8 (#1914): documentation, the website contract and the typed field.**
  The public pages `platform/doi-and-versioning`, `platform/data-api` and `cli/guides/versioning` describe mirror versions and the `mirror` flag, and three gated runbooks cover freshness, the manual re-pull and the automatic path (the links are in `AGENTS.md` and `.context/README.md`).
  ADR 0111 gains its final amendment, and `dataPlaneVersionListingSchema` in `shared/contract/data-plane.ts` types `mirror` as an optional boolean that may be `null`, so a listing whose `mirror` is any other value fails the CLI's read.
- **Carried from `dev` by the epic's two syncs (#1979, #1981).**
  The GitHub App is `nemar-bot`, renamed from `nemar-publish-bot` (#1975); #1979 follows the rename in the epic, and the checks compare the numeric id as well as the login.
  A dataset held on an authenticated data host can be read with the CLI's own git-annex special remote, `git-annex-remote-nemar`, and its credential helper, `nemar auth git-credential`, and the API key goes only to origins on the CLI's own list (#1978; ADR 0114 is still proposed, so this ships ahead of its acceptance).
  `nemar dataset clone` also asks each listed data host when a signed-in user's lookup answers 404 or 400, and `--host` names the one host to read from. ADR 0107, which other entries here rely on, is also proposed.

### Production behavior changes

- **Every version in the data plane's landing JavaScript Object Notation (JSON) and the page bundle's `landing.data.versions` carries `mirror`:** `true` for an N.0.0 of an `on` dataset whose upstream tag is recorded, `false` for every other dataset and version, `null` for an N.0.0 of an `on` dataset whose tag is unknown or not yet examined.
  The tag itself is not on the public wire.
  `GET /datasets/:id/versions` (owner, collaborators, administrators) also carries `source_version` and `source_version_basis`.
- **`nemar dataset release` and `nemar dataset update --bump major` refuse a major version of a mirror** (an `on` id, or a row recorded as an OpenNeuro import), exit 1 before anything is cloned, and point at `nemar admin repull plan`.
  The rule is the CLI's only; the dataset repositories' `version-check` workflow is unchanged (ADR 0020).
- **The Monday report asks for attention when the scheduler waits for gate G4.**
  With the open switch on and the scheduler's last tick concluded `waiting-for-manual-run` (the first two re-pulls are not both run by hand to `complete`), the headline and `nemar admin import-weekly` name it as a reason, because a switch turned on early would otherwise change nothing and say nothing.
  With the switch off the section stays quiet.
- **Production ignores `OPENNEURO_GRAPHQL_URL`, unless it is a loopback `http` URL.**
  The staleness reader behind the report, the scheduler and `GET /admin/upstream-status` posts to OpenNeuro's own endpoint in production and in an unknown environment, whatever the binding says, a Worker secret of the same name included.
  Development, staging and test honor the binding.
  A loopback `http` address (`127.0.0.1`, `localhost`, `[::1]`) is honored everywhere: the test suites that run the production-only scheduler against a local stand-in use it, and a deployed Worker cannot reach one.
  `https`, and every other protocol, on a loopback host is refused.
- **`nemar admin pr-reviews approve --merge` exits 3 while a claim to merge is held.**
  A lost answer, or a merge GitHub did not make, keeps the claim and exits with the waiting code, as `nemar admin repull merge` does, so the same run again or `nemar admin repull resume` settles it.
  A refusal with no claim held exits 1.
- **A re-pull refuses a malformed bucket, region, dataset id, tag, version or commit id where it reads one.**
  The bucket and datacenter `remote.log` names for `nemar-s3` must be an S3 bucket name and an AWS region: `nemar admin repull plan` refuses (exit 1), `execute` and the release refuse as `nemar-s3-invalid`, and neither the annex-uuid read nor the bucket listing builds a host from one.
  A plan's dataset ids, tags, versions and its three commit ids must have the shape execution builds a URL, a ref, a branch name or an argument of git from, or `execute` refuses as `plan-schema`.
  The words name the field and the shape, never the value.
- **The staleness report and `nemar admin upstream-backfill` read version rows spelled `vN.N.N`.**
  The report used to ignore them: a mirror whose rows carry the `v` read as unpublished, so it was never compared or dispatched, and a newer `v` row lost to an older bare one.
  Both spellings are now read together and by number, and the version comes back bare.
  `nemar admin upstream-backfill --execute` therefore writes more rows than before, the ones spelled `vN.N.N`, each recorded on its own spelling (a dry run, the default, writes nothing).
  There is no migration, and no recorded value is rewritten.
- Imports that used to clone HEAD now clone the latest tag. On OpenNeuro's mirrors HEAD and the latest tag normally name the same commit, so most imports are unchanged; a dataset whose mirror carries commits past its latest snapshot is imported at the snapshot.
- A re-import of a released mirror whose `origin/main` records a tag, and whose upstream published a newer one, used to keep the old tree while copying the new tag's data (#993); it now refuses and parks. An unrecorded tag still takes the hard reset.
- The Monday import report gains `## Upstream freshness` and `## Upstream re-pulls`, and `nemar admin import-weekly` prints both.
  Against a Worker that predates this release the command prints them as unknown and exits 1.
- The production daily tick runs the re-pull scheduler and the dispatch watchdog, and the 30-minute tick runs the advance tick.
  While the switches are absent they dispatch, advance and merge nothing; they only stamp their own rows.
- New tracking-issue labels `mirror-lag` and `upstream-moved` on `nemarDatasets/.github`; GitHub creates a label the first time an issue carries it.
- **The publication Object Lock step reads a 403 back before it counts an object as locked.**
  A 403 from the retention write used to count as already locked, with no read-back.
  Now the object's retention is read with `GetObjectRetention`, and the object counts as locked only under GOVERNANCE or COMPLIANCE retention at least 50 years out; any other answer fails the step.
  The production Worker's identity holds `s3:GetObjectRetention`, so an object that is already locked still passes.
- **Deleting a dataset also deletes its re-pull records.**
  `deleteDatasetCascade` removes the dataset's re-pull rows, their screens and their dispatches, so a dataset deleted and re-created under the same id is not blocked by a stale open re-pull, and its re-pull history goes with it.
  Those rows are also the ledger that the daily open and merge caps, the 30-day spacing and gate G4 are read from, so a delete gives back that UTC day's cap units and resets the spacing; deleting `on003645` or `on004362` returns the scheduler to `waiting-for-manual-run`.
- **`nemar admin upstream-status --measure` estimates the days to re-pull every stale mirror at the open cap the Worker reports.**
  When the Worker reports its cap as unreadable (a malformed `REPULL_DAILY_OPEN_CAP`), it opens no automatic re-pull, so any catch-up never finishes until the binding is fixed; a cap of 0 set on purpose gives the same answer.
  Either way `--json` gives `catch_up_days: null` for such a catch-up.
  Only when the Worker's reading cannot be used (the call fails, or the answer does not parse) does the estimate use the default cap of 2, and it says so, with a warning on stderr.

### Deploy coupling

- The migrations are applied by the release's deploy; 0112 also seeds the scheduler's one row.
- `run-upstream-repull.yml` is authored at `.github/dataset-workflows/run-upstream-repull.yml`, and its byte-identical copy is on `main` of `nemarDatasets/.github` (`nemarDatasets/.github#148`, merged first; #1980 here makes the `unit-pure` tier compare the two).
  It runs only on a `repository_dispatch` of the type `run-upstream-repull`, which only the automatic path sends, so merging it turned nothing on.
- The onboard workflow change (`openneuro_tag`) shipped in 0.10.24 (#1933), with its copy in `nemarDatasets/.github`.
  `nemar admin import-openneuro --tag` in dispatch mode sends `openneuro_tag`, which an older workflow answers with 422; it is inert with an older Worker, and with an older CLI the workflow passes `--tag` only when the installed CLI's help lists it.
- The documentation pull requests (`nemarOrg/docs#90` and `#92`) merged before this release; the pages they add describe what the release carries.
- The `mirror` field reads `null` for every `on` N.0.0 whose snapshot is not recorded until `nemar admin upstream-backfill --execute` has run, and the website shows no chip for a `null`; the backfill runs after the deploy and the website is promoted after the backfill.
- No order is required between the Worker and the npm release for imports: a CLI released before its Worker refuses a mirror lag that the older Worker quarantines as `not_found_dataset` with a mail and an issue, and the new Worker's retry query keys on the marker in `last_error`, which recovery keeps, so it picks those rows up once deployed.
- The jobs of one workflow run install the CLI independently; mixing versions inside a run is harmless, because only prepare changed.

### Owner steps after release

None of these is done by the release.
The runbooks are [freshness](https://docs.nemar.org/admin/operations/upstream-freshness/), [manual re-pull](https://docs.nemar.org/admin/operations/upstream-repull/) and [automatic re-pull](https://docs.nemar.org/admin/operations/upstream-repull-automatic/).

1. Run `nemar admin upstream-backfill` (the dry run), then `--execute`, then `nemar admin upstream-status` (freshness).
2. Promote the website after the backfill, by the website's own release procedure.
3. Run the canary, then make a dry-run plan for `on004362` and `on003645` and review the counts (manual re-pull).
4. Re-pull those two by hand, either first as upstream's snapshots allow, and read the new version DOI's record: which relation it carries is not known until then (ADR 0111, Amendment 2026-10-27).
5. In a reviewed change to `backend/wrangler-sccn.toml` that also edits `backend/test/repull-switches-flag.test.ts`, turn on opening only (`AUTO_REPULL_ENABLED = "1"`, `REPULL_DAILY_OPEN_CAP = "1"`), read the first run's public log, then turn on merging (`AUTO_REPULL_MERGE_ENABLED = "1"`, `REPULL_DAILY_MERGE_CAP = "1"`), then set the caps from `nemar admin upstream-status --measure` (automatic re-pull).

### Known limits

- The manual-major refusal is the CLI's only; a major merged outside the CLI is not stopped.
- A mirror's recorded tag that upstream later re-creates under the same name is not detected: the staleness report compares tags, and a plan to the mirrored tag is refused as `nothing-to-pull` before any tree of upstream is compared.
  A target tag re-created after a plan has read it is caught: `execute` refuses with `upstream-tag-moved` before the copy, the registration and the pull request, and the record has to be ended with `abandon` and the dataset planned again.
- Most mirror repositories have no branch protection or ruleset (16 of 21 sampled on 2026-10-24), so GitHub's `clean` proves no check ran on them; the Worker reads the two checks itself.
- The merge cap binds NEMAR's tools, not the GitHub merge button.
- The Worker's merge has no staging rehearsal, because outside production only `xx` datasets are re-pulled and the Worker never merges one.
  Only the first production merge, under a cap of 1, shows whether the App's token reads `mergeable_state` as an administrator does and whether the dataset workflows tag the App's squash.
- ADR 0107's review may never pass a re-pull diff; until one passes, an administrator merges each re-pull.
- A re-pull with corrections mints two version DOIs, N.0.0 and N.0.1.
- The ADR 0111 amendment of 2026-10-27 lists, under "Not yet verified", what only the canary, the first two re-pulls, the first unattended run, the first Worker merge and the release with its first weeks can show.

## 0.10.25 - 2026-10-26

Production sends its mail through the Cloudflare Email Service, and inbound support mail is screened before it reaches anyone (epic #1893).
This release has one migration, 0111: two `ADD COLUMN`s with safe defaults (`mail_tickets.filtered`, `mail_queues.notify`), a new `mail_blocklist` table, an index on `mail_messages (from_addr, created_at)`, and a rebuild of the leaf table `mail_ticket_events` to allow the `unfiltered` event kind, in the same shape as 0107's rebuild.
It sets no new Worker secret.
The production Worker configuration sets `EMAIL_PROVIDER` to `cloudflare`, `EMAIL_FALLBACK` to `resend` and `MAIL_SENDER_HOURLY_CAP` to `20`.

### Changed

- **Production mail goes out through the Cloudflare binding (ADR 0110, #1966).**
  Sign-in codes, account mail and ticket replies are sent from `noreply@` and `support@nemar.org` by Cloudflare.
  A refusal for a quota or account-level reason is retried once through Resend; any other refusal is final, so a sign-in code is never sent twice.

### Added

- **Inbound mail is screened (ADR 0113, #1968).**
  A blocked sender, by address or by domain, is refused at delivery and never stored; a domain block is refused for our own domains, public suffixes and large shared mail providers, and a failed blocklist lookup accepts the mail.
  Bulk mail, mailing lists, automatic replies and bounces are filed as filtered tickets: stored and listed on request, never assigned and never announced, until a person works the ticket or the requester writes back.
  More than `MAIL_SENDER_HOURLY_CAP` messages an hour from one address are filed the same way, counted separately for mail that passed DMARC and mail that did not, so forged mail cannot silence a real sender.
  A queue can be made quiet, which stops its new-ticket notices; escalation notices still go out.
- **`nemar admin mail spam <id>` and `nemar admin mail blocklist`.**
  Marking a ticket as spam can block its sender, but only when the sender passed DMARC; an address block for an unverified sender needs `--force`, and a domain block for one is refused.
  `nemar admin mail queues set <tag> --notify <bool>` and the `--filtered` list option are new.

## 0.10.24 - 2026-10-26

NEMAR mail moves onto the Cloudflare Email Service in code, and the platform gains support tickets and `nemar admin mail`; production keeps sending through Resend (epic #1893).
This release has eight migrations, 0100, 0101, 0102, 0103, 0107, 0108, 0109 and 0110, all on new tables or additive (`CREATE ... IF NOT EXISTS` or `ADD COLUMN` with defaults); 0107's backfill and 0109's rebuild touch only `mail_tickets`, which this release creates, so they run on empty tables in production.
It sets no new Worker secret.
The production Worker configuration adds a `send_email` binding restricted to `noreply@` and `support@nemar.org`, a `MAIL_INBOUND` R2 bucket binding, the `EMAIL_OUTBOX` queue producer, consumers for the outbox and events queues with a dead-letter queue each, and the variable `MAIL_RETENTION_DAYS` (`730`); it does not set `EMAIL_PROVIDER`, and `REPLY_TO` changes to `support@nemar.org`.
The queues, the bucket and the sending onboarding of the domain have to exist before the deploy, or it fails on a missing resource; they were created and checked before this release.
One workflow changes: `onboard-openneuro.yml` gains an optional input, and it is deployed by copying it into `nemarDatasets/.github` (ADR 0020), and the copy there already matches this one byte for byte, which the parity test checks.
The dataset CI shims change in the backend template and reach a dataset repository only when that repository's workflows are next synced.

### Added

- **Sending selects its provider with `EMAIL_PROVIDER`, and a refusal can fall back to Resend (ADR 0110, Phases 1 and 2a).**
  `EMAIL_PROVIDER=cloudflare` sends through the `send_email` binding; unset, empty or `resend` is Resend, so production, which sets nothing, is unchanged.
  Any other value, and `cloudflare` with no binding, is a configuration error that sends nothing and never falls back.
  With `EMAIL_FALLBACK=resend` and a Resend key set, a send falls back to Resend once, only when Cloudflare refuses with a code that certainly sent nothing and that Resend can answer (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_ACCOUNT_SUSPENDED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`).
  A suppressed recipient, a validation or delivery error, a timeout and an internal or unknown error never fall back.
  Staging sends from `test.nemar.org` through the binding, never sets `EMAIL_FALLBACK`, and so cannot reach Resend; the delivery fence of the development Worker runs before either provider.
- **Announcements go through a queue when Cloudflare is the provider (Phase 2b).**
  `nemar admin notify` records the broadcast as `queued` and enqueues one message per allowed, de-duplicated recipient on the outbox queue, which the same Worker consumes.
  A redelivered message is never re-sent or counted twice (`broadcast_outcomes`, migration 0100).
  A rate or daily limit retries with a growing delay, other certain non-delivery is a failure with the address redacted, and anything that may have been accepted is counted unknown and never retried.
  `GET /admin/notify/:id` and `nemar admin notify --status <id>` read the counts, and a partial enqueue answers 200 with `queue_enqueue_failed`.
- **Bounces and complaints are stored (Phase 2c).**
  Cloudflare publishes `message.bounced` and `message.complained` for each sending domain to the events queue; the Worker stores them in `email_delivery_events` (migration 0101, one row per event id, no subject, the SMTP response clamped) and prunes rows after 180 days.
- **Inbound mail is kept in R2 and filed as a support ticket in D1 (ADR 0111 and ADR 0112, Phase 3a).**
  The raw message is stored in `MAIL_INBOUND`, parsed with `postal-mime` and filed in the tables of migration 0102.
  A reply threads onto its ticket by the `support+t...@` address, then by `In-Reply-To` and `References`, and reopens a closed or pending ticket; tags come from the recipient's local part and plus tag.
  Queues are `*` (the default, seeded to the `nemarAdmin` account) and the restricted `security` and `conduct`, which are never assigned automatically and are visible to owners only; a ticket hidden from an administrator answers 404 on every route, counts included.
  Assignment is `fixed`, `round_robin` or `pool` per queue, with away windows and an optional backup.
  A message that fails sender authentication, or has no passing result, becomes its own spam ticket: never threaded, assigned or notified, and never linked to an account.
  A failure after the raw copy is stored keeps the copy and logs one redacted line, and a raw key can be rebuilt idempotently.
  Demotion, revocation and soft delete release the person's open tickets, away setting and queue references in the same batch.
  No mail is auto-answered, and ticket notices go only to owners and administrators who have the new `support_tickets` notification preference on.
- **A ticket admin API under `/admin/mail` (Phase 3b).**
  It lists tickets (filters, keyset paging) and shows one, and replies, adds a note, assigns, sets status and escalates; it also serves `/admin/mail/queues`, `/admin/mail/availability` and `/admin/mail/reprocess`.
  A reply is sent from `support@` with reply-to `support+t<ref>@` and carries `In-Reply-To` and `References`.
  An optional `Idempotency-Key` on a reply returns the first outcome of a retried reply instead of sending twice, and an unknown outcome is never re-sent; a note takes the same key, stored once and replayed (#1945; keys in migration 0108, separate from reply keys in 0103).
  Migration 0103 also adds an escalation owner per queue, who must be an owner and is cleared by every revocation path.
- **`nemar admin mail` works tickets from the command line (Phase 4, #1940).**
  Subcommands are `list`, `show`, `reply`, `note`, `assign`, `status`, `close`, `escalate`, `queues` (list and set), `away` (show, set, clear), `reprocess` and `summarize`; `--json` is available on each, with the API body on stdout and `{error, code}` on stderr.
  `reply` and `note` always send an `Idempotency-Key`, print it before sending, and after a lost or uncertain send say to retry with it; a reply with no terminal and no `--yes` is refused and sends nothing.
  Exit codes are 0 for success, 1 for an API or network error, 2 for a usage error or a refused confirmation, 3 for a ticket that is not found or not visible, and 4 for an action the caller is not permitted to take.
  Users may be named as `me`, `none`, an id or a username.
  Ticket text comes from outside, so human output escapes every control and bidirectional character except newlines and tabs; `--json` stays verbatim.
- **Unread tickets are tracked per administrator.**
  A ticket is unread for an administrator when it has an incoming message newer than that administrator's marker, or no marker exists and it has any incoming message; replies and notes never make a ticket unread.
  Migration 0110 adds `mail_ticket_reads`, which the release cascade clears; the list carries `unread` for each ticket, `nemar admin mail list` shows it in a NEW column, and `GET /admin/mail/unread-count` counts the unread tickets the caller can see that are not closed or spam.
- **`nemar admin pr-reviews start` takes `--redo` and `--concurrency` (#1922, #1929).**
  `--redo` starts a commit whose review already has a result again, or with `--all` every open pull request whose current commit has a finished review; a running review is never superseded, and a blocked contributor's finished review is left alone (`contributor_paused`).
  A redo is a second run of up to two model calls, which the help and the `--all` question state.
  `--concurrency <n>` keeps at most `n` of the started reviews in progress at once, as a sliding window, because every review reserves its whole output budget against the workspace's rate limit when it begins.
  Ctrl-C stops an `--all` run after the request in flight, lists the pull requests never started and exits 130.
- **`onboard-openneuro.yml` takes an optional `openneuro_tag` (#1933).**
  The import is pinned to that upstream snapshot tag; `parse-ids` validates it and refuses it with more than one id, and `prepare` passes `--tag` only when the installed CLI's help lists it, so an older CLI imports as before with a warning.

### Changed

- **A ticket is kept for 730 days in production and 30 on staging, then reduced to a summary (Phase 6a, #1944).**
  `PUT /admin/mail/tickets/:id/summary` and `nemar admin mail summarize` write a summary, and `list --needs-summary` finds closed tickets without one; the Worker never calls a model, restricted tickets are never shown to one, and a summary containing an email address is refused (`summary_has_address`).
  A daily job, driven by `MAIL_RETENTION_DAYS` (missing or invalid deletes nothing), removes the messages, reply and note keys, non-queue tags, event details, subject, and the requester's address and account link of each ticket whose last message is older than the period.
  It keeps the id, queue, status, dates, summary and a conduct exclusion, closes active tickets, leaves spam as spam, never sends mail and never touches R2.
  The raw copies in R2 expire on the bucket's own lifecycle rule (730 days in production, 30 on staging), which matches the period.
  After a purge an action on the ticket answers 409 `ticket_purged`, a purged ticket's raw key cannot be reprocessed back into existence, and mail to its plus address opens a new ticket.
  The job joins the development cron allowlist and touches only that environment's own mail tables.
- **Tickets get three-word references, and reply errors no longer use 502 (#1952).**
  New tickets are named from the Electronic Frontier Foundation's short word list (`amber-falcon-river`) with the plus tag `support+t-<ref>@`; the earlier ten-character references keep working and are not rewritten (migration 0109 rebuilds `mail_tickets` so it accepts both, preserving every row and child row).
  Cloudflare treats `Message-ID` as its own, so a reply now sends only `In-Reply-To` and `References`, and the provider's id is stored only when it is a valid message id.
  `reply_not_sent` is now 422, `reply_delivery_unknown` is 409 and `inbound_not_configured` is 409, so the website's proxy keeps the JSON body; clients decide by `code`, and `ReplyResponse.header_message_id` may be `null`.
- **The dataset CI shims `bids-validation.yml` and `version-check.yml` run on `pull_request_target` (#1784, #1947).**
  A pull request from a fork got no secrets under `pull_request`, so the central validation was never dispatched and the check showed red.
  The job checks out and runs nothing from the pull request; it passes four checked fields to `nemarDatasets/.github` through `env`, where before a branch name was written into the script, and it checks the dataset id, the head sha and the pull request number before calling `gh`.
  Tests pin the safety properties, and ADR 0020 is amended; the change reaches a dataset repository only through the template sync, and until then its trigger is unchanged.
- **Continuous integration is faster.**
  `unit-pure` runs as six shards behind a gate that keeps the required check name and proves every classified file ran, and the migrated test database is built once per process.
  This changes only CI, not the product.
- **The staging test-account sweep also removes generated accounts with an open upload-access request, in batches of 300.**
  An account with granted upload access is still not swept; the sweep runs in non-production environments only.

### Fixed

- **The live test suites delete the accounts they seed.**
  They left them behind for the daily sweep to find.

### Production behavior changes

- **Reply-To on account mail becomes `support@nemar.org`.**
  Until the receiving cutover, that address reaches the same inbox as before through the existing catch-all.
- **No mail is turned into a ticket in production until the receiving cutover.**
  No routing rule targets the production Worker yet, so its `email()` handler is inert, and the new tables stay empty.
- **Sending stays on Resend.**
  The Cloudflare path is deployed but off in production; stored bounce and complaint events will be few or none until it is switched on.
- **The daily retention job runs and finds nothing to purge.**

### Not in this release

- The production sending switch to Cloudflare (#1895) waits on the sending-limit increase and a soak on staging.
- The receiving cutover (#1899) and retiring Resend (#1900) follow separately.
- The website's Mail tab ships in the website's own release.

## 0.10.23 - 2026-10-23

The dataset pull request review now reads a large change as an exact summary the platform computes, and protects what the original authors published.
This release has no migration, sets no new Worker secret or variable, and changes no workflow or Worker configuration; the review check is still not required (`PR_REVIEW_AUTO_REQUIRE` stays unset).
The review scripts run from `main`, so reviews dispatched after the merge run the new scripts while the Worker deploys; the Worker's only change is rendering one paragraph, and an older Worker renders the same reports without it.
The review prompt changed and the model calibration of ADR 0107 on the new prompt is not done; that is acceptable only while the check is not required.

### Changed

- **A modified table or sidecar counts as read when an exact change summary accounts for it (epic #1851, Part A).**
  The summary parses tables and JSON documents strictly, pairs rows, keys and renames by exact rules, and reports what changed as a few classes with counts, so a bulk pull request such as 125 tables with one edit no longer fills the model's context with 114 diffs.
  The model reads the summary beside the diffs it still needs, and a file counts as read only when every class in it that is not additive was shown completely.
  An unrelocated or unkept removal (rows, columns with values, or keys with values that the pull request keeps nowhere else) is a platform blocker on `no_degradation`, placed first in the findings; it can only lower a verdict, and a model cannot raise it.
- **The review protects what the original authors published (Part B).**
  A README or CHANGES line altered beyond a minor edit, moved or removed, a line put inside an original paragraph, an author-owned `dataset_description.json` field altered or removed, or a participant value changed fails `no_degradation`, with the codes `original_text_altered` and `original_field_altered` that 0.10.22 made the Worker accept.
  A replaced recording, a comparison that could not be made and an abandoned pass are `unknown` (`recording_replaced`, `evidence_incomplete`), never clean.
  Minor edits, text added after the dataset's first version, line endings, added fields and moved pointers are information for the model.
  The README is compared with the one at the dataset's first version tag (one `git ls-remote --tags origin` per review of a pull request that changes a README); when the lookup fails, finds no tag or finds no ancestor tag, every line at the merge base is protected.
  The check shows one paragraph under the findings of a report that has one of the two failing codes: contributors add to what the original authors published, describe the change in CHANGES, put new information in a new section, and ask an administrator to correct what the authors wrote.
- **The review prompt gained the change summary and the `original_content` facts.**
  The system prompt grows by about 4,000 characters, the longest message stays under the 300,000-character cap, and the model, effort and token ceilings are unchanged.

### Production behavior changes

- **The check of an open pull request changes the next time it is reviewed**, on a push, an edit, a reopen, a ready-for-review or an administrator start; nothing changes retroactively.
  Of the 129 dataset pull requests open on 2026-10-23, 107 are on public datasets, the only ones the Worker dispatches: measured with the real tag lookup, 79 read clear, 20 fail (three of them the platform account's own `Name` changes, which the Worker exempts), 5 are `unknown` only and 3 carry information.
  Merging a pull request that fails needs an administrator's `--force` in `nemar admin pr-reviews`, as for any failing review.
- **Contributors who rewrite original content now read "Needs changes".**
  An author who reworded or expanded original README lines, edited a participant value or changed a dataset name sees the failing finding and the paragraph above on the check.

### Not in this release

- The 400-name cut (#1861) and the small evidence additions (#1862) follow separately.
- The calibration tool cannot fetch private datasets online (#1884), the unit-pure job flakes on 5-second timeouts of unrelated backend tests (#1885), CI lint covers only `src/` (#1890), and two GitHub-view-only gaps of the hiding tripwire (#1883) are filed.

## 0.10.22 - 2026-10-21

The Worker's report parser now accepts three finding codes that nothing emits yet.
This release has no migration and sets no new Worker secret or variable.
It moves the Brain Imaging Data Structure (BIDS) validator from 2.4.1 to 3.0.2, which changes one dataset's publication gate verdict; see Production behavior changes below before releasing.

### Changed

- **The review report accepts `original_text_altered`, `original_field_altered` and `recording_replaced` (epic #1851, S0).**
  They are for the rules on what a contributor may change of the original authors' content, which a later release adds.
  The review script runs from `main` as soon as a release lands while the Worker deploys separately, so a script that emitted a code the Worker did not know would have its report refused as `report_invalid`.
  The codes are therefore accepted, labeled for the check ("Original text changed", "Original field changed", "Recorded data changed") and kept out of the codes the review model is offered, one release before anything emits them.

- **The BIDS validator is pinned at 3.0.2, and a monthly pull request moves the pin to the newest stable release (issue #1036).**
  The pin was 2.4.1, and the bump workflow selected only the 2.x line, so the pin could not move to 3.x by itself.
  The bump runs on the first day of each month, selects the newest stable release of any major version from the JavaScript Registry (JSR) metadata, skips yanked and prerelease versions, and runs the reference-dataset comparison before it opens its pull request.
  If the comparison is incomplete, the bump fails rather than opening a pull request, and the comparison is kept as a run artifact.
- **Every validation report names the validator release that produced it.**
  `nemar dataset validate` prints `Validator: @bids/validator <version>` after the validator's own text report, and adds a top-level `validatorVersion` key to the `--json` report.
  A report written with `--outfile` names the release in the same way: the key in a `--json` file, or a final `Validator:` line in a text file.
- **A validator run that fails is reported as a failure.**
  An exit other than 0 (valid) or 16 (errors found) is a failed run: `nemar dataset validate` shows the validator's own message and exits with its code.
  A report without a list of issues is refused rather than read as clean.
  The message for a failed run is written to stderr, not stdout, so a script that reads only stdout sees no error text.

### Production behavior changes

- **One dataset's publication gate verdict changes under 3.0.2.**
  The comparison covered 1,091 of the 1,093 datasets in the nemarDatasets organization. `nm000255` and `nm000256` crash under both releases, so neither could be compared.
  `on008837` passes under 2.4.1 and fails under 3.0.2 with 38 HED `SIDECAR_INVALID` errors: its events sidecar has a top-level `HED` key that holds a column description, which 3.0.2 rejects and 2.4.1 accepts.
  Its next validation refuses it until its sidecar is fixed or the rule is judged wrong.
  `on003004` already fails the gate and gains one HED error (`SCHEMA_LOAD_FAILED`): its events files have a HED column whose values are all `n/a`, with no HED version declared, and 3.0.2 requires a schema for that column.
  No other dataset's gating errors change.
- **Real git-annex links are read the same by both releases.**
  A link to a git-annex key, the layout real datasets have, gives the same gating errors under 2.4.1 and 3.0.2, and so does a pointer file.
  A link to no annex key is reported as broken, with its sidecar as orphaned, by 3.0.2 only. The comparison carries that layout as a detector, not as a layout that exists.
- **Under the upload preflight's flags, which keep warnings, 3.0.2 reports fewer warnings on six reference datasets.**
  The six are `nm000189`, `xx099905`, and `nm000104` to `nm000107`. The other six reference datasets report the same number of warnings under both releases, and no warning gates.

### Deploy coupling

- **Pushes and pull requests validate with the pin in each dataset's shim until the shim is rewritten.**
  The `bids-validation.yml` shim in each dataset repository sends the pinned release in its dispatch payload, and the central workflow in `nemarDatasets/.github` runs the release that the payload names.
  Sampled repositories still sent 2.4.1 when this release was prepared, so until a fleet sync rewrites them, their pushes use 2.4.1.
- **Revalidation uses the Worker's pin as soon as the Worker deploys.**
  `POST /admin/datasets/:id/revalidate`, which `nemar admin fleet revalidate` calls, sends the Worker's pin directly, so it validates with 3.0.2 whatever a shim says.
- **The browser validator is not part of this release.**
  The in-browser validation planned in website#161 pins its own release, so it has to move to 3.0.2 on its side, with a check against this repository's `validator-version.json`.

## 0.10.21 - 2026-10-20

The dataset pull-request review is given the room to finish, and a bulk edit that repeats one change across files is read once.
This release has no migration, sets no new Worker secret or variable, and leaves `PR_REVIEW_AUTO_REQUIRE` unset.
The review workflow's `timeout-minutes` is 50 in `nemarDatasets/.github` and in the source copy here, and has to be merged there before this release reaches `main`: the new script runs from `main` at once, and a 28-minute job would be cancelled in the middle of a long review.

### Changed

- **The review stage may use 128,000 output tokens, and a review that still runs out tells the author to split the pull request (ADR 0107, amendment of 2026-10-20).**
  On the first day of the shadow run seven of nine reviews on real pull requests ended `model_truncated` at 32,000 tokens, after about five minutes: the model's thinking at effort `max` filled the budget, not its input.
  The review stage's `max_tokens` is now 128,000, the most `claude-sonnet-5-5` allows in one answer; the screen stays at 32,000.
  The review's deadline is 30 minutes, the job's `timeout-minutes` is 50 and the Worker's `PR_REVIEW_DEADLINE_MINUTES` is 60, so a check can stay `running` for up to 50 minutes on a pull request that uses all its room, and the watchdog's wait for a review that never reported grows from 40 to 60 minutes.
  A review that still uses all of its room is `action_required` as before, now titled "Could not decide: split this pull request", and tells the author that the review used all its room and to split the pull request into smaller ones.
  A review costs up to about $1.28 of output, plus its input, when it uses the whole ceiling, and a pull request that truncates truncates again on each restart; the spend limit is the owner's to raise, and a bulk `pr-reviews start --all` reserves 128,000 output tokens per review against the workspace's per-minute limit.
- **A change repeated across many files is read once.**
  A changed metadata file whose diff is identical to one already shown, line for line and at the same lines, with the same mode, is counted on that diff and is not read again: it uses none of the file or character budget, and is covered by that diff when it was shown in full (a cut diff covers nothing).
  Before this, a sidecar edit made the same way in every subject filled the 40-file budget and left the rest unread, so `no_degradation` could not pass.
  The match is exact, so a change that differs in one byte, or names its own subject, is shown on its own, and a symlink or an executable is never one with a regular file; at most 500 files' diffs are examined, and, once the patches are full, the search stops early when the content pass is short of time, leaving the rest unread.

## 0.10.20 - 2026-10-20

The Zarr conversion that runs on `hallu` now pins biosigIO 1.2.13 and types the failures caused by missing companion data.
This release requeues nothing and leaves `ZARR_ENGINE_VERSION` at `3`. A dataset's stores are rebuilt when that dataset next runs: the drain rebuilds every recording with `--clean`, and a biosigIO change makes a published index non-current, so a pending retry round also rebuilds. A recording that converts again gets the new verdicts.
There is one migration, 0099 (`0099_pr_review_edit_limit.sql`), which rebuilds the `pr_reviews` table, adds the `edit_restarts` count (default 0) and the `edit_limit` word for the review gate below (#1846).
This release sets no new Worker secret or variable; it adds one optional switch, `PR_REVIEW_AUTO_REQUIRE`, which is left unset.
The Worker serves the index schema from one route, so the descriptions that route returns change on deploy.
The conversion changes run on `hallu` from this repository's `main` branch, not from the npm package.

### Changed

- **Zarr conversion pins biosigIO 1.2.13 (`>=1.2.13,<1.2.14`).**
  A BrainVision data file shorter than its header's `DataPoints` count is refused as `corrupt_or_truncated`.
  A BrainVision data file with no `DataPoints` count that ends in a partial frame now converts: the converter reads the whole frames, as 1.2.12 did, and records the dropped byte count in the store's recording metadata (`brainvision_dropped_bytes`). A cut inside the last frame of such a file is therefore read rather than refused. Vectorized data with a partial frame, and a file with no whole frame, are still refused.
  An EDF+C or BDF+C recording whose first time-keeping onset is not zero now converts, where it was refused as not EDF(+) or BDF(+) compliant.
  A truncated FIF read through `Recording.from_file` is typed `corrupt_or_truncated`, where it was `file_read_error`.
  A BrainVision cut that falls exactly on a frame boundary of a file with no `DataPoints` count is not detected; that is a known limit of the reader.
- **The duration backfill counts the same BrainVision frames as the converter (#1837).**
  `scripts/patch_duration.py` passes `allow_partial_frame=True`, as the converter does, so a file the converter stores gets the same duration.
  biosigIO ignores the flag for every other format.
- **Missing companion data gets a typed, terminal verdict (#1808).**
  A BrainVision header that names a data file the tree does not hold is `companion_missing`; a FIF file whose next split part is not in the tree is `split_part_missing`; an EEGLAB `.set` that stores epoched data is `epoched_recording`.
  These replace the `retry_exhausted`, `maxshield_probe_failed` and `file_read_error` verdicts that the same recordings used to receive, and none of them is retried.
  A host error raised while the reader recovers from a refusal keeps its retry: a refusal's code is read from the exception and its direct causes, never from its context.
  Discovery now lists tree paths with `-z`, so a recording whose name has non-ASCII bytes matches the header that names it.
  That widens discovery for those datasets. A dataset takes the new discovery when it next runs; the engine stamp, which this release leaves at `3`, governs requeues only.
- **The source copy of the dataset pull-request review workflow now matches the copy that dataset repositories run (#1820).**
  The review workflow runs the checkout, the Bun setup and the install after it mints the dataset token, and before it writes the token to the clone's configuration.
  The install uses `--ignore-scripts`, and the job timeout is 28 minutes, below the 40-minute watchdog deadline.
  The shared workflow repository already runs this body; this release brings the source copy in this repository to the same content.
- **The index contract says what a retry can change.**
  The `failure` description in `shared/zarr-index.schema.json` says that retrying in the same state will not change the outcome.
  The `failure_count` description excludes content that is not yet fetched locally from the failures that need a change to the data or the converter.
  The code list names `companion_missing`, `split_part_missing` and `epoched_recording`.
  This is a description-only change.
- **The unexpected-skip guard in `test.yml` exempts pytest expected failures (epic #1800).**
  A pinned known gap no longer fails the run as a skip; a real skip still does.
- **Dataset pull requests are screened on their content, and NEMAR owners and administrators are exempt from the model review by identity (epic #1813, merged as #1846; Architecture Decision Record (ADR) 0107).**
  The hourly, daily and platform caps and the automatic tally pause are removed, and the admin list shows a volume line in their place (#1815).
  The exemption also needs the login to hold admin on the dataset's repository, as GitHub reports it, and an exempt pull request shows its own queue verdict (#1814); the naming rule still applies to it (#1816).
  A title or a changed dataset name that cites an author and year, a Digital Object Identifier (DOI) or a naming-template token ends the review at the facts, before any model is asked (`shared/naming-rule.ts`; #1816, #1826, #1830).
  A pull request is reviewed again when its title or body changes, when its base moves onto `main`, or when it is reopened or marked ready; each head commit allows five such restarts, counted in `edit_restarts`, and a sixth is refused as an errored row with `detail = 'edit_limit'` (#1817, #1845).
- **The required review check has its switch in place, and the switch is off unless it is set to `1` (#1819).**
  The Worker reads `PR_REVIEW_AUTO_REQUIRE` as on only when it is `1`, and the repository does not set it.
  The switch gates publishing, visibility changes and `nemar admin fleet enforce`; `nemar admin fleet require-review`, for one dataset or a page, does not wait for it.
- **The command-line interface (CLI) no longer writes a placeholder pull request title or body (#1818, #1823; `src/lib/pr-text.ts`).**
  `nemar dataset push --pr` used to write "Update from branch X" and an empty body when given none, and `nemar dataset update` wrote a stock title and a file list that dropped the first letter of its first path.
  The CLI refuses text that cannot be read as a description of the change.
  In a script, `nemar dataset update` fails unless both `--message` and `--description` are given, and `nemar dataset push --pr` fails unless both `--title` and `--body` are given.
- **`nemar dataset update` writes its title into the dataset's change log as the new version's entry (#1823).**
  The entry goes into the change log the dataset already has (`CHANGES`, `CHANGES.md` and the like), or into a new `CHANGES` file if it has none; an entry the author wrote first is left alone.

### Known limitations

- This release requeues nothing; a dataset's stores change only when that dataset next runs (see the first paragraph above).
- Streamed export still raises an uncoded error for a truncated FIF (biosigIO #161) and for truncated KIT and 4D/BTi files (biosigIO #168), so those are retried until the retry budget runs out.
- In a local run, a git-annex pointer whose content was never fetched is a typed `file_read_error` that is never retried; whether it should stay retryable is open (#1812).
- A BrainVision marker that falls inside a dropped partial frame is not kept; the dropped byte count is in the store's metadata, not in the public index.
- A store whose recording metadata carries `brainvision_dropped_bytes` is refused by the scrub zarr stage until an operator names the member with `--allow-member`, as for the converter's other technical flags.
- A host read error during the MaxShield header probe is still recorded as `maxshield_probe_failed`, which is terminal (#1833).
- A short read of an EEGLAB `.fdt` caused by an I/O error is reported as a sample-count mismatch, which is typed `corrupt_or_truncated` (biosigIO #169).
- The review check is not required on any dataset yet, so a dataset pull request still merges without it until the owner applies the ruleset.
- Once a repository carries the review ruleset, an unset or `0` value of `PR_REVIEW_ENABLED` leaves its pull requests waiting for a check that nothing posts, and its merges stop; remove the rulesets before the review is switched off.

## 0.10.19 - 2026-10-16

A publication request now gets one derived verdict that is built by the Worker from the mechanical gates and a no-tools model review of the submission, and approving over anything that is not a clear pass is the administrator's recorded act (epic #1726, #1782; Architecture Decision Record (ADR) 0102 and ADR 0105).
**The review ships switched off in production.**
`PUBLICATION_REVIEW_ENABLED` is set in the dev environment's variables only and is absent from the production variables, so no review starts, no model is called and no approval waits for one until a later, reviewed change turns it on (see How to turn the review on).
Before releasing, check read only that production has no secret or variable of that name (see Deploy coupling).
What production does change with the flag off is the approval path around the review, and the list below says so item by item (see Production behavior changes): a web approval is attributed to the administrator who clicked by a per-claim token, a terminal approval takes a live web claim over, a denial is refused while an approval is running or once publishing has started, every cookie-authenticated write on the admin routes needs a NEMAR `Origin`, and the write that ends an approval no longer marks a closed request as published.
The release also carries four independent changes: a depositor can withdraw their own publication request (#1778, ADR 0104), `nemar admin publish list` shows the active requests by default and can search (#1777), a pending account can no longer hold a verified email and an owner can force-verify one (#1769, #1770, ADR 0103), and an owner can attest an Open Researcher and Contributor ID (ORCID iD) on an account (#1788, ADR 0106).
The dataset pull-request review was enabled in the production configuration on 2026-10-13 (#1768, merged to `main` after the 0.10.18 tag), and its prompt and evidence fixes from the first live run take effect with this release (#1771).
There are three migrations (0096, 0097, 0098) and no new Worker secret.
The only new Worker variable is the dev-only flag above.
The review's workflow lives in the central dataset-workflow repository and checks its script out of this repository's `main`, so the script reaches the workflow only when this release is on `main`; see Deploy coupling.

### Production behavior changes

With `PUBLICATION_REVIEW_ENABLED` off, which is what production runs after this release, the first list below is what changes, and none of it depends on the flag.
ADR 0102's Phase 2 amendment (item 3) and Phase 3 amendment (item 7) list these, and ADR 0105 records the attribution rule.

**Whatever the flag says (reaches production with this release):**

- A web approval is recorded under the administrator who clicked Approve, and only for a call that presents the click's token (ADR 0105).
  Before, any call inside the claim's fifteen-minute lease was recorded as the clicker, so a person at a terminal could be recorded as someone else (#1604).
  Now a terminal approval carries no token and is recorded as its own caller.
  Once it has passed every gate it takes a live web claim over, and the executor the click dispatched is refused at its next call (409 `dispatch_superseded`).
  A web run that sat idle past the lease is refused (409 `dispatch_expired`) instead of being recorded under the executing key.
- A call that carries the click's token may carry no decision of its own: an override, an identifier-screen acknowledgment, a skipped continuous-integration (CI) check or the sandbox is refused (409 `decision_with_dispatch_token`).
  `nemar admin publish approve` refuses `--force`, `--acknowledge-identifier-screen`, `--skip-ci-check` and `--sandbox` locally while `NEMAR_APPROVAL_DISPATCH_TOKEN` is set.
  On a non-production Worker a web-dispatched approval therefore cannot create a new concept Digital Object Identifier (DOI), because the sandbox is refused for it; run that approval from a terminal with `--sandbox`.
- A request that is `blocked` cannot be approved (409 `request_blocked`).
  The exception is a run that has already started publishing and was walked back to `blocked` because the owner's name went missing: it is resumed with `approve --resume`, and that resume passes neither the identifier screen's gate nor the review's gate, where the screen's gate used to run on it.
- `/approve`, `approve-dispatch` and `/deny` accept the `request_id` of the request the caller was looking at and answer 409 `request_mismatch` when it is no longer the newest active one (#1579).
  The command-line interface (CLI) sends it on every `approve` call and on `deny`; `--request-id` names it for a script.
- A request changed while its approval was being checked is refused (409 `request_changed`) instead of being overwritten.
- `/deny` is refused while an approval is running (409 `approval_in_flight`) and once publishing has started (409 `deny_after_publishing`), because the data may already be public and the depositor must not be told it was denied.
  A request whose first public step was only interrupted counts as started.
- The dispatch route checks the dataset id against the shape the executor accepts before it claims anything, and answers 400 `invalid_dataset_id` (#1583).
  Before, an id the executor would refuse held the lease for fifteen minutes.
- A failing executor releases its own claim through `POST /webhooks/approval-release`, authenticated by the dispatch token alone (#1582).
  Five early exits of `/approve` now record why in `last_error`.
- Every cookie-authenticated write on the admin routes needs a NEMAR `Origin`, or it is 403 `origin_not_allowed` (#1603, #1584).
  A request authenticated by an application programming interface (API) key is unaffected, and reads are unaffected.
  A server-side caller that sends the session cookie to an admin write without that header is now refused.
- The write that ends an approval requires the request to be still `approving`.
  A run whose request was denied after its lease lapsed, or blocked again, answers 409 `approval_closed_during_run` and writes the audit row `approval_finished_on_closed_request`; it does not mark the request published.
  A resumed run whose steps are all done follows the same rule and refuses before it runs any tail job.
  When a tail job warns in that all-steps-done branch, the request stays `approving` and the answer carries `status: "approving"` and the warning under the key `warning`, so approving again retries it.
  The step loop's own ending still marks the request `published` after such a warning (see Known limitations).
- `nemar admin publish` exits non-zero on every failure (#1581), where `approve` used to exit 0 when an approval failed.
  A declined or cancelled confirmation of `approve`, `deny` and `start --all` exits 1 too, because nothing was done.
  `approve` also exits 1 when the Worker's answer is not `published`, `screen` exits 1 when the Worker answers 202 with status `error`, and `next` exits 130 after Ctrl+C and 1 when an approval was refused or failed or a denial or comment could not be sent.
- The audit rows gain content: `dataset_published` carries `review_gate` (`enforced`, `off` or `n/a`) and `skip_ci_check`, and a run finished by a resume also carries `finished_by_resume` and, for a call under a token, `executed_by`.
  New rows are `publication_ci_check_skipped` (written when a CI check is skipped), `publication_request_commented`, `approval_dispatch_released`, `approval_finished_on_closed_request` and `publication_request_withdrawn`.
  `publication_review_overridden` is written only when the review's gate is enforced, so never with the flag off.
- An administrator can mail a depositor a typed message and leave the request open: `POST /admin/publish/:id/comment`, and `c` in `nemar admin publish next`.
  It is not behind the flag.
  The mail is a fixed frame around the administrator's escaped words and carries nothing of any review.
  A failed send is never answered as a success: 502 `comment_not_sent` says that certainly nothing was delivered, and 502 `comment_not_confirmed` says that the mail may have been accepted and may also have arrived, so the administrator is to check with the depositor before sending it again.
  Each reason in the review detail also carries an additive `line` field, the whole reason in the terminal's words; a client that meets a Worker without it falls back to the sentence and the cure.
- The `publication_reviews` table, the review watchdog on the 30-minute tick (production only, and it reads no flag), the review's callback routes (`/webhooks/publication-review-claim` and `/webhooks/publication-review-result`) and the administrator's start and detail routes (`POST /admin/publish/:id/review/start`, `GET /admin/publish/:id/review`) exist in production.
  With the flag off the claim route refuses a new claim so that no model call is spent, and the start route refuses with `review_disabled`.
- The fixture id `nm099997` is declared dev-owned, so production stops claiming pushes to a repository by that name before anyone creates it.

**With the flag off, what does not change:** no review is started, no model is called for a publication request, the identifier screen's gate and acknowledgment work as before, the administrator's mail does not wait for a review and has no review section, and the advisory pre-screen of ADR 0014 is still dispatched.
The Worker's approval gate reads nothing and passes (`off`), and any review a request has is shown as advice and gates nothing.

**With the flag on (a later change, not this release):**

- When the identifier screen reports for a commit and its gate is `clear` or `acknowledge`, the Worker starts one model review of that commit.
  The model is `claude-haiku-5-5` at high effort, with no tools and a schema-constrained answer.
  A depositor's requests may cost 5 model calls in 24 hours and the platform 50.
  An administrator's `start` is held by the platform's cap only, but the call still counts toward the depositor's tally.
- The model is sent the root README (the first of `README.md`, `README`, `README.rst` and `README.txt`), the keys of `dataset_description.json` that the Brain Imaging Data Structure (BIDS) defines, `CHANGES`, `LICENSE`, the column descriptions of `participants.json` and a structural summary of counts and closed words, after the shared mechanical rules have examined exactly the bytes being sent.
  It is never sent a table file, a recording, a signal header value, an identifier finding or the screen's result.
  For prose that pre-send check is a consistency control and not a privacy control: no rule recognizes a name, an email address or a date in prose, and the policy pages must say that a model reads this text before the flag is turned on.
- The verdict is `pass`, `fail` or `action_required`, derived from the report and the live facts, and unknown is never green.
  The administrator's mail waits for the review, up to its 30-minute deadline plus one 30-minute tick, and gains one section with the headline and reasons.
  The advisory pre-screen is no longer dispatched for a request the review covers.
- Approval over a non-pass needs `--force` (or the explicit confirmation in `next` and on the web page), is sent with the id of the review shown and the reasons shown, and is recorded as `publication_review_overridden`.
  A hard reason (`request_blocked`, `submission_minimum_failed`, `identifier_screen_blocks`, `identifier_screen_not_run`, `identifier_screen_stale`, `identifier_screen_pending` and `version_kept_after_anonymous_release`) refuses, whatever the body says, and names its cure; the screen's own reason needs the existing acknowledgment instead.
  Anything else refuses with 409 `publication_review_not_clear`.
- Nothing is denied automatically, and no Worker code path approves.
  The only status the review changes is the mechanical move of a `requested` request to `blocked` when the submission minimums fail at the reviewed commit.

### Added

- **A derived verdict for a publication request (#1782, ADR 0102).**
  `nemar admin publish list` shows each request's identifier screen, then the review's outcome and its reason codes on a line of their own.
  `show <dataset>` prints the screen, the outcome, every reason with what clears it, the four questions' answers, the findings under labels that say who wrote them, what the model was shown and what was withheld, the acknowledgment and the override on record, and the history.
  `start <dataset>` starts or restarts a review, and `start --all` takes the requests that can be started, oldest first, with `--dry-run`, `--yes` and `--json`.
  `approve` shows the screen, the review and the gate's state before it asks, and decides before it asks.
  `next` walks the requests that need a person, oldest first, one card each: `y` approves from the terminal, `n` denies with a typed reason, `c` mails the depositor a message, `d` shows the whole review, `s` skips and `q` stops; it takes `--force`, `--once` and `--dataset`, and it has no `--yes`.
  `deny` takes `--request-id` and sends the request's id.
  Every rendering ends with the standing line "Not assessed: whether the text names the depositors."
- **The administrator's approval page on the website shows the review (ADR 0102, Phase 4).**
  The page fetches the Worker's detail and prints the Worker's own words for each reason, and offers Approve with the same explicit confirmation as the terminal, Deny and Start review.
  The page's own words are declared once in `shared/contract/publication-review-copy.ts`, with a parity test against the website's copy that is strict in CI (#1787).
  Once the website is promoted, the page withholds Approve for a blocked request and when the screen's gate is `blocks`, `rerun` or `wait`, and it always asks for an acknowledgment reason when the screen's gate is `acknowledge`, with the review flag off as well, because the screen's gate applies whatever the flag says; with the review on it also withholds Approve for a hard reason.
  It offers no fallback to the old bodyless Approve: when the detail cannot be read or the API is older than the page, Approve is withheld.
  The website must be promoted to production only after the Worker that carries this release; see Deploy coupling.
- **A per-claim dispatch token (ADR 0105).**
  A web click's claim gets a token that is a hash-based message authentication code (HMAC) over the claim's own columns, signed with the callback secret the Worker already holds.
  The Worker stores none of it.
  The executor presents it as `X-Approval-Dispatch-Token` on every `/approve` call of its run and the CLI reads it only from `NEMAR_APPROVAL_DISPATCH_TOKEN`, in `approve` and never in `next`.
  Releasing, replacing, denying or taking over the claim revokes it.
  The CLI's `--debug` log redacts the `x-approval-dispatch-token` header, and the Worker never logs, stores or returns the token.
- **A depositor can withdraw a publication request (#1778, ADR 0104).**
  `nemar dataset publish withdraw <dataset-id> [--yes|--no]`, backed by `POST /datasets/:id/publish/withdraw`, ends the request as a withdrawn one with no administrator step.
  Only the dataset owner may withdraw (403 for anyone else, including an administrator, who ends a request with `deny`).
  It is allowed while the request is `requested` or `blocked` and nothing has started acting on it; it is refused with 409 `withdraw_too_late` when the request is `approving`, an approval is in flight, or publishing has started, and with 404 `no_active_request` when there is none.
  A withdrawal is stored as `status = 'denied'` with a new `withdrawn_at` column, so every reader that asks whether a request is finished keeps working.
  `publish status` keeps `status: "denied"` for older clients and adds `withdrawn` and `withdrawn_at`.
  Administrators are not mailed; the audit row `publication_request_withdrawn` is the record.
  A withdrawal that races an approval or a denial cannot both succeed: an approval that loses is told 409 `request_changed`, a denial that loses is told 404 for no active request, and a withdrawal that loses is `withdraw_too_late`.
- **`nemar admin publish list` takes state flags and a search (#1777).**
  The default is the active requests (`requested`, `approving` and `blocked`).
  `--requested`, `--approving`, `--blocked`, `--published` and `--denied` select states and combine, `--all` shows every request, and `-s, --status` keeps its old meaning and combines with the flags.
  `--search <text>` matches a substring of the dataset id, the requester's username or the dataset name, and lists an exact id first.
  A withdrawn request is listed wherever `denied` is in scope and is shown as withdrawn.
  `--needs-me` keeps the requests marked `*`, and `--json` prints the response and nothing else on standard output.
  The route `GET /admin/publish/requests` takes a comma-separated `status` and a `search`; an unknown status is a 400, and a search whose match pattern exceeds the 50 bytes D1 accepts (about 48 plain characters) is refused with a sentence, by the CLI before it sends and by the route.
  Omitting both still returns every request, so older CLIs keep working.
- **An owner can force-verify a pending account (#1770, ADR 0103).**
  `nemar admin verify <id>` (`POST /admin/users/by-id/:id/verify`) is owner only and takes a `pending` account to `verified` through the same transition the email flows use.
  It grants no upload access: approval remains the only writer of upload access.
  Two audit rows record it, the transition (`via: owner_override`) and `email_verified_by_owner`, which names the owner.
  The command exits 1 when the Worker refuses.
- **An owner can attest an ORCID iD on an account (#1788, ADR 0106).**
  `nemar admin users edit <account> --orcid <iD>` sets the iD and marks it verified without writing a sign-in record, and the audit row carries `orcid_attested: true`.
  It is refused, and nothing is written, when another live account holds the iD, when the account already holds an iD the person proved by signing in (`orcid_already_proven`), for an owner account or an owner editing their own, and when the same request edits a name that the verified iD would then own.
  The sign-in flow stays the only proof the person gives; an attestation is recorded as one, and a later ORCID link of the same iD only adds the sign-in record.
  `orcid_verified = 1` no longer implies a sign-in record, and every reader of the flag trusts an attestation as much as a proof.
- **`NEMAR_APPROVE_RETRY_DELAY_MS` (optional).**
  A whole number of milliseconds to wait between retries of an approval.
  It can only shorten the default wait, never lengthen it, and exists so a test of the retry does not sleep.

### Changed

- **`nemar admin publish list --json` now returns only the active requests by default (#1777).**
  A script that read every request from it, published and denied ones included, now gets `requested`, `approving` and `blocked` ones only, and `--all` restores every request.
  The shape of the output is the same, and `-s, --status` and the state flags select states as before.
  The route is unchanged: `GET /admin/publish/requests` without a `status` still returns every request.
- **Account copy says collaborating needs upload access and a verified email (#1769).**
  The sentences about upload access, and the help of `nemar auth request-upload-access`, now say that being added as a collaborator on someone else's dataset needs the same grant and that the email must be verified first.
  The website transcribes the account copy, and a drift test on each side compares them.
- **The dataset pull-request review is enabled in the production configuration (#1768).**
  `PR_REVIEW_ENABLED = "1"` is in the production variables, in the configuration file and not in the dashboard, because a deploy replaces dashboard-only variables.
  It was merged to `main` on 2026-10-13, after the 0.10.18 tag, so this is the first tag that contains it.
- **The pull-request review's prompt and evidence follow the first live run (#1771).**
  Files that differ only cosmetically (trailing whitespace, line endings, JSON that parses to the same value) no longer count as unread and no longer use the file-read budget.
  Changed metadata is shown grouped by path shape, with how many of each group were read, in an untrusted fence.
  The change log is checked for an added entry for the new version, and an old entry with the same number does not count.
  The prompt now requires a change log entry (`CHANGES` or `CHANGELOG`) for every new revision and fails `advances_revision` when the platform reports none was added; a log kept only in the README does not count.
  It also states that Hierarchical Event Descriptors (HED) annotations are additive, that moving identical values into a root sidecar by BIDS inheritance loses nothing, and that field names are judged against the dataset's declared `BIDSVersion`.
  The steering rule and the verdict derivation are unchanged.
  The workflow checks the script out of `main`, so this takes effect at the release.
- **The submission minimums moved to `shared/submission-minimums.ts`.**
  The Worker's request gate and the review job must not disagree about them, so both read one module and the Worker's file re-exports it.
  The checks and their sentences are unchanged, and the minimums remain hard blocks.
- **The README forms come from one list.**
  `shared/readme-candidates.ts` holds the four README names in the order `README.md`, `README`, `README.rst`, `README.txt`, and the submission gate, the anonymity sweep and the review read it.
  The submission gate used to try `README.txt` before `README.rst`; its ethics rule reads the first README present, so for a dataset that has both, the one it reads is now `README.rst`.
- **Admin list and approval commands moved out of `src/commands/admin.ts`.**
  The `publish` group now lives in `src/commands/admin-publish.ts` and its siblings; the commands' names and flags are as described above.

### Fixed

- **A pending account that changed its email address was stranded (#1769, ADR 0103).**
  Redeeming an email-change code stamped `email_verified` but left a `pending` account at `pending`, so `/auth/email/verify` answered `already_verified` and nothing could promote it.
  The email-change write now goes through the one transition from `pending` to `verified`, in the same batch as the address update, and administrators are notified once on the transition.
  Migration 0096 repairs the accounts already in that state and refuses it from now on (see Migrations).
- **The ORCID holder lookup no longer hides a different holder behind the account's own row (#1788).**
  The lookup that tells whether another live account holds an ORCID iD used to drop the account's own row after `LIMIT 1`, so a different holder could be hidden behind it; the exclusion is now in the query.
  It affects the conflict check of an ORCID link, a relink and the new attestation.
- **`nemar completion bash` works on bash 3.2 (#1781).**
  The script used `mapfile`, which needs bash 4, and macOS ships bash 3.2: there it was `command not found`, the candidate list was never split, and TAB offered nothing, with the error hidden behind the prompt.
  The script now reads the lines with a `while read` loop.

### Migrations

All three apply on deploy, before the new Worker, and are additive or repairing; none rebuilds a table.

- **0096_pending_cannot_have_verified_email (ADR 0103).**
  Promotes every live `pending` row that already has `email_verified = 1` to `verified`, with one `email_verified` audit row each (`via: migration_0096`), and installs the trigger `users_pending_email_verified_guard`, which aborts any UPDATE that leaves a live row `pending` with `email_verified = 1`.
  Between this migration and the Worker deploy the previous Worker's email change would abort for a pending account and answer `email_change_incomplete` with the code restored; it succeeds after the deploy.
  Upload access is untouched.
- **0097_publication_withdrawn_at (ADR 0104).**
  Adds the nullable column `publication_requests.withdrawn_at`.
- **0098_publication_reviews (ADR 0102).**
  Creates `publication_reviews` and its two indexes, one row per request, screened commit and kind of release, with CHECK constraints that keep a state from being paired with the wrong word.
  No foreign key, and no column is added to `datasets` or `publication_requests`.
- `bun run migrations:d1-check`, run on this release's `dev` in a clean worktree: all 100 migrations applied on real D1 (`wrangler d1 execute --local`), and the catalog matched `bun:sqlite` at 110 objects and 30 tables.

### Deploy coupling

- **Order: the API before the website.**
  The website's approval page withholds Approve when the API predates it, and has no fallback to the old bodyless Approve, so the Worker that carries this release must be deployed first and the website promoted after it.
  The page is on the website's `staging` branch; it is not in production until the website is promoted.
- **The executor workflow is already on `main`.**
  The change that carries the token through the run (`approve-publication.yml`, the central workflow repository's #136) merged on 2026-10-15, and it does nothing against a Worker that sends no token.
  The review workflow `run-publication-review.yml` (that repository's #137) is on its `main` too, and CI now compares the deployed copy with the authored one byte for byte (#1790).
- **The package publish and the Worker deploy are separate workflows, within minutes of each other, in either order.**
  Nothing enforces which comes first, so for a few minutes a new CLI can meet the old Worker.
  The new CLI behaves sensibly against either Worker for `list`, `show`, `approve`, `start`, `withdraw` and `verify`, and what the 0.10.18 Worker cannot do is this:
  - `list` shows the active requests, which that Worker cannot filter by a comma-separated status: when the union comes back empty the CLI asks once per status and merges the rows, newest first.
    That Worker never read `--search`, so the CLI drops the rows that do not match and lists an exact dataset id first.
    That Worker sent no dataset name and no review, so a search that matches only a dataset's name finds nothing on it, and no row shows a review line.
  - `show`, `start`, `withdraw` and `verify` cannot do anything on it, because it has none of their routes.
    Each says that the backend does not support the command yet and exits 1, `start --all` says the Worker is older than the review, and none invites a bug report.
  - `approve` works as it did: it finds no review, says so, and sends no override and no `request_id`, so that Worker has neither the stale-request check nor the review's gate.
  A new Worker answers the CLI's comma-separated list and its search itself, and the CLI changes nothing in its answer.
- **The attribution window of ADR 0105 is the other order: the new Worker with an old CLI on the executor.**
  The executor installs the CLI from npm, and a CLI without this release ignores `NEMAR_APPROVAL_DISPATCH_TOKEN`.
  Until it can install this release, a web approval is recorded under the executor's account and not the clicker's, and an approval that needed the clicker's recorded screen acknowledgment (or their override, when the review is on) is refused.
  Nothing is published wrongly, and the audit rows of `approval_dispatched` joined to the request's approver list the cases to read.
  Holding the Worker deploy until npm shows this version closes the window, and the pipeline does not enforce that.
- **The review script reaches the workflow only when this release is on `main`.**
  The workflow checks the script out of this repository's `main`, and its design forbids a ref chosen by the payload.
  Until then a review started by the dev Worker cannot complete, which is why the flag is dev-only and why the soak (#1732) runs after this release.
  The dev fixture `nm099997`, which the soak uses, is created only after this release.
- **No new Worker secret.**
  The review reuses the callback secret under its own domain tag, and the dispatch token is signed with the same secret; a Worker without it answers 502 `dispatch_unconfigured` before it claims anything.
- **Release checklist item, read only: confirm production is dark.**
  List the production Worker's secret names (never their values) and its variables, and confirm that nothing named `PUBLICATION_REVIEW_ENABLED` exists there.
  Production's pre-screen was once lit by a secret that the configuration file does not record, so reading the file alone does not show what is on.
- **New Worker variable: `PUBLICATION_REVIEW_ENABLED`, in the dev environment's variables only.**
  Do not add it to the production variables in a change that is not reviewed for it.
- **A rollback of the Worker alone is safe for attribution** in every combination of Worker, workflow and CLI that ADR 0105 lists.
  It does not undo the migrations: migration 0096's trigger `users_pending_email_verified_guard` stays, so the 0.10.18 Worker's email change on a pending account answers `email_change_incomplete` until the Worker is rolled forward again (ADR 0103).

### How to turn the review on

This is the record issue #1732 asks the release notes to keep.
It happens after this release, in a reviewed change, and ADR 0102's "Before it is switched on" is the checklist.

1. Read first: `nemar admin publish list` (the active requests, each with its screen), then `nemar admin publish start --all --dry-run`, which lists what would be started and starts nothing.
   `start --all`, the dry run included, refuses with "the automated review is off" when at least one request exists and every request reports the review off, and when no request can have its review started it prints "Nothing to start".
   So the dry run shows what would start only on a Worker that has the flag on, and on production before the flag it cannot run.
2. Create the review's own federation rule and service account and name them in the two organization variables `ANTHROPIC_PUBLICATION_REVIEW_FEDERATION_RULE_ID` and `ANTHROPIC_PUBLICATION_REVIEW_SERVICE_ACCOUNT_ID`.
3. Soak on the dev Worker with a native, named, private fixture that dev owns (`nm099997`, created after this release): a request that passes, one the model holds, one the identifier screen holds, one with a failing BIDS check, and one whose commit changes after the review.
   Never approve the fixture under a name.
4. Make the separate docs change that corrects the policy pages for current practice, then add the review's statement to them, so that they say a model reads the submission text.
5. Verify the attribution: the executor's workflow sends the token, and the staging audit query shows each web approval attributed to the administrator who clicked.
   Record the maintainer's decision on a click whose clicker is no longer an active administrator, which ADR 0105 leaves open (see Known limitations).
6. Add `PUBLICATION_REVIEW_ENABLED = "1"` to the production variables, delete the production pre-screen switch (find it by listing the production secret names, read only), disable `run-prescreen.yml` in the central workflow repository, and run `nemar admin publish start --all` once for the requests already open.
   The configuration file does not record production's pre-screen switch, which is a Worker secret, so deleting the secret is what turns the pre-screen off and editing the file would not.

### Known limitations

- The importer (`src/lib/import-publication.ts`) reports an approval as published when the Worker left the request `approving` after a tail job warned (#1773); the request is retried by approving again.
- A valid token whose clicker is no longer an active administrator falls back to the caller, as ADR 0080 decided, and the maintainer has not decided whether such a click should publish at all (ADR 0105).
  A token also survives the end of the clicker's session or key for as long as its claim stands and its lease is live, which is fifteen minutes after the run's last call, because every `/approve` call of an `approving` request renews the lease.
- A leaked token can cancel one run through the release endpoint, which checks no lease; nothing is published or lost.
- A request that has started publishing cannot be denied or withdrawn, and a queued web approval cannot be cancelled by `deny`; a way to stop a half-published run is a follow-up.
- A request filed again keeps its `steps_completed` (#1766).
- The review's pre-send check does not see a name, an email address or a date in prose, a `file:` URL, a drive path or a network path in the README, `CHANGES` or `LICENSE` (those files are scanned only for local-user paths, so `C:/Users/x` passes), or a lookalike that Unicode compatibility folding does not map to ASCII; the review is not asked whether the text names the depositors.
- The cure of a reason can say to start a review where the Start button is not offered (ADR 0102, Phase 4 amendment, item 7).
- The step loop's own ending, after a tail job warns, still marks the request `published` and tells the administrator to approve again, which finds no active request; a formerly anonymous dataset with more than ten concealed-era versions leaves a request `approving` for good because the warning recurs.
- The website's page has no control to run the identifier screen again; use `nemar admin publish screen`.
- A resumed Object Lock step restarts its listing at page 1 (#1580).
- `isAllowedOrigin` admits any NEMAR subdomain and local addresses (`localhost` and `127.0.0.1` on any port), so the Origin guard is defense in depth and not a boundary against a sibling subdomain.
- The identifier screen's block of a `requested` request does not clear a live claim, so a retained token verifies again after a re-request until its lease lapses; it carries attribution only.

### Repository process

Nothing here changes what the production Worker does, except that the owner-only delete route now calls a shared function for its masking and credential revocation (#1791).
The publication-review decision record is ADR 0102, as the 0.10.18 entry anticipated when it said ADR 0101 would be renumbered.
Two root-cause fixes to tests: the stringified-undefined environment values that polluted later test files are fixed at their sites and guarded by a static scan (#1783), and the flaky manifest memory, upload resume, email fence and EZID tests were each traced to a cause and fixed without loosening an assertion, including a loopback default for `Bun.serve()` so a macOS wildcard bind cannot be answered by an unrelated process (#1781).
CI now checks the publication-review page copy strictly against the website's `staging` copy (#1787, which also moves two live tests to an id that never resolves) and compares the deployed review workflow with the authored one (#1790).
A daily dev-only sweep tombstones the accounts the live integration tests leave in the development database (#1791, issue #1789): it matches only the generated test address shapes (the reserved test domain, plus one example.com shape), tombstones at most 100 per run, and never runs in production; the owner-only delete route's masking and credential revocation move into one shared function that both callers use.

## 0.10.18 - 2026-10-13

The Zarr conversion on `hallu` now runs several datasets side by side, so a dataset that takes days no longer holds up everything behind it (#1757, ADR 0101),
and its memory projection uses what a recording really needs: a 145 GiB float32 recording that was refused as too large now fits.
A text that names a generic home path before a real one is no longer passed by the identifier screen (#1737).
The rest is repository process with no change to what the Worker does: CI jobs are bounded, superseded pull-request runs are cancelled while push runs never are, the dev npm publish comes from a dispatch, the dev deploy is a call from `auto-bump-dev.yml`, the production deploy of the strip commit reuses the merge's test gate, and bot version commits skip Tests (#1755, which changes the release pipeline itself); pull-request review is capped at two rounds (#1748); and the review trial is recorded in the ADRs (#1747, with comment-only edits to two backend files).
There is no migration, no new Worker secret or variable, and no Worker behavior change.
The conversion changes run on `hallu` from the repository clone, not from the npm package; see Deploy coupling.

### Changed

- **Zarr conversions on `hallu` run in parallel slots instead of one dataset at a time (#1757, ADR 0101).**
  A cron tick now starts one drain per free slot (`ZARR_SLOTS`, default 4),
  each with its own lock, scratch directory and log, and four workers (`ZARR_JOBS_PER_SLOT`).
  A dataset that takes days, such as `nm000276` (40 recordings of 100 to 145 GiB, which held the only lock for 5.5 days while the node sat at a load of 1.1),
  now occupies one slot instead of the node.
  Slot 0 keeps the old lock and scratch names, so a drain already running counts as slot 0.
  The slots share one RAM and scratch budget through an admission ledger (`ZARR_LEDGER_DIR`, default `$ZARR_BASE/zarr-admission-ledger`):
  a peer's unspent reserves come off the ceiling and the budget,
  the run-alone exception applies only to an idle node,
  and a slot that waits an hour for its peers hands its queue back without spending an attempt.
  `ZARR_JOBS` now lowers the per-slot worker count and never raises it,
  so a crontab that still says `ZARR_JOBS=24` does not give every slot 24.
  `zarr_queue.py heartbeat` is new, and the script sends it every five minutes while a queue-claimed dataset converts,
  so a conversion longer than the six-hour stale window is not reclaimed by another slot's reconcile.
  A TERM to a slot or to the tick (or an INT to a slot run directly) stops the drivers it started and spends no attempt, and a stop that arrives just after a driver has finished still records the result.
  A one-off `--dataset` run takes the first free slot and refuses to start on a dataset another slot or run is converting.
  `--stats` no longer takes a slot, `--limit` now caps each slot rather than the tick,
  and counts such as `ZARR_SLOTS` must be plain decimal integers (`08` is refused, not read as octal).
  Set `ZARR_SLOTS=1` to run one drain at a time as before; the ledger, the heartbeat and the sample-width projection below stay in force.
- **The Zarr converter projects a float32 BrainVision recording at the memory it needs and measures anonymous memory (#1757).**
  When a recording's sidecar (sampling frequency and duration) and channel count show it is stored at four bytes per sample,
  the streaming projection is 8 times one channel's bytes instead of 12; every other recording projects as before.
  The 145 GiB `nm000276` recording that was refused as too large (about 32 channels, a projected 54 GiB against a 46 GiB budget) now projects at about 36 GiB and fits.
  Workers also sample `RssAnon`,
  and the "under-reserved" warnings compare the reserve with anonymous memory instead of resident size,
  which includes the scratch memmap's file-backed pages
  (on `nm000276` sub-48 the anonymous memory held at 6.2 GiB while the resident size passed 10 GiB).
  A recording refused before this change stays refused until it is converted again.

### Fixed

- **A real local account later in a text is now found even when a generic one comes first
  (#1737).** The local-user-path rule examined only the first home path in a text, so
  `/home/user/project` before `/Users/erin/data.csv` ended the check at the generic account and
  the real one went unseen. Every path is now examined, with the same single `review` finding
  per text. The upload preflight, the fleet scan and the identifier screen all share the rule, so
  a dataset that was reported clean only because of that ordering can now carry a finding.

### Deploy coupling

- The Zarr changes reach `hallu` only when its clone of this repository is updated: the hourly cron runs the clone's `hallu-zarr.sh`, and the clone is refreshed by a run that gets a lock.
  The drain that was converting `nm000276` before this release holds slot 0's lock and runs the old script, so merging does not by itself start the new slots.
  Update the clone by hand (`git -C /mnt/local/zarr-state/nemar-cli fetch origin && git -C /mnt/local/zarr-state/nemar-cli reset --hard origin/main`): that is what its `setup()` does on every run, and the running drain has already loaded its code.
- Register the old drain in the admission ledger before the next tick, so the new slots leave room for the recording it is converting.
  The file is `/mnt/local/zarr-admission-ledger/<driver pid>.json`:
  `{"v":1,"pid":<pid>,"start":<field 22 of /proc/<pid>/stat>,"reservations":{"1":{"ram":<bytes>,"scratch":<bytes>,"paths":["<its scratch directories>"]}}}`.
  The shape matters: a file without `reservations` as an object is taken for debris and deleted by the next driver to look, and the registration silently does nothing.
  The ledger removes the file when the driver exits.
  Without it the slots read the volume as nearly empty while the recording is still growing towards its peak.
- No crontab edit is needed: `ZARR_JOBS=24` is now a ceiling, and the default is four slots of four workers.
  `ZARR_SLOTS=1` restores one drain at a time.
- The ADR number 0101 is also claimed on the publication-review epic branch (`feature/issue-1726-epic-publication-review`), which renumbers when it merges.

## 0.10.17 - 2026-10-13

The website's server-side requests are counted per visitor instead of as one client, which is
the fix for the `/discover` 429 errors (#1709), together with a rate limiter whose windows no
longer slide, a modality filter that matches a whole token, a corrected check before an
administrator approves a pull request, a weekly drift check that can finally file its
issue, and an upload step that no longer re-reads tracked files of 1 GiB or more through
git-annex's filter process. The automated review of dataset pull requests stays off in
production, as in 0.10.16; its first live run passed on dev on 2026-10-12, with a throwaway
pull request to an exemplar dataset. There is no migration and no new secret. Counting per
visitor needs a second deploy: the website must be promoted to production after this release
(see Deploy coupling), while the fixed windows and the higher cap help the shared pool at once.

### Changed

- **The parity test for `run-pr-review.yml` now runs in CI against the deployed copy (ADR 0092).**
  The workflow reached `nemarDatasets/.github` `main` on 2026-10-12 (commit `fe7f821a`), so the
  `unit-pure` job's sparse checkout of that repository lists it beside `onboard-openneuro.yml` and
  sets `NEMAR_PR_REVIEW_WORKFLOW_LIVE` to it. Until now the test skipped in CI, because there was
  nothing to compare. With the variable set, a missing deployed copy fails the test, and so does a
  deployed copy that differs from `.github/dataset-workflows/run-pr-review.yml` by a single byte.
  A change to either copy now has to be deployed to the other in the same step, as it already
  had to be for the onboarding workflow. Step 3 of ADR 0092's "Before it is switched on" is done.

- **The anonymous per-IP cap is 1000 per window, up from 500 (ADR 0098).** It stays at 1000
  because the authenticated token cap is 1000 and a token holder must not be limited more
  strictly than an anonymous caller. `/mcp` shares this bucket, so its ceiling doubles with it.
- **Rate-limit counters are fixed windows (ADR 0099).** The counter used to rewrite its record
  with a fresh full minute on every allowed request, so the window slid, and a pool that never
  went quiet for a minute was refused for about a minute after every `cap / rate` seconds,
  whatever the cap; that is most of the 40 percent in #1709. The record now carries the window's
  end, a block ends where the window does, `Retry-After` is the seconds left and
  `X-RateLimit-Reset` is the window's end. One read, write and refuse path serves every bucket,
  including the data-plane miss budget, the private-grant budget and the observe-only path. A
  fixed window can admit up to twice a cap across a boundary, so the strict sign-in bucket can
  pass up to 20 requests across a boundary instead of 10; ADR 0099 accepts that, because the
  sign-in routes also limit per email.
- **Every answer says how the caller was identified, and browsers can read the headers (ADR
  0098).** `X-RateLimit-Caller` is `edge`, `site` or `unattributed` on every answer, including
  the admin-bypass answer and the private-grant refusal; `X-RateLimit-Bucket` values are
  unchanged. The rate-limit headers are exposed to browser callers on the nemar.org hosts and
  are kept on handler responses.
- **Limiter logs name who and where, once per window (ADR 0098).** Cache-fault lines are keyed
  by bucket kind, phase and error class, say how long ago the previous line was, and speak again
  at the 11th, 101st and 1001st call so a burst shows its size. Refusals are logged once per
  window per caller source, a caller identified by an address is named by source and reason and
  never by value, and token buckets write no identity line.

### Fixed

- **The website's server-side requests are counted per visitor, not as one client (#1709, ADR
  0098).** The website renders `/discover` and dataset pages on the server, so every visitor
  reached the API from the same few Cloudflare addresses and one per-address bucket was shared
  by all of them; when it filled, visitors saw "Could not load datasets" for minutes. The website
  will now call the Worker through a service binding and send the visitor's address in
  `X-Forwarded-For`. The limiter counts a request that has no `CF-Connecting-IP` and a valid
  first `X-Forwarded-For` address in a new `site-ip` bucket of 2000 per window, under a key a
  public caller can never produce, and `X-Forwarded-For` is never read when `CF-Connecting-IP` is
  present. A binding call with neither header now shares one `site-unattributed` bucket of
  20,000 per window instead of getting a fresh random bucket per request, which was no limit at
  all. The Worker's own in-process requests (an MCP tool reading `index.json`, the Neurobagel
  gatherer) are not counted by the data-plane counter or its miss budget, and are counted by
  their headers everywhere else. A forwarded visitor also gets their own ten sign-in requests
  (the address half of #1354). The strict, data, token and Neurobagel caps, the admin bypass
  and the development bypass are unchanged. To be honest about the number: a default Discover
  page costs 11 API calls (about 180 views per window) and the largest page the website can
  render costs about 101 (about 19 views), so capping what one page hydrates is the website's
  to decide. **Per-visitor counting waits for the website's promotion to production;** the fixed
  windows and the 1000 cap apply to the shared pool as soon as this Worker is released.
- **A stalled Cache API can no longer hang a request, and a failed cache write no longer demotes
  an admin (ADR 0098).** Every wait on the cache is bounded at 500 ms and fails open, including
  deferred writes and body reads. An admin the database had just confirmed keeps the admin
  bypass when the cache write fails or stalls, and a damaged cached admin flag is read again
  from the database and logged once per window.
- **The weekly summary.json drift check can file its issue.** The job has no checkout, so `gh`
  had no repository to act on. Of the 20 scheduled runs on record (the first on 2026-06-01), 19
  failed in the step that opens the issue and 1 in the step that reports a broken coverage
  endpoint, so no drift issue was ever filed and the one outage it should have reported went
  unreported. The job now names its repository. The label step creates the `drift` label if it
  is missing and no longer hides its errors; a failure there is visible in the log but does not
  stop the job, because a label that really is missing still fails the step that files the
  issue. Each existing-issue lookup is retried three times, five seconds apart, and still fails
  the step after the third failure instead of reading an error as "no issue", which would have
  filed a duplicate every Monday. A lookup also keeps only an issue whose title starts with its
  own prefix, so the probe-broken and report-broken issues are no longer taken for the drift
  issue. The backfill of 2026-10-12 cleared the 96 of 1303 versions that had no `summary.json`,
  so the first corrected run is expected to file nothing; dispatch the workflow once from
  `main` after the release to confirm that the job runs green. **This takes effect when it
  reaches `main`:** scheduled workflows run from the default branch, and this change targets
  `dev`.
- **The nightly dev-suite issue no longer files a duplicate when its lookup fails.** The same
  `|| true` pattern read a failed lookup as "no open issue", and the label step hid a real
  failure behind "already exists". The lookup is now retried three times and fails the step if
  it still fails; the label step warns in the log instead of going silent.
- **A test fails on a workflow `gh` call that has no repository, and CI runs it on a workflow-only
  pull request.** `test/workflow-gh-calls.test.ts` checks every workflow the repository ships, `.yml`
  or `.yaml`, and the per-dataset templates for a `gh` call with no checkout, `GH_REPO` or
  `--repo`, a swallowed issue lookup, a lookup in a step that does not stop on error, and a
  swallowed label create. A pull request that edited only a workflow used to run no job at all.
- **The `modality` filter matches a whole modality, not a substring (#1711, ADR 0032
  amendment).** `GET /datasets`, `GET /datasets/search` and the MCP `search_datasets` tool
  matched `LIKE '%eeg%'` over the comma-joined modality list, so `modality=EEG` also returned
  datasets that were intracranial only (`ieeg`), and a `%` or `_` in the value matched every
  row or any character. The filter now matches a whole token, ignoring case, and a space
  inside a token is part of it. **A partial name no longer matches:** `modality=ee` and
  `modality=mot` used to return datasets and now return nothing; use the full name (`eeg`,
  `motion`). A comma-separated value matches a dataset holding any of its tokens (it used to
  match only a list that held them adjacent and in stored order). A value that names no
  modality, such as whitespace or a bare comma, matches nothing. **At most 32 distinct
  modalities may be named in one request**; more is a 400 (a refused tool call on MCP) rather
  than a truncated list. Result counts for `modality=eeg` drop to the datasets that hold an
  `eeg` token, which is the count `GET /datasets/facets` reports. `task` and `author` are
  still substring filters. Adjacent fix: `GET /datasets/search` now sends `Cache-Control:
  no-store` on every response; it sent no `Cache-Control` at all, including on its 400s, which
  `GET /datasets` already sent as `no-store`. No migration and no deploy coupling.
  The CLI help, the MCP schema text and the OpenAPI description for `modality` say so too.
  To match both EEG and intracranial datasets, pass `eeg,ieeg`. An empty `modality=` is still no
  filter. A `modality` value of 49 or more characters used to return 500, because of D1's 50-byte
  `LIKE` pattern limit, and now matches nothing.
- **`nemar admin pr-reviews approve --merge` and `y` in `next` no longer approve a pull request
  they then refuse to merge (ADR 0093 amendment).** Both approved first and read GitHub's
  `mergeable_state` afterwards, and `y` was offered for every state but `dirty` and `behind`, so a
  pull request the automated review holds (its check is not required, so GitHub is expected to
  report `unstable`: a check or status that is not required is not passing or has not reported) was
  approved and left unmerged. The state is now read before anything is written, and again just before
  the approval is written: unless GitHub says `clean` (asked again while it says `unknown`; an
  unreadable or unrecognised state, a moved head and a pull request no longer open are not clean),
  nothing is approved or merged, the state or the failed read is named with why it blocks, and the
  way forward is given (approve without `--merge` for a state that will not clear, run the command
  again for one that may or whose head changed; in `next`, `s` skips it and a fresh run looks again).
  The second look narrows the window to one request and does not close it: GitHub has no
  approve-and-merge call. `y` is not offered for such a pull request, `--force` does not reach it,
  and `approve` without `--merge` is unchanged. The "clean only" rule itself is unchanged. A
  repository whose protection required an approving review would read `blocked` before the approval
  and is now refused; neither the ruleset applied to published datasets nor the classic protection on
  the four legacy repositories requires one.
- **A Cache API that keeps stalling no longer costs every API request half a second (#1715,
  ADR 0098 amendment).** Every rate-limiter wait on the cache was bounded at 500 ms with no
  memory, so while the cache stayed stalled each request paid the bound in each place it used
  the cache, the website's server-side renders included. Each Worker isolate now keeps a small
  breaker: three stalls within 60 seconds open it, an open breaker skips the cache at once for
  10 seconds, and then one probe closes it when the cache answers. Fail-open is unchanged: a
  skipped call is treated as a stalled one was, the request is served and not counted, and
  nothing is ever refused because of it. Counting can stay off on an isolate for up to 10
  seconds after the cache recovers. Skips are logged in the existing fault line as
  `CacheSkippedError`, and opening and closing each have a rate-limited line. No migration and
  no deploy coupling.
- **The rate limiter's observe-only warning no longer logs a reversible hash of the caller's
  address (#1713, ADR 0098 amendment).** Its `ipHash` field was a plain SHA-256 of the address
  (or of `site:<address>`), which anyone can reverse for an IPv4 address by trying every
  address. It is now an HMAC-SHA-256 under a key derived from the existing `ENCRYPTION_KEY`
  secret with HKDF, so it still tells one caller from another but a reader of the log cannot
  recover the address. A Worker without `ENCRYPTION_KEY` leaves the field out. The field keeps
  its name; its values change, so a pseudonym logged before this release does not match one
  logged after. No new secret, no migration and no deploy coupling. The same unkeyed hash is
  still stored with sessions and the device sign-in audit; that is tracked in #1733.
- **Tracking no longer leaves data files of 1 GiB or more for git to re-read through
  git-annex filter-process (#1704, ADR 0100).** `git annex add` stages an unlocked file without
  stat data, so the save, the first `git status` afterwards and the next upload's add each
  streamed it through `git-annex filter-process` again, and the add's check of files already in
  the index read each one twice. For data files of 1 GiB or more the tracking step now records
  the stat data with `git add --refresh` through git-annex's per-file clean filter, which
  answers from its inode cache without the file's content being sent. `filter.annex.process` is
  out of the repository's configuration only for one chunk of 100 paths at a time, under
  git-annex's own `filter.annex.process-temp-disabled` marker, and only when no other filter
  process (an empty one included) is set in any scope; it is put back after each chunk, on
  SIGINT, SIGTERM and SIGHUP, and at the start of the next upload, and a configuration that
  cannot be put back fails the step. Files under 1 GiB are tracked as before, so after a save
  that took the 1 GiB skip, the next upload still reads each of them twice; trees of many
  smaller files, the common EEG case, keep that cost. Measured locally with the threshold
  lowered to 100 MB so that 200 MiB files were primed, the bytes piped into the filter on a
  second upload to a 1.26 GB dataset fell from 2,517 MB to 1.1 MB; at the shipped threshold
  those files are not primed. Not measured on CephFS.

### Deploy coupling

- No migration, no new Worker secret or variable, and the automated pull-request review stays
  off in production. The keyed log pseudonym derives from the existing `ENCRYPTION_KEY`.
- **Release the Worker first, then promote the website,** so the first binding calls are counted
  in `site-ip` and the keying can be checked. Until the website calls through the service binding
  with `X-Forwarded-For` (nemarOrg/website, merged to `staging`), its visitors keep arriving from
  shared addresses and the `/discover` errors depend on the 1000 cap and the fixed windows
  alone. The order is not a safety gate: 0.10.16 counts a binding call by its raw
  `X-Forwarded-For` in the old `ip` bucket (cap 500, sliding), per visitor, so promoting the
  website first would be safe and only the website's own first-call check would warn.
- The keying cannot be read from the website's logs or from a browser: the website logs
  `remaining` once per bucket kind per isolate, and its proxy forwards no rate-limit headers. To
  check it before promoting the website, make calls for one visitor and one other from a
  throwaway Worker bound to `nemar-api` through a service binding (`X-Forwarded-For` set to
  reserved documentation addresses such as `203.0.113.201` and `203.0.113.202`), delete the
  Worker afterwards, and expect `X-RateLimit-Bucket: site-ip` and `X-RateLimit-Caller: site`, a
  first `X-RateLimit-Remaining` of 1999 that falls overall across six or more calls a second or
  two apart (the count is kept per data center, so an occasional repeat or small rise is
  normal), and the other visitor starting at 1999. The `[rate-limit] counting a request without CF-Connecting-IP by
  its forwarded visitor` line should appear and no "request with neither" warning. #1712 (demote
  that line) stays open until this has been observed.
- The weekly summary.json drift check runs from `main`, so its first corrected run is the Monday
  after this release. Dispatch it once from `main` after the release; it should run green and
  file nothing, because production coverage is 1303 of 1303.
- Check the fixed windows after deploy: `Retry-After` counts down within a window and
  `X-RateLimit-Reset` stays fixed until the window ends (the check ADR 0099 relies on).
- The CLI command reference on docs.nemar.org is regenerated for 0.10.17 afterwards: the
  `--merge` help of `admin pr-reviews approve` and the `--modality` help of `dataset list` and
  `search` changed.
- Watch how often the `[rate-limit] the cache keeps stalling` line appears after deploy; the
  breaker's three constants are the knob, and production stall rates are unknown.

## 0.10.16 - 2026-10-11

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

## 0.10.15 - 2026-10-08

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

## 0.10.3 - 2026-09-11

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
