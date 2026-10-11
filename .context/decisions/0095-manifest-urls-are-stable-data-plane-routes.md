# ADR 0095: manifest.json URLs are stable data-plane routes

**Status:** accepted
**Date:** 2026-10-09
**Owner:** Seyed Yahya Shirazi

## Context

The first half of #1565 taught the integrity checks to recognize complete
git-annex chunk sets, but a manifest still linked directly to the plain S3 key.
That key does not exist for a chunk-only upload, and excluded datasets received
presigned S3 URLs with a different contract. Manifest construction is cached by
the source manifest ETag, so it cannot safely decide per entry whether to emit a
plain-object or chunk URL without a second availability cache and invalidation
rule. The existing `bytes_url` already names the stable, dataset/version/path
route and keeps its visibility gate ahead of storage access (ADR 0066).

## Decision

Every served `manifest.json` entry sets `url` equal to its stable `bytes_url`,
for git-tracked, plain annex and chunked annex files, regardless of bucket
public-read policy. The per-file route checks the published dataset, version
and manifest path before touching S3; it redirects only after a plain-object
HEAD confirms the exact manifest size, and only a definitive 404 permits a
bounded search for a complete chunk set. A complete chunk set is streamed
sequentially with bounded memory and single-byte-range support. Uncertain,
truncated or inconsistent S3 answers fail closed. HEAD remains metadata-only.

The manifest response remains cached by origin, dataset, version and source
manifest ETag. The internal response-cache key moves to v2 so stored v1
documents containing direct or presigned S3 URLs cannot survive rollout. Its
client cache lifetime is at most 300 seconds, matching
ADR 0066's authorization-staleness bound. The 38,000-entry limit applies to all
datasets because the document no longer creates per-entry signatures. Chunk
availability is resolved on the data-plane request, never while building the
cached manifest.

## Consequences

- A client can persist one manifest URL and fetch either a plain or chunked
  annex object without understanding bucket policy or git-annex layout.
- The Worker takes on a HEAD for a plain annex file and a bounded LIST plus
  sequential GETs for a chunk-only file. Chunk discovery is capped at 512
  objects across at most two pages; hitting the cap or receiving an uncertain
  response fails closed. Plain objects with the wrong size are not rescued by
  chunks.
- Neurobagel reads both participant tables in the same Worker invocation.
  Their chunk GETs share an eight-request allowance; its writer charges a
  conservative 24 HTTP operations per gather inside its existing 400-operation
  run budget so two large chunk responses cannot exhaust the Worker limit.
- A single satisfiable `bytes` range returns 206 with whole-file
  `Content-Range`; an unsatisfiable range returns 416. Unsupported or malformed
  range forms and an `If-Range` mismatch are served as a full response. Plain
  S3 objects are streamed through the route for those cases so the original
  Range header cannot make the redirected S3 response partial. Full and ranged
  streamed responses verify the returned byte count as they stream; an upstream
  failure after response headers have been sent may terminate the body.
- Manifest links no longer carry a short-lived signature. A visibility change
  stops new route reads immediately; downstream cached answers remain bounded
  by 300 seconds. The data-plane route still issues a fresh signed S3 redirect
  for a verified plain object.
- The identifier-fleet scanner's raw-manifest fallback and the scrub runbook
  must use the stable route rather than deriving S3 object keys from `url`.
  EEGDash's CDN/viewer must separately accept the stable route, forward Range
  and CORS behavior, and keep both edge and browser caches within 300 seconds.
- No isolated, non-synthetic chunk-byte sample is currently available. Local
  parser checks and unrelated route regressions do not establish chunk-byte
  acceptance. That acceptance remains open until a safe sample verifies a full
  checksum, within- and cross-chunk ranges, the final short chunk, 416, and
  missing or short chunks.

## Known limits at release (review of 2026-10-10)

None of these blocks the release. Each is a fact a reader of the code would otherwise have to find.

- **`Content-Length` is set by hand on a streamed response.** The repository's own measurements
  (ADR 0066 amendment, `.memory/bun-test-lenient-vs-workerd.md`) say workerd drops a hand-set length
  on a stream body, and only a live test shows it. A chunked 200 or 206 may therefore arrive without a
  length, and completeness then rests on the stream ending cleanly. Serve a real chunked sample from
  staging and read the headers before announcing this.
- **The chunk listing is bounded by prefix, not by file.** It lists `<backend>-s<size>-S`, which every
  chunked file of the same size shares, over two pages of 256 objects. More than 512 chunk objects of one
  file size (one file of more than 512 chunks, or many files of exactly that size) answer 503 for those
  files while the integrity check, which lists without the bound, says they are present. The largest
  recording's chunk count decides whether a dataset is under the bound.
- **Chunk-only bytes pass through the Worker.** There is no single object to redirect to, so
  `.memory/never-proxy-bulk-bytes.md` cannot be followed here, and the delivery is not counted by
  `recordAccess`. It applies only to files whose remote stores `chunk=`.
- **A listed file whose object is gone answers 502** with the error word
  `PUBLISHED_FILE_MISSING_ERROR` (`shared/contract/data-plane.ts`); a git blob GitHub lacks answers the
  same. The CLI's download reads that word by ADR 0005's rule that missing content is reported and never
  blocks the delivery (not retried, not a failed run) and any other 502 as a transport fault. An installed
  CLI older than this release retries it and exits 1.
- **`nemar admin fleet key-registration --apply` uses the same presence test** and so records chunk-only
  keys as held by `nemar-s3`. Do not run it on a chunked dataset until `git annex get` of a chunked key
  is shown to work (ADR 0064 amendment).

## Alternatives considered

- **Keep ADR 0074's public-direct/presigned split and mark chunk-only `url`
  unavailable:** preserves the prior URL contract but leaves known manifest
  consumers unable to fetch files whose plain object is absent.
- **Inspect chunk availability while generating `manifest.json`:** makes the
  response depend on S3 object layout while the response cache is keyed by the
  source manifest ETag, requiring a separate freshness and invalidation
  contract. Resolving storage at request time keeps the manifest deterministic.

## Receipts

- Issues #1565 and #1671; phase plan and cross-pipeline review in
  `.claude/issue-1565.local.md`.
- [ADR 0066](0066-the-data-plane-brokers-git-tracked-files-and-the-manifest-is-the-capability-list.md)
  - visibility gate, dataset-row identity, manifest capability list and
  dataset-scoped cache rules.
- [ADR 0072](0072-the-data-plane-streams-a-manifest-and-revalidates-its-edge-copy.md)
  - source-manifest streaming and ETag-scoped edge-cache validation.
- [ADR 0074](0074-manifest-json-emits-unsigned-public-urls.md) - superseded
  public-direct/presigned `url` contract.
- `.rules/testing.md` and `test_requirements.md` - real chunk-byte acceptance
  requirements and current sample gap.
