/**
 * A real local HTTP server standing in for the S3 bucket's manifest objects
 * (#1502), reached through `S3_ENDPOINT_URL` / `PresignedUrlOptions.endpointUrl`,
 * the origin override the git-broker and zarr suites already use.
 *
 * It implements the S3 behaviors the manifest source, the bucket-policy
 * reader and the public-object URL builder depend on, and nothing else:
 *
 *  - a content-derived `ETag` on every object (S3's is an MD5; this is a
 *    SHA-256, which is just as content-derived and needs no extra import),
 *    so rewriting an object changes its ETag exactly as it does on S3;
 *  - `If-None-Match` answered with a bodiless 304 when the ETag matches;
 *  - a "private" object refused with 403 unless the request is signed
 *    (carries an `Authorization` header), which is the shape that sends
 *    `fetchManifestObject` to its signed fallback;
 *  - a single `Range: bytes=a-b` / `bytes=a-` / `bytes=-N` request answered
 *    with a real `206` + `Content-Range` (#1522's public-URL compatibility
 *    test needs this; the manifest reads never send Range, so this is inert
 *    for every existing use of this stand-in);
 *  - `GET /?policy` answers whatever `setBucketPolicy` last set, mirroring
 *    `getBucketPolicy`'s target (`?policy` on the bucket root, not a keyed
 *    object) -- `null` (the default) answers 404, the same as an S3 bucket
 *    with no policy attached.
 *
 * Every request is logged with the headers that matter, so a test asserts
 * on what was actually sent and answered rather than on what the code under
 * test says it did.
 */

import type { Server } from "bun";

function parseSingleRange(header: string, length: number): { start: number; end: number } | null {
  const single = /^bytes=(?:(\d+)-(\d+)|(\d+)-|-(\d+))$/.exec(header);
  if (!single) return null;
  let start: number;
  let end: number;
  if (single[4] !== undefined) {
    const n = Number(single[4]);
    start = Math.max(0, length - n);
    end = length - 1;
  } else if (single[3] !== undefined) {
    start = Number(single[3]);
    end = length - 1;
  } else {
    start = Number(single[1]);
    end = Number(single[2]);
  }
  if (start >= length || start > end) return null;
  return { start, end: Math.min(end, length - 1) };
}

export interface StandinObject {
  body: Uint8Array;
  etag: string;
  private: boolean;
  /** Serve the body as a stream that errors after this many bytes. */
  breakAfter?: number;
}

export interface StandinRequest {
  method: string;
  path: string;
  ifNoneMatch: string | null;
  signed: boolean;
  status: number;
  /** Body bytes this server sent for the request. */
  bytesSent: number;
}

export interface S3ManifestStandin {
  url: string;
  log: StandinRequest[];
  /** Store (or overwrite) an object at `path`, e.g. `/nm000132/version/v1.1.1.json`. */
  put(
    path: string,
    body: string | Uint8Array,
    opts?: { private?: boolean; breakAfter?: number },
  ): string;
  remove(path: string): void;
  objects: Map<string, StandinObject>;
  /** Set (or, with `null`, clear) the document `GET /?policy` answers.
   *  Cleared (the default) answers 404, mirroring a bucket with no policy
   *  attached. Takes the parsed object, not a JSON string, so a test builds
   *  it with `buildPublicAccessPolicy`/`addPrivateDataset` the same way
   *  production code does. */
  setBucketPolicy(policy: unknown | null): void;
  stop(): void;
}

function etagFor(body: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  return `"${hasher.digest("hex")}"`;
}

export function startS3ManifestStandin(): S3ManifestStandin {
  const objects = new Map<string, StandinObject>();
  const log: StandinRequest[] = [];
  let bucketPolicy: string | null = null;

  const server: Server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      const ifNoneMatch = req.headers.get("if-none-match");
      const signed = req.headers.has("authorization");
      const entry: StandinRequest = {
        method: req.method,
        path,
        ifNoneMatch,
        signed,
        status: 0,
        bytesSent: 0,
      };
      log.push(entry);

      // GET /?policy is not a keyed object: `getBucketPolicy` always reads
      // the bucket root's policy sub-resource, never a path under it.
      if (path === "/" && url.searchParams.has("policy")) {
        if (bucketPolicy === null) {
          entry.status = 404;
          return new Response("<Error><Code>NoSuchBucketPolicy</Code></Error>", { status: 404 });
        }
        entry.status = 200;
        entry.bytesSent = bucketPolicy.length;
        return new Response(bucketPolicy, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const obj = objects.get(path);
      if (!obj) {
        entry.status = 404;
        return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      }
      if (obj.private && !signed) {
        entry.status = 403;
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      }
      if (ifNoneMatch !== null && ifNoneMatch === obj.etag) {
        entry.status = 304;
        return new Response(null, { status: 304, headers: { ETag: obj.etag } });
      }
      const range = req.headers.get("range");
      if (range && obj.breakAfter === undefined) {
        const parsed = parseSingleRange(range, obj.body.length);
        if (!parsed) {
          entry.status = 416;
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${obj.body.length}` },
          });
        }
        const { start, end } = parsed;
        const slice = obj.body.slice(start, end + 1);
        entry.status = 206;
        entry.bytesSent = slice.length;
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 206,
            headers: {
              ETag: obj.etag,
              "Content-Length": String(slice.length),
              "Content-Range": `bytes ${start}-${end}/${obj.body.length}`,
            },
          });
        }
        return new Response(slice, {
          status: 206,
          headers: {
            ETag: obj.etag,
            "Content-Length": String(slice.length),
            "Content-Range": `bytes ${start}-${end}/${obj.body.length}`,
            "Content-Type": "application/octet-stream",
          },
        });
      }
      entry.status = 200;
      const headers = {
        ETag: obj.etag,
        "Content-Length": String(obj.body.length),
        "Content-Type": "application/json",
      };
      if (req.method === "HEAD") return new Response(null, { status: 200, headers });
      if (obj.breakAfter !== undefined) {
        const cut = obj.body.slice(0, obj.breakAfter);
        entry.bytesSent = cut.length;
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(cut);
              await Bun.sleep(5);
              controller.error(new Error("upstream reset"));
            },
          }),
          { status: 200, headers },
        );
      }
      entry.bytesSent = obj.body.length;
      return new Response(obj.body, {
        status: 200,
        headers: { ...headers, "Content-Length": String(obj.body.length) },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    log,
    objects,
    setBucketPolicy(policy) {
      bucketPolicy = policy === null ? null : JSON.stringify(policy);
    },
    put(path, body, opts) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const etag = etagFor(bytes);
      objects.set(path, {
        body: bytes,
        etag,
        private: opts?.private ?? false,
        breakAfter: opts?.breakAfter,
      });
      return etag;
    },
    remove(path) {
      objects.delete(path);
    },
    stop() {
      server.stop(true);
    },
  };
}
