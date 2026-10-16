#!/usr/bin/env python3
"""Unit tests for the pure helpers in scripts/zarr/generate_zarr.py.

No mocks: these exercise the path-classification, worklist, index-merge, and
annex-key parsing logic directly (the git/S3/biosigIO I/O is validated E2E by
`hallu-zarr.sh --dataset nm099999` on Hallu, not here; the old
run-generate-zarr.yml workflow_dispatch path was retired in nemar-cli#1109).

Run with:
    python3 scripts/zarr/test_generate_zarr.py
    uv run python scripts/zarr/test_generate_zarr.py
"""

from __future__ import annotations

import contextlib
import errno
import functools
import hashlib
import io
import itertools
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any, ClassVar, cast

sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate_zarr
from zarr_queue import ZARR_ENGINE_VERSION  # type: ignore[import-not-found]  # noqa: E402

from generate_zarr import (  # type: ignore[import-not-found]  # noqa: E402  (sibling module via sys.path)
    _AWS_OP_TIMEOUT,
    _AWS_RM_TIMEOUT,
    _AWS_TIMEOUTS,
    TRIAL_TYPE_DIGEST_KEY_LEN,
    TRIAL_TYPE_KEY_MAX,
    RecordingTooLarge,
    _aws,
    _normalize_store_entry,
    _s3_prefix_empty,
    _recording_size_bytes,
    affected_primaries,
    annex_key_size,
    bids_suffix_modality,
    compute_clean_orphans,
    convert_one,
    convert_recording,
    projected_peak_bytes,
    per_recording_ceiling_bytes,
    recording_size_from_pointers,
    note_measurement,
    CEILING_FLOOR_BYTES,
    STREAM_PEAK_BYTES,
    _next_admission,
    _drain_with_admission,
    worker_mem_limit_bytes,
    stream_factor_for,
    projection_factor_hint,
    STREAM_MEM_FACTOR_BY_EXT,
    INMEM_MEM_FACTOR_BY_EXT,
    STREAM_MIN_BYTES,
    apply_worker_mem_limit,
    cap_blas_threads,
    data_segment_bytes,
    BLAS_THREAD_VARS,
    MEM_LIMIT_FLOOR_BYTES,
    MEM_LIMIT_SLACK,
    admission_reserve_bytes,
    streaming_peak_bytes,
    reset_peak_rss,
    peak_rss_bytes,
    inmem_factor_for,
    is_maxshield_fif,
    calibration_summary,
    INMEM_MEM_FACTOR,
    usable_ram_bytes,
    memory_failure_result,
    live_admission_ceiling,
    mem_available_bytes,
    anon_rss_bytes,
    _tracked_call,
    memory_snapshot,
    log_memory_failure,
    count_infra_failures,
    RecordingMemoryExceeded,
    MaxShieldUncalibrated,
    MaxShieldProbeFailed,
    maxshield_calibration_for,
    MAXSHIELD_MEM_FACTOR,
    RETRYABLE_CODES,
    reason_for_code,
    should_stream,
    STREAM_EDF_MIN_BYTES,
    compute_worklist,
    ChannelCountMismatch,
    dir_recording_of,
    dir_recordings,
    is_dir_recording,
    is_mefd,
    bti_recordings,
    bti_pdf_choice,
    is_bti_dir,
    is_bti_marker_name,
    MEFD_EXT,
    electrode_positions_for,
    expected_channel_count_for,
    file_declared_channel_count,
    channel_gate_verdict,
    channels_tsv_names,
    sidecar_join_report,
    bound_units_report,
    store_total_channels,
    store_metadata,
    embed_attr,
    embed_root_attr,
    event_descriptions_for,
    events_sibling_for,
    fix_source_file_attr,
    in_excluded_tree,
    is_bids_calibration_file,
    _bids_entities,
    is_excluded_from_discovery,
    is_primary,
    is_split_fif,
    materialize_local,
    merge_index,
    index_provenance,
    pending_retry_worklist,
    parse_annex_key,
    power_line_frequency_for,
    safe_store_prefix,
    split_group_key,
    split_heads_and_members,
    split_index,
    split_members_for,
    store_rel_for,
    INDEX_SCHEMA_PATH,
    MANIFEST_SCHEMA_PATH,
    PENDING_MAX_ATTEMPTS,
    channels_tsv_for,
    check_index_invariant,
    dataset_citation,
    discover_primaries,
    _failure_entry,
    EVENTS_FIXED_COLUMNS,
    EVENTS_PARQUET_NAME,
    EventsStaging,
    PriorEventRows,
    conform_events_table,
    event_rows_for_store,
    events_schema,
    events_row_alert,
    events_summary,
    events_summary_of,
    parse_events_tsv,
    sample_index_for,
    shorten_trial_types,
    trial_type_key,
    write_events_parquet,
    failure_detail,
    fetch_dataset_row,
    is_commit_sha,
    merge_manifest,
    nemar_store_attrs,
    source_tree_for,
    redact_secrets,
    strip_local_paths,
    validate_document,
)


# Real-shaped 40-hex commit SHAs. `merge_index` refuses anything else since index
# v3: a published index that does not name the commit it was built from is
# unreproducible and cannot seed the next incremental diff, and one was actually
# published that way (on008083 carried `source_commit: ""`, #1197). A placeholder
# like "sha" would now assert the wrong contract.
SHA_OLD = "0" * 39 + "1"
SHA_NEW = "0" * 39 + "2"


def by_dir(primaries: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for p in primaries:
        d = p.rsplit("/", 1)[0] if "/" in p else ""
        out.setdefault(d, []).append(p)
    return out


class TestPathClassification(unittest.TestCase):
    def test_is_primary(self):
        self.assertTrue(is_primary("sub-01/eeg/sub-01_task-x_eeg.set"))
        self.assertTrue(is_primary("sub-01/eeg/sub-01_eeg.EDF"))  # case-insensitive
        self.assertTrue(is_primary("sub-01/meg/sub-01_meg.fif"))
        self.assertFalse(is_primary("sub-01/eeg/sub-01_task-x_eeg.fdt"))  # companion
        self.assertFalse(is_primary("sub-01/eeg/sub-01_task-x_events.tsv"))
        self.assertFalse(is_primary("dataset_description.json"))

    def test_store_rel_for(self):
        self.assertEqual(
            store_rel_for("sub-01/eeg/sub-01_task-x_eeg.set"),
            "sub-01/eeg/sub-01_task-x_eeg.zarr",
        )
        self.assertEqual(
            store_rel_for("sub-01/emg/sub-01_task-x_emg.edf"),
            "sub-01/emg/sub-01_task-x_emg.zarr",
        )
        self.assertEqual(
            store_rel_for("sub-01/eeg/sub-01_eeg.vhdr"), "sub-01/eeg/sub-01_eeg.zarr"
        )

    def test_events_sibling_for(self):
        self.assertEqual(
            events_sibling_for("sub-01/eeg/sub-01_task-x_eeg.set"),
            "sub-01/eeg/sub-01_task-x_events.tsv",
        )
        self.assertEqual(
            events_sibling_for("sub-02/emg/sub-02_task-rest_run-1_emg.edf"),
            "sub-02/emg/sub-02_task-rest_run-1_events.tsv",
        )

    def test_events_sibling_for_split_fif_drops_split_entity(self):
        # A split recording shares one events file without the split- entity.
        self.assertEqual(
            events_sibling_for("sub-03/meg/sub-03_task-x_run-02_split-01_meg.fif"),
            "sub-03/meg/sub-03_task-x_run-02_events.tsv",
        )


class TestBidsRawOnlyDiscovery(unittest.TestCase):
    """derivatives/sourcedata/code never hold a BIDS raw recording (nemarOrg/
    nemar-cli#1095/#1098, ADR 0027); BIDS-reserved MEG calibration files are
    excluded by naming convention. Matched on a path SEGMENT, never a bare
    substring."""

    def test_excluded_trees_top_level(self):
        for tree in ("derivatives", "sourcedata", "code"):
            self.assertTrue(
                in_excluded_tree(f"{tree}/sub-01/eeg/sub-01_task-x_eeg.set"),
                tree,
            )

    def test_excluded_trees_nested(self):
        for tree in ("derivatives", "sourcedata", "code"):
            self.assertTrue(
                in_excluded_tree(f"sub-01/{tree}/sub-01_task-x_eeg.set"),
                tree,
            )

    def test_segment_boundary_negatives_are_not_excluded(self):
        # A directory/name that merely CONTAINS an excluded word, but is not
        # that exact path segment, must still be discoverable.
        for path in (
            "mycode/sub-01/eeg/sub-01_task-x_eeg.set",
            "derivatives_old/sub-01/eeg/sub-01_task-x_eeg.set",
            "sourcedatafoo/sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-01/eeg/sub-01_task-code_eeg.set",  # "code" as an entity VALUE
            "sub-01/mycode/sub-01_task-x_eeg.set",
        ):
            self.assertFalse(in_excluded_tree(path), path)
            self.assertTrue(is_primary(path), path)

    def test_is_bids_calibration_file(self):
        self.assertTrue(
            is_bids_calibration_file("sub-01/meg/sub-01_acq-crosstalk_meg.fif")
        )
        self.assertTrue(
            is_bids_calibration_file("sub-01/meg/sub-01_acq-calibration_meg.dat")
        )
        self.assertFalse(is_bids_calibration_file("sub-01/meg/sub-01_task-x_meg.fif"))

    def test_is_primary_excludes_derivatives_sourcedata_code(self):
        for path in (
            "derivatives/preprocessed/sub-01_task-x-epo.fif",
            "sourcedata/sub-01/sub-01_task-x_eeg.set",
            "code/analysis/sub-01_task-x_eeg.set",
            "sub-01/derivatives/sub-01_task-x_eeg.set",
        ):
            self.assertFalse(is_primary(path), path)

    def test_is_primary_excludes_calibration_files(self):
        self.assertFalse(is_primary("sub-01/meg/sub-01_acq-crosstalk_meg.fif"))
        self.assertFalse(is_primary("sub-01/meg/sub-01_acq-calibration_meg.dat"))

    def test_is_excluded_from_discovery_combines_both(self):
        self.assertTrue(is_excluded_from_discovery("derivatives/x/y_eeg.set"))
        self.assertTrue(
            is_excluded_from_discovery("sub-01/meg/sub-01_acq-crosstalk_meg.fif")
        )
        self.assertFalse(is_excluded_from_discovery("sub-01/eeg/sub-01_task-x_eeg.set"))

    def test_full_worklist_excludes_derivatives_sourcedata_code(self):
        head = [
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "derivatives/preprocessed/sub-01_task-x-epo.fif",
            "sourcedata/sub-02/sub-02_task-x_eeg.set",
            "code/analysis/helper.set",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])
        self.assertEqual(remove, [])

    def test_full_worklist_excludes_ctf_ds_under_derivatives(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
            "derivatives/preprocessed/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_full_worklist_excludes_split_fif_under_derivatives(self):
        head = [
            "sub-01/meg/sub-01_task-x_split-01_meg.fif",
            "sub-01/meg/sub-01_task-x_split-02_meg.fif",
            "derivatives/x/sub-01_task-x_split-01_meg.fif",
            "derivatives/x/sub-01_task-x_split-02_meg.fif",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_split-01_meg.fif"])
        self.assertEqual(remove, [])

    def test_full_worklist_excludes_calibration_files(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.fif",
            "sub-01/meg/sub-01_acq-crosstalk_meg.fif",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.fif"])
        self.assertEqual(remove, [])

    def test_derivatives_events_tsv_does_not_pull_in_a_recording(self):
        head = ["derivatives/preprocessed/sub-01_task-x_events.tsv"]
        convert, remove = compute_worklist(
            head, [("M", "derivatives/preprocessed/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, [])

    def test_deleting_file_under_excluded_tree_never_removes_a_store(self):
        # A deletion confined to an excluded tree must never be misread as
        # "the recording is gone from HEAD" (it was never a candidate).
        convert, remove = compute_worklist(
            [], [("D", "derivatives/preprocessed/sub-01_task-x-epo.fif")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, [])

    def test_deleting_one_file_of_a_derivatives_ctf_ds_does_not_remove_or_convert(self):
        head = ["derivatives/x/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4"]
        convert, remove = compute_worklist(
            head,
            [("D", "derivatives/x/sub-01_task-x_meg.ds/BadChannels")],
            full=False,
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, [])


class TestAffectedPrimaries(unittest.TestCase):
    def setUp(self):
        self.primaries = [
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-01/eeg/sub-01_eeg.vhdr",
        ]
        self.bd = by_dir(self.primaries)

    def test_primary_maps_to_itself(self):
        self.assertEqual(
            affected_primaries("sub-01/eeg/sub-01_task-x_eeg.set", self.bd),
            {"sub-01/eeg/sub-01_task-x_eeg.set"},
        )

    def test_primary_not_at_head_maps_to_nothing(self):
        self.assertEqual(affected_primaries("sub-09/eeg/sub-09_eeg.set", self.bd), set())

    def test_fdt_companion_maps_to_set(self):
        self.assertEqual(
            affected_primaries("sub-01/eeg/sub-01_task-x_eeg.fdt", self.bd),
            {"sub-01/eeg/sub-01_task-x_eeg.set"},
        )

    def test_brainvision_companions_map_to_vhdr(self):
        for comp in ("sub-01/eeg/sub-01_eeg.eeg", "sub-01/eeg/sub-01_eeg.vmrk"):
            self.assertEqual(
                affected_primaries(comp, self.bd), {"sub-01/eeg/sub-01_eeg.vhdr"}
            )

    def test_events_maps_to_same_base_primaries(self):
        self.assertEqual(
            affected_primaries("sub-01/eeg/sub-01_task-x_events.tsv", self.bd),
            {"sub-01/eeg/sub-01_task-x_eeg.set"},
        )


class TestComputeWorklist(unittest.TestCase):
    def setUp(self):
        self.head = [
            "dataset_description.json",
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-01/eeg/sub-01_task-x_eeg.fdt",
            "sub-01/eeg/sub-01_task-x_events.tsv",
            "sub-02/eeg/sub-02_task-x_eeg.set",
        ]

    def test_full_converts_every_primary(self):
        convert, remove = compute_worklist(self.head, [], full=True)
        self.assertEqual(
            convert,
            ["sub-01/eeg/sub-01_task-x_eeg.set", "sub-02/eeg/sub-02_task-x_eeg.set"],
        )
        self.assertEqual(remove, [])

    def test_modify_primary(self):
        convert, remove = compute_worklist(
            self.head, [("M", "sub-01/eeg/sub-01_task-x_eeg.set")], full=False
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])
        self.assertEqual(remove, [])

    def test_modify_events_only(self):
        convert, _ = compute_worklist(
            self.head, [("M", "sub-01/eeg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])

    def test_modify_companion_only(self):
        convert, _ = compute_worklist(
            self.head, [("M", "sub-01/eeg/sub-01_task-x_eeg.fdt")], full=False
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])

    def test_delete_primary_removes_store(self):
        head = [p for p in self.head if p != "sub-02/eeg/sub-02_task-x_eeg.set"]
        convert, remove = compute_worklist(
            head, [("D", "sub-02/eeg/sub-02_task-x_eeg.set")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-02/eeg/sub-02_task-x_eeg.zarr"])

    def test_rename_is_remove_plus_convert(self):
        # git diff --no-renames emits D old + A new
        head = [
            "sub-01/eeg/sub-01_task-y_eeg.set",  # renamed-to exists at HEAD
        ]
        convert, remove = compute_worklist(
            head,
            [
                ("D", "sub-01/eeg/sub-01_task-x_eeg.set"),
                ("A", "sub-01/eeg/sub-01_task-y_eeg.set"),
            ],
            full=False,
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-y_eeg.set"])
        self.assertEqual(remove, ["sub-01/eeg/sub-01_task-x_eeg.zarr"])

    def test_delete_events_reconverts_sibling(self):
        # events.tsv removed but the recording remains -> rebuild without events
        convert, remove = compute_worklist(
            self.head, [("D", "sub-01/eeg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])
        self.assertEqual(remove, [])

    def test_metadata_only_change_is_empty(self):
        convert, remove = compute_worklist(
            self.head, [("M", "dataset_description.json")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, [])


class TestSidecarRebuildsDirectoryRecordings(unittest.TestCase):
    """#1106: an events/companion edit beside a DIRECTORY recording must rebuild it.

    `by_dir` was keyed on file heads only, so `affected_primaries` got an empty
    bucket for a CTF `.ds` / MEF3 `.mefd` / 4D-BTi directory and an events edit
    queued nothing at all. The `--clean` cron papered over it on the next full
    rebuild, which is why it stayed invisible.
    """

    CTF = [
        "dataset_description.json",
        "sub-01/meg/sub-01_task-x_meg.ds/res4",
        "sub-01/meg/sub-01_task-x_meg.ds/meg4",
        "sub-01/meg/sub-01_task-x_events.tsv",
    ]
    MEFD = [
        "sub-01/ieeg/sub-01_task-x_ieeg.mefd/segment.1/x.rdat",
        "sub-01/ieeg/sub-01_task-x_ieeg.mefd/segment.1/x.ridx",
        "sub-01/ieeg/sub-01_task-x_events.tsv",
    ]
    BTI = [
        "sub-01/meg/sub-01_task-x_meg/c,rfDC",
        "sub-01/meg/sub-01_task-x_meg/config",
        "sub-01/meg/sub-01_task-x_meg/hs_file",
        "sub-01/meg/sub-01_task-x_events.tsv",
    ]

    def test_events_edit_rebuilds_ctf_ds(self):
        convert, remove = compute_worklist(
            self.CTF, [("M", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_events_edit_rebuilds_mefd(self):
        convert, _ = compute_worklist(
            self.MEFD, [("M", "sub-01/ieeg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/ieeg/sub-01_task-x_ieeg.mefd"])

    def test_events_edit_rebuilds_bti(self):
        convert, _ = compute_worklist(
            self.BTI, [("M", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg"])

    def test_events_added_rebuilds(self):
        convert, _ = compute_worklist(
            self.CTF, [("A", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])

    def test_events_deleted_still_rebuilds_without_events(self):
        # The recording survives, so it must be regenerated WITHOUT the events
        # block rather than left carrying stale annotations.
        head = [p for p in self.CTF if not p.endswith("_events.tsv")]
        convert, remove = compute_worklist(
            head, [("D", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_events_for_a_different_task_does_not_rebuild(self):
        # Guards against the fix over-matching: same directory, different entities.
        head = [*self.CTF, "sub-01/meg/sub-01_task-y_events.tsv"]
        convert, _ = compute_worklist(
            head, [("M", "sub-01/meg/sub-01_task-y_events.tsv")], full=False
        )
        self.assertEqual(convert, [])

    def test_only_the_matching_recording_rebuilds_among_siblings(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/res4",
            "sub-01/meg/sub-01_task-y_meg.ds/res4",
            "sub-01/meg/sub-01_task-x_events.tsv",
        ]
        convert, _ = compute_worklist(
            head, [("M", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])

    def test_file_and_directory_recordings_coexist_in_one_directory(self):
        # A directory recording must not displace a file primary sharing the dir.
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/res4",
            "sub-01/meg/sub-01_task-x_meg.fif",
            "sub-01/meg/sub-01_task-x_events.tsv",
        ]
        convert, _ = compute_worklist(
            head, [("M", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(
            convert,
            ["sub-01/meg/sub-01_task-x_meg.ds", "sub-01/meg/sub-01_task-x_meg.fif"],
        )

    def test_change_inside_the_recording_directory_still_rebuilds(self):
        # Regression guard: this path is resolved by `dir_recording_of` BEFORE
        # `by_dir` is consulted, and must stay that way.
        convert, remove = compute_worklist(
            self.CTF, [("M", "sub-01/meg/sub-01_task-x_meg.ds/meg4")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_unrelated_sidecar_in_another_directory_does_not_rebuild(self):
        head = [*self.CTF, "sub-02/meg/sub-02_task-x_events.tsv"]
        convert, _ = compute_worklist(
            head, [("M", "sub-02/meg/sub-02_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, [])

    def test_session_run_and_acq_entities_route_to_the_right_run(self):
        # The flat sub-01 fixtures above are not how CTF/MEF3 data actually
        # arrives: these are precisely the multi-session, multi-run formats. The
        # entities-base matching is shared with file primaries, but it had never
        # been exercised on a directory recording, so pin it.
        head = [
            "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-1_meg.ds/res4",
            "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-2_meg.ds/res4",
            "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-1_events.tsv",
            "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-2_events.tsv",
            "sub-01/ses-02/meg/sub-01_ses-02_task-x_acq-hi_run-1_meg.ds/res4",
            "sub-01/ses-02/meg/sub-01_ses-02_task-x_acq-hi_run-1_events.tsv",
        ]
        convert, _ = compute_worklist(
            head,
            [("M", "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-2_events.tsv")],
            full=False,
        )
        self.assertEqual(
            convert, ["sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-2_meg.ds"]
        )
        # And the same-numbered run in the OTHER session is untouched.
        convert, _ = compute_worklist(
            head,
            [("M", "sub-01/ses-02/meg/sub-01_ses-02_task-x_acq-hi_run-1_events.tsv")],
            full=False,
        )
        self.assertEqual(
            convert, ["sub-01/ses-02/meg/sub-01_ses-02_task-x_acq-hi_run-1_meg.ds"]
        )


class TestMergeIndex(unittest.TestCase):
    def test_upsert_remove_and_carry_over(self):
        prior = {
            "source_commit": SHA_OLD,
            "stores": [
                {"zarr": "sub-01/eeg/a_eeg.zarr", "store": "old-a"},
                {"zarr": "sub-02/eeg/b_eeg.zarr", "store": "keep-b"},
            ],
        }
        converted = [{"zarr": "sub-01/eeg/a_eeg.zarr", "store": "new-a"}]
        index = merge_index(
            prior, "nm000104", SHA_NEW, converted, ["sub-02/eeg/b_eeg.zarr"], "2026-06-02T00:00:00Z"
        )
        self.assertEqual(index["source_commit"], SHA_NEW)
        self.assertEqual(index["store_count"], 1)
        self.assertEqual(index["format"], "nemar-zarr-index")
        # v3 normalizes every published entry, this run's and the carried-over
        # ones alike, so one index never mixes shapes (see _normalize_store_entry).
        self.assertEqual(
            index["stores"],
            [{
                "zarr": "sub-01/eeg/a_eeg.zarr",
                "store": "new-a",
                "source_tree": "raw",
                "derived": False,
            }],
        )

    def test_no_prior_builds_fresh(self):
        index = merge_index(
            None, "nm000104", SHA_NEW, [{"zarr": "x/y_eeg.zarr"}], [], "2026-06-02T00:00:00Z"
        )
        self.assertEqual(index["store_count"], 1)
        self.assertEqual([s["zarr"] for s in index["stores"]], ["x/y_eeg.zarr"])

    def test_stores_sorted_by_zarr_path(self):
        converted = [{"zarr": "b.zarr"}, {"zarr": "a.zarr"}]
        index = merge_index(None, "nm000104", SHA_NEW, converted, [], "2026-06-02T00:00:00Z")
        self.assertEqual([s["zarr"] for s in index["stores"]], ["a.zarr", "b.zarr"])


class TestKeptManifestSeed(unittest.TestCase):
    KEPT = {"sub-01/eeg/a_eeg.zarr"}

    def seed(self, reader):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            seed = generate_zarr.kept_manifest_seed("b", "nm000276", self.KEPT, read=reader)
        return seed, out.getvalue()

    def test_it_carries_exactly_the_kept_stores_entries(self):
        live = {"stores": [
            {"zarr": "sub-01/eeg/a_eeg.zarr", "source_key": "K", "size_bytes": 5},
            {"zarr": "sub-02/eeg/b_eeg.zarr", "source_key": "L", "size_bytes": 6},
        ]}
        seed, log = self.seed(lambda _b, _k: live)
        self.assertEqual([e["zarr"] for e in seed["stores"]], ["sub-01/eeg/a_eeg.zarr"])
        self.assertEqual(log, "")

    def test_an_absent_manifest_is_a_warning_not_silence(self):
        seed, log = self.seed(lambda _b, _k: None)
        self.assertEqual(seed, {"stores": []})
        self.assertIn("no published manifest to carry 1 kept store(s)", log)

    def test_a_failed_read_is_a_warning_naming_the_error(self):
        def broken(_bucket, _key):
            raise RuntimeError("aws s3 cp exited 1: AccessDenied")

        seed, log = self.seed(broken)
        self.assertEqual(seed, {"stores": []})
        self.assertIn(
            "could not read the published manifest (aws s3 cp exited 1: AccessDenied)", log
        )
        self.assertIn("1 kept store(s) will have no source_key", log)


class TestMergeIndexDeferredRecordings(unittest.TestCase):
    """A recording the scratch gate deferred is neither an attempt nor a conversion:
    it must not spend an attempt, and it must not make the index serve less than
    it did. ``--clean`` hands the merge no prior, so every case below that matters
    runs with prior=None and the published index as the seed."""

    A = "sub-01/eeg/sub-01_task-a_eeg.edf"
    B = "sub-02/eeg/sub-02_task-a_eeg.edf"
    NOW = "2026-10-06T00:00:00Z"
    NOTE = "deferred: needs 500.0 GiB of scratch, 100 GiB available"

    def store(self, path):
        return {"path": path, "zarr": store_rel_for(path)}

    def merge(self, deferred, *, seed=None, seed_current=False, prior=None,
              prior_pending=None, converted=(), failures=None, discovered=None):
        index = merge_index(
            prior, "nm000276", SHA_NEW, list(converted), [], self.NOW,
            failures or [], [],
            discovered=discovered or [self.A, self.B], prior_pending=prior_pending,
            deferred=deferred, seed=seed, seed_current=seed_current,
        )
        check_index_invariant(index)
        return index

    def pending(self, index):
        return {p["path"]: p for p in index["pending"]}

    def test_a_current_store_stays_served_under_clean(self):
        seed = {"stores": [self.store(self.A)], "pending": []}
        index = self.merge({self.A: self.NOTE}, seed=seed, seed_current=True, discovered=[self.A])
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        self.assertEqual(index["pending"], [])
        self.assertEqual(index["store_count"], 1)

    def test_a_stale_store_leaves_the_index_and_is_listed_pending(self):
        seed = {"stores": [self.store(self.A)], "pending": []}
        index = self.merge({self.A: self.NOTE}, seed=seed, seed_current=False, discovered=[self.A])
        self.assertEqual(index["stores"], [])
        entry = self.pending(index)[self.A]
        self.assertEqual((entry["reason"], entry["attempts"]), ("not_attempted", 0))
        self.assertEqual(entry["last_error"], self.NOTE)

    def test_an_incremental_merge_drops_a_stale_carried_store_too(self):
        prior = {"source_commit": SHA_OLD, "stores": [self.store(self.A)], "pending": []}
        index = self.merge(
            {self.A: self.NOTE}, prior=prior, seed=prior, seed_current=False, discovered=[self.A]
        )
        self.assertEqual(index["stores"], [])
        self.assertEqual(list(self.pending(index)), [self.A])

    def test_a_recording_with_no_store_is_pending_not_attempted(self):
        index = self.merge({self.B: self.NOTE}, seed={"stores": []}, discovered=[self.B])
        entry = self.pending(index)[self.B]
        self.assertEqual((entry["reason"], entry["attempts"]), ("not_attempted", 0))
        self.assertIsNone(entry["last_attempt_utc"])

    def test_a_deferral_keeps_the_attempts_and_the_last_error_it_already_had(self):
        history = [{
            "path": self.B, "zarr": store_rel_for(self.B), "reason": "infra_failure",
            "attempts": 3, "last_error": "RuntimeError: No space left on device",
            "last_attempt_utc": "2026-10-05T00:00:00Z",
        }]
        index = self.merge(
            {self.B: self.NOTE}, seed={"pending": history}, prior_pending=history,
            discovered=[self.B],
        )
        entry = self.pending(index)[self.B]
        self.assertEqual(entry["reason"], "not_attempted")
        self.assertEqual(entry["attempts"], 3, "a deferral is not an attempt")
        self.assertEqual(entry["last_attempt_utc"], "2026-10-05T00:00:00Z")
        self.assertEqual(
            entry["last_error"], f"{self.NOTE}; last error: RuntimeError: No space left on device"
        )

    def test_deferring_again_replaces_the_note_instead_of_chaining_it(self):
        history = [{
            "path": self.B, "zarr": store_rel_for(self.B), "reason": "not_attempted",
            "attempts": 3,
            "last_error": "deferred: needs 400 GiB of scratch, 90 GiB available; last error: boom",
            "last_attempt_utc": None,
        }]
        index = self.merge(
            {self.B: self.NOTE}, seed={"pending": history}, prior_pending=history,
            discovered=[self.B],
        )
        self.assertEqual(
            self.pending(index)[self.B]["last_error"], f"{self.NOTE}; last error: boom"
        )
        bare = [{
            **history[0],
            "last_error": "deferred: needs 400 GiB of scratch, 90 GiB available",
        }]
        index = self.merge(
            {self.B: self.NOTE}, seed={"pending": bare}, prior_pending=bare, discovered=[self.B]
        )
        self.assertEqual(self.pending(index)[self.B]["last_error"], self.NOTE)

    def test_a_deferred_recording_at_the_attempt_cap_is_not_promoted_to_exhausted(self):
        # The cap exists so a recording that keeps failing stops consuming the queue.
        # A disk-full node must not be able to trip it for a healthy recording.
        history = [{
            "path": self.B, "zarr": store_rel_for(self.B), "reason": "infra_failure",
            "attempts": generate_zarr.PENDING_MAX_ATTEMPTS, "last_error": "x",
            "last_attempt_utc": None,
        }]
        index = self.merge(
            {self.B: self.NOTE}, seed={"pending": history}, prior_pending=history,
            discovered=[self.B],
        )
        self.assertEqual(index["failures"], [])
        self.assertEqual(
            self.pending(index)[self.B]["attempts"], generate_zarr.PENDING_MAX_ATTEMPTS
        )

    def test_a_typed_failure_on_record_stays_a_failure_when_the_index_is_current(self):
        failure = generate_zarr._failure_entry(self.B, "not_continuous", "epoched")
        index = self.merge(
            {self.B: self.NOTE}, seed={"failures": [failure]}, seed_current=True,
            discovered=[self.B],
        )
        self.assertEqual([f["path"] for f in index["failures"]], [self.B])
        self.assertEqual(index["pending"], [])

    def test_a_stale_typed_failure_is_not_published_as_final(self):
        # The verdict was reached on older data or by an older engine, and a failure
        # is never retried: it goes back to pending so a later round reads it again.
        failure = generate_zarr._failure_entry(self.B, "not_continuous", "epoched")
        for label, kwargs in (
            ("clean", {"seed": {"failures": [failure]}}),
            ("incremental", {"prior": {"failures": [failure]}, "seed": {"failures": [failure]}}),
        ):
            with self.subTest(label):
                index = self.merge(
                    {self.B: self.NOTE}, seed_current=False, discovered=[self.B], **kwargs
                )
                self.assertEqual(index["failures"], [])
                entry = self.pending(index)[self.B]
                self.assertEqual((entry["reason"], entry["attempts"]), ("not_attempted", 0))

    def test_the_note_is_bounded(self):
        index = self.merge({self.B: "deferred: " + "x" * 1000}, seed={}, discovered=[self.B])
        self.assertLessEqual(len(self.pending(index)[self.B]["last_error"]), 300)

    def test_what_converted_this_run_is_untouched_by_a_neighbors_deferral(self):
        converted = [{"path": self.A, "zarr": store_rel_for(self.A)}]
        index = self.merge({self.B: self.NOTE}, seed={}, converted=converted)
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        self.assertEqual(list(self.pending(index)), [self.B])

    def test_without_a_deferral_nothing_changes(self):
        index = self.merge(None, seed={"stores": [self.store(self.A)]}, discovered=[self.A])
        self.assertEqual(index["stores"], [])
        self.assertEqual(self.pending(index)[self.A]["reason"], "not_attempted")


class TestIndexCurrencyProblem(unittest.TestCase):
    ROW = {"concept_doi": "10.1/x", "license": "CC0"}

    def index(self, **over):
        base = {
            "source_commit": SHA_NEW, "engine_version": ZARR_ENGINE_VERSION,
            "biosigio_version": "1.2.10", **generate_zarr.index_provenance(self.ROW),
        }
        return {**base, **over}

    def problem(self, index, **over):
        args = {"head": SHA_NEW, "dataset_row": self.ROW, "row_fetch_failed": False,
                "biosigio_version": "1.2.10", **over}
        return generate_zarr.index_currency_problem(
            index, args["head"], args["dataset_row"], args["row_fetch_failed"],
            args["biosigio_version"],
        )

    def test_a_matching_index_is_current(self):
        self.assertIsNone(self.problem(self.index()))

    def test_an_unreadable_catalog_keeps_a_store_but_never_licenses_a_retry_round(self):
        index = self.index()
        generate_zarr_problem = generate_zarr.index_currency_problem
        self.assertIsNone(
            generate_zarr_problem(
                index, SHA_NEW, None, True, "1.2.10", provenance_unknown_ok=True
            )
        )
        self.assertIn(
            "catalog", generate_zarr_problem(index, SHA_NEW, None, True, "1.2.10")
        )
        # The other three comparisons still run when only provenance is unknowable.
        self.assertIn(
            "different commit",
            generate_zarr_problem(
                self.index(source_commit=SHA_OLD), SHA_NEW, None, True, "1.2.10",
                provenance_unknown_ok=True,
            ),
        )

    def test_each_difference_is_named(self):
        self.assertIn("no published index", self.problem(None))
        self.assertIn("different commit", self.problem(self.index(source_commit=SHA_OLD)))
        self.assertIn("different engine", self.problem(self.index(engine_version="0")))
        self.assertIn("different biosigIO", self.problem(self.index(biosigio_version="0")))
        self.assertIn("provenance", self.problem(self.index(license="MIT")))
        self.assertIn("catalog", self.problem(self.index(), row_fetch_failed=True))


class TestDeferralLeavesIndexAsIs(unittest.TestCase):
    A, B = "sub-01/eeg/a_eeg.edf", "sub-02/eeg/b_eeg.edf"
    NOTE = "deferred: needs 500 GiB of scratch, 100 GiB available"

    def live(self, **over):
        base = {
            "stores": [{"path": self.A, "zarr": "sub-01/eeg/a_eeg.zarr"}],
            "pending": [{"path": self.B, "reason": "not_attempted", "last_error": self.NOTE}],
            "failures": [],
        }
        return {**base, **over}

    def check(
        self, live, deferred=None, current=True, convert=None, remove=(), failed=(), wipe=False
    ):
        deferred = {self.A: self.NOTE, self.B: self.NOTE} if deferred is None else deferred
        return generate_zarr.deferral_leaves_index_as_is(
            live, current, convert if convert is not None else [self.A, self.B], deferred,
            list(remove), list(failed), wipe,
        )

    def test_a_store_it_may_keep_and_a_pending_entry_with_a_note_change_nothing(self):
        self.assertTrue(self.check(self.live()))

    def test_a_stale_store_is_a_real_change(self):
        self.assertFalse(self.check(self.live(), current=False))

    def test_an_older_infra_failure_reason_is_a_change_the_first_time(self):
        pending = [{"path": self.B, "reason": "infra_failure", "last_error": "No space"}]
        self.assertFalse(self.check(self.live(pending=pending)))

    def test_a_pending_entry_without_a_note_is_a_change(self):
        pending = [{"path": self.B, "reason": "not_attempted", "last_error": None}]
        self.assertFalse(self.check(self.live(pending=pending)))

    def test_something_converted_or_removed_or_failed_is_not_all_deferred(self):
        self.assertFalse(self.check(self.live(), convert=[self.A, self.B, "c_eeg.edf"]))
        self.assertFalse(self.check(self.live(), remove=["x.zarr"]))
        self.assertFalse(self.check(self.live(), failed=[self.A]))

    def test_no_published_index_or_a_wipe_always_publishes(self):
        self.assertFalse(self.check(None))
        self.assertFalse(self.check(self.live(), wipe=True))
        self.assertFalse(self.check(self.live(), deferred={}))

    def test_a_typed_failure_on_record_changes_nothing_when_the_index_is_current(self):
        live = self.live(pending=[], failures=[{"path": self.B, "code": "not_continuous"}])
        self.assertTrue(self.check(live))

    def test_a_typed_failure_under_a_stale_index_is_a_real_change(self):
        live = self.live(pending=[], failures=[{"path": self.B, "code": "not_continuous"}])
        self.assertFalse(
            self.check(live, deferred={self.B: self.NOTE}, convert=[self.B], current=False)
        )


class TestSafeStorePrefix(unittest.TestCase):
    def test_valid_store_path(self):
        self.assertEqual(
            safe_store_prefix("nemar", "nm000104", "sub-01/eeg/sub-01_task-x_eeg.zarr"),
            "s3://nemar/nm000104/zarr/sub-01/eeg/sub-01_task-x_eeg.zarr/",
        )

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            safe_store_prefix("nemar", "nm000104", "")

    def test_rejects_non_zarr(self):
        with self.assertRaises(ValueError):
            safe_store_prefix("nemar", "nm000104", "sub-01/eeg/sub-01_eeg.set")

    def test_rejects_traversal(self):
        for bad in ("../escape.zarr", "sub-01/../../x.zarr", "/abs/x.zarr", "a//b.zarr"):
            with self.assertRaises(ValueError):
                safe_store_prefix("nemar", "nm000104", bad)


class TestMaterializeLocal(unittest.TestCase):
    def test_resolves_working_tree_paths_and_annex_key(self):
        key = "SHA256E-s100--abcdef.set"
        primary = "sub-01/eeg/sub-01_task-x_eeg.set"
        events = "sub-01/eeg/sub-01_task-x_events.tsv"
        with tempfile.TemporaryDirectory() as repo:
            os.makedirs(os.path.join(repo, "sub-01", "eeg"))
            # annex-style symlink for the primary; a plain file for the events sidecar
            os.symlink(
                f"../../.git/annex/objects/aa/bb/{key}/{key}",
                os.path.join(repo, primary),
            )
            with open(os.path.join(repo, events), "w") as fh:
                fh.write("onset\tduration\n0\t0\n")
            pl, el, k = materialize_local(repo, primary, {primary, events})
            self.assertEqual(pl, os.path.join(repo, primary))
            self.assertEqual(el, os.path.join(repo, events))
            self.assertEqual(k, key)

    def test_no_events_sibling_when_absent(self):
        primary = "sub-02/eeg/sub-02_task-x_eeg.edf"
        with tempfile.TemporaryDirectory() as repo:
            os.makedirs(os.path.join(repo, "sub-02", "eeg"))
            with open(os.path.join(repo, primary), "w") as fh:
                fh.write("not-an-annex-blob")  # regular in-git file -> key None
            pl, el, k = materialize_local(repo, primary, {primary})
            self.assertEqual(pl, os.path.join(repo, primary))
            self.assertIsNone(el)
            self.assertIsNone(k)


class TestParseAnnexKey(unittest.TestCase):
    def test_locked_symlink_target(self):
        key = "SHA256E-s12345--abcdef0123456789.set"
        target = f"../../.git/annex/objects/aa/bb/{key}/{key}"
        self.assertEqual(parse_annex_key(target), key)

    def test_unlocked_pointer_content(self):
        key = "MD5E-s59778400--abc.edf"
        self.assertEqual(parse_annex_key(f"/annex/objects/{key}"), key)

    def test_non_annex_blob_returns_none(self):
        self.assertIsNone(parse_annex_key("just some file contents\n"))


class TestBidsSuffixModality(unittest.TestCase):
    def test_known_suffixes_map_to_modality(self):
        self.assertEqual(bids_suffix_modality("sub-01/eeg/sub-01_task-rest_eeg.set"), "EEG")
        self.assertEqual(bids_suffix_modality("sub-01/meg/sub-01_task-rest_meg.fif"), "MEG")
        self.assertEqual(bids_suffix_modality("sub-01/ieeg/sub-01_task-rest_ieeg.edf"), "IEEG")
        self.assertEqual(bids_suffix_modality("sub-01/emg/sub-01_task-grip_emg.edf"), "EMG")

    def test_suffix_is_case_insensitive_and_uses_basename(self):
        self.assertEqual(bids_suffix_modality("X/sub-01_task-A_EEG.SET"), "EEG")

    def test_unknown_or_missing_suffix_returns_none(self):
        self.assertIsNone(bids_suffix_modality("sub-01/beh/sub-01_task-rest_physio.tsv"))
        self.assertIsNone(bids_suffix_modality("sub-01/eeg/sub-01_channels.tsv"))
        self.assertIsNone(bids_suffix_modality("noextnounderscore"))


class TestPowerLineFrequencyFor(unittest.TestCase):
    def _write(self, root: str, rel: str, body: dict) -> None:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(body, fh)

    def test_sibling_sidecar_wins_over_root(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_eeg.json", {"PowerLineFrequency": 60})
            self._write(d, "task-rest_eeg.json", {"PowerLineFrequency": 50})  # less specific
            head = {"sub-01/eeg/sub-01_task-rest_eeg.json", "task-rest_eeg.json"}
            self.assertEqual(power_line_frequency_for(d, rec, head, "HEAD"), 60.0)

    def test_inherited_from_root_when_no_sibling(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "task-rest_eeg.json", {"PowerLineFrequency": 50})
            head = {"task-rest_eeg.json"}
            self.assertEqual(power_line_frequency_for(d, rec, head, "HEAD"), 50.0)

    def test_none_when_field_absent(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_eeg.json", {"SamplingFrequency": 1024})
            head = {"sub-01/eeg/sub-01_task-rest_eeg.json"}
            self.assertIsNone(power_line_frequency_for(d, rec, head, "HEAD"))

    def test_non_subset_entities_do_not_apply(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            # A sidecar for a different task must not apply to this recording.
            self._write(d, "sub-01/eeg/sub-01_task-other_eeg.json", {"PowerLineFrequency": 60})
            head = {"sub-01/eeg/sub-01_task-other_eeg.json"}
            self.assertIsNone(power_line_frequency_for(d, rec, head, "HEAD"))

    def test_wrong_suffix_does_not_satisfy(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_ieeg.json", {"PowerLineFrequency": 60})
            head = {"sub-01/eeg/sub-01_task-rest_ieeg.json"}
            self.assertIsNone(power_line_frequency_for(d, rec, head, "HEAD"))

    def test_non_numeric_value_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_eeg.json", {"PowerLineFrequency": "n/a"})
            head = {"sub-01/eeg/sub-01_task-rest_eeg.json"}
            self.assertIsNone(power_line_frequency_for(d, rec, head, "HEAD"))

    def test_a_utf8_bom_sidecar_is_honored(self):
        # Behavior change (#1527): the strict UTF-8 read kept the BOM, so
        # json.loads raised and this sidecar was silently skipped (PLF None).
        # It now parses, and quietly: a UTF-8 BOM is still UTF-8.
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            sidecar = "sub-01/eeg/sub-01_task-rest_eeg.json"
            os.makedirs(os.path.join(d, "sub-01", "eeg"))
            with open(os.path.join(d, sidecar), "wb") as fh:
                fh.write(b"\xef\xbb\xbf" + json.dumps({"PowerLineFrequency": 50}).encode())
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(power_line_frequency_for(d, rec, {sidecar}, "HEAD"), 50.0)
            self.assertEqual(out.getvalue(), "")

    def test_reads_via_git_when_no_working_tree(self):
        # The workflow clones --no-checkout, so the sidecar is only in the git
        # object store, not on disk. Resolution must fall back to `git cat-file`.
        sidecar = "sub-01/eeg/sub-01_task-rest_eeg.json"
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as clone_parent:
            self._write(src, sidecar, {"PowerLineFrequency": 60})
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }
            def run(*a: str) -> None:
                subprocess.run(a, check=True, env=env, capture_output=True)

            run("git", "-C", src, "init", "-q", "-b", "main")
            run("git", "-C", src, "add", "-A")
            run("git", "-C", src, "commit", "-qm", "init")
            clone = os.path.join(clone_parent, "repo")
            run("git", "clone", "--no-checkout", "-q", src, clone)
            self.assertFalse(os.path.exists(os.path.join(clone, sidecar)))  # no working tree
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self.assertEqual(
                power_line_frequency_for(clone, rec, {sidecar}, "HEAD"), 60.0
            )


class TestEmbedRootAttr(unittest.TestCase):
    def test_adds_attribute_and_preserves_existing(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "zarr_format": 3,
                        "node_type": "group",
                        "attributes": {"format": "biosigio-zarr", "channel_groups": ["eeg_250hz"]},
                    },
                    fh,
                )
            embed_root_attr(store, "power_line_frequency", 60.0)
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["attributes"]["power_line_frequency"], 60.0)
            self.assertEqual(doc["attributes"]["channel_groups"], ["eeg_250hz"])  # preserved


class TestEmbedAttr(unittest.TestCase):
    """embed_attr writes into an arbitrary group zarr.json, not only the store root."""

    def _make_zarr_json(self, path: str, attrs: dict) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"zarr_format": 3, "node_type": "group", "attributes": attrs}, fh)

    def test_writes_into_sub_group_zarr_json(self):
        with tempfile.TemporaryDirectory() as d:
            meta = os.path.join(d, "rec.zarr", "events", "zarr.json")
            self._make_zarr_json(meta, {"n_events": 42, "label_map": {}})
            embed_attr(meta, "value_descriptions", {"21": "stimulus - face"})
            with open(meta, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["attributes"]["value_descriptions"], {"21": "stimulus - face"})
            self.assertEqual(doc["attributes"]["n_events"], 42)  # preserved

    def test_creates_attributes_when_absent(self):
        with tempfile.TemporaryDirectory() as d:
            meta = os.path.join(d, "zarr.json")
            with open(meta, "w", encoding="utf-8") as fh:
                json.dump({"zarr_format": 3}, fh)
            embed_attr(meta, "my_key", "my_value")
            with open(meta, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["attributes"]["my_key"], "my_value")

    def test_embed_root_attr_delegates(self):
        """embed_root_attr must still work (it now delegates to embed_attr)."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump({"zarr_format": 3, "attributes": {"x": 1}}, fh)
            embed_root_attr(store, "power_line_frequency", 50.0)
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["attributes"]["power_line_frequency"], 50.0)
            self.assertEqual(doc["attributes"]["x"], 1)


class TestFixSourceFileAttr(unittest.TestCase):
    """recording_metadata.source_file must be the reproducible BIDS-repo-
    relative path, not the conversion host's ephemeral scratch path biosigIO
    was handed (nemarOrg/nemar-cli#1102)."""

    def _make_store(self, d: str, recording_metadata: dict) -> str:
        store = os.path.join(d, "rec.zarr")
        os.makedirs(store)
        with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "zarr_format": 3,
                    "node_type": "group",
                    "attributes": {
                        "format": "biosigio-zarr",
                        "channel_groups": ["eeg_250hz"],
                        "recording_metadata": recording_metadata,
                    },
                },
                fh,
            )
        return store

    def test_overwrites_scratch_path_with_bids_relpath(self):
        with tempfile.TemporaryDirectory() as d:
            store = self._make_store(
                d,
                {
                    "source_file": (
                        "/mnt/local/zarr-scratch/tmpv58rz85q/work/"
                        "sub-1_task-x_eeg.bdf/sub-1_task-x_eeg.bdf"
                    ),
                    "source_format": "bdf",
                },
            )
            bids_path = "sub-1/eeg/sub-1_task-x_eeg.bdf"
            fix_source_file_attr(store, bids_path)
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            rec_meta = doc["attributes"]["recording_metadata"]
            self.assertEqual(rec_meta["source_file"], bids_path)
            self.assertEqual(rec_meta["source_format"], "bdf")  # other keys preserved
            self.assertEqual(
                doc["attributes"]["channel_groups"], ["eeg_250hz"]
            )  # sibling root attrs preserved

    def test_reconversion_is_reproducible_across_different_scratch_dirs(self):
        # The whole point: two runs with DIFFERENT mkdtemp scratch dirs must
        # converge on the SAME source_file once fixed, since only the fix
        # (not biosigIO) determines the published value.
        bids_path = "sub-1/eeg/sub-1_task-x_eeg.bdf"
        results = []
        for tmp_name in ("tmpaaaaaaaa", "tmpbbbbbbbb"):
            with tempfile.TemporaryDirectory() as d:
                store = self._make_store(
                    d,
                    {"source_file": f"/mnt/local/zarr-scratch/{tmp_name}/work/x.bdf"},
                )
                fix_source_file_attr(store, bids_path)
                with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                    doc = json.load(fh)
                results.append(doc["attributes"]["recording_metadata"]["source_file"])
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0], bids_path)

    def test_missing_recording_metadata_does_not_raise(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump({"zarr_format": 3, "attributes": {"format": "biosigio-zarr"}}, fh)
            fix_source_file_attr(store, "sub-1/eeg/sub-1_task-x_eeg.bdf")  # must not raise
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertNotIn("recording_metadata", doc["attributes"])  # not fabricated

    def test_explicit_null_attributes_does_not_raise(self):
        # `"attributes": null` makes .get("attributes", {}) return None, so a
        # chained .get would raise AttributeError rather than skipping cleanly.
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump({"zarr_format": 3, "attributes": None}, fh)
            fix_source_file_attr(store, "sub-1/eeg/sub-1_task-x_eeg.bdf")  # must not raise

    def test_rewrite_leaves_no_temp_file_and_keeps_zarr_json_parseable(self):
        # The rewrite goes through a sibling temp + os.replace so an interruption
        # can never leave a truncated zarr.json that validate_store (which only
        # checks existence) would wave through.
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "zarr_format": 3,
                        "attributes": {
                            "format": "biosigio-zarr",
                            "recording_metadata": {"source_file": "/mnt/local/zarr-scratch/t/x.bdf"},
                        },
                    },
                    fh,
                )
            fix_source_file_attr(store, "sub-1/eeg/sub-1_task-x_eeg.bdf")
            self.assertEqual(sorted(os.listdir(store)), ["zarr.json"])  # no .tmp left behind
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)  # parses, i.e. not truncated
            self.assertEqual(
                doc["attributes"]["recording_metadata"]["source_file"],
                "sub-1/eeg/sub-1_task-x_eeg.bdf",
            )
            self.assertEqual(doc["attributes"]["format"], "biosigio-zarr")  # siblings intact


class TestEventDescriptionsFor(unittest.TestCase):
    def _write(self, root: str, rel: str, body: dict) -> None:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(body, fh)

    def test_sibling_sidecar_wins_over_root(self):
        """Most-specific sidecar overrides less-specific one for the same code."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            # Root-level (less specific): code 1 -> "boundary event"
            self._write(d, "task-rest_events.json", {
                "value": {"Levels": {"1": "boundary event", "21": "generic face"}},
            })
            # Sibling (more specific): code 21 overrides; code 99 is new
            self._write(d, "sub-01/eeg/sub-01_task-rest_events.json", {
                "value": {"Levels": {"21": "stimulus - face", "99": "response"}},
            })
            head = {
                "task-rest_events.json",
                "sub-01/eeg/sub-01_task-rest_events.json",
            }
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result["21"], "stimulus - face")  # sibling wins
            self.assertEqual(result["1"], "boundary event")    # root carries over
            self.assertEqual(result["99"], "response")          # sibling-only code

    def test_inherited_from_root_when_no_sibling(self):
        """on007139 pattern: events.json at dataset root, no sibling in eeg dir."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-Flanker_eeg.set"
            self._write(d, "task-Flanker_events.json", {
                "value": {"Levels": {"1": "left arrow", "2": "right arrow"}},
            })
            head = {"task-Flanker_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {"1": "left arrow", "2": "right arrow"})

    def test_merge_levels_across_multiple_columns(self):
        """Codes from 'value' and 'trial_type' columns are both captured."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-x_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-x_events.json", {
                "value": {"Levels": {"21": "stimulus - face"}},
                "trial_type": {"Levels": {"go": "go trial", "nogo": "no-go trial"}},
            })
            head = {"sub-01/eeg/sub-01_task-x_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertIn("21", result)
            self.assertIn("go", result)
            self.assertIn("nogo", result)

    def test_non_subset_entities_not_applied(self):
        """A sidecar for a different task must not apply to this recording."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-other_events.json", {
                "value": {"Levels": {"10": "face"}},
            })
            head = {"sub-01/eeg/sub-01_task-other_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {})

    def test_absent_sidecar_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            result = event_descriptions_for(d, rec, set(), "HEAD")
            self.assertEqual(result, {})

    def test_non_string_values_ignored(self):
        """Levels entries with non-string key or value are skipped."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            # JSON keys are always strings, but values might be non-string
            self._write(d, "sub-01/eeg/sub-01_task-rest_events.json", {
                "value": {"Levels": {"21": 42, "22": None, "23": "valid"}},
            })
            head = {"sub-01/eeg/sub-01_task-rest_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {"23": "valid"})

    def test_empty_string_keys_and_values_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_events.json", {
                "value": {"Levels": {"": "empty key", "21": ""}},
            })
            head = {"sub-01/eeg/sub-01_task-rest_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {})

    def test_no_levels_field_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_events.json", {
                "value": {"Description": "the event value column", "Units": "n/a"},
            })
            head = {"sub-01/eeg/sub-01_task-rest_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {})

    def test_reads_via_git_when_no_working_tree(self):
        """Mirrors the PLF git test: clone --no-checkout, must use git cat-file."""
        sidecar = "sub-01/eeg/sub-01_task-rest_events.json"
        sidecar_body = {"value": {"Levels": {"10": "face", "20": "house"}}}
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as clone_parent:
            p = os.path.join(src, sidecar)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as fh:
                json.dump(sidecar_body, fh)
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }

            def run(*a: str) -> None:
                subprocess.run(a, check=True, env=env, capture_output=True)

            run("git", "-C", src, "init", "-q", "-b", "main")
            run("git", "-C", src, "add", "-A")
            run("git", "-C", src, "commit", "-qm", "init")
            clone = os.path.join(clone_parent, "repo")
            run("git", "clone", "--no-checkout", "-q", src, clone)
            self.assertFalse(os.path.exists(os.path.join(clone, sidecar)))
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            result = event_descriptions_for(clone, rec, {sidecar}, "HEAD")
            self.assertEqual(result, {"10": "face", "20": "house"})


class TestElectrodePositionsFor(unittest.TestCase):
    """Tests for electrode_positions_for -- TSV parsing, BIDS inheritance, coordsystem."""

    def _write(self, root: str, rel: str, body: str) -> None:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(body)

    def _write_json(self, root: str, rel: str, body: dict) -> None:
        self._write(root, rel, json.dumps(body))

    def _tsv(self, *rows: tuple) -> str:
        return "\n".join("\t".join(str(c) for c in row) for row in rows) + "\n"

    # -- TSV parsing -----------------------------------------------------------

    def test_standard_tsv_parses_positions(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.784", "26.133", "-4.001"),
                ("FP2", "-80.784", "26.133", "-4.001"),
            )
            self._write(d, "sub-01/eeg/sub-01_task-rest_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_task-rest_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertAlmostEqual(result["positions"]["FP1"][0], 80.784)
            self.assertAlmostEqual(result["positions"]["FP2"][0], -80.784)

    def test_extra_columns_do_not_break_parsing(self):
        """Columns like type, impedance, status after z must be ignored."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-x_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z", "type", "impedance"),
                ("Fz", "1.0", "2.0", "3.0", "EEG", "5"),
                ("Cz", "0.0", "0.0", "4.0", "EEG", "n/a"),
            )
            self._write(d, "sub-01/eeg/sub-01_task-x_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_task-x_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertIn("Fz", result["positions"])
            self.assertIn("Cz", result["positions"])
            self.assertEqual(result["positions"]["Fz"], [1.0, 2.0, 3.0])

    def test_non_standard_column_order(self):
        """z before y before x order must still work."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("z", "name", "y", "x"),
                ("9.0", "Oz", "0.0", "0.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertEqual(result["positions"]["Oz"], [0.0, 0.0, 9.0])

    def test_na_rows_skipped(self):
        """Rows where x, y, or z is 'n/a' (case-insensitive) must be skipped."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.0", "26.0", "n/a"),
                ("FP2", "N/A", "26.0", "-4.0"),
                ("Cz", "0.0", "0.0", "88.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertNotIn("FP1", result["positions"])
            self.assertNotIn("FP2", result["positions"])
            self.assertIn("Cz", result["positions"])

    def test_non_numeric_rows_skipped(self):
        """Rows where x/y/z cannot be parsed as float must be skipped."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("REF", "unknown", "0.0", "0.0"),
                ("Cz", "0.0", "0.0", "88.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertNotIn("REF", result["positions"])
            self.assertIn("Cz", result["positions"])

    def test_missing_name_xyz_columns_returns_none(self):
        """A TSV without a 'name' or 'x'/'y'/'z' column must return None."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("label", "lat", "lon"),
                ("FP1", "10.0", "20.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNone(result)

    def test_all_rows_skipped_returns_none(self):
        """If all data rows are invalid (all n/a), return None."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "n/a", "n/a", "n/a"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNone(result)

    # -- BIDS inheritance ------------------------------------------------------

    def test_absent_electrodes_tsv_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            result = electrode_positions_for(d, rec, set(), "HEAD")
            self.assertIsNone(result)

    def test_sibling_beats_root(self):
        """More-specific sibling must win over a root-level electrodes.tsv."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            root_tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "1.0", "2.0", "3.0"),
            )
            sibling_tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.0", "26.0", "-4.0"),
            )
            self._write(d, "electrodes.tsv", root_tsv)
            self._write(d, "sub-01/eeg/sub-01_task-rest_electrodes.tsv", sibling_tsv)
            head = {
                "electrodes.tsv",
                "sub-01/eeg/sub-01_task-rest_electrodes.tsv",
            }
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertAlmostEqual(result["positions"]["FP1"][0], 80.0)

    def test_root_only_inheritance(self):
        """When only a root-level electrodes.tsv exists, it must be used."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.0", "26.0", "-4.0"),
            )
            self._write(d, "electrodes.tsv", tsv)
            head = {"electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertIn("FP1", result["positions"])

    def test_non_subset_entities_not_applied(self):
        """An electrodes.tsv for a different task must not apply."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("Cz", "0.0", "0.0", "88.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_task-other_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_task-other_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNone(result)

    # -- coordsystem.json ------------------------------------------------------

    def test_coordsystem_units_and_system_extracted(self):
        """EEGCoordinateSystem and EEGCoordinateUnits must appear in the result."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.0", "26.0", "-4.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_task-rest_electrodes.tsv", tsv)
            self._write_json(d, "sub-01/eeg/sub-01_task-rest_coordsystem.json", {
                "EEGCoordinateSystem": "EEGLAB",
                "EEGCoordinateUnits": "mm",
            })
            head = {
                "sub-01/eeg/sub-01_task-rest_electrodes.tsv",
                "sub-01/eeg/sub-01_task-rest_coordsystem.json",
            }
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertEqual(result["coordinate_system"], "EEGLAB")
            self.assertEqual(result["coordinate_units"], "mm")

    def test_absent_coordsystem_gives_empty_strings(self):
        """When no coordsystem.json resolves, both strings must be empty."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("Cz", "0.0", "0.0", "88.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertEqual(result["coordinate_system"], "")
            self.assertEqual(result["coordinate_units"], "")

    def test_ieeg_coordsystem_keys_extracted(self):
        """iEEGCoordinateSystem/iEEGCoordinateUnits must also be read."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/ieeg/sub-01_task-rest_ieeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("A1", "10.0", "20.0", "30.0"),
            )
            self._write(d, "sub-01/ieeg/sub-01_task-rest_electrodes.tsv", tsv)
            self._write_json(d, "sub-01/ieeg/sub-01_task-rest_coordsystem.json", {
                "iEEGCoordinateSystem": "Talairach",
                "iEEGCoordinateUnits": "mm",
            })
            head = {
                "sub-01/ieeg/sub-01_task-rest_electrodes.tsv",
                "sub-01/ieeg/sub-01_task-rest_coordsystem.json",
            }
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertEqual(result["coordinate_system"], "Talairach")
            self.assertEqual(result["coordinate_units"], "mm")

    # -- embed onto root -------------------------------------------------------

    def test_embed_electrode_attrs_onto_root(self):
        """The three attrs land on the root zarr.json and preserve existing attrs."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "zarr_format": 3,
                        "node_type": "group",
                        "attributes": {
                            "format": "biosigio-zarr",
                            "channel_groups": ["eeg_250hz"],
                            "power_line_frequency": 60.0,
                        },
                    },
                    fh,
                )
            positions = {"FP1": [80.0, 26.0, -4.0], "FP2": [-80.0, 26.0, -4.0]}
            embed_root_attr(store, "electrode_positions", positions)
            embed_root_attr(store, "electrode_coordinate_system", "EEGLAB")
            embed_root_attr(store, "electrode_coordinate_units", "mm")
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            attrs = doc["attributes"]
            self.assertEqual(attrs["electrode_positions"], positions)
            self.assertEqual(attrs["electrode_coordinate_system"], "EEGLAB")
            self.assertEqual(attrs["electrode_coordinate_units"], "mm")
            self.assertEqual(attrs["power_line_frequency"], 60.0)  # preserved
            self.assertEqual(attrs["channel_groups"], ["eeg_250hz"])  # preserved

    # -- git cat-file fallback (no-checkout clone) -----------------------------

    def test_reads_via_git_when_no_working_tree(self):
        """The workflow clones --no-checkout; must resolve via git cat-file."""
        elec_rel = "sub-01/eeg/sub-01_task-rest_electrodes.tsv"
        cs_rel = "sub-01/eeg/sub-01_task-rest_coordsystem.json"
        tsv_body = "name\tx\ty\tz\nFP1\t80.784\t26.133\t-4.001\n"
        cs_body = json.dumps({"EEGCoordinateSystem": "EEGLAB", "EEGCoordinateUnits": "mm"})
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as clone_parent:
            for rel, body in ((elec_rel, tsv_body), (cs_rel, cs_body)):
                p = os.path.join(src, rel)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(body)
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }

            def run(*a: str) -> None:
                subprocess.run(a, check=True, env=env, capture_output=True)

            run("git", "-C", src, "init", "-q", "-b", "main")
            run("git", "-C", src, "add", "-A")
            run("git", "-C", src, "commit", "-qm", "init")
            clone = os.path.join(clone_parent, "repo")
            run("git", "clone", "--no-checkout", "-q", src, clone)
            # Confirm no working tree
            self.assertFalse(os.path.exists(os.path.join(clone, elec_rel)))
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            result = electrode_positions_for(clone, rec, {elec_rel, cs_rel}, "HEAD")
            self.assertIsNotNone(result)
            self.assertAlmostEqual(result["positions"]["FP1"][0], 80.784)
            self.assertEqual(result["coordinate_system"], "EEGLAB")
            self.assertEqual(result["coordinate_units"], "mm")


class TestKitAndCtf(unittest.TestCase):
    """KIT `.con`/`.sqd`/`.kdf` files and CTF `.ds` directory recordings (the
    extension-keyed directory mechanism generalized to also cover MEF3 `.mefd`
    -- see `TestMefdRecordings` -- via `dir_recording_of`/`dir_recordings`)."""

    def test_kit_extensions_are_primary(self):
        for ext in (".con", ".sqd", ".kdf"):
            self.assertTrue(is_primary(f"sub-01/meg/sub-01_task-x_meg{ext}"))
        # And map to MEG by their BIDS suffix.
        self.assertEqual(bids_suffix_modality("sub-01/meg/sub-01_task-x_meg.con"), "MEG")
        self.assertEqual(
            store_rel_for("sub-01/meg/sub-01_task-x_meg.con"),
            "sub-01/meg/sub-01_task-x_meg.zarr",
        )

    def test_dir_recording_of_and_is_dir_recording(self):
        inner = "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4"
        ds = "sub-01/meg/sub-01_task-x_meg.ds"
        self.assertEqual(dir_recording_of(inner), ds)
        self.assertEqual(dir_recording_of(ds), ds)  # the dir maps to itself
        self.assertIsNone(dir_recording_of("sub-01/meg/sub-01_task-x_meg.fif"))
        self.assertTrue(is_dir_recording(ds))
        self.assertFalse(is_dir_recording(inner))

    def test_dir_recordings_derived_from_inner_files(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.res4",
            "sub-01/meg/sub-01_task-x_meg.ds/BadChannels",
            "sub-02/meg/sub-02_task-y_meg.ds/sub-02_task-y_meg.meg4",
            "dataset_description.json",
        ]
        self.assertEqual(
            dir_recordings(head),
            {"sub-01/meg/sub-01_task-x_meg.ds", "sub-02/meg/sub-02_task-y_meg.ds"},
        )

    def test_ctf_store_rel_and_events_and_modality(self):
        ds = "sub-01/meg/sub-01_task-x_meg.ds"
        self.assertEqual(store_rel_for(ds), "sub-01/meg/sub-01_task-x_meg.zarr")
        self.assertEqual(
            events_sibling_for(ds), "sub-01/meg/sub-01_task-x_events.tsv"
        )
        self.assertEqual(bids_suffix_modality(ds), "MEG")

    def test_full_converts_ctf_ds_as_one_primary(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.res4",
            "sub-01/meg/sub-01_task-x_events.tsv",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_modify_inner_ctf_file_rebuilds_recording(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.res4",
        ]
        convert, remove = compute_worklist(
            head, [("M", "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_delete_whole_ctf_ds_removes_store(self):
        # Every inner file deleted, none remain at HEAD -> drop the recording's store.
        convert, remove = compute_worklist(
            [],
            [
                ("D", "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4"),
                ("D", "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.res4"),
            ],
            full=False,
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-01/meg/sub-01_task-x_meg.zarr"])

    def test_delete_one_ctf_file_with_others_remaining_rebuilds(self):
        head = ["sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4"]
        convert, remove = compute_worklist(
            head, [("D", "sub-01/meg/sub-01_task-x_meg.ds/BadChannels")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_ctf_size_sums_directory_tree(self):
        with tempfile.TemporaryDirectory() as d:
            ds = os.path.join(d, "sub-01_task-x_meg.ds")
            os.makedirs(ds)
            with open(os.path.join(ds, "sub-01_task-x_meg.meg4"), "wb") as fh:
                fh.write(b"m" * 8000)
            with open(os.path.join(ds, "sub-01_task-x_meg.res4"), "wb") as fh:
                fh.write(b"r" * 200)
            self.assertEqual(_recording_size_bytes(ds), 8200)


class TestMefdRecordings(unittest.TestCase):
    """MEF3 `.mefd` directory recordings: the extension-keyed directory
    mechanism generalized from CTF `.ds` (`dir_recording_of`/`is_dir_recording`/
    `dir_recordings`) rather than copy-pasted for the new format. A real MEF3
    session nests several levels below the `.mefd` itself:
    `<name>.mefd/<CHANNEL>.timd/<CHANNEL>-000000.segd/<CHANNEL>-000000.{tdat,tidx,
    tmet}` (on006392 has 194 `.timd` channel dirs and 582 tracked files)."""

    MEFD = "sub-01/ieeg/sub-01_task-photicstim_ieeg.mefd"

    def _member(self, channel: str, suffix: str) -> str:
        return f"{self.MEFD}/{channel}.timd/{channel}-000000.segd/{channel}-000000.{suffix}"

    def test_dir_recording_of_resolves_nested_segd_members(self):
        for suffix in ("tdat", "tidx", "tmet"):
            self.assertEqual(dir_recording_of(self._member("C3", suffix)), self.MEFD)
        self.assertEqual(dir_recording_of(self.MEFD), self.MEFD)  # the dir maps to itself
        self.assertTrue(is_dir_recording(self.MEFD))
        self.assertTrue(is_mefd(self.MEFD))
        self.assertFalse(is_mefd("sub-01/meg/sub-01_task-x_meg.ds"))

    def test_dir_recordings_derives_one_mefd_from_many_channel_members(self):
        # Every .tdat/.tidx/.tmet across every .timd channel dir still resolves
        # to the SAME one recording, keyed at the .mefd path -- not one per
        # channel and not one per segd/timd directory.
        head = [
            self._member(ch, suffix)
            for ch in ("C3", "C4", "CZ", "ECG")
            for suffix in ("tdat", "tidx", "tmet")
        ]
        head.append("dataset_description.json")
        self.assertEqual(dir_recordings(head), {self.MEFD})

    def test_mefd_is_not_itself_a_file_extension_primary(self):
        # Like CTF .ds, a .mefd recording is directory-derived, not an
        # extension match on `is_primary` (which only matches file exts).
        self.assertFalse(is_primary(self.MEFD))

    def test_mefd_store_rel_events_and_modality(self):
        self.assertEqual(
            store_rel_for(self.MEFD), "sub-01/ieeg/sub-01_task-photicstim_ieeg.zarr"
        )
        self.assertEqual(
            events_sibling_for(self.MEFD),
            "sub-01/ieeg/sub-01_task-photicstim_events.tsv",
        )
        self.assertEqual(bids_suffix_modality(self.MEFD), "IEEG")

    def test_full_converts_mefd_as_one_primary(self):
        head = [self._member("C3", "tdat"), self._member("C3", "tidx")]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, [self.MEFD])
        self.assertEqual(remove, [])

    def test_modify_inner_mefd_file_rebuilds_recording(self):
        head = [self._member("C3", "tdat"), self._member("C4", "tdat")]
        convert, remove = compute_worklist(
            head, [("M", self._member("C3", "tdat"))], full=False
        )
        self.assertEqual(convert, [self.MEFD])
        self.assertEqual(remove, [])

    def test_delete_whole_mefd_removes_store(self):
        convert, remove = compute_worklist(
            [],
            [("D", self._member("C3", "tdat")), ("D", self._member("C3", "tidx"))],
            full=False,
        )
        self.assertEqual(convert, [])
        self.assertEqual(
            remove, ["sub-01/ieeg/sub-01_task-photicstim_ieeg.zarr"]
        )

    def test_delete_one_channel_with_others_remaining_rebuilds(self):
        head = [self._member("C4", "tdat")]
        convert, remove = compute_worklist(
            head, [("D", self._member("C3", "tdat"))], full=False
        )
        self.assertEqual(convert, [self.MEFD])
        self.assertEqual(remove, [])

    def test_full_worklist_excludes_mefd_under_derivatives(self):
        head = [
            self._member("C3", "tdat"),
            f"derivatives/preprocessed/{self._member('C3', 'tdat')}",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, [self.MEFD])
        self.assertEqual(remove, [])

    def test_mefd_size_sums_the_whole_nested_tree(self):
        with tempfile.TemporaryDirectory() as d:
            mefd = os.path.join(d, "sub-01_task-x_ieeg.mefd")
            sizes = {"C3": 4000, "C4": 3000}
            for ch, size in sizes.items():
                segd = os.path.join(mefd, f"{ch}.timd", f"{ch}-000000.segd")
                os.makedirs(segd)
                for suffix in ("tdat", "tidx", "tmet"):
                    with open(os.path.join(segd, f"{ch}-000000.{suffix}"), "wb") as fh:
                        fh.write(b"m" * size)
            self.assertEqual(_recording_size_bytes(mefd), sum(sizes.values()) * 3)

    def test_mefd_streams_on_the_common_threshold(self):
        # .mefd streams like CTF/FIF/BrainVision (biosigio>=1.2.3, read_raw_mef
        # supports preload=False), now on the single common threshold (#1112).
        self.assertTrue(self.MEFD.endswith(MEFD_EXT))
        self.assertFalse(should_stream(self.MEFD, 100 * 1024**2))
        self.assertTrue(should_stream(self.MEFD, 500 * 1024**2))


class TestBtiRecordings(unittest.TestCase):
    """4D/BTi recording directories: BIDS gives them NO extension at all, so
    detection is content-based (`bti_recordings`) rather than the extension
    match `dir_recording_of` uses for CTF `.ds`/MEF3 `.mefd`. Mirrors
    biosigIO's `importers.meg._find_bti_pdf` gate exactly: a `c,rf*` file AND a
    sibling `config` file, both required, checked directly in the directory."""

    BTI = "sub-01/meg/sub-01_task-rest_meg"

    def test_detects_directory_with_config_and_crf(self):
        head = [f"{self.BTI}/c,rfDC", f"{self.BTI}/config", f"{self.BTI}/hs_file"]
        self.assertEqual(bti_recordings(head), {self.BTI})

    def test_datalad_config_alone_is_not_a_bti_recording(self):
        # The exact false-positive this converter must never repeat: almost
        # every datalad-tracked dataset has `.datalad/config`, and it carries
        # no `c,rf*` sibling, so it must never be mistaken for a BTi recording.
        head = [
            ".datalad/config",
            "dataset_description.json",
            "sub-01/eeg/sub-01_task-x_eeg.set",
        ]
        self.assertEqual(bti_recordings(head), set())

    def test_crf_without_config_is_not_a_bti_recording(self):
        # Mirrors biosigIO's gate exactly: `config` is REQUIRED alongside
        # `c,rf*`, not merely sufficient on its own (the previous test) -- a
        # stray c,rf*-prefixed file with no config sibling is not enough
        # either, so the two sides never disagree about what counts.
        head = [f"{self.BTI}/c,rfDC"]
        self.assertEqual(bti_recordings(head), set())

    def test_excludes_bti_dir_under_derivatives(self):
        head = [
            f"{self.BTI}/c,rfDC",
            f"{self.BTI}/config",
            f"derivatives/preprocessed/{self.BTI}/c,rfDC",
            f"derivatives/preprocessed/{self.BTI}/config",
        ]
        self.assertEqual(bti_recordings(head), {self.BTI})

    def test_is_bti_marker_name(self):
        self.assertTrue(is_bti_marker_name("config"))
        self.assertTrue(is_bti_marker_name("c,rfDC"))
        self.assertTrue(is_bti_marker_name("c,rfDC,fn50,o"))
        # hs_file is optional and deliberately NOT a marker: its absence must
        # never affect whether a directory counts as a BTi recording.
        self.assertFalse(is_bti_marker_name("hs_file"))
        self.assertFalse(is_bti_marker_name("e,pos"))

    def test_is_bti_dir_is_a_bare_extension_check(self):
        self.assertTrue(is_bti_dir(self.BTI))
        self.assertFalse(is_bti_dir("sub-01/meg/sub-01_task-x_meg.ds"))
        self.assertFalse(is_bti_dir("sub-01/meg/sub-01_task-x_meg.mefd"))
        self.assertFalse(is_bti_dir("sub-01/eeg/sub-01_task-x_eeg.set"))

    def test_bti_pdf_choice_prefers_exact_crfdc(self):
        # Exact c,rfDC wins even when a filtered copy sits right beside it,
        # and its presence with only one candidate is NOT ambiguous.
        chosen, ambiguous = bti_pdf_choice({"c,rfDC", "config", "hs_file"})
        self.assertEqual(chosen, "c,rfDC")
        self.assertFalse(ambiguous)

    def test_bti_pdf_choice_prefers_crfdc_over_filtered_variant(self):
        chosen, ambiguous = bti_pdf_choice({"c,rfDC", "c,rfDC,fn50,o", "config"})
        self.assertEqual(chosen, "c,rfDC")
        self.assertTrue(ambiguous)  # >1 candidate, even though c,rfDC won

    def test_bti_pdf_choice_falls_back_to_sorted_order(self):
        # No exact c,rfDC present -> the first candidate in sorted() order,
        # NOT filesystem/os.listdir order (which is not reproducible).
        chosen, ambiguous = bti_pdf_choice({"c,rfDC,fn50,o", "c,rfhp0.1Hz", "config"})
        self.assertEqual(chosen, "c,rfDC,fn50,o")
        self.assertTrue(ambiguous)

    def test_bti_pdf_choice_no_candidates(self):
        self.assertEqual(bti_pdf_choice({"config", "hs_file"}), (None, False))

    def test_bti_store_rel_and_events_and_modality(self):
        # No extension to strip: store_rel_for is a plain `path + ".zarr"`.
        self.assertEqual(
            store_rel_for(self.BTI), "sub-01/meg/sub-01_task-rest_meg.zarr"
        )
        self.assertEqual(
            events_sibling_for(self.BTI), "sub-01/meg/sub-01_task-rest_events.tsv"
        )
        self.assertEqual(bids_suffix_modality(self.BTI), "MEG")

    def test_full_converts_bti_dir_as_one_primary(self):
        head = [f"{self.BTI}/c,rfDC", f"{self.BTI}/config", f"{self.BTI}/hs_file"]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, [self.BTI])
        self.assertEqual(remove, [])

    def test_modify_config_rebuilds_recording(self):
        head = [f"{self.BTI}/c,rfDC", f"{self.BTI}/config"]
        convert, remove = compute_worklist(head, [("M", f"{self.BTI}/config")], full=False)
        self.assertEqual(convert, [self.BTI])
        self.assertEqual(remove, [])

    def test_delete_optional_hs_file_rebuilds_not_removes(self):
        # hs_file is optional in BIDS; its removal must rebuild the recording
        # (without headshape), never delete the store.
        head = [f"{self.BTI}/c,rfDC", f"{self.BTI}/config"]
        convert, remove = compute_worklist(
            head, [("D", f"{self.BTI}/hs_file")], full=False
        )
        self.assertEqual(convert, [self.BTI])
        self.assertEqual(remove, [])

    def test_delete_last_crf_removes_store(self):
        # The only c,rf* file is gone -> the directory no longer qualifies as
        # BTi (bti_dirs, computed from the post-diff HEAD state) -> drop it.
        convert, remove = compute_worklist(
            [f"{self.BTI}/config"], [("D", f"{self.BTI}/c,rfDC")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-01/meg/sub-01_task-rest_meg.zarr"])

    def test_delete_config_with_crf_remaining_removes_store(self):
        # config gone -> below the two-file detection threshold, even though
        # c,rfDC is still there; mirrors biosigIO's own gate exactly.
        convert, remove = compute_worklist(
            [f"{self.BTI}/c,rfDC"], [("D", f"{self.BTI}/config")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-01/meg/sub-01_task-rest_meg.zarr"])

    def test_replacing_crfdc_with_filtered_variant_still_rebuilds(self):
        # A rename (git diff --no-renames -> D old + A new) must still be read
        # as "rebuild," never "removed," because a qualifying c,rf* file is
        # still present at HEAD after the change (just a different one).
        head = [f"{self.BTI}/c,rfDC,fn50,o", f"{self.BTI}/config"]
        convert, remove = compute_worklist(
            head,
            [("D", f"{self.BTI}/c,rfDC"), ("A", f"{self.BTI}/c,rfDC,fn50,o")],
            full=False,
        )
        self.assertEqual(convert, [self.BTI])
        self.assertEqual(remove, [])

    def test_bti_size_sums_the_whole_directory(self):
        with tempfile.TemporaryDirectory() as d:
            bti = os.path.join(d, "sub-01_task-x_meg")
            os.makedirs(bti)
            with open(os.path.join(bti, "c,rfDC"), "wb") as fh:
                fh.write(b"p" * 9000)
            with open(os.path.join(bti, "config"), "wb") as fh:
                fh.write(b"c" * 300)
            with open(os.path.join(bti, "hs_file"), "wb") as fh:
                fh.write(b"h" * 100)
            self.assertEqual(_recording_size_bytes(bti), 9400)

    def test_bti_streams_on_the_same_threshold_as_everything_else(self):
        # #1112 collapsed the two-tier threshold: BTi used to stay in-memory until
        # multi-GB because it genuinely supports preload=False, but "has a lazy
        # reader" is a reason streaming WORKS, not a reason to postpone it. Only
        # genuinely small recordings keep the in-memory fast path now.
        self.assertFalse(should_stream(self.BTI, 100 * 1024**2))
        self.assertTrue(should_stream(self.BTI, 300 * 1024**2))
        self.assertTrue(should_stream(self.BTI, 3 * 1024**3))

    def test_all_directory_recording_kinds_coexist_in_one_worklist(self):
        # CTF .ds, MEF3 .mefd, and 4D/BTi discovered together must not
        # interfere with each other or with a plain file-extension primary.
        head = [
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-02/meg/sub-02_task-x_meg.ds/sub-02_task-x_meg.meg4",
            "sub-03/ieeg/sub-03_task-x_ieeg.mefd/C3.timd/C3-000000.segd/C3-000000.tdat",
            f"{self.BTI}/c,rfDC",
            f"{self.BTI}/config",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(
            convert,
            sorted([
                "sub-01/eeg/sub-01_task-x_eeg.set",
                "sub-02/meg/sub-02_task-x_meg.ds",
                "sub-03/ieeg/sub-03_task-x_ieeg.mefd",
                self.BTI,
            ]),
        )
        self.assertEqual(remove, [])


class TestRecordingSizeBytes(unittest.TestCase):
    """Streaming gate sizing: primary + same-stem companions, not the whole dir."""

    def test_sums_primary_and_same_stem_companions(self):
        with tempfile.TemporaryDirectory() as d:
            sub = os.path.join(d, "sub-01", "ieeg")
            os.makedirs(sub)
            stem = "sub-01_task-movie_ieeg"
            # BrainVision triplet: the bulk lives in the .eeg companion.
            with open(os.path.join(sub, f"{stem}.vhdr"), "wb") as fh:
                fh.write(b"x" * 100)
            with open(os.path.join(sub, f"{stem}.eeg"), "wb") as fh:
                fh.write(b"y" * 5000)
            with open(os.path.join(sub, f"{stem}.vmrk"), "wb") as fh:
                fh.write(b"z" * 50)
            # A different recording in the same dir must NOT be counted.
            with open(os.path.join(sub, "sub-01_task-rest_ieeg.eeg"), "wb") as fh:
                fh.write(b"q" * 9999)
            primary = os.path.join(sub, f"{stem}.vhdr")
            self.assertEqual(_recording_size_bytes(primary), 100 + 5000 + 50)

    def test_unreadable_dir_forces_streaming(self):
        # A listdir failure must NOT read as size 0 (which would misroute a large
        # recording to the OOM-prone in-memory path); it forces the streaming path.
        self.assertGreater(
            _recording_size_bytes("/no/such/dir/sub-01_eeg.vhdr"), 2 * 1024**3
        )

    def test_split_fif_sums_the_whole_chain(self):
        # #909: split-02.. carry DIFFERENT stems (`_split-02_meg`); summing only
        # split-01's same-stem companions undercounts the chain, so should_stream
        # misroutes a multi-GB recording to the in-memory path and OOMs. The size
        # must be the whole split group, not just split-01.
        with tempfile.TemporaryDirectory() as d:
            sub = os.path.join(d, "sub-01", "meg")
            os.makedirs(sub)
            base = "sub-01_task-rest"
            for idx, size in ((1, 1000), (2, 2000), (3, 500)):
                with open(os.path.join(sub, f"{base}_split-0{idx}_meg.fif"), "wb") as fh:
                    fh.write(b"f" * size)
            # A non-member file in the same dir must NOT be counted.
            with open(os.path.join(sub, "sub-01_task-other_meg.fif"), "wb") as fh:
                fh.write(b"x" * 9999)
            primary = os.path.join(sub, f"{base}_split-01_meg.fif")
            self.assertEqual(_recording_size_bytes(primary), 3500)


class TestMemoryGuard(unittest.TestCase):
    """Per-recording memory guard (#909): projection, budget, deterministic skip."""

    def test_projected_peak_streaming_is_bounded(self):
        # A large .fif streams -> peak is bounded regardless of on-disk size.
        self.assertEqual(
            projected_peak_bytes("sub-01_task-x_meg.fif", 50 * 1024**3), STREAM_PEAK_BYTES
        )

    def test_mef3_projects_from_on_disk_bytes_on_the_streaming_path(self):
        """MEF3 streams (MNE reads it a window at a time) but the worker still
        climbs to the whole recording at float64: 7.5-10.3 GiB from ~1 GB on
        disk on on004696 (2026-09-03). The flat bound admitted eight at once and
        the kernel killed a worker. The projection must scale with size."""
        size = 1024**3
        self.assertTrue(should_stream("sub-01/ieeg/sub-01_ieeg.mefd", size))
        self.assertEqual(
            projected_peak_bytes("sub-01/ieeg/sub-01_ieeg.mefd", size, 256),
            int(size * STREAM_MEM_FACTOR_BY_EXT[".mefd"]),
        )
        self.assertGreater(STREAM_MEM_FACTOR_BY_EXT[".mefd"], 10)
        # Other streamed formats keep the flat bound: nothing measured says
        # otherwise, and charging them 12x would serialize the archive.
        self.assertEqual(projected_peak_bytes("sub-01/meg/sub-01_meg.fif", size, 306), STREAM_PEAK_BYTES)
        self.assertEqual(projected_peak_bytes("sub-01/meg/sub-01_meg.ds", size, 275), STREAM_PEAK_BYTES)
        self.assertEqual(stream_factor_for("sub-01/meg/sub-01_meg.fif"), 0.0)

    def test_mef3_streaming_projection_never_drops_below_the_flat_bound(self):
        # A tiny MEF3 above the stream threshold still gets the streaming floor.
        size = STREAM_MIN_BYTES + 1
        self.assertEqual(
            projected_peak_bytes("x.mefd", size, 8),
            max(STREAM_PEAK_BYTES, int(size * STREAM_MEM_FACTOR_BY_EXT[".mefd"])),
        )

    def test_mef3_in_memory_path_uses_the_same_retention_factor(self):
        size = 100 * 1024**2
        self.assertFalse(should_stream("x.mefd", size))
        self.assertEqual(projected_peak_bytes("x.mefd", size), int(size * INMEM_MEM_FACTOR_BY_EXT[".mefd"]))
        self.assertEqual(INMEM_MEM_FACTOR_BY_EXT[".mefd"], STREAM_MEM_FACTOR_BY_EXT[".mefd"])

    def test_projected_peak_inmemory_scales_with_size(self):
        # EEGLAB `.set` is in no STREAM_*_EXTS tuple, so it is always in-memory
        # and the float64 blow-up scales with size.
        #
        # Deliberately NOT `.edf` here. EDF's path depends on the INSTALLED
        # biosigio (`_EDF_STREAMABLE`, >= 1.2 streams it), so an `.edf` assertion
        # passes in CI, which installs nothing, and FAILS on the conversion node,
        # which has 1.2.4 -- and it did, on the epic branch, before this phase
        # touched anything. A unit test of a pure projection must not depend on
        # whether an optional dependency happens to be present.
        size = 3 * 1024**3
        self.assertEqual(
            projected_peak_bytes("sub-01_task-x_eeg.set", size), int(size * INMEM_MEM_FACTOR)
        )

    def test_ceiling_is_the_whole_usable_node_and_jobs_independent(self):
        # The per-recording ceiling no longer shrinks with --jobs: it is the whole
        # usable node, so raising concurrency never skips a recording it otherwise
        # would convert (admission control bounds the SUM, not each recording).
        os.environ.pop("ZARR_REC_MEM_BUDGET_BYTES", None)
        # Sampled, not exact: since #1111 the ceiling comes from MemAvailable,
        # which moves between two reads on a shared box. The property under test
        # is that the ceiling IS the usable node and does not shrink with --jobs,
        # not that two live samples are bit-identical.
        self.assertAlmostEqual(
            per_recording_ceiling_bytes() / 1024**3, usable_ram_bytes() / 1024**3, places=0
        )

    def test_ceiling_explicit_override_wins(self):
        os.environ["ZARR_REC_MEM_BUDGET_BYTES"] = str(123 * 1024**2)
        try:
            self.assertEqual(per_recording_ceiling_bytes(), 123 * 1024**2)
        finally:
            os.environ.pop("ZARR_REC_MEM_BUDGET_BYTES", None)

    def test_preflight_skips_before_any_load(self):
        # A tiny budget forces a skip BEFORE any load (no biosigIO import, no OOM).
        # The recording easily fits the NODE, so the verdict is the temporary one:
        # "not enough free right now", which retries. Since #1111 the ceiling is
        # MemAvailable, a live sample on a shared box, so "over budget" no longer
        # implies "too big to ever convert" -- and only the latter may be terminal.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            with self.assertRaises(RecordingMemoryExceeded) as cm:
                convert_recording(rec, None, os.path.join(d, "store"), mem_budget_bytes=1)
            self.assertEqual(cm.exception.code, "recording_memory_exceeded")
            self.assertIn(cm.exception.code, RETRYABLE_CODES)

    def test_a_recording_too_big_for_the_node_is_still_terminal(self):
        # The other branch: beyond what the hardware could EVER offer, so no amount
        # of waiting helps and the deterministic, no-retry verdict is correct.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            with self.assertRaises(RecordingTooLarge) as cm:
                # The genuinely terminal shape: free < node capacity < what this
                # recording needs. The two ceilings must be DISTINGUISHABLE, or
                # the verdict is deliberately the retryable one.
                convert_recording(
                    rec, None, os.path.join(d, "store"),
                    mem_budget_bytes=1, hard_ceiling_bytes=2,
                )
            self.assertEqual(cm.exception.code, "recording_too_large")
            self.assertNotIn(cm.exception.code, RETRYABLE_CODES)

    def test_preflight_uses_the_projection_admission_computed(self):
        # Phase 4 made projected_peak_bytes channel-aware but only updated
        # main()'s call site. Recomputing blind inside convert_recording always
        # yielded the flat STREAM_PEAK_BYTES floor for a streaming recording --
        # and since the ceiling is itself floored at 2x that value, the
        # comparison could never fire, making the permanent RecordingTooLarge
        # verdict dead code for the entire streaming path. The preflight must use
        # the number admission already computed.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            # A tiny file whose CHANNEL-AWARE projection is enormous: exactly the
            # few-channel/long/high-rate shape the flat floor cannot represent.
            with self.assertRaises(RecordingTooLarge) as cm:
                convert_recording(
                    rec, None, os.path.join(d, "store"),
                    mem_budget_bytes=10, hard_ceiling_bytes=20,
                    projected_peak=100 * 1024**3,
                )
            self.assertEqual(cm.exception.code, "recording_too_large")

    def test_preflight_falls_back_to_computing_its_own_projection(self):
        # Callers that do not supply one (tests, any future call site) must still
        # get a preflight rather than silently none.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            with self.assertRaises((RecordingTooLarge, RecordingMemoryExceeded)):
                convert_recording(
                    rec, None, os.path.join(d, "store"), mem_budget_bytes=1
                )

    def test_indistinguishable_ceilings_never_produce_a_permanent_verdict(self):
        # When /proc/meminfo is unreadable both ceilings fall back to the same
        # fixed figure. That makes `peak <= hard_ceiling` unsatisfiable whenever
        # `peak > mem_budget`, so every over-budget recording would be marked
        # permanently too-large -- silently undoing the #1111 split. Being wrong
        # toward "retry" costs one attempt; being wrong the other way buries a
        # dataset forever.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            with self.assertRaises(RecordingMemoryExceeded):
                convert_recording(
                    rec, None, os.path.join(d, "store"),
                    mem_budget_bytes=5, hard_ceiling_bytes=5,
                )

    def test_a_too_large_mef3_names_the_factor_behind_the_verdict(self):
        # A MEF3 session is skipped because of the 12x retention factor, not
        # because of its bytes on disk; the message must say which knob to
        # revisit once the reader stops retaining. Small directory: in-memory path.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_ieeg.mefd")
            os.makedirs(os.path.join(rec, "ch-1.timd"))
            with open(os.path.join(rec, "ch-1.timd", "seg.tdat"), "wb") as fh:
                fh.write(b"m" * 100_000)
            with self.assertRaises(RecordingTooLarge) as cm:
                convert_recording(
                    rec, None, os.path.join(d, "store"),
                    mem_budget_bytes=1, hard_ceiling_bytes=2,
                )
            self.assertIn(".mefd factor 12x (ZARR_INMEM_MEM_FACTOR_MEFD)", str(cm.exception))
        self.assertEqual(projection_factor_hint("x.edf", streaming=True), "")
        self.assertEqual(projection_factor_hint("x.fif", streaming=True), "")
        self.assertIn("ZARR_STREAM_MEM_FACTOR_MEFD", projection_factor_hint("x.mefd", streaming=True))
        self.assertIn("ZARR_INMEM_MEM_FACTOR_VHDR", projection_factor_hint("x.vhdr", streaming=False))

    def test_reason_for_code_too_large_is_user_facing(self):
        self.assertIn("too large", reason_for_code("recording_too_large").lower())


class TestSplitFif(unittest.TestCase):
    """Multi-file FIF split recordings collapse to one head store."""

    def test_split_index_and_group_key(self):
        p1 = "sub-03/meg/sub-03_task-x_run-02_split-01_meg.fif"
        p2 = "sub-03/meg/sub-03_task-x_run-02_split-02_meg.fif"
        self.assertEqual(split_index(p1), 1)
        self.assertEqual(split_index(p2), 2)
        self.assertIsNone(split_index("sub-03/meg/sub-03_task-x_run-02_meg.fif"))
        # Both splits resolve to the same group key (split entity removed).
        self.assertEqual(split_group_key(p1), "sub-03/meg/sub-03_task-x_run-02_meg.fif")
        self.assertEqual(split_group_key(p1), split_group_key(p2))

    def test_is_split_fif_only_true_for_fif_with_split(self):
        self.assertTrue(is_split_fif("sub-03/meg/sub-03_task-x_split-01_meg.fif"))
        self.assertFalse(is_split_fif("sub-03/meg/sub-03_task-x_meg.fif"))  # no split
        # A `split-` entity on a non-FIF format is not part of the FIF chain logic.
        self.assertFalse(is_split_fif("sub-03/eeg/sub-03_task-x_split-01_eeg.set"))

    def test_heads_and_members_picks_lowest_split(self):
        primaries = [
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_split-03_meg.fif",
            "sub-04/eeg/sub-04_task-y_eeg.set",  # non-split primary, carried verbatim
        ]
        heads, member_to_head = split_heads_and_members(primaries)
        self.assertEqual(
            heads,
            {
                "sub-03/meg/sub-03_task-x_split-01_meg.fif",
                "sub-04/eeg/sub-04_task-y_eeg.set",
            },
        )
        self.assertEqual(
            member_to_head,
            {
                "sub-03/meg/sub-03_task-x_split-02_meg.fif": "sub-03/meg/sub-03_task-x_split-01_meg.fif",
                "sub-03/meg/sub-03_task-x_split-03_meg.fif": "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            },
        )

    def test_heads_picks_lowest_present_when_split01_absent(self):
        # Degenerate group missing split-01: lowest present split is the head.
        primaries = [
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_split-03_meg.fif",
        ]
        heads, member_to_head = split_heads_and_members(primaries)
        self.assertEqual(heads, {"sub-03/meg/sub-03_task-x_split-02_meg.fif"})
        self.assertEqual(
            member_to_head,
            {"sub-03/meg/sub-03_task-x_split-03_meg.fif": "sub-03/meg/sub-03_task-x_split-02_meg.fif"},
        )

    def test_split_members_for_returns_sorted_chain(self):
        head_files = {
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_events.tsv",
            "sub-04/eeg/sub-04_task-y_eeg.set",
        }
        members = split_members_for("sub-03/meg/sub-03_task-x_split-01_meg.fif", head_files)
        self.assertEqual(
            members,
            [
                "sub-03/meg/sub-03_task-x_split-01_meg.fif",
                "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            ],
        )
        # A non-split primary has no members.
        self.assertEqual(split_members_for("sub-04/eeg/sub-04_task-y_eeg.set", head_files), [])

    def test_full_converts_only_head_split(self):
        head = [
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_events.tsv",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-01_meg.fif"])
        self.assertEqual(remove, [])

    def test_modify_any_split_rebuilds_head(self):
        head = [
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
        ]
        for changed in (
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
        ):
            convert, remove = compute_worklist(head, [("M", changed)], full=False)
            self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-01_meg.fif"])
            self.assertEqual(remove, [])

    def test_events_change_rebuilds_split_head(self):
        head = [
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_events.tsv",
        ]
        convert, _ = compute_worklist(
            head, [("M", "sub-03/meg/sub-03_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-01_meg.fif"])

    def test_delete_non_head_split_rebuilds_head_not_remove(self):
        # split-02 removed but split-01 remains -> re-read the chain, no store drop.
        head = ["sub-03/meg/sub-03_task-x_split-01_meg.fif"]
        convert, remove = compute_worklist(
            head, [("D", "sub-03/meg/sub-03_task-x_split-02_meg.fif")], full=False
        )
        self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-01_meg.fif"])
        self.assertEqual(remove, [])

    def test_delete_head_split_removes_its_store(self):
        # The whole recording is gone (both splits deleted) -> drop the head store.
        head: list[str] = []
        convert, remove = compute_worklist(
            head,
            [
                ("D", "sub-03/meg/sub-03_task-x_split-01_meg.fif"),
                ("D", "sub-03/meg/sub-03_task-x_split-02_meg.fif"),
            ],
            full=False,
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-03/meg/sub-03_task-x_split-01_meg.zarr"])

    def test_head_split_reindex_drops_orphaned_old_store(self):
        # Old head split-01 deleted while split-02 survives as the new head: build the
        # new head store AND remove the orphaned old-head store (would otherwise linger).
        head = ["sub-03/meg/sub-03_task-x_split-02_meg.fif"]
        convert, remove = compute_worklist(
            head, [("D", "sub-03/meg/sub-03_task-x_split-01_meg.fif")], full=False
        )
        self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-02_meg.fif"])
        self.assertEqual(remove, ["sub-03/meg/sub-03_task-x_split-01_meg.zarr"])

    def test_affected_primaries_non_head_split_maps_to_head(self):
        primaries = ["sub-03/meg/sub-03_task-x_split-01_meg.fif"]
        bd = by_dir(primaries)
        m2h = {
            "sub-03/meg/sub-03_task-x_split-02_meg.fif": "sub-03/meg/sub-03_task-x_split-01_meg.fif"
        }
        self.assertEqual(
            affected_primaries("sub-03/meg/sub-03_task-x_split-02_meg.fif", bd, m2h),
            {"sub-03/meg/sub-03_task-x_split-01_meg.fif"},
        )


class TestAnnexKeySize(unittest.TestCase):
    """The `-s<N>` size the download integrity check verifies a blob against."""

    def test_sha256e_size(self):
        self.assertEqual(
            annex_key_size("SHA256E-s628291820--64135e784fc1.con"), 628291820
        )

    def test_md5e_size(self):
        self.assertEqual(annex_key_size("MD5E-s12345--abcdef.edf"), 12345)

    def test_large_eeg_size(self):
        # The kind of >10 GB BrainVision blob that truncates without the check.
        self.assertEqual(
            annex_key_size("SHA256E-s12582746496--7ee1f5a2.eeg"), 12582746496
        )

    def test_no_size_field_returns_none(self):
        self.assertIsNone(annex_key_size("URL--https://example.org/x.edf"))
        self.assertIsNone(annex_key_size("WORM--whatever"))
        self.assertIsNone(annex_key_size(None))
        self.assertIsNone(annex_key_size(""))

    def test_a_size_like_run_in_the_name_is_not_a_size(self):
        # WORM and URL keys carry the file name (or URL) after `--`, and BIDS
        # names are full of `-s<digits>`-shaped runs. Unanchored, these read as
        # a 5-byte file, and every chunk name and size check derived from it
        # would be wrong.
        self.assertIsNone(annex_key_size("WORM-m1700000000--sub-01-s5_eeg.edf"))
        self.assertIsNone(annex_key_size("URL--https&c%%example.org%run-s5.edf"))
        # A sized WORM key keeps its own size, not the name's.
        self.assertEqual(annex_key_size("WORM-s100-m1700000000--sub-01-s5.edf"), 100)
        # The chunk fields that follow the size do not bleed into it.
        self.assertEqual(annex_key_size("SHA256E-s12-S1024-C1--abc.edf"), 12)


class TestMaxShieldCalibrationResolution(unittest.TestCase):
    """ADR 0028: Signal-Space Separation runs only with the recording's OWN
    fine-calibration and cross-talk pair. Resolution is BIDS inheritance, and the
    pair is all-or-nothing -- uncalibrated filtering is a weaker correction a
    consumer could not distinguish from a good one, so it is declined instead."""

    REC = "sub-01/meg/sub-01_task-rest_meg.fif"
    CAL = "sub-01/meg/sub-01_acq-calibration_meg.dat"
    CTC = "sub-01/meg/sub-01_acq-crosstalk_meg.fif"

    def test_pair_beside_the_recording(self):
        self.assertEqual(
            maxshield_calibration_for(self.REC, {self.REC, self.CAL, self.CTC}),
            (self.CAL, self.CTC),
        )

    def test_the_entity_subset_rule_would_reject_these(self):
        """The regression this resolver exists for.

        Every other sidecar resolver requires the candidate's entities to be a
        SUBSET of the recording's. `sub-01_acq-calibration_meg.dat` carries
        `acq=calibration` while the recording has no `acq` at all, so that rule
        rejects the very file it should find. Pin the exemption.
        """
        self.assertEqual(_bids_entities("sub-01_acq-calibration_meg")["acq"], "calibration")
        self.assertNotIn("acq", _bids_entities("sub-01_task-rest_meg"))
        self.assertIsNotNone(
            maxshield_calibration_for(self.REC, {self.REC, self.CAL, self.CTC})
        )

    def test_half_a_pair_is_no_pair(self):
        for present in (self.CAL, self.CTC):
            with self.subTest(present=present):
                self.assertIsNone(
                    maxshield_calibration_for(self.REC, {self.REC, present})
                )

    def test_neither_present(self):
        self.assertIsNone(maxshield_calibration_for(self.REC, {self.REC}))

    def test_inherited_from_an_ancestor(self):
        rec = "sub-06/ses-1/meg/sub-06_ses-1_task-rest_meg.fif"
        head = {rec, "sub-06/sub-06_acq-calibration_meg.dat",
                "sub-06/sub-06_acq-crosstalk_meg.fif"}
        self.assertIsNotNone(maxshield_calibration_for(rec, head))

    def test_bare_form_at_the_dataset_root(self):
        head = {self.REC, "acq-calibration_meg.dat", "acq-crosstalk_meg.fif"}
        self.assertIsNotNone(maxshield_calibration_for(self.REC, head))

    def test_nearest_wins(self):
        rec = "sub-06/ses-1/meg/sub-06_ses-1_task-rest_meg.fif"
        near = "sub-06/ses-1/meg/sub-06_ses-1_acq-calibration_meg.dat"
        head = {rec, near, "sub-06/ses-1/meg/sub-06_ses-1_acq-crosstalk_meg.fif",
                "sub-06/sub-06_acq-calibration_meg.dat",
                "sub-06/sub-06_acq-crosstalk_meg.fif"}
        pair = maxshield_calibration_for(rec, head)
        self.assertIsNotNone(pair)
        self.assertEqual(pair[0], near)

    def test_another_subject_pair_does_not_apply(self):
        head = {self.REC, "sub-02/meg/sub-02_acq-calibration_meg.dat",
                "sub-02/meg/sub-02_acq-crosstalk_meg.fif"}
        self.assertIsNone(maxshield_calibration_for(self.REC, head))

    def test_a_sibling_session_does_not_apply(self):
        # `sub-06/ses-2/` is not an ancestor of `sub-06/ses-1/`, so inheritance
        # must not reach across it.
        rec = "sub-06/ses-1/meg/sub-06_ses-1_task-rest_meg.fif"
        head = {rec, "sub-06/ses-2/meg/sub-06_ses-2_acq-calibration_meg.dat",
                "sub-06/ses-2/meg/sub-06_ses-2_acq-crosstalk_meg.fif"}
        self.assertIsNone(maxshield_calibration_for(rec, head))

    def test_calibration_files_stay_excluded_from_discovery(self):
        """ADR 0028's own trap: these are inputs to conversion AND never
        recordings. Both must remain true; conflating them breaks MaxShield."""
        for p in (self.CAL, self.CTC):
            with self.subTest(p=p):
                self.assertTrue(is_bids_calibration_file(p))
                self.assertFalse(is_primary(p))
        self.assertIsNotNone(
            maxshield_calibration_for(self.REC, {self.REC, self.CAL, self.CTC})
        )


class TestMaxShieldVerdictAndProjection(unittest.TestCase):
    def test_decline_is_deterministic_not_retryable(self):
        """The calibration pair is either shipped or it is not; retrying cannot
        change that, so a dataset made entirely of these must be marked terminal
        rather than burning five attempts."""
        self.assertNotIn(MaxShieldUncalibrated.code, RETRYABLE_CODES)
        failures = [{"code": MaxShieldUncalibrated.code}]
        self.assertEqual(count_infra_failures(failures, failures), 0)

    def test_decline_has_its_own_user_facing_reason(self):
        reason = reason_for_code(MaxShieldUncalibrated.code)
        self.assertNotEqual(reason, reason_for_code("file_read_error"))
        self.assertIn("shielding", reason.lower())

    def test_probe_failure_is_deterministic_not_retryable(self):
        """#1139: the probe runs on a file this same attempt already fetched
        successfully, so a header it cannot read is a property of that file's
        content -- retrying cannot make a corrupt header become readable."""
        self.assertNotIn(MaxShieldProbeFailed.code, RETRYABLE_CODES)
        failures = [{"code": MaxShieldProbeFailed.code}]
        self.assertEqual(count_infra_failures(failures, failures), 0)

    def test_probe_failure_has_its_own_user_facing_reason(self):
        reason = reason_for_code(MaxShieldProbeFailed.code)
        self.assertNotEqual(reason, reason_for_code("file_read_error"))
        self.assertNotEqual(reason, reason_for_code(MaxShieldUncalibrated.code))
        self.assertIn("header", reason.lower())

    def test_projection_covers_the_filter_phase(self):
        """A streaming FIF is projected on the streaming bound, which for this
        dataset's largest recording exceeds the measured filter peak by under 5%.
        That is coincidence, not headroom, so the MaxShield term must raise it."""
        size = 927 * 1024**2
        p = "sub-01/meg/sub-01_task-rest_meg.fif"
        plain = projected_peak_bytes(p, size, 328)
        shielded = projected_peak_bytes(p, size, 328, maxshield=True)
        self.assertGreater(shielded, plain)
        self.assertGreaterEqual(shielded, int(size * MAXSHIELD_MEM_FACTOR))

    def test_factor_clears_every_measured_ratio(self):
        """Pin the factor against the measurements it was derived from, so a future
        edit cannot quietly drop it below an observed peak. Sizes in MiB, peaks in
        GiB, measured through apply_sss on the conversion node."""
        for mib, gib in ((160, 0.78), (164, 0.79), (438, 1.87), (716, 2.95)):
            with self.subTest(mib=mib):
                self.assertGreater(mib * 1024**2 * MAXSHIELD_MEM_FACTOR, gib * 1024**3)

    def test_reserve_keeps_headroom_over_the_measured_peak(self):
        """The projection is not the limit. What the worker actually gets is
        admission_reserve_bytes, which for these recordings suppresses the usual 3x
        slack because the CONVERSION streams -- so assert the end of that chain, not
        just the projection. 716 MiB measured at 2.95 GiB."""
        size = 716 * 1024**2
        p = "sub-01/meg/sub-01_task-rest_meg.fif"
        ceiling = 24 * 1024**3
        proj = projected_peak_bytes(p, size, 336, maxshield=True)
        reserve = admission_reserve_bytes(proj, ceiling, streamed=should_stream(p, size))
        self.assertGreater(reserve, int(2.95 * 1024**3))

    def test_projection_takes_the_larger_phase_not_the_sum(self):
        # The two phases are sequential and the Raw is released between them.
        size = 8 * 1024**2  # small enough that conversion dominates
        p = "sub-01/meg/sub-01_task-rest_meg.fif"
        plain = projected_peak_bytes(p, size)
        shielded = projected_peak_bytes(p, size, maxshield=True)
        self.assertEqual(shielded, max(plain, int(size * MAXSHIELD_MEM_FACTOR)))
        self.assertLess(shielded, plain + int(size * MAXSHIELD_MEM_FACTOR))


class TestFailureReasons(unittest.TestCase):
    """Typed data failures (recordings the viewer should explain) are carried into
    index.json `failures`; infra failures are not. Mirrors biosigIO's error codes."""

    def test_reason_for_code_known_and_unknown(self):
        # Known codes get specific copy; None/unknown get the generic fallback.
        self.assertIn("derivative", reason_for_code("not_continuous").lower())
        self.assertIn("truncated", reason_for_code("corrupt_or_truncated").lower())
        generic = reason_for_code(None)
        self.assertEqual(reason_for_code("some_future_code"), generic)
        self.assertTrue(generic)

    def test_merge_index_records_failures(self):
        index = merge_index(
            None, "nm000104", SHA_NEW, [{"zarr": "a_eeg.zarr", "path": "a_eeg.set"}], [],
            "2026-06-13T00:00:00Z",
            [{"path": "b-ave.fif", "zarr": "b-ave.zarr", "code": "not_continuous",
              "reason": "derivative"}],
        )
        self.assertEqual(index["store_count"], 1)
        self.assertEqual(index["failure_count"], 1)
        self.assertEqual(index["failures"][0]["code"], "not_continuous")
        self.assertEqual(index["failures"][0]["path"], "b-ave.fif")

    def test_merge_index_failure_clears_when_path_converts(self):
        # A path that failed before but converts now drops out of `failures`.
        prior = {
            "source_commit": SHA_OLD,
            "stores": [],
            "failures": [{"path": "x_eeg.set", "zarr": "x_eeg.zarr",
                          "code": "corrupt_or_truncated", "reason": "..."}],
        }
        index = merge_index(
            prior, "nm000104", SHA_NEW, [{"zarr": "x_eeg.zarr", "path": "x_eeg.set"}], [],
            "2026-06-13T00:00:00Z", [],
        )
        self.assertEqual(index["failure_count"], 0)
        self.assertEqual(index["store_count"], 1)

    def test_merge_index_path_never_in_both_stores_and_failures(self):
        # A recording that newly fails drops its stale store entry.
        prior = {
            "source_commit": SHA_OLD,
            "stores": [{"zarr": "x_eeg.zarr", "path": "x_eeg.set"}],
            "failures": [],
        }
        index = merge_index(
            prior, "nm000104", SHA_NEW, [], [], "2026-06-13T00:00:00Z",
            [{"path": "x_eeg.set", "zarr": "x_eeg.zarr", "code": "not_continuous",
              "reason": "..."}],
        )
        store_paths = {s.get("path") for s in index["stores"]}
        fail_paths = {f["path"] for f in index["failures"]}
        self.assertEqual(store_paths & fail_paths, set())
        self.assertEqual(index["failure_count"], 1)
        self.assertEqual(index["store_count"], 0)

    def test_merge_index_drops_failure_for_removed_store(self):
        prior = {
            "source_commit": SHA_OLD, "stores": [],
            "failures": [{"path": "gone_eeg.set", "zarr": "gone_eeg.zarr",
                          "code": "not_continuous", "reason": "..."}],
        }
        index = merge_index(
            prior, "nm000104", SHA_NEW, [], ["gone_eeg.zarr"], "2026-06-13T00:00:00Z", [],
        )
        self.assertEqual(index["failure_count"], 0)

    def test_merge_index_drops_stale_failures_for_now_excluded_paths(self):
        # A carried-forward failure for a path now excluded (derivatives/
        # sourcedata/code) must not persist forever: it will never be
        # reconverted, so it would otherwise show users a stale failure for a
        # file we deliberately no longer serve. A genuine current failure for
        # a still-discoverable path must survive alongside it.
        prior = {
            "source_commit": SHA_OLD,
            "stores": [],
            "failures": [
                {"path": "derivatives/preprocessed/sub-01_task-x-epo.fif",
                 "zarr": "derivatives/preprocessed/sub-01_task-x-epo.zarr",
                 "code": "not_continuous", "reason": "..."},
                {"path": "sub-01/eeg/sub-01_task-y_eeg.set",
                 "zarr": "sub-01/eeg/sub-01_task-y_eeg.zarr",
                 "code": "corrupt_or_truncated", "reason": "..."},
            ],
        }
        index = merge_index(
            prior, "nm000104", SHA_NEW, [], [], "2026-06-13T00:00:00Z", [],
        )
        self.assertEqual(index["failure_count"], 1)
        self.assertEqual(
            index["failures"][0]["path"], "sub-01/eeg/sub-01_task-y_eeg.set"
        )


class TestAwsRunner(unittest.TestCase):
    """The wall-clock timeout + retry that stops a wedged aws op from hanging a
    worker -- or the whole run -- forever (the 2.5 h `aws s3 rm` spin on an empty
    prefix). Real subprocesses, no mocks; python3 stands in for `aws` (the
    appended --cli-* flags are harmlessly absorbed as argv)."""

    def test_timeout_kills_wedged_command(self):
        import time as _t

        start = _t.monotonic()
        with self.assertRaises(RuntimeError):
            # Sleeps 30 s; the 1 s wall-clock cap must kill it well before that.
            _aws([sys.executable, "-c", "import time; time.sleep(30)"], timeout=1, retries=1)
        self.assertLess(_t.monotonic() - start, 10)  # killed, not run to completion

    def test_failing_command_retries_then_raises(self):
        with self.assertRaises(RuntimeError):
            _aws([sys.executable, "-c", "import sys; sys.exit(7)"], timeout=30, retries=2)

    def test_recursive_rm_timeout_far_exceeds_transfer_timeout(self):
        # A whole-prefix `aws s3 rm --recursive` (millions of chunk objects on a
        # big dataset) legitimately runs much longer than a single transfer; the
        # transfer cap was killing real wipes mid-delete.
        self.assertGreaterEqual(_AWS_RM_TIMEOUT, 4 * _AWS_OP_TIMEOUT)

    def test_read_timeout_is_short_enough_to_reap_a_wedge(self):
        # A wedged S3 socket delivers ZERO response bytes; the per-read timeout is
        # what reaps it so botocore reconnects to a healthy IP. It must stay short
        # -- 300 s let an empty-prefix `aws s3 rm` spin for minutes per wedge. A
        # live transfer streams body continuously, so a short cap never trips it.
        i = _AWS_TIMEOUTS.index("--cli-read-timeout")
        self.assertLessEqual(int(_AWS_TIMEOUTS[i + 1]), 60)


class TestS3PrefixEmpty(unittest.TestCase):
    """The empty-prefix probe that lets `--clean` skip a pointless (wedge-prone)
    recursive rm. Real subprocess, no mocks: a fake `aws` on PATH emulates
    `s3api list-objects-v2 --query Contents[0].Key --output text`, which prints the
    first key or the literal `None` when the prefix is empty."""

    def _probe(self, stdout: str, rc: int = 0) -> bool:
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "aws"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                f"sys.stdout.write({stdout!r})\n"
                f"sys.exit({rc})\n"
            )
            fake.chmod(0o755)
            old = os.environ.get("PATH", "")
            os.environ["PATH"] = f"{tmp}{os.pathsep}{old}"
            try:
                return _s3_prefix_empty("nemar", "nm000228/zarr/")
            finally:
                os.environ["PATH"] = old

    def test_empty_prefix_is_skippable(self):
        # `--output text` prints "None" for an empty query; a blank line is treated
        # the same. Both -> True (skip the wipe).
        self.assertTrue(self._probe("None\n"))
        self.assertTrue(self._probe("\n"))

    def test_nonempty_prefix_is_not_skipped(self):
        self.assertFalse(
            self._probe("nm000228/zarr/sub-01/ses-01/eeg/x.zarr/eeg_250hz/0/c/0/0\n")
        )

    def test_error_falls_through_to_real_wipe(self):
        # A nonzero exit (creds/network) must NOT skip -- returning False makes the
        # caller run the real rm rather than silently leaving a stale prefix.
        self.assertFalse(self._probe("some error\n", rc=1))


class TestShouldStream(unittest.TestCase):
    """Which recordings take the bounded-memory streaming path. KIT .con loads
    fully in memory (~5x float64) and OOMs a worker well below the multi-GB mark,
    so it streams at a much lower threshold than BrainVision/FIF/CTF."""

    GB = 1024**3
    MB = 1024**2

    def test_kit_con_streams_above_low_threshold(self):
        # The ~620 MB task-2 .con that OOM'd the in-memory path must stream.
        self.assertTrue(should_stream("sub-01/meg/sub-01_task-x_meg.con", 620 * self.MB))
        self.assertTrue(should_stream("sub-01/meg/sub-01_task-x_meg.sqd", 900 * self.MB))

    def test_small_kit_stays_in_memory(self):
        # A small (~190 MB task-0) .con is cheap in memory -> faster path.
        self.assertFalse(should_stream("sub-01/meg/sub-01_task-x_meg.con", 190 * self.MB))

    def test_brainvision_fif_stream_from_the_common_threshold(self):
        # The 2 GiB threshold is what sank on004917: its BrainVision recordings
        # were 1.18-2.25 GB, so all but one sat just UNDER it, took the unbounded
        # in-memory path, and were admitted seven at a time. 500 MB must stream.
        self.assertTrue(should_stream("sub-01/ieeg/sub-01_task-x_ieeg.vhdr", 500 * self.MB))
        self.assertTrue(should_stream("sub-01/ieeg/sub-01_task-x_ieeg.vhdr", 2 * self.GB))
        self.assertTrue(should_stream("sub-01/meg/sub-01_task-x_meg.fif", 3 * self.GB))

    def test_the_on004917_band_now_streams(self):
        # Regression pin for the exact sizes that OOMed the node.
        for gb in (1.18, 1.5, 2.09, 2.25):
            self.assertTrue(
                should_stream("sub-02/eeg/sub-02_task-pdm_eeg.vhdr", int(gb * 1000**3)),
                f"{gb} GB BrainVision must take the bounded path",
            )

    def test_small_recordings_keep_the_in_memory_fast_path(self):
        # Streaming is not free: a scratch memmap plus a second pass costs more
        # than simply loading a small recording.
        self.assertFalse(should_stream("sub-01/ieeg/sub-01_task-x_ieeg.vhdr", 10 * self.MB))
        self.assertFalse(should_stream("sub-01/meg/sub-01_task-x_meg.fif", 10 * self.MB))

    def test_eeglab_set_never_streams(self):
        # EEGLAB .set has no streaming reader -> always in-memory.
        self.assertFalse(should_stream("sub-01/eeg/sub-01_task-x_eeg.set", 5 * self.GB))

    def test_edf_streaming_gated_on_biosigio_capability(self):
        # EDF/BDF stream ONLY when the installed biosigIO does it via pyedflib
        # (>=1.2.0, #944); on an older lib they stay in-memory (MNE would rescale
        # EDF units and not match the in-memory path). The gate is a module global.
        import generate_zarr  # type: ignore[import-not-found]

        big = STREAM_EDF_MIN_BYTES + 1
        orig = generate_zarr._EDF_STREAMABLE
        try:
            generate_zarr._EDF_STREAMABLE = True
            self.assertTrue(should_stream("sub-01/eeg/sub-01_task-x_eeg.edf", big))
            self.assertTrue(should_stream("sub-01/emg/sub-01_task-x_emg.bdf", big))
            # A small EDF stays on the faster in-memory path.
            self.assertFalse(
                should_stream("sub-01/eeg/sub-01_task-x_eeg.edf", STREAM_EDF_MIN_BYTES - 1)
            )
            generate_zarr._EDF_STREAMABLE = False
            self.assertFalse(should_stream("sub-01/eeg/sub-01_task-x_eeg.edf", big))
            self.assertFalse(should_stream("sub-01/emg/sub-01_task-x_emg.bdf", big))
        finally:
            generate_zarr._EDF_STREAMABLE = orig


class TestNextAdmission(unittest.TestCase):
    def test_admits_first_fitting_when_slot_free(self):
        # slot free, running 50 of a 100 ceiling: the 30 fits -> index 0.
        self.assertEqual(_next_admission([30, 10], 1, 50, 4, 100), 0)

    def test_waits_when_cpu_cap_reached(self):
        self.assertIsNone(_next_admission([1, 1], 4, 0, 4, 100))

    def test_waits_when_nothing_pending_fits(self):
        # something in flight (running 95); neither pending peak fits under 100.
        self.assertIsNone(_next_admission([100, 20], 2, 95, 8, 100))

    def test_idle_admits_head_even_if_oversized(self):
        # nothing in flight -> the head runs ALONE regardless of size (the worker
        # #909-skips it if it truly can't fit); guarantees forward progress.
        self.assertEqual(_next_admission([10**12], 0, 0, 4, 100), 0)

    def test_skips_head_of_line_giant_for_a_smaller_one(self):
        # running 50/100: the 100 giant can't fit, but the 10 behind it can.
        self.assertEqual(_next_admission([100, 10], 1, 50, 4, 100), 1)

    def test_simulation_never_exceeds_ceiling_except_lone_job(self):
        # Drive a full drain via _next_admission, completing the oldest in-flight
        # job each step; assert the concurrent peak SUM stays within the ceiling
        # whenever more than one job runs (a lone job may exceed it, by design).
        cpu_cap, ceiling = 4, 100
        peaks = [30, 30, 30, 30, 90, 5, 5, 200]  # incl. a lone-only 200 (> ceiling)
        pending = list(peaks)
        in_flight: list[int] = []  # FIFO of running peaks
        max_multi = 0
        guard = 0
        while pending or in_flight:
            guard += 1
            self.assertLess(guard, 1000, "admission simulation did not converge")
            idx = _next_admission(pending, len(in_flight), sum(in_flight), cpu_cap, ceiling)
            if idx is not None:
                in_flight.append(pending.pop(idx))
                if len(in_flight) > 1:
                    max_multi = max(max_multi, sum(in_flight))
                continue
            # nothing admittable -> a running job completes (oldest first)
            self.assertTrue(in_flight, "deadlock: nothing running and nothing admittable")
            in_flight.pop(0)
        self.assertLessEqual(max_multi, ceiling)


class TestRecordingSizeFromPointers(unittest.TestCase):
    def _git(self, repo: str, *args: str) -> None:
        subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)

    def test_sums_primary_and_companion_annex_sizes_at_head(self):
        # A real git repo with committed annex-style pointers (locked symlinks):
        # the recording's on-disk size is read from the keys' -s fields, no S3.
        primary = "sub-01/eeg/sub-01_task-x_eeg.set"
        companion = "sub-01/eeg/sub-01_task-x_eeg.fdt"
        pkey = "SHA256E-s5000--aaaa.set"
        ckey = "SHA256E-s2000000--bbbb.fdt"
        with tempfile.TemporaryDirectory() as repo:
            self._git(repo, "init", "-q")
            self._git(repo, "config", "user.email", "t@t")
            self._git(repo, "config", "user.name", "t")
            os.makedirs(os.path.join(repo, "sub-01", "eeg"))
            os.symlink(f"../../.git/annex/objects/aa/bb/{pkey}/{pkey}", os.path.join(repo, primary))
            os.symlink(f"../../.git/annex/objects/cc/dd/{ckey}/{ckey}", os.path.join(repo, companion))
            self._git(repo, "add", "-A")
            self._git(repo, "commit", "-qm", "fixture")
            head = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()
            total = recording_size_from_pointers(repo, primary, {primary, companion}, head)
            self.assertEqual(total, 5000 + 2000000)

    def test_sums_mefd_members_across_channel_dirs(self):
        mefd = "sub-01/ieeg/sub-01_task-x_ieeg.mefd"
        members = {
            f"{mefd}/C3.timd/C3-000000.segd/C3-000000.tdat": "SHA256E-s4000--c3.tdat",
            f"{mefd}/C4.timd/C4-000000.segd/C4-000000.tdat": "SHA256E-s3000--c4.tdat",
        }
        with tempfile.TemporaryDirectory() as repo:
            self._git(repo, "init", "-q")
            self._git(repo, "config", "user.email", "t@t")
            self._git(repo, "config", "user.name", "t")
            for path, key in members.items():
                full = os.path.join(repo, path)
                os.makedirs(os.path.dirname(full))
                # 5 levels deep (sub-01/ieeg/*.mefd/*.timd/*.segd) back to repo root.
                os.symlink(f"../../../../../.git/annex/objects/aa/bb/{key}/{key}", full)
            self._git(repo, "add", "-A")
            self._git(repo, "commit", "-qm", "fixture")
            head = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()
            total = recording_size_from_pointers(repo, mefd, set(members), head)
            self.assertEqual(total, 4000 + 3000)

    def test_sums_bti_dir_members_by_exact_dirname(self):
        bti = "sub-01/meg/sub-01_task-x_meg"
        members = {
            f"{bti}/c,rfDC": "SHA256E-s9000--pdf",
            f"{bti}/config": "SHA256E-s300--cfg",
        }
        with tempfile.TemporaryDirectory() as repo:
            self._git(repo, "init", "-q")
            self._git(repo, "config", "user.email", "t@t")
            self._git(repo, "config", "user.name", "t")
            for path, key in members.items():
                full = os.path.join(repo, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                # 3 levels deep (sub-01/meg/*_meg) back to repo root.
                os.symlink(f"../../../.git/annex/objects/aa/bb/{key}/{key}", full)
            self._git(repo, "add", "-A")
            self._git(repo, "commit", "-qm", "fixture")
            head = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()
            total = recording_size_from_pointers(repo, bti, set(members), head)
            self.assertEqual(total, 9000 + 300)


class TestExpectedChannelCountFor(unittest.TestCase):
    def _write(self, root: str, rel: str, text: str) -> None:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_sibling_channels_tsv_row_count(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
            self._write(d, tsv, "name\ttype\tunits\nCz\tEEG\tuV\nPz\tEEG\tuV\nEOG1\tEOG\tuV\n")
            self.assertEqual(
                expected_channel_count_for(d, rec, {tsv}, "HEAD"), 3
            )

    def test_none_when_no_channels_tsv(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.vhdr"
            self.assertIsNone(expected_channel_count_for(d, rec, set(), "HEAD"))

    def test_other_recordings_channels_tsv_does_not_apply(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = "sub-01/eeg/sub-01_task-other_channels.tsv"
            self._write(d, tsv, "name\ttype\nCz\tEEG\n")
            self.assertIsNone(expected_channel_count_for(d, rec, {tsv}, "HEAD"))

    def test_most_specific_wins(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            root_tsv = "task-rest_channels.tsv"
            sib_tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
            self._write(d, root_tsv, "name\ttype\nCz\tEEG\nPz\tEEG\n")
            self._write(d, sib_tsv, "name\ttype\nCz\tEEG\nPz\tEEG\nOz\tEEG\nFz\tEEG\n")
            self.assertEqual(
                expected_channel_count_for(d, rec, {root_tsv, sib_tsv}, "HEAD"), 4
            )

    def test_header_only_tsv_yields_none(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
            self._write(d, tsv, "name\ttype\tunits\n")
            self.assertIsNone(expected_channel_count_for(d, rec, {tsv}, "HEAD"))

    def test_an_unreadable_channels_tsv_says_what_the_gate_still_does(self):
        # The sidecar is listed at HEAD and cannot be read. Only the sidecar
        # drops out: the file's own header still gates the recording, so the
        # log must not claim the gate is off (it used to, after the header
        # gate stopped depending on channels.tsv).
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.edf"
            tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"  # never written
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertIsNone(expected_channel_count_for(d, rec, {tsv}, "HEAD"))
        log = out.getvalue()
        self.assertIn(f"could not read {tsv}", log)
        self.assertIn("its file header alone", log)
        self.assertNotIn("OFF", log)


    def test_reads_via_git_when_no_working_tree(self):
        # The workflow clones --no-checkout, so channels.tsv is only in the git
        # object store. Resolution must fall back to `git cat-file`.
        tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as clone_parent:
            self._write(src, tsv, "name\ttype\nCz\tEEG\nPz\tEEG\n")
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }

            def run(*a: str) -> None:
                subprocess.run(a, check=True, env=env, capture_output=True)

            run("git", "-C", src, "init", "-q", "-b", "main")
            run("git", "-C", src, "add", "-A")
            run("git", "-C", src, "commit", "-qm", "init")
            clone = os.path.join(clone_parent, "repo")
            run("git", "clone", "--no-checkout", "-q", src, clone)
            self.assertFalse(os.path.exists(os.path.join(clone, tsv)))
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self.assertEqual(expected_channel_count_for(clone, rec, {tsv}, "HEAD"), 2)


class TestReadRepoTextEncodings(unittest.TestCase):
    """on005691: a Latin-1 channels.tsv (`µV` as the byte 0xb5) raised
    UnicodeDecodeError out of `_read_repo_text`. It is not an OSError, so it
    escaped uncoded and the job retried forever. Both read paths (working tree
    and the `--no-checkout` clone's `git cat-file`) are exercised in a real
    repository."""

    TSV = "sub-01/eeg/sub-01_task-rest_channels.tsv"
    REC = "sub-01/eeg/sub-01_task-rest_eeg.set"
    LATIN1 = "name\ttype\tunits\nCz\tEEG\tµV\nPz\tEEG\tµV\nEOG\tEOG\tµV\n".encode("latin-1")

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.src = os.path.join(self._tmp.name, "src")
        # The non-UTF-8 warning is once per path per process; every test here
        # reads the same path and asserts on the warning.
        generate_zarr._NON_UTF8_WARNED.clear()
        self.env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
        }

    def _git(self, *args: str) -> None:
        subprocess.run(["git", *args], check=True, env=self.env, capture_output=True)

    def _commit(self, data: bytes) -> str:
        p = os.path.join(self.src, self.TSV)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(data)
        self._git("-C", self.src, "init", "-q", "-b", "main")
        self._git("-C", self.src, "add", "-A")
        self._git("-C", self.src, "commit", "-qm", "fixture")
        clone = os.path.join(self._tmp.name, "clone")
        self._git("clone", "--no-checkout", "-q", self.src, clone)
        return clone

    def _read(self, repo: str) -> tuple[str | None, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            text = generate_zarr._read_repo_text(repo, "HEAD", self.TSV)
        return text, out.getvalue()

    def test_latin1_is_read_with_a_warning_on_both_paths(self):
        clone = self._commit(self.LATIN1)
        self.assertFalse(os.path.exists(os.path.join(clone, self.TSV)))
        for repo in (self.src, clone):
            with self.subTest(repo=os.path.basename(repo)):
                generate_zarr._NON_UTF8_WARNED.clear()  # same path, both reads warn
                text, log = self._read(repo)
                self.assertIsNotNone(text)
                self.assertIn("Cz\tEEG\tµV", text or "")
                self.assertIn("::warning::", log)
                self.assertIn(self.TSV, log)

    def test_the_fidelity_gate_counts_a_latin1_sidecar(self):
        # The caller the job died in: the gate's ground truth, not a helper.
        clone = self._commit(self.LATIN1)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(expected_channel_count_for(clone, self.REC, {self.TSV}, "HEAD"), 3)
        self.assertIn("not valid UTF-8", out.getvalue())

    def test_utf8_with_a_bom_is_utf8_and_quiet(self):
        clone = self._commit(b"\xef\xbb\xbf" + "name\ttype\tunits\nCz\tEEG\tµV\n".encode())
        text, log = self._read(clone)
        self.assertEqual(text, "name\ttype\tunits\nCz\tEEG\tµV\n")
        self.assertEqual(log, "")

    def test_cp1252_only_bytes_decode_as_cp1252(self):
        # 0x80 is the euro sign in cp1252 and a C1 control in latin-1.
        clone = self._commit(b"name\tdescription\nCz\tgain \x80 note\n")
        text, log = self._read(clone)
        self.assertIn("gain € note", text or "")
        self.assertIn("as cp1252", log)

    def test_bytes_cp1252_leaves_undefined_fall_back_to_latin1(self):
        # 0x81 is undefined in cp1252, so only latin-1 can take it.
        clone = self._commit(b"name\tunits\nCz\t\x81\xb5V\n")
        text, log = self._read(clone)
        self.assertEqual(text, "name\tunits\nCz\t\x81µV\n")
        self.assertIn("as latin-1", log)

    def test_the_warning_is_once_per_path(self):
        # An inherited sidecar is re-read for every recording it applies to;
        # one line per path, not one per read.
        clone = self._commit(self.LATIN1)
        _, first = self._read(clone)
        _, second = self._read(clone)
        self.assertEqual(first.count("::warning::"), 1)
        self.assertEqual(second, "")
        other = "sub-01/eeg/sub-01_task-other_channels.tsv"
        with open(os.path.join(self.src, other), "wb") as fh:
            fh.write(self.LATIN1)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            text = generate_zarr._read_repo_text(self.src, "HEAD", other)
        self.assertIn("Cz\tEEG\tµV", text or "")
        self.assertIn(other, out.getvalue())

    def test_a_utf16_bom_decodes_as_utf16_not_cp1252(self):
        # Windows "Unicode" text: without the BOM check cp1252 accepts these
        # bytes and every character comes back followed by a NUL.
        body = "name\ttype\tunits\r\nCz\tEEG\tµV\r\n"
        for codec, bom in (("utf-16-le", b"\xff\xfe"), ("utf-16-be", b"\xfe\xff")):
            with self.subTest(codec=codec):
                generate_zarr._NON_UTF8_WARNED.clear()
                clone = self._commit(bom + body.encode(codec))
                text, log = self._read(clone)
                self.assertEqual(text, "name\ttype\tunits\nCz\tEEG\tµV\n")
                self.assertIn("read it as utf-16", log)
                shutil.rmtree(self.src)
                shutil.rmtree(clone)

    def test_crlf_is_normalized_as_the_text_mode_read_did(self):
        clone = self._commit(b"name\ttype\r\nCz\tEEG\r\n")
        text, _ = self._read(clone)
        self.assertEqual(text, "name\ttype\nCz\tEEG\n")

    def test_a_missing_file_is_still_none(self):
        clone = self._commit(self.LATIN1)
        self.assertIsNone(generate_zarr._read_repo_text(clone, "HEAD", "absent.tsv"))


class TestStoreTotalChannels(unittest.TestCase):
    def test_sums_across_groups(self):
        meta = {"groups": [{"n_channels": 70}, {"n_channels": 4}]}
        self.assertEqual(store_total_channels(meta), 74)

    def test_missing_or_none_counts_zero(self):
        self.assertEqual(store_total_channels({}), 0)
        self.assertEqual(store_total_channels({"groups": []}), 0)
        self.assertEqual(
            store_total_channels({"groups": [{"n_channels": None}, {}, {"n_channels": 3}]}), 3
        )


class TestChannelCountMismatch(unittest.TestCase):
    def test_carries_typed_data_failure_code(self):
        # The gate must surface as a DETERMINISTIC data failure (a .code the
        # index records), not an untyped infra failure that retries forever.
        self.assertEqual(ChannelCountMismatch.code, "channel_count_mismatch")
        self.assertIn("channels.tsv", reason_for_code("channel_count_mismatch"))


def write_edf_header(path: str, labels: list[str]) -> None:
    """Write an EDF/BDF header with exactly these signal labels and no data
    records: the 256-byte fixed part (field widths per the EDF spec), then 256
    bytes per signal, labels first. Real bytes in the layout the format defines,
    which is all `file_declared_channel_count` reads."""
    ns = len(labels)
    fixed = (
        "0".ljust(8) + "X".ljust(80) + "X".ljust(80) + "01.01.26" + "00.00.00"
        + str(256 * (ns + 1)).ljust(8) + "EDF+C".ljust(44) + "0".ljust(8)
        + "1".ljust(8) + str(ns).ljust(4)
    )
    assert len(fixed) == 256
    per_signal = "".join(label.ljust(16) for label in labels) + " " * (ns * 240)
    with open(path, "wb") as fh:
        fh.write((fixed + per_signal).encode("ascii"))


class TestFileDeclaredChannelCount(unittest.TestCase):
    """The gate's second ground truth: the file's own header, read with no
    importer in between (#1477 follow-up; every sampled channel_count_mismatch
    on 2026-09-22 was a sidecar listing channels its file never had)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def path(self, name):
        return os.path.join(self.dir, name)

    def test_edf_counts_signals_less_the_annotation_track(self):
        p = self.path("r_ieeg.edf")
        write_edf_header(p, ["LPHD1-LPHD2", "LPHD2-LPHD3", "LIWS3-LIWS4", "EDF Annotations"])
        self.assertEqual(file_declared_channel_count(p), 3)

    def test_bdf_drops_its_own_annotation_label(self):
        p = self.path("r_eeg.bdf")
        write_edf_header(p, ["Fp1", "Fp2", "Status", "BDF Annotations"])
        # Status is a real signal in the file; only the annotation track is not.
        self.assertEqual(file_declared_channel_count(p), 3)

    def test_brainvision_reads_number_of_channels(self):
        p = self.path("r_eeg.vhdr")
        with open(p, "w") as fh:
            fh.write("Brain Vision Data Exchange Header File Version 1.0\n"
                     "[Common Infos]\nDataFile=r_eeg.eeg\nNumberOfChannels=63\n")
        self.assertEqual(file_declared_channel_count(p), 63)

    def test_brainvision_ignores_the_count_outside_common_infos(self):
        p = self.path("c_eeg.vhdr")
        with open(p, "w") as fh:
            fh.write("Brain Vision Data Exchange Header File Version 1.0\n"
                     "[Comment]\nNumberOfChannels=999 (amplifier maximum)\n"
                     "[Common Infos]\nDataFile=c_eeg.eeg\nNumberOfChannels=32\n"
                     "[Channel Infos]\nCh1=Fp1,,0.1,uV\n")
        self.assertEqual(file_declared_channel_count(p), 32)
        q = self.path("n_eeg.vhdr")
        with open(q, "w") as fh:
            fh.write("[Comment]\nNumberOfChannels=64\n")
        self.assertIsNone(file_declared_channel_count(q))

    def test_a_truncated_header_is_unknown_not_zero(self):
        p = self.path("short_ieeg.edf")
        with open(p, "wb") as fh:
            fh.write(b"0" * 100)
        self.assertIsNone(file_declared_channel_count(p))

    def test_labels_cut_short_are_unknown(self):
        p = self.path("cut_ieeg.edf")
        write_edf_header(p, ["A", "B", "C"])
        with open(p, "r+b") as fh:
            fh.truncate(256 + 20)  # ns=3 declared, fewer than 48 label bytes
        self.assertIsNone(file_declared_channel_count(p))

    def test_formats_without_a_cheap_header_and_missing_files_are_unknown(self):
        p = self.path("r_eeg.set")
        with open(p, "wb") as fh:
            fh.write(b"MATLAB 5.0")
        self.assertIsNone(file_declared_channel_count(p))
        self.assertIsNone(file_declared_channel_count(self.path("absent_eeg.edf")))

    def count_and_log(self, path):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            value = file_declared_channel_count(path)
        return value, out.getvalue()

    def patched_edf(self, name, labels, offset, field):
        """`write_edf_header`'s file with `field` written over the bytes at
        `offset`, so a fixed-width field holds what a real writer put there."""
        p = self.path(name)
        write_edf_header(p, labels)
        with open(p, "r+b") as fh:
            fh.seek(offset)
            fh.write(field)
        return p

    def test_a_nul_padded_signal_count_is_read(self):
        # An EDF+ whose `ns` field is NUL-padded (b"4\x00\x00\x00") instead of
        # space-padded: real writers do this (biosigio#109) and biosigIO converts
        # the file. `int()` of the raw field refuses it, so the count was None
        # without a word.
        p = self.patched_edf(
            "nul_ns_eeg.edf", ["Fp1", "Fp2", "Cz", "EDF Annotations"], 252, b"4\x00\x00\x00"
        )
        self.assertEqual(self.count_and_log(p), (3, ""))

    def test_a_field_is_cut_at_its_first_nul_then_stripped(self):
        # biosigio's `_decode_field`: everything after the first NUL is
        # ignored, so a value followed by NULs and junk is still the value, and
        # trailing spaces before the NUL go too.
        p = self.patched_edf(
            "nul_junk_eeg.edf", ["Fp1", "Fp2", "Cz", "EDF Annotations"], 252, b"4 \x009"
        )
        self.assertEqual(self.count_and_log(p), (3, ""))

    def test_a_nul_padded_annotation_label_is_still_the_annotation_track(self):
        # `strip()` leaves the NUL, so "EDF Annotations\x00" != "EDF Annotations"
        # and the pseudo-signal was counted as a data channel: 4 in the header,
        # 3 in the store, a complete store refused.
        p = self.patched_edf(
            "nul_label_eeg.edf", ["Fp1", "Fp2", "Cz", "EDF Annotations"],
            256 + 16 * 3, b"EDF Annotations\x00",
        )
        self.assertEqual(self.count_and_log(p), (3, ""))

    def test_an_unreadable_header_is_unknown_and_says_so(self):
        four = ["Fp1", "Fp2", "Cz", "EDF Annotations"]
        short = self.path("short_eeg.edf")
        with open(short, "wb") as fh:
            fh.write(b"0" * 100)
        cut = self.patched_edf("cut_eeg.edf", four, 0, b"")
        with open(cut, "r+b") as fh:
            fh.truncate(256 + 20)
        no_count = self.path("no_count_eeg.vhdr")
        with open(no_count, "w") as fh:
            fh.write("[Common Infos]\nDataFile=x.eeg\n")
        zero_count = self.path("zero_count_eeg.vhdr")
        with open(zero_count, "w") as fh:
            fh.write("[Common Infos]\nNumberOfChannels=0\n")
        cases = {
            "EDF header short of 256 bytes": (short, "EDF"),
            "EDF signal count not an integer": (
                self.patched_edf("word_eeg.edf", four, 252, b"abcd"), "EDF"),
            "EDF declares no signals": (
                self.patched_edf("none_eeg.edf", four, 252, b"0   "), "EDF"),
            "EDF label block cut short": (cut, "EDF"),
            "BDF signal count not an integer": (
                self.patched_edf("word_eeg.bdf", four, 252, b"??  "), "BDF"),
            "EDF file that is not there": (self.path("absent_eeg.edf"), "EDF"),
            "BrainVision without a channel count": (no_count, "BrainVision"),
            "BrainVision with a zero channel count": (zero_count, "BrainVision"),
        }
        for name, (path, kind) in cases.items():
            with self.subTest(name):
                value, log = self.count_and_log(path)
                self.assertIsNone(value)
                self.assertIn(f"could not read the {kind} header", log)
                self.assertIn(path, log)
                self.assertIn("the gate uses channels.tsv alone", log)

    def test_a_format_with_no_cheap_header_is_unknown_without_a_warning(self):
        # Nothing here was expected to have a header to read, so nothing is
        # unreadable: the quiet None is the whole answer. (A `.set` used to be
        # the example here; it has a header count now, and an unreadable one
        # warns, see TestEeglabDeclaredChannelCount.)
        p = self.path("r_meg.con")
        with open(p, "wb") as fh:
            fh.write(b"KIT header bytes")
        self.assertEqual(self.count_and_log(p), (None, ""))

    def test_brainvision_reads_its_count_key_without_regard_to_case(self):
        # MNE's configparser lowercases option names, so `numberofchannels=4`
        # converts; the section name stays case-sensitive there, and here.
        p = self.path("lc_eeg.vhdr")
        with open(p, "w") as fh:
            fh.write("[Common Infos]\nDataFile=lc_eeg.eeg\nnumberofchannels=4\n")
        self.assertEqual(self.count_and_log(p), (4, ""))
        q = self.path("lcsection_eeg.vhdr")
        with open(q, "w") as fh:
            fh.write("[common infos]\nNumberOfChannels=4\n")
        self.assertIsNone(self.count_and_log(q)[0])

    def test_a_real_edf_plus_from_pyedflib(self):
        # EDF+ writers append the annotation pseudo-signal; it must not count.
        try:
            import pyedflib  # noqa: F401
        except ImportError:
            self.skipTest("pyedflib not installed")
        p = build_real_edf(self.dir, "real_eeg", n_channels=4, seconds=2)
        self.assertEqual(file_declared_channel_count(p), 4)


class TestFifDeclaredChannelCountWithoutMne(unittest.TestCase):
    """No MNE means no header count, and the log says so. Run in a real
    interpreter without site-packages (`-S`), so MNE is genuinely absent
    whether or not this suite's environment has it."""

    def test_a_missing_mne_is_unknown_and_says_so(self):
        here = os.path.dirname(os.path.abspath(__file__))
        code = (
            "import sys; sys.path.insert(0, sys.argv[1]); import generate_zarr as g; "
            "print('RESULT', g.file_declared_channel_count(sys.argv[2]))"
        )
        proc = subprocess.run(
            [sys.executable, "-S", "-c", code, here, "sub-01_task-rest_meg.fif"],
            capture_output=True, text=True, check=True,
        )
        self.assertIn("RESULT None", proc.stdout)
        self.assertIn("MNE is not importable", proc.stdout)
        self.assertIn("sub-01_task-rest_meg.fif", proc.stdout)


class TestFifDeclaredChannelCount(unittest.TestCase):
    """The FIF branch of the header count (on000117: an MEG sidecar declaring
    404 channels over a FIF that holds 395, refused as a truncation because no
    header count existed for FIF)."""

    @classmethod
    def setUpClass(cls):
        if not _have_mne():
            raise unittest.SkipTest("mne not installed")

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def test_a_real_fif_reports_every_channel_in_its_info(self):
        p = build_real_fif(os.path.join(self.dir, "sub-01_task-rest_meg.fif"))
        self.assertEqual(file_declared_channel_count(p), len(FIF_CHANNELS))

    def test_a_gzipped_fif_is_read_too(self):
        p = build_real_fif(os.path.join(self.dir, "sub-01_task-rest_meg.fif.gz"))
        self.assertEqual(file_declared_channel_count(p), len(FIF_CHANNELS))

    def test_a_split_recording_is_counted_from_its_head(self):
        # The converter hands the gate the chain head. Cost: MNE reserves a 1 MB
        # cushion per split, so a "2MB" split holds ~1 MB of samples; 120 s at
        # 1 kHz x 5 float32 channels (~2.4 MB) is the least that yields three
        # `split-NN` files, written to a tmpdir in well under a second.
        build_real_fif(
            os.path.join(self.dir, "sub-01_task-rest_meg.fif"),
            rate=1000.0, seconds=120, split_size="2MB", split_naming="bids",
        )
        head = os.path.join(self.dir, "sub-01_task-rest_split-01_meg.fif")
        self.assertTrue(os.path.exists(os.path.join(self.dir, "sub-01_task-rest_split-02_meg.fif")))
        self.assertEqual(file_declared_channel_count(head), len(FIF_CHANNELS))

    def test_an_unreadable_fif_is_unknown_and_says_so(self):
        p = os.path.join(self.dir, "broken_meg.fif")
        with open(p, "wb") as fh:
            fh.write(b"not a fif header at all")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIsNone(file_declared_channel_count(p))
        self.assertIn("could not read the FIF header", out.getvalue())
        self.assertIsNone(file_declared_channel_count(os.path.join(self.dir, "absent_meg.fif")))

    def test_a_store_short_of_the_fif_header_is_still_truncated(self):
        # The header count loosens nothing for a real truncation: a store
        # missing a channel the FIF declares is withheld, sidecar or not.
        p = build_real_fif(os.path.join(self.dir, "sub-01_task-rest_meg.fif"))
        in_file = file_declared_channel_count(p)
        assert in_file is not None
        self.assertEqual(channel_gate_verdict(in_file - 1, in_file + 9, in_file), "truncated")
        self.assertEqual(channel_gate_verdict(in_file - 1, in_file, in_file), "truncated")
        self.assertEqual(channel_gate_verdict(in_file, in_file + 9, in_file), "sidecar_overcount")


def build_eeglab_set(
    path: str, nbchan: int = 3, *, rows: int | None = None, pnts: int = 500,
    trials: int = 1, fdt: bool = False, v73: bool = False, wrapped: bool = True,
    compress: bool = True, labels: list[str] | None = None, dtype: str = "float64",
) -> str:
    """Write a REAL EEGLAB `.set` the way biosigIO reads it, and return `path`.

    Classic (MAT v5/v7) files are written with `scipy.io.savemat`, v7.3 files
    with h5py under the MATLAB 7.3 header text in a 512-byte user block, which
    is what MATLAB writes and what biosigIO's `_is_matlab_v73` sniffs.
    `wrapped` puts every field in one `EEG` struct (classic EEGLAB) or an `EEG`
    group (v7.3); otherwise they are saved flat. `rows` is the data matrix's row
    count when it should disagree with `nbchan`. `fdt=True` writes the samples
    to a float32 `.fdt` beside the `.set`, column-major, and stores its name in
    `data`. `labels` becomes a classic `chanlocs` struct array (it may be shorter
    than `nbchan`: chanlocs only names rows)."""
    import numpy as np

    rows = nbchan if rows is None else rows
    rng = np.random.default_rng(3)
    data = (rng.standard_normal((rows, pnts * trials)) * 1e-5).astype(np.float32)
    fdt_name = os.path.splitext(os.path.basename(path))[0] + ".fdt"
    if fdt:
        data.flatten(order="F").tofile(os.path.splitext(path)[0] + ".fdt")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    header = {"nbchan": nbchan, "trials": trials, "pnts": pnts, "srate": 250.0}
    if v73:
        import h5py

        with h5py.File(path, "w", userblock_size=512) as f:
            eeg = f.create_group("EEG") if wrapped else f
            for key, value in header.items():
                eeg.create_dataset(key, data=np.array([[float(value)]]))
            if fdt:
                codes = np.array([[ord(ch)] for ch in fdt_name], dtype=np.uint16)
                eeg.create_dataset("data", data=codes)
            else:
                # h5py sees MATLAB's (nbchan, pnts) transposed.
                eeg.create_dataset("data", data=data.T.astype(dtype))
        with open(path, "r+b") as fh:
            fh.write(b"MATLAB 7.3 MAT-file, Platform: GLNXA64, Created by: test".ljust(116))
        return path
    import scipy.io

    fields: dict[str, object] = {"setname": "eeglab_fixture"}
    fields.update({k: np.array([[float(v)]]) for k, v in header.items()})
    if fdt:
        fields["data"] = fdt_name
    elif trials > 1:
        fields["data"] = data.reshape((rows, pnts, trials), order="F").astype(dtype)
    else:
        fields["data"] = data.astype(dtype)
    if labels is not None:
        locs = np.zeros((1, len(labels)), dtype=[("labels", "O"), ("type", "O")])
        for i, label in enumerate(labels):
            locs[0, i] = (label, "EEG")
        fields["chanlocs"] = locs
    scipy.io.savemat(path, {"EEG": fields} if wrapped else fields, do_compression=compress)
    return path


class Mat5:
    """A minimal MAT v5 writer, byte for byte per MathWorks' "MAT-File Format",
    for the layouts `scipy.io.savemat` cannot produce: big-endian files, a 1xN
    `EEG` struct array, fields in an arbitrary order, several top-level
    variables. Every file it writes is also checked by `scipy.io.loadmat` in the
    tests that use it, so the writer is not trusted on its own word.

    `end` is the struct byte order, "<" or ">". A matrix is returned as the
    bytes of one whole miMATRIX element; `file` wraps variables in the 128-byte
    header, each optionally in its own miCOMPRESSED element."""

    def __init__(self, end: str = "<") -> None:
        self.end = end

    def elem(self, mtype: int, data: bytes) -> bytes:
        import struct

        n = len(data)
        if 0 < n <= 4:  # small data element: packed into the tag
            return struct.pack(self.end + "I", (n << 16) | mtype) + data.ljust(4, b"\0")
        return struct.pack(self.end + "II", mtype, n) + data + b"\0" * (-n % 8)

    def matrix(
        self, name: str, mclass: int, dims: list[int], body: bytes = b"",
    ) -> bytes:
        import struct

        payload = (
            self.elem(6, struct.pack(self.end + "II", mclass, 0))
            + self.elem(5, struct.pack(self.end + f"{len(dims)}i", *dims))
            + self.elem(1, name.encode())
            + body
        )
        return struct.pack(self.end + "II", 14, len(payload)) + payload

    def scalar(self, name: str, value: float, kind: str = "double") -> bytes:
        """A 1x1 numeric matrix; `uint8` and `int32` store their value in a
        small data element (the tag's own 8 bytes)."""
        import struct

        mclass, mtype, fmt = {
            "double": (6, 9, "d"), "uint8": (9, 2, "B"), "int32": (12, 5, "i"),
        }[kind]
        value_bytes = struct.pack(self.end + fmt, int(value) if fmt != "d" else value)
        return self.matrix(name, mclass, [1, 1], self.elem(mtype, value_bytes))

    def chars(self, name: str, text: str) -> bytes:
        import struct

        body = self.elem(4, struct.pack(self.end + f"{len(text)}H", *map(ord, text)))
        return self.matrix(name, 4, [1, len(text)], body)

    def doubles(self, name: str, rows: int, cols: int, seed: int = 0) -> bytes:
        import numpy as np

        arr = np.random.default_rng(seed).standard_normal((rows, cols)).astype(self.end + "f8")
        return self.matrix(name, 6, [rows, cols], self.elem(9, arr.tobytes(order="F")))

    def struct(self, name: str, elements: list[list[tuple[str, bytes]]]) -> bytes:
        """A 1xN struct array; every element lists the same fields in the same
        order, each field a matrix (its own name is ignored, as MATLAB's is)."""
        import struct

        width = 32
        names = [field for field, _ in elements[0]]
        body = self.elem(5, struct.pack(self.end + "i", width)) + self.elem(
            1, b"".join(n.encode().ljust(width, b"\0") for n in names)
        )
        for element in elements:
            assert [field for field, _ in element] == names
            body += b"".join(matrix for _, matrix in element)
        return self.matrix(name, 2, [1, len(elements)], body)

    def eeg_fields(
        self, nbchan: float, rows: int, pnts: int = 20, *, nbchan_kind: str = "double",
        nbchan_after_data: bool = False, flat: bool = False,
    ) -> list[tuple[str, bytes]]:
        """The fields biosigIO's importer needs, in EEGLAB's order unless
        `nbchan_after_data` moves `nbchan` past `data`. Struct fields carry no
        name of their own, as MATLAB writes them; `flat` names each matrix, to
        be saved as top-level variables."""

        def name(field: str) -> str:
            return field if flat else ""

        fields = [
            ("setname", self.chars(name("setname"), "fixture")),
            ("nbchan", self.scalar(name("nbchan"), nbchan, nbchan_kind)),
            ("trials", self.scalar(name("trials"), 1)),
            ("pnts", self.scalar(name("pnts"), pnts)),
            ("srate", self.scalar(name("srate"), 100.0)),
            ("data", self.doubles(name("data"), rows, pnts)),
        ]
        if nbchan_after_data:
            fields.append(fields.pop(1))
        return fields

    def file(self, path: str, variables: list[bytes], compress: bool = False) -> str:
        import struct
        import zlib

        head = b"MATLAB 5.0 MAT-file, written by the test suite".ljust(116)
        out = head + b"\0" * 8 + struct.pack(self.end + "H", 0x0100)
        out += b"IM" if self.end == "<" else b"MI"
        for variable in variables:
            if compress:
                blob = zlib.compress(variable)
                out += struct.pack(self.end + "II", 15, len(blob)) + blob
            else:
                out += variable
        with open(path, "wb") as fh:
            fh.write(out)
        return path


class TestEeglabDeclaredChannelCount(unittest.TestCase):
    """The EEGLAB branch of the header count (on003645: EEG `.set` recordings
    holding 75 channels under a subject-level channels.tsv listing its 404 MEG
    channels, refused as truncations because `.set` had no header count).

    Every file is real, written by scipy or h5py, and wherever the count is
    returned it is checked against the channels biosigIO actually imports from
    the same file: the header may only vouch for what the importer serves."""

    @classmethod
    def setUpClass(cls):
        try:
            import h5py  # noqa: F401
            import scipy.io  # noqa: F401
            from biosigio import Recording  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"EEGLAB deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def path(self, name: str) -> str:
        return os.path.join(self.dir, f"sub-01_task-{name}_eeg.set")

    def imported(self, p: str) -> int:
        import warnings

        from biosigio import Recording

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # the importer warns on a short chanlocs
            signals = Recording.from_file(p).signals
        assert signals is not None
        return signals.shape[1]

    def assert_counts(self, p: str, expected: int) -> None:
        self.assertEqual(file_declared_channel_count(p), expected)
        self.assertEqual(self.imported(p), expected)

    def quiet_none(self, p: str) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIsNone(file_declared_channel_count(p))
        self.assertIn("could not read the EEGLAB header", out.getvalue())
        self.assertIn(p, out.getvalue())
        return out.getvalue()

    def test_a_classic_set_in_every_layout(self):
        for wrapped in (True, False):
            for compress in (True, False):
                with self.subTest(wrapped=wrapped, compress=compress):
                    p = build_eeglab_set(
                        self.path(f"c{int(wrapped)}{int(compress)}"), 5,
                        wrapped=wrapped, compress=compress,
                    )
                    self.assert_counts(p, 5)

    def test_integer_and_single_precision_matrices(self):
        # MATLAB stores what it saves in the narrowest type that holds it; the
        # header read must not care which numeric class `data` or `nbchan` has.
        for dtype in ("float32", "int16"):
            with self.subTest(dtype=dtype):
                p = build_eeglab_set(self.path(dtype), 6, dtype=dtype)
                self.assertEqual(file_declared_channel_count(p), 6)

    def test_a_classic_set_with_its_samples_in_a_fdt(self):
        for wrapped in (True, False):
            with self.subTest(wrapped=wrapped):
                p = build_eeglab_set(self.path(f"fdt{int(wrapped)}"), 7, fdt=True, wrapped=wrapped)
                self.assert_counts(p, 7)

    def test_a_v73_set_nested_and_flat(self):
        for wrapped in (True, False):
            with self.subTest(wrapped=wrapped):
                p = build_eeglab_set(self.path(f"h{int(wrapped)}"), 4, v73=True, wrapped=wrapped)
                self.assert_counts(p, 4)

    def test_a_v73_set_with_its_samples_in_a_fdt(self):
        p = build_eeglab_set(self.path("hfdt"), 4, v73=True, fdt=True)
        self.assert_counts(p, 4)

    def test_a_v73_matrix_as_wide_as_it_is_long(self):
        # biosigIO transposes unless axis 0 alone matches nbchan; a square matrix
        # is transposed, and either way has nbchan rows.
        p = build_eeglab_set(self.path("sq"), 4, pnts=4, v73=True)
        self.assert_counts(p, 4)

    def test_an_epoched_set_still_counts_nbchan(self):
        # A `.fdt`-backed epoched classic set converts, flattened to nbchan rows.
        p = build_eeglab_set(self.path("epfdt"), 3, trials=4, fdt=True)
        self.assert_counts(p, 3)
        # An inline 3-D matrix and a v7.3 epoched file are refused by the
        # importer before any gate runs; the header count is still nbchan.
        self.assertEqual(
            file_declared_channel_count(build_eeglab_set(self.path("ep"), 3, trials=4)), 3
        )
        self.assertEqual(
            file_declared_channel_count(build_eeglab_set(self.path("hep"), 3, trials=4, v73=True)),
            3,
        )

    def test_a_short_chanlocs_changes_nothing(self):
        # chanlocs only names rows: biosigIO pads the labels and keeps every row.
        p = build_eeglab_set(self.path("locs"), 4, labels=["Fz", "Cz"])
        self.assert_counts(p, 4)

    def test_an_eeg_struct_wins_over_flat_variables(self):
        # biosigIO's `_normalize_eeglab_dict`: the struct's fields, then any
        # top-level variable the struct does not have.
        import numpy as np
        import scipy.io

        p = self.path("both")
        rows = np.zeros((4, 50))
        scipy.io.savemat(p, {
            "nbchan": np.array([[9.0]]), "data": np.zeros((9, 50)),
            "EEG": {"nbchan": np.array([[4.0]]), "trials": np.array([[1.0]]),
                    "pnts": np.array([[50.0]]), "srate": np.array([[250.0]]), "data": rows},
        })
        self.assert_counts(p, 4)

    def test_nbchan_disagreeing_with_the_matrix_is_not_a_count(self):
        # biosigIO serves the matrix's rows whatever nbchan says. An nbchan
        # ABOVE them would refuse a faithful store; one BELOW them is not taken
        # as a lower bound either, since the count is published as `in_file`
        # and a header its own matrix contradicts proves nothing. Neither
        # direction vouches.
        for label, nbchan, v73 in (
            ("classicover", 5, False), ("classicunder", 3, False),
            ("v73over", 5, True), ("v73under", 3, True),
        ):
            with self.subTest(label):
                p = build_eeglab_set(self.path(label), nbchan, rows=4, v73=v73)
                self.assertIn("disagrees with the 4-row data matrix", self.quiet_none(p))
                self.assertEqual(self.imported(p), 4)

    def test_a_fractional_nbchan_is_unknown_whatever_biosigio_makes_of_it(self):
        # biosigIO truncates a classic file's nbchan and rounds a v7.3 file's,
        # so 3.6 is 3 channels to one importer path and 4 to the other. The
        # header read vouches for neither: None, never a count.
        import h5py
        import numpy as np
        import scipy.io

        p = build_eeglab_set(self.path("fracclassic"), 3, fdt=True)
        mat = scipy.io.loadmat(p)["EEG"][0, 0]
        fields = {name: mat[name] for name in mat.dtype.names}
        fields["nbchan"] = np.array([[3.6]])
        scipy.io.savemat(p, {"EEG": fields})
        self.assertIn("nbchan is 3.6", self.quiet_none(p))
        self.assertEqual(self.imported(p), 3)  # int(3.6)

        q = build_eeglab_set(self.path("fracv73"), 4, v73=True)
        with h5py.File(q, "r+") as f:
            f["EEG"]["nbchan"][...] = 3.6
        self.assertIn("nbchan is 3.6", self.quiet_none(q))
        self.assertEqual(self.imported(q), 4)  # int(round(3.6))

    def test_an_unusable_nbchan_is_unknown(self):
        for label, value in {"zero": 0, "negative": -3, "fraction": 3.5, "absurd": 10**7}.items():
            with self.subTest(label):
                # `.fdt`-backed, so nbchan is the only count the header has:
                # no inline matrix can disagree with it and mask the check.
                p = build_eeglab_set(self.path(label), 3, fdt=True)
                # Rewrite nbchan in place.
                import numpy as np
                import scipy.io

                mat = scipy.io.loadmat(p)["EEG"][0, 0]
                fields = {name: mat[name] for name in mat.dtype.names}
                fields["nbchan"] = np.array([[float(value)]])
                scipy.io.savemat(p, {"EEG": fields})
                self.quiet_none(p)

    def test_a_set_with_no_nbchan_or_no_data_is_unknown(self):
        import numpy as np
        import scipy.io

        p = self.path("nonb")
        scipy.io.savemat(p, {"EEG": {"pnts": np.array([[50.0]]), "data": np.zeros((3, 50))}})
        self.quiet_none(p)
        q = self.path("nodata")
        scipy.io.savemat(q, {"EEG": {"nbchan": np.array([[3.0]]), "pnts": np.array([[50.0]])}})
        self.assertIn("no readable data matrix", self.quiet_none(q))

    def test_an_unreadable_set_is_unknown_and_says_so(self):
        good = build_eeglab_set(self.path("good"), 3, compress=True)
        with open(good, "rb") as fh:
            original = fh.read()
        hgood = build_eeglab_set(self.path("hgood"), 3, v73=True)
        with open(hgood, "rb") as fh:
            h_original = fh.read()
        cases = {
            "garbage": b"not a MAT file at all",
            "empty": b"",
            "header only": original[:128],
            "cut mid-variable": original[: len(original) // 2],
            "compressed stream corrupted": original[:200] + b"\xff" * 64 + original[264:],
            "v7.3 cut short": h_original[:600],
        }
        for name, content in cases.items():
            with self.subTest(name):
                p = self.path(name.replace(" ", "").replace(".", ""))
                with open(p, "wb") as fh:
                    fh.write(content)
                self.quiet_none(p)
        self.assertIsNone(file_declared_channel_count(self.path("absent")))

    def test_a_v73_file_that_is_not_an_eeglab_set_is_unknown(self):
        import h5py

        p = self.path("otherh5")
        with h5py.File(p, "w", userblock_size=512) as f:
            f.create_dataset("something_else", data=[1.0])
        with open(p, "r+b") as fh:
            fh.write(b"MATLAB 7.3 MAT-file".ljust(116))
        self.quiet_none(p)

    def loadmat_nbchan(self, p: str) -> float:
        """nbchan as scipy reads the same file: the hand-built writer's check."""
        import scipy.io

        mat = scipy.io.loadmat(p)
        eeg = mat["EEG"][0, 0] if "EEG" in mat else mat
        return float(eeg["nbchan"].ravel()[0])

    def test_hand_built_layouts(self):
        """Layouts scipy's writer cannot produce, each read three ways: by the
        header read, by scipy, and by biosigIO's importer (the count must be
        the rows it serves)."""
        for end, compress, nbchan_kind, nbchan_after_data in itertools.product(
            "<>", (False, True), ("double", "uint8", "int32"), (False, True),
        ):
            # uint8/int32 nbchan sit in a small data element, whose tag a
            # big-endian file stores with its halves swapped.
            m = Mat5(end)
            label = f"{'be' if end == '>' else 'le'}{int(compress)}{nbchan_kind}{int(nbchan_after_data)}"
            with self.subTest(label):
                fields = m.eeg_fields(7, 7, nbchan_kind=nbchan_kind,
                                      nbchan_after_data=nbchan_after_data)
                p = m.file(self.path(label), [m.struct("EEG", [fields])], compress=compress)
                self.assertEqual(self.loadmat_nbchan(p), 7)
                self.assert_counts(p, 7)

    def test_hand_built_flat_big_endian(self):
        for compress in (False, True):
            with self.subTest(compress=compress):
                m = Mat5(">")
                fields = m.eeg_fields(5, 5, flat=True)
                p = m.file(self.path(f"beflat{int(compress)}"),
                           [matrix for _, matrix in fields], compress=compress)
                self.assertEqual(self.loadmat_nbchan(p), 5)
                self.assert_counts(p, 5)

    def test_the_first_element_of_an_eeg_struct_array_wins(self):
        # biosigIO takes EEG(1); MAT v5 stores a struct array element by element.
        for compress in (False, True):
            with self.subTest(compress=compress):
                m = Mat5("<")
                elements = [m.eeg_fields(3, 3), m.eeg_fields(9, 9)]
                p = m.file(self.path(f"sarr{int(compress)}"), [m.struct("EEG", elements)],
                           compress=compress)
                self.assertEqual(self.loadmat_nbchan(p), 3)
                self.assert_counts(p, 3)
                # And a first element that disagrees with itself is not rescued
                # by a consistent second one.
                elements = [m.eeg_fields(5, 3), m.eeg_fields(9, 9)]
                q = m.file(self.path(f"sarrbad{int(compress)}"), [m.struct("EEG", elements)],
                           compress=compress)
                self.quiet_none(q)

    def test_other_top_level_variables_around_eeg(self):
        # An EEGLAB workspace save: variables before and after `EEG`, one of
        # them a large matrix skipped unread, and flat nbchan/data decoys the
        # `EEG` struct outranks.
        for compress in (False, True):
            with self.subTest(compress=compress):
                m = Mat5("<")
                p = m.file(self.path(f"multi{int(compress)}"), [
                    m.chars("LASTCOM", "pop_loadset();"),
                    m.doubles("ALLCOM", 50, 2000, seed=1),
                    m.scalar("nbchan", 9),
                    m.struct("EEG", [m.eeg_fields(6, 6)]),
                    m.doubles("data", 9, 20, seed=2),
                    m.scalar("CURRENTSET", 1, "int32"),
                ], compress=compress)
                self.assertEqual(self.loadmat_nbchan(p), 6)
                self.assert_counts(p, 6)

    def test_a_file_cut_anywhere_is_unknown_or_right(self):
        """Truncated at every 2% (and at every byte of the first 512) of a real
        compressed, uncompressed and big-endian file: each read returns None
        or the true count, never raises, and ends promptly."""
        import signal

        files = {
            "scipyc": (build_eeglab_set(self.path("cutc"), 5, pnts=4000, compress=True), 5),
            "scipyu": (build_eeglab_set(self.path("cutu"), 5, pnts=4000, compress=False), 5),
            "be": (Mat5(">").file(self.path("cutbe"), [
                Mat5(">").struct("EEG", [Mat5(">").eeg_fields(7, 7, pnts=4000)])
            ], compress=True), 7),
        }
        guard = hasattr(signal, "SIGALRM")

        def timeout(*_):
            raise TimeoutError("header read did not return within 5 s")

        previous = signal.signal(signal.SIGALRM, timeout) if guard else None
        self.addCleanup(lambda: guard and signal.signal(signal.SIGALRM, previous))
        for name, (src, truth) in files.items():
            with open(src, "rb") as fh:
                raw = fh.read()
            cuts = sorted({len(raw) * pct // 100 for pct in range(0, 101, 2)} | set(range(512)))
            cut_path = self.path(f"{name}cut")
            for cut in cuts:
                with self.subTest(name, cut=cut):
                    with open(cut_path, "wb") as fh:
                        fh.write(raw[:cut])
                    if guard:
                        signal.alarm(5)
                    try:
                        with contextlib.redirect_stdout(io.StringIO()):
                            got = file_declared_channel_count(cut_path)
                    finally:
                        if guard:
                            signal.alarm(0)
                    self.assertIn(got, (None, truth))
                    if cut == len(raw):
                        self.assertEqual(got, truth)

    def test_a_compressed_data_matrix_is_never_inflated(self):
        """The walk stops at `data`'s dimensions instead of skipping to its
        end, which inside a compressed `EEG` would inflate every sample (CPU
        linear in the file, for nothing). Here the deflate stream is real for
        the header and the first 64 KiB of samples and garbage after, so a
        read that inflates any further fails and returns None. The same file
        with `nbchan` moved past `data`, where skipping `data` is unavoidable,
        shows the garbage is reached when it is read."""
        import struct
        import zlib

        m = Mat5("<")
        for nbchan_after_data, expected in ((False, 4), (True, None)):
            with self.subTest(nbchan_after_data=nbchan_after_data):
                fields = m.eeg_fields(4, 4, pnts=200_000, nbchan_after_data=nbchan_after_data)
                eeg = m.struct("EEG", [fields])
                data = dict(fields)["data"]
                cut = eeg.index(data) + 64 * 1024
                co = zlib.compressobj()
                head = co.compress(eeg[:cut]) + co.flush(zlib.Z_SYNC_FLUSH)
                blob = head + b"\xff" * (len(zlib.compress(eeg)) - len(head))
                with self.assertRaises(zlib.error):
                    zlib.decompress(blob)
                p = m.file(self.path(f"garbled{int(nbchan_after_data)}"), [])
                with open(p, "ab") as fh:
                    fh.write(struct.pack("<II", 15, len(blob)) + blob)
                if expected is None:
                    self.assertIn("decompressing", self.quiet_none(p))
                else:
                    self.assertEqual(file_declared_channel_count(p), expected)

    def test_a_zlib_bomb_ahead_of_nbchan_is_cut_off(self):
        """A compressed `EEG` whose first field declares more zeros than
        `EEGLAB_MAX_HEADER_READ_BYTES` (a few hundred KB on disk) is given up
        on after the cap, not inflated to its end: None, one warning, quickly.
        Just under the cap the same shape is read through and counted, so the
        cap is what stops it."""
        import struct
        import zlib

        cap = generate_zarr.EEGLAB_MAX_HEADER_READ_BYTES
        m = Mat5("<")
        chunk = b"\0" * (1 << 20)

        def bomb(p: str, zeros: int) -> str:
            # EEG = struct(comments=<`zeros` bytes of char>, nbchan, ..., data),
            # compressed as one stream without ever holding `zeros` in memory.
            fields = m.eeg_fields(4, 4)
            comments_head = (
                m.elem(6, struct.pack("<II", 4, 0))
                + m.elem(5, struct.pack("<2i", 1, zeros // 2))
                + m.elem(1, b"")
            )
            comments_len = len(comments_head) + 8 + zeros + (-zeros % 8)
            names = ["comments"] + [name for name, _ in fields]
            body_head = (
                m.elem(6, struct.pack("<II", 2, 0)) + m.elem(5, struct.pack("<2i", 1, 1))
                + m.elem(1, b"EEG") + m.elem(5, struct.pack("<i", 32))
                + m.elem(1, b"".join(n.encode().ljust(32, b"\0") for n in names))
            )
            rest = b"".join(matrix for _, matrix in fields)
            total = len(body_head) + 8 + comments_len + len(rest)
            co = zlib.compressobj(1)
            blob = co.compress(
                struct.pack("<II", 14, total) + body_head
                + struct.pack("<II", 14, comments_len) + comments_head
                + struct.pack("<II", 4, zeros)
            )
            for _ in range(zeros // len(chunk)):
                blob += co.compress(chunk)
            blob += co.compress(b"\0" * (zeros % len(chunk) + (-zeros % 8)) + rest) + co.flush()
            m.file(p, [])
            with open(p, "ab") as fh:
                fh.write(struct.pack("<II", 15, len(blob)) + blob)
            return p

        under = bomb(self.path("undercap"), cap - (1 << 20))
        self.assertEqual(file_declared_channel_count(under), 4)
        over = bomb(self.path("overcap"), cap + (1 << 20))
        self.assertLess(os.path.getsize(over), 2 << 20)
        started = time.monotonic()
        log = self.quiet_none(over)
        self.assertLess(time.monotonic() - started, 10)
        self.assertIn(f"more than {cap} bytes", log)
        self.assertEqual(log.count("::warning::"), 1)

    def test_the_sample_matrix_is_never_loaded(self):
        """The whole point of reading nbchan by hand: `loadmat(variable_names=
        ["EEG"])` still materializes every sample, because a classic export is
        ONE variable, `EEG`, with `data` inside. Measured here against the same
        file, so the bound is shown to separate the two reads.

        With `nbchan` stored after `data` the walk has to skip the whole matrix,
        inflating it when compressed; memory must stay flat through that too.
        The bound (a sixteenth of the samples, 3.2 MB) sits far above the
        parser's measured peak (under 0.4 MB) and far below loadmat's."""
        import tracemalloc

        import numpy as np
        import scipy.io

        nbchan, pnts = 32, 400_000
        data_bytes = nbchan * pnts * 4  # 51.2 MB of float32 samples, inline
        block = np.random.default_rng(3).standard_normal((nbchan, 1000)).astype(np.float32)
        samples = np.tile(block, (1, pnts // 1000))  # tiled: quick to compress
        for compress, nbchan_after_data in itertools.product((False, True), repeat=2):
            with self.subTest(compress=compress, nbchan_after_data=nbchan_after_data):
                p = self.path(f"big{int(compress)}{int(nbchan_after_data)}")
                fields: dict[str, object] = {
                    "setname": "big", "trials": np.array([[1.0]]),
                    "pnts": np.array([[float(pnts)]]), "srate": np.array([[250.0]]),
                }
                if not nbchan_after_data:
                    fields["nbchan"] = np.array([[float(nbchan)]])
                fields["data"] = samples
                fields["nbchan"] = np.array([[float(nbchan)]])
                scipy.io.savemat(p, {"EEG": fields}, do_compression=compress)
                tracemalloc.start()
                try:
                    self.assertEqual(file_declared_channel_count(p), 32)
                    header_peak = tracemalloc.get_traced_memory()[1]
                    tracemalloc.reset_peak()
                    scipy.io.loadmat(p, variable_names=["EEG"])
                    loadmat_peak = tracemalloc.get_traced_memory()[1]
                finally:
                    tracemalloc.stop()
                self.assertGreater(loadmat_peak, data_bytes * 0.9)
                self.assertLess(header_peak, data_bytes / 16)

    def test_a_store_short_of_the_set_header_is_still_truncated(self):
        # biosigIO keeps every row, so a short store cannot be produced through
        # the importer; the gate is driven with a real store built from fewer
        # channels and the real header of a file that holds more, as the FIF
        # and EDF tests do.
        from biosigio import Recording

        p = build_eeglab_set(self.path("full"), 5)
        short = build_eeglab_set(self.path("short"), 3)
        store = os.path.join(self.dir, "short.zarr")
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            Recording.from_file(short).to_zarr(store, dtype="int16")
        in_store = store_total_channels(store_metadata(store))
        self.assertEqual(in_store, 3)
        in_file = file_declared_channel_count(p)
        self.assertEqual(in_file, 5)
        for tsv in (None, 3, 5, 404):
            with self.subTest(channels_tsv=tsv):
                self.assertEqual(channel_gate_verdict(in_store, tsv, in_file), "truncated")
                with self.assertRaises(ChannelCountMismatch) as cm:
                    generate_zarr.enforce_channel_gate(
                        "sub-01/eeg/x_eeg.set", in_store, tsv, in_file
                    )
                self.assertIn("header declares 5", str(cm.exception))


class TestChannelGateVerdict(unittest.TestCase):
    def test_no_applicable_sidecar_passes(self):
        self.assertEqual(channel_gate_verdict(10, None, None), "pass")

    def test_a_store_that_meets_the_sidecar_passes(self):
        self.assertEqual(channel_gate_verdict(128, 128, None), "pass")
        self.assertEqual(channel_gate_verdict(130, 128, 120), "pass")

    def test_a_sidecar_that_over_declares_is_not_a_truncation(self):
        # on004789 sub-R1350D: 120 in the file, 120 in the store, 128 declared.
        self.assertEqual(channel_gate_verdict(120, 128, 120), "sidecar_overcount")

    def test_a_store_short_of_the_file_is_still_withheld(self):
        # biosigio#110: the importer served 1 of a file's 74 channels.
        self.assertEqual(channel_gate_verdict(1, 74, 74), "truncated")
        self.assertEqual(channel_gate_verdict(119, 128, 120), "truncated")

    def test_an_unreadable_header_keeps_the_old_strict_gate(self):
        self.assertEqual(channel_gate_verdict(120, 128, None), "truncated")

    def test_a_store_short_of_the_header_is_withheld_without_a_sidecar(self):
        # nm000110's shape before biosigio 1.2.9: a repeated EDF label
        # overwrote a channel, 22 in the store, 23 in the file. With no
        # channels.tsv at all this used to pass unexamined.
        self.assertEqual(channel_gate_verdict(22, None, 23), "truncated")

    def test_a_collapsed_sidecar_cannot_vouch_for_a_collapsed_store(self):
        # A sidecar written by a tool that keys channels by label collapses the
        # same way the store did and agrees with it; the header still counts
        # every channel.
        self.assertEqual(channel_gate_verdict(22, 22, 23), "truncated")
        self.assertEqual(channel_gate_verdict(23, 22, 23), "pass")


def build_labeled_edf(path: str, labels: list[str], rate: int = 256, seconds: int = 10) -> str:
    """Write a REAL EDF+ with pyedflib whose signals carry exactly `labels`,
    repeats included (EDF does not require unique labels; CHB-MIT repeats
    `T8-P8` and uses `-` for unused inputs). Returns `path`."""
    import numpy as np
    import pyedflib

    writer = pyedflib.EdfWriter(path, len(labels), file_type=pyedflib.FILETYPE_EDFPLUS)
    writer.setSignalHeaders([
        {
            "label": label,
            "dimension": "uV",
            "sample_frequency": rate,
            "physical_max": 3000.0,
            "physical_min": -3000.0,
            "digital_max": 32767,
            "digital_min": -32768,
            "transducer": "",
            "prefilter": "",
        }
        for label in labels
    ])
    rng = np.random.default_rng(0)
    writer.writeSamples([rng.normal(0, 20, rate * seconds) for _ in labels])
    writer.close()
    return path


# CHB-MIT's montage, shortened: a bipolar label the file repeats, and `-`
# placeholders for unused amplifier inputs.
CHB_MIT_LABELS = [
    "FP1-F7", "F7-T7", "T7-P7", "P7-O1", "-", "T8-P8", "-", "T8-P8", "-",
]
# What biosigio >= 1.2.9 (and MNE, and so an MNE-BIDS channels.tsv) names them.
CHB_MIT_SUFFIXED = [
    "FP1-F7", "F7-T7", "T7-P7", "P7-O1", "--0", "T8-P8-0", "--1", "T8-P8-1", "--2",
]


class TestChannelGateOnRealFiles(unittest.TestCase):
    """`enforce_channel_gate`, the step `convert_one` runs before any sync,
    driven with a store biosigIO really built and an EDF header really written.

    A store short of its file cannot be produced through `convert_one` on
    biosigio >= 1.2.9: the importer now keeps every repeated label, which is
    the fix this gate exists to back up. So the collapsed store is built the
    way the old importer left it, from the file's labels with the repeats
    removed, and gated against the file that repeats them."""

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
            from biosigio import Recording  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def store_from(self, labels: list[str]) -> int:
        from biosigio import Recording

        src = build_labeled_edf(os.path.join(self.dir, "collapsed.edf"), labels)
        store = os.path.join(self.dir, "collapsed.zarr")
        Recording.from_file(src).to_zarr(store, dtype="int16")
        return store_total_channels(store_metadata(store))

    def test_the_header_counts_every_repeated_label(self):
        f = build_labeled_edf(os.path.join(self.dir, "chb_eeg.edf"), CHB_MIT_LABELS)
        self.assertEqual(file_declared_channel_count(f), len(CHB_MIT_LABELS))

    def test_a_collapsed_store_is_refused_with_or_without_a_sidecar(self):
        f = build_labeled_edf(os.path.join(self.dir, "chb_eeg.edf"), CHB_MIT_LABELS)
        collapsed = list(dict.fromkeys(CHB_MIT_LABELS))  # what a label-keyed import kept
        in_store = self.store_from(collapsed)
        self.assertEqual(in_store, len(collapsed))
        in_file = file_declared_channel_count(f)
        for tsv in (None, len(collapsed), len(CHB_MIT_LABELS)):
            with self.subTest(channels_tsv=tsv):
                with self.assertRaises(ChannelCountMismatch) as cm:
                    generate_zarr.enforce_channel_gate(
                        "sub-01/eeg/x_eeg.edf", in_store, tsv, in_file
                    )
                self.assertIn(f"header declares {in_file}", str(cm.exception))

    def test_a_complete_store_passes(self):
        f = build_labeled_edf(os.path.join(self.dir, "chb_eeg.edf"), CHB_MIT_LABELS)
        in_store = self.store_from(CHB_MIT_SUFFIXED)
        self.assertIsNone(generate_zarr.enforce_channel_gate(
            "sub-01/eeg/x_eeg.edf", in_store, len(CHB_MIT_LABELS),
            file_declared_channel_count(f),
        ))


class TestCleanOrphanSelection(unittest.TestCase):
    """`--clean` no longer wipes the prefix; it removes only the stores that are
    no longer produced at HEAD. `compute_clean_orphans` is the selection rule
    that replaced the wipe (nemarOrg/nemar-cli#1068 follow-up), and the exact
    function `main` calls -- not a hand-copied mirror of its logic."""

    def test_rebuilt_recordings_are_never_orphans(self):
        # The whole point: a full rebuild of the same dataset deletes NOTHING, so
        # the ~45 min wipe-then-re-upload of identical keys disappears.
        prior = {"stores": [
            {"zarr": "sub-01/eeg/sub-01_task-rest_eeg.zarr"},
            {"zarr": "sub-02/eeg/sub-02_task-rest_eeg.zarr"},
        ]}
        convert = ["sub-01/eeg/sub-01_task-rest_eeg.set", "sub-02/eeg/sub-02_task-rest_eeg.set"]
        self.assertEqual(compute_clean_orphans(prior, convert), set())

    def test_recording_dropped_from_head_is_removed(self):
        prior = {"stores": [
            {"zarr": "sub-01/eeg/sub-01_task-rest_eeg.zarr"},
            {"zarr": "sub-02/eeg/sub-02_task-rest_eeg.zarr"},
        ]}
        convert = ["sub-01/eeg/sub-01_task-rest_eeg.set"]
        self.assertEqual(
            compute_clean_orphans(prior, convert), {"sub-02/eeg/sub-02_task-rest_eeg.zarr"}
        )

    def test_renamed_recording_removes_the_old_store(self):
        prior = {"stores": [{"zarr": "sub-01/eeg/sub-01_task-old_eeg.zarr"}]}
        convert = ["sub-01/eeg/sub-01_task-new_eeg.set"]
        self.assertEqual(
            compute_clean_orphans(prior, convert), {"sub-01/eeg/sub-01_task-old_eeg.zarr"}
        )

    def test_first_conversion_has_no_prior_index_and_removes_nothing(self):
        self.assertEqual(
            compute_clean_orphans(None, ["sub-01/eeg/sub-01_task-rest_eeg.set"]), set()
        )

    def test_malformed_prior_entries_are_ignored(self):
        prior = {"stores": [{"zarr": 42}, {"no_zarr": "x"}, "notadict", {"zarr": "a.zarr"}]}
        self.assertEqual(compute_clean_orphans(prior, []), {"a.zarr"})

    def test_derivatives_sourcedata_code_stores_are_never_orphaned(self):
        # These stores predate the raw-only scope; a raw-only `convert` no
        # longer contains their primaries, but that must NOT be read as "gone
        # from HEAD" -- this change must not delete any already-published
        # store (nemarOrg/nemar-cli#1095 / #1097).
        prior = {"stores": [
            {"zarr": "derivatives/preprocessed/sub-01_task-x-epo.zarr"},
            {"zarr": "sourcedata/sub-02/sub-02_task-x_eeg.zarr"},
            {"zarr": "code/analysis/helper.zarr"},
            {"zarr": "sub-01/eeg/sub-01_task-rest_eeg.zarr"},
        ]}
        convert = ["sub-01/eeg/sub-01_task-rest_eeg.set"]  # only the raw one rebuilds
        self.assertEqual(compute_clean_orphans(prior, convert), set())

    def test_genuinely_gone_raw_store_is_still_removed_alongside_excluded_ones(self):
        prior = {"stores": [
            {"zarr": "derivatives/preprocessed/sub-01_task-x-epo.zarr"},
            {"zarr": "sub-02/eeg/sub-02_task-gone_eeg.zarr"},
        ]}
        convert: list[str] = []
        self.assertEqual(
            compute_clean_orphans(prior, convert),
            {"sub-02/eeg/sub-02_task-gone_eeg.zarr"},
        )

    def test_on005520_pattern_drops_from_index_without_deleting_stores(self):
        """A dataset whose ONLY prior stores are derivatives-tree ones (all
        raw recordings currently fail for an unrelated reason) legitimately
        reports store_count 0 in the next --clean index -- but the 92
        already-published derivatives stores are never scheduled for
        removal. Mirrors the documented on005520 case end-to-end at the
        pure-function level: worklist -> orphan selection -> index rewrite.
        """
        head = [
            "derivatives/preprocessed/sub-01_task-rest_eeg.set",
            "sub-01/eeg/sub-01_task-rest_eeg.vhdr",  # the one raw recording; fails
        ]
        convert, remove_from_worklist = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-rest_eeg.vhdr"])
        self.assertEqual(remove_from_worklist, [])

        prior_index = {"stores": [
            {"zarr": "derivatives/preprocessed/sub-01_task-rest_eeg.zarr"},
        ]}
        orphans = compute_clean_orphans(prior_index, convert)
        # The derivatives store is NOT an orphan: it must not be deleted.
        self.assertEqual(orphans, set())

        # The raw recording fails (unrelated reason) -> nothing converts, and
        # --clean rewrites the index fresh (prior=None), so the derivatives
        # store -- never touched -- simply has no entry in the new index.
        index = merge_index(
            None, "on005520", SHA_NEW, [], sorted(orphans),
            "2026-08-20T00:00:00Z",
            [{"path": head[1], "zarr": "sub-01/eeg/sub-01_task-rest_eeg.zarr",
              "code": "corrupt_or_truncated", "reason": "..."}],
        )
        self.assertEqual(index["store_count"], 0)  # 92 -> 0 in this dataset's index
        self.assertEqual(index["failure_count"], 1)  # the raw failure IS reported


class TestRmRecursiveSharding(unittest.TestCase):
    """`_rm_recursive` shards a big delete across child prefixes. A single
    `aws s3 rm --recursive` measured 13.8k objects/min on Hallu, which made a
    large wipe a ~45 min near-idle block."""

    def setUp(self):
        self.calls: list[list[str]] = []

    def _patch(self, children: list[str]):
        import generate_zarr as gz

        self._orig_aws, self._orig_children = gz._aws, gz._s3_child_prefixes
        gz._s3_child_prefixes = lambda url: children
        gz._aws = lambda cmd, **kw: self.calls.append(cmd)
        self.addCleanup(setattr, gz, "_aws", self._orig_aws)
        self.addCleanup(setattr, gz, "_s3_child_prefixes", self._orig_children)
        return gz

    def test_shards_across_child_prefixes_then_sweeps(self):
        gz = self._patch(["s3://b/d/zarr/sub-01/", "s3://b/d/zarr/sub-02/"])
        gz._rm_recursive("s3://b/d/zarr/")
        targets = [c[3] for c in self.calls]
        self.assertIn("s3://b/d/zarr/sub-01/", targets)
        self.assertIn("s3://b/d/zarr/sub-02/", targets)
        # ...and a final unsharded sweep, so keys sitting directly under the
        # prefix (which no child covers) are still deleted.
        self.assertEqual(targets[-1], "s3://b/d/zarr/")

    def test_falls_back_to_one_rm_when_there_are_no_children(self):
        gz = self._patch([])
        gz._rm_recursive("s3://b/d/zarr/")
        self.assertEqual([c[3] for c in self.calls], ["s3://b/d/zarr/"])

    def test_a_failing_shard_is_not_reported_as_a_clean_wipe(self):
        import generate_zarr as gz

        orig_aws, orig_children = gz._aws, gz._s3_child_prefixes
        gz._s3_child_prefixes = lambda url: ["s3://b/d/zarr/sub-01/"]

        def boom(cmd, **kw):
            raise RuntimeError("delete failed")

        gz._aws = boom
        self.addCleanup(setattr, gz, "_aws", orig_aws)
        self.addCleanup(setattr, gz, "_s3_child_prefixes", orig_children)
        with self.assertRaises(RuntimeError):
            gz._rm_recursive("s3://b/d/zarr/")



# --- #1110: worker memory backstop + pool-break recovery ----------------------

def _crashing_worker(primary, peak_bytes=None):
    """Fault-injection worker body. Module-level so it survives pickling to a
    spawned child. A recording whose path contains `boom` kills its own process
    the way the kernel OOM reaper does, which is what poisons a
    ProcessPoolExecutor; everything else converts normally.

    The sleeps make the crossfire DETERMINISTIC rather than hoped-for. The
    culprit dies while its siblings are provably still running, so a pool break
    always catches innocent recordings in flight -- which is the scenario the
    serial-isolation design exists for. Without them the timing is the
    scheduler's to decide: on macOS (spawn, slow worker startup) the crossfire
    happened readily, while on Linux (fork) the culprit died before any sibling
    was in flight, so the guarded path was never exercised on the platform
    production actually runs.
    """
    if "boom" in primary:
        time.sleep(0.15)
        os._exit(1)
    time.sleep(0.45)
    return {"ok": True, "primary": primary, "entry": {"zarr": primary + ".zarr"}}


def _timed_worker(primary, peak_bytes=None):
    """Fault-free worker that takes long enough for admission to matter, and
    says when it ran. Module-level so it pickles."""
    started = time.monotonic()
    time.sleep(0.8)
    return {
        "ok": True,
        "primary": primary,
        "entry": {"zarr": primary + ".zarr"},
        "span": (started, time.monotonic()),
    }


def _track_listing_worker(track_dir, reserve=None):
    """Reports what `_tracked_call` left in its track directory while this ran."""
    files = sorted(os.listdir(track_dir))
    with open(os.path.join(track_dir, files[0])) as fh:
        return {"files": files, "record": json.load(fh)}


def _track_failing_worker(track_dir, reserve=None):
    raise RuntimeError("the conversion failed")


def _budget_worker(primary, peak_bytes=None):
    """Fault-injection worker for the in-run memory retry (#1483). Module-level so
    it pickles. A recording whose path carries ``need-<MiB>`` needs that much
    reserve: dispatched with less, it returns what ``convert_one`` returns for a
    memory failure (the real ``memory_failure_result``); with enough, it
    converts. A converted result also carries the reserve and the worker
    context's ``mem_budget`` it ran under, and when it ran, so a test can tell
    which pass produced it and whether two runs overlapped."""
    started = time.monotonic()
    marker = next((part for part in primary.split("_") if part.startswith("need-")), None)
    need = int(marker.split("-")[1]) * 1024**2 if marker else 0
    time.sleep(0.1)
    reserve = peak_bytes or 0
    if need > reserve:
        return memory_failure_result(
            primary, MemoryError(f"needed {need >> 20} MiB, had {reserve >> 20} MiB")
        )
    return {
        "ok": True,
        "primary": primary,
        "entry": {"zarr": primary + ".zarr"},
        "reserve": peak_bytes,
        "mem_budget": generate_zarr._CTX.get("mem_budget"),
        "span": (started, time.monotonic()),
    }


class TestMemoryFailureClassification(unittest.TestCase):
    """#1110: a runtime OOM must be explainable to the viewer but still retryable."""

    def test_the_production_mapping_is_used(self):
        # Asserts the SAME helper convert_one calls, so deleting or weakening the
        # handler cannot leave this passing.
        r = memory_failure_result("sub-01/eeg/x.set", MemoryError("nope"))
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], RecordingMemoryExceeded.code)
        self.assertIn("memory budget", r["error"])

    def test_it_is_distinct_from_the_static_preflight_verdict(self):
        # RecordingTooLarge is a judgment on the recording alone, made before any
        # execution; a runtime OOM depends on what else was running. Conflating
        # them is what let a busy hour bury a dataset permanently.
        self.assertNotEqual(RecordingMemoryExceeded.code, RecordingTooLarge.code)

    def test_it_has_a_user_facing_reason(self):
        reason = reason_for_code(RecordingMemoryExceeded.code)
        self.assertTrue(reason)
        self.assertNotIn("recording_memory_exceeded", reason)  # not the raw code

    def test_a_run_of_only_oom_failures_stays_retryable(self):
        # The whole point. hallu-zarr.sh marks a dataset TERMINAL when every
        # failure is deterministic; an all-OOM run must not qualify.
        failures = ["a", "b"]
        entries = [
            {"path": "a", "code": RecordingMemoryExceeded.code},
            {"path": "b", "code": RecordingMemoryExceeded.code},
        ]
        self.assertEqual(count_infra_failures(failures, entries), 2)

    def test_real_data_failures_remain_deterministic(self):
        failures = ["a", "b"]
        entries = [
            {"path": "a", "code": "not_continuous"},
            {"path": "b", "code": "corrupt_or_truncated"},
        ]
        self.assertEqual(count_infra_failures(failures, entries), 0)

    def test_a_mixed_run_is_infra(self):
        failures = ["a", "b", "c"]
        entries = [{"path": "a", "code": "not_continuous"}]  # b uncoded, c OOM
        entries.append({"path": "c", "code": RecordingMemoryExceeded.code})
        self.assertEqual(count_infra_failures(failures, entries), 2)

    # NOT COVERED, deliberately: driving a real MemoryError through the whole of
    # `convert_one` with a synthetic context is not achievable deterministically.
    # Whichever allocation happens to fail first decides the exception type -- a
    # tight RLIMIT makes numpy's own import fail (ImportError), a loose one lets
    # the #909 preflight fire first (RecordingTooLarge), and neither exercises the
    # runtime handler. Both were tried on the real Linux conversion node.
    #
    # What that leaves untested is one line: `except MemoryError` calling
    # `memory_failure_result`. Everything it constructs is asserted above against
    # the SAME production helper, so the mapping itself cannot silently rot -- but
    # a change that deleted the handler, or folded it into the generic
    # `except Exception` below it, would not be caught here. Reaching it honestly
    # needs a real oversized recording, i.e. an integration test on the node.

class TestMemoryErrorBeforePeakResetIsTyped(unittest.TestCase):
    """A MemoryError raised BEFORE `rss_trusted` is assigned must still produce a
    typed memory failure.

    `apply_worker_mem_limit` tightens RLIMIT_DATA at the top of `convert_one`'s
    try, and `rss_trusted = reset_peak_rss()` comes after it. On a reused worker
    still holding the previous recording's memory, the next allocation -- inside
    reset_peak_rss's own `open()`, which catches only OSError -- can raise
    MemoryError while the name does not yet exist. The handler reads
    `rss_trusted`, so this raised UnboundLocalError and escaped `convert_one`
    uncoded, retrying forever. That is the precise failure the limit call sits
    inside the try to prevent (#1110).
    """

    def setUp(self):
        # convert_one calls apply_worker_mem_limit for real before it reaches the
        # injected reset, so on Linux these tests genuinely narrow this PROCESS's
        # RLIMIT_DATA and never put it back. That leaks: this class sorts before
        # TestWorkerMemLimit, whose setUp would then capture the already-narrowed
        # value as its "pristine" baseline and restore the wrong limit -- silently
        # defeating the isolation that class exists to provide. Same save/restore
        # it uses, for the same reason.
        try:
            import resource

            saved = resource.getrlimit(resource.RLIMIT_DATA)
            self.addCleanup(resource.setrlimit, resource.RLIMIT_DATA, saved)
        except Exception:  # noqa: BLE001 - no usable RLIMIT_DATA (macOS/Windows)
            pass

    def _inject(self, exc: BaseException):
        import generate_zarr as gz

        def boom() -> bool:
            raise exc

        self._orig_reset, self._orig_ctx = gz.reset_peak_rss, gz._CTX
        gz.reset_peak_rss = boom
        gz._CTX = {"mem_budget": None}
        self.addCleanup(setattr, gz, "reset_peak_rss", self._orig_reset)
        self.addCleanup(setattr, gz, "_CTX", self._orig_ctx)
        return gz

    def test_memory_error_before_reset_returns_typed_failure(self):
        gz = self._inject(MemoryError("cannot allocate"))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        # #1483: the stack is logged, not just the first line kept in the result.
        self.assertIn("exceeded its memory budget", out.getvalue())
        self.assertIn("Traceback", out.getvalue())
        self.assertFalse(res["ok"])
        # The whole point: coded, so the queue can mark it terminal instead of
        # burning five attempts on a recording that will never fit.
        self.assertEqual(res["code"], gz.RecordingMemoryExceeded.code)
        self.assertEqual(res["primary"], "sub-01/eeg/sub-01_task-x_eeg.set")
        # Unmeasurable, not zero: the reset never completed, so any reading would
        # be the worker's lifetime peak rather than this recording's.
        self.assertIsNone(res["peak_rss"])

    def test_thread_exhaustion_at_the_limit_is_typed_as_memory(self):
        # zarr's codec pipeline dies with this exact RuntimeError when a thread
        # stack cannot be mapped at the RLIMIT_DATA limit (on004696, 2026-09-03).
        # Uncoded it broke the pool; typed it is the same verdict as MemoryError.
        gz = self._inject(RuntimeError("can't start new thread"))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], gz.RecordingMemoryExceeded.code)
        self.assertIn("can't start new thread", out.getvalue())

    def test_enomem_at_the_limit_is_typed_as_memory(self):
        gz = self._inject(OSError(errno.ENOMEM, "Cannot allocate memory"))
        res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertEqual(res["code"], gz.RecordingMemoryExceeded.code)
        # Any other OSError stays what it is: a read error, not a memory verdict.
        gz = self._inject(OSError(errno.EIO, "I/O error"))
        res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertNotEqual(res.get("code"), gz.RecordingMemoryExceeded.code)

    def test_non_memory_error_before_reset_is_still_uncoded_infra(self):
        # The generic handler never touched rss_trusted, so it was already fine;
        # assert it stays that way rather than being swept into the typed branch.
        gz = self._inject(RuntimeError("something else"))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertFalse(res["ok"])
        self.assertIsNone(res["code"])
        self.assertNotIn("exceeded its memory budget", out.getvalue())


class TestMaxShieldWiringInConvertOne(unittest.TestCase):
    """ADR 0028's decision, as `convert_one` actually wires it (#1126).

    The pieces were covered in isolation -- `maxshield_calibration_for`'s
    resolution, and that `maxshield_uncalibrated` is classified deterministic --
    but nothing exercised the code that CONNECTS them. A regression that let any
    of these branches fall through would serve raw Internal Active Shielding
    data, which is the one outcome ADR 0028 exists to prevent, and every
    isolated test would still have passed.

    `is_maxshield_fif` is substituted here, and only it. Real detection needs
    both MNE (absent from the pure-python CI job) and a genuine IAS recording,
    and it is an environmental PROBE, not the decision under test: what runs for
    real below is the pair resolution, all three decline branches, and the
    verdict `convert_one` returns. Same injection the module already uses for
    `reset_peak_rss` in TestMemoryErrorBeforePeakReset.
    """

    REC = "sub-01/meg/sub-01_task-rest_meg.fif"
    CAL = "sub-01/meg/sub-01_acq-calibration_meg.dat"
    CTC = "sub-01/meg/sub-01_acq-crosstalk_meg.fif"

    def setUp(self):
        import generate_zarr as gz

        self.gz = gz
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        os.makedirs(os.path.join(self.repo, "sub-01", "meg"), exist_ok=True)
        self._write(self.REC)

        try:
            import resource

            saved = resource.getrlimit(resource.RLIMIT_DATA)
            self.addCleanup(resource.setrlimit, resource.RLIMIT_DATA, saved)
        except Exception:  # noqa: BLE001 - no usable RLIMIT_DATA (macOS/Windows)
            pass

        self._orig_probe, self._orig_ctx = gz.is_maxshield_fif, gz._CTX
        self.addCleanup(setattr, gz, "is_maxshield_fif", self._orig_probe)
        self.addCleanup(setattr, gz, "_CTX", self._orig_ctx)

    def _write(self, rel: str) -> None:
        path = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(b"\0")

    def _run(self, head_files, *, shielded=True):
        self.gz.is_maxshield_fif = lambda _p: shielded
        self.gz._CTX = {
            "mem_budget": None,
            "tmp": self._tmp.name,
            "local": True,
            "repo": self.repo,
            "head_files": set(head_files),
            "bucket": "b",
            "dataset_id": "on000001",
            "head": "0" * 40,
        }
        return self.gz.convert_one(self.REC, 4 * 1024**3)

    def test_no_calibration_pair_declines_with_the_typed_code(self):
        res = self._run([self.REC])
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], self.gz.MaxShieldUncalibrated.code)
        # Assert the REASON, not just the code. Every decline branch here raises
        # the same code, so a code-only assertion still passes when this branch
        # falls through and a later one happens to catch the mess -- which is
        # exactly what a fallthrough regression looks like.
        self.assertIn("no fine-calibration", res["error"])

    def test_calibration_alone_is_not_enough(self):
        # ADR 0028 rejects uncalibrated SSS: half a pair must decline, not filter.
        self._write(self.CAL)
        res = self._run([self.REC, self.CAL])
        self.assertEqual(res["code"], self.gz.MaxShieldUncalibrated.code)
        self.assertIn("no fine-calibration", res["error"])

    def test_cross_talk_alone_is_not_enough(self):
        self._write(self.CTC)
        res = self._run([self.REC, self.CTC])
        self.assertEqual(res["code"], self.gz.MaxShieldUncalibrated.code)
        self.assertIn("no fine-calibration", res["error"])

    def test_tracked_pair_without_local_content_declines(self):
        # A git-annex pointer whose content was never fetched. Left uncoded this
        # became an infra failure that re-ran the filter on every future pass.
        res = self._run([self.REC, self.CAL, self.CTC])  # in head_files, not on disk
        self.assertEqual(res["code"], self.gz.MaxShieldUncalibrated.code)
        self.assertIn("git annex get", res["error"])

    def test_a_resolvable_pair_gets_past_the_gate(self):
        # The other direction: with both inputs really present, the decline must
        # NOT fire -- otherwise the 365 recoverable recordings ADR 0028 counted
        # would all be declined and the filtering would never run at all.
        self._write(self.CAL)
        self._write(self.CTC)
        res = self._run([self.REC, self.CAL, self.CTC])
        self.assertNotEqual(res.get("code"), self.gz.MaxShieldUncalibrated.code)

    def test_a_recording_that_is_not_shielded_never_declines(self):
        # The gate is conditioned on detection: an ordinary FIF in a dataset that
        # ships no calibration pair must convert normally, not be declined.
        res = self._run([self.REC], shielded=False)
        self.assertNotEqual(res.get("code"), self.gz.MaxShieldUncalibrated.code)

    def test_probe_failure_is_classified_with_the_typed_code_and_detail(self):
        # #1139: when the probe itself cannot read the file, convert_one must
        # not fall through to a generic/uncoded file_read_error -- the raised
        # MaxShieldProbeFailed is classified exactly like any other typed
        # failure (`.code` picked up by the generic `except Exception`
        # handler), and `detail` carries the exception class plus the first
        # message line, the same construction every other coded failure uses.
        def boom(_path):
            raise self.gz.MaxShieldProbeFailed(
                "could not read the FIF header to test for Internal Active "
                "Shielding: OSError: [Errno 5] I/O error"
            )

        self.gz.is_maxshield_fif = boom
        self.gz._CTX = {
            "mem_budget": None,
            "tmp": self._tmp.name,
            "local": True,
            "repo": self.repo,
            "head_files": {self.REC},
            "bucket": "b",
            "dataset_id": "on000001",
            "head": "0" * 40,
        }
        res = self.gz.convert_one(self.REC, 4 * 1024**3)
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], self.gz.MaxShieldProbeFailed.code)
        self.assertIn("MaxShieldProbeFailed", res["detail"])
        self.assertIn("Internal Active Shielding", res["detail"])
        self.assertNotIn(res["code"], RETRYABLE_CODES)


class TestIsMaxShieldFif(unittest.TestCase):
    """The MaxShield probe's own edges (#1126)."""

    def test_a_non_fif_is_not_probed(self):
        # Short-circuits on extension, so it costs nothing on the EEG datasets
        # that make up most of the archive and never needs MNE.
        self.assertFalse(is_maxshield_fif("sub-01/eeg/sub-01_task-x_eeg.set"))

    def test_an_unreadable_fif_raises_the_typed_probe_failure(self):
        # #1139: before this, a header probe that failed routed the recording
        # down the normal path silently (a print, then `return False`), where
        # a genuinely shielded file surfaced as an opaque file_read_error with
        # no hint the probe was the thing that broke. It must instead raise a
        # coded exception -- convert_one classifies it exactly like any other
        # typed failure, via `.code` and `failure_detail`.
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "sub-01_task-x_meg.fif")
            with open(bad, "wb") as fh:
                fh.write(b"not a fif")
            with self.assertRaises(MaxShieldProbeFailed) as cm:
                is_maxshield_fif(bad)
        self.assertEqual(cm.exception.code, "maxshield_probe_failed")
        self.assertIn("Internal Active Shielding", str(cm.exception))
        # The original read failure is chained, not swallowed -- a traceback
        # still names the real cause.
        self.assertIsNotNone(cm.exception.__cause__)


class TestWorkerMemLimit(unittest.TestCase):
    """#1110: the per-recording RLIMIT_DATA backstop."""

    def setUp(self):
        # These mutate the real process limit; restore it so test order cannot
        # leave a later test running under a narrowed data segment.
        try:
            import resource

            self._saved = resource.getrlimit(resource.RLIMIT_DATA)
        except Exception:  # noqa: BLE001
            self._saved = None

    def tearDown(self):
        if self._saved is not None:
            import resource

            resource.setrlimit(resource.RLIMIT_DATA, self._saved)

    def test_none_peak_leaves_limit_alone(self):
        self.assertIsNone(worker_mem_limit_bytes(None, 100))
        self.assertIsNone(worker_mem_limit_bytes(0, 100))

    def test_small_recording_gets_the_floor_not_a_tiny_limit(self):
        # A 10 MB recording reserves little; capping its worker there would kill
        # it on interpreter + numpy/MNE startup, long before any signal.
        self.assertEqual(
            worker_mem_limit_bytes(10 * 1024**2, 999 * 1024**3), MEM_LIMIT_FLOOR_BYTES
        )

    def test_large_recording_scales_with_its_reservation(self):
        peak = 20 * 1024**3
        self.assertEqual(
            worker_mem_limit_bytes(peak, 999 * 1024**3), int(peak * MEM_LIMIT_SLACK)
        )

    def test_never_exceeds_the_node_ceiling(self):
        ceiling = 8 * 1024**3
        self.assertEqual(worker_mem_limit_bytes(20 * 1024**3, ceiling), ceiling)

    def test_admission_charges_what_the_worker_is_permitted(self):
        # The invariant that makes the backstop a real containment rather than a
        # per-process curiosity: if admission charged the bare projection while
        # each worker was allowed `projection * SLACK`, N concurrent workers
        # could be permitted N*SLACK times the ceiling and the kernel OOM reaper
        # would still win. Reserving what we permit bounds the aggregate.
        ceiling = 48 * 1024**3
        projection = 4 * 1024**3
        reserve = admission_reserve_bytes(projection, ceiling)
        admitted, running = 0, 0
        while running + reserve <= ceiling:
            running += reserve
            admitted += 1
        self.assertGreaterEqual(admitted, 1)
        self.assertLessEqual(admitted * reserve, ceiling)

    def test_setting_the_limit_never_raises(self):
        apply_worker_mem_limit(4 * 1024**3, 8 * 1024**3)
        apply_worker_mem_limit(None, None)

    def test_the_limit_sits_on_top_of_the_data_segment_the_worker_already_holds(self):
        """The reservation is headroom for the recording, not an absolute cap.

        On the conversion node numpy+scipy reserve 2.6 GiB of RLIMIT_DATA at
        import (OpenBLAS buffer pools) against 100 MB of RSS, so an absolute
        4 GiB floor left ~1.3 GiB and a 4 MB EMG recording failed a 624 KiB
        allocation as "exceeded its memory budget" (2026-09-03). Linux only:
        that is the only platform the backstop is applied on.
        """
        if not sys.platform.startswith("linux"):
            self.skipTest("RLIMIT_DATA backstop is Linux-only")
        import resource

        reserve = 4 * 1024**3
        before = data_segment_bytes()
        self.assertIsNotNone(before)
        apply_worker_mem_limit(reserve, 64 * 1024**3, reserved=True)
        after = data_segment_bytes()
        soft = resource.getrlimit(resource.RLIMIT_DATA)[0]
        # The baseline is read inside the call, between our two readings.
        self.assertGreaterEqual(soft, before + reserve)
        self.assertLessEqual(soft, after + reserve + 64 * 1024**2)

    def test_the_ceiling_caps_the_reserve_not_the_sum_with_the_baseline(self):
        """A recording admitted AT the ceiling must still get the whole ceiling
        for its own allocations. Clamping the sum would leave it `baseline`
        short of what admission charged -- the original bug at smaller scale."""
        if not sys.platform.startswith("linux"):
            self.skipTest("RLIMIT_DATA backstop is Linux-only")
        import resource

        ceiling = 2 * 1024**3
        before = data_segment_bytes()
        apply_worker_mem_limit(8 * 1024**3, ceiling, reserved=True)
        after = data_segment_bytes()
        soft = resource.getrlimit(resource.RLIMIT_DATA)[0]
        self.assertGreaterEqual(soft, before + ceiling)
        self.assertLessEqual(soft, after + ceiling + 64 * 1024**2)

    def test_data_segment_is_measured_where_the_backstop_applies(self):
        value = data_segment_bytes()
        if sys.platform.startswith("linux"):
            self.assertIsInstance(value, int)
            self.assertGreater(value, 0)
        else:
            self.assertIsNone(value)


class TestBlasThreadCaps(unittest.TestCase):
    """Per-recording BLAS threading oversubscribes the node and, on the
    conversion node, costs each worker ~2.4 GiB of RLIMIT_DATA headroom in
    pre-mapped OpenBLAS buffer pools (see the note above BLAS_THREAD_VARS)."""

    def test_every_pool_is_pinned_to_one_thread_when_unset(self):
        env: dict[str, str] = {}
        effective = cap_blas_threads(env)
        self.assertEqual(effective, {var: "1" for var in BLAS_THREAD_VARS})
        self.assertEqual(env, effective)

    def test_an_operator_value_is_respected(self):
        env = {"OPENBLAS_NUM_THREADS": "4"}
        effective = cap_blas_threads(env)
        self.assertEqual(effective["OPENBLAS_NUM_THREADS"], "4")
        for var in BLAS_THREAD_VARS:
            if var != "OPENBLAS_NUM_THREADS":
                self.assertEqual(effective[var], "1")

    def test_importing_the_converter_pins_this_process(self):
        # The module-level call is what protects the driver and, by inheritance,
        # every pool worker; an operator override in the environment survives.
        for var in BLAS_THREAD_VARS:
            self.assertIn(var, os.environ)


class TestPoolBreakRecovery(unittest.TestCase):
    """#1110: a killed worker must cost one recording, not the whole queue."""

    def _run(self, primaries, cpu_cap=2):
        peaks = {p: 1024 for p in primaries}
        results = []
        breaks, max_suspects = _drain_with_admission(
            list(primaries), peaks, cpu_cap, 10**9, {},
            lambda r, i: results.append(r), worker=_crashing_worker,
        )
        return results, breaks, max_suspects

    def test_a_dying_worker_does_not_abandon_the_queue(self):
        # Before #1110 this aborted the run: on004998 converted 74 of 115 and
        # lost the remaining 41 to one kill.
        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 9)]
        primaries.insert(2, "sub-boom/eeg/sub-boom_task-rest_eeg.set")
        results, breaks, _ = self._run(primaries)

        self.assertEqual(len(results), len(primaries), "every recording must be accounted for")
        ok = {r["primary"] for r in results if r["ok"]}
        self.assertEqual(ok, set(primaries) - {"sub-boom/eeg/sub-boom_task-rest_eeg.set"})
        self.assertGreaterEqual(breaks, 1)

    def test_the_culprit_is_named_after_running_alone(self):
        results, _, _ = self._run(["sub-boom/eeg/sub-boom_task-rest_eeg.set"], cpu_cap=1)
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0]["ok"])
        self.assertIn("killed its worker process", results[0]["error"])
        # Uncoded => infra => retried on a later run, rather than recorded as a
        # permanent property of the data.
        self.assertIsNone(results[0].get("code"))

    def test_innocent_siblings_are_never_blamed(self):
        # The reason recovery re-runs suspects SERIALLY. Retrying them in
        # parallel lets the culprit break the pool again, and a sibling in flight
        # for both breaks gets blamed for a crash it did not cause -- which is
        # exactly what an earlier parallel-retry implementation did.
        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 13)]
        primaries.insert(1, "sub-boom/eeg/sub-boom_task-rest_eeg.set")
        boom = "sub-boom/eeg/sub-boom_task-rest_eeg.set"
        saw_crossfire = False
        for _ in range(5):  # the race is timing-dependent; repeat it
            results, _breaks, max_suspects = self._run(primaries, cpu_cap=4)
            failed = {r["primary"] for r in results if not r["ok"]}
            self.assertEqual(
                failed, {boom}, "only the recording that dies alone may be reported failed"
            )
            self.assertEqual(len(results), len(primaries))
            # More than one suspect set aside at once means an INNOCENT recording
            # was in flight when the pool died -- the actual guarded path.
            # `pool_breaks` cannot express this: with one faulty recording it is
            # pinned at 2 (parallel pass, then the serial confirmation that always
            # breaks too) whether or not a sibling was ever caught, which made the
            # previous version of this assertion pass vacuously.
            if max_suspects > 1:
                saw_crossfire = True
        self.assertTrue(
            saw_crossfire,
            "never observed a sibling caught in the crossfire; the guarded path went untested",
        )

    def test_a_clean_run_is_unaffected(self):
        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 6)]
        results, breaks, _ = self._run(primaries)
        self.assertEqual(len(results), 5)
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(breaks, 0)


def _scratch_worker(primary, peak_bytes=None):
    """Fault-injection worker that leaves the same footprint `convert_one` does:
    a raw copy under `work/` and a memmap under the recording's `.scratch`
    sibling. A recording whose path contains `boom` is SIGKILLed by its own
    process, WITHOUT running any cleanup, which is the case `convert_one`'s
    `finally` cannot cover (a SIGBUS from a full volume kills the same way).
    Module-level so it pickles.

    `leftover` reports whether this recording's scratch already existed when it
    started: true means a previous attempt's debris was never reclaimed."""
    started = time.monotonic()
    tmp = generate_zarr._CTX["tmp"]
    paths = generate_zarr.recording_scratch_paths(tmp, primary)
    leftover = any(os.path.exists(p) for p in paths)
    for path in (paths[0], paths[2]):
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "blob"), "wb") as fh:
            fh.write(b"x" * (1024 * 1024))
    if "boom" in primary:
        time.sleep(0.15)
        os.kill(os.getpid(), signal.SIGKILL)
    time.sleep(0.45)
    for path in paths:
        shutil.rmtree(path, ignore_errors=True)
    return {
        "ok": True, "primary": primary, "entry": {"zarr": primary + ".zarr"},
        "leftover": leftover, "span": (started, time.monotonic()),
    }


def _orphaning_worker(primary, peak_bytes=None):
    """Like `_scratch_worker`'s `boom`, but the dying worker first starts a child
    that names a path under its scratch and outlives it, as an `aws s3 cp` does
    when its worker is SIGKILLed. The child's pid is written under the run's temp
    root for the test to find."""
    tmp = generate_zarr._CTX["tmp"]
    work = generate_zarr.recording_scratch_paths(tmp, primary)[0]
    os.makedirs(work, exist_ok=True)
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)", os.path.join(work, "part")],
        start_new_session=True,
    )
    with open(os.path.join(tmp, "orphan.pid"), "w") as fh:
        fh.write(str(child.pid))
    time.sleep(0.15)
    os.kill(os.getpid(), signal.SIGKILL)


class TestRecordingScratchPaths(unittest.TestCase):
    def test_every_path_is_keyed_to_one_recording(self):
        a = "sub-01/ses-1/eeg/sub-01_ses-1_task-a_eeg.vhdr"
        b = "sub-01/ses-1/eeg/sub-01_ses-1_task-b_eeg.vhdr"
        pa = generate_zarr.recording_scratch_paths("/t", a)
        pb = generate_zarr.recording_scratch_paths("/t", b)
        self.assertEqual(len(set(pa) | set(pb)), 6, "two recordings never share a path")
        work, store, memmap = pa
        self.assertEqual(store, "/t/stores/sub-01/ses-1/eeg/sub-01_ses-1_task-a_eeg.zarr")
        self.assertEqual(memmap, store + generate_zarr.SCRATCH_DIR_SUFFIX)
        self.assertTrue(work.startswith("/t/work/"))

    def test_the_memmap_directory_is_a_sibling_of_the_store_not_inside_it(self):
        # `aws s3 sync <store>` uploads the store directory, so a memmap inside it
        # would be published; a sibling is not.
        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(tmp, "stores", "sub-01", "eeg", "sub-01_task-a_eeg.zarr")
            os.makedirs(os.path.dirname(store))
            scratch = generate_zarr._memmap_scratch_dir(store)
            self.assertTrue(os.path.isdir(scratch))
            self.assertEqual(os.path.dirname(scratch), os.path.dirname(store))
            self.assertFalse(scratch.startswith(store + os.sep))


class TestAllocatedBytes(unittest.TestCase):
    def test_a_sparse_file_is_charged_for_blocks_not_for_its_length(self):
        # A streaming memmap is created at its full length and filled as the
        # windows arrive; st_size would charge it all up front.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "memmap.f32")
            with open(path, "wb") as fh:
                fh.truncate(8 * 1024**3)
                fh.seek(0)
                fh.write(b"x" * 4096)
            if os.stat(path).st_blocks * 512 >= 1024**3:
                self.skipTest("this filesystem does not support sparse files")
            self.assertLess(generate_zarr.allocated_bytes(tmp), 64 * 1024**2)

    def test_it_counts_nested_files_and_ignores_a_missing_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            nested = os.path.join(tmp, "a", "b")
            os.makedirs(nested)
            with open(os.path.join(nested, "data"), "wb") as fh:
                fh.write(os.urandom(1024 * 1024))
            self.assertGreaterEqual(generate_zarr.allocated_bytes(tmp), 1024 * 1024)
            self.assertEqual(generate_zarr.allocated_bytes(os.path.join(tmp, "absent")), 0)


class TestReclaimRecordingScratch(unittest.TestCase):
    def test_removes_all_three_directories_and_reports_what_it_freed(self):
        primary = "sub-01/eeg/sub-01_task-a_eeg.vhdr"
        with tempfile.TemporaryDirectory() as tmp:
            paths = generate_zarr.recording_scratch_paths(tmp, primary)
            for path in paths:
                os.makedirs(path)
                with open(os.path.join(path, "blob"), "wb") as fh:
                    fh.write(os.urandom(1024 * 1024))
            result = generate_zarr.reclaim_recording_scratch(tmp, primary)
            self.assertGreaterEqual(result.freed, 3 * 1024 * 1024)
            self.assertEqual((result.leaked, result.errors), (0, []))
            for path in paths:
                self.assertFalse(os.path.exists(path), path)

    def test_leaves_another_recordings_scratch_alone(self):
        keep = "sub-01/eeg/sub-01_task-a_eeg.vhdr"
        drop = "sub-01/eeg/sub-01_task-b_eeg.vhdr"
        with tempfile.TemporaryDirectory() as tmp:
            for primary in (keep, drop):
                for path in generate_zarr.recording_scratch_paths(tmp, primary):
                    os.makedirs(path)
            generate_zarr.reclaim_recording_scratch(tmp, drop)
            for path in generate_zarr.recording_scratch_paths(tmp, keep):
                self.assertTrue(os.path.isdir(path), path)

    def test_a_recording_with_nothing_on_scratch_frees_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = generate_zarr.reclaim_recording_scratch(tmp, "sub-01/eeg/x_eeg.vhdr")
            self.assertEqual(tuple(result), (0, 0, []))


class TestScratchPathsStayInsideTheRun(unittest.TestCase):
    def test_an_absolute_primary_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            generate_zarr.recording_scratch_paths("/run/tmp", "/etc/sub-01_eeg.vhdr")
        self.assertIn("outside", str(caught.exception))

    def test_a_primary_that_climbs_out_is_refused(self):
        for primary in ("../../x/sub-01_eeg.vhdr", "sub-01/../../../x_eeg.vhdr"):
            with self.subTest(primary=primary):
                with self.assertRaises(ValueError):
                    generate_zarr.recording_scratch_paths("/run/tmp", primary)

    def test_an_ordinary_bids_path_is_accepted(self):
        paths = generate_zarr.recording_scratch_paths(
            "/run/tmp", "sub-01/ses-1/ieeg/sub-01_ses-1_task-x_ieeg.vhdr"
        )
        self.assertTrue(all(p.startswith("/run/tmp/") for p in paths))

    def test_reclaim_refuses_to_touch_a_path_outside_the_run(self):
        with tempfile.TemporaryDirectory() as outer:
            run = os.path.join(outer, "run")
            os.makedirs(run)
            victim = os.path.join(outer, "keep_eeg.zarr")  # where an absolute primary lands
            os.makedirs(victim)
            with open(os.path.join(victim, "data"), "w") as fh:
                fh.write("precious")
            with contextlib.redirect_stdout(io.StringIO()) as out:
                result = generate_zarr.reclaim_recording_scratch(
                    run, os.path.join(outer, "keep_eeg.vhdr")
                )
            self.assertTrue(os.path.exists(os.path.join(victim, "data")))
        self.assertEqual((result.freed, result.leaked), (0, 0))
        self.assertIn("::error::not reclaiming scratch", out.getvalue())

    def test_a_symlink_inside_the_run_that_points_outside_is_refused(self):
        # A lexical check passes `<run>/stores/...`; a reclaim would then delete
        # through the link.
        with tempfile.TemporaryDirectory() as outer:
            run = os.path.join(outer, "run")
            elsewhere = os.path.join(outer, "elsewhere")
            os.makedirs(run)
            os.makedirs(elsewhere)
            os.symlink(elsewhere, os.path.join(run, "stores"))
            primary = "sub-01/eeg/sub-01_task-a_eeg.vhdr"
            with self.assertRaises(ValueError):
                generate_zarr.recording_scratch_paths(run, primary)
            victim = os.path.join(elsewhere, "sub-01", "eeg", "sub-01_task-a_eeg.zarr")
            os.makedirs(victim)
            with open(os.path.join(victim, "data"), "w") as fh:
                fh.write("precious")
            with contextlib.redirect_stdout(io.StringIO()):
                result = generate_zarr.reclaim_recording_scratch(run, primary)
            self.assertTrue(os.path.exists(os.path.join(victim, "data")))
        self.assertEqual((result.freed, result.leaked), (0, 0))

    def test_a_run_root_that_is_itself_reached_through_a_symlink_is_fine(self):
        with tempfile.TemporaryDirectory() as outer:
            real = os.path.join(outer, "real")
            link = os.path.join(outer, "link")
            os.makedirs(real)
            os.symlink(real, link)
            paths = generate_zarr.recording_scratch_paths(link, "sub-01/eeg/x_eeg.vhdr")
        self.assertTrue(all(p.startswith(link + os.sep) for p in paths))

    def test_held_bytes_skips_a_primary_that_cannot_be_ours(self):
        with tempfile.TemporaryDirectory() as run:
            self.assertEqual(generate_zarr.held_scratch_bytes(run, ["/etc/x_eeg.vhdr"]), 0)


class TestReclaimReportsWhatItCouldNotRemove(unittest.TestCase):
    PRIMARY = "sub-01/eeg/sub-01_task-a_eeg.vhdr"

    def setUp(self):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root ignores directory permissions, so a delete cannot fail")

    def _undeletable(self, root):
        work = generate_zarr.recording_scratch_paths(root, self.PRIMARY)[0]
        os.makedirs(work)
        with open(os.path.join(work, "blob"), "wb") as fh:
            fh.write(os.urandom(4 * 1024 * 1024))
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(work, 0o500)  # the files inside can no longer be unlinked
        self.addCleanup(self._restore, work)
        return work

    @staticmethod
    def _restore(path):
        with contextlib.suppress(OSError):
            os.chmod(path, 0o700)

    def test_remove_scratch_tree_names_what_it_could_not_delete(self):
        with tempfile.TemporaryDirectory() as root:
            work = self._undeletable(root)
            failures = generate_zarr.remove_scratch_tree(work)
            self.assertTrue(failures)
            self.assertTrue(all(work in f for f in failures), failures)
            self.assertTrue(os.path.exists(work))
            os.chmod(work, 0o700)

    def test_a_failed_delete_is_not_reported_as_freed(self):
        # `freed` used to be measured BEFORE an `ignore_errors` delete: this very
        # case reported 4 MiB freed while all 4 MiB stayed on disk.
        with tempfile.TemporaryDirectory() as root:
            self._undeletable(root)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                result = generate_zarr.reclaim_recording_scratch(root, self.PRIMARY)
            os.chmod(generate_zarr.recording_scratch_paths(root, self.PRIMARY)[0], 0o700)
        self.assertLess(result.freed, 1024 * 1024)
        self.assertGreaterEqual(result.leaked, 4 * 1024 * 1024)
        self.assertTrue(result.errors)
        self.assertIn("::error::could not remove scratch", out.getvalue())
        self.assertIn("is still on disk", out.getvalue())

    def test_convert_one_reports_a_scratch_directory_it_could_not_remove(self):
        # Through the real `convert_one`: the recording fails before any conversion
        # (its file is not in the repo), and the `finally` that follows has to say it
        # could not delete the directory a killed attempt left locked.
        with tempfile.TemporaryDirectory() as root:
            repo = os.path.join(root, "repo")
            os.makedirs(repo)
            run = os.path.join(root, "run")
            os.makedirs(run)
            work = self._undeletable(run)
            generate_zarr._init_worker({
                "repo": repo, "bucket": "nemar-test", "dataset_id": "on000117",
                "head": "b" * 40, "head_files": {self.PRIMARY}, "local": True,
                "tmp": run, "updated": "2026-10-07T00:00:00Z",
                "contract_base": "https://zarr.nemar.org", "engine_version": "3",
                "dataset_row": None, "provenance_fetch_failed": False,
                "mem_budget": None, "hard_ceiling": None, "projections": {},
            })
            with contextlib.redirect_stdout(io.StringIO()) as out:
                result = convert_one(self.PRIMARY)
            os.chmod(work, 0o700)
        self.assertFalse(result["ok"], "the recording has no file, so it cannot convert")
        self.assertRegex(out.getvalue(), r"::error::could not remove scratch .*" + re.escape(work))


class TestKillOrphansUnder(unittest.TestCase):
    def _sleeper(self, *args):
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(300)", *args],
            start_new_session=True,
        )

        def finish():
            if proc.poll() is None:
                proc.kill()
            proc.wait()

        self.addCleanup(finish)
        return proc

    def test_a_process_naming_a_path_under_the_run_root_is_killed(self):
        # The real scan of this platform: /proc/<pid>/cmdline on Linux, ps elsewhere.
        with tempfile.TemporaryDirectory() as root:
            orphan = self._sleeper(os.path.join(root, "work", "sub-01_x", "part"))
            bystander = self._sleeper("unrelated")
            lookalike = self._sleeper(root + "-sibling/work/x")
            time.sleep(0.3)  # let the interpreters start so their arguments are readable
            report = generate_zarr.kill_orphans_under(root)
            self.assertIn(orphan.pid, report.killed)
            self.assertEqual(orphan.wait(timeout=10), -signal.SIGKILL)
            self.assertIsNone(bystander.poll(), "an unrelated process must survive")
            self.assertIsNone(lookalike.poll(), "a sibling directory sharing a prefix must survive")
            self.assertNotIn(os.getpid(), report.killed)
            self.assertEqual(report.survivors, [])
            self.assertIsNone(report.error)
            self.assertGreater(report.scanned, 0)

    def test_nothing_to_kill_returns_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            report = generate_zarr.kill_orphans_under(root)
        self.assertEqual((report.killed, report.survivors), ([], []))

    def test_the_proc_reader_matches_exact_arguments_in_the_kernels_layout(self):
        # A fixture in /proc's own layout, naming REAL pids of processes whose real
        # command lines say nothing, so the match is the reader's and the kill lands
        # on nothing but the sleepers this test started.
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as proc:
            under = self._sleeper("a")
            sibling = self._sleeper("b")
            other = self._sleeper("c")

            def entry(pid, *args):
                os.makedirs(os.path.join(proc, str(pid)))
                with open(os.path.join(proc, str(pid), "cmdline"), "wb") as fh:
                    fh.write(b"\0".join(a.encode() for a in args) + b"\0")

            entry(under.pid, "aws", "s3", "cp", "s3://b/k", os.path.join(root, "work", "x", "part"))
            entry(sibling.pid, "aws", "s3", "cp", root + "-sibling/work/x")
            entry(other.pid, "aws", "s3", "ls")
            os.makedirs(os.path.join(proc, "not-a-pid"))
            report = generate_zarr.kill_orphans_under(root, proc_root=proc)
            self.assertEqual(report.killed, [under.pid])
            self.assertEqual(under.wait(timeout=10), -signal.SIGKILL)
            self.assertIsNone(sibling.poll())
            self.assertIsNone(other.poll())
            self.assertEqual(report.scanned, 3)

    def test_a_scan_that_cannot_run_says_so_instead_of_returning_nothing(self):
        report = generate_zarr.kill_orphans_under("/run/x", proc_root="/no/such/proc")
        self.assertEqual(report.killed, [])
        self.assertIn("cannot list", report.error)
        self.assertEqual(report.scanned, 0)

    def test_the_ps_fallback_sees_this_process_untruncated(self):
        if shutil.which("ps") is None:
            self.skipTest("no ps binary here")
        # A command line far wider than any terminal: truncated `args` is what hid a
        # live process from the first version of this scan on Ubuntu.
        wide = "x" * 400
        sleeper = self._sleeper(wide)
        time.sleep(0.3)
        table, error = generate_zarr._ps_process_table()
        self.assertIsNone(error)
        argv = dict(table).get(sleeper.pid)
        self.assertIsNotNone(argv)
        self.assertIn(wide, argv)

    def test_a_missing_ps_is_reported_not_swallowed(self):
        saved = os.environ["PATH"]
        self.addCleanup(os.environ.__setitem__, "PATH", saved)
        os.environ["PATH"] = "/nonexistent"
        table, error = generate_zarr._ps_process_table()
        self.assertEqual(table, [])
        self.assertIn("ps could not run", error)

    def test_a_killed_but_unreaped_process_counts_as_gone(self):
        proc = self._sleeper("z")
        time.sleep(0.2)
        os.kill(proc.pid, signal.SIGKILL)  # a zombie until the test waits on it
        self.assertEqual(generate_zarr._wait_until_gone([proc.pid], 5.0), [])

    def test_a_process_that_stays_is_a_survivor(self):
        self.assertEqual(generate_zarr._wait_until_gone([os.getpid()], 0.1), [os.getpid()])


class TestKillOrphansGuards(unittest.TestCase):
    """The scan's deadline, the re-read before each kill, the wait for killed
    processes and the survivors report, against real processes."""

    @staticmethod
    def _script(body):
        return ["-c", body]

    def _start(self, body, *args):
        proc = subprocess.Popen(
            [sys.executable, "-c", body, *args], start_new_session=True
        )

        def finish():
            if proc.poll() is None:
                proc.kill()
            proc.wait()

        self.addCleanup(finish)
        return proc

    def _fixture_proc(self, proc_dir, pid, *args):
        os.makedirs(os.path.join(proc_dir, str(pid)))
        with open(os.path.join(proc_dir, str(pid), "cmdline"), "wb") as fh:
            fh.write(b"\0".join(a.encode() for a in args) + b"\0")

    def test_a_pid_that_no_longer_matches_when_re_read_is_not_killed(self):
        # Between the scan and the kill a pid can be freed and reused by an unrelated
        # process. The fixture's command line is rewritten after the scan, as a
        # reused pid's would read, and the process must survive.
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as proc:
            victim = self._start("import time; time.sleep(300)", "innocent")
            cmdline = os.path.join(proc, str(victim.pid), "cmdline")
            self._fixture_proc(proc, victim.pid, "aws", "s3", "cp", os.path.join(root, "work", "x"))

            def pid_is_reused():
                with open(cmdline, "wb") as fh:
                    fh.write(b"someone-else\0--unrelated\0")

            report = generate_zarr.kill_orphans_under(
                root, proc_root=proc, _after_scan=pid_is_reused
            )
            self.assertEqual(report.killed, [])
            self.assertIsNone(victim.poll(), "an unrelated process was killed")

    def test_a_pid_that_vanishes_between_scan_and_kill_is_skipped(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as proc:
            victim = self._start("import time; time.sleep(300)", "x")
            self._fixture_proc(proc, victim.pid, "aws", os.path.join(root, "work", "x"))
            report = generate_zarr.kill_orphans_under(
                root, proc_root=proc,
                _after_scan=lambda: shutil.rmtree(os.path.join(proc, str(victim.pid))),
            )
            self.assertEqual(report.killed, [])
            self.assertIsNone(victim.poll())

    def test_a_scan_blocked_on_a_read_is_abandoned_at_the_deadline(self):
        # A FIFO where a cmdline file should be blocks the reader forever: a real
        # read that does not return. The run must not hang on it.
        if not hasattr(os, "mkfifo"):
            self.skipTest("no FIFOs here")
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as proc:
            os.makedirs(os.path.join(proc, "424242"))
            fifo = os.path.join(proc, "424242", "cmdline")
            os.mkfifo(fifo)

            def release():
                # Let the abandoned reader finish, so the test leaves no stuck thread.
                with open(fifo, "wb"):
                    pass

            started = time.monotonic()
            try:
                report = generate_zarr.kill_orphans_under(
                    root, proc_root=proc, scan_seconds=0.3
                )
            finally:
                release()
            self.assertLess(time.monotonic() - started, 5.0)
            self.assertIn("did not finish", report.error)
            self.assertEqual((report.killed, report.survivors, report.scanned), ([], [], 0))

    def test_a_process_that_outlives_the_signal_is_a_survivor(self):
        # SIGSTOP stands in for a process the kernel cannot reap (uninterruptible
        # sleep): the signal is delivered and the process is still there.
        with tempfile.TemporaryDirectory() as root:
            orphan = self._start(
                "import time; time.sleep(300)", os.path.join(root, "work", "x", "part")
            )
            time.sleep(0.3)
            report = generate_zarr.kill_orphans_under(
                root, wait_seconds=0.3,
                send_signal=lambda pid, _sig: os.kill(pid, signal.SIGSTOP),
            )
            self.assertEqual(report.killed, [orphan.pid])
            self.assertEqual(report.survivors, [orphan.pid])

    def test_the_pool_break_names_a_survivor_as_an_error(self):
        with (
            tempfile.TemporaryDirectory() as root,
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            orphan = self._start(
                "import time; time.sleep(300)", os.path.join(root, "work", "x", "part")
            )
            time.sleep(0.3)
            generate_zarr.reclaim_after_pool_break(
                root, [], wait_seconds=0.3,
                send_signal=lambda pid, _sig: os.kill(pid, signal.SIGSTOP),
            )
        log = out.getvalue()
        self.assertIn("::error::1 orphaned process(es) survived SIGKILL", log)
        self.assertIn(str(orphan.pid), log)
        self.assertIn("1 orphaned child process(es) killed", log)

    def test_it_waits_for_a_slow_dying_process_before_reporting(self):
        # SIGTERM with a handler that takes 0.6 s to exit: the report must not call
        # it a survivor if it is given time, and must if it is not.
        slow = (
            "import os, signal, time\n"
            "signal.signal(signal.SIGTERM, lambda *a: (time.sleep(0.6), os._exit(0)))\n"
            "time.sleep(300)"
        )
        with tempfile.TemporaryDirectory() as root:
            first = self._start(slow, os.path.join(root, "work", "a"))
            time.sleep(0.4)
            started = time.monotonic()
            patient = generate_zarr.kill_orphans_under(
                root, wait_seconds=10.0,
                send_signal=lambda pid, _sig: os.kill(pid, signal.SIGTERM),
            )
            waited = time.monotonic() - started
            self.assertEqual(patient.killed, [first.pid])
            self.assertEqual(patient.survivors, [])
            self.assertGreaterEqual(waited, 0.4, "returned before the process had gone")
            second = self._start(slow, os.path.join(root, "work", "b"))
            time.sleep(0.4)
            impatient = generate_zarr.kill_orphans_under(
                root, wait_seconds=0.1,
                send_signal=lambda pid, _sig: os.kill(pid, signal.SIGTERM),
            )
            self.assertEqual(impatient.survivors, [second.pid])


class TestPoolBreakReportsWhatItCouldNotVerify(unittest.TestCase):
    PRIMARY = "sub-01/eeg/sub-01_task-a_eeg.vhdr"

    def _leave(self, root, mib):
        work = generate_zarr.recording_scratch_paths(root, self.PRIMARY)[0]
        os.makedirs(work)
        with open(os.path.join(work, "blob"), "wb") as fh:
            fh.write(os.urandom(mib * 1024 * 1024))
            fh.flush()
            os.fsync(fh.fileno())

    @staticmethod
    def _volume(*readings):
        reads = iter(readings)
        return lambda: next(reads)

    def test_a_scan_that_cannot_run_is_a_warning_naming_the_reason(self):
        with (
            tempfile.TemporaryDirectory() as root,
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            generate_zarr.reclaim_after_pool_break(
                root, [self.PRIMARY], proc_root="/no/such/proc"
            )
        self.assertIn("could not look for orphaned child processes (cannot list", out.getvalue())

    def test_a_scan_that_read_nothing_is_a_warning(self):
        with (
            tempfile.TemporaryDirectory() as root,
            tempfile.TemporaryDirectory() as empty_proc,
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            generate_zarr.reclaim_after_pool_break(root, [self.PRIMARY], proc_root=empty_proc)
        self.assertIn("no process command line was readable", out.getvalue())

    def test_a_volume_that_gains_less_than_was_removed_says_a_process_may_hold_it(self):
        gib = 1024**3
        with (
            tempfile.TemporaryDirectory() as root,
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            self._leave(root, 8)
            generate_zarr.reclaim_after_pool_break(
                root, [self.PRIMARY],
                self._volume((100 * gib, 500 * gib), (100 * gib, 500 * gib)),
                suspect_after=1024 * 1024,
            )
        self.assertIn("scratch free rose by 0.0 GiB although", out.getvalue())
        self.assertIn("may still hold deleted files open", out.getvalue())

    def test_a_volume_that_gains_what_was_removed_is_not_suspected(self):
        gib = 1024**3
        with (
            tempfile.TemporaryDirectory() as root,
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            self._leave(root, 8)
            generate_zarr.reclaim_after_pool_break(
                root, [self.PRIMARY],
                self._volume((100 * gib, 500 * gib), (100 * gib + 8 * 1024 * 1024, 500 * gib)),
                suspect_after=1024 * 1024,
            )
        self.assertNotIn("may still hold deleted files open", out.getvalue())

    def test_the_removed_bytes_are_not_called_reclaimed(self):
        with (
            tempfile.TemporaryDirectory() as root,
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            generate_zarr.reclaim_after_pool_break(root, [self.PRIMARY], proc_root="/no/such/proc")
        self.assertIn("removed 0.0 GiB of files", out.getvalue())
        self.assertNotIn("reclaimed", out.getvalue())


class TestPoolBreakReclaimsScratch(unittest.TestCase):
    """A worker killed outright never runs `convert_one`'s `finally`. On nm000276
    two killed workers kept 535 GiB until the dataset run ended, and every
    recording behind them failed with ENOSPC: the break must give the disk back
    before the suspects re-run and the rebuilt pool drains the rest."""

    def test_a_killed_workers_scratch_is_gone_before_anything_re_runs(self):
        boom = "sub-boom/eeg/sub-boom_task-rest_eeg.vhdr"
        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.vhdr" for i in range(1, 7)]
        primaries.insert(2, boom)
        results = []
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()) as out:
            breaks, _ = _drain_with_admission(
                list(primaries), {p: 1024 for p in primaries}, 3, 10**9, {"tmp": tmp},
                lambda r, i: results.append(r), worker=_scratch_worker,
            )
            leaked = [
                path for p in primaries
                for path in generate_zarr.recording_scratch_paths(tmp, p)
                if os.path.exists(path)
            ]
        self.assertGreaterEqual(breaks, 1)
        self.assertEqual(leaked, [], "nothing may outlive the run's drain")
        self.assertEqual(len(results), len(primaries))
        innocents = [r for r in results if r["primary"] != boom]
        self.assertTrue(all(r["ok"] for r in innocents))
        self.assertFalse(
            any(r["leftover"] for r in innocents),
            "an innocent re-ran on top of the debris its killed attempt left behind",
        )
        self.assertIn("worker pool broke with", out.getvalue())

    def test_the_break_says_how_full_the_disk_was(self):
        # The "killed its worker process" verdict reads as out of memory; the line
        # printed at the break is what tells an operator the volume was the cause.
        boom = "sub-boom/eeg/sub-boom_task-rest_eeg.vhdr"
        results = []
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()) as out:
            _drain_with_admission(
                [boom], {boom: 1024}, 1, 10**9, {"tmp": tmp},
                lambda r, i: results.append(r), worker=_scratch_worker,
            )
        log = out.getvalue()
        self.assertIn("scratch free", log)
        self.assertIn("SIGBUS", log)
        self.assertIn("orphaned child process(es) killed", log)
        self.assertIn("a full scratch disk", results[0]["error"], "the verdict now names the disk")

    def test_a_killed_workers_orphaned_child_is_killed_with_it(self):
        boom = "sub-boom/eeg/sub-boom_task-rest_eeg.vhdr"
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            _drain_with_admission(
                [boom], {boom: 1024}, 1, 10**9, {"tmp": tmp},
                lambda r, i: None, worker=_orphaning_worker,
            )
            with open(os.path.join(tmp, "orphan.pid")) as fh:
                pid = int(fh.read())
            deadline = time.monotonic() + 10
            alive = True
            while alive and time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                    time.sleep(0.05)
                except ProcessLookupError:
                    alive = False
            if alive:
                os.kill(pid, signal.SIGKILL)
        self.assertFalse(alive, "the child of a killed worker outlived the pool break")

    def test_a_clean_run_reclaims_nothing_and_says_nothing(self):
        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.vhdr" for i in range(1, 4)]
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()) as out:
            breaks, _ = _drain_with_admission(
                list(primaries), {p: 1024 for p in primaries}, 2, 10**9, {"tmp": tmp},
                lambda r, i: None, worker=_scratch_worker,
            )
        self.assertEqual(breaks, 0)
        self.assertNotIn("worker pool broke with", out.getvalue())


class TestScratchSettings(unittest.TestCase):
    """The scratch tunables are validated when the module loads: a value that
    cannot mean what the operator meant stops the run, naming the variable."""

    NAME = "ZARR_SCRATCH_TEST_SETTING"

    def setting(self, raw, default=3.0, minimum=1.0):
        saved = os.environ.get(self.NAME)
        self.addCleanup(
            lambda: os.environ.pop(self.NAME, None)
            if saved is None else os.environ.__setitem__(self.NAME, saved)
        )
        if raw is None:
            os.environ.pop(self.NAME, None)
        else:
            os.environ[self.NAME] = raw
        return generate_zarr._scratch_setting(self.NAME, default, minimum=minimum)

    def test_unset_or_blank_takes_the_default(self):
        self.assertEqual(self.setting(None), 3.0)
        self.assertEqual(self.setting("  "), 3.0)

    def test_a_valid_value_is_used(self):
        self.assertEqual(self.setting("2.5"), 2.5)
        self.assertEqual(self.setting("1"), 1.0)
        self.assertEqual(self.setting("0", default=10.0, minimum=0), 0.0)

    def test_values_that_would_silently_misbehave_are_refused_by_name(self):
        for raw in ("0", "-1", "0.99", "nan", "inf", "-inf", "abc"):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError) as caught:
                    self.setting(raw)
                self.assertIn(self.NAME, str(caught.exception))

    def test_a_negative_or_infinite_headroom_is_refused(self):
        for raw in ("-1", "inf", "nan"):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    self.setting(raw, default=10.0, minimum=0)

    def _import_in_fresh_interpreter(self, **env):
        base = {k: v for k, v in os.environ.items() if not k.startswith("ZARR_SCRATCH_")}
        code = (
            f"import sys; sys.path.insert(0, {str(Path(__file__).resolve().parent)!r}); "
            "import generate_zarr as g, json; "
            "print(g.SCRATCH_STREAM_FACTOR, g.SCRATCH_INMEM_FACTOR, g.SCRATCH_HEADROOM_BYTES); "
            "print(json.dumps(g.SCRATCH_SETTING_ERRORS))"
        )
        return subprocess.run(
            [sys.executable, "-I", "-c", code], env={**base, **env},
            capture_output=True, text=True, timeout=120,
        )

    def test_the_shipped_defaults_are_3_2_and_10_gib(self):
        # The values the node runs with. A fresh interpreter, so another test's
        # override of the module attributes cannot make this pass or fail.
        out = self._import_in_fresh_interpreter()
        self.assertEqual(out.returncode, 0, out.stderr)
        values, errors = out.stdout.splitlines()
        self.assertEqual(values.split(), ["3.0", "2.0", str(10 * 1024**3)])
        self.assertEqual(json.loads(errors), [])

    def test_a_bad_setting_does_not_break_the_import_and_is_recorded_by_name(self):
        # Every dataset run (and patch_duration) imports this module: raising here
        # would kill each before it could write a callback.
        for name, raw in (
            ("ZARR_SCRATCH_STREAM_FACTOR", "0"),
            ("ZARR_SCRATCH_INMEM_FACTOR", "nan"),
            ("ZARR_SCRATCH_HEADROOM_BYTES", "10G"),
        ):
            with self.subTest(name=name):
                out = self._import_in_fresh_interpreter(**{name: raw})
                self.assertEqual(out.returncode, 0, out.stderr)
                values, errors = out.stdout.splitlines()
                self.assertEqual(
                    values.split(), ["3.0", "2.0", str(10 * 1024**3)], "defaults stand"
                )
                (message,) = json.loads(errors)
                self.assertIn(name, message)

    def test_main_refuses_a_bad_setting_and_reports_it_through_the_callback(self):
        script = Path(__file__).resolve().parent / "generate_zarr.py"
        env = {k: v for k, v in os.environ.items() if not k.startswith("ZARR_SCRATCH_")}
        env["ZARR_SCRATCH_HEADROOM_BYTES"] = "10G"
        with tempfile.TemporaryDirectory() as tmp:
            callback = os.path.join(tmp, "cb.json")
            done = subprocess.run(
                [sys.executable, str(script), "--dataset-id", "on000001",
                 "--repo-dir", os.path.join(tmp, "no-repo"), "--callback-out", callback],
                env=env, capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(done.returncode, 1, done.stderr)
            with open(callback) as fh:
                body = json.load(fh)
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["dataset_id"], "on000001")
        self.assertFalse(body["deterministic"], "a config typo must stay retryable")
        self.assertIn("ZARR_SCRATCH_HEADROOM_BYTES='10G' is not a number", body["error"])
        self.assertIn("::error::invalid scratch setting", done.stdout)


class TestCheckEnv(unittest.TestCase):
    """`--check-env`: the scratch settings, validated once, with no dataset."""

    SCRIPT = Path(__file__).resolve().parent / "generate_zarr.py"

    def run_check(self, **env):
        base = {k: v for k, v in os.environ.items() if not k.startswith("ZARR_SCRATCH_")}
        return subprocess.run(
            [sys.executable, str(self.SCRIPT), "--check-env"], env={**base, **env},
            capture_output=True, text=True, timeout=120,
        )

    def test_valid_settings_exit_zero_and_say_nothing(self):
        done = self.run_check()
        self.assertEqual((done.returncode, done.stdout), (0, ""), done.stderr)

    def test_a_valid_override_is_accepted(self):
        self.assertEqual(self.run_check(ZARR_SCRATCH_HEADROOM_BYTES="0").returncode, 0)

    def test_a_bad_setting_exits_one_and_names_it(self):
        done = self.run_check(ZARR_SCRATCH_HEADROOM_BYTES="10G")
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn("::error::invalid scratch setting", done.stdout)
        self.assertIn("ZARR_SCRATCH_HEADROOM_BYTES='10G' is not a number", done.stdout)

    def test_every_bad_setting_is_listed_in_one_message(self):
        done = self.run_check(ZARR_SCRATCH_STREAM_FACTOR="0", ZARR_SCRATCH_INMEM_FACTOR="nan")
        self.assertEqual(done.returncode, 1)
        self.assertIn("ZARR_SCRATCH_STREAM_FACTOR", done.stdout)
        self.assertIn("ZARR_SCRATCH_INMEM_FACTOR", done.stdout)

    def test_it_needs_no_dataset_repository_or_callback(self):
        # None of the arguments a conversion requires, and it must not write one.
        with tempfile.TemporaryDirectory() as tmp:
            before = os.listdir(tmp)
            self.assertEqual(self.run_check().returncode, 0)
            self.assertEqual(os.listdir(tmp), before)


class TestUnreadableSizesAreCharged(unittest.TestCase):
    STREAMED = "sub-01/ieeg/sub-01_task-x_ieeg.vhdr"

    def _git(self, repo, *args):
        subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)

    def _repo(self, repo, links):
        self._git(repo, "init", "-q")
        self._git(repo, "config", "user.email", "t@t")
        self._git(repo, "config", "user.name", "t")
        for path, key in links.items():
            os.makedirs(os.path.dirname(os.path.join(repo, path)), exist_ok=True)
            os.symlink(f"../../.git/annex/objects/aa/bb/{key}/{key}", os.path.join(repo, path))
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-qm", "fixture")
        return subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"], text=True).strip()

    def test_a_zero_size_is_charged_the_floor_not_nothing(self):
        floor = generate_zarr.SCRATCH_UNKNOWN_SIZE_BYTES
        self.assertEqual(generate_zarr.scratch_peak_bytes(self.STREAMED, 0), floor)
        self.assertGreater(floor, 0)

    def test_a_key_without_a_size_field_is_charged_at_least_the_floor(self):
        floor = generate_zarr.SCRATCH_UNKNOWN_SIZE_BYTES
        tiny = 4096  # only the sidecars could be sized
        self.assertEqual(generate_zarr.scratch_peak_bytes(self.STREAMED, tiny, False), floor)

    def test_a_readable_size_is_charged_by_its_factor_even_when_small(self):
        got = generate_zarr.scratch_peak_bytes(self.STREAMED, 4096, True)
        self.assertEqual(got, int(4096 * generate_zarr.SCRATCH_INMEM_FACTOR))

    def test_the_floor_never_lowers_a_larger_charge(self):
        size = 100 * 1024**3
        got = generate_zarr.scratch_peak_bytes(self.STREAMED, size, False)
        self.assertEqual(got, int(size * generate_zarr.SCRATCH_STREAM_FACTOR))

    def test_pointer_walk_reports_whether_the_size_could_be_read(self):
        sized = "sub-01/eeg/sub-01_task-a_eeg.set"
        sizeless = "sub-02/eeg/sub-02_task-a_eeg.set"
        with tempfile.TemporaryDirectory() as repo:
            head = self._repo(repo, {
                sized: "SHA256E-s5000--aaaa.set",
                # A WORM key's name after `--` is free text, never a size.
                sizeless: "WORM-m1700000000--sub-02-s5.set",
            })
            files = {sized, sizeless}
            self.assertEqual(
                generate_zarr.recording_size_info(repo, sized, files, head), (5000, True)
            )
            size, readable = generate_zarr.recording_size_info(repo, sizeless, files, head)
            self.assertEqual((size, readable), (0, False))
            absent = "sub-03/eeg/sub-03_task-a_eeg.set"
            self.assertEqual(
                generate_zarr.recording_size_info(repo, absent, files | {absent}, head),
                (0, False),
            )

    def test_admission_size_info_adds_a_declared_fdt_and_keeps_readability(self):
        sized = "sub-01/eeg/sub-01_task-a_eeg.set"
        with tempfile.TemporaryDirectory() as repo:
            head = self._repo(repo, {sized: "SHA256E-s5000--aaaa.set"})
            decl = {sized: {"fdt": "x.fdt", "fdt_bytes": 700}}
            info = generate_zarr.admission_size_info(repo, [sized], {sized}, head, decl)
        self.assertEqual(info, {sized: (5700, True)})


class TestScratchAdmissionDecision(unittest.TestCase):
    GIB = 1024**3

    def test_a_recording_that_does_not_fit_scratch_waits_for_one_that_does(self):
        # Running 100 of a 150 budget: the 80 behind the head cannot fit, the 40 can.
        idx = _next_admission(
            [1, 1], 1, 0, 4, 100,
            pending_scratch=[80, 40], running_scratch=100, scratch_budget=150,
        )
        self.assertEqual(idx, 1)

    def test_scratch_has_no_run_alone_exception(self):
        # RAM lets an oversized head run alone because its own preflight skips it
        # cleanly. A recording the DISK cannot hold would download for hours and
        # then fail, so it is never admitted, even with nothing in flight.
        self.assertIsNone(
            _next_admission(
                [1], 0, 0, 4, 100,
                pending_scratch=[200], running_scratch=0, scratch_budget=150,
            )
        )

    def test_ram_still_runs_an_oversized_head_alone_when_scratch_fits(self):
        self.assertEqual(
            _next_admission(
                [10**12], 0, 0, 4, 100,
                pending_scratch=[10], running_scratch=0, scratch_budget=150,
            ),
            0,
        )

    def test_without_a_scratch_budget_nothing_changes(self):
        self.assertEqual(_next_admission([10**12], 0, 0, 4, 100), 0)
        self.assertEqual(
            _next_admission([30, 10], 1, 50, 4, 100, pending_scratch=[10**15, 10**15]), 0
        )

    def test_a_recording_exactly_at_the_budget_is_admitted(self):
        self.assertEqual(
            _next_admission(
                [1], 1, 0, 4, 100, pending_scratch=[50], running_scratch=100, scratch_budget=150
            ),
            0,
        )

    def test_a_streamed_recording_is_charged_the_streaming_factor(self):
        size = 10 * self.GIB
        got = generate_zarr.scratch_peak_bytes("sub-01/ieeg/sub-01_task-x_ieeg.vhdr", size)
        self.assertEqual(got, int(size * generate_zarr.SCRATCH_STREAM_FACTOR))

    def test_a_small_or_unstreamable_recording_is_charged_the_in_memory_factor(self):
        small = 100 * 1024**2  # under the 256 MiB streaming threshold
        self.assertEqual(
            generate_zarr.scratch_peak_bytes("sub-01/ieeg/sub-01_task-x_ieeg.vhdr", small),
            int(small * generate_zarr.SCRATCH_INMEM_FACTOR),
        )
        # EEGLAB .set never streams, whatever its size.
        big = 5 * self.GIB
        self.assertEqual(
            generate_zarr.scratch_peak_bytes("sub-01/eeg/sub-01_task-x_eeg.set", big),
            int(big * generate_zarr.SCRATCH_INMEM_FACTOR),
        )

    def test_the_default_factor_covers_the_measured_nm000276_peak(self):
        # raw 1.00x + float32 memmap 1.00x + int16 memmap 0.50x + views 0.33x
        # was observed at 2.83x on that dataset; the charge must not be below it.
        self.assertGreaterEqual(generate_zarr.SCRATCH_STREAM_FACTOR, 2.83)


class TestScratchBudgetArithmetic(unittest.TestCase):
    """The budget formula on integers, so a term dropped from it fails here
    deterministically instead of hiding behind a volume's real free space."""

    def test_free_plus_held_minus_headroom(self):
        self.assertEqual(generate_zarr.scratch_budget_bytes(100, 30, 10), 120)

    def test_what_the_run_holds_is_added_back(self):
        # Without `held` the run would count its own in-flight writes against
        # itself: free has already shrunk by exactly that much.
        with_held = generate_zarr.scratch_budget_bytes(100, 50, 10)
        without = generate_zarr.scratch_budget_bytes(100, 0, 10)
        self.assertEqual(with_held - without, 50)

    def test_headroom_is_subtracted(self):
        self.assertEqual(generate_zarr.scratch_budget_bytes(100, 0, 40), 60)

    def test_it_is_never_negative(self):
        self.assertEqual(generate_zarr.scratch_budget_bytes(5, 0, 10), 0)
        self.assertEqual(generate_zarr.scratch_budget_bytes(0, 0, 0), 0)


class TestHeldScratchBytes(unittest.TestCase):
    A = "sub-01/eeg/sub-01_task-a_eeg.vhdr"
    B = "sub-01/eeg/sub-01_task-b_eeg.vhdr"
    MIB = 1024 * 1024

    def _write(self, root, primary, which, mib):
        path = generate_zarr.recording_scratch_paths(root, primary)[which]
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "blob"), "wb") as fh:
            fh.write(os.urandom(mib * self.MIB))
            fh.flush()
            os.fsync(fh.fileno())

    def test_it_counts_only_the_recordings_it_is_asked_about(self):
        with tempfile.TemporaryDirectory() as root:
            self._write(root, self.A, 0, 4)
            self._write(root, self.B, 0, 4)
            held_a = generate_zarr.held_scratch_bytes(root, [self.A])
            held_both = generate_zarr.held_scratch_bytes(root, [self.A, self.B])
        self.assertGreaterEqual(held_a, 4 * self.MIB)
        self.assertLess(held_a, 8 * self.MIB)
        self.assertGreaterEqual(held_both, 8 * self.MIB)

    def test_debris_nobody_is_running_is_not_counted_as_held(self):
        # A killed worker's leftovers (or a failed delete's) are not scratch the
        # run is about to give back, so they must not be added to its budget.
        with tempfile.TemporaryDirectory() as root:
            self._write(root, self.B, 0, 4)
            self.assertEqual(generate_zarr.held_scratch_bytes(root, []), 0)
            self.assertEqual(generate_zarr.held_scratch_bytes(root, [self.A]), 0)

    def test_it_sums_the_work_store_and_memmap_directories(self):
        with tempfile.TemporaryDirectory() as root:
            for which in (0, 1, 2):
                self._write(root, self.A, which, 2)
            self.assertGreaterEqual(generate_zarr.held_scratch_bytes(root, [self.A]), 6 * self.MIB)


class TestScratchGate(unittest.TestCase):
    """The gate against a stated volume: the probe is injected, the files it
    counts are real, so every number below is exact."""

    A = "sub-01/eeg/sub-01_task-a_eeg.vhdr"

    @staticmethod
    def usage(free, total=10**12):
        return lambda _path: type("Usage", (), {"free": free, "total": total})()

    @staticmethod
    def failing(exc):
        def probe(_path):
            raise exc
        return probe

    def test_the_budget_is_free_minus_headroom_with_nothing_in_flight(self):
        with tempfile.TemporaryDirectory() as root:
            gate = generate_zarr.ScratchGate(root, headroom=100, usage=self.usage(1000))
            self.assertEqual(gate(()), 900)

    def test_what_an_in_flight_recording_holds_is_added_back(self):
        # The assertion a gate that forgot `held` would fail, with no volume noise.
        with tempfile.TemporaryDirectory() as root:
            path = generate_zarr.recording_scratch_paths(root, self.A)[0]
            os.makedirs(path)
            with open(os.path.join(path, "blob"), "wb") as fh:
                fh.write(os.urandom(4 * 1024 * 1024))
            held = generate_zarr.held_scratch_bytes(root, [self.A])
            self.assertGreaterEqual(held, 4 * 1024 * 1024)
            gate = generate_zarr.ScratchGate(root, headroom=100, usage=self.usage(1000))
            self.assertEqual(gate([self.A]), 900 + held)
            self.assertEqual(gate(()), 900, "not in flight, so not ours to hand back")

    def test_the_volume_reports_free_and_total(self):
        with tempfile.TemporaryDirectory() as root:
            gate = generate_zarr.ScratchGate(root, usage=self.usage(7, 9))
            self.assertEqual(gate.volume(), (7, 9))
            free, total = generate_zarr.ScratchGate(root).volume()
        self.assertGreater(total, 0)
        self.assertLessEqual(free, total)

    def test_an_unreadable_volume_from_the_start_admits_nothing_and_says_so_once(self):
        gate = generate_zarr.ScratchGate(
            "/r", usage=self.failing(OSError(errno.EIO, "Input/output error"))
        )
        with contextlib.redirect_stdout(io.StringIO()) as out:
            first, second = gate(()), gate(())
        self.assertEqual((first, second), (0, 0))
        self.assertEqual(out.getvalue().count("cannot read the scratch volume"), 1)
        self.assertIn("admitting nothing", out.getvalue())
        self.assertIsNone(gate.volume())

    def test_a_volume_that_fails_mid_run_keeps_the_last_good_budget(self):
        state = {"fail": None, "free": 1000}

        def probe(_path):
            if state["fail"]:
                raise state["fail"]
            return type("Usage", (), {"free": state["free"], "total": 10**12})()

        gate = generate_zarr.ScratchGate("/r", headroom=100, usage=probe)
        self.assertEqual(gate(()), 900)
        state["fail"] = OSError(errno.ESTALE, "Stale file handle")
        state["free"] = 5  # what a successful read would now say; it must not be used
        with contextlib.redirect_stdout(io.StringIO()) as out:
            during = [gate(()), gate(()), gate(())]
        self.assertEqual(during, [900, 900, 900], "fail closed on the last good budget")
        self.assertEqual(
            out.getvalue().count("cannot read the scratch volume"), 1, "warned once, not per round"
        )
        self.assertIn("holding the last good budget of", out.getvalue())

    def test_it_recovers_and_warns_again_after_a_later_failure(self):
        state = {"fail": None}

        def probe(_path):
            if state["fail"]:
                raise state["fail"]
            return type("Usage", (), {"free": 1000, "total": 10**12})()

        gate = generate_zarr.ScratchGate("/r", headroom=0, usage=probe)
        gate(())
        state["fail"] = OSError(errno.EIO, "x")
        with contextlib.redirect_stdout(io.StringIO()):
            gate(())
        state["fail"] = None
        self.assertEqual(gate(()), 1000)
        state["fail"] = OSError(errno.EIO, "x")
        with contextlib.redirect_stdout(io.StringIO()) as out:
            gate(())
        self.assertEqual(out.getvalue().count("cannot read the scratch volume"), 1)


class TestDrainAdmitsAgainstScratch(unittest.TestCase):
    """The drain charges scratch like RAM: what fits runs, what waits is admitted
    when something finishes, and what can never fit is handed back unreported."""

    PRIMARIES = tuple(f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 4))

    def setUp(self):
        # Short enough that the re-samples before a deferral cost milliseconds.
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.05

    def _drain(self, scratch_peaks, budget, cpu_cap=3, deferred=None, volume=None):
        results = []
        _drain_with_admission(
            list(scratch_peaks), {p: 1024 for p in scratch_peaks}, cpu_cap, 10**12, {},
            lambda r, i: results.append(r), worker=_timed_worker,
            scratch_peaks=scratch_peaks,
            scratch_budget=budget if callable(budget) else (lambda _in_flight: budget),
            deferred=deferred, scratch_volume=volume,
        )
        return results

    def test_a_tight_budget_runs_recordings_one_at_a_time(self):
        peaks = {p: 100 for p in self.PRIMARIES}
        spans = sorted(r["span"] for r in self._drain(peaks, budget=150))
        self.assertEqual(len(spans), 3)
        for earlier, later in itertools.pairwise(spans):
            self.assertGreaterEqual(later[0], earlier[1] - 0.01)

    def test_a_roomy_budget_runs_them_together(self):
        peaks = {p: 100 for p in self.PRIMARIES}
        spans = sorted(r["span"] for r in self._drain(peaks, budget=1000))
        self.assertLess(spans[1][0], spans[0][1], "the second started before the first ended")

    def test_a_recording_that_can_never_fit_is_deferred_not_reported(self):
        a, b, c = self.PRIMARIES
        deferred: dict[str, str] = {}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            results = self._drain({b: 500, a: 50, c: 50}, budget=150, cpu_cap=2, deferred=deferred)
        self.assertEqual(sorted(r["primary"] for r in results), [a, c])
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(list(deferred), [b])
        self.assertIn("deferred 1 recording(s)", out.getvalue())

    def test_the_first_fitting_and_the_second_not_converts_one_and_defers_one(self):
        a, b, _ = self.PRIMARIES
        deferred: dict[str, str] = {}
        with contextlib.redirect_stdout(io.StringIO()):
            results = self._drain({a: 50, b: 500}, budget=150, cpu_cap=2, deferred=deferred)
        self.assertEqual([r["primary"] for r in results], [a])
        self.assertEqual(list(deferred), [b])

    def test_it_terminates_when_every_recording_is_too_large(self):
        deferred: dict[str, str] = {}
        with contextlib.redirect_stdout(io.StringIO()):
            results = self._drain({p: 500 for p in self.PRIMARIES}, budget=150, deferred=deferred)
        self.assertEqual(results, [])
        self.assertEqual(sorted(deferred), sorted(self.PRIMARIES))

    def test_each_deferred_recording_is_named_with_its_charge_and_the_volume(self):
        a, b, _ = self.PRIMARIES
        gib = 1024**3
        deferred: dict[str, str] = {}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self._drain(
                {a: 80 * gib, b: 60 * gib}, budget=50 * gib, deferred=deferred,
                volume=lambda: (40 * gib, 500 * gib),
            )
        log = out.getvalue()
        for primary, charge in ((a, 80), (b, 60)):
            line = next(ln for ln in log.splitlines() if primary in ln)
            self.assertIn(f"charged {charge} GiB", line)
            self.assertIn("budget 50 GiB", line)
            self.assertIn("free 40 of 500 GiB", line)
        self.assertEqual(deferred[a], "deferred: needs 80 GiB of scratch, 50 GiB available")
        self.assertNotIn("::error::", log, "both could fit an empty volume, so neither is final")

    def test_a_recording_larger_than_the_volume_is_an_error_naming_it(self):
        a, b, _ = self.PRIMARIES
        gib = 1024**3
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self._drain(
                {a: 900 * gib, b: 60 * gib}, budget=50 * gib,
                volume=lambda: (40 * gib, 500 * gib),
            )
        errors = [ln for ln in out.getvalue().splitlines() if ln.startswith("::error::")]
        self.assertEqual(len(errors), 1)
        self.assertIn(a, errors[0])
        self.assertIn("can never fit this volume", errors[0])
        self.assertIn("1 can never fit", out.getvalue())

    def test_the_per_recording_lines_are_capped_but_every_recording_is_deferred(self):
        self.addCleanup(
            setattr, generate_zarr, "SCRATCH_DEFER_LOG_LINES", generate_zarr.SCRATCH_DEFER_LOG_LINES
        )
        generate_zarr.SCRATCH_DEFER_LOG_LINES = 2
        peaks = {f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set": 500 for i in range(1, 6)}
        deferred: dict[str, str] = {}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self._drain(peaks, budget=150, deferred=deferred)
        self.assertEqual(len(deferred), 5)
        self.assertEqual(out.getvalue().count("::warning::deferring "), 2)
        self.assertIn("3 more deferred recording(s) not listed", out.getvalue())

    def test_a_transient_spike_does_not_defer_the_queue(self):
        # With nothing in flight one bad sample used to defer everything left. The
        # volume reads as full twice, then as it really is.
        reads = {"n": 0}

        def spiky(_in_flight):
            reads["n"] += 1
            return 0 if reads["n"] <= 2 else 10**6

        deferred: dict[str, str] = {}
        results = self._drain({p: 100 for p in self.PRIMARIES}, budget=spiky, deferred=deferred)
        self.assertEqual(len(results), 3)
        self.assertEqual(deferred, {})

    def test_a_sustained_shortage_defers_after_the_resamples(self):
        reads = {"n": 0}

        def full(_in_flight):
            reads["n"] += 1
            return 0

        deferred: dict[str, str] = {}
        with contextlib.redirect_stdout(io.StringIO()):
            self._drain({p: 100 for p in self.PRIMARIES}, budget=full, deferred=deferred)
        self.assertEqual(len(deferred), 3)
        self.assertEqual(reads["n"], 1 + generate_zarr.SCRATCH_DEFER_RESAMPLES)

    def test_without_resamples_the_first_sample_decides(self):
        self.addCleanup(
            setattr, generate_zarr, "SCRATCH_DEFER_RESAMPLES", generate_zarr.SCRATCH_DEFER_RESAMPLES
        )
        generate_zarr.SCRATCH_DEFER_RESAMPLES = 0
        reads = {"n": 0}

        def spiky(_in_flight):
            reads["n"] += 1
            return 0 if reads["n"] == 1 else 10**6

        deferred: dict[str, str] = {}
        with contextlib.redirect_stdout(io.StringIO()):
            self._drain({p: 100 for p in self.PRIMARIES}, budget=spiky, deferred=deferred)
        self.assertEqual(len(deferred), 3)

    def test_a_budget_that_changes_between_rounds_is_followed(self):
        # Every other test here hands the drain a constant. This one rewrites the
        # budget while recordings run, as another tenant freeing space would.
        import threading

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "budget")

        def set_budget(n):
            with open(path + ".tmp", "w") as fh:
                fh.write(str(n))
            os.replace(path + ".tmp", path)

        def read_budget(_in_flight):
            with open(path) as fh:
                return int(fh.read())

        set_budget(150)  # room for one recording at a time
        timer = threading.Timer(0.2, set_budget, args=(10**6,))
        timer.start()
        self.addCleanup(timer.cancel)
        results = []
        _drain_with_admission(
            list(self.PRIMARIES), {p: 1024 for p in self.PRIMARIES}, 3, 10**12, {},
            lambda r, i: results.append(r), worker=_timed_worker,
            scratch_peaks={p: 100 for p in self.PRIMARIES}, scratch_budget=read_budget,
        )
        spans = sorted(r["span"] for r in results)
        self.assertEqual(len(spans), 3)
        # The first runs 0.8 s; the budget rises at 0.2 s and the others start then.
        self.assertLess(spans[1][0], spans[0][1])
        self.assertLess(spans[2][0], spans[0][1])

    def test_what_in_flight_recordings_hold_is_counted_in_the_pool_path(self):
        # The budget is free + held - headroom, with `held` read from the recordings
        # that are RUNNING. Here two admitted recordings write real scratch, and the
        # third (which does not fit on the stated free space alone) must be admitted
        # as soon as they have: a drain that handed the gate no in-flight recordings
        # would hold it back until one finished.
        primaries = list(self.PRIMARIES)
        headroom = 10**9
        free = headroom + 250

        def usage(_path):
            return type("U", (), {"free": free, "total": 10**12})()

        seen: list[tuple[list[str], int]] = []
        results = []
        with tempfile.TemporaryDirectory() as tmp:
            gate = generate_zarr.ScratchGate(tmp, headroom=headroom, usage=usage)

            def spy(in_flight):
                budget = gate(in_flight)
                seen.append((list(in_flight), budget))
                return budget

            _drain_with_admission(
                primaries, {p: 1024 for p in primaries}, 3, 10**12, {"tmp": tmp},
                lambda r, i: results.append(r), worker=_scratch_worker,
                scratch_peaks={p: 100 for p in primaries}, scratch_budget=spy,
            )
        self.assertEqual(len(results), 3)
        # Three recordings of 100 against a stated 250: the third waited ...
        starts = sorted(r["span"][0] for r in results)
        first_end = min(r["span"][1] for r in results)
        # ... and was admitted before either of the first two had finished, because
        # their files were by then held scratch, not free space.
        self.assertLess(starts[2], first_end)
        two_in_flight = [(live, b) for live, b in seen if len(live) == 2]
        self.assertTrue(two_in_flight, "the gate was never asked with two recordings running")
        self.assertTrue(all(b >= 250 for _, b in two_in_flight))
        self.assertTrue(
            any(b > 250 for _, b in two_in_flight),
            "what the two hold was not added to the budget",
        )

    def test_an_unreadable_volume_admits_nothing_instead_of_everything(self):
        # The default gate fails closed: with no good read there is no budget, so
        # the whole queue is deferred rather than admitted blind.
        deferred: dict[str, str] = {}
        results = []
        with contextlib.redirect_stdout(io.StringIO()) as out:
            _drain_with_admission(
                list(self.PRIMARIES), {p: 1024 for p in self.PRIMARIES}, 3, 10**12,
                {"tmp": "/no/such/scratch/root"}, lambda r, i: results.append(r),
                worker=_timed_worker, scratch_peaks={p: 1 for p in self.PRIMARIES},
                deferred=deferred,
            )
        self.assertEqual(results, [])
        self.assertEqual(sorted(deferred), sorted(self.PRIMARIES))
        self.assertEqual(out.getvalue().count("cannot read the scratch volume"), 1)

    def test_an_unconsumed_deferral_does_not_crash_a_caller_that_ignores_it(self):
        with contextlib.redirect_stdout(io.StringIO()):
            results = self._drain({p: 500 for p in self.PRIMARIES}, budget=150)
        self.assertEqual(results, [])



class TestSerialDrainAdmitsAgainstScratch(unittest.TestCase):
    """The ``--jobs 1`` drain: same rule, in this process."""

    A, B, C = tuple(f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 4))

    def setUp(self):
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.01

    def _run(self, peaks, budget, order=None):
        ran, results, deferred = [], [], {}

        def run_one(p):
            ran.append(p)
            return {"ok": True, "primary": p}

        with contextlib.redirect_stdout(io.StringIO()) as out:
            generate_zarr.drain_serially(
                list(order or peaks), peaks,
                budget if callable(budget) else (lambda _in_flight: budget),
                None, deferred, run_one, lambda r, i: results.append((i, r["primary"])),
            )
        return ran, results, deferred, out.getvalue()

    def test_the_first_fitting_and_the_second_not_converts_one_and_defers_one(self):
        ran, results, deferred, _ = self._run({self.A: 50, self.B: 500}, 150)
        self.assertEqual(ran, [self.A])
        self.assertEqual(results, [(1, self.A)])
        self.assertEqual(list(deferred), [self.B])
        self.assertTrue(deferred[self.B].startswith("deferred: needs"))

    def test_a_giant_at_the_head_does_not_hold_a_smaller_recording_behind_it(self):
        ran, _, deferred, _ = self._run({self.B: 500, self.A: 50}, 150)
        self.assertEqual(ran, [self.A])
        self.assertEqual(list(deferred), [self.B])

    def test_everything_that_fits_runs_in_order(self):
        ran, results, deferred, _ = self._run({self.A: 10, self.B: 20, self.C: 30}, 150)
        self.assertEqual(ran, [self.A, self.B, self.C])
        self.assertEqual([i for i, _ in results], [1, 2, 3])
        self.assertEqual(deferred, {})

    def test_a_transient_spike_does_not_defer(self):
        reads = {"n": 0}

        def spiky(_in_flight):
            reads["n"] += 1
            return 0 if reads["n"] <= 2 else 10**6

        ran, _, deferred, _ = self._run({self.A: 10, self.B: 20}, spiky)
        self.assertEqual(ran, [self.A, self.B])
        self.assertEqual(deferred, {})

    def test_a_sustained_shortage_defers_all_after_the_resamples(self):
        reads = {"n": 0}

        def full(_in_flight):
            reads["n"] += 1
            return 0

        ran, _, deferred, log = self._run({self.A: 10, self.B: 20}, full)
        self.assertEqual(ran, [])
        self.assertEqual(len(deferred), 2)
        self.assertEqual(reads["n"], 1 + generate_zarr.SCRATCH_DEFER_RESAMPLES)
        self.assertIn(self.A, log)
        self.assertIn(self.B, log)


class TestHeldMemoryFailureIsReportedWhenTheRetryCannotFit(unittest.TestCase):
    """A recording that failed its memory budget WAS attempted. If the serial retry
    then cannot get scratch for it, the failure it already had is reported, not
    replaced by "not attempted" at the index's coverage balance."""

    MIB = 1024**2

    def setUp(self):
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.01

    def _run(self, retry_budget):
        small = "sub-01/eeg/sub-01_task-rest_eeg.set"
        big = "sub-02/eeg/sub-02_task-rest_need-300_eeg.set"
        peaks = {small: 100 * self.MIB, big: 100 * self.MIB}
        phase = {"retry": False}
        results, deferred = [], {}

        def memory_retry():
            phase["retry"] = True
            return {"mem_budget": 512 * self.MIB}, 512 * self.MIB

        with contextlib.redirect_stdout(io.StringIO()):
            _drain_with_admission(
                [small, big], peaks, 2, 10**12, {"mem_budget": 100 * self.MIB},
                lambda r, i: results.append(r), worker=_budget_worker,
                memory_retry=memory_retry, scratch_peaks={small: 1, big: 1},
                scratch_budget=lambda _in_flight: retry_budget if phase["retry"] else 10**9,
                deferred=deferred,
            )
        return small, big, {r["primary"]: r for r in results}, deferred

    def test_a_retry_with_room_converts_it(self):
        small, big, results, deferred = self._run(retry_budget=10**9)
        self.assertTrue(results[big]["ok"])
        self.assertEqual(deferred, {})

    def test_a_retry_without_room_reports_the_memory_failure_it_already_had(self):
        small, big, results, deferred = self._run(retry_budget=0)
        self.assertTrue(results[small]["ok"])
        self.assertFalse(results[big]["ok"])
        self.assertEqual(results[big]["code"], "recording_memory_exceeded")
        self.assertNotIn(big, deferred, "it was attempted, so it is not a deferral")

class TestSerialMemoryRetry(unittest.TestCase):
    """#1483: a recording that exceeds its memory reserve is retried ONCE, alone,
    at the end of the run, with the budget the node offers then. Before, it waited
    1h-7d for a retry round that rebuilt the whole dataset under the same budget
    and mostly failed the same way."""

    MIB = 1024**2
    RESERVE = 100 * MIB
    RETRY = 512 * MIB

    @staticmethod
    def _rec(i, need=0):
        tag = f"_need-{need}" if need else ""
        return f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest{tag}_eeg.set"

    def _run(self, primaries, retry_peak=None, cpu_cap=3, with_retry=True):
        retry_peak = self.RETRY if retry_peak is None else retry_peak
        peaks = {p: self.RESERVE for p in primaries}
        results, indices, asked = [], [], []

        def memory_retry():
            asked.append(retry_peak)
            return {"mem_budget": retry_peak}, retry_peak

        def record(r, i):
            results.append(r)
            indices.append(i)

        _drain_with_admission(
            list(primaries), peaks, cpu_cap, 10**12, {"mem_budget": self.RESERVE},
            record, worker=_budget_worker,
            memory_retry=memory_retry if with_retry else None,
        )
        self.assertEqual(indices, list(range(1, len(primaries) + 1)),
                         "every recording is reported exactly once, in order")
        self.assertEqual(sorted(r["primary"] for r in results), sorted(primaries))
        return {r["primary"]: r for r in results}, asked

    def test_a_memory_failure_converts_when_retried_alone(self):
        small = [self._rec(i) for i in range(1, 6)]
        big = [self._rec(i, need=300) for i in range(6, 8)]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            results, asked = self._run(small[:2] + big[:1] + small[2:] + big[1:])

        self.assertTrue(all(r["ok"] for r in results.values()))
        self.assertEqual(len(asked), 1, "the retry budget is read once per run")
        for p in big:
            # Retried with the budget read AFTER the parallel pass, both as the
            # reserve and as the worker context's ceiling.
            self.assertEqual(results[p]["reserve"], self.RETRY)
            self.assertEqual(results[p]["mem_budget"], self.RETRY)
        for p in small:
            self.assertEqual(results[p]["reserve"], self.RESERVE)
            self.assertEqual(results[p]["mem_budget"], self.RESERVE)
        # At the end of the run, and one at a time.
        first_pass_end = max(results[p]["span"][1] for p in small)
        spans = sorted(results[p]["span"] for p in big)
        self.assertGreaterEqual(spans[0][0], first_pass_end)
        self.assertGreaterEqual(spans[1][0], spans[0][1], "retries must not overlap")
        self.assertIn("2 of 2 converted", out.getvalue())

    def test_a_recording_that_fails_again_is_reported_once(self):
        huge = self._rec(9, need=1024)
        with contextlib.redirect_stdout(io.StringIO()):
            results, _ = self._run([self._rec(1), huge, self._rec(2)])
        r = results[huge]
        self.assertFalse(r["ok"])
        # Still the retryable memory code, so it goes to `pending` for the next
        # round rather than being recorded as a property of the data.
        self.assertEqual(r["code"], RecordingMemoryExceeded.code)
        self.assertIn("had 512 MiB", r["error"], "the reported failure is the retry's")

    def test_no_second_attempt_when_the_node_offers_no_more(self):
        big = self._rec(1, need=300)
        results, asked = self._run([big, self._rec(2)], retry_peak=self.RESERVE)
        self.assertEqual(asked, [self.RESERVE])
        self.assertFalse(results[big]["ok"])
        self.assertIn("had 100 MiB", results[big]["error"])

    def test_retries_per_run_are_capped(self):
        # Each retry runs alone, so a dataset where most recordings trip their
        # reserve must not turn a parallel run into a serial one.
        self.addCleanup(setattr, generate_zarr, "MEMORY_RETRY_MAX", generate_zarr.MEMORY_RETRY_MAX)
        generate_zarr.MEMORY_RETRY_MAX = 1
        big = [self._rec(i, need=300) for i in range(1, 4)]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            results, _ = self._run(big)
        converted = [p for p in big if results[p]["ok"]]
        self.assertEqual(len(converted), 1)
        for p in set(big) - set(converted):
            self.assertIn("had 100 MiB", results[p]["error"])
        self.assertIn("2 more left for the next round", out.getvalue())

    def test_without_a_retry_hook_failures_report_as_before(self):
        big = self._rec(1, need=300)
        results, asked = self._run([big, self._rec(2)], with_retry=False)
        self.assertEqual(asked, [])
        self.assertIn("had 100 MiB", results[big]["error"])

    def test_a_clean_run_never_reads_a_retry_budget(self):
        # Reading it samples /proc/meminfo three times; a run with nothing to
        # retry has no reason to.
        results, asked = self._run([self._rec(i) for i in range(1, 4)])
        self.assertTrue(all(r["ok"] for r in results.values()))
        self.assertEqual(asked, [])


class TestMemoryFailureForensics(unittest.TestCase):
    """#1483: a memory failure logs where it was raised and how close the worker
    was to its limit; on004789's could only be attributed by reading source."""

    def test_snapshot_reads_the_process_where_proc_exists(self):
        snap = memory_snapshot()
        if sys.platform.startswith("linux"):
            for key in ("VmData", "VmRSS", "VmHWM"):
                self.assertGreater(snap[key], 1024**2)
            self.assertGreaterEqual(snap["VmHWM"], snap["VmRSS"])
        else:
            self.assertNotIn("VmData", snap)

    def test_snapshot_reports_a_finite_data_limit(self):
        import resource

        saved = resource.getrlimit(resource.RLIMIT_DATA)
        limit = (data_segment_bytes() or 0) + 64 * 1024**3
        if saved[1] != resource.RLIM_INFINITY:
            limit = min(limit, saved[1])
        try:
            resource.setrlimit(resource.RLIMIT_DATA, (limit, saved[1]))
        except (OSError, ValueError):
            self.skipTest("RLIMIT_DATA cannot be set here")
        self.addCleanup(resource.setrlimit, resource.RLIMIT_DATA, saved)
        self.assertEqual(memory_snapshot()["RLIMIT_DATA"], limit)

    def test_the_log_names_the_recording_and_the_raising_frame(self):
        def allocate_shard_buffer():
            raise MemoryError("Unable to allocate 60.4 MiB")

        try:
            allocate_shard_buffer()
        except MemoryError as exc:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                log_memory_failure("sub-01/ieeg/sub-01_ieeg.edf", exc)
        text = out.getvalue()
        self.assertTrue(text.startswith("::warning::'sub-01/ieeg/sub-01_ieeg.edf' exceeded"))
        self.assertIn("allocate_shard_buffer", text)
        self.assertIn("MemoryError: Unable to allocate 60.4 MiB", text)

    def test_logging_never_raises(self):
        # A failure inside the log must not turn a typed memory failure into an
        # uncoded one that retries forever.
        class Unprintable:
            def __repr__(self):
                raise MemoryError("no room to format this")

        with contextlib.redirect_stdout(io.StringIO()):
            log_memory_failure(Unprintable(), MemoryError("x"))


class TestStoreMetadataDiagnostics(unittest.TestCase):
    """#1119: a store-read failure must name its cause, and must not publish it."""

    def test_unreadable_store_reports_the_cause_privately(self):
        meta = store_metadata("/no/such/store.zarr")
        self.assertFalse(meta.get("groups"))
        self.assertIn("_error", meta)

    def test_diagnostic_keys_are_underscore_prefixed(self):
        # `meta` is spread into the published index entry, so anything diagnostic
        # has to be filterable. The `_` prefix is that contract.
        meta = store_metadata("/no/such/store.zarr")
        for key in meta:
            if key == "_error":
                continue
            self.assertFalse(key.startswith("_"), f"unexpected private key {key}")


class TestPeakRssMeasurement(unittest.TestCase):
    """#1111: per-recording peak RAM, so the projection factors stop being guesses."""

    def test_peak_rss_is_readable_and_plausible(self):
        rss = peak_rss_bytes()
        if rss is None:
            self.skipTest("no readable peak-RSS source on this platform")
        # A running CPython is comfortably over 1 MiB and nowhere near 1 TiB;
        # this catches a units error (KiB read as bytes, or vice versa), which is
        # the realistic failure mode here.
        self.assertGreater(rss, 1024**2)
        self.assertLess(rss, 1024**4)

    @unittest.skipUnless(sys.platform.startswith("linux"), "clear_refs is Linux-only")
    def test_reset_actually_lowers_the_high_water_mark(self):
        # The whole reason measurement is trustworthy with REUSED pool workers:
        # without this a small recording inherits the peak of the largest one its
        # worker handled earlier, and every number is an upper envelope.
        blob = bytearray(256 * 1024**2)
        blob[::4096] = b"\x01" * (len(blob) // 4096)  # touch it so it is resident
        before = peak_rss_bytes()
        del blob
        self.assertTrue(reset_peak_rss())
        after = peak_rss_bytes()
        self.assertIsNotNone(before)
        self.assertIsNotNone(after)
        self.assertLess(after, before, "clear_refs did not reset the peak")

    def test_reset_is_harmless_where_unsupported(self):
        # Returns False rather than raising, so a platform without clear_refs
        # simply reports coarser numbers instead of failing conversions.
        self.assertIn(reset_peak_rss(), (True, False))


class TestInMemoryFactors(unittest.TestCase):
    """#1111: one blow-up multiplier for every format was the calibration error."""

    def test_brainvision_is_higher_than_the_default(self):
        # Its chain is MNE float64 preload + a per-channel DataFrame copy + the
        # pandas consolidation transient + the resample copy -- roughly twice the
        # generic assumption, which is what the admission controller mis-reserved
        # when it packed seven of them onto a 62 GB node.
        self.assertGreater(inmem_factor_for("sub-01_task-x_eeg.vhdr"), INMEM_MEM_FACTOR)

    def test_unmeasured_formats_keep_the_default(self):
        for name in ("sub-01_eeg.set", "sub-01_eeg.edf", "sub-01_meg.con"):
            self.assertEqual(inmem_factor_for(name), INMEM_MEM_FACTOR)

    def test_projection_uses_the_per_format_factor(self):
        # Below the streaming threshold, so the in-memory factor is what applies.
        size = 100 * 1024**2
        self.assertEqual(
            projected_peak_bytes("sub-01_task-x_eeg.vhdr", size),
            int(size * inmem_factor_for("x.vhdr")),
        )


class TestCalibrationSummary(unittest.TestCase):
    """#1111: the feedback loop that turns the factor table into measurement."""

    def test_reports_the_worst_ratio_per_format(self):
        projections = {"a.set": 1000, "b.set": 1000, "c.vhdr": 1000}
        measured = {"a.set": 500, "b.set": 3000, "c.vhdr": 1200}
        rows = {r["ext"]: r for r in calibration_summary(measured, projections, set())}
        self.assertEqual(rows[".set"]["n"], 2)
        self.assertEqual(rows[".set"]["max_ratio"], 3.0)  # the worst, not the mean
        self.assertEqual(rows[".vhdr"]["max_ratio"], 1.2)
        # The peak reported must belong to the SAME recording as the ratio, or the
        # summary attributes one recording's size to another's overrun.
        self.assertEqual(rows[".set"]["max_peak_bytes"], 3000)

    def test_worst_format_sorts_first(self):
        projections = {"a.set": 1000, "b.vhdr": 1000}
        measured = {"a.set": 4000, "b.vhdr": 1100}
        self.assertEqual(calibration_summary(measured, projections, set())[0]["ext"], ".set")

    def test_suggested_factor_scales_the_current_one(self):
        # Advisory only: it says what WOULD have covered the worst case, and is
        # never applied automatically -- one pathological recording must not
        # silently re-tune the archive.
        rows = calibration_summary({"a.set": 2000}, {"a.set": 1000}, set())
        self.assertEqual(rows[0]["suggested_factor"], round(INMEM_MEM_FACTOR * 2, 1))

    def test_streamed_recordings_get_no_factor_suggestion(self):
        # A streamed recording's projection is the flat STREAM_PEAK_BYTES,
        # unrelated to on-disk size, so multiplying a blow-up factor by its
        # overrun ratio yields a number that looks like a factor but is not one.
        rows = calibration_summary(
            {"a.edf": STREAM_PEAK_BYTES * 2}, {"a.edf": STREAM_PEAK_BYTES}, {"a.edf"}
        )
        self.assertEqual(rows[0]["path"], "stream")
        self.assertNotIn("suggested_factor", rows[0])

    def test_the_same_format_is_split_by_which_path_it_took(self):
        rows = calibration_summary(
            {"a.edf": 100, "b.edf": STREAM_PEAK_BYTES * 2},
            {"a.edf": 50, "b.edf": STREAM_PEAK_BYTES},
            {"b.edf"},
        )
        self.assertEqual({r["path"] for r in rows}, {"inmem", "stream"})

    def test_channel_raised_streaming_projection_still_buckets_as_stream(self):
        # Regression: the bucket used to be derived from `proj == STREAM_PEAK_BYTES`,
        # which silently stopped being equivalent to "streamed" once
        # `streaming_peak_bytes` began raising the projection to the per-channel
        # floor for a few-channel, long, high-rate recording (ADR 0030). Such a
        # recording streamed, but was bucketed "inmem" and handed a suggested_factor
        # computed from a streaming projection -- a number that reads like a blow-up
        # multiplier and is not one.
        raised = streaming_peak_bytes(8 * 1024**3, 2)
        self.assertGreater(raised, STREAM_PEAK_BYTES)  # guard: the case is real
        rows = calibration_summary({"a.edf": raised * 2}, {"a.edf": raised}, {"a.edf"})
        self.assertEqual(rows[0]["path"], "stream")
        self.assertNotIn("suggested_factor", rows[0])

    def test_recordings_without_a_projection_are_ignored(self):
        self.assertEqual(calibration_summary({"ghost.set": 10}, {}, set()), [])

    def test_empty_input_is_empty_output(self):
        self.assertEqual(calibration_summary({}, {}, set()), [])


class TestUsableRam(unittest.TestCase):
    """#1111: the ceiling must describe RAM we can actually get."""

    def test_is_positive_and_not_absurd(self):
        os.environ.pop("ZARR_REC_MEM_BUDGET_BYTES", None)
        usable = usable_ram_bytes()
        self.assertGreater(usable, 0)
        self.assertLess(usable, 1024**5)

    @unittest.skipUnless(sys.platform.startswith("linux"), "reads /proc/meminfo")
    def test_never_exceeds_what_the_kernel_says_is_available(self):
        # MemTotal describes a machine we do not have to ourselves: the conversion
        # node is shared, and the page cache backing our own scratch lives in the
        # same RAM. Using it consistently overstated the budget.
        with open("/proc/meminfo") as fh:
            info = {
                line.split(":", 1)[0]: int(line.split()[1]) * 1024
                for line in fh
                if line.split(":", 1)[0] in ("MemTotal", "MemAvailable")
            }
        if "MemAvailable" not in info:
            self.skipTest("kernel too old to publish MemAvailable")
        self.assertLessEqual(usable_ram_bytes(), info["MemAvailable"])
        self.assertLess(usable_ram_bytes(), info["MemTotal"])


class TestUsableRamFromSyntheticMeminfo(unittest.TestCase):
    """#1111: prove the ceiling takes MemAvailable, without depending on whatever
    the host's ambient memory happens to be. On a near-idle CI runner MemAvailable
    is most of MemTotal, so a live-/proc assertion barely discriminates."""

    def _meminfo(self, total_gib, avail_gib=None):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "meminfo")
        lines = [f"MemTotal:       {total_gib * 1024 * 1024} kB\n"]
        if avail_gib is not None:
            lines.append(f"MemAvailable:   {avail_gib * 1024 * 1024} kB\n")
        lines.append("SwapTotal:      0 kB\n")
        with open(path, "w") as fh:
            fh.writelines(lines)
        return path

    def test_prefers_memavailable_over_memtotal(self):
        # Far apart on purpose: the old code took 0.8 * 64 = 51.2 GiB while only
        # 20 GiB was obtainable. That gap is the whole bug.
        path = self._meminfo(total_gib=64, avail_gib=20)
        os.environ["ZARR_MEM_HEADROOM_FRAC"] = "0.8"
        try:
            self.assertAlmostEqual(
                usable_ram_bytes(path) / 1024**3, 16.0, places=1  # 0.8 * 20
            )
        finally:
            os.environ.pop("ZARR_MEM_HEADROOM_FRAC", None)

    def test_falls_back_to_memtotal_on_an_old_kernel(self):
        # MemAvailable landed in 3.14; without it MemTotal is all there is.
        path = self._meminfo(total_gib=64)
        os.environ["ZARR_MEM_HEADROOM_FRAC"] = "0.5"
        try:
            self.assertAlmostEqual(usable_ram_bytes(path) / 1024**3, 32.0, places=1)
        finally:
            os.environ.pop("ZARR_MEM_HEADROOM_FRAC", None)

    def test_a_momentarily_loaded_node_cannot_starve_admission(self):
        # Without a floor, a transient dip yields a ceiling below one streaming
        # recording -- at which point EVERY recording is skipped as "too large"
        # and a node-load artifact is recorded as a property of the data.
        path = self._meminfo(total_gib=64, avail_gib=1)
        self.assertEqual(usable_ram_bytes(path), CEILING_FLOOR_BYTES)
        self.assertGreaterEqual(CEILING_FLOOR_BYTES, STREAM_PEAK_BYTES)


class TestNoteMeasurement(unittest.TestCase):
    """#1111: the bookkeeping that feeds calibration."""

    def test_records_a_measurement_and_stays_quiet_when_within_budget(self):
        measured = {}
        warning = note_measurement(
            {"primary": "a.set", "peak_rss": 500, "ok": True}, {"a.set": 1000}, measured
        )
        self.assertIsNone(warning)
        self.assertEqual(measured, {"a.set": 500})

    def test_warns_when_a_recording_cost_more_than_reserved(self):
        measured = {}
        # Over the containment boundary (projection * slack), not merely over the
        # bare projection.
        warning = note_measurement(
            {"primary": "a.vhdr", "peak_rss": 9000, "ok": True}, {"a.vhdr": 1000}, measured
        )
        self.assertIsNotNone(warning)
        self.assertIn("under-reserved", warning)
        self.assertIn("9.0x", warning)

    def test_stays_quiet_within_the_slack_that_was_actually_reserved(self):
        # A recording over its bare projection but inside its reservation
        # endangered nothing; warning here would put a line against a large share
        # of every run, in a log already too big to read.
        measured = {}
        self.assertIsNone(
            note_measurement(
                {"primary": "a.set", "peak_rss": 2000, "ok": True}, {"a.set": 1000}, measured
            )
        )
        self.assertEqual(measured, {"a.set": 2000})

    def test_an_unmeasured_recording_is_dropped_not_recorded_as_zero(self):
        # None means "not measured" or "measured untrustworthily". Blending it in
        # would silently corrupt the calibration sample.
        measured = {}
        self.assertIsNone(
            note_measurement({"primary": "a.set", "peak_rss": None}, {"a.set": 1000}, measured)
        )
        self.assertEqual(measured, {})

    def test_a_recording_with_no_projection_is_ignored(self):
        measured = {}
        self.assertIsNone(
            note_measurement({"primary": "ghost.set", "peak_rss": 10}, {}, measured)
        )
        self.assertEqual(measured, {})

    def test_a_backstop_trip_still_contributes_a_measurement(self):
        # The recordings that PROVE a format is under-projected are the ones that
        # hit the backstop; excluding them made calibration look cleanest exactly
        # where it was most wrong.
        r = memory_failure_result("a.set", MemoryError("x"), peak_rss=5000)
        measured = {}
        warning = note_measurement(r, {"a.set": 1000}, measured)
        self.assertEqual(measured, {"a.set": 5000})
        self.assertIn("under-reserved", warning)


class TestFactorAffectsAdmission(unittest.TestCase):
    """#1111: the per-format factor must actually change what runs concurrently --
    not merely what `projected_peak_bytes` returns."""

    def test_a_heavier_format_admits_fewer_at_once(self):
        # Below the streaming threshold on purpose: above it both formats get the
        # same flat STREAM_PEAK_BYTES and the factor is not what is being tested.
        size = 100 * 1024**2
        ceiling = 200 * 1024**3

        def admitted(name):
            reserve = admission_reserve_bytes(projected_peak_bytes(name, size), ceiling)
            n, running = 0, 0
            while running + reserve <= ceiling:
                running += reserve
                n += 1
            return n

        heavy = admitted("sub-01_task-x_eeg.vhdr")   # factor 12
        light = admitted("sub-01_task-x_eeg.set")    # factor 6 (default)
        self.assertLess(heavy, light, "the heavier format must self-limit concurrency")
        self.assertGreater(light, 0)


class TestStreamingAdmissionThroughput(unittest.TestCase):
    """#1112: making streaming the default must not make conversion serial."""

    def test_streaming_is_not_charged_in_memory_slack(self):
        # Slack covers the in-memory factor being a guess that runs ~2x low. The
        # streaming projection is the flat bound the two-pass design gives, not a
        # guess of that kind, so tripling it is charging for nothing.
        ceiling = 200 * 1024**3
        proj = STREAM_PEAK_BYTES
        self.assertEqual(admission_reserve_bytes(proj, ceiling, streamed=True), proj)
        self.assertEqual(
            admission_reserve_bytes(proj, ceiling, streamed=False),
            int(proj * MEM_LIMIT_SLACK),
        )

    def test_more_than_one_recording_is_admitted_on_a_realistic_ceiling(self):
        # The regression this guards: with slack applied to the streaming bound,
        # a 4 GiB projection was charged 12 GiB against this node's measured
        # ~19 GiB ceiling, admitting exactly ONE recording at a time under
        # --jobs 24 -- serial conversion of a 1.5 TB dataset.
        ceiling = 19 * 1024**3
        size = int(1.3 * 1000**3)  # a real on004917 recording
        name = "sub-02/eeg/sub-02_task-pdm_eeg.vhdr"
        self.assertTrue(should_stream(name, size))
        reserve = admission_reserve_bytes(
            projected_peak_bytes(name, size), ceiling, streamed=True
        )
        self.assertGreater(
            ceiling // reserve, 1, "streaming the default must not serialize the queue"
        )

    def test_in_memory_recordings_still_carry_slack(self):
        # .set has no streaming route, so its projection is still the guessed
        # multiple and must keep its safety margin.
        ceiling = 200 * 1024**3
        size = 100 * 1024**2
        name = "sub-01/eeg/sub-01_task-x_eeg.set"
        self.assertFalse(should_stream(name, size))
        proj = projected_peak_bytes(name, size)
        self.assertEqual(
            admission_reserve_bytes(proj, ceiling, streamed=False),
            int(proj * MEM_LIMIT_SLACK),
        )

    def test_set_never_streams_at_any_size(self):
        # ADR 0030: two independent blockers (MNE refuses v7.3; an embedded
        # classic .set loads fully even with preload=False). Pinned at sizes well
        # past every threshold so a future tuple edit cannot quietly include it.
        for size in (10 * 1024**2, 512 * 1024**2, 5 * 1024**3, 50 * 1024**3):
            self.assertFalse(
                should_stream("sub-01/eeg/sub-01_task-x_eeg.set", size),
                f".set must not stream at {size} bytes",
            )


class TestThresholdIndependence(unittest.TestCase):
    """#1112 collapsed STREAM_MIN_BYTES and STREAM_KIT_MIN_BYTES to the same
    value. They remain separate, separately-overridable constants feeding separate
    branches, so no black-box probe can tell any more whether BTi reads the right
    one -- a refactor wiring it to KIT's would pass every other test. These pin
    each branch to its own constant by giving them different values."""

    def setUp(self):
        self._saved = (
            generate_zarr.STREAM_MIN_BYTES,
            generate_zarr.STREAM_KIT_MIN_BYTES,
            generate_zarr.STREAM_EDF_MIN_BYTES,
        )
        generate_zarr.STREAM_MIN_BYTES = 100
        generate_zarr.STREAM_KIT_MIN_BYTES = 10_000
        generate_zarr.STREAM_EDF_MIN_BYTES = 1_000_000

    def tearDown(self):
        (
            generate_zarr.STREAM_MIN_BYTES,
            generate_zarr.STREAM_KIT_MIN_BYTES,
            generate_zarr.STREAM_EDF_MIN_BYTES,
        ) = self._saved

    def test_bti_tracks_stream_min_not_the_kit_constant(self):
        bti = "sub-01/meg/sub-01_task-x_meg"  # extension-less: the BTi branch
        self.assertTrue(generate_zarr.should_stream(bti, 200))     # > STREAM_MIN
        self.assertFalse(generate_zarr.should_stream(bti, 50))

    def test_brainvision_tracks_stream_min_not_the_kit_constant(self):
        vhdr = "sub-01/eeg/sub-01_task-x_eeg.vhdr"
        self.assertTrue(generate_zarr.should_stream(vhdr, 200))
        self.assertFalse(generate_zarr.should_stream(vhdr, 50))

    def test_kit_tracks_its_own_constant(self):
        con = "sub-01/meg/sub-01_task-x_meg.con"
        self.assertFalse(generate_zarr.should_stream(con, 200))    # < STREAM_KIT_MIN
        self.assertTrue(generate_zarr.should_stream(con, 20_000))

    def test_edf_tracks_its_own_constant(self):
        # The third constant, and the one this class originally missed: all three
        # default to 256 MiB, so a refactor wiring the EDF branch to
        # STREAM_MIN_BYTES or STREAM_KIT_MIN_BYTES would have passed every test
        # in the file -- exactly the bug shape this class exists to prevent.
        edf = "sub-01/eeg/sub-01_task-x_eeg.edf"
        if not generate_zarr._EDF_STREAMABLE:
            self.skipTest("installed biosigio does not stream EDF")
        self.assertFalse(generate_zarr.should_stream(edf, 200))        # > STREAM_MIN
        self.assertFalse(generate_zarr.should_stream(edf, 20_000))     # > STREAM_KIT_MIN
        self.assertTrue(generate_zarr.should_stream(edf, 2_000_000))   # > STREAM_EDF_MIN

    def test_exact_boundary_is_strictly_greater_than(self):
        vhdr = "sub-01/eeg/sub-01_task-x_eeg.vhdr"
        self.assertFalse(generate_zarr.should_stream(vhdr, 100))   # equal, not >
        self.assertTrue(generate_zarr.should_stream(vhdr, 101))


class TestOn004917BatchAdmission(unittest.TestCase):
    """#1112: the end-to-end concurrency the fix restores, on the real batch."""

    def test_the_real_batch_admits_several_at_once(self):
        # The 24 BrainVision recordings that OOMed the node, at their real sizes,
        # against the ceiling Phase 3 measured there. Before the streamed-slack
        # fix this admitted exactly one at a time.
        sizes = [
            2.246, 1.728, 1.681, 1.577, 1.452, 1.433, 1.407, 1.386, 1.369, 1.361,
            1.350, 1.326, 1.322, 1.318, 1.308, 1.304, 1.295, 1.280, 1.275, 1.261,
            1.254, 1.241, 1.237, 1.181,
        ]
        ceiling = 19 * 1024**3
        reserves = []
        for i, gb in enumerate(sizes):
            name = f"sub-{i:02d}/eeg/sub-{i:02d}_task-pdm_eeg.vhdr"
            size = int(gb * 1000**3)
            self.assertTrue(should_stream(name, size), f"{gb} GB must stream now")
            reserves.append(
                admission_reserve_bytes(
                    projected_peak_bytes(name, size), ceiling, streamed=True
                )
            )

        # Walk the real admission rule over the batch.
        running, admitted = 0, 0
        for r in reserves:
            if running + r > ceiling:
                break
            running += r
            admitted += 1
        self.assertGreater(admitted, 1, "the batch must not convert one at a time")
        self.assertLessEqual(running, ceiling, "and must still respect the ceiling")


class TestMneEmbeddedSetCanary(unittest.TestCase):
    """ADR 0030 rests on MNE eagerly materializing an EEGLAB `.set` whose samples
    are embedded in the MAT struct rather than a sibling `.fdt`. That is a claim
    about a third-party library, verified once by hand; if a future MNE gains real
    lazy support the `.set` exclusion goes stale silently. This is the canary."""

    def test_mne_still_eagerly_loads_embedded_set(self):
        try:
            import inspect

            from mne.io.eeglab.eeglab import RawEEGLAB
        except Exception:  # noqa: BLE001
            self.skipTest("mne not installed (it is lazily imported in production)")
        src = inspect.getsource(RawEEGLAB._read_segment_file)
        self.assertIn("is_embedded", src, "MNE no longer flags embedded .set")
        self.assertIn(
            "preload=True",
            src,
            "MNE may have gained lazy reads for embedded .set -- re-evaluate ADR 0030",
        )


class TestStreamingPeakIsChannelAware(unittest.TestCase):
    """#1112: STREAM_PEAK_BYTES is a FLOOR, not a bound.

    Pass 2 of the streaming exporter materializes one whole channel at native
    rate as anonymous float64 (`n_samples * 8`). That term scales with duration
    and sample rate and is independent of channel count, so a few-channel, long,
    high-rate recording can have a single channel that alone exceeds the flat
    figure -- it would then be admitted as if it cost 4 GiB, trip the RLIMIT set
    to exactly that, and fail.
    """

    SIZE = int(1.3 * 1000**3)

    def test_many_channels_stay_at_the_floor(self):
        # 66 short channels: no single one is anywhere near the floor.
        self.assertEqual(streaming_peak_bytes(self.SIZE, 66), STREAM_PEAK_BYTES)

    def test_a_single_channel_recording_projects_higher(self):
        # All the bytes in one channel: the per-channel term dominates and the
        # flat figure would have been a serious under-projection.
        self.assertGreater(streaming_peak_bytes(self.SIZE, 1), STREAM_PEAK_BYTES)

    def test_the_projection_falls_as_channels_rise(self):
        peaks = [streaming_peak_bytes(self.SIZE, n) for n in (1, 2, 4, 8)]
        self.assertEqual(peaks, sorted(peaks, reverse=True))

    def test_unknown_channel_count_falls_back_to_the_floor(self):
        # channels.tsv unreadable: no worse than before this change.
        self.assertEqual(streaming_peak_bytes(self.SIZE, None), STREAM_PEAK_BYTES)
        self.assertEqual(streaming_peak_bytes(self.SIZE, 0), STREAM_PEAK_BYTES)

    def test_projected_peak_bytes_threads_the_channel_count(self):
        name = "sub-01/emg/sub-01_task-x_emg.vhdr"
        self.assertTrue(should_stream(name, self.SIZE))
        self.assertGreater(
            projected_peak_bytes(name, self.SIZE, 1),
            projected_peak_bytes(name, self.SIZE, 66),
        )

    def test_the_in_memory_path_ignores_channel_count(self):
        # .set never streams, so its projection is the on-disk factor regardless.
        name = "sub-01/eeg/sub-01_task-x_eeg.set"
        self.assertEqual(
            projected_peak_bytes(name, 100 * 1024**2, 1),
            projected_peak_bytes(name, 100 * 1024**2, 66),
        )

def build_real_edf(directory: str, stem: str, n_channels: int = 4,
                   rate: int = 200, seconds: int = 60) -> str:
    """Write a REAL, spec-compliant EDF+ with pyedflib and return its path.

    Not a fixture file in the repo, and not a stub: `test/fixtures/bids-minimal`'s
    `.edf` is a 1 KB placeholder that pyedflib refuses to open ("the label is
    incorrect"), so it cannot exercise a conversion at all. This writes one with
    the same library biosigIO's importer reads it back with, so everything
    downstream -- the importer, the resampler, the Zarr writer, the attrs this
    module then republishes -- is the real code on real samples. 60 s at 200 Hz is
    the smallest size that still produces a multi-level view pyramid, which is
    what the geometry assertions need.
    """
    import numpy as np
    import pyedflib

    path = os.path.join(directory, f"{stem}.edf")
    writer = pyedflib.EdfWriter(path, n_channels, file_type=pyedflib.FILETYPE_EDFPLUS)
    writer.setSignalHeaders([
        {
            "label": f"E{i + 1}",
            "dimension": "uV",
            "sample_frequency": rate,
            "physical_max": 500.0,
            "physical_min": -500.0,
            "digital_max": 32767,
            "digital_min": -32768,
            "transducer": "",
            "prefilter": "",
        }
        for i in range(n_channels)
    ])
    rng = np.random.default_rng(0)
    writer.writeSamples([rng.normal(0, 20, rate * seconds) for _ in range(n_channels)])
    writer.close()
    return path


# A small Neuromag-shaped channel set: MEG sensors, one EEG, one trigger line.
FIF_CHANNELS = (
    ("MEG0111", "mag"), ("MEG0112", "grad"), ("MEG0113", "grad"),
    ("EEG001", "eeg"), ("STI101", "stim"),
)


def build_real_fif(path: str, rate: float = 250.0, seconds: int = 10, **save_kwargs) -> str:
    """Write a REAL FIF with MNE (`RawArray(...).save`) and return its path.

    MNE is the reader biosigIO uses for FIF, so the header written here is the
    header both the converter and `file_declared_channel_count` read back."""
    import mne
    import numpy as np

    names = [n for n, _ in FIF_CHANNELS]
    types = [t for _, t in FIF_CHANNELS]
    info = mne.create_info(names, rate, types)
    data = np.random.default_rng(0).normal(0, 1e-12, (len(names), int(rate * seconds)))
    mne.io.RawArray(data, info, verbose="ERROR").save(path, verbose="ERROR", **save_kwargs)
    return path


def _have_mne() -> bool:
    try:
        import mne  # noqa: F401
    except ImportError:
        return False
    return True


# --- real recordings ----------------------------------------------------------
# A handful of assertions can only be made against an actual archived recording:
# the resampling relation `sample_index` rests on is a property of biosigIO plus
# a real acquisition rate, and a hand-built fixture at the SERVING rate would
# never exercise it (#1060 names nm000329 for exactly this reason).
#
# Downloads are cached OUTSIDE the repository -- nothing to commit, and one
# download per host rather than one per worktree -- and every failure path skips
# rather than fails: these tests need the network, and a flaky connection must
# not turn a converter change red. Mirrors biosigio's own
# `biosigio/tests/real_data.py`, with `unittest.SkipTest` in place of
# `pytest.skip` so `python test_generate_zarr.py` behaves the same as pytest.
REAL_DATA_CACHE_ENV = "NEMAR_ZARR_REAL_DATA_CACHE"
REAL_DATA_SKIP_ENV = "NEMAR_ZARR_SKIP_REAL_DATA"
_REAL_DATA_DEFAULT_CACHE = os.path.join(
    os.path.expanduser("~"), ".cache", "nemar-zarr-tests", "real_data"
)
# data.nemar.org resets the connection for urllib's default `Python-urllib/x.y`
# User-Agent (a generic anti-bot header check -- any other string clears it).
_REAL_DATA_USER_AGENT = (
    "nemar-cli-zarr-tests/1.0 (+https://github.com/nemarOrg/nemar-cli)"
)


def fetch_real_file(url: str, *, min_bytes: int = 1) -> str:
    """Local path to `url`, downloading it into the shared cache on first use.

    Raises `unittest.SkipTest` (never fails) when the download is unavailable or
    opted out of. URLs must be VERSIONED (`/nm000329/v1.0.7/...`): the point of a
    real-data assertion is that it is made against known bytes, and `latest`
    would silently change what was verified.
    """
    if os.environ.get(REAL_DATA_SKIP_ENV):
        raise unittest.SkipTest(
            f"real-data test skipped: {REAL_DATA_SKIP_ENV} is set"
        )
    cache = os.environ.get(REAL_DATA_CACHE_ENV) or _REAL_DATA_DEFAULT_CACHE
    os.makedirs(cache, exist_ok=True)
    dest = os.path.join(cache, url.rsplit("/", 1)[-1])
    if os.path.exists(dest) and os.path.getsize(dest) >= min_bytes:
        return dest
    import urllib.error
    import urllib.request

    part = dest + ".part"
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": _REAL_DATA_USER_AGENT}
        )
        with urllib.request.urlopen(request, timeout=30) as resp, open(part, "wb") as fh:
            shutil.copyfileobj(resp, fh, 4 * 1024 * 1024)
        os.replace(part, dest)
    except Exception as exc:  # noqa: BLE001 - offline is a skip, never a failure
        with contextlib.suppress(OSError):
            os.unlink(part)
        raise unittest.SkipTest(f"real-data test skipped: could not fetch {url} ({exc})")
    if os.path.getsize(dest) < min_bytes:
        os.unlink(dest)
        raise unittest.SkipTest(f"real-data test skipped: {url} looked truncated")
    return dest


class TestSampleIndexAgainstARealRateChange(unittest.TestCase):
    """#1060's acceptance criterion: `sample_index` verified to within one sample
    on a dataset that actually changes rate (nm000329, 1000 Hz -> 250 Hz).

    A recording built at the serving rate cannot check this at all -- the whole
    class of error the column exists to remove only appears when the source and
    target rates differ. Three independent checks, none of which re-uses the
    formula under test:

    1. The store's own geometry: level-0 `n_samples` is `round(n_native *
       target / native)`, i.e. the grid really is `t[n] = n / rate`.
    2. No filter delay: the served signal correlates with the NATIVE samples
       taken at the same absolute times, peaking at lag 0. `resample_poly` is
       zero-phase, and this is what proves it for the exporter we ship.
    3. The dataset's own `sample` column (onsets in native samples, written by
       whoever curated it) scaled to the serving rate.
    """

    VERSION = "v1.0.7"
    STEM = "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0"
    BASE = "https://data.nemar.org/nm000329"
    NATIVE_RATE = 1000.0
    SERVING_RATE = 250.0

    @classmethod
    def setUpClass(cls):
        try:
            import numpy  # noqa: F401
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        cls.recording = fetch_real_file(
            f"{cls.BASE}/{cls.VERSION}/{cls.STEM}_eeg.bdf", min_bytes=100_000_000
        )
        cls.events = fetch_real_file(f"{cls.BASE}/{cls.VERSION}/{cls.STEM}_events.tsv")
        cls._tmp = tempfile.TemporaryDirectory()
        cls.store = os.path.join(cls._tmp.name, "real.zarr")
        # The real converter entry point on the real bytes: same call
        # `convert_one` makes.
        convert_recording(cls.recording, cls.events, cls.store)
        cls.meta = store_metadata(cls.store)
        cls.group = cls.meta["groups"][0]
        with open(cls.events, encoding="utf-8") as fh:
            cls.parsed = parse_events_tsv(fh.read())
        cls.rows = event_rows_for_store(
            "sub-1/ses-0/eeg/x_eeg.zarr", f"{cls.STEM}_eeg.bdf",
            cls.meta["groups"], cls.parsed,
        )

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "_tmp"):
            cls._tmp.cleanup()

    def native_samples(self):
        """(labels, n_samples, first-channel signal) straight from the BDF."""
        import pyedflib

        reader = pyedflib.EdfReader(self.recording)
        try:
            labels = reader.getSignalLabels()
            n = int(reader.getNSamples()[0])
            return labels, n, reader
        except Exception:
            reader.close()
            raise

    def test_the_dataset_really_changes_rate(self):
        # Guard the premise: if the archive ever re-published this at 250 Hz,
        # every assertion below would pass while checking nothing.
        self.assertEqual(self.group["source_rate_hz"], self.NATIVE_RATE)
        self.assertEqual(self.group["rate"], self.SERVING_RATE)

    def test_level_zero_is_the_nominal_grid_over_the_same_span(self):
        _labels, n_native, reader = self.native_samples()
        try:
            self.assertGreater(n_native, 0)
        finally:
            reader.close()
        expected = round(n_native * self.SERVING_RATE / self.NATIVE_RATE)
        self.assertEqual(self.group["n_samples"], expected)
        # ...so sample n is at t = n / rate, which is what the formula assumes.
        self.assertAlmostEqual(
            self.group["duration_s"], n_native / self.NATIVE_RATE, places=3
        )

    def test_the_served_signal_carries_no_filter_delay(self):
        """If `resample_poly` left its FIR group delay in, every sample index
        would be off by that delay and the column would be confidently wrong.

        Compared against the NATIVE samples at the same absolute times
        (1000 -> 250 is an exact 4, so `native[::4]` is the zero-phase reference
        and no resampler is involved in the reference at all).
        """
        import numpy as np
        import zarr

        root = zarr.open_group(self.store, mode="r")
        group = root[self.group["name"]]
        label = dict(group.attrs)["channels"][0]["label"]
        served = np.asarray(group["0"][0, :], dtype=np.float64)

        labels, _n, reader = self.native_samples()
        try:
            self.assertIn(label, labels, "store channel is not a native channel")
            native = reader.readSignal(labels.index(label)).astype(np.float64)
        finally:
            reader.close()

        step = int(self.NATIVE_RATE // self.SERVING_RATE)
        reference = native[::step]
        n = min(len(served), len(reference)) - 20
        a = served[10 : 10 + n] - served[10 : 10 + n].mean()
        b = reference[10 : 10 + n] - reference[10 : 10 + n].mean()
        lags = range(-8, 9)
        scores = {
            lag: float(np.dot(a, np.roll(b, lag)) / (np.linalg.norm(a) * np.linalg.norm(b)))
            for lag in lags
        }
        best = max(scores, key=scores.get)
        self.assertGreater(
            scores[0], 0.9,
            "the served channel does not track the native one at all -- the "
            f"channel mapping is wrong, not the delay (r={scores[0]:.3f})",
        )
        self.assertEqual(
            best, 0,
            f"served level 0 lags the native grid by {best} sample(s); "
            "sample_index would be off by the same amount",
        )

    def test_every_onset_lands_on_the_grid_within_one_sample(self):
        """The acceptance criterion, checked against the grid itself rather than
        against the formula: the level-0 timestamps are `n / rate`, and the
        published index must be the nearest of them.

        Measured on this recording: 72 events, worst disagreement 1 sample, and
        every one of those is an exact TIE -- the onset sits exactly half a
        sample (0.002 s at 250 Hz) between two level-0 samples, e.g. 39.302 s ->
        9825.5. The published rule takes the later sample and `argmin` takes the
        earlier; neither is more correct, and no rule can do better than one
        sample there. On every event that is not a tie the two agree exactly,
        which is the assertion that would break if the formula drifted.
        """
        import numpy as np

        rate = self.group["rate"]
        grid = np.arange(self.group["n_samples"], dtype=np.float64) / rate
        self.assertGreater(len(self.rows["onset_s"]), 50, "fixture lost its events")
        ties = 0
        for onset, published in zip(self.rows["onset_s"], self.rows["sample_index"]):
            nearest = int(np.argmin(np.abs(grid - onset)))
            delta = abs(published - nearest)
            self.assertLessEqual(
                delta, 1, f"onset {onset} published {published}, grid says {nearest}"
            )
            if delta == 0:
                continue
            ties += 1
            # The only licensed disagreement: equidistant from both samples.
            self.assertAlmostEqual(
                abs(grid[published] - onset), abs(grid[nearest] - onset), places=9,
                msg=f"onset {onset} is off by a sample and is NOT a tie",
            )
        # The fixture has to contain some, or the tie branch above is untested
        # and this test is weaker than it reads.
        self.assertGreater(ties, 0)

    def test_the_datasets_own_native_sample_column_agrees(self):
        """nm000329's events.tsv carries a `sample` column in NATIVE samples,
        written by whoever curated the dataset. It is the one ground truth here
        that owes nothing to this converter -- and it agrees to within one
        sample, disagreeing only on the same ties (a native sample number
        divided by 4 lands on x.5 for exactly those events)."""
        self.assertIn("sample", self.rows, "fixture lost its `sample` column")
        ratio = self.SERVING_RATE / self.NATIVE_RATE
        for native, published in zip(self.rows["sample"], self.rows["sample_index"]):
            scaled = int(native) * ratio
            self.assertLessEqual(
                abs(published - round(scaled)), 1,
                f"curated sample {native} -> {scaled}, published {published}",
            )
            if published != round(scaled):
                self.assertAlmostEqual(scaled % 1, 0.5, places=9)


class TestSampleIndexOnANonIntegerRateRatio(unittest.TestCase):
    """512 Hz -> 250 Hz: the ratio is 125/256, so there is no whole-sample
    relationship between the source and serving grids at all.

    Synthetic on purpose, and the comment matters: nm000329 (the real-data check
    above) is an exact 4, so it CANNOT distinguish a formula that quietly assumes
    an integer decimation from one that does not. Nothing in the archive was
    handy at a fractional ratio, so this fixture is the only thing standing
    between that assumption and a silently mis-aligned file. The recording is a
    real EDF written by pyedflib and converted by the real exporter -- only the
    samples are synthetic.
    """

    RATE = 512
    SERVING_RATE = 250.0
    SECONDS = 20
    ONSETS = [0.0, 0.001, 1.003, 7.777, 12.5, 19.999]

    @classmethod
    def setUpClass(cls):
        try:
            import numpy  # noqa: F401
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        cls._tmp = tempfile.TemporaryDirectory()
        d = cls._tmp.name
        cls.recording = build_real_edf(
            d, "sub-01_task-x_eeg", n_channels=3, rate=cls.RATE, seconds=cls.SECONDS
        )
        cls.events = os.path.join(d, "sub-01_task-x_events.tsv")
        with open(cls.events, "w") as fh:
            fh.writelines(
                ["onset\tduration\ttrial_type\n"]
                + [f"{onset}\t0.1\tgo\n" for onset in cls.ONSETS]
            )
        cls.store = os.path.join(d, "out.zarr")
        convert_recording(cls.recording, cls.events, cls.store)
        cls.meta = store_metadata(cls.store)
        cls.group = cls.meta["groups"][0]
        with open(cls.events) as fh:
            cls.rows = event_rows_for_store(
                "sub-01/eeg/x_eeg.zarr", "sub-01/eeg/sub-01_task-x_eeg.edf",
                cls.meta["groups"], parse_events_tsv(fh.read()),
            )

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_the_ratio_really_is_fractional(self):
        self.assertEqual(self.group["source_rate_hz"], float(self.RATE))
        self.assertEqual(self.group["rate"], self.SERVING_RATE)
        self.assertNotEqual((self.RATE / self.SERVING_RATE) % 1, 0.0)

    def test_level_zero_length_follows_the_rate_ratio(self):
        n_native = self.RATE * self.SECONDS
        self.assertEqual(
            self.group["n_samples"], round(n_native * self.SERVING_RATE / self.RATE)
        )

    def test_every_onset_lands_on_the_grid_within_one_sample(self):
        import numpy as np

        grid = np.arange(self.group["n_samples"], dtype=np.float64) / self.group["rate"]
        for onset, published in zip(self.rows["onset_s"], self.rows["sample_index"]):
            nearest = int(np.argmin(np.abs(grid - onset)))
            self.assertLessEqual(
                abs(published - nearest), 1,
                f"onset {onset} published as {published}, grid says {nearest}",
            )

    def test_the_acquisition_rate_is_the_wrong_rate_to_index_with(self):
        """The error the column exists to remove. A client reading the BIDS
        sidecar sees 512 Hz and computes `onset * 512`; level 0 is 250 Hz, so
        that index is roughly twice as far along the array as the event -- and
        for most of this recording it is off the end of it entirely. The index
        publishes the SERVING rate per group precisely so that guess is never
        needed."""
        n_samples = self.group["n_samples"]
        wrong = [round(onset * self.RATE) for onset in self.ONSETS]
        published = list(self.rows["sample_index"])
        self.assertNotEqual(wrong, published)
        # ...and it is not a rounding-scale disagreement, it is a different array
        # position: the last onset indexes past the end of level 0.
        self.assertGreater(wrong[-1], n_samples)
        self.assertLessEqual(published[-1], n_samples)

    def test_deriving_the_index_from_the_native_sample_number_disagrees(self):
        """The sub-sample error #1060 names. A client that rounds the onset to a
        NATIVE sample first and scales that -- what the BIDS `sample` column
        invites -- rounds twice, and on a fractional ratio the two roundings
        disagree wherever the true position sits within a quarter sample of a
        tie. It is bounded by one sample, which is exactly why nobody notices it
        without a column to compare against."""
        ratio = self.SERVING_RATE / self.RATE
        onset = 0.086  # 21.5 level-0 samples: the tie band
        published = sample_index_for(onset, self.SERVING_RATE)
        two_step = round(round(onset * self.RATE) * ratio)
        self.assertEqual(published, 22)
        self.assertEqual(two_step, 21)


class TestSourceTree(unittest.TestCase):
    def test_raw_is_the_default(self):
        self.assertEqual(source_tree_for("sub-01/eeg/sub-01_task-x_eeg.set"), "raw")

    def test_names_the_excluded_tree_it_sits_under(self):
        self.assertEqual(
            source_tree_for("derivatives/prep/sub-01/eeg/sub-01_eeg.set"), "derivatives"
        )
        self.assertEqual(source_tree_for("sourcedata/sub-01/eeg/x_eeg.set"), "sourcedata")
        self.assertEqual(source_tree_for("code/x_eeg.set"), "code")

    def test_segment_boundary_is_respected(self):
        # `mycode/` and `derivatives_old/` are ordinary directories, matching
        # in_excluded_tree's own rule.
        self.assertEqual(source_tree_for("mycode/sub-01_eeg.set"), "raw")
        self.assertEqual(source_tree_for("derivatives_old/sub-01_eeg.set"), "raw")


class TestFailureDetail(unittest.TestCase):
    """`detail` is the field that makes an opaque `file_read_error` diagnosable
    from the published index (#1197). It must name the exception and keep the
    message while dropping the conversion node's scratch paths, which are a fresh
    mkdtemp name every run."""

    def test_names_the_exception_class_and_first_line(self):
        detail = failure_detail(ValueError("could not find measurement data\nsecond line"))
        self.assertEqual(detail, "ValueError: could not find measurement data")

    def test_strips_absolute_paths(self):
        exc = OSError(
            "/mnt/local/zarr-scratch/tmpab12/work/sub-01_eeg.edf: the file is not "
            "EDF(+) or BDF(+) compliant the label is incorrect"
        )
        detail = failure_detail(exc)
        self.assertNotIn("/mnt/local", detail)
        self.assertIn("<path>", detail)
        # The diagnosis itself survives -- that is the whole point of the field.
        self.assertIn("not EDF(+) or BDF(+) compliant", detail)

    def test_leaves_non_path_slashes_alone(self):
        self.assertEqual(strip_local_paths("min/max envelope"), "min/max envelope")

    def test_accepts_a_bare_string_for_a_synthesized_failure(self):
        # A worker killed while running alone has no exception to report.
        self.assertEqual(failure_detail("killed its worker process"),
                         "killed its worker process")

    def test_length_capped(self):
        self.assertLessEqual(len(failure_detail(ValueError("x" * 5000))), 300)

    def test_strips_windows_paths(self):
        # MNE formats paths out of a recording's own header, so a Windows path
        # can reach a Linux conversion node's error message.
        detail = failure_detail(
            OSError(r"C:\Users\hallu\scratch\sub-01_eeg.edf is not EDF(+) compliant")
        )
        self.assertNotIn("Users", detail)
        self.assertIn("<path>", detail)
        self.assertIn("not EDF(+) compliant", detail)


class TestDetailRedaction(unittest.TestCase):
    """`detail` and `last_error` are published in index.json on a PUBLIC bucket,
    and the driver shells out to `aws` and reads HTTP -- so an exception message
    can quote a presigned URL, a request header, or a key id. Path stripping does
    not cover any of that; none of them is a filesystem path.

    Each case is a real message shape (AWS error text, a curl failure), and each
    asserts BOTH halves: the secret is gone and the diagnosis survives. A
    redactor that returned a constant would pass the first half alone.
    """

    def assert_redacted(self, message: str, secret: str, keep: str = ""):
        detail = failure_detail(RuntimeError(message))
        self.assertNotIn(secret, detail, f"secret survived in {detail!r}")
        self.assertIn("[redacted]", detail)
        if keep:
            self.assertIn(keep, detail, f"diagnosis lost from {detail!r}")

    def test_authorization_header(self):
        self.assert_redacted(
            "PUT failed with Authorization: AWS4-HMAC-SHA256 SignedHeaders=host",
            "AWS4-HMAC-SHA256",
            keep="PUT failed",
        )

    def test_bearer_token(self):
        self.assert_redacted(
            "callback rejected: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
            "eyJhbGciOiJIUzI1NiJ9",
            keep="callback rejected",
        )

    def test_x_amz_query_parameters(self):
        # A presigned URL is the realistic leak: `aws s3 cp` quotes the whole
        # request line on a 403.
        self.assert_redacted(
            "403 for https://nemar.s3.us-east-2.amazonaws.com/k?X-Amz-Signature=deadbeefcafe0123",
            "deadbeefcafe0123",
            keep="403",
        )

    def test_x_amz_credential_is_covered_by_the_prefix_rule(self):
        self.assert_redacted(
            "denied: https://h/k?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260902",
            "AKIAIOSFODNN7EXAMPLE",
            keep="denied",
        )

    def test_signature_field(self):
        self.assert_redacted(
            "SignatureDoesNotMatch signature: abc123def456+/=",
            "abc123def456",
            keep="SignatureDoesNotMatch",
        )

    def test_bare_access_key_id(self):
        # AWS error text quotes the key id with no URL around it.
        self.assert_redacted(
            "The AWS Access Key Id AKIAIOSFODNN7EXAMPLE does not exist in our records",
            "AKIAIOSFODNN7EXAMPLE",
            keep="does not exist in our records",
        )

    def test_sts_session_key_id(self):
        # ASIA is the form the Hallu profile's session credentials actually take.
        self.assert_redacted(
            "expired token for ASIAY34FZKBOKMUTVV7A",
            "ASIAY34FZKBOKMUTVV7A",
            keep="expired token",
        )

    def test_token_query_parameter(self):
        self.assert_redacted(
            "POST https://api.nemar.org/webhooks/zarr-ready?token=s3cr3tvalue -> 401",
            "s3cr3tvalue",
            keep="401",
        )

    def test_key_query_parameter(self):
        self.assert_redacted("GET https://h/p?key=abc123secret", "abc123secret")

    def test_a_url_shaped_message_keeps_its_diagnosis(self):
        # #1197's whole point: an operator must still be able to tell WHAT failed.
        detail = failure_detail(
            RuntimeError("HTTP 503 from https://nemar.s3.us-east-2.amazonaws.com/a/b.edf")
        )
        self.assertIn("HTTP 503", detail)

    def test_an_innocent_message_is_left_alone(self):
        """A redactor that fired on ordinary text would destroy every diagnosis.

        The false-positive risk is real and specific here: BIDS filenames and
        column names routinely contain the very words the patterns key on, and
        the words alone must never be enough -- only the `?name=value` and
        `Header: value` SHAPES are. A redactor that ate `primary_key.csv` would
        make a corrupt-file report unreadable while leaking nothing.
        """
        for clean in (
            "Could not find measurement data",
            "channels.tsv declares 74 channels but the store has 1",
            "min/max envelope mismatch",
            # "token"/"key" inside BIDS entities and filenames.
            "sub-01_task-tokenTask_eeg.edf is not EDF(+) compliant",
            "sub-02_task-keypress_run-1_eeg.vhdr: header missing",
            "primary_key.csv could not be parsed",
            "no key column found in participants.tsv",
            "token count mismatch in the events sidecar",
            # A bare `key=` with no query string around it is a log field, not a
            # secret -- the patterns require the `?`/`&` that makes it a URL.
            "reader reported key=value for channel E1",
            # And the words as ordinary prose.
            "the signature of read_raw_edf changed upstream",
            "authorization to publish this dataset is pending",
        ):
            with self.subTest(message=clean):
                self.assertEqual(redact_secrets(clean), clean)
                self.assertNotIn("[redacted]", failure_detail(RuntimeError(clean)))

    def test_redaction_survives_the_length_cap(self):
        # Cap applied AFTER redaction, so truncation can never expose a tail.
        detail = failure_detail(
            RuntimeError("x" * 250 + " Bearer supersecrettokenvalue0123456789")
        )
        self.assertNotIn("supersecrettokenvalue", detail)
        self.assertLessEqual(len(detail), 300)

    def test_empty_is_none(self):
        self.assertIsNone(failure_detail(None))


class TestEventsSummary(unittest.TestCase):
    """`n_events` / `trial_types` let a client judge a dataset, and pick an
    epoching strategy, without reading a signal byte (#1059)."""

    def test_counts_rows_and_trial_types(self):
        text = (
            "onset\tduration\ttrial_type\n"
            "0.0\t0.5\tgo\n"
            "1.0\t0.5\tstop\n"
            "2.0\t0.5\tgo\n"
        )
        self.assertEqual(
            events_summary(text), {"n_events": 3, "trial_types": {"go": 2, "stop": 1}}
        )

    def test_no_events_file_omits_both_keys(self):
        # Absent keys mean "no events.tsv", which is not the same claim as
        # "an events.tsv with no trial types".
        self.assertEqual(events_summary(None), {})

    def test_no_trial_type_column_is_an_empty_object(self):
        self.assertEqual(
            events_summary("onset\tduration\n0.0\t0.5\n"),
            {"n_events": 1, "trial_types": {}},
        )

    def test_na_values_are_not_counted(self):
        text = "onset\ttrial_type\n0.0\tn/a\n1.0\t\n2.0\tgo\n"
        self.assertEqual(events_summary(text)["trial_types"], {"go": 1})
        self.assertEqual(events_summary(text)["n_events"], 3)

    # nm000229 (MEG-MASC) writes the whole stringified row into `trial_type` for
    # some recordings, so each of their events is a distinct value of about 280
    # characters.
    @staticmethod
    def _record_value(start: float, phoneme: str = "l_B") -> str:
        return (
            "{'story': 'easy_money', 'story_uid': 2.0, 'sound_id': 2.0, "
            f"'kind': 'phoneme', 'start': {start}, "
            "'sound': 'stimuli/audio/easy_money_2.wav', "
            f"'phoneme': '{phoneme}', 'sequence_id': 81.0, 'condition': 'sentence', "
            "'word_index': 6.0, 'speech_rate': 190.0, 'voice': 'Samantha', "
            "'pronounced': 1.0}"
        )

    # Two distinct values of 155 characters that share their first 13 characters
    # and the first 14 hex digits of their SHA-256, so their digest keys collide.
    # Found by a birthday search (Brent cycle detection over 14 hex digits, about
    # 2**28 hashes). Both digests were checked with
    #   printf '%s' "$VALUE" | shasum -a 256        -> 10544c804e6d2b...
    # They sort in this order: COLLIDING_FIRST is the smaller string.
    COLLIDING_FIRST = (
        "{'story': 'ea0a86d8243e315d', 'kind': 'phoneme', "
        "'sound': 'stimuli/audio/easy_money_2.wav', 'phoneme': 'l_B', "
        "'sequence_id': 81.0, 'condition': 'sentence'}"
    )
    COLLIDING_SECOND = (
        "{'story': 'ea955d4fad05eec6', 'kind': 'phoneme', "
        "'sound': 'stimuli/audio/easy_money_2.wav', 'phoneme': 'l_B', "
        "'sequence_id': 81.0, 'condition': 'sentence'}"
    )

    def test_the_published_limits_are_pinned(self):
        # Clients hard-code these two numbers: they are part of the index contract.
        self.assertEqual(TRIAL_TYPE_KEY_MAX, 128)
        self.assertEqual(TRIAL_TYPE_DIGEST_KEY_LEN, 28)

    def test_a_value_that_fits_is_its_own_key(self):
        exact = "x" * 128
        # The value is measured after stripping, so trailing spaces do not push it over.
        text = (
            f"onset\ttrial_type\n0.0\tgo\n1.0\t{exact}\n2.0\tgo\n3.0\t{exact}   \n"
        )
        self.assertEqual(events_summary(text)["trial_types"], {"go": 2, exact: 2})

    def test_a_value_one_over_the_limit_gets_a_28_character_key(self):
        value = "x" * 129
        text = "onset\ttrial_type\n" + "".join(
            f"{i}.0\t{value}\n" for i in range(4)
        ) + "9.0\tgo\n"
        summary = events_summary(text)
        # printf 'x%.0s' $(seq 1 129) | shasum -a 256   -> 0ec9eb33e74510...
        self.assertEqual(
            summary["trial_types"], {"go": 1, "xxxxxxxxxxxxx~0ec9eb33e74510": 4}
        )
        self.assertEqual(summary["n_events"], 5)
        self.assertEqual(len("xxxxxxxxxxxxx~0ec9eb33e74510"), TRIAL_TYPE_DIGEST_KEY_LEN)

    def test_an_ordinary_label_stays_readable(self):
        """The longest label key among the other published datasets is 104
        characters (a slash-joined condition string). The limit is chosen so that
        none of them becomes an opaque digest."""
        label = (
            "SequenceID_4/RunNumber_1/StimPosition_1/StimType_target/"
            "Response_hit/Block_3/Trial_017/Cue_left/Fbk_none"
        )
        self.assertEqual(len(label), 104)
        text = f"onset\ttrial_type\n0.0\t{label}\n1.0\t{label}\n"
        self.assertEqual(events_summary(text)["trial_types"], {label: 2})

    def test_the_limit_counts_code_points_not_bytes(self):
        fits = "\u00e9" * 128  # 256 UTF-8 bytes, 128 code points
        over = "\u00e9" * 129
        text = f"onset\ttrial_type\n0.0\t{fits}\n1.0\t{over}\n"
        # printf '\xc3\xa9%.0s' $(seq 1 129) | shasum -a 256   -> a62bf20794e9af...
        self.assertEqual(
            events_summary(text)["trial_types"],
            {fits: 1, "\u00e9" * 13 + "~a62bf20794e9af": 1},
        )

    def test_the_limit_counts_code_points_not_utf16_units(self):
        fits = "\U0001f600" * 128  # 128 code points, 256 UTF-16 units, 512 bytes
        over = "\U0001f600" * 129
        text = f"onset\ttrial_type\n0.0\t{fits}\n1.0\t{over}\n"
        # for i in $(seq 1 129); do printf '\xf0\x9f\x98\x80'; done | shasum -a 256
        #   -> f1725ce917cd79...
        self.assertEqual(
            events_summary(text)["trial_types"],
            {fits: 1, "\U0001f600" * 13 + "~f1725ce917cd79": 1},
        )

    def test_the_prefix_counts_code_points_and_the_digest_is_over_utf8(self):
        value = "a\U0001f600bcdefghijkl" + "z" * 120  # 133 code points, 4-byte emoji first
        # { printf 'a\xf0\x9f\x98\x80bcdefghijkl'; printf 'z%.0s' $(seq 1 120); } \
        #   | shasum -a 256   -> 1bac5ee4c59300...
        self.assertEqual(trial_type_key(value), "a\U0001f600bcdefghijkl~1bac5ee4c59300")

    def test_composed_and_decomposed_forms_are_not_normalized(self):
        composed = "caf\u00e9" + "x" * 125  # 129 code points
        decomposed = "cafe\u0301" + "x" * 125  # 130 code points
        text = f"onset\ttrial_type\n0.0\t{composed}\n1.0\t{decomposed}\n"
        # { printf 'caf\xc3\xa9'; printf 'x%.0s' $(seq 1 125); } | shasum -a 256 -> 228391f0830f3a
        # { printf 'cafe\xcc\x81'; printf 'x%.0s' $(seq 1 125); } | shasum -a 256 -> 6c5a9fb1a4e1e6
        self.assertEqual(
            events_summary(text)["trial_types"],
            {
                composed[:13] + "~228391f0830f3a": 1,
                decomposed[:13] + "~6c5a9fb1a4e1e6": 1,
            },
        )

    def test_a_whole_record_value_gets_a_28_character_key_and_keeps_its_count(self):
        value = self._record_value(93.72)
        self.assertEqual(len(value), 281)
        text = "onset\ttrial_type\n" + "".join(
            f"{i}.0\t{value}\n" for i in range(4)
        ) + "9.0\tgo\n"
        summary = events_summary(text)
        # sha256 of exactly these 281 bytes, from a file, with shasum -a 256
        # -> 97ecccec881a7c... (the value has an uppercase letter, so a digest of
        # the lowercased value would differ).
        self.assertEqual(
            summary["trial_types"], {"go": 1, "{'story': 'ea~97ecccec881a7c": 4}
        )
        self.assertEqual(summary["n_events"], 5)

    def test_blank_and_na_values_are_not_counted_and_an_empty_key_is_kept_if_given(self):
        text = "onset\ttrial_type\n0.0\t\n1.0\tn/a\n2.0\tgo\n"
        self.assertEqual(
            events_summary(text), {"n_events": 3, "trial_types": {"go": 1}}
        )
        # A direct call is not an events.tsv: an empty key is left as it is.
        self.assertEqual(shorten_trial_types({"": 2}), {"": 2})

    def test_records_that_share_a_prefix_stay_distinct(self):
        """The nm000229 shape: about 280 characters, identical up to the onset
        field, and different only by an onset or a phoneme. Every one keeps its
        own key and every count survives."""
        values = [self._record_value(93.0 + i / 100) for i in range(500)]
        values += [self._record_value(10.0, ph) for ph in ("l_B", "ah_I", "t_E")]
        text = "onset\ttrial_type\n" + "".join(f"{i}\t{v}\n" for i, v in enumerate(values))
        summary = events_summary(text)
        keys = list(summary["trial_types"])
        self.assertEqual(len(keys), len(values))
        self.assertTrue(
            all(len(k) == TRIAL_TYPE_DIGEST_KEY_LEN for k in keys), set(map(len, keys))
        )
        self.assertEqual(sum(summary["trial_types"].values()), len(values))
        self.assertEqual(summary["n_events"], len(values))
        # The published entry costs a fraction of what the raw keys did.
        raw = len(json.dumps(dict.fromkeys(values, 1)))
        self.assertLess(len(json.dumps(summary["trial_types"])) * 5, raw)

    def test_a_repeated_long_value_is_still_one_key(self):
        value = self._record_value(1.5)
        text = (
            "onset\ttrial_type\n"
            f"0.0\t{value}\n1.0\t{self._record_value(2.5)}\n2.0\t{value}\n"
        )
        counts = sorted(events_summary(text)["trial_types"].values())
        self.assertEqual(counts, [1, 2])

    def test_the_colliding_pair_really_collides(self):
        first, second = self.COLLIDING_FIRST, self.COLLIDING_SECOND
        self.assertLess(first, second)
        self.assertNotEqual(first, second)
        self.assertGreater(len(first), TRIAL_TYPE_KEY_MAX)
        self.assertEqual(len(first), len(second))
        self.assertEqual(trial_type_key(first), "{'story': 'ea~10544c804e6d2b")
        self.assertEqual(trial_type_key(second), "{'story': 'ea~10544c804e6d2b")

    def test_a_real_collision_is_resolved_the_same_way_in_either_arrival_order(self):
        first, second = self.COLLIDING_FIRST, self.COLLIDING_SECOND
        forward = shorten_trial_types({first: 3, second: 5})
        backward = shorten_trial_types({second: 5, first: 3})
        self.assertEqual(forward, backward)
        # The value that sorts first keeps the digest key; the other is salted:
        # printf '1\0%s' "$SECOND" | shasum -a 256   -> 4000e57045d764...
        self.assertEqual(
            forward, {"{'story': 'ea~10544c804e6d2b": 3, "{'story': 'ea~4000e57045d764": 5}
        )
        self.assertEqual(sum(forward.values()), 8)
        self.assertEqual(list(forward), sorted(forward))

    def test_shortening_is_idempotent(self):
        once = shorten_trial_types(
            {self._record_value(i): 1 for i in range(30)}
            | {"go": 5, self.COLLIDING_FIRST: 2, self.COLLIDING_SECOND: 4}
        )
        self.assertEqual(shorten_trial_types(once), once)

    def test_the_result_is_sorted_by_key_so_the_index_bytes_are_stable(self):
        """Short values are added first and long ones after, so insertion order
        is not key order: a short key that sorts after a long value's digest key
        shows whether the result is sorted."""
        result = shorten_trial_types({"zeta": 1, "a" * 200: 2, "go": 3})
        self.assertEqual(
            list(result), ["a" * 13 + "~" + trial_type_key("a" * 200)[14:], "go", "zeta"]
        )
        self.assertEqual(list(result), sorted(result))

    def test_a_short_value_shaped_like_a_key_does_not_swallow_a_long_one(self):
        """A value that fits claims its key first, so a long value whose digest
        key equals it is re-hashed instead of being merged into its count."""
        long_value = self._record_value(7.0)
        taken = trial_type_key(long_value)
        # sha256 of the 279 bytes of _record_value(7.0) is 108c50fe64de81...; the
        # salted material is printf '1\0' followed by them (281 bytes), whose
        # sha256 starts 50fbdf9ddd7954...
        self.assertEqual(taken, "{'story': 'ea~108c50fe64de81")
        counts = {taken: 3, long_value: 2}
        shortened = shorten_trial_types(counts)
        self.assertEqual(
            shortened, {"{'story': 'ea~108c50fe64de81": 3, "{'story': 'ea~50fbdf9ddd7954": 2}
        )
        # And it is still stable when the short value arrives second.
        self.assertEqual(shorten_trial_types({long_value: 2, taken: 3}), shortened)

    def test_salts_are_decimal_and_pinned(self):
        # printf "$N\\0%s" "$COLLIDING_SECOND" | shasum -a 256, for N = 1, 2, 3 and 10
        #   -> 4000e57045d764..., 52a0d9dbea719f..., 5e0be657b304bc..., 60d73bb1f08b00...
        # (10 is decimal, not a byte or a letter).
        second = self.COLLIDING_SECOND
        self.assertEqual(trial_type_key(second, 1), "{'story': 'ea~4000e57045d764")
        self.assertEqual(trial_type_key(second, 2), "{'story': 'ea~52a0d9dbea719f")
        self.assertEqual(trial_type_key(second, 3), "{'story': 'ea~5e0be657b304bc")
        self.assertEqual(trial_type_key(second, 10), "{'story': 'ea~60d73bb1f08b00")

    def test_salts_keep_stepping_until_a_key_is_free(self):
        second = self.COLLIDING_SECOND
        k0 = "{'story': 'ea~10544c804e6d2b"  # the digest key of both colliding values
        k1 = "{'story': 'ea~4000e57045d764"  # salt 1 of the second value
        k2 = "{'story': 'ea~52a0d9dbea719f"  # salt 2
        k3 = "{'story': 'ea~5e0be657b304bc"  # salt 3
        # Keys that fit claim their own key first, so these three are already taken.
        self.assertEqual(
            shorten_trial_types({k0: 1, k1: 2, second: 4}), {k0: 1, k1: 2, k2: 4}
        )
        self.assertEqual(
            shorten_trial_types({k0: 1, k1: 2, k2: 3, second: 4}),
            {k0: 1, k1: 2, k2: 3, k3: 4},
        )

    def test_the_order_is_by_value_not_by_count(self):
        """The value that sorts first keeps the digest key even when it has the
        larger count, in either arrival order."""
        first, second = self.COLLIDING_FIRST, self.COLLIDING_SECOND
        expected = {"{'story': 'ea~10544c804e6d2b": 5, "{'story': 'ea~4000e57045d764": 3}
        self.assertEqual(shorten_trial_types({first: 5, second: 3}), expected)
        self.assertEqual(shorten_trial_types({second: 3, first: 5}), expected)

    def test_the_parquet_rows_keep_the_full_value(self):
        """Only the index summary is keyed by the short form; events.parquet is
        the lossless record, and its `trial_type` column is what a client hashes
        to find a value's key."""
        value = self._record_value(93.72)
        parsed = parse_events_tsv(f"onset\tduration\ttrial_type\n0.0\t0.5\t{value}\n")
        rows = event_rows_for_store(
            "sub-01/eeg/a_eeg.zarr", "sub-01/eeg/sub-01_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}], parsed,
        )
        self.assertEqual((rows or {})["trial_type"], [value])
        self.assertEqual(
            list(events_summary_of(parsed)["trial_types"]), ["{'story': 'ea~97ecccec881a7c"]
        )

    def test_every_parquet_trial_type_finds_its_count_in_the_summary(self):
        """The join a client relies on: hash the `trial_type` of an events.parquet
        row and look it up in the store's `trial_types`. Both cut the same stripped
        cell, so leading or trailing spaces in the TSV change neither."""
        pinned = self._record_value(93.72)  # key {'story': 'ea~97ecccec881a7c
        other = self._record_value(2.5)
        text = (
            "onset\ttrial_type\n"
            f"0.0\t   {pinned}\n1.0\t{pinned}   \n2.0\t  {other}\n3.0\t go \n"
        )
        parsed = parse_events_tsv(text)
        rows = event_rows_for_store(
            "sub-01/eeg/a_eeg.zarr", "sub-01/eeg/sub-01_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}], parsed,
        )
        cells = (rows or {})["trial_type"]
        summary = events_summary_of(parsed)["trial_types"]
        self.assertEqual(sorted(set(cells)), sorted([pinned, other, "go"]))
        for cell in set(cells):
            key = trial_type_key(cell) if len(cell) > TRIAL_TYPE_KEY_MAX else cell
            self.assertEqual(summary[key], cells.count(cell), cell)
        self.assertEqual(summary["{'story': 'ea~97ecccec881a7c"], 2)

    def test_the_summary_and_the_rows_come_from_one_parse(self):
        """#1060's last acceptance criterion. `n_events` in index.json and the
        rows in events.parquet describe the same file, so they must not be able
        to disagree: both are computed from a single `parse_events_tsv`."""
        text = "onset\tduration\ttrial_type\n0.0\t0.5\tgo\n1.0\t0.5\tstop\n"
        parsed = parse_events_tsv(text)
        summary = events_summary_of(parsed)
        rows = event_rows_for_store(
            "sub-01/eeg/a_eeg.zarr", "sub-01/eeg/sub-01_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}], parsed,
        )
        self.assertEqual(summary, events_summary(text))
        # One group, so one row per event: the counts are the same number
        # arrived at two ways.
        self.assertEqual(len(rows["onset_s"]), summary["n_events"])


class TestEventsParse(unittest.TestCase):
    """The shared parse behind both the index summary and events.parquet."""

    def test_a_utf8_bom_does_not_eat_the_onset_column(self):
        """A spreadsheet-exported events.tsv starts with U+FEFF, so the first
        header cell reads `﻿onset` -- every onset would be unparseable and
        every sample_index null. nm000329 (the dataset #1060 names for the
        one-sample check) ships exactly this file."""
        parsed = parse_events_tsv("﻿onset\tduration\n1.5\t0.5\n")
        self.assertEqual(parsed["columns"], ["onset", "duration"])
        rows = event_rows_for_store(
            "a.zarr", "sub-01/eeg/sub-01_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}], parsed,
        )
        self.assertEqual(rows["onset_s"], [1.5])
        self.assertEqual(rows["sample_index"], [375])

    def test_no_file_and_an_empty_file_are_different(self):
        self.assertIsNone(parse_events_tsv(None))
        self.assertEqual(parse_events_tsv(""), {"columns": [], "rows": []})
        self.assertEqual(events_summary_of(parse_events_tsv("")),
                         {"n_events": 0, "trial_types": {}})

    def test_blank_lines_are_not_events(self):
        parsed = parse_events_tsv("onset\n0.0\n\n1.0\n\n")
        self.assertEqual(len(parsed["rows"]), 2)


class TestSampleIndexFormula(unittest.TestCase):
    """`sample_index` is the reason the file exists (#1060): the converter knows
    the exact resampling relation and every client re-deriving it gets a
    sub-sample offset wrong wherever the ratio is not an integer."""

    def test_it_is_the_onset_on_the_level_zero_grid(self):
        self.assertEqual(sample_index_for(0.0, 250.0), 0)
        self.assertEqual(sample_index_for(4.057, 250.0), 1014)
        self.assertEqual(sample_index_for(10.0, 250.0), 2500)

    def test_ties_round_up(self):
        # 1014.5 -> 1015, not banker's 1014. One rule, stated, so a client that
        # wants to reproduce it can.
        self.assertEqual(sample_index_for(4.058, 250.0), 1015)
        self.assertEqual(sample_index_for(0.002, 250.0), 1)

    def test_a_non_integer_rate_ratio_lands_on_the_grid(self):
        """The case the issue is about: 512 Hz capped to 250 Hz is 125/256, so
        `round(onset * source_rate) / 4`-style reasoning is wrong. Checked
        against the grid itself -- the times level 0 actually has, built from
        the rate rather than from the formula under test."""
        rate = 250.0
        n_samples = 512 * 60 * 125 // 256  # what the exporter writes for 60 s
        grid = [n / rate for n in range(n_samples)]
        for onset in (0.0, 0.001, 1.0 / 512, 7.13, 33.3333, 59.9):
            nearest = min(range(len(grid)), key=lambda i: abs(grid[i] - onset))
            self.assertLessEqual(
                abs(sample_index_for(onset, rate) - nearest), 1,
                f"onset {onset} is more than a sample off the level-0 grid",
            )

    def test_it_is_not_clamped_to_the_recording(self):
        # An onset past the end is a property of the data. Clamping would be
        # indistinguishable from an event on the last sample.
        self.assertEqual(sample_index_for(10_000.0, 250.0), 2_500_000)

    def test_unknowables_are_null_not_zero(self):
        for onset, rate in ((None, 250.0), (1.0, None), (1.0, 0), (1.0, -250.0),
                            (float("nan"), 250.0), (float("inf"), 250.0)):
            self.assertIsNone(sample_index_for(onset, rate), (onset, rate))


class TestEventRowBuilder(unittest.TestCase):
    """The rows of `<id>/zarr/events.parquet`, per store (#1060)."""

    PATH = "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-3_eeg.edf"
    ZARR = "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-3_eeg.zarr"
    TEXT = (
        "onset\tduration\ttrial_type\tvalue\tHED\tresponse_time\n"
        "1.0\t0.5\tgo\t2\t(Def/Go)\t0.31\n"
        "0.0\t0.25\tstop\tn/a\t\t\n"
    )

    UNSET = object()

    def rows(self, text=UNSET, groups=None, path=None):
        return event_rows_for_store(
            self.ZARR, path or self.PATH,
            [{"name": "eeg_250hz", "rate": 250.0}] if groups is None else groups,
            parse_events_tsv(self.TEXT if text is self.UNSET else text),
        )

    def test_the_fixed_columns_come_first_and_in_order(self):
        rows = self.rows()
        self.assertEqual(list(rows)[: len(EVENTS_FIXED_COLUMNS)], list(EVENTS_FIXED_COLUMNS))

    def test_entities_come_from_the_recording_path(self):
        rows = self.rows()
        self.assertEqual(set(rows["subject"]), {"01"})
        self.assertEqual(set(rows["session"]), {"02"})
        self.assertEqual(set(rows["task"]), {"rest"})
        self.assertEqual(set(rows["run"]), {"3"})
        self.assertEqual(set(rows["store_path"]), {self.ZARR})

    def test_session_and_run_are_null_when_the_dataset_has_neither(self):
        rows = self.rows(path="sub-01/eeg/sub-01_task-rest_eeg.edf")
        self.assertEqual(rows["session"], [None, None])
        self.assertEqual(rows["run"], [None, None])
        self.assertEqual(set(rows["subject"]), {"01"})

    def test_rows_are_ordered_by_onset(self):
        # The file's own order is onset 1.0 then 0.0; published order is sorted,
        # which is what makes `store_path, onset_s` true of the whole file
        # without a global sort at write time.
        self.assertEqual(self.rows()["onset_s"], [0.0, 1.0])
        self.assertEqual(self.rows()["trial_type"], ["stop", "go"])

    def test_na_and_blank_cells_are_null(self):
        rows = self.rows()
        self.assertEqual(rows["value"], [None, "2"])  # `n/a` on the stop row
        self.assertEqual(rows["hed"], [None, "(Def/Go)"])
        self.assertEqual(rows["response_time"], [None, "0.31"])

    def test_the_hed_column_is_matched_case_insensitively(self):
        # BIDS spells it `HED`; datasets in the archive use both cases, and a
        # case-sensitive match would silently pass it through as an extra column
        # instead of filling the declared `hed` one.
        self.assertEqual(self.rows(text="onset\thed\n0.0\tX\n")["hed"], ["X"])
        self.assertEqual(self.rows(text="onset\tHED\n0.0\tX\n")["hed"], ["X"])

    def test_remaining_columns_pass_through_under_their_own_names(self):
        rows = self.rows()
        self.assertIn("response_time", rows)
        self.assertNotIn("x_response_time", rows)

    def test_a_column_named_like_a_fixed_one_is_prefixed(self):
        rows = self.rows(text="onset\tsample_index\tsubject\n0.0\t7\tzz\n")
        self.assertEqual(rows["x_sample_index"], ["7"])
        self.assertEqual(rows["x_subject"], ["zz"])
        # ...and the real columns keep their meaning.
        self.assertEqual(rows["sample_index"], [0])
        self.assertEqual(rows["subject"], ["01"])

    def test_a_duplicated_header_keeps_both_columns(self):
        # Malformed input, but dropping the second column's values silently is
        # the worse answer.
        rows = self.rows(text="onset\tstim\tstim\n0.0\ta\tb\n")
        self.assertEqual(rows["stim"], ["a"])
        self.assertEqual(rows["x_stim"], ["b"])

    def test_one_row_per_event_and_group(self):
        """A store's groups are concurrent streams at different rates, so one
        onset has a different sample index in each -- and `group_name` is what
        tells the rows apart. No dataset in the catalog has a multi-group store
        today, so this fixture is the only thing standing between the rule and a
        silently single-rate file."""
        rows = self.rows(groups=[
            {"name": "eeg_250hz", "rate": 250.0},
            {"name": "misc_50hz", "rate": 50.0},
        ])
        self.assertEqual(len(rows["onset_s"]), 4)
        self.assertEqual(rows["group_name"], ["eeg_250hz", "misc_50hz"] * 2)
        self.assertEqual(rows["onset_s"], [0.0, 0.0, 1.0, 1.0])
        self.assertEqual(rows["sample_index"], [0, 0, 250, 50])

    def test_a_group_with_no_rate_yields_a_null_index_not_a_dropped_row(self):
        rows = self.rows(groups=[{"name": "eeg_250hz", "rate": None}])
        self.assertEqual(rows["sample_index"], [None, None])
        self.assertEqual(rows["onset_s"], [0.0, 1.0])

    def test_a_malformed_onset_keeps_the_row(self):
        rows = self.rows(text="onset\ttrial_type\nn/a\tgo\n1.0\tstop\n")
        # Unparseable onsets sort last, and say so with nulls rather than
        # vanishing -- an event was declared, its position is unknown.
        self.assertEqual(rows["onset_s"], [1.0, None])
        self.assertEqual(rows["sample_index"], [250, None])
        self.assertEqual(rows["trial_type"], ["stop", "go"])

    def test_nothing_to_publish_returns_none(self):
        self.assertIsNone(self.rows(text=None))          # no events.tsv
        self.assertIsNone(self.rows(text="onset\n"))     # header only
        self.assertIsNone(self.rows(groups=[]))          # store with no groups

    def test_duplicate_onsets_keep_both_rows_in_file_order(self):
        """Two events at the same instant are two events -- a simultaneous
        stimulus and response, or two annotation streams merged into one file.
        The sort is stable, so their file order survives; de-duplicating or
        reordering them would silently drop or re-pair a client's trials."""
        rows = self.rows(
            text="onset\tduration\ttrial_type\n1.5\t0.1\tfirst\n1.5\t0.2\tsecond\n"
        )
        self.assertEqual(rows["onset_s"], [1.5, 1.5])
        self.assertEqual(rows["trial_type"], ["first", "second"])
        self.assertEqual(rows["duration_s"], [0.1, 0.2])
        self.assertEqual(rows["sample_index"], [375, 375])


class TestEventsRowAlert(unittest.TestCase):
    """The two conditions that leave a client with events it cannot use, and
    which the parquet cannot show on its own: a store that contributes no rows
    at all, and rows whose sample index is null throughout."""

    PARSED = parse_events_tsv("onset\ttrial_type\n0.0\tgo\n1.0\tstop\n")
    PRIMARY = "sub-01/eeg/sub-01_task-x_eeg.edf"

    def build(self, groups):
        return event_rows_for_store("a.zarr", self.PRIMARY, groups, self.PARSED)

    def test_a_healthy_store_is_silent(self):
        rows = self.build([{"name": "eeg_250hz", "rate": 250.0}])
        self.assertIsNone(events_row_alert(self.PRIMARY, self.PARSED, rows))

    def test_events_but_no_channel_groups_is_named(self):
        """Unreachable through `main` -- `convert_one` refuses to publish a
        store with no channel groups -- so this is the only place the branch can
        be exercised at all. It stays because the alternative is a store that
        silently vanishes from events.parquet if that guard ever changes."""
        alert = events_row_alert(self.PRIMARY, self.PARSED, self.build([]))
        self.assertIsNotNone(alert)
        self.assertIn("::warning::", alert)
        self.assertIn(self.PRIMARY, alert)
        self.assertIn("no channel groups", alert)
        self.assertIn("2 event(s)", alert)

    def test_no_events_at_all_is_silent(self):
        # No events.tsv, or an empty one: not a defect, and not worth a line in
        # a log where most datasets would print it.
        self.assertIsNone(events_row_alert(self.PRIMARY, None, None))
        self.assertIsNone(events_row_alert(self.PRIMARY, parse_events_tsv("onset\n"), None))

    def test_every_sample_index_null_is_named(self):
        rows = self.build([{"name": "eeg_250hz", "rate": None}])
        alert = events_row_alert(self.PRIMARY, self.PARSED, rows)
        self.assertIn("no usable sample index", alert)
        self.assertIn("2 row(s)", alert)

    def test_one_usable_index_is_enough_to_stay_silent(self):
        parsed = parse_events_tsv("onset\ttrial_type\nn/a\tgo\n1.0\tstop\n")
        rows = event_rows_for_store(
            "a.zarr", self.PRIMARY, [{"name": "eeg_250hz", "rate": 250.0}], parsed
        )
        self.assertIsNone(events_row_alert(self.PRIMARY, parsed, rows))


class TestEventsParquetFile(unittest.TestCase):
    """The file itself: schema, order, and the bounded-memory write path.

    `pyarrow` is a real dependency here (scripts/zarr/requirements.txt, and the
    zarr-python-test CI job installs it) rather than an optional one, for the
    same reason `jsonschema` is: without it these tests do not fail, they ERROR
    on import, and the converter's own degradation path makes a missing writer
    look like a dataset with no events.
    """

    def test_pyarrow_is_installed_so_this_class_can_fail(self):
        import pyarrow  # noqa: F401 - presence IS the assertion

    def build(self, n_stores=3, n_events=2, rate=250.0, extra=None, first=0):
        staging = EventsStaging()
        rels = []
        for s in range(first, first + n_stores):
            rel = f"sub-{s:03d}/eeg/sub-{s:03d}_task-x_eeg.zarr"
            text = "onset\tduration\ttrial_type" + (f"\t{extra}" if extra else "") + "\n"
            for i in range(n_events):
                text += f"{i * 2.0}\t0.5\tgo" + (f"\t{i}" if extra else "") + "\n"
            rows = event_rows_for_store(
                rel, f"sub-{s:03d}/eeg/sub-{s:03d}_task-x_eeg.edf",
                [{"name": "eeg_250hz", "rate": rate}], parse_events_tsv(text),
            )
            staging.add(rel, rows)
            rels.append(rel)
        return staging, rels

    def write(self, staging, rels, prior=None):
        out = os.path.join(tempfile.mkdtemp(), "events.parquet")
        rows = write_events_parquet(out, rels, staging, prior)
        return out, rows

    def test_the_published_types_are_the_declared_ones(self):
        import pyarrow as pa
        import pyarrow.parquet as pq

        staging, rels = self.build()
        out, rows = self.write(staging, rels)
        self.assertEqual(rows, 6)
        table = pq.read_table(out)
        self.assertEqual(table.num_rows, 6)
        label = pa.dictionary(pa.int32(), pa.string())
        # Dictionary-encoded on the way out AND on the way back: a client reads
        # categoricals, not 25k copies of the same store path (#1060).
        for name in ("store_path", "subject", "task", "group_name", "trial_type"):
            self.assertEqual(table.schema.field(name).type, label, name)
        self.assertEqual(table.schema.field("onset_s").type, pa.float64())
        self.assertEqual(table.schema.field("duration_s").type, pa.float32())
        self.assertEqual(table.schema.field("sample_index").type, pa.int64())

    def test_two_hundred_stores_write_one_file_without_holding_them(self):
        """The shape that made this a streaming writer: nm000281 has ~25k stores,
        and one pandas frame for the dataset is not an option (#1060). With the
        row-group cap lowered, a build that buffered everything would produce ONE
        row group; the flush is what makes it many."""
        import pyarrow.parquet as pq

        staging, rels = self.build(n_stores=200, n_events=5)
        self.assertEqual(len(staging), 200)
        self.assertEqual(staging.row_count, 1000)
        saved = generate_zarr.EVENTS_ROW_GROUP_ROWS
        try:
            generate_zarr.EVENTS_ROW_GROUP_ROWS = 100
            out, rows = self.write(staging, rels)
        finally:
            generate_zarr.EVENTS_ROW_GROUP_ROWS = saved
        self.assertEqual(rows, 1000)
        pf = pq.ParquetFile(out)
        self.assertEqual(pf.metadata.num_rows, 1000)
        self.assertEqual(pf.num_row_groups, 10)

    def test_rows_are_ordered_by_store_then_onset(self):
        import pyarrow.parquet as pq

        staging, rels = self.build(n_stores=3, n_events=3)
        # Stores are emitted in the order given (in production the index's, i.e.
        # sorted by `zarr`) whatever order the pool finished them in -- so the
        # published order is a property of the caller's list, not of arrival.
        # Reversed here precisely so "sorted by accident" cannot pass.
        asked = sorted(rels, reverse=True)
        out, _ = self.write(staging, asked)
        table = pq.read_table(out)
        stores = table["store_path"].to_pylist()
        onsets = table["onset_s"].to_pylist()
        self.assertEqual(stores, [rel for rel in asked for _ in range(3)])
        # ...and onsets ascend within each store.
        self.assertEqual(onsets, [0.0, 2.0, 4.0] * 3)

    def test_a_column_only_some_stores_have_is_null_for_the_others(self):
        import pyarrow.parquet as pq

        with_extra, rels_a = self.build(n_stores=1, extra="stim_file")
        without, rels_b = self.build(n_stores=1)
        # Same store id in both fixtures; rename so they are distinct stores.
        rel_b = "sub-999/eeg/sub-999_task-x_eeg.zarr"
        rows = without.get(rels_b[0])
        rows["store_path"] = [rel_b] * len(rows["store_path"])
        with_extra.add(rel_b, rows)
        out, total = self.write(with_extra, sorted([*rels_a, rel_b]))
        table = pq.read_table(out).to_pydict()
        self.assertEqual(total, 4)
        self.assertIn("stim_file", table)
        by_store = dict(zip(table["store_path"], table["stim_file"]))
        self.assertIsNone(by_store[rel_b])
        self.assertIsNotNone(by_store[rels_a[0]])

    def test_a_store_not_converted_this_run_keeps_its_prior_rows(self):
        """The incremental path: an unchanged store carries its rows forward from
        the published file exactly as its entry carries forward in the index. It
        is not reconverted, so this is the only place its events exist."""
        import pyarrow.parquet as pq

        first, rels = self.build(n_stores=3, n_events=2)
        prior_path, _ = self.write(first, rels)

        # Second run: only the middle store reconverted, with different events.
        second = EventsStaging()
        changed = rels[1]
        second.add(changed, event_rows_for_store(
            changed, "sub-001/eeg/sub-001_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}],
            parse_events_tsv("onset\ttrial_type\n9.0\tnew\n"),
        ))
        out, total = self.write(second, rels, PriorEventRows(prior_path))
        self.assertEqual(total, 5)  # 2 carried + 1 fresh + 2 carried
        table = pq.read_table(out).to_pydict()
        rows_for = {}
        for rel, onset, trial in zip(
            table["store_path"], table["onset_s"], table["trial_type"]
        ):
            rows_for.setdefault(rel, []).append((onset, trial))
        self.assertEqual(rows_for[rels[0]], [(0.0, "go"), (2.0, "go")])
        self.assertEqual(rows_for[changed], [(9.0, "new")])
        self.assertEqual(rows_for[rels[2]], [(0.0, "go"), (2.0, "go")])

    def test_a_reconverted_store_never_inherits_prior_rows(self):
        """`reconverted` is not `staged`: a store rebuilt this run that produced
        no rows (its events.tsv was deleted or emptied) must publish none, not
        fall through to the prior file and resurrect the old ones."""
        import pyarrow.parquet as pq

        first, rels = self.build(n_stores=2, n_events=2)
        prior_path, _ = self.write(first, rels)

        # Second run rebuilt BOTH stores; only one still has events.
        second = EventsStaging()
        second.add(rels[0], event_rows_for_store(
            rels[0], "sub-000/eeg/sub-000_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}],
            parse_events_tsv("onset\ttrial_type\n4.0\tkept\n"),
        ))
        out = os.path.join(tempfile.mkdtemp(), "events.parquet")
        total = write_events_parquet(
            out, rels, second, PriorEventRows(prior_path), set(rels)
        )
        self.assertEqual(total, 1)
        table = pq.read_table(out).to_pydict()
        self.assertEqual(table["store_path"], [rels[0]])
        self.assertEqual(table["trial_type"], ["kept"])
        # Without the `reconverted` argument the same call carries them forward,
        # which is what an unchanged (untouched) store needs.
        carried = write_events_parquet(
            os.path.join(tempfile.mkdtemp(), "events.parquet"),
            rels, second, PriorEventRows(prior_path),
        )
        self.assertEqual(carried, 3)

    def test_a_store_dropped_from_the_index_loses_its_rows(self):
        # The rel list is the index's store list, so a removed recording's rows
        # are simply not carried: the two documents cannot disagree about which
        # stores exist.
        import pyarrow.parquet as pq

        first, rels = self.build(n_stores=3, n_events=1)
        prior_path, _ = self.write(first, rels)
        out, total = self.write(EventsStaging(), rels[:2], PriorEventRows(prior_path))
        self.assertEqual(total, 2)
        self.assertNotIn(rels[2], set(pq.read_table(out)["store_path"].to_pylist()))

    def test_a_prior_file_without_a_later_column_conforms(self):
        import pyarrow as pa
        import pyarrow.parquet as pq

        first, rels = self.build(n_stores=1, n_events=1)
        prior_path, _ = self.write(first, rels)
        prior = PriorEventRows(prior_path)
        schema = events_schema(pa, {"stim_file"})
        table = prior.table_for(rels[0], schema)
        self.assertEqual(table.schema, schema)
        self.assertEqual(table["stim_file"].to_pylist(), [None])
        # And through the writer, alongside a fresh store that HAS the column.
        fresh, rels_b = self.build(n_stores=1, n_events=2, extra="stim_file", first=1)
        out, total = self.write(fresh, sorted([*rels, *rels_b]), prior)
        self.assertEqual(total, 3)
        self.assertIn("stim_file", pq.read_table(out).column_names)

    def test_conform_fills_a_missing_column_with_nulls(self):
        import pyarrow as pa

        schema = events_schema(pa, {"a", "b"})
        table = pa.Table.from_arrays(
            [pa.array(["x"], type=pa.dictionary(pa.int32(), pa.string()))],
            names=["store_path"],
        )
        conformed = conform_events_table(pa, table, schema)
        self.assertEqual(conformed.schema, schema)
        self.assertEqual(conformed["b"].to_pylist(), [None])


class TestDatasetProvenanceAttrs(unittest.TestCase):
    """The structured `nemar` root attribute (#1064). Prose provenance is useless
    to the machines that are increasingly what reads these stores."""

    ROW = {
        "name": "Resting state EEG",
        "authors": "Doe J, Roe R",
        "concept_doi": "10.82901/nemar.on007763",
        "license": "CC0",
        "hed_version": "8.2.0",
        "latest_version": "v1.0.2",
        "created_at": "2024-05-01T00:00:00Z",
    }

    def attrs(self, row):
        return nemar_store_attrs(
            dataset_id="on007763",
            source_commit="a" * 40,
            source_tree="raw",
            derived=False,
            engine_version="2",
            contract_url="https://zarr.nemar.org/on007763/zarr/sub-01/eeg/x_eeg.zarr/",
            row=row,
        )

    def test_carries_the_catalog_fields(self):
        a = self.attrs(self.ROW)
        self.assertEqual(a["doi"], "10.82901/nemar.on007763")
        self.assertEqual(a["license"], "CC0")
        self.assertEqual(a["hed_version"], "8.2.0")
        self.assertEqual(a["source_commit"], "a" * 40)
        self.assertEqual(a["engine_version"], "2")
        self.assertEqual(a["source_tree"], "raw")
        self.assertIs(a["derived"], False)

    def test_missing_catalog_row_leaves_fields_null_not_invented(self):
        a = self.attrs(None)
        for key in ("doi", "license", "citation", "hed_version"):
            self.assertIsNone(a[key], key)
        # The fields the converter knows by itself are still stated.
        self.assertEqual(a["dataset_id"], "on007763")
        self.assertEqual(a["source_commit"], "a" * 40)

    def test_citation_composes_from_the_row(self):
        citation = dataset_citation(self.ROW)
        self.assertIn("Doe J, Roe R", citation)
        self.assertIn("(2024)", citation)
        self.assertIn("Resting state EEG (v1.0.2).", citation)
        self.assertIn("https://doi.org/10.82901/nemar.on007763", citation)

    def test_citation_needs_a_name(self):
        self.assertIsNone(dataset_citation({"authors": "Doe J"}))
        self.assertIsNone(dataset_citation(None))

    def test_citation_omits_the_parts_the_row_lacks(self):
        citation = dataset_citation({"name": "Untitled"})
        self.assertEqual(citation, "Untitled. NEMAR.")


class TestFetchDatasetRow(unittest.TestCase):
    """`fetch_dataset_row` against a REAL HTTP server on a real socket -- the
    provenance attrs depend on its parsing (two response shapes) and on it never
    failing a conversion when the catalog is unreachable."""

    def serve(
        self,
        handler_body: bytes | None,
        status: int = 200,
        refuse_user_agent_prefix: str | None = None,
        seen_user_agents: list[str] | None = None,
    ):
        """A real server on a real socket. `refuse_user_agent_prefix` makes it
        play the Cloudflare edge in front of api.nemar.org, which 403s the
        default Python-urllib User-Agent; `seen_user_agents` records what each
        request sent so a test can assert on the header itself."""
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
                ua = self.headers.get("User-Agent", "")
                if seen_user_agents is not None:
                    seen_user_agents.append(ua)
                if refuse_user_agent_prefix is not None and (
                    not ua or ua.startswith(refuse_user_agent_prefix)
                ):
                    self.send_error(403, "error code: 1010")
                    return
                if handler_body is None:
                    self.send_error(500)
                    return
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(handler_body)))
                self.end_headers()
                self.wfile.write(handler_body)

            def log_message(self, *_args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def test_reads_a_bare_row(self):
        base = self.serve(json.dumps({"dataset_id": "on007763", "license": "CC0"}).encode())
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertEqual(row["license"], "CC0")
        self.assertIs(failed, False)

    def test_reads_a_row_wrapped_in_dataset(self):
        base = self.serve(json.dumps({"dataset": {"license": "CC-BY-4.0"}}).encode())
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertEqual(row["license"], "CC-BY-4.0")
        self.assertIs(failed, False)

    def test_identifies_itself_so_the_cloudflare_edge_does_not_403_it(self):
        """Cloudflare 403s the default Python-urllib User-Agent on api.nemar.org.

        The first engine-3 production run (on004696, 2026-09-03) fetched with no
        User-Agent and flagged every store `provenance_fetch_failed`; this pins
        the header so the fetch cannot quietly regress to the blocked default.
        """
        seen: list[str] = []
        base = self.serve(
            json.dumps({"dataset": {"id": "on000001", "doi": "10.1/x"}}).encode(),
            refuse_user_agent_prefix="Python-urllib",
            seen_user_agents=seen,
        )
        with contextlib.redirect_stdout(io.StringIO()):
            row, failed = fetch_dataset_row(base, "on000001")
        self.assertIs(failed, False)
        self.assertEqual(row, {"id": "on000001", "doi": "10.1/x"})
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0].startswith("nemar-zarr-converter/"), seen)
        self.assertIn(ZARR_ENGINE_VERSION, seen[0])

    def test_the_refusing_server_does_refuse_the_bare_urllib_default(self):
        # The fixture must actually discriminate, or the test above proves
        # nothing: a bare urllib request against the same server is a 403.
        base = self.serve(b"{}", refuse_user_agent_prefix="Python-urllib")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(f"{base}/datasets/on000001", timeout=5)
        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_a_500_is_reported_as_a_FETCH_FAILURE_not_an_absent_field(self):
        """The distinction the flag exists for.

        A catalog outage and a dataset with no license both leave `doi`/`license`
        null in every store's `nemar` attrs. One is a fact about the run, fixed
        by re-converting; the other is a fact about the dataset. Without the flag
        an outage silently publishes a whole conversion wave claiming to have no
        license, and afterwards nothing distinguishes those stores from datasets
        that genuinely have none.
        """
        base = self.serve(None)  # the handler send_error(500)s
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertIsNone(row)
        self.assertIs(failed, True)

    def test_a_row_that_lacks_a_field_is_NOT_a_fetch_failure(self):
        # The other half of the same distinction: a 200 with no license is data.
        base = self.serve(json.dumps({"dataset_id": "on007763", "name": "N"}).encode())
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertIs(failed, False)
        self.assertIsNone(nemar_store_attrs(
            dataset_id="on007763", source_commit="a" * 40, source_tree="raw",
            derived=False, engine_version="3",
            contract_url="https://zarr.nemar.org/on007763/zarr/x.zarr/",
            row=row, provenance_fetch_failed=failed,
        )["license"])

    def test_a_non_object_body_is_a_fetch_failure(self):
        # A 200 that is not an object is a broken catalog, not an absent field.
        base = self.serve(json.dumps(["not", "an", "object"]).encode())
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertIsNone(row)
        self.assertIs(failed, True)

    def test_the_flag_reaches_the_store_attrs(self):
        attrs = nemar_store_attrs(
            dataset_id="on007763", source_commit="a" * 40, source_tree="raw",
            derived=False, engine_version="3",
            contract_url="https://zarr.nemar.org/on007763/zarr/x.zarr/",
            row=None, provenance_fetch_failed=True,
        )
        self.assertIs(attrs["provenance_fetch_failed"], True)
        self.assertIsNone(attrs["doi"])
        # Always present, so a consumer never has to ask whether the key exists
        # to know whether a null is meaningful.
        clean = nemar_store_attrs(
            dataset_id="on007763", source_commit="a" * 40, source_tree="raw",
            derived=False, engine_version="3",
            contract_url="https://zarr.nemar.org/on007763/zarr/x.zarr/",
            row={"name": "N", "license": "CC0"},
        )
        self.assertIs(clean["provenance_fetch_failed"], False)


class TestIndexFormatV3(unittest.TestCase):
    """The v3 envelope (#1059): where the bytes are, which engine made them, and
    a `source_commit` that is always a real commit."""

    HEAD = "b" * 40

    def build(self, **kwargs):
        base = {
            "prior": None,
            "dataset_id": "on007763",
            "head_commit": self.HEAD,
            "converted": [{"zarr": "sub-01/eeg/a_eeg.zarr", "path": "sub-01/eeg/a_eeg.edf"}],
            "removed_store_rels": [],
            "updated_utc": "2026-09-02T00:00:00Z",
        }
        base.update(kwargs)
        return merge_index(
            base.pop("prior"),
            base.pop("dataset_id"),
            base.pop("head_commit"),
            base.pop("converted"),
            base.pop("removed_store_rels"),
            base.pop("updated_utc"),
            **base,
        )

    def test_declares_the_data_plane(self):
        index = self.build(bucket="nemar", region="us-east-2")
        self.assertEqual(index["format"], "nemar-zarr-index")
        self.assertEqual(index["format_version"], 3)
        self.assertEqual(index["contract_base"], "https://zarr.nemar.org/on007763/zarr/")
        self.assertEqual(
            index["data_base"], "https://nemar.s3.us-east-2.amazonaws.com/on007763/zarr/"
        )
        self.assertEqual(index["data_base_kind"], "s3-public")
        self.assertEqual(index["s3_uri"], "s3://nemar/on007763/zarr/")
        self.assertEqual(index["s3_region"], "us-east-2")
        self.assertIs(index["s3_anonymous"], True)
        self.assertEqual(index["n_recordings"], index["store_count"])

    def test_contract_base_is_not_derived_from_the_bucket(self):
        # The test instance publishes its own host while writing to nemar-dev.
        index = self.build(contract_base="https://zarr-test.nemar.org", bucket="nemar-dev")
        self.assertEqual(index["contract_base"], "https://zarr-test.nemar.org/on007763/zarr/")
        self.assertEqual(
            index["data_base"], "https://nemar-dev.s3.us-east-2.amazonaws.com/on007763/zarr/"
        )

    def test_stamps_the_engine_and_the_library(self):
        index = self.build(engine_version="7", biosigio_version="1.2.6")
        self.assertEqual(index["engine_version"], "7")
        self.assertEqual(index["biosigio_version"], "1.2.6")

    def test_refuses_to_build_without_a_real_commit(self):
        # on008083 published `source_commit: ""` while D1 held the real SHA.
        for bad in ("", "abc123", None, "z" * 40, "A" * 40):
            with self.subTest(commit=bad), self.assertRaises(ValueError):
                self.build(head_commit=bad)

    def test_is_commit_sha(self):
        self.assertTrue(is_commit_sha("0123456789abcdef" + "0" * 24))
        self.assertFalse(is_commit_sha("0123456789ABCDEF" + "0" * 24))  # upper-case
        self.assertFalse(is_commit_sha("0" * 39))
        self.assertFalse(is_commit_sha(None))

    def test_source_key_is_not_published_in_the_index(self):
        index = self.build(
            converted=[{
                "zarr": "sub-01/eeg/a_eeg.zarr",
                "path": "sub-01/eeg/a_eeg.edf",
                "source_key": "SHA256E-s100--abc.edf",
            }],
        )
        self.assertNotIn("source_key", index["stores"][0])

    def test_a_carried_over_v1_entry_is_normalized(self):
        # An index built incrementally on top of a v1 one must not publish a
        # half-v1 document: `source_key` goes, `source_tree`/`derived` appear.
        prior = {
            "source_commit": "a" * 40,
            "stores": [{
                "zarr": "sub-02/eeg/b_eeg.zarr",
                "path": "sub-02/eeg/b_eeg.edf",
                "source_key": "SHA256E-s200--old.edf",
            }],
        }
        index = self.build(prior=prior)
        carried = next(s for s in index["stores"] if s["zarr"] == "sub-02/eeg/b_eeg.zarr")
        self.assertNotIn("source_key", carried)
        self.assertEqual(carried["source_tree"], "raw")
        self.assertIs(carried["derived"], False)

    def test_manifest_carries_the_source_key(self):
        manifest = merge_manifest(
            None,
            "on007763",
            [{"zarr": "sub-01/eeg/a_eeg.zarr", "source_key": "SHA256E-s100--abc.edf",
              "size_bytes": 100}],
            ["sub-01/eeg/a_eeg.zarr"],
            "2026-09-02T00:00:00Z",
        )
        self.assertEqual(manifest["format"], "nemar-zarr-manifest")
        self.assertEqual(manifest["format_version"], 1)
        self.assertEqual(manifest["stores"], [{
            "zarr": "sub-01/eeg/a_eeg.zarr",
            "source_key": "SHA256E-s100--abc.edf",
            "size_bytes": 100,
        }])

    def test_manifest_tracks_the_index_store_set(self):
        # A store the index no longer publishes must not linger in the manifest,
        # or the two documents disagree about what exists.
        prior = {"stores": [
            {"zarr": "gone.zarr", "source_key": "k1", "size_bytes": 1},
            {"zarr": "kept.zarr", "source_key": "k2", "size_bytes": 2},
        ]}
        manifest = merge_manifest(prior, "on007763", [], ["kept.zarr"], "2026-09-02T00:00:00Z")
        self.assertEqual([s["zarr"] for s in manifest["stores"]], ["kept.zarr"])


class TestCoverageInvariant(unittest.TestCase):
    """#1197's acceptance criterion: every discovered raw recording is accounted
    for exactly once, in the published document."""

    HEAD = "c" * 40
    A = "sub-01/eeg/a_eeg.edf"
    B = "sub-02/eeg/b_eeg.edf"
    C = "sub-03/eeg/c_eeg.edf"

    def build(self, converted=(), failures=(), pending=(), discovered=None, **kw):
        return merge_index(
            kw.pop("prior", None),
            "on008083",
            self.HEAD,
            list(converted),
            [],
            "2026-09-02T00:00:00Z",
            list(failures),
            list(pending),
            discovered=discovered,
            **kw,
        )

    def test_full_run_balances(self):
        index = self.build(
            converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
            failures=[{"path": self.B, "zarr": store_rel_for(self.B),
                       "code": "corrupt_or_truncated", "reason": "...", "detail": "..."}],
            pending=[{"path": self.C, "reason": "infra_failure", "last_error": "boom"}],
            discovered=[self.A, self.B, self.C],
        )
        self.assertEqual(index["discovered_count"], 3)
        self.assertEqual((index["store_count"], index["failure_count"],
                          index["pending_count"]), (1, 1, 1))
        check_index_invariant(index)

    def test_partial_run_lists_the_untouched_recordings(self):
        # The five recordings on008083 lost: discovered, not attempted, and
        # before v3 present in neither list.
        index = self.build(
            converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
            discovered=[self.A, self.B, self.C],
        )
        check_index_invariant(index)
        self.assertEqual(index["pending_count"], 2)
        reasons = {p["path"]: p for p in index["pending"]}
        self.assertEqual(reasons[self.B]["reason"], "not_attempted")
        self.assertEqual(reasons[self.B]["attempts"], 0)
        self.assertEqual(reasons[self.B]["zarr"], store_rel_for(self.B))

    def test_entries_for_undiscovered_paths_are_dropped(self):
        prior = {"source_commit": "a" * 40,
                 "stores": [{"zarr": store_rel_for(self.C), "path": self.C}]}
        index = self.build(
            prior=prior,
            converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
            discovered=[self.A],
        )
        check_index_invariant(index)
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])

    def test_a_non_raw_store_is_dropped_and_counted(self):
        """A carried-over store under `derivatives/` must NOT be republished.

        ADR 0027 made discovery raw-only and `purge_non_raw_stores.py` is the
        authorized deletion of what it stopped producing, so those stores are not
        hosted -- an index that kept describing one would advertise bytes that are
        being removed. The drop is deliberate, but it is LOUD: `merge_index` logs
        each one with the tree that excluded it, and `main` reports the count as
        `non_raw_dropped` on the callback, because "the index lost 92 stores"
        needs a cause attached when an orphan-detection bug is the alternative
        reading.
        """
        legacy = "derivatives/preprocessed/sub-09/eeg/sub-09_task-x_eeg.set"
        prior = {
            "source_commit": "a" * 40,
            "stores": [
                {"zarr": store_rel_for(legacy), "path": legacy,
                 "source_key": "SHA256E-s9--legacy"},
            ],
        }
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            index = self.build(
                prior=prior,
                converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
                discovered=[self.A],
            )
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        self.assertEqual(index["store_count"], 1)
        self.assertNotIn("legacy_store_count", index)
        # Named, with the reason, rather than vanishing.
        log = buf.getvalue()
        self.assertIn(legacy, log)
        self.assertIn("derivatives", log)
        self.assertEqual(index["discovered_count"], 1)
        check_index_invariant(index)

    def test_non_raw_store_paths_counts_from_the_prior_index(self):
        """The callback's `non_raw_dropped` is read from the PRIOR PUBLISHED
        index, not from the merge's filtering.

        Production always runs `--clean`, which passes `prior=None` to the merge:
        the entries never enter, so the filter never sees them -- yet they are
        still gone from the index a client fetches next. Counting from the merge
        would report 0 on exactly the path that matters.
        """
        prior = {"stores": [
            {"path": "derivatives/prep/a_eeg.set", "zarr": "derivatives/prep/a_eeg.zarr"},
            {"path": "sourcedata/b_eeg.set", "zarr": "sourcedata/b_eeg.zarr"},
            {"path": "code/c_eeg.set", "zarr": "code/c_eeg.zarr"},
            {"path": "sub-01/meg/sub-01_acq-crosstalk_meg.fif",
             "zarr": "sub-01/meg/sub-01_acq-crosstalk_meg.zarr"},
            {"path": self.A, "zarr": store_rel_for(self.A)},
        ]}
        dropped = generate_zarr.non_raw_store_paths(prior)
        self.assertEqual(len(dropped), 4, dropped)
        self.assertNotIn(self.A, dropped)
        self.assertEqual(generate_zarr.non_raw_store_paths(None), [])
        self.assertEqual(generate_zarr.non_raw_store_paths({}), [])

    def test_excluded_reason_names_the_cause(self):
        self.assertEqual(generate_zarr.excluded_reason("derivatives/x_eeg.set"), "derivatives")
        self.assertEqual(generate_zarr.excluded_reason("sub-01/sourcedata/x_eeg.set"), "sourcedata")
        self.assertEqual(generate_zarr.excluded_reason("code/x_eeg.set"), "code")
        self.assertEqual(
            generate_zarr.excluded_reason("sub-01/meg/sub-01_acq-crosstalk_meg.fif"),
            "bids-calibration",
        )
        self.assertIsNone(generate_zarr.excluded_reason("sub-01/eeg/a_eeg.set"))

    def test_a_non_raw_failure_or_pending_entry_cannot_survive(self):
        # The same rule on the other two lists: a non-raw path has no business in
        # any of them, and the carry-forward already refused one.
        prior = {
            "source_commit": "a" * 40,
            "stores": [],
            "failures": [{"path": "derivatives/prep/x-epo.fif", "zarr": "derivatives/prep/x-epo.zarr",
                          "code": "not_continuous", "reason": "..."}],
            "pending": [{"path": "code/y_eeg.set", "reason": "infra_failure", "attempts": 2}],
        }
        index = merge_index(
            prior, "on008083", self.HEAD, [], [], "2026-09-02T00:00:00Z", [], [],
            discovered=[self.A], prior_pending=prior["pending"],
        )
        self.assertEqual(index["failure_count"], 0)
        self.assertEqual([p["path"] for p in index["pending"]], [self.A])
        check_index_invariant(index)

    def test_errors_counts_this_runs_failures_typed_and_not(self):
        index = self.build(
            converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
            failures=[{"path": self.B, "zarr": store_rel_for(self.B),
                       "code": "not_continuous", "reason": "..."}],
            pending=[{"path": self.C, "reason": "infra_failure"}],
            discovered=[self.A, self.B, self.C],
            errors=2,
        )
        self.assertEqual(index["errors"], 2)

    def test_discovered_primaries_match_the_worklist(self):
        # The coverage denominator has to be the set the converter would attempt,
        # not a second walk that could drift from it.
        head = [
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-01/eeg/sub-01_task-x_eeg.fdt",
            "derivatives/prep/sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-02/meg/sub-02_task-x_acq-crosstalk_meg.fif",
            "dataset_description.json",
        ]
        convert, _remove = compute_worklist(head, [], full=True)
        self.assertEqual(discover_primaries(head), convert)
        self.assertEqual(discover_primaries(head), ["sub-01/eeg/sub-01_task-x_eeg.set"])


class TestPendingRetries(unittest.TestCase):
    """Pending entries age, and stop aging (#1197). An infra failure that will
    never succeed must not promise forever that it is about to."""

    HEAD = "d" * 40
    PATH = "sub-01/eeg/a_eeg.edf"

    def run_round(self, prior_pending, reason="infra_failure", last_error="boom"):
        return merge_index(
            None, "on008083", self.HEAD, [], [], "2026-09-02T00:00:00Z", [],
            [{"path": self.PATH, "reason": reason, "last_error": last_error}],
            discovered=[self.PATH],
            prior_pending=prior_pending,
        )

    def test_attempts_start_at_one_and_accumulate(self):
        index = self.run_round(None)
        self.assertEqual(index["pending"][0]["attempts"], 1)
        self.assertEqual(index["pending"][0]["reason"], "infra_failure")
        self.assertEqual(index["pending"][0]["last_error"], "boom")
        self.assertEqual(index["pending"][0]["last_attempt_utc"], "2026-09-02T00:00:00Z")

        index = self.run_round(index["pending"])
        self.assertEqual(index["pending"][0]["attempts"], 2)

    def test_exhaustion_promotes_to_a_typed_failure(self):
        pending = None
        for round_n in range(1, PENDING_MAX_ATTEMPTS):
            index = self.run_round(pending)
            self.assertEqual(index["pending_count"], 1, f"round {round_n}")
            pending = index["pending"]
        # The round that reaches the cap moves it out of `pending` for good.
        index = self.run_round(pending)
        self.assertEqual(index["pending_count"], 0)
        self.assertEqual(index["failure_count"], 1)
        failure = index["failures"][0]
        self.assertEqual(failure["code"], "retry_exhausted")
        self.assertEqual(failure["detail"], "boom")
        self.assertEqual(failure["attempts"], PENDING_MAX_ATTEMPTS)
        self.assertTrue(failure["reason"])
        check_index_invariant(index)

    def test_a_memory_budget_pending_is_reason_tagged(self):
        index = self.run_round(None, reason="memory_budget")
        self.assertEqual(index["pending"][0]["reason"], "memory_budget")

    def test_converting_clears_the_pending_entry(self):
        first = self.run_round(None)
        index = merge_index(
            None, "on008083", self.HEAD,
            [{"zarr": store_rel_for(self.PATH), "path": self.PATH}],
            [], "2026-09-02T01:00:00Z", [], [],
            discovered=[self.PATH],
            prior_pending=first["pending"],
        )
        self.assertEqual(index["pending_count"], 0)
        self.assertEqual(index["store_count"], 1)
        check_index_invariant(index)

    def test_a_path_is_never_in_two_lists(self):
        index = merge_index(
            None, "on008083", self.HEAD,
            [{"zarr": store_rel_for(self.PATH), "path": self.PATH}],
            [], "2026-09-02T00:00:00Z", [],
            [{"path": self.PATH, "reason": "infra_failure"}],
            discovered=[self.PATH],
        )
        self.assertEqual(index["store_count"], 0)
        self.assertEqual(index["pending_count"], 1)
        check_index_invariant(index)

    def test_not_attempted_never_ages_toward_exhaustion(self):
        # A recording a `--limit`ed run never reached has not failed at anything.
        pending = None
        for _ in range(PENDING_MAX_ATTEMPTS + 2):
            index = merge_index(
                None, "on008083", self.HEAD, [], [], "2026-09-02T00:00:00Z", [], [],
                discovered=[self.PATH], prior_pending=pending,
            )
            pending = index["pending"]
        self.assertEqual(index["pending_count"], 1)
        self.assertEqual(index["pending"][0]["reason"], "not_attempted")
        self.assertEqual(index["pending"][0]["attempts"], 0)


class TestIndexSchemaSelfCheck(unittest.TestCase):
    """The converter validates the document it is about to publish. index.json is
    the mandatory entry point (in-prefix ListBucket is denied), so a malformed one
    has no fallback for any consumer."""

    HEAD = "e" * 40

    def index(self):
        return merge_index(
            None, "on007763", self.HEAD,
            [{"zarr": "sub-01/eeg/a_eeg.zarr", "path": "sub-01/eeg/a_eeg.edf",
              "updated_utc": "2026-09-02T00:00:00Z", "source_tree": "raw",
              "derived": False, "modalities": ["eeg"],
              "groups": [{"name": "eeg_200hz", "modality": "EEG", "rate": 200.0,
                          "n_channels": 4, "n_samples": 12000, "duration_s": 60.0,
                          "n_view_levels": 3, "view_chunk_columns": 1024,
                          "source_rate_hz": 200.0, "chunk_samples": 800,
                          "shard_samples": 12000}],
              "n_events": 3, "trial_types": {"go": 2, "stop": 1},
              "units_report": {"converted": 1, "relabelled": 0,
                               "kept_importer_unit": 0, "units_column_present": True}}],
            [], "2026-09-02T00:00:00Z",
            [{"path": "sub-02/eeg/b_eeg.edf", "zarr": "sub-02/eeg/b_eeg.zarr",
              "code": "file_read_error", "reason": "...", "detail": "OSError: ..."}],
            [{"path": "sub-03/eeg/c_eeg.edf", "reason": "infra_failure",
              "last_error": "boom"}],
            discovered=["sub-01/eeg/a_eeg.edf", "sub-02/eeg/b_eeg.edf",
                        "sub-03/eeg/c_eeg.edf"],
            biosigio_version="1.2.6",
        )

    def test_the_validator_is_installed_so_this_class_can_fail(self):
        """Without `jsonschema` every other test here is vacuous.

        `validate_document` degrades to a loud warning when the validator is
        missing -- deliberately, so an old venv on the conversion node still
        converts rather than refusing to publish over a lint dependency. The
        cost is that the positive cases below then pass without validating
        anything, and the negative cases ERROR on their own import. Both read
        like a green schema gate.

        This is the tripwire: it fails, by name, in exactly the environment
        where the rest of the class stops meaning anything. CI installs the
        validator for this job (`.github/workflows/test.yml`), and so does
        `scripts/zarr/requirements.txt`; if either drops it, this is what says
        so.
        """
        import jsonschema  # noqa: F401 - presence IS the assertion

    def index_with_events(self):
        """The index as `main` publishes it for a dataset that HAS events: the
        two fields are set there, after the parquet is uploaded, so the document
        never names a file that was not written."""
        index = self.index()
        index["events_parquet"] = f"{index['data_base']}{EVENTS_PARQUET_NAME}"
        index["events_row_count"] = 3
        return index

    def test_a_built_index_validates(self):
        validate_document(self.index(), INDEX_SCHEMA_PATH, "index")

    def test_an_index_with_events_validates(self):
        validate_document(self.index_with_events(), INDEX_SCHEMA_PATH, "index")

    def test_the_events_fields_are_optional(self):
        """A dataset with no events.tsv anywhere publishes neither field, and a
        v3 index written before they existed carries neither. Both must keep
        validating -- that is what "additive within v3" means."""
        index = self.index()
        self.assertNotIn("events_parquet", index)
        self.assertNotIn("events_row_count", index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_the_events_file_is_in_the_layout_recipe(self):
        # Same reason as the rest of the layout block: an MCP recipe (ADR 0025)
        # is computable from index.json alone. Whether the file EXISTS is said by
        # `events_parquet`, not by this template.
        self.assertEqual(self.index()["layout"]["events"], "<data_base>events.parquet")
        with open(INDEX_SCHEMA_PATH) as fh:
            props = json.load(fh)["properties"]["layout"]
        self.assertEqual(props["properties"]["events"]["const"], "<data_base>events.parquet")
        # Optional in `required`, so an index published by the previous producer
        # (which had no such key) still validates against this schema.
        self.assertNotIn("events", props["required"])

    def test_the_index_declares_its_stability_policy(self):
        # A schema with no stated policy is one every client has to guess at.
        with open(INDEX_SCHEMA_PATH) as fh:
            schema = json.load(fh)
        self.assertIn("format_version 3", schema["$comment"])
        self.assertIn("additionalProperties", schema["$comment"])
        self.assertIn("v4", schema["$comment"])
        with open(MANIFEST_SCHEMA_PATH) as fh:
            self.assertIn("format_version 1", json.load(fh)["$comment"])

    def test_the_layout_recipe_is_published(self):
        """An MCP recipe (ADR 0025) has to be computable from index.json plus ONE
        array-metadata fetch. The broker is stateless, so anything absent from
        the index it must discover by request -- and discovery-by-404 is what
        #1178 item 2 removed. The numbers were already here; these are the path
        templates and the sample-value rule that make them usable."""
        layout = self.index()["layout"]
        self.assertEqual(layout["level0"], "<zarr>/<group>/0")
        self.assertEqual(layout["view"], "<zarr>/<group>/view/<L>")
        self.assertIn("n_view_levels", layout["view_levels"])
        self.assertIn("physical = digital * scale + offset", layout["scale_offset"])
        # `const` in the schema, so a client may hardcode it after checking
        # format_version -- and a layout change becomes a schema change.
        with open(INDEX_SCHEMA_PATH) as fh:
            props = json.load(fh)["properties"]["layout"]["properties"]
        self.assertEqual(props["level0"]["const"], layout["level0"])

    def test_dataset_provenance_is_hoisted_to_the_top_level(self):
        index = merge_index(
            None, "on007763", self.HEAD, [], [], "2026-09-02T00:00:00Z", [], [],
            discovered=[],
            dataset_row={"name": "N", "authors": "Doe J", "concept_doi": "10.82901/x",
                         "license": "CC0", "hed_version": "8.2.0",
                         "created_at": "2024-01-01"},
        )
        self.assertEqual(index["doi"], "10.82901/x")
        self.assertEqual(index["license"], "CC0")
        self.assertEqual(index["hed_version"], "8.2.0")
        self.assertIn("Doe J", index["citation"])
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_dataset_provenance_is_null_without_a_row(self):
        # Already fetched once per run, so publishing it is free -- but a catalog
        # that has no DOI yet must yield null rather than an invented string.
        index = merge_index(
            None, "on007763", self.HEAD, [], [], "2026-09-02T00:00:00Z", [], [],
            discovered=[],
        )
        for key in ("doi", "license", "citation", "hed_version"):
            self.assertIsNone(index[key], key)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_zero_store_index_validates(self):
        # A dataset whose every recording failed still publishes an index, and it
        # is the shape most likely to be built by a path nobody exercised.
        index = merge_index(
            None, "on008083", self.HEAD, [], [], "2026-09-02T00:00:00Z",
            [_failure_entry("sub-01/eeg/a_eeg.edf", "file_read_error", "OSError: x")],
            [],
            discovered=["sub-01/eeg/a_eeg.edf"],
        )
        self.assertEqual(index["store_count"], 0)
        self.assertEqual(index["stores"], [])
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_carried_entry_with_the_raw_case_match_map_heals_on_merge(self):
        """An entry published by a 1.2.10 run before the converter bounded the
        map carries biosigIO's per-channel `matched_case_insensitive`. It is
        carried verbatim by every incremental run, so without healing each run
        would fail validation until a `--clean` rebuild."""
        import jsonschema

        n = 40
        raw = {f"Fp{i}-F{i}": f"FP{i}-F{i}" for i in range(n)}
        prior = self.index()
        old = prior["stores"][0]
        old["units_report"] = {
            "converted": n, "relabelled": 0, "kept_importer_unit": 0,
            "units_column_present": True, "unmatched_channels": 0,
            "matched_case_insensitive": raw,
        }
        # The premise: as published, that prior index is refused.
        with self.assertRaises(jsonschema.ValidationError):
            validate_document(prior, INDEX_SCHEMA_PATH, "index")
        prior_before = json.loads(json.dumps(prior))

        new_store = {**old, "zarr": "sub-02/eeg/b_eeg.zarr", "path": "sub-02/eeg/b_eeg.edf",
                     "units_report": {"converted": 1, "relabelled": 0,
                                      "kept_importer_unit": 0, "units_column_present": True}}
        merged = merge_index(
            prior, "on007763", "f" * 40, [new_store], [], "2026-09-03T00:00:00Z", [],
            [{"path": "sub-03/eeg/c_eeg.edf", "reason": "infra_failure", "last_error": "boom"}],
            discovered=["sub-01/eeg/a_eeg.edf", "sub-02/eeg/b_eeg.edf",
                        "sub-03/eeg/c_eeg.edf"],
            biosigio_version="1.2.10",
            prior_pending=prior["pending"],
        )
        validate_document(merged, INDEX_SCHEMA_PATH, "index")
        by_zarr = {e["zarr"]: e for e in merged["stores"]}
        healed = by_zarr["sub-01/eeg/a_eeg.zarr"]["units_report"]
        self.assertNotIn("matched_case_insensitive", healed)
        self.assertEqual(healed["matched_case_only"], n)
        self.assertEqual(
            healed["matched_case_only_examples"],
            [f"Fp{i}-F{i} -> FP{i}-F{i}" for i in range(generate_zarr.CASE_MATCH_EXAMPLES_MAX)],
        )
        # Everything else the old report said is carried as it was.
        for key in ("converted", "relabelled", "kept_importer_unit",
                    "units_column_present", "unmatched_channels"):
            self.assertEqual(healed[key], old["units_report"][key], key)
        self.assertEqual(by_zarr["sub-02/eeg/b_eeg.zarr"]["units_report"],
                         new_store["units_report"])
        # merge_index is pure: the prior document is left as it was read.
        self.assertEqual(prior, prior_before)

    @staticmethod
    def _events_tsv(counts: dict[str, int]) -> str:
        """The events.tsv whose `trial_type` column holds each value `n` times."""
        rows = [v for v, n in counts.items() for _ in range(n)]
        return "onset\ttrial_type\n" + "".join(f"{i}\t{v}\n" for i, v in enumerate(rows))

    def _merge_carrying(self, prior):
        return merge_index(
            prior, "on007763", "f" * 40, [], [], "2026-09-03T00:00:00Z", [], [],
            discovered=["sub-01/eeg/a_eeg.edf"],
            prior_pending=prior["pending"],
        )

    def test_a_carried_entry_with_long_keys_is_rekeyed_on_merge(self):
        """Stores published with one very long `trial_types` key per event (the
        whole-record shape) must be brought to the short form a fresh conversion
        writes, without reconverting, and an entry already in it left alone."""
        long_values = [TestEventsSummary._record_value(i / 100) for i in range(50)]
        old = {**dict.fromkeys(long_values, 1), "word": 1}
        prior = self.index()
        prior["stores"][0]["n_events"] = 51
        prior["stores"][0]["trial_types"] = old
        before = json.loads(json.dumps(prior))

        merged = self._merge_carrying(prior)
        validate_document(merged, INDEX_SCHEMA_PATH, "index")
        store = next(e for e in merged["stores"] if e["zarr"] == "sub-01/eeg/a_eeg.zarr")
        # Parity: the healed entry is what a fresh conversion of the same events writes.
        self.assertEqual(
            store["trial_types"], events_summary(self._events_tsv(old))["trial_types"]
        )
        self.assertEqual(len(store["trial_types"]), 51)
        # sha256 of the 279 bytes of _record_value(0.0), from a file, with shasum -a 256
        #   -> f7b38eb9d52cad...
        self.assertEqual(store["trial_types"]["{'story': 'ea~f7b38eb9d52cad"], 1)
        self.assertTrue(all(len(k) <= TRIAL_TYPE_KEY_MAX for k in store["trial_types"]))
        self.assertEqual(
            sum(1 for k in store["trial_types"] if len(k) == TRIAL_TYPE_DIGEST_KEY_LEN), 50
        )
        self.assertEqual(store["n_events"], 51)
        # Merging the merged index again changes nothing.
        again = self._merge_carrying(merged)
        self.assertEqual(
            next(e for e in again["stores"] if e["zarr"] == "sub-01/eeg/a_eeg.zarr"),
            store,
        )
        self.assertEqual(prior, before)

    def test_a_merge_handles_every_trial_types_shape_in_one_index(self):
        """An old-format store, a new-format store, a store with an empty
        `trial_types`, and one with none at all: each is treated by itself."""
        long_values = [TestEventsSummary._record_value(i / 10) for i in range(5)]
        old = dict.fromkeys(long_values, 2)
        new = shorten_trial_types(old)
        self.assertNotEqual(old, new)
        prior = self.index()
        template = prior["stores"][0]
        stores = []
        for name, shape in (
            ("a", {"trial_types": old}),
            ("b", {"trial_types": new}),
            ("c", {"trial_types": {}}),
            ("d", {}),
        ):
            entry = json.loads(json.dumps(template))
            entry["zarr"] = f"sub-01/eeg/{name}_eeg.zarr"
            entry["path"] = f"sub-01/eeg/{name}_eeg.edf"
            entry.pop("trial_types", None)
            entry.update(shape)
            stores.append(entry)
        prior["stores"] = stores
        merged = merge_index(
            prior, "on007763", "f" * 40, [], [], "2026-09-03T00:00:00Z", [], [],
            discovered=[e["path"] for e in stores] + ["sub-02/eeg/b_eeg.edf", "sub-03/eeg/c_eeg.edf"],
            prior_pending=prior["pending"],
        )
        validate_document(merged, INDEX_SCHEMA_PATH, "index")
        by_name = {e["zarr"].rsplit("/", 1)[1][0]: e for e in merged["stores"]}
        self.assertEqual(by_name["a"]["trial_types"], new)
        self.assertEqual(by_name["b"]["trial_types"], new)
        self.assertEqual(by_name["c"]["trial_types"], {})
        self.assertNotIn("trial_types", by_name["d"])

    def test_a_trial_types_that_is_not_an_object_is_left_alone(self):
        for odd in (None, ["go"], "go"):
            entry = _normalize_store_entry(
                {"zarr": "sub-01/eeg/a_eeg.zarr", "path": "sub-01/eeg/a_eeg.edf", "trial_types": odd}
            )
            self.assertEqual(entry["trial_types"], odd)

    def test_a_mutated_index_is_rejected(self):
        import jsonschema

        for mutate in (
            lambda d: d.__setitem__("source_commit", ""),
            lambda d: d.__setitem__("format_version", 1),
            lambda d: d.__setitem__("store_count", -1),
            lambda d: d.__setitem__("data_base_kind", "gopher"),
            lambda d: d.__setitem__("stray_key", 1),
            lambda d: d["pending"][0].__setitem__("reason", "because"),
            lambda d: d["stores"][0].pop("source_tree"),
            lambda d: d["failures"][0].pop("code"),
            # The "no source_key in the index" rule (#1178 item 5) is now
            # CHECKABLE rather than a convention: the store object is closed, so
            # a producer that forgot to strip it cannot publish.
            lambda d: d["stores"][0].__setitem__("source_key", "SHA256E-s1--a"),
            # Every sub-object closed, so a typo'd key fails here rather than
            # being served to clients that ignore it.
            lambda d: d["stores"][0].__setitem__("stray", 1),
            lambda d: d["stores"][0]["groups"][0].__setitem__("stray", 1),
            lambda d: d["failures"][0].__setitem__("stray", 1),
            lambda d: d["pending"][0].__setitem__("stray", 1),
            # A group with no name cannot be addressed at all: the layout
            # recipe's <group> has nothing to substitute.
            lambda d: d["stores"][0]["groups"][0].pop("name"),
            # http:// is not the contract: the data plane is HTTPS-only.
            lambda d: d.__setitem__("contract_base", "http://zarr.nemar.org/x/zarr/"),
            lambda d: d.__setitem__("data_base", "ftp://example.org/"),
            # A failure or pending entry must name a STORE path.
            lambda d: d["failures"][0].__setitem__("zarr", "sub-02/eeg/b_eeg.edf"),
            lambda d: d["pending"][0].__setitem__("zarr", "nope"),
            lambda d: d.pop("layout"),
            lambda d: d["layout"].__setitem__("level0", "<zarr>/<group>/level0"),
            lambda d: d["layout"].__setitem__("events", "<data_base>events.pq"),
            # The events file is fetched over the same HTTPS data plane as the
            # stores; an s3:// URI here would not be fetchable by a browser
            # client at all.
            lambda d: d.__setitem__("events_parquet", "s3://nemar/x/zarr/events.parquet"),
            lambda d: d.__setitem__("events_row_count", -1),
            lambda d: d.__setitem__("events_row_count", "3"),
        ):
            doc = json.loads(json.dumps(self.index_with_events()))
            mutate(doc)
            with self.subTest(mutation=str(mutate)), self.assertRaises(
                jsonschema.ValidationError
            ):
                validate_document(doc, INDEX_SCHEMA_PATH, "index")

    def test_a_built_manifest_validates(self):
        manifest = merge_manifest(
            None, "on007763",
            [{"zarr": "sub-01/eeg/a_eeg.zarr", "source_key": "SHA256E-s100--a.edf",
              "size_bytes": 100}],
            ["sub-01/eeg/a_eeg.zarr"], "2026-09-02T00:00:00Z",
        )
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_mutated_manifest_is_rejected(self):
        import jsonschema

        manifest = merge_manifest(
            None, "on007763",
            [{"zarr": "sub-01/eeg/a_eeg.zarr", "source_key": "k", "size_bytes": 1}],
            ["sub-01/eeg/a_eeg.zarr"], "2026-09-02T00:00:00Z",
        )
        manifest["stores"][0]["zarr"] = "sub-01/eeg/a_eeg.set"  # not a store path
        with self.assertRaises(jsonschema.ValidationError):
            validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_the_manifest_records_the_published_events_file(self):
        manifest = merge_manifest(
            None, "on007763", [], [], "2026-09-02T00:00:00Z",
            events_file={"name": EVENTS_PARQUET_NAME, "size_bytes": 4096, "row_count": 3},
        )
        self.assertEqual(manifest["files"][0]["size_bytes"], 4096)
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")
        # No file published, no claim about one: the previous run's object may
        # still be on S3, and this document must not describe it.
        bare = merge_manifest(None, "on007763", [], [], "2026-09-02T00:00:00Z")
        self.assertNotIn("files", bare)
        validate_document(bare, MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_mutated_manifest_file_entry_is_rejected(self):
        import jsonschema

        for mutate in (
            # The enum is what stops this list from quietly becoming a
            # free-form file inventory nobody validates.
            lambda d: d["files"][0].__setitem__("name", "events.pq"),
            lambda d: d["files"][0].__setitem__("size_bytes", -1),
            lambda d: d["files"][0].__setitem__("row_count", -1),
            lambda d: d["files"][0].pop("size_bytes"),
            lambda d: d["files"][0].__setitem__("stray", 1),
        ):
            manifest = merge_manifest(
                None, "on007763", [], [], "2026-09-02T00:00:00Z",
                events_file={"name": EVENTS_PARQUET_NAME, "size_bytes": 1, "row_count": 1},
            )
            with self.subTest(mutation=str(mutate)), self.assertRaises(
                jsonschema.ValidationError
            ):
                mutate(manifest)
                validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")


class TestRealRecordingV3Fields(unittest.TestCase):
    """End-to-end over the STORE-LEVEL functions on a real recording.

    Not `convert_one`: that uploads with `aws s3 sync`, so a whole-run test would
    need S3 credentials and a bucket. Everything between the file and the upload
    is exercised here on real bytes -- biosigIO reads a real EDF, writes a real
    Zarr v3 store, and `store_metadata` reads back the very attrs the index
    republishes. That is the half where a biosigIO attr rename would silently
    empty the new fields.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        cls._tmp = tempfile.TemporaryDirectory()
        d = cls._tmp.name
        cls.recording = build_real_edf(d, "sub-01_task-rest_eeg")
        cls.channels = os.path.join(d, "sub-01_task-rest_channels.tsv")
        with open(cls.channels, "w") as fh:
            fh.writelines(
                ["name\ttype\tunits\n"] + [f"E{i + 1}\tEEG\tV\n" for i in range(4)]
            )
        cls.events = os.path.join(d, "sub-01_task-rest_events.tsv")
        with open(cls.events, "w") as fh:
            fh.writelines(
                ["onset\tduration\ttrial_type\n"]
                + [
                    f"{i * 5.0}\t0.5\t{'go' if i % 2 == 0 else 'stop'}\n"
                    for i in range(6)
                ]
            )
        cls.store = os.path.join(d, "sub-01_task-rest_eeg.zarr")
        convert_recording(
            cls.recording, cls.events, cls.store, channels_local=cls.channels
        )
        cls.meta = store_metadata(cls.store)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_view_geometry_is_republished_from_the_store(self):
        group = self.meta["groups"][0]
        # Without n_view_levels the website reader probes view/1, view/2, ...
        # until a 404 (#1178 item 2).
        self.assertGreaterEqual(group["n_view_levels"], 1)
        # Constant COLUMNS per view chunk is what turns a zoomed-out read from
        # 594 requests into 3 (#1178 item 1, biosigio 1.2.6).
        self.assertEqual(group["view_chunk_columns"], 1024)

    def test_source_rate_is_the_acquisition_rate_not_the_serving_cap(self):
        group = self.meta["groups"][0]
        self.assertEqual(group["source_rate_hz"], 200.0)
        self.assertGreater(group["chunk_samples"], 0)
        self.assertGreater(group["shard_samples"], 0)

    def test_units_report_is_published_when_channels_tsv_was_applied(self):
        report = self.meta["units_report"]
        self.assertIs(report["units_column_present"], True)
        for key in ("converted", "relabelled", "kept_importer_unit"):
            self.assertIsInstance(report[key], int)

    def test_no_units_report_when_no_channels_tsv_applies(self):
        # Absence means "not applied", never "applied cleanly" -- the distinction
        # a consumer needs while the streaming path still cannot apply it.
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "plain_eeg.zarr")
            convert_recording(self.recording, None, store)
            self.assertNotIn("units_report", store_metadata(store))

    def test_events_summary_matches_the_applied_events_tsv(self):
        with open(self.events) as fh:
            summary = events_summary(fh.read())
        self.assertEqual(summary["n_events"], 6)
        self.assertEqual(summary["trial_types"], {"go": 3, "stop": 3})

    def test_provenance_attrs_land_in_the_store_root(self):
        import zarr

        embed_root_attr(
            self.store,
            "nemar",
            nemar_store_attrs(
                dataset_id="on007763",
                source_commit="f" * 40,
                source_tree=source_tree_for("sub-01/eeg/sub-01_task-rest_eeg.edf"),
                derived=False,
                engine_version="2",
                contract_url="https://zarr.nemar.org/on007763/zarr/x.zarr/",
                row={"name": "N", "license": "CC0"},
            ),
        )
        attrs = dict(zarr.open_group(self.store, mode="r").attrs)
        self.assertEqual(attrs["nemar"]["license"], "CC0")
        self.assertEqual(attrs["nemar"]["source_tree"], "raw")
        # biosigIO's own attributes are untouched.
        self.assertEqual(attrs["format"], "biosigio-zarr")
        self.assertIn("channel_groups", attrs)

    def test_sidecar_applies_to_a_recording_with_no_sidecar_beside_it(self):
        """The ADR 0028 MaxShield shape, without needing a MaxShield recording.

        On that path `primary_local` is the Signal-Space-Separated copy at
        `work/sss_<basename>` -- a real file at a path where no channels.tsv is
        adjacent. biosigIO's own `bids_channels="auto"` resolves the sidecar as a
        SIBLING, so it would find nothing there and silently serve importer units
        and MNE-inferred types. This reproduces exactly that geometry with a real
        EDF at a renamed path in an empty directory, and asserts the sidecar still
        reaches the conversion.
        """
        with tempfile.TemporaryDirectory() as d:
            filtered = os.path.join(d, "sss_sub-01_task-rest_eeg.edf")
            shutil.copyfile(self.recording, filtered)
            self.assertEqual(
                [f for f in os.listdir(d) if f.endswith("_channels.tsv")], [],
                "the fixture must have NO sidecar beside the recording",
            )
            store = os.path.join(d, "out.zarr")
            convert_recording(filtered, None, store, channels_local=self.channels)
            report = store_metadata(store)["units_report"]
            self.assertIs(report["units_column_present"], True)

    def test_sibling_auto_detection_is_not_what_applies_the_sidecar(self):
        """A sidecar sitting beside the recording but NOT the one this driver
        resolved must not be picked up: with no sidecar resolved the driver
        passes `bids_channels="off"`, so the only sidecar that can ever shape a
        store is one this driver chose.

        Without this, the SSS test above could pass for the wrong reason on some
        future release whose auto-detection searches more widely -- and a staged
        sidecar would be at risk of being applied twice, which matters because
        adopting a unit CONVERTS samples rather than relabeling them.
        """
        with tempfile.TemporaryDirectory() as d:
            recording = os.path.join(d, "sub-01_task-rest_eeg.edf")
            shutil.copyfile(self.recording, recording)
            # A sibling naming channels the recording does not have: applied, it
            # would report nothing changed; ignored, there is no report at all.
            with open(os.path.join(d, "sub-01_task-rest_channels.tsv"), "w") as fh:
                fh.write("name\ttype\tunits\nNOPE\tEEG\tV\n")
            store = os.path.join(d, "out.zarr")
            convert_recording(recording, None, store)
            self.assertNotIn("units_report", store_metadata(store))

    def test_bids_channels_arg_is_the_path_or_off_never_auto(self):
        """"auto" is biosigIO's default and is always wrong here: it resolves the
        sidecar as a SIBLING of the file the exporter was handed, which is a
        scratch materialization (and, on the MaxShield path, a filtered copy).
        The driver therefore passes the resolved path, or "off" when no sidecar
        applies -- an explicit "there is none" rather than a guess."""
        self.assertEqual(generate_zarr.bids_channels_arg(self.channels), self.channels)
        self.assertEqual(generate_zarr.bids_channels_arg(None), "off")
        self.assertEqual(generate_zarr.bids_channels_arg(""), "off")
        # Staged but missing (a failed sidecar read) is "off", not a path the
        # exporter would raise on.
        self.assertEqual(
            generate_zarr.bids_channels_arg("/no/such/_channels.tsv"), "off"
        )

    def test_the_streaming_exporter_applies_the_sidecar_too(self):
        """The two exporters must not disagree about a recording's units.

        This is the assertion that was impossible on biosigio 1.2.6, whose
        `stream_to_zarr` had no `bids_channels` parameter at all: a dataset's
        small recordings carried the sidecar's units and its large ones carried
        the importer's, which is exactly why the engine bump waited for
        biosigio#128. Now it is an observable property of a real streamed store,
        so a regression on either path fails here rather than being inferred from
        a missing index field.
        """
        if not generate_zarr._EDF_STREAMABLE:
            self.skipTest("installed biosigio does not stream EDF")
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "streamed.zarr")
            saved = generate_zarr.STREAM_EDF_MIN_BYTES
            try:
                # Force the streaming branch for a small real EDF, so this runs
                # the same exporter a multi-GB recording would.
                generate_zarr.STREAM_EDF_MIN_BYTES = 1
                self.assertTrue(
                    generate_zarr.should_stream(self.recording, os.path.getsize(self.recording))
                )
                convert_recording(
                    self.recording, None, store, channels_local=self.channels
                )
            finally:
                generate_zarr.STREAM_EDF_MIN_BYTES = saved
            report = store_metadata(store)["units_report"]
            self.assertIs(report["units_column_present"], True)

    def test_a_streamed_recording_with_no_sidecar_beside_it(self):
        """The MaxShield geometry on the STREAMING path: the exporter is handed a
        filtered copy in a directory with no channels.tsv, and must still apply
        the sidecar the driver resolved. Sibling auto-detection would find
        nothing here."""
        if not generate_zarr._EDF_STREAMABLE:
            self.skipTest("installed biosigio does not stream EDF")
        with tempfile.TemporaryDirectory() as d:
            filtered = os.path.join(d, "sss_sub-01_task-rest_eeg.edf")
            shutil.copyfile(self.recording, filtered)
            self.assertEqual(
                [f for f in os.listdir(d) if f.endswith("_channels.tsv")], [],
                "the fixture must have NO sidecar beside the recording",
            )
            store = os.path.join(d, "out.zarr")
            saved = generate_zarr.STREAM_EDF_MIN_BYTES
            try:
                generate_zarr.STREAM_EDF_MIN_BYTES = 1
                convert_recording(filtered, None, store, channels_local=self.channels)
            finally:
                generate_zarr.STREAM_EDF_MIN_BYTES = saved
            self.assertIs(
                store_metadata(store)["units_report"]["units_column_present"], True
            )

    def test_channels_tsv_resolution_is_shared_with_the_fidelity_gate(self):
        head = {
            "sub-01/eeg/sub-01_task-rest_eeg.edf",
            "sub-01/eeg/sub-01_task-rest_channels.tsv",
            "sub-01/sub-01_channels.tsv",
        }
        self.assertEqual(
            channels_tsv_for("sub-01/eeg/sub-01_task-rest_eeg.edf", head),
            "sub-01/eeg/sub-01_task-rest_channels.tsv",
        )


class TestMainRefusesToPublish(unittest.TestCase):
    """The refuse-to-publish guards must still write a `failed` callback.

    `hallu-zarr.sh` POSTs whatever the callback file contains. A failure path
    that writes NO file posts nothing, so the `converting` signal the driver sent
    when it started the dataset is never superseded and D1 sits at
    `zarr_status='pending'` forever -- the dashboard shows a conversion in flight
    with nothing running. #774 fixed exactly that for the total-failure branch;
    the two schema guards were added later and returned 1 directly, reopening it.

    Drives `main()` end to end: a real git repo, a real (stub) `aws` executable
    on PATH, real argument parsing, real callback file. Only the SCHEMA is
    swapped -- for one that rejects every document -- because a producer bug is
    otherwise not reachable from outside.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        os.makedirs(self.repo)
        def run(*args):
            subprocess.run(args, cwd=self.repo, check=True, capture_output=True)

        run("git", "init", "-q", "-b", "main")
        run("git", "config", "user.email", "t@example.org")
        run("git", "config", "user.name", "t")
        # A dataset with NO recordings: `convert` is empty, so nothing is
        # downloaded or converted and the guard is the only thing under test.
        with open(os.path.join(self.repo, "dataset_description.json"), "w") as fh:
            json.dump({"Name": "guard fixture", "BIDSVersion": "1.8.0"}, fh)
        run("git", "add", "-A")
        run("git", "commit", "-q", "-m", "init")

        # A real executable standing in for `aws`, reporting NoSuchKey so the
        # prior index/manifest reads take their legitimate first-run path. Same
        # approach as TestAwsRunner, which stands python3 in for aws.
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        self.aws = os.path.join(bindir, "aws")
        with open(self.aws, "w") as fh:
            fh.write("#!/bin/sh\necho 'NoSuchKey' >&2\nexit 1\n")
        os.chmod(self.aws, 0o755)
        self._path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + self._path

        self.callback = os.path.join(self.dir, "cb.json")
        self._schemas = (generate_zarr.INDEX_SCHEMA_PATH, generate_zarr.MANIFEST_SCHEMA_PATH)

    def tearDown(self):
        os.environ["PATH"] = self._path
        (generate_zarr.INDEX_SCHEMA_PATH, generate_zarr.MANIFEST_SCHEMA_PATH) = self._schemas
        self._tmp.cleanup()

    def reject_everything(self) -> str:
        """A valid draft 2020-12 schema that no instance satisfies."""
        path = os.path.join(self.dir, "reject.schema.json")
        with open(path, "w") as fh:
            json.dump({"$schema": "https://json-schema.org/draft/2020-12/schema",
                       "not": {}}, fh)
        return path

    def run_main(self) -> int:
        argv = [
            "generate_zarr.py",
            "--dataset-id", "on008083",
            "--repo-dir", self.repo,
            "--bucket", "nemar-test",
            "--callback-out", self.callback,
            "--clean",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return generate_zarr.main()
        finally:
            sys.argv = saved

    def read_callback(self) -> dict:
        self.assertTrue(
            os.path.exists(self.callback),
            "no callback file: the driver would POST nothing and D1 would stay "
            "at zarr_status='pending' forever",
        )
        with open(self.callback) as fh:
            return json.load(fh)

    def assert_failed_shape(self, body: dict):
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["dataset_id"], "on008083")
        # Same shape as the total-failure branch, so the backend's one handler
        # reads all three exits identically.
        for key in (
            "store_count", "commit", "converted", "removed", "errors", "failed",
            "failure_count", "data_failures", "deterministic", "pool_breaks",
            "pending_count", "discovered_count", "not_attempted_count",
            "provenance_fetch_failed",
        ):
            self.assertIn(key, body, key)
        self.assertRegex(body["commit"], r"^[0-9a-f]{40}$")

    def test_a_refused_index_writes_a_failed_callback(self):
        generate_zarr.INDEX_SCHEMA_PATH = self.reject_everything()
        rc = self.run_main()
        self.assertEqual(rc, 1)
        body = self.read_callback()
        self.assert_failed_shape(body)
        # And it names the cause: a schema violation has no per-recording failure
        # to point at, so without this the callback says "failed" and no more.
        self.assertIn("index refused", body["error"])

    def test_a_refused_manifest_writes_a_failed_callback(self):
        generate_zarr.MANIFEST_SCHEMA_PATH = self.reject_everything()
        rc = self.run_main()
        self.assertEqual(rc, 1)
        body = self.read_callback()
        self.assert_failed_shape(body)
        self.assertIn("manifest refused", body["error"])

    def test_a_clean_run_with_nothing_to_convert_publishes(self):
        """The control: with both schemas intact this run reaches the upload.

        Without it the two tests above could pass because `main` failed for some
        unrelated reason -- a missing git object, the stub `aws` -- rather than at
        the guard. Here the stub `aws` fails the UPLOAD, and the callback names a
        DIFFERENT cause from either guard, which is what proves the guards were
        what produced the other two.

        The upload failure used to escape as an uncaught RuntimeError, which is
        the very shape #774 removed everywhere else: the process exits non-zero
        having written no callback file, so `hallu-zarr.sh` POSTs nothing, the
        `converting` signal is never superseded, and D1 sits at
        `zarr_status='pending'` with nothing running. It now goes through
        `write_failed_callback` like every other exit that returns 1.
        """
        rc = self.run_main()
        self.assertEqual(rc, 1)
        body = self.read_callback()
        self.assert_failed_shape(body)
        self.assertIn("index publish failed", body["error"])
        # Not a schema guard: those are the other two tests' cause.
        self.assertNotIn("refused", body["error"])


# A real `aws` stand-in for the converter's main()-level tests: a real
# executable over local files, so `s3_read_json`, `s3_download_file`, `aws_cp`
# and the conditional index read/write pair all run for real, subprocess argv
# included.
#
# `s3api get-object`/`put-object` carry GENUINE ETag semantics -- an object's
# ETag is the md5 of its bytes, and put-object honors `--if-match` /
# `--if-none-match` the way S3 does (412 on a mismatch). That is the same
# stand-in test_purge_non_raw_stores.py uses, and it has to be: the two scripts
# now share one conditional write (`generate_zarr.write_index`), so a stub that
# accepted any condition would let a broken one pass in both suites.
STUB_AWS = r"""#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import sys

ROOT = os.environ["ZARR_TEST_S3_ROOT"]

FLAGS_WITH_VALUES = ("--bucket", "--key", "--body", "--content-type",
                     "--cache-control", "--if-match", "--if-none-match",
                     "--query", "--output")


def local(uri):
    return os.path.join(ROOT, uri.split("/", 3)[3].replace("/", "_"))


def local_key(key):
    return os.path.join(ROOT, key.replace("/", "_"))


def etag(path):
    with open(path, "rb") as fh:
        return chr(34) + hashlib.md5(fh.read()).hexdigest() + chr(34)


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


args = [a for a in sys.argv[1:] if not a.startswith("--cli-")]
args = [a for a in args if a not in ("--only-show-errors",)]
# Every invocation, in order, so a test can assert on what the converter did
# NOT do -- "it never fetched the prior events file" is otherwise unobservable.
log = os.environ.get("ZARR_TEST_S3_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(" ".join(args) + "\n")
# One key made to fail, the way a bucket policy or a transient S3 error would,
# so the converter's own non-fatal handling runs for real.
fail_key = os.environ.get("ZARR_TEST_S3_FAIL_KEY")
if fail_key and any(fail_key in a for a in args):
    sys.stderr.write("An error occurred (InternalError) when calling PutObject\n")
    sys.exit(1)
if args[:2] == ["s3", "cp"]:
    src, dst = args[2], args[3]
    if src.startswith("s3://"):
        path = local(src)
        if not os.path.exists(path):
            sys.stderr.write("NoSuchKey\n")
            sys.exit(1)
        # `-` is a read-to-stdout (s3_read_json); anything else is a real
        # download to a path, and it must stay BYTE-exact -- events.parquet is
        # binary, and a text round-trip through stdout would corrupt it.
        if dst == "-":
            with open(path, "rb") as fh:
                sys.stdout.buffer.write(fh.read())
        else:
            shutil.copyfile(path, dst)
    else:
        shutil.copyfile(src, local(dst))
    sys.exit(0)
if args[:2] == ["s3api", "get-object"]:
    path = local_key(opt(args, "--key"))
    positional = [
        a for i, a in enumerate(args[2:], start=2)
        if not a.startswith("--") and args[i - 1] not in FLAGS_WITH_VALUES
    ]
    if not os.path.exists(path):
        sys.stderr.write("An error occurred (NoSuchKey) when calling GetObject\n")
        sys.exit(1)
    shutil.copyfile(path, positional[0])
    print(etag(path))
    sys.exit(0)
if args[:2] == ["s3api", "put-object"]:
    path = local_key(opt(args, "--key"))
    if "--if-match" in args:
        have = etag(path) if os.path.exists(path) else None
        if have != opt(args, "--if-match"):
            sys.stderr.write(
                "An error occurred (PreconditionFailed) when calling PutObject\n"
            )
            sys.exit(1)
    if "--if-none-match" in args and os.path.exists(path):
        sys.stderr.write(
            "An error occurred (PreconditionFailed) when calling PutObject\n"
        )
        sys.exit(1)
    shutil.copyfile(opt(args, "--body"), path)
    print(json.dumps({"ETag": etag(path)}))
    sys.exit(0)
if args[:2] == ["s3api", "head-object"]:
    print('"deadbeef"')
    sys.exit(0)
sys.exit(0)
"""


class TestMainCleanRunAgainstPriorIndexes(unittest.TestCase):
    """A `--clean` run over a REAL prior index, v1 and v3, through `main()`.

    This is the production path (hallu-zarr.sh always passes `--clean`) and no
    test reached it: every prior-index behavior was exercised through
    `merge_index` directly, which `--clean` hands `prior=None` -- so the facts
    that must survive a clean rebuild travel a route nothing covered. They come
    from the PUBLISHED document rather than from what the merge is given:
    the `pending` attempt counts (reset every run, and a recording could never
    reach the exhaustion cap on the only path production runs), and the count of
    non-raw stores the run drops from the index.

    The stub `aws` is a real executable backed by local files, so `s3_read_json`,
    `aws_cp` and the ETag read all execute.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        os.makedirs(self.repo)
        os.makedirs(self.s3)

        def run(*args):
            subprocess.run(args, cwd=self.repo, check=True, capture_output=True)

        run("git", "init", "-q", "-b", "main")
        run("git", "config", "user.email", "t@example.org")
        run("git", "config", "user.name", "t")
        with open(os.path.join(self.repo, "dataset_description.json"), "w") as fh:
            json.dump({"Name": "clean fixture", "BIDSVersion": "1.8.0"}, fh)
        run("git", "add", "-A")
        run("git", "commit", "-q", "-m", "init")
        self.head = subprocess.run(
            ["git", "-C", self.repo, "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

        # A real `aws` stand-in over local files: `cp s3://... -` reads,
        # `cp <file> s3://...` writes, `s3api head-object` answers the ETag read.
        # The root arrives by environment rather than being baked in, so the
        # script is a fixed file with no interpolation.
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        script = os.path.join(bindir, "aws")
        with open(script, "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(script, 0o755)
        self._env = (os.environ.get("PATH"), os.environ.get("ZARR_TEST_S3_ROOT"))
        os.environ["PATH"] = bindir + os.pathsep + (self._env[0] or "")
        os.environ["ZARR_TEST_S3_ROOT"] = self.s3
        self.callback = os.path.join(self.dir, "cb.json")
        self.log = ""

    def tearDown(self):
        path, root = self._env
        if path is not None:
            os.environ["PATH"] = path
        if root is None:
            os.environ.pop("ZARR_TEST_S3_ROOT", None)
        else:
            os.environ["ZARR_TEST_S3_ROOT"] = root
        self._tmp.cleanup()

    def put(self, key, doc):
        with open(os.path.join(self.s3, "on008083_zarr_" + key), "w") as fh:
            json.dump(doc, fh)

    def published(self, key):
        path = os.path.join(self.s3, "on008083_zarr_" + key)
        self.assertTrue(os.path.exists(path), key + " was not published")
        with open(path) as fh:
            return json.load(fh)

    def prior_v3(self, **overrides):
        doc = {
            "dataset_id": "on008083", "format": "nemar-zarr-index",
            "format_version": 3, "source_commit": "a" * 40,
            "store_count": 0, "stores": [], "failure_count": 0, "failures": [],
            "pending_count": 0, "pending": [],
        }
        doc.update(overrides)
        return doc

    def run_main(self):
        argv = [
            "generate_zarr.py",
            "--dataset-id", "on008083",
            "--repo-dir", self.repo,
            "--bucket", "nemar-test",
            "--callback-out", self.callback,
            "--clean",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = generate_zarr.main()
            self.log = out.getvalue()
            return rc
        finally:
            sys.argv = saved

    def callback_body(self):
        with open(self.callback) as fh:
            return json.load(fh)

    def test_a_clean_run_over_a_v1_prior_index(self):
        # The realistic first re-conversion: what is on S3 today is v1.
        self.put("index.json", {
            "dataset_id": "on008083", "format": "nemar-zarr-index",
            "format_version": 1, "source_commit": "a" * 40, "store_count": 1,
            "stores": [{"path": "sub-01/eeg/a_eeg.edf",
                        "zarr": "sub-01/eeg/a_eeg.zarr",
                        "source_key": "SHA256E-s1--a"}],
            "failure_count": 0, "failures": [],
        })
        self.assertEqual(self.run_main(), 0)
        index = self.published("index.json")
        self.assertEqual(index["format_version"], 3)
        self.assertEqual(index["source_commit"], self.head)
        # The v1 entry's recording is not at HEAD, so it does not carry -- and
        # its `source_key` is nowhere in the v3 document.
        self.assertEqual(index["store_count"], 0)
        self.assertNotIn("source_key", json.dumps(index))
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        validate_document(self.published("manifest.json"), MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_clean_run_over_a_v3_prior_index(self):
        self.put("index.json", self.prior_v3())
        self.assertEqual(self.run_main(), 0)
        index = self.published("index.json")
        self.assertEqual(index["format_version"], 3)
        self.assertEqual(index["engine_version"], ZARR_ENGINE_VERSION)
        self.assertEqual(index["layout"]["level0"], "<zarr>/<group>/0")
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_the_manifest_is_published_alongside_the_index(self):
        self.put("index.json", self.prior_v3())
        self.put("manifest.json", {
            "format": "nemar-zarr-manifest", "format_version": 1,
            "dataset_id": "on008083", "updated_utc": "2026-09-01T00:00:00Z",
            "stores": [{"zarr": "sub-01/eeg/a_eeg.zarr",
                        "source_key": "SHA256E-s1--a", "size_bytes": 1}],
        })
        self.assertEqual(self.run_main(), 0)
        manifest = self.published("manifest.json")
        # Restricted to the rels the index publishes, so the two documents can
        # never disagree about which stores exist. Nothing is served here, so
        # the stale entry goes.
        self.assertEqual(manifest["stores"], [])
        self.assertEqual(manifest["dataset_id"], "on008083")
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_pending_attempts_are_read_from_the_published_index(self):
        """The fact `--clean` would otherwise reset on every run.

        `main` sources `prior_pending` from the document it read, not from what
        it hands the merge -- which under `--clean` is `None`. Without that, a
        recording failing for an infra reason would restart at attempt 1 forever
        and `retry_exhausted` would be unreachable in production.
        """
        path = "sub-01/eeg/a_eeg.edf"
        self.put("index.json", self.prior_v3(
            pending_count=1,
            pending=[{"path": path, "zarr": store_rel_for(path),
                      "reason": "infra_failure", "attempts": 4,
                      "last_error": "RuntimeError: boom",
                      "last_attempt_utc": "2026-09-01T00:00:00Z"}],
        ))
        self.assertEqual(self.run_main(), 0)
        # The recording is not at HEAD any more, so the entry drops rather than
        # aging -- what is asserted here is that `main` READ it: the attempt
        # history reached the merge, which is the wiring `--clean` breaks.
        self.assertEqual(self.published("index.json")["pending_count"], 0)
        # And the merge does age it when the recording IS still discovered,
        # through the same argument main passes.
        index = merge_index(
            None, "on008083", self.head, [], [], "2026-09-02T00:00:00Z", [],
            [{"path": path, "reason": "infra_failure", "last_error": "boom"}],
            discovered=[path],
            prior_pending=self.prior_v3(
                pending=[{"path": path, "reason": "infra_failure", "attempts": 4}]
            )["pending"],
        )
        # 4 + 1 == PENDING_MAX_ATTEMPTS, so this is the round that promotes it.
        self.assertEqual(index["pending_count"], 0)
        self.assertEqual(index["failures"][0]["code"], "retry_exhausted")
        self.assertEqual(index["failures"][0]["attempts"], PENDING_MAX_ATTEMPTS)

    def test_non_raw_stores_are_dropped_reported_and_logged(self):
        self.put("index.json", self.prior_v3(
            store_count=2,
            stores=[
                {"path": "derivatives/prep/a_eeg.set",
                 "zarr": "derivatives/prep/a_eeg.zarr",
                 "source_tree": "raw", "derived": False},
                {"path": "sourcedata/b_eeg.set", "zarr": "sourcedata/b_eeg.zarr",
                 "source_tree": "raw", "derived": False},
            ],
        ))
        self.assertEqual(self.run_main(), 0)
        body = self.callback_body()
        self.assertEqual(body["non_raw_dropped"], 2)
        # Named in the log, with the tree, so the count has a cause attached.
        self.assertIn("derivatives/prep/a_eeg.set", self.log)
        self.assertIn("sourcedata", self.log)
        index = self.published("index.json")
        self.assertEqual(index["stores"], [])
        self.assertNotIn("legacy_store_count", index)

    def test_the_callback_reports_every_new_field(self):
        self.put("index.json", self.prior_v3())
        self.assertEqual(self.run_main(), 0)
        body = self.callback_body()
        for key in (
            "pending_count", "discovered_count", "not_attempted_count",
            "non_raw_dropped", "provenance_fetch_failed", "manifest_upload_failed",
        ):
            self.assertIn(key, body, key)
        self.assertEqual(body["status"], "ready")
        self.assertIs(body["manifest_upload_failed"], False)
        # Nothing to convert, so the catalog was never read: not a failure.
        self.assertIs(body["provenance_fetch_failed"], False)

    def test_a_missing_prior_index_is_the_first_run_path(self):
        # No document at all: the stub reports NoSuchKey, which must read as
        # "first run" rather than raising.
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.published("index.json")["store_count"], 0)
        self.assertEqual(self.callback_body()["non_raw_dropped"], 0)

    # --- The index publish is a conditional write ------------------------
    #
    # Two processes write `<id>/zarr/index.json`: a converter run and
    # `purge_non_raw_stores.py`. Both read it, work for minutes to hours, then
    # write back what they merged from that read, so an unconditional PUT from
    # either silently reverts the other -- restoring the 4,721 non-raw stores a
    # purge had just dropped, or losing a conversion's new stores while their
    # chunks sit on S3 unreferenced. Both exit 0; nothing anywhere says so.
    #
    # The stub `aws` carries real ETag semantics (md5 of the bytes, 412 on a
    # mismatch), so these drive the actual condition rather than a flag.

    def object_etag(self, key="index.json"):
        """The ETag the stub reports for a published object: md5 of its bytes,
        the same rule the stub's `put-object` and `get-object` use."""
        with open(os.path.join(self.s3, "on008083_zarr_" + key), "rb") as fh:
            return hashlib.md5(fh.read()).hexdigest()

    def log_aws_calls(self):
        """Capture every `aws` argv, in order -- the only way to see that the
        retry actually RE-READ the document rather than resending the same body.
        """
        path = os.path.join(self.dir, "aws.log")
        os.environ["ZARR_TEST_S3_LOG"] = path
        self.addCleanup(lambda: os.environ.pop("ZARR_TEST_S3_LOG", None))
        return lambda: [
            line.strip() for line in open(path) if os.path.exists(path)
        ] if os.path.exists(path) else []

    def publish_competitor_before(self, reads):
        """Publish a DIFFERENT document immediately after the run's first
        `reads` index reads, the way a concurrent purge would.

        Wrapping the real `read_index_with_etag` is the only way to open the
        window deterministically: the ETag the run holds is invalidated after it
        was read and before it is used, which is exactly the race. Nothing in the
        conditional write itself is replaced -- the stub `aws` decides the 412.
        """
        original = generate_zarr.read_index_with_etag
        seen = {"reads": 0}

        def read_then_publish(bucket, dataset_id):
            index, etag = original(bucket, dataset_id)
            seen["reads"] += 1
            if seen["reads"] <= reads:
                # A DIFFERENT body each time (the ETag is the md5 of the bytes),
                # so a second competing write really does invalidate the ETag the
                # retry just read -- republishing identical bytes would leave the
                # ETag unchanged and quietly turn the two-conflict case into the
                # one-conflict case.
                self.put("index.json", self.prior_v3(
                    source_commit="c" * 40, competitor_round=seen["reads"],
                ))
            return index, etag

        generate_zarr.read_index_with_etag = read_then_publish
        self.addCleanup(setattr, generate_zarr, "read_index_with_etag", original)
        return seen

    def test_the_index_publish_is_conditional_on_the_etag_it_read(self):
        self.put("index.json", self.prior_v3())
        calls = self.log_aws_calls()
        self.assertEqual(self.run_main(), 0)
        puts = [c for c in calls() if c.startswith("s3api put-object") and "index.json" in c]
        self.assertEqual(len(puts), 1)
        # The read's ETag, sent back verbatim: an unconditional PUT is what this
        # replaces, and `--if-none-match "*"` here would 412 on every run over an
        # existing document.
        self.assertIn("--if-match", puts[0])
        self.assertNotIn("--if-none-match", puts[0])
        # The callback reports the ETag the PUT itself returned, so it names the
        # version this run wrote rather than whatever a follow-up read would see.
        self.assertEqual(self.callback_body()["index_etag"], self.object_etag())

    def test_a_first_publish_is_conditional_on_there_being_no_document(self):
        calls = self.log_aws_calls()
        self.assertEqual(self.run_main(), 0)
        puts = [c for c in calls() if c.startswith("s3api put-object") and "index.json" in c]
        self.assertEqual(len(puts), 1)
        # `if_match=None` is not "skip the check": it means the object was absent
        # at read time, so a first index published in the meantime is not
        # clobbered either.
        self.assertIn("--if-none-match", puts[0])
        self.assertEqual(self.callback_body()["index_etag"], self.object_etag())

    def test_a_lost_race_is_re_read_re_merged_and_published(self):
        self.put("index.json", self.prior_v3())
        calls = self.log_aws_calls()
        seen = self.publish_competitor_before(reads=1)
        self.assertEqual(self.run_main(), 0)
        # Two reads and two writes: the first write 412'd, and the retry read the
        # NEWER document before recomputing. One read would mean it resent the
        # same body against a fresh ETag, which is the silent clobber wearing a
        # condition.
        self.assertEqual(seen["reads"], 2)
        gets = [c for c in calls() if c.startswith("s3api get-object") and "index.json" in c]
        puts = [c for c in calls() if c.startswith("s3api put-object") and "index.json" in c]
        self.assertEqual(len(gets), 2)
        self.assertEqual(len(puts), 2)
        self.assertIn("re-reading and re-merging once", self.log)
        # This run's document is what ends up published, and the callback names
        # the ETag of the retry's write.
        published = self.published("index.json")
        self.assertEqual(published["source_commit"], self.head)
        self.assertEqual(self.callback_body()["index_etag"], self.object_etag())
        self.assertEqual(self.callback_body()["status"], "ready")
        check_index_invariant(published)
        validate_document(published, INDEX_SCHEMA_PATH, "index")
        # The manifest rides the same publish, so it is not left describing the
        # first attempt's store set.
        validate_document(self.published("manifest.json"), MANIFEST_SCHEMA_PATH, "manifest")

    def test_losing_the_race_twice_fails_loudly_and_publishes_nothing(self):
        self.put("index.json", self.prior_v3())
        seen = self.publish_competitor_before(reads=2)
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(seen["reads"], 2)
        # The other writer's LATEST document is what survives: a third attempt
        # has no reason to win, and overwriting from a body that is already stale
        # again is the rollback this whole mechanism exists to prevent.
        survivor = self.published("index.json")
        self.assertEqual(survivor["source_commit"], "c" * 40)
        self.assertEqual(survivor["competitor_round"], 2)
        # And it is LOUD: the driver POSTs this file, so a run that published
        # nothing must not leave D1 at `converting` forever (#774).
        body = self.callback_body()
        self.assertEqual(body["status"], "failed")
        self.assertIn("index publish conflict", body["error"])
        self.assertIn("::error::", self.log)
        # The manifest is not published either -- it would describe stores the
        # surviving index does not list.
        self.assertFalse(
            os.path.exists(os.path.join(self.s3, "on008083_zarr_manifest.json")),
            "a run that published no index must not publish its manifest",
        )


class TestMainPublishesEventsParquet(unittest.TestCase):
    """`main()` over a real recording, through to `<id>/zarr/events.parquet`.

    The entry point, not the writer: everything the file depends on is derived by
    code the unit tests do not reach -- the worker parses the events.tsv, `record`
    turns it into rows against the entry's OWN groups, `main` orders them by the
    index's store list, uploads, and only then names the file in index.json. A
    writer test cannot catch a `record` that stages nothing.

    Same shape as TestMainCleanRunAgainstPriorIndexes: a real git repo, a real
    stub `aws` over local files, real argument parsing. `--local` reads the
    working tree, so no annex download is needed.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import pyarrow  # noqa: F401
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        eeg = os.path.join(self.repo, "sub-01", "ses-1", "eeg")
        os.makedirs(eeg)
        os.makedirs(self.s3)
        self.primary = "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_eeg.edf"
        build_real_edf(eeg, "sub-01_ses-1_task-rest_run-2_eeg", seconds=30)
        self.onsets = [i * 3.0 + 0.111 for i in range(5)]
        with open(os.path.join(eeg, "sub-01_ses-1_task-rest_run-2_events.tsv"), "w") as fh:
            fh.writelines(
                ["onset\tduration\ttrial_type\tstim_file\n"]
                + [
                    f"{onset}\t0.5\t{'go' if i % 2 == 0 else 'stop'}\tim{i}.png\n"
                    for i, onset in enumerate(self.onsets)
                ]
            )

        def run(*args):
            subprocess.run(args, cwd=self.repo, check=True, capture_output=True)

        run("git", "init", "-q", "-b", "main")
        run("git", "config", "user.email", "t@example.org")
        run("git", "config", "user.name", "t")
        run("git", "add", "-A")
        run("git", "commit", "-q", "-m", "init")

        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        script = os.path.join(bindir, "aws")
        with open(script, "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(script, 0o755)
        self._env = (os.environ.get("PATH"), os.environ.get("ZARR_TEST_S3_ROOT"))
        os.environ["PATH"] = bindir + os.pathsep + (self._env[0] or "")
        os.environ["ZARR_TEST_S3_ROOT"] = self.s3
        # Every `aws` invocation, in order: the only way to assert that a run
        # did NOT fetch the prior events file.
        self.aws_log = os.path.join(self.dir, "aws.log")
        os.environ["ZARR_TEST_S3_LOG"] = self.aws_log
        self.callback = os.path.join(self.dir, "cb.json")

    def tearDown(self):
        path, root = self._env
        if path is not None:
            os.environ["PATH"] = path
        if root is None:
            os.environ.pop("ZARR_TEST_S3_ROOT", None)
        else:
            os.environ["ZARR_TEST_S3_ROOT"] = root
        os.environ.pop("ZARR_TEST_S3_LOG", None)
        os.environ.pop("ZARR_TEST_S3_FAIL_KEY", None)
        self._tmp.cleanup()

    def aws_calls(self) -> list[str]:
        if not os.path.exists(self.aws_log):
            return []
        with open(self.aws_log) as fh:
            return [ln for ln in fh.read().splitlines() if ln.strip()]

    def downloads_of(self, name: str) -> list[str]:
        """Calls that READ `name` from S3 (`cp s3://... <dest>`), not writes."""
        return [
            call
            for call in self.aws_calls()
            if call.startswith("s3 cp s3://") and name in call.split()[2]
        ]

    def add_store(self, sub: str, onsets: list[float] | None) -> str:
        """A second/third recording in the same repo, with or without events.
        Returns its repo-relative primary path (uncommitted -- the caller
        commits, so a test controls which run sees it)."""
        eeg = os.path.join(self.repo, sub, "eeg")
        os.makedirs(eeg, exist_ok=True)
        stem = f"{sub}_task-rest_eeg"
        build_real_edf(eeg, stem, seconds=10)
        if onsets is not None:
            with open(os.path.join(eeg, f"{sub}_task-rest_events.tsv"), "w") as fh:
                fh.writelines(
                    ["onset\tduration\ttrial_type\n"]
                    + [f"{onset}\t0.2\tgo\n" for onset in onsets]
                )
        return f"{sub}/eeg/{stem}.edf"

    def commit(self, message: str) -> None:
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", message], cwd=self.repo, check=True,
            capture_output=True,
        )

    def run_main(self, *extra):
        argv = [
            "generate_zarr.py",
            "--dataset-id", "on007763",
            "--repo-dir", self.repo,
            "--bucket", "nemar-test",
            "--callback-out", self.callback,
            "--local",
            # Nothing is listening there, so the catalog read fails fast instead
            # of reaching the real api.nemar.org from a unit test.
            "--api-base", "http://127.0.0.1:1",
            *extra,
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = generate_zarr.main()
            self.log = out.getvalue()
            return rc
        finally:
            sys.argv = saved

    def published(self, key):
        path = os.path.join(self.s3, "on007763_zarr_" + key)
        self.assertTrue(os.path.exists(path), key + " was not published")
        return path

    def index(self):
        with open(self.published("index.json")) as fh:
            return json.load(fh)

    def callback_body(self):
        with open(self.callback) as fh:
            return json.load(fh)

    def events_table(self):
        import pyarrow.parquet as pq

        return pq.read_table(self.published(EVENTS_PARQUET_NAME)).to_pydict()

    def test_a_clean_run_publishes_the_file_and_names_it_in_the_index(self):
        self.assertEqual(self.run_main("--clean"), 0)
        index = self.index()
        rel = store_rel_for(self.primary)
        self.assertEqual(index["store_count"], 1)
        # The index names the file only because it was uploaded first, so the
        # pointer can never precede the object.
        self.assertEqual(index["events_parquet"], index["data_base"] + EVENTS_PARQUET_NAME)
        self.assertEqual(index["events_row_count"], 5)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

        table = self.events_table()
        self.assertEqual(table["store_path"], [rel] * 5)
        # Joins to stores[].zarr, which is the whole point of the column.
        self.assertEqual({index["stores"][0]["zarr"]}, set(table["store_path"]))
        rate = index["stores"][0]["groups"][0]["rate"]
        self.assertEqual(
            table["sample_index"], [sample_index_for(o, rate) for o in self.onsets]
        )
        self.assertEqual(set(table["group_name"]), {index["stores"][0]["groups"][0]["name"]})
        self.assertEqual(table["subject"], ["01"] * 5)
        self.assertEqual(table["session"], ["1"] * 5)
        self.assertEqual(table["run"], ["2"] * 5)
        # A pass-through column keeps its own name.
        self.assertEqual(table["stim_file"], [f"im{i}.png" for i in range(5)])
        # And the per-store summary agrees with the rows, because one parse made
        # both (#1060's last acceptance criterion).
        self.assertEqual(index["stores"][0]["n_events"], 5)
        self.assertEqual(index["stores"][0]["trial_types"], {"go": 3, "stop": 2})

    def test_the_callback_reports_the_row_count(self):
        self.assertEqual(self.run_main("--clean"), 0)
        body = self.callback_body()
        self.assertEqual(body["events_row_count"], 5)
        self.assertIs(body["events_upload_failed"], False)

    def test_the_manifest_records_the_bytes_the_run_wrote(self):
        """The index says the file exists and how many rows it has; the producer
        manifest says how many BYTES this run uploaded, so "the object on S3 is
        the one this conversion wrote" is a HEAD away rather than a download."""
        self.assertEqual(self.run_main("--clean"), 0)
        with open(self.published("manifest.json")) as fh:
            manifest = json.load(fh)
        self.assertEqual(len(manifest["files"]), 1)
        entry = manifest["files"][0]
        self.assertEqual(entry["name"], EVENTS_PARQUET_NAME)
        self.assertEqual(entry["row_count"], 5)
        self.assertEqual(
            entry["size_bytes"], os.path.getsize(self.published(EVENTS_PARQUET_NAME))
        )
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_run_that_publishes_no_file_claims_no_bytes(self):
        # The previous run's file may still be on S3; the manifest must not
        # inherit its size and read as though this run wrote it.
        self.assertEqual(self.run_main("--clean"), 0)
        published = self.published(EVENTS_PARQUET_NAME)
        with open(published, "wb") as fh:
            fh.write(b"not a parquet file")
        self.assertEqual(self.run_main(), 0)
        with open(self.published("manifest.json")) as fh:
            manifest = json.load(fh)
        self.assertNotIn("files", manifest)
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_an_incremental_run_carries_the_rows_forward(self):
        """The store is not reconverted, so the published file is the only place
        its events exist -- exactly like its entry in the index."""
        self.assertEqual(self.run_main("--clean"), 0)
        first = os.path.getmtime(self.published(EVENTS_PARQUET_NAME))
        # Second run at the same commit: nothing to convert, everything carried.
        time.sleep(0.01)
        self.assertEqual(self.run_main(), 0)
        index = self.index()
        self.assertEqual(index["store_count"], 1)
        self.assertEqual(index["events_row_count"], 5)
        self.assertGreater(os.path.getmtime(self.published(EVENTS_PARQUET_NAME)), first)
        table = self.events_table()
        self.assertEqual(table["onset_s"], self.onsets)
        self.assertEqual(table["stim_file"], [f"im{i}.png" for i in range(5)])
        self.assertNotIn("contribute no rows", self.log)

    def test_a_dataset_with_no_events_publishes_no_file(self):
        """Absent means absent: a client must not fetch a file to learn there are
        no events, and `events_parquet` is what says whether to fetch at all."""
        os.remove(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ))
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-q", "-m", "drop events"],
                       cwd=self.repo, check=True, capture_output=True)
        self.assertEqual(self.run_main("--clean"), 0)
        index = self.index()
        self.assertNotIn("events_parquet", index)
        self.assertNotIn("events_row_count", index)
        self.assertFalse(os.path.exists(
            os.path.join(self.s3, "on007763_zarr_" + EVENTS_PARQUET_NAME)
        ))
        self.assertIsNone(self.callback_body()["events_row_count"])
        self.assertIs(self.callback_body()["events_upload_failed"], False)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_reconverted_store_that_lost_its_events_publishes_no_rows(self):
        """The carry-forward defect. "Carried over" has to mean "this run did
        not rebuild it", not "this run produced no rows for it": a store whose
        events.tsv was deleted IS rebuilt, produces nothing, and must not have
        its old rows resurrected from the published file forever."""
        keeper = self.add_store("sub-02", [1.0, 2.0])
        self.commit("add a second store with events")
        self.assertEqual(self.run_main("--clean"), 0)
        rel = store_rel_for(self.primary)
        self.assertEqual(len(set(self.events_table()["store_path"])), 2)

        os.remove(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ))
        self.commit("drop the first store's events")
        self.assertEqual(self.run_main("--clean"), 0)
        table = self.events_table()
        # The reconverted store is gone from the file; the untouched one is not.
        self.assertNotIn(rel, set(table["store_path"]))
        self.assertEqual(set(table["store_path"]), {store_rel_for(keeper)})
        self.assertEqual(self.index()["events_row_count"], 2)
        # ...and it is not reported as an unrecoverable carry-over, because it
        # was not carried over at all.
        self.assertNotIn("contribute no rows", self.log)

    def test_a_first_clean_run_never_fetches_a_prior_for_event_less_stores(self):
        """A store with no events.tsv is reconverted like any other, so it is
        not "carried over" and there is nothing to carry: a first run must not
        fetch a prior file (there is none) or warn about stores it just built."""
        self.add_store("sub-03", None)  # no events.tsv at all
        self.commit("add an event-less store")
        self.assertEqual(self.run_main("--clean"), 0)
        self.assertEqual(self.index()["store_count"], 2)
        self.assertEqual(self.index()["events_row_count"], 5)
        self.assertNotIn("contribute no rows", self.log)
        self.assertEqual(self.downloads_of(EVENTS_PARQUET_NAME), [])

    def test_an_onset_past_the_end_is_published_unclamped(self):
        """A client bound-checks against groups[].n_samples; a clamped index
        would be indistinguishable from an event on the last sample."""
        with open(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ), "a") as fh:
            fh.write("999.0\t0.5\tlate\tim9.png\n")  # the recording is 30 s
        self.commit("add an event past the end")
        self.assertEqual(self.run_main("--clean"), 0)
        index = self.index()
        group = index["stores"][0]["groups"][0]
        table = self.events_table()
        late = table["sample_index"][table["trial_type"].index("late")]
        self.assertEqual(late, sample_index_for(999.0, group["rate"]))
        self.assertGreater(late, group["n_samples"])

    def test_a_store_whose_onsets_all_fail_to_parse_is_warned_and_counted(self):
        """Rows with nothing but null sample indices are events a client cannot
        epoch, and the row count alone cannot show it."""
        with open(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ), "w") as fh:
            fh.write("onset\tduration\ttrial_type\n")
            fh.writelines(["n/a\t0.5\tgo\n", "later\t0.5\tstop\n"])
        self.commit("break every onset")
        self.assertEqual(self.run_main("--clean"), 0)
        self.assertIn("no usable sample index for any event", self.log)
        self.assertEqual(self.callback_body()["events_stores_without_rows"], 1)
        table = self.events_table()
        self.assertEqual(table["sample_index"], [None, None])

    def test_a_healthy_run_counts_no_store_without_rows(self):
        # The control: the counter is 0 on the ordinary path, so the assertion
        # above is about the condition and not about the field always being 1.
        self.assertEqual(self.run_main("--clean"), 0)
        self.assertEqual(self.callback_body()["events_stores_without_rows"], 0)

    def test_a_refused_index_uploads_no_events_file(self):
        """Schema first, uploads second. A refused index means this run
        publishes NOTHING -- and events.parquet is a destructive overwrite of a
        file the live index still describes, so it must not already be gone by
        the time the index is rejected."""
        self.assertEqual(self.run_main("--clean"), 0)
        published = self.published(EVENTS_PARQUET_NAME)
        with open(published, "rb") as fh:
            before = fh.read()
        with open(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ), "a") as fh:
            fh.write("29.0\t0.5\textra\tim9.png\n")  # would change the bytes
        self.commit("add an event")
        reject = os.path.join(self.dir, "reject.schema.json")
        with open(reject, "w") as fh:
            json.dump({"$schema": "https://json-schema.org/draft/2020-12/schema",
                       "not": {}}, fh)
        saved = generate_zarr.INDEX_SCHEMA_PATH
        try:
            generate_zarr.INDEX_SCHEMA_PATH = reject
            self.assertEqual(self.run_main("--clean"), 1)
        finally:
            generate_zarr.INDEX_SCHEMA_PATH = saved
        body = self.callback_body()
        self.assertEqual(body["status"], "failed")
        self.assertIn("index refused", body["error"])
        self.assertIsNone(body["events_row_count"])
        self.assertIs(body["events_upload_failed"], False)
        # The object on S3 is untouched: same bytes as the good run left.
        with open(published, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_an_upload_that_precedes_a_rejection_is_reported_on_the_callback(self):
        """The interleaving that CAN still overwrite: a document that passes the
        pre-flight (row count 0) and fails on the real count. The file is
        replaced and the index is refused, so the callback is the only place
        that can say an object was rewritten by a run that published nothing."""
        schema = os.path.join(self.dir, "row-count-zero.schema.json")
        with open(schema, "w") as fh:
            json.dump({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": {"events_row_count": {"const": 0}},
            }, fh)
        saved = generate_zarr.INDEX_SCHEMA_PATH
        try:
            generate_zarr.INDEX_SCHEMA_PATH = schema
            self.assertEqual(self.run_main("--clean"), 1)
        finally:
            generate_zarr.INDEX_SCHEMA_PATH = saved
        body = self.callback_body()
        self.assertEqual(body["status"], "failed")
        self.assertIn("index refused", body["error"])
        # The upload DID happen before the refusal, and the callback says so.
        self.assertEqual(body["events_row_count"], 5)
        self.assertIs(body["events_upload_failed"], False)
        self.assertTrue(os.path.exists(
            os.path.join(self.s3, "on007763_zarr_" + EVENTS_PARQUET_NAME)
        ))
        # ...and no index was published at all.
        self.assertFalse(os.path.exists(os.path.join(self.s3, "on007763_zarr_index.json")))

    def test_a_failed_events_upload_leaves_no_pointer_and_does_not_fail_the_run(self):
        """ADR 0005: the stores and index.json are the serving copy. A failed
        events upload is reported, the index names no file (the object on S3 is
        the older one), and the run still publishes."""
        os.environ["ZARR_TEST_S3_FAIL_KEY"] = EVENTS_PARQUET_NAME
        # aws_cp retries with backoff; one attempt is enough here and keeps the
        # test from sleeping through 14 seconds of real backoff.
        saved = generate_zarr._aws.__kwdefaults__["retries"]
        try:
            generate_zarr._aws.__kwdefaults__["retries"] = 1
            self.assertEqual(self.run_main("--clean"), 0)
        finally:
            generate_zarr._aws.__kwdefaults__["retries"] = saved
            os.environ.pop("ZARR_TEST_S3_FAIL_KEY", None)
        index = self.index()
        self.assertEqual(index["store_count"], 1)
        self.assertNotIn("events_parquet", index)
        self.assertNotIn("events_row_count", index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        body = self.callback_body()
        self.assertEqual(body["status"], "ready")
        self.assertIs(body["events_upload_failed"], True)
        self.assertIsNone(body["events_row_count"])
        self.assertIn("events.parquet was not published", self.log)
        self.assertFalse(os.path.exists(
            os.path.join(self.s3, "on007763_zarr_" + EVENTS_PARQUET_NAME)
        ))

    def test_without_pyarrow_the_run_succeeds_and_publishes_no_events(self):
        """The Hallu fallback install (biosigio only, no requirements.txt) has
        no pyarrow. That must cost the events file and nothing else -- not the
        conversion, and not a `failed` flag, since nothing was attempted."""
        saved = sys.modules.get("pyarrow", "absent")
        try:
            # A real import failure, in the import system, not a patched
            # function: `None` in sys.modules is what CPython raises ImportError
            # for, which is exactly what a venv without the package does.
            sys.modules["pyarrow"] = None  # type: ignore[assignment]
            self.assertEqual(self.run_main("--clean"), 0)
        finally:
            if saved == "absent":
                sys.modules.pop("pyarrow", None)
            else:
                sys.modules["pyarrow"] = saved
        index = self.index()
        self.assertEqual(index["store_count"], 1)
        self.assertNotIn("events_parquet", index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        body = self.callback_body()
        self.assertEqual(body["status"], "ready")
        self.assertIsNone(body["events_row_count"])
        self.assertIs(body["events_upload_failed"], False)
        self.assertIn("pyarrow is not installed", self.log)

    def test_an_unreadable_prior_file_is_reported_not_fatal(self):
        """ADR 0005: the stores and index.json are the serving copy, so a failure
        to produce this one is reported and the run still publishes.

        The index then names NO file -- deliberately. The object on S3 is the
        older one, and pointing at it from a new index would claim rows for
        stores this run's index may not describe. A `--clean` run rebuilds it
        from scratch, which is the recovery.
        """
        self.assertEqual(self.run_main("--clean"), 0)
        published = self.published(EVENTS_PARQUET_NAME)
        with open(published, "wb") as fh:
            fh.write(b"not a parquet file")
        self.assertEqual(self.run_main(), 0)  # incremental: every store carried
        index = self.index()
        self.assertEqual(index["store_count"], 1)
        self.assertNotIn("events_parquet", index)
        self.assertNotIn("events_row_count", index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        body = self.callback_body()
        self.assertEqual(body["status"], "ready")
        self.assertIsNone(body["events_row_count"])
        # The flag is what separates "this dataset has no events" from "we could
        # not say what its events are".
        self.assertIs(body["events_upload_failed"], True)
        self.assertIn("events.parquet was not published", self.log)
        # The unreadable object is left exactly as it was rather than being
        # overwritten with a half-built file.
        with open(published, "rb") as fh:
            self.assertEqual(fh.read(), b"not a parquet file")


class TestConvertOneEndToEnd(unittest.TestCase):
    """`convert_one` in LOCAL mode over a real recording, up to the upload.

    The store entry is assembled here -- `store_metadata`'s spread, the events
    summary, the `units_report` annotation, the SSS flags -- and every test of
    those pieces called them individually. So the assembly itself, which is
    where a key gets mis-set or dropped, was covered by nothing.

    `--local` reads the working tree directly (the Hallu path after `nemar
    dataset download`), so no S3 is needed until the `aws s3 sync`, which the
    stub below absorbs. Everything before it is the real code on real bytes.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.eeg = os.path.join(self.repo, "sub-01", "eeg")
        os.makedirs(self.eeg)
        self.primary = "sub-01/eeg/sub-01_task-rest_eeg.edf"
        build_real_edf(self.eeg, "sub-01_task-rest_eeg", seconds=30)
        with open(os.path.join(self.eeg, "sub-01_task-rest_channels.tsv"), "w") as fh:
            fh.writelines(
                ["name\ttype\tunits\n"] + [f"E{i + 1}\tEEG\tV\n" for i in range(4)]
            )
        with open(os.path.join(self.eeg, "sub-01_task-rest_events.tsv"), "w") as fh:
            fh.writelines(
                ["onset\tduration\ttrial_type\n"]
                + [f"{i * 2.0}\t0.5\t{'go' if i % 2 == 0 else 'stop'}\n"
                   for i in range(8)]
            )
        # `aws s3 sync` is the only external call convert_one makes in local
        # mode; a real no-op executable absorbs it.
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        self._path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + self._path
        self._work = tempfile.TemporaryDirectory()

    def tearDown(self):
        os.environ["PATH"] = self._path
        self._work.cleanup()
        self._tmp.cleanup()

    def convert(self, head_files=None, dataset_row=None, provenance_failed=False):
        files = head_files if head_files is not None else {
            self.primary,
            "sub-01/eeg/sub-01_task-rest_channels.tsv",
            "sub-01/eeg/sub-01_task-rest_events.tsv",
        }
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "on007763",
            "head": "b" * 40, "head_files": files, "local": True,
            "tmp": self._work.name, "updated": "2026-09-02T00:00:00Z",
            "contract_base": "https://zarr.nemar.org",
            "engine_version": "3",
            "dataset_row": dataset_row,
            "provenance_fetch_failed": provenance_failed,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        return convert_one(self.primary)

    def test_the_entry_carries_the_sidecar_annotation(self):
        result = self.convert()
        self.assertTrue(result["ok"], result.get("error"))
        entry = result["entry"]
        report = entry["units_report"]
        # Which sidecar shaped the store, and that the CONVERTER chose it rather
        # than the exporter stumbling on a sibling -- two separate claims, both
        # of which matter on the MaxShield path where sibling detection finds
        # nothing.
        self.assertIs(report["sidecar_supplied"], True)
        self.assertEqual(report["sidecar"], "sub-01/eeg/sub-01_task-rest_channels.tsv")
        self.assertIs(report["units_column_present"], True)
        self.assertNotIn("channels_tsv_read_error", entry)

    def test_the_entry_is_a_complete_v3_store_entry(self):
        entry = self.convert()["entry"]
        self.assertEqual(entry["path"], self.primary)
        self.assertEqual(entry["zarr"], store_rel_for(self.primary))
        self.assertEqual(entry["source_tree"], "raw")
        self.assertIs(entry["derived"], False)
        self.assertEqual(entry["n_events"], 8)
        self.assertEqual(entry["trial_types"], {"go": 4, "stop": 4})
        self.assertEqual(entry["modalities"], ["eeg"])
        self.assertGreaterEqual(entry["groups"][0]["n_view_levels"], 1)
        # And `source_key` is NOT here: it moved to the manifest (#1178 item 5).
        self.assertNotIn("source_key", entry)
        self.assertIn("source_key", self.convert()["manifest"])

    def test_the_entry_validates_inside_a_real_index(self):
        # The assembled entry has to satisfy the closed store schema, which is
        # what the producer enforces before publishing.
        entry = self.convert()["entry"]
        index = merge_index(
            None, "on007763", "b" * 40, [entry], [], "2026-09-02T00:00:00Z",
            [], [], discovered=[self.primary],
        )
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_sidecar_that_over_declares_still_publishes_the_faithful_store(self):
        """channels.tsv listing channels the file never had (on004789's bipolar
        micro-contacts, on006914's 6-of-128) must not withhold a store holding
        every channel the file declares. The disagreement is disclosed on the
        entry, and the entry still satisfies the closed schema."""
        with open(os.path.join(self.eeg, "sub-01_task-rest_channels.tsv"), "w") as fh:
            fh.writelines(
                ["name\ttype\tunits\n"] + [f"E{i + 1}\tEEG\tV\n" for i in range(6)]
            )
        result = self.convert()
        self.assertTrue(result["ok"], result.get("error"))
        entry = result["entry"]
        self.assertEqual(
            entry["channels_tsv_count_mismatch"],
            {"channels_tsv": 6, "in_file": 4, "in_store": 4},
        )
        index = merge_index(
            None, "on007763", "b" * 40, [entry], [], "2026-09-02T00:00:00Z",
            [], [], discovered=[self.primary],
        )
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_agreeing_counts_add_no_mismatch_note(self):
        self.assertNotIn("channels_tsv_count_mismatch", self.convert()["entry"])

    def test_a_latin1_channels_tsv_converts_instead_of_retrying_forever(self):
        """on005691: `µV` written as the Latin-1 byte 0xb5. The strict UTF-8
        read raised uncoded from convert_one, so the job retried forever."""
        generate_zarr._NON_UTF8_WARNED.clear()  # the warning is once per path
        with open(os.path.join(self.eeg, "sub-01_task-rest_channels.tsv"), "wb") as fh:
            fh.write(
                ("name\ttype\tunits\n" + "".join(f"E{i + 1}\tEEG\tµV\n" for i in range(4)))
                .encode("latin-1")
            )
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = self.convert()
        self.assertTrue(result["ok"], result.get("error"))
        entry = result["entry"]
        self.assertNotIn("channels_tsv_count_mismatch", entry)
        self.assertNotIn("channels_tsv_read_error", entry)
        self.assertIs(entry["units_report"]["sidecar_supplied"], True)
        self.assertIn("sub-01_task-rest_channels.tsv is not valid UTF-8", out.getvalue())

    def test_an_unreadable_sidecar_is_recorded_not_collapsed(self):
        """A channels.tsv that APPLIES but cannot be read must not look like a
        dataset that ships none: both leave `units_report` absent, and only one
        of them means the store is serving importer units unintentionally."""
        # Declared at HEAD, absent from the working tree and from git: the read
        # fails the way a pack/tree desync would.
        files = {self.primary, "sub-01/sub-01_channels.tsv"}
        entry = self.convert(head_files=files)["entry"]
        self.assertIs(entry["channels_tsv_read_error"], True)
        self.assertNotIn("units_report", entry)

    def test_it_converts_with_a_failed_provenance_fetch(self):
        """A catalog outage must not cost a conversion.

        The store's `nemar` attrs then carry nulls plus
        `provenance_fetch_failed: true`; that the flag lands in the ATTRS is
        asserted in TestRealRecordingV3Fields (the store is deleted by
        `convert_one`'s `finally`, so it cannot be read back from here). What
        this covers is the path itself: the flag threads through the worker
        context without breaking the conversion.
        """
        result = self.convert(dataset_row=None, provenance_failed=True)
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["entry"]["path"], self.primary)


class TestConvertOneStreamsIntoItsOwnScratch(unittest.TestCase):
    """The real exporter, driven by the real `convert_one`: the memmap directory it
    is handed is the recording's own `.scratch` sibling of its store, and nothing
    of it, the store or the work directory outlives the call. `stream_to_zarr` is
    wrapped only to see its arguments; the real function still does the work."""

    PRIMARY = "sub-01/meg/sub-01_task-rest_meg.fif"

    @classmethod
    def setUpClass(cls):
        try:
            import biosigio  # noqa: F401
            import mne  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        os.makedirs(os.path.join(self.repo, "sub-01", "meg"))
        build_real_fif(os.path.join(self.repo, self.PRIMARY))
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)
        # Any size streams: the point is the streaming path, not the threshold.
        self.addCleanup(setattr, generate_zarr, "STREAM_MIN_BYTES", generate_zarr.STREAM_MIN_BYTES)
        generate_zarr.STREAM_MIN_BYTES = 0

    def test_the_memmap_goes_to_the_recordings_own_scratch_and_is_removed(self):
        import biosigio

        work_root = os.path.join(self._tmp.name, "work")
        os.makedirs(work_root)
        work, store_local, scratch = generate_zarr.recording_scratch_paths(
            work_root, self.PRIMARY
        )
        seen: dict = {}
        real = biosigio.stream_to_zarr

        # Names `exclude_subject_info` as the real exporter does, or `write_store`
        # refuses it before the call (#1626), and passes it on.
        def spy(*args, exclude_subject_info=False, **kwargs):
            seen["scratch_dir"] = kwargs.get("scratch_dir")
            seen["existed"] = os.path.isdir(kwargs.get("scratch_dir") or "")
            seen["store"] = args[1] if len(args) > 1 else None
            seen["exclude_subject_info"] = exclude_subject_info
            return real(*args, exclude_subject_info=exclude_subject_info, **kwargs)

        biosigio.stream_to_zarr = spy
        self.addCleanup(setattr, biosigio, "stream_to_zarr", real)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "on000117",
            "head": "b" * 40, "head_files": {self.PRIMARY}, "local": True,
            "tmp": work_root, "updated": "2026-10-06T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": "3",
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        with contextlib.redirect_stdout(io.StringIO()):
            result = convert_one(self.PRIMARY)
        self.assertTrue(result["ok"], result.get("error"))
        self.assertTrue(seen, "the streaming path was not taken")
        self.assertIs(seen["exclude_subject_info"], True)
        self.assertEqual(seen["scratch_dir"], scratch)
        self.assertEqual(seen["scratch_dir"], store_local + generate_zarr.SCRATCH_DIR_SUFFIX)
        self.assertTrue(
            seen["existed"], "the directory must exist before the exporter makes a temp dir in it"
        )
        self.assertEqual(os.path.dirname(seen["scratch_dir"]), os.path.dirname(seen["store"]))
        for path in (work, store_local, scratch):
            self.assertFalse(os.path.exists(path), f"{path} outlived convert_one")
        stores_parent = os.path.dirname(store_local)
        leftovers = [n for n in os.listdir(stores_parent)] if os.path.isdir(stores_parent) else []
        self.assertEqual(leftovers, [], "nothing may remain beside the store")


    def test_a_volume_that_fills_under_the_exporter_is_an_uncoded_failure_and_leaves_nothing(self):
        # The case the admission gate exists to avoid, and what happens when it
        # misses: the exporter has made its memmap and half a store when the volume
        # fills. Today that is an uncoded infrastructure failure, which spends one of
        # a recording's five attempts (whether it should defer instead is a design
        # question, not decided here). Whatever the classification, nothing may stay
        # on the disk that just filled.
        #
        # The exporter is made to raise at the library boundary: a really full volume
        # needs root to create. Everything after that point is the real convert_one.
        import biosigio

        work_root = os.path.join(self._tmp.name, "work")
        os.makedirs(work_root)
        work, store_local, scratch = generate_zarr.recording_scratch_paths(
            work_root, self.PRIMARY
        )
        real = biosigio.stream_to_zarr

        # Names `exclude_subject_info` like the real exporter, or `write_store`
        # refuses it before the call and the volume never fills (#1626).
        def full_volume(*args, exclude_subject_info=False, **kwargs):
            with open(os.path.join(kwargs["scratch_dir"], "memmap.dat"), "wb") as fh:
                fh.write(b"x" * 4096)
            os.makedirs(args[1], exist_ok=True)
            with open(os.path.join(args[1], "zarr.json"), "wb") as fh:
                fh.write(b"{}")
            raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))

        biosigio.stream_to_zarr = full_volume
        self.addCleanup(setattr, biosigio, "stream_to_zarr", real)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "on000117",
            "head": "b" * 40, "head_files": {self.PRIMARY}, "local": True,
            "tmp": work_root, "updated": "2026-10-07T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": "3",
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        with contextlib.redirect_stdout(io.StringIO()):
            result = convert_one(self.PRIMARY)
        self.assertFalse(result["ok"])
        self.assertIsNone(result["code"], "uncoded, so it is an infrastructure failure")
        self.assertIn("No space left on device", result["error"])
        for path in (work, store_local, scratch):
            self.assertFalse(os.path.exists(path), f"{path} outlived the failed conversion")


class TestConvertOneFifSidecarOvercount(unittest.TestCase):
    """on000117 through `convert_one`: an MEG channels.tsv listing channels its
    FIF never had (CHPI coils, EEG inherited from another run) was refused as
    `channel_count_mismatch` because FIF had no header count. A real FIF, a
    real conversion; only `aws s3 sync` is absorbed, as in
    TestConvertOneEndToEnd."""

    PRIMARY = "sub-01/meg/sub-01_task-rest_meg.fif"
    TSV = "sub-01/meg/sub-01_task-rest_channels.tsv"

    @classmethod
    def setUpClass(cls):
        try:
            import mne  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        meg = os.path.join(self.repo, "sub-01", "meg")
        os.makedirs(meg)
        build_real_fif(os.path.join(self.repo, self.PRIMARY))
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        # The aws stand-in records its argv, so a test can tell whether a store
        # was ever pushed.
        self.aws_log = os.path.join(self._tmp.name, "aws.log")
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(f'#!/bin/sh\necho "$*" >> "{self.aws_log}"\nexit 0\n')
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)

    def synced(self) -> bool:
        if not os.path.exists(self.aws_log):
            return False
        with open(self.aws_log) as fh:
            return any(line.startswith("s3 sync") for line in fh)

    def convert(self, tsv_rows: int):
        with open(os.path.join(self.repo, self.TSV), "w") as fh:
            fh.writelines(
                ["name\ttype\tunits\n"] + [f"CH{i:03d}\tMISC\tV\n" for i in range(tsv_rows)]
            )
        work = os.path.join(self._tmp.name, "work")
        os.makedirs(work, exist_ok=True)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "on000117",
            "head": "b" * 40, "head_files": {self.PRIMARY, self.TSV}, "local": True,
            "tmp": work, "updated": "2026-09-28T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": "3",
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        return convert_one(self.PRIMARY)

    def test_an_over_declaring_sidecar_publishes_and_discloses(self):
        n = len(FIF_CHANNELS)
        result = self.convert(n + 9)  # nine phantom channels, as on000117's CHPI00x
        self.assertTrue(result["ok"], result.get("error"))
        self.assertTrue(self.synced())
        entry = result["entry"]
        self.assertEqual(
            entry["channels_tsv_count_mismatch"],
            {"channels_tsv": n + 9, "in_file": n, "in_store": n},
        )
        index = merge_index(
            None, "on000117", "b" * 40, [entry], [], "2026-09-28T00:00:00Z",
            [], [], discovered=[self.PRIMARY],
        )
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_the_overcount_exemption_never_launders_an_unreadable_fif(self):
        # The load-bearing guarantee is that a store SHORT of the file is still
        # withheld. It cannot be driven end to end with a real FIF: MNE refuses
        # a FIF whose nchan disagrees with its channel definitions ("Incorrect
        # number of channel definitions found"), and biosigIO maps every MNE
        # channel type (unknown ones to MISC/OTHER), so a readable FIF always
        # converts to exactly its header's channels. `channel_gate_verdict`
        # covers the `truncated` branch directly. What CAN be driven is the
        # other way the header count goes missing, a FIF MNE cannot parse:
        # with a sidecar over-declaring it, it must be refused before any
        # store exists, never reach the gate's "header unknown" path and publish.
        # biosigIO 1.2.13 types a FIF cut short in its data `corrupt_or_truncated`
        # through `Recording.from_file`; the other two cases keep the probe's codes.
        header_codes = ("maxshield_probe_failed", "file_read_error")
        cases = {
            "garbage header": (lambda data: b"not a fif header at all", header_codes),
            "header cut short": (lambda data: data[:600], header_codes),
            "data cut short": (lambda data: data[: len(data) // 2], ("corrupt_or_truncated",)),
        }
        path = os.path.join(self.repo, self.PRIMARY)
        with open(path, "rb") as fh:
            original = fh.read()
        for name, (corrupt, codes) in cases.items():
            with self.subTest(name):
                with open(path, "wb") as fh:
                    fh.write(corrupt(original))
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    result = self.convert(len(FIF_CHANNELS) + 9)
                self.assertFalse(result["ok"])
                self.assertIn(result["code"], codes)
                self.assertNotIn("entry", result)
                self.assertFalse(self.synced())

    def test_a_matching_sidecar_adds_no_note(self):
        result = self.convert(len(FIF_CHANNELS))
        self.assertTrue(result["ok"], result.get("error"))
        self.assertNotIn("channels_tsv_count_mismatch", result["entry"])


class TestConvertOneEeglabSidecarOvercount(unittest.TestCase):
    """on003645 through `convert_one`: a dataset mixing MEG `.fif` and EEG
    `.set`, whose subject-level channels.tsv lists the 404 MEG channels and is
    inherited by the EEG recordings. Their `.set` files hold 75 channels, and
    with no header count for `.set` all 108 were refused as
    `channel_count_mismatch`. Real `.set` files, a real conversion; only
    `aws s3 sync` is absorbed, and logged so a test can tell whether a store
    was pushed."""

    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.set"
    TSV = "sub-01/sub-01_task-rest_channels.tsv"  # subject level: inherited
    N = 3

    @classmethod
    def setUpClass(cls):
        try:
            import h5py  # noqa: F401
            import scipy.io  # noqa: F401
            import zarr  # noqa: F401
            from biosigio import Recording  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        self.aws_log = os.path.join(self._tmp.name, "aws.log")
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(f'#!/bin/sh\necho "$*" >> "{self.aws_log}"\nexit 0\n')
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)

    def synced(self) -> bool:
        if not os.path.exists(self.aws_log):
            return False
        with open(self.aws_log) as fh:
            return any(line.startswith("s3 sync") for line in fh)

    def write_set(self, **kwargs) -> str:
        kwargs.setdefault("nbchan", self.N)
        return build_eeglab_set(os.path.join(self.repo, self.PRIMARY), **kwargs)

    def convert(self, tsv_rows: int):
        os.makedirs(os.path.join(self.repo, "sub-01"), exist_ok=True)
        with open(os.path.join(self.repo, self.TSV), "w") as fh:
            fh.writelines(
                ["name\ttype\tunits\n"] + [f"MEG{i:04d}\tMEGMAG\tT\n" for i in range(tsv_rows)]
            )
        work = os.path.join(self._tmp.name, "work")
        os.makedirs(work, exist_ok=True)
        # The tree tracks what is on disk: a `.set` that keeps its samples in a
        # `.fdt` has that `.fdt` in the dataset (`require_companions` asks the tree).
        fdt = os.path.splitext(self.PRIMARY)[0] + ".fdt"
        tracked = {self.PRIMARY, self.TSV}
        if os.path.exists(os.path.join(self.repo, fdt)):
            tracked.add(fdt)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "on003645",
            "head": "b" * 40, "head_files": tracked, "local": True,
            "tmp": work, "updated": "2026-09-29T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": "3",
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = convert_one(self.PRIMARY)
        result["_log"] = out.getvalue()
        return result

    def assert_published_with_note(self, result, tsv_rows: int):
        self.assertTrue(result["ok"], result.get("error"))
        self.assertTrue(self.synced())
        entry = result["entry"]
        self.assertEqual(
            entry["channels_tsv_count_mismatch"],
            {"channels_tsv": tsv_rows, "in_file": self.N, "in_store": self.N},
        )
        index = merge_index(
            None, "on003645", "b" * 40, [entry], [], "2026-09-29T00:00:00Z",
            [], [], discovered=[self.PRIMARY],
        )
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_an_over_declaring_inherited_sidecar_publishes_and_discloses(self):
        cases = {
            "classic, samples inline": {},
            "classic, samples in a .fdt": {"fdt": True},
            "classic, fields flat": {"wrapped": False},
            "v7.3, samples inline": {"v73": True},
            "v7.3, samples in a .fdt": {"v73": True, "fdt": True},
        }
        for name, kwargs in cases.items():
            for tsv_rows in (404, 9):
                with self.subTest(name, channels_tsv=tsv_rows):
                    self.write_set(**kwargs)
                    if os.path.exists(self.aws_log):
                        os.remove(self.aws_log)
                    self.assert_published_with_note(self.convert(tsv_rows), tsv_rows)

    def test_a_matching_sidecar_adds_no_note(self):
        for kwargs in ({}, {"fdt": True}, {"v73": True}):
            with self.subTest(**kwargs):
                self.write_set(**kwargs)
                result = self.convert(self.N)
                self.assertTrue(result["ok"], result.get("error"))
                self.assertNotIn("channels_tsv_count_mismatch", result["entry"])

    def test_without_a_usable_header_the_strict_gate_still_refuses(self):
        # nbchan 5 over a 3-row matrix: biosigIO serves the 3 rows, and the
        # header vouches for nothing, so the gate is channels.tsv alone again,
        # exactly as for every `.set` before the header count existed.
        self.write_set(nbchan=5, rows=self.N)
        result = self.convert(404)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "channel_count_mismatch")
        self.assertIn("channels.tsv declares 404", result["error"])
        self.assertNotIn("header declares", result["error"])
        self.assertIn("could not read the EEGLAB header", result["_log"])
        self.assertFalse(self.synced())

    def test_a_corrupt_set_is_refused_before_any_store_exists(self):
        p = self.write_set()
        with open(p, "rb") as fh:
            original = fh.read()
        with open(p, "wb") as fh:
            fh.write(original[: len(original) // 2])
        result = self.convert(404)
        self.assertFalse(result["ok"])
        self.assertNotIn("entry", result)
        self.assertFalse(self.synced())


class TestSidecarJoinReport(unittest.TestCase):
    """`channels_tsv_names` + `sidecar_join_report`, the pure half of what
    `convert_one` adds to `units_report`. `TestDuplicateLabelsThroughConvertOne`
    drives the same thing through a real conversion."""

    def test_names_keep_repeats_and_file_order(self):
        text = "name\ttype\tunits\nT8-P8\tEEG\tV\n\nT8-P8\tEEG\tV\n -\tMISC\tn/a\n"
        self.assertEqual(channels_tsv_names(text), ["T8-P8", "T8-P8", "-"])

    def test_names_are_read_with_pandas_quoting(self):
        # biosigIO reads channels.tsv with pandas, which honors `"` quoting:
        # a quoted name loses its quotes and keeps a quoted tab, and a lone
        # quote inside a cell is literal. A plain split would disagree.
        text = 'name\ttype\n"Fp1"\tEEG\n"A\tB"\tEEG\n  C \tEEG\nD"x\tEEG\n'
        self.assertEqual(channels_tsv_names(text), ["Fp1", "A\tB", "C", 'D"x'])
        try:  # the conversion tier has pandas; the fast tier does not
            import pandas as pd
        except ImportError:
            return
        frame = pd.read_csv(io.StringIO(text), sep="\t", dtype=str, keep_default_na=False)
        self.assertEqual(channels_tsv_names(text), [n.strip() for n in frame["name"]])

    def test_no_name_column_means_no_join(self):
        self.assertIsNone(channels_tsv_names("label\ttype\nA\tEEG\n"))
        self.assertIsNone(channels_tsv_names(""))
        # biosigIO matches the header exactly, so this reader does too.
        self.assertIsNone(channels_tsv_names("Name\ttype\nA\tEEG\n"))

    def test_a_full_match_is_a_positive_zero(self):
        self.assertEqual(
            sidecar_join_report(CHB_MIT_SUFFIXED, CHB_MIT_SUFFIXED, {}),
            {"unmatched_channels": 0},
        )

    def test_no_store_labels_is_no_join_not_a_zero(self):
        # A store whose groups record no labels: nothing was joined, and a
        # 0 would claim every channel met a row.
        self.assertEqual(sidecar_join_report([], ["A", "B"], {}), {})

    def test_repeated_store_labels_are_each_counted(self):
        # A list, not a set: two channels the sidecar misses are two.
        report = sidecar_join_report(["A", "A", "B"], ["B"], {})
        self.assertEqual(report["unmatched_channels"], 2)

    def test_a_sidecar_naming_the_file_label_is_reported(self):
        renames = {"T8-P8-0": "T8-P8", "T8-P8-1": "T8-P8"}
        report = sidecar_join_report(
            ["FP1-F7", "T8-P8-0", "T8-P8-1"], ["FP1-F7", "T8-P8", "T8-P8"], renames
        )
        self.assertEqual(report, {
            "unmatched_channels": 2, "unmatched_raw_label": 2,
            "unmatched_examples": ["T8-P8-0", "T8-P8-1"],
        })

    def test_a_case_only_difference_is_reported(self):
        report = sidecar_join_report(["FP1-F7", "F7-T7"], ["Fp1-F7", "F7-T7"], {})
        self.assertEqual(report, {
            "unmatched_channels": 1, "unmatched_case_only": 1,
            "unmatched_examples": ["FP1-F7"],
        })

    def test_a_case_only_match_biosigio_reported_is_not_unmatched(self):
        # biosigio 1.2.10 applied `Fp1-F7` to `FP1-F7` and said so; a row it
        # left alone (`t8` against `T8`, ambiguous there) is still unmatched
        # and still case-only. The map is biosigIO's own
        # `matched_case_insensitive`, `{sidecar_name: channel_label}`.
        #
        # The end-to-end proof, on the real biosigIO requirements.txt installs,
        # is the canary in TestDuplicateLabelsThroughConvertOne.
        report = sidecar_join_report(
            ["FP1-F7", "F7-T7", "T8"],
            ["Fp1-F7", "F7-T7", "t8"],
            {},
            {"Fp1-F7": "FP1-F7"},
        )
        self.assertEqual(report, {
            "unmatched_channels": 1, "unmatched_case_only": 1,
            "unmatched_examples": ["T8"],
        })
        # Without the map the same inputs count both, which is 1.2.9's truth.
        self.assertEqual(
            sidecar_join_report(["FP1-F7", "F7-T7", "T8"], ["Fp1-F7", "F7-T7", "t8"], {})[
                "unmatched_channels"
            ],
            2,
        )

    def test_renamed_labels_inherit_a_position_and_override_nothing(self):
        positions = {"Fp1": [1.0, 2.0, 3.0], "Fp1-1": [9.0, 9.0, 9.0]}
        out = generate_zarr.positions_for_renamed_labels(
            positions, {"Fp1-0": "Fp1", "Fp1-1": "Fp1", "--0": "-"}
        )
        self.assertEqual(out, {
            "Fp1": [1.0, 2.0, 3.0],
            "Fp1-0": [1.0, 2.0, 3.0],
            "Fp1-1": [9.0, 9.0, 9.0],  # the sidecar named it; left as it is
        })
        self.assertEqual(positions, {"Fp1": [1.0, 2.0, 3.0], "Fp1-1": [9.0, 9.0, 9.0]})

    def test_the_example_bound_is_the_published_schema_bound(self):
        # The JSON Schema spells the same bound as `maxItems`; a converter
        # that named more examples would fail its own pre-upload validation.
        # The two zod mirrors are tied to this constant on the TypeScript
        # side (test/zarr-schema-contract.test.ts, mcp-schema-parity).
        with open(INDEX_SCHEMA_PATH, encoding="utf-8") as fh:
            schema = json.load(fh)
        units = schema["$defs"]["store"]["properties"]["units_report"]["properties"]
        self.assertEqual(
            units["unmatched_examples"]["maxItems"], generate_zarr.UNMATCHED_EXAMPLES_MAX
        )

    def test_the_case_match_map_is_published_as_a_count_and_examples(self):
        # biosigio >= 1.2.10's `matched_case_insensitive` is one entry per
        # matched channel; the index carries a count and a bounded sample,
        # and the full map comes back for the join report.
        n = 300
        full = {f"ch{i:03d}": f"CH{i:03d}" for i in range(n)}
        biosigio_report = {
            "converted": n, "relabelled": 0, "kept_importer_unit": 0,
            "units_column_present": True, "matched_case_insensitive": full,
        }
        published, matches = bound_units_report(biosigio_report)
        self.assertEqual(matches, full)
        self.assertNotIn("matched_case_insensitive", published)
        self.assertEqual(published["matched_case_only"], n)
        self.assertEqual(
            published["matched_case_only_examples"],
            [f"ch{i:03d} -> CH{i:03d}" for i in range(generate_zarr.CASE_MATCH_EXAMPLES_MAX)],
        )
        # Every other key biosigIO reported is republished as it was.
        for key in ("converted", "relabelled", "kept_importer_unit", "units_column_present"):
            self.assertEqual(published[key], biosigio_report[key])
        # The input is not mutated: it is the store's own attribute.
        self.assertIs(biosigio_report["matched_case_insensitive"], full)

    def test_no_case_match_leaves_the_report_as_biosigio_wrote_it(self):
        report = {"converted": 2, "relabelled": 0, "kept_importer_unit": 0,
                  "units_column_present": True}
        self.assertEqual(bound_units_report(report), (report, {}))

    def test_a_case_match_value_of_an_unknown_shape_is_dropped(self):
        # Never republished as is, and it matched nothing this code can name.
        published, matches = bound_units_report(
            {"converted": 1, "matched_case_insensitive": ["Fp1-F7"]}
        )
        self.assertEqual(published, {"converted": 1})
        self.assertEqual(matches, {})

    def test_the_case_match_example_bound_is_the_published_schema_bound(self):
        with open(INDEX_SCHEMA_PATH, encoding="utf-8") as fh:
            schema = json.load(fh)
        units = schema["$defs"]["store"]["properties"]["units_report"]["properties"]
        self.assertEqual(
            units["matched_case_only_examples"]["maxItems"],
            generate_zarr.CASE_MATCH_EXAMPLES_MAX,
        )

    def test_examples_are_bounded(self):
        labels = [f"X{i}" for i in range(12)]
        report = sidecar_join_report(labels, [], {})
        self.assertEqual(report["unmatched_channels"], 12)
        self.assertEqual(report["unmatched_examples"], labels[:generate_zarr.UNMATCHED_EXAMPLES_MAX])
        self.assertNotIn("unmatched_case_only", report)
        self.assertNotIn("unmatched_raw_label", report)


def biosigio_matches_case_only_rows() -> bool:
    """Whether the installed biosigIO applies a channels.tsv row to a channel
    whose label differs from the row's name only in case (biosigio#136).

    Asked of biosigIO itself on a real EDF and a real sidecar, through
    `Recording.from_file`, and answered from the account it gives of its own
    join: 1.2.10 records `matched_case_insensitive` under `channels_tsv_units`
    when it matched that way, 1.2.9 has no such key. No conversion by this
    repo's code is involved, so the answer cannot depend on what it is used to
    check."""
    from biosigio import Recording

    with tempfile.TemporaryDirectory() as tmp:
        edf = build_labeled_edf(os.path.join(tmp, "probe.edf"), ["FP1-F7", "F7-T7"])
        tsv = os.path.join(tmp, "probe_channels.tsv")
        with open(tsv, "w") as fh:
            fh.write("name\ttype\tunits\nFp1-F7\tEEG\tV\nF7-T7\tEEG\tV\n")
        rec = Recording.from_file(edf, bids_channels=tsv)
    return "matched_case_insensitive" in rec.metadata.get("channels_tsv_units", {})


class TestDuplicateLabelsThroughConvertOne(unittest.TestCase):
    """A REAL EDF that repeats a label, CHB-MIT shaped, through `convert_one`.

    biosigio >= 1.2.9 suffixes each repeat MNE-style (`T8-P8` -> `T8-P8-0`,
    `T8-P8-1`; `-` -> `--0`, `--1`, ...). Before it, a repeat overwrote a
    channel and the store came up short of the file (nm000110: 22 of 23).
    `aws` is a stand-in that copies a synced store aside, so the test can open
    what would have been uploaded; nothing else is substituted."""

    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.edf"
    TSV = "sub-01/eeg/sub-01_task-rest_channels.tsv"

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
            from biosigio import __version__ as biosigio_version
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        parts = tuple(int(p) for p in biosigio_version.split(".")[:3] if p.isdigit())
        if parts < (1, 2, 9):
            raise unittest.SkipTest(
                f"biosigio {biosigio_version} predates repeated-label suffixing (1.2.9)"
            )

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        os.makedirs(os.path.join(self.repo, "sub-01", "eeg"))
        build_labeled_edf(os.path.join(self.repo, self.PRIMARY), CHB_MIT_LABELS)
        self.extra_head_files: set[str] = set()
        self.synced_dir = os.path.join(self._tmp.name, "synced")
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(
                "#!/bin/sh\n"
                'if [ "$1" = s3 ] && [ "$2" = sync ]; then\n'
                f'  mkdir -p "{self.synced_dir}" && cp -R "$3" "{self.synced_dir}/"\n'
                "fi\nexit 0\n"
            )
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)
        saved_ctx = dict(generate_zarr._CTX)
        self.addCleanup(lambda: (generate_zarr._CTX.clear(), generate_zarr._CTX.update(saved_ctx)))

    def convert(self, tsv_names: list[str] | None):
        head_files = {self.PRIMARY, *self.extra_head_files}
        if tsv_names is not None:
            with open(os.path.join(self.repo, self.TSV), "w") as fh:
                fh.writelines(["name\ttype\tunits\n"] + [f"{n}\tEEG\tV\n" for n in tsv_names])
            head_files.add(self.TSV)
        work = os.path.join(self._tmp.name, "work")
        os.makedirs(work, exist_ok=True)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "nm000110",
            "head": "c" * 40, "head_files": head_files, "local": True,
            "tmp": work, "updated": "2026-09-28T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": ZARR_ENGINE_VERSION,
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        with contextlib.redirect_stdout(io.StringIO()) as out:
            result = convert_one(self.PRIMARY)
        return result, out.getvalue()

    def synced_store(self, entry: dict):
        import zarr

        return zarr.open_group(
            os.path.join(self.synced_dir, os.path.basename(entry["zarr"])), mode="r"
        )

    def store_units(self, entry: dict) -> dict[str, str]:
        root = self.synced_store(entry)
        return {
            ch["label"]: ch.get("unit")
            for g in root.attrs["channel_groups"]
            for ch in root[g].attrs["channels"]
        }

    def test_every_repeated_label_is_served_on_both_exporters(self):
        # The sidecar names the channels exactly as MNE (and so MNE-BIDS)
        # suffixes them. Both exporters, because either can take an EDF: the
        # streaming one above STREAM_EDF_MIN_BYTES, here lowered to 1 byte.
        saved = generate_zarr.STREAM_EDF_MIN_BYTES
        self.addCleanup(setattr, generate_zarr, "STREAM_EDF_MIN_BYTES", saved)
        for path_name, threshold in (("in-memory", saved), ("streaming", 1)):
            with self.subTest(path_name):
                generate_zarr.STREAM_EDF_MIN_BYTES = threshold
                shutil.rmtree(self.synced_dir, ignore_errors=True)
                result, out = self.convert(CHB_MIT_SUFFIXED)
                self.assertTrue(result["ok"], result.get("error"))
                entry = result["entry"]

                # Every channel the file declares, under the suffixed labels,
                # so the channel-count gate passed with nothing to disclose.
                self.assertEqual(store_total_channels(entry), len(CHB_MIT_LABELS))
                self.assertNotIn("channels_tsv_count_mismatch", entry)
                root = self.synced_store(entry)
                labels = [
                    ch["label"]
                    for g in root.attrs["channel_groups"]
                    for ch in root[g].attrs["channels"]
                ]
                self.assertEqual(labels, CHB_MIT_SUFFIXED)

                # The sidecar reached the suffixed channels: every unit is the
                # sidecar's V rather than the file's uV, and nothing went unmatched.
                self.assertEqual(set(self.store_units(entry).values()), {"V"})
                report = entry["units_report"]
                self.assertEqual(report["converted"], len(CHB_MIT_LABELS))
                self.assertEqual(report["unmatched_channels"], 0)
                self.assertNotIn("names no row", out)

                # biosigIO's record of what it renamed, in the store itself.
                self.assertEqual(
                    root.attrs["recording_metadata"]["channel_labels_deduplicated"],
                    {"--0": "-", "--1": "-", "--2": "-",
                     "T8-P8-0": "T8-P8", "T8-P8-1": "T8-P8"},
                )

                index = merge_index(
                    None, "nm000110", "c" * 40, [entry], [], "2026-09-28T00:00:00Z",
                    [], [], discovered=[self.PRIMARY],
                )
                check_index_invariant(index)
                validate_document(index, INDEX_SCHEMA_PATH, "index")
                manifest = merge_manifest(
                    None, "nm000110", [result["manifest"]], [entry["zarr"]],
                    "2026-09-28T00:00:00Z",
                )
                validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_sidecar_naming_the_file_label_is_disclosed(self):
        # A sidecar that names the repeat the way the FILE spells it: nothing
        # can tell which row meant which channel, so biosigIO applies neither,
        # and the entry now says so instead of reporting a clean conversion.
        result, out = self.convert(CHB_MIT_LABELS)
        self.assertTrue(result["ok"], result.get("error"))
        report = result["entry"]["units_report"]
        self.assertEqual(report["unmatched_channels"], 5)  # 3 x `-`, 2 x T8-P8
        self.assertEqual(report["unmatched_raw_label"], 5)
        self.assertEqual(report["unmatched_examples"], ["--0", "T8-P8-0", "--1", "T8-P8-1", "--2"])
        units = self.store_units(result["entry"])
        self.assertEqual(units["T8-P8-0"], "uV")  # the importer's, not the sidecar's
        self.assertEqual(units["FP1-F7"], "V")
        self.assertIn("names no row for 5 store channel(s)", out)

    def test_repeated_electrodes_keep_their_position(self):
        # A monopolar repeat: `Fp1` twice in the file, served as Fp1-0/Fp1-1,
        # while electrodes.tsv names the electrode once, as `Fp1`.
        build_labeled_edf(os.path.join(self.repo, self.PRIMARY), ["Fp1", "F7", "Fp1"])
        elec = "sub-01/eeg/sub-01_electrodes.tsv"
        with open(os.path.join(self.repo, elec), "w") as fh:
            fh.write("name\tx\ty\tz\nFp1\t-0.03\t0.08\t0.0\nF7\t-0.07\t0.04\t0.0\n")
        self.extra_head_files = {elec}
        result, _ = self.convert(None)
        self.assertTrue(result["ok"], result.get("error"))
        positions = self.synced_store(result["entry"]).attrs["electrode_positions"]
        self.assertEqual(positions["Fp1-0"], [-0.03, 0.08, 0.0])
        self.assertEqual(positions["Fp1-1"], [-0.03, 0.08, 0.0])
        self.assertEqual(positions["F7"], [-0.07, 0.04, 0.0])
        self.assertIn("Fp1", positions)  # the sidecar's own key is kept

    def entry_is_published(self, result: dict) -> None:
        """The entry validates inside a real merged index, the way `main`
        publishes it, against the served schema."""
        index = merge_index(
            None, "nm000110", "c" * 40, [result["entry"]], [], "2026-09-28T00:00:00Z",
            [], [], discovered=[self.PRIMARY],
        )
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_case_only_row_is_applied_and_reported_per_biosigios_join(self):
        # biosigio#136: EDF header `FP1-F7`, channels.tsv `Fp1-F7`.
        #
        # CANARY for biosigIO's channels.tsv join. biosigio >= 1.2.10 (the floor
        # in requirements.txt) matches a row to the one channel that differs
        # from it only in case, APPLIES its type and unit, and reports the match
        # as `matched_case_insensitive`, `{sidecar_name: channel_label}`. So the
        # index must not claim the row went unmatched, and must carry the
        # bounded count and example rather than biosigIO's map.
        #
        # The probe asks biosigIO directly, on a real EDF, whether it matches
        # that way; it is asserted rather than branched on. A biosigIO that
        # renamed its report key, or stopped matching by case, fails here by
        # name instead of passing on a join report that is no longer true.
        self.assertTrue(
            biosigio_matches_case_only_rows(),
            "the installed biosigIO does not report a case-only channels.tsv match "
            "as `matched_case_insensitive`; requirements.txt's floor (1.2.10) says it must",
        )
        names = ["Fp1-F7", *CHB_MIT_SUFFIXED[1:]]
        saved = generate_zarr.STREAM_EDF_MIN_BYTES
        self.addCleanup(setattr, generate_zarr, "STREAM_EDF_MIN_BYTES", saved)
        for path_name, threshold in (("in-memory", saved), ("streaming", 1)):
            with self.subTest(path_name):
                generate_zarr.STREAM_EDF_MIN_BYTES = threshold
                shutil.rmtree(self.synced_dir, ignore_errors=True)
                result, out = self.convert(names)
                self.assertTrue(result["ok"], result.get("error"))
                entry = result["entry"]
                report = entry["units_report"]
                # The sidecar's V, not the file's uV: the row was applied, and
                # the samples converted with it (every channel is V now).
                self.assertEqual(set(self.store_units(entry).values()), {"V"})
                self.assertEqual(report["converted"], len(CHB_MIT_LABELS))
                # Reported truthfully, and bounded.
                self.assertEqual(report["unmatched_channels"], 0)
                self.assertNotIn("unmatched_case_only", report)
                self.assertNotIn("unmatched_examples", report)
                self.assertEqual(report["matched_case_only"], 1)
                self.assertEqual(report["matched_case_only_examples"], ["Fp1-F7 -> FP1-F7"])
                self.assertNotIn("matched_case_insensitive", report)
                self.assertNotIn("names no row", out)
                self.assertNotIn("differ only in case", out)
                # The store keeps biosigIO's own full account; only the index
                # entry is bounded.
                root = self.synced_store(entry)
                units_attr = root.attrs.get("channels_tsv_units") or root.attrs[
                    "recording_metadata"
                ]["channels_tsv_units"]
                self.assertEqual(units_attr["matched_case_insensitive"], {"Fp1-F7": "FP1-F7"})
                self.entry_is_published(result)

    def test_an_ambiguous_case_only_row_stays_unmatched(self):
        # Two store channels fold to the row's name (`FZ` and `Fz`, the row
        # `fz`): biosigIO cannot tell which one the row meant, applies it to
        # neither, and the index says so under `unmatched_case_only`.
        build_labeled_edf(os.path.join(self.repo, self.PRIMARY), ["FZ", "Fz", "Cz"])
        result, out = self.convert(["fz", "Cz"])
        self.assertTrue(result["ok"], result.get("error"))
        report = result["entry"]["units_report"]
        self.assertEqual(report["unmatched_channels"], 2)
        self.assertEqual(report["unmatched_case_only"], 2)
        self.assertEqual(report["unmatched_examples"], ["FZ", "Fz"])
        self.assertNotIn("matched_case_only", report)
        units = self.store_units(result["entry"])
        self.assertEqual((units["FZ"], units["Fz"], units["Cz"]), ("uV", "uV", "V"))
        self.assertIn("differ only in case", out)
        self.entry_is_published(result)

    def test_a_300_channel_case_differing_sidecar_keeps_the_entry_small(self):
        # Every one of 300 channels is named in another case by the sidecar,
        # so biosigIO's map has 300 entries. The index entry must not grow
        # with it: the case-differing entry is compared with the SAME
        # recording under an exactly-matching sidecar, so the channel-count
        # parts of the entry (groups) cancel out and only the join report is
        # measured.
        labels = [f"CH{i:03d}-REF" for i in range(300)]
        build_labeled_edf(os.path.join(self.repo, self.PRIMARY), labels, seconds=2)
        exact, _ = self.convert(labels)
        self.assertTrue(exact["ok"], exact.get("error"))
        shutil.rmtree(self.synced_dir, ignore_errors=True)
        folded, out = self.convert([label.lower() for label in labels])
        self.assertTrue(folded["ok"], folded.get("error"))

        report = folded["entry"]["units_report"]
        self.assertEqual(report["converted"], 300)
        self.assertEqual(report["unmatched_channels"], 0)
        self.assertEqual(report["matched_case_only"], 300)
        self.assertEqual(
            len(report["matched_case_only_examples"]), generate_zarr.CASE_MATCH_EXAMPLES_MAX
        )
        self.assertNotIn("matched_case_insensitive", report)
        self.assertNotIn("names no row", out)
        self.assertEqual(set(self.store_units(folded["entry"]).values()), {"V"})

        size = len(json.dumps(folded["entry"]["units_report"]))
        growth = len(json.dumps(folded["entry"])) - len(json.dumps(exact["entry"]))
        # A count and five ~30-byte examples. biosigIO's map alone would be
        # ~9 KB here (300 x `"ch000-ref": "CH000-REF", `).
        self.assertLess(size, 600, report)
        self.assertLess(growth, 400)
        self.entry_is_published(folded)


def build_edf_family(
    path: str,
    signals: list[tuple[str, int]],
    file_type: int,
    *,
    annotations: bool = False,
    seconds: int = 10,
) -> str:
    """Write a REAL EDF/BDF (plain or +) with pyedflib: `signals` is
    `(label, sample_rate)` per signal, so a mixed-rate file is just unequal
    rates. With `annotations`, EDF+/BDF+ get an annotation track in the
    header (pyedflib adds the `EDF Annotations`/`BDF Annotations` signal)."""
    import numpy as np
    import pyedflib

    bdf = file_type in (pyedflib.FILETYPE_BDF, pyedflib.FILETYPE_BDFPLUS)
    dmax, dmin = (8388607, -8388608) if bdf else (32767, -32768)
    writer = pyedflib.EdfWriter(path, len(signals), file_type=file_type)
    writer.setSignalHeaders([
        {
            "label": label,
            # A BioSemi Status channel is a trigger word, not a voltage.
            "dimension": "Boolean" if label == "Status" else "uV",
            "sample_frequency": rate,
            "physical_max": dmax if label == "Status" else 3000.0,
            "physical_min": dmin if label == "Status" else -3000.0,
            "digital_max": dmax,
            "digital_min": dmin,
            "transducer": "",
            "prefilter": "",
        }
        for label, rate in signals
    ])
    rng = np.random.default_rng(0)
    writer.writeSamples([
        np.zeros(rate * seconds) if label == "Status" else rng.normal(0, 20, rate * seconds)
        for label, rate in signals
    ])
    if annotations:
        writer.writeAnnotation(1.0, -1, "stimulus")
        writer.writeAnnotation(4.5, 0.5, "response")
    writer.close()
    return path


def write_plain_edf(path: str, labels: list[str], rate: int = 128, seconds: int = 4) -> str:
    """A REAL plain EDF (reserved field empty, so not EDF+), byte for byte per
    the EDF spec, 1-second data records of int16 zeros. Written by hand
    because pyedflib will not put the label `EDF Annotations` on an ordinary
    signal, and some legacy writers did exactly that."""
    ns = len(labels)
    fixed = (
        "0".ljust(8) + "X".ljust(80) + "X".ljust(80) + "01.01.26" + "00.00.00"
        + str(256 * (ns + 1)).ljust(8) + "".ljust(44) + str(seconds).ljust(8)
        + "1".ljust(8) + str(ns).ljust(4)
    )
    per_signal = (
        "".join(label.ljust(16) for label in labels)
        + "".ljust(80) * ns                    # transducer type
        + "uV".ljust(8) * ns                   # physical dimension
        + "-3000".ljust(8) * ns                # physical minimum
        + "3000".ljust(8) * ns                 # physical maximum
        + "-32768".ljust(8) * ns               # digital minimum
        + "32767".ljust(8) * ns                # digital maximum
        + "".ljust(80) * ns                    # prefiltering
        + str(rate).ljust(8) * ns              # samples per data record
        + "".ljust(32) * ns                    # reserved
    )
    header = (fixed + per_signal).encode("ascii")
    assert len(header) == 256 * (ns + 1)
    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(b"\x00\x00" * rate * ns * seconds)
    return path


def write_brainvision(vhdr: str, labels: list[str], rate: int = 250, seconds: int = 4) -> list[str]:
    """A REAL BrainVision triplet (.vhdr/.vmrk/.eeg, multiplexed INT_16), as
    the format specifies it. Returns the three paths."""
    stem = os.path.splitext(vhdr)[0]
    base = os.path.basename(stem)
    with open(vhdr, "w", encoding="utf-8") as fh:
        fh.write(
            "Brain Vision Data Exchange Header File Version 1.0\n"
            "[Common Infos]\nCodepage=UTF-8\n"
            f"DataFile={base}.eeg\nMarkerFile={base}.vmrk\n"
            "DataFormat=BINARY\nDataOrientation=MULTIPLEXED\n"
            f"NumberOfChannels={len(labels)}\nSamplingInterval={1_000_000 // rate}\n"
            "[Binary Infos]\nBinaryFormat=INT_16\n[Channel Infos]\n"
            + "".join(f"Ch{i + 1}={label},,0.1,µV\n" for i, label in enumerate(labels))
        )
    with open(stem + ".vmrk", "w", encoding="utf-8") as fh:
        fh.write(
            "Brain Vision Data Exchange Marker File, Version 1.0\n"
            f"[Common Infos]\nCodepage=UTF-8\nDataFile={base}.eeg\n"
            "[Marker Infos]\nMk1=New Segment,,1,1,0\nMk2=Stimulus,S  1,250,1,0\n"
        )
    with open(stem + ".eeg", "wb") as fh:
        fh.write(b"\x00\x00" * rate * seconds * len(labels))
    return [vhdr, stem + ".vmrk", stem + ".eeg"]


class TestHeaderGateFalseRefusalMatrix(unittest.TestCase):
    """The always-on header gate must not refuse a COMPLETE store.

    Since the gate reads the file header for every recording, a format whose
    header counts something the store does not serve as a channel (an
    annotation track, a trigger channel) would now be refused even with no
    channels.tsv at all. Each case is a real file, converted by the real
    biosigio stack through `convert_one` with NO channels.tsv, so the header
    is the only witness; each must publish, with the store holding at least
    what the header declares. Also asserted: the store's own
    `recording_metadata.number_of_signals` (the witness
    find_collapsed_channel_stores.py reads) never exceeds what it serves.
    Only `aws s3 sync` is absorbed (it copies the store aside), as in
    TestDuplicateLabelsThroughConvertOne.

    It also pins the CALL SITE. `convert_one` must hand the gate the header
    count for every recording, sidecar or none: a reviewer once changed that
    line to `file_declared_channel_count(primary_local) if expected else None`,
    which restores the old channels.tsv-only gate, and every test stayed green.
    Each case therefore records what `convert_one` passes to
    `enforce_channel_gate` (a pass-through: the real gate still runs on it).

    Why the REFUSAL cannot be driven from here: on biosigio >= 1.2.9 no real
    file yields a store short of its header. Probed with real files through
    `convert_one`, on both exporters: repeated, empty and colliding labels
    (suffixed, all kept), zero-rate and mixed-rate signals, NUL-padded fields,
    annotation-label variants (pyedflib rejects them), and BrainVision channel
    infos that disagree with the count (rejected, or read at the count). Each
    either converts whole or fails before a store exists. So real data cannot
    falsify a call site that stops passing the header, and the only thing left
    to observe is the argument. The refusal itself is proved on a store built
    the way biosigio <= 1.2.8 built one, in TestChannelGateOnRealFiles."""

    @classmethod
    def setUpClass(cls):
        try:
            import mne  # noqa: F401
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
            from biosigio import __version__ as biosigio_version
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        parts = tuple(int(p) for p in biosigio_version.split(".")[:3] if p.isdigit())
        if parts < (1, 2, 9):
            raise unittest.SkipTest(f"biosigio {biosigio_version} is below the 1.2.9 floor")

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        self.synced_dir = os.path.join(self._tmp.name, "synced")
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(
                "#!/bin/sh\n"
                'if [ "$1" = s3 ] && [ "$2" = sync ]; then\n'
                f'  mkdir -p "{self.synced_dir}" && cp -R "$3" "{self.synced_dir}/"\n'
                "fi\nexit 0\n"
            )
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)
        saved_ctx = dict(generate_zarr._CTX)
        self.addCleanup(lambda: (generate_zarr._CTX.clear(), generate_zarr._CTX.update(saved_ctx)))

    def place(self, rel: str) -> str:
        path = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path

    def assert_published_whole(
        self,
        primary: str,
        extra_files: set[str],
        in_file: int,
        in_store: int,
        unusable_sidecar: str | None = None,
    ):
        """`unusable_sidecar` is a channels.tsv listed at HEAD that gives the
        gate no count (unreadable, or a header row and nothing else), so the
        header is still the only witness."""
        head_files = {primary, *extra_files}
        self.assertFalse(
            any(p.endswith("_channels.tsv") for p in head_files), "no sidecar: header only"
        )
        if unusable_sidecar:
            head_files.add(unusable_sidecar)
        gate_calls: list[tuple] = []
        real_gate = generate_zarr.enforce_channel_gate

        def recording_gate(*args, **kwargs):
            gate_calls.append(args)
            return real_gate(*args, **kwargs)

        setattr(generate_zarr, "enforce_channel_gate", recording_gate)  # noqa: B010
        self.addCleanup(setattr, generate_zarr, "enforce_channel_gate", real_gate)
        work = os.path.join(self._tmp.name, "work")
        os.makedirs(work, exist_ok=True)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "nm000110",
            "head": "d" * 40, "head_files": head_files, "local": True,
            "tmp": work, "updated": "2026-09-28T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": ZARR_ENGINE_VERSION,
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        self.assertEqual(
            file_declared_channel_count(os.path.join(self.repo, primary)), in_file,
            "the header count this case is about",
        )
        with contextlib.redirect_stdout(io.StringIO()):
            result = convert_one(primary)
        self.assertTrue(result["ok"], result.get("error"))
        entry = result["entry"]
        self.assertNotIn("channels_tsv_count_mismatch", entry)
        self.assertEqual(store_total_channels(entry), in_store)
        self.assertGreaterEqual(in_store, in_file)
        self.assertEqual(
            gate_calls, [(primary, in_store, None, in_file)],
            "convert_one must hand the gate the file's own header count even "
            "when no channels.tsv gives a count",
        )
        with open(
            os.path.join(self.synced_dir, os.path.basename(entry["zarr"]), "zarr.json"),
            encoding="utf-8",
        ) as fh:
            rec_meta = json.load(fh)["attributes"].get("recording_metadata") or {}
        witness = rec_meta.get("number_of_signals")
        if witness is not None:
            self.assertLessEqual(witness, in_store, "the detector's witness would misfire")
        return entry

    def test_bdf_with_a_status_channel(self):
        import pyedflib

        primary = "sub-01/eeg/sub-01_task-rest_eeg.bdf"
        build_edf_family(
            self.place(primary), [("Fp1", 256), ("Fp2", 256), ("Status", 256)],
            pyedflib.FILETYPE_BDF,
        )
        self.assert_published_whole(primary, set(), 3, 3)

    def test_edf_plus_with_annotations(self):
        import pyedflib

        primary = "sub-01/eeg/sub-01_task-rest_eeg.edf"
        build_edf_family(
            self.place(primary), [("Fp1", 256), ("Fp2", 256), ("Cz", 256)],
            pyedflib.FILETYPE_EDFPLUS, annotations=True,
        )
        self.assert_published_whole(primary, set(), 3, 3)

    def test_bdf_plus_with_annotations(self):
        import pyedflib

        primary = "sub-01/eeg/sub-01_task-rest_eeg.bdf"
        build_edf_family(
            self.place(primary), [("Fp1", 256), ("Fp2", 256), ("Status", 256)],
            pyedflib.FILETYPE_BDFPLUS, annotations=True,
        )
        self.assert_published_whole(primary, set(), 3, 3)

    def test_mixed_rate_edf(self):
        # Unequal rates take the converter's `mixed_rate="resample"` path.
        import pyedflib

        primary = "sub-01/eeg/sub-01_task-rest_eeg.edf"
        build_edf_family(
            self.place(primary), [("Fp1", 256), ("Fp2", 256), ("ECG", 128), ("Resp", 32)],
            pyedflib.FILETYPE_EDFPLUS,
        )
        self.assert_published_whole(primary, set(), 4, 4)

    def test_brainvision(self):
        primary = "sub-01/eeg/sub-01_task-rest_eeg.vhdr"
        paths = write_brainvision(self.place(primary), ["Fp1", "Fp2", "Cz", "Pz"])
        rels = {os.path.relpath(p, self.repo) for p in paths}
        self.assert_published_whole(primary, rels - {primary}, 4, 4)

    def test_fif(self):
        primary = "sub-01/meg/sub-01_task-rest_meg.fif"
        build_real_fif(self.place(primary))
        self.assert_published_whole(primary, set(), len(FIF_CHANNELS), len(FIF_CHANNELS))

    def test_split_fif(self):
        # Three `split-NN` files (see TestFifDeclaredChannelCount for the cost).
        build_real_fif(
            self.place("sub-01/meg/sub-01_task-rest_meg.fif"),
            rate=1000.0, seconds=120, split_size="2MB", split_naming="bids",
        )
        meg = os.path.join(self.repo, "sub-01", "meg")
        splits = sorted(f"sub-01/meg/{n}" for n in os.listdir(meg) if "_split-" in n)
        self.assertGreaterEqual(len(splits), 2)
        entry = self.assert_published_whole(
            splits[0], set(splits[1:]), len(FIF_CHANNELS), len(FIF_CHANNELS)
        )
        self.assertEqual(entry["path"], splits[0])

    def test_edf_plus_with_a_nul_padded_signal_count(self):
        # pyedflib refuses a NUL-padded header field, so biosigIO converts this
        # through its tolerant fallback (biosigio#109). A header reader that
        # cannot parse the field has no count, and the gate then runs blind on a
        # file it has every reason to check.
        import pyedflib

        primary = "sub-01/eeg/sub-01_task-rest_eeg.edf"
        path = self.place(primary)
        build_edf_family(
            path, [("Fp1", 256), ("Fp2", 256), ("Cz", 256)],
            pyedflib.FILETYPE_EDFPLUS, annotations=True,
        )
        with open(path, "r+b") as fh:
            fh.seek(252)
            self.assertEqual(fh.read(4), b"4   ")  # 3 signals + the annotation track
            fh.seek(252)
            fh.write(b"4\x00\x00\x00")
        self.assert_published_whole(primary, set(), 3, 3)

    def test_brainvision_with_a_lowercase_count_key(self):
        primary = "sub-01/eeg/sub-01_task-rest_eeg.vhdr"
        paths = write_brainvision(self.place(primary), ["Fp1", "Fp2", "Cz", "Pz"])
        with open(paths[0], encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("NumberOfChannels=4", text)
        with open(paths[0], "w", encoding="utf-8") as fh:
            fh.write(text.replace("NumberOfChannels=4", "numberofchannels=4"))
        rels = {os.path.relpath(p, self.repo) for p in paths}
        self.assert_published_whole(primary, rels - {primary}, 4, 4)

    def test_a_header_only_sidecar_leaves_the_header_as_the_witness(self):
        # A channels.tsv with a header row and no data rows counts nothing
        # (`expected_channel_count_for` -> None), which is the same "no count
        # from the sidecar" the call site must not confuse with "no header".
        import pyedflib

        primary = "sub-01/eeg/sub-01_task-rest_eeg.edf"
        tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
        build_edf_family(
            self.place(primary), [("Fp1", 256), ("Fp2", 256), ("Cz", 256)],
            pyedflib.FILETYPE_EDFPLUS,
        )
        with open(self.place(tsv), "w") as fh:
            fh.write("name\ttype\tunits\n")
        self.assert_published_whole(primary, set(), 3, 3, unusable_sidecar=tsv)

    def test_an_unreadable_sidecar_leaves_the_header_as_the_witness(self):
        import pyedflib

        primary = "sub-01/eeg/sub-01_task-rest_eeg.edf"
        tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"  # listed at HEAD, never written
        build_edf_family(
            self.place(primary), [("Fp1", 256), ("Fp2", 256), ("Cz", 256)],
            pyedflib.FILETYPE_EDFPLUS,
        )
        self.assert_published_whole(primary, set(), 3, 3, unusable_sidecar=tsv)

    def test_plain_edf_whose_header_under_counts(self):
        # A plain EDF (not EDF+) with an ordinary signal that happens to be
        # LABELED `EDF Annotations`. The header count drops that label, so it
        # under-counts (2 of 3); the importer serves all three. A store above
        # the header is not a truncation and must publish.
        primary = "sub-01/eeg/sub-01_task-rest_eeg.edf"
        write_plain_edf(self.place(primary), ["Fp1", "Fp2", "EDF Annotations"])
        self.assert_published_whole(primary, set(), 2, 3)


class TestMainRoutesSingleRecordingsThroughThePool(unittest.TestCase):
    """#1483: a single-recording run with --jobs > 1 converts in a pool worker,
    the only path with the serial memory retry; --jobs 1 stays in-process.

    Observed without substituting anything: the in-process path initializes the
    worker context (`_CTX`) in THIS process, and a pool worker initializes its
    own, leaving this process's untouched. A real EDF is converted either way.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        os.makedirs(os.path.join(self.repo, "sub-01", "eeg"))
        os.makedirs(self.s3)

        def git(*args):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.org")
        git("config", "user.name", "t")
        build_real_edf(os.path.join(self.repo, "sub-01", "eeg"), "sub-01_task-rest_eeg", seconds=10)
        git("add", "-A")
        git("commit", "-q", "-m", "init")

        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        saved = (os.environ.get("PATH"), os.environ.get("ZARR_TEST_S3_ROOT"))
        os.environ["PATH"] = bindir + os.pathsep + (saved[0] or "")
        os.environ["ZARR_TEST_S3_ROOT"] = self.s3
        self.addCleanup(self._restore_env, saved)
        saved_ctx = dict(generate_zarr._CTX)
        self.addCleanup(lambda: (generate_zarr._CTX.clear(), generate_zarr._CTX.update(saved_ctx)))
        generate_zarr._CTX.clear()

    @staticmethod
    def _restore_env(saved):
        for key, value in zip(("PATH", "ZARR_TEST_S3_ROOT"), saved, strict=True):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def run_main(self, jobs: int) -> str:
        argv = [
            "generate_zarr.py", "--dataset-id", "on008083", "--repo-dir", self.repo,
            "--bucket", "nemar-test", "--callback-out", os.path.join(self.dir, "cb.json"),
            "--local", "--clean", "--jobs", str(jobs),
            # Closed port: the catalog read fails fast instead of reaching the
            # real API; provenance is best-effort and not under test here.
            "--api-base", "http://127.0.0.1:9",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = generate_zarr.main()
        finally:
            sys.argv = saved
        self.assertEqual(rc, 0, out.getvalue())
        self.assertIn("converted sub-01/eeg/sub-01_task-rest_eeg.edf", out.getvalue())
        return out.getvalue()

    def test_one_recording_with_several_jobs_converts_in_a_worker(self):
        self.run_main(jobs=2)
        self.assertEqual(generate_zarr._CTX, {}, "converted in-process, not in the pool")

    def test_jobs_one_still_converts_in_process(self):
        self.run_main(jobs=1)
        self.assertEqual(generate_zarr._CTX.get("dataset_id"), "on008083")


class TestPendingRetryWorklist(unittest.TestCase):
    """#1483: a retry round converts only what is pending, and only while every
    other store the index serves is what a full rebuild would produce."""

    HEAD = "b" * 40
    A = "sub-01/eeg/sub-01_task-rest_eeg.edf"
    B = "sub-02/eeg/sub-02_task-rest_eeg.edf"
    ROW: ClassVar[dict] = {
        "dataset_id": "on008083", "license": "CC0", "concept_doi": "10.5281/zenodo.1"
    }

    def index(self, *, head=HEAD, row=ROW, biosigio="1.2.7", pending=(B,), discovered=(A, B)):
        """A real v3 index, built by `merge_index` exactly as a run publishes it."""
        return merge_index(
            None, "on008083", head,
            [{"path": self.A, "zarr": store_rel_for(self.A)}], [],
            "2026-09-22T00:00:00Z", [],
            [{"path": p, "reason": "memory_budget", "last_error": "x"} for p in pending],
            discovered=list(discovered), biosigio_version=biosigio, dataset_row=row,
        )

    def worklist(self, index, *, discovered=(A, B), row=ROW, failed=False, biosigio="1.2.7"):
        return pending_retry_worklist(
            index, self.HEAD, list(discovered), row, failed, biosigio
        )

    def test_a_current_index_retries_only_its_pending_recordings(self):
        # Round trip through the published shape: the provenance comparison is
        # against what merge_index wrote, not against a hand-built document.
        paths, why = self.worklist(self.index())
        self.assertEqual(paths, [self.B])
        self.assertIn("1 pending", why)

    def test_the_index_publishes_the_provenance_the_retry_compares(self):
        index = self.index()
        for key, value in index_provenance(self.ROW).items():
            self.assertEqual(index[key], value, key)

    def test_anything_that_changes_the_served_stores_forces_a_full_rebuild(self):
        cases = {
            "no index": (None, {}),
            "different commit": (self.index(head="c" * 40), {}),
            "different engine": ({**self.index(), "engine_version": "0"}, {}),
            "different biosigIO": (self.index(biosigio="1.2.6"), {}),
            "catalog unreadable": (self.index(), {"failed": True}),
            "license changed": (self.index(), {"row": {**self.ROW, "license": "CC-BY-4.0"}}),
            "citation changed": (
                self.index(),
                {"row": {**self.ROW, "authors": ["Doe, J."], "name": "A dataset"}},
            ),
            "nothing pending": (
                self.index(pending=(), discovered=(self.A,)), {"discovered": (self.A,)}
            ),
            "pending recording gone from HEAD": (self.index(), {"discovered": (self.A,)}),
        }
        for label, (index, kwargs) in cases.items():
            with self.subTest(label):
                paths, why = self.worklist(index, **kwargs)
                self.assertIsNone(paths)
                self.assertTrue(why)

    def test_a_recording_never_attempted_is_retried_too(self):
        # merge_index lists a discovered recording with no store and no failure
        # as `not_attempted` pending; the round owes it a conversion as well.
        index = self.index(pending=())
        self.assertEqual(index["pending"][0]["reason"], "not_attempted")
        self.assertEqual(self.worklist(index)[0], [self.B])

    def test_malformed_pending_entries_are_ignored(self):
        index = {**self.index(), "pending": [None, {"path": 3}, {"path": self.B}]}
        self.assertEqual(self.worklist(index)[0], [self.B])


def generate_zarr_queue_shortest() -> int:
    """The queue's shortest re-queue delay, from the queue module itself."""
    import zarr_queue

    return zarr_queue.PENDING_BACKOFF_SECONDS[0]


class TestMainRetryPendingRound(unittest.TestCase):
    """`--retry-pending` through `main()` (#1483): real recordings converted by
    the real exporter, the real `aws` stand-in over local files, and a local
    catalog server, so the decision, the worklist, the merge into the published
    index and the exit status all run for real.

    Recording B is committed the way git-annex commits it, as a symlink into
    `.git/annex/objects`. Its object exists but this user cannot read it on the
    first run (mode 0): the host's condition and not the file's, which no reader
    types, so B fails uncoded and is listed as pending while A converts. The
    tests then decide whether the content is readable for the retry. HEAD never
    moves, which is exactly the situation a retry round is in.

    An ABSENT object would not do. Since biosigIO 1.2.12 its streaming source
    types a missing file `file_read_error`, as its in-memory path always did
    (`TestAbsentAnnexObjectThroughConvertOne`).
    """

    A = "sub-01/eeg/sub-01_task-rest_eeg.edf"
    B = "sub-02/eeg/sub-02_task-rest_eeg.edf"

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        os.makedirs(self.s3)

        def git(*args):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

        os.makedirs(os.path.join(self.repo, "sub-01", "eeg"))
        os.makedirs(os.path.join(self.repo, "sub-02", "eeg"))
        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.org")
        git("config", "user.name", "t")
        with open(os.path.join(self.repo, "dataset_description.json"), "w") as fh:
            json.dump({"Name": "retry fixture", "BIDSVersion": "1.8.0"}, fh)
        build_real_edf(os.path.join(self.repo, "sub-01", "eeg"), "sub-01_task-rest_eeg", seconds=10)
        # B as git-annex leaves it before `get`: a committed symlink to an object
        # this user cannot read yet.
        self.b_object = os.path.join(self.repo, ".git", "annex", "objects", "B.edf")
        os.makedirs(os.path.dirname(self.b_object))
        build_real_edf(os.path.dirname(self.b_object), "B", seconds=10)
        os.chmod(self.b_object, 0)
        if os.access(self.b_object, os.R_OK):
            self.skipTest("file modes do not bind this user (root), so B would convert")
        os.symlink(
            os.path.relpath(self.b_object, os.path.join(self.repo, "sub-02", "eeg")),
            os.path.join(self.repo, self.B),
        )
        git("add", "-A")
        git("commit", "-q", "-m", "init")

        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        saved = (os.environ.get("PATH"), os.environ.get("ZARR_TEST_S3_ROOT"))
        os.environ["PATH"] = bindir + os.pathsep + (saved[0] or "")
        os.environ["ZARR_TEST_S3_ROOT"] = self.s3
        self.addCleanup(self._restore_env, saved)

        self.row = {"dataset_id": "on008083", "license": "CC0", "concept_doi": "10.5281/zenodo.1"}
        self.api = self._serve_catalog()
        self.callback = os.path.join(self.dir, "cb.json")

    @staticmethod
    def _restore_env(saved):
        for key, value in zip(("PATH", "ZARR_TEST_S3_ROOT"), saved, strict=True):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _serve_catalog(self) -> str:
        """A local catalog answering GET /datasets/<id> with `self.row`, read
        per request so a test can change the dataset between runs."""
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        test = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
                body = json.dumps(test.row).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def materialize_b(self):
        """`git annex get` for B: the content becomes readable, HEAD does not move."""
        os.chmod(self.b_object, 0o644)

    def run_main(self, *extra, clean: bool = True) -> tuple[int, str, dict]:
        argv = [
            "generate_zarr.py", "--dataset-id", "on008083", "--repo-dir", self.repo,
            "--bucket", "nemar-test", "--callback-out", self.callback, "--local",
            "--api-base", self.api, "--jobs", "2", *(["--clean"] if clean else []), *extra,
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = generate_zarr.main()
        finally:
            sys.argv = saved
        with open(self.callback) as fh:
            return rc, out.getvalue(), json.load(fh)

    def published_index(self) -> dict:
        with open(os.path.join(self.s3, "on008083_zarr_index.json")) as fh:
            return json.load(fh)

    def first_round(self) -> dict:
        """The run a retry round follows: A converts, B is left pending."""
        rc, log, _ = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("no published index; full rebuild", log)
        index = self.published_index()
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        self.assertEqual([p["path"] for p in index["pending"]], [self.B])
        return index

    def test_a_retry_round_converts_only_the_pending_recording(self):
        before = self.first_round()
        self.materialize_b()
        rc, log, body = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("converting only 1 pending recording(s)", log)
        self.assertIn(f"converted {self.B}", log)
        self.assertNotIn(f"converted {self.A}", log)
        index = self.published_index()
        self.assertEqual(sorted(s["path"] for s in index["stores"]), [self.A, self.B])
        # A was carried from the published index, untouched, not rebuilt.
        carried = next(s for s in index["stores"] if s["path"] == self.A)
        self.assertEqual(carried, before["stores"][0])
        self.assertEqual(index["pending"], [])
        self.assertEqual(body["pending_count"], 0)
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_round_that_converts_nothing_still_advances_the_attempts(self):
        # Without this a retry round where the pending recording fails again
        # took the total-failure exit: index untouched, attempts never counted,
        # and the queue row marked `failed` while A was still being served.
        self.first_round()
        rc, log, body = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        index = self.published_index()
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        self.assertEqual([(p["path"], p["attempts"]) for p in index["pending"]], [(self.B, 2)])
        self.assertEqual(body["pending_count"], 1)

    def test_a_provenance_change_turns_the_round_into_a_full_rebuild(self):
        # Every store embeds the dataset's DOI, license and citation, so a
        # changed catalog row (de-anonymization, a new license) has to reach A.
        self.first_round()
        self.materialize_b()
        self.row = {**self.row, "license": "CC-BY-4.0"}
        rc, log, _ = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("provenance changed", log)
        self.assertIn(f"converted {self.A}", log)
        self.assertEqual(self.published_index()["license"], "CC-BY-4.0")

    def test_without_the_flag_a_run_is_a_full_rebuild(self):
        # A one-off `hallu-zarr.sh --dataset` run never passes it.
        self.first_round()
        self.materialize_b()
        rc, log, _ = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertNotIn("--retry-pending", log)
        self.assertIn(f"converted {self.A}", log)


    def _no_scratch(self):
        """Headroom larger than any volume leaves a budget of zero, so no recording
        fits and every one is deferred. Returns a function that gives the room
        back, for a test that goes on to a run with space."""
        saved = generate_zarr.SCRATCH_HEADROOM_BYTES
        generate_zarr.SCRATCH_HEADROOM_BYTES = 10**18
        self.addCleanup(setattr, generate_zarr, "SCRATCH_HEADROOM_BYTES", saved)
        # The re-samples before a deferral are ADMISSION_RECHECK_SECONDS apart.
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.01
        return lambda: setattr(generate_zarr, "SCRATCH_HEADROOM_BYTES", saved)

    def _index_bytes(self) -> bytes:
        with open(os.path.join(self.s3, "on008083_zarr_index.json"), "rb") as fh:
            return fh.read()

    def _body(self) -> dict:
        with open(self.callback) as fh:
            return json.load(fh)

    def _git(self, *args) -> str:
        return subprocess.run(
            ["git", *args], cwd=self.repo, check=True, capture_output=True, text=True
        ).stdout.strip()

    def _assert_deferred_without_spending_attempts(self, rc, log, body):
        self.assertEqual(rc, 0, log)
        self.assertIn("deferred ", log)
        self.assertNotIn("conversion(s) failed", log)
        self.assertNotIn(f"converted {self.A}", log)
        self.assertNotIn(f"converted {self.B}", log)
        index = self.published_index()
        self.assertEqual(index["stores"], [])
        self.assertEqual(
            sorted((p["path"], p["reason"], p["attempts"]) for p in index["pending"]),
            [(self.A, "not_attempted", 0), (self.B, "not_attempted", 0)],
        )
        self.assertEqual(body["not_attempted_count"], 2)
        self.assertEqual(body["status"], "ready")
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_pool_run_that_cannot_fit_scratch_defers_instead_of_failing(self):
        self._no_scratch()
        self._assert_deferred_without_spending_attempts(*self.run_main("--retry-pending"))

    def test_a_deferred_retry_spends_no_attempt(self):
        # The contrast with `test_a_round_that_converts_nothing_still_advances_the
        # _attempts`: there B was tried and failed, so its count went to 2. Here the
        # node had no room to try, so the count stays at 1 and nothing is closer to
        # `retry_exhausted` than before. A disk-full node must not be able to
        # promote healthy recordings into permanent failures.
        self.first_round()
        self._no_scratch()
        rc, log, body = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("deferred ", log)
        index = self.published_index()
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        self.assertEqual([(p["path"], p["attempts"]) for p in index["pending"]], [(self.B, 1)])
        self.assertEqual(index["failures"], [])
        (entry,) = index["pending"]
        # Re-reasoned as not attempted, with the history kept behind the note.
        self.assertEqual(entry["reason"], "not_attempted")
        self.assertTrue(entry["last_error"].startswith("deferred: needs"), entry["last_error"])
        self.assertIn("; last error:", entry["last_error"])
        self.assertEqual(body["pending_count"], 1)
        self.assertEqual(body["not_attempted_count"], 1)

    def test_an_all_deferred_clean_run_keeps_the_served_store(self):
        # The run hallu always makes: --clean, so the merge is handed no prior. A
        # previously served store must not drop out of the index because this run
        # could not rebuild it, and a run with nothing to say must not
        # rewrite the index at all.
        self.first_round()
        self._no_scratch()
        rc, log, body = self.run_main()  # no --retry-pending: a full --clean rebuild
        self.assertEqual(rc, 0, log)
        self.assertIn("deferred ", log)
        index = self.published_index()
        self.assertEqual([s["path"] for s in index["stores"]], [self.A], "A is still served")
        self.assertEqual(index["store_count"], 1)
        self.assertEqual(body["store_count"], 1)
        (entry,) = index["pending"]
        self.assertEqual(
            (entry["path"], entry["reason"], entry["attempts"]), (self.B, "not_attempted", 1)
        )
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        # The same situation again: the index already says it, so it is left alone.
        before = self._index_bytes()
        rc, log, body = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertIn("left untouched", log)
        self.assertEqual(self._index_bytes(), before)
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["store_count"], 1)
        self.assertEqual((body["pending_count"], body["not_attempted_count"]), (1, 1))

    def test_a_retry_round_that_defers_everything_leaves_the_index_alone(self):
        self.first_round()
        self._no_scratch()
        self.run_main("--retry-pending")  # corrects B's reason and says why, once
        before = self._index_bytes()
        rc, log, body = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("left untouched", log)
        self.assertEqual(self._index_bytes(), before)
        self.assertEqual(body["store_count"], 1)

    def _queue(self):
        """The real queue, holding the dataset as a pending job."""
        from zarr_queue import connect, reconcile

        conn = connect(os.path.join(self.dir, "q.db"))
        self.addCleanup(conn.close)
        reconcile(conn, [("on008083", "v1.0.0")], 3600)
        return conn

    @staticmethod
    def _round(conn, body):
        """One run's callback numbers into the real `mark_done`; the row after."""
        from zarr_queue import claim_next, mark_done

        conn.execute("UPDATE jobs SET status='pending' WHERE dataset_id='on008083'")
        conn.commit()
        claim_next(conn)
        mark_done(
            conn, "on008083", "v1.0.0",
            pending_count=body["pending_count"],
            not_attempted_count=body["not_attempted_count"],
        )
        conn.commit()
        return conn.execute(
            "SELECT retry_round, next_retry_at, pending_count FROM jobs "
            "WHERE dataset_id='on008083'"
        ).fetchone()

    def test_a_deferral_spends_no_queue_retry_round_end_to_end(self):
        # B is pending as an attempted failure: two real rounds advance the queue
        # to round 2 (a six-hour backoff). The deferred rounds that follow report
        # the recording as not attempted, so the real `mark_done` leaves the round
        # where it was and re-queues at the shortest delay.
        self.first_round()
        first = self._body()
        rc, log, second = self.run_main("--retry-pending")  # B fails again: attempt 2
        self.assertEqual(rc, 0, log)
        self.assertEqual((second["pending_count"], second["not_attempted_count"]), (1, 0))
        self._no_scratch()
        rc, log, deferred_once = self.run_main("--retry-pending")  # publishes the correction
        self.assertEqual(rc, 0, log)
        rc, log, deferred_twice = self.run_main("--retry-pending")  # index left untouched
        self.assertIn("left untouched", log)
        for body in (deferred_once, deferred_twice):
            self.assertEqual(
                (body["pending_count"], body["not_attempted_count"]), (1, 1),
                "the deferred recording must be counted as not attempted",
            )
        conn = self._queue()
        self._round(conn, first)
        row = self._round(conn, second)
        self.assertEqual(row["retry_round"], 2)
        shortest = generate_zarr_queue_shortest()
        for deferral in (deferred_once, deferred_twice):
            row = self._round(conn, deferral)
            self.assertEqual(row["retry_round"], 2, "a deferral advanced the retry round")
            self.assertLessEqual(row["next_retry_at"] - int(time.time()), shortest + 5)

    def test_an_attempted_failure_still_advances_the_round_for_contrast(self):
        self.first_round()
        first = self._body()
        rc, log, second = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        conn = self._queue()
        self._round(conn, first)
        self.assertEqual(self._round(conn, second)["retry_round"], 2)

    def test_a_deferred_stale_store_is_listed_pending_and_rebuilt_later(self):
        # The provenance changed (a new license), so A's published store is stale.
        # A deferral must not leave it in the index claiming the new commit and a
        # complete dataset: it is pending, and the next round rebuilds it.
        self.first_round()
        self.row = {**self.row, "license": "CC-BY-4.0"}
        restore = self._no_scratch()
        rc, log, body = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("provenance changed", log)
        index = self.published_index()
        self.assertEqual(index["stores"], [], "the stale store left the index")
        self.assertEqual(
            sorted((p["path"], p["reason"]) for p in index["pending"]),
            [(self.A, "not_attempted"), (self.B, "not_attempted")],
        )
        self.assertEqual((body["pending_count"], body["not_attempted_count"]), (2, 2))
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        restore()
        self.materialize_b()
        rc, log, _ = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("converting only 2 pending recording(s)", log)
        index = self.published_index()
        self.assertEqual(sorted(s["path"] for s in index["stores"]), [self.A, self.B])
        self.assertEqual(index["license"], "CC-BY-4.0")
        self.assertEqual(index["pending"], [])

    def test_an_incremental_run_that_defers_holds_the_commit_back(self):
        # Without --clean the worklist is a diff from the index's commit, so a
        # deferred recording has to leave that commit where it was or the next run
        # would diff from a commit the recording was never built at.
        self.first_round()
        first_commit = self._git("rev-parse", "HEAD")
        build_real_edf(os.path.join(self.repo, "sub-01", "eeg"), "sub-01_task-rest_eeg", seconds=12)
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "A changes")
        second_commit = self._git("rev-parse", "HEAD")
        restore = self._no_scratch()
        rc, log, body = self.run_main(clean=False)
        self.assertEqual(rc, 0, log)
        self.assertIn("full=False", log)
        index = self.published_index()
        self.assertEqual(index["source_commit"], first_commit, "the commit is held back")
        self.assertNotEqual(index["source_commit"], second_commit)
        self.assertEqual(index["stores"], [], "A's store predates the change")
        self.assertEqual(
            sorted(p["path"] for p in index["pending"]), [self.A, self.B]
        )
        restore()
        rc, log, _ = self.run_main(clean=False)
        self.assertEqual(rc, 0, log)
        self.assertIn(f"converted {self.A}", log)
        index = self.published_index()
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        self.assertEqual(index["source_commit"], second_commit)

    def _manifest(self) -> dict:
        with open(os.path.join(self.s3, "on008083_zarr_manifest.json")) as fh:
            return json.load(fh)

    def _bigger_a_streams_with_an_absurd_charge(self):
        """A is re-recorded larger than B's pointer and made to stream, with a charge
        no volume holds, so A is the recording the gate defers while B (30 bytes of
        pointer, in memory) still fits. Applied AFTER the first round, which must
        convert A normally."""
        saved = (generate_zarr.STREAM_EDF_MIN_BYTES, generate_zarr.SCRATCH_STREAM_FACTOR)

        def restore():
            generate_zarr.STREAM_EDF_MIN_BYTES, generate_zarr.SCRATCH_STREAM_FACTOR = saved

        self.addCleanup(restore)
        generate_zarr.STREAM_EDF_MIN_BYTES = 1000
        generate_zarr.SCRATCH_STREAM_FACTOR = 1e12
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.01

    def test_an_unreadable_catalog_does_not_drop_a_served_store(self):
        # With the catalog down, provenance cannot be compared. The store the index
        # serves must stay: dropping it because the catalog blinked is worse than
        # serving it, and a rebuild would have given A null provenance.
        self.first_round()
        self._no_scratch()
        rc, log, body = self.run_main("--api-base", "http://127.0.0.1:9")
        self.assertEqual(rc, 0, log)
        self.assertIn("deferred ", log)
        index = self.published_index()
        self.assertEqual([s["path"] for s in index["stores"]], [self.A], "A is still served")
        self.assertEqual((index["store_count"], body["store_count"]), (1, 1))
        check_index_invariant(index)

    def test_a_partial_deferral_under_clean_keeps_the_served_stores_manifest_entry(self):
        # --clean hands the manifest no prior, so a store the index KEPT lost its
        # source_key and size: the manifest listed [B] while the index served [A, B].
        build_real_edf(os.path.join(self.repo, "sub-01", "eeg"), "sub-01_task-rest_eeg", seconds=30)
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "A is longer")
        self.first_round()
        # Local mode has no annex key, so give A's published entry the content a real
        # run records, to see it survive a run that does not rebuild A.
        manifest = self._manifest()
        marked = {
            "zarr": store_rel_for(self.A),
            "source_key": "SHA256E-s48000--" + "a" * 64 + ".edf",
            "size_bytes": 48000,
        }
        manifest["stores"] = [
            marked if e["zarr"] == marked["zarr"] else e for e in manifest["stores"]
        ]
        with open(os.path.join(self.s3, "on008083_zarr_manifest.json"), "w") as fh:
            json.dump(manifest, fh)
        entry = marked
        self.materialize_b()
        self._bigger_a_streams_with_an_absurd_charge()
        rc, log, body = self.run_main()  # --clean, no --retry-pending
        self.assertEqual(rc, 0, log)
        self.assertIn(f"converted {self.B}", log)
        self.assertNotIn(f"converted {self.A}", log)
        index = self.published_index()
        self.assertEqual(sorted(s["path"] for s in index["stores"]), [self.A, self.B])
        manifest = self._manifest()
        by_rel = {e["zarr"]: e for e in manifest["stores"]}
        self.assertEqual(
            sorted(by_rel), sorted(e["zarr"] for e in index["stores"]),
            "the manifest and the index must list the same stores",
        )
        self.assertEqual(by_rel[store_rel_for(self.A)], entry, "A's entry carried unchanged")
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_partial_deferral_with_no_published_manifest_warns(self):
        build_real_edf(os.path.join(self.repo, "sub-01", "eeg"), "sub-01_task-rest_eeg", seconds=30)
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "A is longer")
        self.first_round()
        os.remove(os.path.join(self.s3, "on008083_zarr_manifest.json"))
        self.materialize_b()
        self._bigger_a_streams_with_an_absurd_charge()
        rc, log, _ = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertIn("::warning::no published manifest to carry 1 kept store(s)", log)
        self.assertEqual(
            sorted(s["path"] for s in self.published_index()["stores"]), [self.A, self.B]
        )

    def test_the_callback_of_a_failed_run_counts_what_it_deferred(self):
        # B is attempted and fails (its content is absent); A is deferred. The
        # failure callback must report the deferred recording as not attempted.
        self._bigger_a_streams_with_an_absurd_charge()
        rc, log, body = self.run_main()
        self.assertEqual(rc, 1, log)
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["not_attempted_count"], 1)
        self.assertEqual(body["pending_count"], 2)  # B, attempted and failed, and A, deferred

    def _s3_snapshot(self) -> dict[str, tuple[int, int, str]]:
        """Every object in the stand-in bucket: size, mtime and content hash. Equal
        before and after means no object was written, replaced or deleted."""
        snapshot = {}
        for name in sorted(os.listdir(self.s3)):
            full = os.path.join(self.s3, name)
            if os.path.isfile(full):
                with open(full, "rb") as fh:
                    digest = hashlib.sha256(fh.read()).hexdigest()
                snapshot[name] = (os.path.getsize(full), os.stat(full).st_mtime_ns, digest)
        return snapshot

    def test_an_unchanged_run_posts_ready_with_the_commit_the_index_names_and_writes_nothing(self):
        # Nothing was rebuilt, so no S3 object may be written and the row must agree
        # with the document it describes (the commit the index names, not this HEAD).
        # The run still ends with a normal `ready` body, which hallu-zarr.sh POSTs:
        # it began with a `converting` signal that sets zarr_status to `pending`, and a
        # dataset that serves stores must not be left there (it would lose its index
        # URL and drop out of every "has a Zarr copy" filter).
        self._no_scratch()
        rc, log, first = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        index_commit = self.published_index()["source_commit"]
        self._git("commit", "-q", "--allow-empty", "-m", "an unrelated commit")
        head = self._git("rev-parse", "HEAD")
        self.assertNotEqual(head, index_commit)
        before = self._s3_snapshot()
        self.assertTrue(before, "the first run published something to compare against")
        rc, log, body = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("left untouched", log)
        self.assertEqual(self._s3_snapshot(), before, "an S3 object was written")
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["commit"], index_commit)
        self.assertNotEqual(body["commit"], head)
        self.assertEqual((body["pending_count"], body["not_attempted_count"]), (2, 2))

    def _make_b_enormous(self):
        """B's pointer now declares 1 PB, so admission charges it more than any
        volume holds while A (a real 10 s EDF) still fits: the first recording
        fits and the second does not. (500 GB was not enough: charged at 3 times
        its bytes it still fit a 3.7 TB scratch volume, and the run then
        deferred B as merely too big for now instead of refusing it.)"""
        link = os.path.join(self.repo, self.B)
        os.remove(link)
        key = "SHA256E-s1000000000000000--" + "b" * 32 + ".edf"
        os.symlink(f"../../.git/annex/objects/bb/bb/{key}/{key}", link)
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "B is enormous")

    def _assert_a_converts_and_b_is_deferred(self, rc, log, body):
        self.assertEqual(rc, 0, log)
        self.assertIn(f"converted {self.A}", log)
        self.assertNotIn(f"converted {self.B}", log)
        self.assertIn(f"::error::{self.B} can never fit this volume", log)
        index = self.published_index()
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        (entry,) = index["pending"]
        self.assertEqual(
            (entry["path"], entry["reason"], entry["attempts"]), (self.B, "not_attempted", 0)
        )
        self.assertTrue(entry["last_error"].startswith("deferred: needs"), entry["last_error"])
        self.assertEqual((body["pending_count"], body["not_attempted_count"]), (1, 1))
        self.assertEqual(body["converted"], [store_rel_for(self.A)])
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_pool_run_converts_what_fits_and_defers_what_does_not(self):
        self._make_b_enormous()
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.01
        self._assert_a_converts_and_b_is_deferred(*self.run_main("--retry-pending"))

    def test_a_serial_run_converts_what_fits_and_defers_what_does_not(self):
        self._make_b_enormous()
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.01
        self._assert_a_converts_and_b_is_deferred(*self.run_main("--retry-pending", "--jobs", "1"))

    def test_a_serial_run_that_cannot_fit_scratch_defers_instead_of_failing(self):
        self._no_scratch()
        self._assert_deferred_without_spending_attempts(
            *self.run_main("--retry-pending", "--jobs", "1")
        )


class TestSerialAdmissionBoundary(unittest.TestCase):
    """`--jobs 1` admits a recording whose charge EQUALS the budget, like the pool."""

    def _drain(self, peak, budget):
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.0
        ran: list[str] = []
        deferred: dict[str, str] = {}
        with contextlib.redirect_stdout(io.StringIO()):
            generate_zarr.drain_serially(
                ["a"], {"a": peak}, lambda _in_flight: budget, None, deferred,
                lambda p: {"ok": True, "primary": p}, lambda r, _i: ran.append(r["primary"]),
            )
        return ran, deferred

    def test_a_charge_equal_to_the_budget_runs(self):
        self.assertEqual(self._drain(100, 100), (["a"], {}))

    def test_a_charge_one_byte_over_the_budget_is_deferred(self):
        ran, deferred = self._drain(101, 100)
        self.assertEqual(ran, [])
        self.assertEqual(list(deferred), ["a"])


class TestNeverFitThreshold(unittest.TestCase):
    """A recording can never fit when its charge exceeds the volume's TOTAL minus the
    headroom; one that merely does not fit now is a note, not an operator error."""

    GIB = 1024**3

    def _defer(self, charge):
        self.addCleanup(
            setattr, generate_zarr, "SCRATCH_HEADROOM_BYTES", generate_zarr.SCRATCH_HEADROOM_BYTES
        )
        generate_zarr.SCRATCH_HEADROOM_BYTES = 10 * self.GIB
        with contextlib.redirect_stdout(io.StringIO()) as out:
            generate_zarr.defer_unfit(
                ["a"], {"a": charge}, 5 * self.GIB, lambda: (50 * self.GIB, 100 * self.GIB), {}
            )
        return out.getvalue()

    def test_a_charge_that_fits_the_volume_minus_headroom_exactly_is_only_deferred(self):
        log = self._defer(90 * self.GIB)  # the 100 GiB volume less the 10 GiB headroom
        self.assertNotIn("can never fit", log)
        self.assertIn("::warning::deferring a: charged 90 GiB", log)

    def test_one_byte_more_can_never_fit_and_is_an_error(self):
        log = self._defer(90 * self.GIB + 1)
        self.assertIn("::error::a can never fit this volume", log)
        self.assertIn("(1 can never fit this volume)", log)


class TestOrphanKillNeverTouchesThisProcess(unittest.TestCase):
    def test_this_process_is_not_signalled_even_when_its_command_line_matches(self):
        # A fixture in /proc's layout names THIS pid with an argument under the run
        # root, as an unlucky command line would. The recording `send_signal` shows
        # who would have been killed; it must be nobody here.
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as proc:
            os.makedirs(os.path.join(proc, str(os.getpid())))
            with open(os.path.join(proc, str(os.getpid()), "cmdline"), "wb") as fh:
                fh.write(b"aws\0s3\0cp\0" + os.path.join(root, "work", "x").encode() + b"\0")
            signalled: list[int] = []
            report = generate_zarr.kill_orphans_under(
                root, proc_root=proc, wait_seconds=0.1,
                send_signal=lambda pid, _sig: signalled.append(pid),
            )
        self.assertEqual(signalled, [])
        self.assertEqual(report.killed, [])
        self.assertEqual(report.scanned, 1)


class TestPoolBreakWarningContract(unittest.TestCase):
    """The one line a pool break prints, as an operator reads it."""

    GIB = 1024**3
    PRIMARY = "sub-01/eeg/sub-01_task-a_eeg.vhdr"

    @staticmethod
    def _readings(*values):
        """A volume probe answering ``values`` in order, then the last one again, so a
        further probe never raises StopIteration into the code under test."""
        remaining = list(values)
        return lambda: remaining.pop(0) if len(remaining) > 1 else remaining[0]

    def _warning(self, volume):
        with (
            tempfile.TemporaryDirectory() as root,
            tempfile.TemporaryDirectory() as empty_proc,
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            generate_zarr.reclaim_after_pool_break(
                root, [self.PRIMARY], volume, proc_root=empty_proc
            )
        return out.getvalue()

    def test_the_warning_gives_the_volume_before_and_after_the_reclaim(self):
        log = self._warning(
            self._readings((200 * self.GIB, 500 * self.GIB), (260 * self.GIB, 500 * self.GIB))
        )
        self.assertRegex(
            log,
            r"(?m)^::warning::worker pool broke with 1 recording\(s\) in flight; "
            r"scratch free 200 GiB before the reclaim and 260 GiB after, of 500 GiB; ",
        )

    def test_a_volume_that_cannot_be_read_says_the_free_space_is_unreadable(self):
        # No probe at all, and a probe that answers None (the real unreadable case:
        # statvfs failed on the scratch volume).
        for label, volume in (("no probe", None), ("a probe returning None", lambda: None)):
            with self.subTest(label):
                self.assertRegex(
                    self._warning(volume),
                    r"(?m)^::warning::worker pool broke with 1 recording\(s\) in flight; "
                    r"scratch free space unreadable; ",
                )

    def test_a_probe_that_fails_only_after_the_reclaim_is_unreadable_too(self):
        log = self._warning(self._readings((200 * self.GIB, 500 * self.GIB), None))
        self.assertIn("scratch free space unreadable;", log)

    def test_a_break_inside_a_drain_reads_the_drains_own_volume(self):
        # The drain hands its volume probe to the reclaim: a run whose probe works
        # must not report the free space as unreadable.
        boom = "sub-boom/eeg/sub-boom_task-rest_eeg.vhdr"
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()) as out:
            _drain_with_admission(
                [boom], {boom: 1024}, 1, 10**9, {"tmp": tmp},
                lambda r, i: None, worker=_scratch_worker,
                scratch_volume=lambda: (200 * self.GIB, 500 * self.GIB),
            )
        self.assertRegex(
            out.getvalue(),
            r"scratch free 200 GiB before the reclaim and 200 GiB after, of 500 GiB",
        )


def _fixture_only(cls):
    """Keep what ``cls`` inherits from `TestMainRetryPendingRound` (a real repo, the
    real exporter, the `aws` stand-in over local files, a local catalog) without
    re-running that class's own tests: the loaders skip a non-callable attribute."""
    for name in dir(cls):
        if name.startswith("test") and name not in cls.__dict__:
            setattr(cls, name, None)
    return cls


@_fixture_only
class TestDeferredRunsAgainstALiveIndex(TestMainRetryPendingRound):
    """What a run that defers recordings says about the dataset, checked against the
    index it left on S3: a live index with a served store (A, with events), a pending
    recording (B, with events) and a typed failure (C, an unreadable EDF)."""

    C = "sub-03/eeg/sub-03_task-rest_eeg.edf"

    def setUp(self):
        super().setUp()
        os.makedirs(os.path.join(self.repo, "sub-03", "eeg"))
        with open(os.path.join(self.repo, self.C), "wb") as fh:
            fh.write(b"this is not an EDF file\n" * 40)
        for rel, onsets in (("sub-01/eeg/sub-01_task-rest_events.tsv", (0.5, 1.5, 2.5)),
                            ("sub-02/eeg/sub-02_task-rest_events.tsv", (0.25, 0.75))):
            with open(os.path.join(self.repo, rel), "w") as fh:
                fh.write("onset\tduration\ttrial_type\n")
                fh.writelines(f"{t}\t0.1\tgo\n" for t in onsets)
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "events and an unreadable recording")

    def events_rows(self) -> list[dict]:
        import pyarrow.parquet as pq

        path = os.path.join(self.s3, "on008083_zarr_events.parquet")
        return pq.read_table(path).to_pylist()

    def _defer_b_then_publish(self) -> dict:
        """The first run: A converts (with events), B is too large for any volume and
        is deferred, C is an unreadable EDF and becomes a typed failure. Returns the
        index it published."""
        self._make_b_enormous()
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.01
        index = self.first_round()
        self.assertEqual([f["path"] for f in index["failures"]], [self.C])
        self.assertTrue(index["errors"] > 0, "a live index with no errors proves nothing")
        return index

    def test_an_all_deferred_run_restates_what_the_live_index_says(self):
        # The backend derives the dataset's row from this body (its error and failure
        # counts, a bounded summary of pending and discovered counts, the ETag), so a
        # field restated wrongly (a zero error count, no ETag) changes that row on every
        # hourly tick of a recording that never fits. Not every field below reaches the
        # row (the failure entries and the events row count do not); each is pinned
        # here as part of the body the script POSTs.
        live = self._defer_b_then_publish()
        self._no_scratch()
        before = self._s3_snapshot()
        rc, log, body = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertIn("left untouched", log)
        self.assertEqual(self._s3_snapshot(), before, "an S3 object was written")
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["errors"], live["errors"])
        self.assertEqual(body["failure_count"], live["failure_count"])
        self.assertEqual(
            body["data_failures"],
            [{"path": self.C, "code": "corrupt_or_truncated"}],
            "the typed failure the index carries",
        )
        # Not deterministic: B is still owed, so the dataset is not all data failures.
        self.assertIs(body["deterministic"], False)
        self.assertEqual(
            body["index_etag"], hashlib.md5(self._index_bytes()).hexdigest(),
            "the ETag of the published index, unquoted",
        )
        self.assertEqual(body["commit"], live["source_commit"])
        self.assertEqual(body["store_count"], live["store_count"])
        self.assertEqual((body["pending_count"], body["not_attempted_count"]), (1, 1))
        self.assertEqual(body["discovered_count"], 3)
        self.assertEqual(body["events_row_count"], live["events_row_count"])
        self.assertEqual(body["events_row_count"], 3)
        self.assertEqual((body["converted"], body["removed"], body["failed"]), ([], [], []))

    def test_an_all_deferred_run_reports_no_failure_of_its_own(self):
        # Nothing was attempted, so nothing failed for a retryable reason: the
        # driver's "N recording(s) failed for a RETRYABLE reason" line would otherwise
        # repeat every hour for a recording that is only waiting for room.
        self._defer_b_then_publish()
        self._no_scratch()
        rc, log, body = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertIn("left untouched", log)
        self.assertEqual(body["pending_count"], 1)
        self.assertEqual(body["retryable_failures"], 0)

    def test_a_companion_pointer_with_no_size_makes_the_recording_charged_the_floor(self):
        # B's primary pointer declares a small size, but a same-stem companion's
        # pointer is a WORM key with no `-s` field, so the total cannot be trusted
        # even though it is positive: the recording is charged at least
        # SCRATCH_UNKNOWN_SIZE_BYTES. With a floor no volume holds it can never fit,
        # while A (real files of known size) converts. Reading the size as known would
        # charge B its few bytes and attempt it, and B has no content to convert.
        link = os.path.join(self.repo, self.B)
        os.remove(link)
        sized = "SHA256E-s2000--" + "b" * 32 + ".edf"
        os.symlink(f"../../.git/annex/objects/bb/bb/{sized}/{sized}", link)
        companion = os.path.join(self.repo, "sub-02/eeg/sub-02_task-rest_eeg.json")
        unsized = "WORM-m1700000000--sub-02_task-rest_eeg.json"
        os.symlink(f"../../.git/annex/objects/cc/cc/{unsized}/{unsized}", companion)
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "B has a sized primary and an unsized companion")
        self.addCleanup(
            setattr, generate_zarr, "SCRATCH_UNKNOWN_SIZE_BYTES",
            generate_zarr.SCRATCH_UNKNOWN_SIZE_BYTES,
        )
        generate_zarr.SCRATCH_UNKNOWN_SIZE_BYTES = 10**18
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.01
        rc, log, _ = self.run_main("--retry-pending")
        self.assertEqual(rc, 0, log)
        self.assertIn("the size of 1 recording(s) could not be read from their pointers", log)
        self.assertIn(f"(first: {self.B})", log)
        self.assertIn(f"::error::{self.B} can never fit this volume", log)
        self.assertIn(f"converted {self.A}", log)
        index = self.published_index()
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        entry = next(p for p in index["pending"] if p["path"] == self.B)
        self.assertEqual((entry["reason"], entry["attempts"]), ("not_attempted", 0))
        self.assertTrue(entry["last_error"].startswith("deferred: needs"), entry["last_error"])

    def test_a_kept_store_under_clean_carries_its_events_rows_beside_the_converted_ones(self):
        # --clean rebuilds from scratch, so the rows of a store it deferred and the
        # index kept have to come from the LIVE events.parquet: A's three rows from
        # the first run, and B's two from this one. Losing A's would leave the index
        # serving a store with no events behind it.
        build_real_edf(os.path.join(self.repo, "sub-01", "eeg"), "sub-01_task-rest_eeg", seconds=30)
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "A is longer")
        self.first_round()
        self.assertEqual({r["store_path"] for r in self.events_rows()}, {store_rel_for(self.A)})
        self.materialize_b()
        self._bigger_a_streams_with_an_absurd_charge()
        rc, log, body = self.run_main()  # --clean, no --retry-pending
        self.assertEqual(rc, 0, log)
        self.assertIn(f"converted {self.B}", log)
        self.assertNotIn(f"converted {self.A}", log)
        index = self.published_index()
        self.assertEqual(sorted(s["path"] for s in index["stores"]), [self.A, self.B])
        per_store: dict[str, int] = {}
        for row in self.events_rows():
            per_store[row["store_path"]] = per_store.get(row["store_path"], 0) + 1
        self.assertEqual(per_store, {store_rel_for(self.A): 3, store_rel_for(self.B): 2})
        self.assertEqual(index["events_row_count"], 5)
        self.assertEqual(body["events_row_count"], 5)
        self.assertEqual(body["events_stores_without_rows"], 0)


class TestLiveAdmissionCeiling(unittest.TestCase):
    """#1483: the admission ceiling follows the node's memory during the run,
    charging in-flight recordings only for what they have not yet taken.

    The /proc files are real-shaped fixtures written to a temporary directory,
    in the kernel's own `Key:   <n> kB` format, and read by the same functions
    that read the live ones."""

    GIB = 1024**3

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = self._tmp.name
        self.meminfo = os.path.join(self.root, "meminfo")
        self.proc = os.path.join(self.root, "proc")
        self.track = os.path.join(self.root, "track")
        os.makedirs(self.proc)
        os.makedirs(self.track)
        self.addCleanup(os.environ.pop, "ZARR_MEM_HEADROOM_FRAC", None)
        os.environ.pop("ZARR_MEM_HEADROOM_FRAC", None)
        self.available(10 * self.GIB)

    def available(self, n):
        with open(self.meminfo, "w") as fh:
            fh.write(f"MemTotal:       {64 * self.GIB // 1024} kB\n")
            fh.write(f"MemFree:        {n // 2048} kB\n")
            fh.write(f"MemAvailable:   {n // 1024} kB\n")

    def worker(self, pid, *, reserve, start, now):
        """A tracked recording in flight: its track file and its /proc status."""
        with open(os.path.join(self.track, f"{pid}.json"), "w") as fh:
            json.dump({"reserve": reserve, "rss_anon_start": start}, fh)
        if now is not None:
            os.makedirs(os.path.join(self.proc, str(pid)))
            with open(os.path.join(self.proc, str(pid), "status"), "w") as fh:
                fh.write(f"Name:\tpython3\nVmRSS:\t{now // 1024} kB\n"
                         f"RssAnon:\t{now // 1024} kB\nRssFile:\t 2048 kB\n")

    def ceiling(self, running_peak, *, static=3 * GIB, hard=None):
        return live_admission_ceiling(
            static, hard, running_peak, self.track,
            meminfo_path=self.meminfo, proc_root=self.proc,
        )

    def test_idle_it_is_the_headroom_of_what_is_available_now(self):
        self.assertEqual(self.ceiling(0), 8 * self.GIB)
        self.available(20 * self.GIB)  # a tenant finished: the ceiling rises
        self.assertEqual(self.ceiling(0), 16 * self.GIB)
        self.available(5 * self.GIB)  # a tenant grew: it falls
        self.assertEqual(self.ceiling(0), 4 * self.GIB)

    def test_it_never_exceeds_the_hardware_ceiling(self):
        self.assertEqual(self.ceiling(0, hard=6 * self.GIB), 6 * self.GIB)

    def test_off_linux_the_static_ceiling_applies(self):
        os.remove(self.meminfo)
        self.assertEqual(self.ceiling(0), 3 * self.GIB)

    def test_what_a_recording_has_taken_is_not_charged_twice(self):
        # 1.5 GiB of its 4 GiB reserve is already out of MemAvailable; the other
        # 2.5 GiB is still owed.
        self.worker(101, reserve=4 * self.GIB, start=self.GIB, now=int(2.5 * self.GIB))
        self.assertEqual(self.ceiling(4 * self.GIB), int(9.5 * self.GIB))

    def test_credit_is_capped_at_the_reserve(self):
        # Retained heap from an earlier recording must not buy extra room.
        self.worker(101, reserve=4 * self.GIB, start=0, now=7 * self.GIB)
        self.assertEqual(self.ceiling(4 * self.GIB), 12 * self.GIB)

    def test_an_untracked_or_unreadable_recording_is_charged_in_full(self):
        self.worker(101, reserve=4 * self.GIB, start=0, now=None)  # process gone
        self.assertEqual(self.ceiling(4 * self.GIB), 8 * self.GIB)
        with open(os.path.join(self.track, "102.json"), "w") as fh:
            fh.write("{not json")
        self.assertEqual(self.ceiling(4 * self.GIB), 8 * self.GIB)

    def test_credit_never_exceeds_what_is_in_flight(self):
        # A track file can outlive its recording by an instant.
        self.worker(101, reserve=4 * self.GIB, start=0, now=3 * self.GIB)
        self.assertEqual(self.ceiling(self.GIB), 9 * self.GIB)
        self.assertEqual(self.ceiling(0), 8 * self.GIB)

    def test_the_live_readers_work_where_proc_exists(self):
        if not sys.platform.startswith("linux"):
            self.assertIsNone(mem_available_bytes())
            return
        self.assertGreater(mem_available_bytes(), 0)
        self.assertGreater(anon_rss_bytes(os.getpid()), 1024**2)
        self.assertIsNone(anon_rss_bytes(2**22 + 12345))


class TestTrackedCall(unittest.TestCase):
    """`_tracked_call` leaves a record for the parent while the recording runs,
    and removes it however the recording ends."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.track = self._tmp.name

    def test_the_record_exists_while_the_worker_runs(self):
        out = _tracked_call(_track_listing_worker, self.track, 123, self.track)
        self.assertEqual(out["files"], [f"{os.getpid()}.json"])
        self.assertEqual(out["record"]["reserve"], 123)
        if sys.platform.startswith("linux"):
            self.assertIsInstance(out["record"]["rss_anon_start"], int)
        else:  # nothing to measure; the parent then charges the full reserve
            self.assertIsNone(out["record"]["rss_anon_start"])
        self.assertEqual(os.listdir(self.track), [])

    def test_the_record_is_removed_when_the_worker_raises(self):
        with self.assertRaises(RuntimeError):
            _tracked_call(_track_failing_worker, self.track, 1, self.track)
        self.assertEqual(os.listdir(self.track), [])


class TestAdmissionFollowsTheCeiling(unittest.TestCase):
    """A drain re-reads its ceiling while recordings run, not only when one
    finishes (#1483). The ceiling here is a file the test rewrites mid-run, in
    place of /proc: the node's memory is the environment, not the logic."""

    RESERVE = 100

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.limit = os.path.join(self._tmp.name, "limit")
        self.set_limit(150)  # room for one recording at a time
        self.addCleanup(
            setattr, generate_zarr, "ADMISSION_RECHECK_SECONDS",
            generate_zarr.ADMISSION_RECHECK_SECONDS,
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.05

    def set_limit(self, n):
        # Replaced atomically: the drain reads this from another thread, and a
        # truncate-then-write would let it read an empty file.
        tmp = self.limit + ".tmp"
        with open(tmp, "w") as fh:
            fh.write(str(n))
        os.replace(tmp, self.limit)

    def ceiling(self, _running_peak, _track_dir):
        with open(self.limit) as fh:
            return int(fh.read())

    def run_drain(self, raise_after=None):
        import threading

        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 4)]
        results = []
        if raise_after is not None:
            timer = threading.Timer(raise_after, self.set_limit, args=(10**6,))
            timer.start()
            self.addCleanup(timer.cancel)
        _drain_with_admission(
            primaries, {p: self.RESERVE for p in primaries}, 3, 10**12, {},
            lambda r, i: results.append(r), worker=_timed_worker, ceiling=self.ceiling,
        )
        self.assertEqual(len(results), 3)
        return sorted(r["span"] for r in results)

    def test_a_tight_ceiling_runs_recordings_one_at_a_time(self):
        spans = self.run_drain()
        for earlier, later in itertools.pairwise(spans):
            self.assertGreaterEqual(later[0], earlier[1] - 0.01)

    def test_memory_freed_mid_run_is_used_before_anything_finishes(self):
        spans = self.run_drain(raise_after=0.2)
        # The first recording is still running (0.8 s) when the ceiling rises
        # at 0.2 s; the others start then, not when it finishes.
        first_end = spans[0][1]
        self.assertLess(spans[1][0], first_end)
        self.assertLess(spans[2][0], first_end)


def write_eeglab_set(set_path: str, fdt_path: str | None, *, nbchan: int = 4,
                     pnts: int = 1000, srate: float = 250.0,
                     embedded: str = "orig_name.fdt") -> None:
    """A real classic EEGLAB `.set` (fields saved flat, as EEGLAB's own
    `pop_saveset` does) whose samples are a float32 `.fdt` written column-major
    at `fdt_path`, which need NOT sit beside the `.set`. `fdt_path=None` embeds
    the matrix inline instead. Skips the calling test when numpy or scipy is
    missing (the CI fast tier installs neither)."""
    try:
        import numpy as np
        import scipy.io
    except ImportError as exc:
        raise unittest.SkipTest(f"{exc.name} not installed") from exc

    rng = np.random.default_rng(7)
    data = (rng.standard_normal((nbchan, pnts)) * 1e-5).astype(np.float32)
    fields = {
        "setname": np.array(["fdt_declaration_fixture"]),
        "nbchan": np.array([[nbchan]]),
        "trials": np.array([[1]]),
        "pnts": np.array([[pnts]]),
        "srate": np.array([[srate]]),
        "xmin": np.array([[0.0]]),
        "xmax": np.array([[(pnts - 1) / srate]]),
    }
    if fdt_path is None:
        fields["data"] = data.astype(np.float64)
    else:
        os.makedirs(os.path.dirname(fdt_path), exist_ok=True)
        data.flatten(order="F").tofile(fdt_path)
        fields["data"] = np.array([embedded])
    os.makedirs(os.path.dirname(set_path), exist_ok=True)
    scipy.io.savemat(set_path, fields)


class TestBlobKeyAndSize(unittest.TestCase):
    """`_blob_key_and_size` over a real git repository: every tracked shape it
    has to tell apart, including an in-git blob too large to be a pointer (sized
    by `git cat-file -s`, never read)."""

    KEY = "SHA256E-s2048--" + "a" * 64 + ".fdt"

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = tmp.name

        def git(*args):
            return subprocess.run(["git", *args], cwd=self.repo, check=True,
                                  capture_output=True, text=True).stdout.strip()

        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.org")
        git("config", "user.name", "t")
        with open(os.path.join(self.repo, "big.fdt"), "wb") as fh:
            fh.write(b"\x01" * 5000)
        with open(os.path.join(self.repo, "small.fdt"), "wb") as fh:
            fh.write(b"\x01" * 10)
        with open(os.path.join(self.repo, "unlocked.fdt"), "w") as fh:
            fh.write(f"/annex/objects/{self.KEY}\n")
        os.symlink(f".git/annex/objects/Xx/Yy/{self.KEY}/{self.KEY}",
                   os.path.join(self.repo, "locked.fdt"))
        git("add", "-A")
        git("commit", "-q", "-m", "fixture")
        self.head = git("rev-parse", "HEAD")

    def test_each_shape(self):
        cases = {
            "big.fdt": (None, 5000),
            "small.fdt": (None, 10),
            "unlocked.fdt": (self.KEY, 0),
            "locked.fdt": (self.KEY, 0),
            "absent.fdt": (None, 0),
        }
        for path, want in cases.items():
            with self.subTest(path):
                self.assertEqual(generate_zarr._blob_key_and_size(self.repo, path, self.head), want)


def sha256e_key(path: str) -> str:
    """The git-annex SHA256E key of a file's bytes, as a declaration pins it."""
    with open(path, "rb") as fh:
        data = fh.read()
    return f"SHA256E-s{len(data)}--{hashlib.sha256(data).hexdigest()}.fdt"


class TestFdtDeclarationFile(unittest.TestCase):
    """The committed declaration file, and the loader's refusals."""

    def write(self, doc) -> str:
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump(doc, fh)
        self.addCleanup(os.remove, path)
        return path

    @staticmethod
    def doc(recordings):
        return {"datasets": {"on000001": {"reviewed": "2026-09-28", "recordings": recordings}}}

    ENTRY: ClassVar[dict] = {
        "fdt": "derivatives/fdt/a.fdt", "nbchan": 2, "pnts": 10, "trials": 1, "fdt_bytes": 80,
        "annex_key": "SHA256E-s80--" + "0" * 64 + ".fdt",
    }

    def test_the_committed_file_loads_and_names_only_raw_recordings(self):
        decls = generate_zarr.load_fdt_declarations()
        self.assertEqual(set(decls), {"on004306"})
        recs = decls["on004306"]
        self.assertEqual(len(recs), 15)
        for set_path, d in recs.items():
            self.assertFalse(generate_zarr.is_excluded_from_discovery(set_path))
            self.assertEqual(d["fdt_bytes"], d["nbchan"] * d["pnts"] * d["trials"] * 4)
            # Every entry is pinned to content whose size is the declared size.
            self.assertEqual(generate_zarr.annex_key_size(d["annex_key"]), d["fdt_bytes"])
            self.assertTrue(d["annex_key"].endswith(".fdt"))
        self.assertEqual(len({d["annex_key"] for d in recs.values()}), len(recs))
        # The misnamed file is paired by size and folder, not by its name.
        self.assertEqual(
            recs["sub-013/ses-01/eeg/sub-013_ses-01_task-experiment_run-01_eeg.set"]["fdt"],
            "derivatives/fdt_files/sub13_sess-01/sub12_sess01.fdt",
        )

    def test_invalid_json_is_a_value_error(self):
        path = self.write({})
        with open(path, "w") as fh:
            fh.write("{not json")
        with self.assertRaises(ValueError):
            generate_zarr.load_fdt_declarations(path)

    def test_a_missing_file_declares_nothing(self):
        self.assertEqual(generate_zarr.load_fdt_declarations("/nonexistent/decl.json"), {})

    def test_a_valid_entry_loads(self):
        path = self.write(self.doc({"sub-01/eeg/sub-01_eeg.set": dict(self.ENTRY)}))
        self.assertEqual(
            generate_zarr.load_fdt_declarations(path)["on000001"]["sub-01/eeg/sub-01_eeg.set"]["fdt"],
            "derivatives/fdt/a.fdt",
        )

    def test_refusals(self):
        cases = {
            "bytes disagree with the dimensions":
                {"sub-01/eeg/sub-01_eeg.set": {**self.ENTRY, "fdt_bytes": 84}},
            "unknown key": {"sub-01/eeg/sub-01_eeg.set": {**self.ENTRY, "fdt_path": "x.fdt"}},
            "missing key": {"sub-01/eeg/sub-01_eeg.set": {
                k: v for k, v in self.ENTRY.items() if k != "pnts"}},
            "one fdt for two sets": {
                "sub-01/eeg/sub-01_eeg.set": dict(self.ENTRY),
                "sub-02/eeg/sub-02_eeg.set": dict(self.ENTRY),
            },
            "a non-raw recording": {"derivatives/x/sub-01_eeg.set": dict(self.ENTRY)},
            "path escapes the repo": {"sub-01/eeg/sub-01_eeg.set": {
                **self.ENTRY, "fdt": "../elsewhere/a.fdt"}},
            "a boolean count": {"sub-01/eeg/sub-01_eeg.set": {**self.ENTRY, "trials": True}},
            "an entry that is not an object": {"sub-01/eeg/sub-01_eeg.set": ["x.fdt"]},
            "no annex_key": {"sub-01/eeg/sub-01_eeg.set": {
                k: v for k, v in self.ENTRY.items() if k != "annex_key"}},
            "annex_key size disagrees": {"sub-01/eeg/sub-01_eeg.set": {
                **self.ENTRY, "annex_key": "SHA256E-s84--" + "0" * 64 + ".fdt"}},
            "annex_key is not SHA-256": {"sub-01/eeg/sub-01_eeg.set": {
                **self.ENTRY, "annex_key": "MD5E-s80--" + "0" * 32 + ".fdt"}},
            "annex_key is not a string": {"sub-01/eeg/sub-01_eeg.set": {
                **self.ENTRY, "annex_key": 80}},
            "one content for two sets": {
                "sub-01/eeg/sub-01_eeg.set": dict(self.ENTRY),
                "sub-02/eeg/sub-02_eeg.set": {**self.ENTRY, "fdt": "derivatives/fdt/b.fdt"},
            },
        }
        # Paths the loader must refuse whichever side of the pairing they are on.
        unsafe = {
            "empty segment": "derivatives//a.fdt",
            "dot segment": "derivatives/./a.fdt",
            "leading dot segment": "./derivatives/a.fdt",
            "bare extension": ".fdt",
            "bare extension in a folder": "derivatives/.fdt",
            "NUL": "derivatives/a\0.fdt",
            "absolute": "/derivatives/a.fdt",
            "backslash": "derivatives\\a.fdt",
            "wrong extension": "derivatives/a.set",
            "not a string": 7,
        }
        for name, fdt in unsafe.items():
            cases[f"fdt: {name}"] = {"sub-01/eeg/sub-01_eeg.set": {**self.ENTRY, "fdt": fdt}}
        cases["set: dot segment"] = {"sub-01/./eeg/sub-01_eeg.set": dict(self.ENTRY)}
        for name, recordings in cases.items():
            with self.subTest(name), self.assertRaises(generate_zarr.FdtDeclarationFileError):
                generate_zarr.load_fdt_declarations(self.write(self.doc(recordings)))
        shapes = {
            "no `reviewed`": {"datasets": {"on000001": {"recordings": {}}}},
            "recordings is not an object": {
                "datasets": {"on000001": {"reviewed": "2026-09-28", "recordings": []}}},
            "a dataset that is not an object": {"datasets": {"on000001": "x"}},
            "datasets is not an object": {"datasets": []},
            "unknown top-level key": {"datasets": {}, "extra": 1},
            "unknown dataset key": {"datasets": {"on000001": {
                "reviewed": "2026-09-28", "recordings": {}, "notes": "x"}}},
            # fullmatch: a prefix match would accept a trailing suffix.
            "dataset id with a suffix": {"datasets": {"on000001x": {
                "reviewed": "2026-09-28", "recordings": {}}}},
            "dataset id with a newline": {"datasets": {"on000001\n": {
                "reviewed": "2026-09-28", "recordings": {}}}},
        }
        for name, doc in shapes.items():
            with self.subTest(name), self.assertRaises(generate_zarr.FdtDeclarationFileError):
                generate_zarr.load_fdt_declarations(self.write(doc))


class TestDeclaredFdtConvertOne(unittest.TestCase):
    """`convert_one` over a real EEGLAB `.set` whose `.fdt` lives under
    `derivatives/`, as on004306 ships it. Both materialization paths are driven:
    local mode (the working tree) and the remote path, whose blob fetch reads a
    real git repository (in-git blobs, so no S3 read is needed). `aws s3 sync`
    is the only external call and a no-op executable absorbs it, as in
    TestConvertOneEndToEnd."""

    SET = "sub-01/eeg/sub-01_task-x_eeg.set"
    FDT = "derivatives/fdt_files/sub1_sess-01/sub1_sess1.fdt"
    NBCHAN, PNTS = 4, 1000

    @classmethod
    def setUpClass(cls):
        try:
            import scipy.io  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        write_eeglab_set(os.path.join(self.repo, self.SET), os.path.join(self.repo, self.FDT),
                         nbchan=self.NBCHAN, pnts=self.PNTS)
        # The reviewed content, pinned before any test alters the file.
        self.key = sha256e_key(os.path.join(self.repo, self.FDT))
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)

    def commit(self) -> str:
        def git(*args):
            return subprocess.run(["git", *args], cwd=self.repo, check=True,
                                  capture_output=True, text=True).stdout.strip()

        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.org")
        git("config", "user.name", "t")
        git("add", "-A")
        git("commit", "-q", "-m", "fixture")
        return git("rev-parse", "HEAD")

    def decl(self, **over) -> dict:
        d = {"fdt": self.FDT, "nbchan": self.NBCHAN, "pnts": self.PNTS, "trials": 1,
             "fdt_bytes": self.NBCHAN * self.PNTS * 4, "annex_key": self.key}
        d.update(over)
        return d

    def convert(self, declarations, *, local=True, head="b" * 40, extra_files=()):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "on000001",
            "head": head, "head_files": {self.SET, self.FDT, *extra_files}, "local": local,
            "tmp": work.name, "updated": "2026-09-28T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": "3",
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
            "fdt_declarations": declarations,
        })
        return convert_one(self.SET)

    def assert_converted(self, result):
        self.assertTrue(result["ok"], result.get("error"))
        (group,) = result["entry"]["groups"]
        self.assertEqual(group["n_channels"], self.NBCHAN)
        self.assertEqual(group["n_samples"], self.PNTS)

    def test_an_undeclared_dataset_is_refused_for_the_fdt_its_tree_lacks(self):
        # No declaration, and the tree has no .fdt beside the .set nor under the
        # name the header embeds: `companion_missing` (it was `file_read_error`,
        # "none was found"), naming the file by its BIDS path. It is the
        # declaration that supplies this .fdt, so it is not a declaration refusal.
        result = self.convert({})
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "companion_missing")
        self.assertIn("sub-01/eeg/sub-01_task-x_eeg.fdt", result["error"])
        self.assertNotEqual(result["code"], "fdt_declaration_refused")

    def test_a_declared_fdt_converts_in_local_mode(self):
        self.assert_converted(self.convert({self.SET: self.decl()}))
        # The working tree is untouched: nothing was written beside the .set.
        self.assertFalse(os.path.exists(os.path.join(self.repo, "sub-01/eeg/sub-01_task-x_eeg.fdt")))

    def test_the_header_gate_reads_the_staged_set(self):
        # The gate reads the header of the `.set` actually converted, here the
        # staged one beside its declared `.fdt`: an inherited channels.tsv that
        # over-declares is disclosed, not refused.
        tsv = "sub-01/sub-01_task-x_channels.tsv"
        with open(os.path.join(self.repo, tsv), "w") as fh:
            fh.writelines(["name\ttype\tunits\n"] + [f"M{i}\tMEGMAG\tT\n" for i in range(9)])
        result = self.convert({self.SET: self.decl()}, extra_files=(tsv,))
        self.assert_converted(result)
        self.assertEqual(
            result["entry"]["channels_tsv_count_mismatch"],
            {"channels_tsv": 9, "in_file": self.NBCHAN, "in_store": self.NBCHAN},
        )

    def test_a_declared_fdt_converts_through_the_blob_fetch(self):
        head = self.commit()
        self.assert_converted(self.convert({self.SET: self.decl()}, local=False, head=head))

    def test_a_size_mismatch_is_refused_before_conversion(self):
        # The declaration agrees with itself and with the header; the FILE is short.
        with open(os.path.join(self.repo, self.FDT), "r+b") as fh:
            fh.truncate(self.NBCHAN * self.PNTS * 4 - 4)
        for local in (True, False):
            with self.subTest(local=local):
                head = "b" * 40 if local else self.commit()
                result = self.convert({self.SET: self.decl()}, local=local, head=head)
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "fdt_declaration_refused")
                self.assertIn("bytes", result["error"])

    def test_same_size_different_content_is_refused(self):
        # Right name, right size, wrong bytes: only the content pin can tell.
        path = os.path.join(self.repo, self.FDT)
        with open(path, "r+b") as fh:
            fh.write(b"\x00\x00\x00\x00")
        for local in (True, False):
            with self.subTest(local=local):
                head = "b" * 40 if local else self.commit()
                result = self.convert({self.SET: self.decl()}, local=local, head=head)
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "fdt_declaration_refused")
                self.assertIn("not the reviewed content", result["error"])

    def test_a_declaration_the_header_contradicts_is_refused(self):
        wrong = self.decl(nbchan=8, fdt_bytes=8 * self.PNTS * 4)
        result = self.convert({self.SET: wrong})
        self.assertEqual(result["code"], "fdt_declaration_refused")
        self.assertIn("header", result["error"])

    def test_an_fdt_absent_at_head_is_refused(self):
        result = self.convert({self.SET: self.decl(fdt="derivatives/fdt_files/other.fdt")})
        self.assertEqual(result["code"], "fdt_declaration_refused")

    def test_a_corrupt_set_is_refused_typed_not_retried(self):
        set_path = os.path.join(self.repo, self.SET)
        with open(set_path, "rb") as fh:
            raw = fh.read()
        for name, content in {
            "truncated": raw[: len(raw) // 2],
            "not a MAT file": b"\x99" * 500,
            "empty": b"",
        }.items():
            with self.subTest(name):
                with open(set_path, "wb") as fh:
                    fh.write(content)
                with self.assertRaises(generate_zarr.FdtDeclarationRefused):
                    generate_zarr.eeglab_fdt_layout(set_path)
                result = self.convert({self.SET: self.decl()})
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "fdt_declaration_refused")
                self.assertIn("could not be read", result["error"])

    def test_the_remote_path_requires_bucket_and_dataset_id(self):
        head = self.commit()
        for missing in ("bucket", "dataset_id"):
            with self.subTest(missing), tempfile.TemporaryDirectory() as work:
                kwargs = {"bucket": "nemar-test", "dataset_id": "on000001", missing: None}
                with self.assertRaises(ValueError):
                    generate_zarr.stage_declared_fdt(
                        cast("generate_zarr.FdtDeclaration", self.decl()), self.SET, os.path.join(self.repo, self.SET), work,
                        repo=self.repo, head_files={self.SET, self.FDT}, head=head,
                        local=False, **kwargs,
                    )
                self.assertEqual(os.listdir(work), [], "nothing staged")

    def test_a_set_with_inline_samples_is_refused(self):
        write_eeglab_set(os.path.join(self.repo, self.SET), None,
                         nbchan=self.NBCHAN, pnts=self.PNTS)
        result = self.convert({self.SET: self.decl()})
        self.assertEqual(result["code"], "fdt_declaration_refused")
        self.assertIn("inline", result["error"])

    def test_a_set_that_already_has_a_sibling_fdt_is_refused(self):
        sibling = "sub-01/eeg/sub-01_task-x_eeg.fdt"
        result = self.convert({self.SET: self.decl()}, extra_files=(sibling,))
        self.assertEqual(result["code"], "fdt_declaration_refused")
        self.assertIn("sibling", result["error"])

    def test_a_v73_set_is_refused(self):
        # A v7.3 MAT-file is an HDF5 container behind this 128-byte text header;
        # the header alone is what the refusal reads.
        with open(os.path.join(self.repo, self.SET), "wb") as fh:
            fh.write(b"MATLAB 7.3 MAT-file, Platform: GLNXA64".ljust(128, b" "))
            fh.write(b"\x89HDF\r\n\x1a\n" + b"\x00" * 512)
        result = self.convert({self.SET: self.decl()})
        self.assertEqual(result["code"], "fdt_declaration_refused")
        self.assertIn("v7.3", result["error"])

    def test_an_fdt_listed_but_absent_from_the_tree_is_refused(self):
        # The remote path fetches against the pinned head: a path head_files
        # names but the tree at that commit lacks is refused, never fetched.
        ghost = "derivatives/fdt_files/ghost.fdt"
        head = self.commit()
        result = self.convert({self.SET: self.decl(fdt=ghost)}, local=False, head=head,
                              extra_files=(ghost,))
        self.assertEqual(result["code"], "fdt_declaration_refused")
        self.assertIn("not in the tree", result["error"])


class TestDeclaredFdtAnnexed(unittest.TestCase):
    """The remote path over an ANNEXED `.fdt`, as on004306 ships it: the tree
    holds a git-annex symlink whose key is compared with the declaration's pin
    and whose `-s` field is the size, both BEFORE any download; the bytes then
    come from the (stubbed, file-backed) bucket's `objects/<key>`."""

    SET = TestDeclaredFdtConvertOne.SET
    FDT = TestDeclaredFdtConvertOne.FDT
    NBCHAN, PNTS = 4, 1000

    @classmethod
    def setUpClass(cls):
        try:
            import scipy.io  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        os.makedirs(self.s3)
        content = os.path.join(self.dir, "content.fdt")
        write_eeglab_set(os.path.join(self.repo, self.SET), content,
                         nbchan=self.NBCHAN, pnts=self.PNTS)
        self.key = sha256e_key(content)
        shutil.copyfile(content, os.path.join(self.s3, f"on000001_objects_{self.key}"))

        def git(*args):
            return subprocess.run(["git", *args], cwd=self.repo, check=True,
                                  capture_output=True, text=True).stdout.strip()

        self.git = git
        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.org")
        git("config", "user.name", "t")
        self.point_fdt_at(self.key)

        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        self.log = os.path.join(self.dir, "aws.log")
        saved = {k: os.environ.get(k) for k in ("PATH", "ZARR_TEST_S3_ROOT", "ZARR_TEST_S3_LOG")}
        os.environ["PATH"] = bindir + os.pathsep + (saved["PATH"] or "")
        os.environ["ZARR_TEST_S3_ROOT"] = self.s3
        os.environ["ZARR_TEST_S3_LOG"] = self.log
        self.addCleanup(self._restore_env, saved)

    @staticmethod
    def _restore_env(saved):
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def point_fdt_at(self, key: str) -> None:
        """Commit the `.fdt` as a locked git-annex symlink to `key` (content
        absent locally, exactly as a metadata clone has it)."""
        link = os.path.join(self.repo, self.FDT)
        os.makedirs(os.path.dirname(link), exist_ok=True)
        if os.path.lexists(link):
            os.remove(link)
        target = os.path.join(self.repo, ".git", "annex", "objects", "Xx", "Yy", key, key)
        os.symlink(os.path.relpath(target, os.path.dirname(link)), link)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", f"point at {key[:20]}")
        self.head = self.git("rev-parse", "HEAD")

    def decl(self) -> dict:
        return {"fdt": self.FDT, "nbchan": self.NBCHAN, "pnts": self.PNTS, "trials": 1,
                "fdt_bytes": self.NBCHAN * self.PNTS * 4, "annex_key": self.key}

    def convert(self) -> dict:
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "on000001",
            "head": self.head, "head_files": {self.SET, self.FDT}, "local": False,
            "tmp": work.name, "updated": "2026-09-28T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": "3",
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
            "fdt_declarations": {self.SET: self.decl()},
        })
        return convert_one(self.SET)

    def fetched_objects(self) -> list[str]:
        if not os.path.exists(self.log):
            return []
        with open(self.log) as fh:
            return [line for line in fh if "/objects/" in line]

    def test_the_pinned_annex_object_is_downloaded_and_converts(self):
        result = self.convert()
        self.assertTrue(result["ok"], result.get("error"))
        (group,) = result["entry"]["groups"]
        self.assertEqual((group["n_channels"], group["n_samples"]), (self.NBCHAN, self.PNTS))
        (fetch,) = self.fetched_objects()
        self.assertIn(self.key, fetch)

    def test_a_different_key_is_refused_before_download(self):
        # Same declared size, different content: the key in the tree is not the pin.
        other = self.key.replace(self.key.split("--")[1][:8], "00000000", 1)
        self.point_fdt_at(other)
        result = self.convert()
        self.assertEqual(result["code"], "fdt_declaration_refused")
        self.assertIn("not the reviewed content", result["error"])
        self.assertEqual(self.fetched_objects(), [])

    def test_a_key_of_another_size_is_refused_before_download(self):
        # The annex key's `-s` field is the size seen before fetching; a key
        # declaring any other size never reaches the multi-GB download.
        want = self.NBCHAN * self.PNTS * 4
        self.point_fdt_at(self.key.replace(f"-s{want}--", f"-s{want * 2}--"))
        result = self.convert()
        self.assertEqual(result["code"], "fdt_declaration_refused")
        self.assertIn(f"-s{want * 2}--", result["error"])
        self.assertEqual(self.fetched_objects(), [])


class TestDeclaredFdtWiring(unittest.TestCase):
    """What connects a declaration to a run: `main()` loads it and hands it to
    the worker context on both conversion paths, admission counts the declared
    bytes, the serial memory retry keeps it, and the refusal is classified as
    data rather than infrastructure."""

    SET = TestDeclaredFdtConvertOne.SET
    FDT = TestDeclaredFdtConvertOne.FDT

    def test_the_refusal_is_a_data_failure_with_its_own_reason(self):
        code = generate_zarr.FdtDeclarationRefused.code
        self.assertEqual(code, "fdt_declaration_refused")
        self.assertNotIn(code, generate_zarr.RETRYABLE_CODES)
        entry = generate_zarr._failure_entry(self.SET, code, "detail")
        self.assertEqual(generate_zarr.count_infra_failures([self.SET], [entry]), 0)
        self.assertIn("did not match the recording's header",
                      generate_zarr.reason_for_code(code))
        self.assertNotEqual(generate_zarr.reason_for_code(code),
                            generate_zarr.reason_for_code("an_unknown_code"))

    def test_admission_counts_the_declared_fdt(self):
        with tempfile.TemporaryDirectory() as repo:
            write_eeglab_set(os.path.join(repo, self.SET), os.path.join(repo, self.FDT))

            def git(*args):
                return subprocess.run(["git", *args], cwd=repo, check=True,
                                      capture_output=True, text=True).stdout.strip()

            git("init", "-q", "-b", "main")
            git("config", "user.email", "t@example.org")
            git("config", "user.name", "t")
            git("add", "-A")
            git("commit", "-q", "-m", "fixture")
            head = git("rev-parse", "HEAD")
            head_set = set(generate_zarr.git_ls_files(repo, head))
            decl: generate_zarr.FdtDeclaration = {
                "fdt": self.FDT, "nbchan": 4, "pnts": 1000, "trials": 1,
                "fdt_bytes": 16000, "annex_key": "SHA256E-s16000--" + "0" * 64 + ".fdt",
            }
            bare = generate_zarr.admission_sizes(repo, [self.SET], head_set, head, {})
            declared = generate_zarr.admission_sizes(
                repo, [self.SET], head_set, head, {self.SET: decl}
            )
        self.assertGreater(bare[self.SET], 0)
        self.assertEqual(declared[self.SET], bare[self.SET] + 16000)

    def test_the_memory_retry_context_keeps_the_declarations(self):
        decls = {self.SET: {"fdt": self.FDT}}
        ctx = {"hard_ceiling": None, "mem_budget": 1, "fdt_declarations": decls, "repo": "r"}
        retry_ctx, budget = generate_zarr.memory_retry_context(ctx)
        self.assertIs(retry_ctx["fdt_declarations"], decls)
        self.assertEqual(retry_ctx["mem_budget"], budget)
        self.assertEqual(retry_ctx["repo"], "r")
        capped, capped_budget = generate_zarr.memory_retry_context({**ctx, "hard_ceiling": 5})
        self.assertLessEqual(capped_budget, 5)
        self.assertEqual(capped["mem_budget"], capped_budget)


class TestMainConvertsADeclaredFdt(unittest.TestCase):
    """`main()` end to end over a dataset whose `.fdt` sits under
    `derivatives/`, with the declaration read from a real file. The recording
    converts only if the declaration reached the worker context, so a run with
    `--jobs 1` (in-process) and one with `--jobs 2` (a pool worker, whose context
    travels through the pool initializer) each prove one wiring; the same run
    with the declaration file empty fails as it did before this feature."""

    SET = TestDeclaredFdtConvertOne.SET
    FDT = TestDeclaredFdtConvertOne.FDT

    @classmethod
    def setUpClass(cls):
        try:
            import scipy.io  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        os.makedirs(self.s3)
        write_eeglab_set(os.path.join(self.repo, self.SET), os.path.join(self.repo, self.FDT))
        for args in (("init", "-q", "-b", "main"), ("config", "user.email", "t@example.org"),
                     ("config", "user.name", "t"), ("add", "-A"),
                     ("commit", "-q", "-m", "fixture")):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)
        self.decl_path = os.path.join(self.dir, "decl.json")
        saved_path = generate_zarr.FDT_DECLARATIONS_PATH
        generate_zarr.FDT_DECLARATIONS_PATH = self.decl_path
        self.addCleanup(setattr, generate_zarr, "FDT_DECLARATIONS_PATH", saved_path)

        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        saved = {k: os.environ.get(k) for k in ("PATH", "ZARR_TEST_S3_ROOT")}
        os.environ["PATH"] = bindir + os.pathsep + (saved["PATH"] or "")
        os.environ["ZARR_TEST_S3_ROOT"] = self.s3
        self.addCleanup(self._restore_env, saved)
        saved_ctx = dict(generate_zarr._CTX)
        self.addCleanup(lambda: (generate_zarr._CTX.clear(), generate_zarr._CTX.update(saved_ctx)))

    @staticmethod
    def _restore_env(saved):
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def declare(self, recordings: dict) -> None:
        with open(self.decl_path, "w") as fh:
            json.dump({"description": "test", "datasets": {"on000001": {
                "reviewed": "2026-09-28", "recordings": recordings}}}, fh)

    def run_main(self, jobs: int) -> tuple[int, str, dict]:
        callback = os.path.join(self.dir, f"cb{jobs}.json")
        argv = [
            "generate_zarr.py", "--dataset-id", "on000001", "--repo-dir", self.repo,
            "--bucket", "nemar-test", "--callback-out", callback,
            "--local", "--clean", "--jobs", str(jobs), "--api-base", "http://127.0.0.1:9",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = generate_zarr.main()
        finally:
            sys.argv = saved
        with open(callback) as fh:
            return rc, out.getvalue(), json.load(fh)

    def test_a_declared_fdt_converts_in_process_and_in_a_pool_worker(self):
        self.declare({self.SET: {
            "fdt": self.FDT, "nbchan": 4, "pnts": 1000, "trials": 1, "fdt_bytes": 16000,
            "annex_key": sha256e_key(os.path.join(self.repo, self.FDT)),
        }})
        # --jobs 2 first, from an empty context: it must convert while leaving
        # this process's context untouched, i.e. in a pool worker.
        generate_zarr._CTX.clear()
        rc, log, _ = self.run_main(2)
        self.assertEqual(rc, 0, log)
        self.assertIn(f"converted {self.SET}", log)
        self.assertEqual(generate_zarr._CTX, {}, "converted in-process, not in the pool")
        rc, log, _ = self.run_main(1)
        self.assertEqual(rc, 0, log)
        self.assertIn(f"converted {self.SET}", log)
        self.assertIn(f"using declared .fdt {self.FDT!r}", log)
        self.assertEqual(generate_zarr._CTX["fdt_declarations"][self.SET]["fdt"], self.FDT)

    def test_without_a_declaration_the_recording_still_fails(self):
        self.declare({})
        _, log, _ = self.run_main(1)
        self.assertNotIn(f"converted {self.SET}", log)
        self.assertIn("sub-01/eeg/sub-01_task-x_eeg.fdt is not in the dataset tree", log)


# A stand-in `aws` that serves a local directory laid out EXACTLY like the bucket:
# `<root>/<bucket>/<id>/objects/<key>` holds the object `s3://<bucket>/<id>/objects/<key>`.
# It answers the calls the annex fetch, the store upload and `main()`'s index
# round trip make, with the real CLI's shapes: `s3 cp` (a missing key prints the
# CLI's own 404 line and exits 1; `-` streams to stdout; a local source uploads),
# `s3api list-objects-v2` (prefix match: `Contents[].[Key,Size]` as JSON,
# `null` when nothing matches; `Contents[0].Key` and `CommonPrefixes[].Prefix`
# as text, `None` when empty), `s3api get-object`/`put-object` with the ETag
# and the conditional-write refusal, `s3 sync` and `s3 rm`. Every call is
# logged, so a test can count requests.
BUCKET_AWS = r"""#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import sys

ROOT = os.environ["ZARR_TEST_BUCKET_ROOT"]
args = [a for a in sys.argv[1:] if a != "--only-show-errors"]
clean, skip = [], False
for a in args:
    if skip:
        skip = False
        continue
    if a.startswith("--cli-"):
        skip = True
        continue
    clean.append(a)
args = clean
with open(os.environ["ZARR_TEST_BUCKET_LOG"], "a") as fh:
    fh.write(" ".join(args) + "\n")


def opt(name):
    return args[args.index(name) + 1]


def split(uri):
    bucket, _, key = uri[len("s3://"):].partition("/")
    return bucket, key


def etag(path):
    with open(path, "rb") as fh:
        return chr(34) + hashlib.md5(fh.read()).hexdigest() + chr(34)


def keys_under(bucket, prefix):
    top = os.path.join(ROOT, bucket)
    out = []
    for d, _, files in os.walk(top):
        for f in files:
            key = os.path.relpath(os.path.join(d, f), top).replace(os.sep, "/")
            if key.startswith(prefix):
                out.append([key, os.path.getsize(os.path.join(d, f))])
    return sorted(out)


fail = os.environ.get("ZARR_TEST_BUCKET_FAIL")
if fail and any(fail in a for a in args):
    # The CLI's own shape for a transfer that failed part-way: it quotes the
    # source, and so the key, whose hash digits can contain "404".
    where = f"download failed: {args[2]} to {args[3]} " if args[:2] == ["s3", "cp"] else ""
    sys.stderr.write(where + "An error occurred (InternalError) when calling the GetObject "
                     "operation (reached max retries: 9): We encountered an internal error.\n")
    sys.exit(1)
# A caller without s3:ListBucket, the way `s3://nemar` treats anonymous callers
# (.memory/s3-403-is-not-absence.md): "all" -- S3 will not say whether a key
# exists, so a missing key answers 403 rather than 404, and a listing is
# AccessDenied; "list" -- only the listing is denied.
no_list = os.environ.get("ZARR_TEST_BUCKET_NO_LIST")
if no_list and args[:2] == ["s3api", "list-objects-v2"]:
    sys.stderr.write("An error occurred (AccessDenied) when calling the ListObjectsV2 "
                     "operation: Access Denied\n")
    sys.exit(254)
if args[:2] == ["s3", "cp"] and args[2].startswith("s3://"):
    bucket, key = split(args[2])
    path = os.path.join(ROOT, bucket, key)
    if not os.path.isfile(path):
        if no_list == "all":
            sys.stderr.write("fatal error: An error occurred (403) when calling the "
                             "HeadObject operation: Forbidden\n")
            sys.exit(1)
        sys.stderr.write("fatal error: An error occurred (404) when calling the HeadObject "
                         f'operation: Key "{key}" does not exist\n')
        sys.exit(1)
    if args[3] == "-":
        with open(path, "rb") as fh:
            sys.stdout.buffer.write(fh.read())
        sys.exit(0)
    shutil.copyfile(path, args[3])
    short = os.environ.get("ZARR_TEST_BUCKET_SHORT_ONCE")
    marker = os.path.join(ROOT, ".short-once-done")
    if short and short in args[2] and not os.path.exists(marker):
        # A transfer that "succeeds" but lands short, once: the transient
        # shape `download_blob`'s size check exists for.
        open(marker, "w").close()
        with open(args[3], "r+b") as fh:
            fh.truncate(max(0, os.path.getsize(path) - 1))
    sys.exit(0)
if args[:2] == ["s3", "cp"] and args[3].startswith("s3://"):
    bucket, key = split(args[3])
    os.makedirs(os.path.dirname(os.path.join(ROOT, bucket, key)), exist_ok=True)
    shutil.copyfile(args[2], os.path.join(ROOT, bucket, key))
    sys.exit(0)
if args[:2] == ["s3api", "list-objects-v2"]:
    bucket, prefix = opt("--bucket"), opt("--prefix")
    rows = keys_under(bucket, prefix)
    query = opt("--query")
    if query == "Contents[0].Key":
        print(rows[0][0] if rows else "None")
    elif query == "CommonPrefixes[].Prefix":
        subs = sorted({prefix + k[len(prefix):].split("/", 1)[0] + "/"
                       for k, _ in rows if "/" in k[len(prefix):]})
        print("\t".join(subs) if subs else "None")
    else:
        print(json.dumps(rows or None))
    sys.exit(0)
if args[:2] == ["s3api", "get-object"]:
    path = os.path.join(ROOT, opt("--bucket"), opt("--key"))
    if not os.path.isfile(path):
        sys.stderr.write("An error occurred (NoSuchKey) when calling the GetObject "
                         "operation: The specified key does not exist.\n")
        sys.exit(254)
    shutil.copyfile(path, args[args.index("--key") + 2])
    print(etag(path))
    sys.exit(0)
if args[:2] == ["s3api", "put-object"]:
    path = os.path.join(ROOT, opt("--bucket"), opt("--key"))
    exists = os.path.isfile(path)
    if ("--if-match" in args and (not exists or etag(path) != opt("--if-match"))) or (
        "--if-none-match" in args and exists
    ):
        sys.stderr.write("An error occurred (PreconditionFailed) when calling the "
                         "PutObject operation\n")
        sys.exit(254)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    shutil.copyfile(opt("--body"), path)
    print(json.dumps({"ETag": etag(path)}))
    sys.exit(0)
if args[:2] == ["s3", "sync"]:
    bucket, key = split(args[3])
    shutil.copytree(args[2], os.path.join(ROOT, bucket, key), dirs_exist_ok=True)
    sys.exit(0)
if args[:2] == ["s3", "rm"]:
    bucket, key = split(args[2])
    target = os.path.join(ROOT, bucket, key)
    if os.path.isdir(target):
        shutil.rmtree(target)
    elif os.path.isfile(target):
        os.remove(target)
    sys.exit(0)
sys.stderr.write("unexpected aws call: " + " ".join(args) + "\n")
sys.exit(2)
"""


def sha256e(data: bytes, ext: str) -> str:
    """The SHA256E git-annex key of `data`, as a pointer file names it."""
    return f"SHA256E-s{len(data)}--{hashlib.sha256(data).hexdigest()}{ext}"


class BucketStandIn:
    """A file-backed bucket with a real `aws` executable in front of it."""

    BUCKET = "nemar"
    DATASET = "nm000276"

    def __init__(self, test: unittest.TestCase, root: str) -> None:
        self.root = os.path.join(root, "s3")
        self.objects = os.path.join(self.root, self.BUCKET, self.DATASET, "objects")
        os.makedirs(self.objects)
        bindir = os.path.join(root, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(BUCKET_AWS)
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        self.log = os.path.join(root, "aws.log")
        saved = {k: os.environ.get(k) for k in
                 ("PATH", "ZARR_TEST_BUCKET_ROOT", "ZARR_TEST_BUCKET_LOG", "ZARR_TEST_BUCKET_FAIL",
                  "ZARR_TEST_BUCKET_SHORT_ONCE", "ZARR_TEST_BUCKET_NO_LIST")}
        os.environ["PATH"] = bindir + os.pathsep + (saved["PATH"] or "")
        os.environ["ZARR_TEST_BUCKET_ROOT"] = self.root
        os.environ["ZARR_TEST_BUCKET_LOG"] = self.log
        os.environ.pop("ZARR_TEST_BUCKET_FAIL", None)
        os.environ.pop("ZARR_TEST_BUCKET_SHORT_ONCE", None)
        os.environ.pop("ZARR_TEST_BUCKET_NO_LIST", None)

        def restore():
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

        test.addCleanup(restore)
        # The chunk-size cache is per process and per dataset; every test starts
        # from a process that has discovered nothing.
        generate_zarr._ANNEX_CHUNK_SIZE.clear()
        test.addCleanup(generate_zarr._ANNEX_CHUNK_SIZE.clear)

    def put_plain(self, key: str, data: bytes) -> None:
        with open(os.path.join(self.objects, key), "wb") as fh:
            fh.write(data)

    def put_chunked(self, key: str, data: bytes, chunk_size: int) -> int:
        """Store `data` the way git-annex `chunk=<chunk_size>` does; returns the
        number of chunks."""
        pieces = [data[i:i + chunk_size] for i in range(0, len(data), chunk_size)] or [b""]
        for n, piece in enumerate(pieces, start=1):
            with open(os.path.join(self.objects, generate_zarr.annex_chunk_key(key, chunk_size, n)), "wb") as fh:
                fh.write(piece)
        return len(pieces)

    def calls(self, verb: str | None = None) -> list[str]:
        if not os.path.exists(self.log):
            return []
        with open(self.log) as fh:
            lines = [ln.strip() for ln in fh if ln.strip()]
        return [ln for ln in lines if verb is None or ln.startswith(verb)]


class TestChunkedAnnexFetch(unittest.TestCase):
    """`fetch_annex_object` against a bucket laid out like nm000276, which was
    uploaded with git-annex chunking: the pointer names
    `SHA256E-s<size>--<hash>.<ext>` and the bucket holds only
    `SHA256E-s<size>-S<chunk>-C<n>--<hash>.<ext>`. The chunk size here is 1024
    bytes, not the production 1 GiB, and the code must learn it from the listing.
    Real `aws` subprocesses over real files; nothing in the fetch is replaced."""

    CHUNK = 1024

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.s3 = BucketStandIn(self, tmp.name)
        self.scratch = os.path.join(tmp.name, "scratch")
        os.makedirs(self.scratch)
        saved = generate_zarr._AWS_RETRIES
        self.addCleanup(setattr, generate_zarr, "_AWS_RETRIES", saved)

    def fetch(self, key: str, name: str = "out") -> str:
        dst = os.path.join(self.scratch, name)
        generate_zarr.fetch_annex_object(self.s3.BUCKET, self.s3.DATASET, key, dst)
        return dst

    def assert_bytes(self, path: str, data: bytes) -> None:
        with open(path, "rb") as fh:
            self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), hashlib.sha256(data).hexdigest())

    def test_a_plain_key_costs_one_request_as_before(self):
        data = os.urandom(5000)
        key = sha256e(data, ".edf")
        self.s3.put_plain(key, data)
        self.assert_bytes(self.fetch(key), data)
        (call,) = self.s3.calls()
        self.assertEqual(call.split()[:3], ["s3", "cp", f"s3://nemar/nm000276/objects/{key}"])

    def test_a_small_file_stored_as_one_chunk(self):
        # The nm000276 `.vhdr`: 982 bytes, stored only as `-S<chunk>-C1`.
        data = b"Brain Vision Data Exchange Header File Version 1.0\n".ljust(982, b";")
        key = sha256e(data, ".vhdr")
        self.assertEqual(self.s3.put_chunked(key, data, self.CHUNK), 1)
        self.assert_bytes(self.fetch(key), data)
        calls = self.s3.calls()
        self.assertEqual(len(calls), 3, calls)  # plain 404, one listing, C1
        self.assertIn(f"{key.split('--')[0]}-S{self.CHUNK}-C1--", calls[2])

    def test_a_multi_chunk_file_reassembles_byte_identically(self):
        data = os.urandom(self.CHUNK * 4 + 321)
        key = sha256e(data, ".eeg")
        self.assertEqual(self.s3.put_chunked(key, data, self.CHUNK), 5)
        self.assert_bytes(self.fetch(key), data)
        fetched = [c.split()[2] for c in self.s3.calls("s3 cp")][1:]
        self.assertEqual(
            fetched,
            [f"s3://nemar/nm000276/objects/{generate_zarr.annex_chunk_key(key, self.CHUNK, n)}"
             for n in range(1, 6)],
            "chunks are fetched in order, each once",
        )
        self.assertEqual(os.listdir(self.scratch), ["out"], "no chunk or assembly file left")

    def test_an_exact_multiple_has_no_empty_trailing_chunk(self):
        data = os.urandom(self.CHUNK * 3)
        key = sha256e(data, ".eeg")
        self.assertEqual(self.s3.put_chunked(key, data, self.CHUNK), 3)
        self.assert_bytes(self.fetch(key), data)
        self.assertEqual(generate_zarr.annex_chunk_sizes(len(data), self.CHUNK), [self.CHUNK] * 3)
        self.assertEqual(generate_zarr.annex_chunk_sizes(0, self.CHUNK), [0])

    def assert_refused(self, key: str, *needles: str) -> str:
        with self.assertRaises(generate_zarr.AnnexObjectMissing) as cm:
            self.fetch(key)
        for needle in needles:
            self.assertIn(needle, str(cm.exception))
        self.assertEqual(os.listdir(self.scratch), [], "nothing partial left in scratch")
        self.assertEqual(cm.exception.code, "annex_object_missing")
        return str(cm.exception)

    def test_a_missing_middle_chunk_is_refused_and_leaves_nothing(self):
        data = os.urandom(self.CHUNK * 2 + 10)
        key = sha256e(data, ".eeg")
        self.s3.put_chunked(key, data, self.CHUNK)
        os.remove(os.path.join(self.s3.objects, generate_zarr.annex_chunk_key(key, self.CHUNK, 2)))
        self.assert_refused(key, "chunk C2", "absent")
        # Decided from the listing: no chunk download was started for a copy
        # the listing already showed to be incomplete.
        self.assertEqual(len(self.s3.calls("s3 cp")), 1)

    def test_a_chunk_of_the_wrong_size_is_refused(self):
        data = os.urandom(self.CHUNK * 2 + 10)
        key = sha256e(data, ".eeg")
        self.s3.put_chunked(key, data, self.CHUNK)
        with open(os.path.join(self.s3.objects, generate_zarr.annex_chunk_key(key, self.CHUNK, 2)), "wb") as fh:
            fh.write(b"\0" * 1000)
        self.assert_refused(key, "chunk C2", "1000 bytes", f"expected {self.CHUNK}")

    def test_an_object_stored_in_no_form_is_refused(self):
        self.assert_refused(sha256e(b"never uploaded", ".edf"), "no chunked copy")
        self.assertEqual(len(self.s3.calls()), 2)  # the plain 404 and one listing, no retries

    def test_chunks_of_another_key_with_the_same_size_are_not_mistaken_for_it(self):
        # The listing prefix is `<backend>-s<size>-S`, which every chunked key of
        # the same size shares; only the exact name may match.
        other = os.urandom(700)
        self.s3.put_chunked(sha256e(other, ".vhdr"), other, self.CHUNK)
        mine = os.urandom(700)
        self.assert_refused(sha256e(mine, ".vhdr"), "no chunked copy")

    def test_a_transient_failure_stays_retryable_and_never_lists(self):
        generate_zarr._AWS_RETRIES = 1
        data = os.urandom(100)
        # A key whose digits contain "404", quoted in the CLI's error line: a
        # dropped transfer must not be read as an absent object.
        key = f"SHA256E-s{len(data)}--4040{hashlib.sha256(data).hexdigest()[4:]}.edf"
        self.s3.put_plain(key, data)
        os.environ["ZARR_TEST_BUCKET_FAIL"] = key
        with self.assertRaises(RuntimeError) as cm:
            self.fetch(key)
        self.assertNotIsInstance(cm.exception, generate_zarr.AnnexObjectMissing)
        self.assertIsNone(getattr(cm.exception, "code", None))
        self.assertIn("InternalError", str(cm.exception))
        self.assertEqual(self.s3.calls("s3api"), [], "a 5xx is not a 404; no chunk discovery")

    def test_a_failed_listing_is_an_error_not_an_absence(self):
        generate_zarr._AWS_RETRIES = 1
        key = sha256e(b"x" * 50, ".edf")
        os.environ["ZARR_TEST_BUCKET_FAIL"] = "list-objects-v2"
        with self.assertRaises(RuntimeError) as cm:
            self.fetch(key)
        self.assertNotIsInstance(cm.exception, generate_zarr.AnnexObjectMissing)
        self.assertIn("listing chunked copies", str(cm.exception))

    def test_a_403_on_the_plain_key_is_retried_uncoded_and_never_looks_for_chunks(self):
        # Without s3:ListBucket, S3 answers a MISSING key with 403, not 404, and
        # a 403 has other causes too: expired credentials, a private dataset, a
        # signature without its session token. None of them is evidence of
        # absence, so the copy is retried like any other failure, ends uncoded
        # (infra, the recording stays pending), and the chunk fallback -- which
        # a 404 alone unlocks -- is never tried. For a chunked dataset that
        # means every recording fails this way: safe, but the feature does
        # nothing until the profile can list `<id>/objects/`.
        generate_zarr._AWS_RETRIES = 2
        data = os.urandom(2500)
        key = sha256e(data, ".eeg")
        self.s3.put_chunked(key, data, self.CHUNK)
        os.environ["ZARR_TEST_BUCKET_NO_LIST"] = "all"
        with self.assertRaises(RuntimeError) as cm:
            self.fetch(key)
        self.assertNotIsInstance(cm.exception, generate_zarr.AnnexObjectMissing)
        self.assertIsNone(getattr(cm.exception, "code", None))
        self.assertIn("(403)", str(cm.exception))
        plain = f"s3://nemar/nm000276/objects/{key}"
        self.assertEqual([c.split()[2] for c in self.s3.calls("s3 cp")], [plain, plain],
                         "the plain key, retried; no chunk fetched")
        self.assertEqual(self.s3.calls("s3api"), [], "a 403 is not a 404; no chunk discovery")
        self.assertEqual(os.listdir(self.scratch), [])

    def test_an_access_denied_listing_is_retried_uncoded(self):
        # The plain key is a definite 404, so the listing runs, and is refused.
        # Refused is not empty: an empty listing would type the recording as
        # missing, a refused one says nothing about what is stored.
        generate_zarr._AWS_RETRIES = 2
        data = os.urandom(2500)
        key = sha256e(data, ".eeg")
        self.s3.put_chunked(key, data, self.CHUNK)
        os.environ["ZARR_TEST_BUCKET_NO_LIST"] = "list"
        with self.assertRaises(RuntimeError) as cm:
            self.fetch(key)
        self.assertNotIsInstance(cm.exception, generate_zarr.AnnexObjectMissing)
        self.assertIsNone(getattr(cm.exception, "code", None))
        self.assertIn("listing chunked copies", str(cm.exception))
        self.assertIn("AccessDenied", str(cm.exception))
        self.assertEqual(len(self.s3.calls("s3api list-objects-v2")), 2, "retried")
        self.assertEqual(len(self.s3.calls("s3 cp")), 1, "the plain 404 only; no chunk fetched")
        self.assertNotIn(("nemar", "nm000276"), generate_zarr._ANNEX_CHUNK_SIZE)

    def test_the_chunk_size_is_discovered_once_per_dataset(self):
        blobs = [os.urandom(n) for n in (3000, 982, 2500)]
        keys = [sha256e(b, ".eeg") for b in blobs]
        for key, data in zip(keys, blobs):
            self.s3.put_chunked(key, data, self.CHUNK)
        for i, (key, data) in enumerate(zip(keys, blobs)):
            self.assert_bytes(self.fetch(key, f"f{i}"), data)
        self.assertEqual(len(self.s3.calls("s3api list-objects-v2")), 1)
        self.assertEqual(generate_zarr._ANNEX_CHUNK_SIZE[("nemar", "nm000276")], self.CHUNK)

    def test_a_key_stored_under_another_chunk_size_is_still_found(self):
        a, b = os.urandom(3000), os.urandom(3000)
        ka, kb = sha256e(a, ".eeg"), sha256e(b, ".eeg")
        self.s3.put_chunked(ka, a, self.CHUNK)
        self.s3.put_chunked(kb, b, 2048)
        self.assert_bytes(self.fetch(ka, "a"), a)
        self.assert_bytes(self.fetch(kb, "b"), b)
        self.assertEqual(len(self.s3.calls("s3api list-objects-v2")), 2)

    def test_a_missing_chunk_under_the_cached_size_is_refused(self):
        a, b = os.urandom(3000), os.urandom(3000)
        ka, kb = sha256e(a, ".eeg"), sha256e(b, ".eeg")
        self.s3.put_chunked(ka, a, self.CHUNK)
        self.s3.put_chunked(kb, b, self.CHUNK)
        self.fetch(ka, "a")
        os.remove(os.path.join(self.scratch, "a"))
        os.remove(os.path.join(self.s3.objects, generate_zarr.annex_chunk_key(kb, self.CHUNK, 3)))
        self.assert_refused(kb, "chunk C3", "absent")

    def test_a_chunk_stored_at_the_wrong_size_under_the_cached_size_is_typed(self):
        # With the chunk size cached, the chunks are fetched without a listing,
        # so the only thing that sees a wrong-sized chunk is `download_blob`'s
        # size check. That used to end uncoded after every retry, on every run,
        # for a chunk that is simply stored wrong. It now hands over to the
        # listing, which reads the STORED size and types the refusal.
        generate_zarr._AWS_RETRIES = 2
        a, b = os.urandom(3000), os.urandom(3000)
        ka, kb = sha256e(a, ".eeg"), sha256e(b, ".eeg")
        self.s3.put_chunked(ka, a, self.CHUNK)
        self.s3.put_chunked(kb, b, self.CHUNK)
        self.fetch(ka, "a")
        os.remove(os.path.join(self.scratch, "a"))
        bad = generate_zarr.annex_chunk_key(kb, self.CHUNK, 2)
        with open(os.path.join(self.s3.objects, bad), "wb") as fh:
            fh.write(b"\0" * 1000)
        self.assert_refused(kb, "chunk C2", "1000 bytes", f"expected {self.CHUNK}")
        # The bad chunk was retried as a possibly short transfer, then the
        # listing decided: a second listing, for this key alone.
        self.assertEqual(len([c for c in self.s3.calls("s3 cp") if bad in c]), 2)
        self.assertEqual(len(self.s3.calls("s3api list-objects-v2")), 2)

    def test_a_short_transfer_under_the_cached_size_is_fetched_again(self):
        # The other half: the stored chunk is right and the copy was short.
        # The listing agrees with the key, so the fetch goes ahead and succeeds.
        generate_zarr._AWS_RETRIES = 1
        a, b = os.urandom(3000), os.urandom(3000)
        ka, kb = sha256e(a, ".eeg"), sha256e(b, ".eeg")
        self.s3.put_chunked(ka, a, self.CHUNK)
        self.s3.put_chunked(kb, b, self.CHUNK)
        self.fetch(ka, "a")
        os.environ["ZARR_TEST_BUCKET_SHORT_ONCE"] = generate_zarr.annex_chunk_key(kb, self.CHUNK, 2)
        self.assert_bytes(self.fetch(kb, "b"), b)
        self.assertEqual(len(self.s3.calls("s3api list-objects-v2")), 2)


class TestChunkedAnnexConvertOne(unittest.TestCase):
    """`convert_one` in remote mode over real EDF recordings whose annex objects
    are stored chunked, as nm000276's are: the pointer in the tree holds the
    plain key, the bucket holds only `-S<chunk>-C<n>` objects, and the store is
    published back into the same (file-backed) bucket."""

    CHUNK = 1024
    RECS = ("sub-01/ieeg/sub-01_task-rest_ieeg.edf", "sub-02/ieeg/sub-02_task-rest_ieeg.edf")

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
            from biosigio import Recording  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.s3 = BucketStandIn(self, self.dir)
        self.repo = os.path.join(self.dir, "repo")

        def git(*args):
            return subprocess.run(["git", *args], cwd=self.repo, check=True,
                                  capture_output=True, text=True).stdout.strip()

        os.makedirs(self.repo)
        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.org")
        git("config", "user.name", "t")
        self.keys = {}
        for rec in self.RECS:
            content = build_labeled_edf(os.path.join(self.dir, os.path.basename(rec)),
                                        ["C1", "C2", "C3"])
            with open(content, "rb") as fh:
                data = fh.read()
            key = sha256e(data, ".edf")
            self.assertGreater(self.s3.put_chunked(key, data, self.CHUNK), 3)
            link = os.path.join(self.repo, rec)
            os.makedirs(os.path.dirname(link), exist_ok=True)
            target = os.path.join(self.repo, ".git", "annex", "objects", "Xx", "Yy", key, key)
            os.symlink(os.path.relpath(target, os.path.dirname(link)), link)
            self.keys[rec] = key
        git("add", "-A")
        git("commit", "-q", "-m", "chunked fixture")
        self.head = git("rev-parse", "HEAD")
        self.work = os.path.join(self.dir, "work")
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": self.s3.BUCKET, "dataset_id": self.s3.DATASET,
            "head": self.head, "head_files": set(self.RECS), "local": False,
            "tmp": self.work, "updated": "2026-09-29T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": "3",
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
            "fdt_declarations": {},
        })

    def test_chunked_recordings_convert_and_publish(self):
        for rec in self.RECS:
            with self.subTest(rec):
                result = convert_one(rec)
                self.assertTrue(result["ok"], result.get("error"))
                (group,) = result["entry"]["groups"]
                self.assertEqual(group["n_channels"], 3)
                # Provenance names the key the pointer holds, not a chunk.
                self.assertEqual(result["manifest"]["source_key"], self.keys[rec])
                store = os.path.join(self.s3.root, self.s3.BUCKET, self.s3.DATASET, "zarr",
                                     store_rel_for(rec), "zarr.json")
                self.assertTrue(os.path.isfile(store), "store published to the bucket")
        # One listing for the whole dataset: the second recording reuses the
        # discovered chunk size.
        self.assertEqual(len(self.s3.calls("s3api list-objects-v2")), 1)
        self.assertFalse(os.listdir(os.path.join(self.work, "work")), "scratch reclaimed")

    def test_a_missing_chunk_refuses_the_recording_as_data(self):
        rec = self.RECS[0]
        os.remove(os.path.join(self.s3.objects,
                               generate_zarr.annex_chunk_key(self.keys[rec], self.CHUNK, 2)))
        with contextlib.redirect_stdout(io.StringIO()):
            result = convert_one(rec)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "annex_object_missing")
        self.assertIn("chunk C2", result["detail"])
        self.assertNotIn(result["code"], RETRYABLE_CODES)
        entry = _failure_entry(rec, result["code"], result["detail"])
        self.assertEqual(count_infra_failures([rec], [entry]), 0)
        self.assertIn("missing or incomplete", generate_zarr.reason_for_code(result["code"]))
        self.assertFalse(os.path.exists(os.path.join(self.s3.root, self.s3.BUCKET, self.s3.DATASET, "zarr")),
                         "nothing published for a refused recording")



class TestAnnexMissingDatasetVerdict(unittest.TestCase):
    """`dataset_failure_is_deterministic`, the rule behind the callback's
    `deterministic`, which `hallu-zarr.sh` turns into a terminal `data_failed`
    for a run that converted nothing. `annex_object_missing` is permanent for
    its recording but must not, on its own, make the DATASET terminal."""

    @staticmethod
    def entry(path: str, code: str) -> generate_zarr.FailureEntry:
        return _failure_entry(path, code, f"{code} detail")

    def verdict(self, *codes: str | None) -> bool:
        paths = [f"sub-{i:02d}/eeg/r.edf" for i in range(len(codes))]
        entries = [self.entry(p, c) for p, c in zip(paths, codes) if c]
        return generate_zarr.dataset_failure_is_deterministic(paths, entries)

    def test_the_code_is_a_storage_state_code_and_not_a_retryable_one(self):
        code = generate_zarr.AnnexObjectMissing.code
        self.assertIn(code, generate_zarr.STORAGE_STATE_CODES)
        self.assertNotIn(code, RETRYABLE_CODES)

    def test_every_recording_missing_its_object_is_not_deterministic(self):
        self.assertFalse(self.verdict("annex_object_missing"))
        self.assertFalse(self.verdict("annex_object_missing", "annex_object_missing"))

    def test_a_genuine_data_failure_among_missing_objects_is_deterministic(self):
        self.assertTrue(self.verdict("annex_object_missing", "corrupt_or_truncated"))
        self.assertTrue(self.verdict("channel_count_mismatch", "annex_object_missing"))

    def test_the_existing_rule_is_unchanged_for_every_other_code(self):
        self.assertFalse(self.verdict())  # nothing failed
        self.assertTrue(self.verdict("corrupt_or_truncated"))
        self.assertTrue(self.verdict("corrupt_or_truncated", "maxshield_uncalibrated"))
        # Any infra failure keeps the run retryable, with or without the code.
        self.assertFalse(self.verdict("corrupt_or_truncated", None))
        self.assertFalse(self.verdict("annex_object_missing", None))
        self.assertFalse(self.verdict("recording_memory_exceeded", "corrupt_or_truncated"))

    def test_the_summary_names_the_first_missing_object_by_path(self):
        summary = generate_zarr.annex_missing_summary(
            [("sub-02/eeg/b.edf", "KEY-B"), ("sub-01/eeg/a.edf", "KEY-A")]
        )
        self.assertEqual(summary, {
            "annex_missing_count": 2,
            "annex_missing_first_path": "sub-01/eeg/a.edf",
            "annex_missing_first_key": "KEY-A",
        })
        self.assertEqual(generate_zarr.annex_missing_summary([]), {
            "annex_missing_count": 0,
            "annex_missing_first_path": None,
            "annex_missing_first_key": None,
        })

    def test_the_exception_keeps_its_key_across_a_pickle(self):
        import pickle

        exc = generate_zarr.AnnexObjectMissing("SHA256E-s5--ab.edf", "no chunked copy")
        back = pickle.loads(pickle.dumps(exc))
        self.assertEqual((back.key, str(back)), (exc.key, "SHA256E-s5--ab.edf: no chunked copy"))


class TestMainAnnexMissingVerdict(unittest.TestCase):
    """`main()` end to end in remote mode, over real EDF recordings whose annex
    objects are served by the stand-in `aws` from a file-backed bucket: what the
    callback tells `hallu-zarr.sh` when storage lacks some or all of them."""

    CHUNK = 1024
    RECS = ("sub-01/ieeg/sub-01_task-rest_ieeg.edf", "sub-02/ieeg/sub-02_task-rest_ieeg.edf")

    @classmethod
    def setUpClass(cls):
        TestChunkedAnnexConvertOne.setUpClass()

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.s3 = BucketStandIn(self, self.dir)
        self.repo = os.path.join(self.dir, "repo")
        os.makedirs(self.repo)
        saved_ctx = dict(generate_zarr._CTX)
        self.addCleanup(lambda: (generate_zarr._CTX.clear(), generate_zarr._CTX.update(saved_ctx)))

    def build(self, stored: dict[str, str]) -> dict[str, str]:
        """One real EDF per recording, committed as an annex pointer; `stored`
        says what the bucket holds for it: "chunked", "missing" (nothing), or
        "truncated" (the plain object, cut short INSIDE the file, so the size
        in the key matches and biosigIO is what refuses it)."""

        def git(*args):
            return subprocess.run(["git", *args], cwd=self.repo, check=True,
                                  capture_output=True, text=True).stdout.strip()

        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.org")
        git("config", "user.name", "t")
        keys = {}
        for i, (rec, how) in enumerate(stored.items()):
            if how == "refused_bdf":
                # A real BDF+ cut to half its length: pyedflib refuses it
                # ("Filesize"), and biosigIO's tolerant read cannot recover it
                # (unlike a late first onset). Stored plain with a key that
                # vouches for exactly these bytes.
                content = build_truncated_bdfplus(
                    os.path.join(self.dir, os.path.basename(rec))
                )
                ext = ".bdf"
            else:
                # Distinct labels per recording: identical files would share one
                # annex key, and storing one would store the other.
                content = build_labeled_edf(os.path.join(self.dir, os.path.basename(rec)),
                                            [f"R{i}C{n}" for n in (1, 2, 3)])
                ext = ".edf"
            with open(content, "rb") as fh:
                data = fh.read()
            if how == "truncated":
                # Same length, garbage after the fixed header: a file the key
                # vouches for and no reader can decode.
                data = data[:256] + b"\xff" * (len(data) - 256)
            key = sha256e(data, ext)
            if how == "chunked":
                self.s3.put_chunked(key, data, self.CHUNK)
            elif how in ("truncated", "refused_bdf"):
                self.s3.put_plain(key, data)
            link = os.path.join(self.repo, rec)
            os.makedirs(os.path.dirname(link), exist_ok=True)
            target = os.path.join(self.repo, ".git", "annex", "objects", "Xx", "Yy", key, key)
            os.symlink(os.path.relpath(target, os.path.dirname(link)), link)
            keys[rec] = key
        git("add", "-A")
        git("commit", "-q", "-m", "fixture")
        return keys

    def run_main(self) -> tuple[int, str, dict]:
        callback = os.path.join(self.dir, "cb.json")
        argv = [
            "generate_zarr.py", "--dataset-id", self.s3.DATASET, "--repo-dir", self.repo,
            "--bucket", self.s3.BUCKET, "--callback-out", callback,
            "--clean", "--jobs", "1", "--api-base", "http://127.0.0.1:9",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = generate_zarr.main()
        finally:
            sys.argv = saved
        with open(callback) as fh:
            return rc, out.getvalue(), json.load(fh)

    def published_index(self) -> dict | None:
        path = os.path.join(self.s3.root, self.s3.BUCKET, self.s3.DATASET, "zarr", "index.json")
        if not os.path.exists(path):
            return None
        with open(path) as fh:
            return json.load(fh)

    def test_every_recording_missing_is_a_retryable_total_failure(self):
        keys = self.build({rec: "missing" for rec in self.RECS})
        rc, log, cb = self.run_main()
        self.assertEqual(rc, 1, log)
        self.assertEqual(cb["status"], "failed")
        self.assertEqual([e["code"] for e in cb["data_failures"]], ["annex_object_missing"] * 2)
        self.assertFalse(cb["deterministic"], "all missing must not be data_failed")
        self.assertEqual(cb["annex_missing_count"], 2)
        self.assertEqual(cb["annex_missing_first_path"], self.RECS[0])
        self.assertEqual(cb["annex_missing_first_key"], keys[self.RECS[0]])
        self.assertIn("storage lacks the annex object(s) of 2 recording(s)", log)
        self.assertIsNone(self.published_index(), "a total failure publishes nothing")

    def test_a_genuine_data_failure_alongside_a_missing_object_is_deterministic(self):
        self.build({self.RECS[0]: "missing", self.RECS[1]: "truncated"})
        rc, log, cb = self.run_main()
        self.assertEqual(rc, 1, log)
        codes = sorted(e["code"] for e in cb["data_failures"])
        self.assertEqual(len(codes), 2, log)
        self.assertIn("annex_object_missing", codes)
        other = next(c for c in codes if c != "annex_object_missing")
        self.assertNotIn(other, RETRYABLE_CODES)
        self.assertTrue(cb["deterministic"], log)
        self.assertEqual(cb["annex_missing_count"], 1)
        self.assertNotIn("storage lacks the annex object", log)

    def test_a_partial_run_still_serves_and_lists_the_missing_recording(self):
        keys = self.build({self.RECS[0]: "chunked", self.RECS[1]: "missing"})
        rc, log, cb = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertEqual(cb["status"], "ready")
        self.assertEqual(cb["converted"], [store_rel_for(self.RECS[0])])
        self.assertFalse(cb["deterministic"])
        self.assertEqual(cb["annex_missing_first_key"], keys[self.RECS[1]])
        index = self.published_index()
        if index is None:
            self.fail("a partial run publishes its index")
        self.assertEqual([e["path"] for e in index["stores"]], [self.RECS[0]])
        (failure,) = index["failures"]
        self.assertEqual((failure["path"], failure["code"]), (self.RECS[1], "annex_object_missing"))
        self.assertEqual(index["pending"], [], "typed, so not pending")

    BDF = "sub-02/ieeg/sub-02_task-rest_ieeg.bdf"

    def test_a_streamed_refusal_is_a_data_failure_and_never_pending(self):
        # The recording pyedflib refuses, through the STREAMING exporter: it used
        # to reach the callback as an uncoded failure, so the run was not
        # `deterministic`, the recording was `pending`, and it was retried five
        # times before the index called it `retry_exhausted`.
        self.build({self.BDF: "refused_bdf"})
        StreamEdfThreshold.use(self, 1)
        rc, log, cb = self.run_main()
        self.assertEqual(rc, 1, log)
        self.assertEqual(cb["status"], "failed")
        (entry,) = cb["data_failures"]
        self.assertEqual((entry["path"], entry["code"]), (self.BDF, "corrupt_or_truncated"))
        self.assertTrue(cb["deterministic"], log)
        self.assertEqual(cb["pending_count"], 0, "typed, so not pending")
        self.assertIsNone(self.published_index(), "a total failure publishes nothing")

    def test_a_streamed_refusal_beside_a_converting_recording_is_listed_as_a_failure(self):
        self.build({self.RECS[0]: "chunked", self.BDF: "refused_bdf"})
        StreamEdfThreshold.use(self, 1)
        rc, log, cb = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertEqual(cb["status"], "ready")
        self.assertEqual(cb["converted"], [store_rel_for(self.RECS[0])])
        index = self.published_index()
        if index is None:
            self.fail("a partial run publishes its index")
        (failure,) = index["failures"]
        self.assertEqual((failure["path"], failure["code"]), (self.BDF, "corrupt_or_truncated"))
        self.assertEqual(index["pending"], [], "typed, so not pending")


# --- Typed verdicts for missing companion data (#1801) --------------------------


class TestTypedVerdictCodes(unittest.TestCase):
    """The three NEMAR-side codes #1801 adds, and where they sit in the retry
    rules. Pure: no library is read."""

    NEW = ("companion_missing", "split_part_missing", "epoched_recording")

    @staticmethod
    def verdict(*codes: str | None) -> bool:
        paths = [f"sub-{i:02d}/eeg/r.edf" for i in range(len(codes))]
        entries = [_failure_entry(p, c, f"{c} detail") for p, c in zip(paths, codes) if c]
        return generate_zarr.dataset_failure_is_deterministic(paths, entries)

    def test_the_constants_spell_the_published_codes(self):
        self.assertEqual(
            {
                generate_zarr.CompanionMissing.code,
                generate_zarr.SPLIT_PART_MISSING,
                generate_zarr.EPOCHED_RECORDING,
            },
            set(self.NEW),
        )

    def test_each_new_code_has_its_own_reason(self):
        generic = reason_for_code(None)
        reasons = {code: reason_for_code(code) for code in self.NEW}
        for code, reason in reasons.items():
            with self.subTest(code):
                self.assertNotEqual(reason, generic)
        self.assertEqual(len(set(reasons.values())), len(self.NEW), "one sentence per code")
        # And the sentence says the thing: the viewer shows it to a person.
        self.assertIn("not in the dataset", reasons["companion_missing"])
        self.assertIn("split", reasons["split_part_missing"])
        self.assertIn("epoched", reasons["epoched_recording"])
        # `not_continuous` calls its file a derivative; this code does not.
        self.assertNotIn("derivative", reasons["epoched_recording"])

    def test_the_schema_description_lists_each_new_code(self):
        with open(INDEX_SCHEMA_PATH, encoding="utf-8") as fh:
            schema = json.load(fh)
        description = schema["$defs"]["failure"]["properties"]["code"]["description"]
        for code in self.NEW:
            with self.subTest(code):
                self.assertIn(code, description)

    def test_a_run_of_only_new_codes_is_deterministic(self):
        # They are data failures, so a run that converts nothing and fails only
        # with them is terminal, exactly as for corrupt_or_truncated.
        for code in self.NEW:
            with self.subTest(code):
                self.assertTrue(self.verdict(code))
                self.assertTrue(self.verdict(code, code))
                # Alongside a storage-state code the run is still deterministic,
                # because the new code is the genuine data failure in the mix.
                self.assertTrue(self.verdict("annex_object_missing", code))
                # An infrastructure failure (uncoded) keeps the run retryable.
                self.assertFalse(self.verdict(code, None))

    def test_the_new_codes_join_neither_code_set(self):
        # Both sets are pinned: a new code added to either would change what a
        # whole dataset's verdict means.
        self.assertEqual(RETRYABLE_CODES, frozenset({"recording_memory_exceeded"}))
        self.assertEqual(generate_zarr.STORAGE_STATE_CODES, frozenset({"annex_object_missing"}))
        for code in self.NEW:
            with self.subTest(code):
                self.assertNotIn(code, RETRYABLE_CODES)
                self.assertNotIn(code, generate_zarr.STORAGE_STATE_CODES)


class TestVhdrDataFile(unittest.TestCase):
    """`_vhdr_data_file`: the `DataFile=` a BrainVision header names, read the way
    the channel-count rule reads `NumberOfChannels=` (the `[Common Infos]`
    section, the key without regard to case). None when the header names no
    data file or cannot be read: the reader decides then, not this rule."""

    def parse(self, content: str | bytes) -> str | None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sub-01_task-x_eeg.vhdr")
            with open(path, "wb") as fh:
                fh.write(content if isinstance(content, bytes) else content.encode("utf-8"))
            return generate_zarr._vhdr_data_file(path)

    def test_the_file_name(self):
        self.assertEqual(
            self.parse("Brain Vision Data Exchange Header File Version 1.0\n"
                       "[Common Infos]\nCodepage=UTF-8\nDataFile=x.eeg\nMarkerFile=x.vmrk\n"),
            "x.eeg",
        )
        # Spaces around the sign and after the value are not part of the name;
        # one inside it is.
        self.assertEqual(self.parse("[Common Infos]\nDataFile = my data.eeg  \n"), "my data.eeg")

    def test_only_the_common_infos_section_counts(self):
        # A DataFile line in another section, ahead of or behind [Common Infos],
        # names nothing: MNE reads the key from that section alone.
        self.assertIsNone(self.parse("[Marker Infos]\nDataFile=wrong.eeg\n[Common Infos]\nCodepage=UTF-8\n"))
        self.assertIsNone(self.parse("[Common Infos]\nCodepage=UTF-8\n[Binary Infos]\nDataFile=wrong.eeg\n"))
        self.assertEqual(
            self.parse("[Marker Infos]\nDataFile=wrong.eeg\n[Common Infos]\nDataFile=right.eeg\n[Binary Infos]\nDataFile=wrong.eeg\n"),
            "right.eeg",
        )
        # The section name is matched exactly, as the channel count does.
        self.assertIsNone(self.parse("[Common Infos 2]\nDataFile=wrong.eeg\n"))
        # A commented-out line is not a key.
        self.assertIsNone(self.parse("[Common Infos]\n; DataFile=wrong.eeg\n"))

    def test_the_key_is_read_without_regard_to_case(self):
        for key in ("datafile", "DATAFILE", "DataFile", "dataFile"):
            with self.subTest(key):
                self.assertEqual(self.parse(f"[Common Infos]\n{key}=x.eeg\n"), "x.eeg")
        # A longer key that merely starts the same way is a different key.
        self.assertIsNone(self.parse("[Common Infos]\nDataFileFormat=BINARY\n"))

    def test_crlf_line_endings_leave_no_carriage_return_in_the_name(self):
        self.assertEqual(
            self.parse("[Common Infos]\r\nDataFile=x.eeg\r\nMarkerFile=x.vmrk\r\n"), "x.eeg"
        )
        self.assertEqual(self.parse("[Common Infos]\r\nDataFile=x.eeg"), "x.eeg")

    def test_an_absent_or_empty_key_names_nothing(self):
        self.assertIsNone(self.parse("[Common Infos]\nCodepage=UTF-8\n"))
        self.assertIsNone(self.parse("[Common Infos]\nDataFile=\n"))
        self.assertIsNone(self.parse("[Common Infos]\nDataFile=   \n"))
        self.assertIsNone(self.parse(""))

    def test_a_latin1_header_is_read(self):
        # Written by a Windows tool in cp1252: not UTF-8, and `µV` is one byte.
        header = (
            "[Common Infos]\nCodepage=ANSI\nDataFile=é.eeg\n[Channel Infos]\nCh1=Fz,,0.1,µV\n"
        ).encode("latin-1")
        self.assertEqual(self.parse(header), "é.eeg")

    def test_an_unreadable_header_names_nothing(self):
        self.assertIsNone(generate_zarr._vhdr_data_file("/no/such/dir/sub-01_task-x_eeg.vhdr"))


class TestRequireCompanionsVhdr(unittest.TestCase):
    """`require_companions` for a BrainVision recording, judged against the git
    tree: refuse only when the header's DataFile is untracked AND no same-stem
    `.eeg` or `.dat` is, which is the question biosigIO's own stale-header
    recovery (biosigio#132) answers before it gives up."""

    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.vhdr"
    HEAD = "0123456789abcdef" * 2 + "01234567"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.local = os.path.join(self._tmp.name, "sub-01_task-rest_eeg.vhdr")

    def check(self, tracked, data_file="sub-01_task-rest_eeg.eeg", *, header=True):
        if header:
            with open(self.local, "w", encoding="utf-8") as fh:
                fh.write(
                    "Brain Vision Data Exchange Header File Version 1.0\n"
                    f"[Common Infos]\nDataFile={data_file}\nMarkerFile=x.vmrk\n"
                )
        generate_zarr.require_companions(
            self.PRIMARY, self.local, {self.PRIMARY, *tracked}, self.HEAD, False
        )

    def test_a_header_whose_data_file_is_tracked_passes(self):
        self.check({"sub-01/eeg/sub-01_task-rest_eeg.eeg"})

    def test_an_untracked_data_file_is_refused_by_its_tree_path(self):
        with self.assertRaises(generate_zarr.CompanionMissing) as cm:
            self.check({"sub-01/eeg/sub-01_task-rest_eeg.vmrk"})
        exc = cm.exception
        self.assertEqual(exc.code, "companion_missing")
        # The BIDS-relative path of the missing file, never a scratch path, and
        # the commit it was judged against.
        self.assertIn("sub-01/eeg/sub-01_task-rest_eeg.eeg", str(exc))
        self.assertIn(self.HEAD[:8], str(exc))
        # Survives `failure_detail` as written: a relative path is not stripped.
        self.assertIn("sub-01/eeg/sub-01_task-rest_eeg.eeg", failure_detail(exc) or "")

    def test_a_stale_header_with_a_same_stem_sibling_passes(self):
        # BIDS renamed the .eeg on disk and not the name inside the header.
        self.check({"sub-01/eeg/sub-01_task-rest_eeg.eeg"}, data_file="old_name.eeg")
        self.check({"sub-01/eeg/sub-01_task-rest_eeg.dat"}, data_file="old_name.eeg")

    def test_the_sibling_extension_is_matched_without_regard_to_case(self):
        for ext in (".EEG", ".Eeg", ".DAT"):
            with self.subTest(ext):
                self.check({f"sub-01/eeg/sub-01_task-rest_eeg{ext}"}, data_file="old_name.eeg")

    def test_a_stale_header_with_no_sibling_is_refused(self):
        with self.assertRaises(generate_zarr.CompanionMissing) as cm:
            self.check({"sub-01/eeg/sub-01_task-rest_eeg.vmrk"}, data_file="old_name.eeg")
        self.assertIn("sub-01/eeg/old_name.eeg", str(cm.exception))

    def test_only_the_stem_of_this_recording_counts(self):
        for other in (
            "sub-01/eeg/sub-01_task-other_eeg.eeg",   # another recording's data
            "sub-02/eeg/sub-01_task-rest_eeg.eeg",    # the same name in another directory
            "sub-01/eeg/sub-01_task-rest_eeg.eeg.bak",  # not an extension we read
        ):
            with self.subTest(other), self.assertRaises(generate_zarr.CompanionMissing):
                self.check({other}, data_file="old_name.eeg")

    def test_a_data_file_tracked_under_another_name_is_not_this_rules_to_refuse(self):
        # The tree HAS the file the header names, so there is nothing missing to
        # report; whether the reader gets it is a different question.
        self.check({"sub-01/eeg/shared.eeg"}, data_file="shared.eeg")

    def test_a_header_in_a_subdirectory_reference_is_resolved_from_its_directory(self):
        self.check({"sub-01/eeg/data/run1.eeg"}, data_file="data/run1.eeg")
        with self.assertRaises(generate_zarr.CompanionMissing) as cm:
            self.check({"sub-01/eeg/run1.eeg"}, data_file="data/run1.eeg")
        self.assertIn("sub-01/eeg/data/run1.eeg", str(cm.exception))

    def test_nothing_is_refused_that_the_rule_cannot_read(self):
        # No such header, a header naming no data file: the reader decides.
        self.check(set(), header=False)
        self.check(set(), data_file="")

    def test_other_formats_are_untouched(self):
        for primary in (
            "sub-01/eeg/sub-01_task-rest_eeg.edf",
            "sub-01/eeg/sub-01_task-rest_eeg.bdf",
            "sub-01/meg/sub-01_task-rest_meg.fif",
            "sub-01/meg/sub-01_task-rest_meg.ds",
        ):
            with self.subTest(primary):
                generate_zarr.require_companions(
                    primary, "/no/such/file", {primary}, self.HEAD, False
                )


def write_fdt_backed_set(path: str, embedded: str = "orig_name.fdt", nbchan: int = 4) -> str:
    """A classic EEGLAB `.set` whose `EEG.data` is a file NAME (the samples live in
    a `.fdt`), written by the pure-Python `Mat5` writer so the fast tier can use
    it. No `.fdt` is written: the tests decide what the tree holds."""
    m = Mat5("<")
    fields = [
        ("setname", m.chars("", "fixture")),
        ("nbchan", m.scalar("", nbchan)),
        ("trials", m.scalar("", 1)),
        ("pnts", m.scalar("", 100)),
        ("srate", m.scalar("", 250.0)),
        ("data", m.chars("", embedded)),
    ]
    return m.file(path, [m.struct("EEG", [fields])])


def write_inline_set(path: str, nbchan: int = 2) -> str:
    """A classic EEGLAB `.set` that carries its samples inline (a numeric
    `EEG.data`), by the same writer."""
    import struct

    m = Mat5("<")
    pnts = 5
    count = nbchan * pnts
    samples = m.matrix("", 6, [nbchan, pnts], m.elem(9, struct.pack(f"<{count}d", *range(count))))
    fields = [
        ("setname", m.chars("", "fixture")),
        ("nbchan", m.scalar("", nbchan)),
        ("trials", m.scalar("", 1)),
        ("pnts", m.scalar("", pnts)),
        ("srate", m.scalar("", 250.0)),
        ("data", samples),
    ]
    return m.file(path, [m.struct("EEG", [fields])])


class TestRequireCompanionsSet(unittest.TestCase):
    """`require_companions` for an EEGLAB `.set` whose samples are in a `.fdt`:
    refused only when the header says so (`EEG.data` is a file name), the
    same-stem `.fdt` is untracked, no reviewed ADR 0073 declaration supplies one,
    and the name the header embeds is not a tracked file beside it either (the
    second place biosigIO's `_read_fdt` looks)."""

    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.set"
    SIBLING = "sub-01/eeg/sub-01_task-rest_eeg.fdt"
    HEAD = "89abcdef" * 5

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.local = os.path.join(self._tmp.name, "sub-01_task-rest_eeg.set")

    def check(self, tracked, *, declared=False):
        generate_zarr.require_companions(
            self.PRIMARY, self.local, {self.PRIMARY, *tracked}, self.HEAD, declared
        )

    def test_a_tracked_sibling_passes_without_reading_the_header(self):
        # No file at all: the tree already answers, so the header is not opened.
        self.check({self.SIBLING})

    def test_a_tracked_same_stem_fdt_passes_though_the_header_names_another(self):
        # The common BIDS-rename shape: the .fdt was renamed with the .set, and
        # the name inside the .set is the stale pre-rename one. The case above
        # cannot see the same-stem clause (no file, so the header is unreadable
        # and the rule returns anyway); this header IS readable, names a file
        # the tree lacks, and only the tracked <stem>.fdt satisfies the rule.
        write_fdt_backed_set(self.local, embedded="pre_rename.fdt")
        self.check({self.SIBLING})
        # The control: without that sibling the same header is refused.
        with self.assertRaises(generate_zarr.CompanionMissing):
            self.check(set())

    def test_an_untracked_fdt_is_refused_by_its_tree_path(self):
        write_fdt_backed_set(self.local, embedded="sub-01_task-rest_eeg.fdt")
        with self.assertRaises(generate_zarr.CompanionMissing) as cm:
            self.check(set())
        exc = cm.exception
        self.assertEqual(exc.code, "companion_missing")
        self.assertIn(self.SIBLING, str(exc))
        self.assertIn(self.HEAD[:8], str(exc))
        self.assertIn(self.SIBLING, failure_detail(exc) or "")

    def test_a_declared_fdt_is_not_this_rules_to_refuse(self):
        # ADR 0073: a reviewed declaration supplies the .fdt, and
        # `stage_declared_fdt` verifies it (and refuses, typed, if it is wrong).
        write_fdt_backed_set(self.local)
        self.check(set(), declared=True)

    def test_a_set_with_inline_samples_needs_no_fdt(self):
        write_inline_set(self.local)
        self.check(set())

    def test_an_unreadable_set_is_left_to_the_reader(self):
        for content in (b"", b"not a MAT file", b"MATLAB 5.0 MAT-file" + b"\0" * 20):
            with self.subTest(content=content[:12]):
                with open(self.local, "wb") as fh:
                    fh.write(content)
                self.check(set())
        os.remove(self.local)
        self.check(set())

    def test_a_tracked_sibling_of_another_recording_is_not_this_ones(self):
        write_fdt_backed_set(self.local, embedded="sub-01_task-rest_eeg.fdt")
        for other in ("sub-01/eeg/sub-01_task-other_eeg.fdt", "sub-02/eeg/sub-01_task-rest_eeg.fdt"):
            with self.subTest(other), self.assertRaises(generate_zarr.CompanionMissing):
                self.check({other})

    def test_the_name_the_header_embeds_is_a_companion_when_it_is_tracked_beside_the_set(self):
        # biosigIO reads <set stem>.fdt first and the embedded name second, so a
        # .set whose own stem has no .fdt but whose embedded name is tracked
        # beside it CONVERTS; refusing it would turn a served store into a failure.
        try:
            import scipy.io  # noqa: F401
        except ImportError:
            self.skipTest("scipy not installed (the fast tier); the full tier runs this")
        write_fdt_backed_set(self.local, embedded="orig_name.fdt")
        self.check({"sub-01/eeg/orig_name.fdt"})
        # Beside the .set, not anywhere else, and by the name the header gives.
        for tracked in ("sub-02/eeg/orig_name.fdt", "sub-01/eeg/other_name.fdt"):
            with self.subTest(tracked), self.assertRaises(generate_zarr.CompanionMissing):
                self.check({tracked})

    def test_a_v73_set_with_its_samples_in_a_fdt(self):
        for wrapped in (True, False):
            with self.subTest(wrapped=wrapped):
                try:
                    build_eeglab_set(self.local, 4, v73=True, fdt=True, wrapped=wrapped)
                except ImportError as exc:
                    self.skipTest(f"{exc.name} not installed (the fast tier); the full tier runs this")
                # build_eeglab_set wrote <stem>.fdt beside the .set on disk; the
                # TREE is what is judged, and it tracks nothing.
                with self.assertRaises(generate_zarr.CompanionMissing) as cm:
                    self.check(set())
                self.assertIn(self.SIBLING, str(cm.exception))
                self.check({self.SIBLING})

    def test_a_v73_sets_embedded_fdt_name_is_a_companion_when_tracked_beside_it(self):
        # The .set was saved as orig_name_eeg.set (so it embeds orig_name_eeg.fdt)
        # and renamed to the BIDS name; the .fdt kept its name.
        for wrapped in (True, False):
            with self.subTest(wrapped=wrapped):
                original = os.path.join(self._tmp.name, "orig_name_eeg.set")
                try:
                    build_eeglab_set(original, 4, v73=True, fdt=True, wrapped=wrapped)
                except ImportError as exc:
                    self.skipTest(f"{exc.name} not installed (the fast tier); the full tier runs this")
                os.replace(original, self.local)
                self.check({"sub-01/eeg/orig_name_eeg.fdt"})
                with self.assertRaises(generate_zarr.CompanionMissing):
                    self.check({"sub-01/eeg/other_name_eeg.fdt"})

    def test_an_epoched_v73_set_is_left_to_the_reader(self):
        # biosigIO's v7.3 reader refuses a file with more than one epoch
        # (`not_continuous`) before it asks for the .fdt, and that is the verdict
        # on record for the file; this rule would otherwise pre-empt it.
        for wrapped in (True, False):
            with self.subTest(wrapped=wrapped):
                try:
                    build_eeglab_set(self.local, 4, v73=True, fdt=True, wrapped=wrapped, trials=4)
                except ImportError as exc:
                    self.skipTest(f"{exc.name} not installed (the fast tier); the full tier runs this")
                self.check(set())
                # The control: the same file with ONE epoch is refused, so the
                # exemption is the epochs and nothing wider.
                build_eeglab_set(self.local, 4, v73=True, fdt=True, wrapped=wrapped, trials=1)
                with self.assertRaises(generate_zarr.CompanionMissing):
                    self.check(set())

    def test_a_classic_epoched_set_is_not_exempt(self):
        # A classic file with several epochs and a .fdt converts (the epochs are
        # flattened), so a missing .fdt is its problem like any other's.
        try:
            build_eeglab_set(self.local, 4, fdt=True, trials=4)
        except ImportError as exc:
            self.skipTest(f"{exc.name} not installed (the fast tier); the full tier runs this")
        with self.assertRaises(generate_zarr.CompanionMissing):
            self.check(set())

    def test_other_formats_are_untouched(self):
        generate_zarr.require_companions(
            "sub-01/eeg/sub-01_task-rest_eeg.edf", "/no/such/file", set(), self.HEAD, False
        )


class TestGitTreeNamesAreNotQuoted(unittest.TestCase):
    """Everything the converter judges by a recording's name (discovery, the
    incremental worklist, `require_companions`) is read from `git ls-tree` and
    `git diff`. Asked without `-z`, git wraps a name holding a byte above 0x7f in
    double quotes and escapes the bytes, so `Müller_01.eeg` is listed as
    `"M\\303\\274ller_01.eeg"`: a string no file has and no extension test matches.
    Over a REAL repository, with the quoting pinned on in its config so the
    result does not depend on the machine's global git settings."""

    HEADER = "sub-01/eeg/sub-01_task-rest_eeg.vhdr"
    DATA = "sub-01/eeg/Müller_01.eeg"
    NAMED_RECORDING = "sub-01/eeg/sub-01_task-Müller_eeg.edf"
    PLAIN_RECORDING = "sub-01/eeg/sub-01_task-rest_eeg.edf"
    ADDED = "sub-01/eeg/sub-01_task-Ärger_eeg.edf"
    HEAD = "0123456789abcdef" * 2 + "01234567"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = self._tmp.name
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.org")
        self.git("config", "user.name", "t")
        self.git("config", "core.quotePath", "true")
        os.makedirs(os.path.join(self.repo, "sub-01/eeg"))
        write_brainvision(
            os.path.join(self.repo, self.HEADER), ["Fz", "Cz"], rate=10, seconds=1
        )
        os.replace(
            os.path.join(self.repo, "sub-01/eeg/sub-01_task-rest_eeg.eeg"),
            os.path.join(self.repo, self.DATA),
        )
        with open(os.path.join(self.repo, self.HEADER), encoding="utf-8") as fh:
            header = fh.read().replace(
                "DataFile=sub-01_task-rest_eeg.eeg", "DataFile=Müller_01.eeg"
            )
        with open(os.path.join(self.repo, self.HEADER), "w", encoding="utf-8") as fh:
            fh.write(header)
        for name in (self.NAMED_RECORDING, self.PLAIN_RECORDING):
            with open(os.path.join(self.repo, name), "wb") as fh:
                fh.write(b"x")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "one")
        self.first = self.git("rev-parse", "HEAD").strip()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", self.repo, *args], check=True, capture_output=True, text=True
        ).stdout

    def tree(self) -> set[str]:
        return set(generate_zarr.git_ls_files(self.repo, "HEAD"))

    def test_the_listing_holds_the_real_names(self):
        tree = self.tree()
        for name in (self.DATA, self.NAMED_RECORDING, self.PLAIN_RECORDING, self.HEADER):
            with self.subTest(name):
                self.assertIn(name, tree)
        self.assertFalse([n for n in tree if n.startswith('"') or "\\" in n], tree)
        # The control: git does quote them when asked the way the converter used to.
        quoted = self.git("ls-tree", "-r", "--name-only", "HEAD")
        self.assertIn('"sub-01/eeg/M\\303\\274ller_01.eeg"', quoted)

    def test_discovery_finds_a_recording_with_a_non_ascii_name(self):
        found = generate_zarr.discover_primaries(sorted(self.tree()))
        self.assertIn(self.NAMED_RECORDING, found)
        self.assertIn(self.PLAIN_RECORDING, found)

    def test_the_incremental_worklist_sees_a_non_ascii_name_added_or_removed(self):
        with open(os.path.join(self.repo, self.ADDED), "wb") as fh:
            fh.write(b"x")
        self.git("rm", "-q", self.NAMED_RECORDING)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "two")
        diff = generate_zarr.git_diff_name_status(self.repo, self.first, "HEAD")
        self.assertEqual(sorted(diff), sorted([("A", self.ADDED), ("D", self.NAMED_RECORDING)]))
        convert, remove = generate_zarr.compute_worklist(sorted(self.tree()), diff, False)
        self.assertEqual(convert, [self.ADDED])
        self.assertEqual(remove, [store_rel_for(self.NAMED_RECORDING)])

    def test_a_header_naming_a_tracked_non_ascii_data_file_is_not_refused(self):
        # Not the recording's own stem, so only the name the header gives can
        # satisfy the rule. It converted before the rule existed.
        generate_zarr.require_companions(
            self.HEADER, os.path.join(self.repo, self.HEADER), self.tree(), self.HEAD, False
        )

    def test_a_non_ascii_data_file_the_tree_lacks_is_refused_by_its_real_name(self):
        self.git("rm", "-q", self.DATA)
        self.git("commit", "-q", "-m", "drop the data file")
        with self.assertRaises(generate_zarr.CompanionMissing) as cm:
            generate_zarr.require_companions(
                self.HEADER, os.path.join(self.repo, self.HEADER), self.tree(), self.HEAD, False
            )
        self.assertIn(self.DATA, str(cm.exception))

    def test_an_eeglab_fdt_with_a_non_ascii_name_beside_the_set_is_a_companion(self):
        # The `.set` embeds a non-ASCII `.fdt` name and the `.fdt` sits beside it
        # under that name, with no same-stem `.fdt`. (Skips without scipy, like
        # the writer: the fast tier runs the cases above.)
        primary = "sub-01/eeg/sub-01_task-x_eeg.set"
        write_eeglab_set(
            os.path.join(self.repo, primary),
            os.path.join(self.repo, "sub-01/eeg/Müller_01.fdt"),
            embedded="Müller_01.fdt",
        )
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "a set and its fdt")
        generate_zarr.require_companions(
            primary, os.path.join(self.repo, primary), self.tree(), self.HEAD, False
        )


class TestGitListingsAreByteExact(unittest.TestCase):
    """`git_ls_files`, `git_diff_name_status` and `compute_worklist` over a REAL
    repository whose tree holds names a text pipeline mangles: a space, a tab, a
    newline, a quote, a backslash, leading and trailing whitespace, a byte
    sequence that is not UTF-8, and a valid non-ASCII name.

    What the listings promise is the bytes of every name, once each, and nothing
    else: `-z` output ends in a NUL, and splitting on it leaves an empty last
    field that is not a file. These tests fail if that empty field is kept, if a
    name is stripped, split on whitespace or decoded lossily, if `-z` goes, or if
    `--no-renames` goes (a rename then carries two paths and the pairs shift).

    The tree is written with git's plumbing, never through a working tree: a file
    system may refuse some of these names (APFS refuses a byte sequence that is
    not UTF-8), and git does not care."""

    DIR = b"sub-01/eeg/"
    # Name tails; each ends `_eeg.edf` (a recording) unless the test says otherwise.
    SPACE = b"sub-01_task-with space_eeg.edf"
    TAB = b"sub-01_task-tab\there_eeg.edf"
    NEWLINE = b"sub-01_task-new\nline_eeg.edf"
    QUOTE = b'sub-01_task-say "hi"_eeg.edf'
    BACKSLASH = b"sub-01_task-back\\slash_eeg.edf"
    NOT_UTF8 = b"sub-01_task-\xff\xfe_eeg.edf"
    RENAMED_NOT_UTF8 = b"sub-01_task-\xfe\xff_eeg.edf"
    NON_ASCII = "sub-01_task-M\u00fcller_eeg.edf".encode()
    EDGES = b" edges \n"  # not a recording: leading and trailing whitespace, a newline
    ADDED = b"sub-01_task-added\ttab_eeg.edf"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = self._tmp.name
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.org")
        self.git("config", "user.name", "t")
        self.git("config", "core.quotePath", "true")
        self.git("config", "diff.renames", "true")  # the default `git diff` would detect them
        self.first = self.commit(
            [(self.DIR + name, b"100644", name) for name in (
                self.SPACE, self.TAB, self.NEWLINE, self.QUOTE, self.BACKSLASH,
                self.NOT_UTF8, self.NON_ASCII, self.EDGES,
            )]
        )

    def git(self, *args: str, stdin: bytes | None = None) -> bytes:
        return subprocess.run(
            ["git", "-C", self.repo, *args], check=True, capture_output=True, input=stdin
        ).stdout

    def commit(self, entries: list[tuple[bytes, bytes, bytes | None]]) -> str:
        """Apply `(path, mode, content)` entries to the index and commit it on
        `main`; `content` None removes the path."""
        info = b""
        for path, mode, content in entries:
            if content is None:
                info += b"0 " + b"0" * 40 + b"\t" + path + b"\0"
            else:
                blob = self.git("hash-object", "-w", "--stdin", stdin=content).strip()
                info += mode + b" " + blob + b"\t" + path + b"\0"
        self.git("update-index", "-z", "--index-info", stdin=info)
        tree = self.git("write-tree").decode().strip()
        parents = []
        head = subprocess.run(
            ["git", "-C", self.repo, "rev-parse", "-q", "--verify", "HEAD"],
            capture_output=True, text=True, check=False,
        )
        if head.returncode == 0:
            parents = ["-p", head.stdout.strip()]
        commit = self.git("commit-tree", *parents, "-m", "x", tree).decode().strip()
        self.git("update-ref", "HEAD", commit)
        return commit

    def paths(self, *tails: bytes) -> set[bytes]:
        return {self.DIR + tail for tail in tails}

    @staticmethod
    def as_bytes(listing) -> list[bytes]:
        return [os.fsencode(name) for name in listing]

    def test_the_tree_listing_is_every_name_once_byte_for_byte(self):
        listing = generate_zarr.git_ls_files(self.repo, "HEAD")
        # The control: this really is the tree, so equality is not vacuous.
        self.assertEqual(len(listing), 8)
        self.assertNotIn("", listing, "the field after the last NUL is not a file")
        self.assertEqual(
            sorted(self.as_bytes(listing)),
            sorted(self.paths(
                self.SPACE, self.TAB, self.NEWLINE, self.QUOTE, self.BACKSLASH,
                self.NOT_UTF8, self.NON_ASCII, self.EDGES,
            )),
        )
        # The listing stays a path the file system can be asked for.
        self.assertIn(os.fsdecode(self.DIR + self.NOT_UTF8), listing)

    def test_discovery_finds_every_recording_among_those_names(self):
        found = generate_zarr.discover_primaries(sorted(generate_zarr.git_ls_files(self.repo, "HEAD")))
        self.assertEqual(
            sorted(self.as_bytes(found)),
            sorted(self.paths(
                self.SPACE, self.TAB, self.NEWLINE, self.QUOTE, self.BACKSLASH,
                self.NOT_UTF8, self.NON_ASCII,
            )),
        )

    def second_commit(self) -> None:
        """One of each status git reports with renames off, plus a rename."""
        self.commit([
            (self.DIR + self.ADDED, b"100644", b"added"),            # A
            (self.DIR + self.NEWLINE, b"100644", None),               # D
            (self.DIR + self.SPACE, b"100644", b"changed"),           # M
            (self.DIR + self.QUOTE, b"120000", b"elsewhere"),         # T: file to symlink
            (self.DIR + self.NOT_UTF8, b"100644", None),              # a rename ...
            # ... with the content `setUp` gave the old name (its own name), so git
            # sees a rename when asked to look for one
            (self.DIR + self.RENAMED_NOT_UTF8, b"100644", self.NOT_UTF8),
        ])

    def test_the_diff_keeps_every_status_and_every_name(self):
        self.second_commit()
        diff = generate_zarr.git_diff_name_status(self.repo, self.first, "HEAD")
        self.assertEqual(
            sorted((status, os.fsencode(path)) for status, path in diff),
            sorted([
                ("A", self.DIR + self.ADDED),
                ("D", self.DIR + self.NEWLINE),
                ("M", self.DIR + self.SPACE),
                ("T", self.DIR + self.QUOTE),
                # `--no-renames`: a rename is a deletion and an addition, each with
                # one path, not an `R100` entry carrying two.
                ("D", self.DIR + self.NOT_UTF8),
                ("A", self.DIR + self.RENAMED_NOT_UTF8),
            ]),
        )

    def test_the_control_for_no_renames_git_would_detect_the_rename(self):
        self.second_commit()
        raw = self.git("diff", "--name-status", "-z", f"{self.first}..HEAD")
        self.assertTrue(
            any(field.startswith(b"R") for field in raw.split(b"\0")),
            "without --no-renames git reports the rename as one entry with two paths",
        )

    def test_deleted_names_reach_remove_and_changed_ones_reach_convert(self):
        self.second_commit()
        tree = generate_zarr.git_ls_files(self.repo, "HEAD")
        diff = generate_zarr.git_diff_name_status(self.repo, self.first, "HEAD")
        convert, remove = generate_zarr.compute_worklist(sorted(tree), diff, False)
        self.assertEqual(
            sorted(self.as_bytes(convert)),
            sorted(self.paths(self.ADDED, self.SPACE, self.QUOTE, self.RENAMED_NOT_UTF8)),
        )
        self.assertEqual(
            sorted(self.as_bytes(remove)),
            sorted(
                os.fsencode(store_rel_for(os.fsdecode(self.DIR + tail)))
                for tail in (self.NEWLINE, self.NOT_UTF8)
            ),
        )


class TestNameStatusPairs(unittest.TestCase):
    """`git diff --name-status -z` is `<status> NUL <path> NUL` per entry. Pairing
    is by position, so a field list that does not pair up is an error: zipping it
    would drop the tail silently and an incremental run would skip a change."""

    def test_pairs_status_with_path_and_keeps_the_status_letter(self):
        self.assertEqual(
            generate_zarr._name_status_pairs(["A", "a.edf", "D", "b c.edf", "T", "d.edf"]),
            [("A", "a.edf"), ("D", "b c.edf"), ("T", "d.edf")],
        )
        self.assertEqual(generate_zarr._name_status_pairs([]), [])

    def test_an_odd_number_of_fields_is_an_error_not_a_shorter_list(self):
        for fields in (["A"], ["A", "a.edf", "D"], ["R100", "old.edf", "new.edf"]):
            with self.subTest(fields), self.assertRaises(RuntimeError) as cm:
                generate_zarr._name_status_pairs(fields)
            self.assertIn(str(len(fields)), str(cm.exception))


class ConvertOneLocalCase(unittest.TestCase):
    """Shared harness for the full-tier cases below: `convert_one` in LOCAL mode
    (the Hallu path) over real files in a throwaway repository, up to the upload,
    which a no-op `aws` absorbs. Nothing else is substituted. Subclasses say which
    libraries they need through `REQUIRES`."""

    REQUIRES: ClassVar[tuple[str, ...]] = ("zarr",)

    @classmethod
    def setUpClass(cls):
        for name in cls.REQUIRES:
            try:
                __import__(name)
            except Exception as exc:  # noqa: BLE001
                raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        os.makedirs(self.repo)
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)
        saved_ctx = dict(generate_zarr._CTX)
        self.addCleanup(lambda: (generate_zarr._CTX.clear(), generate_zarr._CTX.update(saved_ctx)))

    def convert(self, primary: str, head_files, **ctx) -> dict:
        work = os.path.join(self._tmp.name, "work")
        os.makedirs(work, exist_ok=True)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "nm099999",
            "head": "d" * 40, "head_files": set(head_files), "local": True,
            "tmp": work, "updated": "2026-10-15T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": ZARR_ENGINE_VERSION,
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
            **ctx,
        })
        with contextlib.redirect_stdout(io.StringIO()):
            return convert_one(primary)

    def assert_refused_as_data(self, result: dict, code: str) -> None:
        """A typed data failure: not ok, the expected code, never retried, and
        counted as a property of the data rather than of the node."""
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], code, result.get("error"))
        self.assertNotIn(code, RETRYABLE_CODES)
        entry = _failure_entry(result["primary"], result["code"], result["detail"])
        self.assertEqual(count_infra_failures([result["primary"]], [entry]), 0)
        self.assertTrue(generate_zarr.dataset_failure_is_deterministic([result["primary"]], [entry]))


class TestCompanionMissingThroughConvertOne(ConvertOneLocalCase):
    """A recording whose companion data the tree does not hold, through the real
    `convert_one` and the real readers (MNE for BrainVision, scipy and biosigIO
    for EEGLAB): a typed `companion_missing` that names the file, where it was an
    opaque `file_read_error`; and the controls that prove the rule does not
    refuse what converts."""

    REQUIRES = ("zarr", "scipy.io", "mne", "biosigio")

    SET = "sub-01/eeg/sub-01_task-x_eeg.set"
    SET_FDT = "sub-01/eeg/sub-01_task-x_eeg.fdt"
    VHDR = "sub-01/eeg/sub-01_task-rest_eeg.vhdr"
    VMRK = "sub-01/eeg/sub-01_task-rest_eeg.vmrk"
    EEG = "sub-01/eeg/sub-01_task-rest_eeg.eeg"

    def write_set(self, fdt_rel: str | None, *, embedded: str = "orig_name.fdt") -> None:
        write_eeglab_set(
            os.path.join(self.repo, self.SET),
            None if fdt_rel is None else os.path.join(self.repo, fdt_rel),
            embedded=embedded,
        )

    def assert_converted(self, result: dict) -> None:
        self.assertTrue(result["ok"], result.get("error"))
        (group,) = result["entry"]["groups"]
        self.assertEqual((group["n_channels"], group["n_samples"]), (4, 1000))

    def test_an_eeglab_set_without_its_fdt_is_companion_missing(self):
        self.write_set(self.SET_FDT, embedded="sub-01_task-x_eeg.fdt")
        os.remove(os.path.join(self.repo, self.SET_FDT))  # the data is not in the dataset
        result = self.convert(self.SET, {self.SET})
        self.assert_refused_as_data(result, "companion_missing")
        # Names the file the tree lacks, by its BIDS path, in the published detail.
        self.assertIn(self.SET_FDT, result["error"])
        self.assertIn(self.SET_FDT, result["detail"])
        self.assertNotIn(self.repo, result["detail"])

    def test_biosigio_refuses_the_same_file_so_the_rule_pre_empts_nothing(self):
        # Without this the rule could be refusing a file the reader would have
        # converted. The reader, handed the same bytes, fails: it reports the
        # missing .fdt as a generic read error.
        from biosigio import Recording
        from biosigio.exceptions import FileReadError

        self.write_set(self.SET_FDT, embedded="sub-01_task-x_eeg.fdt")
        os.remove(os.path.join(self.repo, self.SET_FDT))
        with self.assertRaises(FileReadError) as cm:
            Recording.from_file(os.path.join(self.repo, self.SET))
        self.assertIn("none was found", str(cm.exception))
        self.assertEqual(cm.exception.code, "file_read_error")

    def test_the_same_set_converts_once_its_fdt_is_in_the_tree(self):
        self.write_set(self.SET_FDT, embedded="sub-01_task-x_eeg.fdt")
        self.assert_converted(self.convert(self.SET, {self.SET, self.SET_FDT}))

    def test_a_set_whose_embedded_fdt_name_is_tracked_beside_it_still_converts(self):
        # The .set names orig_name.fdt, which sits beside it and is tracked; there
        # is no <stem>.fdt. biosigIO reads the embedded name second, so this
        # converts today and must keep converting.
        fdt = "sub-01/eeg/orig_name.fdt"
        self.write_set(fdt, embedded="orig_name.fdt")
        self.assert_converted(self.convert(self.SET, {self.SET, fdt}))

    def test_a_stale_embedded_fdt_name_with_a_tracked_same_stem_fdt_converts(self):
        # BIDS renamed the .fdt with the .set and not the name inside it. biosigIO
        # reads <set stem>.fdt first, so this converts on the base branch (the
        # case this rule must not turn into a failure); the embedded name is
        # untracked, so only the same-stem clause lets it through.
        self.write_set(self.SET_FDT, embedded="pre_rename.fdt")
        self.assert_converted(self.convert(self.SET, {self.SET, self.SET_FDT}))

    def build_v73(self, trials: int) -> None:
        os.makedirs(os.path.join(self.repo, os.path.dirname(self.SET)), exist_ok=True)
        try:
            build_eeglab_set(
                os.path.join(self.repo, self.SET), 3, trials=trials, fdt=True, v73=True
            )
        except ImportError as exc:
            self.skipTest(f"{exc.name} not installed")

    def test_an_epoched_v73_set_without_its_fdt_keeps_the_epoched_verdict(self):
        # biosigIO's v7.3 reader refuses an epoched file before it asks for the
        # .fdt, so the verdict on record for this file is `not_continuous`. The
        # absent .fdt is also true; it is not the better description, and the
        # recording stays as typed as it was.
        self.build_v73(trials=4)
        os.remove(os.path.join(self.repo, self.SET_FDT))
        result = self.convert(self.SET, {self.SET})
        self.assert_refused_as_data(result, "not_continuous")
        self.assertIn("4 epochs", result["detail"])

    def test_an_epoched_v73_set_with_its_fdt_is_not_continuous_too(self):
        self.build_v73(trials=4)
        self.assert_refused_as_data(self.convert(self.SET, {self.SET, self.SET_FDT}), "not_continuous")

    def test_a_continuous_v73_set_without_its_fdt_is_companion_missing(self):
        # The control for the two above: the exemption is the epochs.
        self.build_v73(trials=1)
        os.remove(os.path.join(self.repo, self.SET_FDT))
        self.assert_refused_as_data(self.convert(self.SET, {self.SET}), "companion_missing")

    def test_a_brainvision_header_without_its_data_file_is_companion_missing(self):
        write_brainvision(self.vhdr_path(), ["Fz", "Cz", "Pz", "Oz"])
        os.remove(os.path.join(self.repo, self.EEG))
        result = self.convert(self.VHDR, {self.VHDR, self.VMRK})
        self.assert_refused_as_data(result, "companion_missing")
        self.assertIn(self.EEG, result["error"])
        self.assertIn(self.EEG, result["detail"])

    def test_the_same_brainvision_recording_converts_with_its_data_file(self):
        write_brainvision(self.vhdr_path(), ["Fz", "Cz", "Pz", "Oz"])
        result = self.convert(self.VHDR, {self.VHDR, self.VMRK, self.EEG})
        self.assertTrue(result["ok"], result.get("error"))

    def test_a_stale_brainvision_header_with_a_same_stem_data_file_converts(self):
        # BIDS renamed the .eeg and not the name in the header (biosigio#132).
        # Measured: this converts, so it must not become companion_missing.
        write_brainvision(self.vhdr_path(), ["Fz", "Cz", "Pz", "Oz"])
        header = os.path.join(self.repo, self.VHDR)
        with open(header, encoding="utf-8") as fh:
            text = fh.read()
        stem = "sub-01_task-rest_eeg"
        with open(header, "w", encoding="utf-8") as fh:
            fh.write(text.replace(f"DataFile={stem}.eeg", "DataFile=pre_rename.eeg"))
        result = self.convert(self.VHDR, {self.VHDR, self.VMRK, self.EEG})
        self.assertTrue(result["ok"], result.get("error"))

    def vhdr_path(self) -> str:
        path = os.path.join(self.repo, self.VHDR)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path


class Refusal(Exception):
    """A stand-in for a reader's refusal, carrying a `.code` the way biosigIO's
    typed errors do. For the pure `failure_verdict` tests only: every other test
    here reaches a refusal by giving a real reader a real file."""

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


def chained(outer: BaseException, inner: BaseException) -> BaseException:
    """`outer` raised `from` `inner`, without raising either."""
    outer.__cause__ = inner
    return outer


EDF_REFUSAL = "the file is not EDF(+) or BDF(+) compliant"
MNE_SPLIT_REFUSAL = (
    "Split raw file detected but next file {path} does not exist. Ensure all files "
    "were transferred properly and that split and original files were not manually "
    "renamed on disk (split files should be recursively loaded)."
)


class TestFailureVerdict(unittest.TestCase):
    """`failure_verdict(exc, primary, head_files) -> (code, detail)`: the one place
    a reader's refusal becomes a code. Pure. The exceptions here are constructed
    to prove refusals: a host condition is not one, nor is a typed failure of
    another kind, nor is the same words from a different exception."""

    SPLIT_HEAD = "sub-01/meg/sub-01_task-rest_split-01_meg.fif"
    SPLIT_NEXT = "sub-01/meg/sub-01_task-rest_split-02_meg.fif"
    SET = "sub-01/eeg/sub-01_task-x_eeg.set"

    def verdict(self, exc, primary="sub-01/eeg/sub-01_task-x_eeg.edf", tracked=()):
        return generate_zarr.failure_verdict(exc, primary, set(tracked) | {primary})

    def probe_failure(self, path="/scratch/work/sub-01_task-rest_split-02_meg.fif"):
        """MNE's split refusal as `is_maxshield_fif` surfaces it."""
        return chained(
            MaxShieldProbeFailed(
                "could not read the FIF header to test for Internal Active Shielding: "
                "ValueError: " + MNE_SPLIT_REFUSAL.format(path=path)
            ),
            ValueError(MNE_SPLIT_REFUSAL.format(path=path)),
        )

    # -- a bare OSError is the host's, whatever its words --------------------
    #
    # The former bare-OSError text match typed pyedflib's streaming refusal and
    # biosigIO's tolerant fallback's truncation errors by their words. biosigIO
    # 1.2.12 types both itself (`CorruptFileError`), so nothing reads an
    # `OSError`'s words now.

    def test_a_bare_oserror_is_not_typed_by_its_text(self):
        # The words biosigIO's streaming source used to leave in a bare,
        # errno-less OSError: pyedflib's refusal, and the tolerant fallback's
        # truncation errors with the scratch path in front.
        for message in (
            f"/scratch/work/x.bdf: {EDF_REFUSAL} (Filesize)",
            "/scratch/work/x.edf: EDF/BDF header is truncated (<256 bytes)",
            "/scratch/work/x.edf: invalid number of signals in header (-1)",
            "/scratch/work/x.edf: signal header is truncated",
            (
                "/scratch/work/x.edf: file is truncated (expected at least 3080 bytes "
                "for 4 data record(s), found 1850)"
            ),
        ):
            with self.subTest(message):
                self.assertEqual(self.verdict(OSError(message)), (None, None))

    def test_a_host_condition_is_not_a_refusal(self):
        # An OSError that carries an errno is the HOST saying no (a failing
        # disk, a permission, a full volume), and it keeps its retry, also when
        # its words are a reader's refusal.
        for exc in (
            OSError(errno.EIO, f"x.bdf: {EDF_REFUSAL} (Filesize)"),
            OSError(errno.ENOSPC, f"x.bdf: {EDF_REFUSAL} (Filesize)"),
            PermissionError(errno.EACCES, f"x.bdf: {EDF_REFUSAL} (Filesize)"),
            FileNotFoundError(errno.ENOENT, f"x.bdf: {EDF_REFUSAL} (Filesize)"),
        ):
            with self.subTest(type(exc).__name__, errno=exc.errno):
                self.assertEqual(self.verdict(exc), (None, None))

    def test_the_same_words_from_another_exception_are_not_a_refusal(self):
        for exc in (
            RuntimeError(f"x.bdf: {EDF_REFUSAL} (Filesize)"),
            ValueError(f"x.bdf: {EDF_REFUSAL} (Filesize)"),
            Refusal(f"x.bdf: {EDF_REFUSAL} (Filesize)"),
            # Subclasses of OSError built without an errno.
            PermissionError(f"x.bdf: {EDF_REFUSAL} (Filesize)"),
            FileNotFoundError(f"x.bdf: {EDF_REFUSAL} (Filesize)"),
        ):
            with self.subTest(type(exc).__name__):
                self.assertEqual(self.verdict(exc), (None, None))

    def test_an_oserror_with_other_words_is_still_uncoded(self):
        self.assertEqual(self.verdict(OSError("download failed after 4 attempts")), (None, None))

    @staticmethod
    def raised_while_handling(refusal: BaseException, make_next: Callable[[], BaseException]):
        """The exception `make_next` builds, RAISED inside the `except` block that
        caught `refusal`: Python links the refusal as its `__context__`, which is
        how biosigIO's tolerant EDF read ends up holding a host error beside
        pyedflib's refusal. Raised, not assembled by hand, so the link is the
        interpreter's own."""
        try:
            try:
                raise refusal
            except Exception:  # noqa: BLE001 - any refusal, not only an OSError
                raise make_next()
        except Exception as raised:  # noqa: BLE001 - the exception is the product
            return raised
        raise AssertionError("make_next() was not raised")

    def test_a_host_error_raised_while_recovering_from_a_refusal_keeps_its_retry(self):
        # biosigIO recovers three kinds of header pyedflib refuses by reading the
        # file again INSIDE the `except` block that caught the refusal. A host
        # error raised by that second read (a failing disk, a full volume, a
        # permission) therefore carries the refusal as its `__context__`. It is
        # the host saying no, and keeps its retry: the refusal behind it is not
        # what this exception is.
        for label, make in (
            ("EIO", lambda: OSError(errno.EIO, "Input/output error")),
            ("ENOSPC", lambda: OSError(errno.ENOSPC, "No space left on device")),
            ("EACCES", lambda: PermissionError(errno.EACCES, "Permission denied")),
            ("no errno, other words", lambda: OSError("fallback read failed")),
        ):
            with self.subTest(label):
                exc = self.raised_while_handling(
                    OSError(f"x.bdf: {EDF_REFUSAL} (Filesize)"), make
                )
                # The control: the refusal really is the context, so a verdict
                # of (None, None) is the rule declining to read it.
                self.assertIn(EDF_REFUSAL, str(exc.__context__))
                self.assertEqual(self.verdict(exc), (None, None))

    def test_a_refusal_behind_another_exception_is_not_the_refusal(self):
        # A refusal text behind the exception is not a verdict: no rule reads an
        # `OSError`'s words, at the top or down a chain.
        refusal = OSError(f"x.bdf: {EDF_REFUSAL} (Filesize)")
        host = OSError(errno.EIO, "Input/output error")
        host.__cause__ = refusal
        self.assertEqual(self.verdict(host), (None, None))
        for depth in range(1, 6):
            with self.subTest(depth=depth):
                self.assertEqual(self.verdict(self.wrapper_chain(refusal, depth)), (None, None))

    # -- a code that is not generic passes through -------------------------

    def test_a_specific_code_is_never_refined(self):
        edf = OSError(f"x.bdf: {EDF_REFUSAL} (Filesize)")
        split = ValueError(MNE_SPLIT_REFUSAL.format(path="/w/sub-01_task-rest_split-02_meg.fif"))
        for exc, code in (
            (chained(RecordingMemoryExceeded("out of memory"), edf), "recording_memory_exceeded"),
            (chained(generate_zarr.AnnexObjectMissing("KEY", "chunk C2 is absent"), split),
             "annex_object_missing"),
            (chained(MaxShieldUncalibrated("no pair"), split), "maxshield_uncalibrated"),
            (chained(generate_zarr.CompanionMissing("no fdt"), split), "companion_missing"),
            (chained(Refusal("x", "channel_count_mismatch"), edf), "channel_count_mismatch"),
            (chained(Refusal("x", "not_continuous"), edf), "not_continuous"),
        ):
            with self.subTest(code):
                self.assertEqual(
                    self.verdict(exc, primary=self.SPLIT_HEAD, tracked=()), (code, None)
                )

    def test_only_the_generic_codes_are_refined(self):
        # The four a reader (or the probe) reports without saying why.
        split = ValueError(MNE_SPLIT_REFUSAL.format(path="/w/sub-01_task-rest_split-02_meg.fif"))
        for code in (None, "file_read_error", "corrupt_or_truncated", "maxshield_probe_failed"):
            with self.subTest(code):
                self.assertEqual(
                    self.verdict(chained(Refusal("read failed", code), split), self.SPLIT_HEAD)[0],
                    "split_part_missing",
                )

    # -- rule 1: a split chain missing its next part -----------------------

    def test_a_missing_split_part_is_named_by_its_tree_path(self):
        code, detail = self.verdict(self.probe_failure(), self.SPLIT_HEAD)
        self.assertEqual(code, "split_part_missing")
        self.assertIn(self.SPLIT_NEXT, detail or "")
        # The scratch directory MNE quoted is nowhere in what is published.
        self.assertNotIn("/scratch", detail or "")
        self.assertIn(self.SPLIT_NEXT, failure_detail(detail) or "")

    def test_the_split_message_alone_is_enough(self):
        # biosigIO's typed error carries MNE's sentence in its own message.
        exc = Refusal(
            "Truncated, incomplete, or corrupt file (/w/x.fif): "
            + MNE_SPLIT_REFUSAL.format(path="/w/sub-01_task-rest_split-02_meg.fif"),
            "corrupt_or_truncated",
        )
        self.assertEqual(self.verdict(exc, self.SPLIT_HEAD)[0], "split_part_missing")

    def test_a_tracked_next_part_is_not_relabeled(self):
        # The tree HAS the part: the file is missing from the working tree or was
        # not fetched, which is a fetch gap, not a property of the dataset.
        for code_source in (self.probe_failure(),
                            Refusal("corrupt", "corrupt_or_truncated"),
                            Refusal("unreadable", "file_read_error")):
            exc = chained(code_source, ValueError(
                MNE_SPLIT_REFUSAL.format(path="/w/sub-01_task-rest_split-02_meg.fif")))
            with self.subTest(exc.code):
                self.assertEqual(
                    self.verdict(exc, self.SPLIT_HEAD, tracked={self.SPLIT_NEXT}),
                    (exc.code, None),
                )

    def test_the_part_is_judged_in_the_primarys_directory_by_basename(self):
        # MNE quotes wherever the file was materialized; the tree path is the
        # primary's directory plus that file's name.
        elsewhere = "sub-01/meg/other/sub-01_task-rest_split-02_meg.fif"
        _, detail = self.verdict(self.probe_failure("/deep/ly/nested/" + os.path.basename(self.SPLIT_NEXT)),
                                 self.SPLIT_HEAD, tracked={elsewhere})
        self.assertIn(self.SPLIT_NEXT, detail or "")

    # -- rule 2: epoched EEGLAB ---------------------------------------------

    def test_a_three_dimensional_set_is_an_epoched_recording(self):
        exc = Refusal(
            "Could not read recording (/w/x.set): Must pass 2-d input. shape=(4, 500, 3)",
            "file_read_error",
        )
        self.assertEqual(self.verdict(exc, self.SET), ("epoched_recording", None))
        self.assertEqual(self.verdict(exc, self.SET.replace(".set", ".SET"))[0], "epoched_recording")
        # Through a cause, too.
        wrapped = chained(Refusal("Could not read recording", "file_read_error"),
                          ValueError("Must pass 2-d input. shape=(4, 500, 3)"))
        self.assertEqual(self.verdict(wrapped, self.SET)[0], "epoched_recording")

    def test_the_epoched_rule_is_for_eeglab_sets_only(self):
        exc = Refusal("Could not read recording: Must pass 2-d input. shape=(4, 500, 3)", "file_read_error")
        for primary in ("sub-01/eeg/x_eeg.edf", "sub-01/eeg/x_eeg.vhdr", "sub-01/meg/x_meg.fif"):
            with self.subTest(primary):
                self.assertEqual(self.verdict(exc, primary), ("file_read_error", None))

    # -- rule 3: a .fdt whose size disagrees with the header ---------------

    def test_a_fdt_that_disagrees_with_its_header_is_corrupt_or_truncated(self):
        message = (
            "/w/x.fdt holds 3999 float32 samples but the .set header implies 4000 "
            "(nbchan 4 x pnts 1000 x trials 1)"
        )
        exc = Refusal(f"Could not read recording (/w/x.set): {message}", "file_read_error")
        self.assertEqual(self.verdict(exc, self.SET), ("corrupt_or_truncated", None))
        self.assertEqual(
            self.verdict(chained(Refusal("unreadable", "file_read_error"), ValueError(message)),
                         self.SET),
            ("corrupt_or_truncated", None),
        )

    # -- the walk ------------------------------------------------------------

    def wrapper_chain(self, leaf: BaseException, depth: int) -> BaseException:
        """An uncoded exception whose `__cause__` chain reaches `leaf` after
        `depth` links."""
        links = [RuntimeError(f"wrapper {i}") for i in range(depth)]
        for outer, inner in zip(links, [*links[1:], leaf]):
            outer.__cause__ = inner
        return links[0] if links else leaf

    FDT_MISMATCH = (
        "/w/x.fdt holds 3999 float32 samples but the .set header implies 4000 "
        "(nbchan 4 x pnts 1000 x trials 1)"
    )

    def test_the_walk_follows_exactly_exc_plus_five_links(self):
        # exc is link 0; the leaf is link `depth`. Five links is the last one
        # read, by the rules that read the chain (1 to 3).
        leaf = ValueError(self.FDT_MISMATCH)
        self.assertEqual(
            self.verdict(self.wrapper_chain(leaf, 5), self.SET), ("corrupt_or_truncated", None)
        )
        self.assertEqual(self.verdict(self.wrapper_chain(leaf, 6), self.SET), (None, None))
        # The walk reads only what the rules above look for: the same chain
        # around the EDF refusal, at any depth, is not a verdict.
        refusal = OSError(f"x.bdf: {EDF_REFUSAL} (Filesize)")
        for depth in range(1, 6):
            with self.subTest(refusal_at=depth):
                self.assertEqual(self.verdict(self.wrapper_chain(refusal, depth)), (None, None))

    def test_the_walk_does_not_follow_the_implicit_context(self):
        # The cause contract: a reader that types a failure raises `... from` the
        # reader's own error (biosigIO's `classify_read_error(...) from e`, the
        # probe's `MaxShieldProbeFailed ... from exc`), and that explicit link is
        # the only one read. `__context__` is whatever was being handled when
        # something else was raised, which is the HOST's error as often as the
        # file's, so it is not a statement of cause.
        try:
            try:
                raise ValueError(self.FDT_MISMATCH)
            except ValueError:
                raise RuntimeError("while handling that") from None
        except RuntimeError as exc:
            # The control: the link is there (`from None` only hides it from a
            # traceback), so (None, None) is the walk declining to follow it.
            self.assertIsNotNone(exc.__context__)
            self.assertEqual(self.verdict(exc, self.SET), (None, None))
        implicit = self.raised_while_handling(
            ValueError(self.FDT_MISMATCH), lambda: RuntimeError("while handling that")
        )
        self.assertIsNotNone(implicit.__context__)
        self.assertEqual(self.verdict(implicit, self.SET), (None, None))
        # The same link, made explicit, is read.
        try:
            try:
                raise ValueError(self.FDT_MISMATCH)
            except ValueError as inner:
                raise RuntimeError("wrapped on purpose") from inner
        except RuntimeError as exc:
            self.assertEqual(self.verdict(exc, self.SET), ("corrupt_or_truncated", None))
        # And what it must NOT carry to a data verdict is a host error: raised
        # while handling pyedflib's refusal, it holds the refusal as its context
        # and is still the host's.
        host = self.raised_while_handling(
            OSError(f"x.bdf: {EDF_REFUSAL} (Filesize)"),
            lambda: OSError(errno.EIO, "Input/output error"),
        )
        self.assertIsNotNone(host.__context__)
        self.assertEqual(self.verdict(host), (None, None))

    # -- rules 1 to 3 read causes, never contexts ----------------------------
    #
    # A host error raised while a handler was reading a file carries that file's
    # refusal as its `__context__`. It is the host saying no, and keeps its retry:
    # the refusal behind it is not what the exception is. Each exception below is
    # RAISED inside the handler that caught the refusal, so the link is the
    # interpreter's own.

    HOSTS: ClassVar[tuple[tuple[str, Callable[[], BaseException]], ...]] = (
        ("EIO", lambda: OSError(errno.EIO, "Input/output error")),
        ("ENOSPC", lambda: OSError(errno.ENOSPC, "No space left on device")),
        ("EACCES", lambda: PermissionError(errno.EACCES, "Permission denied")),
        # A typed generic code is no more a statement of cause than an errno:
        # it was raised without `from`, so it names no cause.
        ("untied generic", lambda: Refusal("read failed", "file_read_error")),
    )

    def assert_context_is_not_a_cause(self, refusal, primary, tracked=()):
        for label, make in self.HOSTS:
            with self.subTest(label):
                exc = self.raised_while_handling(refusal, make)
                # The control: the refusal really is the context, and nothing is
                # the cause, so the verdict is the rule declining to read it.
                self.assertIsNone(exc.__cause__)
                self.assertIn(str(refusal), str(exc.__context__))
                self.assertEqual(self.verdict(exc, primary, tracked), (getattr(exc, "code", None), None))

    def test_a_split_refusal_in_the_context_is_not_a_missing_part(self):
        refusal = ValueError(MNE_SPLIT_REFUSAL.format(path="/w/sub-01_task-rest_split-02_meg.fif"))
        self.assert_context_is_not_a_cause(refusal, self.SPLIT_HEAD)
        # The control for the control: as the explicit cause, the same refusal
        # is read, and the part the tree lacks is named.
        code, detail = self.verdict(chained(OSError(errno.EIO, "Input/output error"), refusal),
                                    self.SPLIT_HEAD)
        self.assertEqual(code, "split_part_missing")
        self.assertIn(self.SPLIT_NEXT, detail or "")

    def test_an_epoched_refusal_in_the_context_is_not_an_epoched_recording(self):
        refusal = ValueError("Must pass 2-d input. shape=(4, 500, 3)")
        self.assert_context_is_not_a_cause(refusal, self.SET)
        self.assertEqual(
            self.verdict(chained(OSError(errno.EIO, "Input/output error"), refusal), self.SET),
            ("epoched_recording", None),
        )

    def test_a_size_mismatch_in_the_context_is_not_a_truncated_fdt(self):
        refusal = ValueError(self.FDT_MISMATCH)
        self.assert_context_is_not_a_cause(refusal, self.SET)
        self.assertEqual(
            self.verdict(chained(OSError(errno.EIO, "Input/output error"), refusal), self.SET),
            ("corrupt_or_truncated", None),
        )

    def test_a_cause_cycle_terminates(self):
        a, b = RuntimeError("a"), RuntimeError("b")
        a.__cause__, b.__cause__ = b, a
        self.assertEqual(self.verdict(a), (None, None))

    def test_an_unmatched_generic_code_is_returned_as_it_was(self):
        for code in (None, "file_read_error", "corrupt_or_truncated", "maxshield_probe_failed"):
            with self.subTest(code):
                self.assertEqual(self.verdict(Refusal("something else entirely", code)), (code, None))

    def test_a_code_that_is_not_a_nonempty_string_is_absent(self):
        # The code is tested for membership in a frozenset, which raises TypeError
        # for an unhashable value (a list, a dict, a set). That TypeError escaped
        # `convert_one`'s `except` branch and turned a recording's failure into a
        # crash of the worker. Any `.code` that is not a non-empty string is not a
        # code: the exception is read as uncoded, which is also what gets its
        # message refined and what keeps a stray value off the public index.
        cases = (
            ("plain", "read failed", "sub-01/eeg/sub-01_task-x_eeg.edf", None),
            ("split", MNE_SPLIT_REFUSAL.format(path="/w/sub-01_task-rest_split-02_meg.fif"),
             self.SPLIT_HEAD, "split_part_missing"),
            ("epoched", "Must pass 2-d input. shape=(4, 500, 3)", self.SET, "epoched_recording"),
            ("fdt", self.FDT_MISMATCH, self.SET, "corrupt_or_truncated"),
        )
        for label, message, primary, refined in cases:
            uncoded = self.verdict(Refusal(message, None), primary)
            # The control: an uncoded exception really is refined (or not) as
            # expected, so equality below compares against a non-trivial verdict.
            self.assertEqual(uncoded[0], refined, label)
            for bad in (["file_read_error"], {"file_read_error"}, {"code": 1}, 7, b"x", "", object()):
                with self.subTest(label, code=type(bad).__name__):
                    odd = type("OddCoded", (Exception,), {"code": bad})(message)
                    try:
                        verdict = self.verdict(odd, primary)
                    except TypeError as exc:  # pragma: no cover - the defect itself
                        self.fail(f"failure_verdict raised {exc!r} for code {bad!r}")
                    self.assertEqual(verdict, uncoded)


def build_truncated_edfplus(path: str) -> str:
    """A REAL EDF+ written by pyedflib and cut to half its length: the reader's
    own "(Filesize)" refusal, not a hand-made file."""
    directory, name = os.path.split(path)
    written = build_real_edf(directory, os.path.splitext(name)[0], seconds=10)
    with open(written, "rb") as fh:
        data = fh.read()
    with open(written, "wb") as fh:
        fh.write(data[: len(data) // 2])
    return written


def build_truncated_bdfplus(path: str) -> str:
    """A REAL BDF+ written by pyedflib and cut to half its length: the same
    "(Filesize)" refusal as `build_truncated_edfplus`, for a `.bdf`."""
    import pyedflib

    build_edf_family(
        path, [("Fz", 64), ("Cz", 64)], pyedflib.FILETYPE_BDFPLUS, annotations=True, seconds=10
    )
    with open(path, "rb") as fh:
        data = fh.read()
    with open(path, "wb") as fh:
        fh.write(data[: len(data) // 2])
    return path


def build_onset_shifted_edf_family(path: str, file_type: int, first_onset: int = 40) -> str:
    """A REAL EDF+ or BDF+ written by pyedflib whose time-keeping annotation
    onsets start at +`first_onset` instead of +0: a session cut out of the middle
    with its session-relative onsets kept. pyedflib refuses it with "(it contains
    format errors)" and no errno. About 2 KB; only the onsets are rewritten, in
    place, so every length in the header still holds."""
    import pyedflib

    build_edf_family(path, [("Fz", 64), ("Cz", 64)], file_type, seconds=2)
    width = 3 if file_type in (pyedflib.FILETYPE_BDF, pyedflib.FILETYPE_BDFPLUS) else 2
    with open(path, "rb") as fh:
        raw = bytearray(fh.read())
    n_signals = int(raw[252:256].decode().strip())
    per_signal = 16 + 80 + 8 + 8 + 8 + 8 + 8 + 80  # label ... prefiltering, per signal
    first_count = 256 + n_signals * per_signal
    samples = [
        int(raw[first_count + 8 * i: first_count + 8 * (i + 1)].decode().strip())
        for i in range(n_signals)
    ]
    header_bytes = 256 * (n_signals + 1)
    record_bytes = width * sum(samples)
    annotation_bytes = width * samples[-1]  # the annotation signal is last
    for record in range((len(raw) - header_bytes) // record_bytes):
        start = header_bytes + record * record_bytes + (record_bytes - annotation_bytes)
        new = f"+{first_onset + record}".encode() + b"\x14\x14\x00"
        raw[start:start + len(new)] = new
    with open(path, "wb") as fh:
        fh.write(raw)
    return path


def build_late_onset_pair(compliant: str, late: str, file_type: int, first_onset: int = 40) -> None:
    """A REAL compliant EDF+C or BDF+C with events (`compliant`) and its late-onset
    twin (`late`): the same bytes with every time-stamped annotation list (TAL)
    moved by `first_onset` seconds, the time-keeping ones and the events alike.
    That is a session cut out of the middle with its onsets kept, and it is what
    pyedflib refuses ("it contains format errors"). Only TAL bytes differ between
    the two, so the samples are identical by construction, and the compliant file
    is the reference both are read against."""
    from decimal import Decimal

    import pyedflib

    # Events at 1.0 s ("stimulus", no duration) and 4.5 s ("response", 0.5 s) in a
    # six-second file of one-second data records.
    build_edf_family(compliant, [("Fz", 64), ("Cz", 64)], file_type, annotations=True, seconds=6)
    width = 3 if file_type in (pyedflib.FILETYPE_BDF, pyedflib.FILETYPE_BDFPLUS) else 2
    with open(compliant, "rb") as fh:
        raw = bytearray(fh.read())
    n_signals = int(raw[252:256].decode().strip())
    per_signal = 16 + 80 + 8 + 8 + 8 + 8 + 8 + 80  # label ... prefiltering, per signal
    first_count = 256 + n_signals * per_signal
    samples = [
        int(raw[first_count + 8 * i : first_count + 8 * (i + 1)].decode().strip())
        for i in range(n_signals)
    ]
    header_bytes = 256 * (n_signals + 1)
    record_bytes = width * sum(samples)
    block_bytes = width * samples[-1]  # the annotation signal is last
    for record in range((len(raw) - header_bytes) // record_bytes):
        start = header_bytes + record * record_bytes + (record_bytes - block_bytes)
        shifted = bytearray()
        for tal in re.findall(rb"[^\x00]+", bytes(raw[start : start + block_bytes])):
            onset = re.match(rb"([+-])(\d+(?:\.\d+)?)(.*)", tal, re.DOTALL)
            assert onset is not None, tal
            fraction = onset.group(2).partition(b".")[2]
            value = Decimal(onset.group(2).decode()) * (-1 if onset.group(1) == b"-" else 1)
            value += first_onset
            sign = "-" if value < 0 else "+"
            shifted += f"{sign}{abs(value):.{len(fraction)}f}".encode() + onset.group(3) + b"\x00"
        assert len(shifted) <= block_bytes, "the shifted TALs no longer fit the block"
        raw[start : start + block_bytes] = bytes(shifted).ljust(block_bytes, b"\x00")
    with open(late, "wb") as fh:
        fh.write(raw)


class StreamEdfThreshold:
    """Choose the exporter for the EDF and BDF files of one test, and see which
    one ran. 1 sends every file down the streaming exporter, the existing
    pattern for reaching it with a file small enough to build in a test; None
    puts the threshold back to what production runs with."""

    # Read at import, before any test lowers it. `use(test, None)` means THIS
    # value, not "leave the current one alone": a test that streams one file
    # and then asks for the in-memory exporter for the next must get it, and
    # the value in force at that moment is the 1 the first file left behind.
    DEFAULT: ClassVar[int] = generate_zarr.STREAM_EDF_MIN_BYTES

    @staticmethod
    def use(test: unittest.TestCase, threshold: int | None) -> None:
        saved = generate_zarr.STREAM_EDF_MIN_BYTES
        test.addCleanup(setattr, generate_zarr, "STREAM_EDF_MIN_BYTES", saved)
        generate_zarr.STREAM_EDF_MIN_BYTES = (
            StreamEdfThreshold.DEFAULT if threshold is None else threshold
        )

    @staticmethod
    @contextlib.contextmanager
    def watching_writers():
        """Yield the names of the store writers `convert_recording` hands to
        `write_store`, in call order, collected as they are called. The real
        function still runs; this only watches, and puts it back on exit. A
        refusal in memory never reaches a writer (the importer refuses first),
        so an empty list means the in-memory exporter, and `stream_to_zarr` the
        streaming one."""
        seen: list[str] = []
        real = generate_zarr.write_store

        def watch(writer, *args, **kwargs):
            seen.append(getattr(writer, "__name__", repr(writer)))
            return real(writer, *args, **kwargs)

        generate_zarr.write_store = watch
        try:
            yield seen
        finally:
            generate_zarr.write_store = real


class TestStreamedEdfRefusalThroughConvertOne(ConvertOneLocalCase):
    """A file pyedflib refuses is `corrupt_or_truncated` on BOTH exporters.

    biosigIO types the refusal itself on both (`CorruptFileError`, since 1.2.12).
    Streaming used to re-raise pyedflib's bare `OSError`, which `convert_one`
    took for infrastructure and retried until `retry_exhausted`. Real files, the
    real exporters, the real `convert_one`."""

    REQUIRES = ("zarr", "pyedflib", "biosigio")

    REFUSED: ClassVar[dict[str, tuple[str, Callable[[str], str]]]] = {
        "truncated EDF+ (Filesize)": (
            "sub-01/eeg/sub-01_task-rest_eeg.edf", build_truncated_edfplus,
        ),
        "truncated BDF+ (Filesize)": (
            "sub-01/eeg/sub-01_task-rest_eeg.bdf", build_truncated_bdfplus,
        ),
    }

    def test_both_exporters_type_the_refusal_alike(self):
        for label, (primary, build) in self.REFUSED.items():
            os.makedirs(os.path.join(self.repo, os.path.dirname(primary)), exist_ok=True)
            build(os.path.join(self.repo, primary))
            codes = {}
            for path_name, threshold in (("in-memory", None), ("streaming", 1)):
                with self.subTest(label, path=path_name):
                    StreamEdfThreshold.use(self, threshold)
                    with StreamEdfThreshold.watching_writers() as writers:
                        result = self.convert(primary, {primary})
                    # Which exporter ran, from what it was handed to write with:
                    # the second fixture used to stream in both halves.
                    self.assertEqual(
                        "stream_to_zarr" in writers, path_name == "streaming", writers
                    )
                    self.assert_refused_as_data(result, "corrupt_or_truncated")
                    self.assertNotIn("entry", result, "nothing is published for a refusal")
                    self.assertIn("not EDF(+) or BDF(+) compliant", result["detail"])
                    codes[path_name] = result["code"]
            self.assertEqual(codes.get("in-memory"), codes.get("streaming"), label)

    def test_a_streamed_file_that_pyedflib_reads_still_converts(self):
        # The inverse: the rule keys on the refusal, not on the exporter.
        import pyedflib

        primary = "sub-01/eeg/sub-01_task-rest_eeg.bdf"
        os.makedirs(os.path.join(self.repo, "sub-01/eeg"))
        build_edf_family(
            os.path.join(self.repo, primary), [("Fz", 64), ("Cz", 64)],
            pyedflib.FILETYPE_BDFPLUS, seconds=2,
        )
        StreamEdfThreshold.use(self, 1)
        result = self.convert(primary, {primary})
        self.assertTrue(result["ok"], result.get("error"))


class TestPinnedStreamingRefusal(unittest.TestCase):
    """The pinned biosigIO types a streamed EDF/BDF refusal itself.

    `stream_to_zarr` used to re-raise pyedflib's refusal, and the tolerant
    fallback's truncation errors, as a bare `OSError` (errno None), where the
    in-memory path raised a typed `corrupt_or_truncated`. The converter read
    those by their text. biosigio#149 (fixed by #150, released in 1.2.12) types
    them at the source, so the converter has nothing to infer, and this class
    is the canary for that contract on the converter's own call
    (`write_store(stream_to_zarr, ...)`). The day a release raises a bare
    `OSError` again, or a different type, it FAILS, and the cap in
    requirements.txt is not raised until a person has read why.

    A bare `OSError` out of the streaming exporter is still read as the host's:
    it carries no code, so it is retried (`TestFailureVerdict`)."""

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
            from biosigio import stream_to_zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def streamed_error(self, build, name: str) -> BaseException:
        """What the converter's streaming write raises for the file `build` makes."""
        from biosigio import stream_to_zarr

        with tempfile.TemporaryDirectory() as tmp:
            src = build(os.path.join(tmp, name))
            store = os.path.join(tmp, "out.zarr")
            with self.assertRaises(Exception) as raised:  # the exception IS the measurement
                generate_zarr.write_store(
                    stream_to_zarr, src, store, expected_path=store, bids_channels="off"
                )
        return raised.exception

    def assert_typed(self, exc: BaseException, expected: type, code: str, text: str) -> None:
        self.assertIs(
            type(exc), expected,
            f"biosigIO raised {type(exc).__name__} for a streamed refusal, not "
            f"{expected.__name__}: {exc}",
        )
        self.assertNotIsInstance(exc, OSError)
        self.assertEqual(exc.code, code)
        self.assertIn(text, str(exc))

    def test_a_streamed_pyedflib_refusal_is_a_corrupt_file_error(self):
        from biosigio.exceptions import CorruptFileError

        for label, build, name in (
            ("truncated EDF+", build_truncated_edfplus, "sub-01_task-rest_eeg.edf"),
            ("truncated BDF+", build_truncated_bdfplus, "sub-01_task-rest_eeg.bdf"),
        ):
            with self.subTest(label):
                exc = self.streamed_error(build, name)
                self.assert_typed(
                    exc, CorruptFileError, "corrupt_or_truncated",
                    "not EDF(+) or BDF(+) compliant",
                )

    def test_a_streamed_fallback_truncation_is_a_corrupt_file_error(self):
        from biosigio.exceptions import CorruptFileError

        exc = self.streamed_error(build_cut_degenerate_range_edf, "sub-01_task-rest_eeg.edf")
        self.assert_typed(exc, CorruptFileError, "corrupt_or_truncated", "file is truncated")

    def test_a_streamed_impossible_signal_count_is_a_file_read_error(self):
        # The fallback's header probe. biosigIO types it generically, not as
        # `corrupt_or_truncated`; the converter publishes the code it is given.
        from biosigio.exceptions import FileReadError

        exc = self.streamed_error(build_negative_signal_count_edf, "sub-01_task-rest_eeg.edf")
        self.assert_typed(
            exc, FileReadError, "file_read_error", "invalid number of signals in header (-1)"
        )


def build_degenerate_range_edf(path: str) -> str:
    """A REAL EDF written by pyedflib whose first channel has
    `physical_max == physical_min`, rewritten in place in the header. pyedflib
    refuses to open it ("not EDF(+) or BDF(+) compliant") and biosigIO's tolerant
    fallback reads it anyway (biosigio#109, #116): the one shape where the
    refusal is caught and a SECOND read of the file follows inside the `except`
    block that caught it."""
    directory, name = os.path.split(path)
    written = build_real_edf(directory, os.path.splitext(name)[0], n_channels=2, rate=100, seconds=4)
    with open(written, "rb") as fh:
        raw = bytearray(fh.read())
    n_signals = int(raw[252:256].decode().strip())
    physical_min = 256 + n_signals * (16 + 80 + 8)  # label, transducer, dimension
    physical_max = physical_min + n_signals * 8
    raw[physical_max:physical_max + 8] = raw[physical_min:physical_min + 8]
    with open(written, "wb") as fh:
        fh.write(raw)
    return written


def build_cut_degenerate_range_edf(path: str, keep: float = 0.6) -> str:
    """`build_degenerate_range_edf`, then cut to `keep` of its length: pyedflib
    refuses it for the degenerate range before it ever looks at the length, so
    biosigIO's tolerant fallback is what finds the file short."""
    written = build_degenerate_range_edf(path)
    with open(written, "rb") as fh:
        raw = fh.read()
    with open(written, "wb") as fh:
        fh.write(raw[: int(len(raw) * keep)])
    return written


def build_negative_signal_count_edf(path: str) -> str:
    """`build_degenerate_range_edf` with the header's signal count rewritten to
    -1, so pyedflib refuses it ("(Number of signals)") and the tolerant
    fallback's header probe finds the count impossible."""
    written = build_degenerate_range_edf(path)
    with open(written, "rb") as fh:
        raw = bytearray(fh.read())
    raw[252:256] = b"-1  "
    with open(written, "wb") as fh:
        fh.write(raw)
    return written


class TestHostErrorWhileRecoveringARefusedEdf(ConvertOneLocalCase):
    """A host error is the host's, also when it is raised while biosigIO is
    recovering from pyedflib's refusal.

    The tolerant fallback reads the file a second time inside the `except`
    block that caught pyedflib's refusal, so an `OSError(EIO)` raised by the
    second read has the refusal as its `__context__`. biosigIO leaves that EIO
    uncoded (it re-raises a host condition instead of typing it), and the
    converter must not read the context behind it: the failure stays a
    `pending` retry, never a terminal `corrupt_or_truncated` verdict for what a
    retry on a healthy disk would convert. The EIO is injected at
    `mne.io.read_raw`, the fallback's one read of the samples: no portable file
    permission reaches it, since pyedflib's own open fails first on an
    unreadable file and raises the host error before any fallback."""

    REQUIRES = ("zarr", "pyedflib", "biosigio", "mne")
    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.edf"

    def setUp(self):
        super().setUp()
        os.makedirs(os.path.join(self.repo, os.path.dirname(self.PRIMARY)))
        build_degenerate_range_edf(os.path.join(self.repo, self.PRIMARY))

    @contextlib.contextmanager
    def failing_disk(self):
        """`mne.io.read_raw` raises `OSError(EIO)`; yields the list of calls."""
        import mne.io

        calls: list[str] = []
        real = mne.io.read_raw

        def read_raw(path, *args, **kwargs):
            calls.append(os.path.basename(str(path)))
            raise OSError(errno.EIO, "Input/output error", str(path))

        mne.io.read_raw = read_raw
        try:
            yield calls
        finally:
            mne.io.read_raw = real

    def test_the_fixture_is_refused_by_pyedflib_and_recovered_by_biosigio(self):
        # The control for everything below: this file takes the fallback.
        import pyedflib

        with self.assertRaises(OSError) as refusal:
            pyedflib.EdfReader(os.path.join(self.repo, self.PRIMARY))
        self.assertIn("not EDF(+) or BDF(+) compliant", str(refusal.exception))
        for path_name, threshold in (("in-memory", None), ("streaming", 1)):
            with self.subTest(path_name):
                StreamEdfThreshold.use(self, threshold)
                with StreamEdfThreshold.watching_writers() as writers:
                    result = self.convert(self.PRIMARY, {self.PRIMARY})
                self.assertTrue(result["ok"], result.get("error"))
                self.assertEqual("stream_to_zarr" in writers, path_name == "streaming", writers)

    def test_a_host_error_during_the_fallback_read_keeps_its_retry(self):
        for path_name, threshold in (("in-memory", None), ("streaming", 1)):
            with self.subTest(path_name):
                StreamEdfThreshold.use(self, threshold)
                with StreamEdfThreshold.watching_writers() as writers, self.failing_disk() as calls:
                    result = self.convert(self.PRIMARY, {self.PRIMARY})
                # The fallback ran (the injected read was reached) on the
                # exporter this subtest asked for.
                self.assertEqual(calls, [os.path.basename(self.PRIMARY)] * len(calls))
                self.assertTrue(calls, "the fallback read was never reached")
                self.assertEqual("stream_to_zarr" in writers, path_name == "streaming", writers)
                # Not a data verdict. Uncoded is how a host condition reaches the
                # driver: it becomes a `pending` retry, never a `failures` entry.
                self.assertFalse(result["ok"], result)
                self.assertIsNone(result["code"], result.get("detail"))
                self.assertIn("Input/output error", result["detail"])


class TestFallbackTruncationThroughConvertOne(ConvertOneLocalCase):
    """A file biosigIO's tolerant fallback finds cut short is `corrupt_or_truncated`
    on BOTH exporters.

    The fallback is for files pyedflib refuses and MNE can read, and it raises
    an error when it finds the file shorter than its header says. biosigIO
    types it on both exporters (`CorruptFileError`, since 1.2.12); streaming
    used to raise it as a bare `OSError`, which reached `failure_verdict`
    uncoded and was retried until `retry_exhausted`. Real files, the real
    exporters, the real `convert_one`."""

    REQUIRES = ("zarr", "pyedflib", "biosigio", "mne")
    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.edf"

    def build(self, builder) -> None:
        os.makedirs(os.path.join(self.repo, os.path.dirname(self.PRIMARY)), exist_ok=True)
        builder(os.path.join(self.repo, self.PRIMARY))

    def convert_on(self, path_name: str, threshold: int | None) -> dict:
        StreamEdfThreshold.use(self, threshold)
        with StreamEdfThreshold.watching_writers() as writers:
            result = self.convert(self.PRIMARY, {self.PRIMARY})
        self.assertEqual("stream_to_zarr" in writers, path_name == "streaming", writers)
        return result

    def test_the_uncut_file_converts_on_both_exporters(self):
        # The control: this file takes the fallback and is whole, so the
        # verdicts below are about the cut and nothing else.
        self.build(build_degenerate_range_edf)
        for path_name, threshold in (("in-memory", None), ("streaming", 1)):
            with self.subTest(path_name):
                result = self.convert_on(path_name, threshold)
                self.assertTrue(result["ok"], result.get("error"))

    def test_a_cut_file_is_corrupt_or_truncated_on_both_exporters(self):
        self.build(build_cut_degenerate_range_edf)
        codes = {}
        for path_name, threshold in (("in-memory", None), ("streaming", 1)):
            with self.subTest(path_name):
                result = self.convert_on(path_name, threshold)
                self.assert_refused_as_data(result, "corrupt_or_truncated")
                self.assertNotIn("entry", result, "nothing is published for a refusal")
                self.assertIn("file is truncated", result["detail"])
                codes[path_name] = result["code"]
        self.assertEqual(codes.get("in-memory"), codes.get("streaming"))

    def test_an_impossible_signal_count_is_a_generic_data_failure_on_both_exporters(self):
        # The fallback's header probe. biosigIO calls this one a generic
        # `file_read_error` on both exporters, which is its call to make, and the
        # converter publishes the code it is given: a typed failure that is
        # never retried, where the bare `OSError` used to be typed
        # `corrupt_or_truncated` here by its text.
        self.build(build_negative_signal_count_edf)
        codes = {}
        for path_name, threshold in (("in-memory", None), ("streaming", 1)):
            with self.subTest(path_name):
                result = self.convert_on(path_name, threshold)
                self.assert_refused_as_data(result, "file_read_error")
                self.assertIn("invalid number of signals in header (-1)", result["detail"])
                codes[path_name] = result["code"]
        self.assertEqual(codes.get("in-memory"), codes.get("streaming"))


class TestAbsentAnnexObjectThroughConvertOne(ConvertOneLocalCase):
    """A git-annex pointer whose content was never fetched, in LOCAL mode.

    The working tree holds a symlink to an object that is not there, so the
    converter cannot stat the file, forces streaming, and a reader is asked to
    open a path that does not exist. biosigIO 1.2.12 types that
    `file_read_error` on the streaming source, as its in-memory source always
    did; before, the streaming source raised a bare `FileNotFoundError`, which
    reached `failure_verdict` uncoded and was retried as `pending`. Remote
    mode never gets here: it types a missing object `annex_object_missing`
    before any reader runs.

    This pins what the pin does, so the change is visible; it is not a
    statement that a typed, never-retried failure is the right verdict for
    content that is merely unfetched."""

    REQUIRES = ("zarr", "pyedflib", "biosigio")
    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.edf"
    PRIMARY_BDF = "sub-01/eeg/sub-01_task-rest_eeg.bdf"

    def assert_unfetched_is_a_typed_read_failure(self, primary: str) -> None:
        link = os.path.join(self.repo, primary)
        os.makedirs(os.path.dirname(link))
        extension = os.path.splitext(primary)[1]
        absent = os.path.join(self.repo, ".git", "annex", "objects", f"absent{extension}")
        os.symlink(os.path.relpath(absent, os.path.dirname(link)), link)
        self.assertFalse(os.path.exists(link), "the control: the link dangles")

        result = self.convert(primary, {primary})

        self.assert_refused_as_data(result, "file_read_error")
        self.assertIn("no such file or directory", result["detail"])

    def test_an_unfetched_object_is_a_typed_read_failure(self):
        self.assert_unfetched_is_a_typed_read_failure(self.PRIMARY)

    def test_an_unfetched_bdf_object_is_a_typed_read_failure(self):
        self.assert_unfetched_is_a_typed_read_failure(self.PRIMARY_BDF)


class TestLateOnsetThroughConvertOne(ConvertOneLocalCase):
    """An EDF+C or BDF+C recording whose first time-keeping onset is late
    converts on BOTH exporters (biosigio#145, fixed by #152, in 1.2.12).

    pyedflib refuses such a file ("it contains format errors"); biosigIO's
    tolerant read recovers it and says so in the store's recording metadata
    (`edf_tolerant_read`). The fixture is a small real file this test writes,
    with its onsets rewritten in place."""

    REQUIRES = ("zarr", "pyedflib", "biosigio")

    def setUp(self):
        super().setUp()
        # `ConvertOneLocalCase`'s `aws` absorbs the upload; this one keeps the store.
        self.synced_dir = os.path.join(self._tmp.name, "synced")
        with open(os.path.join(self._tmp.name, "bin", "aws"), "w") as fh:
            fh.write(
                "#!/bin/sh\n"
                'if [ "$1" = s3 ] && [ "$2" = sync ]; then\n'
                f'  mkdir -p "{self.synced_dir}" && cp -R "$3" "{self.synced_dir}/"\n'
                "fi\nexit 0\n"
            )

    def published_recording_metadata(self, entry: dict) -> dict:
        with open(
            os.path.join(self.synced_dir, os.path.basename(entry["zarr"]), "zarr.json"),
            encoding="utf-8",
        ) as fh:
            return json.load(fh)["attributes"]["recording_metadata"]

    def test_a_late_first_onset_converts_in_memory_and_streamed(self):
        import pyedflib

        for label, primary, file_type in (
            ("EDF+C", "sub-01/eeg/sub-01_task-rest_eeg.edf", pyedflib.FILETYPE_EDFPLUS),
            ("BDF+C", "sub-01/eeg/sub-01_task-rest_eeg.bdf", pyedflib.FILETYPE_BDFPLUS),
        ):
            path = os.path.join(self.repo, primary)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            build_onset_shifted_edf_family(path, file_type, first_onset=40)
            with self.subTest(label, check="the fixture is the shape pyedflib refuses"):
                with self.assertRaises(OSError) as refusal:
                    pyedflib.EdfReader(path)
                self.assertIn("not EDF(+) or BDF(+) compliant", str(refusal.exception))
            for path_name, threshold in (("in-memory", None), ("streaming", 1)):
                with self.subTest(label, path=path_name):
                    shutil.rmtree(self.synced_dir, ignore_errors=True)
                    StreamEdfThreshold.use(self, threshold)
                    with StreamEdfThreshold.watching_writers() as writers:
                        result = self.convert(primary, {primary})
                    self.assertEqual(
                        "stream_to_zarr" in writers, path_name == "streaming", writers
                    )
                    self.assertTrue(result["ok"], result.get("error"))
                    (group,) = result["entry"]["groups"]
                    self.assertEqual((group["n_channels"], group["n_samples"]), (2, 128))
                    metadata = self.published_recording_metadata(result["entry"])
                    self.assertIs(metadata.get("edf_tolerant_read"), True, metadata)
                    self.assertEqual(
                        metadata.get("edf_tolerant_read_reason"), "late_timekeeping_onset"
                    )

    def published_group(self, entry: dict):
        import zarr

        return zarr.open_group(
            os.path.join(self.synced_dir, os.path.basename(entry["zarr"])), mode="r"
        )

    def published_samples(self, entry: dict) -> list[tuple[Any, float]]:
        """Each channel's samples as the store serves them, decoded by the
        channel's own `scale` and `offset`, with that scale: the serving copy is
        int16, so the scale is one quantization step."""
        import numpy as np

        root = self.published_group(entry)
        (name,) = root.attrs["channel_groups"]
        group = root[name]
        level0 = np.asarray(group["0"][:, :], dtype=np.float64)
        return [
            (level0[ch["row_index"]] * ch["scale"] + ch["offset"], ch["scale"])
            for ch in group.attrs["channels"]
        ]

    def published_events(self, entry: dict) -> tuple[list[float], list[str]]:
        """The store's events as (onsets in seconds, descriptions)."""
        events = self.published_group(entry)["events"]
        if events.attrs["n_events"] == 0:
            return [], []
        labels = events.attrs["label_map"]
        return (
            [float(v) for v in events["onset"][:]],
            [labels[str(int(code))] for code in events["code"][:]],
        )

    EVENTS = ([1.0, 4.5], ["stimulus", "response"])
    # The `events.tsv` rows of the test below. They differ from the file's own
    # annotations on purpose: `apply_events_tsv` replaces events, and a store that
    # still held the annotations (a no-op apply) would otherwise pass.
    TSV_EVENTS = ([2.0, 3.25], ["go", "stop"])
    # The store writer `convert_recording` hands to `write_store` on each path.
    WRITER: ClassVar[dict[str, str]] = {"in-memory": "to_zarr", "streaming": "stream_to_zarr"}

    def late_onset_formats(self):
        import pyedflib

        return (
            ("EDF+C", "edf", pyedflib.FILETYPE_EDFPLUS),
            ("BDF+C", "bdf", pyedflib.FILETYPE_BDFPLUS),
        )

    def test_a_late_first_onset_keeps_the_samples_and_the_in_file_events(self):
        """The late recording's store holds the samples its compliant twin holds,
        read by pyedflib (the reference reader), and the in-file events at the
        times the compliant file states, not shifted by the late onset. The
        streaming exporter carries no in-file annotations at all, on a compliant
        recording as on this one, so there both stores must publish none."""
        import numpy as np
        import pyedflib

        for label, ext, file_type in self.late_onset_formats():
            late = f"sub-01/eeg/sub-01_task-rest_eeg.{ext}"
            twin = f"sub-02/eeg/sub-02_task-rest_eeg.{ext}"
            compliant = os.path.join(self._tmp.name, f"compliant.{ext}")
            for rel in (late, twin):
                os.makedirs(os.path.dirname(os.path.join(self.repo, rel)), exist_ok=True)
            build_late_onset_pair(compliant, os.path.join(self.repo, late), file_type)
            shutil.copy(compliant, os.path.join(self.repo, twin))

            reader = pyedflib.EdfReader(compliant)
            try:
                reference = [reader.readSignal(i) for i in range(reader.signals_in_file)]
                onsets, _durations, descriptions = reader.readAnnotations()
            finally:
                reader.close()
            with self.subTest(label, check="the reference reads what the fixture wrote"):
                self.assertEqual((list(onsets), list(descriptions)), self.EVENTS)
                self.assertEqual(len(reference), 2)

            for path_name, threshold in (("in-memory", None), ("streaming", 1)):
                with self.subTest(label, path=path_name):
                    StreamEdfThreshold.use(self, threshold)
                    shutil.rmtree(self.synced_dir, ignore_errors=True)
                    with StreamEdfThreshold.watching_writers() as writers:
                        results = {rel: self.convert(rel, {rel}) for rel in (late, twin)}
                    # The exporter that ran, for the late file and its twin alike.
                    self.assertEqual(writers, [self.WRITER[path_name]] * 2)
                    for rel, result in results.items():
                        self.assertTrue(result["ok"], (rel, result.get("error")))
                    # The controls: only the late file went through the tolerant read.
                    self.assertIs(
                        self.published_recording_metadata(results[late]["entry"]).get(
                            "edf_tolerant_read"
                        ),
                        True,
                    )
                    self.assertNotIn(
                        "edf_tolerant_read",
                        self.published_recording_metadata(results[twin]["entry"]),
                    )

                    published = self.published_samples(results[late]["entry"])
                    twin_published = self.published_samples(results[twin]["entry"])
                    self.assertEqual(len(published), len(reference))
                    for (decoded, step), (twin_decoded, _), source in zip(
                        published, twin_published, reference, strict=True
                    ):
                        self.assertEqual(decoded.shape, source.shape)
                        np.testing.assert_array_equal(decoded, twin_decoded)
                        self.assertLessEqual(float(np.abs(decoded - source).max()), step)

                    events = self.published_events(results[late]["entry"])
                    self.assertEqual(events, self.published_events(results[twin]["entry"]))
                    if path_name == "in-memory":
                        self.assertEqual(events, self.EVENTS)
                    else:
                        # The streaming exporter writes only the events table it is
                        # handed (from events.tsv), never a file's own annotations,
                        # so the compliant file and the late one both publish none
                        # here. The events.tsv test below covers streamed events.
                        self.assertEqual(events, ([], []))

    def test_events_tsv_events_reach_the_store_of_a_late_first_onset_recording(self):
        """On the streaming path the events come from the BIDS `events.tsv`, so
        that is where a late recording's events are checked against expected
        values on both exporters. The rows differ from the file's own
        annotations, so only the sidecar's values can satisfy the test."""
        self.assertNotEqual(self.TSV_EVENTS, self.EVENTS)
        tsv = "sub-01/eeg/sub-01_task-rest_events.tsv"
        os.makedirs(os.path.join(self.repo, "sub-01/eeg"), exist_ok=True)
        with open(os.path.join(self.repo, tsv), "w", encoding="utf-8") as fh:
            fh.write("onset\tduration\ttrial_type\n2.0\t0.5\tgo\n3.25\t0\tstop\n")

        for label, ext, file_type in self.late_onset_formats():
            primary = f"sub-01/eeg/sub-01_task-rest_eeg.{ext}"
            build_late_onset_pair(
                os.path.join(self._tmp.name, f"compliant.{ext}"),
                os.path.join(self.repo, primary),
                file_type,
            )
            for path_name, threshold in (("in-memory", None), ("streaming", 1)):
                with self.subTest(label, path=path_name):
                    StreamEdfThreshold.use(self, threshold)
                    shutil.rmtree(self.synced_dir, ignore_errors=True)
                    with StreamEdfThreshold.watching_writers() as writers:
                        result = self.convert(primary, {primary, tsv})
                    self.assertEqual(writers, [self.WRITER[path_name]])
                    self.assertTrue(result["ok"], result.get("error"))
                    self.assertEqual(self.published_events(result["entry"]), self.TSV_EVENTS)
                    self.assertEqual(result["entry"]["n_events"], 2)
                    self.assertEqual(result["entry"]["trial_types"], {"go": 1, "stop": 1})


class TestCutShortBrainVisionThroughConvertOne(ConvertOneLocalCase):
    """A BrainVision data file cut short is a terminal `corrupt_or_truncated`.

    Before biosigIO 1.2.13 the reader dropped the partial trailing frame, and any
    marker in it, without a word, and the converter published a store for a
    recording that was missing its end. The header here declares no `DataPoints`
    count, so a size that is not a whole number of frames (channels times bytes
    per sample) is the evidence. The files are a real BrainVision triplet written
    by `write_brainvision`, converted through the real `convert_one`."""

    REQUIRES = ("zarr", "mne", "biosigio")
    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.vhdr"

    def test_a_data_file_cut_by_one_byte_is_terminal_corrupt_or_truncated(self):
        os.makedirs(os.path.join(self.repo, "sub-01/eeg"))
        paths = write_brainvision(os.path.join(self.repo, self.PRIMARY), ["Fp1", "Fp2", "Cz", "Pz"])
        head_files = {os.path.relpath(path, self.repo) for path in paths}
        data = paths[2]
        self.assertEqual(os.path.splitext(data)[1], ".eeg")

        # The control: the complete triplet converts, so the refusal below is the
        # missing byte and not the fixture.
        self.assertEqual(os.path.getsize(data) % (4 * 2), 0)
        complete = self.convert(self.PRIMARY, head_files)
        self.assertTrue(complete["ok"], complete.get("error"))

        with open(data, "r+b") as fh:
            fh.truncate(os.path.getsize(data) - 1)
        result = self.convert(self.PRIMARY, head_files)

        self.assert_refused_as_data(result, "corrupt_or_truncated")
        self.assertIn(os.path.basename(data), result["detail"])
        self.assertNotIn("entry", result)


class TestStreamedTruncatedFifThroughConvertOne(ConvertOneLocalCase):
    """A FIF cut short in its data, converted down the STREAMING path.

    Through `Recording.from_file` biosigIO 1.2.13 types such a file
    `corrupt_or_truncated`, and the in-memory path ends there (see
    `TestConvertOneFifSidecarOvercount`). The streaming export still raises MNE's
    bare `ValueError` ("buffer size must be a multiple of element size",
    biosigio#161), which reaches `failure_verdict` uncoded, so the converter
    retries the recording until `retry_exhausted`. One defect, two verdicts.

    The streaming branch is selected by lowering `STREAM_MIN_BYTES`, which is path
    selection and not a substitute for any logic: the file, the reader and the
    converter are real. A KIT `.sqd` and a 4D/BTi `config` or `hs_file` have the
    same gap on the streaming path (biosigio#168), but this repository carries no
    such fixture, so they are not covered here.

    The first test pins today's verdict, so a biosigIO that fixes #161 breaks it
    and says why; the second is the verdict we want, an expected failure that
    turns into a failing run the day it passes. Remove both xfail and companion
    together when #161 is fixed."""

    REQUIRES = ("zarr", "mne", "biosigio")
    PRIMARY = "sub-01/meg/sub-01_task-rest_meg.fif"

    def convert_streamed(self) -> tuple[dict, list[str]]:
        os.makedirs(os.path.join(self.repo, "sub-01/meg"))
        path = build_real_fif(os.path.join(self.repo, self.PRIMARY))
        with open(path, "rb") as fh:
            data = fh.read()
        with open(path, "wb") as fh:
            fh.write(data[: len(data) // 2])
        saved = generate_zarr.STREAM_MIN_BYTES
        self.addCleanup(setattr, generate_zarr, "STREAM_MIN_BYTES", saved)
        generate_zarr.STREAM_MIN_BYTES = 1
        with StreamEdfThreshold.watching_writers() as writers:
            result = self.convert(self.PRIMARY, {self.PRIMARY})
        return result, writers

    def test_a_streamed_truncated_fif_is_uncoded_until_biosigio_161_is_fixed(self):
        result, writers = self.convert_streamed()
        self.assertEqual(writers, ["stream_to_zarr"], "the streaming branch ran")
        self.assertFalse(result["ok"])
        self.assertIsNone(result["code"], "uncoded, so retried as infrastructure")
        self.assertIn("buffer size must be a multiple of element size", result["error"])

    @unittest.expectedFailure
    def test_a_streamed_truncated_fif_is_corrupt_or_truncated(self):
        """xfail (strict): biosigio#161."""
        result, writers = self.convert_streamed()
        self.assertEqual(writers, ["stream_to_zarr"], "the streaming branch ran")
        self.assert_refused_as_data(result, "corrupt_or_truncated")


class TestReaderRefusalsThroughConvertOne(ConvertOneLocalCase):
    """The readers' refusals that `failure_verdict` types, each reached by giving
    the real reader a real broken file, and the controls that keep the rules
    from turning a conversion that works into a failure."""

    REQUIRES = ("zarr", "scipy.io", "mne", "biosigio")

    SET = "sub-01/eeg/sub-01_task-x_eeg.set"
    FDT = "sub-01/eeg/sub-01_task-x_eeg.fdt"
    SPLITS = tuple(f"sub-01/meg/sub-01_task-rest_split-0{n}_meg.fif" for n in (1, 2, 3))

    def write_fdt_set(self, **kwargs) -> None:
        write_eeglab_set(
            os.path.join(self.repo, self.SET), os.path.join(self.repo, self.FDT),
            embedded="sub-01_task-x_eeg.fdt", **kwargs,
        )

    def test_a_fdt_of_the_wrong_size_is_corrupt_or_truncated(self):
        self.write_fdt_set()
        with open(os.path.join(self.repo, self.FDT), "r+b") as fh:
            fh.truncate(4 * 1000 * 4 - 4)
        result = self.convert(self.SET, {self.SET, self.FDT})
        self.assert_refused_as_data(result, "corrupt_or_truncated")
        self.assertIn("float32 samples but the .set header implies", result["detail"])

    def test_a_fdt_of_the_right_size_converts(self):
        self.write_fdt_set()
        result = self.convert(self.SET, {self.SET, self.FDT})
        self.assertTrue(result["ok"], result.get("error"))

    def test_an_embedded_epoched_set_is_an_epoched_recording(self):
        build_eeglab_set(os.path.join(self.repo, self.SET), 3, trials=4)
        result = self.convert(self.SET, {self.SET})
        self.assert_refused_as_data(result, "epoched_recording")
        self.assertIn("Must pass 2-d input", result["detail"])

    def test_an_epoched_set_with_a_fdt_still_converts(self):
        # Measured: the reader flattens its four epochs into one run. This is why
        # the rule keys on the reader's refusal and not on `trials > 1`.
        os.makedirs(os.path.join(self.repo, "sub-01/eeg"))
        build_eeglab_set(os.path.join(self.repo, self.SET), 3, trials=4, fdt=True)
        result = self.convert(self.SET, {self.SET, self.FDT})
        self.assertTrue(result["ok"], result.get("error"))
        (group,) = result["entry"]["groups"]
        self.assertEqual((group["n_channels"], group["n_samples"]), (3, 500 * 4))

    def build_split_chain(self) -> None:
        os.makedirs(os.path.join(self.repo, "sub-01/meg"))
        build_real_fif(
            os.path.join(self.repo, "sub-01/meg/sub-01_task-rest_meg.fif"),
            rate=1000.0, seconds=120, split_size="2MB", split_naming="bids",
        )
        for part in self.SPLITS:
            self.assertTrue(os.path.exists(os.path.join(self.repo, part)), part)

    def test_a_split_chain_without_its_next_part_is_split_part_missing(self):
        self.build_split_chain()
        os.remove(os.path.join(self.repo, self.SPLITS[1]))
        result = self.convert(self.SPLITS[0], {self.SPLITS[0], self.SPLITS[2]})
        self.assert_refused_as_data(result, "split_part_missing")
        self.assertIn(self.SPLITS[1], result["detail"])
        self.assertNotIn(self.repo, result["detail"])
        # And it is not the MaxShield verdict it used to be reported as.
        self.assertNotEqual(result["code"], "maxshield_probe_failed")

    def test_a_tracked_next_part_that_is_absent_keeps_the_probe_failure(self):
        # The tree lists split-02, the working tree lacks it: not a property of
        # the dataset, so no relabel.
        self.build_split_chain()
        os.remove(os.path.join(self.repo, self.SPLITS[1]))
        result = self.convert(self.SPLITS[0], set(self.SPLITS))
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "maxshield_probe_failed")

    def test_the_whole_split_chain_converts(self):
        self.build_split_chain()
        result = self.convert(self.SPLITS[0], set(self.SPLITS))
        self.assertTrue(result["ok"], result.get("error"))


# --- Subject information never reaches a store (#1626) -------------------------
#
# A store holds the data, the events, channel names, types and units, and
# technical recording metadata, and never the subject. Every assertion below is
# on member NAMES, never on a value: the fixture's header values are synthetic,
# but the habit is the one a real recording needs.

# The EDF/BDF header members biosigIO's importer copies into the recording
# metadata when they are non-empty, which is what the 2026-10-05 census found in
# every store root of nm000186.
EDF_HEADER_SUBJECT_MEMBERS = {
    "patientcode", "gender", "birthdate", "patient_additional",
    "admincode", "technician", "equipment", "recording_additional",
}
# Maps whose KEYS are channel labels, sidecar rows, electrode names or event
# codes rather than member names, so a channel labeled `Sex` is not a finding.
# The first two are the ones biosigIO's own removal never descends into.
LABEL_KEYED_ATTRS = frozenset({
    "channels_tsv_units", "channel_labels_deduplicated",
    "electrode_positions", "label_map", "value_descriptions",
})


def member_names(value: object) -> set[str]:
    """Every mapping key at any depth, without descending into the keys of a
    label-keyed map. Names only: a failure built on this cannot print a value."""
    names: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            names.add(str(key))
            if key not in LABEL_KEYED_ATTRS:
                names |= member_names(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            names |= member_names(item)
    return names


def build_edf_with_subject_header(path: str, labels: list[str], rate: int = 200,
                                  seconds: int = 10) -> str:
    """A REAL EDF+ written by pyedflib with every patient and recording header
    field it can set, as biosigIO's own tests write one. The values are
    synthetic and never asserted on."""
    import datetime

    import numpy as np
    import pyedflib

    writer = pyedflib.EdfWriter(path, len(labels), file_type=pyedflib.FILETYPE_EDFPLUS)
    try:
        writer.setSignalHeaders([
            {
                "label": label, "dimension": "uV", "sample_frequency": rate,
                "physical_max": 500.0, "physical_min": -500.0,
                "digital_max": 32767, "digital_min": -32768,
                "transducer": "", "prefilter": "",
            }
            for label in labels
        ])
        writer.setPatientCode("SUBJ-0042")
        writer.setPatientName("Test_Person")
        writer.setSex(1)
        writer.setBirthdate(datetime.date(1970, 1, 2))
        writer.setPatientAdditional("left_handed")
        writer.setAdmincode("ADM-7")
        writer.setTechnician("Operator_A")
        writer.setEquipment("Amplifier_1000")
        writer.setRecordingAdditional("pilot_session")
        # EDF stores a local start time with no zone, and pyedflib takes it naive.
        writer.setStartdatetime(datetime.datetime(2020, 1, 2, 3, 4, 5))  # noqa: DTZ001
        rng = np.random.default_rng(0)
        writer.writeSamples([rng.normal(0, 20, rate * seconds) for _ in labels])
    finally:
        writer.close()
    return path


def _writer_with_option(filepath, *, dtype="int16", exclude_subject_info=False, **kwargs):
    return filepath


def _writer_without_option(filepath, **kwargs):
    """A writer as biosigIO shipped it before 1.2.11: it collects unknown
    keywords, so it would have accepted the option and written the store with
    every subject member in it."""
    return filepath


CAPABLE_WRITERS = {
    "Recording.to_zarr": _writer_with_option,
    "ZarrExporter.export": _writer_with_option,
    "stream_to_zarr": _writer_with_option,
}


def _strip_nothing(metadata):
    """A stand-in `strip_subject_info` that the check only needs to be callable."""
    return dict(metadata)


def _have_biosigio_strip() -> bool:
    try:
        from biosigio import strip_subject_info  # noqa: F401
    except Exception:  # noqa: BLE001 - absent or too old: the read-back cannot run
        return False
    return True


def _requires_biosigio_strip(test):
    """Skip `test` without biosigIO's `strip_subject_info`, decided when the test
    RUNS, not when this module is imported. Importing biosigIO takes over a
    second, and a pool worker started by spawn (the default on macOS) imports
    this module to unpickle its worker function; paid at import, that second
    lands inside the admission tests' timed spans and fails them."""

    @functools.wraps(test)
    def run(self, *args, **kwargs):
        if not _have_biosigio_strip():
            raise unittest.SkipTest("conversion deps unavailable: biosigio")
        return test(self, *args, **kwargs)

    return run


class TestSubjectInfoProblems(unittest.TestCase):
    """The check `main` runs before converting anything, against stand-in
    writers that do or do not name the option. This tests the check itself:
    no conversion logic is replaced."""

    def problems(self, installed="1.2.13", imported="1.2.13", strip=_strip_nothing, **writers):
        return generate_zarr.subject_info_problems(
            installed_version=installed, imported_version=imported,
            writers={**CAPABLE_WRITERS, **writers}, strip=strip,
        )

    def test_a_capable_biosigio_passes(self):
        # "1.10.0" is the case a string comparison gets wrong: as strings it
        # sorts below "1.2.13".
        for version in ("1.2.13", "1.2.13.0", "1.2.13.post1", "1.2.13+local.1",
                        "1.2.14", "1.3", "1.10.0", "2.0.0"):
            with self.subTest(version):
                self.assertEqual(self.problems(version, version), [])

    def test_a_release_below_the_floor_is_refused(self):
        for version in ("1.2.12", "1.2.12.post1", "1.2.11", "1.2.11.post1", "1.2.10",
                        "1.2.10.post1", "1.2.9", "1.1.99", "0.9.9"):
            with self.subTest(version):
                problems = self.problems(version, version)
                self.assertEqual(problems, [
                    f"the installed biosigIO is {version}, below 1.2.13",
                    f"the imported biosigIO is {version}, below 1.2.13",
                ])

    def test_a_pre_release_or_unreadable_version_is_refused(self):
        # `1.2.13rc1` sorts BELOW 1.2.13; read by its leading digits it would pass.
        for version in ("1.2.13rc1", "1.2.13.dev0", "1.2.13a1", "1.2.14.dev0",
                        "1.2.13.post1.dev0", "not-a-version", "", None):
            with self.subTest(version):
                self.assertEqual(len(self.problems(version, version)), 2)

    def test_an_import_older_than_the_installed_release_is_refused(self):
        # An older copy shadowing the installed one, or imported before an
        # upgrade: the distribution says 1.2.13, the code that runs is 1.2.12.
        self.assertEqual(self.problems("1.2.13", "1.2.12"),
                         ["the imported biosigIO is 1.2.12, below 1.2.13"])

    def test_an_installed_release_older_than_the_import_is_refused(self):
        self.assertEqual(self.problems("1.2.12", "1.2.13"),
                         ["the installed biosigIO is 1.2.12, below 1.2.13"])

    def test_every_writer_must_name_the_option(self):
        for name in generate_zarr.BIOSIGIO_STORE_WRITERS:
            with self.subTest(name):
                problems = self.problems(**{name: _writer_without_option})
                self.assertEqual(problems, [
                    f"biosigIO's {name} does not take exclude_subject_info"
                ])

    def test_a_missing_writer_is_refused(self):
        problems = self.problems(stream_to_zarr=None)
        self.assertEqual(problems, ["biosigIO has no stream_to_zarr"])

    def test_a_biosigio_without_strip_subject_info_is_refused(self):
        # The read-back of every written store needs it; without it every
        # recording would be refused one by one instead of the run up front.
        self.assertEqual(self.problems(strip=None), [
            "biosigIO has no strip_subject_info to check a written store with"
        ])

    def test_names_keyword_does_not_count_a_catch_all(self):
        self.assertTrue(generate_zarr.names_keyword(_writer_with_option, "exclude_subject_info"))
        self.assertFalse(generate_zarr.names_keyword(_writer_without_option, "exclude_subject_info"))
        self.assertFalse(generate_zarr.names_keyword(None, "exclude_subject_info"))

    def test_the_floor_is_the_pinned_release(self):
        self.assertEqual(generate_zarr.final_release(generate_zarr.SUBJECT_INFO_FLOOR), (1, 2, 13))

    def test_the_refusal_exit_is_ex_config(self):
        self.assertEqual(generate_zarr.EXIT_SUBJECT_INFO_UNAVAILABLE, 78)

    def test_the_pin_installs_nothing_the_check_refuses(self):
        # requirements.txt is what the node installs; a floor below the check's
        # would install a biosigIO the converter then refuses on every run.
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "requirements.txt")) as fh:
            pins = [ln.strip() for ln in fh if ln.strip().startswith("biosigio[")]
        self.assertEqual(len(pins), 1, pins)
        match = re.search(r">=\s*([^,\s]+)", pins[0])
        if match is None:
            self.fail(f"no >= floor in {pins[0]!r}")
        pinned = generate_zarr.final_release(match.group(1))
        required = generate_zarr.final_release(generate_zarr.SUBJECT_INFO_FLOOR)
        if pinned is None or required is None:
            self.fail(f"cannot read the floor of {pins[0]!r}")
        self.assertGreaterEqual(pinned, required, pins[0])


def write_root(store: str, attrs: dict) -> None:
    """A real Zarr v3 root group document holding `attrs`."""
    os.makedirs(store, exist_ok=True)
    with open(os.path.join(store, "zarr.json"), "w") as fh:
        json.dump({"zarr_format": 3, "node_type": "group", "attributes": attrs}, fh)


EXCLUDED_ROOT = {"subject_info_excluded": True,
                 "recording_metadata": {"number_of_signals": 4, "startdate": "2020-01-02"}}


class TestWriteStore(unittest.TestCase):
    """`write_store`, the one way the converter writes a store, against
    stand-in writers that write a real root `zarr.json`. What is under test is
    the guard, so the writers are the smallest that can satisfy or break it.
    The cases a store passes need biosigIO's `strip_subject_info` for the
    content check, so they run in the job with the real stack."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = os.path.join(self._tmp.name, "rec.zarr")
        self.calls: list[dict] = []

    def honoring_writer(self, filepath, *, dtype="int16", exclude_subject_info=False):
        self.calls.append({"dtype": dtype, "exclude_subject_info": exclude_subject_info})
        write_root(self.store, EXCLUDED_ROOT if exclude_subject_info else {})
        return filepath

    def write(self, writer, **kwargs):
        return generate_zarr.write_store(writer, self.store, expected_path=self.store, **kwargs)

    @_requires_biosigio_strip
    def test_the_option_is_passed_and_the_mark_read_back(self):
        self.assertEqual(self.write(self.honoring_writer, dtype="float32"), self.store)
        self.assertEqual(self.calls, [{"dtype": "float32", "exclude_subject_info": True}])

    @_requires_biosigio_strip
    def test_a_path_like_return_is_accepted(self):
        def writer(filepath, *, exclude_subject_info=False):
            write_root(filepath, EXCLUDED_ROOT)
            return Path(filepath)

        written = self.write(writer)
        self.assertEqual(written, self.store)
        self.assertIsInstance(written, str)

    def test_a_writer_without_the_option_writes_nothing(self):
        # What a pool worker holding a pre-1.2.11 biosigIO would call.
        def old_writer(filepath, **kwargs):
            write_root(filepath, {})
            return filepath

        with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable) as caught:
            self.write(old_writer)
        self.assertFalse(os.path.exists(self.store), "refused BEFORE the write")
        self.assertIn("exclude_subject_info", str(caught.exception))
        # Uncoded on purpose: a property of the node, so the recording is
        # retried as pending rather than failed as data.
        self.assertIsNone(getattr(caught.exception, "code", None))

    def test_a_writer_that_reports_another_path_is_refused(self):
        # The store the writer vouches for is not the one that would be
        # uploaded, so its mark proves nothing about what is published.
        elsewhere = os.path.join(self._tmp.name, "elsewhere.zarr")

        def writer(filepath, *, exclude_subject_info=False):
            write_root(elsewhere, EXCLUDED_ROOT)
            return elsewhere

        with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable) as caught:
            self.write(writer)
        self.assertIn("not " + self.store, str(caught.exception))

    def test_a_store_without_the_mark_is_refused(self):
        def ignoring_writer(filepath, *, exclude_subject_info=False):
            write_root(filepath, {"recording_metadata": {}})
            return filepath

        with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable):
            self.write(ignoring_writer)

    def test_only_a_true_mark_counts(self):
        for mark in (False, "true", 1, None):
            with self.subTest(mark=mark):
                shutil.rmtree(self.store, ignore_errors=True)

                def writer(filepath, *, exclude_subject_info=False, mark=mark):
                    write_root(filepath, {**EXCLUDED_ROOT, "subject_info_excluded": mark})
                    return filepath

                with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable):
                    self.write(writer)

    @_requires_biosigio_strip
    def test_a_marked_store_that_still_carries_a_member_is_refused(self):
        # The mark is biosigIO's claim; the content check is biosigIO's own list
        # applied to what is actually there, at any depth.
        for rec_meta in ({"patientcode": "x", "number_of_signals": 4},
                         {"recording_info": {"Sex": "x"}, "number_of_signals": 4}):
            with self.subTest(sorted(member_names(rec_meta))):
                shutil.rmtree(self.store, ignore_errors=True)

                def writer(filepath, *, exclude_subject_info=False, rec_meta=rec_meta):
                    write_root(filepath, {"subject_info_excluded": True,
                                          "recording_metadata": rec_meta})
                    return filepath

                with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable):
                    self.write(writer)

    def test_a_root_without_recording_metadata_is_refused(self):
        def writer(filepath, *, exclude_subject_info=False):
            write_root(filepath, {"subject_info_excluded": True})
            return filepath

        with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable):
            self.write(writer)

    def test_a_missing_root_is_refused(self):
        with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable):
            self.write(_writer_with_option)

    def test_a_writer_that_returns_no_path_is_refused(self):
        def writer(filepath, *, exclude_subject_info=False):
            write_root(filepath, EXCLUDED_ROOT)

        with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable):
            self.write(writer)

    def test_the_caller_cannot_turn_it_off(self):
        with self.assertRaises(TypeError) as caught:
            self.write(self.honoring_writer, exclude_subject_info=False)
        self.assertEqual(
            str(caught.exception),
            "write_store sets exclude_subject_info itself; do not pass it",
        )
        self.assertEqual(self.calls, [])


class TestReadBackWhenStripUnavailable(unittest.TestCase):
    """The read-back cannot check content without biosigIO's
    `strip_subject_info`, and must then refuse a store that otherwise passes.
    Run in a separate process against a stand-in `biosigio` that has none, so
    the result does not depend on what this interpreter has installed."""

    def test_a_marked_store_is_refused_when_its_content_cannot_be_checked(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            write_root(store, EXCLUDED_ROOT)
            os.makedirs(os.path.join(d, "standin", "biosigio"))
            with open(os.path.join(d, "standin", "biosigio", "__init__.py"), "w") as fh:
                fh.write('__version__ = "1.2.11"\n')
            proc = subprocess.run(
                [sys.executable, "-c",
                 "import sys; sys.path.insert(0, sys.argv[1]); import generate_zarr as g\n"
                 "try:\n    g.require_subject_info_excluded(sys.argv[2])\n"
                 "except g.SubjectInfoExclusionUnavailable as exc:\n"
                 "    print('REFUSED', exc); sys.exit(0)\n"
                 "print('ACCEPTED'); sys.exit(1)\n",
                 os.path.dirname(os.path.abspath(generate_zarr.__file__)), store],
                env={**os.environ, "PYTHONPATH": os.path.join(d, "standin")},
                capture_output=True, text=True, timeout=60, check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("strip_subject_info is unavailable", proc.stdout)


class TestSyncStore(unittest.TestCase):
    """`sync_store`, the one upload, re-checks the bytes it uploads. A logging
    `aws` stand-in records each call's arguments, one tab-separated line per
    call, so an argument holding a space stays one argument."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = os.path.join(self._tmp.name, "rec.zarr")
        self.log = os.path.join(self._tmp.name, "aws.log")
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(
                "#!/bin/sh\n"
                f'{{ for a in "$@"; do printf \'%s\\t\' "$a"; done; printf \'\\n\'; }} >> "{self.log}"\n'
                "exit 0\n"
            )
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)

    def calls(self) -> list[list[str]]:
        if not os.path.exists(self.log):
            return []
        with open(self.log) as fh:
            return [line.rstrip("\t").split("\t") for line in fh.read().splitlines()]

    def test_a_store_that_lost_its_mark_is_not_uploaded(self):
        # As a later rewrite of the root would leave it.
        write_root(self.store, {"recording_metadata": {"number_of_signals": 4}})
        with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable):
            generate_zarr.sync_store(self.store, "s3://nemar-test/nm000186/zarr/rec.zarr")
        self.assertEqual(self.calls(), [])

    @_requires_biosigio_strip
    def test_a_store_that_gained_a_member_is_not_uploaded(self):
        write_root(self.store, {"subject_info_excluded": True,
                                "recording_metadata": {"gender": "x"}})
        with self.assertRaises(generate_zarr.SubjectInfoExclusionUnavailable):
            generate_zarr.sync_store(self.store, "s3://nemar-test/nm000186/zarr/rec.zarr")
        self.assertEqual(self.calls(), [])

    @_requires_biosigio_strip
    def test_a_clean_store_is_uploaded_with_the_full_sync_vector(self):
        # Every flag pinned: `--delete` is what makes the bucket copy exactly the
        # converted store (ADR 0023 relies on it), and the cache lifetime is what
        # the CDN purge in the callback is sized against.
        write_root(self.store, EXCLUDED_ROOT)
        prefix = "s3://nemar-test/nm000186/zarr/rec.zarr"
        generate_zarr.sync_store(self.store, prefix)
        self.assertEqual(self.calls(), [[
            "s3", "sync", self.store, prefix,
            "--delete", "--only-show-errors",
            "--cache-control", "public, max-age=86400",
            *_AWS_TIMEOUTS,
        ]])


def aws_sync_builders(source: str) -> list[tuple[int, str]]:
    """Every place Python source builds an `aws s3 sync` command, as
    `(line, enclosing function)`: a list or tuple literal holding the elements
    "s3" and "sync", or a string that starts with "aws s3 sync" (a shell
    command). Prose that merely mentions the command is not matched."""
    import ast

    found: list[tuple[int, str]] = []

    def visit(node: ast.AST, function: str) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function = node.name
        if isinstance(node, (ast.List, ast.Tuple)):
            words = {e.value for e in node.elts if isinstance(e, ast.Constant)}
            if {"s3", "sync"} <= words:
                found.append((node.lineno, function))
        elif (isinstance(node, ast.Constant) and isinstance(node.value, str)
              and node.value.lstrip().startswith("aws s3 sync")):
            found.append((node.lineno, function))
        for child in ast.iter_child_nodes(node):
            visit(child, function)

    visit(ast.parse(source), "<module>")
    return found


class TestOnlySyncStoreUploadsAStore(unittest.TestCase):
    """`sync_store` re-checks a store for subject information on the bytes it
    uploads, which only protects anything if it is the ONLY way a store is
    uploaded. These scan the scripts for an `aws s3 sync` built anywhere else,
    and check that `convert_one` uploads through it. No code is run."""

    SCRIPTS = Path(__file__).resolve().parent.parent

    def test_no_script_builds_a_sync_outside_sync_store(self):
        builders = {}
        for path in sorted(self.SCRIPTS.rglob("*.py")):
            if path.name.startswith("test_"):
                continue
            found = aws_sync_builders(path.read_text(encoding="utf-8"))
            if found:
                builders[str(path.relative_to(self.SCRIPTS))] = sorted(f for _, f in found)
        self.assertEqual(builders, {"zarr/generate_zarr.py": ["sync_store"]})

    def test_convert_one_uploads_through_sync_store(self):
        import ast

        tree = ast.parse(Path(generate_zarr.__file__).read_text(encoding="utf-8"))
        (convert_one_def,) = [
            n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "convert_one"
        ]
        calls = [
            n for n in ast.walk(convert_one_def)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "sync_store"
        ]
        self.assertEqual(len(calls), 1)

    def test_the_scan_sees_every_shape(self):
        found = aws_sync_builders(
            "def a():\n"
            "    _aws(['aws', 's3', 'sync', src, dst])\n"
            "def b():\n"
            "    subprocess.run(('aws', 's3', 'sync', src, dst))\n"
            "def c():\n"
            "    subprocess.run('aws s3 sync ' + src + ' ' + dst, shell=True)\n"
            "CMD = ['s3', 'sync']\n"
            "def d():\n"
            "    '''Uploads with `aws s3 sync --delete`.'''\n"
            "    _aws(['aws', 's3', 'cp', src, dst])\n"
        )
        self.assertEqual(found, [(2, "a"), (4, "b"), (6, "c"), (7, "<module>")])


# The biosigIO store writers, by how a reference reaches them: an attribute
# (`rec.to_zarr`, `biosigio.stream_to_zarr`, `module.ZarrExporter`), a bare
# name (`stream_to_zarr`, `ZarrExporter`), a name bound by an aliased import
# (`from biosigio import stream_to_zarr as s2z`), or a string equal to a writer's
# name, which is how `getattr`, `__dict__[...]`, `__getattribute__`,
# `operator.attrgetter` and `operator.methodcaller` reach one. A name computed at
# run time (`"to_" + "zarr"`) is out of reach of any static scan.
_WRITER_ATTRS = frozenset({"to_zarr", "stream_to_zarr", "ZarrExporter"})
_WRITER_NAMES = frozenset({"stream_to_zarr", "ZarrExporter"})
# What generate_zarr.py, and only generate_zarr.py, may hold by name: the one
# function that looks writers up to INSPECT them for the startup check (it never
# calls one), and the tuple naming them.
_WRITER_INSPECTOR = "biosigio_subject_info_problems"
_WRITER_NAMES_CONSTANT = "BIOSIGIO_STORE_WRITERS"


def writer_references(
    source: str, *, inspector_allowed: bool = False
) -> tuple[list[str], set[str]]:
    """Scan Python source for biosigIO store writers. Returns the references
    that are NOT the first argument of a `write_store(...)` call, as
    `line:name`, and the names that are. `inspector_allowed` is for
    generate_zarr.py alone: it exempts `biosigio_subject_info_problems` and the
    `BIOSIGIO_STORE_WRITERS` tuple there, and nowhere else."""
    import ast

    tree = ast.parse(source)
    allowed: set[int] = set()
    exempt: set[int] = set()
    through_write_store: set[str] = set()
    for node in ast.walk(tree):
        if inspector_allowed and (
            (isinstance(node, ast.FunctionDef) and node.name == _WRITER_INSPECTOR)
            or (isinstance(node, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == _WRITER_NAMES_CONSTANT
                        for t in node.targets))
        ):
            exempt |= {id(inner) for inner in ast.walk(node)}
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        callee = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if callee == "write_store":
            for inner in ast.walk(node.args[0]):
                allowed.add(id(inner))
    stray: list[str] = []
    aliases: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name in _WRITER_NAMES and alias.asname:
                    # Rebinding a writer under another name hides every later
                    # use of it from the name and attribute rules below.
                    stray.append(f"{node.lineno}:{alias.name} as {alias.asname}")
                    aliases.add(alias.asname)
    for node in ast.walk(tree):
        if id(node) in exempt:
            continue
        if isinstance(node, ast.Attribute) and node.attr in _WRITER_ATTRS:
            name = node.attr
        elif isinstance(node, ast.Name) and (node.id in _WRITER_NAMES or node.id in aliases):
            name = node.id
        elif isinstance(node, ast.Constant) and node.value in _WRITER_ATTRS:
            name = repr(node.value)
        else:
            continue
        if id(node) in allowed:
            through_write_store.add(name)
        else:
            stray.append(f"{node.lineno}:{name}")
    return stray, through_write_store


class TestEveryStoreWriteExcludesSubjectInfo(unittest.TestCase):
    """No script writes a store except through `write_store`. A new direct call
    (`rec.to_zarr(...)`, `stream_to_zarr(...)`, `ZarrExporter.export(...)`), a
    writer bound to another name, imported under an alias, or reached through a
    string holding its name fails here. Test files are exempt: they build
    fixture stores, which are never served."""

    SCRIPTS = Path(__file__).resolve().parent.parent
    CONVERTER = Path(generate_zarr.__file__).resolve()

    def test_no_script_references_a_writer_outside_write_store(self):
        offenders = {}
        for path in sorted(self.SCRIPTS.rglob("*.py")):
            if path.name.startswith("test_"):
                continue
            stray, _ = writer_references(
                path.read_text(encoding="utf-8"),
                inspector_allowed=path.resolve() == self.CONVERTER,
            )
            if stray:
                offenders[str(path.relative_to(self.SCRIPTS))] = stray
        self.assertEqual(offenders, {}, "write a store through generate_zarr.write_store")

    def test_both_exporters_go_through_write_store(self):
        # The positive control: the scan finds the two real call sites, so an
        # empty offender list above is not a scan that sees nothing.
        _, through = writer_references(
            self.CONVERTER.read_text(encoding="utf-8"), inspector_allowed=True
        )
        self.assertEqual(through, {"to_zarr", "stream_to_zarr"})

    def test_the_converter_is_clean_only_because_of_its_exemption(self):
        # And the exemption is what admits the inspector: without it the same
        # file is flagged, so the exemption is doing work and is scoped.
        stray, _ = writer_references(self.CONVERTER.read_text(encoding="utf-8"))
        self.assertTrue(stray)

    def test_the_scan_catches_every_shape_of_direct_use(self):
        stray, through = writer_references(
            "rec.to_zarr(path)\n"
            "stream_to_zarr(src, path)\n"
            "ZarrExporter.export(rec, path)\n"
            "write = rec.to_zarr\n"
            "biosigio.stream_to_zarr(src, path, exclude_subject_info=True)\n"
            "write_store(rec.to_zarr, path)\n"
            "from biosigio import stream_to_zarr as s2z\n"
            "s2z(src, path)\n"
            "from biosigio.exporters.zarr import ZarrExporter as ZE\n"
            "getattr(rec, 'to_zarr')(path)\n"
            "getattr(importlib.import_module('biosigio'), 'stream_to_zarr')(src, path)\n"
            "m.__dict__['stream_to_zarr'](src, path)\n"
            "operator.attrgetter('to_zarr')(rec)(path)\n"
            "rec.__getattribute__('to_zarr')(path)\n"
            "operator.methodcaller('to_zarr', path)(rec)\n"
            "def biosigio_subject_info_problems():\n"
            "    return getattr(rec, 'to_zarr', None)\n"
            "BIOSIGIO_STORE_WRITERS = ('stream_to_zarr',)\n"
        )
        self.assertEqual(
            sorted(stray, key=lambda s: int(s.split(":")[0])),
            ["1:to_zarr", "2:stream_to_zarr", "3:ZarrExporter", "4:to_zarr",
             "5:stream_to_zarr", "7:stream_to_zarr as s2z", "8:s2z",
             "9:ZarrExporter as ZE", "10:'to_zarr'", "11:'stream_to_zarr'",
             "12:'stream_to_zarr'", "13:'to_zarr'", "14:'to_zarr'", "15:'to_zarr'",
             # Outside generate_zarr.py the inspector's name and the tuple's
             # name buy nothing.
             "17:'to_zarr'", "18:'stream_to_zarr'"],
        )
        self.assertEqual(through, {"to_zarr"})


class TestFixSourceFileAttrAfterExclusion(unittest.TestCase):
    """With `exclude_subject_info`, biosigIO leaves only the scratch file's
    NAME in `source_file`; the converter still replaces it with the BIDS path,
    and the rewrite keeps the mark."""

    def test_the_bids_path_replaces_the_name_and_the_mark_survives(self):
        for written in ("sub-01_task-rest_eeg.edf", "sss_sub-01_task-rest_meg.fif"):
            with self.subTest(written), tempfile.TemporaryDirectory() as d:
                with open(os.path.join(d, "zarr.json"), "w") as fh:
                    json.dump({"zarr_format": 3, "node_type": "group", "attributes": {
                        "subject_info_excluded": True,
                        "recording_metadata": {"source_file": written, "number_of_signals": 4},
                    }}, fh)
                fix_source_file_attr(d, "sub-01/eeg/sub-01_task-rest_eeg.edf")
                with open(os.path.join(d, "zarr.json")) as fh:
                    attrs = json.load(fh)["attributes"]
                self.assertEqual(
                    attrs["recording_metadata"]["source_file"],
                    "sub-01/eeg/sub-01_task-rest_eeg.edf",
                )
                self.assertIs(attrs["subject_info_excluded"], True)
                self.assertEqual(attrs["recording_metadata"]["number_of_signals"], 4)


class TestTheInstalledBiosigioExcludesSubjectInfo(unittest.TestCase):
    """The check against the REAL biosigIO this suite runs with. In the job
    with the real stack installed (requirements.txt) it must pass."""

    @classmethod
    def setUpClass(cls):
        try:
            import biosigio  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def test_the_check_passes(self):
        self.assertEqual(generate_zarr.biosigio_subject_info_problems(), [])

    def test_the_mark_is_the_one_biosigio_writes(self):
        import biosigio

        self.assertEqual(generate_zarr.SUBJECT_INFO_EXCLUDED_ATTR, biosigio.SUBJECT_INFO_EXCLUDED_ATTR)


class TestSubjectInfoNeverReachesAStore(unittest.TestCase):
    """A REAL EDF+ whose header carries every patient and recording field,
    through `convert_one`, on both exporters. `aws` is a stand-in that logs
    every call and copies a synced store aside so the test can open what would
    have been uploaded; nothing else is substituted.

    The file repeats a label and has a channels.tsv, so the two members the
    converter reads back from `recording_metadata` (`channels_tsv_units` and
    `channel_labels_deduplicated`) are present to be checked; and it has a
    PowerLineFrequency sidecar and electrodes, so the converter rewrites the
    root (`embed_root_attr`) after biosigIO wrote it, before the upload."""

    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.edf"
    TSV = "sub-01/eeg/sub-01_task-rest_channels.tsv"
    SIDECAR = "sub-01/eeg/sub-01_task-rest_eeg.json"
    ELECTRODES = "sub-01/eeg/sub-01_electrodes.tsv"
    COORDSYSTEM = "sub-01/eeg/sub-01_coordsystem.json"
    LABELS = ("E1", "E2", "E2", "E3")
    SUFFIXED = ("E1", "E2-0", "E2-1", "E3")
    # The synthetic header values `build_edf_with_subject_header` writes, by the
    # field that carries each. Only ever searched for, never printed.
    HEADER_VALUES: ClassVar[dict[str, str]] = {
        "patientcode": "SUBJ-0042", "patientname": "Test_Person",
        "patient_additional": "left_handed", "admincode": "ADM-7",
        "technician": "Operator_A", "equipment": "Amplifier_1000",
        "recording_additional": "pilot_session", "birthdate": "1970",
    }

    @classmethod
    def setUpClass(cls):
        try:
            import biosigio
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        if not hasattr(biosigio, "SUBJECT_INFO_KEYS"):
            raise unittest.SkipTest(
                f"biosigio {biosigio.__version__} predates exclude_subject_info (1.2.11)"
            )

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        os.makedirs(os.path.join(self.repo, "sub-01", "eeg"))
        self.edf = build_edf_with_subject_header(
            os.path.join(self.repo, self.PRIMARY), list(self.LABELS)
        )
        self.write(self.TSV, "name\ttype\tunits\n"
                   + "".join(f"{n}\tEEG\tuV\n" for n in self.SUFFIXED))
        self.write(self.SIDECAR, json.dumps({"PowerLineFrequency": 60}))
        # Named by the file's own labels, so the converter has to carry E2's
        # position to both de-duplicated channels (`label_renames`).
        self.write(self.ELECTRODES, "name\tx\ty\tz\n"
                   + "".join(f"{n}\t{i}.0\t0.0\t0.0\n"
                             for i, n in enumerate(("E1", "E2", "E3"))))
        self.write(self.COORDSYSTEM, json.dumps(
            {"EEGCoordinateSystem": "CapTrak", "EEGCoordinateUnits": "mm"}
        ))
        self.synced_dir = os.path.join(self._tmp.name, "synced")
        self.aws_log = os.path.join(self._tmp.name, "aws.log")
        bindir = os.path.join(self._tmp.name, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(
                "#!/bin/sh\n"
                f'echo "$@" >> "{self.aws_log}"\n'
                'if [ "$1" = s3 ] && [ "$2" = sync ]; then\n'
                f'  mkdir -p "{self.synced_dir}" && cp -R "$3" "{self.synced_dir}/"\n'
                "fi\nexit 0\n"
            )
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)
        saved_ctx = dict(generate_zarr._CTX)
        self.addCleanup(lambda: (generate_zarr._CTX.clear(), generate_zarr._CTX.update(saved_ctx)))
        saved_min = generate_zarr.STREAM_EDF_MIN_BYTES
        self.addCleanup(setattr, generate_zarr, "STREAM_EDF_MIN_BYTES", saved_min)

    def write(self, rel: str, text: str) -> None:
        with open(os.path.join(self.repo, rel), "w") as fh:
            fh.write(text)

    def convert(self) -> dict:
        work = os.path.join(self._tmp.name, "work")
        os.makedirs(work, exist_ok=True)
        shutil.rmtree(self.synced_dir, ignore_errors=True)
        if os.path.exists(self.aws_log):
            os.unlink(self.aws_log)
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "nm000186",
            "head": "d" * 40,
            "head_files": {self.PRIMARY, self.TSV, self.SIDECAR, self.ELECTRODES,
                           self.COORDSYSTEM},
            "local": True, "tmp": work, "updated": "2026-10-05T00:00:00Z",
            "contract_base": "https://zarr.nemar.org", "engine_version": ZARR_ENGINE_VERSION,
            "dataset_row": None, "provenance_fetch_failed": False,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        with contextlib.redirect_stdout(io.StringIO()):
            return convert_one(self.PRIMARY)

    def aws_calls(self) -> list[str]:
        if not os.path.exists(self.aws_log):
            return []
        with open(self.aws_log) as fh:
            return fh.read().splitlines()

    def synced_store(self, entry: dict) -> str:
        return os.path.join(self.synced_dir, os.path.basename(entry["zarr"]))

    def synced_nodes(self, entry: dict) -> dict[str, dict]:
        """Every node's attributes in the store that would have been uploaded,
        keyed by its path inside the store."""
        nodes = {}
        for dirpath, _dirs, files in os.walk(self.synced_store(entry)):
            if "zarr.json" in files:
                with open(os.path.join(dirpath, "zarr.json")) as fh:
                    nodes[os.path.relpath(dirpath, self.synced_store(entry))] = (
                        json.load(fh).get("attributes") or {}
                    )
        return nodes

    def test_the_fixture_carries_subject_members_and_biosigios_default_keeps_them(self):
        # The control. Without it the store assertions below could pass because
        # the header was never written, not because the converter left it out.
        from biosigio import Recording, is_subject_info_key

        rec = Recording.from_file(self.edf)
        self.assertEqual(
            {n for n in member_names(rec.metadata) if is_subject_info_key(n)},
            EDF_HEADER_SUBJECT_MEMBERS,
        )
        # And a store written WITHOUT the option still carries every one, which
        # is what `write_store` exists to prevent; the value scan below finds them.
        store = rec.to_zarr(os.path.join(self._tmp.name, "default.zarr"), dtype="int16")
        with open(os.path.join(store, "zarr.json")) as fh:
            text = fh.read()
        attrs = json.loads(text)["attributes"]
        self.assertNotIn("subject_info_excluded", attrs)
        self.assertLessEqual(EDF_HEADER_SUBJECT_MEMBERS, member_names(attrs["recording_metadata"]))
        self.assertTrue(any(value in text for value in self.HEADER_VALUES.values()))

    def test_no_store_carries_a_subject_member_on_either_exporter(self):
        from biosigio import SUBJECT_INFO_KEYS, is_subject_info_key

        for path_name, threshold in (("in-memory", generate_zarr.STREAM_EDF_MIN_BYTES),
                                     ("streaming", 1)):
            with self.subTest(path_name):
                generate_zarr.STREAM_EDF_MIN_BYTES = threshold
                result = self.convert()
                self.assertTrue(result["ok"], result.get("error"))
                entry = result["entry"]
                nodes = self.synced_nodes(entry)
                root = nodes["."]

                self.assertIs(root.get("subject_info_excluded"), True)
                rec_meta = root["recording_metadata"]
                names = member_names(rec_meta)
                self.assertEqual({n for n in names if is_subject_info_key(n)}, set())
                self.assertEqual(names & SUBJECT_INFO_KEYS, set())
                # Nor anywhere else in the store, at any node.
                for node, attrs in nodes.items():
                    found = sorted(n for n in member_names(attrs) if is_subject_info_key(n))
                    self.assertEqual(found, [], node)
                # And no header VALUE survives under some other name: a boolean
                # per field, so a failure names the field and never the value.
                texts = []
                for dirpath, _dirs, files in os.walk(self.synced_store(entry)):
                    if "zarr.json" in files:
                        with open(os.path.join(dirpath, "zarr.json")) as fh:
                            texts.append(fh.read())
                for field, value in self.HEADER_VALUES.items():
                    self.assertFalse(any(value in t for t in texts), f"{field} value present")

                # The technical members stay, including the two the converter
                # reads back: `channel_labels_deduplicated` (label_renames) and
                # `channels_tsv_units` (store_metadata, root or recording_metadata).
                self.assertLessEqual(
                    {"source_file", "number_of_signals", "channel_labels_deduplicated"}, names
                )
                if path_name == "in-memory":
                    self.assertLessEqual(
                        {"startdate", "filetype", "file_duration", "datarecord_duration",
                         "source_format", "channels_tsv_units"},
                        names,
                    )
                else:
                    self.assertIn("streamed", names)
                    self.assertIn("channels_tsv_units", root)
                # And the readers still find them: the index entry carries the
                # sidecar report, and every channel under its suffixed label.
                self.assertIn("units_report", entry)
                self.assertEqual(entry["units_report"]["unmatched_channels"], 0)
                self.assertEqual(store_total_channels(entry), len(self.LABELS))

                # The converter's own rewrites of the root ran after biosigIO
                # wrote it, and the mark (checked above, on the uploaded copy)
                # survived them: the sidecar's frequency, and electrode
                # positions carried to the de-duplicated labels.
                self.assertEqual(root["power_line_frequency"], 60)
                self.assertEqual(
                    set(root["electrode_positions"]), {"E1", "E2", "E2-0", "E2-1", "E3"}
                )
                self.assertIn("nemar", root)

                # biosigIO left the scratch file's name; the converter's rewrite
                # puts back the BIDS path the index keys this store by.
                self.assertEqual(rec_meta["source_file"], self.PRIMARY)

                index = merge_index(
                    None, "nm000186", "d" * 40, [entry], [], "2026-10-05T00:00:00Z",
                    [], [], discovered=[self.PRIMARY],
                )
                check_index_invariant(index)
                validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_worker_with_a_pre_option_writer_writes_and_uploads_nothing(self):
        """A pool worker that holds biosigIO 1.2.10's writers: the real ones,
        wrapped in the signature 1.2.10 had, which collects unknown keywords and
        so would drop the option. The recording is refused, uncoded (pending,
        retried), and nothing is synced."""
        import biosigio

        real_to_zarr = biosigio.Recording.to_zarr
        real_stream = biosigio.stream_to_zarr

        def to_zarr_1_2_10(rec, filepath, **kwargs):
            kwargs.pop("exclude_subject_info", None)
            return real_to_zarr(rec, filepath, **kwargs)

        def stream_to_zarr_1_2_10(filepath, store_path, **kwargs):
            kwargs.pop("exclude_subject_info", None)
            return real_stream(filepath, store_path, **kwargs)

        self.addCleanup(setattr, biosigio.Recording, "to_zarr", real_to_zarr)
        self.addCleanup(setattr, biosigio, "stream_to_zarr", real_stream)
        biosigio.Recording.to_zarr = to_zarr_1_2_10
        biosigio.stream_to_zarr = stream_to_zarr_1_2_10

        for path_name, threshold in (("in-memory", generate_zarr.STREAM_EDF_MIN_BYTES),
                                     ("streaming", 1)):
            with self.subTest(path_name):
                generate_zarr.STREAM_EDF_MIN_BYTES = threshold
                result = self.convert()
                self.assertIs(result["ok"], False)
                self.assertIsNone(result["code"])
                self.assertIn("exclude_subject_info", result["error"])
                self.assertEqual([c for c in self.aws_calls() if c.startswith("s3 sync")], [])
                self.assertFalse(os.path.exists(self.synced_dir))


# A stand-in biosigIO package, on disk and importable, that is only what the
# subject-information check reads: a version, a distribution record, and the
# three writers' signatures. It cannot convert, and is not meant to.
# Placeholders are replaced with str.replace, not str.format, so the source can
# hold braces.
_STANDIN_INIT = '''\
import json
import os

__version__ = __VERSION__
# "read_nothing": every read raises. "unmarked": a recording reads, and its
# writer names exclude_subject_info but ignores it, as a build whose version
# outran its code would, so the root it writes carries no mark; a path
# naming sub-02 still raises, for a run that mixes the two failures.
_MODE = __MODE__


class Recording:
    def __init__(self):
        self.channels = {"E1": {}}
        self.metadata = {}

    @classmethod
    def from_file(cls, filepath, **kwargs):
        if _MODE == "unmarked" and "sub-02" not in filepath:
            return cls()
        raise RuntimeError("stand-in biosigIO reads nothing")

    def to_zarr(self, filepath, __TO_ZARR__**kwargs):
        os.makedirs(filepath, exist_ok=True)
        with open(os.path.join(filepath, "zarr.json"), "w") as fh:
            json.dump({"zarr_format": 3, "node_type": "group",
                       "attributes": {"recording_metadata": {}}}, fh)
        return filepath


def stream_to_zarr(filepath, store_path, *, dtype="int16", __STREAM__**kwargs):
    raise RuntimeError("stand-in biosigIO writes nothing")


def strip_subject_info(metadata):
    return dict(metadata)
'''
_STANDIN_BIDS = '''\
def apply_events_tsv(rec, path):
    return rec


def read_events_tsv(path):
    return None
'''
_STANDIN_EXPORTER = '''\
class ZarrExporter:
    @staticmethod
    def export(rec, filepath, *, dtype="int16", __EXPORT__**kwargs):
        raise RuntimeError("stand-in biosigIO writes nothing")
'''
# An install whose Zarr exporter cannot be imported (the [zarr] extra missing,
# say): the package imports, the writer module does not.
_STANDIN_BROKEN_EXPORTER = 'raise ImportError("stand-in: no module named zarr")\n'

# aws calls that write, delete or list (the `--wipe` probe) in the serving
# bucket. A refused run makes none of them.
_MUTATING_AWS = {("s3", "sync"), ("s3", "rm"), ("s3", "mv"), ("s3", "ls"),
                 ("s3api", "put-object"), ("s3api", "delete-object"),
                 ("s3api", "delete-objects"), ("s3api", "list-objects"),
                 ("s3api", "list-objects-v2")}


def mutating_aws_calls(calls: list[str]) -> list[str]:
    out = []
    for call in calls:
        words = call.split()
        if tuple(words[:2]) in _MUTATING_AWS:
            out.append(call)
        elif words[:2] == ["s3", "cp"] and words[-1].startswith("s3://"):
            out.append(call)  # an upload
    return out


class TestMainRefusesWithoutSubjectInfoExclusion(unittest.TestCase):
    """`main` against a stand-in biosigIO, as a separate process so that
    `import biosigio` really resolves to it (PYTHONPATH, ahead of any installed
    copy). A dataset with one recording, `--wipe` included: the refusal must
    come before anything is converted and before the serving prefix is erased.
    The `aws` stand-in is the real-file one, logging every call."""

    PRIMARY = "sub-01/eeg/sub-01_task-rest_eeg.edf"
    SECOND = "sub-02/eeg/sub-02_task-rest_eeg.edf"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        self.aws_log = os.path.join(self.dir, "aws.log")
        self.callback = os.path.join(self.dir, "cb.json")
        os.makedirs(self.s3)
        os.makedirs(self.repo)
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        self.env = {
            **os.environ,
            "PATH": bindir + os.pathsep + os.environ.get("PATH", ""),
            "ZARR_TEST_S3_ROOT": self.s3,
            "ZARR_TEST_S3_LOG": self.aws_log,
        }

    def commit(self, with_recording: bool, second_recording: bool = False) -> None:
        def git(*args):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.org")
        git("config", "user.name", "t")
        with open(os.path.join(self.repo, "dataset_description.json"), "w") as fh:
            json.dump({"Name": "subject-info fixture", "BIDSVersion": "1.8.0"}, fh)
        if with_recording:
            os.makedirs(os.path.join(self.repo, "sub-01", "eeg"))
            # Never read: the refusal comes first, and in the control the
            # stand-in fails the import before any reader runs.
            with open(os.path.join(self.repo, self.PRIMARY), "wb") as fh:
                fh.write(b"0" * 256)
        if second_recording:
            os.makedirs(os.path.join(self.repo, "sub-02", "eeg"))
            with open(os.path.join(self.repo, self.SECOND), "wb") as fh:
                fh.write(b"0" * 256)
        git("add", "-A")
        git("commit", "-q", "-m", "init")

    def standin(self, version: str = "1.2.13", dist_version: str | None = None,
                lacking: str | None = None, exporter_imports: bool = True,
                mode: str = "read_nothing") -> str:
        """Write the stand-in package; `lacking` names the one writer that does
        not take the option, as biosigIO's writers did before 1.2.11."""
        root = os.path.join(self.dir, "standin")
        shutil.rmtree(root, ignore_errors=True)
        pkg = os.path.join(root, "biosigio")
        os.makedirs(os.path.join(pkg, "exporters"))

        def option(name):
            return "" if name == lacking else "exclude_subject_info=False, "

        with open(os.path.join(pkg, "__init__.py"), "w") as fh:
            fh.write(
                _STANDIN_INIT.replace("__VERSION__", repr(version))
                .replace("__MODE__", repr(mode))
                .replace("__TO_ZARR__", option("Recording.to_zarr"))
                .replace("__STREAM__", option("stream_to_zarr"))
            )
        with open(os.path.join(pkg, "bids.py"), "w") as fh:
            fh.write(_STANDIN_BIDS)
        with open(os.path.join(pkg, "exporters", "__init__.py"), "w") as fh:
            fh.write("")
        with open(os.path.join(pkg, "exporters", "zarr.py"), "w") as fh:
            fh.write(
                _STANDIN_EXPORTER.replace("__EXPORT__", option("ZarrExporter.export"))
                if exporter_imports else _STANDIN_BROKEN_EXPORTER
            )
        dist = os.path.join(root, f"biosigio-{dist_version or version}.dist-info")
        os.makedirs(dist)
        with open(os.path.join(dist, "METADATA"), "w") as fh:
            fh.write(f"Metadata-Version: 2.1\nName: biosigio\nVersion: {dist_version or version}\n")
        return root

    def run_main(self, standin: str, *extra: str) -> tuple[int, str]:
        if os.path.exists(self.aws_log):
            os.unlink(self.aws_log)
        proc = subprocess.run(
            [sys.executable, generate_zarr.__file__,
             "--dataset-id", "on008083", "--repo-dir", self.repo,
             "--bucket", "nemar-test", "--callback-out", self.callback,
             "--local", "--clean", "--api-base", "http://127.0.0.1:9", *extra],
            env={**self.env, "PYTHONPATH": standin},
            capture_output=True, text=True, timeout=120, check=False,
        )
        return proc.returncode, proc.stdout + proc.stderr

    def callback_body(self) -> dict:
        with open(self.callback) as fh:
            return json.load(fh)

    def aws_calls(self) -> list[str]:
        if not os.path.exists(self.aws_log):
            return []
        with open(self.aws_log) as fh:
            return fh.read().splitlines()

    def assert_refused(self, rc: int, log: str, why: str) -> None:
        self.assertEqual(rc, 78, log)  # sysexits.h EX_CONFIG, which hallu-zarr.sh stops on
        self.assertIn(f"::error::{why}", log)
        body = self.callback_body()
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["converted"], [])
        self.assertFalse(body["deterministic"], "the node, not the dataset, is at fault")
        self.assertIn("does not meet the converter's floor", body["error"])
        self.assertEqual(body["discovered_count"], 1)
        self.assertEqual(body["pending_count"], 0, "nothing was attempted")
        # The prior index was read first, and nothing in the bucket was synced,
        # listed for the wipe, removed or written.
        calls = self.aws_calls()
        self.assertTrue(calls, "the run should have read the prior index first")
        self.assertEqual(mutating_aws_calls(calls), [])

    def test_the_mutating_call_filter_sees_what_it_must(self):
        self.assertEqual(mutating_aws_calls([
            "s3api get-object --bucket b --key k /tmp/x",
            "s3 cp s3://b/k -",
            "s3 sync /tmp/s s3://b/p --delete",
            "s3api list-objects-v2 --bucket b --prefix p",
            "s3 rm s3://b/p --recursive",
            "s3 cp /tmp/x s3://b/k",
            "s3api put-object --bucket b --key k --body /tmp/x",
        ]), [
            "s3 sync /tmp/s s3://b/p --delete",
            "s3api list-objects-v2 --bucket b --prefix p",
            "s3 rm s3://b/p --recursive",
            "s3 cp /tmp/x s3://b/k",
            "s3api put-object --bucket b --key k --body /tmp/x",
        ])

    def test_each_writer_without_the_option_is_refused(self):
        self.commit(with_recording=True)
        for name in generate_zarr.BIOSIGIO_STORE_WRITERS:
            with self.subTest(name):
                rc, log = self.run_main(self.standin(lacking=name), "--wipe")
                self.assert_refused(rc, log, f"biosigIO's {name} does not take exclude_subject_info")

    def test_a_release_below_the_floor_is_refused(self):
        self.commit(with_recording=True)
        rc, log = self.run_main(self.standin(version="1.2.12"), "--wipe")
        self.assert_refused(rc, log, "the installed biosigIO is 1.2.12, below 1.2.13")

    def test_a_stale_import_is_refused_although_the_installed_release_is_current(self):
        # The distribution record says 1.2.13; the module imported says 1.2.12.
        self.commit(with_recording=True)
        rc, log = self.run_main(self.standin(version="1.2.12", dist_version="1.2.13"), "--wipe")
        self.assert_refused(rc, log, "the imported biosigIO is 1.2.12, below 1.2.13")

    def test_an_installed_release_older_than_the_import_is_refused(self):
        # The other way round: the module says 1.2.13, but what the environment
        # records as installed is 1.2.12.
        self.commit(with_recording=True)
        rc, log = self.run_main(self.standin(version="1.2.13", dist_version="1.2.12"), "--wipe")
        self.assert_refused(rc, log, "the installed biosigIO is 1.2.12, below 1.2.13")

    def test_a_biosigio_whose_exporter_cannot_be_imported_is_refused(self):
        # Fail closed: a check that cannot look must refuse, not wave through.
        self.commit(with_recording=True)
        rc, log = self.run_main(self.standin(exporter_imports=False), "--wipe")
        self.assert_refused(rc, log, "biosigIO cannot be imported (ImportError")

    def test_a_capable_biosigio_gets_past_the_check(self):
        # The control. The stand-in cannot convert, so the run still fails, but
        # in the conversion and with the ordinary exit, not with the refusal.
        self.commit(with_recording=True)
        rc, log = self.run_main(self.standin())
        self.assertEqual(rc, 1, log)
        self.assertNotIn("does not meet the converter's floor", log)
        self.assertIn(f"conversion failed for {self.PRIMARY}", log)
        body = self.callback_body()
        self.assertNotIn("error", body)
        # The total failure's callback carries what the run measured: one
        # uncoded failure, pending and retryable, and the catalog read failed
        # (the closed port above).
        self.assertEqual((body["errors"], body["failed"]), (1, [self.PRIMARY]))
        self.assertEqual(body["pending_count"], 1)
        self.assertFalse(body["deterministic"])
        self.assertIs(body["provenance_fetch_failed"], True)

    def test_a_run_whose_workers_refuse_every_store_exits_78(self):
        # Past the startup check: the writers name the option, but the store
        # written comes back without the mark, so `write_store` refuses it in
        # the converting process. Every failure is that refusal, which is the
        # node's fault: exit 78 (the drain stops), not 1 (an attempt spent).
        self.commit(with_recording=True)
        rc, log = self.run_main(self.standin(mode="unmarked"))
        self.assertEqual(rc, 78, log)
        self.assertIn("::error::1 recording(s) refused at write or upload", log)
        body = self.callback_body()
        self.assertEqual(body["status"], "failed")
        self.assertIn("refused at write or upload", body["error"])
        self.assertEqual(body["pending_count"], 1)
        self.assertEqual(mutating_aws_calls(self.aws_calls()), [], "nothing uploaded")

    def test_a_run_that_also_fails_otherwise_takes_the_ordinary_exit(self):
        # One recording refused, one failing for an ordinary reason: not the
        # node alone, so the run is an ordinary total failure.
        self.commit(with_recording=True, second_recording=True)
        rc, log = self.run_main(self.standin(mode="unmarked"))
        self.assertEqual(rc, 1, log)
        self.assertNotIn("refused at write or upload", log)
        body = self.callback_body()
        self.assertNotIn("error", body)
        self.assertEqual(body["pending_count"], 2)

    def test_a_run_with_nothing_to_convert_is_not_held_up(self):
        # Nothing is written, so a node's biosigIO is no reason to refuse.
        self.commit(with_recording=False)
        rc, log = self.run_main(self.standin(lacking="stream_to_zarr"))
        self.assertEqual(rc, 0, log)
        self.assertNotIn("does not meet the converter's floor", log)


class TestFailedCallbackBody(unittest.TestCase):
    """`failed_callback_body`, every key, from a distinct non-default value
    for every field, so a field dropped or crossed with another shows."""

    FAILURES: ClassVar[list[dict[str, str]]] = [
        {"path": "sub-01/eeg/a_eeg.edf", "code": "corrupt_or_truncated"},
        {"path": "sub-01/eeg/b_eeg.edf", "code": "annex_object_missing"},
    ]

    def body(self, **overrides):
        fields: dict[str, Any] = {
            "dataset_id": "nm000186", "head": "e" * 40, "prior": {"store_count": 7},
            "discovered": ["a", "b", "c", "d"],
            "failures": ["sub-01/eeg/a_eeg.edf", "sub-01/eeg/b_eeg.edf"],
            "failure_entries": self.FAILURES,
            "annex_missing": [("sub-01/eeg/b_eeg.edf", "SHA256E-s1--b")],
            "pool_breaks": 3,
            "pending_entries": [{"path": "c", "reason": "infra_failure"},
                                {"path": "d", "reason": "not_attempted"},
                                {"path": "e", "reason": "not_attempted"}],
            # Six deferred recordings: both counts then differ from their
            # `pending_entries`-only values (3 and 2) and from every other
            # number in the body.
            "deferred": {f"f{i}": "deferred: needs 9 GiB of scratch, 1 GiB available"
                         for i in range(6)},
            "provenance_fetch_failed": True, "events_row_count": 11,
            "events_upload_failed": True, "events_stores_without_rows": 2,
            "error": "index refused: test",
        }
        fields.update(overrides)
        return generate_zarr.failed_callback_body(**fields)

    def test_every_key(self):
        self.assertEqual(self.body(), {
            "dataset_id": "nm000186",
            "status": "failed",
            "store_count": 7,
            "commit": "e" * 40,
            "converted": [],
            "removed": [],
            "errors": 2,
            "failed": ["sub-01/eeg/a_eeg.edf", "sub-01/eeg/b_eeg.edf"],
            "failure_count": 2,
            "data_failures": self.FAILURES,
            "deterministic": True,
            "annex_missing_count": 1,
            "annex_missing_first_path": "sub-01/eeg/b_eeg.edf",
            "annex_missing_first_key": "SHA256E-s1--b",
            "pool_breaks": 3,
            "pending_count": 9,
            "discovered_count": 4,
            "not_attempted_count": 8,
            "provenance_fetch_failed": True,
            "events_row_count": 11,
            "events_upload_failed": True,
            "events_stores_without_rows": 2,
            "error": "index refused: test",
        })

    def test_no_error_means_no_error_key(self):
        self.assertNotIn("error", self.body(error=None))

    def test_a_clean_run_has_no_prior_store_count(self):
        self.assertEqual(self.body(prior=None)["store_count"], 0)

    def test_every_field_is_required(self):
        # A caller that leaves one out fails, rather than reporting a zero it
        # never measured (the refactor once had defaults, and five dropped
        # fields went unnoticed by the whole suite).
        complete: dict[str, Any] = {
            "dataset_id": "x", "head": "h", "prior": None, "discovered": [], "failures": [],
            "failure_entries": [], "annex_missing": [], "pool_breaks": 0,
            "pending_entries": [], "deferred": {}, "provenance_fetch_failed": False,
            "events_row_count": None, "events_upload_failed": False,
            "events_stores_without_rows": 0, "error": None,
        }
        generate_zarr.failed_callback_body(**complete)
        for name in complete:
            with self.subTest(name), self.assertRaises(TypeError):
                generate_zarr.failed_callback_body(
                    **{k: v for k, v in complete.items() if k != name}
                )


class TestSubjectInfoRefusedRun(unittest.TestCase):
    """Which runs end with the node-level exit: every failure a refusal."""

    def test_the_verdict(self):
        verdict = generate_zarr.subject_info_refused_run
        self.assertFalse(verdict([], []), "no failure at all")
        self.assertTrue(verdict(["a"], ["a"]))
        self.assertTrue(verdict(["a", "b"], ["b", "a"]))
        self.assertFalse(verdict(["a", "b"], ["a"]), "one failure is something else")
        self.assertFalse(verdict(["a"], []))

if __name__ == "__main__":
    unittest.main()
