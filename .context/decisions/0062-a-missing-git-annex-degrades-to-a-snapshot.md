# ADR 0062: A missing git-annex degrades to an HTTP snapshot, and a snapshot is not a repository

**Status:** accepted
**Date:** 2026-09-15
**Owner:** Seyed Yahya Shirazi

## Context

`nemar dataset download` had exactly one route: clone the dataset repository from
`nemarDatasets`, then pull annexed content with `git annex get`. That route is right for the
case it was built for -- it yields a working repository with history, and `commit`, `push` and
`update` operate on it -- and it is the wrong tool for three real ones:

- **git-annex is not installed.** This was a hard exit with an install hint, which is a poor
  answer to "I just want the files" on a machine where installing it is not the user's call.
- **The repository is not readable by the caller even though the DATA is public.** This is the
  shape a temporarily-anonymous deposit takes (#1400): the repo is private so no author shows on
  GitHub, while the dataset itself is listed and served.
- **A container, a login node, a CI runner.** git-annex plus a GitHub account plus an SSH key is
  a lot of prerequisite for a read.

In all three the data plane already serves what is needed. `<api>/data/<id>/<version>/manifest.json`
is one request that returns every file's path, size, checksum and a durable byte URL, and it is
already public for published datasets.

## Decision

**A missing git-annex falls back to HTTP automatically, and the fallback announces itself.**
Degrading silently in BEHAVIOR is the point; degrading silently in OUTPUT would not be. The plan
block names the method (`Method:  HTTP (no git-annex)`) before anything is fetched, and the run
ends on `printSnapshotCaveat`, which is the one wording for what the result cannot do. `--http`
asks for the same path outright, for the two cases where git-annex is present and still wrong.

**What lands is a snapshot, not a repository, and nothing pretends otherwise.** There is no
`.git`, so `commit`, `push` and `update` do not work in the result and `git annex get` cannot
widen it; re-running the download with different filters is how the selection grows. The
tempting alternative -- initialize a repo, or write annex pointer files, so the tree "looks
normal" -- is rejected: a half-repository that fails at push time, after someone has edited it,
is worse than a directory that never claimed to be one. The directory says what it is in
`.nemar/http-snapshot.json`, so a later run can tell.

**That stamp is what makes resume safe, and it refuses three things rather than merging into
them:** a git-annex clone (the default output path is the same `./<dataset-id>` the clone path
uses, and unfetched annexed files there are dangling symlinks, so an existence check reads them
as absent and would overwrite a working clone), a snapshot of a different dataset, and a snapshot
of a different VERSION of this one.

**Resume is size-only. No checksum is computed.** A file already on disk at its declared size is
skipped. Verifying checksums would re-read every byte on every run, which on a 14 GB dataset
costs about what the download costs, for a guarantee the write path already gives at the moment
it matters: every write is compared against the declared size as it lands, and a mismatch removes
the file. What size-only does NOT catch is a file of the right length whose content is wrong, and
the realistic way to get one is a version mix -- `dataset_description.json` is byte-identical in
length across a patch bump -- which is exactly what the version stamp refuses. A future `--verify`
can add the strict pass; it is not the default, because the default runs after every interrupted
transfer.

**Bytes come from each entry's `bytes_url`.** It is the durable download contract (#615); under
ADR 0095, `url` now equals it and also names the stable data-plane route. The CLI continues to use
`bytes_url` explicitly so stored download URLs do not depend on the optional immediate-fetch field.
The data-plane host is addressed as the configured API origin, which serves git-tracked bytes
without relying on the dataset repository being public (#1403).

**The data plane is addressed as the configured API origin plus `/data`, not `data.nemar.org`.**
That mount exists in production, staging and the workers.dev dev deployment while the pretty
hostname does not, so environment selection stays where it already is: whichever API the CLI is
pointed at.

**A transport or disk fault fails the run; a clean 404 does not.** ADR 0005 makes genuinely
absent content a reported state that still serves, and that holds here -- a dataset with one
missing object still lands. A dropped connection, a 403, a full disk or a short write is a failed
run whatever the tallies say, and exits non-zero. Collapsing the two exits 0 on a half-finished
transfer, which is the failure that gets built on.

**The transfer itself is shared with the OpenNeuro fallback, not copied.** `lib/file-download.ts`
owns the bounded pool, resume, retries, the path-traversal guard and the transport-versus-404
split; `lib/http-download.ts` and `lib/openneuro.ts` each supply only their own file list and URL
mapping. The second copy is how the two drift, and this one drifted before it was extracted: the
OpenNeuro path had been discarding `Bun.write`'s return value, which is a short count on a
truncated body and does not throw, so a partial file landed as a healthy one.

## Consequences

Easier: a user with neither git-annex nor a GitHub account can read a published NEMAR dataset,
which is the first prerequisite for the anonymous-deposit direction in #1400 and useful on its own
for containers and HPC login nodes. The download prerequisite check no longer stops a reader who
only wants files; `nemar doctor` still reports git-annex as missing, because it still is.

Harder: **there are now two download paths and one filter contract between them.**
`buildBidsFilterArgs` emits the git-annex arguments AND the glob groups `matchesBidsFilter`
evaluates, from one declaration, because the alternative -- a second matcher -- means
`--subjects sub-01` returning different files depending on whether git-annex happens to be
installed, which is close to undebuggable from a bug report. Any new filter must be added there,
once.

The manifest becomes load-bearing for reading, not just for auditing. A dataset whose manifest is
missing is now a broken download rather than a cosmetic gap, so the failure says so explicitly
and points at healing (`/admin/manifest/dispatch`) rather than blaming permissions.

This grants no access it did not already have. The path reads the public data plane as an
anonymous client; a private dataset returns 404 and is told to use git-annex.

## Alternatives considered

- **Keep the hard exit and improve the message.** Status quo. It is a correct instruction and a
  dead end for the three cases above, the first of which the user cannot always act on.
- **Shell out to `rclone` or `wget -x`.** The original suggestion, and it inverts the premise:
  this path exists for machines that are missing a tool, so requiring a different tool trades one
  prerequisite for another. A bounded pool over `fetch` is the same handful of parallel GETs with
  no install, and it can read the manifest's declared sizes to verify and resume, which neither tool
  can do from a URL list alone.
- **Write a git repository without annex content.** Makes `commit` and `push` appear to work and
  then fail against a repo nobody can push to, after edits. The snapshot's honesty is the feature.
- **Checksum every resumed file.** Correct and unaffordable as a default; the version stamp closes
  the hazard that actually occurs, and `--verify` remains available later.
- **A `--no-annex` git clone.** Still needs git, still needs the GitHub repo to be readable, and
  so answers neither the missing-tool case nor the private-repo case.

## Receipts

- PR #1402, issue #1401; #1403 (the `bytes_url` host), #1400 (anonymous deposit, the case that
  needs the private-repo half)
- ADR 0005 (partial data still serves; applied here to the exit code), ADR 0015 (git carries
  metadata, git-annex carries data -- what `checksum_algorithm` means), ADR 0031 (the extension is
  not the policy, so selection reads the manifest field), ADR 0037 (make versus take: one
  downloader, not two)
- Rules: `src/lib/file-download.ts` (the shared transfer), `src/lib/http-download.ts` (the data
  plane, the snapshot stamp, `printSnapshotCaveat`), `shared/contract/data-plane.ts` (the wire
  shape both sides agree on), `src/lib/bids-filter.ts` (one filter declaration, two consumers)
