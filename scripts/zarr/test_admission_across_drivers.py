#!/usr/bin/env python3
"""Tests for admission across drivers (ADR 0102): `_drain_with_admission` with a
shared `admission_ledger.Ledger`.

A "peer driver" is a live child process whose reservations the ledger reads, the way
it reads another hallu-zarr.sh slot's; the drain under test runs in this process or,
for the end-to-end class, in two real processes at once. Nothing is mocked: the
ceiling and the scratch budget are injected (the same hooks `TestAdmissionFollows
TheCeiling` uses, standing in for a node's memory), and everything else is the real
code and the real ledger files.

Run:
    python scripts/zarr/test_admission_across_drivers.py
    uv run --with pytest pytest scripts/zarr/test_admission_across_drivers.py
"""

from __future__ import annotations

import contextlib
import io
import itertools
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import admission_ledger
import generate_zarr
from admission_ledger import Ledger
from generate_zarr import (
    PEER_DEFERRAL_MESSAGE,
    _drain_with_admission,
    close_ledger,
    ledger_from_env,
    tracked_taken_bytes,
)

LINUX = sys.platform.startswith("linux")
HERE = os.path.dirname(os.path.abspath(__file__))


def _timed_worker(primary, peak_bytes=None):
    """Takes long enough for admission to matter and says when it ran. Module-level
    so it pickles to a spawned child."""
    started = time.monotonic()
    time.sleep(0.5)
    return {
        "ok": True,
        "primary": primary,
        "entry": {"zarr": primary + ".zarr"},
        "span": (started, time.monotonic()),
    }


def _primaries(n):
    return [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, n + 1)]


class DrainAgainstPeersCase(unittest.TestCase):
    CEILING = 300
    RESERVE = 100

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = os.path.join(self._tmp.name, "ledger")
        self._children: list[subprocess.Popen] = []
        self.addCleanup(self._reap)
        for name in ("ADMISSION_RECHECK_SECONDS", "LEDGER_WAIT_SECONDS"):
            self.addCleanup(setattr, generate_zarr, name, getattr(generate_zarr, name))
        self.addCleanup(
            setattr, admission_ledger, "STARVATION_SECONDS", admission_ledger.STARVATION_SECONDS
        )
        generate_zarr.ADMISSION_RECHECK_SECONDS = 0.05
        generate_zarr.LEDGER_WAIT_SECONDS = 30.0

    def _reap(self):
        for child in self._children:
            if child.poll() is None:
                child.kill()
            child.wait()

    def peer(self, ram=0, scratch=0, paths=(), track_dir=None, waiting_since=None):
        """A live peer driver that holds one reservation (when ``ram`` or ``scratch``)."""
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self._children.append(child)
        deadline = time.monotonic() + 5
        while LINUX and admission_ledger.process_start_ticks(child.pid) is None:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        peer = Ledger(self.root, pid=child.pid)
        with peer.exclusive():
            if track_dir is not None:
                peer.set_track_dir(track_dir)
            if ram or scratch:
                peer.reserve(ram, scratch, list(paths))
            if waiting_since is not None:
                peer.mark_waiting(True, now=waiting_since)
        return peer

    def drain(self, n=3, ceiling=None, ledger="own", deferred=None, **kwargs):
        """Drain ``n`` recordings of RESERVE each; returns their sorted spans."""
        primaries = _primaries(n)
        results = []
        fixed = self.CEILING if ceiling is None else ceiling
        own = Ledger(self.root) if ledger == "own" else ledger
        try:
            _drain_with_admission(
                primaries, dict.fromkeys(primaries, self.RESERVE), 3, 10**12, {},
                lambda r, i: results.append(r), worker=_timed_worker,
                ceiling=lambda running_peak, track_dir: fixed, ledger=own,
                deferred=deferred, **kwargs,
            )
        finally:
            if own is not None:
                close_ledger(own)
        return sorted(r["span"] for r in results if r.get("ok"))

    @staticmethod
    def overlapping(spans):
        """The most recordings that were running at the same moment."""
        events = sorted(
            itertools.chain(((a, 1) for a, _ in spans), ((b, -1) for _, b in spans)),
            key=lambda e: (e[0], e[1]),
        )
        running = best = 0
        for _, step in events:
            running += step
            best = max(best, running)
        return best


class TestPeersReservesComeOffTheBudget(DrainAgainstPeersCase):
    def test_alone_all_three_run_at_once(self):
        spans = self.drain()
        self.assertEqual(len(spans), 3)
        self.assertEqual(self.overlapping(spans), 3)

    def test_a_peers_unspent_reserve_is_subtracted_from_the_ceiling(self):
        self.peer(ram=100)  # 300 - 100 leaves room for two of the three
        spans = self.drain()
        self.assertEqual(len(spans), 3)
        self.assertEqual(self.overlapping(spans), 2)

    @unittest.skipUnless(LINUX, "reads the worker's RssAnon from /proc")
    def test_what_a_peers_worker_has_already_taken_is_credited(self):
        # This process stands in for the peer's worker: the "peer" says its worker
        # started at 0 bytes of anonymous memory, so it has taken at least its
        # whole (tiny) reserve, and nothing more is owed.
        track = os.path.join(self._tmp.name, "peer-track")
        os.makedirs(track)
        with open(os.path.join(track, f"{os.getpid()}.json"), "w") as fh:
            json.dump({"reserve": 100, "rss_anon_start": 0}, fh)
        self.peer(ram=100, track_dir=track)
        self.assertEqual(tracked_taken_bytes(track, 100), 100)
        spans = self.drain()
        self.assertEqual(self.overlapping(spans), 3)

    def test_a_peers_unspent_scratch_is_subtracted_from_the_budget(self):
        primaries = _primaries(3)
        peaks = dict.fromkeys(primaries, 400)
        self.peer(ram=1, scratch=300)  # of 1000, 300 is spoken for: one 400 fits twice
        results = []
        own = Ledger(self.root)
        _drain_with_admission(
            primaries, dict.fromkeys(primaries, 1), 3, 10**12, {},
            lambda r, i: results.append(r), worker=_timed_worker,
            ceiling=lambda running_peak, track_dir: 10**12, ledger=own,
            scratch_peaks=peaks, scratch_budget=lambda in_flight: 1000,
        )
        close_ledger(own)
        spans = sorted(r["span"] for r in results)
        self.assertEqual(len(spans), 3)
        self.assertEqual(self.overlapping(spans), 1)  # 300 + 400 + 400 > 1000

    def test_scratch_a_peer_already_holds_on_disk_is_not_charged_again(self):
        primaries = _primaries(3)
        held = os.path.join(self._tmp.name, "peer-recording")
        os.makedirs(held)
        with open(os.path.join(held, "blob"), "wb") as fh:
            fh.write(os.urandom(1 << 20))
        on_disk = generate_zarr.allocated_bytes(held)
        self.assertGreater(on_disk, 0)
        # The peer reserved exactly what it holds, so nothing is owed.
        self.peer(ram=1, scratch=on_disk, paths=[held])
        results = []
        own = Ledger(self.root)
        _drain_with_admission(
            primaries, dict.fromkeys(primaries, 1), 3, 10**12, {},
            lambda r, i: results.append(r), worker=_timed_worker,
            ceiling=lambda running_peak, track_dir: 10**12, ledger=own,
            scratch_peaks=dict.fromkeys(primaries, 400), scratch_budget=lambda f: 1000,
        )
        close_ledger(own)
        self.assertEqual(self.overlapping(sorted(r["span"] for r in results)), 2)

    def test_a_dead_peer_reserves_nothing(self):
        peer = self.peer(ram=300)
        child = self._children[-1]
        child.kill()
        child.wait()
        del peer
        spans = self.drain()
        self.assertEqual(self.overlapping(spans), 3)


class TestRunAloneNeedsTheWholeNodeToBeIdle(DrainAgainstPeersCase):
    BIG = 500  # more than the ceiling, so only the run-alone exception admits it

    def run_big(self, release_after=None, **kwargs):
        primaries = _primaries(1)
        results = []
        peer = None
        if release_after is not None:
            peer = self.peer(ram=100)
            timer = threading.Timer(release_after, lambda: self._release(peer))
            timer.start()
            self.addCleanup(timer.cancel)
        own = Ledger(self.root)
        began = time.monotonic()
        _drain_with_admission(
            primaries, {primaries[0]: self.BIG}, 3, 10**12, {},
            lambda r, i: results.append(r), worker=_timed_worker,
            ceiling=lambda running_peak, track_dir: self.CEILING, ledger=own, **kwargs,
        )
        close_ledger(own)
        return began, results

    @staticmethod
    def _release(peer):
        with peer.exclusive():
            peer.release_all()

    def test_alone_an_oversized_recording_runs_at_once(self):
        began, results = self.run_big()
        self.assertEqual(len(results), 1)
        self.assertLess(results[0]["span"][0] - began, 0.3)

    def test_with_a_peer_holding_something_it_waits_for_the_peer_to_finish(self):
        began, results = self.run_big(release_after=0.5)
        self.assertEqual(len(results), 1)
        self.assertGreaterEqual(results[0]["span"][0] - began, 0.45)


class TestWaitingEndsInADeferral(DrainAgainstPeersCase):
    def test_a_wait_that_outlasts_the_limit_hands_the_queue_back(self):
        generate_zarr.LEDGER_WAIT_SECONDS = 0.3
        self.peer(ram=300)  # holds the whole ceiling for as long as the test runs
        deferred: dict = {}
        began = time.monotonic()
        spans = self.drain(deferred=deferred)
        self.assertEqual(spans, [])
        self.assertEqual(set(deferred), set(_primaries(3)))
        self.assertTrue(all(m == PEER_DEFERRAL_MESSAGE for m in deferred.values()))
        self.assertTrue(PEER_DEFERRAL_MESSAGE.startswith(generate_zarr._DEFERRED_PREFIX))
        self.assertLess(time.monotonic() - began, 5)

    def test_it_is_not_given_up_while_the_peer_can_still_finish(self):
        generate_zarr.LEDGER_WAIT_SECONDS = 5.0
        peer = self.peer(ram=300)
        timer = threading.Timer(0.4, lambda: TestRunAloneNeedsTheWholeNodeToBeIdle._release(peer))
        timer.start()
        self.addCleanup(timer.cancel)
        deferred: dict = {}
        spans = self.drain(deferred=deferred)
        self.assertEqual(len(spans), 3)
        self.assertEqual(deferred, {})

    def test_a_peer_waiting_longer_goes_first(self):
        admission_ledger.STARVATION_SECONDS = 60.0
        generate_zarr.LEDGER_WAIT_SECONDS = 0.3
        peer = self.peer(waiting_since=time.time() - 3600)  # holds nothing, waits longest
        deferred: dict = {}
        spans = self.drain(deferred=deferred)
        self.assertEqual(spans, [])
        self.assertEqual(len(deferred), 3)
        with peer.exclusive():
            peer.mark_waiting(False)
        self.assertEqual(len(self.drain()), 3)

    def test_a_peer_that_has_not_waited_long_is_not_deferred_to(self):
        admission_ledger.STARVATION_SECONDS = 3600.0
        self.peer(waiting_since=time.time() - 5)
        self.assertEqual(len(self.drain()), 3)


class TestEveryAdmissionIsVisibleToPeers(DrainAgainstPeersCase):
    def test_reservations_exist_while_recordings_run_and_not_after(self):
        observer_child = self.peer()  # a live peer that only looks
        observer = Ledger(self.root, pid=observer_child.pid)
        seen: list[int] = []
        stop = threading.Event()

        def watch():
            while not stop.is_set():
                with observer.exclusive():
                    mine = [d for d in observer.peers() if d["pid"] == os.getpid()]
                seen.append(sum(len(d["reservations"]) for d in mine))
                time.sleep(0.02)

        thread = threading.Thread(target=watch)
        thread.start()
        try:
            spans = self.drain()
        finally:
            stop.set()
            thread.join()
        self.assertEqual(len(spans), 3)
        self.assertEqual(max(seen), 3)
        with observer.exclusive():
            self.assertEqual(observer.peers(), [])  # withdrawn at the end


class TestLedgerFromEnv(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(os.environ.pop, "ZARR_LEDGER_DIR", None)
        os.environ.pop("ZARR_LEDGER_DIR", None)

    def test_unset_means_no_ledger(self):
        self.assertIsNone(ledger_from_env())
        os.environ["ZARR_LEDGER_DIR"] = "  "
        self.assertIsNone(ledger_from_env())

    def test_a_directory_is_created_and_used(self):
        root = os.path.join(self._tmp.name, "a", "b")
        os.environ["ZARR_LEDGER_DIR"] = root
        ledger = ledger_from_env()
        self.assertIsNotNone(ledger)
        self.assertTrue(os.path.isdir(root))

    def test_an_unusable_directory_is_reported_and_the_driver_runs_without(self):
        blocker = os.path.join(self._tmp.name, "file")
        with open(blocker, "w") as fh:
            fh.write("x")
        os.environ["ZARR_LEDGER_DIR"] = os.path.join(blocker, "ledger")
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            self.assertIsNone(ledger_from_env())
        self.assertIn("::error::cannot use the admission ledger", captured.getvalue())


HELPER = textwrap.dedent(
    '''
    """One driver process of TestTwoDriversShareTheNode."""
    import json
    import os
    import sys
    import time

    sys.path.insert(0, {here!r})
    import generate_zarr as gz
    from admission_ledger import Ledger


    def worker(primary, peak_bytes=None):
        started = time.time()
        time.sleep(0.4)
        record = {{"primary": primary, "reserve": peak_bytes,
                   "start": started, "end": time.time()}}
        name = primary.replace("/", "_") + ".json"
        with open(os.path.join(os.environ["LEDGER_TEST_OUT"], name), "w") as fh:
            json.dump(record, fh)
        return {{"ok": True, "primary": primary, "entry": {{}}}}


    def main(root, tag, count, use_ledger):
        gz.ADMISSION_RECHECK_SECONDS = 0.05
        ledger = Ledger(root) if use_ledger == "yes" else None
        primaries = [f"{{tag}}/sub-{{i:02d}}/eeg/x_eeg.set" for i in range(int(count))]
        go = os.environ["LEDGER_TEST_GO"]
        while not os.path.exists(go):  # start together, however long the imports took
            time.sleep(0.005)
        gz._drain_with_admission(
            primaries, dict.fromkeys(primaries, 40 * 1024**3), 4, 100 * 1024**3, {{}},
            lambda r, i: None, worker=worker,
            ceiling=lambda running_peak, track_dir: 100 * 1024**3, ledger=ledger,
        )
        gz.close_ledger(ledger)


    if __name__ == "__main__":
        main(*sys.argv[1:])
    '''
)


class TestTwoDriversShareTheNode(unittest.TestCase):
    """Two real driver processes, one node of 100 GiB, recordings reserving 40 GiB:
    with the ledger never more than two (80 GiB) run at once between them; without it
    each driver admits two on its own reading of the node and four (160 GiB) do.

    GiB, not bytes, because a peer's reserve is credited for the anonymous memory its
    workers have actually taken (that memory is already out of MemAvailable). The
    ceiling here is a constant standing in for MemAvailable, so it does not shrink
    as workers grow, and a reserve small enough for a Python process's own footprint
    to cover would be credited in full."""

    COUNT = 10
    GIB = 1024**3

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.helper = os.path.join(self._tmp.name, "driver_helper.py")
        with open(self.helper, "w") as fh:
            fh.write(HELPER.format(here=HERE))

    def run_two(self, use_ledger):
        out = os.path.join(self._tmp.name, f"out-{use_ledger}")
        root = os.path.join(self._tmp.name, f"ledger-{use_ledger}")
        go = os.path.join(self._tmp.name, f"go-{use_ledger}")
        os.makedirs(out)
        env = {**os.environ, "LEDGER_TEST_OUT": out, "LEDGER_TEST_GO": go}
        procs = [
            subprocess.Popen(
                [sys.executable, self.helper, root, tag, str(self.COUNT), use_ledger], env=env
            )
            for tag in ("a", "b")
        ]
        try:
            time.sleep(1.0)  # let both finish importing before either starts
            open(go, "w").close()
            for proc in procs:
                self.assertEqual(proc.wait(timeout=180), 0)
        finally:
            for proc in procs:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        records = []
        for name in os.listdir(out):
            with open(os.path.join(out, name)) as fh:
                records.append(json.load(fh))
        self.assertEqual(len(records), 2 * self.COUNT)
        return records, root

    @staticmethod
    def most_reserved_at_once(records):
        events = sorted(
            itertools.chain(
                ((r["start"], r["reserve"]) for r in records),
                ((r["end"], -r["reserve"]) for r in records),
            ),
            key=lambda e: (e[0], e[1]),
        )
        running = best = 0
        for _, step in events:
            running += step
            best = max(best, running)
        return best

    def test_with_the_ledger_the_node_is_never_oversubscribed(self):
        records, root = self.run_two("yes")
        self.assertLessEqual(self.most_reserved_at_once(records), 100 * self.GIB)
        self.assertGreaterEqual(
            self.most_reserved_at_once(records), 80 * self.GIB, "the drivers never overlapped"
        )
        self.assertEqual([n for n in os.listdir(root) if n.endswith(".json")], [])

    def test_without_it_each_driver_assumes_the_node_is_its_own(self):
        records, _ = self.run_two("no")
        self.assertGreater(self.most_reserved_at_once(records), 100 * self.GIB)


if __name__ == "__main__":
    unittest.main()
