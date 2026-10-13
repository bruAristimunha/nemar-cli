# ADR 0101: Zarr conversions run side by side in slots and admit against one shared budget

**Status:** accepted
**Date:** 2026-10-13
**Owner:** Seyed Yahya Shirazi

## Context

On 2026-10-13 a single run of `hallu-zarr.sh` had held the node's one lock for 5.5 days, converting `nm000276`: 40 BrainVision iEEG recordings of 100 to 145 GiB each, stored as float32 (sub-48 has 39 channels).
Every hourly cron tick logged "another hallu-zarr instance holds the lock; exiting", and every dataset behind it in the queue waited (`nm000289` since 2026-10-06).
The node was almost idle.
Load average was 1.1 on 32 cores, 54 of 62 GiB of RAM were available, and 474 of 954 GiB of scratch were free.
The run's pool had 24 workers and 23 of them were idle.

Two limits kept that run to one recording at a time, and both are admission, not hardware.
Each recording reserved 20 to 55 GiB of RAM against a ceiling of about 46 GiB.
Each charged 3 times its size on scratch (the raw blob, a float32 memmap, the int16 memmap and the views), which for a 145 GiB recording is more than half the volume.
The second limit is real for recordings that size.
The first is not.
The worker's anonymous memory (`RssAnon`) held at 6.2 GiB while its peak resident size passed 10 GiB, the difference being the scratch memmap's file-backed pages, which the kernel already counts as available.
The calibration warnings ("needed 48.7 GiB, reserved 39.2 GiB") compared a reserve, which is anonymous memory, with a resident peak, and read as a projection that was too low when it was not.
One recording (145 GiB, about 32 channels) was refused outright as too large for the node: a projected 54 GiB against the 46 GiB budget, from a projection that assumes two bytes per sample for a file that stores four.

The single lock was also what made several other things safe.
`claim_next` documented that it relied on it to keep two drivers off one queue.
The sweep of orphaned scratch, the update of the driver clone and the biosigIO environment, and the admission control itself all assumed the node belonged to one driver.
Admission reads `MemAvailable` and the volume's free space, both of which already exclude what other drivers have taken and say nothing about what they have reserved.
Two drivers each admitting a 145 GiB recording into 474 GiB of free scratch would both be told yes.

## Decision

**Slots.**
A cron tick starts one drain per free slot (`ZARR_SLOTS`, default 4), each holding its own lock, with its own scratch directory and log, claiming its own dataset and converting `ZARR_JOBS_PER_SLOT` (default 4) recordings at a time.
Slot 0 keeps the lock, scratch directory and log the single drain always had, so a drain started before this change counts as slot 0.
`ZARR_JOBS` can lower the per-slot count and never raise it, so a crontab that still says `ZARR_JOBS=24` does not give every slot 24.
A one-off `--dataset` run takes the first free slot, and refuses to start on a dataset that a slot or another one-off is converting (a lock per dataset, held by the driver for as long as it lives; a slot handed a dataset a one-off holds waits for it).
The nightly staging run is one slot.
`ZARR_SLOT=n` runs a single slot, which is how the tick starts them.
`--stats` and `--requeue` read the queue and nothing else, so they run before any slot is taken.
`--limit` is a cap per slot.
Counts are plain decimal integers; a leading zero is refused rather than read as octal.

**One ledger per node.**
Every driver publishes its reservations in a file under `ZARR_LEDGER_DIR` (default `$ZARR_BASE/zarr-admission-ledger`, shared by production and staging because they share the machine).
Before admitting, a driver takes the ledger's `flock` and subtracts what its peers still owe:

- RAM: a peer's reserve minus what its workers have taken since they started, by the same `RssAnon` accounting a driver already does for itself.
- Scratch: a peer recording's projected peak minus the disk blocks it holds now.

Deciding and recording happen under that lock, so two drivers cannot both read the same free space.
The run-alone exception (a recording larger than the ceiling runs when nothing else does) applies only when no other driver holds anything.
A recording that would run if the node were its own, judged with the peers' written scratch given back (the free space already excludes it), waits for its peers.
After 30 minutes of waiting with nothing in flight, the driver that has waited longest is let in first.
The drivers it is waiting for (the ones holding reservations, which it names in its file) stop admitting, and so does any driver with nothing in flight, because each slot starts a new process for every dataset and a newcomer would otherwise pass the waiter at once; a driver with other work running that the waiter is not waiting for carries on.
After 60 minutes (`ZARR_LEDGER_WAIT_SECONDS`) the driver hands its queue back the way a scratch deferral does: the recordings stay pending, no attempt is spent, and the slot takes another dataset.
Without `ZARR_LEDGER_DIR` nothing changes, and with one even `--jobs 1` goes through the pool so that the other slots see it.
A ledger that cannot be used (the lock is not had in time, a peer's document cannot be read, or a write of the driver's own file fails, which a full volume does) makes a round admit nothing and leaves what is running alone; with nothing running the driver waits, and after the same 60 minutes defers with a note that says so.
The cause is printed once.
A failed write of a reservation also ends the round, since the recording that was just admitted is running where the others cannot see it.
Only the ledger's own failures are treated this way: an error from the pool (a worker that cannot be started) propagates, because the recording is already queued there and admitting it again would run it twice.
A file whose driver is gone is removed by the next driver to look, keyed on the pid and the process start time, unless a worker the driver recorded is still running: a killed driver's workers finish the recording they have, and its reservations stand until they do.
A file that cannot be read this time is left alone.
The lock descriptor is closed in forked workers and unlocked explicitly, because `flock` belongs to the open file description and the process pool forks its workers while the driver holds the lock.

**A heartbeat for long conversions.**
`zarr_queue.py heartbeat <dataset>` refreshes an `inprogress` row, and `hallu-zarr.sh` sends one every five minutes (`ZARR_HEARTBEAT_SECONDS`) while a queue-claimed dataset converts, for as long as the driver lives.
Each slot starts with a reconcile, and a reconcile returns to `pending` any `inprogress` row idle for six hours.
Without the heartbeat, a second slot would take `nm000276` after six hours and convert it onto the same S3 prefix twice.
The driver runs in the background so that the heartbeat can follow it, which makes the script responsible for signals: a TERM or INT to a slot stops its driver and then the slot, without spending an attempt (the row stays `inprogress` and the stale sweep returns it), and the tick forwards a TERM to its slots.

**Memory anticipated from what is measured.**
Workers sample `RssAnon`, and the calibration warnings compare the reserve with anonymous memory.
The streaming projection uses the recording's sample width when it can be pinned: for a `.vhdr`, size divided by channel count, sampling frequency and recording duration (the sidecar, which is git-tracked text) must come to within 3 percent of 2 or of 4 bytes.
A width of 4 projects at 8 times one channel's bytes instead of 12.
Anything else, and every other format, projects exactly as before.
Setup (the clone and the venv) is done by one slot at a time.

## Consequences

- A dataset that takes days occupies one slot instead of the node.
  The recording that was refused as too large now projects at about 36 GiB and fits.
- Concurrency follows the budget rather than a worker count: small EEG datasets run four wide in each of four slots, and two 145 GiB recordings cannot be admitted together because their scratch will not fit.
- The logs are per slot (`.nm-zarr.slotN.log`), so following the whole node means following several files, and the scratch directories are per slot (`zarr-scratch-slotN`).
- `--limit` caps each slot, not the tick, so an existing crontab with `--limit 20` allows up to 80 datasets per tick at four slots.
- A driver outside the ledger is visible to the others only through `MemAvailable` and the volume's free space.
  That covers a `--jobs 1` run, and a drain started by the previous version.
  The second is a transition problem, and the deploy note for this change registers it by hand.
- A peer that is alive but hung holds its reservations until it dies, and one that holds the lock itself is waited out the same way.
  The others wait out the limit and defer, which is slow and not wrong.
- The serial memory retry (a recording that exceeded its reserve is run again alone with the node's whole budget) needs the node, and with other slots busy it waits for them like any large recording.
  If they do not give way within the limit it is deferred and reported as the memory failure it was, so under heavy load a retry usually fails where it used to run after the pool drained.
- A wait limit set below the starvation threshold (`ZARR_LEDGER_STARVATION_SECONDS`, 30 minutes) turns the waiting driver's priority off, because the driver gives up first.
- The ledger reads the disk blocks of every peer reservation's scratch tree under the lock.
  That is cost, not correctness, and it grows with the number of files a recording has written.
- The sample width is inferred, not read.
  A sidecar whose duration is wrong in a way that lands exactly on 4 bytes would under-project an int16 recording, and the worker's `RLIMIT_DATA` backstop turns that into the existing serial memory retry rather than a killed node.
- Updating the driver clone while another slot is starting a driver can fail that start on an import.
  The window is the length of a `git reset` and the queue retries the dataset; it is accepted rather than closed with a lock held for the length of a conversion.
- Every change to admission now needs a test with two drivers.
  `test_admission_across_drivers.py` runs two real processes against one node, with a control that shows the overcommit without the ledger.

## Alternatives considered

- **Divide RAM and scratch evenly between the slots.**
  Simple, and wrong for exactly the case that prompted this: a 145 GiB recording needs about 36 GiB of RAM and 435 GiB of scratch, which no quarter of the node holds.
- **One driver draining several datasets through a shared pool.**
  Avoids a ledger, but is a rewrite of the engine's main loop, and loses the per-dataset process boundary that contains a crash or an out-of-memory kill.
- **Raise `ZARR_JOBS`.**
  The pool was already 24 wide with 23 workers idle.
  The limit was admission and the single dataset, not the pool.
- **Loosen or remove admission.**
  The history is 96 pool aborts from kernel out-of-memory kills before it existed, and a full scratch disk on this very dataset after it charged RAM alone.
- **Read the sample width from the BrainVision header.**
  Exact, but the header is annexed and admission deliberately downloads nothing.
  Worth doing if the inference ever misleads.

## Receipts

- Measured on `hallu` on 2026-10-13: `RssAnon` plateau 6.17 GiB and `VmHWM` above 10.3 GiB (4.4 GiB of it file-backed) for `nm000276` sub-48, 122,098,089,984 bytes, 39 channels, 1024 Hz, 764,336 s, which is exactly 4.000 bytes per sample.
- ADR 0029 (the engine lives with the CLI), ADR 0033 (the queue stamps the engine), nemar-cli #1111, #1112, #1142, #1483 and #1638 (admission, scratch admission, the atomic claim).
- `scripts/zarr/admission_ledger.py`, `scripts/zarr/test_admission_ledger.py`, `scripts/zarr/test_admission_across_drivers.py`, `scripts/zarr/test_zarr_memory_projection.py`.
