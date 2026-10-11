/**
 * HMAC callback tokens for GitHub-Actions -> Worker callbacks: per-job
 * manifest tokens and per-request prescreen tokens. Pure WebCrypto; no
 * GitHub API calls. (GitHub App/PAT auth lives in services/github-auth.ts,
 * not here.)
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import { timingSafeEqual } from "../../lib/constant-time";

// ============================================================================
// Manifest callback HMAC tokens
// ============================================================================
//
// The Worker signs a one-shot HMAC-SHA256 token over {dataset_id, version,
// nonce} with `MANIFEST_CALLBACK_SECRET` and includes it in the dispatch
// `client_payload.callback_token`. The central workflow echoes it back in
// the `X-Webhook-Token` header on `/webhooks/manifest-ready`. The Worker
// re-derives the expected signature and rejects any mismatch with
// constant-time compare.
//
// Single-use is enforced by the `manifest_jobs` row (UNIQUE on
// (dataset_id, version, nonce) + status flip), not by the HMAC itself.
// The HMAC just proves the central workflow saw the dispatch payload.

export interface ManifestCallbackPayload {
  datasetId: string;
  version: string;
  nonce: string;
}

/** Canonical payload encoding -- pinned so signer and verifier agree. */
function encodeManifestCallbackPayload(payload: ManifestCallbackPayload): string {
  return `${payload.datasetId}\n${payload.version}\n${payload.nonce}`;
}

function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Sign a manifest callback payload with HMAC-SHA256.
 * Returns a hex-encoded digest. Uses Workers' built-in `crypto.subtle`.
 */
export async function signManifestCallbackToken(
  payload: ManifestCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signManifestCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodeManifestCallbackPayload(payload)),
  );
  return toHex(signature);
}

/**
 * Verify a manifest callback token against a claimed payload.
 * Constant-time compare via `lib/constant-time.ts`'s `timingSafeEqual`
 * (Workers' `crypto.subtle.timingSafeEqual`, or a portable XOR-accumulate
 * on runtimes without it) to defeat timing oracles. Returns true iff the
 * digest matches.
 */
export async function verifyManifestCallbackToken(
  token: string,
  payload: ManifestCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  // Crypto failures here mean MANIFEST_CALLBACK_SECRET is malformed; surface
  // as 500 (via Hono's default error handler) not 401, so operators can
  // distinguish "broken secret on worker" from "wrong token from caller".
  const expected = await signManifestCallbackToken(payload, secret);
  return timingSafeEqual(token, expected);
}

// ============================================================================
// Pre-screen callback HMAC tokens (issue #666)
// ============================================================================
//
// Same one-shot HMAC handshake as the manifest callback above, signed over
// {dataset_id, request_id, nonce}. The Worker stores the nonce on the
// publication_requests row at dispatch time and puts the token in the
// dispatch client_payload; the workflow echoes it back in X-Webhook-Token.
// Single-use is enforced by the row's prescreen_status='pending' -> done
// flip, not the HMAC itself.

export interface PrescreenCallbackPayload {
  datasetId: string;
  requestId: number;
  nonce: string;
}

/** Canonical payload encoding -- pinned so signer and verifier agree. */
function encodePrescreenCallbackPayload(payload: PrescreenCallbackPayload): string {
  return `${payload.datasetId}\n${payload.requestId}\n${payload.nonce}`;
}

/** Sign a pre-screen callback payload with HMAC-SHA256 (hex digest). */
export async function signPrescreenCallbackToken(
  payload: PrescreenCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signPrescreenCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodePrescreenCallbackPayload(payload)),
  );
  return toHex(signature);
}

/** Verify a pre-screen callback token (constant-time). */
export async function verifyPrescreenCallbackToken(
  token: string,
  payload: PrescreenCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const expected = await signPrescreenCallbackToken(payload, secret);
  return timingSafeEqual(token, expected);
}

// ============================================================================
// Identifier-screen callback HMAC tokens (epic #1610, phase 4)
// ============================================================================
//
// The same one-shot handshake as the pre-screen token above, over the same
// {dataset_id, request_id, nonce}, and signed with the SAME secret
// (PRESCREEN_CALLBACK_SECRET): a second Worker secret would be one more thing to
// provision on two Workers and forget on one. Sharing the key is safe only
// because the signed message is DOMAIN-SEPARATED: it begins with a fixed tag
// that no pre-screen message can begin with (a pre-screen message begins with a
// dataset id, and its request id is a number, so it can never reproduce the
// tag line followed by a dataset id line). Without the tag, a pre-screen token
// for a request would also be a valid identifier-screen token for the same
// request and nonce, and one workflow could answer for the other.
//
// Single-use is enforced by the row (`identifier_screen_status = 'pending'` and
// the nonce, both cleared when a result is stored), not by the HMAC.

/** The first line of every identifier-screen message. Never shared with another token kind. */
export const IDENTIFIER_SCREEN_TOKEN_DOMAIN = "identifier-screen";

export interface IdentifierScreenCallbackPayload {
  datasetId: string;
  requestId: number;
  nonce: string;
}

/** Canonical, domain-tagged payload encoding -- pinned so signer and verifier agree. */
function encodeIdentifierScreenCallbackPayload(payload: IdentifierScreenCallbackPayload): string {
  return `${IDENTIFIER_SCREEN_TOKEN_DOMAIN}\n${payload.datasetId}\n${payload.requestId}\n${payload.nonce}`;
}

/** Sign an identifier-screen callback payload with HMAC-SHA256 (hex digest). */
export async function signIdentifierScreenCallbackToken(
  payload: IdentifierScreenCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signIdentifierScreenCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodeIdentifierScreenCallbackPayload(payload)),
  );
  return toHex(signature);
}

/** Verify an identifier-screen callback token (constant-time). */
export async function verifyIdentifierScreenCallbackToken(
  token: string,
  payload: IdentifierScreenCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const expected = await signIdentifierScreenCallbackToken(payload, secret);
  return timingSafeEqual(token, expected);
}

// ============================================================================
// Identifier-sweep callback HMAC tokens (epic #1610, phase 5, ADR 0088)
// ============================================================================
//
// The scheduled sweep dispatches the same screen workflow as a publication
// request, with its own callback route and a token of its own kind. Signed with
// the same secret for the reason the identifier-screen token gives, and
// domain-separated the same way: the message begins with a tag line that no
// other kind's message can begin with (`identifier-screen` differs from it, and
// a pre-screen message begins with a dataset id). Without the tag a sweep token
// could be replayed at the publication callback, or the reverse.
//
// There is no request: the token binds the dataset and the attempt's nonce,
// and the workflow echoes `request_id` 0. Single-use is enforced by the
// dataset row (`$.identifier_sweep_nonce`, cleared when a result is stored),
// not by the HMAC.

/** The first line of every identifier-sweep message. Never shared with another token kind. */
export const IDENTIFIER_SWEEP_TOKEN_DOMAIN = "identifier-sweep";

export interface IdentifierSweepCallbackPayload {
  datasetId: string;
  nonce: string;
}

/** Canonical, domain-tagged payload encoding, pinned so signer and verifier agree. */
function encodeIdentifierSweepCallbackPayload(payload: IdentifierSweepCallbackPayload): string {
  return `${IDENTIFIER_SWEEP_TOKEN_DOMAIN}\n${payload.datasetId}\n${payload.nonce}`;
}

/** Sign an identifier-sweep callback payload with HMAC-SHA256 (hex digest). */
export async function signIdentifierSweepCallbackToken(
  payload: IdentifierSweepCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signIdentifierSweepCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodeIdentifierSweepCallbackPayload(payload)),
  );
  return toHex(signature);
}

/** Verify an identifier-sweep callback token (constant-time). */
export async function verifyIdentifierSweepCallbackToken(
  token: string,
  payload: IdentifierSweepCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const expected = await signIdentifierSweepCallbackToken(payload, secret);
  return timingSafeEqual(token, expected);
}

// ============================================================================
// PR-review callback HMAC tokens (ADR 0092)
// ============================================================================
//
// The pull-request review workflow claims its review at /webhooks/pr-review-claim and posts its
// report to /webhooks/pr-review-result with one token. Signed with the same secret as the pre-screen and identifier-screen tokens
// (PRESCREEN_CALLBACK_SECRET, one fewer secret to provision on two Workers) and
// DOMAIN-SEPARATED the same way: the message begins with a tag line no other kind's message can
// begin with, so a token minted for any other callback cannot answer for a review, and a review
// token cannot answer for them.
//
// The token binds the dataset, the review row and the attempt's nonce. Single-use is enforced by
// the row (`state` and `nonce`, cleared when a result is stored), not by the HMAC.

/** The first line of every PR-review message. Never shared with another token kind. */
export const PR_REVIEW_TOKEN_DOMAIN = "pr-review";

export interface PrReviewCallbackPayload {
  datasetId: string;
  reviewId: number;
  nonce: string;
}

/** Canonical, domain-tagged payload encoding, pinned so signer and verifier agree. */
function encodePrReviewCallbackPayload(payload: PrReviewCallbackPayload): string {
  return `${PR_REVIEW_TOKEN_DOMAIN}\n${payload.datasetId}\n${payload.reviewId}\n${payload.nonce}`;
}

/** Sign a PR-review callback payload with HMAC-SHA256 (hex digest). */
export async function signPrReviewCallbackToken(
  payload: PrReviewCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signPrReviewCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodePrReviewCallbackPayload(payload)),
  );
  return toHex(signature);
}

/** Verify a PR-review callback token (constant-time). */
export async function verifyPrReviewCallbackToken(
  token: string,
  payload: PrReviewCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const expected = await signPrReviewCallbackToken(payload, secret);
  return timingSafeEqual(token, expected);
}
