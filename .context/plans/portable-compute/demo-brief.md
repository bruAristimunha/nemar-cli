# Demo brief: portable compute, Sunday 2026-11-15

This page is for the owner.
It says what can be shown, what is live and what is recorded, what each part proves and does not prove, and what comes next.
Times are Pacific.
Every row rests on a gate that passed in recorded evidence; anything without a passed gate is under "does not prove yet".
Last updated 2026-11-14, after DM-15 (the recorded run through a local NEMAR stack) passed and section 4 was rehearsed once.

Key: DM-nn and PX-nn name cards of the plan.
G1 the demo workstation runs the digest-pinned image with limits; G2 the control-plane tests; G3 the runner tests; G4 the image identity and signature; G5 the job record says `finished` on the runner; G6 provenance records are schema-valid; G7 the runner discarded its scratch; G8 the reader opens the recordings and matches the index.
F1 is the recorded run through the local stack (DM-15); F2 is the manual run (F2-a container run, F2-b reader, F2-c tests; DM-19).

## 1. What you can say

"NEMAR's quality control (QC) recipe, built on eegprep, ran in a container identified by its image digest on a lab workstation over a real public electroencephalography (EEG) dataset, streaming the recordings from NEMAR's Zarr serving copy with no dataset download and nothing kept on disk, and wrote QC tables with signalJourney provenance; the same recordings open in mne-python.
QC ran on NEMAR's Zarr serving copy (EEG capped at 250 Hz, 16-bit; the serving copy of this dataset is at 200 Hz), not on the archived recordings.
The pull-based runner and its queue are built and tested against NEMAR's real control-plane code; they are not yet deployed."

Add: the container image was built and signed in continuous integration (CI).
Add (F1): "A recorded run shows the runner on the lab workstation claiming a job from a local NEMAR test stack on the presenter's laptop, not staging and not production, running it from the signed image, and completing it in about 23 seconds."
Label the manual run "manual run, not dispatched by NEMAR" and the F1 run "recorded, run through the local stack".
The 250 Hz figure is a rate cap (Architecture Decision Record (ADR) 0028), not a target.
The archived recording's own rate was not checked: say "not shown" if asked.
Never say or imply: runs on high-performance computing (HPC) unchanged, the runner verified a signature, private data, EEGLAB support, EEGDash integration, derivatives published or citable, catalog-scale throughput, or a consolidated NEMAR reader.

## 2. Live or recorded

Dataset: public `nm000274` `v1.0.5` (tag commit `91a8f5c9c83117b7e064cf7ae4eef1220b81cf57`, Zarr index source commit `64feed5210ebea128a8484acd3027f9551ff2d7e`; only `.nemar/availability-report.json` and `.nemar/metadata.json` changed since the tag, verdict `metadata_only`).
Image: `ghcr.io/nemarorg/nemar-python@sha256:33922cad47b58098079905edb9a06e688e533c30e0a24e364c0306f0f14c431a` (tag `0.1.0-cpu`), built by the CI image run on nemar-process `main` at `9212eb5a919cfdd5d6b74fc77f8ea7aed807fc70`.
"Cli head" is nemar-cli `27868ce1b2ea81424b42a3bc518f750821717de9`; "process head" is nemar-process `13b3a899f2adf42b01120496cb902abf19feb1b2`; "reader commit" is eegprep-lean `14ba46e8da5340cd7ae6adb644cda24fb3f5e483`, which is on the `develop` branch of eegprep.

| Step | Mode | Recorded time and commit | Gate |
|---|---|---|---|
| Signature and digest | recorded | signature check 2026-11-14 00:17 (the signature check record: anonymous, against the CI workflow identity and the OpenID Connect issuer, a wrong-identity control fails); CI's own signing step passed in public run 43545538455 on `main`; pulled by digest on the demo workstation and equal, 2026-11-13 23:48; `main` `9212eb5a` | G4 |
| Limits | recorded | 2026-11-13 23:49, DM-14 smoke test of the image digest | G1 |
| Recipe in a container | live, about 15 s | 2026-11-13 23:54, image digest, `main` `9212eb5a` | F2-a |
| Provenance check | live | 2026-11-13 23:55, validator at the process head | G6 |
| Discard of the manual run | live | 2026-11-13 23:55, image digest (shell commands only) | F2-a |
| Reader in mne-python | live | 2026-11-13 23:55, reader commit | G8 |
| Control-plane tests | live, about 20 s after install | 2026-11-14 00:00, cli head | G2 |
| Runner and launcher tests | recorded only, about 4 minutes | 2026-11-14 00:00, process head | G3 |
| Runner against a stand-in in CI | recorded only | 2026-11-13 19:30, CI run on the process head | G3 |
| Job through the local stack | recorded only | 2026-11-14 00:09:36 to 00:09:59, cli head, process head, image digest | G5 |
| F1 outputs, discard and reader | recorded only | 2026-11-14 00:10, process head (validator), reader commit | G6, G7, G8 |

Every live row has a recorded fallback; the recordings are the operator's transcripts and plain-text logs.
The commands of section 4 were run once as written in a rehearsal on 2026-11-14 (F2 and the tests passed; F1 was not run live).

## 3. What it proves and does not prove

What it proves, one line per passed gate:

- G4: the image on the demo workstation is the CI-built digest named above, and CI signed it (the signature was checked by hand on the operator's machine).
- G1: Docker on the demo workstation enforces memory and CPU limits and control groups version 2 on a small smoke container (python image, memory 268435456 bytes, cpu `100000 100000`); the demo run passed the same flags, but its own enforcement was not measured.
- F2-a: the recipe processed 4 of 4 EEG stores over the network in 14 s (exit 0) in a read-only container with all capabilities dropped, 4 CPUs and 16 GiB, and wrote 5 records; the outputs were deleted afterwards (the image and its layers stay in Docker's cache on purpose).
- G6: all 5 signalJourney records are schema-valid, in the manual run and in F1 (22 output files downloaded); the aggregate record names the image digest and both dataset commits.
- G8: the same 4 EEG recordings open in mne-python with 32 channels at 200 Hz and the index's sample counts, in both runs.
- G2: the control-plane tests (six files, 254 pass, 0 fail, plus typecheck, lint and the Cloudflare SQLite database (D1) catalog check) pass on the cli head.
- G3: the runner and launcher tests pass on the process head (3781 passed, 57 skipped: 45 Apptainer container tests plus 12 others, Linux-only features and a drift check that needs a nemar-cli checkout and runs in CI); the CI job ran the runner against a local stack with real Apptainer (2 tests, a tiny stand-in image on a seeded fixture dataset, not the QC recipe).
- G5: job `job_c574b14326174e8d1a307d1e` for `nm000274@1.0.5` was dispatched through the real routes of a local NEMAR stack, claimed and run by `nemar-runner` on the demo workstation over a reverse tunnel with Docker and no image pull, and ended `finished` (executor `runner`, backend `local`, provenance and manifest status ok, results verified).
- G7: after the F1 job the workstation had 0 job directories and the runner log shows `scratch_discarded` once.

What it does not prove yet:

- Staging or production: no staging or production NEMAR API, database, switch or deployment was touched; the recipe reads files from the public Zarr serving host, which is a production host, read only.
- The F1 stack is a local test stack on the presenter's laptop, shown only from the recording, since a live rerun needs a fresh stack; a job from a real account was not shown, nor a second workstation.
- That the runner verifies image signatures, or enforces per-job limits (its F1 log shows `enforce_limits` false).
- Private data, and HPC or any scheduler.
- The Zarr conversion migration: the conversion cron is untouched.
- The fidelity of the serving copy: QC values describe the serving copy, and the archived recording's own rate was not checked.
- Where derivatives will live: outputs existed only on the workstation's scratch, the local stack and the operator's evidence directory, not in any NEMAR store.
- Reproducibility of the input: the recipe writes `index_sha256` and `bytes_read`, but the platform does not verify them, G6 proves schema validity only, and in the aggregate record the commit check is `attested_by_caller`, so the `metadata_only` verdict is the operator's check, not the platform's.
- A consolidated reader: `eegprep-lean` at a commit now on `develop`, not a release; the image's pin moves to a release later (step PX-08).
- Release provenance in the records: image `0.1.0` predates the release-provenance change (nemar-process pull request 28), so its records carry the image digest but not the nemar-process release version and commit.
- The full `bun test` suite was not run.

## 4. Run order for Sunday

Set the placeholders once; every path and login is expanded locally, and an unset runner root makes each command that uses `${R:?}` fail instead of running.
No key is needed for F2, which reads only public data; ssh access to the workstation is.
F2 live takes about one minute with warm caches (a cold laptop needs GitHub and PyPI access for the reader and the validator, and a longer first run).

```bash
W="<workstation login>"; R="<runner root on the workstation>"; E="<absolute evidence directory>"
N="<nemar-process checkout at the process head>"; C="<nemar-cli checkout at the cli head>"
H=33922cad47b58098079905edb9a06e688e533c30e0a24e364c0306f0f14c431a
IMG=ghcr.io/nemarorg/nemar-python@sha256:$H

# F2 preflight: the workstation answers, Docker answers, the image digest is present (the output must show the digest above)
ssh "$W" "docker info --format '{{.ServerVersion}}'"
ssh "$W" "docker image inspect --format '{{json .RepoDigests}}' $IMG"

# F2-a (DM-19 steps 2, 3): the recipe in the container, with exit code and wall time
ssh "$W" "mkdir -p -m 0700 '${R:?}/manual/out'"
ssh "$W" "start=\$(date +%s); docker run --rm --user \"\$(id -u):\$(id -g)\" --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --cpus 4 --memory 16384m --mount type=bind,src=${R:?}/manual/out,dst=/work/outputs $IMG nemar-recipe run nemar-floor-zarr --out /work/outputs/product --dataset-id nm000274 --dataset-version v1.0.5 --source-commit 64feed5210ebea128a8484acd3027f9551ff2d7e --tag-commit 91a8f5c9c83117b7e064cf7ae4eef1220b81cf57 --commit-equivalence metadata_only --image-digest sha256:$H --zarr-base https://zarr.nemar.org --commit-delta-path .nemar/availability-report.json --commit-delta-path .nemar/metadata.json; rc=\$?; echo EXIT=\$rc WALL=\$(( \$(date +%s)-start ))s"

# F2-a (DM-19 step 4): copy back, validate, discard
rm -rf "${E:?}/product"; mkdir -p "$E"
scp -r "$W:${R:?}/manual/out/product" "$E/"
cd "$N" && find "$E/product" -name '*signalJourney.json' | while read -r f; do uv run --group signaljourney python scripts/validate_signaljourney.py "$f"; echo "rc=$?"; done
ssh "$W" "rm -rf '${R:?}/manual' && test ! -e '${R:?}/manual' && echo discarded"

# F2-b (DM-19 step 5): the reader on each store (the store argument is the index path key, the .edf path)
for s in sub-4/ses-0/eeg/sub-4_ses-0_task-imagery_acq-finaltest_run-1_eeg.edf sub-4/ses-0/eeg/sub-4_ses-0_task-imagery_acq-finaltrain_run-0_eeg.edf sub-5/ses-0/eeg/sub-5_ses-0_task-imagery_acq-finaltest_run-1_eeg.edf sub-5/ses-0/eeg/sub-5_ses-0_task-imagery_acq-finaltrain_run-0_eeg.edf; do
  uv run --no-project --with "eegprep-lean[zarr,mne] @ git+https://github.com/sccn/eegprep@14ba46e8da5340cd7ae6adb644cda24fb3f5e483#subdirectory=packages/eegprep-lean" python -c "import sys, eegprep_lean as L; r = L.to_mne_raw(L.load_recording('nm000274', sys.argv[1])); print(r.info['nchan'], r.info['sfreq'], r.n_times)" "$s"
done

# F2-c (G2): the control-plane tests, live
cd "$C" && bun install --frozen-lockfile && (cd backend && bun install --frozen-lockfile)
cd "$C" && bun test backend/test/compute-runner-registry.test.ts backend/test/compute-runner-end-callers.test.ts backend/test/compute-runner-jobs.test.ts backend/test/compute-runner-queue.test.ts backend/test/compute-local-stack-runner.test.ts test/admin-compute-runners-cli.test.ts 2>&1 | tail -15
```

Expected: the recipe summary shows 4 discovered and 4 succeeded, then `EXIT=0` and a wall time near 14 s; `rc=0` five times; `discarded`; `32 200.0` with the sample counts 160000, 96000, 160000, 96000; the last test lines show 254 pass, 0 fail across 6 files.

F1 is shown from the recording: the job record, the gate logs (G6 to G8) and the runner log, all from 2026-11-14 00:09 to 00:10.
A live F1 needs a fresh stack, because a stack runs one live job per dataset version and the finished job still exists.
It is not part of Sunday's live run.

## 5. If something fails on stage

Switch in this order and say "recorded" aloud each time.
1. Recipe run or network trouble: the recorded recipe transcript (2026-11-13 23:54, exit 0 in 14 s).
2. F1 itself: it is only ever shown as the recorded transcript and gate logs (2026-11-14 00:09 to 00:10).
3. Validation or discard: the recorded logs (2026-11-13 23:55).
4. Reader: the recorded reader transcript (23:55).
5. Tests: the recorded test transcripts (2026-11-14 00:00).
6. Anything else: stop and answer from section 3.

On a 500 from the Zarr host, retry once after a pause, then switch to the recording.
A question outside the evidence gets "not shown yet", with the matching line from "does not prove yet".

## 6. Next

- Phase S (staging and production runner jobs): S1, a dev-owned compute fixture `nm099996` eligible outside production only; then S2, the epic reaching `dev` with a staging job finished.
- Phase Z (Zarr conversion becomes a pipeline): Z0, ADR 0123 proposed after the frontier review; then Z1, the formats contract file.
- Phase R (readers): R0, the collaborator's reader epic arriving upstream with ADR 0120; then R1, the eegprep-lean engine transport plus one conformance suite for the three readers.

Open items for the owner: the architecture slide named in plan section 3.4 does not exist yet.
