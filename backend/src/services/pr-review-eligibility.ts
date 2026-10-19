/**
 * Which datasets the pull-request review applies to, and so which repositories carry the ruleset
 * that requires it (ADR 0107).
 *
 * The Worker decides whether to review a pull request in SQL: `REVIEWABLE_DATASET_PREDICATE` in
 * `services/pr-review.ts`, asked of one dataset by `reviewableDataset`. The tooling that puts the
 * ruleset on repositories (the admin routes, publication, visibility, the drift report) reads many
 * rows at once and has to give the SAME answer without a query for each, so {@link isReviewableRow}
 * is that answer for a row in hand. Two statements of one rule can drift, which is why
 * `backend/test/pr-review-eligibility.test.ts` runs both over every combination of the four columns and
 * fails when they disagree. A change to the rule is a change to both.
 *
 * Nothing here talks to GitHub. The types that name what to do about a repository live with the
 * ruleset (`services/github/branch-protection.ts`); this module only decides which one a dataset
 * calls for.
 */

import type { Bindings } from "../types/bindings.js";
import { RESERVED_FIXTURE_FLOOR, isReservedFixtureId } from "./datasetId.js";
import { type GitHubAppEnv, getGitHubAppConfig } from "./github-auth.js";
import { NEMAR_APP_ID, type ReviewIntent } from "./github/branch-protection.js";

/** The four `datasets` columns the review's rule reads. */
export interface ReviewableRow {
  status: string | null;
  visibility: string | null;
  anonymous: number | null;
  first_published_at: string | null;
}

/**
 * The columns {@link ReviewableRow} is read from, for a `SELECT`. One list, so a query that feeds
 * {@link isReviewableRow} cannot leave one out.
 */
export const REVIEWABLE_ROW_COLUMNS = "status, visibility, anonymous, first_published_at";

/** The first condition a dataset fails, in this order. */
export type NotReviewableReason = "inactive" | "private" | "anonymous" | "unpublished";

/**
 * Why a dataset is not reviewed, or null when it is: a live (active), public, named (not
 * anonymous), first-published dataset is reviewed, and nothing else is. Written as the SQL reads:
 * `anonymous = 0` is not true of a NULL, so a missing value is not reviewable either.
 */
export function notReviewableReason(row: ReviewableRow): NotReviewableReason | null {
  if (row.status !== "active") return "inactive";
  if (row.visibility !== "public") return "private";
  if (row.anonymous !== 0) return "anonymous";
  if (row.first_published_at === null || row.first_published_at === undefined) return "unpublished";
  return null;
}

/** Whether the Worker reviews pull requests to this dataset: the row-in-hand form of the SQL rule. */
export function isReviewableRow(row: ReviewableRow): boolean {
  return notReviewableReason(row) === null;
}

/** Whether the review is switched on in this environment. Exactly "1", as the Worker reads it. */
export function isReviewEnabled(env: Pick<Bindings, "PR_REVIEW_ENABLED">): boolean {
  return env.PR_REVIEW_ENABLED === "1";
}

/**
 * Whether the automatic paths (publishing a dataset, a visibility change, the enforce routes) may
 * put the review ruleset ON a repository. Exactly "1"; unset is off. It gates the requirement and
 * nothing else: taking the ruleset off a repository whose dataset is not reviewed is never held
 * back by it ({@link automaticReviewIntent}), because a dataset made private while the switch is
 * off would otherwise keep a ruleset that nothing can satisfy.
 *
 * It is a switch of its own, apart from {@link isReviewEnabled}, because the review runs from the
 * day the Worker is deployed and the requirement is the owner's step: the owner turns this on when
 * the fleet step of the rollout starts, after the canary and the calibration gate, and it is never
 * on before. The explicit tools (the review-ruleset routes and `nemar admin fleet require-review`)
 * do not read it.
 */
export function isAutoRequireEnabled(env: Pick<Bindings, "PR_REVIEW_AUTO_REQUIRE">): boolean {
  return env.PR_REVIEW_AUTO_REQUIRE === "1";
}

/**
 * What the `GITHUB_APP_ID` binding holds, as far as an answer may say: nothing (`unset`), something
 * that is not an App id (`not_a_number`, whatever it is, which is never repeated: a value pasted
 * there by mistake can be a secret), or an id. They are three different things to fix.
 */
export type AppIdState = "unset" | "not_a_number" | "id";

/**
 * The GitHub App ids that decide whether a requirement can ever be met. The ruleset requires the
 * `NEMAR PR Review` check from the App with id {@link NEMAR_APP_ID}, and this Worker posts that
 * check as the App whose id is its `GITHUB_APP_ID` binding. `github_app_id` is that binding when it
 * is a plain number and null otherwise, `github_app_id_state` says which of the three cases the
 * binding is in (an unset binding and a value that is not an id are both null in the first field
 * and are told apart by the second), `ruleset_app_id` is the one the ruleset names, and
 * `app_id_matches` is whether they are the same App: exactly the same digits, with nothing around
 * them. The right id is not enough: the check is posted with an installation token for the
 * `nemarDatasets` organization, which needs the App's private key and that organization's
 * installation id, and without them the Worker falls back to a personal access token, which GitHub
 * does not let post a check run. `installation_configured` is whether the Worker holds both.
 */
export interface ReviewAppIds {
  github_app_id: string | null;
  github_app_id_state: AppIdState;
  ruleset_app_id: number;
  app_id_matches: boolean;
  installation_configured: boolean;
}

export function reviewAppIds(env: GitHubAppEnv): ReviewAppIds {
  const raw = env.GITHUB_APP_ID;
  const isId = typeof raw === "string" && /^\d{1,15}$/.test(raw);
  return {
    github_app_id: isId ? raw : null,
    github_app_id_state: isId ? "id" : raw ? "not_a_number" : "unset",
    ruleset_app_id: NEMAR_APP_ID,
    app_id_matches: raw === String(NEMAR_APP_ID),
    // Decided by getGitHubAppConfig, the single place that says whether App authentication is
    // available and the one getDatasetsToken, which posts the check, goes by: with no installation
    // id for the organization it falls back to the personal access token.
    installation_configured:
      getGitHubAppConfig(env)?.installationIdsByOrg.nemarDatasets !== undefined,
  };
}

/**
 * The last sentence of every refusal of a requirement: the way out is never refused. It is the
 * same for the three reasons, so it is said once, here. A refusal's sentence says nothing about
 * whether anything was changed: it is also what one row of a page says, and on a page other rows
 * may have been changed. The route that answers one dataset adds that nothing was.
 */
export const REMOVAL_IS_NEVER_REFUSED =
  "Taking the ruleset off is never refused, whether it is asked for or the dataset is not one the review covers.";

/**
 * Why the review ruleset must not be REQUIRED from this Worker, or null when it may be: the ruleset
 * requires the check from the App with id {@link NEMAR_APP_ID}, so unless the Worker posts as that
 * App the check never arrives, and every pull request on the repository waits for it for good.
 * The sentence names both ids. This is the App's id only; being able to sign in as it is
 * {@link reviewAppInstallationRefusal}. Nothing is read or written to produce it; a removal is
 * never refused by it, because taking the ruleset off needs no check to arrive.
 */
export function reviewAppIdRefusal(env: Pick<Bindings, "GITHUB_APP_ID">): string | null {
  const ids = reviewAppIds(env);
  if (ids.app_id_matches) return null;
  const posts =
    ids.github_app_id_state === "id"
      ? `the App with id ${ids.github_app_id}`
      : ids.github_app_id_state === "not_a_number"
        ? "an App whose id is not a number (GITHUB_APP_ID is set but is not a plain number)"
        : "no App (GITHUB_APP_ID is not set)";
  return `The review ruleset requires the NEMAR PR Review check from the GitHub App with id ${ids.ruleset_app_id}, but this Worker posts the check as ${posts}, so the check would never arrive and requiring it would block every merge. ${REMOVAL_IS_NEVER_REFUSED}`;
}

/**
 * Why the review ruleset must not be REQUIRED from this Worker although it posts as the right App,
 * or null when it may be: the check is posted with an installation token for `nemarDatasets`, and
 * without the App's private key or that organization's installation id the Worker falls back to a
 * personal access token (`getDatasetsTokenWithRefresher`), which cannot post a check run. So the
 * check would never arrive. Nothing is read or written to produce it, and a removal is never
 * refused by it.
 */
export function reviewAppInstallationRefusal(env: GitHubAppEnv): string | null {
  if (reviewAppIds(env).installation_configured) return null;
  return `This Worker cannot sign in as the GitHub App for the nemarDatasets organization: GITHUB_APP_PRIVATE_KEY or GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS is missing or not valid. It would post the NEMAR PR Review check with a personal access token instead, and GitHub does not let a personal access token post a check run, so the check would never arrive and requiring it would block every merge. ${REMOVAL_IS_NEVER_REFUSED}`;
}

/** The words a refusal about the GitHub App can carry as its `code`. */
export type ReviewAppRefusalCode = "review_app_mismatch" | "review_app_not_configured";

/**
 * Why the check could not arrive from this Worker, as a code and a sentence, or null when it can:
 * the Worker posts as another App ({@link reviewAppIdRefusal}), or as the right one without a way
 * to sign in as it ({@link reviewAppInstallationRefusal}). The id is said first, because an unset or
 * wrong id is also what makes the installation unusable.
 */
export function reviewAppRefusal(
  env: GitHubAppEnv,
): { code: ReviewAppRefusalCode; sentence: string } | null {
  const id = reviewAppIdRefusal(env);
  if (id) return { code: "review_app_mismatch", sentence: id };
  const installation = reviewAppInstallationRefusal(env);
  if (installation) return { code: "review_app_not_configured", sentence: installation };
  return null;
}

/**
 * Whether the requirement may be put on by anything that acts on its own, or measured against by
 * the drift report: the review itself is on (so something posts the check) AND the owner's switch
 * is on. The one definition of "the requirement is the target", so the paths that write and the
 * report that reads cannot disagree about it.
 */
export function isRequirementTarget(
  env: Pick<Bindings, "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE">,
): boolean {
  return isReviewEnabled(env) && isAutoRequireEnabled(env);
}

/**
 * The dataset ids the ruleset tooling never touches: the top 100 ids of the `nm` prefix
 * (nm099900 to nm099999), which the fixture rule reserves for standing test fixtures. They are the
 * end-to-end dataset (nm099999), the standing anonymous deposit (nm099998) and the fixtures that
 * follow downward from them. They are named by the band and not as a list, because a list would
 * have to be edited for each new fixture and a fixture left off it would be changed by a batch.
 *
 * The `xx` band is not excluded: its exemplar fleet (xx099900 and up) is the staging copy a
 * ruleset is first tried on, and it belongs to the staging Worker alone.
 */
export function isReviewRulesetFixture(datasetId: string): boolean {
  return datasetId.startsWith("nm") && isReservedFixtureId(datasetId);
}

/**
 * {@link isReviewRulesetFixture} as a condition on `dataset_id` for a `WHERE`: true for a row
 * OUTSIDE the band. `sql` has one placeholder, and `bind` is the value for it. It reads the same
 * floor the function does, so the two are one rule, and a test checks that they agree. The bound
 * value is a constant; nothing a caller sends reaches the SQL.
 */
export const OUTSIDE_FIXTURE_BAND = {
  sql: "NOT (substr(dataset_id, 1, 2) = 'nm' AND CAST(substr(dataset_id, 3) AS INTEGER) >= ?)",
  bind: RESERVED_FIXTURE_FLOOR,
} as const;

/**
 * What a dataset's row calls for: take the ruleset off a dataset that is not reviewed, put it on
 * one that is, and, while `requirementOn` is false, leave a reviewed dataset's ruleset alone
 * (`undefined`). Requiring a check that nothing is posting would block every merge, so the
 * requirement is never put on while it is not the target ({@link isRequirementTarget}); lifting it
 * never waits for anything.
 *
 * This is the row's answer and nothing more. The drift report asks it directly, with
 * {@link isRequirementTarget} as `requirementOn`. The paths that WRITE on their own, publishing, a
 * visibility change and `enforce`, ask {@link automaticReviewIntent}, which passes the same.
 *
 * A standing test fixture ({@link isReviewRulesetFixture}) calls for nothing, whatever its row
 * says: the tooling does not touch its repository's rulesets in either direction.
 */
export function reviewIntentOf(
  datasetId: string,
  row: ReviewableRow,
  requirementOn: boolean,
): ReviewIntent | undefined {
  if (isReviewRulesetFixture(datasetId)) return undefined;
  if (!isReviewableRow(row)) return "remove";
  return requirementOn ? "require" : undefined;
}

/**
 * What the AUTOMATIC paths ask of a repository, which are publishing a dataset, a visibility change
 * and the enforce routes: {@link reviewIntentOf} with the requirement on only while
 * {@link isRequirementTarget}. So the switch gates the ADDITION and nothing else. Until the owner
 * has started the fleet step a reviewed dataset gets `undefined` (its ruleset is left exactly as it
 * is, and the caller makes no ruleset call for it), but a dataset that is not reviewed still gets
 * `remove`: a dataset made private while the switch is off must not keep a ruleset that nothing
 * will satisfy. This is the one place the owner's switch is read for a path that writes, so a path
 * that asks here cannot require the review before the owner has started the fleet step.
 *
 * A requirement is also not asked for from a Worker that cannot post the check as the App the
 * ruleset names ({@link reviewAppRefusal}): another App, or no way to sign in as the right one. The
 * check would never arrive. There is no caller to refuse with a status here, so that case is
 * `undefined` (the ruleset is left as it is) and an error in the log that says why, and the
 * explicit routes, which do refuse with a status, say it plainly.
 */
export function automaticReviewIntent(
  env: Pick<Bindings, "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE"> & GitHubAppEnv,
  datasetId: string,
  row: ReviewableRow,
): ReviewIntent | undefined {
  const intent = reviewIntentOf(datasetId, row, isRequirementTarget(env));
  if (intent !== "require") return intent;
  const refusal = reviewAppRefusal(env);
  if (refusal) {
    console.error(
      `[review-ruleset] not requiring the review for ${datasetId}: ${refusal.sentence}`,
    );
    return undefined;
  }
  return intent;
}

/**
 * {@link automaticReviewIntent} for a dataset, read from the catalog now. A dataset the catalog
 * does not hold has no answer (`undefined`: touch nothing), and neither has one whose row could not
 * be read. The read is made while the lifecycle code is bringing a repository to its spec, with the
 * branch ruleset and the collaborators still to do, so a failure is logged and leaves the review
 * ruleset as it is instead of costing the rest of that work. The drift report shows a repository
 * left out of step. The row is read whether or not the switch is on, because a dataset that is not
 * reviewed has its ruleset taken off either way, and so that the decision stays in the one
 * function.
 */
export async function readReviewIntent(
  env: Pick<Bindings, "DB" | "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE"> & GitHubAppEnv,
  datasetId: string,
): Promise<ReviewIntent | undefined> {
  try {
    const row = await env.DB.prepare(
      `SELECT ${REVIEWABLE_ROW_COLUMNS} FROM datasets WHERE dataset_id = ?`,
    )
      .bind(datasetId)
      .first<ReviewableRow>();
    return row ? automaticReviewIntent(env, datasetId, row) : undefined;
  } catch (e) {
    console.error(
      `[review-ruleset] could not read ${datasetId} to decide its review ruleset; leaving it as it is:`,
      e,
    );
    return undefined;
  }
}
