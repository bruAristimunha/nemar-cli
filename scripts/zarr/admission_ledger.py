#!/usr/bin/env python3
"""The admission ledger: what every conversion driver on this node has promised
itself, readable by all of them.

Admission (``generate_zarr._drain_with_admission``) packs recordings under a RAM
ceiling and a scratch-disk budget. Both are measured on the NODE, but each driver
used to be the only one on it, so each assumed what it measured was its own to
spend. With several datasets converting at once (hallu-zarr.sh slots) that is
wrong in a specific way: ``MemAvailable`` and the free space of the volume already
exclude what the other drivers HAVE taken, and say nothing about what they have
RESERVED and not taken yet. A driver that admitted a 145 GiB recording sees the
volume nearly empty for the first hours of its life, so a second driver would read
the same free space and admit its own.

The ledger closes exactly that gap. Each driver publishes its reservations in one
small file; before admitting, a driver reads the others' and subtracts what they
still owe the node:

* RAM: a peer's reserve minus what its workers have taken since they started
  (the same ``RssAnon`` bookkeeping a driver already does for itself).
* Scratch: a peer recording's projected peak minus the disk blocks it holds now.

Deciding and reserving happen under one exclusive ``flock`` (``exclusive``), so
two drivers cannot both read the same free space and both take it.

Nothing here knows how a reserve or a peak is computed, or how to measure a peer's
workers: the driver passes those in. That keeps the module stdlib-only, free of the
converter's import cost, and testable with real files and real processes.

A file left by a dead driver is removed by the next one to look (``peers``), keyed
on the pid AND the process start time, so a recycled pid does not keep a dead
driver's reservations alive. Everything is advisory in one direction only: a driver
with no ``ZARR_LEDGER_DIR`` admits exactly as before.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import time
from collections.abc import Callable, Iterator

# How long a driver waits on nothing in flight, blocked only by what its peers hold,
# before it asks them to stop admitting. Without it, a recording that needs most of
# the node would wait behind an endless stream of small ones from the other drivers.
STARVATION_SECONDS = float(os.environ.get("ZARR_LEDGER_STARVATION_SECONDS", "1800"))
# The exclusive lock is held for a /proc read and a file write, a second at the very
# most. A wait longer than this means something is wrong, and the caller admits nothing
# this round instead of admitting without the lock.
LOCK_TIMEOUT_SECONDS = float(os.environ.get("ZARR_LEDGER_LOCK_TIMEOUT_SECONDS", "60"))

FORMAT_VERSION = 1

# Lock descriptors this process holds right now. A flock belongs to the open file
# DESCRIPTION, not to the descriptor, and a forked child shares the parent's
# description: the converter's process pool forks its workers lazily, while a driver
# holds the lock (it submits a recording under it), and without the hook below each
# worker would keep the lock held for as long as it lived. A killed driver would leave
# it held by its orphans, and every other driver would wait on a lock nobody could
# release.
_HELD_FDS: set[int] = set()


def _close_inherited_lock_fds() -> None:
    for fd in list(_HELD_FDS):
        with contextlib.suppress(OSError):
            os.close(fd)  # the child's reference only; the parent's lock is untouched
    _HELD_FDS.clear()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_close_inherited_lock_fds)


class LedgerBusy(RuntimeError):
    """The exclusive lock could not be taken in time."""


def process_start_ticks(pid: int, proc_root: str = "/proc") -> int | None:
    """Start time of ``pid`` in clock ticks since boot (field 22 of ``stat``), or
    None when there is no such process. A zombie counts as gone: it holds no memory
    and will never publish again."""
    try:
        with open(os.path.join(proc_root, str(pid), "stat"), encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return None
    # ``comm`` is parenthesized and may itself contain spaces or parentheses, so the
    # fields after it are counted from the LAST closing parenthesis.
    rest = text.rpartition(")")[2].split()
    try:
        if rest[0] in ("Z", "X"):
            return None
        return int(rest[19])  # field 22 overall; ``state`` is rest[0] = field 3
    except (IndexError, ValueError):
        return None


def driver_is_alive(pid: int, start: int | None, proc_root: str = "/proc") -> bool:
    """Whether the driver that published ``(pid, start)`` is still running."""
    if os.path.isdir(proc_root):
        now = process_start_ticks(pid, proc_root)
        return now is not None and (start is None or now == start)
    # No /proc (macOS): the best available answer, and good enough for tests there.
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class Ledger:
    """One driver's view of the node's reservations, rooted at a shared directory.

    ``reserve``, ``set_track_dir``, ``mark_waiting``, ``flush`` and ``close``
    publish this driver's file, and ``peers`` may delete a dead one's, so all of
    them must run inside ``exclusive()``. ``AssertionError`` otherwise: an
    unlocked write is the race the module exists to prevent. ``release`` is the one
    exception, for the reason it gives."""

    def __init__(self, root: str, *, pid: int | None = None, proc_root: str = "/proc") -> None:
        self.root = root
        self.pid = os.getpid() if pid is None else pid
        self.proc_root = proc_root
        self.start = process_start_ticks(self.pid, proc_root)
        self.track_dir: str | None = None
        self.waiting_since: float | None = None
        self._reservations: dict[int, dict] = {}
        self._next_token = 1
        self._locked = False
        self._fd: int | None = None
        self._dirty = False
        os.makedirs(root, exist_ok=True)
        self._lock_path = os.path.join(root, ".lock")
        self._path = os.path.join(root, f"{self.pid}.json")

    # --- locking -----------------------------------------------------------------

    def acquire(self, timeout: float | None = None) -> None:
        """Take the node-wide lock, waiting up to ``timeout`` seconds (default
        ``LOCK_TIMEOUT_SECONDS``). Not reentrant: a second thread of this process
        blocks like another process would, because each acquire opens its own
        descriptor. Prefer ``exclusive()``."""
        assert self._fd is None, "the admission ledger lock is not reentrant"
        limit = LOCK_TIMEOUT_SECONDS if timeout is None else timeout
        fd = os.open(self._lock_path, os.O_CREAT | os.O_RDWR, 0o666)
        deadline = time.monotonic() + limit
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(fd)
                    raise LedgerBusy(
                        f"admission ledger {self.root} busy for {limit:g}s"
                    ) from None
                time.sleep(0.02)
            except BaseException:
                os.close(fd)
                raise
        self._fd = fd
        _HELD_FDS.add(fd)
        self._locked = True

    def unlock(self) -> None:
        """Release the lock taken by ``acquire``."""
        fd, self._fd = self._fd, None
        self._locked = False
        if fd is not None:
            _HELD_FDS.discard(fd)
            # Unlock explicitly as well as closing: a child forked while the lock was
            # held (on a platform without register_at_fork) shares the description, and
            # only an explicit LOCK_UN releases it for them.
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    @contextlib.contextmanager
    def exclusive(self, timeout: float | None = None) -> Iterator[None]:
        """Hold the node-wide lock for the body."""
        self.acquire(timeout)
        try:
            yield
        finally:
            self.unlock()

    def sleep_unlocked(self, seconds: float, timeout: float | None = None) -> None:
        """Sleep without holding the lock, then take it again. For a driver that has
        decided to wait and must not keep its peers waiting with it."""
        self.unlock()
        try:
            time.sleep(seconds)
        finally:
            self.acquire(timeout)

    def _require_lock(self) -> None:
        assert self._locked, "the admission ledger is written only under exclusive()"

    # --- this driver's own file --------------------------------------------------

    def _publish(self) -> None:
        self._require_lock()
        doc = {
            "v": FORMAT_VERSION,
            "pid": self.pid,
            "start": self.start,
            "track_dir": self.track_dir,
            "waiting_since": self.waiting_since,
            "reservations": {str(t): r for t, r in self._reservations.items()},
        }
        tmp = f"{self._path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        os.replace(tmp, self._path)  # a reader sees the old file or the new, never half
        self._dirty = False

    def flush(self) -> None:
        """Publish a change made while the lock could not be had (see ``release``)."""
        self._require_lock()
        if self._dirty:
            self._publish()

    def set_track_dir(self, track_dir: str | None) -> None:
        """Where this driver's workers record what they have started with, so a peer
        can tell how much of a reserve has already been taken."""
        self._require_lock()
        if track_dir != self.track_dir:
            self.track_dir = track_dir
            self._publish()

    def reserve(self, ram: int, scratch: int, paths: list[str]) -> int:
        """Record one recording's reserve and projected scratch peak; returns the
        token ``release`` takes."""
        self._require_lock()
        token = self._next_token
        self._next_token += 1
        self._reservations[token] = {"ram": int(ram), "scratch": int(scratch), "paths": list(paths)}
        self._publish()
        return token

    def release(self, token: int) -> None:
        """Give a reservation back. Allowed without the lock: a driver that cannot get
        it in time still must not keep a recording that has finished, so the change is
        made here at once and published by the next ``flush`` (or any other write).
        Until then peers see more reserved than is, which is the safe direction."""
        if self._reservations.pop(token, None) is not None:
            self._dirty = True
            if self._locked:
                self._publish()

    def release_all(self) -> None:
        """Give every reservation back; see ``release`` for the unlocked case."""
        if self._reservations:
            self._reservations.clear()
            self._dirty = True
            if self._locked:
                self._publish()

    def mark_waiting(self, waiting: bool, now: float | None = None) -> None:
        """Say that this driver has nothing in flight and is held up only by its
        peers (``waiting``), or that it no longer is. The time is kept from the first
        call, so a long wait is one wait."""
        self._require_lock()
        if waiting and self.waiting_since is None:
            self.waiting_since = time.time() if now is None else now
            self._publish()
        elif not waiting and self.waiting_since is not None:
            self.waiting_since = None
            self._publish()

    def close(self) -> None:
        """Withdraw this driver from the ledger."""
        self._require_lock()
        self._reservations.clear()
        self.waiting_since = None
        with contextlib.suppress(FileNotFoundError):
            os.remove(self._path)

    # --- the other drivers -------------------------------------------------------

    def peers(self) -> list[dict]:
        """The live drivers other than this one, as their published documents. A file
        whose driver is gone, or that cannot be read as a document, is removed."""
        self._require_lock()
        found: list[dict] = []
        try:
            names = os.listdir(self.root)
        except OSError:
            return found
        for name in sorted(names):
            stem, dot, ext = name.partition(".")
            if ext != "json" or not dot or not stem.isdigit() or int(stem) == self.pid:
                continue
            path = os.path.join(self.root, name)
            try:
                with open(path, encoding="utf-8") as fh:
                    doc = json.load(fh)
                pid = int(doc["pid"])
                reservations = doc["reservations"]
                if not isinstance(reservations, dict):
                    raise TypeError("reservations is not an object")
            except FileNotFoundError:
                continue
            except (OSError, ValueError, KeyError, TypeError):
                with contextlib.suppress(OSError):
                    os.remove(path)
                continue
            if not driver_is_alive(pid, doc.get("start"), self.proc_root):
                with contextlib.suppress(OSError):
                    os.remove(path)
                continue
            found.append(doc)
        return found

    def others_in_flight(self) -> bool:
        """Whether any peer holds a reservation."""
        return any(doc["reservations"] for doc in self.peers())

    def others_outstanding(
        self,
        taken: Callable[[str | None, int], int],
        held: Callable[[list[str]], int],
    ) -> tuple[int, int]:
        """``(ram, scratch)`` the peers have reserved and not yet taken.

        ``taken(track_dir, reserved)`` is how much of ``reserved`` bytes of RAM that
        peer's workers have used (never more than ``reserved``); ``held(paths)`` is
        the disk blocks under ``paths`` right now. What a peer has already taken is
        in ``MemAvailable`` and in the volume's free space, so charging it again
        would count it twice."""
        ram = scratch = 0
        for doc in self.peers():
            reservations = list(doc["reservations"].values())
            reserved = sum(int(r.get("ram", 0)) for r in reservations)
            if reserved:
                ram += reserved - min(reserved, max(0, taken(doc.get("track_dir"), reserved)))
            for r in reservations:
                on_disk = max(0, held(list(r.get("paths") or [])))
                scratch += max(0, int(r.get("scratch", 0)) - on_disk)
        return ram, scratch

    def older_peer_waiting(self, now: float | None = None) -> bool:
        """Whether a peer that has waited longer than ``STARVATION_SECONDS`` is
        ahead of this driver in line. Ties go to the lower pid, so of two drivers
        waiting on each other exactly one is ahead."""
        current = time.time() if now is None else now
        mine = (self.waiting_since if self.waiting_since is not None else float("inf"), self.pid)
        for doc in self.peers():
            since = doc.get("waiting_since")
            if since is None or current - since < STARVATION_SECONDS:
                continue
            if (since, int(doc["pid"])) < mine:
                return True
        return False
