#!/usr/bin/env python3
"""Unit tests for the SQLite conversion queue (scripts/zarr/zarr_queue.py).

Real SQLite (a temp db per test), no mocks: exercises the enqueue / claim /
done / fail transitions, retry-backoff, version-bump requeue, the crash
recovery (stale `inprogress` -> `pending`), the engine-version stamp and its
migration (#1172), and the pure decision logic of the directory-format backfill
sweep. The HTTP fetches are not tested here (they hit the live API/data plane,
validated by the cron run and by a dry-run sweep).

Run: python3 scripts/zarr/test_zarr_queue.py
"""

from __future__ import annotations

import contextlib
import http.server
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from zarr_queue import (  # type: ignore[import-not-found]  # noqa: E402
    DEFAULT_ENGINE_REQUEUE_LIMIT,
    PENDING_BACKOFF_SECONDS,
    PENDING_MAX_ROUNDS,
    ZARR_ENGINE_VERSION,
    _get_json_retrying,
    _requeue_is_stale,
    backoff_seconds,
    build_parser,
    claim_next,
    classify_backfill,
    connect,
    dir_format_recordings,
    fetch_manifest_paths,
    fetch_requeue_requests,
    fetch_zarr_index,
    heartbeat,
    index_failure_keys,
    index_store_keys,
    main,
    mark_done,
    mark_fail,
    may_carry_dir_formats,
    migrate_schema,
    missing_dir_format_stores,
    partition_dir_format_recordings,
    pending_backoff_seconds,
    reconcile,
    requeue,
    sweep_dir_format_backfill,
)


class QueueTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def status(self, dataset_id):
        r = self.conn.execute(
            "SELECT status FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()
        return r["status"] if r else None

    def test_reconcile_enqueues_new(self):
        res = reconcile(self.conn, [("nm000001", "1.0.0"), ("on000002", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 2)
        self.assertEqual(self.status("nm000001"), "pending")

    def test_requeue_request_reconverts_a_done_row(self):
        """The archive asks for one dataset to be rebuilt, and it is.

        nemarOrg/nemar-cli#1409. A de-anonymized deposit's stores carry the
        blinded author label, and publishing it for real changes neither its
        version nor the engine stamp -- the only two triggers this queue had --
        so without this the store keeps serving "Anonymous (withheld until
        publication)" forever.
        """
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        mark_done(self.conn, "nm000001", "1.0.0")
        self.assertEqual(self.status("nm000001"), "done")

        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0")],
            3600,
            requeue_requests={"nm000001": "2026-09-16 01:00:00"},
        )
        self.assertEqual(self.status("nm000001"), "pending")
        self.assertEqual(res["requeue_requested"], 1)

    def test_no_request_means_never_stale(self):
        """The short-circuit that keeps this from re-queueing the archive.

        `_requeue_is_stale` is deliberately the OPPOSITE polarity to
        `_engine_is_stale`: a NULL stamp IS stale, because it means the row has
        never honored the request in hand. That rule is only safe because of
        `if not requested: return False` -- without it, every dataset that has
        ever been re-queued would re-queue on every tick the moment the catalog
        stopped carrying the stamp, which is exactly the unattended mass
        requeue the engine ack gate exists to prevent.
        """
        # A stamp present, no request: not stale.
        self.assertFalse(_requeue_is_stale("2026-09-16 01:00:00", None))
        # No stamp, no request: not stale either.
        self.assertFalse(_requeue_is_stale(None, None))
        # No stamp WITH a request: stale, which is the inverted rule.
        self.assertTrue(_requeue_is_stale(None, "2026-09-16 01:00:00"))
        # Stamp behind the request: stale.
        self.assertTrue(_requeue_is_stale("2026-09-15 00:00:00", "2026-09-16 01:00:00"))
        # Stamp equal to the request: honored already.
        self.assertFalse(_requeue_is_stale("2026-09-16 01:00:00", "2026-09-16 01:00:00"))

    def test_a_request_reaches_a_failed_row(self):
        """A named request is a new reason to retry a terminal failure.

        "Terminal for this version" (#774) is about the DATA not converting.
        This request is about the dataset's METADATA having changed -- the
        citation the converter bakes in -- which the failed attempt never saw.
        The request used to be evaluated only inside the `done` branch, so a
        de-anonymized dataset whose last conversion failed kept serving the
        blinded citation with nothing left to ask again.
        """
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        mark_fail(self.conn, "nm000001", "boom", 1, 1800)
        self.assertEqual(self.status("nm000001"), "failed")

        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0")],
            3600,
            requeue_requests={"nm000001": "2026-09-16 01:00:00"},
        )
        self.assertEqual(self.status("nm000001"), "pending")
        self.assertEqual(res["requeue_requested"], 1)

    def test_a_failed_rows_request_is_also_honored_once(self):
        """The control for the test above: it buys one retry, not a loop."""
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        mark_fail(self.conn, "nm000001", "boom", 1, 1800)
        request = {"nm000001": "2026-09-16 01:00:00"}
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, requeue_requests=request)
        mark_fail(self.conn, "nm000001", "boom again", 1, 1800)
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600, requeue_requests=request)
        self.assertEqual(res["requeue_requested"], 0)
        self.assertEqual(self.status("nm000001"), "failed")

    def test_an_outstanding_request_is_counted_even_when_not_honored(self):
        """The counter that makes a lost request visible.

        `requeue_requested` counts requests HONORED. On its own it renders "a
        rebuild the archive asked for and never got" as zero, which is the
        thing ADR 0054 forbids. `requeue_outstanding` counts rows still carrying
        a request whose stamp is behind it, whatever their status.
        """
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        # An inprogress row: the request is outstanding and cannot be honored
        # this tick.
        self.conn.execute("UPDATE jobs SET status='inprogress' WHERE dataset_id=?", ("nm000001",))
        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0")],
            3600,
            requeue_requests={"nm000001": "2026-09-16 01:00:00"},
        )
        self.assertEqual(res["requeue_requested"], 0)
        self.assertEqual(res["requeue_outstanding"], 1)

    def test_a_version_bump_satisfies_an_outstanding_request(self):
        """A reconversion the request wanted must not buy a second one.

        `version_changed` wins over the requeue branch, and it reconverts from
        the current catalog row -- which is what the request asked for. Without
        recording the stamp there, the request would re-queue the dataset AGAIN
        once the row went `done`.
        """
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        mark_done(self.conn, "nm000001", "1.0.0")
        request = {"nm000001": "2026-09-16 01:00:00"}
        res = reconcile(self.conn, [("nm000001", "2.0.0")], 3600, requeue_requests=request)
        self.assertEqual(res["requeue_requested"], 1)
        mark_done(self.conn, "nm000001", "2.0.0")
        again = reconcile(self.conn, [("nm000001", "2.0.0")], 3600, requeue_requests=request)
        self.assertEqual(again["requeue_requested"], 0)
        self.assertEqual(self.status("nm000001"), "done")

    def test_the_same_request_is_honored_once(self):
        """The control, and the property that makes this safe to run hourly.

        The stamp is recorded when the request is honored, so a request that
        stays on the catalog row -- which it does, because nothing clears it --
        re-queues the dataset once rather than on every tick forever.
        """
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        mark_done(self.conn, "nm000001", "1.0.0")
        request = {"nm000001": "2026-09-16 01:00:00"}

        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, requeue_requests=request)
        mark_done(self.conn, "nm000001", "1.0.0")

        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600, requeue_requests=request)
        self.assertEqual(self.status("nm000001"), "done")
        self.assertEqual(res["requeue_requested"], 0)

    def test_a_later_request_is_honored_again(self):
        """A second de-anonymization, or any later rebuild, is a new stamp."""
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        mark_done(self.conn, "nm000001", "1.0.0")
        reconcile(
            self.conn,
            [("nm000001", "1.0.0")],
            3600,
            requeue_requests={"nm000001": "2026-09-16 01:00:00"},
        )
        mark_done(self.conn, "nm000001", "1.0.0")

        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0")],
            3600,
            requeue_requests={"nm000001": "2026-09-17 09:30:00"},
        )
        self.assertEqual(self.status("nm000001"), "pending")
        self.assertEqual(res["requeue_requested"], 1)

    def test_no_request_touches_nothing(self):
        """The common case: every dataset in the catalog, on every tick."""
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(self.status("nm000001"), "done")
        self.assertEqual(res["requeue_requested"], 0)

    def test_a_request_is_not_held_by_the_engine_ack_gate(self):
        """One dataset asked for by name does not wait on an unrelated bump.

        The ack gate exists because a global engine bump can hand the whole
        archive back at once. This is one dataset, for a reason the archive
        knows; holding it behind that guard would mean a de-anonymized dataset
        kept serving a blinded citation until somebody acked something else.
        """
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, engine_version="3")
        mark_done(self.conn, "nm000001", "1.0.0", engine_version="3")
        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0")],
            3600,
            engine_version="4",
            engine_requeue_limit=0,
            engine_requeue_ack=False,
            requeue_requests={"nm000001": "2026-09-16 01:00:00"},
        )
        self.assertEqual(self.status("nm000001"), "pending")
        self.assertEqual(res["requeue_requested"], 1)

    def test_fetch_requeue_requests_reads_only_real_stamps(self):
        """Sparse by construction: the field is absent for almost every row."""
        rows = [
            {"dataset_id": "nm000001", "zarr_requeue_at": "2026-09-16 01:00:00"},
            {"dataset_id": "nm000002", "zarr_requeue_at": None},
            {"dataset_id": "nm000003"},
            {"dataset_id": "nm000004", "zarr_requeue_at": ""},
            {"zarr_requeue_at": "2026-09-16 01:00:00"},
        ]
        self.assertEqual(
            fetch_requeue_requests(rows), {"nm000001": "2026-09-16 01:00:00"}
        )

    def test_reconcile_filters_invalid_and_test_id(self):
        reconcile(self.conn, [("nm099999", "1"), ("bad", "1"), ("nm000001", "1.0.0")], 3600)
        ids = [r["dataset_id"] for r in self.conn.execute("SELECT dataset_id FROM jobs").fetchall()]
        self.assertEqual(ids, ["nm000001"])

    def test_reconcile_rejects_exemplars_by_default_and_names_them(self):
        res = reconcile(
            self.conn,
            [("xx099900", "1.0.0"), ("xx099905", "1.0.1"), ("nm000001", "1.0.0")],
            3600,
        )
        self.assertEqual(res["rejected"], 2)
        self.assertEqual(res["rejected_sample"], ["xx099900", "xx099905"])
        ids = [r["dataset_id"] for r in self.conn.execute("SELECT dataset_id FROM jobs").fetchall()]
        self.assertEqual(ids, ["nm000001"])

    def test_reconcile_accept_exemplars_admits_only_the_fleet_band(self):
        res = reconcile(
            self.conn,
            [
                ("xx099900", "1.0.0"),  # exemplar fleet: accepted
                ("xx099999", "1.0.0"),  # top of the band: accepted
                ("xx000001", "1.0.0"),  # prod sandbox band: still rejected
                ("xx090001", "1.0.0"),  # dev ephemeral band: still rejected
                ("nm000001", "1.0.0"),
            ],
            3600,
            accept_exemplars=True,
        )
        self.assertEqual(res["enqueued"], 3)
        self.assertEqual(res["rejected"], 2)
        self.assertEqual(res["rejected_sample"], ["xx000001", "xx090001"])
        self.assertEqual(self.status("xx099900"), "pending")
        self.assertEqual(self.status("xx099999"), "pending")
        self.assertIsNone(self.status("xx000001"))
        self.assertIsNone(self.status("xx090001"))

    def test_cli_refuses_accept_exemplars_against_production_api(self):
        # Guarded before any catalog fetch, for every subcommand that carries
        # the flag: the process must exit non-zero on the flag alone, with no
        # network reached (the temp db stays empty).
        db = os.path.join(self._tmp.name, "cli.db")
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "zarr_queue.py")
        for subcommand in ("reconcile", "backfill-dir-formats"):
            with self.subTest(subcommand=subcommand):
                proc = subprocess.run(
                    [
                        sys.executable,
                        script,
                        "--db",
                        db,
                        subcommand,
                        "--api-base",
                        "https://api.nemar.org",
                        "--accept-exemplars",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn(
                    "refusing --accept-exemplars against the production API", proc.stderr
                )

    def test_reconcile_rejected_sample_is_capped_but_count_is_not(self):
        res = reconcile(self.conn, [(f"bad{i:02d}", "1") for i in range(8)], 3600)
        self.assertEqual(res["rejected"], 8)
        self.assertEqual(res["rejected_sample"], [f"bad{i:02d}" for i in range(5)])

    def test_done_then_reconcile_skips_same_version(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.status("nm000001"), "done")

    def test_version_bump_requeues_done(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "1.1.0")], 3600)
        self.assertEqual(res["enqueued"], 1)
        self.assertEqual(self.status("nm000001"), "pending")

    def test_bare_vs_tagged_same_version_does_not_requeue(self):
        # A done row converted at the bare "1.0.0"; nemar-cli #899 flips the
        # catalog latest_version to the tag "v1.0.0". These are the SAME version
        # and must NOT re-queue (else the queue re-drains every already-converted
        # dataset). Guards against the format-flip compute burst.
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.status("nm000001"), "done")
        # And the reverse (tagged converted, bare latest) is likewise a no-op.
        res2 = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(res2["enqueued"], 0)

    def test_claim_marks_inprogress_then_empty(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        row = claim_next(self.conn)
        self.assertEqual(row["dataset_id"], "nm000001")
        self.assertEqual(self.status("nm000001"), "inprogress")
        self.assertIsNone(claim_next(self.conn))

    def test_claim_orders_by_enqueued(self):
        reconcile(self.conn, [("nm000002", "1"), ("nm000001", "1")], 3600)
        self.conn.execute("UPDATE jobs SET enqueued_at='2026-01-01T00:00:01Z' WHERE dataset_id='nm000002'")
        self.conn.execute("UPDATE jobs SET enqueued_at='2026-01-01T00:00:00Z' WHERE dataset_id='nm000001'")
        self.conn.commit()
        self.assertEqual(claim_next(self.conn)["dataset_id"], "nm000001")
        self.assertEqual(claim_next(self.conn)["dataset_id"], "nm000002")

    def test_claim_next_is_atomic_across_connections(self):
        """#1142: the docstring claimed the read-then-write was atomic under
        the connection's write lock, but a plain SELECT takes no SQLite lock
        at all -- only the later UPDATE did, and only once Python's sqlite3
        module decided to open its own implicit transaction. So two
        connections could each read the SAME 'pending' row before either
        one's UPDATE committed, and BOTH would return it: the same dataset
        handed to two workers, converted twice.

        Reproduced with two REAL connections to the same on-disk database
        file (no mocks). Connection A is driven by hand through claim_next's
        own two statements -- real SQL, the exact sequence the function
        runs -- so this test can hold it PAUSED in the exact window the bug
        lived in: past the read, short of the write. While it is paused,
        connection B runs the real `claim_next()`. The old (buggy)
        implementation's SELECT would succeed immediately in that window
        (WAL readers are not blocked by a writer holding a reserved lock)
        and read the still-'pending' row, so it would go on to update and
        return it too -- a genuine double claim. The fixed implementation's
        `BEGIN IMMEDIATE` instead blocks connection B's whole call until
        connection A's transaction ends, so by the time B's SELECT actually
        runs the row already reads 'inprogress' and B correctly gets None.

        Connection B is opened and fully migrated BEFORE connection A takes
        its lock, then parked: `connect()`'s own schema step
        (`CREATE TABLE IF NOT EXISTS`) needs a write lock too, so building
        connection B while A already holds one would deadlock this test
        against its own fixture rather than exercising claim_next at all.
        """
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.conn.close()  # this test drives its own two connections

        db_path = os.path.join(self._tmp.name, "q.db")
        # sqlite3 connections are single-thread by default (check_same_thread),
        # so each connection is opened INSIDE the thread that uses it, not
        # shared across the thread boundary.
        result_b = {}
        conn_b_ready = threading.Event()
        release_b = threading.Event()

        def run_b():
            conn_b = connect(db_path)  # built before conn_a ever locks anything
            try:
                conn_b_ready.set()
                release_b.wait(timeout=5)
                result_b["row"] = claim_next(conn_b)
            finally:
                conn_b.close()

        t_b = threading.Thread(target=run_b)
        t_b.start()
        self.addCleanup(t_b.join, timeout=5)
        self.assertTrue(
            conn_b_ready.wait(timeout=5), "conn_b never finished connecting"
        )

        reached_pause = threading.Event()
        release_a = threading.Event()

        def run_a():
            # The read half of claim_next, by hand, on conn_a -- real SQL
            # against the real database, paused before the write half runs.
            conn_a = connect(db_path)
            try:
                conn_a.execute("BEGIN IMMEDIATE")
                row = conn_a.execute(
                    "SELECT dataset_id, latest_version FROM jobs"
                    " WHERE status='pending' AND next_retry_at <= ?"
                    " ORDER BY enqueued_at ASC LIMIT 1",
                    (int(time.time()),),
                ).fetchone()
                assert row["dataset_id"] == "nm000001"
                reached_pause.set()
                release_a.wait(timeout=5)
                conn_a.execute(
                    "UPDATE jobs SET status='inprogress', updated_at=? WHERE dataset_id=?",
                    (int(time.time()), "nm000001"),
                )
                conn_a.commit()
            finally:
                conn_a.close()

        t_a = threading.Thread(target=run_a)
        t_a.start()
        self.addCleanup(t_a.join, timeout=5)
        self.assertTrue(reached_pause.wait(timeout=5), "conn_a never reached its pause")

        # conn_a stays paused -- still holding its lock -- for as long as
        # this test wants, so widening this window cannot change what the
        # FIXED implementation does: its BEGIN IMMEDIATE blocks on conn_a's
        # lock regardless of how long that lock is held. The sleep below
        # exists only so the OLD, buggy implementation's race is not masked
        # by conn_b's thread simply not having been scheduled yet -- it
        # gives conn_b's SELECT (unmodified real claim_next code) a chance
        # to actually run while conn_a's row is still 'pending'.
        release_b.set()
        time.sleep(0.05)

        release_a.set()
        t_a.join(timeout=5)
        t_b.join(timeout=5)
        self.assertFalse(t_b.is_alive(), "conn_b's claim_next never returned")
        # The one assertion the fix is FOR: B must not also claim A's row.
        self.assertIsNone(
            result_b["row"],
            "conn_b claimed nm000001 after conn_a already claimed it -- the "
            "same row was handed to two callers",
        )

    def test_fail_reschedules_with_backoff_then_terminal(self):
        reconcile(self.conn, [("nm000001", "1")], 3600)
        claim_next(self.conn)
        self.assertEqual(mark_fail(self.conn, "nm000001", "boom", 3, 1800), "pending")
        # in backoff -> not yet claimable
        self.assertIsNone(claim_next(self.conn))
        for expect in ("pending", "failed"):
            self.conn.execute("UPDATE jobs SET next_retry_at=0 WHERE dataset_id='nm000001'")
            self.conn.commit()
            claim_next(self.conn)
            self.assertEqual(mark_fail(self.conn, "nm000001", "boom", 3, 1800), expect)
        self.assertEqual(self.status("nm000001"), "failed")

    def test_stale_inprogress_recovered(self):
        reconcile(self.conn, [("nm000001", "1")], 3600)
        claim_next(self.conn)  # -> inprogress
        self.conn.execute(
            "UPDATE jobs SET updated_at=? WHERE dataset_id='nm000001'", (int(time.time()) - 99999,)
        )
        self.conn.commit()
        res = reconcile(self.conn, [("nm000001", "1")], 3600)
        self.assertEqual(res["recovered_stale"], 1)
        self.assertEqual(self.status("nm000001"), "pending")

    def stale(self, dataset_id, seconds=99999):
        self.conn.execute(
            "UPDATE jobs SET updated_at=? WHERE dataset_id=?",
            (int(time.time()) - seconds, dataset_id),
        )
        self.conn.commit()

    def test_a_heartbeat_keeps_a_long_conversion_from_being_reclaimed(self):
        """Several drivers drain one queue, and each starts with a reconcile: a
        dataset that has been converting for longer than the stale window must not be
        handed to a second driver while its own is still working on it."""
        reconcile(self.conn, [("nm000001", "1"), ("nm000002", "1")], 3600)
        claim_next(self.conn)
        claim_next(self.conn)
        self.stale("nm000001")
        self.stale("nm000002")
        self.assertEqual(heartbeat(self.conn, "nm000001"), 1)  # still converting
        res = reconcile(self.conn, [("nm000001", "1"), ("nm000002", "1")], 3600)
        self.assertEqual(res["recovered_stale"], 1)  # only the abandoned one
        self.assertEqual(self.status("nm000001"), "inprogress")
        self.assertEqual(self.status("nm000002"), "pending")

    def test_a_heartbeat_touches_nothing_that_is_not_inprogress(self):
        reconcile(self.conn, [("nm000001", "1"), ("nm000002", "1"), ("nm000003", "1")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1")
        claim_next(self.conn)
        mark_fail(self.conn, "nm000002", "boom", 1, 1800)  # -> failed
        for dataset_id in ("nm000001", "nm000002", "nm000003", "nm999999"):
            self.stale(dataset_id)
            self.assertEqual(heartbeat(self.conn, dataset_id), 0)
        stamps = {r["dataset_id"]: r["updated_at"] for r in self.conn.execute(
            "SELECT dataset_id, updated_at FROM jobs")}
        self.assertTrue(all(t < time.time() - 99000 for t in stamps.values()))
        self.assertEqual(self.status("nm000001"), "done")
        self.assertEqual(self.status("nm000002"), "failed")
        self.assertEqual(self.status("nm000003"), "pending")

    def test_the_heartbeat_command_prints_what_it_touched(self):
        db = os.path.join(self._tmp.name, "q.db")
        reconcile(self.conn, [("nm000001", "1")], 3600)
        claim_next(self.conn)
        self.stale("nm000001")
        out = io.StringIO()
        saved = sys.argv
        try:
            with contextlib.redirect_stdout(out):
                for dataset_id in ("nm000001", "nm000404"):
                    sys.argv = ["zarr_queue.py", "--db", db, "heartbeat", dataset_id]
                    self.assertEqual(main(), 0)
        finally:
            sys.argv = saved
        self.assertEqual(out.getvalue().split(), ["1", "0"])
        row = self.conn.execute("SELECT updated_at FROM jobs").fetchone()
        self.assertGreater(row["updated_at"], time.time() - 60)

    def test_backoff_capped(self):
        self.assertEqual(backoff_seconds(1, 100), 100)
        self.assertEqual(backoff_seconds(2, 100), 200)
        self.assertEqual(backoff_seconds(3, 100), 400)
        self.assertEqual(backoff_seconds(100, 100), 6 * 3600)

    # --- #774: deterministic data failures are terminal, don't re-queue --------

    def test_deterministic_fail_is_terminal_data_failed(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        # One deterministic failure -> terminal data_failed immediately, even
        # though max_attempts is high (no retry).
        self.assertEqual(
            mark_fail(self.conn, "nm000001", "MaxShield .fif", 5, 1800, deterministic=True),
            "data_failed",
        )
        self.assertEqual(self.status("nm000001"), "data_failed")

    def test_reconcile_does_not_requeue_terminal_same_version(self):
        # The bug #774 fixes: a failed/data_failed row was re-queued on every
        # reconcile (converted_version is NULL != latest), wedging the queue.
        reconcile(self.conn, [("nm000001", "1.0.0"), ("nm000002", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_fail(self.conn, "nm000001", "boom", 1, 1800)  # -> failed (infra, exhausted)
        claim_next(self.conn)
        mark_fail(self.conn, "nm000002", "unreadable", 5, 1800, deterministic=True)  # -> data_failed
        res = reconcile(self.conn, [("nm000001", "1.0.0"), ("nm000002", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.status("nm000001"), "failed")
        self.assertEqual(self.status("nm000002"), "data_failed")

    def test_reconcile_requeues_terminal_on_new_version(self):
        # A genuinely new snapshot DOES retry a terminal failure from scratch.
        reconcile(self.conn, [("nm000001", "1.0.0"), ("nm000002", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_fail(self.conn, "nm000001", "boom", 1, 1800)  # -> failed
        claim_next(self.conn)
        mark_fail(self.conn, "nm000002", "unreadable", 5, 1800, deterministic=True)  # -> data_failed
        res = reconcile(self.conn, [("nm000001", "2.0.0"), ("nm000002", "2.0.0")], 3600)
        self.assertEqual(res["enqueued"], 2)
        self.assertEqual(self.status("nm000001"), "pending")
        self.assertEqual(self.status("nm000002"), "pending")
        # attempts reset so the new version gets its full retry budget.
        row = self.conn.execute(
            "SELECT attempts, last_error FROM jobs WHERE dataset_id='nm000001'"
        ).fetchone()
        self.assertEqual(row["attempts"], 0)
        self.assertIsNone(row["last_error"])

    def test_data_failed_not_claimable(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_fail(self.conn, "nm000001", "unreadable", 5, 1800, deterministic=True)
        # terminal -> never handed back out by claim_next
        self.assertIsNone(claim_next(self.conn))

    def converted_version(self, dataset_id):
        r = self.conn.execute(
            "SELECT converted_version FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()
        return r["converted_version"] if r else None

    def test_mark_done_stores_canonical_v_tag(self):
        # A bare version from the catalog must land in the column as the canonical
        # tag, so `converted_version` is uniform for any future comparison written
        # without _vtag (222 live rows had drifted to the bare form).
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        self.assertEqual(self.converted_version("nm000001"), "v1.0.0")

    def test_mark_done_leaves_tagged_version_untouched(self):
        reconcile(self.conn, [("nm000001", "v1.2.3")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "v1.2.3")
        self.assertEqual(self.converted_version("nm000001"), "v1.2.3")

    def test_mark_done_normalization_does_not_requeue(self):
        # The normalized write must still compare equal to a bare catalog version
        # on the next reconcile -- otherwise every dataset re-converts forever.
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.status("nm000001"), "done")



class RequeueTest(unittest.TestCase):
    """#1113: recovering datasets the OOM defect and its misclassification buried."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))
        reconcile(self.conn, [("nm000001", "v1"), ("nm000002", "v1"), ("nm000003", "v1")], 3600)
        # nm1: retry budget exhausted on infra errors.
        for _ in range(5):
            mark_fail(self.conn, "nm000001", "worker crashed", max_attempts=5, backoff_base=1)
        # nm2: terminal by the (previously wrong) deterministic classifier.
        mark_fail(self.conn, "nm000002", "all data failures", 5, 1, deterministic=True)
        # nm3 stays pending and must not be touched.

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _status(self, dataset_id):
        return self.conn.execute(
            "SELECT status, attempts FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()

    def test_setup_is_what_we_think(self):
        self.assertEqual(self._status("nm000001")["status"], "failed")
        self.assertEqual(self._status("nm000001")["attempts"], 5)
        self.assertEqual(self._status("nm000002")["status"], "data_failed")
        self.assertEqual(self._status("nm000003")["status"], "pending")

    def test_dry_run_reports_without_changing_anything(self):
        # Requeue un-does a deliberate give-up, so seeing the scope first is the
        # default rather than an option.
        rows = requeue(self.conn, ("failed",))
        self.assertEqual([r[0] for r in rows], ["nm000001"])
        self.assertEqual(self._status("nm000001")["status"], "failed")

    def test_execute_resets_status_and_the_retry_budget(self):
        # attempts must reset too: the budget was spent on a defect that no
        # longer exists, so leaving it at 5 would give the dataset one attempt.
        requeue(self.conn, ("failed",), execute=True)
        row = self._status("nm000001")
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["attempts"], 0)

    def test_failed_only_leaves_data_failed_alone(self):
        requeue(self.conn, ("failed",), execute=True)
        self.assertEqual(self._status("nm000002")["status"], "data_failed")

    def test_all_covers_both_terminal_states(self):
        requeue(self.conn, ("failed", "data_failed"), execute=True)
        self.assertEqual(self._status("nm000001")["status"], "pending")
        self.assertEqual(self._status("nm000002")["status"], "pending")

    def test_a_single_dataset_can_be_targeted(self):
        for _ in range(5):
            mark_fail(self.conn, "nm000003", "worker crashed", max_attempts=5, backoff_base=1)
        requeue(self.conn, ("failed",), dataset_id="nm000001", execute=True)
        self.assertEqual(self._status("nm000001")["status"], "pending")
        self.assertEqual(self._status("nm000003")["status"], "failed")

    def test_multiple_statuses_and_a_dataset_filter_together(self):
        # The parameter shape most likely to hide a placeholder/order slip: two
        # status placeholders AND an appended dataset_id, in both the SELECT and
        # the UPDATE. Nothing else covers it, and this is the function where a
        # wrong requeue resets the wrong production rows.
        for _ in range(5):
            mark_fail(self.conn, "nm000003", "worker crashed", max_attempts=5, backoff_base=1)
        rows = requeue(
            self.conn, ("failed", "data_failed"), dataset_id="nm000002", execute=True
        )
        self.assertEqual([r[0] for r in rows], ["nm000002"])
        self.assertEqual(self._status("nm000002")["status"], "pending")
        # The other terminal rows in BOTH statuses must be untouched.
        self.assertEqual(self._status("nm000001")["status"], "failed")
        self.assertEqual(self._status("nm000003")["status"], "failed")

    def test_done_is_reachable_but_never_swept_up_by_all(self):
        # A run where anything converted is marked `done`, so a recording that
        # failed for a retryable reason is stranded in a `done` row (#1113).
        # Requeue must be able to reach it -- but `all` must NOT include it, or a
        # routine recovery would re-convert the entire archive.
        mark_done(self.conn, "nm000003", "v1")
        self.assertEqual(self._status("nm000003")["status"], "done")

        requeue(self.conn, ("failed", "data_failed"), execute=True)
        self.assertEqual(
            self._status("nm000003")["status"], "done", "`all` must not touch done"
        )

        requeue(self.conn, ("done",), dataset_id="nm000003", execute=True)
        self.assertEqual(self._status("nm000003")["status"], "pending")

    def test_healthy_jobs_are_never_touched(self):
        before = self._status("nm000003")["attempts"]
        requeue(self.conn, ("failed", "data_failed"), execute=True)
        self.assertEqual(self._status("nm000003")["status"], "pending")
        self.assertEqual(self._status("nm000003")["attempts"], before)

    def test_requeued_jobs_are_immediately_claimable(self):
        # next_retry_at must clear, or a requeued job sits behind a backoff that
        # was set when it last failed.
        requeue(self.conn, ("failed",), execute=True)
        claimed = set()
        while (row := claim_next(self.conn)) is not None:
            claimed.add(row["dataset_id"])
        self.assertIn("nm000001", claimed)

    def test_requeueing_nothing_is_not_an_error(self):
        self.assertEqual(requeue(self.conn, ("failed",), dataset_id="nope"), [])


class UnlistedSweepTest(unittest.TestCase):
    """Datasets the catalog stops listing must stop being converted (#1048).

    Withdrawn datasets sat `pending` forever: every run cloned them, failed on
    content that is 0-byte by design, and wrote failure lines. They vanish from
    `GET /datasets` on withdrawal, so reconcile never sees them again and its
    add-and-update-only logic left the rows untouched.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))
        reconcile(self.conn, [("nm000001", "1.0.0"), ("on000002", "1.0.0")], 3600)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def status(self, dataset_id):
        r = self.conn.execute(
            "SELECT status FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()
        return r["status"] if r else None

    def test_absent_dataset_is_parked(self):
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(res["unlisted"], 1)
        self.assertEqual(self.status("on000002"), "unlisted")
        self.assertEqual(self.status("nm000001"), "pending")

    def test_parked_dataset_is_never_claimed(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        claimed = set()
        while (row := claim_next(self.conn)) is not None:
            claimed.add(row["dataset_id"])
        self.assertEqual(claimed, {"nm000001"})

    def test_partial_catalog_read_parks_nothing(self):
        """The guard that stops a truncated fetch from emptying the queue."""
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=False)
        self.assertEqual(res["unlisted"], 0)
        self.assertEqual(self.status("on000002"), "pending")

    def test_relisted_dataset_returns_to_pending(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(self.status("on000002"), "unlisted")
        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0"), ("on000002", "1.0.0")],
            3600,
            listing_complete=True,
        )
        self.assertEqual(res["unlisted"], 0)
        self.assertEqual(self.status("on000002"), "pending")

    def test_parking_preserves_converted_version(self):
        """Parked, not deleted: a dataset that comes back must not reconvert
        work we already have."""
        mark_done(self.conn, "on000002", "1.0.0")
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        row = self.conn.execute(
            "SELECT converted_version FROM jobs WHERE dataset_id=?", ("on000002",)
        ).fetchone()
        self.assertEqual(row["converted_version"], "v1.0.0")

    def test_inprogress_row_is_left_to_its_converter(self):
        """A worker holds that row right now; its own completion decides."""
        claim_next(self.conn)  # nm000001, the older row
        claimed = claim_next(self.conn)
        self.assertEqual(claimed["dataset_id"], "on000002")
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(res["unlisted"], 0)
        self.assertEqual(self.status("on000002"), "inprogress")

    def test_terminal_rows_are_parked_too(self):
        """A withdrawn dataset that already burned its retries still stops
        showing up in the failure listing."""
        mark_fail(self.conn, "on000002", "boom", max_attempts=1, backoff_base=1)
        self.assertEqual(self.status("on000002"), "failed")
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(self.status("on000002"), "unlisted")

    def test_unrecognized_ids_are_counted_not_silently_dropped(self):
        """An ID the queue cannot parse never enters it. Counting that is the
        only way the log distinguishes it from an ordinary quiet run, where most
        rows are already `done` and `enqueued` is legitimately 0."""
        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0"), ("NM000001", "1.0.0"), ("ds000117", "1.0.0")],
            3600,
        )
        self.assertEqual(res["rejected"], 2)

    def test_the_e2e_fixture_is_an_expected_skip_not_a_rejection(self):
        """nm099999 is deliberately never converted; counting it as rejected
        would put a permanent non-zero anomaly in every single run's summary."""
        res = reconcile(self.conn, [("nm000001", "1.0.0"), ("nm099999", "1.0.0")], 3600)
        self.assertEqual(res["rejected"], 0)

    def test_relisting_an_exhausted_row_restores_its_full_retry_budget(self):
        """A row that failed its way to terminal, was parked, and later came back
        must convert again -- not arrive one failure from terminal.

        The relist branch resets attempts/last_error/next_retry_at precisely so
        the row is not judged on failures that happened while the dataset was in
        a different state. Without that reset the dataset would go straight back
        to terminal on its next hiccup and silently stay unconverted.
        """
        mark_fail(self.conn, "on000002", "boom", max_attempts=1, backoff_base=1)
        self.assertEqual(self.status("on000002"), "failed")
        row = self.conn.execute(
            "SELECT attempts, last_error FROM jobs WHERE dataset_id='on000002'"
        ).fetchone()
        self.assertGreater(row["attempts"], 0)  # guard: the case is real
        self.assertIsNotNone(row["last_error"])

        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(self.status("on000002"), "unlisted")

        reconcile(
            self.conn,
            [("nm000001", "1.0.0"), ("on000002", "1.0.0")],
            3600,
            listing_complete=True,
        )
        self.assertEqual(self.status("on000002"), "pending")
        back = self.conn.execute(
            "SELECT attempts, last_error, next_retry_at FROM jobs WHERE dataset_id='on000002'"
        ).fetchone()
        self.assertEqual(back["attempts"], 0)
        self.assertIsNone(back["last_error"])
        self.assertEqual(back["next_retry_at"], 0)


class EngineStampMigrationTest(unittest.TestCase):
    """#1172: the migration that must NOT requeue the archive.

    The production queue predates the `engine_version` column, so every one of
    its ~667 `done` rows arrives NULL. Reading NULL as "old engine" would put the
    whole archive back through conversion on the next cron tick; the migration
    therefore seeds them to the CURRENT version and leaves the genuinely stranded
    cohort to the targeted `backfill-dir-formats` sweep.
    """

    # The jobs table exactly as it stood before this change: a real pre-migration
    # database, not a stand-in for one.
    PRE_MIGRATION_SCHEMA = """
    CREATE TABLE IF NOT EXISTS jobs (
      dataset_id        TEXT PRIMARY KEY,
      latest_version    TEXT,
      converted_version TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempts          INTEGER NOT NULL DEFAULT 0,
      last_error        TEXT,
      next_retry_at     INTEGER NOT NULL DEFAULT 0,
      enqueued_at       TEXT,
      updated_at        INTEGER NOT NULL DEFAULT 0
    );
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self._tmp.name, "old.db")
        old = sqlite3.connect(self.db)
        # WAL, like the live queue: `connect` sets it on every open, and
        # SWITCHING journal mode needs an exclusive lock that an already-WAL
        # database never asks for. Without this the fixture would make two
        # concurrent opens collide on the pragma rather than on the migration.
        old.execute("PRAGMA journal_mode=WAL")
        old.executescript(self.PRE_MIGRATION_SCHEMA)
        old.executemany(
            "INSERT INTO jobs(dataset_id, latest_version, converted_version, status,"
            " enqueued_at, updated_at) VALUES(?,?,?,?,?,?)",
            [
                ("nm000001", "v1.0.0", "v1.0.0", "done", "2026-01-01T00:00:00Z", 0),
                ("on000002", "v2.0.0", "v2.0.0", "done", "2026-01-01T00:00:01Z", 0),
                ("nm000003", "v1.0.0", None, "pending", "2026-01-01T00:00:02Z", 0),
            ],
        )
        old.commit()
        old.close()

    def tearDown(self):
        self._tmp.cleanup()

    def _open(self):
        """connect() with its one-time migration notice captured, not printed."""
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            conn = connect(self.db)
        return conn, buf.getvalue()

    def stamps(self, conn):
        return {
            r["dataset_id"]: r["engine_version"]
            for r in conn.execute("SELECT dataset_id, engine_version FROM jobs")
        }

    def test_the_pre_migration_db_really_lacks_the_column(self):
        # Guard on the fixture itself: if this ever passes trivially, every other
        # assertion in this class is testing nothing.
        raw = sqlite3.connect(self.db)
        cols = {r[1] for r in raw.execute("PRAGMA table_info(jobs)")}
        raw.close()
        self.assertNotIn("engine_version", cols)

    def test_connect_adds_the_column_and_seeds_the_done_rows_to_current(self):
        conn, _ = self._open()
        self.addCleanup(conn.close)
        self.assertEqual(
            self.stamps(conn),
            {
                "nm000001": ZARR_ENGINE_VERSION,
                "on000002": ZARR_ENGINE_VERSION,
                # Pending: nothing has converted it, so it has nothing to
                # declare. `mark_done` stamps it when it actually converts.
                "nm000003": None,
            },
        )

    def test_a_pending_row_is_not_seeded(self):
        """The seed runs on every connect, so it must match only what it means.

        Seeding every NULL row would re-fire forever: `reconcile` INSERTs new
        rows with no stamp, so the next process would "seed" them, print a
        migration notice on a routine tick, and take a write lock inside the
        drain's `next` loop.
        """
        conn, _ = self._open()
        self.addCleanup(conn.close)
        reconcile(conn, [("nm000009", "v1.0.0")], 3600)
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            self.assertEqual(migrate_schema(conn), 0)
        self.assertEqual(buf.getvalue(), "")
        row = conn.execute(
            "SELECT engine_version FROM jobs WHERE dataset_id='nm000009'"
        ).fetchone()
        self.assertIsNone(row["engine_version"])

    def test_the_migration_announces_itself(self):
        # The single most consequential thing this file does to a live queue is
        # declare rows current instead of requeuing them. It must leave a trace
        # in the cron log.
        _, notice = self._open()
        self.assertIn("2 pre-existing row(s)", notice)
        self.assertIn("engine_version", notice)

    def test_migrated_rows_are_not_requeued_by_the_next_reconcile(self):
        """The whole point: no mass reconversion on the first post-upgrade run."""
        conn, _ = self._open()
        self.addCleanup(conn.close)
        res = reconcile(conn, [("nm000001", "v1.0.0"), ("on000002", "v2.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(res["engine_stale"], 0)
        self.assertEqual(res["engine_requeued"], 0)
        statuses = {
            r["dataset_id"]: r["status"]
            for r in conn.execute("SELECT dataset_id, status FROM jobs")
        }
        self.assertEqual(statuses["nm000001"], "done")
        self.assertEqual(statuses["on000002"], "done")

    def test_a_crash_between_the_alter_and_the_seed_is_recovered(self):
        """The window that made the seed unconditional.

        SQLite makes `ALTER TABLE ... ADD COLUMN` durable the moment it runs,
        before the seeding UPDATE that follows commits. An OOM kill in between --
        this box's documented history (#1110) -- leaves the column present and
        every row NULL. A `column exists -> return 0` guard would then see a
        migrated schema forever, never seed, and leave those rows permanently
        invisible to every future engine bump, with nothing in any log saying so.

        This constructs exactly that state and asserts the next connect repairs
        it.
        """
        crashed = sqlite3.connect(self.db)
        crashed.execute("ALTER TABLE jobs ADD COLUMN engine_version TEXT")
        crashed.commit()  # the ALTER lands; the seed never ran
        crashed.close()

        raw = sqlite3.connect(self.db)
        raw.row_factory = sqlite3.Row
        self.assertIn("engine_version", {r["name"] for r in raw.execute("PRAGMA table_info(jobs)")})
        self.assertEqual(
            [r["engine_version"] for r in raw.execute("SELECT engine_version FROM jobs")],
            [None, None, None],
            "guard: the crashed state must really be column-present/all-NULL",
        )
        raw.close()

        conn, notice = self._open()
        self.addCleanup(conn.close)
        self.assertEqual(
            self.stamps(conn),
            {
                "nm000001": ZARR_ENGINE_VERSION,
                "on000002": ZARR_ENGINE_VERSION,
                "nm000003": None,
            },
        )
        self.assertIn("2 pre-existing row(s)", notice)

    def test_a_lost_alter_race_does_not_raise(self):
        """Two processes may legitimately hold this DB at once.

        `--requeue` and `--backfill-dir-formats` are documented as safe to run
        while a drain holds the flock, so two processes can both read "no
        column" and both attempt the ALTER. The loser used to take an uncaught
        OperationalError -- and if the loser is the cron's `reconcile`, the whole
        tick aborts and nothing is enqueued.
        """
        winner, _ = self._open()  # adds the column and seeds
        self.addCleanup(winner.close)
        # A connection that read the schema BEFORE the winner ran: its PRAGMA
        # said "no column", so it will attempt the ALTER and lose.
        loser = sqlite3.connect(self.db)
        loser.row_factory = sqlite3.Row
        self.addCleanup(loser.close)
        with self.assertRaises(sqlite3.OperationalError) as raised:
            loser.execute("ALTER TABLE jobs ADD COLUMN engine_version TEXT")
        self.assertIn("duplicate column", str(raised.exception).lower())
        # migrate_schema swallows exactly that error and proceeds to the seed.
        self.assertEqual(migrate_schema(loser), 0)

    def test_a_real_schema_error_still_raises(self):
        # The duplicate-column tolerance must not become a blanket
        # "ignore OperationalError", or a genuinely broken schema converts
        # silently against the wrong table.
        broken = sqlite3.connect(os.path.join(self._tmp.name, "broken.db"))
        broken.row_factory = sqlite3.Row
        self.addCleanup(broken.close)
        with self.assertRaises(sqlite3.OperationalError) as raised:
            migrate_schema(broken)  # no `jobs` table at all
        self.assertIn("no such table", str(raised.exception).lower())

    def test_two_racing_connects_both_succeed(self):
        """The race, driven for real through two threads on one file."""
        errors: list[BaseException] = []
        started = threading.Barrier(2)

        def open_and_migrate():
            try:
                started.wait(timeout=5)
                buf = io.StringIO()
                with contextlib.redirect_stderr(buf):
                    conn = connect(self.db)
                conn.close()
            except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
                errors.append(exc)

        threads = [threading.Thread(target=open_and_migrate) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual([f"{type(e).__name__}: {e}" for e in errors], [])
        raw = sqlite3.connect(self.db)
        raw.row_factory = sqlite3.Row
        self.addCleanup(raw.close)
        done = [
            r["engine_version"]
            for r in raw.execute("SELECT engine_version FROM jobs WHERE status='done'")
        ]
        self.assertEqual(done, [ZARR_ENGINE_VERSION, ZARR_ENGINE_VERSION])

    def test_migration_is_idempotent(self):
        conn, _ = self._open()
        self.addCleanup(conn.close)
        self.assertEqual(migrate_schema(conn), 0)
        conn2, notice = self._open()
        self.addCleanup(conn2.close)
        self.assertEqual(notice, "")

    def test_a_fresh_db_has_the_column_and_seeds_nothing(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            conn = connect(os.path.join(tmp.name, "new.db"))
        self.addCleanup(conn.close)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(jobs)")}
        self.assertIn("engine_version", cols)
        self.assertEqual(buf.getvalue(), "")


class PendingRetryTest(unittest.TestCase):
    """A `done` dataset that still owes recordings gets re-queued on its own
    (nemarOrg/nemar-cli#1197).

    Before this, a run that converted SOMETHING returned 0, the row went `done`,
    and any recording that had failed for an infra reason was never looked at
    again: on008083 lost five that way, and from outside they were
    indistinguishable from "still generating" forever. The converter now lists
    them in index.json's `pending` and reports the count; this is the half that
    acts on it.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def row(self):
        return self.conn.execute(
            "SELECT status, pending_count, retry_round, next_retry_at FROM jobs"
            " WHERE dataset_id='nm000001'"
        ).fetchone()

    def due_now(self):
        """Make the row's backoff elapsed, so reconcile's decision is about the
        POLICY and not about waiting an hour in a test."""
        self.conn.execute(
            "UPDATE jobs SET next_retry_at=0 WHERE dataset_id='nm000001'"
        )
        self.conn.commit()

    def test_a_clean_run_records_nothing_outstanding(self):
        mark_done(self.conn, "nm000001", "1.0.0")
        row = self.row()
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["pending_count"], 0)
        self.assertEqual(row["retry_round"], 0)
        self.assertEqual(row["next_retry_at"], 0)
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(res["pending_outstanding"], 0)

    def test_pending_recordings_stamp_a_round_and_a_backoff(self):
        before = int(time.time())
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=5)
        row = self.row()
        self.assertEqual(row["status"], "done", "what converted is still served")
        self.assertEqual(row["pending_count"], 5)
        self.assertEqual(row["retry_round"], 1)
        self.assertGreaterEqual(row["next_retry_at"], before + PENDING_BACKOFF_SECONDS[0])

    def test_reconcile_waits_for_the_backoff(self):
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=5)
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        # Counted as outstanding, but NOT re-queued: the hour has not passed.
        self.assertEqual(res["pending_outstanding"], 1)
        self.assertEqual(res["pending_requeued"], 0)
        self.assertEqual(self.row()["status"], "done")

    def test_reconcile_requeues_once_the_backoff_elapses(self):
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=5)
        self.due_now()
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(res["pending_requeued"], 1)
        self.assertEqual(res["enqueued"], 1)
        self.assertEqual(self.row()["status"], "pending")

    def test_the_backoff_grows_with_the_round(self):
        self.assertEqual(
            [pending_backoff_seconds(n) for n in (1, 2, 3, 4)],
            [3600, 6 * 3600, 24 * 3600, 7 * 86400],
        )
        # Past the table it holds at weekly rather than growing without bound.
        self.assertEqual(pending_backoff_seconds(99), PENDING_BACKOFF_SECONDS[-1])
        # And a round of 0 (never retried) still yields the first entry.
        self.assertEqual(pending_backoff_seconds(0), PENDING_BACKOFF_SECONDS[0])

    def test_rounds_accumulate_across_conversions(self):
        for expected in (1, 2, 3):
            mark_done(self.conn, "nm000001", "1.0.0", pending_count=1)
            self.assertEqual(self.row()["retry_round"], expected)
            self.due_now()
            reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
            claim_next(self.conn)

    def test_exhaustion_stops_consuming_the_queue(self):
        for _ in range(PENDING_MAX_ROUNDS):
            mark_done(self.conn, "nm000001", "1.0.0", pending_count=1)
            self.due_now()
            res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
            if self.row()["status"] == "pending":
                claim_next(self.conn)
        self.assertEqual(self.row()["retry_round"], PENDING_MAX_ROUNDS)
        # The last reconcile of the loop already refused to requeue.
        self.assertEqual(res["pending_requeued"], 0)
        self.assertEqual(res["pending_exhausted"], 1)
        self.assertEqual(self.row()["status"], "done")

    def test_a_clean_run_resets_the_round(self):
        # A dataset that succeeds after bad rounds must not be one round from
        # exhaustion the next time something transient happens to it.
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=3)
        self.assertEqual(self.row()["retry_round"], 1)
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=0)
        self.assertEqual(self.row()["retry_round"], 0)
        self.assertEqual(self.row()["pending_count"], 0)

    def test_a_new_version_wins_over_the_pending_backoff(self):
        # A newer snapshot re-converts everything anyway, so it must not be held
        # back by a pending backoff from the previous one.
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=5)
        res = reconcile(self.conn, [("nm000001", "1.1.0")], 3600)
        self.assertEqual(res["enqueued"], 1)
        self.assertEqual(res["pending_requeued"], 0)
        self.assertEqual(self.row()["status"], "pending")

    def test_the_engine_bump_guard_does_not_block_a_pending_requeue(self):
        # A pending requeue is ordinary unfinished work on the CURRENT engine.
        # Blocking it behind an unacknowledged engine bump would strand exactly
        # the recordings this mechanism exists to recover.
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=2)
        self.due_now()
        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0")],
            3600,
            engine_version="99",
            engine_requeue_limit=0,
        )
        self.assertEqual(res["pending_requeued"], 1)
        self.assertEqual(self.row()["status"], "pending")

    def test_not_attempted_pendings_do_not_spend_a_round(self):
        """A recording nothing has tried yet must not cost an exhaustion round.

        A dataset too large to finish in one run reports pendings every time. If
        those advanced `retry_round`, five runs would exhaust it and it would
        look permanently broken while nothing had ever actually failed.
        """
        before = int(time.time())
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=4, not_attempted_count=4)
        row = self.row()
        self.assertEqual(row["pending_count"], 4)
        self.assertEqual(row["retry_round"], 0, "no round spent")
        # Re-queued at the SHORTEST delay rather than the round-1 backoff, which
        # here happen to be the same number -- so assert the round, above, too.
        self.assertGreaterEqual(row["next_retry_at"], before + PENDING_BACKOFF_SECONDS[0])

    def test_not_attempted_pendings_never_exhaust(self):
        for _ in range(PENDING_MAX_ROUNDS + 3):
            mark_done(
                self.conn, "nm000001", "1.0.0", pending_count=2, not_attempted_count=2
            )
            self.due_now()
            res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
            self.assertEqual(res["pending_requeued"], 1)
            self.assertEqual(res["pending_exhausted"], 0)
            claim_next(self.conn)
        self.assertEqual(self.row()["retry_round"], 0)

    def test_a_mixed_batch_spends_a_round(self):
        # One genuinely failing recording alongside three untried ones: something
        # HAS failed, so the backoff applies.
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=4, not_attempted_count=3)
        self.assertEqual(self.row()["retry_round"], 1)
        self.assertEqual(self.row()["pending_count"], 4)

    def test_only_attempted_pendings_drive_exhaustion(self):
        for _ in range(PENDING_MAX_ROUNDS):
            mark_done(
                self.conn, "nm000001", "1.0.0", pending_count=3, not_attempted_count=2
            )
            self.due_now()
            res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
            if self.row()["status"] == "pending":
                claim_next(self.conn)
        self.assertEqual(self.row()["retry_round"], PENDING_MAX_ROUNDS)
        self.assertEqual(res["pending_exhausted"], 1)

    def test_not_attempted_is_clamped_to_pending(self):
        # A converter bug must not be able to make the attempted count negative,
        # which would silently turn a failing dataset into a never-exhausting one.
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=2, not_attempted_count=9)
        self.assertEqual(self.row()["pending_count"], 2)
        self.assertEqual(self.row()["retry_round"], 0)
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=2, not_attempted_count=-5)
        self.assertEqual(self.row()["retry_round"], 1, "negative reads as zero untried")

    def test_a_clean_run_still_clears_a_not_attempted_backlog(self):
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=3, not_attempted_count=3)
        self.assertEqual(self.row()["pending_count"], 3)
        mark_done(self.conn, "nm000001", "1.0.0", pending_count=0)
        self.assertEqual(self.row()["pending_count"], 0)
        self.assertEqual(self.row()["next_retry_at"], 0)

    def test_the_cli_passes_both_counts_through(self):
        # hallu-zarr.sh forwards both; a flag the parser accepts but never threads
        # would leave every other test in this class green.
        db = os.path.join(self._tmp.name, "q.db")
        argv = [
            "zarr_queue.py", "--db", db, "done", "nm000001", "1.0.0",
            "--pending-count", "5", "--not-attempted-count", "5",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            self.assertEqual(main(), 0)
        finally:
            sys.argv = saved
        self.assertEqual(self.row()["pending_count"], 5)
        self.assertEqual(self.row()["retry_round"], 0, "all untried: no round spent")

    def test_the_cli_passes_the_pending_count_through(self):
        # `hallu-zarr.sh` reaches this via `qpy done <id> <ver> --pending-count N`,
        # so drive the real argument parser: a flag the parser accepts but never
        # threads to mark_done would leave every other test in this class green.
        db = os.path.join(self._tmp.name, "q.db")
        argv = [
            "zarr_queue.py", "--db", db, "done", "nm000001", "1.0.0",
            "--pending-count", "4",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            rc = main()
        finally:
            sys.argv = saved
        self.assertEqual(rc, 0)
        self.assertEqual(self.row()["pending_count"], 4)
        self.assertEqual(self.row()["retry_round"], 1)


class PendingColumnMigrationTest(unittest.TestCase):
    """The pending columns land on a table that already exists in production, so
    they arrive by ALTER, not by CREATE TABLE (same reason `engine_version` did).
    A NULL-defaulting column would make every pre-existing `done` row look
    outstanding on the first reconcile after deploy and re-queue the archive."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, "old.db")

    def tearDown(self):
        self._tmp.cleanup()

    def legacy_db(self):
        """A `jobs` table as it existed before #1197 -- with engine_version, since
        that migration already shipped, but without the pending columns."""
        conn = sqlite3.connect(self.path)
        conn.executescript(
            """
            CREATE TABLE jobs (
              dataset_id TEXT PRIMARY KEY, latest_version TEXT,
              converted_version TEXT, status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
              next_retry_at INTEGER NOT NULL DEFAULT 0, enqueued_at TEXT,
              updated_at INTEGER NOT NULL DEFAULT 0, engine_version TEXT
            );
            INSERT INTO jobs(dataset_id, latest_version, converted_version, status,
                             engine_version)
            VALUES('nm000001', 'v1.0.0', 'v1.0.0', 'done', ?);
            """.replace("?", f"'{ZARR_ENGINE_VERSION}'")
        )
        conn.commit()
        conn.close()

    def test_the_columns_are_added_and_default_to_zero(self):
        self.legacy_db()
        conn = connect(self.path)
        try:
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(jobs)")}
            self.assertIn("pending_count", cols)
            self.assertIn("retry_round", cols)
            row = conn.execute(
                "SELECT pending_count, retry_round FROM jobs WHERE dataset_id='nm000001'"
            ).fetchone()
            self.assertEqual((row["pending_count"], row["retry_round"]), (0, 0))
        finally:
            conn.close()

    def test_a_migrated_row_is_not_requeued(self):
        self.legacy_db()
        conn = connect(self.path)
        try:
            res = reconcile(conn, [("nm000001", "v1.0.0")], 3600)
            self.assertEqual(res["enqueued"], 0)
            self.assertEqual(res["pending_outstanding"], 0)
        finally:
            conn.close()

    def test_migration_is_idempotent(self):
        self.legacy_db()
        for _ in range(3):
            conn = connect(self.path)
            self.assertEqual(migrate_schema(conn), 0)
            conn.close()


class EngineStampRequeueTest(unittest.TestCase):
    """#1172: a widened engine reaches the back catalog through the stamp.

    An engine upgrade bumps no dataset version, so before this the version
    comparison in `reconcile` was the only requeue trigger and every
    already-converted dataset stayed on the rules it was converted under.
    """

    OLD_ENGINE = "1"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))
        reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        claim_next(self.conn)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def row(self, dataset_id="nm000001"):
        return self.conn.execute(
            "SELECT status, latest_version, converted_version, engine_version, attempts"
            " FROM jobs WHERE dataset_id=?",
            (dataset_id,),
        ).fetchone()

    def test_done_stamps_the_current_engine(self):
        mark_done(self.conn, "nm000001", "v1.0.0")
        self.assertEqual(self.row()["engine_version"], ZARR_ENGINE_VERSION)

    def test_a_stale_stamp_requeues_at_the_same_version(self):
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 1)
        self.assertEqual(res["engine_stale"], 1)
        self.assertEqual(res["engine_requeued"], 1)
        self.assertEqual(self.row()["status"], "pending")

    def test_a_current_stamp_is_left_alone(self):
        mark_done(self.conn, "nm000001", "v1.0.0")
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual((res["enqueued"], res["engine_stale"]), (0, 0))
        self.assertEqual(self.row()["status"], "done")

    def test_the_guard_flag_suppresses_the_requeue_but_still_counts_it(self):
        # `--no-engine-requeue` exists so the cost of a bump can be read off a
        # run before it is paid; a suppressed requeue that also reported zero
        # would make the flag useless.
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600, engine_requeue=False)
        self.assertEqual(res["engine_stale"], 1)
        self.assertEqual(res["engine_requeued"], 0)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.row()["status"], "done")

    def test_a_null_stamp_is_never_stale(self):
        """Fail-safe: a NULL that escaped the migration must not requeue.

        `migrate_schema` seeds every pre-existing row, so this should be
        unreachable -- which is exactly why the behavior needs pinning. If a
        NULL ever does appear (an older driver writing into a migrated DB, a
        hand-edited row), the wrong reading of it re-converts the entire archive.
        """
        mark_done(self.conn, "nm000001", "v1.0.0")
        self.conn.execute("UPDATE jobs SET engine_version=NULL WHERE dataset_id='nm000001'")
        self.conn.commit()
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual((res["enqueued"], res["engine_stale"]), (0, 0))
        self.assertEqual(self.row()["status"], "done")

    def test_a_version_change_still_requeues_and_is_not_double_counted(self):
        # A row with both a new version and a stale stamp would re-convert
        # anyway, so it is attributed to the version -- `engine_requeued` reports
        # the MARGINAL cost of a bump, not the overlap.
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        res = reconcile(self.conn, [("nm000001", "v2.0.0")], 3600)
        self.assertEqual(res["enqueued"], 1)
        self.assertEqual(res["engine_stale"], 1)
        self.assertEqual(res["engine_requeued"], 0)
        row = self.row()
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["latest_version"], "v2.0.0")

    def test_a_stamp_only_requeue_keeps_the_version_to_convert(self):
        # The drain reads `latest_version` off the claimed row; blanking it would
        # hand the converter an empty target.
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        reconcile(self.conn, [("nm000001", "")], 3600)
        row = self.row()
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["latest_version"], "v1.0.0")

    def test_the_requeued_row_converts_and_restamps_to_current(self):
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        claimed = claim_next(self.conn)
        self.assertEqual(claimed["dataset_id"], "nm000001")
        mark_done(self.conn, "nm000001", claimed["latest_version"])
        self.assertEqual(self.row()["engine_version"], ZARR_ENGINE_VERSION)
        # ... and the next reconcile is quiet again, so a bump requeues once.
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual((res["enqueued"], res["engine_stale"]), (0, 0))

    def test_the_stamp_governs_done_rows_only(self):
        # A terminal row is terminal for reasons the stamp knows nothing about
        # (#774). Widening discovery does not make an unreadable recording
        # readable, so an engine bump must not revive `failed`/`data_failed`.
        mark_fail(self.conn, "nm000001", "unreadable", 5, 1800, deterministic=True)
        self.conn.execute("UPDATE jobs SET engine_version=? WHERE dataset_id='nm000001'", ("1",))
        self.conn.commit()
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual((res["enqueued"], res["engine_stale"]), (0, 0))
        self.assertEqual(self.row()["status"], "data_failed")


class EngineBumpGuardTest(unittest.TestCase):
    """#1172: a merged engine bump must not land unattended.

    The Hallu cron self-deploys the driver every run (`setup()` resets the clone
    to origin/$DRIVER_REF), so merging a bump IS deploying it: the next hourly
    tick would reconcile with the new constant and re-queue the back catalog with
    nobody watching. The guard turns that into a deliberate second step.
    """

    OLD_ENGINE = "1"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))
        self.ids = [f"nm{n:06d}" for n in range(1, 11)]
        reconcile(self.conn, [(i, "v1.0.0") for i in self.ids], 3600)
        for dataset_id in self.ids:
            claim_next(self.conn)
            mark_done(self.conn, dataset_id, "v1.0.0", engine_version=self.OLD_ENGINE)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def catalog(self):
        return [(i, "v1.0.0") for i in self.ids]

    def statuses(self):
        return [
            r["status"] for r in self.conn.execute("SELECT status FROM jobs ORDER BY dataset_id")
        ]

    def test_a_bump_over_the_limit_requeues_nothing_at_all(self):
        # All-or-nothing: a partial requeue would split the archive across two
        # engines with no record of where the line fell, and the next run would
        # carry on regardless -- the very thing the guard prevents.
        res = reconcile(self.conn, self.catalog(), 3600, engine_requeue_limit=5)
        self.assertTrue(res["engine_requeue_blocked"])
        self.assertEqual(res["engine_requeued"], 0)
        self.assertEqual(res["engine_pending"], 10)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.statuses(), ["done"] * 10)

    def test_the_block_still_reports_the_full_stale_count(self):
        res = reconcile(self.conn, self.catalog(), 3600, engine_requeue_limit=5)
        self.assertEqual(res["engine_stale"], 10)

    def test_an_ack_applies_the_whole_bump(self):
        res = reconcile(
            self.conn, self.catalog(), 3600, engine_requeue_limit=5, engine_requeue_ack=True
        )
        self.assertFalse(res["engine_requeue_blocked"])
        self.assertEqual(res["engine_requeued"], 10)
        self.assertEqual(res["enqueued"], 10)
        self.assertEqual(self.statuses(), ["pending"] * 10)

    def test_a_bump_at_or_under_the_limit_needs_no_ack(self):
        # The guard is for bumps, not for the handful of rows a hand-fixed stamp
        # or a rolled-back driver leaves behind.
        res = reconcile(self.conn, self.catalog(), 3600, engine_requeue_limit=10)
        self.assertFalse(res["engine_requeue_blocked"])
        self.assertEqual(res["engine_requeued"], 10)

    def test_no_limit_is_the_pure_default(self):
        res = reconcile(self.conn, self.catalog(), 3600)
        self.assertFalse(res["engine_requeue_blocked"])
        self.assertEqual(res["engine_requeued"], 10)

    def test_the_DEFAULT_limit_of_25_is_the_boundary(self):
        """The boundary AT the real default, rather than at an invented one.

        Every other test in this class passes `engine_requeue_limit=` explicitly,
        so `DEFAULT_ENGINE_REQUEUE_LIMIT` itself -- the value the CLI supplies and
        therefore the only one the cron ever uses -- was asserted nowhere.
        Changing 25 to 2500 would have left this class green and the guard
        useless.

        This calls `reconcile()` directly, passing the constant: it pins the
        <=/< boundary (25 requeues, 26 blocks). That the CLI actually SUPPLIES
        that constant is a separate fact, pinned by
        `test_the_cli_supplies_the_default_limit` below through the real parser --
        together they cover "the number is right" and "the number arrives".
        """
        self.assertEqual(DEFAULT_ENGINE_REQUEUE_LIMIT, 25)
        for count, expect_blocked in ((25, False), (26, True)):
            with self.subTest(stale=count):
                tmp = tempfile.TemporaryDirectory()
                self.addCleanup(tmp.cleanup)
                conn = connect(os.path.join(tmp.name, "q.db"))
                ids = [f"nm{n:06d}" for n in range(1, count + 1)]
                reconcile(conn, [(i, "v1.0.0") for i in ids], 3600)
                for dataset_id in ids:
                    claim_next(conn)
                    mark_done(conn, dataset_id, "v1.0.0", engine_version=self.OLD_ENGINE)
                res = reconcile(
                    conn,
                    [(i, "v1.0.0") for i in ids],
                    3600,
                    engine_requeue_limit=DEFAULT_ENGINE_REQUEUE_LIMIT,
                )
                self.assertEqual(res["engine_stale"], count)
                self.assertIs(res["engine_requeue_blocked"], expect_blocked)
                self.assertEqual(res["engine_requeued"], 0 if expect_blocked else count)
                conn.close()

    def test_the_cli_supplies_the_default_limit(self):
        """The guard's floor as the CRON gets it: parsed, with no override.

        `hallu-zarr.sh` passes `--engine-requeue-limit "$ENGINE_REQUEUE_LIMIT"`,
        but the parser's default is what applies whenever anyone runs `reconcile`
        by hand -- and it is the only place the constant becomes an argument.
        Comparing the constant to itself would assert nothing; this drives the
        real `argparse` parser and reads the value off the parsed namespace.
        """
        args = build_parser().parse_args(["--db", "/tmp/x.db", "reconcile"])
        self.assertEqual(args.engine_requeue_limit, 25)
        self.assertEqual(args.engine_requeue_limit, DEFAULT_ENGINE_REQUEUE_LIMIT)
        # `0` spells "no guard" on a CLI where None cannot be typed, so the
        # default must be a real, positive floor rather than the disabled value.
        self.assertGreater(args.engine_requeue_limit, 0)
        # And an explicit override still wins, which is how the cron passes it.
        override = build_parser().parse_args(
            ["--db", "/tmp/x.db", "reconcile", "--engine-requeue-limit", "3"]
        )
        self.assertEqual(override.engine_requeue_limit, 3)

    def test_the_cli_defaults_the_pending_counts_to_zero(self):
        # The same class of fact for `done`: a run that reports nothing
        # outstanding must not accidentally arm a retry.
        args = build_parser().parse_args(["--db", "/tmp/x.db", "done", "nm000001", "v1.0.0"])
        self.assertEqual(args.pending_count, 0)
        self.assertEqual(args.not_attempted_count, 0)

    def test_a_blocked_bump_does_not_stop_ordinary_work(self):
        """The guard is scoped to the stamp-only requeues, deliberately.

        A guard that stopped genuinely new datasets converting would be a worse
        failure than the unattended requeue it prevents.
        """
        catalog = self.catalog() + [("nm000042", "v1.0.0")]  # brand new
        catalog[0] = (self.ids[0], "v2.0.0")  # and one real version bump
        res = reconcile(self.conn, catalog, 3600, engine_requeue_limit=5)
        self.assertTrue(res["engine_requeue_blocked"])
        self.assertEqual(res["enqueued"], 2)  # the new row + the version bump
        self.assertEqual(res["engine_requeued"], 0)
        row = self.conn.execute(
            "SELECT status FROM jobs WHERE dataset_id=?", (self.ids[0],)
        ).fetchone()
        self.assertEqual(row["status"], "pending")
        self.assertEqual(
            self.conn.execute("SELECT status FROM jobs WHERE dataset_id='nm000042'").fetchone()[
                "status"
            ],
            "pending",
        )
        # ... and every other stamp-stale row is untouched.
        self.assertEqual(
            [
                r["status"]
                for r in self.conn.execute(
                    "SELECT status FROM jobs WHERE dataset_id IN"
                    " ('nm000002','nm000003','nm000004')"
                )
            ],
            ["done", "done", "done"],
        )

    def test_a_blocked_run_leaves_the_next_run_free_to_apply(self):
        # Blocking must be a pause, not a state change: the same bump has to be
        # applyable by the acknowledged run that follows.
        reconcile(self.conn, self.catalog(), 3600, engine_requeue_limit=5)
        res = reconcile(
            self.conn, self.catalog(), 3600, engine_requeue_limit=5, engine_requeue_ack=True
        )
        self.assertEqual(res["engine_requeued"], 10)
        self.assertEqual(self.statuses(), ["pending"] * 10)

    def test_the_suppression_flag_reports_nothing_pending(self):
        # --no-engine-requeue is a deliberate "don't", not a blocked "can't", so
        # it must not read as a bump awaiting acknowledgment.
        res = reconcile(
            self.conn, self.catalog(), 3600, engine_requeue=False, engine_requeue_limit=5
        )
        self.assertFalse(res["engine_requeue_blocked"])
        self.assertEqual(res["engine_pending"], 0)
        self.assertEqual(res["engine_stale"], 10)
        self.assertEqual(self.statuses(), ["done"] * 10)


class DirFormatDetectionTest(unittest.TestCase):
    """#1172: which datasets the one-off sweep considers, and what it looks for.

    The detectors themselves are imported from `generate_zarr` rather than
    restated, so these assert the wiring and the exclusions that matter here --
    not a second copy of the format rules.
    """

    def test_meg_and_ieeg_are_the_carriers(self):
        for modalities in ("meg", "ieeg", "anat,meg", "beh,ieeg", "eeg,meg", "MEG"):
            self.assertTrue(may_carry_dir_formats(modalities), modalities)
        for modalities in ("eeg", "emg", "beh,eeg", "anat,eeg,func"):
            self.assertFalse(may_carry_dir_formats(modalities), modalities)

    def test_an_unknown_modality_is_probed_not_skipped(self):
        # A catalog row with no modalities is what an un-backfilled OpenNeuro
        # import looks like (nemar-cli#512) -- exactly the under-described shape
        # this sweep exists to find, so it must not be filtered out.
        self.assertTrue(may_carry_dir_formats(""))
        self.assertTrue(may_carry_dir_formats(None))
        self.assertTrue(may_carry_dir_formats("  ,  "))

    def test_directory_recordings_are_found_from_their_member_files(self):
        paths = {
            "sub-01/ieeg/sub-01_task-x_ieeg.mefd/c1.timd/c1-000000.segd/c1.tdat",
            "sub-02/meg/sub-02_task-y_meg.ds/sub-02_task-y_meg.meg4",
            "sub-03/meg/sub-03_task-z_meg/c,rfDC",
            "sub-03/meg/sub-03_task-z_meg/config",
            "sub-04/eeg/sub-04_task-w_eeg.set",
            "participants.tsv",
        }
        self.assertEqual(
            dir_format_recordings(paths),
            {
                "sub-01/ieeg/sub-01_task-x_ieeg.mefd",
                "sub-02/meg/sub-02_task-y_meg.ds",
                "sub-03/meg/sub-03_task-z_meg",
            },
        )

    def test_a_bare_config_file_is_not_a_bti_recording(self):
        # `.datalad/config` exists in virtually every dataset here; treating
        # `config` alone as the marker would report every repo as a stranded
        # BTi recording and requeue the archive.
        self.assertEqual(
            dir_format_recordings({".datalad/config", "dataset_description.json"}), set()
        )

    def test_excluded_trees_are_not_counted_as_missing(self):
        # The converter would not build these either (ADR 0027), so a dataset is
        # not stranded for lacking them.
        paths = {
            "derivatives/pipe/sub-01/meg/sub-01_task-x_meg.ds/x.meg4",
            "sourcedata/sub-01/ieeg/sub-01_task-x_ieeg.mefd/c1.timd/c1.tdat",
            "code/demo_meg.ds/x.meg4",
        }
        self.assertEqual(dir_format_recordings(paths), set())


class BackfillClassificationTest(unittest.TestCase):
    """#1172: is this dataset stranded, and on what evidence."""

    MEFD = "sub-01/ieeg/sub-01_task-x_ieeg.mefd"
    PATHS = {
        f"{MEFD}/c1.timd/c1-000000.segd/c1.tdat",
        "sub-01/eeg/sub-01_task-x_eeg.set",
        "participants.tsv",
    }

    ZARR = "sub-01/ieeg/sub-01_task-x_ieeg.zarr"

    def index(self, stores, failures=None):
        failures = failures or []
        return {
            "dataset_id": "on004696",
            "format": "nemar-zarr-index",
            "store_count": len(stores),
            "stores": stores,
            "failure_count": len(failures),
            "failures": failures,
        }

    def test_a_recorded_failure_is_not_a_discovery_miss(self):
        """The precision rule, found by running the sweep against production.

        A directory recording listed in `failures` was SEEN by the converter: the
        pre-#1095 engine could not have put it there, since it did not recognize
        the directory as a recording at all. Counting it as missing re-queues
        datasets whose `.ds` recordings a current engine has already tried and
        rejected -- on005752 alone would have re-queued 471 CTF MEG recordings.
        """
        doc = self.index(
            [{"path": "sub-01/eeg/x.set", "zarr": "sub-01/eeg/x.zarr"}],
            failures=[{"path": self.MEFD, "zarr": self.ZARR, "code": "unreadable"}],
        )
        got = classify_backfill("on004696", doc, self.PATHS)
        self.assertFalse(got["affected"], "a known failure is #1113's problem, not this one")
        self.assertEqual(got["reason"], "served")
        self.assertEqual(got["missing"], [])
        self.assertEqual(got["known_failed"], [self.MEFD])

    def test_the_two_buckets_are_reported_separately(self):
        # A dataset can have both, and the report must not merge them: one is
        # this sweep's business and the other is not.
        other = "sub-02/meg/sub-02_task-y_meg.ds"
        paths = set(self.PATHS) | {f"{other}/sub-02_task-y_meg.meg4"}
        doc = self.index(
            [{"path": "sub-01/eeg/x.set", "zarr": "sub-01/eeg/x.zarr"}],
            failures=[{"path": other, "zarr": "sub-02/meg/sub-02_task-y_meg.zarr"}],
        )
        unseen, failed = partition_dir_format_recordings(paths, doc)
        self.assertEqual(unseen, [self.MEFD])
        self.assertEqual(failed, [other])
        got = classify_backfill("on004696", doc, paths)
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "dir_stores_missing")

    def test_a_served_recording_is_in_neither_bucket(self):
        doc = self.index([{"path": self.MEFD, "zarr": self.ZARR}])
        self.assertEqual(partition_dir_format_recordings(self.PATHS, doc), ([], []))

    def test_a_failure_matched_by_its_zarr_rel_path_alone_still_counts(self):
        doc = self.index(
            [{"path": "sub-01/eeg/x.set", "zarr": "sub-01/eeg/x.zarr"}],
            failures=[{"zarr": self.ZARR}],
        )
        self.assertEqual(partition_dir_format_recordings(self.PATHS, doc), ([], [self.MEFD]))

    def test_index_failure_keys_reads_the_failures_list(self):
        paths, rels = index_failure_keys(
            {"failures": [{"path": "a.ds", "zarr": "a.zarr"}, "junk", {}]}
        )
        self.assertEqual(paths, {"a.ds"})
        self.assertEqual(rels, {"a.zarr"})
        self.assertEqual(index_failure_keys(None), (set(), set()))
        self.assertEqual(index_failure_keys({"stores": [{"path": "a.ds"}]}), (set(), set()))

    def test_an_empty_index_stays_affected_even_with_recorded_failures(self):
        # store_count 0 is decisive on its own; the failure list only refines
        # which recordings are named as unseen.
        doc = self.index([], failures=[{"path": self.MEFD, "zarr": self.ZARR}])
        got = classify_backfill("on004696", doc, self.PATHS)
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "empty_index")
        self.assertEqual(got["missing"], [])
        self.assertEqual(got["known_failed"], [self.MEFD])

    def test_no_published_index_at_all(self):
        got = classify_backfill("on004696", None)
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "index_missing")

    def test_the_reference_case_empty_index(self):
        # on004696 as observed: store_count 0, failure_count 0 -- the pre-#1095
        # engine saw the `.mefd` directories as nothing at all, so they landed in
        # neither list and the run was marked done.
        got = classify_backfill("on004696", self.index([]), self.PATHS)
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "empty_index")
        self.assertEqual(got["store_count"], 0)
        self.assertEqual(got["missing"], [self.MEFD])

    def test_an_empty_index_is_affected_even_without_a_probe(self):
        got = classify_backfill("on004696", self.index([]))
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "empty_index")
        self.assertEqual(got["missing"], [])

    def test_the_partial_case_some_stores_but_no_directory_store(self):
        # What rule (a) alone cannot see: an EEG store exists, so the index is
        # not empty, but the dataset's one `.mefd` recording was never converted.
        got = classify_backfill(
            "on004696",
            self.index(
                [
                    {
                        "path": "sub-01/eeg/sub-01_task-x_eeg.set",
                        "zarr": "sub-01/eeg/sub-01_task-x_eeg.zarr",
                    }
                ]
            ),
            self.PATHS,
        )
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "dir_stores_missing")
        self.assertEqual(got["missing"], [self.MEFD])

    def test_a_served_directory_recording_is_not_affected(self):
        got = classify_backfill(
            "on004696",
            self.index(
                [
                    {"path": self.MEFD, "zarr": "sub-01/ieeg/sub-01_task-x_ieeg.zarr"},
                    {
                        "path": "sub-01/eeg/sub-01_task-x_eeg.set",
                        "zarr": "sub-01/eeg/sub-01_task-x_eeg.zarr",
                    },
                ]
            ),
            self.PATHS,
        )
        self.assertFalse(got["affected"])
        self.assertEqual(got["reason"], "served")

    def test_a_store_matched_by_its_zarr_rel_path_alone_still_counts_as_served(self):
        # Either key identifies a store; a half-written entry must not be read
        # as a missing conversion and re-converted.
        got = classify_backfill(
            "on004696",
            self.index([{"zarr": "sub-01/ieeg/sub-01_task-x_ieeg.zarr"}]),
            self.PATHS,
        )
        self.assertFalse(got["affected"])

    def test_unprobed_is_reported_but_never_requeued(self):
        # `--no-probe` cannot rule out the partial case, and requeuing on an
        # unfinished check would re-convert datasets on no evidence.
        got = classify_backfill(
            "on004696",
            self.index([{"path": "sub-01/eeg/x.set", "zarr": "sub-01/eeg/x.zarr"}]),
        )
        self.assertFalse(got["affected"])
        self.assertEqual(got["reason"], "not_probed")

    def test_the_entries_outrank_a_disagreeing_store_count(self):
        # The viewer reads the entries, so judge the document by what it serves.
        doc = self.index([])
        doc["store_count"] = 7
        self.assertEqual(classify_backfill("on004696", doc)["store_count"], 0)

    def test_index_store_keys_tolerates_a_malformed_document(self):
        paths, rels = index_store_keys(
            {"stores": ["not-a-dict", {"path": "a.set"}, {"zarr": "b.zarr"}, {}]}
        )
        self.assertEqual(paths, {"a.set"})
        self.assertEqual(rels, {"b.zarr"})
        self.assertEqual(index_store_keys(None), (set(), set()))
        self.assertEqual(index_store_keys({}), (set(), set()))

    def test_missing_is_sorted_for_a_stable_report(self):
        paths = {
            "sub-02/meg/sub-02_meg.ds/x.meg4",
            "sub-01/ieeg/sub-01_ieeg.mefd/c1.timd/c1.tdat",
        }
        self.assertEqual(
            missing_dir_format_stores(paths, {"stores": []}),
            ["sub-01/ieeg/sub-01_ieeg.mefd", "sub-02/meg/sub-02_meg.ds"],
        )


class _CannedHTTPServer:
    """A real HTTP server on 127.0.0.1 serving scripted responses.

    Not a mock: the code under test makes genuine `urllib` calls over a genuine
    socket, and this decides only what comes BACK -- the same role a `respx`
    fixture plays for an HTTP client. It is the only way to exercise the retry
    classifier and the sweep's per-dataset error isolation without depending on
    api.nemar.org being sick in a particular way at test time.

    `routes` maps a path to either a list of (status, body) responses consumed
    one per request (so a flaky endpoint can be scripted), or a single one
    repeated. Requests are recorded so a test can assert how many attempts the
    retry actually made.
    """

    def __init__(self, routes: dict):
        self.routes = {p: (r if isinstance(r, list) else [r]) for p, r in routes.items()}
        self.requests: list[str] = []
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's API
                server.requests.append(self.path)
                scripted = server.routes.get(self.path.split("?")[0])
                if not scripted:
                    self.send_error(404, "no route")
                    return
                status, body = scripted[0] if len(scripted) == 1 else scripted.pop(0)
                if status >= 400:
                    self.send_error(status, "scripted")
                    return
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):  # keep the test output clean
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        # An explicit poll_interval, not the 0.5s default: `shutdown()` waits out
        # one interval, which would otherwise add half a second to every test here.
        self._thread = threading.Thread(
            target=lambda: self._httpd.serve_forever(poll_interval=0.01), daemon=True
        )

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)

    @property
    def base(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def count(self, path: str) -> int:
        return sum(1 for p in self.requests if p.split("?")[0] == path)


class RetryClassificationTest(unittest.TestCase):
    """#1172: which failures are worth another attempt, and which are answers."""

    def test_a_transient_5xx_is_retried_until_it_succeeds(self):
        routes = {"/x.json": [(503, None), (503, None), (200, {"ok": True})]}
        with _CannedHTTPServer(routes) as srv:
            got = _get_json_retrying(f"{srv.base}/x.json", timeout=5, backoff=0)
            self.assertEqual(got, {"ok": True})
            self.assertEqual(srv.count("/x.json"), 3)

    def test_a_5xx_that_never_clears_raises_after_the_budget(self):
        with _CannedHTTPServer({"/x.json": (500, None)}) as srv:
            with self.assertRaises(urllib.error.HTTPError):
                _get_json_retrying(f"{srv.base}/x.json", timeout=5, attempts=3, backoff=0)
            self.assertEqual(srv.count("/x.json"), 3)

    def test_a_404_is_an_answer_and_is_never_retried(self):
        # A 404 is a finding ("nothing was ever published here"), so spending
        # the retry budget on it would only slow the sweep down.
        with _CannedHTTPServer({"/x.json": (404, None)}) as srv:
            with self.assertRaises(urllib.error.HTTPError) as raised:
                _get_json_retrying(f"{srv.base}/x.json", timeout=5, backoff=0)
            self.assertEqual(raised.exception.code, 404)
            self.assertEqual(srv.count("/x.json"), 1)

    def test_a_403_is_not_retried_either(self):
        with _CannedHTTPServer({"/x.json": (403, None)}) as srv:
            with self.assertRaises(urllib.error.HTTPError):
                _get_json_retrying(f"{srv.base}/x.json", timeout=5, backoff=0)
            self.assertEqual(srv.count("/x.json"), 1)

    def test_the_index_fetch_reads_404_as_none_but_raises_on_500(self):
        routes = {"/on000001/zarr/index.json": (404, None), "/on000002/zarr/index.json": (500, None)}
        with _CannedHTTPServer(routes) as srv:
            self.assertIsNone(fetch_zarr_index(srv.base, "on000001", backoff=0))
            with self.assertRaises(urllib.error.HTTPError):
                fetch_zarr_index(srv.base, "on000002", backoff=0)

    def test_the_manifest_fetch_reads_404_as_none_but_raises_on_500(self):
        # None means "no published version to list", which is `not_probed` --
        # a permanent property of the dataset, not a transient failure to
        # re-examine on every future run.
        routes = {
            "/on000001/v1.0.0/manifest.json": (404, None),
            "/on000002/v1.0.0/manifest.json": (500, None),
            "/on000003/v1.0.0/manifest.json": (200, [{"path": "a.set"}, {"nope": 1}, "junk"]),
        }
        with _CannedHTTPServer(routes) as srv:
            self.assertIsNone(fetch_manifest_paths(srv.base, "on000001", "1.0.0", backoff=0))
            with self.assertRaises(urllib.error.HTTPError):
                fetch_manifest_paths(srv.base, "on000002", "1.0.0", backoff=0)
            self.assertEqual(
                fetch_manifest_paths(srv.base, "on000003", "v1.0.0", backoff=0), {"a.set"}
            )

    def test_a_bare_version_is_tagged_for_the_data_plane(self):
        routes = {"/on000001/v1.0.0/manifest.json": (200, [{"path": "a.set"}])}
        with _CannedHTTPServer(routes) as srv:
            fetch_manifest_paths(srv.base, "on000001", "1.0.0", backoff=0)
            self.assertEqual(srv.count("/on000001/v1.0.0/manifest.json"), 1)

    def test_no_version_falls_back_to_the_latest_alias(self):
        routes = {"/on000001/latest/manifest.json": (200, [{"path": "a.set"}])}
        with _CannedHTTPServer(routes) as srv:
            fetch_manifest_paths(srv.base, "on000001", "", backoff=0)
            self.assertEqual(srv.count("/on000001/latest/manifest.json"), 1)


class SweepOrchestrationTest(unittest.TestCase):
    """#1172: one sick dataset must not cost the sweep its other answers."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def catalog(self, *ids):
        return {
            "/datasets": (
                200,
                {
                    "datasets": [
                        {
                            "dataset_id": i,
                            "visibility": "public",
                            "modalities": "ieeg",
                            "latest_version": "v1.0.0",
                        }
                        for i in ids
                    ],
                    "total_count": len(ids),
                },
            )
        }

    def status(self, dataset_id):
        r = self.conn.execute(
            "SELECT status FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()
        return r["status"] if r else None

    def _seed_done(self, *ids):
        reconcile(self.conn, [(i, "v1.0.0") for i in ids], 3600)
        for dataset_id in ids:
            claim_next(self.conn)
            mark_done(self.conn, dataset_id, "v1.0.0")

    def test_exemplar_ids_are_counted_and_named_not_silently_dropped(self):
        # The staging catalog is the xx0999NN fleet. Without the opt-in the sweep
        # must say it refused them by id, not report candidates=0 as if the
        # archive were clean.
        routes = {**self.catalog("xx099905", "on000001"), "/on000001/zarr/index.json": (404, None)}
        out = io.StringIO()
        with _CannedHTTPServer(routes) as srv, contextlib.redirect_stdout(out):
            res = sweep_dir_format_backfill(self.conn, srv.base, srv.base, srv.base, sleep_seconds=0)
        self.assertEqual(res["candidates"], 1)
        self.assertEqual(res["id_rejected"], 1)
        self.assertEqual(res["id_rejected_sample"], ["xx099905"])
        self.assertIn("id_rejected=1 (xx099905)", out.getvalue())

    def test_accept_exemplars_admits_the_fleet_to_the_sweep(self):
        # Same catalog, opted in: the exemplar is examined like any nm/on row
        # (its index 404s, so it is affected) and nothing is refused by id.
        self._seed_done("on000001")
        reconcile(self.conn, [("xx099905", "v1.0.0")], 3600, accept_exemplars=True)
        claim_next(self.conn)
        mark_done(self.conn, "xx099905", "v1.0.0")
        routes = {
            **self.catalog("xx099905", "on000001"),
            "/xx099905/zarr/index.json": (404, None),
            "/on000001/zarr/index.json": (404, None),
        }
        with _CannedHTTPServer(routes) as srv, contextlib.redirect_stdout(io.StringIO()):
            res = sweep_dir_format_backfill(
                self.conn, srv.base, srv.base, srv.base, sleep_seconds=0, execute=True,
                accept_exemplars=True,
            )
        self.assertEqual(res["id_rejected"], 0)
        self.assertEqual(sorted(f["dataset_id"] for f in res["affected"]), ["on000001", "xx099905"])
        self.assertEqual(self.status("xx099905"), "pending")

    def test_a_failing_dataset_is_recorded_and_the_sweep_continues(self):
        # on000001's index 404s (affected: nothing was ever published);
        # on000002's index 403s, which reaches the handler without spending the
        # retry budget, so this asserts orchestration rather than timing.
        self._seed_done("on000001", "on000002")
        routes = {
            **self.catalog("on000001", "on000002"),
            "/on000001/zarr/index.json": (404, None),
            "/on000002/zarr/index.json": (403, None),
        }
        with _CannedHTTPServer(routes) as srv, contextlib.redirect_stdout(io.StringIO()):
            res = sweep_dir_format_backfill(
                self.conn, srv.base, srv.base, srv.base, sleep_seconds=0, execute=True
            )
        self.assertEqual([f["dataset_id"] for f in res["affected"]], ["on000001"])
        self.assertEqual([e[0] for e in res["errors"]], ["on000002"])
        self.assertEqual(res["examined"], 2)
        # Only the answered dataset is touched; the one we could not read is
        # left exactly as it was.
        self.assertEqual(self.status("on000001"), "pending")
        self.assertEqual(self.status("on000002"), "done")
        self.assertEqual(res["requeued"], ["on000001"])

    def test_the_cli_exits_non_zero_when_a_dataset_could_not_be_examined(self):
        """A sweep that could not read some datasets did not answer for them.

        Reporting "nothing affected" with exit 0 would let a scripted run record
        a clean bill of health for datasets it never saw.
        """
        self._seed_done("on000001")
        routes = {**self.catalog("on000001"), "/on000001/zarr/index.json": (403, None)}
        with _CannedHTTPServer(routes) as srv:
            argv = [
                "zarr_queue.py",
                "--db",
                os.path.join(self._tmp.name, "q.db"),
                "backfill-dir-formats",
                "--api-base",
                srv.base,
                "--data-base",
                srv.base,
                "--zarr-base",
                srv.base,
                "--sleep",
                "0",
            ]
            saved, sys.argv = sys.argv, argv
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), 1)
            finally:
                sys.argv = saved

    def test_execute_never_touches_a_row_that_is_not_done(self):
        """The "no-op by construction" claim, asserted rather than assumed.

        `requeue` filters on status itself, so an affected dataset that is
        mid-flight or terminal must come back reported and untouched.
        """
        reconcile(self.conn, [("on000001", "v1.0.0"), ("on000002", "v1.0.0")], 3600)
        claim_next(self.conn)  # on000001 -> inprogress
        claim_next(self.conn)
        mark_fail(self.conn, "on000002", "unreadable", 5, 1800, deterministic=True)
        self.assertEqual((self.status("on000001"), self.status("on000002")),
                         ("inprogress", "data_failed"))
        routes = {
            **self.catalog("on000001", "on000002"),
            "/on000001/zarr/index.json": (404, None),
            "/on000002/zarr/index.json": (404, None),
        }
        with _CannedHTTPServer(routes) as srv, contextlib.redirect_stdout(io.StringIO()):
            res = sweep_dir_format_backfill(
                self.conn, srv.base, srv.base, srv.base, sleep_seconds=0, execute=True
            )
        self.assertEqual(len(res["affected"]), 2)
        self.assertEqual(res["requeued"], [])
        self.assertEqual(
            sorted(res["not_requeued"]), [("on000001", "inprogress"), ("on000002", "data_failed")]
        )
        self.assertEqual(self.status("on000001"), "inprogress")
        self.assertEqual(self.status("on000002"), "data_failed")

    def test_an_unprobed_dataset_is_counted_in_the_summary(self):
        # A dataset that serves stores but cannot be probed is neither affected
        # nor an error; without the not_probed count a --no-probe run would read
        # as a clean bill of health.
        self._seed_done("on000001")
        routes = {
            **self.catalog("on000001"),
            "/on000001/zarr/index.json": (
                200,
                {"store_count": 1, "stores": [{"path": "a.set", "zarr": "a.zarr"}], "failures": []},
            ),
            "/on000001/v1.0.0/manifest.json": (404, None),
        }
        with _CannedHTTPServer(routes) as srv, contextlib.redirect_stdout(io.StringIO()):
            res = sweep_dir_format_backfill(
                self.conn, srv.base, srv.base, srv.base, sleep_seconds=0
            )
        self.assertEqual(res["affected"], [])
        self.assertEqual([f["dataset_id"] for f in res["not_probed"]], ["on000001"])

    def test_a_non_meg_ieeg_dataset_is_never_examined(self):
        routes = {
            "/datasets": (
                200,
                {
                    "datasets": [
                        {
                            "dataset_id": "nm000001",
                            "visibility": "public",
                            "modalities": "eeg",
                            "latest_version": "v1.0.0",
                        }
                    ],
                    "total_count": 1,
                },
            )
        }
        with _CannedHTTPServer(routes) as srv, contextlib.redirect_stdout(io.StringIO()):
            res = sweep_dir_format_backfill(
                self.conn, srv.base, srv.base, srv.base, sleep_seconds=0
            )
            self.assertEqual(srv.count("/nm000001/zarr/index.json"), 0)
        self.assertEqual((res["candidates"], res["examined"]), (0, 0))


class EngineBumpCliTest(unittest.TestCase):
    """The operator-visible half of the guard: what the cron actually sees.

    hallu-zarr.sh captures reconcile's stdout into one log line and lets stderr
    through separately, then greps the former to re-raise the notice as its own
    ERROR line. Both streams are asserted here because the shell needs both.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self._tmp.name, "q.db")
        conn = connect(self.db)
        self.ids = [f"nm{n:06d}" for n in range(1, 11)]
        reconcile(conn, [(i, "v1.0.0") for i in self.ids], 3600)
        for dataset_id in self.ids:
            claim_next(conn)
            mark_done(conn, dataset_id, "v1.0.0", engine_version="1")
        conn.close()

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, *extra):
        routes = {
            "/datasets": (
                200,
                {
                    "datasets": [
                        {
                            "dataset_id": i,
                            "visibility": "public",
                            "modalities": "ieeg",
                            "latest_version": "v1.0.0",
                        }
                        for i in self.ids
                    ],
                    "total_count": len(self.ids),
                },
            )
        }
        out, errbuf = io.StringIO(), io.StringIO()
        with _CannedHTTPServer(routes) as srv:
            argv = ["zarr_queue.py", "--db", self.db, "reconcile", "--api-base", srv.base, *extra]
            saved, sys.argv = sys.argv, argv
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(errbuf):
                    code = main()
            finally:
                sys.argv = saved
        return code, out.getvalue(), errbuf.getvalue()

    def statuses(self):
        conn = connect(self.db)
        self.addCleanup(conn.close)
        return [r["status"] for r in conn.execute("SELECT status FROM jobs ORDER BY dataset_id")]

    def test_a_blocked_bump_is_announced_on_both_streams(self):
        code, out, err = self._run("--engine-requeue-limit", "5")
        self.assertEqual(code, 0)  # not an error: the queue is fine, it just waited
        self.assertIn("ENGINE BUMP PENDING ACK", out)
        self.assertIn("ENGINE BUMP PENDING ACK", err)
        self.assertIn("engine_requeued=0", out)
        self.assertEqual(self.statuses(), ["done"] * 10)

    def test_the_ack_flag_applies_it(self):
        code, out, _ = self._run("--engine-requeue-limit", "5", "--engine-requeue-ack")
        self.assertEqual(code, 0)
        self.assertNotIn("ENGINE BUMP PENDING ACK", out)
        self.assertIn("engine_requeued=10", out)
        self.assertEqual(self.statuses(), ["pending"] * 10)

    def test_a_zero_limit_disables_the_guard(self):
        # 0 spells "no guard" on a CLI where None cannot be typed.
        code, out, _ = self._run("--engine-requeue-limit", "0")
        self.assertEqual(code, 0)
        self.assertIn("engine_requeued=10", out)

    def test_the_routine_line_reports_the_stamp_even_when_nothing_is_stale(self):
        # A steady `engine_stale=0` in the cron log is what makes the run that
        # says otherwise legible.
        self._run("--engine-requeue-limit", "5", "--engine-requeue-ack")
        code, out, _ = self._run("--engine-requeue-limit", "5")
        self.assertEqual(code, 0)
        self.assertIn(f"engine={ZARR_ENGINE_VERSION}", out)
        self.assertIn("engine_stale=0", out)


if __name__ == "__main__":
    unittest.main()
