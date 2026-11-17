# ADR 0123: Derivatives live in a keyed store, named by what they read

**Status:** proposed
**Date:** 2026-11-14
**Owner:** Seyed Yahya Shirazi

Epic #2145.
This Architecture Decision Record (ADR) records where the products of NEMAR's compute recipes live once a job has finished, how each one is named, how long each is kept, and what each says about itself.
It follows [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md), whose results bucket expires a job's outputs, and [ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md) decision 8, which promised a derivative its own home and left the choosing of it to a later decision.
It supersedes nothing.

The key and both digests are defined byte for byte in [`shared/contract/derivatives.ts`](../../shared/contract/derivatives.ts) and held to [`shared/contract/derivatives-vectors.json`](../../shared/contract/derivatives-vectors.json), which Python and TypeScript must both reproduce.
Where this text, that module and a vector disagree, one of them is wrong and the maintainer decides which; no one edits a vector to make code pass, and no one edits this ADR to excuse code that disagrees with it.

## Context

A finished pipeline job's outputs sit in the results bucket, which expires them after 30 days by default (ADR 0118 decision 7).
A product worth keeping needs a home with its own lifetime and a name that does not change when the same work is run again.
Naming a derivative by the digest of the Zarr index would orphan every derivative at the next reconversion, because the index carries `updated_utc`: the name has to follow what the recipe read, not the file that describes it.
The Zarr serving copy is 16-bit and its rate is capped per modality: electroencephalography (EEG) and magnetoencephalography (MEG) at 250 hertz (Hz), intracranial EEG (iEEG) and electromyography (EMG) at 1000 Hz.
And [ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md) keeps it to raw recordings, so a derivative of it must say what it was computed on and must never be written into it.
A Digital Object Identifier (DOI) cannot be withdrawn, and the registrar is EZID ([ADR 0007](0007-ezid-is-the-sole-doi-provider.md)).
The owner decided on 2026-11-14 that derivatives live in a keyed store with three retention classes.

## Decision

1. **Derivatives live in a private Cloudflare object store (R2) bucket of their own.**
   Objects are `d/`, the key, and the product's relative paths, and are immutable once stored.
   They are never written into the serving copy, never committed into the dataset repository, and never kept in the results bucket, because each of those has a different purpose and, for the results bucket, a lifetime that would delete a kept derivative.
2. **The derivative key is the Secure Hash Algorithm 256 (SHA-256) of `nemar.derivative-key.v1` and eight lines.**
   The lines are `dataset`, `version`, `recipe`, `recipe_version`, `engine`, `input`, `profile` and `input_digest`, in that order, each `name`, a space, the value and a line feed (LF).
   The values are full-string matches, so a Python consumer must use `re.fullmatch` (its `$` also matches before a trailing LF): dataset `^[a-z]{2}[0-9]{6}$`; version and recipe version `^[0-9A-Za-z._+-]{1,64}$`; recipe `^[a-z0-9-]{1,64}$`; engine `^[0-9A-Za-z._+@-]{1,64}$`.
   Input `zarr` goes with profile `serving` and a `sha256:` digest, input `bids` with profile `archive` and a `git:` digest, and any other value or pairing is refused, so a serving derivative can never pass for an archive one.
   The image digest is recorded with a derivative and is never part of its key: it is provenance, so a rebuilt image does not orphan a derivative whose recipe version and engine are unchanged.
   The price is a duty: an image change that can change a value must change `recipe_version` or `engine`, because a rebuild that changed numbers without a version bump would silently keep the old derivative.
3. **The input digest names what was read, not what was indexed.**
   For a `zarr` input it is `sha256:` and the SHA-256 of the lines `path`, tab, `group`, tab, `content_sha256`, LF, one per store whose group was read in full, sorted by path in code point order, which is the order of the paths' bytes in Unicode Transformation Format 8-bit (UTF-8).
   Python's `sorted` gives that order; JavaScript's default `sort` compares UTF-16 units and disagrees above U+FFFF, so the TypeScript compares bytes.
   For a `bids` input it is `git:` and the 40 hexadecimal digits of the source commit the dataset version names.
   `inputDigest` has no digest for no rows, a repeated path, an empty path or group, a tab, carriage return, line feed or lone surrogate in a path or group (a tab would let two different rows give one line), or a `content_sha256` that is not 64 lowercase hexadecimal digits.
   Keying on the index would orphan derivatives at every reconversion; a content digest changes only when a value the recipe read changes.
   Amended 2026-11-16: a `zarr` input is keyed by `nemar.input-digest.v2`, which adds each store's `nemar.store-locations.v1` digest (see the amendment).
4. **A store's content digest is `nemar.store-content.v1`, over one channel group of the level-0 array.**
   It is the SHA-256 of a UTF-8 header and then the physical values.
   The header lines, each ending in LF, are `nemar.store-content.v1`; `shape C S`, the decimal channel and sample counts; `rate H`, the 16 lowercase hexadecimal digits of the serving rate as an Institute of Electrical and Electronics Engineers (IEEE) 754 binary64, big-endian; `unit` and the unit; one `label` line per channel in stored order; `data float64-le`.
   Labels are all or none (the lines carry labels only when every channel has a non-empty one, otherwise every line is `label` alone), and the unit is shared or none (`unit` carries text only when every channel states the same non-empty unit, otherwise `unit` alone, so an empty unit is no unit and never `unit` and a space).
   The two rules apply first, so text they drop is never examined.
   The values are C times S little-endian binary64 numbers, channel-major, each `float64(digital) * float64(scale[c]) + float64(offset[c])` as two separately rounded operations, never fused.
   Text is hashed as its UTF-8 bytes exactly as given, with no Unicode normalization and no trimming, so U+00B5 and U+03BC are different units.
   Text that enters the header and holds a carriage return, a line feed or a lone surrogate has no digest: it is an error and never a guess.
   A rate, scale, offset, digital value or product that is not finite has no digest, because the bytes of a NaN differ by processor (an x86 operation writes `fff8000000000000`, ARM `7ff8000000000000`), and neither has a group with fewer than one channel or one sample.
   The archived rate is never read, so a digest cannot state or depend on it.
5. **Retention has three classes, and a DOI is never minted by code.**
   `canary` expires 30 days after it is stored.
   `catalog` is kept until a later `catalog` derivative of the same dataset, recipe, input and profile is promoted, and then expires 30 days after that.
   `published` never expires and only the owner sets it.
   Every derivative starts as `canary`, and no code path mints a DOI: a future, separately reviewed, owner-only action does, for a `published` derivative only, because a DOI cannot be withdrawn.
6. **Every derivative says what it is.**
   It carries `GeneratedBy` (recipe, version, image digest, job id and the nemar-process build) and `SourceDatasets` (dataset id, version, and the version DOI when there is one), and a citation string.
   For the `serving` profile it also carries one sentence, declared once in the module: "Computed on NEMAR's Zarr serving copy (EEG capped at 250 Hz, 16-bit), not on the archived recordings."
   The sentence names EEG only, which is true of every derivative the store can take today because the only Zarr-input recipe reads just a store's EEG group, while the cap is per modality (EEG and MEG at 250 Hz, iEEG and EMG at 1000 Hz):
   the change that first lets a recipe read an iEEG, EMG or MEG group adds that modality's sentence to the module, with an amendment to this ADR, before any such derivative is stored, and since the sentence is in no key or digest, adding it orphans nothing.
   General statements about EEG say "capped at 250 Hz", quality control describes the serving copy, and the archived recordings' rate is never stated.
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
- A derivative of the serving copy says what it was computed on, and a derivative of the archive can never carry the serving sentence.
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
- `shared/contract/derivatives.ts` and `shared/contract/derivatives-vectors.json`: the definitions, eight vectors and a list of refusals, computed with Python `struct`, `hashlib` and NumPy and with Bun `node:crypto`, all equal; computed, not measured on any NEMAR data.
- The owner's decision of 2026-11-14 on keyed storage and the three retention classes, and the review finding that an index digest orphans derivatives at reconversion.
- The amendment's vectors (`store_locations`, `input_digest_v2` and their refusals) in `shared/contract/derivatives-vectors.json`, computed in Python and in Bun, equal, and held to a second implementation in Python that `test/contract-derivatives-python.unit.test.ts` runs through `uv`; computed, not measured on any NEMAR data.

## Amendment 2026-11-16 (owner decision Q49, D3): the Zarr input digest names the positions a recipe was handed

Decision 3 above is the 2026-11-14 text and stays as written: it defines version 1 of the input digest.
From this amendment on, a `zarr` input is keyed by `nemar.input-digest.v2`, which adds to each store's row a digest of the electrode positions the recipe was handed from that store.
Both texts are defined byte for byte in `shared/contract/derivatives.ts` (`inputDigestV2`, `storeLocationsText` and `storeLocationsSha256`) and held to the vectors `store_locations` and `input_digest_v2` in `shared/contract/derivatives-vectors.json`, which Python and TypeScript must both reproduce.

**Why.**
Once a recipe hands electrode positions to eegprep, its output depends on them, and the store content digest of decision 4 holds none: positions are root attributes of the store, not values of the channel group that digest describes.
Three cases then break the promise that a key names what was read.

1. A converter change alone, or a reconversion after the dataset corrected its electrodes file, changes the positions and no value, so the content digest and the key stay, and the first derivative stands over positions that are no longer the store's.
2. A recording that failed for want of positions is a deterministic failure, which may be keyed; once positions appear, a rerun has the same key and the keyed failure stands.
3. A recipe whose quality control branches on whether positions exist takes the other branch for the same stores under the same digest once the reader carries positions.

Putting positions into the store content digest was rejected: every reader implements that digest, and every derivative would be re-keyed when only positions changed, including derivatives of recipes that read none.
A ninth key line (`nemar.derivative-key.v2`) was the second choice and was rejected because the input digest would then no longer name everything the recipe read.

**`nemar.store-locations.v1`** is the SHA-256 of a UTF-8 text, as 64 lowercase hexadecimal digits, over what a reader handed eegprep for one read group.
The lines, each ending in LF, are `nemar.store-locations.v1`; `system`, and after a space the store's coordinate system text; `units` by the same rule; then one `position` line per channel of the group in stored order, which is `position` and after a space the 16 lowercase hexadecimal digits of each of x, y and z as an IEEE 754 binary64, big-endian (as the rate is written in decision 4), or `position` alone.

- The definition reads exactly three root attributes of the store, `electrode_positions`, `electrode_coordinate_system` and `electrode_coordinate_units`, through own-property reads; a key that is absent or null is absent.
- The system and units lines carry text only when positions are present and the text is a non-empty string; a value that is not a string counts as the empty string.
- A channel gets coordinates only when every channel of the group has a non-empty label (the all-or-none rule of decision 4, so an unlabeled group joins nothing), positions are present, they hold an own entry under exactly that label (no case fold, no trimming, no Unicode normalization, no inherited name such as `constructor`), and that entry is an array of exactly three numbers that are finite and none a boolean.
  Any other entry gives that channel `position` alone.
- A zero coordinate is written as positive zero, `0000000000000000`, whatever its sign, because Python reads the JSON number `-0` as the integer 0 where `JSON.parse` reads negative zero.
- A number that is not finite as a binary64 (a NaN, an infinity, or an integer too large for binary64) gives that channel `position` alone and is not a refusal.
- Coordinates are hashed as the store states them, before any unit change, axis change or recentering: what a reader makes of them is fixed by the reader's and the recipe's versions.
- Refused, with no digest: labels that are not a list of at least one entry or hold an entry that is neither text nor null; attributes that are not an object; positions that are present and not an object; and a system or units text that enters the text and holds a carriage return, a line feed or a lone surrogate.
  Text that is dropped is never examined.
- The converter's provenance attributes `electrode_positions_source`, `electrode_positions_file` and `electrode_coordsystem_file` are not hashed, and neither is any other root attribute or an entry under a label the group does not have.
  They do not change what eegprep receives, so a recipe that branches on one of them must first change this definition.

**`nemar.input-digest.v2`** is `sha256:` and the SHA-256 of the line `nemar.input-digest.v2` and LF, then one line per store whose group was read in full, `path`, tab, `group`, tab, `content_sha256`, tab, `locations`, LF, sorted by path in code point order exactly as in decision 3.
`locations` is the store's `nemar.store-locations.v1` digest or exactly `none`, in lowercase.
`none` means the recipe by design handed eegprep no positions from that store; it never means that the store had none, which is the digest of a text whose every `position` is alone.
Every refusal of decision 3 holds with the same field, except that a row that is a list is not an object and is refused with the field `stores_content` (version 1 reads a list as an object with no path and names `path`, which no stamp reaches, because the stamp rejects lists first), and a `locations` that is missing, not text, or neither shape is refused with the field `locations`.
The header line means a version 1 text and a version 2 text are never the same bytes.
The derivative key keeps `nemar.derivative-key.v1` and its validator, because a version 2 digest is a valid `sha256:` input digest.

**What stays.**
Nothing of version 1 moves, and version 1 stays defined: `inputDigest`, the store content digest, the key and every earlier vector keep their bytes, and the vectors file gained lines only, because records written before a recipe computes version 2 state a version 1 digest.
No derivative and no key exists outside tests, and the code that writes a Zarr derivative recomputes `inputDigestV2` and never `inputDigest`, so nothing is keyed under version 1.
The stamp's coverage check reads only each row's path and the `sha256:` shape of the stated digest, so it does not move.

**Why an amendment and not a new ADR.**
The decisions index keeps an amendment for a clarification and sends a changed verdict to a new ADR, because an amended verdict is invisible to anyone who read the ADR before.
This ADR is still `proposed`, no derivative and no key exists outside tests, and the owner decided on 2026-11-16 (Q49, D3: option B, decided before the code that writes a derivative is built) that this is an amendment of decision 3.
The 2026-11-14 text above is kept word for word so that it stays findable, and its closing sentence points here.
This amendment is the single exception to the Consequences sentence "A change is therefore a new format name (`v2`) and a new ADR": it keeps the new format names, `nemar.store-locations.v1` and `nemar.input-digest.v2`, and not the new ADR, on the owner's decision of 2026-11-16 (Q49, D3) cited above.
The rule in Consequences governs every later change: a change is a new format name and a new ADR, including a change to either definition above.

## Amendment 2026-11-17 (owner decisions Q68 A and Q69 A): each environment binds its own derivatives bucket, reached with that environment's compute R2 token

Decision 1's bucket is bound as `COMPUTE_DERIVATIVES`, with its name in `COMPUTE_DERIVATIVES_BUCKET_NAME`: `nemar-compute-derivatives` for production and `nemar-compute-derivatives-dev` for the dev Worker, never one bucket for both.
Each is private (no r2.dev access, no custom domain) and carries no lifecycle rule that deletes objects (Cloudflare's default abort of incomplete multipart uploads is the only rule), because retention is the store's code and a deletion rule would delete a `published` derivative.
The copy from the results bucket is signed with the environment's existing compute key pair (`COMPUTE_R2_ACCESS_KEY_ID` and `COMPUTE_R2_SECRET_ACCESS_KEY`), whose token the owner extends to that environment's derivatives bucket and no other, so the store has no secret of its own, and no address into the derivatives bucket is ever signed: the copy is a request the Worker signs and sends itself.
Reusing the pair has a cost: the token is Object Read & Write with no prefix scoping, so the pair that signs every records and results address can also overwrite or delete any derivative, a `published` one included; no lock or lifecycle rule protects a derivative, only the store's code and the pair staying in the Worker, Infisical and the owner's own commands, so a leak or a rotation of that pair is a derivatives event as well.
Binding a bucket turns on no compute, though it starts the store's daily production pass, which reads no switch: that pass keys only a succeeded pipeline stamp, which only a job dispatched while `COMPUTE_ENABLED` is on can produce.
