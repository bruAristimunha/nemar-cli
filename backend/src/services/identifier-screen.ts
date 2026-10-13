/**
 * The identifier screen of a publication request (epic #1610, phase 4).
 *
 * When a depositor requests publication, the Worker hands the dataset to the
 * `run-identifier-screen` workflow on `nemarDatasets/.github`, which screens it
 * for identifying information (names, birth dates and record numbers in EDF/BDF
 * headers, identifying sidecar columns and keys, identifying file names) and
 * posts a report to `/webhooks/identifier-screen-result`. The admin's
 * publication-request email WAITS for that report and states it. While the
 * publication review is on (ADR 0102) it also waits for a review of the screened
 * commit that is in flight, and adds the review's section.
 *
 * Every way of not getting a report still reaches the admin, and says so:
 *   - the dispatch was impossible (no credential, callback secret, API base or
 *     repository): stored `error` / `dispatch-unconfigured`, mailed at once;
 *   - GitHub refused or the call failed: `error` / `dispatch-failed`, mailed at once;
 *   - the workflow posted an error, or a body outside the report contract:
 *     `error`, mailed when it lands;
 *   - the workflow never reported: GitHub answers a dispatch 204 even when no
 *     workflow listens for the event, so a 2xx proves nothing. The watchdog
 *     ({@link sweepIdentifierScreens}) turns a screen still pending after
 *     {@link SCREEN_REPORT_DEADLINE_MINUTES} into `unreported` and mails it.
 * Unknown is never healthy (ADR 0053): none of those is described, stored or
 * gated as clean (`screenGate` answers "rerun").
 *
 * **Nothing a workflow wrote reaches D1, an email, a log line or an API response
 * except through `parseScreenReport` and `describeScreen`**
 * (`shared/identifier-screen-report.ts`). The stored report is the parsed one,
 * re-serialized; a body that does not parse is replaced by a Worker-built error
 * report and only the parser's fixed error word is logged.
 *
 * The routes stay thin; this module owns the logic: starting a screen
 * ({@link startIdentifierScreen}), storing a result ({@link storeScreenResult}),
 * mailing it exactly once ({@link notifyAdminsOfScreen}), the watchdog, the
 * block on direct identifiers, and the approval gate ({@link checkApprovalScreenGate}).
 */

import {
  REPORT_VERSION,
  type ScreenDescription,
  type ScreenError,
  type ScreenGate,
  type ScreenReport,
  type ScreenState,
  describeScreen,
  parseScreenReport,
  screenGate,
  stateOf,
} from "../../../shared/identifier-screen-report.js";
import { PUBLICATION_STEPS } from "../../../shared/publication-steps.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import {
  type PublicationReviewSection,
  type PublicationScreenSection,
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendIdentifierScreenBlockedEmail,
  sendPublicationRequestEmail,
} from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsAuth } from "./github-auth.js";
import {
  getMainBranchSha,
  signIdentifierScreenCallbackToken,
  triggerIdentifierScreenRun,
} from "./github.js";
import { isScreenExempt, readStoredReport, readStoredState } from "./identifier-screen-stored.js";
import { reviewInFlightSql } from "./publication-review-rows.js";
import { publicationReviewEmailSection, reviewEnabled } from "./publication-review-view.js";

// The two readers of a stored screen, and the sandbox exemption, live in their own module so the
// publication review (ADR 0102) can use them without importing this one; re-exported for every
// existing importer.
export { isScreenExempt, readStoredReport, readStoredState };

/**
 * A screen still pending this long after its dispatch has not reported, and is
 * mailed as such. Above the workflow's own budget (a 35-minute script deadline
 * inside a 45-minute job, plus queueing and callback retries), so the watchdog
 * does not overtake a run that is merely slow. A report that arrives later still
 * lands: marking a screen `unreported` keeps its nonce.
 */
export const SCREEN_REPORT_DEADLINE_MINUTES = 50;

/**
 * How long the admin-mail lease holds: a stored result whose mail has not gone
 * out, and whose lease is free or this old, is retried by the watchdog. Also the
 * grace the watchdog gives the path that stored a result before it steps in.
 */
export const SCREEN_EMAIL_RETRY_AFTER_MINUTES = 5;

/**
 * The steps an approval runs BEFORE it changes anything: validation only. The
 * first step after them, `s3_public_read`, is the first mutation (it makes the
 * data publicly readable; shared/publication-steps.ts says so where it orders
 * it). A resumed approval skips the identifier screen gate only once a step
 * outside this list has completed: from then on the publication is underway and
 * its own later steps commit to `main`, so a head check would refuse it halfway,
 * stranding a half-published dataset. Before then nothing is public, and a
 * resume, or a re-dispatch, is gated exactly like a fresh run, because the
 * depositor may have pushed new content after the earlier attempt stopped.
 */
export const PRE_PUBLICATION_STEPS: readonly string[] = PUBLICATION_STEPS.slice(
  0,
  PUBLICATION_STEPS.indexOf("s3_public_read"),
);

/** True once an approval has completed a step that changed something (see {@link PRE_PUBLICATION_STEPS}). */
export function hasStartedPublishing(stepsCompletedJson: string | null | undefined): boolean {
  let steps: unknown;
  try {
    steps = JSON.parse(stepsCompletedJson || "[]");
  } catch {
    return false;
  }
  return (
    Array.isArray(steps) &&
    steps.some((s) => typeof s === "string" && !PRE_PUBLICATION_STEPS.includes(s))
  );
}

/**
 * Rows the watchdog handles per tick, in EACH of its two passes. Each row costs a
 * few D1 statements and one Resend call per admin; the tick it rides also runs
 * the auto-import, so the bound keeps a backlog from spending that tick's budget.
 */
export const SCREEN_SWEEP_LIMIT = 10;

/** The block reason a direct identifier puts on a request. */
export const IDENTIFIER_SCREEN_BLOCK_REASON = "identifier_screen_findings";

/** Where the workflow posts its report, under API_BASE_URL. */
export const IDENTIFIER_SCREEN_CALLBACK_PATH = "/webhooks/identifier-screen-result";

/** What an exempt dataset's email and status say about the screen. Worker-fixed words. */
export const EXEMPT_SCREEN_DESCRIPTION: ScreenDescription = {
  headline: "Identifier screen: not applicable (sandbox)",
  tone: "note",
  lines: ["Sandbox (xx) datasets never publish real data, so they are not screened."],
};

/**
 * Every column the screen owns, reset to NULL. Spliced into the UPDATE that
 * unblocks a re-request, and into every dispatch, so a stale result, nonce,
 * email claim or acknowledgment can never carry over to new content. A module
 * constant, never input.
 */
export const RESET_SCREEN_COLUMNS_SQL = `identifier_screen_status = NULL,
       identifier_screen_nonce = NULL,
       identifier_screen_dispatched_at = NULL,
       identifier_screen_at = NULL,
       identifier_screen_report = NULL,
       identifier_screen_emailed_at = NULL,
       identifier_screen_mail_claimed_at = NULL,
       identifier_screen_ack_by = NULL,
       identifier_screen_ack_reason = NULL,
       identifier_screen_ack_at = NULL`;

/**
 * The admin re-run's claim guard: only an active request that can still be
 * screened (`requested`, `blocked`, or `approving` before it started publishing,
 * which the route checks first), and never over a screen dispatched less than
 * {@link SCREEN_REPORT_DEADLINE_MINUTES} ago that has not reported, which would
 * orphan a run that may still answer. NULL-safe: a pending screen with no
 * dispatch time is overdue. A module constant, never input.
 */
export const RERUN_GUARD_SQL = `AND status IN ('requested', 'blocked', 'approving')
         AND NOT (COALESCE(identifier_screen_status, '') = 'pending'
                  AND COALESCE(identifier_screen_dispatched_at, '')
                      >= datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES} minutes'))`;

/** A report the Worker writes itself, for a screen that produced none. */
export function workerErrorReport(error: ScreenError): ScreenReport {
  return parseScreenReport({ version: REPORT_VERSION, scanner: null, head: null, error });
}

/** The screen as a status view shows it. */
export interface ScreenView {
  /** The stored state; `exempt` for a sandbox dataset; null when no screen was started. */
  state: ScreenState | "exempt" | null;
  headline: string;
  tone: ScreenDescription["tone"];
  lines: string[];
}

/** One reading of a row's screen, for every surface that shows it. */
export function screenView(datasetId: string, rawStatus: unknown, rawReport: unknown): ScreenView {
  if (isScreenExempt(datasetId)) return { state: "exempt", ...EXEMPT_SCREEN_DESCRIPTION };
  const state = readStoredState(rawStatus);
  const report = state === null ? null : readStoredReport(rawReport);
  const d = describeScreen(state, report);
  return { state, headline: d.headline, tone: d.tone, lines: d.lines };
}

/** The sentence that tells an admin what approval may do next, by gate. Worker-fixed words. */
function nextStep(gate: ScreenGate, datasetId: string): string | undefined {
  switch (gate) {
    case "clear":
      return undefined;
    case "blocks":
      return "Approval is refused while this stands. The request is blocked and the depositor has been told to fix the data and request publication again, which re-runs the screen.";
    case "acknowledge":
      return `Approval needs a recorded reason: nemar admin publish approve ${datasetId} --acknowledge-identifier-screen "<reason>"`;
    case "wait":
      return "The screen is still running; this request is mailed again when it finishes.";
    case "rerun":
      return `Approval is held until the screen is re-run: nemar admin publish screen ${datasetId}`;
  }
}

/** The email section for a row's screen. */
export function screenEmailSection(
  datasetId: string,
  rawStatus: unknown,
  rawReport: unknown,
): PublicationScreenSection {
  const view = screenView(datasetId, rawStatus, rawReport);
  if (view.state === "exempt") {
    return { headline: view.headline, tone: view.tone, lines: view.lines };
  }
  return {
    headline: view.headline,
    tone: view.tone,
    lines: view.lines,
    next: nextStep(screenGate(view.state), datasetId),
  };
}

// ============================================================================
// Mailing the admins
// ============================================================================

/** Send the publication-request email to the admins, with a screen section and, when there is one, a review section. */
export async function mailPublicationRequest(
  env: Bindings,
  args: {
    datasetId: string;
    username: string;
    anonymous: boolean;
    screen: PublicationScreenSection;
    review?: PublicationReviewSection | null;
  },
): Promise<{ attempted: number; delivered: number }> {
  const adminEmails = await getAdminEmailsForCategory(env.DB, "publication_request", env);
  if (adminEmails.length === 0) return { attempted: 0, delivered: 0 };
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const outcome = await sendPublicationRequestEmail(
    adminEmails,
    args.datasetId,
    args.username,
    env.RESEND_API_KEY,
    fromEmail,
    replyTo,
    isDev,
    env,
    { anonymous: args.anonymous, screen: args.screen, review: args.review ?? undefined },
  );
  return { attempted: outcome.attempted, delivered: outcome.delivered };
}

export type NotifyOutcome = "sent" | "not-claimed" | "undelivered";

/** A lease value: SQLite's clock to the millisecond, so two claims never compare equal. */
const LEASE_NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
/** The instant before which a lease has expired. */
const LEASE_EXPIRED_SQL = `strftime('%Y-%m-%d %H:%M:%f', 'now', '-${SCREEN_EMAIL_RETRY_AFTER_MINUTES} minutes')`;

/**
 * What the mail lease and the watchdog's unmailed query add while the publication review is on
 * (ADR 0102, section 6): the mail WAITS while a review of the screened commit is dispatched and
 * younger than the review deadline, so the one mail an administrator gets carries the review.
 * Only a request in `requested` waits, because only such a request is reviewed; a request in
 * any other status is mailed as before. Two things end the wait, so it can never hold a mail for
 * good: the review reports (its result tries the mail), or its row passes the deadline, which
 * `reviewInFlightSql` reads from the row's own age whether or not a watchdog runs.
 *
 * Empty while the flag is off, so the statements are then exactly what they were before the
 * review existed. A module-level function of fixed text, never input. `atMs` decides at an instant
 * of the caller's instead of the database's clock ({@link reviewInFlightSql}).
 */
export function reviewHoldSql(reviewOn: boolean, atMs?: number): string {
  return reviewOn
    ? `\n     AND NOT (status = 'requested' AND ${reviewInFlightSql("publication_requests", atMs)})`
    : "";
}

/**
 * Mail the admins the publication request with its screen result, at most once
 * per result in the normal case, and never lose it.
 *
 * A LEASE, not a stamp: one conditional UPDATE takes
 * `identifier_screen_mail_claimed_at` only while the mail has not gone out
 * (`emailed_at` NULL), the lease is free or expired, the result is in (not
 * pending, not NULL), the request is still active and, while the publication
 * review is on, no review of the screened commit is in flight
 * ({@link reviewHoldSql}; the mail then carries the review's section). Of two triggers racing for
 * one result (the callback and the watchdog, or two ticks) exactly one holds it.
 * After the send:
 *   - at least one admin accepted it: `emailed_at` is set and the lease cleared;
 *   - nobody did: the lease is released, and the watchdog retries.
 * Both are compare-and-set on the lease this call took, so neither can touch a
 * row that has since been re-screened (a reset clears the lease). A process that
 * dies between claim and send, or a write that fails after it, leaves a lease
 * that expires after {@link SCREEN_EMAIL_RETRY_AFTER_MINUTES}, and the watchdog
 * takes it then. That last case can mail twice; losing the mail is the worse one.
 *
 * Exported for the routes and the watchdog; it never throws.
 */
export async function notifyAdminsOfScreen(
  env: Bindings,
  requestId: number,
): Promise<NotifyOutcome> {
  const db = env.DB;
  const hold = reviewHoldSql(reviewEnabled(env));
  let claim: {
    claim: string;
    dataset_id: string;
    requested_by: number;
    anonymous: number | null;
    identifier_screen_status: string | null;
    identifier_screen_report: string | null;
  } | null;
  try {
    claim = await db
      .prepare(
        `UPDATE publication_requests
            SET identifier_screen_mail_claimed_at = ${LEASE_NOW_SQL}
          WHERE id = ?
            AND identifier_screen_emailed_at IS NULL
            AND (identifier_screen_mail_claimed_at IS NULL
                 OR identifier_screen_mail_claimed_at < ${LEASE_EXPIRED_SQL})
            AND identifier_screen_status IS NOT NULL
            AND identifier_screen_status != 'pending'
            AND status IN ('requested', 'blocked')${hold}
          RETURNING identifier_screen_mail_claimed_at AS claim, dataset_id, requested_by,
                    anonymous, identifier_screen_status, identifier_screen_report`,
      )
      .bind(requestId)
      .first();
  } catch (err) {
    console.error(
      `[identifier-screen] could not claim the admin email for request ${requestId}: ${errorText(err)}`,
    );
    return "undelivered";
  }
  if (!claim) return "not-claimed";

  let delivered = 0;
  try {
    const user = await db
      .prepare("SELECT username FROM users WHERE id = ?")
      .bind(claim.requested_by)
      .first<{ username: string | null }>();
    const outcome = await mailPublicationRequest(env, {
      datasetId: claim.dataset_id,
      username: user?.username ?? `user ${claim.requested_by}`,
      anonymous: claim.anonymous === 1,
      screen: screenEmailSection(
        claim.dataset_id,
        claim.identifier_screen_status,
        claim.identifier_screen_report,
      ),
      // Never throws, and is null when the review is off and has no row: the mail is then what
      // it was before the review existed.
      review: await publicationReviewEmailSection(env, requestId),
    });
    delivered = outcome.delivered;
  } catch (err) {
    console.error(
      `[identifier-screen] admin email for request ${requestId} failed: ${errorText(err)}`,
    );
  }

  try {
    await db
      .prepare(
        delivered > 0
          ? `UPDATE publication_requests
                SET identifier_screen_emailed_at = datetime('now'),
                    identifier_screen_mail_claimed_at = NULL
              WHERE id = ? AND identifier_screen_mail_claimed_at = ?`
          : `UPDATE publication_requests SET identifier_screen_mail_claimed_at = NULL
              WHERE id = ? AND identifier_screen_mail_claimed_at = ?`,
      )
      .bind(requestId, claim.claim)
      .run();
  } catch (err) {
    // The lease stays and expires; the watchdog then retries (and, if the send
    // had landed, mails twice rather than not at all).
    console.error(
      `[identifier-screen] could not record the admin email for request ${requestId}; the lease will expire and be retried: ${errorText(err)}`,
    );
  }
  if (delivered > 0) return "sent";
  console.warn(
    `[identifier-screen] admin email for request ${requestId} reached nobody; released for retry`,
  );
  return "undelivered";
}

/**
 * Mail the admins a request whose screen could not even be recorded (a database
 * error before the screen's own claim committed): the request exists, so the
 * admins must hear about it, with the screen stated as NOT RUN. No lease: there
 * is no stored result for one to protect, and the approval gate refuses the
 * request until the screen is re-run.
 */
export async function mailScreenNotStarted(env: Bindings, requestId: number): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT pr.dataset_id, pr.anonymous, u.username, pr.requested_by
         FROM publication_requests pr JOIN users u ON u.id = pr.requested_by
        WHERE pr.id = ?`,
    )
      .bind(requestId)
      .first<{
        dataset_id: string;
        anonymous: number | null;
        username: string | null;
        requested_by: number;
      }>();
    if (!row) return;
    await mailPublicationRequest(env, {
      datasetId: row.dataset_id,
      username: row.username ?? `user ${row.requested_by}`,
      anonymous: row.anonymous === 1,
      screen: screenEmailSection(row.dataset_id, null, null),
    });
  } catch (err) {
    console.error(
      `[identifier-screen] NOT RUN mail for request ${requestId} failed: ${errorText(err)}`,
    );
  }
}

/**
 * Start a request's screen and mail what the admins must hear now: a screen
 * that could not start is mailed with its result, one whose start threw before
 * anything was recorded is mailed as NOT RUN. A dispatched screen is mailed when
 * it reports, and an exempt one is left to the caller. Never throws.
 */
export async function startScreenAndNotify(
  env: Bindings,
  args: { requestId: number; datasetId: string; githubRepo: string | null },
): Promise<StartScreenOutcome | { kind: "threw" }> {
  let started: StartScreenOutcome | null;
  try {
    started = await startIdentifierScreen(env, args);
  } catch (err) {
    console.error(
      `[identifier-screen] starting the screen of request ${args.requestId} threw: ${errorText(err)}`,
    );
    await mailScreenNotStarted(env, args.requestId);
    return { kind: "threw" };
  }
  if (started?.kind === "failed") await notifyAdminsOfScreen(env, args.requestId);
  return started ?? { kind: "threw" };
}

// ============================================================================
// Starting a screen
// ============================================================================

export type StartScreenOutcome =
  | { kind: "exempt" }
  | { kind: "dispatched" }
  | { kind: "failed"; error: "dispatch-unconfigured" | "dispatch-failed" };

/** Record a screen that could not be started. Replaces whatever the row held. */
async function recordDispatchFailure(
  db: D1Database,
  requestId: number,
  error: "dispatch-unconfigured" | "dispatch-failed",
  nonce: string | null,
): Promise<void> {
  const report = JSON.stringify(workerErrorReport(error));
  if (nonce === null) {
    await db
      .prepare(
        `UPDATE publication_requests
            SET ${RESET_SCREEN_COLUMNS_SQL},
                identifier_screen_status = 'error', identifier_screen_report = ?,
                identifier_screen_at = datetime('now')
          WHERE id = ?`,
      )
      .bind(report, requestId)
      .run();
    return;
  }
  // After a claim: only the pending screen THIS dispatch claimed is turned into
  // an error. A callback cannot have landed (the token never left the Worker),
  // but a concurrent re-run could have replaced the nonce.
  await db
    .prepare(
      `UPDATE publication_requests
          SET identifier_screen_status = 'error', identifier_screen_report = ?,
              identifier_screen_at = datetime('now'), identifier_screen_nonce = NULL
        WHERE id = ? AND identifier_screen_status = 'pending' AND identifier_screen_nonce = ?`,
    )
    .bind(report, requestId, nonce)
    .run();
}

/**
 * Claim a request's screen as pending with a fresh nonce, resetting every other
 * screen column. `guard` is an extra SQL condition (a module constant); the
 * claim is refused, and null returned, when it does not hold.
 */
async function claimPending(db: D1Database, requestId: number, guard = ""): Promise<string | null> {
  const nonce = crypto.randomUUID();
  const res = await db
    .prepare(
      `UPDATE publication_requests
          SET ${RESET_SCREEN_COLUMNS_SQL},
              identifier_screen_status = 'pending', identifier_screen_nonce = ?,
              identifier_screen_dispatched_at = datetime('now')
        WHERE id = ? ${guard}`,
    )
    .bind(nonce, requestId)
    .run();
  return (res.meta.changes ?? 0) === 1 ? nonce : null;
}

/**
 * Start the screen of one request. Does NOT mail: on `failed` the caller mails
 * at once ({@link notifyAdminsOfScreen}); on `dispatched` the mail waits for the
 * result; on `exempt` nothing is recorded and the caller mails as before.
 *
 * Deliberately not gated on PRESCREEN_ENABLED: the screen must not be silently
 * switchable off. A Worker without the secret records `dispatch-unconfigured`,
 * which the admin is told about and which the approval gate refuses.
 *
 * `guard` lets the admin re-run route refuse to replace a fresh pending run in
 * the same statement that claims it. Returns null when that guard refused.
 */
export async function startIdentifierScreen(
  env: Bindings,
  args: { requestId: number; datasetId: string; githubRepo: string | null },
  guard = "",
): Promise<StartScreenOutcome | null> {
  const { requestId, datasetId } = args;
  if (isScreenExempt(datasetId)) return { kind: "exempt" };
  const db = env.DB;

  // The workflow addresses the dataset's repository by its id; a row with no
  // repository has nothing to screen yet.
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  const apiBase = env.API_BASE_URL;
  let pat: string | null = null;
  let unconfigured = !secret || !apiBase || !args.githubRepo;
  let failed = false;
  if (!unconfigured) {
    let auth: ReturnType<typeof getDatasetsAuth> | null = null;
    try {
      auth = getDatasetsAuth(env);
    } catch (err) {
      console.error(`[identifier-screen] no GitHub credential for ${datasetId}: ${errorText(err)}`);
      unconfigured = true;
    }
    if (auth) {
      try {
        pat = auth.kind === "app" ? await auth.getToken() : auth.token;
      } catch (err) {
        console.error(
          `[identifier-screen] could not mint a GitHub token for ${datasetId}: ${errorText(err)}`,
        );
        failed = true;
      }
    }
  }

  if (unconfigured || failed || !pat || !secret || !apiBase) {
    const error = unconfigured ? "dispatch-unconfigured" : "dispatch-failed";
    if (guard) {
      // The re-run route: claim first, so the guard decides, then fail it.
      const nonce = await claimPending(db, requestId, guard);
      if (nonce === null) return null;
      await recordDispatchFailure(db, requestId, error, nonce);
    } else {
      await recordDispatchFailure(db, requestId, error, null);
    }
    console.warn(`[identifier-screen] ${datasetId} request ${requestId}: ${error}`);
    return { kind: "failed", error };
  }

  const nonce = await claimPending(db, requestId, guard);
  if (nonce === null) return null;
  try {
    const token = await signIdentifierScreenCallbackToken({ datasetId, requestId, nonce }, secret);
    await triggerIdentifierScreenRun(
      datasetId,
      "main",
      requestId,
      token,
      `${apiBase}${IDENTIFIER_SCREEN_CALLBACK_PATH}`,
      pat,
    );
  } catch (err) {
    console.error(
      `[identifier-screen] dispatch failed for ${datasetId} request ${requestId}: ${errorText(err)}`,
    );
    await recordDispatchFailure(db, requestId, "dispatch-failed", nonce);
    return { kind: "failed", error: "dispatch-failed" };
  }
  console.log(`[identifier-screen] ${datasetId} request ${requestId}: dispatched`);
  return { kind: "dispatched" };
}

// ============================================================================
// Storing a result
// ============================================================================

export type StoreOutcome =
  | { stored: true; state: ScreenState; blocked: boolean }
  | { stored: false };

/**
 * Store a verified callback's report on the row it was issued for.
 *
 * `body` is the untrusted `report` field. It goes through `parseScreenReport`
 * and nothing else: a body outside the contract is stored as the Worker's own
 * `workflow-failed` error report and only the parser's fixed word is logged. A
 * scan of a DIFFERENT dataset than the row's is the same failure.
 *
 * One conditional UPDATE (`status = 'pending'` and the nonce that verified) is
 * the write, so of a callback and a replay, or a callback and the watchdog,
 * exactly one stores. The nonce is cleared with it, so a replay finds nothing
 * to verify against.
 */
export async function storeScreenResult(
  env: Bindings,
  args: { requestId: number; datasetId: string; nonce: string; body: unknown },
): Promise<StoreOutcome> {
  const db = env.DB;
  let report: ScreenReport;
  try {
    report = parseScreenReport(args.body);
    if (report.scan && report.scan.id !== args.datasetId) {
      console.warn(
        `[identifier-screen] report for request ${args.requestId} describes another dataset; stored as workflow-failed`,
      );
      report = workerErrorReport("workflow-failed");
    }
  } catch (err) {
    // The parser's message is a fixed word that never quotes the input.
    const code = err instanceof Error && err.name === "ReportError" ? err.message : "unparseable";
    console.warn(
      `[identifier-screen] report for request ${args.requestId} is outside the contract (${code}); stored as workflow-failed`,
    );
    report = workerErrorReport("workflow-failed");
  }
  const state = stateOf(report);

  // A late report is a real report: a screen the watchdog marked `unreported`
  // keeps its nonce, so the run it was issued for can still answer. Its mail is
  // re-armed (emailed and lease cleared), because the mail already sent said it
  // did not report. A re-run replaces the nonce, so an older run cannot.
  const res = await db
    .prepare(
      `UPDATE publication_requests
          SET identifier_screen_status = ?, identifier_screen_report = ?,
              identifier_screen_at = datetime('now'), identifier_screen_nonce = NULL,
              identifier_screen_emailed_at = NULL, identifier_screen_mail_claimed_at = NULL
        WHERE id = ? AND identifier_screen_status IN ('pending', 'unreported')
          AND identifier_screen_nonce = ?`,
    )
    .bind(state, JSON.stringify(report), args.requestId, args.nonce)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { stored: false };

  // A direct identifier blocks the request (and tells the depositor). A clear
  // result lifts a block that an earlier screen's findings put there (an admin
  // re-ran it after the data was fixed). Anything else leaves it where it is.
  let blocked = false;
  const gate = screenGate(state);
  if (gate === "blocks") {
    blocked = await blockForFindings(env, args.requestId, args.datasetId, report);
  } else if (gate === "clear") {
    await db
      .prepare(
        `UPDATE publication_requests
            SET status = 'requested', block_reason = NULL, updated_at = datetime('now')
          WHERE id = ? AND status = 'blocked' AND block_reason = ?`,
      )
      .bind(args.requestId, IDENTIFIER_SCREEN_BLOCK_REASON)
      .run();
  }
  return { stored: true, state, blocked };
}

/**
 * A direct identifier blocks the request, and the depositor is told what to fix
 * in kinds and counts. Conditional on `requested`, so it blocks once and only an
 * active request; the requester mail rides on that one transition.
 */
async function blockForFindings(
  env: Bindings,
  requestId: number,
  datasetId: string,
  report: ScreenReport,
): Promise<boolean> {
  const db = env.DB;
  const res = await db
    .prepare(
      `UPDATE publication_requests
          SET status = 'blocked', block_reason = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'requested'`,
    )
    .bind(IDENTIFIER_SCREEN_BLOCK_REASON, requestId)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  console.log(
    `[identifier-screen] ${datasetId} request ${requestId}: blocked (${IDENTIFIER_SCREEN_BLOCK_REASON})`,
  );

  try {
    const requester = await db
      .prepare(
        `SELECT u.username, u.email FROM publication_requests pr
           JOIN users u ON u.id = pr.requested_by WHERE pr.id = ?`,
      )
      .bind(requestId)
      .first<{ username: string | null; email: string }>();
    if (requester) {
      const d = describeScreen(stateOf(report), report);
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
      await sendIdentifierScreenBlockedEmail(
        requester.email,
        requester.username ?? "there",
        datasetId,
        { headline: d.headline, tone: d.tone, lines: d.lines },
        env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        env,
      );
    }
  } catch (err) {
    // Best effort: the block and its reason are on the status view either way.
    console.error(
      `[identifier-screen] requester notice for request ${requestId} failed: ${errorText(err)}`,
    );
  }
  return true;
}

// ============================================================================
// The watchdog
// ============================================================================

export interface ScreenSweepResult {
  /** Pending screens past the deadline, now `unreported`. */
  timedOut: number;
  /** Results mailed by this run (timed out or retried). */
  emailed: number;
  /** Results whose mail reached nobody this run; released for the next. */
  undelivered: number;
  /** Rows whose handling threw. */
  errors: number;
  /** True when the run did nothing because this is not production. */
  skipped: boolean;
}

/** Pending screens past the deadline. NULL-safe: a pending row with no dispatch time is overdue too. */
export const OVERDUE_SCREENS_SQL = `SELECT id FROM publication_requests
   WHERE identifier_screen_status = 'pending'
     AND (identifier_screen_dispatched_at IS NULL
          OR identifier_screen_dispatched_at < datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES} minutes'))
   ORDER BY id LIMIT ?`;

/**
 * Stored results on active requests whose admin email never went out, and whose
 * mail lease is free or expired (a sender that died, or a release that failed).
 *
 * While the review is on, a request whose mail is held for a review in flight
 * ({@link reviewHoldSql}) is left out, so held rows do not fill the ten slots of a tick
 * and a request that is ready waits behind them.
 */
export function unmailedScreensSql(reviewOn: boolean): string {
  return `SELECT id FROM publication_requests
   WHERE status IN ('requested', 'blocked')
     AND identifier_screen_status IS NOT NULL
     AND identifier_screen_status != 'pending'
     AND identifier_screen_emailed_at IS NULL
     AND (identifier_screen_mail_claimed_at IS NULL
          OR identifier_screen_mail_claimed_at < ${LEASE_EXPIRED_SQL})
     AND COALESCE(identifier_screen_at, identifier_screen_dispatched_at, '')
         < datetime('now', '-${SCREEN_EMAIL_RETRY_AFTER_MINUTES} minutes')${reviewHoldSql(reviewOn)}
   ORDER BY id LIMIT ?`;
}

/**
 * The watchdog, run on the 30-minute tick in PRODUCTION ONLY (the call site in
 * `scheduled()` is fenced, and so is this function, which answers `skipped`
 * outside production). It mails admins, and the dev worker shares the `users`
 * table with production (AGENTS.md); staging recovers a stuck screen with the
 * admin re-run route instead.
 *
 * Two passes, both D1 only (no GitHub call, so no infrastructure verdict to get
 * wrong), each bounded by {@link SCREEN_SWEEP_LIMIT}, each row independent:
 *   (a) a screen pending past {@link SCREEN_REPORT_DEADLINE_MINUTES} becomes
 *       `unreported` with the Worker's `no-report-in-time` report, by a
 *       conditional UPDATE that a late callback racing it can win instead, and
 *       is mailed;
 *   (b) a result on an active request whose mail never went out (the send
 *       reached nobody and was released, or the Worker died between storing and
 *       sending) is mailed, once it is {@link SCREEN_EMAIL_RETRY_AFTER_MINUTES}
 *       old so the path that stored it has had its chance.
 */
export async function sweepIdentifierScreens(env: Bindings): Promise<ScreenSweepResult> {
  const result: ScreenSweepResult = {
    timedOut: 0,
    emailed: 0,
    undelivered: 0,
    errors: 0,
    skipped: false,
  };
  if (isNonProductionEnv(env)) {
    result.skipped = true;
    return result;
  }
  const db = env.DB;
  const count = (o: NotifyOutcome) => {
    if (o === "sent") result.emailed++;
    else if (o === "undelivered") result.undelivered++;
  };

  let overdue: { id: number }[] = [];
  try {
    overdue = (await db.prepare(OVERDUE_SCREENS_SQL).bind(SCREEN_SWEEP_LIMIT).all<{ id: number }>())
      .results;
  } catch (err) {
    result.errors++;
    console.error(`[identifier-screen-sweep] overdue query failed: ${errorText(err)}`);
  }
  const unreported = JSON.stringify(workerErrorReport("no-report-in-time"));
  for (const row of overdue) {
    try {
      const res = await db
        .prepare(
          // The nonce is KEPT: a report that arrives after this is still the
          // run's own answer, and storeScreenResult accepts it.
          `UPDATE publication_requests
              SET identifier_screen_status = 'unreported', identifier_screen_report = ?,
                  identifier_screen_at = datetime('now')
            WHERE id = ? AND identifier_screen_status = 'pending'
              AND (identifier_screen_dispatched_at IS NULL
                   OR identifier_screen_dispatched_at < datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES} minutes'))`,
        )
        .bind(unreported, row.id)
        .run();
      if ((res.meta.changes ?? 0) !== 1) continue;
      result.timedOut++;
      count(await notifyAdminsOfScreen(env, row.id));
    } catch (err) {
      result.errors++;
      console.error(`[identifier-screen-sweep] request ${row.id}: ${errorText(err)}`);
    }
  }

  let unmailed: { id: number }[] = [];
  try {
    unmailed = (
      await db
        .prepare(unmailedScreensSql(reviewEnabled(env)))
        .bind(SCREEN_SWEEP_LIMIT)
        .all<{ id: number }>()
    ).results;
  } catch (err) {
    result.errors++;
    console.error(`[identifier-screen-sweep] unmailed query failed: ${errorText(err)}`);
  }
  for (const row of unmailed) {
    try {
      count(await notifyAdminsOfScreen(env, row.id));
    } catch (err) {
      result.errors++;
      console.error(`[identifier-screen-sweep] request ${row.id}: ${errorText(err)}`);
    }
  }
  return result;
}

// ============================================================================
// The approval gate
// ============================================================================

/** A refusal, shaped for a 409 body. */
export interface ScreenGateRefusal {
  error: "identifier_screen_not_clear";
  /** `screenGate`'s answer, or `stale` / `unverified` for the head check. */
  gate: ScreenGate | "stale" | "unverified";
  headline: string;
  message: string;
}

export type ScreenGateOutcome = { ok: true } | { ok: false; refusal: ScreenGateRefusal };

/** The screen columns the gate reads. */
interface GateRow {
  identifier_screen_status: string | null;
  identifier_screen_report: string | null;
  identifier_screen_ack_at: string | null;
  identifier_screen_ack_by: number | null;
}

/**
 * The state half of the gate: no network, no writes. `acknowledging` says the
 * caller carries a reason this call may record. A reason already recorded on
 * the request satisfies the gate only for the admin who recorded it
 * (`approverId`, the approver the run is attributed to): a web click records
 * the clicker's reason and the executor's run is attributed to that clicker, so
 * it passes, while a different admin approving later must state their own.
 */
export function screenStateGate(
  datasetId: string,
  row: GateRow,
  acknowledging: boolean,
  approverId: number,
): ScreenGateOutcome {
  const view = screenView(datasetId, row.identifier_screen_status, row.identifier_screen_report);
  if (view.state === "exempt") return { ok: true };
  const gate = screenGate(view.state === null ? null : view.state);
  const refuse = (message: string): ScreenGateOutcome => ({
    ok: false,
    refusal: { error: "identifier_screen_not_clear", gate, headline: view.headline, message },
  });
  switch (gate) {
    case "clear":
      return { ok: true };
    case "acknowledge":
      if (
        acknowledging ||
        (row.identifier_screen_ack_at !== null && row.identifier_screen_ack_by === approverId)
      ) {
        return { ok: true };
      }
      return refuse(
        `${view.headline}. An admin must look at what the screen reported and approve with a recorded reason: nemar admin publish approve ${datasetId} --acknowledge-identifier-screen "<reason>".`,
      );
    case "blocks":
      return refuse(
        `${view.headline}. A direct identifier cannot be acknowledged: the depositor must remove it and request publication again, which re-runs the screen.`,
      );
    case "wait":
      return refuse(
        `${view.headline}. The screen is still running; approve once it reports (admins are mailed when it does).`,
      );
    case "rerun":
      return refuse(
        `${view.headline}. Approval waits for a screen that produced a verdict: run it again with nemar admin publish screen ${datasetId}.`,
      );
  }
}

/**
 * The content half: the screened commit must be the dataset's current `main`,
 * or the verdict is about content that is no longer the content being
 * published. FAILS CLOSED: a report with no head, a missing token or a lookup
 * that fails all refuse, as "could not verify", never as clear.
 *
 * The repository is addressed by the dataset id, as the screen workflow
 * addresses it, so the head compared is the head the workflow would screen.
 */
export async function verifyScreenHead(
  env: Bindings,
  datasetId: string,
  row: GateRow,
  pat?: string,
): Promise<ScreenGateOutcome> {
  if (isScreenExempt(datasetId)) return { ok: true };
  const view = screenView(datasetId, row.identifier_screen_status, row.identifier_screen_report);
  const report = readStoredReport(row.identifier_screen_report);
  const unverified = (why: string): ScreenGateOutcome => ({
    ok: false,
    refusal: {
      error: "identifier_screen_not_clear",
      gate: "unverified",
      headline: view.headline,
      message: `Could not verify that the identifier screen read the current content: ${why}. Approval is refused until it can be verified; try again, or re-run the screen with nemar admin publish screen ${datasetId}.`,
    },
  });
  if (!report?.head) return unverified("the stored report names no commit");
  let token = pat;
  if (!token) {
    try {
      const auth = getDatasetsAuth(env);
      token = auth.kind === "app" ? await auth.getToken() : auth.token;
    } catch (err) {
      console.error(
        `[identifier-screen] gate: no GitHub token for ${datasetId}: ${errorText(err)}`,
      );
      return unverified("no GitHub credential was available");
    }
  }
  let head: string;
  try {
    head = await getMainBranchSha(datasetId, "main", token);
  } catch (err) {
    console.error(
      `[identifier-screen] gate: head lookup for ${datasetId} failed: ${errorText(err)}`,
    );
    return unverified("the repository's main branch could not be read");
  }
  if (head !== report.head) {
    return {
      ok: false,
      refusal: {
        error: "identifier_screen_not_clear",
        gate: "stale",
        headline: view.headline,
        message: `The identifier screen read commit ${report.head.slice(0, 12)}, and main is now at ${head.slice(0, 12)}: its verdict is about content that has since changed. Re-run it with nemar admin publish screen ${datasetId}. If an approval already started and committed to the repository, continue it with --resume instead.`,
      },
    };
  }
  return { ok: true };
}

/**
 * Record an admin's acknowledgment of a screen that needed one, and audit it.
 * Conditional on the state the gate read, so an acknowledgment can only attach
 * to the result the admin was shown. Returns false when the state moved.
 */
export async function recordScreenAcknowledgment(
  db: D1Database,
  args: {
    requestId: number;
    datasetId: string;
    adminUserId: number;
    reason: string;
    state: string;
  },
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE publication_requests
          SET identifier_screen_ack_by = ?, identifier_screen_ack_reason = ?,
              identifier_screen_ack_at = datetime('now')
        WHERE id = ? AND identifier_screen_status = ?`,
    )
    .bind(args.adminUserId, args.reason, args.requestId, args.state)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  try {
    await auditLogStatement(db, {
      userId: args.adminUserId,
      action: "identifier_screen_acknowledged",
      resourceType: "dataset",
      resourceId: args.datasetId,
      details: JSON.stringify({
        request_id: args.requestId,
        screen_state: args.state,
        reason: args.reason,
      }),
    }).run();
  } catch (err) {
    // The acknowledgment itself is on the request row; the audit row is the
    // second record, and losing it must not refuse an approval already decided.
    console.error(
      `[identifier-screen] audit write for the acknowledgment on ${args.datasetId} failed: ${errorText(err)}`,
    );
  }
  return true;
}

/**
 * The whole gate, for a fresh approval run: the state, then the head, then the
 * acknowledgment. Called before the request is marked `approving`; a resumed
 * run has already passed it.
 */
export async function checkApprovalScreenGate(
  env: Bindings,
  args: {
    requestId: number;
    datasetId: string;
    adminUserId: number;
    acknowledgment?: string;
    pat?: string;
  },
): Promise<ScreenGateOutcome> {
  if (isScreenExempt(args.datasetId)) return { ok: true };
  const row = await env.DB.prepare(
    `SELECT identifier_screen_status, identifier_screen_report, identifier_screen_ack_at,
            identifier_screen_ack_by
       FROM publication_requests WHERE id = ?`,
  )
    .bind(args.requestId)
    .first<GateRow>();
  if (!row) {
    return screenStateGate(args.datasetId, emptyGateRow(), false, args.adminUserId);
  }
  const acknowledging = typeof args.acknowledgment === "string";
  const state = screenStateGate(args.datasetId, row, acknowledging, args.adminUserId);
  if (!state.ok) return state;
  const head = await verifyScreenHead(env, args.datasetId, row, args.pat);
  if (!head.ok) return head;
  if (
    acknowledging &&
    screenGate(readStoredState(row.identifier_screen_status)) === "acknowledge"
  ) {
    const recorded = await recordScreenAcknowledgment(env.DB, {
      requestId: args.requestId,
      datasetId: args.datasetId,
      adminUserId: args.adminUserId,
      reason: args.acknowledgment as string,
      state: row.identifier_screen_status as string,
    });
    if (!recorded) {
      return {
        ok: false,
        refusal: {
          error: "identifier_screen_not_clear",
          gate: "wait",
          headline: "Identifier screen: changed",
          message:
            "The identifier screen's result changed while this approval was being checked. Read it again before approving.",
        },
      };
    }
  }
  return { ok: true };
}

function emptyGateRow(): GateRow {
  return {
    identifier_screen_status: null,
    identifier_screen_report: null,
    identifier_screen_ack_at: null,
    identifier_screen_ack_by: null,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
