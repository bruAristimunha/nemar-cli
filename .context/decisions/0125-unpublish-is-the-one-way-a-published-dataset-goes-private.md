# ADR 0125: Unpublish is the one way a published dataset goes back to private, and a bare visibility flip no longer exists

**Status:** accepted
**Date:** 2026-11-17
**Owner:** Seyed Yahya Shirazi
**Refines:** ADR 0086 (retires the PATCH visibility route it names; see its amendment of 2026-11-17)

## Context

On 2026-10-29 an administrator ran `nemar admin repo private nm000289` at the authors' request.
The dataset had been published on 2026-10-05 (a `published` request with every step done, a concept DOI and a version DOI both `public`, `first_published_at` set).
The command changed three surfaces, GitHub, the S3 policy and `datasets.visibility`, and nothing else.
What was left was private in every place a reader looks and published in every place a record looks: `nemar dataset publish status` reported a finished publication of a dataset nobody could reach, the DOIs resolved to a landing page for a private dataset, and no new publication request could describe the state truthfully.
The owner then could not make sense of its sharing and lookup behavior, which the investigation showed was not a visibility defect: the info, listing, collaborator and access-request routes admit the owner, administrators and collaborators to a private row, and the semantic search is public-only for everyone, owner and administrator included, by design.

The same flip in the other direction makes the mirror half state: a dataset that is public with no publication, no DOI and no review.

`withdraw` (ADR 0064) already exists for a dataset that is broken or removed, and it deliberately tombstones every DOI.
It is the wrong tool for authors who simply want the dataset back, because a DOI cannot be withdrawn once it is minted and a tombstone is a statement to the registrar that the work is gone.

## Decision

1. **`nemar admin repo unpublish <id>` (`POST /admin/datasets/:id/unpublish`) is the one way to take a dataset back to the unpublished, private state.**
   It runs `applyDatasetVisibility(private)` (GitHub, S3, D1, repo spec, collaborator reconcile, with revert on failure), stamps `publication_requests.unpublished_at` on every request still `published`, and writes a `dataset_unpublished` audit row carrying the reason.
   It never calls EZID: the concept DOI, every version DOI, `ezid_status` and `dataset_versions` are left exactly as they were.
   It is dry-run by default, needs `--execute` and a reason, and asks for confirmation.
2. **A published request is stamped, never rewritten.**
   Its `status` stays `published`, because it is the record that the dataset was published and the DOIs were minted under it.
   `unpublished_at` says it no longer describes the dataset; the owner's `publish status` reads such a request as "none", and the ordinary publication request is allowed again.
   A new request that is approved publishes the dataset again under the DOIs it already has.
3. **It also repairs the half state.**
   A dataset that is already private but still carries a live `published` request (nm000289) is reset by running the same operation; the visibility step is idempotent.
   A dataset that is public and was never published (an import, a bare flip) is simply made private.
4. **What it leaves alone, on purpose:** `first_published_at` (a repository that has been public has been public, so anonymity stays unavailable, ADR 0065), the tag ruleset and the S3 object lock (both guard versions that still exist), collaborators and access requests.
5. **What it refuses:** the live datasets nm000103 to nm000107, an exemplar, a withdrawn dataset (that is `restore`), and a private dataset with no live publication record.
6. **There is no bare visibility flip.**
   `nemar admin repo public` and `nemar admin repo private` are removed, and `PATCH /admin/datasets/:id/visibility` answers 409 in both directions with a pointer to the publication flow and to unpublish.
   Making a dataset public is what publishing does; the route stays registered so an old caller gets a sentence instead of a 404.
7. **The lifecycle commands live together** under `nemar admin repo`: `publish` (the former `admin publish` group), `unpublish`, `withdraw` and `restore`.
   The old top-level `admin publish`, `admin withdraw` and `admin restore` are hidden stubs that do nothing and exit 1 naming the new path, so a script fails loudly.
   `nemar dataset publish` (the depositor's command) is unchanged.

## Consequences

- An administrator picks between two clearly named operations: **unpublish** when the authors pull a dataset back (DOIs untouched, can be published again), **withdraw** when it is broken or removed (DOIs tombstoned, undone by `restore`).
- A scrub that takes a published dataset private and later returns it public (`.context/scrub-runbook.md`) lost its public step with `repo public`; that step is held for an owner decision on how a scrubbed dataset goes public again, and the runbook says so.
- Republishing after an unpublish reuses the concept DOI and the existing version DOI.
  The publication orchestrator already takes an existing concept DOI and EZID's "already exists" answer for a version; a second publish of the same version number has not been exercised end to end against EZID and should be watched the first time.
- `datasets.visibility` can no longer be moved by a tool that does not also move the publication record, so the half state cannot be produced again by the CLI or the API; a direct D1 write still can.

## Alternatives considered

- **Make `admin repo private` refuse a published dataset and point at unpublish.** Kept two commands for one act and left `private` as a way to make the unpublished half state (`public` to `private` on an import). Folding both cases into unpublish is simpler.
- **Reuse `withdraw` with a flag that skips the DOIs.** Withdraw's resume and skip logic is built on `withdrawn_at` and the tombstone state; a variant that does not tombstone would need its own preconditions and its own undo, which is a different operation under the same name.
- **Set the old request to `denied` or delete it.** Denied states a decision that was not made; deleting loses the record that the DOIs were minted under it. A stamp keeps both.
- **Remove the PATCH route outright.** An old caller would get a bare 404; the runbook and external scripts still name it. A refusal with a pointer is cheaper to leave in place than the confusion of removing it.

## Receipts

- nm000289, 2026-10-05 published, 2026-10-29 bare private flip; the audit rows of both.
- `backend/src/services/unpublish.ts`, `backend/src/routes/admin/unpublish.ts`, migration `0144_publication_requests_unpublished_at.sql`.
- `backend/test/unpublish.test.ts` reproduces the half state and proves the repair against stand-ins for GitHub and S3, with EZID unreachable.
- ADR 0064 (withdraw), ADR 0065 (anonymity), ADR 0086 (the screen gate and the break-glass visibility route this retires).
