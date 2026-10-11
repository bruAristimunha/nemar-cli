/**
 * NEMAR API client: publication workflow endpoints (user-facing requests and
 * the admin approve orchestrator client).
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import { APPROVE_RETRY_DELAY_MS } from "../../../shared/publication-retry.js";
import { PUBLICATION_STEPS } from "../../../shared/publication-steps.js";
import type { IdentifierScreenView } from "../identifier-screen-display.js";
import { request } from "./client.js";
import { ApiError } from "./errors.js";

// ============================================================================
// Publication Workflow
// ============================================================================

// `identifier_screen` (epic #1610, phase 4) is the request's identifier screen as
// the backend's `describeScreen` worded it. Optional on every response below,
// because an older backend does not send it.
export type { IdentifierScreenView };

export interface PublishStatusResponse {
  dataset_id: string;
  status: string;
  requested_at?: string;
  requested_by?: string;
  approved_at?: string | null;
  denied_at?: string | null;
  denied_reason?: string | null;
  steps_completed?: string[];
  current_step?: string | null;
  last_error?: string | null;
  updated_at?: string;
  message?: string;
  block_reason?: string | null;
  // Present when status='blocked': link to the dataset repo's Actions tab so the
  // user can see the BIDS validation run (#428).
  ci_url?: string;
  // Present when block_reason='min_requirements_failed' (#1087): the itemized
  // submission-minimums failures persisted at request time, plus the policy
  // they come from.
  reasons?: string[];
  policy_url?: string;
  // Non-blocking pre-screen advisory (#756): present when the screen flagged a
  // concern. The request is NOT blocked by this.
  advisory?: { source: "prescreen"; reasons: string[]; issue_url?: string };
  // #1408: which of the two runs is queued. This is the only place a depositor
  // can confirm, before an admin acts, that `--anonymous` was recorded.
  // Optional because an older backend does not send it -- absent means
  // unknown, never "no".
  anonymous?: boolean;
  identifier_screen?: IdentifierScreenView;
}

export interface PublishRequestsResponse {
  requests: Array<{
    id: number;
    dataset_id: string;
    status: string;
    requested_at: string;
    requested_by_username: string;
    requested_by_email: string;
    steps_completed: string[];
    current_step: string | null;
    last_error: string | null;
    prescreen_status?: string | null;
    prescreen_reasons?: string | null;
    prescreen_issue_url?: string | null;
    // #1408: 1 when this request asks for an ANONYMOUS release rather than a
    // publication. The route spreads `pr.*`, so the column was already on the
    // wire and merely unrendered -- which left an admin approving the two
    // outcomes from an identical line.
    anonymous?: number | null;
    identifier_screen?: IdentifierScreenView;
  }>;
  count: number;
}

export interface StepResult {
  step: string;
  status: "completed" | "failed" | "skipped";
  attempts: number;
  duration_ms: number;
  error?: string;
}

/**
 * The 200 answer of `POST /datasets/:id/publish/request`. `request_notice` is the
 * Worker's copy of the neutral notice (ADR 0090, amendment "what an accepted request is told"), for API
 * clients; the CLI prints its own from the same shared definition, so it does not
 * read this field and an older Worker cannot make it print less.
 */
export interface PublishRequestResponse {
  message: string;
  dataset_id: string;
  status: string;
  anonymous?: boolean;
  identifier_screen?: IdentifierScreenView;
  request_notice?: string[];
}

export interface PublishApproveResponse {
  message: string;
  dataset_id: string;
  status?: string;
  steps_completed?: string[];
  step_results?: StepResult[];
  error?: string;
  step?: string;
  hasMore?: boolean;
  /** S3 ListObjectsV2 continuation token returned by the server while
   *  streaming object-lock batches. The CLI threads it back unchanged on
   *  the next invocation until `hasMore` is false. Replaced the legacy
   *  `s3_lock_offset` field as of #385.
   */
  s3_lock_continuation_token?: string;
  /** Total object count under the dataset's `objects/` prefix, computed
   *  once on the first s3_lock call. The CLI threads it back via the
   *  request body on subsequent calls so progress reporting survives
   *  across Worker invocations. See #284.
   */
  s3_lock_total?: number;
  /** Number of objects locked in the most recent batch. The CLI sums
   *  these across pages to render a running total against `s3_lock_total`.
   */
  s3_lock_batch_count?: number;
  /** Legacy field — kept on the response type for back-compat but no
   *  longer populated by current servers. */
  s3_lock_offset?: number;
  /** Non-fatal warning(s) from the orchestrator (e.g. notify_user email
   *  failure, audit log failure). Publication succeeded; operator should
   *  review and follow up manually. Multiple warnings are joined with " | ". */
  warning?: string;
}

/**
 * Request publication of a dataset (user)
 *
 * `anonymous` asks for a RELEASE rather than a publication (#1408): the data
 * goes public while the repository stays private, the DOI stays reserved with
 * no curator, and the depositor is withheld everywhere NEMAR writes them. The
 * body is only sent when the flag is set, so an ordinary request stays exactly
 * the bodyless POST it has always been.
 */
export async function requestPublication(
  datasetId: string,
  options: { anonymous?: boolean } = {},
): Promise<PublishRequestResponse> {
  // `anonymous` is echoed by the server (#1408). The caller must print from
  // the ECHO rather than from `options.anonymous`: what matters to a depositor
  // is what was recorded, not what was typed, and the two diverge exactly in
  // the cases worth catching -- a dropped body, a proxy that rewrites it, an
  // older backend that does not know the flag.
  return request<PublishRequestResponse>(
    `/datasets/${datasetId}/publish/request`,
    options.anonymous
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anonymous: true }),
        }
      : { method: "POST" },
    true,
  );
}

/**
 * Get publication status (user)
 */
export async function getPublishStatus(datasetId: string): Promise<PublishStatusResponse> {
  return request<PublishStatusResponse>(`/datasets/${datasetId}/publish/status`, {}, true);
}

/**
 * Resend publication notification (user)
 */
export async function resendPublishNotification(datasetId: string): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/datasets/${datasetId}/publish/resend`,
    { method: "POST" },
    true,
  );
}

/**
 * List publication requests (admin)
 */
export async function listPublishRequests(status?: string): Promise<PublishRequestsResponse> {
  const query = status ? `?status=${status}` : "";
  return request<PublishRequestsResponse>(`/admin/publish/requests${query}`, {}, true);
}

/**
 * Deny publication request (admin)
 */
export async function denyPublication(
  datasetId: string,
  reason: string,
): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/admin/publish/${datasetId}/deny`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
    true,
  );
}

/**
 * Re-run the identifier screen of a dataset's active publication request
 * (admin; epic #1610, phase 4). The admins are mailed when it reports.
 */
export async function rerunIdentifierScreen(datasetId: string): Promise<{
  dataset_id: string;
  request_id: number;
  status: string;
  identifier_screen: IdentifierScreenView;
}> {
  return request(`/admin/publish/${datasetId}/identifier-screen`, { method: "POST" }, true);
}

/**
 * Info passed to `onRetry` when the orchestrator hits a transient failure
 * and the CLI is about to wait and re-invoke.
 */
export interface PublishRetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  step?: string;
  error: string;
}

/**
 * Progress information emitted by `approvePublication` while the
 * orchestrator runs. Two flavors:
 *   - step transitions: `step` advances and `s3LockLocked`/`s3LockTotal`
 *     are undefined.
 *   - s3_lock pagination: `step === "s3_lock"` and the counters are set
 *     after each batch response.
 *
 * `stepIndex` is 1-based against `stepTotal` so the CLI can render
 * "Step 14/17: s3 lock" without re-deriving from a step list.
 */
export interface PublishProgressInfo {
  /** Current step name as reported by the orchestrator (e.g. "s3_lock"). */
  step: string;
  /** 1-based position of this step in the orchestrator step list. */
  stepIndex: number;
  /** Total number of orchestrator steps. */
  stepTotal: number;
  /** Number of S3 objects locked so far across all pages this run. */
  s3LockLocked?: number;
  /** Total S3 objects to lock, once known. */
  s3LockTotal?: number;
  /**
   * True when emitting s3_lock progress after a Worker retry. The outer
   * retry loop (on 5xx/timeout) re-invokes the Worker with the persisted
   * continuation token so locking resumes from the right page; however
   * the visible counter can appear lower than the pre-retry value while
   * the new invocation re-accumulates its batches. Setting this flag lets
   * the CLI append "(resumed)" to the spinner line so the display is
   * honest rather than misleading. (#284)
   */
  s3LockResumed?: boolean;
}

/**
 * Ordered list of orchestrator step names. Single-sourced from
 * `shared/publication-steps.ts` — the exact list the backend orchestrator
 * executes — so the CLI's step labels/indices can no longer drift from the
 * backend (#904; the previous hand-mirrored copy had steps 3/4 swapped).
 * Used both for `stepIndex`/`stepTotal` computation in `approvePublication`
 * and to label progress in the CLI.
 */
export { PUBLICATION_STEPS };

/**
 * Resolve a step name to its 1-based index in `PUBLICATION_STEPS`, or
 * fall back to `stepsCompleted.length + 1` when the name isn't known
 * (defensive for future steps the CLI hasn't shipped a label for).
 */
export function stepIndexFor(step: string | undefined, stepsCompleted: string[] = []): number {
  if (step) {
    const idx = (PUBLICATION_STEPS as readonly string[]).indexOf(step);
    if (idx >= 0) return idx + 1;
  }
  return Math.min(stepsCompleted.length + 1, PUBLICATION_STEPS.length);
}

/**
 * Decide whether a failed `approvePublication` request is worth re-invoking
 * from a fresh Worker. The orchestrator persists progress in D1, so a
 * re-invocation skips already-completed steps and only re-attempts the one
 * that failed — that makes wait-and-retry safe and idempotent for the
 * transient failures admins actually see in practice:
 *
 *   - 5xx / 429 from the Worker itself or upstream services (EZID 503,
 *     Cloudflare "Too many subrequests by single Worker invocation",
 *     transient GitHub 5xx). In practice this is the dominant retry path:
 *     the orchestrator wraps every step failure as HTTP 500 with the
 *     upstream message in the body, so propagation 5xx and even GitHub's
 *     "Repository has been locked" 403 (re-wrapped as 500) match here.
 *   - Network-layer drops surfaced by the request helper as `statusCode === 0`
 *   - A bare HTTP 403 whose message still contains "repository has been
 *     locked" — defensive coverage for any future code path that returns
 *     the GitHub 403 directly without wrapping it in a 500.
 *
 * Real input errors (CI failure 422, sandbox-prefix rejection 400, missing
 * auth 401/403, dataset-not-found 404) are NOT retried — they will not fix
 * themselves with time and the admin needs to act.
 *
 * Exported for direct unit testing — kept as a pure predicate over
 * `ApiError` so the retry surface can be locked in by the test suite.
 */
export function isRetryablePublishError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.statusCode === 0) return true;
  if (err.statusCode === 429) return true;
  if (err.statusCode >= 500 && err.statusCode < 600) return true;
  if (err.statusCode === 403 && /repository has been locked/i.test(err.message)) return true;
  return false;
}

/**
 * Approve publication request (admin) - runs orchestrator with
 * retry-with-delay across Worker invocations.
 *
 * The pipeline's flakiest steps (tag protection, EZID DOI mint, S3 Object
 * Lock) hit transient failures: GitHub propagation lag right after the
 * repo visibility flip, EZID rate limits, and Cloudflare per-invocation
 * subrequest limits. Inline retry inside a single Worker (`withRetry` in
 * the backend) made S3 Object Lock worse — each retry re-issued ~40 S3
 * PUTs in the same invocation and tripped CF's subrequest cap.
 *
 * Instead we drive retries from the CLI: each retry is a *fresh* Worker
 * invocation with a fresh subrequest budget, and the 10s gap between
 * attempts gives GitHub/EZID propagation a real chance to clear. The
 * orchestrator's persisted progress means the retry only re-runs the
 * failed step, not the whole pipeline.
 */
export async function approvePublication(
  datasetId: string,
  resume = false,
  sandbox = false,
  skipCiCheck = false,
  onRetry?: (info: PublishRetryInfo) => void,
  onProgress?: (info: PublishProgressInfo) => void,
  acknowledgeIdentifierScreen?: string,
): Promise<PublishApproveResponse> {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = APPROVE_RETRY_DELAY_MS;

  let s3_lock_continuation_token: string | undefined;
  // Total object count for s3_lock — computed by the server on the first
  // s3_lock call and threaded back on every subsequent call so the
  // server doesn't have to re-count per page. See #284.
  let s3_lock_total: number | undefined;
  // Running locked-objects count accumulated across all hasMore=true pages
  // AND across outer retries. Kept at function scope so a Worker timeout
  // mid-s3_lock doesn't reset the counter to 0 on retry.
  let s3LockLocked = 0;
  // Set to true after the first outer-loop retry so s3_lock progress events
  // can carry the s3LockResumed flag — the spinner text can then say
  // "(resumed)" to clarify that the counter reflects pre-retry work plus
  // new batches from the fresh Worker, not a fresh start from 0. (#284)
  let s3LockIsResumed = false;
  let lastReportedStep: string | undefined;
  let useResume = resume;
  const accumulatedStepResults: StepResult[] = [];
  let lastError: unknown;

  /**
   * Emit a progress event whenever the orchestrator's reported step
   * changes (or s3_lock is making intra-step progress). Centralised so
   * step-only events and s3_lock-batch events share the same dedup logic.
   */
  function emitProgress(
    step: string,
    stepsCompleted: string[],
    s3Locked?: number,
    s3Total?: number,
  ) {
    if (!onProgress) return;
    onProgress({
      step,
      stepIndex: stepIndexFor(step, stepsCompleted),
      stepTotal: PUBLICATION_STEPS.length,
      s3LockLocked: s3Locked,
      s3LockTotal: s3Total,
      s3LockResumed: step === "s3_lock" && s3LockIsResumed ? true : undefined,
    });
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let result: PublishApproveResponse;
      // Inner loop handles S3 lock pagination (CF Workers ~50 subrequest
      // limit per invocation). On the first call, pass the caller's
      // `resume` flag so the orchestrator either starts fresh or resumes
      // from persisted progress. On subsequent iterations (S3 lock
      // batching) always pass resume=true so we skip already-completed
      // steps and only continue locking objects.
      let isFirstCall = true;
      do {
        result = await request<PublishApproveResponse>(
          `/admin/publish/${datasetId}/approve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resume: isFirstCall ? useResume : true,
              sandbox,
              s3_lock_continuation_token,
              s3_lock_total,
              skip_ci_check: skipCiCheck,
              // Epic #1610 phase 4: the admin's recorded reason for approving
              // over a screen that needs a person to look. Sent on every call:
              // a retry that lands before the run is marked approving passes
              // the gate again, and must carry the same reason.
              ...(acknowledgeIdentifierScreen !== undefined
                ? { acknowledge_identifier_screen: acknowledgeIdentifierScreen }
                : {}),
            }),
          },
          true,
        );
        isFirstCall = false;

        if (result.step_results) {
          accumulatedStepResults.push(...result.step_results);
        }

        // Cache the server-computed total so the next request doesn't
        // force a re-count. Server returns this in every s3_lock response.
        if (result.s3_lock_total !== undefined) {
          s3_lock_total = result.s3_lock_total;
        }
        // Accumulate locked count across pages. s3LockLocked is at
        // function scope so it persists across outer retries and the
        // counter never resets mid-stream. (#284)
        if (result.s3_lock_batch_count !== undefined) {
          s3LockLocked += result.s3_lock_batch_count;
        }

        // Emit progress when the current step changes or when s3_lock is
        // paging. `result.step` is populated on hasMore responses; on the
        // final non-paging response we fall back to the last completed
        // step in `step_results` so the caller sees the last transition.
        const currentStep =
          result.step ?? result.step_results?.[result.step_results.length - 1]?.step;
        if (currentStep && (currentStep !== lastReportedStep || currentStep === "s3_lock")) {
          emitProgress(
            currentStep,
            result.steps_completed ?? [],
            currentStep === "s3_lock" ? s3LockLocked : undefined,
            currentStep === "s3_lock" ? s3_lock_total : undefined,
          );
          lastReportedStep = currentStep;
        }

        if (result.hasMore && result.s3_lock_continuation_token !== undefined) {
          s3_lock_continuation_token = result.s3_lock_continuation_token;
        } else {
          break;
        }
      } while (result.hasMore);

      if (accumulatedStepResults.length > 0) {
        // Dedupe by step name, keeping the most recent entry. Without this,
        // a step that failed-then-succeeded across a retry boundary appears
        // twice in the post-publication summary (once failed, once
        // completed) and the admin can't trust the count.
        result.step_results = dedupeStepResults(accumulatedStepResults);
      }
      return result;
    } catch (err) {
      lastError = err;
      const lastAttempt = attempt === MAX_ATTEMPTS;
      if (lastAttempt || !isRetryablePublishError(err)) {
        if (err instanceof ApiError && accumulatedStepResults.length > 0) {
          // Attach the per-attempt step timeline to the thrown error so the
          // CLI handler can show the full retry history (which step failed
          // when, and how many attempts each took) instead of just the
          // final raw 500 message.
          (err as ApiError & { stepResults?: StepResult[] }).stepResults =
            dedupeStepResults(accumulatedStepResults);
        }
        throw err;
      }

      const apiErr = err as ApiError;
      onRetry?.({
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        delayMs: RETRY_DELAY_MS,
        step: apiErr.step,
        error: apiErr.message,
      });

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      // Anything that succeeded in the failed attempt is already persisted
      // in D1; the next attempt must resume to skip it.
      useResume = true;
      // If the failure happened during s3_lock (continuation token is set,
      // meaning we were mid-stream), mark subsequent s3_lock progress events
      // as resumed so the CLI can append "(resumed)" to the spinner line.
      // The counter (s3LockLocked) is kept from before the failure so the
      // display shows the true running total rather than appearing to restart.
      if (s3_lock_continuation_token !== undefined) {
        s3LockIsResumed = true;
      }
    }
  }

  throw lastError;
}

/**
 * Dedupe step results by step name, keeping the latest entry per step.
 * Used to collapse multi-attempt retry timelines into a single summary
 * where each step appears once with its final status.
 */
function dedupeStepResults(results: StepResult[]): StepResult[] {
  const byStep = new Map<string, StepResult>();
  for (const r of results) byStep.set(r.step, r);
  return Array.from(byStep.values());
}
