/**
 * The responses of the compute routes that are NOT under `/admin` and that something other than the
 * command-line interface (CLI) reads (epic #2005 review, ADR 0118): a person's cancel and links, which the
 * website and Epic D consume, and the observer's answer. They were backend-local types, so a change to
 * one reached a consumer by surprise; the schemas below are the contract, and a backend test parses the
 * real route output against them.
 *
 * Like `./compute-admin.ts`, every schema is open: a released reader keeps working when the Worker adds a
 * key, so each object accepts and keeps one it does not know, and a word the Worker may grow is a
 * string here and not an enum (the words that exist today are listed beside the schema). This file
 * imports nothing from `./compute.ts` and never the strict policy schema.
 *
 * Wire names are snake_case throughout. The observer's answer used to carry `sacctRows` and
 * `settlementFailed`; the observer does not read the answer body (it reads the status and drops the
 * rest), and nothing else consumed those keys, so they are `sacct_rows` and `settlement_failed` now.
 */

import { z } from "zod";

/**
 * `POST /compute/jobs/:id/cancel`, 200: the intent is recorded, or the job was already cancelled. The
 * refusals (`bad_state`, `job_not_found`) are the `{ error, code }` answers of the other statuses.
 */
export const COMPUTE_CANCEL_OUTCOMES = [
  "cancel_requested",
  "cancelled",
  "already_cancelled",
] as const;

export const ComputeCancelResponseSchema = z
  .object({
    ok: z.literal(true),
    /** The job's state after the call; a cancel at Tapis is carried out afterwards, so it may not be `cancelled` yet. */
    state: z.string().nullable(),
    /** One of `COMPUTE_CANCEL_OUTCOMES` today. */
    outcome: z.string(),
  })
  .passthrough();

export type ComputeCancelResponse = z.infer<typeof ComputeCancelResponseSchema>;

/**
 * `POST /compute/jobs/:id/links`, 200: seven-day links to a finished job's declared outputs, at most
 * 1,000 at a time. `next_after` is the cursor for the next page (send it as `after`), null on the last
 * page. The links are bearer links: never logged, never mailed.
 */
export const ComputeLinksResponseSchema = z
  .object({
    links: z.array(
      z
        .object({ path: z.string(), size: z.number().int().nonnegative(), url: z.string() })
        .passthrough(),
    ),
    expires_at: z.string(),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    next_after: z.string().nullable(),
  })
  .passthrough();

export type ComputeLinksResponse = z.infer<typeof ComputeLinksResponseSchema>;

/**
 * `POST /compute/observer`, 200: what one post stored and settled. `skipped` counts the partitions and
 * jobs the post carried that were not stored (see ADR 0118, the amendment of 2026-11-06, item 4);
 * `truncated` is present (true) when the observer cut its export; `settlement_failed` is present (true)
 * when the rows were stored and the settlement failed, which the daily sweep does again.
 */
export const ComputeObserverIngestResponseSchema = z
  .object({
    ok: z.literal(true),
    snapshots: z.number().int().nonnegative(),
    sacct_rows: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    mismatched: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    truncated: z.literal(true).optional(),
    settlement_failed: z.literal(true).optional(),
  })
  .passthrough();

export type ComputeObserverIngestResponse = z.infer<typeof ComputeObserverIngestResponseSchema>;
