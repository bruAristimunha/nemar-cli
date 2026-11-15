# ADR 0123: Derivatives live in a keyed store, named by what they read

**Status:** proposed
**Date:** 2026-11-14
**Owner:** Seyed Yahya Shirazi

Epic #2145.
This Architecture Decision Record (ADR) records where the products of NEMAR's compute recipes live once a job has finished, how each one is named, how long each is kept, and what each says about itself.
It follows [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md), whose results bucket expires a job's outputs, and [ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md) decision 8, which promised a derivative its own home and left the choosing of it to a later decision.
It supersedes nothing.

The key and both digests are defined byte for byte in [`shared/contract/derivatives.ts`](../../shared/contract/derivatives.ts) and held to [`shared/contract/derivatives-vectors.json`](../../shared/contract/derivatives-vectors.json), which Python and TypeScript must both reproduce.
Where this text, that module and a vector disagree, the defect is settled by amending this ADR, never by editing a vector to fit code.

## Context

A finished pipeline job's outputs sit in the results bucket, which expires them after 30 days by default (ADR 0118 decision 7).
A product worth keeping needs a home with its own lifetime and a name that does not change when the same work is run again.
Naming a derivative by the digest of the Zarr index would orphan every derivative at the next reconversion, because the index carries `updated_utc`: the name has to follow what the recipe read, not the file that describes it.
The Zarr serving copy is capped at 250 hertz (Hz) and 16-bit, and [ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md) keeps it to raw recordings, so a derivative of it must say so and must never be written into it.
A Digital Object Identifier (DOI) cannot be withdrawn, and the registrar is EZID ([ADR 0007](0007-ezid-is-the-sole-doi-provider.md)).
The owner decided on 2026-11-14 that derivatives live in a keyed store with three retention classes.

## Decision

1. **Derivatives live in a private Cloudflare object store (R2) bucket of their own.**
   Objects are `d/`, the key, and the product's relative paths, and are immutable once stored.
   They are never written into the serving copy, never committed into the dataset repository, and never kept in the results bucket, because each of those has a different purpose and, for the results bucket, a lifetime that would delete a kept derivative.
2. **The derivative key is the Secure Hash Algorithm 256 (SHA-256) of `nemar.derivative-key.v1` and eight lines.**
   The lines are `dataset`, `version`, `recipe`, `recipe_version`, `engine`, `input`, `profile` and `input_digest`, in that order, each `name`, a space, the value and a line feed (LF).
   The values are full-string matches: dataset `^[a-z]{2}[0-9]{6}$`; version and recipe version `^[0-9A-Za-z._+-]{1,64}$`; recipe `^[a-z0-9-]{1,64}$`; engine `^[0-9A-Za-z._+@-]{1,64}$`.
   Input `zarr` goes with profile `serving` and a `sha256:` digest, input `bids` with profile `archive` and a `git:` digest, and any other value or pairing is refused, so a serving derivative can never pass for an archive one.
   The image digest is recorded with a derivative and is never part of its key, so a rebuilt image does not orphan a derivative whose recipe version and engine are unchanged.
3. **The input digest names what was read, not what was indexed.**
   For a `zarr` input it is `sha256:` and the SHA-256 of the lines `path`, tab, `group`, tab, `content_sha256`, LF, one per store whose group was read in full, sorted by path in code point order, which is the order of the paths' bytes in Unicode Transformation Format 8-bit (UTF-8).
   Python's `sorted` gives that order; JavaScript's default `sort` compares UTF-16 units and disagrees above U+FFFF, so the TypeScript compares bytes.
   For a `bids` input it is `git:` and the 40 hexadecimal digits of the source commit the dataset version names.
   Keying on the index would orphan derivatives at every reconversion; a content digest changes only when a value the recipe read changes.
4. **A store's content digest is `nemar.store-content.v1`, over one channel group of the level-0 array.**
   It is the SHA-256 of a UTF-8 header and then the physical values.
   The header lines, each ending in LF, are `nemar.store-content.v1`; `shape C S`, the decimal channel and sample counts; `rate H`, the 16 lowercase hexadecimal digits of the serving rate as an Institute of Electrical and Electronics Engineers (IEEE) 754 binary64, big-endian; `unit` and the unit; one `label` line per channel in stored order; `data float64-le`.
   Labels are all or none (the lines carry labels only when every channel has a non-empty one, otherwise every line is `label` alone), and the unit is shared or none (`unit` carries text only when every channel states the same non-empty unit, otherwise `unit` alone, so an empty unit is no unit and never `unit` and a space).
   The two rules apply first, so text they drop is never examined.
   The values are C times S little-endian binary64 numbers, channel-major, each `float64(digital) * float64(scale[c]) + float64(offset[c])` as two separately rounded operations, never fused.
   Text is hashed as its UTF-8 bytes exactly as given, with no Unicode normalization and no trimming, so U+00B5 and U+03BC are different units.
   Text that enters the header and holds a carriage return, a line feed or a lone surrogate has no digest: it is an error and never a guess.
   The archived rate is never read, so a digest cannot state or depend on it.
5. **Retention has three classes, and a DOI is never minted by code.**
   `canary` expires 30 days after it is stored.
   `catalog` is kept until a later `catalog` derivative of the same dataset, recipe, input and profile is promoted, and then expires 30 days after that.
   `published` never expires and only the owner sets it.
   Every derivative starts as `canary`, and no code path mints a DOI: a future, separately reviewed, owner-only action does, for a `published` derivative only, because a DOI cannot be withdrawn.
6. **Every derivative says what it is.**
   It carries `GeneratedBy` (recipe, version, image digest, job id and the nemar-process build) and `SourceDatasets` (dataset id, version, and the version DOI when there is one), and a citation string.
   For the `serving` profile it also carries one sentence about electroencephalography (EEG), declared once in the module: "Computed on NEMAR's Zarr serving copy (EEG capped at 250 Hz, 16-bit), not on the archived recordings."
   General statements say "capped at 250 Hz", quality control describes the serving copy, and the archived recordings' rate is never stated.
7. **Known limit: a recorded digest is a claim the platform cannot yet verify.**
   Until the converter writes each store's content digest at commit, the recipe computes it from what it read and records it in its signalJourney record; the platform records it and cannot check it against the store.
   A recorded input digest therefore keys a derivative only when every check holds.
   For either input, the job's dispatched specification named no `--recording`, because the record cannot say a run was a subset and a subset run would take its full run's key.
   For either input, no row of the job's recordings table ended `out_of_memory`, `internal_error`, `disk_error` or `time_budget`, because a rerun under the same key could differ; a deterministic failure such as `load_failed` may be keyed.
   For a `zarr` input also, the dataset record's `stores_unread` is an empty list (the store paths not read in full, never a count) and its `stores_content` is non-empty.
   And the paths of those rows are the input's `stores`, each once, and `inputDigest` of those rows equals the record's stated `input_digest`.
   The stamp stores a Zarr digest only after the first three Zarr checks and leaves the recomputation to the store that writes a derivative, so `inputDigest` is the one copy of the definition.

## Consequences

- A second job with the same key adds nothing: the first derivative stands.
  A reconversion that changes no value the recipe reads keeps every key; one that changes a value makes new keys, and the old derivatives age out under their classes.
- The stamps decide when a recipe runs again.
  A reconversion that changes values but no version string is not noticed until the converter writes digests, so a derivative keeps the key of what was read at the time, which remains true of it.
- The key is a name, not a secret; access is decided where the bucket is bound and by role, never by knowing a key.
- The definitions are hard to reverse, because a change orphans every key.
  A change is therefore a new format name (`v2`) and a new ADR, and old keys stay valid names.
- The TypeScript digest function hashes a group in one call and is for vectors and groups that fit in memory; the recipes hash a real recording by streaming, and the two agree on the vectors.
- A derivative of the serving copy is honest about its source, and a derivative of the archive can never carry the serving sentence.
- Until the converter writes the digests, the keying checks are the only guard against a partial or flaky run taking a full run's key, so a stamp that fails one is skipped and counted, not keyed.

## Alternatives considered

- **Key on the Zarr index digest:** every reconversion rewrites `updated_utc` and orphans every derivative.
- **Put the image digest in the key:** every image rebuild would orphan derivatives of an unchanged recipe version; it is provenance, recorded with the derivative.
- **Write derivatives into the serving copy:** ADR 0027 keeps it to raw recordings.
- **Commit derivatives into the dataset repository:** it would cost a version bump, an irrevocable DOI and a stamp loop (ADR 0121 decision 8).
- **Keep them in the results bucket:** it expires objects, which would delete a `catalog` or `published` derivative.
- **Mint a DOI when a derivative is promoted:** a DOI cannot be withdrawn, so it follows an explicit owner action only.
- **Normalize or trim text before hashing:** two stores whose labels differ by a code point or a space would share a digest, and a digest names the bytes read.

## Receipts

- [ADR 0007](0007-ezid-is-the-sole-doi-provider.md) (EZID is the registrar), [ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md) (the serving copy is raw-only), ADR 0118 decision 7 (the results bucket) and ADR 0121 decisions 8 and 9 (a derivative's own home; the recipe records what it read).
- `shared/contract/derivatives.ts` and `shared/contract/derivatives-vectors.json`: the definitions and seven vectors, computed with Python `struct`, `hashlib` and NumPy and with Bun `node:crypto`, all equal; computed, not measured on any NEMAR data.
- The owner's decision of 2026-11-14 on keyed storage and the three retention classes, and the review finding that an index digest orphans derivatives at reconversion.
