/**
 * NEMAR API client: the compute gateway's policy and allocation pools (epic #2005 phase A2, #2007;
 * ADR 0118), `/admin/compute`. Owner and admin roles.
 *
 * Every response is parsed with an OPEN schema (shared/contract/compute-admin.ts): a Worker that
 * adds a key, at the top level or nested, must not break a released CLI. The strict schema of the
 * owner policy is for what `policy set` sends, and `policy show` never parses a response with it.
 * A refusal answers `{ error: <sentence>, code: <word> }`: the sentence is `ApiError.message`, and
 * the word is in `ApiError.rawBody.code` (never `ApiError.code`, which is the body's `error`, the
 * sentence, under this convention); `computeRefusalCode` below reads it, and `pipeline run` uses it.
 */

import {
  type ComputeAccessReportResponse,
  ComputeAccessReportResponseSchema,
  type ComputeAccessReportsResponse,
  ComputeAccessReportsResponseSchema,
  type ComputeAccountPoolsResponse,
  ComputeAccountPoolsResponseSchema,
  type ComputeAccountReportResponse,
  ComputeAccountReportResponseSchema,
  type ComputeHoldResponse,
  ComputeHoldResponseSchema,
  type ComputeHoldsResponse,
  ComputeHoldsResponseSchema,
  type ComputeJobAdminResponse,
  ComputeJobAdminResponseSchema,
  type ComputeJobsListResponse,
  ComputeJobsListResponseSchema,
  type ComputeObserverRunResponse,
  ComputeObserverRunResponseSchema,
  type ComputePipelineRunRequest,
  type ComputePipelineRunResponse,
  ComputePipelineRunResponseSchema,
  type ComputePipelineStatusResponse,
  ComputePipelineStatusResponseSchema,
  type ComputePolicyResponse,
  ComputePolicyResponseSchema,
  type ComputePoolAdjustRequest,
  type ComputePoolGrantRequest,
  type ComputePoolHolderKind,
  type ComputePoolWriteResponse,
  ComputePoolWriteResponseSchema,
  type ComputePoolsResponse,
  ComputePoolsResponseSchema,
  type ComputeRecordReadResponse,
  ComputeRecordReadResponseSchema,
  type ComputeRecordResponse,
  ComputeRecordResponseSchema,
  type ComputeRequeueResponse,
  ComputeRequeueResponseSchema,
  type ComputeStatusResponse,
  ComputeStatusResponseSchema,
  type ComputeUnmatchedResponse,
  ComputeUnmatchedResponseSchema,
} from "../../../shared/contract/compute-admin.js";
import { request } from "./client.js";
import { ApiError } from "./errors.js";

/** `GET /admin/compute/policy` (owner): the policy in force, or the default while none is set. */
export async function getComputePolicy(): Promise<ComputePolicyResponse> {
  return request("/admin/compute/policy", {}, true, ComputePolicyResponseSchema);
}

/** `PUT /admin/compute/policy` (owner): the next version, which the Worker validates strictly again. */
export async function putComputePolicy(
  policy: unknown,
  note?: string,
): Promise<ComputePolicyResponse> {
  return request(
    "/admin/compute/policy",
    { method: "PUT", body: JSON.stringify(note === undefined ? { policy } : { policy, note }) },
    true,
    ComputePolicyResponseSchema,
  );
}

/** `GET /admin/compute/pools` (admin): a keyset page, at most 200; `next_after` continues it. */
export async function listComputePools(
  q: { holderKind?: ComputePoolHolderKind; after?: number; limit?: number } = {},
): Promise<ComputePoolsResponse> {
  const params = new URLSearchParams();
  if (q.holderKind) params.set("holder_kind", q.holderKind);
  if (q.after !== undefined) params.set("after", String(q.after));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request(`/admin/compute/pools${query}`, {}, true, ComputePoolsResponseSchema);
}

/** `GET /admin/compute/pools/by-id/:accountId` (admin): the account's pools; none yet is an empty list. */
export async function getAccountComputePools(
  accountId: number,
): Promise<ComputeAccountPoolsResponse> {
  return request(
    `/admin/compute/pools/by-id/${accountId}`,
    {},
    true,
    ComputeAccountPoolsResponseSchema,
  );
}

function post(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return request(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Idempotency-Key": idempotencyKey },
    },
    true,
    ComputePoolWriteResponseSchema,
  );
}

/** `POST /admin/compute/pools/by-id/:accountId/grant` (admin). One key for one request, ever. */
export async function grantAccountComputePool(
  accountId: number,
  body: ComputePoolGrantRequest,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return post(`/admin/compute/pools/by-id/${accountId}/grant`, body, idempotencyKey);
}

/** `POST /admin/compute/pools/by-id/:accountId/adjust` (admin). */
export async function adjustAccountComputePool(
  accountId: number,
  body: ComputePoolAdjustRequest,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return post(`/admin/compute/pools/by-id/${accountId}/adjust`, body, idempotencyKey);
}

/** `POST /admin/compute/pools/platform/:key/grant` (owner): a platform budget. */
export async function grantPlatformComputePool(
  key: string,
  body: ComputePoolGrantRequest,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return post(
    `/admin/compute/pools/platform/${encodeURIComponent(key)}/grant`,
    body,
    idempotencyKey,
  );
}

/** `POST /admin/compute/pools/platform/:key/adjust` (owner). */
export async function adjustPlatformComputePool(
  key: string,
  body: ComputePoolAdjustRequest,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return post(
    `/admin/compute/pools/platform/${encodeURIComponent(key)}/adjust`,
    body,
    idempotencyKey,
  );
}

/**
 * `GET /admin/compute/status` (admin): the switches as the Worker reads them, whether Tapis, the two
 * compute buckets with their signing secrets and the ACCESS key are configured, and one token mint
 * and one health call, as booleans and fixed words (epic #2005 phase A4, #2009).
 */
export async function getComputeStatus(): Promise<ComputeStatusResponse> {
  return request("/admin/compute/status", {}, true, ComputeStatusResponseSchema);
}

/**
 * `POST /admin/compute/jobs/:id/cancel` (admin): cancel a job at Tapis (a job that never started is ended
 * here and its hold released). The Worker records the intent and carries it out; a job Tapis could not be
 * asked about is retried by the Worker's own sweep.
 */
export async function cancelComputeJobAsAdmin(jobId: string): Promise<ComputeJobAdminResponse> {
  return request(
    `/admin/compute/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
    true,
    ComputeJobAdminResponseSchema,
  );
}

/**
 * `POST /admin/compute/jobs/:id/advance` (admin): one step of a job, wherever it is: a `created` job is
 * submitted, a submitted one is read back from Tapis and applied, and a finished one gets what it is
 * owed. The way a job advances in development, where no compute cron runs.
 */
export async function advanceComputeJobAsAdmin(jobId: string): Promise<ComputeJobAdminResponse> {
  return request(
    `/admin/compute/jobs/${encodeURIComponent(jobId)}/advance`,
    { method: "POST" },
    true,
    ComputeJobAdminResponseSchema,
  );
}

/**
 * `POST /admin/compute/pipeline/run` (admin): run a recipe over one dataset version, or over the next
 * datasets it has not been run over (`eligible` with a `limit`), or say what that would do (`dry_run`,
 * which reads only). A refusal about the one named dataset answers an error with its word in
 * `rawBody.code` (see {@link computeRefusalCode}); a run over the queue answers 200 with each dataset's
 * outcome and the word that stopped it, if one did (epic #2005 phase A6, #2011).
 */
export async function runComputePipeline(
  body: ComputePipelineRunRequest,
): Promise<ComputePipelineRunResponse> {
  return request(
    "/admin/compute/pipeline/run",
    { method: "POST", body: JSON.stringify(body) },
    true,
    ComputePipelineRunResponseSchema,
  );
}

/** What `GET /admin/compute/pipeline/status` filters by; `before` continues a page. */
export interface ComputePipelineStatusQuery {
  recipe?: string;
  dataset?: string;
  state?: string;
  before?: number;
  limit?: number;
}

/**
 * `GET /admin/compute/pipeline/status` (admin): the stamps, newest first, after the Worker synced them
 * with their jobs. `next_before` continues the page.
 */
export async function getComputePipelineStatus(
  q: ComputePipelineStatusQuery = {},
): Promise<ComputePipelineStatusResponse> {
  const params = new URLSearchParams();
  if (q.recipe) params.set("recipe", q.recipe);
  if (q.dataset) params.set("dataset", q.dataset);
  if (q.state) params.set("state", q.state);
  if (q.before !== undefined) params.set("before", String(q.before));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request(
    `/admin/compute/pipeline/status${query}`,
    {},
    true,
    ComputePipelineStatusResponseSchema,
  );
}

// --- Reporting, holds, ACCESS reports and the observer (epic #2005 phase A7, #2012) ---------------------------

/** What `GET /admin/compute/jobs` filters by; `after` continues a page. */
export interface ComputeJobsQuery {
  flag?: string;
  state?: string;
  account?: number;
  /** `tapis` or `runner`. */
  executor?: string;
  /** `su` or `none`. */
  accounting?: string;
  /** A runner registration's id. */
  runner?: string;
  limit?: number;
  after?: number;
}

const queryString = (params: URLSearchParams) => (params.toString() ? `?${params.toString()}` : "");

/** `GET /admin/compute/jobs` (admin): jobs by flag, state and account, newest first. No identity. */
export async function listComputeJobs(q: ComputeJobsQuery = {}): Promise<ComputeJobsListResponse> {
  const params = new URLSearchParams();
  if (q.flag) params.set("flag", q.flag);
  if (q.state) params.set("state", q.state);
  if (q.account !== undefined) params.set("account", String(q.account));
  if (q.executor) params.set("executor", q.executor);
  if (q.accounting) params.set("accounting", q.accounting);
  if (q.runner) params.set("runner", q.runner);
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.after !== undefined) params.set("after", String(q.after));
  return request(
    `/admin/compute/jobs${queryString(params)}`,
    {},
    true,
    ComputeJobsListResponseSchema,
  );
}

/** `GET /admin/compute/jobs?unmatched=1` (admin): Expanse's rows that no job claims. */
export async function listUnmatchedComputeRows(limit?: number): Promise<ComputeUnmatchedResponse> {
  const params = new URLSearchParams({ unmatched: "1" });
  if (limit !== undefined) params.set("limit", String(limit));
  return request(
    `/admin/compute/jobs${queryString(params)}`,
    {},
    true,
    ComputeUnmatchedResponseSchema,
  );
}

/**
 * `GET /admin/compute/records/:ref` (admin): one job by its NEMAR id, Tapis uuid or Slurm id. The answer
 * is parsed OPEN (unknown keys kept), never with a strict compute schema.
 */
export async function getComputeRecord(ref: string): Promise<ComputeRecordResponse> {
  return request(
    `/admin/compute/records/${encodeURIComponent(ref)}`,
    {},
    true,
    ComputeRecordResponseSchema,
  );
}

/** `POST /admin/compute/records/:ref/read` (owner): one record, with a stated reason, audited first. */
export async function readComputeRecord(
  ref: string,
  name: string,
  reason: string,
): Promise<ComputeRecordReadResponse> {
  return request(
    `/admin/compute/records/${encodeURIComponent(ref)}/read`,
    { method: "POST", body: JSON.stringify({ name, reason }) },
    true,
    ComputeRecordReadResponseSchema,
  );
}

/** `GET /admin/compute/report` (admin): one account's jobs and charge from one date to another. */
export async function getComputeAccountReport(q: {
  account: number;
  from: string;
  to: string;
}): Promise<ComputeAccountReportResponse> {
  const params = new URLSearchParams({
    account: String(q.account),
    from: q.from,
    to: q.to,
  });
  return request(
    `/admin/compute/report${queryString(params)}`,
    {},
    true,
    ComputeAccountReportResponseSchema,
  );
}

/** `GET /admin/compute/access-report` (admin): for ACCESS, a quarter's distinct gateway users and jobs. */
export async function getComputeAccessReport(
  quarter: string,
): Promise<ComputeAccessReportResponse> {
  const params = new URLSearchParams({ quarter });
  return request(
    `/admin/compute/access-report${queryString(params)}`,
    {},
    true,
    ComputeAccessReportResponseSchema,
  );
}

/** `GET /admin/compute/holds` (admin): the active legal holds, optionally for one target. */
export async function listComputeHolds(
  q: { scope?: string; ref?: string } = {},
): Promise<ComputeHoldsResponse> {
  const params = new URLSearchParams();
  if (q.scope) params.set("scope", q.scope);
  if (q.ref) params.set("ref", q.ref);
  return request(
    `/admin/compute/holds${queryString(params)}`,
    {},
    true,
    ComputeHoldsResponseSchema,
  );
}

/** `POST /admin/compute/holds` (owner): a legal hold on a job or an account. */
export async function placeComputeHold(body: {
  scope: string;
  ref: string;
  reason: string;
}): Promise<ComputeHoldResponse> {
  return request(
    "/admin/compute/holds",
    { method: "POST", body: JSON.stringify(body) },
    true,
    ComputeHoldResponseSchema,
  );
}

/** `DELETE /admin/compute/holds/:id` (owner): release a hold (the row stays). */
export async function releaseComputeHold(id: number): Promise<ComputeHoldResponse> {
  return request(
    `/admin/compute/holds/${id}`,
    { method: "DELETE" },
    true,
    ComputeHoldResponseSchema,
  );
}

/** `GET /admin/compute/access-reports` (admin): ACCESS report rows in one state, and `failed` ones by word. */
export async function listComputeAccessReports(
  q: { state?: string; limit?: number; after?: string } = {},
): Promise<ComputeAccessReportsResponse> {
  const params = new URLSearchParams();
  if (q.state) params.set("state", q.state);
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.after) params.set("after", q.after);
  return request(
    `/admin/compute/access-reports${queryString(params)}`,
    {},
    true,
    ComputeAccessReportsResponseSchema,
  );
}

/**
 * `POST /admin/compute/access-reports/:jobId/requeue` (owner): put a `failed` ACCESS report back to
 * `pending`. The body carries the owner's explicit acknowledgement that ACCESS did NOT record it: an
 * unknown outcome is never resent by code (a report may be lost, never doubled).
 */
export async function requeueComputeAccessReport(jobId: string): Promise<ComputeRequeueResponse> {
  return request(
    `/admin/compute/access-reports/${encodeURIComponent(jobId)}/requeue`,
    { method: "POST", body: JSON.stringify({ confirmed_not_recorded: true }) },
    true,
    ComputeRequeueResponseSchema,
  );
}

/** `POST /admin/compute/observer-runs` (admin): mint the observer's one-hour token. Shown once. */
export async function mintComputeObserverRun(): Promise<ComputeObserverRunResponse> {
  return request(
    "/admin/compute/observer-runs",
    { method: "POST" },
    true,
    ComputeObserverRunResponseSchema,
  );
}

/**
 * The fixed word of a compute route's refusal (`rawBody.code`) and, for a refused dataset, the terms of
 * the eligibility predicate that block it (`rawBody.blocked_by`); undefined for anything else.
 */
export function computeRefusalCode(
  err: unknown,
): { code: string; blockedBy: string[]; reason?: string } | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.rawBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { code, blocked_by: blocked, reason } = body as Record<string, unknown>;
  if (typeof code !== "string") return undefined;
  const blockedBy = Array.isArray(blocked)
    ? blocked.filter((t): t is string => typeof t === "string")
    : [];
  return { code, blockedBy, ...(typeof reason === "string" ? { reason } : {}) };
}
