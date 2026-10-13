/**
 * Work that follows a callback's answer (ADR 0102): the admin mail, and the review's start.
 *
 * A callback's caller is a workflow with a POST timeout whose retry finds the one-shot token spent,
 * so nothing slow (a Resend send, a GitHub App token and a dispatch of up to ten seconds) sits
 * inside its request. The state the answer reports is stored first; this work finishes after it.
 */

import type { Defer } from "../../services/publication-review.js";
import type { WebhookContext } from "../webhooks/shared.js";

/**
 * A {@link Defer} for this request: it hands the task to the runtime's `waitUntil` and answers
 * true, or answers false when the request has no execution context (an in-process test), and the
 * caller awaits the task itself.
 */
export function deferAfterAnswer(c: WebhookContext): Defer {
  return (task) => {
    try {
      c.executionCtx.waitUntil(task);
      return true;
    } catch {
      return false;
    }
  };
}
