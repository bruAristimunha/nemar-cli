/**
 * NEMAR API client: the owner's runner registry (portable compute, card DM-05), `/admin/compute/runners`.
 * Owner role. The request and the registration's answer are the protocol's own shapes
 * (`shared/contract/compute-runner.ts`); the two answers the protocol has no shape for, the listing and
 * the revoke, are declared here as OPEN schemas, so a Worker that adds a key, at the top level or in a
 * row, does not break a released CLI. A refusal answers `{ error: <sentence>, code: <word> }`, and the
 * word is in `ApiError.rawBody.code` (see `computeRefusalCode` in `./compute.js`).
 */

import { z } from "zod";
import {
  type ComputeRunnersUsageResponse,
  ComputeRunnersUsageResponseSchema,
} from "../../../shared/contract/compute-admin.js";
import {
  type RunnerRegisterRequest,
  type RunnerRegisterResponse,
  RunnerRegisterResponseSchema,
} from "../../../shared/contract/compute-runner.js";
import { request } from "./client.js";

/** One registration as the owner reads it: the capacity it declared, and whether and why it ended. */
export const RunnerViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    pool: z.string(),
    cores: z.number(),
    memory_mb: z.number(),
    gpus: z.number(),
    scratch_gb: z.number(),
    backend: z.string(),
    runtimes: z.array(z.string()),
    arch: z.string(),
    accounting: z.string(),
    site: z.string(),
    trust: z.string(),
    registered_by: z.number(),
    registered_at: z.string(),
    revoked_at: z.string().nullable(),
    revoke_reason: z.string().nullable(),
    last_seen_at: z.string().nullable(),
    runner_version: z.string().nullable(),
  })
  .passthrough();

export const RunnerListResponseSchema = z
  .object({ runners: z.array(RunnerViewSchema) })
  .passthrough();

export const RunnerRevokeResponseSchema = z
  .object({ runner_id: z.string(), revoked: z.boolean(), already_revoked: z.boolean() })
  .passthrough();

export type RunnerView = z.infer<typeof RunnerViewSchema>;
export type RunnerListResponse = z.infer<typeof RunnerListResponseSchema>;
export type RunnerRevokeResponse = z.infer<typeof RunnerRevokeResponseSchema>;

/** `POST /admin/compute/runners` (owner): register a runner; the answer holds its secret, ONCE. */
export async function registerComputeRunner(
  body: RunnerRegisterRequest,
): Promise<RunnerRegisterResponse> {
  return request(
    "/admin/compute/runners",
    { method: "POST", body: JSON.stringify(body) },
    true,
    RunnerRegisterResponseSchema,
  );
}

/** `GET /admin/compute/runners` (owner): every registration, newest first, without a hash. */
export async function listComputeRunners(): Promise<RunnerListResponse> {
  return request("/admin/compute/runners", {}, true, RunnerListResponseSchema);
}

/** `POST /admin/compute/runners/:id/revoke` (owner): end a registration, its tokens and its work. */
export async function revokeComputeRunner(id: string): Promise<RunnerRevokeResponse> {
  return request(
    `/admin/compute/runners/${encodeURIComponent(id)}/revoke`,
    { method: "POST", body: "{}" },
    true,
    RunnerRevokeResponseSchema,
  );
}

/**
 * `GET /admin/compute/reports/runners` (admin): every runner registration's usage over a date range, in the
 * runners' own figures and never in service units. The answer is parsed OPEN (unknown keys kept).
 */
export async function getComputeRunnersUsage(q: {
  from: string;
  to: string;
}): Promise<ComputeRunnersUsageResponse> {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  return request(
    `/admin/compute/reports/runners?${params.toString()}`,
    {},
    true,
    ComputeRunnersUsageResponseSchema,
  );
}
