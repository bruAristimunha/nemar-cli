# Datasets, Dataset IDs and Test Fixtures

The detail behind the "Live datasets" and "Dataset ID bands" hard rules in `AGENTS.md`.
The decisions are ADR 0011 (ids are backend-assigned in reserved bands), ADR 0068 (fixtures are assigned from the top of the band downward) and ADR 0065 (anonymity).
Where this file and an ADR disagree, the ADR wins.

## [STRICT] Live datasets

**`nm000103`-`nm000107` are LIVE.** Do NOT modify their visibility, S3 data, DOIs, or repo settings during development or testing.
All five are PUBLIC and carry minted DOIs (verified 2026-09-14: public on GitHub and `visibility: public` in the catalog).
An earlier version of this rule said they were kept private during dev; that has not been true since they were published, and it is the kind of stale fact that makes someone think a mistake is safe to make.

For end-to-end testing use `nm099999`, created on demand via `POST /admin/datasets/nm099999/reset` (lazily created if missing):

```bash
nemar admin e2e-test --verbose      # reset, upload, clone, download, update cycle
nemar admin e2e-test --skip-reset   # reuse existing nm099999 state
```

The 10-step pipeline lives in `src/lib/e2e-test.ts` and sources `test/fixtures/bids-minimal/`.
`xx`-prefix datasets are blocked from publishing.

## Dataset ID bands

All inside the 0-99999 cap, so `xx900001` is invalid.

| Band | Range | Purpose | Cleanup |
|---|---|---|---|
| Pre-allocator `nm` | `nm000001`-`nm000107` | predate `START_NUMBER`; `nm000103`-`nm000107` are LIVE | never |
| Real datasets | `nm000108`-`nm099899` | allocated upward by `generateDatasetId` | never |
| **`nm` fixtures (reserved)** | `nm099900`-`nm099999` | standing test fixtures, assigned by name | **never** |
| Prod sandbox | `xx000001`-`xx089999` | real user sandbox training | 14-day cron (prod) |
| Dev ephemeral | `xx090001`-`xx099899` | throwaway dev/e2e | dev cron |
| Dev exemplar fleet (reserved) | `xx099900`-`xx099999` | curated persistent copies | **never** (`is_exemplar=1`) |

**The top 100 ids of each allocating PREFIX are RESERVED and the allocator never returns one** (ADR 0068): `nm099900`-`nm099999` and `xx099900`-`xx099999`.
This is a property of the prefix, not of each band in the table above, so the top of the prod sandbox band (`xx089900`+) and of the dev ephemeral band (`xx099800`+) are allocated normally.
Real datasets grow upward from the prefix's start; standing test fixtures are assigned downward from `nm099999`, so a fixture's id is predictable without a registry.

In use today (the code is the source of truth for the declared set: `DEV_OWNED_FIXTURE_IDS` in `backend/src/services/datasetId.ts`):

- `nm099999`: end-to-end, with its own reset endpoint.
  It exists in both production and dev D1 and is deliberately NOT dev-owned.
- `nm099998`: the standing anonymous deposit, dev-owned (see below).
- `nm099997`: the standing fixture the publication review (ADR 0102) is exercised against on the dev worker, declared dev-owned in `DEV_OWNED_FIXTURE_IDS` ahead of its creation.
- `nm099996`: the standing compute fixture (portable compute, plan step S1), a staging copy of a small public EEG dataset that runner jobs run on outside production only, declared dev-owned in `DEV_OWNED_FIXTURE_IDS` ahead of its creation.
  The next fixture, assigned downward, is `nm099995`.
- The `xx099900+` exemplar fleet.

The FLOOR of the `nm` band is spoken for in the opposite direction: `nm099900` is `ABSENT_DATASET_ID`, the id live tests rely on never resolving.
It must never be declared dev-owned and a downward assignment must never reach it.
Four live tests used `nm099998` for that purpose, each commented "unlikely to be allocated", and building the fixture on that id turned all four red at once.

Reserved means not *allocatable*, not invalid, so `isValidDatasetId` still accepts these and every route must still serve them.
A fixture is created by NAMING its id on `POST /datasets` (`dataset_id`), fenced by `explicitDatasetIdGate` on FOUR terms, all of them required: non-production, an admin, the reserved band, AND the id being declared dev-owned in `DEV_OWNED_FIXTURE_IDS`.
The fourth is the one a new fixture hits: creating an undeclared fixture id is refused, because an undeclared fixture is invisible to the dev worker and claimed by the production one.
It narrows the route's "non-production forces sandbox" rule without weakening it: that rule exists to stop dev minting a REAL `nm` id, and a reserved id is one the allocator can never mint for anybody.
Naming an id exempts nothing else, so the account gates still apply and an operator who cannot pass them is not the right operator.
The reservation is **not** environment-fenced: `nemarDatasets` is shared between prod and dev, so a prod-minted fixture id would collide with a dev fixture's repository.
`on` ids are mirrored from OpenNeuro and never allocated here, so they have no reserved band.

## The exemplar fleet is permanent, not ephemeral

Seven curated `xx0999NN` copies of real public datasets (`scripts/exemplar-fleet.json`) cover eeg / ieeg / emg / meg / multi-modal / HED, published with **sandbox** EZID DOIs (`10.5072/FK2`, never the production `10.82901` shoulder).
Their `active`/`public` state lives in D1 and is the source of truth for the staging catalog; it does not depend on the registrar.
The only thing that lapses is EZID's sandbox shoulder, which purges DOIs after about two weeks, so re-mint with `nemar admin exemplar remint-dois` only when a resolvable test DOI actually matters.

**The fleet has no anonymous deposit (#1433, ADR 0068).**
It had one at `xx099907`, and that placement was the mistake ADR 0068 exists to prevent: `xx` publishes only through the exemplar exception, while an anonymous deposit's defining event is an anonymous RELEASE, so the one path the fixture needed was the one path its band refuses.
Keeping it there meant widening a publish gate, which is what #1428 did and #1433 undid.

What is true now:

- `scripts/exemplar-fleet.json` declares seven entries and the loader **refuses** an `anonymous` key outright.
- `isExemplarPublishAllowed` refuses an anonymous exemplar in every direction; there is no longer a way to ask.
- The clone tool does not blind `Authors`.
- `xx099907` is RETIRED (#1434): no dev D1 row, no `nemarDatasets` repository, both verified 404 on 2026-09-17.
- `POST /datasets` takes `dataset_id` and the CLI sends it (`nemar dataset upload --dataset-id`), so a fixture's create is not an out-of-band API call.
- `POST /admin/datasets/exemplar` REFUSES `anonymous: true` with `exemplar_anonymous_retired`.
  That field is still declared, deliberately: zod strips an unknown key, so deleting it outright would take `anonymous: true` from a caller who means it, create a NAMED exemplar, and report success.

Two caveats with the clone tool:

- It reads `AWS_ACCESS_KEY_ID`/`SECRET` from the **ambient environment** (unlike `e2e-test.ts`, which fetches per-user S3 credentials from the backend), and session credentials are short-lived, so export them immediately before each run.
- Creation is **not retry-safe** after a partial failure (issue #955): recover with `nemar admin delete-dataset <id>` then recreate, rather than re-running `create`.

## [STRICT] `nm099998` is the standing anonymous deposit, and a NAMED publication destroys it

It is the fixture every anonymity surface is exercised against (ADR 0065, #1407): a PUBLIC catalog row over a PRIVATE `nemarDatasets` repository, `anonymous = 1`, `first_published_at` NULL, with a version DOI minted and left **reserved** rather than published.
It exists so anonymity is tested against a dataset that STAYS concealed across releases, deploys and enrichment runs, not only against rows a test creates and tears down in one process.
That value ACCRUES: it was built on 2026-09-17, so deleting and rebuilding it costs whatever it has accumulated, which is the reason the reserved band's error text does not offer `delete-dataset` as routine advice.

**Never publish it non-anonymously.**
An ANONYMOUS release is fine and is the point; it has had one.
What is unrecoverable is a normal publication, and the mechanism lives in two files:

- `FIRST_PUBLICATION_STAMP_SQL` (`services/anonymity.ts`) stamps `first_published_at` only `WHEN anonymous = 0`, so an anonymous release leaves the column NULL, while a named one stamps it.
- Migration 0085's `datasets_anonymous_unpublished_ai`/`_au` triggers then ABORT any statement that would set `anonymous = 1` on a stamped row, forever.

So publishing it under a name does not dirty the fixture, it destroys it, and no repair exists short of rebuilding the dataset at a new id.
An earlier version of this rule said the approve path stamps the column outright; that is false for an anonymous release, and the difference is the whole safety margin.

The dev worker OWNS it (`DEV_OWNED_FIXTURE_IDS`, ADR 0068), so `nemar admin delete-dataset nm099998` works from staging and a failed rebuild is recoverable.
Production has no row for it, and the production webhook short-circuits a repository whose id is declared dev-owned (`backend/src/routes/webhooks/github.ts`).
The declaration is on `main` (checked 2026-11-04 against 0.10.27), so failed production runs for this repository are no longer expected: if one appears, check the declaration before blaming the fixture.
An earlier version of this rule said production still claimed its pushes until the next release; that gap has closed.
