/**
 * NEMAR API client: transport core.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim. `request` is exported for the sibling endpoint-group modules
 * (internal wiring, not part of the CLI-facing API surface pinned by
 * test/api-export-surface.unit.test.ts).
 *
 * DEFAULT_API_URL's literal is rewritten in dist/index.js by the dev-build
 * sed in .github/workflows/npm-publish.yml; keep the literal and the
 * IS_DEV_BUILD `.includes` expression exactly as they are.
 */

import type { ZodType } from "zod";
import { ADMIN_USER_ERROR_CODES } from "../../../shared/contract/admin-user.js";
import {
  DEVICE_AUTH_REFUSAL_CODES,
  deviceGrantErrorSchema,
} from "../../../shared/contract/device-auth.js";
import { IDENTITY_CONFLICT_CODES } from "../../../shared/contract/identity.js";
import {
  IDENTIFIER_SCREEN_ERROR_CODES,
  PUBLICATION_REFUSAL_ERROR_CODES,
} from "../../../shared/contract/publication.js";
import {
  ACCOUNT_KIND_ERROR_CODES,
  PROFILE_EDIT_ERROR_CODES,
  UPLOAD_ACCESS_ERROR_CODES,
} from "../../../shared/contract/user.js";
import { getConfig } from "../config.js";
import { isDebugEnabled, recordHttpExchange } from "../debug-log.js";
import { printMaintenanceBanner } from "../maintenance-banner.js";
import { version } from "../version.js";
import { ApiError, MaintenanceError } from "./errors.js";

const DEFAULT_API_URL = "https://api.nemar.org";

export const IS_DEV_BUILD = DEFAULT_API_URL.includes("workers.dev");

/**
 * Get the API base URL from config or default.
 * Dev builds (injected URL) always use the dev backend regardless of stored config.
 *
 * Exported because the data plane is addressed as this origin plus `/data`
 * (lib/http-download.ts): that mount exists in every environment, so deriving
 * it here keeps environment selection in one place instead of introducing a
 * second host that has to be kept in step.
 */
export function getApiUrl(): string {
  if (process.env.TEST_API_URL) {
    return process.env.TEST_API_URL;
  }
  if (IS_DEV_BUILD) {
    return DEFAULT_API_URL;
  }
  const config = getConfig();
  return config.apiUrl || DEFAULT_API_URL;
}

/**
 * Make an authenticated or unauthenticated API request
 */
export async function request<T>(
  path: string,
  options: RequestInit = {},
  authenticated: boolean | "optional" = false,
  // Optional wire-contract schema (epic #896, #898). When provided, the parsed
  // response is validated against it and the VALIDATED value is returned, so a
  // shape drift fails loudly here instead of silently casting to a malformed T
  // (the getCurrentUser class of bug). Endpoints opt in by passing a schema from
  // shared/contract; passthrough schemas keep additive backend fields safe.
  schema?: ZodType<T>,
): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-CLI-Version": version,
    ...(options.headers as Record<string, string>),
  };

  if (authenticated) {
    const config = getConfig();
    if (!config.apiKey && authenticated === true) {
      throw new ApiError(401, "Not authenticated. Run 'nemar auth login' first.");
    }
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  }

  const method = options.method || "GET";
  const requestBody = typeof options.body === "string" ? options.body : undefined;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (fetchError) {
    // Network error - DNS resolution, connection refused, etc.
    if (isDebugEnabled()) {
      recordHttpExchange({
        method,
        url,
        status: null,
        durationMs: Date.now() - startedAt,
        requestHeaders: headers,
        requestBody,
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
      });
    }
    throw new ApiError(0, `Network error: Could not connect to ${getApiUrl()}`, {
      originalError: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
  }

  // Read the body as text once (a Response body can only be consumed once)
  // so it's available both for parsing below and for the debug log entry,
  // including the "invalid JSON" failure case.
  //
  // Wrapped in its own try/catch (review finding, PR #1257): this used to
  // run unguarded for EVERY caller, debug on or off, so a body-stream
  // failure (connection dropped mid-response, etc.) escaped as a raw
  // TypeError instead of an ApiError -- breaking the `instanceof ApiError`
  // checks roughly 20 call sites rely on (e.g. publish's isRetryable
  // classifier), regardless of whether --debug was ever involved.
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (readError) {
    if (isDebugEnabled()) {
      recordHttpExchange({
        method,
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestHeaders: headers,
        requestBody,
        error: readError instanceof Error ? readError.message : String(readError),
      });
    }
    // statusCode 0, not response.status: a stream dying mid-body is a
    // network-layer drop regardless of what status line the server sent,
    // and 0 is this codebase's convention for exactly that (review finding,
    // PR #1257) -- see the network-error branch above, and
    // isRetryablePublishError, which treats statusCode 0 as retryable. The
    // status line the server DID send is preserved in `details` for anyone
    // reading the error, not lost.
    throw new ApiError(0, "Failed to read response body", {
      httpStatus: response.status,
      originalError: readError instanceof Error ? readError.message : String(readError),
    });
  }
  if (isDebugEnabled()) {
    recordHttpExchange({
      method,
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      requestHeaders: headers,
      requestBody,
      responseBody: rawBody,
    });
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Response wasn't valid JSON
    throw new ApiError(response.status, `Invalid response from server (status ${response.status})`);
  }

  if (!response.ok) {
    if (response.status === 503 && (data.mode === "read-only" || data.mode === "full")) {
      const message =
        typeof data.message === "string"
          ? data.message
          : "NEMAR is in maintenance mode. Please retry shortly.";
      const eta = typeof data.eta === "string" ? data.eta : null;
      const maintErr = new MaintenanceError(data.mode, message, eta, data.details);
      printMaintenanceBanner(maintErr);
      throw maintErr;
    }
    const hasBlockReason = typeof data.block_reason === "string";
    // `missing` is carried through only when it is genuinely an array of
    // strings: a server that sends something else must not turn into a
    // `.map()` crash inside a catch block (ADR 0042, #1253).
    const missing = Array.isArray(data.missing)
      ? data.missing.filter((f): f is string => typeof f === "string")
      : undefined;
    // `message` wins for the two refusal families that put a short MACHINE
    // CODE in `error` and the actionable sentence in `message`. Preferring
    // `error` showed the user "Owner has no researcher name on file" with no
    // hint about how to fix it (#1255) — or, for the upload-access request,
    // the bare word "already_approved" (ADR 0042).
    //
    // The upload-access arm is keyed on the CODE, not merely on `missing`
    // being present: `missing` is a plausible field name for an unrelated
    // endpoint to use, and "this body has a `missing` array" is not evidence
    // that its `error` is a code rather than a sentence. The vocabulary is
    // imported from shared/contract so the client and the route cannot drift
    // on which codes those are. Every other endpoint still leads with `error`,
    // which is where its human sentence lives.
    // The third family (#1266, ADR 0044): the self-service identity edits.
    // `PATCH /auth/profile`, the email change and the ORCID link intent all
    // answer with a code in `error` and the sentence in `message`, and unlike
    // the upload-access arm above there is no `missing` array to key on — so
    // membership in the declared vocabulary IS the test. Both sets are
    // imported from shared/contract rather than spelled out here, so a code
    // the backend adds and the CLI has not been taught about prints as a bare
    // token exactly once, in review.
    const isProfileEditCode =
      typeof data.error === "string" &&
      (PROFILE_EDIT_ERROR_CODES.includes(data.error) ||
        IDENTITY_CONFLICT_CODES.includes(data.error));
    // The device authorization grant's two vocabularies (epic #1272 phase 3;
    // ADR 0047): the RFC 8628 grant-error codes `POST /auth/device/token`
    // answers 400 with (`authorization_pending`, `slow_down`,
    // `expired_token`, ...), and the more general device-auth refusal codes
    // `lookup`/`confirm`/`deny`/`/auth/keys` answer with (`too_many_keys`,
    // `key_not_found`, `device_code_used`, ...). Neither is a human sentence
    // on its own -- `message` is, so it wins here the same way the two
    // families above already do. Cast off zod's literal-tuple type: this is
    // a runtime membership test against caller-supplied JSON, not a narrowing
    // of `data.error`'s type.
    const isDeviceCode =
      typeof data.error === "string" &&
      ((deviceGrantErrorSchema.options as readonly string[]).includes(data.error) ||
        DEVICE_AUTH_REFUSAL_CODES.includes(data.error));
    // The account-kind change vocabulary (epic #1272 phase 4, #1284 review;
    // ADR 0048): `POST /admin/users/:username/kind` answers `{ error: <code>,
    // message }` from a closed set the same shape as the two families above,
    // so it wins the same way -- `error` is a token (`orcid_linked`,
    // `same_kind`, ...), not a sentence.
    const isAccountKindCode =
      typeof data.error === "string" && ACCOUNT_KIND_ERROR_CODES.includes(data.error);
    // The admin account lookup and edit vocabulary (ADR 0096): `invalid_search`,
    // `field_not_editable`, `owner_only_field`, ... Same shape again, same rule.
    // The uniqueness refusals the edit route also raises (`email_in_use`,
    // `username_taken`, ...) are already covered by the identity and profile
    // sets above.
    const isAdminUserCode =
      typeof data.error === "string" && ADMIN_USER_ERROR_CODES.includes(data.error);
    // The identifier screen's refusals (epic #1610 phase 4): a code in
    // `error`, the reason and the next command in `message`.
    const isScreenCode =
      typeof data.error === "string" && IDENTIFIER_SCREEN_ERROR_CODES.includes(data.error);
    // A publication request that could not check BIDS validation status at
    // all (ci_check_unavailable): a code in `error`, the sentence in `message`.
    const isPublicationRefusalCode =
      typeof data.error === "string" && PUBLICATION_REFUSAL_ERROR_CODES.includes(data.error);
    const prefersMessage =
      hasBlockReason ||
      isPublicationRefusalCode ||
      isProfileEditCode ||
      isDeviceCode ||
      isAccountKindCode ||
      isAdminUserCode ||
      isScreenCode ||
      (missing !== undefined &&
        typeof data.error === "string" &&
        UPLOAD_ACCESS_ERROR_CODES.includes(data.error));
    let primary = prefersMessage
      ? (data.message as string) || (data.error as string)
      : (data.error as string) || (data.message as string);

    // A route this CLI knows about and the backend does not (#1266 review).
    // The API's 404 body is `{ error: "Not Found", message: "Route PATCH
    // /auth/profile not found" }`, and leading with `error` renders the whole
    // thing as the words "Not Found" -- which reads as "your dataset is
    // missing", not "this deployment predates the command you just ran". The
    // message names the route, and the added line names the cause.
    //
    // Keyed on the API's own not-found SIGNATURE (`error === "Not Found"` plus
    // a message, backend/src/index.ts) rather than on the status alone: a
    // route that answers 404 for a missing DATASET says so in `error`, and
    // "this backend does not support this command" would be a wrong and
    // confusing thing to append to it.
    if (response.status === 404 && data.error === "Not Found" && typeof data.message === "string") {
      primary = `${data.message}. This NEMAR backend does not support this command yet.`;
    }

    const apiError = new ApiError(
      response.status,
      primary || "Request failed",
      data.details,
      typeof data.step === "string" ? data.step : undefined,
      hasBlockReason ? (data.block_reason as string) : undefined,
      missing,
    );
    // Assigned after construction (errors.ts), not constructor parameters:
    // every existing `new ApiError(...)` call site (tests, retry
    // classifiers) predates these two fields and passes neither.
    if (typeof data.error === "string") apiError.code = data.error;
    if (typeof data.reason === "string") apiError.reason = data.reason;
    apiError.rawBody = data;
    throw apiError;
  }

  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ApiError(
        response.status,
        `Response for ${path} did not match the expected NEMAR contract`,
        { issues: result.error.issues },
      );
    }
    return result.data;
  }

  return data as T;
}

// ============================================================================
// Health
// ============================================================================

export interface HealthResponse {
  status: string;
  timestamp: string;
  version: string;
}

/**
 * Check API health
 */
export async function checkHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}
