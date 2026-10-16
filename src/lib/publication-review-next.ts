/**
 * The rules of `nemar admin publish next` (ADR 0102, section 8), apart from the terminal, so they
 * are tested without one.
 *
 * `next` walks the publication requests that need an administrator, oldest first, one card each,
 * and waits for a single answer:
 *
 *   y   approve from this terminal (the loop `approve` runs)
 *   n   deny, with a reason you type, which the depositor is mailed
 *   c   mail the depositor a message you type, and leave the request open
 *   d   show the whole review      s   leave it for now      q   stop
 *
 * What `y` may do is what `approve` would do for the same review (`decideApproval`), with two
 * differences that are the point of a walk. The screen's acknowledgment is asked for on the spot
 * and not given as a flag, because there is no flag to give; and a review that is not a pass is
 * refused unless the walk was started with `--force`, and then every approval over reasons asks
 * one more question that names them. A hard reason, a blocked request and a run that has not been
 * told to resume are never offered. The override is built from the review the card SHOWED (its id
 * and exactly the override-class reasons shown), never from a second read, so an approval attaches
 * to what the administrator saw or to nothing (`decideApproval`'s rule, kept here).
 *
 * Nothing here decides a review. The words on a card are the Worker's (`describePublicationReview`
 * through the detail), every string that came from the network passes `plain()`, and the walk's
 * queue is `needsAdministrator`, which reads what the Worker already decided.
 */

import chalk from "chalk";
import type {
  PublicationReviewDetail,
  PublicationReviewOverride,
} from "../../shared/contract/publication-review-admin.js";
import {
  type PublicationReviewEvidence,
  type ReasonCode,
  effectiveVersionOf,
} from "../../shared/publication-review.js";
import type { PublishRequestsResponse } from "./api/publish.js";
import { type ReviewRead, decideApproval, reasonViewLine } from "./publication-review-approve.js";
import { toneColor } from "./publication-review-display.js";
import { byOldestFirst, needsAdministrator } from "./publication-review-queue.js";
import { ageOf, plain } from "./terminal-text.js";

/** One row of `GET /admin/publish/requests`. */
export type PublishRow = PublishRequestsResponse["requests"][number];

// ---------------------------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------------------------

export type NextChoice = "approve" | "deny" | "comment" | "details" | "skip" | "quit";

/** What was typed, as a choice; null for anything else, including an empty line. */
export function parseChoice(raw: string): NextChoice | null {
  switch (raw.trim().toLowerCase()) {
    case "y":
    case "yes":
      return "approve";
    case "n":
    case "no":
      return "deny";
    case "c":
    case "comment":
      return "comment";
    case "d":
    case "details":
      return "details";
    case "s":
    case "skip":
      return "skip";
    case "q":
    case "quit":
      return "quit";
    default:
      return null;
  }
}

/**
 * Whether `y` is offered for a card and what it will ask. `override` is what to send with the
 * approval, built from the review the card showed; `overrideReasons` is its reason codes (empty
 * when nothing is overridden, as for a pass or an override already on record). `notes` are what
 * `decideApproval` would say beside the question.
 */
export type YAnswer =
  | {
      offered: true;
      /** The screen needs an acknowledgment nobody has recorded: `y` asks for its reason. */
      askAcknowledgment: boolean;
      overrideReasons: ReasonCode[];
      override: PublicationReviewOverride | null;
      notes: string[];
    }
  | { offered: false; why: string };

/**
 * A stand-in for the acknowledgment `y` will ask for. `decideApproval` treats an acknowledgment
 * that was given as the screen's reason cleared, and only whether one was given, so the word is
 * never sent anywhere: the real one is typed after the card and checked there.
 */
const ASKED_LATER = "(asked after the card)";

/**
 * Whether `y` is offered for this review, and what it will ask. Built on `decideApproval`, with
 * the acknowledgment treated as given because `y` asks for it: a refusal for a hard reason, a
 * blocked request or a run that was not told to resume is not offered, and a review that is not a
 * pass is offered only with `--force`, which then asks about each approval over reasons.
 *
 * `resume` is the walk's own: a stopped run continues (`resumeOf`).
 */
export function yAnswer(
  datasetId: string,
  read: ReviewRead,
  force: boolean,
  resume: boolean,
): YAnswer {
  // Asked first without an acknowledgment: that is the rule's own way of saying the screen's
  // reason stands and nobody has cleared it, so there is one place that knows.
  const bare = decideApproval(datasetId, read, { force, acknowledge: undefined, resume });
  const needsAck = bare.kind === "refuse" && bare.why === "needs_ack";
  const decision = needsAck
    ? decideApproval(datasetId, read, { force, acknowledge: ASKED_LATER, resume })
    : bare;

  if (decision.kind === "proceed") {
    return {
      offered: true,
      askAcknowledgment: needsAck,
      overrideReasons: decision.override?.reasons ?? [],
      override: decision.override,
      // The note that an override is being given is the question's to say, not the card's.
      notes: decision.override === null ? decision.notes : [],
    };
  }
  if (decision.why === "needs_force") {
    const approve = `nemar admin publish approve ${datasetId}${resume ? " --resume" : ""} --force`;
    return {
      offered: false,
      why: `this review is not a pass. Run 'nemar admin publish next --force' to be asked about it, or approve it with '${approve}'.`,
    };
  }
  return { offered: false, why: decision.lines.map(plain).join(" ") };
}

/** A stopped run continues: a request with steps done, or one that is already `approving`. */
export function resumeOf(row: Pick<PublishRow, "status" | "steps_completed">): boolean {
  return row.steps_completed.length > 0 || row.status === "approving";
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

/**
 * The `next` walk: the requests that need an administrator (`needsAdministrator`), oldest
 * `requested_at` first, minus those already handled in this run. A copy; `rows` is not changed.
 */
export function nextQueue(rows: readonly PublishRow[], handled: ReadonlySet<string>): PublishRow[] {
  return byOldestFirst(rows.filter(needsAdministrator)).filter((r) => !handled.has(r.dataset_id));
}

// ---------------------------------------------------------------------------------------------
// The size line
// ---------------------------------------------------------------------------------------------

/** A dataset this big gets a size line: locking its objects is a long run, and a person should know. */
export const SIZE_LINE_THRESHOLD = 5_000;

/**
 * Objects the Worker locks in one call (the batch size of `applyObjectLockBatch` in the backend's
 * S3 service). A copy, because the CLI does not import the backend; the duration is said in calls
 * only, because no per-call time has been measured here.
 */
export const OBJECTS_PER_LOCK_CALL = 100;

/**
 * "about N files; locking them takes about M calls to the API", or null below the threshold or
 * when the count is not known. `datasets.total_files` is the count: the number of objects to lock
 * is known only once the first lock call has listed them, so this says "about".
 */
export function sizeLine(totalFiles: number | null): string | null {
  // The count crossed the network: an older Worker sends none, and a number is all that is believed.
  if (typeof totalFiles !== "number" || !Number.isFinite(totalFiles)) return null;
  if (totalFiles < SIZE_LINE_THRESHOLD) return null;
  const calls = Math.ceil(totalFiles / OBJECTS_PER_LOCK_CALL);
  return `about ${totalFiles.toLocaleString("en-US")} files; locking them takes about ${calls.toLocaleString("en-US")} calls to the API`;
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

/**
 * How long ago a request was made. The database writes `YYYY-MM-DD HH:MM:SS` in UTC with no zone,
 * which `Date.parse` would read in the local one; the zone is added before it is read.
 */
export function requestedAge(requestedAt: string, now: number = Date.now()): string {
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(requestedAt)
    ? `${requestedAt.replace(" ", "T")}Z`
    : requestedAt;
  return ageOf(stamp, now);
}

/** Reasons a card lists before saying how many more `d` shows. */
const CARD_REASONS = 6;

/** `Version:` for the card: the one an approval would publish, or why none is known. */
function versionWord(read: ReviewRead): string {
  if (read.kind !== "detail") return "not read (the review could not be read)";
  const evidence: PublicationReviewEvidence | null = read.detail.review?.evidence ?? null;
  if (evidence === null) return "not read (no report)";
  const version = effectiveVersionOf(evidence);
  return version === null ? "malformed (X.Y.Z expected)" : plain(version);
}

export interface CardInput {
  /** This card's place in the run, and how many the walk has shown and has waiting. */
  position: number;
  total: number;
  row: PublishRow;
  read: ReviewRead;
  answer: YAnswer;
  /** The walk was started with `--force`. */
  force: boolean;
  /** The clock for "requested 2d ago", so a test can fix it. */
  now?: number;
}

/**
 * One card, as the lines to print. The detail it was built from is the one `d` shows and the one
 * an override is built from: a card never reads twice.
 */
export function cardLines(input: CardInput): string[] {
  const { row, read, answer } = input;
  const detail: PublicationReviewDetail | null = read.kind === "detail" ? read.detail : null;
  const anonymous = detail === null ? row.anonymous === 1 : detail.anonymous;
  const kind = anonymous ? chalk.yellow("ANONYMOUS RELEASE") : "named publication";
  const out: string[] = [
    `${chalk.bold(`[${input.position} of ${input.total}] ${plain(row.dataset_id)}`)}  ${plain(row.requested_by_username)}  ${kind}  requested ${requestedAge(row.requested_at, input.now)} ago`,
    `  Version:  ${versionWord(read)}`,
  ];

  const screen = detail?.identifier_screen ?? row.identifier_screen;
  out.push(
    `  Screen:   ${screen ? toneColor(screen.tone)(plain(screen.headline)) : "not reported"}`,
  );

  const review = detail?.description ?? row.publication_review;
  out.push(
    `  Review:   ${review ? toneColor(review.tone)(plain(review.headline)) : "not reported"}`,
  );
  const indent = " ".repeat(12);
  if (detail !== null) {
    for (const r of detail.reasons.slice(0, CARD_REASONS)) {
      out.push(`${indent}${plain(reasonViewLine(r))}`);
    }
    if (detail.reasons.length > CARD_REASONS) {
      out.push(`${indent}+${detail.reasons.length - CARD_REASONS} more (d shows them)`);
    }
  } else if (Array.isArray(row.publication_review?.reasons)) {
    const codes = row.publication_review.reasons.map(plain).join(", ");
    if (codes !== "") out.push(`${indent}${chalk.dim(codes)}`);
  }

  const size = detail === null ? null : sizeLine(detail.total_files);
  if (size !== null) out.push(`  Size:     ${size}`);

  if (answer.offered) {
    for (const note of answer.notes) out.push(chalk.yellow(`  ${plain(note)}`));
    if (answer.askAcknowledgment) {
      out.push(
        chalk.yellow("  y will ask for your reason for approving over the identifier screen."),
      );
    }
    if (input.force && answer.overrideReasons.length > 0) {
      out.push(chalk.red("  --force: y will ask you to confirm each reason"));
    }
  } else {
    out.push(chalk.yellow(`  y is not offered: ${answer.why}`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The tally and the exit code
// ---------------------------------------------------------------------------------------------

/** What one walk did, request by request. */
export interface NextTally {
  approved: number;
  denied: number;
  commented: number;
  skipped: number;
  /** A write that was refused or could not be made: an approval, a denial or a comment. */
  failed: number;
}

export const emptyTally = (): NextTally => ({
  approved: 0,
  denied: 0,
  commented: 0,
  skipped: 0,
  failed: 0,
});

/** `Done: 1 approved, 1 skipped.`, or that nothing was changed. */
export function tallyLine(t: NextTally): string {
  const parts = [
    t.approved && `${t.approved} approved`,
    t.denied && `${t.denied} denied`,
    t.commented && `${t.commented} commented`,
    t.skipped && `${t.skipped} skipped`,
    t.failed && `${t.failed} failed`,
  ].filter(Boolean);
  return parts.length === 0 ? "Nothing was changed." : `Done: ${parts.join(", ")}.`;
}

/** Requests the walk leaves for the administrator: the ones skipped and the ones that failed. */
export function stillNeedYou(t: NextTally): number {
  return t.skipped + t.failed;
}

/**
 * The walk's exit code: 130 when it was interrupted (the shell's code for Ctrl+C), else 1 when
 * anything failed, else 0. A request that was skipped or left open is not a failure; a script that
 * asked for an approval and was refused has to be able to tell.
 */
export function exitCodeOf(t: NextTally, interrupted: boolean): 0 | 1 | 130 {
  if (interrupted) return 130;
  return t.failed > 0 ? 1 : 0;
}
