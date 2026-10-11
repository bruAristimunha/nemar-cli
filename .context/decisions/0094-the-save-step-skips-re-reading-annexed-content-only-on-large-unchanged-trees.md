# ADR 0094: The save step skips re-reading annexed content only on large trees, only for files that have not changed, and only while it can take the skip back

**Status:** accepted
**Date:** 2026-10-07
**Owner:** Seyed Yahya Shirazi

Issue #1642, see also the 2026-09-18 comment on #1455 (the save step's re-read), tracked under epic #1671.
Relates to [ADR 0031](0031-the-annex-policy-has-one-source-and-data-may-wear-a-metadata-extension.md) (the annex policy and what the save annexes).
Relates to [ADR 0060](0060-an-imported-tree-is-brought-onto-nemars-annex-policy-in-prepare.md), which records what `git annex add` considers: only files git sees as new or modified, which is why a re-run re-tracks a changed file, and why a file that was edited while a stale flag hid it is not re-tracked.

## Context

`git annex add` stages an unlocked file through `git update-index --index-info`, which leaves its index entry with zero stat data.
The save's `git add -A` then treats every annexed file as possibly modified and streams its full content through `git-annex filter-process` to find out that it is not.
On nm000358 (165 files, 1.6 TB, on Ceph) the "Saving dataset changes" step after the S3 copy took hours.
This re-read is the likely cause: it reproduces at small scale, but the save was not timed at that size.

Marking the annexed paths `assume-unchanged` for the duration of the save avoids that read.
It also hides those paths from git.
A flag that is wrong, or that outlives the save, silently omits every later edit and deletion of the file, and the user sees "Upload complete".
On a small tree the skip can cost more than it saves: one Ceph run saved 600 annexed 120 KB files plus 600 JSON files in 33.5 s with the skip and 6.6 s without it.
That run was not reproduced on local disk, where the skip is faster even at 600 files.

## Decision

**The save skips re-reading annexed content only when the recorded annexed bytes reach `SAVE_SKIP_MIN_BYTES`, only for a file whose size and mtime still match the upload plan's record, and with every way the flag could outlive the save closed.**

- The threshold is 1 GiB (`SAVE_SKIP_MIN_BYTES`).
  It is applied first to the sum of every data file's recorded size, an upper bound on the annexed bytes that costs nothing to compute, and then to the annexed files' recorded sizes.
  It is a conservative starting point, not a measured crossover: nm000358 is three orders of magnitude above it and the Ceph run (72 MB of annexed data) more than one order below.
  Below the data-size gate the save runs the stale-flag check and the plain `git add -A`, with no listing of annexed files, no stat pass and no index rewrite.
- A path is skipped only if its size and mtime still match what the upload plan recorded.
  The record predates a possibly multi-hour `git annex add`, and it is the right thing to compare with because `git annex add` leaves the size, mtime and inode of an unlocked file unchanged.
  This was verified against git-annex 10.20260901 on APFS; a test checks the filesystem the suite runs on, and others are unverified.
- A changed file fails the save, naming the first few paths and saying to re-run the upload, which re-tracks them.
  A file that has stopped being data since it was tracked is dropped from the skip before the comparison and saved normally, because re-running the upload could never re-track it.
  The comparison runs again after the commit, and a marked file that vanished or became unreadable counts as changed.
- Stale flags are cleared at the entry of every save, at the repository's top level, for annexed paths only.
  They are also cleared at the start of the upload steps, before `git annex add`, because `git annex add` on a flagged file exits 0 and changes nothing: an edit made after a killed run would otherwise be stamped as uploaded and never tracked, copied or committed.
  A save that cleared any flag reads every file instead of skipping, since the plan's record of that file may postdate an edit the flag hid.
  A failure to check or to clear flags fails the step with git's message, because the alternative is a "saved" result that is not.
  The next run clears them first, so the way out is to run it again.
- The flags are cleared in a `finally`, retried once.
  A failure after the commit fails the save and names the way out: `nemar dataset commit`, or the upload again, either of which clears them first.
- On SIGINT, SIGTERM and SIGHUP the clear is attempted before the process dies, and it is best effort.
  A signal sent to the CLI alone, unlike a terminal's Ctrl-C, does not reach the `git add` it interrupted, so the handler asks the CLI's child processes to stop, retries for about 2.5 seconds while `index.lock` is held, bounds every attempt with a timeout, and prints the recovery on stderr if it still fails.
  The recovery is always the two nemar commands that clear the flags; the `git update-index` command itself is printed only for 10 or fewer paths, none of which (nor the repository path) has a character a command cannot carry.
  SIGKILL and a power loss cannot run it at all; what they leave behind is cleared by the next run's entry clear.
  After the handler the signal is re-raised, and the process dies the way the signal says only when no other handler for it is registered.
- A failure to mark degrades to the plain save, with a warning: the skip is an optimization, never a reason to refuse a save.

The deferred cost is accepted.
The skip defers the re-read, it does not remove it: the entries stay zero-stat, so the first `git status` afterwards re-reads the annexed content once.
Measured on local disk, that first `git status` took about 0.35 to 0.45 s against 0.01 s at 600 files of 120 KB, and 4 to 7 s against 0.04 s at 10,000 annexed files plus 5,000 JSON files.

## Consequences

- A large upload does not spend the read in "Saving dataset changes".
  The first `git status`, `nemar dataset update` or `nemar dataset commit` afterwards pays it once, and it grows with the annexed bytes.
  The total work is unchanged: 9.4 s for the plain save against 5.3 s plus 4.3 s for the skip save and the first status, at 10,000 annexed files plus 5,000 JSON files (local disk).
- The save fails on a changed file, on an annexed file that disappeared, and on a git that cannot report or clear its flags.
  Each message says what to do.
- Index stat data is still not primed, so the cost above is paid on a later command rather than avoided.

## The check of recorded files that precedes the save

The save only follows an S3 step whose answer is trusted, so the cost of that step belongs here too.
When the S3 step has something to add or copy, it does not take the location log's word for a file it already records at the remote: it asks the remote itself.
It uses `git annex copy --to` without `--fast` for files whose content is in this repository, and `git annex fsck --fast --numcopies=1 --mincopies=1 --from` for files whose content is not (`copy` skips those with exit 0 and never contacts the remote).
The numcopies flags are there because fsck also enforces the repository's numcopies, and would fail a file the remote does hold when two copies are wanted.
When there is nothing to add or copy, the step does not contact the remote at all.
A path that fsck or copy gives no record for was not asked: for fsck the step is unverifiable, and for copy the summary says git-annex gave no result for some files and ends as a warning.
The check costs one request per recorded file, not per pending file.
At the 75 ms midpoint of 50 to 100 ms a request that is about 5 minutes for 15,000 files at the default `-J4` and about 19 minutes at `-J1`.
The two-hour credential window is reached at roughly 290,000 files at `-J4` and 100 ms a request (7,200 s x 4 / 0.1 s).
Above 5,000 recorded files the step prints the count and an estimate before it starts.
A run that gets through the check, with output it understood, stamps `remote_checked_at`, `remote_checked_count` (the number of annexed files it covered), and `remote_checked_fingerprint` in the progress file. The fingerprint is SHA-256 over the effective remote target identity and the sorted annexed path/key pairs. The target identity includes the S3 remote name and the effective remote arguments, but never credentials.
A resume within 6 hours skips the check only when the current recorded path/key set and effective remote target exactly match that fingerprint; both walks of the location log still run.
The count is a quick guard, while the fingerprint catches a collaborator's merged location log that replaces one recorded key with another without changing the number of files, or a resume that reconfigures the same remote name for a different environment or bucket.
A stamp that is missing, unreadable, in the future or older than 6 hours, or a count or fingerprint that is missing or different, means the check runs. Progress files written before the fingerprint was added therefore get one full check before they can use the optimization again.
There is no flag to skip the check, because a flag would let "uploaded" mean less than it says.
fsck strikes a key from the location log when it finds the object missing, and also when the remote could not be read, so the step reports "git-annex reports the remote no longer holds N files" and says that `git annex fsck --fast --from nemar-s3` puts back keys struck only for the second reason.

## Alternatives considered

- **Always skip.** Rejected by the small-tree measurement on Ceph: 33.5 s against 6.6 s.
- **Never skip.** Rejected because the re-read grows with the annexed bytes and the one large upload seen spent hours in this step.
- **Prime the index's stat data so the read never happens.** No way found: only `git status` and `git update-index --refresh` were tried, and both re-read the content; writing the index by hand is not something to maintain.
- **Skip by a per-file size threshold.** Rejected because it would need the same two index rewrites and a per-file decision with more code to get wrong, for a gain the tree-level gate already gives (the gate uses recorded sizes held in memory).

## Receipts

- `src/lib/git-annex/clone-push.ts` - `saveDataset`, `clearStaleFlags`, `compareRecordedStat`, `clearStaleAssumeUnchanged`, `armUnmarkOnInterrupt`
- `src/lib/upload/finalize.ts` - `SAVE_SKIP_MIN_BYTES`, `planSaveSkip`, `dropFilesNoLongerData`, `saveDatasetStep`
- `src/lib/upload/transfer.ts` - `copyAnnexedToRemote`, `describeRecordedCheck`, `transferAnnexedData` (writes the stamp)
- `src/lib/git-annex/transfer.ts` - `checkRemoteHolds`
- `src/lib/upload-progress.ts` - `isRecordedCheckFresh`, `markRecordedChecked`
- `test/upload-save-skip.unit.test.ts` - the gate, the stat guard, the stale flags, against real git-annex
- `test/upload-save-failures.unit.test.ts` - git failing, a subdirectory, an interrupt
- `test/upload-data-steps.unit.test.ts` - a run killed or signaled inside the save, then resumed
- `test/upload-recorded-check.unit.test.ts` - the check of recorded files, the stamp

## Amendment (issue #1644 follow-up, 2026-10-09)

The recorded-file presence check shares the upload's renewable STS credential session with
pending copies. It refreshes before a bounded check chunk when the remaining lease is shorter
than the safety margin plus the longest observed batch, and retries only that chunk after an
identifiable expired-credential result or a failed check that returns after the known lease has
expired. S3 `HeadObject` failures are generic, so no exact error code is available for an
`fsck` check; the lease timestamp is the signal for that case. Recorded paths missing from the
current data-file inventory have unknown sizes and are checked one at a time, never grouped as
zero-byte files. A recorded path that is in the inventory is sized from it and batched like any
other, so a resume that adds only a few files still checks the rest in bulk. A newly transferred path reported in a parsed git-annex JSON record resets the chunk's
fruitless-expiry counter, while the upload's overall renewal limit still bounds retries. This is
only a retry-progress signal; durable progress and final confirmation still come from the
location log. Copy retry summaries count unique transferred paths across attempts only when
git-annex output remains understood; uncertain output remains unrecognized. Neither a loopback
S3 stand-in nor CI closes the owner-selected live-S3 and `sandboxCommand` acceptance gap.

## Known gap at release (review of 2026-10-10)

`nemar dataset update` runs its own `git status` and `git add -A` and never clears stale assume-unchanged
flags, so it does not do what this ADR says every save does. The flags outlive a save that was killed
with SIGKILL or lost power. A flag left that way, an edit to the same annexed file, and then `update`
reads "No changes detected" or leaves the edit out of the pull request. Run `nemar dataset commit` (or the
upload again) in that directory first; both clear stale flags. Routing `update` through the same clear is
the fix.
