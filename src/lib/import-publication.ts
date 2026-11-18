/**
 * How an import's finalize publishes: it waits for the identifier screen's verdict and approves
 * only a clear one (ADR 0089).
 *
 * Requesting publication starts the screen (ADR 0086), and approval is refused until it reports.
 * The importer used to request and approve in one run, which the gate now refuses. So finalize
 * polls the request's screen state for a bounded time, approves when `screenGate` says `clear`,
 * re-runs a screen the gate calls `stale` at most once (an automated commit to `main`, such as
 * enrichment's, can land after the screen read the head), and otherwise approves nothing.
 *
 * **A held publication is not a failed import.** Every outcome returns, except an approval of a
 * clear screen that fails for a reason that is not the screen's and a hold that cannot be recorded:
 * the data is copied and registered, the request stays open, and Phase 4 mails the admins whatever
 * the screen says, including when it never reports. Exiting non-zero here would quarantine or roll
 * back the import and open a public failure issue for a dataset that needs a person, not a fix
 * (ADR 0053).
 *
 * **The importer's own holds are written on the request.** The screen cannot see that a forward fix
 * left originals in the pushed history, or that the staging manifest has no scrub record, so for
 * those the request is denied with a fixed reason (`IMPORTER_HOLD_REASONS`) before anyone is asked
 * to approve it; publishing then takes a person's new request, which re-runs the screen.
 *
 * **Unknown is never clear.** A status that cannot be read, a screen view an older backend does
 * not send, a state that is not a state, and a wait that runs out are each `unchecked`, never an
 * approval.
 */

import {
  type ScreenGate,
  isScreenState,
  screenGate,
} from "../../shared/identifier-screen-report.js";
import { ApiError } from "./api/errors.js";
import {
  approvePublication,
  denyPublication,
  getPublishStatus,
  rerunIdentifierScreen,
} from "./api/publish.js";
import type { ImportPrivacyRecord } from "./s3-server-copy.js";

/** The outcome of finalize's publication step, as one fixed word. */
export type ImportPublicationOutcome =
  /** The screen was clear and the approval ran. */
  | "published"
  /** The dataset was public before this run (a data re-copy); nothing was requested. */
  | "already-published"
  /** The screen found direct identifiers. The request is blocked; there is no override. */
  | "blocked"
  /** A person must look and approve with a recorded reason. */
  | "review"
  /** No verdict this run could act on. */
  | "unchecked";

/** Why an outcome is `review` or `unchecked`. Fixed words. */
export type ImportPublicationReason =
  /** The screen asked for an admin's acknowledgment (findings of lesser severity, or a scan that could not cover everything). */
  | "acknowledgment-needed"
  /** The import's scrub changed content git tracks, whose original the pushed history still holds. */
  | "history-holds-originals"
  /** The staging manifest has no scrub record (an older prepare), so whether the scrub ran is unknown. */
  | "no-scrub-record"
  /** The screen did not run, failed, or did not report. */
  | "no-verdict"
  /** The screen was still running when the wait ran out. */
  | "timeout"
  /** The request's status could not be read before the wait ran out. */
  | "status-unreadable"
  /** The backend sent no screen view, or a state that is not one. */
  | "no-screen-view"
  /** The request's status was refused (401, 403 or 404): waiting would not change it. */
  | "status-refused"
  /** `main` moved after the screen read it, and the re-run could not be started. */
  | "rerun-failed"
  /** The dataset's open request is already being approved; finalize does not start a second run. */
  | "approval-in-progress"
  /** `main` moved after the screen read it, and the one re-run allowed did not settle it. */
  | "stale"
  /** The approval could not verify which commit the screen read. */
  | "unverified";

export interface PublicationDecision {
  outcome: ImportPublicationOutcome;
  reason?: ImportPublicationReason;
}

/**
 * What the importer writes on a request it holds itself (ADR 0089), through the deny route: fixed
 * words a person reads in the denial mail and the request's record. The screen cannot see these
 * holds, so a request left open would show only its verdict, and a clean verdict would be approved.
 */
export const IMPORTER_HOLD_REASONS: Record<"history-holds-originals" | "no-scrub-record", string> =
  {
    "history-holds-originals":
      "Held by the importer (ADR 0089): its identifier scrub changed files git tracks, and the pushed history still holds their original content. Rewrite the history with ADR 0085's tools, or request publication again to publish the history as it is.",
    "no-scrub-record":
      "Held by the importer (ADR 0089): the import's staging manifest has no valid record of the identifier scrub, so whether it ran is unknown. Re-run the import's prepare phase, or check the dataset and request publication again.",
  };

/** Attempts at recording a hold before finalize gives up and fails loudly. */
const HOLD_ATTEMPTS = 3;

/** The longest finalize waits for a verdict: past the screen's own 35-minute deadline, under the 50-minute watchdog. */
export const SCREEN_WAIT_MS = 45 * 60_000;

/**
 * The finalize job's `timeout-minutes` in `.github/dataset-workflows/onboard-openneuro.yml`, pinned
 * to the file by a test. A job killed by its timeout reports a failure for an import whose data is
 * in place, so the wait is cut to what the job has left; the file is deployed as a whole-file copy
 * to `nemarDatasets/.github`, and raising the timeout there lets the full wait apply (ADR 0089).
 */
export const FINALIZE_JOB_TIMEOUT_MS = 90 * 60_000;
/** What the job keeps after the wait: runner setup before this process, the approval's S3 lock pages, and the reindex. */
export const FINALIZE_RESERVE_MS = 30 * 60_000;
/** The shortest wait: a screen usually reports in minutes. */
export const MIN_SCREEN_WAIT_MS = 5 * 60_000;

/** The wait finalize can afford after `elapsedMs` of its own run, within {@link SCREEN_WAIT_MS}. */
export function screenWaitBudget(elapsedMs: number): number {
  const left = FINALIZE_JOB_TIMEOUT_MS - FINALIZE_RESERVE_MS - elapsedMs;
  return Math.min(SCREEN_WAIT_MS, Math.max(MIN_SCREEN_WAIT_MS, left));
}
/** How often it reads the request's status while it waits. */
export const SCREEN_POLL_MS = 30_000;
/** Re-runs allowed for a screen whose commit `main` has moved past. */
export const MAX_RESCREENS = 1;
/** Approval attempts for an error that is not the screen's, and the gap between them. */
const APPROVE_ATTEMPTS = 10;
const APPROVE_RETRY_MS = 3_000;

export interface AwaitScreenOptions {
  nemarId: string;
  skipCiCheck: boolean;
  /** From the staging manifest; absent when an older prepare wrote it. */
  privacy: ImportPrivacyRecord | undefined;
  waitMs?: number;
  pollMs?: number;
  approveRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Progress for a spinner: fixed words only. */
  onProgress?: (text: string) => void;
}

/**
 * The gate a status view's state puts the request behind; anything that is not a screen state is
 * `rerun`. That includes `exempt`, which the backend reports only for sandbox (`xx`) ids: the
 * importer imports `on` ids, so an exemption here is a fault, not a reason to approve.
 */
function gateOfState(state: unknown): ScreenGate {
  return screenGate(isScreenState(state) ? state : null);
}

type Verdict =
  | { kind: "verdict"; gate: ScreenGate }
  | { kind: "no-view" }
  | { kind: "timeout" }
  | { kind: "unreadable" }
  | { kind: "refused" };

/** A status read the backend will refuse again however long the wait. */
function isRefusedRead(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 404)
  );
}

/** The privacy record is one this finalize understands, and says exactly whether history holds. */
function isPrivacyRecord(x: unknown): x is ImportPrivacyRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.version === 1 && typeof r.historyHoldsOriginals === "boolean";
}

/** The screen's refusal of an approval, when the error is one; null for any other error. */
function screenRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.statusCode !== 409) return null;
  if (err.code !== "identifier_screen_not_clear") return null;
  const body = err.rawBody as { gate?: unknown } | undefined;
  return typeof body?.gate === "string" ? body.gate : "unknown";
}

/**
 * Wait for the screen's verdict and approve a clear one. Returns the outcome; throws only when an
 * approval of a clear screen fails for a reason that is not the screen's (the import's failure, as
 * it always was).
 */
export async function awaitScreenAndApprove(
  opts: AwaitScreenOptions,
): Promise<PublicationDecision> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? SCREEN_POLL_MS;
  const deadline = now() + (opts.waitMs ?? SCREEN_WAIT_MS);
  const progress = opts.onProgress ?? (() => undefined);
  let rescreens = 0;

  // The holds only the importer knows about come first: the screen cannot see them, so they are
  // recorded on the request before anyone is asked to approve it.
  const hold = !isPrivacyRecord(opts.privacy)
    ? "no-scrub-record"
    : opts.privacy.historyHoldsOriginals
      ? "history-holds-originals"
      : null;
  if (hold) {
    for (let attempt = 1; ; attempt++) {
      try {
        progress("Recording the importer's hold on the publication request");
        await denyPublication(opts.nemarId, IMPORTER_HOLD_REASONS[hold]);
        return { outcome: "review", reason: hold };
      } catch {
        // Fail loudly rather than leave an open request that a clean verdict would get approved.
        if (attempt >= HOLD_ATTEMPTS) {
          throw new Error(
            `could not record the importer's hold (${hold}) on the publication request after ${HOLD_ATTEMPTS} attempts; deny it by hand before anyone approves it`,
          );
        }
        await sleep(opts.approveRetryMs ?? APPROVE_RETRY_MS);
      }
    }
  }

  const pollForVerdict = async (): Promise<Verdict> => {
    let sawStatus = false;
    for (;;) {
      try {
        const status = await getPublishStatus(opts.nemarId);
        const view = status.identifier_screen;
        if (!view || typeof view !== "object") return { kind: "no-view" };
        sawStatus = true;
        const gate = gateOfState(view.state);
        if (gate !== "wait") return { kind: "verdict", gate };
      } catch (err) {
        // A failed read is retried until the deadline and never read as a verdict; one the backend
        // will refuse again (a revoked key, a missing dataset) ends the wait now.
        if (isRefusedRead(err)) return { kind: "refused" };
      }
      const left = deadline - now();
      if (left <= 0) return { kind: sawStatus ? "timeout" : "unreadable" };
      progress(`Waiting for the identifier screen (${Math.ceil(left / 60_000)} min left)`);
      await sleep(Math.min(pollMs, left));
    }
  };

  for (;;) {
    const verdict = await pollForVerdict();
    if (verdict.kind === "timeout") return { outcome: "unchecked", reason: "timeout" };
    if (verdict.kind === "unreadable") return { outcome: "unchecked", reason: "status-unreadable" };
    if (verdict.kind === "no-view") return { outcome: "unchecked", reason: "no-screen-view" };
    if (verdict.kind === "refused") return { outcome: "unchecked", reason: "status-refused" };
    const gate = verdict.gate;
    if (gate === "blocks") return { outcome: "blocked" };
    if (gate === "acknowledge") return { outcome: "review", reason: "acknowledgment-needed" };
    if (gate === "rerun") return { outcome: "unchecked", reason: "no-verdict" };
    if (gate === "wait") return { outcome: "unchecked", reason: "timeout" };

    // Clear, and no hold of the importer's own (they returned above).
    let refusal: string | null = null;
    for (let attempt = 1; attempt <= APPROVE_ATTEMPTS; attempt++) {
      try {
        progress(`Approving publication (attempt ${attempt}/${APPROVE_ATTEMPTS})`);
        // A retry resumes: the orchestrator keeps its progress, and a resumed run that has not
        // started publishing is gated like a fresh one (ADR 0086).
        await approvePublication(opts.nemarId, attempt > 1, false, opts.skipCiCheck);
        return { outcome: "published" };
      } catch (err) {
        refusal = screenRefusal(err);
        if (refusal !== null) break;
        if (attempt === APPROVE_ATTEMPTS) throw err;
        await sleep(opts.approveRetryMs ?? APPROVE_RETRY_MS);
      }
    }

    // The gate refused a screen this run read as clear: its state or the head moved in between.
    if (refusal === "stale") {
      if (rescreens >= MAX_RESCREENS) return { outcome: "unchecked", reason: "stale" };
      rescreens++;
      progress("The screened commit is no longer main; re-running the identifier screen");
      try {
        await rerunIdentifierScreen(opts.nemarId);
      } catch {
        // No new screen means no new verdict and no new mail: say so rather than wait on the old one.
        return { outcome: "unchecked", reason: "rerun-failed" };
      }
      continue;
    }
    if (refusal === "unverified") {
      if (deadline - now() <= 0) return { outcome: "unchecked", reason: "unverified" };
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      continue;
    }
    // Any other refusal: read the state again, which says what it is now, after a pause so a
    // backend that keeps disagreeing with its own status is not asked again at once.
    if (deadline - now() <= 0) return { outcome: "unchecked", reason: "timeout" };
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

/** The fixed sentence the finalize log prints for a decision. Counts and words only: the log is public. */
export function describePublicationDecision(id: string, d: PublicationDecision): string {
  switch (d.outcome) {
    case "published":
      return "Identifier screen: clear; publication approved";
    case "already-published":
      return `${id} was already published; publication not requested (data re-copy only)`;
    case "blocked":
      return "Identifier screen: blocked; publication not approved. The data must be corrected and publication requested again.";
    case "review":
      return d.reason === "history-holds-originals" || d.reason === "no-scrub-record"
        ? `Import held (${d.reason}); the publication request was denied with that reason. An admin decides: nemar admin repo publish list`
        : `Identifier screen: review (${d.reason}); publication not approved. An admin decides: nemar admin repo publish list`;
    case "unchecked":
      return `Identifier screen: unchecked (${d.reason}); publication not approved. An admin decides: nemar admin repo publish screen ${id}`;
  }
}
