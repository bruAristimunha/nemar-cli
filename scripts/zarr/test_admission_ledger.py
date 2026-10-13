#!/usr/bin/env python3
"""Tests for the cross-driver admission ledger (scripts/zarr/admission_ledger.py).

Real files, real processes, no mocks: a "peer driver" is a live child process whose
pid and start time the ledger reads from /proc, and a dead one is a child that was
killed. The /proc-shaped cases that cannot be provoked on demand (a comm field with
parentheses) write the kernel's own `stat` format into a temporary directory, which
the module reads through the same function it reads the real one with.

Run:
    python scripts/zarr/test_admission_ledger.py
    uv run --with pytest pytest scripts/zarr/test_admission_ledger.py
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import admission_ledger
from admission_ledger import (
    Ledger,
    LedgerBusy,
    driver_is_alive,
    process_start_ticks,
)

LINUX = sys.platform.startswith("linux")
GIB = 1024**3


def _no_credit(_track_dir, _reserved):
    return 0


def _no_held(_paths):
    return 0


class LedgerTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = os.path.join(self._tmp.name, "ledger")
        self._children: list[subprocess.Popen] = []
        self.addCleanup(self._reap)

    def _reap(self):
        for child in self._children:
            if child.poll() is None:
                child.kill()
            child.wait()

    def live_process(self) -> subprocess.Popen:
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self._children.append(child)
        deadline = time.monotonic() + 5
        while process_start_ticks(child.pid) is None and LINUX:
            self.assertLess(time.monotonic(), deadline, "child never appeared in /proc")
            time.sleep(0.01)
        return child

    def peer(self, child: subprocess.Popen) -> Ledger:
        return Ledger(self.root, pid=child.pid)


class TestLocking(LedgerTestCase):
    def test_a_second_driver_waits_for_the_lock_and_then_gets_it(self):
        a, b = Ledger(self.root, pid=1001), Ledger(self.root, pid=1002)
        with a.exclusive():
            with self.assertRaises(LedgerBusy), b.exclusive(timeout=0.15):
                pass
        with b.exclusive(timeout=0.15):
            pass

    def test_the_lock_is_released_when_the_body_raises(self):
        a, b = Ledger(self.root, pid=1001), Ledger(self.root, pid=1002)
        with self.assertRaises(RuntimeError), a.exclusive():
            raise RuntimeError("boom")
        with b.exclusive(timeout=0.15):
            pass

    def test_nothing_is_written_outside_the_lock(self):
        ledger = Ledger(self.root, pid=1001)
        for write in (
            lambda: ledger.reserve(1, 1, []),
            lambda: ledger.flush(),
            lambda: ledger.set_track_dir("/x"),
            lambda: ledger.mark_waiting(True),
            lambda: ledger.close(),
            lambda: ledger.peers(),
        ):
            with self.assertRaises(AssertionError):
                write()
        self.assertEqual([n for n in os.listdir(self.root) if n.endswith(".json")], [])


@unittest.skipUnless(hasattr(os, "fork"), "needs fork")
class TestForkedChildrenDoNotKeepTheLock(LedgerTestCase):
    """The converter forks its pool workers while the driver holds the lock."""

    def test_a_forked_child_does_not_inherit_the_lock_descriptor(self):
        ledger = Ledger(self.root, pid=1001)
        with ledger.exclusive():
            fd = ledger._fd
            pid = os.fork()
            if pid == 0:  # the child: is the lock descriptor still open here?
                try:
                    os.fstat(fd)
                except OSError:
                    os._exit(0)
                os._exit(1)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.WEXITSTATUS(status), 0, "the child kept the lock descriptor")

    def test_the_lock_is_free_once_the_parent_unlocks_though_a_child_lives_on(self):
        ledger, other = Ledger(self.root, pid=1001), Ledger(self.root, pid=1002)
        with ledger.exclusive():
            pid = os.fork()
            if pid == 0:
                time.sleep(30)
                os._exit(0)
        try:
            with other.exclusive(timeout=2.0):
                pass
        finally:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)

    def test_a_driver_killed_while_it_holds_the_lock_frees_it_for_the_others(self):
        # The driver forks a worker under the lock, then dies without unlocking.
        reader, writer = os.pipe()
        driver = os.fork()
        if driver == 0:
            os.close(reader)
            ledger = Ledger(self.root, pid=os.getpid())
            ledger.acquire()
            worker = os.fork()
            if worker == 0:
                time.sleep(30)
                os._exit(0)
            os.write(writer, f"{worker}\n".encode())
            time.sleep(30)
            os._exit(0)
        os.close(writer)
        with os.fdopen(reader) as fh:
            worker = int(fh.readline())
        try:
            os.kill(driver, signal.SIGKILL)
            os.waitpid(driver, 0)
            with Ledger(self.root, pid=1002).exclusive(timeout=2.0):
                pass  # the orphaned worker is still alive and does not hold it
        finally:
            os.kill(worker, signal.SIGKILL)
            with contextlib.suppress(ChildProcessError):
                os.waitpid(worker, 0)


class TestReleaseWithoutTheLock(LedgerTestCase):
    def test_a_release_made_without_the_lock_is_published_by_the_next_flush(self):
        ledger = Ledger(self.root, pid=os.getpid())
        path = os.path.join(self.root, f"{os.getpid()}.json")
        with ledger.exclusive():
            token = ledger.reserve(5, 5, [])
        ledger.release(token)  # the lock could not be had; the state changes anyway
        with open(path) as fh:
            self.assertEqual(len(json.load(fh)["reservations"]), 1)  # peers still see it
        with ledger.exclusive():
            ledger.flush()
        with open(path) as fh:
            self.assertEqual(json.load(fh)["reservations"], {})

    def test_release_all_without_the_lock_is_published_by_the_next_write(self):
        ledger = Ledger(self.root, pid=os.getpid())
        path = os.path.join(self.root, f"{os.getpid()}.json")
        with ledger.exclusive():
            ledger.reserve(5, 5, [])
            ledger.reserve(6, 6, [])
        ledger.release_all()
        with ledger.exclusive():
            ledger.reserve(7, 7, [])
        with open(path) as fh:
            self.assertEqual([r["ram"] for r in json.load(fh)["reservations"].values()], [7])


class TestSleepUnlocked(LedgerTestCase):
    def test_peers_get_the_lock_while_a_driver_sleeps_and_it_is_retaken_after(self):
        a, b = Ledger(self.root, pid=1001), Ledger(self.root, pid=1002)
        took = []
        with a.exclusive():
            def other():
                with b.exclusive(timeout=2.0):
                    took.append(time.monotonic())

            thread = threading.Thread(target=other)
            thread.start()
            a.sleep_unlocked(0.3)
            thread.join(timeout=5)
            self.assertEqual(len(took), 1)
            # a holds the lock again: b cannot take it now.
            with self.assertRaises(LedgerBusy), b.exclusive(timeout=0.1):
                pass
        with b.exclusive(timeout=0.1):
            pass


class TestOwnFile(LedgerTestCase):
    def test_reserve_and_release_publish_the_document_atomically(self):
        ledger = Ledger(self.root, pid=os.getpid())
        path = os.path.join(self.root, f"{os.getpid()}.json")
        with ledger.exclusive():
            ledger.set_track_dir("/scratch/track")
            token = ledger.reserve(4 * GIB, 300 * GIB, ["/scratch/a", "/scratch/b"])
            with open(path) as fh:
                doc = json.load(fh)
            self.assertEqual(doc["pid"], os.getpid())
            self.assertEqual(doc["track_dir"], "/scratch/track")
            self.assertEqual(
                list(doc["reservations"].values()),
                [{"ram": 4 * GIB, "scratch": 300 * GIB, "paths": ["/scratch/a", "/scratch/b"]}],
            )
            ledger.release(token)
            with open(path) as fh:
                self.assertEqual(json.load(fh)["reservations"], {})
            ledger.release(token)  # a second release is a no-op, not an error
        self.assertEqual([n for n in os.listdir(self.root) if n.endswith(".tmp")], [])

    def test_close_withdraws_the_driver(self):
        ledger = Ledger(self.root, pid=os.getpid())
        path = os.path.join(self.root, f"{os.getpid()}.json")
        with ledger.exclusive():
            ledger.reserve(1, 1, [])
            self.assertTrue(os.path.exists(path))
            ledger.close()
            self.assertFalse(os.path.exists(path))
            ledger.close()  # closing twice is fine

    def test_waiting_is_timed_from_the_first_call(self):
        ledger = Ledger(self.root, pid=os.getpid())
        with ledger.exclusive():
            ledger.mark_waiting(True, now=100.0)
            ledger.mark_waiting(True, now=900.0)
            self.assertEqual(ledger.waiting_since, 100.0)
            ledger.mark_waiting(False)
            self.assertIsNone(ledger.waiting_since)
            ledger.mark_waiting(False)  # already clear: nothing to publish


class TestPeers(LedgerTestCase):
    def publish_as_peer(self, child, ram=1, scratch=1, paths=(), track_dir=None):
        peer = self.peer(child)
        with peer.exclusive():
            if track_dir is not None:
                peer.set_track_dir(track_dir)
            peer.reserve(ram, scratch, list(paths))
        return peer

    def test_a_live_peer_is_seen_and_this_driver_is_not(self):
        child = self.live_process()
        self.publish_as_peer(child, ram=7)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            me.reserve(99, 99, [])
            docs = me.peers()
        self.assertEqual([d["pid"] for d in docs], [child.pid])
        self.assertEqual(sum(r["ram"] for r in docs[0]["reservations"].values()), 7)

    @unittest.skipUnless(LINUX, "needs /proc")
    def test_a_killed_driver_is_dropped_and_its_file_removed(self):
        child = self.live_process()
        self.publish_as_peer(child)
        path = os.path.join(self.root, f"{child.pid}.json")
        child.kill()
        child.wait()
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.peers(), [])
        self.assertFalse(os.path.exists(path))

    @unittest.skipUnless(LINUX, "needs /proc")
    def test_a_zombie_is_not_a_live_driver(self):
        child = self.live_process()
        self.publish_as_peer(child)
        os.kill(child.pid, signal.SIGKILL)  # killed, not yet reaped: a zombie
        deadline = time.monotonic() + 5
        while process_start_ticks(child.pid) is not None:
            self.assertLess(time.monotonic(), deadline, "the child never became a zombie")
            time.sleep(0.01)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.peers(), [])

    @unittest.skipUnless(LINUX, "needs /proc")
    def test_a_recycled_pid_does_not_keep_a_dead_drivers_reservations(self):
        child = self.live_process()
        self.publish_as_peer(child, ram=5)
        path = os.path.join(self.root, f"{child.pid}.json")
        with open(path) as fh:
            doc = json.load(fh)
        doc["start"] += 1  # same pid, different process: the original is gone
        with open(path, "w") as fh:
            json.dump(doc, fh)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.peers(), [])
        self.assertFalse(os.path.exists(path))

    def test_an_unreadable_document_is_removed_not_trusted(self):
        os.makedirs(self.root)
        for name, body in (("4001.json", "{not json"), ("4002.json", "[]"),
                           ("4003.json", json.dumps({"pid": 4003, "reservations": 7}))):
            with open(os.path.join(self.root, name), "w") as fh:
                fh.write(body)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.peers(), [])
        self.assertEqual(sorted(n for n in os.listdir(self.root) if n.endswith(".json")), [])

    def test_unrelated_files_are_left_alone(self):
        os.makedirs(self.root)
        for name in ("README", "notes.json", "notes.json.tmp"):
            with open(os.path.join(self.root, name), "w") as fh:
                fh.write("x")
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.peers(), [])
        self.assertTrue(all(os.path.exists(os.path.join(self.root, n))
                            for n in ("README", "notes.json", "notes.json.tmp")))

    def test_others_in_flight_means_a_reservation_not_just_a_file(self):
        child = self.live_process()
        peer = self.publish_as_peer(child)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertTrue(me.others_in_flight())
        with peer.exclusive():
            peer.release_all()
        with me.exclusive():
            self.assertFalse(me.others_in_flight())


class TestOutstanding(LedgerTestCase):
    def two_peers(self):
        a, b = self.live_process(), self.live_process()
        pa, pb = self.peer(a), self.peer(b)
        with pa.exclusive():
            pa.set_track_dir("/track/a")
            pa.reserve(10 * GIB, 400 * GIB, ["/s/a1"])
            pa.reserve(6 * GIB, 100 * GIB, ["/s/a2"])
        with pb.exclusive():
            pb.set_track_dir("/track/b")
            pb.reserve(4 * GIB, 50 * GIB, ["/s/b1"])
        return Ledger(self.root, pid=os.getpid())

    def test_with_nothing_taken_every_reserve_is_owed(self):
        me = self.two_peers()
        with me.exclusive():
            ram, scratch = me.others_outstanding(_no_credit, _no_held)
        self.assertEqual(ram, 20 * GIB)
        self.assertEqual(scratch, 550 * GIB)

    def test_what_a_peer_has_taken_is_not_charged_twice(self):
        me = self.two_peers()
        taken = {"/track/a": 5 * GIB, "/track/b": 4 * GIB}
        held = {"/s/a1": 150 * GIB, "/s/a2": 100 * GIB, "/s/b1": 10 * GIB}
        with me.exclusive():
            ram, scratch = me.others_outstanding(
                lambda track, reserved: taken[track],
                lambda paths: sum(held[p] for p in paths),
            )
        self.assertEqual(ram, (16 - 5) * GIB + 0)
        self.assertEqual(scratch, (400 - 150) * GIB + 0 + (50 - 10) * GIB)

    def test_credit_never_exceeds_the_reserve_or_goes_negative(self):
        me = self.two_peers()
        with me.exclusive():
            ram, scratch = me.others_outstanding(
                lambda track, reserved: 10**15, lambda paths: 10**15
            )
            self.assertEqual((ram, scratch), (0, 0))
            ram, scratch = me.others_outstanding(lambda track, reserved: -5, lambda paths: -5)
            self.assertEqual((ram, scratch), (20 * GIB, 550 * GIB))

    def test_no_peers_owe_nothing(self):
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.others_outstanding(_no_credit, _no_held), (0, 0))


class TestStarvation(LedgerTestCase):
    def setUp(self):
        super().setUp()
        self.addCleanup(setattr, admission_ledger, "STARVATION_SECONDS",
                        admission_ledger.STARVATION_SECONDS)
        admission_ledger.STARVATION_SECONDS = 1800.0

    def waiting_peer(self, since, blocked_by=None):
        """A peer waiting since ``since`` for the drivers in ``blocked_by`` (by default
        this process, which is who the cases below ask)."""
        child = self.live_process()
        peer = self.peer(child)
        with peer.exclusive():
            peer.mark_waiting(
                True, now=since, blocked_by={os.getpid()} if blocked_by is None else blocked_by
            )
        return child, peer

    def test_a_peer_waiting_long_enough_is_ahead_of_a_driver_that_is_not_waiting(self):
        self.waiting_peer(1000.0)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertTrue(me.older_peer_waiting(now=1000.0 + 1800.0))
            self.assertFalse(me.older_peer_waiting(now=1000.0 + 1799.0))

    def test_a_peer_not_yet_starved_is_not_deferred_to(self):
        self.waiting_peer(1000.0)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertFalse(me.older_peer_waiting(now=1100.0))

    def test_only_the_older_of_two_waiting_drivers_is_ahead(self):
        _, peer = self.waiting_peer(1000.0)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            me.mark_waiting(True, now=2000.0, blocked_by={peer.pid})
            self.assertTrue(me.older_peer_waiting(now=9000.0))
        with peer.exclusive():
            self.assertFalse(peer.older_peer_waiting(now=9000.0))

    def test_a_driver_that_is_not_in_the_waiters_way_keeps_admitting(self):
        # The peer waits for someone else (pid 1): stopping this driver would cost it
        # throughput and bring the waiter nothing.
        self.waiting_peer(1000.0, blocked_by={1})
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertFalse(me.older_peer_waiting(now=9000.0))

    def test_a_document_that_does_not_say_who_it_waits_for_is_taken_to_mean_everyone(self):
        child = self.live_process()
        path = os.path.join(self.root, f"{child.pid}.json")
        peer = self.peer(child)
        with peer.exclusive():
            peer.mark_waiting(True, now=1000.0)
        with open(path) as fh:
            doc = json.load(fh)
        del doc["blocked_by"]
        with open(path, "w") as fh:
            json.dump(doc, fh)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertTrue(me.older_peer_waiting(now=9000.0))

    def test_who_a_waiter_waits_for_can_change_without_restarting_its_clock(self):
        _, peer = self.waiting_peer(1000.0, blocked_by={1})
        with peer.exclusive():
            peer.mark_waiting(True, now=5000.0, blocked_by={os.getpid()})
            self.assertEqual(peer.waiting_since, 1000.0)
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertTrue(me.older_peer_waiting(now=9000.0))

    def test_equal_times_break_toward_the_lower_pid(self):
        _, peer_a = self.waiting_peer(1000.0)
        _, peer_b = self.waiting_peer(1000.0)
        for peer in (peer_a, peer_b):  # each waits for the other
            with peer.exclusive():
                peer.mark_waiting(True, blocked_by={peer_a.pid, peer_b.pid})
        low, high = sorted([peer_a, peer_b], key=lambda p: p.pid)
        with low.exclusive():
            self.assertFalse(low.older_peer_waiting(now=9000.0))
        with high.exclusive():
            self.assertTrue(high.older_peer_waiting(now=9000.0))


class TestProcessIdentity(LedgerTestCase):
    @unittest.skipUnless(LINUX, "needs /proc")
    def test_a_live_process_has_a_start_time_that_does_not_change(self):
        first = process_start_ticks(os.getpid())
        self.assertIsInstance(first, int)
        self.assertEqual(process_start_ticks(os.getpid()), first)
        self.assertTrue(driver_is_alive(os.getpid(), first))
        self.assertFalse(driver_is_alive(os.getpid(), first + 1))
        self.assertTrue(driver_is_alive(os.getpid(), None))

    def test_no_such_process(self):
        self.assertIsNone(process_start_ticks(2**22 + 4242))
        if LINUX:
            self.assertFalse(driver_is_alive(2**22 + 4242, 1))

    def test_a_comm_with_spaces_and_parentheses_is_parsed_from_the_last_parenthesis(self):
        proc = os.path.join(self.root, "proc")
        os.makedirs(os.path.join(proc, "77"))
        fields = ["S"] + ["0"] * 18 + ["123456"] + ["0"] * 10
        with open(os.path.join(proc, "77", "stat"), "w") as fh:
            fh.write("77 (python (worker) 3) " + " ".join(fields) + "\n")
        self.assertEqual(process_start_ticks(77, proc), 123456)
        fields[0] = "Z"
        with open(os.path.join(proc, "77", "stat"), "w") as fh:
            fh.write("77 (python) " + " ".join(fields) + "\n")
        self.assertIsNone(process_start_ticks(77, proc))
        with open(os.path.join(proc, "77", "stat"), "w") as fh:
            fh.write("77 (python) S 1 2\n")  # truncated
        self.assertIsNone(process_start_ticks(77, proc))


class TestReadingThePeers(LedgerTestCase):
    def test_a_file_that_cannot_be_read_now_is_left_for_a_later_look(self):
        # A directory where a document should be: opening it fails, as EMFILE or EIO
        # would, and says nothing about whether the driver is alive.
        os.makedirs(os.path.join(self.root, "4001.json"))
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.peers(), [])
        self.assertTrue(os.path.isdir(os.path.join(self.root, "4001.json")))

    def test_a_write_a_killed_driver_never_finished_is_removed(self):
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        stale = os.path.join(self.root, f"{child.pid}.json.tmp")
        os.makedirs(self.root, exist_ok=True)
        with open(stale, "w") as fh:
            fh.write("{")
        live = self.live_process()
        kept = os.path.join(self.root, f"{live.pid}.json.tmp")
        with open(kept, "w") as fh:
            fh.write("{")
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            me.peers()
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(kept))  # its writer is alive and may be mid-write

    def test_a_killed_drivers_reservations_stand_while_its_workers_run(self):
        # The driver is gone; its pool workers are not, and a worker finishes the
        # recording it has before it notices (hours, for a large one).
        driver = subprocess.Popen([sys.executable, "-c", "pass"])
        driver.wait()
        worker = self.live_process()
        track = os.path.join(self._tmp.name, "track")
        os.makedirs(track)
        with open(os.path.join(track, f"{worker.pid}.json"), "w") as fh:
            json.dump({"reserve": 7, "rss_anon_start": 0, "start": process_start_ticks(worker.pid)}, fh)
        os.makedirs(self.root, exist_ok=True)
        path = os.path.join(self.root, f"{driver.pid}.json")
        with open(path, "w") as fh:
            json.dump(
                {
                    "v": 1, "pid": driver.pid, "start": None, "track_dir": track,
                    "waiting_since": None, "blocked_by": [],
                    "reservations": {"1": {"ram": 7, "scratch": 9, "paths": []}},
                },
                fh,
            )
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual([d["pid"] for d in me.peers()], [driver.pid])
            self.assertEqual(me.others_outstanding(_no_credit, _no_held), (7, 9))
        worker.kill()
        worker.wait()
        with me.exclusive():
            self.assertEqual(me.peers(), [])
        self.assertFalse(os.path.exists(path))

    def test_a_dead_driver_with_nothing_reserved_is_gone_whatever_its_track_dir(self):
        driver = subprocess.Popen([sys.executable, "-c", "pass"])
        driver.wait()
        worker = self.live_process()
        track = os.path.join(self._tmp.name, "track")
        os.makedirs(track)
        with open(os.path.join(track, f"{worker.pid}.json"), "w") as fh:
            json.dump({"reserve": 7, "rss_anon_start": 0, "start": None}, fh)
        os.makedirs(self.root, exist_ok=True)
        with open(os.path.join(self.root, f"{driver.pid}.json"), "w") as fh:
            json.dump(
                {"v": 1, "pid": driver.pid, "start": None, "track_dir": track,
                 "waiting_since": None, "reservations": {}},
                fh,
            )
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.peers(), [])


class TestReserveSurvivesAWriteThatFails(LedgerTestCase):
    def block_the_file(self):
        path = os.path.join(self.root, f"{os.getpid()}.json")
        os.makedirs(os.path.join(path, "x"))  # os.replace onto a non-empty directory fails
        return path

    def test_the_reservation_is_kept_and_published_by_the_next_write_that_works(self):
        ledger = Ledger(self.root, pid=os.getpid())
        path = self.block_the_file()
        with ledger.exclusive():
            token = ledger.reserve(5, 6, ["/x"])  # does not raise: the recording runs
            self.assertIsNotNone(ledger.publish_error)
            with self.assertRaises(OSError):
                ledger.flush()
        shutil.rmtree(path)
        with ledger.exclusive():
            ledger.flush()
            self.assertIsNone(ledger.publish_error)
        with open(path) as fh:
            self.assertEqual(list(json.load(fh)["reservations"]), [str(token)])


class TestSettings(unittest.TestCase):
    def setUp(self):
        self._saved = list(admission_ledger.SETTING_ERRORS)
        self.addCleanup(self._restore)
        self.addCleanup(os.environ.pop, "ZARR_TEST_SECONDS", None)

    def _restore(self):
        admission_ledger.SETTING_ERRORS[:] = self._saved

    def test_a_bad_value_keeps_the_default_and_is_reported_instead_of_raising(self):
        for raw in ("soon", "-5", "inf", "nan"):
            with self.subTest(raw=raw):
                os.environ["ZARR_TEST_SECONDS"] = raw
                self.assertEqual(admission_ledger._env_seconds("ZARR_TEST_SECONDS", 12.5), 12.5)
        self.assertEqual(len(admission_ledger.SETTING_ERRORS) - len(self._saved), 4)
        self.assertTrue(all("ZARR_TEST_SECONDS" in m for m in admission_ledger.SETTING_ERRORS[-4:]))

    def test_a_good_or_missing_value_is_used_quietly(self):
        os.environ.pop("ZARR_TEST_SECONDS", None)
        self.assertEqual(admission_ledger._env_seconds("ZARR_TEST_SECONDS", 3.0), 3.0)
        os.environ["ZARR_TEST_SECONDS"] = " 7.5 "
        self.assertEqual(admission_ledger._env_seconds("ZARR_TEST_SECONDS", 3.0), 7.5)
        os.environ["ZARR_TEST_SECONDS"] = "0"
        self.assertEqual(admission_ledger._env_seconds("ZARR_TEST_SECONDS", 3.0), 0.0)
        self.assertEqual(admission_ledger.SETTING_ERRORS, self._saved)


class TestSummary(LedgerTestCase):
    def test_the_summary_names_who_holds_what_and_how_much_is_on_disk(self):
        a, b = self.live_process(), self.live_process()
        pa, pb = self.peer(a), self.peer(b)
        with pa.exclusive():
            pa.reserve(10, 100, ["/s/a"])
        with pb.exclusive():
            pb.mark_waiting(True)  # waiting holds nothing: not a blocker
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            summary = me.others_summary(_no_credit, lambda paths: 30)
        self.assertEqual(summary.pids, frozenset({a.pid}))
        self.assertEqual((summary.ram, summary.scratch, summary.held), (10, 70, 30))


class TestSeveralDriversShareOneBudget(LedgerTestCase):
    """The property the ledger exists for: drivers that each decide and reserve under
    the lock never hold more than the node has, however they interleave."""

    CAP = 10  # units of RAM the node has
    WORKER = textwrap.dedent(
        """
        import os, sys, time, random
        sys.path.insert(0, sys.argv[1])
        from admission_ledger import Ledger
        root, events, cap, jobs = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
        rng = random.Random(os.getpid())
        me = Ledger(root)
        done = 0
        while done < jobs:
            need = rng.choice([2, 3, 4])
            admitted = None
            with me.exclusive():
                owed = sum(
                    sum(r["ram"] for r in d["reservations"].values()) for d in me.peers()
                )
                if owed + need <= cap:
                    admitted = me.reserve(need, 0, [])
                    with open(events, "a") as fh:
                        fh.write(f"+{need}\\n")
            if admitted is None:
                time.sleep(0.005)
                continue
            time.sleep(rng.uniform(0.005, 0.03))
            with me.exclusive():
                me.release(admitted)
                with open(events, "a") as fh:
                    fh.write(f"-{need}\\n")
            done += 1
        with me.exclusive():
            me.close()
        """
    )

    def test_the_sum_in_flight_never_exceeds_the_cap(self):
        events = os.path.join(self._tmp.name, "events")
        open(events, "w").close()
        here = os.path.dirname(os.path.abspath(__file__))
        # A worker holds one reservation at a time and decides while holding none, so
        # what `peers()` shows it IS everything in flight, and the cap is exact.
        procs = [
            subprocess.Popen(
                [sys.executable, "-c", self.WORKER, here, self.root, events,
                 str(self.CAP), "25"]
            )
            for _ in range(5)
        ]
        self._children.extend(procs)
        for proc in procs:
            self.assertEqual(proc.wait(timeout=120), 0)
        running = peak = 0
        with open(events) as fh:
            lines = [line.strip() for line in fh if line.strip()]
        self.assertEqual(len(lines), 5 * 25 * 2)
        for line in lines:
            running += int(line)
            peak = max(peak, running)
            self.assertGreaterEqual(running, 0)
        self.assertEqual(running, 0)
        self.assertLessEqual(peak, self.CAP)
        self.assertGreater(peak, 4, "the drivers never overlapped; the test proved nothing")
        leftover = [n for n in os.listdir(self.root) if n.endswith(".json")]
        self.assertEqual(leftover, [])


if __name__ == "__main__":
    unittest.main()
