# Runbook: scrub a published dataset in place

Operational steps for [ADR 0085](decisions/0085-a-privacy-correction-scrubs-every-version-in-place.md).
One dataset at a time, the smallest one first.
Every stage that reads or deletes is a dry run unless a command carries `--execute`; the few that write a local file without it (`git-scrub snapshot` and `rewrite`, `build-git-plan.ts`, `ledger-cli.ts` append) write only to the working directory and can be redone, and nothing irreversible happens before step 9.
Four steps are irreversible, and each sits in a marked box: the force-push of the rewritten history (step 9), the deletion of the archives and of the old bytes (steps 15a and 15b), and making the dataset public again (step 16).
A box needs the maintainer's go for that dataset, in exact words, before its `--execute` is typed (see "Boxes and the go").
Opening the dispatch window (step 8b) can be undone, but it pauses three central workflows for every dataset repository, so it needs a go too.

**The working directory holds file names that may be identifying (the git plan, the clone), so it is private (`chmod 700`) and is deleted when the dataset is done.**
Nothing printed or written by any stage is a participant value.
The one place values are read is the names-only probe in "Before each dataset", and it prints member names, never values.

## Contents

Step numbers 0 to 17 are fixed, because code comments cite them; a step added later takes a letter after the step it follows.

- Setup; Boxes and the go; Exit codes; Files in the working directory; What a copy of a recording can be; What a push sets off; Real-bucket checklist; Before each dataset (item 7: delete the merged branches before the clone).
- Steps 0 to 8, one dataset at a time: clone, plan, git plan, hash, assemble, verify, sanity, rewrite, register keys.
- Step 5b: hash and verify the raw copies (only for a dataset whose plan has any: nm000112 and nm000114).
- Step 8b: open the dispatch window, once per batch.
- Step 8c: a mirror's import is quiet (`on` datasets only).
- Step 9: switch the repository (box), for every dataset of the batch inside the window.
- Step 9b: close the dispatch window, once per batch, with its checklist.
- Steps 10 to 14: Zarr, a look at the archives, manifests and records, ledger, verify while private.
- Step 14b: the Zarr stores are the ones the proof covers, and the converter is quiet.
- Steps 15a and 15b: drop the archives, delete the old bytes (boxes).
- Step 15c: rebuild the archive, before the flip.
- Step 16: screen from inside (with the census of prefixes nothing else lists), make public (box), verify from outside.
- Step 17: afterwards.
- If a stage is killed; Abort points and rollback; Order of datasets; Residuals; Appendix: what a push fires.

## Setup

```bash
D=nm000186                  # the dataset id
W=$HOME/scrub-work/$D       # the working directory; no spaces in the path
T=scripts/scrub             # the tools; run every command from the root of a checkout of the merged branch
mkdir -p -m 700 "$W"
```

**Prerequisites**, on the machine that runs the stages:

- `bun`, `uv` (the rewrite runs `uv run --with git-filter-repo==2.47.0`, so uv must be able to fetch or have cached that version), `git`, `git-annex`, `jq`, `curl`, and `gh` as an org admin (`switch.ts` takes its token from `GITHUB_TOKEN` or `gh auth token`).
- **`aws` CLI 2.23.0 or later.**
  `s3-scrub.ts` (every command except `zarr-public` and `raw-verify`) and `ledger-cli.ts publish` run `aws --version` first and refuse an older CLI (`aws-cli-too-old`) or one whose version cannot be read (`aws-cli-version-unknown`), both exit 3 with nothing attempted.
  The hash host needs the same CLI for its default source command, although `hash_stage.py` does not check.
- Credentials are the ambient `aws login` session (short-lived `ASIA` credentials).
  A long-lived `AKIA` key in the environment is refused (`long-lived-key-in-environment`).
  The S3 tools resolve the session once and share it across every `aws` call (`cliCredentialSource`), because parallel `aws` processes race on the login session's single-use refresh token.
  So do not `export` credentials in the shell that runs the TypeScript tools: a key already in the environment is used as it is, and it expires.
- The hash host (a host with fast reads from S3; Hallu in the maintainers' setup) needs `python3` 3.12, the `aws` CLI, and the host's own read-only AWS credentials.
- The suites pass on the checkout: `NEMAR_REQUIRE_SCRUB_TOOLS=1 bun run test:scrub` (the variable makes a missing tool a failure, not a skip).
  One file: `bun test --path-ignore-patterns=x test/scrub/<file>.test.ts`, because `bunfig.toml` keeps `test/scrub` out of a bare `bun test` and hides even an explicit path.

Every tool prints counts and fixed words only, with one exception: `hash_stage.py` with a custom `--source-cmd` prints the last 200 characters of that command's standard error when it fails, so a source command must not print a value there.
`s3-scrub.ts`, `git-scrub.ts` and `hash_stage.py` print their usage with `--help`; the others print theirs on a usage error.
A dataset with raw copies (step 1) puts their names, which are file paths, in `plan.json`, `raw-hashes.json` and `raw-unmatched.json`; those stay in `$W` and on the hash host, and are never printed.
A bad flag is exit 2 everywhere.

## Boxes and the go

An **irreversible** step is one whose result cannot be undone from what the tools keep.
Each box below lists what it destroys, the checks to make by hand (the tool checks the rest, and a dry run shows all of its refusals at once before `--execute` is typed), and the words.

The go is a sentence the maintainer says for this dataset and this step:

```
GO <step> <dataset> <plan-id>
```

where `<plan-id>` is `shasum -a 256 $W/plan.json | cut -c1-12` (`sha256sum` on Linux).
The plan-id ties the go to one plan, so a go cannot be reused for another dataset or after a re-plan.
For example, `GO delete-old nm000186 3f9a1c0b27de`.
The steps are `window`, `switch`, `drop-archives`, `delete-old` and `public`, and each needs its own go.
`window` is not irreversible, but it disables three workflows that every dataset repository depends on (step 8b), so the maintainer gives it for each dataset of the batch, like the others.

Record each go twice before acting on it: append the line and the date to `$W/go.txt`, and post the same line as a comment on the epic issue (nemarOrg/nemar-cli#1610), which is public and carries no value.
The ledger records each step afterwards (`--actor` is the person who ran it), but it has no field for who gave the go and it refuses free text by design (ADR 0036), so the go itself cannot be written into a ledger line.
`$W` is deleted at the end, so the epic comment is the record that lasts.

The tools add their own words: `--confirm-dataset $D` on `drop-archives` and `delete-old` (the dataset id typed again, required even for the dry run), and the prompt of `nemar admin repo public`.

## Exit codes

| Tool | 0 | 1 | 2 | 3 | 4 | 5 | Signals |
|---|---|---|---|---|---|---|---|
| `s3-scrub.ts` | ok | a stage failed | usage | refused (a precondition or proof is missing or stale) | unreadable (the plan, a Zarr store or the Zarr index is incomplete) | versions or markers remain after a delete | 129, 130, 143 |
| `git-scrub.ts` | done | failed (a command or the tool broke) | usage | refused (nothing was changed) | checked and not clean (`verify` found failures, each a reason with a count, `provenance-unannotated` among them, listed in steps 7 and 14; or `annex-registry`'s read-back disagrees) | | |
| `build-git-plan.ts` | plan written | failed | usage | refused (no plan written) | | | |
| `switch.ts` | done | failed (a push failed part way), or `check` found a ruleset that differs | usage | refused (nothing changed) | | a ruleset could not be restored | 129, 130, 143 after restoring |
| `hash_stage.py` | all done and verified | an object failed | usage | refused (an input does not match the contract, or `patches-stale`) | `--limit` stopped with keys left | | 129, 130, 143 |
| `ledger-cli.ts` | done | failed | usage | refused (nothing written) | written but not proven: look at the object now | | 129, 130, 143 |
| `identifier-fleet-scan.ts` | done | | usage | the run was stopped (a server was struggling) | | | |

Each step below says which exit continues; a nonzero exit is never "close enough".
`s3-scrub.ts raw-verify` exits 1 when a raw version did not match (`raw-verify: FAILED ...`) and 3 when an input is missing or stale; `hash_stage.py raw-hash` exits as `compute` does, 4 meaning `--limit` left raw versions to hash (step 5b).
`raw-verify` reads no S3 object, so it skips the `aws` version check.

`drop-archives` and `delete-old` evaluate every refusal before they stop, so one dry run lists them all.
On stdout there is one line per refusal, `<stage>: refused <word>: <what triggered it>` (a count, a file name or a tag, never a value), in a fixed order.
The stop line on stderr joins the words with `+`, for example `s3-scrub: archives-not-dropped+history-remains`; with one refusal it is the word alone, and the exit is 3 either way.

## Files in the working directory

| File | Written by | Needed by |
|---|---|---|
| `plan.json`, `patches.json` | step 1 (`patches.json` first; `plan.json` names its sha256 as `patchesSha256`); for a dataset with raw copies `plan.json` also holds their names, which are file paths | every later stage |
| `hashes.json` | step 3, on the hash host | step 4 |
| `git-blobs.txt` | step 0, from the clone BEFORE the rewrite (only for a dataset with raw copies) | step 5b (`raw-verify`) |
| `raw-hashes.json` | step 5b, on the hash host (`raw-hash`); it names the sha256 of `plan.json` and holds raw names | step 5b (`raw-verify`) |
| `raw-verified.json`, `raw-unmatched.json` | step 5b (`raw-verify`; the second only when a raw version did not match, with the names) | step 15b (the first); a person (the second) |
| `assembled.json`, `keymap.json` | step 4 | steps 5, 7, 8, 14, 15a, 15b |
| `verified.json` | step 5 | steps 15a and 15b |
| `new-hash-verified.json` | step 5, on the hash host | steps 15a and 15b |
| `git-plan.json`, `git-plan.json.skipped.json`, `git-plan.report.json` | step 2 | steps 7, 13, 14; steps 15a and 15b compare `git-plan.json`, when it is here, with the git proof |
| `before.json` | step 7 | steps 7 (local verify) and 9 (snapshot) |
| `git-verified.json` | step 7 (mode `local`), then step 14 (mode `fresh-clone`, which overwrites it) | steps 15a and 15b need the `fresh-clone` one |
| `ruleset.json` | step 9 | step 9 (switch, check, restore) |
| `zarr-plan.json`, `zarr-verified.json`, `zarr-unknown-members.json` | step 10 | steps 15a and 15b (the first two) and 16 (`zarr-public`) |
| `archives-dropped.json` | step 15a | the record only |
| `deleted.json` | step 15b | step 17 (the ledger) |
| `ledger.jsonl` | step 13 | steps 13 and 17 |
| `original.bundle` | step 0 | rollback |
| `actions-before.json`, `doi-before.txt` | step 8b | steps 9b and 15c |
| `zarr-roots-now.txt`, `zarr-roots-proof.txt` | step 14b | the record only |
| `staging-prefixes.txt` | step 16 | step 16 |
| `go.txt` | by hand: each go, each branch deleted before step 0, the window's start (`T0`) and end (`T1`) | the record |

Every file is written atomically (a temp file in the same directory, then a rename) with mode 0600.
A file that exists and cannot be read is `<name>-unreadable` (exit 1); `<name>-missing` means it does not exist (exit 3).

**Files from an older version of the tools are refused.**
A `plan.json` made before `patchesSha256` existed (the read-only plans of 2026-10-04 are such files) is refused by `assemble`, `verify` and the hash stage as `patches-stale` (exit 3): plan again, which is read-only.
A re-plan is refused over an existing `assembled.json` (`assembled-exists`), because it would orphan an assembly; abandon the assembly first (see "Abort points and rollback").
A `zarr-verified.json` from the older Zarr stage has no `stores` or `allowedMembers` and does not parse: `drop-archives` and `delete-old` refuse it (`zarr-not-scrubbed`) and `zarr-public` refuses it (`zarr-verified.json-invalid`); run the zarr stage again.
A `before.json` or a switch snapshot without `originTips` is refused (`before-invalid` by `switch.ts snapshot`, `snapshot-invalid` by `switch.ts switch`, `refused: contract` by `git-scrub verify`), and a before file cannot be taken after the rewrite (`snapshot-after-rewrite`), so a clone the older tool rewrote is cloned again and rewritten again, with `original.bundle` as the way back.
A `ledger.jsonl` line written by the older tool with `old-versions-deleted` and a bare verification no longer validates; the line is appended again from `deleted.json` (step 17).
A `git-plan.json` made before 2026-10-06 sets the provenance file's `privacy_correction` only when files are dropped, so on a dataset scrubbed only in place step 7 refuses the rewrite it made (`provenance-unannotated`; nm000186's first run).
Plan again from a clone of the history before the rewrite (step 0; the plan refuses a rewritten clone as `orphan-key`, because its pointers name only new keys), then snapshot, rewrite and verify that clone (step 7); `keymap.json` and everything before it stand.
A `git-verified.json` written before the same date has no `provenanceHashesKept` or `provenanceBlobsKept` count and is still accepted: that verify allowed no old hash anywhere, a stricter check than today's.

## What a copy of a recording can be

A scrub is only complete when every copy NEMAR controls is clean.
Measured in the real bucket on 2026-10-04 and 2026-10-05, a dataset has these:

| Where | What it holds | Handled by |
|---|---|---|
| `D/objects/` | the recordings, locked 100 years | steps 1 to 6, 15b |
| `D/objects/<path>` (raw copies, nm000112 and nm000114, read on 2026-10-06) | a legacy import uploaded the whole BIDS tree by PATH, from a Mac, next to the annex keys: the original recordings (`.bdf` on nm000112, 123 names; `.edf` on nm000114, 181 names with 328 versions), every one behind a current delete marker and unlocked, and the text files as they were before the rewrite blanks them (TSV, JSON, `README.md`, `.gitignore`, `code/`, AppleDouble `._*` files; 624 names on nm000112, 435 on nm000114, one version each), current and locked GOVERNANCE 100 years (four TSV names of nm000112 are behind a delete marker too). Every raw recording version has the size of an annex key of its dataset. `annex-uuid` (36 bytes, the special remote's marker) is the one non-annex name every dataset has: it is not a raw copy and stays | steps 0 (blob list), 1, 5b, 15b, 16 |
| GitHub history | annex pointers, inline JSON, file names; in a `sourcedata/` mirror, `sourcedata/sourcedata_provenance.json` lists the sha256 of each upstream original, which stays as provenance with a `privacy_correction` sentence (ADR 0085) | steps 2 and 7 to 9 |
| `D/zarr/**/<store>.zarr/zarr.json` | the subject and operator members the converter mirrors from the EDF or BDF header into `attributes.recording_metadata`: `patientcode`, `birthdate`, `gender`, `patient_name`, `patient_additional`, `admincode`, `technician`, `equipment`, `recording_additional` (the removal set, `EDF_MIRROR_MEMBERS`), plus every key the scanner calls an identifier. Only the technical members stay (`startdate`, `filetype`, `number_of_signals`, `file_duration`, `datarecord_duration`, `source_file`, `source_format`, `streamed`, `channels_tsv_units`). Not locked | steps 10 and 15b |
| `D/archives/*.zip` | the original recordings, zipped | steps 11, 15a and 16 |
| `D/version/<tag>.json` | keys, paths and checksums | steps 12 and 15b |
| `D/version/<tag>-summary.json` | entities, signal summaries, provenance; no header field (checked by key name) | regenerated with the manifest in step 12 |
| `D/version/<tag>-records.json` | the same kind of content, built from the tag's tree; checked by key name on 2026-10-04 | regenerated by hand in step 12 (a version-DOI run regenerates it too, after a successful publish, which the window of step 8b prevents), and its old version is pruned in step 15b |
| `D/qa/`, `D/staging/`, `staging/D/<branch>/`, `staging/pr-<N>/D/` | QA output copied from Hallu; an import's staging area; pull-request staging areas | listed and counted in step 16; nothing here changes them |
| `D/zarr/index.json` | `failures[].detail` and `pending[].last_error`: the first line of a converter exception's text | counted in step 16; Residuals |
| Zenodo backup deposits | a draft holding GitHub's zip of the tag's git tree (pointer files, inline JSON, file names; never a recording), made by a version-DOI run when a Zenodo key is configured, never for an `on` dataset | not changed by this procedure: Residuals |
| GitHub pull-request refs and cached views | the pre-scrub commits | not removed: Residuals (decision of 2026-10-06) |
| Hallu (the SCCN host) | a clone with annexed content and the archive zip of every public `nm` dataset | not removed: Residuals (decision of 2026-10-06) |

**Decision of 2026-10-06 (the maintainer) on the raw copies: "Delete the raw copies after verifying they match."**
A raw recording is an original, header and all, and a raw text file holds the values the rewrite blanks, so both go at step 15b, like the old annex keys.
They go only once each raw VERSION is shown to duplicate content NEMAR keeps elsewhere (step 5b): a raw recording must be byte for byte an annex key of the plan (its sha256 and size), and any other raw file must be a blob of the repository's history from before the rewrite.
Anything that is not shown to match stops `delete-old` (ADR 0085, amendment of 2026-10-06 on raw copies).

The principle behind the Zarr row, from the maintainer (2026-10-05): a store holds the data and the events plus channel names, types and units and technical recording metadata, and says nothing about the subject.
Subject and phenotype information (age, sex, patient code, birth date, name, additional patient text) lives at dataset scope, and `participants.tsv` is the one canonical place for it.
So `gender` is removed from a store although sex is neither a name nor a date: the scrubbed header's patient field says nothing about sex, and the store must say no more than the header does.

## What a push sets off

The Worker answers every push to a dataset repository (`POST /webhooks/github`), and a pushed repository can also run workflows of its own.
Left alone, the force-push of step 9 sets off, for each moved `v*` tag, the whole publication fan-out: a version-DOI run, which refreshes the enrichment, publishes the version DOI (and so dispatches the manifest job, and can upload a Zenodo backup), then dispatches the archive and records jobs.
The push event's `forced` field is never read, so a moved tag looks like a new one.
The appendix lists every job, what it writes and what its public log shows.
No tool in this repository suppresses dispatch, pauses the Zarr queue or removes the uploader's write access (ADR 0085 lists these as not built).

**Decision of 2026-10-06 (the maintainer): suppress dispatch by hand, for a short window (step 8b).**

- The three central workflows the Worker dispatches on a push, `run-version-doi.yml`, `run-enrichment.yml` and `run-bids-validation.yml` in `nemarDatasets/.github`, are disabled for the window, so a dispatch to them starts nothing.
- GitHub Actions is disabled for the window on each repository of the batch whose `main` or any tag still carries a legacy per-repository workflow (`version-doi.yml`, `generate-archive.yml`, `llm-enrichment.yml`): a tag push runs the workflow files of the pushed commit, which disabling the central workflows does not reach.
- `generate-manifest.yml`, `generate-records.yml` and `run-generate-archive.yml` stay enabled: on a push only a version-DOI run dispatches them, and steps 12 and 15c dispatch them by hand.

So during the window a push sets off nothing, and afterwards:

- The manifests and records are regenerated by hand in step 12, and the archive in step 15c.
- **A push to `main` after the window** (the ledger commits of steps 13 and 17) runs the repository's BIDS validation shim, which dispatches `run-bids-validation.yml`: it validates the scrubbed tree, prints the validator's whole JSON to the public log of `nemarDatasets/.github`, and posts a check-run with up to 50 error rows.
  Nothing else fires: enrichment is dispatched only when `README.md` or `dataset_description.json` is touched (`ENRICHMENT_TRIGGER_PATHS`), and the ledger commit touches neither.
- **Zarr is not dispatched from the webhook.**
  The converter runs on the Hallu cron (ADR 0029).
  While the dataset is private the queue's `reconcile` parks it as `unlisted` (`scripts/zarr/zarr_queue.py`), so it is not converted; a row already `inprogress` is finished by its own converter.
  Before step 10, confirm on Hallu that no queue row for `D` is `inprogress` (the read-only query is in step 14b).
- `zarr.nemar.org` gates on visibility before it reads any cache, so it serves nothing for a private dataset.
  Its edge copy of a `zarr.json` lives `max-age=60, stale-while-revalidate=300` (so at least 6 minutes) when the URL carries no `?v=` token, and `max-age=86400, stale-while-revalidate=86400` when it does (`cacheControlFor` in `backend/src/routes/zarr-data.ts`).
  A cache purge is a no-op: the Cloudflare token and zone id are unset in production, as that file documents.

Step 9b confirms that nothing ran for the dataset during the window, and steps 12 and 15c that what they dispatched by hand finished.

## Real-bucket checklist

The local S3 stand-in (`test/scrub/helpers/s3-standin.ts`) encodes what its authors believe S3 does.
The first multipart canary found that real S3 refuses an `UploadPart` without a checksum under Object Lock, which the stand-in had not said.
So each item below is assumed, not measured, until it has been run against the real bucket and GitHub: once before the first real `--execute` on any dataset (before step 4), and again after any change to an S3 call.
Use only the test prefixes: `nm099999` or a dev ephemeral sandbox `xx090000` to `xx098999`, never a live dataset, a production sandbox or the exemplar fleet.
Record the outcome of each item on the epic.

```bash
aws login                                  # a fresh session; the checklist is short
PC=nm099999/canary-$(date +%s)-tool/       # the prefix for the canary stage
PM=nm099999/canary-$(date +%s)-manual/     # the prefix for the manual items; never share one with the stage
mkdir -p -m 700 "$W/check" && printf 'a\n' > "$W/check/a.txt"
```

**C1. The canary stage, both modes.**
An earlier canary, without the conditional-write steps, passed against the real bucket on 2026-10-04, so run the current one.
It proves: the lock holds without the bypass and gives way with it; an `If-Match` put and get with the current ETag succeed, and with a stale one are refused (`PreconditionFailed`); an `UploadPart` and `UploadPartCopy` under a lock set at `CreateMultipartUpload`; the checksum headers the CLI sends over HTTPS (the stand-in sees plain HTTP, and real S3 may take `aws-chunked` bodies with trailing checksums); that an unlocked object deletes without the bypass, which also shows that no default bucket retention applies; and that the final listing is empty.

```bash
bun run $T/s3/s3-scrub.ts canary --prefix $PC --execute
bun run $T/s3/s3-scrub.ts canary --prefix $PC --execute --multipart
bun run $T/s3/s3-scrub.ts canary --prefix $PC --execute --batch
```

Expected, each run exit 0, with these lines in order:

```
canary: put a locked probe object
canary: a delete without the bypass was refused (the lock holds)
canary: a delete with the bypass succeeded
canary: a put conditional on the current ETag succeeded
canary: a put and a get conditional on a stale ETag were refused (precondition)
canary: the unlocked versions were deleted by id without the bypass
canary: zero versions and zero delete markers remain under the prefix
```

With `--multipart`, also, before the last line above, `canary: multipart object built with the lock set at create`, and the without-bypass and with-bypass pair twice more.
With `--batch`, also, before the last line above (`zero versions and zero delete markers remain`), the proof of `DeleteObjects` that steps 15a and 15b rely on (a batch answers 200 whatever happened to an item, so the stand-in's belief about it is checked here, on the real bucket):

```
canary: a batch delete without the bypass removed 3 unlocked versions (one a delete marker, one with XML characters in its key) and refused the 2 locked ones
canary: a batch delete with the bypass removed the 2 locked versions
canary: a batch naming an already deleted version answered deleted
```

The last line is a record, not a pass or fail: it says what a resend of an already deleted version answers (a retry after a lost answer sends such versions again).
Measured against the real bucket on 2026-10-06 (aws-cli 2.x, `nm099999/canary-*-batch/`, every line above printed, the independent listing empty afterwards): a locked version is refused per item inside a 200 and stays, a delete marker and a key with `&`, a space and angle brackets are removed in the same request, the bypass removes the locked ones, and an already deleted version answers `deleted`.
The two others are the proof: a locked version is refused per item inside a 200 and stays, and the bypass removes it.
Any other word is a stop: `batch-lock-not-enforced`, `batch-bypass-denied`, `batch-unexpected:...`, `batch-result-wrong`, `batch-marker-missing`, `lock-not-enforced`, `bypass-denied`, `conditional-put-not-enforced`, `conditional-get-not-enforced`, `conditional-put-failed:...`, `unlocked-delete-refused:...`, `multipart-lock-missing`, `canary-remainder` (exit 5), or another fixed word such as `prefix-not-canary` (exit 3), `multipart-size-wrong`, `multipart-no-version`, `conditional-put-unexpected:...` or a word followed by `+abort-failed`.
Then confirm independently that nothing is left; both listings must be empty:

```bash
aws s3api list-object-versions --bucket nemar --prefix $PC
aws s3api list-multipart-uploads --bucket nemar --prefix $PC
```

**C2. `If-None-Match` on a put.**
`ledger-cli.ts publish` uses it for a first publish, and the canary does not.

```bash
aws s3api put-object --bucket nemar --key ${PM}none-match.txt --body $W/check/a.txt --if-none-match '*'   # expect success and a VersionId
aws s3api put-object --bucket nemar --key ${PM}none-match.txt --body $W/check/a.txt --if-none-match '*'   # expect a nonzero exit: PreconditionFailed (412)
```

**C3. A conflicting write in flight (`409 ConditionalRequestConflict`).**
No command provokes it on demand.
The tools map it to the same word as `412` (`precondition-failed`), so the stage reports `changed-concurrently` (zarr) or `remote-ledger-changed` (ledger) and writes nothing.
If it ever appears, the rule is: look at the object, then run the stage again.

**C4. `DeleteObject` of a version id that does not exist.**
The stand-in answers 404 `NoSuchVersion`; real S3 is believed to answer 204.
The code does not depend on either: deletes are counted for the report only, and the final authoritative `ListObjectVersions` decides (`delete-old`, `drop-archives`, the canary).

```bash
V=$(aws s3api put-object --bucket nemar --key ${PM}gone.txt --body $W/check/a.txt --query VersionId --output text)
aws s3api delete-object --bucket nemar --key ${PM}gone.txt --version-id "$V"    # removes it
aws s3api delete-object --bucket nemar --key ${PM}gone.txt --version-id "$V"    # the version is gone now: note exit 0 (204) or NoSuchVersion
```

**C5. `CompleteMultipartUpload` answering 200 with an `<Error>` body.**
The stand-in never does, and no command provokes it.
Every assembly re-reads the new object after completing it, so a silent failure shows as `new-object-missing` or `new-size-mismatch`, but the word does not name the cause.
If it appears: list the open uploads (`aws s3api list-multipart-uploads --bucket nemar --prefix $D/objects/`), abort what is open, and run `assemble` again, which resumes.
C1 with `--multipart` proves the happy path of the same call.

**C6. The anonymous `HEAD` gate** of `delete-old` and `zarr-public`.
The tests use a constant-status local server, not the stand-in.
This bucket denies anonymous `ListBucket`, so a missing key answers 403 as a private one does, and only a key known to exist makes 403 mean private.

```bash
S3=https://nemar.s3.us-east-2.amazonaws.com
curl -s -o /dev/null -w '%{http_code}\n' -I "$S3/<public dataset>/version/<one of its tags>.json"        # expect 200 (the public control)
K=$(aws s3 cp "s3://nemar/$D/version/<one of its tags>.json" - | jq -r '[.files[].key | select(startswith("git:") | not)][0]')
curl -s -o /dev/null -w '%{http_code}\n' -I "$S3/$D/objects/$K"                                          # expect 403 (D is private)
```

Take the control from the public catalog (`https://api.nemar.org/datasets`: a public dataset's `dataset_id` and `latest_version`).
The second request needs an object that exists, so it takes one key from the dataset's own manifest.
Allow a few minutes after any change of visibility: on 2026-10-04 three datasets stayed readable briefly while the bucket policy settled.

**C7. The `aws` CLI's retry policy.**
Every test pins `AWS_MAX_ATTEMPTS=1`, and the tools do not, so on the real bucket the CLI can repeat a conditional put after a timeout.
A repeated `If-Match` put whose first attempt landed gets 412 and is reported as `changed-concurrently` or `remote-ledger-changed`, although nothing else wrote.
That is fail-safe (a refusal, never an overwrite) but the word misleads: read the object, then run the stage again.
See what the CLI will do with `aws configure get retry_mode; aws configure get max_attempts` (empty output means the defaults).

**C8. `ListMultipartUploads`.**
`assemble` uses it to report an upload that a lost `CreateMultipartUpload` answer left open, and it has only run against the stand-in.
The call itself, and the operator's permission for it, are proven with the CLI:

```bash
U=$(aws s3api create-multipart-upload --bucket nemar --key ${PM}mpu.bin --query UploadId --output text)
aws s3api list-multipart-uploads --bucket nemar --prefix $PM --query 'Uploads[].[Key,UploadId]' --output text   # expect one row naming the key and $U
aws s3api abort-multipart-upload --bucket nemar --key ${PM}mpu.bin --upload-id "$U"
aws s3api list-multipart-uploads --bucket nemar --prefix $PM        # expect no Uploads
```

The tool's own parser of that answer is proven only by the stand-in.

**C9. Encryption and cache control on a Zarr rewrite.**
The zarr stage keeps a store root's content type, cache control and server-side encryption (`sse`, `kmsKeyId`) when it rewrites it, which is tested against the stand-in only.
Before the first zarr `--execute`, record what one store root carries, and compare after step 10:

```bash
aws s3api head-object --bucket nemar --key "$D/zarr/<one store>/zarr.json" --query '[ServerSideEncryption,SSEKMSKeyId,ContentType,CacheControl]'
```

Expect the same four values before and after.

**C10. Bucket-wide Object Lock settings.**

```bash
aws s3api get-object-lock-configuration --bucket nemar
```

Expect `ObjectLockEnabled: Enabled` and no `Rule` (no default retention).
A default retention would refuse the unlocked deletes of `drop-archives` and of the prune, version by version, which the stages report but cannot fix.

**C11. GitHub ruleset updates.**
`switch.ts` lifts a ruleset with a `PUT` of the ruleset as `GET` returned it minus its read-only fields, restores it the same way, and reads it back.
Only the real API shows that this is accepted.
On the disposable end-to-end repository, with a clone that has nothing to push, a round trip lifts and restores the rulesets and pushes no ref:

```bash
git clone https://github.com/nemarDatasets/nm099999 $W/check/clone
bun run $T/git/git-scrub.ts snapshot --repo $W/check/clone --out $W/check/before.json
bun run $T/github/switch.ts snapshot --repo nemarDatasets/nm099999 --clone $W/check/clone --before $W/check/before.json --out $W/check/ruleset.json
bun run $T/github/switch.ts switch --repo nemarDatasets/nm099999 --clone $W/check/clone --snapshot $W/check/ruleset.json            # dry run
bun run $T/github/switch.ts switch --repo nemarDatasets/nm099999 --clone $W/check/clone --snapshot $W/check/ruleset.json --execute
bun run $T/github/switch.ts check --repo nemarDatasets/nm099999 --snapshot $W/check/ruleset.json
```

Expect `plan: lift N ruleset(s), push 0 ref(s)`, then `lifted ruleset ...`, `restored N ruleset(s)`, `done: lifted=N pushed=0 restored=N`, and `protection matches the snapshot`.
If it prints `snapshot: 0 ruleset(s)` the repository has no ruleset and this proved nothing.
The snapshot also refuses a repository whose branches or tags are not what the switch expects (`unexpected-remote-head`, `remote-only-tag`); then the check needs another repository that has a tag ruleset.
A force-push of a moved tag is not part of this round trip; step 9 of the first dataset is its first proof, so read its dry run twice.

**Clean up** the manual prefix, and confirm both listings are empty:

```bash
aws s3api list-object-versions --bucket nemar --prefix $PM --output json \
  | jq -r '(.Versions // []) + (.DeleteMarkers // []) | .[] | [.Key, .VersionId] | @tsv' \
  | while IFS="$(printf '\t')" read -r k v; do aws s3api delete-object --bucket nemar --key "$k" --version-id "$v"; done
aws s3api list-object-versions --bucket nemar --prefix $PM
aws s3api list-multipart-uploads --bucket nemar --prefix $PM
rm -rf $W/check
```

## Before each dataset

1. The tooling PR and the docs PRs are merged, and the maintainer has said go for this dataset.
   The first dataset is also the first real run of every stage: take it slowly, and stop at the first word this runbook does not explain.
2. The real-bucket checklist has been run with the current checkout, after the last change to an S3 call.
3. The dataset is private with the bucket-policy exclusion (`nemar admin repo private $D` is the supported transition: the GitHub repository, the bucket policy and the catalog row), verified by C6: an anonymous `HEAD` of one of its objects answers 403, and a public control answers 200.
4. The uploader, and for a mirror the source archive, have been told and asked not to upload over it.
   Nothing here stops an upload: a push the uploader makes during the run is caught by the leases of step 9 (`remote-moved-since-clone`), and a recording written to S3 after the plan is caught by `delete-old` (`unplanned-recording`), as is any raw object (`raw-copy-not-in-plan`).
5. **Read the member names, not the values, of the real Zarr stores**, so the lists in `scripts/scrub/s3/zarr-json.ts` are known to cover what the converter wrote.
   One store:

   ```bash
   S=$(aws s3 cp "s3://nemar/$D/zarr/index.json" - | jq -r '.stores[0].zarr')
   aws s3 cp "s3://nemar/$D/zarr/$S/zarr.json" - | jq -r '(.attributes.recording_metadata // .attributes.recording_info // {}) | keys[]'
   ```

   Every store, as a histogram of names and counts (never a value):

   ```bash
   aws s3 cp "s3://nemar/$D/zarr/index.json" - | jq -r '.stores[].zarr' \
     | while read -r s; do aws s3 cp "s3://nemar/$D/zarr/$s/zarr.json" - | jq -r '(.attributes.recording_metadata // .attributes.recording_info // {}) | keys[]'; done \
     | sort | uniq -c | sort -rn
   ```

   `jq keys` prints names only; never print the object itself.
   For comparison, the census of 2026-10-05 (names only, store roots only):
   - **nm000186**, all 88 store roots: `birthdate`, `patientcode`, `gender` and `equipment` (non-empty in every one); `startdate` (a typed object); `source_file`, `source_format`, `number_of_signals`; empty `filetype`, `file_duration`, `datarecord_duration`; `channels_tsv_units` (an object with `converted`, `kept_importer_unit`, `relabelled`, `units_column_present`); no `technician`, `admincode`, `patient_name`, `patient_additional` or `recording_additional`.
     The real run therefore removes exactly four members from each of the 88 roots (352) and leaves the other eight.
   - **nm000348**, 153 stores (33,250 Zarr keys): only `channels_tsv_units`, `number_of_signals`, `source_file`, `streamed`.
     Nothing to remove, and a clean proof (`found: stores`), not a failure.
   - A name outside the removal set and the allow-list refuses the zarr stage (`unknown-recording-member`, step 10) until a person has looked at it.
     The four technical flags biosigIO writes only when they apply (`channel_labels_deduplicated`, `brainvision_header_recovered`, `eeglab_fdt_recovered`, `edf_tolerant_read`, named in `scripts/zarr/requirements.txt`) are not in the allow-list, so a store with one is refused until `--allow-member NAME` names it; whether to add them to the list is the maintainer's decision. Since release 0.10.15 the converter removes `brainvision_header_recovered` and `eeglab_fdt_recovered` itself (biosigIO's `SUBJECT_INFO_KEYS`), so only a store converted before it carries those two.
6. Know what a push sets off (above).
   And know that the converter of release 0.10.15 (Phase 8, nemarOrg/nemar-cli#1626 and #1627) writes no subject or operator member into a store, but a node still on an older converter writes them again on a reconversion, and `zarr-public` then reports them.
7. **The repository has no branch but `main` and `git-annex`, and this is true before step 0.**
   The switch snapshot of step 9 refuses any other remote head (`unexpected-remote-head`).
   It also leases on what the clone knew (`before.json`'s `originTips` lists every `refs/remotes/origin/*` of the clone), so a branch deleted after the clone makes it refuse `remote-moved-since-clone`: delete before cloning, not just before the push.
   A branch is visible once the repository is public, so leaving one on the pre-scrub commits is not acceptable, unlike a pull-request ref (Residuals).
   Measured on 2026-10-06 with read calls: ten repositories carry `add-sourcedata-original` (nm000149, nm000173, nm000176, nm000186, nm000191, nm000197, nm000200, nm000277, nm000301, nm000340), nm000176 also `complete-sourcedata`, and nm000112 four branches (`fix/bdf-physical-dimension-uV`, `fix/faced-conv-script-uV`, `update/nm000112-mmt8e31n`, `update/nm000112-mmt8fxtu`); every one compared `behind` with `ahead_by` 0, that is, fully merged into `main`.
   The branch rulesets target only the default branch (`~DEFAULT_BRANCH`, read on nm000186 and nm000348), so no ruleset refuses the delete.
   One branch at a time, immediately before deleting it:

   ```bash
   gh api repos/nemarDatasets/$D/branches --paginate --jq '.[].name'                      # the heads now
   B=add-sourcedata-original                                                              # the branch to delete
   gh api "repos/nemarDatasets/$D/compare/main...$B" --jq '[.status, .ahead_by] | @tsv'    # must end in 0: "behind 0" (or "identical 0")
   SHA=$(gh api "repos/nemarDatasets/$D/git/ref/heads/$B" --jq .object.sha)
   printf '%s branch-deleted %s %s %s ahead_by=0\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$D" "$B" "$SHA" >> $W/go.txt
   gh api -X DELETE "repos/nemarDatasets/$D/git/refs/heads/$B"
   ```

   **If `ahead_by` is not 0, STOP and ask**: the branch holds commits that `main` does not, which a deletion would lose and which the rewrite would not cover.
   The delete is outward-facing, so it is done under the maintainer's go for this dataset (item 1), and each one is recorded in `go.txt` as above; the SHA recreates the ref, from `main`'s own history, if that is ever needed before step 9.
   If step 0 has already run, clone again after the deletions (`rm -rf $W/clone $W/original.bundle`, then step 0) and plan the git history again (step 2), both before step 7: the snapshot of step 7 must come from a clone that never knew the branch.

## Steps

### Step 0: Clone

A private working copy, and a normal clone, because the rewrite refuses a tree that is not clean and a `--no-checkout` clone reads as every file deleted:

```bash
git clone https://github.com/nemarDatasets/$D $W/clone && (cd $W/clone && git annex init)
git -C $W/clone bundle create $W/original.bundle --all
```

The bundle holds the original inline content and every ref, so it is private and is deleted with `W`.
It is the way back until step 15b.

**A dataset with raw copies (step 1 says `rawCopies=` more than 0; nm000112 and nm000114) also needs the blob list of the history, now.**
Step 5b proves each raw text file against it, and step 7 rewrites this clone in place, after which the history no longer holds the original text, so the list must come from the clone BEFORE the rewrite (taking it from `original.bundle` cloned again is the same thing):

```bash
git -C $W/clone rev-list --objects --all | awk '{print $1}' \
  | git -C $W/clone cat-file --batch-check='%(objecttype) %(objectname)' \
  | awk '$1=="blob"{print $2}' | sort -u > $W/git-blobs.txt
wc -l < $W/git-blobs.txt          # a count, never zero
```

It holds 40-hex blob ids and nothing else, one per line.
It must come from THIS dataset's clone: `raw-verify` cannot tell whose history a list is, and another dataset's blobs could match a text file this history never held.
Taking it for a dataset without raw copies does no harm; step 5b does not run for one.

### Step 1: Plan (read-only)

```bash
bun run $T/s3/s3-scrub.ts plan --dataset $D --out $W
```

Continue only on exit 0.
The line reads `plan: tags=T keys=K needScrub=N bytesToHash=B unreadable=U rawCopies=R versions=V markers=M`, the raw counts there even when they are 0.
A raw copy is an object under `D/objects/` stored by its path instead of an annex key ("What a copy of a recording can be"); `annex-uuid` is not one and is never counted.
The plan records every raw name with every version (id and size) and every delete marker in `plan.json` (`rawCopies`), and prints counts only, never a name, and with any it adds `plan: raw copies under objects/ by kind: recording=N other=M; ...`.
Raw copies never make the plan incomplete and change nothing about the keys; a plan with any needs step 5b, and the blob list of step 0.
Exit 4 means the plan is incomplete, and no later stage runs on it: a key was unreadable, a manifest named an EDF or BDF held inline in git (`git-inline-recording`), `version/` held a file that is neither a manifest nor a known sibling (`version-dir-unknown-file`), an object under `objects/` is named in the annex key space (`SHA256E-`) but is not an annex key, or has a name no S3 call can carry, a control character such as a carriage return (`objects-bad-key`, whatever its extension; no `DeleteObjects` body can name such a key, so it is a person's to deal with; none on nm000112 or nm000114), or a recording hidden by a delete marker needs a scrub (`masked-needs-scrub`; a recording with markers and no version at all is `markers-only`).
A masked recording (`masked-needs-scrub`, `markers-only`) is a person's decision: the tools never remove a delete marker, so remove it and plan again, or deal with its versions.
The line `plan: unreadable by reason: ...` names each reason with its count.
The keys are the union of every manifest and of a listing of every version and delete marker under `D/objects/`, so a recording that no manifest names, or whose current entry is a delete marker, is still found.
Read the counts: tags, keys, how many need a scrub, bytes to hash.
A plan made with `--tags` is partial, and a plan with any unreadable key is incomplete; assemble, verify, zarr, drop-archives, delete-old and the hash stage all refuse either (`plan-partial`, `plan-has-unreadable`).

### Step 2: Git plan (read-only)

```bash
bun run $T/plan/build-git-plan.ts --repo $W/clone --dataset $D --out $W/git-plan.json --s3-plan $W/plan.json > $W/git-plan.report.json
```

It reads every commit of every ref, not only the tips, and prints one JSON line of counts (`refs`, `commits`, `dropPaths`, `jsonFilesBlanked`, `jsonKeysBlanked`, `provenanceEntriesDropped`, `provenanceAnnotated`, `provenanceReadmeAnnotated`, `s3KeysScrubbed`, `skippedOversizeJson`, `skippedUnparseableJson`, `orphanKeys`, `versions`), which the redirect keeps for step 13.

A dataset that mirrors upstream recordings under `sourcedata/` has `sourcedata/sourcedata_provenance.json`, whose `files` entries carry the `sha256` of each original upstream file.
Those checksums stay, as provenance (ADR 0085), and they are also the hashes of old keys the S3 plan scrubs, because the mirrored copies were the upstream bytes.
Whenever the S3 plan scrubs any key, or a file is dropped, the plan sets `privacy_correction` in that file to a sentence saying what changed and that the checksums describe the original upstream files, not the scrubbed copies, and appends a note on the same terms to `sourcedata/README_sourcedata_provenance.md`.
The sentence and the note say files were removed only when some are dropped, and only then are entries dropped from `files` and the counts recomputed.
The three cases read: scrubbed in place only (the headers were scrubbed in place; the checksums describe the original upstream files, not the scrubbed copies), files removed only (which files went; the remaining checksums describe the original upstream files), and both.
`provenanceAnnotated` and `provenanceReadmeAnnotated` are 1 when the plan did so, and `s3KeysScrubbed` is how many keys the S3 plan scrubs.
Without `--s3-plan` the plan cannot know whether a header was scrubbed, so it refuses a history that has the provenance file or its README (`s3-plan-required`); `s3KeysScrubbed` is `-1` only for a dataset with neither.
Step 7's verify refuses a provenance file that keeps old hashes without a sentence (`provenance-unannotated`); it checks that a sentence is there, not what it says, and the plan's own `set` operation is what binds its words (`json-ops-not-applied`).
Like every appended text, the README note is created in each commit that has no README file yet, including commits from before `sourcedata/` existed, where the file holds only the note (as `CHANGES` is created where it is absent); that is cosmetic and expected.
Exit 3 is a refusal that writes no plan:

- `skipped-json (oversize=N unparseable=M)`: an inline JSON file could not be read in some commit (over 1 MiB, or not UTF-8 JSON), so its identifier keys would never be blanked.
  The paths are in `$W/git-plan.json.skipped.json`.
  Look at them; if a person accepts them unread, run again with `--allow-skipped-json`, and the plan lists them under `skippedJson` (their keys are not blanked).
- `tag-not-semver (N)`: a `v*` tag that is not `vX.Y.Z[-pre]`.
- `orphan-key (N)`: a key the S3 plan scrubs that no commit's pointer or symlink names, so the rewrite would refuse its keymap entry.
  Assembling such a key (an orphan, with `gitReferenced: false` in the keymap) is not built (ADR 0085, deferred items); stop and ask.
- `s3-plan-dataset-mismatch`.
- `s3-plan-required`: the history has `sourcedata/sourcedata_provenance.json` or its README and no `--s3-plan` was given.

Anything outside `sourcedata/` that the scanner flags is for a person to decide, not for the plan.
Read the counts (files dropped, JSON files blanked, provenance entries, and whether the provenance file and its README are annotated).
For a dataset with the provenance file and a nonzero `s3KeysScrubbed`, `provenanceAnnotated` must be 1; a 0 there is a plan step 7 will refuse.

### Step 3: Hash

This reads every object once; the original is verified against its own key in the same pass.
`hash_stage.py` runs where the data is read quickly, so it runs on the hash host, which needs only `hash_stage.py` (standard library plus the `aws` CLI), `plan.json` and `patches.json`.
For a small dataset the host can be this machine, with the credentials frozen for the short run: `eval "$(aws configure export-credentials --format env)"`, in a shell that runs nothing else.
For a large one, copy the inputs, run there, and carry `hashes.json` back (the files hold annex keys, sizes, version ids and patched headers, no value, and for a dataset with raw copies `plan.json` also holds their names, which are file paths; they are 0600):

```bash
H=hallu                                       # an ssh alias for the hash host
ssh $H "mkdir -p -m 700 scrub-work/$D"
scp -p $T/hash/hash_stage.py $W/plan.json $W/patches.json $H:scrub-work/$D/
ssh $H "cd scrub-work/$D && python3 hash_stage.py compute --plan plan.json --patches patches.json --out hashes.json --workers 16"
scp $H:scrub-work/$D/hashes.json $W/hashes.json
```

For a run longer than a session, launch it detached on the host (the form is in the maintainers' memory `hallu-launch-and-self-deploy-lag`), and later run the foreground command again: `hashes.json` is resumed, so it reads nothing more and exits 0 exactly when every key is in it.
Each entry is bound to its patch, so a re-plan with different scanner rules recomputes rather than reusing a stale digest.
`--limit N` reads at most N keys and exits 4 when keys remain; `--timeout`, `--retries`, `--retry-backoff`, `--checkpoint-every` and `--source-cmd` are in `--help`.
Continue only on exit 0.
The stage refuses (exit 3) a partial plan, a plan with an unreadable key, a `patches.json` that is not the one written with `plan.json` (`patches-stale`), and totals that disagree with the keys.
SIGINT, SIGTERM and SIGHUP kill every running source command with its `aws` child, save the finished keys, and exit 130, 143 or 129.

### Step 4: Assemble (admin credentials)

```bash
bun run $T/s3/s3-scrub.ts assemble --dir $W               # dry run: object count, bytes uploaded versus copied server side
bun run $T/s3/s3-scrub.ts assemble --dir $W --execute
```

New keys are created with GOVERNANCE retention at creation.
Nothing is deleted.
It writes `assembled.json` and `keymap.json` only when every object succeeded.
A failed `CreateMultipartUpload` lists the open uploads left on the new key and prints each as `assemble: open upload left by a failed create: key=... uploadId=...`, and the failure word gets `+upload-may-be-open`; a failed abort prints `assemble: abort-failed key=... uploadId=... (...)`.
Uploads are reported, never aborted for you: abort them as in "If a stage is killed", then run assemble again, which finds and keeps what it already made.

### Step 5: Verify

On this machine, `verify` checks sizes, the patched header, sampled ranges, retention, and that the version assembly recorded is still the current version of the new key; it writes `verified.json`:

```bash
bun run $T/s3/s3-scrub.ts verify --dir $W
```

On the hash host, `verify-new` re-reads every NEW object at the version assembly recorded (`newVersionId`, through `aws s3api get-object --version-id`, the body on `/dev/fd/3`) and checks it against its key:

```bash
scp -p $W/assembled.json $H:scrub-work/$D/
ssh $H "cd scrub-work/$D && python3 hash_stage.py verify-new --assembled assembled.json --out new-hash-verified.json --workers 16"
scp $H:scrub-work/$D/new-hash-verified.json $W/new-hash-verified.json
```

When both have passed, remove the host's copy: `ssh $H "rm -rf scrub-work/$D"` (for a dataset with raw copies, after step 5b).
That default source is new: run it once on a small dataset on the host it will run on before trusting it on a large one, since a Linux `/dev/fd` behaves differently from macOS in edge cases.
Both must pass.
`verify` prints `verify: ok ...`, and a failure prints `verify: FAILED ...` with words such as `new-not-current` (someone wrote the new key after assembly), `old-unreadable:<Op>:<class>`, `header-not-patch`, `range-mismatch`, `lock-missing`, `retention-short`.
`verify-new` writes `new-hash-verified.json` only if every object matches, and removes one left by an earlier run.

### Step 5b: Hash and verify the raw copies (only when step 1 counted any)

Skip this step when step 1 printed `rawCopies=0`.
Decided by the maintainer on 2026-10-06: "Delete the raw copies after verifying they match."
Step 15b deletes every raw copy, every version and every delete marker of every name under `D/objects/` that is not an annex key and not `annex-uuid`, and it refuses to unless this step proved, for this `plan.json`, that every raw VERSION duplicates content NEMAR keeps: a raw recording (`.edf`, `.bdf`) must be byte for byte an annex key of the plan, scrubbed or clean (its sha256 is the one the key names, and its size the key's), and any other raw file must be a blob of the repository's history from before the rewrite (its git blob id is in `$W/git-blobs.txt`, step 0).
A recording is compared with the annex keys and never with the blobs, and a text file with the blobs and never with the keys.
The raw recordings of nm000112 hold 33.7 GB, so the hashing runs on the hash host, as step 3 does; `plan.json` there holds the raw names, which are file paths, and the host's copy is removed after.

```bash
scp -p $T/hash/hash_stage.py $W/plan.json $H:scrub-work/$D/        # this plan.json, if step 3 copied an older one
ssh $H "cd scrub-work/$D && python3 hash_stage.py raw-hash --plan plan.json --out raw-hashes.json --workers 16"
scp $H:scrub-work/$D/raw-hashes.json $W/raw-hashes.json
bun run $T/s3/s3-scrub.ts raw-verify --dir $W                      # reads $W/git-blobs.txt; --git-blobs F names another file
```

A `--source-cmd` template (as step 3 can use) gets each value shell-quoted once, for the shell that runs it; a template that hands `{key}` to another shell (`ssh`, `sh -c`) must quote it again for that one, because a raw name is a file path and may hold a quote, a space, `$` or a backtick.

`raw-hash` streams every raw version at its version id (`aws s3api get-object --version-id`, the body on `/dev/fd/3`, as `verify-new` reads; a delete marker holds no bytes and is never read) and records its sha256 and its git blob id, the SHA-1 of `blob <size>\0` and the bytes with the plan's size, computed in the same pass.
A byte count that is not the plan's size is recorded as `size-differs`, never with a digest.
It prints counts and fixed words only (`[i/N] hashed`, `[i/N] FAILED read-failed` or `size-differs`, and `failed by reason: ...`), never a name, and never a read failure's own text, because an `aws` error quotes the key.
`raw-hashes.json` names the sha256 of `plan.json`: a run resumes from one for the same plan (a `size-differs` entry is read again) and refuses one for another plan, another dataset, or with a version the plan does not record (exit 3: move it aside).
Its exits are `compute`'s: 0 every version hashed, 1 a version failed, 3 refused (a plan that is partial or has an unreadable key, raw copies off the contract, a `--source-cmd` that does not name `{version}`), 4 `--limit` stopped with versions left; 129, 130, 143 on a signal, with the finished versions saved.

`raw-verify` reads no S3 object and calls no `aws`.
It prints `raw-verify: ok names=N versions=V markers=M matchedRecordings=R matchedOther=O` and writes `raw-verified.json` (names, versions and markers equal to step 1's; it names the sha256 of `plan.json`, `raw-hashes.json` and `git-blobs.txt`, and lists the annex keys the raw recordings matched, `matchedKeys`, which step 15b checks are still there) only when every raw version matched, and removes an earlier proof first.
Otherwise it exits 1 with `raw-verify: FAILED ... (<reason>=<count>, ...)`, and the names and version ids that did not match go to `$W/raw-unmatched.json` (0600), never to the terminal.
The reasons: `raw-recording-unmatched` (no annex key of the plan has those bytes; an AppleDouble fork of a recording, `._x.bdf`, is kind recording by its name and lands here, because its bytes are no recording's: none on nm000112 or nm000114, whose `._` files are `._.git`, `._.gitignore`, `._README.md` and `._.nemar`), `raw-other-unmatched` (the blob is not in the history's list), `raw-hash-missing` (no digest for a version the plan records: run `raw-hash` again), `raw-size-differs` (the bytes read were not the plan's size), `raw-hash-not-in-plan` (a digest of a version the plan does not record).
A zero-byte raw file (a "folder" key such as `code/`) matches only when the history holds the empty blob (`e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`), that is, when some commit had an empty file; no zero-byte raw object is on nm000112 or nm000114.
It refuses (exit 3) `raw-hashes-stale` (made for another `plan.json`: run `raw-hash` again), `raw-hashes-wrong-dataset`, `raw-hashes.json-missing`, `raw-hashes.json-invalid`, `git-blobs-missing` and `git-blobs-invalid` (a line that is not 40 lowercase hex, a blank line, or no blob at all); `git-blobs-unreadable` is a failure (exit 1).
**Any unmatched version is a stop for a person, with the maintainer**: the decision deletes copies that match, and nothing here deletes one that does not.
On nm000112 every raw text version was measured, read only, to hash to a blob of the history (624 of 624), and every raw recording version has the size of an annex key; nm000114's text has not been measured.

### Step 6: Sanity (still read-only)

The public fleet scan lists only public datasets and refuses a private one (`--only ids not in the public catalog`, exit 2), and a dataset must never be made public to scan it.
So for a private dataset the screen from inside is the plan itself, which read every recording header with the scrub's own rule: step 1's counts are that screen, and step 16 runs it again after the scrub.
If the scan's record for this dataset from before it went private is still on hand (`<out>/$D.json`), compare counts: `jq '{status, incomplete, edf_bdf: .files.edf_bdf, flagged: .edf_bdf_files_flagged}'` of that file against the plan's keys and `needScrub`.
The record holds counts and never paths, and the plan counts distinct keys while the scan counts files, so a gap is explained, not assumed away: shared keys explain a plan with fewer, and a scan that was `incomplete` explains one with more.

### Step 7: Rewrite history in the clone

```bash
bun run $T/git/git-scrub.ts snapshot --repo $W/clone --out $W/before.json
bun run $T/git/git-scrub.ts rewrite --repo $W/clone --keymap $W/keymap.json --plan $W/git-plan.json
bun run $T/git/git-scrub.ts verify --repo $W/clone --keymap $W/keymap.json --plan $W/git-plan.json --s3-plan $W/plan.json --before $W/before.json
```

Take `before.json` before the rewrite: it records `originTips`, every head and tag the clone knew of the remote, which step 9 uses as its leases, and a snapshot after the rewrite is refused (`snapshot-after-rewrite`).
`rewrite --snapshot-out $W/before.json` snapshots first, in one command.
The rewrite derives its target from the plan (the clone's origin must be `nemarDatasets/$D`; `--expect-remote` is optional and must name the same repository).
It refuses a clone that is not clean or has a stash, whose branches do not match origin, or whose history never held a keymap key (`keymap-key-never-seen`), and prints `rewrite: ok <counts>`.
A relative `--report` is resolved from where you stand.
Its refusals are exit 3 (`bad-input: ...` too), and failures are exit 1.
A failure after the refs were rewritten prints `failed: cleanup-after-rewrite: the refs WERE rewritten; old objects may remain in the object store. In the clone run ...`: run the two commands it names in the clone, then verify.
The rewrite deletes `refs/annex/last-index`, a cache git-annex writes that names the pre-rewrite index (it would keep every old pointer blob reachable).
git-annex recreates it, naming the new index, after a later command in the clone: `git status` with 10.20240129, and `git checkout` with 10.20260901 (measured on the test fixture).
Verify reads it like every ref: it names a root tree, so it keeps the provenance exception, and it fails `old-key-present` only if that tree still holds an old key.
The verify of commit ad419189 turned the exception off for any ref to a tree, so with that version the recreated ref fails `old-key-present` on the provenance file with `provenanceBlobsKept=0`; delete it first (`git -C $W/clone update-ref -d refs/annex/last-index`), which is safe because the next git-annex command writes it again.

Verify must exit 0: no old key in any blob, commit message or annotated-tag message of any ref (except the upstream checksums of the provenance file, below), every EDF and BDF key in any commit is a new key or one the plan found clean, no dropped path, JSON blanked and structural edits applied, commit counts and tag names unchanged.
It prints `verify: ok mode=local <counts>`, the counts in alphabetical order: `blobsScanned`, `commits`, `edfKeys`, `jsonChecked`, `jsonUnparseable`, `objectsScanned`, `provenanceBlobsKept`, `provenanceHashesKept`, `refs`.
Exit 4 prints `verify: FAIL reason=... count=...` for each reason, then `verify: failed mode=local <counts>`.
The reasons in this mode: `refs-missing`, `tag-names-changed`, `tag-kind-changed`, `commit-count-changed`, `old-key-present`, `old-key-in-message`, `provenance-unannotated`, `provenance-too-large`, `dropped-path-present`, `blank-key-not-empty`, `json-ops-not-applied`, `json-unparseable`, `append-missing`, `append-duplicated`, `tip-paths-mismatch`, `annex-branch-changed`, `edf-key-unaccounted`, `edf-path-not-a-pointer`.

**The provenance file keeps its upstream checksums (ADR 0085).**
An old key's hash may stay in one place only: `sourcedata/sourcedata_provenance.json`, as the whole string value of a `sha256` member of an object in its top-level `files` array.
A blob is that file only when it is that path, as a regular file (mode `100644` or `100755`, never a symlink), and nothing else, in every commit of every ref and in every tree a ref names directly.
A ref that names a tree, as `refs/annex/last-index` does, has its blobs listed under that tree's own paths: a root tree, which is what git-annex writes, keeps the exception, and a subtree, or a tree that also holds the blob at another path, does not.
While any ref names a blob, or anything but a commit or a tree, that blob has no path to check, and nothing is exempt.
An old hash anywhere else in that blob (in the `privacy_correction` sentence, in another field, nested deeper, in another array, as a key) is `old-key-present`, and so is one in any other file, a copy of the provenance file at another path included.
A blob whose old hashes all sit where they may, but which has no non-empty `privacy_correction`, is `provenance-unannotated`: it would claim upstream checksums with no word that the copies differ, which is what a plan made before 2026-10-06 leaves on a dataset scrubbed only in place.
A provenance blob over 16 MiB (about 100,000 entries) is not read and is `provenance-too-large`; nm000186's file is tens of KiB.
One nested deeper than the walk can follow (tens of thousands of levels) is not placed, and is `old-key-present`.
`provenanceHashesKept` counts the distinct old hashes kept, not the other checksums the file lists, and `provenanceBlobsKept` the blobs that kept them; both are 0 for a dataset without the file.
On nm000186 the file has two versions listing 88 checksums, so expect `provenanceBlobsKept=2` and at most 88 hashes kept; a count you cannot explain from the file's history is a stop.
`--allow-unparseable-json` accepts a plan path whose content is not JSON in some commit; it is about plan paths and is unrelated to step 2's `--allow-skipped-json`.
A passing verify writes `$W/git-verified.json` in mode `local`; steps 15a and 15b need the one that step 14 writes.

### Step 8: Register keys in the clone

```bash
bun run $T/git/git-scrub.ts annex-registry --repo $W/clone --keymap $W/keymap.json              # dry run
bun run $T/git/git-scrub.ts annex-registry --repo $W/clone --keymap $W/keymap.json --execute
```

New keys are recorded present at the S3 remote only, and old keys are retracted at every holder and marked dead.
The S3 remote is the special remote named exactly `nemar-s3` in this clone (read from `git-annex:remote.log`, else `git config remote.nemar-s3.annex-uuid`), so there is no uuid to paste: each repository's `initremote` gave its remote its own uuid, and one from another dataset is refused.
Refusals (exit 3): `annex-not-initialized`, `no-nemar-s3-remote`, `remote-uuid-ambiguous` (two remotes named `nemar-s3`), `remote-uuid-unknown` (any `--remote-uuid`, given or derived, that is not a special remote of this clone), `old-key-unknown` (an old key with no location log and no holder: another dataset's keymap).
The dry run prints `annex-registry: dry-run oldKeys=.. holdersToRetract=.. newKeys=.. newToRegister=..`; `--execute` prints `annex-registry: ok ...`, or `FAILED` with exit 4 when the read-back disagrees.
This changes the clone's `git-annex` branch only; nothing is on GitHub until step 9.

### Step 8b: Open the dispatch window (once per batch)

**Decision of 2026-10-06 (the maintainer):** dispatch is suppressed by disabling three central workflows "for a short window", then enabling them again (ADR 0085, amendment of 2026-10-06).
A disabled workflow drops the dispatches of every dataset repository, not only this one, and `repository_dispatch` answers 204 whether or not a run starts, so nothing on the Worker's side shows what was dropped.
Hence:

- **Batch** every dataset that has passed step 8 (and step 8c, for a mirror) into one window, and run step 9 for each of them inside it.
- **Announce** the window on the epic before opening it.
- **Get the go** for each dataset of the batch, `GO window <dataset> <plan-id>`, recorded as in "Boxes and the go".
  Disabling a workflow is an outward-facing change, so it waits for the go like a box.

**Which repositories also need Actions disabled.**
A tag push runs the workflow files of the pushed commit, and the clone holds exactly the commits step 9 pushes, so check every ref the push moves:

```bash
for r in refs/heads/main $(git -C $W/clone for-each-ref --format='%(refname)' 'refs/tags/v*'); do
  echo "$r $(git -C $W/clone ls-tree --name-only "$r" .github/workflows/ | grep -cE '/(version-doi|generate-archive|llm-enrichment)\.yml$')"
done
```

A nonzero count on any line means the repository's own legacy workflows would run on the push (`version-doi.yml` on a tag, `llm-enrichment.yml` on `main`): the legacy `version-doi.yml` calls the Worker's enrichment and publish routes itself, so the version DOI pointer is written and the central manifest job is dispatched, and where `main` carries the legacy `generate-archive.yml` it builds an archive under the old key name `D/archives/v<X.Y.Z>.zip`.
Disable GitHub Actions on that repository for the window.
The maintainer's decision names the seven repositories whose `main` carries these files: nm000197, nm000200, nm000246, nm000277, nm000301, nm000340 and nm000348.
A read of every tag on 2026-10-06 found `version-doi.yml` in at least one tag of each of the other seven `nm` datasets of the sixteen as well (nm000112, nm000114, nm000149, nm000173, nm000176, nm000186, nm000191), and nm000186's own run history shows a legacy `Version DOI` run on its `v1.0.0` push; the two `on` mirrors carry none.
So the check above decides, not the list.
The legacy workflows themselves are a fleet-drift finding (`GET /admin/fleet/drift`, `DEPRECATED_WORKFLOW_PRESENT`) and are not stripped here.

**Record the state before the window**, for each dataset of the batch:

```bash
gh api repos/nemarDatasets/$D/actions/permissions > $W/actions-before.json      # all sixteen read {"enabled":true,"allowed_actions":"all"} on 2026-10-06
nemar admin doi info $D > $W/doi-before.txt                                      # compared in step 15c
```

**Open the window**, after the announcement and every go of the batch:

```bash
gh issue comment 1610 --repo nemarOrg/nemar-cli --body "Scrub dispatch window opening for <datasets>: run-version-doi.yml, run-enrichment.yml and run-bids-validation.yml in nemarDatasets/.github are disabled until it closes, so dispatches to every dataset repository are dropped meanwhile."
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)                                                  # write it into go.txt of every dataset in the batch
for wf in run-version-doi.yml run-enrichment.yml run-bids-validation.yml; do gh workflow disable $wf --repo nemarDatasets/.github; done
gh api -X PUT repos/nemarDatasets/$D/actions/permissions -F enabled=false        # only for each dataset the check above flagged
```

`gh workflow disable` takes the file name, the workflow's name or its id (on 2026-10-06: `run-version-doi.yml` 282106256, `run-enrichment.yml` 282095257, `run-bids-validation.yml` 282124377).

**Verify before the first push:**

```bash
gh workflow list --repo nemarDatasets/.github --all --json path,state \
  --jq '.[] | select(.path | test("/(run-version-doi|run-enrichment|run-bids-validation)\\.yml$")) | [.path, .state] | @tsv'
                                                                                   # expect all three disabled_manually
gh api repos/nemarDatasets/$D/actions/permissions --jq .enabled                   # expect false, for each flagged dataset
for wf in run-version-doi.yml run-enrichment.yml run-bids-validation.yml; do
  for s in queued in_progress; do echo "$wf $s $(gh run list --repo nemarDatasets/.github --workflow $wf --all --status $s --json databaseId --jq length)"; done
done                                                                               # wait until every count is 0
```

A disable does not stop a run that has already started, and a run that started before `T0` acts on the state of that moment, so wait for the last count to reach 0 before the first push.
`gh run list --workflow` skips a disabled workflow without `--all`.

### Step 8c: A mirror's import is quiet (`on` datasets only)

For an OpenNeuro mirror (on005007, on005383), the purge list as a document is not built (ADR 0085), but since release 0.10.15 the importer's prepare step (Phase 7, ADR 0089) cuts its copy manifest to the committed tree minus every key the git-annex branch records as dead, and refuses a replaced key the tree still names (`old-key-still-named`).
Until the git-annex branch that carries those dead marks is pushed (step 9), nothing refuses an old key.
Three production crons read `import_jobs` and can copy the upstream originals back into `D/objects/`: `sweepImportRetries` re-pulls a row that is `incomplete`, `failed` or `quarantined`; `autoImportTick` re-imports a `failed` one; and `reclassifyCompleteRows` re-verifies a `complete` row whose `integrity_checked_at` is empty and flips it to `incomplete` when the S3 copy reads incomplete (`backend/src/services/import-retry.ts`, `auto-import.ts`).
So before the push, read the dataset's rows (read-only):

```bash
nemar admin import status $D
bun -e "import { getImportStatus } from './src/lib/api/admin'; console.log((await getImportStatus()).imports.filter((r) => r.dataset_id === '$D').map((r) => ({ status: r.status, stage: r.stage, integrity_checked_at: r.integrity_checked_at, next_retry_at: r.next_retry_at, blocklisted: r.blocklisted })))"
```

The CLI command does not print `integrity_checked_at`; the second line does.
Continue only when every row is `complete` with `integrity_checked_at` set.
Anything else: stop and ask, because a sweep may act on the row while the scrub is in flight.
Read it again before step 15b.

### Step 9: Switch the repository

> **IRREVERSIBLE: step 9, force-push of every branch and tag**
>
> **What it destroys.**
> The dataset's published history on GitHub: `main` and every `v*` tag are replaced by the rewritten ones, and the pushed `git-annex` branch marks every old key dead.
> The only way back is `$W/original.bundle`, by hand and untested (see "Abort points and rollback").
> GitHub's cached views and pull-request refs keep the old commits; that is an accepted residual (decision of 2026-10-06, see "Residuals"), and no Support request is made.
>
> **Preconditions you check by hand.**
> - Steps 7 and 8 passed, and `jq -r .mode $W/git-verified.json` prints `local`.
> - The dataset is private (C6) and the uploader has been told.
> - The dispatch window is open and verified (step 8b): the three central workflows are `disabled_manually`, and Actions is off on this repository if step 8b's check flagged it.
> - For an `on` mirror, step 8c passed.
> - The remote has no head but `main` and `git-annex`: `gh api repos/nemarDatasets/$D/branches --paginate --jq '.[].name'` prints only those two, and `go.txt` records each merged branch deleted before step 0, with its SHA and the `ahead_by 0` read just before it went ("Before each dataset", item 7).
>   A branch that has appeared since the clone is someone's new work: stop and ask, and never delete it under this go.
> - The snapshot below succeeded, and `switch.ts check` right after it says `protection matches the snapshot`.
> - You have read the dry run of the switch: `plan: lift N ruleset(s), push M ref(s)`, where M is one for `main` plus one per tag that changed, and N is the number of active rulesets that block the push (a branch ruleset the pusher can bypass is left alone).
> - The maintainer's go is recorded: `GO switch <dataset> <plan-id>`.
>
> **Commands.**
> ```bash
> bun run $T/github/switch.ts snapshot --repo nemarDatasets/$D --clone $W/clone --before $W/before.json --out $W/ruleset.json
> bun run $T/github/switch.ts switch --repo nemarDatasets/$D --clone $W/clone --snapshot $W/ruleset.json              # dry run
> bun run $T/github/switch.ts switch --repo nemarDatasets/$D --clone $W/clone --snapshot $W/ruleset.json --execute
> bun run $T/github/switch.ts check --repo nemarDatasets/$D --snapshot $W/ruleset.json
> git -C $W/clone fetch origin git-annex && git -C $W/clone annex merge && git -C $W/clone push origin git-annex
> ```
>
> **Words.**
> `snapshot` is never written over a file (`snapshot-exists`), and it refuses (exit 3, nothing written) on `remote-moved-since-clone (N ref(s))` (the remote's heads and tags are not exactly `before.json`'s `originTips`: someone pushed since the clone), `ruleset-already-lifted` (a tag ruleset, or a branch ruleset the pusher cannot bypass, is not `active`; `--accept-disabled` overrides, and the restore then restores it as it was), `ruleset-not-repository` (a ruleset the organization owns would block the push, and the repository's endpoint cannot lift it), `before-invalid`, `unexpected-remote-head` (the remote has a head other than `main` and `git-annex`), `remote-only-tag` and `origin-mismatch`.
> `switch` also refuses `ruleset-not-in-snapshot`, `snapshot-other-repository`, `snapshot-invalid` and `remote-moved-since-clone`; read its plan line first.
> It reports `pushed refs/heads/main` and `pushed tag K of N` as each ref lands, then `restored N ruleset(s)`.
> A push that fails part way exits **1**: stderr says `switch: push failed: <class>` (`non-fast-forward`, which includes a stale lease, `hook-declined`, `auth`, `network`, `timeout`, `other`), then which branches and how many tags were and were not pushed, that the rulesets were restored, and that the remote may be half rewritten.
> Run `switch.ts check`, compare `git ls-remote` with `before.json`'s `originTips`, fix the cause, and run it again: a ref the remote already holds at the rewrite's SHA (pushed by the earlier run) is not drift and is not pushed twice, a run with nothing left to push lifts nothing, and the leases still refuse to overwrite anything else.
> SIGINT, SIGTERM and SIGHUP restore the rulesets for the whole lift-push-restore window, print `switch: interrupted by <SIGNAL>; protection restored`, and exit 130, 143 or 129; a second signal during the restore prints `restore in progress` and is ignored.
> **If a ruleset could not be restored the exit is 5, and any exit while one may be lifted prints `RESTORE FAILED: run switch.ts restore --execute now`: do that at once, before anything else, and read `switch.ts check`.**
> The git-annex push is a normal push, never a force: the fetch and merge come first because the remote's branch can have moved, and step 14 reads the PUSHED branch.
> `git annex sync --no-content --only-annex` does the same.

### Step 9b: Close the dispatch window (once per batch)

After the last dataset of the batch has finished step 9, its `git-annex` push included:

```bash
for wf in run-version-doi.yml run-enrichment.yml run-bids-validation.yml; do gh workflow enable $wf --repo nemarDatasets/.github; done
gh api -X PUT repos/nemarDatasets/$D/actions/permissions -F enabled=true -f allowed_actions=$(jq -r .allowed_actions $W/actions-before.json)   # each dataset step 8b disabled
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ)                                                  # write it into go.txt of every dataset in the batch
gh issue comment 1610 --repo nemarOrg/nemar-cli --body "Scrub dispatch window closed: the three workflows are enabled again."
```

Then the checklist, every item for every dataset of the batch:

- [ ] The three workflows are `active` again: step 8b's `gh workflow list` line.
- [ ] Actions is as it was: `diff <(gh api repos/nemarDatasets/$D/actions/permissions | jq -S .) <(jq -S . $W/actions-before.json)` prints nothing.
- [ ] No run of the three started during the window; each count must be 0:

  ```bash
  for wf in run-version-doi.yml run-enrichment.yml run-bids-validation.yml; do
    echo "$wf $(gh run list --repo nemarDatasets/.github --workflow $wf --all --created "$T0..$T1" --limit 200 --json databaseId --jq length)"
  done
  ```

- [ ] No run started for this dataset after its tag pushes.
  The run names do not carry the dataset id, so count it in each run's log, where the step headers print the dispatch payload:

  ```bash
  for wf in run-version-doi.yml run-enrichment.yml run-bids-validation.yml generate-manifest.yml generate-records.yml run-generate-archive.yml; do
    gh run list --repo nemarDatasets/.github --workflow $wf --all --created ">=$T0" --limit 200 --json databaseId --jq '.[].databaseId' \
      | while read -r id; do echo "$wf $id $(gh run view $id --repo nemarDatasets/.github --log 2>/dev/null | grep -c "$D")"; done
  done
  gh api -X GET repos/nemarDatasets/$D/actions/runs -f created=">=$T0" --jq '.workflow_runs[] | [.name, .event, .head_branch] | @tsv'
  ```

  Every count must be 0 until step 12 dispatches by hand.
  The dataset repository shows no run from the window when step 8b disabled its Actions; otherwise it shows only `BIDS Validation` runs on `push`, the shim whose one job dispatches `run-bids-validation.yml`, which the disabled central workflow dropped.
  `gh run view --log` reads only a finished run, so run the loop again until no run listed is still in progress.
  A run for the dataset that did start (a nonzero count) wrote what the appendix says: stop and ask before step 10.
- [ ] Pushes to repositories outside the batch during the window lost their dispatches (enrichment, a version DOI and its archive and records, BIDS validation):

  ```bash
  gh api "orgs/nemarDatasets/repos?sort=pushed&direction=desc&per_page=100" --jq ".[] | select(.pushed_at >= \"$T0\") | [.name, .pushed_at] | @tsv"
  ```

  Give the list, minus the batch, to the maintainer.
  The manual dispatches exist (`gh workflow run run-version-doi.yml --repo nemarDatasets/.github -f dataset_id=<id> -f tag=<vX.Y.Z>`, `gh workflow run run-enrichment.yml --repo nemarDatasets/.github -f dataset_id=<id> -f ref=main`), and a validation runs again on that repository's next push; whether to re-dispatch is the maintainer's call.

### Step 10: Zarr serving copy (not locked)

```bash
bun run $T/s3/s3-scrub.ts zarr --dir $W                                   # dry run
bun run $T/s3/s3-scrub.ts zarr --dir $W --execute
```

The dry run reads every store root and every nested `zarr.json` and says how many need a scrub; `--execute` removes the subject and identifier members from each, writing a document back only if no one changed it since it was read (an ETag-conditional put), and re-reads every document to prove it clean.

**What a clean store means:** the data and events, the channel names, types and units, and the technical recording metadata, and nothing else.
The rule is one function for the stage, its re-read, its proof and the public check of step 16:

- Removed: every key the scanner calls an identifier and every member of the removal set (`EDF_MIRROR_MEMBERS`: `patientcode`, `birthdate`, `gender`, `patient_name`, `patient_additional`, `admincode`, `technician`, `equipment`, `recording_additional`), at any depth and in any spelling, when it holds something.
- Kept: every other member of `recording_metadata` (or `recording_info`) that is in the allow-list `KNOWN_BENIGN`, or is a key the scanner knows (`email` is kept: it is a review key, not removed), or is named with `--allow-member NAME` (repeatable, any spelling, letters and digits only, else `bad-allow-member`; recorded in `zarr-verified.json` as `allowedMembers`, which `zarr-public` applies too).
- Refused: anything else stops the run before any document is written (`unknown-recording-member`, exit 3, in the dry run too).
  The names, never values, go to `$W/zarr-unknown-members.json` with the number of documents per name, and stdout says `zarr: unknown-recording-member in N document(s), M distinct name(s); the names are in zarr-unknown-members.json`.
  Look at each name, ask the maintainer, and run again with `--allow-member`.

Every `zarr.json` inside a store (an array's or a nested group's) is read, cleaned and re-read too, at most `--max-zarr-json N` documents (default 20,000; more is refused before any is read, `too-many-zarr-json`, exit 3).
The stage also refuses to prove a prefix it cannot account for (objects but no store root, a `zarr.json` outside any store, a store without its root, a Zarr v2 metadata file, a byte order mark): exit 4, nothing proven.
A store that vanishes between the listing and its read is `HeadObject:not-found`, a failure (exit 1), never clean.
The output is `zarr: stores=S docs=D clean=.. scrubbed=.. unreadable=.. unknownMembers=.. failed=..` (`needScrub=` in the dry run) and, on success, `zarr: ok; every one of S store roots and D zarr.json documents is clean`.
From the census, nm000186's roots are expected to need a scrub (88) and the real run to remove 352 members; nested documents were not part of the census.
It writes `zarr-plan.json` (counts and a digest of the keys it read, no key) and `zarr-verified.json` (`stores`, `allowedMembers`, `counts`).
A dataset with nothing under `D/zarr/` is `found: no-zarr`, which `drop-archives` and `delete-old` do not accept once Zarr objects exist.
Run this step with `--execute` for every dataset, one without a Zarr copy too: `drop-archives` refuses without a `zarr-verified.json` for this plan, and for such a dataset the proof is the `no-zarr` one.

The noncurrent versions of every zarr object still hold the old metadata, and step 15b prunes them with `--prune-noncurrent $D/zarr/`.
The count is not one per document rewritten: it is the whole history of the prefix.
nm000186 (88 stores, 968 documents rewritten) measured 46,127 noncurrent versions and 36,068 markers, 82,195 in all: 40,654 data chunks, 5,456 `zarr.json` and 5 `index.json` from every earlier conversion, 15,622 noncurrent delete markers, and 20,446 delete markers that are current (keys deleted long ago, whose old versions are still there).
The old `zarr.json` versions are the ones that carry the subject, and the rest is history of a derived copy, regenerable from the dataset.
Read the `delete-old: prune noncurrent versions=N markers=P` line of step 15b's dry run and set `delete-old --max-prune` to at least N+P (its default is 1,000, which a dataset converted more than once always exceeds).

**Waiting for the edge.**
The stage writes to S3, not through `zarr.nemar.org`.
The dataset is private, so the Worker serves none of it, and a purge does nothing.
After step 16 an untokened `zarr.json` can still be served from the edge for at least 6 minutes, and a tokened one for up to a day (`max-age=86400, stale-while-revalidate=86400`), counted from the last time the dataset was public (these are the `Cache-Control` values the Worker sets; how the Workers Cache API treats `stale-while-revalidate` has not been measured here).
If the privacy flip was less than two days ago, check a store root through `https://zarr.nemar.org/$D/zarr/<store>/zarr.json` after step 16 as well; a non-browser GET of a store object is redirected to S3, so it tests S3, not the edge copy.
`attributes.nemar.source_commit` and the index's `source_commit` now name commits that no longer exist; that is not a privacy matter, remapping them is not built (ADR 0085), and the next reconversion of the dataset repairs them.

### Step 11: Archives, a read-only look

```bash
bun run $T/s3/s3-scrub.ts drop-archives --dir $W --confirm-dataset $D
```

This is the dry run: it prints `drop-archives: keys=.. versions=.. markers=..` and the `would delete` line, and deletes nothing.
Note the counts.
The archive holds the original recordings, so it must go, but not yet: step 15a does it, after the rewrite has been verified from outside the clone, because it cannot be undone.
The tool enforces that: it refuses until every proof of step 15a is in `$W` and names this plan, so here it is expected to exit 3 with `drop-archives: refused git-proof-stale: mode local, not fresh-clone` (step 14 has not run yet).
Any other refusal line names a proof to fix before step 15a: a missing `verified.json`, `new-hash-verified.json` or `zarr-verified.json`, or one made for another plan.

### Step 12: Regenerate every tag's manifest and records after the tags moved

Before the tags move, the jobs rebuild the old files from the old tree.
With the window of step 8b open, the tag pushes of step 9 dispatched nothing (step 9b confirms it), so here every tag's manifest and records are regenerated by hand.
They are regenerated BEFORE step 15b on purpose: `--prune-noncurrent $D/version/` there removes the versions they replace, while a file regenerated for the first time after step 15b would leave its pre-scrub version behind as a noncurrent version that nothing prunes.
The manifest job regenerates `D/version/<tag>.json` and `<tag>-summary.json` (the summary is rebuilt from the scrubbed tree); the records job regenerates `<tag>-records.json`, which the manifest job does not.

**Manifests.**
A dispatch for a **private** dataset must carry `skip_canary: true`: the job's canary makes an unauthenticated request to `raw.githubusercontent.com`, which cannot serve a private repository.
The CLI's `nemar admin summary check --fix` does not pass it, so call the admin route's client with it, as the signed-in admin.
The route (`POST /admin/manifest/dispatch`) dispatches `generate-manifest.yml` with `skip_canary` as asked, always with `skip_callback: true` (there is no in-flight `manifest_jobs` row to call back to), and with the version's `doi` and `concept_doi` read from D1, so the regenerated manifest keeps its DOIs.
It looks the version up by its exact spelling, and the publish flow stores it without the `v` (`normalizeVersion`; the manifest's own `version` field is bare too), so pass `${tag#v}`:

```bash
T12=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for tag in $(jq -r '.tags[]' $W/plan.json); do
  bun -e "import { dispatchManifest } from './src/lib/api/admin'; console.log(await dispatchManifest('$D', '${tag#v}', { skipCanary: true }))"
done
```

A 404 (`No published version row`) means no row with that spelling: run that tag once more with `'$tag'` (an older row may hold the `v`), and if that answers 404 too, stop and ask.
The same job without the route is `gh workflow run generate-manifest.yml --repo nemarDatasets/.github -f dataset_id=$D -f version=${tag#v} -f doi=<version DOI> -f concept_doi=<concept DOI> -f skip_canary=true -f skip_callback=true`; without `doi` and `concept_doi` it writes a manifest with empty DOI fields, so use that form only with both.

**Records**, one per tag:

```bash
for tag in $(jq -r '.tags[]' $W/plan.json); do
  gh workflow run generate-records.yml --repo nemarDatasets/.github -f dataset_id=$D -f version=${tag#v}
done
```

The job clones the tag with the GitHub App's token (a private repository is fine), builds the records from the scrubbed tree, reads a recording only by its new key, to fill a missing duration, and prints the first 2,000 and then 1,500 bytes of the records file to the public log of `nemarDatasets/.github`.

Wait for both kinds of run to finish, each `completed` and `success`:

```bash
for wf in generate-manifest.yml generate-records.yml; do gh run list --repo nemarDatasets/.github --workflow $wf --created ">=$T12" --json databaseId,status,conclusion; done
```

Expect one manifest run and one records run per tag of this dataset; a run listed for another dataset is told apart by counting `$D` in its log, as in step 9b.
Then confirm that each records file was written by these runs (each `LastModified` later than `T12`):

```bash
for tag in $(jq -r '.tags[]' $W/plan.json); do
  aws s3api head-object --bucket nemar --key "$D/version/$tag-records.json" --query LastModified --output text
done
```

And that each `s3://nemar/$D/version/<tag>.json` names only new keys; the `comm` line prints nothing when it is right:

```bash
for tag in $(jq -r '.tags[]' $W/plan.json); do
  aws s3 cp "s3://nemar/$D/version/$tag.json" - | jq -r '.files | to_entries[] | select(.key | test("\\.(edf|bdf)$"; "i")) | .value.key' | LC_ALL=C sort -u > $W/manifest-$tag.keys
  jq -r 'keys[]' $W/keymap.json | LC_ALL=C sort | LC_ALL=C comm -12 - $W/manifest-$tag.keys
done
```

`delete-old` reads every current manifest itself and refuses while one names an old key (`manifest-names-old-key`) or a recording the scrub did not account for (`manifest-names-unplanned-key`).

### Step 13: Ledger

One line per action, appended to `$W/ledger.jsonl`, with the numbers read from the stages' own files.
`A` is a shell function, not a variable, because zsh (the maintainers' shell) does not split an unquoted `$A` into words and would try to run the whole string as one command name:

```bash
ACTOR=$(gh api user --jq .login)
VERSIONS=$(jq -r '.tags | join(",")' $W/plan.json)
A() { bun run $T/ledger-cli.ts append --file $W/ledger.jsonl --dataset $D --actor $ACTOR --versions $VERSIONS "$@"; }
A --action plan --counts keys=$(jq .totals.keys $W/plan.json),need_scrub=$(jq .totals.needScrub $W/plan.json) --verification plan-only
A --action headers-scrubbed --counts objects=$(jq '.entries | length' $W/assembled.json),headers=$(jq .counts.headersChecked $W/verified.json) --verification scanner-clean+payload-identical+rehash-ok
A --action files-removed --counts drop_paths=$(jq '.dropPaths | length' $W/git-plan.json),json_files_blanked=$(jq '.blankJsonKeys | length' $W/git-plan.json),provenance_entries_dropped=$(jq .provenanceEntriesDropped $W/git-plan.report.json) --verification scanner-clean
A --action history-rewritten --counts refs=$(jq .counts.refs $W/git-verified.json),commits=$(jq .counts.commits $W/git-verified.json) --verification scanner-clean
A --action locks-applied --counts objects=$(jq '.entries | length' $W/assembled.json) --verification none
A --action manifests-regenerated --counts manifests=$(jq '.tags | length' $W/plan.json) --verification none
```

A ledger line holds counts and a closed vocabulary only: an action (`plan`, `headers-scrubbed`, `files-removed`, `history-rewritten`, `locks-applied`, `manifests-regenerated`, `old-versions-deleted`, `published-again`, and `import-scrubbed`, which only the importer writes, ADR 0089), versions as tags, counts as `name=number` with lowercase names, a verification from the closed list (`none`, `plan-only`, `scanner-clean`, `scanner-clean+payload-identical`, `scanner-clean+payload-identical+rehash-ok`, `public-surface-clean`, `authoritative-listing-empty`), a scanner revision and an actor handle.
The tool refuses any other text.
The words chosen above are this runbook's convention: the closed list has no word for a lock or a manifest check, so those two lines say `none`, and the proof files named in steps 5 and 12 are what verified them.
The scanner revision is the last commit that touched `shared/identifier-scan.ts`, `shared/identifier-scrub.ts` or `scripts/scrub/s3/zarr-json.ts`, unless `--scanner` is given.
`ledger-cli.ts show --file $W/ledger.jsonl` prints the file back, validating every line.

Commit the file as `.nemar/corrections.jsonl` on `main` (a normal push, not a force; if GitHub declines it, stop and ask, and never lift a ruleset by hand), and publish it.
The dataset's own `.gitignore` has listed `.nemar/` since its first upload (the bot's `metadata.json` and `availability-report.json` are tracked only because they were force-added), so `git add` without `-f` refuses and the push says `Everything up-to-date`; `-f` on this one file is the fix, and no ruleset is involved.
A push by an admin shows `remote: - 2 of 2 required status checks are expected.` and succeeds; that is the rule being bypassed by the pusher, as for every push of the pipeline's own bot, not a refusal.
The push sets off the BIDS validation (two runs were seen for the one push on 2026-10-06, both for this dataset and both `success`) and nothing else:

```bash
mkdir -p $W/clone/.nemar && cp $W/ledger.jsonl $W/clone/.nemar/corrections.jsonl
git -C $W/clone add -f .nemar/corrections.jsonl && git -C $W/clone commit -m "Record the privacy correction" && git -C $W/clone push origin main
bun run $T/ledger-cli.ts publish --file $W/ledger.jsonl --dataset $D                 # dry run
bun run $T/ledger-cli.ts publish --file $W/ledger.jsonl --dataset $D --execute
```

`publish` copies the file to `s3://nemar/$D/corrections/ledger.jsonl`.
It treats only a genuine not-found (`NoSuchKey`) as "no ledger yet"; every other read failure refuses with `remote-ledger-unreadable (<Op>:<class>)` (`GetObject:access-denied`, `:unreachable`, `:failed`, `:timeout`), and a 403 is never absence, the dry run included.
It also refuses (exit 3) `remote-ledger-not-utf8`, `remote-ledger-partial-line`, `not-an-append` (anything but a strict extension of what is there), `ledger-empty`, `ledger-other-dataset`, and `remote-ledger-changed` (the conditional put was refused: someone wrote between the read and the put, their version stands; look, then run it again).
The put is conditional (`--if-none-match '*'` for a first publish, `--if-match <ETag read>` for an extension) and the bytes put are the bytes validated.
Exit 4 (`read-back-differs-after-write`, `read-back-failed-after-write (...)`) means written but not proven: look at the object now.
`--timeout-sec N` (default 120) bounds each `aws` call, and a transfer gets five times as long.
The change-log sentence is already in every version through the git plan.

### Step 14: Verify while still private

Admin reads, no public exposure.
Let the runs of step 12 finish first; step 9 set off none (step 9b).
Then clone the dataset fresh from GitHub and verify the pushed refs, not the local rewrite:

```bash
git clone https://github.com/nemarDatasets/$D $W/fresh
bun run $T/git/git-scrub.ts verify --fresh-clone --repo $W/fresh --keymap $W/keymap.json --plan $W/git-plan.json --s3-plan $W/plan.json
rm -rf $W/fresh
```

**`--fresh-clone` takes no `--before`** (a usage error, exit 2).
A fresh clone needs no `git annex init`: the pushed `git-annex` branch is read from `refs/remotes/origin/git-annex`.
It checks, over every ref: no old key anywhere, but the upstream checksums of the provenance file under the same rule as step 7 (`provenance-unannotated`, and the same two counts on the line and in the proof); every EDF and BDF key is new or planned clean; no dropped path; JSON blanked and structural edits applied; appended text once at the end; the tag names equal the plan's `tags`, plus any named with `--allow-tag` (`tag-names-not-plan`, `allowed-tag-missing`); every commit that touches `.nemar/corrections.jsonl` touches nothing else (`ledger-commit-not-alone`), except the importer's own commit, which appends only `import-scrubbed` lines beside the files it scrubbed and edits no earlier line (ADR 0089; verify cannot tell that commit from one made by hand, it only bounds what such a commit may do to the ledger), and the ledger at every head tip is valid for this dataset (`ledger-invalid`); and in the pushed `git-annex` branch, no old key is held anywhere (`annex-old-key-held`), every old key is dead (`annex-old-key-not-dead`) and every new key is recorded present (`annex-new-key-unregistered`; `annex-branch-missing` if the branch was not pushed).
It does not compare commit counts, tip paths or annex refs, so the ledger commit of step 13 is tolerated.
Exit 0 prints `verify: ok mode=fresh-clone <counts>` (step 7's counts and `ledgerCommits`; `allowedTags=N` too, only when `--allow-tag` was given) and writes `$W/git-verified.json` in mode `fresh-clone` (overwriting step 7's), which steps 15a and 15b require, with this same `keymap.json` and `plan.json`.
Its `provenanceHashesKept` and `provenanceBlobsKept` must equal step 7's: the pushed history is the one verified there.
Exit 4 prints `verify: FAIL reason=... count=...` for each reason and removes any earlier proof.
The reasons in this mode: `tag-names-not-plan`, `allowed-tag-missing`, `old-key-present`, `old-key-in-message`, `provenance-unannotated`, `provenance-too-large`, `dropped-path-present`, `blank-key-not-empty`, `json-ops-not-applied`, `json-unparseable`, `append-missing`, `append-duplicated`, `edf-key-unaccounted`, `edf-path-not-a-pointer`, `ledger-commit-not-alone`, `ledger-invalid`, `annex-branch-missing`, `annex-old-key-held`, `annex-old-key-not-dead`, `annex-new-key-unregistered`.

**A git tag that S3 never had a manifest for.**
When step 14 stops with `tag-names-not-plan` and the extra tag is one the repository has but S3 never had a manifest for (nm000112's `v1.1.1`: a git tag and a GitHub release, no manifest), confirm that first.
The tag is in `before.json`'s `tags`, `aws s3 ls s3://nemar/$D/version/` has no manifest for it, and the local verify of step 7 passed (it covered every tag, this one included).
Then run step 14 again with `--allow-tag v1.1.1`, one flag per tag; a name that is not `vX.Y.Z` or `vX.Y.Z-pre` is a usage error (exit 2), and so is the flag with `--before`.
The line then reads `allowedTags=N`, and the name is recorded in `git-verified.json` as `allowedTags`, so the proof steps 15a and 15b read says which names were allowed.
The allowance is by name and covers the name check only: that tag's tree is scanned like every other ref's, so an old key in it is still `old-key-present`, and a name the repository does not have is `allowed-tag-missing`.
A tag that is not in `before.json`, or that you cannot account for this way, is a stop, not a name to allow.

Then read every regenerated manifest again (step 12's check).
`verify-new` (step 5) already hashed every new object.
The dataset stays private until the old bytes are gone, so there is no window in which an old key is publicly readable.

### Step 14b: The Zarr stores are the ones the proof covers, and the converter is quiet

`drop-archives` and `delete-old` check that `zarr-verified.json` names this plan and the `zarr-plan.json` beside it, but neither compares the stores that exist now with the ones the zarr stage read, so a store written after step 10 passes both.
Check it by hand before step 15a, and again before step 16's flip:

```bash
aws s3api list-objects-v2 --bucket nemar --prefix "$D/zarr/" --output json \
  | jq -r --arg p "$D/zarr/" '(.Contents // [])[].Key | select(test("\\.zarr/zarr\\.json$")) | ltrimstr($p) | rtrimstr("/zarr.json")' \
  | LC_ALL=C sort > $W/zarr-roots-now.txt
jq -r '.stores[]' $W/zarr-verified.json | LC_ALL=C sort > $W/zarr-roots-proof.txt
LC_ALL=C comm -3 $W/zarr-roots-now.txt $W/zarr-roots-proof.txt | wc -l        # expect 0
wc -l < $W/zarr-roots-now.txt                                                  # expect jq .counts.stores $W/zarr-verified.json
```

The selection is the stage's own definition of a store root (`STORE_ROOT`, a key ending in `.zarr/zarr.json`), spelled as the proof spells it (the path under `$D/zarr/`).
The store paths are built from file names, so they stay in `$W` and only counts are printed.
For a `no-zarr` proof both files are empty.
A nonzero first count before step 15a: run step 10 again, which writes a new proof, then this check.
After step 15b, stop and ask instead: a zarr stage run then leaves noncurrent versions with the old metadata, which nothing prunes any more.

Then the converter.
While the dataset is private the queue's `reconcile` parks it as `unlisted`, and a row already `inprogress` is finished by its own converter ("What a push sets off").
Read the dataset's row on the conversion host, read-only; the queue is a SQLite file, `${ZARR_BASE:-/mnt/local}/zarr-state/zarr-queue.db` by default in `scripts/zarr/hallu-zarr.sh`, and `zarr_queue.py` itself is not read-only, because its `connect` migrates the schema:

```bash
ssh hallu "python3 - <<'EOF'
import sqlite3
c = sqlite3.connect('file:/mnt/local/zarr-state/zarr-queue.db?mode=ro', uri=True)
print(c.execute(\"SELECT status, converted_version, updated_at FROM jobs WHERE dataset_id = ?\", ('$D',)).fetchall())
print(c.execute(\"SELECT COUNT(*) FROM jobs WHERE status = 'inprogress'\").fetchone())
EOF"
```

Expect `unlisted`, or no row, and never `inprogress`.
The host has no `sqlite3` binary (measured 2026-10-06: `sqlite3: command not found`), so the read uses Python's `sqlite3` module in read-only mode (`mode=ro`, which does not migrate the schema); the path was right.
The second line counts rows `inprogress` for any dataset, which is not this dataset's concern unless the first line says `inprogress` too.
If the path differs, ask the maintainer to read the row.

### Step 15: Drop the archives, then delete the old bytes

> **IRREVERSIBLE: step 15a, drop the archives**
>
> **What it destroys.**
> Every version and every delete marker of every key under `s3://nemar/$D/archives/`, by version id, with no bypass.
> The archive is a zip of the dataset's files as they were, original recordings included, and nothing can be patched inside a zip, so it is deleted and rebuilt from the scrubbed tree (step 15c).
> The tool checks for itself that the scrub has been verified everywhere before the originals are lost (the list is under "It refuses unless"); the checks below are the ones it cannot make.
>
> **Preconditions you check by hand.**
> - No archive job ran or runs for this dataset since the window opened: step 9b's run check, repeated now for `run-generate-archive.yml`, and the dataset repository's own runs (a legacy `generate-archive.yml` writes `D/archives/v<X.Y.Z>.zip`, the old key name), so none is built after the drop; an archive built from the scrubbed tree is deleted here too, because the tool deletes every version.
> - Step 14b passed.
> - The dry run of step 15b, run now with the flags it will run with (`--prune-noncurrent`, `--max-delete`, `--max-prune`), lists `archives-not-dropped` and no other refusal.
>   It evaluates every refusal, so anything else it names is something to fix while the originals still exist.
> - You have read step 11's counts, and the dry run below exits 0 with the same counts or ones you can explain (an archive job that ran since).
> - The maintainer's go is recorded: `GO drop-archives <dataset> <plan-id>`.
>
> **Commands.**
> ```bash
> bun run $T/s3/s3-scrub.ts drop-archives --dir $W --confirm-dataset $D                  # dry run
> bun run $T/s3/s3-scrub.ts drop-archives --dir $W --confirm-dataset $D --execute
> ```
> `--verified`, `--hash-verified` and `--git-verified` default to `verified.json`, `new-hash-verified.json` and `git-verified.json` in `$W`, as for step 15b.
>
> **It refuses unless** (all exit 3, all in the dry run, and every one that applies is listed, while the dry run still prints what it would delete):
> - the plan is complete and not partial, and `--confirm-dataset` matches (`plan-partial`, `plan-has-unreadable`, `confirm-dataset-mismatch`); these stop before anything else is read;
> - `assembled.json` exists, names this dataset and bucket, and holds only keys the plan marked for a scrub, each with a new key of its own (`assembled.json-missing`, `assembled-wrong-dataset`, `assembled-wrong-bucket`, `assembled-not-in-plan`, `duplicate-new-key`, `old-key-is-a-new-key`);
> - `verified.json` and `new-hash-verified.json` (step 5) exist, parse, and name the exact bytes of `assembled.json`, this dataset and its number of entries (`verified.json-missing`, `new-hash-verified.json-missing`, `verified.json-invalid`, `new-hash-verified.json-invalid`, `verified-stale`, `new-hash-verified-stale`, `proof-wrong-dataset`, `proof-count-mismatch`);
> - `git-verified.json` (step 14) exists, parses, is mode `fresh-clone`, and names this `keymap.json` and `plan.json`, and, when `git-plan.json` is in `$W`, that git plan, and the keymap is this assembly's (`git-proof-missing`, `git-proof-invalid`, `git-proof-stale`, `keymap.json-missing`, `keymap-mismatch`);
> - `zarr-verified.json` (step 10) exists, parses, and names this `plan.json` and the `zarr-plan.json` beside it, and while Zarr objects are current it proves stores, not `no-zarr` (`zarr-not-scrubbed`, with the reason).
>
> These are step 15b's checks of the same files, with the same words, except that step 15b asks for the Zarr proof only while Zarr objects are current.
> A proof file that is there and cannot be read is `<name>-unreadable` (exit 1, a failure).
> The `zarr-public` check of step 16 runs after the dataset is public again and writes no proof, so it is not a precondition here.
>
> **Words.**
> It deletes in batches: one `DeleteObjects` request takes up to 1,000 versions, each named by key and version id, and `--concurrency` (default 4) requests run at a time.
> A batch answers 200 even when an item was refused, so the tool reads the answer item by item and counts each refusal as `DeleteObjects:<class>` (`delete errors=N (...)`); an item the answer never mentions counts as `DeleteObjects:bad-output`, never as deleted.
> It ends with an authoritative `ListObjectVersions` that must show nothing; otherwise it prints `drop-archives: FAILED, versions and markers remain` and exits 5, with no `archives-dropped.json`.
> A lock refusal is reported and fails the stage: archives carry no lock, so a refusal is news, and the lock is a person's to look at.
> An archive job can still run after the drop: a version-DOI run outside the window, or a legacy per-repository `generate-archive.yml`, which writes the old key name `D/archives/v<X.Y.Z>.zip`.
> `delete-old` refuses `archives-not-dropped` if any archive version or marker is there, so after any such run, run the drop-archives dry run again, then drop again.

> **IRREVERSIBLE: step 15b, delete the old bytes**
>
> **What it destroys.**
> Every version and delete marker of every old key under `D/objects/`, by version id with the governance bypass (a locked object is the point), and the noncurrent versions under `D/version/` and `D/zarr/` that `--prune-noncurrent` names (no bypass).
> For a plan with raw copies (step 1), also every raw version the plan recorded, with the bypass (the raw text is locked), and then every raw delete marker it recorded, in requests of their own after every raw version's; a marker goes only once no version is left under its name, because a raw recording is an original hidden by its marker and removing the marker first would make the original current again.
> `annex-uuid` is never touched.
> After it nothing NEMAR controls holds the original bytes, and `$W/original.bundle` can no longer restore a usable dataset.
>
> **Preconditions you check by hand.**
> The tool checks the proofs of steps 5, 10 and 14 and that step 15a is done (the list is under "It refuses unless"); these are left to you:
> - `$W/deleted.json` does not exist yet.
> - Nothing wrote to the dataset since the plan; the tool refuses anything it did not plan, but read the dry run.
> - Step 12's manifests and records exist for every tag, so the prune of `D/version/` removes the versions they replaced; a file regenerated for the first time after this step would leave its pre-scrub version behind.
> - Step 14b passed, and for an `on` mirror step 8c's read, taken again now, still says `complete` with `integrity_checked_at` set.
> - The dry run's lines: `delete-old: keys=K versions=V markers=M planRecorded=R limit=L` and `delete-old: prune noncurrent versions=N markers=P`, and for a plan with raw copies `delete-old: raw copies names=RN versions=RV markers=RM` and `delete-old dry run: would delete raw copies versions=RV markers=RM across X names`.
>   `planRecorded` counts the old keys' versions and markers and, for such a plan, the raw versions and markers it recorded.
> - `--max-delete` is set to V+M, plus RV+RM for a plan with raw copies (it can only lower the plan's own count, never raise it), and `--max-prune` to at least N+P (default 1000).
> - For a plan with raw copies, step 5b passed (`$W/raw-verified.json` is there), and `$W/raw-unmatched.json` is not.
> - The maintainer's go is recorded: `GO delete-old <dataset> <plan-id>`.
>
> **Commands.** The dry run first, with every refusal evaluated:
> ```bash
> bun run $T/s3/s3-scrub.ts delete-old --dir $W --confirm-dataset $D --prune-noncurrent $D/version/ --prune-noncurrent $D/zarr/
> bun run $T/s3/s3-scrub.ts delete-old --dir $W --confirm-dataset $D --prune-noncurrent $D/version/ --prune-noncurrent $D/zarr/ --max-delete <V+M> --max-prune <N+P> --execute
> ```
> `--verified`, `--hash-verified` and `--git-verified` default to `verified.json`, `new-hash-verified.json` and `git-verified.json` in `$W`.
> A dry run evaluates every refusal and lists them all, so the dry run before step 15a shows everything that would stop this step: `archives-not-dropped` is the expected line then, and any other line is something to fix before the archives go.
> The working files are checked first, all of them (the proofs, `assembled.json`, `keymap.json` and the prune prefixes); if any of them refuses, the bucket is not read (`delete-old: the bucket was not read; its checks run once the working files agree`), and the bucket's checks are listed once the files agree.
> Nothing that clears a refusal of the working files is irreversible.
>
> **It refuses unless** (all exit 3, all in the dry run, and every one that applies is listed):
> - the plan is complete and not partial, and `--confirm-dataset` matches (`plan-partial`, `plan-has-unreadable`, `confirm-dataset-mismatch`); these stop before anything else is read;
> - both S3 proofs exist, parse, and name the exact bytes of `assembled.json` (`verified.json-missing`, `new-hash-verified.json-missing`, `verified-stale`, `new-hash-verified-stale`, `proof-wrong-dataset`, `proof-count-mismatch`), and `assembled.json` names this dataset and bucket (`assembled-wrong-dataset`, `assembled-wrong-bucket`);
> - the git proof exists, parses, is mode `fresh-clone`, and names this `keymap.json` and `plan.json`, and, when `git-plan.json` is in `$W`, that git plan (`git-proof-missing`, `git-proof-invalid`, `git-proof-stale`), and the keymap is this assembly's (`keymap-mismatch`);
> - every current manifest names no old key and no recording the scrub did not account for (`manifest-names-old-key`, `manifest-names-unplanned-key`, `manifest-unreadable`, `no-manifests`);
> - every EDF and BDF under `D/objects/`, a version or a marker included, is a planned or an assembled key, or a raw recording the plan recorded (`unplanned-recording`, which also counts a raw recording the plan never listed), and no name in the annex key space is a bad key (`objects-bad-key`);
> - `D/archives/` holds no version or marker at all (`archives-not-dropped`);
> - while Zarr objects are current, `zarr-verified.json` exists, names stores, and belongs to this plan (`zarr-not-scrubbed`);
> - for a plan with raw copies, `raw-verified.json` (step 5b) exists, parses, names this `plan.json` and this dataset, counts the plan's raw names, versions and markers, and matched only keys of the plan (`raw-copies-unverified`, with the reason; a proof that is there and cannot be read is `raw-verified.json-unreadable`, exit 1); it is a working file, so it is checked with the proofs, before the bucket is read;
> - every annex key a raw recording matched (step 5b), other than one this run replaces, is current at the size its key declares (`raw-duplicate-missing`, with the count: the raw recording goes because that key keeps its bytes, and a clean key's whole body was never read, only its header and size);
> - an anonymous `HEAD` of a new object, and of an old one while any remains, answers 403 (`dataset-is-public` on 200, `privacy-unproven` otherwise), and `--public-base` is the plan's bucket's own S3 endpoint over https (`bad-public-base`, exit 2); a plan that scrubs no key has no new object to ask about, so `delete-old` refuses it with `privacy-unproven` and its raw copies or Zarr history cannot be removed by this tool;
> - every version of an old key is the size its key declares (`version-size-differs`) and one the plan recorded (`version-not-in-plan`: someone wrote to an old key after the plan, so stop and find out why);
> - every version and marker under a raw name is one the plan recorded, at the size recorded, and every non-annex name under `D/objects/` but `annex-uuid` is one the plan listed (`raw-copy-not-in-plan`: a raw object written after the plan, whose bytes step 5b never compared; a plan made without raw copies refuses any raw object the same way);
> - the count is within `--max-delete` (`over-max-delete`, old keys and raw copies together) and the prune within `--max-prune` (`over-max-prune`);
> - every prefix with history (`D/version/`, `D/zarr/`) is named with `--prune-noncurrent` (`history-remains`, with the count per prefix), and a prune prefix is exactly `D/version/`, `D/archives/` or `D/zarr/` (`bad-prune-prefix`).
>
> **Words.**
> It deletes in batches, as step 15a does (up to 1,000 versions per `DeleteObjects` request, `--concurrency` requests at a time, default 4), with the governance bypass for the old recordings and without it for the pruned history, and prints a progress line `delete-old: deleted N of M in this group` after each request.
> An item S3 asked to be retried (`SlowDown`, `InternalError` and the like, as an entry of the answer) is sent again alone, and a whole request that failed with throttling, an unreachable endpoint or a timeout is sent again whole, up to five requests in all, with a jittered pause that grows each time; a lock refusal (`AccessDenied`) is final for that item and stays on the final listing.
> If a run ends with `DeleteObjects:throttled` in its `delete errors` line, S3 was busier than the pauses covered: run it again, which resumes, with a lower `--concurrency` (2).
> One version at a time, nm000186's 82,195 history entries took hours (about 6 deletions a second, one `aws` process each); a batch of 1,000 is one request, so the same history is about 90 requests.
> For a plan with raw copies the order is: the old keys (bypass), the raw versions (bypass), the pruned history (no bypass), then the raw markers (no bypass, never locked), each group in requests of its own, with the same progress line.
> It ends with an authoritative `ListObjectVersions` showing zero versions and zero markers for every old key, no history under `D/archives/`, `D/version/` or `D/zarr/`, and nothing under `D/objects/` but annex keys and `annex-uuid`, for a plan with raw copies or without; otherwise it exits 5 and writes no `deleted.json`, and a raw object left is the line `delete-old: FAILED, versions and markers remain: rawCopies=N versions=V markers=M badKeys=B`.
> A raw version the bypass could not remove (a lock without the permission) stays, and so does the marker over it, so no original becomes current; it is in the exit-5 line.
> `deleted.json` then carries `rawVersions` and `rawMarkers` beside the other counts, for a plan with raw copies only, and the run ends with `delete-old: deleted raw copies versions=RV markers=RM; zero versions and zero markers remain under the RN raw names, and no object under objects/ but annex keys and annex-uuid`.
> A re-run is safe and resumes: once the old keys are gone the new keys prove privacy, so a run that stopped at exit 5 is finished by running it again.
> `deleted.json` is removed at the start of every run, so a refused or failed run leaves none.
> An archive object that appears during the run is found by the final listing (exit 5, `history-remains`).

### Step 15c: Rebuild the archive (after 15b, before the flip)

Step 15a deleted every archive, and nothing rebuilds one by itself: the Worker's archive retry re-dispatches only an archive whose D1 `archive_status` is `failed` (`backend/src/services/archive-retry.ts`), and that column still says `ready`.
The website's download button reads that column, so it now points at a missing zip; the dataset is private meanwhile, so the button is not shown, and the archive is rebuilt here, before step 16.
An earlier version of this runbook said that no command builds an archive by hand; one does, in the central repository.
Build exactly one archive, for the latest version only (only the latest version keeps an archive, and the job deletes older ones):

```bash
V=$(jq -r '.tags | sort_by(ltrimstr("v") | split(".") | map(tonumber)) | last | ltrimstr("v")' $W/plan.json)
T15=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run run-generate-archive.yml --repo nemarDatasets/.github -f dataset_id=$D -f version=$V -f force=true
```

`version` is `X.Y.Z` with no leading `v`; the job refuses one.
`force=true` matters only when a zip is already there: the job's idempotency guard skips a version whose key exists unless `force` is true, which is also why a tag push never rebuilds the latest version's archive while its old zip is in place.
The job clones the tag with the GitHub App's token and reads the recordings with its own AWS credentials, so a private dataset is fine, and it posts `archive-ready`, which sets `archive_status` again.
Its public log shows counts, and a path on a per-file failure.
A dataset over the archive policy (more than 100 GiB or 200,000 files, `backend/src/services/archive-policy.ts`; nm000348 at 165 GB) never gets a zip: the job's preflight skips the build and posts a skip, and the checks below then expect no key.

Then confirm that the run finished and that exactly one archive exists:

```bash
gh run list --repo nemarDatasets/.github --workflow run-generate-archive.yml --created ">=$T15" --json databaseId,status,conclusion
aws s3api list-object-versions --bucket nemar --prefix "$D/archives/" --output json \
  | jq -r '((.Versions // [])[] | [.Key, (if .IsLatest then "current" else "noncurrent" end)]), ((.DeleteMarkers // [])[] | [.Key, "marker"]) | @tsv'
```

Expect the run `completed` with `success` (its log names `$D`), and exactly one line: `$D/archives/${D}_v$V.zip`, `current`.
Archive keys are named after the dataset and version, never after a file, so printing them is fine.
Any other key (for example `$D/archives/v$V.zip`, the name a legacy per-repository `generate-archive.yml` writes): stop and ask.
Running `drop-archives` again would delete the new archive with it, because that stage deletes every version under the prefix.

Re-run step 12's manifest check now.
Dispatch a manifest or records file again only if that check fails: a file regenerated after step 15b leaves the version it replaces behind as a noncurrent version, which is harmless for step 12's files, already clean, and is the reason their FIRST regeneration happens in step 12.

Last, the catalog's version DOI pointer:

```bash
nemar admin doi info $D | diff $W/doi-before.txt -          # expect no difference
```

`datasets.latest_version_doi` is written, unconditionally, by every successful version-DOI publish (`mintEzidVersionDoi` in `backend/src/services/central-manifest.ts`), and the runs of several tags race with no `concurrency` group, so the last one to finish wins.
With the window, nothing should have written it.
If the line differs, stop and ask: a version-DOI run to set it again would run the whole fan-out of the appendix.

### Step 16: Screen from inside, make the dataset public again, then verify from outside

First the screen from inside.
The old keys are gone, so a new read-only plan, into a fresh directory, reads the header of every recording that remains with the scrub's own rule:

```bash
bun run $T/s3/s3-scrub.ts plan --dataset $D --out $W/post
```

Expect exit 0 with `needScrub=0 unreadable=0 rawCopies=0 versions=0 markers=0`: no recording header has anything left for the rule to change, no raw copy is left under `D/objects/` (for nm000112 and nm000114 this is the screen of what step 15b deleted there; `annex-uuid` is never counted), and its key count equals step 1's (each scrubbed key was replaced by one new key, and each clean key stayed).
Anything else stops here, with the dataset still private.

Then the surfaces nothing else lists, as names of prefixes and counts only.
What is under the dataset's prefix:

```bash
aws s3api list-objects-v2 --bucket nemar --prefix "$D/" --delimiter / --output json \
  | jq -c '{prefixes: [(.CommonPrefixes // [])[].Prefix], loose_objects: ((.Contents // []) | length)}'
```

Expect only `objects/`, `version/`, `archives/` (none for a dataset over the archive policy), `zarr/` (none without a Zarr copy) and `corrections/`, plus anything the maintainer has named, and `loose_objects` 0.
Anything else, such as `qa/` (pipeline QA output that `scripts/hallu-qa-sync.sh` copies from Hallu) or `staging/` (an import's staging area, which a finished import removes): it is counted below; stop and ask before the flip.

Then the history and the staging copies, counts only (`staging/` is excluded from public read by the bucket policy, `backend/src/services/bucket-policy.ts`, but it is a copy NEMAR controls):

```bash
aws s3api list-objects-v2 --bucket nemar --prefix staging/ --delimiter / --output json \
  | jq -r '(.CommonPrefixes // [])[].Prefix' > $W/staging-prefixes.txt
census() {
  out=$(aws s3api list-object-versions --bucket nemar --prefix "$1" --output json) || { echo "$1 UNREADABLE"; return 1; }
  printf '%s' "$out" | jq -nc --arg p "$1" '([inputs][0] // {}) as $r | {prefix: $p, current: ([($r.Versions // [])[] | select(.IsLatest)] | length), noncurrent: ([($r.Versions // [])[] | select(.IsLatest | not)] | length), markers: (($r.DeleteMarkers // []) | length)}'
}
{ printf '%s\n' "$D/version/" "$D/zarr/" "$D/archives/" "$D/qa/" "$D/staging/" "staging/$D/"; grep '^staging/pr-' $W/staging-prefixes.txt | sed "s|\$|$D/|"; } \
  | while read -r p; do census "$p"; done
```

Expect `noncurrent` 0 and `markers` 0 for `$D/version/`, `$D/zarr/` and `$D/archives/` (step 15b removed their history, and step 15c added one current archive), and all three counts 0 for every other prefix.
A nonzero count anywhere else: stop and ask.
`UNREADABLE` is never zero: run it again.
The pull-request staging areas are `staging/pr-<N>/<id>/`, written for a pull request and removed when it closes, which is why each one is checked for this dataset.

Then the Zarr index's failure text, as counts (skip it when the proof says `no-zarr`):

```bash
aws s3 cp "s3://nemar/$D/zarr/index.json" - \
  | jq -c '{failures: ((.failures // []) | length), failures_with_detail: ([(.failures // [])[] | select((.detail // "") != "")] | length), pending: ((.pending // []) | length), pending_with_last_error: ([(.pending // [])[] | select((.last_error // "") != "")] | length)}'
```

`failures[].detail` and `pending[].last_error` hold the first line of a converter exception's message, with local paths stripped, credentials redacted and at most 300 characters (`failure_detail` in `scripts/zarr/generate_zarr.py`), and a reader of a recording can quote its header in one.
The scrub rewrites store metadata, never the index, and the index is public with the dataset (Residuals).
If either text count is nonzero, a person reads those entries before the flip and decides with the maintainer.

Last, step 14b again.

> **IRREVERSIBLE: step 16, make the dataset public again**
>
> **What it exposes.**
> Everything now in the repository and the bucket, to everyone and to every cache and crawler.
> Making it private again stops new reads and recalls nothing already read.
>
> **Preconditions you check by hand.**
> - Step 15b finished: `$W/deleted.json` exists and the run ended `zero versions and zero markers remain`.
> - `$W/zarr-verified.json` exists for this plan (a `found: no-zarr` proof is fine when there is no Zarr copy).
> - Every earlier box has its go and its record, and the plan above said `needScrub=0 unreadable=0 rawCopies=0 versions=0 markers=0`.
> - The prefix listing, the census and the Zarr index counts above are as expected, and step 14b passed again.
> - Step 15c confirmed the archive (or its skip, for a dataset over the archive policy) and the version DOI pointer.
> - The maintainer's go is recorded: `GO public <dataset> <plan-id>`.
>
> **Command.**
> ```bash
> nemar admin repo public $D
> ```
> It prompts for confirmation (`--yes` skips the prompt; use it only in a script).
> The visibility change takes a few minutes to settle, as the 2026-10-04 change to private did.
>
> **If anything below fails**, make it private again (`nemar admin repo private $D`) and stop: the new objects were verified twice, so the fault is in a manifest, a cache or a route, not in the bytes.

Wait a few minutes, then confirm with C6's two commands (the dataset's object must now answer 200).
Then the archive that step 15c rebuilt (not for a dataset over the archive policy), which must now answer 200 anonymously (`$S3` as in C6, `$V` as in step 15c):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -I "$S3/$D/archives/${D}_v$V.zip"
```

Then, from outside:

```bash
bun run scripts/identifier-fleet-scan.ts --out $W/fleet --only $D --force
jq '{status, incomplete, edf_bdf: .files.edf_bdf, flagged: .edf_bdf_files_flagged, by_kind: .findings_by_kind}' $W/fleet/$D.json
```

The scan reads the public catalog, the data plane and public S3, with `--out` required and `--only` taking this one dataset.
It exits 2 for a usage error such as a dataset that is not public yet, and 3 if a server was struggling.
Expect no direct finding (`status` is not `direct-identifiers`), and never read `unchecked`, `incomplete` or `not-screened` as clean.
Then verify each served manifest uses stable URLs and agrees with the raw version manifest, whose annex keys step 12 confirmed are new. Download one recording per version and hash it to the checksum in the served manifest:

```bash
DATA=https://data.nemar.org
for tag in $(jq -r '.tags[]' $W/plan.json); do
  aws s3 cp "s3://nemar/$D/version/$tag.json" "$W/raw-$tag.json"
  curl -fsS "$DATA/$D/$tag/manifest.json" -o "$W/served-$tag.json"
  jq -e 'all(.[]; .url == .bytes_url and (.url | type == "string"))' "$W/served-$tag.json" >/dev/null
  jq -r 'keys[]' $W/keymap.json | LC_ALL=C sort -u > "$W/old-keys.txt"
  jq -r '.files[].key' "$W/raw-$tag.json" | LC_ALL=C sort -u > "$W/raw-keys-$tag.txt"
  comm -12 "$W/old-keys.txt" "$W/raw-keys-$tag.txt" > "$W/old-keys-still-named-$tag.txt"
  echo "$tag old keys named: $(wc -l < "$W/old-keys-still-named-$tag.txt" | tr -d ' ')"
  jq -r '.[] | [.path, (.size | tostring), .checksum_algorithm, .checksum] | @tsv' "$W/served-$tag.json" | LC_ALL=C sort > "$W/served-checksums-$tag.tsv"
  jq -r '.files | to_entries[] | [.key, (.value.size | tostring), (.value.checksum | split(":")[0]), (.value.checksum | sub("^[^:]+:"; ""))] | @tsv' "$W/raw-$tag.json" | LC_ALL=C sort > "$W/raw-checksums-$tag.tsv"
  diff -u "$W/raw-checksums-$tag.tsv" "$W/served-checksums-$tag.tsv"
  ROW=$(jq -ce '[.[] | select(.path | test("\\.(edf|bdf)$"; "i"))] | min_by(.size)' "$W/served-$tag.json")
  U=$(printf '%s' "$ROW" | jq -r '.url')
  ALG=$(printf '%s' "$ROW" | jq -r '.checksum_algorithm')
  WANT=$(printf '%s' "$ROW" | jq -r '.checksum')
  curl -fsSL "$U" -o "$W/download-$tag"
  case "$ALG" in
    sha256) GOT=$(shasum -a 256 "$W/download-$tag" | cut -d' ' -f1) ;;
    sha1) GOT=$(shasum -a 1 "$W/download-$tag" | cut -d' ' -f1) ;;
    md5) GOT=$(md5 -q "$W/download-$tag") ;;
    *) echo "$tag unsupported checksum algorithm: $ALG"; exit 1 ;;
  esac
  [ "$WANT" = "$GOT" ] && echo "$tag download ok" || { echo "$tag DOWNLOAD CHECKSUM DOES NOT MATCH"; exit 1; }
done
```

Each tag must say `old keys named: 0` and `download ok`, and `diff` must be empty.
The served data-plane `url` no longer reveals an S3 key; the raw version manifest is the
authority for which keys are named, while the served manifest's paths, sizes and checksums
must agree with it. A manifest can remain in a downstream cache for up to five minutes, so
repeat after five minutes before concluding.

Then the Zarr copy, as an anonymous reader reads it:

```bash
bun run $T/s3/s3-scrub.ts zarr-public --dataset $D --zarr-verified $W/zarr-verified.json
```

It reads `zarr/index.json` and the root of every store in the union of the index's stores and the proof's, and exits 0 only when at least one store was read and every one is clean by the zarr stage's own rule, or the proof says `no-zarr` and the index names no store (so there is nothing to skip).
Its refusals are `store-not-in-index` (a store the zarr stage proved is not in the index), `no-store-checked` (no store at all and the proof is not `no-zarr`), `zarr-verified-wrong-dataset`, `zarr-verified.json-missing` and `zarr-verified.json-invalid` (exit 3), and `index-unreadable` and `index-malformed` (exit 4); a store root it could not read is exit 4, `zarr-verified.json-unreadable` is exit 1, and so is a store with an identifier or an unknown member.
It reads store roots only, because an anonymous reader cannot list the nested documents.
Check one store root through `zarr.nemar.org` too if the privacy flip was recent (step 10).
Do step 17 only after all of this passes.

### Step 17: Afterwards

- Record the deletion and the republication in the ledger, then commit and publish it again as in step 13 (it is a strict extension):

  ```bash
  A --action old-versions-deleted --proof $W/deleted.json
  A --action published-again --counts manifests=$(jq '.tags | length' $W/plan.json) --verification public-surface-clean
  cp $W/ledger.jsonl $W/clone/.nemar/corrections.jsonl
  git -C $W/clone add -f .nemar/corrections.jsonl && git -C $W/clone commit -m "Record the deletion and republication" && git -C $W/clone push origin main
  bun run $T/ledger-cli.ts publish --file $W/ledger.jsonl --dataset $D --execute
  ```

  (`A` is step 13's shell function; in a new shell, set `ACTOR` and `VERSIONS` and define `A` again.)
  `old-versions-deleted` is read, not typed: `--proof` must be `deleted.json` (parsed strictly), its counts (`keys`, `versions`, `markers`, `pruned_versions`, `pruned_markers`, and `raw_versions` and `raw_markers` when the plan had raw copies) are taken from it, `--counts` beside it is a usage error, and the verification is set to `authoritative-listing-empty+proof-<first 16 hex of the sha256 of deleted.json>` (`--verification` may be omitted or say `authoritative-listing-empty`; anything else is `verification-contradicts-proof`).
  Refusals: `proof-missing`, `proof-invalid`, `proof-wrong-dataset`, and `verification-needs-deletion` when `authoritative-listing-empty` is used with another action.
  **If `delete-old` was interrupted and run again**, `deleted.json` counts only the last run (the first run's deletions are gone, so the last run's listing never saw them), and the line would undercount.
  Add what the first run removed with `--earlier-run-counts`, read from that run's own lines (its dry run's `delete-old: keys=K versions=V markers=M` and `prune noncurrent versions=N markers=P`, less what the last run removed, which is in `deleted.json`): `A --action old-versions-deleted --proof $W/deleted.json --earlier-run-counts versions=<V minus deleted.json's versions>,markers=<M minus its markers>,pruned_versions=<N minus its pruned_versions>,pruned_markers=<P minus its pruned_markers>`, each a number you computed (the flag takes digits only and adds them to the proof's).
  For a plan with raw copies add the raw counts the same way, from that run's `delete-old: raw copies ... versions=RV markers=RM` line less what `deleted.json` says: `raw_versions=...,raw_markers=...`.
  It takes only those six names (the two raw ones only beside a proof that has raw counts), adds them to the proof's, and is refused for any other action or without `--proof` (usage error).
  nm000186 (2026-10-06) was the case: the first run, one version at a time, was stopped after removing all 176 old versions and part of the history, the rest was finished by the batch tool.
- Ask the scheduled sweep to screen the dataset again (`POST /admin/identifier-sweep/$D/rescreen` as an admin, ADR 0088), so the weekly report stops listing its pre-scrub finding; there is no CLI client for the route.
- Comment on the dataset issue in plain words and close it; tell the uploader and the authors, and the source archive for a mirror.
- Do not ask GitHub Support to clear cached views or pull-request refs: they are an accepted residual (decision of 2026-10-06).
- Walk "Residuals" for this dataset: run the read-only checks it names (the `Zenodo:` line of `nemar admin doi info $D`, and the count of this dataset's id in the logs of the central runs that ran for it) and post what they show, as counts and yes or no, on the dataset issue.
  Nothing in this procedure changes any of them.
- Delete the working directory, the bundle and the local clones: `rm -rf $W`.

## If a stage is killed

A signal (Ctrl-C, `kill`, a dropped terminal) makes `s3-scrub.ts` and `ledger-cli.ts` kill their `aws` children, remove their private temp directory (which can hold raw original bytes mid-download) and exit 130 (SIGINT), 143 (SIGTERM) or 129 (SIGHUP).
A `kill -9` does none of that: then remove `$TMPDIR/scrub-s3-*` by hand.
What a signal cannot undo is in S3, and none of it shows in `list-object-versions`:

- **assemble**: an open multipart upload for each object in progress, created with the lock parameters and billed until aborted.
  The `assemble: open upload left by a failed create: key=... uploadId=...` lines name the ones a failed create left; find the rest with `aws s3api list-multipart-uploads --bucket nemar --prefix $D/objects/` and abort each with `aws s3api abort-multipart-upload --bucket nemar --key <Key> --upload-id <UploadId>`; confirm the listing is empty.
  A new object that was completed but never reached `assembled.json` is found and kept by a re-run, so run assemble again rather than deleting it.
- **canary**: up to five locked objects under the canary prefix (`probe.txt`, `multipart-source.bin`, `multipart.bin`, and with `--batch` `batch-locked-1.txt` and `batch-locked-2.txt`, GOVERNANCE for one day), an open multipart upload (a failed abort prints `canary: abort-failed key=... uploadId=...`), and up to two unlocked versions of `conditional.json`.
  List with `aws s3api list-object-versions --bucket nemar --prefix <prefix>` and `list-multipart-uploads --prefix <prefix>`; delete each version by id (`--bypass-governance-retention` for the locked ones), abort each upload, and confirm both listings are empty.
- **zarr**, **drop-archives**, **delete-old**: some objects changed or deleted; each stage resumes on a re-run (delete-old proves privacy from the new keys once the old ones are gone).
- **hash stage**: `hashes.json` holds every key finished before the signal, and a `hashes.json.tmp` (keys only) may remain; a re-run resumes.
  A signal on the host kills the source commands with their process groups, so no `aws` child is left.
- **switch.ts**: it restores the rulesets and exits 130, 143 or 129; if it could not, it prints `RESTORE FAILED: run switch.ts restore --execute now`.
  A `kill -9` or a lost machine skips even that: run `switch.ts restore --repo nemarDatasets/$D --snapshot $W/ruleset.json --execute` at once, then `switch.ts check`.
  Which refs landed is `git ls-remote` against `before.json`'s `originTips`.

## Abort points and rollback

- Steps 0 to 6 change nothing but add new locked objects; abandoning leaves them, deleted later by version id with the bypass (the canary shows it works, and a failed canary is cleaned the same way).
  To abandon an assembly: list the versions of each new key in `assembled.json` with `aws s3api list-object-versions`, delete each with `--bypass-governance-retention`, then move `W` aside and plan again.
- Steps 7 and 8 are local and rewrite the clone in place (they prune the old objects from the clone); `$W/original.bundle` is the way back for the local state.
- Step 9 is the first change to the repository.
  Until step 15b the old S3 objects still exist, so the old tips can be pushed back from the bundle, by hand and untested: force-push the bundle's `main` and tags with the rulesets lifted, and restore the pushed `git-annex` branch the same way, because it already marks the old keys dead and retracts their holders (the alternative is to record each old key present at each holder again with `git annex setpresentkey KEY UUID 1`, with the holders read from the bundle's `git-annex` branch).
  Then regenerate the manifests and records from the restored tree with step 12's dispatches (`skip_canary: true` while private): a rolled-back dataset would otherwise serve the regenerated files, whose old versions survive as noncurrent versions until step 15b prunes `D/version/`.
  Push the rollback inside a dispatch window (steps 8b and 9b), or the tag pushes set off the version-DOI fan-out again.
- Step 10 changes objects that are not locked; their old versions survive until step 15b prunes them, which is the only way back: copy the old version over the current object (`aws s3api copy-object` with `?versionId=` in the copy source), untested.
- Step 12 adds manifest and records versions; see step 9.
- Step 15a deletes every archive version outright; the way back is the rebuild of step 15c.
- Step 15b has no rollback.
  Do it only after step 14 passes and the go is recorded, and keep `--max-delete` at the dry-run number.
  The new objects exist and are verified twice before it, so what it removes is only the old copies.
- Step 16 is undone for new reads only: make the dataset private again, and stop.

## Order of datasets

Start with the smallest confirmed one to prove the whole path, then nm000348 (156 GB of recordings across 5 tags, the reported one), then the rest by size.
Sizes (Sep 15 snapshot): nm000186 0.5 GB, nm000176 0.8 GB, nm000114 0.9 GB, nm000246 62.7 GB, nm000348 165 GB.
Read-only plans made on 2026-10-04: nm000186 has 3 tags and 176 keys (541 MB to hash); nm000348 has 5 tags and 525 keys (156.4 GB to hash); every key in both needs a scrub.
Those plan files predate `patchesSha256` and are refused by every later stage, so plan again.
The Zarr copy of nm000348 holds none of the removed members, and its zarr stage run is a clean proof with nothing to remove.

## Residuals: what this procedure does not remove

Each item below is left in place, on purpose or because NEMAR cannot reach it, with the reason and who decided.
None of them is solved, and none may be reported as solved.

1. **GitHub pull-request refs and cached views.**
   Twelve of the sixteen repositories carry two to five `refs/pull/<N>/head` each (read on 2026-10-06: nm000112 4, nm000149 2, nm000173 3, nm000176 3, nm000186 2, nm000191 2, nm000197 3, nm000200 3, nm000277 4, nm000301 4, nm000340 4, nm000348 5; nm000114, nm000246, on005007 and on005383 none).
   A pull-request ref survives a force-push and cannot be deleted by the repository's owner, so it keeps the pre-scrub commits reachable: once the repository is public, anyone can fetch `refs/pull/*/head` and read the old trees, with the old pointer files and keys, the inline JSON the rewrite blanked and the file names it dropped.
   Not the recordings: their old bytes are gone after step 15b.
   GitHub's cached views of old commits are the same kind of copy.
   Decided by the maintainer on 2026-10-06: "Don't worry just force push and move forward, these are not our mistakes, we do our best."
   No GitHub Support request and no recreation of the repository.
   A branch is not this: it is deleted before the clone ("Before each dataset", item 7).
2. **The Hallu copies.**
   `scripts/hallu-sync.sh` (hourly, by its header; the live crontab is UNVERIFIED) keeps, for every public `nm` dataset, a clone with its annexed content under `/data/qumulo/openneuro/<id>` and the archive zip as `zip_files/<id>.zip`, readable by the `nemar` group, and never deletes a dataset that goes private (it removes only an incomplete download).
   `processed/<id>/` holds the pipeline's QA output, which `scripts/hallu-qa-sync.sh` copies to `s3://nemar/<id>/qa/` (step 16 lists that prefix).
   Decided by the maintainer on 2026-10-06: "Leave the Hallu copies."
   What the operator will see: at first, nothing.
   The sync compares the version it recorded with the catalog's latest version, and a scrub keeps the version numbers, so it logs `[SKIP] <id>: data up to date` and keeps the pre-scrub clone and zip without an error.
   The rewrite shows on the dataset's next new version: `git pull --ff-only` cannot fast-forward over rewritten history, so every hourly run then logs `[FAIL] <id>: git pull failed` until someone replaces the clone, while the zip is replaced by the new version's archive.
   A read-only look on the host (needs ssh, not run for this runbook): `ssh hallu "ls -d /data/qumulo/openneuro/$D; ls -l /data/qumulo/openneuro/zip_files/$D.zip; ls -d /data/qumulo/openneuro/processed/$D"`.
3. **Zenodo.**
   A version-DOI run uploads a backup of the tag (`maybeZenodoBackup` in `backend/src/routes/callbacks/version-doi.ts`): GitHub's zip of the tag's git tree, so pointer files, inline JSON and file names, never a recording and never the S3 archive.
   It is skipped for an `on` dataset and when no key is configured, fails above 100 MB, and stays a draft; it is never published.
   A draft made before the scrub holds the pre-scrub tree.
   Published legacy Zenodo records (concept DOIs `10.5281/zenodo.*`, from the datasets deposited when Zenodo was the registrar) cannot be deleted by NEMAR.
   Whether a draft or a record exists for a dataset, and whether a Zenodo key is set in production, is UNVERIFIED: `nemar admin doi info $D` prints a `Zenodo:` line when the row records a deposition, and whether that is a draft or a published record has to be read at Zenodo.
   Not decided: the maintainer has not ruled on drafts, and a published record is beyond NEMAR.
4. **Public Actions logs of `nemarDatasets/.github`.**
   The repository is public and keeps logs for 90 days (read on 2026-10-06, when the runs on record were: `run-bids-validation.yml` 6,140, `run-enrichment.yml` 2,537, `generate-manifest.yml` 1,674, `generate-records.yml` 1,141, `run-generate-archive.yml` 1,096, `run-version-doi.yml` 1,080).
   For the pre-scrub trees these logs printed file paths, README-derived metadata (the enrichment responses), the validator's whole JSON and the first bytes of each records file.
   Whether any validator message quotes header text is UNVERIFIED.
   A counts-only check of one run: `gh run view <id> --repo nemarDatasets/.github --log | grep -c "$D"`.
   Not decided: the logs expire after 90 days; deleting a run's logs sooner is possible for an admin (`DELETE /repos/{owner}/{repo}/actions/runs/{run_id}/logs`, not run for this runbook) and is the maintainer's call, which the decisions of 2026-10-06 did not make.
5. **The Zarr index's failure text.**
   `failures[].detail` and `pending[].last_error` in `<id>/zarr/index.json` keep the first line of a converter exception; the scrub rewrites store metadata, never the index, and the index is public with the dataset.
   Not decided in general: step 16 counts them and stops for a person when either count is nonzero.
6. **Copies others made**: downloads, forks, and other systems' ingestion of the bucket (what EEGDash keeps is UNVERIFIED) are beyond NEMAR, as ADR 0085 says.

## Appendix: what a push fires

What a push to a dataset repository sets off when no window is open, one row per job, as an operator needs it (read from `backend/src/routes/webhooks/github.ts`, the central workflows on `nemarDatasets/.github` `main` at `1452d11`, and the legacy files on nm000197).

| Trigger | Job | What it writes | What its public log shows |
|---|---|---|---|
| a `v*` tag push, by the Worker (not for an anonymous deposit) | `run-version-doi.yml`: create the release if missing | a GitHub release for the tag, only when none exists | the tag |
| same run | refresh enrichment (`POST /webhooks/llm-enrich`, forced) | D1 enrichment and metadata, the search index, the concept DOI's EZID metadata | the whole response body |
| same run | publish the version DOI (`POST /webhooks/publish-version-doi`) | D1 `manifest_jobs`; `datasets.latest_version_doi`, unconditionally (no `concurrency` group, so the last tag to finish wins); nothing new at EZID for a DOI already public; a Zenodo draft of the tag's git tree when a key is set; dispatches `generate-manifest.yml` with `skip_canary` | the DOI and the job's status |
| the publish step | `generate-manifest.yml` | `<id>/version/<tag>.json` and `<tag>-summary.json`; D1 `dataset_versions` by its callback | the callback's response; what the emitter prints is UNVERIFIED |
| the run's `trigger-archive` job | `run-generate-archive.yml` | `<id>/archives/<id>_v<X.Y.Z>.zip`, skipped when that key exists unless `force`; D1 `archive_status`; deletes older archive versions | counts, and a path on a per-file failure |
| the run's `trigger-records` job, only after a successful publish | `generate-records.yml` | `<id>/version/<tag>-records.json`, every time | the first 2,000 and 1,500 bytes of the records file |
| a `main` push touching `README.md` or `dataset_description.json`, by the Worker | `run-enrichment.yml` | commits `.nemar/metadata.json` and `.bidsignore` to `main` as `nemar-publish-bot`; D1 | the whole response body, which carries the generated metadata |
| a `main` push, by the repository's `bids-validation.yml` shim | `run-bids-validation.yml` | a check-run on the commit, with up to 50 error rows naming paths | the validator's whole JSON |
| a `v*` tag push whose commit carries the legacy `version-doi.yml` | legacy `version-doi.yml`, run from the tag's own commit in the dataset repository | the same release, enrichment and publish calls as the central run, then a `generate-archive` dispatch to its own repository, where a legacy `generate-archive.yml` on `main` writes `<id>/archives/v<X.Y.Z>.zip` | the dataset repository's own log, private while the dataset is |
| a `main` push touching `README.md`, `dataset_description.json` or `.nemar/metadata.json`, when `main` carries the legacy `llm-enrichment.yml` | legacy `llm-enrichment.yml` | enrichment, as the central run does | the dataset repository's own log |
| a push of the `git-annex` branch | nothing: it is neither `main`, a `release/*` branch nor a `v*` tag | | |
| any push | no Zarr conversion: the converter runs on the Hallu cron (ADR 0029) | | |
