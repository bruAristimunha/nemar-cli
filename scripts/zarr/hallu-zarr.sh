#!/usr/bin/env bash
################################################################################
# NEMAR SDSC Hallu Zarr conversion (queue-driven)
#
# Purpose: Build the derived, latest-only Zarr serving copies for NEMAR public
#          datasets ON Hallu (ample compute + a 1 Gbps link, no GitHub Actions
#          120-min cap) and push them to s3://nemar/<id>/zarr/. Epic
#          nemarOrg/nemar-cli#684; the conversion engine replaces the
#          run-generate-zarr.yml Actions path for bulk/backfill.
#
# Design: self-contained, EPHEMERAL, and crash-safe via a persistent SQLite
#         queue (scripts/zarr/zarr_queue.py). Each run:
#           1. reconcile -- enqueue every public dataset whose latest version
#              isn't converted yet, and reset any `inprogress` job left by a
#              crashed/rebooted run back to `pending`.
#           2. drain     -- claim the oldest job, clone the dataset's metadata
#              only (`nemar dataset download --no-data`, seconds), then the
#              biosigIO driver STREAMs each recording's annex blob from
#              s3://nemar/<id>/objects/<key> just-in-time -> convert -> push,
#              JOBS recordings in PARALLEL (ProcessPoolExecutor), onto NVMe
#              scratch; `rm -rf` the scratch copy and mark the job done (or fail
#              w/ backoff). Repeat until the queue is empty (or --limit).
#              Streaming + parallelism start converting immediately, never hold
#              the whole dataset, and saturate Hallu's cores on the CPU-bound
#              resample/compress.
#         flock keeps a single long backfill draining across hourly cron ticks
#         (a later tick finds the lock held and exits). As long as the box is on,
#         the cron fires and the queue resumes exactly where it left off. The
#         drain also stops itself at a dataset boundary when origin/$DRIVER_REF
#         moves, so a merged driver change reaches the node on the next tick
#         instead of waiting out the backfill (#1129).
#
#         SLOTS (ADR 0101). A tick no longer drains the queue itself: it starts
#         one drain per FREE slot (ZARR_SLOTS, default 4), each under its own
#         lock, with its own scratch directory and log, claiming its own dataset
#         and converting it ZARR_JOBS_PER_SLOT (default 4) recordings at a time. A
#         dataset that takes days (nm000276: 40 recordings of 100 to 145 GiB)
#         then occupies one slot instead of the whole node. The slots share one
#         RAM and scratch budget through the admission ledger (ZARR_LEDGER_DIR), so
#         several big datasets cannot fill the disk between them, and a heartbeat
#         keeps a long conversion from looking abandoned to another slot.
#
# Usage:
#   ./hallu-zarr.sh                      # reconcile + drain the queue
#   ./hallu-zarr.sh --limit 20           # cap datasets per run (paced); each slot has its own cap
#   ./hallu-zarr.sh --dataset nm000132   # one dataset now, in the first free slot
#   ZARR_SLOT=2 ./hallu-zarr.sh          # drain as slot 2 only (what a tick starts)
#   ./hallu-zarr.sh --stats              # print queue status and exit
#   ./hallu-zarr.sh --requeue failed     # dry-run: what a requeue would revive
#   ./hallu-zarr.sh --requeue all --execute   # revive failed + data_failed
#   ./hallu-zarr.sh --backfill-dir-formats            # dry-run: the #1172 sweep
#   ./hallu-zarr.sh --backfill-dir-formats --execute  # requeue what it found
#   ./hallu-zarr.sh --preview-engine-bump             # what an engine bump costs
#   ./hallu-zarr.sh --test                     # against api-test.nemar.org / nemar-dev
#   ./hallu-zarr.sh --test --print-config      # resolved --test config, no side effects
#   ./hallu-zarr.sh --print-config             # resolved prod config, no side effects
#
# --requeue exists because the retry budget for `failed` was spent on OOM-killed
# workers taking whole datasets down (#1110), and `data_failed` was reachable by
# a classifier that recorded a runtime out-of-memory as a permanent property of
# the data (#1111). Both give-ups predate the fixes, so they deserve one more
# attempt; a genuine data failure simply returns to data_failed next run.
#
# --backfill-dir-formats is the one-off recovery for the cohort stranded before
# the queue stamped an engine version (#1172): MEG/iEEG datasets converted before
# epic #1095 taught discovery to see MEF3 `.mefd`, CTF `.ds` and 4D/BTi recording
# DIRECTORIES. Those runs found nothing, succeeded, and were marked `done`, so
# neither `reconcile` (no version change) nor the engine stamp (added after they
# converted) can reach them. It reads the published index and the dataset file
# list to identify them by evidence, and requeues only with --execute.
#
# Every conversion rebuilds the whole dataset (the driver's --clean) so the
# serving copy mirrors the current dataset. --clean RECONCILES rather than
# erases: each store is synced with --delete and only stores that no longer
# exist in HEAD are removed, after a successful conversion (ADR 0023). The one
# exception is a retry round from the queue (#1483): when the published index
# is otherwise current, only its pending recordings are converted.
#
# Crontab (sibling of hallu-sync, offset to :30):
#   30 * * * * /path/to/hallu-zarr.sh >> /mnt/local/zarr-state/.nm-zarr-cron.log 2>&1
#
# Prereqs: curl, jq, git, git-annex, nemar CLI, aws, uv, python3 in PATH.
################################################################################

set -uo pipefail

# --- Bash 4+ required (nemarOrg/nemar-cli#1180, epic #1181 phase 3) -----------
# The --test guard rails' host check (_is_prod_api_host, further down) uses
# ${var,,} lowercasing, a bash 4.0+ feature. Under bash 3.2 (macOS's stock
# /bin/bash) that expansion is a "bad substitution": _is_prod_api_host errors
# out and returns non-zero, so its `if _is_prod_api_host ...` caller reads
# that as "not prod" and every host guard silently PASSES -- the exact
# failure mode this script exists to close, just moved to a different layer.
# Fail loud here instead, before anything else runs, rather than silently
# degrading to "allow" on the wrong interpreter.
if ((BASH_VERSINFO[0] < 4)); then
  echo "FATAL: hallu-zarr.sh requires bash 4+ (the --test host guards use" \
       "\${var,,} lowercasing); running under bash ${BASH_VERSION:-unknown}." >&2
  exit 1
fi

# --- PATH bootstrap (Homebrew/Bun/uv installed under $HOME) -------------------
for p in "$HOME/.local/homebrew/bin" "$HOME/.bun/bin" "$HOME/.local/bin"; do
  [[ -d "$p" ]] && PATH="$p:$PATH"
done
export PATH

# --- Test-mode pre-pass (nemarOrg/nemar-cli#1180, epic #1181 phase 3) ---------
# A second, independently-stated Hallu invocation against zarr-test.nemar.org /
# nemar-dev, not a code fork: --test is a scan over "$@" that runs BEFORE the
# Config block below and exports a default for each variable ONLY when it is
# still unset, so Config's existing "${VAR:-default}" everywhere just resolves
# to the test value instead of the prod one. This has to be a separate pre-pass
# rather than a case arm in the real parser further down, because the real
# parser runs AFTER Config has already read its defaults -- too late to steer
# them. --test is deliberately left in "$@": the real parser (below) still
# consumes it, to record TEST_MODE=1 for the "[test]" log prefix, without a
# second parse of the arguments.
#
# TEST_PREPASS_SEEN is the one variable this pre-pass sets that nothing else
# derives or overrides: a raw record of "--test was literally present in the
# original argv", independent of whatever the real parser below does with it.
# The guard rails further down key off THIS, not off the real parser's
# TEST_MODE, because a value-taking flag with a permissive parser can consume
# the following token as ITS OWN value -- `--dataset --test` used to leave
# `--test` swallowed as a dataset id, so TEST_MODE stayed unset and the guard
# block (which checked TEST_MODE) never ran at all, even though this pre-pass
# had already applied test defaults on top of whatever prod values were
# ambient. `--dataset`/`--limit` now refuse a value starting with "--" (see
# the arg parser below), which closes that specific hole, but the guard
# rails no longer trust TEST_MODE to agree with reality regardless: as long
# as this pre-pass's own scan saw "--test" anywhere in argv, the guards run.
#
# ZARR_JOBS defaults to 4, not nproc like the prod default: a test instance
# runs on the SAME Hallu box as the prod backfill and must not contend with it
# for cores.
#
# TEST_API_URL is NOT part of issue #1180's env-var inventory -- that
# inventory covers this script and the Python driver/queue, both of which
# already take API_BASE/--api-base. It missed that convert_dataset() also
# shells out to the separate `nemar` CLI binary (`nemar dataset download`),
# whose own API base resolution (src/lib/api/client.ts getApiUrl()) is
# entirely independent of API_BASE: it reads TEST_API_URL first, then a
# stored account config, then defaults to api.nemar.org. Without this, the
# metadata clone step in --test mode looks up the dataset against PROD and
# fails "Dataset not found" for a dev-only xx0999NN exemplar, discovered live
# against xx099905 during this phase's verification. TEST_API_URL is existing
# CLI plumbing (already used for staging e2e tests, AGENTS.md's "isolated
# NEMAR_CONFIG_DIR" pattern), not a new mechanism -- this just wires --test
# into the hook that was already there.
TEST_PREPASS_SEEN=""
for _pretest_arg in "$@"; do
  if [[ "$_pretest_arg" == "--test" ]]; then
    TEST_PREPASS_SEEN=1
    export API_BASE="${API_BASE:-https://api-test.nemar.org}"
    export TEST_API_URL="${TEST_API_URL:-https://api-test.nemar.org}"
    export S3_BUCKET="${S3_BUCKET:-nemar-dev}"
    export ZARR_AWS_PROFILE="${ZARR_AWS_PROFILE:-nemar-zarr-dev}"
    export ZARR_CONTRACT_BASE="${ZARR_CONTRACT_BASE:-https://zarr-test.nemar.org}"
    export ZARR_STATE_DIR="${ZARR_STATE_DIR:-${ZARR_BASE:-/mnt/local}/zarr-state-test}"
    export ZARR_WORK_DIR="${ZARR_WORK_DIR:-${ZARR_BASE:-/mnt/local}/zarr-scratch-test}"
    export ZARR_DRIVER_REF="${ZARR_DRIVER_REF:-dev}"
    export ZARR_JOBS="${ZARR_JOBS:-4}"
    # One slot: the nightly staging run is a single drain beside the production
    # slots, and must not take a share of the node of its own accord. It still
    # registers in the node-wide admission ledger (ZARR_LEDGER_DIR below), so the
    # production slots see what it has reserved.
    export ZARR_SLOTS="${ZARR_SLOTS:-1}"
    break
  fi
done
unset _pretest_arg

# --- Config (environment-overridable) ----------------------------------------
# ZARR_BASE is the SINGLE local drive this pipeline lives on. Both the hot
# per-recording scratch AND the persistent state (queue db, venv, driver clone,
# logs) hang off it, so the whole pipeline touches exactly one filesystem and has
# NO network (NFS) dependency: NFS made every Python import, SQLite lock, and stat
# a network round-trip -- too much tension/traffic on the hot path, and
# SQLite-over-NFS locking is fragile. All state here is rebuildable (venv/clone
# via setup(); the queue via `reconcile`) and the real outputs live in S3, so
# single-drive-local is the right durability trade. Moving to another machine is
# a one-line change here (or set ZARR_BASE in the environment / crontab).
#
# WORK_DIR is the EPHEMERAL per-recording scratch: the driver streams each annex
# blob here and N parallel workers build temp Zarr stores before upload, so it
# MUST be fast local disk. Only this subtree is wiped between recordings; the
# sibling STATE_DIR is never touched by the cleanup.
ZARR_BASE="${ZARR_BASE:-/mnt/local}"
WORK_DIR="${ZARR_WORK_DIR:-${ZARR_BASE}/zarr-scratch}"
STATE_DIR="${ZARR_STATE_DIR:-${ZARR_BASE}/zarr-state}"
# --- Scratch-sweep deployment guard (nemarOrg/nemar-cli#1121) -----------------
# sweep_orphaned_scratch() (below) deletes stray `tmp*` entries under WORK_DIR
# on the theory that holding the single-instance lock -- which lives under
# STATE_DIR -- proves nothing under WORK_DIR is owned by anyone else. That
# holds only while WORK_DIR and STATE_DIR belong to the SAME deployment. A
# second deployment that shares one of the two directories with this one
# (e.g. it overrides WORK_DIR to point somewhere private but leaves
# STATE_DIR at the shared default, or vice versa) is invisible to this
# lock -- it holds a different lock file under its own STATE_DIR, so it can
# be mid-conversion under a WORK_DIR this run is about to sweep. That is
# exactly how an in-flight on007808 recording was destroyed.
#
# The simplest sound rule: only sweep when both directories were resolved
# the SAME way -- both left at their ZARR_BASE-relative defaults, or both
# explicitly overridden (as --test's pre-pass does, pointing both at a
# dedicated *-test tree so its sweep stays safe and stays on). Exactly one
# overridden means the other is a shared default this run does not own
# alone, so skip. Checked here, right after ZARR_WORK_DIR/ZARR_STATE_DIR are
# resolved into WORK_DIR/STATE_DIR (and after --test's pre-pass has had its
# chance to set both), so the decision is available to --print-config too
# (--print-config exits before sweep_orphaned_scratch is ever defined).
SWEEP_SCRATCH=1
_work_dir_overridden=""
_state_dir_overridden=""
[[ -n "${ZARR_WORK_DIR:-}" ]] && _work_dir_overridden=1
[[ -n "${ZARR_STATE_DIR:-}" ]] && _state_dir_overridden=1
if [[ -n "$_work_dir_overridden" && -z "$_state_dir_overridden" ]] || \
   [[ -z "$_work_dir_overridden" && -n "$_state_dir_overridden" ]]; then
  SWEEP_SCRATCH=""
fi
unset _work_dir_overridden _state_dir_overridden
# Max parallel workers = the driver's ProcessPoolExecutor CPU cap. Default to all
# cores: the driver's RAM-admission control (nemarDatasets/.github#67) dispatches a
# recording only while the SUM of in-flight projected peaks fits usable RAM, so a
# high worker count adds CPU parallelism WITHOUT OOM risk or shrinking the
# per-recording budget (small EEG packs many-wide; large MEG self-limits). Override
# with ZARR_JOBS.
#
# With more than one slot (below) ZARR_JOBS is a ceiling per drain, not the node's
# total: the default is ZARR_JOBS_PER_SLOT (4), and ZARR_JOBS can lower it but never
# raise it, so a crontab that still says ZARR_JOBS=24 from the single-drain days does
# not give every slot 24.
#
# Counts are plain decimal integers: a leading zero would be read as octal by the
# arithmetic below ("08" is an error, "010" is 8) and would name a different lock and
# scratch directory than the same number without it.
is_posint() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
fatal_config() { echo "FATAL: $*" >&2; exit 1; }
SLOTS="${ZARR_SLOTS:-4}"
{ is_posint "$SLOTS" && ((SLOTS <= 16)); } ||
  fatal_config "ZARR_SLOTS must be an integer from 1 to 16 (got '$SLOTS')."
[[ -z "${ZARR_JOBS:-}" ]] || is_posint "$ZARR_JOBS" ||
  fatal_config "ZARR_JOBS must be a positive integer (got '$ZARR_JOBS')."
[[ -z "${ZARR_JOBS_PER_SLOT:-}" ]] || is_posint "$ZARR_JOBS_PER_SLOT" ||
  fatal_config "ZARR_JOBS_PER_SLOT must be a positive integer (got '$ZARR_JOBS_PER_SLOT')."
if ((SLOTS > 1)); then
  JOBS="${ZARR_JOBS_PER_SLOT:-4}"
  if [[ -n "${ZARR_JOBS:-}" ]] && ((ZARR_JOBS < JOBS)); then
    JOBS="$ZARR_JOBS"
  fi
else
  JOBS="${ZARR_JOBS:-$(nproc 2>/dev/null || echo 8)}"
fi
is_posint "$JOBS" || fatal_config "the worker count must be a positive integer (got '$JOBS')."
# How often a running conversion tells the queue it is alive (see heartbeat_start).
HEARTBEAT_SECONDS="${ZARR_HEARTBEAT_SECONDS:-300}"
is_posint "$HEARTBEAT_SECONDS" ||
  fatal_config "ZARR_HEARTBEAT_SECONDS must be a positive integer (got '$HEARTBEAT_SECONDS')."
# Which slot THIS process is. Unset on a plain invocation, which then starts a drain
# in every free slot (or, for --dataset, takes the first free one). A tick starts its
# drains with ZARR_SLOT set.
SLOT="${ZARR_SLOT:-}"
if [[ -n "$SLOT" ]] && { ! [[ "$SLOT" =~ ^(0|[1-9][0-9]*)$ ]] || ((SLOT >= SLOTS)); }; then
  fatal_config "ZARR_SLOT must be an integer from 0 to $((SLOTS - 1)) (got '$SLOT', ZARR_SLOTS=$SLOTS)."
fi
# Anonymous-memory bounds for every conversion worker. Each worker converts under
# an RLIMIT_DATA budget (generate_zarr.py apply_worker_mem_limit), which counts
# anonymous memory (VmData), not page cache, and two library defaults grow that
# independently of the recording: zarr keeps up to `async.concurrency` (10) shard
# encodes in flight, and glibc gives each thread its own malloc arena (up to 8 x
# cores). on004789's recording_memory_exceeded failures (2026-09-22) were budget
# trips of this kind; biosigio#129 removes the biggest source, and these bounds
# keep the rest near the worker's own arrays. Exported so the Python driver and
# its pool workers inherit them; a value already in the environment wins.
export ZARR_ASYNC__CONCURRENCY="${ZARR_ASYNC__CONCURRENCY:-3}"
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"
# The driver source. Repatriated from nemarDatasets/.github to nemarOrg/nemar-cli
# in #1109 (ADR 0029): this engine runs here on the cron, never in Actions, so it
# belongs with the CLI where it can be developed and tested. Deployment is now a
# `git pull` of this clone -- do NOT hand-copy the script onto the box again.
# ZARR_DRIVER_REF pins which ref to track; `main` is the released CLI. Point it at
# `dev` (or a feature branch) to run an unreleased driver.
DRIVER_REPO="${ZARR_DRIVER_REPO:-${STATE_DIR}/nemar-cli}"   # clone of nemarOrg/nemar-cli
DRIVER_REF="${ZARR_DRIVER_REF:-main}"
VENV_DIR="${ZARR_VENV_DIR:-${STATE_DIR}/.zarr-venv}"
# The two halves of BIOSIGIO_SPEC below, as bare versions for setup()'s
# post-install check (test_hallu_zarr_config.py holds all three together). The
# check is TWO-SIDED: the installed biosigIO must be a final release in
# [BIOSIGIO_FLOOR, BIOSIGIO_CAP). Below the floor is a failed upgrade; at or above
# the cap is a release nobody has read yet (the cap exists because a biosigIO
# patch release changed what a store contains or which recordings convert five
# times in a row, 1.2.9 through 1.2.13), which an install that went wrong can also
# leave behind; a pre-release or dev build satisfies
# neither pin. None of them may convert.
#
# The probe prints the installed version and exits 0 when it is in range, 3 when
# it is below the floor or cannot be read, 4 when it is at or above the cap, 5 when
# it is a pre-release or dev build. Versions are compared AS versions: with
# `packaging` when the venv has it, else by a fallback that accepts only a
# canonical final release (`N(.N)*`, optionally `.postN` and a `+local` label) and
# compares its numeric fields as a tuple, because as strings "1.2.10" sorts below
# "1.2.9". The two paths agree on every canonical spelling: both refuse
# `1.2.10rc1` and `1.2.10.dev0` as pre-releases, which a bare tuple of leading
# digits would read as 1.2.10 and accept. Anything the fallback cannot parse fails
# closed.
BIOSIGIO_FLOOR="1.2.13"
BIOSIGIO_CAP="1.2.14"
BIOSIGIO_FLOOR_PROBE='
import re
import sys
import biosigio

have = getattr(biosigio, "__version__", "<unknown>")
floor, cap = sys.argv[1], sys.argv[2]
BELOW, ABOVE, PRE = 3, 4, 5

FINAL = re.compile(r"(\d+(?:\.\d+)*)(?:\.post\d+)?(?:\+[a-z0-9]+(?:\.[a-z0-9]+)*)?")
PRE_RELEASE = re.compile(
    r"\d+(?:\.\d+)*(?:[-_.]?post\d+)?[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview|dev)", re.I
)


def release(text):
    match = FINAL.fullmatch(text)
    if match is None:
        return None
    fields = [int(p) for p in match.group(1).split(".")]
    while len(fields) > 1 and fields[-1] == 0:
        fields.pop()
    return tuple(fields)


def verdict():
    try:
        from packaging.version import InvalidVersion, Version
    except ImportError:
        Version = None
    if Version is not None:
        try:
            v = Version(have)
        except InvalidVersion:
            return BELOW
        if v.is_prerelease:
            return PRE
        if v < Version(floor):
            return BELOW
        return ABOVE if v >= Version(cap) else 0
    v = release(have)
    if v is None:
        return PRE if PRE_RELEASE.match(have) else BELOW
    if v < release(floor):
        return BELOW
    return ABOVE if v >= release(cap) else 0


try:
    code = verdict()
except Exception:
    code = BELOW
print(have)
sys.exit(code)
'
# Fallback only (used when the clone predates scripts/zarr/requirements.txt, which
# is the real pin). Floor is 1.2.6: 1.2.3 added MEF3 .mefd / 4D-BTi import (so a
# run below it would discover a .mefd/BTi recording via generate_zarr.py's
# dir_recording_of/bti_recordings and then fail to convert it), 1.2.4 added MATLAB
# v7.3 (HDF5) EEGLAB `.set` plus three recovered EDF/BDF rejections, 1.2.5 fixed
# CTF `.hc` coil naming, 1.2.6 is what index format v3 reads (constant-column view
# chunking with the geometry declared in attrs, channels.tsv units CONVERTING
# samples with a per-file report, resource exhaustion propagating as MemoryError),
# 1.2.7 gives `stream_to_zarr` the same `bids_channels` parameter as
# `Recording.from_file` -- which is what makes engine "3" safe, since below that
# floor the streaming and in-memory paths disagree about a recording's units --
# and 1.2.8 writes each streamed shard once instead of once per channel, which is
# what kept large EDFs inside their memory budget (#1483), and 1.2.9 converts real
# files that failed before (EEGLAB v7.3 flat root and empty fields, BrainVision
# stale DataFile/MarkerFile names, repeated EDF/BDF/WFDB labels that used to lose
# channels) and raises host I/O errors as the OSError itself, which is retried,
# instead of a typed file failure, and 1.2.10 applies a channels.tsv row to the
# one channel whose label differs from it only in case (biosigio#140), which can
# convert that channel's unit; the converter publishes those matches bounded
# (`units_report.matched_case_only`), and the join texts in the schema, zod and
# MCP mirrors were reworded with this bump, and 1.2.11 lets a store be written
# without subject information (`exclude_subject_info`, #1626), which the
# converter passes on every write and refuses to convert without, and 1.2.12
# types a streamed EDF/BDF refusal (`CorruptFileError`, biosigio#149) and reads
# an EDF+C or BDF+C recording whose first time-keeping onset is late
# (biosigio#145), and 1.2.13 refuses a BrainVision data file whose header shows it
# was cut short, with a typed `CorruptFileError`, where it used to read with the
# tail dropped. It types a truncated FIF the same way only through
# `Recording.from_file`. The streaming export still raises a bare `ValueError` for
# a truncated FIF (biosigio#161) and for a truncated KIT `.sqd` or 4D/BTi `config`
# or `hs_file` (biosigio#168), and an uncoded failure is retried until
# `retry_exhausted`. The converter opts in to `allow_partial_frame` for one case,
# a MULTIPLEXED BrainVision file that ends in a partial frame and declares no
# positive `DataPoints` count: it reads the whole frames, as 1.2.12 did, and
# records the dropped bytes (`brainvision_dropped_bytes`). Vectorized data with a
# partial frame is still refused. The engine stamp did not move for any of them,
# and this pin does not move it (see requirements.txt).
# The `<1.2.14` half is a CAP, not a floor, raised deliberately per release; raise
# it everywhere at once (requirements.txt, this default and
# BIOSIGIO_FLOOR/BIOSIGIO_CAP, SUBJECT_INFO_FLOOR in generate_zarr.py when the
# floor moves, test_hallu_zarr_config.py).
# Extras are not optional here: [mef3] carries pymef and [hdf5] carries h5py, and
# without either the matching recordings raise ImportError at convert time even
# though discovery finds them.
BIOSIGIO_SPEC="${BIOSIGIO_SPEC:-biosigio[zarr,meg,mef3,hdf5]>=1.2.13,<1.2.14}"
API_BASE="${API_BASE:-https://api.nemar.org}"
# The STABLE base published in each index as `contract_base` and in each store's
# `nemar.contract_url` (#1059/#1064). Distinct from S3_BUCKET/AWS_REGION, which
# say where the bytes physically are today: this is the URL clients are told they
# may hardcode, so it must NOT be derived from the bucket. The --test pre-pass
# above defaults it to zarr-test.nemar.org, so a test-instance index never
# advertises the production host.
CONTRACT_BASE="${ZARR_CONTRACT_BASE:-https://zarr.nemar.org}"
CALLBACK_URL="${ZARR_CALLBACK_URL:-${API_BASE}/webhooks/zarr-ready}"
S3_BUCKET="${S3_BUCKET:-nemar}"
AWS_REGION="${AWS_DEFAULT_REGION:-us-east-2}"
# Scoped service profile (IAM user nemar-hallu-zarr; s3:Get/Put/Delete on
# nemar/*/zarr/* + ListBucket). The driver's `aws s3 ...` calls inherit it.
# Reading annex content needs s3:GetObject on nemar/<id>/objects/* AND
# s3:ListBucket for the <id>/objects/ prefixes: a git-annex chunked upload
# stores only `<key-fields>-S<chunk>-C<n>--...` objects, and the chunk size is
# discovered by listing them. Without ListBucket, S3 answers the missing plain
# key with 403 instead of 404, a 403 is never read as absence, so the chunked
# fallback never runs and every chunked recording fails uncoded and retries.
# Safe, but the chunked fetch silently does nothing.
export AWS_PROFILE="${ZARR_AWS_PROFILE:-nemar-zarr}"
export AWS_DEFAULT_REGION="$AWS_REGION"
QUEUE_DB="${ZARR_QUEUE_DB:-${STATE_DIR}/zarr-queue.db}"
LOG_FILE="${ZARR_LOG_FILE:-${STATE_DIR}/.nm-zarr.log}"
LOCK_FILE="${ZARR_LOCK_FILE:-${STATE_DIR}/.nm-zarr.lock}"
# The admission ledger (ADR 0101): what every driver on this NODE has reserved. Under
# ZARR_BASE rather than STATE_DIR so the nightly --test run, which keeps its own state
# directory, still shares it with the production slots: they share the machine.
export ZARR_LEDGER_DIR="${ZARR_LEDGER_DIR:-${ZARR_BASE}/zarr-admission-ledger}"
# Slot 0 keeps the names the single drain always had, so an upgrade changes nothing
# for a run that already holds them; slot N adds `.slotN`. The values above are the
# slot-0 names, kept for use_slot().
BASE_WORK_DIR="$WORK_DIR"
BASE_LOCK_FILE="$LOCK_FILE"
BASE_LOG_FILE="$LOG_FILE"
slot_work_dir() { if (($1 == 0)); then echo "$BASE_WORK_DIR"; else echo "${BASE_WORK_DIR%/}-slot$1"; fi; }
slot_lock_file() { if (($1 == 0)); then echo "$BASE_LOCK_FILE"; else echo "${BASE_LOCK_FILE%.lock}.slot$1.lock"; fi; }
slot_log_file() { if (($1 == 0)); then echo "$BASE_LOG_FILE"; else echo "${BASE_LOG_FILE%.log}.slot$1.log"; fi; }
# Name slot $1's scratch directory, lock and log (no side effects; --print-config uses
# this alone).
select_slot() {
  SLOT="$1"
  WORK_DIR="$(slot_work_dir "$1")"
  LOCK_FILE="$(slot_lock_file "$1")"
  LOG_FILE="$(slot_log_file "$1")"
}
# Point this process at slot $1. TMPDIR follows the scratch directory, so the driver's
# temporary directories land in it.
use_slot() {
  select_slot "$1"
  mkdir -p "$WORK_DIR"
  export TMPDIR="$WORK_DIR"
}
# --- engine-bump guard (nemarOrg/nemar-cli#1172, ADR 0033) --------------------
# `setup()` resets the driver clone to origin/$DRIVER_REF on every run, so
# MERGING a bump of ZARR_ENGINE_VERSION deploys it: without a guard the next
# hourly tick would reconcile under the new constant and re-queue the back
# catalog with nobody watching. Above this many stamp-stale rows, reconcile
# requeues NONE of them and says so; conversion of genuinely new datasets is
# unaffected. Preview with `--preview-engine-bump`, then arm ONE run:
#
#   touch /mnt/local/zarr-state/.zarr-engine-bump-ack     # cron picks it up
#   ZARR_ENGINE_BUMP_ACK=1 ./hallu-zarr.sh                # or a manual run
ENGINE_REQUEUE_LIMIT="${ZARR_ENGINE_REQUEUE_LIMIT:-25}"
ENGINE_ACK_FILE="${ZARR_ENGINE_BUMP_ACK_FILE:-${STATE_DIR}/.zarr-engine-bump-ack}"
# NEMAR_WEBHOOK_TOKEN may be exported by the environment; the callback is skipped
# when it is empty (the viewer reads index.json, not D1, so the callback is only
# D1 bookkeeping).
# NEMAR_WEBHOOK_TOKEN is loaded further down, once log()/err() exist -- a missing
# token has to be able to announce itself.

# The arguments as given, for the drains a tick starts (the parser below consumes them).
ORIG_ARGS=("$@")
ONLY_DATASET=""
LIMIT="${ZARR_LIMIT:-0}"
STATS_ONLY=""
REQUEUE=""
BACKFILL_DIR_FORMATS=""
PREVIEW_ENGINE_BUMP=""
# Shared by --requeue and --backfill-dir-formats: both default to reporting and
# write only when this is set, so one spelling of "yes, actually do it" serves
# both recoveries.
EXECUTE=""
# TEST_MODE is set below once this parser actually consumes a bare --test
# token (the pre-pass's TEST_PREPASS_SEEN is the raw, can't-be-swallowed
# record used by the guard rails; TEST_MODE here only drives log()/err()'s
# "[test]" prefix and --print-config's own display of it).
TEST_MODE=""
PRINT_CONFIG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    # A value starting with "--" is refused rather than silently consumed as
    # the dataset id / limit: `--dataset --test` used to swallow the --test
    # token this way, which is exactly the hole TEST_PREPASS_SEEN (pre-pass,
    # above) exists to not depend on -- but refusing it here is still the
    # right UX rather than quietly treating "--test" as a dataset id.
    --dataset)
      if [[ -n "${2:-}" && "${2:-}" != --* ]]; then
        ONLY_DATASET="$2"; shift 2
      else
        echo "Error: --dataset requires a value" >&2
        exit 1
      fi
      ;;
    --limit)
      if [[ -n "${2:-}" && "${2:-}" != --* ]]; then
        LIMIT="$2"; shift 2
      else
        echo "Error: --limit requires a value" >&2
        exit 1
      fi
      ;;
    --stats) STATS_ONLY=1; shift ;;
    --backfill-dir-formats) BACKFILL_DIR_FORMATS=1; shift ;;
    --preview-engine-bump) PREVIEW_ENGINE_BUMP=1; shift ;;
    # `shift 2` would fail on a bare `--requeue` (one positional left), and since
    # this script runs without `set -e` a failed shift leaves $# unchanged and the
    # loop spins forever. Take a value only when one is actually there.
    --requeue)
      if [[ -n "${2:-}" && "${2:-}" != --* ]]; then
        REQUEUE="$2"; shift 2
      else
        REQUEUE="failed"; shift
      fi
      ;;
    --execute) EXECUTE=1; shift ;;
    --test) TEST_MODE=1; shift ;;
    --print-config) PRINT_CONFIG=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --limit and ZARR_LIMIT: a plain decimal count, 0 meaning no limit. `08` would be an
# arithmetic error below that turned a limited run into an unlimited one.
[[ "$LIMIT" =~ ^(0|[1-9][0-9]*)$ ]] ||
  fatal_config "--limit / ZARR_LIMIT must be a non-negative integer (got '$LIMIT')."

log() {
  local prefix=""
  [[ -n "$TEST_MODE" ]] && prefix="[test] "
  [[ -n "$SLOT" ]] && ((SLOTS > 1)) && prefix="${prefix}[slot $SLOT] "
  echo "${prefix}[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" | tee -a "$LOG_FILE"
}
err() {
  local prefix=""
  [[ -n "$TEST_MODE" ]] && prefix="[test] "
  [[ -n "$SLOT" ]] && ((SLOTS > 1)) && prefix="${prefix}[slot $SLOT] "
  echo "${prefix}[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ERROR: $*" | tee -a "$LOG_FILE" >&2
}

# git-annex marks object files (and their dirs) read-only, so a plain `rm -rf`
# fails with EPERM. Make the tree writable first, then remove.
safe_rm() { [[ -n "${1:-}" && -e "$1" ]] || return 0; chmod -R u+w "$1" 2>/dev/null; rm -rf "$1"; }

# --- Guard-rail path/host normalization ---------------------------------------
# Shared by the guard rails below. A path is collapsed to a canonical form
# before comparing against a hardcoded prod default: repeated "/" anywhere
# (not just trailing) is squashed to one, then a trailing "/" is stripped, so
# "/mnt/local/zarr-state/" and "/mnt/local//zarr-state" both compare equal to
# "/mnt/local/zarr-state". When the directory already exists, resolve it with
# `realpath` too, so a symlink or a relative component collapses to the same
# canonical form as the hardcoded constant. It usually WON'T exist yet here --
# these guards run before `mkdir -p "$WORK_DIR" "$STATE_DIR"` -- so the
# string-normalized form is what most comparisons actually run on; `realpath`
# only firms it up further on a real Hallu box where the prod dirs are long-lived.
_normalize_guard_path() {
  local p="$1"
  while [[ "$p" == *//* ]]; do p="${p//\/\//\/}"; done
  while [[ "$p" == */ && "$p" != "/" ]]; do p="${p%/}"; done
  if [[ -d "$p" ]]; then
    p="$(realpath "$p" 2>/dev/null || echo "$p")"
  fi
  echo "$p"
}

# True if $1 names the production API host (api.nemar.org), independent of
# case, scheme, port, trailing slash, path, or a trailing DNS root dot:
# lowercase, strip a leading "scheme://", strip everything from the first
# "/" or "?" onward, strip a trailing ":port", strip trailing "."s.
# "https://API.NEMAR.ORG/foo", "http://api.nemar.org:8443", bare
# "api.nemar.org", and "https://api.nemar.org./" (the trailing dot marks an
# absolute FQDN in DNS -- resolvers treat it identically to the same name
# without one, so a naive comparison would let it slip past as a different
# string while it resolves to the same production host) all match;
# "api-test.nemar.org" does not, because the comparison is exact-host, not
# substring -- a plain `*api.nemar.org*` match would also (harmlessly, but
# wrongly) flag "api-test.nemar.org" itself as prod, since "-test" sits
# BEFORE the dot, not inside the substring being searched for.
_is_prod_api_host() {
  local url="${1,,}"
  url="${url#*://}"
  url="${url%%/*}"
  url="${url%%\?*}"
  url="${url%%:*}"
  while [[ "$url" == *. ]]; do url="${url%.}"; done
  [[ "$url" == "api.nemar.org" ]]
}

# --- Test-mode guard rails / prod TEST_API_URL leak guard ----------------------
# --test picks safe defaults (above), but an operator can still export a PROD
# value alongside --test (e.g. a stale `S3_BUCKET=nemar` left in their shell).
# Catch that here and fail loud rather than silently converting against prod
# with the safety flag on. Deliberately NOT using err()/log(): both tee to
# $LOG_FILE, and one of the very things being guarded against is STATE_DIR
# resolving to the prod state dir -- mkdir'ing (or writing under) that path
# just to report the guard failure would defeat the guard. Plain stderr only;
# nothing under $STATE_DIR exists yet at this point in the script.
#
# This keys off TEST_PREPASS_SEEN (set by the raw argv scan at the top of the
# file), NOT off TEST_MODE (set by the arg parser just above). They agree in
# every case this parser can produce today, but TEST_PREPASS_SEEN is the one
# that cannot be made to disagree by a future value-taking flag with a
# permissive parser -- see the pre-pass comment for the `--dataset --test`
# history here.
if [[ -n "$TEST_PREPASS_SEEN" ]]; then
  guard_failed=""
  guard_err() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ERROR: $*" >&2; }
  if [[ "$S3_BUCKET" == "nemar" ]]; then
    guard_err "--test refuses S3_BUCKET=nemar (the production bucket)."
    guard_failed=1
  fi
  if _is_prod_api_host "$API_BASE"; then
    guard_err "--test refuses API_BASE=$API_BASE (the production catalog)."
    guard_failed=1
  fi
  # TEST_API_URL is the `nemar` CLI's own API-base override (see the pre-pass
  # comment above) -- checked separately from API_BASE because they are read
  # by two different programs and could disagree.
  if [[ -n "${TEST_API_URL:-}" ]] && _is_prod_api_host "$TEST_API_URL"; then
    guard_err "--test refuses TEST_API_URL=$TEST_API_URL (the production catalog)."
    guard_failed=1
  fi
  if [[ "$AWS_PROFILE" == "nemar-zarr" ]]; then
    guard_err "--test refuses AWS_PROFILE=nemar-zarr (the production credential)."
    guard_failed=1
  fi
  if [[ "$(_normalize_guard_path "$STATE_DIR")" == "$(_normalize_guard_path /mnt/local/zarr-state)" ]]; then
    guard_err "--test refuses STATE_DIR=$STATE_DIR (the production state dir)."
    guard_failed=1
  fi
  if [[ "$(_normalize_guard_path "$WORK_DIR")" == "$(_normalize_guard_path /mnt/local/zarr-scratch)" ]]; then
    guard_err "--test refuses WORK_DIR=$WORK_DIR (the production scratch dir)."
    guard_failed=1
  fi
  if [[ -n "$guard_failed" ]]; then
    guard_err "--test is a safety boundary: a prod value exported alongside it stops"
    guard_err "the run rather than silently pointing it at prod. Unset the offending"
    guard_err "variable(s) or point them at their nemar-dev/api-test equivalents."
    exit 1
  fi
  unset guard_failed
else
  # The complementary leak in the other direction: TEST_API_URL left exported
  # in the shell from an earlier --test session must not silently steer a
  # PLAIN prod run's `nemar` CLI invocation at api-test.nemar.org. Unset it
  # rather than trusting that nobody left it exported; log one line (plain
  # stderr, same reasoning as the guards above -- no LOG_FILE write here)
  # only when there was actually something to unset.
  if [[ -n "${TEST_API_URL:-}" ]]; then
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] unsetting stale TEST_API_URL=$TEST_API_URL for this prod run" >&2
    unset TEST_API_URL
  fi
fi

# --- --print-config -------------------------------------------------------------
# The ops sanity check and the test seam: print every resolved config value and
# exit before touching the filesystem, network, or lock. Placed ahead of the
# `mkdir` below deliberately -- unlike --stats/--preview-engine-bump/--requeue
# further down (which already accept `mkdir` as a side effect of getting this
# far), --print-config's whole purpose is to be inspectable with zero side
# effects, from a temp HOME/ZARR_BASE in a test as much as from a real one.
if [[ -n "$PRINT_CONFIG" ]]; then
  [[ -n "$SLOT" ]] && select_slot "$SLOT"
  # Token presence only -- never the value. Resolved the same three-tier way
  # load_secrets() (below) resolves it, but read-only and in a subshell: this
  # must not source into the current process (that WOULD partly duplicate
  # load_secrets()'s job) and must not tee an ERROR line to $LOG_FILE on a
  # miss, since a miss is the common case (no secrets file yet) and
  # --print-config promises no filesystem writes either way.
  pc_secrets_file=""
  if [[ -n "${ZARR_SECRETS_FILE:-}" && -f "${ZARR_SECRETS_FILE:-}" ]]; then
    pc_secrets_file="$ZARR_SECRETS_FILE"
  elif [[ -f "${STATE_DIR}/.zarr-secrets.env" ]]; then
    pc_secrets_file="${STATE_DIR}/.zarr-secrets.env"
  elif [[ -f "${BASH_SOURCE%/*}/.zarr-secrets.env" ]]; then
    pc_secrets_file="${BASH_SOURCE%/*}/.zarr-secrets.env"
  fi
  pc_token="absent"
  if [[ -n "$pc_secrets_file" ]]; then
    # shellcheck source=/dev/null  # deployment-local, chmod-600, never in the repo
    if [[ -n "$(source "$pc_secrets_file" 2>/dev/null; echo "${NEMAR_WEBHOOK_TOKEN:-}")" ]]; then
      pc_token="present"
    fi
  elif [[ -n "${NEMAR_WEBHOOK_TOKEN:-}" ]]; then
    pc_token="present"
  fi
  cat <<EOF
TEST_MODE=${TEST_MODE:-0}
ACCEPT_EXEMPLARS=${TEST_PREPASS_SEEN:-0}
ONLY_DATASET=$ONLY_DATASET
LIMIT=$LIMIT
REQUEUE=$REQUEUE
BACKFILL_DIR_FORMATS=${BACKFILL_DIR_FORMATS:-0}
PREVIEW_ENGINE_BUMP=${PREVIEW_ENGINE_BUMP:-0}
EXECUTE=${EXECUTE:-0}
API_BASE=$API_BASE
TEST_API_URL=${TEST_API_URL:-}
CALLBACK_URL=$CALLBACK_URL
CONTRACT_BASE=$CONTRACT_BASE
S3_BUCKET=$S3_BUCKET
AWS_REGION=$AWS_REGION
AWS_PROFILE=$AWS_PROFILE
ZARR_BASE=$ZARR_BASE
WORK_DIR=$WORK_DIR
STATE_DIR=$STATE_DIR
SWEEP_SCRATCH=${SWEEP_SCRATCH:-0}
JOBS=$JOBS
SLOTS=$SLOTS
SLOT=$SLOT
LEDGER_DIR=$ZARR_LEDGER_DIR
ZARR_ASYNC__CONCURRENCY=$ZARR_ASYNC__CONCURRENCY
MALLOC_ARENA_MAX=$MALLOC_ARENA_MAX
DRIVER_REPO=$DRIVER_REPO
DRIVER_REF=$DRIVER_REF
VENV_DIR=$VENV_DIR
BIOSIGIO_SPEC=$BIOSIGIO_SPEC
QUEUE_DB=$QUEUE_DB
LOG_FILE=$LOG_FILE
LOCK_FILE=$LOCK_FILE
ENGINE_REQUEUE_LIMIT=$ENGINE_REQUEUE_LIMIT
ENGINE_ACK_FILE=$ENGINE_ACK_FILE
NEMAR_WEBHOOK_TOKEN=$pc_token
EOF
  exit 0
fi

mkdir -p "$WORK_DIR" "$STATE_DIR" "$ZARR_LEDGER_DIR"
# The driver's tempfile.TemporaryDirectory() (per-recording materialize + store)
# follows TMPDIR; pin it to the NVMe scratch, not the system default. A drain
# running as slot N points it at that slot's own directory (use_slot).
export TMPDIR="$WORK_DIR"

# --- Secrets (NEMAR_WEBHOOK_TOKEN) -------------------------------------------
# Loaded from a chmod-600 file so the token lives neither in crontab nor in any
# repo. That second half stopped holding when #1109 moved this script INTO the
# nemar-cli checkout: "beside this script" is now a git working tree, where the
# file is one `git add -A` away from being committed. Hence the STATE_DIR default,
# which sits outside the clone alongside the queue DB and the venv.
#
# The beside-the-script fallback does NOT carry a token through that move, and it
# would be dangerous to believe it does. It resolves against wherever the script
# currently IS, so post-cutover it points inside the clone -- never at the old
# hand-copy directory the token actually sat in. Relocating the token to STATE_DIR
# is a required manual step of the cutover, not something this fallback does for
# you. The fallback covers only the other deployment shape: script and secrets
# kept together somewhere outside a checkout.
#
# An absent token is otherwise SILENT: both callback POSTs below skip when it is
# empty, so conversion keeps succeeding and uploading while D1's zarr_status
# quietly stops updating -- a botched cutover would surface only as a dashboard
# that stopped advancing. Warn instead. It stays non-fatal because the callback is
# only D1 bookkeeping; the viewer reads index.json from S3, which is still written.
# Deliberately a function, called just before the conversion loop rather than at
# top level. Only convert_dataset() reads the token, and --stats/--requeue exit
# before that: an operator reaching for either during an incident must not be
# blocked by a webhook-token misconfiguration they are not using. That is the same
# reasoning that keeps --requeue ahead of the flock and out of setup().
load_secrets() {
  local sourced=""
  if [[ -n "${ZARR_SECRETS_FILE:-}" ]]; then
    # An explicit override is exclusive. Falling back after a typo'd path would
    # source a DIFFERENT file than the operator named -- possibly a stale token --
    # which is worse than stopping, and contradicts the fail-loud rule setup()
    # uses for the driver checkout.
    if [[ ! -f "$ZARR_SECRETS_FILE" ]]; then
      err "FATAL: ZARR_SECRETS_FILE=$ZARR_SECRETS_FILE does not exist. Not falling back."
      exit 1
    fi
    # shellcheck source=/dev/null  # deployment-local, chmod-600, never in the repo
    source "$ZARR_SECRETS_FILE"
    sourced="$ZARR_SECRETS_FILE"
  elif [[ -f "${STATE_DIR}/.zarr-secrets.env" ]]; then
    # shellcheck source=/dev/null
    source "${STATE_DIR}/.zarr-secrets.env"
    sourced="${STATE_DIR}/.zarr-secrets.env"
  elif [[ -f "${BASH_SOURCE%/*}/.zarr-secrets.env" ]]; then
    # shellcheck source=/dev/null
    source "${BASH_SOURCE%/*}/.zarr-secrets.env"
    sourced="${BASH_SOURCE%/*}/.zarr-secrets.env"
  fi
  NEMAR_WEBHOOK_TOKEN="${NEMAR_WEBHOOK_TOKEN:-}"
  [[ -n "$NEMAR_WEBHOOK_TOKEN" ]] && return 0
  # Report what actually happened. Naming the search paths when a file WAS sourced
  # would repeat the original mistake in this PR -- a message describing behavior
  # that did not occur -- and this is the message read during a live outage.
  if [[ -n "$sourced" ]]; then
    err "sourced $sourced but it did not set NEMAR_WEBHOOK_TOKEN."
  else
    err "no NEMAR_WEBHOOK_TOKEN: no secrets file at ${STATE_DIR}/.zarr-secrets.env or ${BASH_SOURCE%/*}/.zarr-secrets.env."
  fi
  err "Conversion will run and upload normally, but every zarr-ready callback is SKIPPED, so D1 zarr_status will not advance."
}

# --- One-time setup: driver repo + biosigIO venv ------------------------------
setup() {
  # This script runs `set -uo pipefail` WITHOUT -e, so every git step below is
  # checked explicitly. An unchecked failure here is the worst kind: `git reset
  # --hard` validates the revspec BEFORE touching the tree, so a bad DRIVER_REF
  # exits 128 and leaves the previous run's checkout intact -- the file-existence
  # check below then passes on STALE code and the cron converts an entire batch
  # against it, the only trace being a bare `fatal:` line in a multi-megabyte log.
  # Same "fail loud rather than silently convert on the wrong thing" rule as the
  # biosigio import guard further down.
  if [[ -d "$DRIVER_REPO/.git" ]]; then
    # Verify the clone is the repo we think it is before fetching into it. The
    # driver moved from nemarDatasets/.github to nemarOrg/nemar-cli (#1109), and
    # a leftover clone of the OLD repo still has scripts/zarr/generate_zarr.py --
    # so neither the existence check nor the drift guard would notice, and we
    # would convert against the wrong tree.
    actual_url="$(git -C "$DRIVER_REPO" remote get-url origin 2>/dev/null || echo "<unreadable>")"
    if [[ "$actual_url" != *"nemarOrg/nemar-cli"* ]]; then
      err "FATAL: $DRIVER_REPO points at '$actual_url', expected nemarOrg/nemar-cli."
      err "Refusing to run. Remove that directory, or fix ZARR_DRIVER_REPO."
      exit 1
    fi
    if ! git -C "$DRIVER_REPO" fetch -q origin; then
      err "FATAL: fetch failed for $DRIVER_REPO (currently at $(git -C "$DRIVER_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown))."
      err "Refusing to convert a batch against a possibly-stale driver."
      exit 1
    fi
    if ! git -C "$DRIVER_REPO" reset -q --hard "origin/${DRIVER_REF}"; then
      err "FATAL: origin/${DRIVER_REF} does not resolve in $DRIVER_REPO."
      err "Check ZARR_DRIVER_REF (branch deleted after merge?). Not running a stale driver."
      exit 1
    fi
  else
    if ! git clone -q --branch "$DRIVER_REF" https://github.com/nemarOrg/nemar-cli "$DRIVER_REPO"; then
      err "FATAL: clone of nemarOrg/nemar-cli@${DRIVER_REF} into $DRIVER_REPO failed."
      exit 1
    fi
  fi
  if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    uv venv -q "$VENV_DIR"
  fi
  # Install biosigIO from the driver repo's manifest so the pin is single-sourced
  # with the Actions workflow (scripts/zarr/requirements.txt). Fall back to the
  # inline spec if an older clone predates the manifest.
  #
  # --refresh-package/--upgrade-package biosigio are REQUIRED, not cosmetic: a
  # plain `uv pip install` reuses uv's cached index, so right after a biosigIO
  # release the cache still lists the old version and the pin bump silently no-ops
  # (the venv keeps the stale wheel, and the `|| true` below hides the resolution
  # miss). That shipped a run converting on the OLD library. Forcing a refresh +
  # upgrade of just biosigIO makes a pin bump take effect on the very next run
  # (deps are untouched). Verify afterward and fail loud if the pin is still unmet,
  # rather than silently converting with the wrong version.
  local req="$DRIVER_REPO/scripts/zarr/requirements.txt"
  if [[ -f "$req" ]]; then
    VIRTUAL_ENV="$VENV_DIR" uv pip install -q --refresh-package biosigio --upgrade-package biosigio -r "$req" 2>&1 | tail -2 || true
  else
    VIRTUAL_ENV="$VENV_DIR" uv pip install -q --refresh-package biosigio --upgrade-package biosigio "$BIOSIGIO_SPEC" 2>&1 | tail -2 || true
  fi
  # Guard: the pinned biosigIO must actually be importable, else abort setup so the
  # cron does not convert a whole batch on a stale library.
  if ! VIRTUAL_ENV="$VENV_DIR" "$VENV_DIR/bin/python" -c "import biosigio" 2>/dev/null; then
    echo "[setup] FATAL: biosigio not importable after install ($BIOSIGIO_SPEC)" >&2
    exit 1
  fi
  # ...and it must be AT the floor. Importable is not enough: the install above
  # ends `| tail -2 || true`, and `tail` exits 0 whatever uv did, so a failed
  # upgrade (an unreachable index, a resolver conflict) leaves the venv on the old
  # wheel and passes the import guard. On 1.2.8 a streaming EDF that repeats a
  # channel label still publishes, with the repeated label as is, and the header
  # gate in generate_zarr.py cannot catch it: every channel is there, only the
  # names collapse for a consumer that keys by label. On 1.2.9 a channels.tsv row
  # that differs from its channel only in case is silently not applied, so the
  # store serves the importer's unit where the sidecar declares another. On 1.2.10
  # no writer can leave subject information out of a store; generate_zarr.py
  # would refuse every dataset with exit 78, so stop here once instead (#1626).
  # On 1.2.11 a streamed EDF/BDF refusal is a bare OSError, which the converter
  # no longer reads by its text (the former bare-OSError text match is gone), so
  # it becomes an uncoded retry as if the node were at fault, until
  # `retry_exhausted`.
  # And it must be BELOW the cap, and a final release: see BIOSIGIO_FLOOR_PROBE.
  local installed probe_rc=0
  installed="$(VIRTUAL_ENV="$VENV_DIR" "$VENV_DIR/bin/python" -c "$BIOSIGIO_FLOOR_PROBE" "$BIOSIGIO_FLOOR" "$BIOSIGIO_CAP" 2>&1)" || probe_rc=$?
  case "$probe_rc" in
    0) ;;
    4)
      echo "[setup] FATAL: biosigio ${installed} is at or above the ${BIOSIGIO_CAP} cap after install ($BIOSIGIO_SPEC)." >&2
      echo "[setup] The pin says <${BIOSIGIO_CAP}: a biosigIO release is reviewed before the converter takes it; refusing to convert on one that was not." >&2
      exit 1
      ;;
    5)
      echo "[setup] FATAL: biosigio ${installed} is a pre-release or development build ($BIOSIGIO_SPEC)." >&2
      echo "[setup] The converter runs only a final release in [${BIOSIGIO_FLOOR}, ${BIOSIGIO_CAP}); refusing to convert." >&2
      exit 1
      ;;
    *)
      echo "[setup] FATAL: biosigio ${installed:-<unreadable>} is below the ${BIOSIGIO_FLOOR} floor after install ($BIOSIGIO_SPEC)." >&2
      echo "[setup] The upgrade did not take effect; refusing to convert on a stale library." >&2
      exit 1
      ;;
  esac
  echo "[setup] biosigio ${installed}"
}

DRIVER="$DRIVER_REPO/scripts/zarr/generate_zarr.py"
QUEUE="$DRIVER_REPO/scripts/zarr/zarr_queue.py"
qpy() { VIRTUAL_ENV="$VENV_DIR" "$VENV_DIR/bin/python" "$QUEUE" --db "$QUEUE_DB" "$@"; }

# Take the lock on descriptor $1 and wait for it as long as it takes, but never in one
# piece for more than five seconds. Bash runs a trapped signal only between commands, and
# flock is an external one, so a plain blocking flock would leave a TERM unanswered for as
# long as the lock is held (a one-off conversion can hold one for days). Any further
# arguments are a command run about every HEARTBEAT_SECONDS while waiting. Returns the
# flock status when it is anything but a timeout.
flock_wait() {
  local fd="$1" rc waited=$SECONDS
  shift
  while :; do
    flock -w 5 "$fd"
    rc=$?
    ((rc == 0)) && return 0
    ((rc == 1)) || return "$rc"
    if (($# > 0)) && ((SECONDS - waited >= HEARTBEAT_SECONDS)); then
      "$@"
      waited=$SECONDS
    fi
  done
}

# Only one slot at a time may update the shared driver clone and venv: two `git reset`
# or `uv pip install` runs at once can corrupt either. Another slot's setup takes seconds
# to a minute, so this waits; the running drains are not affected (they have loaded their
# code), and a drain that starts while a clone is being rewritten fails fast on an import
# and is retried by the queue.
setup_locked() {
  exec 8>"${STATE_DIR}/.nm-zarr.setup.lock" || {
    err "cannot open ${STATE_DIR}/.nm-zarr.setup.lock"
    exit 1
  }
  flock_wait 8 || {
    err "cannot take the setup lock"
    exit 1
  }
  setup
  flock -u 8
  exec 8>&-
}

# While a driver converts a dataset, tell the queue so every few minutes. Every slot
# starts with a reconcile, and a reconcile returns to `pending` any `inprogress` row
# idle for more than six hours: a dataset that converts for longer (nm000276 has run
# for days) would be handed to a second slot and converted twice, concurrently, onto
# the same S3 prefix. The loop follows the DRIVER, not this script: a script killed
# with SIGKILL leaves its driver running, and the driver is what is converting.
# Started for a dataset the queue handed out (a one-off run has no `inprogress` row to
# keep, and would report the missing one as a problem).
HEARTBEAT_PID=""
heartbeat_start() {
  local id="$1" driver="$2"
  (
    # The sleep is a child of this subshell and holds its output open, so it is ended
    # with the loop instead of being left to run out its interval.
    sleeper=""
    trap '[[ -n "$sleeper" ]] && kill "$sleeper" 2>/dev/null; exit 0' TERM
    while :; do
      sleep "$HEARTBEAT_SECONDS" &
      sleeper=$!
      wait "$sleeper" 2>/dev/null
      kill -0 "$driver" 2>/dev/null || exit 0
      touched="$(qpy heartbeat "$id" 2>/dev/null)" || continue
      if [[ "$touched" == "0" ]]; then
        err "[$id] the queue no longer lists this dataset as inprogress (another slot's reconcile reclaimed it?); it may now be converted twice"
        exit 0
      fi
    done
  ) 9>&- 7>&- &
  HEARTBEAT_PID=$!
}
heartbeat_stop() {
  [[ -n "$HEARTBEAT_PID" ]] || return 0
  kill "$HEARTBEAT_PID" 2>/dev/null
  wait "$HEARTBEAT_PID" 2>/dev/null
  HEARTBEAT_PID=""
}

# A signal to this script reaches the driver too. The driver runs in the background so
# that the heartbeat can follow it, and a background job of a non-interactive shell
# starts with SIGINT ignored, so Ctrl-C and the supervisor's TERM would otherwise stop
# the script and leave the driver converting with nothing to report its result. (A slot
# the tick started inherits an ignored SIGINT itself, and bash cannot trap what was
# ignored on entry: stop one of those with TERM, or stop the tick, which forwards it. INT
# works on a slot run directly.) The
# driver's workers are its children and go with it. A stop is not a failure of the
# dataset: its row stays `inprogress` and the stale sweep returns it to `pending`.
DRIVER_PID=""
STOP_REQUESTED=""
# Set while a dataset is being converted, from taking its lock until the caller has its
# result. A stop that arrives after the driver has finished must not discard what it did:
# the callback, the scratch clean-up and `qpy done` still have to run.
CONVERTING=""
stop_driver() {
  [[ -n "$DRIVER_PID" ]] || return 0
  pkill -TERM -P "$DRIVER_PID" 2>/dev/null
  kill -TERM "$DRIVER_PID" 2>/dev/null
  return 0
}
on_stop_signal() {
  STOP_REQUESTED=1
  if [[ -n "$DRIVER_PID" ]]; then
    stop_driver  # the conversion returns, and the drain loop sees STOP_REQUESTED
  elif [[ -n "$CONVERTING" ]]; then
    :  # between the clone and the result: the caller finishes the bookkeeping, then stops
  else
    heartbeat_stop
    exit 143
  fi
}

# The driver's exit when this node's biosigIO does not meet the converter's floor,
# SUBJECT_INFO_FLOOR, which is where it can leave subject information out of a
# store and the converter takes nothing older (generate_zarr.py
# EXIT_SUBJECT_INFO_UNAVAILABLE, sysexits.h
# EX_CONFIG; #1626; test_hallu_zarr_config.py holds the two together). It is a
# property of the NODE, not of the dataset: every dataset would be refused the
# same way, so the drain stops on it instead of spending a retry attempt of every
# queued row in turn, which would turn the whole queue `failed` after a few
# hourly ticks. setup()'s floor check normally stops such a node first; the
# driver also exits 78 when its conversion workers refused every store they
# failed on (a worker with a different biosigIO than the one it checked).
#
# The driver's callback is still POSTed, as on every outcome (convert_dataset).
# Skipping it would keep nothing: the `converting` POST at the start of the
# attempt already set zarr_status='pending' and cleared the dataset's recorded
# failure detail (routes/callbacks/zarr-ready.ts), so without a terminal
# callback the dashboard would show the dataset as processing with nothing
# running, the #774 shape. With it, D1 reads `failed` (or `ready`, for a run
# that published what did convert) until the dataset's next conversion.
DRIVER_EXIT_SUBJECT_INFO_UNAVAILABLE=78
report_subject_info_refusal() {
  local id="$1"
  err "FATAL: the driver stopped on ${id}: this node's biosigIO does not meet the converter's floor (SUBJECT_INFO_FLOOR in generate_zarr.py; exit ${DRIVER_EXIT_SUBJECT_INFO_UNAVAILABLE}, #1626). No store it refused was uploaded."
  err "No queue row was marked failed and no retry attempt was spent. The driver's callback for ${id} was posted as on any outcome, so its zarr_status in D1 reads failed (ready if part of it converted) until its next conversion; the failure detail of its previous conversion was already cleared when this attempt started."
  err "Fix biosigIO in ${VENV_DIR} (the driver's ::error:: lines are in ${LOG_FILE}), then rerun."
}

# --- Per-dataset: download -> convert -> push -> CLEANUP -----------------------
# Returns 0 on success. The store is on S3; the scratch copy is always deleted.
# One conversion of a dataset at a time, across every slot and every one-off run. The
# queue hands a dataset to one slot, but a one-off `--dataset X` bypasses the queue, and
# with the single lock gone nothing else stops it running X onto the same S3 prefix as
# a slot that is converting X (`--clean` syncs with --delete: two at once undo each
# other). A one-off refuses to start on a dataset that is being converted (exit 3); a
# slot that is handed one a one-off holds waits for it to finish. The lock is on a
# descriptor the driver inherits, so it is held for as long as the driver lives.
DATASET_LOCK_DIR="${STATE_DIR}/dataset-locks"
convert_dataset_exclusive() {
  local id="$1" lock_rc=0
  LAST_DETERMINISTIC=false LAST_PENDING_COUNT=0 LAST_NOT_ATTEMPTED=0
  mkdir -p "$DATASET_LOCK_DIR"
  if ! exec 7>"${DATASET_LOCK_DIR}/${id}.lock"; then
    err "[$id] cannot open its dataset lock in ${DATASET_LOCK_DIR}"
    return 1
  fi
  if [[ -n "$ONLY_DATASET" ]]; then
    flock -n 7 || lock_rc=$?
  else
    # A queue-claimed run keeps the claim alive while it waits behind a one-off.
    flock_wait 7 qpy heartbeat "$id" >/dev/null 2>&1 || lock_rc=$?
  fi
  if ((lock_rc == 1)); then
    err "[$id] is being converted by another slot or run; not starting a second conversion of it"
    exec 7>&-
    return 3
  elif ((lock_rc != 0)); then
    err "[$id] cannot take its dataset lock (flock exited $lock_rc)"
    exec 7>&-
    return 1
  fi
  CONVERTING=1
  convert_dataset "$@"
  local rc=$?
  CONVERTING=""
  flock -u 7
  exec 7>&-
  return "$rc"
}

convert_dataset() {
  # $3 = "retry-pending" from the queue drain only (#1483): the driver then
  # converts just the recordings the published index lists as pending, when that
  # index is otherwise current (same commit, engine, biosigIO, provenance), and
  # falls back to the full --clean rebuild when it is not. A one-off --dataset
  # run never passes it, so an operator asking for a dataset always gets a full
  # rebuild.
  local id="$1" version="${2:-}" scope="${3:-}"
  local dir="$WORK_DIR/$id"
  local cb="$WORK_DIR/$id.callback.json"
  # Reset BEFORE any early return so the drain loop never reads an unbound (set -u
  # aborts) or stale value: a clone-failure early-return below must NOT inherit
  # the previous dataset's `deterministic` and get mis-marked terminal. Set from
  # the callback further down on a real conversion run.
  LAST_DETERMINISTIC=false
  # Same reasoning as LAST_DETERMINISTIC: reset per dataset so a run that writes
  # no callback cannot inherit the previous dataset's pending count and put this
  # row into a retry loop it never earned.
  LAST_PENDING_COUNT=0
  LAST_NOT_ATTEMPTED=0
  # Same again: whether every failure was storage lacking an annex object, and
  # the first such key, for record_conversion_failure's queue message.
  LAST_STORAGE_MISSING=false
  LAST_ANNEX_MISSING_COUNT=0
  LAST_ANNEX_MISSING_KEY=""
  log "[$id] start (version=${version:-?})"

  # In-progress signal so the observability dashboard's "Processing" tile reflects
  # live conversions (the cron has no Actions dispatch to set zarr_status=pending;
  # #774). Best-effort: a failed/skipped POST never blocks the conversion -- the
  # terminal ready/failed callback below is the authoritative state.
  if [[ -n "$NEMAR_WEBHOOK_TOKEN" ]]; then
    curl -sS --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL" \
      -H "Content-Type: application/json" \
      -H "X-Webhook-Token: ${NEMAR_WEBHOOK_TOKEN}" \
      --data "{\"dataset_id\":\"$id\",\"status\":\"converting\"}" >>"$LOG_FILE" 2>&1 \
      || err "[$id] converting callback failed (non-fatal)"
  fi

  # Metadata-only clone (git history + annex pointers, no content -- seconds, not
  # the whole 18 GB). The driver then STREAMS each recording's annex blob from
  # s3://nemar/<id>/objects/<key> just-in-time, converts, pushes, and moves on,
  # so we start converting immediately and never hold the whole dataset on disk.
  safe_rm "$dir"
  if ! nemar dataset download "$id" --no-data -o "$dir" >>"$LOG_FILE" 2>&1; then
    err "[$id] metadata clone failed"
    safe_rm "$dir"
    return 1
  fi

  # A stop that arrived while the clone was being made is acted on here, not after a
  # conversion it would then have to wait out.
  if [[ -n "$STOP_REQUESTED" ]]; then
    safe_rm "$dir"
    return 143
  fi

  local rc=0
  local retry_args=()
  [[ "$scope" == "retry-pending" ]] && retry_args=(--retry-pending)
  # --clean: full-rebuild every recording so the serving copy mirrors the current
  # dataset. It RECONCILES rather than wiping -- each store is synced with
  # --delete and only stores absent from HEAD are removed, after a successful
  # conversion (ADR 0023); the flag does not mean what its name suggests. With
  # streaming + JOBS-way parallelism a whole-dataset rebuild is cheap enough that
  # we always remake rather than reason about incremental diffs.
  VIRTUAL_ENV="$VENV_DIR" "$VENV_DIR/bin/python" "$DRIVER" \
    --dataset-id "$id" --repo-dir "$dir" \
    --bucket "$S3_BUCKET" --region "$AWS_REGION" --clean \
    ${retry_args[@]+"${retry_args[@]}"} \
    --contract-base "$CONTRACT_BASE" --api-base "$API_BASE" \
    --jobs "$JOBS" --callback-out "$cb" >>"$LOG_FILE" 2>&1 &
  DRIVER_PID=$!
  [[ "$scope" == "retry-pending" ]] && heartbeat_start "$id" "$DRIVER_PID"
  # A trapped signal interrupts `wait` without ending the child, so wait again until
  # the driver is really gone (it is, once stop_driver has signalled it).
  while :; do
    wait "$DRIVER_PID"
    rc=$?
    kill -0 "$DRIVER_PID" 2>/dev/null || break
  done
  DRIVER_PID=""
  heartbeat_stop

  # Read the driver's classification BEFORE the scratch is reclaimed. The
  # converter now writes the callback on EVERY outcome (incl. a total failure),
  # carrying `deterministic` = all failures are typed DATA failures. The drain
  # loop only consults LAST_DETERMINISTIC in the failure (rc!=0) branch: a
  # partial success returns rc=0 -> `done` regardless of this value (#774).
  if [[ -f "$cb" ]]; then
    LAST_DETERMINISTIC="$(jq -r '.deterministic // false' "$cb" 2>/dev/null || echo false)"
    # Recordings the index lists as `pending` (#1197). Handed to `qpy done` so the
    # row carries a backoff and reconcile re-queues it on its own -- which is what
    # #1113's "until the queue tracks per-recording state" was waiting for. The
    # manual recovery below stays for an operator who does not want to wait an
    # hour, and for the case where the rounds have run out.
    LAST_PENDING_COUNT="$(jq -r '.pending_count // 0' "$cb" 2>/dev/null || echo 0)"
    [[ "$LAST_PENDING_COUNT" =~ ^[0-9]+$ ]] || LAST_PENDING_COUNT=0
    # The subset never attempted. Forwarded separately because the queue treats
    # it differently: re-queued at the shortest delay, without spending a retry
    # round, since nothing has actually failed for those recordings.
    LAST_NOT_ATTEMPTED="$(jq -r '.not_attempted_count // 0' "$cb" 2>/dev/null || echo 0)"
    [[ "$LAST_NOT_ATTEMPTED" =~ ^[0-9]+$ ]] || LAST_NOT_ATTEMPTED=0
    # Every failed recording refused because storage lacks its annex object
    # (`annex_object_missing`), and the run failed for no other reason (no
    # producer `error`). The driver already keeps such a run non-deterministic,
    # so it is retried with backoff; this only chooses the message.
    LAST_STORAGE_MISSING="$(jq -r '
      (.annex_missing_count // 0) as $n
      | if .error == null and $n > 0 and $n == (.errors // -1) then "true" else "false" end
    ' "$cb" 2>/dev/null || echo false)"
    LAST_ANNEX_MISSING_COUNT="$(jq -r '.annex_missing_count // 0' "$cb" 2>/dev/null || echo 0)"
    [[ "$LAST_ANNEX_MISSING_COUNT" =~ ^[0-9]+$ ]] || LAST_ANNEX_MISSING_COUNT=0
    LAST_ANNEX_MISSING_KEY="$(jq -r '.annex_missing_first_key // ""' "$cb" 2>/dev/null || echo "")"
    retryable="$(jq -r '.retryable_failures // 0' "$cb" 2>/dev/null || echo 0)"
    if [[ "$retryable" =~ ^[0-9]+$ && "$retryable" -gt 0 ]]; then
      err "[$id] $retryable recording(s) failed for a RETRYABLE reason; they are listed as pending in index.json and the dataset will be re-queued automatically after a backoff. To retry now: $0 --dataset $id --requeue done --execute"
    fi
    # POST on every outcome (not just rc==0) so the backend records failures too.
    if [[ -n "$NEMAR_WEBHOOK_TOKEN" ]]; then
      curl -sS --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL" \
        -H "Content-Type: application/json" \
        -H "X-Webhook-Token: ${NEMAR_WEBHOOK_TOKEN}" \
        --data @"$cb" >>"$LOG_FILE" 2>&1 || err "[$id] callback failed (non-fatal)"
    fi
  fi

  # EPHEMERAL: always reclaim the scratch copy, success or failure.
  safe_rm "$dir"; rm -f "$cb"
  if [[ "$rc" -eq 0 ]]; then log "[$id] done"; else err "[$id] driver rc=$rc"; fi
  return "$rc"
}

# --- Queue verdict for a failed conversion ------------------------------------
# Reads the LAST_* values convert_dataset set from the driver's callback.
#   deterministic       -> `data_failed` now, never retried (#774)
#   storage lacks the   -> the queue's bounded backoff, then `failed`: every
#   annex object(s)        recording missing its object at once is what an
#                          upload still landing looks like, so it must not be
#                          buried as data_failed on the first run
#   anything else       -> the same bounded backoff, generic message
record_conversion_failure() {
  local id="$1"
  if [[ "$LAST_DETERMINISTIC" == "true" ]]; then
    # Every recording is an unreadable DATA failure -- terminal, no retry (#774).
    qpy fail "$id" "all recordings failed to convert (typed data failures; see ${LOG_FILE})" --deterministic ||
      err "[$id] marking the deterministic failure FAILED; the row stays inprogress and will be retried despite being terminal"
  elif [[ "$LAST_STORAGE_MISSING" == "true" ]]; then
    qpy fail "$id" "storage lacks the annex object(s) of all ${LAST_ANNEX_MISSING_COUNT} failed recording(s); first missing: s3://${S3_BUCKET}/${id}/objects/${LAST_ANNEX_MISSING_KEY}. Retrying with backoff in case an upload is still landing; if the objects never arrive this ends failed. Remedy: fix the upload, then requeue: $0 --dataset ${id} --requeue failed --execute (see ${LOG_FILE})" ||
      err "[$id] marking the missing-object failure FAILED; the row stays inprogress until the stale sweep reclaims it"
  else
    qpy fail "$id" "conversion failed (see ${LOG_FILE})" ||
      err "[$id] marking the failure FAILED; the row stays inprogress until the stale sweep reclaims it"
  fi
}

# --- Single-instance lock -----------------------------------------------------
# Requeue runs BEFORE the single-instance lock, deliberately. A drain can hold
# that lock for hours (on007808 held it through two cron ticks), and needing to
# revive stranded jobs while a long conversion is in flight is precisely when an
# operator reaches for this -- behind the lock it would just exit 3 having done
# nothing. It also skips setup(): that does `git reset --hard` on the driver
# clone, which a running conversion is reading from. SQLite's own locking covers
# the concurrent write, which is a single fast UPDATE.
# `--preview-engine-bump` answers "what would a bump cost" BEFORE one lands, and
# is the reason ADR 0033 can claim a bump is visible rather than merely loud
# after the fact. It runs `engine-preview`, which touches no network and changes
# no job's STATE -- it only counts what a bump would re-queue. It is not
# literally read-only: `zarr_queue.py`'s `main()` connects for every subcommand,
# and `connect` runs `migrate_schema`, whose additive ALTER and `engine_version`
# seed are by design idempotent and re-run on every connect. So a preview on a
# node that has never run the current queue schema does write those, exactly as
# the next reconcile would. That is safe ahead of the lock and of setup(), like
# --requeue and for the same reasons: SQLite's own locking covers it, and it is
# the same statements a concurrent drain has already run.
#
# Note this deliberately does NOT run a real reconcile with --no-engine-requeue.
# That would be a preview with side effects: reconcile enqueues new datasets,
# parks unlisted ones, and resets stale `inprogress` rows -- writes that would
# race a drain holding the lock. `--no-engine-requeue` remains available on
# `zarr_queue.py reconcile` for anyone who wants that instead.
if [[ -n "$PREVIEW_ENGINE_BUMP" ]]; then
  if [[ ! -f "$QUEUE" ]]; then
    err "queue script not found at $QUEUE; run once without --preview-engine-bump to set up the clone"
    exit 1
  fi
  qpy engine-preview
  exit $?
fi

# The #1172 backfill sweep sits in the same pre-lock, pre-setup() position, for
# the same two reasons: an operator reaches for it precisely while a drain may be
# holding the lock for hours, and it must not `git reset --hard` a clone that a
# running conversion is reading from. It is read-only against the archive until
# --execute, and even then its only write is the same single fast UPDATE that
# --requeue performs, which SQLite's own locking covers.
if [[ -n "$BACKFILL_DIR_FORMATS" ]]; then
  if [[ -n "$REQUEUE" ]]; then
    err "--backfill-dir-formats and --requeue are different recoveries; run one at a time"
    exit 2
  fi
  if [[ ! -f "$QUEUE" ]]; then
    err "queue script not found at $QUEUE; run once without --backfill-dir-formats to set up the clone"
    exit 1
  fi
  backfill_args=(backfill-dir-formats --api-base "$API_BASE")
  # --dataset and --limit are forwarded for the same reason --requeue forwards
  # --dataset: accepting a narrowing flag and ignoring it turns a deliberately
  # scoped run into a full-archive one.
  [[ -n "$ONLY_DATASET" ]] && backfill_args+=(--dataset "$ONLY_DATASET")
  [[ "$LIMIT" -gt 0 ]] && backfill_args+=(--limit "$LIMIT")
  [[ -n "$EXECUTE" ]] && backfill_args+=(--execute)
  # Same opt-in as reconcile's below: the staging catalog is the xx0999NN fleet.
  [[ -n "$TEST_PREPASS_SEEN" ]] && backfill_args+=(--accept-exemplars)
  qpy "${backfill_args[@]}"
  exit $?
fi

if [[ -n "$REQUEUE" ]]; then
  if [[ ! -f "$QUEUE" ]]; then
    err "queue script not found at $QUEUE; run once without --requeue to set up the clone"
    exit 1
  fi
  # --dataset MUST be forwarded. Accepting it and ignoring it would turn a
  # deliberately narrow `--dataset X --requeue failed --execute` into a reset of
  # EVERY failed row -- the operator asks for one dataset and silently gets all
  # of them.
  requeue_args=(requeue --status "$REQUEUE")
  [[ -n "$ONLY_DATASET" ]] && requeue_args+=(--dataset "$ONLY_DATASET")
  [[ -n "$EXECUTE" ]] && requeue_args+=(--execute)
  qpy "${requeue_args[@]}"
  exit $?
fi

# --- Slots: who runs what ------------------------------------------------------
# A plain invocation with several slots is a supervisor: it starts one drain per slot
# whose lock is free, waits for them, and exits. An invocation that names its slot
# (ZARR_SLOT, which is how the supervisor starts them) drains as that slot. A one-off
# `--dataset` takes the first free slot, so it neither waits behind a long drain nor
# shares a slot's scratch directory with one.
slot_is_free() (
  exec 9>"$(slot_lock_file "$1")"
  flock -n 9
)

supervise() {
  local k started=0 pids=() rc=0 pid
  for ((k = 0; k < SLOTS; k++)); do
    if slot_is_free "$k"; then
      log "starting slot $k (of $SLOTS)"
      ZARR_SLOT="$k" "${BASH:-bash}" "$SCRIPT_PATH" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"} &
      pids+=("$!")
      started=$((started + 1))
    fi
  done
  if ((started == 0)); then
    log "all $SLOTS slot(s) are busy; exiting"
    return 3
  fi
  # A drain that outlives this process would run on without a supervisor, which is
  # harmless, but one signalled here should be signalled too.
  trap 'kill "${pids[@]}" 2>/dev/null' TERM INT
  for pid in "${pids[@]}"; do
    # A trapped signal interrupts `wait` for the first slot only; keep waiting until each
    # slot is really gone, so the tick does not exit while a slot is still stopping.
    local r=0
    while :; do
      wait "$pid"
      r=$?
      kill -0 "$pid" 2>/dev/null || break
    done
    ((r == 3)) || rc=$r
  done
  return "$rc"
}

# --stats reads the queue and nothing else, so like --requeue it runs before any slot is
# taken and before setup(): a slot per question would rewrite the shared clone and hold
# every idle slot's lock to print one line. Where the clone or the venv does not exist
# yet (a new node) it falls through to the path that builds them.
if [[ -n "$STATS_ONLY" && -f "$QUEUE" && -x "$VENV_DIR/bin/python" ]]; then
  qpy stats
  exit $?
fi

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/$(basename "${BASH_SOURCE[0]}")"
if [[ -z "$SLOT" && -z "$ONLY_DATASET" && -z "$STATS_ONLY" ]] && ((SLOTS > 1)); then
  supervise
  exit $?
fi
if [[ -n "$SLOT" ]]; then
  use_slot "$SLOT"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "this slot is already running; exiting"
    exit 3
  fi
elif [[ -n "$ONLY_DATASET" ]] && ((SLOTS > 1)); then
  taken=""
  for ((k = 0; k < SLOTS; k++)); do
    use_slot "$k"
    exec 9>"$LOCK_FILE"
    if flock -n 9; then taken=1; break; fi
    exec 9>&-
  done
  if [[ -z "$taken" ]]; then
    use_slot 0
    err "all $SLOTS slot(s) are busy; not starting ${ONLY_DATASET}. Wait for one to finish, or raise ZARR_SLOTS."
    exit 3
  fi
else
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another hallu-zarr instance holds the lock; exiting"
    exit 3
  fi
fi

# From here this process owns a slot: a TERM or INT stops its driver and then it
# (see stop_driver).
trap on_stop_signal TERM INT

# --- Reclaim orphaned scratch -------------------------------------------------
# The driver's per-recording `tempfile.TemporaryDirectory()` unwinds on a normal
# exit, but a SIGKILL, an OOM, or an operator killing the drain's process group
# leaves the whole tree behind. Those are invisible (random `tmp*` names, not
# dataset-named) and they are BIG: 130 GB across 10 dirs by 2026-08-12, one of
# them 117 GB on its own. nemarOrg/nemar-cli#1068.
#
# Sweeping is safe HERE and only here: we hold the single-instance lock and have
# not started the driver, so nothing owns anything under WORK_DIR and every
# `tmp*` entry is by definition from a dead run. Dataset-named scratch dirs are
# left alone -- convert_dataset safe_rm's those itself before each clone.
#
# That safety argument depends on WORK_DIR and STATE_DIR (where the lock
# lives) belonging to the same deployment -- see the SWEEP_SCRATCH guard set
# above, right after both are resolved. When they disagree, this run's lock
# proves nothing about who owns files under WORK_DIR, so skip rather than
# risk deleting another deployment's in-flight scratch (nemarOrg/nemar-cli#1121).
sweep_orphaned_scratch() {
  local n=0 kb=0 sz
  while IFS= read -r -d '' p; do
    # `du -sk` (KiB) not `-sb`: -b is GNU-only. The regex guard keeps a failed or
    # empty du from turning the arithmetic into a syntax error and aborting the
    # sweep mid-loop -- reporting the size must never cost us the reclaim.
    sz=$(du -sk "$p" 2>/dev/null | cut -f1)
    [[ "$sz" =~ ^[0-9]+$ ]] || sz=0
    kb=$((kb + sz))
    safe_rm "$p"
    n=$((n + 1))
  done < <(find "$WORK_DIR" -maxdepth 1 -name 'tmp*' -print0 2>/dev/null)
  if [[ "$n" -gt 0 ]]; then
    log "swept $n orphaned scratch entries from a previous run (~$((kb / 1024)) MiB reclaimed)"
  fi
  return 0
}
if [[ -n "$SWEEP_SCRATCH" ]]; then
  sweep_orphaned_scratch
else
  log "WARNING: skipping orphaned-scratch sweep -- exactly one of" \
      "ZARR_STATE_DIR/ZARR_WORK_DIR is overridden from its default, so" \
      "WORK_DIR=$WORK_DIR may be shared with a deployment this run's lock" \
      "(under STATE_DIR=$STATE_DIR) does not cover. Override both or" \
      "neither to resume sweeping (nemarOrg/nemar-cli#1121)."
fi

setup_locked
START_HEAD="$(git -C "$DRIVER_REPO" rev-parse HEAD 2>/dev/null)"
if [[ ! -f "$DRIVER" || ! -f "$QUEUE" ]]; then
  err "driver/queue not found under $DRIVER_REPO after setup"; exit 1
fi

# Drift guard, for the bootstrap deployment shape only. setup() refreshes
# DRIVER_REPO from origin/$DRIVER_REF every run, and since #1109 moved this script
# INTO the checkout, cron invokes the clone's copy -- so in the normal deployment
# this script deploys itself along with the driver and the check below is a no-op
# (SELF == REPO_SELF). It still matters for a node bootstrapped from an
# out-of-clone copy, which has to exist before the clone does and which git never
# touches: such a copy silently fell ~5 weeks behind main once already
# (nemarDatasets/.github#92's scratch sweep merged and did nothing here).
# Compare and warn; do NOT self-copy,
# because bash reads a script incrementally and rewriting the running file mid-run
# resumes execution at a garbage byte offset. Deploy with an atomic rename:
#   scp hallu-zarr.sh hallu:/path/.hallu-zarr.sh.new && ssh hallu 'mv /path/.hallu-zarr.sh.new /path/hallu-zarr.sh'
# dirname/basename rather than ${BASH_SOURCE%/*}: invoked by bare name off $PATH
# there is no slash to strip, and the parameter expansion would yield the filename
# as the directory, making every run report a bogus drift.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_SELF="$DRIVER_REPO/scripts/zarr/$(basename "${BASH_SOURCE[0]}")"
if [[ -f "$REPO_SELF" && "$SELF" != "$REPO_SELF" ]] && ! cmp -s "$SELF" "$REPO_SELF"; then
  err "DRIFT: $SELF differs from $REPO_SELF (origin/${DRIVER_REF}). Changes merged to this script are NOT live; deploy it."
fi

# The drift guard above answers "is this script stale relative to the repo it was
# launched from". It CANNOT answer "has that repo moved since this run started",
# and during a backfill that is the question that matters: a run does not end
# until the queue is empty, so setup() never re-runs and the deployed driver is
# frozen for the whole drain. Measured once, and it is not a small window --
# Hallu ran a driver two deploys behind for two days, missing the entire epic
# #1108 memory work, because the run holding the lock had started before the
# cutover (#1129).
#
# So re-check the tracked ref BETWEEN datasets and stop cleanly when it moves.
# One ls-remote per dataset is noise against per-dataset conversion times
# measured in minutes, and the queue persists across runs, so stopping costs
# nothing but the next cron tick.
#
# A failed ls-remote must NEVER stop a backfill: a network blip is not a reason
# to halt hours of work, and the worst case of ignoring it is that the redeploy
# waits for the next dataset boundary.
ref_moved() {
  local remote_head local_head
  remote_head="$(git -C "$DRIVER_REPO" ls-remote origin "$DRIVER_REF" 2>/dev/null | cut -f1)"
  [[ -z "$remote_head" ]] && return 1
  # The commit THIS drain started on, not whatever the shared clone is at now: another
  # slot's setup() moves the clone, and comparing with that would tell this drain it is
  # current while it runs the old shell logic against the new driver.
  local_head="${START_HEAD:-$(git -C "$DRIVER_REPO" rev-parse HEAD 2>/dev/null)}"
  [[ -z "$local_head" ]] && return 1
  [[ "$remote_head" != "$local_head" ]]
}

if [[ -n "$STATS_ONLY" ]]; then
  # Propagate qpy's status rather than hard-coding success. `--stats` is what an
  # operator reaches for when the queue looks wrong, so a crash here (a corrupt
  # DB, say) IS the answer to their question -- reporting 0 would hide it from
  # anything checking the exit code.
  qpy stats
  exit $?
fi

# Past every early exit; from here on convert_dataset() may run and needs the token.
load_secrets

# The scratch settings (ZARR_SCRATCH_*) are checked ONCE, before anything is
# dispatched. generate_zarr.py refuses a bad value per dataset, after the clone and
# with a failed callback, so left to that every dataset the drain visited would post
# `failed` and burn a queue attempt on a typo that has nothing to do with it. Here a
# bad value stops the whole run with the clear message and leaves the queue and D1
# untouched, and the next tick tries again once the crontab is fixed.
if ! check_env_out="$(VIRTUAL_ENV="$VENV_DIR" "$VENV_DIR/bin/python" "$DRIVER" --check-env 2>&1)"; then
  err "$check_env_out"
  err "refusing to dispatch any dataset until the setting above is fixed (queue and D1 untouched)"
  exit 1
fi


# Targeted single-dataset run bypasses the queue (manual rebuild / test).
if [[ -n "$ONLY_DATASET" ]]; then
  v="$(curl -sS --max-time 30 "${API_BASE}/datasets/${ONLY_DATASET}" 2>/dev/null \
        | jq -r '.dataset.latest_version // ""' 2>/dev/null)"
  only_rc=0
  convert_dataset_exclusive "$ONLY_DATASET" "$v" || only_rc=$?
  if [[ -n "$STOP_REQUESTED" && "$only_rc" -ne 0 ]]; then
    log "[$ONLY_DATASET] stopped by a signal"
    exit 143
  fi
  if [[ "$only_rc" -eq "$DRIVER_EXIT_SUBJECT_INFO_UNAVAILABLE" ]]; then
    report_subject_info_refusal "$ONLY_DATASET"
  fi
  exit "$only_rc"
fi

# Reconcile (enqueue pending + recover stale inprogress), then drain the queue.
#
# Both queue calls below are exit-code checked, and that is load-bearing under
# `set -uo pipefail` (no -e). `log "reconcile: $(qpy reconcile)"` used to discard
# the status entirely: fetch_public_datasets' urlopen has no retry, so one API
# blip crashed qpy, the traceback went to stderr while the substitution captured
# only stdout, and the run logged a content-free "reconcile: " line. The drain
# then read an empty queue, broke immediately, and reported
# "run complete: processed 0 dataset(s)" with exit 0 -- a green cron tick that
# enqueued nothing, repeatable every hour for as long as the API stayed sick.
# Fail loud instead, the same way setup() treats every git step.
#
# The engine-bump guard is armed here (#1172). An ack is consumed BEFORE the run
# rather than after: a crash mid-reconcile would otherwise leave the file in
# place and arm every subsequent tick, and losing an ack to a crashed run is the
# safe direction to fail -- the operator re-touches it, versus a mass requeue
# nobody asked for twice.
reconcile_args=(reconcile --api-base "$API_BASE" --engine-requeue-limit "$ENGINE_REQUEUE_LIMIT")
# The staging catalog is the exemplar fleet (xx0999NN), which reconcile's
# production id filter rejects; --test opts the fleet band in. Keyed on the
# pre-pass record rather than TEST_MODE for the reason the pre-pass comment
# gives: it is the one --test signal a permissive parser cannot swallow.
if [[ -n "$TEST_PREPASS_SEEN" ]]; then
  reconcile_args+=(--accept-exemplars)
fi
if [[ -n "${ZARR_ENGINE_BUMP_ACK:-}" ]]; then
  log "engine bump acknowledged via ZARR_ENGINE_BUMP_ACK"
  reconcile_args+=(--engine-requeue-ack)
elif [[ -f "$ENGINE_ACK_FILE" ]]; then
  log "engine bump acknowledged via $ENGINE_ACK_FILE (consumed; touch it again to re-arm)"
  rm -f "$ENGINE_ACK_FILE"
  reconcile_args+=(--engine-requeue-ack)
fi
if ! reconcile_out="$(qpy "${reconcile_args[@]}")"; then
  err "FATAL: reconcile failed (catalog unreachable, or queue error); nothing was"
  err "enqueued this run. Not draining -- an empty queue here would be a lie."
  exit 1
fi
log "reconcile: $reconcile_out"
# The command-substitution above captures stdout, so the pending-ack notice would
# otherwise reach the log only as part of that one line. Re-raise it as its own
# ERROR line: a bump waiting on an operator must not be something you find by
# reading to the end of a reconcile summary.
case "$reconcile_out" in
  *"ENGINE BUMP PENDING ACK"*)
    err "an engine bump is waiting for acknowledgment; nothing was requeued for the stamp."
    err "Preview: $0 --preview-engine-bump   Apply: touch $ENGINE_ACK_FILE (arms the next run)"
    ;;
esac
n=0
while :; do
  # An empty line means "queue drained"; a NON-ZERO exit means the queue could
  # not be read. Conflating them would turn a broken DB into a silent clean exit.
  if ! line="$(qpy next)"; then
    err "FATAL: could not read the next queue entry; refusing to treat that as an"
    err "empty queue. ${n} dataset(s) processed before this."
    exit 1
  fi
  [[ -z "$line" ]] && break
  id="${line%%$'\t'*}"; version="${line#*$'\t'}"
  # These three are warn-not-exit, unlike the two above. A queue write that fails
  # right after a real conversion leaves the row `inprogress`, which the 6h
  # stale-recovery sweep reclaims on its own -- it costs one re-conversion, it
  # does not lose data or stall the drain. Worth a loud line so the wasted work
  # is attributable, not worth abandoning a backfill mid-queue.
  driver_rc=0
  convert_dataset_exclusive "$id" "$version" retry-pending || driver_rc=$?
  if [[ "$driver_rc" -ne 0 && -n "$STOP_REQUESTED" ]]; then
    # An operator stop, not a failure of the dataset: no attempt is spent. The row
    # stays inprogress and the stale sweep returns it to pending after six hours. (A
    # conversion that FINISHED before the stop took effect is recorded below first:
    # days of work are not discarded for a signal that arrived a moment late.)
    log "[$id] stopped by a signal; its queue row stays inprogress until the stale sweep returns it to pending"
    exit 143
  fi
  if [[ "$driver_rc" -eq 0 ]]; then
    # shellcheck disable=SC1010  # `done` is the queue subcommand, not the keyword
    qpy done "$id" "$version" --pending-count "${LAST_PENDING_COUNT:-0}" \
      --not-attempted-count "${LAST_NOT_ATTEMPTED:-0}" ||
      err "[$id] converted, but marking it done FAILED; the row stays inprogress until the stale sweep reclaims it (~6h) and it will be converted again"
  elif [[ "$driver_rc" -eq "$DRIVER_EXIT_SUBJECT_INFO_UNAVAILABLE" ]]; then
    # A node-level refusal: stop here, fail nothing. This row stays `inprogress`
    # and reconcile's stale sweep returns it to `pending` without an attempt
    # (~6h); the rows behind it are never claimed.
    report_subject_info_refusal "$id"
    err "Stopping the drain; ${n} dataset(s) processed before ${id}. Its queue row stays inprogress until reconcile's stale sweep (~6h) returns it to pending, without an attempt."
    exit "$DRIVER_EXIT_SUBJECT_INFO_UNAVAILABLE"
  else
    record_conversion_failure "$id"
  fi
  n=$((n + 1))
  if [[ -n "$STOP_REQUESTED" ]]; then
    log "[$id] done; stopping on a signal (queue persists; next run continues)"
    exit 143
  fi
  if [[ "$LIMIT" -gt 0 && "$n" -ge "$LIMIT" ]]; then
    log "reached --limit $LIMIT; stopping (queue persists; next run continues)"
    break
  fi
  if ref_moved; then
    log "origin/${DRIVER_REF} moved; stopping so the next run redeploys (queue persists)"
    break
  fi
done

log "run complete: processed $n dataset(s); $(qpy stats | head -1)"
