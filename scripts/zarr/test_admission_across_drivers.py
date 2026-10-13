#!/usr/bin/env python3
"""Tests for admission across drivers (ADR 0101): `_drain_with_admission` with a
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
import shutil
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

    def peer(
        self, ram=0, scratch=0, paths=(), track_dir=None, waiting_since=None, blocked_by=None
    ):
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
                peer.mark_waiting(True, now=waiting_since, blocked_by=blocked_by)
        return peer

    def drain(self, n=3, ceiling=None, ledger="own", deferred=None, ctx=None, **kwargs):
        """Drain ``n`` recordings of RESERVE each; returns their sorted spans."""
        primaries = _primaries(n)
        results = []
        fixed = self.CEILING if ceiling is None else ceiling
        own = Ledger(self.root) if ledger == "own" else ledger
        try:
            _drain_with_admission(
                primaries, dict.fromkeys(primaries, self.RESERVE), 3, 10**12, ctx or {},
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
        # Holds nothing, waits longest, and is waiting for this process.
        peer = self.peer(waiting_since=time.time() - 3600, blocked_by={os.getpid()})
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


class TestOnlyTheDriversInTheWaitersWayStop(DrainAgainstPeersCase):
    def test_a_driver_the_waiter_is_not_waiting_for_keeps_admitting(self):
        admission_ledger.STARVATION_SECONDS = 60.0
        generate_zarr.LEDGER_WAIT_SECONDS = 5.0
        self.peer(ram=100)  # holds a share of the ceiling, as the real blocker would
        self.peer(waiting_since=time.time() - 3600, blocked_by={1})  # waits for pid 1
        deferred: dict = {}
        spans = self.drain(deferred=deferred)
        self.assertEqual(len(spans), 3)
        self.assertEqual(deferred, {})

    def test_the_driver_the_waiter_is_waiting_for_stops_so_the_waiter_can_run(self):
        admission_ledger.STARVATION_SECONDS = 60.0
        generate_zarr.LEDGER_WAIT_SECONDS = 0.3
        self.peer(waiting_since=time.time() - 3600, blocked_by={os.getpid()})
        deferred: dict = {}
        spans = self.drain(deferred=deferred)
        self.assertEqual(spans, [])
        self.assertEqual(len(deferred), 3)


class TestAloneMeansWithoutThePeersDisk(DrainAgainstPeersCase):
    """The free space of the volume already excludes what the peers have written. A
    recording that would fit if they were gone is held up by them, not unfit."""

    MIB = 1 << 20

    def test_a_recording_that_fits_once_the_peers_are_gone_waits_instead_of_deferring(self):
        primaries = _primaries(1)
        held_dir = os.path.join(self._tmp.name, "peer-recording")
        os.makedirs(held_dir)
        with open(os.path.join(held_dir, "blob"), "wb") as fh:
            fh.write(os.urandom(self.MIB))
        total = int(5.75 * self.MIB)

        def free_now(in_flight):  # the volume: what the peer holds is not free
            return total - generate_zarr.allocated_bytes(held_dir)

        # Free is ~4.75 MiB, the recording is charged 5. The peer reserved 3 and holds 1,
        # so 2 are still owed: with it there are 2.75 to admit into, without it 5.75.
        peer = self.peer(ram=1, scratch=3 * self.MIB, paths=[held_dir])

        def peer_finishes():
            with peer.exclusive():
                peer.release_all()
            shutil.rmtree(held_dir)

        timer = threading.Timer(0.5, peer_finishes)
        timer.start()
        self.addCleanup(timer.cancel)
        results: list = []
        deferred: dict = {}
        own = Ledger(self.root)
        _drain_with_admission(
            primaries, dict.fromkeys(primaries, 1), 3, 10**12, {},
            lambda r, i: results.append(r), worker=_timed_worker,
            ceiling=lambda running_peak, track_dir: 10**12, ledger=own,
            scratch_peaks={primaries[0]: 5 * self.MIB}, scratch_budget=free_now,
            deferred=deferred,
        )
        close_ledger(own)
        self.assertEqual(deferred, {})
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0]["ok"])

    def test_a_recording_that_does_not_fit_even_alone_is_still_deferred(self):
        primaries = _primaries(1)
        deferred: dict = {}
        own = Ledger(self.root)
        self.peer(ram=1, scratch=1, paths=[])
        _drain_with_admission(
            primaries, dict.fromkeys(primaries, 1), 3, 10**12, {}, lambda r, i: None,
            worker=_timed_worker, ceiling=lambda running_peak, track_dir: 10**12,
            ledger=own, scratch_peaks={primaries[0]: 5 * self.MIB},
            scratch_budget=lambda in_flight: self.MIB, deferred=deferred,
        )
        close_ledger(own)
        self.assertEqual(set(deferred), set(primaries))
        self.assertTrue(deferred[primaries[0]].startswith("deferred: needs "))
        self.assertNotEqual(deferred[primaries[0]], PEER_DEFERRAL_MESSAGE)


class TestALedgerThatCannotBeUsed(DrainAgainstPeersCase):
    def test_one_that_stops_working_mid_run_ends_the_wait_in_a_deferral_not_a_traceback(self):
        generate_zarr.LEDGER_WAIT_SECONDS = 0.4
        lock = os.path.join(self.root, ".lock")

        def break_it():
            os.remove(lock)
            os.makedirs(lock)  # opening a directory fails the way EMFILE or EIO would

        timer = threading.Timer(0.2, break_it)
        timer.start()
        self.addCleanup(timer.cancel)
        deferred: dict = {}
        # Room for one recording at a time: the first runs, the rest wait their turn.
        spans = self.drain(ceiling=150, deferred=deferred)
        self.assertEqual(len(spans), 1)  # the one in flight when it broke was reported
        self.assertEqual(len(deferred), 2)
        self.assertTrue(all(m == generate_zarr.LEDGER_UNUSABLE_MESSAGE for m in deferred.values()))

    def test_one_that_cannot_be_written_from_the_start_defers_instead_of_raising(self):
        generate_zarr.LEDGER_WAIT_SECONDS = 0.3
        own = Ledger(self.root)
        os.makedirs(os.path.join(own._path, "x"))  # os.replace onto this fails
        deferred: dict = {}
        spans = self.drain(ledger=own, deferred=deferred)
        self.assertEqual(spans, [])
        self.assertEqual(len(deferred), 3)
        self.assertTrue(PEER_DEFERRAL_MESSAGE != generate_zarr.LEDGER_UNUSABLE_MESSAGE)
        self.assertTrue(all(m == generate_zarr.LEDGER_UNUSABLE_MESSAGE for m in deferred.values()))

    def test_a_lock_a_live_peer_holds_for_good_ends_in_a_deferral(self):
        for name in ("LOCK_TIMEOUT_SECONDS",):
            self.addCleanup(setattr, admission_ledger, name, getattr(admission_ledger, name))
        admission_ledger.LOCK_TIMEOUT_SECONDS = 0.1
        generate_zarr.LEDGER_WAIT_SECONDS = 0.5
        os.makedirs(self.root, exist_ok=True)
        code = (
            "import fcntl, sys, time\n"
            "fh = open(sys.argv[1], 'w')\n"
            "fcntl.flock(fh, fcntl.LOCK_EX)\n"
            "print('held', flush=True)\n"
            "time.sleep(120)\n"
        )
        holder = subprocess.Popen(
            [sys.executable, "-c", code, os.path.join(self.root, ".lock")],
            stdout=subprocess.PIPE, text=True,
        )
        self._children.append(holder)
        self.assertEqual(holder.stdout.readline().strip(), "held")
        deferred: dict = {}
        began = time.monotonic()
        spans = self.drain(deferred=deferred)
        self.assertEqual(spans, [])
        self.assertEqual(len(deferred), 3)
        self.assertLess(time.monotonic() - began, 10)


class TestConvertsInProcess(unittest.TestCase):
    def test_one_worker_without_a_ledger_converts_here(self):
        self.assertTrue(generate_zarr.converts_in_process(1, None, ["a"]))

    def test_one_worker_with_a_ledger_goes_through_the_pool_so_its_peers_see_it(self):
        ledger = Ledger(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, ledger.root, ignore_errors=True)
        self.assertFalse(generate_zarr.converts_in_process(1, ledger, ["a"]))

    def test_several_workers_always_use_the_pool_and_nothing_to_convert_never_does(self):
        self.assertFalse(generate_zarr.converts_in_process(4, None, ["a"]))
        self.assertTrue(generate_zarr.converts_in_process(4, None, []))
        self.assertTrue(generate_zarr.converts_in_process(1, Ledger(tempfile.mkdtemp()), []))


class TestEveryAdmissionIsVisibleToPeers(DrainAgainstPeersCase):
    """What a real drain publishes, read the way a peer reads it."""

    def watch(self, observer, seen, stop):
        while not stop.is_set():
            with observer.exclusive():
                mine = [d for d in observer.peers() if d["pid"] == os.getpid()]
            seen.extend(mine)
            time.sleep(0.02)

    def test_reservations_exist_while_recordings_run_and_not_after(self):
        observer_child = self.peer()  # a live peer that only looks
        observer = Ledger(self.root, pid=observer_child.pid)
        scratch = os.path.join(self._tmp.name, "scratch")
        os.makedirs(scratch)
        seen: list[dict] = []
        stop = threading.Event()
        thread = threading.Thread(target=self.watch, args=(observer, seen, stop))
        thread.start()
        try:
            spans = self.drain(ctx={"tmp": scratch})
        finally:
            stop.set()
            thread.join()
        self.assertEqual(len(spans), 3)
        self.assertEqual(max(len(d["reservations"]) for d in seen), 3)
        busiest = max(seen, key=lambda d: len(d["reservations"]))
        # RAM is what a peer subtracts; the track directory is how it learns how much
        # of that a worker has already taken.
        self.assertTrue(busiest["track_dir"])
        self.assertEqual(
            sorted(r["ram"] for r in busiest["reservations"].values()), [self.RESERVE] * 3
        )
        # Scratch is what a peer subtracts from the budget, and the paths are how it
        # learns how much of that is already on disk.
        for reservation in busiest["reservations"].values():
            self.assertEqual(len(reservation["paths"]), 3)
            self.assertTrue(all(path.startswith(scratch) for path in reservation["paths"]))
        with observer.exclusive():
            self.assertEqual(observer.peers(), [])  # withdrawn at the end

    def test_a_driver_held_up_by_a_peer_says_so_and_names_who_it_waits_for(self):
        peer = self.peer(ram=300)  # holds the whole ceiling
        observer_child = self.peer()
        observer = Ledger(self.root, pid=observer_child.pid)
        generate_zarr.LEDGER_WAIT_SECONDS = 30.0
        seen: list[dict] = []
        stop = threading.Event()
        thread = threading.Thread(target=self.watch, args=(observer, seen, stop))
        thread.start()
        timer = threading.Timer(
            1.0, lambda: TestRunAloneNeedsTheWholeNodeToBeIdle._release(peer)
        )
        timer.start()
        self.addCleanup(timer.cancel)
        try:
            spans = self.drain()
        finally:
            stop.set()
            thread.join()
        self.assertEqual(len(spans), 3)  # it ran once the peer let go
        waiting = [d for d in seen if d["waiting_since"] is not None]
        self.assertTrue(waiting, "it never said it was waiting")
        self.assertEqual(waiting[0]["blocked_by"], [peer.pid])
        self.assertEqual(seen[-1]["waiting_since"], None)  # and said so when it stopped


class TestDefaultsAreWhatTheDecisionRecordSays(unittest.TestCase):
    def test_the_waits_in_a_clean_environment(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("ZARR_")}
        out = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import admission_ledger as a, generate_zarr as g;"
                    "print(a.STARVATION_SECONDS, g.LEDGER_WAIT_SECONDS,"
                    " a.LOCK_TIMEOUT_SECONDS, g.ADMISSION_RECHECK_SECONDS)"
                ),
            ],
            cwd=HERE, env=env, capture_output=True, text=True, check=True,
        ).stdout.split()
        starvation, wait, lock_timeout, recheck = (float(x) for x in out)
        self.assertEqual(starvation, 1800.0)  # 30 minutes before a waiter goes first
        self.assertEqual(wait, 3600.0)  # 60 minutes before a slot gives up
        self.assertGreater(wait, starvation)  # or the priority could never act
        self.assertEqual(lock_timeout, 60.0)
        self.assertEqual(recheck, 15.0)


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


    SCRATCH_MODE = os.environ.get("LEDGER_TEST_MODE") == "scratch"
    GIB = 1024**3


    def worker(primary, peak_bytes=None):
        started = time.time()
        time.sleep(0.4)
        # What is being shared: RAM reserves, or (in scratch mode) the 40 GiB charged
        # per recording against a volume budget.
        record = {{"primary": primary, "reserve": 40 * GIB if SCRATCH_MODE else peak_bytes,
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
        if SCRATCH_MODE:
            extra = dict(
                scratch_peaks=dict.fromkeys(primaries, 40 * GIB),
                scratch_budget=lambda in_flight: 100 * GIB,
            )
            reserves, ceiling = dict.fromkeys(primaries, 1), 10**15
        else:
            extra = {{}}
            reserves, ceiling = dict.fromkeys(primaries, 40 * GIB), 100 * GIB
        gz._drain_with_admission(
            primaries, reserves, 4, ceiling, {{}},
            lambda r, i: None, worker=worker,
            ceiling=lambda running_peak, track_dir: ceiling, ledger=ledger, **extra,
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

    def run_two(self, use_ledger, mode="ram"):
        out = os.path.join(self._tmp.name, f"out-{use_ledger}-{mode}")
        root = os.path.join(self._tmp.name, f"ledger-{use_ledger}-{mode}")
        go = os.path.join(self._tmp.name, f"go-{use_ledger}-{mode}")
        os.makedirs(out)
        env = {
            **os.environ, "LEDGER_TEST_OUT": out, "LEDGER_TEST_GO": go,
            "LEDGER_TEST_MODE": mode,
        }
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

    def test_scratch_is_shared_the_same_way(self):
        # The headline case: two drivers each admitting a recording that needs most of
        # the volume. Each is told the volume has 100 GiB of budget and charges 40 GiB
        # per recording, with RAM out of the picture.
        records, _ = self.run_two("yes", "scratch")
        self.assertLessEqual(self.most_reserved_at_once(records), 100 * self.GIB)
        self.assertGreaterEqual(self.most_reserved_at_once(records), 80 * self.GIB)

    def test_scratch_without_the_ledger_is_overcommitted(self):
        records, _ = self.run_two("no", "scratch")
        self.assertGreater(self.most_reserved_at_once(records), 100 * self.GIB)


if __name__ == "__main__":
    unittest.main()
