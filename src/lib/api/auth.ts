/**
 * NEMAR API client: authentication, account, and sandbox-training endpoints.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import type { DocsCliSessionResponse } from "../../../shared/contract/docs-auth.js";
import {
  type ApiKeyCreateResponse,
  type ApiKeyListResponse,
  type ContractUser,
  DEVICE_GRANT_MESSAGES,
  type DeviceAuthRefusalCode,
  type DeviceGrantError,
  type DeviceStartResponse,
  type DeviceTokenSuccess,
  type UsernameSuggestionResponse,
  apiKeyCreateResponseSchema,
  apiKeyListResponseSchema,
  deviceGrantErrorSchema,
  deviceStartResponseSchema,
  deviceTokenErrorSchema,
  deviceTokenSuccessSchema,
  userMeResponseSchema,
  usernameSuggestionResponseSchema,
} from "../../../shared/contract/index.js";
import type { OrcidNameLookupStatus } from "../../../shared/contract/publication.js";
import { request } from "./client.js";
import { ApiError } from "./errors.js";

// ============================================================================
// Authentication
// ============================================================================

// ============================================================================
// Pre-signup validation
// ============================================================================

export interface CheckUsernameResponse {
  available: boolean;
  reason?: string;
}

/**
 * Check if a username is available
 */
export async function checkUsername(username: string): Promise<CheckUsernameResponse> {
  return request<CheckUsernameResponse>(
    `/auth/check-username?username=${encodeURIComponent(username)}`,
  );
}

export interface CheckGitHubResponse {
  valid: boolean;
  username?: string;
  registered?: boolean;
}

/**
 * Check if a GitHub username exists
 */
export async function checkGitHubUsername(username: string): Promise<CheckGitHubResponse> {
  return request<CheckGitHubResponse>(
    `/auth/check-github?username=${encodeURIComponent(username)}`,
  );
}

export interface OrcidNameResponse {
  /** `found` only when the record yielded BOTH name parts; the other two are
   *  kept apart so the caller can say WHY it is asking (#1255). */
  status: OrcidNameLookupStatus;
  given_name: string | null;
  family_name: string | null;
}

/**
 * Look up the given/family name on a public ORCID record before signing up.
 */
export async function checkOrcidName(orcid: string): Promise<OrcidNameResponse> {
  return request<OrcidNameResponse>(`/auth/orcid-name?orcid=${encodeURIComponent(orcid)}`);
}

export interface LoginRequest {
  api_key: string;
}

export interface LoginResponse {
  valid: boolean;
  user: {
    // Nullable (epic #1272 phase 3; ADR 0047): `POST /auth/login` shares its
    // user shape with `POST /auth/device/token`'s success response, and a
    // brand-new ORCID account has no username until
    // `refreshNameThenAssignUsername` runs after finalize -- a --key paste
    // moments after signup can present the same still-unset column.
    username: string | null;
    email: string;
    github_username: string;
    role: "owner" | "admin" | "member";
    sandbox_completed: boolean;
    sandbox_dataset_id?: string;
  };
}

/**
 * Validate an API key and get user info
 */
export async function login(apiKey: string): Promise<LoginResponse> {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ api_key: apiKey }),
  });
}

export interface ResendVerificationRequest {
  email: string;
}

/**
 * Resend verification email
 */
export async function resendVerification(email: string): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function requestKeyRegeneration(email: string): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/request-key-regeneration", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// ============================================================================
// User
// ============================================================================

/**
 * Get current user info (requires authentication).
 *
 * `/users/me` returns a NESTED envelope `{ user, token }`; this unwraps `.user`
 * (typed by the shared contract's `ContractUser`). Previously it declared a
 * flat `UserInfo` and did `request<UserInfo>` on the envelope, so every field
 * read (`.username`, `.role`, `.orcid`, ...) was
 * `undefined` at runtime, silently writing `undefined` over stored account
 * config on `auth status --refresh` and disabling the upload ORCID auto-match
 * (#895 / epic #896 #899). Validated against the shared contract so a future
 * shape drift fails loud here instead of silently.
 */
export async function getCurrentUser(): Promise<ContractUser> {
  const res = await request("/users/me", {}, true, userMeResponseSchema);
  return res.user;
}

// ============================================================================
// SSH Key Management
// TODO: These functions are prepared for future backend-managed SSH key registration.
// Currently, setup-ssh guides users to manually add keys to GitHub.
// ============================================================================

export interface RegisterSSHKeyResponse {
  message: string;
  key_id: number;
  key_title: string;
}

/**
 * Register an SSH public key with GitHub via the backend
 * The backend uses the user's GitHub credentials to add the deploy key
 *
 * Note: Not yet used; users currently add keys manually via GitHub UI.
 */
export async function registerSSHKey(publicKey: string): Promise<RegisterSSHKeyResponse> {
  return request<RegisterSSHKeyResponse>(
    "/auth/ssh-key",
    {
      method: "POST",
      body: JSON.stringify({ public_key: publicKey }),
    },
    true,
  );
}

/**
 * Check if user has an SSH key registered
 *
 * Note: Not yet used; users currently add keys manually via GitHub UI.
 */
export async function checkSSHKeyStatus(): Promise<{ registered: boolean; key_title?: string }> {
  return request<{ registered: boolean; key_title?: string }>("/auth/ssh-key", {}, true);
}

// ============================================================================
// Sandbox Training
// ============================================================================

export interface SandboxCompleteResponse {
  message: string;
  sandbox_completed: boolean;
  sandbox_dataset_id: string;
}

/**
 * Mark sandbox training as complete (called after successful sandbox upload)
 */
export async function completeSandbox(datasetId: string): Promise<SandboxCompleteResponse> {
  return request<SandboxCompleteResponse>(
    "/sandbox/complete",
    {
      method: "POST",
      body: JSON.stringify({ dataset_id: datasetId }),
    },
    true,
  );
}

/**
 * Reset sandbox training status (for testing or re-training)
 */
export async function resetSandbox(): Promise<{ message: string }> {
  return request<{ message: string }>(
    "/sandbox/reset",
    {
      method: "POST",
    },
    true,
  );
}

/**
 * Get sandbox training status
 */
export async function getSandboxStatus(): Promise<{
  sandbox_completed: boolean;
  sandbox_dataset_id?: string;
  sandbox_completed_at?: string;
}> {
  return request<{
    sandbox_completed: boolean;
    sandbox_dataset_id?: string;
    sandbox_completed_at?: string;
  }>("/sandbox/status", {}, true);
}

// ============================================================================
// Upload access (ADR 0042, #1253)
// ============================================================================

export interface UploadAccessRequestResponse {
  ok: true;
  /** True when a request was already open. */
  already_requested: boolean;
  requested_at?: string | null;
  /**
   * Whether at least one admin actually received the review card. False means
   * the request IS recorded but nobody was told yet; calling again re-sends
   * (ADR 0042). Optional so a backend that predates the second stamp reads as
   * "unknown" rather than as a failure.
   */
  email_sent?: boolean;
  /** Admins reached. `null` on a repeat call for an already-notified request,
   *  where the count belongs to the original send and is not re-derived. */
  admins_notified?: number | null;
}

/**
 * Ask for upload access, once. Every precondition failure arrives as an
 * ApiError whose `missing` names the account fields still to fill in, so the
 * caller can print them rather than a single sentence (see errors.ts).
 */
export async function requestUploadAccess(why: string): Promise<UploadAccessRequestResponse> {
  return request<UploadAccessRequestResponse>(
    "/users/me/upload-access/request",
    {
      method: "POST",
      body: JSON.stringify({ why }),
    },
    true,
  );
}

// ============================================================================
// Self-service identity edits (#1266, epic #1250; ADR 0044)
// ============================================================================
//
// The same routes the website's Settings page uses, reached with the CLI's
// bearer token instead of a session cookie. Every refusal arrives as an
// ApiError whose message is the backend's own sentence: the bodies carry a
// machine code in `error` and the sentence in `message`, and client.ts prefers
// the latter for the codes declared in shared/contract (identity.ts and
// user.ts).

export interface EmailChangeRequestResponse {
  ok: true;
  /** The new address, masked, for echoing back to the user. */
  masked_email: string;
  /** Non-production only, and only for a synthetic test target: the echo IS
   *  the delivery there (the dev worker must not mail real addresses). */
  dev_code?: string;
  /** Non-production: the target was not allow-listed, so nothing was sent. */
  dev_skip?: string;
}

/** Step 1 of an email change: mail a 6-digit code to the NEW address. */
export async function requestEmailChange(email: string): Promise<EmailChangeRequestResponse> {
  return request<EmailChangeRequestResponse>(
    "/auth/email/change/request",
    {
      method: "POST",
      body: JSON.stringify({ email }),
    },
    true,
  );
}

export interface EmailChangeVerifyResponse {
  ok: true;
  /**
   * Whether the PREVIOUS address was told the account email moved (#1054).
   * `false` is not a failure of the change -- the change has landed either
   * way -- but it is worth saying out loud, because the notice is the only
   * thing that would reach a legitimate owner if this were not them.
   * Optional: a backend deployed before #1266 does not send it.
   */
  old_address_notified?: boolean;
}

/** Step 2: redeem the code and move `users.email`. */
export async function verifyEmailChange(
  email: string,
  code: string,
): Promise<EmailChangeVerifyResponse> {
  return request<EmailChangeVerifyResponse>(
    "/auth/email/change/verify",
    {
      method: "POST",
      body: JSON.stringify({ email, code }),
    },
    true,
  );
}

/** Any subset of the self-editable profile fields; absent keys are untouched. */
export interface ProfilePatchRequest {
  github_username?: string;
  username?: string;
  given_name?: string;
  family_name?: string;
  city?: string;
  country?: string;
  affiliation?: string;
}

export interface ProfileUpdateResponse {
  ok: true;
}

/** Edit the account's own profile fields (`PATCH /auth/profile`). */
export async function updateProfile(patch: ProfilePatchRequest): Promise<ProfileUpdateResponse> {
  return request<ProfileUpdateResponse>(
    "/auth/profile",
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
    true,
  );
}

export interface OrcidCliStartResponse {
  /** Open this in a browser; it sets the state cookie and bounces to ORCID. */
  authorize_url: string;
  /** Seconds the intent stays usable. */
  expires_in: number;
  mode: "link" | "relink";
}

/**
 * Mint a browser-openable ORCID link (or relink) intent for this account.
 * ORCID cannot be completed in a terminal — this is the handoff, and the
 * callback finishes the link for the account the intent names.
 */
export async function startOrcidCliLink(mode: "link" | "relink"): Promise<OrcidCliStartResponse> {
  return request<OrcidCliStartResponse>(
    "/auth/orcid/cli-start",
    {
      method: "POST",
      body: JSON.stringify({ mode }),
    },
    true,
  );
}

/** Remove the ORCID link (identity row, `users.orcid`, `orcid_verified`). */
export async function unlinkOrcid(): Promise<{ ok: true }> {
  return request<{ ok: true }>("/auth/orcid/unlink", { method: "POST" }, true);
}

// ============================================================================
// Device authorization grant + named keys (epic #1272 phase 3; ADR 0047)
// ============================================================================

/** `POST /auth/device/start`: mint a device code for this machine. Never
 *  authenticated -- there is no credential yet, that is the point of the
 *  flow. */
export async function startDeviceAuth(machineName: string): Promise<DeviceStartResponse> {
  return request<DeviceStartResponse>(
    "/auth/device/start",
    { method: "POST", body: JSON.stringify({ machine_name: machineName }) },
    false,
    deviceStartResponseSchema,
  );
}

/** One outcome of a single `POST /auth/device/token` poll. `terminal.error`
 *  is the RFC 8628 grant-error code (the poll loop's retry logic switches on
 *  it); `terminal.message` is the sentence to print verbatim. `reason` is
 *  the more specific refusal code the message was already built from
 *  server-side (ADR 0047: the two disagree on purpose) -- it is `undefined`
 *  only when the 400 body itself failed to validate against the contract,
 *  in which case there is no validated refusal code to report and none is
 *  invented by falling back to `error`. */
export type PollDeviceTokenResult =
  | { status: "success"; data: DeviceTokenSuccess }
  | { status: "pending" }
  | { status: "slow_down" }
  | {
      status: "terminal";
      error: Exclude<DeviceGrantError, "authorization_pending" | "slow_down">;
      reason: DeviceAuthRefusalCode | undefined;
      message: string;
    };

function isDeviceGrantErrorCode(code: string | undefined): code is DeviceGrantError {
  return (
    typeof code === "string" && (deviceGrantErrorSchema.options as readonly string[]).includes(code)
  );
}

/** The raw error body's `message` field, when it happens to be a string --
 *  used only once the body has already failed `deviceTokenErrorSchema`, so
 *  a still-readable sentence isn't thrown away just because some OTHER
 *  field of the body drifted from the contract. */
function rawMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const message = (body as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

/**
 * `POST /auth/device/token`: one poll. Every RFC 8628 answer this endpoint
 * gives (`authorization_pending`, `slow_down`, and the three terminal codes)
 * arrives as a 400 whose body is re-parsed here against
 * `deviceTokenErrorSchema` -- the contract's discriminated union -- rather
 * than probed field by field, so the caller (device-login.ts) never has to
 * `instanceof ApiError` for a "keep polling" answer.
 *
 * When the body fails that parse but `error` is still one of the three
 * TERMINAL grant codes this build recognizes, the poll still ends: a
 * `reason` this build doesn't know about (or some other field drifting from
 * the contract) must not turn a real refusal into an infinite retry. That
 * fallback reports `reason: undefined` (never backfilled from `error`,
 * which is a different vocabulary -- ADR 0047) and prints the body's own
 * `message` when it parsed as a string, else the RFC-level
 * `DEVICE_GRANT_MESSAGES[error]` sentence.
 *
 * Anything else (a network failure, a 5xx, a 200 that failed
 * `deviceTokenSuccessSchema`, or a 400 whose `error` this build does not
 * recognize at all) is rethrown, so the caller can classify it as transient
 * the same way `waitForOrcidLink` already does.
 *
 * `signal` composes with the request's own timeout the same way every other
 * `request()` caller's does -- see device-login.ts's poll loop for how the
 * two are combined.
 */
export async function pollDeviceToken(
  deviceCode: string,
  signal?: AbortSignal,
): Promise<PollDeviceTokenResult> {
  try {
    const data = await request(
      "/auth/device/token",
      { method: "POST", body: JSON.stringify({ device_code: deviceCode }), signal },
      false,
      deviceTokenSuccessSchema,
    );
    return { status: "success", data };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 400) {
      const parsed = deviceTokenErrorSchema.safeParse(error.rawBody);
      if (parsed.success) {
        const body = parsed.data;
        if (body.error === "authorization_pending") return { status: "pending" };
        if (body.error === "slow_down") return { status: "slow_down" };
        return {
          status: "terminal",
          error: body.error,
          reason: body.reason,
          message: body.message,
        };
      }
      if (
        isDeviceGrantErrorCode(error.code) &&
        error.code !== "authorization_pending" &&
        error.code !== "slow_down"
      ) {
        return {
          status: "terminal",
          error: error.code,
          reason: undefined,
          message: rawMessage(error.rawBody) ?? DEVICE_GRANT_MESSAGES[error.code],
        };
      }
    }
    throw error;
  }
}

/** `GET /auth/keys`: this account's live named keys. */
export async function listApiKeys(): Promise<ApiKeyListResponse> {
  return request<ApiKeyListResponse>("/auth/keys", {}, true, apiKeyListResponseSchema);
}

/** `POST /auth/keys`: mint a new named key -- the paste-key fallback for a
 *  machine that cannot run the device flow's browser half. */
export async function createApiKey(name: string): Promise<ApiKeyCreateResponse> {
  return request<ApiKeyCreateResponse>(
    "/auth/keys",
    { method: "POST", body: JSON.stringify({ name }) },
    true,
    apiKeyCreateResponseSchema,
  );
}

/**
 * `POST /auth/docs/cli-session` (epic #1336 phase 3, #1341).
 *
 * Trades the stored API key for a short-lived, read-only, docs-scoped session
 * value. The key itself never leaves this host: only the value returned here is
 * sent to `docs.nemar.org`, which is the separation ADR 0056 exists for.
 *
 * No response schema, unlike its neighbors: `shared/contract/docs-auth.ts` is
 * read as TEXT by drift tests in two other repositories, so it is deliberately
 * dependency-free and declares no zod shapes. `lib/docs-fetch.ts` checks the
 * one field it depends on instead.
 */
export async function mintDocsSession(): Promise<DocsCliSessionResponse> {
  return request<DocsCliSessionResponse>("/auth/docs/cli-session", { method: "POST" }, true);
}

/** `DELETE /auth/keys/:id` or `DELETE /auth/keys/current`. */
export async function revokeApiKey(id: number | "current"): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/auth/keys/${id}`, { method: "DELETE" }, true);
}

/**
 * `DELETE /auth/keys/:id`, authenticated with an EXPLICIT bearer rather
 * than the stored config's key (epic #1272 phase 3). For the one caller
 * that needs it: a just-minted device key whose write to disk then failed
 * (`writeSignedInAccount`'s `upsertAccount` catch) has to be revoked with
 * ITSELF, since it was never saved and `getConfig().apiKey` is stale or
 * absent. Passed as `authenticated: false` deliberately -- `request()`'s
 * authenticated branch (client.ts) always prefers the stored key over a
 * caller-supplied `Authorization` header when one exists, which would
 * silently revoke the WRONG key (or none) here.
 */
export async function revokeApiKeyWithBearer(
  id: number | "current",
  bearer: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/auth/keys/${id}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } },
    false,
  );
}

/** `GET /auth/profile/username-suggestion`: a default username built from
 *  the account's name, for `nemar auth signup`'s guided completion. */
export async function suggestUsername(): Promise<UsernameSuggestionResponse> {
  return request<UsernameSuggestionResponse>(
    "/auth/profile/username-suggestion",
    {},
    true,
    usernameSuggestionResponseSchema,
  );
}
