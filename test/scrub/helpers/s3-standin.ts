/**
 * A real local HTTP stand-in for the subset of S3 the scrub stages use, driven by the REAL `aws`
 * CLI through `AWS_ENDPOINT_URL_S3`. Path-style (`/<bucket>/<key>`), and it keeps real bytes, so a
 * test compares the content an assembled object actually holds, not a size it was told.
 *
 * What it models, because the stages depend on each of these being true:
 *
 *  - Versioning. Every PUT and every completed multipart upload makes a new version with an id.
 *    DELETE with no version id adds a delete marker; DELETE with a version id removes exactly
 *    that version, and the previous one becomes current again.
 *  - Object Lock. A version carries GOVERNANCE (or COMPLIANCE) retention taken from the put or
 *    create-multipart-upload headers. DELETE by version id of a locked version answers 403
 *    AccessDenied unless `x-amz-bypass-governance-retention: true` is present, and answers 403
 *    even with it when the operator was configured without the bypass permission
 *    (`denyBypass`). Delete markers are never locked. A deletion without a version id is allowed
 *    on a locked key, as on S3, because it only adds a marker.
 *  - DeleteObjects (`POST /<bucket>?delete`): up to 1000 `<Object>` entries, each by key and
 *    optional version id, with the same lock rules per item as DeleteObject. As on S3 the request
 *    answers 200 even when an item is refused: a locked item is an `<Error>` entry
 *    (`AccessDenied`) beside the `<Deleted>` ones; with `<Quiet>true</Quiet>` only the errors. A version id that does not exist is answered
 *    `<Deleted>` (measured on the real bucket by the canary's `--batch` step, 2026-10-06, as
 *    were the per-item refusal inside a 200, a delete marker named by id, and the bypass). A
 *    request without `Content-MD5` or an `x-amz-checksum-*` header is refused (`InvalidRequest`),
 *    as S3 does. A fault on `DeleteObjects` fails the whole request; one on
 *    `DeleteObjectsItem` (with a `key`) turns that one item into an `<Error>` entry.
 *  - ListObjectVersions: a PREFIX match across keys, Versions and DeleteMarkers, newest first
 *    within a key, exactly one IsLatest per key, key-marker / version-id-marker paging with a
 *    configurable page size, and `encoding-type=url` (the CLI sends it and decodes the keys).
 *  - ListObjectsV2 (current objects only, with continuation tokens).
 *  - GET and HEAD, with Range (206 and Content-Range, 416 past the end), If-Match (412), and
 *    `versionId`. HEAD returns the version id, the lock mode and date, the encryption fields and
 *    Cache-Control.
 *  - PutObject with Object Lock parameters needs `Content-MD5` or an `x-amz-checksum-*` header,
 *    as an UploadPart of a lock-created upload does (documented for put-object, measured only for
 *    the part).
 *  - PutObject with `If-None-Match: *`: 412 PreconditionFailed when the key has a current version.
 *  - PutObject with `If-Match`: 412 PreconditionFailed when the current version's ETag is not the
 *    one named, and 404 NoSuchKey when the key has no current version, as S3 documents for
 *    conditional writes (Nov 2024). ASSUMED, not measured against the real bucket: this encodes
 *    what the documentation says, which is a belief until the canary (which now puts and gets
 *    conditionally with a right and a stale ETag) has run against the real bucket. The 409
 *    ConditionalRequestConflict S3 documents for a conflicting write in flight is not modeled; a
 *    test injects it as a fault.
 *  - GetObjectRetention (404 NoSuchObjectLockConfiguration when a version has none).
 *  - ListMultipartUploads (one page, by prefix).
 *  - Multipart: CreateMultipartUpload (keeps the lock and encryption headers), UploadPart,
 *    UploadPartCopy (`x-amz-copy-source` with an optional `?versionId=`, a byte range, and
 *    `x-amz-copy-source-if-match`, 412 on mismatch), CompleteMultipartUpload (validates the part
 *    list and, as S3 does, refuses any non-final part under 5 MiB with EntityTooSmall; the object
 *    ETag is the multipart form `<md5 of the md5s>-<parts>`), AbortMultipartUpload.
 *
 * Every request is logged by operation so a test asserts on what the real CLI sent. Faults and
 * hooks are injected explicitly by the test that needs them. Test-only helpers that S3 has no
 * request for (flip a stored byte, strip a lock) are methods on the returned object.
 */

import { createHash } from "node:crypto";

export const MIN_PART_BYTES = 5 * 1024 * 1024;

export type StandinOp =
  | "GetBucketLocation"
  | "CreateBucket"
  | "ListObjectsV2"
  | "ListObjectVersions"
  | "HeadObject"
  | "GetObject"
  | "GetObjectRetention"
  | "PutObject"
  | "CreateMultipartUpload"
  | "UploadPart"
  | "UploadPartCopy"
  | "CompleteMultipartUpload"
  | "AbortMultipartUpload"
  | "ListMultipartUploads"
  | "DeleteObject"
  | "DeleteObjects"
  /** A per-item fault of a DeleteObjects request: the item is answered as an `<Error>` entry. */
  | "DeleteObjectsItem";

export interface StoredVersion {
  versionId: string;
  deleteMarker: boolean;
  data: Uint8Array;
  etag: string;
  lastModified: string;
  contentType: string;
  sse?: string;
  kmsKeyId?: string;
  cacheControl?: string;
  lock?: { mode: string; until: Date };
}

export interface StandinLogEntry {
  op: StandinOp | "Unknown";
  bucket: string;
  key: string;
  status: number;
  versionId?: string | null;
  bypass?: boolean;
  range?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  partNumber?: number;
  /** The access key id the request was signed with. */
  keyId?: string;
  /** SHA-256 fingerprint of the session token header; token material is never logged. */
  sessionTokenFingerprint?: string;
  /** A PutObject or UploadPart request that carried an `x-amz-checksum-*` header (or Content-MD5). */
  checksum?: boolean;
  size?: number;
  method?: string;
  /** A DeleteObjects request: what it named, in order, and whether it asked for the bypass. */
  items?: Array<{ key: string; versionId: string | null }>;
}

export interface Fault {
  code: string;
  status: number;
  /** Let this many matching calls through before failing. */
  after?: number;
  /** Fail this many matching calls, then behave normally (default: all). */
  times?: number;
  /** Only calls for this key. */
  key?: string;
  /** Only calls signed with this access key id. */
  keyId?: string;
  /**
   * The request takes effect, THEN the error is returned: an answer lost on the way back. Only
   * CreateMultipartUpload honors it (the upload is created and left open).
   */
  applied?: boolean;
  /**
   * DeleteObjectsItem only: the item is neither deleted nor mentioned in the answer, which the
   * caller must read as "not known to be gone".
   */
  omit?: boolean;
}

export interface PutOptions {
  lockUntil?: Date;
  lockMode?: string;
  contentType?: string;
  sse?: string;
  kmsKeyId?: string;
  cacheControl?: string;
}

/** An opaque copy of the stand-in's contents. */
export type Snapshot = Map<string, StoredVersion[]>;

export interface S3Standin {
  /** Value for AWS_ENDPOINT_URL_S3. */
  url: string;
  log: StandinLogEntry[];
  /** Push a NEW version holding `data`. Returns its version id. */
  putObject(bucket: string, key: string, data: Uint8Array, opts?: PutOptions): string;
  /** Push a delete marker on top of the key. Returns its version id. */
  putDeleteMarker(bucket: string, key: string): string;
  /** Every stored version of the key, oldest first. */
  versions(bucket: string, key: string): StoredVersion[];
  /** The key's current version, or undefined when absent or hidden by a marker. */
  current(bucket: string, key: string): StoredVersion | undefined;
  /** Every key under the prefix that has at least one version or marker. */
  keys(bucket: string, prefix: string): string[];
  /** Flip one stored byte of one version (a corruption no request could cause). */
  corruptByte(bucket: string, key: string, versionId: string, offset: number): void;
  /** Remove the lock from one version. */
  clearLock(bucket: string, key: string, versionId: string): void;
  /** Give one version a lock (replacing any), as a put with lock headers would. */
  setLock(bucket: string, key: string, versionId: string, mode: string, until: Date): void;
  /** Remove one version outright, as an out-of-band deletion would (no lock check). */
  dropVersion(bucket: string, key: string, versionId: string): void;
  /** Capture every key and version, so a test can return to this state with `restore`. */
  snapshot(): Snapshot;
  restore(snapshot: Snapshot): void;
  /** Multipart uploads begun and neither completed nor aborted. */
  openUploads(): number;
  /** Operators without s3:BypassGovernanceRetention: the bypass header is refused too. */
  setDenyBypass(deny: boolean): void;
  /**
   * An endpoint that ignores `If-Match` on PutObject and GetObject, as one without conditional
   * writes would: the request succeeds whatever ETag it names. What a canary must catch.
   */
  setIgnoreIfMatch(ignore: boolean): void;
  /** Entries per ListObjectVersions / ListObjectsV2 page. */
  setPageSize(n: number): void;
  /** A truncated ListObjectVersions page names its next key but not its next version id. */
  omitNextVersionIdMarker(on?: boolean): void;
  /** Hold the next `times` requests with this HTTP method for `ms` before answering (a hung server). */
  stallNext(method: string, ms: number, times?: number): void;
  /**
   * Answer the next GetObject of a key under `keyPrefix` with its headers and the first `bytes`
   * of its body, then hold the rest for `ms` (or until the client goes away): a download caught
   * half way, with the client's output file already open.
   */
  stallBodyNext(opts: { keyPrefix: string; bytes: number; ms: number }): void;
  inject(op: StandinOp, fault: Fault): void;
  clearFaults(): void;
  /** Run `fn` just before the Nth call (1-based) of `op` is handled. */
  beforeOp(op: StandinOp, fn: () => void, nth?: number): void;
  /** How many calls of `op` the stand-in has handled since it started (the log can be cleared). */
  opCount(op: StandinOp): number;
  /** Log entries for one operation. */
  calls(op: StandinOp): StandinLogEntry[];
  stop(): void;
}

let counter = 0;
const nextVersionId = () => `standin-v${++counter}`;

const md5 = (data: Uint8Array) => createHash("md5").update(data).digest();
const md5hex = (data: Uint8Array) => md5(data).toString("hex");

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

function xml(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(XML_HEAD + body, {
    status,
    headers: { "Content-Type": "application/xml", ...headers },
  });
}

function s3Error(code: string, status: number, message = code): Response {
  return xml(`<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`, status);
}

interface Upload {
  bucket: string;
  key: string;
  contentType: string;
  sse?: string;
  kmsKeyId?: string;
  lock?: { mode: string; until: Date };
  parts: Map<number, { data: Uint8Array; etag: string }>;
}

function parseLock(req: Request): { mode: string; until: Date } | undefined | "bad" {
  const mode = req.headers.get("x-amz-object-lock-mode");
  const until = req.headers.get("x-amz-object-lock-retain-until-date");
  if (!mode && !until) return undefined;
  if (!mode || !until) return "bad";
  const d = new Date(until);
  if (!["GOVERNANCE", "COMPLIANCE"].includes(mode) || Number.isNaN(d.getTime())) return "bad";
  return { mode, until: d };
}

function parseRange(header: string | null, size: number): [number, number] | "bad" | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!m) return "bad";
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "bad";
  return [start, end];
}

export function startS3Standin(options: { region?: string } = {}): S3Standin {
  const store = new Map<string, StoredVersion[]>(); // oldest -> newest
  const uploads = new Map<string, Upload>();
  const log: StandinLogEntry[] = [];
  const faults = new Map<StandinOp, Array<Fault & { seen: number; failed: number }>>();
  const hooks = new Map<StandinOp, Array<{ fn: () => void; nth: number }>>();
  const opCounts = new Map<StandinOp, number>();
  let denyBypass = false;
  let ignoreIfMatch = false;
  let pageSize = 1000;
  let omitVersionIdMarker = false;
  const stalls: Array<{ method: string; ms: number; times: number }> = [];
  const bodyStalls: Array<{ keyPrefix: string; bytes: number; ms: number }> = [];

  const slot = (bucket: string, key: string) => `${bucket}/${key}`;
  const versionsOf = (bucket: string, key: string) => store.get(slot(bucket, key)) ?? [];
  const current = (bucket: string, key: string): StoredVersion | undefined => {
    const vs = versionsOf(bucket, key);
    const v = vs[vs.length - 1];
    return v && !v.deleteMarker ? v : undefined;
  };
  /** The addressed version, live only: by id, or the current one. */
  const pick = (bucket: string, key: string, versionId: string | null) => {
    if (versionId) return versionsOf(bucket, key).find((v) => v.versionId === versionId);
    return current(bucket, key);
  };
  const push = (bucket: string, key: string, v: StoredVersion): string => {
    const arr = versionsOf(bucket, key);
    arr.push(v);
    store.set(slot(bucket, key), arr);
    return v.versionId;
  };

  const enter = (op: StandinOp, key: string, keyId?: string): Fault | null => {
    const n = (opCounts.get(op) ?? 0) + 1;
    opCounts.set(op, n);
    for (const h of hooks.get(op) ?? []) if (h.nth === n) h.fn();
    for (const f of faults.get(op) ?? []) {
      if (f.key !== undefined && f.key !== key) continue;
      if (f.keyId !== undefined && f.keyId !== keyId) continue;
      f.seen += 1;
      if (f.seen <= (f.after ?? 0)) continue;
      if (f.times !== undefined && f.failed >= f.times) continue;
      f.failed += 1;
      return f;
    }
    return null;
  };

  const keyOut = (k: string, encode: boolean) => xmlEscape(encode ? encodeURIComponent(k) : k);

  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, not the default: a wildcard bind (`*:port`, IPv6 dual-stack) lets another
    // process on the machine bind 127.0.0.1:<same port> and take every connection the test makes
    // to 127.0.0.1 (measured on macOS: the "404 in 2 ms" and "401" flakes were other local
    // servers answering). A specific bind refuses that second bind (EADDRINUSE).
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      const stall = stalls.find((x) => x.method === req.method && x.times > 0);
      if (stall) {
        stall.times -= 1;
        // Answer late, or not at all if the client gives up first (its connection closes).
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, stall.ms);
          req.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      const url = new URL(req.url);
      const segments = url.pathname.slice(1).split("/");
      const bucket = decodeURIComponent(segments[0] ?? "");
      const key = decodeURIComponent(segments.slice(1).join("/"));
      const q = url.searchParams;
      const versionId = q.get("versionId");
      const keyId = /Credential=([^/]+)\//.exec(req.headers.get("authorization") ?? "")?.[1];
      const sessionToken = req.headers.get("x-amz-security-token");
      const sessionTokenFingerprint = sessionToken
        ? createHash("sha256").update(sessionToken).digest("hex")
        : undefined;
      const record = (e: Omit<StandinLogEntry, "bucket">) =>
        log.push({ bucket, keyId, sessionTokenFingerprint, ...e });
      const fail = (op: StandinOp, f: Fault, extra: Partial<StandinLogEntry> = {}) => {
        record({ op, key, status: f.status, ...extra });
        return s3Error(f.code, f.status, `induced ${f.code} (test)`);
      };

      // ---- DeleteObjects ----
      if (req.method === "POST" && key === "" && q.has("delete")) {
        const bypass = req.headers.get("x-amz-bypass-governance-retention") === "true";
        const body = await req.text();
        // S3 requires Content-MD5 or an x-amz-checksum-* header on a multi-object delete. The CLI
        // sends one by default; a regression of the pinned checksum setting would show here.
        const checksum =
          [...req.headers.keys()].some((h) => h.startsWith("x-amz-checksum-")) ||
          req.headers.has("content-md5");
        if (!checksum) {
          record({ op: "DeleteObjects", key: "", status: 400, bypass, checksum: false });
          return s3Error(
            "InvalidRequest",
            400,
            "Missing required header for this request: Content-MD5 OR x-amz-checksum-",
          );
        }
        // As on S3, Quiet mode answers only the failures: a caller that asks for it cannot tell
        // which items were deleted.
        const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(body);
        const items = [...body.matchAll(/<Object>([\s\S]*?)<\/Object>/g)].map((m) => {
          const part = m[1] as string;
          const k = /<Key>([\s\S]*?)<\/Key>/.exec(part)?.[1] ?? "";
          const v = /<VersionId>([\s\S]*?)<\/VersionId>/.exec(part)?.[1] ?? null;
          return { key: xmlUnescape(k), versionId: v === null ? null : xmlUnescape(v) };
        });
        const fault = enter("DeleteObjects", "");
        if (fault) return fail("DeleteObjects", fault, { bypass, items, checksum });
        if (items.length === 0 || items.length > 1000) {
          record({ op: "DeleteObjects", key: "", status: 400, bypass, items, checksum });
          return s3Error("MalformedXML", 400);
        }
        const deleted: string[] = [];
        const errors: string[] = [];
        const refuse = (k: string, v: string | null, code: string) =>
          errors.push(
            `<Error><Key>${xmlEscape(k)}</Key>${v === null ? "" : `<VersionId>${xmlEscape(v)}</VersionId>`}<Code>${code}</Code><Message>${code}</Message></Error>`,
          );
        for (const it of items) {
          const itemFault = enter("DeleteObjectsItem", it.key);
          if (itemFault) {
            if (!itemFault.omit) refuse(it.key, it.versionId, itemFault.code);
            continue;
          }
          const arr = versionsOf(bucket, it.key);
          if (it.versionId === null) {
            // No version id: a delete marker is added, as DeleteObject does.
            const id = push(bucket, it.key, {
              versionId: nextVersionId(),
              deleteMarker: true,
              data: new Uint8Array(0),
              etag: "",
              lastModified: new Date().toISOString(),
              contentType: "",
            });
            deleted.push(
              `<Deleted><Key>${xmlEscape(it.key)}</Key><DeleteMarker>true</DeleteMarker><DeleteMarkerVersionId>${id}</DeleteMarkerVersionId></Deleted>`,
            );
            continue;
          }
          const idx = arr.findIndex((v) => v.versionId === it.versionId);
          const v = idx < 0 ? undefined : (arr[idx] as StoredVersion);
          if (v && !v.deleteMarker && v.lock && v.lock.until.getTime() > Date.now()) {
            const allowed = v.lock.mode === "GOVERNANCE" && bypass && !denyBypass;
            if (!allowed) {
              refuse(it.key, it.versionId, "AccessDenied");
              continue;
            }
          }
          if (idx >= 0) arr.splice(idx, 1);
          deleted.push(
            `<Deleted><Key>${xmlEscape(it.key)}</Key><VersionId>${xmlEscape(it.versionId)}</VersionId>${v?.deleteMarker ? `<DeleteMarker>true</DeleteMarker><DeleteMarkerVersionId>${xmlEscape(it.versionId)}</DeleteMarkerVersionId>` : ""}</Deleted>`,
          );
        }
        record({ op: "DeleteObjects", key: "", status: 200, bypass, items, checksum });
        return xml(
          `<DeleteResult>${quiet ? "" : deleted.join("")}${errors.join("")}</DeleteResult>`,
        );
      }

      // ---- bucket-level: listings ----
      if (key === "") {
        if (req.method === "GET" && q.has("location")) {
          const fault = enter("GetBucketLocation", "");
          if (fault) return fail("GetBucketLocation", fault);
          record({ op: "GetBucketLocation", key: "", status: 200 });
          const region = options.region === "us-east-1" ? "" : (options.region ?? "");
          return xml(
            `<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${xmlEscape(region)}</LocationConstraint>`,
          );
        }
        if (req.method === "PUT") {
          const fault = enter("CreateBucket", "");
          if (fault) return fail("CreateBucket", fault);
          record({ op: "CreateBucket", key: "", status: 200 });
          return new Response(null, { status: 200 });
        }
        const encode = q.get("encoding-type") === "url";
        const limit = Math.min(Number(q.get("max-keys") ?? pageSize), pageSize);
        const prefix = q.get("prefix") ?? "";
        if (q.get("list-type") === "2") {
          const fault = enter("ListObjectsV2", prefix);
          if (fault) return fail("ListObjectsV2", fault);
          const all = [...store.keys()]
            .filter((s) => s.startsWith(`${bucket}/${prefix}`))
            .map((s) => s.slice(bucket.length + 1))
            .filter((k) => current(bucket, k) !== undefined)
            .sort();
          const token = q.get("continuation-token");
          const startAt = token ? all.findIndex((k) => k > token) : 0;
          const page = startAt < 0 ? [] : all.slice(startAt, startAt + limit);
          const truncated = startAt >= 0 && startAt + limit < all.length;
          const contents = page
            .map((k) => {
              const v = current(bucket, k) as StoredVersion;
              return `<Contents><Key>${keyOut(k, encode)}</Key><LastModified>${v.lastModified}</LastModified><ETag>${xmlEscape(v.etag)}</ETag><Size>${v.data.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
            })
            .join("");
          record({ op: "ListObjectsV2", key: prefix, status: 200 });
          return xml(
            `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${limit}</MaxKeys>${encode ? "<EncodingType>url</EncodingType>" : ""}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1] as string)}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`,
          );
        }
        if (q.has("versions")) {
          const fault = enter("ListObjectVersions", prefix);
          if (fault) return fail("ListObjectVersions", fault);
          const flat: Array<{ key: string; v: StoredVersion; latest: boolean }> = [];
          for (const s of [...store.keys()]
            .filter((s) => s.startsWith(`${bucket}/${prefix}`))
            .sort()) {
            const k = s.slice(bucket.length + 1);
            [...versionsOf(bucket, k)].reverse().forEach((v, i) => {
              flat.push({ key: k, v, latest: i === 0 });
            });
          }
          const keyMarker = q.get("key-marker");
          const idMarker = q.get("version-id-marker");
          let startAt = 0;
          if (keyMarker) {
            const idx = flat.findIndex(
              (e) => e.key === keyMarker && (idMarker ? e.v.versionId === idMarker : false),
            );
            startAt =
              idx >= 0
                ? idx + 1
                : Math.max(
                    0,
                    flat.findIndex((e) => e.key > keyMarker),
                  );
          }
          const page = flat.slice(startAt, startAt + limit);
          const truncated = startAt + limit < flat.length;
          const last = page[page.length - 1];
          const body = page
            .map(({ key: k, v, latest }) => {
              const tag = v.deleteMarker ? "DeleteMarker" : "Version";
              const extra = v.deleteMarker
                ? ""
                : `<ETag>${xmlEscape(v.etag)}</ETag><Size>${v.data.length}</Size><StorageClass>STANDARD</StorageClass>`;
              return `<${tag}><Key>${keyOut(k, encode)}</Key><VersionId>${v.versionId}</VersionId><IsLatest>${latest}</IsLatest><LastModified>${v.lastModified}</LastModified>${extra}</${tag}>`;
            })
            .join("");
          record({ op: "ListObjectVersions", key: prefix, status: 200 });
          return xml(
            `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><MaxKeys>${limit}</MaxKeys>${encode ? "<EncodingType>url</EncodingType>" : ""}<IsTruncated>${truncated}</IsTruncated>${truncated && last ? `<NextKeyMarker>${keyOut(last.key, encode)}</NextKeyMarker>${omitVersionIdMarker ? "" : `<NextVersionIdMarker>${last.v.versionId}</NextVersionIdMarker>`}` : ""}${body}</ListVersionsResult>`,
          );
        }
        if (q.has("uploads") && req.method === "GET") {
          const fault = enter("ListMultipartUploads", prefix);
          if (fault) return fail("ListMultipartUploads", fault);
          const open = [...uploads.entries()]
            .filter(([, u]) => u.bucket === bucket && u.key.startsWith(prefix))
            .sort(([, a], [, b]) => a.key.localeCompare(b.key));
          record({ op: "ListMultipartUploads", key: prefix, status: 200 });
          return xml(
            `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket)}</Bucket><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>false</IsTruncated>${open
              .map(
                ([id, u]) =>
                  `<Upload><Key>${keyOut(u.key, encode)}</Key><UploadId>${id}</UploadId><Initiated>${new Date().toISOString()}</Initiated></Upload>`,
              )
              .join("")}</ListMultipartUploadsResult>`,
          );
        }
        record({ op: "Unknown", key: url.search, status: 501, method: req.method });
        return s3Error("NotImplemented", 501);
      }

      // ---- HEAD ----
      if (req.method === "HEAD") {
        const fault = enter("HeadObject", key);
        if (fault) {
          record({ op: "HeadObject", key, status: fault.status, versionId });
          return new Response(null, { status: fault.status });
        }
        const v = pick(bucket, key, versionId);
        record({ op: "HeadObject", key, status: v && !v.deleteMarker ? 200 : 404, versionId });
        if (!v || v.deleteMarker) return new Response(null, { status: 404 });
        const headers: Record<string, string> = {
          "Content-Length": String(v.data.length),
          ETag: v.etag,
          "Last-Modified": new Date(v.lastModified).toUTCString(),
          "Content-Type": v.contentType,
          "x-amz-version-id": v.versionId,
        };
        if (v.lock) {
          headers["x-amz-object-lock-mode"] = v.lock.mode;
          headers["x-amz-object-lock-retain-until-date"] = v.lock.until.toISOString();
        }
        if (v.sse) headers["x-amz-server-side-encryption"] = v.sse;
        if (v.kmsKeyId) headers["x-amz-server-side-encryption-aws-kms-key-id"] = v.kmsKeyId;
        if (v.cacheControl) headers["Cache-Control"] = v.cacheControl;
        return new Response(null, { status: 200, headers });
      }

      // ---- GetObjectRetention ----
      if (req.method === "GET" && q.has("retention")) {
        const fault = enter("GetObjectRetention", key);
        if (fault) return fail("GetObjectRetention", fault);
        const v = pick(bucket, key, versionId);
        if (!v || v.deleteMarker) {
          record({ op: "GetObjectRetention", key, status: 404, versionId });
          return s3Error("NoSuchKey", 404);
        }
        if (!v.lock) {
          record({ op: "GetObjectRetention", key, status: 404, versionId });
          return s3Error("NoSuchObjectLockConfiguration", 404);
        }
        record({ op: "GetObjectRetention", key, status: 200, versionId });
        return xml(
          `<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>${v.lock.mode}</Mode><RetainUntilDate>${v.lock.until.toISOString()}</RetainUntilDate></Retention>`,
        );
      }

      // ---- GetObject ----
      if (req.method === "GET") {
        const fault = enter("GetObject", key);
        const rangeHeader = req.headers.get("range");
        const ifMatch = req.headers.get("if-match") ?? undefined;
        if (fault) return fail("GetObject", fault, { range: rangeHeader ?? undefined });
        const v = pick(bucket, key, versionId);
        if (!v || v.deleteMarker) {
          record({ op: "GetObject", key, status: 404, range: rangeHeader ?? undefined });
          return s3Error("NoSuchKey", 404);
        }
        if (ifMatch && !ignoreIfMatch && ifMatch !== v.etag) {
          record({ op: "GetObject", key, status: 412, range: rangeHeader ?? undefined, ifMatch });
          return s3Error("PreconditionFailed", 412);
        }
        const range = parseRange(rangeHeader, v.data.length);
        if (range === "bad") {
          record({ op: "GetObject", key, status: 416, range: rangeHeader ?? undefined });
          return s3Error("InvalidRange", 416);
        }
        const headers: Record<string, string> = {
          ETag: v.etag,
          "Last-Modified": new Date(v.lastModified).toUTCString(),
          "Content-Type": v.contentType,
          "x-amz-version-id": v.versionId,
          "Accept-Ranges": "bytes",
        };
        if (v.sse) headers["x-amz-server-side-encryption"] = v.sse;
        if (v.kmsKeyId) headers["x-amz-server-side-encryption-aws-kms-key-id"] = v.kmsKeyId;
        if (v.cacheControl) headers["Cache-Control"] = v.cacheControl;
        const bodyStall = bodyStalls.findIndex((x) => key.startsWith(x.keyPrefix));
        if (bodyStall >= 0) {
          const { bytes, ms } = bodyStalls.splice(bodyStall, 1)[0] as (typeof bodyStalls)[number];
          const [a, b] = range ?? [0, v.data.length - 1];
          const body = v.data.slice(a, b + 1);
          if (range) headers["Content-Range"] = `bytes ${a}-${b}/${v.data.length}`;
          headers["Content-Length"] = String(body.length);
          record({
            op: "GetObject",
            key,
            status: range ? 206 : 200,
            range: rangeHeader ?? undefined,
          });
          // start() must not wait: the server sends nothing until it returns.
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body.slice(0, Math.min(bytes, body.length - 1)));
              const rest = () => {
                try {
                  controller.enqueue(body.slice(Math.min(bytes, body.length - 1)));
                  controller.close();
                } catch {
                  // The client went away.
                }
              };
              const timer = setTimeout(rest, ms);
              req.signal.addEventListener("abort", () => clearTimeout(timer));
            },
          });
          return new Response(stream, { status: range ? 206 : 200, headers });
        }
        if (!range) {
          record({ op: "GetObject", key, status: 200, size: v.data.length, versionId });
          return new Response(v.data, { status: 200, headers });
        }
        const [a, b] = range;
        headers["Content-Range"] = `bytes ${a}-${b}/${v.data.length}`;
        record({
          op: "GetObject",
          key,
          status: 206,
          range: rangeHeader ?? undefined,
          size: b - a + 1,
          versionId,
          ifMatch,
        });
        return new Response(v.data.subarray(a, b + 1), { status: 206, headers });
      }

      // ---- CreateMultipartUpload ----
      if (req.method === "POST" && q.has("uploads")) {
        const fault = enter("CreateMultipartUpload", key);
        if (fault && !fault.applied) return fail("CreateMultipartUpload", fault);
        const lock = parseLock(req);
        if (lock === "bad") {
          record({ op: "CreateMultipartUpload", key, status: 400 });
          return s3Error("InvalidArgument", 400);
        }
        const id = `upload-${nextVersionId()}`;
        uploads.set(id, {
          bucket,
          key,
          contentType: req.headers.get("content-type") ?? "binary/octet-stream",
          sse: req.headers.get("x-amz-server-side-encryption") ?? undefined,
          kmsKeyId: req.headers.get("x-amz-server-side-encryption-aws-kms-key-id") ?? undefined,
          lock,
          parts: new Map(),
        });
        if (fault) return fail("CreateMultipartUpload", fault);
        record({ op: "CreateMultipartUpload", key, status: 200 });
        return xml(
          `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }

      // ---- UploadPartCopy / UploadPart (both are PUT with partNumber and uploadId) ----
      if (req.method === "PUT" && q.has("partNumber") && q.has("uploadId")) {
        const partNumber = Number(q.get("partNumber"));
        const upload = uploads.get(q.get("uploadId") ?? "");
        const copySource = req.headers.get("x-amz-copy-source");
        if (copySource !== null) {
          const ifMatch = req.headers.get("x-amz-copy-source-if-match") ?? undefined;
          const rangeHeader = req.headers.get("x-amz-copy-source-range") ?? undefined;
          const fault = enter("UploadPartCopy", key);
          const base = {
            op: "UploadPartCopy" as const,
            key,
            partNumber,
            range: rangeHeader,
            ifMatch,
          };
          if (fault) {
            record({ ...base, status: fault.status });
            return s3Error(fault.code, fault.status, `induced ${fault.code} (test)`);
          }
          if (!upload) {
            record({ ...base, status: 404 });
            return s3Error("NoSuchUpload", 404);
          }
          const qm = copySource.indexOf("?");
          const srcPath = decodeURIComponent(qm === -1 ? copySource : copySource.slice(0, qm));
          const srcVersion =
            qm === -1 ? null : new URLSearchParams(copySource.slice(qm + 1)).get("versionId");
          const slash = srcPath.replace(/^\//, "").indexOf("/");
          const trimmed = srcPath.replace(/^\//, "");
          const srcBucket = trimmed.slice(0, slash);
          const srcKey = trimmed.slice(slash + 1);
          const src = pick(srcBucket, srcKey, srcVersion);
          if (!src || src.deleteMarker) {
            record({ ...base, status: 404 });
            return s3Error("NoSuchKey", 404);
          }
          if (ifMatch && ifMatch !== src.etag) {
            record({ ...base, status: 412 });
            return s3Error("PreconditionFailed", 412);
          }
          const range = parseRange(rangeHeader ?? null, src.data.length);
          if (range === "bad") {
            record({ ...base, status: 416 });
            return s3Error("InvalidRange", 416);
          }
          const [a, b] = range ?? [0, src.data.length - 1];
          const data = src.data.slice(a, b + 1);
          const etag = `"${md5hex(data)}"`;
          upload.parts.set(partNumber, { data, etag });
          record({ ...base, status: 200, size: data.length });
          return xml(
            `<CopyPartResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>${new Date().toISOString()}</LastModified><ETag>${xmlEscape(etag)}</ETag></CopyPartResult>`,
          );
        }
        const body = new Uint8Array(await req.arrayBuffer());
        const checksum = [...req.headers.keys()].some((h) => h.startsWith("x-amz-checksum-"));
        const fault = enter("UploadPart", key);
        const base = { op: "UploadPart" as const, key, partNumber, checksum };
        if (fault) {
          record({ ...base, status: fault.status });
          return s3Error(fault.code, fault.status, `induced ${fault.code} (test)`);
        }
        if (!upload) {
          record({ ...base, status: 404 });
          return s3Error("NoSuchUpload", 404);
        }
        // Real S3 (measured 2026-10-04): a part of an upload created with lock parameters must
        // carry Content-MD5 or an x-amz-checksum-* header, or it is refused.
        if (upload.lock && !checksum && !req.headers.has("content-md5")) {
          record({ ...base, status: 400 });
          return s3Error(
            "InvalidRequest",
            400,
            "Content-MD5 OR x-amz-checksum- HTTP header is required for Put Part requests with Object Lock parameters",
          );
        }
        const etag = `"${md5hex(body)}"`;
        upload.parts.set(partNumber, { data: body, etag });
        record({ ...base, status: 200, size: body.length });
        return new Response(null, { status: 200, headers: { ETag: etag } });
      }

      // ---- CompleteMultipartUpload ----
      if (req.method === "POST" && q.has("uploadId")) {
        const text = await req.text();
        const id = q.get("uploadId") ?? "";
        const upload = uploads.get(id);
        const fault = enter("CompleteMultipartUpload", key);
        if (fault) return fail("CompleteMultipartUpload", fault);
        if (!upload) {
          record({ op: "CompleteMultipartUpload", key, status: 404 });
          return s3Error("NoSuchUpload", 404);
        }
        const listed = [
          ...text.matchAll(
            /<Part>\s*<ETag>([^<]*)<\/ETag>\s*<PartNumber>(\d+)<\/PartNumber>\s*<\/Part>/g,
          ),
        ].map((m) => ({
          etag: (m[1] as string).replace(/&quot;/g, '"'),
          number: Number(m[2]),
        }));
        const bad = (code: string, status = 400) => {
          record({ op: "CompleteMultipartUpload", key, status });
          return s3Error(code, status);
        };
        if (listed.length === 0) return bad("MalformedXML");
        for (let i = 0; i < listed.length; i++) {
          const p = listed[i] as { etag: string; number: number };
          if (i > 0 && p.number <= (listed[i - 1] as { number: number }).number) {
            return bad("InvalidPartOrder");
          }
          const stored = upload.parts.get(p.number);
          if (!stored || stored.etag !== p.etag) return bad("InvalidPart");
          if (i < listed.length - 1 && stored.data.length < MIN_PART_BYTES) {
            return bad("EntityTooSmall");
          }
        }
        const datas = listed.map((p) => (upload.parts.get(p.number) as { data: Uint8Array }).data);
        const total = datas.reduce((n, d) => n + d.length, 0);
        const data = new Uint8Array(total);
        let off = 0;
        for (const d of datas) {
          data.set(d, off);
          off += d.length;
        }
        const etag = `"${createHash("md5")
          .update(Buffer.concat(datas.map(md5)))
          .digest("hex")}-${listed.length}"`;
        const versionIdNew = push(upload.bucket, upload.key, {
          versionId: nextVersionId(),
          deleteMarker: false,
          data,
          etag,
          lastModified: new Date().toISOString(),
          contentType: upload.contentType,
          sse: upload.sse,
          kmsKeyId: upload.kmsKeyId,
          lock: upload.lock,
        });
        uploads.delete(id);
        record({ op: "CompleteMultipartUpload", key, status: 200, size: total });
        return xml(
          `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>http://standin/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`,
          200,
          { "x-amz-version-id": versionIdNew },
        );
      }

      // ---- AbortMultipartUpload ----
      if (req.method === "DELETE" && q.has("uploadId")) {
        const fault = enter("AbortMultipartUpload", key);
        if (fault) return fail("AbortMultipartUpload", fault);
        const existed = uploads.delete(q.get("uploadId") ?? "");
        record({ op: "AbortMultipartUpload", key, status: existed ? 204 : 404 });
        return existed ? new Response(null, { status: 204 }) : s3Error("NoSuchUpload", 404);
      }

      // ---- PutObject ----
      if (req.method === "PUT" && !req.headers.has("x-amz-copy-source")) {
        const body = new Uint8Array(await req.arrayBuffer());
        const fault = enter("PutObject", key, keyId);
        if (fault) return fail("PutObject", fault);
        const lock = parseLock(req);
        if (lock === "bad") {
          record({ op: "PutObject", key, status: 400 });
          return s3Error("InvalidArgument", 400);
        }
        // S3 documents the same rule for a put with lock parameters as for a part of an upload
        // created with them (the part rule is measured; this one is documented, not measured).
        const checksum =
          [...req.headers.keys()].some((h) => h.startsWith("x-amz-checksum-")) ||
          req.headers.has("content-md5");
        if (lock && !checksum) {
          record({ op: "PutObject", key, status: 400, checksum: false });
          return s3Error(
            "InvalidRequest",
            400,
            "Content-MD5 OR x-amz-checksum- HTTP header is required for requests with Object Lock parameters",
          );
        }
        const ifMatch = req.headers.get("if-match") ?? undefined;
        const ifNoneMatch = req.headers.get("if-none-match") ?? undefined;
        // `If-None-Match: *` creates the object only when the key has no current version (a key
        // whose newest entry is a delete marker counts as absent), else 412, as S3 documents for
        // conditional writes (Aug 2024). ASSUMED, not measured against the real bucket.
        if (ifNoneMatch !== undefined && !ignoreIfMatch) {
          if (ifNoneMatch !== "*") {
            record({ op: "PutObject", key, status: 501, ifMatch });
            return s3Error("NotImplemented", 501);
          }
          if (current(bucket, key)) {
            record({ op: "PutObject", key, status: 412, ifNoneMatch });
            return s3Error("PreconditionFailed", 412);
          }
        }
        if (ifMatch !== undefined && !ignoreIfMatch) {
          const now = current(bucket, key);
          if (!now) {
            record({ op: "PutObject", key, status: 404, ifMatch });
            return s3Error("NoSuchKey", 404);
          }
          if (now.etag !== ifMatch) {
            record({ op: "PutObject", key, status: 412, ifMatch });
            return s3Error("PreconditionFailed", 412);
          }
        }
        const etag = `"${md5hex(body)}"`;
        const id = push(bucket, key, {
          versionId: nextVersionId(),
          deleteMarker: false,
          data: body,
          etag,
          lastModified: new Date().toISOString(),
          contentType: req.headers.get("content-type") ?? "binary/octet-stream",
          sse: req.headers.get("x-amz-server-side-encryption") ?? undefined,
          kmsKeyId: req.headers.get("x-amz-server-side-encryption-aws-kms-key-id") ?? undefined,
          cacheControl: req.headers.get("cache-control") ?? undefined,
          lock,
        });
        record({
          op: "PutObject",
          key,
          status: 200,
          size: body.length,
          ifMatch,
          ifNoneMatch,
          checksum,
        });
        return new Response(null, { status: 200, headers: { ETag: etag, "x-amz-version-id": id } });
      }

      // ---- DeleteObject ----
      if (req.method === "DELETE") {
        const bypass = req.headers.get("x-amz-bypass-governance-retention") === "true";
        const fault = enter("DeleteObject", key);
        if (fault) return fail("DeleteObject", fault, { versionId, bypass });
        const arr = versionsOf(bucket, key);
        if (!versionId) {
          // On a versioned bucket a delete with no version id only adds a marker, locked or not.
          const id = push(bucket, key, {
            versionId: nextVersionId(),
            deleteMarker: true,
            data: new Uint8Array(0),
            etag: "",
            lastModified: new Date().toISOString(),
            contentType: "",
          });
          record({ op: "DeleteObject", key, status: 204, versionId: null, bypass });
          return new Response(null, {
            status: 204,
            headers: { "x-amz-delete-marker": "true", "x-amz-version-id": id },
          });
        }
        const idx = arr.findIndex((v) => v.versionId === versionId);
        if (idx < 0) {
          record({ op: "DeleteObject", key, status: 404, versionId, bypass });
          return s3Error("NoSuchVersion", 404);
        }
        const v = arr[idx] as StoredVersion;
        if (!v.deleteMarker && v.lock && v.lock.until.getTime() > Date.now()) {
          const allowed = v.lock.mode === "GOVERNANCE" && bypass && !denyBypass;
          if (!allowed) {
            record({ op: "DeleteObject", key, status: 403, versionId, bypass });
            return s3Error(
              "AccessDenied",
              403,
              "Access Denied because object protected by object lock.",
            );
          }
        }
        arr.splice(idx, 1);
        record({ op: "DeleteObject", key, status: 204, versionId, bypass });
        return new Response(null, { status: 204, headers: { "x-amz-version-id": versionId } });
      }

      record({ op: "Unknown", key, status: 501, method: req.method });
      return s3Error("NotImplemented", 501);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    log,
    putObject(bucket, key, data, opts = {}) {
      return push(bucket, key, {
        versionId: nextVersionId(),
        deleteMarker: false,
        data,
        etag: `"${md5hex(data)}"`,
        lastModified: new Date().toISOString(),
        contentType: opts.contentType ?? "binary/octet-stream",
        sse: opts.sse,
        kmsKeyId: opts.kmsKeyId,
        cacheControl: opts.cacheControl,
        lock: opts.lockUntil
          ? { mode: opts.lockMode ?? "GOVERNANCE", until: opts.lockUntil }
          : undefined,
      });
    },
    putDeleteMarker(bucket, key) {
      return push(bucket, key, {
        versionId: nextVersionId(),
        deleteMarker: true,
        data: new Uint8Array(0),
        etag: "",
        lastModified: new Date().toISOString(),
        contentType: "",
      });
    },
    versions: (bucket, key) => [...versionsOf(bucket, key)],
    current: (bucket, key) => current(bucket, key),
    keys(bucket, prefix) {
      return [...store.entries()]
        .filter(([s, vs]) => s.startsWith(`${bucket}/${prefix}`) && vs.length > 0)
        .map(([s]) => s.slice(bucket.length + 1))
        .sort();
    },
    corruptByte(bucket, key, versionId, offset) {
      const v = versionsOf(bucket, key).find((x) => x.versionId === versionId);
      if (!v) throw new Error("no such version in the stand-in");
      v.data[offset] = (v.data[offset] as number) ^ 0xff;
    },
    clearLock(bucket, key, versionId) {
      const v = versionsOf(bucket, key).find((x) => x.versionId === versionId);
      if (!v) throw new Error("no such version in the stand-in");
      v.lock = undefined;
    },
    setLock(bucket, key, versionId, mode, until) {
      const v = versionsOf(bucket, key).find((x) => x.versionId === versionId);
      if (!v) throw new Error("no such version in the stand-in");
      v.lock = { mode, until };
    },
    dropVersion(bucket, key, versionId) {
      const arr = versionsOf(bucket, key);
      const idx = arr.findIndex((x) => x.versionId === versionId);
      if (idx < 0) throw new Error("no such version in the stand-in");
      arr.splice(idx, 1);
    },
    snapshot() {
      const copy: Snapshot = new Map();
      for (const [k, vs] of store) {
        copy.set(
          k,
          vs.map((v) => ({ ...v, data: v.data.slice(), lock: v.lock ? { ...v.lock } : undefined })),
        );
      }
      return copy;
    },
    restore(snapshot) {
      store.clear();
      for (const [k, vs] of snapshot) {
        store.set(
          k,
          vs.map((v) => ({ ...v, data: v.data.slice(), lock: v.lock ? { ...v.lock } : undefined })),
        );
      }
      uploads.clear();
      log.length = 0;
      faults.clear();
      hooks.clear();
      opCounts.clear();
      denyBypass = false;
      ignoreIfMatch = false;
      pageSize = 1000;
      stalls.length = 0;
      bodyStalls.length = 0;
    },
    openUploads: () => uploads.size,
    setDenyBypass(deny) {
      denyBypass = deny;
    },
    setIgnoreIfMatch(ignore) {
      ignoreIfMatch = ignore;
    },
    setPageSize(n) {
      pageSize = n;
    },
    omitNextVersionIdMarker(on = true) {
      omitVersionIdMarker = on;
    },
    stallNext(method, ms, times = 1) {
      stalls.push({ method, ms, times });
    },
    stallBodyNext(opts) {
      bodyStalls.push(opts);
    },
    inject(op, fault) {
      const list = faults.get(op) ?? [];
      list.push({ ...fault, seen: 0, failed: 0 });
      faults.set(op, list);
    },
    clearFaults() {
      faults.clear();
    },
    beforeOp(op, fn, nth = 1) {
      const list = hooks.get(op) ?? [];
      list.push({ fn, nth });
      hooks.set(op, list);
    },
    calls: (op) => log.filter((e) => e.op === op),
    opCount: (op) => opCounts.get(op) ?? 0,
    stop() {
      server.stop(true);
    },
  };
}
