/**
 * Publication-approval orchestrator (#904, epic #902).
 *
 * Extraction of the POST /admin/publish/:id/approve state machine from
 * routes/admin/publish.ts, behavior-preserving. This module owns the step
 * vocabulary (re-exported from shared/publication-steps.ts so the CLI's
 * progress display reads the same list) and the progress recorder that is
 * the single writer of publication_requests.{steps_completed,current_step,
 * last_error} during a run.
 */

import { z } from "zod";
import {
  ANONYMOUS_RELEASE_STEPS,
  OWNER_NAME_MISSING_REASON,
  PUBLICATION_STEPS,
  type PublicationStep,
  publishingStanding,
} from "../../../shared/publication-steps.js";

import {
  OVERRIDE_INSIDE_WEB_APPROVAL_MESSAGE,
  REQUEST_CHANGED_MESSAGE,
} from "../../../shared/contract/publication.js";
import { datasetLandingUrl } from "../../../shared/datacite-constants.js";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../../../shared/publication-limits.js";
import { REASON_CODES } from "../../../shared/publication-review.js";
import { auditLogStatement } from "../db/audit-log";
import { getS3Config } from "../routes/admin/shared";
import type { AuthUser, Bindings } from "../types/bindings";
import {
  ANONYMOUS_AUTHORS_LABEL,
  END_ANONYMITY_AT_PUBLICATION_SQL,
  FIRST_PUBLICATION_STAMP_SQL,
  PRIOR_ANONYMOUS_REQUEST_SQL,
  expectedRepoVisibility,
  isAnonymous,
  markAnonymous,
} from "./anonymity";
import {
  ACTIVE_REQUEST_TAIL_SQL,
  type Approver,
  approvalLeaseLiveSql,
  resolveApprover,
} from "./approval-dispatch";
import {
  isCentralManifestWorkflowEnabled,
  publishEzidVersionDoiViaCentral,
} from "./central-manifest";
import { type DataCiteEnrichment, nemarMetadataToEnrichment, parseNemarMetadata } from "./datacite";
import { runEnrichmentForDataset } from "./dataset-reindex";
import {
  type DoiProvider,
  applyConceptDoiToDescription,
  buildDoiBadge,
  createEzidVersionDoi,
  planReadmeBadgeCommit,
  resolveEzidAuth,
} from "./doi";
import { resolveEmailConfig, sendPublicationApprovedEmail } from "./email";
import { resolveDatasetLandingBase } from "./environment";
import { isExemplarPublishAllowed } from "./exemplar";
import { conceptEzidIdentifier, makePublic as ezidMakePublic, isSandboxIdentifier } from "./ezid";
import {
  checkWorkflowExists,
  createOrUpdateFile,
  createRelease,
  createTag,
  deleteRepoFile,
  deployWorkflows,
  ensureRepoToSpec,
  getBlobContent,
  getMainBranchSha,
  getTreeAtRef,
  getWorkflowRuns,
  setRepoVisibility,
} from "./github";
import { getDatasetsToken } from "./github-auth";
import { checkApprovalScreenGate } from "./identifier-screen";
import { generateManifest } from "./manifest";
import { scheduleNeurobagelSync } from "./neurobagel-hooks.js";
import {
  evaluateApprovalReviewGate,
  recordApprovalOverride,
  requestBlockedRefusal,
  reviewGateStateOf,
} from "./publication-review-gate.js";
import { BIDS_METADATA_UNAVAILABLE, errorMessage, readRepoMetadata } from "./repo-metadata";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "./repo-spec";
import { withRetry } from "./retry";
import {
  applyObjectLockBatch,
  getDatasetS3Stats,
  markDatasetPublic,
  uploadManifest,
  waitForPublicPropagation,
} from "./s3";
import { ZARR_REQUEUE_AT_PATH } from "./sweep-stamps";
import {
  OWNER_NAME_MISSING_MESSAGE,
  requiresUploaderName,
  resolveOwnerIdentity,
} from "./uploader-identity";

export { PUBLICATION_STEPS };
export type { PublicationStep };

/**
 * Result of a single publication step, included in the API response.
 */
export interface StepResult {
  step: PublicationStep;
  status: "completed" | "failed" | "skipped";
  attempts: number;
  duration_ms: number;
  error?: string;
}

/**
 * Progress recorder for one approve invocation.
 *
 * `completed` and `stepResults` are in-place-mutated arrays with STABLE
 * identity: step code destructures them once and abort-response bodies
 * reference them directly, so they must never be replaced with copies.
 *
 * `currentStepStartMs` is deliberately ONE shared slot, not per-step: steps
 * that call updateProgress without a preceding startStep (the no-op steps,
 * and ci_check's skip path) inherit the previous step's start time and
 * record an elapsed-since-then duration. That is the pre-extraction
 * behavior; do not "fix" it to a per-step timer.
 */
export interface ProgressRecorder {
  startStep(step: PublicationStep): Promise<void>;
  updateProgress(step: PublicationStep, error?: string, attempts?: number): Promise<void>;
  completed: PublicationStep[];
  stepResults: StepResult[];
}

export function createProgressRecorder(
  db: D1Database,
  requestId: number,
  datasetId: string,
  initialCompleted: PublicationStep[],
): ProgressRecorder {
  const completed: PublicationStep[] = [...initialCompleted];
  const stepResults: StepResult[] = [];

  // Track step start time for duration measurement
  let currentStepStartMs = 0;

  // Helper to set current step before execution. Non-fatal on failure.
  async function startStep(step: PublicationStep) {
    currentStepStartMs = Date.now();
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(step, requestId)
        .run();
    } catch (dbErr) {
      console.error(`[publish] Failed to set current_step to ${step}:`, dbErr);
    }
  }

  // Helper to update progress in D1. Catches its own errors to avoid
  // masking the original failure when called inside catch blocks.
  async function updateProgress(step: PublicationStep, error?: string, attempts = 1) {
    const duration_ms = currentStepStartMs > 0 ? Date.now() - currentStepStartMs : 0;
    if (!error) {
      completed.push(step);
      stepResults.push({ step, status: "completed", attempts, duration_ms });
    } else {
      stepResults.push({ step, status: "failed", attempts, duration_ms, error });
    }
    try {
      await db
        .prepare(
          `UPDATE publication_requests
           SET steps_completed = ?, current_step = ?, last_error = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(JSON.stringify(completed), error ? step : null, error || null, requestId)
        .run();
    } catch (dbErr) {
      console.error(
        `[publish] CRITICAL: Failed to update progress for step ${step}, dataset ${datasetId}:`,
        dbErr,
      );
    }
  }

  return { startStep, updateProgress, completed, stepResults };
}

// ---------------------------------------------------------------------------
// Approve orchestration (#904): types, schema, helpers, step functions, runner.
// Step bodies are moved VERBATIM from the former inline handler in
// routes/admin/publish.ts; the only rewrites are the whitelisted transforms
// documented in the PR (isRespond, dynamic-import depth, c.* slot fields).
// ---------------------------------------------------------------------------

/**
 * A step's request-terminating outcome: the exact JSON body + status the
 * route returns. Produced by the `c.json(...)` facade inside step code (same
 * call shape as Hono's) so moved bodies stay verbatim; serialization happens
 * once at the route boundary, which is safe because every outcome is either
 * returned immediately or discarded.
 *
 * The discriminant is a unique symbol, not a string key: several helpers
 * return `parsed-JSON | RespondOutcome` unions where the JSON side is
 * dataset-owner-controlled (dataset_description.json), and a symbol cannot
 * be forged by JSON.parse — matching the unforgeability the pre-extraction
 * `instanceof Response` checks had.
 */
const RESPOND: unique symbol = Symbol("respond");

export interface RespondOutcome {
  [RESPOND]: true;
  body: unknown;
  status?: number;
}

export function makeRespond(body: unknown, status?: number): RespondOutcome {
  return { [RESPOND]: true, body, status };
}

export function isRespond(v: unknown): v is RespondOutcome {
  return typeof v === "object" && v !== null && RESPOND in v;
}

/**
 * How the audit trail names the administrator whose key executed a run attributed to another (a
 * web approval, ADR 0080): the username, or the id as text when there is none. One form for every
 * row that carries `executed_by`, so the field has one type across the trail.
 */
function executorName(adminUser: Pick<AuthUser, "id" | "username">): string {
  return adminUser.username || String(adminUser.id);
}

/** An acknowledgment of the identifier screen: a stated reason, 10 to 500 characters once trimmed. */
export const acknowledgeIdentifierScreenSchema = z
  .string()
  .trim()
  .min(
    ACKNOWLEDGMENT_MIN_LENGTH,
    `The acknowledgment needs a reason of at least ${ACKNOWLEDGMENT_MIN_LENGTH} characters`,
  )
  .max(
    ACKNOWLEDGMENT_MAX_LENGTH,
    `The acknowledgment is limited to ${ACKNOWLEDGMENT_MAX_LENGTH} characters`,
  );

/**
 * The override of the publication review as the approval routes accept it. Shared by `/approve` and
 * `approve-dispatch` so the two read one shape; its type is `PublicationReviewOverride`.
 */
export const publicationReviewOverrideSchema = z
  .object({
    review_id: z.number().int().positive().nullable(),
    reasons: z.array(z.enum(REASON_CODES)).max(REASON_CODES.length),
  })
  .strict();

/**
 * POST /admin/publish/:id/approve - Approve and run publication orchestrator
 *
 * The step inventory and execution order live in PUBLICATION_STEPS
 * (shared/publication-steps.ts); a hand-written enumeration here had drifted
 * to 14 misnumbered entries — the drift class #904 removes.
 *
 * (Archive zip generation is NOT an orchestrator step -- the central
 * run-version-doi.yml workflow dispatches generate-archive after the version
 * DOI mint; see #670.)
 *
 * Body: { resume?: boolean } - if true, skip already-completed steps
 */
export const approveSchema = z.object({
  resume: z.boolean().optional().default(false),
  sandbox: z.boolean().optional().default(false),
  s3_lock_continuation_token: z.string().optional(),
  // Total S3 object count for the dataset's `objects/` prefix. The server
  // computes this once on the first s3_lock call (when no continuation
  // token is sent) and returns it via `s3_lock_total` in every response;
  // the CLI threads it back on subsequent calls so progress reporting
  // ("Locking S3 objects: 1240/4963 (25.0%)") survives across the many
  // sequential Worker invocations a large dataset requires. See #284.
  s3_lock_total: z.number().int().nonnegative().optional(),
  // Pre-#385 CLIs (v0.8.4 and earlier) sent `s3_lock_offset` for
  // offset-paginated batching. The server no longer reads it AND no
  // longer returns it on the response, which means an old CLI's inner
  // pagination loop breaks out on the very first `hasMore: true`,
  // silently reporting "lock complete" after only the first batch — a
  // dataset published this way ends up with most objects unlocked. We
  // detect this case explicitly and reject with 426 so the admin sees a
  // clear "upgrade required" message instead of corrupt-by-omission
  // success.
  s3_lock_offset: z.number().optional(),
  skip_ci_check: z.boolean().optional().default(false),
  // Epic #1610 phase 4: an admin's reason for approving over an identifier
  // screen that needs a person to look (`screenGate` answers "acknowledge").
  // Recorded on the request with the admin and audited; ignored for any other
  // screen state, and never enough for direct identifiers.
  acknowledge_identifier_screen: acknowledgeIdentifierScreenSchema.optional(),
  // ADR 0102: an administrator's override of a publication review that is not a pass, given for
  // the review shown (`review_id`, null when there was none) and the reasons shown. Strict, so a
  // field the gate does not know cannot ride along, and it means nothing unless the review gate
  // is on and a reason stands that an override clears. `/approve` takes it from a bearer key only.
  override_publication_review: publicationReviewOverrideSchema.optional(),
});

export type ApproveBody = z.infer<typeof approveSchema>;

/** Dataset snapshot the approve flow threads between steps. `doi_create`
 *  mutates it in place so later steps see fresh DOI fields. */
export interface ApproveDataset {
  id: number;
  dataset_id: string;
  name: string;
  description: string | null;
  github_repo: string | null;
  concept_doi: string | null;
  zenodo_concept_id: string | null;
  ezid_status: string | null;
  is_sandbox: number | null;
  is_exemplar: number | null;
  source: string | null;
  /**
   * #1408: 1 when the dataset is currently a blinded deposit. Selected by the
   * `SELECT d.*` that builds this row. Declared rather than left implicit,
   * because the de-anonymization branch reads it and an omission would
   * silently publish a blinded dataset with its attribution never restored.
   */
  anonymous: number | null;
  owner_username: string;
  owner_email: string;
  owner_orcid: string | null;
  /** Real name for DOI attribution (#1255); the username is never cited. */
  owner_given_name: string | null;
  owner_family_name: string | null;
}

interface ApproveHelpers {
  readDatasetDescription(
    stepName: PublicationStep,
  ): Promise<Record<string, unknown> | RespondOutcome>;
  getConceptDoi(stepName: PublicationStep): Promise<string | RespondOutcome>;
  getVersionTag(
    stepName: PublicationStep,
  ): Promise<
    { version: string; tag: string; datasetDesc: Record<string, unknown> } | RespondOutcome
  >;
}

/**
 * Everything a step can see. Named `c` at every use site so moved bodies keep
 * their `c.env` / `c.json(...)` / `c.executionCtx.waitUntil(...)` references
 * byte-identical to the pre-extraction handler. Built progressively by the
 * runner (requestId/repoName/pat/dataset/stepsToRun/recorder/helpers are
 * assigned after the pre-loop resolves them, before any step runs).
 */
export interface ApproveStepContext {
  env: Bindings;
  db: D1Database;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
  json(body: unknown, status?: number): RespondOutcome;
  datasetId: string;
  /** The account that called `/approve`: a person at a terminal, or the
   *  executor's service key. Not necessarily the approver; see `approver`. */
  adminUser: AuthUser;
  /** Who the publication is recorded as approved by. The admin who clicked
   *  Approve on the website when the run was dispatched from there, otherwise
   *  `adminUser` (ADR 0080). Assigned once the request is found. */
  approver: Approver;
  body: ApproveBody;
  requestId: number;
  repoName: string;
  pat: string;
  dataset: ApproveDataset;
  stepsToRun: readonly PublicationStep[];
  /** #1408: this run releases the data while concealing the depositor. */
  anonymousRelease: boolean;
  recorder: ProgressRecorder;
  helpers: ApproveHelpers;
  // Cross-step slots read by the finalize block. Captured at the end of the
  // s3_lock step so the final success response can include the last-batch
  // count; the CLI accumulates `s3_lock_batch_count` from every response to
  // render the completed percentage. (#284)
  s3LockFinalTotal: number | undefined;
  s3LockFinalBatchCount: number | undefined;
  notifyUserWarning: string | undefined;
}

function createApproveHelpers(
  // Narrowed to what the helpers actually read: makes the one construction-
  // time circularity (helpers close over `c` before c.helpers exists)
  // explicit and keeps them honest about their dependencies.
  c: Pick<
    ApproveStepContext,
    "db" | "datasetId" | "repoName" | "pat" | "recorder" | "json" | "env"
  >,
): ApproveHelpers {
  const db = c.db;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;

  // --- Helper: read dataset_description.json from repo ---
  async function readDatasetDescription(
    stepName: PublicationStep,
  ): Promise<Record<string, unknown> | RespondOutcome> {
    const tree = await getTreeAtRef(repoName, "main", pat);
    const descFile = tree.find((f) => f.path === "dataset_description.json");
    if (!descFile) {
      await updateProgress(stepName, "dataset_description.json not found in repo");
      return c.json(
        {
          error: "dataset_description.json not found in repository",
          step: stepName,
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
    const content = await getBlobContent(repoName, descFile.sha, pat);
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch (parseErr) {
      const parseMsg = `dataset_description.json contains invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`;
      console.error(
        `[publish] ${parseMsg} for ${repoName}. Content starts with: ${content.substring(0, 200)}`,
      );
      await updateProgress(stepName, parseMsg);
      return c.json(
        {
          error: parseMsg,
          step: stepName,
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // --- Helper: get concept DOI from database ---
  async function getConceptDoi(stepName: PublicationStep): Promise<string | RespondOutcome> {
    const row = await db
      .prepare("SELECT concept_doi FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ concept_doi: string | null }>();
    if (!row?.concept_doi) {
      await updateProgress(stepName, "No concept DOI found");
      return c.json(
        {
          error: `Cannot run ${stepName}: no concept DOI found`,
          step: stepName,
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
    return row.concept_doi;
  }

  // --- Helper: get version and tag from dataset_description.json ---
  // NOTE: This helper only reads; version defaulting is handled in update_metadata
  // to avoid creating [skip ci] commits that the create_tag step would tag.
  async function getVersionTag(
    stepName: PublicationStep,
  ): Promise<
    { version: string; tag: string; datasetDesc: Record<string, unknown> } | RespondOutcome
  > {
    const result = await readDatasetDescription(stepName);
    if (isRespond(result)) return result;
    const datasetDesc = result;
    const version = String(datasetDesc.Version || "1.0.0");
    return { version, tag: `v${version}`, datasetDesc };
  }

  return { readDatasetDescription, getConceptDoi, getVersionTag };
}

async function stepCiCheck(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const body = c.body;
  const adminUser = c.adminUser;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;

  // Step 1: CI Check
  if (stepsToRun.includes("ci_check")) {
    if (body.skip_ci_check) {
      console.warn(`[publish] CI check skipped by admin ${adminUser.username} for ${datasetId}`);
      // The skip is on the record when it happens: the approval's own row says only what the call
      // that FINISHED the run asked for, and a run resumed with another flag would lose it.
      // Best effort, like the approval's row: a missing row never changes the run.
      try {
        await auditLogStatement(c.db, {
          userId: c.approver.id,
          action: "publication_ci_check_skipped",
          resourceType: "dataset",
          resourceId: datasetId,
          details: JSON.stringify({
            request_id: c.requestId,
            ...(c.approver.id !== adminUser.id ? { executed_by: executorName(adminUser) } : {}),
          }),
        }).run();
      } catch (auditError) {
        console.error(
          `[publish] audit write for the skipped CI check on ${datasetId} failed: ${errorMessage(auditError)}`,
        );
      }
      await updateProgress("ci_check");
    } else {
      try {
        await startStep("ci_check");

        const bidsExists = await checkWorkflowExists(
          repoName,
          ".github/workflows/bids-validation.yml",
          pat,
        );
        if (!bidsExists) {
          const deployResult = await deployWorkflows(repoName, pat);
          if (!deployResult.success) {
            throw new Error(
              `Failed to deploy CI workflows to ${repoName}: ${deployResult.errors.join("; ")}`,
            );
          }
        }

        // Check latest run status (if workflow existed, verify it passes)
        // Freshly deployed workflows have no runs yet, which is acceptable
        const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
        if (runs.length > 0) {
          const latest = runs[0];
          if (latest.conclusion === "failure") {
            await updateProgress("ci_check", "BIDS validation CI is failing");
            return c.json(
              {
                error: "CI check failed: BIDS validation is failing",
                dataset_id: datasetId,
                step: "ci_check",
                steps_completed: completed,
                step_results: stepResults,
              },
              422,
            );
          }
        }

        await updateProgress("ci_check");
      } catch (err) {
        const msg = errorMessage(err);
        await updateProgress("ci_check", msg);
        return c.json(
          {
            error: `CI check failed: ${msg}`,
            step: "ci_check",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }
  }

  return undefined;
}

async function stepEnrichmentCheck(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const db = c.db;
  const datasetId = c.datasetId;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;

  // Step 2: Enrichment check (warn-only, does not block publication)
  if (stepsToRun.includes("enrichment_check")) {
    try {
      await startStep("enrichment_check");

      const enrichRow = await db
        .prepare("SELECT enrichment_json FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ enrichment_json: string | null }>();

      if (!enrichRow?.enrichment_json) {
        console.warn(
          `[publish] Dataset ${datasetId} has no LLM enrichment metadata. DOI will have minimal metadata.`,
        );
      }

      await updateProgress("enrichment_check");
    } catch (err) {
      // Non-fatal: log error and continue (enrichment check should not block publication)
      console.warn(
        `[publish] Enrichment check failed for ${datasetId} (non-fatal): ${errorMessage(err)}`,
      );
      await updateProgress("enrichment_check");
    }
  }

  return undefined;
}

async function stepS3PublicRead(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const datasetId = c.datasetId;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;

  // Add the S3 public-read bucket policy (deny-list removal). Runs as the FIRST
  // mutation after the validation gates (epic #736, Phase 4 / #741) so the
  // bucket-policy change has the most time to propagate before create_tag fires
  // generate-archive.
  if (stepsToRun.includes("s3_public_read")) {
    try {
      await startStep("s3_public_read");

      const { attempts: s3PublicAttempts } = await withRetry(
        () => markDatasetPublic(getS3Config(c.env), datasetId),
        "s3_public_read",
      );

      // Non-fatal propagation gate: confirm a real blob is actually anonymously
      // readable, so a stuck/slow propagation is surfaced rather than silently
      // assumed (the nm000111 failure mode). Run it via waitUntil
      // (fire-and-forget) so its bounded poll (~10s) overlaps the subsequent
      // publish steps instead of adding serial latency toward the Worker
      // wall-clock limit -- the gate is observability-only and the cascade
      // proceeds regardless (Phase 1's signed reads removed the hard dependency).
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const propagation = await waitForPublicPropagation(getS3Config(c.env), datasetId);
            if (propagation.checked && !propagation.propagated) {
              console.warn(
                `[publish] s3_public_read: public access not yet propagated for ${datasetId} after ${propagation.attempts} probes (key=${propagation.key})`,
              );
            } else {
              console.log(
                `[publish] s3_public_read: propagation ${
                  propagation.checked
                    ? `confirmed in ${propagation.attempts} probe(s)`
                    : "skipped (no annexed objects)"
                } for ${datasetId}`,
              );
            }
          } catch (gateErr) {
            console.warn(
              `[publish] s3_public_read: propagation probe errored for ${datasetId} (non-fatal):`,
              gateErr instanceof Error ? gateErr.message : String(gateErr),
            );
          }
        })(),
      );

      await updateProgress("s3_public_read", undefined, s3PublicAttempts);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] S3 public read policy failed for ${datasetId}:`, err);
      await updateProgress("s3_public_read", msg);
      return c.json(
        {
          error: `S3 public read policy failed: ${msg}`,
          step: "s3_public_read",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

async function stepRepoPublic(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const db = c.db;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;

  // Make the repository public (runs after the S3 public flip; the two are
  // independent, S3 goes first for propagation lead time).
  //
  // #1408: for an ANONYMOUS release this step still runs, because it is what
  // flips the catalog row to public -- which is the whole point of the release
  // -- but the repository stays private. The step's name is now narrower than
  // what it does. `expectedRepoVisibility` is the one rule that decides, shared
  // with the drift report and the visibility service, so the three cannot
  // disagree about what an anonymous deposit's repository should be.
  if (stepsToRun.includes("repo_public")) {
    try {
      await startStep("repo_public");

      // Does this run have to RESTORE attribution that an earlier anonymous
      // release withheld? Asked once, here, before any write in this step can
      // change the answer, and asked of the request history rather than of
      // `datasets.anonymous`: the history is durable, the flag is cleared by
      // this step's own UPDATE and re-read fresh on every retry. Same source
      // `c.anonymousRelease` comes from, one row older.
      const priorAnonymous = c.anonymousRelease
        ? null
        : await db.prepare(PRIOR_ANONYMOUS_REQUEST_SQL).bind(datasetId).first<{ found: number }>();
      const restoreAttribution =
        !c.anonymousRelease && (isAnonymous(c.dataset) || priorAnonymous?.found === 1);

      const repoShouldBePrivate =
        expectedRepoVisibility({
          visibility: "public",
          anonymous: c.anonymousRelease ? 1 : 0,
        }) === "private";
      const result = await setRepoVisibility(repoName, repoShouldBePrivate, pat);
      if (!result.ok) {
        await updateProgress("repo_public", `Failed to make repo public: ${result.error}`);
        return c.json(
          {
            error: `Failed to make repo public: ${result.error}`,
            step: "repo_public",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }

      // Turn the flag on at the same point the data becomes readable, and
      // scrub what an earlier enrichment already wrote. `markAnonymous` does
      // the D1 half atomically -- `datasets.authors`, the cached enrichment
      // document -- and reports the half it cannot reach.
      if (c.anonymousRelease) {
        const marked = await markAnonymous(c.env, datasetId);
        if (!marked.changed) {
          await updateProgress("repo_public", "Failed to mark dataset anonymous");
          return c.json(
            {
              error: `Failed to mark ${datasetId} anonymous; the release was stopped rather than published under the depositor's name`,
              step: "repo_public",
              steps_completed: completed,
              step_results: stepResults,
            },
            500,
          );
        }
        // `.nemar/metadata.json` is backend-written, git-tracked and served
        // publicly from the manifest since #1403, so it still names the
        // depositor until a fresh enrichment rewrites it. This has to happen
        // BEFORE the data plane serves the release, which is why it is here
        // and not in a later step.
        //
        // UNCONDITIONAL, and `repoMetadataStale` is only logged. That flag is
        // read from D1 (`enrichment_json IS NOT NULL`), which is a CACHE of
        // the committed document, not the document: an admin revert nulls the
        // column and leaves the repository's file in place
        // (`routes/admin/datasets-lifecycle.ts`), as does any manual repair or
        // half-finished reindex. When the two disagree the flag says "nothing
        // to do" and the blind silently never reaches the repository -- a
        // failure with no log, on the file the data plane serves. An extra
        // enrichment pass on a dataset that did not need one costs a commit;
        // the other direction costs the guarantee.
        const reenriched = await runEnrichmentForDataset(c.env, datasetId);
        if (!reenriched.ok) {
          await updateProgress(
            "repo_public",
            `Failed to re-enrich after blinding: ${reenriched.error}`,
          );
          return c.json(
            {
              error: `${datasetId} was marked anonymous but its committed .nemar/metadata.json still names the depositor, and re-enrichment failed: ${reenriched.error}`,
              step: "repo_public",
              steps_completed: completed,
              step_results: stepResults,
            },
            500,
          );
        }
        if (reenriched.warnings?.length) {
          // Logged, never `updateProgress`: that helper's second argument
          // marks the step FAILED, and these are things the enrichment
          // declined to do, not things that went wrong. One of them is the
          // anonymity guard in the DOI sync refusing to touch DataCite, which
          // is the blind working as designed.
          console.warn(
            `[publish] ${datasetId} blinding enrichment warnings: ${reenriched.warnings.join("; ")}`,
          );
        }
        if (!marked.repoMetadataStale) {
          console.log(
            `[publish] ${datasetId}: no cached enrichment before blinding; re-enriched anyway so the committed metadata cannot be stale`,
          );
        }
      }

      // Update dataset visibility in database to match GitHub repo visibility,
      // and record the first publication of the depositor's identity in the
      // SAME statement.
      //
      // Here, and not after the run completes. This is the moment the
      // repository becomes readable by the world, so it is the moment
      // concealment actually ends; every later step can fail and return, and
      // a stamp at the end of the run would leave a dataset public on GitHub
      // and anonymous in D1 with nothing to retry it. `first_published_at` is
      // also the only durable record that a dataset has ever been public --
      // `visibility` has no history, and `concept_doi IS NULL` is unsound
      // because this step runs before `doi_create`, so a crashed run leaves a
      // public dataset with no DOI.
      //
      // One statement because migration 0085's triggers refuse a row that is
      // simultaneously anonymous and published, so clearing the flag and
      // stamping the date separately would abort on whichever ran first. The
      // publication-request route refuses a still-anonymous dataset, so
      // `anonymous = 0` is normally already true; it is written anyway
      // because an admin-approved run that somehow reached here must not end
      // with a public dataset that still claims to be concealed.
      let dbUpdateResult: D1Result;
      try {
        dbUpdateResult = await db
          .prepare(
            `UPDATE datasets
             SET visibility = 'public',
                 ${c.anonymousRelease ? FIRST_PUBLICATION_STAMP_SQL : END_ANONYMITY_AT_PUBLICATION_SQL},
                 updated_at = datetime('now')
             WHERE dataset_id = ?`,
          )
          .bind(datasetId)
          .run();

        if (!dbUpdateResult.success) {
          throw new Error("Database update did not succeed");
        }

        if (dbUpdateResult.meta.changes === 0) {
          throw new Error("Dataset not found in database");
        }

        // Verify the write persisted (read-after-write check)
        const verify = await db
          .prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
          .bind(datasetId)
          .first<{ visibility: string }>();

        if (!verify || verify.visibility !== "public") {
          console.error(
            `[publish] CRITICAL: Visibility read-after-write mismatch for ${datasetId}: expected 'public', got '${verify?.visibility}'`,
          );
          throw new Error(
            `Read-after-write verification failed: visibility is '${verify?.visibility}' instead of 'public'`,
          );
        }
      } catch (dbError) {
        const msg = dbError instanceof Error ? dbError.message : String(dbError);
        console.error(
          `CRITICAL: Failed to update database visibility for ${datasetId} after making repo public:`,
          msg,
        );
        await updateProgress("repo_public", `Database visibility update failed: ${msg}`);
        return c.json(
          {
            error: "Critical: Database update failed after making repository public",
            details: msg,
            dataset_id: datasetId,
            github_visibility: "public",
            database_visibility: "private (update failed)",
            // The recovery statement an operator is told to run has to carry
            // the same stamp the code path it is repairing carries (#1407);
            // without it the repaired dataset would be public with its
            // publication unrecorded, and could then be made anonymous
            // retroactively. For an ANONYMOUS release the correct stamp is the
            // other one: pasting END_ANONYMITY there would name the depositor
            // as published and destroy the concealment the run was delivering,
            // by hand, with no way back (#1408).
            action_required: `Manually update database: UPDATE datasets SET visibility = 'public', ${
              c.anonymousRelease ? FIRST_PUBLICATION_STAMP_SQL : END_ANONYMITY_AT_PUBLICATION_SQL
            } WHERE dataset_id = '${datasetId}'`,
            step_results: stepResults,
          },
          500,
        );
      }

      // De-anonymization (#1408). The UPDATE above already cleared the flag
      // via END_ANONYMITY_AT_PUBLICATION_SQL, but clearing it only changes
      // what the WRITERS will do next -- it does not rewrite what they wrote
      // while the deposit was blind. `datasets.authors` still holds the
      // blinded label, the cached enrichment document is stripped, and the
      // repository's committed `.nemar/metadata.json` carries no attribution.
      // One enrichment pass restores all three, because phase 2 put the author
      // blind inside `writeDatasetCatalogFields` (it decides from the row) and
      // made the DataCite sync conditional on the same flag. Both reverse
      // themselves now that the row is no longer anonymous.
      //
      // It runs HERE, before doi_create, because the mint prefers
      // `.nemar/metadata.json` over the BIDS description when that file parses
      // -- so minting first would cite an enrichment with no authors.
      //
      // OUTSIDE the database try/catch above, deliberately. This makes GitHub
      // and Claude API calls, and any throw from them landed in a handler that
      // reports "Database update failed after making repository public" and
      // hands the operator a visibility-repair SQL statement -- for a failure
      // that had nothing to do with the database, on a row the statement would
      // not fix. The visibility write is verified by the time we get here.
      //
      // The condition is `restoreAttribution`, captured BEFORE that UPDATE and
      // derived from the request history rather than from
      // `c.dataset.anonymous`. Reading the row here was self-defeating: the
      // UPDATE sets `anonymous = 0`, and the run context is re-SELECTed on
      // every invocation, so a retry after a failed enrichment saw a
      // non-anonymous row, skipped this block silently, and went on to mint a
      // PERMANENT DataCite record whose creator is the blinded label -- the
      // one outcome the step order exists to prevent, reached by the one path
      // an admin is most likely to take.
      if (restoreAttribution) {
        const restored = await runEnrichmentForDataset(c.env, datasetId);
        if (!restored.ok) {
          await updateProgress(
            "repo_public",
            `Failed to re-enrich after de-anonymizing: ${restored.error}`,
          );
          return c.json(
            {
              error: `${datasetId} was de-anonymized but its attribution could not be restored: ${restored.error}. It is now PUBLIC and its publication is recorded; what is missing is the attribution. No DOI was minted. Approve the request again once the cause is cleared -- the restoration is re-attempted on every run and doi_create refuses to mint until it succeeds.`,
              step: "repo_public",
              steps_completed: completed,
              step_results: stepResults,
            },
            500,
          );
        }
        if (restored.warnings?.length) {
          console.warn(
            `[publish] ${datasetId} de-anonymization enrichment warnings: ${restored.warnings.join("; ")}`,
          );
        }

        // The Zarr rebuild this de-anonymization needs is requested at the END
        // of the run (`stampZarrRequeue`), not here: a rebuild that raced this
        // point would bake the restored attribution WITHOUT the DOI, which is
        // not yet minted, and spend the one request doing it.
      }

      // Enforce the published-repo spec (epic #713): lock main (ruleset,
      // green-gated) + reconcile collaborators. Non-fatal; visibility is
      // already public + verified above.
      let publishSpec: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
      try {
        const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);
        publishSpec = await ensureRepoToSpec(repoName, pat, {
          // From the same rule the visibility flip above used, not a literal.
          // A hardcoded "public" here took the published-repo branch for an
          // anonymous release and locked `main` behind a pull-request ruleset
          // on a repository that is still PRIVATE -- which breaks the
          // documented way out of anonymity, where the depositor commits their
          // restored Authors straight to `main` precisely because ADR 0001's
          // PR-only rule has not bitten yet. It applied silently: a successful
          // ruleset is not logged, and the depositor would have found out at
          // acceptance time.
          visibility: repoShouldBePrivate ? "private" : "public",
          collaborators: { ownerLogin, approvedWriters },
        });
        // Surface a non-green/failed protection step in the bulk-approval log,
        // since the orchestrator response does not carry the per-step detail.
        const offSteps = Object.entries(publishSpec.steps)
          .filter(([, s]) => s.status !== "ok")
          .map(([k, s]) => `${k}=${s.status}${s.detail ? `(${s.detail})` : ""}`);
        if (offSteps.length > 0) {
          console.warn(`[repo-spec] ${datasetId} enforcement non-ok steps: ${offSteps.join(", ")}`);
        }
      } catch (specError) {
        console.error(`Repo-spec enforcement failed for ${datasetId} (non-fatal):`, specError);
      }
      // Mirror reconcile removals into D1 (own try/catch; flags a divergence).
      await mirrorReconcileRemovals(db, datasetId, publishSpec?.reconcile?.removed);

      await updateProgress("repo_public");
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("repo_public", msg);
      return c.json(
        {
          error: `repo_public failed: ${msg}`,
          step: "repo_public",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

async function stepTagProtect(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const repoName = c.repoName;
  const pat = c.pat;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;

  // Tag protection (before DOI to prevent tag manipulation)
  // Idempotent: applyTagProtection treats 422 (rule already exists) as
  // success and throws HttpError with status + body on terminal failure.
  // No inline withRetry: githubFetchWithRetry inside applyTagProtection
  // already absorbs short propagation 5xx/404 windows. Persistent failures
  // (e.g., GitHub "Repository has been locked" right after a visibility
  // flip) are surfaced as 500 so the CLI's retry-with-delay loop can
  // re-invoke from a fresh Worker (and a fresh propagation window).
  if (stepsToRun.includes("tag_protect")) {
    try {
      await startStep("tag_protect");

      const { applyTagProtection } = await import("./github");
      await applyTagProtection(repoName, pat);

      await updateProgress("tag_protect");
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("tag_protect", msg);
      return c.json(
        {
          error: `Tag protection failed: ${msg}`,
          step: "tag_protect",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

/**
 * Refuse to write a permanent identifier while the catalog still carries the
 * blinded label (#1408).
 *
 * The ordering that makes de-anonymization work -- restore attribution, then
 * mint -- is enforced by the step order in `stepRepoPublic`. This is the same
 * rule stated as an INVARIANT rather than as a sequence, because the cost of
 * the sequence being wrong is not recoverable: a DataCite record naming
 * `ANONYMOUS_AUTHORS_LABEL` as its creator is harvested within hours and
 * inverts ADR 0041 on the one identifier nothing can retract. A guard that
 * reads the state cannot be defeated by a retry, a resume, or a future
 * reordering of the steps.
 *
 * Reads `datasets.authors` fresh rather than trusting the run context, which
 * was loaded before the restoration ran.
 */
async function blockedByUnrestoredAttribution(
  c: ApproveStepContext,
  step: PublicationStep,
): Promise<RespondOutcome | undefined> {
  if (c.anonymousRelease) return undefined;
  const row = await c.db
    .prepare("SELECT authors FROM datasets WHERE dataset_id = ?")
    .bind(c.datasetId)
    .first<{ authors: string | null }>();
  if (row?.authors !== ANONYMOUS_AUTHORS_LABEL) return undefined;
  await c.recorder.updateProgress(step, "Attribution is still blinded");
  return c.json(
    {
      error: `${c.datasetId} still carries the anonymous-deposit author label, so a DOI minted or published now would cite "${ANONYMOUS_AUTHORS_LABEL}" permanently. Restore the real Authors in dataset_description.json and approve again.`,
      step,
      steps_completed: c.recorder.completed,
      step_results: c.recorder.stepResults,
    },
    500,
  );
}

async function stepDoiCreate(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const db = c.db;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const dataset = c.dataset;
  const sandbox = c.body.sandbox;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;
  const readDatasetDescription = c.helpers.readDatasetDescription;

  // Step 6: Create concept DOI (if not exists)
  if (stepsToRun.includes("doi_create")) {
    const blocked = await blockedByUnrestoredAttribution(c, "doi_create");
    if (blocked) return blocked;
    try {
      await startStep("doi_create");

      if (!dataset.concept_doi) {
        // SAFETY: Block production DOI creation in non-production environments
        if (!sandbox) {
          const environment = c.env.ENVIRONMENT;
          if (!environment) {
            await updateProgress("doi_create", "ENVIRONMENT variable not configured");
            return c.json(
              {
                error: "Server misconfiguration: ENVIRONMENT variable not set",
                message:
                  "Cannot create production DOIs without explicit environment configuration. Use --sandbox for testing.",
                step: "doi_create",
                steps_completed: completed,
                step_results: stepResults,
              },
              500,
            );
          }
          const normalizedEnv = environment.toLowerCase().trim();
          if (normalizedEnv !== "production") {
            await updateProgress("doi_create", "Production DOI blocked in non-production");
            return c.json(
              {
                error: "Production DOI creation blocked in non-production environment",
                message: "Use --sandbox flag for testing, or deploy to production.",
                environment: normalizedEnv,
                step: "doi_create",
                steps_completed: completed,
                step_results: stepResults,
              },
              400,
            );
          }
        }

        // EZID is the sole provider (ADR 0007); the doi_provider column is
        // gone (#1182), so this is a constant rather than a per-dataset read.
        const provider: DoiProvider = "ezid";

        // Read BIDS metadata and enrichment for richer DOI records
        let bidsDesc: Record<string, unknown> | undefined;
        let enrichment: DataCiteEnrichment | undefined;
        if (repoName) {
          const descResult = await readDatasetDescription("doi_create");
          if (isRespond(descResult)) return descResult;
          bidsDesc = descResult;

          // Read .nemar/metadata.json enrichment (same pattern as doi update)
          const tree = await getTreeAtRef(repoName, "main", pat);
          const nemarMetaFile =
            tree.find((f) => f.path === ".nemar/metadata.json") ||
            tree.find((f) => f.path === "nemar_metadata.json");
          if (nemarMetaFile) {
            try {
              const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
              const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
              if (nemarParsed) {
                enrichment = nemarMetadataToEnrichment(nemarParsed);
              }
            } catch (nemarErr) {
              console.warn(
                "[publish] doi_create: .nemar/metadata.json enrichment skipped:",
                nemarErr,
              );
            }
          }
        }

        // EZID DOIs are deterministic (buildConceptIdentifier is a pure function
        // of datasetId), and createEzidConceptDoi already handles the
        // "already exists" case by fetching the existing record. That makes
        // EZID minting idempotent under retry, which is what we want here:
        // EZID/DataCite propagation can briefly fail with transient 5xx or
        // network errors during approval.
        const { createConceptDoi: doiDispatch } = await import("./doi");
        const doiCall = () =>
          doiDispatch(
            {
              provider,
              datasetId,
              datasetName: dataset.name,
              datasetDescription: dataset.description,
              githubRepo: dataset.github_repo,
              bidsDescription: bidsDesc,
              enrichment,
              // The approval entry point already refused a required-but-missing
              // identity; passing the flag makes doi.ts enforce it too, so a
              // future caller of this step cannot skip the rule (#1255).
              uploader: resolveOwnerIdentity(dataset),
              uploaderRequired: requiresUploaderName(dataset),
              // #1408: an anonymous release mints a reserved identifier with no
              // DataCurator. Read from THIS RUN's intent rather than from the
              // dataset row: on a normal publication of a formerly blinded
              // deposit the row was still anonymous moments ago, and reading it
              // would mint the real, permanent DOI with no attribution at all --
              // inverting ADR 0041 on the one identifier that gets harvested.
              anonymousDeposit: c.anonymousRelease,
              sandbox,
            },
            {
              EZID_USERNAME: c.env.EZID_USERNAME,
              EZID_PASSWORD: c.env.EZID_PASSWORD,
              EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
              EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
              ZENODO_API_KEY: c.env.ZENODO_API_KEY,
              ZENODO_SANDBOX_API_KEY: c.env.ZENODO_SANDBOX_API_KEY,
              // Landing-base resolution for the concept DOI _target (epic #923).
              FRONTEND_URL: c.env.FRONTEND_URL,
              DATASET_LANDING_BASE_URL: c.env.DATASET_LANDING_BASE_URL,
            },
          );
        const { result: doiResult, attempts: doiAttempts } = await withRetry(doiCall, "doi_create");
        await db
          .prepare(
            "UPDATE datasets SET concept_doi = ?, ezid_status = ?, is_sandbox = ?, updated_at = datetime('now') WHERE dataset_id = ?",
          )
          .bind(doiResult.doi, doiResult.status, sandbox ? 1 : 0, datasetId)
          .run();

        // Keep the in-memory `dataset` snapshot in sync with the DB write so
        // later steps in this same invocation (publish_doi, etc.) don't read
        // a stale null. The EZID identifier itself is derived from
        // concept_doi wherever it is needed (conceptEzidIdentifier, #1182).
        dataset.concept_doi = doiResult.doi;
        dataset.is_sandbox = sandbox ? 1 : 0;
        dataset.ezid_status = doiResult.status;

        await updateProgress("doi_create", undefined, doiAttempts);
      } else {
        await updateProgress("doi_create");
      }
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("doi_create", msg);
      return c.json(
        {
          error: `DOI creation failed: ${msg}`,
          step: "doi_create",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

async function stepUpdateMetadata(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;
  const readDatasetDescription = c.helpers.readDatasetDescription;
  const getConceptDoi = c.helpers.getConceptDoi;

  // Step: update_metadata - Update dataset_description.json with DOI
  if (stepsToRun.includes("update_metadata")) {
    try {
      await startStep("update_metadata");

      // Get concept DOI (set by the doi_create step above)
      const doiResult = await getConceptDoi("update_metadata");
      if (isRespond(doiResult)) return doiResult;
      const conceptDoi = doiResult;

      const descResult = await readDatasetDescription("update_metadata");
      if (isRespond(descResult)) return descResult;
      const datasetDesc = descResult;

      // The rule lives in doi.ts so the #1386 repair applies the same edit.
      const applied = applyConceptDoiToDescription(datasetDesc, conceptDoi);
      if (applied.preservedSourceDoi) {
        console.log(
          `[publish] Preserved existing DatasetDOI "${applied.preservedSourceDoi}" in SourceDatasets for ${datasetId}`,
        );
      }

      await createOrUpdateFile(
        repoName,
        "dataset_description.json",
        JSON.stringify(applied.description, null, 2),
        `Update DatasetDOI with concept DOI: ${conceptDoi} [skip ci]`,
        pat,
        // Named, not defaulted: this write read main and used to land wherever
        // GitHub pointed the repository, which for sixteen of them is the
        // git-annex branch (#1386).
        "main",
      );

      await updateProgress("update_metadata");
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] update_metadata failed for dataset ${datasetId}:`, err);
      await updateProgress("update_metadata", msg);
      return c.json(
        {
          error: `Metadata update failed: ${msg}`,
          step: "update_metadata",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

async function stepUpdateReadme(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const dataset = c.dataset;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;
  const getConceptDoi = c.helpers.getConceptDoi;

  // Step: update_readme - Update README.md with DOI badge
  if (stepsToRun.includes("update_readme")) {
    try {
      await startStep("update_readme");

      const doiResult = await getConceptDoi("update_readme");
      if (isRespond(doiResult)) return doiResult;
      const conceptDoi = doiResult;
      const doiBadge = buildDoiBadge(conceptDoi);

      const tree = await getTreeAtRef(repoName, "main", pat);
      // Find all README variants in the repo
      const readmeCandidates = ["README.md", "README.rst", "README.txt", "README"];
      const foundReadmes: { path: string; sha: string }[] = [];
      for (const candidate of readmeCandidates) {
        const found = tree.find((f) => f.path === candidate);
        if (found) foundReadmes.push(found);
      }

      // Use the best available README for content (prefer README.md, then others in order)
      const contentSource = foundReadmes[0];
      let readmeContent = "";
      if (contentSource) {
        readmeContent = await getBlobContent(repoName, contentSource.sha, pat);
      } else {
        console.warn(`[publish] No README found in ${repoName}; creating README.md with DOI badge`);
      }

      // Decide whether the README needs a commit. Skips the no-op case
      // (current badge already present in README.md) so --resume runs do
      // not stack empty "Add DOI badge" commits that re-trigger CI.
      const plan = planReadmeBadgeCommit({
        readmeContent,
        doiBadge,
        conceptDoi,
        contentSourcePath: contentSource?.path,
      });

      if (!plan.commit) {
        console.log(`[publish] update_readme skipping commit for ${repoName}: ${plan.reason}`);
      } else {
        await createOrUpdateFile(repoName, "README.md", plan.content, plan.message, pat, "main");
      }

      // Delete any non-.md README files (handles both fresh rename and resume after partial run)
      for (const readme of foundReadmes) {
        if (readme.path === "README.md") continue;
        await deleteRepoFile(
          repoName,
          readme.path,
          readme.sha,
          `Remove old ${readme.path} (renamed to README.md)`,
          pat,
        );
        console.log(`[publish] Removed ${readme.path} from ${repoName} (using README.md)`);
        if (readme.path.endsWith(".rst")) {
          console.warn(
            `[publish] Warning: ${readme.path} was RST; content may not render correctly as Markdown`,
          );
        }
      }

      // Update GitHub repo description (name only) and homepage (DOI URL)
      const { setRepoDescription } = await import("./github.js");
      const descResult = await setRepoDescription(
        repoName,
        dataset.name,
        pat,
        conceptDoi ? `https://doi.org/${conceptDoi}` : undefined,
      );
      let descWarning: string | undefined;
      if (!descResult.ok) {
        descWarning = `Repo description not set: ${descResult.error}`;
        console.warn(`[publish] ${descWarning}`);
      }

      await updateProgress("update_readme", descWarning);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] update_readme failed for dataset ${datasetId}:`, err);
      await updateProgress("update_readme", msg);
      return c.json(
        {
          error: `README update failed: ${msg}`,
          step: "update_readme",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

async function stepCreateTag(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;
  const getVersionTag = c.helpers.getVersionTag;

  // Step: create_tag - Create git tag for version
  if (stepsToRun.includes("create_tag")) {
    try {
      await startStep("create_tag");

      const vtResult = await getVersionTag("create_tag");
      if (isRespond(vtResult)) return vtResult;
      const { tag, datasetDesc } = vtResult;

      const commitSha = await getMainBranchSha(repoName, "main", pat);

      const { attempts: createTagAttempts } = await withRetry(
        () =>
          createTag(
            repoName,
            tag,
            commitSha,
            `Release ${tag} - DOI: ${datasetDesc.DatasetDOI || "pending"}`,
            pat,
          ),
        "create_tag",
      );

      await updateProgress("create_tag", undefined, createTagAttempts);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] create_tag failed for dataset ${datasetId}:`, err);
      await updateProgress("create_tag", msg);
      return c.json(
        {
          error: `Tag creation failed: ${msg}`,
          step: "create_tag",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

async function stepCreateRelease(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const dataset = c.dataset;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;
  const getVersionTag = c.helpers.getVersionTag;

  // Step: create_release - Create GitHub release
  if (stepsToRun.includes("create_release")) {
    try {
      await startStep("create_release");

      const vtResult = await getVersionTag("create_release");
      if (isRespond(vtResult)) return vtResult;
      const { version, tag, datasetDesc } = vtResult;

      const nemarUrl = datasetLandingUrl(datasetId, resolveDatasetLandingBase(c.env));
      const archiveLine = `**Download:** [${tag}.zip](https://github.com/nemarDatasets/${repoName}/archive/refs/tags/${tag}.zip)`;
      const sections = [
        `# ${dataset.name} - Version ${version}`,
        `BIDS-formatted dataset published via [NEMAR](${nemarUrl}).`,
        archiveLine,
      ];
      if (datasetDesc.DatasetDOI) {
        sections.push(`**DOI:** https://doi.org/${datasetDesc.DatasetDOI}`);
      }
      const releaseBody = sections.join("\n\n");

      const { attempts: createReleaseAttempts } = await withRetry(
        () => createRelease(repoName, tag, tag, releaseBody, pat),
        "create_release",
      );

      await updateProgress("create_release", undefined, createReleaseAttempts);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] create_release failed for dataset ${datasetId}:`, err);
      await updateProgress("create_release", msg);
      return c.json(
        {
          error: `Release creation failed: ${msg}`,
          step: "create_release",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

async function stepUploadToZenodo(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const updateProgress = c.recorder.updateProgress;

  // Step: upload_to_zenodo - Disabled (EZID is now the DOI provider)
  // The step is kept in allSteps so existing DB records with upload_to_zenodo
  // in steps_completed remain valid.
  if (stepsToRun.includes("upload_to_zenodo")) {
    console.log("[publish] Zenodo upload skipped (disabled)");
    await updateProgress("upload_to_zenodo");
  }

  return undefined;
}

async function stepPublishDoi(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const db = c.db;
  const datasetId = c.datasetId;
  const dataset = c.dataset;
  const sandbox = c.body.sandbox;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;

  // Step: publish_doi - Publish DOI (permanent and irreversible!)
  // EZID is the sole provider (ADR 0007); the retired Zenodo publish branch
  // was removed in #1186 (its SQL named the dropped doi_provider column and
  // would have failed at runtime if ever re-enabled).
  if (stepsToRun.includes("publish_doi")) {
    // Same interlock as doi_create, for the same reason one step later:
    // `makePublic` is the transition that makes the record resolvable and
    // harvestable, so a still-blinded author list must not reach it either.
    const blocked = await blockedByUnrestoredAttribution(c, "publish_doi");
    if (blocked) return blocked;
    try {
      await startStep("publish_doi");

      // EZID: transition the reserved DOI to public status. The identifier
      // derives from concept_doi (#1182).
      if (!dataset.concept_doi) {
        await updateProgress("publish_doi", "No EZID identifier found");
        return c.json(
          {
            error: "No EZID identifier found for dataset",
            step: "publish_doi",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }

      const auth = resolveEzidAuth(c.env, sandbox || !!dataset.is_sandbox);
      const target = datasetLandingUrl(datasetId, resolveDatasetLandingBase(c.env));
      await ezidMakePublic(auth, conceptEzidIdentifier(dataset.concept_doi), target);

      // Update EZID status in D1
      try {
        await db
          .prepare(
            "UPDATE datasets SET ezid_status = 'public', updated_at = datetime('now') WHERE dataset_id = ?",
          )
          .bind(datasetId)
          .run();
      } catch (dbErr) {
        console.error(
          `[publish] CRITICAL: EZID DOI published but database update failed for ${datasetId}:`,
          dbErr,
        );
      }

      await updateProgress("publish_doi");
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] publish_doi failed for dataset ${datasetId}:`, err);
      await updateProgress("publish_doi", msg);
      return c.json(
        {
          error: `DOI publication failed: ${msg}`,
          step: "publish_doi",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  return undefined;
}

async function stepVersionDoi(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const db = c.db;
  const datasetId = c.datasetId;
  const repoName = c.repoName;
  const pat = c.pat;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const getVersionTag = c.helpers.getVersionTag;

  // Step: version_doi - Create version DOI record and manifest via webhook
  // This creates the version DOI record and manifest directly (same logic as
  // the publish-version-doi webhook). We can't self-fetch in Cloudflare Workers,
  // so we call the service functions directly. The central run-version-doi.yml
  // (Phase 2 of #601, on nemarDatasets/.github) serves as the
  // tag-push-triggered counterpart for PR/patch scenarios.
  if (stepsToRun.includes("version_doi")) {
    try {
      await startStep("version_doi");

      const vtResult = await getVersionTag("version_doi");
      if (isRespond(vtResult)) {
        // updateProgress was already called by readDatasetDescription inside getVersionTag
        // so we just mark completed to avoid double-recording and unnecessary retries
        await updateProgress("version_doi");
      } else {
        const { version } = vtResult;

        // Only stable semver versions get permanent DOIs (matches webhook guard)
        if (!/^\d+\.\d+\.\d+$/.test(version)) {
          console.info(
            `[publish] version_doi skipped for ${datasetId}: non-stable version "${version}"`,
          );
        }

        // Re-read dataset to get latest state (concept DOI may have been set in earlier steps)
        const freshDataset = !/^\d+\.\d+\.\d+$/.test(version)
          ? null
          : await db.prepare("SELECT * FROM datasets WHERE dataset_id = ?").bind(datasetId).first<{
              id: number;
              dataset_id: string;
              name: string;
              github_repo: string | null;
              concept_doi: string | null;
              // #1447: this step now RUNS for an anonymous release, because it
              // is also the only thing that dispatches the central manifest
              // job. The mint reads this field to leave the identifier
              // reserved instead of publishing it, so the row type has to say
              // it carries the column -- a `SELECT` that stopped returning it
              // must be a compile error, not a silent publish.
              anonymous: number | null;
            }>();

        if (!freshDataset) {
          // Non-stable version, or dataset disappeared during publish
          if (/^\d+\.\d+\.\d+$/.test(version)) {
            console.error(
              `[publish] version_doi: dataset ${datasetId} not found in D1 (deleted during publish?)`,
            );
          }
          await updateProgress("version_doi");
        } else if (!freshDataset.concept_doi) {
          // The EZID identifier derives from concept_doi (#1182), so "no
          // concept DOI" is also "no EZID identifier" -- one gate now.
          console.info(`[publish] version_doi skipped for ${datasetId}: no concept DOI`);
          await updateProgress("version_doi");
        } else {
          // Auto-detect sandbox from EZID test shoulder prefix (both paths).
          const isSandboxDoi = isSandboxIdentifier(conceptEzidIdentifier(freshDataset.concept_doi));

          if (isCentralManifestWorkflowEnabled(c.env)) {
            // Central flow (#751): cheap O(1) mint + dispatch. No inline
            // generateManifest (the file-count wall) and no inline
            // dataset_versions insert — /webhooks/manifest-ready owns the row
            // once the dispatched manifest job uploads to S3, the same single
            // owner as the tag-triggered webhook path.
            const minted = await publishEzidVersionDoiViaCentral(c.env, {
              dataset: freshDataset,
              repoName,
              version,
              sandbox: isSandboxDoi,
              pat,
              requestSource: "admin",
            });
            if (minted.warnings?.length) {
              for (const w of minted.warnings) {
                console.warn(`[publish:version_doi] ${w}`);
              }
            }
            console.log(`[publish] Version DOI dispatched for ${datasetId}: ${minted.doi}`);
            await updateProgress(
              "version_doi",
              minted.warnings?.length
                ? `DOI created (${minted.doi}) but: ${minted.warnings.join("; ")}`
                : undefined,
            );
          } else {
            // LEGACY inline path (centralFlow disabled, e.g. prod before the
            // #751 cutover). Reads the full repo tree and generates the manifest
            // inline; retained unchanged for the pre-cutover env.
            const repoMeta = await readRepoMetadata(
              repoName,
              pat,
              undefined,
              freshDataset.name,
              `v${version}`,
            );
            for (const w of repoMeta.warnings) {
              console.warn("[publish:version_doi]", w);
            }

            // Query existing version DOIs for concept DOI HasVersion relations
            const versionRows = await db
              .prepare("SELECT doi FROM dataset_versions WHERE dataset_id = ?")
              .bind(datasetId)
              .all<{ doi: string }>();
            const existingVersionDois = versionRows.results.map((r) => r.doi);

            const result = await createEzidVersionDoi(
              {
                EZID_USERNAME: c.env.EZID_USERNAME,
                EZID_PASSWORD: c.env.EZID_PASSWORD,
                EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
                EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
                // Landing-base resolution for the version DOI _target (epic #923).
                FRONTEND_URL: c.env.FRONTEND_URL,
                DATASET_LANDING_BASE_URL: c.env.DATASET_LANDING_BASE_URL,
              },
              {
                datasetId,
                conceptIdentifier: conceptEzidIdentifier(freshDataset.concept_doi),
                version,
                bidsDescription: repoMeta.bidsDescription,
                githubRepo: freshDataset.github_repo || `nemarDatasets/${repoName}`,
                sandbox: isSandboxDoi,
                existingVersionDois,
                enrichment: repoMeta.enrichment,
                // Same rule as the central path above (#1447): mint, do not
                // publish, for a concealed deposit.
                reserveOnly: isAnonymous(freshDataset),
              },
            );

            // Surface warnings from DOI creation (e.g., concept DOI HasVersion update failed)
            if (result.warnings?.length) {
              for (const w of result.warnings) {
                console.warn(`[publish:version_doi] ${w}`);
              }
            }

            // DOI is now public and permanent, unless this was an anonymous
            // release, where it is reserved and the row records the identifier
            // that the real publication will complete. DB and manifest
            // failures below are non-fatal but must be surfaced for operator
            // awareness.
            let dbError: string | undefined;
            try {
              // Not for a concealed deposit: `latest_version_doi` means "the
              // version DOI that is PUBLISHED", and this one is reserved. The
              // central path in `central-manifest.ts` carries the same rule
              // and the reasoning.
              if (!isAnonymous(freshDataset)) {
                await db
                  .prepare(
                    "UPDATE datasets SET latest_version_doi = ?, updated_at = datetime('now') WHERE id = ?",
                  )
                  .bind(result.doi, freshDataset.id)
                  .run();
              }

              await db
                .prepare(
                  "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, 'ezid')",
                )
                .bind(datasetId, version, result.doi)
                .run();
            } catch (err) {
              dbError = errorMessage(err);
              console.error(
                `[publish] DOI ${result.doi} is PUBLIC but DB update failed for ${datasetId}:`,
                err,
              );
            }

            // Generate and upload version manifest (proceeds regardless of DB failure)
            const manifest = await generateManifest(
              repoName,
              version,
              pat,
              datasetId,
              result.doi,
              freshDataset.concept_doi,
            );

            await uploadManifest(
              {
                bucket: c.env.S3_BUCKET,
                region: c.env.AWS_REGION,
                accessKeyId: c.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
              },
              datasetId,
              version,
              JSON.stringify(manifest, null, 2),
            );

            console.log(`[publish] Version DOI created for ${datasetId}: ${result.doi}`);
            const issues = [
              ...(dbError ? [`DB update failed: ${dbError}`] : []),
              ...(result.warnings || []),
            ];
            await updateProgress(
              "version_doi",
              issues.length ? `DOI created (${result.doi}) but: ${issues.join("; ")}` : undefined,
            );
          }
        }
      }
    } catch (err) {
      // Non-fatal: the CI workflow may still handle this as a fallback
      const msg = errorMessage(err);
      console.error(`[publish] version_doi failed for ${datasetId}: ${msg}`);
      await updateProgress("version_doi", msg);
    }
  }

  return undefined;
}

async function stepS3Lock(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const datasetId = c.datasetId;
  const body = c.body;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;
  const completed = c.recorder.completed;
  const stepResults = c.recorder.stepResults;

  // Step 14: S3 Object Lock — streamed via S3 ListObjectsV2 continuation
  // tokens. Each invocation issues exactly one LIST page (capped to
  // batchSize keys via max-keys) plus up to batchSize PutObjectRetention
  // calls — bounded subrequest cost regardless of dataset size. The CLI
  // re-invokes with the returned `s3_lock_continuation_token` until
  // `hasMore` is false. Idempotent: 403 = already-locked = counted as
  // success, so retries on the same token are safe.
  //
  // The previous offset-based approach paginated the entire dataset on
  // every call (full LIST + 40-PUT slice), which compounded across
  // batches and tripped Cloudflare's per-invocation subrequest cap on
  // the SCCN deployment for datasets with even a few hundred objects
  // (#385).
  if (stepsToRun.includes("s3_lock")) {
    try {
      await startStep("s3_lock");

      // Count total objects once at the start of the s3_lock stream so the
      // CLI can render a real progress bar instead of just a running count
      // (#284). The CLI threads `s3_lock_total` back via the request body
      // on every subsequent call so we don't re-count per page.
      //
      // Subrequest budget note: the counting sweep uses ceil(N/1000) LIST
      // subrequests; for a 6500-object dataset that is ~7 LISTs on top of
      // the 1 LIST + 100 PUTs from applyObjectLockBatch. The Workers Paid
      // cap is 1000 subrequests, so we cap the sweep at 20 LISTs (20 000
      // objects). If the dataset is larger the count is skipped and the CLI
      // falls back to a running count without a denominator — better than
      // risking a "Too many subrequests" failure on the first invocation.
      const MAX_COUNT_LISTS = 20;
      let s3LockTotal = body.s3_lock_total;
      if (s3LockTotal === undefined && body.s3_lock_continuation_token === undefined) {
        const stats = await getDatasetS3Stats(getS3Config(c.env), datasetId, MAX_COUNT_LISTS);
        // stats.objectCount is undefined when the cap was hit; leave
        // s3LockTotal as undefined so the CLI shows "N locked" without a
        // denominator rather than an incorrect percentage.
        if (stats.objectCount !== undefined) {
          s3LockTotal = stats.objectCount;
        }
      }

      const lockResult = await applyObjectLockBatch(
        getS3Config(c.env),
        datasetId,
        body.s3_lock_continuation_token,
      );

      if (lockResult.failed.length > 0) {
        const msg = `${lockResult.locked} locked, ${lockResult.failed.length} failed`;
        await updateProgress("s3_lock", msg);
        return c.json(
          {
            error: `S3 lock partially failed: ${msg}`,
            step: "s3_lock",
            steps_completed: completed,
            step_results: stepResults,
            details: lockResult,
            // Echo the same token the caller sent so the CLI's retry
            // replays this exact batch (idempotent: 403=already-locked).
            // Without this echo, the CLI would lose its place and
            // re-stream from page 1 on retry.
            s3_lock_continuation_token: body.s3_lock_continuation_token,
            s3_lock_total: s3LockTotal,
            s3_lock_batch_count: lockResult.locked,
          },
          500,
        );
      }

      if (lockResult.hasMore) {
        // More pages to lock — return next continuation token for the
        // CLI to thread into its next invocation.
        return c.json({
          message: `S3 lock in progress: ${lockResult.locked} locked in this batch`,
          step: "s3_lock",
          steps_completed: completed,
          step_results: stepResults,
          s3_lock_continuation_token: lockResult.nextContinuationToken,
          s3_lock_total: s3LockTotal,
          s3_lock_batch_count: lockResult.locked,
          hasMore: true,
        });
      }

      // Capture values for the final success response so the CLI's running
      // counter reaches the true total (not short by the last batch).
      c.s3LockFinalTotal = s3LockTotal;
      c.s3LockFinalBatchCount = lockResult.locked;
      await updateProgress("s3_lock");
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("s3_lock", msg);
      return c.json(
        {
          error: `S3 lock failed: ${msg}`,
          step: "s3_lock",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // NOTE (#670): the archive is generated by the central run-version-doi.yml
  // workflow, which always dispatches `generate-archive` after minting the
  // version DOI. The `create_tag` step above pushes the `v*` tag, which fires
  // the GitHub App push webhook -> triggerVersionDoiRun -> run-version-doi.yml
  // -> generate-archive. A separate orchestrator-side `generate_archive` step
  // used to ALSO dispatch here, producing two redundant Generate Archive runs
  // per publish; it was removed (run-generate-archive.yml also gained an
  // S3 skip-if-exists guard as defense-in-depth).

  return undefined;
}

async function stepSyncNemar(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const updateProgress = c.recorder.updateProgress;

  // Step 15: nemar.org datapipeline sync — disabled (epic #837 retired the legacy
  // dataexplorer coupling). Kept in allSteps + stepsToRun so existing
  // publication_requests step records stay valid; the step is now a logged no-op
  // (mirrors the disabled upload_to_zenodo step above).
  if (stepsToRun.includes("sync_nemar")) {
    console.log("[publish] nemar.org sync skipped (legacy datapipeline sync disabled)");
    await updateProgress("sync_nemar");
  }

  return undefined;
}

async function stepNotifyUser(c: ApproveStepContext): Promise<RespondOutcome | undefined> {
  const stepsToRun = c.stepsToRun;
  const db = c.db;
  const datasetId = c.datasetId;
  const dataset = c.dataset;
  const startStep = c.recorder.startStep;
  const updateProgress = c.recorder.updateProgress;

  // Step 16: Notify user (non-fatal — mirrors sync_nemar pattern)
  if (stepsToRun.includes("notify_user")) {
    try {
      await startStep("notify_user");

      // Re-read DOI in case it was just created
      const updatedDataset = await db
        .prepare("SELECT concept_doi FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ concept_doi: string | null }>();

      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendPublicationApprovedEmail(
        dataset.owner_email,
        dataset.owner_username,
        datasetId,
        updatedDataset?.concept_doi || null,
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        c.env,
        // #1408: the mail's whole vocabulary changes. For an anonymous release
        // the DOI is reserved and does not resolve, so it must not be offered
        // as "your DOI" -- the recipient is mid-submission and would cite it.
        { anonymous: c.anonymousRelease },
      );

      await updateProgress("notify_user");
    } catch (err) {
      const msg = errorMessage(err);
      // Non-fatal: email failure must not block publication after DOI is minted
      console.error(`[publish] notify_user failed for ${datasetId} (non-fatal): ${msg}`);
      c.notifyUserWarning = `Notification email failed: ${msg}`;
      try {
        await auditLogStatement(db, {
          userId: c.approver.id,
          action: "notify_user_failed",
          resourceType: "dataset",
          resourceId: datasetId,
          details: JSON.stringify({ error: msg, owner_email: dataset.owner_email }),
        }).run();
      } catch (auditErr) {
        console.warn(`[publish] Failed to write notify_user failure to audit log: ${auditErr}`);
      }
      await updateProgress("notify_user", msg);
    }
  }

  return undefined;
}

type StepFn = (c: ApproveStepContext) => Promise<RespondOutcome | undefined>;

/**
 * Step implementations keyed by step name. Execution order is driven by
 * PUBLICATION_STEPS (the runner iterates it directly), so the shared list is
 * the single source of both documented and actual order; Record<PublicationStep,
 * StepFn> makes a missing or extra key a compile error.
 */
const STEP_FUNCTIONS: Record<PublicationStep, StepFn> = {
  ci_check: stepCiCheck,
  enrichment_check: stepEnrichmentCheck,
  s3_public_read: stepS3PublicRead,
  repo_public: stepRepoPublic,
  tag_protect: stepTagProtect,
  doi_create: stepDoiCreate,
  update_metadata: stepUpdateMetadata,
  update_readme: stepUpdateReadme,
  create_tag: stepCreateTag,
  create_release: stepCreateRelease,
  upload_to_zenodo: stepUploadToZenodo,
  publish_doi: stepPublishDoi,
  version_doi: stepVersionDoi,
  s3_lock: stepS3Lock,
  sync_nemar: stepSyncNemar,
  notify_user: stepNotifyUser,
};

export interface ApproveRunArgs {
  db: D1Database;
  env: Bindings;
  waitUntil: (p: Promise<unknown>) => void;
  datasetId: string;
  adminUser: AuthUser;
  body: ApproveBody;
}

/**
 * The publication-approval run: pre-loop gates, the 16-step loop, and the
 * finalize block, moved verbatim from the route handler. Returns the exact
 * JSON body + status the route should emit.
 */
/**
 * Was this dataset EVER released under the blind?
 *
 * The durable answer, and the only one available at the end of a run.
 * `datasets.anonymous` and `first_published_at` are both rewritten by
 * `repo_public` in this same invocation (migration 0085's triggers force the two
 * into one statement), so by the time the tail jobs below run, the row itself no
 * longer says the deposit was ever concealed. `publication_requests` keeps every
 * request, so the request that asked for the blind is still there.
 *
 * Shared by both de-anonymization tail jobs and by `repo_public`'s restoration
 * decision, through the one statement in `services/anonymity.ts`, deliberately:
 * all three have to agree about which datasets have a concealed era at all.
 * {@link PRIOR_ANONYMOUS_REQUEST_SQL} says why no `status` predicate can narrow
 * it -- `denied` can follow `approving`, and `blocked` means either -- and why
 * over-answering here is the cheap direction. What bounds the work is the
 * `created_at` filter in {@link completeConcealedEraVersionDois}, not this.
 *
 * Reads nothing on failure: a D1 error here is reported by the caller that
 * matters. Swallowing it would be wrong at `repo_public`, where a false negative
 * skips a restoration, which is why that site asks the question directly and
 * lets the step fail.
 */
async function hadAnonymousRequest(db: D1Database, datasetId: string): Promise<boolean> {
  const priorAnonymous = await db
    .prepare(PRIOR_ANONYMOUS_REQUEST_SQL)
    .bind(datasetId)
    .first<{ found: number }>()
    .catch(() => null);
  return priorAnonymous?.found === 1;
}

/**
 * Request one dataset's Zarr stores be rebuilt after de-anonymization.
 *
 * Returns a warning string when the request could not be recorded, rather than
 * swallowing it. There is no safety net behind this write: the anonymity sweep
 * selects `anonymous = 1`, and by this point the row is `anonymous = 0`, so a
 * dataset that misses its stamp has left the only pool that would have
 * re-checked it. Silence here is a public dataset serving a blinded citation
 * forever, with one line in a Worker log to show for it.
 *
 * Not fatal: the dataset IS correctly published, and what is stale is a derived
 * serving copy (ADR 0005). So it is reported to the approving admin and written
 * to `audit_log`, not raised.
 */
export async function stampZarrRequeue(
  db: D1Database,
  datasetId: string,
  anonymousRelease: boolean,
): Promise<string | undefined> {
  // An anonymous RELEASE is the blinded state arriving, not leaving: its stores
  // should carry the blinded label, so it asks for nothing.
  if (anonymousRelease) return undefined;
  if (!(await hadAnonymousRequest(db, datasetId))) return undefined;

  try {
    await db
      .prepare(
        `UPDATE datasets
           SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '${ZARR_REQUEUE_AT_PATH}', datetime('now'))
         WHERE dataset_id = ?`,
      )
      .bind(datasetId)
      .run();
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[publish] ${datasetId}: could not request a Zarr rebuild after de-anonymizing:`,
      message,
    );
    try {
      await auditLogStatement(db, {
        userId: null,
        action: "zarr_requeue_request_failed",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ error: message }),
      }).run();
    } catch {
      // The warning below is then the only record, which is why it is returned
      // to the caller rather than logged.
    }
    return `${datasetId} was de-anonymized but its Zarr rebuild could not be requested: ${message}. Approve the request again to retry the stamp -- a run whose steps are all complete still re-requests it. Its viewer keeps the blinded citation until then, and nothing else re-checks a de-anonymized row.`;
  }
}

/**
 * Version identifiers this completes in one run, beyond which it reports rather
 * than keeps going. A concealed deposit accumulates one per anonymous release,
 * so a handful is the realistic ceiling; the cap is here so a corrupt or
 * unexpectedly long history cannot turn the tail of a publication into an
 * unbounded series of EZID writes.
 */
export const MAX_CONCEALED_ERA_VERSION_DOIS = 10;

/**
 * Publish the version identifiers a concealed release left `reserved`.
 *
 * `version_doi` mints the version the depositor is publishing NOW. An anonymous
 * release minted one too, reserved (#1447), and review is exactly the process
 * that produces a revision -- so the ordinary case is that the depositor
 * publishes `1.0.1` after having released `1.0.0` under the blind. Nothing then
 * revisits `1.0.0`: `version_doi` never names it, and `doi-reconcile.ts` only
 * ever looks at `latest_version_doi`. Its identifier stays reserved forever
 * while its `dataset_versions` row stops being withheld the moment
 * `anonymous` clears, so the landing page renders a live `https://doi.org/...`
 * anchor for an identifier that does not resolve, on a published dataset.
 *
 * Concealed-era means created no later than `first_published_at`, and the query
 * says so rather than taking every row the dataset has. Anonymity is only
 * available before first publication (ADR 0065) and migration 0085's triggers
 * enforce it, so a version recorded after that stamp cannot have been minted
 * under a blind. Reading every row instead looks equivalent on the first real
 * publication, when the stamp is minutes old and there is nothing else, and is
 * wrong on the ones after it: a formerly-anonymous dataset that goes on to
 * accumulate ordinary revisions would re-attempt them forever and, past the cap,
 * report that identifiers "may still be reserved" when the only rows not
 * attempted were ordinary public ones.
 *
 * `createEzidVersionDoi` per version rather than a bespoke flip: the
 * reserved-to-public transition, the rebuilt DataCite document that keeps the
 * blinded creator out of the permanent record, the refusal to advance a
 * tombstoned identifier, and the concept record's `HasVersion` refresh are all
 * already there and already tested. An identifier that is already public costs
 * one call and changes nothing (`return_public`), so this is idempotent, and a
 * row whose identifier EZID no longer holds is minted back rather than skipped.
 *
 * Non-fatal, and reported the way {@link stampZarrRequeue} is: the dataset IS
 * published and correctly attributed, and what is wrong is a secondary
 * identifier. Raising here would fail a run that had already succeeded.
 */
export async function completeConcealedEraVersionDois(
  env: Bindings,
  db: D1Database,
  datasetId: string,
  anonymousRelease: boolean,
): Promise<string | undefined> {
  // The blind arriving, not leaving: these identifiers are meant to be reserved.
  if (anonymousRelease) return undefined;
  if (!(await hadAnonymousRequest(db, datasetId))) return undefined;

  // Accumulates every problem the run hits, so one report carries all of them.
  // Each `return` below goes through the shared writer with this list, never a
  // fresh one: a run that both truncated and then failed has to say both.
  const warnings: string[] = [];

  let dataset: { name: string; github_repo: string | null; concept_doi: string | null } | null;
  let rows: { version: string; doi: string }[];
  try {
    dataset = await db
      .prepare("SELECT name, github_repo, concept_doi FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ name: string; github_repo: string | null; concept_doi: string | null }>();
    // `repo_public` stamped `first_published_at` earlier in THIS run, so the
    // comparison is against this publication for a dataset publishing for the
    // first time and against the earlier one for every publication after it.
    // A NULL stamp cannot happen here (this runs after that step) and is treated
    // as "everything qualifies" rather than "nothing does", so a missing stamp
    // reports too much instead of silently leaving an identifier dead.
    const res = await db
      .prepare(
        `SELECT v.version, v.doi
           FROM dataset_versions v
           JOIN datasets d ON d.dataset_id = v.dataset_id
          WHERE v.dataset_id = ?
            AND (d.first_published_at IS NULL OR v.created_at <= d.first_published_at)
          ORDER BY v.created_at ASC
          LIMIT ?`,
      )
      .bind(datasetId, MAX_CONCEALED_ERA_VERSION_DOIS + 1)
      .all<{ version: string; doi: string }>();
    rows = res.results ?? [];
  } catch (err) {
    warnings.push(`could not read the recorded versions: ${errorMessage(err)}`);
    return concealedEraVersionWarning(db, datasetId, warnings);
  }
  if (rows.length === 0) return undefined;

  if (rows.length > MAX_CONCEALED_ERA_VERSION_DOIS) {
    rows = rows.slice(0, MAX_CONCEALED_ERA_VERSION_DOIS);
    warnings.push(
      `more than ${MAX_CONCEALED_ERA_VERSION_DOIS} versions recorded before first publication; only the oldest ${MAX_CONCEALED_ERA_VERSION_DOIS} were attempted`,
    );
  }

  if (!dataset?.concept_doi) {
    // Without the concept identifier there is no `IsVersionOf` to write, so the
    // record cannot be rebuilt correctly. Reported rather than guessed at.
    warnings.push(
      `${rows.length} recorded version(s) may still be reserved, but the dataset has no concept DOI to relate them to`,
    );
    return concealedEraVersionWarning(db, datasetId, warnings);
  }
  const conceptIdentifier = conceptEzidIdentifier(dataset.concept_doi);
  const sandbox = isSandboxIdentifier(conceptIdentifier);
  const repoName = dataset.github_repo?.split("/")[1];
  if (!repoName) {
    warnings.push(
      `${rows.length} recorded version(s) may still be reserved, but the dataset has no GitHub repository to rebuild their metadata from`,
    );
    return concealedEraVersionWarning(db, datasetId, warnings);
  }

  let repoMeta: Awaited<ReturnType<typeof readRepoMetadata>>;
  try {
    const pat = await getDatasetsToken(env);
    // `main`, not the version's own tag: the authors are what has to be right,
    // and the restored ones are on main. A tag read would reproduce the
    // description as it stood during review, which is where the blinded label
    // came from in the first place.
    repoMeta = await readRepoMetadata(repoName, pat, undefined, dataset.name, "main", {
      useContentsApi: true,
    });
  } catch (err) {
    warnings.push(
      `could not read the repository metadata to rebuild ${rows.length} version record(s): ${errorMessage(err)}`,
    );
    return concealedEraVersionWarning(db, datasetId, warnings);
  }

  // `readRepoMetadata` reports a failed read instead of raising, and its
  // fallback description is `{ Name }` alone -- which DataCite renders with a
  // `(:unav)` creator. Publishing an identifier with that record is worse than
  // leaving it reserved: reserved is recoverable by approving again, whereas a
  // public version DOI attributed to nobody is exactly the outcome ADR 0065
  // exists to prevent, and it would look deliberate on a dataset that was
  // anonymous by choice. So an unreadable repository stops the run.
  const unreadable = repoMeta.warnings.filter((w) => w.startsWith(BIDS_METADATA_UNAVAILABLE));
  if (unreadable.length > 0) {
    warnings.push(
      `${rows.length} recorded version(s) may still be reserved; their attribution could not be rebuilt: ${unreadable.join("; ")}`,
    );
    return concealedEraVersionWarning(db, datasetId, warnings);
  }
  // Read the rebuilt record, not the step order, for whether attribution has
  // actually been restored. What this function does is make identifiers PUBLIC,
  // and a DataCite record whose creator is the blinded label is harvested within
  // hours and inverts ADR 0041 on the one thing nothing can retract -- the same
  // reason `doi_create` and `publish_doi` carry the interlock at
  // `refuseWhileBlinded`. That interlock reads `datasets.authors`, which
  // `repo_public` has already rewritten by the time this runs, so it cannot
  // answer here; the repository can, because the restoring commit is what put
  // the real names on `main`. If they are not there, the reservation is left
  // alone: still reserved is recoverable, still blinded and public is not.
  const stillBlinded = (
    Array.isArray(repoMeta.bidsDescription.Authors) ? repoMeta.bidsDescription.Authors : []
  ).some((a) => typeof a === "string" && a.trim() === ANONYMOUS_AUTHORS_LABEL);
  if (stillBlinded) {
    warnings.push(
      `${rows.length} recorded version(s) may still be reserved; the repository still carries the anonymous-deposit author label, so making them public would publish a blinded record`,
    );
    return concealedEraVersionWarning(db, datasetId, warnings);
  }
  for (const w of repoMeta.warnings) {
    console.warn(`[publish:concealed-era-version-doi] ${datasetId}: ${w}`);
  }

  const allDois = rows.map((r) => r.doi);
  const ensured: string[] = [];
  for (const row of rows) {
    try {
      const result = await createEzidVersionDoi(env, {
        datasetId,
        conceptIdentifier,
        version: row.version,
        bidsDescription: repoMeta.bidsDescription,
        githubRepo: dataset.github_repo || `nemarDatasets/${repoName}`,
        sandbox,
        existingVersionDois: allDois,
        enrichment: repoMeta.enrichment,
        // Deliberately no `reserveOnly`: this function exists to END the
        // reservation the anonymous release made.
      });
      ensured.push(result.doi);
      for (const w of result.warnings ?? []) {
        warnings.push(`${row.version}: ${w}`);
      }
    } catch (err) {
      warnings.push(`${row.version} (${row.doi}) is still reserved: ${errorMessage(err)}`);
    }
  }
  console.log(
    `[publish] ${datasetId}: concealed-era version identifiers ensured public: ${ensured.join(", ") || "none"}`,
  );
  if (warnings.length === 0) return undefined;
  return concealedEraVersionWarning(db, datasetId, warnings);
}

/**
 * One place that both records and phrases a failed completion, so the audit row
 * and the admin's copy cannot say different things. Every early return above
 * goes through it.
 */
async function concealedEraVersionWarning(
  db: D1Database,
  datasetId: string,
  problems: string[],
): Promise<string> {
  const joined = problems.join("; ");
  console.error(`[publish] ${datasetId}: concealed-era version DOIs not completed: ${joined}`);
  try {
    await auditLogStatement(db, {
      userId: null,
      action: "concealed_era_version_doi_incomplete",
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify({ problems }),
    }).run();
  } catch {
    // The returned warning is then the only record, which is why it is returned
    // to the caller rather than logged.
  }
  return `${datasetId} was de-anonymized but a version identifier minted during the blind may still be RESERVED: ${joined}. A reserved DOI does not resolve, and the dataset page now links it. Approve the request again to retry -- a run whose steps are all complete still retries this.`;
}

export async function runPublicationApproval(args: ApproveRunArgs): Promise<RespondOutcome> {
  const { db, env, waitUntil, datasetId, adminUser, body } = args;
  const { resume } = body;

  const c = {
    env,
    db,
    executionCtx: { waitUntil },
    json: makeRespond,
    datasetId,
    adminUser,
    body,
    s3LockFinalTotal: undefined,
    s3LockFinalBatchCount: undefined,
    notifyUserWarning: undefined,
  } as ApproveStepContext;

  // Refuse pre-#385 CLIs that still drive s3_lock by offset. See the
  // approveSchema comment for the silent-partial-lock failure mode this
  // prevents.
  if (body.s3_lock_offset !== undefined && body.s3_lock_continuation_token === undefined) {
    console.warn(
      `[publish] rejecting pre-0.8.5 CLI for ${datasetId}: s3_lock_offset is no longer supported`,
    );
    return c.json(
      {
        error: "Outdated nemar-cli; please upgrade to >=0.8.5 for S3 lock streaming",
        message:
          "This server uses S3 ListObjectsV2 continuation tokens for s3_lock. Upgrade with `bun add -g @nemarOrg/nemar-cli@latest` and re-run.",
      },
      // 426 Upgrade Required signals a strictly-non-retryable client problem
      // so the CLI's transient-error retry classifier won't mask it.
      426,
    );
  }

  // Find the publication request
  // The newest active request, by the same rule the dispatch route claims with
  // (ACTIVE_REQUEST_TAIL_SQL): the two must agree on the row, or the clicking
  // admin would be recorded on a request this run never touches.
  //
  // `approval_lease_live` is read HERE, with the row, because the request-start
  // UPDATE below bumps `updated_at`: asked afterwards, every call would find a
  // fresh heartbeat and a stale click would always look live.
  const request = await db
    .prepare(
      `SELECT id, status, block_reason, steps_completed, anonymous, approval_requested_by,
              ${approvalLeaseLiveSql()} AS approval_lease_live ${ACTIVE_REQUEST_TAIL_SQL}`,
    )
    .bind(datasetId)
    .first<{
      id: number;
      status: string;
      block_reason: string | null;
      steps_completed: string;
      anonymous: number | null;
      approval_requested_by: number | null;
      approval_lease_live: number;
    }>();

  if (!request) {
    return c.json({ error: "No active publication request found" }, 404);
  }

  // A blocked request is refused by the mechanical rules (ADR 0102): whatever the flag says, and
  // for every dataset, before anything else decides anything, as `approve-dispatch` refuses it
  // before its screen gate. It holds for a resume too, and the depositor fixes what blocked it
  // and requests again.
  //
  // One exception: a run that HAS started publishing and was walked back to `blocked` for the
  // owner's name (`publishingStanding`: that reason, and a step done outside the validation-only
  // ones). The owner-name check below walks the request back on every call of a run, a resume and
  // the batches of `s3_lock` included, so a depositor who clears their name mid-run blocks a run
  // that is half published. The owner fixes the name and the run is resumed, as it was before the
  // review existed; refusing it for good would strand a half-published dataset until a
  // re-request. A request blocked for any other reason is refused however stale its steps: the
  // standing reads the reason, so the steps of an earlier life cannot skip the gates.
  const standing = publishingStanding(request);
  if (request.status === "blocked" && standing !== "publishing") {
    return c.json(requestBlockedRefusal(datasetId, request.block_reason), 409);
  }

  // Attribution forks (ADR 0080): a web click records the admin who clicked,
  // a terminal approval records its own caller. `adminUser` stays the executor.
  c.approver = await resolveApprover(
    db,
    request.approval_requested_by,
    request.approval_lease_live === 1,
    { id: adminUser.id, username: adminUser.username },
  );

  // An override is the act of the administrator who sends it, and is recorded under the approver
  // of record (ADR 0102, section 9). Inside a live web lease the approver is the administrator who
  // clicked (ADR 0080), so another administrator's override would be recorded under the clicker's
  // name, with the sender only as the executor. Refused until a dispatch token makes the
  // attribution exact (#1604, Phase 3); this also means the executor's service account never
  // records one (it sends none, and its run rides on the clicker's recorded override).
  if (body.override_publication_review !== undefined && c.approver.id !== adminUser.id) {
    console.warn(
      `[publish] ${datasetId}: override refused, a web approval of request ${request.id} is in progress`,
    );
    return c.json(
      {
        error: "override_inside_web_approval",
        message: OVERRIDE_INSIDE_WEB_APPROVAL_MESSAGE,
      },
      409,
    );
  }

  const stepsCompleted: PublicationStep[] = resume
    ? JSON.parse(request.steps_completed || "[]")
    : [];
  // #1408: an anonymous release is the ordinary publication minus the steps
  // whose whole effect is to expose identity. The set is declared next to
  // PUBLICATION_STEPS itself so the two cannot drift, and the reason each step
  // is skipped is recorded there.
  const anonymousRelease = request.anonymous === 1;
  const allSteps: readonly PublicationStep[] = anonymousRelease
    ? ANONYMOUS_RELEASE_STEPS
    : PUBLICATION_STEPS;
  const stepsToRun = allSteps.filter((s) => !stepsCompleted.includes(s));

  if (stepsToRun.length === 0) {
    // Re-request the Zarr rebuild on this path too, so the warning
    // `stampZarrRequeue` returns is actionable. Its one other caller is at the
    // END of the step loop, and a run that reaches here never gets there -- so
    // an admin told "its viewer keeps the blinded citation until this is
    // re-run" had no way to re-run it, and no other code path re-checks a
    // de-anonymized row (the sweep selects `anonymous = 1`).
    const retryWarning = await stampZarrRequeue(db, datasetId, anonymousRelease);
    // And the other tail job, for the same reason: its warning tells the admin
    // to approve again, so approving again has to be what retries it.
    const retryVersionWarning = await completeConcealedEraVersionDois(
      env,
      db,
      datasetId,
      anonymousRelease,
    );
    const retryWarnings = [retryWarning, retryVersionWarning].filter(Boolean);
    // Neurobagel federation (epic #1586 phase 4, ADR 0084): a run whose steps are all
    // complete is still a publication that may not have been federated yet. A hook,
    // never a step: it does nothing unless the writer is enabled, runs in `waitUntil`,
    // and cannot fail or delay this response.
    scheduleNeurobagelSync(env, waitUntil, datasetId, "hook:publication");
    return c.json({
      message: "All steps already completed",
      dataset_id: datasetId,
      status: "published",
      ...(retryWarnings.length > 0 ? { warnings: retryWarnings } : {}),
    });
  }

  // The identifier screen gate (epic #1610 phase 4, ADR 0086), before anything
  // is marked: a request whose screen is not clear for its CURRENT content
  // never starts approving. It is skipped only for a resume of a run that has
  // already started publishing (`publishingStanding`: a step after the
  // validation-only ones completed). From then on the run must be able to
  // finish, and its own steps commit to main, so a head check would strand it
  // halfway. Before that point nothing is public, and the depositor may have
  // pushed since the earlier attempt stopped (a failed ci_check leaves the row
  // `approving`), so a resume, or the import pipeline's resume-flagged retry of
  // a request that never started, is gated like a fresh run. Sandbox (`xx`)
  // datasets are exempt inside the check. A run the owner-name walk-back blocked
  // half way is a run that started: it is continued, not gated.
  const startedPublishing = resume && standing === "publishing";
  if (!startedPublishing) {
    const gate = await checkApprovalScreenGate(env, {
      requestId: request.id,
      datasetId,
      adminUserId: c.approver.id,
      acknowledgment: body.acknowledge_identifier_screen,
    });
    if (!gate.ok) {
      console.warn(
        `[publish] ${datasetId}: approval refused by the identifier screen (${gate.refusal.gate})`,
      );
      return c.json(gate.refusal, 409);
    }

    // The publication review's gate (ADR 0102), after the screen's and before anything is
    // marked: a review that is not a pass needs the approver's recorded override, and a hard
    // reason is refused whatever the body says. Skipped (with the screen's) only for a run that has
    // started publishing. Off and not-applicable datasets pass without a read of the review. The
    // screen's acknowledgment was recorded when the screen gate passed, on its own; only the
    // override below is recorded last, once both gates have passed.
    const review = await evaluateApprovalReviewGate(env, {
      requestId: request.id,
      datasetId,
      approverId: c.approver.id,
      override: body.override_publication_review,
    });
    if (!review.ok) {
      console.warn(
        `[publish] ${datasetId}: approval refused by the publication review (${review.body.refusal})`,
      );
      return c.json(review.body, 409);
    }
    if (review.state === "enforced" && review.record !== null) {
      const recorded = await recordApprovalOverride(env, {
        requestId: request.id,
        datasetId,
        approverId: c.approver.id,
        via: "approve",
        outcome: review.outcome,
        headSha: review.headSha,
        record: review.record,
      });
      if (!recorded.ok) {
        console.warn(
          `[publish] ${datasetId}: approval refused by the publication review (${recorded.body.refusal})`,
        );
        return c.json(recorded.body, 409);
      }
    }
  }

  // Mark as approving. Only a request that is still one an approval can act on (`requested`, or
  // `approving` for a resume): the gates above read it a moment ago, and a result that re-blocked
  // it since (a failed submission minimum, ADR 0102) or a denial would be overwritten by an
  // unconditional write, and the run would publish over it. Nothing has run yet, so a request
  // that changed is refused and read again. A request that was `blocked` when it was read got
  // here only because the owner-name walk-back blocked a run that has started publishing (above),
  // and is marked `approving` again. Two terms let a `blocked` row through: the last bound value
  // (1 only for such a request), so a request that was not blocked when it was read cannot be
  // marked once it has become one, and the owner-name reason itself, so a row a re-request moved
  // to another reason since is refused as well.
  const readAsBlocked = request.status === "blocked" ? 1 : 0;
  const marked = await db
    .prepare(
      // `last_error = NULL`: a new attempt begins, so the previous attempt's
      // error is history (the caller's own output has it), and the row reads as
      // running, not failed, from this moment (services/approval-dispatch.ts).
      `UPDATE publication_requests SET status = 'approving', approved_by = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ? AND (status IN ('requested', 'approving') OR (status = 'blocked' AND block_reason = '${OWNER_NAME_MISSING_REASON}' AND ? = 1))`,
    )
    .bind(c.approver.id, request.id, readAsBlocked)
    .run();
  if ((marked.meta.changes ?? 0) !== 1) {
    console.warn(
      `[publish] ${datasetId}: approval refused, request ${request.id} changed while it was being checked`,
    );
    return c.json(
      {
        error: "request_changed",
        message: REQUEST_CHANGED_MESSAGE,
      },
      409,
    );
  }

  // Get dataset info
  const dataset = await db
    .prepare(
      `SELECT d.*, u.username as owner_username, u.email as owner_email, u.orcid as owner_orcid,
            u.given_name as owner_given_name, u.family_name as owner_family_name
     FROM datasets d
     JOIN users u ON d.owner_user_id = u.id
     WHERE d.dataset_id = ?`,
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      description: string | null;
      github_repo: string | null;
      concept_doi: string | null;
      zenodo_concept_id: string | null;
      ezid_status: string | null;
      is_sandbox: number | null;
      is_exemplar: number | null;
      source: string | null;
      owner_username: string;
      owner_email: string;
      owner_orcid: string | null;
      owner_given_name: string | null;
      owner_family_name: string | null;
      anonymous: number | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Block publication of sandbox datasets, except staging exemplars (epic #923).
  if (dataset.dataset_id.startsWith("xx") && !isExemplarPublishAllowed(c.env, dataset)) {
    return c.json(
      {
        error: "Cannot publish sandbox datasets",
        message: "Sandbox datasets (xx-prefix) are for testing only and cannot be published.",
        dataset_id: datasetId,
      },
      400,
    );
  }

  // Real-name precondition (#1255). Publishing mints a concept DOI, and a DOI
  // is permanent: once EZID has the record, an unattributed or wrongly
  // attributed curator cannot be recalled, only updated. So the check happens
  // here, before the first step runs, rather than at doi_create in the middle
  // of a 16-step run that has already flipped visibility.
  //
  // The request row is walked back to 'blocked' with the reason: this
  // function set it to 'approving' a few lines up, and a row left there is
  // unreachable for the user (POST /publish/request 409s on a non-blocked
  // active request), so the owner could not re-request after fixing their
  // name. Every other early return here fails on something only an admin can
  // fix; this one fails on something the OWNER fixes and then retries.
  if (requiresUploaderName(dataset) && !resolveOwnerIdentity(dataset)) {
    // The walk-back is best-effort and MUST NOT replace the 422 with a 500:
    // an unguarded throw here would strand the row at 'approving', which is
    // precisely the unreachable state this code exists to prevent. If it
    // fails, the operator still gets the reason and the marker below tells
    // them the row needs unsticking by hand.
    //
    // A web run's claim (`approval_requested_by`, `approval_dispatched_at`,
    // ADR 0080) is cleared with it: this run is over, and a claim left on the
    // blocked row would read as live for the rest of the lease once the owner
    // re-requests and the row is `requested` again, showing "running" with
    // nothing running and attributing a terminal approval to the stale clicker.
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET status = 'blocked', block_reason = ?, approval_requested_by = NULL, approval_dispatched_at = NULL, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(OWNER_NAME_MISSING_REASON, request.id)
        .run();
    } catch (walkBackErr) {
      console.error(
        `[publish] BLOCK WALKBACK FAILED for ${datasetId} (request ${request.id}): the row is still 'approving' and the owner cannot re-request until it is set to 'blocked':`,
        walkBackErr,
      );
    }
    return c.json(
      {
        status: "blocked",
        block_reason: OWNER_NAME_MISSING_REASON,
        message: OWNER_NAME_MISSING_MESSAGE,
        dataset_id: datasetId,
      },
      422,
    );
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const pat = await getDatasetsToken(c.env);
  const requestId = request.id;

  // Progress recorder: single writer of steps_completed/current_step/
  // last_error for this run (#904). `completed`/`stepResults` are the
  // recorder's own in-place-mutated arrays.
  const recorder = createProgressRecorder(db, requestId, datasetId, stepsCompleted);
  const { stepResults } = recorder;

  c.requestId = requestId;
  c.repoName = repoName;
  c.pat = pat;
  c.dataset = dataset;
  c.stepsToRun = stepsToRun;
  c.anonymousRelease = anonymousRelease;
  c.recorder = recorder;
  c.helpers = createApproveHelpers(c);

  for (const step of PUBLICATION_STEPS) {
    const out = await STEP_FUNCTIONS[step](c);
    if (out) return out;
  }
  // Final consistency check: ensure dataset visibility matches GitHub state
  const finalCheck = await db
    .prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ visibility: string }>();

  if (finalCheck && finalCheck.visibility !== "public") {
    console.warn(
      `[publish] Consistency fix: dataset ${datasetId} visibility was '${finalCheck.visibility}' at end of publish, correcting to 'public'`,
    );
    await db
      .prepare(
        // Carries the same stamp as the run it is repairing: this is a fix for
        // a row that should already have been flipped, so it must not leave
        // the dataset public with the publication unrecorded -- and for an
        // anonymous release it must not record a publication that did not
        // happen. END_ANONYMITY here would have undone the entire release at
        // the very end of the run that delivered it (#1408).
        `UPDATE datasets SET visibility = 'public', ${
          c.anonymousRelease ? FIRST_PUBLICATION_STAMP_SQL : END_ANONYMITY_AT_PUBLICATION_SQL
        }, updated_at = datetime('now') WHERE dataset_id = ?`,
      )
      .bind(datasetId)
      .run();
  }

  // Ask for the Zarr stores to be rebuilt, now that attribution AND the DOI
  // both exist (#1409).
  //
  // The converter bakes the catalog row's attribution into `index.json`'s
  // `citation` and into every store's `nemar` root attribute, and an anonymous
  // deposit is `visibility = 'public'`, so it has been converting all along --
  // with the blinded label and no DOI. Re-conversion is otherwise triggered
  // only by a `latest_version` change or a GLOBAL `ZARR_ENGINE_VERSION` bump,
  // and de-anonymizing causes neither: the tag comes from the depositor's own
  // `Version` field, `createTag` treats an existing ref as success, and the
  // `dataset_versions` row is written by callbacks the anonymous release never
  // reaches. Without this stamp a published, attributed dataset keeps serving
  // "Anonymous (withheld until publication)" from zarr.nemar.org indefinitely.
  const zarrRequeueWarning = await stampZarrRequeue(db, datasetId, anonymousRelease);

  // Finish the reservations the blind left behind, now that `version_doi` has
  // dealt with the version being published and the concept record is public.
  // After that step, not before: it is the one that refreshes the concept
  // record's `HasVersion` list, and it reads `dataset_versions` to build it.
  const concealedEraDoiWarning = await completeConcealedEraVersionDois(
    env,
    db,
    datasetId,
    anonymousRelease,
  );

  // Mark as published
  await db
    .prepare(
      `UPDATE publication_requests
     SET status = 'published', approved_at = datetime('now'), current_step = NULL, last_error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
    )
    .bind(request.id)
    .run();

  // Neurobagel federation (epic #1586 phase 4, ADR 0084): the dataset is published.
  // A hook, never a step: it does nothing unless the writer is enabled (the default is
  // off), runs in `waitUntil` and catches every failure, so it can neither fail nor
  // delay this approval. A dataset whose version row has not landed yet (the central
  // manifest job writes it later) is not eligible yet, and the manifest-ready callback
  // runs the same hook when it does.
  scheduleNeurobagelSync(env, waitUntil, datasetId, "hook:publication");

  // Audit log (non-fatal but warn user if fails)
  let auditLogFailed = false;
  let auditLogError: string | undefined;

  try {
    await auditLogStatement(db, {
      userId: c.approver.id,
      action: "dataset_published",
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify({
        approved_by: c.approver.username,
        // Only when the executor is not the approver, so a terminal approval's
        // row is byte-identical to what it always was.
        ...(c.approver.id !== adminUser.id ? { executed_by: executorName(adminUser) } : {}),
        steps: allSteps,
        // The review gate's state for this environment and dataset when the row is written, and
        // the flag of the call that finished the run. A skip is also its own row when it happens
        // (`publication_ci_check_skipped`), which survives a resume with another flag.
        review_gate: reviewGateStateOf(env, dataset),
        skip_ci_check: body.skip_ci_check,
      }),
    }).run();
  } catch (auditError) {
    auditLogFailed = true;
    auditLogError = auditError instanceof Error ? auditError.message : String(auditError);
    console.error(
      "AUDIT LOG FAILURE: Dataset publication for",
      datasetId,
      "was not logged:",
      auditLogError,
    );
  }

  // Combine all non-fatal warnings into the response so operators can act
  // without tailing logs. Both warnings are optional and independent.
  const auditWarning = auditLogFailed
    ? `Audit log write failed: ${auditLogError}. Publication succeeded but was not logged for compliance.`
    : undefined;
  const responseWarnings = [
    auditWarning,
    c.notifyUserWarning,
    zarrRequeueWarning,
    concealedEraDoiWarning,
  ].filter(Boolean);

  return c.json({
    message: "Dataset published successfully",
    dataset_id: datasetId,
    status: "published",
    steps_completed: allSteps,
    step_results: stepResults,
    // Always return the final s3_lock totals so the CLI's running counter
    // reaches the true total. Without these the last batch is never counted
    // and the progress display reads short by a full page (e.g. 3963/4963
    // instead of 4963/4963) even when locking succeeded. (#284)
    s3_lock_total: c.s3LockFinalTotal,
    s3_lock_batch_count: c.s3LockFinalBatchCount,
    warning: responseWarnings.length > 0 ? responseWarnings.join(" | ") : undefined,
  });
}
