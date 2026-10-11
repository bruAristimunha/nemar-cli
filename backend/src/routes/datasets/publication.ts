/**
 * User-facing publication workflow: publish request/status/resend, CI status,
 * and POST /:id/publish (make-public). The make-public route physically sat
 * after the Version Manifests section in the monolith; it is registered with
 * its concern group here (all cross-file same-method paths are structurally
 * disjoint, and the route-inventory pin is unordered).
 *
 * Moved verbatim from routes/datasets.ts (#906, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import {
  CI_CHECK_UNAVAILABLE_CODE,
  type PublicationBlockReason,
  isCiPendingReason,
} from "../../../../shared/contract/publication.js";
import { publicationRequestNotice } from "../../../../shared/identifier-screen-report.js";
import { authMiddleware } from "../../middleware/auth";
import {
  FIRST_PUBLICATION_STAMP_SQL,
  expectedRepoVisibility,
  hasEverBeenPublished,
  isAnonymous,
} from "../../services/anonymity";
import { isValidDatasetId } from "../../services/datasetId";
import { isExemplarPublishAllowed } from "../../services/exemplar";
import {
  checkWorkflowExists,
  deployWorkflows,
  ensureRepoToSpec,
  getWorkflowRuns,
  setRepoVisibility,
  signPrescreenCallbackToken,
  triggerPrescreenRun,
} from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import {
  RESET_SCREEN_COLUMNS_SQL,
  type ScreenView,
  mailPublicationRequest,
  screenEmailSection,
  screenView,
  startScreenAndNotify,
} from "../../services/identifier-screen";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "../../services/repo-spec";
import { markDatasetPrivate, markDatasetPublic } from "../../services/s3";
import { checkSubmissionGate } from "../../services/submission-gate";
import { SUBMISSION_POLICY_URL } from "../../services/submission-minimums";
import {
  OWNER_NAME_MISSING_MESSAGE,
  OWNER_NAME_MISSING_REASON,
  requiresUploaderName,
  resolveOwnerIdentity,
} from "../../services/uploader-identity";
import { hasRole } from "../../types/bindings";
import { extractRepoName } from "./shared";
import type { DatasetsRouter } from "./shared";

/**
 * What a depositor is told when the BIDS-validation readiness check could not
 * run at all (token, workflow deploy, GitHub outage). Not a block reason: see
 * the 503 below.
 */
const CI_CHECK_UNAVAILABLE_MESSAGE =
  "NEMAR could not check BIDS validation status right now (a temporary GitHub or credential problem). Your request is recorded; try again later or contact an administrator.";

/**
 * User-facing message for each publication block reason.
 *
 * Keyed by the shared vocabulary (`PublicationBlockReason`) so a reason added
 * to the contract without a message here is a type error, not a silent
 * fallback to the generic sentence. Reads go through `blockMessage`, which
 * takes the free-TEXT column value (legacy rows exist) and degrades to a
 * generic sentence for anything it does not recognise.
 */
const BLOCK_MESSAGES: Record<PublicationBlockReason, string> = {
  bids_validation_failed:
    "BIDS validation is failing on your dataset. Please check the repository CI and fix validation errors, then re-request publication.",
  bids_validation_pending:
    "BIDS validation has not run yet. Your request is recorded and continues automatically once validation passes.",
  // "BIDS validation is currently running" is matched as a substring by two
  // CLI loops that wait out this refusal (src/lib/exemplar-clone.ts and
  // src/lib/import-openneuro.ts); the rest of the sentence is free to change.
  bids_validation_in_progress:
    "BIDS validation is currently running. Your request is recorded and continues automatically once validation passes.",
  // Legacy only: the pre-screen no longer blocks (#756), so new rows never get
  // this block_reason. Kept (without the now-removed repo-issue reference) so a
  // pre-deploy 'blocked' row still renders a sensible message until re-request.
  prescreen_failed:
    "The automated pre-screen flagged missing publication essentials (data, README, or dataset_description). Address the gaps and re-request publication; the pre-screen now runs as a non-blocking advisory.",
  // No policy URL in the message: the response carries policy_url separately
  // and the CLI renders it once, alongside the itemized reasons.
  min_requirements_failed:
    "The dataset does not meet the minimum submission requirements. Fix the stated items and re-request publication.",
  // #1255: DOIs cite the uploader by real name, so an owner with no
  // given_name/family_name cannot be attributed at all. The message is the
  // one place a user is told how to supply it, so it lives with the reason.
  [OWNER_NAME_MISSING_REASON]: OWNER_NAME_MISSING_MESSAGE,
  // Epic #1610 phase 4. The counts are on the status view's
  // `identifier_screen`; the message says where to look and what clears it.
  identifier_screen_findings:
    "The identifier screen found information that identifies a participant (a name, birth date or record number, for example in EDF/BDF headers or sidecar files). Remove it, push the change, and request publication again; that re-runs the screen. The kinds and counts it found are listed under the identifier screen below.",
};

/**
 * Message for a stored block_reason, or a generic one for an unknown value.
 *
 * `Object.hasOwn`, not a bare index. `block_reason` is a free-TEXT column, so
 * the lookup key is whatever is in the database -- and a plain index on an
 * object literal also finds `Object.prototype`'s members, so a row reading
 * `constructor` or `toString` would return a FUNCTION where the caller expects
 * a sentence. `??` cannot rescue that: the value is not nullish. The website's
 * own copy of this table caught it in their tests (nemarOrg/website#306).
 */
function blockMessage(reason: string | null | undefined): string {
  const key = reason ?? "";
  if (Object.hasOwn(BLOCK_MESSAGES, key)) {
    return (BLOCK_MESSAGES as Record<string, string>)[key];
  }
  return "Publication request blocked.";
}

export function registerPublicationRoutes(datasetRoutes: DatasetsRouter): void {
  // ============================================================================
  // Publication Workflow (User-facing)
  // ============================================================================

  /**
   * POST /datasets/:id/publish/request - Request publication of a dataset
   */
  datasetRoutes.post("/:id/publish/request", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    // #1408: `--anonymous` asks for a RELEASE rather than a publication. The
    // data goes public -- listed, browsable, downloadable -- while the
    // repository stays private, the DOI stays reserved with no curator, and
    // the depositor is withheld everywhere NEMAR writes them.
    //
    // Asked for here rather than at upload because the moment a depositor
    // wants concealment is the moment they want their data read; those are not
    // two decisions. It also means an anonymous release passes the same gates
    // a publication does -- BIDS validation, submission minimums, admin review
    // -- instead of being a side door around them.
    //
    // The body is optional: every existing caller posts no body at all, and a
    // malformed one must not turn a publication request into a 500.
    //
    // But ABSENT and PRESENT-BUT-NOT-`true` are different mistakes and must
    // not collapse into the same silent answer. `{"anonymous": "true"}` from a
    // form serializer, or `{"anonymous": 1}`, parses cleanly and would
    // otherwise be coerced to a normal publication -- concealment asked for,
    // attribution delivered, with output identical to a correct request. A key
    // that is present and not a JSON boolean is refused instead.
    let anonymousRequested = false;
    let anonymousMalformed = false;
    try {
      const raw: unknown = await c.req.json();
      if (typeof raw === "object" && raw !== null && "anonymous" in raw) {
        const value = (raw as { anonymous?: unknown }).anonymous;
        if (typeof value === "boolean") {
          anonymousRequested = value;
        } else {
          anonymousMalformed = true;
        }
      }
    } catch {
      // No body, or not JSON. Both mean a normal publication request.
    }
    if (anonymousMalformed) {
      return c.json(
        {
          error: "invalid_anonymous",
          message:
            '`anonymous` must be a JSON boolean. A depositor who asked to be concealed and was published under their own name because their client sent a string cannot be un-published, so this is refused rather than read as "no".',
        },
        400,
      );
    }

    // The owner's name columns ride along on the dataset lookup: publication
    // mints a DOI that cites the uploader by real name (#1255), so "does this
    // account have a citable name" is a precondition of the request, not a
    // detail discovered later at mint time.
    const dataset = await db
      .prepare(
        // `first_published_at` is here because `hasEverBeenPublished` reads it
        // below. It is NOT redundant with `visibility`: a dataset that was
        // public and has since been reverted keeps the stamp, and that is
        // exactly the row the anonymity guard has to catch.
        `SELECT d.id, d.dataset_id, d.owner_user_id, d.is_sandbox, d.is_exemplar,
                d.github_repo, d.visibility, d.source, d.anonymous, d.first_published_at,
                u.given_name as owner_given_name, u.family_name as owner_family_name
         FROM datasets d
         JOIN users u ON d.owner_user_id = u.id
         WHERE d.dataset_id = ?`,
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        owner_user_id: number;
        is_sandbox: number | null;
        is_exemplar: number | null;
        github_repo: string | null;
        visibility: string | null;
        source: string | null;
        anonymous: number | null;
        first_published_at: string | null;
        owner_given_name: string | null;
        owner_family_name: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only the dataset owner can request publication" }, 403);
    }

    // Block sandbox/xx, except staging exemplars (epic #923).
    if (
      (dataset.is_sandbox || dataset.dataset_id.startsWith("xx")) &&
      !isExemplarPublishAllowed(c.env, dataset)
    ) {
      return c.json({ error: "Cannot publish sandbox datasets" }, 400);
    }

    // #1408: an anonymous release is deliberately `visibility = 'public'` while
    // its depositor stays concealed, so "public" no longer means "published".
    // Taking it to mean that made de-anonymization unreachable: the normal
    // request IS how a blinded deposit gets published for real, and this guard
    // refused exactly the command the CLI tells the depositor to run.
    if (dataset.visibility === "public" && !isAnonymous(dataset)) {
      return c.json({ error: "Dataset is already published" }, 409);
    }
    if (isAnonymous(dataset) && dataset.visibility === "public" && anonymousRequested) {
      // Already released anonymously; asking again changes nothing. Said
      // plainly rather than queued, so the depositor is not left waiting on an
      // admin for a no-op.
      //
      // The `visibility === "public"` term matters (#1423): `anonymous = 1` is
      // not by itself evidence that a release HAPPENED. For a depositor it is,
      // because the release is what sets it -- but a row can also be CREATED
      // anonymous, which migration 0085 deliberately permits ("set at INSERT
      // rather than flipped afterwards, because this is the only moment it is
      // unconditionally legal"). Such a row is anonymous and PRIVATE: nothing
      // has been released, and the release is the only thing that makes it
      // public. Without this term such a row is told its release already
      // happened while it sits private and the data plane refuses to serve it.
      // This term outlived the fixture that exposed it (#1433): it is a
      // correctness fix about what `anonymous` means, not an accommodation,
      // and it changes nothing for a real deposit, whose `anonymous` and
      // `public` arrive together.
      return c.json(
        {
          error: "already_released_anonymously",
          message: `${datasetId} is already released as an anonymous deposit. To publish it for real, restore the real Authors in dataset_description.json and request publication again without --anonymous.`,
        },
        409,
      );
    }

    // Check for existing active request (allow re-checking blocked requests)
    const existing = await db
      .prepare(
        "SELECT id, status, block_reason FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked') ORDER BY requested_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ id: number; status: string; block_reason: string | null }>();

    if (existing && existing.status !== "blocked") {
      return c.json(
        {
          error: "A publication request already exists",
          status: existing.status,
          message:
            existing.status === "approving"
              ? "Publication is in progress"
              : "Use 'resend' to remind admins",
        },
        409,
      );
    }

    // For blocked requests, re-run readiness checks instead of creating a new one
    const requestId = existing?.id;

    // Run readiness checks: deploy CI if missing, check BIDS validation
    const repoName = dataset.github_repo?.split("/")[1];
    let blocked = false;
    let blockReason: string | null = null;
    const ciUrl = repoName ? `https://github.com/nemarDatasets/${repoName}/actions` : undefined;

    // Uploader-name precondition (#1255), checked FIRST: it is a property of
    // the account rather than of the dataset, it is the cheapest check here,
    // and reporting it before spending GitHub calls tells the user the one
    // thing they must fix in their profile before any dataset work matters.
    // OpenNeuro imports and exemplars are exempt (see requiresUploaderName),
    // the same pair the submission-minimums check below exempts.
    if (requiresUploaderName(dataset) && !resolveOwnerIdentity(dataset)) {
      blocked = true;
      blockReason = OWNER_NAME_MISSING_REASON;
    }

    // #1408: anonymity is not refused here, it is REQUESTED here. Phase 2
    // blocked every publication request from an anonymous dataset, which was
    // too blunt in both directions: it gave a depositor no way to reach the
    // anonymous state at all, and it made de-anonymizing impossible, since
    // the normal request is exactly how a blinded deposit gets published for
    // real.
    //
    // What enforces the ordering instead is ADR 0026's placeholder-author
    // check below, conditioned on this flag. An anonymous release EXEMPTS it
    // -- a blinded deposit legitimately has placeholder Authors, that is what
    // being blinded means -- and a normal publication ENFORCES it, so a
    // depositor cannot publish for real while still concealed. One gate, two
    // jobs, and the refusal names the fix.
    //
    // The ordering matters beyond tidiness: restoring attribution is a content
    // commit to the depositor's own `dataset_description.json`, and it has to
    // land while the repository is still private, because ADR 0001 makes
    // `main` pull-request-only once it is public.
    if (anonymousRequested && hasEverBeenPublished(dataset)) {
      // Not a block: a block invites a re-request, and this can never succeed.
      // The database would refuse the write anyway (migration 0085's
      // triggers); this turns that into a sentence.
      return c.json(
        {
          error: "already_published",
          message: `${datasetId} has already been published, so its depositor cannot be concealed now. Retracting an attribution that is already public is not something NEMAR can deliver.`,
        },
        409,
      );
    }

    // Resolve auth inside the try so a missing or unconfigured token blocks
    // the request the same way other CI infrastructure failures do, rather
    // than 500-ing the request before we've even recorded a row.
    let pat: string | null = null;
    // True when the readiness check itself could not run (token, workflow
    // deploy, GitHub outage), as opposed to running and finding no run yet.
    // The two share a block reason, and only the second has a GitHub that
    // answered, which the submission-minimums check below needs.
    let ciCheckFailed = false;
    if (repoName && !blocked) {
      try {
        pat = await getDatasetsToken(c.env);
        // Deploy CI workflows if missing
        const hasWorkflow = await checkWorkflowExists(
          repoName,
          ".github/workflows/bids-validation.yml",
          pat,
        );
        if (!hasWorkflow) {
          const deployResult = await deployWorkflows(repoName, pat);
          if (!deployResult.success) {
            throw new Error(
              `Failed to deploy CI workflows to ${repoName}: ${deployResult.errors.join("; ")}`,
            );
          }
        }

        // Check latest BIDS validation run
        const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
        if (runs.length === 0) {
          blocked = true;
          blockReason = "bids_validation_pending";
        } else if (runs[0].conclusion === "failure") {
          blocked = true;
          blockReason = "bids_validation_failed";
        } else if (runs[0].conclusion === null) {
          blocked = true;
          blockReason = "bids_validation_in_progress";
        }
      } catch (err) {
        // CI infrastructure failure (GitHub API outage, PAT expired, auth
        // misconfig, etc.). Block the request so it can be retried rather
        // than bypassing validation.
        console.error(
          `[publish-request] CI readiness check failed for ${datasetId}:`,
          err instanceof Error ? err.message : err,
        );
        blocked = true;
        blockReason = "bids_validation_pending";
        ciCheckFailed = true;
      }
    } else if (!repoName) {
      console.warn(`[publish-request] Skipping CI checks for ${datasetId}: no GitHub repo`);
    }

    // Submission minimums (#1087, ADR 0026) and the anonymity blind check (ADR
    // 0065). The rules, their exemptions and what an unreadable file means are
    // in `checkSubmissionGate`, which the sweep that later moves a blocked
    // request on calls too.
    //
    // It runs when nothing blocks the request AND when the only block is that
    // CI has not finished. The second case is the common one (a request made
    // right after an upload), and without it a missing minimum would be hidden
    // behind "pending" and found, if at all, only after the sweep had released
    // the request. It does not run when CI failed, when the owner has no name,
    // or when the readiness check itself could not run: the first two already
    // have a fix to make, and the last has nothing trustworthy to read with.
    // A missing minimum replaces the pending reason, so the depositor is told
    // at once and the verdict is re-recorded on every request.
    const ciOnlyPending = blocked && !ciCheckFailed && isCiPendingReason(blockReason);
    let minReasons: string[] | null = null;
    if (!blocked || ciOnlyPending) {
      const gate = await checkSubmissionGate({
        datasetId,
        repoName,
        pat,
        dataset,
        anonymous: anonymousRequested,
        caller: "publish-request",
      });
      // An anonymous release is never granted on a blind nobody verified, so
      // for it "could not verify" blocks like a failure. A native submission
      // that could not be read goes on to the admin review (ADR 0026): the CI
      // check just proved GitHub reachable, so a later hiccup is not worth a
      // spurious block.
      if (gate.kind === "blocked" || (gate.kind === "unverified" && anonymousRequested)) {
        blocked = true;
        blockReason = "min_requirements_failed";
        minReasons = gate.reasons;
      }
    }

    let prId: number | null = requestId ?? null;
    if (requestId) {
      // Update existing blocked request
      if (blocked) {
        // Persist the itemized minimums reasons (migration 0068) so the later
        // /publish/status view stays as specific as this rejection; NULL for
        // CI blocks, and stale reasons from a prior minimums block are
        // overwritten either way.
        //
        // The identifier screen is reset here too (epic #1610 phase 4): the
        // depositor may have changed the data since the last screen, and a
        // result left on a blocked row would be read as current once the row
        // is unblocked by anything other than a re-request.
        await db
          .prepare(
            `UPDATE publication_requests SET status = 'blocked', block_reason = ?, min_requirements_reasons = ?, anonymous = ?, ${RESET_SCREEN_COLUMNS_SQL}, updated_at = datetime('now') WHERE id = ?`,
          )
          .bind(
            blockReason,
            minReasons ? JSON.stringify(minReasons) : null,
            anonymousRequested ? 1 : 0,
            requestId,
          )
          .run();
      } else {
        // Unblock: transition to requested. Also clear any prior pre-screen
        // state so a re-request gets a clean screen (and a disabled-feature
        // re-request doesn't leave a stale 'failed'/nonce on a 'requested' row).
        //
        // Every identifier-screen column is reset in this SAME statement
        // (epic #1610 phase 4): a re-request is new content, so a stale 'clean',
        // an old acknowledgment or an old email claim must never carry over to
        // it. The screen is dispatched afresh below.
        await db
          .prepare(
            // `anonymous` is re-stated rather than left alone: a depositor who
            // re-requests WITHOUT the flag is asking for a normal publication,
            // and a stale 1 here would silently give them an anonymous release
            // instead -- the one mistake this flow must not make quietly.
            `UPDATE publication_requests SET status = 'requested', block_reason = NULL, min_requirements_reasons = NULL, prescreen_status = NULL, prescreen_nonce = NULL, prescreen_issue_url = NULL, prescreen_reasons = NULL, ${RESET_SCREEN_COLUMNS_SQL}, anonymous = ?, updated_at = datetime('now') WHERE id = ?`,
          )
          .bind(anonymousRequested ? 1 : 0, requestId)
          .run();
      }
    } else {
      // Create new publication request
      const inserted = await db
        .prepare(
          "INSERT INTO publication_requests (dataset_id, requested_by, status, block_reason, min_requirements_reasons, anonymous) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(
          datasetId,
          currentUser.id,
          blocked ? "blocked" : "requested",
          blockReason,
          minReasons ? JSON.stringify(minReasons) : null,
          anonymousRequested ? 1 : 0,
        )
        .first<{ id: number }>();
      prId = inserted?.id ?? null;
      if (prId === null) {
        console.warn(
          `[publish-request] INSERT ... RETURNING id returned no id for ${datasetId}; pre-screen will not run`,
        );
      }
    }

    // The row above is written either way, so "recorded" is true. What is not
    // known is that anything will carry it on. The sweep reads the run list
    // with the same credential, so it recovers when GitHub does, but it does
    // not deploy the workflow: a request recorded because the deploy failed
    // waits for a run nothing starts. A depositor told "pending, continues on
    // its own" by a 422 would be promised a transition that may not come, so
    // this is answered as the temporary fault it is, with no block reason (the
    // reason vocabulary is shared with the website and is deliberately not
    // extended here). The CLI prints the message and exits 1. The row carries
    // the pending reason, so `publish status` still shows it as waiting on
    // validation; telling the two apart would take a stored marker.
    if (ciCheckFailed) {
      return c.json(
        {
          error: CI_CHECK_UNAVAILABLE_CODE,
          message: CI_CHECK_UNAVAILABLE_MESSAGE,
          dataset_id: datasetId,
          anonymous: anonymousRequested,
          ci_url: ciUrl,
        },
        503,
      );
    }

    if (blocked) {
      return c.json(
        {
          status: "blocked",
          block_reason: blockReason,
          message: blockMessage(blockReason),
          dataset_id: datasetId,
          anonymous: anonymousRequested,
          ci_url: ciUrl,
          // Specific, user-facing failures from the minimums check, mirrored
          // under `details` because the CLI's ApiError only carries that field.
          ...(minReasons
            ? {
                reasons: minReasons,
                policy_url: SUBMISSION_POLICY_URL,
                details: { reasons: minReasons, policy_url: SUBMISSION_POLICY_URL },
              }
            : {}),
        },
        422,
      );
    }

    // Dispatch the automated pre-screen (issue #666). Async + feature-flagged:
    // the request is already 'requested', so a dispatch failure must not 500
    // the call -- we log it and leave the row as a normal pending request.
    // The verdict arrives later at /webhooks/prescreen-result.
    if (
      prId !== null &&
      repoName &&
      pat &&
      c.env.PRESCREEN_ENABLED === "true" &&
      c.env.PRESCREEN_CALLBACK_SECRET
    ) {
      try {
        const nonce = crypto.randomUUID();
        const callbackToken = await signPrescreenCallbackToken(
          { datasetId, requestId: prId, nonce },
          c.env.PRESCREEN_CALLBACK_SECRET,
        );
        await db
          .prepare(
            "UPDATE publication_requests SET prescreen_status = 'pending', prescreen_nonce = ?, prescreen_issue_url = NULL, prescreen_reasons = NULL, prescreen_at = NULL, updated_at = datetime('now') WHERE id = ?",
          )
          .bind(nonce, prId)
          .run();
        await triggerPrescreenRun(
          datasetId,
          "main",
          prId,
          callbackToken,
          `${c.env.API_BASE_URL}/webhooks/prescreen-result`,
          pat,
        );
      } catch (err) {
        console.error(
          `[publish-request] prescreen dispatch failed for ${datasetId} (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
        // Don't strand the row in 'pending' with no workflow behind it.
        try {
          await db
            .prepare(
              "UPDATE publication_requests SET prescreen_status = NULL, prescreen_nonce = NULL, prescreen_reasons = NULL WHERE id = ?",
            )
            .bind(prId)
            .run();
        } catch (resetErr) {
          console.error(`[publish-request] prescreen reset failed for ${datasetId}:`, resetErr);
        }
      }
    }

    // The identifier screen (epic #1610 phase 4) decides WHEN the admins are
    // mailed. A dispatched screen mails them when its report lands (the
    // callback, or the watchdog when it never does), stating the result. A
    // screen that could not be started is mailed NOW, saying so. A sandbox
    // exemplar is not screened and is mailed now, as before. Never gated on
    // PRESCREEN_ENABLED: the screen must not be silently switchable off.
    //
    // `startScreenAndNotify` never throws: a start that throws before anything
    // is recorded (a database error) is mailed there as NOT RUN.
    let screen: ScreenView;
    const started =
      prId === null
        ? null
        : await startScreenAndNotify(c.env, {
            requestId: prId,
            datasetId,
            githubRepo: dataset.github_repo,
          });
    if (started === null || started.kind === "exempt") {
      // Exempt, or (prId null) a request the screen cannot be tied to: the
      // mail goes now, and the section says which ("not applicable (sandbox)"
      // for an exempt dataset, "NOT RUN" otherwise).
      try {
        await mailPublicationRequest(c.env, {
          datasetId,
          username: currentUser.username,
          anonymous: anonymousRequested,
          screen: screenEmailSection(datasetId, null, null),
        });
      } catch (mailError) {
        console.error(
          `[publish-request] admin mail failed for ${datasetId}:`,
          mailError instanceof Error ? mailError.message : mailError,
        );
      }
    }
    if (prId !== null) {
      const row = await db
        .prepare(
          "SELECT identifier_screen_status, identifier_screen_report FROM publication_requests WHERE id = ?",
        )
        .bind(prId)
        .first<{
          identifier_screen_status: string | null;
          identifier_screen_report: string | null;
        }>();
      screen = screenView(datasetId, row?.identifier_screen_status, row?.identifier_screen_report);
    } else {
      screen = screenView(datasetId, null, null);
    }

    // The flag is ECHOED, not assumed. A depositor whose client lost it would
    // otherwise see a success message byte-identical to a correct request and
    // find out at approval, when the outcome is no longer theirs to change.
    // The CLI prints a different line for each value (`src/commands/dataset.ts`).
    //
    // `request_notice` is what an accepted request is told, from the one
    // definition the CLI prints (ADR 0090, amendment "what an accepted request is
    // told"). It is the
    // same neutral words for a new request and for a re-request of a blocked
    // one, and it never depends on `screen`: the screen has not reported, and
    // a result shown now could be stale by the time anyone acts on it. It is
    // on this response only. A request refused above (403, 404, 409, 422)
    // returned its own text and never reaches here.
    return c.json({
      message: anonymousRequested ? "Anonymous release requested" : "Publication request submitted",
      dataset_id: datasetId,
      status: "requested",
      anonymous: anonymousRequested,
      identifier_screen: screen,
      request_notice: publicationRequestNotice(datasetId),
    });
  });

  /**
   * GET /datasets/:id/publish/status - Get publication status
   */
  datasetRoutes.get("/:id/publish/status", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ id: number; owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only the dataset owner or admin can view publication status" }, 403);
    }

    const request = await db
      .prepare(
        `SELECT pr.*, u.username as requested_by_username, d.github_repo
         FROM publication_requests pr
         JOIN users u ON pr.requested_by = u.id
         JOIN datasets d ON pr.dataset_id = d.dataset_id
         WHERE pr.dataset_id = ?
         ORDER BY pr.requested_at DESC
         LIMIT 1`,
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        status: string;
        requested_at: string;
        requested_by_username: string;
        approved_at: string | null;
        denied_at: string | null;
        denied_reason: string | null;
        block_reason: string | null;
        min_requirements_reasons: string | null;
        prescreen_status: string | null;
        prescreen_reasons: string | null;
        prescreen_issue_url: string | null;
        steps_completed: string;
        current_step: string | null;
        last_error: string | null;
        updated_at: string;
        anonymous: number | null;
        github_repo: string | null;
        identifier_screen_status: string | null;
        identifier_screen_report: string | null;
      }>();

    if (!request) {
      return c.json({
        dataset_id: datasetId,
        status: "none",
        message: "No publication request found",
      });
    }

    const repoName = request.github_repo?.split("/")[1];

    // Pre-screen is advisory (#756): when it flagged a concern, surface it as a
    // non-blocking advisory (the request is NOT blocked by it). Real blockers keep
    // status='blocked' with a BLOCK_MESSAGE below.
    let prescreenAdvisory:
      | { source: "prescreen"; reasons: string[]; issue_url?: string }
      | undefined;
    if (request.prescreen_status === "concern") {
      let reasons: string[] = [];
      try {
        const parsed = JSON.parse(request.prescreen_reasons || "[]");
        if (Array.isArray(parsed)) reasons = parsed.filter((r) => typeof r === "string");
      } catch (err) {
        // malformed reasons JSON -> empty list (the advisory flag still shows)
        console.error(`[publish-status] malformed prescreen_reasons for ${datasetId}:`, err);
      }
      prescreenAdvisory = {
        source: "prescreen",
        reasons,
        ...(request.prescreen_issue_url ? { issue_url: request.prescreen_issue_url } : {}),
      };
    }

    // Persisted submission-minimums reasons (#1087, migration 0068): keep the
    // status view as specific as the original 422.
    let minReasons: string[] | undefined;
    if (request.block_reason === "min_requirements_failed" && request.min_requirements_reasons) {
      try {
        const parsed = JSON.parse(request.min_requirements_reasons);
        if (Array.isArray(parsed)) {
          minReasons = parsed.filter((r): r is string => typeof r === "string");
        }
      } catch (err) {
        console.error(`[publish-status] malformed min_requirements_reasons for ${datasetId}:`, err);
      }
    }

    return c.json({
      dataset_id: datasetId,
      status: request.status,
      requested_at: request.requested_at,
      requested_by: request.requested_by_username,
      approved_at: request.approved_at,
      denied_at: request.denied_at,
      denied_reason: request.denied_reason,
      block_reason: request.block_reason,
      // The explanation is gated on the STATUS only. It used to also require
      // a repo, which is right for the CI-shaped reasons that link to a
      // workflow run but wrong for a reason that has nothing to do with the
      // repository: owner_name_missing is a property of the ACCOUNT, and
      // withholding its message left the user a bare reason code with no way
      // to act on it (#1255 review item 24). `ci_url` stays repo-gated,
      // because without a repo there is no run to link.
      ...(request.status === "blocked"
        ? {
            message: blockMessage(request.block_reason),
            ...(repoName ? { ci_url: `https://github.com/nemarDatasets/${repoName}/actions` } : {}),
          }
        : {}),
      ...(minReasons?.length ? { reasons: minReasons, policy_url: SUBMISSION_POLICY_URL } : {}),
      ...(prescreenAdvisory ? { advisory: prescreenAdvisory } : {}),
      // #1408: the one place a depositor can confirm, before an admin acts,
      // that the release they asked for is the release that was recorded.
      // Without it the flag is write-only: nothing between `--anonymous` and
      // the published result reports which of the two runs is queued.
      anonymous: request.anonymous === 1,
      // Epic #1610 phase 4: the screen as describeScreen words it -- headline,
      // tone and count lines. Never the stored report, and never the nonce.
      identifier_screen: screenView(
        datasetId,
        request.identifier_screen_status,
        request.identifier_screen_report,
      ),
      steps_completed: JSON.parse(request.steps_completed || "[]"),
      current_step: request.current_step,
      last_error: request.last_error,
      updated_at: request.updated_at,
    });
  });

  /**
   * POST /datasets/:id/publish/resend - Resend publication request notification
   */
  datasetRoutes.post("/:id/publish/resend", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ id: number; owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only the dataset owner can resend notifications" }, 403);
    }

    const request = await db
      .prepare(
        // `anonymous` rides along so the reminder says the same thing the
        // original notification did: an admin reading only the resend must
        // not approve an anonymous release believing it is a publication.
        // The screen columns ride along so the reminder carries the result as
        // stored (epic #1610 phase 4).
        "SELECT id, status, updated_at, anonymous, identifier_screen_status, identifier_screen_report FROM publication_requests WHERE dataset_id = ? AND status = 'requested' ORDER BY requested_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{
        id: number;
        status: string;
        updated_at: string;
        anonymous: number | null;
        identifier_screen_status: string | null;
        identifier_screen_report: string | null;
      }>();

    if (!request) {
      return c.json({ error: "No pending publication request found" }, 404);
    }

    // While the screen runs there is nothing to remind the admins of: they
    // have not been mailed yet, and they will be when it finishes. Checked
    // before the cooldown so the depositor hears the real reason.
    if (request.identifier_screen_status === "pending") {
      return c.json(
        {
          error: "identifier_screen_pending",
          message:
            "The identifier screen is still running. The admins are mailed when it finishes, with its result, so there is nothing to resend yet.",
        },
        409,
      );
    }

    // Rate limit: 30 minutes between resends
    const lastUpdate = new Date(request.updated_at).getTime();
    const cooldownMs = 30 * 60 * 1000;
    if (Date.now() - lastUpdate < cooldownMs) {
      return c.json({ error: "Please wait before resending (30 min cooldown)" }, 429);
    }

    // Update timestamp for rate limiting
    await db
      .prepare("UPDATE publication_requests SET updated_at = datetime('now') WHERE id = ?")
      .bind(request.id)
      .run();

    // Resend notification to admins who have publication_request notifications
    // enabled, with the screen section as stored: a request that predates the
    // screen says "NOT RUN for this request", never nothing.
    try {
      const outcome = await mailPublicationRequest(c.env, {
        datasetId,
        username: currentUser.username,
        anonymous: request.anonymous === 1,
        screen: screenEmailSection(
          datasetId,
          request.identifier_screen_status,
          request.identifier_screen_report,
        ),
      });
      if (outcome.delivered > 0 && request.identifier_screen_status !== null) {
        // A result whose first mail was lost has now reached an admin, so the
        // watchdog must not send it a third time.
        await db
          .prepare(
            "UPDATE publication_requests SET identifier_screen_emailed_at = COALESCE(identifier_screen_emailed_at, datetime('now')) WHERE id = ?",
          )
          .bind(request.id)
          .run();
      }
    } catch (emailError) {
      console.error("Failed to resend publication notification:", emailError);
      return c.json(
        {
          error: "Failed to resend notification email",
          message:
            "The notification could not be sent. Please try again later or contact an administrator directly.",
        },
        500,
      );
    }

    return c.json({
      message: "Notification resent to admins",
      dataset_id: datasetId,
    });
  });

  /**
   * GET /datasets/:id/ci/status - Check CI status for a dataset (user-accessible)
   *
   * Returns CI workflow presence and latest run status.
   * Authenticated users can check any dataset they own or collaborate on.
   */
  datasetRoutes.get("/:id/ci/status", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const currentUser = c.get("user");

    const dataset = await db
      .prepare(
        `SELECT d.dataset_id, d.github_repo, u.username as owner_username
         FROM datasets d
         JOIN users u ON d.owner_user_id = u.id
         WHERE d.dataset_id = ?`,
      )
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null; owner_username: string }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Check ownership or admin status
    if (dataset.owner_username !== currentUser.username && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Access denied" }, 403);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = extractRepoName(dataset.github_repo);
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const pat = await getDatasetsToken(c.env);

    let bidsWorkflowExists = false;
    let latestRunStatus = "unknown";
    let latestRunUrl: string | null = null;

    try {
      bidsWorkflowExists = await checkWorkflowExists(
        repoName,
        ".github/workflows/bids-validation.yml",
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
      console.error(`[ci/status] GitHub API error for ${datasetId} (repo: ${repoName}):`, msg);
      return c.json({ error: `GitHub API error: ${msg}` }, 502);
    }

    return c.json({
      dataset_id: datasetId,
      bids_validation: {
        present: bidsWorkflowExists,
        status: bidsWorkflowExists ? latestRunStatus : "missing",
        url: latestRunUrl,
      },
    });
  });

  /**
   * POST /datasets/:id/publish - Publish a dataset (make public)
   *
   * Authorization: Admin only. Predates the orchestrated publication flow
   * (publish/request -> admin approval -> orchestrator); as a direct flip of
   * GitHub/S3/D1 visibility it skips DOI minting, manifest generation, and the
   * submission-minimums gate, so owners must go through publish/request instead.
   * One-way operation: Cannot unpublish
   *
   * Effects:
   * 1. Changes GitHub repo from private to public
   * 2. Updates S3 bucket policy for public read
   * 3. Sets visibility='public' in database
   * 4. Logs action in audit_log
   *
   * A break-glass admin tool: it does NOT pass the identifier screen gate a
   * publication approval does (ADR 0086 states the exception). Use the
   * publication request flow for a dataset that has not been screened.
   */
  datasetRoutes.post("/:id/publish", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const user = c.get("user");
    const db = c.env.DB;

    // Validate dataset ID format
    if (!isValidDatasetId(datasetId)) {
      return c.json({ error: "Invalid dataset ID" }, 400);
    }

    // Fetch dataset with ownership check
    const dataset = await db
      .prepare(`
        SELECT id, dataset_id, name, owner_user_id, github_repo, visibility, is_sandbox, anonymous
        FROM datasets
        WHERE dataset_id = ? AND status = 'active'
      `)
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        name: string;
        owner_user_id: number;
        github_repo: string | null;
        visibility: string;
        is_sandbox: number;
        anonymous: number | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Authorization: admin only. Owners must use the publication request flow
    // (POST /datasets/:id/publish/request), which routes through the orchestrator.
    if (!hasRole(user.role, "admin")) {
      return c.json(
        {
          error:
            "Forbidden: Only admins can publish directly. Use 'nemar dataset publish request' to request publication.",
        },
        403,
      );
    }

    // Prevent publishing sandbox datasets
    if (dataset.is_sandbox) {
      return c.json(
        {
          error: "Cannot publish sandbox datasets",
          message: "Sandbox datasets are for training only and cannot be made public",
        },
        400,
      );
    }

    // Already public (idempotent). An anonymous deposit is public too, so it
    // would take this branch and report success while its repository stayed
    // private and its depositor concealed (#1408) -- a 200 saying "already
    // public" to an admin who asked to publish it for real. Named instead.
    if (dataset.visibility === "public" && !isAnonymous(dataset)) {
      return c.json(
        {
          message: "Dataset is already public",
          dataset_id: datasetId,
        },
        200,
      );
    }
    if (isAnonymous(dataset)) {
      return c.json(
        {
          error: "anonymous_deposit",
          message: `${datasetId} is an anonymous deposit. Publishing it means ending anonymity, which restores attribution from the depositor's own dataset_description.json -- run it through the publication request flow so the author check and the enrichment pass both happen.`,
          dataset_id: datasetId,
        },
        409,
      );
    }

    // Validate GitHub repo exists
    if (!dataset.github_repo) {
      return c.json(
        {
          error: "Dataset has no GitHub repository",
          message: "Cannot publish a dataset without a repository",
        },
        400,
      );
    }

    // Extract repo name from full name (e.g., "nemarDatasets/nm000104" -> "nm000104")
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid GitHub repository format" }, 500);
    }

    // Step 1: Update GitHub repository visibility.
    //
    // This route REFUSES an anonymous deposit outright, 35 lines up (#1408:
    // ending anonymity has to restore attribution from the depositor's own
    // dataset_description.json, which only the publication-request flow does).
    // So `dataset.anonymous` is always 0 here and this always resolves to
    // public. The call is kept rather than replaced with a literal precisely
    // BECAUSE it is currently moot: `expectedRepoVisibility` is the one rule
    // for this field, and if that refusal is ever relaxed, the route stays
    // correct instead of silently publishing a concealed depositor's
    // repository. A literal `false` here would be the bug phase 3 found twice.
    const pat = await getDatasetsToken(c.env);
    const repoShouldBePrivate =
      expectedRepoVisibility({ visibility: "public", anonymous: dataset.anonymous }) === "private";
    const ghResult = await setRepoVisibility(repoName, repoShouldBePrivate, pat);
    if (!ghResult.ok) {
      console.error(`GitHub visibility update failed for ${datasetId}:`, ghResult.error);
      return c.json(
        {
          error: "Failed to update GitHub repository visibility",
          details: ghResult.error,
          dataset_id: datasetId,
        },
        500,
      );
    }

    // Step 2: Grant public read by removing the dataset's private carve-out
    try {
      await markDatasetPublic(
        {
          bucket: c.env.S3_BUCKET,
          region: c.env.AWS_REGION,
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        },
        datasetId,
      );
    } catch (s3Error) {
      const s3Msg = s3Error instanceof Error ? s3Error.message : String(s3Error);
      console.error(`S3 policy update failed for ${datasetId}:`, s3Msg);

      // Revert GitHub to private on S3 failure
      const revertResult = await setRepoVisibility(repoName, true, pat);
      if (revertResult.ok) {
        return c.json(
          {
            error: "Failed to update S3 bucket policy, reverted GitHub repository to private",
            details: s3Msg,
            dataset_id: datasetId,
          },
          500,
        );
      }

      return c.json(
        {
          error: "CRITICAL: S3 policy update failed AND GitHub revert failed",
          details: s3Msg,
          dataset_id: datasetId,
          github_visibility: "public",
          s3_public: false,
          revert_error: revertResult.error,
          action_required: `Manually revert GitHub repo to private OR manually add S3 public read policy for ${datasetId}`,
        },
        500,
      );
    }

    // Step 3: Update database
    try {
      await db
        .prepare(
          // The stamp rides along with the visibility flip: the triggers
          // refuse a row that is both anonymous and stamped, so it cannot be
          // a second statement, and an anonymous deposit goes public without
          // being attributed (the CASE in FIRST_PUBLICATION_STAMP_SQL).
          `UPDATE datasets SET visibility = 'public', ${FIRST_PUBLICATION_STAMP_SQL}, updated_at = datetime('now') WHERE id = ?`,
        )
        .bind(dataset.id)
        .run();
    } catch (dbError) {
      const dbMsg = dbError instanceof Error ? dbError.message : String(dbError);
      console.error(`Database update failed for ${datasetId}:`, dbMsg);

      // Revert both GitHub and S3 on database failure
      const ghRevertResult = await setRepoVisibility(repoName, true, pat);

      let s3Reverted = false;
      try {
        await markDatasetPrivate(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          },
          datasetId,
        );
        s3Reverted = true;
      } catch (s3RevertError) {
        console.error(`S3 policy revert failed for ${datasetId}:`, s3RevertError);
      }

      return c.json(
        {
          error: "CRITICAL: Database update failed, attempted rollback",
          details: dbMsg,
          dataset_id: datasetId,
          github_reverted: ghRevertResult.ok,
          s3_reverted: s3Reverted,
          action_required:
            ghRevertResult.ok && s3Reverted
              ? "Rollback successful, but database update failed. Contact administrator."
              : `Manually revert: ${!ghRevertResult.ok ? "GitHub repo to private" : ""} ${!s3Reverted ? "Remove S3 public read policy" : ""}`.trim(),
        },
        500,
      );
    }

    // Step 3.5: Enforce the published-repo spec (epic #713): lock main (branch +
    // tag ruleset, green-gated), deploy workflows, reconcile collaborators
    // (owner=maintain, ledger writers=push, strip stray read). Non-fatal: the
    // dataset is already public at GitHub/S3/D1; a failed step just means
    // protection may need a retry (surfaced in the response for visibility).
    let specEnforcement: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
    try {
      const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);
      specEnforcement = await ensureRepoToSpec(repoName, pat, {
        // From the same value the repository flip above used. This route
        // refuses an anonymous deposit outright, so the literal was correct
        // today -- but it is correct by a guard two hundred lines away rather
        // than by construction, and that is the shape of the bug the
        // orchestrator had.
        visibility: repoShouldBePrivate ? "private" : "public",
        collaborators: { ownerLogin, approvedWriters },
      });
    } catch (specError) {
      console.error(`Repo-spec enforcement failed for ${datasetId} (non-fatal):`, specError);
    }
    // Mirror reconcile removals into D1 (own try/catch; flags a divergence).
    await mirrorReconcileRemovals(db, datasetId, specEnforcement?.reconcile?.removed);

    // Step 4: Audit log
    await db
      .prepare(`
        INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(
        user.id,
        "dataset_publish",
        "dataset",
        datasetId,
        JSON.stringify({
          dataset_name: dataset.name,
          github_repo: dataset.github_repo,
        }),
      )
      .run();

    return c.json({
      success: true,
      message: "Dataset published successfully",
      dataset_id: datasetId,
      github_url: `https://github.com/${dataset.github_repo}`,
      s3_url: `https://${c.env.S3_BUCKET}.s3.${c.env.AWS_REGION}.amazonaws.com/${datasetId}/`,
      spec_enforcement: specEnforcement?.steps,
    });
  });
}
