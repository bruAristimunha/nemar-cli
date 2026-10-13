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

import json
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
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
            lambda: ledger.release(1),
            lambda: ledger.release_all(),
            lambda: ledger.set_track_dir("/x"),
            lambda: ledger.mark_waiting(True),
            lambda: ledger.close(),
            lambda: ledger.peers(),
        ):
            with self.assertRaises(AssertionError):
                write()
        self.assertEqual([n for n in os.listdir(self.root) if n.endswith(".json")], [])


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
        for name in ("README", "notes.json", "12.json.tmp"):
            with open(os.path.join(self.root, name), "w") as fh:
                fh.write("x")
        me = Ledger(self.root, pid=os.getpid())
        with me.exclusive():
            self.assertEqual(me.peers(), [])
        self.assertTrue(all(os.path.exists(os.path.join(self.root, n))
                            for n in ("README", "notes.json", "12.json.tmp")))

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

    def waiting_peer(self, since):
        child = self.live_process()
        peer = self.peer(child)
        with peer.exclusive():
            peer.mark_waiting(True, now=since)
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
            me.mark_waiting(True, now=2000.0)
            self.assertTrue(me.older_peer_waiting(now=9000.0))
        with peer.exclusive():
            self.assertFalse(peer.older_peer_waiting(now=9000.0))

    def test_equal_times_break_toward_the_lower_pid(self):
        _, peer_a = self.waiting_peer(1000.0)
        _, peer_b = self.waiting_peer(1000.0)
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
