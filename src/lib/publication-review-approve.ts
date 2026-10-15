/**
 * What `nemar admin publish approve` decides before it asks (ADR 0102, sections 8 and 9).
 *
 * **The Worker is the gate; this explains.** `POST /admin/publish/:id/approve` runs the review gate
 * (`backend/src/services/publication-review-gate.ts`) and refuses with the shared words, so a
 * client that skipped this file could not publish over a non-pass. What this adds is the sentence
 * BEFORE the question, so an administrator is not asked to confirm a thing the Worker would
 * refuse, and the override the Worker needs, built from what the administrator was shown.
 *
 * Two rules keep it honest, and the tests hold it to them:
 *
 *  - It refuses only where the Worker's gate would also refuse, except where an explicit flag is
 *    missing (`--force`, `--acknowledge-identifier-screen`, `--resume`): those are the
 *    administrator's own act, and the Worker cannot know one was meant. It never refuses a state
 *    the Worker would pass, and where it lets a run through the Worker may still refuse (a record
 *    that is another administrator's, a reason that came up after the read). `decideApproval` and
 *    `evaluateApprovalReviewGate` share `hardReasonsOf` and `uncoveredByOverride`, so what is hard
 *    and what an override covers is one rule in `shared/publication-review.ts`, not two.
 *  - The override it builds comes only from the review and the reasons in the detail the command
 *    READ and printed: the review id in force and exactly the override-class codes shown, never a
 *    re-read. A reason that came up since is the Worker's to refuse (`override_not_covering`), which
 *    is how an approval attaches to what was shown or to nothing.
 *
 * `decideApproval` has no `yes` input. `--yes` is the answer to the question and nothing else: it
 * can never stand in for `--force` or for `--acknowledge-identifier-screen`, and a function that
 * cannot see it cannot be argued into treating it as one.
 */

import type {
  PublicationReviewDetail,
  PublicationReviewOverride,
  ReasonView,
} from "../../shared/contract/publication-review-admin.js";
import {
  REASONS,
  REASON_CODES,
  type ReasonCode,
  hardReasonsOf,
  reasonLine,
  reviewGateRefusalText,
  uncoveredByOverride,
} from "../../shared/publication-review.js";
import { BLOCK_REASON_HINTS } from "./admin-command.js";
import { ApiError, errorDetail } from "./api/errors.js";
import { getPublicationReview, reviewErrorCode } from "./api/publish.js";

/** What the command could learn about the review before it decided. */
export type ReviewRead =
  | { kind: "detail"; detail: PublicationReviewDetail }
  /** The backend has no review route (a 404 without a review code), or no active request (`not_found`). */
  | { kind: "absent"; why: "no_route" | "no_request" }
  /**
   * `refused` is the Worker's own definitive answer to the read (HTTP 400, 401 or 403: a bad id, no
   * key, a key that is not an administrator's). Nothing the command could ask next would change
   * it, so `approve` stops there; a caller that does not read it treats it like any other read that
   * failed.
   */
  | { kind: "unreadable"; why: string; refused?: ApiError };

/** The flags that are the administrator's own act. There is no `yes` here, on purpose. */
export interface ApproveOptions {
  force: boolean;
  acknowledge: string | undefined;
  resume: boolean;
}

export type ApproveRefusal = "blocked" | "needs_resume" | "hard" | "needs_ack" | "needs_force";

export type ApproveDecision =
  | {
      kind: "proceed";
      /** What to send: the review shown and the reasons shown; null when nothing is overridden here. */
      override: PublicationReviewOverride | null;
      notes: string[];
    }
  | { kind: "refuse"; why: ApproveRefusal; lines: string[] };

// ---------------------------------------------------------------------------------------------
// Reading the review
// ---------------------------------------------------------------------------------------------

const GATES: readonly string[] = ["enforced", "off", "n/a"];
const CODES: readonly string[] = REASON_CODES;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * One reason this CLI can read and classify as the API does. `cleared_by` is what the API says
 * clears it; the CLI decides from its own table (`REASONS`), so a reason the API classifies
 * differently (a newer API that moved it) is unreadable here and the API decides, rather than this
 * CLI refusing as hard what the API would accept, or sending an override for what it would refuse.
 */
function isReasonView(x: unknown): boolean {
  return (
    isObject(x) &&
    typeof x.code === "string" &&
    CODES.includes(x.code) &&
    typeof x.sentence === "string" &&
    typeof x.cure === "string" &&
    (x.detail === null || typeof x.detail === "string") &&
    (x.line === undefined || typeof x.line === "string") &&
    x.cleared_by === REASONS[x.code as ReasonCode].clearedBy
  );
}

/** Whether `raw` carries a reason this CLI knows that the API classifies differently ({@link isReasonView}). */
function classifiesDifferently(raw: unknown): boolean {
  return (
    isObject(raw) &&
    Array.isArray(raw.reasons) &&
    raw.reasons.some(
      (r) =>
        isObject(r) &&
        typeof r.code === "string" &&
        CODES.includes(r.code) &&
        typeof r.cleared_by === "string" &&
        r.cleared_by !== REASONS[r.code as ReasonCode].clearedBy,
    )
  );
}

function isReviewRecord(x: unknown): boolean {
  if (!isObject(x) || typeof x.id !== "number" || !Number.isInteger(x.id)) return false;
  const o = x.override;
  return (
    o === null ||
    (isObject(o) &&
      typeof o.by === "number" &&
      typeof o.at === "string" &&
      Array.isArray(o.reasons) &&
      o.reasons.every((r) => typeof r === "string"))
  );
}

/**
 * The detail the Worker sent, if this version of the CLI can read every field the decision and the
 * banner use; null otherwise. A reason code this CLI does not know (a newer server) is unreadable
 * rather than a crash in `hardReasonsOf`, and an unreadable review is the Worker's to judge.
 */
export function parseReviewDetail(raw: unknown): PublicationReviewDetail | null {
  if (!isObject(raw)) return null;
  const ack = raw.screen_acknowledgment;
  const ok =
    typeof raw.request_status === "string" &&
    typeof raw.gate === "string" &&
    GATES.includes(raw.gate) &&
    typeof raw.started_publishing === "boolean" &&
    (raw.block_reason === null || typeof raw.block_reason === "string") &&
    (ack === null || (isObject(ack) && typeof ack.by === "number" && typeof ack.at === "string")) &&
    Array.isArray(raw.reasons) &&
    raw.reasons.every(isReasonView) &&
    (raw.review === null || isReviewRecord(raw.review)) &&
    isObject(raw.description) &&
    typeof raw.description.headline === "string" &&
    Array.isArray(raw.description.lines) &&
    raw.description.lines.every((l) => typeof l === "string");
  return ok ? (raw as unknown as PublicationReviewDetail) : null;
}

/** The statuses of the review read that are the Worker's final word: a bad id, no key, not an administrator. */
const REFUSING_STATUSES: readonly number[] = [400, 401, 403];

/** `GET /admin/publish/:id/review`, as a {@link ReviewRead}: never throws. */
export async function readReview(datasetId: string): Promise<ReviewRead> {
  try {
    const raw = await getPublicationReview(datasetId);
    const detail = parseReviewDetail(raw);
    if (detail !== null) return { kind: "detail", detail };
    return {
      kind: "unreadable",
      why: classifiesDifferently(raw)
        ? "this version of the CLI classifies a reason differently from the API"
        : "the NEMAR API sent a review this version of the CLI cannot read",
    };
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      // The review route answers `not_found` for a dataset with no active request; a 404 without
      // that word is a backend that has no such route.
      return {
        kind: "absent",
        why: reviewErrorCode(err) === "not_found" ? "no_request" : "no_route",
      };
    }
    const why =
      err instanceof ApiError && err.statusCode !== 0 ? `HTTP ${err.statusCode}` : errorDetail(err);
    return err instanceof ApiError && REFUSING_STATUSES.includes(err.statusCode)
      ? { kind: "unreadable", why, refused: err }
      : { kind: "unreadable", why };
  }
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

/**
 * One reason as one line, in the words the Worker's own description uses (`line`: the sentence, the
 * detail as words for a person and the cure), so a reason reads the same in the review above the
 * question and in the refusal below it. A Worker that predates `line` sends none; the line is then
 * the sentence and the cure, without the closed word behind it, which is not a word for a person.
 */
export function reasonViewLine(view: Pick<ReasonView, "sentence" | "cure" | "line">): string {
  return typeof view.line === "string" && view.line !== ""
    ? view.line
    : `${view.sentence} ${view.cure}`;
}

/** The approve command for this dataset, with the flags the administrator needs next. */
function approveCommand(
  id: string,
  flags: { resume: boolean; acknowledge: boolean; force: boolean },
): string {
  return `nemar admin publish approve ${id}${flags.resume ? " --resume" : ""}${
    flags.acknowledge ? ' --acknowledge-identifier-screen "<reason>"' : ""
  }${flags.force ? " --force" : ""}`;
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

/**
 * Decide, from the review the administrator was shown and the flags that are theirs, whether to
 * ask the question, and what override to send with the approval. Ten steps, in this order.
 */
export function decideApproval(
  datasetId: string,
  read: ReviewRead,
  options: ApproveOptions,
): ApproveDecision {
  // 1. Nothing was read: the Worker is the gate, and a client that cannot read cannot clear
  // anything, so nothing is overridden and the Worker's own refusal is what the administrator sees.
  // A --force that was given says it was not sent, or the Worker's "approve over it with --force"
  // would reach someone who just passed it.
  if (read.kind !== "detail") {
    const note =
      read.kind === "unreadable"
        ? `The publication review could not be read (${read.why}); the API still checks it.`
        : read.why === "no_route"
          ? "This API has no publication review."
          : `No active publication request was found for ${datasetId}; the API decides.`;
    const notes = options.force
      ? [note, "--force was not sent: no review could be read to approve over."]
      : [note];
    return { kind: "proceed", override: null, notes };
  }
  const { detail } = read;
  const id = datasetId;

  // 2. A run that has started publishing is continued, not gated (the Worker skips every gate for
  // it). Without --resume the Worker would start it over, so that is the cure. This comes before
  // the blocked check because the owner-name walk-back can block a run half way: the detail says
  // `started_publishing` for it whatever the status, and the Worker passes it.
  if (detail.started_publishing) {
    if (!options.resume) {
      return {
        kind: "refuse",
        why: "needs_resume",
        lines: [
          `This approval has already started publishing. Continue it with: nemar admin publish approve ${id} --resume`,
        ],
      };
    }
    return {
      kind: "proceed",
      override: null,
      notes: [
        "It passed the gates when it started; a resume that has started publishing is not gated again.",
      ],
    };
  }

  // 3. A blocked request that has not started publishing is refused by the mechanical rules,
  // whatever the gate says: with the flag off the reasons are empty, so this reads the status.
  if (detail.request_status === "blocked") {
    const hint = detail.block_reason === null ? undefined : BLOCK_REASON_HINTS[detail.block_reason];
    const lines = [
      reasonLine({ code: "request_blocked", detail: detail.block_reason }, id, null, false),
    ];
    if (hint) lines.push(hint);
    return { kind: "refuse", why: "blocked", lines };
  }

  // 4. A gate that is off, or does not apply, gates nothing, and --force changes nothing there.
  if (detail.gate !== "enforced") {
    return {
      kind: "proceed",
      override: null,
      notes: options.force ? [`--force changes nothing: the review gate is ${detail.gate}.`] : [],
    };
  }

  const resumeFlag = options.resume || detail.request_status === "approving";
  const ackGiven = options.acknowledge !== undefined;

  // 5. A hard reason is refused whatever the flags say, with its cure.
  const hard = hardReasonsOf(detail.reasons);
  if (hard.length > 0) {
    return {
      kind: "refuse",
      why: "hard",
      lines: [reviewGateRefusalText("hard_reason", id), ...hard.map(reasonViewLine)],
    };
  }

  // What an override would have to cover, and whether one already does (step 9).
  const need = uncoveredByOverride(detail.reasons, []);
  const recorded = detail.review?.override ?? null;
  const recordedCovers =
    recorded !== null && uncoveredByOverride(detail.reasons, recorded.reasons).length === 0;

  // 6. The screen's own reason is cleared by its own flag, never by --force and never by --yes.
  const ackReason = detail.reasons.find((r) => r.code === "identifier_screen_needs_acknowledgment");
  if (ackReason !== undefined && !ackGiven && detail.screen_acknowledgment === null) {
    const lines = [reasonViewLine(ackReason)];
    if (need.length > 0 && !options.force && !recordedCovers) {
      lines.push(
        `The review is not a pass either, so that command also needs --force: ${approveCommand(id, {
          resume: resumeFlag,
          acknowledge: true,
          force: true,
        })}`,
      );
    }
    return { kind: "refuse", why: "needs_ack", lines };
  }

  // 7. Nothing an override clears: a pass, or only the acknowledgment reason, which the screen
  // gate decides.
  if (need.length === 0) {
    return { kind: "proceed", override: null, notes: [] };
  }

  // 8. --force: the administrator's own act. The override names the review shown and the
  // override-class reasons shown, so it attaches to what was read or to nothing.
  if (options.force) {
    return {
      kind: "proceed",
      override: { review_id: detail.review?.id ?? null, reasons: need },
      notes: [`Approving over: ${need.join(", ")} (--force; recorded with your account).`],
    };
  }

  // 9. An override already recorded for this review covers it: how the web executor's `--yes` run
  // proceeds on the confirmation its clicker recorded (ADR 0102, section 8). Nothing is sent; the
  // Worker accepts the record only for a run attributed to the administrator who made it.
  if (recorded !== null && recordedCovers) {
    return {
      kind: "proceed",
      override: null,
      notes: [
        `An override by administrator #${recorded.by} at ${recorded.at} covers these reasons. The API accepts it only for a run recorded as theirs.`,
      ],
    };
  }

  // 10. Otherwise the administrator has to say so.
  return {
    kind: "refuse",
    why: "needs_force",
    lines: [
      reviewGateRefusalText("needs_override", id),
      `To approve over them, run: ${approveCommand(id, {
        resume: resumeFlag,
        acknowledge: ackGiven,
        force: true,
      })}`,
    ],
  };
}
