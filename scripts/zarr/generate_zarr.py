#!/usr/bin/env python3
"""NEMAR Zarr serving-copy generator (epic nemarOrg/nemar-cli#684, Stream B).

Runs on the SDSC Hallu cron, driven by ``scripts/zarr/hallu-zarr.sh`` (ADR 0029).
It previously lived in nemarDatasets/.github and ran as run-generate-zarr.yml;
that workflow is retired -- Actions cannot finish a large dataset inside the
120-minute cap. Converts the BIDS recordings that changed since the last
conversion into per-recording biosigIO Zarr v3 serving stores, uploads them to
``s3://<bucket>/<id>/zarr/...`` (LATEST-ONLY: overwrite in place, delete on
source removal), maintains ``s3://<bucket>/<id>/zarr/index.json``, and writes a
callback body the driver script POSTs to ``/webhooks/zarr-ready``.

The conversion itself is biosigIO (``Recording.from_file -> bids.apply_events_tsv
-> rec.to_zarr``); this driver owns the BIDS-tree orchestration: change
detection, annex-content materialization, S3 sync, and the index.

A store holds the data, the events, channel names, types and units, and
technical recording metadata, and never the subject (#1626). Every store is
written through ``write_store``, which has biosigIO leave subject and operator
information out (``exclude_subject_info``, biosigio>=1.2.11), and ``main``
refuses to convert on a biosigIO that cannot. Subject information stays at
dataset scope, in ``participants.tsv``.

Design notes
------------
* The dataset repo is cloned by the workflow (full history, ``--no-checkout``);
  this script reads the tree with git plumbing (``ls-tree``/``cat-file``/``diff``)
  exactly like ``emit_manifest.py``, and pulls annex *content* from
  ``s3://<bucket>/<id>/objects/<key>`` with authenticated ``aws s3 cp`` (works for
  private datasets, unlike the archive workflow's public-HTTP fetch), or from
  that key's git-annex chunks when the dataset was uploaded with chunking
  (``fetch_annex_object``).
* Incremental: the prior ``index.json`` records the commit it was built from;
  we ``git diff <prior>..HEAD`` and convert only the affected recordings, mapping
  a changed companion (``.fdt``/``.eeg``/``.vmrk``) or ``*_events.tsv`` back to its
  sibling recording. ``--full`` (or a missing/!ancestor prior) converts everything.
* BIDS raw only: ``derivatives/``, ``sourcedata/``, and ``code/`` never hold a BIDS
  raw recording, so ``is_excluded_from_discovery`` excludes them (and BIDS-reserved
  MEG calibration filenames) from every discovery path -- ``is_primary``, the
  directory-recording derivation, and the diff-based companion/events routing. This
  scope matches nemarOrg/nemar-cli ADR 0027 (the backend dispatch-gate side of the
  same decision). Excluding a tree from *future* conversion must not be read as
  "gone from HEAD": ``compute_clean_orphans`` explicitly protects already-published
  stores under an excluded tree from ``--clean``'s orphan-removal so this scope
  change alone never deletes a store; that cleanup is separate, explicitly-authorized
  follow-up work (nemarOrg/nemar-cli#1095 / nemarOrg/nemar-cli#1097).
* Directory-keyed recordings: CTF ``.ds``, MEF3 ``.mefd``, and 4D/BTi are each a
  DIRECTORY of files git tracks individually, never the directory itself.
  ``.ds``/``.mefd`` are derived from an extension on a path component
  (``dir_recording_of`` / ``is_dir_recording`` / ``dir_recordings``); 4D/BTi carries
  no extension at all (BIDS names it a bare ``..._meg/`` directory), so it is
  detected by CONTENT instead -- a ``c,rf*`` processed-data file alongside a sibling
  ``config`` file (``bti_recordings``), the same gate biosigIO's importer uses, so
  the two sides agree on what counts as a recording. Requires biosigio>=1.2.3 (the
  release that added ``.mefd``/4D-BTi import); see ``requirements.txt``.
* The pure helpers (path classification, worklist, index merge) carry the logic
  and are unit-tested in ``test_generate_zarr.py``; the I/O lives in ``main``.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import errno
import hashlib
import importlib
import inspect
import io
import json
import math
import os
import pickle
import posixpath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.request
from collections.abc import Callable, Mapping, MutableMapping
from concurrent.futures import (
    FIRST_COMPLETED,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    wait,
)
from concurrent.futures.process import BrokenProcessPool
from datetime import datetime, timezone
from typing import Any, Literal, NamedTuple, Protocol, TypedDict

# The engine stamp lives in `zarr_queue`, whose column decides which already-done
# datasets re-convert (ADR 0033). The index republishes it so a consumer can tell
# WHICH generation of the discovery rules produced a store without reading the
# queue, and so an operator can spot a node running a stale driver. Imported
# rather than copied: two constants would drift the moment one was bumped. This is
# a sibling module in the same directory, which is on sys.path both when this file
# is run as a script and when the test suite imports it.
from zarr_queue import ZARR_ENGINE_VERSION

# Several drivers can convert on one node at once (hallu-zarr.sh slots). Each admits
# against the RAM and scratch the others have reserved and not yet taken, through a
# ledger they share (ADR 0101). A sibling module for the same reason as the import
# above.
from admission_ledger import SETTING_ERRORS as LEDGER_SETTING_ERRORS
from admission_ledger import Ledger, LedgerBusy, process_start_ticks

# --- Path classification -------------------------------------------------

# Primary recording containers biosigIO reads directly. A change to one of
# these (or its companion / events sidecar) rebuilds exactly one `.zarr` store.
# KIT/Yokogawa MEG is a single `.con`/`.sqd`/`.kdf` file (its `.mrk`/`.elp`/`.hsp`
# coregistration sidecars are not needed for the signal serving copy).
PRIMARY_EXTS = (".set", ".edf", ".bdf", ".vhdr", ".fif", ".con", ".sqd", ".kdf")
# Companions that share a recording's filename stem and carry its samples or
# markers; a change confined to one still rebuilds the recording's store.
COMPANION_EXTS = (".fdt", ".eeg", ".vmrk")
# CTF MEG is a `.ds` DIRECTORY (`.meg4` data + `.res4`/`.hc`/... headers), and MEF3
# iEEG is a `.mefd` DIRECTORY (`<CHANNEL>.timd/<CHANNEL>-000000.segd/` holding
# `.tdat`/`.tidx`/`.tmet` per channel segment -- a real session can hold well over a
# hundred `.timd` channel dirs, see on006392's 194). Neither is a single file, so
# neither ever appears in `git ls-tree` as one path -- each is derived from the files
# under it and treated as one recording keyed at the directory itself. Both are
# EXTENSION-keyed (the directory's own name ends in `.ds`/`.mefd`), which is what
# lets `dir_recording_of` derive the recording from any member path without
# consulting `head_files`; contrast 4D/BTi below, which is directory-based too but
# carries no extension and needs content-based detection instead.
CTF_DS_EXT = ".ds"
# api.nemar.org sits behind Cloudflare, which 403s the default Python-urllib
# User-Agent as a bot (verified 2026-09-03: the same GET is 200 under any other
# string). The first production run on engine 3 fetched provenance without one
# and flagged every store `provenance_fetch_failed`, so this is load-bearing for
# the whole conversion wave, not a courtesy header. `zarr_queue.USER_AGENT`
# covers the catalog fetch for the same reason; the converter identifies itself
# distinctly so the two are separable in access logs.
USER_AGENT = f"nemar-zarr-converter/{ZARR_ENGINE_VERSION} (+https://github.com/nemarOrg/nemar-cli)"

MEFD_EXT = ".mefd"
DIR_RECORDING_EXTS = (CTF_DS_EXT, MEFD_EXT)

# 4D Neuroimaging/BTi MEG: BIDS gives the recording directory NO extension at all
# (`sub-<label>[_ses-<label>]_task-<label>[_run-<index>]_meg/`), so unlike
# `.ds`/`.mefd` it cannot be keyed by a path-component extension -- detection is by
# CONTENT instead (`bti_recordings`, `bti_dir_of`): a directory qualifies only when
# it directly (non-nested) contains a `c,rf*`-prefixed processed-data file AND a
# sibling `config` file. Requiring `c,rf*` is the point: `config` alone is common to
# almost every datalad-tracked dataset (`.datalad/config`) and would false-positive
# on nearly every repo if used by itself. This mirrors biosigIO's own
# `importers.meg._find_bti_pdf` gate exactly, so the converter and biosigIO agree on
# what counts as a BTi recording.
_BTI_PDF_PREFIX = "c,rf"
_BTI_CONFIG_NAME = "config"

# Trees that can never hold a BIDS raw recording, so a file under one is never
# a servable recording no matter its extension. Mirrors `emit_records.py`'s
# `derivatives`/`sourcedata` exclusion shape (this repo), extended to also
# cover `code/` -- see `is_excluded_from_discovery` below and
# nemarOrg/nemar-cli ADR 0027 for the matching backend dispatch-gate scope.
EXCLUDED_TREES = ("derivatives", "sourcedata", "code")

# BIDS-reserved Elekta/Neuromag MEG calibration filenames: fine-calibration
# and crosstalk-correction data, never a recording. `_acq-crosstalk_meg.fif`
# matches PRIMARY_EXTS by extension alone and, read as a recording, raises a
# correctly-failing `ValueError: Could not find measurement data` (confirmed
# in on006012, on006720) -- the right verdict on the wrong question.
_BIDS_CALIBRATION_SUFFIXES = ("_acq-crosstalk_meg.fif", "_acq-calibration_meg.dat")

INDEX_FORMAT = "nemar-zarr-index"
# v3 (nemarOrg/nemar-cli#1059, #1197, #1178 item 5). Additive over v1 for every
# field a consumer already read, with ONE removal: per-store `source_key` moved to
# the sibling producer manifest (see MANIFEST_FORMAT), because nothing on the
# website read it and it was 18 percent of nm000281's 12.8 MB index. v2 was never
# published; the number is skipped so "v3" means one thing everywhere.
INDEX_FORMAT_VERSION = 3
MANIFEST_FORMAT = "nemar-zarr-manifest"
MANIFEST_FORMAT_VERSION = 1

# JSON Schemas the published documents are validated against before upload. They
# live in the repo (`shared/`) rather than beside this file so the backend can
# serve the same bytes at GET /schemas/zarr-index-v3.json.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
INDEX_SCHEMA_PATH = os.path.join(_REPO_ROOT, "shared", "zarr-index.schema.json")
MANIFEST_SCHEMA_PATH = os.path.join(_REPO_ROOT, "shared", "zarr-manifest.schema.json")

# The STABLE base a client may hardcode. `data_base`/`s3_uri` say where the bytes
# happen to live today and are derived from --bucket/--region; this one is
# declared, because the whole point of publishing it is that it can stay put while
# the storage behind it moves. `--contract-base` overrides it (hallu-zarr.sh
# passes the test host in --test mode).
DEFAULT_CONTRACT_BASE = "https://zarr.nemar.org"
# Catalog the per-dataset provenance (DOI, license, HED version) is read from once
# per run for the stores' `nemar` root attribute (#1064).
DEFAULT_API_BASE = "https://api.nemar.org"

# A published index MUST name the commit it was built from. on008083 published
# `source_commit: ""` while D1 held the real SHA, which makes the index
# unreproducible and the incremental diff impossible (#1197). Enforced in
# `merge_index`, which refuses to build a document without one.
COMMIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# The store layout, published verbatim in every index. An MCP recipe (ADR 0025)
# has to be computable from index.json plus ONE array-metadata fetch, with no
# probing: the broker is stateless, so anything it cannot read from the index it
# has to discover by request, and discovery-by-404 is what #1178 item 2 was about.
# The index already carries `n_view_levels` and the geometry per group; these are
# the path templates and the sample-value rule that turn those numbers into
# actual reads. `const` in the schema, so a client may hardcode them after
# checking `format_version` -- and so a change to the layout is a schema change
# rather than a silent one.
INDEX_LAYOUT = {
    "level0": "<zarr>/<group>/0",
    "view": "<zarr>/<group>/view/<L>",
    "view_levels": "1..n_view_levels from the group attrs",
    "scale_offset": (
        "level-0 array attrs scale[] and offset[]; physical = digital * scale + offset"
    ),
    # Stated against data_base rather than contract_base because it is one object,
    # not a store path. Whether it EXISTS is said by the top-level
    # `events_parquet` field, which is absent for a dataset with no events (#1060)
    # -- the template here is how to read it, not a promise that it is there.
    "events": "<data_base>events.parquet",
}

# Conversion attempts a `pending` recording gets before the producer stops
# expecting it to convert and promotes it to a typed `retry_exhausted` failure.
# Matches `zarr_queue.PENDING_MAX_ROUNDS`, which caps the queue side of the same
# loop: a recording that will never convert must stop consuming the queue.
PENDING_MAX_ATTEMPTS = 5

# Per-modality canonical rate caps (Hz) passed to to_zarr. Keys are biosigIO's
# uppercase modality names; the defaults already match, set explicitly so the
# NEMAR caps are visible/auditable here rather than implied by the library.
MODALITY_RATES = {"EEG": 250, "MEG": 250, "IEEG": 1000, "EMG": 1000}

# Large recordings are converted with biosigIO's STREAMING path (bounded RAM)
# instead of the in-memory `Recording.from_file -> to_zarr`, which loads the whole
# recording at float64 2-3x and OOMs on multi-GB iEEG/MEG (e.g. nm000253's 18 GB
# BrainVision recordings). Gated on (a) size and (b) the format having a streaming
# reader that agrees with its in-memory reader exactly. That condition started out
# as "MNE-native" (BrainVision/FIF go through MNE either way) and is no longer a
# synonym for it: KIT and EDF/BDF stream too, each on its own lower threshold,
# which is why they get their own tuples below. EEGLAB `.set` is now the only
# format that never streams at any size (ADR 0030) -- `should_stream` is the
# authority, not this paragraph.
# No single version floor: EDF streaming needs biosigio>=1.2.0, MEF3/BTi discovery
# >=1.2.3, HDF5 `.set` >=1.2.4, CTF coil naming >=1.2.5. `requirements.txt` carries
# the pin and the reason for each bump; read it there rather than tracking a number
# here. Threshold is env-overridable for the Hallu cron.
# CTF `.ds` is MNE-native too (large MEG), so it streams as well. So is MEF3
# `.mefd`: `mne.io.read_raw_mef` supports `preload=False`, and biosigio's streaming
# exporter opens it lazily the same way as CTF/FIF (`_MneSource`, biosigio>=1.2.3)
# -- worth it, since a MEF3 iEEG session can be multi-gigabyte. 4D/BTi streams too
# (`mne.io.read_raw_bti(preload=False)`, same `_MneSource` lazy path) but is NOT
# extension-keyed, so it cannot join this tuple; `should_stream` below gives it its
# own extension-less branch at this SAME common threshold, deliberately not the
# lower KIT one (see the KIT comment below for why KIT differs).
# 256 MiB, matching KIT and EDF. It was 2 GiB, and that gap is what sank
# on004917: its 24 BrainVision recordings are 1.18-2.25 GB, so all but one sat
# just UNDER the threshold, took the unbounded in-memory path, and were admitted
# seven at a time against a projection running half their real cost.
#
# There was never a principled reason for BrainVision to need a threshold eight
# times higher than EDF's -- the driver's own note says BrainVision goes through
# MNE on both paths, so parity holds either way. The in-memory path survives only
# as a fast path for genuinely small recordings, where process startup and the
# scratch memmap would cost more than the load itself.
#
# This supersedes the ZARR_STREAM_MIN_BYTES=268435456 crontab override added as a
# mitigation on 2026-08-22; remove that override when this reaches the node
# (ADR 0030).
STREAM_MIN_BYTES = int(os.environ.get("ZARR_STREAM_MIN_BYTES", str(256 * 1024**2)))
STREAM_EXTS = (".vhdr", ".fif", ".ds", MEFD_EXT)
# KIT/Yokogawa .con/.sqd/.kdf load FULLY in memory (read_raw_kit has no lazy
# path), and a many-channel MEG file expands to ~5x its bytes as float64 + the
# biosigIO DataFrame + the resample copy -- so even a ~600 MB .con OOM-kills a
# pool worker at JOBS-way concurrency (which then breaks the whole pool). Route
# them through the streaming converter from the common threshold (since #1112
# common one: streaming peaks ~3 GB regardless of file size, and small KIT
# files stay on the faster in-memory path. 4D/BTi does NOT belong in this group
# even though it is also MEG and also directory-based: `read_raw_bti` DOES support
# `preload=False` (confirmed via biosigio's streaming exporter, which opens it lazily
# exactly like CTF/FIF/`.mefd`), so it has none of KIT's "no lazy path" problem and
# stays on the `STREAM_EXTS` threshold instead (see
# `should_stream`).
STREAM_KIT_EXTS = (".con", ".sqd", ".kdf")
STREAM_KIT_MIN_BYTES = int(os.environ.get("ZARR_STREAM_KIT_MIN_BYTES", str(256 * 1024**2)))

# EDF/BDF have no lazy MNE reader parity: the in-memory path reads them via
# pyedflib and MNE rescales EDF to SI volts, so streaming EDF via MNE would NOT
# match a re-run on the in-memory path. biosigIO >= 1.2.0 streams EDF/BDF via
# pyedflib (importer parity), so ONLY then may we route them to the streamer;
# on an older lib EDF stays in-memory (and is #909-skipped when too large).
# Threshold is low (like KIT) because in-memory EDF blows up ~6x and OOMs early.
STREAM_EDF_EXTS = (".edf", ".bdf")
STREAM_EDF_MIN_BYTES = int(os.environ.get("ZARR_STREAM_EDF_MIN_BYTES", str(256 * 1024**2)))


def _biosigio_streams_edf() -> bool:
    """True if the installed biosigIO streams EDF/BDF via pyedflib (>= 1.2.0,
    nemar-cli#944). Older builds read EDF via MNE in stream_to_zarr, which
    disagrees with the in-memory pyedflib units, so EDF must stay in-memory."""
    try:
        from importlib.metadata import version

        major_minor = tuple(int(p) for p in version("biosigio").split(".")[:2])
        return major_minor >= (1, 2)
    except Exception:  # noqa: BLE001 - absent/odd version string: assume no EDF streaming
        return False


# Resolved once at import; a recording-format decision must not re-probe per call.
_EDF_STREAMABLE = _biosigio_streams_edf()


def should_stream(primary_local: str, size_bytes: int) -> bool:
    """Whether a recording converts via the bounded-memory streaming path.

    EEGLAB `.set` is deliberately absent from every streaming tuple, and stays on
    the in-memory path at any size. Two independent blockers, both verified
    against the installed MNE and biosigIO:

    1. A MATLAB v7.3 `.set` is an HDF5 container. MNE refuses it outright, and
       only biosigIO's own h5py importer reads it (the `[hdf5]` extra, added in
       1.2.4 for 544 such recordings across the archive). Streaming routes through
       MNE, so routing `.set` there would turn those 544 back into failures.
    2. For a classic `.set` whose samples are embedded in the MAT struct rather
       than a sibling `.fdt`, `preload=False` is a fiction: MNE's
       `_read_segment_file` detects `is_embedded` and calls `_readmat(preload=True)`,
       materializing the whole recording and caching it. Streaming such a file
       would load everything anyway AND add the scratch memmap on top -- strictly
       worse than the in-memory path it replaced.

    Only a classic `.set` with a sibling `.fdt` could genuinely stream, which is a
    subset, and biosigIO importer parity for units and channel handling would
    still need proving before relying on it. Large `.set` recordings are instead
    protected by the RLIMIT_DATA backstop (#1110) and by the temporary-vs-permanent
    verdict split (#1111), so one cannot take down a node or be buried forever.

    Large MNE-native recordings (BrainVision/FIF, CTF `.ds`, MEF3 `.mefd`) stream
    above ``STREAM_MIN_BYTES``; KIT `.con`/`.sqd`/`.kdf` and
    -- when biosigIO >= 1.2.0 -- EDF/BDF stream above the much lower KIT/EDF
    thresholds because their in-memory float64 blow-up OOMs a worker well below
    the common threshold. Everything else uses the faster
    in-memory path.

    Called both pre-materialization (``primary_local`` is still the git-relative
    path, e.g. the RAM-admission estimate in ``main``) and post-materialization
    (a real local path, from ``convert_recording``), so every branch here must
    decide from the path STRING alone -- never ``os.path.isdir`` or another
    filesystem check, which would silently misclassify the pre-materialization
    call (nothing exists at that path yet).
    """
    ext = lower_ext(primary_local)
    if ext in STREAM_KIT_EXTS:
        return size_bytes > STREAM_KIT_MIN_BYTES
    if _EDF_STREAMABLE and ext in STREAM_EDF_EXTS:
        return size_bytes > STREAM_EDF_MIN_BYTES
    if ext in STREAM_EXTS:
        return size_bytes > STREAM_MIN_BYTES
    # 4D/BTi: BIDS gives it no extension at all (see `bti_recordings`), so it
    # can't join STREAM_EXTS by extension the way `.ds`/`.mefd` do. Every other
    # primary this converter discovers carries a real extension (PRIMARY_EXTS, or
    # `.ds`/`.mefd` via DIR_RECORDING_EXTS), so an empty extension reaching here is
    # a BTi recording by construction, not an unrelated ext-less path. It streams
    # above the SAME threshold as STREAM_EXTS -- deliberately not the
    # lower KIT one -- because `read_raw_bti` genuinely supports `preload=False`
    # (biosigIO's streaming exporter opens it lazily via the same `_MneSource`
    # path as CTF/FIF/`.mefd`); it doesn't have KIT's "no lazy reader" problem.
    if ext == "":
        return size_bytes > STREAM_MIN_BYTES
    return False


# --- Per-recording memory guard (#909) ----------------------------------------
# The in-memory path (`Recording.from_file`) loads a recording at float64 (~4x
# its int16 on-disk bytes) plus a resample copy, so a large EDF/BDF/EEGLAB
# recording -- which has no streaming reader -- OOM-kills its pool worker (and,
# via BrokenProcessPool, its concurrently-running siblings), then reruns as an
# infra failure and burns retries. The streaming path peaks ~STREAM_PEAK_BYTES
# regardless of size. We PROJECT each recording's peak RAM and skip (cleanly,
# with a deterministic reason surfaced in the index) anything that won't fit the
# node's usable RAM -- BEFORE the load, so no OOM ever happens. The ceiling is the
# whole usable node (not usable_RAM / jobs): main() admits recordings so the SUM
# of in-flight peaks stays within it, so raising --jobs adds concurrency without
# shrinking the budget or skipping more recordings.
STREAM_PEAK_BYTES = int(os.environ.get("ZARR_STREAM_PEAK_BYTES", str(4 * 1024**3)))
# Hard floor for the admission ceiling: two streaming recordings. See
# `usable_ram_bytes`.
CEILING_FLOOR_BYTES = int(
    os.environ.get("ZARR_CEILING_FLOOR_BYTES", str(2 * STREAM_PEAK_BYTES))
)

# --- Per-worker memory ceiling (#1110) ---------------------------------------
# Admission reserves a projected peak for each recording. Nothing enforced that
# reservation, so a recording that blew past it took the WHOLE NODE with it: the
# kernel OOM reaper killed the worker, ProcessPoolExecutor declared the pool
# broken, and every recording still queued behind it died too (on004998 lost 41
# of 115 that way; 96 such aborts in the log history).
#
# RLIMIT_DATA, not RLIMIT_AS. The streaming path builds a channel-major
# `np.memmap` on scratch, which is FILE-BACKED: it consumes address space without
# consuming memory, so an RLIMIT_AS sized to the budget would kill precisely the
# bounded path we want recordings to use. Since Linux 4.7 RLIMIT_DATA covers
# anonymous mappings (the float64 blow-up that actually OOMs) and excludes
# file-backed mmap. Verified on the conversion node: under a 512 MiB RLIMIT_DATA
# a file-backed 2 GiB memmap is allowed while a 1 GiB anonymous allocation raises
# a clean, catchable MemoryError.
#
# The limit is deliberately loose: `peak * SLACK`, floored so a small recording
# still gets a minimum reservation of its own (the interpreter and library
# footprint are measured and added separately; see `data_segment_bytes`), and
# capped at the node ceiling so nothing may exceed what #909 already forbids. It is a backstop
# against a runaway, NOT a tight budget -- projections are still the guessed
# `INMEM_MEM_FACTOR` and run ~2x low for BrainVision, so a tight limit here would
# fail recordings that convert fine today. #1111 makes projections
# measurement-based and can then tighten SLACK.
MEM_LIMIT_SLACK = float(os.environ.get("ZARR_MEM_LIMIT_SLACK", "3.0"))
MEM_LIMIT_FLOOR_BYTES = int(os.environ.get("ZARR_MEM_LIMIT_FLOOR_BYTES", str(4 * 1024**3)))

# The limit is applied ON TOP of the worker's data segment as it stands when the
# recording starts, not as an absolute number. RLIMIT_DATA counts every private
# writable mapping, and the scientific stack reserves a great deal of those at
# import without ever touching them: measured on the conversion node
# (2026-09-03, 32 cores), `import numpy` + `import scipy` alone put VmData at
# 2.6 GiB against 100 MB of RSS, because each bundled OpenBLAS pre-maps a buffer
# pool sized for every core. Applied as an absolute cap, the 4 GiB floor left
# ~1.3 GiB of real headroom, and a 4 MB EMG recording died on a 624 KiB
# allocation with "exceeded its memory budget" -- the same message a genuine
# runaway produces, so the failures read as data problems for days. The thread
# caps below shrink that reservation to ~220 MB; adding the baseline makes the
# backstop mean what its name says regardless of what the libraries reserve.
BLAS_THREAD_VARS = (
    "OPENBLAS_NUM_THREADS",
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)


def cap_blas_threads(env: MutableMapping[str, str] = os.environ) -> dict[str, str]:
    """Pin BLAS/OpenMP thread pools to one thread unless the operator set them.

    Must run before numpy is first imported in this process (the pools are sized
    at import); this module imports numpy lazily, so calling it at module import
    is early enough for the driver, and pool workers inherit the environment.
    One thread is also simply correct here: the driver already runs up to
    `--jobs` recordings in parallel, so per-recording BLAS threading only
    oversubscribes the node (24 workers x 32 threads) and, per the numbers above,
    costs ~2.4 GiB of RLIMIT_DATA headroom per worker for nothing.
    Returns the values now in effect, for the log.
    """
    for var in BLAS_THREAD_VARS:
        env.setdefault(var, "1")
    return {var: env[var] for var in BLAS_THREAD_VARS}


cap_blas_threads()


def data_segment_bytes() -> int | None:
    """This process's RLIMIT_DATA-accounted footprint right now (`VmData` from
    /proc/self/status), or None where that file does not exist (macOS, Windows),
    which is also where the backstop is not applied."""
    try:
        with open("/proc/self/status", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("VmData:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def memory_snapshot() -> dict[str, int]:
    """VmData, VmRSS and VmHWM from /proc/self/status, plus the soft RLIMIT_DATA,
    at this instant. Whatever cannot be read (macOS, a locked-down /proc) is
    omitted rather than guessed. For the log line a memory failure prints: the
    budget is enforced on VmData while calibration measures RSS, and only both,
    side by side with the limit, say which one a failure actually hit (#1483)."""
    snap: dict[str, int] = {}
    try:
        with open("/proc/self/status", encoding="utf-8") as fh:
            for line in fh:
                key = line.split(":", 1)[0]
                if key in ("VmData", "VmRSS", "VmHWM"):
                    snap[key] = int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    try:
        import resource

        soft = resource.getrlimit(resource.RLIMIT_DATA)[0]
        if soft != resource.RLIM_INFINITY:
            snap["RLIMIT_DATA"] = soft
    except (ImportError, OSError, ValueError):
        pass
    return snap


def log_memory_failure(primary: str, exc: BaseException) -> None:
    """Print a memory failure's traceback and a ``memory_snapshot``.

    ``memory_failure_result`` keeps only the first line of the error, and the
    failure happens inside a pool worker, so without this the stack and the
    process's footprint are gone for good. on004789's 60.4 MiB allocation
    failures (#1483) could only be attributed to zarr shard buffers by reading
    source code, because nothing recorded where they were raised or how close
    the worker was to its limit. Best-effort: logging must never turn a typed
    memory failure into an uncoded one, so any error here, including a second
    MemoryError, is swallowed. Interrupts still propagate."""
    try:
        import traceback

        snap = memory_snapshot()
        mem = ", ".join(f"{k}={v / 1024**3:.2f} GiB" for k, v in snap.items()) or "unavailable"
        stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        print(
            f"::warning::{primary!r} exceeded its memory budget ({mem}); traceback "
            f"follows:\n{stack}",
            flush=True,
        )
    except Exception:  # noqa: BLE001, S110 - see docstring
        pass
# One-shot latch: a box where setrlimit is refused (a seccomp profile, an odd
# container runtime) would otherwise run with NO containment and say nothing,
# leaving everyone believing #1110 shipped when it silently did not.
_WARNED_NO_BACKSTOP = [False]
# Same latch shape for the measurement side-channel: a run that silently stops
# measuring would quietly end the #1111 feedback loop with nobody the wiser.
_WARNED_NO_RSS = [False]
_WARNED_NO_RESET = [False]
# A meminfo fallback silently changes which VERDICT an over-budget recording
# gets, so it cannot be quiet either.
_WARNED_MEMINFO = [False]


def admission_reserve_bytes(
    peak_bytes: int, ceiling_bytes: int | None, *, streamed: bool = False
) -> int:
    """What admission must CHARGE for a recording: what its worker is permitted to
    allocate.

    Slack applies to the IN-MEMORY path only. It exists to cover that path's
    projection being a guessed multiple of on-disk bytes that runs about 2x low.
    The streaming path's projection is not a guess of that kind -- it is the flat
    bound the two-pass design gives (one read window plus one channel), already
    generous. Tripling it charged 12 GiB for a recording whose real peak is in the
    hundreds of megabytes, and against this node's ~19 GiB ceiling that admitted
    exactly ONE recording at a time with --jobs 24, i.e. serial conversion of a
    1.5 TB dataset. #1112

    Once #1111's measurements land, STREAM_PEAK_BYTES itself should come down from
    4 GiB, which is where the rest of the concurrency comes back.

    Charging the bare projection instead was the flaw that made the backstop only
    half a containment. Admission bounded the SUM of nominal projections to the
    node ceiling, while each worker was separately allowed `projection * SLACK` --
    so ~12 concurrent streaming recordings on a 62 GB box were collectively
    permitted ~144 GiB before any single soft limit could fire, and the kernel
    OOM reaper still won. Reserving what we permit makes the aggregate bound hold
    by construction, at the cost of proportionally less concurrency for large
    recordings -- which is the point: the previous concurrency was overcommitted.
    """
    reserve = peak_bytes if streamed else int(peak_bytes * MEM_LIMIT_SLACK)
    return min(reserve, ceiling_bytes) if ceiling_bytes else reserve


def reset_peak_rss() -> bool:
    """Reset this process's peak-RSS high-water mark so the NEXT measurement is
    attributable to one recording.

    Pool workers are reused, and both `VmHWM` and `ru_maxrss` are per-PROCESS
    high-water marks, so without this a small recording inherits whatever the
    biggest recording that worker previously handled peaked at -- which would make
    every calibration number an upper envelope rather than a measurement. Writing
    `5` to /proc/self/clear_refs resets it (Linux >= 4.0). Verified on the
    conversion node: 611 MiB -> reset -> 12 MiB.
    """
    try:
        with open("/proc/self/clear_refs", "w") as fh:
            fh.write("5")
        return True
    except OSError:
        return False


class AnonPeak:
    """The highest ``RssAnon`` this process has held since ``reset``, sampled.

    ``VmHWM`` (``peak_rss_bytes``) counts every resident page, and a streamed
    recording's scratch memmap is resident too: file-backed, reclaimable, and already
    counted as available by ``MemAvailable``. Admission reserves anonymous memory, the
    RLIMIT_DATA backstop limits anonymous memory, and the ledger credits anonymous
    memory, so comparing a reserve with ``VmHWM`` called a recording that took 6 GiB
    "under-reserved" at 48 (measured on nm000276, 2026-10-13: ``RssAnon`` held at
    6.2 GiB while ``VmHWM`` rose past 10 GiB with the memmap). The kernel keeps no
    high-water mark for ``RssAnon``, so a thread reads it a few times a second; an
    allocation that lives for less than the interval can be missed, which is why this
    is a measurement to calibrate with and not a bound to enforce."""

    def __init__(self, interval: float = 0.25, proc_root: str = "/proc") -> None:
        self.interval = interval
        self.proc_root = proc_root
        self._lock = threading.Lock()
        self._peak: int | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            now = anon_rss_bytes(os.getpid(), self.proc_root)
            if now is None:
                continue
            with self._lock:
                if self._peak is not None and now > self._peak:
                    self._peak = now

    def reset(self) -> bool:
        """Start measuring afresh from the memory held now; False where it cannot be
        read (off Linux, or a kernel older than 4.5)."""
        now = anon_rss_bytes(os.getpid(), self.proc_root)
        if now is None:
            with self._lock:
                self._peak = None
            return False
        with self._lock:
            self._peak = now
        # A forked worker inherits this object but not its thread.
        if self._thread is None or not self._thread.is_alive():
            self._stop = threading.Event()
            self._thread = threading.Thread(target=self._run, name="anon-peak", daemon=True)
            self._thread.start()
        return True

    def close(self) -> None:
        """Stop sampling. A worker never needs to (it ends with its process); tests do."""
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2)

    def peak(self) -> int | None:
        now = anon_rss_bytes(os.getpid(), self.proc_root)
        with self._lock:
            if self._peak is None:
                return None
            if now is not None and now > self._peak:
                self._peak = now
            return self._peak


_ANON_PEAK = AnonPeak()


def reset_peak_anon() -> bool:
    return _ANON_PEAK.reset()


def peak_anon_bytes() -> int | None:
    return _ANON_PEAK.peak()


def peak_rss_bytes() -> int | None:
    """This process's peak RSS since the last `reset_peak_rss`, or None where that
    cannot be read. Prefers /proc (bytes we can trust the units of); falls back to
    `ru_maxrss`, whose units differ by platform -- KiB on Linux, bytes on macOS."""
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        pass
    try:
        import resource

        maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return maxrss if sys.platform == "darwin" else maxrss * 1024
    except Exception:  # noqa: BLE001 - measurement is never worth failing a run over
        return None


def worker_mem_limit_bytes(peak_bytes: int | None, ceiling_bytes: int | None) -> int | None:
    """Soft RLIMIT_DATA for one recording, or None to leave the limit alone.

    The floor is deliberately NOT charged to admission. It is the minimum
    reservation a small recording's own allocations get; the interpreter and
    library footprint is per-process baseline rather than signal data, measured
    and added on top by `apply_worker_mem_limit` rather than covered here, and
    charging either to admission would stop small EEG recordings packing
    many-wide for no real benefit. The residual overcommit
    is therefore bounded by `jobs * MEM_LIMIT_FLOOR_BYTES` of baseline, not by
    anything that scales with recording size.
    """
    if not peak_bytes:
        return None
    limit = max(admission_reserve_bytes(peak_bytes, ceiling_bytes), MEM_LIMIT_FLOOR_BYTES)
    if ceiling_bytes:
        limit = min(limit, ceiling_bytes)
    return limit


def apply_worker_mem_limit(
    peak_bytes: int | None, ceiling_bytes: int | None, *, reserved: bool = False
) -> None:
    """Cap this process's anonymous memory for the recording it is about to
    convert. Best-effort: a platform without a usable RLIMIT_DATA (macOS counts
    it differently, and it is absent on Windows) simply runs unlimited, exactly
    as before. Never raises -- failing to set a backstop must not fail a
    conversion."""
    # `reserved=True` means the caller already passed a slack-inflated reserve
    # (what admission charged), so only the floor and ceiling still apply --
    # multiplying by slack again would permit 3x what was reserved.
    if reserved and peak_bytes:
        limit = max(peak_bytes, MEM_LIMIT_FLOOR_BYTES)
        if ceiling_bytes:
            limit = min(limit, ceiling_bytes)
    else:
        limit = worker_mem_limit_bytes(peak_bytes, ceiling_bytes)
    if limit is None or not sys.platform.startswith("linux"):
        return
    try:
        import resource

        # The reservation is headroom for THIS recording's allocations; what the
        # process already holds (library buffer pools, the interpreter, a reused
        # worker's retained heap) is measured and added, not charged against it.
        # See the note above `BLAS_THREAD_VARS` for the 2.6 GiB that motivated this.
        # Deliberately NOT re-clamped to `ceiling_bytes` after this addition: the
        # ceiling is stated in resident memory (what admission charges against the
        # node), while the baseline is address space the libraries have mapped
        # and mostly never touch. Clamping the SUM would hand a recording admitted
        # at the ceiling exactly `baseline` less than it was charged -- the bug in
        # miniature. The reserve is what the ceiling caps, and it already was.
        baseline = data_segment_bytes() or 0
        limit += baseline
        # Only the hard limit is read: the soft one is what this call REPLACES.
        hard = resource.getrlimit(resource.RLIMIT_DATA)[1]
        # Keep the hard limit where it is so the next task can raise the soft
        # one back up; a task needing MORE than the previous one must not be
        # capped by it.
        if hard != resource.RLIM_INFINITY and limit > hard:
            limit = hard
        resource.setrlimit(resource.RLIMIT_DATA, (limit, hard))
    except Exception as exc:  # noqa: BLE001 - a missing backstop must not fail a conversion
        if not _WARNED_NO_BACKSTOP[0]:
            _WARNED_NO_BACKSTOP[0] = True
            print(
                f"::warning::RLIMIT_DATA backstop unavailable ({exc}); this run has "
                "NO per-recording out-of-memory containment (#1110)",
                flush=True,
            )

# Multiplier from on-disk bytes to peak RAM on the in-memory path. ONE constant
# for every format was the calibration error behind the 2026-08-22 OOMs: the
# admission controller packed seven BrainVision recordings whose real cost was
# roughly twice what it had reserved, and the node died. The cost genuinely
# differs by reader, so the factor does too.
#
# The default stays 6 for formats nothing has measured yet. BrainVision is 12,
# from its actual chain: MNE preloads at float64 (4x int16 on disk), biosigIO
# copies each channel into a DataFrame (another 4x), pandas periodically
# consolidates that fragmented frame (transiently another 4x -- this is the
# `PerformanceWarning` the log is full of), plus the resample copy. Measured
# peaks are now logged against these projections on every run
# (`::warning::under-projected`), so the next revision of this table is data
# rather than arithmetic. #1111
INMEM_MEM_FACTOR = float(os.environ.get("ZARR_INMEM_MEM_FACTOR", "6"))
INMEM_MEM_FACTOR_BY_EXT = {
    ".vhdr": float(os.environ.get("ZARR_INMEM_MEM_FACTOR_VHDR", "12")),
    # Same retention as on the streaming path (see STREAM_MEM_FACTOR_BY_EXT):
    # a MEF3 recording small enough for the in-memory path still decompresses
    # to float64 several times its RED-compressed on-disk size.
    MEFD_EXT: float(os.environ.get("ZARR_INMEM_MEM_FACTOR_MEFD", "12")),
}

# Formats that take the STREAMING path but do not stay inside its flat bound.
# MEF3 `.mefd` is read through `mne.io.read_raw_mef`, which does ask pymef for one
# time window at a time -- and the worker's resident memory still climbs to the
# whole recording decompressed at float64. Measured on the conversion node on
# 2026-09-03 (on004696, 178-256 channels x 3.3M samples, ~1 GB on disk each):
# VmHWM 7.5-10.3 GiB per worker, and every recording failed its 8 GiB RLIMIT_DATA
# on a single-window allocation after many windows, which is the signature of
# memory retained per window read rather than of one large read. Under the flat
# 4 GiB projection admission packed eight of them and the kernel killed a worker,
# which broke the pool. Until the retention is fixed at the reader, project MEF3
# as an in-memory format: on-disk bytes times this factor (RED compression means
# on-disk understates the float64 footprint several-fold). 12x covers the worst
# measured point (10.3 GiB from ~1 GB) with a small margin and admits three at a
# time against the node's ~46 GiB ceiling instead of eight. Env-overridable so
# the next measurement (the `worst .mefd at Nx its projection` line in every
# run's log) can tighten it without a deploy. #1111
STREAM_MEM_FACTOR_BY_EXT = {
    MEFD_EXT: float(os.environ.get("ZARR_STREAM_MEM_FACTOR_MEFD", "12")),
}


def stream_factor_for(primary_local: str) -> float:
    """On-disk multiplier for a streamed recording whose format is known to retain
    memory beyond the flat streaming bound; 0.0 for every other format, so the
    flat bound stands alone."""
    return STREAM_MEM_FACTOR_BY_EXT.get(lower_ext(primary_local), 0.0)


def projection_factor_hint(primary_local: str, streaming: bool) -> str:
    """Name the format-specific multiplier behind a projection, for the skip
    message, when one applied. A recording skipped as too large under a
    per-format factor is skipped because of that factor as much as because of
    its bytes on disk, so the person reading the index should see which knob
    produced the number rather than a bare "too large". For MEF3 that knob is
    what to retune once the reader stops retaining; for BrainVision the 12x is
    a measured cost (#1111) and the hint is simply where the number came from.

    The knob name is derived by convention (`ZARR_<STREAM|INMEM>_MEM_FACTOR_<EXT>`);
    every per-extension factor above follows it, and a new one must too or the
    hint names a variable that does not exist."""
    ext = lower_ext(primary_local)
    table = STREAM_MEM_FACTOR_BY_EXT if streaming else INMEM_MEM_FACTOR_BY_EXT
    if ext not in table or (streaming and table[ext] <= 0):
        return ""
    knob = f"ZARR_{'STREAM' if streaming else 'INMEM'}_MEM_FACTOR_{ext.lstrip('.').upper()}"
    return f"; projected with the {ext} factor {table[ext]:g}x ({knob})"

# Signal-Space Separation (ADR 0028) runs BEFORE conversion and costs its own peak:
# it needs a fully preloaded float64 `Raw`, which is the anonymous memory RLIMIT_DATA
# counts. The filtered copy then STREAMS, so conversion adds nothing to that peak.
#
# Measured through `apply_sss` itself on the conversion node, across both affected
# datasets rather than at one point -- the BrainVision entry above is the cautionary
# tale for a single-sample factor:
#
#     on006720 sub-197   160 MiB -> 0.78 GiB   5.0x
#     on006720 sub-155   164 MiB -> 0.79 GiB   5.0x
#     on006012 sub-01    438 MiB -> 1.87 GiB   4.4x
#     on006720 sub-155   716 MiB -> 2.95 GiB   4.2x
#
# The ratio FALLS with size as fixed overhead amortizes, so the worst ratio sits where
# the absolute number is trivial and the largest recordings -- the ones that can
# actually exhaust the node -- are the cheapest per byte. 6x clears every observed
# point, and clears the largest by 43%.
#
# Note this deliberately does NOT get `MEM_LIMIT_SLACK`. Admission calls
# `admission_reserve_bytes(..., streamed=True)` for these recordings, since the
# CONVERSION streams, and that suppresses the 3x multiplier. That multiplier exists
# for factors that are "a guessed multiple of on-disk bytes"; this one is measured
# across the range it will be applied to, which is the condition the slack covers.
# Applying both would reserve ~18x on-disk and gut concurrency for no evidence.
#
# Load-bearing rather than an efficiency nicety: `apply_worker_mem_limit` sizes
# RLIMIT_DATA from this projection BEFORE the worker starts, so an under-projection
# does not merely over-schedule the node, it kills the filter mid-run. The streaming
# floor alone (4 GiB) happens to clear the largest recording by under 5%, which is
# coincidence -- that floor was sized for conversion, not for this phase.
MAXSHIELD_MEM_FACTOR = float(os.environ.get("ZARR_MAXSHIELD_MEM_FACTOR", "6"))


def note_measurement(result: dict, projections: dict, measured: dict) -> str | None:
    """Fold one `convert_one` result into ``measured``; return a warning to print
    when the recording cost more than was reserved for it, else None.

    Extracted from ``main``'s reporting closure so the bookkeeping that feeds
    calibration is testable without a live conversion. `rss is None` is checked
    explicitly rather than by truthiness: None means "not measured" (or measured
    untrustworthily) and must be dropped, while a genuine 0 would be a real
    reading and must not be silently conflated with it.
    """
    # Anonymous memory when it was measured: that is what a reserve is, and the
    # resident figure also counts the scratch memmap's file-backed pages.
    anon = result.get("peak_anon")
    rss = anon if anon is not None else result.get("peak_rss")
    primary = result.get("primary")
    proj = projections.get(primary)
    if rss is None or not proj:
        return None
    measured[primary] = rss
    # Warn at the CONTAINMENT boundary, not the bare projection. Admission charges
    # `projection * MEM_LIMIT_SLACK`, so a recording over its bare projection is
    # still comfortably inside what was reserved for it and endangered nothing --
    # warning there would put a scary line against a large share of every run's
    # recordings, in a log already too big to read, and drown the real cases.
    # "reserved" means the slack-inflated charge, matching admission's vocabulary.
    reserved = proj * MEM_LIMIT_SLACK
    if rss > reserved:
        what = (
            f"{rss / 1024**3:.1f} GiB of anonymous memory"
            if anon is not None else f"{rss / 1024**3:.1f} GiB"
        )
        return (
            f"::warning::under-reserved {primary}: needed {what}, "
            f"reserved {reserved / 1024**3:.1f} GiB ({rss / proj:.1f}x its "
            f"projection) -- see INMEM_MEM_FACTOR_BY_EXT (#1111)"
        )
    return None


def calibration_summary(
    measured: dict, projections: dict, streamed: set[str]
) -> list[dict]:
    """Per-extension measured-vs-projected peak RAM, worst case first.

    This is the feedback loop that stops `INMEM_MEM_FACTOR_BY_EXT` being folklore:
    every run reports what each format actually cost against what was reserved for
    it, so the next revision of that table is measurement. `suggested_factor` is
    the multiplier that would have covered the worst recording seen here; it is
    advisory output, never applied automatically -- one pathological recording
    should not silently re-tune the whole archive.
    """
    # Bucket by (extension, which path it took). A streamed recording's projection
    # is unrelated to its on-disk size, so mixing it in with in-memory recordings
    # of the same extension yields a "suggested factor" that looks like a blow-up
    # multiplier but is not one. Only the in-memory path has a factor to suggest.
    #
    # `streamed` is passed in rather than re-derived from `proj == STREAM_PEAK_BYTES`.
    # That test held only while a streamed projection was always the flat constant;
    # `streaming_peak_bytes` now raises it to the per-channel floor for a few-channel,
    # long, high-rate recording (ADR 0030's EMG / single-contact iEEG case), and such
    # a recording would fall through to "inmem" and be handed a bogus suggested_factor
    # -- corrupting the very feedback loop this function exists to provide.
    buckets: dict[tuple[str, str], list[tuple[int, int]]] = {}
    for path, rss in measured.items():
        proj = projections.get(path)
        if proj:
            kind = "stream" if path in streamed else "inmem"
            buckets.setdefault((lower_ext(path) or "(dir)", kind), []).append((rss, proj))
    rows = []
    for (ext, kind), pairs in buckets.items():
        # max_peak_bytes must come from the SAME recording as max_ratio, or the
        # log reads "worst .set at 4.0x its projection (peak 105 KB)" while the 4x
        # recording actually peaked at 400 bytes -- misleading exactly the person
        # trying to retune the table.
        worst_rss, worst_proj = max(pairs, key=lambda x: x[0] / x[1])
        row = {
            "ext": ext,
            "path": kind,
            "n": len(pairs),
            "max_ratio": round(worst_rss / worst_proj, 2),
            "max_peak_bytes": worst_rss,
            "max_peak_projection_bytes": worst_proj,
        }
        if kind == "inmem":
            row["suggested_factor"] = round(
                inmem_factor_for(f"x{ext}") * worst_rss / worst_proj, 1
            )
        rows.append(row)
    return sorted(rows, key=lambda r: r["max_ratio"], reverse=True)


def inmem_factor_for(primary_local: str) -> float:
    """In-memory blow-up multiplier for this recording's format."""
    return INMEM_MEM_FACTOR_BY_EXT.get(lower_ext(primary_local), INMEM_MEM_FACTOR)


class RecordingTooLarge(Exception):
    """A recording whose projected peak RAM exceeds this run's per-recording
    budget. Carries `.code` so convert_one surfaces it as a DETERMINISTIC skip
    (recorded in the index, no infra retry) -- exactly like a biosigIO data
    failure -- instead of OOM-crashing the worker. #909"""

    code = "recording_too_large"


def is_memory_exhaustion(exc: BaseException) -> bool:
    """Whether `exc` is the RLIMIT_DATA backstop (or the allocator) saying no.

    `MemoryError` is the obvious shape. Two others come from the same cause and
    used to fall through as uncoded infra failures, which breaks the worker pool
    and re-runs the recording one at a time to "find the culprit": a thread
    stack is a private writable mapping, so at the limit zarr's codec pipeline
    dies with `RuntimeError: can't start new thread` (on004696, 2026-09-03), and
    an `mmap` refused at the limit raises `OSError(ENOMEM)`.
    """
    if isinstance(exc, MemoryError):
        return True
    # CPython raises this one fixed string for ANY pthread_create failure and
    # attaches no errno, so EAGAIN (a thread-count limit such as RLIMIT_NPROC)
    # is indistinguishable here from ENOMEM. Nothing in this driver tightens a
    # thread limit, only RLIMIT_DATA, so at the limit this is the backstop; if it
    # ever recurs on a node where memory is NOT the story, this is the line that
    # turned a novel infra failure into a retryable memory verdict.
    if isinstance(exc, RuntimeError) and "can't start new thread" in str(exc):
        return True
    return isinstance(exc, OSError) and exc.errno == errno.ENOMEM


class RecordingMemoryExceeded(Exception):
    """A recording hit its RLIMIT_DATA backstop (or the allocator failed) WHILE
    converting. Deliberately distinct from `RecordingTooLarge`, which is a static
    preflight verdict on the recording alone and is therefore a permanent property
    of the data.

    A runtime out-of-memory is NOT: the same recording can OOM today under sibling
    contention and convert fine tomorrow running alone. So this code is surfaced in
    the index (the viewer can say why there is no store) but is listed in
    `RETRYABLE_CODES`, which keeps it OUT of the `deterministic` verdict -- otherwise
    a dataset whose recordings all OOM during one busy hour would be marked
    terminal by hallu-zarr.sh and never retried. #1110."""

    code = "recording_memory_exceeded"


class MaxShieldUncalibrated(Exception):
    """A MEG recording carrying raw Internal Active Shielding (MaxShield) data for
    which the site-specific calibration pair does not resolve.

    MEGIN's position, which MNE enforces by refusing to read these files at all, is
    that raw Internal Active Shielding data is not fit for analysis until the
    shielding's effect has been modeled out. ADR 0028 decides we correct it with
    Signal-Space Separation and serve the result -- but ONLY with the recording's own
    fine-calibration and cross-talk files, because uncalibrated Signal-Space
    Separation is a weaker correction whose quality varies by site and hardware, and
    serving it under the same label would make the two indistinguishable.

    So this is the honest decline: a permanent property of what the dataset ships,
    NOT in `RETRYABLE_CODES`. It exists to replace the opaque `file_read_error` that
    gave a user no way to tell an unreadable file from a policy decision."""

    code = "maxshield_uncalibrated"


class MaxShieldProbeFailed(Exception):
    """`is_maxshield_fif`'s header-only probe could not read `path` at all.

    Before #1139 the probe caught every exception itself, printed a
    `::warning::`, and returned False -- which routed the recording down the
    NORMAL conversion path. For a file the probe could not even open, that
    path failed anyway, but as an uncoded (or differently-coded, biosigIO's
    own) `file_read_error`: nothing on the public index distinguished "the
    MaxShield probe itself could not read this FIF" from any other read
    failure, so the operator lost the one clue that would have named the
    actual failure surface.

    The probe runs on `primary_local`, which `materialize_local` /
    `materialize_recording` has already fetched successfully by the time
    `convert_one` calls it -- so a header read failing here is a property of
    what the file itself contains (truncated, corrupt, a missing split
    member MNE could not resolve), not of this run. Same reasoning ADR 0028
    already applies to `MaxShieldUncalibrated`: NOT in `RETRYABLE_CODES`,
    because retrying cannot make a corrupt header become readable."""

    code = "maxshield_probe_failed"


class CompanionMissing(Exception):
    """A recording's header says its samples live in a companion file, and the
    dataset tree at the pinned commit does not hold that file (#1801).

    Judged against the git tree, not against the reader's error: a companion the
    tree tracks but storage lacks fails earlier as `annex_object_missing`, which
    stays the storage-state code. Here the tree itself has no such file, so the
    only repair is a new commit, and retrying the same commit cannot change the
    answer. NOT in `RETRYABLE_CODES`, and not in `STORAGE_STATE_CODES` either: a
    run that converts nothing and fails only with this is a property of the
    DATASET, so it is terminal like `corrupt_or_truncated`. The message names the
    missing file by its BIDS path, which `failure_detail` leaves alone."""

    code = "companion_missing"


# The other two codes #1801 adds are only ever chosen by `failure_verdict`, which
# reads a reader's refusal; neither has an exception class of its own. Same
# standing as `CompanionMissing`: data failures, outside both code sets below.
# A FIF whose next split part is not in the tree (MNE's refusal had been reported
# as `maxshield_probe_failed`, which it is not):
SPLIT_PART_MISSING = "split_part_missing"
# An EEGLAB `.set` that stores trials, not one continuous recording (#1214). Not
# `not_continuous`, whose reason calls the file a derivative:
EPOCHED_RECORDING = "epoched_recording"


# Coded failures that are nevertheless NOT a permanent property of the data, so a
# run consisting entirely of them must stay retryable. See `deterministic` in main().
# `maxshield_uncalibrated` is deliberately absent: the calibration pair is either
# shipped with the dataset or it is not, and retrying cannot change that.
# `maxshield_probe_failed` is absent for the same reason: the probe runs on a
# local file this same attempt already fetched successfully, so a header it
# cannot read is a property of that file's content, not of node conditions.
RETRYABLE_CODES = frozenset({RecordingMemoryExceeded.code})

# Typed codes that are permanent for the RECORDING but say nothing permanent
# about the DATASET: they describe what storage held at the moment of the run.
# Unlike `RETRYABLE_CODES` they stay typed failures in the index (the viewer is
# told why, the rest of the dataset still serves, the recording is not retried
# on its own), but a run whose failures are ALL of these codes is not
# `deterministic`: see `dataset_failure_is_deterministic`. A literal rather than
# `AnnexObjectMissing.code` only because the class is defined further down; a
# test pins the two together.
STORAGE_STATE_CODES = frozenset({"annex_object_missing"})


def memory_failure_result(
    primary: str, exc: BaseException, peak_rss: int | None = None,
    peak_anon: int | None = None,
) -> dict:
    """The `convert_one` result for a recording that ran out of memory mid-convert.

    A function rather than an inline dict so tests exercise the SAME construction
    production uses. Inlined, the obvious test reimplements the mapping and passes
    even if the handler is deleted or folded into the generic `except Exception`
    below it -- which would silently downgrade this to an uncoded infra failure
    that retries forever.
    """
    return {
        "ok": False,
        "primary": primary,
        "error": f"exceeded its memory budget while converting: {exc}",
        "code": RecordingMemoryExceeded.code,
        "detail": failure_detail(exc),
        "peak_rss": peak_rss,
        "peak_anon": peak_anon,
    }


def count_infra_failures(failures: list, failure_entries: list) -> int:
    """How many of ``failures`` are infrastructure rather than a property of the
    data. Drives ``deterministic``, which the shell driver turns into a TERMINAL,
    never-retried verdict for the whole dataset when every failure is data-shaped.

    An uncoded failure (crashed worker, transient S3) is infra. A coded one
    normally is not -- except the codes in ``RETRYABLE_CODES``, which are surfaced
    to the viewer but still depend on conditions rather than on the recording, so
    they must not let one bad hour bury a dataset permanently. #1110.

    Since index v3 both of those land in the index's ``pending`` list rather than
    in ``failure_entries``, so the subtraction already counts them and the
    ``retryable_coded`` term is normally zero. It stays because the term is what
    makes the rule TRUE rather than incidentally right: if a retryable code is
    ever surfaced as a typed failure again, the verdict must not silently flip to
    terminal. This number is the infra failures of this run itself; recordings
    deferred for scratch space are pending but are not counted.
    """
    retryable_coded = sum(1 for e in failure_entries if e.get("code") in RETRYABLE_CODES)
    return len(failures) - len(failure_entries) + retryable_coded


def dataset_failure_is_deterministic(failures: list, failure_entries: list) -> bool:
    """Whether this run's failures are a permanent property of the DATASET, which
    `hallu-zarr.sh` turns into a terminal `data_failed` on a run that converted
    nothing (no retry, #774).

    True only when there is a failure, none of them is infra
    (`count_infra_failures` is zero), and at least one is a typed code that is
    NOT in `STORAGE_STATE_CODES`. The last term is the one that matters for
    `annex_object_missing`: that code is permanent for its recording, but when
    EVERY failure is a missing object the likeliest cause is an upload or an
    import whose objects have not all landed yet, and burying the dataset as
    `data_failed` on the first run would need a human to notice and requeue it.
    So such a run takes the queue's ordinary bounded backoff and ends `failed`
    if the objects never arrive.

    A mix is still deterministic when anything in it is a genuine data failure:
    a recording biosigIO cannot read will fail identically on every retry, and
    retrying the whole dataset for the sake of the missing objects would only
    delay the same verdict. A partially successful run is unaffected: it exits
    0 and the dataset is `done` whatever this returns.
    """
    if not failures or count_infra_failures(failures, failure_entries):
        return False
    return any(e.get("code") not in STORAGE_STATE_CODES for e in failure_entries)


def annex_missing_summary(missing: list[tuple[str, str | None]]) -> dict:
    """The callback's account of recordings refused as `annex_object_missing`:
    how many, and the first by path (sorted, so a pool's completion order does
    not decide which one the operator is shown) with the annex key storage
    lacks. `hallu-zarr.sh` names that key in the queue's `last_error`."""
    first = min(missing, default=(None, None))
    return {
        "annex_missing_count": len(missing),
        "annex_missing_first_path": first[0],
        "annex_missing_first_key": first[1],
    }


def failed_callback_body(
    *,
    dataset_id: str,
    head: str,
    prior: dict | None,
    discovered: list[str],
    failures: list[str],
    failure_entries: list,
    annex_missing: list[tuple[str, str | None]],
    pool_breaks: int,
    pending_entries: list[dict],
    deferred: dict[str, str],
    provenance_fetch_failed: bool,
    events_row_count: int | None,
    events_upload_failed: bool,
    events_stores_without_rows: int,
    error: str | None,
) -> dict:
    """The `status: "failed"` callback body for a run that publishes nothing.

    One builder for every such exit once the dataset has been measured, so they
    cannot drift apart: `main`'s `write_failed_callback`, and the refusal to
    convert on a biosigIO that cannot leave subject information out, which
    happens before any recording is attempted (or deferred). Every field is
    required and has no default, so a caller that leaves one out fails loudly
    instead of reporting a zero it never measured. The one failed body that
    does not come from here is the refusal of an invalid scratch setting at the
    top of `main`: it runs before the repository is read, so it has none of
    these numbers to report and reports none.

    `deferred` maps each recording the scratch gate would not admit to the
    `last_error` the index carries for it. Those recordings are pending and
    were never attempted, and they are not in `pending_entries` (`merge_index`
    derives their entries from `deferred`), so both counts add them.
    """
    return {
        "dataset_id": dataset_id,
        "status": "failed",
        "store_count": int((prior or {}).get("store_count", 0) or 0),
        "commit": head,
        "converted": [],
        "removed": [],
        "errors": len(failures),
        "failed": failures,
        "failure_count": len(failure_entries),
        "data_failures": failure_entries,
        "deterministic": dataset_failure_is_deterministic(failures, failure_entries),
        **annex_missing_summary(annex_missing),
        "pool_breaks": pool_breaks,
        # Coverage (#1197). Reported even here, where the index was NOT
        # rewritten: the queue's pending-driven requeue needs to know a total
        # failure left recordings outstanding, and `discovered_count` is what
        # makes "2 of 43" sayable at all.
        "pending_count": len(pending_entries) + len(deferred),
        "discovered_count": len(discovered),
        "not_attempted_count": len(deferred) + sum(
            1 for e in pending_entries if e.get("reason") == "not_attempted"
        ),
        "provenance_fetch_failed": provenance_fetch_failed,
        # The events file, on the failure path too (#1060). A refused index can
        # still have been preceded by a successful events.parquet upload, and an
        # operator reading only the callback would otherwise have no idea an
        # object on S3 was replaced by a run that then published nothing.
        "events_row_count": events_row_count,
        "events_upload_failed": events_upload_failed,
        "events_stores_without_rows": events_stores_without_rows,
        # What went wrong, when it was the PRODUCER or the node rather than the
        # recordings: a schema violation, an unbalanced index or a biosigIO that
        # cannot exclude subject information has no per-recording failure to
        # point at, so without this the callback would say "failed" and name no
        # cause.
        **({"error": error} if error else {}),
    }


class ChannelCountMismatch(Exception):
    """The converted store carries fewer channels than the recording file's own
    header declares, with or without a channels.tsv; or fewer than its BIDS
    `_channels.tsv` declares while the header could not be read. Publishing it
    would serve a silently unfaithful copy (the failure mode behind
    nemarDatasets/on002718#1, where biosigio#110 truncated 74-channel EEGLAB
    files to one channel, and behind nm000110, where biosigio before 1.2.9
    let a repeated EDF label overwrite a channel). Typed so
    the gate is a DETERMINISTIC data failure surfaced in the index and the
    unfaithful store is never uploaded.

    Policy: better NO new store than a wrong one. The gate runs before this
    recording's sync, so the refused store is never uploaded, on the
    incremental path and under ``--clean`` alike: ``--clean`` reconciles and
    does NOT wipe the prefix (ADR 0023; only ``--wipe`` erases it), and a
    recording still at HEAD is never an orphan. So a refused recording KEEPS
    its previously published store objects until a good re-conversion's
    ``sync --delete`` overwrites them; this run's index lists the recording
    under ``failures`` rather than ``stores`` (``merge_index`` drops the entry
    of a newly failed path). Being deterministic, a gated recording does NOT
    self-retry: after a converter fix, re-run the dataset explicitly
    (hallu-zarr.sh --dataset <id>, or a queue requeue)."""

    code = "channel_count_mismatch"


# Pass 2 of the streaming exporter does, per channel,
# `x = np.asarray(mm[i], dtype=np.float64)` -- it materializes ONE WHOLE CHANNEL
# at native rate as anonymous float64. That term is `n_samples * 8` bytes: it
# scales with duration and sample rate and is INDEPENDENT of channel count, so
# STREAM_PEAK_BYTES is not the guaranteed bound it looks like. A many-channel
# recording splits its bytes across many short channels and stays far under it; a
# FEW-channel, long, high-rate recording (EMG, single-contact iEEG) can have one
# channel that alone approaches or exceeds it.
#
# So project the per-channel term explicitly when the channel count is known.
# `size_bytes / n_channels` is one channel's on-disk bytes; x4 takes int16 to
# float64, and the multiplier below covers the resampled copy and resample_poly's
# scratch alongside it.
STREAM_CHANNEL_EXPANSION = float(os.environ.get("ZARR_STREAM_CHANNEL_EXPANSION", "12"))
# The 12 above is `8 / 2 * 3`: a float64 sample is four int16 samples, and three such
# channels can be live at once (the channel, and the temporaries of the int16
# quantization). It is right for a recording stored in two bytes per sample, which is
# what admission has to assume when it cannot tell. A recording stored in four bytes per
# sample (float32 BrainVision, which is what the 100 to 145 GiB iEEG of nm000276 is)
# holds half as many samples per byte, so the same channel needs half the float64. This
# is how many float64 channels to provision for in that case: three measured, plus a third
# of margin. The result is never above STREAM_CHANNEL_EXPANSION.
STREAM_CHANNEL_COPIES = float(os.environ.get("ZARR_STREAM_CHANNEL_COPIES", "4"))


def streaming_peak_bytes(
    size_bytes: int, n_channels: int | None, sample_bytes: int | None = None
) -> int:
    """Projected peak for the streaming path: the flat floor, raised when one
    channel alone would exceed it. Falls back to the flat value when the channel
    count is unknown.

    ``sample_bytes`` is the width the recording is stored at when that is known
    (``sample_bytes_from_sidecar``); without it the narrowest width is assumed, which
    is the larger projection."""
    if not n_channels or n_channels <= 0:
        return STREAM_PEAK_BYTES
    expansion = STREAM_CHANNEL_EXPANSION
    if sample_bytes and sample_bytes > 0:
        expansion = min(expansion, 8.0 / sample_bytes * STREAM_CHANNEL_COPIES)
    per_channel = int(size_bytes / n_channels * expansion)
    return max(STREAM_PEAK_BYTES, per_channel)


def projected_peak_bytes(
    primary_local: str,
    size_bytes: int,
    n_channels: int | None = None,
    maxshield: bool = False,
    sample_bytes: int | None = None,
) -> int:
    """Estimated peak RAM to convert this recording: the streaming path's
    channel-aware bound, or the float64 blow-up for the in-memory path. Drives the
    skip guard (#909).

    `maxshield` adds the Signal-Space Separation phase (ADR 0028), which runs before
    conversion and peaks independently of it. The two phases are sequential and the
    `Raw` is released between them, so the recording's peak is the LARGER of the two
    rather than their sum.
    """
    if should_stream(primary_local, size_bytes):
        conversion = max(
            streaming_peak_bytes(size_bytes, n_channels, sample_bytes),
            int(size_bytes * stream_factor_for(primary_local)),
        )
    else:
        conversion = int(size_bytes * inmem_factor_for(primary_local))
    if not maxshield:
        return conversion
    return max(conversion, int(size_bytes * MAXSHIELD_MEM_FACTOR))


def usable_ram_bytes(meminfo_path: str = "/proc/meminfo") -> int:
    """Convertible RAM: MemTotal (Linux /proc/meminfo) minus a headroom fraction.
    A conservative fallback keeps the guard active off-Linux / in tests."""
    frac = float(os.environ.get("ZARR_MEM_HEADROOM_FRAC", "0.8"))
    total: int | None = None
    # MemAvailable, not MemTotal. The conversion node is SHARED -- other tenants,
    # other jobs, and the page cache backing this run's own scratch all live in the
    # same RAM -- so MemTotal describes a machine we do not have to ourselves and
    # consistently overstates what we may allocate. MemAvailable is the kernel's own
    # estimate of what is obtainable without swapping, which is the number admission
    # actually needs. Falls back to MemTotal on a kernel too old to publish it
    # (< 3.14), and to the env/default below off-Linux. #1111
    def _meminfo() -> dict:
        fields = {}
        with open(meminfo_path) as fh:
            for line in fh:
                key = line.split(":", 1)[0]
                if key in ("MemAvailable", "MemTotal"):
                    fields[key] = int(line.split()[1]) * 1024  # kB -> bytes
        return fields

    try:
        # Median of three samples. MemAvailable is a live number on a shared box,
        # and this is read ONCE for a run that lasts hours -- so a single unlucky
        # instant (a neighboring job's page-cache spike) would otherwise set an
        # absurdly low ceiling for everything that follows. `is not None` rather
        # than `or`: a genuine 0 must not silently fall through to MemTotal.
        samples = []
        for i in range(3):
            fields = _meminfo()
            avail = fields.get("MemAvailable")
            samples.append(avail if avail is not None else fields.get("MemTotal"))
            if i < 2:
                time.sleep(0.05)
        samples = [x for x in samples if x is not None]
        total = sorted(samples)[len(samples) // 2] if samples else None
    except OSError:
        total = None
    if total is None:
        if not _WARNED_MEMINFO[0]:
            _WARNED_MEMINFO[0] = True
            print(
                f"::warning::could not read {meminfo_path}; falling back to a fixed "
                "node-RAM figure. Admission is no longer sized to this machine, and "
                "the temporary-vs-permanent verdict split degrades to always-temporary "
                "(#1111)",
                flush=True,
            )
        total = int(os.environ.get("ZARR_NODE_RAM_BYTES", str(32 * 1024**3)))
    # Never fall below what one streaming recording needs, with room for a second.
    # Without a floor, a momentarily-loaded node yields a ceiling under
    # STREAM_PEAK_BYTES, at which point NOTHING is admissible and every recording
    # is skipped as "too large" -- a node-load artifact recorded as a property of
    # the data. #1111
    return max(int(total * frac), CEILING_FLOOR_BYTES)


def hardware_ceiling_bytes(meminfo_path: str = "/proc/meminfo") -> int:
    """The most memory this NODE could ever offer one recording: MemTotal, not
    MemAvailable.

    This is what separates a permanent verdict from a temporary one. Since the
    admission ceiling became MemAvailable (#1111) it is a live sample on a shared
    box, so "exceeds the budget" stopped meaning "too big to ever convert" and
    started meaning "too big right now" -- and the two must not share a verdict,
    because one is terminal and the other must retry.
    """
    frac = float(os.environ.get("ZARR_MEM_HEADROOM_FRAC", "0.8"))
    try:
        with open(meminfo_path) as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return max(int(int(line.split()[1]) * 1024 * frac), CEILING_FLOOR_BYTES)
    except OSError:
        pass
    return max(int(int(os.environ.get("ZARR_NODE_RAM_BYTES", str(32 * 1024**3))) * frac),
               CEILING_FLOOR_BYTES)


def mem_available_bytes(meminfo_path: str = "/proc/meminfo") -> int | None:
    """One `MemAvailable` sample, or None where it cannot be read (off Linux, or
    a kernel older than 3.14). Unlike `usable_ram_bytes` this is not smoothed:
    `live_admission_ceiling` reads it at every admission decision, so a single
    unlucky instant costs one decision, not a whole run."""
    try:
        with open(meminfo_path) as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def anon_rss_bytes(pid: int, proc_root: str = "/proc") -> int | None:
    """`RssAnon` of process `pid`: the memory it has actually taken from the node
    that only swap could give back. None when the process is gone or the field
    is not published (off Linux, or a kernel older than 4.5)."""
    try:
        with open(os.path.join(proc_root, str(pid), "status"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("RssAnon:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def _tracked_call(worker, primary: str, reserve: int, track_dir: str) -> dict:
    """Run ``worker(primary, reserve)`` in a pool worker, recording while it runs
    what `live_admission_ceiling` needs: this process's pid, the reserve it was
    admitted with, and its `RssAnon` at the start. What the recording has taken
    since is then `RssAnon` now minus that, readable from the parent without
    asking the worker anything. Module-level so it pickles. #1483"""
    path = os.path.join(track_dir, f"{os.getpid()}.json")
    start = anon_rss_bytes(os.getpid())
    try:
        with open(path, "w") as fh:
            # `start` lets the ledger tell this worker from a later process that is given
            # its pid, when it decides whether a killed driver's workers are still running.
            json.dump(
                {
                    "reserve": int(reserve),
                    "rss_anon_start": start,
                    "start": process_start_ticks(os.getpid()),
                },
                fh,
            )
    except OSError:
        pass  # untracked: the parent then counts the whole reserve as outstanding
    try:
        return worker(primary, reserve)
    finally:
        with contextlib.suppress(OSError):
            os.remove(path)


def tracked_taken_bytes(
    track_dir: str | None, in_flight_reserve: int, proc_root: str = "/proc"
) -> int:
    """How much of ``in_flight_reserve`` bytes of RAM the workers recorded in
    ``track_dir`` have already taken: for each, its ``RssAnon`` now minus what it
    started with, no more than its own reserve, and no more in all than is in flight
    (a record can outlive its recording by an instant). A worker that is gone, or
    whose usage cannot be read, has taken nothing as far as this can tell, so its
    whole reserve stays owed. Shared by a driver's own ceiling and by the ledger, which
    asks it of its peers' directories."""
    if in_flight_reserve <= 0 or not track_dir:
        return 0
    taken = 0
    try:
        names = os.listdir(track_dir)
    except OSError:
        names = []
    for name in names:
        pid_text, _, ext = name.partition(".")
        if ext != "json" or not pid_text.isdigit():
            continue
        try:
            with open(os.path.join(track_dir, name)) as fh:
                rec = json.load(fh)
            reserve = int(rec["reserve"])
            start = rec.get("rss_anon_start")
        except (OSError, ValueError, KeyError, TypeError):
            continue
        now = anon_rss_bytes(int(pid_text), proc_root)
        if now is None or not isinstance(start, int):
            continue
        taken += min(reserve, max(0, now - start))
    return min(taken, in_flight_reserve)


def live_admission_ceiling(
    static_ceiling: int,
    hard_ceiling: int | None,
    running_peak: int,
    track_dir: str | None,
    *,
    meminfo_path: str = "/proc/meminfo",
    proc_root: str = "/proc",
) -> int:
    """The RAM ceiling admission packs in-flight reserves under, NOW (#1483).

    The ceiling used to be sampled once, at the start of a run that can last
    hours, on a node other tenants share: when they grew, admission kept packing
    against memory that was no longer there, and when they shrank it kept a busy
    hour's limit for the rest of the run. This reads `MemAvailable` again and
    asks how much of it is already spoken for by recordings in flight.

    `MemAvailable` has already been reduced by what those recordings have taken,
    so charging their whole reserves against it again would count that twice.
    What is still owed is each reserve minus what its recording has actually
    taken (`_tracked_call` records the starting point). A recording not yet
    tracked, or whose usage cannot be read, is charged its whole reserve. So:

        ceiling = MemAvailable * headroom + sum(min(reserve, taken))

    admits a new recording when ``running_peak + its reserve <= ceiling``, never
    above ``hard_ceiling``. Where `MemAvailable` cannot be read (off Linux), the
    static ceiling applies unchanged. Taken memory is `RssAnon`, not RSS: the
    streaming path's scratch memmaps are file-backed page cache, which
    `MemAvailable` already counts as reclaimable.
    """
    avail = mem_available_bytes(meminfo_path)
    if avail is None:
        return static_ceiling
    frac = float(os.environ.get("ZARR_MEM_HEADROOM_FRAC", "0.8"))
    taken = tracked_taken_bytes(track_dir, running_peak, proc_root)
    ceiling = int(avail * frac) + taken
    if hard_ceiling:
        ceiling = min(ceiling, hard_ceiling)
    return max(0, ceiling)


def per_recording_ceiling_bytes() -> int:
    """Largest projected peak a SINGLE recording may use: the whole usable node.
    Admission control in ``main`` keeps the SUM of concurrently-converting
    recordings within this, so a recording is #909-skipped only when it can't fit
    the node even alone -- independent of ``--jobs`` (unlike the old RAM/jobs
    split, where raising jobs shrank the budget and skipped more recordings).
    Explicit override still wins. #909"""
    override = os.environ.get("ZARR_REC_MEM_BUDGET_BYTES")
    if override:
        return int(override)
    return usable_ram_bytes()


# --- Scratch-disk admission -----------------------------------------------------
# RAM was the only resource admission charged, and the streaming path's scratch is
# the one that ran out. A streaming recording first lands whole on scratch (the raw
# blob), then becomes a channel-major float32 memmap, then an int16 memmap plus the
# view pyramid; the memmap and the outputs coexist with the raw copy at the end of
# pass 2, which is the recording's peak. Measured on nm000276 sub-03 (a float32
# BrainVision recording of 114,458,234,880 bytes) just before the node filled up:
#
#     raw 1.00x + float32 memmap 1.00x + int16 memmap 0.50x + views 0.33x = 2.83x
#
# so a 177 GiB recording needs ~500 GiB at once against ~535 GiB of free scratch, and
# 24 workers admitted by RAM alone (~4.7 GiB each) had no chance. A recording stored
# in fewer bytes per sample (int16 BrainVision, EDF) expands more, so this factor is
# the float32 figure plus margin, not a bound; a miss costs one retryable ENOSPC,
# which `reclaim_recording_scratch` now keeps from cascading.
def _scratch_setting(name: str, default: float, *, minimum: float) -> float:
    """One scratch tunable from the environment, refused loudly when it cannot mean
    what an operator intended. A factor of 0 or below would charge every recording
    nothing and quietly switch the gate off, ``nan`` raised ValueError deep inside
    ``main``, ``inf`` overflowed ``int()``, and a negative headroom inflated the
    budget; each is a crontab typo that should stop the run, naming the
    variable, not surface hours later as a full disk. The import records the message and
    keeps the default; `main` is what refuses to run (see SCRATCH_SETTING_ERRORS)."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name}={raw!r} is not a number") from None
    if not math.isfinite(value) or value < minimum:
        raise ValueError(f"{name}={raw!r} must be a finite number of at least {minimum:g}")
    return value


# A bad value must not take down the import: every dataset run (and `patch_duration`)
# loads this module, and an exception here would kill each before it could write a
# callback, so nothing would say why. The defaults stand and the messages wait here
# for `main()`, which refuses to run and reports them through the callback.
SCRATCH_SETTING_ERRORS: list[str] = list(LEDGER_SETTING_ERRORS)


def _scratch_setting_or_default(name: str, default: float, *, minimum: float) -> float:
    try:
        return _scratch_setting(name, default, minimum=minimum)
    except ValueError as exc:
        SCRATCH_SETTING_ERRORS.append(str(exc))
        return default


SCRATCH_STREAM_FACTOR = _scratch_setting_or_default(
    "ZARR_SCRATCH_STREAM_FACTOR", 3.0, minimum=1.0
)
# In-memory path: the raw copy plus the store it writes. Those recordings are small
# by construction (the streaming threshold is 256 MiB) or have no streaming reader.
SCRATCH_INMEM_FACTOR = _scratch_setting_or_default(
    "ZARR_SCRATCH_INMEM_FACTOR", 2.0, minimum=1.0
)
# Left unspoken for: other tenants share the volume and grow while a run lasts hours,
# and `aws s3 cp` keeps partial files beside the chunks it is assembling.
SCRATCH_HEADROOM_BYTES = int(
    _scratch_setting_or_default("ZARR_SCRATCH_HEADROOM_BYTES", 10 * 1024**3, minimum=0)
)
# What a recording whose size cannot be read is charged. Its pointer carries no
# `-s` field (or there is no pointer), so the factor would multiply nothing and the
# recording would be admitted for free, even at a budget of zero. A floor rather
# than a refusal: most such recordings are small, and one that is not fails with a
# retryable ENOSPC like any other miss.
SCRATCH_UNKNOWN_SIZE_BYTES = int(
    _scratch_setting_or_default("ZARR_SCRATCH_UNKNOWN_SIZE_BYTES", 16 * 1024**3, minimum=1)
)
# How many times admission looks at the volume again, `ADMISSION_RECHECK_SECONDS`
# apart, before it concludes that nothing left can fit and defers the rest of the
# queue. One statvfs sample can land in another tenant's transient spike, and with
# nothing in flight the whole remaining queue would be deferred on it.
SCRATCH_DEFER_RESAMPLES = int(
    _scratch_setting_or_default("ZARR_SCRATCH_DEFER_RESAMPLES", 3, minimum=0)
)
# One line per deferred recording is the point, but a dataset of 25k recordings on a
# node with no room would write 25k of them every tick; the index names them all.
SCRATCH_DEFER_LOG_LINES = 200


def scratch_peak_bytes(primary: str, size_bytes: int, size_known: bool = True) -> int:
    """Projected peak scratch for one recording: its on-disk bytes times the
    factor for the path it will take. Projected from git-annex pointers like the
    RAM peak, so it costs no download.

    A size that could not be read (``size_known`` false, or not positive) is
    charged at least ``SCRATCH_UNKNOWN_SIZE_BYTES``: a charge of zero is admitted
    unconditionally, which is the one input that defeats the gate."""
    factor = SCRATCH_STREAM_FACTOR if should_stream(primary, size_bytes) else SCRATCH_INMEM_FACTOR
    charge = int(max(0, size_bytes) * factor)
    if not size_known or size_bytes <= 0:
        return max(charge, SCRATCH_UNKNOWN_SIZE_BYTES)
    return charge


def scratch_budget_bytes(free: int, held: int, headroom: int) -> int:
    """Bytes this run may hold on scratch in total: what is free, plus what the run's
    in-flight recordings already hold, minus headroom, never below zero.

    What is free already excludes what those recordings have written, so charging
    their whole projected peaks against it would count them twice. Adding ``held``
    back gives the total the run could occupy if none of its own were on disk,
    which is what the SUM of in-flight projected peaks plus the candidate's is
    compared with."""
    return max(0, free + held - headroom)


def held_scratch_bytes(run_root: str, primaries) -> int:
    """Disk blocks the given in-flight recordings hold under ``run_root``.

    Their own `work/`, store and memmap directories only, never the whole run tree:
    debris a killed worker left (or a failed delete left behind) is not memory the
    run can hand back, and counting it as held would add it to the budget as if it
    were about to be freed."""
    total = 0
    for primary in primaries:
        try:
            paths = recording_scratch_paths(run_root, primary)
        except ValueError:
            continue  # a path that cannot be ours holds nothing of ours
        total += sum(allocated_bytes(path) for path in paths)
    return total


class ScratchGate:
    """What admission asks the scratch volume, and what it does when the volume
    cannot answer.

    ``gate(in_flight)`` is the budget right now (`scratch_budget_bytes`). A read
    that fails (EIO, ESTALE or ENOENT on a volume under load) used to turn the gate
    OFF and let a whole wave in, on the one occasion nothing was known about the
    disk. It now fails closed: the last good budget stands, and with no good read
    yet the budget is zero so nothing is admitted. Warned once, not every round."""

    def __init__(
        self, run_root: str, headroom: int | None = None, usage=shutil.disk_usage
    ) -> None:
        self.run_root = run_root
        self.headroom = SCRATCH_HEADROOM_BYTES if headroom is None else headroom
        # The probe of the volume, injectable the way `live_admission_ceiling` takes
        # its /proc paths: a test can state the free space and make the read fail
        # without waiting for a real disk to do either.
        self._usage = usage
        self._last_good: int | None = None
        self._warned = False
        # The budget before it is raised to zero: negative when the volume is short of the
        # headroom. Admission across drivers judges a recording "alone" from this, because
        # adding the peers' written scratch to a clamped zero would credit the headroom.
        self.last_raw: int | None = None

    def volume(self) -> tuple[int, int] | None:
        """``(free, total)`` bytes of the volume right now, or None if unreadable."""
        try:
            usage = self._usage(self.run_root)
        except OSError:
            return None
        return usage.free, usage.total

    def __call__(self, in_flight=()) -> int:
        try:
            free = self._usage(self.run_root).free
        except OSError as exc:
            if not self._warned:
                self._warned = True
                kept = (
                    f"holding the last good budget of {self._last_good / 1024**3:.0f} GiB"
                    if self._last_good is not None
                    else "admitting nothing until it can be read"
                )
                print(
                    f"::warning::cannot read the scratch volume at {self.run_root} ({exc}); "
                    f"{kept}",
                    flush=True,
                )
            return self._last_good if self._last_good is not None else 0
        held = held_scratch_bytes(self.run_root, in_flight)
        self.last_raw = free + held - self.headroom
        budget = scratch_budget_bytes(free, held, self.headroom)
        self._last_good = budget
        self._warned = False
        return budget


# Fallback user-facing reasons, keyed by biosigIO error code. The authoritative
# copy lives in biosigio.exceptions.REASONS (single source of truth); we prefer
# that at runtime and use this only if the import is unavailable. Keep the codes
# in sync with biosigio's hierarchy.
_FALLBACK_REASONS = {
    "recording_memory_exceeded": (
        "This recording ran out of memory while its viewer copy was being "
        "built. It is not a defect in the data and can succeed on a later run."
    ),
    "not_continuous": (
        "This file is a trial-averaged or epoched derivative, not a continuous "
        "recording, so the time-series viewer is not available."
    ),
    "corrupt_or_truncated": (
        "This recording's data file appears truncated or corrupt, so the viewer "
        "could not be generated."
    ),
    "unsupported_format": "This file format is not yet supported by the viewer.",
    "empty_recording": "This recording contains no signal channels to display.",
    "file_read_error": "This recording could not be prepared for viewing.",
    # NEMAR-side (not a biosigIO code): a recording too large to convert on the
    # conversion node within memory limits (#909). The streaming path handles
    # multi-GB BrainVision/FIF/CTF; this is hit by a very large EDF/BDF/EEGLAB
    # recording, which has no streaming reader yet and would load fully in memory.
    "recording_too_large": (
        "This recording is too large to convert to an interactive viewer copy "
        "within the conversion node's memory limits."
    ),
    # NEMAR-side fidelity gate: the converted copy came up short of the file's
    # own header, or of the recording's channels.tsv where the header was
    # unreadable, so it was withheld rather than served. A sidecar that merely
    # over-declares is not this failure; see channel_gate_verdict.
    "channel_count_mismatch": (
        "The converted viewer copy carried fewer channels than the data file "
        "itself declares (or, where its header could not be read, than this "
        "recording's channels.tsv declares), so it was withheld pending a "
        "converter fix."
    ),
    # NEMAR-side (not a biosigIO code): ADR 0028. Surfaces MEGIN's own position,
    # which is why the file cannot simply be shown, rather than a bare read error.
    "maxshield_uncalibrated": (
        "This recording was acquired with internal active shielding, which distorts "
        "the signal until it is corrected. Correcting it needs the site's "
        "fine-calibration and cross-talk files, which this dataset does not provide "
        "for this recording, so no viewer copy is offered."
    ),
    # NEMAR-side (not a biosigIO code): ADR 0028's probe (is_maxshield_fif) could
    # not read this FIF's header at all, so it was never possible to tell whether
    # it carries raw internal active shielding or needs some other correction.
    "maxshield_probe_failed": (
        "This recording's header could not be read, so it was not possible to "
        "check whether it needs internal-active-shielding correction before "
        "converting it, and no viewer copy is offered."
    ),
    # NEMAR-side (not a biosigIO code): an EEGLAB `.set` whose `.fdt` is declared
    # elsewhere in the dataset (eeglab-fdt-declarations.json), and the declared
    # file did not verify against the `.set` header. See FdtDeclarationRefused.
    "fdt_declaration_refused": (
        "This recording's data file is stored elsewhere in the dataset, and the "
        "file declared for it did not match the recording's header, so no viewer "
        "copy is offered."
    ),
    # NEMAR-side (not a biosigIO code): the archive's storage holds no complete
    # copy of a file this recording needs, plain or git-annex chunked. See
    # AnnexObjectMissing.
    "annex_object_missing": (
        "A data file this recording needs is missing or incomplete in the "
        "archive's storage, so the viewer could not be generated."
    ),
    # NEMAR-side (not a biosigIO code): the recording's header points to a data
    # file the dataset's tree does not hold at all (#1801). Distinct from
    # `annex_object_missing`, where the tree lists the file and storage lacks it.
    "companion_missing": (
        "A data file this recording's header points to is not in the dataset, so "
        "no viewer copy can be generated until it is added."
    ),
    # NEMAR-side (not a biosigIO code): a FIF recording split across files, and a
    # later part of the series is not in the dataset's tree (#1801).
    "split_part_missing": (
        "This recording is stored as a series of split files, and a later part of "
        "the series is not in the dataset, so no viewer copy can be generated."
    ),
    # NEMAR-side (not a biosigIO code): an EEGLAB `.set` that stores epoched data,
    # a set of trials, rather than one continuous recording (#1214, #1801).
    "epoched_recording": (
        "This file stores epoched data, a set of trials, rather than one "
        "continuous recording, so the time-series viewer is not available for it."
    ),
    # NEMAR-side (not a biosigIO code): the producer gave up retrying. A recording
    # that fails for an INFRA reason is listed in the index's `pending` with an
    # attempt count instead of a failure; after PENDING_MAX_ATTEMPTS rounds it is
    # promoted here, so a permanently failing recording stops consuming the queue
    # and stops claiming it is about to appear. Its `detail` carries the last
    # error, which is the thing an operator actually needs. #1197
    "retry_exhausted": (
        "This recording could not be prepared for viewing after several attempts, "
        "so it is no longer being retried automatically."
    ),
}
_GENERIC_REASON = _FALLBACK_REASONS["file_read_error"]

# Longest `detail` / `last_error` string published per entry. These ride in a
# document fetched by every dataset-page visit, and #1178 item 5 is about that
# document's weight -- one pathological exception message must not undo it.
_DETAIL_MAX_CHARS = 300

# An absolute filesystem path inside an error message. `(?<![\w.])` is what keeps
# it from matching the tail of "min/max" or a URL's path; the alternation excludes
# the punctuation that normally ENDS a path in prose, so
# "corrupt file (/scratch/x.edf): ..." loses the path and keeps the sentence.
_LOCAL_PATH_RE = re.compile(r"(?<![\w.])(?:/[^\s'\"()\[\]{},;:]+)+")
# A Windows-style path, which reaches us through a library that formats one even
# on Linux (MNE embeds paths from a recording's own header) and through anyone
# running the converter on Windows. Same treatment as a POSIX path.
_WINDOWS_PATH_RE = re.compile(r"(?<![\w.])[A-Za-z]:[\\/][^\s'\"()\[\]{},;:]*")

# --- credential redaction ----------------------------------------------------
# The driver shells out to `aws` and reads HTTP, so an exception message can
# quote a presigned URL, a request header, or a key id -- and `detail` /
# `last_error` are PUBLISHED in index.json, on a public bucket, fetched by every
# dataset-page visit. Path stripping alone does not cover that: it was written
# for scratch directories, and a presigned S3 URL is not a filesystem path.
#
# Redaction is by VALUE, not by whole-message suppression: the diagnosis is the
# reason these fields exist (#1197), so "SignatureDoesNotMatch" has to survive
# while the signature does not.
_REDACTED = "[redacted]"
_SECRET_PATTERNS = (
    # `Authorization: AWS4-HMAC-SHA256 Credential=...` / `Bearer <token>`.
    re.compile(r"(?i)\b(authorization\s*[:=]\s*)\S+"),
    re.compile(r"(?i)\bbearer\s+[\w.\-+/=]+"),
    # Every AWS SigV4 query parameter, signature and credential included. Kept as
    # one alternation so a new X-Amz-* parameter is covered by the prefix rule.
    re.compile(r"(?i)([?&]x-amz-[\w-]+=)[^\s&'\"]*"),
    re.compile(r"(?i)\b(signature\s*[:=]\s*)[\w+/=%]+"),
    # Bare access-key ids, which appear in AWS error text without a URL around
    # them ("The AWS Access Key Id AKIA... does not exist"). ASIA is the STS
    # session form the Hallu profile actually uses.
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    # Any query parameter whose NAME says it is a secret, wherever it appears.
    re.compile(r"(?i)([?&](?:token|key|secret|password|passwd|sig|signature)=)[^\s&'\"]*"),
)


def redact_secrets(text: str) -> str:
    """Replace credential-shaped substrings in `text` with `[redacted]`.

    Applied to everything the converter publishes as `detail` or `last_error`.
    The failure mode this closes is narrow but real: a presigned-URL or
    credential error from `aws s3 cp` becomes an uncoded failure, whose message
    is then written verbatim into a world-readable index.json. Nothing else in
    the pipeline was going to catch that, because the message is not a path and
    not a secret the driver ever held in a variable.
    """
    for pattern in _SECRET_PATTERNS:
        # A capture group means "keep the label, drop the value"; no group means
        # the whole match is the secret.
        text = pattern.sub(
            lambda m: (m.group(1) + _REDACTED) if m.groups() else _REDACTED, text
        )
    return text


def strip_local_paths(text: str) -> str:
    """Replace absolute filesystem paths in `text` with `<path>`, POSIX and
    Windows alike.

    The conversion host's scratch directory is a fresh `mkdtemp` name every run,
    so a raw exception message publishes a directory that does not exist by the
    time anyone reads it, and makes two identical failures look different. The
    entry already carries the recording's BIDS `path`, so nothing is lost.

    Runs AFTER `redact_secrets` in `failure_detail`, deliberately: a presigned
    URL's path component would otherwise be collapsed to `<path>` first, taking
    the `X-Amz-Signature` query string with it in some messages and leaving it in
    others depending on punctuation. Redacting first makes the outcome the same
    either way.
    """
    return _WINDOWS_PATH_RE.sub("<path>", _LOCAL_PATH_RE.sub("<path>", text))


def failure_detail(exc: BaseException | str | None) -> str | None:
    """Operator-facing cause for a failed recording: the exception class plus the
    FIRST line of its message, local paths stripped, length-capped.

    This is the field that makes `file_read_error` diagnosable. on008083 published
    36 of them, every one reading "This recording could not be prepared for
    viewing" -- true, sanitized, and useless: it cannot distinguish a corrupt EDF
    from an importer gap without SSH access to the conversion node. The sanitized
    `reason` stays exactly as it was for the viewer; this rides alongside it for
    the human. #1197

    Published on a public bucket, so it is redacted (`redact_secrets`) as well as
    path-stripped: an `aws` or HTTP failure can quote a presigned URL, an
    Authorization header, or an access-key id, and none of those are paths.
    """
    if exc is None:
        return None
    if isinstance(exc, str):
        text, prefix = exc, ""
    else:
        text, prefix = str(exc), f"{type(exc).__name__}: "
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    # Redact BEFORE stripping paths -- see `strip_local_paths` for why the order
    # is load-bearing.
    detail = (prefix + strip_local_paths(redact_secrets(first))).strip()
    if not detail:
        return None
    return detail[:_DETAIL_MAX_CHARS]


def reason_for_code(code: str | None) -> str:
    """User-facing reason for a biosigIO failure code, preferring biosigIO's own
    REASONS (single source of truth) and falling back to a local copy."""
    if not code:
        return _GENERIC_REASON
    try:
        from biosigio.exceptions import REASONS  # type: ignore[import-not-found]

        if code in REASONS:
            return REASONS[code]
    except Exception:  # noqa: BLE001 - biosigio absent/old: use the local copy
        pass
    return _FALLBACK_REASONS.get(code, _GENERIC_REASON)


# --- Reading a reader's refusal (#1801) ---------------------------------------
#
# A reader says that a file failed, and often not why: a generic `file_read_error`,
# MNE's refusal re-labeled `maxshield_probe_failed` by the probe, pyedflib's bare
# `OSError` out of the streaming exporter (no code at all, so it was retried as if
# the node were at fault). `failure_verdict` is the ONE place those are read.
#
# Which codes it looks behind: the four a reader or the probe reports without
# saying why. Any other code is already a statement of cause (a memory budget,
# a missing annex object, a declared `.fdt` that did not verify, ...) and passes
# through untouched, so no rule here can overrule a more specific verdict.
_REFINABLE_CODES = frozenset(
    {None, "file_read_error", "corrupt_or_truncated", "maxshield_probe_failed"}
)
# How far down a `__cause__` chain to read: the exception itself and five links.
# The refusals below sit one to three links down (biosigIO's typed error `from`
# MNE's, the probe's `from` MNE's); the bound keeps a pathological chain from
# costing anything.
_VERDICT_CHAIN_LINKS = 5
# MNE's refusal to read the head of a split series whose next file is not beside
# it. It quotes the file by the path it looked at, which is a scratch path here.
_MNE_SPLIT_RE = re.compile(r"Split raw file detected but next file (.+?) does not exist")
# pyedflib's refusal, which biosigIO's streaming EDF/BDF source re-raises as a bare
# `OSError`; matched anywhere in the text, the way it has always been.
_PYEDFLIB_REFUSAL = "not EDF(+) or BDF(+) compliant"
# biosigIO's tolerant fallback (`importers/_edf_tolerant.py`, 1.2.11) reads a file
# pyedflib refuses and raises its OWN bare, errno-less `OSError` when the file is
# cut short or its header is unusable. Each message is `<path>: <text>`, the path
# being a scratch path here, so only the tail is matched, and all of it: a
# sentence that merely contains these words is not the refusal. One per `raise`
# in `probe_edf_header` (the first three) and `_check_not_truncated`.
_BIOSIGIO_TRUNCATION_RES = (
    re.compile(r"(?s)\A.+: EDF/BDF header is truncated \(<256 bytes\)\Z"),
    re.compile(r"(?s)\A.+: invalid number of signals in header \(-?\d+\)\Z"),
    re.compile(r"(?s)\A.+: signal header is truncated\Z"),
    re.compile(
        r"(?s)\A.+: file is truncated \(expected at least \d+ bytes "
        r"for \d+ data record\(s\), found \d+\)\Z"
    ),
)


def _is_streaming_edf_refusal(message: str) -> bool:
    """True if `message` is pyedflib's refusal or one of biosigIO's tolerant
    fallback's truncation errors: the texts rule 4 of `failure_verdict` types."""
    return _PYEDFLIB_REFUSAL in message or any(
        pattern.search(message) for pattern in _BIOSIGIO_TRUNCATION_RES
    )


def _exception_chain(exc: BaseException) -> list[BaseException]:
    """`exc` and up to `_VERDICT_CHAIN_LINKS` of its causes, nearest first. Only
    the explicit `__cause__` is followed, never the implicit `__context__`: a
    context is whatever was being handled when something else was raised, which is
    as often the host's error as the file's. Every wrapping site that types a
    reader's failure raises `from` it (biosigIO's `classify_read_error(...) from
    e` in each importer, `MaxShieldProbeFailed ... from exc`), so the cause is
    where the refusal is. Stops at a cycle."""
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen and len(chain) <= _VERDICT_CHAIN_LINKS:
        chain.append(current)
        seen.add(id(current))
        current = current.__cause__
    return chain


def failure_verdict(
    exc: BaseException, primary: str, head_files: set[str] | frozenset[str]
) -> tuple[str | None, str | None]:
    """`(code, detail)` for a recording whose conversion raised `exc`.

    `code` is the exception's own, refined where one of the rules below can say
    what a generic one could not. `detail` is the text to publish when a rule
    has a better one than the exception's (it names the file by its BIDS path,
    never a scratch path); None means `failure_detail(exc)`.

    Reads `exc` and five `__cause__` links (rule 4 reads `exc` alone), and only
    for the codes in `_REFINABLE_CODES`. Never `__context__`: an exception raised
    while another was being handled is not caused by it, and a host error raised
    during a read's recovery must keep its retry. The first rule that matches
    wins:

    1. MNE's "Split raw file detected but next file X does not exist":
       `split_part_missing`, naming `dirname(primary)/basename(X)`, when the TREE
       lacks that file. When the tree lists it the part is merely absent from
       the working tree or unfetched, a gap in this run, and no rule relabels it.
    2. An EEGLAB `.set` the reader refuses with "Must pass 2-d input" (a
       three-dimensional array, epoched data): `epoched_recording`. It goes dead
       when biosigio#142 reads epoched files, and #1214 then sets the policy.
    3. "float32 samples but the .set header implies": the `.fdt` is not the size
       its `.set` header says, `corrupt_or_truncated`. DEFENSE until biosigIO
       types the mismatch itself.
    4. `exc` ITSELF is exactly `OSError`, with no errno, saying "not EDF(+) or
       BDF(+) compliant" (pyedflib's refusal, re-raised bare by biosigIO's
       streaming EDF/BDF source) or one of the four truncation errors biosigIO's
       tolerant fallback raises bare (`_BIOSIGIO_TRUNCATION_RES`: a header or
       signal header cut short, an impossible signal count, a file shorter than
       its header implies): `corrupt_or_truncated`, as its in-memory path types
       the same file. TEMPORARY, like its canary
       (`TestStreamingRefusalCanary`), until biosigio 1.2.12 ships PR #150
       (closes #149), which types the streaming refusal and wraps the streaming
       fallback's errors in `classify_read_error`. The pinned 1.2.11 still
       leaves both bare, so the fallback text match
       (`_BIOSIGIO_TRUNCATION_RES`) is still needed; at that release it is
       deleted with its canary case, and so is the rest of this rule. The guard
       is exact on purpose: an `OSError` that carries an errno (EIO, ENOSPC,
       EACCES) or is a subclass (`PermissionError`) is the HOST saying no, a
       condition that must keep its retry. And it is `exc`, never a link behind
       it: biosigIO recovers some refusals inside the `except` block that
       caught them, so a host error raised during that recovery carries the
       bare refusal as its
       `__context__`, and reading the chain would type the host's error as the
       file's. Rules 1 to 3 do read causes, but only explicit ones, for the
       same reason.
    5. Otherwise the exception's own code, which may be None.

    A `.code` that is not a non-empty string is not a code: the exception is
    read as uncoded. Membership in a frozenset hashes the value, so a list
    there would raise `TypeError` out of `convert_one`'s `except` branch, and
    the worker would crash on a failure it exists to report.
    """
    code = getattr(exc, "code", None)
    if not isinstance(code, str) or not code:
        code = None
    if code not in _REFINABLE_CODES:
        return code, None
    chain = _exception_chain(exc)
    messages = [str(link) for link in chain]
    for message in messages:
        match = _MNE_SPLIT_RE.search(message)
        if match:
            part = os.path.join(os.path.dirname(primary), os.path.basename(match.group(1)))
            if part not in head_files:
                return SPLIT_PART_MISSING, f"next split part {part} is not in the dataset tree"
    if lower_ext(primary) == ".set" and any("Must pass 2-d input" in m for m in messages):
        return EPOCHED_RECORDING, None
    if any("float32 samples but the .set header implies" in m for m in messages):
        return "corrupt_or_truncated", None
    if type(exc) is OSError and exc.errno is None and _is_streaming_edf_refusal(str(exc)):
        return "corrupt_or_truncated", None
    return code, None


# The serving group + rate are driven by the recording's BIDS datatype SUFFIX, not
# by per-channel type guessing. A `*_eeg.set` is EEG (250 Hz cap) even when a few
# EOG/REF/trigger channels ride along; biosigIO's EEGLAB importer can only see an
# empty chanlocs `type` and would otherwise fall back to OTHER -> MISC, yielding a
# `misc_1024hz` group (no cap) instead of the intended `eeg_250hz`. We force every
# channel's modality from the suffix so the whole recording lands in one coherent
# group at the modality's MODALITY_RATES cap.
_SUFFIX_MODALITY = {"eeg": "EEG", "meg": "MEG", "ieeg": "IEEG", "emg": "EMG"}


def bids_suffix_modality(path: str) -> str | None:
    """Modality from a recording's BIDS suffix (`sub-01_task-rest_eeg.set` -> EEG),
    or None when the trailing `_<suffix>` is not a known datatype. The rate cap
    then follows from MODALITY_RATES (EEG/MEG 250 Hz, IEEG/EMG 1000 Hz)."""
    stem = os.path.basename(path).rsplit(".", 1)[0]
    suffix = stem.rsplit("_", 1)[-1].lower() if "_" in stem else ""
    return _SUFFIX_MODALITY.get(suffix)

ANNEX_TARGET_RE = re.compile(r"\.git/annex/objects/[A-Za-z0-9]+/[A-Za-z0-9]+/([^/]+)/\1$")
ANNEX_POINTER_CONTENT_RE = re.compile(r"^/annex/objects/(.+)$")


def lower_ext(path: str) -> str:
    return os.path.splitext(path)[1].lower()


def in_excluded_tree(path: str) -> bool:
    """True if `path` sits under `derivatives/`, `sourcedata/`, or `code/`,
    matched at the top level or nested, on a full path SEGMENT rather than a
    bare substring -- `mycode/`, `derivatives_old/`, and a task label
    containing "code" must still be discoverable. Same shape as
    `emit_records.py`'s `derivatives`/`sourcedata` exclusion in this repo."""
    return any(
        path.startswith(f"{tree}/") or f"/{tree}/" in path for tree in EXCLUDED_TREES
    )


def source_tree_for(path: str) -> str:
    """Which BIDS tree a source recording lives in: "raw", or the excluded tree
    that contains it (`derivatives` / `sourcedata` / `code`).

    Published per store as `source_tree` (#1064), where it is always "raw": ADR
    0027 made discovery raw-only, and `merge_index` DROPS a carried-over store
    whose path is excluded rather than republishing it -- those stores are being
    deleted by `purge_non_raw_stores.py`, so an index that described them would
    advertise bytes that are going away. The drop is reported (logged with the
    tree, counted as `non_raw_dropped` on the callback), never published.

    So this function's non-raw answers do not reach the index at all. They exist
    because the drop has to be able to SAY why: `excluded_reason` names the cause
    on each logged line, and "dropped a store" versus "dropped a store because it
    is under `derivatives/`" are very different lines to find in a cron log when
    an orphan-detection bug is the alternative explanation.

    Deliberately NOT the same question as the store entry's `derived`, which is
    about whether the SIGNAL was processed (ADR 0028 Signal-Space Separation). A
    recording can sit in `derivatives/` and be served unprocessed, and an
    SSS-filtered MEG store is derived while its source is raw.
    """
    for tree in EXCLUDED_TREES:
        if path.startswith(f"{tree}/") or f"/{tree}/" in path:
            return tree
    return "raw"


def is_bids_calibration_file(path: str) -> bool:
    """True for a BIDS-reserved MEG calibration filename (crosstalk or
    fine-calibration correction data), which is never a recording."""
    return path.endswith(_BIDS_CALIBRATION_SUFFIXES)


def maxshield_calibration_for(
    primary_path: str, head_files: set[str] | frozenset[str]
) -> tuple[str, str] | None:
    """The `(fine_calibration, cross_talk)` pair applying to `primary_path`, or None
    when either is absent.

    Resolved by BIDS inheritance: the nearest match in the recording's own directory
    or any ancestor, most specific winning. Both must resolve -- ADR 0028 declines
    rather than run Signal-Space Separation uncalibrated, because an uncalibrated
    correction is weaker in a way a consumer could not distinguish from a good one.

    These are exactly the files `is_bids_calibration_file` excludes from DISCOVERY.
    That is not a contradiction and the two must not be conflated: they are never
    recordings, and they are inputs to converting one. A future change that reads
    "excluded from discovery" as "irrelevant to conversion" silently breaks MaxShield
    support (ADR 0028's own warning).

    The entity-subset rule the other sidecar resolvers use does NOT work here, which
    is why this is its own function. `sub-01_acq-calibration_meg.dat` carries
    `acq=calibration`, while the recording `sub-01_task-rest_meg.fif` has no `acq` at
    all, so the subset test rejects the very file it should find. `acq` is the entity
    that NAMES these sidecars rather than scoping them, so it is exempt here.
    """
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(filename_stem(primary_path))

    def _nearest(suffix: str) -> str | None:
        # Same two accepted spellings as the other sidecar resolvers: the
        # entity-prefixed form beside the recording, or the bare form (no leading
        # underscore) at a level that has no entities of its own.
        bare = suffix.lstrip("_")
        candidates: list[tuple[int, int, str]] = []
        for f in head_files:
            if not (f.endswith(suffix) or os.path.basename(f) == bare):
                continue
            cdir = os.path.dirname(f)
            if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
                continue
            cents = _bids_entities(filename_stem(f))
            cents.pop("acq", None)  # names the sidecar, does not scope it
            if any(rec_ents.get(k) != v for k, v in cents.items()):
                continue
            candidates.append((cdir.count("/") + (1 if cdir else 0), len(cents), f))
        if not candidates:
            return None
        candidates.sort()
        return candidates[-1][2]

    cal = _nearest("_acq-calibration_meg.dat")
    ctc = _nearest("_acq-crosstalk_meg.fif")
    return (cal, ctc) if cal and ctc else None


def is_maxshield_fif(path: str) -> bool:
    """True if `path` is a FIF carrying raw Internal Active Shielding data.

    Reads the FIF header only (`preload=False`), which is cheap even on a large
    recording -- measured at 1.6 s and 0.13 GiB of peak RSS against a 716 MiB file on
    the conversion node -- so this is affordable as a preflight on every FIF.

    `allow_maxshield="yes"` is the quiet form: it suppresses MNE's warning, which we
    do not want in the log for a file we are about to correct properly. The flag we
    read back, `info["maxshield"]`, is MNE's own; ADR 0028 established that it flips
    True -> False once Signal-Space Separation has run, so the same field serves as
    both the detector here and the verification afterwards.

    A non-FIF path is not our business: return False and let the normal
    conversion path produce its own typed failure. A FIF whose header cannot
    be read raises `MaxShieldProbeFailed` (#1139) rather than swallowing the
    exception and returning False: doing that used to route the recording
    down the NORMAL conversion path, which for a file this probe could not
    even open failed anyway -- as an uncoded (or differently-coded)
    `file_read_error`, with nothing on the public index distinguishing "the
    MaxShield probe itself could not read this FIF" from any other read
    failure. `convert_one` classifies the raised exception the same way it
    classifies every other typed failure, via `.code` and `failure_detail`.
    """
    if lower_ext(path) != ".fif":
        return False
    try:
        import mne  # type: ignore[import-not-found]  # lazy: runtime-only dep

        info = mne.io.read_raw_fif(
            path, allow_maxshield="yes", preload=False, verbose="ERROR"
        ).info
        return bool(info.get("maxshield"))
    except Exception as exc:  # reclassified as MaxShieldProbeFailed below
        raise MaxShieldProbeFailed(
            f"could not read the FIF header to test for Internal Active "
            f"Shielding: {type(exc).__name__}: {exc}"
        ) from exc


def apply_sss(raw_path: str, calibration: str, cross_talk: str, out_path: str) -> dict:
    """Signal-Space Separation filter a MaxShield recording, writing the corrected
    recording to `out_path`. Returns the disclosure recorded in the store and index.

    ADR 0028: raw Internal Active Shielding data is never served. It is corrected
    with the recording's own site-specific fine-calibration and cross-talk files, or
    it is declined. `mne.preprocessing.maxwell_filter` is an open-source
    implementation of the same Signal-Space Separation family as MEGIN's proprietary
    MaxFilter, which the conversion host cannot run.

    The result is a PROCESSED DERIVATIVE, unlike every other store this converter
    writes, which is why this returns a disclosure rather than filtering silently.
    """
    import mne  # type: ignore[import-not-found]  # lazy: runtime-only dep

    raw = mne.io.read_raw_fif(
        raw_path, allow_maxshield="yes", preload=True, verbose="ERROR"
    )
    try:
        sss = mne.preprocessing.maxwell_filter(
            raw, calibration=calibration, cross_talk=cross_talk, verbose="ERROR"
        )
    except MemoryError:
        # Genuinely transient: the node was busy, not the data wrong. Let it reach
        # the retryable `recording_memory_exceeded` verdict.
        raise
    except Exception as exc:  # noqa: BLE001 - see below
        # A calibration pair that is PRESENT but does not fit this recording (wrong
        # sensor set, wrong site, malformed file) is just as permanent a property of
        # what the dataset ships as a missing pair, so it gets the same terminal
        # verdict. Left uncoded it would fall through to the generic handler as an
        # infra failure and re-run maxwell_filter on every future pass forever --
        # the anti-pattern #1110 exists to prevent, at ~1 minute of compute a time.
        raise MaxShieldUncalibrated(
            f"Signal-Space Separation failed with this recording's calibration pair "
            f"({os.path.basename(calibration)}, {os.path.basename(cross_talk)}): "
            f"{type(exc).__name__}: {exc}"
        ) from exc
    # MNE's own guardrail, the check that refused to load the file, is satisfied by
    # the output. If it is not, the correction did not happen and serving the result
    # would be exactly the thing ADR 0028 forbids -- so fail rather than publish it.
    if sss.info.get("maxshield"):
        raise MaxShieldUncalibrated(
            "Signal-Space Separation ran but the recording is still flagged as raw "
            "Internal Active Shielding data; refusing to serve it"
        )
    sss.save(out_path, overwrite=True, verbose="ERROR")
    return {
        "applied": True,
        "method": "maxwell_filter",
        "calibration": os.path.basename(calibration),
        "cross_talk": os.path.basename(cross_talk),
        "mne_version": mne.__version__,
    }


def is_excluded_from_discovery(path: str) -> bool:
    """True if `path` can never be a servable BIDS raw recording: it sits
    under an excluded tree, or it is a reserved BIDS calibration filename.

    The single predicate every recording-discovery path runs a candidate
    through before treating it as buildable -- `is_primary`, the directory-
    recording derivations (`dir_recordings` for CTF `.ds`/MEF3 `.mefd`,
    `bti_recordings` for 4D/BTi), the diff-based companion/`_events.tsv`
    routing in `compute_worklist`, the stale-failure carry-forward in
    `merge_index`, and the `--clean` orphan-safety filter in
    `compute_clean_orphans`. One predicate used everywhere instead of
    repeating the tree/filename checks inline keeps the raw-only scope
    consistent across every entry point.
    """
    return in_excluded_tree(path) or is_bids_calibration_file(path)


def excluded_reason(path: str) -> str | None:
    """WHY `is_excluded_from_discovery` rejects `path`, or None if it does not:
    the excluded tree's name, or `bids-calibration`.

    Exists so a drop can be logged with its cause. "Dropped a store" and
    "dropped a store because it is under `derivatives/`" are very different
    lines to find in a cron log when a real orphan bug is the alternative
    explanation.
    """
    for tree in EXCLUDED_TREES:
        if path.startswith(f"{tree}/") or f"/{tree}/" in path:
            return tree
    if is_bids_calibration_file(path):
        return "bids-calibration"
    return None


def non_raw_store_paths(prior: dict | None) -> list[str]:
    """Paths in a prior index's `stores` that discovery no longer walks.

    The count `main` reports as `non_raw_dropped`. Read from the PRIOR PUBLISHED
    index rather than from `merge_index`'s filtering, because the production path
    is `--clean`: there `prior` is not passed to the merge at all, so the entries
    never enter and the filter never sees them -- yet they are still gone from
    the index a client will fetch next, which is the thing worth reporting.
    """
    return sorted(
        str(e.get("path"))
        for e in (prior or {}).get("stores", [])
        if isinstance(e, dict)
        and isinstance(e.get("path"), str)
        and is_excluded_from_discovery(e["path"])
    )


def is_primary(path: str) -> bool:
    return lower_ext(path) in PRIMARY_EXTS and not is_excluded_from_discovery(path)


def is_events_tsv(path: str) -> bool:
    return path.endswith("_events.tsv")


def filename_stem(path: str) -> str:
    """`sub-01/eeg/sub-01_task-x_eeg.vhdr` -> `sub-01_task-x_eeg`."""
    return os.path.splitext(os.path.basename(path))[0]


def entities_base(stem: str) -> str:
    """Drop the trailing BIDS suffix: `sub-01_task-x_eeg` -> `sub-01_task-x`."""
    return stem.rsplit("_", 1)[0] if "_" in stem else stem


# --- BIDS split recordings (multi-file FIF) ------------------------------
#
# MNE writes a recording larger than the FIF 2 GB limit as a chain of files
# `..._split-01_<suffix>.fif`, `..._split-02_<suffix>.fif`, ...; the first file
# holds the header and a pointer to the next, so `read_raw_fif(split-01)` follows
# the chain and returns the WHOLE recording. The other splits are not standalone
# recordings -- reading one in isolation yields only its segment. So a split group
# is ONE logical recording: the lowest-index split is the chain head (the only
# buildable primary), every split must be materialized together for MNE to follow
# the chain, and exactly one store is written (keyed at the head split's path).
_SPLIT_RE = re.compile(r"_split-(\d+)")


def split_index(path: str) -> int | None:
    """Numeric `split-NN` entity of a BIDS split file (`..._split-02_meg.fif` -> 2),
    or None when the path carries no `split-` entity."""
    m = _SPLIT_RE.search(os.path.basename(path))
    return int(m.group(1)) if m else None


def _strip_split(stem: str) -> str:
    """Remove the `_split-NN` entity token from a stem (no-op when absent)."""
    return _SPLIT_RE.sub("", stem, count=1)


def is_split_fif(path: str) -> bool:
    """True for a FIF recording carrying a `split-` entity (the only ext where the
    split chain matters; other formats are single-file)."""
    return lower_ext(path) == ".fif" and split_index(path) is not None


def split_group_key(path: str) -> str:
    """Identity of the logical recording a split file belongs to: its path with the
    `_split-NN` entity removed. `sub-03/meg/sub-03_task-x_split-02_meg.fif` ->
    `sub-03/meg/sub-03_task-x_meg.fif`. A non-split path returns unchanged."""
    d = os.path.dirname(path)
    base = _SPLIT_RE.sub("", os.path.basename(path), count=1)
    return f"{d}/{base}" if d else base


def split_heads_and_members(primaries: list[str]) -> tuple[set[str], dict[str, str]]:
    """Partition primaries into buildable heads + a non-head-split -> head map.

    `heads` is every primary that should build a store: non-split primaries
    verbatim, plus the lowest-index split of each FIF split group. `member_to_head`
    maps each NON-head split to its head, so a change to any split rebuilds the one
    head store. A degenerate group whose `split-01` is absent picks the lowest
    present split as head (best-effort; MNE then reads from there)."""
    groups: dict[str, list[str]] = {}
    heads: set[str] = set()
    for p in primaries:
        if is_split_fif(p):
            groups.setdefault(split_group_key(p), []).append(p)
        else:
            heads.add(p)
    member_to_head: dict[str, str] = {}
    for members in groups.values():
        ordered = sorted(members, key=lambda x: (split_index(x), x))
        head = ordered[0]
        heads.add(head)
        for m in ordered[1:]:
            member_to_head[m] = head
    return heads, member_to_head


def split_members_for(primary_path: str, head_files: set[str]) -> list[str]:
    """Every FIF split that shares `primary_path`'s split group, sorted by index
    (includes the head). `[]` when `primary_path` is not a split file. Used to (a)
    materialize the whole chain and (b) record the member list on the index entry so
    the browser can resolve any split file to the one store."""
    if not is_split_fif(primary_path):
        return []
    gkey = split_group_key(primary_path)
    members = [p for p in head_files if is_split_fif(p) and split_group_key(p) == gkey]
    return sorted(members, key=lambda x: (split_index(x), x))


def store_rel_for(primary_path: str) -> str:
    """`sub-01/eeg/sub-01_task-x_eeg.set` -> `sub-01/eeg/sub-01_task-x_eeg.zarr`.

    Strips the data extension and appends `.zarr`; the BIDS suffix (`_eeg`,
    `_emg`, ...) is preserved, so the rule is uniform across all primary exts and
    over a directory recording (CTF `..._meg.ds` -> `..._meg.zarr`, MEF3
    `..._ieeg.mefd` -> `..._ieeg.zarr`). A 4D/BTi directory carries no extension
    at all, so `os.path.splitext` finds none to strip and this is a plain
    `path + ".zarr"` for it (`..._meg` -> `..._meg.zarr`).
    """
    root, _ = os.path.splitext(primary_path)
    return root + ".zarr"


# Sibling of a store's local directory that holds the streaming exporter's memmaps.
# It sits NEXT to the store (same volume, never uploaded) but is unique to one
# recording: the exporter's `TemporaryDirectory` used to land in the store's PARENT
# directory, which sibling recordings of the same session share, so nothing could
# reclaim one recording's memmaps without risking another's.
SCRATCH_DIR_SUFFIX = ".scratch"


def recording_scratch_paths(tmp: str, primary: str) -> tuple[str, str, str]:
    """Where one recording keeps its local bytes under the run's temp root:
    ``(work, store_local, memmap_scratch)``. One definition, shared by the worker
    that creates them and by the drain that reclaims them after a pool break, so
    the two cannot disagree about what a dead worker left behind.

    Every path must sit inside ``tmp``: a git primary is relative today, but this is
    also what a reclaim deletes, so an absolute or ``..``-climbing ``primary`` (it
    would make `os.path.join` discard ``tmp``) raises ValueError instead of naming
    a directory outside the run."""
    work = os.path.join(tmp, "work", primary.replace("/", "_"))
    store_local = os.path.join(tmp, "stores", store_rel_for(primary))
    paths = (work, store_local, store_local + SCRATCH_DIR_SUFFIX)
    # realpath, not abspath: a symlink inside the run's directory that points
    # outside it would pass a lexical check and have a reclaim delete through it.
    root = os.path.realpath(tmp)
    for path in paths:
        resolved = os.path.realpath(path)
        if resolved == root or os.path.commonpath([root, resolved]) != root:
            raise ValueError(f"scratch path {path!r} for {primary!r} is outside {tmp!r}")
    return paths


def remove_scratch_tree(path: str) -> list[str]:
    """Delete ``path`` and return what could not be removed, as ``"<path>: <error>"``.

    Every scratch delete used to be ``ignore_errors=True``: a failed one (a read-only
    directory, a busy mount) reported the bytes as freed, left them on disk, and
    added them to the next budget. Nothing here is silent now."""
    failures: list[str] = []
    if not os.path.lexists(path):
        return failures

    def record(_func, failed_path, exc) -> None:
        failures.append(f"{failed_path}: {exc}")

    try:
        try:
            shutil.rmtree(path, onexc=record)
        except TypeError:  # Python < 3.12 has onerror, not onexc
            shutil.rmtree(path, onerror=lambda f, p, info: record(f, p, info[1]))
    except OSError as exc:  # the top-level path itself (not a directory, vanished)
        failures.append(f"{path}: {exc}")
    return failures


class ReclaimResult(NamedTuple):
    freed: int  # bytes that are gone from disk, measured after the delete
    leaked: int  # bytes still on disk under the recording's paths
    errors: list[str]


def reclaim_recording_scratch(tmp: str, primary: str) -> ReclaimResult:
    """Delete everything a recording left on scratch and say what that bought.

    `convert_one`'s ``finally`` does this on every exit it gets to run. A worker
    killed outright (SIGKILL, or SIGBUS from a memmap write to a full volume) never
    reaches it, so its raw download and its multi-hundred-GiB memmaps stayed on
    disk until the whole dataset run ended: on nm000276 two killed workers held 535
    GiB and every recording behind them in the queue failed with ENOSPC. Called
    only once the pool's workers are gone, when nothing can still be writing.

    ``freed`` is measured AFTER the delete (before minus after), so a delete that
    failed reports what it did not free: it used to claim the bytes it had only
    tried to remove. Each failure is an ``::error::`` naming the path and what is
    still on disk.
    """
    try:
        paths = recording_scratch_paths(tmp, primary)
    except ValueError as exc:
        print(f"::error::not reclaiming scratch for {primary!r}: {exc}", flush=True)
        return ReclaimResult(0, 0, [str(exc)])
    freed = leaked = 0
    errors: list[str] = []
    for path in paths:
        before = allocated_bytes(path)
        failures = remove_scratch_tree(path)
        after = allocated_bytes(path)
        freed += max(0, before - after)
        leaked += after
        for failure in failures:
            print(
                f"::error::could not remove scratch {failure}; "
                f"{after / 1024**3:.2f} GiB under {path} is still on disk",
                flush=True,
            )
        errors.extend(failures)
    return ReclaimResult(freed, leaked, errors)


class OrphanReport(NamedTuple):
    killed: list[int]  # pids sent SIGKILL
    survivors: list[int]  # killed pids still present after the wait
    scanned: int  # processes whose command line could be read
    error: str | None  # why the scan could not run at all, or None


def _ps_process_table() -> tuple[list[tuple[int, list[str]]], str | None]:
    """``(pid, argv)`` from `ps`, for a system without /proc. ``-ww`` and a huge
    COLUMNS keep procps and BSD ps from truncating `args` to a terminal width,
    which hid a live process from the first version of this scan on Ubuntu. argv
    is the whitespace split of the command line, so it is only as exact as that."""
    try:
        done = subprocess.run(
            ["ps", "-ww", "-Ao", "pid=,args="], capture_output=True, text=True, timeout=30,
            env={**os.environ, "COLUMNS": "100000"},
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return [], f"ps could not run: {exc}"
    if done.returncode != 0:
        return [], f"ps exited {done.returncode}: {done.stderr.strip()[:200]}"
    table: list[tuple[int, list[str]]] = []
    for line in done.stdout.splitlines():
        pid_text, _, args = line.strip().partition(" ")
        if pid_text.isdigit():
            table.append((int(pid_text), args.split()))
    return table, None


def process_table(proc_root: str | None = None) -> tuple[list[tuple[int, list[str]]], str | None]:
    """``(pid, argv)`` for every process whose command line can be read, and the
    reason when the table could not be built at all.

    On Linux this reads ``/proc/<pid>/cmdline``: the kernel's own NUL-separated argv,
    exact and never truncated, with no dependency on a `ps` binary being installed.
    Without /proc it falls back to `ps`. ``proc_root`` points the /proc reader at a
    fixture directory in the kernel's layout."""
    if proc_root is None and not os.path.isdir("/proc/self"):
        return _ps_process_table()
    root = proc_root or "/proc"
    try:
        names = os.listdir(root)
    except OSError as exc:
        return [], f"cannot list {root}: {exc}"
    table: list[tuple[int, list[str]]] = []
    for name in names:
        if not name.isdigit():
            continue
        try:
            with open(os.path.join(root, name, "cmdline"), "rb") as fh:
                raw = fh.read()
        except OSError:
            continue  # exited since the listing, or not readable
        table.append((int(name), [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]))
    return table, None


def _with_deadline(fn, seconds: float):
    """``(value, timed_out)``: run ``fn`` in a daemon thread and give up after
    ``seconds``. A /proc read of a live process normally returns at once, but it
    reaches into the target's memory and can wait on it; a scan run while a pool is
    being cleaned up must not hang the run on one such read. The abandoned thread is
    left behind (daemon), which is the price of not being able to cancel a read."""
    box: dict = {}

    def run() -> None:
        try:
            box["value"] = fn()
        except BaseException as exc:  # noqa: BLE001 - re-raised in the caller's thread
            box["error"] = exc

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        return None, True
    if "error" in box:
        raise box["error"]
    return box["value"], False


def _cmdline_argv(pid: int, proc_root: str | None) -> list[str] | None:
    """The argv of ``pid`` right now, or None if it cannot be read (it has exited)."""
    if proc_root is not None or os.path.isdir("/proc/self"):
        try:
            with open(os.path.join(proc_root or "/proc", str(pid), "cmdline"), "rb") as fh:
                raw = fh.read()
        except OSError:
            return None
        return [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]
    try:
        done = subprocess.run(
            ["ps", "-ww", "-o", "args=", "-p", str(pid)], capture_output=True, text=True,
            timeout=10, env={**os.environ, "COLUMNS": "100000"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.split() if done.returncode == 0 and done.stdout.strip() else None


def _pid_is_gone(pid: int) -> bool:
    """Whether ``pid`` has exited. A process killed but not yet reaped is a zombie:
    it has released its files and its blocks, so it counts as gone."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    if os.path.isdir("/proc/self"):
        try:
            with open(f"/proc/{pid}/stat", "rb") as fh:
                state = fh.read().rpartition(b")")[2].split()[0]
            return state in (b"Z", b"X")
        except FileNotFoundError:
            return True  # /proc exists and has no such process
        except (OSError, IndexError):
            pass
    try:
        listing = subprocess.run(
            ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return listing.stdout.strip().startswith("Z")


def _wait_until_gone(pids: list[int], seconds: float) -> list[int]:
    """The pids among ``pids`` still present after up to ``seconds``."""
    deadline = time.monotonic() + seconds
    alive = list(pids)
    while alive:
        alive = [pid for pid in alive if not _pid_is_gone(pid)]
        if not alive or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    return alive


def kill_orphans_under(
    root: str,
    proc_root: str | None = None,
    wait_seconds: float = 5.0,
    *,
    scan_seconds: float = 30.0,
    send_signal=os.kill,
    _after_scan=None,
) -> OrphanReport:
    """SIGKILL every process whose command line names a path under ``root``, wait
    for each to exit, and say what could not be established.

    `aws s3 cp` children are started without a process group or a parent-death
    signal, so one can outlive the worker that started it and keep writing into
    files `reclaim_recording_scratch` is about to unlink (the blocks stay allocated
    until it exits). ``root`` is this run's own unique temp directory, so a process
    that names a path under it belongs to this run, and the caller only asks once
    the pool's workers are gone: what is left is an orphan. An argument matches only
    if it starts with ``root`` plus a separator, so a sibling directory sharing a
    prefix survives, and this process is never touched.

    The result is explicit about the two ways this can quietly do nothing: the scan
    could not run (``error``), or it read no process at all (``scanned`` is 0). A
    killed process that is still present after the wait is in ``survivors``.

    The scan has a deadline (``scan_seconds``), and each candidate's command line is
    read AGAIN immediately before the signal and must still match: between the scan
    and the kill a pid can be freed and reused by an unrelated process, and the second
    read is what stops that process being killed. ``send_signal`` is ``os.kill``; a
    test passes another to produce a process that outlives the signal.
    """
    scanned, timed_out = _with_deadline(lambda: process_table(proc_root), scan_seconds)
    if timed_out:
        return OrphanReport([], [], 0, f"the process scan did not finish in {scan_seconds:g}s")
    table, error = scanned
    prefix = os.path.join(root, "")
    me = os.getpid()
    candidates = [
        pid for pid, argv in table
        if pid != me and any(arg.startswith(prefix) for arg in argv)
    ]
    if _after_scan is not None:
        _after_scan()
    killed: list[int] = []
    for pid in candidates:
        again, _ = _with_deadline(lambda pid=pid: _cmdline_argv(pid, proc_root), 5.0)
        if not again or not any(arg.startswith(prefix) for arg in again):
            continue  # exited, or the pid now belongs to something else
        try:
            send_signal(pid, signal.SIGKILL)
            killed.append(pid)
        except OSError:
            continue  # already gone, or not ours to signal
    return OrphanReport(killed, _wait_until_gone(killed, wait_seconds), len(table), error)


def reclaim_after_pool_break(
    tmp_root: str,
    primaries: list[str],
    volume=None,
    *,
    proc_root: str | None = None,
    suspect_after: int = 1024**3,
    send_signal=os.kill,
    wait_seconds: float = 5.0,
) -> ReclaimResult:
    """What a pool break owes the disk, in one warning.

    Kills the orphaned children of the dead workers first (they would keep writing
    into what is about to be unlinked), reclaims each in-flight recording's scratch,
    and reports the volume before and after. The warning names the cause the
    "killed its worker process" verdict cannot: a full volume kills workers with
    SIGBUS, which looks exactly like an out-of-memory kill.

    The bytes it says were reclaimed are the ones removed from the recordings'
    paths. They are only freed on the volume once nothing holds the deleted files
    open, so the volume's own free space is compared with them: a gain under half of
    what was removed (once it exceeds ``suspect_after``) says a process may still
    hold the blocks. When the disk is still short after the reclaim, or the orphan
    scan could not run, or a killed process survived, that is an ``::error::`` or a
    ``::warning::`` with the numbers, since the rebuilt pool is about to inherit it.
    ``volume`` is a callable returning ``(free, total)`` or None."""
    before = volume() if volume else None
    orphans = kill_orphans_under(
        tmp_root, proc_root, wait_seconds, send_signal=send_signal
    )
    freed = leaked = 0
    errors: list[str] = []
    for primary in primaries:
        result = reclaim_recording_scratch(tmp_root, primary)
        freed += result.freed
        leaked += result.leaked
        errors.extend(result.errors)
    after = volume() if volume else None
    gib = 1024**3
    if before and after:
        disk = (
            f"scratch free {before[0] / gib:.0f} GiB before the reclaim and "
            f"{after[0] / gib:.0f} GiB after, of {after[1] / gib:.0f} GiB"
        )
    else:
        disk = "scratch free space unreadable"
    print(
        f"::warning::worker pool broke with {len(primaries)} recording(s) in flight; "
        f"{disk}; removed {freed / gib:.1f} GiB of files, {leaked / gib:.1f} GiB still on "
        f"disk, {len(orphans.killed)} orphaned child process(es) killed. A full scratch "
        "volume kills workers with SIGBUS, which the 'killed its worker process' "
        "verdict below reports as out of memory",
        flush=True,
    )
    if orphans.error or not orphans.scanned:
        why = orphans.error or "no process command line was readable"
        print(
            f"::warning::could not look for orphaned child processes ({why}); one may "
            "still be writing into files that were just deleted",
            flush=True,
        )
    if orphans.survivors:
        print(
            f"::error::{len(orphans.survivors)} orphaned process(es) survived SIGKILL "
            f"{orphans.survivors[:5]}; the blocks of the files they hold stay allocated",
            flush=True,
        )
    if before and after and freed >= suspect_after and after[0] - before[0] < freed / 2:
        print(
            f"::warning::scratch free rose by {max(0, after[0] - before[0]) / gib:.1f} GiB "
            f"although {freed / gib:.1f} GiB of files were removed: a process may still "
            "hold deleted files open, or something else is writing to the volume",
            flush=True,
        )
    if leaked or (after and after[0] < SCRATCH_HEADROOM_BYTES):
        free_text = f"{after[0] / gib:.1f} GiB" if after else "unknown"
        print(
            f"::error::scratch is still short after reclaiming: {free_text} free, "
            f"{leaked / gib:.1f} GiB left under the dead workers' recordings "
            f"({len(errors)} delete(s) failed); the rest of the queue starts from this",
            flush=True,
        )
    return ReclaimResult(freed, leaked, errors)


def allocated_bytes(root: str) -> int:
    """Disk blocks actually allocated under ``root``, in bytes. Not the apparent
    size: a streaming memmap is a sparse file created at its full length, so
    `st_size` would charge hundreds of GiB that were never written. Unreadable or
    vanishing entries count as zero; a live scratch tree changes under the walk."""
    try:
        top = os.lstat(root)
    except OSError:
        return 0
    if not stat.S_ISDIR(top.st_mode):
        return top.st_blocks * 512
    total = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        else:
                            total += entry.stat(follow_symlinks=False).st_blocks * 512
                    except OSError:
                        continue
        except OSError:
            continue
    return total


# --- Extension-keyed directory recordings (CTF `.ds`, MEF3 `.mefd`) -----------
#
# A CTF recording is a directory `..._meg.ds/` holding `.meg4` (data) + `.res4`/
# `.hc`/... headers. A MEF3 recording is a directory `..._ieeg.mefd/` holding one
# `<CHANNEL>.timd/<CHANNEL>-000000.segd/` per channel, each with `.tdat`/`.tidx`/
# `.tmet`. Both are directories git tracks by their inner files, never the
# directory itself, so each is derived from those files and treated as one
# primary keyed at the directory path; biosigIO/MNE reads the directory whole
# (`read_raw_ctf` / `read_raw_mef`). Generalized into one mechanism (rather than
# copy-pasting the CTF logic for MEF3) because the shape is identical: both are
# recognized by an EXTENSION on a path component, so the recording can be derived
# from any member path alone, without consulting `head_files`. Contrast 4D/BTi
# just below, which is directory-based too but has no extension and needs
# content-based detection instead.


def dir_recording_of(path: str) -> str | None:
    """The `.ds`/`.mefd` recording directory a path belongs to, or None.

    `sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4` ->
    `sub-01/meg/sub-01_task-x_meg.ds`; likewise a `.mefd` member resolves to its
    `.mefd` directory regardless of nesting depth (a MEF3 recording nests a
    `<CHANNEL>.timd/<CHANNEL>-000000.segd/*.tdat` several levels below the
    `.mefd` itself). Returns a directory path itself unchanged. Only the FIRST
    matching component counts (neither `.ds` nor `.mefd` dirs are nested)."""
    parts = path.split("/")
    for i, comp in enumerate(parts):
        lower = comp.lower()
        if any(lower.endswith(ext) for ext in DIR_RECORDING_EXTS):
            return "/".join(parts[: i + 1])
    return None


def is_dir_recording(path: str) -> bool:
    """True if `path` is exactly a `.ds`/`.mefd` recording directory (not a file
    inside one)."""
    stripped = path.lower().rstrip("/")
    return any(stripped.endswith(ext) for ext in DIR_RECORDING_EXTS)


def is_mefd(path: str) -> bool:
    """True if `path` is exactly a MEF3 `.mefd` recording directory."""
    return path.lower().rstrip("/").endswith(MEFD_EXT)


def dir_recordings(head_files) -> set[str]:
    """Every CTF `.ds` / MEF3 `.mefd` recording directory present in `head_files`
    (derived from the inner files, since the directory itself is never a tracked
    path).

    Excludes a directory under an excluded tree (derivatives/sourcedata/code): a
    directory recording's identity is directory-derived rather than an extension
    match on the recording's OWN path, so it needs its own
    `is_excluded_from_discovery` check rather than inheriting `is_primary`'s.
    """
    dirs: set[str] = set()
    for f in head_files:
        d = dir_recording_of(f)
        if d is not None and not is_excluded_from_discovery(d):
            dirs.add(d)
    return dirs


# --- Content-keyed directory recordings (4D/BTi) -------------------------------
#
# 4D/BTi is directory-based like CTF/MEF3, but BIDS gives it NO extension at all,
# so it cannot be derived from a path component the way `dir_recording_of` does.
# Detection is instead by CONTENT: a directory qualifies only when it directly
# (non-nested) contains a `c,rf*`-prefixed processed-data file (conventionally
# `c,rfDC`; a hardware-filtered copy such as `c,rfDC,fn50,o` also matches) AND a
# sibling `config` file -- exactly biosigIO's own `importers.meg._find_bti_pdf`
# gate, so this converter and biosigIO agree on what counts as a BTi recording
# (the converter decides what's a recording; biosigIO decides which file it
# reads -- if they disagreed, the index would describe a different file than was
# actually converted). `config` is checked but never sufficient by itself:
# `.datalad/config` exists in virtually every datalad-tracked dataset, and using
# it alone as the detector would treat every repo as a BTi recording.


def is_bti_marker_name(name: str) -> bool:
    """True for a basename that participates in 4D/BTi directory detection: the
    processed-data file (`c,rf*`) or its required `config` sibling. `hs_file`
    (the optional head-shape sidecar) deliberately does NOT count -- its absence
    or removal must not affect whether a directory is a BTi recording."""
    return name == _BTI_CONFIG_NAME or name.startswith(_BTI_PDF_PREFIX)


def bti_recordings(head_files) -> set[str]:
    """Every 4D/BTi recording directory present in `head_files`, detected by
    content rather than extension (see the module note above): a directory
    qualifies when it directly contains both a `c,rf*` file and a sibling
    `config` file. Excludes a directory under an excluded tree
    (derivatives/sourcedata/code), like `dir_recordings`.
    """
    names_by_dir: dict[str, set[str]] = {}
    for f in head_files:
        names_by_dir.setdefault(os.path.dirname(f), set()).add(os.path.basename(f))
    dirs: set[str] = set()
    for d, names in names_by_dir.items():
        if not d or is_excluded_from_discovery(d):
            continue
        if _BTI_CONFIG_NAME in names and any(n.startswith(_BTI_PDF_PREFIX) for n in names):
            dirs.add(d)
    return dirs


def is_bti_dir(path: str) -> bool:
    """True for a path that is a 4D/BTi recording directory keyed the
    extension-less way (see `bti_recordings`).

    A bare extension check, not a content re-check: every OTHER primary this
    converter discovers carries a real extension (`PRIMARY_EXTS`, or `.ds`/
    `.mefd` via `DIR_RECORDING_EXTS`), so this is only ever called on a path
    already known to be a recording (from the worklist), where "no extension"
    unambiguously means "4D/BTi directory."
    """
    return lower_ext(path) == ""


def bti_pdf_choice(basenames) -> tuple[str | None, bool]:
    """Which processed-data file biosigIO's `_find_bti_pdf` will read among the
    `c,rf*`-prefixed candidates in `basenames`, and whether that choice is
    AMBIGUOUS (more than one candidate present, or falling back off the
    canonical name).

    Mirrors biosigIO 1.2.3's precedence exactly: an exact `c,rfDC` always wins;
    otherwise the first candidate in `sorted()` order (filesystem listing order
    is NOT used -- verified to matter in practice, see biosigIO's module note).
    Neither side of this converter picks a file to convert -- biosigIO alone
    reads the directory -- so this exists purely to let this converter's own
    discovery/materialization logging name the SAME file biosigIO is expected
    to read, keeping the two sides verifiably in agreement (see the module note
    above: if they disagreed, the index would describe a different file than
    was actually converted). Returns (None, False) when no `c,rf*` candidate is
    present at all.
    """
    candidates = sorted(n for n in basenames if n.startswith(_BTI_PDF_PREFIX))
    if not candidates:
        return None, False
    fell_back = "c,rfDC" not in candidates
    chosen = candidates[0] if fell_back else "c,rfDC"
    ambiguous = fell_back or len(candidates) > 1
    return chosen, ambiguous


def events_sibling_for(primary_path: str) -> str:
    """BIDS events sidecar path for a recording (suffix `_events`, ext `.tsv`).

    `sub-01/eeg/sub-01_task-x_eeg.set` -> `sub-01/eeg/sub-01_task-x_events.tsv`.

    The `split-NN` entity is dropped (a split FIF recording shares one events file
    without it): `sub-03/meg/sub-03_task-x_split-01_meg.fif` ->
    `sub-03/meg/sub-03_task-x_events.tsv`.
    """
    d = os.path.dirname(primary_path)
    base = _strip_split(entities_base(filename_stem(primary_path)))
    name = f"{base}_events.tsv"
    return f"{d}/{name}" if d else name


def _bids_entities(stem: str) -> dict[str, str]:
    """Entity key->value pairs from a BIDS stem (`sub-01_task-x_run-2_eeg` ->
    {sub: 01, task: x, run: 2}); the trailing suffix token (no dash) is ignored."""
    ents: dict[str, str] = {}
    for tok in stem.split("_"):
        if "-" in tok:
            k, v = tok.split("-", 1)
            ents[k] = v
    return ents


_UTF16_BOMS = (b"\xff\xfe", b"\xfe\xff")

# Sidecar paths already warned about as non-UTF-8 in this process.
_NON_UTF8_WARNED: set[str] = set()


def _decode_sidecar_bytes(raw: bytes) -> tuple[str, str]:
    """`(text, encoding)` for a sidecar's bytes; see `_decode_sidecar_text`."""
    if raw.startswith(_UTF16_BOMS):
        try:
            return raw.decode("utf-16"), "utf-16"
        except UnicodeDecodeError:
            pass  # a BOM-shaped prefix on bytes that are not UTF-16 after all
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1"), "latin-1"  # maps every byte, never raises


def _decode_sidecar_text(raw: bytes, path: str) -> str:
    """Decode a sidecar's bytes: UTF-8 (a leading BOM dropped), else UTF-16
    when the file opens with a UTF-16 BOM, else a legacy single-byte encoding;
    anything but UTF-8 draws a warning naming the file.

    BIDS requires UTF-8, but real datasets ship Latin-1/Windows-1252 sidecars
    (on005691's channels.tsv spells microvolts `µV` as the single byte 0xb5).
    A strict decode raised UnicodeDecodeError, which is not an OSError, so it
    escaped every caller uncoded and the job retried forever. A UTF-16 BOM
    (Windows "Unicode" text, `FF FE`/`FE FF`) is honored first: cp1252 would
    otherwise accept those bytes and hand every caller text with a NUL between
    each character. cp1252 is tried before latin-1 because it is what Windows
    tools actually write (and a superset of latin-1's printable range);
    latin-1 maps every byte, so this always returns.

    Behavior change for UTF-8 files with a BOM: the strict text-mode read
    kept the BOM as U+FEFF, so `json.loads` raised ValueError and the JSON
    callers (PowerLineFrequency, coordsystem, event descriptions) swallowed
    it and ignored the sidecar. The BOM is now dropped and those sidecars
    parse, so a rebuilt store for such a dataset can newly carry a power-line
    frequency, electrode coordinates or event descriptions it lacked before.
    That is the sidecar's declared content reaching the store, not a new
    guess; a UTF-8 BOM is still UTF-8, so it draws no warning. (A BOM'd TSV
    likewise no longer has its first column header spelled `\\ufeffname`.)

    The warning is issued once per path per process: an inherited sidecar
    (a top-level `eeg.json`, say) is re-read for every recording it applies
    to, and thousands of identical lines would bury the rest of the log.

    Newlines are normalized to `\\n`, as the text-mode reads this replaced did,
    so a CRLF sidecar reaches every caller (and the copy staged for biosigIO)
    exactly as before.
    """
    text, encoding = _decode_sidecar_bytes(raw)
    if encoding != "utf-8-sig" and path not in _NON_UTF8_WARNED:
        _NON_UTF8_WARNED.add(path)
        print(
            f"::warning::{path} is not valid UTF-8 (BIDS requires it); "
            f"read it as {encoding}",
            flush=True,
        )
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _read_repo_text(repo_dir: str, head: str, path: str) -> str | None:
    """Read a git-tracked text file at `head`. Uses the working tree when present
    (local/Hallu mode), else falls back to `git cat-file` -- the workflow clones
    `--no-checkout`, so there is no working tree there. None if unreadable.

    Both sources are read as BYTES and decoded once by `_decode_sidecar_text`,
    so every caller (the channel-count fidelity gate, the channels.tsv staged
    for biosigIO's units, PLF, electrode positions, coordsystem and event
    descriptions) gets the same non-UTF-8 fallback."""
    raw: bytes | None = None
    try:
        with open(os.path.join(repo_dir, path), "rb") as fh:
            raw = fh.read()
    except OSError:
        pass
    if raw is None:
        try:
            raw = subprocess.check_output(
                ["git", "-C", repo_dir, "cat-file", "blob", f"{head}:{path}"],
                stderr=subprocess.DEVNULL,
            )
        except (subprocess.CalledProcessError, OSError):
            return None
    return _decode_sidecar_text(raw, path)


def power_line_frequency_for(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> float | None:
    """BIDS PowerLineFrequency (Hz) for a recording, resolved via the inheritance
    principle: among the `_<suffix>.json` sidecars sitting in the recording's
    directory or an ancestor whose entities are a subset of the recording's, the
    most specific one that declares PowerLineFrequency wins. Returns None when none
    declare it (so the viewer leaves the notch off).

    Sidecars are git-tracked text (not annexed); they are read at `head` from the
    working tree when present and `git cat-file` otherwise, so this works in both
    the no-checkout workflow clone and the local/Hallu working tree -- one grep of
    the head file list, then a couple of small reads, no annex download.
    """
    stem = filename_stem(primary_path)
    suffix = stem.rsplit("_", 1)[-1].lower() if "_" in stem else ""
    if not suffix:
        return None
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(stem)
    needle = f"_{suffix}.json"
    candidates: list[tuple[int, int, str]] = []
    for f in head_files:
        if not f.endswith(needle):
            continue
        cdir = os.path.dirname(f)
        # Applicable only if the sidecar is in the recording's dir or an ancestor.
        if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
            continue
        cents = _bids_entities(filename_stem(f))
        # ...and its entities must be a subset of the recording's.
        if any(rec_ents.get(k) != v for k, v in cents.items()):
            continue
        depth = cdir.count("/") + (1 if cdir else 0)
        candidates.append((depth, len(cents), f))
    candidates.sort()  # least specific first; the most specific value overrides
    plf: float | None = None
    for _, _, f in candidates:
        text = _read_repo_text(repo_dir, head, f)
        if text is None:
            continue
        try:
            data = json.loads(text)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        v = data.get("PowerLineFrequency")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            plf = float(v)
    return plf


def store_total_channels(meta: dict) -> int:
    """Total channels a built store serves, summed across its groups (a group
    with a missing/None n_channels counts 0). Compared against
    ``expected_channel_count_for`` by the fidelity gate in ``convert_one``."""
    return sum(int(g.get("n_channels") or 0) for g in meta.get("groups", []))


def channels_tsv_for(primary_path: str, head_files) -> str | None:
    """Repo-relative path of the `_channels.tsv` that applies to a recording, or
    None when none does.

    BIDS inheritance, closest-file-wins: among the sidecars in the recording's
    directory or an ancestor whose entities are a subset of the recording's, the
    most specific one wins. Unlike the JSON sidecars there is no per-field merge
    across levels -- a TSV is adopted whole.

    Two callers, deliberately the same resolution: the fidelity gate reads it for
    the ground-truth channel count, and the converter hands it to biosigIO's
    `bids.apply_channels_tsv` so the served samples are in the unit the sidecar
    declares. They must agree about WHICH file applies, or the gate would be
    checking a different sidecar than the one that shaped the store.
    """
    stem = filename_stem(primary_path)
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(stem)
    candidates: list[tuple[int, int, str]] = []
    for f in head_files:
        if not f.endswith("_channels.tsv"):
            continue
        cdir = os.path.dirname(f)
        if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
            continue
        cents = _bids_entities(filename_stem(f))
        if any(rec_ents.get(k) != v for k, v in cents.items()):
            continue
        depth = cdir.count("/") + (1 if cdir else 0)
        candidates.append((depth, len(cents), f))
    if not candidates:
        return None
    candidates.sort()
    return candidates[-1][2]  # most specific


def channels_tsv_names(text: str) -> list[str] | None:
    """The `name` column of a channels.tsv, in file order and with repeats
    kept, or None when the header has no `name` column (biosigIO then applies
    nothing, so there is no join to report on).

    Read the way biosigIO reads it (`bids._read_channels_tsv`, pandas
    `read_csv(sep="\\t")`): tab-separated with `"` quoting (so `"Fp1"` is
    `Fp1`, and a quoted tab stays in the name), blank lines skipped, the header
    matched exactly, each name stripped as biosigIO strips it when matching.
    The two must agree, or `sidecar_join_report` would describe a join biosigIO
    never made.
    """
    rows = [
        row for row in csv.reader(io.StringIO(text), delimiter="\t")
        if any(cell.strip() for cell in row)
    ]
    if not rows:
        return None
    header = rows[0]
    if "name" not in header:
        return None
    col = header.index("name")
    return [
        cols[col].strip()
        for cols in rows[1:]
        if len(cols) > col and cols[col].strip()
    ]


# How many unmatched labels an index entry names. Enough to recognize the
# pattern (a case difference, a suffix), small enough that a dataset with
# thousands of stores does not pay for it in index bytes (#1178).
UNMATCHED_EXAMPLES_MAX = 5

# How many case-only matches an index entry names, as `"<sidecar name> ->
# <channel>"`. The same reasoning as UNMATCHED_EXAMPLES_MAX: enough to see the
# pattern, and no per-channel map in every store's entry.
CASE_MATCH_EXAMPLES_MAX = 5

# biosigIO's (>= 1.2.10, biosigio#140) key in its `channels_tsv_units` account:
# `{sidecar_name: channel_label}` for every row it matched to a channel only by
# ignoring case. One entry per such channel, so it is never published as is.
BIOSIGIO_CASE_MATCH_KEY = "matched_case_insensitive"


def bound_units_report(report: dict) -> tuple[dict, dict[str, str]]:
    """biosigIO's `channels_tsv_units` account as the index publishes it, and
    the full case-match map it carried.

    Every key biosigIO reports is republished unchanged except
    `matched_case_insensitive`, whose value grows with the channel count (a
    300-channel recording whose sidecar spells every label in another case is
    300 entries, in every store's entry). It is replaced by:

    - ``matched_case_only``: how many channels a row reached only by ignoring
      case, so the sidecar's type and unit WERE applied to them. Present only
      when non-zero, like ``unmatched_case_only``.
    - ``matched_case_only_examples``: up to CASE_MATCH_EXAMPLES_MAX of those
      matches as ``"<sidecar name> -> <channel label>"``, in biosigIO's order
      (channels.tsv row order). Present exactly when the count is.

    The map is returned separately, for `sidecar_join_report`, which needs
    every matched channel to know which ones the sidecar did NOT reach. A
    value that is not a map (a biosigIO shape this code does not know) is
    dropped rather than republished, and contributes no matches.
    """
    out = {k: v for k, v in report.items() if k != BIOSIGIO_CASE_MATCH_KEY}
    raw = report.get(BIOSIGIO_CASE_MATCH_KEY)
    matches = (
        {str(k): str(v) for k, v in raw.items()} if isinstance(raw, dict) else {}
    )
    if matches:
        out["matched_case_only"] = len(matches)
        out["matched_case_only_examples"] = [
            f"{name} -> {label}"
            for name, label in list(matches.items())[:CASE_MATCH_EXAMPLES_MAX]
        ]
    return out, matches


class SidecarJoinReport(TypedDict, total=False):
    """What `sidecar_join_report` adds to an index entry's `units_report`."""

    unmatched_channels: int
    unmatched_case_only: int
    unmatched_raw_label: int
    unmatched_examples: list[str]


def sidecar_join_report(
    store_labels: list[str],
    sidecar_names: list[str],
    renames: dict[str, str],
    matched_case_insensitive: dict[str, str] | None = None,
) -> SidecarJoinReport:
    """Account for the store channels channels.tsv did NOT reach.

    biosigIO applies a sidecar row to the channel whose label equals the row's
    `name` exactly, and says nothing (a DEBUG log line) about a channel no row
    names: its `units_report` counts only what the rows it matched did. So a
    channel the sidecar misses keeps the importer's type and unit while the
    report looks clean. Two ways that happens are worth naming, because each
    looks like a match to a person reading the sidecar:

    - ``unmatched_raw_label``: the sidecar names the label the FILE carries,
      but the store holds biosigIO's de-duplicated one (``T8-P8`` in the
      sidecar, ``T8-P8-0``/``T8-P8-1`` in the store). `renames` is the store's
      ``channel_labels_deduplicated`` map, ``{new_label: file_label}``.
    - ``unmatched_case_only``: the names differ only in case (EDF header
      ``FP1-F7``, sidecar ``Fp1-F7``; biosigio#136).

    ``unmatched_channels`` is present whenever there were store labels to
    join, so 0 is a positive statement that every store channel met a row;
    the rest appear only when non-zero. With no store labels (a store whose
    groups record none) there was no join, and the report is empty rather
    than a vacuous 0.
    biosigio 1.2.9 joins by exact match only, so a case-only difference is
    never applied and ``unmatched_case_only`` is a true statement about it.
    biosigio 1.2.10 (biosigio#140) also matches a row to the one channel that
    differs from it only in case, and reports each such match as
    ``matched_case_insensitive``, ``{sidecar_name: channel_label}``, in its
    `channels_tsv_units` account (which `bound_units_report` republishes as a
    count and a few examples, never the map). Pass that map as
    `matched_case_insensitive` and those channels count as matched, because the
    sidecar DID reach them; what is left under ``unmatched_case_only`` is then
    only the ambiguous rows biosigIO warns about and leaves unapplied. Without
    the map (biosigio 1.2.9, or no case-only match) every non-exact name is
    unmatched.
    """
    if not store_labels:
        return {}
    exact = set(sidecar_names)
    folded = {name.casefold() for name in sidecar_names}
    matched_by_case = set((matched_case_insensitive or {}).values())
    unmatched = [
        label for label in store_labels
        if label not in exact and label not in matched_by_case
    ]
    report: SidecarJoinReport = {"unmatched_channels": len(unmatched)}
    if not unmatched:
        return report
    raw = [label for label in unmatched if renames.get(label) in exact]
    case_only = [
        label for label in unmatched
        if label not in raw
        and (label.casefold() in folded or renames.get(label, "").casefold() in folded)
    ]
    if raw:
        report["unmatched_raw_label"] = len(raw)
    if case_only:
        report["unmatched_case_only"] = len(case_only)
    report["unmatched_examples"] = unmatched[:UNMATCHED_EXAMPLES_MAX]
    return report


# --- events -------------------------------------------------------------------
# ONE parse of the events.tsv a store was built from feeds BOTH the per-store
# `n_events`/`trial_types` in index.json (#1059) and the rows of
# `<id>/zarr/events.parquet` (#1060). Two parsers would eventually disagree, and
# a summary that contradicts the file a client can download is worse than no
# summary: the summary is what a client uses to decide whether to fetch at all.

# The published columns, in order (#1060). Every string one is dictionary-encoded
# in the parquet; `onset_s` is float64, `duration_s` float32, `sample_index`
# int64. A remaining events.tsv column passes through under its own name -- with
# `x_` prefixed only when that name would collide with one of these.
EVENTS_FIXED_COLUMNS = (
    "store_path",
    "subject",
    "session",
    "task",
    "run",
    "onset_s",
    "duration_s",
    "sample_index",
    "group_name",
    "trial_type",
    "value",
    "hed",
)
# events.tsv column (lower-cased) -> the fixed column it feeds. BIDS spells the
# HED column `HED`, and real datasets use both cases, so the match is
# case-insensitive; a second column that lower-cases to the same name passes
# through instead of overwriting the first.
EVENTS_SOURCE_COLUMNS = {
    "onset": "onset_s",
    "duration": "duration_s",
    "trial_type": "trial_type",
    "value": "value",
    "hed": "hed",
}
EVENTS_PASSTHROUGH_PREFIX = "x_"
# BIDS's null. A cell carrying it becomes a real null rather than three literal
# characters a client would have to know to filter out.
EVENTS_NA = "n/a"


class ParsedEvents(TypedDict):
    """A BIDS events.tsv exactly as read: the header, and the cells of each data
    row. Values stay strings here -- typing them is the row builder's job, and
    the summary needs only to count."""

    columns: list[str]
    rows: list[list[str]]


def parse_events_tsv(events_text: str | None) -> ParsedEvents | None:
    """Parse the text of the events.tsv the converter applied. `None` in, `None`
    out -- "no events.tsv applies", which is not the same as an empty one.

    Deliberately minimal (header row, tab-separated, no quoting rules), which is
    what BIDS specifies. The one non-obvious rule is the UTF-8 BOM: a
    spreadsheet-exported events.tsv starts with U+FEFF, which would otherwise
    make the first column "\\ufeffonset" -- silently costing every row its onset,
    and therefore its sample index. nm000329 ships exactly that file.

    Blank lines are dropped anywhere, so a trailing newline is not an event.
    """
    if events_text is None:
        return None
    lines = [ln for ln in events_text.lstrip("\ufeff").splitlines() if ln.strip()]
    if not lines:
        return {"columns": [], "rows": []}
    return {
        "columns": [c.strip() for c in lines[0].split("\t")],
        "rows": [ln.split("\t") for ln in lines[1:]],
    }


# A trial_type is a label, so the index keys its counts by the value itself. Some
# datasets put a record there instead: nm000229 (MEG-MASC) writes the whole
# stringified row ("{'story': 'easy_money', ..., 'start': 93.72, ...}", about 290
# characters) into the column for some recordings, so no two of their events share
# a value and the index holds a key of that length per event. A value longer than
# TRIAL_TYPE_KEY_MAX Unicode code points is therefore keyed by a fixed
# 28-character form, `<first 13 code points>~<first 14 hex digits of the SHA-256
# of the value's UTF-8 bytes>`. Counts stay per DISTINCT value, so nothing is merged
# and the sum of the counts is unchanged; the full value remains in the
# `trial_type` column of events.parquet (when that file is published), which is
# the lossless record. 128 keeps every ordinary label as itself: the longest label
# key in the other published datasets is 104 characters, while a whole-record
# value is at least 120.
TRIAL_TYPE_KEY_MAX = 128
_TRIAL_TYPE_PREFIX_CHARS = 13
_TRIAL_TYPE_DIGEST_CHARS = 14
_TRIAL_TYPE_SEPARATOR = "~"
TRIAL_TYPE_DIGEST_KEY_LEN = (
    _TRIAL_TYPE_PREFIX_CHARS + len(_TRIAL_TYPE_SEPARATOR) + _TRIAL_TYPE_DIGEST_CHARS
)
if TRIAL_TYPE_DIGEST_KEY_LEN > TRIAL_TYPE_KEY_MAX:
    # Idempotence of shorten_trial_types rests on this: a digest key must itself
    # count as a key that fits.
    raise RuntimeError("a trial_type digest key must be no longer than TRIAL_TYPE_KEY_MAX")


def trial_type_key(value: str, salt: int = 0) -> str:
    """The key standing for a `trial_type` value longer than TRIAL_TYPE_KEY_MAX
    (it is not defined for a shorter one, which is its own key): its first 13
    code points, `~`, and 14 hex digits of a SHA-256, 28 characters in all.

    The digest is over the value's UTF-8 bytes when `salt` is 0, which is the key a
    reader computes from a value in events.parquet unless that key was already
    taken. A key can be taken (a hash collision, or a short value shaped like a
    key), and `shorten_trial_types` then steps `salt` to 1, 2, ... and hashes the
    UTF-8 bytes of the decimal salt, one NUL byte, then the value, instead."""
    material = value if salt == 0 else f"{salt}\0{value}"
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return (
        f"{value[:_TRIAL_TYPE_PREFIX_CHARS]}{_TRIAL_TYPE_SEPARATOR}"
        f"{digest[:_TRIAL_TYPE_DIGEST_CHARS]}"
    )


def shorten_trial_types(counts: dict[str, int]) -> dict[str, int]:
    """`counts` re-keyed so that no key is longer than TRIAL_TYPE_KEY_MAX, sorted
    by key.

    A value of TRIAL_TYPE_KEY_MAX code points or fewer is its own key. A longer one
    gets `trial_type_key(value)`, and keys are unique by construction: values that
    fit claim their own key first, then the long values sorted by code point, and one
    whose key is taken (a hash collision, or a short value that happens to look
    like one) is re-hashed with the next salt. The result therefore depends only on
    the set of values, never on the order they arrived in, and the counts are never
    summed together.

    Idempotent: every key it returns fits, so applying it to its own output (or
    to an index entry written by this function) changes nothing. That is what
    lets `_normalize_store_entry` re-key an entry carried over from an older run.
    """
    shortened = {v: n for v, n in counts.items() if len(v) <= TRIAL_TYPE_KEY_MAX}
    for value in sorted(v for v in counts if len(v) > TRIAL_TYPE_KEY_MAX):
        salt = 0
        key = trial_type_key(value)
        while key in shortened:
            salt += 1
            key = trial_type_key(value, salt)
        shortened[key] = counts[value]
    return dict(sorted(shortened.items()))


def events_summary_of(parsed: ParsedEvents | None) -> dict:
    """`{n_events, trial_types}` for a parsed events.tsv, or `{}` when none
    applies.

    Published per store so a client can judge whether a dataset is worth opening,
    and which epoching strategy fits, without reading a signal byte (#1059). The
    counts describe the SAME file the parquet rows are built from and the SAME
    file biosigIO was handed -- one parse, one set of numbers.

    An empty `trial_types` means the file has no `trial_type` column (or every
    row is `n/a`); the absence of both keys means there was no events.tsv at all.
    The distinction matters to a consumer deciding whether "no trial types" is a
    property of the data or of the pipeline.

    A `trial_types` key is the value itself when it has TRIAL_TYPE_KEY_MAX code
    points or fewer, and `trial_type_key(value)` otherwise (see
    `shorten_trial_types`), so a store's entry has at most one key per event and
    no key is longer than TRIAL_TYPE_KEY_MAX. Values are measured after stripping,
    and blank or `n/a` values are not counted at all.
    """
    if parsed is None:
        return {}
    try:
        col = [c.lower() for c in parsed["columns"]].index("trial_type")
    except ValueError:
        col = -1
    counts: dict[str, int] = {}
    if col >= 0:
        for fields in parsed["rows"]:
            if col >= len(fields):
                continue
            value = fields[col].strip()
            if not value or value.lower() == EVENTS_NA:
                continue
            counts[value] = counts.get(value, 0) + 1
    return {"n_events": len(parsed["rows"]), "trial_types": shorten_trial_types(counts)}


def events_summary(events_text: str | None) -> dict:
    """`{n_events, trial_types}` straight from the events.tsv text. The parse the
    parquet rows come from, so the two can never disagree."""
    return events_summary_of(parse_events_tsv(events_text))


def _event_cell(fields: list[str], col: int) -> str | None:
    """One cell as a published string: `None` for missing, blank, or `n/a`."""
    if col < 0 or col >= len(fields):
        return None
    value = fields[col].strip()
    return None if not value or value.lower() == EVENTS_NA else value


def _event_number(fields: list[str], col: int) -> float | None:
    """One cell as a float, or `None` when it is absent or not a number. A
    malformed onset yields a null onset and a null `sample_index` rather than a
    dropped row: the row still says an event was declared, and a client can see
    that its position is unknown instead of silently getting one fewer event."""
    raw = _event_cell(fields, col)
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def sample_index_for(onset_s: float | None, rate: float | None) -> int | None:
    """The level-0 sample an onset falls on, or `None` when it cannot be computed.

    ``math.floor(onset_s * rate + 0.5)``, where `rate` is the group's SERVING
    rate (the level-0 `rate` attr the index republishes). Written out rather than
    called ``round()`` because the two DIFFER: Python's ``round()`` is
    banker's rounding, which breaks an exact .5 tie toward the even integer
    (``round(0.5) == 0``, ``round(1.5) == 2``), while this ties UP everywhere
    (``0.5 -> 1``, ``1.5 -> 2``). A tie is not exotic here -- an onset of 0.5 s
    at 1 Hz, or any onset landing on a half sample at the serving rate, hits it
    -- and a client that reimplements the column with ``round()`` would disagree
    with the published value on exactly those rows, which is the failure the
    column exists to prevent.

    That is the whole formula, and the reason it is this simple is worth writing
    down once, because the point of publishing the column at all is that a client
    should not have to re-derive it (#1060):

    * biosigIO resamples level 0 to ``target_rate = min(native_rate, cap)`` with
      ``scipy.signal.resample_poly(x, up, down)``, ``up/down =
      Fraction(round(target), round(native))``, and trims/pads the result to
      ``n_out = round(n_native * target / native)``. So level 0 is exactly the
      grid ``t[n] = n / target_rate`` over the same span as the source -- both
      exporters, in-memory and streaming, share ``_resample_channel``.
    * ``resample_poly`` is ZERO-PHASE: it compensates the polyphase FIR's group
      delay internally, so output sample ``n`` is at absolute time ``n / rate``
      with no delay term to subtract. This is verified against a real
      1000 Hz -> 250 Hz recording in the test suite (nm000329) by correlating the
      served level-0 signal against the native samples taken at the same absolute
      times; a filter delay would show up there as a non-zero lag.

    The index is thus the only place the relation is known exactly -- a client
    that guesses `rate` from the acquisition rate, or that subtracts a delay it
    assumes is there, is wrong by a fraction of a sample everywhere the ratio is
    not an integer.

    NOT clamped to the group's length. An onset past the end of the recording is
    a property of the data, and a clamped index would be indistinguishable from
    an event that genuinely lands on the last sample; clients bound-check against
    `groups[].n_samples`, which the index publishes beside this.
    """
    if onset_s is None or rate is None:
        return None
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(rate) or rate <= 0 or not math.isfinite(onset_s):
        return None
    return math.floor(onset_s * rate + 0.5)


def _passthrough_column_names(columns: list[str]) -> dict[int, str]:
    """Source-column index -> published column name, for the events.tsv columns
    that are not one of the five the fixed columns consume.

    `x_` is prefixed only on a collision -- with a fixed column name, or with a
    name already taken (a duplicate header). Prefixing until free rather than
    dropping: a duplicated or awkwardly-named column is malformed input, and
    losing its values silently is the worse failure."""
    taken = set(EVENTS_FIXED_COLUMNS)
    consumed: set[str] = set()
    out: dict[int, str] = {}
    for i, raw in enumerate(columns):
        name = raw.strip()
        if not name:
            continue
        key = name.lower()
        if key in EVENTS_SOURCE_COLUMNS and key not in consumed:
            consumed.add(key)
            continue
        while name in taken:
            name = EVENTS_PASSTHROUGH_PREFIX + name
        taken.add(name)
        out[i] = name
    return out


def event_rows_for_store(
    zarr_rel: str,
    primary_path: str,
    groups: list[dict] | None,
    parsed: ParsedEvents | None,
) -> dict[str, list] | None:
    """The `events.parquet` rows for one store, as a column -> values mapping, or
    `None` when the store contributes none.

    ONE ROW PER (EVENT, CHANNEL GROUP). A store's groups are concurrent streams
    of one recording at different rates (biosigIO names them
    `<modality>_<rate>hz`), so a single onset has a different sample index in
    each; `group_name` is what tells the rows apart, and joining on it plus
    `store_path` is how a client gets the index that matches the array it is
    about to read. Rows are ordered by onset, then group name.

    `subject`/`session`/`task`/`run` come from the recording's BIDS entities so
    the file can be filtered without a join back to the index; `session` and
    `run` are null for a dataset that uses neither.
    """
    if parsed is None or not parsed["rows"]:
        return None
    named = sorted(
        (g for g in (groups or []) if isinstance(g, dict) and g.get("name")),
        key=lambda g: str(g["name"]),
    )
    if not named:
        return None

    lower = [c.lower() for c in parsed["columns"]]

    def source(name: str) -> int:
        return lower.index(name) if name in lower else -1

    onset_col = source("onset")
    duration_col = source("duration")
    trial_col = source("trial_type")
    value_col = source("value")
    hed_col = source("hed")
    passthrough = _passthrough_column_names(parsed["columns"])

    ents = _bids_entities(filename_stem(primary_path))
    subject = ents.get("sub")
    session = ents.get("ses")
    task = ents.get("task")
    run = ents.get("run")

    cols: dict[str, list] = {name: [] for name in EVENTS_FIXED_COLUMNS}
    for name in passthrough.values():
        cols[name] = []

    rows = parsed["rows"]
    onsets = [_event_number(f, onset_col) for f in rows]
    durations = [_event_number(f, duration_col) for f in rows]
    # Onset order, with unparseable onsets last and file order preserved within
    # a tie -- so the published order is deterministic for a given file.
    order = sorted(
        range(len(rows)),
        key=lambda i: (onsets[i] is None, onsets[i] if onsets[i] is not None else 0.0, i),
    )
    for i in order:
        fields = rows[i]
        for group in named:
            cols["store_path"].append(zarr_rel)
            cols["subject"].append(subject)
            cols["session"].append(session)
            cols["task"].append(task)
            cols["run"].append(run)
            cols["onset_s"].append(onsets[i])
            cols["duration_s"].append(durations[i])
            cols["sample_index"].append(sample_index_for(onsets[i], group.get("rate")))
            cols["group_name"].append(str(group["name"]))
            cols["trial_type"].append(_event_cell(fields, trial_col))
            cols["value"].append(_event_cell(fields, value_col))
            cols["hed"].append(_event_cell(fields, hed_col))
            for col, name in passthrough.items():
                cols[name].append(_event_cell(fields, col))
    return cols


def events_row_alert(
    primary_path: str,
    parsed: ParsedEvents | None,
    rows: dict[str, list] | None,
) -> str | None:
    """The `::warning::` a store's events deserve, or None when they are fine.

    Two conditions, both invisible from the outside otherwise -- the parquet
    either does not mention the store at all, or mentions it with a column of
    nulls, and neither is distinguishable from "this recording has no events":

    * The recording HAS events and the store has no named channel group, so
      there is nothing to attach a rate (and therefore a sample index) to and
      the store contributes no rows at all.
    * Every published row has a null `sample_index`: either no onset cell parsed
      as a number, or the group carries no rate. A client gets events it cannot
      epoch.

    Pure, and separate from the caller, because the first condition cannot be
    reached through a real conversion (`convert_one` refuses to publish a store
    with no channel groups) -- so a test can only reach that branch here.
    """
    if rows is None:
        if parsed and parsed["rows"]:
            return (
                f"::warning::{primary_path} has {len(parsed['rows'])} event(s) but "
                "the store has no channel groups, so it contributes no rows to "
                "events.parquet"
            )
        return None
    if rows["sample_index"] and all(v is None for v in rows["sample_index"]):
        return (
            f"::warning::no usable sample index for any event in {primary_path}: "
            f"{len(rows['sample_index'])} row(s) published with sample_index null "
            "(unparseable onsets, or a group with no rate)"
        )
    return None


def expected_channel_count_for(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> int | None:
    """Channel count the recording's BIDS `_channels.tsv` declares, or None when
    no applicable channels.tsv exists (nothing to check against).

    Resolution mirrors ``power_line_frequency_for``: among `_channels.tsv` files
    in the recording's directory or an ancestor whose entities are a subset of
    the recording's, the most specific wins. channels.tsv is git-tracked text
    (never annexed), so this is a head-file-list scan plus one small read.

    This is one of the two ground truths for the post-conversion fidelity
    gate (`channel_gate_verdict`); the other is the file's own header
    (`file_declared_channel_count`). Which one decides depends on whether the
    header could be read. With it, a store short of the HEADER is withheld
    (``ChannelCountMismatch``), and a store short of this number but not of the
    header is published with the sidecar's over-declaration disclosed. Without
    it, a store short of this number is withheld.

    Unlike PLF's per-field JSON inheritance, only the single most specific
    candidate is read (BIDS TSV inheritance is closest-file-wins, not a
    merge). If that read fails or the file has no data rows, this returns
    None and the sidecar takes no part in the gate for the recording. The
    gate does not go off with it: the header still gates the recording
    wherever it is readable. Only a recording with no usable sidecar AND an
    unreadable header has nothing to check against -- fail-open by design.
    """
    best = channels_tsv_for(primary_path, head_files)
    if best is None:
        return None
    text = _read_repo_text(repo_dir, head, best)
    if text is None:
        # NOT the same as "no channels.tsv exists". Ground truth is present at
        # HEAD and we failed to consult it. The file's own header still gates
        # the recording where it is readable, so a repeat of biosigio#110
        # silently truncating a 74-channel recording to one (nemarDatasets/
        # on002718#1) is still caught; a recording whose header is unreadable
        # too is unchecked, and that is the case worth a line in the log, on
        # precisely the recording most likely to be mid-incident. Fail open,
        # but say so.
        print(
            f"::warning::could not read {best}; the channel-count gate compares "
            "this recording with its file header alone, and with nothing if "
            "that header is unreadable too",
            flush=True,
        )
        return None
    return channels_tsv_row_count(text) or None


# Widths a BrainVision binary file is written in: `INT_16` and `IEEE_FLOAT_32`.
_BRAINVISION_SAMPLE_BYTES = (2, 4)


def snap_sample_width(bytes_per_sample: float) -> int | None:
    """The BrainVision sample width ``bytes_per_sample`` is within 3% of, or None.
    The slack covers a header and markers; a figure that is not close to a real width
    means the duration or the channel count describes something else, and is not used."""
    if not math.isfinite(bytes_per_sample):
        return None
    for width in _BRAINVISION_SAMPLE_BYTES:
        if abs(bytes_per_sample - width) <= 0.03 * width:
            return width
    return None


def sample_bytes_from_sidecar(
    repo_dir: str,
    primary_path: str,
    head_files: set[str],
    head: str,
    size_bytes: int,
    n_channels: int | None,
) -> int | None:
    """Bytes per sample a BrainVision recording is stored in, worked out from what
    admission can read without downloading it: the recording's size, its channel count,
    and the sidecar's ``SamplingFrequency`` and ``RecordingDuration`` (git-tracked text).
    None when any of them is missing, or when they do not add up to a width a
    BrainVision file is written in, in which case the narrowest width is assumed.

    Only ``.vhdr``: the header that states the width (``BinaryFormat``) is annexed and
    is not there to read yet, and BrainVision is the format whose recordings reach
    hundreds of GiB. An answer of 2 is the default and changes nothing; an answer of 4
    is what lets a float32 recording be projected at the memory it needs rather than at
    twice that."""
    if lower_ext(primary_path) != ".vhdr" or not n_channels or n_channels <= 0 or size_bytes <= 0:
        return None
    sidecar = posixpath.splitext(primary_path)[0] + ".json"
    if sidecar not in head_files:
        return None
    text = _read_repo_text(repo_dir, head, sidecar)
    if text is None:
        return None
    try:
        doc = json.loads(text)
        rate = float(doc["SamplingFrequency"])
        seconds = float(doc["RecordingDuration"])
    except (ValueError, KeyError, TypeError):
        return None
    if not (math.isfinite(rate) and math.isfinite(seconds) and rate > 0 and seconds > 0):
        return None
    return snap_sample_width(size_bytes / (n_channels * rate * seconds))


def channels_tsv_row_count(text: str) -> int:
    """Data rows in a channels.tsv: every non-blank line after the header. The
    one counting rule the fidelity gate and `find_collapsed_channel_stores.py`
    share, so the detector flags exactly what the gate would have refused."""
    return sum(1 for line in text.splitlines()[1:] if line.strip())


# EDF+/BDF+ carry their annotations as a pseudo-signal with this label; it is
# never a data channel, and no exporter serves it as one.
EDF_ANNOTATION_LABELS = frozenset({"EDF Annotations", "BDF Annotations"})


def file_declared_channel_count(primary_local: str) -> int | None:
    """Data-channel count the recording file's OWN header declares, read with no
    importer in between, or None when the format has no cheap header to read or
    the header cannot be read.

    This is the second ground truth the fidelity gate needs. channels.tsv alone
    cannot tell "the importer dropped channels" (biosigio#110, the failure the
    gate exists for) from "the sidecar lists channels this file never had": on
    2026-09-22, every channel_count_mismatch sampled across ten datasets
    (on004789, on006914, on004551, on004703, on005280, on006107, on007095,
    on007118-on007120) was the second kind, with the store holding exactly the
    file's channels. The header is independent of biosigIO by construction, so
    a real truncation still shows up as a store short of THIS number.

    EDF/BDF: `ns` at bytes 252-256, then ns 16-byte labels; the annotation
    pseudo-signal is not a channel. The fixed-width fields are decoded the way
    biosigio's tolerant probe decodes them (`_edf_field`): cut at the first NUL,
    then strip, because real writers NUL-pad short values (biosigio#109) and
    biosigIO converts those files. BrainVision: `NumberOfChannels` in the
    `.vhdr`'s `[Common Infos]` section. FIF (`.fif`, and `.fif.gz`, which MNE
    reads transparently): `nchan` from the measurement info, read with
    `mne.io.read_info`, which parses the header tags and never loads data. For
    a split recording that is the chain head's info, which every split shares.
    on000117's MEG sidecars list CHPI and EEG channels the FIF never had.
    EEGLAB `.set` (classic MAT v5/v7 and MATLAB v7.3): `nbchan`, read without
    the sample matrix, and only where it provably equals the rows biosigIO
    serves (`_eeglab_declared_channel_count`). on003645's EEG recordings hold
    75 channels under a subject-level channels.tsv listing its 404 MEG ones.

    None leaves the gate on channels.tsv alone -- exactly its behavior before
    this existed. For a format that normally HAS a readable header here (the
    four above) a None from an unreadable one is not silent: it is worth a line
    in the log, because the recording the converter just read but whose header
    it cannot is the one the header gate then does not cover. Formats with no
    cheap header (CTF, MEF3, 4D/BTi, KIT, ...) return None quietly. A declared
    count of zero or less is unreadable too, not a recording with no channels.
    """
    if primary_local.lower().endswith((".fif", ".fif.gz")):
        return _fif_declared_channel_count(primary_local)
    ext = lower_ext(primary_local)
    if ext in (".edf", ".bdf"):
        return _edf_declared_channel_count(primary_local)
    if ext == ".vhdr":
        return _vhdr_declared_channel_count(primary_local)
    if ext == ".set":
        return _eeglab_declared_channel_count(primary_local)
    return None


def _warn_unreadable_header(kind: str, path: str, why: str) -> None:
    """The one line a header the converter cannot read earns: what, where, why,
    and what the gate does instead (the FIF reader says the same)."""
    print(
        f"::warning::could not read the {kind} header of {path} for its channel "
        f"count ({why}); the gate uses channels.tsv alone",
        flush=True,
    )


def _edf_field(raw: bytes) -> str:
    """One fixed-width EDF/BDF ASCII header field, decoded the way biosigio's
    `_decode_field` decodes it: cut at the first NUL, then strip. Real files pad
    short values with NULs instead of spaces (b'4\\x00\\x00\\x00'), and
    `strip()` alone leaves the NULs, so `int()` refuses the number and an
    annotation label no longer equals `EDF_ANNOTATION_LABELS`."""
    return raw.decode("latin-1").split("\x00", 1)[0].strip()


def _edf_declared_channel_count(path: str) -> int | None:
    kind = "BDF" if lower_ext(path) == ".bdf" else "EDF"
    try:
        with open(path, "rb") as fh:
            head = fh.read(256)
            if len(head) < 256:
                _warn_unreadable_header(
                    kind, path, f"{len(head)} bytes, short of the 256-byte main header"
                )
                return None
            try:
                ns = int(_edf_field(head[252:256]))
            except ValueError:
                _warn_unreadable_header(
                    kind, path, f"the signal-count field {head[252:256]!r} is not an integer"
                )
                return None
            if ns <= 0:
                _warn_unreadable_header(kind, path, f"the header declares {ns} signals")
                return None
            raw = fh.read(16 * ns)
    except OSError as exc:
        _warn_unreadable_header(kind, path, f"{type(exc).__name__}: {exc}")
        return None
    if len(raw) < 16 * ns:
        _warn_unreadable_header(
            kind, path, f"the label block holds {len(raw)} of {16 * ns} bytes"
        )
        return None
    labels = [_edf_field(raw[i * 16:(i + 1) * 16]) for i in range(ns)]
    return sum(1 for label in labels if label not in EDF_ANNOTATION_LABELS)


def _vhdr_common_infos(text: str) -> str | None:
    """The body of a BrainVision header's `[Common Infos]` section, or None.

    The one place the section rule lives, shared by the channel count and the
    data-file name below. Scoped to that section because it is where MNE reads
    both from, so a comment or a key in any other section can never supply
    them. The section name is matched exactly and the key, by the callers,
    without regard to case, because that is how MNE's configparser reads them:
    `numberofchannels=4` converts, and a case-sensitive key left such a file
    with no header count."""
    section = re.search(r"^\[Common Infos\][^\n]*\n(.*?)(?=^\[|\Z)", text, re.M | re.S)
    return section.group(1) if section else None


def _vhdr_declared_channel_count(path: str) -> int | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as exc:
        _warn_unreadable_header("BrainVision", path, f"{type(exc).__name__}: {exc}")
        return None
    section = _vhdr_common_infos(text)
    m = section and re.search(
        r"^\s*NumberOfChannels\s*=\s*(\d+)", section, re.MULTILINE | re.IGNORECASE
    )
    if not m:
        _warn_unreadable_header(
            "BrainVision", path, "no NumberOfChannels in its [Common Infos] section"
        )
        return None
    count = int(m.group(1))
    if count <= 0:
        _warn_unreadable_header("BrainVision", path, f"NumberOfChannels is {count}")
        return None
    return count


def _fif_declared_channel_count(path: str) -> int | None:
    """`nchan` from a FIF's measurement info, or None if it cannot be read.

    MNE raises a spread of types on a malformed FIF (ValueError, KeyError,
    RuntimeError, struct.error, ...), so the read is guarded broadly; None is
    the conservative answer, since it keeps the strict channels.tsv-only gate.
    It is not silent: a FIF the converter just read but whose header MNE cannot
    parse is worth a line in the log. MemoryError is the exception: it is a
    host condition, re-raised so the job retries instead of gating on less.
    """
    try:
        import mne  # type: ignore[import-not-found]  # lazy: runtime-only dep
    except ImportError as exc:
        print(
            f"::warning::could not read the FIF header of {path} for its channel "
            f"count (MNE is not importable: {exc}); the gate uses channels.tsv alone",
            flush=True,
        )
        return None
    try:
        info = mne.io.read_info(path, verbose="ERROR")
        nchan = int(info["nchan"])
    except MemoryError:
        # The node was busy, not the header wrong: let it reach convert_one's
        # retryable `recording_memory_exceeded` verdict, as apply_sss does.
        raise
    except Exception as exc:  # noqa: BLE001 - any header failure means "unknown"
        print(
            f"::warning::could not read the FIF header of {path} for its channel "
            f"count ({type(exc).__name__}: {exc}); the gate uses channels.tsv alone",
            flush=True,
        )
        return None
    return nchan if nchan > 0 else None


# An EEGLAB `nbchan` above this is not a channel count but a corrupt field. The
# densest real recordings are a few thousand channels (high-density iEEG,
# probes); a count that could never be real must not refuse a faithful store.
EEGLAB_MAX_NBCHAN = 100_000

# The most bytes one classic `.set` header read may inflate or inspect before
# it gives up (None, with the usual warning). Only the fields ahead of `nbchan`
# and `data` are ever inflated; in EEGLAB's order the largest is `times`, one
# double per sample. A MAT v5/v7 variable cannot exceed 2 GiB, so with inline
# single-precision samples `times` stays under this cap from 16 channels up;
# a header read that does reach it (say a very long `.fdt`-backed recording)
# is only unknown, the gate it had before the header count existed. What the
# cap bounds is a crafted stream (a zlib bomb declaring gigabytes of zeros
# ahead of `nbchan`), which would otherwise cost seconds of CPU per file;
# memory is flat either way (`_MatStream`).
EEGLAB_MAX_HEADER_READ_BYTES = 256 << 20

# The leading text of a MATLAB v7.3 (HDF5) file, as biosigIO's `_is_matlab_v73`
# sniffs it; a classic v5/v7 file opens with "MATLAB 5.0 MAT-file" instead.
_MATLAB_V73_MAGIC = b"MATLAB 7.3 MAT-file"


def _eeglab_declared_channel_count(path: str) -> int | None:
    """`nbchan` from an EEGLAB `.set`, read from its header alone, or None.

    Read the way biosigIO's importer tells the two containers apart (the MAT
    header text): a MATLAB v7.3 `.set` through h5py, a classic MAT v5/v7 `.set`
    through `_mat5_eeglab_header`, a bounded streaming parse that stops at the
    fields it needs and never materializes the sample matrix. `scipy.io.loadmat`
    cannot do that for the common layout: `variable_names` selects top-level
    variables, and a real EEGLAB export saves the whole dataset as ONE variable,
    `EEG`, whose fields include `data`. Measured on a 100 MB inline-data `.set`:
    `loadmat(variable_names=["EEG"])` peaked at 103 MB traced.

    The count is returned only where it provably equals what biosigIO serves.
    biosigIO keeps every row of the data matrix, whatever `nbchan` says (it
    warns and uses the matrix); chanlocs only names rows, so a short or long
    chanlocs never changes the count. So:

    - samples in a `.fdt` (`EEG.data` is the file name): biosigIO reshapes the
      `.fdt` to `nbchan` rows, and refuses it when its size disagrees, so the
      store holds exactly `nbchan` channels. Epoched files flatten to the same
      rows.
    - samples inline: the matrix's own row count (from its header, in MATLAB
      orientation; for v7.3 by biosigIO's transpose rule) must equal `nbchan`.
      A disagreement returns None: `nbchan` above the rows would refuse a
      faithful store, so the header vouches for nothing there.

    Both layouts are read: fields wrapped in an `EEG` struct (the first element
    of a struct array, as biosigIO takes it), or saved flat at the top level; an
    `EEG` struct wins when both exist, as it does in the importer.
    """
    try:
        with open(path, "rb") as fh:
            v73 = fh.read(len(_MATLAB_V73_MAGIC)) == _MATLAB_V73_MAGIC
        fields = _h5_eeglab_header(path) if v73 else _mat5_eeglab_header(path)
    except MemoryError:
        raise
    except Exception as exc:  # noqa: BLE001 - any header failure means "unknown"
        _warn_unreadable_header("EEGLAB", path, f"{type(exc).__name__}: {exc}")
        return None
    nbchan = fields.get("nbchan")
    # A non-integral nbchan is unknown, deliberately. biosigIO does not agree
    # with itself on one (classic files truncate it, `int()`; v7.3 files round
    # it, `int(round())`), so no single integer is what it serves; and a
    # fraction says the field is not a channel count. None is the safe
    # direction: it leaves the gate on channels.tsv alone, never lower.
    if nbchan is None or not math.isfinite(nbchan) or nbchan != int(nbchan):
        _warn_unreadable_header("EEGLAB", path, f"nbchan is {nbchan!r}")
        return None
    count = int(nbchan)
    if not 0 < count <= EEGLAB_MAX_NBCHAN:
        _warn_unreadable_header("EEGLAB", path, f"nbchan is {count}")
        return None
    rows = fields.get("data")
    if rows == "fdt":
        return count
    if rows is None:
        _warn_unreadable_header("EEGLAB", path, "it has no readable data matrix")
        return None
    # Either direction is unknown, deliberately. nbchan ABOVE the rows would
    # call a faithful store truncated. nbchan BELOW them is not taken as a
    # lower bound either: the count is used as proof of what the file holds
    # (a store equal to it is complete, and it is published as `in_file` in
    # the `channels_tsv_count_mismatch` disclosure), and a file whose header
    # and matrix disagree proves nothing, so a lower number would publish an
    # `in_file` the store itself contradicts. None leaves channels.tsv alone.
    if rows != count:
        _warn_unreadable_header(
            "EEGLAB", path,
            f"nbchan {count} disagrees with the {rows}-row data matrix biosigIO serves",
        )
        return None
    return count


def _h5_eeglab_header(path: str) -> dict[str, Any]:
    """`nbchan` and the data matrix's shape from a MATLAB v7.3 `.set`, through
    h5py's metadata alone (`Dataset.shape` reads no samples). Layout and
    orientation follow biosigIO's `_load_v73`: an `EEG` group, else the flat
    root when it carries nbchan/srate/pnts/data; h5py hands back MATLAB's
    (nbchan, pnts) transposed, and a 2-D matrix already channel-major is kept."""
    import h5py  # type: ignore[import-not-found]  # biosigIO's [hdf5] extra
    import numpy as np

    with h5py.File(path, "r") as f:
        if "EEG" in f:
            eeg = f["EEG"]
        elif all(key in f for key in ("nbchan", "srate", "pnts", "data")):
            eeg = f
        else:
            raise ValueError("no 'EEG' group and no flat nbchan/srate/pnts/data")
        out: dict[str, Any] = {"nbchan": None, "data": None}
        if "nbchan" in eeg:
            value = np.asarray(eeg["nbchan"][()]).ravel()
            if value.size == 1:
                out["nbchan"] = float(value[0])
        if "data" in eeg and eeg["data"].size:
            ds = eeg["data"]
            if ds.dtype.kind != "f":
                out["data"] = "fdt"  # char codes naming the .fdt
            elif len(ds.shape) != 2:
                out["data"] = 1  # biosigIO reshapes it to one row
            else:
                a, b = ds.shape
                nbchan = out["nbchan"]
                out["data"] = a if (a == nbchan and b != nbchan) else b
        return out


# MAT v5 element types and array classes the header read needs
# (MathWorks, "MAT-File Format", tables 1-2 and 1-3).
_MI_INT8, _MI_INT32, _MI_UINT32, _MI_MATRIX, _MI_COMPRESSED = 1, 5, 6, 14, 15
_MI_NUMERIC = {
    1: "b", 2: "B", 3: "h", 4: "H", 5: "i", 6: "I", 7: "f", 9: "d", 12: "q", 13: "Q",
}
_MX_STRUCT, _MX_CHAR = 2, 4
_MX_NUMERIC = frozenset(range(6, 16))  # double, single, int8 ... uint64


class _MatStream:
    """Forward-only byte source over a classic MAT file or one zlib-compressed
    element of it, counting its position so an element can be skipped to its
    end. Skipping decompresses in bounded chunks and keeps nothing, so memory
    stays flat whatever the size of the matrix skipped. The chunk bounds both
    the compressed input read at once and each skip step; it is kept small
    because a header read usually needs a few hundred bytes of it. `limit`
    caps the bytes it hands out by `read` (skipping a compressed field reads
    it; skipping an uncompressed one seeks), past which it raises."""

    CHUNK = 1 << 16

    def __init__(self, fh: Any, compressed_bytes: int | None, limit: int) -> None:
        import zlib

        self.fh = fh
        self.pos = 0
        self.left = compressed_bytes
        self.z = zlib.decompressobj() if compressed_bytes is not None else None
        self.buf = bytearray()
        self.limit = limit  # bytes this stream may hand out (read, never seeked past)
        self.spent = 0

    def read(self, n: int) -> bytes:
        if self.spent + n > self.limit:
            raise ValueError(
                f"reading its header would inflate or inspect more than "
                f"{EEGLAB_MAX_HEADER_READ_BYTES} bytes"
            )
        if self.z is None:
            out = self.fh.read(n)
        else:
            while len(self.buf) < n:
                tail = self.z.unconsumed_tail
                if not tail:
                    if not self.left:
                        break
                    tail = self.fh.read(min(self.left, self.CHUNK))
                    if not tail:
                        break
                    self.left -= len(tail)
                self.buf += self.z.decompress(tail, max(n - len(self.buf), 1))
            out, self.buf = bytes(self.buf[:n]), self.buf[n:]
        if len(out) < n:
            raise EOFError(f"MAT element ends {n - len(out)} byte(s) early")
        self.pos += n
        self.spent += n
        return out

    def skip(self, n: int) -> None:
        if self.z is None:
            self.fh.seek(n, os.SEEK_CUR)
            self.pos += n
            return
        while n > 0:
            step = min(n, self.CHUNK)
            self.read(step)
            n -= step


def _mat5_element(src: _MatStream, end: str) -> tuple[int, bytes]:
    """One whole (small) data element: its type and its bytes, padding
    consumed. Only for header subelements, never a sample matrix."""
    import struct

    mtype, nbytes = struct.unpack(end + "II", src.read(8))
    if mtype >> 16:  # small data element: packed into the tag's 8 bytes
        return mtype & 0xFFFF, struct.pack(end + "I", nbytes)[: mtype >> 16]
    if nbytes > 1 << 20:
        raise ValueError(f"a {nbytes}-byte header subelement")
    data = src.read(nbytes)
    src.read(-nbytes % 8)
    return mtype, data


def _mat5_matrix_header(src: _MatStream, end: str) -> tuple[int, list[int], str]:
    """Array class, dimensions and name of the miMATRIX whose tag was just read."""
    import struct

    _, flags = _mat5_element(src, end)
    mclass = struct.unpack(end + "I", flags[:4])[0] & 0xFF
    _, raw_dims = _mat5_element(src, end)
    dims = list(struct.unpack(end + f"{len(raw_dims) // 4}i", raw_dims))
    _, name = _mat5_element(src, end)
    return mclass, dims, name.decode("latin-1")


def _mat5_scalar(src: _MatStream, end: str, mclass: int, dims: list[int]) -> float | None:
    """The single value of a 1x1 numeric matrix, or None for any other shape."""
    import struct

    if mclass not in _MX_NUMERIC or math.prod(dims) != 1:
        return None
    mtype, data = _mat5_element(src, end)
    fmt = _MI_NUMERIC.get(mtype)
    if fmt is None or len(data) < struct.calcsize(fmt):
        return None
    return float(struct.unpack(end + fmt, data[: struct.calcsize(fmt)])[0])


def _mat5_field(src: _MatStream, end: str, name: str, mclass: int, dims: list[int]) -> Any:
    """What the header read keeps of one `nbchan` or `data` matrix: nbchan's
    value; for data, ``"fdt"`` when it is the `.fdt`'s name (a char array), its
    row count when numeric (MATLAB's (nbchan, pnts[, trials]) order), else None."""
    if name == "nbchan":
        return _mat5_scalar(src, end, mclass, dims)
    if not math.prod(dims):
        return None
    if mclass == _MX_CHAR:
        return "fdt"
    return dims[0] if mclass in _MX_NUMERIC else None


def _mat5_eeglab_header(path: str) -> dict[str, Any]:
    """``{"nbchan": ..., "data": ...}`` (see `_mat5_field`) from a classic MAT
    v5/v7 `.set`, reading element headers only.

    Every top-level variable is visited by its header and then skipped by
    seeking past it, compressed or not. The `EEG` struct is walked field by
    field: each field's matrix header is read, the field is skipped to its end,
    and the walk stops the moment `nbchan` and `data` have both been read,
    without skipping past the second. A field skipped inside a compressed
    variable is decompressed in bounded chunks and discarded, and `data` is
    never read past its dimensions. A field in `EEG`
    wins over a top-level variable of the same name, as in biosigIO's
    `_normalize_eeglab_dict`.
    """
    import struct

    flat: dict[str, Any] = {}
    wrapped: dict[str, Any] = {}
    budget = EEGLAB_MAX_HEADER_READ_BYTES
    with open(path, "rb") as fh:
        head = fh.read(128)
        if len(head) < 128 or head[126:128] not in (b"IM", b"MI"):
            raise ValueError("not a MAT v5 file (no endian indicator)")
        end = "<" if head[126:128] == b"IM" else ">"
        size = os.fstat(fh.fileno()).st_size
        while fh.tell() < size:
            raw = fh.read(8)
            if len(raw) < 8:
                raise EOFError("truncated variable tag")
            mtype, nbytes = struct.unpack(end + "II", raw)
            after = fh.tell() + nbytes + (0 if mtype == _MI_COMPRESSED else -nbytes % 8)
            if after > size:
                raise EOFError(f"a variable runs {after - size} byte(s) past the end")
            src = _MatStream(fh, nbytes if mtype == _MI_COMPRESSED else None, budget)
            if mtype == _MI_COMPRESSED:
                mtype, nbytes = struct.unpack(end + "II", src.read(8))
            if mtype == _MI_MATRIX and nbytes:
                mclass, dims, name = _mat5_matrix_header(src, end)
                if name == "EEG" and mclass == _MX_STRUCT and math.prod(dims):
                    wrapped = _mat5_struct_fields(src, end)
                elif name in ("nbchan", "data"):
                    flat[name] = _mat5_field(src, end, name, mclass, dims)
            budget -= src.spent
            fh.seek(after)
    return {**flat, **wrapped}


def _mat5_struct_fields(src: _MatStream, end: str) -> dict[str, Any]:
    """`nbchan` and `data` from the first element of the struct whose matrix
    header was just read (biosigIO takes the first of a struct array; MAT v5
    stores a struct array element by element, fields in order)."""
    import struct

    _, raw_len = _mat5_element(src, end)
    name_len = struct.unpack(end + "i", raw_len[:4])[0]
    _, raw_names = _mat5_element(src, end)
    if name_len <= 0:
        return {}
    names = [
        raw_names[i:i + name_len].split(b"\x00", 1)[0].decode("latin-1")
        for i in range(0, len(raw_names), name_len)
    ]
    out: dict[str, Any] = {}
    for name in names:
        mtype, nbytes = struct.unpack(end + "II", src.read(8))
        if mtype != _MI_MATRIX:
            raise ValueError(f"struct field {name!r} is element type {mtype}")
        start = src.pos
        if name in ("nbchan", "data"):
            out[name] = None
            if nbytes:
                mclass, dims, _ = _mat5_matrix_header(src, end)
                out[name] = _mat5_field(src, end, name, mclass, dims)
            # Stop here, BEFORE skipping to the field's end: in the usual order
            # `data` is the second of the two, and skipping it inside a
            # compressed `EEG` would inflate every sample only to discard them.
            if "nbchan" in out and "data" in out:
                return out
        src.skip(start + nbytes - src.pos)
    return out


ChannelGateVerdict = Literal["pass", "sidecar_overcount", "truncated"]


def channel_gate_verdict(
    in_store: int, channels_tsv: int | None, in_file: int | None
) -> ChannelGateVerdict:
    """The fidelity gate's decision, kept pure so every branch is testable.

    - ``truncated``: the store falls short of the file's OWN header, whatever
      channels.tsv says or whether one exists at all; or it falls short of
      channels.tsv while the file's count is unknown. Withheld
      (``ChannelCountMismatch``): better no store than a wrong one.
    - ``pass``: the store holds every channel the header declares (or the
      header is unreadable) and at least what channels.tsv declares (or no
      channels.tsv applies).
    - ``sidecar_overcount``: the store falls short of channels.tsv but holds
      every channel the file's own header declares, so the SIDECAR over-declares
      and the store is faithful. Published, with the disagreement recorded.

    The header check comes first, and on its own, because channels.tsv is not
    an independent witness of a label collapse. Before biosigio 1.2.9 a label
    the file repeats (CHB-MIT's ``T8-P8``, its ``-`` placeholders) overwrote a
    channel on import, so the store came up one short per repeat. A sidecar
    written by a tool that keys channels by label collapses the same way and
    agrees with the short store; a dataset that ships no channels.tsv has
    nothing to compare against at all. Both passed this gate before, and only
    the header, read with no importer in between, still counts every channel.
    """
    if in_file is not None and in_store < in_file:
        return "truncated"
    if not channels_tsv or in_store >= channels_tsv:
        return "pass"
    if in_file is not None:
        return "sidecar_overcount"
    return "truncated"


class ChannelCountNote(TypedDict):
    """The index entry's ``channels_tsv_count_mismatch`` object."""

    channels_tsv: int
    in_file: int
    in_store: int


def enforce_channel_gate(
    primary: str, in_store: int, channels_tsv: int | None, in_file: int | None
) -> ChannelCountNote | None:
    """Apply ``channel_gate_verdict`` to a built store, before its sync.

    Raises ``ChannelCountMismatch`` on ``truncated``. Returns the note to
    disclose on the index entry for ``sidecar_overcount``, else None.
    ``convert_one`` calls this with the store it just built and the header of
    the very file it converted, so the two counts describe the same recording.
    """
    verdict = channel_gate_verdict(in_store, channels_tsv, in_file)
    if verdict == "sidecar_overcount":
        # `sidecar_overcount` is only reachable with both counts known.
        assert channels_tsv is not None and in_file is not None
        # The store holds every channel the file itself declares; the sidecar
        # lists channels the file never had. Serve the faithful copy and
        # disclose the disagreement on the index entry.
        print(
            f"::warning::{primary}: channels.tsv declares {channels_tsv} channel(s) "
            f"but the file itself holds {in_file}; serving the {in_store}-channel "
            "store, which matches the file",
            flush=True,
        )
        return {"channels_tsv": channels_tsv, "in_file": in_file, "in_store": in_store}
    if verdict == "truncated":
        declared = []
        if in_file is not None:
            declared.append(f"the file's own header declares {in_file}")
        if channels_tsv:
            declared.append(f"its channels.tsv declares {channels_tsv}")
        raise ChannelCountMismatch(
            f"store has {in_store} channel(s) but {primary}: {' and '.join(declared)}; "
            "refusing to publish an unfaithful copy"
        )
    return None


def affected_primaries(
    changed_path: str,
    primaries_by_dir: dict[str, list[str]],
    member_to_head: dict[str, str] | None = None,
) -> set[str]:
    """Buildable head primaries a changed path rebuilds, restricted to those at HEAD.

    A head primary maps to itself; a non-head split FIF maps to its group head (via
    `member_to_head`), so editing any split rebuilds the one store; a companion
    (`.fdt`/`.eeg`/`.vmrk`) maps to the same-stem primary in its directory; a
    `*_events.tsv` maps to every primary in its directory sharing the events
    entities-base (the `split-NN` entity is ignored on both sides, since a split
    recording's events file carries no split).

    `primaries_by_dir` holds every buildable primary in a directory: the file
    heads AND the directory recordings (CTF `.ds`, MEF3 `.mefd`, 4D/BTi), which
    sit in the same parent directory as their sidecars. A non-head split is still
    absent from `here`, since only chain heads are buildable. Directory recordings
    reach only the companion and events branches: they are never `is_primary`
    (their extensions are not in `PRIMARY_EXTS`, and a BTi directory is not a
    tracked path at all), and never split FIFs.
    """
    d = os.path.dirname(changed_path)
    here = primaries_by_dir.get(d, [])
    if is_primary(changed_path):
        if changed_path in here:
            return {changed_path}
        # A non-head split (not itself buildable) rebuilds its group head.
        head = (member_to_head or {}).get(changed_path)
        return {head} if head in here else set()
    ext = lower_ext(changed_path)
    if ext in COMPANION_EXTS:
        stem = filename_stem(changed_path)
        return {p for p in here if filename_stem(p) == stem}
    if is_events_tsv(changed_path):
        ev_stem = filename_stem(changed_path)  # `sub-01_task-x_events`
        ev_base = ev_stem[: -len("_events")] if ev_stem.endswith("_events") else entities_base(ev_stem)
        ev_base = _strip_split(ev_base)
        return {p for p in here if _strip_split(entities_base(filename_stem(p))) == ev_base}
    return set()


def _buildable_primaries(
    head_files,
) -> tuple[list[str], dict[str, str], set[str], set[str], set[str]]:
    """Every recording discovery can build at HEAD, plus the bookkeeping the
    incremental path needs.

    Returns `(all_primaries, member_to_head, heads, dirrec_dirs, bti_dirs)`.
    Factored out of `compute_worklist` so `discover_primaries` and the worklist
    answer "what recordings exist" through the SAME code: the index's coverage
    denominator has to be the set the converter would actually attempt, not a
    second, subtly different walk of the tree.
    """
    primaries = [p for p in head_files if is_primary(p)]
    # Directory-keyed recordings are derived from the files under them, not
    # tracked paths of their own, so they are buildable primaries alongside the
    # file primaries. CTF `.ds`/MEF3 `.mefd` are extension-derived; 4D/BTi is
    # content-derived (see the two sections near the top of this file).
    dirrec_dirs = dir_recordings(head_files)
    bti_dirs = bti_recordings(head_files)
    # Collapse FIF split groups to their chain head: only the head builds a store,
    # and a change to any split routes to that head (member_to_head).
    heads, member_to_head = split_heads_and_members(primaries)
    return sorted([*heads, *dirrec_dirs, *bti_dirs]), member_to_head, heads, dirrec_dirs, bti_dirs


def discover_primaries(head_files) -> list[str]:
    """Every raw recording at HEAD, after the ADR 0027 exclusions.

    This is the index's `discovered_count` -- the denominator of coverage and the
    left-hand side of the invariant `discovered_count == store_count +
    failure_count + pending_count`. Publishing it is what lets a consumer check
    completeness without cloning the repository: on008083 served 2 stores and 36
    failures out of 43 raw recordings, and the missing five were visible nowhere
    (#1197).
    """
    return _buildable_primaries(head_files)[0]


def compute_worklist(
    head_files: list[str],
    diff_entries: list[tuple[str, str]],
    full: bool,
) -> tuple[list[str], list[str]]:
    """Return (convert, remove): primary source paths to (re)build, and store
    rel-paths (`*.zarr`) to delete.

    `diff_entries` is a list of (status, path) from `git diff --no-renames
    --name-status` (so a rename is a D + an A). `full` ignores the diff and
    converts every primary at HEAD.
    """
    head_set = set(head_files)
    all_primaries, member_to_head, heads, dirrec_dirs, bti_dirs = _buildable_primaries(
        head_files
    )
    # Keyed on ALL buildable primaries, not just the file heads. A directory
    # recording sits in the same parent directory as its sidecars -- CTF
    # `sub-01/meg/..._meg.ds` next to `sub-01/meg/..._events.tsv` -- so omitting
    # the directory forms here left `affected_primaries` with an empty bucket and
    # an events edit rebuilt NOTHING for CTF/MEF3/BTi (#1106). Events only: the
    # companion extensions are EEGLAB/BrainVision-specific, so reaching a
    # directory recording through that branch would need a same-stem `.fdt`/
    # `.eeg`/`.vmrk` beside it, which is not a valid BIDS layout.
    # Changes INSIDE a recording directory never reach this map; they are resolved
    # earlier by `dir_recording_of`/`bti_dirs`. This map is only consulted for
    # siblings alongside the recording, which is exactly the sidecar case.
    by_dir: dict[str, list[str]] = {}
    for p in all_primaries:
        by_dir.setdefault(os.path.dirname(p), []).append(p)

    if full:
        return all_primaries, []

    convert: set[str] = set()
    remove: set[str] = set()
    # Deleted splits are resolved per split GROUP after the loop: a split file gone
    # from HEAD is no longer in `member_to_head` (which is built from HEAD), so it
    # can't route through it. Group by split_group_key and decide once per group.
    deleted_split_groups: dict[str, list[str]] = {}
    for status, path in diff_entries:
        # A changed/removed path under an excluded tree (derivatives/
        # sourcedata/code) or a BIDS calibration filename never builds or
        # removes a store: it was never a candidate recording, and a
        # deletion there must not be misread as "the recording is gone from
        # HEAD" -- that would delete an already-published store this change
        # is required to leave untouched (see `compute_clean_orphans`).
        if is_excluded_from_discovery(path):
            continue
        # A change anywhere inside a CTF `.ds`/MEF3 `.mefd` is a change to that
        # one recording (extension-derived; see `dir_recording_of`).
        ds = dir_recording_of(path)
        if ds is not None:
            if ds in dirrec_dirs:  # at least one file remains -> rebuild the recording
                convert.add(ds)
            elif status == "D":  # the whole directory is gone -> drop its store
                remove.add(store_rel_for(ds))
            continue
        # A change anywhere inside a 4D/BTi directory is a change to that one
        # recording too, but BTi has no extension to derive it from -- membership
        # is content-based (`bti_dirs`, computed from the current HEAD state), so
        # a still-valid BTi dir means "rebuild." A deletion that drops the
        # directory below the c,rf*/config threshold (the last processed-data or
        # config file going away) is the removal signal instead; `hs_file` (not a
        # marker name) deliberately does NOT trigger removal on its own.
        btidir = os.path.dirname(path)
        if btidir in bti_dirs:
            convert.add(btidir)
            continue
        if status == "D" and is_bti_marker_name(os.path.basename(path)):
            remove.add(store_rel_for(btidir))
            continue
        if status == "D":
            if is_split_fif(path):
                deleted_split_groups.setdefault(split_group_key(path), []).append(path)
            elif is_primary(path):
                # A buildable recording is gone -> drop its store. (If a same-name
                # primary still exists at HEAD it lands in convert below.)
                if path not in head_set:
                    remove.add(store_rel_for(path))
            else:
                # A companion/events removal still rebuilds any sibling recording
                # that remains (e.g. events.tsv deleted -> regenerate without events).
                convert |= affected_primaries(path, by_dir, member_to_head)
        else:  # "A", "M", "T", ...
            convert |= affected_primaries(path, by_dir, member_to_head)

    # Per deleted split group: if any split still exists at HEAD, re-read the chain
    # (rebuild its head); otherwise the whole recording is gone -> drop the store,
    # which was keyed at the group's head (lowest split index seen for the group).
    for gkey, deleted in deleted_split_groups.items():
        head_here = next(
            (h for h in heads if is_split_fif(h) and split_group_key(h) == gkey), None
        )
        # All entries are split FIFs, so split_index is never None here (-1 is an
        # unreachable fallback that only quiets the type checker).
        old_lowest = min(deleted, key=lambda x: (split_index(x) or 0, x))
        if head_here is not None:
            convert.add(head_here)
            # If the deletion reaches below the surviving head, the group's head
            # index shifted up (old head removed): drop its now-orphaned store. The
            # `remove -= convert_stores` guard below protects a rebuilt store.
            if (split_index(old_lowest) or -1) < (split_index(head_here) or -1):
                remove.add(store_rel_for(old_lowest))
        else:
            remove.add(store_rel_for(old_lowest))

    # A directory recording is "present" when it still has qualifying files at HEAD.
    present = head_set | dirrec_dirs | bti_dirs
    convert &= present  # never convert something not present at HEAD
    convert_stores = {store_rel_for(p) for p in convert}
    remove -= convert_stores  # a rebuilt store must not also be deleted
    return sorted(convert), sorted(remove)


def compute_clean_orphans(prior_index: dict | None, convert: list[str]) -> set[str]:
    """Stores a `--clean` run should remove: prior index stores this run does
    not (re)produce, MINUS any store under an excluded tree
    (derivatives/sourcedata/code).

    A store's rel-path missing from `convert` normally means its recording is
    gone from HEAD. But since this converter went raw-only, a derivatives/
    sourcedata/code primary is ALSO absent from `convert` -- deliberately,
    because we stopped attempting it, not because the file disappeared. A
    store rel-path mirrors its primary's directory structure (`store_rel_for`
    only swaps the extension), so `is_excluded_from_discovery` applies to it
    directly. Without this guard, going raw-only would let `--clean`'s own
    orphan-removal delete the ~4,721 already-published non-raw stores on the
    very next run -- exactly the cleanup this change must NOT perform; that
    is separate, explicitly-authorized follow-up work
    (nemarOrg/nemar-cli#1095 / nemarOrg/nemar-cli#1097).
    """
    prior_rels = {
        e["zarr"]
        for e in (prior_index or {}).get("stores", [])
        if isinstance(e, dict) and isinstance(e.get("zarr"), str)
    }
    convert_rels = {store_rel_for(p) for p in convert}
    return {
        rel for rel in prior_rels - convert_rels if not is_excluded_from_discovery(rel)
    }


def is_commit_sha(value: object) -> bool:
    """True for a full 40-hex git commit SHA."""
    return isinstance(value, str) and bool(COMMIT_SHA_RE.match(value))


def installed_biosigio_version() -> str | None:
    """The installed biosigIO release, or None when it cannot be determined.

    Published as the index's `biosigio_version` so a store's geometry and unit
    handling can be attributed to a specific library release -- the engine stamp
    says which DISCOVERY generation ran, not which exporter wrote the bytes, and
    the two move independently. Null rather than a guess: an unattributable store
    must not claim a version.
    """
    try:
        from importlib.metadata import version

        return version("biosigio")
    except Exception as exc:  # noqa: BLE001 - absent/odd metadata is not fatal
        print(
            f"::warning::could not determine the installed biosigio version ({exc}); "
            "publishing biosigio_version: null",
            flush=True,
        )
        return None


class StoreEntry(TypedDict, total=False):
    """One published `stores[]` entry. `total=False` throughout, because the
    schema's `required` set is the contract and most keys are conditional --
    `sss` only on an ADR 0028 store, `n_events`/`trial_types` only when an
    events.tsv applies, `units_report` only when a channels.tsv did.

    Declared for the reader, not the type checker: these dicts are assembled
    from several sources (`store_metadata`'s spread, `events_summary`'s update,
    the SSS path) and a mistyped key would otherwise only be caught by the
    pre-upload schema self-check, at the end of a conversion.
    """

    path: str
    zarr: str
    updated_utc: str
    source_tree: str
    derived: bool
    modalities: list[str]
    groups: list[dict]
    power_line_frequency: float | None
    event_description_count: int
    n_events: int
    trial_types: dict[str, int]
    units_report: dict
    channels_tsv_read_error: bool
    split_members: list[str]
    sss: dict


class FailureEntry(TypedDict):
    """One published `failures[]` entry: a recording that will not convert
    without a change to the data or the converter. `reason` is the sanitized
    sentence a viewer shows; `detail` is the operator-facing cause."""

    path: str
    zarr: str
    code: str
    reason: str
    detail: str | None
    attempts: int


# The three reasons a discovered recording can be `pending`, spelled exactly as
# `zarr-index.schema.json`'s `$defs.pending.reason` enum spells them. A CLOSED
# set, unlike `FailureEntry.code`: the schema rejects a fourth value, so a typo
# or a newly-invented reason has to fail here, at the call site, rather than at
# `validate_document` after a full conversion has already run.
PendingReason = Literal["infra_failure", "memory_budget", "not_attempted"]


class PendingEntry(TypedDict):
    """One published `pending[]` entry: a discovered recording with no store
    that is still expected to convert."""

    path: str
    zarr: str
    reason: PendingReason
    attempts: int
    last_error: str | None
    last_attempt_utc: str | None


def _normalize_store_entry(entry: dict) -> StoreEntry:
    """Bring a store entry up to the v3 shape without inventing facts.

    Applied to CARRIED-OVER entries as well as this run's, so one index never
    mixes shapes: an entry written by the v1 producer carries `source_key` (which
    v3 moved to the manifest, #1178 item 5) and carries neither `source_tree` nor
    `derived`. The defaults are the only honest ones available from the entry
    alone -- a store that exists was built from a discoverable raw recording, and
    `derived` is stated by the SSS path, which also writes `sss`, so its absence
    is evidence rather than a guess.

    Every entry this reaches is raw by construction: `merge_index` drops a
    carried-over store whose path is excluded from discovery (they are being
    purged, not served), so `source_tree` is the only value the schema allows.

    `trial_types` is re-keyed through `shorten_trial_types`, which is not a change
    of shape (format_version stays 3) but does drop the full text of a long value
    from index.json. An entry written before that limit existed (a dataset whose
    events carry a whole record, such as nm000229) is thereby brought to the same
    form a fresh conversion produces, on the next merge and without reconverting
    the store; an entry already in the new form is unchanged.
    """
    out: StoreEntry = {k: v for k, v in entry.items() if k != "source_key"}  # type: ignore[assignment]
    trial_types = out.get("trial_types")
    if isinstance(trial_types, dict):
        out["trial_types"] = shorten_trial_types(trial_types)
    out.setdefault("source_tree", source_tree_for(str(out.get("path", ""))))
    out.setdefault("derived", bool(out.get("sss")))
    return out


def _pending_reason(value: object) -> PendingReason:
    """Coerce a `reason` read off a PUBLISHED index into the closed set.

    Carried-forward pending entries come from a document written by an earlier
    run (or hand-edited), so the value is data, not a literal. An unrecognized
    one becomes `infra_failure` -- the reading that says "no store, cause not
    established, try again" -- rather than being republished as-is, which would
    fail `validate_document` at the very END of a run, after every recording had
    already been converted, and refuse to publish the whole index over it.
    """
    return value if value in ("infra_failure", "memory_budget", "not_attempted") else "infra_failure"  # type: ignore[return-value]


def _pending_entry(
    path: str,
    reason: PendingReason,
    attempts: int,
    last_error: str | None = None,
    last_attempt_utc: str | None = None,
) -> PendingEntry:
    return {
        "path": path,
        "zarr": store_rel_for(path),
        "reason": reason,
        "attempts": attempts,
        "last_error": last_error,
        "last_attempt_utc": last_attempt_utc,
    }


def _failure_entry(
    path: str,
    code: str,
    detail: str | None = None,
    attempts: int = 0,
) -> FailureEntry:
    """A `failures[]` entry, built in ONE place.

    Mirrors `_pending_entry` for the same reason: the `zarr` rel-path and the
    user-facing `reason` are DERIVED (`store_rel_for`, `reason_for_code`), and
    three call sites were each deriving them again -- `record` in main, the
    exhaustion promotion in `merge_index`, and the retry-exhausted path. A fourth
    would have been written the same way, and a hand-built entry that skipped
    `reason_for_code` would publish a code with no explanation for the viewer.
    """
    return {
        "path": path,
        "zarr": store_rel_for(path),
        "code": code,
        "reason": reason_for_code(code),
        "detail": detail,
        "attempts": attempts,
    }


def index_provenance(dataset_row: dict | None) -> dict:
    """The index's top-level dataset provenance (#1064), from the catalog row.
    One function because ``pending_retry_worklist`` compares a published index
    against the current row on exactly these fields: two copies of the mapping
    would let the comparison drift from what is published."""
    row = dataset_row or {}
    return {
        "doi": row.get("concept_doi") or row.get("doi") or None,
        "license": row.get("license") or None,
        "citation": dataset_citation(dataset_row),
        "hed_version": row.get("hed_version") or None,
    }


def index_currency_problem(
    index: dict | None,
    head: str,
    dataset_row: dict | None,
    row_fetch_failed: bool,
    biosigio_version: str | None,
    engine_version: str = ZARR_ENGINE_VERSION,
    *,
    provenance_unknown_ok: bool = False,
) -> str | None:
    """Why a published index is NOT exactly what a full rebuild at ``head`` would
    produce for the stores it already serves, or None when it is: same commit, same
    engine, same biosigIO, same dataset provenance (which every store embeds).

    One predicate for two decisions. A retry round may convert only the pending
    recordings when this is None (`pending_retry_worklist`), and a recording the
    scratch gate defers may keep serving its published store when this is None
    (`merge_index`): in both cases the store on S3 is what this run would have
    written. When it is not None that store is stale, so a deferred recording's
    entry leaves the index and the recording is listed pending to be rebuilt.

    An unreadable catalog means provenance cannot be compared. A retry round must
    treat that as "not current" (converting only the pending recordings would leave
    every other store with provenance nobody checked). A store that is merely being
    KEPT must not: dropping a served store because the catalog was down for a minute
    is the one outcome worse than serving it. ``provenance_unknown_ok`` selects the
    second reading; commit, engine and biosigIO are still compared."""
    if not isinstance(index, dict):
        return "no published index"
    if index.get("source_commit") != head:
        return "the index was built from a different commit"
    if index.get("engine_version") != engine_version:
        return "the index was built by a different engine"
    if index.get("biosigio_version") != biosigio_version:
        return "the index was built with a different biosigIO"
    if row_fetch_failed:
        return None if provenance_unknown_ok else (
            "the catalog could not be read to compare provenance"
        )
    current = index_provenance(dataset_row)
    if any(index.get(k) != v for k, v in current.items()):
        return "the dataset's provenance changed since the index was built"
    return None


def pending_retry_worklist(
    index: dict | None,
    head: str,
    discovered: list[str],
    dataset_row: dict | None,
    row_fetch_failed: bool,
    biosigio_version: str | None,
    engine_version: str = ZARR_ENGINE_VERSION,
) -> tuple[list[str] | None, str]:
    """What a pending-driven retry round has to convert (#1483). Pure.

    Returns ``(recordings, reason)``. ``recordings`` is the published index's
    ``pending`` paths still discovered at HEAD, when everything else the index
    serves is still exactly what a full rebuild would produce: same commit, same
    engine, same biosigIO, and the same dataset provenance (which every store
    embeds). Otherwise it is None, ``reason`` says why, and the run is a full
    rebuild as before.

    A retry round used to rebuild the whole dataset to convert the handful of
    recordings still pending, so on a large dataset each round spent hours
    reconverting stores that were already published at this commit, and could
    fail new recordings for memory while doing it.
    """
    problem = index_currency_problem(
        index, head, dataset_row, row_fetch_failed, biosigio_version, engine_version
    )
    if problem:
        return None, problem
    assert isinstance(index, dict)  # narrowed by the check above
    at_head = set(discovered)
    pending = index.get("pending")
    paths = sorted(
        {
            e["path"]
            for e in (pending if isinstance(pending, list) else [])
            if isinstance(e, dict) and isinstance(e.get("path"), str) and e["path"] in at_head
        }
    )
    if not paths:
        return None, "the index lists nothing pending"
    return paths, f"{len(paths)} pending recording(s)"


def _heal_carried_units_report(entry: dict) -> dict:
    """A prior index entry with its `units_report` bounded, as `merge_index`
    carries it.

    Entries for unchanged stores are carried verbatim, and the schema refuses
    biosigIO's raw per-channel `matched_case_insensitive` map. An entry
    published with that map (a biosigio 1.2.10 run before the converter bounded
    it: staging, an exemplar, an ad hoc `--dataset` with BIOSIGIO_SPEC
    overridden) would otherwise be re-carried by every incremental run and fail
    the pre-upload validation each time, wedging the dataset until a `--clean`
    rebuild. Passing it through `bound_units_report` derives the count and the
    examples from the map and drops the map, so the entry heals on the next
    merge. Every other entry is returned as it is, and `prior` is not mutated.
    """
    report = entry.get("units_report")
    if not (isinstance(report, dict) and BIOSIGIO_CASE_MATCH_KEY in report):
        return entry
    bounded, _matches = bound_units_report(report)
    return {**entry, "units_report": bounded}


def _entry_for_path(doc: dict | None, section: str, path: str) -> dict | None:
    """The entry of ``doc[section]`` ("stores" or "failures") for a recording, or
    None. Read off a PUBLISHED document, so nothing about its shape is assumed."""
    entries = (doc or {}).get(section)
    if not isinstance(entries, list):
        return None
    return next(
        (e for e in entries if isinstance(e, dict) and e.get("path") == path), None
    )


_DEFERRED_PREFIX = "deferred:"
_DEFERRED_JOIN = "; last error: "


def _without_deferral(last_error: str | None) -> str | None:
    """A pending entry's ``last_error`` with a deferral note stripped, so a recording
    deferred tick after tick keeps the error it last FAILED with instead of a chain
    of deferral notes. A note with nothing behind it leaves None."""
    if not last_error:
        return None
    if not last_error.startswith(_DEFERRED_PREFIX):
        return last_error
    _, sep, tail = last_error.partition(_DEFERRED_JOIN)
    return tail or None if sep else None


def merge_index(
    prior: dict | None,
    dataset_id: str,
    head_commit: str,
    converted: list[dict],
    removed_store_rels: list[str],
    updated_utc: str,
    # `failures` is built exclusively by `_failure_entry`, so it carries the
    # TypedDict. `converted`, `pending` and `prior_pending` deliberately do NOT:
    # `converted` is a store entry assembled by the worker, and the other two are
    # this function's INPUT -- `pending` carries only what a run observed (path,
    # reason, last_error) and `prior_pending` comes verbatim out of a PUBLISHED
    # index that this function does not re-validate. Claiming PendingEntry for
    # either would assert a shape nothing checks.
    failures: list[FailureEntry] | None = None,
    pending: list[dict] | None = None,
    *,
    discovered: list[str] | None = None,
    errors: int | None = None,
    contract_base: str = DEFAULT_CONTRACT_BASE,
    bucket: str = "nemar",
    region: str = "us-east-2",
    engine_version: str = ZARR_ENGINE_VERSION,
    biosigio_version: str | None = None,
    prior_pending: list[dict] | None = None,
    dataset_row: dict | None = None,
    deferred: dict[str, str] | None = None,
    seed: dict | None = None,
    seed_current: bool = False,
) -> dict:
    """Fold this run's results into the prior index and return the v3 document. Pure.

    `converted` is a list of store entries (each carries a `zarr` rel-path key);
    `removed_store_rels` are `*.zarr` rels to drop. Entries for unchanged stores
    are carried over from `prior`, normalized to the v3 shape (which includes
    re-keying a long `trial_types` value by its digest form, see
    `_normalize_store_entry`).

    `failures` is this run's typed data failures ({path, zarr, code, reason,
    detail}) -- recordings that will not convert without a change to the data or
    the converter. They are merged like stores: prior failures carry over, a path
    that converted (or whose store was removed) this run drops out, and this run's
    failures overlay.

    `pending` is this run's INFRA failures ({path, zarr, reason, last_error,
    last_attempt_utc}) -- recordings that have no store yet but are still expected
    to convert. Before v3 these were simply omitted, which is why on008083's five
    silently-lost recordings were indistinguishable from "still generating"
    forever (#1197). `attempts` is not supplied by the caller: it is a property of
    the recording's HISTORY, so it is carried from `prior_pending` and
    incremented here. At `PENDING_MAX_ATTEMPTS` the entry is promoted to a typed
    `retry_exhausted` failure carrying its last error as `detail`, which is what
    stops a permanently failing recording from consuming the queue forever.

    `discovered` (every raw recording at HEAD) makes the coverage invariant hold
    BY CONSTRUCTION rather than by hope: entries for paths that are not discovered
    are dropped, and discovered paths in none of the three lists become
    `not_attempted` pending entries. A partial run therefore still balances.

    `deferred` maps recordings the scratch gate would not admit to the text that
    explains it. A deferral is not an attempt and not a conversion, so it must
    neither spend an attempt nor make the index serve less than it did (a served
    store is not dropped by a rebuild that could not run).
    `seed` is the index as published (under ``--clean`` the merge is handed no
    `prior`, so this is the only place the deferred recordings' old entries live),
    and `seed_current` says whether the stores it serves are what this run would
    have written (`index_currency_problem` is None). For each deferred path:

    - a store in `seed` and `seed_current`: the store stays in the index, served
      exactly as before; nothing is owed;
    - a store that is stale (or any store carried by an incremental merge): the
      entry leaves the index, as a failure's does, and the recording is listed
      pending as `not_attempted` so the queue rebuilds it; its objects stay on S3;
    - a typed failure already on record stays a failure when the index is current,
      and is dropped for pending when it is stale (the verdict may no longer hold);
    - otherwise it is pending as `not_attempted`, `attempts` and `last_attempt_utc`
      carried from its history (so an attempt-3 recording is still attempt 3), and
      `last_error` says why it was deferred ahead of whatever it last failed with.

    A path is never in more than one of `stores`, `failures`, `pending`.

    Raises ValueError when `head_commit` is not a 40-hex SHA: an index that does
    not name the commit it was built from is unreproducible and cannot seed the
    next incremental diff, and one was published (on008083, #1197). Refusing here
    means the run fails loudly instead of overwriting a good index with a broken
    one.
    """
    if not is_commit_sha(head_commit):
        raise ValueError(
            f"refusing to build an index for {dataset_id} with source_commit "
            f"{head_commit!r}: a published index must name the 40-hex commit it "
            "was built from (#1197)"
        )
    failures = failures or []
    pending = pending or []
    new_fail_paths = {f["path"] for f in failures if f.get("path")}
    new_pending_paths = {p["path"] for p in pending if p.get("path")}

    stores: dict[str, dict] = {}
    if prior and isinstance(prior.get("stores"), list):
        for entry in prior["stores"]:
            if isinstance(entry, dict) and isinstance(entry.get("zarr"), str):
                stores[entry["zarr"]] = _heal_carried_units_report(entry)
    for rel in removed_store_rels:
        stores.pop(rel, None)
    for entry in converted:
        stores[entry["zarr"]] = entry
    # A recording that newly FAILED (or is newly pending) must not keep a stale
    # store entry claiming it is served.
    stores = {
        z: e
        for z, e in stores.items()
        if e.get("path") not in new_fail_paths and e.get("path") not in new_pending_paths
    }

    # Deliberately NOT dict[str, FailureEntry]: the values below are a mix of
    # `_failure_entry` results and entries read verbatim out of a PUBLISHED
    # index, which this function does not re-validate. Claiming the TypedDict
    # here would assert a shape for a document written by an earlier engine.
    fails: dict[str, dict] = {}
    if prior and isinstance(prior.get("failures"), list):
        for f in prior["failures"]:
            # A path now excluded from discovery (derivatives/sourcedata/code,
            # or a BIDS calibration filename) will never be reconverted, so a
            # stale failure entry for it would otherwise persist in
            # index.json indefinitely -- showing users a failure for a file
            # we deliberately no longer serve at all.
            if (
                isinstance(f, dict)
                and f.get("path")
                and not is_excluded_from_discovery(f["path"])
            ):
                fails[f["path"]] = f
    converted_paths = {e["path"] for e in converted if e.get("path")}
    removed_set = set(removed_store_rels)
    # Drop prior failures that converted this run, whose recording was removed, or
    # that are now pending a retry instead.
    fails = {
        p: f
        for p, f in fails.items()
        if p not in converted_paths
        and p not in new_pending_paths
        and f.get("zarr") not in removed_set
    }
    for f in failures:
        fails[f["path"]] = f

    # --- pending -------------------------------------------------------------
    prior_attempts: dict[str, int] = {}
    for e in prior_pending or []:
        if isinstance(e, dict) and isinstance(e.get("path"), str):
            n = e.get("attempts")
            prior_attempts[e["path"]] = int(n) if isinstance(n, int) and n > 0 else 0
    # Every value here comes from `_pending_entry`, so the container carries the
    # TypedDict rather than a bare dict: a hand-built entry missing `zarr` or
    # `attempts` is then a type error at the call site instead of a schema
    # violation at the end of the run.
    pends: dict[str, PendingEntry] = {}
    for e in prior_pending or []:
        # Carry forward a recording this run never touched (an incremental run
        # converts only what changed), minus anything now resolved or excluded.
        if not (isinstance(e, dict) and isinstance(e.get("path"), str)):
            continue
        p = e["path"]
        if p in converted_paths or p in fails or is_excluded_from_discovery(p):
            continue
        pends[p] = _pending_entry(
            p,
            _pending_reason(e.get("reason")),
            prior_attempts.get(p, 0),
            e.get("last_error"),
            e.get("last_attempt_utc"),
        )
    for e in pending:
        p = e["path"]
        pends[p] = _pending_entry(
            p,
            _pending_reason(e.get("reason")),
            prior_attempts.get(p, 0) + 1,
            e.get("last_error"),
            e.get("last_attempt_utc") or updated_utc,
        )

    for path, message in (deferred or {}).items():
        rel = store_rel_for(path)
        seeded_store = _entry_for_path(seed, "stores", path)
        if seed_current and seeded_store is not None and path not in converted_paths:
            stores[rel] = _heal_carried_units_report(seeded_store)
            pends.pop(path, None)
            fails.pop(path, None)
            continue
        stores.pop(rel, None)
        # A typed failure is a verdict on the recording AS IT WAS read, by the engine
        # that read it. Under a stale index (the data changed, or a newer engine may
        # read it) it may no longer be true, and a failure is never retried, so
        # keeping it would publish an obsolete verdict as final: the recording goes
        # back to pending instead. Under a current index it is still the verdict.
        if seed_current:
            seeded_failure = fails.get(path) or _entry_for_path(seed, "failures", path)
        else:
            fails.pop(path, None)
            seeded_failure = None
        if seeded_failure is not None:
            fails[path] = seeded_failure
            pends.pop(path, None)
            continue
        history = pends.get(path)
        earlier = _without_deferral(history["last_error"] if history else None)
        text = message if not earlier else f"{message}; last error: {earlier}"
        pends[path] = _pending_entry(
            path,
            "not_attempted",
            prior_attempts.get(path, 0),
            text[:_DETAIL_MAX_CHARS],
            history["last_attempt_utc"] if history else None,
        )

    if discovered is not None:
        wanted = set(discovered)
        # A carried-over store whose path is EXCLUDED from discovery goes, and
        # goes NOISILY. ADR 0027 made discovery raw-only and
        # `purge_non_raw_stores.py` is the authorized deletion of what it stopped
        # producing, so a non-raw store is not something the archive serves -- an
        # index that kept describing one would advertise bytes that are being
        # removed. But dropping a store silently is how a real orphan bug would
        # hide, so each one is named with the reason it was excluded.
        dropped_non_raw = sorted(
            (str(e.get("path") or ""), excluded_reason(str(e.get("path") or "")))
            for e in stores.values()
            if e.get("path") not in wanted
            and is_excluded_from_discovery(str(e.get("path") or ""))
        )
        for path, reason in dropped_non_raw:
            print(
                f"[zarr] dropping non-raw store from the index: {path} ({reason})",
                flush=True,
            )
        stores = {z: e for z, e in stores.items() if e.get("path") in wanted}
        # Failures and pending entries are filtered the same way, and the
        # carry-forward above already refuses a now-excluded path, so neither
        # list can carry a non-raw recording either.
        fails = {p: f for p, f in fails.items() if p in wanted}
        pends = {p: e for p, e in pends.items() if p in wanted}
        accounted = {e.get("path") for e in stores.values()} | set(fails) | set(pends)
        for p in wanted - accounted:
            # Discovered, attempted by nobody this run: a `--limit`ed or
            # short-circuited run, or a recording the worklist never reached.
            # Recorded with attempts 0 so it neither ages toward exhaustion nor
            # disappears from the accounting.
            pends[p] = _pending_entry(p, "not_attempted", 0)

    # Exhaustion: stop promising a recording that has had its rounds. Done AFTER
    # the discovered reconciliation so a promoted entry is one that is still at
    # HEAD, and `not_attempted` is exempt because it has not been tried at all.
    for p, e in list(pends.items()):
        if e["reason"] == "not_attempted" or e["attempts"] < PENDING_MAX_ATTEMPTS:
            continue
        del pends[p]
        fails[p] = _failure_entry(
            p, "retry_exhausted", e.get("last_error"), e["attempts"]
        )

    ordered = [_normalize_store_entry(stores[k]) for k in sorted(stores)]
    ordered_fails = [fails[k] for k in sorted(fails)]
    ordered_pending = [pends[k] for k in sorted(pends)]

    prefix = f"{dataset_id}/zarr/"
    return {
        "format": INDEX_FORMAT,
        "format_version": INDEX_FORMAT_VERSION,
        "dataset_id": dataset_id,
        # The stable base, and the two forms of "where the bytes are today".
        # Per-dataset rather than global so a single dataset can be mirrored or
        # migrated without rewriting anyone's client (#1059).
        "contract_base": f"{contract_base.rstrip('/')}/{prefix}",
        "data_base": f"https://{bucket}.s3.{region}.amazonaws.com/{prefix}",
        "data_base_kind": "s3-public",
        "s3_uri": f"s3://{bucket}/{prefix}",
        "s3_region": region,
        "s3_anonymous": True,
        "source_commit": head_commit,
        "engine_version": engine_version,
        "biosigio_version": biosigio_version,
        "updated_utc": updated_utc,
        # Dataset-level provenance, hoisted to the top level (#1064). Already
        # fetched once per run for the store attrs, so publishing it here is
        # free -- and it saves an MCP broker or a citation tool one request per
        # dataset, which is the difference between "read the index" and "read the
        # index and then the catalog" for every recipe. Nullable throughout: the
        # catalog genuinely may not have a DOI yet.
        **index_provenance(dataset_row),
        # How to turn this index's numbers into reads, without probing.
        "layout": dict(INDEX_LAYOUT),
        "discovered_count": (
            len(set(discovered))
            if discovered is not None
            else len(ordered) + len(ordered_fails) + len(ordered_pending)
        ),
        "store_count": len(ordered),
        # #1059 asked for `n_recordings`; it is the store count under another
        # name. The discovered total is `discovered_count`, deliberately a
        # different word, because conflating the two is how coverage went
        # unnoticed in the first place.
        "n_recordings": len(ordered),
        "errors": len(failures) + len(pending) if errors is None else errors,
        "failure_count": len(ordered_fails),
        "pending_count": len(ordered_pending),
        "stores": ordered,
        "failures": ordered_fails,
        "pending": ordered_pending,
    }


def deferral_leaves_index_as_is(
    live_index: dict | None,
    seed_current: bool,
    convert: list[str],
    deferred,
    remove: list[str],
    failed: list[str],
    wipe: bool,
) -> bool:
    """Whether a run in which the scratch gate deferred EVERYTHING it was asked to
    convert has nothing to say that the published index does not already say.

    Rewriting it anyway is not free: a metadata clone, a manifest and index PUT, and
    (when stores are carried) an `events.parquet` download and upload, every
    `PENDING_BACKOFF_SECONDS[0]` for a recording that can never fit. And for a
    ``--clean`` run it is not harmless either, since the merge is handed no prior and
    would republish the dataset with only what this run converted.

    True when every deferred path is already accounted for as the run would leave
    it: pending with the `not_attempted` reason and a deferral note (written by the
    first run that deferred it), a typed failure, or a store the index may keep
    (``seed_current``). Anything else (a stale store to turn into a pending entry,
    an older ``infra_failure`` reason to correct) is a real change and publishes."""
    if not isinstance(live_index, dict) or wipe or remove or failed or not deferred:
        return False
    if set(deferred) != set(convert):
        return False
    pending = {
        e["path"]: e
        for e in live_index.get("pending") or []
        if isinstance(e, dict) and isinstance(e.get("path"), str)
    }
    stores = {
        e.get("path") for e in live_index.get("stores") or [] if isinstance(e, dict)
    }
    failures = {
        e.get("path") for e in live_index.get("failures") or [] if isinstance(e, dict)
    }
    for path in deferred:
        entry = pending.get(path)
        if entry is not None:
            note = str(entry.get("last_error") or "")
            if entry.get("reason") != "not_attempted" or not note.startswith(_DEFERRED_PREFIX):
                return False
        elif not seed_current:
            return False  # a stale store or verdict is a real change
        elif path in failures or path in stores:
            continue
        else:
            return False
    return True


def deferred_unchanged_callback(
    dataset_id: str,
    head: str,
    live_index: dict,
    live_etag: str | None,
    deferred,
    discovered_count: int,
    non_raw_dropped: int,
    provenance_fetch_failed: bool,
) -> dict:
    """The zarr-ready body for a run that deferred everything and published nothing.

    It restates the published index's own numbers, because the backend overwrites
    its row from this body: an empty ``data_failures`` would clear the failure
    summary, and a ``pending_count`` of zero would stop the queue re-queueing
    recordings that are still owed. ``not_attempted_count`` counts the deferred
    recordings among the pending ones, so ``zarr_queue.mark_done`` neither advances
    a retry round nor schedules a longer backoff for them.

    The body is POSTed like any other, and it has to be: the run began with a
    `converting` signal that sets ``zarr_status`` to `pending`, and without a
    terminal `ready` a dataset that serves stores would stay `pending`, lose its
    ``zarr_index_url`` and drop out of every "has a Zarr copy" filter. The known
    cost is that a `ready` body restamps ``zarr_converted_at`` and re-queues the
    recording-stats sweep; the webhook has no status that says "nothing changed",
    and adding one is a backend change that does not belong in this converter."""
    pending = [
        e for e in live_index.get("pending") or []
        if isinstance(e, dict) and isinstance(e.get("path"), str)
    ]
    failures = [
        e for e in live_index.get("failures") or [] if isinstance(e, dict)
    ]
    deferred_paths = set(deferred)
    deferred_pending = sum(1 for e in pending if e["path"] in deferred_paths)
    errors = live_index.get("errors")
    return {
        "dataset_id": dataset_id,
        "status": "ready",
        "store_count": int(live_index.get("store_count") or 0),
        "index_etag": (live_etag or "").strip().strip('"') or None,
        # The commit the PUBLISHED index names, not this run's HEAD: nothing was
        # rebuilt, so the row must keep agreeing with the document it describes.
        "commit": live_index.get("source_commit") or head,
        "converted": [],
        "removed": [],
        "errors": errors if isinstance(errors, int) else len(failures) + len(pending),
        "failed": [],
        "failure_count": int(live_index.get("failure_count") or len(failures)),
        "data_failures": [{"path": f.get("path"), "code": f.get("code")} for f in failures],
        "deterministic": False,
        **annex_missing_summary([]),
        "pool_breaks": 0,
        "calibration": [],
        "measured_count": 0,
        # This run attempted nothing, so nothing in it failed for a retryable
        # reason; the pending recordings are counted below. `hallu-zarr.sh` logs
        # "N recording(s) failed for a RETRYABLE reason" from this field, which
        # would otherwise repeat every hour for a recording that only waits for room.
        "retryable_failures": 0,
        "pending_count": len(pending),
        "discovered_count": discovered_count,
        "not_attempted_count": deferred_pending,
        "non_raw_dropped": non_raw_dropped,
        "provenance_fetch_failed": provenance_fetch_failed,
        "manifest_upload_failed": False,
        "events_row_count": live_index.get("events_row_count"),
        "events_upload_failed": False,
        "events_stores_without_rows": 0,
    }


def check_index_invariant(index: dict) -> None:
    """Raise unless every discovered recording is accounted for exactly once.

    `discovered_count == store_count + failure_count + pending_count` is the whole
    of #1197's acceptance criterion, and `merge_index` makes it true by
    construction -- which is exactly why it is worth asserting separately. The
    construction is the thing that could regress, and a silently unbalanced index
    is the failure mode being fixed: it looks complete and is not.

    There is no exemption for the pre-ADR-0027 non-raw stores. They are being
    deleted, not served (`purge_non_raw_stores.py`), so a carried-over entry for
    one is dropped by `merge_index` and reported as `non_raw_dropped` on the
    callback -- it never reaches `store_count`, and the equation stays a plain
    sum.
    """
    discovered = index.get("discovered_count")
    parts = (
        index.get("store_count"),
        index.get("failure_count"),
        index.get("pending_count"),
    )
    if not isinstance(discovered, int) or any(not isinstance(n, int) for n in parts):
        raise ValueError(
            "index coverage counts are missing or non-integer: "
            f"discovered={discovered!r} store/failure/pending={parts!r}"
        )
    if discovered != sum(parts):  # type: ignore[arg-type]
        raise ValueError(
            f"index coverage does not balance for {index.get('dataset_id')}: "
            f"discovered_count={discovered} but store_count+failure_count+"
            f"pending_count={sum(parts)} "  # type: ignore[arg-type]
            f"({parts[0]}+{parts[1]}+{parts[2]})"
        )


def kept_manifest_seed(bucket: str, dataset_id: str, kept: set[str], read=None) -> dict:
    """The published manifest's entries for the stores an index kept, as a prior for
    `merge_manifest`. The manifest is producer bookkeeping, so a read that fails or
    finds nothing does not fail the run, but it is never silent:
    the kept stores then have no ``source_key`` in the manifest until a run rebuilds
    them, and the warning says which read failed and how many are affected."""
    reader = read or s3_read_json
    try:
        live = reader(bucket, f"{dataset_id}/zarr/manifest.json")
    except Exception as exc:  # noqa: BLE001 - bookkeeping; reported, not fatal
        print(
            f"::warning::could not read the published manifest ({exc}); {len(kept)} kept "
            "store(s) will have no source_key or size in the new manifest",
            flush=True,
        )
        return {"stores": []}
    if live is None:
        print(
            f"::warning::no published manifest to carry {len(kept)} kept store(s) from; "
            "they will have no source_key or size in the new manifest",
            flush=True,
        )
        return {"stores": []}
    return {
        "stores": [
            e for e in live.get("stores") or []
            if isinstance(e, dict) and e.get("zarr") in kept
        ]
    }


def merge_manifest(
    prior: dict | None,
    dataset_id: str,
    entries: list[dict],
    store_rels: list[str],
    updated_utc: str,
    events_file: ManifestFileEntry | None = None,
) -> dict:
    """Build the producer manifest (`<id>/zarr/manifest.json`). Pure.

    Carries the git-annex `source_key` (and its declared size) per store. This
    used to ride in index.json, where it was 2.3 MB of nm000281's 12.8 MB and read
    by nothing: index.json is fetched on every dataset-page visit, the manifest by
    no one but us (#1178 item 5).

    Restricted to `store_rels` -- the rels the index actually publishes -- so the
    two documents can never disagree about which stores exist.

    `events_file` is `{name, size_bytes, row_count}` for the events.parquet THIS
    run uploaded, or None when it published none. Recorded rather than inferred:
    the index says the file exists and how many rows it has, and this says how
    many bytes the producer actually wrote -- which is what makes "the object on
    S3 is the one this run wrote" checkable with a HEAD instead of a download.
    Not carried over from `prior`: a run that published no file must not claim
    the previous run's bytes.
    """
    by_rel: dict[str, dict] = {}
    if prior and isinstance(prior.get("stores"), list):
        for e in prior["stores"]:
            if isinstance(e, dict) and isinstance(e.get("zarr"), str):
                by_rel[e["zarr"]] = e
    for e in entries:
        by_rel[e["zarr"]] = e
    keep = set(store_rels)
    return {
        "format": MANIFEST_FORMAT,
        "format_version": MANIFEST_FORMAT_VERSION,
        "dataset_id": dataset_id,
        "updated_utc": updated_utc,
        **({"files": [events_file]} if events_file else {}),
        "stores": [
            {
                "zarr": rel,
                "source_key": by_rel[rel].get("source_key"),
                "size_bytes": by_rel[rel].get("size_bytes"),
            }
            for rel in sorted(keep & set(by_rel))
        ],
    }


def validate_document(doc: dict, schema_path: str, label: str) -> None:
    """Validate a document against its JSON Schema before it is uploaded.

    A producer bug caught here costs one failed run; the same bug caught by a
    consumer costs every consumer. Degrades to a loud warning rather than a
    failure when `jsonschema` or the schema file is unavailable, so a node whose
    venv predates the pin still converts -- the check is a guard rail, not a
    dependency of serving.
    """
    try:
        import jsonschema  # type: ignore[import-not-found]
    except ImportError:
        print(
            f"::warning::jsonschema is not installed; the {label} was NOT validated "
            "against its schema before upload (add it: scripts/zarr/requirements.txt)",
            flush=True,
        )
        return
    try:
        with open(schema_path, encoding="utf-8") as fh:
            schema = json.load(fh)
    except OSError as exc:
        print(
            f"::warning::could not read {schema_path} ({exc}); the {label} was NOT "
            "validated against its schema before upload",
            flush=True,
        )
        return
    jsonschema.validate(doc, schema)


# --- events.parquet -----------------------------------------------------------
# One columnar file per dataset, at `<id>/zarr/events.parquet`, so a client can
# plan epochs and shards with zero signal bytes read and the MCP (ADR 0025) has a
# `get_events` source. The converter is the only party that knows the exact
# resampling relation, so `sample_index` is computed HERE rather than re-derived
# (differently, and wrong on non-integer rate ratios) by every client.
#
# Memory is the constraint that shapes the code below: nm000281 has ~25k stores,
# and a dataset's rows do not fit in one table. So rows are staged per store on
# disk as they arrive, and the file is written store by store into a
# ParquetWriter -- never one giant frame.

# Rows buffered before a row group is flushed. Big enough that a 25k-store
# dataset does not end up with 25k row groups (each carries per-column
# statistics in the footer), small enough that the buffer stays bounded.
EVENTS_ROW_GROUP_ROWS = int(os.environ.get("ZARR_EVENTS_ROW_GROUP_ROWS", "65536"))
EVENTS_PARQUET_NAME = "events.parquet"
# IANA-registered media type for Apache Parquet.
EVENTS_CONTENT_TYPE = "application/vnd.apache.parquet"


class EventsStaging:
    """This run's event rows, held on disk keyed by store, not in memory.

    A pool worker returns one store's rows as they are converted and `main` hands
    them straight to `add`, which serializes them and forgets them; `get` reads
    one store back at write time. What stays resident is the offset table (one
    entry per store) and the set of pass-through column names -- both proportional
    to the STORE count, not the event count.

    The backing file is an anonymous `tempfile.TemporaryFile`: it has no name in
    the filesystem, so it cannot be left behind by a crash the way a
    `delete=False` temp file was (#1068).
    """

    def __init__(self) -> None:
        # Deliberately long-lived and deliberately anonymous: it is written
        # to across a whole run and read at the end, and an unnamed temp file
        # cannot be left behind on the node's scratch (#1068).
        self._fh = tempfile.TemporaryFile()  # noqa: SIM115 - closed by GC/process exit
        self._index: dict[str, tuple[int, int]] = {}
        self._extras: set[str] = set()
        self.row_count = 0

    def add(self, zarr_rel: str, columns: dict[str, list]) -> None:
        blob = pickle.dumps(columns, protocol=pickle.HIGHEST_PROTOCOL)
        self._fh.seek(0, os.SEEK_END)
        offset = self._fh.tell()
        self._fh.write(blob)
        self._index[zarr_rel] = (offset, len(blob))
        self._extras.update(k for k in columns if k not in EVENTS_FIXED_COLUMNS)
        self.row_count += len(columns.get("store_path", ()))

    def __contains__(self, zarr_rel: object) -> bool:
        return zarr_rel in self._index

    def __len__(self) -> int:
        return len(self._index)

    @property
    def extras(self) -> set[str]:
        return set(self._extras)

    def get(self, zarr_rel: str) -> dict[str, list] | None:
        entry = self._index.get(zarr_rel)
        if entry is None:
            return None
        offset, size = entry
        self._fh.seek(offset)
        return pickle.loads(self._fh.read(size))


class ArrowTable(Protocol):
    """The `pyarrow.Table` surface this module actually touches.

    A structural Protocol rather than an import, because pyarrow is an OPTIONAL
    dependency loaded lazily inside the functions that need it: a node without
    it still converts, it just publishes no events file. There is therefore no
    module-scope name to annotate with, and a `TYPE_CHECKING` import would still
    make a checker's answer depend on whether the package happens to be
    installed. Stating the three members used here says the same thing, costs
    nothing at runtime, and turns `table["store_path"]` and `table.filter(mask)`
    back into checked accesses instead of attribute lookups on `object`.
    """

    @property
    def num_rows(self) -> int: ...

    def __getitem__(self, key: str) -> Any: ...

    def filter(self, mask: Any) -> ArrowTable: ...


class PriorEventRows:
    """Random access by store into the events.parquet a previous run published.

    An incremental run converts only what changed, so the stores it did NOT touch
    keep the rows they already had -- exactly how the index carries a store entry
    forward. Row groups are indexed by the stores they contain (reading one
    column, not the file), so carrying a store forward reads its rows and nothing
    else; the last row group read is cached because the caller walks stores in
    sorted order and the file is written in that same order.
    """

    def __init__(self, path: str) -> None:
        import pyarrow as pa  # type: ignore[import-not-found]  # lazy: optional dep
        import pyarrow.parquet as pq  # type: ignore[import-not-found]

        self._pa = pa
        self._file = pq.ParquetFile(path)
        self.extras = {
            name
            for name in self._file.schema_arrow.names
            if name not in EVENTS_FIXED_COLUMNS
        }
        self._by_rel: dict[str, list[int]] = {}
        for i in range(self._file.num_row_groups):
            column = self._file.read_row_group(i, columns=["store_path"])["store_path"]
            for rel in column.unique().to_pylist():
                if rel is not None:
                    self._by_rel.setdefault(rel, []).append(i)
        self._cached: tuple[int, ArrowTable] | None = None

    def __contains__(self, zarr_rel: object) -> bool:
        return zarr_rel in self._by_rel

    def _row_group(self, i: int) -> ArrowTable:
        """The i-th row group (cached: consecutive stores usually share one).

        Typed as `ArrowTable`, the structural Protocol declared above, rather
        than `object`: pyarrow is an optional dependency imported lazily inside
        the methods that need it, so there is no importable name to annotate
        with, and `object` made every `table[column]` and `table.filter(...)`
        below an unchecked attribute access on a value the checker believed had
        neither.
        """
        if self._cached is None or self._cached[0] != i:
            self._cached = (i, self._file.read_row_group(i))
        return self._cached[1]

    def table_for(self, zarr_rel: str, schema):
        """The prior rows for one store, conformed to `schema`, or None."""
        import pyarrow.compute as pc  # type: ignore[import-not-found]

        groups = self._by_rel.get(zarr_rel)
        if not groups:
            return None
        parts: list[ArrowTable] = []
        for i in groups:
            table = self._row_group(i)
            mask = pc.equal(table["store_path"].cast(self._pa.string()), zarr_rel)
            part = table.filter(mask)
            if part.num_rows:
                parts.append(part)
        if not parts:
            return None
        table = parts[0] if len(parts) == 1 else self._pa.concat_tables(parts)
        return conform_events_table(self._pa, table, schema)


def events_schema(pa, extras):
    """The parquet schema: the fixed columns (#1060) then the pass-through ones.

    Extras are sorted rather than kept in first-seen order on purpose: workers
    finish in arbitrary order, and a column order that depended on which
    recording converted first would make two runs over the same commit produce
    different files.
    """
    label = pa.dictionary(pa.int32(), pa.string())
    fields = [
        ("store_path", label),
        ("subject", label),
        ("session", label),
        ("task", label),
        ("run", label),
        ("onset_s", pa.float64()),
        ("duration_s", pa.float32()),
        ("sample_index", pa.int64()),
        ("group_name", label),
        ("trial_type", label),
        ("value", label),
        ("hed", label),
    ]
    fields += [(name, label) for name in sorted(extras)]
    return pa.schema(fields)


def events_table_from_columns(pa, schema, columns: dict[str, list]):
    """One store's staged columns as a table in the dataset-wide schema. A column
    this store's events.tsv did not have is all-null, not absent: the file has one
    schema, and a client must not have to ask which stores contributed which
    columns."""
    n = len(columns.get("store_path", ()))
    arrays = [
        pa.array(columns.get(field.name, [None] * n), type=field.type)
        for field in schema
    ]
    return pa.Table.from_arrays(arrays, schema=schema)


def conform_events_table(pa, table, schema):
    """Bring a table read back from a prior file into `schema` -- filling a column
    that file did not have with nulls, since a later run may have added one."""
    n = table.num_rows
    arrays = []
    for field in schema:
        if field.name in table.column_names:
            column = table[field.name]
            arrays.append(column if column.type == field.type else column.cast(field.type))
        else:
            arrays.append(pa.chunked_array([pa.nulls(n, field.type)]))
    return pa.Table.from_arrays(arrays, schema=schema)


def write_events_parquet(
    out_path: str,
    ordered_rels: list[str],
    staged: EventsStaging,
    prior: PriorEventRows | None = None,
    reconverted: set[str] | None = None,
) -> int:
    """Write `<id>/zarr/events.parquet` and return the row count.

    Stores are visited in the order given (the index's, i.e. sorted by `zarr`),
    and each store's rows are already ordered by onset, so the file is sorted by
    `store_path, onset_s` by construction -- no global sort, and therefore no
    point at which the whole dataset is in memory. Rows accumulate only until
    `EVENTS_ROW_GROUP_ROWS`, then become a row group.

    The MCP's `get_events` relies on that order (#1498): for a file over its
    whole-file budget it reads only the row groups whose `store_path` min/max
    statistics can hold the recording asked for (`storeRowGroupSpan` in
    `backend/src/mcp/tools/get-events.ts`). An unsorted file is still read
    correctly there, but those row groups then span more of it and more
    recordings are declined.

    A store with rows from THIS run uses them. A store this run did NOT reconvert
    keeps the rows the prior file has for it. `reconverted` is what separates the
    two, and it is not `staged`: a store that WAS reconverted and produced no
    rows (its events.tsv was deleted, or emptied) must publish no rows, not
    silently inherit the ones the prior file still has for it. Passing None means
    "nothing was reconverted", the read-only shape the pure writer tests use.
    """
    import pyarrow as pa  # type: ignore[import-not-found]  # lazy: optional dep
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    schema = events_schema(pa, staged.extras | (prior.extras if prior else set()))
    total = 0
    buffered: list = []
    buffered_rows = 0
    writer = pq.ParquetWriter(out_path, schema, compression="zstd")
    try:
        for rel in ordered_rels:
            columns = staged.get(rel)
            if columns is not None:
                table = events_table_from_columns(pa, schema, columns)
            elif prior is not None and not (reconverted and rel in reconverted):
                table = prior.table_for(rel, schema)
            else:
                table = None
            if table is None or not table.num_rows:
                continue
            buffered.append(table)
            buffered_rows += table.num_rows
            total += table.num_rows
            if buffered_rows >= EVENTS_ROW_GROUP_ROWS:
                writer.write_table(pa.concat_tables(buffered))
                buffered, buffered_rows = [], 0
        if buffered:
            writer.write_table(pa.concat_tables(buffered))
    finally:
        writer.close()
    return total


def parse_annex_key(blob_text: str) -> str | None:
    """Annex key from a locked-mode symlink target or an unlocked pointer blob."""
    t = blob_text.strip()
    m = ANNEX_TARGET_RE.search(t)
    if m:
        return m.group(1)
    m = ANNEX_POINTER_CONTENT_RE.match(t)
    return m.group(1) if m else None


# --- I/O (git, S3, conversion) ------------------------------------------


def _run(cmd: list[str], cwd: str | None = None) -> str:
    return subprocess.check_output(cmd, cwd=cwd, text=True)


def _run_z(cmd: list[str]) -> list[str]:
    """The NUL-separated fields of a `git ... -z` command's output, as file system
    names. Without `-z` git wraps any name with a byte above 0x7f (or a quote, a
    backslash, a control character) in double quotes and escapes it, so
    `Müller_01.eeg` comes back as `"M\\303\\274ller_01.eeg"`: a string no file has
    and no extension test matches. Decoded as the file system decodes names, so a
    name that is not valid UTF-8 survives the round trip to `open`."""
    out = subprocess.check_output(cmd)
    return [os.fsdecode(field) for field in out.split(b"\0") if field]


def git_ls_files(repo_dir: str, ref: str) -> list[str]:
    return _run_z(["git", "-C", repo_dir, "ls-tree", "-r", "-z", "--name-only", ref])


def _name_status_pairs(fields: list[str]) -> list[tuple[str, str]]:
    """`(status, path)` pairs from the fields of `git diff --name-status -z`: each
    entry is `<status> NUL <path> NUL`, one path since `--no-renames` leaves no
    copy or rename to carry two. An odd number of fields means an entry lost its
    path (or one carries two): pairing the rest would silently drop or mispair
    the tail, and an incremental run would then miss a changed recording, so it
    is an error instead."""
    statuses, paths = fields[0::2], fields[1::2]
    if len(statuses) != len(paths):
        raise RuntimeError(
            f"git diff --name-status -z gave {len(fields)} fields, which do not pair "
            f"up as status and path ({len(statuses)} statuses, {len(paths)} paths)"
        )
    return [(status[:1], path) for status, path in zip(statuses, paths, strict=True)]


def git_diff_name_status(repo_dir: str, base: str, head: str) -> list[tuple[str, str]]:
    return _name_status_pairs(
        _run_z(
            ["git", "-C", repo_dir, "diff", "--no-renames", "--name-status", "-z", f"{base}..{head}"]
        )
    )


def is_ancestor(repo_dir: str, maybe_ancestor: str, head: str) -> bool:
    """True iff `maybe_ancestor` is an ancestor of `head`.

    `merge-base --is-ancestor` exits 0 (yes), 1 (no), or other (git error, e.g.
    an unknown commit after a history rewrite). A git error is treated as "not
    an ancestor" (so the run falls back to a full rebuild, which is correct for
    a rewritten prior commit) but is logged so it isn't mistaken for a clean no.
    """
    res = subprocess.run(
        ["git", "-C", repo_dir, "merge-base", "--is-ancestor", maybe_ancestor, head],
        capture_output=True,
        text=True,
    )
    if res.returncode not in (0, 1):
        print(
            f"::warning::merge-base --is-ancestor {maybe_ancestor[:8]}..{head[:8]} "
            f"exited {res.returncode}: {res.stderr.strip()}; treating as non-ancestor",
            flush=True,
        )
    return res.returncode == 0


def safe_store_prefix(bucket: str, dataset_id: str, rel_store: str) -> str:
    """Build the S3 prefix for a store, validating `rel_store` first.

    This prefix feeds `aws s3 sync --delete` and `aws s3 rm --recursive`, so an
    empty or path-traversal value could wipe an unintended prefix (e.g. the
    whole `<id>/zarr/`). Reject anything that isn't a clean `*.zarr` rel-path.
    """
    if not rel_store or not rel_store.endswith(".zarr"):
        raise ValueError(f"unsafe store rel-path {rel_store!r}: empty or not a .zarr")
    parts = rel_store.split("/")
    if rel_store.startswith("/") or "" in parts or ".." in parts:
        raise ValueError(f"unsafe store rel-path {rel_store!r}: traversal or empty segment")
    return f"s3://{bucket}/{dataset_id}/zarr/{rel_store}/"


def validate_store(store_local: str) -> None:
    """Raise if biosigIO produced an empty/partial store.

    Guards the `aws s3 sync --delete` below: syncing an empty local directory to
    a populated destination would DELETE a previously-valid store. A biosigIO
    Zarr v3 store always has a root `zarr.json`.
    """
    if not os.path.isdir(store_local) or not os.path.exists(os.path.join(store_local, "zarr.json")):
        raise RuntimeError(f"biosigIO wrote no zarr.json at {store_local}; store is empty/partial")


_AWS_RETRIES = int(os.environ.get("ZARR_AWS_RETRIES", "4"))
# Per-read socket timeout: the PRIMARY defense against a wedged S3 connection.
# Symptom (observed repeatedly from Hallu): aws opens several sockets to S3, the
# TCP handshakes complete, then a signed request stalls -- Send-Q backs up, no
# response bytes ever arrive, and the op sits burning a trickle of CPU on retries
# that reuse the dead socket. A SHORT read timeout is the cure: botocore abandons
# the wedged socket and reconnects (AWS_MAX_ATTEMPTS, below), and a fresh
# connection to a healthy S3 IP answers in ~200 ms, so the op recovers in seconds.
# The old 300 s made every wedge cost 5 minutes, so a recursive rm of an
# already-empty prefix could spin for hours before landing a good socket. 30 s
# reaps the wedge fast while far exceeding any healthy read gap -- a live transfer
# streams body bytes continuously, so 30 s of total silence is always a stall,
# never a legitimately slow-but-progressing read. Override with
# ZARR_AWS_READ_TIMEOUT.
_AWS_READ_TIMEOUT = os.environ.get("ZARR_AWS_READ_TIMEOUT", "30")
_AWS_TIMEOUTS = ["--cli-connect-timeout", "30", "--cli-read-timeout", _AWS_READ_TIMEOUT]
# Hard wall-clock cap per aws invocation (seconds) for transfers (cp/sync). A
# wedged process is killed and retried rather than hanging a worker forever.
# Generous so a legitimately slow multi-GB transfer never trips it; override with
# ZARR_AWS_TIMEOUT.
_AWS_OP_TIMEOUT = int(os.environ.get("ZARR_AWS_TIMEOUT", "1800"))
# Recursive deletes (`aws s3 rm --recursive` on a whole `<id>/zarr/` prefix or a
# store) are a different beast: a big dataset's prefix holds hundreds of stores x
# thousands of chunk objects = millions of keys, and DeleteObjects batches 1000 at
# a time, so a legitimate wipe can run far longer than a single transfer. Give it
# a much larger ceiling (and FEWER retries, so a true wedge fails in bounded time
# instead of N x the ceiling). The 1800 s transfer cap was killing real wipes of
# large datasets (e.g. on005261, 318 stores) mid-delete -> rebuild then 404'd.
_AWS_RM_TIMEOUT = int(os.environ.get("ZARR_AWS_RM_TIMEOUT", str(4 * 3600)))
_AWS_RM_RETRIES = int(os.environ.get("ZARR_AWS_RM_RETRIES", "2"))


def _aws_env() -> dict:
    """Environment for an aws subprocess: more internal API retries for transient
    throttle/5xx (the CLI honors ``AWS_MAX_ATTEMPTS``). The per-process S3
    transfer concurrency (``s3.max_concurrent_requests``) is config-only and is
    pinned low on the runner's profile out of band, so JOBS-way parallelism does
    not fan out to hundreds of concurrent connections (the cause of multipart
    download races and ``Need to rewind the stream`` upload failures)."""
    env = dict(os.environ)
    env.setdefault("AWS_MAX_ATTEMPTS", "10")
    return env


def _aws(
    cmd: list[str], *, timeout: int = _AWS_OP_TIMEOUT, retries: int = _AWS_RETRIES
) -> None:
    """Run an aws CLI command with a wall-clock timeout + backoff retry.

    A transfer that errors (throttle, multipart race) OR wedges past ``timeout``
    is retried; both `CalledProcessError` and `TimeoutExpired` (the wedge) count
    as a failed attempt. Raises RuntimeError after the last attempt.
    """
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            subprocess.run([*cmd, *_AWS_TIMEOUTS], check=True, timeout=timeout, env=_aws_env())
            return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            last = exc
            if attempt < retries:
                time.sleep(min(2**attempt, 30))
    raise RuntimeError(f"aws {' '.join(cmd[1:3])} failed after {retries} attempts: {last}")


def _s3_prefix_empty(bucket: str, prefix: str) -> bool:
    """True only when a LIST of ``s3://bucket/prefix`` confirmably returns 0 keys.

    Lets the ``--clean`` wipe skip ``aws s3 rm --recursive`` when the serving
    prefix is already empty -- the common first-conversion / backfill case. The
    recursive rm still opens sockets and, if one wedges, spins on a prefix with
    nothing to delete; a single cheap LIST (short read timeout, so a wedge is
    reaped fast) sidesteps that entirely. Any error or ambiguity returns False so
    the caller falls through to the real rm rather than skipping a needed wipe.
    """
    try:
        res = subprocess.run(
            [
                "aws", "s3api", "list-objects-v2", "--bucket", bucket,
                "--prefix", prefix, "--max-items", "1",
                "--query", "Contents[0].Key", "--output", "text",
                *_AWS_TIMEOUTS,
            ],
            capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
        )
    except (subprocess.SubprocessError, OSError):
        return False
    if res.returncode != 0:
        return False
    # `--query Contents[0].Key --output text` prints the first key, or "None" when
    # the prefix holds no objects.
    return res.stdout.strip() in ("", "None")


# How many `aws s3 rm --recursive` processes to shard a big prefix across. Each
# inherits the runner profile's own (deliberately low) per-process request
# concurrency, so this multiplies delete throughput without raising the transfer
# concurrency that was pinned low to stop JOBS-way uploads causing multipart
# races. A single rm measured 13.8k objects/min on Hallu; the wipes that remain
# after the --clean change are rare (recovery via --wipe) but can still be huge.
_AWS_RM_SHARDS = int(os.environ.get("ZARR_AWS_RM_SHARDS", "8"))


def _s3_child_prefixes(url: str) -> list[str]:
    """Immediate child prefixes of an ``s3://bucket/prefix/`` URL (delimited LIST).

    ``[]`` means the prefix genuinely HAS no subdirectories. A failed listing
    RAISES: the empty list and the failure used to be the same answer, which is
    only harmless for the caller this was written for. ``_rm_recursive`` reads
    ``[]`` as "nothing to shard" and falls back to one unsharded delete, so it is
    correct either way -- but ``purge_non_raw_stores.list_dataset_ids`` reads the
    same ``[]`` as "this bucket holds no datasets" and ``discover_excluded_stores``
    as "this tree has no stranded stores", and both then report a clean, empty
    result for a run that could not see the bucket at all.

    Same rule as ``s3_read_json`` and ``s3_download_file``, for the same reason:
    an absence is an answer, an error is not.
    """
    rest = url[len("s3://") :]
    bucket, _, prefix = rest.partition("/")
    res = subprocess.run(
        [
            "aws", "s3api", "list-objects-v2", "--bucket", bucket,
            "--prefix", prefix, "--delimiter", "/",
            "--query", "CommonPrefixes[].Prefix", "--output", "text",
            *_AWS_TIMEOUTS,
        ],
        capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
        check=False,  # the return code is inspected below rather than raised on
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"_s3_child_prefixes: aws s3api list-objects-v2 {url} exited "
            f"{res.returncode}: {res.stderr.strip()}"
        )
    if res.stdout.strip() in ("", "None"):
        return []
    return [f"s3://{bucket}/{p}" for p in res.stdout.split() if p and p != "None"]


def _rm_recursive(url: str) -> None:
    """Recursively delete an S3 prefix, sharded across child prefixes.

    `aws s3 rm --recursive` is single-process and paces at its profile's request
    concurrency, so a large prefix serializes into a long, near-idle wall-clock
    block. Splitting by child prefix lets N of them run at once. Falls back to one
    unsharded rm when the prefix has no children (or the LIST fails), and always
    finishes with an unsharded sweep so any key directly under `url` -- which no
    child prefix covers -- is deleted too.
    """
    # A failed LIST is not fatal HERE, and only here: the unsharded delete below
    # removes the whole prefix on its own, so sharding is a speed-up whose
    # failure costs time, not correctness. Every other caller of
    # `_s3_child_prefixes` reads its result as a fact about the bucket and must
    # see the error, which is why the tolerance lives at this call site rather
    # than inside the helper.
    try:
        children = _s3_child_prefixes(url) if _AWS_RM_SHARDS > 1 else []
    except (RuntimeError, subprocess.SubprocessError, OSError) as exc:
        print(
            f"::warning::could not list shards for {url} ({exc}); deleting unsharded",
            flush=True,
        )
        children = []
    if children:
        print(f"[zarr] deleting {url} across {len(children)} shard(s)", flush=True)
        errors: list[BaseException] = []
        with ThreadPoolExecutor(max_workers=min(_AWS_RM_SHARDS, len(children))) as pool:
            futures = {
                pool.submit(
                    _aws,
                    ["aws", "s3", "rm", child, "--recursive", "--only-show-errors"],
                    timeout=_AWS_RM_TIMEOUT,
                    retries=_AWS_RM_RETRIES,
                ): child
                for child in children
            }
            for fut in futures:
                try:
                    fut.result()
                except BaseException as exc:  # noqa: BLE001 -- re-raised below
                    errors.append(exc)
        if errors:
            # Surface the first failure; a partially-deleted prefix must not be
            # reported as a clean wipe.
            raise errors[0]
    # Sweep: catches loose keys at the top level, and is a cheap no-op once the
    # shards have done the bulk.
    _aws(
        ["aws", "s3", "rm", url, "--recursive", "--only-show-errors"],
        timeout=_AWS_RM_TIMEOUT,
        retries=_AWS_RM_RETRIES,
    )


def aws_cp(src: str, dst: str, *, extra: list[str] | None = None) -> None:
    # --only-show-errors drops the per-file transfer progress meter; with JOBS
    # workers each streaming a blob, that meter otherwise floods the log.
    _aws(["aws", "s3", "cp", src, dst, "--only-show-errors", *(extra or [])])


def annex_key_size(key: str | None) -> int | None:
    """Byte size a git-annex SHA256E/MD5E key declares in its ``-s<N>`` field
    (``SHA256E-s628291820--<hash>.con`` -> ``628291820``). ``None`` when the key
    carries no size (e.g. a URL/WORM key).

    Read from the key's FIELDS only, the part before the first ``--``: the name
    after it is free text for a WORM or URL key (``WORM-m1700000000--sub-01-s5.edf``,
    ``URL--https&c%%host%run-s5.edf``), and a ``-s5`` there is not a size. The
    size field is a whole ``-`` separated field, so ``-s12-S1024`` reads 12."""
    fields = (key or "").partition("--")[0]
    m = re.search(r"-s(\d+)(?=-|$)", fields)
    return int(m.group(1)) if m else None


def _blob_key_and_size(repo_dir: str, path: str, head: str) -> tuple[str | None, int]:
    """For a tracked path at ``head``: ``(annex_key, in_git_blob_bytes)``. An
    annexed path returns ``(key, 0)`` -- its size lives in the key's ``-s`` field;
    a small in-git blob returns ``(None, len(blob))``. Reads pointers only, never
    downloads S3 content. Mirrors ``_fetch_blob``'s annex-vs-in-git decision."""
    meta = _run(["git", "-C", repo_dir, "ls-tree", head, "--", path]).strip()
    if not meta:
        return None, 0
    mode, _, rest = meta.split(" ", 2)
    sha = rest.split("\t", 1)[0].strip()
    # Only a symlink or a small blob can be a pointer, so ask git for the size
    # first: a multi-GB in-git blob is sized without being read into memory.
    if mode != "120000":
        size = int(_run(["git", "-C", repo_dir, "cat-file", "-s", sha]).strip())
        if size >= 1024:
            return None, size
    blob = subprocess.check_output(["git", "-C", repo_dir, "cat-file", "blob", sha])
    if mode == "120000" or len(blob) < 1024:
        key = parse_annex_key(blob.decode("utf-8", "replace"))
        if key:
            return key, 0
    return None, len(blob)


def recording_size_info(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> tuple[int, bool]:
    """``(bytes, readable)``: on-disk bytes of a recording's whole file set, read
    from git-annex pointers at ``head`` WITHOUT downloading: primary + same-stem
    companions + FIF split members, or every file under a directory recording (CTF
    ``.ds``/MEF3 ``.mefd``/4D-BTi). Mirrors ``materialize_recording``'s wanted set
    and ``_recording_size_bytes`` so the parent's admission estimate (main) lines up
    with the worker's #909 preflight.

    ``readable`` is false when the number cannot be trusted as a size: a member's
    annex key carries no ``-s`` field, or the total is zero (no pointer at HEAD).
    An unreadable size used to read as 0 and so as free."""
    if is_dir_recording(primary_path):
        members: list[str] = [p for p in head_files if dir_recording_of(p) == primary_path]
    elif is_bti_dir(primary_path):
        # 4D/BTi: extension-less directory, so membership is exact-dirname
        # matching rather than `dir_recording_of`'s ancestor-component match.
        members = [p for p in head_files if os.path.dirname(p) == primary_path]
    else:
        d = os.path.dirname(primary_path)
        stem = filename_stem(primary_path)
        siblings = [
            p for p in head_files
            if os.path.dirname(p) == d and filename_stem(p) == stem
        ]
        members = list(
            dict.fromkeys([primary_path, *siblings, *split_members_for(primary_path, head_files)])
        )
    total = 0
    readable = True
    for path in members:
        key, blob_size = _blob_key_and_size(repo_dir, path, head)
        if key and annex_key_size(key) is None:
            readable = False
        total += (annex_key_size(key) or 0) if key else blob_size
    return total, readable and total > 0


def recording_size_from_pointers(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> int:
    """On-disk bytes of a recording's whole file set; see ``recording_size_info``."""
    return recording_size_info(repo_dir, primary_path, head_files, head)[0]


def download_blob(src: str, dst: str, expected_size: int | None) -> None:
    """Download an annex blob to ``dst`` robustly: a unique temp + atomic rename
    + size check against the key's declared size, retried with backoff.

    Large MEG/iEEG blobs (KIT ``.con`` ~1 GB, BrainVision ``.eeg`` >10 GB, split
    FIF >2 GB) intermittently arrive truncated under JOBS-way parallelism, which
    then surfaces downstream as ``not EDF compliant (Filesize)`` or a split chain
    that can't read its next file. A short/zero copy must never reach the reader:
    verify the byte count, and on any mismatch/transfer error drop the temp and
    retry rather than convert a corrupt file into a wrong store.

    A 404 is the one failure that is NOT retried: it raises `S3ObjectAbsent` on
    the first answer. S3 is strongly consistent, so asking again gets the same
    answer, and the caller has something better to do with it (look for a
    git-annex chunked copy, see `fetch_annex_object`). Everything else -- a
    throttle, a 5xx, a wedge past the timeout, a short copy -- is retried as
    before and ends in an uncoded RuntimeError, which the run treats as infra.
    """
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    last: Exception | None = None
    for attempt in range(1, _AWS_RETRIES + 1):
        tmp = f"{dst}.part.{os.getpid()}.{attempt}"
        try:
            # stderr is captured, not inherited, because it is how a 404 is told
            # apart from a transient failure; it is carried in the exception.
            res = subprocess.run(
                ["aws", "s3", "cp", src, tmp, "--only-show-errors", *_AWS_TIMEOUTS],
                capture_output=True,
                text=True,
                timeout=_AWS_OP_TIMEOUT,
                env=_aws_env(),
                check=False,  # the return code is inspected below
            )
            if res.returncode != 0:
                stderr = res.stderr.strip()
                if _s3_not_found(stderr):
                    raise S3ObjectAbsent(src, stderr)
                raise RuntimeError(f"aws s3 cp exited {res.returncode}: {stderr}")
            got = os.path.getsize(tmp)
            if expected_size is not None and got != expected_size:
                raise S3SizeMismatch(
                    f"truncated download: got {got} of {expected_size} bytes"
                )
            os.replace(tmp, dst)
            return
        except Exception as exc:  # any failure -> drop temp + retry (a 404 re-raises)
            last = exc
            with contextlib.suppress(OSError):
                if os.path.exists(tmp):
                    os.remove(tmp)
            if isinstance(exc, S3ObjectAbsent):
                raise
            if attempt < _AWS_RETRIES:
                time.sleep(min(2**attempt, 30))
    # Still a RuntimeError either way, so every caller that treats this as an
    # uncoded infra failure keeps doing so. The subclass only lets the chunk
    # fetch tell "the copy kept arriving at the wrong size" apart, see
    # `fetch_annex_object`.
    failed = S3SizeMismatch if isinstance(last, S3SizeMismatch) else RuntimeError
    raise failed(f"download {src} -> {dst} failed after {_AWS_RETRIES} attempts: {last}")


def _s3_not_found(stderr: str) -> bool:
    """Whether an `aws s3 cp` error says the object is absent, as opposed to any
    other failure: the CLI's ``An error occurred (404) when calling the
    HeadObject operation: Key "..." does not exist``, or ``NoSuchKey``.

    Deliberately narrower than `s3_read_json`'s bare ``"404"`` test. A transfer
    failure prints ``download failed: s3://.../<key> to ...``, and an annex key
    is a 64-digit hex hash plus a byte count: ``404`` turns up inside one often
    enough that the loose test would read a dropped connection as an absence.

    A 403 is deliberately NOT an absence. S3 answers a missing key with 403
    when the caller lacks s3:ListBucket, but also for expired credentials, a
    private object, or a signature without its session token
    (``.memory/s3-403-is-not-absence.md``). So a 403 is retried and ends
    uncoded, and the chunked fallback, which only a 404 unlocks, never runs."""
    err = stderr.lower()
    return "(404)" in err or "nosuchkey" in err


class S3SizeMismatch(RuntimeError):
    """`download_blob` copied the object, but not the byte count it expected, on
    its last attempt. Uncoded like any RuntimeError; a distinct class only so a
    chunk fetched under a CACHED chunk size can hand the question to the
    listing, which can tell a short transfer from a chunk stored at the wrong
    size."""


class S3ObjectAbsent(Exception):
    """`download_blob`'s source answered 404. Internal to the annex fetch: it is
    either answered by a chunked copy or turned into `AnnexObjectMissing`, and is
    never what a recording fails with. `chunk` names the chunk number when the
    absent object was one chunk of a chunked key."""

    def __init__(self, src: str, stderr: str, chunk: int | None = None) -> None:
        super().__init__(f"{src} does not exist ({stderr})" if stderr else f"{src} does not exist")
        self.src = src
        self.chunk = chunk


class AnnexObjectMissing(Exception):
    """The S3 bucket does not hold this annex key's content intact: no object at
    the plain key and no complete git-annex chunked copy (a chunk absent, or a
    chunk whose stored size is not the size its key implies).

    A property of what the archive holds, not of this run, so it is typed and
    NOT in `RETRYABLE_CODES`: the recording is refused (ADR 0005, the rest of the
    dataset still serves) instead of being retried as infra five times and then
    promoted to an unexplained `retry_exhausted`. Only a definite answer from S3
    reaches this class -- a 404, or a successful listing that lacks the chunk.
    A throttle, a 5xx, a timeout or a listing that errored stays an uncoded
    RuntimeError and is retried. Recovery once the content is uploaded is a
    requeue of the dataset.

    Permanent for the RECORDING, not for the dataset: it is in
    `STORAGE_STATE_CODES`, so a run in which every failure is this code does not
    make the dataset `deterministic` (see `dataset_failure_is_deterministic`).
    Every recording missing its object at once is what an upload still landing
    looks like, and the queue's bounded backoff is the right answer to that.

    `key` is carried separately from the message so the run can name the first
    missing object to the operator without parsing text."""

    code = "annex_object_missing"

    def __init__(self, key: str, problem: str) -> None:
        # Both in `args`, so the exception pickles and unpickles as itself.
        super().__init__(key, problem)
        self.key = key
        self.problem = problem

    def __str__(self) -> str:
        return f"{self.key}: {self.problem}"


# --- git-annex chunked storage ---------------------------------------------
#
# A special remote configured with `chunk=<size>` never stores the key a
# pointer names. The content of `SHA256E-s<size>--<hash>.<ext>` is stored as
# `SHA256E-s<size>-S<chunksize>-C<n>--<hash>.<ext>` for n = 1..ceil(size /
# chunksize), every chunk `chunksize` bytes except the last (nm000276 was
# uploaded this way with 1 GiB chunks, so even a 982-byte `.vhdr` exists only as
# `...-S1073741824-C1--...`). The chunk size is not in the pointer, so it is
# discovered by listing `objects/<fields>-S` once and then cached per dataset:
# a dataset is uploaded with one chunk configuration, and a key that does not
# match the cached size falls back to its own listing.
_ANNEX_CHUNK_SIZE: dict[tuple[str, str], int] = {}
# Bounded copy buffer for appending a downloaded chunk to the assembled file.
_CHUNK_COPY_BUFFER = 8 * 1024 * 1024


def annex_chunk_sizes(size: int, chunk_size: int) -> list[int]:
    """Byte size of each chunk, in order, of a `size`-byte key stored in
    `chunk_size` chunks. An empty key is one empty chunk."""
    if chunk_size <= 0:
        raise ValueError(f"chunk size must be positive, got {chunk_size}")
    n = max(1, -(-size // chunk_size))
    return [chunk_size] * (n - 1) + [size - chunk_size * (n - 1)]


def annex_chunk_key(key: str, chunk_size: int, number: int) -> str:
    """The object name git-annex stores chunk `number` of `key` under."""
    fields, sep, name = key.partition("--")
    if not sep:
        raise ValueError(f"not a git-annex key: {key!r}")
    return f"{fields}-S{chunk_size}-C{number}--{name}"


def _list_annex_chunks(bucket: str, dataset_id: str, key: str) -> dict[int, dict[int, int]]:
    """Every chunked copy of `key` in the bucket, as ``{chunk_size: {chunk_number:
    stored_bytes}}``; ``{}`` when there is none.

    One LIST of ``<id>/objects/<fields>-S``: it can also return chunks of other
    keys with the same backend and size, which the exact-name match drops. A
    failed listing RAISES (after retries) rather than returning ``{}``: an
    empty answer means "not stored", and an error is not that answer."""
    fields, _, name = key.partition("--")
    prefix = f"{dataset_id}/objects/{fields}-S"
    pattern = re.compile(
        rf"{re.escape(prefix)}(\d+)-C(\d+)--{re.escape(name)}"
    )
    last = ""
    for attempt in range(1, _AWS_RETRIES + 1):
        try:
            res = subprocess.run(
                [
                    "aws", "s3api", "list-objects-v2", "--bucket", bucket,
                    "--prefix", prefix,
                    "--query", "Contents[].[Key,Size]", "--output", "json",
                    *_AWS_TIMEOUTS,
                ],
                capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
                check=False,  # the return code is inspected below
            )
        except subprocess.TimeoutExpired as exc:
            last = str(exc)
        else:
            if res.returncode == 0:
                rows = json.loads(res.stdout or "null") or []
                found: dict[int, dict[int, int]] = {}
                for obj_key, obj_size in rows:
                    m = pattern.fullmatch(obj_key)
                    if m:
                        found.setdefault(int(m[1]), {})[int(m[2])] = int(obj_size)
                return found
            last = f"exited {res.returncode}: {res.stderr.strip()}"
        if attempt < _AWS_RETRIES:
            time.sleep(min(2**attempt, 30))
    raise RuntimeError(
        f"listing chunked copies of {key} under s3://{bucket}/{prefix} failed after "
        f"{_AWS_RETRIES} attempts: {last}"
    )


def _complete_chunk_size(
    variants: dict[int, dict[int, int]], size: int, prefer: int | None
) -> tuple[int | None, str]:
    """The chunk size whose chunks are all present at their expected sizes, and
    otherwise ``None`` with what is wrong, for the error. ``prefer`` (the cached
    size) is tried first; the rest in ascending order."""
    if not variants:
        return None, "no object at the plain key and no chunked copy"
    problems = []
    order = sorted(variants, key=lambda s: (s != prefer, s))
    for chunk_size in order:
        stored = variants[chunk_size]
        for number, want in enumerate(annex_chunk_sizes(size, chunk_size), start=1):
            got = stored.get(number)
            if got is None:
                problems.append(f"chunk C{number} of the {chunk_size}-byte chunking is absent")
                break
            if got != want:
                problems.append(
                    f"chunk C{number} of the {chunk_size}-byte chunking is {got} bytes, "
                    f"expected {want}"
                )
                break
        else:
            return chunk_size, ""
    return None, "; ".join(problems)


def _download_chunks(base: str, key: str, size: int, chunk_size: int, dst: str) -> None:
    """Download every chunk of `key` in order and append each to `dst`.

    Each chunk goes through `download_blob`, so it keeps that function's
    timeout, retry and per-chunk size check. Memory stays bounded (one copy
    buffer); scratch peaks at the whole file plus one chunk, the moment the
    last chunk has landed and is being appended. `dst` appears only complete
    (atomic rename after the total is checked); on any failure nothing is left
    behind. A 404 raises `S3ObjectAbsent` with `chunk` set to the absent
    chunk's number.

    There is NO resume, deliberately for now. The chunks are fetched one after
    another, one `aws s3 cp` each, and a failure discards the assembly: a
    100 GB file in 1 GiB chunks is ~94 sequential copies, ~17 minutes at
    100 MB/s, and one that fails for good at chunk 90 (after `download_blob`'s
    own retries) is fetched again from chunk 1 on the next attempt. The
    `_AWS_OP_TIMEOUT` cap (1800 s by default) applies to each chunk's copy, not
    to the file, so a slow but healthy transfer of a large file is not cut off."""
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    assembly = f"{dst}.chunked.{os.getpid()}"
    piece = f"{dst}.chunk.{os.getpid()}"
    try:
        with open(assembly, "wb") as out:
            for number, want in enumerate(annex_chunk_sizes(size, chunk_size), start=1):
                try:
                    download_blob(base + annex_chunk_key(key, chunk_size, number), piece, want)
                except S3ObjectAbsent as exc:
                    exc.chunk = number
                    raise
                with open(piece, "rb") as fh:
                    shutil.copyfileobj(fh, out, _CHUNK_COPY_BUFFER)
                os.remove(piece)
        got = os.path.getsize(assembly)
        if got != size:
            # Unreachable by construction: every chunk was size-checked against
            # `annex_chunk_sizes`, which sums to `size`. Reaching it is a bug in
            # THIS code, not a fact about the bucket, so it must not carry the
            # permanent `annex_object_missing` verdict: uncoded, it stays infra.
            raise RuntimeError(
                f"{key}: its {chunk_size}-byte chunks reassembled to {got} bytes, the "
                f"key declares {size} (internal error: each chunk passed its size check)"
            )
        os.replace(assembly, dst)
    finally:
        for path in (piece, assembly):
            with contextlib.suppress(OSError):
                if os.path.exists(path):
                    os.remove(path)


def fetch_annex_object(bucket: str, dataset_id: str, key: str, dst: str) -> None:
    """Download annex `key` of `dataset_id` to `dst`, plain or chunked.

    The plain object ``s3://<bucket>/<id>/objects/<key>`` is tried first, so a
    dataset stored without chunking costs exactly what it did before: one
    request. Only when that answers 404 is a chunked copy looked for: with the
    dataset's cached chunk size directly, otherwise (or when chunk 1 is not
    there under the cached size, or a chunk keeps arriving at the wrong size)
    through one listing, whose answer is cached.

    Raises `AnnexObjectMissing` (typed, not retried) when the bucket definitely
    holds no complete copy; any other failure propagates as-is."""
    base = f"s3://{bucket}/{dataset_id}/objects/"
    size = annex_key_size(key)
    try:
        download_blob(base + key, dst, size)
        return
    except S3ObjectAbsent as exc:
        if size is None or "--" not in key:
            # Without a declared size the chunk names cannot be derived, so the
            # plain object was the only place this content could be.
            raise AnnexObjectMissing(key, f"no object at the plain key ({exc})") from exc
    cache = (bucket, dataset_id)
    cached = _ANNEX_CHUNK_SIZE.get(cache)
    if cached is not None:
        try:
            _download_chunks(base, key, size, cached, dst)
            return
        except S3ObjectAbsent as exc:
            if exc.chunk != 1:
                raise AnnexObjectMissing(
                    key, f"chunk C{exc.chunk} of its {cached}-byte chunking is absent"
                ) from exc
            # Not stored under the cached size at all: this key may have been
            # uploaded with another chunking. Its own listing decides.
        except S3SizeMismatch:
            # A chunk kept arriving at the wrong size. Uncoded, that would be
            # retried as infra on every run for a chunk that is simply stored
            # wrong; the listing reports each chunk's STORED size, so it types a
            # stored-wrong chunk as `annex_object_missing`, and a transfer that
            # was merely short is fetched again below.
            pass
    chunk_size, problem = _complete_chunk_size(
        _list_annex_chunks(bucket, dataset_id, key), size, cached
    )
    if chunk_size is None:
        raise AnnexObjectMissing(key, problem)
    _ANNEX_CHUNK_SIZE[cache] = chunk_size
    try:
        _download_chunks(base, key, size, chunk_size, dst)
    except S3ObjectAbsent as exc:
        # Listed a moment ago and gone now: a deletion, which is still an answer.
        raise AnnexObjectMissing(
            key, f"chunk C{exc.chunk} of its {chunk_size}-byte chunking is absent"
        ) from exc


def s3_read_json(bucket: str, key: str) -> dict | None:
    """Read a JSON object from S3.

    Returns None ONLY for a genuine 404 (NoSuchKey) -- the legitimate first-run
    case. Any other non-zero exit (credentials, network, wrong bucket) RAISES:
    silently treating it as "no prior index" would send the run full AND drop
    every prior store from the rewritten index. A corrupt body raises for the
    same reason (absent != corrupt).
    """
    res = subprocess.run(
        ["aws", "s3", "cp", f"s3://{bucket}/{key}", "-", *_AWS_TIMEOUTS],
        capture_output=True,
        text=True,
        timeout=_AWS_OP_TIMEOUT,
        env=_aws_env(),
    )
    if res.returncode != 0:
        err = res.stderr.lower()
        if "nosuchkey" in err or "404" in err or "not found" in err:
            return None
        raise RuntimeError(
            f"s3_read_json: aws s3 cp s3://{bucket}/{key} exited {res.returncode}: "
            f"{res.stderr.strip()}"
        )
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"corrupt JSON at s3://{bucket}/{key}: {exc}") from exc


class IndexPreconditionFailed(Exception):
    """The live `index.json` changed between the read a rewrite was computed from
    and the write. The write is REFUSED rather than forced: the other writer
    published a whole document, and replaying a merge computed from the old one
    would silently roll it back.
    """


def read_index_with_etag(bucket: str, dataset_id: str) -> tuple[dict | None, str | None]:
    """`(index, etag)` for a dataset's live `index.json`, or `(None, None)` when
    there is none.

    One `get-object` call for both, on purpose: the ETag has to be the one the
    body that produced this merge actually had, and a separate `head-object`
    could observe a different version. Raises for any failure that is not a
    genuine absence -- the same rule `s3_read_json` follows, for the same reason
    (treating a credentials or network error as "no index" would rewrite the
    document from nothing).

    Shared with `purge_non_raw_stores.py`, which imports it: both writers of this
    one object have to agree on how the ETag is read and sent back, or the
    conditional write protecting them from each other is decorative.
    """
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as fh:
        tmp_path = fh.name
    try:
        res = subprocess.run(
            [
                "aws", "s3api", "get-object", "--bucket", bucket,
                "--key", f"{dataset_id}/zarr/index.json", tmp_path,
                "--query", "ETag", "--output", "text", *_AWS_TIMEOUTS,
            ],
            capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
            check=False,  # the return code IS the answer: absent vs failed
        )
        if res.returncode != 0:
            err = res.stderr.lower()
            if "nosuchkey" in err or "404" in err or "not found" in err:
                return None, None
            raise RuntimeError(
                f"read_index_with_etag: aws s3api get-object exited "
                f"{res.returncode}: {res.stderr.strip()}"
            )
        with open(tmp_path, encoding="utf-8") as fh:
            index = json.load(fh)
        # `--output text` prints the quoted ETag; S3 wants it back verbatim on
        # `--if-match`, so only the surrounding whitespace is stripped.
        return index, res.stdout.strip()
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)


def write_index(bucket: str, dataset_id: str, index: dict, *, if_match: str | None) -> str | None:
    """Write `index.json` to S3 CONDITIONALLY. Returns the new object's ETag as
    the PUT reports it (quoted, as S3 spells it), or None when the response
    carried none.

    `index.json`'s destination is a single S3 object, so a single PUT is already
    atomic there: a reader sees the previous full body or the new full body,
    never a partial one. Atomic is not the same as safe, though, and that is what
    `if_match` is for. Two processes write this document -- a converter run
    (`generate_zarr.main`) and the non-raw purge (`purge_non_raw_stores.py`) --
    and both read it, work for minutes to hours, then write it back. An
    unconditional PUT from either silently reverts whatever the other published
    in that window, taking every store it added (or every store it deleted) with
    it. So the write carries `--if-match` with the ETag the document was computed
    from and S3 refuses it (412) if anything else has written since.

    `if_match=None` is not "skip the check" -- there is no such mode. It means
    the object did not exist at read time, and the write is then conditional on
    it still not existing (`--if-none-match "*"`), so a first index published in
    the meantime is not clobbered either.

    Single attempt, deliberately: `_aws`'s retry loop would re-send a conditional
    PUT whose first attempt may in fact have succeeded, turning a lost response
    into a phantom conflict. The CALLER decides what a conflict means -- the
    purge abandons its rewrite, the converter re-reads and re-merges once.
    """
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(index, fh, separators=(",", ":"))
        tmp_path = fh.name
    condition = ["--if-match", if_match] if if_match else ["--if-none-match", "*"]
    try:
        res = subprocess.run(
            [
                "aws", "s3api", "put-object", "--bucket", bucket,
                "--key", f"{dataset_id}/zarr/index.json", "--body", tmp_path,
                "--content-type", "application/json",
                "--cache-control", "public, max-age=60",
                *condition, *_AWS_TIMEOUTS,
            ],
            capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
            check=False,  # a 412 is a verdict to report, not an exception to raise
        )
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
    if res.returncode == 0:
        # The PUT's own response names the version THIS call wrote. A follow-up
        # `head-object` would not: it can observe a newer writer's document,
        # which is precisely the race the conditional write exists to expose.
        try:
            etag = json.loads(res.stdout or "{}").get("ETag")
        except json.JSONDecodeError:
            etag = None
        return etag if isinstance(etag, str) else None
    err = res.stderr.lower()
    if "preconditionfailed" in err or "412" in err or "conditionalrequestconflict" in err:
        raise IndexPreconditionFailed(
            f"index.json for {dataset_id} changed between this run's read and its "
            f"write (if-match {if_match or '<absent>'}); the write was NOT applied "
            "and the newer document is untouched"
        )
    raise RuntimeError(
        f"write_index: aws s3api put-object exited {res.returncode}: {res.stderr.strip()}"
    )


def s3_download_file(bucket: str, key: str, dest: str) -> bool:
    """Download an S3 object to `dest`. False for a genuine 404, True on success.

    Same rule as `s3_read_json`, for the same reason: "the object is not there"
    is a legitimate first-run answer, and every OTHER failure (credentials,
    network, wrong bucket) raises rather than being flattened into it. The caller
    of this one carries rows forward from the object, so a swallowed error would
    silently republish a file with those rows missing.
    """
    res = subprocess.run(
        ["aws", "s3", "cp", f"s3://{bucket}/{key}", dest, "--only-show-errors", *_AWS_TIMEOUTS],
        capture_output=True,
        text=True,
        timeout=_AWS_OP_TIMEOUT,
        env=_aws_env(),
    )
    if res.returncode == 0:
        return True
    err = res.stderr.lower()
    if "nosuchkey" in err or "404" in err or "not found" in err:
        return False
    raise RuntimeError(
        f"s3_download_file: aws s3 cp s3://{bucket}/{key} exited {res.returncode}: "
        f"{res.stderr.strip()}"
    )


class ManifestFileEntry(TypedDict):
    """One entry of the manifest's `files[]`: a dataset-level object this run
    published beside index.json, with the size it wrote.

    Mirrors `zarr-manifest.schema.json`'s `files[]` items exactly, including the
    single-member `name` enum -- index.json and manifest.json describe
    themselves, so the events file is the only object that needs describing
    (#1060). Named as a type because both readers of it index it by key
    (`merge_manifest` embeds the whole entry; `main` reads `row_count` onto the
    index and the callback), and a bare `dict` let a renamed key typecheck
    everywhere and fail schema validation at the end of a conversion instead.
    """

    name: str
    size_bytes: int
    row_count: int


class EventsPublication(TypedDict):
    """What a run did about `<id>/zarr/events.parquet`.

    `file` is None whenever nothing was published, and the index must then point
    at nothing. `failed` separates the reason: "this dataset has no events" and
    "we could not say what its events are" must not look the same from outside.
    """

    file: ManifestFileEntry | None
    failed: bool


def publish_events_parquet(
    staged: EventsStaging,
    ordered_rels: list[str],
    *,
    bucket: str,
    dataset_id: str,
    reconverted: set[str],
) -> EventsPublication:
    """Build and upload `<id>/zarr/events.parquet`.

    Publishes nothing when the dataset has no events at all, `pyarrow` is
    missing, or this run could not write/upload the file -- the last of which
    sets `failed` and is reported on the callback.

    `reconverted` is every store this run rebuilt, INCLUDING the ones that
    produced no rows, and it is the thing "carried over" is defined against.
    Defining it against the staged rows instead is wrong twice over: a
    reconverted store whose events.tsv was deleted would keep republishing its
    old rows from the prior file forever, and on a first `--clean` run every
    event-less store would be reported as an unrecoverable carry-over it is not.

    Best-effort throughout, exactly like manifest.json: the stores and index.json
    are the serving copy, and ADR 0005 says partial data still serves. A failure
    here leaves the PREVIOUS file in place on S3, unreferenced by the new index
    until a later run republishes it.
    """
    carried = [rel for rel in ordered_rels if rel not in reconverted]
    if not staged.row_count and not carried:
        return {"file": None, "failed": False}
    try:
        import pyarrow  # type: ignore[import-not-found]  # noqa: F401 - probe only
    except ImportError:
        print(
            "::warning::pyarrow is not installed; "
            f"{dataset_id}/zarr/events.parquet was NOT written and the index will "
            "not advertise one (add it: scripts/zarr/requirements.txt)",
            flush=True,
        )
        return {"file": None, "failed": False}

    prior: PriorEventRows | None = None
    prior_local: str | None = None
    local: str | None = None
    try:
        if carried:
            # An INCREMENTAL run carries the rows of every untouched store. A
            # `--clean` run (the Hallu path) rebuilds every store, so it reaches
            # this only when a deferred store was kept, and then carries just
            # that store's rows.
            with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as fh:
                prior_local = fh.name
            if s3_download_file(bucket, f"{dataset_id}/zarr/{EVENTS_PARQUET_NAME}", prior_local):
                prior = PriorEventRows(prior_local)
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as fh:
            local = fh.name
        rows = write_events_parquet(local, ordered_rels, staged, prior, reconverted)
        if not rows:
            # Every store's events.tsv was absent or empty. Publishing an empty
            # file would tell a client "no events" no more clearly than the
            # absent `events_parquet` field does, and costs a fetch to learn it.
            return {"file": None, "failed": False}
        aws_cp(
            local,
            f"s3://{bucket}/{dataset_id}/zarr/{EVENTS_PARQUET_NAME}",
            extra=["--content-type", EVENTS_CONTENT_TYPE,
                   "--cache-control", "public, max-age=60"],
        )
        missing = [rel for rel in carried if prior is None or rel not in prior]
        if missing:
            # Stores this run did NOT reconvert whose rows are in no prior file
            # either: the first incremental run after this shipped, or a prior
            # file that predates them. Their events are simply absent from the
            # file until the store is reconverted, and a client joining on
            # `store_path` cannot tell that from "this recording has no
            # events.tsv" -- so say it here, where an operator can see how many
            # and re-run with --clean. A store this run DID reconvert is never
            # in this list, however few rows it produced: nothing is missing
            # about a store whose events were just re-read.
            print(
                f"::warning::{len(missing)} carried-over store(s) contribute no rows "
                f"to {dataset_id}/zarr/events.parquet (no prior rows to carry); "
                "a --clean run rebuilds them",
                flush=True,
            )
        return {
            "file": {
                "name": EVENTS_PARQUET_NAME,
                "size_bytes": os.path.getsize(local),
                "row_count": rows,
            },
            "failed": False,
        }
    except Exception as exc:  # noqa: BLE001 - never fail a good conversion over this
        print(
            f"::warning::{dataset_id}/zarr/{EVENTS_PARQUET_NAME} was not published: "
            f"{redact_secrets(str(exc))}",
            flush=True,
        )
        return {"file": None, "failed": True}
    finally:
        for path in (local, prior_local):
            if path:
                with contextlib.suppress(OSError):
                    os.unlink(path)


def _fetch_blob(
    repo_dir: str, bucket: str, dataset_id: str, path: str, head: str, local: str
) -> tuple[bool, str | None]:
    """Materialize one tracked path to `local`. Returns (found, annex_key).

    Annex content (locked symlink or unlocked pointer) is pulled from S3 with
    authenticated `aws s3 cp`; an in-git blob is written directly. `found=False`
    when the path is absent from `ls-tree head` (caller decides if that is fatal).
    Reads against the pinned `head` SHA so it matches the worklist's tree.
    """
    meta = _run(["git", "-C", repo_dir, "ls-tree", head, "--", path]).strip()
    if not meta:
        return False, None
    mode, _, rest = meta.split(" ", 2)
    sha = rest.split("\t", 1)[0].strip()
    blob = subprocess.check_output(["git", "-C", repo_dir, "cat-file", "blob", sha])
    key = None
    if mode == "120000" or len(blob) < 1024:
        key = parse_annex_key(blob.decode("utf-8", "replace"))
    os.makedirs(os.path.dirname(local) or ".", exist_ok=True)
    if key:
        fetch_annex_object(bucket, dataset_id, key, local)
    else:
        with open(local, "wb") as fh:
            fh.write(blob)
    return True, key


def _materialize_dir_members(
    repo_dir: str,
    bucket: str,
    dataset_id: str,
    dir_path: str,
    inner: list[str],
    head_files: set[str],
    head: str,
    work_dir: str,
    kind: str,
) -> tuple[str, str | None, str | None]:
    """Shared download step for a directory-keyed recording (CTF `.ds`, MEF3
    `.mefd`, or 4D/BTi): materialize the already-resolved `inner` member paths
    into `work_dir`, preserving the directory's internal layout the reader
    expects, plus the BIDS events sidecar if present. `kind` (e.g. ``"CTF"``,
    ``"MEF3"``, ``"4D/BTi"``) only flavors error/warning text -- the download
    logic itself is identical for all three, which is the point of factoring it
    out rather than repeating it per format. Returns (local_dir, events_local|
    None, None) -- a directory recording carries no single git-annex key of its
    own (see `materialize_recording`).
    """
    local_dir = os.path.join(work_dir, os.path.basename(dir_path))
    if not inner:
        raise RuntimeError(f"{kind} recording {dir_path!r} has no files at ls-tree {head[:8]}")
    for path in inner:
        rel = path[len(dir_path) + 1 :]  # path relative to the recording dir
        found, _ = _fetch_blob(repo_dir, bucket, dataset_id, path, head, os.path.join(local_dir, rel))
        if not found:
            # Every inner file came from `ls-tree head`; a missing one means a real
            # tree/pack desync. The recording is read as a whole, and we cannot tell
            # a mandatory file from an optional sidecar, so FAIL rather than convert
            # a partial recording into a wrong store that would then
            # `aws s3 sync --delete` over a good one.
            raise RuntimeError(
                f"{kind} file {path!r} absent from ls-tree {head[:8]}; refusing to convert a "
                "partial recording"
            )
    events_path = events_sibling_for(dir_path)
    events_local = None
    if events_path in head_files:
        events_local = os.path.join(work_dir, os.path.basename(events_path))
        found, _ = _fetch_blob(repo_dir, bucket, dataset_id, events_path, head, events_local)
        if not found:
            # Sidecar tracked at HEAD but unfetchable -> don't claim a phantom path
            # (downstream would silently embed no events); warn and drop it.
            print(f"::warning::{kind} events {events_path!r} absent from ls-tree {head[:8]}; skipping", flush=True)
            events_local = None
    return local_dir, events_local, None


def _materialize_dir_recording(
    repo_dir: str,
    bucket: str,
    dataset_id: str,
    dir_path: str,
    head_files: set[str],
    head: str,
    work_dir: str,
) -> tuple[str, str | None, str | None]:
    """Download every file under a CTF `.ds` or MEF3 `.mefd` recording directory
    (extension-derived membership; see `dir_recording_of`)."""
    inner = sorted(p for p in head_files if dir_recording_of(p) == dir_path)
    kind = "MEF3" if is_mefd(dir_path) else "CTF"
    return _materialize_dir_members(
        repo_dir, bucket, dataset_id, dir_path, inner, head_files, head, work_dir, kind
    )


def _materialize_bti(
    repo_dir: str,
    bucket: str,
    dataset_id: str,
    bti_dir: str,
    head_files: set[str],
    head: str,
    work_dir: str,
) -> tuple[str, str | None, str | None]:
    """Download every file directly inside a 4D/BTi recording directory (see
    `bti_recordings`). BIDS gives it no extension, so unlike `.ds`/`.mefd` its
    members are exact-dirname matches rather than ancestor-derived."""
    inner = sorted(p for p in head_files if os.path.dirname(p) == bti_dir)
    # Name, in this converter's own log, the same file biosigIO's `_find_bti_pdf`
    # is expected to choose (see `bti_pdf_choice`) whenever the choice is
    # ambiguous -- so an operator reading THIS converter's output can already see
    # which processed-data file will end up in the store, without cross-
    # referencing biosigIO's separate warning.
    chosen, ambiguous = bti_pdf_choice({os.path.basename(p) for p in inner})
    if chosen and ambiguous:
        print(
            f"::warning::4D/BTi {bti_dir!r} has multiple processed-data candidates; "
            f"biosigio is expected to read {chosen!r}",
            flush=True,
        )
    return _materialize_dir_members(
        repo_dir, bucket, dataset_id, bti_dir, inner, head_files, head, work_dir, "4D/BTi"
    )


def materialize_recording(
    repo_dir: str,
    bucket: str,
    dataset_id: str,
    primary_path: str,
    head_files: set[str],
    head: str,
    work_dir: str,
) -> tuple[str, str | None, str | None]:
    """Reconstruct a recording's file set into `work_dir`.

    Downloads the primary + every same-stem companion (annex content via
    authenticated `aws s3 cp`, in-git blobs written directly) and the BIDS
    `_events.tsv` sidecar if present. A directory recording (CTF `.ds`/MEF3
    `.mefd`/4D-BTi) is handled by `_materialize_dir_recording`/`_materialize_bti`
    instead. Returns (primary_local_path, events_local_path|None,
    primary_annex_key|None).
    """
    if is_dir_recording(primary_path):
        return _materialize_dir_recording(repo_dir, bucket, dataset_id, primary_path, head_files, head, work_dir)
    if is_bti_dir(primary_path):
        return _materialize_bti(repo_dir, bucket, dataset_id, primary_path, head_files, head, work_dir)

    d = os.path.dirname(primary_path)
    stem = filename_stem(primary_path)
    siblings = [
        p
        for p in head_files
        if os.path.dirname(p) == d and filename_stem(p) == stem
    ]
    # For a split FIF, pull every split in the group (read_raw_fif(split-01) follows
    # the chain on disk; without split-02.. present the head read raises). Their
    # basenames are distinct, so they land beside the head under their BIDS names
    # and MNE resolves the chain. [] for non-split recordings.
    split_members = split_members_for(primary_path, head_files)
    events_path = events_sibling_for(primary_path)
    wanted = list(dict.fromkeys([primary_path, *siblings, *split_members]))
    if events_path in head_files:
        wanted.append(events_path)

    primary_key: str | None = None
    events_fetched = False
    for path in wanted:
        local = os.path.join(work_dir, os.path.basename(path))
        found, key = _fetch_blob(repo_dir, bucket, dataset_id, path, head, local)
        if not found:
            if path == primary_path:
                raise RuntimeError(
                    f"primary {path!r} in the worklist but absent from ls-tree {head[:8]} "
                    "(possible pack corruption or path-encoding issue)"
                )
            if path == events_path:
                # events_path only reaches `wanted` when it IS in head_files, so
                # "not found" here is a tree/pack desync rather than the ordinary
                # "this recording has no events.tsv". Say so distinctly: the
                # generic companion line below reads identically to the benign
                # case and would hide a real repository problem.
                print(
                    f"::warning::events sidecar {path!r} is tracked at {head[:8]} but "
                    "could not be fetched; converting WITHOUT behavioral annotations",
                    flush=True,
                )
            else:
                print(
                    f"::warning::companion {path!r} absent from ls-tree {head[:8]}; skipping",
                    flush=True,
                )
            continue
        if path == primary_path:
            primary_key = key
        if path == events_path:
            events_fetched = True
    return (
        os.path.join(work_dir, os.path.basename(primary_path)),
        # Derived from the fetch actually succeeding, not from tree membership.
        # `_materialize_dir_members` already does it this way; this returned a
        # path to a file it had not written whenever the events fetch failed.
        # Every caller happens to guard with os.path.exists, so nothing is
        # mis-served today -- but the value was a claim this function could not
        # back, and one unguarded caller away from being a real bug.
        os.path.join(work_dir, os.path.basename(events_path)) if events_fetched else None,
        primary_key,
    )


def store_metadata(store_path: str) -> dict:
    """Read the small per-store summary the viewer/index needs from the written
    store's attrs (biosigIO contract: root `channel_groups`, group `rate`/
    `n_channels`/`n_samples`/`modality`). Best-effort: returns {} on any error.
    """
    try:
        import zarr  # type: ignore

        root = zarr.open_group(store_path, mode="r")
        ra = dict(root.attrs)
        groups = []
        modalities: set[str] = set()
        # Every channel's label in store order, across groups. A LIST, never a
        # set or a dict key: the point of reading it is to see each channel,
        # and a repeated label must not collapse here the way it once did in
        # the importer.
        labels: list[str] = []
        for gname in ra.get("channel_groups", []):
            ga = dict(root[gname].attrs)
            channels = ga.get("channels")
            if isinstance(channels, list):
                labels.extend(
                    str(ch.get("label", "")) for ch in channels if isinstance(ch, dict)
                )
            rate = ga.get("rate")
            nsamp = ga.get("n_samples")
            mod = ga.get("modality")
            if mod:
                modalities.add(str(mod).lower())
            group = {
                "name": gname,
                "modality": mod,
                "rate": rate,
                "n_channels": ga.get("n_channels"),
                "n_samples": nsamp,
                "duration_s": (nsamp / rate) if rate and nsamp else None,
            }
            # Serving GEOMETRY, republished from the store's own attrs
            # (biosigio>=1.2.6, biosigio#126). A reader that has the index has
            # then already paid for the store's shape: `n_view_levels` removes
            # the probe-until-404 walk over view/1..N, and `view_chunk_columns`
            # says how many requests a viewport-sized read costs at any level
            # (#1178 items 1-2). `source_rate_hz` is the ACQUISITION rate, the
            # thing `rate` above is not -- `rate` is the NEMAR modality cap.
            # Copied only when present, so an older store simply omits them.
            for key in ("n_view_levels", "view_chunk_columns"):
                if key in ga:
                    group[key] = ga[key]
            try:
                la = dict(root[gname]["0"].attrs)
            except Exception:  # noqa: BLE001 - level 0 absent/unreadable: omit
                la = {}
            for key in ("source_rate_hz", "chunk_samples", "shard_samples"):
                if key in la:
                    group[key] = la[key]
            groups.append(group)
        # Count event descriptions when the events group exists and carries them.
        event_description_count: int | None = None
        if "events" in root:
            vd = dict(root["events"].attrs).get("value_descriptions")
            if isinstance(vd, dict):
                event_description_count = len(vd)
        result: dict = {
            "modalities": sorted(modalities),
            "groups": groups,
            "power_line_frequency": ra.get("power_line_frequency"),
        }
        if event_description_count is not None:
            result["event_description_count"] = event_description_count
        # biosigIO's own account of what the BIDS channels.tsv `units` column did
        # (biosigio#125), which it records in the recording metadata and `to_zarr`
        # serializes into the store root. Republished so a unit that could NOT be
        # adopted is visible on the PUBLIC surface: a store whose report says
        # `kept_importer_unit` is serving numbers the sidecar disagrees with, and
        # before this that was only discoverable by reading the conversion log.
        # Absence means "no channels.tsv applied to this recording" -- either the
        # dataset ships none that inherits to it, or the read failed and the
        # driver said so. It never means "applied cleanly".
        #
        # Two locations, on purpose. The in-memory path records it in the
        # recording metadata, which `to_zarr` serializes into
        # `recording_metadata`; the streaming exporter never builds a Recording,
        # so biosigio#128 writes it as a ROOT attr instead. Root wins when both
        # exist -- it is the exporter-level statement, made after any importer's.
        rec_meta = ra.get("recording_metadata")
        for candidate in (
            ra.get("channels_tsv_units"),
            rec_meta.get("channels_tsv_units") if isinstance(rec_meta, dict) else None,
        ):
            if isinstance(candidate, dict):
                # Republished bounded: biosigIO's per-channel case-match map
                # becomes a count and a few examples (`bound_units_report`).
                # The full map rides along as a diagnostic for the join report.
                result["units_report"], result["_case_matches"] = bound_units_report(candidate)
                break
        # Diagnostics for the sidecar join (`sidecar_join_report`), `_`-prefixed
        # so they never reach the published entry. `channel_labels_deduplicated`
        # is biosigIO's (>= 1.2.9) record of the labels it renamed because the
        # file repeated them, `{new_label: file_label}`.
        result["_channel_labels"] = labels
        result["_label_renames"] = label_renames(ra)
        return result
    except Exception as exc:  # noqa: BLE001 - best-effort metadata, never fatal
        print(f"::warning::store_metadata failed for {store_path}: {exc}", flush=True)
        # Carry the cause so the caller's error names it, instead of the two
        # halves only being reconstructable by grepping the log for timestamps.
        # Keyed `_error` and stripped before the entry is built: `meta` is spread
        # into the PUBLISHED index, and diagnostic state must not ride along.
        return {"_error": str(exc)}


def materialize_local(
    repo_dir: str, primary_path: str, head_files: set[str]
) -> tuple[str, str | None, str | None]:
    """Local-mode materialization (e.g. Hallu after `nemar dataset download`).

    The dataset working tree already holds the annex content (the data files are
    symlinks resolving to local annex objects), so biosigIO reads the
    working-tree paths directly and companions resolve beside the primary --
    no S3 download. Returns (primary_local, events_local|None, annex_key|None);
    the key is read from the symlink target for index provenance, best-effort.
    """
    primary_local = os.path.join(repo_dir, primary_path)
    events_rel = events_sibling_for(primary_path)
    events_local = os.path.join(repo_dir, events_rel) if events_rel in head_files else None
    primary_key: str | None = None
    try:
        if os.path.islink(primary_local):
            primary_key = parse_annex_key(os.readlink(primary_local))
    except OSError:
        primary_key = None
    return primary_local, events_local, primary_key


# --- Declared EEGLAB `.fdt` locations (per dataset, reviewed) -----------------
#
# An EEGLAB `.set` whose samples live in a separate `.fdt` is read from the
# `.fdt` BESIDE it. A few datasets ship the `.fdt` elsewhere (on004306 keeps
# them under `derivatives/fdt_files/`, under names that do not match the `.set`
# or even each other), so the reader fails with "EEGLAB data is in a separate
# .fdt file but none was found". Discovery stays raw-only (ADR 0027): the `.set`
# is the recording, and the `.fdt` is only fetched because a person paired it
# with that `.set` in `eeglab-fdt-declarations.json` and recorded the evidence.
#
# Nothing here pairs files by name. A declaration is checked against the `.set`
# header (channels x samples x trials), against the target's byte size, and
# against the reviewed content (its git-annex key, or the SHA-256 of its bytes
# when it has no key), and any disagreement REFUSES the recording with a typed code rather than serving a
# signal read from the wrong file. Datasets and recordings the file does not name
# are untouched.
FDT_DECLARATIONS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "eeglab-fdt-declarations.json"
)
_FDT_DATASET_ID_RE = re.compile(r"[a-z]{2}\d{6}")
_FDT_DATASET_KEYS = frozenset({"reviewed", "note", "recordings"})
_FDT_RECORDING_KEYS = frozenset(
    {"fdt", "nbchan", "pnts", "trials", "fdt_bytes", "annex_key", "evidence"}
)
# The content pin: a git-annex SHA-256 key, whose size field and hash are both
# checked at conversion (an in-git `.fdt` is hashed against the same key).
_FDT_ANNEX_KEY_RE = re.compile(r"SHA256E?-s(\d+)--([0-9a-f]{64})(?:\.[A-Za-z0-9]+)*")


def _sha256_file(path: str) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class FdtDeclarationRefused(Exception):
    """A declared `.fdt` for an EEGLAB `.set` failed verification: absent at HEAD,
    contradicted by (or unreadable in) the `.set` header, the wrong size, or not
    the reviewed content. A property of the
    dataset plus its declaration, so NOT retryable; the fix is a reviewed edit to
    `eeglab-fdt-declarations.json`, never a guess at another file."""

    code = "fdt_declaration_refused"


class FdtDeclarationFileError(ValueError):
    """`eeglab-fdt-declarations.json` is malformed. One type for every refusal
    the loader makes, wrong shape or wrong value alike, so a caller never has to
    know which check fired; it fails the whole run, never one recording."""


class FdtDeclaration(TypedDict):
    fdt: str
    nbchan: int
    pnts: int
    trials: int
    fdt_bytes: int
    annex_key: str


def _fdt_positive_int(value: object, where: str) -> int:
    # bool is an int subclass; `true` is never a channel count.
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise FdtDeclarationFileError(f"{where} must be a positive integer, got {value!r}")
    return value


def _fdt_safe_rel(value: object, ext: str, where: str) -> str:
    # `normpath(value) == value` refuses empty and `.` segments and a trailing
    # slash; the explicit terms refuse what normpath leaves alone (`..`, an
    # absolute path, a backslash, NUL) and a bare extension with no stem.
    if (
        not isinstance(value, str)
        or not value.endswith(ext)
        or posixpath.basename(value) == ext
        or posixpath.normpath(value) != value
        or value.startswith("/")
        or ".." in value.split("/")
        or "\\" in value
        or "\0" in value
    ):
        raise FdtDeclarationFileError(f"{where} must be a repository-relative {ext} path, got {value!r}")
    return value


def load_fdt_declarations(
    path: str | None = None,
) -> dict[str, dict[str, FdtDeclaration]]:
    """Parse and validate the declaration file into
    ``{dataset_id: {set_path: FdtDeclaration}}``.

    Strict on purpose: an unknown key is refused (a misspelt field would
    otherwise be dropped and the entry read as something nobody reviewed), the
    declared byte count must equal ``nbchan * pnts * trials * 4`` (EEGLAB writes
    `.fdt` as float32), ``annex_key`` must be a SHA256E key whose size field is
    ``fdt_bytes``, and one `.fdt` (by path or by key) may back only one `.set`.
    A malformed file raises FdtDeclarationFileError (a ValueError; invalid JSON
    raises json.JSONDecodeError, also a ValueError) and so fails the run loudly
    rather than converting against a half-read declaration. A missing file
    means no declarations. ``path`` defaults to ``FDT_DECLARATIONS_PATH``, read
    at call time."""
    path = path or FDT_DECLARATIONS_PATH
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return {}
    if (
        not isinstance(doc, dict)
        or not isinstance(doc.get("datasets"), dict)
        or set(doc) - {"description", "datasets"}
    ):
        raise FdtDeclarationFileError(f"{path}: expected an object with 'description' and a 'datasets' object")
    out: dict[str, dict[str, FdtDeclaration]] = {}
    for dataset_id, ds in doc["datasets"].items():
        if not _FDT_DATASET_ID_RE.fullmatch(dataset_id):
            raise FdtDeclarationFileError(f"{path}: {dataset_id!r} is not a dataset id")
        if not isinstance(ds, dict) or not isinstance(ds.get("recordings"), dict):
            raise FdtDeclarationFileError(f"{path}: {dataset_id} needs a 'recordings' object")
        unknown = set(ds) - _FDT_DATASET_KEYS
        if unknown:
            raise FdtDeclarationFileError(f"{path}: {dataset_id} has unknown key(s) {sorted(unknown)}")
        if not isinstance(ds.get("reviewed"), str) or not ds["reviewed"]:
            raise FdtDeclarationFileError(f"{path}: {dataset_id} must record when it was 'reviewed'")
        recs: dict[str, FdtDeclaration] = {}
        claimed: dict[str, str] = {}
        pinned_keys: dict[str, str] = {}
        for set_path, entry in ds["recordings"].items():
            where = f"{path}: {dataset_id} {set_path!r}"
            _fdt_safe_rel(set_path, ".set", where)
            if is_excluded_from_discovery(set_path):
                raise FdtDeclarationFileError(f"{where}: only a raw recording can be declared (ADR 0027)")
            if not isinstance(entry, dict):
                raise FdtDeclarationFileError(f"{where}: expected an object")
            unknown = set(entry) - _FDT_RECORDING_KEYS
            missing = (_FDT_RECORDING_KEYS - {"evidence"}) - set(entry)
            if unknown or missing:
                raise FdtDeclarationFileError(
                    f"{where}: unknown key(s) {sorted(unknown)}, missing key(s) {sorted(missing)}"
                )
            fdt = _fdt_safe_rel(entry["fdt"], ".fdt", f"{where} fdt")
            if fdt in claimed:
                raise FdtDeclarationFileError(f"{where}: {fdt!r} is already declared for {claimed[fdt]!r}")
            claimed[fdt] = set_path
            fdt_bytes = _fdt_positive_int(entry["fdt_bytes"], f"{where} fdt_bytes")
            key = entry["annex_key"]
            m = _FDT_ANNEX_KEY_RE.fullmatch(key) if isinstance(key, str) else None
            if m is None:
                raise FdtDeclarationFileError(f"{where}: annex_key must be a SHA256E git-annex key, got {key!r}")
            if int(m[1]) != fdt_bytes:
                raise FdtDeclarationFileError(f"{where}: annex_key size {m[1]} != fdt_bytes {fdt_bytes}")
            if key in pinned_keys:
                raise FdtDeclarationFileError(f"{where}: {key} is already declared for {pinned_keys[key]!r}")
            pinned_keys[key] = set_path
            decl: FdtDeclaration = {
                "fdt": fdt,
                "nbchan": _fdt_positive_int(entry["nbchan"], f"{where} nbchan"),
                "pnts": _fdt_positive_int(entry["pnts"], f"{where} pnts"),
                "trials": _fdt_positive_int(entry["trials"], f"{where} trials"),
                "fdt_bytes": fdt_bytes,
                "annex_key": key,
            }
            implied = decl["nbchan"] * decl["pnts"] * decl["trials"] * 4
            if decl["fdt_bytes"] != implied:
                raise FdtDeclarationFileError(
                    f"{where}: fdt_bytes {decl['fdt_bytes']} != nbchan x pnts x trials x 4 "
                    f"= {implied}"
                )
            recs[set_path] = decl
        out[dataset_id] = recs
    return out


def eeglab_fdt_layout(set_local: str) -> tuple[int, int, int] | None:
    """``(nbchan, pnts, trials)`` from a classic EEGLAB `.set` header, or None
    when the `.set` carries its samples inline (``EEG.data`` is numeric, so there
    is no `.fdt` to find). Handles both saved forms: fields wrapped in one ``EEG``
    struct, and fields saved flat at the top level.

    A MATLAB v7.3 (HDF5) `.set` is refused rather than half-supported: no
    declared dataset uses one, and a declaration should not be the first code
    path to read that form's header."""
    with open(set_local, "rb") as fh:
        if fh.read(19) == b"MATLAB 7.3 MAT-file":
            raise FdtDeclarationRefused(
                "a declared .fdt is only supported for a classic (non-v7.3) EEGLAB .set"
            )
    import struct
    import zlib

    from scipy.io import loadmat  # biosigIO's own dependency
    from scipy.io.matlab import MatReadError

    # The `.set` was fetched successfully by this same attempt, so a header scipy
    # cannot parse is a property of the file, not of the node: refuse it typed
    # rather than let it escape uncoded and retry forever. MemoryError is not in
    # this tuple on purpose; convert_one types that one itself.
    try:
        mat = loadmat(set_local, squeeze_me=True, struct_as_record=False)
    except (
        MatReadError, ValueError, OSError, TypeError, EOFError, struct.error, zlib.error,
    ) as exc:
        raise FdtDeclarationRefused(
            f"the .set header could not be read to verify the declaration ({exc})"
        ) from exc
    src: Any = mat.get("EEG")

    def field(name: str) -> Any:
        if src is not None:
            return getattr(src, name, None)
        return mat.get(name)

    data = field("data")
    if not isinstance(data, str):
        return None
    try:
        nbchan = int(field("nbchan"))
        pnts = int(field("pnts"))
        trials = int(field("trials") or 1) or 1
    except (TypeError, ValueError) as exc:
        raise FdtDeclarationRefused(
            f"the .set header has no usable nbchan/pnts/trials ({exc})"
        ) from exc
    return nbchan, pnts, trials


def stage_declared_fdt(
    decl: FdtDeclaration,
    primary: str,
    primary_local: str,
    work: str,
    *,
    repo: str,
    head_files: set[str],
    head: str,
    local: bool,
    bucket: str | None = None,
    dataset_id: str | None = None,
) -> str:
    """Put the declared `.fdt` beside the `.set` under the sibling name the
    EEGLAB reader looks for first (``<set stem>.fdt``) and return the `.set` path
    the converter should read. Refuses (``FdtDeclarationRefused``) instead of
    guessing whenever the declaration and the data disagree.

    ``bucket`` and ``dataset_id`` name where the remote path fetches the `.fdt`
    from, so they are required unless ``local``; a missing one is a caller bug
    (ValueError), never an empty S3 path."""
    if not local and not (bucket and dataset_id):
        raise ValueError("stage_declared_fdt needs bucket and dataset_id unless local")
    fdt = decl["fdt"]
    if fdt not in head_files:
        raise FdtDeclarationRefused(f"declared .fdt {fdt!r} is not tracked at {head[:8]}")
    sibling_rel = os.path.splitext(primary)[0] + ".fdt"
    if sibling_rel in head_files:
        raise FdtDeclarationRefused(
            f"{primary!r} already has a sibling .fdt; the declaration of {fdt!r} contradicts the tree"
        )
    layout = eeglab_fdt_layout(primary_local)
    if layout is None:
        raise FdtDeclarationRefused(
            f"{primary!r} carries its samples inline, so no .fdt belongs to it"
        )
    declared = (decl["nbchan"], decl["pnts"], decl["trials"])
    if layout != declared:
        raise FdtDeclarationRefused(
            f"{primary!r} header says nbchan x pnts x trials = {layout}, the declaration says {declared}"
        )
    want = decl["fdt_bytes"]
    pinned = decl["annex_key"]

    def refuse_size(known: int) -> FdtDeclarationRefused:
        return FdtDeclarationRefused(
            f"declared .fdt {fdt!r} is {known} bytes; {primary!r} needs {want} "
            f"(nbchan {declared[0]} x pnts {declared[1]} x trials {declared[2]} x 4)"
        )

    def refuse_content(found: str) -> FdtDeclarationRefused:
        return FdtDeclarationRefused(
            f"declared .fdt {fdt!r} is {found}, not the reviewed content {pinned}"
        )

    # Size and content identity BEFORE fetching, from the pointer (annex key) or
    # the in-git blob, so a wrong pairing never costs a multi-GB download. An
    # annexed `.fdt` is pinned by its key; one without a key (in git, or an
    # unlocked working-tree file) is pinned by hashing the bytes against the
    # key's SHA-256 once they are local.
    key: str | None
    if local:
        src = os.path.join(repo, fdt)
        if not os.path.exists(src):
            raise FdtDeclarationRefused(f"declared .fdt {fdt!r} has no local content (run `git annex get`)")
        # The working tree, not HEAD: local mode converts what is checked out
        # (annex content present), so the size and bytes that matter are that
        # file's.
        known = os.path.getsize(src)
        key = parse_annex_key(os.readlink(src)) if os.path.islink(src) else None
    else:
        key, known = _blob_key_and_size(repo, fdt, head)
        if key is None and known == 0:
            # Listed in head_files but not in the tree at the pinned head (a
            # declared size is always positive, so an empty blob cannot match).
            raise FdtDeclarationRefused(f"declared .fdt {fdt!r} is not in the tree at {head[:8]}")
    if key is not None:
        if key != pinned:
            raise refuse_content(f"annex key {key}")
        known = annex_key_size(key)
    if known is not None and known != want:
        raise refuse_size(known)
    set_local = os.path.join(work, os.path.basename(primary))
    staged = os.path.splitext(set_local)[0] + ".fdt"
    if local:
        # Never write into the working tree: link both halves into `work`, which
        # convert_one removes afterwards.
        os.makedirs(work, exist_ok=True)
        if os.path.abspath(primary_local) != os.path.abspath(set_local):
            os.symlink(os.path.abspath(primary_local), set_local)
        os.symlink(os.path.abspath(src), staged)
    else:
        assert bucket and dataset_id  # checked on entry; narrows for the type checker
        found, _ = _fetch_blob(repo, bucket, dataset_id, fdt, head, staged)
        if not found:
            raise FdtDeclarationRefused(f"declared .fdt {fdt!r} could not be fetched at {head[:8]}")
    # No cleanup on refusal: `staged` is inside `work`, which convert_one's
    # `finally` removes whatever happens here.
    got = os.path.getsize(staged)
    if got != want:
        raise FdtDeclarationRefused(f"staged .fdt {fdt!r} is {got} bytes; expected {want}")
    if key is None:
        # The loader accepted `pinned` only as a SHA256E key, so its hash field
        # is the content's SHA-256.
        digest = _sha256_file(staged)
        if digest != pinned.split("--", 1)[1].split(".", 1)[0]:
            raise refuse_content(f"SHA-256 {digest}")
    print(f"[zarr] {primary}: using declared .fdt {fdt!r} ({want} bytes)", flush=True)
    return set_local


# --- Companion data the tree must hold (#1801) --------------------------------
#
# A BrainVision header and an EEGLAB `.set` can say their samples live in another
# file. When the dataset tree at the pinned commit holds no such file there is
# nothing to convert, and the reader's own error cannot say so reliably: its
# shape for a missing DataFile changed across biosigIO releases, and it cannot
# tell "absent from the tree" from "tracked under another stem and never
# fetched". The tree can. So the question is asked of the tree, before the read
# (`require_companions`), mirroring the fallbacks biosigIO itself applies so a
# recording that converts today is never refused here.

# The same-stem names biosigIO tries for a BrainVision `DataFile=` that names a
# file the header's directory lacks (`_SIBLING_EXTS["datafile"]`).
_VHDR_DATA_EXTS = (".eeg", ".dat")


def _vhdr_data_file(path: str) -> str | None:
    """The `DataFile=` a BrainVision header names in its `[Common Infos]`
    section, or None when it names none or cannot be read (then the reader
    decides, not this rule). Decoded as UTF-8, else Latin-1, which is what an
    ANSI header written by a Windows tool is; the key is read without regard to
    case, as `NumberOfChannels` is (`_vhdr_common_infos`)."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    section = _vhdr_common_infos(text)
    m = section and re.search(
        r"^[ \t]*DataFile[ \t]*=[ \t]*(.*?)[ \t]*\r?$", section, re.MULTILINE | re.IGNORECASE
    )
    return (m.group(1) or None) if m else None


def _tracked_same_stem(primary: str, head_files: set[str], exts: tuple[str, ...]) -> bool:
    """Whether the tree tracks a file beside `primary`, with its stem and one of
    `exts`, the extension compared without regard to case. The stem is compared
    up to Unicode normalization, as biosigIO's sibling search does, so an NFD
    name in one place and NFC in another is one file."""
    directory = os.path.dirname(primary)
    stem = unicodedata.normalize("NFC", filename_stem(primary))
    for tracked in head_files:
        if os.path.dirname(tracked) != directory:
            continue
        base, ext = os.path.splitext(os.path.basename(tracked))
        if ext.lower() in exts and unicodedata.normalize("NFC", base) == stem:
            return True
    return False


def _eeglab_names_an_fdt(path: str) -> bool:
    """Whether an EEGLAB `.set` keeps its samples in a `.fdt` (`EEG.data` is the
    file's NAME, not a matrix), from the header alone through the same bounded
    readers the channel gate uses. False for a header that cannot be read: that
    is the reader's to refuse."""
    try:
        with open(path, "rb") as fh:
            v73 = fh.read(len(_MATLAB_V73_MAGIC)) == _MATLAB_V73_MAGIC
        fields = _h5_eeglab_header(path) if v73 else _mat5_eeglab_header(path)
    except MemoryError:
        raise
    except Exception:  # noqa: BLE001 - an unreadable header is the reader's to refuse
        return False
    return fields.get("data") == "fdt"


def _eeglab_v73_epoch_count(path: str) -> int:
    """`trials` from a MATLAB v7.3 `.set`, read the way biosigIO's `_load_v73`
    reads it (the field as a float, rounded, zero read as one), through h5py's
    metadata alone. 1 for a classic file, and for anything that cannot be read
    or has no such field: this only ever LETS a file past `require_companions`,
    so an unknown count must not."""
    try:
        with open(path, "rb") as fh:
            if fh.read(len(_MATLAB_V73_MAGIC)) != _MATLAB_V73_MAGIC:
                return 1
        import h5py  # type: ignore[import-not-found]  # biosigIO's [hdf5] extra
        import numpy as np

        with h5py.File(path, "r") as f:
            group = f["EEG"] if "EEG" in f else f
            if "trials" not in group:
                return 1
            value = np.asarray(group["trials"][()], dtype=float).reshape(-1)
            return (int(round(float(value[0]))) or 1) if value.size else 1
    except MemoryError:
        raise
    except Exception:  # noqa: BLE001 - an unreadable header is the reader's to refuse
        return 1


def _eeglab_fdt_reference(path: str) -> str | None:
    """The `.fdt` file name an EEGLAB `.set` stores in `EEG.data`, or None when
    it cannot be read. Only called for a `.set` that `_eeglab_names_an_fdt` says
    holds a name, which is a header with no sample matrix, so reading the
    variable whole is cheap; the bounded readers above keep only a sentinel."""
    try:
        with open(path, "rb") as fh:
            v73 = fh.read(len(_MATLAB_V73_MAGIC)) == _MATLAB_V73_MAGIC
        if v73:
            import h5py  # type: ignore[import-not-found]  # biosigIO's [hdf5] extra

            with h5py.File(path, "r") as f:
                group = f.get("EEG", f)
                codes = group["data"][()].ravel()
                name = "".join(chr(int(code)) for code in codes)
        else:
            from scipy.io import loadmat  # biosigIO's own dependency

            mat = loadmat(path, squeeze_me=True, struct_as_record=False,
                          variable_names=["EEG", "data"])
            struct = mat.get("EEG")
            name = getattr(struct, "data", None) if struct is not None else mat.get("data")
    except MemoryError:
        raise
    except Exception:  # noqa: BLE001 - the name stays unknown; the sibling rule decides
        return None
    return name.strip() or None if isinstance(name, str) else None


def require_companions(
    primary: str, primary_local: str, head_files: set[str], head: str, fdt_declared: bool
) -> None:
    """Refuse, as `CompanionMissing`, a recording whose header says its samples
    live in a file the dataset tree does not hold. Runs before anything reads the
    recording, so the verdict does not depend on how a reader words its error.

    - BrainVision (`.vhdr`): the `[Common Infos]` DataFile is untracked AND no
      same-stem `.eeg` or `.dat` is. The second term is biosigIO's recovery for
      a header BIDS renamed the data file out from under (biosigio#132): such a
      recording converts, so it is not refused.
    - EEGLAB (`.set`): `EEG.data` is a file name, the same-stem `.fdt` is
      untracked, and no reviewed ADR 0073 declaration supplies one
      (`fdt_declared`; `stage_declared_fdt` verifies those and refuses them
      typed itself). biosigIO reads the same-stem file first and the embedded
      name second, so a tracked file of that name beside the `.set` also counts.
      A MATLAB v7.3 file with more than one epoch is left to the reader too,
      which refuses it `not_continuous` before it asks for the `.fdt`.

    Anything the rule cannot read it leaves alone: an unreadable header is the
    reader's to refuse. Messages name the missing file by its BIDS path and the
    commit judged, never a scratch path (`failure_detail` strips those)."""
    ext = lower_ext(primary)
    directory = os.path.dirname(primary)
    if ext == ".vhdr":
        name = _vhdr_data_file(primary_local)
        if name is None:
            return
        wanted = os.path.normpath(os.path.join(directory, name))
        if wanted in head_files or _tracked_same_stem(primary, head_files, _VHDR_DATA_EXTS):
            return
        raise CompanionMissing(
            f"BrainVision header names data file {wanted}, which is not in the dataset "
            f"tree at {head[:8]}"
        )
    if ext == ".set":
        sibling = os.path.splitext(primary)[0] + ".fdt"
        if fdt_declared or sibling in head_files or not _eeglab_names_an_fdt(primary_local):
            return
        # biosigIO's v7.3 reader refuses an epoched file (`not_continuous`) BEFORE
        # it looks for the `.fdt`, and that verdict is the one on record for such
        # a file; an absent `.fdt` is not a better description of it.
        if _eeglab_v73_epoch_count(primary_local) > 1:
            return
        embedded = _eeglab_fdt_reference(primary_local)
        beside = os.path.join(directory, os.path.basename(embedded)) if embedded else None
        if beside is not None and beside in head_files:
            return
        raise CompanionMissing(
            f"EEGLAB samples are in a separate .fdt file, and {sibling} is not in the "
            f"dataset tree at {head[:8]}"
        )


def embed_attr(meta_path: str, key: str, value: object) -> None:
    """Write a key into the `attributes` dict of an arbitrary Zarr v3 group zarr.json.

    Reads `meta_path`, sets `attributes[key] = value`, and writes back in place.
    Preserves all other fields. Use `embed_root_attr` for the store-root shorthand.
    """
    with open(meta_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    doc.setdefault("attributes", {})[key] = value
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)


def embed_root_attr(store_path: str, key: str, value: object) -> None:
    """Write a scalar into the Zarr v3 root group's attributes (its `zarr.json`)
    after biosigIO has written the store. Carries a display hint the converter knows
    from BIDS context but biosigIO does not (PowerLineFrequency), so the viewer reads
    it straight from the store with no extra fetch."""
    embed_attr(os.path.join(store_path, "zarr.json"), key, value)


def label_renames(root_attrs: dict) -> dict[str, str]:
    """biosigIO's `channel_labels_deduplicated` map from a store's root
    attributes' `recording_metadata`, `{new_label: file_label}`, or {} when it
    renamed nothing (or predates 1.2.9, which is when it started recording
    this). The one reader of that key: `store_metadata` hands it the attrs it
    already opened, `store_label_renames` the ones it reads from disk."""
    rec_meta = root_attrs.get("recording_metadata")
    renames = rec_meta.get("channel_labels_deduplicated") if isinstance(rec_meta, dict) else None
    if not isinstance(renames, dict):
        return {}
    return {str(k): str(v) for k, v in renames.items()}


def store_label_renames(store_path: str) -> dict[str, str]:
    """`label_renames` of a written store, read from its root `zarr.json`; {}
    when that cannot be read."""
    try:
        with open(os.path.join(store_path, "zarr.json"), encoding="utf-8") as fh:
            attrs = json.load(fh).get("attributes") or {}
    except (OSError, ValueError):
        return {}
    return label_renames(attrs) if isinstance(attrs, dict) else {}


def positions_for_renamed_labels(
    positions: dict[str, list[float]], renames: dict[str, str]
) -> dict[str, list[float]]:
    """Electrode positions a viewer can join to the STORE's channel labels.

    Positions are keyed by the electrodes.tsv `name`, and a viewer finds a
    channel's position by its label. When the file repeats a label, biosigIO
    serves the repeats as `<label>-0`, `<label>-1`, ... and a sidecar written
    from the file names only `<label>`, so every repeat would lose its position.
    Each renamed label inherits its file label's position, which is the
    electrode that label names. Only fills a gap: a sidecar that names the
    suffixed label itself (as MNE-BIDS writes it) is left as it is, and no
    existing key is dropped or overwritten.
    """
    out = dict(positions)
    for new_label, file_label in renames.items():
        if new_label not in out and file_label in positions:
            out[new_label] = positions[file_label]
    return out


def fix_source_file_attr(store_path: str, bids_relpath: str) -> None:
    """Overwrite the store's `recording_metadata.source_file` root attribute
    with the repository-relative BIDS path.

    Every biosigIO importer calls ``rec.set_metadata("source_file", filepath)``
    with whatever path this driver handed it -- the conversion host's scratch
    materialization (``.../zarr-scratch/tmpXXXXXXXX/work/...``), a fresh
    ``mkdtemp`` name every run. Left as-is, re-converting the same recording at
    the same source commit produces byte-different store metadata (defeating
    reproducibility), needlessly publishes the conversion host's internal
    directory layout, and names a directory that no longer exists by the time
    anyone reads it. ``bids_relpath`` is the same ``path`` this recording is
    already keyed at in index.json, so it is stable and known here without any
    extra lookup. biosigIO itself is untouched; this only corrects what NEMAR
    publishes downstream, after biosigIO has written the store and before it
    is validated/uploaded. nemarOrg/nemar-cli#1102.

    Since #1626 every store is written with ``exclude_subject_info``, which has
    biosigIO keep only the final component of the path (the scratch file's
    name, ``sss_<name>`` on the MaxShield path). The overwrite is unconditional,
    so the result is the BIDS path either way, and the rest of the root
    attributes, the ``subject_info_excluded`` mark included, are rewritten as
    read.
    """
    meta_path = os.path.join(store_path, "zarr.json")
    with open(meta_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    # `or {}` rather than a `{}` default: an explicit `"attributes": null` makes
    # `.get("attributes", {})` return None, and the chained .get would then raise.
    rec_meta = (doc.get("attributes") or {}).get("recording_metadata")
    if not isinstance(rec_meta, dict):
        # Unexpected biosigIO version/shape: nothing to correct, and we must
        # not fabricate a key biosigIO did not write.
        print(
            f"::warning::no recording_metadata attribute at {meta_path}; "
            "source_file scratch-path fix skipped",
            flush=True,
        )
        return
    rec_meta["source_file"] = bids_relpath
    # Write to a sibling temp file then os.replace: opening `meta_path` with "w"
    # truncates it first, so an interruption mid-dump would leave a truncated
    # zarr.json behind -- and validate_store only checks that the file EXISTS,
    # not that it parses, so a corrupt one could pass the gate. os.replace is
    # atomic within a directory, so the store metadata is never half-written.
    tmp_path = f"{meta_path}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        os.replace(tmp_path, meta_path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


# Matches `publisher` in backend/src/services/datacite.ts, shortened to the form a
# reference list actually carries.
_CITATION_PUBLISHER = "NEMAR"


def dataset_citation(row: dict | None) -> str | None:
    """A ready-to-paste citation string for a dataset, or None when the catalog
    row does not carry enough to make one honestly.

    #1064's point: a client that reads the data has the citation at the moment it
    needs it, rather than reconstructing it later or not at all -- which has a
    disproportionate effect on whether NEMAR gets cited correctly. Composed here
    rather than fetched because the catalog has no citation column; every part
    comes from the public row, and a missing part omits its segment instead of
    printing an empty one.
    """
    if not isinstance(row, dict):
        return None
    name = str(row.get("name") or "").strip()
    if not name:
        return None
    authors = str(row.get("authors") or "").strip()
    doi = str(row.get("concept_doi") or row.get("doi") or "").strip()
    version = str(row.get("latest_version") or "").strip()
    year = str(row.get("created_at") or "")[:4]
    parts: list[str] = []
    if authors:
        parts.append(authors)
    if year.isdigit():
        parts.append(f"({year})")
    parts.append(f"{name}{f' ({version})' if version else ''}.")
    parts.append(f"{_CITATION_PUBLISHER}.")
    if doi:
        parts.append(f"https://doi.org/{doi.removeprefix('doi:')}")
    return " ".join(parts)


def nemar_store_attrs(
    dataset_id: str,
    source_commit: str,
    source_tree: str,
    derived: bool,
    engine_version: str,
    contract_url: str,
    row: dict | None = None,
    provenance_fetch_failed: bool = False,
) -> dict:
    """The `nemar` root attribute written on every store (#1064). Pure.

    Store attributes carried provenance as PROSE -- a free-text `note` saying the
    copy is derived and the BIDS source is authoritative. That is fine for a human
    reading the JSON and useless to a client deciding whether the data is suitable,
    and the population reading these stores is increasingly machine. This is the
    structured half; biosigIO's own attributes (including that note) are left
    exactly as they are.

    DOI, license and citation especially: a store that carries its own attribution
    can be cited by whoever opens it. `row` is the public catalog row (GET
    /datasets/<id>); a field the catalog does not have stays None rather than
    being invented, so "unknown license" is distinguishable from "no license".
    `provenance_fetch_failed` carries the third case: the nulls are there because
    the catalog could not be read at all, which is a property of the RUN and is
    fixed by re-converting rather than by editing the dataset.
    """
    row = row if isinstance(row, dict) else {}
    doi = row.get("concept_doi") or row.get("doi")
    return {
        "dataset_id": dataset_id,
        "doi": doi or None,
        "license": row.get("license") or None,
        "citation": dataset_citation(row),
        "source_commit": source_commit,
        # Which BIDS tree the source sits in, vs whether the SIGNAL was
        # processed. #1064 flagged that "derivative" collides semantically
        # between the two senses; carrying both, named apart, is the fix.
        "source_tree": source_tree,
        "derived": derived,
        "hed_version": row.get("hed_version") or None,
        "engine_version": engine_version,
        # The stable URL for THIS store, so a copy of the store that has been
        # moved or vendored can still say where it came from.
        "contract_url": contract_url,
        # True when the catalog read FAILED, so the nulls above are a property of
        # this run rather than of the dataset. Present either way: a consumer
        # that has to check `"provenance_fetch_failed" in attrs` to know whether
        # an absence is meaningful is back where it started.
        "provenance_fetch_failed": provenance_fetch_failed,
    }


def fetch_dataset_row(api_base: str, dataset_id: str) -> tuple[dict | None, bool]:
    """`(row, fetch_failed)` for `GET <api_base>/datasets/<id>`.

    Read ONCE per run in `main` and passed to the workers, not fetched per
    recording: a dataset with 25k recordings would otherwise make 25k identical
    requests to the catalog. Best-effort by design -- the provenance attrs are
    written either way, with the catalog-sourced fields left None, because a
    catalog blip must not cost a conversion.

    The second element is why this returns a tuple rather than an optional row.
    "The catalog has no DOI for this dataset" and "we could not reach the
    catalog" both produce `doi: null` in the store attrs, and they mean opposite
    things: the first is a fact about the dataset, the second is a fact about the
    run, fixed by re-converting. Without the flag, a catalog outage silently
    publishes a whole conversion wave's worth of stores that claim to have no
    license -- afterwards indistinguishable from datasets that genuinely have
    none. `fetch_failed` is True ONLY for a transport/parse failure, never for a
    row that simply lacks a field.
    """
    url = f"{api_base.rstrip('/')}/datasets/{dataset_id}"
    try:
        req = urllib.request.Request(
            url, headers={"Accept": "application/json", "User-Agent": USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https base
            body = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - provenance is best-effort
        print(
            f"::warning::could not read {url} ({exc}); store provenance attrs will "
            "omit doi/license/citation/hed_version and are flagged "
            "provenance_fetch_failed",
            flush=True,
        )
        return None, True
    # The route wraps the row in `{dataset: {...}}` on some paths and returns it
    # bare on others; accept either rather than coupling to one shape.
    if isinstance(body, dict):
        inner = body.get("dataset")
        return (inner if isinstance(inner, dict) else body), False
    # A 200 whose body is not an object is a broken catalog, not an absent field.
    print(
        f"::warning::{url} returned a non-object body; store provenance attrs are "
        "flagged provenance_fetch_failed",
        flush=True,
    )
    return None, True


def electrode_positions_for(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> dict | None:
    """BIDS electrode positions for a recording, resolved via the inheritance
    principle: among the `_electrodes.tsv` sidecars in the recording's directory
    or an ancestor whose entities are a subset of the recording's, the most
    specific one wins. A sibling `_coordsystem.json` is resolved the same way.

    The TSV is parsed by its header row to find the `name`/`x`/`y`/`z` columns
    (robust to extra columns like type/impedance and to column-order variation).
    Rows where any of x/y/z is missing, non-numeric, or "n/a" are skipped.

    Returns ``{"positions": {label: [x, y, z]}, "coordinate_system": str,
    "coordinate_units": str}`` or None when no `_electrodes.tsv` resolves or it
    contains no valid rows.
    """
    stem = filename_stem(primary_path)
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(stem)

    def _resolve_sidecar(needle: str) -> str | None:
        """Return the most-specific applicable sidecar path, or None.

        `needle` is an entity-prefixed suffix like ``_electrodes.tsv``.
        A file matches when its basename ends with `needle` (e.g.
        ``sub-01_task-rest_electrodes.tsv``) or its basename is exactly
        the bare form without the leading underscore (e.g. ``electrodes.tsv``
        at the dataset root). Both forms carry empty entities, so the entity
        subset check still applies correctly.
        """
        bare = needle.lstrip("_")  # "electrodes.tsv" from "_electrodes.tsv"
        candidates: list[tuple[int, int, str]] = []
        for f in head_files:
            bname = os.path.basename(f)
            if not (f.endswith(needle) or bname == bare):
                continue
            cdir = os.path.dirname(f)
            if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
                continue
            cents = _bids_entities(filename_stem(f))
            if any(rec_ents.get(k) != v for k, v in cents.items()):
                continue
            depth = cdir.count("/") + (1 if cdir else 0)
            candidates.append((depth, len(cents), f))
        if not candidates:
            return None
        candidates.sort()
        # most specific = last after ascending sort
        return candidates[-1][2]

    elec_path = _resolve_sidecar("_electrodes.tsv")
    if elec_path is None:
        return None
    elec_text = _read_repo_text(repo_dir, head, elec_path)
    if not elec_text:
        return None

    # Parse the TSV by its header to locate name/x/y/z columns.
    lines = elec_text.splitlines()
    if not lines:
        return None
    header = [col.strip().lower() for col in lines[0].split("\t")]
    try:
        name_i = header.index("name")
        x_i = header.index("x")
        y_i = header.index("y")
        z_i = header.index("z")
    except ValueError:
        return None  # required columns absent

    positions: dict[str, list[float]] = {}
    for row_line in lines[1:]:
        if not row_line.strip():
            continue
        cols = row_line.split("\t")
        if len(cols) <= max(name_i, x_i, y_i, z_i):
            continue
        label = cols[name_i].strip()
        if not label:
            continue
        try:
            xv = cols[x_i].strip()
            yv = cols[y_i].strip()
            zv = cols[z_i].strip()
            if xv.lower() == "n/a" or yv.lower() == "n/a" or zv.lower() == "n/a":
                continue
            positions[label] = [float(xv), float(yv), float(zv)]
        except (ValueError, IndexError):
            continue

    if not positions:
        return None

    # Resolve the sibling coordsystem.json for coordinate metadata.
    coord_system = ""
    coord_units = ""
    cs_path = _resolve_sidecar("_coordsystem.json")
    if cs_path is not None:
        cs_text = _read_repo_text(repo_dir, head, cs_path)
        if cs_text:
            try:
                cs_data = json.loads(cs_text)
                if isinstance(cs_data, dict):
                    sys_val = cs_data.get("EEGCoordinateSystem") or cs_data.get(
                        "iEEGCoordinateSystem"
                    ) or cs_data.get("MEGCoordinateSystem") or ""
                    units_val = cs_data.get("EEGCoordinateUnits") or cs_data.get(
                        "iEEGCoordinateUnits"
                    ) or cs_data.get("MEGCoordinateUnits") or ""
                    coord_system = str(sys_val) if sys_val else ""
                    coord_units = str(units_val) if units_val else ""
            except ValueError:
                pass

    return {
        "positions": positions,
        "coordinate_system": coord_system,
        "coordinate_units": coord_units,
    }


def event_descriptions_for(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> dict[str, str]:
    """BIDS event-code descriptions for a recording, resolved via the inheritance
    principle: among the `_events.json` sidecars sitting in the recording's
    directory or an ancestor whose entities are a subset of the recording's, the
    most specific one wins (overrides less specific). Returns a flat mapping of
    event code -> description string (empty dict when none apply or no Levels are
    declared).

    Each applicable `_events.json` sidecar is parsed as a BIDS column-metadata
    object. For every top-level value that is a dict containing a ``"Levels"`` dict,
    its ``{str: str}`` entries are merged (most-specific sidecar wins). This supports
    multiple columns declaring Levels (e.g. ``value``, ``trial_type``).

    Sidecars are small JSON files tracked in git (not annexed); read via the working
    tree when present and ``git cat-file`` otherwise, matching the no-checkout
    workflow clone behavior.
    """
    stem = filename_stem(primary_path)
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(stem)
    needle = "_events.json"
    candidates: list[tuple[int, int, str]] = []
    for f in head_files:
        if not f.endswith(needle):
            continue
        cdir = os.path.dirname(f)
        # Applicable only if the sidecar is in the recording's dir or an ancestor.
        if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
            continue
        cents = _bids_entities(filename_stem(f))
        # ...and its entities must be a subset of the recording's.
        if any(rec_ents.get(k) != v for k, v in cents.items()):
            continue
        depth = cdir.count("/") + (1 if cdir else 0)
        candidates.append((depth, len(cents), f))
    candidates.sort()  # least specific first; the most specific value overrides
    result: dict[str, str] = {}
    for _, _, f in candidates:
        text = _read_repo_text(repo_dir, head, f)
        if text is None:
            continue
        try:
            data = json.loads(text)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        for col_meta in data.values():
            if not isinstance(col_meta, dict):
                continue
            levels = col_meta.get("Levels")
            if not isinstance(levels, dict):
                continue
            for code, desc in levels.items():
                if isinstance(code, str) and code and isinstance(desc, str) and desc:
                    result[code] = desc
    return result


def _recording_size_bytes(primary_local: str) -> int:
    """On-disk size of a recording: its primary file + same-stem companions
    (`.eeg`/`.vmrk` for BrainVision; FIF is single-file), or every file under a
    directory recording. The `os.path.isdir` branch is format-agnostic, so it
    already covers CTF `.ds`, MEF3 `.mefd` (a real MEF3 session's bulk lives in
    its many `.timd/.../.tdat` channel-segment files, not any single header), and
    a 4D/BTi directory (whose bulk is the `c,rf*` processed-data file) with no
    extension-specific code -- summing the whole tree is correct for all three.
    Drives the streaming decision -- the bulk lives in the `.eeg` companion /
    `.meg4` / `.tdat` / `c,rf*`, not the tiny header files beside it.

    On any stat/listing error this returns a value that FORCES the (bounded-memory)
    streaming path rather than an undercount/zero, which would misroute a large
    recording to the OOM-prone in-memory path. Only MNE-native exts reach streaming,
    so over-forcing a small file there is at worst slower, never wrong."""
    force = 1 << 62  # exceeds any real STREAM_MIN_BYTES -> routes to streaming
    # Any directory recording (CTF `.ds` / MEF3 `.mefd` / 4D-BTi): sum the whole
    # directory tree. `os.path.isdir` alone decides this -- no extension check
    # needed, which is exactly why this branch already covers `.mefd`/BTi too.
    if os.path.isdir(primary_local):
        errored = False

        def _onerr(_exc: OSError) -> None:
            nonlocal errored
            errored = True

        total = 0
        for root, _dirs, files in os.walk(primary_local, onerror=_onerr):
            for fn in files:
                try:
                    total += os.path.getsize(os.path.join(root, fn))
                except OSError:
                    errored = True
        if errored:
            print(f"::warning::could not fully stat recording dir {primary_local!r}; forcing streaming", flush=True)
            return force
        return total
    d = os.path.dirname(primary_local) or "."
    try:
        entries = os.listdir(d)
    except OSError:
        print(f"::warning::could not list {d!r}; forcing streaming", flush=True)
        return force
    # A split FIF's bulk lives in split-02.., which carry DIFFERENT stems
    # (`_split-02_meg` vs `_split-01_meg`); summing only split-01's same-stem
    # companions undercounts the chain, so should_stream misroutes a multi-GB
    # recording onto the OOM-prone in-memory path (read_raw_fif follows the whole
    # chain on disk). Sum every local member of the split group instead. #909
    if is_split_fif(primary_local):
        gkey = split_group_key(primary_local)
        total = 0
        for fn in entries:
            full = os.path.join(d, fn)  # split_group_key keeps the dir; compare on full paths
            if is_split_fif(full) and split_group_key(full) == gkey:
                try:
                    total += os.path.getsize(full)
                except OSError:
                    print(f"::warning::could not stat split member {fn!r}; forcing streaming", flush=True)
                    return force
        return total
    stem = filename_stem(primary_local)
    total = 0
    for fn in entries:
        if os.path.splitext(fn)[0] == stem:
            try:
                total += os.path.getsize(os.path.join(d, fn))
            except OSError:
                print(f"::warning::could not stat {fn!r}; forcing streaming", flush=True)
                return force
    return total


# --- Subject information never reaches a store (#1626) -------------------------
# A Zarr store holds the data, the events, channel names, types and units, and
# technical recording metadata. It never holds the subject. Age, sex, a patient
# code or name, a birth date and other phenotype stay at dataset scope, in
# participants.tsv, and the operator and administrative free text a recording
# header carries (technician, equipment, admin code, additional recording text) is
# not data, events or channels either. The 2026-10-05 census found patientcode,
# birthdate, gender and equipment non-empty in every store root of nm000186.
#
# biosigIO 1.2.11 added `exclude_subject_info` to its three store writers: it
# removes the members `biosigio.SUBJECT_INFO_KEYS` names from `recording_metadata`
# at any depth, reduces `source_file` and `bti_pdf_file` to their final path
# component, and marks the store root `subject_info_excluded: true`. The list of
# members is biosigIO's and lives there only; this module keeps no copy of it.
#
# Four layers, so no path uploads a store with those members in it:
#   * `main` refuses to convert anything on a biosigIO that cannot leave them out
#     (`biosigio_subject_info_problems`), and exits EXIT_SUBJECT_INFO_UNAVAILABLE
#     rather than fall back to a store that carries them. hallu-zarr.sh stops its
#     drain on that exit instead of failing every queued dataset in turn.
#   * Every store is written through `write_store`, which passes the option
#     itself, refuses a writer whose signature does not NAME it, refuses a
#     writer that reports a path other than the store to be uploaded, and reads
#     that root back (`require_subject_info_excluded`: the mark, and the
#     metadata unchanged by biosigIO's own `strip_subject_info`). It runs in the
#     process that writes, so a pool worker that imports a different biosigIO
#     from the one `main` checked still refuses. A test fails if a biosigIO
#     writer is referenced anywhere else.
#   * `sync_store`, the one upload, runs the same read-back on the bytes it is
#     about to upload, after every later rewrite of the root.
#   * hallu-zarr.sh's setup() refuses an installed biosigIO below 1.2.11.
#
# `fix_source_file_attr` still rewrites `source_file` afterwards: biosigIO now
# leaves the scratch file's name there instead of its whole path, and the
# converter replaces it with the BIDS path the index keys the store by.
SUBJECT_INFO_FLOOR = "1.2.11"
SUBJECT_INFO_OPTION = "exclude_subject_info"
SUBJECT_INFO_EXCLUDED_ATTR = "subject_info_excluded"
# The writers that put a store on disk, by the names `biosigio_subject_info_problems`
# reports them under. `Recording.to_zarr` forwards to `ZarrExporter.export`, so
# both have to take the option for the in-memory path to honor it.
BIOSIGIO_STORE_WRITERS = ("Recording.to_zarr", "ZarrExporter.export", "stream_to_zarr")
# sysexits.h EX_CONFIG: what is wrong is the node's biosigIO, not the dataset.
EXIT_SUBJECT_INFO_UNAVAILABLE = 78

# A final release: `1.2.11`, `1.2.11.post1`, `1.2.11+local.1`. A pre-release or a
# dev build does not match and is refused, the same rule hallu-zarr.sh's
# BIOSIGIO_FLOOR_PROBE applies: `1.2.11rc1` sorts BELOW 1.2.11, and a parser that
# kept only its leading digits would read it as 1.2.11 and accept it.
_FINAL_RELEASE_RE = re.compile(
    r"(\d+(?:\.\d+)*)(?:\.post\d+)?(?:\+[a-z0-9]+(?:\.[a-z0-9]+)*)?", re.IGNORECASE
)


class SubjectInfoExclusionUnavailable(RuntimeError):
    """The biosigIO this process writes with cannot leave subject information out
    of a store, or a store came back without the mark that says it did.

    Deliberately uncoded (no `.code`): it is a property of the node, not of the
    recording, so `convert_one` lists the recording as pending and retries it,
    and the store it refused is never uploaded. A run whose every failure is
    one exits EXIT_SUBJECT_INFO_UNAVAILABLE (`subject_info_refused_run`).
    """


def subject_info_refused_run(failures: list[str], refused: list[str]) -> bool:
    """Whether a run failed ONLY because its conversion processes refused to
    write or upload a store that may carry subject information.

    That happens past `main`'s startup check: a pool worker that imports a
    different biosigIO, or a later rewrite of a store root that loses the mark.
    Like the startup refusal it is the node's fault, not the dataset's, so the
    run exits EXIT_SUBJECT_INFO_UNAVAILABLE and hallu-zarr.sh stops the drain
    rather than spend a retry attempt of every queued dataset. A run with any
    other failure, or with none, takes the ordinary path.
    """
    return bool(failures) and set(failures) == set(refused)


def final_release(version: object) -> tuple[int, ...] | None:
    """The numeric release fields of a final release version, trailing zeros
    dropped so `1.2.11.0` compares equal to `1.2.11`; None for anything else
    (a pre-release, a dev build, None, or text that is not a version). Compared
    as a tuple, because as strings "1.10.0" sorts below "1.2.11"."""
    if not isinstance(version, str):
        return None
    match = _FINAL_RELEASE_RE.fullmatch(version.strip())
    if match is None:
        return None
    fields = [int(part) for part in match.group(1).split(".")]
    while len(fields) > 1 and fields[-1] == 0:
        fields.pop()
    return tuple(fields)


def names_keyword(fn: object, name: str) -> bool:
    """Whether `fn`'s signature NAMES `name` as a parameter a caller can pass by
    keyword. A bare `**kwargs` does not count: a writer that only collects
    unknown keywords can drop this one and write the store without it."""
    if not callable(fn):
        return False
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    param = params.get(name)
    return param is not None and param.kind in (
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
        inspect.Parameter.KEYWORD_ONLY,
    )


def subject_info_problems(
    *,
    installed_version: str | None,
    imported_version: object,
    writers: Mapping[str, object],
    strip: object,
) -> list[str]:
    """Why a biosigIO cannot be trusted to leave subject information out of a
    store; empty when it can.

    Both versions have to be a final release at or above SUBJECT_INFO_FLOOR: the
    distribution the environment says is installed, and the `__version__` of
    the module actually imported, which differ when an older copy shadows the
    installed one or was imported before an upgrade. Each writer in
    BIOSIGIO_STORE_WRITERS has to name `exclude_subject_info` in its signature;
    a version alone is not proof, because a build can carry a version it does
    not have the code for. `strip` is biosigIO's `strip_subject_info`, which
    `require_subject_info_excluded` checks every written store with.
    """
    problems: list[str] = []
    floor = final_release(SUBJECT_INFO_FLOOR)
    assert floor is not None
    for label, version in (("installed", installed_version), ("imported", imported_version)):
        release = final_release(version)
        if version is None:
            problems.append(f"no {label} biosigIO version could be read")
        elif release is None:
            problems.append(
                f"the {label} biosigIO version {version!r} is not a final release"
            )
        elif release < floor:
            problems.append(
                f"the {label} biosigIO is {version}, below {SUBJECT_INFO_FLOOR}"
            )
    for name in BIOSIGIO_STORE_WRITERS:
        fn = writers.get(name)
        if fn is None:
            problems.append(f"biosigIO has no {name}")
        elif not names_keyword(fn, SUBJECT_INFO_OPTION):
            problems.append(f"biosigIO's {name} does not take {SUBJECT_INFO_OPTION}")
    if not callable(strip):
        problems.append("biosigIO has no strip_subject_info to check a written store with")
    return problems


def biosigio_subject_info_problems() -> list[str]:
    """`subject_info_problems` for the biosigIO this process imports, resolved
    the way the conversion resolves it: `import biosigio`, its `Recording` and
    `stream_to_zarr`, and `biosigio.exporters.zarr.ZarrExporter`."""
    try:
        from importlib.metadata import version

        installed: str | None = version("biosigio")
    except Exception:  # noqa: BLE001 - absent metadata is reported, not raised
        installed = None
    try:
        # By name rather than an import statement: biosigIO is a runtime-only
        # dependency of this module, absent from the fast test tier.
        biosigio = importlib.import_module("biosigio")
        zarr_module = importlib.import_module("biosigio.exporters.zarr")
        exporter = getattr(zarr_module, "ZarrExporter", None)
    except Exception as exc:  # noqa: BLE001 - any import failure means "cannot"
        return [f"biosigIO cannot be imported ({type(exc).__name__}: {exc})"]
    recording = getattr(biosigio, "Recording", None)
    return subject_info_problems(
        installed_version=installed,
        imported_version=getattr(biosigio, "__version__", None),
        writers={
            "Recording.to_zarr": getattr(recording, "to_zarr", None),
            "ZarrExporter.export": getattr(exporter, "export", None),
            "stream_to_zarr": getattr(biosigio, "stream_to_zarr", None),
        },
        strip=getattr(biosigio, "strip_subject_info", None),
    )


def require_subject_info_excluded(store_path: str) -> None:
    """Refuse a store whose root does not show subject information left out.

    Two checks on the root `zarr.json` on disk, which is what gets uploaded: it
    carries `subject_info_excluded: true`, the mark biosigIO sets when it left
    the members out, and its `recording_metadata` is unchanged by biosigIO's own
    `strip_subject_info`, so no member biosigIO lists is there at any depth
    whatever the mark says. The second check uses biosigIO's list, never a copy,
    and fails closed when that function cannot be imported. A root with no
    `recording_metadata` is refused too: biosigIO always writes one, so its
    absence means something else wrote the root.
    """
    meta_path = os.path.join(store_path, "zarr.json")
    try:
        with open(meta_path, encoding="utf-8") as fh:
            attrs = json.load(fh).get("attributes")
    except (OSError, ValueError, AttributeError) as exc:
        raise SubjectInfoExclusionUnavailable(
            f"cannot read {meta_path} to confirm subject information was left out ({exc})"
        ) from exc
    if not isinstance(attrs, dict) or attrs.get(SUBJECT_INFO_EXCLUDED_ATTR) is not True:
        raise SubjectInfoExclusionUnavailable(
            f"{store_path} was written without `{SUBJECT_INFO_EXCLUDED_ATTR}: true`; "
            "refusing to publish a store that may carry subject information"
        )
    rec_meta = attrs.get("recording_metadata")
    if not isinstance(rec_meta, dict):
        raise SubjectInfoExclusionUnavailable(
            f"{store_path} has no recording_metadata object to check for subject information"
        )
    try:
        strip = importlib.import_module("biosigio").strip_subject_info
    except Exception as exc:  # cannot verify means refuse
        raise SubjectInfoExclusionUnavailable(
            f"cannot check {store_path} for subject information: biosigIO's "
            f"strip_subject_info is unavailable ({type(exc).__name__}: {exc})"
        ) from exc
    if strip(rec_meta) != rec_meta:
        raise SubjectInfoExclusionUnavailable(
            f"{store_path} carries a recording_metadata member biosigIO lists as "
            "subject information; refusing to publish it"
        )


def write_store(
    writer: Callable[..., object], *args: object, expected_path: str, **kwargs: object
) -> str:
    """Write a store with a biosigIO writer, leaving subject information out.

    The ONLY way this module writes a store: a test scans the scripts for a
    biosigIO writer referenced anywhere but as this function's first argument.
    `writer` is `Recording.to_zarr`, `ZarrExporter.export` or `stream_to_zarr`,
    called with `args` and `kwargs` plus `exclude_subject_info=True`. Refused
    BEFORE the call when the writer does not name the option, so a worker
    holding an older biosigIO writes nothing; and refused AFTER it when the
    path the writer reports is not `expected_path` (the store the caller will
    upload) or that store's root does not show subject information left out.
    `sync_store` checks the same store again right before the upload, after
    every later rewrite of its root. Returns `expected_path`.
    """
    name = getattr(writer, "__qualname__", None) or repr(writer)
    if SUBJECT_INFO_OPTION in kwargs:
        raise TypeError(f"write_store sets {SUBJECT_INFO_OPTION} itself; do not pass it")
    if not names_keyword(writer, SUBJECT_INFO_OPTION):
        raise SubjectInfoExclusionUnavailable(
            f"{name} does not take {SUBJECT_INFO_OPTION}: this process has a biosigIO "
            f"older than {SUBJECT_INFO_FLOOR}, so no store was written"
        )
    written = writer(*args, **kwargs, **{SUBJECT_INFO_OPTION: True})
    if isinstance(written, os.PathLike):
        written = os.fspath(written)
    if not isinstance(written, str):
        raise SubjectInfoExclusionUnavailable(
            f"{name} returned {type(written).__name__}, not the store path it wrote"
        )
    if os.path.realpath(written) != os.path.realpath(expected_path):
        raise SubjectInfoExclusionUnavailable(
            f"{name} reports writing {written}, not {expected_path}, the store that "
            "would be uploaded"
        )
    require_subject_info_excluded(expected_path)
    return expected_path


def sync_store(store_local: str, prefix: str) -> None:
    """Upload one converted store to `prefix` with `aws s3 sync --delete`.

    The last step between a store and the public bucket, and the one place a
    store is uploaded, so it checks the bytes being uploaded once more
    (`require_subject_info_excluded`), after every rewrite of the root that
    followed the write (`fix_source_file_attr`, `embed_root_attr`).

    Latest-only: --delete drops stale chunk objects a smaller new store no
    longer needs. Long origin TTL; the callback purges zarr.json/index.json.
    Through `_aws` for the wall-clock timeout + retry: a store is thousands of
    tiny chunk PUTs, which under contention intermittently fail ("Need to
    rewind the stream") or wedge; sync is idempotent so a retry just re-PUTs
    whatever is missing.
    """
    require_subject_info_excluded(store_local)
    _aws([
        "aws", "s3", "sync", store_local, prefix,
        "--delete", "--only-show-errors",
        "--cache-control", "public, max-age=86400",
    ])


def bids_channels_arg(channels_local: str | None) -> str:
    """The `bids_channels` value for both biosigIO exporters: the resolved sidecar
    path, or "off".

    Never "auto" (biosigIO's default), and that is the whole point. "auto" looks
    for a SIBLING `_channels.tsv` next to the file it was handed, which is the
    wrong question twice over:

    * The file this driver hands the exporter is not the recording's own path. It
      is a scratch materialization in `work/`, and on the ADR 0028 MaxShield path
      it is the Signal-Space-Separated copy at `work/sss_<basename>`. Sibling
      detection there finds whatever this driver happened to stage, or nothing.
    * BIDS inheritance is not siblinghood. The sidecar that applies to
      `sub-01/eeg/..._eeg.edf` may live in `sub-01/` or at the dataset root; the
      resolution that finds it is `channels_tsv_for`, which is also what the
      channel-count fidelity gate consults. The gate and the conversion must
      agree about WHICH sidecar applies, or the gate is checking a different file
      than the one that shaped the store.

    So the path is always resolved from the ORIGINAL BIDS `primary` and passed
    explicitly, and "off" says "there is no applicable sidecar" rather than
    leaving the exporter to guess. biosigio>=1.2.7 accepts the path form on
    `Recording.from_file` AND `stream_to_zarr` and acts on it (biosigio#128,
    closing #127); on 1.2.6 the streaming exporter had no such parameter and
    `from_file` accepted a path and silently ignored it, which is why the pin is
    a floor and not a preference.
    """
    return channels_local if channels_local and os.path.exists(channels_local) else "off"


def _memmap_scratch_dir(store_path: str) -> str:
    """The recording's own memmap directory, created. `tempfile` needs the parent to
    exist before it will make a `TemporaryDirectory` inside it."""
    path = store_path + SCRATCH_DIR_SUFFIX
    os.makedirs(path, exist_ok=True)
    return path


def convert_recording(
    primary_local: str,
    events_local: str | None,
    store_path: str,
    power_line_frequency: float | None = None,
    value_descriptions: dict[str, str] | None = None,
    electrode_positions: dict | None = None,
    mem_budget_bytes: int | None = None,
    hard_ceiling_bytes: int | None = None,
    projected_peak: int | None = None,
    channels_local: str | None = None,
) -> None:
    modality = bids_suffix_modality(primary_local)
    size_bytes = _recording_size_bytes(primary_local)
    streaming = should_stream(primary_local, size_bytes)
    # Preflight (#909): skip -- BEFORE any load -- a recording whose projected
    # peak RAM won't fit this run's budget, so it can never OOM-crash the worker
    # and BrokenProcessPool-cascade its siblings. Raised as a typed, coded failure
    # -> a DETERMINISTIC skip surfaced in the index, not an infra retry.
    if mem_budget_bytes is not None:
        # Use the projection ADMISSION computed, not a fresh blind one. Phase 4
        # made `projected_peak_bytes` channel-aware but only updated main()'s call
        # site; recomputing here without the channel count always yielded the flat
        # STREAM_PEAK_BYTES floor for a streaming recording -- and since the
        # ceiling is itself floored at 2x that value, `peak > mem_budget` was then
        # unsatisfiable for EVERY streaming recording, making the permanent
        # `RecordingTooLarge` verdict dead code on that whole path. One number,
        # computed once, is also simply the right shape.
        peak = (
            projected_peak
            if projected_peak is not None
            else projected_peak_bytes(primary_local, size_bytes)
        )
        # Injectable so the two verdicts can be tested without reloading the module
        # (a reload rebinds the exception classes and breaks assertRaises).
        hard_ceiling = (
            hardware_ceiling_bytes() if hard_ceiling_bytes is None else hard_ceiling_bytes
        )
        # The permanent verdict requires the two ceilings to be DISTINGUISHABLE.
        # When /proc/meminfo is unreadable both fall back to the same fixed figure,
        # which makes `peak <= hard_ceiling` unsatisfiable whenever
        # `peak > mem_budget_bytes` -- so every over-budget recording would be
        # marked permanently too-large, silently defeating the whole reason #1111
        # split these verdicts apart. If we cannot tell the two apart, prefer the
        # retryable verdict: being wrong that way costs one re-attempt, the other
        # way buries a dataset forever.
        if hard_ceiling <= mem_budget_bytes:
            hard_ceiling = None
        if peak > mem_budget_bytes and (hard_ceiling is None or peak <= hard_ceiling):
            # Fits the node, just not what is free right now. A TEMPORARY
            # condition on a shared box, so it must retry rather than mark the
            # dataset terminal -- otherwise one busy hour permanently buries a
            # dataset that converts fine an hour later. #1111
            raise RecordingMemoryExceeded(
                f"projected peak ~{peak // 1024**3} GiB exceeds the "
                f"~{mem_budget_bytes // 1024**3} GiB free on the node right now "
                f"(the node itself could hold it); will retry"
            )
        if peak > mem_budget_bytes:
            raise RecordingTooLarge(
                f"projected peak ~{peak // 1024**3} GiB exceeds the "
                f"~{mem_budget_bytes // 1024**3} GiB per-recording budget for this run "
                f"(on-disk {size_bytes // 1024**3} GiB via the "
                f"{'streaming' if streaming else 'in-memory'} path"
                f"{projection_factor_hint(primary_local, streaming)}; "
                "the budget is the node's usable RAM and does NOT change with --jobs)"
            )
    def _convert_in_memory() -> None:
        from biosigio import Recording, bids  # type: ignore[import-not-found]  # lazy: runtime-only dep

        # mixed_rate="resample": a Zarr store is a derived serving copy (viewing + ML),
        # not the authoritative recording, so for a mixed-sampling-rate EDF/BDF (e.g.
        # polysomnography: EEG ~200 Hz + SpO2 ~12.5 Hz) upsample the slow channels onto
        # the fastest channel's grid rather than failing the conversion. biosigIO
        # defaults to "error" everywhere else so no one gets resampled data unknowingly
        # (requires biosigio>=1.1.4; ignored for non-EDF formats). See nemar-cli#737.
        # `bids_channels` is the resolved sidecar path or "off", never "auto" --
        # see `bids_channels_arg` for why sibling auto-detection is the wrong
        # question for a scratch materialization. The importer applies it before
        # the suffix override below, which deliberately has the last word on
        # modality (see its comment), and records what the `units` column did in
        # `rec.metadata["channels_tsv_units"]` -> the store's `recording_metadata`
        # -> the index entry's `units_report`.
        rec = Recording.from_file(
            primary_local,
            mixed_rate="resample",
            bids_channels=bids_channels_arg(channels_local),
        )
        if events_local and os.path.exists(events_local):
            bids.apply_events_tsv(rec, events_local)
        # Suffix-driven modality: group + resample the whole recording by its BIDS
        # datatype (an _eeg file -> eeg_250hz), regardless of what the importer guessed
        # per channel. Without this, EEGLAB's empty chanlocs type -> MISC -> misc_1024hz.
        if modality:
            for label in rec.channels:
                rec.channels[label]["modality"] = modality
        # Through `write_store`, never `rec.to_zarr(...)` directly: it is what
        # leaves subject information out of the store (#1626).
        write_store(
            rec.to_zarr, store_path, expected_path=store_path,
            dtype="int16", modality_rates=MODALITY_RATES,
        )

    # Large recordings use the streaming converter so peak RAM stays bounded; the
    # in-memory path would load them at float64 2-3x and OOM. (multi-GB BrainVision/
    # FIF/CTF/MEF3/4D-BTi, KIT, and EDF/BDF via
    # pyedflib on biosigio>=1.2.0 -- see should_stream.)
    if streaming:
        from biosigio import stream_to_zarr  # type: ignore[import-not-found]  # lazy
        from biosigio.bids import read_events_tsv  # type: ignore[import-not-found]  # lazy
        from biosigio.exceptions import MixedSamplingRateError  # type: ignore[import-not-found]

        events_df = (
            read_events_tsv(events_local)
            if events_local and os.path.exists(events_local)
            else None
        )
        try:
            # Through `write_store` like the in-memory path, so neither exporter
            # can write a store that carries subject information (#1626).
            write_store(
                stream_to_zarr,
                primary_local,
                store_path,
                expected_path=store_path,
                force_modality=modality,
                modality_rates=MODALITY_RATES,
                dtype="int16",
                events_df=events_df,
                # Keep the temp channel-major memmap on the same (fast) scratch volume as
                # the store; it is a sibling directory, not synced to S3, and unique to
                # this recording so a pool break can reclaim it (see
                # `reclaim_recording_scratch`).
                scratch_dir=_memmap_scratch_dir(store_path),
                # The same explicit sidecar the in-memory path uses, so the two
                # exporters cannot disagree about a recording's units -- the
                # disagreement that held the engine bump back until biosigio#128
                # gave `stream_to_zarr` this parameter. See `bids_channels_arg`.
                bids_channels=bids_channels_arg(channels_local),
            )
        except MixedSamplingRateError:
            # A mixed per-channel-rate EDF can't stream on a single grid; the
            # in-memory path resamples it (mixed_rate="resample"). Re-check the
            # (larger) in-memory budget before the full-load fallback so a big
            # mixed-rate EDF is #909-skipped rather than OOMing.
            if mem_budget_bytes is not None:
                inmem_peak = int(size_bytes * inmem_factor_for(primary_local))
                if inmem_peak > mem_budget_bytes and inmem_peak <= (
                    hardware_ceiling_bytes() if hard_ceiling_bytes is None
                    else hard_ceiling_bytes
                ):
                    raise RecordingMemoryExceeded(
                        f"mixed-rate EDF needs the in-memory resample path "
                        f"(projected ~{inmem_peak // 1024**3} GiB > "
                        f"~{mem_budget_bytes // 1024**3} GiB free right now); will retry"
                    )
                if inmem_peak > mem_budget_bytes:
                    raise RecordingTooLarge(
                        f"mixed-rate EDF needs the in-memory resample path "
                        f"(projected ~{inmem_peak // 1024**3} GiB > "
                        f"~{mem_budget_bytes // 1024**3} GiB budget); the budget is the node's usable RAM and does NOT change with --jobs"
                    ) from None
            _convert_in_memory()
    else:
        _convert_in_memory()
    if power_line_frequency is not None:
        embed_root_attr(store_path, "power_line_frequency", power_line_frequency)
    if value_descriptions:
        events_meta = os.path.join(store_path, "events", "zarr.json")
        if os.path.exists(events_meta):
            embed_attr(events_meta, "value_descriptions", value_descriptions)
    if electrode_positions is not None:
        embed_root_attr(
            store_path, "electrode_positions",
            positions_for_renamed_labels(
                electrode_positions["positions"], store_label_renames(store_path)
            ),
        )
        embed_root_attr(store_path, "electrode_coordinate_system", electrode_positions["coordinate_system"])
        embed_root_attr(store_path, "electrode_coordinate_units", electrode_positions["coordinate_units"])


# --- Parallel conversion ------------------------------------------------------
# Recordings are independent (distinct S3 store prefixes), so they convert in a
# ProcessPoolExecutor: each worker streams its own annex blob, converts, validates,
# and `aws s3 sync`s its store, then returns the index entry. Conversion is
# CPU-bound (resample + zstd), so processes (not threads) give real parallelism.
# The shared context (repo, bucket, head, the head file set) is pickled once per
# worker via the initializer, not once per task.

_CTX: dict = {}


def _init_worker(ctx: dict) -> None:
    _CTX.clear()
    _CTX.update(ctx)


def convert_one(primary: str, peak_bytes: int | None = None) -> dict:
    """Convert + upload one recording in a pool worker. Returns
    {"ok": True, "primary", "entry"} or {"ok": False, "primary", "error"}.
    Self-contained and picklable; reads shared inputs from the worker `_CTX`."""
    c = _CTX
    # `work`/`store_local` are bound before the try so the `finally` can always
    # reference them, even when setup itself is what failed. `rss_trusted` needs
    # the same treatment for the `except MemoryError` handler: it is assigned
    # AFTER apply_worker_mem_limit tightens RLIMIT_DATA, so on a reused worker
    # still holding the previous recording's memory the very next allocation --
    # inside reset_peak_rss's own open() -- can raise MemoryError before the name
    # exists. The handler reads it, so that path raised UnboundLocalError and
    # escaped convert_one uncoded, retrying forever: exactly the failure the
    # limit call sits inside the try to prevent (#1110). Default to untrusted,
    # which is correct anyway when the reset never ran.
    work = store_local = memmap_scratch = None
    rss_trusted = False
    try:
        # Backstop this recording before any allocation: exceeding the reservation
        # admission made for it must raise in-process, not take the node down.
        # Inside the try, so a MemoryError during SETUP is typed like any other
        # rather than escaping convert_one uncoded and retrying forever (#1110).
        apply_worker_mem_limit(peak_bytes, c.get("mem_budget"), reserved=True)
        # Reset the high-water mark so what we read at the end belongs to THIS
        # recording and not to whatever this reused worker converted before it.
        # A failed reset means the next reading is this WORKER's lifetime peak
        # across every recording it has handled, not this recording's -- an
        # inflated number that would drive false "under-projected" warnings and,
        # if believed, a pointless factor increase. Mark the sample untrusted
        # rather than blend it into calibration.
        rss_trusted = reset_peak_rss()
        reset_peak_anon()
        if not rss_trusted and not _WARNED_NO_RESET[0]:
            _WARNED_NO_RESET[0] = True
            print(
                "::warning::cannot reset the peak-RSS mark (/proc/self/clear_refs); "
                "peak-RAM measurements are unattributable this run and are being "
                "discarded rather than reported wrong (#1111)",
                flush=True,
            )
        rel_store = store_rel_for(primary)
        work, store_local, memmap_scratch = recording_scratch_paths(c["tmp"], primary)
        os.makedirs(work, exist_ok=True)
        os.makedirs(os.path.dirname(store_local), exist_ok=True)
        if c["local"]:
            primary_local, events_local, primary_key = materialize_local(
                c["repo"], primary, c["head_files"]
            )
        else:
            primary_local, events_local, primary_key = materialize_recording(
                c["repo"], c["bucket"], c["dataset_id"], primary, c["head_files"], c["head"], work
            )
        fdt_decl = (c.get("fdt_declarations") or {}).get(primary)
        if fdt_decl is not None:
            primary_local = stage_declared_fdt(
                fdt_decl, primary, primary_local, work,
                repo=c["repo"], head_files=c["head_files"], head=c["head"],
                local=c["local"], bucket=c.get("bucket"), dataset_id=c.get("dataset_id"),
            )
        # A header that names a data file the tree does not hold has nothing to
        # convert: refuse it typed, by the missing file's name, before a reader's
        # error has to be interpreted (#1801). After the declared-.fdt staging so a
        # reviewed declaration has already been verified, before the MaxShield
        # probe, which reads the file.
        require_companions(
            primary, primary_local, c["head_files"], c["head"], fdt_decl is not None
        )
        # ADR 0028. Substituted HERE rather than inside convert_recording, which
        # derives modality, size and the streaming decision from the path it is given
        # (a late rebind would leave all three describing the unfiltered file). The
        # filtered copy lands in `work`, which the `finally` below already removes,
        # and fix_source_file_attr still rewrites source_file to the BIDS path, so the
        # scratch name never reaches the store.
        sss_meta = None
        if is_maxshield_fif(primary_local):
            pair = maxshield_calibration_for(primary, c["head_files"])
            if pair is None:
                raise MaxShieldUncalibrated(
                    "recording carries raw Internal Active Shielding data and this "
                    "dataset provides no fine-calibration / cross-talk pair for it"
                )
            cal_rel, ctc_rel = pair
            cal_local = os.path.join(work, os.path.basename(cal_rel))
            ctc_local = os.path.join(work, os.path.basename(ctc_rel))
            if c["local"]:
                cal_local = os.path.join(c["repo"], cal_rel)
                ctc_local = os.path.join(c["repo"], ctc_rel)
                # The remote branch below decides cleanly when a tracked file cannot
                # be materialized; local mode has to check for itself. A working tree
                # can hold a git-annex POINTER whose content was never fetched, and
                # `os.path.exists` is False for a dangling symlink -- so this catches
                # the realistic case rather than letting apply_sss fail uncoded and
                # retry the filter on every future run.
                missing = [r for r, p in ((cal_rel, cal_local), (ctc_rel, ctc_local))
                           if not os.path.exists(p)]
                if missing:
                    raise MaxShieldUncalibrated(
                        "calibration input(s) present in the tree but without local "
                        f"content (run `git annex get`): {', '.join(missing)}"
                    )
            else:
                for rel, dest in ((cal_rel, cal_local), (ctc_rel, ctc_local)):
                    found, _ = _fetch_blob(
                        c["repo"], c["bucket"], c["dataset_id"], rel, c["head"], dest
                    )
                    if not found:
                        # Tracked at HEAD but unfetchable. Falling through to serve
                        # the recording unfiltered is exactly what ADR 0028 forbids.
                        raise MaxShieldUncalibrated(
                            f"calibration input {rel!r} is tracked at "
                            f"{c['head'][:8]} but could not be fetched"
                        )
            filtered = os.path.join(work, "sss_" + os.path.basename(primary_local))
            sss_meta = apply_sss(primary_local, cal_local, ctc_local, filtered)
            primary_local = filtered
        plf = power_line_frequency_for(c["repo"], primary, c["head_files"], c["head"])
        descs = event_descriptions_for(c["repo"], primary, c["head_files"], c["head"])
        elec = electrode_positions_for(c["repo"], primary, c["head_files"], c["head"])
        # channels.tsv is git-tracked TEXT (never annexed), so it is read from the
        # repo and staged beside the recording rather than fetched from S3. It is
        # handed to biosigIO so the served samples carry the sidecar's units
        # (biosigio#125); the same resolution already feeds the fidelity gate.
        channels_local = None
        channels_text: str | None = None
        channels_read_failed = False
        channels_rel = channels_tsv_for(primary, c["head_files"])
        if channels_rel:
            channels_text = _read_repo_text(c["repo"], c["head"], channels_rel)
            if channels_text is None:
                # NOT the same as "this dataset ships no channels.tsv". A sidecar
                # that applies is present at HEAD and we failed to read it, so the
                # store is served with importer units and NOTHING on the public
                # surface would say why -- `units_report` is simply absent, which
                # is the same shape as a dataset that has no sidecar at all. The
                # fidelity gate makes the same distinction and warns for the same
                # reason (`expected_channel_count_for`). Recorded on the entry.
                channels_read_failed = True
                print(
                    f"::warning::could not read {channels_rel}; channels.tsv units "
                    f"are NOT applied to {primary}",
                    flush=True,
                )
            else:
                channels_local = os.path.join(work, os.path.basename(channels_rel))
                with open(channels_local, "w", encoding="utf-8") as fh:
                    fh.write(channels_text)
        convert_recording(
            primary_local, events_local, store_local, plf, descs or None, elec,
            mem_budget_bytes=c.get("mem_budget"),
            hard_ceiling_bytes=c.get("hard_ceiling"),
            projected_peak=(c.get("projections") or {}).get(primary),
            channels_local=channels_local,
        )
        # biosigIO stamped recording_metadata.source_file with the name of the
        # scratch file it was handed (only the final component under
        # exclude_subject_info, #1626; `sss_<name>` on the MaxShield path);
        # overwrite it with the stable, reproducible BIDS-repo-relative path
        # before validating/uploading. nemarOrg/nemar-cli#1102.
        fix_source_file_attr(store_local, primary)
        if sss_meta:
            # In the store as well as the index: a consumer reading the store
            # directly (the ML streaming path) must not have to fetch index.json to
            # learn that this signal is a processed derivative.
            embed_root_attr(store_local, "sss", sss_meta)
        # Structured provenance, in the store rather than only in the index
        # (#1064). The population reading these stores is increasingly machine,
        # and a client that has the store has the DOI, license and citation at the
        # moment it needs them. biosigIO's own attributes are untouched.
        embed_root_attr(
            store_local,
            "nemar",
            nemar_store_attrs(
                dataset_id=c["dataset_id"],
                source_commit=c["head"],
                source_tree=source_tree_for(primary),
                derived=bool(sss_meta),
                engine_version=c["engine_version"],
                contract_url=f"{c['contract_base'].rstrip('/')}/{c['dataset_id']}/zarr/{rel_store}/",
                row=c.get("dataset_row"),
                provenance_fetch_failed=bool(c.get("provenance_fetch_failed")),
            ),
        )
        # Guard the --delete sync: an empty/partial store would otherwise wipe a
        # previously-valid one. zarr.json => v3 root.
        validate_store(store_local)
        meta = store_metadata(store_local)
        if not meta.get("groups"):
            # store_metadata swallows its exception and returns {}, so without
            # carrying the reason here the operator sees "no channel groups" (a
            # data problem) while the real cause sits in an uncorrelated warning
            # line somewhere in a multi-megabyte log.
            why = meta.get("_error")
            raise RuntimeError(
                f"store has no channel groups: {store_local}"
                + (f" (reading it failed: {why})" if why else "")
            )
        # Fidelity gate: the file's own header and the BIDS channels.tsv are
        # the two ground truths for how many channels this recording has. A
        # store that comes up short means the importer silently dropped
        # signals (biosigio#110 served 74-channel EEGLAB recordings as 1
        # channel for weeks, nemarDatasets/on002718#1; before biosigio 1.2.9 a
        # repeated EDF label overwrote a channel, nm000110 22 of 23); withhold
        # it as a typed data failure rather than publish an unfaithful copy.
        # The header is read for EVERY recording, not only when a sidecar
        # disagrees: see channel_gate_verdict. Runs BEFORE the sync, so the
        # refused store is never uploaded and this recording's previously
        # published store objects survive untouched, under --clean as on the
        # incremental path (--clean reconciles, it does not wipe: ADR 0023),
        # until a good re-conversion overwrites them. The index lists the
        # recording as a failure instead (see the ChannelCountMismatch
        # docstring, and note a gated recording needs an explicit re-run
        # after a fix).
        expected = expected_channel_count_for(
            c["repo"], primary, c["head_files"], c["head"]
        )
        channel_count_note = enforce_channel_gate(
            primary, store_total_channels(meta), expected,
            file_declared_channel_count(primary_local),
        )
        # The upload, which re-checks this store for subject information on the
        # bytes it uploads (#1626); see `sync_store`.
        sync_store(store_local, safe_store_prefix(c["bucket"], c["dataset_id"], rel_store))
        # `source_key` is deliberately NOT here any more: it moved to the sibling
        # producer manifest in v3 (#1178 item 5). It was ~90 bytes per store that
        # no consumer read -- 2.3 MB of nm000281's 12.8 MB index, fetched on every
        # dataset-page visit.
        entry = {
            "path": primary,
            "zarr": rel_store,
            "updated_utc": c["updated"],
            "source_tree": source_tree_for(primary),
            "derived": bool(sss_meta),
            # `_`-prefixed keys are diagnostics, never published.
            **{k: v for k, v in meta.items() if not k.startswith("_")},
        }
        # Counted from the SAME events.tsv biosigIO was handed, so the numbers
        # describe what is actually in the store (#1059).
        events_text = None
        if events_local and os.path.exists(events_local):
            try:
                with open(events_local, encoding="utf-8", errors="replace") as fh:
                    events_text = fh.read()
            except OSError as exc:
                print(
                    f"::warning::could not re-read {events_local} for the event "
                    f"summary of {primary}: {exc}",
                    flush=True,
                )
        # ONE parse, feeding both the per-store summary published in the index
        # and the rows `main` stages for events.parquet (#1060). The parsed rows
        # travel back with the result rather than being re-read there: the events
        # sidecar may be annexed, and this worker is the only place it is
        # materialized.
        parsed_events = parse_events_tsv(events_text)
        entry.update(events_summary_of(parsed_events))
        # Which channels.tsv shaped this store, and that the converter chose it
        # rather than the exporter stumbling on a sibling. On the MaxShield path
        # the exporter is handed `work/sss_<basename>`, where sibling detection
        # finds nothing, so "a report is present" and "the right sidecar was
        # used" are separate claims and both belong on the public surface.
        if channels_rel and isinstance(entry.get("units_report"), dict):
            entry["units_report"] = {
                **entry["units_report"],
                "sidecar": channels_rel,
                "sidecar_supplied": True,
            }
            # Which store channels the sidecar never reached. biosigIO's own
            # report cannot say: it counts only what matched rows did.
            names = channels_tsv_names(channels_text) if channels_text is not None else None
            if names is not None:
                join = sidecar_join_report(
                    meta.get("_channel_labels") or [], names, meta.get("_label_renames") or {},
                    meta.get("_case_matches") or None,
                )
                entry["units_report"].update(join)
                if join.get("unmatched_channels"):
                    print(
                        f"::warning::{primary}: {channels_rel} names no row for "
                        f"{join['unmatched_channels']} store channel(s) "
                        f"(e.g. {', '.join(join.get('unmatched_examples', []))}), so their "
                        "type and unit are the importer's"
                        + (f"; {join['unmatched_case_only']} differ only in case"
                           if join.get("unmatched_case_only") else "")
                        + (f"; {join['unmatched_raw_label']} are named by the file's "
                           "repeated label rather than the de-duplicated one"
                           if join.get("unmatched_raw_label") else ""),
                        flush=True,
                    )
        if channels_read_failed:
            entry["channels_tsv_read_error"] = True
        if channel_count_note:
            entry["channels_tsv_count_mismatch"] = channel_count_note
        # For a split FIF, record all member source paths so the browser can map any
        # split file (e.g. a click on split-02) to this single head store.
        members = split_members_for(primary, c["head_files"])
        if members:
            entry["split_members"] = members
        # ADR 0028 requires this to be DISCLOSED, not merely auditable. Every other
        # store is the source signal quantized and rate-capped and nothing more; this
        # one has been processed. A model training across datasets would otherwise
        # silently mix filtered and unfiltered MEG with no signal that it was doing
        # so. MNE writes the parameters into the recording's own proc_history, but
        # biosigIO's importer does not carry that into the store, so state it here
        # (and in the store's root attributes) rather than assume it survives.
        if sss_meta:
            entry["sss"] = sss_meta
        return {
            "ok": True,
            "primary": primary,
            "entry": entry,
            # The events.tsv this store was built from, parsed once. `main` turns
            # it into the store's events.parquet rows using the same `groups` it
            # publishes in the entry, so the rates behind `sample_index` are the
            # rates the index states.
            "events": parsed_events,
            # The producer-only half of the entry: which annex blob this store was
            # built from. Published in manifest.json, never in the index.
            "manifest": {
                "zarr": rel_store,
                "source_key": primary_key,
                "size_bytes": annex_key_size(primary_key),
            },
            "peak_rss": peak_rss_bytes() if rss_trusted else None,
            "peak_anon": peak_anon_bytes() if rss_trusted else None,
        }
    except MemoryError as exc:
        # The RLIMIT_DATA backstop fired (or the allocator genuinely ran out).
        # This is the same verdict #909's preflight reaches -- this recording does
        # not fit the memory it was given -- so report it with the same code
        # rather than as a nameless infra failure that retries forever. Reporting
        # it typed also means a dataset made ENTIRELY of such recordings is marked
        # terminal instead of burning its five attempts.
        # Measure here as well: a recording that hit the backstop is the strongest
        # evidence its format is under-projected, and excluding it made the
        # calibration summary look cleanest exactly where it was most wrong.
        log_memory_failure(primary, exc)
        return memory_failure_result(
            primary, exc, peak_rss_bytes() if rss_trusted else None,
            peak_anon_bytes() if rss_trusted else None,
        )
    except Exception as exc:  # noqa: BLE001 - isolate one bad recording
        # The backstop does not always surface as MemoryError: see
        # `is_memory_exhaustion`. Same verdict, same code, same measurement.
        if is_memory_exhaustion(exc):
            log_memory_failure(primary, exc)
            return memory_failure_result(
                primary, exc, peak_rss_bytes() if rss_trusted else None,
                peak_anon_bytes() if rss_trusted else None,
            )
        # biosigIO read failures carry a stable `.code` (not_continuous,
        # corrupt_or_truncated, ...) so the index can tell the viewer WHY a
        # recording has no store. Infra failures (a plain RuntimeError, a crashed
        # worker) have no code -> not surfaced, they retry on the next run.
        #
        # Print the traceback for the uncoded ones before it is lost. This runs in
        # a ProcessPoolExecutor worker, so once the exception is reduced to
        # `str(exc)` for the return value the stack is gone for good, and a NOVEL
        # bug surfaces on an unattended cron as a bare "list index out of range"
        # with no file or line. That is the same undiagnosable shape that left the
        # MaxShield cause unexplained across 396 recordings. Coded failures are
        # already self-explaining and stay quiet, or every derivative in the
        # archive would print a stack.
        #
        # The code is the exception's own, read through `failure_verdict`: a
        # reader that refuses a file without saying why (a generic read error,
        # the MaxShield probe's relabel of MNE, pyedflib's bare OSError out of
        # the streaming exporter) is typed here, by the refusal it reported, and
        # `named` is the better detail it can publish (#1801).
        code, named = failure_verdict(exc, primary, c.get("head_files") or frozenset())
        if code is None:
            import traceback

            print(
                f"::warning::{primary!r} failed with an uncoded error; traceback follows "
                f"so the cause is not reduced to one line:\n{traceback.format_exc()}",
                flush=True,
            )
        return {
            "ok": False,
            "primary": primary,
            "error": str(exc),
            "code": code,
            # Published on the entry (typed) or as `last_error` (pending), which
            # is the only way an uncoded failure says anything at all from
            # outside the conversion node. #1197
            "detail": failure_detail(named or exc),
            # The object storage lacks, so the driver can name it (see
            # `annex_missing_summary`).
            "annex_key": exc.key if isinstance(exc, AnnexObjectMissing) else None,
            # A refusal to write or upload a store that may carry subject
            # information (#1626): a property of the process that converted, so
            # `main` turns a run whose every failure is one into the node-level
            # exit instead of a dataset failure (`subject_info_refused_run`).
            "subject_info_refused": isinstance(exc, SubjectInfoExclusionUnavailable),
        }
    finally:
        # Parallel workers share the NVMe scratch; reclaim each recording's copy
        # right after upload so N concurrent stores don't accumulate on disk.
        for d in (store_local, memmap_scratch, work):
            if d:
                for failure in remove_scratch_tree(d):
                    print(f"::error::could not remove scratch {failure}", flush=True)


# How often a drain re-evaluates admission while nothing finishes (#1483). A
# drain used to sleep until a recording completed, so memory freed by another
# tenant went unused until then, and a large recording could hold the queue for
# an hour. `wait` now returns at least this often and admission is re-read.
ADMISSION_RECHECK_SECONDS = float(os.environ.get("ZARR_ADMISSION_RECHECK_SECONDS", "15"))


# How many memory-budget failures one run retries serially at its end (#1483).
# Each retry runs ALONE, so a dataset where most recordings trip the budget
# would otherwise turn a parallel run into a serial one; past this many, the
# rest go to the next retry round as before.
MEMORY_RETRY_MAX = int(os.environ.get("ZARR_MEMORY_RETRY_MAX", "64"))


def _gib(n: float) -> str:
    return f"{n / 1024**3:.1f}" if n < 10 * 1024**3 else f"{n / 1024**3:.0f}"


def deferral_message(charge: int, budget: int) -> str:
    """What the index's ``last_error`` says about a deferred recording."""
    return f"deferred: needs {_gib(charge)} GiB of scratch, {_gib(budget)} GiB available"


# --- Admission across drivers (ADR 0101) -----------------------------------------
# How long a driver with nothing in flight waits, held up only by what its peers have
# reserved, before it hands its queue back and lets this slot move to another
# dataset. Longer than the ledger's starvation threshold on purpose: the driver that
# has waited longest is let in first, and only a wait that outlives that priority
# is given up.
LEDGER_WAIT_SECONDS = _scratch_setting_or_default("ZARR_LEDGER_WAIT_SECONDS", 3600.0, minimum=0.0)

# Constant text, no counts: the index is left untouched when a run defers everything it
# was asked to and the index already carries a note starting with ``deferred:``, so a
# note that changed every tick would rewrite the index every tick.
PEER_DEFERRAL_MESSAGE = (
    "deferred: the node's memory and scratch are reserved by other conversions; "
    "retried automatically"
)
LEDGER_UNUSABLE_MESSAGE = (
    "deferred: the node's admission ledger could not be used; retried automatically"
)


def ledger_from_env() -> Ledger | None:
    """The shared admission ledger named by ``ZARR_LEDGER_DIR``, or None to admit
    against this driver's own measurements alone (the behavior before ADR 0101, and
    the right one when this is the only driver on the node)."""
    root = os.environ.get("ZARR_LEDGER_DIR", "").strip()
    if not root:
        return None
    try:
        return Ledger(root)
    except OSError as exc:
        print(
            f"::error::cannot use the admission ledger at {root} ({exc}); this driver "
            "admits without regard to other conversions on the node, which can "
            "overcommit it when several run at once",
            flush=True,
        )
        return None


def converts_in_process(cpu_cap: int, ledger: Ledger | None, convert: list) -> bool:
    """Whether the recordings are converted in this process (``--jobs 1`` with no
    ledger, or nothing to convert) rather than through the pool."""
    return (cpu_cap == 1 and ledger is None) or not convert


def close_ledger(ledger: Ledger | None) -> None:
    """Withdraw this driver from the ledger. Best effort: a peer prunes the file of a
    driver that is gone, so failing to remove it costs a few seconds of stale
    reservations, never correctness."""
    if ledger is None:
        return
    try:
        with ledger.exclusive():
            ledger.close()
    except (LedgerBusy, OSError) as exc:
        print(f"::warning::could not withdraw from the admission ledger: {exc}", flush=True)


def _ledger_held(paths: list[str]) -> int:
    return sum(allocated_bytes(path) for path in paths)


def defer_for_peers(
    queue, sink, waited_seconds: float, unusable: bool = False, cause: str = ""
) -> None:
    """Hand ``queue`` back unreported: it fits this node, but other conversions on it
    hold what it needs (or, with ``unusable``, the ledger that says what they hold could
    not be used for as long). The scratch deferral's sibling (``defer_unfit``) and
    recorded the same way, so the recordings stay pending, spend no attempt, and are
    retried at the shortest delay."""
    for primary in queue:
        if sink is not None:
            sink[primary] = LEDGER_UNUSABLE_MESSAGE if unusable else PEER_DEFERRAL_MESSAGE
    why = (
        "the admission ledger could not be used" + (f" ({cause})" if cause else "")
        if unusable
        else "memory and scratch that other conversions on this node had reserved"
    )
    print(
        f"::warning::deferring {len(queue)} recording(s): waited "
        f"{waited_seconds / 60:.0f} min; {why}; they stay pending without spending "
        "an attempt",
        flush=True,
    )


def defer_unfit(queue, scratch_peaks, budget, volume, sink) -> None:
    """Hand ``queue`` back unreported: nothing is running, and none of it fits.

    One line per recording names it, its charge, the budget, and the volume's free
    and total space. A recording whose charge exceeds the whole volume minus
    headroom can NEVER fit however long it waits: that is an ``::error::`` telling
    the operator the node needs more scratch, not a note that a tick was busy.
    ``sink`` (a dict, or None) receives ``{recording: last_error message}``."""
    free_total = volume() if volume else None
    ceiling = None if free_total is None else max(0, free_total[1] - SCRATCH_HEADROOM_BYTES)
    shown = 0
    never = 0
    for primary in queue:
        charge = scratch_peaks.get(primary, SCRATCH_UNKNOWN_SIZE_BYTES)
        message = deferral_message(charge, budget)
        if sink is not None:
            sink[primary] = message
        impossible = ceiling is not None and charge > ceiling
        never += impossible
        if shown >= SCRATCH_DEFER_LOG_LINES:
            continue
        shown += 1
        where = (
            f", free {_gib(free_total[0])} of {_gib(free_total[1])} GiB"
            if free_total else ""
        )
        if impossible:
            print(
                f"::error::{primary} can never fit this volume: charged {_gib(charge)} GiB, "
                f"the volume holds {_gib(free_total[1])} GiB with "  # type: ignore[index]
                f"{_gib(SCRATCH_HEADROOM_BYTES)} GiB of headroom; it needs more scratch, "
                "or a lower ZARR_SCRATCH_STREAM_FACTOR if the charge is too high",
                flush=True,
            )
        else:
            print(
                f"::warning::deferring {primary}: charged {_gib(charge)} GiB, "
                f"budget {_gib(budget)} GiB{where}",
                flush=True,
            )
    if len(queue) > shown:
        print(
            f"::warning::{len(queue) - shown} more deferred recording(s) not listed here; "
            "the index names them all",
            flush=True,
        )
    print(
        f"::warning::deferred {len(queue)} recording(s) that do not fit the scratch disk"
        + (f" ({never} can never fit this volume)" if never else "")
        + "; they stay pending without spending an attempt",
        flush=True,
    )


def drain_serially(
    convert, scratch_peaks, scratch_budget, scratch_volume, deferred, run_one, record
) -> None:
    """The ``--jobs 1`` drain: one recording at a time, in this process, each only if
    it fits. First fit, like the pool's admission, so a giant at the head does not
    hold smaller recordings behind it; a recording that fits nothing after the
    re-samples (see ``SCRATCH_DEFER_RESAMPLES``) is deferred with the rest."""
    queue = list(convert)
    done = 0

    def pick(budget: int) -> int | None:
        return next(
            (j for j, p in enumerate(queue)
             if scratch_peaks.get(p, SCRATCH_UNKNOWN_SIZE_BYTES) <= budget),
            None,
        )

    while queue:
        budget = scratch_budget(())
        idx = pick(budget)
        for _ in range(SCRATCH_DEFER_RESAMPLES if idx is None else 0):
            time.sleep(ADMISSION_RECHECK_SECONDS)
            budget = scratch_budget(())
            idx = pick(budget)
            if idx is not None:
                break
        if idx is None:
            defer_unfit(queue, scratch_peaks, budget, scratch_volume, deferred)
            return
        p = queue.pop(idx)
        done += 1
        record(run_one(p), done)


def _next_admission(
    pending_peaks: list[int], in_flight_count: int, running_peak: int,
    cpu_cap: int, ram_ceiling: int,
    *, pending_scratch: list[int] | None = None, running_scratch: int = 0,
    scratch_budget: int | None = None, others_in_flight: bool = False,
) -> int | None:
    """Index into ``pending_peaks`` of the next recording to dispatch, or ``None``
    to wait for a running one to finish. Admittable when a worker slot is free AND
    either nothing is in flight (it runs alone, guaranteeing progress) or it fits
    the remaining RAM ceiling, AND (when scratch is gated) it fits the scratch
    budget. Picks the first pending recording that fits, so a head-of-line giant
    doesn't starve smaller ones behind it.

    The run-alone exception is RAM's only. Memory a recording cannot fit is
    reported by the worker's own preflight, but a recording that does not fit the
    disk would spend hours downloading before it hit ENOSPC, so scratch is checked
    even when nothing is in flight: a ``None`` with nothing running means what is
    left cannot be admitted at all (see ``_drain_with_admission``).

    With ``others_in_flight`` (another driver on this node holds a reservation) the
    run-alone exception is withdrawn: this driver being idle does not make the NODE
    idle, and several drivers each running a recording that does not fit would be the
    overcommit the ledger exists to prevent. The recording waits instead."""
    if in_flight_count >= cpu_cap:
        return None
    idle = in_flight_count == 0 and not others_in_flight
    gated = pending_scratch is not None and scratch_budget is not None

    def fits_scratch(j: int) -> bool:
        if not gated:
            return True
        needed = running_scratch + pending_scratch[j]  # type: ignore[index]
        return needed <= scratch_budget  # type: ignore[operator]

    return next(
        (j for j, pk in enumerate(pending_peaks)
         if (idle or running_peak + pk <= ram_ceiling) and fits_scratch(j)),
        None,
    )


def _drain_with_admission(
    convert, peaks, cpu_cap, ram_ceiling, ctx, record, worker=None, memory_retry=None,
    ceiling=None, scratch_peaks=None, scratch_budget=None, deferred=None,
    scratch_volume=None, ledger=None,
) -> tuple[int, int]:
    """Run ``convert_one`` over ``convert`` in a pool of up to ``cpu_cap`` workers,
    dispatching a recording only while the SUM of in-flight projected peaks stays
    within ``ram_ceiling`` (see ``_next_admission``). Results are reported via
    ``record(r, i)`` in completion order.

    A worker that dies (OOM kill, segfault) poisons the whole
    ``ProcessPoolExecutor``: every subsequent ``submit`` raises
    ``BrokenProcessPool``, so before #1110 one kill aborted the run and abandoned
    everything still queued -- on004998 converted 74 of 115 and lost the
    remaining 41, none of which had anything to do with the memory pressure, and
    the log carries 96 such aborts.

    Recovery is two-pass, because when a pool breaks you cannot tell WHICH of the
    in-flight recordings killed it:

    1. Parallel pass over the queue. On a break, the in-flight recordings are set
       aside as suspects and the executor is rebuilt to drain the rest.
    2. Serial pass over the suspects, one worker. A recording that dies here was
       running alone, so it is provably the culprit and only it is reported
       failed; every innocent suspect converts normally.

    Retrying suspects in PARALLEL instead would be wrong: the culprit kills the
    pool again, and an innocent recording that happened to be in flight for both
    breaks gets blamed. That is not hypothetical -- the tests caught exactly it.

    3. Serial memory retry (#1483), when ``memory_retry`` is given. A recording
       that failed with a retryable memory code (``RETRYABLE_CODES``) is held
       back instead of reported. Once the passes above are done, the node's RAM
       is no longer shared with the parallel pass, so ``memory_retry()`` is
       called ONCE, then, and returns ``(retry_ctx, retry_peak)``: the worker
       context and the per-recording reserve to retry with, read at that moment.
       Each held recording whose original reserve was below ``retry_peak`` is
       re-run alone with it, up to ``MEMORY_RETRY_MAX``; the rest are reported as
       they failed. Before this, such a failure waited 1h-7d for a retry round
       that rebuilt the whole dataset under the same budget and mostly failed the
       same way.

    Admission is re-evaluated against ``ceiling(running_peak, track_dir)``, by
    default `live_admission_ceiling` over this node's /proc with ``ram_ceiling``
    as its off-Linux fallback, whenever a recording finishes and at least every
    ``ADMISSION_RECHECK_SECONDS`` otherwise (#1483).

    Scratch disk is admitted the same way when ``scratch_peaks`` (primary ->
    projected peak bytes) is given: a recording is dispatched only while the sum
    of in-flight scratch peaks plus its own fits ``scratch_budget(in_flight)``
    (default: a `ScratchGate` over ``ctx["tmp"]``, which is handed the in-flight
    primaries so it can count what they hold). Unlike RAM there is no run-alone
    exception: a recording that does not fit while nothing is in flight can never
    be admitted this run, so it is handed back in ``deferred`` (a dict of
    recording -> the `last_error` text the index will carry) UNREPORTED. Before
    that, admission looks at the volume again ``SCRATCH_DEFER_RESAMPLES`` times,
    since one sample can land in someone else's spike. A memory-failed recording
    held for the serial retry that cannot fit there is reported as the memory
    failure it was, not deferred.

    ``ledger`` (an ``admission_ledger.Ledger``) makes the node shared: before
    admitting, the RAM ceiling and the scratch budget are reduced by what the OTHER
    drivers on it have reserved and not yet taken, the run-alone exception applies
    only when no other driver holds anything, and every admission is recorded for
    them to read. Deciding and recording happen under the ledger's lock, so two
    drivers cannot both admit into the same free space. A recording this driver
    could run if it had the node to itself waits for its peers (and goes first once
    it has waited longest); after ``LEDGER_WAIT_SECONDS`` of nothing else to do it is
    handed back like a scratch deferral, so the slot can take another dataset. With
    no ledger, nothing here applies.
    """
    worker = worker or convert_one
    if ceiling is None:
        hard = ctx.get("hard_ceiling")

        def ceiling(running_peak: int, track_dir: str | None) -> int:
            return live_admission_ceiling(ram_ceiling, hard, running_peak, track_dir)
    if scratch_peaks is not None and scratch_budget is None and ctx.get("tmp"):
        scratch_budget = ScratchGate(ctx["tmp"])
    volume = scratch_volume or (
        ScratchGate(ctx["tmp"]).volume if ctx.get("tmp") else None
    )
    done = 0
    pool_breaks = 0
    held: list[dict] = []  # memory failures awaiting the serial retry
    retried: set = set()
    recovered = 0

    def report(r: dict) -> None:
        nonlocal done, recovered
        p = r.get("primary")
        if (
            memory_retry is not None
            and not r.get("ok")
            and r.get("code") in RETRYABLE_CODES
            and p not in retried
        ):
            held.append(r)
            return
        if p in retried and r.get("ok"):
            recovered += 1
        done += 1
        record(r, done)

    def drain_once(
        queue: list, cap: int, run_ctx=None, run_peaks=None, defer_to=None
    ) -> list:
        """Drain ``queue`` (mutated in place) with up to ``cap`` workers until it
        is empty or the pool breaks. Returns the recordings that were in flight
        at the moment of the break -- empty when the pass completed cleanly."""
        nonlocal pool_breaks
        run_ctx = ctx if run_ctx is None else run_ctx
        run_peaks = peaks if run_peaks is None else run_peaks
        in_flight: dict = {}
        tokens: dict = {}  # future -> its ledger reservation
        running_peak = 0
        # One pass observes at most one pool death, but it can surface twice (a
        # future resolving with BrokenProcessPool, and again from `submit`). Latch
        # it so the count is events, not observations -- `max(pool_breaks, 1)`
        # previously absorbed a genuine SECOND break in a later pass.
        broke = False
        # Recordings whose future resolved with the pool's death rather than a
        # fault of their own. They are suspects, not failures: when a pool dies
        # EVERY outstanding future raises BrokenProcessPool, so reporting them
        # here would blame each in-flight sibling for the one crash.
        broken: list = []

        def ledger_io(call, *args, **kwargs):
            """A ledger read or write whose I/O failure means only that the ledger cannot
            be used this round. Narrow on purpose: the pool's own errors (``ex.submit``
            failing to fork a worker) are not the ledger's and must propagate."""
            try:
                return call(*args, **kwargs)
            except OSError as exc:
                raise LedgerBusy(f"admission ledger I/O failed: {exc}") from exc

        def ledger_paths(primary: str) -> list[str]:
            tmp = run_ctx.get("tmp")
            if not tmp:
                return []
            try:
                return list(recording_scratch_paths(tmp, primary))
            except ValueError:
                return []  # a path that cannot be ours holds nothing of ours

        def admit() -> bool:
            """Dispatch what fits. True when, with the ledger, this driver has nothing
            in flight and is held up only by its peers, so the caller waits and looks
            again; False otherwise."""
            nonlocal running_peak
            # Read once per round, not per recording admitted: what this round
            # submits has not started, so it earns no credit and the ceiling
            # cannot move because of it. No slot, no read.
            limit: int | None = None
            budget: int | None = None
            # The same two figures before the peers' reserves come off, to tell a
            # recording that waits for them from one that would not fit alone.
            limit_alone: int | None = None
            budget_alone: int | None = None
            peers_busy = False
            yield_to_peer = False
            gated = scratch_peaks is not None and scratch_budget is not None
            blockers: frozenset[int] = frozenset()

            def read_scratch() -> int | None:
                return scratch_budget([p for p, _ in in_flight.values()]) if gated else None

            def look() -> None:
                nonlocal limit, budget, limit_alone, budget_alone, peers_busy
                nonlocal yield_to_peer, blockers
                limit = ceiling(running_peak, track_dir)
                budget = read_scratch()
                limit_alone, budget_alone = limit, budget
                if ledger is None:
                    return
                summary = ledger_io(ledger.others_summary, tracked_taken_bytes, _ledger_held)
                blockers = summary.pids
                peers_busy = bool(summary.pids)
                yield_to_peer = ledger_io(ledger.older_peer_waiting)
                limit = max(0, limit - summary.ram)
                if budget is not None:
                    # Free space already excludes what the peers have written. Were they
                    # not there it would include it, which is what "alone" is judged on:
                    # a recording is held up by its peers (and waits) when it would fit
                    # without them, and does not fit the volume at all otherwise. Built
                    # from the budget before it was raised to zero, so a volume the
                    # peers have filled is not credited the headroom as well.
                    raw = getattr(scratch_budget, "last_raw", None)
                    base = budget if raw is None else raw
                    budget_alone = max(0, base + summary.held)
                    budget = max(0, budget - summary.scratch)

            def pick(alone: bool = False) -> int | None:
                if yield_to_peer and not alone:
                    return None
                lim = limit_alone if alone else limit
                bud = budget_alone if alone else budget
                running_scratch = (
                    sum(
                        scratch_peaks.get(q, SCRATCH_UNKNOWN_SIZE_BYTES)
                        for q, _ in in_flight.values()
                    )
                    if bud is not None else 0
                )
                return _next_admission(
                    [run_peaks[p] for p in queue], len(in_flight), running_peak,
                    cap, lim,  # type: ignore[arg-type]
                    pending_scratch=(
                        [scratch_peaks.get(p, SCRATCH_UNKNOWN_SIZE_BYTES) for p in queue]
                        if bud is not None else None
                    ),
                    running_scratch=running_scratch, scratch_budget=bud,
                    others_in_flight=peers_busy and not alone,
                )

            def held_up_by_peers() -> bool:
                """Nothing of ours is running, and the first thing that fits the node
                alone does not fit it with the others on it."""
                return (
                    ledger is not None and not in_flight and bool(queue)
                    and pick(alone=True) is not None
                )

            def pause() -> None:
                if ledger is not None:
                    ledger_io(ledger.sleep_unlocked, ADMISSION_RECHECK_SECONDS)
                else:
                    time.sleep(ADMISSION_RECHECK_SECONDS)

            while queue and len(in_flight) < cap:
                if limit is None:
                    look()
                idx = pick()
                if idx is None and held_up_by_peers():
                    last_blockers[0] = blockers
                    return True
                if idx is None and not in_flight and budget is not None:
                    # Nothing running will give scratch back, so one more sample is
                    # the only thing that can change the answer. A single statvfs
                    # can land in another tenant's transient spike; look again a
                    # few times, `ADMISSION_RECHECK_SECONDS` apart, before
                    # deferring everything that is left.
                    for _ in range(SCRATCH_DEFER_RESAMPLES):
                        pause()
                        look()
                        idx = pick()
                        if idx is not None:
                            break
                        if held_up_by_peers():
                            last_blockers[0] = blockers
                            return True
                if idx is None:
                    if not in_flight and queue and budget is not None:
                        # Handed back, not reported: see the docstring.
                        defer_unfit(
                            queue, scratch_peaks,
                            budget if budget_alone is None else budget_alone, volume,
                            deferred if defer_to is None else defer_to,
                        )
                        queue.clear()
                    break
                # Submit BEFORE popping. `ex.submit` is exactly where a broken
                # pool surfaces, and popping first would leave the recording in
                # neither the queue nor in_flight -- silently dropped, which is
                # the very failure this recovery exists to prevent.
                p = queue[idx]
                fut = ex.submit(_tracked_call, worker, p, run_peaks[p], track_dir)
                queue.pop(idx)
                in_flight[fut] = (p, run_peaks[p])
                running_peak += run_peaks[p]
                if ledger is not None:
                    tokens[fut] = ledger.reserve(
                        run_peaks[p],
                        scratch_peaks.get(p, SCRATCH_UNKNOWN_SIZE_BYTES)
                        if scratch_peaks is not None else 0,
                        ledger_paths(p),
                    )
                    if ledger.publish_error is not None:
                        # The recording runs, but the others cannot read that it does.
                        # Admit nothing more this round, and say why once.
                        note_ledger_problem(ledger.publish_error)
                        break
            return False

        # Which drivers the last ``admit`` found holding what this one waits for.
        last_blockers: list[frozenset[int]] = [frozenset()]
        last_problem: list[str] = [""]

        def note_ledger_problem(exc: BaseException) -> None:
            """Remember why the ledger could not be used, and say so the first time."""
            text = str(exc) or type(exc).__name__
            if text != last_problem[0]:
                last_problem[0] = text
                print(
                    f"::warning::the admission ledger cannot be used ({text}); this driver "
                    "admits nothing new until it can, and keeps what is running",
                    flush=True,
                )

        def admit_round() -> None:
            """``admit`` under the ledger's lock, waiting out the other drivers.

            A round that cannot see the ledger (the lock is not had in time, or a read or
            write of it fails: a full volume does that) admits nothing and leaves what is
            running alone; it does not end the drain. With nothing running, a driver that
            is held up by its peers, or cannot use the ledger, waits and looks again, and
            gives its queue back after ``LEDGER_WAIT_SECONDS`` of it. Only the ledger's
            own failures are caught: whatever the pool raises goes on up."""
            if ledger is None:
                admit()
                return
            blocked_since: float | None = None
            while True:
                waiting = unusable = False
                try:
                    ledger.acquire()
                except (LedgerBusy, OSError) as exc:
                    note_ledger_problem(exc)
                    unusable = True
                else:
                    try:
                        ledger_io(ledger.flush)
                        ledger_io(ledger.set_track_dir, track_dir)
                        waiting = admit()
                        ledger_io(ledger.mark_waiting, waiting, blocked_by=set(last_blockers[0]))
                        last_problem[0] = ""  # worked: a later failure is news again
                    except LedgerBusy as exc:
                        # Lost the lock during a pause and could not take it back, or
                        # could not read or write the ledger.
                        note_ledger_problem(exc)
                        unusable = True
                    finally:
                        ledger.unlock()
                if in_flight or not queue or not (waiting or unusable):
                    return  # something is running, or nothing is left, or all is admitted
                now = time.monotonic()
                blocked_since = now if blocked_since is None else blocked_since
                waited = now - blocked_since
                if waited >= LEDGER_WAIT_SECONDS:
                    defer_for_peers(
                        queue, deferred if defer_to is None else defer_to, waited,
                        unusable=unusable and not waiting, cause=last_problem[0],
                    )
                    queue.clear()
                    # Forget the wait in memory whether or not the lock can be had to say
                    # so: a later pass of this drain (the suspects, the memory retry) must
                    # not inherit its clock and look hours old.
                    ledger.stop_waiting()
                    with contextlib.suppress(LedgerBusy, OSError), ledger.exclusive():
                        ledger.flush()
                    return
                time.sleep(ADMISSION_RECHECK_SECONDS)

        track_dir = tempfile.mkdtemp(prefix="zarr-admission-")
        try:
            with ProcessPoolExecutor(
                max_workers=cap, initializer=_init_worker, initargs=(run_ctx,)
            ) as ex:
                admit_round()
                while in_flight:
                    finished, _ = wait(
                        list(in_flight),
                        timeout=ADMISSION_RECHECK_SECONDS,
                        return_when=FIRST_COMPLETED,
                    )
                    for fut in finished:
                        p, peak = in_flight.pop(fut)
                        running_peak -= peak
                        if ledger is not None:
                            ledger.release(tokens.pop(fut, 0))
                        try:
                            r = fut.result()
                        except BrokenProcessPool:
                            broken.append(p)
                            continue
                        except Exception as exc:  # noqa: BLE001 - this worker died
                            r = {
                                "ok": False,
                                "primary": p,
                                "error": f"worker crashed: {exc}",
                                "detail": failure_detail(exc),
                            }
                        report(r)
                    admit_round()
        except BrokenProcessPool:
            broke = True
        finally:
            shutil.rmtree(track_dir, ignore_errors=True)
            if ledger is not None:
                # Whatever is still reserved belongs to workers that are gone (the
                # pool is shut down by now), and the track directory just removed
                # was the one the ledger pointed peers at.
                ledger.release_all()
                try:
                    with ledger.exclusive():
                        ledger.set_track_dir(None)
                        ledger.flush()
                except (LedgerBusy, OSError):
                    # The next write publishes it; peers see more reserved until then.
                    # Nothing here may raise: this runs on the way out of a failed pass,
                    # before the scratch it left behind is reclaimed.
                    pass
        suspects_now = broken + [p for p, _peak in in_flight.values()]
        if broke or broken:
            pool_breaks += 1
            # The executor was shut down above, so every worker is gone and nothing
            # can still be writing. A killed worker never ran `convert_one`'s
            # `finally`, so its raw download and memmaps are still on scratch, and
            # the rebuilt pool would inherit that disk. Reclaim them BEFORE the
            # suspects re-run and the rest of the queue drains.
            tmp_root = run_ctx.get("tmp")
            if tmp_root and suspects_now:
                reclaim_after_pool_break(tmp_root, suspects_now, volume)
        return suspects_now

    pending = list(convert)
    suspects: list = []
    # How many recordings the parallel pass ever had to set aside at once. Tests
    # need this to tell "a sibling really was caught in the crossfire" from "only
    # the culprit was in flight" -- `pool_breaks` cannot, because the serial
    # confirmation pass always breaks too, pinning it at 2 either way.
    max_suspects_at_once = 0
    while pending:
        batch = drain_once(pending, cpu_cap)
        max_suspects_at_once = max(max_suspects_at_once, len(batch))
        suspects.extend(batch)

    if suspects:
        print(
            f"::warning::worker pool broke; re-running {len(suspects)} in-flight "
            "recording(s) one at a time to find the culprit",
            flush=True,
        )
    killed = ("killed its worker process while running alone "
              "(out of memory, a full scratch disk, or a native crash in the reader)")
    while suspects:
        culprits = drain_once(suspects, 1)
        # cap=1, so at most one recording was in flight: it died running alone.
        for p in culprits:
            report({
                "ok": False,
                "primary": p,
                "error": killed,
                "detail": failure_detail(killed),
            })

    if held:
        retry_ctx, retry_peak = memory_retry()
        eligible = [r for r in held if retry_peak > peaks[r["primary"]]]
        to_retry = eligible[:MEMORY_RETRY_MAX]
        retry_set = {r["primary"] for r in to_retry}
        for r in held:
            if r["primary"] not in retry_set:
                retried.add(r["primary"])  # final: report, never hold again
                report(r)
        if to_retry:
            print(
                f"::warning::retrying {len(to_retry)} recording(s) that exceeded their "
                f"memory budget, one at a time with ~{retry_peak / 1024**3:.1f} GiB each"
                + (f" ({len(eligible) - len(to_retry)} more left for the next round)"
                   if len(eligible) > len(to_retry) else ""),
                flush=True,
            )
            queue = [r["primary"] for r in to_retry]
            retried.update(queue)
            retry_peaks = {p: retry_peak for p in queue}
            held_result = {r["primary"]: r for r in to_retry}
            # A recording the retry cannot fit on scratch is not "not attempted": it
            # WAS attempted and failed its memory budget. Reported as that failure,
            # not left to be filed as untouched by the index's coverage balance.
            retry_deferred: dict[str, str] = {}
            while queue:
                for p in drain_once(
                    queue, 1, run_ctx=retry_ctx, run_peaks=retry_peaks, defer_to=retry_deferred
                ):
                    report({
                        "ok": False,
                        "primary": p,
                        "error": killed,
                        "detail": failure_detail(killed),
                    })
            for p in retry_deferred:
                report(held_result[p])
            print(
                f"[zarr] memory retry: {recovered} of {len(to_retry)} converted when "
                "given the node alone",
                flush=True,
            )

    if pool_breaks:
        # ::warning:: not [zarr]: on the cron this lands in a multi-megabyte plain
        # log with no annotation parsing, so chronic node pressure needs to look
        # different from routine progress. It is also reported in the callback.
        print(
            f"::warning::recovered from {pool_breaks} worker-pool break(s); the run "
            "continued instead of abandoning its queue, but a worker being killed "
            "means the node is under memory pressure (#1110)",
            flush=True,
        )
    return pool_breaks, max_suspects_at_once


def admission_size_info(
    repo: str,
    convert: list[str],
    head_set: set[str],
    head: str,
    fdt_declarations: dict[str, FdtDeclaration],
) -> dict[str, tuple[int, bool]]:
    """``{recording: (bytes, readable)}`` admission projects from: its
    pointer-walked file set, plus a declared `.fdt`'s size. The declared `.fdt`
    lives outside the recording's directory, so the pointer walk cannot see it,
    and without the addition a multi-GB in-memory `.set` read is projected as a few
    tens of MB. One walk serves both the size and whether it can be trusted."""
    info: dict[str, tuple[int, bool]] = {}
    for p in convert:
        size, readable = recording_size_info(repo, p, head_set, head)
        if p in fdt_declarations:
            size += fdt_declarations[p]["fdt_bytes"]
        info[p] = (size, readable)
    return info


def admission_sizes(
    repo: str,
    convert: list[str],
    head_set: set[str],
    head: str,
    fdt_declarations: dict[str, FdtDeclaration],
) -> dict[str, int]:
    """On-disk bytes admission projects each recording from; see
    ``admission_size_info``."""
    return {
        p: size
        for p, (size, _readable) in admission_size_info(
            repo, convert, head_set, head, fdt_declarations
        ).items()
    }


def memory_retry_context(ctx: dict) -> tuple[dict, int]:
    """The worker context for the serial memory retry (#1483): the run's own
    context, every key carried (the `.fdt` declarations included), with the
    budget re-read now. The retry runs alone after the parallel pass, so it may
    have the whole usable node, never past the hardware ceiling."""
    budget = per_recording_ceiling_bytes()
    if ctx["hard_ceiling"]:
        budget = min(budget, ctx["hard_ceiling"])
    return {**ctx, "mem_budget": budget}, budget


def scratch_settings_message() -> str:
    """The one line that names every invalid ``ZARR_SCRATCH_*`` setting."""
    return "invalid scratch setting: " + "; ".join(SCRATCH_SETTING_ERRORS)


def check_env() -> int:
    """``--check-env``: 0 when the scratch settings are valid, else 1 with the message
    printed. Takes no dataset, repository or callback, so it can run once ahead of the
    whole drain."""
    if SCRATCH_SETTING_ERRORS:
        print(f"::error::{scratch_settings_message()}", flush=True)
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate NEMAR Zarr serving copies")
    ap.add_argument("--dataset-id", required=True)
    ap.add_argument("--repo-dir", required=True, help="cloned dataset repo (full history)")
    ap.add_argument("--bucket", default="nemar")
    ap.add_argument("--region", default="us-east-2")
    ap.add_argument("--full", action="store_true", help="convert every recording")
    ap.add_argument(
        "--clean",
        action="store_true",
        help="full-rebuild every recording and rewrite the index fresh (no merge). "
        "Each store is uploaded with `aws s3 sync --delete`, so its contents are "
        "reconciled exactly; stores for recordings no longer at HEAD are removed "
        "afterwards. Does NOT erase the serving prefix up front -- see --wipe. "
        "Implies --full.",
    )
    ap.add_argument(
        "--retry-pending",
        action="store_true",
        help="a pending-driven retry round (#1483): when the published index was "
        "built from this HEAD by this engine and biosigIO, with the same dataset "
        "provenance, convert only the recordings it lists as pending and merge "
        "them into it. Otherwise ignored, and --clean applies as given.",
    )
    ap.add_argument(
        "--wipe",
        action="store_true",
        help="erase s3://<bucket>/<id>/zarr/ before rebuilding. Recovery only (a "
        "corrupt prefix, or an index that no longer describes what is on S3): it "
        "destroys the serving copy before the replacement exists, so the dataset "
        "has no viewer for the length of the run. Use with --clean.",
    )
    ap.add_argument(
        "--local",
        action="store_true",
        help="read recordings from the local working tree (annex content present, "
        "e.g. on Hallu after `nemar dataset download`) instead of downloading the "
        "annex blobs from S3",
    )
    ap.add_argument(
        "--contract-base",
        default=DEFAULT_CONTRACT_BASE,
        help="the STABLE base URL clients may hardcode, published as the index's "
        "`contract_base` (<base>/<id>/zarr/) and as each store's `contract_url`. "
        f"Default {DEFAULT_CONTRACT_BASE}; the --test Hallu instance passes its own "
        "host so a test index never advertises the production one.",
    )
    ap.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        help="catalog to read this dataset's DOI / license / HED version from, "
        "once per run, for the stores' structured `nemar` provenance attribute "
        f"(#1064). Default {DEFAULT_API_BASE}. Best-effort: an unreachable catalog "
        "warns and leaves those fields null.",
    )
    ap.add_argument("--callback-out", required=True, help="write the zarr-ready body here")
    ap.add_argument(
        "--jobs",
        type=int,
        default=1,
        help="convert this many recordings in parallel (ProcessPoolExecutor). "
        "Default 1 (serial). The Hallu cron raises it; cap to keep N concurrent "
        "multi-GB recordings within local scratch + RAM.",
    )
    ap.add_argument(
        "--check-env",
        action="store_true",
        help="validate the ZARR_SCRATCH_* settings and exit (0 valid, 1 invalid, with "
        "the message). Needs no other argument; hallu-zarr.sh runs it once before "
        "dispatching any dataset.",
    )
    if "--check-env" in sys.argv[1:]:
        return check_env()
    args = ap.parse_args()

    if SCRATCH_SETTING_ERRORS:
        # Refused here, not at import, so the failure is REPORTED: the callback is
        # how an operator learns why every dataset stopped converting. (The Hallu
        # driver script checks once up front with --check-env, so in production this
        # only fires for a run started by hand.)
        message = scratch_settings_message()
        print(f"::error::{message}", flush=True)
        with open(args.callback_out, "w") as fh:
            json.dump(
                {
                    "dataset_id": args.dataset_id,
                    "status": "failed",
                    "errors": 1,
                    "failed": [],
                    "deterministic": False,
                    "error": message,
                },
                fh,
            )
        return 1

    dataset_id = args.dataset_id
    bucket = args.bucket
    repo = args.repo_dir
    head = _run(["git", "-C", repo, "rev-parse", "HEAD"]).strip()
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # --clean rebuilds every recording from scratch: no diff, and the index is
    # rewritten fresh (no carry-forward of stale entries) rather than merged.
    # The prior index is still READ -- purely to find orphaned stores below, not
    # to seed the merge or the diff.
    #
    # Read ONCE, with the ETag, whichever branch wants the document: that ETag is
    # what the publish below writes back under `--if-match`, so it has to belong
    # to the exact body this run merged from. `--clean` needs it too -- the merge
    # is handed `prior=None`, but the OBJECT still exists on S3, and a
    # `--if-none-match "*"` write derived from "the merge had no prior" would 412
    # on every clean run.
    live_index, live_index_etag = read_index_with_etag(bucket, dataset_id)
    head_files = git_ls_files(repo, head)
    # Coverage denominator: every raw recording at HEAD, whether or not this run
    # touches it. Publishing it is what lets a consumer check completeness without
    # cloning the repo (#1197).
    discovered = discover_primaries(head_files)
    # A retry round converts only what is still pending when nothing else would
    # change (#1483); see `pending_retry_worklist`. The catalog row it compares
    # against is fetched here and reused for the stores below, so it is still
    # read once per run.
    biosigio_version = installed_biosigio_version()
    early_row: tuple[dict | None, bool] | None = None
    retry_paths: list[str] | None = None
    if args.retry_pending and not args.wipe:
        early_row = fetch_dataset_row(args.api_base, dataset_id)
        retry_paths, why = pending_retry_worklist(
            live_index, head, discovered, early_row[0], early_row[1], biosigio_version
        )
        verdict = f"converting only {why}" if retry_paths else f"{why}; full rebuild"
        print(f"[zarr] --retry-pending: {verdict}", flush=True)
    # From here on `clean` is what this run does, which a retry round turns off:
    # it merges into the published index instead of rewriting it.
    clean = args.clean and retry_paths is None
    prior_for_orphans: dict | None = None
    if clean:
        prior, prior_commit, full = None, None, True
        prior_for_orphans = live_index
    else:
        prior = live_index
        prior_commit = (prior or {}).get("source_commit")
        full = args.full or not prior_commit or not is_ancestor(repo, prior_commit, head)
    # The producer manifest tracks exactly the index's store set, so it is merged
    # on the same terms: carried on the incremental path, rebuilt from this run
    # under --clean (which reconverts every recording anyway).
    prior_manifest = (
        None if clean else s3_read_json(bucket, f"{dataset_id}/zarr/manifest.json")
    )

    if full:
        diff: list[tuple[str, str]] = []
    else:
        assert prior_commit  # full is False only when prior_commit is a real ancestor SHA
        diff = git_diff_name_status(repo, prior_commit, head)
    convert, remove = compute_worklist(head_files, diff, full)
    if retry_paths is not None:
        # The index was built from HEAD, so the diff is empty and the worklist
        # with it; what is left to do is exactly what the index lists as pending.
        convert, remove = retry_paths, []
    # `pending` attempt counts are a property of the RECORDING's history, not of
    # this run, so they are carried even under --clean -- which otherwise rebuilds
    # the index from nothing. Without this a recording would reset to attempt 1
    # every run on the Hallu path (which always passes --clean) and could never
    # reach the exhaustion cap.
    # The prior index as PUBLISHED, whichever branch read it. `--clean` passes
    # `prior=None` to the merge (the index is rewritten fresh) but still reads the
    # document for orphan detection, and two facts have to come from what was
    # actually published rather than from what the merge is given: the pending
    # attempt counts, and how many non-raw stores this run removes from the index.
    prior_index_doc = prior if prior is not None else prior_for_orphans
    prior_pending = (prior_index_doc or {}).get("pending")
    dropped_non_raw_paths = non_raw_store_paths(prior_index_doc)
    non_raw_dropped = len(dropped_non_raw_paths)
    if dropped_non_raw_paths:
        # Named individually, at most a handful of lines for the datasets that
        # have them, because "the index lost 92 stores" needs a cause attached
        # when the alternative reading is an orphan-detection bug (#1095/#1097;
        # the deletion itself is purge_non_raw_stores.py's job, not this run's).
        print(
            f"[zarr] {non_raw_dropped} non-raw store(s) from the prior index will "
            "not be republished (ADR 0027 raw-only; see purge_non_raw_stores.py):",
            flush=True,
        )
        for path in dropped_non_raw_paths:
            print(f"[zarr]   - {path} ({excluded_reason(path)})", flush=True)

    # --clean no longer wipes the serving prefix up front.
    #
    # It used to, and that dominated the run: nm000338 (a v1.0.1 -> v1.0.2 bump)
    # spent ~45 min deleting ~620k objects at 13.8k/min before converting a single
    # recording, with 30 of 32 cores idle -- then re-uploaded almost exactly what
    # it had just deleted. The wipe was never what made the copy exact: each store
    # is uploaded with `aws s3 sync --delete`, which already reconciles that
    # store's contents precisely (stale chunks, renamed groups, a shortened
    # recording). The ONLY thing the wipe added was dropping stores for recordings
    # that no longer exist at HEAD.
    #
    # So compute exactly those, and hand them to the `remove` path that the
    # incremental branch already uses -- which deletes per store, AFTER a
    # successful conversion, instead of pre-emptively destroying a good serving
    # copy. A recording that is still at HEAD but fails to convert is in `convert`,
    # never an orphan, so it keeps its previous store (ADR 0005: partial data
    # still serves) instead of being deleted by a wipe that ran before we knew.
    #
    # `--wipe` keeps the old behavior for recovery (a corrupt prefix, an index
    # that no longer describes what is on S3).
    if clean:
        # `compute_clean_orphans` also protects already-published stores under
        # an excluded tree (derivatives/sourcedata/code) from this removal: a
        # raw-only `convert` no longer contains them, but that must not be
        # misread as "gone from HEAD" -- see its docstring.
        orphans = compute_clean_orphans(prior_for_orphans, convert)
        if orphans:
            print(
                f"[zarr] --clean: {len(orphans)} store(s) no longer at HEAD; "
                "removing those, keeping the rest in place",
                flush=True,
            )
        # Stays a sorted LIST: `remove` is JSON-serialized into the callback and
        # the index, and a set would blow up json.dump.
        remove = sorted(set(remove) | orphans)
    # Fail closed before anything is converted, and before `--wipe` erases the
    # serving prefix: a biosigIO that cannot leave subject information out of a
    # store must not write one (#1626), and there is no fallback to writing it
    # in. A run with nothing to convert never writes a store, so it is not held
    # up by this. The failed callback supersedes the `converting` signal (see
    # `write_failed_callback` for why a refusal writes one). Its `error` names
    # the node as the cause for whoever reads the callback file; the backend
    # parses the body but does not store `error`, so the operator-facing signal
    # is the `::error::` lines here and hallu-zarr.sh's FATAL on this exit code,
    # which stops the drain rather than fail every queued dataset in turn.
    if convert:
        problems = biosigio_subject_info_problems()
        if problems:
            for problem in problems:
                print(f"::error::{problem}", flush=True)
            reason = (
                f"refusing to convert: this biosigIO cannot leave subject information "
                f"out of a store (needs a final release >= {SUBJECT_INFO_FLOOR} whose "
                f"{', '.join(BIOSIGIO_STORE_WRITERS)} take {SUBJECT_INFO_OPTION}): "
                + "; ".join(problems)
            )
            print(f"::error::{reason}", flush=True)
            with open(args.callback_out, "w") as fh:
                json.dump(
                    # Nothing was attempted: no failures, no pool, no events,
                    # and nothing deferred (scratch admission has not run yet).
                    failed_callback_body(
                        dataset_id=dataset_id,
                        head=head,
                        prior=prior,
                        discovered=discovered,
                        failures=[],
                        failure_entries=[],
                        annex_missing=[],
                        pool_breaks=0,
                        pending_entries=[],
                        deferred={},
                        provenance_fetch_failed=bool(early_row and early_row[1]),
                        events_row_count=None,
                        events_upload_failed=False,
                        events_stores_without_rows=0,
                        error=reason,
                    ),
                    fh,
                )
            return EXIT_SUBJECT_INFO_UNAVAILABLE
    if args.wipe and convert:
        prefix = f"{dataset_id}/zarr/"
        if _s3_prefix_empty(bucket, prefix):
            print(f"[zarr] --wipe: s3://{bucket}/{prefix} already empty; skipping wipe", flush=True)
        else:
            print(f"[zarr] --wipe: erasing s3://{bucket}/{prefix} before full rebuild", flush=True)
            _rm_recursive(f"s3://{bucket}/{prefix}")
    print(
        f"[zarr] {dataset_id} head={head[:8]} prior={(prior_commit or 'none')[:8]} "
        f"full={full} convert={len(convert)} remove={len(remove)}",
        flush=True,
    )

    head_set = set(head_files)
    converted_entries: list[dict] = []
    manifest_entries: list[dict] = []
    failures: list[str] = []
    # The subset of `failures` refused for subject information (#1626); see
    # `subject_info_refused_run`.
    subject_info_refused: list[str] = []
    failure_entries: list[FailureEntry] = []
    # NOT PendingEntry: these are the merge's INPUT, carrying only what this run
    # observed (path, reason, last_error, last_attempt_utc). `merge_index` is
    # what derives `zarr` and the attempt count and produces the published
    # entries -- see `_pending_entry`.
    pending_entries: list[dict] = []
    # (path, annex key) of each recording refused as `annex_object_missing`; the
    # callback names the first so the queue's error can (`annex_missing_summary`).
    annex_missing: list[tuple[str, str | None]] = []
    # Event rows go to disk as each recording finishes, never into a list that
    # grows with the dataset: nm000281 is ~25k stores (#1060).
    events_staging = EventsStaging()
    # Every store this run rebuilt, whether or not it produced event rows. This
    # -- not the set of stores WITH rows -- is what "carried over from the prior
    # events file" is defined against.
    reconverted_rels: set[str] = set()
    # Stores whose events could not be turned into usable rows: no channel
    # groups to attach them to, or no usable sample index on any row. Counted
    # for the callback so the condition is visible off-node.
    events_stores_without_rows = 0

    n = len(convert)

    def record(r: dict, i: int) -> None:
        nonlocal events_stores_without_rows
        # Log each recording as it finishes (live progress over a long backfill),
        # not all at once at the end.
        # Under-projection is the defect that caused the 2026-08-22 OOMs, and it is
        # invisible until the node dies. Say so per recording, while the path that
        # caused it is still on screen.
        warning = note_measurement(r, projections, measured)
        if warning:
            print(warning, flush=True)
        elif r["ok"] and r.get("peak_rss") is None and not _WARNED_NO_RSS[0]:
            _WARNED_NO_RSS[0] = True
            print(
                "::warning::peak RAM could not be measured; this run contributes "
                "nothing to calibration and `calibration` will be empty for reasons "
                "unrelated to what converted (#1111)",
                flush=True,
            )
        if r["ok"]:
            converted_entries.append(r["entry"])
            if r.get("manifest"):
                manifest_entries.append(r["manifest"])
            # Staged here rather than in the worker so the rows are built from the
            # entry's OWN groups -- the same rates the index publishes are the
            # rates `sample_index` is computed against.
            rel_store = r["entry"]["zarr"]
            reconverted_rels.add(rel_store)
            parsed = r.get("events")
            rows = event_rows_for_store(
                rel_store, r["primary"], r["entry"].get("groups"), parsed
            )
            if rows:
                events_staging.add(rel_store, rows)
            alert = events_row_alert(r["primary"], parsed, rows)
            if alert:
                events_stores_without_rows += 1
                print(alert, flush=True)
            print(f"[zarr] [{i}/{n}] converted {r['primary']} -> {r['entry']['zarr']}", flush=True)
        else:
            failures.append(r["primary"])
            if r.get("subject_info_refused"):
                subject_info_refused.append(r["primary"])
            # Two destinations, and which one is the whole of #1197.
            #
            # A typed, non-retryable biosigIO/NEMAR failure is a property of the
            # DATA (or a converter gap): it goes to `failures` with the code, the
            # user-facing reason, AND the importer's own first line as `detail`,
            # so an opaque `file_read_error` is diagnosable from the public index.
            #
            # Everything else -- an uncoded failure (crashed worker, transient S3)
            # or a RETRYABLE code (the memory budget, which is a condition on a
            # shared node, not a property of the recording) -- goes to `pending`.
            # These used to be dropped on the floor so they would "retry next
            # run", but a run where anything converted is marked `done`, so they
            # never did: on008083 lost five recordings that appeared in neither
            # list and were indistinguishable from "still generating" forever.
            code = r.get("code")
            detail = r.get("detail") or failure_detail(r.get("error"))
            if code == AnnexObjectMissing.code:
                annex_missing.append((r["primary"], r.get("annex_key")))
            if code and code not in RETRYABLE_CODES:
                failure_entries.append(_failure_entry(r["primary"], code, detail))
            else:
                pending_entries.append({
                    "path": r["primary"],
                    "reason": "memory_budget" if code else "infra_failure",
                    "last_error": detail,
                    "last_attempt_utc": updated,
                })
            print(f"::warning::[{i}/{n}] conversion failed for {r['primary']}: {r['error']}", flush=True)

    cpu_cap = max(1, args.jobs)
    ram_ceiling = per_recording_ceiling_bytes()
    # RAM-admission control: workers are sized to CPU (cpu_cap), but a recording is
    # dispatched only while the SUM of in-flight projected peaks stays within the
    # node's usable RAM. Small (EEG) recordings pack many-wide -> cores stay busy;
    # large (MEG) ones self-limit concurrency -> no OOM; and a recording is
    # #909-skipped only when it can't fit the node even alone (independent of jobs).
    # Peaks are projected from git-annex pointers (no download) so the estimate is
    # cheap and matches the worker's preflight.
    # Charge admission what each worker is PERMITTED (projection * slack), not the
    # bare projection -- otherwise the in-flight sum is bounded while the memory
    # those workers may actually take is not. See `admission_reserve_bytes`.
    # A declared `.fdt` counts toward its `.set`'s size (see `admission_sizes`).
    # The declaration file is read unconditionally, for every dataset: a
    # malformed one fails every run, which is why the committed file is loaded
    # by a test in CI.
    fdt_declarations = load_fdt_declarations().get(dataset_id, {})
    size_info = admission_size_info(repo, convert, head_set, head, fdt_declarations)
    sizes = {p: size for p, (size, _readable) in size_info.items()}
    # channels.tsv is already the fidelity gate's ground truth; reuse it so the
    # streaming projection can account for its per-channel term (see
    # `streaming_peak_bytes`). Best-effort: an unreadable sidecar falls back to
    # the flat bound rather than failing the run.
    channel_counts: dict[str, int | None] = {}
    for p in convert:
        try:
            channel_counts[p] = expected_channel_count_for(repo, p, head_set, head)
        except Exception:  # noqa: BLE001 - a projection input must not fail a run
            channel_counts[p] = None
    # Whether a recording will need the Signal-Space Separation phase cannot be known
    # here: that is `info["maxshield"]` inside the FIF, and admission deliberately
    # projects from git-annex pointers WITHOUT downloading. The BIDS sidecar carries
    # no MaxShield marker either. So use the one signal that IS available from
    # `head_files` alone -- a resolvable fine-calibration / cross-talk pair -- and let
    # the worker do the real detection. A dataset that ships the pair for a FIF that
    # turns out not to be MaxShield is merely over-reserved for, which costs
    # concurrency; under-reserving costs the node.
    maxshield_hint = {
        p: lower_ext(p) == ".fif" and maxshield_calibration_for(p, head_set) is not None
        for p in convert
    }
    # How many bytes each sample of a BrainVision recording takes, from its sidecar,
    # so a float32 recording is not projected as if it were int16 (twice the memory).
    # Best-effort like the channel count: the narrowest width is assumed without it.
    sample_widths: dict[str, int | None] = {}
    for p in convert:
        try:
            sample_widths[p] = sample_bytes_from_sidecar(
                repo, p, head_set, head, sizes[p], channel_counts.get(p)
            )
        except Exception:  # noqa: BLE001 - a projection input must not fail a run
            sample_widths[p] = None
    projections = {
        p: projected_peak_bytes(
            p, sizes[p], channel_counts.get(p), maxshield=maxshield_hint[p],
            sample_bytes=sample_widths.get(p),
        )
        for p in convert
    }
    # Which path each recording will take. Computed once and reused: admission
    # needs it to skip MEM_LIMIT_SLACK for streamed recordings, and the calibration
    # summary needs it to bucket them apart from in-memory ones.
    streamed_paths = {p for p in convert if should_stream(p, sizes[p])}
    peaks = {
        p: admission_reserve_bytes(proj, ram_ceiling, streamed=p in streamed_paths)
        for p, proj in projections.items()
    }
    # Projected scratch per recording, charged by admission like RAM (see
    # `scratch_peak_bytes`). Recordings admission cannot fit land in `deferred`.
    scratch_peaks = {
        p: scratch_peak_bytes(p, sizes[p], size_info[p][1]) for p in convert
    }
    unreadable = [p for p in convert if not size_info[p][1]]
    if unreadable:
        print(
            f"::warning::the size of {len(unreadable)} recording(s) could not be read "
            f"from their pointers; each is charged {SCRATCH_UNKNOWN_SIZE_BYTES / 1024**3:.0f} "
            f"GiB of scratch at least (first: {', '.join(unreadable[:3])})",
            flush=True,
        )
    deferred: dict[str, str] = {}  # recording -> the last_error the index will carry
    # Measured peak RSS per recording, so the factors above stop being guesses.
    measured: dict[str, int] = {}
    # Every tunable here is env-overridable, and ADR 0030 expects one such
    # override (ZARR_STREAM_MIN_BYTES, applied to the crontab as an emergency
    # mitigation) to be REMOVED once this ships. Nothing would otherwise tell
    # anyone if a stale override diverged from the coded default later -- a future
    # retune driven by calibration data would silently no-op on the node. Print
    # what is actually in force.
    overrides = sorted(k for k in os.environ if k.startswith("ZARR_"))
    if overrides:
        print(
            "[zarr] active env overrides: "
            + ", ".join(f"{k}={os.environ[k]}" for k in overrides),
            flush=True,
        )

    # Scratch is admitted like RAM: each streaming recording holds its raw blob plus
    # a memmap of `n_channels * n_samples * 4` bytes plus the outputs, and nothing
    # used to stop 24 of them being admitted into a few hundred GiB. #1112 recorded
    # that as an open risk; nm000276 is what it cost.
    try:
        scratch_root = tempfile.gettempdir()
        scratch_free = shutil.disk_usage(scratch_root).free
        print(
            f"[zarr] scratch free: {scratch_free / 1024**3:.0f} GiB at {scratch_root} "
            f"(admission charges each recording ~{SCRATCH_STREAM_FACTOR:g}x its bytes "
            f"when streamed, {SCRATCH_INMEM_FACTOR:g}x otherwise, and keeps "
            f"{SCRATCH_HEADROOM_BYTES / 1024**3:.0f} GiB free)",
            flush=True,
        )
    except OSError as exc:  # visibility only; never fail a run over a stat
        print(f"::warning::could not stat scratch: {exc}", flush=True)

    print(
        f"[zarr] admission: up to {cpu_cap} worker(s), RAM ceiling "
        f"~{ram_ceiling // 1024**3} GiB now and re-read from MemAvailable as the run "
        f"goes (#1483); a recording projected above it alone is skipped (#909)",
        flush=True,
    )
    # Only the pool admits through the ledger. A bare `--jobs 1` run converts in this
    # process and is not registered with the others, but a node that has a ledger gets the
    # pool even at one worker: a slot told to run one recording at a time must still be
    # seen by its peers (and by the serial memory retry, which only the pool has).
    ledger = ledger_from_env() if convert else None
    if ledger is not None:
        print(
            f"[zarr] admission ledger {ledger.root}: this run admits against what other "
            "conversions on this node have reserved and not yet taken (ADR 0101)",
            flush=True,
        )
    # Per-dataset provenance for the stores' `nemar` root attribute (#1064).
    # Skipped when there is nothing to convert, so a no-op run makes no request.
    if early_row is not None:
        dataset_row, provenance_fetch_failed = early_row
    else:
        dataset_row, provenance_fetch_failed = (
            fetch_dataset_row(args.api_base, dataset_id) if convert else (None, False)
        )
    with tempfile.TemporaryDirectory() as tmp:
        ctx = {
            "repo": repo, "bucket": bucket, "dataset_id": dataset_id, "head": head,
            "head_files": head_set, "local": args.local, "tmp": tmp, "updated": updated,
            "contract_base": args.contract_base,
            "engine_version": ZARR_ENGINE_VERSION,
            # Read ONCE per run, not per recording: nm000281 has 25k of them.
            "dataset_row": dataset_row,
            "provenance_fetch_failed": provenance_fetch_failed,
            "mem_budget": ram_ceiling,
            # Computed once here rather than re-derived per worker from a second,
            # independent /proc/meminfo read, which could disagree with this one.
            "hard_ceiling": hardware_ceiling_bytes(),
            "projections": projections,
            "fdt_declarations": fdt_declarations,
        }
        pool_breaks = 0
        # --jobs 1 converts in this process, as an operator asked for. Anything
        # else, a single recording included, goes through the pool: it is the
        # only path with the serial memory retry, and a single-recording run is
        # where a large recording most often trips its reserve (#1483). A node with
        # an admission ledger always uses the pool, so a slot told to run one
        # recording at a time is still seen by the others.
        if converts_in_process(cpu_cap, ledger, convert):
            _init_worker(ctx)
            scratch_gate = ScratchGate(tmp)
            # One at a time still has to fit: a recording that cannot is deferred
            # rather than downloaded for hours and failed at ENOSPC.
            drain_serially(
                convert, scratch_peaks, scratch_gate, scratch_gate.volume, deferred,
                lambda p: convert_one(p, peaks[p]), record,
            )
        else:
            def memory_retry() -> tuple[dict, int]:
                return memory_retry_context(ctx)

            try:
                pool_breaks, _max_suspects = _drain_with_admission(
                    convert, peaks, cpu_cap, ram_ceiling, ctx, record,
                    memory_retry=memory_retry,
                    scratch_peaks=scratch_peaks, deferred=deferred,
                    ledger=ledger,
                )
            finally:
                close_ledger(ledger)

    calibration = calibration_summary(measured, projections, streamed_paths)
    if calibration:
        worst = calibration[0]
        print(
            f"[zarr] peak RAM measured for {len(measured)}/{len(convert)} recording(s); "
            f"worst {worst['ext']} at {worst['max_ratio']}x its projection "
            f"(peak {worst['max_peak_bytes'] / 1024**3:.1f} GiB)",
            flush=True,
        )
    elif convert:
        print(
            f"[zarr] peak RAM measured for 0/{len(convert)} recording(s); "
            "calibration is empty because nothing could be measured, not because "
            "nothing converted (#1111)",
            flush=True,
        )

    for rel_store in remove:
        _rm_recursive(safe_store_prefix(bucket, dataset_id, rel_store))
        print(f"[zarr] removed store {rel_store}", flush=True)

    # `deterministic` = every failure is a typed DATA failure (biosigIO carries a
    # `.code`); none are infra (crashed worker / transient S3), and not all of
    # them are a storage-state code like `annex_object_missing`. The driver uses
    # this to mark a total failure terminal (`data_failed`, no retry) vs
    # retryable (bounded retry) — and the backend records it for the failures
    # dashboard. See nemarOrg/nemar-cli#774 and `dataset_failure_is_deterministic`.
    infra_failures = count_infra_failures(failures, failure_entries)
    # Recordings that failed for a reason that is NOT a property of the data. On a
    # run where anything converted, `main` returns 0 and the driver marks the
    # dataset `done`, so these are not retried by the queue on their own -- say so
    # loudly rather than let the index carry a failure nobody revisits. #1113
    retryable_failures = infra_failures
    deterministic = dataset_failure_is_deterministic(failures, failure_entries)
    annex_missing_fields = annex_missing_summary(annex_missing)

    # Set by the events.parquet step below. Bound HERE, before
    # `write_failed_callback` closes over them, because the total-failure exit
    # calls that callback before the events step has run -- and a name that only
    # exists on the happy path would raise NameError inside the very handler
    # whose job is to make a failure visible.
    events_file: ManifestFileEntry | None = None
    events_upload_failed = False

    # Every failure of this run a refusal to write or upload a store that may
    # carry subject information (#1626): the node's fault, so the run ends with
    # EXIT_SUBJECT_INFO_UNAVAILABLE, the exit hallu-zarr.sh stops its drain on,
    # rather than 1 (a total failure the queue would spend an attempt on) or 0.
    # Anything else that converted is still published as usual first.
    node_refused = subject_info_refused_run(failures, subject_info_refused)
    node_refusal_reason = (
        f"{len(subject_info_refused)} recording(s) refused at write or upload because "
        "this node's biosigIO cannot leave subject information out of a store; "
        "fix the node, then rerun" if node_refused else None
    )
    if node_refusal_reason:
        print(f"::error::{node_refusal_reason}", flush=True)

    def write_failed_callback(error: str | None = None) -> None:
        """Write the `status: "failed"` callback body for a run that publishes
        nothing.

        Every exit that returns 1 goes through here, and that is the point (the
        one exception, an invalid scratch setting, is refused before the
        repository is read and writes its own minimal body). The
        driver POSTs whatever this file contains; if a failure path writes NO
        file, `hallu-zarr.sh` posts nothing, the `converting` signal it sent at
        the start is never superseded, and D1 sits at `zarr_status='pending'`
        forever -- the dataset reads as "still converting" on the dashboard with
        nothing running. That is exactly the invisible-failure shape #774 fixed
        for the total-failure branch, and the two refuse-to-publish guards below
        (a bad index, a bad manifest) reintroduced it: they were added later and
        returned 1 directly. The body itself is `failed_callback_body`, shared
        with the refusal to convert on a biosigIO that cannot exclude subject
        information.
        """
        with open(args.callback_out, "w") as fh:
            json.dump(
                failed_callback_body(
                    dataset_id=dataset_id,
                    head=head,
                    prior=prior,
                    discovered=discovered,
                    failures=failures,
                    failure_entries=failure_entries,
                    annex_missing=annex_missing,
                    pool_breaks=pool_breaks,
                    pending_entries=pending_entries,
                    deferred=deferred,
                    provenance_fetch_failed=provenance_fetch_failed,
                    events_row_count=events_file["row_count"] if events_file else None,
                    events_upload_failed=events_upload_failed,
                    events_stores_without_rows=events_stores_without_rows,
                    error=error,
                ),
                fh,
            )

    # Hard fail: every attempted conversion errored and nothing was removed. Do
    # NOT advance the checkpoint or rewrite the index (that would strand the
    # failed recordings); return non-zero. Still write the callback (status
    # "failed") so the driver can classify data-vs-infra and the backend records
    # WHAT failed even on a total failure (#774 — previously no callback was
    # written here, so total failures were invisible).
    #
    # Not for a retry round (#1483). Its worklist is only the recordings already
    # pending, so "none converted" is the ordinary outcome of a round that did
    # not help, not a failed dataset: the index still serves everything else, and
    # it has to be rewritten so the pending attempt counts advance, or those
    # recordings could never reach `retry_exhausted` and the queue row would go
    # `failed` instead of backing off.
    deferred_set = set(deferred)
    attempted = [p for p in convert if p not in deferred_set]

    def store_is_keepable(doc: dict | None) -> bool:
        """Whether a store ``doc`` serves may stay in the index although this run
        deferred its recording: same commit, engine and biosigIO, and provenance
        that matches or cannot be checked because the catalog was unreadable."""
        return doc is not None and index_currency_problem(
            doc, head, dataset_row, provenance_fetch_failed, biosigio_version,
            provenance_unknown_ok=True,
        ) is None

    # Every recording was deferred and the published index already says so: there is
    # nothing to publish, and republishing is the one way a --clean run could drop
    # stores it merely failed to rebuild. Report and stop (see
    # `deferral_leaves_index_as_is`).
    if deferral_leaves_index_as_is(
        live_index, store_is_keepable(live_index),
        convert, deferred, remove, failures, args.wipe,
    ):
        assert live_index is not None
        print(
            f"[zarr] all {len(deferred)} recording(s) were deferred for scratch and the "
            "published index already says so; index, manifest and events.parquet left "
            "untouched",
            flush=True,
        )
        with open(args.callback_out, "w") as fh:
            json.dump(
                deferred_unchanged_callback(
                    dataset_id, head, live_index, live_index_etag, deferred,
                    len(discovered), non_raw_dropped, provenance_fetch_failed,
                ),
                fh,
            )
        return 0
    if attempted and not converted_entries and not remove and retry_paths is None:
        print(
            f"::error::all {len(attempted)} conversion(s) failed; index left untouched",
            flush=True,
        )
        if annex_missing and not deterministic:
            print(
                f"::error::storage lacks the annex object(s) of {len(annex_missing)} "
                f"recording(s) (first: {annex_missing_fields['annex_missing_first_key']} "
                f"for {annex_missing_fields['annex_missing_first_path']}); the dataset "
                "is retryable, not data_failed, in case an upload is still landing",
                flush=True,
            )
        write_failed_callback(node_refusal_reason)
        return EXIT_SUBJECT_INFO_UNAVAILABLE if node_refused else 1

    # Advance source_commit to HEAD unless there are INFRA failures to retry. A
    # typed data failure (a derivative, a corrupt file) is permanent -- retrying it
    # never helps and would pin the checkpoint forever on a derivative-heavy
    # dataset -- so it does not hold the commit back; it's recorded in the index's
    # `failures` instead. An infra failure keeps the prior commit so the next run
    # re-diffs and retries it.
    # (`infra_failures` / `deterministic` computed above, before the total-fail path.)
    #
    # The old fallback for "infra failures but no usable prior commit" was `""`,
    # which is how on008083 came to publish an EMPTY source_commit while D1 held
    # the real SHA (#1197). There is no longer anything to fall back FOR: those
    # recordings are now listed in `pending`, and the queue re-queues a `done`
    # dataset that has any (zarr_queue.reconcile), which re-runs it: only the
    # pending recordings when the index is otherwise current (#1483), else --clean.
    # So publish the commit the stores were actually built from.
    # The trailing `and prior_commit` in the condition is not redundant with
    # `is_commit_sha`: that call narrows the value at runtime but not for a
    # reader or a type checker, so the extra term is what makes the ternary's
    # first branch visibly a `str` rather than `str | None`. `head_commit` is
    # published as the index's `source_commit`, where None would serialize as
    # JSON null -- the on008083 shape (#1197) that took an empty commit all the
    # way into a published document.
    #
    # A deferral holds the commit back for the same reason an infra failure does: on
    # the incremental path a recording the gate would not admit is still owed, and
    # the next run diffs from the commit the stores were really built from.
    index_commit = (
        prior_commit
        if ((infra_failures or deferred) and is_commit_sha(prior_commit) and prior_commit)
        else head
    )

    def build_index(
        merge_prior: dict | None, merge_pending: list | None, seed_doc: dict | None = None
    ) -> dict:
        """Merge this run's results onto a prior document and check the coverage
        invariant. A function rather than a straight line because the publish
        below re-runs it against a NEWER live document when the conditional write
        loses a race -- re-merging is the only way to keep both writers' work.
        """
        merged = merge_index(
            merge_prior,
            dataset_id,
            index_commit,
            converted_entries,
            remove,
            updated,
            failure_entries,
            pending_entries,
            discovered=discovered,
            errors=len(failures),
            contract_base=args.contract_base,
            bucket=bucket,
            region=args.region,
            biosigio_version=biosigio_version,
            prior_pending=merge_pending,
            dataset_row=dataset_row,
            deferred=deferred,
            seed=seed_doc,
            seed_current=store_is_keepable(seed_doc),
        )
        check_index_invariant(merged)
        return merged

    try:
        index = build_index(prior, prior_pending, None if args.wipe else prior_index_doc)
        # SCHEMA FIRST, UPLOADS SECOND. A refused index means this run publishes
        # nothing -- and "nothing" has to include events.parquet, which is a
        # destructive overwrite of a file the LIVE index still describes. So the
        # document is validated here, before anything is uploaded, in the exact
        # shape it will take: the events pair is filled in with the values this
        # run would use (the URL is deterministic; the row count is a
        # placeholder, and `minimum: 0` makes 0 the strictest stand-in). A bug in
        # either field therefore aborts BEFORE the overwrite rather than after
        # it.
        events_url = f"{index['data_base']}{EVENTS_PARQUET_NAME}"
        validate_document(
            {**index, "events_parquet": events_url, "events_row_count": 0},
            INDEX_SCHEMA_PATH,
            "index",
        )
        # events.parquet then goes up BEFORE index.json, so `events_parquet`
        # never names a file that is not there. It is best-effort and cannot fail
        # the run; when it does not publish, the two fields stay absent and a
        # client reads that as "this dataset has no events file", which is
        # exactly what is true of the new index.
        published_events = publish_events_parquet(
            events_staging,
            [e["zarr"] for e in index["stores"]],
            bucket=bucket,
            dataset_id=dataset_id,
            reconverted=reconverted_rels,
        )
        events_file = published_events["file"]
        events_upload_failed = published_events["failed"]
        if events_file:
            index["events_parquet"] = events_url
            index["events_row_count"] = events_file["row_count"]
        # Validate what is about to be published, not a copy of it. The pre-flight
        # above checked the same document with a stand-in row count; this checks
        # the real one, so nothing reaches S3 unvalidated.
        validate_document(index, INDEX_SCHEMA_PATH, "index")
    except Exception as exc:  # noqa: BLE001 - refuse to publish a bad index
        print(
            f"::error::refusing to publish {dataset_id}/zarr/index.json: {exc}",
            flush=True,
        )
        write_failed_callback(f"index refused: {exc}")
        return 1

    def manifest_prior_for(index_doc: dict) -> dict | None:
        """The manifest to carry entries from. ``--clean`` hands the merge no prior
        (this run rebuilds everything), but a store the index KEPT because its
        recording was deferred was not rebuilt, so its ``source_key`` and size exist
        only in the published manifest. Seed exactly those entries; without them
        the manifest would list fewer stores than the index serves."""
        if not (clean and deferred and not args.wipe):
            return prior_manifest
        kept = {store_rel_for(p) for p in deferred} & {e["zarr"] for e in index_doc["stores"]}
        if not kept:
            return prior_manifest
        return kept_manifest_seed(bucket, dataset_id, kept)

    def build_manifest(index_doc: dict) -> dict:
        """The producer manifest tracks EXACTLY the index's store set, so it is
        derived from the document that is actually published -- including the
        re-merged one a conditional-write retry produces, whose store list can
        differ from the first attempt's. Validated here so a bad manifest still
        refuses the publish rather than being uploaded.
        """
        doc = merge_manifest(
            manifest_prior_for(index_doc),
            dataset_id,
            manifest_entries,
            [e["zarr"] for e in index_doc["stores"]],
            updated,
            events_file=events_file,
        )
        validate_document(doc, MANIFEST_SCHEMA_PATH, "manifest")
        return doc

    try:
        manifest = build_manifest(index)
    except Exception as exc:  # noqa: BLE001 - refuse to publish a bad manifest
        print(
            f"::error::refusing to publish {dataset_id}/zarr/manifest.json: {exc}",
            flush=True,
        )
        write_failed_callback(f"manifest refused: {exc}")
        return 1

    # The index publish is a CONDITIONAL write, and its own temp-file handling
    # lives in `write_index` (shared with purge_non_raw_stores.py).
    #
    # It used to be an unconditional `aws_cp` followed by a `head-object` for the
    # ETag. Two processes write this object -- a converter run and the non-raw
    # purge -- and both read it, work for minutes to hours, then write back what
    # they merged from that read. Whichever finished second silently reverted the
    # other: a purge that had just deleted 92 non-raw stores would be undone, or a
    # conversion's newly added stores would vanish from the document while their
    # chunks sat on S3 unreferenced. Nothing anywhere reported it -- both runs
    # exited 0 and both callbacks said "ready".
    #
    # So the PUT carries `--if-match` with the ETag read at the top of this run
    # (or `--if-none-match "*"` when there was no document then). A 412 means the
    # premise changed, and it is recoverable exactly once: re-read, re-merge this
    # run's results onto the NEWER document, and write again against its ETag.
    # The re-merge covers the document only -- the objects this run uploaded and
    # deleted are already on S3 and are not redone. A second 412 is abandoned
    # loudly through `write_failed_callback`: a third attempt has no reason to
    # win, and publishing an index computed from a body that is already stale
    # again is exactly the silent rollback this replaces.
    def publish_index() -> tuple[dict, dict, str | None]:
        try:
            return index, manifest, write_index(
                bucket, dataset_id, index, if_match=live_index_etag
            )
        except IndexPreconditionFailed as first:
            print(
                f"::warning::{dataset_id}/zarr/index.json changed under this run "
                f"({first}); re-reading and re-merging once",
                flush=True,
            )
        newer, newer_etag = read_index_with_etag(bucket, dataset_id)
        # `--clean` hands the merge no prior (the document is rebuilt from this
        # run), exactly as the first attempt did; the pending attempt history
        # still comes from the published document, newer one included.
        remerged = build_index(
            None if clean else newer, (newer or {}).get("pending"),
            None if args.wipe else newer,
        )
        if events_file:
            remerged["events_parquet"] = f"{remerged['data_base']}{EVENTS_PARQUET_NAME}"
            remerged["events_row_count"] = events_file["row_count"]
        # Re-validated, not assumed: the retry publishes a document built from a
        # body this run has not otherwise inspected. The manifest follows the
        # re-merged store set for the same reason -- it is defined as exactly the
        # index's stores, and pairing a retried index with the first attempt's
        # manifest would publish the disagreement `manifest_upload_failed` exists
        # to report.
        validate_document(remerged, INDEX_SCHEMA_PATH, "index")
        try:
            remerged_manifest = build_manifest(remerged)
        except Exception as exc:  # noqa: BLE001 - abandon the publish, do not skip it
            raise RuntimeError(f"manifest refused after index re-merge: {exc}") from exc
        return remerged, remerged_manifest, write_index(
            bucket, dataset_id, remerged, if_match=newer_etag
        )

    try:
        index, manifest, put_etag = publish_index()
    except IndexPreconditionFailed as exc:
        print(
            f"::error::refusing to publish {dataset_id}/zarr/index.json: {exc}",
            flush=True,
        )
        write_failed_callback(f"index publish conflict: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001 - the run has nothing to serve without this
        # Includes an `aws` too old to know `--if-match` on put-object (S3 gained
        # conditional writes in Nov 2024): that is a node-provisioning failure,
        # and it has to read as a loud failed run rather than a silent one.
        print(
            f"::error::publishing {dataset_id}/zarr/index.json failed: {exc}",
            flush=True,
        )
        write_failed_callback(f"index publish failed: {exc}")
        return 1
    # The ETag the PUT itself reported, not a follow-up read: a `head-object`
    # here could hand the backend a version this run did not write.
    etag = (put_etag or "").strip().strip('"') or None

    # The manifest is producer-only bookkeeping, so it is uploaded AFTER the index
    # and a failure here does not fail the run: the serving copy and its entry
    # point are already correct, and ADR 0005 says partial data still serves. The
    # next run rewrites it.
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(manifest, fh, separators=(",", ":"))
        manifest_local = fh.name
    manifest_upload_failed = False
    try:
        aws_cp(
            manifest_local,
            f"s3://{bucket}/{dataset_id}/zarr/manifest.json",
            extra=["--content-type", "application/json", "--cache-control", "public, max-age=60"],
        )
    except Exception as exc:  # noqa: BLE001 - never fail a good conversion over this
        # Non-fatal by design (the index and the stores are already correct), but
        # reported: the manifest is where `source_key` lives now, so a silent
        # failure leaves the producer unable to say which blob a store came from,
        # and a warning in a multi-megabyte cron log is not a signal anyone sees.
        manifest_upload_failed = True
        print(f"::warning::manifest.json upload failed for {dataset_id}: {exc}", flush=True)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(manifest_local)

    # status stays "ready": the stores that converted + the index are on S3, so
    # the latest-only state is real and worth recording even on a partial run.
    # `errors`/`failed` carry the per-recording skips; the workflow flags the run
    # red on errors>0 AFTER posting this, so the callback always fires.
    callback = {
        "dataset_id": dataset_id,
        "status": "ready",
        "store_count": index["store_count"],
        "index_etag": etag,
        "commit": head,
        "converted": [e["zarr"] for e in converted_entries],
        "removed": remove,
        "errors": len(failures),
        "failed": failures,
        # Typed data failures (recordings the viewer should explain, not retry).
        "failure_count": index["failure_count"],
        "data_failures": failure_entries,
        # On a partial run the dataset is still `done` (the index has what
        # converted); `deterministic` only tells the backend whether the skipped
        # recordings are data (won't retry) vs infra. See #774.
        "deterministic": deterministic,
        # Recordings refused because storage lacks their object; the count and
        # the first one, by path. Reported here too, where the dataset is `done`,
        # so a partial run's missing objects are visible without the index.
        **annex_missing_fields,
        # Worker-pool breaks recovered during this run. Zero is the healthy
        # value; a non-zero trend means the node is under memory pressure and
        # is only visible here -- the log is far too large to watch. #1110.
        "pool_breaks": pool_breaks,
        # Measured peak RAM vs what was reserved, per format. The only way the
        # projection factors stop being guesses. #1111
        "calibration": calibration,
        # Measured vs attempted, so an empty `calibration` can be told apart
        # from a run where measurement itself was unavailable.
        "measured_count": len(measured),
        # Failures that could succeed on a later run. A partially successful
        # run is still marked `done` by the queue, so these need an explicit
        # requeue; they are reported here so that is visible. #1113
        "retryable_failures": retryable_failures,
        # Coverage (#1197). These are what the queue turns into an AUTOMATIC
        # re-queue of a `done` dataset (see zarr_queue.mark_done / reconcile), so
        # #1113's "needs an explicit requeue" above is no longer the whole story;
        # and what the backend records alongside the failure summary so a
        # dashboard can rank datasets by coverage without reading every index.
        "pending_count": index["pending_count"],
        "discovered_count": index["discovered_count"],
        # The subset of `pending_count` that was never ATTEMPTED, as opposed to
        # attempted and failed. They need a re-queue, not a backoff: nothing has
        # gone wrong with them yet, so they must not consume the retry rounds a
        # genuinely failing recording gets (see zarr_queue's pending policy).
        "not_attempted_count": sum(
            1 for e in index["pending"] if e.get("reason") == "not_attempted"
        ),
        # Carried-over stores dropped because their source sits in a tree
        # discovery no longer walks (ADR 0027 raw-only) or is a BIDS calibration
        # file. Reported rather than published: the index describes what IS
        # served, and these are being deleted by `purge_non_raw_stores.py`, so
        # the only place the number belongs is the operational record.
        "non_raw_dropped": non_raw_dropped,
        # True when the catalog could not be read, so this wave's stores carry
        # null doi/license/citation/hed_version because of the RUN, not the data.
        "provenance_fetch_failed": provenance_fetch_failed,
        # True when index.json is published but manifest.json is not, so the two
        # documents disagree about which stores exist until the next run.
        "manifest_upload_failed": manifest_upload_failed,
        # Rows in the events.parquet this run published, or null when it
        # published none (#1060). Null covers three different things -- the
        # dataset has no events, pyarrow is absent from the node's venv, or the
        # build/upload failed -- so `events_upload_failed` separates the last one:
        # "no events" and "we could not say what the events are" must not read
        # the same from outside.
        "events_row_count": events_file["row_count"] if events_file else None,
        "events_upload_failed": events_upload_failed,
        # Stores whose events could not be turned into usable rows: no channel
        # group to attach them to, or no usable sample index on any row. Zero is
        # the healthy value. Each one is warned about by name as it happens, but
        # a warning in a multi-megabyte cron log is not a signal anyone sees, so
        # the count rides here as well (the same argument as `pool_breaks`).
        "events_stores_without_rows": events_stores_without_rows,
    }
    with open(args.callback_out, "w") as fh:
        json.dump(callback, fh)

    if failures:
        print(f"::error::{len(failures)} recording(s) failed to convert: {failures}", flush=True)
    # What converted is published above; the refusals are pending in the index.
    # The exit still says the node is at fault, so the drain stops here.
    return EXIT_SUBJECT_INFO_UNAVAILABLE if node_refused else 0


if __name__ == "__main__":
    sys.exit(main())
