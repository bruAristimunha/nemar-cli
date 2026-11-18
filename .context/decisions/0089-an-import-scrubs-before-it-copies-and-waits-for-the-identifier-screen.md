# ADR 0089: An import scrubs before it copies, never copies what it replaced, and waits for the identifier screen before it approves

**Status:** accepted
**Date:** 2026-10-06
**Owner:** Seyed Yahya Shirazi

Epic #1610, issue #1618 (Phase 7).
Builds the importer half of ADR 0085 ("The scrub is a step in the workflows that bring data in")
and of the ADR 0060 amendment of 2026-10-04, and replaces the importer's request-and-approve-in-one-run
that ADR 0086 says meets the gate.

## Context

An OpenNeuro import copies recordings server side by upstream key (ADR 0010), so the bytes it
copies are exactly upstream's, header identifiers included, and the bucket grants anonymous read
on every dataset prefix it does not list as private (`services/bucket-policy.ts`): an object the
copy phase writes is readable by key before anyone looks at it.
The importer then requested and approved publication in the same run, which the Phase 4 gate now
refuses (ADR 0086). A re-import resets onto `origin/main` (#990) but builds its copy manifest from
upstream's whereis, so a key a correction replaced would be copied back.

The scrub cannot live in the copy leg, which has no clone and copies by key. Prepare is the one
phase that holds a clone before the first push, and it already moves bytes from the host under a
bound (ADR 0060).

## Decision

**Prepare scrubs, with the Phase 2 rules, before anything is copied** (`src/lib/import-scrub.ts`,
`prepareImportedTreeForCopy`, called between the S3 remote setup and the annex-policy step):

- **EDF and BDF headers.** Every recording the copy will copy is read: a file git holds from the
  clone, an annexed one by an anonymous 256-byte ranged read of the upstream object the copy phase
  would copy (the S3 object by path, or, for a whereis URL that is not an S3 endpoint, that URL,
  which the copy's curl fallback fetches). A read must return every byte it should and state the
  object's size, which must be the key's. Not read: annexed recordings under `--skip-data`, which
  copies nothing; a key with no URL at all, which nothing copies; a re-import's own keys, which NEMAR
  already holds and the screen reads; an empty file. A closing check refuses an upstream recording in
  the cut manifest whose header this run did not read.
  A header needs a scrub exactly when `scrubEdfHeader` changes it, the rule ADR 0085's plan uses.
  Such a recording is downloaded whole, checked against its annex key (size and digest), patched in
  bytes 8 to 168 only, re-proven with `verifyScrub`, annexed as SHA256E and uploaded from the host by
  ADR 0060's upload leg with its location-log proof. Its old key is retired in the git-annex branch
  the way ADR 0085's `annex-registry` retires one (every holder retracted, then `dead`), so the
  dataset's own metadata records the key as purged.
- **JSON.** In every inline JSON file of the tree, each value under a key the scanner calls an
  identifier (`scanJsonKeys`, identifier severity) is replaced by `""`, editing the text so every
  other byte stays; the result is re-scanned and must find none (`blankIdentifierJsonKeys` in
  `shared/identifier-scrub.ts`). It gives the bytes of ADR 0085's `blank_json` on the documents that
  rewrite was built for, and differs in three edge cases: a key the scanner's spelling matches and
  the rewrite's does not (a tab in the key) and a duplicated key whose last copy is empty are blanked
  here and left there, and an empty value (`null`, `[]`) is left here and turned into `""` there.
- **Images and documents** are counted and never removed or changed: the screen reports them and
  approval then needs a person (ADR 0086). Tables have no scrub rule; a participants identifier
  column is left for the screen, which blocks on it.
- **Provenance.** When headers were scrubbed, `sourcedata/sourcedata_provenance.json` gets ADR 0085's
  `privacy_correction` sentence and its README the matching note, from the same text functions.
- **Ledger.** One `import-scrubbed` line, counts only, is committed with the scrub in
  `.nemar/corrections.jsonl`. Its `scanner` is `identifier-scan@<16 hex>`, the first 16 hex digits of
  the sha256 of the two rule files' bytes, fixed at build time: the importer runs from a package,
  not a checkout, so it has no commit to name.

**It fails closed, before the push, with one marker and a fixed word.**
`[nemar-identifier-scrub] refused: <word>` with counts, never a value, path or file name:
`header-unreadable` (prefixed by the upstream marker when every failure is HTTP 403 or 404, so it
classifies as `upstream_inaccessible`), `upstream-size-mismatch`, `bound-exceeded` (the bytes to move,
downloads and git-held data together, over `NORMALIZE_MAX_BYTES`; raise with `--normalize-max-gb`),
`content-mismatch`, `unsupported-key-backend` (a key to replace that is not SHA256E, which ADR 0085's
tools cannot follow), `already-imported-unscrubbed` (a re-import whose tree already names a key that
needs a scrub: NEMAR holds the original, which is ADR 0085's procedure, not an import's),
`old-key-still-named`, `retire-failed`, `scrub-unverified`, `upload-failed` and `scrub-failed` (any
other error, named by its class and errno code only, because a file system error's message carries
the path). The import-failure classifier gains the cause `identifier_scrub`, and the retry engine
parks the words a retry cannot clear (`identifier_scrub_refused`) instead of re-dispatching them.

**The copy manifest is the final tree's keys and nothing else.** An upstream key the committed tree
does not name, and any key the git-annex branch records as dead, is dropped and counted. This is the
reader of a purge list that needs no new store: the dead marks ADR 0085's tooling and this importer
write. A replaced key still in the manifest refuses.

**Finalize requests publication and waits for the verdict** (`src/lib/import-publication.ts`).
Requesting starts the screen (ADR 0086). The importer polls the request's screen state for a bounded
time, approves only when `screenGate` says `clear`, re-runs a screen the gate calls `stale` at most
once (an automated commit to `main`, such as enrichment's, can land after the screen read the head),
and otherwise approves nothing. The wait is at most 45 minutes (past the screen's 35-minute deadline,
under the watchdog's 50) and is cut to what the finalize job's 90-minute timeout leaves, because the
workflow file here must match the deployed copy byte for byte (`test/dataset-workflow-parity.test.ts`)
and a job killed by its timeout reports a failure for data in place.
The outcome is one of five fixed words: `published`,
`already-published`, `blocked` (direct identifiers), `review` (a person must look and acknowledge),
`unchecked` (no verdict in time, a screen that did not run or report, an unreadable status, or a
verdict that could not be bound to the head).

**A held publication is not a failed import.** The data is copied, registered and CI is deployed,
so finalize exits 0 and the import is `complete`. The request stays open and Phase 4 mails the admins
whatever the screen says, including when it never reports; `nemar admin repo publish list` is the queue.

**A forward fix of git-tracked content is never approved automatically.** When the scrub blanked a
JSON value or rewrote a recording git held, the history the push carries still holds the original:
the outcome is `review` whatever the screen says, and the staging manifest says so to finalize. A
re-import reads the same hold from the dataset's ledger (an earlier `import-scrubbed` line that
changed git-tracked content, with no `history-rewritten` line after it; a ledger that cannot be read
holds). A manifest without an exact record (`version: 1` and a boolean; an older prepare) is treated
the same way. The screen cannot see these holds, so finalize writes them on the request before
anything else, through the deny route with a fixed reason: a request left open with a clean verdict
would be approved by the next admin to read the mail. If the hold cannot be written, finalize fails.

**A re-run of finalize meets the request it left.** An open request is waited on like a fresh one;
one that is being approved is not approved a second time (`unchecked`, `approval-in-progress`).

**Logs, refusals and the ledger carry counts and fixed words only.** The Actions log of
`nemarDatasets/.github` is public. The importer's log does state an outcome word per dataset, which
ADR 0086's screen workflow deliberately does not: the brief for this phase asked for an explicit
outcome per dataset, and the mirrored data is public upstream. Suppressing it is one function
(`describePublicationDecision`) and the maintainer's call.

## Consequences

- An EDF or BDF recording whose header the scrub flags (a name, a birth date finer than year, a
  record number, an age over 89, non-ASCII text in the identification fields) is not copied into
  NEMAR's bucket by an import, and a re-import cannot copy back a key a correction replaced. The
  header is read from the object the copy will copy, minutes or hours before the copy: an upstream
  change in between is caught by the screen, which reads NEMAR's copies, not by this step.
- Most OpenNeuro mirrors are in formats the scanner does not parse, so their screen is
  `not-screened` and approval needs an admin's recorded reason: auto-import no longer publishes them
  unattended. That follows from ADR 0086 ("OpenNeuro mirrors are screened like any deposit") and is
  not overridden here.
- A dataset whose flagged recordings exceed the bound refuses on a runner; it imports on a host that
  can move them, with `--normalize-max-gb`.
- Residuals, not closed by this ADR: upstream keeps the originals, and an old commit's pointer still
  names the replaced key, which upstream serves; a forward fix leaves blanked JSON values in the
  pushed history (hence the hold); objects copied before publication are anonymously readable by
  key, which now means scrubbed or not-flagged recordings, plus what the scrub does not read and only
  the screen does afterwards: formats the scanner cannot parse, JSON that upstream annexed or that is
  over 1 MiB or not UTF-8 JSON, and tables (a participants identifier column has no scrub rule); the
  server-side copy takes the object by path, as the scrub reads it, while its curl fallback fetches
  the version the whereis URL pins, so the two differ only if upstream replaced an object without a
  new commit, and the screen reads NEMAR's copy either way; held imports are not yet counted in the
  weekly report (ADR 0054).
- The finalize job's timeout is not raised by this change. Raising it in both copies at release
  (with Phase 4's `run-identifier-screen.yml`), and `FINALIZE_JOB_TIMEOUT_MS` with it, lets the
  full wait apply; until then a slow run waits less and leaves more publications for an admin.
- A reviewed per-dataset scrub declaration (the ADR 0073 pattern named in the design review on #1618)
  is not built: there is no re-pull yet (ADR 0006, epic #1046), and the rule is deterministic, so the
  same upstream bytes give the same SHA256E key ADR 0085's tools produced. A test pins that.

## Alternatives considered

- **Scrub after the copy.** The unscrubbed bytes would sit in a publicly readable prefix first, and
  deleting them later meets Object Lock and versioning. Rejected.
- **Assemble the scrubbed object server side, as ADR 0085 does.** The new key needs the hash of the
  whole file, so the bytes are read either way; it is the way past the bound, not a reason to skip it.
- **Report a held publication as an import failure.** Most imports would quarantine or roll back,
  open public failure issues and drown the real failures (ADR 0053). Rejected.
- **Acknowledge unscreened formats automatically.** An acknowledgment is a person's recorded reason;
  a machine's defeats ADR 0086. Rejected.
- **Rewrite the upstream history before the first push**, with ADR 0085's rewrite. The principled
  close of the JSON residual; it needs git-filter-repo and the rewrite script on the runner. Left to
  the maintainer; until then the forward fix is held for a person.
- **Remove images and documents, as ADR 0085's git plan does under `sourcedata/`.** An import has no
  person reviewing it; holding them for the screen keeps a person in the loop. Rejected.

## Receipts

- `src/lib/import-scrub.ts` (`prepareImportedTreeForCopy`, `scrubImportedTree`,
  `restrictManifestToTree`), `src/lib/import-publication.ts` (`awaitScreenAndApprove`),
  `src/lib/import-openneuro.ts` (the two call sites), `shared/identifier-scrub.ts`
  (`blankIdentifierJsonKeys`), `shared/privacy-correction-text.ts`,
  `src/lib/scanner-rules-digest.ts`, `backend/src/services/import-failure-cause.ts`.
- `test/import-scrub.test.ts` and `test/import-finalize-screen.test.ts`: real git-annex repositories,
  a directory special remote, and HTTP stand-ins for the upstream bucket and the API.
- ADR 0085 (rules, annex-registry, provenance sentences, ledger), ADR 0086 (`screenGate`), ADR 0060
  (the upload leg and its bound), ADR 0010, ADR 0051 to 0054.

## Amendment 2026-10-07 (Phase 9): a first import also sets acquisition dates

[ADR 0091](0091-a-new-recordings-acquisition-dates-are-set-to-1-january-and-nothing-published-is-changed.md) adds `normalizeEdfDates` after `scrubEdfHeader` on a first import.
A recording is downloaded and given a new key when either rule changes its header, so a recording whose only change is its date gets one too.
The patch then covers the start-date bytes 168 to 176 and the EDF+ `Startdate` token as well as bytes 8 to 168, each step proven (`verifyScrub`, `verifyDateNormalization`).
A re-import is unchanged.

## Amendment 2026-10-23 (#1046): a re-pull scrubs its delta paths before its copy and its commit

Designed in [ADR 0111](0111-an-upstream-re-pull-is-a-reviewed-delta-on-a-release-branch.md) and not yet built.
*Annotated 2026-10-27: built by epic #1046.
The scrub takes a scope, a source per key and a pinned version (ADR 0111, the Phase 6b amendment), `execute` runs it on the delta paths before the copy and before the synthesized commit (Phase 6c), each copy item pins its S3 `versionId` (Phase 6d), and the identifier screen bound to the re-pull's row gates its merge (Phase 6e).
The future tense below states the rule.*
An upstream re-pull is not an import: it will write no `import_jobs` row and make no publication request.
It will run this record's scrub on its delta paths only, the paths its one synthesized commit adds or changes relative to `main`, before the copy and before that commit, as an import scrubs before its copy, so nothing unscrubbed is copied into the bucket, where an object is anonymously readable by key, and nothing unscrubbed enters NEMAR's history.
A recording the commit does not touch will keep its key and will not be read again.
It will push none of upstream's history, so the forward-fix hold does not apply to it; the identifier screen will gate its merge instead of a publication.
The copy manifest rule stands (the scrubbed tree's keys, minus those present and those dead), and each re-pull copy item will also pin its S3 `versionId`.
