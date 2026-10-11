# ADR 0074: manifest.json emits unsigned public URLs, presigned only for a bucket-policy exclusion

**Status:** superseded by ADR-0095
**Date:** 2026-09-28
**Owner:** Seyed Yahya Shirazi

## Context

`manifest.json` presigned every annexed entry's `url` on every request, but a public dataset's
objects are already anonymously readable: a sweep on 2026-09-28 HEAD-requested one annexed
object per catalog dataset with no signature, and all 771 public datasets with objects answered
200. The signature bought nothing and cost a great deal. Measured on nm000134 v1.0.3 (18,274
annexed entries): signed URL text was 8.9 MB of the 16.1 MB response, and computing the
signatures was most of its 9.7 s. Signed URLs also expire in 3,600 s, so a client that read the
manifest once and downloaded for longer than an hour got 403s partway through (observed: a URL
from a morning fetch 403'd eight hours later, and nm000284 is 512 GiB). And because the
signature is minted from the Worker's own credentials, it keeps answering for up to an hour
after the bucket policy excludes the dataset from public read -- the opposite of the revocation
promise a reader would assume.

Issue #1524, filed the same day, found the other half of the risk: 23 catalog-private datasets
were anonymously readable in S3 because the bucket policy's `PublicReadExceptPrivate` carve-out
(`services/bucket-policy.ts`) had drifted from the catalog. That issue is about bringing the two
back into agreement; this decision has to be correct whether or not they agree, because nothing
enforces they always will.

## Decision

**An annexed entry's `url` is the plain public S3 URL, no query string, for a dataset the bucket
policy does not exclude from public read.** `buildPublicObjectUrl` (`services/s3.ts`) builds it
the same way `generatePresignedGetUrl` builds its pre-signature URL -- a bare string-concatenated
key parsed by `new URL(...)`, no manual percent-encoding -- so a key produces the identical path
either way; the difference is that nothing is ever signed. `buildAnnexPublicUrl`
(`services/data-router.ts`) adds the same git/annex-key validation `buildRedirectUrl` already
applies.

**A dataset the bucket policy excludes keeps the legacy presigned URL, always**, so
`manifest.json`'s correctness never depends on the catalog and the bucket policy agreeing --
exactly the drift #1524 found. The decision is read through the existing `getBucketPolicy` and
cached per isolate for 60 seconds (`services/public-read-cache.ts`), keyed by (bucket, endpoint)
rather than a single slot so it cannot answer for the wrong bucket. Neither stale direction is a
security problem: a stale "excluded" reading keeps presigning (the Worker's own credentials sign
regardless of the anonymous grant, so the link still works); a stale "not excluded" reading emits
an unsigned URL that S3 answers 403 for until the cache catches up -- broken, never leaked,
because `NotResource` means the object was never anonymously public in that window. The
visibility gate (`loadPublishedDataset`, ADR 0017) still runs before any of this on every
request; the cached decision only ever affects which KIND of URL a request already cleared to see
gets.

**The document is deterministic per (dataset, version, manifest ETag), so it is cached.** For a
non-excluded dataset the built response -- the full JSON array, not just the raw manifest bytes
`manifest-source.ts` already caches -- is stored in the Workers Cache API
(`services/manifest-json-cache.ts`) under a key scoped like `manifestCacheKey` and
`gitFileCacheKey` (dataset, version, origin; never content-addressed, per ADR 0066), and
revalidated on every use with a conditional GET against the manifest object's current ETag
(`fetchManifestObject`'s `ifNoneMatch`) before ever answering from the cache. A hit skips both the
count scan and the entries scan entirely; a miss costs what it always cost. The stored entry's own
TTL is seven days -- unrelated to freshness, since every hit re-validates regardless of age, the
same reasoning `GIT_FILE_CACHE_TTL_SECONDS` and `MANIFEST_CACHE_TTL_SECONDS` already use. An
excluded dataset's document is never written to this cache: its entries carry a signature good for
one requester for one hour, and caching it would hand that signature to everyone who asks for the
next seven days of staleness this cache would otherwise tolerate.

**The client-facing `Cache-Control` no longer tracks a signature lifetime.** A non-excluded
document is served `public, max-age=300`, reusing the authorization-staleness bound ADR 0066
already set for a brokered git-tracked file's bytes, rather than inventing a third number for the
same question on the same data plane: it bounds how long a downstream cache may keep answering
for a dataset whose visibility just flipped, not a signature's lifetime, since there is no longer
one. An excluded dataset keeps `public, max-age=60`, unchanged, because its URLs still expire in
an hour and cost real CPU to mint.

**The entry bound (#1502/#1505) is now PER BRANCH, not one number applied to both.** Re-measured
with the same generator (`test/helpers/large-manifest.ts`) and the actual production URL
builders, under Bun with `bun:jsc`'s `heapStats`: a presigned entry costs about 1.03 KB live at
serialization (a different absolute number from #1505's own 1.7 KB estimate, most likely
differently accounted `Promise.all` overhead, but flat and reproducible under this methodology)
against about 0.80 KB for an unsigned one -- 22% less, since a public URL carries no signature,
expiry or `response-content-disposition` query parameters. The two costs are different, so each
branch keeps the bound its own cost supports:

- `MAX_MANIFEST_JSON_ENTRIES_PRESIGNED` stays at the original 30,000. At 1.03 KB/entry that is
  about 30.2 MB, the same figure #1505 sized 30,000 against -- unchanged, because presigning
  never got cheaper.
- `MAX_MANIFEST_JSON_ENTRIES` (unsigned) is raised to 38,000. At 0.80 KB/entry that is about
  29.7 MB, under the 30.2 MB the presigned branch already spends -- so it covers more entries
  because each one is cheaper, not because the ceiling moved.

**Amendment 2026-09-28 (review of #1529):** the first version of this change raised ONE shared
constant to 38,000 and applied it to both branches. That let the presigned branch grow to 38,000
entries at 1.03 KB each -- about 38.3 MB, ~27% over the 30.2 MB budget it was ever measured
against -- for entries whose cost this change never reduced. `manifestJsonHandler` now picks the
bound from the already-known `excluded` decision BEFORE the count check, so the count check, the
`EntriesQuery` limit, and the 413 body's `limit` field all agree on which branch's number applies;
a test (`data-route-manifest-stream.test.ts`, "the per-branch bound") pins a single manifest sized
strictly between the two bounds answering 413 when presigned and 200 when unsigned.

Against the catalog on 2026-09-24, neither bound moves any of the seven datasets already over the
old 30,000 bound (they start at 45,424). The intended asymmetry: a PUBLIC dataset between 30,000
and 38,000 files now gets `manifest.json` where it did not before; a dataset the bucket policy
EXCLUDES in that same range still does not, because its entries never got cheaper.

## Consequences

- A downloader that reads the manifest once and transfers for longer than an hour no longer 403s
  partway through, for any dataset the bucket policy does not exclude -- the problem #1522 opened
  on.
- `manifest.json` is now cheaper to build (no per-entry signing) and cheaper to re-serve (the
  built document is cached), at the cost of one more per-isolate cache and one more edge cache to
  reason about, both following patterns (`github-auth.ts`'s installation-token cache;
  `git-file-cache.ts`) already established in this codebase.
- Revocation for the unsigned path is now IMMEDIATE at the bucket-policy layer (an excluded
  object 403s the moment the policy says so) rather than lagging up to an hour behind a signed
  URL's expiry -- but only once #1524's drift is fixed for a given dataset; until then, a
  catalog-private dataset whose objects are still anonymously public in S3 was already
  unsigned-readable directly, and this ADR does not change that exposure, only where `url` points.
- A client that persisted a `manifest.json` response and expected its annexed URLs to expire has
  nothing that breaks: they simply keep working, which is what #1522's compatibility sweep
  confirmed no in-repo or known external consumer relies on.

## Alternatives considered

- **Sign shorter-lived URLs instead of removing the signature.** Does not fix the actual cost
  (still one signature per entry, still 8.9 MB of query string on nm000134) and does not fix the
  main complaint (a long transfer still outlives a short expiry sooner).
- **Presign everything, unconditionally, and fix #1524 instead.** Rejected because it makes
  `manifest.json`'s correctness depend on the catalog and the bucket policy staying in agreement,
  which is the exact failure mode #1524 exists to describe; this decision has to hold even before
  that issue is resolved.
- **Cache the unsigned entries but not the whole built document.** Considered and rejected as not
  worth a second, narrower cache: the entries array and its `JSON.stringify` are cheap to rebuild
  once the manifest bytes are known, so the real cost this removes is the manifest SCAN itself,
  which only a response-level cache (not a per-entry one) can skip.

## Receipts

- Issues #1522 (this decision), #1524 (the drift this decision has to be correct despite), #1494
  (the owner's compatibility note to nemar-py), #1502/#1505 (the entry bound this re-measures),
  #1530 (a follow-up, filed from #1529's review: `assertValidS3Key` does not reject `#`/`?`,
  pre-existing parity between the presigned and unsigned builders, not a regression here)
- `backend/src/routes/data.ts` (`manifestJsonHandler`, `MAX_MANIFEST_JSON_ENTRIES`,
  `MAX_MANIFEST_JSON_ENTRIES_PRESIGNED`),
  `backend/src/services/s3.ts` (`buildPublicObjectUrl`, `getBucketPolicy`),
  `backend/src/services/data-router.ts` (`buildAnnexPublicUrl`, `PublicManifestEntry`),
  `backend/src/services/public-read-cache.ts`, `backend/src/services/manifest-json-cache.ts`
- ADR 0017 (the visibility gate this still runs before any of this), ADR 0066 (the manifest is
  the capability list; cache keys never content-addressed; the 300s authorization-staleness bound
  this reuses), ADR 0072 (the raw-manifest edge cache this response-level cache sits beside, and
  the streaming read this bound governs)
- Guards: `backend/test/s3-public-url.test.ts`, `backend/test/public-read-cache.test.ts`,
  `backend/test/manifest-json-cache.test.ts`, `backend/test/data-route-manifest-stream.test.ts`
  ("manifest.json", "the manifest.json response cache sits behind the visibility gate")
