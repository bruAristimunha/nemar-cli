# NEMAR CLI — Development Instructions

> Tool-agnostic project instructions for any coding agent (Codex, Cursor, Copilot, Windsurf,
> Claude Code, ...). Claude Code reads this via `@AGENTS.md` in `CLAUDE.md`.

**This file is the rules, not the reference.** What it still contains is the set of things that
can go badly wrong in THIS checkout and are not obvious from the code: which datasets are live,
which environment shares real users, what CI owns, and where decisions are recorded. Everything
that merely describes the platform now lives at `docs.nemar.org` and is linked below.

**Read the hard rules in full before you edit anything.** Follow a link when you are about to
touch that area.

This file used to be 669 lines, most of it a second copy of the documentation site. Two copies
drift, and this epic exists because they did (ADR 0057). If you are about to add a paragraph
here explaining how part of the platform works, that paragraph belongs on `docs.nemar.org`; add
a link here instead.

---

## Retrieval: how to read the linked material

Public pages need nothing: fetch the URL. **Every page also has a Markdown mirror**, which is
what to fetch if you are a program rather than a browser, and `https://docs.nemar.org/llms.txt`
indexes them.

The mirror sits at the page path with `.md` appended and **no trailing slash**: the tables below
spell URLs as `/cli/commands/`, and the mirror of that page is `/cli/commands.md`, not
`/cli/commands/.md`. Drop the slash before adding the extension.

```bash
curl -s https://docs.nemar.org/cli/commands.md
```

Pages under `/admin/` are gated: `nemarOrg/docs` is private at source and the gate admits the
`admin` and `owner` roles only (ADR 0056, ADR 0059). An admin holding a CLI key reads one
without a browser:

```bash
nemar admin docs admin/operations/systems-inventory
nemar admin docs admin/operations/validated-workflows cli/commands   # several share one session
```

That trades the stored API key for a fifteen-minute, read-only, documentation-scoped session;
the key itself never reaches the documentation host.

---

## If you cannot read something you need

**Open the issue anyway.** Losing read access must not cost you the ability to report a problem
(ADR 0057).

If you hit an admin-adjacent problem, or need a runbook you cannot open, file the issue on the
relevant repository, say plainly what you could not read and what you were trying to do, and tag
**`@nemarOrg/admins`**. Someone with access will either answer or open the page for you.

Escalation replaces read access. **Silence does not.** A blocked agent that stops without saying
so is the failure mode this instruction exists to prevent: the problem stays real and nobody
learns it exists.

---

## START HERE: Architecture Decision Records

**[`.context/decisions/`](.context/decisions/README.md) records what was decided and why.**
Read the index before designing anything,
and before "fixing" something that looks wrong —
several of the oddities in this codebase are deliberate, and the ADR says which.

- **Where an ADR and any other doc disagree, the ADR wins.**
  Design docs under `.context/` keep the analysis; the ADR is the verdict.
- **Never delete an ADR. Supersede it** (see ADR 0019 for what a superseded one looks like).
- **Write a new one** when a decision is expensive to reverse, closes off other reasonable paths,
  has been argued more than once, or encodes a constraint that is not obvious from the code.
  Copy `0000-template.md`, number sequentially, and add it to the index in `README.md` —
  a test enforces that the index and the files on disk agree.

Load-bearing ones to know before touching the relevant area:
0005 (partial data still serves), 0009 (dev D1 is not a prod mirror),
0010 (never client-stream an import), 0012 (archive size policy),
0016 (never hand-bump versions), 0020 (workflow edits hit ~785 repos at once),
0023 (`--clean` reconciles, it does not wipe), 0027 (Zarr discovery is raw-only),
0028 (MaxShield MEG is filtered or declined),
0029 (the Zarr conversion engine lives here, not in the Actions repo),
0030 (bounded streaming is the default; `.set` is the exception),
0031 (one annex policy module; `_motion.tsv` is data despite the extension),
0032 (facet filters are declared once and report what they exclude),
0033 (the queue stamps which engine converted each dataset; pre-stamp rows are declared current),
0034 (`datasets` stays one table under an enforced column budget; derive, don't store),
0040 (`verified` is the base tier; admin approval is the only writer of upload access),
0042 (upload access is requested once, by the person who wants it),
0043 (one person, one account: an ORCID iD, an email or a GitHub handle backs at most one live account),
0044 (identity self-service reaches the CLI; ORCID links through a browser handoff whose
signed state names the account),
0045 (the CLI and the web say one thing about an account),
0048 (account kinds are explicit: person, service, test; superseding 0045's role-based
ORCID-gap exemption),
0051 (a specific import error is never overwritten by a generic one),
0052 (an import-failure tracking issue closes on verified state, and a burst rolls up),
0053 (silence is only evidence of a problem when there was work to do),
0054 (the weekly import report arrives whether or not anything is wrong, and unknown is
never rendered as zero),
0060 (an imported tree is brought onto the annex policy in prepare: an inherited
`.gitattributes` outranks the configured policy, and stripping it without installing
ours annexes everything),
0062 (a missing git-annex degrades to an HTTP snapshot, and a snapshot is deliberately
not a repository),
0065 (anonymity is available before first publication and NEVER after; the blind lives in
`writeDatasetCatalogFields`, the one writer of `datasets.authors`, and decides from the
row -- never re-add a blind at a call site),
0066 (the data plane brokers git-tracked files and the manifest is the capability list:
the repository comes from the dataset row and never the request, the gate runs before the
token is used, and the cache is keyed by request URL and NEVER by blob SHA),
0067 (anonymity is verified on a schedule and reported, never repaired: it writes only
`sweep_stamps`, files no GitHub issue because `nemarDatasets` is public-facing, and a
check that could not run is `unchecked` rather than clean),
0068 (the top 100 ids of a band are reserved for standing test fixtures and the allocator
never returns one: real datasets grow upward, fixtures are assigned downward from
`nm099999`, and the reservation is not environment-fenced because the GitHub org is shared),
0072 (the data plane never reads a manifest whole: it streams it through a query that keeps
only its answer, its edge copy is trusted for 60 seconds and otherwise answers only after S3
says 304 for the copy's ETag because manifests are rewritten in place; the `manifest.json`
entry bound is now 38,000 for every dataset under ADR 0095),
0073 (a declared `.fdt` outside the raw tree is fetched for its `.set`, never discovered: only a
reviewed, verified declaration in `eeglab-fdt-declarations.json` pairs one, and any disagreement
refuses that recording rather than guessing the pairing by name),
0074 (superseded by ADR 0095; it previously selected public S3 or presigned URLs by bucket policy),
0095 (every served manifest `url` is its stable data-plane `bytes_url`; plain objects require
an exact-size HEAD, absent plain objects may use a bounded complete chunk set, and the
visibility/version/path gates precede storage access),
0081 (Neurobagel artifacts come from one pure transform over data-plane documents: identity only
from `metadata.json`, `anonymous` must be exactly `false` or the transform refuses before reading
anything else, ids are uuid5 under one committed namespace, and a fact the rules cannot establish
is left out and counted),
0082 (the Neurobagel node runs stock on a shared host under hard limits and is fed by pull, never
push: it executes nothing for the platform, and a service that needs more is a different decision),
0083 (curated Neurobagel annotations are a reviewed, content-pinned file: terms only from the pinned
vocabulary, a strict loader that fails closed, and a dataset with an entry is never converted
without it),
0084 (federation eligibility is one predicate decided from the D1 row and re-checked at every read,
with `anonymous: false` in the gathered metadata as a second independent guard; the writer is a hook
that never fails or blocks a flow and is off unless `NEUROBAGEL_WRITER_ENABLED` is `1`),
0085 (a privacy correction scrubs every version in place: new annex keys, DOIs and version numbers
kept, old versions deleted by version id, and a public ledger of counts and fixed words that never
holds a value),
0086 (a publication request is screened for identifiers by a CI workflow bound to a commit, the
admin mail waits for the verdict, and `unchecked` is never treated as clean),
0087 (`nemar dataset upload` screens locally before anything is sent and refuses direct
identifiers with no override; what it records is a note, never a verdict the server trusts),
0088 (published datasets are re-screened on a cycle that does not depend on the verdict, and the
weekly report says what was not screened; it reports, never repairs, and files no issue),
0089 (an import scrubs the clone before it copies or pushes and finalize waits for the screen; a
held import is not a failure),
0090 (an acquisition date finer than year and month is a review finding that warns and never
gates, and nothing already published is rewritten),
0091 (a new recording's day-level acquisition dates are set to 1 January of their year on upload
and import, and nothing already published is changed),
0092 (only active, named, public datasets with `first_published_at` set reach the model and that
eligibility is rechecked atomically at claim; the verdict is derived from the report and from git
facts and never read from the model, unknown is `action_required` and never green, the latest
Worker-recorded delivery is checked atomically with the one-shot claim and the workflow checks the
GitHub head before the model call, an unsettled claim is closed as `stale_head`, a dispatch failure
cannot erase an already claimed run, each Actions run has a unique concurrency group, and the
Anthropic identity is minted only in `nemarDatasets/.github`; a contributor is paused after more
than 5 rejected pull requests AND
more than 10 percent of their decided ones).
0093 (`nemar admin pr-reviews` lists the open dataset pull requests with the automated review: a verdict
belongs to the commit it read, an approval is the administrator's OWN act from their machine with their
own GitHub login and no Worker code path approves, a failing, running or unreadable review needs
`--force`, nothing merges without `--merge` or a `y` in `nemar admin pr-reviews next`, and each
Worker lists only the datasets it owns).
0094 (the upload save step skips re-reading annexed content only once recorded annexed bytes reach
1 GiB, only for files whose size and mtime still match the upload plan, and only while it can clear
`assume-unchanged` safely; failures to verify or clear the state fail the save).

**Account copy and the profile-gap matrix are declared once, in
[`shared/contract/account-copy.ts`](shared/contract/account-copy.ts) and
[`shared/contract/profile-gaps.ts`](shared/contract/profile-gaps.ts)** (ADR 0045).
Every sentence about tiers, upload access or a missing field comes from the first;
`computeProfileGaps` in the second is the ONE rule behind `profile_gaps` on
`GET /users/me`, `profile_gaps` on `GET /auth/me`, and the `missing` array a refused
upload-access request carries. `nemarOrg/website` transcribes both files and a drift
test on each side compares them when both checkouts are present. Change a sentence or a
rule there, never at a call site; `cli.`-prefixed keys are the CLI's own and the website
ignores them.

---

## Hard rules

### Live datasets

**`nm000103`-`nm000107` are LIVE.** Do NOT modify their visibility, S3 data, DOIs,
or repo settings during development or testing.
All five are PUBLIC and carry minted DOIs (verified 2026-09-14: public on GitHub and
`visibility: public` in the catalog). An earlier version of this line said they were kept
private during dev; that has not been true since they were published, and it is the kind of
stale fact that makes someone think a mistake is safe to make.

For end-to-end testing use `nm099999`, created on demand via
`POST /admin/datasets/nm099999/reset` (lazily created if missing):

```bash
nemar admin e2e-test --verbose      # reset, upload, clone, download, update cycle
nemar admin e2e-test --skip-reset   # reuse existing nm099999 state
```

The 10-step pipeline lives in `src/lib/e2e-test.ts` and sources
`test/fixtures/bids-minimal/`. `xx`-prefix datasets are blocked from publishing.

### Dev D1 shares production users and the GitHub org

`nemar-db-dev` no longer mirrors production's dataset catalog — it was purged to the curated
fixtures only (the eight `xx0999NN` exemplars plus the private E2E dataset `nm099999`)
and must stay that way. **Do not re-seed production `nm`/`ds` rows into dev D1.**

But the `users` table was **not** purged: it still holds roughly 609 real email addresses,
and the dev worker holds a live `RESEND_API_KEY`.
The `nemarDatasets` GitHub org is also **shared** between prod and dev, since the org name is
hardcoded rather than environment-scoped.
So a dev-side job that selects users by a generic predicate can still email real people,
and a cascade delete can still destroy a real repo.
The catalog purge removed one blast-radius vector; it did not remove the reason these fences exist.

Admin-facing notification mail (new-user approval, upload-access and publication requests,
import recovery, cron digests) is production-only by default,
via `getAdminEmailsForCategory`'s fence in `backend/src/services/email.ts`.
Set `DEV_ADMIN_NOTIFICATIONS=1` only for a deliberate staging test of admin mail.
The dev worker's `DEV_EMAIL_ALLOWLIST` is a Worker secret holding exact human addresses, never a domain:
`@nemar.org` has a catch-all that lands in a real inbox, and `@nemar.test` fixtures get their sign-in codes echoed in the response instead of delivered.

`users.account_kind` (ADR 0048) is explicit on the seeded fixtures: `test-owner` and `test-admin`
are `service` (operational, no human signs in to them directly); `test-user`, `test-pending`,
`test-verified`, and `test-revoked` are `test` (a persona, not a real identity); `test-web` stays
`person`: it is the shared web-QA account and has to reach the ORCID authorize page and the
Settings key form the way a real person would.

**A new daily cron job is production-only BY DEFAULT.** The dev cron is governed by a fail-safe
allowlist in `scheduled()`. Before adding a job to the non-prod set, confirm it cannot email a
real user, dispatch GitHub work against `nemarDatasets`, or mutate a real DOI or prod-bucket object.

Authentication against staging never uses production keys: use `TEST_ADMIN_API_KEY` from
`test/.env.test` — it matches the `test-admin` token seeded by `scripts/seed-dev-db.sql` —
with an isolated `NEMAR_CONFIG_DIR`, so the real `~/.config/nemar` is untouched;
`TEST_OWNER_API_KEY`, the seeded `test-owner` token, is its owner-role sibling.

### Two names that look like bugs and are not

**`ORG_NAME = "nemarDatasets"`** in `backend/src/services/github.ts`, and the publishing scripts
targeting `nemarDatasets`, are correct. Two GitHub orgs is deliberate: `nemarOrg` holds tooling
and infrastructure, `nemarDatasets` holds dataset repositories only. **Do not change these to
`nemarOrg`.** In a two-org codebase this reads as a typo, which is exactly why the warning is
here rather than left to the reader.

**EZID is the DOI registrar, not Zenodo** (ADR 0007). `.context/research.md` describes a Zenodo
flow and `docs.nemar.org/develop/zenodo-testing/` documents Zenodo sandbox testing; both are
prior art and test tooling, neither is the production path. A DOI change made on the strength of
either is wrong.

### Revocation cascades, always

Ending a credential has to end everything minted from it. API tokens are tied to a GitHub PAT
and per-user S3 credentials, and an API key can also mint a docs session
(`POST /auth/docs/cli-session`), so every route that revokes keys without ending every session
calls `revokeDocsCredentials`; the three that revoke keys and end the docs credential in their
own batch (a role demotion, `finalizeRevocation`, the owner-only soft delete) do not need it.
Two host-scoped session kinds hang off the app session: `docs` (ADR 0056) and `private`, held by
the private site (`private.nemar.org`, ADR 0079) and reached only through the `NemarApiRpc`
service-binding entrypoint (ADR 0078). `services/docs-auth.ts` and `services/private-auth.ts`
each name the callers of their revoke and grants-purge statements and say a new path that ends a
credential needs the lines too; those counts are load-bearing, so add yourself to them rather
than assuming someone else did. A role demotion and an API key revocation deliberately leave
`private` sessions alone; `PRIVATE_REVOKE_ALL_SQL` says why.

### Never hand-bump the version

`package.json` version is owned by CI. Do not edit it, and do **not** run
`./scripts/bump-version.sh` before a dev → main PR — a manual bump desyncs the tag,
the version, and the npm release. See ADR 0016 and the release section below.

### Work in a worktree

Do not edit the primary checkout directly; concurrent sessions share it.
Branch into a worktree first: `git worktree add <path> -b <branch> origin/dev`.

### Dataset ID bands

All inside the 0-99999 cap, so `xx900001` is invalid.

| Band | Range | Purpose | Cleanup |
|---|---|---|---|
| Pre-allocator `nm` | `nm000001`-`nm000107` | predate `START_NUMBER`; `nm000103`-`nm000107` are LIVE | never |
| Real datasets | `nm000108`-`nm099899` | allocated upward by `generateDatasetId` | never |
| **`nm` fixtures (reserved)** | `nm099900`-`nm099999` | standing test fixtures, assigned by name | **never** |
| Prod sandbox | `xx000001`-`xx089999` | real user sandbox training | 14-day cron (prod) |
| Dev ephemeral | `xx090001`-`xx099899` | throwaway dev/e2e | dev cron |
| Dev exemplar fleet (reserved) | `xx099900`-`xx099999` | curated persistent copies | **never** (`is_exemplar=1`) |

**The top 100 ids of each allocating PREFIX are RESERVED and the allocator never returns
one** (ADR 0068): `nm099900`-`nm099999` and `xx099900`-`xx099999`. This is a property of
the prefix, not of each band in the table above, so the top of the prod sandbox band
(`xx089900`+) and of the dev ephemeral band (`xx099800`+) are allocated normally.
Real datasets grow upward from the prefix's start; standing test fixtures are assigned
downward from `nm099999`, so a fixture's id is predictable without a registry. In use
today: `nm099999` (end-to-end, its own reset endpoint), `nm099998` (the standing anonymous
deposit, dev-owned) and the `xx099900+` exemplar fleet; `nm099997` is next.
The FLOOR of the `nm` band is spoken for in the opposite direction: `nm099900` is
`ABSENT_DATASET_ID`, the id live tests rely on never resolving. It must never be declared
dev-owned and a downward assignment must never reach it. Four live tests used `nm099998`
for that purpose, each commented "unlikely to be allocated", and building the fixture on
that id turned all four red at once.
Reserved means not *allocatable*, not invalid, so `isValidDatasetId` still accepts these
and every route must still serve them. A fixture is created by NAMING its id on
`POST /datasets` (`dataset_id`), fenced by `explicitDatasetIdGate` on FOUR terms, all of
them required: non-production, an admin, the reserved band, AND the id being declared
dev-owned in `DEV_OWNED_FIXTURE_IDS`. The fourth is the one a new fixture hits: ADR 0068
names `nm099997` as the next standing fixture, and creating it is refused until it is
declared, because an undeclared fixture is invisible to the dev worker and claimed by the
production one. It narrows the route's
"non-production forces sandbox" rule without weakening it: that rule exists to stop dev
minting a REAL `nm` id, and a reserved id is one the allocator can never mint for anybody.
Naming an id exempts nothing else, so the account gates still apply and an operator who
cannot pass them is not the right operator. The reservation is **not** environment-fenced:
`nemarDatasets` is shared between prod and dev, so a prod-minted fixture id would collide
with a dev fixture's repository. `on` ids are mirrored from OpenNeuro and never allocated
here, so they have no reserved band.

**The exemplar fleet is permanent, not ephemeral.** Seven curated `xx0999NN` copies of real public
datasets (`scripts/exemplar-fleet.json`) cover eeg / ieeg / emg / meg / multi-modal / HED,
published with **sandbox** EZID DOIs (`10.5072/FK2`, never the production `10.82901` shoulder).

> **The fleet no longer has an anonymous deposit (#1433, ADR 0068).** It had one at
> `xx099907`, and that placement was the mistake ADR 0068 exists to prevent: `xx` publishes
> only through the exemplar exception, while an anonymous deposit's defining event is an
> anonymous RELEASE, so the one path the fixture needed was the one path its band refuses.
> Keeping it there meant widening a publish gate, which is what #1428 did and #1433 undid.
>
> What is true NOW: `scripts/exemplar-fleet.json` declares seven entries and the loader
> **refuses** an `anonymous` key outright. `isExemplarPublishAllowed` refuses an anonymous
> exemplar in every direction; there is no longer a way to ask. The clone tool does not
> blind `Authors`.
>
> `xx099907` is RETIRED (#1434). No dev D1 row, no `nemarDatasets` repository; both
> verified 404 on 2026-09-17. The standing anonymous deposit is now `nm099998`, described
> in full below.
>
> Two seams the previous text promised are closed, recorded because someone reading the
> old paragraphs would still expect them: `POST /datasets` takes `dataset_id` and the CLI
> sends it (`nemar dataset upload --dataset-id`), so a fixture's create is no longer an
> out-of-band API call; and `POST /admin/datasets/exemplar` REFUSES `anonymous: true`
> with `exemplar_anonymous_retired`. That field is still declared, deliberately: zod
> strips an unknown key, so deleting it outright would take `anonymous: true` from a
> caller who means it, create a NAMED exemplar, and report success.

Their `active`/`public` state lives in D1 and is the source of truth for the staging catalog;
it does not depend on the registrar.
The only thing that lapses is EZID's sandbox shoulder, which purges DOIs after about two weeks,
so re-mint with `nemar admin exemplar remint-dois` only when a resolvable test DOI actually matters.

Two caveats with the clone tool: it reads `AWS_ACCESS_KEY_ID`/`SECRET` from the **ambient
environment** (unlike `e2e-test.ts`, which fetches per-user S3 credentials from the backend),
and session credentials are short-lived, so export them immediately before each run.
Creation is also **not retry-safe** after a partial failure (issue #955):
recover with `nemar admin delete-dataset <id>` then recreate, rather than re-running `create`.

### `nm099998` is the standing anonymous deposit, and a NAMED publication destroys it

It is the fixture every anonymity surface is exercised against (ADR 0065, #1407): a PUBLIC
catalog row over a PRIVATE `nemarDatasets` repository, `anonymous = 1`,
`first_published_at` NULL, with a version DOI minted and left **reserved** rather than
published. It exists so anonymity is tested against a dataset that STAYS concealed across
releases, deploys and enrichment runs, not only against rows a test creates and tears down in
one process. That value ACCRUES, so it is worth saying where the fixture is today: it was built
on 2026-09-17 and has no tenure yet. Deleting and rebuilding it costs whatever it has
accumulated, which is the reason the reserved band's error text does not offer
`delete-dataset` as routine advice.

**Never publish it non-anonymously.** An ANONYMOUS release is fine and is the point; it has
had one. What is unrecoverable is a normal publication, and the mechanism is worth knowing
exactly, because the two halves live in different files:
`FIRST_PUBLICATION_STAMP_SQL` (`services/anonymity.ts`) stamps `first_published_at` only
`WHEN anonymous = 0`, so an anonymous release leaves the column NULL, while a named one
stamps it -- and migration 0085's `datasets_anonymous_unpublished_ai`/`_au` triggers then
ABORT any statement that would set `anonymous = 1` on a stamped row, forever. So publishing
it under a name does not dirty the fixture, it destroys it, and no repair exists short of
rebuilding the dataset at a new id. An earlier version of this file said the approve path
stamps the column outright; that is false for an anonymous release, and the difference is
the whole safety margin.

The dev worker OWNS it (`DEV_OWNED_FIXTURE_IDS`, ADR 0068), so `nemar admin delete-dataset
nm099998` works from staging and a failed rebuild is recoverable. Production has no row for
it, so until the next `dev -> main` release the production worker still claims pushes to its
repository and dispatches runs that fail. Expect those; they are not a sign the fixture is
broken.

---

## Tooling is fixed

**Bun** for JavaScript and TypeScript, never npm or npx.
**Biome** for lint and format, never ESLint or Prettier.
**uv** for anything Python, never pip or conda.

```bash
bun install                  # dependencies
bun run src/index.ts         # run the CLI from source
bun test                     # real tests only, no mocks (.rules/testing.md)
bun run typecheck            # tsc for the CLI and the backend
bun run lint                 # biome
```

Wrangler runs through cfman, which holds the SCCN account token:
`bunx cfman wrangler --account sccn <arguments>`. There is no plain `wrangler login` on these
machines, so a command reporting "Not logged in" was run without cfman.

---

## Development workflow

1. **Check decisions** — skim `.context/decisions/README.md` for anything binding on the area
2. **Check context** — `.context/plan.md` for current tasks
3. **Branch into a worktree** — `git worktree add <path> -b feature/short-description origin/dev`
4. **Code** — follow `.rules/javascript.md`
5. **Test** — real tests with `bun test`
6. **Commit** — atomic, under 50 characters, no emojis, no co-author tags
7. **PR** — reference the context and the issue
8. **Record the decision** — if the change settled something an ADR should own,
   add one (or supersede the ADR it contradicts) in the same PR

### Epic / multi-phase development (REQUIRED)

For any multi-phase feature — an epic with sub-issues, phased delivery,
or anything spanning more than one PR — drive it with the **`/project:epic-dev`** skill.
Do not hand-roll the epic or sprint flow.
The skill owns epic and sub-issue creation and linking (`gh sub-issue`),
the epic/phase worktree structure, the per-phase plan → implement → PR → `/review-pr` →
squash-merge cycle, and the `.claude/epic.local.md` state file that tracks `current_phase`.

```
/project:epic-dev <description>     # start
/project:epic-dev --next-phase      # advance
/project:epic-dev --resume          # resume mid-phase
/project:epic-dev --finalize        # epic branch -> dev
/project:epic-status                # inspect state
```

Never let GitHub issues/PRs and `.claude/epic.local.md` drift.
Phase PRs squash-merge into the epic branch; the epic branch merges into `dev`.

---

## Everything else is on the documentation site

`nemar <group> --help` is authoritative for command behavior. For anything else:

| If you need | Go to |
|---|---|
| What a CLI command does | [CLI command reference](https://docs.nemar.org/cli/commands/) |
| Signing in, keys, the device flow | [authentication](https://docs.nemar.org/cli/getting-started/authentication/) |
| Account tiers, upload access, what a status means | [account and access](https://docs.nemar.org/cli/reference/account-access/) |
| The HTTP API surface | [API reference](https://docs.nemar.org/platform/api/) |
| Dataset download and byte-range access | [data API](https://docs.nemar.org/platform/data-api/) |
| DOIs, versioning, what is permanent | [DOI and versioning](https://docs.nemar.org/platform/doi-and-versioning/) |
| Which host serves what | [hosts and routes](https://docs.nemar.org/platform/hosts-and-routes/) |
| The Zarr serving copy, end to end | [Zarr](https://docs.nemar.org/platform/zarr/) |
| The `index.json` contract | [index contract](https://docs.nemar.org/platform/zarr/index-contract/) |
| One store's on-disk layout | [store contract](https://docs.nemar.org/platform/zarr/store-contract/) |
| What the Zarr format guarantees, and how that is checked | [format stability](https://docs.nemar.org/platform/zarr/format-stability/) |
| How a version reaches npm, and when to bump by hand | [release pipeline](https://docs.nemar.org/develop/release-pipeline/) |
| Writing and reading as an agent | [for agents](https://docs.nemar.org/platform/for-agents/) |

Gated, and worth knowing exist:

| If you need | Go to |
|---|---|
| Hosts, paths, crons, deploy procedures | [systems inventory](https://docs.nemar.org/admin/operations/systems-inventory/) |
| A proven recipe (git-annex, staging, branch protection) | [validated workflows](https://docs.nemar.org/admin/operations/validated-workflows/) |
| Zarr operations, including the maintenance commands | [Zarr serving runbook](https://docs.nemar.org/admin/operations/zarr-serving/) |
| Staging and the exemplar fleet | [staging environment](https://docs.nemar.org/admin/operations/staging-environment/) |
| Backup and restore | [disaster recovery](https://docs.nemar.org/admin/disaster-recovery/) |

---

## Rules and context, which stay in this repository

`.rules/` holds the detailed standards: [`javascript.md`](.rules/javascript.md),
[`git.md`](.rules/git.md), [`testing.md`](.rules/testing.md) (**NO MOCK policy**),
[`code_review.md`](.rules/code_review.md), [`documentation.md`](.rules/documentation.md),
[`ci_cd.md`](.rules/ci_cd.md).

`.memory/` holds what working on this repository has taught: one observation per file, the flag
that actually works, the status code that lies, the fix that looked right and was not. It is
tracked in git so it survives a change of agent, model or machine, and so a person can correct it.
Read [`.memory/README.md`](.memory/README.md) for the boundary against the two below, which is the
part that matters: an ADR is a ruling, a `.context/` document is an argument, a memory is an
observation and binds nobody.

`.context/` holds decisions, planning and research. Start from
[`.context/README.md`](.context/README.md), which marks what is current and what is historical.
The entries worth knowing by name: [`decisions/`](.context/decisions/README.md) (binding),
[`plan.md`](.context/plan.md), [`ideas.md`](.context/ideas.md),
[`research.md`](.context/research.md).

**ADRs stay next to the code they bind** and are not moving to the documentation site. The
operational runbooks that used to sit beside them did move; `.context/README.md` links them at
their URLs.
