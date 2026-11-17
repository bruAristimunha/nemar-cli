# NEMAR as an indexed source on Brainlife: plan and handoff

STATUS: closed out on our side and waiting on the Brainlife maintainers (as of 2026-11-17).
Tracking issues: nemarOrg/nemar-cli#2195 (ours), brainlife/docs#157 (theirs).
The issues hold the live checklist; this document holds the evidence and the handoff.

## Goal

NEMAR datasets (EEG, iEEG, MEG and other electrophysiology) appear in Brainlife's dataset browser with the same standing as OpenNeuro, and Brainlife apps can stage them.
Brainlife is on board and will adapt its side; we make small changes on ours and offer small PRs on theirs.

## Decisions (owner, 2026-11-17)

- Index the `on` mirrors; Brainlife skips or merges the ones already in its OpenNeuro index, using the `mirror` flag.
- New `neuro/ieeg/*` datatypes.
- Exclude anonymous deposits.
- Clone route first (the existing DataLad flow); the `url` route is a later follow-up.

## Verified findings (read-only, 2026-11-17)

- Only some published repos are DataLad datasets: 5 of 189 `nm` repos and 486 of 521 `on` repos in a 710-repo sample.
  The rest are plain git-annex repos with a public S3 special remote (`autoenable=true`, `publicurl`).
  Anonymous `git annex get` on the plain repos works (experiment E2, 2026-11-17: `nm000335`, `nm000276`, `on002718`; small files, checksums verified, content from the public `nemar-s3` remote).
- Brainlife's registry already has `neuro/eeg/{eeglab,edf,bdf,brainvision,egi}` and `neuro/meg/{ctf,fif,BTi4D}`.
  The gaps are in `brainlife/cli` `bids-walker.js`: no iEEG datatype and the `ieeg/` folder is skipped (about lines 343-364); EEGLAB is detected only from `eeg.fdt` (about line 910), so single-file `.set` datasets such as HBN index zero objects.
- `brainlife/warehouse` `bin/importdatalad.js` throws on an unknown datatype inside an async callback (about line 137), parses a version only for `OpenNeuro/` paths (about line 77), and has a `bids.CHANGED` typo (about line 122).
  `ui/src/datasets.vue` and `ui/src/dataset.vue` hardcode the same prefix.
- `GET /datasets/:id/versions` is not public.
  Use `GET /datasets` (`source`, `source_id`, `latest_version`) and `data.nemar.org/<id>?format=json` (`mirror`, versions).
- 181 of the 583 `on` mirrors are already in Brainlife's OpenNeuro index; 402 are not.
- Walker experiment (the real walker in memory over NEMAR manifests): EDF, BrainVision and FIF datasets index fully; HBN-style `.set` and iEEG-only datasets index nothing.

## Eligibility rule

Id matches `^(nm|on)\d{6}$` excluding `nm099xxx`, `anonymous == 0`, and `latest_version != null`.
Re-index by polling `GET /datasets` and diffing `latest_version`.
Never touch `nm000103`-`nm000107` (live datasets).

## Next actions (in order)

1. Wait for the Brainlife reply on brainlife/docs#157 (clone prefix, who registers the datatypes, re-index cadence).
2. E2 is DONE and passed (see above).
   Still open: fetch one large chunked object anonymously (for example from `nm000276`).
3. On their go-ahead, send small PRs:
   `brainlife/cli` (EEGLAB from `eeg.set`; iEEG handler), then `brainlife/warehouse` (prefix generalization, skip-and-record unknown datatypes, NEMAR removal script).
   The registry change (make `fdt` optional, add `neuro/ieeg/*`) needs a Brainlife admin.
4. Our side, small and independent: a docs page "Indexing NEMAR"; fix inconsistent release tags on two datasets; optionally expose `source_version` publicly or add `?since=` to the listing.
5. Later: a `url`-storage importer pinning `data.nemar.org/<id>/<version>/` URLs; a `nemar` mount in `ga-launcher`; NIRS, EMG and motion datatypes.

## Not verified

A large chunked object fetched anonymously, how Brainlife populates its DataLad tree, one very large dataset (about 100k files), and staging of single recordings of 100 GB or more (an operational concern for their shared disk).
