/**
 * A per-isolate memo of a manifest query's FINISHED answer (#1494 placement/
 * trust-window follow-up to #1502/ADR 0072).
 *
 * WHY THIS EXISTS. ADR 0072's stream-and-revalidate design bounds a manifest
 * read's MEMORY (proportional to the answer, never the document), but every
 * read still tokenizes the whole body: about 45ms per 40MB under Bun, about
 * 140ms per 43MB under local workerd (ADR 0072's own "Consequences"
 * measurement). A warm isolate serving the same hot file or directory
 * repeatedly -- the common case for an `rclone sync` or a notebook that reads
 * `participants.tsv` before every subject -- paid that scan cost on every
 * single request, even once the trust window (`manifest-source.ts`) had
 * already made the S3 round trip unnecessary. This memo removes the SCAN too,
 * for a query this isolate has already answered.
 *
 * WHAT IS KEYED. `(datasetId, version, manifest ETag, a caller-supplied
 * description of the query)` -- the ETag is what makes a manifest rewrite
 * (ADR 0072: the pipeline regenerates manifests in place) safe to memoize
 * across: a rewrite gets a new ETag, which is a different key, so a stale
 * answer is never returned; it just ages out of the LRU once nothing asks for
 * the old ETag's entries again. This is the same safety property
 * `gitFileCacheKey` and `manifestCacheKey` already rely on for their own
 * synthetic keys (dataset- and version-scoped, never content alone), applied
 * one level up: the manifest's own content identity, not just its location.
 *
 * BOUNDED HOW, AND WHY THAT NUMBER. An LRU with a total byte cap
 * ({@link MANIFEST_ANSWER_MEMO_CAP_BYTES}), estimated via `JSON.stringify`
 * (every answer type in `manifest-queries.ts` is a plain, non-circular,
 * JSON-safe object). The cap is 4 MiB: a resolved file or directory answer is
 * a few hundred bytes, so this holds many thousands of them, while staying
 * under 4% of the 128 MB isolate budget nm000281's 43 MB manifest already
 * pushes hard on (#1502) -- an isolate juggling several concurrent scans of a
 * large manifest must not ALSO be carrying a memo sized like another one. A
 * single entry may use at most half the cap: `manifest.json`'s own answer
 * (`EntriesQuery`) is capped at 38,000 entries for every dataset
 * (`MAX_MANIFEST_JSON_ENTRIES`, `routes/data.ts`) because all URLs use the
 * same compact, stable data-plane route. That bound is
 * large enough that memoizing the answer whole could otherwise evict every
 * small, hot per-file entry this memo mainly exists for; past that fraction,
 * the answer is still returned to the caller, it is just not remembered.
 */

/** Answers larger than this are not memoized at all: see the module comment. */
export const MANIFEST_ANSWER_MEMO_CAP_BYTES = 4 * 1024 * 1024;

/** No single entry may claim more than this fraction of the cap. */
const MAX_SINGLE_ENTRY_FRACTION = 0.5;

interface MemoEntry {
  value: unknown;
  bytes: number;
}

/** Rough serialized size. `Map` iteration order is insertion order in
 *  JavaScript, so re-inserting an accessed key on `get` is enough to make
 *  this a real LRU without a second data structure. */
export class ManifestAnswerMemo {
  private readonly store = new Map<string, MemoEntry>();
  private bytes = 0;

  constructor(private readonly capBytes: number = MANIFEST_ANSWER_MEMO_CAP_BYTES) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set(key: string, value: unknown): void {
    const bytes = estimateBytes(value);
    if (bytes > this.capBytes * MAX_SINGLE_ENTRY_FRACTION) return;
    const existing = this.store.get(key);
    if (existing) {
      this.bytes -= existing.bytes;
      this.store.delete(key);
    }
    while (this.bytes + bytes > this.capBytes && this.store.size > 0) {
      const oldestKey = this.store.keys().next().value as string;
      const oldest = this.store.get(oldestKey);
      this.store.delete(oldestKey);
      if (oldest) this.bytes -= oldest.bytes;
    }
    this.store.set(key, { value, bytes });
    this.bytes += bytes;
  }

  clear(): void {
    this.store.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.store.size;
  }

  get byteSize(): number {
    return this.bytes;
  }
}

function estimateBytes(value: unknown): number {
  try {
    // Rough but conservative: UTF-16 code units, not the (smaller) UTF-8 byte
    // count, plus a fixed overhead for the Map entry itself.
    return JSON.stringify(value).length * 2 + 64;
  } catch (err) {
    // A value that cannot be serialized (should not happen for anything
    // `manifest-queries.ts` produces) is never memoized rather than sized
    // wrong. Logged because "should not happen" is exactly the case worth
    // knowing about if it ever does.
    console.warn(
      "[manifest-answer-memo] estimateBytes failed to serialize a value; skipping memoization:",
      err instanceof Error ? err.message : String(err),
    );
    return Number.POSITIVE_INFINITY;
  }
}
