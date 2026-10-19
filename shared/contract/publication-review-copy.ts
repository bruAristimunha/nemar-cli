/**
 * The words the administrator's approval page owns, in one place, so the page and the CLI say the
 * same thing where they must (ADR 0102, Phase 4 of epic #1726; the arrangement of
 * `account-copy.ts`, ADR 0045).
 *
 * **This file is the source of truth.** `nemarOrg/website`'s `src/lib/publication-review-copy.ts`
 * is a transcription of it with the same keys and the same strings. The two repositories share no
 * package, so the values are transcribed rather than imported, and there is a drift test on each
 * side: `test/publication-review-copy-parity.test.ts` here, and the website's own test there, each
 * of which reads the OTHER repository's file as text and compares it key by key. Changing a
 * sentence here means changing it there in the same sitting.
 *
 * **Why a table at all.** The Worker words its refusals for a terminal: the review gate's
 * `needs_override` asks for `--force`, the identifier screen's `acknowledge` quotes a command. A
 * page prints neither, so it words those refusals itself, and this table is those words. A key
 * exists only where the page cannot print what the Worker sends: the gate's and the screen's
 * refusals, the approve control's states, the review's standing words, and the success of a
 * review start, which the Worker answers with a closed word and no sentence.
 *
 * **Four rules this file has to keep, because both drift tests and the mirroring depend on them:**
 *
 * 1. *Every value is a literal string.* No template literals, no concatenation, no interpolation
 *    from a constant: the drift tests read the other repository's file as text, so a computed
 *    value would be invisible to them. Where a sentence embeds a number that lives somewhere else
 *    (`screen_gate.acknowledge` and the 10 to 500 character bounds of the acknowledgment), the
 *    literal is written out and the parity test asserts it still agrees with the constants.
 * 2. *Every value is a complete sentence the page prints as it is*, except
 *    `review.model_summary_label` and `review.model_findings_label`, which are phrases the page
 *    prints in parentheses after a heading. There are no placeholders and no accessor function:
 *    the CLI never reads this file, and the website has its own reader.
 * 3. *Keys are stable and dotted.* They are the mirroring contract; renaming one is a change on
 *    both sides. Every key is mirrored (there is no `cli.` prefix here, unlike `account-copy.ts`).
 * 4. *No value names a terminal.* No command, flag, placeholder or backtick, and none of the words
 *    "terminal", "command" or "CLI". The parity test holds every value to the one list the
 *    web-safety tests use (`test/helpers/terminal-words.ts`).
 *
 * What is deliberately NOT here:
 *
 * - **Words the Worker sends and the page prints.** A reason's `sentence`, `statement` and `cure`,
 *   the identifier screen's headline and lines, the start refusals' `error` and the `message` of
 *   the refusals that name no terminal are web-safe by a pin of their own, so a copy of them here
 *   would be a second place to drift.
 * - **Refusals only `/approve` answers.** The page calls `approve-dispatch`, never `/approve`, so
 *   a key for those would be dead copy.
 * - **The website's existing friendly messages** (`forbidden`, `not_found`, `dispatch_unconfigured`
 *   and the like). They have no CLI counterpart to agree with. A blocked request is not one of
 *   them: the page prints the mirrored `approve.blocked`.
 *
 * The code needs no import from this file and this file imports nothing, so it can be lifted out
 * whole, as `account-copy.ts` can.
 */

/** The copy table. Index it directly; the keys are typed. */
export const PUBLICATION_REVIEW_COPY = {
  // The review gate's refusal words (`REVIEW_GATE_REFUSALS`), by the `refusal` of a 409
  // publication_review_not_clear. `hard_reason` and `unverified` are the Worker's own sentences,
  // which name no terminal; the other four are worded for a page.
  "gate.hard_reason":
    "The publication review gives a reason that no override clears, so the approval is refused.",
  "gate.needs_override":
    "The publication review is not a pass. Read the reasons, then confirm that you approve despite them; the confirmation is recorded with your account.",
  "gate.override_not_covering":
    "The review now gives a reason that your confirmation was not given for. Read the reasons again before approving.",
  "gate.review_changed":
    "The review your confirmation was given for is no longer the review of this request, or it changed while the approval was being checked. Read the reasons again before approving.",
  "gate.no_review_row":
    "No review of this commit is on record to attach your confirmation to. Start the review, then approve.",
  "gate.unverified":
    "The publication review could not be checked just now, so the approval is refused. Try again.",

  // The identifier screen's refusal words, by the `gate` of a 409 identifier_screen_not_clear.
  // `acknowledge` is also the prompt above the reason field before the click.
  "screen_gate.acknowledge":
    "The identifier screen found something a person must look at, or could not read everything. Read what it reported, then give a reason of 10 to 500 characters to approve; the reason is recorded with your account.",
  "screen_gate.blocks":
    "The identifier screen found a direct identifier, which cannot be acknowledged. The depositor must remove it and request publication again, which runs the screen again.",
  "screen_gate.wait":
    "The identifier screen is still running, or its result has just changed. Reload to read its current result.",
  "screen_gate.rerun":
    "The identifier screen has no verdict about the current commit, so approval waits for a screen that produced one. An administrator runs the screen again.",
  "screen_gate.stale":
    "The identifier screen read a commit that is no longer the head of main, so its result is out of date. An administrator runs the screen again.",
  "screen_gate.unverified":
    "The identifier screen's result could not be checked against the current commit just now, so the approval is refused. Try again. If it keeps happening, an administrator runs the screen again.",

  // The approve control.
  "approve.unavailable":
    "The publication review could not be read just now, so Approve is not offered. Reload to try again.",
  "approve.blocked":
    "This request is blocked, so it cannot be approved until the block is cleared.",
  "approve.resume":
    "This approval has started publishing; it passed the gates when it started and is continued without them.",
  "approve.override_control":
    "I have read the reasons above and approve despite them. This records an override with my account.",

  // The review's standing word and the labels on the model's text.
  "review.not_assessed": "Not assessed: whether the text names the depositors.",
  "review.model_summary_label": "written by the model; the depositor's text can steer it",
  "review.model_findings_label": "written by the model; the depositor's text can steer them",

  // A review start that went (HTTP 202), by `reason`.
  "start.dispatched": "The review was started.",
  "start.redispatched": "The review was started again.",
  "start.dispatch_claimed": "A review of this commit was already handed over and stands.",
} as const;

export type PublicationReviewCopyKey = keyof typeof PUBLICATION_REVIEW_COPY;
