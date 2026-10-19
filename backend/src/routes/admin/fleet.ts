/**
 * Admin routes: repository visibility, fleet governance (drift report,
 * enforce, revalidate; epic #713), and CI workflow management.
 *
 * Moved verbatim from routes/admin.ts in #903 (epic #902); the only
 * intentional changes are import paths, `adminRoutes` -> `admin`, and
 * audit-log INSERTs routed through auditLogStatement().
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { LIVE_DATASETS, isLiveDataset } from "../../constants";
import { auditLogStatement } from "../../db/audit-log";
import { expectedRepoVisibility } from "../../services/anonymity";
import { isValidDatasetId } from "../../services/datasetId";
import {
  type DriftBucket,
  classifyDatasetDrift,
  gatherRepoDriftState,
} from "../../services/fleet-drift";
import {
  type ReviewIntent,
  type ReviewRulesetPayload,
  type ReviewRulesetStep,
  buildReviewRulesetPayload,
  checkWorkflowExists,
  deployWorkflows,
  ensureRepoToSpec,
  getBranchRulesetInfo,
  getMainBranchSha,
  getWorkflowRuns,
  reconcileReviewRuleset,
  syncWorkflowTemplates,
  triggerBidsValidation,
  validateDeployedWorkflows,
} from "../../services/github";
import { type GitHubAppEnv, getDatasetsToken } from "../../services/github-auth";
import {
  type NotReviewableReason,
  OUTSIDE_FIXTURE_BAND,
  REMOVAL_IS_NEVER_REFUSED,
  REVIEWABLE_ROW_COLUMNS,
  type ReviewableRow,
  automaticReviewIntent,
  isAutoRequireEnabled,
  isRequirementTarget,
  isReviewEnabled,
  isReviewRulesetFixture,
  notReviewableReason,
  reviewAppIds,
  reviewAppRefusal,
  reviewIntentOf,
} from "../../services/pr-review-eligibility";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "../../services/repo-spec";
import { HttpError } from "../../services/retry";
import { applyDatasetVisibility } from "../../services/visibility";
import type { Bindings } from "../../types/bindings";
import type { AdminRouter } from "./shared";

const REVIEW_DISABLED_SENTENCE = `The pull-request review is off in this environment (PR_REVIEW_ENABLED is not 1), so nothing would post the check, and requiring it would block every merge. Turn the review on first. ${REMOVAL_IS_NEVER_REFUSED}`;

/** A dataset row as the review-ruleset routes read it. */
interface ReviewRulesetRow extends ReviewableRow {
  dataset_id: string;
  github_repo: string | null;
}

/** The words an `error` row of a review-ruleset outcome can carry as its `code`. */
type ReviewRulesetErrorCode =
  | "review_disabled"
  | "review_app_mismatch"
  | "review_app_not_configured"
  | "github_request_failed";

/**
 * What one dataset's review-ruleset request came to. `intent` is what the row calls for (or what
 * `remove` asked for), and `action` is what was done, or with a dry run would be: `create`,
 * `update`, `remove`, `none` (nothing to take off), `skip` (required here, not written: see
 * `reason`) or null when the attempt failed (`error` says how, and `code` is its word when it
 * has one).
 */
interface ReviewRulesetOutcome {
  dataset_id: string;
  reviewable: boolean;
  not_reviewable_because: NotReviewableReason | null;
  intent: ReviewIntent;
  action: ReviewRulesetStep["action"] | null;
  applied: boolean;
  reason?: string;
  default_branch?: string;
  payload?: ReviewRulesetPayload;
  error?: string;
  code?: ReviewRulesetErrorCode;
}

/**
 * What a dataset's row, and a request's `remove`, call for: the ruleset on a reviewed dataset,
 * off everything else, and off everywhere with `remove`. The decision is the row's, through the
 * same rule the Worker applies to a pull request (`notReviewableReason`), so a request cannot
 * require the review where the Worker will not give it.
 */
function reviewRulesetIntent(
  row: ReviewableRow,
  remove: boolean,
): { intent: ReviewIntent; why: NotReviewableReason | null } {
  const why = notReviewableReason(row);
  return { intent: remove || why !== null ? "remove" : "require", why };
}

/**
 * Why a live requirement is refused in this environment: the word, and the sentence that says it.
 * The sentence is also what one row of a page carries, and the CLI prints it once for the page, so
 * it says nothing about whether anything was changed: on a page other rows were. The route for one
 * dataset adds that nothing was.
 */
interface RequireRefusal {
  code: ReviewRulesetErrorCode;
  error: string;
}

/**
 * Why a live REQUIREMENT is refused here, or null when it is not: the review is off (nothing would
 * post the check), or this Worker cannot post the check as the GitHub App the ruleset requires it
 * from, because it posts as another App or has no way to sign in as the right one (it would never
 * arrive). Asked of a request whose computed intent is `require`, never of a request's shape:
 * taking the ruleset off is the way out and is never refused, so a live request for a private
 * dataset (which is a removal) goes through, and so does every removal row of a page.
 */
function requireRefusal(
  env: Pick<Bindings, "PR_REVIEW_ENABLED"> & GitHubAppEnv,
): RequireRefusal | null {
  if (!isReviewEnabled(env)) return { code: "review_disabled", error: REVIEW_DISABLED_SENTENCE };
  const app = reviewAppRefusal(env);
  if (app) return { code: app.code, error: app.sentence };
  return null;
}

/**
 * Bring one dataset's repository to what its row calls for (see {@link reviewRulesetIntent}).
 * With `refuseRequire`, a live request whose intent is `require` is not made and is the outcome's
 * `error`, with the refusal's `code`; the rows of the same page that call for a removal are
 * unaffected. Never throws: a failure is the outcome's `error`.
 */
async function reconcileDatasetReview(
  row: ReviewRulesetRow,
  pat: string,
  o: {
    dryRun: boolean;
    remove: boolean;
    withPayload: boolean;
    refuseRequire?: RequireRefusal | null;
  },
): Promise<ReviewRulesetOutcome> {
  const { intent, why } = reviewRulesetIntent(row, o.remove);
  const base = {
    dataset_id: row.dataset_id,
    reviewable: why === null,
    not_reviewable_because: why,
    intent,
  };
  const repoName = row.github_repo?.split("/")[1];
  if (!repoName) {
    return { ...base, action: null, applied: false, error: "the dataset has no GitHub repository" };
  }
  if (!o.dryRun && intent === "require" && o.refuseRequire) {
    return {
      ...base,
      action: null,
      applied: false,
      error: o.refuseRequire.error,
      code: o.refuseRequire.code,
    };
  }
  try {
    const step = await reconcileReviewRuleset(repoName, pat, { intent, dryRun: o.dryRun });
    return {
      ...base,
      action: step.action,
      applied: step.applied,
      ...(step.reason ? { reason: step.reason, default_branch: step.defaultBranch } : {}),
      ...(o.withPayload && step.payload ? { payload: step.payload } : {}),
    };
  } catch (e) {
    // What GitHub said stays on the server: the status and a short message go to the log, and the
    // outcome gets a sentence with the status in it. GitHub's own body is not for a terminal.
    console.error(
      `[review-ruleset] GitHub failed for ${row.dataset_id} (${intent}${o.dryRun ? ", dry run" : ""}): ${
        e instanceof HttpError ? `HTTP ${e.status}: ` : ""
      }${(e instanceof Error ? e.message : String(e)).slice(0, 400)}`,
    );
    return {
      ...base,
      action: null,
      applied: false,
      error: githubFailureSentence(row.dataset_id, e),
      code: "github_request_failed",
    };
  }
}

/**
 * What a failed GitHub request is called to the person who ran the command: a plain sentence with
 * GitHub's status code, and what is known about whether anything changed. A 4xx is a refusal, so
 * nothing was changed. A 5xx or 429, or no answer at all, may have come after GitHub made the
 * change (the answer is what was lost), so it is said not to be known, and the command is safe to
 * run again because it reads before it writes. GitHub's own body is never repeated here.
 */
function githubFailureSentence(datasetId: string, e: unknown): string {
  const again = "Run the same command again: it reads before it writes.";
  if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) {
    return `GitHub refused the request for ${datasetId} (HTTP ${e.status}). Nothing was changed for this dataset.`;
  }
  if (e instanceof HttpError && e.status >= 400) {
    return `GitHub could not complete the request for ${datasetId} (HTTP ${e.status}), so it is not known whether the change was made. ${again}`;
  }
  if (e instanceof HttpError) {
    return `GitHub's answer for ${datasetId} could not be used (HTTP ${e.status}, with no default branch in it). Nothing was changed for this dataset.`;
  }
  return `The request to GitHub for ${datasetId} did not complete, so it is not known whether the change was made. ${again}`;
}

/** The audit row for a ruleset that was written or deleted. Non-fatal, like the other admin audit rows. */
async function auditReviewRuleset(
  db: D1Database,
  admin: { id: number; username: string },
  outcome: ReviewRulesetOutcome,
  bulk: boolean,
): Promise<void> {
  if (!outcome.applied) return;
  try {
    await auditLogStatement(db, {
      userId: admin.id,
      action: outcome.action === "remove" ? "review_ruleset_removed" : "review_ruleset_applied",
      resourceType: "dataset",
      resourceId: outcome.dataset_id,
      details: JSON.stringify({ by: admin.username, action: outcome.action, bulk }),
    }).run();
  } catch (auditError) {
    console.error(
      `Audit log write failed for the review ruleset on ${outcome.dataset_id}:`,
      auditError,
    );
  }
}

const reviewRulesetSchema = z
  .object({ dry_run: z.boolean().optional(), remove: z.boolean().optional() })
  .strict();

const reviewRulesetBulkSchema = z
  .object({
    prefix: z
      .string()
      .regex(/^[a-z]{2}[0-9]{0,6}$/, "prefix is a dataset id prefix such as nm or nm0001")
      .optional(),
    after: z.string().refine(isValidDatasetId, "after is a dataset id").optional(),
    limit: z.number().int().min(1).max(50).optional(),
    dry_run: z.boolean().optional(),
    remove: z.boolean().optional(),
  })
  .strict();

export function registerFleetRoutes(admin: AdminRouter): void {
  // ============================================================================
  // Repository Visibility
  // ============================================================================

  const visibilitySchema = z.object({
    visibility: z.enum(["public", "private"]),
  });

  /**
   * PATCH /admin/datasets/:id/visibility - Change repository visibility
   *
   * A break-glass admin tool: making a dataset public here does NOT pass the
   * identifier screen gate that a publication approval does (ADR 0086 states
   * the exception). It writes an audit row; use the publication flow for a
   * dataset that has not been screened.
   */
  admin.patch("/datasets/:id/visibility", zValidator("json", visibilitySchema), async (c) => {
    const datasetId = c.req.param("id");
    const { visibility } = c.req.valid("json");
    const db = c.env.DB;
    const adminUser = c.get("user");
    const isPrivate = visibility === "private";

    const result = await applyDatasetVisibility(c.env, datasetId, visibility);

    if (!result.ok) {
      switch (result.stage) {
        case "not_found":
          return c.json({ error: result.error }, 404);
        case "no_repo":
          return c.json({ error: result.error }, 400);
        case "invalid_repo":
        case "github":
          return c.json({ error: result.error }, 500);
        case "s3":
          if (result.githubReverted) {
            return c.json(
              {
                error: `Failed to update S3 bucket policy, reverted GitHub repository to ${isPrivate ? "public" : "private"}`,
                details: result.error,
                dataset_id: datasetId,
              },
              500,
            );
          }
          return c.json(
            {
              error: "CRITICAL: S3 policy update failed AND GitHub revert failed",
              details: result.error,
              dataset_id: datasetId,
              github_visibility: visibility,
              s3_public: visibility === "private",
              revert_error: result.revertError,
              action_required: `Manually revert GitHub repo to ${isPrivate ? "public" : "private"} OR manually ${visibility === "public" ? "add" : "remove"} S3 public read policy for ${datasetId}`,
            },
            500,
          );
        case "db":
          if (result.githubReverted && result.s3Reverted) {
            return c.json(
              {
                error: "Database update failed, reverted GitHub and S3 to original state",
                details: result.error,
                dataset_id: datasetId,
              },
              500,
            );
          }
          return c.json(
            {
              error: "CRITICAL: Database update failed AND rollback incomplete",
              details: result.error,
              dataset_id: datasetId,
              github_visibility: visibility,
              github_reverted: result.githubReverted,
              s3_reverted: result.s3Reverted,
              database_visibility: visibility === "public" ? "private" : "public",
              revert_error: result.revertError,
              action_required:
                `Manually fix: ${!result.githubReverted ? `revert GitHub to ${!isPrivate ? "public" : "private"}` : ""} ${!result.s3Reverted ? `revert S3 policy for ${datasetId}` : ""} update database SET visibility = '${visibility}' WHERE dataset_id = '${datasetId}'`.trim(),
            },
            500,
          );
      }
    }

    // Audit log (non-fatal but warn user if fails)
    let auditLogFailed = false;
    let auditLogError: string | undefined;

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "repo_visibility_changed",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ visibility, changed_by: adminUser.username }),
      }).run();
    } catch (auditError) {
      auditLogFailed = true;
      auditLogError = auditError instanceof Error ? auditError.message : String(auditError);
      console.error(
        "AUDIT LOG FAILURE: Visibility change for dataset",
        datasetId,
        "was not logged:",
        auditLogError,
      );
    }

    return c.json({
      message: `Repository visibility set to ${visibility}`,
      dataset_id: datasetId,
      visibility,
      spec_enforcement: result.specEnforcement?.steps,
      warning: auditLogFailed
        ? `Audit log write failed: ${auditLogError}. Operation succeeded but was not logged for compliance.`
        : undefined,
    });
  });

  // ============================================================================
  // Fleet governance (epic #713)
  // ============================================================================

  /**
   * GET /admin/fleet/drift - Report dataset repos that are off the governance
   * spec. Read-only; gathers live GitHub state per repo (sequential, to respect
   * the shared App rate limit) and classifies into drift buckets. Filter with
   * ?prefix=nm, ?visibility=public|private, ?limit=N (default 25, max 50).
   *
   * The required review (ADR 0107) is measured against the requirement being the target, which it
   * is only with PR_REVIEW_ENABLED and PR_REVIEW_AUTO_REQUIRE both on: before that no reviewed
   * dataset is reported as missing the ruleset, while a ruleset on a dataset that is not
   * reviewed is reported as stray whatever the switches say.
   */
  admin.get("/fleet/drift", async (c) => {
    const db = c.env.DB;
    const prefix = c.req.query("prefix");
    const visFilter = c.req.query("visibility");
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query("limit") ?? "25", 10) || 25, 1),
      50,
    );

    const clauses: string[] = ["github_repo IS NOT NULL", "dataset_id != 'nm099999'"];
    const binds: unknown[] = [];
    if (prefix) {
      clauses.push("dataset_id LIKE ?");
      binds.push(`${prefix}%`);
    }
    if (visFilter === "public" || visFilter === "private") {
      clauses.push("visibility = ?");
      binds.push(visFilter);
    }

    const rows = await db
      .prepare(
        `SELECT dataset_id, github_repo, ${REVIEWABLE_ROW_COLUMNS} FROM datasets
        WHERE ${clauses.join(" AND ")} ORDER BY dataset_id LIMIT ?`,
      )
      .bind(...binds, limit)
      .all<ReviewableRow & { dataset_id: string; github_repo: string }>();

    const datasets = rows.results ?? [];
    const pat = await getDatasetsToken(c.env);
    // The requirement is the target only once the review is on AND the owner has turned the
    // automatic requirement on. Before that no dataset is "missing" it: right after a deploy every
    // reviewed public dataset lacks the ruleset, and that is what nobody has asked for yet. A
    // ruleset on a dataset that is not reviewed is stray whatever the switches say.
    const requirementOn = isRequirementTarget(c.env);
    const buckets: Partial<Record<DriftBucket, string[]>> = {};
    const repos: Array<{ dataset_id: string; buckets: DriftBucket[] }> = [];

    for (const d of datasets) {
      const repoName = d.github_repo.split("/")[1];
      if (!repoName) continue;
      const visibility = expectedRepoVisibility(d);
      let result: DriftBucket[];
      try {
        result = classifyDatasetDrift(
          await gatherRepoDriftState(
            repoName,
            visibility,
            pat,
            reviewIntentOf(d.dataset_id, d, requirementOn),
          ),
        );
      } catch (e) {
        console.error(`[fleet/drift] gather failed for ${d.dataset_id}:`, e);
        continue;
      }
      repos.push({ dataset_id: d.dataset_id, buckets: result });
      for (const b of result) {
        const list = buckets[b] ?? [];
        list.push(d.dataset_id);
        buckets[b] = list;
      }
    }

    const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
    return c.json({ scanned: datasets.length, limit, counts, buckets, repos });
  });

  const enforceSchema = z.object({ dry_run: z.boolean().optional() });

  /**
   * POST /admin/datasets/:id/enforce - Bring one dataset repo to spec via
   * ensureRepoToSpec (public locks + reconciles; private removes the ruleset +
   * reconciles). `dry_run` defaults to TRUE (must pass `dry_run:false` to apply),
   * matching the bulk endpoint so a bare `{}` body never mutates.
   *
   * The required pull-request review (ADR 0107) is one more step, decided from the
   * dataset's row: required on a reviewed dataset while the review is on, removed
   * from any other, left alone while the review is off or for a standing fixture.
   * Only the REQUIREMENT waits for the owner's switch (PR_REVIEW_AUTO_REQUIRE): with the
   * switch off a reviewed dataset has no review step and its review ruleset is left exactly as
   * it is, while a dataset that is not reviewed still has the ruleset taken off. The explicit
   * review-ruleset routes below do not wait for it.
   */
  admin.post("/datasets/:id/enforce", zValidator("json", enforceSchema), async (c) => {
    const datasetId = c.req.param("id");
    const dryRun = c.req.valid("json").dry_run !== false;
    const db = c.env.DB;

    // Live datasets hold real data; refuse to APPLY governance changes to them
    // without an explicit override. Dry-run (read-only) is always allowed.
    if (!dryRun && isLiveDataset(datasetId) && c.req.query("force") !== "true") {
      return c.json(
        {
          error: `Refusing to enforce live dataset ${datasetId}. Pass ?force=true to override.`,
        },
        403,
      );
    }

    const dataset = await db
      .prepare(`SELECT github_repo, ${REVIEWABLE_ROW_COLUMNS} FROM datasets WHERE dataset_id = ?`)
      .bind(datasetId)
      .first<ReviewableRow & { github_repo: string | null }>();
    if (!dataset) return c.json({ error: "Dataset not found" }, 404);
    if (!dataset.github_repo) return c.json({ error: "Dataset has no GitHub repository" }, 400);
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) return c.json({ error: "Invalid repository format" }, 500);

    const visibility = expectedRepoVisibility(dataset);
    const pat = await getDatasetsToken(c.env);
    const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);

    let result: Awaited<ReturnType<typeof ensureRepoToSpec>>;
    try {
      result = await ensureRepoToSpec(repoName, pat, {
        visibility,
        collaborators: { ownerLogin, approvedWriters },
        dryRun: dryRun,
        // The required review follows the row, as it does on publication (ADR 0107). Putting it
        // on waits for the owner to turn automatic requirement on; taking it off does not.
        review: automaticReviewIntent(c.env, datasetId, dataset),
      });
    } catch (e) {
      return c.json(
        { error: "Enforcement failed", details: e instanceof Error ? e.message : String(e) },
        500,
      );
    }

    if (!dryRun) await mirrorReconcileRemovals(db, datasetId, result.reconcile?.removed);
    return c.json({ dataset_id: datasetId, dry_run: dryRun, result });
  });

  /**
   * POST /admin/datasets/:id/revalidate - Re-run central BIDS validation on the
   * dataset's `main` HEAD so a fresh `Run BIDS Validation` check-run lands there
   * (the enforce green-gate only reads HEAD; a `[skip ci]` metadata commit leaves
   * it uncovered). Unifies the two cases the manual #713 rollout handled by hand:
   *   - inline workflow still present -> `syncWorkflowTemplates` commits the shim,
   *     and that push auto-triggers validation;
   *   - shim already deployed -> `triggerBidsValidation` dispatches it directly.
   * Already-protected repos are skipped (locked => no re-validation needed).
   * Live datasets are refused without `?force=true` (mirrors ci/sync, #730).
   * The CLI polls the resulting check-run, then runs `enforce` for the greens.
   */
  admin.post("/datasets/:id/revalidate", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const adminUser = c.get("user");
    const force = c.req.query("force") === "true";

    if (isLiveDataset(datasetId) && !force) {
      return c.json(
        {
          error: `Refusing to revalidate live dataset ${datasetId}. Pass ?force=true to override.`,
        },
        403,
      );
    }

    const dataset = await db
      .prepare("SELECT github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ github_repo: string | null }>();
    if (!dataset) return c.json({ error: "Dataset not found" }, 404);
    if (!dataset.github_repo) return c.json({ error: "Dataset has no GitHub repository" }, 400);
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) return c.json({ error: "Invalid repository format" }, 500);

    const pat = await getDatasetsToken(c.env);

    // Skip-if-locked: a protected repo is already green-gated; no need to churn it.
    try {
      const ruleset = await getBranchRulesetInfo(repoName, pat);
      if (ruleset.present && !force) {
        const headSha = await getMainBranchSha(repoName, "main", pat).catch(() => null);
        return c.json({ dataset_id: datasetId, skipped: "already_protected", head_sha: headSha });
      }
    } catch (e) {
      // Non-fatal: if we can't read the ruleset, fall through and revalidate.
      console.error(`[revalidate] ruleset check failed for ${datasetId}:`, e);
    }

    let triggeredBy: "sync" | "dispatch";
    let headSha: string;
    try {
      // Ensure the central shim is deployed. If it was inline, the sync commit
      // auto-triggers validation; re-read HEAD to point the caller at the new sha.
      const sync = await syncWorkflowTemplates(repoName, "main", pat);
      if (sync.listFailed) {
        return c.json(
          { error: "Workflow listing failed (transient?)", details: sync.errors.join("; ") },
          502,
        );
      }
      if (sync.errors.length > 0) {
        return c.json({ error: "Workflow sync failed", details: sync.errors.join("; ") }, 502);
      }
      if (sync.committed) {
        triggeredBy = "sync";
        headSha = await getMainBranchSha(repoName, "main", pat);
      } else {
        triggeredBy = "dispatch";
        headSha = await getMainBranchSha(repoName, "main", pat);
        await triggerBidsValidation(datasetId, headSha, pat);
      }
    } catch (e) {
      return c.json(
        { error: "Revalidation failed", details: e instanceof Error ? e.message : String(e) },
        500,
      );
    }

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "ci_revalidate",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({
          by: adminUser.username,
          triggered_by: triggeredBy,
          head_sha: headSha,
        }),
      }).run();
    } catch (auditError) {
      console.error("Audit log write failed for revalidate:", auditError);
    }

    return c.json({ dataset_id: datasetId, head_sha: headSha, triggered_by: triggeredBy });
  });

  const enforceBulkSchema = z.object({
    prefix: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    dry_run: z.boolean().optional(),
  });

  /**
   * POST /admin/datasets/enforce/bulk - Run ensureRepoToSpec across a filtered set
   * SEQUENTIALLY (shared App rate limit). `dry_run` defaults to TRUE; pass
   * `dry_run:false` to actually apply. Always excludes nm099999. Owner-only.
   * Each dataset's required review follows its row, as in the single route, and its requirement
   * waits for the owner's switch (PR_REVIEW_AUTO_REQUIRE) in the same way.
   */
  admin.post("/datasets/enforce/bulk", zValidator("json", enforceBulkSchema), async (c) => {
    if (c.get("user").role !== "owner") {
      return c.json({ error: "Only the NEMAR owner can bulk-enforce" }, 403);
    }
    const db = c.env.DB;
    const { prefix, visibility, limit, dry_run } = c.req.valid("json");
    const dryRun = dry_run !== false; // default to a dry run
    const cap = limit ?? 25;

    // Never bulk-mutate the test dataset or any LIVE production dataset. The
    // values are compile-time constants (no user input), so inlining them is
    // injection-safe and mirrors the existing nm099999 literal.
    const liveList = [...LIVE_DATASETS].map((id) => `'${id}'`).join(", ");
    const clauses: string[] = [
      "github_repo IS NOT NULL",
      "dataset_id != 'nm099999'",
      `dataset_id NOT IN (${liveList})`,
    ];
    const binds: unknown[] = [];
    if (prefix) {
      clauses.push("dataset_id LIKE ?");
      binds.push(`${prefix}%`);
    }
    if (visibility) {
      clauses.push("visibility = ?");
      binds.push(visibility);
    }

    const rows = await db
      .prepare(
        `SELECT dataset_id, github_repo, ${REVIEWABLE_ROW_COLUMNS} FROM datasets
        WHERE ${clauses.join(" AND ")} ORDER BY dataset_id LIMIT ?`,
      )
      .bind(...binds, cap)
      .all<ReviewableRow & { dataset_id: string; github_repo: string }>();

    const datasets = rows.results ?? [];
    const pat = await getDatasetsToken(c.env);
    const results: Array<{
      dataset_id: string;
      steps?: Record<string, { status: string; detail?: string }>;
      error?: string;
    }> = [];

    for (const d of datasets) {
      const repoName = d.github_repo.split("/")[1];
      if (!repoName) {
        results.push({ dataset_id: d.dataset_id, error: "invalid repo format" });
        continue;
      }
      const vis = expectedRepoVisibility(d);
      try {
        const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, d.dataset_id);
        const spec = await ensureRepoToSpec(repoName, pat, {
          visibility: vis,
          collaborators: { ownerLogin, approvedWriters },
          dryRun: dryRun,
          review: automaticReviewIntent(c.env, d.dataset_id, d),
        });
        if (!dryRun) await mirrorReconcileRemovals(db, d.dataset_id, spec.reconcile?.removed);
        results.push({ dataset_id: d.dataset_id, steps: spec.steps });
      } catch (e) {
        results.push({
          dataset_id: d.dataset_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return c.json({ dry_run: dryRun, count: datasets.length, results });
  });

  // ============================================================================
  // The required pull-request review (ADR 0107)
  // ============================================================================

  /**
   * POST /admin/datasets/:id/review-ruleset - Put the "NEMAR PR review required" ruleset on one
   * dataset's repository, or take it off.
   *
   * What the dataset calls for is decided from its row by the rule the Worker reviews by: required
   * on a live, public, named, first-published dataset, removed from any other. `remove: true`
   * takes it off whatever the row says (the rollback). `dry_run` defaults to TRUE; send
   * `dry_run:false` to change anything, so a bare `{}` never mutates.
   *
   * Refused, always with a 409: a standing test fixture (nm099900 to nm099999), whatever else is
   * asked (`reserved_fixture_id`: a conflict with what the dataset is, not a matter of who is
   * asking, which a 403 would say); and a live request whose COMPUTED intent is to require the
   * review where a required check could not arrive, because it would block every merge: the
   * review is off in this environment (`review_disabled`), or this Worker posts the check as a
   * different GitHub App than the one the ruleset requires it from (`review_app_mismatch`, which
   * names both ids). The test is the intent the dataset's row works out to, not the shape of the
   * request: a live request for a private dataset is a removal, and taking the requirement off is
   * never refused, since it is the way out. No dataset is special-cased for being live.
   *
   * Every answer carries the two App ids (`github_app_id`, `ruleset_app_id`, `app_id_matches`), so
   * a dry run shows whether `dry_run:false` would be refused for that reason, and the two switches
   * as this Worker reads them (`review_enabled`, `auto_require`). The second is how a switch that
   * was set as a Worker secret, which the configuration file cannot show, becomes visible.
   */
  admin.post("/datasets/:id/review-ruleset", zValidator("json", reviewRulesetSchema), async (c) => {
    const datasetId = c.req.param("id");
    const { dry_run, remove } = c.req.valid("json");
    const dryRun = dry_run !== false;
    const removing = remove === true;
    const enabled = isReviewEnabled(c.env);
    const autoRequire = isAutoRequireEnabled(c.env);

    if (isReviewRulesetFixture(datasetId)) {
      return c.json(
        {
          error: `${datasetId} is a standing test fixture (the nm099900 to nm099999 band), so the review ruleset is never put on it or taken off it.`,
          code: "reserved_fixture_id",
        },
        // 409, not 403: the caller is allowed to ask, and the request conflicts with what this
        // dataset is. A 403 makes the CLI tell an administrator that the command needs admin
        // privileges, which they have.
        409,
      );
    }

    const row = await c.env.DB.prepare(
      `SELECT dataset_id, github_repo, ${REVIEWABLE_ROW_COLUMNS} FROM datasets WHERE dataset_id = ?`,
    )
      .bind(datasetId)
      .first<ReviewRulesetRow>();
    if (!row) return c.json({ error: "Dataset not found" }, 404);
    if (!row.github_repo) return c.json({ error: "Dataset has no GitHub repository" }, 400);

    // Refused before a token is minted or GitHub is asked anything, and only for a requirement.
    if (!dryRun && reviewRulesetIntent(row, removing).intent === "require") {
      const refusal = requireRefusal(c.env);
      if (refusal) {
        return c.json({ error: `${refusal.error} Nothing was changed.`, code: refusal.code }, 409);
      }
    }

    const outcome = await reconcileDatasetReview(row, await getDatasetsToken(c.env), {
      dryRun,
      remove: removing,
      withPayload: true,
    });
    if (outcome.error) {
      // The sentence is the answer: the CLI prints `error` and never `details`, so a cause kept
      // behind a generic title never reached the person who ran the command.
      return c.json({ error: outcome.error, code: outcome.code }, 502);
    }
    await auditReviewRuleset(c.env.DB, c.get("user"), outcome, false);
    return c.json({
      dry_run: dryRun,
      review_enabled: enabled,
      auto_require: autoRequire,
      ...reviewAppIds(c.env),
      ...outcome,
    });
  });

  /**
   * POST /admin/datasets/review-ruleset/bulk - The same across a page of datasets, in id order,
   * SEQUENTIALLY (the App's rate limit is shared). Owner-only. `dry_run` defaults to TRUE.
   *
   * Each dataset gets what ITS row calls for: the ruleset where the Worker reviews, taken off
   * everywhere else (a private dataset, an unpublished one, an anonymous deposit), and off
   * everywhere with `remove`. The fixture band nm099900 to nm099999 is never selected. A page is
   * at most 50 datasets; `next_after` is the last id of a full page, to send as `after` for the
   * next one. A dataset that fails is an `error` on its row and does not stop the page.
   *
   * With the requirement refused (the review off, or the App ids different), a live page still
   * applies every removal. A row whose computed intent is to require the review is refused on its
   * own row, with the code `review_disabled` or `review_app_mismatch`, because requiring a check
   * that cannot arrive would block every merge.
   */
  admin.post(
    "/datasets/review-ruleset/bulk",
    zValidator("json", reviewRulesetBulkSchema),
    async (c) => {
      if (c.get("user").role !== "owner") {
        return c.json({ error: "Only the NEMAR owner can bulk-apply the review ruleset" }, 403);
      }
      const { prefix, after, limit, dry_run, remove } = c.req.valid("json");
      const dryRun = dry_run !== false;
      const removing = remove === true;
      const cap = limit ?? 25;
      const enabled = isReviewEnabled(c.env);
      const autoRequire = isAutoRequireEnabled(c.env);

      const clauses: string[] = ["github_repo IS NOT NULL", OUTSIDE_FIXTURE_BAND.sql];
      const binds: unknown[] = [OUTSIDE_FIXTURE_BAND.bind];
      if (prefix) {
        clauses.push("dataset_id LIKE ?");
        binds.push(`${prefix}%`);
      }
      if (after) {
        clauses.push("dataset_id > ?");
        binds.push(after);
      }
      const rows = await c.env.DB.prepare(
        `SELECT dataset_id, github_repo, ${REVIEWABLE_ROW_COLUMNS} FROM datasets
        WHERE ${clauses.join(" AND ")} ORDER BY dataset_id LIMIT ?`,
      )
        .bind(...binds, cap)
        .all<ReviewRulesetRow>();
      const datasets = rows.results ?? [];

      const pat = await getDatasetsToken(c.env);
      const results: ReviewRulesetOutcome[] = [];
      const refuseRequire = requireRefusal(c.env);
      for (const row of datasets) {
        const outcome = await reconcileDatasetReview(row, pat, {
          dryRun,
          remove: removing,
          withPayload: false,
          refuseRequire,
        });
        results.push(outcome);
        await auditReviewRuleset(c.env.DB, c.get("user"), outcome, true);
      }

      return c.json({
        dry_run: dryRun,
        review_enabled: enabled,
        auto_require: autoRequire,
        ...reviewAppIds(c.env),
        remove: removing,
        limit: cap,
        count: datasets.length,
        next_after: datasets.length === cap ? datasets[datasets.length - 1].dataset_id : null,
        // What every `create` and `update` row sends: one body for the page.
        payload: removing ? null : buildReviewRulesetPayload(),
        results,
      });
    },
  );

  // ============================================================================
  // CI Management
  // ============================================================================

  /**
   * GET /admin/datasets/:id/ci - Check CI workflow status
   */
  admin.get("/datasets/:id/ci", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const pat = await getDatasetsToken(c.env);

    let bidsWorkflowExists = false;
    let versionCheckExists = false;
    let latestRunStatus = "unknown";
    let latestRunUrl: string | null = null;

    try {
      bidsWorkflowExists = await checkWorkflowExists(
        repoName,
        ".github/workflows/bids-validation.yml",
        pat,
      );

      versionCheckExists = await checkWorkflowExists(
        repoName,
        ".github/workflows/version-check.yml",
        pat,
      );

      if (bidsWorkflowExists) {
        const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
        if (runs.length > 0) {
          const latest = runs[0];
          latestRunStatus = latest.conclusion || latest.status;
          latestRunUrl = latest.html_url;
        } else {
          latestRunStatus = "no_runs";
        }
      }
    } catch (githubError) {
      const msg = githubError instanceof Error ? githubError.message : String(githubError);
      return c.json({ error: `GitHub API error: ${msg}` }, 502);
    }

    return c.json({
      dataset_id: datasetId,
      bids_validation: {
        present: bidsWorkflowExists,
        status: bidsWorkflowExists ? latestRunStatus : "missing",
        url: latestRunUrl,
      },
      version_check: {
        present: versionCheckExists,
      },
    });
  });

  /**
   * POST /admin/datasets/:id/ci - Deploy CI workflows to repository
   */
  admin.post("/datasets/:id/ci", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const adminUser = c.get("user");

    // Deploying workflows commits to the repo's main branch (same class of
    // mutation as ci/sync). Live datasets hold real data; refuse without an
    // explicit override.
    if (isLiveDataset(datasetId) && c.req.query("force") !== "true") {
      return c.json(
        {
          error: `Refusing to modify live dataset ${datasetId}. Pass ?force=true to override.`,
        },
        403,
      );
    }

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    // Post-deploy parseability check moved out of the Worker (issue #472).
    // The CLI polls POST /admin/datasets/:id/ci/validate after this returns.
    // The legacy ?validate=false query param is accepted but ignored — old
    // CLIs that sent it still get a successful, fast deploy.
    const result = await deployWorkflows(repoName, await getDatasetsToken(c.env));

    if (!result.success) {
      return c.json(
        {
          error: "Failed to deploy some workflows",
          deployed: result.deployed,
          failed: result.errors,
        },
        500,
      );
    }

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "ci_workflows_deployed",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ deployed_by: adminUser.username }),
      }).run();
    } catch (auditError) {
      console.error("Audit log write failed for CI deploy:", auditError);
    }

    return c.json({
      message: "CI workflows deployed successfully",
      dataset_id: datasetId,
      workflows_deployed: result.deployed,
    });
  });

  /**
   * POST /admin/datasets/:id/ci/validate - One-shot parseability probe.
   *
   * Called by the CLI after the deploy endpoint returns. The CLI handles the
   * indexing-lag wait and retry on its own machine, keeping the Worker
   * wall-clock budget out of the loop (issue #472).
   *
   * Returns valid/missing/errors for the workflows defined by the current
   * template set. Best-effort: a 500 from GitHub or a transport error lands in
   * `errors` rather than failing the response.
   *
   * Verb choice: this is a read-only probe and a strict REST reading would
   * favor GET. We keep POST to stay consistent with the rest of the ci/*
   * family (POST /ci to deploy, POST /ci/sync to bring drift back in line —
   * both admin-only RPC-style operations). Mixing verbs across the family
   * would surprise admin tooling that scripts these endpoints.
   */
  admin.post("/datasets/:id/ci/validate", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }
    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const result = await validateDeployedWorkflows(repoName, await getDatasetsToken(c.env));
    return c.json({
      dataset_id: datasetId,
      valid: result.valid,
      missing: result.missing,
      errors: result.errors,
    });
  });

  /**
   * POST /admin/datasets/:id/ci/sync - Bring deployed CI workflows in sync with
   * the current templates. Only files that drift or are missing are written,
   * in a single tree commit. Idempotent and cheap when nothing has changed
   * (single Contents-API listing).
   */
  admin.post("/datasets/:id/ci/sync", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const adminUser = c.get("user");

    // ci/sync commits to the repo's main branch (overwrites workflow files).
    // Live datasets hold real data; refuse without an explicit override.
    if (isLiveDataset(datasetId) && c.req.query("force") !== "true") {
      return c.json(
        {
          error: `Refusing to modify live dataset ${datasetId}. Pass ?force=true to override.`,
        },
        403,
      );
    }

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }
    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const result = await syncWorkflowTemplates(repoName, "main", await getDatasetsToken(c.env));

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "ci_workflows_synced",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({
          synced_by: adminUser.username,
          changed: result.changed,
          added: result.added,
          errors: result.errors,
          committed: result.committed,
          list_failed: result.listFailed,
        }),
      }).run();
    } catch (auditError) {
      console.error("Audit log write failed for CI sync:", auditError);
    }

    // 207 (Multi-Status) when the call surfaced any partial failures so
    // automation and `--all` loops don't false-green on partial errors.
    const status = result.errors.length > 0 ? 207 : 200;
    return c.json(
      {
        dataset_id: datasetId,
        checked: result.checked,
        changed: result.changed,
        added: result.added,
        errors: result.errors,
        committed: result.committed,
        list_failed: result.listFailed,
      },
      status,
    );
  });
}
