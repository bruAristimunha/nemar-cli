/**
 * Admin routes: publication workflow (list/deny/approve publication requests,
 * S3 Object Lock). The approve route is a thin adapter over the 16-step
 * state machine in services/publication-orchestrator.ts (#904, epic #902);
 * list/deny/s3-lock handlers moved verbatim from routes/admin.ts in #903.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { screenGate } from "../../../../shared/identifier-screen-report.js";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
  DENIAL_REASON_MAX_LENGTH,
} from "../../../../shared/publication-limits.js";
import { publishingStanding } from "../../../../shared/publication-steps.js";
import { auditLogStatement } from "../../db/audit-log";
import { ACTIVE_REQUEST_TAIL_SQL, approvalInFlightSql } from "../../services/approval-dispatch";
import { resolveEmailConfig, sendPublicationDeniedEmail } from "../../services/email";
import { getDatasetsAuth } from "../../services/github-auth";
import {
  DispatchRejectedError,
  approvalDispatchEnvironment,
  triggerApprovePublication,
} from "../../services/github/dispatch";
import {
  RERUN_GUARD_SQL,
  SCREEN_REPORT_DEADLINE_MINUTES,
  hasStartedPublishing,
  isScreenExempt,
  notifyAdminsOfScreen,
  readStoredState,
  recordScreenAcknowledgment,
  screenStateGate,
  screenView,
  startIdentifierScreen,
  verifyScreenHead,
} from "../../services/identifier-screen";
import {
  acknowledgeIdentifierScreenSchema,
  approveSchema,
  publicationReviewOverrideSchema,
  runPublicationApproval,
} from "../../services/publication-orchestrator";
import {
  type ReviewGateResult,
  evaluateApprovalReviewGate,
  recordApprovalOverride,
} from "../../services/publication-review-gate";
import { publicationReviewSummaries } from "../../services/publication-review-view";
import { errorMessage } from "../../services/repo-metadata";
import { applyObjectLockBatch } from "../../services/s3";
import { isAllowedOrigin } from "../../services/web-session";
import { getS3Config } from "./shared";
import type { AdminRouter } from "./shared";

/** The re-run route's answer for a request whose approval has started publishing. */
const APPROVAL_IN_PROGRESS = {
  error: "approval_in_progress",
  message:
    "An approval of this request has already started publishing, and it passed the identifier screen when it started. Resume it rather than screening again.",
};

/** The optional body of the approve-dispatch route. */
const dispatchBodySchema = z
  .object({
    acknowledge_identifier_screen: acknowledgeIdentifierScreenSchema.optional(),
    override_publication_review: publicationReviewOverrideSchema.optional(),
  })
  .strict();

export function registerPublishRoutes(admin: AdminRouter): void {
  // ============================================================================
  // Publication Workflow (Admin)
  // ============================================================================

  /**
   * GET /admin/publish/requests - List publication requests
   *
   * `approval_in_flight` is computed per row from the same predicate the
   * dispatch route claims with (services/approval-dispatch.ts), so a client
   * never offers an action the route would refuse and never hard-codes the
   * lease. The new columns `approval_requested_by` and `approval_dispatched_at`
   * ride along in `pr.*`.
   *
   * `publication_review` (ADR 0102) is the review of each request, re-derived now from its stored
   * report and the live facts: the outcome, the headline and the reason codes in the shared
   * words, and no sentence the model wrote. The dataset's columns it needs are joined in under
   * names of their own and withheld from the response below, so the wire gains one key.
   */
  admin.get("/publish/requests", async (c) => {
    const db = c.env.DB;
    const status = c.req.query("status");

    let query = `
    SELECT pr.*, u.username as requested_by_username, u.email as requested_by_email,
           ${approvalInFlightSql("pr.")} AS approval_in_flight,
           d.dataset_id AS review_ds_id, d.source AS review_ds_source,
           d.is_exemplar AS review_ds_is_exemplar, d.concept_doi AS review_ds_concept_doi,
           d.ezid_status AS review_ds_ezid_status,
           d.first_published_at AS review_ds_first_published_at
    FROM publication_requests pr
    JOIN users u ON pr.requested_by = u.id
    LEFT JOIN datasets d ON d.dataset_id = pr.dataset_id
  `;
    const params: string[] = [];

    if (status) {
      query += " WHERE pr.status = ?";
      params.push(status);
    }

    query += " ORDER BY pr.requested_at DESC";

    const requests = await db
      .prepare(query)
      .bind(...params)
      .all<{
        id: number;
        dataset_id: string;
        status: string;
        requested_at: string;
        requested_by_username: string;
        requested_by_email: string;
        steps_completed: string;
        current_step: string | null;
        last_error: string | null;
        prescreen_status: string | null;
        prescreen_reasons: string | null;
        prescreen_issue_url: string | null;
        approval_requested_by: number | null;
        approval_dispatched_at: string | null;
        approval_in_flight: number;
        prescreen_nonce?: string | null;
        block_reason: string | null;
        anonymous: number | null;
        identifier_screen_status: string | null;
        identifier_screen_nonce?: string | null;
        identifier_screen_report?: string | null;
        identifier_screen_ack_by: number | null;
        identifier_screen_ack_at: string | null;
        review_ds_id: string | null;
        review_ds_source: string | null;
        review_ds_is_exemplar: number | null;
        review_ds_concept_doi: string | null;
        review_ds_ezid_status: string | null;
        review_ds_first_published_at: string | null;
      }>();

    // One clock for the whole list, so two rows are aged by the same instant.
    const nowMs = Date.now();
    // The review of every row, read in a few statements and derived a few rows at a time; a row
    // whose review cannot be read says so for itself and never fails the list (ADR 0102).
    const reviews = await publicationReviewSummaries(
      c.env,
      requests.results.map((r) => ({
        request: {
          id: r.id,
          dataset_id: r.dataset_id,
          status: r.status,
          block_reason: r.block_reason,
          anonymous: r.anonymous,
          identifier_screen_status: r.identifier_screen_status,
          identifier_screen_report: r.identifier_screen_report ?? null,
          identifier_screen_ack_by: r.identifier_screen_ack_by,
          identifier_screen_ack_at: r.identifier_screen_ack_at,
          steps_completed: r.steps_completed ?? null,
        },
        dataset:
          r.review_ds_id === null
            ? null
            : {
                source: r.review_ds_source,
                is_exemplar: r.review_ds_is_exemplar,
                concept_doi: r.review_ds_concept_doi,
                ezid_status: r.review_ds_ezid_status,
                first_published_at: r.review_ds_first_published_at,
                // The detail's field; the summary does not use it.
                total_files: null,
              },
      })),
      nowMs,
    );
    const rows = requests.results.map((r, index) => {
      // `pr.*` puts every column on the wire without naming it. The two
      // callback nonces are credentials (each one verifies a workflow's
      // callback), and the stored screen report is shown ONLY through
      // describeScreen's words below, so all three are withheld here, from
      // everyone (epic #1610 phase 4). The dataset columns the review reads
      // were joined in for it and are not part of the contract either.
      const {
        prescreen_nonce: _prescreenNonce,
        identifier_screen_nonce: _screenNonce,
        identifier_screen_report: screenReport,
        review_ds_id: _dsId,
        review_ds_source: _dsSource,
        review_ds_is_exemplar: _dsIsExemplar,
        review_ds_concept_doi: _dsConceptDoi,
        review_ds_ezid_status: _dsEzidStatus,
        review_ds_first_published_at: _dsFirstPublishedAt,
        ...rest
      } = r;
      return {
        ...rest,
        steps_completed: JSON.parse(r.steps_completed || "[]"),
        approval_in_flight: r.approval_in_flight === 1,
        identifier_screen: screenView(r.dataset_id, r.identifier_screen_status, screenReport),
        publication_review: reviews[index],
      };
    });

    return c.json({ requests: rows, count: rows.length });
  });

  /**
   * POST /admin/publish/:id/deny - Deny a publication request
   */
  const denySchema = z.object({
    reason: z
      .string()
      .min(1, "Reason is required")
      .max(DENIAL_REASON_MAX_LENGTH, "Reason too long"),
  });

  admin.post("/publish/:id/deny", zValidator("json", denySchema), async (c) => {
    const datasetId = c.req.param("id");
    const { reason } = c.req.valid("json");
    const adminUser = c.get("user");
    const db = c.env.DB;

    const request = await db
      .prepare(
        "SELECT id, status, requested_by FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked') ORDER BY requested_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ id: number; status: string; requested_by: number }>();

    if (!request) {
      return c.json({ error: "No active publication request found" }, 404);
    }

    await db
      .prepare(
        `UPDATE publication_requests
       SET status = 'denied', denied_at = datetime('now'), denied_by = ?, denied_reason = ?, updated_at = datetime('now')
       WHERE id = ?`,
      )
      .bind(adminUser.id, reason, request.id)
      .run();

    // Notify the requesting user
    try {
      const user = await db
        .prepare("SELECT username, email FROM users WHERE id = ?")
        .bind(request.requested_by)
        .first<{ username: string; email: string }>();

      if (user) {
        const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
        await sendPublicationDeniedEmail(
          user.email,
          user.username,
          datasetId,
          reason,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
          c.env,
        );
      }
    } catch (emailError) {
      console.error("Failed to send denial email:", emailError);
    }

    return c.json({
      message: "Publication request denied",
      dataset_id: datasetId,
      reason,
    });
  });

  /**
   * POST /admin/publish/:id/approve - Approve and run the publication
   * orchestrator. The 16-step state machine lives in
   * services/publication-orchestrator.ts (#904); this route is a thin adapter.
   *
   * The body carries `resume`, `skip_ci_check` and the S3 lock fields as before, and two fields
   * of an approval that is gated: `acknowledge_identifier_screen` (the identifier screen's
   * reason, ADR 0086) and `override_publication_review` (the review shown and the reasons shown,
   * ADR 0102).
   *
   * Refusals, each with a stable code in `error` and a sentence in `message`:
   *   403 origin_not_allowed  an override sent with a session cookie: it is accepted only with
   *                         an API key, and the website records one through approve-dispatch
   *   409 request_blocked   the request is `blocked` and is not a run that started publishing
   *                         (the owner-name walk-back); whatever the flag says
   *   409 identifier_screen_not_clear  the identifier screen does not allow it (ADR 0086)
   *   409 publication_review_not_clear  the review does not allow it, with a `refusal` word and
   *                         the review's words (ADR 0102)
   *   409 override_inside_web_approval  an override sent inside a live web approval of the
   *                         request, which would be recorded under the administrator who clicked
   *   409 request_changed   the request was denied or blocked while the approval was checked
   */
  admin.post("/publish/:id/approve", zValidator("json", approveSchema), async (c) => {
    const body = c.req.valid("json");
    // An override of the publication review is an administrator's own act, and a session cookie
    // rides along with any cross-site request a browser can be made to send, so it is accepted
    // only with an API key (ADR 0102; the one slice of #1603 this phase needs). The website records
    // one through approve-dispatch, which asks for a NEMAR origin. Phrased as "not a token", so an
    // unset `authMethod` fails closed.
    if (body.override_publication_review !== undefined && c.get("authMethod") !== "token") {
      return c.json(
        {
          error: "origin_not_allowed",
          message:
            "An override of the publication review is accepted only with an API key; the website records one through approve-dispatch.",
        },
        403,
      );
    }
    const result = await runPublicationApproval({
      db: c.env.DB,
      env: c.env,
      // Lazy closure: executionCtx is only touched if a step actually
      // schedules background work (test harnesses provide no executionCtx).
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      datasetId: c.req.param("id"),
      adminUser: c.get("user"),
      body,
    });
    return c.json(result.body as never, (result.status ?? 200) as never);
  });

  /**
   * POST /admin/publish/:id/approve-dispatch - Launch an approval from the web
   * (ADR 0080).
   *
   * Approval is not one request: after the irreversible DOI publish, S3 Object
   * Lock runs in batches the CALLER must keep requesting, so a click cannot run
   * it inside one Worker invocation and the loop is deliberately not moved into
   * the Worker. This route claims the request, records WHO clicked, and hands
   * the run to an executor (a GitHub Actions workflow that drives the CLI)
   * through `repository_dispatch`, then answers 202 straight away. Closing the
   * page cannot matter: the state lives in `publication_requests`.
   *
   * The executor calls `POST /publish/:id/approve` with its own service key; the
   * orchestrator reads `approval_requested_by` as the approver while the run is
   * live, so the record names the admin who clicked rather than the bot.
   * `/approve` is the contract for every executor, a terminal included: it also
   * takes the review's override in its body, and answers 403 origin_not_allowed
   * for an override sent with a cookie, and the 409s `request_blocked`,
   * `request_changed`, `override_inside_web_approval` and
   * `publication_review_not_clear`, besides the identifier screen's own
   * (see its docblock). The executor sends no override: its run rides on the
   * clicker's, recorded here before the dispatch.
   *
   * A cookie request must come from a NEMAR origin; a bearer key is not asked.
   *
   * Errors carry a stable code in `error` and a sentence in `message`:
   *   403 origin_not_allowed  a cookie request from a non-NEMAR origin
   *   404 not_found         no active request for the dataset, or it stopped
   *                         being one (published or denied) before the claim
   *   409 not_dispatchable  the newest active request is `blocked`
   *   409 already_in_flight a run is live (services/approval-dispatch.ts), a
   *                         failed run inside its short grace window included
   *   409 identifier_screen_not_clear  the request's identifier screen does not
   *                         allow approval (epic #1610 phase 4): not run, not
   *                         reported, findings, a review with no reason, or a
   *                         verdict about a commit `main` has moved past
   *   409 publication_review_not_clear  the publication review does not allow
   *                         approval (ADR 0102): the gate refuses before the claim, with
   *                         a `refusal` word and the review's words, and an override that
   *                         is recorded is recorded after the head check (below)
   *   400 invalid_body      the optional body is not `{ acknowledge_identifier_screen,
   *                         override_publication_review }`
   *   502 dispatch_failed   GitHub answered 4xx, or a token could not be
   *                         minted: nothing was sent, the claim is released
   *   502 dispatch_unconfigured  the Worker has no GitHub credential; retrying
   *                         cannot help; the claim is released
   *   502 dispatch_unconfirmed   the call to GitHub dropped, timed out or was
   *                         answered 5xx: it MAY have started, so the lease is
   *                         KEPT (a retry is a 409 until it lapses) and an
   *                         `approval_dispatch_unconfirmed` audit row is written
   */
  admin.post("/publish/:id/approve-dispatch", async (c) => {
    // A session cookie rides along with any cross-site request a browser can be
    // tricked into making, and this route launches an irreversible publication,
    // so every path but a bearer key must come from a NEMAR origin. A bearer key
    // cannot be forged cross-site and a terminal sends no Origin, so it is not
    // asked for one. Phrased as "not a token" rather than "is a cookie" so that
    // an unset `authMethod` fails closed. This is the cookie-only rule
    // `resolveActingAccount` and `/auth/orcid/cli-start` apply; the admin router
    // does not apply it to its routes in general, and this one should not wait
    // for that to change.
    if (c.get("authMethod") !== "token" && !isAllowedOrigin(c.req.header("Origin"))) {
      return c.json(
        {
          error: "origin_not_allowed",
          message: "This request did not come from a NEMAR page, so it was not accepted.",
        },
        403,
      );
    }

    const datasetId = c.req.param("id");
    const adminUser = c.get("user");
    const db = c.env.DB;

    // The body is optional; it carries an acknowledgment of the identifier
    // screen (epic #1610 phase 4) and the administrator's override of the
    // publication review (ADR 0102). No body, or none that parses as JSON, is
    // the bodyless click every existing caller sends.
    let acknowledgment: string | undefined;
    let override: z.infer<typeof publicationReviewOverrideSchema> | undefined;
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    if (rawBody !== undefined) {
      const parsed = dispatchBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          {
            error: "invalid_body",
            message: `The only fields this accepts are acknowledge_identifier_screen, a reason of ${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters, and override_publication_review, the review shown and the reasons shown.`,
          },
          400,
        );
      }
      acknowledgment = parsed.data.acknowledge_identifier_screen;
      override = parsed.data.override_publication_review;
    }

    const request = await db
      .prepare(
        `SELECT id, status, last_error, updated_at, identifier_screen_status,
                identifier_screen_report, identifier_screen_ack_at, identifier_screen_ack_by,
                steps_completed ${ACTIVE_REQUEST_TAIL_SQL}`,
      )
      .bind(datasetId)
      .first<{
        id: number;
        status: string;
        last_error: string | null;
        updated_at: string;
        identifier_screen_status: string | null;
        identifier_screen_report: string | null;
        identifier_screen_ack_at: string | null;
        identifier_screen_ack_by: number | null;
        steps_completed: string | null;
      }>();

    if (!request) {
      return c.json({ error: "not_found", message: "No active publication request found" }, 404);
    }
    if (request.status === "blocked") {
      return c.json(
        {
          error: "not_dispatchable",
          message:
            "This request is blocked. Resolve the block before dispatching an approval, or approve it from a terminal.",
        },
        409,
      );
    }

    // A request already `approving` has done part of the work, and some of it
    // cannot be undone: it resumes, it does not start over.
    const resume = request.status === "approving";

    // The identifier screen gate (ADR 0086), by the orchestrator's own rule: it
    // is skipped only for a run that has already started publishing. A run that
    // stopped before that (a failed ci_check leaves the row `approving`) is
    // gated like a fresh one, because the depositor may have pushed since.
    // A blocked request never gets here (refused above), so the reason is not asked.
    const gated = publishingStanding({ ...request, block_reason: null }) !== "publishing";

    // The state half: no network and no claim, so a refused click changes
    // nothing. The head half needs a GitHub token and runs once one is in hand,
    // below. A reason recorded earlier counts only for the admin who gave it.
    let review: ReviewGateResult = { ok: true, state: "off" };
    if (gated) {
      const stateGate = screenStateGate(
        datasetId,
        request,
        acknowledgment !== undefined,
        adminUser.id,
      );
      if (!stateGate.ok) return c.json(stateGate.refusal, 409);
      // The publication review's gate (ADR 0102) is asked next, still before the
      // claim, so a refusal claims nothing and changes nothing. It reads no GitHub
      // and writes nothing: only the OVERRIDE it says to record waits, until the head
      // check below has passed, so it is recorded last, only after every gate has passed.
      // (The screen's acknowledgment is recorded when the screen gate passes,
      // on its own, and stands whether or not the review then refuses.)
      // `requireRow`: the executor that follows reads the clicker's override off the
      // review row, so an override with no row to hold it cannot be carried.
      review = await evaluateApprovalReviewGate(c.env, {
        requestId: request.id,
        datasetId,
        approverId: adminUser.id,
        override,
        requireRow: true,
      });
      if (!review.ok) return c.json(review.body, 409);
    }

    // One conditional UPDATE is the claim: D1 runs it atomically, so two
    // simultaneous clicks cannot both see the row idle. `updated_at` is left
    // alone on purpose. It is the orchestrator's progress heartbeat, and
    // bumping it here would make a failed dispatch read as a live run for the
    // whole lease on an `approving` row.
    //
    // `last_error` is cleared: a new attempt begins, and the previous attempt's
    // error is history. It has to be cleared HERE and not only when `/approve`
    // starts, because a failed run's error would otherwise sit on the row
    // between the claim and the executor's first call, and the predicate would
    // read the freshly dispatched run as failed and let a second click through.
    // The release below puts it back if nothing was sent.
    const claim = await db
      .prepare(
        `UPDATE publication_requests
           SET approval_requested_by = ?, approval_dispatched_at = datetime('now'),
               last_error = NULL
         WHERE id = ? AND status IN ('requested', 'approving') AND NOT ${approvalInFlightSql()}`,
      )
      .bind(adminUser.id, request.id)
      .run();

    if (claim.meta.changes !== 1) {
      // The claim refuses for two different reasons, and the page must be told
      // the true one. A run may be live (the lease), or the request may have
      // stopped being one that can run in the moments since it was read here:
      // approved by someone else, denied, or blocked. "Already running" for a
      // request that is already published would send the admin looking for a
      // run that does not exist.
      const now = await db
        .prepare("SELECT status FROM publication_requests WHERE id = ?")
        .bind(request.id)
        .first<{ status: string }>();
      if (!now || now.status === "published" || now.status === "denied") {
        return c.json({ error: "not_found", message: "No active publication request found" }, 404);
      }
      if (now.status === "blocked") {
        return c.json(
          {
            error: "not_dispatchable",
            message:
              "This request is blocked. Resolve the block before dispatching an approval, or approve it from a terminal.",
          },
          409,
        );
      }
      return c.json(
        {
          error: "already_in_flight",
          message: "An approval is already running for this dataset.",
        },
        409,
      );
    }

    const environment = approvalDispatchEnvironment(c.env);

    // Release the claim so the admin can try again at once rather than wait out
    // the lease. Only ever done for a failure that is DEFINITELY "not sent", so
    // the row goes back to how it was. `AND approval_requested_by = ?` makes it
    // clear only a claim this click made. The error the claim cleared is
    // restored only while `updated_at` still holds the value read before the
    // claim: `/approve` bumps it as it starts, so a changed `updated_at` means a
    // run began in the meantime (a person's terminal), and restoring the old
    // error over its fresh state would make that live run read as failed after
    // the grace window. If even the release fails the lease lapses by itself,
    // which errs toward refusing a retry, never toward a second run.
    const releaseClaim = async (): Promise<void> => {
      try {
        await db
          .prepare(
            `UPDATE publication_requests
               SET approval_requested_by = NULL, approval_dispatched_at = NULL,
                   last_error = CASE WHEN updated_at = ? THEN COALESCE(last_error, ?)
                                     ELSE last_error END
             WHERE id = ? AND approval_requested_by = ?`,
          )
          .bind(request.updated_at, request.last_error, request.id, adminUser.id)
          .run();
      } catch (releaseErr) {
        console.error(
          `[approve-dispatch] could not release the claim on request ${request.id}:`,
          errorMessage(releaseErr),
        );
      }
    };

    // 1. A credential. Absent entirely is a configuration fault that retrying
    // cannot fix, so it has its own code; failing to MINT one (an App token
    // request GitHub refused) is transient and is an ordinary failed dispatch.
    // Neither sent anything, so both release.
    let auth: ReturnType<typeof getDatasetsAuth>;
    try {
      auth = getDatasetsAuth(c.env);
    } catch (err) {
      console.error(`[approve-dispatch] no GitHub credential for ${datasetId}:`, errorMessage(err));
      await releaseClaim();
      return c.json(
        {
          error: "dispatch_unconfigured",
          message:
            "This server has no GitHub credential configured, so an approval cannot be dispatched from the web. Retrying will not help. Approve from a terminal, and ask an administrator to fix the configuration.",
        },
        502,
      );
    }
    let pat: string;
    try {
      pat = auth.kind === "app" ? await auth.getToken() : auth.token;
    } catch (err) {
      console.error(
        `[approve-dispatch] could not obtain a GitHub token for ${datasetId}:`,
        errorMessage(err),
      );
      await releaseClaim();
      return c.json(
        {
          error: "dispatch_failed",
          message: "The approval could not be started. Nothing was changed; try again.",
        },
        502,
      );
    }

    // The identifier screen, content half (epic #1610 phase 4): the screened
    // commit must still be `main`, and a lookup that fails refuses (fail
    // closed). Nothing has been sent, so a refusal releases the claim. A
    // reason given for a screen that needs one is recorded only once this has
    // passed, so it attaches to the verdict the admin was shown.
    if (gated) {
      const headGate = await verifyScreenHead(c.env, datasetId, request, pat);
      if (!headGate.ok) {
        await releaseClaim();
        return c.json(headGate.refusal, 409);
      }
      if (
        acknowledgment !== undefined &&
        screenGate(readStoredState(request.identifier_screen_status)) === "acknowledge"
      ) {
        const recorded = await recordScreenAcknowledgment(db, {
          requestId: request.id,
          datasetId,
          adminUserId: adminUser.id,
          reason: acknowledgment,
          state: request.identifier_screen_status as string,
        });
        if (!recorded) {
          await releaseClaim();
          return c.json(
            {
              error: "identifier_screen_not_clear",
              gate: "wait",
              headline: "Identifier screen: changed",
              message:
                "The identifier screen's result changed while this approval was being checked. Read it again before approving.",
            },
            409,
          );
        }
      }
      // The override the review gate asked to record, last, now that the screened commit
      // is still `main`: it attaches to content that is still the content being published,
      // and is recorded only after every gate has passed. It can remain on its row, bound to
      // that review, those reasons and its approver, when the dispatch then fails or goes
      // unconfirmed. The screen's acknowledgment above was recorded when its own check passed
      // and does not depend on this one. Still before the dispatch, so the executor's run
      // finds it on the row. A row that moved since the gate read it refuses, and nothing has
      // been sent.
      if (review.ok && review.state === "enforced" && review.record !== null) {
        const recorded = await recordApprovalOverride(c.env, {
          requestId: request.id,
          datasetId,
          approverId: adminUser.id,
          via: "approve-dispatch",
          outcome: review.outcome,
          headSha: review.headSha,
          record: review.record,
        });
        if (!recorded.ok) {
          await releaseClaim();
          return c.json(recorded.body, 409);
        }
      }
    }

    // The audit row for this click's dispatch. A missing row must never change
    // what the admin is told about a run, so a failed write is only logged.
    const audit = async (action: string, extra: Record<string, unknown> = {}): Promise<void> => {
      try {
        await auditLogStatement(db, {
          userId: adminUser.id,
          action,
          resourceType: "dataset",
          resourceId: datasetId,
          details: JSON.stringify({ request_id: request.id, resume, environment, ...extra }),
        }).run();
      } catch (auditErr) {
        console.error(
          `[approve-dispatch] audit write failed (${action}) for ${datasetId}:`,
          errorMessage(auditErr),
        );
      }
    };

    // 2. The dispatch itself. GitHub refusing the request (a 4xx) means nothing
    // was sent: release. Anything else means UNKNOWN: a dropped connection, a
    // timeout, or a 5xx from GitHub's edge, any of which can follow an event that
    // was already queued. Releasing then would let the next click start a second
    // run beside it. KEEP the lease; it lapses on its own if nothing started, and
    // the audit row records that a run may exist that the lease alone would not
    // explain.
    try {
      await triggerApprovePublication(datasetId, request.id, resume, environment, pat);
    } catch (err) {
      console.error(`[approve-dispatch] dispatch failed for ${datasetId}:`, errorMessage(err));
      if (err instanceof DispatchRejectedError && err.definitelyNotSent) {
        await releaseClaim();
        return c.json(
          {
            error: "dispatch_failed",
            message: "The approval could not be started. Nothing was changed; try again.",
          },
          502,
        );
      }
      await audit("approval_dispatch_unconfirmed", {
        // The status only: never GitHub's body, which the error text carries.
        reason: err instanceof DispatchRejectedError ? `http_${err.httpStatus}` : "no_answer",
      });
      return c.json(
        {
          error: "dispatch_unconfirmed",
          message:
            "GitHub did not confirm the request. It may have started; check again in a few minutes before trying again.",
        },
        502,
      );
    }

    // The run is already launched; a missing audit row must not report the
    // launch as failed (`audit` only logs).
    await audit("approval_dispatched");

    return c.json(
      { status: "dispatched", dataset_id: datasetId, request_id: request.id, resume },
      202,
    );
  });

  /**
   * POST /admin/publish/:id/identifier-screen - Re-run the identifier screen
   * of the dataset's active request (epic #1610, phase 4).
   *
   * For a screen that did not run, did not report, or read a commit `main`
   * has since moved past: the approval gate refuses all three and names this
   * route. Same dispatch and failure handling as a new request, so the admins
   * are mailed when it reports, or at once when it cannot start. Every screen
   * column is reset in the claim, an earlier acknowledgment included.
   *
   *   202 { status: "pending" | "error", identifier_screen }
   *   400 identifier_screen_not_applicable  a sandbox (xx) dataset
   *   404 not_found             no active request
   *   403 origin_not_allowed    a cookie request from a non-NEMAR origin
   *   409 approval_in_progress  the request's approval has started publishing;
   *                             it passed the screen when it started
   *   409 identifier_screen_pending  a screen dispatched under
   *                             SCREEN_REPORT_DEADLINE_MINUTES ago has not reported
   */
  admin.post("/publish/:id/identifier-screen", async (c) => {
    // The same origin rule approve-dispatch applies: a session cookie rides
    // along with a cross-site request, so anything but a bearer key must come
    // from a NEMAR page.
    if (c.get("authMethod") !== "token" && !isAllowedOrigin(c.req.header("Origin"))) {
      return c.json(
        {
          error: "origin_not_allowed",
          message: "This request did not come from a NEMAR page, so it was not accepted.",
        },
        403,
      );
    }
    const datasetId = c.req.param("id");
    const adminUser = c.get("user");
    const db = c.env.DB;

    if (isScreenExempt(datasetId)) {
      return c.json(
        {
          error: "identifier_screen_not_applicable",
          message: "Sandbox (xx) datasets never publish real data and are not screened.",
        },
        400,
      );
    }
    const request = await db
      .prepare(`SELECT id, status, steps_completed ${ACTIVE_REQUEST_TAIL_SQL}`)
      .bind(datasetId)
      .first<{ id: number; status: string; steps_completed: string | null }>();
    if (!request) {
      return c.json({ error: "not_found", message: "No active publication request found" }, 404);
    }
    if (request.status === "approving" && hasStartedPublishing(request.steps_completed)) {
      return c.json(APPROVAL_IN_PROGRESS, 409);
    }
    const dataset = await db
      .prepare("SELECT github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ github_repo: string | null }>();

    let started: Awaited<ReturnType<typeof startIdentifierScreen>>;
    try {
      started = await startIdentifierScreen(
        c.env,
        { requestId: request.id, datasetId, githubRepo: dataset?.github_repo ?? null },
        RERUN_GUARD_SQL,
      );
    } catch (err) {
      console.error(`[identifier-screen] re-run for ${datasetId} failed:`, errorMessage(err));
      return c.json(
        {
          error: "identifier_screen_rerun_failed",
          message: "The screen could not be started: the database refused the write. Try again.",
        },
        500,
      );
    }
    if (started === null) {
      // The claim's guard refused. It has two halves, and the admin must be told
      // the true one: the request may have stopped being active (or started
      // publishing) since it was read, or a recent screen is still running.
      const now = await db
        .prepare("SELECT status, steps_completed FROM publication_requests WHERE id = ?")
        .bind(request.id)
        .first<{ status: string; steps_completed: string | null }>();
      if (!now || !["requested", "blocked", "approving"].includes(now.status)) {
        return c.json({ error: "not_found", message: "No active publication request found" }, 404);
      }
      if (now.status === "approving" && hasStartedPublishing(now.steps_completed)) {
        return c.json(APPROVAL_IN_PROGRESS, 409);
      }
      return c.json(
        {
          error: "identifier_screen_pending",
          message: `A screen of this request was dispatched less than ${SCREEN_REPORT_DEADLINE_MINUTES} minutes ago and has not reported yet. The admins are mailed when it does; if it never does, it is marked unreported and can be re-run then.`,
        },
        409,
      );
    }
    if (started.kind === "failed") {
      await notifyAdminsOfScreen(c.env, request.id);
    }
    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "identifier_screen_rerun",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ request_id: request.id, outcome: started.kind }),
      }).run();
    } catch (auditErr) {
      console.error(
        `[identifier-screen] audit write for the re-run of ${datasetId} failed:`,
        errorMessage(auditErr),
      );
    }

    const row = await db
      .prepare(
        "SELECT identifier_screen_status, identifier_screen_report FROM publication_requests WHERE id = ?",
      )
      .bind(request.id)
      .first<{
        identifier_screen_status: string | null;
        identifier_screen_report: string | null;
      }>();
    return c.json(
      {
        dataset_id: datasetId,
        request_id: request.id,
        status: started.kind === "dispatched" ? "pending" : "error",
        identifier_screen: screenView(
          datasetId,
          row?.identifier_screen_status,
          row?.identifier_screen_report,
        ),
      },
      202,
    );
  });

  /**
   * POST /admin/datasets/:id/s3-lock - Apply S3 Object Lock to dataset
   *
   * Streamed via S3 ListObjectsV2 continuation tokens — see
   * `applyObjectLockBatch` for the per-invocation subrequest contract.
   */
  admin.post("/datasets/:id/s3-lock", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const body = (await c.req.json().catch(() => ({}))) as { continuation_token?: string };

    const dataset = await db
      .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    try {
      const result = await applyObjectLockBatch(
        getS3Config(c.env),
        datasetId,
        body.continuation_token,
      );

      return c.json({
        message: result.failed.length === 0 ? "Batch locked" : "Some objects failed",
        dataset_id: datasetId,
        locked: result.locked,
        failed: result.failed.map((f) => ({ key: f.key, error: f.error })),
        hasMore: result.hasMore,
        continuation_token: result.nextContinuationToken,
      });
    } catch (err) {
      const msg = errorMessage(err);
      return c.json({ error: `S3 lock failed: ${msg}` }, 500);
    }
  });
}
