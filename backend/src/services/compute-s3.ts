/**
 * The compute gateway's S3-API signer (epic #2005 phase A3, #2008; ADR 0118, decision 7).
 *
 * Compute storage is two private Cloudflare R2 buckets, reached by the Worker through bindings
 * (`COMPUTE_RECORDS`, `COMPUTE_RESULTS`). A binding has no copy and no presigned address, and hides
 * its bucket's name, so the few things a binding cannot do go through R2's S3 interface: a presigned
 * PUT for one file of one job (the only way a job's bytes reach a bucket, since no storage credential
 * reaches Tapis, a node or the launcher), a presigned GET, and a server-side `CopyObject` (a bundle
 * from `incoming/` into the locked `records/`). They are signed here with aws4fetch against the
 * account endpoint, path style, region `auto`.
 *
 * `generatePresignedPutUrls` and `generatePresignedGetUrl` of `s3.ts` cannot be used: they hardcode
 * the AWS host.
 *
 * A THIRD BUCKET, the derivative store's (portable compute, card V1b; ADR 0123): `derivatives`, named by
 * `COMPUTE_DERIVATIVES_BUCKET_NAME`, which is optional (the store is dark without it). It is addressed by
 * the same endpoint and the same R2 token as the other two, and it is reached ONLY by `copyObject` (a
 * server-side copy from the results bucket) and by the Worker's binding: `presignPut` and `presignGet`
 * refuse it, so no address into it can be made.
 *
 * THE ENDPOINT. It is `globalThis.NEMAR_COMPUTE_S3_URL` when set, else the Worker secret
 * `COMPUTE_R2_S3_ENDPOINT` (the account endpoint, which is never written in this public repository).
 * `testS3EndpointOverride` is not used, and `S3_ENDPOINT_URL` is never read here: that seam is dead in
 * production, so a test that runs the production flag could not otherwise reach a stand-in. A
 * deployed Worker cannot set a global, so the override cannot be present in one.
 *
 * THE KEY. A key is built from segments the caller names and encoded once, segment by segment, so
 * `a..b.csv`, `100%.txt`, `a+b` and a name with a space or a non-ASCII character all round-trip. It
 * is refused if it could escape (an empty, `.` or `..` segment, a backslash or a control character:
 * the contract's own predicate, `COMPUTE_PATH_RE`, so the Worker and the launcher judge one thing)
 * or if it is longer than the 1,024 bytes a key may be. `assertValidS3Key` is NOT used: it refuses
 * any `..` inside a name and throws on a stray `%`, which would fail an upload for a name the
 * launcher was entitled to use.
 *
 * AN EXPIRY is a whole number of seconds from 1 to 604,800 (seven days, the limit of S3 and of R2),
 * and anything else is refused before anything is signed.
 *
 * THE CHECKSUM. `x-amz-checksum-sha256` can be signed with a PUT's URL: aws4fetch signs any header it
 * is given, and a client that omits it or sends another body is refused. WHETHER R2 ENFORCES IT ON A
 * PRESIGNED PUT HAS NOT BEEN CHECKED AGAINST THE REAL SERVICE (no test here can reach it); until it
 * is, the bound the Worker itself relies on is the object's size, read back through the binding.
 */

import { AwsClient } from "aws4fetch";
import { COMPUTE_PATH_RE, isSafeComputePath } from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";

/** The longest expiry S3 and R2 take: seven days. */
export const COMPUTE_PRESIGN_MAX_SECONDS = 7 * 24 * 3600;

/** What an upload address lives: one hour, and a launcher or a client asks again after it. */
export const COMPUTE_UPLOAD_SECONDS = 3600;

/** What the launcher's address for a job's own code bundle lives: ten minutes. */
export const COMPUTE_BUNDLE_READ_SECONDS = 600;

/** What an owner's read of one submitted file or log lives: five minutes. */
export const COMPUTE_RECORD_READ_SECONDS = 300;

/**
 * The most bytes R2 copies in one `CopyObject` request, and the most one presigned PUT takes: 5 GiB
 * (a larger object needs a multipart copy or upload, which is not verified on R2). A caller's own limit
 * above it does not lift it.
 */
export const COPY_OBJECT_MAX_BYTES = 5 * 1024 ** 3;

/** The longest key R2 and S3 take, in bytes of UTF-8. */
export const COMPUTE_KEY_MAX_BYTES = 1024;

/**
 * The compute buckets the signer can address. `derivatives` (portable compute, card V1b; ADR 0123) is
 * reached ONLY by a server-side copy and by the Worker's own binding: no address is ever presigned for it,
 * so no person's key, no launcher and no node can read or write it (`presignPut` and `presignGet` take a
 * {@link PresignBucket}, and refuse `derivatives` at run time as well).
 */
export type ComputeBucket = "records" | "results" | "derivatives";

/** The buckets an address may be presigned for: never the derivatives bucket. */
export type PresignBucket = Exclude<ComputeBucket, "derivatives">;

export type ComputeS3ErrorCode =
  | "expiry_invalid"
  | "key_invalid"
  | "digest_invalid"
  | "copy_failed"
  | "bucket_unbound"
  | "bucket_not_presignable";

/**
 * A signing or copying error with a fixed code. The message never holds a key, a bucket or a
 * response: a log line carries the code and the status, nothing a person chose.
 */
export class ComputeS3Error extends Error {
  constructor(
    readonly code: ComputeS3ErrorCode,
    message: string,
    /** The HTTP status the interface answered with, for a refused copy; a number, never a body. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "ComputeS3Error";
  }
}

/**
 * What the signer reads of the environment. The first five are needed; the derivatives bucket's name is
 * optional, and without it the signer still works for the records and results buckets and `derivatives`
 * is `null` (the store is dark until the owner names its bucket).
 */
export type ComputeS3Env = Partial<
  Pick<
    Bindings,
    | "COMPUTE_R2_S3_ENDPOINT"
    | "COMPUTE_R2_ACCESS_KEY_ID"
    | "COMPUTE_R2_SECRET_ACCESS_KEY"
    | "COMPUTE_RECORDS_BUCKET_NAME"
    | "COMPUTE_RESULTS_BUCKET_NAME"
    | "COMPUTE_DERIVATIVES_BUCKET_NAME"
  >
>;

export interface ComputeS3 {
  readonly client: AwsClient;
  /** The account endpoint, no trailing slash. */
  readonly endpoint: string;
  /** The records bucket's name, which a binding hides and the S3 interface needs. */
  readonly records: string;
  /** The results bucket's name. */
  readonly results: string;
  /** The derivatives bucket's name, or null while the owner has not named one. */
  readonly derivatives: string | null;
}

const present = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * The endpoint requests are signed for: the test global when set, else the Worker secret, else null.
 * Read at call time, so a test sets and clears the global around its cases.
 */
export function computeS3Endpoint(env: ComputeS3Env): string | null {
  const override = (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL;
  const endpoint = present(override) ? override : env.COMPUTE_R2_S3_ENDPOINT;
  return present(endpoint) ? endpoint.trim().replace(/\/+$/, "") : null;
}

/**
 * The signer: an aws4fetch client (region `auto`) with the endpoint and both bucket names, or null
 * when anything is missing, so a Worker that was never given the secrets reports `compute_disabled`
 * and signs nothing. No retry: a copy that failed is retried by the caller's own idempotent step.
 */
export function computeS3(env: ComputeS3Env): ComputeS3 | null {
  const endpoint = computeS3Endpoint(env);
  const accessKeyId = env.COMPUTE_R2_ACCESS_KEY_ID;
  const secretAccessKey = env.COMPUTE_R2_SECRET_ACCESS_KEY;
  const records = env.COMPUTE_RECORDS_BUCKET_NAME;
  const results = env.COMPUTE_RESULTS_BUCKET_NAME;
  const derivatives = env.COMPUTE_DERIVATIVES_BUCKET_NAME;
  if (
    endpoint === null ||
    !present(accessKeyId) ||
    !present(secretAccessKey) ||
    !present(records) ||
    !present(results)
  ) {
    return null;
  }
  return {
    client: new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: "auto",
      retries: 0,
    }),
    endpoint,
    records: records.trim(),
    results: results.trim(),
    // The derivatives bucket is NEVER one of the other two: those are presignable and the results bucket
    // expires its objects, so a derivative stored there would be readable through an address and lost in 30
    // days. A name that is the records or the results bucket's own is no name: the store is dark.
    derivatives:
      present(derivatives) &&
      derivatives.trim() !== records.trim() &&
      derivatives.trim() !== results.trim()
        ? derivatives.trim()
        : null,
  };
}

/**
 * Why a key may not be signed, or null when it may: the contract's path predicate (no empty, `.` or
 * `..` segment, no backslash, no control character, no leading slash) and a length of at most 1,024
 * bytes of UTF-8. A `..` INSIDE a name (`a..b.csv`) and a `%` are fine.
 */
export function objectKeyProblem(key: string): string | null {
  if (typeof key !== "string" || key.length === 0) return "empty";
  if (key.length > COMPUTE_KEY_MAX_BYTES) return "too_long";
  if (!COMPUTE_PATH_RE.test(key) || !isSafeComputePath(key, COMPUTE_KEY_MAX_BYTES)) return "unsafe";
  if (new TextEncoder().encode(key).length > COMPUTE_KEY_MAX_BYTES) return "too_long";
  return null;
}

function assertKey(key: string): void {
  if (objectKeyProblem(key) !== null) {
    throw new ComputeS3Error("key_invalid", "the key is not one that may be signed");
  }
}

function assertExpiry(expiresIn: number): void {
  if (
    typeof expiresIn !== "number" ||
    !Number.isInteger(expiresIn) ||
    expiresIn < 1 ||
    expiresIn > COMPUTE_PRESIGN_MAX_SECONDS
  ) {
    throw new ComputeS3Error(
      "expiry_invalid",
      "an expiry is a whole number of seconds from 1 to 604800",
    );
  }
}

/** A key as it goes in a path: each segment percent-encoded once, the slashes kept. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function bucketName(s3: ComputeS3, bucket: ComputeBucket): string {
  if (bucket === "records") return s3.records;
  if (bucket === "results") return s3.results;
  if (s3.derivatives === null) {
    throw new ComputeS3Error("bucket_unbound", "the derivatives bucket has no name");
  }
  return s3.derivatives;
}

/** `<endpoint>/<bucket>/<key, encoded>`: path style, because the bucket is not a host here. */
function objectUrl(s3: ComputeS3, bucket: ComputeBucket, key: string): string {
  return `${s3.endpoint}/${bucketName(s3, bucket)}/${encodeKey(key)}`;
}

/** `20261104T080000Z` as a time: the moment aws4fetch signed, read back from the URL it made. */
function signedAt(url: string): number {
  const date = new URL(url).searchParams.get("X-Amz-Date") ?? "";
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!m) throw new Error("a signed address carries no date");
  return Date.UTC(
    +(m[1] as string),
    +(m[2] as string) - 1,
    +(m[3] as string),
    +(m[4] as string),
    +(m[5] as string),
    +(m[6] as string),
  );
}

/** `YYYYMMDDTHHMMSSZ`, the form aws4fetch takes for a date it did not choose itself. */
function amzDate(when: Date): string {
  return when.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export interface Presigned {
  url: string;
  /** Headers the client must send with the request, because they are part of the signature. */
  headers: Record<string, string>;
  /** When the address stops working, as an ISO time, taken from the moment it was signed. */
  expires_at: string;
}

export interface PresignOptions {
  /** Whole seconds, 1 to 604,800; required, so every caller says how long its address lives. */
  expiresIn: number;
  /** A time to sign as of; tests use it to make an address that has already expired. */
  now?: Date;
}

export interface PresignPutOptions extends PresignOptions {
  /** The object's SHA-256 as 64 lowercase hex digits, signed with the URL as `x-amz-checksum-sha256`. */
  sha256Hex?: string;
}

function hexToBase64(hex: string): string {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2)
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(binary);
}

async function presign(
  s3: ComputeS3,
  bucket: PresignBucket,
  key: string,
  method: "PUT" | "GET",
  options: PresignOptions,
  headers: Record<string, string>,
): Promise<Presigned> {
  // The type already refuses it; a caller that gets round the type is refused here, before anything is
  // signed: nobody is ever given an address into the derivatives bucket (ADR 0123 decision 1).
  if ((bucket as ComputeBucket) === "derivatives") {
    throw new ComputeS3Error(
      "bucket_not_presignable",
      "no address is signed for the derivatives bucket",
    );
  }
  assertKey(key);
  assertExpiry(options.expiresIn);
  // The expiry is in the URL BEFORE signing, so that it is part of the signature.
  const url = `${objectUrl(s3, bucket, key)}?X-Amz-Expires=${options.expiresIn}`;
  const signed = await s3.client.sign(url, {
    method,
    headers,
    aws: { signQuery: true, ...(options.now ? { datetime: amzDate(options.now) } : {}) },
  });
  const when = signedAt(signed.url);
  return {
    url: signed.url,
    headers,
    expires_at: new Date(when + options.expiresIn * 1000).toISOString(),
  };
}

/** A presigned PUT of one object, valid `expiresIn` seconds, with the checksum header when a digest is given. */
export async function presignPut(
  s3: ComputeS3,
  bucket: PresignBucket,
  key: string,
  options: PresignPutOptions,
): Promise<Presigned> {
  const headers: Record<string, string> = {};
  if (options.sha256Hex !== undefined) {
    if (typeof options.sha256Hex !== "string" || !/^[0-9a-f]{64}$/.test(options.sha256Hex)) {
      throw new ComputeS3Error("digest_invalid", "a digest is 64 lowercase hex digits");
    }
    headers["x-amz-checksum-sha256"] = hexToBase64(options.sha256Hex);
  }
  return presign(s3, bucket, key, "PUT", options, headers);
}

/** A presigned GET of one object, valid `expiresIn` seconds. */
export async function presignGet(
  s3: ComputeS3,
  bucket: PresignBucket,
  key: string,
  options: PresignOptions,
): Promise<Presigned> {
  return presign(s3, bucket, key, "GET", options, {});
}

/**
 * How long a copy may take before it is given up on. A server-side copy inside R2 moves no bytes
 * through the Worker; 30 seconds is for the largest object a single copy takes, which
 * `COPY_OBJECT_MAX_BYTES` bounds at 5 GiB (the owner's limits are 100 MiB by default and, in the
 * contract, unbounded, so the callers clamp them to that bound before they ask).
 */
const COPY_TIMEOUT_MS = 30_000;

/**
 * A server-side copy (`CopyObject`, `x-amz-copy-source`), signed by header, from one key to another:
 * the bytes never pass through the Worker. Throws `ComputeS3Error('copy_failed')` for any status but
 * 2xx and for a 2xx whose body is an error (S3 can fail a copy after it has answered), with no key and
 * no response in the message. The caller checks the copy by reading its size back.
 */
export async function copyObject(
  s3: ComputeS3,
  from: { bucket: ComputeBucket; key: string },
  to: { bucket: ComputeBucket; key: string },
): Promise<void> {
  assertKey(from.key);
  assertKey(to.key);
  const source = `/${bucketName(s3, from.bucket)}/${encodeKey(from.key)}`;
  let response: Response;
  try {
    response = await s3.client.fetch(objectUrl(s3, to.bucket, to.key), {
      method: "PUT",
      headers: { "x-amz-copy-source": source },
      signal: AbortSignal.timeout(COPY_TIMEOUT_MS),
    });
  } catch {
    throw new ComputeS3Error("copy_failed", "the copy could not be sent");
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new ComputeS3Error(
      "copy_failed",
      `the copy was refused with HTTP ${response.status}`,
      response.status,
    );
  }
  if (/<Error[\s>]/.test(body)) {
    throw new ComputeS3Error("copy_failed", "the copy answered with an error");
  }
}
