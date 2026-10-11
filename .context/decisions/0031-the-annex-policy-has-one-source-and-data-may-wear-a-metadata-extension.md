# ADR 0031: The annex policy has one source, and data may wear a metadata extension

**Status:** accepted
**Date:** 2026-08-25
**Owner:** Seyed Yahya Shirazi

Amends ADR 0015, which stands. This narrows "metadata never annexes" to
"metadata never annexes, except where the extension is lying", and puts the
policy in one place.

## Context

ADR 0015 decided that git-annex takes recognised data extensions or anything over
100 kB, and never takes `.tsv`, `.json`, `.md`, `.txt`, `.yml`, `.yaml`, `README*`,
`LICENSE*`, `CHANGES*`, `.bidsignore`, `.gitignore`, at any size. It also predicted
its own failure mode: *"the exclusion list is extension-based, so a new metadata
format needs adding to it or it silently gets annexed."*

The mirror image happened instead. **Motion-BIDS stores the recording itself as a
headerless `_motion.tsv`** -- one column per channel, names in the sibling
`_channels.tsv` -- and it is the only BIDS continuous-data file specified
uncompressed (`_physio` and `_stim` are required to be `.tsv.gz`, so they annex
already). `exclude=*.tsv` therefore routed entire motion-capture recordings into
plain git.

Two things made it invisible:

1. **The policy existed in five places in three spellings.** `configureLargefiles`
   held the annex expression; `collectFileManifest` held a *different* rule (a local
   extension set, or larger than 100 kB) used to decide which files get handed to
   `git annex add`; `isNeverAnnexedMetadata` restated the exclusions as a regex;
   `scripts/nemar-restore-dataset.sh` held a shell copy; `https://docs.nemar.org/admin/operations/validated-workflows/`
   held two prose copies. Nothing checked that any of them agreed.

2. **The two rules disagreed in a way that reported success.** A large
   `_motion.tsv` counted as "data" in the manifest, so the upload plan told the
   user it would go to S3 and handed it to `git annex add` -- which put it in git,
   because the annex expression said `.tsv`. The S3 verification step filters to
   files annex actually took, so nothing failed. A *small* `_motion.tsv` was worse:
   classified as metadata, it never reached `git annex add` at all, and
   `commitChanges` staged it with `git add -A`, which does **not** honour
   `annex.largefiles` in these repos (no `* filter=annex` in `.gitattributes`).

Measured on the live catalogue: `nemarDatasets/on007788`, public, carries **893
`_motion.tsv` files totalling 675 MB as git blobs**, alongside **690 annexed
siblings of the identical type**. The split comes from upstream -- OpenNeuro annexes
on size alone (~1 MB) -- and the import inherits it. A sweep of that dataset plus
eight other imported datasets found **no other category of violation**: outside
`_motion.tsv`, the "git-resident but should be annexed" set is empty.

## Decision

**One module owns the policy: `src/lib/git-annex/policy.ts`.** It renders the
git-annex expression (`buildLargefilesExpression`) and evaluates the same rule in
TypeScript (`shouldAnnex`). `configureLargefiles`, the upload manifest classifier,
and `isNeverAnnexedMetadata` all derive from it; the shell copy in
`scripts/nemar-restore-dataset.sh` is held to it by a test that parses the script.

**"data" in the upload manifest means exactly "git-annex will take this."** The
classifier is no longer an independent guess. This is what makes the plan shown to
the user true, and it is what gets a sub-100 kB recording to `git annex add` at all.

**Data may wear a metadata extension, declared by glob.** `ANNEX_DATA_GLOBS`
currently holds exactly `*_motion.tsv`. Such a glob is emitted into *both* clauses
of the expression, because git-annex ANDs the top-level terms and a bare
`include=*_motion.tsv` loses to `exclude=*.tsv`:

```
(... or include=*_motion.tsv or largerthan=100kb) and (exclude=*.tsv or include=*_motion.tsv) and exclude=*.json and ...
```

**git-annex is the oracle in tests.** `test/annex-policy.test.ts` builds a real
repo, runs the real `configureLargefiles` and `git annex add`, and asserts
`shouldAnnex` agrees with what git-annex did, file by file. A re-implementation of
git-annex's glob semantics asserted against itself is what this ADR exists to
prevent.

**The import path reports; it does not yet normalise.** `findUnannexedData` warns
during `prepare` when a clone carries files NEMAR policy would annex. It stops
there deliberately: the import copies content server-side by *upstream annex key*,
and the manifest cannot express a key sourced from the clone, so annexing a file
without also uploading its content would publish an unresolvable pointer -- worse
than the bloat. Issue #1159 carries the real fix.

## Consequences

- New uploads put motion recordings in S3, at any size. Motion sidecars
  (`_channels.tsv`, `_motion.json`) stay in git, so a metadata-only clone is still
  useful -- ADR 0015's central promise is preserved rather than weakened.
- The upload plan's "Data files: N (will be uploaded to S3)" is now accurate.
  Counts will shift for existing datasets: large `.tsv`/`.json` sidecars used to be
  counted as data and no longer are. No file changes plane as a result -- the old
  classification was already being overruled by the annex expression.
- A future data format that looks like metadata is a one-line addition to
  `ANNEX_DATA_GLOBS`, and both the expression and the predicate follow.
- The shell script can still drift *within a commit that skips tests*, which is the
  residual risk of a copy that cannot import. The test is the mitigation, not a
  guarantee.
- `on007788` is not fixed by this change. It is a live public dataset; migrating
  it moves 675 MB into S3 and rewrites the tree, so it needs its own authorisation.
- The 100 kB threshold is untouched, and so is the gap with OpenNeuro's ~1 MB one.
  The sweep says that gap is currently empty of real files, so this ADR does not
  reconcile it.

## Alternatives considered

- **Add `*_motion.tsv` to the include list only.** The obvious one-line fix, and it
  does nothing: the metadata clause ANDs with the include clause and vetoes it.
  Verified against git-annex 10.20260717 before writing the paired form.
- **Drop `exclude=*.tsv` and rely on the 100 kB threshold.** Would annex large
  `events.tsv` and `participants.tsv`, breaking metadata-only clone and the
  enrichment readers. This is the configuration ADR 0015 already rejected.
- **Adopt OpenNeuro's size-only rule for parity.** Removes the extension logic that
  keeps workflows and sidecars readable, and re-introduces exactly the failure ADR
  0015 was written about. Rejected.
- **Compress motion to `_motion.tsv.gz` on ingest.** Would annex without a policy
  change, but rewrites deposited data, breaks BIDS validation for the motion
  modality, and changes files under a DOI. Rejected.
- **Keep the classifier separate but add motion to both.** Leaves two rules that
  merely happen to agree today, which is the state that produced this bug.

## Receipts

- `src/lib/git-annex/policy.ts` - the policy
- `test/annex-policy.test.ts` - agreement with real git-annex, and the shell sync check
- `test/import-unannexed-data.test.ts` - the detector, against a reproduced upstream split
- ADR 0015 - the decision this amends
- Issue #1158 (this fix), issue #1159 (import normalisation and the `on007788` backfill)

## Amendment 2026-10-07 (#1642): the size threshold is 100,000 bytes, the CLI's selection is authoritative for case variants of data names, and the save annexes by size too

Three findings, all measured against git-annex 10.20260901, tracked under epic #1671.
The save step's use of `assume-unchanged` is a separate decision: [ADR 0094](0094-the-save-step-skips-re-reading-annexed-content-only-on-large-unchanged-trees.md).

### The size threshold is 100,000 bytes

The "100 kB" above is literally 100,000 bytes, and the policy module now says so.
git-annex reads the `kb` in `largerthan=100kb` as SI (1 kB = 1000 bytes), not as 1024.
With the production expression, files of 99,999 and 100,000 bytes stay in git, and files of 100,001, 102,399, 102,400 and 102,401 bytes annex.
With the exact-bytes form `largerthan=102400` the boundary moves to 102,400, which is what `ANNEX_SIZE_THRESHOLD_BYTES = 100 * 1024` implied.
The module therefore disagreed with git-annex for every file of 100,001 to 102,400 bytes: `shouldAnnex` called it small while git-annex annexed it, and the file was never handed to `git annex add`, so the save annexed it by size after the copy, which is the known gap below.
The disagreement was invisible because the expression was rendered as `largerthan=${bytes / 1024}kb`, so both sides printed "100".

`ANNEX_SIZE_THRESHOLD_BYTES` is now 100_000 and the expression carries the exact byte count, `largerthan=100000`, so there is no unit left to misread.
This preserves what git-annex does today, so no dataset's tracking changes; it only corrects the CLI's classification and the text derived from the constant (`describeAnnexSizeThreshold`).
Repositories configured before this amendment carry `largerthan=100kb`, which git-annex evaluates identically; `isCurrentLargefilesExpression` accepts that spelling so the fleet sweep does not report the `nm` datasets as drifted.
`test/annex-policy.test.ts` runs both spellings against real git-annex at 99,999, 100,000, 100,001, 102,399, 102,400 and 102,401 bytes, with the expected outcome written as a literal rather than derived from the constant.
As of 2026-10-07 the prose copies on `https://docs.nemar.org/admin/operations/validated-workflows/` live outside this repository and still say `largerthan=100kb`; both spellings are correct, and the page should move to the byte count when it is next edited.

### The CLI's selection is authoritative for case variants of data names

git-annex's `include=` and `exclude=` globs are case-sensitive.
There is no case-insensitive switch (`iinclude=` does not parse), but a bracket class matches either case: with `include=*.[eE][dD][fF]`, an `UPPER.EDF` of 50 bytes was annexed.
`shouldAnnex` has always folded case, so the upload plan calls `UPPER.EDF`, `Mixed.Edf` and `X_MOTION.tsv` data while git-annex does not read them that way by name.
Measured with the production expression, whose first clause annexes a file that matches a data extension or glob or is over the size threshold:

- `UPPER.EDF` and `Mixed.Edf` over the threshold annex by size, so they need no help; under the threshold they stay in git, which `findDataFilesNotAnnexed` reports as small files stored in git.
- `X_MOTION.tsv` stays in git at any size, because `exclude=*.tsv` matches it while `include=*_motion.tsv` does not.
  A large one is the case where the upload would otherwise commit a recording to git while the plan promised S3.

The tracking step therefore passes the files for which `isCaseVariantData` holds to `git annex add --force-large`, and every other data file to a plain `git annex add`.
Forcing only the case variants keeps the not-annexed check meaningful: an inherited `.gitattributes` `annex.largefiles` override (ADR 0060) still leaves an ordinary data file in git, and the upload still refuses it.
The not-annexed check therefore fires only on a file whose name git-annex itself reads as data and which it still did not annex (an inherited override or an ignore pattern); letter case alone cannot trigger it.
Re-running is idempotent: `git annex add` skips an annexed, unmodified file.
The Decision's sentence now reads: "data" in the upload manifest means "git-annex will take this, or the upload forces it into the annex with `--force-large`."

Bracket classes were not adopted in the expression.
They change the expression string for every dataset and for every comparison of it: the fleet sweep would read every configured `nm` dataset as drifted again, and an older admin CLI, which compares against its own spelling, would disagree with a newer one.
`--force-large` covers the tracking step without touching the expression.
A case-folded expression would also close the known gap below, because the save's `git add -A` filter reads the same expression: with bracket classes in every glob of the expression, a plain save of a 200 KB `BIG.JSON` and `big.json` left both in git while a 50-byte `UPPER.EDF` was still annexed.
With brackets in only some terms (the `.json`, `.tsv` and data-extension ones), `NOTES.TXT` and `readme` were still annexed.
That is a fleet-wide expression change, with ADR 0020's blast radius, and belongs in its own decision.

### Known gap: the save annexes by size too, and what now catches it

The Context above says `git add -A` "does **not** honour `annex.largefiles` in these repos (no `* filter=annex` in `.gitattributes`)".
That holds for `.gitattributes` and not for the repository: `git annex init` writes `* filter=annex` to `.git/info/attributes`, so the save's `git add -A` runs git-annex's clean filter, which does annex by `annex.largefiles`.
A plain save of fresh `BIG.JSON`, `BIG.TSV` and `unknown.xyz` files of 200 KB annexed all three.
The same finding corrects the Context's account of a small `_motion.tsv`: the save did not commit it to git, it annexed it (`include=*_motion.tsv`), and its content never reached S3.
That case is covered, because the upload plan calls it data and hands it to `git annex add` before the copy.

What is exposed is the mirror image of the section above: a name the CLI calls metadata only after folding case.
The CLI never hands it to `git annex add`, git-annex's case-sensitive exclusions do not match it, and the size clause annexes it at the save, after the S3 step has run.
That is any name that matches a `NEVER_ANNEX_GLOBS` entry only after case folding (`BIG.JSON`, `BIG.TSV`, `NOTES.TXT`, `x.YML`, and a 200 KB `readme`, `license` or `changes` were all annexed by a plain save) and is over the threshold.
Dotfiles are the exception: `.BIDSIGNORE` and `.GITIGNORE` stay in git at any size, because git-annex does not annex a dotfile by default (unless `annex.dotfiles` is true).
Its content is then in the local annex only, and the commit carries a pointer nothing can resolve.

The gap is now detected and a re-run clears it.
After the commit the save step asks the location log what the S3 remote still lacks (`saveDatasetStep` with `verifyRemote`), fails naming the files, and clears the `s3_upload` stamp.
The re-run's step 9 asks the log before its empty-add-targets gate (`listPendingAtRemote`), so a run with nothing to add still copies them, and the save then passes.
`test/upload-data-steps.unit.test.ts` characterizes it end to end with a 200 KB `BIG.JSON`.
The cost is one walk of the location log per check, 3.7 s at 10,000 annexed files and 0.2 s at 600, against a directory remote.

## Receipts for the amendment

- `src/lib/git-annex/policy.ts` - the threshold, `isCaseVariantData`, `isCurrentLargefilesExpression`
- `src/lib/upload/transfer.ts` - `trackDataFiles`, `copyAnnexedToRemote`, `listPendingAtRemote`
- `src/lib/upload/finalize.ts` - the post-save check
- `test/annex-policy.test.ts` - both spellings at the boundary, against real git-annex
- `test/upload-track-data.unit.test.ts` - both readers of a case variant, and idempotence
- `test/upload-s3-copy-step.unit.test.ts` - the step's decisions, with a real directory remote
- `test/upload-data-steps.unit.test.ts` - the whole run, and the `BIG.JSON` characterization
