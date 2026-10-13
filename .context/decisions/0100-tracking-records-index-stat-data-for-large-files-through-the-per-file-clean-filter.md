# ADR 0100: Tracking records index stat data for large files through git-annex's per-file clean filter

**Status:** proposed
**Date:** 2026-10-12
**Owner:** Seyed Yahya Shirazi

Issue #1704 (follow-up to #884 and #1455).
Relates to [ADR 0094](0094-the-save-step-skips-re-reading-annexed-content-only-on-large-unchanged-trees.md), whose rejected alternative "prime the index's stat data" this ADR finds a way to do, and whose save skip it leaves in place.

## Context

`git annex add` stages an unlocked file through `git update-index --index-info`, which leaves its index entry with zero stat data.
Every later git command that compares the tree with the index then runs the file through the clean filter.
With `filter.annex.process` set, which `git annex init` does, that is the long-running filter: git sends it the whole content over a pipe, and only then does git-annex answer from its inode cache that nothing changed.
The add itself reads nothing through either filter (measured with `git annex add --batch -J4` and `-J16`, and the older argument form).
The reads come afterwards, from whichever command next looks at the file.

Measured with git-annex 10.20260901 and git 2.54 on the Apple File System (APFS), through `runDataSteps` with a directory remote standing in for S3, counting the bytes git pipes into the filter (the files are 200 MiB each; these are the reads without priming):

- A fresh upload of 1.26 GB in six files: nothing during the steps (the save skips the read above 1 GiB, ADR 0094), then 1,258 MB at the first `git status`.
- The next upload to the same dataset, after two subjects were added: 2,517 MB during the tracking step, because a completed upload clears its progress, every data file is an add target again, and the add's check of already-indexed paths (`git diff --name-only`) reads each zero-stat file twice. Then 210 MB at the first `git status`.
- A tracking step resumed after half the files were added: the added half read twice in the same check (1,258 MB), then 629 MB at the first `git status`.

The issue reports 75 to 95 MB/s a stream for this read on CephFS, over 80 minutes for 1.9 TB.

`git update-index --refresh` reads everything too while the filter process is set (1,258 MB, 3.25 s), which is why ADR 0094 found no way to prime.
With `filter.annex.process` absent, git uses git-annex's per-file clean filter, `git-annex smudge --clean -- %f`, which answers from the same inode cache from the path alone: the same refresh piped 0.8 MB (a pipe buffer per file) in 0.38 s, recorded the stat data, and the next `git status` read nothing.
git-annex does exactly this for its own restage: it records the value under `filter.annex.process-temp-disabled`, unsets `filter.annex.process`, refreshes, sets it back and removes the record, and its next restage restores from a record a killed run left (traced with `GIT_TRACE`).

The per-file filter is one git-annex process per file, and that cost does not depend on the file's size: 0.06 to 0.26 s a file on APFS with 6 to 6,000 annexed files in the index, and 500 files of 150 KB took 129.9 s against 0.75 s through filter-process.
The issue reports 3.7 s for a 25 GB file on CephFS.

## Decision

**The upload's tracking step records index stat data for data files whose recorded size is at least 1 GiB (`PRIME_MIN_FILE_BYTES`), with `git add --refresh` and the filter process out of the repository's configuration for the duration, under git-annex's own marker, and with every way that change could outlive the step closed.**

- It runs twice in the tracking step: before the add, for large targets already in the index (left by an interrupted run or by the last upload's save), and after the add, for every large target.
  The second runs after the step is stamped: the files are tracked whatever it finds.
- `git add --refresh -- <paths>` only records stat data for an entry whose content cleans to the blob already staged, and only for the paths named.
  It never stages anything, so what is committed cannot change.
  A file edited since it was tracked cleans to a different pointer, keeps zero stat data, and is still read and still seen.
- Both filter forms answer from the same inode cache (inode, size, mtime), so they agree on which files are unchanged.
  An edit in place that puts the size and the exact mtime back is missed by `git status` through filter-process as well; the priming hides nothing that `git status` would have shown.
- Only paths in the index are named, literally: `git add --refresh` refuses a whole list over one path it does not track.
- Nothing is primed unless `filter.annex.clean` is git-annex's and the filter process, if any, is set once, only in the repository's own configuration, and not empty.
  One set anywhere else cannot be taken out for one command, and the files are left to be read as before, with a warning.
  An empty value counts: git reads an empty filter process as no filter at all, so with the repository's value out, an empty one in a lower scope (global, system, an include before the repository's entry) would take effect and every `git add` in the window would store raw content in git. A review reproduced exactly that against the first version of this code, which dropped empty values when it read the configuration.
  After the unset, and before each chunk is refreshed, no filter process may be left in any scope; otherwise the chunk is not refreshed and the value is put back.
  With no filter process at all (the issue's own workaround), git already uses the per-file filter and nothing is changed.
- The paths are refreshed in chunks of 100, and the value is taken out for one chunk at a time and put back before the next, so the window is one chunk long (about six minutes at the issue's 3.7 s a file) rather than the whole refresh. Measured locally it has no measurable cost: 200 files took 15.8 to 17.4 s chunked against 16.4 to 16.7 s in one window, which is noise.
  A value someone sets in the repository while the priming runs is theirs: a restore leaves it in place, and a chunk that finds the value changed since the first read stops instead of writing the old value back.
  An empty value is the exception: it is never theirs to keep, because git reads it as no filter at all and anything staged meanwhile would go into git as raw content. A restore that finds one refuses, keeps the marker and fails the step; the next upload's recovery refuses it too, with the text that says not to run `git add`; and the signal handler replaces it with the recorded value. A review reproduced the alternative: an empty value written during the window was kept, the upload went on, and the save committed a 2 MiB recording to git.
- The value is written to `filter.annex.process-temp-disabled` before `filter.annex.process` is unset, and put back after each chunk, retried once and read back.
  On SIGINT, SIGTERM and SIGHUP it is put back synchronously, retried for about 2.5 seconds in case this process's own `git config` holds `.git/config.lock` at that moment, and the CLI's child processes are then asked to stop before the signal is re-raised.
  The restore does not wait on the refresh (`git config` takes `config.lock`, not the `index.lock` the refresh holds), but a refresh left running would hold `index.lock` until it had been through every file, and a signal sent to the CLI alone does not reach it.
  SIGKILL and a power loss leave the marker, which the start of the next upload's steps restores (and git-annex's next restage would).
- A configuration that cannot be read fails the step; one that cannot be put back fails it with the two commands that restore it.
  Because a chunk is only refreshed once no filter process is left in any scope, what a killed or failed run leaves behind is a repository in which git uses git-annex's per-file filters, which store files the same way but start one git-annex process per file; the failure text says so only when that check passed, and otherwise tells the person not to run `git add` or `git commit` until the value is back.
  It is still a change to the person's configuration that nothing else would undo, and nothing stops the other scopes changing afterwards.
- A leftover marker next to a filter process that is set is only removed, and only warned about when it cannot be: nothing is out of the configuration in that state.
  A marker that cannot be written (a `config.lock` held at that moment) skips the priming with a warning: nothing has been taken out yet.
  Like git-annex's own restage, the restore puts the filter process back from a marker even if the person removed it by hand after the marker was written.
- A refresh that fails is only a warning: it can have recorded nothing but stat data.
- A file edited since it was tracked is cleaned by git-annex while the refresh compares it, and git-annex stores its new content as an unreferenced object in `.git/annex/objects`, as plain `git status` does (measured: two objects before, three after). That is not new, but for a 25 GB edited file it is a 25 GB copy.

## Consequences

- With the threshold lowered to 100 MB for the test, so that those 200 MiB files were primed, the bytes piped into the filter on the three runs above fell to 0.8, 1.1 and 0.8 MB, and the first `git status` afterwards to nothing.
  At the shipped 1 GiB threshold none of those files is primed and the numbers above stand; the measurement shows what happens to a file at or above the threshold.
  Such a file is no longer read by the next upload's add, by the save (with or without ADR 0094's skip), or by the first command after the upload.
- The double re-read in the next upload's add, after a save that took ADR 0094's skip, is fixed only for files at or above 1 GiB. A tree of many smaller files, the common EEG case, keeps it: each such file is read twice by the next upload's add unless a `git status` ran in between.
- Each large file costs one git-annex process per run that finds its entry without stat data, and an `lstat` on runs that do not.
- Files below 1 GiB keep the old behavior, including ADR 0094's deferred read, because for them the per-file process can cost more than the read it saves.
  At 1 GiB the per-file process is cheaper than the read on both measured hosts: about 0.6 s to re-read on APFS against 0.06 to 0.26 s a file (a thin margin of 2.4 times at worst, where the read is fast anyway), and 11 to 14 s on the issue's CephFS against 3.7 s (3 times). It is not a measured crossover on CephFS, where only the one per-file figure from the issue is known.
- Nothing here was run on CephFS, on a multi-terabyte tree, or against S3.
- The check that no filter process is left in any scope sees only the scopes the CLI's own environment shows it. A scope that environment hides can defeat it: with an empty value in the system configuration and the CLI run under `GIT_CONFIG_NOSYSTEM=1`, a review reproduced a `git add` run elsewhere without that override storing a 500,000-byte raw blob during the window. It needs a deliberate override and is not handled.
- `git annex init` does not set `filter.annex.required`, so in either filter mode a clean filter that fails during someone's `git add` lets git store the raw content. That is how git-annex repositories already behave and is not changed here.

## Data for the threshold decision

The threshold is the maintainer's call; this is what it trades.
The break-even file size is the per-file cost times the filter-process read rate.

| Call | What one primed file saves | Break-even on the issue's CephFS (3.7 s a file, 75 to 95 MB/s) | Break-even on local APFS (0.06 to 0.26 s a file, about 1.7 GB/s) |
|---|---|---|---|
| After the add | one read (the save's `git add -A` or the first `git status`) | about 280 to 350 MB | about 100 to 440 MB |
| Before the add | two reads (the add's check reads each file twice) | about 140 to 175 MB | about 50 to 220 MB |

A file primed after the add also spares the next upload's two reads when nothing refreshed the index in between, which moves its break-even toward the second row.
1 GiB is above every figure in the table; anything between about 350 MB and 1 GiB is a gain on the issue's figures that the shipped value leaves unused.

## Alternatives considered

- **`-c filter.annex.process=` for one command.** Rejected: git treats an empty value as no filter at all, not as unset. A refresh then hashes the raw content and records nothing, and `git add` of a new 200 MiB file staged it as a 209,715,200-byte git blob.
- **`git update-index --refresh` with the filter process set.** Reads everything (1,258 MB); this is what ADR 0094 tried.
- **`git update-index -q --refresh -z --stdin` with paths, git-annex's own restage form.** Rejected: it re-stages the paths it is given, and a file edited after tracking had its new content annexed and staged.
- **`git annex restage`.** Does nothing for entries `git annex add` staged; its log is empty.
- **Leave the filter process unset for the whole upload (the issue's workaround).** Rejected as a default: every `git add -A` and `git status` would start one git-annex process per file, and a tree of many small files pays far more than the read (129.9 s against 0.75 s for 500 files of 150 KB).
- **Hand already-indexed files to `git annex add --batch` instead of checking them with `git diff`.** Rejected: git-annex re-hashes them (2.55 s for 600 MB), one read instead of two, not none.
- **`assume-unchanged` around the add's check, as ADR 0094 does around the save.** Defers the read rather than removing it, hides edits while set, and needs the same restoration machinery as this does.
- **A lower threshold.** Not chosen here. For the call after the add, which saves one read, a file below about 280 to 350 MB re-reads on the issue's CephFS in less than the 3.7 s the issue reported for one per-file process; the call before the add saves two reads, so its break-even is about half that (140 to 175 MB, from the table). Only that one per-file figure is known, and the table above is the data for revisiting it.
- **One window for the whole refresh.** Replaced by one window per chunk of 100 paths, which measured the same locally and keeps the window from spanning hours on slow storage.

## Receipts

- `src/lib/git-annex/index-prime.ts` - `primeIndexStat`, `restoreSuspendedFilterProcess`, `PRIME_MIN_FILE_BYTES`
- `src/lib/upload/transfer.ts` - `primeLargeDataFiles`, the tracking branch of `uploadDataToS3`
- `src/lib/upload/data-steps.ts` - the restore at the start of the upload steps
- `test/upload-index-prime.unit.test.ts` - the reads that are gone, the threshold, edits, signals, a configuration that cannot be restored, and the configurations left alone, against real git-annex
- `test/helpers/prime-runner.ts` - the process the signal tests interrupt
