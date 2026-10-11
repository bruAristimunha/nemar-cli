/**
 * git-annex key size and chunk-aware presence, one definition shared by the CLI
 * (`src/lib/s3-server-copy.ts`) and the Worker
 * (`backend/src/services/import-integrity.ts`), which both re-export it. Pure on
 * purpose: no `node:` import, so the Workers bundle can take it.
 *
 * KEY GRAMMAR. A key is `<fields>--<name>`, split at the FIRST `--`:
 *
 *   fields = BACKEND[-s<size>][-m<mtime>][-S<chunksize>-C<chunknumber>]
 *
 * A special remote configured with `chunk=<size>` stores each piece of a file as
 * `<fields>-S<chunksize>-C<n>--<name>` (n counts from 1) and never the plain key.
 * `scripts/zarr/generate_zarr.py` implements the same grammar; each function names
 * its twin.
 *
 * PRESENCE. A key is present when its plain object exists at the declared size,
 * or, only when the plain object is ABSENT, when some chunking of it is complete
 * (ADR 0064, amendment 2026-10-07). "Present" means recoverable by reassembling
 * the chunks. The data plane uses the same geometry to serve those bytes (#1565).
 */

type KeyParts = { fields: string; name: string };

/** The fields and name of a key, split at the first `--`; null when there is none. */
function splitKey(key: string): KeyParts | null {
  const sep = key.indexOf("--");
  if (sep < 0) return null;
  return { fields: key.slice(0, sep), name: key.slice(sep + 2) };
}

/**
 * Declared size (bytes) encoded in a git-annex key, e.g.
 * `SHA256E-s10565888--abc123.edf` -> 10565888. Works for any backend that
 * encodes size this way (SHA256E, MD5E, SHA1E, ...). Returns null for
 * non-annex keys (`git:<sha>`, in-tree git blobs) or anything that doesn't
 * match the pattern, so callers can tell "no declared size" apart from "0
 * bytes claimed" -- load-bearing for the copy-integrity checks, which must not
 * silently accept an empty object as correct.
 *
 * This is the historical contract for a PLAIN key and is deliberately unchanged.
 * A simple key with an `-m<mtime>` field (`WORM-s5-m17--x`) returns null here, so
 * a plain WORM object stays present-if-listed. The scan covers the whole key,
 * though, so a `-sN--` inside a free-text name is read as a size:
 * `WORM-s5-m17--a-s9--b` gives 9 here and 5 from {@link annexKeyFieldSize}. That
 * is a documented pre-existing exception, pinned by a test and not changed here.
 */
export function annexKeyDeclaredSize(key: string): number | null {
  const match = key.match(/-s(\d+)--/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** The `-s<size>` field of a key's fields, tolerant of a following `-m<mtime>`. */
function sizeOfFields(fields: string): number | null {
  const match = fields.match(/-s(\d+)(?=-|$)/);
  if (!match) return null;
  const size = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(size) ? size : null;
}

/**
 * The `-s<size>` field of a key, read from the fields before the first `--` and
 * tolerant of a following `-m<mtime>` (`WORM-s5-m17--x` -> 5). The twin of
 * `annex_key_size` in `scripts/zarr/generate_zarr.py`. Null when the key has no
 * `--` or no size field. Used for chunk geometry, where the size has to be known
 * to know how many chunks to expect.
 */
export function annexKeyFieldSize(key: string): number | null {
  const parts = splitKey(key);
  return parts ? sizeOfFields(parts.fields) : null;
}

/**
 * True when `key` is present in `existing` (a key -> byte-size map from the S3
 * listing) at its correct size.
 *
 * A plain object decides the answer whenever it exists: an annex key's declared
 * size must match exactly, so a 0-byte or truncated object counts as absent even
 * though the key exists (the #967 bug: a failed curl fallback used to leave a
 * valid-looking 0-byte PUT behind). A non-annex `git:` key has no declared size,
 * so presence alone is sufficient (its bytes live in GitHub, not S3).
 *
 * Chunks are consulted ONLY when the plain object is ABSENT, for content uploaded
 * through a chunked special remote (nm000276, #1565): present when a chunking of
 * it is complete (see isChunkedKeyPresent). A plain object that exists at the
 * wrong size stays missing even beside a complete chunk set. The data plane
 * also checks the plain object's exact size before redirecting; only an absent
 * plain object can be served from chunks.
 */
export function isKeyPresentAtDeclaredSize(key: string, existing: Map<string, number>): boolean {
  const actual = existing.get(key);
  if (actual !== undefined) {
    const declared = annexKeyDeclaredSize(key);
    return declared === null || actual === declared;
  }
  return isChunkedKeyPresent(key, existing);
}

/** A chunk object name split into the whole-file key it belongs to. */
interface ParsedChunkKey {
  baseKey: string;
  chunkSize: number;
  chunkNumber: number;
}

/**
 * Chunk object name -> its whole-file key, chunk size and chunk number.
 * `SHA256E-s982-S1073741824-C1--ba3d.vhdr` -> base `SHA256E-s982--ba3d.vhdr`,
 * chunk size 1073741824, chunk 1 (nm000276, #1565). The `-S<chunksize>-C<n>` pair
 * must be the LAST thing in the fields, before the first `--`, as the special
 * remote writes it; the same text inside the free-text name is not a chunk.
 * Returns null for anything that is not a chunk name, including a zero or
 * unsafe-integer size or number.
 */
export function parseChunkKey(name: string): ParsedChunkKey | null {
  const parts = splitKey(name);
  if (!parts) return null;
  const match = parts.fields.match(/^(.+)-S(\d+)-C(\d+)$/);
  if (!match) return null;
  const chunkSize = Number.parseInt(match[2], 10);
  const chunkNumber = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) return null;
  if (!Number.isSafeInteger(chunkNumber) || chunkNumber < 1) return null;
  return { baseKey: `${match[1]}--${parts.name}`, chunkSize, chunkNumber };
}

/** One verified member of a complete chunk set, in whole-file byte coordinates. */
export interface AnnexChunkPart {
  name: string;
  number: number;
  offset: number;
  size: number;
}

/** A complete, size-verified chunking of one annex key. */
export interface AnnexChunkSet {
  chunkSize: number;
  totalSize: number;
  chunks: AnnexChunkPart[];
}

/**
 * The narrow S3 prefix that contains chunk objects for `key`, or null when the
 * key has no declared size. Chunk sizes vary by upload, so the prefix stops at
 * `-S` and callers must still parse each listed name and match its base key.
 */
export function annexChunkObjectPrefix(key: string): string | null {
  const parts = splitKey(key);
  if (!parts || sizeOfFields(parts.fields) === null) return null;
  return `${parts.fields}-S`;
}

/** The name chunk `chunkNumber` of a split key is stored under: `annex_chunk_key`. */
function chunkObjectName(parts: KeyParts, chunkSize: number, chunkNumber: number): string {
  return `${parts.fields}-S${chunkSize}-C${chunkNumber}--${parts.name}`;
}

/** The index of one listing, keyed by the Map itself; see {@link firstChunksIn}. */
const firstChunksCache = new WeakMap<
  Map<string, number>,
  { listingSize: number; chunkSizesByKey: ReadonlyMap<string, ReadonlySet<number>> }
>();

/**
 * The chunk sizes each chunked file in a listing was stored at, read off its C1
 * objects: whole-file key -> chunk sizes.
 *
 * Only C1 is indexed. A complete chunking always contains C1, so a key with no C1
 * object cannot be complete at any size, and a key is only ever tried at the sizes
 * its OWN C1 objects carry. That bounds the work for a key by the chunkings of
 * that one file, not by how many distinct chunk sizes the bucket holds anywhere.
 * The distinction matters because anyone who can write under `<id>/objects/` can
 * mint any number of `-S<n>-C1--x` names; trying every size in the listing for
 * every missing key would let them multiply the cost of the integrity sweep.
 * Memory is one entry per chunked file, not per chunk.
 *
 * The scan is lazy, so a dataset whose every key is present as a plain object
 * never pays for it, and it runs once per listing: the cache is keyed by the Map's
 * identity and revalidated by its size, so a listing that grows or shrinks is
 * rescanned. An edit that leaves the size unchanged (one name deleted, one added)
 * keeps a stale index. That can only make a key read as missing, never present:
 * the index only nominates chunk sizes to try, and every chunk is then looked up
 * in the live Map. No caller mutates a listing after its first lookup.
 */
function firstChunksIn(existing: Map<string, number>): ReadonlyMap<string, ReadonlySet<number>> {
  const cached = firstChunksCache.get(existing);
  if (cached && cached.listingSize === existing.size) return cached.chunkSizesByKey;
  const chunkSizesByKey = new Map<string, Set<number>>();
  for (const name of existing.keys()) {
    const parsed = parseChunkKey(name);
    if (!parsed || parsed.chunkNumber !== 1) continue;
    const sizes = chunkSizesByKey.get(parsed.baseKey);
    if (sizes) sizes.add(parsed.chunkSize);
    else chunkSizesByKey.set(parsed.baseKey, new Set([parsed.chunkSize]));
  }
  firstChunksCache.set(existing, { listingSize: existing.size, chunkSizesByKey });
  return chunkSizesByKey;
}

/**
 * The complete chunking of `key` in `existing`, if one exists. A listing can hold
 * more than one chunking of a key (a partial attempt at one chunk size and a
 * finished upload at another), so every chunk size the key's own C1 objects carry
 * is tried. The largest complete chunk size is preferred because it needs the
 * fewest object requests when streamed. `maxChunks` lets a serving caller refuse
 * a complete set whose sequential request count exceeds its bounded budget; the
 * integrity checker leaves it unset and retains its historical behavior.
 */
export function findCompleteChunkSet(
  key: string,
  existing: Map<string, number>,
  maxChunks = Number.MAX_SAFE_INTEGER,
): AnnexChunkSet | null {
  const parts = splitKey(key);
  if (!parts) return null;
  const declared = sizeOfFields(parts.fields);
  if (declared === null) return null;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) return null;
  const chunkSizes = firstChunksIn(existing).get(key);
  if (!chunkSizes) return null;
  const orderedSizes = [...chunkSizes].sort((a, b) => b - a);
  for (const chunkSize of orderedSizes) {
    const count = declared === 0 ? 1 : Math.ceil(declared / chunkSize);
    if (count > maxChunks) continue;
    const chunks: AnnexChunkPart[] = [];
    let offset = 0;
    let complete = true;
    for (let i = 1; i <= count; i++) {
      const size = i < count ? chunkSize : declared - (count - 1) * chunkSize;
      const name = chunkObjectName(parts, chunkSize, i);
      if (existing.get(name) !== size) {
        complete = false;
        break;
      }
      chunks.push({ name, number: i, offset, size });
      offset += size;
    }
    if (complete && offset === declared) {
      return { chunkSize, totalSize: declared, chunks };
    }
  }
  return null;
}

function isChunkedKeyPresent(key: string, existing: Map<string, number>): boolean {
  return findCompleteChunkSet(key, existing) !== null;
}
