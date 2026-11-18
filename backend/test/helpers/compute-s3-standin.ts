/**
 * A real local HTTP server speaking the path-style S3 subset the compute gateway's signer uses
 * (epic #2005 phase A3, #2008; ADR 0118 decision 7), over the SAME Miniflare R2 buckets the Worker's
 * bindings read and write, so a presigned PUT and a binding read share one store.
 *
 * It stands in for Cloudflare R2's S3 interface, which no test can reach: the account endpoint is a
 * secret and the R2 API token is the owner's. Nothing here stands in for NEMAR logic. The code under
 * test signs with aws4fetch against `globalThis.NEMAR_COMPUTE_S3_URL`, and this server answers.
 *
 * WHAT IT SPEAKS: PutObject (a presigned URL or a signed request), GetObject, HeadObject,
 * DeleteObject, CopyObject (`x-amz-copy-source`) and ListObjectsV2, addressed `/<bucket>/<key>` with
 * the key percent-encoded once.
 *
 * WHAT IT CHECKS, so that a signing bug fails here and not in production:
 *  - the SigV4 signature, recomputed with the same library over the request exactly as it arrived,
 *    for a presigned URL (query authentication) and for a header-authenticated request alike. The
 *    key, the secret, the bucket, the path, the method, the signed headers and the date all have to
 *    agree, so a URL whose path was encoded differently from the one that was signed is refused;
 *  - `X-Amz-Expires` is at most 604800 (seven days, the limit of S3 and of R2) and at least 1, and a
 *    presigned URL past its expiry is refused with 403, by the stand-in's own clock (`clock.now`);
 *  - `x-amz-checksum-sha256`, when present on a PUT, must be the base64 of the body's SHA-256, else
 *    400 `BadDigest`. WHETHER R2 ENFORCES THIS HEADER ON A PRESIGNED PUT IS NOT VERIFIED: this server
 *    enforces what S3 documents, and the finding on the real service is the owner's to check;
 *  - `If-None-Match: *` on a PUT: 412 when the key exists.
 *
 * WHAT IT DOES NOT DO: Miniflare does not enforce bucket lock, so an overwrite of a locked object
 * succeeds here and is refused by the real bucket. Lock and lifecycle rules are bucket
 * configuration, never code, and are not tested.
 *
 * Every request is logged, with its operation, bucket, key, status and whether it was presigned, so a
 * test asserts on what was actually sent (one CopyObject, no second). `failWith` makes the next
 * matching request answer an error without touching a bucket.
 */

import { createHash } from "node:crypto";
import { AwsV4Signer } from "aws4fetch";
import type { Server } from "bun";

export const STANDIN_REGION = "auto";
export const STANDIN_MAX_EXPIRES = 604_800;

export type StandinOp =
  | "PutObject"
  | "GetObject"
  | "HeadObject"
  | "DeleteObject"
  | "CopyObject"
  | "ListObjectsV2"
  | "Unknown";

export interface StandinRequest {
  op: StandinOp;
  method: string;
  bucket: string | null;
  /** The decoded key, as the bucket stores it. */
  key: string | null;
  presigned: boolean;
  /** `X-Amz-Expires` of a presigned URL, else null. */
  expires: number | null;
  /** The headers the signature covered, `host` included. */
  signedHeaders: string[];
  status: number;
  /** The S3 error code the stand-in answered with, when it refused. */
  code: string | null;
  /** `x-amz-copy-source` of a CopyObject, decoded. */
  copySource: string | null;
}

export interface StandinFailure {
  op?: StandinOp;
  bucket?: string;
  /** Matches when the decoded key contains this text. */
  keyIncludes?: string;
  status: number;
  code?: string;
  /** How many matching requests answer the error before it clears. Default 1. */
  times?: number;
}

export interface ComputeS3Standin {
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  log: StandinRequest[];
  /** The stand-in's clock, for the expiry of a presigned URL. A test moves it, not the system's. */
  clock: { now: () => number };
  /** Make the next `times` matching requests answer an error. */
  failWith(failure: StandinFailure): void;
  clearFailures(): void;
  stop(): void;
}

export interface StandinOptions {
  /** Bucket name to the real (Miniflare) R2 bucket it serves. */
  buckets: Record<string, R2Bucket>;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** The port to listen on (default 0, an ephemeral one). The server always listens on loopback only. */
  port?: number;
  /**
   * Answer 421 `host_not_allowed` to any request whose `Host` is not `127.0.0.1:<port>` or
   * `localhost:<port>` (a browser rebound to this address by DNS sends its own name). Off by default:
   * the signature already covers the host of a presigned URL, and the suites address `127.0.0.1`.
   */
  hostGuard?: boolean;
}

/**
 * Whether a `Host` header names this loopback server: exactly `127.0.0.1:<port>` or `localhost:<port>`
 * (case-insensitive name, no other name, no IP literal but the loopback one, no other port, no missing
 * header). A client on another machine reaching the port through `ssh -R` sends the name and port it
 * dialed; the stack's tunnel uses the same port number on both ends, so that is one of these two.
 */
export function loopbackHostAllowed(host: string | null, port: number): boolean {
  if (host === null) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

export const HOST_REFUSAL_STATUS = 421;
export const HOST_REFUSAL_BODY = '{"error":"host_not_allowed"}';

const xml = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "application/xml", ...extra } });

const errorXml = (code: string, message: string, status: number) =>
  xml(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    status,
  );

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

/** `20261104T080000Z` as a time. */
function parseAmzDate(date: string | null): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date ?? "");
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

interface Authentication {
  ok: boolean;
  presigned: boolean;
  expires: number | null;
  signedHeaders: string[];
  status?: number;
  code?: string;
  message?: string;
}

export function startComputeS3Standin(options: StandinOptions): ComputeS3Standin {
  const accessKeyId = options.accessKeyId ?? "STANDINKEYID";
  const secretAccessKey = options.secretAccessKey ?? "standin-secret-access-key";
  const log: StandinRequest[] = [];
  const clock = { now: () => Date.now() };
  let failures: Array<StandinFailure & { left: number }> = [];

  async function authenticate(req: Request): Promise<Authentication> {
    const url = new URL(req.url);
    const presigned = url.searchParams.has("X-Amz-Signature");
    const base = { presigned, expires: null as number | null, signedHeaders: [] as string[] };
    const denied = (code: string, message: string, status = 403): Authentication => ({
      ...base,
      ok: false,
      status,
      code,
      message,
    });

    if (presigned) {
      const q = url.searchParams;
      const expires = Number(q.get("X-Amz-Expires"));
      base.expires = Number.isFinite(expires) ? expires : null;
      if (q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") {
        return denied("AuthorizationQueryParametersError", "unsupported algorithm", 400);
      }
      if (!Number.isInteger(expires) || expires < 1 || expires > STANDIN_MAX_EXPIRES) {
        return denied(
          "AuthorizationQueryParametersError",
          "X-Amz-Expires must be between 1 and 604800 seconds",
          400,
        );
      }
      const credential = q.get("X-Amz-Credential") ?? "";
      const [key, date, region, service, terminator] = credential.split("/");
      if (
        key !== accessKeyId ||
        region !== STANDIN_REGION ||
        service !== "s3" ||
        terminator !== "aws4_request"
      ) {
        return denied("InvalidAccessKeyId", "the credential is not one this server knows");
      }
      const signedAt = parseAmzDate(q.get("X-Amz-Date"));
      if (signedAt === null || (q.get("X-Amz-Date") ?? "").slice(0, 8) !== date) {
        return denied("AuthorizationQueryParametersError", "bad X-Amz-Date", 400);
      }
      if (clock.now() > signedAt + expires * 1000)
        return denied("AccessDenied", "Request has expired");
      if (clock.now() < signedAt - 15 * 60 * 1000) {
        return denied("RequestTimeTooSkewed", "the request is dated in the future");
      }
      const signature = q.get("X-Amz-Signature");
      const names = (q.get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean);
      base.signedHeaders = names;
      const headers = new Headers();
      for (const name of names) if (name !== "host") headers.set(name, req.headers.get(name) ?? "");
      const unsigned = new URL(req.url);
      unsigned.searchParams.delete("X-Amz-Signature");
      const signer = new AwsV4Signer({
        method: req.method,
        url: unsigned.toString(),
        headers,
        accessKeyId,
        secretAccessKey,
        service: "s3",
        region: STANDIN_REGION,
        signQuery: true,
        datetime: q.get("X-Amz-Date") as string,
      });
      const signed = await signer.sign();
      if ((signed.url as URL).searchParams.get("X-Amz-Signature") !== signature) {
        return denied("SignatureDoesNotMatch", "the signature does not match");
      }
      return { ...base, ok: true };
    }

    const authorization = req.headers.get("authorization");
    if (!authorization) return denied("AccessDenied", "the request is not signed");
    const m =
      /^AWS4-HMAC-SHA256 Credential=([^,\s]+), SignedHeaders=([^,\s]+), Signature=([0-9a-f]{64})$/.exec(
        authorization,
      );
    if (!m) return denied("AuthorizationHeaderMalformed", "malformed Authorization header", 400);
    const [, credential, signedHeaders, signature] = m;
    const [key, , region, service, terminator] = (credential as string).split("/");
    if (
      key !== accessKeyId ||
      region !== STANDIN_REGION ||
      service !== "s3" ||
      terminator !== "aws4_request"
    ) {
      return denied("InvalidAccessKeyId", "the credential is not one this server knows");
    }
    const names = (signedHeaders as string).split(";").filter(Boolean);
    base.signedHeaders = names;
    const headers = new Headers();
    for (const name of names) if (name !== "host") headers.set(name, req.headers.get(name) ?? "");
    const signer = new AwsV4Signer({
      method: req.method,
      url: req.url,
      headers,
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: STANDIN_REGION,
      datetime: req.headers.get("x-amz-date") as string,
    });
    const header = (await signer.authHeader()) as string;
    if (!header.endsWith(`Signature=${signature}`)) {
      return denied("SignatureDoesNotMatch", "the signature does not match");
    }
    return { ...base, ok: true };
  }

  function takeFailure(
    op: StandinOp,
    bucket: string | null,
    key: string | null,
  ): StandinFailure | null {
    for (const f of failures) {
      if (f.left <= 0) continue;
      if (f.op !== undefined && f.op !== op) continue;
      if (f.bucket !== undefined && f.bucket !== bucket) continue;
      if (f.keyIncludes !== undefined && !(key ?? "").includes(f.keyIncludes)) continue;
      f.left -= 1;
      return f;
    }
    return null;
  }

  async function handle(req: Request, entry: StandinRequest): Promise<Response> {
    const url = new URL(req.url);
    const [, bucketName = "", ...rest] = url.pathname.split("/");
    let key: string | null = null;
    try {
      if (rest.length > 0) key = decodeURIComponent(rest.join("/"));
    } catch {
      return errorXml("InvalidURI", "the key is not valid percent-encoding", 400);
    }
    entry.bucket = bucketName || null;
    entry.key = key === "" ? null : key;

    const isList =
      req.method === "GET" && key === null && url.searchParams.get("list-type") === "2";
    const copySourceHeader = req.headers.get("x-amz-copy-source");
    entry.op = isList
      ? "ListObjectsV2"
      : req.method === "PUT" && copySourceHeader !== null
        ? "CopyObject"
        : req.method === "PUT"
          ? "PutObject"
          : req.method === "GET"
            ? "GetObject"
            : req.method === "HEAD"
              ? "HeadObject"
              : req.method === "DELETE"
                ? "DeleteObject"
                : "Unknown";
    if (copySourceHeader !== null) {
      try {
        entry.copySource = decodeURIComponent(copySourceHeader);
      } catch {
        entry.copySource = copySourceHeader;
      }
    }

    const injected = takeFailure(entry.op, entry.bucket, entry.key);
    if (injected) {
      entry.code = injected.code ?? "InternalError";
      return errorXml(entry.code, "an injected failure", injected.status);
    }

    const auth = await authenticate(req);
    entry.presigned = auth.presigned;
    entry.expires = auth.expires;
    entry.signedHeaders = auth.signedHeaders;
    if (!auth.ok) {
      entry.code = auth.code ?? "AccessDenied";
      return errorXml(entry.code, auth.message ?? "denied", auth.status ?? 403);
    }

    const bucket = options.buckets[bucketName];
    if (!bucket) {
      entry.code = "NoSuchBucket";
      return errorXml("NoSuchBucket", "no such bucket", 404);
    }

    if (isList) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const max = Math.min(Number(url.searchParams.get("max-keys") ?? 1000) || 1000, 1000);
      const token = url.searchParams.get("continuation-token") ?? undefined;
      const listed = await bucket.list({ prefix, limit: max, cursor: token });
      const contents = listed.objects
        .map(
          (o) =>
            `<Contents><Key>${escapeXml(o.key)}</Key><Size>${o.size}</Size><ETag>"${o.etag}"</ETag></Contents>`,
        )
        .join("");
      return xml(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${escapeXml(bucketName)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${listed.objects.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${listed.truncated}</IsTruncated>${
          listed.truncated
            ? `<NextContinuationToken>${escapeXml(listed.cursor)}</NextContinuationToken>`
            : ""
        }${contents}</ListBucketResult>`,
        200,
      );
    }
    if (key === null) {
      entry.code = "InvalidRequest";
      return errorXml("InvalidRequest", "this server serves objects and listings", 400);
    }

    if (entry.op === "CopyObject") {
      const source = /^\/?([^/]+)\/(.+)$/.exec(entry.copySource ?? "");
      const from = source ? options.buckets[source[1] as string] : undefined;
      const object = from && source ? await from.get(source[2] as string) : null;
      if (!object) {
        entry.code = "NoSuchKey";
        return errorXml("NoSuchKey", "the copy source does not exist", 404);
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      const put = await bucket.put(key, bytes);
      return xml(
        `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${new Date(clock.now()).toISOString()}</LastModified><ETag>"${put.etag}"</ETag></CopyObjectResult>`,
        200,
      );
    }

    if (entry.op === "PutObject") {
      const body = new Uint8Array(await req.arrayBuffer());
      const checksum = req.headers.get("x-amz-checksum-sha256");
      if (checksum !== null && checksum !== sha256Base64(body)) {
        entry.code = "BadDigest";
        return errorXml("BadDigest", "the x-amz-checksum-sha256 does not match the body", 400);
      }
      if (req.headers.get("if-none-match") === "*" && (await bucket.head(key)) !== null) {
        entry.code = "PreconditionFailed";
        return errorXml("PreconditionFailed", "the key exists", 412);
      }
      const put = await bucket.put(key, body);
      return new Response(null, { status: 200, headers: { ETag: `"${put.etag}"` } });
    }

    if (entry.op === "HeadObject") {
      const head = await bucket.head(key);
      if (!head) {
        entry.code = "NoSuchKey";
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 200,
        headers: { "Content-Length": String(head.size), ETag: `"${head.etag}"` },
      });
    }

    if (entry.op === "GetObject") {
      const object = await bucket.get(key);
      if (!object) {
        entry.code = "NoSuchKey";
        return errorXml("NoSuchKey", "no such key", 404);
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Length": String(bytes.length),
          ETag: `"${object.etag}"`,
          "Content-Type": "application/octet-stream",
        },
      });
    }

    if (entry.op === "DeleteObject") {
      await bucket.delete(key);
      return new Response(null, { status: 204 });
    }

    entry.code = "MethodNotAllowed";
    return errorXml("MethodNotAllowed", "not served", 405);
  }

  const server: Server = Bun.serve({
    port: options.port ?? 0,
    // Loopback only: without it Bun listens on every interface, and the long-running local stack's ssh
    // tunnel (card DM-08) would expose a bucket to the whole network.
    hostname: "127.0.0.1",
    async fetch(req) {
      if (
        options.hostGuard === true &&
        !loopbackHostAllowed(req.headers.get("host"), server.port as number)
      ) {
        return new Response(HOST_REFUSAL_BODY, {
          status: HOST_REFUSAL_STATUS,
          headers: { "Content-Type": "application/json" },
        });
      }
      const entry: StandinRequest = {
        op: "Unknown",
        method: req.method,
        bucket: null,
        key: null,
        presigned: false,
        expires: null,
        signedHeaders: [],
        status: 0,
        code: null,
        copySource: null,
      };
      log.push(entry);
      try {
        const response = await handle(req, entry);
        entry.status = response.status;
        return response;
      } catch (err) {
        entry.status = 500;
        entry.code = "InternalError";
        return errorXml("InternalError", err instanceof Error ? err.message : "error", 500);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    accessKeyId,
    secretAccessKey,
    log,
    clock,
    failWith(failure) {
      failures.push({ ...failure, left: failure.times ?? 1 });
    },
    clearFailures() {
      failures = [];
    },
    stop() {
      server.stop(true);
    },
  };
}
