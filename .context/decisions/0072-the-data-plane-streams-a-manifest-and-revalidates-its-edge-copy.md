# ADR 0072: The data plane streams a manifest, answers one question per read, and revalidates its edge copy on every use (amended 2026-09-28: it trusts the copy for 60 seconds before revalidating)

**Status:** accepted
**Amendment 2026-09-28 (#1494):** "Every read costs one conditional S3 request even on a
cache hit" (a Consequences bullet below) turned out to be most of a cache hit's own cost
once the Worker was no longer running next to its backends (see the placement change,
`backend/wrangler-sccn.toml`). Read "Amendment, 2026-09-28" below before relying on this
document's claim that every read revalidates; a read now revalidates unless a bounded
trust window says it does not need to.
**Date:** 2026-09-24
**Owner:** Seyed Yahya Shirazi

## Context

Every data.nemar.org request that names a file, a directory, a tombstone or `metadata.json`
needs the version manifest (`<id>/version/v<X>.json`), and `loadManifest` read it whole
and `JSON.parse`d it per request. nm000281's v1.0.3 manifest is 42,849,468 bytes and
102,532 entries; in a 128 MB isolate every request for that dataset ended in
`exceededMemory`, and an isolate that exceeds its memory fails every request it is
serving, not only the one that pushed it over (#1502). Seven catalog datasets have more
than 45,000 files. ADR 0066 makes the manifest the capability list, so whatever replaced
the whole parse had to stay the one source the gate reads.

Two facts measured while fixing it constrain the design. A version's manifest is NOT
immutable: the S3 objects for nm000132's three versions were all last written on
2026-05-27, months after those versions were published, and nm000281's on 2026-08-31,
because the pipeline regenerates manifests in place. And `manifest.json`, which presigns
every entry into one JSON document, cannot be bounded by reading less: its answer is the
whole manifest.

## Decision

**A manifest is read as a stream and a read answers one question.** The body is tokenized
incrementally (`services/manifest-scan.ts`) and a query (`services/manifest-queries.ts`)
keeps only its answer: one entry, one directory's immediate children, a boolean, a digest
of totals and the BIDS index, or a count. The verdict is still `JSON.parse`'s: the whole
body is read on every scan, and a document broken anywhere, including after the entry a
caller wanted, is malformed.

**No query reads a manifest whole, whatever the manifest looks like.** Where the stream
cannot prove an answer, it says so instead of materializing the document to find out.
The `metadata.json` digest is the case: its totals are exact only while keys strictly
ascend (so no key repeats). Once the order breaks, the totals are reported unproven, and
the route takes them from the catalog row, as it does when no manifest can be read. The
BIDS index and sessions are sets, so they stay exact in any order. An entry whose size
is not a non-negative integer is counted as a file and left out of `size_bytes`. Both
cases are logged. Manifests are rewritten in place, so "no current manifest is unsorted"
is an observation, not an invariant, and the bound cannot depend on it.

**The raw body is kept in the Workers Cache API, and a copy never answers without S3
saying so.** The copy is stored with the S3 ETag it came with, under a dataset- and
version-scoped synthetic key on a path no public route serves, and every use sends
`If-None-Match`. Only a 304 lets the copy answer; a rewrite gets a 200 and replaces it; a
404 is absent. The cache is read only after the visibility gate, as the manifest always
was. A copy is stored only after the scanner accepted the whole document, and a copy that
cannot be read back whole is not trusted: S3 answers instead.
(Amended 2026-09-28: within the 60 s trust window described below, a copy S3 confirmed
recently answers without a revalidation.)

**`manifest.json` refuses more than 30,000 entries** with a 413 that names the
per-directory JSON listing. It counts first and keeps nothing, so the refusal costs what
any other lookup costs.
(Amended 2026-09-28: see ADR 0074 for the per-branch bound, 38,000 unsigned / 30,000
presigned.)
(Amended 2026-10-09: ADR 0095 supersedes the per-branch bound; stable data-plane URLs make
38,000 the common limit for every dataset.)

## Consequences

- A request's memory follows its answer, not the dataset. Measured on a generated
  63 MB, 149,979-entry manifest: under 1 MB of live memory for a lookup under Bun, and an
  isolate heap that stayed under about 27 MB under local workerd on a 43 MB one.
- CPU still follows the manifest: every scan tokenizes the whole body (about 45 ms for
  40 MB under Bun, about 140 ms per request for 43 MB under local workerd). This is the
  stopgap the issue named. A per-directory index written at publication, still read
  from the manifest the gate trusts, is what removes it.
- Every read costs one conditional S3 request even on a cache hit, and a miss costs one
  full read that also fills the cache. The cache changes where the bytes come from, never
  what the route decides. The tail of a cache write goes to `waitUntil`, so a slow or
  wedged `cache.put` never delays an answer.
- `metadata.json` for a manifest whose keys are out of order reports the catalog row's
  `total_files` and `size_bytes`, which can be stale, instead of the manifest's. That
  departs from the pre-#1502 route, which parsed the whole document and summed it
  (concatenating a string size). This is the price of having no unbounded path.
- Seven datasets lose `manifest.json` (every one at 45,424 files or more, where the old
  path already needed about 90 MB). Their files remain enumerable one directory at a time.

## Amendment, 2026-09-28: a bounded trust window, and a per-isolate answer memo (#1494)

Staging measured what this ADR's original design could not see from a laptop: with the
Worker running wherever the free-tier zone's anycast happened to land it rather than next
to D1 and S3 (the placement change alongside this amendment, `backend/wrangler-sccn.toml`),
the conditional GET this ADR requires on every read was itself 120-460ms of a 200-600ms
cache-hit response -- most of the cost, on a request that had already done the hard part
(the copy was right there, unread). Placement addresses HOW FAR that round trip travels;
this amendment addresses whether every read needs to make it AT ALL.

**An edge copy validated within the last 60 seconds is used without asking S3.** The
validation time is recorded as a header on the STORED copy (`X-Nemar-Manifest-Validated-At`
in `manifest-source.ts`), not in per-isolate memory, so the window is a property of the
cache entry and holds across every isolate sharing it in a data center, not only the one
that first validated it. Once the window has passed, the very next read revalidates against
S3 exactly as the original design required; a 304 there both answers that read and restamps
the copy (streamed through the same bounded-queue writer a miss already uses, never buffered
whole), starting a new 60-second window. A genuine rewrite during the window is invisible
until the window's next boundary and never later -- the staleness this trades for skipping
the round trip is bounded, not unbounded.

**Why 60 seconds, and why this is not the "trust the edge copy for a TTL" alternative
rejected above.** That rejection was about trusting a copy with NOTHING left to catch a
rewrite -- an unbounded staleness window with no periodic correction. This is a rolling
60-second bound with a hard floor: manifests are rewritten rarely (a publish, a heal run,
not continuously, per the Context section above), and every client-facing response this
route already serves is trusted for at least as long without revalidation on the CLIENT'S
side -- `public, max-age=60` on the JSON directory listing, `manifest.json` and the
tombstone 404, `max-age=300` on a brokered git-tracked file (ADR 0066). So this window is
never the largest source of staleness a client already accepts; it only removes a
round trip the client could not observe either way. The gate is unaffected: every request
still calls `loadPublishedDataset` before the manifest is read, memoized or not, so a
dataset flipped private is refused on its very next request regardless of how fresh the
window or the memo is (`data-route-manifest-stream.test.ts`, "a dataset flipped private is
refused even with a warm memo and a fresh trust window").

**A per-isolate answer memo removes the SCAN too, for a query this isolate has already run.**
The trust window above still means a warm isolate re-tokenizes the whole cached body for
every request, because nothing before this amendment remembered what an earlier scan had
already answered. `manifest-answer-memo.ts` keys a finished answer by `(dataset, version,
the manifest's own ETag, a caller-supplied description of the query)` -- the ETag is what
makes a rewrite safe to memoize across: a rewrite is a new ETag, which is a different key,
and the memo is consulted ONLY once the trust window already accepts the cached copy's ETag
as current (never on a stale, not-yet-revalidated one), so a repeat request within the
window can skip both the round trip and the scan. Bounded by an LRU with a 4 MiB total cap
(`MANIFEST_ANSWER_MEMO_CAP_BYTES`) -- generous for the small answers (a resolved file or
directory entry, a digest) this mainly exists for, and under 4% of the 128 MB isolate budget
nm000281's 43 MB manifest already pushes hard on, so a memo entry can never meaningfully
compete with the memory bound #1502 exists to hold. A single answer larger than half the cap
(`manifest.json`'s own `EntriesQuery`, near its current 38,000-entry ceiling under ADR 0095) is
answered but never memoized, so one large listing cannot evict every small, hot entry.
(Amended 2026-09-28: see ADR 0074 for the per-branch bound, 38,000 unsigned / 30,000
presigned -- either is still answered but not memoized.)
(Amended 2026-10-09: ADR 0095 supersedes the per-branch bound; the common 38,000-entry ceiling
applies to every dataset, and the memoization rule is unchanged.)

`Server-Timing`'s `manifest` stage now carries `desc="memo"`, `"fresh"` (window hit, still
scanned), `"revalidated"` (a 304) or `"rewrite"` (a fresh 200), so the window's effect is
visible from outside without a deploy that adds logging first -- the same reason the header
exists at all (#1516).

**`manifest.json`'s own response cache (now governed by ADR 0095) rides this same window, instead of a
second, independent conditional GET.** Its freshness check used to call `fetchManifestObject`
directly (`manifestJsonCacheStillFresh`); every hit paid one conditional GET regardless of the
window above. `manifestJsonHandler` now compares its cached document's ETag against the ETag
the `EntryCountQuery` it already runs (to enforce the common entry bound) came back with --
that query goes through `readManifest` like any other, so a hit confirmed within the window
costs no S3 call at all, and one confirmed past the window costs exactly the single conditional
GET the count query already pays to restamp its own copy. `manifestJsonCacheStillFresh` is gone.
See "the manifest.json response cache sits behind the visibility gate" in
`data-route-manifest-stream.test.ts` for the within-window (zero calls), past-window (one call)
and rewrite-visible-only-past-the-window guards.

## Alternatives considered

- **Trust the edge copy for a TTL.** Rejected as an UNBOUNDED design (see the 2026-09-28
  amendment for the bounded version that shipped): manifests are rewritten in place, and a
  stale capability list serves paths the current manifest no longer names.
- **Stop scanning at the requested entry.** Rejected: a truncated or corrupt manifest
  would then answer for its first part, which is a partial answer presented as complete.
- **Shard the manifest at publication, or index it in D1 or KV.** The right end state and
  a pipeline change across the Actions repository and every published version; left as
  the follow-up.
- **Stream `manifest.json` out as it scans.** Keeps every entry servable, but a manifest
  found malformed at its end could no longer be answered with the 404 it gets today once
  a 200 was sent. Not ruled out; not needed to stop the isolate dying.

## Receipts

- Issue #1502; `backend/src/services/manifest-scan.ts`, `manifest-queries.ts`,
  `manifest-source.ts`, `backend/src/routes/data.ts`
- ADR 0066 (the manifest is the capability list; cache keys never content-addressed across
  datasets), ADR 0050 (no WebAssembly: the scanner is plain JavaScript)
- Guards: `backend/test/manifest-scan.test.ts`, `manifest-queries.test.ts`,
  `manifest-source.test.ts`, `data-route-manifest-stream.test.ts`
- The 2026-09-28 amendment (the trust window and the answer memo) is #1494 (staging
  measurement) and its placement/window follow-up PR. Guards: new describe blocks in
  `backend/test/manifest-source.test.ts` ("the trust window (#1494 amendment)" and "the
  per-isolate answer memo (#1494 amendment)"), `backend/test/manifest-answer-memo.test.ts`
  (the LRU and byte cap in isolation), and a "the trust window and answer memo at the route"
  describe block in `backend/test/data-route-manifest-stream.test.ts`, including the gate
  test named above. `backend/src/services/manifest-answer-memo.ts` is the new module; the
  placement change itself lives in `backend/wrangler-sccn.toml`'s `[placement]` /
  `[env.dev.placement]` blocks, with no ADR of its own (a Wrangler config knob, reversed by
  deleting it, rather than a decision that closes off another path).
- The `manifest.json` response cache's freshness check (ADR 0074) routed through this window,
  in the rebase that reconciled #1494's amendment with #1529 (ADR 0074): guards are in
  `data-route-manifest-stream.test.ts`'s "the manifest.json response cache sits behind the
  visibility gate" describe block ("a hit within the window makes zero S3 calls", "a hit past
  the window still costs exactly one conditional GET", "a manifest rewrite invalidates the
  cached document only once the window passes").
