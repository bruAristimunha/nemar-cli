#!/usr/bin/env python3
"""Tests for how the converter anticipates and measures memory (ADR 0101):

* a BrainVision recording's sample width, read off what admission can see without a
  download, so a float32 recording is not projected as if it were int16;
* the anonymous-memory peak, which is what a reserve is, measured apart from the
  resident peak that also counts a streamed recording's file-backed scratch.

Real git repositories, real /proc, real memory: nothing is mocked. The numbers are
the measured ones from nm000276 on hallu (2026-10-13): a 145 GiB float32 recording
(about 32 channels) was refused as "too large" at a projected 54 GiB against a 46 GiB
budget, and sub-48, 39 channels and 122 GB, held 6.2 GiB of anonymous memory while
its resident size passed 10 GiB.

Run:
    python scripts/zarr/test_zarr_memory_projection.py
    uv run --with pytest pytest scripts/zarr/test_zarr_memory_projection.py
"""

from __future__ import annotations

import ast
import json
import mmap
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import generate_zarr as gz

GIB = 1024**3
LINUX = sys.platform.startswith("linux") and gz.anon_rss_bytes(os.getpid()) is not None


class TestSnapSampleWidth(unittest.TestCase):
    def test_widths_a_brainvision_file_is_written_in(self):
        self.assertEqual(gz.snap_sample_width(4.0), 4)
        self.assertEqual(gz.snap_sample_width(2.0), 2)

    def test_a_header_and_markers_do_not_change_the_answer(self):
        self.assertEqual(gz.snap_sample_width(4.0 * 1.0002), 4)
        self.assertEqual(gz.snap_sample_width(3.9), 4)
        self.assertEqual(gz.snap_sample_width(2.05), 2)

    def test_a_figure_that_is_not_a_width_is_refused(self):
        for ratio in (0.0, 1.0, 1.9, 3.0, 3.5, 4.5, 8.0, float("nan"), float("inf")):
            with self.subTest(ratio=ratio):
                self.assertIsNone(gz.snap_sample_width(ratio))


class TestSampleBytesFromSidecar(unittest.TestCase):
    """Over a real git repository, the way `main` reads it."""

    PRIMARY = "sub-48/ieeg/sub-48_task-ltm_ieeg.vhdr"
    SIDECAR = "sub-48/ieeg/sub-48_task-ltm_ieeg.json"
    # nm000276 sub-48, as measured on hallu.
    SIZE = 122_098_089_984
    CHANNELS = 39
    RATE = 1024.0
    SECONDS = 764_336.0

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = tmp.name
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.org")
        self.git("config", "user.name", "t")

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, check=True, capture_output=True, text=True
        ).stdout.strip()

    def commit(self, sidecar: str | None, path: str | None = None):
        path = path or self.SIDECAR
        os.makedirs(os.path.join(self.repo, os.path.dirname(path)), exist_ok=True)
        if sidecar is not None:
            with open(os.path.join(self.repo, path), "w") as fh:
                fh.write(sidecar)
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", "fixture")
        head = self.git("rev-parse", "HEAD")
        files = set(self.git("ls-tree", "-r", "--name-only", "HEAD").splitlines())
        return head, files

    def infer(self, sidecar, *, size=None, channels=CHANNELS, primary=None, sidecar_path=None):
        head, files = self.commit(sidecar, sidecar_path)
        return gz.sample_bytes_from_sidecar(
            self.repo, primary or self.PRIMARY, files, head,
            self.SIZE if size is None else size, channels,
        )

    def doc(self, **overrides):
        body = {"SamplingFrequency": self.RATE, "RecordingDuration": self.SECONDS}
        body.update(overrides)
        return json.dumps(body)

    def test_nm000276_is_float32(self):
        self.assertEqual(self.infer(self.doc()), 4)

    def test_half_the_bytes_for_the_same_duration_is_int16(self):
        self.assertEqual(self.infer(self.doc(), size=self.SIZE // 2), 2)

    def test_a_duration_that_does_not_add_up_is_not_trusted(self):
        # Recorded time that includes a gap: the figure lands between widths.
        self.assertIsNone(self.infer(self.doc(RecordingDuration=self.SECONDS * 1.1)))
        self.assertIsNone(self.infer(self.doc(SamplingFrequency=500.0)))

    def test_missing_unreadable_or_odd_fields_are_not_trusted(self):
        for label, text in {
            "no duration": json.dumps({"SamplingFrequency": self.RATE}),
            "no rate": json.dumps({"RecordingDuration": self.SECONDS}),
            "not json": "{nope",
            "not an object": "[1, 2]",
            "text": json.dumps({"SamplingFrequency": "fast", "RecordingDuration": "long"}),
            "zero rate": self.doc(SamplingFrequency=0),
            "negative": self.doc(RecordingDuration=-5),
            "infinite": '{"SamplingFrequency": Infinity, "RecordingDuration": 5}',
        }.items():
            with self.subTest(label):
                self.assertIsNone(self.infer(text))

    def test_no_sidecar_in_the_commit(self):
        self.assertIsNone(self.infer(None))

    def test_only_brainvision_is_inferred(self):
        edf = "sub-48/ieeg/sub-48_task-ltm_ieeg.edf"
        self.assertIsNone(self.infer(self.doc(), primary=edf))

    def test_no_channel_count_or_size_no_answer(self):
        self.assertIsNone(self.infer(self.doc(), channels=None))
        self.assertIsNone(self.infer(self.doc(), channels=0))
        self.assertIsNone(self.infer(self.doc(), size=0))


class TestStreamingProjectionUsesTheSampleWidth(unittest.TestCase):
    SIZE = 145 * GIB
    CHANNELS = 39
    BUDGET = 46 * GIB  # the node's usable RAM when this was measured

    def test_the_recording_that_was_refused_now_fits(self):
        # 145 GiB over 32 channels is the recording that was refused: 12x one channel's
        # bytes is 54.4 GiB, over the 46 GiB budget; at four bytes per sample it is 8x,
        # 36.3 GiB.
        refused = gz.streaming_peak_bytes(145 * GIB, 32)
        self.assertAlmostEqual(refused / GIB, 54.4, delta=0.1)
        self.assertGreater(refused, self.BUDGET)
        fits = gz.streaming_peak_bytes(145 * GIB, 32, 4)
        self.assertAlmostEqual(fits / GIB, 36.25, delta=0.1)
        self.assertLess(fits, self.BUDGET)

    def test_the_arithmetic_at_39_channels(self):
        # 145 GiB over 39 channels: 12x one channel's bytes is 44.6 GiB, 8x is 29.7 GiB.
        narrow = gz.streaming_peak_bytes(self.SIZE, self.CHANNELS)
        float32 = gz.streaming_peak_bytes(self.SIZE, self.CHANNELS, 4)
        self.assertGreater(narrow, 40 * GIB)
        self.assertLess(float32, 32 * GIB)
        self.assertLess(float32, self.BUDGET)
        self.assertAlmostEqual(float32 / narrow, 8 / 12, places=3)

    def test_int16_and_unknown_widths_are_projected_exactly_as_before(self):
        base = gz.streaming_peak_bytes(self.SIZE, self.CHANNELS)
        self.assertEqual(gz.streaming_peak_bytes(self.SIZE, self.CHANNELS, 2), base)
        self.assertEqual(gz.streaming_peak_bytes(self.SIZE, self.CHANNELS, None), base)
        self.assertEqual(gz.streaming_peak_bytes(self.SIZE, self.CHANNELS, 0), base)

    def test_a_wider_sample_never_projects_more_than_the_default(self):
        base = gz.streaming_peak_bytes(self.SIZE, self.CHANNELS)
        for width in (2, 3, 4, 8):
            with self.subTest(width=width):
                self.assertLessEqual(gz.streaming_peak_bytes(self.SIZE, self.CHANNELS, width), base)

    def test_the_floor_still_applies(self):
        self.assertEqual(
            gz.streaming_peak_bytes(GIB, 64, 4), gz.STREAM_PEAK_BYTES
        )

    def test_unknown_channels_ignore_the_width(self):
        self.assertEqual(gz.streaming_peak_bytes(self.SIZE, None, 4), gz.STREAM_PEAK_BYTES)

    def test_projected_peak_bytes_threads_the_width(self):
        name = "sub-29/ieeg/sub-29_task-ltm_ieeg.vhdr"
        self.assertTrue(gz.should_stream(name, self.SIZE))
        self.assertLess(
            gz.projected_peak_bytes(name, self.SIZE, self.CHANNELS, sample_bytes=4),
            gz.projected_peak_bytes(name, self.SIZE, self.CHANNELS),
        )

    def test_the_in_memory_path_is_untouched_by_the_width(self):
        name = "sub-01/eeg/sub-01_task-x_eeg.set"
        self.assertEqual(
            gz.projected_peak_bytes(name, 100 * 1024**2, 8, sample_bytes=4),
            gz.projected_peak_bytes(name, 100 * 1024**2, 8),
        )


class TestNoteMeasurementPrefersAnonymousMemory(unittest.TestCase):
    def test_file_backed_pages_do_not_make_a_recording_look_under_reserved(self):
        measured: dict = {}
        result = {
            "primary": "a.vhdr", "ok": True,
            "peak_rss": 48 * GIB,  # resident, memmap pages included
            "peak_anon": 6 * GIB,  # what it actually took
        }
        self.assertIsNone(gz.note_measurement(result, {"a.vhdr": 10 * GIB}, measured))
        self.assertEqual(measured, {"a.vhdr": 6 * GIB})

    def test_anonymous_memory_over_the_reserve_still_warns_and_says_what_it_is(self):
        measured: dict = {}
        result = {"primary": "a.vhdr", "ok": True, "peak_rss": 40 * GIB, "peak_anon": 35 * GIB}
        warning = gz.note_measurement(result, {"a.vhdr": 10 * GIB}, measured)
        self.assertIn("under-reserved", warning)
        self.assertIn("35.0 GiB of anonymous memory", warning)
        self.assertEqual(measured, {"a.vhdr": 35 * GIB})

    def test_without_an_anonymous_figure_the_resident_one_is_used_as_before(self):
        measured: dict = {}
        result = {"primary": "a.vhdr", "ok": True, "peak_rss": 9000}
        warning = gz.note_measurement(result, {"a.vhdr": 1000}, measured)
        self.assertIn("under-reserved", warning)
        self.assertNotIn("anonymous", warning)
        self.assertEqual(measured, {"a.vhdr": 9000})

    def test_a_memory_failure_carries_both_figures(self):
        result = gz.memory_failure_result("a.set", MemoryError("x"), 5000, 4000)
        self.assertEqual((result["peak_rss"], result["peak_anon"]), (5000, 4000))
        self.assertIsNone(gz.memory_failure_result("a.set", MemoryError("x"))["peak_anon"])


@unittest.skipUnless(LINUX, "needs RssAnon from /proc")
class TestAnonPeak(unittest.TestCase):
    MIB = 1024**2

    def sampler(self):
        peak = gz.AnonPeak(interval=0.02)
        self.addCleanup(peak.close)  # no sampler thread outlives its test
        self.assertTrue(peak.reset())
        return peak

    def test_an_allocation_that_has_since_been_freed_is_remembered(self):
        peak = self.sampler()
        base = peak.peak()
        block = bytearray(200 * self.MIB)
        for i in range(0, len(block), 4096):  # touch every page: anonymous memory is lazy
            block[i] = 1
        time.sleep(0.2)
        del block
        time.sleep(0.2)
        self.assertGreaterEqual(peak.peak(), base + 150 * self.MIB)
        now = gz.anon_rss_bytes(os.getpid())
        self.assertLess(now, peak.peak() - 100 * self.MIB)

    def test_a_reset_forgets_the_last_recordings_peak(self):
        peak = self.sampler()
        block = bytearray(150 * self.MIB)
        for i in range(0, len(block), 4096):
            block[i] = 1
        time.sleep(0.1)
        high = peak.peak()
        del block
        time.sleep(0.1)
        self.assertTrue(peak.reset())
        self.assertLess(peak.peak(), high - 100 * self.MIB)

    def test_file_backed_pages_are_resident_but_not_anonymous(self):
        peak = self.sampler()
        base_anon = peak.peak()
        with tempfile.TemporaryFile() as fh:
            fh.truncate(200 * self.MIB)
            with mmap.mmap(fh.fileno(), 200 * self.MIB) as mm:
                for i in range(0, len(mm), 4096):
                    _ = mm[i]  # fault the page in
                time.sleep(0.2)
                resident_now = gz.peak_rss_bytes()
                self.assertGreaterEqual(peak.peak(), base_anon)
                self.assertLess(peak.peak() - base_anon, 50 * self.MIB)
                self.assertGreater(resident_now, base_anon + 150 * self.MIB)

    def test_the_module_level_readers_agree_with_the_class(self):
        self.assertTrue(gz.reset_peak_anon())
        self.assertGreater(gz.peak_anon_bytes(), self.MIB)

    def test_a_forked_worker_restarts_the_thread_it_did_not_inherit(self):
        # Not run in the test process's thread pool: the child gets a fresh AnonPeak, as
        # a pool worker does, and the parent's sampler thread is the one it must not
        # have inherited. os.fork() warns that the process is multi-threaded; the child
        # takes no lock the parent's thread could hold.
        parent = self.sampler()
        pid = os.fork()
        if pid == 0:
            ok = False
            try:
                child = gz.AnonPeak(interval=0.02)
                baseline = None
                ok = child.reset() and child._thread is not None and child._thread.is_alive()
                ok = ok and parent._thread is not None and not parent._thread.is_alive()
                baseline = child.peak()
                block = bytearray(120 * self.MIB)
                for i in range(0, len(block), 4096):
                    block[i] = 1
                time.sleep(0.2)
                del block
                time.sleep(0.1)
                ok = ok and child.peak() >= baseline + 100 * self.MIB
            finally:
                os._exit(0 if ok else 1)
        deadline = time.monotonic() + 30
        status = None
        while time.monotonic() < deadline:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                break
            time.sleep(0.05)
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            self.fail("the forked child did not finish")
        self.assertEqual(os.WEXITSTATUS(status), 0)


class TestAnonPeakWhereItCannotBeRead(unittest.TestCase):
    def test_nothing_is_reported_and_nothing_breaks(self):
        # An empty /proc, which is what macOS and a kernel older than 4.5 look like to it.
        with tempfile.TemporaryDirectory() as proc_root:
            peak = gz.AnonPeak(proc_root=proc_root)
            self.assertFalse(peak.reset())
            self.assertIsNone(peak.peak())
            self.assertIsNone(peak._thread)  # no sampler is started for nothing to sample


class TestTheConverterIsWiredToTheseParts(unittest.TestCase):
    """The behavior above is tested where it lives. These pin that `main` and
    `convert_one` actually use it: dropping one argument from a call turns a whole
    feature off without failing any test of the part."""

    @classmethod
    def setUpClass(cls):
        with open(gz.__file__, encoding="utf-8") as fh:
            cls.tree = ast.parse(fh.read())

    def function(self, name):
        return next(
            n for n in ast.walk(self.tree) if isinstance(n, ast.FunctionDef) and n.name == name
        )

    def keywords_of_calls(self, function, callee):
        return [
            {k.arg for k in call.keywords}
            for call in ast.walk(function)
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
            and call.func.id == callee
        ]

    def test_main_gives_the_pool_drain_the_ledger(self):
        calls = self.keywords_of_calls(self.function("main"), "_drain_with_admission")
        self.assertEqual(len(calls), 1)
        self.assertIn("ledger", calls[0])

    def test_main_builds_the_ledger_from_the_environment_and_withdraws_from_it(self):
        main = self.function("main")
        callees = {
            c.func.id for c in ast.walk(main)
            if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
        }
        self.assertTrue({"ledger_from_env", "close_ledger", "converts_in_process"} <= callees)

    def test_main_projects_with_the_sample_width_read_from_the_sidecar(self):
        main = self.function("main")
        projections = self.keywords_of_calls(main, "projected_peak_bytes")
        self.assertEqual(len(projections), 1)
        self.assertIn("sample_bytes", projections[0])
        callees = {
            c.func.id for c in ast.walk(main)
            if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
        }
        self.assertIn("sample_bytes_from_sidecar", callees)

    def test_a_worker_reports_the_anonymous_peak_on_every_outcome(self):
        convert_one = self.function("convert_one")
        reports = [
            node for node in ast.walk(convert_one)
            if isinstance(node, ast.Dict)
            and any(isinstance(k, ast.Constant) and k.value == "peak_anon" for k in node.keys)
        ]
        self.assertEqual(len(reports), 1)  # the success result
        calls = [
            c for c in ast.walk(convert_one)
            if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
            and c.func.id == "memory_failure_result"
        ]
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(len(c.args) == 4 for c in calls))  # primary, exc, rss, anon
        starts = [
            c for c in ast.walk(convert_one)
            if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
            and c.func.id == "reset_peak_anon"
        ]
        self.assertEqual(len(starts), 1)


if __name__ == "__main__":
    unittest.main()
