/**
 * The rules of `nemar admin pr-reviews next` (ADR 0093), apart from the terminal, so they are
 * tested without one.
 *
 * `next` walks the queue one pull request at a time and waits for a single answer:
 *
 *   y   approve as yourself, then squash-merge
 *   n   close it, with a comment you type
 *   c   comment on it and leave it open
 *   d   show the whole report      s   leave it for now      q   stop
 *
 * What `y` may do is the same as for `approve`, plus one thing: it also merges, so it is only
 * offered when the two required checks are green AND GitHub reports the pull request `clean`. The
 * merge would be refused otherwise, and an approval nobody can follow with a merge is better made
 * on purpose with `approve` (without `--merge`) than as the side effect of an answer that promised
 * both (ADR 0093).
 */

import type { ApprovalGate, MergeCheck } from "./pr-review-approve.js";

export type NextChoice = "approve" | "close" | "comment" | "details" | "skip" | "quit";

/** What was typed, as a choice; null for anything else, including an empty line. */
export function parseChoice(raw: string): NextChoice | null {
  switch (raw.trim().toLowerCase()) {
    case "y":
    case "yes":
      return "approve";
    case "n":
    case "no":
      return "close";
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

/** The `y` answer: allowed, or why not. Closing and commenting are always allowed. */
export type ApproveVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether `y` may approve and merge this pull request now. The review's own verdict is judged as
 * for `approve` (`gate`): a failing or running review, or one that could not be read, needs
 * `--force`; the others only need the answer. The two required checks must both be green, whatever
 * `--force` says, because the merge that follows would be refused by GitHub, and so must GitHub
 * report the pull request `clean`: an approval that cannot be followed by the merge `y` promises is
 * better made on purpose with `approve`. Any other state is refused, including `unstable` (a check
 * that is not required is not passing, which is how a pull request the automated review holds is
 * reported), `unknown` and one nobody has heard of; `--force` is about the review's verdict and
 * does not reach it.
 */
export function approveAllowed(input: {
  gate: ApprovalGate;
  force: boolean;
  bids: string;
  version: string;
  /**
   * What GitHub's `mergeable_state` allows, as `checkMergeable` made it (asked again while it was
   * `unknown`, and a read that failed or found another head is a refusal that says so). Required,
   * so a caller cannot forget it; only `clean` passes.
   */
  merge: MergeCheck;
}): ApproveVerdict {
  const reasons: string[] = [];
  if (input.bids !== "pass" || input.version !== "pass") {
    reasons.push(
      `A required check is not green (BIDS ${checkWord(input.bids)}, version ${checkWord(input.version)}), so GitHub would not let it merge.`,
    );
  }
  if (!input.merge.ok) reasons.push(input.merge.why);
  if (input.gate.kind === "needs_force" && !input.force) {
    reasons.push(input.gate.reason);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join(" ") };
}

function checkWord(state: string): string {
  switch (state) {
    case "pass":
      return "ok";
    case "fail":
      return "failing";
    case "pending":
      return "pending";
    case "missing":
      return "missing";
    default:
      return "unknown";
  }
}
