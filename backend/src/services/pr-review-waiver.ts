/**
 * An administrator's explicit override of the naming rule, for one commit of one pull request
 * opened by a NEMAR owner or administrator (ADR 0107).
 *
 * Owners and administrators are exempt from the automated review, and not from the naming rule:
 * a title that has an author and a year, or a DOI, anywhere in it, or a change of the dataset's
 * name to such a name, fails their pull request's check like anyone's. The one way past it without
 * a change is this override, asked for by name with
 * `nemar admin pr-reviews allow <dataset> <pr> --admin --reason <why>`:
 *
 *  1. The Worker reads the pull request from GitHub itself (nothing about it comes from the caller)
 *     and holds it to the same gates as a start: the review is on, the dataset is reviewable, the
 *     pull request is open, aimed at `main`, not a draft and not a bot's. The caller may name the
 *     commit it means, as a hex prefix of seven characters or more; if the pull request has moved
 *     on from it, nothing is recorded or posted and the answer is `head_moved` (409). Without a
 *     commit the current one is waived, and the answer names it.
 *  2. Its current commit must not have been reviewed (a review of it stands, whoever acts next),
 *     and its author must be exempt: the override replaces the exemption for this rule, so it is
 *     never a way past a contributor's review. When GitHub does not answer whether the author holds
 *     the repository's admin role, nothing is waived and the answer is an error, not "not exempt".
 *  3. The rule runs again on that commit. When it finds nothing there is nothing to waive, and the
 *     plain `skipped` check is posted. When it could not read the dataset's name there is nothing
 *     definite to waive yet, and nothing is: a waiver covers only what the rule found.
 *  4. Otherwise the waiver is recorded first (`pr_review_naming_waived` in the audit log: who, the
 *     commit, what the rule found as closed words, and the reason given), and then a `skipped`
 *     check that says the rule was waived is posted on the commit. The exempt path reads the same
 *     row, so a later delivery of that commit keeps the waiver for what it recorded; a problem the
 *     rule finds there later that the waiver did not record, and a new commit, are checked again.
 *
 * The reason is required, because it is what the record keeps: a request without one, or with one
 * that has no plain words left once links, mentions and markup are removed (a letter or a digit
 * must remain, so a link alone or punctuation alone is no reason), is a 400 (`bad_reason`) and
 * records and posts nothing.
 *
 * It never approves or merges anything, and it records no pull request text: the audit row holds
 * the rule's closed words, not the title or the name.
 */

import type { WaiveNamingResponse } from "../../../shared/contract/pr-review-admin.js";
import { sanitizeNote } from "../../../shared/pr-review.js";
import { LINK_REMOVED } from "../../../shared/untrusted-text.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { reviewExemption } from "./pr-review-exemption.js";
import { NAMING_WAIVED_ACTION, namingResource } from "./pr-review-naming.js";
import { QueueError, environmentName, ownedHere } from "./pr-review-queue.js";
import { readPullRequest } from "./pr-review-start.js";
import {
  ExemptCheckNotPublished,
  exemptOutcomeFor,
  postExemptCheck,
  readPullRequestEvent,
  reviewableDataset,
} from "./pr-review.js";

/** The most of a reason that is kept, as for a contributor's allow or block. */
const MAX_REASON = 200;

/** What the caller says about the waiver, beyond which pull request it is for. */
export interface WaiveRequest {
  /** Why, as the caller wrote it. Required: a waiver is recorded with its reason. */
  reason: string;
  /**
   * The commit the caller means: a hex prefix of seven characters or more, in either case, checked
   * by the route. The pull request's current commit is waived only if its id starts with this
   * (compared in lowercase, as GitHub writes ids); absent, the current commit is waived whatever it
   * is.
   */
  commit?: string;
}

/**
 * Waive the naming rule for `datasetId#prNumber`'s current commit. The answer says what happened in
 * a fixed word; a pull request that cannot be waived is an answer, not an error, and a dataset this
 * Worker does not own, a pull request GitHub does not have, a pull request that has moved on from
 * the commit the caller named, and a GitHub that does not answer are errors.
 */
export async function waiveNamingRule(
  env: Bindings,
  adminUserId: number,
  datasetId: string,
  prNumber: number,
  { reason, commit }: WaiveRequest,
): Promise<WaiveNamingResponse> {
  const environment = environmentName(env);
  // The reason is what the record keeps, so a reason with no word left in it once links, mentions
  // and markup are taken out (the route has already refused a blank one) is no reason. A link
  // leaves its marker behind, which is not a word, and punctuation alone is not one either: the
  // reason needs a letter or a digit.
  const kept = sanitizeNote(reason, MAX_REASON);
  if (!/[\p{L}\p{N}]/u.test(kept.replaceAll(LINK_REMOVED, ""))) {
    throw new QueueError(
      400,
      "bad_reason",
      "The reason has no plain words in it (links, mentions and markup are removed). Say, in words, why the naming rule is waived.",
    );
  }
  const answer = (
    word: WaiveNamingResponse["reason"],
    rest: Partial<WaiveNamingResponse> = {},
  ): WaiveNamingResponse => ({
    environment,
    waived: false,
    reason: word,
    head_sha: null,
    facts: null,
    ...rest,
  });
  if (!ownedHere(env, datasetId)) {
    throw new QueueError(
      404,
      "not_owned_here",
      "The other environment's Worker answers for that dataset.",
    );
  }
  // With the review off nothing posts a check, so there is no check to turn into a waiver.
  if (env.PR_REVIEW_ENABLED !== "1") return answer("pr_review_disabled");
  const reviewable = await reviewableDataset(env.DB, datasetId);
  if (reviewable !== "reviewable") {
    return answer(reviewable === "unknown" ? "unknown_dataset" : "dataset_not_reviewable");
  }

  const pull = await readPullRequest(env, datasetId, prNumber, "nothing was waived");
  const base = pull.base as { repo?: unknown } | null | undefined;
  const intake = readPullRequestEvent({
    action: "synchronize",
    pull_request: pull,
    repository: base?.repo,
  });
  if (!intake.ok) return answer(intake.reason);
  const pr = intake.pr;
  const head = { head_sha: pr.headSha };

  // The administrator looked at one commit. If the pull request has moved on, what they saw is not
  // what would be waived, so nothing is: not a word recorded, not a check posted.
  if (commit !== undefined && !pr.headSha.startsWith(commit.toLowerCase())) {
    throw new QueueError(
      409,
      "head_moved",
      `The pull request is no longer at that commit (it is at ${pr.headSha.slice(0, 7)} now), so nothing was waived. Look at the new commit and ask again.`,
    );
  }

  // A commit a review has touched keeps what its review said: the waiver is for the exempt path.
  const reviewed = await env.DB.prepare(
    "SELECT 1 AS reviewed FROM pr_reviews WHERE dataset_id = ? AND pr_number = ? AND head_sha = ?",
  )
    .bind(pr.datasetId, pr.prNumber, pr.headSha)
    .first<{ reviewed: number }>();
  if (reviewed) return answer("reviewed", head);
  const exemption = await reviewExemption(env, { login: pr.authorLogin, repo: pr.datasetId });
  if (exemption === "unknown") {
    throw new QueueError(
      502,
      "github_unavailable",
      "GitHub did not say whether the author holds the repository's admin role, so nothing was waived. Ask again in a moment.",
    );
  }
  if (exemption === "not_exempt") return answer("not_exempt", head);

  const outcome = await exemptOutcomeFor(env, pr);
  const facts = outcome.kind === "naming" ? outcome.facts : null;
  // A waiver is for what the rule found. A name it could not read is not a finding, and waiving it
  // would also cover whatever that name turns out to be.
  if (facts?.name === "unchecked") return answer("naming_unchecked", { ...head, facts });
  try {
    if (outcome.kind === "exempt" && !outcome.waived) {
      // Nothing to waive, now: post the check the commit should carry.
      await postExemptCheck(env, pr, outcome);
      return answer("nothing_to_waive", head);
    }
    if (outcome.kind === "exempt") {
      // Already waived for this commit: say so again on the commit, and record nothing twice.
      await postExemptCheck(env, pr, outcome);
      return answer("already_waived", { ...head, waived: true });
    }

    // The record comes first: a waiver that is posted but not recorded would leave no trace of who
    // decided it, and a recorded one whose check did not land is posted again by asking again.
    await auditLogStatement(env.DB, {
      userId: adminUserId,
      action: NAMING_WAIVED_ACTION,
      resourceType: "pr_review",
      resourceId: namingResource(pr.datasetId, pr.prNumber),
      details: JSON.stringify({
        head_sha: pr.headSha,
        title: facts?.title ?? null,
        name: facts?.name ?? null,
        reason: kept,
      }),
    }).run();
    await postExemptCheck(env, pr, { kind: "exempt", waived: true });
  } catch (err) {
    if (err instanceof ExemptCheckNotPublished) {
      throw new QueueError(
        502,
        "github_unavailable",
        "GitHub would not take the check for this pull request. Anything already recorded stands; ask again in a moment to post it.",
      );
    }
    throw err;
  }
  console.info(
    `[pr-review-waiver] ${pr.datasetId}#${pr.prNumber}: naming rule waived for ${pr.headSha.slice(0, 7)} by user ${adminUserId}`,
  );
  return answer("waived", { ...head, waived: true, facts });
}
