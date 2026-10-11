import {
  annexChunkObjectPrefix,
  annexKeyFieldSize,
  findCompleteChunkSet,
  parseChunkKey,
} from "../../../shared/annex-key.js";
import type { ManifestFile } from "./manifest.js";
import { type PresignedUrlOptions, fetchS3Object, listObjectSizesBounded } from "./s3.js";

export const MAX_SERVABLE_CHUNKS = 512;
export const CHUNK_GET_BUDGET_HEADER = "x-nemar-chunk-get-budget";
export const CHUNK_GETS_USED_HEADER = "x-nemar-chunk-gets-used";

export type AnnexDelivery =
  | { kind: "plain" }
  | { kind: "missing" }
  | { kind: "unavailable"; status: 502 | 503; reason: string }
  | {
      kind: "streamed";
      body: ReadableStream<Uint8Array>;
      status: 200 | 206 | 416;
      contentLength: number;
      chunkGetRequests: number;
      contentRange?: string;
    };

interface ByteRange {
  start: number;
  end: number;
}

interface ChunkSpan {
  key: string;
  range: string | null;
  expectedBytes: number;
  contentRange: string | null;
}

type ParsedRange =
  | { kind: "full" }
  | { kind: "range"; range: ByteRange }
  | { kind: "unsatisfiable" };

/**
 * Resolve an annex object only after the caller has passed dataset visibility,
 * published-version and manifest-path checks. A correctly sized plain object
 * keeps the existing redirect behavior. Only a definitive HEAD 404 permits a
 * bounded chunk listing; wrong-sized objects and uncertain S3 answers fail
 * closed instead of being hidden by a second representation.
 */
export async function resolveAnnexDelivery(args: {
  options: PresignedUrlOptions;
  datasetId: string;
  file: ManifestFile;
  rangeHeader: string | null;
  ifRange: string | null;
  etag: string;
  lastModified: string;
  /** Optional cap shared across several file requests made by one caller. */
  maxChunkGetRequests?: number;
}): Promise<AnnexDelivery> {
  const { options, datasetId, file } = args;
  const objectPrefix = `${datasetId}/objects/`;
  const plainKey = `${objectPrefix}${file.key}`;
  const keySize = annexKeyFieldSize(file.key);
  if (keySize === null || keySize !== file.size) {
    return { kind: "unavailable", status: 502, reason: "manifest size does not match annex key" };
  }

  let plain: Response;
  try {
    plain = await fetchS3Object(options, plainKey, { method: "HEAD" });
  } catch (error) {
    return { kind: "unavailable", status: 503, reason: errorMessage(error) };
  }
  if (plain.status === 404) {
    await plain.body?.cancel().catch(() => {});
  } else if (plain.status !== 200) {
    await plain.body?.cancel().catch(() => {});
    return {
      kind: "unavailable",
      status: 503,
      reason: `plain object HEAD returned HTTP ${plain.status}`,
    };
  } else {
    const size = parseContentLength(plain.headers.get("Content-Length"));
    if (size !== file.size) {
      return {
        kind: "unavailable",
        status: 502,
        reason: `plain object size ${size ?? "unknown"} does not match manifest size ${file.size}`,
      };
    }

    const honorsRange = shouldHonorRange(args.ifRange, args.etag, args.lastModified);
    const range = honorsRange
      ? parseByteRange(args.rangeHeader, file.size)
      : { kind: "full" as const };
    if (range.kind === "unsatisfiable") {
      return {
        kind: "streamed",
        body: emptyBody(),
        status: 416,
        contentLength: 0,
        chunkGetRequests: 0,
        contentRange: `bytes */${file.size}`,
      };
    }
    if (!args.rangeHeader || range.kind === "range") return { kind: "plain" };

    // S3 GET accepts Range but does not implement our If-Range and unsupported
    // multi-range policy. Ignore those Range forms here and return a complete
    // body through this route, so the redirected client cannot receive a
    // partial S3 response when the contract requires a full response.
    let full: Response;
    try {
      full = await fetchS3Object(options, plainKey, { method: "GET" });
    } catch (error) {
      return { kind: "unavailable", status: 503, reason: errorMessage(error) };
    }
    if (full.status !== 200) {
      await full.body?.cancel().catch(() => {});
      return {
        kind: "unavailable",
        status: full.status === 404 ? 502 : 503,
        reason: `plain object GET returned HTTP ${full.status}`,
      };
    }
    const getSize = parseContentLength(full.headers.get("Content-Length"));
    if (getSize !== null && getSize !== file.size) {
      await full.body?.cancel().catch(() => {});
      return {
        kind: "unavailable",
        status: 502,
        reason: `plain object GET size ${getSize} does not match manifest size ${file.size}`,
      };
    }
    if (!full.body) {
      return { kind: "unavailable", status: 503, reason: "plain object GET returned no body" };
    }
    return {
      kind: "streamed",
      body: exactSizeBody(full.body, file.size, `dataset=${datasetId} key=${file.key}`),
      status: 200,
      contentLength: file.size,
      chunkGetRequests: 0,
    };
  }

  const relativePrefix = annexChunkObjectPrefix(file.key);
  if (!relativePrefix) {
    return { kind: "unavailable", status: 502, reason: "annex key has no usable chunk prefix" };
  }

  let listing: Awaited<ReturnType<typeof listObjectSizesBounded>>;
  try {
    listing = await listObjectSizesBounded(options, `${objectPrefix}${relativePrefix}`);
  } catch (error) {
    return { kind: "unavailable", status: 503, reason: errorMessage(error) };
  }
  if (!listing.complete) {
    return {
      kind: "unavailable",
      status: 503,
      reason: "chunk listing exceeded its bounded page or object limit",
    };
  }

  const relativeSizes = new Map<string, number>();
  for (const [key, size] of listing.sizes) {
    if (!key.startsWith(objectPrefix)) continue;
    const name = key.slice(objectPrefix.length);
    const parsed = parseChunkKey(name);
    if (parsed?.baseKey === file.key) relativeSizes.set(name, size);
  }
  if (relativeSizes.size === 0) return { kind: "missing" };

  const chunkSet = findCompleteChunkSet(file.key, relativeSizes, MAX_SERVABLE_CHUNKS);
  if (!chunkSet || chunkSet.totalSize !== file.size) {
    return {
      kind: "unavailable",
      status: 502,
      reason: "chunk set is incomplete or exceeds the serving limit",
    };
  }

  const range = shouldHonorRange(args.ifRange, args.etag, args.lastModified)
    ? parseByteRange(args.rangeHeader, file.size)
    : { kind: "full" as const };
  if (range.kind === "unsatisfiable") {
    return {
      kind: "streamed",
      body: emptyBody(),
      status: 416,
      contentLength: 0,
      chunkGetRequests: 0,
      contentRange: `bytes */${file.size}`,
    };
  }

  const selectedRange = range.kind === "range" ? range.range : null;
  const spans = chunkSet.chunks.flatMap((chunk): ChunkSpan[] => {
    const chunkEnd = chunk.offset + chunk.size - 1;
    if (selectedRange && (chunkEnd < selectedRange.start || chunk.offset > selectedRange.end)) {
      return [];
    }
    if (!selectedRange) {
      return [
        {
          key: `${objectPrefix}${chunk.name}`,
          range: null,
          expectedBytes: chunk.size,
          contentRange: null,
        },
      ];
    }
    const overlapStart = Math.max(chunk.offset, selectedRange.start);
    const overlapEnd = Math.min(chunkEnd, selectedRange.end);
    const localStart = overlapStart - chunk.offset;
    const localEnd = overlapEnd - chunk.offset;
    return [
      {
        key: `${objectPrefix}${chunk.name}`,
        range: `bytes=${localStart}-${localEnd}`,
        expectedBytes: overlapEnd - overlapStart + 1,
        contentRange: `bytes ${localStart}-${localEnd}/${chunk.size}`,
      },
    ];
  });

  const contentLength = selectedRange ? selectedRange.end - selectedRange.start + 1 : file.size;
  if (spans.length === 0) {
    return {
      kind: "streamed",
      body: emptyBody(),
      status: selectedRange ? 206 : 200,
      contentLength,
      chunkGetRequests: 0,
      ...(selectedRange
        ? { contentRange: `bytes ${selectedRange.start}-${selectedRange.end}/${file.size}` }
        : {}),
    };
  }

  const chunkGetLimit = Math.min(
    MAX_SERVABLE_CHUNKS,
    args.maxChunkGetRequests ?? MAX_SERVABLE_CHUNKS,
  );
  if (!Number.isSafeInteger(chunkGetLimit) || chunkGetLimit < 0 || spans.length > chunkGetLimit) {
    return {
      kind: "unavailable",
      status: 503,
      reason: "chunk stream exceeds the caller's remaining request budget",
    };
  }

  let first: Response;
  try {
    first = await fetchChunk(options, spans[0] as ChunkSpan);
  } catch (error) {
    return { kind: "unavailable", status: 503, reason: errorMessage(error) };
  }
  const firstSpan = spans[0] as ChunkSpan;
  const firstError = validateChunkResponse(first, firstSpan);
  if (firstError) {
    await first.body?.cancel().catch(() => {});
    return { kind: "unavailable", status: 503, reason: firstError };
  }
  if (!first.body) {
    return { kind: "unavailable", status: 503, reason: "chunk GET returned no response body" };
  }

  const body = sequentialChunkBody({
    options,
    spans,
    first,
    datasetId,
    fileKey: file.key,
  });
  return {
    kind: "streamed",
    body,
    status: selectedRange ? 206 : 200,
    contentLength,
    chunkGetRequests: spans.length,
    ...(selectedRange
      ? { contentRange: `bytes ${selectedRange.start}-${selectedRange.end}/${file.size}` }
      : {}),
  };
}

function parseContentLength(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const size = Number(raw);
  return Number.isSafeInteger(size) ? size : null;
}

function shouldHonorRange(ifRange: string | null, etag: string, lastModified: string): boolean {
  if (!ifRange) return true;
  if (ifRange === etag) return true;
  const conditionDate = Date.parse(ifRange);
  const modifiedDate = Date.parse(lastModified);
  return (
    Number.isFinite(conditionDate) && Number.isFinite(modifiedDate) && modifiedDate <= conditionDate
  );
}

function parseByteRange(raw: string | null, size: number): ParsedRange {
  if (!raw) return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw.trim());
  if (!match || (match[1] === "" && match[2] === "")) return { kind: "full" };
  const [, startRaw, endRaw] = match;
  const total = BigInt(size);
  if (!startRaw) {
    const suffix = BigInt(endRaw as string);
    if (suffix === 0n || size === 0) return { kind: "unsatisfiable" };
    const start = suffix >= total ? 0 : Number(total - suffix);
    return { kind: "range", range: { start, end: size - 1 } };
  }
  const start = BigInt(startRaw);
  if (start >= total || size === 0) return { kind: "unsatisfiable" };
  const requestedEnd = endRaw ? BigInt(endRaw) : total - 1n;
  if (requestedEnd < start) return { kind: "unsatisfiable" };
  return {
    kind: "range",
    range: { start: Number(start), end: Number(requestedEnd >= total ? total - 1n : requestedEnd) },
  };
}

async function fetchChunk(options: PresignedUrlOptions, span: ChunkSpan): Promise<Response> {
  return fetchS3Object(options, span.key, {
    method: "GET",
    ...(span.range ? { range: span.range } : {}),
  });
}

function validateChunkResponse(response: Response, span: ChunkSpan): string | null {
  const expectedStatus = span.range ? 206 : 200;
  if (response.status !== expectedStatus) {
    return `chunk GET returned HTTP ${response.status}, expected ${expectedStatus}`;
  }
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && parseContentLength(contentLength) !== span.expectedBytes) {
    return "chunk GET Content-Length does not match the requested bytes";
  }
  if (span.contentRange && response.headers.get("Content-Range") !== span.contentRange) {
    return "chunk GET Content-Range does not match the requested slice";
  }
  return null;
}

function sequentialChunkBody(args: {
  options: PresignedUrlOptions;
  spans: ChunkSpan[];
  first: Response;
  datasetId: string;
  fileKey: string;
}): ReadableStream<Uint8Array> {
  const { options, spans, first, datasetId, fileKey } = args;
  let index = 0;
  let response: Response | null = first;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = first.body?.getReader() ?? null;
  let seen = 0;
  const describe = () => `dataset=${datasetId} key=${fileKey} chunk=${index + 1}/${spans.length}`;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (!reader) {
            if (index >= spans.length) {
              controller.close();
              return;
            }
            const span = spans[index] as ChunkSpan;
            response = await fetchChunk(options, span);
            const invalid = validateChunkResponse(response, span);
            if (invalid) {
              await response.body?.cancel().catch(() => {});
              throw new Error(invalid);
            }
            if (!response.body) throw new Error("chunk GET returned no response body");
            reader = response.body.getReader();
          }

          const { done, value } = await reader.read();
          const span = spans[index] as ChunkSpan;
          if (!done) {
            if (!value) continue;
            seen += value.byteLength;
            if (seen > span.expectedBytes)
              throw new Error("chunk response exceeded expected bytes");
            controller.enqueue(value);
            return;
          }

          if (seen !== span.expectedBytes)
            throw new Error("chunk response ended before expected bytes");
          reader.releaseLock();
          reader = null;
          response = null;
          seen = 0;
          index++;
          if (index >= spans.length) {
            controller.close();
            return;
          }
        }
      } catch (error) {
        console.error(`[data] chunk stream failed ${describe()}: ${errorMessage(error)}`);
        await reader?.cancel(error).catch(() => {});
        reader?.releaseLock();
        reader = null;
        await response?.body?.cancel(error).catch(() => {});
        response = null;
        controller.error(new Error("Chunked object transfer failed"));
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason).catch(() => {});
      await response?.body?.cancel(reason).catch(() => {});
    },
  });
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function exactSizeBody(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
  context: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (seen !== expectedBytes) throw new Error("plain object ended before expected bytes");
          reader.releaseLock();
          controller.close();
          return;
        }
        if (!value) return;
        seen += value.byteLength;
        if (seen > expectedBytes) throw new Error("plain object exceeded expected bytes");
        controller.enqueue(value);
      } catch (error) {
        console.error(`[data] plain stream failed ${context}: ${errorMessage(error)}`);
        await reader.cancel(error).catch(() => {});
        reader.releaseLock();
        controller.error(new Error("Plain object transfer failed"));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
