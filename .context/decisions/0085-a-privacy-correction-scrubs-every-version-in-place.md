# ADR 0085: A privacy correction scrubs every version in place, and NEMAR keeps the history of each correction

**Status:** accepted
**Date:** 2026-10-04
**Owner:** Seyed Yahya Shirazi

## Context

A researcher reported name-like strings in the EDF/BDF patient headers of a published dataset
(epic #1610). Reading the headers of every public dataset (`scripts/identifier-fleet-scan.ts`)
found the same class in others, always in a dataset that re-shares data other groups
released: the `nm` datasets are conversions of public releases and the `on` datasets are
OpenNeuro mirrors. For the reported dataset a header read from inside the original release was
byte-identical to NEMAR's copy, so the identifiers come from upstream and were public before
NEMAR copied them. That lowers the severity and removes none of the obligation.

The bytes are everywhere a version is: the git history (pointer files and inline JSON), the
S3 objects (public read, a content-addressed key per file, GOVERNANCE Object Lock for 100
years on `<id>/objects/` only, in a versioned bucket), the per-version manifests, and the data
plane. The standing rules pull in different directions. ADR 0006 gives NEMAR's own changes a
minor or patch bump. ADR 0016 leaves tags to CI. The Takedown Procedure withdrew prior versions
and tombstoned the DOI, but a tombstone hides bytes and deletes none, and withdrawing every
version of a dataset with 34 citations breaks every analysis that cites it. A new corrected
version would leave the old ones serving the identifiers. The existing delete paths add delete
markers in a versioned bucket, so they remove nothing.

## Decision

**What gates.** A name, a birth date finer than year, a record number, an age over 89, contact
details and a face gate. An acquisition date alone does not: it is acceptable when nothing in
the dataset ties the recording to an identifiable person (published in the Contributor Terms,
2026-10-04). The scanner reports start dates at review severity and they never block.

**The default remedy is an in-place scrub of every version.** The affected fields are removed
from every version NEMAR serves, and version numbers and DOIs are kept; no new version is
issued. The Contributor Terms and the Takedown Procedure reserve the right to do this and say
how depositors, authors and source archives are told. Withdrawal with deletion of the data is
reserved for a dataset that cannot be scrubbed: a license that forbids modified copies, an
identifier carried in the signal or pervasive (audio, video, many annotations), or an extent
that cannot be bounded. A tombstone alone is never the remedy.

**The scrub replaces keys, it does not edit locked objects.** For EDF and BDF files only
bytes 8 to 88 (patient identification) and 88 to 168 (recording identification) change, and
only when the scanner finds in them a name or a name-like patient code, a birth date finer than
year, a record number, an age over 89, other free text, a technician or non-ASCII text
(`PATIENT_DIRTY` and `RECORDING_DIRTY` in `shared/identifier-scrub.ts`); the start date and time, the record count and every byte after offset 256 stay
identical, which is proven byte for byte (`shared/identifier-scrub.ts`). The new content has a
new SHA256E key, so the order is add, verify, switch, delete:

1. restrict the dataset (private with the bucket-policy exclusion, the supported visibility
   transition), suppress workflow dispatch, pause its Zarr queue, and take the uploader's write
   access away; **NOT BUILT in Phase 2, except the restriction**: no tool suppresses dispatch,
   pauses the queue or removes write access (see "Build status"), and the runbook tells the
   operator what a push sets off and to watch it; dispatch suppression was decided on 2026-10-06
   as a temporary disable of three central workflows, done by hand (amendment of that date);
2. hash the new content on a host with fast S3 reads (the key needs the whole file), verifying
   the original against its own key in the same pass;
3. assemble each new object server side (a patched first part and `UploadPartCopy` for the rest),
   with explicit GOVERNANCE retention at creation, and verify it (sizes, patched header, sampled
   ranges, retention) and re-hash it from S3;
4. rewrite the git history of every branch and tag with `git-filter-repo` so every tree names
   the new keys and drops or blanks the inline identifiers, record the new keys as present and
   the old keys as dead in the `git-annex` branch, lift the per-repository tag ruleset, force-push,
   and restore the ruleset;
5. regenerate every tag's manifest AFTER the tags move (before, the job rebuilds the old
   manifest from the old tree); the remap of `zarr_source_commit` and the index `source_commit`
   is **NOT BUILT in Phase 2** (it is not a privacy matter, and the next reconversion of the
   dataset repairs both);
6. verify through the public surface that every manifest names only new keys and that downloads
   hash to them;
7. delete the old object versions, and the noncurrent manifest and archive versions, by VersionId
   with the governance bypass, and prove it with an authoritative `ListObjectVersions` showing
   zero versions and zero delete markers;
8. ask GitHub Support to clear cached views and pull-request refs, check for other copies NEMAR
   controls, delete local clones, and make the dataset public (re-enabling dispatch and access
   has nothing to undo while step 1 is not built); the Support request is withdrawn by the
   decision of 2026-10-06, which accepts the pull-request refs as a residual (amendment of
   that date).

Retention is never shortened with `PutObjectRetention`, which would open an unprotected window.
Nothing is deleted until the public surface has been verified, and deletion is the only
irreversible step.

**Purged keys stay purged. NOT BUILT in Phase 2.**
Nothing creates, stores or reads a purge list yet.
The design is that every old key goes on a private purge list (a document with a catalog pointer, not a per-key table, ADR 0036), and that import copy, recovery (ADR 0063), key registration (ADR 0061), the availability count (ADR 0064) and the publish gate refuse a purged key, and none counts it as missing.
What Phase 2 does instead: the old keys are marked dead in the `git-annex` branch and deleted by version id, so the bytes are gone, but nothing stops the same bytes being uploaded or recovered again.
The epic's phase list owns only some readers: the publication gate is Phase 4 (#1614; the design review on #1613 names the publication orchestrator as the gate that holds), and the importer's prepare step is Phase 7 (#1618, which must refuse a key on the purge list).
No phase builds the list itself, its catalog pointer, or the readers in import copy, recovery, registration and the availability count, so that work is unowned and needs its own issue before Phase 4 or Phase 7 can use it.

**Authority and a rehearsal.** The owner gives an explicit go for each dataset after a dry run
whose plan is read-only. The bypass is proven on a disposable canary object before any real
object is touched, and the first real scrub is a single dataset.

**NEMAR keeps the history of its corrective actions.** An append-only ledger records, per
dataset, each action (plan, headers scrubbed, files removed, history rewritten, locks applied,
manifests regenerated, old versions deleted, republished), the versions affected, counts, the
scanner version and rules, the verification result and who ran it, with no values and no per-file
lists (ADR 0036). It lives where a history rewrite cannot erase it: a file in the dataset
repository committed after the rewrite, an object under the dataset's S3 prefix, and a count and
pointer on the catalog row. Each corrected version's change log says that a privacy correction
was made, without describing what was removed.
The file (`.nemar/corrections.jsonl`) and the object (`<id>/corrections/ledger.jsonl`) are built (`scripts/scrub/ledger-cli.ts`, runbook step 13).
**The count and pointer on the catalog row are NOT BUILT in Phase 2**, and no phase of the epic lists them; they need a migration and a route, so they need an owner.
The ledger has no field for who gave the go for an irreversible step, and refuses free text by design, so the runbook records each go in a comment on the epic.

**The scrub is a step in the workflows that bring data in. NOT BUILT in Phase 2.**
The importer's prepare step (ADR 0060) scrubs identifying fields in place, then the same deterministic screen runs, then the ledger is written, so a later OpenNeuro import or re-pull is scrubbed again and does not reintroduce what was corrected.
That is Phase 7 (#1618).
The publication workflow gains `identifier_screen`, a hard gate before `s3_public_read` that fails closed on a direct finding, and treats an unread header or a recording format the scanner cannot parse as not screened, which only an explicit, recorded admin acknowledgment can pass.
That is Phase 4 (#1614).
Phase 2 builds the tools an administrator runs by hand, and the shared header scrub that both phases will call (`shared/identifier-scrub.ts`).

## Consequences

- The original bytes are gone from NEMAR for good. Copies others downloaded, forks, and GitHub's
  cached views and pull-request refs are beyond NEMAR; the Takedown Procedure says so.
- The bytes behind a tag and a DOI change. What preserves provenance is the ledger, the change
  log and this ADR, not the version number; a citing analysis still reproduces because the signal
  bytes are identical.
- A mirror diverges from upstream. The provenance text that said sourcedata is byte-for-byte
  unmodified is corrected for any dataset scrubbed, and upstream archives are told.
  The provenance file keeps the `sha256` of each original upstream file, which is also the hash of an old key the scrub replaced.
  Whenever any key is scrubbed or any file is removed, it says in `privacy_correction` what changed and that its checksums describe the original upstream files; it adds "not the scrubbed copies" only when keys were scrubbed in place, and names removed files only when some were.
  `git-scrub verify` lets an old hash stand there and nowhere else (amendment of 2026-10-06, "A mirror's provenance file keeps the upstream checksums").
- Scrubbing re-reads every affected file once (about 345 GB across the first 16 datasets), which is
  why hashing runs on a host with fast S3 reads and assembly never moves the payload.
- **NOT BUILT in Phase 2:** the purge list does not exist, so nothing yet refuses a purged key.
  Several services must learn it before it can be trusted, and until the publication gate and the importer step exist, only byte-identical re-uploads would be caught by it.
- Webhooks dispatch a version-DOI run on any non-delete tag push and enrichment on pushes to
  `main`, and the design was that dispatch is suppressed for the duration of a rewrite.
  **That suppression is NOT BUILT in Phase 2**, so the force-push of the tags dispatches a version-DOI run for each moved tag, which dispatches the central manifest job and the archive job, and can upload a Zenodo backup.
  On 2026-10-06 the maintainer decided to suppress it by hand instead, disabling three central workflows for a short window (amendment of that date; runbook steps 8b and 9b), and the derived files are then rebuilt by hand (steps 12 and 15c).

## Alternatives considered

- **A new corrected version, with earlier versions withdrawn.** Leaves the identifiers in every
  version until withdrawal, breaks every citation of the earlier versions, and mints an
  irreversible version DOI. Rejected.
- **Tombstone every version.** Hides the bytes and deletes none. Rejected as a remedy.
- **Make the dataset private and stop.** Stops anonymous reads and fixes nothing; kept only as
  the interim step.
- **Scrub the objects but not the git history.** Leaves the inline JSON, file names and every old
  key reachable from old commits and tags. Rejected.
- **Edit the objects at their existing keys.** Impossible: the key is the content hash.
- **A different key backend for scrubbed files, to avoid re-reading them.** Breaks the annex
  policy (ADR 0031) and every reader that assumes SHA256E. Rejected.

## Receipts

- Epic #1610 and its phases: #1611 (scanner), #1612 (this ADR and the tooling, PR #1625), #1613
  (uploader preflight), #1614 (publication gate), #1615 (scheduled sweep), #1616 (admin triage),
  #1618 (importer) and #1626 (Zarr stores carry no subject-level metadata); docs PRs #57, #58
  and #59.
- The design review recorded on #1612 (key replacement, delete by VersionId, canary, purge list,
  dispatch suppression, manifests after the tag move); the purge list and the dispatch
  suppression in it are not built in Phase 2.
- `.context/scrub-runbook.md`, which holds the operational steps, the exit codes, and the
  real-bucket checklist that must run before the first real execute.
- `scripts/identifier-fleet-scan.ts` and its results, `shared/identifier-scan.ts`,
  `shared/identifier-scrub.ts`.
- ADRs amended today: 0006, 0010, 0016, 0060, 0061, 0063, 0064, 0067.

## Amendment 2026-10-05 (#1612): the other copies, and what a successful run proves

A review of the Phase 2 tooling and a first read of the real bucket found things the procedure above did not name.

**Two more copies of the identifiers.**
The Zarr serving copy repeats header fields:
every store's root metadata (`<id>/zarr/<path>.zarr/zarr.json`) carries, in `attributes.recording_metadata`, the subject and operator members the converter copies from the EDF or BDF header (the removal set is listed under "What a clean Zarr store means" below).
Those objects are not Object Locked, so the `zarr` stage removes those members in place and re-reads every document; the noncurrent versions of every zarr object are then pruned, because the bucket is versioned.
The archive zip under `<id>/archives/` contains the original recordings, so `drop-archives` deletes every version of it, only after the rewrite has been verified from a fresh clone of the pushed repository (runbook step 15a, because the deletion cannot be undone).
The stage refuses until the proofs of the new objects, of the pushed history and of the Zarr copy are in the working directory and name this plan.
The archive is then rebuilt from the scrubbed tree by the normal archive workflow, which the maintainer has to trigger, because no command in this repository builds one by hand and nothing re-dispatches a missing archive (runbook step 16; corrected by the amendment of 2026-10-06: the central repository has a manual dispatch, and the runbook rebuilds the archive in step 15c).
`<tag>-summary.json` and `<tag>-records.json` were checked by key name and hold entities, signal summaries and provenance, no header field.
The manifest job regenerates `<tag>-summary.json` together with the manifest; `<tag>-records.json` is not regenerated by it.

**Verification before deletion is by admin reads.**
Step 6 says to verify through the public surface, but the dataset is private until the old bytes are gone, which is what keeps any old key from being publicly readable.
What is verified before deletion is therefore the pushed refs in a fresh clone (`git-scrub verify --fresh-clone`, which also reads the pushed `git-annex` branch), every regenerated manifest and every new object re-hashed from S3, all by an administrator.
After the old bytes are deleted and before the dataset is made public again, a new read-only plan over what remains must say there is nothing left to scrub (`needScrub=0`).
The fleet scan lists only public datasets, so it cannot screen a private one, and that plan is the screen from inside; the fleet scan runs after publication.
The public surface is checked after the dataset is made public again, and a failure there makes it private again; the new objects were verified twice, so the fault would be in a manifest, a cache or a route.

**The irreversible steps check for themselves.**
`delete-old` refuses unless the plan is complete and not partial, both S3 proofs name the exact bytes of `assembled.json`, the verification of a fresh clone of the pushed repository (`git-verified.json`, mode `fresh-clone`) names this keymap and plan (and, from 2026-10-06, the `git-plan.json` in the working directory when one is there), no current manifest names an old key, an anonymous request for a new object, and for an old one while any remains, is refused (the dataset is private), the Zarr stage has verified for this plan, and no archive remains.
`drop-archives` refuses unless the plan is complete and not partial, and the same proofs of the working directory hold: both S3 proofs, the fresh-clone git proof with its keymap, and the Zarr stage's proof for this plan (a `no-zarr` proof only while no Zarr object is current).
It checks them with the same code and the same words as `delete-old`.
Both stages evaluate every refusal before they stop and list them all, so the dry run of `delete-old` before the archives are dropped shows everything that would stop the deletion, not only that the archives remain.
The maintainer's go for each irreversible step (the force-push, the archive drop, the deletion and making the dataset public again) is an operator discipline in the runbook, not something a tool checks.
A prune prefix is an allow-list (`<id>/version/`, `<id>/archives/`, `<id>/zarr/`), never a deny-list, because a deny-list let the dataset root through in review.

**A successful run is not proof that nothing was missed.**
The plan's keys are the union of every manifest and a listing of `<id>/objects/`, the git plan reads every commit rather than the tag tips, and `verify` requires every EDF and BDF key in any commit to be a new key or one the plan found clean.
The hash stage binds each digest to the patch it was computed for, so a re-plan cannot reuse a stale one.

**The stand-in is not S3.**
On first contact with the real bucket the tools disagreed with their stand-in twice: S3 requires a checksum header on an `UploadPart` of a multipart upload created with Object Lock parameters, and `<id>/version/` holds `<tag>-records.json` beside the manifest.
Both were fixed, and the canary, which runs on the real bucket against a test prefix, is run again after any change to an S3 call.

**Second review of the same day: what a "clean" Zarr store means.**
The first version of the `zarr` stage removed only the members the scanner calls identifiers, but the converter mirrors the whole EDF identification fields into the store, including `technician`, `admincode`, `patient_additional`, `equipment` and `recording_additional`, which the EDF scrub rewrites and the scanner does not name as keys.
A store holding a technician's name came out "clean" and was proven clean.
The stage, its re-read, its proof and the public check (`zarr-public`, runbook step 16) now share one list of the mirrored members (`EDF_MIRROR_MEMBERS`), so what one removes the other checks.
An earlier version of this paragraph kept `gender` because sex is neither a name, a date nor a record number; the decision of 2026-10-05 below supersedes that, and `gender` is removed.
The same review made `delete-old` finish clean or refuse: any version or marker left under `archives/`, `version/` or `zarr/` is refused before a delete, history found afterwards writes no `deleted.json`, every live version must be in the plan, and the privacy probe also covers the new keys so a failed prune can be re-run.
Signals (`SIGINT`, `SIGTERM`, `SIGHUP`) remove the temp directory and kill the `aws` children, because `finally` does not run on a signal and the directory can hold raw header bytes.

**What a clean Zarr store means (decision 2026-10-05).**
A store holds the data and the events, plus channel names, types and units and technical recording metadata.
It says nothing about the subject: age, sex or gender, patient code, birth date, name and additional patient text live at dataset scope, and `participants.tsv` is the one canonical place for them.
Operator and administrative free text copied from a recording header (technician, administrative code, equipment, additional recording text) is not data, events or channels either.
A store is clean when every `zarr.json` in it, the root and every array's or nested group's, passes one rule (`scripts/scrub/s3/zarr-json.ts`), shared by the `zarr` stage, its re-read, its proof and `zarr-public`:

- **Removed:** every member of the removal set `EDF_MIRROR_MEMBERS` (`patientcode`, `birthdate`, `gender`, `patient_name`, `patient_additional`, `admincode`, `technician`, `equipment`, `recording_additional`) and every key the scanner calls an identifier, at any depth under `attributes` and in any spelling, whenever it holds something.
  `gender` is removed for consistency with the scrubbed header, whose patient field is `X X X X`; `participants.tsv` keeps sex.
  The document is edited as text, so every byte outside the removed members is the original byte.
- **Allowed:** the members of `recording_metadata` (or `recording_info`) in the allow-list `KNOWN_BENIGN`: `startdate` (an acquisition date does not gate), `filetype`, `number_of_signals`, `file_duration`, `datarecord_duration`, `source_file`, `source_format`, `streamed` and `channels_tsv_units` with whatever it holds, plus any key the scanner knows at review severity (an `email` is kept, not removed).
- **Refused:** any other member name refuses the run (`unknown-recording-member`, exit 3) before a document is written.
  The names, never values, go to `zarr-unknown-members.json`, and a person accepts a name with `--allow-member NAME`, which `zarr-verified.json` records and `zarr-public` applies.
  biosigIO's four technical flags, which it writes only when they apply (`channel_labels_deduplicated`, `brainvision_header_recovered`, `eeglab_fdt_recovered`, `edf_tolerant_read`), are not in `KNOWN_BENIGN`, so a store that carries one refuses until `--allow-member` names it.
  Whether to add them to the list is the maintainer's decision.

`zarr-public` reads store roots only, because an anonymous reader cannot list the nested documents.
Since release 0.10.15 the converter writes no subject or operator member into a store (Phase 8, #1627, biosigIO 1.2.11 or later); the fleet-wide strip of the stores nobody has scrubbed is not built (#1626).

**The Zarr census (names only, read-only, 2026-10-05).**
A read-only census read the member names of every store root of two datasets, never a value.

- nm000186, all 88 store roots: `birthdate`, `patientcode`, `gender` and `equipment`, non-empty in every one; `startdate` (a typed object); `source_file`, `source_format`, `number_of_signals`; empty `filetype`, `file_duration` and `datarecord_duration`; `channels_tsv_units` (an object with `converted`, `kept_importer_unit`, `relabelled`, `units_column_present`).
  No `technician`, `admincode`, `patient_name`, `patient_additional` or `recording_additional`.
  So the real run must remove exactly four members from each of the 88 roots (352) and leave the other eight, and a test builds 88 such stores by hand and asserts exactly that.
- nm000348, 153 stores (33,250 Zarr keys): only `channels_tsv_units`, `number_of_signals`, `source_file` and `streamed`.
  There is nothing to remove, and that is a clean proof (`found: stores`), not a failure.

The census read store roots only; nested documents were not censused.

## Amendment 2026-10-06 (#1612): dispatch is suppressed by hand, and what a scrub leaves behind

Three decisions by the maintainer, made on 2026-10-06 after a read-only investigation of what a push sets off and of the copies outside the bucket and the repository.
The runbook (`.context/scrub-runbook.md`) carries the procedure, the checks and the commands.

**Decision 1: dispatch is suppressed by a temporary workflow disable.**
For a short window around the force-push, the three central workflows the Worker dispatches on a push, `run-version-doi.yml`, `run-enrichment.yml` and `run-bids-validation.yml` in `nemarDatasets/.github`, are disabled with `gh workflow disable` and then enabled again.
No code.
A disabled workflow drops the dispatches of every dataset repository, and `repository_dispatch` answers 204 whether or not a run starts, so the runbook batches every ready dataset into one window, announces it on the epic, checks with `gh workflow list --all` before the first push and after the last, and confirms from `gh run list` that no run started for a dataset of the batch (runbook steps 8b and 9b).
`gh workflow disable` is outward-facing, so opening the window needs the maintainer's go for each dataset, in the same form as a box (`GO window <dataset> <plan-id>`).
A repository whose own legacy workflows (`version-doi.yml`, `generate-archive.yml`, `llm-enrichment.yml`) would run on the push is not reached by the central disable, so GitHub Actions is disabled on it for the window and enabled again after.
The decision named the seven repositories whose `main` carries those files (nm000197, nm000200, nm000246, nm000277, nm000301, nm000340, nm000348).
A tag push runs the workflow files of the pushed commit, and a read of every tag on 2026-10-06 found `version-doi.yml` in at least one tag of each of the fourteen `nm` datasets of the sixteen, so the runbook decides per repository by checking every ref the push moves.
The legacy workflows are a fleet-drift finding (`GET /admin/fleet/drift`, `DEPRECATED_WORKFLOW_PRESENT`) and are not stripped by the scrub.
The cost the window carries: a push to any other dataset repository during it loses its dispatches, which step 9b lists for the maintainer.
With dispatch suppressed, the derived files are rebuilt by hand: every tag's manifest and records before the deletion, so its prune removes the versions they replace (step 12), and exactly one archive, for the latest version, after the deletion and before the dataset is public again (step 15c).

**Decision 2: GitHub pull-request refs are an accepted residual.**
In the maintainer's words: "Don't worry just force push and move forward, these are not our mistakes, we do our best."
No GitHub Support request and no recreation of the repository; this withdraws the Support request of step 8 above.
Twelve of the sixteen repositories carry two to five `refs/pull/<N>/head`, which survive a force-push, cannot be deleted by the owner, and keep the pre-scrub commits fetchable once the repository is public.
A branch is treated differently: a branch merged into `main` is deleted before the clone (the switch refuses any remote head but `main` and `git-annex`, and a branch is visible once the repository is public), and a branch ahead of `main` stops the run for the maintainer.

**Decision 3: the Hallu copies stay.**
In the maintainer's words: "Leave the Hallu copies."
`scripts/hallu-sync.sh` keeps a clone with annexed content and the archive zip of every public `nm` dataset on the SCCN host and never deletes one that goes private.
A scrub keeps the version numbers, so the sync keeps the pre-scrub copy without an error; on the dataset's next version its `git pull --ff-only` fails on the rewritten history, every hour, until the clone is replaced.

**What a scrub leaves behind**, in short (the runbook's "Residuals" has the checks):

- pull-request refs and GitHub's cached views (decision 2);
- the Hallu copies, including the QA output under `processed/<id>/` (decision 3);
- Zenodo: a backup deposit is a draft of the tag's git tree, never a recording, and one made before the scrub holds the pre-scrub tree; published legacy Zenodo records cannot be deleted by NEMAR; whether any draft exists is UNVERIFIED, and drafts are not decided;
- the public Actions logs of `nemarDatasets/.github` (90-day retention), which printed paths, README-derived metadata, the validator's JSON and the head of each records file for the pre-scrub trees; whether any validator message quotes header text is UNVERIFIED; not decided;
- the failure text in `<id>/zarr/index.json` (`failures[].detail`, `pending[].last_error`), which the runbook counts before the flip and stops on for a person.

**Corrections to the amendment of 2026-10-05.**

- `<tag>-records.json` is regenerated by every version-DOI run whose publish step succeeds (its `trigger-records` job); only the manifest job leaves it alone, which is what that amendment's sentence was about.
- A manual archive dispatch exists, in the central repository: `run-generate-archive.yml` takes `workflow_dispatch` with `dataset_id`, `version` (`X.Y.Z`, no leading `v`) and `force`.
  Its idempotency guard skips a version whose zip exists unless `force` is true.
  The rest of that sentence holds: nothing re-dispatches a missing archive, because the archive retry looks only at a `failed` status.
- `datasets.latest_version_doi` is written unconditionally by every successful version-DOI publish, and the runs of several tags race with no concurrency group; the runbook compares it with its value from before the window (step 15c).
- The archive is no longer rebuilt after the flip at the maintainer's request: the runbook rebuilds it in step 15c, while the dataset is still private, and step 16 checks the new key anonymously after the flip.

## Amendment 2026-10-06 (#1610): a mirror's provenance file keeps the upstream checksums

The first real run, on nm000186, stopped at the local verify of the rewritten clone (runbook step 7) with `old-key-present count=2`, before anything was pushed.
Both hits were versions of `sourcedata/sourcedata_provenance.json`, whose `files` entries carry the `sha256` of each original upstream recording that `sourcedata/` mirrors.
The mirrored copies were the upstream bytes, so each of those checksums is also the hash of an old key the scrub replaced: on nm000186, 88 of its 176.
This ADR keeps those checksums as upstream provenance, so the check was right to stop and two things were wrong.
Verify treated a kept checksum as a dangling reference.
The git plan said, in the file and in its README, that the checksums describe the upstream files only when it dropped a file, so a dataset scrubbed purely in place, as nm000186 is, would have kept upstream checksums with no word that its copies differ.
Ten of the sixteen datasets carry the same mirror and the same file.

**The plan.**
Whenever the provenance file is in any commit and the S3 plan scrubs any key, or any file is dropped, the plan sets `privacy_correction` in that file to a sentence saying what changed and that its checksums describe the original upstream files, adding "not the scrubbed copies" when keys were scrubbed in place.
When `sourcedata/README_sourcedata_provenance.md` exists, it appends a note on the same terms.
Both say files were removed only when some were, and only then are entries dropped from `files` and the counts recomputed.
The report counts what it did (`provenanceAnnotated`, `provenanceReadmeAnnotated`, and `s3KeysScrubbed`, the keys the S3 plan scrubs).
Without `--s3-plan` the plan cannot know whether a key is scrubbed, so it refuses (`s3-plan-required`) a history that has the provenance file or its README, rather than write a sentence that might leave out the scrub; the runbook always passes it.
Verify requires a sentence, not particular words: what it says is bound by the plan's own `set` operation, which verify checks in every commit (`json-ops-not-applied`).

**The verify rule.**
In both modes, `--before` and `--fresh-clone`, which share one code path, an old hash found in a blob is not `old-key-present` only if all of these hold:

- the blob is `sourcedata/sourcedata_provenance.json` as a regular file (mode `100644` or `100755`, never a symlink), and nothing else, in every commit of every ref and in every tree a ref names directly (a ref to a tree, such as git-annex's `refs/annex/last-index`, has its blobs listed under that tree's paths, so a root tree keeps the exception and a subtree does not), and no ref names a blob or anything but a commit or a tree (that blob has no path to check, so then nothing is exempt);
- the blob is a UTF-8 JSON object, and every old hash in it is the whole string value of a `sha256` member of an object in the top-level `files` array; one anywhere else in the file (in the sentence, in another field, nested deeper, in another array, as a key) is a hit, found by the same scan as before with only those values masked;
- the blob carries `privacy_correction` as a non-empty string.

A blob that meets the first two and not the third fails with a reason of its own, `provenance-unannotated`, with a count.
A provenance blob over 16 MiB is not read, and fails as `provenance-too-large`; one nested deeper than the walk can follow is not placed, and is `old-key-present`.
A hash in any other file, a copy of the provenance file at another path included, is `old-key-present` as before.
The verify line and the proof's `counts` carry `provenanceHashesKept` (distinct old hashes; a checksum that is no old key's is not counted) and `provenanceBlobsKept`, both 0 for a dataset without the file.
The proof's schema already takes any count, so a `git-verified.json` from before has neither and is still accepted: that verify allowed no old hash anywhere, which is stricter.
A kept checksum is a digest of a file in the upstream release and carries none of its header text.

## Amendment 2026-10-06 (#1610): old versions are deleted in batches, and the bypass is for the recordings only

Step 7 above says the old object versions, "and the noncurrent manifest and archive versions", go "by VersionId with the governance bypass".
Read that as two groups with two rules, which is what the tools do: the old recordings go with the bypass (the lock is the point), and the noncurrent manifest, Zarr and archive history goes **without** it, so a locked object there is refused and reported, never forced.
The first real run, on nm000186, deleted one version per call, at about six a second, and an 82,195-entry Zarr history was hours of work.
`delete-old` and `drop-archives` now send up to 1,000 versions in one `DeleteObjects` request, each named by key and version id, with the same bypass rule per request (a request never mixes the two groups).
The answer to a batch is read item by item, because S3 answers 200 whatever happened to an item: a locked version without the bypass is an entry of `Errors`, not a failed request.
An item in neither `Deleted` nor `Errors` counts as not deleted.
Nothing about what is selected, what is refused, or the final authoritative `ListObjectVersions` changed, and that listing, not the answers, decides whether `deleted.json` is written.
The canary's `--batch` step measured the behavior on the real bucket (2026-10-06) before it was relied on.

## Amendment 2026-10-06 (#1610): raw copies under `objects/` are deleted once they are shown to match

A read-only listing of nm000112 and nm000114 found a copy class the procedure above did not name.
Beside the annex keys, `<id>/objects/` holds objects stored by their PATH, not by an annex key: a legacy early import uploaded the whole BIDS tree that way, from a Mac (AppleDouble `._*` files included).
On nm000112, 123 raw recordings (`.bdf`, 33.7 GB), each one version behind a current delete marker and unlocked, and 624 raw text files (TSV, JSON, `README.md`, `.gitignore`, `code/`, `._*`), current and locked GOVERNANCE for 100 years; on nm000114, 181 raw recordings (`.edf`) with 328 versions, all behind delete markers, and 435 raw text names.
The raw recordings are ORIGINALS, their headers holding the identifiers, and the raw text holds the values the git rewrite blanks.
The plan stopped on them (`objects-bad-key`), and `delete-old` would have refused them (`unplanned-recording`), so neither dataset could be scrubbed.
Every dataset also holds exactly one other non-annex object, `annex-uuid` (36 bytes, the S3 special remote's marker), which is not a copy of anything and stays.

**The decision (the maintainer, 2026-10-06), in his words: "Delete the raw copies after verifying they match."**
Every raw copy goes at step 7 above (runbook step 15b): every version and every delete marker of every name under `<id>/objects/` that is not an annex key and not exactly `annex-uuid`.
But only once each raw VERSION is proven to duplicate content NEMAR keeps elsewhere; anything not proven refuses the deletion, with counts by reason, and is never deleted or skipped.

**What "match" means, and why it differs by kind.**
A raw recording (`.edf` or `.bdf`, any letter case) must be byte for byte an annex key of the plan: its sha256 is the one some key of `plan.keys` names, scrubbed or clean, and its size is that key's.
This rests on content addressing: an annex key names the sha256 and size of its content, and git-annex stores the content under that name, so a key of the same sha256 and size holds the same bytes.
The plan did not read every such key whole: a key the scrub replaces was read whole by the hash stage (`compute` checks its stored bytes against its name), but a clean key was read for its header and size only.
So `raw-verified.json` records the annex keys the raw recordings matched (`matchedKeys`, content hashes and no value), and `delete-old` requires each one it does not replace to be current at its declared size (`raw-duplicate-missing` otherwise, with a count).
What the raw copy holds then survives as that key, or, for a key the scrub replaces, as its replacement, which differs only in the header the scrub exists to remove and which `verify` and `verify-new` proved.
Any other raw file must be a blob of the dataset repository's history from BEFORE the rewrite: its git blob id (SHA-1 of `blob <size>\0` and the bytes) is in the list the operator takes from the clone at runbook step 0.
That history held the same text, so the raw copy holds nothing the repository did not; it must be taken before the rewrite, because the rewrite is exactly what removes the original text from the history.
A recording is never matched by a blob and a text file never by an annex key: a recording is not text in the history (it is an annex pointer there), and a text file is no annex key.
On nm000112 every raw recording version has the size of an annex key and every raw text version was measured to hash to a blob of the history, so the rule is expected to pass there; nm000114's text was not measured.

**How it is built.**
The plan records every raw copy with every version (id and size) and every delete marker (`rawCopies`), sorted by name and counted on its line (`rawCopies=N versions=V markers=M`, there even when 0, which is how the screen from inside after the deletion, runbook step 16, shows that none is left); a name in the annex key space that does not parse is `objects-bad-key`, now for any extension (it used to be checked for recordings only), and so is a name no S3 call can carry: one with a control character (U+0000 to U+001F, U+007F to U+009F, U+FFFE, U+FFFF; carriage return among them), which no `DeleteObjects` body can name, or a lone surrogate (neither occurs on nm000112 or nm000114, read on 2026-10-06).
The hash stage's `raw-hash` streams each raw version at its version id on the hash host and records its sha256 and git blob id (`raw-hashes.json`, bound to the plan by sha256); a byte count other than the plan's size is recorded as a fixed word, never with a digest, and no name is ever printed, because a name is a file path.
`s3-scrub raw-verify` compares and writes `raw-verified.json`, bound to the plan, the digests and the blob list, only when every raw version matches; the names that do not match go to a private file, never to the terminal.

**Deletion order, and what refuses.**
`delete-old` requires `raw-verified.json` for this plan, with the plan's own counts and with matched keys that are keys of the plan, for a plan with raw copies (`raw-copies-unverified`), in the dry run too; it reads working files only, so it is checked with the other proofs, before the bucket is read.
Each matched key the run does not replace must be current at its size (`raw-duplicate-missing`), listed with every other refusal of the bucket.
It refuses any raw version or marker the plan did not record, and any non-annex name it did not list (`raw-copy-not-in-plan`; a raw recording it did not list is `unplanned-recording`), because their bytes were never compared; a plan made without raw copies refuses a raw object the same way.
It deletes every raw version first, with the governance bypass (the raw text is locked like the recordings), and every raw delete marker after, in requests of their own and only for a name with no version left: a raw recording is an original hidden by its marker, and removing the marker while a version stays would make the original current.
`--max-delete` and the plan's own count cover the raw versions and markers with the old keys'.
The final authoritative listing must show zero versions and zero markers under every raw name and no non-annex name under `objects/` but `annex-uuid`; otherwise exit 5 and no `deleted.json`, which records `rawVersions` and `rawMarkers` when the plan had raw copies, and the ledger line carries them as `raw_versions` and `raw_markers`.

## Amendment 2026-10-07 (#1610): a git tag that was never a published version

The fresh-clone verify required the repository's tag names to equal the S3 plan's tags (the versions that have a manifest), and nm000112 has a git tag and a GitHub release, `v1.1.1`, that never had one, so runbook step 14 stopped with `tag-names-not-plan` and blocked steps 15a and 15b although every key of that tag's tree was in the plan.
The rule is that `git-scrub verify --fresh-clone --allow-tag NAME` accepts a version tag by name, for that run only, recorded in the proof as `allowedTags`, and covers the name check only: the tag's tree is scanned like every other ref's, a name the repository lacks is `allowed-tag-missing`, and the flag is refused with `--before`.

## Build status

Built in Phase 2 (PR #1625, issue #1612): the S3 stages (`plan`, `assemble`, `verify`, `zarr`, `drop-archives`, `delete-old`, `zarr-public`, `canary`), the hash stage, the git stages (`snapshot`, `rewrite`, `verify`, `annex-registry`), the ruleset switch, the git plan, the ledger file and object, the shared header scrub, and the runbook.
Built on 2026-10-06 for the raw copies (amendment of that date): the plan's `rawCopies`, the hash stage's `raw-hash`, `s3-scrub raw-verify`, and their checks in `delete-old` and the ledger.
The two deleting stages, `drop-archives` and `delete-old`, check the proofs of every copy for themselves and report every refusal at once (runbook steps 15a and 15b); neither is left to the operator.
The maintainer's go, and the real-bucket checklist run with the current checkout (the canary among it), are the preconditions of an irreversible step that no tool checks.

**NOT BUILT in Phase 2, with the phase that owns each** (phases and issues from epic #1610):

| Claim | Status | Owner |
|---|---|---|
| Suppress workflow dispatch for the dataset | **decided 2026-10-06, no code**: for a short window the runbook disables `run-version-doi.yml`, `run-enrichment.yml` and `run-bids-validation.yml` in `nemarDatasets/.github`, and GitHub Actions on a repository whose own legacy workflows would run (runbook steps 8b and 9b); suppression per dataset in code stays not built | the maintainer's decision of 2026-10-06; a code form, should one be wanted, needs its own sub-issue |
| Pause the dataset's Zarr queue, remove the uploader's write access | not built; while private, the queue parks the dataset as `unlisted` | none in the phase list |
| The purge list, and its readers in import copy, recovery, registration and the availability count | not built | none for the list and those readers; the publication gate is Phase 4 (#1614) and the importer's prepare step is Phase 7 (#1618) |
| The ledger's count and pointer on the catalog row | not built | none in the phase list |
| Remap `zarr_source_commit` and the index `source_commit` | not built; the next reconversion repairs them | none; Phase 8 (#1626) changes the converter but does not list it |
| The importer scrubs in place on every import and re-pull | not built | Phase 7 (#1618) |
| `identifier_screen`, the publication gate | built in Phase 4 (#1614, ADR 0086) | Phase 4 (#1614) |
| The converter never writes subject members, and a fleet-wide strip of existing stores | the converter: built in Phase 8 (#1627, release 0.10.15); the strip of stores converted before it: not built | Phase 8 (#1626) |
| The uploader's preflight, admin triage | the preflight: built in Phase 3 (#1613, ADR 0087); admin triage: not built | Phases 3 (#1613) and 6 (#1616) |
| The scheduled sweep | built in Phase 5 (#1615, ADR 0088): it reports and never repairs | Phase 5 (#1615) |

**Deferred inside Phase 2, none a blocker for the first real run on nm000186:**

- **Assembling an orphan recording (review item S6, full form).**
  A key the S3 plan scrubs that no commit's pointer or symlink names would be assembled with `gitReferenced: false` in the keymap, and the rewrite would accept flagged entries.
  That changes the keymap format, `assemble`, the Python rewrite and `delete-old`'s keymap check, so it is not built.
  Today such a key stops the git plan early with `orphan-key` (before, it stopped the rewrite late with `keymap-key-never-seen`).
- **The 88-store test through the real converter (review item T8a).**
  biosigIO 1.2.10, the converter's pin, was not installable without the network, so the test builds the stores from the census by hand (and names biosigIO 1.2.10 in a comment); it has not run end to end through the converter.
- **`--prune-degenerate never`** of the rewrite (review item T9) is not tested separately: with `--prune-empty never` and no pruned paths in the fixtures it cannot be observed, and a dedicated fixture would be needed.
- **The `KNOWN_BENIGN` extension** for biosigIO's four conditional flags is the maintainer's decision; until it is made, such a store refuses until `--allow-member` names the flag.

The stand-in is not S3, and the items only the real bucket and GitHub can prove are the real-bucket checklist of the runbook.
An earlier canary, without the conditional-write steps, passed against the real bucket on 2026-10-04; the checklist has not run with the current tools, and it must run before the first real execute.

## Amendment 2026-10-06 (#1618): the importer's scrub is built

The row "The importer scrubs in place on every import and re-pull" of the build-status table is built by [ADR 0089](0089-an-import-scrubs-before-it-copies-and-waits-for-the-identifier-screen.md): prepare applies this ADR's header rule, the JSON rule of the history rewrite and the provenance sentences, retires each replaced key the way `annex-registry` does, and writes an `import-scrubbed` ledger line.
The purge list itself is still not built. The importer reads the dead marks in the dataset's git-annex branch, which `annex-registry` and the importer write, and never copies a key marked dead; the list as a document with a catalog pointer, and its readers in recovery, registration and the availability count, keep the owner this table gives them: none.

## Amendment 2026-10-07 (release 0.10.15): the gate, the preflight and the converter are built

The rows `identifier_screen`, the uploader's preflight and the converter of the build-status table are built by [ADR 0086](0086-publication-requests-are-screened-for-identifiers-in-ci-and-the-admin-mail-waits-for-the-verdict.md), [ADR 0087](0087-the-upload-preflight-screens-locally-refuses-direct-identifiers-and-is-never-trusted.md) and #1627.
Since biosigIO 1.2.11 the converter writes every store with `exclude_subject_info` and refuses to convert without it, so a reconversion no longer writes the removed members.
The fleet-wide strip of stores converted before it, admin triage and the purge list's readers keep the owners the table gives them.
Two corrections to the text above.
The publication gate is not a publication step named `identifier_screen` before `s3_public_read`: it is `screenStateGate` at approval and on resume until `s3_public_read`, as ADR 0086 records.
And issue #1616 became the acquisition-date warning (ADR 0090), not admin triage, which ADR 0090 leaves to be done outside the repository.

## Amendment 2026-10-18 (#1837): a fifth technical flag

The converter's partial-frame opt-in writes a fifth technical flag when it reads a BrainVision file that ends in a partial frame and declares no positive `DataPoints` count: `brainvision_dropped_bytes`, the number of bytes dropped. The count in the Allowed bullet above is five, not four: `channel_labels_deduplicated`, `brainvision_header_recovered`, `eeglab_fdt_recovered`, `edf_tolerant_read` and `brainvision_dropped_bytes`.

The verdict stands. None of the five is in `KNOWN_BENIGN`, so a store that carries one refuses until `--allow-member` names it. Whether to add them to the list is still the maintainer's decision; adding them would change the verdict and would need a superseding ADR.
