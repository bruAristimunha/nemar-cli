/**
 * Admin commands for NEMAR CLI
 *
 * These commands require admin privileges.
 *
 * Commands:
 * - nemar admin users              - List users (pending, approved, all), or search every field
 * - nemar admin users show/edit    - Look up one account's details; edit a closed set of fields
 * - nemar admin approve            - Approve a pending user
 * - nemar admin revoke             - Revoke user access
 * - nemar admin role               - Change a user's role (owner only)
 * - nemar admin s3 regenerate-iam  - Regenerate AWS credentials for a user
 * - nemar admin repo public/private - Change repository visibility
 * - nemar admin ci check/add       - Manage CI workflows
 * - nemar admin doi create/info/update/enrich - DOI management
 * - nemar admin publish list/deny/approve - Publication workflow
 * - nemar admin revert             - Revert dataset to a previous version
 * - nemar admin withdraw/restore   - Withdraw/restore a published dataset (visibility + EZID DOIs)
 * - nemar admin recover [status]   - Re-copy epic #967 imports whose upstream is accessible
 * - nemar admin email-preferences show/update - Email notification opt-out
 * - nemar admin notice list/set/clear - System notice management
 * - nemar admin notify              - Send broadcast email to users
 * - nemar admin pr-reviews          - Dataset pull requests awaiting approval, with the automated review
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora, { type Ora } from "ora";
import { formatBytesCli } from "../../shared/bytes.js";
import {
  ADMIN_USER_DESCRIPTIVE_FIELDS,
  ADMIN_USER_IDENTITY_FIELDS,
  ADMIN_USER_SEARCH_MAX_TERMS,
  ADMIN_USER_SEARCH_MAX_TERM_CHARS,
} from "../../shared/contract/admin-user.js";
import {
  ACCOUNT_KIND_VALUES,
  type DuplicateGroup,
  OPERATIONAL_ACCOUNT_KINDS,
  isAccountKind,
} from "../../shared/contract/index.js";
import {
  NEUROBAGEL_CHECKS,
  NEUROBAGEL_REGENERATE_MAX,
  neurobagelVerdictExitCode,
  neurobagelVerificationState,
} from "../../shared/contract/neurobagel-admin.js";
import { weeklyAttention } from "../../shared/contract/weekly-attention.js";
import {
  PUBLICATION_STEPS,
  PUBLICATION_STEP_LABELS,
  stepsForRelease,
} from "../../shared/publication-steps.js";
import {
  CLEAR_FLAGS,
  EDIT_FLAG_FIELDS,
  type LookupMatch,
  allFuzzy,
  candidateLine,
  displayEditValue,
  editBodyFromOptions,
  exactHit,
  flagName,
  planEdit,
  resolveLookup,
  searchWasUnderstood,
  userDetailLines,
} from "../lib/admin-user-lookup.js";
import {
  type AnonymitySweepBatchResponse,
  type AvailabilityReport,
  type AvailabilityReportResult,
  type AvailabilityReportSweepBatchResponse,
  type BackfillNamesResponse,
  type BackfillUsernamesResponse,
  type DataIntegritySweepBatchResponse,
  type DatasetTransitionResponse,
  type DoctorFixLiveResponse,
  type DoctorFixResult,
  type DoctorScanResponse,
  type EmailPreferences,
  type HedSweepBatchResponse,
  type ImportCoverageResponse,
  type ImportIssueTriageResponse,
  type NeurobagelRunResult,
  type NeurobagelStatus,
  type NeurobagelVerification,
  type NeurobagelVerifyResult,
  type RecordingStatsSweepBatchResponse,
  type ReindexBulkOptions,
  type ReindexBulkResponse,
  type ReindexFilter,
  type ReindexOptions,
  type ReindexResponse,
  type SignalDefaultsSweepBatchResponse,
  type SummaryVersionCoverage,
  type UserListItem,
  type WeeklySummaryResponse,
  type ZarrFidelitySweepBatchResponse,
  addCi,
  anonymitySweep,
  anonymitySweepReset,
  approveUser,
  approveUserById,
  availabilityReport,
  availabilityReportSweep,
  availabilityReportSweepReset,
  backfillUserNames,
  backfillUsernames,
  bulkDeleteDatasets,
  changeUserRole,
  changeVisibility,
  clearIdentityConflict,
  createConceptDoi,
  createExemplar,
  createKeyFor,
  dataIntegritySweep,
  dataIntegritySweepReset,
  deleteDataset,
  dispatchCooldown,
  dispatchManifest,
  doctorFix,
  doctorScan,
  editAdminUser,
  enforceBulk,
  enforceDataset,
  getAdminUserById,
  getAdminUserByUsername,
  getCiStatus,
  getDoiInfo,
  getEmailPreferences,
  getFleetDrift,
  getImportStatus,
  getNeurobagelStatus,
  getSummaryCoverage,
  getUserDuplicates,
  hedSweep,
  hedSweepReset,
  importCoverageSweep,
  importIssueTriage,
  importWeeklySummary,
  listKeysFor,
  listUsers,
  neurobagelRegenerate,
  neurobagelVerify,
  publishDataset,
  publishZarrCatalog,
  recordingStatsSweep,
  recordingStatsSweepReset,
  reindexBulk,
  reindexDataset,
  remintExemplarDois,
  restoreDataset,
  retryImport,
  revalidateDataset,
  revokeKeyFor,
  revokeUser,
  revokeUserById,
  rollbackImport,
  sendBroadcast,
  setAccountKind,
  signalDefaultsSweep,
  signalDefaultsSweepReset,
  syncCi,
  updateDoi,
  updateEmailPreferences,
  uploadTierOf,
  validateCi,
  verifyImport,
  withdrawDataset,
  zarrFidelitySweep,
} from "../lib/api/admin.js";
import { applyS3Lock, getDatasetFiles } from "../lib/api/data.js";
import {
  type Dataset,
  type NemarMetadataPayload,
  ORCID_REGEX,
  finalizeDataset,
  getDataset,
  listDatasets,
  submitEnrichment,
} from "../lib/api/datasets.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import {
  NOTICE_LEVELS,
  type NoticeLevel,
  createNotice,
  deleteNotice,
  listAdminNotices,
} from "../lib/api/notices.js";
import {
  type PublishProgressInfo,
  type StepResult,
  approvePublication,
  denyPublication,
  getPublishStatus,
  listPublishRequests,
  rerunIdentifierScreen,
} from "../lib/api/publish.js";
import { getConfig, isAuthenticated } from "../lib/config.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
  confirmWithInput,
} from "../lib/confirm.js";
import { markReportedExit } from "../lib/debug-log.js";
import { fetchDocsPages, getDocsUrl } from "../lib/docs-fetch.js";
import { CLI_LIVE_DATASETS, selectRevalidateTargets } from "../lib/fleet.js";
import {
  cloneDataset,
  commitRevert,
  createRevertBranch,
  pushBranch,
} from "../lib/git-annex/clone-push.js";
import { checkDownloadPrerequisites } from "../lib/git-annex/prereq.js";
import { getVersionCommit, listDatasetVersions } from "../lib/git-annex/repo-state.js";
import { identifierScreenLines } from "../lib/identifier-screen-display.js";
import {
  type RecoverDatasetEntry,
  loadRecoverDatasets,
  resolveImportSources,
  resolveRecoverTargets,
} from "../lib/recover-datasets.js";
import { sanitizeSnippetText as safeText } from "../lib/render/snippet.js";
import {
  type WithdrawnDatasetEntry,
  loadWithdrawnDatasets,
  resolveWithdrawTargets,
  stillWithdrawn,
} from "../lib/withdrawn-datasets.js";
import { prReviewsCommand } from "./admin-pr-reviews.js";

/**
 * Hints keyed on a publication `block_reason`, which outrank the status-code
 * hint: a 422 from the publish paths is not always a CI problem, and telling
 * an admin to "fix the CI issues" when the real problem is a missing
 * researcher name sends them to the wrong place entirely (#1255).
 */
const BLOCK_REASON_HINTS: Record<string, string> = {
  owner_name_missing:
    "Run `nemar admin backfill-names --apply` if the owner's ORCID record publishes their name; an ORCID-linked owner must otherwise make it public on ORCID and sign in again, and an owner with no linked ORCID can now type it into Settings on nemar.org (ADR 0042).",
};

/** Handle common error patterns in admin CLI commands */
function handleCommandError(
  error: unknown,
  spinner: ReturnType<typeof ora>,
  defaultMsg: string,
  hints?: Record<number, string>,
): void {
  if (error instanceof ApiError) {
    spinner.fail(error.message);
    const reasonHint = error.blockReason ? BLOCK_REASON_HINTS[error.blockReason] : undefined;
    const hint = reasonHint ?? hints?.[error.statusCode];
    if (hint) {
      console.log(chalk.dim(`  ${hint}`));
    } else if (error.statusCode === 403) {
      console.log(chalk.dim("  This command requires admin privileges"));
    }
  } else {
    spinner.fail(defaultMsg);
    console.log(chalk.dim(`  Error details: ${errorDetail(error)}`));
  }
}

/**
 * Fetch a file from a GitHub repo via the gh CLI, returning its decoded content.
 * Uses the /readme endpoint for READMEs, /contents/{path} for other files.
 * Returns null if the file does not exist or the command fails.
 */
async function fetchGitHubFileContent(repoName: string, path: string): Promise<string | null> {
  const { spawn: bunSpawn } = await import("bun");
  const endpoint =
    path === "README" ? `repos/${repoName}/readme` : `repos/${repoName}/contents/${path}`;
  const proc = bunSpawn({
    cmd: ["gh", "api", endpoint, "--jq", ".content"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const base64Content = await new Response(proc.stdout).text();
  const stderrContent = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    // Log non-404 errors so we can distinguish "not found" from real failures
    if (stderrContent.trim() && !stderrContent.includes("404")) {
      console.warn(`[fetchGitHubFileContent] Error fetching ${path}: ${stderrContent.trim()}`);
    }
    return null;
  }
  if (!base64Content.trim()) return null;
  return Buffer.from(base64Content.trim(), "base64").toString("utf-8");
}

export const adminCommand = new Command("admin")
  .description("Admin commands (requires admin privileges)")
  .addHelpText(
    "after",
    `
Description:
  Administrative commands for managing NEMAR users and datasets.
  These commands require admin privileges.

User Management:
  users          - List users and their status
  approve        - Approve a pending user registration
  revoke         - Revoke user access
  role           - Change a user's role (owner only: owner > admin > member)

Dataset Management:
  repo            - Manage repository visibility (public/private)
  ci              - Manage CI workflows (check status, deploy)
  s3              - S3/IAM credential management
  doi             - Create and manage DOIs for datasets
  publish         - Publication workflow management
  revert          - Revert dataset to previous version (via PR)
  make-public     - Publish a dataset (permanent, irreversible)
  delete-dataset    - Delete a dataset and all associated resources
  import-openneuro  - Import an OpenNeuro dataset into NEMAR
  withdraw          - Withdraw a broken published dataset (private + DOI tombstone), reversible
  restore           - Reverse a withdrawal (public + DOI restore)

Examples:
  $ nemar admin users --verified           # List users awaiting approval
  $ nemar admin users --role admin         # List all admins
  $ nemar admin approve john_doe           # Approve a user
  $ nemar admin approve --id 123           # Approve a web/ORCID user (no username)
  $ nemar admin role john_doe admin        # Promote user to admin (owner only)
  $ nemar admin repo public nm000104       # Make dataset repo public
  $ nemar admin ci check nm000104          # Check CI status
  $ nemar admin s3 regenerate-iam john_doe # Regenerate AWS credentials
  $ nemar admin doi create nm000104        # Create concept DOI`,
  );

/**
 * Check authentication and show error if not authenticated
 */
function requireAuth(): boolean {
  if (!isAuthenticated()) {
    console.log(chalk.red("Error: Not authenticated"));
    console.log(chalk.dim("  Run 'nemar auth login' first"));
    return false;
  }
  return true;
}

// ============================================================================
// Users
// ============================================================================

const adminUsersCommand = adminCommand
  .command("users")
  .description("List and search NEMAR users; 'show' and 'edit' work on one account")
  // A stray word (`nemar admin users ada`) would otherwise be ignored and the
  // command would list EVERY account, which is the wrong answer to someone
  // looking for one person. Commander 12 allows excess arguments by default.
  .allowExcessArguments(false)
  .option(
    "-s, --search <text>",
    "Find accounts by any field: name, email, GitHub, ORCID, affiliation, id, dates, ...",
  )
  .option("--include-deleted", "Include deleted (tombstoned) accounts")
  .option("--pending", "Show only pending approval")
  .option("--verified", "Show only verified (base tier: browse, no upload access)")
  .option("--approved", "Show only approved users")
  .option("--revoked", "Show only revoked users")
  .option("--no-upload-access", "Show only accounts without upload access")
  .option("--awaiting-approval", "Show accounts with an open upload-access request")
  .option("--role <role>", "Filter by role: owner, admin, or member")
  .option("--kind <kind>", "Filter by account kind: person, service, or test")
  .addHelpText(
    "after",
    `
Tiers (ADR 0040):
  browse   base tier: browse, dashboard, settings, CLI API key, and sandbox
           training (ADR 0040 phase 2, landed)
  upload   an admin granted upload access; 'nemar admin approve' is the grant
  unknown  the API reported no tier for this account (a backend older than
           the tier split, or a rolling deploy)

Search (--search):
  Every word must be found, in any field of the account, in any order; case does
  not matter, and part of a word is enough (a first name, or "lovel" for
  Lovelace). Passwords, tokens and keys are never searched or shown. Each result
  says which fields matched; the best matches come first. Combine it with any
  filter above.

  If the text is exactly one account's id, username, email, GitHub handle or ORCID
  iD, that account's details are shown straight away, with any other matches
  listed beneath. If nothing matches, the closest accounts are offered instead
  (a typo or a missing accent: "lovelase", "ekstrom"), labelled as near misses.

Examples:
  $ nemar admin users                    # List all users
  $ nemar admin users --search lovelace  # Find an account by anything
  $ nemar admin users -s "ada san diego" # Name plus affiliation
  $ nemar admin users -s 0000-0002-1825-0097  # By ORCID iD
  $ nemar admin users -s 2026-09 --role admin # Admins with any date in September 2026
  $ nemar admin users show lovelace      # One account's full details
  $ nemar admin users edit lovelace --affiliation "UC San Diego"  # Edit (see 'edit --help')
  $ nemar admin users --awaiting-approval # Open upload-access requests
  $ nemar admin users --no-upload-access # Every account without the upload grant
  $ nemar admin users --role admin       # List all admins
  $ nemar admin users --role owner       # List all owners
  $ nemar admin users --approved --role member  # Approved regular users
  $ nemar admin users --kind test        # List every test-kind account`,
  )
  .action(async (options) => {
    if (!requireAuth()) return;

    // Commander turns `--no-upload-access` into `uploadAccess`, defaulting to
    // true and set false when the flag is passed.
    const noUploadAccess = options.uploadAccess === false;
    // --awaiting-approval now means what it says (ADR 0042, #1253): an account
    // that ASKED for upload access and has not been granted it. Phase 1 could
    // only approximate that as "verified with no grant" — every base-tier
    // account, whether or not anyone wanted to upload — because there was no
    // request to read.
    //
    // The narrowing is entirely server-side: an open request is
    // `upload_access_requested_at` set, no grant, and `status='verified'`, and
    // the route applies all three. `status=verified` is still sent as well
    // because the pre-#1253 backend this CLI may be talking to knows only that
    // half, and it is a true property of every open request either way.
    const awaitingApproval = options.awaitingApproval === true;

    // Determine status filter
    let status: string | undefined;
    if (options.pending) status = "pending";
    else if (options.verified) status = "verified";
    else if (options.approved) status = "approved";
    else if (options.revoked) status = "revoked";

    if (awaitingApproval) {
      if (status && status !== "verified") {
        console.error(
          chalk.red(
            `--awaiting-approval implies --verified; it cannot be combined with --${status}`,
          ),
        );
        process.exit(1);
      }
      status = "verified";
    }

    // Validate role filter
    const role: string | undefined = options.role;
    if (role && !["owner", "admin", "member"].includes(role)) {
      console.error(chalk.red(`Invalid role '${role}'. Must be: owner, admin, or member`));
      process.exit(1);
    }

    // Validate kind filter (epic #1272 phase 4, #1284; ADR 0048).
    const kindOption: string | undefined = options.kind;
    if (kindOption !== undefined && !isAccountKind(kindOption)) {
      console.error(
        chalk.red(`Invalid kind '${kindOption}'. Must be: ${ACCOUNT_KIND_VALUES.join(", ")}`),
      );
      process.exit(1);
    }
    const kind = kindOption;

    // An empty search is refused here and again by the backend, never treated
    // as "no search": someone looking up one person must not be handed the
    // whole directory because a shell variable came out empty (ADR 0096).
    const search: string | undefined = options.search;
    if (search !== undefined && search.trim() === "") {
      console.error(chalk.red("--search needs at least one word to look for"));
      process.exit(1);
    }
    // The same limits the backend enforces, refused here so it costs no request.
    if (search !== undefined) {
      const words = search.split(/\s+/).filter(Boolean);
      if (
        words.length > ADMIN_USER_SEARCH_MAX_TERMS ||
        words.some((word) => word.length > ADMIN_USER_SEARCH_MAX_TERM_CHARS)
      ) {
        console.error(
          chalk.red(
            `--search takes at most ${ADMIN_USER_SEARCH_MAX_TERMS} words of ${ADMIN_USER_SEARCH_MAX_TERM_CHARS} characters; narrow it with --role or --kind instead`,
          ),
        );
        process.exit(1);
      }
    }
    const includeDeleted = options.includeDeleted === true;

    const spinner = ora(search !== undefined ? "Searching users..." : "Fetching users...").start();

    try {
      const result = await listUsers(status, role, awaitingApproval, kind, {
        search,
        includeDeleted,
      });
      spinner.stop();

      // A backend that predates `?q=` ignores it and returns every account, and
      // printing that under a "search" label would hand an admin the whole
      // directory as if it were the answer. The kind and tier filters below
      // guard the same rollout case; a search response always carries
      // `match_kind`, so its absence on every row is the tell.
      if (search !== undefined && !searchWasUnderstood(result.users)) {
        process.exitCode = 1;
        markReportedExit();
        console.error(
          chalk.red(
            "This NEMAR backend does not support --search yet, so the accounts it returned are not search results. Update the backend, or filter with --role or --kind.",
          ),
        );
        return;
      }

      // The TIER filters are applied here rather than server-side: the listing
      // is unpaginated, so there is nothing to gain from a new query param.
      // (--awaiting-approval is the exception and is filtered server-side; the
      // client-side pass below still runs for it, which is what keeps a backend
      // that predates #1253 — and so ignores the query param entirely — from
      // presenting every verified account as an open request.)
      //
      // Both filters select an EXPLICIT "browse", never an unreported tier: a
      // backend that does not send `service_access` would otherwise dump every
      // account into "needs approving", which is the opposite of what an admin
      // asked for (ADR 0040).
      const tierFiltered =
        noUploadAccess || awaitingApproval
          ? result.users.filter((u) => uploadTierOf(u) === "browse")
          : result.users;
      // Same reasoning as the tier filter above, for `--kind` (epic #1272
      // phase 4, #1284 review; ADR 0048): `?kind=` is sent server-side too,
      // but a backend that predates this phase ignores an unrecognized
      // query param and would otherwise return every account unfiltered.
      // Re-narrowing here client-side means an older backend cannot produce
      // a listing mislabeled as "just the test accounts" when it is really
      // everyone.
      const users = kind ? tierFiltered.filter((u) => u.account_kind === kind) : tierFiltered;
      const unknownTierCount = result.users.filter((u) => uploadTierOf(u) === "unknown").length;

      const filterLabel = [
        status,
        search !== undefined ? `search="${search.trim()}"` : "",
        role ? `role=${role}` : "",
        kind ? `kind=${kind}` : "",
        awaitingApproval ? "awaiting-approval" : noUploadAccess ? "no-upload-access" : "",
      ]
        .filter(Boolean)
        .join(", ");

      if (users.length === 0) {
        console.log(
          chalk.yellow(`No users found${filterLabel ? ` (filter: ${filterLabel})` : ""}`),
        );
        return;
      }

      // A search that names ONE account outright (its id, username, email,
      // GitHub handle or ORCID iD) goes straight to it, as a search box does
      // with an exact hit, and lists whatever else matched beneath (ADR 0096).
      // What counts as "outright" is the server's call (`match_kind`).
      if (search !== undefined) {
        const hit = exactHit(users);
        if (hit) {
          const { user: detail } = await getAdminUserById(hit.id, includeDeleted);
          console.log();
          for (const line of userDetailLines(detail)) console.log(line);
          console.log();
          const others = users.filter((u) => u.id !== hit.id);
          if (others.length > 0) {
            console.log(
              chalk.dim(
                `${others.length} other account${others.length === 1 ? "" : "s"} also match "${search.trim()}":\n`,
              ),
            );
            for (const other of others) console.log(candidateLine(other));
            console.log();
          }
          return;
        }
      }

      // Nothing matched as typed, so these are near misses (a typo, an accent):
      // say so, rather than present them as hits.
      console.log(
        search !== undefined && allFuzzy(users)
          ? `\n${chalk.yellow(`No exact matches for "${search.trim()}". Closest ${users.length === 1 ? "account" : `${users.length} accounts`}:`)}\n`
          : `\n${chalk.cyan("NEMAR Users")} (${users.length} total${filterLabel ? `, filter: ${filterLabel}` : ""})\n`,
      );

      // Display users in a clean format
      for (const user of users) {
        const statusColor =
          {
            pending: chalk.dim,
            verified: chalk.yellow,
            approved: chalk.green,
            revoked: chalk.red,
          }[user.status] || chalk.white;

        const userRole = user.role || "member";
        const roleBadge =
          userRole === "owner"
            ? chalk.red(" [owner]")
            : userRole === "admin"
              ? chalk.magenta(" [admin]")
              : chalk.dim(" [member]");
        const verifiedBadge = user.email_verified ? "" : chalk.dim(" (unverified)");

        // Web/ORCID accounts have username = NULL by design (#1012), so the
        // heading falls back to the email and carries the numeric id — the
        // only key `nemar admin approve --id` can address them by. Printing
        // the raw field would put the literal "null" in the listing.
        const heading = safeText(user.username ?? user.email);
        // A search is how an admin finds the id `show` and `edit` take, so the
        // id is printed on every row of one; a plain listing keeps it to the
        // rows that have no username to address them by.
        const idHint = user.username
          ? search !== undefined
            ? chalk.dim(` (id ${user.id})`)
            : ""
          : chalk.dim(` (no username, id ${user.id})`);
        const realName = safeText([user.given_name, user.family_name].filter(Boolean).join(" "));
        const tier = {
          upload: chalk.green("upload"),
          browse: chalk.dim("browse"),
          unknown: chalk.dim("unknown"),
        }[uploadTierOf(user)];

        console.log(`  ${chalk.cyan(heading)}${roleBadge}${idHint}`);
        if (realName) console.log(`    Name:    ${realName}`);
        console.log(`    Email:   ${safeText(user.email)}${verifiedBadge}`);
        console.log(
          `    GitHub:  ${user.github_username ? `@${safeText(user.github_username)}` : "-"}`,
        );
        console.log(`    Status:  ${statusColor(user.status)}`);
        console.log(`    Tier:    ${tier}`);
        // Only when not `person` (epic #1272 phase 4, #1284; ADR 0048): the
        // overwhelming majority of rows are people, and a line that always
        // said "Kind: person" would be noise in every listing.
        if (user.account_kind && user.account_kind !== "person") {
          console.log(`    Kind:    ${chalk.yellow(user.account_kind)}`);
        }
        // Only when there IS one. An absent field means either "never asked" or
        // a backend older than #1253, and neither is worth a line that says
        // nothing (ADR 0042).
        if (user.upload_access_requested_at) {
          console.log(
            `    Asked:   ${new Date(user.upload_access_requested_at).toLocaleDateString()} (upload access)`,
          );
        }
        console.log(`    Created: ${new Date(user.created_at).toLocaleDateString()}`);
        // Which fields the words were found in. A hit on a field the listing
        // does not print (affiliation, a date, the ORCID iD) is otherwise
        // unexplained, and an admin cannot tell a real match from a surprise.
        if (user.matched_in && user.matched_in.length > 0) {
          console.log(`    Matched: ${chalk.dim(user.matched_in.map(safeText).join(", "))}`);
        }
        console.log();
      }

      // Say it out loud rather than letting a column of "unknown" imply the
      // backend is fine. This is what a pre-#1251 or mid-rollout API looks like.
      if (unknownTierCount > 0) {
        console.log(
          chalk.yellow(
            `Note: ${unknownTierCount} account(s) reported no upload tier; the API may predate it.`,
          ),
        );
      }
    } catch (error) {
      // A failed SEARCH is a lookup a script may be waiting on: empty output and
      // exit 0 reads as "no such account". A plain listing keeps its old behaviour.
      if (search !== undefined) failAccountCommand(error, spinner, "Failed to search users");
      else handleCommandError(error, spinner, "Failed to fetch users");
    }
  });

// ----------------------------------------------------------------------------
// users show / users edit (ADR 0096)
// ----------------------------------------------------------------------------

/**
 * The exit code a script reads, and the message an operator reads.
 *
 * `handleCommandError` is shared by most admin commands and sets no exit code,
 * so a refused call there ends in 0. Lookups and edits are what a script runs
 * to find or change an account, and "it was refused" must not look like
 * success to it. Differences from the shared helper, both deliberate:
 *   - a 4xx is the server answering no (not found, owner only, in use): a
 *     verdict and not a crash, so it does not invite a bug report;
 *   - no generic "this requires admin privileges" line on a 403. The server's
 *     own sentence says why (owner only, an owner's account, not an admin), and
 *     the generic one is wrong for most of them.
 */
function failAccountCommand(
  error: unknown,
  spinner: Ora,
  defaultMsg: string,
  hints?: Record<number, string>,
): void {
  if (error instanceof ApiError) {
    spinner.fail(error.message);
    const hint = hints?.[error.statusCode];
    if (hint) console.log(chalk.dim(`  ${hint}`));
    if (error.statusCode >= 400 && error.statusCode < 500) markReportedExit();
  } else {
    handleCommandError(error, spinner, defaultMsg);
  }
  process.exitCode = 1;
}

/**
 * The `users` listing's own options. Commander also accepts them AFTER a
 * subcommand name and hands them to the parent, so `edit lovelace --role admin
 * --city Paris -y` would change the city, drop `--role` without a word, and
 * exit 0, leaving an admin sure they had changed a role. `show` and `edit`
 * refuse them instead, and say where the change they were reaching for is made.
 */
const LISTING_ONLY_OPTIONS: ReadonlyArray<{
  key: string;
  flag: string;
  hint?: string;
  showOk?: boolean;
}> = [
  { key: "search", flag: "--search", hint: "Pass the text as the argument instead." },
  {
    key: "role",
    flag: "--role",
    hint: "A role is changed with 'nemar admin role <username> <role>' (owners only).",
  },
  {
    key: "kind",
    flag: "--kind",
    hint: "An account kind is changed with 'nemar admin kind <username> <kind>' (owners only).",
  },
  {
    key: "pending",
    flag: "--pending",
    hint: "Status is changed with 'nemar admin approve' or 'revoke'.",
  },
  {
    key: "verified",
    flag: "--verified",
    hint: "Status is changed with 'nemar admin approve' or 'revoke'.",
  },
  {
    key: "approved",
    flag: "--approved",
    hint: "Status is changed with 'nemar admin approve' or 'revoke'.",
  },
  {
    key: "revoked",
    flag: "--revoked",
    hint: "Status is changed with 'nemar admin approve' or 'revoke'.",
  },
  {
    key: "uploadAccess",
    flag: "--no-upload-access",
    hint: "Upload access is granted with 'nemar admin approve'.",
  },
  { key: "awaitingApproval", flag: "--awaiting-approval" },
  // `show` honours this one (it can read a deleted account); `edit` cannot edit one.
  {
    key: "includeDeleted",
    flag: "--include-deleted",
    hint: "A deleted account cannot be edited.",
    showOk: true,
  },
];

/** True (after saying why, exit 1) if the admin passed a listing option to
 *  `show` or `edit` that would otherwise be silently dropped. */
function refuseListingOptions(command: Command, subcommand: "show" | "edit"): boolean {
  const parent = command.parent;
  if (!parent) return false;
  const given = LISTING_ONLY_OPTIONS.filter(
    (option) =>
      !(subcommand === "show" && option.showOk) &&
      parent.getOptionValueSource(option.key) === "cli",
  );
  if (given.length === 0) return false;
  console.error(
    chalk.red(
      `${given.map((option) => option.flag).join(", ")} ${given.length === 1 ? "filters" : "filter"} the 'nemar admin users' listing and ${given.length === 1 ? "does" : "do"} nothing for '${subcommand}'.`,
    ),
  );
  for (const option of given) {
    if (option.hint) console.error(chalk.dim(`  ${option.flag}: ${option.hint}`));
  }
  process.exitCode = 1;
  markReportedExit();
  return true;
}

/**
 * Find the ONE account a query names, or say why not.
 *
 * Runs the same all-fields search as `nemar admin users --search`, then narrows
 * (src/lib/admin-user-lookup.ts): a query that is an account's id, username,
 * email, GitHub handle or ORCID iD picks it even when longer names also contain
 * the text. Returns null after printing the reason, with a non-zero exit code,
 * so a script running `show` or `edit` can tell "not found" and "ambiguous"
 * from success.
 */
async function lookupOneAccount(
  query: string,
  includeDeleted: boolean,
  spinner: Ora,
  opts: { mayIncludeDeleted: boolean },
): Promise<{ user: UserListItem; match: LookupMatch } | null> {
  const result = await listUsers(undefined, undefined, false, undefined, {
    search: query,
    includeDeleted,
  });
  spinner.stop();

  // The exit code IS the answer from here on ("nothing", "several", "cannot
  // search"), not a crash.
  if (!searchWasUnderstood(result.users)) {
    process.exitCode = 1;
    markReportedExit();
    console.error(
      chalk.red(
        "This NEMAR backend does not support searching yet, so it cannot tell which account you mean. Update the backend, or pass the numeric id.",
      ),
    );
    return null;
  }
  const resolved = resolveLookup(result.users);
  if (resolved.kind === "one") return { user: resolved.user, match: resolved.match };

  process.exitCode = 1;
  markReportedExit();
  if (resolved.kind === "none") {
    console.log(chalk.yellow(`No account matches "${safeText(query)}", not even a close one.`));
    console.log(
      chalk.dim(
        `  Every field is searched; try fewer or shorter words${opts.mayIncludeDeleted ? ", or --include-deleted" : ""}.`,
      ),
    );
    return null;
  }
  console.log(
    chalk.yellow(
      resolved.match === "fuzzy"
        ? `No account matches "${safeText(query)}" exactly. Did you mean one of these?\n`
        : `${resolved.users.length} accounts match "${safeText(query)}". Which one did you mean?\n`,
    ),
  );
  for (const user of resolved.users) console.log(candidateLine(user));
  console.log(
    chalk.dim("\n  Narrow the words, or pass the exact username, email, ORCID iD or numeric id."),
  );
  return null;
}

adminUsersCommand
  .command("show")
  .description("Show one account's details (never credentials)")
  .argument(
    "<query>",
    "Username, email, GitHub handle, ORCID iD, numeric id, or any text from the account",
  )
  .addHelpText(
    "after",
    `
Looks the account up with the same all-fields search as 'nemar admin users
--search'. If the text names exactly one account's id, username, email, GitHub
handle or ORCID iD, that account is shown even when longer names also contain
the text; if several accounts still match, they are listed and nothing is shown.
If nothing matches but one account is close (a typo, a missing accent) it is
shown with a note, and the command exits 1 so a script does not mistake it for
the account it asked for.

Passwords, sign-in tokens and API keys are never shown.

Examples:
  $ nemar admin users show lovelace
  $ nemar admin users show ada@lab.org
  $ nemar admin users show 0000-0002-1825-0097
  $ nemar admin users show 42               # By numeric id (works for web/ORCID accounts)`,
  )
  .action(async (query: string, _options: unknown, command: Command) => {
    if (!requireAuth()) return;
    if (refuseListingOptions(command, "show")) return;
    // A parent's option is recognised after the subcommand name too, so the
    // parent consumes `--include-deleted` and the subcommand never sees it.
    const includeDeleted = command.optsWithGlobals().includeDeleted === true;

    const spinner = ora("Looking up account...").start();
    try {
      const found = await lookupOneAccount(query, includeDeleted, spinner, {
        mayIncludeDeleted: true,
      });
      if (!found) return;
      const { user } = await getAdminUserById(found.user.id, includeDeleted);
      console.log();
      for (const line of userDetailLines(user)) console.log(line);
      console.log();
      if (found.match === "fuzzy") {
        // Details of a DIFFERENT account than the one named: shown for a human
        // who mistyped, but not a success for a script that asked for one.
        process.exitCode = 1;
        markReportedExit();
        console.log(
          chalk.yellow(
            `No account matches "${safeText(query)}" exactly; this is the closest one (a typo or an accent away).\n`,
          ),
        );
      } else if (found.match === "partial") {
        console.log(
          chalk.dim(
            `Found by searching for "${safeText(query)}"; it is not an exact username, email, GitHub handle, ORCID iD or id.\n`,
          ),
        );
      }
    } catch (error) {
      failAccountCommand(error, spinner, "Failed to look up the account");
    }
  });

adminUsersCommand
  .command("edit")
  .description("Edit one account: name, affiliation, location (owners: username, email, GitHub)")
  .argument("<query>", "Username, email, GitHub handle, ORCID iD or numeric id of the account")
  .option("--given-name <text>", "Given name")
  .option("--family-name <text>", "Family name")
  .option("--affiliation <text>", "Affiliation")
  .option("--clear-affiliation", "Remove the affiliation")
  .option("--city <text>", "City")
  .option("--country <text>", "Country")
  .option("--username <name>", "Username (owner only)")
  .option("--github <handle>", "GitHub handle (owner only)")
  .option("--clear-github", "Remove the GitHub handle (owner only)")
  .option("--email <address>", "Email address (owner only; marks it unconfirmed)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Who can change what:
  ${ADMIN_USER_DESCRIPTIVE_FIELDS.join(", ")}
      any admin
  ${ADMIN_USER_IDENTITY_FIELDS.join(", ")}
      owners only, never on your own account and never on another owner's. These
      decide who can act as the account (sign-in is passwordless, so whoever holds
      an email can sign in as it), so they follow the same rule as role, kind and
      key minting. An owner changes their own in Settings ('nemar auth profile').

What this does NOT change (each has its own command):
  role / status / upload access   nemar admin role | approve | revoke
  account kind                    nemar admin kind
  ORCID iD                        proven by signing in with ORCID, never typed in
  names on an ORCID-verified account: ORCID owns them and rewrites them at the
  next sign-in, so the edit is refused (the person updates orcid.org)

Safeguards:
  - The account is shown with the exact changes and you confirm (-y skips the
    prompt, but only when the text names the account exactly).
  - Every edit is written to the audit log with the old and new values.
  - A new email address is marked unconfirmed and any verification link already
    sent stops working; the person confirms the new address in Settings. The
    PREVIOUS address is sent a notice that the email changed (the command says
    when it could not be sent).
  - The GitHub handle is checked for format and uniqueness, NOT against GitHub.
    Repository access already granted to the old handle is not changed.
  - A flag with an empty value is refused. To remove an affiliation or a GitHub
    handle use --clear-affiliation or --clear-github, so that an unset shell
    variable can never wipe a field.
  - Nothing here deletes or merges accounts.

Examples:
  $ nemar admin users edit lovelace --affiliation "UC San Diego"
  $ nemar admin users edit 42 --given-name Ada --family-name Lovelace
  $ nemar admin users edit lovelace --clear-affiliation
  $ nemar admin users edit lovelace --email new@lab.org   # Owner only`,
  )
  .action(
    async (query: string, options: Record<string, unknown> & ConfirmOptions, command: Command) => {
      if (!requireAuth()) return;
      if (refuseListingOptions(command, "edit")) return;

      const built = editBodyFromOptions(options);
      if (!built.ok) {
        console.error(chalk.red(built.message));
        process.exit(1);
      }
      const body = built.body;
      if (Object.keys(body).length === 0) {
        const flags = [
          ...EDIT_FLAG_FIELDS.map(([option]) => flagName(option)),
          ...CLEAR_FLAGS.map(({ option }) => flagName(option)),
        ];
        console.error(chalk.red(`Nothing to change. Pass at least one of: ${flags.join(", ")}`));
        process.exit(1);
      }

      const spinner = ora("Looking up account...").start();
      try {
        const found = await lookupOneAccount(query, false, spinner, { mayIncludeDeleted: false });
        if (!found) return;

        // -y confirms WITHOUT looking, which is only safe if the admin named the
        // account outright. A substring that happened to match one account is how
        // `edit ada -y` changes the wrong person.
        if (options.yes && found.match !== "exact") {
          process.exitCode = 1;
          markReportedExit();
          const label = `${safeText(found.user.username ?? found.user.email)} (id ${found.user.id})`;
          console.error(
            chalk.red(
              found.match === "fuzzy"
                ? `"${safeText(query)}" is not the username, email, GitHub handle, ORCID iD or id of any account; the closest is ${label}.`
                : `"${safeText(query)}" matched ${label} by search, not by an exact username, email, GitHub handle, ORCID iD or id.`,
            ),
          );
          console.error(
            chalk.dim(
              `  Repeat with the exact identifier, e.g. 'nemar admin users edit ${found.user.id} ...', or drop -y to confirm.`,
            ),
          );
          return;
        }

        const { user: current } = await getAdminUserById(found.user.id);
        const plan = planEdit(current, body);
        const who = `${safeText(current.username ?? current.email)} (id ${current.id})`;
        if (plan.length === 0) {
          console.log(chalk.yellow(`Nothing to change: ${who} already has these values.`));
          return;
        }

        console.log(`\n${chalk.cyan("Edit")} ${who}\n`);
        if (found.match === "fuzzy") {
          console.log(
            chalk.yellow(
              `  No account matches "${safeText(query)}" exactly; check this is the one you meant.\n`,
            ),
          );
        }
        for (const change of plan) {
          console.log(
            `  ${change.field.padEnd(16)} ${displayEditValue(change.from)} ${chalk.dim("->")} ${displayEditValue(change.to)}`,
          );
        }
        console.log();

        const confirmResult = await confirm(
          `Apply ${plan.length} change${plan.length === 1 ? "" : "s"} to ${who}?`,
          options,
        );
        if (confirmResult === "declined") {
          console.log(chalk.dim("Skipped"));
          return;
        }
        if (confirmResult !== "confirmed") {
          // It could not ASK (no terminal, and neither --yes nor --no), or the
          // admin cancelled. Nothing was changed, and a script that forgot -y
          // must not read that as success.
          process.exitCode = 1;
          markReportedExit();
          console.log(chalk.dim("Canceled: nothing was changed"));
          return;
        }

        spinner.start(`Updating ${who}...`);
        const result = await editAdminUser(current.id, body);
        spinner.succeed(result.message);
        // The server's report, not the preview, is what actually happened: it
        // normalises (trim, lower-case an email, strip '@') and drops values that
        // turned out to be unchanged.
        for (const [field, change] of Object.entries(result.changed)) {
          console.log(
            `  ${field.padEnd(16)} ${displayEditValue(change.from)} ${chalk.dim("->")} ${displayEditValue(change.to)}`,
          );
        }
        for (const note of result.notes ?? []) console.log(chalk.yellow(`  ! ${note}`));
      } catch (error) {
        // Every refusal sets `error.message` to its own sentence (owner_only_field,
        // owner_account, email_in_use, name_is_orcid_canonical, ...), which
        // spinner.fail already prints.
        failAccountCommand(error, spinner, "Failed to edit the account");
      }
    },
  );

// ============================================================================
// Approve
// ============================================================================

adminCommand
  .command("approve")
  .description("Approve a pending user")
  .argument("[username]", "Username to approve (CLI accounts)")
  .option("--id <id>", "Approve by numeric user id (web/ORCID accounts have no username)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (username: string | undefined, options: ConfirmOptions & { id?: string }) => {
    // Exactly one addressing key: username (CLI accounts) or --id
    // (web/ORCID accounts, whose username is NULL by design — #1012).
    // Validated before the auth gate: argv errors should surface (exit 1)
    // even when the caller is not logged in.
    const byId = options.id !== undefined;
    if (!byId && !username) {
      console.error(chalk.red("Error: provide a username or --id <id>"));
      console.error(chalk.dim("Web/ORCID accounts have no username; find their id with:"));
      console.error(chalk.dim("  nemar admin users --pending"));
      process.exit(1);
    }
    if (byId && username) {
      console.error(chalk.red("Error: username and --id are mutually exclusive; provide one"));
      process.exit(1);
    }
    let userId = 0;
    if (byId) {
      userId = Number.parseInt(options.id ?? "", 10);
      if (!Number.isInteger(userId) || userId <= 0) {
        console.error(chalk.red(`Error: invalid user id: ${options.id}`));
        process.exit(1);
      }
    }

    if (!requireAuth()) return;

    const label = username ?? `user id ${userId}`;

    // Confirmation
    console.log(chalk.cyan(`\nApproving user: ${label}\n`));
    console.log("This will:");
    console.log("  1. Mark the account approved and grant upload access");
    if (username) {
      console.log("  2. Notify them that upload access is granted");
    } else {
      console.log("  2. Notify them to sign in to the dashboard");
    }
    console.log();

    const result = await confirm(`Approve ${label}?`, options, true);
    if (result !== "confirmed") {
      console.log(chalk.dim(result === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Approving ${label}...`).start();

    try {
      const result = username ? await approveUser(username) : await approveUserById(userId);
      spinner.succeed(`Approved ${result.user.username ?? label}`);
      console.log();
      console.log(`  Email: ${result.user.email}`);
      console.log(`  Status: ${chalk.green(result.user.status)}`);
      // Approval is the single writer of upload access (ADR 0040) — say so,
      // because #1249 was exactly an admin assuming it and being wrong. Read it
      // off the RESPONSE rather than hardcoding "upload": an older backend that
      // still approves without granting is the very bug this phase fixes, and
      // printing the outcome we wanted would hide it on exactly the deployment
      // where an admin most needs to see it.
      if (result.user.service_access === true) {
        console.log(`  Tier: ${chalk.green("upload")}`);
      } else {
        console.log(`  Tier: ${chalk.yellow("grant not confirmed by server")}`);
        console.log(
          chalk.yellow(
            "  The account is approved but the API did not report upload access; verify with 'nemar admin users'.",
          ),
        );
      }
      if (result.note) console.log(chalk.dim(`  ${result.note}`));

      console.log();
      // `note` marks the repair path, where the account was ALREADY approved so
      // no notification was attempted (the backend returns email_sent: false by
      // design). Reporting "Notification email failed to send" there sends an
      // admin chasing a delivery problem that does not exist, so say nothing
      // about email at all.
      if (result.note) {
        // Nothing to report: no email was owed and none was tried.
      } else if (result.email_sent) {
        console.log(
          result.user.username
            ? chalk.green("User notified that upload access is granted")
            : chalk.green("User notified to sign in at https://nemar.org/login"),
        );
      } else {
        console.log(chalk.yellow("Warning: Notification email failed to send."));
        console.log(
          result.user.username
            ? chalk.yellow("Please notify the user manually that upload access is granted")
            : chalk.yellow("Please notify the user manually that their account is approved"),
        );
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to approve user", {
        404: "User not found or not eligible for approval",
      });
    }
  });

// ============================================================================
// Revoke
// ============================================================================

adminCommand
  .command("revoke")
  .description("Revoke user access")
  .argument("[username]", "Username to revoke (CLI accounts)")
  .option("--id <id>", "Revoke by numeric user id (web/ORCID accounts have no username)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (username: string | undefined, options: ConfirmOptions & { id?: string }) => {
    // Exactly one addressing key, the same rule `admin approve` enforces:
    // username (CLI accounts) or --id (web/ORCID accounts, whose username is
    // NULL by design). Approval can reach those accounts by id, so revocation
    // has to as well (ADR 0040: revoke is the eraser of what approval wrote).
    // Validated before the auth gate, like approve's, so an argv mistake
    // surfaces (exit 1) even when the caller is not logged in.
    const byId = options.id !== undefined;
    if (!byId && !username) {
      console.error(chalk.red("Error: provide a username or --id <id>"));
      console.error(chalk.dim("Web/ORCID accounts have no username; find their id with:"));
      console.error(chalk.dim("  nemar admin users"));
      process.exit(1);
    }
    if (byId && username) {
      console.error(chalk.red("Error: username and --id are mutually exclusive; provide one"));
      process.exit(1);
    }
    let userId = 0;
    if (byId) {
      userId = Number.parseInt(options.id ?? "", 10);
      if (!Number.isInteger(userId) || userId <= 0) {
        console.error(chalk.red(`Error: invalid user id: ${options.id}`));
        process.exit(1);
      }
    }

    if (!requireAuth()) return;

    // Prevent self-revocation. Only the username is checkable here -- the
    // config stores no numeric id -- so the backend holds the id-keyed half of
    // this guard.
    const config = getConfig();
    if (username && config.username === username) {
      console.log(chalk.red("Error: Cannot revoke your own access"));
      return;
    }

    const label = username ?? `user id ${userId}`;
    // What the admin types back to confirm: the username, or the id when that
    // is the only handle the account has.
    const confirmToken = username ?? String(userId);

    // Confirmation with warning
    console.log(chalk.red(`\nRevoking access for: ${label}\n`));
    console.log(chalk.yellow("This will:"));
    console.log("  1. Invalidate all API keys for this user");
    console.log("  2. Remove them from datasets they have access to");
    console.log("  3. Revoke upload access, if they hold it");
    console.log("  4. Send them a notification email");
    console.log();

    const result = await confirmWithInput(
      `Type '${confirmToken}' to confirm revocation:`,
      confirmToken,
      options,
    );
    if (result !== "confirmed") {
      console.log(chalk.dim(result === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Revoking ${label}...`).start();

    try {
      await (username ? revokeUser(username) : revokeUserById(userId));
      spinner.succeed(`Revoked access for ${label}`);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to revoke user", {
        404: "User not found",
      });
    }
  });

// ============================================================================
// Role Management (Owner Only)
// ============================================================================

adminCommand
  .command("role")
  .description("Change a user's role (owner only)")
  .argument("<username>", "Username to change role for")
  .argument("<role>", "New role: owner, admin, or member")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Permission Model:
  owner  - Full access: can manage users, roles, datasets, DOIs, and system settings
  admin  - Can approve/revoke users, manage datasets and DOIs
  member - Can upload and manage their own datasets only

Rules:
  - Only owners can change roles
  - You cannot change your own role (prevents self-lockout)
  - The last owner cannot be demoted (prevents total lockout)
  - Demoting a user revokes their tokens (they must re-login)

Examples:
  $ nemar admin role john_doe admin        # Promote to admin
  $ nemar admin role john_doe member       # Demote to member
  $ nemar admin role jane_doe owner -y     # Promote to owner (skip confirm)`,
  )
  .action(async (username: string, role: string, options: { yes?: boolean }) => {
    if (!requireAuth()) return;

    if (!["owner", "admin", "member"].includes(role)) {
      console.error(chalk.red(`Invalid role '${role}'. Must be: owner, admin, or member`));
      process.exit(1);
    }

    if (!options.yes) {
      const { confirmed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message: `Change ${username}'s role to '${role}'?`,
          default: false,
        },
      ]);
      if (!confirmed) {
        console.log(chalk.dim("Cancelled"));
        return;
      }
    }

    const spinner = ora(`Changing ${username}'s role to '${role}'...`).start();

    try {
      const result = await changeUserRole(username, role as "owner" | "admin" | "member");
      spinner.succeed(result.message);
      if (result.tokens_revoked !== undefined && result.tokens_revoked > 0) {
        console.log(
          chalk.yellow(`  ${result.tokens_revoked} token(s) revoked (user must re-login)`),
        );
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to change role", {
        400: "Invalid request (check if you are an owner)",
        403: "Owner access required",
        404: "User not found",
        409: "User already has that role",
      });
    }
  });

// ============================================================================
// Account Kind (Owner Only) -- epic #1272 phase 4, #1284; ADR 0048
// ============================================================================

adminCommand
  .command("kind")
  .description("Change a user's account kind (owner only)")
  .argument("<username>", "Username to change the kind for")
  .argument("<kind>", "New kind: person, service, or test")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Kinds:
  person  - a human's own account (the default)
  service - operational automation; no human signs in to it directly, keys
            are owner-minted with 'nemar admin keys create'
  test    - a human's secondary persona; signs in and uploads like a person,
            but on production may only own xx sandbox datasets

Rules:
  - Only owners can change account kinds
  - You cannot change your own account kind
  - A verified ORCID iD blocks a move to service/test -- run
    'nemar auth profile orcid unlink' on that account first, then retry
  - Keys are not revoked on a kind change

Examples:
  $ nemar admin kind cool-vibers test      # Mark a persona account
  $ nemar admin kind nemarAdmin service    # Mark an operational account
  $ nemar admin kind cool-vibers person -y # Revert (skip confirm)`,
  )
  .action(async (username: string, kindArg: string, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    if (!isAccountKind(kindArg)) {
      console.error(
        chalk.red(`Invalid kind '${kindArg}'. Must be: ${ACCOUNT_KIND_VALUES.join(", ")}`),
      );
      process.exit(1);
    }
    const kind = kindArg;

    const confirmResult = await confirm(`Change ${username}'s account kind to '${kind}'?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Canceled"));
      return;
    }

    const spinner = ora(`Changing ${username}'s account kind to '${kind}'...`).start();

    try {
      const result = await setAccountKind(username, kind);
      spinner.succeed(result.message);
    } catch (error) {
      // No 409 hint here: the route's three 409 causes (same_kind,
      // orcid_linked, kind_changed_concurrently) each set `error.message` to
      // their own ACCOUNT_KIND_ERROR_MESSAGES sentence (shared/contract/
      // user.ts), which handleCommandError's spinner.fail already prints as
      // the primary line -- a static hint here would either repeat that or,
      // for kind_changed_concurrently, name causes that did not happen.
      handleCommandError(error, spinner, "Failed to change account kind", {
        400: "Invalid request (check that you are not targeting your own account)",
        403: "Owner access required",
        404: "User not found",
      });
    }
  });

// ============================================================================
// Owner Key Management for Non-Person Accounts -- epic #1272 phase 4, #1284;
// ADR 0048
// ============================================================================

const adminKeysCommand = new Command("keys").description(
  "Manage API keys for service/test accounts (owner only)",
);

adminKeysCommand
  .command("create")
  .description("Mint a key for a service/test account")
  .argument("<username>", "Username of the service/test account")
  .argument("<name>", "Name for the key (e.g. the machine or job it authenticates)")
  .action(async (username: string, name: string) => {
    if (!requireAuth()) return;

    const spinner = ora(`Minting a key for ${username}...`).start();
    try {
      const result = await createKeyFor(username, name);
      spinner.succeed(`Key minted for ${username}`);
      console.log();
      console.log(chalk.yellow("  This key will only be shown once:"));
      console.log(`  ${chalk.cyan(result.api_key)}`);
      console.log();
      console.log(chalk.dim(`  Sign in as ${username} with:`));
      console.log(chalk.dim(`    nemar auth login --key ${result.api_key}`));
    } catch (error) {
      handleCommandError(error, spinner, "Failed to mint key", {
        403: "Owner access required, or this account is a person (person_account)",
        404: "User not found",
        409: "This account already has the maximum number of live keys",
        // statusCode 0 is this codebase's convention for a network-layer
        // failure (lib/api/client.ts). The mint and its read-back run in one
        // D1 batch (routes/admin/user-keys.ts), so a drop here can land on
        // either side of that commit -- the key may already exist even
        // though this command never saw the response (epic #1272 phase 4,
        // #1284 review).
        0: `The key may have been minted before the connection dropped; run \`nemar admin keys list ${username}\` before retrying.`,
      });
    }
  });

adminKeysCommand
  .command("list")
  .description("List a target account's live keys")
  .argument("<username>", "Username of the account")
  .action(async (username: string) => {
    if (!requireAuth()) return;

    const spinner = ora(`Fetching keys for ${username}...`).start();
    try {
      const result = await listKeysFor(username);
      spinner.stop();
      if (result.keys.length === 0) {
        console.log(chalk.yellow(`No live keys for ${username}`));
        return;
      }
      console.log(`\n${chalk.cyan(`Keys for ${username}`)} (${result.keys.length} total)\n`);
      for (const key of result.keys) {
        console.log(`  ${chalk.cyan(`#${key.id}`)} ${key.name ?? chalk.dim("(unnamed)")}`);
        console.log(`    Prefix:  ${key.prefix}`);
        console.log(`    Created: ${new Date(key.created_at).toLocaleDateString()}`);
        console.log(
          `    Used:    ${key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : chalk.dim("never")}`,
        );
        console.log();
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to fetch keys", {
        403: "Owner access required",
        404: "User not found",
      });
    }
  });

adminKeysCommand
  .command("revoke")
  .description("Revoke one of a target account's keys")
  .argument("<username>", "Username of the account")
  .argument("<id>", "Key row id (from 'nemar admin keys list')")
  .action(async (username: string, idStr: string) => {
    if (!requireAuth()) return;

    const id = Number.parseInt(idStr, 10);
    if (Number.isNaN(id)) {
      console.error(chalk.red("Invalid key id"));
      process.exit(1);
    }

    const spinner = ora(`Revoking key #${id} for ${username}...`).start();
    try {
      await revokeKeyFor(username, id);
      spinner.succeed(`Key #${id} revoked for ${username}`);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to revoke key", {
        403: "Owner access required",
        404: "User or key not found",
      });
    }
  });

adminCommand.addCommand(adminKeysCommand);

// ============================================================================
// Documentation retrieval
// ============================================================================

/**
 * `nemar admin docs <path...>` (epic #1336 phase 3, issue #1341).
 *
 * `nemarOrg/docs` is private and `docs.nemar.org` is the retrieval surface
 * (ADR 0057, ADR 0059), so a checkout is not how anyone reads an operations
 * runbook any more. This is how: the stored API key buys a fifteen-minute
 * docs-scoped session, and only that session value is sent to the docs host.
 *
 * THERE IS DELIBERATELY NO FORM THAT PRINTS THE SESSION VALUE. Printing it
 * would be the convenient thing and is exactly what should not exist: the
 * credential would land in a shell history, a CI log, or an agent's transcript,
 * which is the whole class of exposure the short TTL is hedging against and the
 * reason the key is traded for something weaker in the first place. The command
 * holds the value in memory for the length of one invocation and prints only
 * documentation.
 */
adminCommand
  .command("docs")
  .description("Fetch documentation pages from docs.nemar.org as Markdown, including gated ones")
  .argument(
    "<path...>",
    "Page paths, for example admin/operations/zarr-serving (a full docs.nemar.org URL also works)",
  )
  .option("--no-headers", "Print only the page bodies, with no path banner")
  .addHelpText(
    "after",
    `
Every page has a Markdown mirror; ${getDocsUrl()}/llms.txt indexes them.
Pass several paths at once: they share one documentation session, which is
both faster and easier on the rate limit than one command per page.`,
  )
  .action(async (paths: string[], options: { headers: boolean }) => {
    // NOT the shared `requireAuth()` / `handleCommandError()` pair every other
    // command in this file uses, and the difference is the point. Both write
    // their message with `console.log`, i.e. to STDOUT, and `requireAuth`
    // returns false without setting an exit code. For a command whose whole
    // contract is "the page goes to stdout", that combination is the worst
    // available: `nemar admin docs x > page.md` with no credentials exited 0
    // and wrote the words "Error: Not authenticated" into page.md, where the
    // caller -- a script or an agent, by design -- would then read them as
    // documentation. Found in review of #1384. Everything below reports to
    // stderr and sets an exit code; stdout carries pages and nothing else.
    if (!isAuthenticated()) {
      console.error(chalk.red("Error: Not authenticated"));
      console.error(chalk.dim("  Run 'nemar auth login' first"));
      process.exitCode = 1;
      return;
    }

    const spinner = ora({
      text: paths.length === 1 ? "Fetching documentation..." : `Fetching ${paths.length} pages...`,
      // ora writes to stderr by default, but say so rather than rely on it:
      // a spinner frame on stdout would land in the redirected page.
      stream: process.stderr,
    }).start();

    let results: Awaited<ReturnType<typeof fetchDocsPages>>;
    try {
      results = await fetchDocsPages(paths);
    } catch (error) {
      spinner.stop();
      const hints: Record<number, string> = {
        401: "Sign in again with `nemar auth login`",
        403: "This account cannot use the API; see the message above",
        404: "This account does not have access to the operations documentation",
        429: "Too many documentation sessions from this address; wait a minute",
      };
      const hint = error instanceof ApiError ? hints[error.statusCode] : undefined;
      console.error(
        chalk.red(
          error instanceof ApiError
            ? error.message
            : `Failed to fetch documentation: ${errorDetail(error)}`,
        ),
      );
      if (hint) console.error(chalk.dim(`  ${hint}`));
      process.exitCode = 1;
      return;
    }
    spinner.stop();

    // Bodies go to stdout and everything else to stderr, so `nemar admin docs
    // <path> > page.md` yields the page rather than the page plus banners --
    // the shape an agent or a pipeline wants. `console.log` appends a newline,
    // so a redirected single page is the page plus a trailing newline, not
    // byte-identical to the mirror. That is the right trade for a text file and
    // is stated here because the sentence above used to imply otherwise.
    //
    // CONSEQUENCE WORTH KNOWING FOR THE MULTI-PATH CASE: redirecting several
    // pages concatenates them with no delimiter in the file, because the banner
    // that separates them is on stderr. That is deliberate rather than an
    // oversight -- putting a separator on stdout would contaminate the
    // single-page redirect, which is the common case and the one whose output
    // should be exactly the page. Fetch one page per invocation when the caller
    // needs them apart; the banners still name them, in order, on stderr.
    for (const result of results) {
      if (!result.ok) {
        console.error(chalk.red(`${result.path}: ${result.error}`));
        process.exitCode = 1;
        continue;
      }
      if (options.headers && results.length > 1) {
        console.error(chalk.cyan(`\n# ${result.path}`));
      }
      console.log(result.body);
    }
  });

// ============================================================================
// S3 / IAM Management
// ============================================================================

const s3Command = new Command("s3").description("S3 and IAM credential management");

s3Command
  .command("regenerate-iam")
  .description("Regenerate AWS IAM credentials for a user")
  .argument("<username>", "Username to regenerate credentials for")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(regenerateIamAction);

s3Command
  .command("lock")
  .description("Apply S3 Object Lock (Governance mode) to a dataset")
  .argument("<dataset-id>", "Dataset ID to lock")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId: string, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    console.log(chalk.cyan(`\nApply S3 Object Lock to ${datasetId}\n`));
    console.log("This will:");
    console.log("  • Set GOVERNANCE mode Object Lock on all objects");
    console.log("  • Retention period: 100 years");
    console.log("  • Objects cannot be deleted or modified without bypass");
    console.log();

    const confirmResult = await confirm(`Apply S3 Object Lock to ${datasetId}?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora("Applying S3 Object Lock...").start();

    try {
      const result = await applyS3Lock(datasetId);
      if (result.failed.length > 0) {
        spinner.fail(`Partial lock: ${result.locked} locked, ${result.failed.length} failed`);
        console.log(chalk.yellow("\nFailed objects:"));
        for (const f of result.failed.slice(0, 10)) {
          console.log(`  • ${f.key}: ${chalk.dim(f.error)}`);
        }
        if (result.failed.length > 10) {
          console.log(`  ... and ${result.failed.length - 10} more`);
        }
      } else {
        spinner.succeed(`All ${result.locked} objects locked successfully`);
      }
    } catch (error) {
      spinner.fail("S3 lock failed");
      console.log(chalk.dim(`  ${errorDetail(error)}`));
    }
  });

s3Command
  .command("credential-check")
  .description("Mint a dataset's upload credentials and ask S3 what they can actually do")
  .argument("<dataset-id>", "Dataset ID (e.g., on007788)")
  .addHelpText(
    "after",
    `
Read-only. Mints the same STS credentials an upload would get, then lists and reads
one object under the dataset's objects/ prefix with them, through the aws CLI.

It answers the question #1380 got wrong: a 403 from a signed request does not say
whether the identity, the session policy, or the request itself is at fault. The
credentials NEMAR mints are temporary, and a temporary key signs nothing without
its session token -- S3 refuses such a request with a bare 403 even on an object
that is anonymously readable.

Examples:
  $ nemar admin s3 credential-check on007788
  $ nemar admin s3 credential-check nm099999
`,
  )
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;

    const { requestUploadCredentials } = await import("../lib/api/data.js");
    const { probeS3PrefixAccess } = await import("../lib/aws-cli.js");

    const mintSpinner = ora(`Minting upload credentials for ${datasetId}...`).start();
    let creds: Awaited<ReturnType<typeof requestUploadCredentials>>;
    try {
      creds = await requestUploadCredentials(datasetId);
    } catch (error) {
      mintSpinner.fail(`Could not mint upload credentials for ${datasetId}`);
      console.log(chalk.dim(`  ${errorDetail(error)}`));
      process.exit(1);
    }
    const temporary = creds.credentials.access_key_id.startsWith("ASIA");
    mintSpinner.succeed(
      `Minted ${temporary ? "temporary (STS)" : "long-lived"} credentials, expiring ${creds.credentials.expiration}`,
    );
    console.log(`  Scope: ${chalk.cyan(`s3://${creds.s3.bucket}/${creds.s3.prefix}/`)}`);
    console.log(
      chalk.dim(
        "  The session policy names this dataset; the identity it is federated from covers the bucket.",
      ),
    );

    const probeSpinner = ora("Asking S3 what they reach...").start();
    const probe = await probeS3PrefixAccess({
      credentials: creds.credentials,
      bucket: creds.s3.bucket,
      region: creds.s3.region,
      prefix: creds.s3.prefix,
    });

    switch (probe.outcome) {
      case "reachable":
        probeSpinner.succeed(`Listed and read ${probe.object}`);
        console.log(
          chalk.green(`  These credentials reach s3://${probe.bucket}/${probe.prefix}/.`),
        );
        if (temporary) {
          console.log(
            chalk.dim(
              "  A transfer must carry the session token too: git-annex caches an S3 remote's key and secret with nowhere to put it, so a copy that inherits the environment signs without one and every request comes back 403.",
            ),
          );
        }
        break;
      case "empty-prefix":
        probeSpinner.warn(`Listing worked; there is no object under ${probe.prefix}/ to read`);
        console.log(
          chalk.dim(
            "  ListBucket is granted, so the credentials are valid. Reachability of an object is unproven because there is none.",
          ),
        );
        break;
      case "unavailable":
        probeSpinner.warn(`Could not probe: ${probe.detail}`);
        console.log(chalk.dim("  Install the aws CLI (nemar doctor lists it) and re-run."));
        break;
      case "refused":
        probeSpinner.fail(`S3 refused: ${probe.detail}`);
        console.log();
        console.log("Three things can produce this, in the order worth checking:");
        console.log(
          "  1. the request dropped the session token (a temporary key alone is always 403)",
        );
        console.log(
          `  2. the session policy does not name ${datasetId} (it is generated per dataset id)`,
        );
        console.log(
          "  3. the identity the token is federated from no longer covers the bucket, so the intersection is empty",
        );
        process.exit(1);
    }
  });

adminCommand.addCommand(s3Command);

// Hidden alias for backward compatibility
adminCommand
  .command("regenerate-iam", { hidden: true })
  .argument("<username>")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(regenerateIamAction);

async function regenerateIamAction(_username: string, _options: ConfirmOptions) {
  if (!requireAuth()) return;

  console.log(chalk.yellow("\nThis command is deprecated.\n"));
  console.log("S3 access is now managed through backend-scoped credentials.");
  console.log("Per-user IAM credentials are no longer needed.");
  console.log();
  console.log(chalk.dim("Users can upload datasets without any IAM setup."));
}

// ============================================================================
// Repository Management
// ============================================================================

const repoCommand = new Command("repo").description("Repository visibility management");

repoCommand
  .command("public")
  .description("Make a dataset repository public")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    console.log(chalk.cyan(`\nMaking repository public: ${datasetId}\n`));
    console.log(chalk.yellow("Warning: This will make the dataset visible to everyone."));
    console.log();

    const confirmResult = await confirm(`Make ${datasetId} public?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Setting ${datasetId} to public...`).start();
    try {
      await changeVisibility(datasetId, "public");
      spinner.succeed(`Repository ${datasetId} is now public`);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to change visibility", {
        404: "Dataset not found",
      });
    }
  });

repoCommand
  .command("private")
  .description("Make a dataset repository private")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    console.log(chalk.yellow(`\nMaking repository private: ${datasetId}\n`));
    console.log("This will restrict access to collaborators only.");
    console.log();

    const confirmResult = await confirm(`Make ${datasetId} private?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Setting ${datasetId} to private...`).start();
    try {
      await changeVisibility(datasetId, "private");
      spinner.succeed(`Repository ${datasetId} is now private`);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to change visibility", {
        404: "Dataset not found",
      });
    }
  });

adminCommand.addCommand(repoCommand);

// ============================================================================
// CI Management
// ============================================================================

const ciCommand = new Command("ci").description("CI workflow management");

ciCommand
  .command("check")
  .description("Check CI workflow status for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .action(async (datasetId) => {
    if (!requireAuth()) return;

    const spinner = ora(`Checking CI status for ${datasetId}...`).start();

    try {
      const result = await getCiStatus(datasetId);
      spinner.stop();

      console.log(`\n${chalk.cyan("CI Status:")} ${datasetId}\n`);

      // BIDS Validation
      const bidsPresent = result.bids_validation.present;
      const bidsIcon = bidsPresent ? chalk.green("[x]") : chalk.red("[ ]");
      console.log(`  ${bidsIcon} BIDS Validation`);
      if (bidsPresent) {
        const statusColor =
          result.bids_validation.status === "success"
            ? chalk.green
            : result.bids_validation.status === "failure"
              ? chalk.red
              : chalk.yellow;
        console.log(`      Status: ${statusColor(result.bids_validation.status)}`);
        if (result.bids_validation.url) {
          console.log(`      URL:    ${chalk.dim(result.bids_validation.url)}`);
        }
      } else {
        console.log(`      ${chalk.dim("Not deployed. Use 'nemar admin ci add' to deploy.")}`);
      }

      // Version Check
      const versionPresent = result.version_check.present;
      const versionIcon = versionPresent ? chalk.green("[x]") : chalk.red("[ ]");
      console.log(`  ${versionIcon} Version Check`);
      if (!versionPresent) {
        console.log(`      ${chalk.dim("Not deployed. Use 'nemar admin ci add' to deploy.")}`);
      }

      console.log();
    } catch (error) {
      handleCommandError(error, spinner, "Failed to check CI status", {
        404: "Dataset not found",
      });
    }
  });

/** Probe shape — see pollCiValidation. Exported for the unit test. */
export type ValidationProbe = () => Promise<{
  valid: string[];
  missing: string[];
  errors: string[];
}>;

/**
 * Poll the validate endpoint after a CI deploy. GitHub's workflow index lags
 * the commit by a few seconds; the previous design slept inside the Worker,
 * which burned wall-clock budget. This runs the sleep + retry on the user's
 * machine instead (issue #472).
 *
 * Default backoff: 2.5 s, then 5 s if anything is still missing. Returns the
 * final validation result (or null if the poll itself errored out — also
 * treated as a best-effort warning by the caller). `probe` and `delaysMs`
 * are dependency-injected so the unit test can pass a fake probe and zero
 * delays without spinning up a real backend.
 */
export async function pollCiValidation(
  datasetId: string,
  probe: ValidationProbe = async () => {
    const r = await validateCi(datasetId);
    return { valid: r.valid, missing: r.missing, errors: r.errors };
  },
  delaysMs: readonly number[] = [2500, 5000],
): Promise<{ valid: string[]; missing: string[]; errors: string[] } | null> {
  let last: { valid: string[]; missing: string[]; errors: string[] } | null = null;
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      last = await probe();
      // Stop early when everything is parseable or the call itself failed
      // (retrying a 500 just adds latency without new information).
      if (last.missing.length === 0 || last.errors.length > 0) return last;
    } catch {
      // Network/API hiccup. Don't retry — the deploy succeeded, just skip
      // the inline parseability warning.
      return null;
    }
  }
  return last;
}

function printValidationWarning(result: { missing: string[]; errors: string[] }): void {
  console.log();
  console.log(chalk.yellow("Validation warnings (best-effort; deploy succeeded):"));
  if (result.missing.length > 0) {
    console.log(
      `  ${chalk.yellow("!")} Not listed by GitHub Actions (parse error or indexing lag): ${result.missing.join(", ")}`,
    );
  }
  for (const e of result.errors) {
    console.log(`  ${chalk.yellow("!")} ${e}`);
  }
}

ciCommand
  .command("add")
  .description("Deploy CI workflows to a dataset repository (or all with --all)")
  .argument("[dataset-id]", "Dataset ID (e.g., nm000104)")
  .option("--all", "Deploy to all dataset repositories")
  .option(
    "--no-validate",
    "Skip the post-deploy parseability poll on the single-dataset path. No-op for --all (fleet deploys always skip the poll).",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: { all?: boolean; validate?: boolean } & ConfirmOptions) => {
    if (!requireAuth()) return;

    // Commander sets `validate: false` when the user passes `--no-validate`.
    const skipValidate = options.validate === false;

    if (options.all) {
      const spinner = ora("Fetching dataset list...").start();
      let datasets: { dataset_id: string }[];
      try {
        const result = await listDatasets({ limit: 1000 });
        datasets = result.datasets;
        spinner.succeed(`Found ${datasets.length} datasets`);
        if (datasets.length >= 1000) {
          console.log(
            chalk.yellow("Warning: reached 1000 dataset limit; some datasets may be skipped"),
          );
        }
      } catch (error) {
        handleCommandError(error, spinner, "Failed to fetch datasets");
        return;
      }

      console.log(chalk.cyan(`\nDeploy CI workflows to ${datasets.length} datasets\n`));
      console.log("This will add/update the following workflows on each:");
      console.log("  1. BIDS Validation (runs on PRs)");
      console.log("  2. Version Check (ensures version bump on PRs)");
      console.log("  3. PR Merge Handler (creates releases, publishes DOIs)");
      console.log(
        chalk.dim(
          "  (post-deploy parseability poll skipped for --all; run 'nemar admin ci validate <id>' per dataset)",
        ),
      );
      console.log();

      const confirmResult = await confirm(
        `Deploy CI workflows to all ${datasets.length} datasets?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      // Fleet deploys always skip the parseability poll. With many datasets
      // the per-dataset 2.5–7.5 s wait adds up; users running --all typically
      // just want fast confirmation of commits. Admins can run
      // `nemar admin ci validate <id>` on individual datasets afterward.
      // skipValidate is intentionally unused here — --no-validate accepts but
      // is a no-op on the fleet path (consistent with what the help text
      // says).
      let succeeded = 0;
      let failed = 0;
      for (const ds of datasets) {
        const dsSpinner = ora(`Deploying to ${ds.dataset_id}...`).start();
        try {
          await addCi(ds.dataset_id);
          dsSpinner.succeed(`${ds.dataset_id}: deployed`);
          succeeded++;
        } catch (error) {
          const msg = error instanceof ApiError ? error.message : String(error);
          dsSpinner.fail(`${ds.dataset_id}: ${msg}`);
          failed++;
        }
      }

      console.log();
      console.log(
        chalk.cyan(`Done: ${succeeded} succeeded, ${failed} failed out of ${datasets.length}`),
      );
      return;
    }

    if (!datasetId) {
      console.error(chalk.red("Error: dataset-id is required (or use --all)"));
      return;
    }

    console.log(chalk.cyan(`\nDeploy CI workflows to: ${datasetId}\n`));
    console.log("This will add the following workflows:");
    console.log("  1. BIDS Validation (runs on PRs)");
    console.log("  2. Version Check (ensures version bump on PRs)");
    console.log("  3. PR Merge Handler (creates releases, publishes DOIs)");
    if (skipValidate) {
      console.log(chalk.dim("  (post-deploy parseability poll disabled via --no-validate)"));
    }
    console.log();

    const confirmResult = await confirm(`Deploy CI workflows to ${datasetId}?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Deploying CI workflows to ${datasetId}...`).start();

    let result: Awaited<ReturnType<typeof addCi>>;
    try {
      result = await addCi(datasetId);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to deploy CI workflows", {
        404: "Dataset not found",
      });
      return;
    }
    spinner.succeed("CI workflows deployed");
    console.log();
    for (const workflow of result.workflows_deployed) {
      console.log(`  ${chalk.green("[x]")} ${workflow}`);
    }

    if (!skipValidate) {
      const validateSpinner = ora("Verifying GitHub Actions can parse the workflows...").start();
      const validation = await pollCiValidation(datasetId);
      if (!validation) {
        validateSpinner.warn("Could not verify workflow parseability (deploy succeeded)");
      } else if (validation.missing.length === 0 && validation.errors.length === 0) {
        validateSpinner.succeed("All workflows parseable by GitHub Actions");
      } else {
        // missing.length > 0 and errors.length > 0 are independent: a 5xx on
        // the listing call (errors) doesn't necessarily mean any workflow
        // is missing. Be precise about which case is firing.
        const warnMsg =
          validation.missing.length > 0
            ? "Some workflows missing from GitHub Actions listing"
            : "Could not fully verify workflow parseability (GitHub API error)";
        validateSpinner.warn(warnMsg);
        printValidationWarning(validation);
      }
    }
    console.log();
  });

ciCommand
  .command("validate")
  .description("Check whether GitHub Actions can parse the deployed CI workflows")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;
    const spinner = ora(`Validating CI workflows for ${datasetId}...`).start();
    try {
      const r = await validateCi(datasetId);
      if (r.missing.length === 0 && r.errors.length === 0) {
        spinner.succeed(`All ${r.valid.length} workflows parseable by GitHub Actions`);
      } else {
        spinner.warn("Some workflows missing or unreadable");
        printValidationWarning({ missing: r.missing, errors: r.errors });
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to validate CI workflows", {
        404: "Dataset not found",
      });
    }
  });

ciCommand
  .command("sync")
  .description(
    "Sync deployed CI workflows to current templates (only writes drifted/missing files)",
  )
  .argument("[dataset-id]", "Dataset ID (e.g., nm000104)")
  .option("--all", "Sync across all dataset repositories")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: { all?: boolean } & ConfirmOptions) => {
    if (!requireAuth()) return;

    if (options.all) {
      const spinner = ora("Fetching dataset list...").start();
      let datasets: { dataset_id: string }[];
      try {
        const result = await listDatasets({ limit: 1000 });
        datasets = result.datasets;
        spinner.succeed(`Found ${datasets.length} datasets`);
        if (datasets.length >= 1000) {
          console.log(
            chalk.yellow("Warning: reached 1000 dataset limit; some datasets may be skipped"),
          );
        }
      } catch (error) {
        handleCommandError(error, spinner, "Failed to fetch datasets");
        return;
      }

      console.log(
        chalk.cyan(`\nSync CI templates across ${datasets.length} datasets (writes only diffs)\n`),
      );

      const confirmResult = await confirm(
        `Sync templates on all ${datasets.length} datasets?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      let upToDate = 0;
      let updated = 0;
      let withErrors = 0;
      for (const ds of datasets) {
        const dsSpinner = ora(`Syncing ${ds.dataset_id}...`).start();
        try {
          const result = await syncCi(ds.dataset_id);
          const changes = result.changed.length + result.added.length;
          if (result.errors.length > 0) {
            dsSpinner.warn(
              `${ds.dataset_id}: ${changes} updated, ${result.errors.length} error(s)`,
            );
            withErrors++;
          } else if (changes === 0) {
            dsSpinner.succeed(`${ds.dataset_id}: up to date`);
            upToDate++;
          } else {
            const parts: string[] = [];
            if (result.added.length > 0) parts.push(`+${result.added.length} added`);
            if (result.changed.length > 0) parts.push(`~${result.changed.length} updated`);
            dsSpinner.succeed(`${ds.dataset_id}: ${parts.join(", ")}`);
            updated++;
          }
        } catch (error) {
          const msg = error instanceof ApiError ? error.message : String(error);
          dsSpinner.fail(`${ds.dataset_id}: ${msg}`);
          withErrors++;
        }
      }

      console.log();
      console.log(
        chalk.cyan(`Done: ${upToDate} up-to-date, ${updated} updated, ${withErrors} with errors`),
      );
      return;
    }

    if (!datasetId) {
      console.error(chalk.red("Error: dataset-id is required (or use --all)"));
      return;
    }

    const spinner = ora(`Syncing CI templates for ${datasetId}...`).start();
    try {
      const result = await syncCi(datasetId);
      const changes = result.changed.length + result.added.length;
      if (result.errors.length > 0) {
        spinner.warn(`${datasetId}: ${result.errors.length} error(s)`);
      } else if (changes === 0) {
        spinner.succeed(`${datasetId}: already up to date`);
      } else {
        spinner.succeed(`${datasetId}: synced`);
      }
      console.log();
      console.log(`  ${chalk.dim("Checked:")} ${result.checked.join(", ")}`);
      if (result.added.length > 0) {
        console.log(`  ${chalk.green("Added:")}   ${result.added.join(", ")}`);
      }
      if (result.changed.length > 0) {
        console.log(`  ${chalk.yellow("Updated:")} ${result.changed.join(", ")}`);
      }
      if (!result.committed && changes > 0 && result.errors.length === 0) {
        // Defensive: the intended changes were computed but no commit
        // was made. Should never happen in practice (the helper sets
        // `committed: true` whenever it tries to write).
        console.log(`  ${chalk.yellow("Note:")}    listed changes were not committed`);
      }
      if (result.list_failed) {
        console.log(
          `  ${chalk.red("Warning:")} workflow directory listing failed; presence is unknown`,
        );
      }
      if (result.errors.length > 0) {
        console.log(`  ${chalk.red("Errors:")}`);
        for (const err of result.errors) console.log(`    - ${err}`);
      }
      console.log();
    } catch (error) {
      handleCommandError(error, spinner, "Failed to sync CI templates", {
        404: "Dataset not found",
      });
    }
  });

adminCommand.addCommand(ciCommand);

// ============================================================================
// DOI Management
// ============================================================================

const doiCommand = new Command("doi").description("DOI management");

doiCommand
  .command("create")
  .description("Create concept DOI for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--title <title>", "DOI title (defaults to dataset name)")
  .option("--description <desc>", "DOI description")
  .option("--provider <provider>", "DOI provider: ezid (default) or zenodo", "ezid")
  .option("--sandbox", "Use sandbox/test DOI")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      datasetId,
      options: {
        title?: string;
        description?: string;
        provider?: string;
        sandbox?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      // Get dataset info
      const spinner = ora("Fetching dataset info...").start();
      let dataset: Dataset;
      try {
        dataset = await getDataset(datasetId);
        spinner.succeed(`Found dataset: ${dataset.name}`);
      } catch (error) {
        if (error instanceof ApiError) {
          spinner.fail(error.message);
          if (error.statusCode === 404) {
            console.log(chalk.dim("  Dataset not found"));
          }
        } else {
          spinner.fail("Failed to fetch dataset");
        }
        return;
      }

      // Check if already has concept DOI
      try {
        const doiInfo = await getDoiInfo(datasetId);
        if (doiInfo.concept_doi) {
          console.log(chalk.yellow("\nDataset already has a concept DOI:"));
          console.log(`  Concept DOI: ${chalk.cyan(doiInfo.concept_doi)}`);
          if (doiInfo.zenodo_concept_url) {
            console.log(`  Zenodo URL:  ${doiInfo.zenodo_concept_url}`);
          }
          return;
        }
      } catch (err) {
        // DOI info unavailable (e.g., dataset has no DOI yet); continue to creation
        if (process.env.DEBUG) console.error("[debug] DOI info fetch:", err);
      }

      // Display summary
      console.log();
      console.log(chalk.cyan("Dataset Information:"));
      console.log(`  ID:          ${dataset.dataset_id}`);
      console.log(`  Name:        ${dataset.name}`);
      if (dataset.github_repo) {
        console.log(`  GitHub:      ${dataset.github_repo}`);
      }
      if (options.sandbox) {
        console.log(`  Mode:        ${chalk.yellow("SANDBOX (test DOI)")}`);
      }
      console.log();

      // Enhanced sandbox warning
      const provider = (options.provider === "zenodo" ? "zenodo" : "ezid") as "ezid" | "zenodo";

      if (options.sandbox) {
        console.log(chalk.yellow("━".repeat(60)));
        console.log(chalk.yellow.bold("                 SANDBOX MODE ENABLED"));
        console.log(chalk.yellow("━".repeat(60)));
        if (provider === "zenodo") {
          console.log(chalk.yellow("  • Using Zenodo sandbox (sandbox.zenodo.org)"));
        } else {
          console.log(chalk.yellow("  • Using EZID test shoulder (doi:10.5072/FK2)"));
          console.log(chalk.yellow("  • Test DOIs auto-delete after 2 weeks"));
        }
        console.log(chalk.yellow("  • DOI will NOT be indexed by DataCite"));
        console.log(chalk.yellow("  • DOI will NOT resolve in production"));
        console.log(chalk.yellow("  • Use this for testing workflows only"));
        console.log(chalk.yellow("━".repeat(60)));
        console.log();
      }

      // Confirmation
      console.log(chalk.red("WARNING: DOIs are PERMANENT and cannot be deleted!"));
      console.log(
        chalk.dim(
          "The DOI will be pre-reserved but not published until the first version release.",
        ),
      );
      console.log(`  Provider: ${chalk.cyan(provider.toUpperCase())}`);
      console.log();

      const confirmMessage = options.sandbox
        ? `Create TEST concept DOI via ${provider.toUpperCase()} SANDBOX?`
        : `Create PERMANENT concept DOI via ${provider.toUpperCase()} PRODUCTION?`;
      const result = await confirm(confirmMessage, options);
      if (result !== "confirmed") {
        console.log(chalk.dim(result === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      // Create concept DOI
      const createSpinner = ora(`Creating concept DOI via ${provider.toUpperCase()}...`).start();

      try {
        const result = await createConceptDoi(datasetId, {
          title: options.title,
          description: options.description,
          sandbox: options.sandbox,
          provider,
        });

        createSpinner.succeed("Concept DOI created successfully");

        // Finalize repo setup now that the dataset has a DOI: default branch,
        // CI workflow shims, auto-merge, owner maintain. Branch protection is
        // applied at make-public, not here (epic #713).
        const protectionSpinner = ora("Finalizing repository setup...").start();
        try {
          const finalizeResult = await finalizeDataset(datasetId);
          if (finalizeResult.warnings && finalizeResult.warnings.length > 0) {
            protectionSpinner.warn("Repository setup finalized with warnings");
            for (const warning of finalizeResult.warnings) {
              console.log(chalk.yellow(`  Warning: ${warning}`));
            }
          } else {
            protectionSpinner.succeed("Repository setup finalized");
          }
        } catch (protectionError) {
          protectionSpinner.warn("Could not finalize repository setup");
          if (protectionError instanceof ApiError) {
            console.log(chalk.dim(`  ${protectionError.message}`));
            if (protectionError.statusCode === 403) {
              console.log(chalk.dim("  Check admin credentials and permissions"));
            }
          } else {
            console.log(
              chalk.dim(
                `  ${protectionError instanceof Error ? protectionError.message : "Unknown error"}`,
              ),
            );
          }
        }

        console.log();
        console.log(chalk.green("DOI Information:"));
        console.log(`  Concept DOI: ${chalk.cyan(result.concept_doi)}`);
        console.log(`  Provider:    ${result.provider.toUpperCase()}`);
        if (result.provider === "ezid") {
          console.log(`  DOI URL:     ${result.doi_url}`);
          console.log(`  EZID ID:     ${result.ezid_identifier}`);
        } else {
          console.log(`  Zenodo URL:  ${result.zenodo_url}`);
        }
        if (result.metadata_warning) {
          console.log(chalk.yellow(`  Warning:     ${result.metadata_warning}`));
        }
        console.log();

        console.log(chalk.yellow("Next steps:"));
        console.log("  1. Update dataset_description.json with DatasetDOI field");
        console.log("  2. Create a PR and merge it to trigger version DOI publication");
        console.log();
        if (options.sandbox) {
          console.log(chalk.dim("Note: This is a sandbox DOI and will not resolve in production."));
        }
      } catch (error) {
        if (error instanceof ApiError) {
          createSpinner.fail(error.message);
          if (error.statusCode === 403) {
            console.log(chalk.dim("  This command requires admin privileges"));
          }
        } else {
          createSpinner.fail("Failed to create concept DOI");
          console.log(chalk.dim(`  ${errorDetail(error)}`));
        }
      }
    },
  );

doiCommand
  .command("info")
  .description("Get DOI info for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .action(async (datasetId) => {
    if (!requireAuth()) return;

    const spinner = ora("Fetching DOI info...").start();

    try {
      const doiInfo = await getDoiInfo(datasetId);
      spinner.stop();

      console.log();
      console.log(chalk.cyan(`DOI Information for ${datasetId}:`));
      console.log(`  Dataset Name:    ${doiInfo.name}`);
      console.log();

      if (doiInfo.concept_doi) {
        console.log(chalk.green("Concept DOI:"));
        console.log(`  DOI:      ${doiInfo.concept_doi}`);
        console.log(`  URL:      https://doi.org/${doiInfo.concept_doi}`);
        console.log(`  Provider: ${(doiInfo.doi_provider || "zenodo").toUpperCase()}`);

        if (doiInfo.doi_provider === "ezid") {
          if (doiInfo.ezid_identifier) {
            console.log(`  EZID ID:  ${doiInfo.ezid_identifier}`);
          }
          if (doiInfo.ezid_status) {
            const statusColor = doiInfo.ezid_status === "public" ? chalk.green : chalk.yellow;
            console.log(`  Status:   ${statusColor(doiInfo.ezid_status)}`);
          }
        }

        if (doiInfo.zenodo_concept_url) {
          console.log(`  Zenodo:   ${doiInfo.zenodo_concept_url}`);

          // Detect and warn about sandbox DOIs
          if (doiInfo.zenodo_concept_url.includes("sandbox.zenodo.org")) {
            console.log();
            console.log(chalk.yellow("Mode: SANDBOX (test DOI)"));
            console.log(
              chalk.yellow(
                "  This DOI is not indexed by DataCite and will not resolve in production",
              ),
            );
          }
        }
      } else {
        console.log(chalk.yellow("No concept DOI created yet"));
        console.log(chalk.dim("  Use 'nemar admin doi create' to create one"));
      }

      console.log();

      if (doiInfo.latest_version_doi) {
        console.log(chalk.green("Latest Version DOI:"));
        console.log(`  DOI:  ${doiInfo.latest_version_doi}`);
        console.log(`  URL:  https://doi.org/${doiInfo.latest_version_doi}`);
      } else if (doiInfo.concept_doi) {
        console.log(chalk.yellow("No version DOI published yet"));
        console.log(chalk.dim("  Version DOIs are created automatically on PR merge"));
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 404) {
          console.log(chalk.dim("  Dataset not found"));
        } else if (error.statusCode === 403) {
          console.log(chalk.dim("  This command requires admin privileges"));
        }
      } else {
        spinner.fail("Failed to fetch DOI info");
      }
    }
  });

doiCommand
  .command("update")
  .description("Update EZID DOI metadata or status")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--make-public", "Transition DOI from reserved to public (permanent)")
  .option(
    "--unavailable",
    "Tombstone the concept DOI (EZID _status=unavailable); concept-only, reversible via --make-public. For a full withdrawal (visibility + every version DOI) use 'nemar admin withdraw' instead.",
  )
  .option("--refresh", "Refresh metadata from dataset_description.json and .nemar/metadata.json")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      datasetId: string,
      options: { makePublic?: boolean; unavailable?: boolean; refresh?: boolean } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (options.makePublic && options.unavailable) {
        console.log(chalk.red("Use --make-public or --unavailable, not both."));
        return;
      }

      if (!options.makePublic && !options.unavailable && !options.refresh) {
        console.log(
          chalk.yellow("No action specified. Use --make-public, --unavailable, and/or --refresh."),
        );
        return;
      }

      if (options.makePublic) {
        console.log(chalk.red("WARNING: Making a DOI public is PERMANENT!"));
        console.log(chalk.dim("  The DOI will be findable in DataCite and cannot be reverted."));
        console.log();

        const confirmResult = await confirm(
          `Make DOI for ${datasetId} PUBLIC and permanent?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      if (options.unavailable) {
        console.log(chalk.yellow("This tombstones the concept DOI (EZID _status=unavailable)."));
        console.log(chalk.dim("  Reversible with --make-public. Version DOIs are untouched."));
        console.log();

        const confirmResult = await confirm(
          `Mark DOI for ${datasetId} unavailable (tombstone)?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      const spinner = ora("Updating DOI...").start();

      try {
        const result = await updateDoi(datasetId, {
          status: options.makePublic ? "public" : options.unavailable ? "unavailable" : undefined,
          refresh_metadata: options.refresh,
        });

        spinner.succeed("DOI updated successfully");
        console.log();
        console.log(`  EZID ID: ${chalk.cyan(result.ezid_identifier)}`);
        console.log(
          `  Status:  ${result.status === "public" ? chalk.green(result.status) : chalk.yellow(result.status)}`,
        );
        console.log(`  URL:     ${result.doi_url}`);
      } catch (error) {
        if (error instanceof ApiError) {
          spinner.fail(error.message);
          if (error.statusCode === 400) {
            console.log(chalk.dim("  DOI update is only supported for EZID-managed DOIs"));
          }
        } else {
          spinner.fail("Failed to update DOI");
          console.log(chalk.dim(`  ${errorDetail(error)}`));
        }
      }
    },
  );

doiCommand
  .command("enrich")
  .description("Enrich DOI metadata with ORCIDs, descriptions, funding, and more")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--no-llm", "Skip LLM-based enrichment from README")
  .option("--sandbox", "Use sandbox DOI")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (datasetId: string, options: { llm?: boolean; sandbox?: boolean } & ConfirmOptions) => {
      if (!requireAuth()) return;

      const spinner = ora("Fetching dataset and existing enrichment...").start();

      // Get dataset info
      let dataset: Dataset;
      try {
        dataset = await getDataset(datasetId);
        spinner.succeed(`Dataset: ${dataset.name}`);
      } catch (error) {
        if (error instanceof ApiError) {
          spinner.fail(error.message);
        } else {
          spinner.fail("Failed to fetch dataset");
        }
        return;
      }

      // Get DOI info
      let doiInfo: Awaited<ReturnType<typeof getDoiInfo>> | undefined;
      let doiFetchFailed = false;
      try {
        doiInfo = await getDoiInfo(datasetId);
      } catch (doiErr) {
        if (doiErr instanceof ApiError && doiErr.statusCode === 404) {
          // No DOI exists yet
        } else {
          doiFetchFailed = true;
          console.log(chalk.yellow(`  Warning: Could not fetch DOI info: ${errorDetail(doiErr)}`));
        }
      }

      if (doiInfo?.concept_doi) {
        console.log(`  DOI: ${chalk.cyan(doiInfo.concept_doi)}`);
      }

      // Fetch existing .nemar/metadata.json to merge with (never overwrite)
      let enrichment: NemarMetadataPayload = { version: "2.0" };
      if (dataset.github_repo) {
        const metaSpinner = ora("Reading existing metadata...").start();
        const existingContent = await fetchGitHubFileContent(
          dataset.github_repo,
          ".nemar/metadata.json",
        );
        if (existingContent) {
          try {
            const parsed = JSON.parse(existingContent);
            if (parsed && typeof parsed === "object" && parsed.version === "2.0") {
              enrichment = parsed as NemarMetadataPayload;
              metaSpinner.succeed(
                `Loaded existing metadata (stage: ${(parsed as Record<string, unknown>).pipeline_stage || "unknown"})`,
              );
            } else {
              metaSpinner.warn("Existing metadata has unsupported version, starting fresh");
            }
          } catch (parseErr) {
            metaSpinner.warn(
              `Could not parse existing metadata (${parseErr instanceof Error ? parseErr.message : String(parseErr)}), starting fresh`,
            );
          }
        } else {
          metaSpinner.info("No existing .nemar/metadata.json found, starting fresh");
        }
      }

      // --- LLM Enrichment (triggers CI workflow on GitHub Actions) ---
      // Run BEFORE manual author entry so discovered ORCIDs are shown for confirmation
      if (options.llm !== false && dataset.github_repo) {
        console.log();
        console.log(chalk.cyan("--- Running LLM enrichment pipeline (CI workflow) ---"));

        const llmSpinner = ora("Triggering run-enrichment workflow...").start();
        try {
          const { spawn: bunSpawn } = await import("bun");
          const repo = dataset.github_repo;
          // Phase 1 of centralization (#602): the enrichment workflow now
          // lives at nemarDatasets/.github/.github/workflows/run-enrichment.yml.
          // We trigger it with the target dataset_id in the workflow_dispatch
          // inputs; the central workflow mints a per-repo App token, checks
          // out the dataset repo, and hands off to /webhooks/llm-enrich the
          // same way the legacy per-repo workflow did.
          const CENTRAL_WORKFLOW_REPO = "nemarDatasets/.github";
          const CENTRAL_WORKFLOW_FILE = "run-enrichment.yml";

          // Trigger the workflow
          const trigger = bunSpawn({
            cmd: [
              "gh",
              "workflow",
              "run",
              CENTRAL_WORKFLOW_FILE,
              "--repo",
              CENTRAL_WORKFLOW_REPO,
              "--ref",
              "main",
              "-f",
              `dataset_id=${datasetId}`,
              "-f",
              "ref=main",
              "-f",
              "force=true",
            ],
            stdout: "pipe",
            stderr: "pipe",
          });
          const triggerErr = await new Response(trigger.stderr).text();
          const triggerExit = await trigger.exited;
          if (triggerExit !== 0) {
            throw new Error(`Failed to trigger workflow: ${triggerErr.trim()}`);
          }

          llmSpinner.text = "Waiting for workflow to register...";
          await new Promise((r) => setTimeout(r, 3000));

          // Poll for completion. Filter runs by the dataset_id we just
          // dispatched against — multiple datasets share the central
          // workflow so we can't just look at the latest run.
          llmSpinner.text = "Polling workflow status...";
          const maxAttempts = 60; // 5 minutes at 5s intervals
          let conclusion = "";
          let consecutiveFailures = 0;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const poll = bunSpawn({
              cmd: [
                "gh",
                "run",
                "list",
                "--repo",
                CENTRAL_WORKFLOW_REPO,
                "--workflow",
                CENTRAL_WORKFLOW_FILE,
                "-L",
                "10",
                "--json",
                "databaseId,status,conclusion,displayTitle,event",
              ],
              stdout: "pipe",
              stderr: "pipe",
            });
            const pollOut = await new Response(poll.stdout).text();
            const pollErr = await new Response(poll.stderr).text();
            const pollExit = await poll.exited;

            if (pollExit !== 0) {
              consecutiveFailures++;
              if (consecutiveFailures >= 3) {
                llmSpinner.warn(`gh CLI error: ${pollErr.trim()}`);
                break;
              }
              await new Promise((r) => setTimeout(r, 5000));
              continue;
            }

            try {
              const runs = JSON.parse(pollOut.trim()) as Array<{
                databaseId: number;
                status: string;
                conclusion: string | null;
                displayTitle?: string;
                event?: string;
              }>;
              consecutiveFailures = 0;
              // Multiple datasets can share the central workflow, so picking
              // runs[0] outright is unsafe — a concurrent push-triggered
              // dispatch would shadow ours. Filter to the most recent
              // workflow_dispatch (which is how this CLI dispatches) and
              // accept the small race where two operators run `nemar admin
              // enrich` within seconds of each other. Centralization
              // followup: include a correlation ID once GitHub exposes
              // dispatch->run_id linkage.
              const ours = runs.find((r) => r.event === "workflow_dispatch");
              if (ours) {
                if (ours.status === "completed") {
                  conclusion = ours.conclusion || "unknown";
                  break;
                }
                llmSpinner.text = `Workflow ${ours.status}... (${attempt * 5}s)`;
              }
            } catch (parseErr) {
              consecutiveFailures++;
              if (consecutiveFailures >= 3) {
                llmSpinner.warn(
                  `Unable to parse workflow status: ${parseErr instanceof Error ? parseErr.message : String(parseErr)} (raw: ${pollOut.trim().slice(0, 200)})`,
                );
                break;
              }
            }

            await new Promise((r) => setTimeout(r, 5000));
          }

          let discoveryRan = false;
          if (!conclusion) {
            llmSpinner.warn("Workflow timed out after 5 minutes (may still be running)");
          } else if (conclusion === "success") {
            llmSpinner.succeed("LLM enrichment workflow completed successfully");

            // Re-read metadata from repo since CI committed it
            const updatedContent = await fetchGitHubFileContent(repo, ".nemar/metadata.json");
            if (updatedContent) {
              try {
                const parsed = JSON.parse(updatedContent);
                if (parsed && typeof parsed === "object" && parsed.version === "2.0") {
                  // Merge LLM results into enrichment (preserves any fields set by earlier steps)
                  Object.assign(enrichment, parsed);
                  discoveryRan = true;
                  const stage = parsed.pipeline_stage || "unknown";
                  console.log(chalk.dim(`  Pipeline stage: ${stage}`));
                  if (enrichment.authors) {
                    const authorCount = Object.keys(enrichment.authors).length;
                    console.log(chalk.dim(`  Authors: ${authorCount}`));
                  }
                }
              } catch (parseErr) {
                console.log(
                  chalk.yellow(
                    `  Warning: Could not parse updated metadata: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                  ),
                );
                console.log(chalk.dim("  Using pre-workflow enrichment data"));
              }
            } else {
              console.log(
                chalk.yellow(
                  "  Warning: Could not fetch updated metadata after successful workflow.",
                ),
              );
              console.log(chalk.dim("  Author data below may be from a previous run."));
            }
          } else {
            llmSpinner.fail(`LLM enrichment workflow failed (conclusion: ${conclusion})`);
          }

          if (!discoveryRan) {
            console.log(
              chalk.yellow(
                "  ORCID discovery did not complete. Authors below may be from previous metadata.",
              ),
            );
          }
        } catch (error) {
          llmSpinner.fail("LLM enrichment pipeline failed");
          console.log(chalk.dim(`  ${errorDetail(error)}`));
          console.log(
            chalk.yellow("  ORCID discovery did not run. You will need to enter ORCIDs manually."),
          );
        }
      }

      // --- Author ORCIDs (confirm discovered + supplement missing) ---
      console.log();
      console.log(chalk.cyan("--- Author ORCIDs ---"));

      // Show authors discovered by the pipeline
      const existingAuthors = enrichment.authors || {};
      const authorNames = Object.keys(existingAuthors);
      if (authorNames.length > 0) {
        const withOrcid = authorNames.filter((n) => existingAuthors[n]?.orcid);
        const withoutOrcid = authorNames.filter((n) => !existingAuthors[n]?.orcid);
        console.log(chalk.dim(`  Discovered ${authorNames.length} authors from pipeline:`));
        for (const name of withOrcid) {
          console.log(chalk.green(`    [x] ${name}: ${existingAuthors[name]?.orcid}`));
        }
        for (const name of withoutOrcid) {
          console.log(chalk.yellow(`    [ ] ${name}: no ORCID found`));
        }
        if (withoutOrcid.length > 0) {
          console.log(chalk.dim(`  ${withoutOrcid.length} author(s) missing ORCIDs.`));
        }
      }

      const { updateAuthors } = await inquirer.prompt([
        {
          type: "confirm",
          name: "updateAuthors",
          message:
            authorNames.length > 0
              ? "Add or correct author ORCIDs?"
              : "Add author ORCIDs manually?",
          default: false,
        },
      ]);

      if (updateAuthors) {
        const authors: Record<string, { orcid?: string; affiliations?: Array<{ name: string }> }> =
          {};

        let addMore = true;
        while (addMore) {
          const { authorName } = await inquirer.prompt([
            {
              type: "input",
              name: "authorName",
              message: 'Author name (as in BIDS, e.g., "Shirazi, Yahya"):',
            },
          ]);
          if (!authorName) break;

          // Show current ORCID if one was discovered
          const current = existingAuthors[authorName];
          if (current?.orcid) {
            console.log(chalk.dim(`  Current ORCID: ${current.orcid}`));
          }

          const { orcid } = await inquirer.prompt([
            {
              type: "input",
              name: "orcid",
              message: `ORCID for "${authorName}" (Enter to ${current?.orcid ? "keep current" : "skip"}):`,
              validate: (input: string) => {
                if (!input) return true;
                return ORCID_REGEX.test(input) || "Invalid ORCID format (XXXX-XXXX-XXXX-XXXX)";
              },
            },
          ]);

          const entry: { orcid?: string; affiliations?: Array<{ name: string }> } = {};
          if (orcid) entry.orcid = orcid;

          const { affiliation } = await inquirer.prompt([
            {
              type: "input",
              name: "affiliation",
              message: `Affiliation for "${authorName}" (optional):`,
            },
          ]);
          if (affiliation) entry.affiliations = [{ name: affiliation }];

          if (entry.orcid || entry.affiliations) {
            authors[authorName] = entry;
          }

          const { more } = await inquirer.prompt([
            { type: "confirm", name: "more", message: "Add another author?", default: true },
          ]);
          addMore = more;
        }

        if (Object.keys(authors).length > 0) {
          // Deep-merge: preserve discovered fields (e.g., ORCID) when user only adds affiliation
          const merged = { ...(enrichment.authors || {}) };
          for (const [name, manualEntry] of Object.entries(authors)) {
            const existing = merged[name] || {};
            merged[name] = {
              ...existing,
              ...manualEntry,
              orcid: manualEntry.orcid || existing.orcid,
            };
          }
          enrichment.authors = merged;
        }
      }

      // --- Dataset stats (sizes/formats) ---
      console.log();
      console.log(chalk.cyan("--- Dataset stats ---"));
      const statsSpinner = ora("Computing dataset sizes and formats...").start();
      try {
        const filesInfo = await getDatasetFiles(datasetId);
        const totalSizeStr = formatBytesCli(filesInfo.total_size);
        enrichment.sizes = [`${totalSizeStr} (${filesInfo.file_count} files)`];
        enrichment.formats = filesInfo.extensions;
        statsSpinner.succeed(
          `Sizes: ${totalSizeStr} (${filesInfo.file_count} files), Formats: ${filesInfo.extensions.join(", ")}`,
        );
      } catch (error) {
        statsSpinner.warn("Could not compute dataset stats");
        console.log(chalk.dim(`  ${errorDetail(error)}`));
      }

      // --- Review ---
      console.log();
      console.log(chalk.cyan("--- Review ---"));
      console.log(JSON.stringify(enrichment, null, 2));
      console.log();

      const confirmResult = await confirm("Commit to repo and refresh DOI?", options, true);
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      // Submit enrichment
      const submitSpinner = ora("Saving enrichment...").start();
      try {
        const result = await submitEnrichment(datasetId, enrichment);
        submitSpinner.succeed(result.message);

        if (result.bidsignore_updated) {
          console.log(chalk.dim("  .bidsignore updated to include .nemar/"));
        }

        // Refresh DOI metadata if the dataset has an EZID DOI
        // Re-attempt DOI info fetch if it failed earlier (transient error)
        if (!doiInfo && doiFetchFailed) {
          try {
            doiInfo = await getDoiInfo(datasetId);
          } catch (err) {
            if (process.env.DEBUG) console.error("[debug] DOI info re-fetch:", err);
          }
        }
        if (doiInfo?.ezid_identifier) {
          const refreshSpinner = ora("Refreshing DOI metadata...").start();
          try {
            await updateDoi(datasetId, { refresh_metadata: true });
            refreshSpinner.succeed("DOI metadata refreshed");
          } catch (error) {
            refreshSpinner.warn("Could not refresh DOI metadata");
            console.log(chalk.dim(`  ${errorDetail(error)}`));
          }
        } else if (doiFetchFailed) {
          console.log(
            chalk.yellow(
              "  DOI refresh skipped: could not verify DOI exists. Run 'nemar admin doi update --refresh' manually.",
            ),
          );
        }
      } catch (error) {
        if (error instanceof ApiError) {
          submitSpinner.fail(error.message);
        } else {
          submitSpinner.fail("Failed to save enrichment");
          console.log(chalk.dim(`  ${errorDetail(error)}`));
        }
      }
    },
  );

adminCommand.addCommand(doiCommand);

// ============================================================================
// Publication Workflow (Admin)
// ============================================================================

const publishCommand = new Command("publish").description("Publication workflow management");

publishCommand
  .command("list")
  .description("List publication requests")
  .option("-s, --status <status>", "Filter by status (requested, approving, published, denied)")
  .addHelpText(
    "after",
    `
Description:
  List all publication requests from users, with optional filtering by status.
  Shows dataset ID, status, requesting user, and current progress.

Filter Options:
  requested  - Pending requests awaiting admin action
  approving  - Currently being processed by orchestrator
  published  - Successfully published datasets
  denied     - Denied requests with reasons

Examples:
  $ nemar admin publish list                # All requests
  $ nemar admin publish list --status requested   # Pending only
  $ nemar admin publish list --status approving   # In progress
  $ nemar admin publish list --status denied      # View denied`,
  )
  .action(async (options: { status?: string }) => {
    if (!requireAuth()) return;

    const spinner = ora("Fetching publication requests...").start();

    try {
      const result = await listPublishRequests(options.status);
      spinner.stop();

      if (result.requests.length === 0) {
        console.log(chalk.dim("\n  No publication requests found.\n"));
        return;
      }

      console.log(`\n${chalk.cyan("Publication Requests")} (${result.count})\n`);

      for (const req of result.requests) {
        const statusColor =
          req.status === "published"
            ? chalk.green
            : req.status === "denied"
              ? chalk.red
              : req.status === "approving"
                ? chalk.yellow
                : chalk.white;

        console.log(
          `  ${chalk.bold(req.dataset_id)}  ${statusColor(req.status)}  by ${req.requested_by_username}  ${chalk.dim(req.requested_at)}`,
        );
        // #1408: an anonymous release and a publication reach this list
        // looking identical, and approving the wrong one is not reversible in
        // either direction -- publishing names a depositor who asked to be
        // concealed; releasing anonymously withholds a DOI someone needs.
        if (req.anonymous === 1) {
          console.log(
            `    ${chalk.yellow("! anonymous release:")} ${chalk.dim(
              "repository stays private, DOI stays reserved, depositor is not named",
            )}`,
          );
        }
        // Epic #1610 phase 4: the identifier screen, in the backend's words.
        for (const line of identifierScreenLines(req.identifier_screen, 4)) console.log(line);
        if (req.current_step && req.status === "approving") {
          console.log(
            `    ${chalk.yellow(">")} ${req.current_step.replace(/_/g, " ")}${req.last_error ? chalk.red(` (${req.last_error})`) : ""}`,
          );
        }
        // Non-blocking pre-screen advisory (#756): a concern for the admin to
        // weigh before approving, NOT a block.
        if (req.prescreen_status === "concern") {
          let reasons: string[] = [];
          try {
            const parsed = JSON.parse(req.prescreen_reasons || "[]");
            if (Array.isArray(parsed)) reasons = parsed.filter((x) => typeof x === "string");
          } catch {
            // malformed -> show the flag without inline reasons
          }
          const summary = reasons.length ? reasons.join("; ") : "see pre-screen";
          console.log(`    ${chalk.yellow("! pre-screen advisory:")} ${chalk.dim(summary)}`);
        }
      }
      console.log();
    } catch (error) {
      handleCommandError(error, spinner, "Failed to list publication requests");
    }
  });

publishCommand
  .command("deny")
  .description("Deny a publication request")
  .argument("<dataset-id>", "Dataset ID")
  .option("-r, --reason <reason>", "Reason for denial")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Deny a user's publication request with a specific reason.
  The user will receive an email notification with your reason.

  A clear, actionable reason helps users understand what to fix
  before resubmitting their publication request.

Requirements:
  - Must provide a reason for denial
  - Reason will be sent to the user via email
  - User can fix issues and submit a new request

Examples:
  $ nemar admin publish deny nm000104 --reason "BIDS validation failing"
  $ nemar admin publish deny nm000104 -r "Dataset incomplete - missing subjects"
  $ nemar admin publish deny nm000104    # Prompts for reason interactively`,
  )
  .action(async (datasetId, options: ConfirmOptions & { reason?: string }) => {
    if (!requireAuth()) return;

    let reason = options.reason;
    if (!reason) {
      const { inputReason } = await inquirer.prompt([
        { type: "input", name: "inputReason", message: "Reason for denial:" },
      ]);
      reason = inputReason;
    }

    if (!reason) {
      console.log(chalk.red("Reason is required"));
      return;
    }

    const confirmResult = await confirm(`Deny publication of ${datasetId}?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Denying publication for ${datasetId}...`).start();

    try {
      await denyPublication(datasetId, reason);
      spinner.succeed(`Publication denied for ${datasetId}`);
      console.log(chalk.dim("  User has been notified."));
    } catch (error) {
      handleCommandError(error, spinner, "Failed to deny publication");
    }
  });

publishCommand
  .command("screen")
  .description("Re-run the identifier screen of a publication request")
  .argument("<dataset-id>", "Dataset ID")
  .addHelpText(
    "after",
    `
Description:
  Dispatch the identifier screen again for the dataset's active publication
  request (requested or blocked). Use it when the screen did not run, did not
  report, or read a commit that is no longer the repository's main. The admins
  are mailed when it reports, as for a new request.

  Refused while a screen is already running and recent, and for sandbox (xx)
  datasets, which are not screened.

Examples:
  $ nemar admin publish screen nm000104`,
  )
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;
    const spinner = ora(`Re-running the identifier screen for ${datasetId}...`).start();
    try {
      const result = await rerunIdentifierScreen(datasetId);
      if (result.status === "pending") {
        spinner.succeed(`Identifier screen dispatched for ${datasetId}`);
        console.log(chalk.dim("  The admins are mailed when it reports."));
      } else {
        spinner.warn(`The identifier screen for ${datasetId} could not be started`);
        for (const line of identifierScreenLines(result.identifier_screen)) console.log(line);
        console.log(chalk.dim("  The admins have been mailed this result."));
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to re-run the identifier screen");
      process.exitCode = 1;
    }
  });

publishCommand
  .command("approve")
  .description("Approve and publish a dataset (runs orchestrator)")
  .argument("<dataset-id>", "Dataset ID")
  .option("--resume", "Resume from last failed step")
  .option("--sandbox", "Use Zenodo sandbox for testing")
  .option("--skip-ci-check", "Skip BIDS validation CI check (admin override)")
  .option(
    "--acknowledge-identifier-screen <reason>",
    "Approve over an identifier screen that needs review, recording why (10 to 500 characters)",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Approve a publication request and run the automated orchestrator
  to make the dataset publicly accessible with a permanent DOI.

  The request's IDENTIFIER SCREEN must allow it first. A clean screen passes.
  A screen that needs review, or could not look at everything, passes only with
  --acknowledge-identifier-screen "<reason>", which is recorded with your name.
  Direct identifiers cannot be acknowledged: the depositor fixes the data and
  requests again. A screen that did not run or did not report must be re-run
  with 'nemar admin publish screen <dataset-id>', and so must one whose commit
  is no longer the repository's main. 'nemar admin publish list' shows it.

  An ANONYMOUS RELEASE runs a smaller step set: the GitHub repository stays
  private, no identifier is published, and the depositor is not named. The
  confirmation banner reads the pending request and lists what will actually
  run, so approve one and read the banner rather than this list.

  WARNING: This action is PERMANENT. Published datasets cannot be unpublished.
  Once a DOI is assigned, it is permanent and cannot be deleted.

Orchestrator Steps (execution order; shared/publication-steps.ts):
   1. CI Check          - Verify BIDS validation passes, deploy workflows if missing
   2. Enrichment Check  - Verify metadata pipeline has run (warn-only, non-blocking)
   3. S3 Public Read    - Grant public read access to S3 data
   4. Repo Public       - Publish the catalog row; for an ordinary publication
                          this also makes the GitHub repository public, and for
                          an anonymous release the repository stays private
   5. Tag Protection    - Enable tag protection rules
   6. Create DOI        - Create concept DOI via EZID (or Zenodo if configured)
   7. Update Metadata   - Update dataset metadata from BIDS description
   8. Update README     - Add DOI badge and citation info to README
   9. Create Tag        - Create version tag (e.g., v1.0.0)
  10. Create Release    - Create GitHub release from tag
  11. Upload to Zenodo  - Legacy Zenodo upload (disabled; kept for step history)
  12. Publish DOI       - Make DOI public and findable (permanent, irreversible)
  13. Version DOI       - Mint the version DOI and dispatch the manifest job,
                          which is what records the version. Runs for an
                          anonymous release too, minting RESERVED (#1447)
  14. S3 Lock           - Enable S3 Object Lock (prevents data deletion)
  15. Sync NEMAR        - Legacy nemar.org sync (no-op, retired)
  16. Notify User       - Send publication confirmation email

  (Archive zip generation is not an orchestrator step; the version-DOI
  workflow dispatches it separately.)

  Steps 7, 8, 11 and 12 are skipped for an anonymous release: each one either
  publishes an identifier or writes one into a file the data plane serves
  publicly. See ANONYMOUS_RELEASE_SKIPPED_STEPS in shared/publication-steps.ts,
  which states the reason for each.

Resume Capability:
  If a step fails, the orchestrator saves progress. Use --resume to retry
  from the failed step without re-running successful steps.

  The orchestrator is idempotent - safe to run multiple times. Completed
  steps are automatically skipped.

Examples:
  $ nemar admin publish approve nm000104                    # Run full orchestrator
  $ nemar admin publish approve nm000104 --resume           # Resume from failed step
  $ nemar admin publish approve nm000104 --skip-ci-check    # Override BIDS validation
  $ nemar admin publish approve nm000104 --yes              # Skip confirmation

After Approval:
  - User receives email with DOI and public dataset link
  - Dataset is publicly visible on GitHub
  - Tags are protected (prevents version manipulation)
  - Data is protected by S3 Object Lock`,
  )
  .action(
    async (
      datasetId,
      options: ConfirmOptions & {
        resume?: boolean;
        sandbox?: boolean;
        skipCiCheck?: boolean;
        acknowledgeIdentifierScreen?: string;
      },
    ) => {
      if (!requireAuth()) return;

      const ack = options.acknowledgeIdentifierScreen?.trim();
      if (ack !== undefined && (ack.length < 10 || ack.length > 500)) {
        console.log(
          chalk.red("--acknowledge-identifier-screen needs a reason of 10 to 500 characters."),
        );
        process.exitCode = 1;
        return;
      }

      const action = options.resume
        ? `Resume publication of ${datasetId}`
        : `Approve and publish ${datasetId}`;
      console.log(chalk.cyan(`\n${action}\n`));

      // Ask the server what this request IS before describing what approving
      // it will do (#1447). An anonymous release runs a strictly smaller step
      // set, and the banner used to be a hand-numbered literal of all sixteen:
      // an admin approving one was told the repository would be made public
      // and the DOI published irreversibly, and neither happens. A banner that
      // describes the wrong operation is worse than no banner, because it is
      // the screen the decision is made from.
      let anonymousRelease = false;
      let planUnknownReason: string | null = null;
      try {
        anonymousRelease = (await getPublishStatus(datasetId)).anonymous === true;
      } catch (err) {
        // Unreadable state is not a reason to refuse an approval the admin can
        // still make, but it IS a reason to stop asserting what will happen --
        // and to say WHY. A bare `catch {}` here printed "could not read the
        // request's state" for an expired key, a 404 and a network failure
        // alike, which is three different next actions rendered as one.
        planUnknownReason = err instanceof Error ? err.message : String(err);
      }

      const steps = stepsForRelease(anonymousRelease);
      if (planUnknownReason === null) {
        console.log(
          anonymousRelease
            ? `This is an ANONYMOUS RELEASE and will run ${steps.length} of the ${PUBLICATION_STEPS.length} orchestrator steps:`
            : `This will run the following ${steps.length}-step orchestrator:`,
        );
      } else {
        console.log(
          chalk.yellow(
            `Could not read the request's state (${planUnknownReason}), so this lists all ${steps.length} steps; an anonymous release runs fewer.`,
          ),
        );
      }
      // Two columns, generated from the step list rather than typed out, so
      // adding a step cannot leave the banner describing the old publication.
      const half = Math.ceil(steps.length / 2);
      for (let i = 0; i < half; i++) {
        const left = steps[i];
        const right = steps[i + half];
        const label = (step: (typeof steps)[number], n: number): string => {
          const text =
            step === "doi_create" && options.sandbox
              ? `${PUBLICATION_STEP_LABELS[step]} (SANDBOX)`
              : PUBLICATION_STEP_LABELS[step];
          return `${String(n).padStart(2, " ")}. ${text}`;
        };
        const leftCell = label(left, i + 1).padEnd(34, " ");
        console.log(`   ${leftCell}${right ? label(right, i + half + 1) : ""}`.trimEnd());
      }
      if (anonymousRelease) {
        console.log();
        console.log(
          chalk.yellow("  The GitHub repository stays PRIVATE and no identifier is published:"),
        );
        console.log(
          chalk.yellow(
            "  the concept and version DOIs stay reserved until the deposit is published for real.",
          ),
        );
      }
      console.log();

      // Sandbox warning
      if (options.sandbox) {
        console.log(chalk.yellow("━".repeat(60)));
        console.log(chalk.yellow.bold("                 SANDBOX MODE ENABLED"));
        console.log(chalk.yellow("━".repeat(60)));
        console.log(chalk.yellow("  • DOI will be created in sandbox mode (EZID test shoulder)"));
        console.log(chalk.yellow("  • DOI will NOT be indexed by DataCite"));
        console.log(chalk.yellow("  • DOI will NOT resolve in production"));
        console.log(chalk.yellow("  • Use this for testing workflows only"));
        console.log(chalk.yellow("━".repeat(60)));
        console.log();
      }

      const confirmResult = await confirm(`${action}?`, options);
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      const initialSpinnerText = "Running publication workflow (this may take a few minutes)...";
      const spinner = ora(initialSpinnerText).start();

      // Most recent step label rendered into the spinner; kept on the
      // outer scope so onRetry can restore the same line after the
      // retry notice instead of falling back to the generic text.
      let currentSpinnerText = initialSpinnerText;

      /**
       * Render the spinner line for a progress event. Shows the step
       * position and, for s3_lock, a running locked/total ratio so the
       * admin can see thousands-of-objects datasets making progress
       * instead of staring at a static spinner for minutes. See #284.
       */
      function renderProgress(info: PublishProgressInfo): string {
        const stepLabel = info.step.replace(/_/g, " ");
        const head = `Step ${info.stepIndex}/${info.stepTotal}: ${stepLabel}`;
        if (
          info.step === "s3_lock" &&
          info.s3LockLocked !== undefined &&
          info.s3LockTotal !== undefined &&
          info.s3LockTotal > 0
        ) {
          const pct = ((info.s3LockLocked / info.s3LockTotal) * 100).toFixed(1);
          const resumeSuffix = info.s3LockResumed ? " (resumed)" : "";
          return `${head} | Locking S3 objects: ${info.s3LockLocked}/${info.s3LockTotal} (${pct}%)${resumeSuffix}`;
        }
        if (info.step === "s3_lock" && info.s3LockLocked !== undefined) {
          // Total not yet known (rare; first response before server has
          // counted). Show running count without the denominator so the
          // line still advances.
          const resumeSuffix = info.s3LockResumed ? " (resumed)" : "";
          return `${head} | Locking S3 objects: ${info.s3LockLocked}${resumeSuffix}`;
        }
        return head;
      }

      try {
        const result = await approvePublication(
          datasetId,
          !!options.resume,
          !!options.sandbox,
          !!options.skipCiCheck,
          (info) => {
            // Surface transient failures the CLI is about to retry. We pause
            // the spinner so the message isn't overwritten, then resume it.
            spinner.stop();
            const stepLabel = info.step ? info.step.replace(/_/g, " ") : "step";
            console.log(chalk.yellow(`  [!] ${stepLabel} failed: ${info.error}`));
            console.log(
              chalk.dim(
                `  Retrying in ${Math.round(info.delayMs / 1000)}s (attempt ${info.attempt + 1}/${info.maxAttempts})...`,
              ),
            );
            spinner.start(currentSpinnerText);
          },
          (info) => {
            currentSpinnerText = renderProgress(info);
            spinner.text = currentSpinnerText;
          },
          ack,
        );
        spinner.succeed(result.message);

        // Display step-by-step results if available
        if (result.step_results && result.step_results.length > 0) {
          console.log();
          const allSteps = result.step_results;
          const totalSteps = allSteps.length;
          allSteps.forEach((sr: StepResult, idx: number) => {
            const stepNum = `[${String(idx + 1).padStart(2, " ")}/${totalSteps}]`;
            const stepName = sr.step.replace(/_/g, " ");
            if (sr.status === "completed") {
              const durationSec = (sr.duration_ms / 1000).toFixed(1);
              const retryNote = sr.attempts > 1 ? ` (attempt ${sr.attempts})` : "";
              console.log(
                `  ${chalk.green("[x]")} ${chalk.dim(stepNum)} ${stepName} ${chalk.dim(`(${durationSec}s${retryNote})`)}`,
              );
            } else if (sr.status === "failed") {
              console.log(
                `  ${chalk.red("[!]")} ${chalk.dim(stepNum)} ${stepName}${sr.error ? `: ${chalk.red(sr.error)}` : ""}`,
              );
            } else {
              console.log(
                `  ${chalk.dim("[-]")} ${chalk.dim(stepNum)} ${chalk.dim(stepName)} ${chalk.dim("(skipped)")}`,
              );
            }
          });
          console.log();
        } else if (result.steps_completed) {
          // Fallback for responses without step_results
          console.log();
          for (const step of result.steps_completed) {
            console.log(`  ${chalk.green("[x]")} ${step.replace(/_/g, " ")}`);
          }
          console.log();
        }

        // Surface non-fatal orchestrator warnings (e.g. notify_user email
        // failure) so operators know to follow up without re-running.
        if (result.warning) {
          console.log(chalk.yellow(`  Warning: ${result.warning}`));
        }
      } catch (error) {
        handleCommandError(error, spinner, "Failed to approve publication", {
          422: "Fix the CI issues and retry with --resume",
        });

        // After all retries fail, surface the per-attempt step timeline the
        // retry loop attached to the error so the admin sees which step
        // failed when, instead of just the final 500 message.
        const stepResults = (error as { stepResults?: StepResult[] }).stepResults;
        if (stepResults && stepResults.length > 0) {
          console.log();
          console.log(chalk.dim("Step timeline (last attempt):"));
          const totalSteps = stepResults.length;
          stepResults.forEach((sr, idx) => {
            const stepNum = `[${String(idx + 1).padStart(2, " ")}/${totalSteps}]`;
            const stepName = sr.step.replace(/_/g, " ");
            const durationSec = (sr.duration_ms / 1000).toFixed(1);
            const retryNote = sr.attempts > 1 ? ` (attempt ${sr.attempts})` : "";
            if (sr.status === "completed") {
              console.log(
                `  ${chalk.green("[x]")} ${chalk.dim(stepNum)} ${stepName} ${chalk.dim(`(${durationSec}s${retryNote})`)}`,
              );
            } else if (sr.status === "failed") {
              console.log(
                `  ${chalk.red("[!]")} ${chalk.dim(stepNum)} ${stepName}${sr.error ? `: ${chalk.red(sr.error)}` : ""}`,
              );
            } else {
              console.log(
                `  ${chalk.dim("[-]")} ${chalk.dim(stepNum)} ${chalk.dim(stepName)} ${chalk.dim("(skipped)")}`,
              );
            }
          });
          console.log();
        }
      }
    },
  );

adminCommand.addCommand(publishCommand);

// ============================================================================
// Revert (Admin Only)
// ============================================================================

adminCommand
  .command("revert")
  .description("Revert a dataset to a previous version (creates PR for review)")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .argument("[version]", "Target version to revert to (e.g., 1.0.0)")
  .option("--list", "List available versions without reverting")
  .option("--force", "Direct push to main without PR (emergency only)")
  .option("--message <msg>", "Custom revert commit message")
  .option("--dir <path>", "Use existing local clone instead of cloning fresh")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      datasetId,
      targetVersion,
      options: { list?: boolean; force?: boolean; message?: string; dir?: string } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      // Verify prerequisites
      const prereqs = await checkDownloadPrerequisites();
      if (!prereqs.allPassed) {
        console.log(chalk.red("Error: Missing prerequisites"));
        for (const error of prereqs.errors) {
          console.log(chalk.dim(`  - ${error}`));
        }
        return;
      }

      // Determine working directory
      let workDir: string;
      let needsClone = true;

      if (options.dir) {
        if (!existsSync(options.dir)) {
          console.log(chalk.red(`Error: Directory not found: ${options.dir}`));
          return;
        }
        workDir = options.dir;
        needsClone = false;
      } else {
        workDir = join(process.cwd(), `${datasetId}-revert-${Date.now()}`);
      }

      // Get dataset info from API
      const spinner = ora("Fetching dataset info...").start();
      let dataset: Dataset;
      try {
        dataset = await getDataset(datasetId);
        spinner.succeed(`Found dataset: ${dataset.name}`);
      } catch (error) {
        // Echo a plain stdout error after the spinner line (which goes to stderr)
        // so callers grepping stdout can detect the failure reliably. Treat
        // 400 (invalid id format) and 404 alike as "dataset not found" from
        // the user's perspective: both mean we cannot load this dataset.
        if (error instanceof ApiError) {
          spinner.fail(error.message);
          if (error.statusCode === 404 || error.statusCode === 400) {
            console.log(chalk.red(`Error: Dataset ${datasetId} not found`));
            console.log(chalk.dim(`  ${error.message}`));
          } else {
            console.log(chalk.red(`Error: ${error.message}`));
          }
        } else {
          spinner.fail("Failed to fetch dataset");
          const msg = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`Error: Could not load dataset ${datasetId}: ${msg}`));
        }
        return;
      }

      // Check if dataset has GitHub repo
      if (!dataset.github_repo) {
        console.log(chalk.red("Error: Dataset has no GitHub repository"));
        return;
      }

      // Clone if needed
      if (needsClone) {
        const cloneSpinner = ora(`Cloning ${datasetId}...`).start();
        const cloneUrl = `https://github.com/${dataset.github_repo}.git`;
        const cloneResult = await cloneDataset(cloneUrl, workDir);
        if (!cloneResult.success) {
          cloneSpinner.fail(`Clone failed: ${cloneResult.error}`);
          return;
        }
        cloneSpinner.succeed(`Cloned to ${workDir}`);
      }

      // List available versions
      const versions = await listDatasetVersions(workDir);

      if (versions.length === 0) {
        console.log(chalk.yellow("No versions found for this dataset"));
        console.log(chalk.dim("  Dataset may not have any tagged releases yet"));
        return;
      }

      // If --list flag, just show versions and exit
      if (options.list) {
        console.log(`\n${chalk.cyan("Available Versions:")}\n`);
        for (const v of versions) {
          console.log(`  ${chalk.green(v.version)}  ${chalk.dim(v.date)}  ${chalk.dim(v.commit)}`);
        }
        return;
      }

      // If no version specified, prompt for selection
      let selectedVersion = targetVersion;
      if (!selectedVersion) {
        console.log(`\n${chalk.cyan("Available Versions:")}\n`);
        for (const v of versions) {
          console.log(`  ${chalk.green(v.version)}  ${chalk.dim(v.date)}`);
        }
        console.log();

        const { version } = await inquirer.prompt([
          {
            type: "list",
            name: "version",
            message: "Select version to revert to:",
            choices: versions.map((v) => ({
              name: `${v.version} (${v.date})`,
              value: v.version,
            })),
          },
        ]);
        selectedVersion = version;
      }

      // Verify version exists
      const commitHash = await getVersionCommit(workDir, selectedVersion);
      if (!commitHash) {
        console.log(chalk.red(`Error: Version ${selectedVersion} not found`));
        console.log(chalk.dim("  Use --list to see available versions"));
        return;
      }

      // Confirm revert action
      console.log();
      console.log(chalk.yellow("Revert Summary:"));
      console.log(`  Dataset:        ${chalk.cyan(datasetId)}`);
      console.log(`  Target version: ${chalk.green(selectedVersion)}`);
      console.log(`  Commit:         ${chalk.dim(commitHash)}`);
      if (options.force) {
        console.log(`  Mode:           ${chalk.red("DIRECT PUSH (--force)")}`);
      } else {
        console.log(`  Mode:           ${chalk.green("Pull Request")}`);
      }
      console.log();

      if (options.force) {
        console.log(chalk.red("WARNING: --force will push directly to main without PR review!"));
        console.log(chalk.red("This should only be used in emergencies."));
        console.log();
      }

      const confirmMessage = options.force
        ? `Directly push revert to ${selectedVersion}?`
        : `Create PR to revert to ${selectedVersion}?`;
      const confirmResult = await confirm(confirmMessage, options);
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      // Create revert branch
      const branchName = `revert-to-${selectedVersion.replace(/\./g, "-")}-${Date.now()}`;
      const branchSpinner = ora("Creating revert branch...").start();

      const branchResult = await createRevertBranch(workDir, selectedVersion, branchName);
      if (!branchResult.success) {
        branchSpinner.fail(`Failed to create branch: ${branchResult.error}`);
        return;
      }
      branchSpinner.succeed(`Created branch: ${branchName}`);

      // Commit the revert
      const commitSpinner = ora("Committing revert...").start();
      const commitMessage = options.message || `Revert to version ${selectedVersion}`;

      const commitResult = await commitRevert(workDir, selectedVersion, commitMessage);
      if (!commitResult.success) {
        commitSpinner.fail(`Failed to commit: ${commitResult.error}`);
        return;
      }
      commitSpinner.succeed("Committed revert changes");

      // Push branch
      const pushSpinner = ora("Pushing branch...").start();
      const pushResult = await pushBranch(workDir, branchName);
      if (!pushResult.success) {
        pushSpinner.fail(`Failed to push: ${pushResult.error}`);
        return;
      }
      pushSpinner.succeed("Pushed branch to GitHub");

      // Create PR (using gh CLI)
      if (!options.force) {
        const prSpinner = ora("Creating pull request...").start();
        try {
          const { spawn } = await import("node:child_process");
          const prTitle = `Revert to version ${selectedVersion}`;
          const prBody = `## Revert Request\n\nThis PR reverts the dataset to version ${selectedVersion}.\n\n**Reason:** Admin-initiated revert\n**Target version:** ${selectedVersion}\n**Original commit:** ${commitHash}`;

          const pr = spawn(
            "gh",
            [
              "pr",
              "create",
              "--repo",
              dataset.github_repo,
              "--head",
              branchName,
              "--base",
              "main",
              "--title",
              prTitle,
              "--body",
              prBody,
            ],
            { cwd: workDir },
          );

          let prUrl = "";
          pr.stdout.on("data", (data) => {
            prUrl += data.toString();
          });

          await new Promise<void>((resolve, reject) => {
            pr.on("close", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`gh pr create failed with code ${code}`));
            });
          });

          prSpinner.succeed("Created pull request");
          console.log();
          console.log(`  ${chalk.cyan("PR URL:")} ${prUrl.trim()}`);
          console.log();
          console.log(chalk.green("Revert PR created successfully."));
          console.log(
            chalk.dim("The PR will go through validation checks before it can be merged."),
          );
        } catch (_prError) {
          prSpinner.fail("Failed to create PR via gh CLI");
          const errorMsg = _prError instanceof Error ? _prError.message : String(_prError);
          console.error(chalk.red(`  Error: ${errorMsg}`));

          if (errorMsg.includes("not found") || errorMsg.includes("command not found")) {
            console.log(chalk.yellow("  Possible causes:"));
            console.log("    • GitHub CLI (gh) not installed or not in PATH");
            console.log("    • Run: brew install gh  (or see https://cli.github.com)");
          } else if (errorMsg.includes("auth") || errorMsg.includes("401")) {
            console.log(chalk.yellow("  GitHub authentication failed."));
            console.log("    • Run: gh auth login");
          }

          console.log(chalk.dim("  You may need to create the PR manually on GitHub"));
          console.log(chalk.dim(`  Branch: ${branchName}`));
        }
      } else {
        // Force mode: merge directly (emergency only)
        console.log(chalk.yellow("Force mode: Merging directly to main..."));
        // Note: We'd need to checkout main, merge, and push. For safety, just inform user.
        console.log(chalk.red("Direct merge not implemented for safety."));
        console.log(chalk.dim("To force-merge, manually merge the branch on GitHub:"));
        console.log(chalk.dim(`  git checkout main && git merge ${branchName} && git push`));
      }

      // Cleanup info
      if (needsClone) {
        console.log();
        console.log(chalk.dim(`Working directory: ${workDir}`));
        console.log(chalk.dim("You can delete this directory after the PR is merged."));
      }
    },
  );

// ============================================================================
// Make Public (One-Way Publish)
// ============================================================================

adminCommand
  .command("make-public")
  .description("Publish a dataset (make repository and data public) - PERMANENT")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Publish a dataset by making both the GitHub repository and S3 data publicly accessible.

  ${chalk.yellow("WARNING: This operation is PERMANENT and IRREVERSIBLE")}

  Once published:
  - GitHub repository will be publicly visible
  - S3 data files will be publicly downloadable
  - git-annex will use public URLs for downloads

  Publishing cannot be undone because:
  - Data may be cached, indexed, or linked externally
  - Unpublishing would create broken links
  - Aligns with DOI permanence principles

  Use this when:
  - Dataset has been reviewed and validated
  - Ready for public release and citation
  - Associated with a DOI (concept or version)

Requirements:
  - Dataset must not be a sandbox dataset
  - Dataset must have a GitHub repository
  - Admin only; owners request publication via 'nemar dataset publish request'

Examples:
  $ nemar admin make-public nm000104

  This will prompt for confirmation by requiring you to type
  the dataset ID to confirm the permanent action.
`,
  )
  .action(async (datasetIdArg: string) => {
    if (!requireAuth()) return;

    const datasetId = datasetIdArg.trim();

    // Fetch dataset details first
    let dataset: Dataset;
    try {
      dataset = await getDataset(datasetId);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        console.error(chalk.red(`Dataset '${datasetId}' not found`));
      } else {
        console.error(
          chalk.red(
            `Failed to fetch dataset: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      process.exit(1);
    }

    // Show warning and dataset info
    console.log(chalk.yellow("\nWARNING: Publishing is PERMANENT and IRREVERSIBLE\n"));
    console.log("This will:");
    console.log("  1. Make the GitHub repository PUBLIC");
    console.log("  2. Allow public S3 access to all dataset files");
    console.log("  3. Update git-annex configuration for web access\n");
    console.log(`Dataset: ${chalk.cyan(dataset.dataset_id)} - ${dataset.name}`);
    if (dataset.owner_username) {
      console.log(`Owner: ${dataset.owner_username}`);
    }
    if (dataset.github_repo) {
      console.log(`Repository: ${dataset.github_repo}`);
    }
    console.log();

    // Require typing dataset ID to confirm
    const confirmation = await inquirer.prompt([
      {
        type: "input",
        name: "datasetId",
        message: `Type '${datasetId}' to confirm:`,
        validate: (input: string) => {
          if (input.trim() === datasetId) {
            return true;
          }
          return `Please type exactly '${datasetId}' to confirm`;
        },
      },
    ]);

    if (confirmation.datasetId !== datasetId) {
      console.log(chalk.dim("Cancelled."));
      process.exit(0);
    }

    const spinner = ora("Publishing dataset...").start();

    try {
      const result = await publishDataset(datasetId);
      spinner.succeed(chalk.green("Dataset published successfully"));
      console.log(`\nGitHub: ${chalk.cyan(result.github_url)}`);
      console.log(`S3: ${chalk.cyan(result.s3_url)}`);
    } catch (error) {
      spinner.fail(chalk.red("Failed to publish dataset"));
      if (error instanceof ApiError) {
        console.error(chalk.red(`\n${error.message}`));
        if (error.details) {
          console.error(chalk.dim(JSON.stringify(error.details, null, 2)));
        }
        if (error.statusCode === 403) {
          console.log(
            chalk.dim(
              "  Admin only; owners request publication via 'nemar dataset publish request'",
            ),
          );
        } else if (error.statusCode === 400 && error.message.includes("sandbox")) {
          console.log(chalk.dim("  Sandbox datasets cannot be published"));
        }
      } else {
        console.error(chalk.red(`\n${error instanceof Error ? error.message : String(error)}`));
      }
      process.exit(1);
    }
  });

// ============================================================================
// Delete Dataset (Admin/Owner Only)
// ============================================================================

adminCommand
  .command("delete-dataset")
  .description("Delete a dataset and all associated resources (GitHub, S3, D1)")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000108)")
  .option("--force", "Force deletion of published datasets with DOIs (owner only)")
  .action(async (datasetId: string, options: { force?: boolean }) => {
    if (!requireAuth()) return;

    const spinner = ora("Looking up dataset...").start();

    try {
      const dataset = await getDataset(datasetId);
      spinner.stop();

      console.log(chalk.bold(`\nDataset: ${dataset.dataset_id}`));
      console.log(`  Name: ${dataset.name || "(unnamed)"}`);
      console.log(`  Visibility: ${dataset.visibility}`);
      if (dataset.concept_doi) {
        console.log(`  DOI: ${dataset.concept_doi}`);
        console.log(
          chalk.yellow("\n  WARNING: This dataset has a DOI. Only the NEMAR owner can delete it."),
        );
        if (!options.force) {
          console.log(chalk.dim("  Use --force to confirm deletion of published datasets."));
          process.exit(1);
        }
      }

      const { proceed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: chalk.red(
            `Delete dataset ${datasetId}? This will remove the GitHub repo, S3 data, and all database records. This cannot be undone.`,
          ),
          default: false,
        },
      ]);

      if (!proceed) {
        console.log(chalk.dim("Cancelled."));
        return;
      }

      spinner.start("Deleting dataset...");
      const result = await deleteDataset(datasetId, options.force ?? false);
      if (!result.deleted) {
        spinner.fail("Dataset deletion incomplete");
      } else if (result.warnings.length > 0) {
        spinner.warn("Dataset deleted with warnings");
      } else {
        spinner.succeed("Dataset deleted");
      }

      // Summary
      console.log(chalk.bold("\nDeletion summary:"));
      console.log(
        `  GitHub repo: ${result.steps.github.success ? chalk.green("deleted") : chalk.red("failed")}`,
      );
      if (result.steps.s3.skipped) {
        console.log(`  S3 objects: ${chalk.yellow("skipped (published dataset)")}`);
      } else {
        let s3Summary = chalk.green(`${result.steps.s3.deleted} deleted`);
        if (result.steps.s3.failed.length > 0) {
          s3Summary += chalk.red(`, ${result.steps.s3.failed.length} failed`);
        }
        console.log(`  S3 objects: ${s3Summary}`);
      }
      console.log(
        `  Database: ${result.steps.d1.success ? chalk.green("cleaned up") : chalk.red("failed")}`,
      );
      if (result.steps.d1.versionsDeleted > 0) {
        console.log(chalk.dim(`    ${result.steps.d1.versionsDeleted} version records removed`));
      }
      if (result.steps.d1.pubRequestsDeleted > 0) {
        console.log(
          chalk.dim(`    ${result.steps.d1.pubRequestsDeleted} publication requests removed`),
        );
      }

      if (result.warnings.length > 0) {
        console.log(chalk.yellow("\nWarnings:"));
        for (const w of result.warnings) {
          console.log(chalk.yellow(`  - ${w}`));
        }
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to delete dataset", {
        403: "Published datasets can only be deleted by the NEMAR owner",
        404: "Dataset not found",
        409: "Cannot delete dataset with active publication requests",
      });
      process.exit(1);
    }
  });

// ============================================================================
// Bulk Delete
// ============================================================================

adminCommand
  .command("bulk-delete")
  .description("Delete multiple phantom/orphaned datasets at once (owner only)")
  .argument("<dataset-ids>", "Comma-separated dataset IDs (e.g., nm000153,nm000154,nm000155)")
  .option("--yes", "Skip confirmation prompt")
  .action(async (datasetIdsArg: string, options: { yes?: boolean }) => {
    if (!requireAuth()) return;

    const datasetIds = datasetIdsArg
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (datasetIds.length === 0) {
      console.log(chalk.red("No dataset IDs provided."));
      process.exit(1);
    }

    console.log(chalk.bold(`\nBulk delete: ${datasetIds.length} datasets`));
    console.log(
      chalk.dim(
        `  IDs: ${datasetIds.slice(0, 10).join(", ")}${datasetIds.length > 10 ? ` ... +${datasetIds.length - 10} more` : ""}`,
      ),
    );
    console.log(chalk.yellow("\n  Only private datasets without DOIs will be deleted."));

    if (!options.yes) {
      const { proceed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: chalk.red(`Delete ${datasetIds.length} datasets? This cannot be undone.`),
          default: false,
        },
      ]);
      if (!proceed) {
        console.log(chalk.dim("Cancelled."));
        return;
      }
    }

    const spinner = ora(`Deleting ${datasetIds.length} datasets...`).start();

    try {
      const result = await bulkDeleteDatasets(datasetIds);
      spinner.succeed(`Bulk delete complete: ${result.deleted} deleted, ${result.failed} failed`);

      if (result.failed > 0) {
        console.log(chalk.yellow("\nFailed deletions:"));
        for (const r of result.results.filter((r) => !r.deleted)) {
          console.log(chalk.yellow(`  ${r.dataset_id}: ${r.error || "unknown error"}`));
        }
      }
    } catch (error) {
      handleCommandError(error, spinner, "Bulk delete failed", {
        403: "Only the NEMAR owner can bulk-delete datasets",
      });
      process.exit(1);
    }
  });

// ============================================================================
// Dataset withdrawal / restore (epic #967 phase 4, #971)
// ============================================================================

/** Default location of the checked-in withdrawal target list, resolved
 *  relative to this source file rather than cwd (mirrors
 *  defaultExemplarFleetPath below). Shipped to npm (package.json "files"),
 *  same as defaultRecoverDatasetsPath below -- see that function's comment
 *  for why a single hardcoded depth breaks between a source checkout and
 *  the published, single-file dist/index.js bundle (#1049 review). */
function defaultWithdrawnDatasetsPath(): string {
  const fromSourceTree = join(import.meta.dir, "..", "..", "scripts", "withdrawn-datasets.json");
  if (existsSync(fromSourceTree)) return fromSourceTree;
  return join(import.meta.dir, "..", "scripts", "withdrawn-datasets.json");
}

function printTransitionResult(
  tag: string,
  datasetId: string,
  result: DatasetTransitionResponse | undefined,
  error: string | undefined,
): void {
  if (error) {
    console.log(`  ${chalk.red("error".padEnd(8))} ${datasetId}: ${error}`);
    return;
  }
  if (!result) return;
  if ("skipped" in result) {
    console.log(`  ${chalk.yellow("skipped".padEnd(8))} ${datasetId}: ${result.skipped}`);
    return;
  }

  const resumeTag = result.resumed ? chalk.yellow(" (resumed)") : "";
  console.log(chalk.bold(`  ${tag}${datasetId}${resumeTag}`));

  const vColor = result.visibility.status === "failed" ? chalk.red : chalk.green;
  console.log(`    visibility: ${vColor(result.visibility.status)}`);
  if (result.visibility.status === "failed") {
    console.log(chalk.red(`      stage=${result.visibility.stage}: ${result.visibility.error}`));
    if ("githubReverted" in result.visibility) {
      const s3Bit =
        "s3Reverted" in result.visibility ? ` s3Reverted=${result.visibility.s3Reverted}` : "";
      const revertBit = result.visibility.revertError
        ? ` revertError=${result.visibility.revertError}`
        : "";
      console.log(
        chalk.dim(`      githubReverted=${result.visibility.githubReverted}${s3Bit}${revertBit}`),
      );
    }
  }

  for (const d of result.dois) {
    const color =
      d.status === "failed" ? chalk.red : d.status === "planned" ? chalk.yellow : chalk.green;
    const label = d.kind === "version" ? `version ${d.version}` : "concept";
    console.log(`    ${color(d.status.padEnd(8))} ${label} -> ${d.action}  ${chalk.dim(d.doi)}`);
    if (d.error) console.log(chalk.red(`      ${d.error}`));
  }

  if (result.warning) {
    console.log(chalk.yellow(`    warning: ${result.warning}`));
  }
}

adminCommand
  .command("withdraw")
  .description(
    "Withdraw a broken published dataset: make it private and tombstone its EZID DOIs (concept + every version). Dry-run by default.",
  )
  .argument("[ids...]", "Dataset id(s) to withdraw (omit when using --all)")
  .option("--all", "Target the still-withdrawn entries on the checked-in list")
  .option("--reason <reason>", "Withdrawal reason (default: the list entry's own reason)")
  .option("--execute", "Actually apply the withdrawal (default is a dry run)")
  .option("--force", "Allow a dataset id that is not on the checked-in withdrawn-datasets list")
  .option(
    "--withdrawn-file <path>",
    "Path to the withdrawn-datasets JSON (default: scripts/withdrawn-datasets.json)",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--json", "Output raw JSON")
  .action(
    async (
      ids: string[],
      options: {
        all?: boolean;
        reason?: string;
        execute?: boolean;
        force?: boolean;
        withdrawnFile?: string;
        json?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (ids.length === 0 && !options.all) {
        console.log(chalk.red("Error: provide dataset id(s) or use --all"));
        process.exit(1);
      }
      if (ids.length > 0 && options.all) {
        console.log(chalk.red("Error: provide dataset id(s) OR --all, not both"));
        process.exit(1);
      }

      const listPath = options.withdrawnFile || defaultWithdrawnDatasetsPath();
      let entries: WithdrawnDatasetEntry[];
      try {
        entries = loadWithdrawnDatasets(listPath);
      } catch (err) {
        console.error(chalk.red(`Failed to load withdrawn-datasets file: ${errorDetail(err)}`));
        process.exit(1);
      }

      // `--all` acts only on entries still down. A reinstated one keeps its entry
      // as the record of a withdrawal that should not have happened (#1396), and
      // re-targeting it would tombstone a dataset whose content we just proved is
      // there. An explicit id still works, with the existing force guard.
      const resolved = options.all
        ? {
            targets: stillWithdrawn(entries).map((e) => ({
              datasetId: e.dataset_id,
              reason: options.reason || e.reason,
            })),
          }
        : resolveWithdrawTargets(ids, entries, { reason: options.reason, force: options.force });

      if ("error" in resolved) {
        console.error(chalk.red(resolved.error));
        process.exit(1);
      }
      const targets = resolved.targets;

      const dryRun = !options.execute;
      const tag = dryRun ? "[dry-run] " : "";

      if (!dryRun) {
        console.log(
          chalk.red(
            `\nWARNING: this makes ${targets.length} dataset(s) private and tombstones their EZID DOIs (concept + every version).`,
          ),
        );
        const confirmResult = await confirm(
          `Execute withdrawal for ${targets.length} dataset(s)?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      const results: Array<{
        dataset_id: string;
        result?: DatasetTransitionResponse;
        error?: string;
      }> = [];
      for (const t of targets) {
        try {
          const result = await withdrawDataset(t.datasetId, { reason: t.reason, dryRun });
          results.push({ dataset_id: t.datasetId, result });
        } catch (error) {
          results.push({ dataset_id: t.datasetId, error: errorDetail(error) });
        }
      }

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log();
      for (const r of results) {
        printTransitionResult(tag, r.dataset_id, r.result, r.error);
      }
    },
  );

adminCommand
  .command("restore")
  .description(
    "Reverse a withdrawal: make a dataset public again and restore its EZID DOIs (concept + every version). Dry-run by default.",
  )
  .argument("[ids...]", "Dataset id(s) to restore (omit when using --all)")
  .option("--all", "Target the still-withdrawn entries on the checked-in list")
  .option("--execute", "Actually apply the restore (default is a dry run)")
  .option(
    "--withdrawn-file <path>",
    "Path to the withdrawn-datasets JSON (default: scripts/withdrawn-datasets.json)",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--json", "Output raw JSON")
  .action(
    async (
      ids: string[],
      options: {
        all?: boolean;
        execute?: boolean;
        withdrawnFile?: string;
        json?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (ids.length === 0 && !options.all) {
        console.log(chalk.red("Error: provide dataset id(s) or use --all"));
        process.exit(1);
      }
      if (ids.length > 0 && options.all) {
        console.log(chalk.red("Error: provide dataset id(s) OR --all, not both"));
        process.exit(1);
      }

      let targets: string[];
      if (options.all) {
        const listPath = options.withdrawnFile || defaultWithdrawnDatasetsPath();
        try {
          // Restoring an already-restored dataset is a no-op, but listing it as a
          // target reads as though it were still down; the list is the record.
          targets = stillWithdrawn(loadWithdrawnDatasets(listPath)).map((e) => e.dataset_id);
        } catch (err) {
          console.error(chalk.red(`Failed to load withdrawn-datasets file: ${errorDetail(err)}`));
          process.exit(1);
        }
      } else {
        targets = ids;
      }

      const dryRun = !options.execute;
      const tag = dryRun ? "[dry-run] " : "";

      if (!dryRun) {
        console.log(
          chalk.yellow(
            `\nThis makes ${targets.length} dataset(s) public again and restores their EZID DOIs.`,
          ),
        );
        const confirmResult = await confirm(
          `Execute restore for ${targets.length} dataset(s)?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      const results: Array<{
        dataset_id: string;
        result?: DatasetTransitionResponse;
        error?: string;
      }> = [];
      for (const datasetId of targets) {
        try {
          const result = await restoreDataset(datasetId, { dryRun });
          results.push({ dataset_id: datasetId, result });
        } catch (error) {
          results.push({ dataset_id: datasetId, error: errorDetail(error) });
        }
      }

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log();
      for (const r of results) {
        printTransitionResult(tag, r.dataset_id, r.result, r.error);
      }
    },
  );

// ============================================================================
// Import OpenNeuro
// ============================================================================

/**
 * The onboard-openneuro.yml copy phase fans each dataset out into 8 shard
 * jobs, and GitHub caps a workflow's job matrix at 256 entries. Above 32
 * datasets in one dispatch, the matrix silently instantiates 0 copy jobs
 * instead of erroring, so a batch must be split before it reaches that cap.
 * 256 / 8 = 32; this stays a bit under that for headroom.
 */
export const MAX_DATASETS_PER_DISPATCH = 30;

/**
 * Split `ids` into chunks of at most `size`, preserving order. Pure so the
 * batching logic is unit-testable without a live `gh` call.
 */
export function chunkDatasetIds(
  ids: string[],
  size: number = MAX_DATASETS_PER_DISPATCH,
): string[][] {
  if (ids.length === 0) return [];
  if (ids.length <= size) return [ids];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Dispatch the onboard-openneuro.yml workflow (nemarDatasets/.github) for a
 * batch of OpenNeuro `ds######` ids -- the prepare/copy/finalize matrix
 * hardened in epic #967 Phases 1-3. Shared by `import-openneuro`'s default
 * (non---local) branch, a brand-new import, and `recover --execute` (Phase
 * 5, #972), a re-copy of an existing import whose S3 content was found
 * empty; both dispatch the SAME workflow, one gh run per batch.
 *
 * Chunks `dsIds` to stay under the 256-job matrix cap (see
 * MAX_DATASETS_PER_DISPATCH), issuing one `gh workflow run` per chunk. Fails
 * fast on the first chunk that doesn't dispatch, naming which chunk so the
 * operator can resume from there instead of re-running the whole batch.
 */
async function dispatchOpenNeuroImportWorkflow(
  dsIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { runCommand } = await import("../lib/git-annex/run-command.js");
  const chunks = chunkDatasetIds(dsIds);
  if (chunks.length > 1) {
    console.log(
      chalk.dim(
        `  Splitting ${dsIds.length} datasets into ${chunks.length} dispatches (matrix job cap).`,
      ),
    );
  }
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const result = await runCommand([
      "gh",
      "workflow",
      "run",
      "onboard-openneuro.yml",
      "--repo",
      "nemarDatasets/.github",
      "--field",
      `openneuro_ids=${chunk.join(",")}`,
    ]);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `chunk ${i + 1}/${chunks.length} (${chunk.join(",")}): ${result.stderr.trim()}`,
      };
    }
  }
  return { ok: true };
}

adminCommand
  .command("annex-normalize <datasetId>")
  .description(
    "Move data an existing dataset keeps in git into the annex, and put NEMAR's annex policy in force (ADR 0060)",
  )
  .option("--dry-run", "Clone and report what would change; touch nothing")
  .option("--dir <path>", "Working directory for the clone (reuse it to resume without re-cloning)")
  .option("--no-push", "Do everything except push, for a rehearsal")
  .option(
    "--normalize-max-gb <n>",
    "Raise the ceiling on how much data will be uploaded from this host (default 5 GiB)",
  )
  .option(
    "--via-aws-cli",
    "Move the content with `aws s3 sync` rather than git-annex's S3 client, using whatever the aws CLI on this machine is already configured with. Faster for a large migration, and the only option on a host with no NEMAR credentials; the default path mints credentials scoped to this dataset instead.",
  )
  .option("-y, --yes", "Skip the confirmation prompt")
  .addHelpText(
    "after",
    `
What this does (ADR 0060, issue #1159):
  1. clones the dataset (full clone -- data in git has to be present to upload)
  2. annexes every file NEMAR policy calls data that the repo keeps in git, and
     uploads the content to S3 with credentials minted for this dataset
  3. replaces any inherited annex.largefiles attributes with NEMAR's expression
  4. commits both changes and pushes main plus the git-annex branch

It is a FORWARD fix: history is never rewritten, so published version manifests
that address a git-resident file by its raw.githubusercontent URL keep resolving,
and the repository does not shrink. Tags, DOIs, archives and existing S3 objects
are untouched.

Examples:
  $ nemar admin annex-normalize on007788 --dry-run
  $ nemar admin annex-normalize on007788 --dir /tmp/normalize-on007788
`,
  )
  .action(
    async (
      datasetId: string,
      options: {
        dryRun?: boolean;
        dir?: string;
        push?: boolean;
        normalizeMaxGb?: string;
        viaAwsCli?: boolean;
        yes?: boolean;
        no?: boolean;
      },
    ) => {
      if (!requireAuth()) return;

      let maxBytes: number | undefined;
      if (options.normalizeMaxGb !== undefined) {
        const gb = Number(options.normalizeMaxGb);
        if (!Number.isFinite(gb) || gb <= 0) {
          console.error(
            chalk.red(
              `Invalid --normalize-max-gb "${options.normalizeMaxGb}". Expected a positive number of GiB.`,
            ),
          );
          process.exit(1);
        }
        maxBytes = Math.floor(gb * 1024 ** 3);
      }

      const { planDatasetNormalization, normalizeDatasetRepo } = await import(
        "../lib/normalize-dataset.js"
      );

      const planSpinner = ora(`Cloning ${datasetId} and measuring...`).start();
      let plan: Awaited<ReturnType<typeof planDatasetNormalization>>;
      try {
        plan = await planDatasetNormalization(datasetId, { workDir: options.dir });
      } catch (err) {
        planSpinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      planSpinner.succeed(`Cloned ${datasetId} to ${plan.datasetPath}`);

      console.log();
      console.log(chalk.bold(`Plan for ${datasetId}`));
      console.log(
        `  Data files in git: ${chalk.cyan(plan.files.length.toString())} (${chalk.cyan(`${(plan.bytes / 1e6).toFixed(1)} MB`)}) -> annex + S3`,
      );
      for (const f of plan.files.slice(0, 5)) {
        console.log(chalk.dim(`    - ${f.path} (${(f.size / 1e6).toFixed(2)} MB)`));
      }
      if (plan.files.length > 5) {
        console.log(chalk.dim(`    ... and ${plan.files.length - 5} more`));
      }
      console.log(
        `  Inherited largefiles attributes: ${
          plan.attributeFiles.length > 0
            ? chalk.cyan(plan.attributeFiles.join(", "))
            : chalk.dim("none")
        }`,
      );
      console.log(chalk.dim("  History is not rewritten; tags, DOIs and archives are untouched."));
      console.log();

      if (
        plan.files.length === 0 &&
        plan.attributeFiles.length === 0 &&
        (plan.pendingKeys?.length ?? 0) === 0
      ) {
        console.log(chalk.green("Nothing to do: this dataset already matches NEMAR policy."));
        return;
      }
      if (plan.files.length === 0 && (plan.pendingKeys?.length ?? 0) > 0) {
        // A resumed clone (--dir) whose previous attempt committed and stopped. The
        // tree looks normalized because it IS normalized -- locally. Origin still
        // carries the recordings as plain blobs, and the keys were never proved
        // present in S3, which is the only reason the push did not happen.
        console.log(
          chalk.yellow(
            `  Resuming: ${plan.pendingKeys?.length ?? 0} key(s) are committed here and absent from origin. They will be re-verified against S3 before anything is pushed.`,
          ),
        );
      }

      if (options.dryRun) {
        console.log(chalk.dim("--dry-run: stopping before any change."));
        return;
      }

      const confirmResult = await confirm(
        plan.files.length > 0
          ? `Rewrite ${datasetId}'s HEAD and upload ${(plan.bytes / 1e6).toFixed(1)} MB to S3?`
          : `Put NEMAR's annex policy in force on ${datasetId} (no data moves, no S3 traffic)?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(confirmResult === "declined" ? "Declined." : "Cancelled.");
        return;
      }

      const runSpinner = ora("Annexing and uploading...").start();
      let result: Awaited<ReturnType<typeof normalizeDatasetRepo>>;
      try {
        result = await normalizeDatasetRepo(plan, {
          push: options.push !== false,
          maxBytes,
          credentials: options.viaAwsCli ? "ambient" : "backend",
        });
      } catch (err) {
        runSpinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      runSpinner.succeed(result.notes.length > 0 ? result.notes.join("; ") : "nothing changed");

      if (result.committed && !result.pushed) {
        console.log(
          chalk.yellow(
            `  Committed but NOT pushed (--no-push). The clone is at ${plan.datasetPath}.`,
          ),
        );
      } else if (result.pushed) {
        console.log(chalk.green(`  Pushed main and the git-annex branch for ${datasetId}`));
      }

      // Verification is not something the CLI can do on its own: it has to ask with
      // the credentials that moved the bytes, so `normalizeDatasetRepo` owns it and
      // refuses to push without it. Reaching here means it passed.
      if (result.verification) {
        console.log(
          chalk.green(
            `  Remote holds all ${result.verification.present.length} uploaded key(s), checked by ${result.verification.method}`,
          ),
        );
      }
    },
  );

adminCommand
  .command("import-openneuro")
  .description("Import an OpenNeuro dataset into NEMAR")
  .argument("<openneuro-ids>", "OpenNeuro dataset ID(s), comma-separated (e.g., ds007262,ds007263)")
  .option("--local", "Run import locally instead of dispatching GitHub Actions workflow")
  .option("--dir <path>", "Working directory for local clone (requires --local)")
  .option("--skip-data", "Skip S3 data copy, metadata only (requires --local)")
  .option(
    "--trust-upstream",
    "If BIDS validation does not register within the bounded poll, fall back to skip_ci_check=true at approval. OpenNeuro data is pre-validated upstream so this is the recommended setting for OpenNeuro imports (#431).",
  )
  .option(
    "--phase <phase>",
    "Run a single import phase in-process (prepare|copy|finalize) for the sharded CI workflow. State passes between phases via S3 staging. Implies in-process execution.",
  )
  .option(
    "--shard <i/N>",
    "Copy-phase only: process shard i of N (0-indexed), e.g. 0/8. Required with --phase copy.",
  )
  .option(
    "--normalize-max-gb <n>",
    "Raise the ceiling on how much data the prepare phase will move from this host (default 5 GiB): data git holds, and recordings the identifier scrub downloads to rewrite their headers. The import aborts rather than silently spending hours on it (ADR 0060, ADR 0089). Recordings whose only change would be their acquisition date are downloaded only if they all fit, and otherwise keep the date (ADR 0091).",
  )
  .option(
    "--screen-wait-minutes <n>",
    "How long finalize waits for the identifier screen's verdict before leaving the publication for an admin (default: what the finalize job's 90-minute timeout leaves, at most 45; ADR 0089).",
  )
  .action(
    async (
      openneuroIds: string,
      options: {
        local?: boolean;
        dir?: string;
        skipData?: boolean;
        trustUpstream?: boolean;
        phase?: string;
        shard?: string;
        normalizeMaxGb?: string;
        screenWaitMinutes?: string;
      },
    ) => {
      if (!requireAuth()) return;

      const ids = openneuroIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      // Validate all IDs
      for (const id of ids) {
        if (!/^ds\d{6}$/.test(id)) {
          console.error(
            chalk.red(`Invalid OpenNeuro ID "${id}". Expected format: ds###### (e.g., ds007262)`),
          );
          process.exit(1);
        }
      }

      if ((options.dir || options.skipData) && !options.local && !options.phase) {
        console.error(chalk.red("--dir and --skip-data require --local or --phase"));
        process.exit(1);
      }

      let normalizeMaxBytes: number | undefined;
      if (options.normalizeMaxGb !== undefined) {
        const gb = Number(options.normalizeMaxGb);
        if (!Number.isFinite(gb) || gb <= 0) {
          console.error(
            chalk.red(
              `Invalid --normalize-max-gb "${options.normalizeMaxGb}". Expected a positive number of GiB.`,
            ),
          );
          process.exit(1);
        }
        normalizeMaxBytes = Math.floor(gb * 1024 ** 3);
      }

      let screenWaitMs: number | undefined;
      if (options.screenWaitMinutes !== undefined) {
        const minutes = Number(options.screenWaitMinutes);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          console.error(
            chalk.red(
              `Invalid --screen-wait-minutes "${options.screenWaitMinutes}". Expected a positive number of minutes.`,
            ),
          );
          process.exit(1);
        }
        screenWaitMs = Math.floor(minutes * 60_000);
      }

      // Single-phase execution for the sharded CI workflow (prepare/copy/finalize).
      if (options.phase) {
        const validPhases = ["prepare", "copy", "finalize"];
        if (!validPhases.includes(options.phase)) {
          console.error(
            chalk.red(`Invalid --phase "${options.phase}". Expected prepare|copy|finalize.`),
          );
          process.exit(1);
        }
        if (ids.length > 1) {
          console.error(chalk.red("--phase only supports a single dataset ID"));
          process.exit(1);
        }
        if (options.shard && options.phase !== "copy") {
          console.error(chalk.red("--shard is only valid with --phase copy"));
          process.exit(1);
        }
        if (options.phase === "copy" && !options.shard) {
          console.error(chalk.red("--phase copy requires --shard i/N (e.g. --shard 0/8)"));
          process.exit(1);
        }

        const { prepareImport, copyShard, finalizeImport } = await import(
          "../lib/import-openneuro.js"
        );
        const { parseShardArg } = await import("../lib/s3-server-copy.js");
        const opts = {
          workDir: options.dir,
          skipData: options.skipData,
          trustUpstream: options.trustUpstream,
          persistStaging: true,
          normalizeMaxBytes,
          screenWaitMs,
        };
        try {
          if (options.phase === "prepare") {
            await prepareImport(ids[0], opts);
          } else if (options.phase === "copy") {
            // biome-ignore lint/style/noNonNullAssertion: guarded above (copy requires --shard)
            await copyShard(ids[0], parseShardArg(options.shard!), opts);
          } else {
            await finalizeImport(ids[0], opts);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`\n[${options.phase}] failed: ${msg}`));
          process.exit(1);
        }
        return;
      }

      if (options.local) {
        if (ids.length > 1) {
          console.error(chalk.red("--local only supports a single dataset ID"));
          process.exit(1);
        }
        const { importOpenNeuro } = await import("../lib/import-openneuro.js");
        try {
          await importOpenNeuro(ids[0], {
            workDir: options.dir,
            skipData: options.skipData,
            trustUpstream: options.trustUpstream,
            normalizeMaxBytes,
            screenWaitMs,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`\nImport failed: ${msg}`));
          process.exit(1);
        }
        return;
      }

      // Default: dispatch GitHub Actions workflow on nemarDatasets/.github
      const idsStr = ids.join(",");
      console.log(chalk.cyan(`\nDispatching OpenNeuro import workflow for: ${idsStr}\n`));

      const dispatch = await dispatchOpenNeuroImportWorkflow(ids);
      if (!dispatch.ok) {
        console.error(chalk.red(`Failed to dispatch workflow: ${dispatch.error}`));
        console.error(
          chalk.dim("Make sure gh CLI is authenticated with access to nemarDatasets org"),
        );
        process.exit(1);
      }
      console.log(chalk.green("Workflow dispatched successfully"));
      console.log(
        chalk.dim(
          "  Monitor at: https://github.com/nemarDatasets/.github/actions/workflows/onboard-openneuro.yml",
        ),
      );
      console.log(chalk.dim("  Or run: gh run list --repo nemarDatasets/.github --limit 5"));
    },
  );

// ============================================================================
// E2E Test
// ============================================================================

adminCommand
  .command("e2e-test")
  .description("Run end-to-end test against nm099999 (admin only)")
  .option("--verbose", "Show detailed output for each step")
  .option("--skip-reset", "Use existing nm099999 state (skip reset)")
  .option("--skip-cleanup", "Keep temp directories after test")
  .addHelpText(
    "after",
    `
Description:
  Runs a full upload/download/update cycle against the test dataset nm099999.
  Tests the complete git-annex S3 remote workflow with real infrastructure.

Steps:
   1. Reset nm099999          6. Push to GitHub
   2. Prepare upload           7. Clone fresh
   3. Init git + annex         8. Download + verify
   4. Configure remotes        9. Update cycle
   5. Upload to S3            10. Cleanup

Requirements:
  - Admin privileges (API role check)
  - git-annex installed
  - GitHub CLI authenticated (gh auth login)
  - Active nemar auth session

Examples:
  $ nemar admin e2e-test                    # Full test
  $ nemar admin e2e-test --verbose          # With detailed output
  $ nemar admin e2e-test --skip-cleanup     # Keep temp dirs for inspection
  $ nemar admin e2e-test --skip-reset       # Reuse existing nm099999 state`,
  )
  .action(async (options: { verbose?: boolean; skipReset?: boolean; skipCleanup?: boolean }) => {
    if (!requireAuth()) return;

    console.log(chalk.cyan("\nNEMAR E2E Test (nm099999)\n"));

    // Lazy import to avoid loading e2e-test module on every CLI invocation
    const { runE2ETest } = await import("../lib/e2e-test.js");

    const result = await runE2ETest({
      verbose: options.verbose,
      skipReset: options.skipReset,
      skipCleanup: options.skipCleanup,
    });

    // Print results table
    console.log();
    for (const step of result.steps) {
      const icon = step.passed ? chalk.green("[x]") : chalk.red("[ ]");
      const time = chalk.dim(`(${step.duration_ms}ms)`);
      console.log(`  ${icon} ${step.name} ${time}`);
      if (step.error) {
        console.log(chalk.red(`      ${step.error}`));
      }
    }

    console.log();
    const totalSec = (result.total_duration_ms / 1000).toFixed(1);
    if (result.passed) {
      console.log(chalk.green(`All ${result.steps.length} steps passed (${totalSec}s)`));
    } else {
      const failed = result.steps.filter((s) => !s.passed).length;
      console.log(chalk.red(`${failed}/${result.steps.length} steps failed (${totalSec}s)`));
    }

    if (result.upload_dir) {
      console.log(chalk.dim(`\nUpload dir: ${result.upload_dir}`));
      console.log(chalk.dim(`Clone dir:  ${result.clone_dir}`));
    }

    process.exit(result.passed ? 0 : 1);
  });

// ============================================================================
// Import jobs (issue #754)
// ============================================================================

const importCommand = new Command("import").description("View and recover OpenNeuro import jobs");

importCommand
  .command("status")
  .description("Show OpenNeuro import job state (failed/quarantined first)")
  .argument("[dataset-id]", "Filter to one dataset id (e.g., on007523)")
  .option("-s, --status <status>", "Filter by status (failed, quarantined, incomplete, ...)")
  .option("-b, --blocklisted", "Only show retry-engine blocklisted rows")
  .action(
    async (datasetId: string | undefined, options: { status?: string; blocklisted?: boolean }) => {
      if (!requireAuth()) return;

      const spinner = ora("Fetching import status...").start();
      try {
        const result = await getImportStatus(options.status, options.blocklisted);
        spinner.stop();

        let rows = result.imports;
        if (datasetId) rows = rows.filter((r) => r.dataset_id === datasetId);

        const counts = result.by_status;
        console.log(chalk.bold(`\nImport Jobs (${result.total})\n`));
        console.log(
          `  ${chalk.yellow(`in-flight ${(counts.preparing ?? 0) + (counts.copying ?? 0) + (counts.finalizing ?? 0)}`)}  ${chalk.green(`complete ${counts.complete ?? 0}`)}  ${chalk.magenta(`incomplete ${counts.incomplete ?? 0}`)}  ${chalk.red(`failed ${counts.failed ?? 0}`)}  ${chalk.red(`quarantined ${counts.quarantined ?? 0}`)}  ${chalk.dim(`rolled_back ${counts.rolled_back ?? 0}`)}\n`,
        );
        // Withdrawn datasets are counted inside `complete` -- their import did
        // succeed -- so say so rather than letting the total read as datasets
        // that are still fetchable (#1048).
        if (result.withdrawn) {
          console.log(
            `  ${chalk.red(`withdrawn ${result.withdrawn}`)} ${chalk.dim("(included in complete; content removed and DOI tombstoned)")}\n`,
          );
        }

        if (rows.length === 0) {
          console.log(chalk.dim("  No import jobs match."));
          return;
        }

        console.log(
          chalk.dim(
            `  ${"ID".padEnd(12)} ${"Source".padEnd(12)} ${"Stage".padEnd(10)} ${"Status".padEnd(12)} ${"Updated".padEnd(20)}`,
          ),
        );
        console.log(chalk.dim(`  ${"─".repeat(70)}`));
        for (const r of rows) {
          const color =
            r.status === "complete"
              ? chalk.green
              : r.status === "failed" || r.status === "quarantined"
                ? chalk.red
                : r.status === "rolled_back"
                  ? chalk.dim
                  : r.status === "incomplete"
                    ? chalk.magenta
                    : chalk.yellow;
          const updated = r.updated_at ? new Date(r.updated_at).toLocaleString() : "-";
          console.log(
            `  ${r.dataset_id.padEnd(12)} ${(r.source_id || "-").padEnd(12)} ${r.stage.padEnd(10)} ${color(r.status.padEnd(12))} ${updated}`,
          );
          if (r.last_error) console.log(chalk.red(`    ${r.last_error}`));
          if (r.workflow_run_url) console.log(chalk.dim(`    run: ${r.workflow_run_url}`));
          if (r.blocklisted) {
            console.log(
              chalk.magenta(
                `    blocklisted (${r.blocklist_reason ?? "unknown"}); recovery_attempts=${r.recovery_attempts}; next_retry=${r.next_retry_at ?? "-"}${r.maintainer_notified_at ? `; maintainer notified ${r.maintainer_notified_at}` : ""}`,
              ),
            );
          } else if (r.status === "incomplete" || r.status === "failed") {
            console.log(
              chalk.dim(
                `    recovery_attempts=${r.recovery_attempts}; next_retry=${r.next_retry_at ?? "-"}`,
              ),
            );
          }
        }
      } catch (err) {
        spinner.fail("Failed to fetch import status");
        console.error(chalk.red(errorDetail(err)));
      }
    },
  );

importCommand
  .command("rollback")
  .description("Roll back a failed/quarantined import (deletes repo + S3 + D1)")
  .argument("<dataset-id>", "NEMAR dataset id (e.g., on007523)")
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;

    const { proceed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "proceed",
        message: chalk.red(
          `Roll back import ${datasetId}? This deletes the GitHub repo, S3 objects, and D1 records. This cannot be undone.`,
        ),
        default: false,
      },
    ]);
    if (!proceed) {
      console.log(chalk.dim("Cancelled."));
      return;
    }

    const spinner = ora(`Rolling back ${datasetId}...`).start();
    try {
      const result = await rollbackImport(datasetId);
      if (!result.rolled_back) {
        spinner.fail(
          `Rollback incomplete for ${datasetId} (kept quarantined); retry after fixing:`,
        );
        for (const w of result.warnings) console.log(chalk.red(`  - ${w}`));
      } else if (result.warnings.length > 0) {
        spinner.warn(`Rolled back ${datasetId} with warnings`);
        for (const w of result.warnings) console.log(chalk.yellow(`  - ${w}`));
      } else {
        spinner.succeed(`Rolled back ${datasetId}`);
      }
    } catch (err) {
      spinner.fail(`Failed to roll back ${datasetId}`);
      console.error(chalk.red(errorDetail(err)));
    }
  });

importCommand
  .command("retry")
  .description("Reset a failed/quarantined import to 'preparing' for re-dispatch")
  .argument("<dataset-id>", "NEMAR dataset id (e.g., on007523)")
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;

    const spinner = ora(`Resetting ${datasetId}...`).start();
    try {
      await retryImport(datasetId);
      spinner.succeed(
        `${datasetId} reset to 'preparing'. Re-run the onboard-openneuro workflow to retry.`,
      );
    } catch (err) {
      spinner.fail(`Failed to reset ${datasetId}`);
      console.error(chalk.red(errorDetail(err)));
    }
  });

importCommand
  .command("verify")
  .description("Force a per-key S3 integrity check now (seeds the retry lane or confirms health)")
  .argument("<dataset-id>", "NEMAR dataset id (e.g., on007523)")
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;

    const spinner = ora(`Verifying ${datasetId} against S3...`).start();
    try {
      const result = await verifyImport(datasetId);
      if (result.complete) {
        spinner.succeed(
          `${datasetId} verified complete (${result.presentCount}/${result.expectedCount} objects present)`,
        );
      } else if (result.expectedCount === 0) {
        // The backend answers `complete: false` with an empty expected set when
        // there is no published manifest to compare against, which is the right
        // refusal but not an incompleteness: rendering it as "0/0 missing" reads
        // as a verdict on the data when nothing was actually checked (ADR 0054).
        spinner.warn(
          `${datasetId} not verifiable: no published manifest to compare against ` +
            `(${result.presentCount} object(s) in the bucket)`,
        );
      } else {
        spinner.warn(
          `${datasetId} incomplete: ${result.missingKeys.length}/${result.expectedCount} object(s) missing${result.zeroByteKeys.length > 0 ? ` (${result.zeroByteKeys.length} zero-byte)` : ""}`,
        );
        for (const key of result.missingKeys.slice(0, 20)) {
          console.log(chalk.dim(`    ${key}`));
        }
        if (result.missingKeys.length > 20) {
          console.log(chalk.dim(`    ... and ${result.missingKeys.length - 20} more`));
        }
      }
    } catch (err) {
      spinner.fail(`Failed to verify ${datasetId}`);
      console.error(chalk.red(errorDetail(err)));
    }
  });

adminCommand.addCommand(importCommand);

// ============================================================================
// Dataset recovery (epic #967 phase 5, #972)
// ============================================================================

/** Default location of the checked-in recovery target list, resolved
 *  relative to this source file rather than cwd (mirrors
 *  defaultWithdrawnDatasetsPath, which shares this same shape). Shipped
 *  to npm (package.json "files") so `nemar admin recover` works from an
 *  installed build, not just a repo checkout -- the two layouts put this
 *  file at different depths from `import.meta.dir` (#1049):
 *   - source (`bun run src/index.ts`): this code lives at src/commands/, so
 *     the repo-root scripts/ dir is two levels up.
 *   - published (`dist/index.js`, a single-file bundle from `bun build`):
 *     this code lives at dist/, so the package's scripts/ dir is only ONE
 *     level up -- a hardcoded "two levels up" instead resolved to a path
 *     outside the installed package entirely and 404'd on every real run.
 *  Try the source-tree depth first (existsSync), then fall back to the
 *  bundled depth; a repo checkout always has the former, an npm install
 *  always has the latter, and only ever one of the two exists on disk. */
function defaultRecoverDatasetsPath(): string {
  const fromSourceTree = join(import.meta.dir, "..", "..", "scripts", "recover-datasets.json");
  if (existsSync(fromSourceTree)) return fromSourceTree;
  return join(import.meta.dir, "..", "scripts", "recover-datasets.json");
}

const recoverCommand = new Command("recover").description(
  "Re-copy epic #967 OpenNeuro imports published with 0-byte content, whose upstream is accessible (Phase 5, #972). Dry-run by default.",
);

recoverCommand
  .argument("[ids...]", "Dataset id(s) to recover (omit when using --all)")
  .option("--all", "Target every entry in the checked-in recover-datasets list")
  .option("--execute", "Actually verify + dispatch the re-copy (default is a dry run)")
  .option("--force", "Allow a dataset id that is not on the checked-in recover-datasets list")
  .option(
    "--recover-file <path>",
    "Path to the recover-datasets JSON (default: scripts/recover-datasets.json)",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--json", "Output raw JSON")
  .addHelpText(
    "after",
    `
Description:
  Re-dispatches the hardened OpenNeuro copy path (epic #967 Phases 1-3) for
  datasets published with 0-byte content whose OpenNeuro upstream is still
  accessible today. A direct re-dispatch onto a still-'complete' import_jobs
  row silently no-ops the status callback (only a non-terminal row accepts
  an update), so --execute FIRST forces a per-key S3 verify on every target
  (reclassifying a stale 'complete' row to 'incomplete'), THEN dispatches
  ONE batch 'gh workflow run onboard-openneuro.yml' for the whole set.
  Afterward, treat 'nemar admin recover status' (datasets.data_complete) as
  the completion oracle, not import_jobs.status.

  The actual re-copy is production-only IN PRACTICE: outside production the
  target on###### ids have no import_jobs row (dev D1 is exemplars-only), so
  source-id resolution fails loudly before any dispatch. But verifyImport
  itself is NOT environment-gated -- --execute's reclassify step ('complete'
  -> 'incomplete') runs against whatever backend the CLI is pointed at, so
  only ever run --execute against production. A target already
  quarantined/blocklisted by the Phase 2 retry engine is not un-stuck by
  this reclassify (which only flips complete -> incomplete); trust
  datasets.data_complete, not import_jobs.status. Acceptance audit: run
  'nemar admin data-integrity-sweep --reaudit' after the batch lands
  (--older-than 0 does NOT converge here -- its cutoff is relative to an
  ever-advancing now(), so a just-stamped row re-qualifies on the very next
  batch; --reaudit anchors the cutoff once so remaining reaches 0, #980).`,
  )
  .action(
    async (
      ids: string[],
      options: {
        all?: boolean;
        execute?: boolean;
        force?: boolean;
        recoverFile?: string;
        json?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (ids.length === 0 && !options.all) {
        console.log(chalk.red("Error: provide dataset id(s) or use --all"));
        process.exit(1);
      }
      if (ids.length > 0 && options.all) {
        console.log(chalk.red("Error: provide dataset id(s) OR --all, not both"));
        process.exit(1);
      }

      const listPath = options.recoverFile || defaultRecoverDatasetsPath();
      let entries: RecoverDatasetEntry[];
      try {
        entries = loadRecoverDatasets(listPath);
      } catch (err) {
        console.error(chalk.red(`Failed to load recover-datasets file: ${errorDetail(err)}`));
        process.exit(1);
      }

      const resolved = options.all
        ? { targets: entries.map((e) => e.dataset_id) }
        : resolveRecoverTargets(ids, entries, { force: options.force });

      if ("error" in resolved) {
        console.error(chalk.red(resolved.error));
        process.exit(1);
      }
      const targets = resolved.targets;

      if (!options.execute) {
        // JSON first and exclusive: `recover --all --json | jq` must see pure
        // JSON on stdout, nothing else.
        if (options.json) {
          console.log(JSON.stringify({ dry_run: true, targets }, null, 2));
          return;
        }
        console.log(chalk.cyan(`\n[dry-run] Would recover ${targets.length} dataset(s):\n`));
        for (const id of targets) {
          const note = entries.find((e) => e.dataset_id === id)?.note;
          console.log(`  ${id}${note ? chalk.dim(` - ${note}`) : ""}`);
        }
        console.log(
          chalk.dim(
            "\nEach target: POST /admin/imports/:id/verify (reclassify), then one batch " +
              "gh workflow run onboard-openneuro.yml for the whole set. Pass --execute to run.",
          ),
        );
        return;
      }

      // Every human-readable console.log below is gated behind `!options.json`
      // so `recover --execute --json | jq` sees pure JSON on stdout; the JSON
      // result is assembled as the flow proceeds and printed once at the end
      // (it needs the dispatch/verify results, so it can't print up front the
      // way the dry-run branch above does). ora spinners write to stderr by
      // default, so they're left unguarded.
      if (!options.json) {
        console.log(
          chalk.yellow(
            `\nThis verifies (reclassifies) and re-dispatches the OpenNeuro copy for ${targets.length} dataset(s).`,
          ),
        );
      }
      const confirmResult = await confirm(
        `Execute recovery for ${targets.length} dataset(s)?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        if (!options.json) {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        }
        return;
      }

      // Resolve each target's OpenNeuro ds###### source id from import_jobs
      // BEFORE any mutating call, so a target with no row fails loudly up
      // front rather than after some targets have already been reclassified.
      const resolveSpinner = ora("Resolving import sources...").start();
      let sourceByTarget: Map<string, string>;
      let missingSource: string[];
      try {
        const status = await getImportStatus();
        ({ sourceByTarget, missingSource } = resolveImportSources(targets, status.imports));
      } catch (err) {
        resolveSpinner.fail("Failed to fetch import job state");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }
      if (missingSource.length > 0) {
        resolveSpinner.fail("Some targets have no import_jobs source to recover from");
        for (const id of missingSource) {
          console.error(chalk.red(`  ${id}: no import_jobs row (or empty source_id)`));
        }
        process.exit(1);
      }
      resolveSpinner.succeed(`Resolved ${targets.length} OpenNeuro source id(s)`);

      const verifyResults: Array<{ dataset_id: string; ok: boolean; error?: string }> = [];
      for (const id of targets) {
        const verifySpinner = ora(`Verifying ${id}...`).start();
        try {
          const result = await verifyImport(id);
          verifyResults.push({ dataset_id: id, ok: true });
          verifySpinner.succeed(
            `${id} reclassified: ${
              result.complete
                ? "already complete"
                : result.expectedCount === 0
                  ? "not verifiable (no published manifest)"
                  : `incomplete (${result.missingKeys.length}/${result.expectedCount} missing)`
            }`,
          );
        } catch (err) {
          verifyResults.push({ dataset_id: id, ok: false, error: errorDetail(err) });
          verifySpinner.fail(`${id}: verify failed - ${errorDetail(err)}`);
        }
      }

      const verifiedTargets = verifyResults.filter((r) => r.ok).map((r) => r.dataset_id);
      const failedTargets = verifyResults.filter((r) => !r.ok);
      if (verifiedTargets.length === 0) {
        console.error(chalk.red("\nNo targets verified successfully; not dispatching."));
        process.exit(1);
      }

      // biome-ignore lint/style/noNonNullAssertion: sourceByTarget covers every id in verifiedTargets (checked above)
      const dsIds = verifiedTargets.map((id) => sourceByTarget.get(id)!);
      if (!options.json) {
        console.log(
          chalk.cyan(
            `\nDispatching onboard-openneuro.yml for ${dsIds.length} dataset(s): ${dsIds.join(", ")}\n`,
          ),
        );
      }
      const dispatch = await dispatchOpenNeuroImportWorkflow(dsIds);

      // Best-effort: push next_retry_at forward for the just-dispatched
      // targets so the Phase-2 retry cron (sweepImportRetries) doesn't
      // independently re-dispatch the same onboard-openneuro.yml run on its
      // next tick (#981). A failure here is non-corrupting -- worst case the
      // cron redundantly re-dispatches once -- so it must not fail the
      // recovery itself, only warn.
      //
      // Runs BEFORE the dispatch.ok check below, and unconditionally on
      // verifiedTargets (not just the ids of chunks that actually fired):
      // verifyImport already reclassified every one of verifiedTargets to
      // 'incomplete' with next_retry_at=now before we got here, so if a LATER
      // chunk fails after an EARLIER chunk already ran `gh workflow run`, the
      // already-dispatched datasets still need cooling down -- otherwise the
      // cron re-dispatches exactly the datasets this whole mechanism exists to
      // protect (the #981 bug, in the partial-failure case). Cooling down the
      // ids whose dispatch never fired is harmless: the operator resumes the
      // failed chunk manually, and any re-run of `recover` re-verifies first
      // (resetting next_retry_at=now again), so this is overwritten either way.
      let cooldown: { updated: number } | { error: string };
      try {
        cooldown = await dispatchCooldown(verifiedTargets);
        if (!options.json && cooldown.updated < verifiedTargets.length) {
          console.log(
            chalk.dim(
              `  (${verifiedTargets.length - cooldown.updated} of ${verifiedTargets.length} target(s) needed no cooldown: already complete, nothing for the cron to re-dispatch)`,
            ),
          );
        }
      } catch (err) {
        cooldown = { error: errorDetail(err) };
        console.warn(
          chalk.yellow(
            `\nWarning: failed to set dispatch cooldown (${errorDetail(err)}); the retry cron may briefly re-dispatch these datasets (non-corrupting).`,
          ),
        );
      }

      if (!dispatch.ok) {
        console.error(chalk.red(`Failed to dispatch workflow: ${dispatch.error}`));
        console.error(
          chalk.dim("Make sure gh CLI is authenticated with access to nemarDatasets org"),
        );
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.green("Workflow dispatched successfully"));
        console.log(
          chalk.dim(
            "  Monitor at: https://github.com/nemarDatasets/.github/actions/workflows/onboard-openneuro.yml",
          ),
        );
        console.log(chalk.dim("  Or run: gh run list --repo nemarDatasets/.github --limit 5"));
        console.log(
          chalk.dim(
            "  Watch progress with: nemar admin recover status  /  nemar admin data-integrity-sweep --reaudit",
          ),
        );

        if (failedTargets.length > 0) {
          console.log(chalk.yellow(`\n${failedTargets.length} target(s) skipped (verify failed):`));
          for (const f of failedTargets) console.log(chalk.red(`  ${f.dataset_id}: ${f.error}`));
        }
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            { dispatched: verifiedTargets, skipped: failedTargets, dispatch, cooldown },
            null,
            2,
          ),
        );
      }

      // Non-zero exit on partial verify failure so shell scripts can chain
      // safely (mirrors reindex/hed-sweep's convention); the JSON/human
      // output above still prints either way, this only affects the exit
      // code.
      if (failedTargets.length > 0) process.exit(1);
    },
  );

// `status` shares --all/--recover-file/--json with recoverCommand's own
// action above. Commander does not merge parent+child option VALUES when a
// flag of the same name is declared on both (the parent's parseOptions
// consumes it first, regardless of whether it appears before or after
// "status" on the command line -- the child then sees an empty value for
// that key), so the options are redeclared here ONLY for --help visibility
// and read back via optsWithGlobals(), which merges this command's own
// (empty) values with its ancestors' (the parent's real, captured values).
const recoverStatusCommand = recoverCommand
  .command("status")
  .description("Report data_complete/bytes_present progress for recover targets")
  .argument("[ids...]", "Dataset id(s) to check (omit when using --all)")
  .option("--all", "Check every entry in the checked-in recover-datasets list")
  .option(
    "--recover-file <path>",
    "Path to the recover-datasets JSON (default: scripts/recover-datasets.json)",
  )
  .option("--json", "Output raw JSON");

recoverStatusCommand.action(async (ids: string[]) => {
  const options = recoverStatusCommand.optsWithGlobals() as {
    all?: boolean;
    recoverFile?: string;
    json?: boolean;
  };
  if (!requireAuth()) return;

  if (ids.length === 0 && !options.all) {
    console.log(chalk.red("Error: provide dataset id(s) or use --all"));
    process.exit(1);
  }
  if (ids.length > 0 && options.all) {
    console.log(chalk.red("Error: provide dataset id(s) OR --all, not both"));
    process.exit(1);
  }

  const listPath = options.recoverFile || defaultRecoverDatasetsPath();
  let entries: RecoverDatasetEntry[];
  try {
    entries = loadRecoverDatasets(listPath);
  } catch (err) {
    console.error(chalk.red(`Failed to load recover-datasets file: ${errorDetail(err)}`));
    process.exit(1);
  }
  const targets = options.all ? entries.map((e) => e.dataset_id) : ids;

  const results: Array<{
    dataset_id: string;
    data_complete: number | null;
    bytes_present: number | null;
    file_size: number | null;
    error?: string;
  }> = [];
  for (const id of targets) {
    try {
      const dataset = await getDataset(id);
      results.push({
        dataset_id: id,
        data_complete: dataset.data_complete ?? null,
        bytes_present: dataset.bytes_present ?? null,
        file_size: dataset.file_size ?? null,
      });
    } catch (err) {
      results.push({
        dataset_id: id,
        data_complete: null,
        bytes_present: null,
        file_size: null,
        error: errorDetail(err),
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(chalk.bold(`\nRecover status (${results.length})\n`));
  let completeCount = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.dataset_id.padEnd(10)} ${chalk.red(`error: ${r.error}`)}`);
      continue;
    }
    if (r.data_complete === 1) completeCount++;
    const label =
      r.data_complete === 1
        ? chalk.green("complete")
        : r.data_complete === 0
          ? chalk.red("incomplete")
          : chalk.dim("unaudited");
    const bytes =
      r.bytes_present != null && r.file_size != null
        ? ` ${formatBytesCli(r.bytes_present)}/${formatBytesCli(r.file_size)}`
        : "";
    console.log(`  ${r.dataset_id.padEnd(10)} ${label}${bytes}`);
  }
  console.log(chalk.bold(`\n${completeCount}/${results.length} data_complete`));
});

adminCommand.addCommand(recoverCommand);

// ============================================================================
// Exemplar staging fleet (epic #923, Phase 5)
// ============================================================================

const EXEMPLAR_ID_RE = /^xx0999\d{2}$/;
const EXEMPLAR_SOURCE_ID_RE = /^(nm|on)\d{6}$/;

/** Default location of the curated fleet spec, resolved relative to this
 *  source file rather than cwd. Only present in a repo checkout (not
 *  published to npm) — `--all` is a maintainer/CI tool, not an end-user one. */
function defaultExemplarFleetPath(): string {
  return join(import.meta.dir, "..", "..", "scripts", "exemplar-fleet.json");
}

const exemplarCommand = new Command("exemplar").description(
  "Clone public nm/on datasets into staging exemplars (xx099900-xx099999)",
);

exemplarCommand
  .command("create")
  .description("Clone a public NEMAR dataset into a staging exemplar")
  .argument("[xx-id]", "Exemplar dataset id (e.g., xx099900); omit with --all")
  .option("--source <id>", "Source nm/on dataset id to clone (overrides the fleet file)")
  .option("--all", "Clone every entry in the fleet file")
  .option("--fleet-file <path>", "Path to the fleet JSON (default: scripts/exemplar-fleet.json)")
  .option("--publish", "Request and approve publication after data lands (mints a sandbox DOI)")
  .option("--include-derived", "Also copy zarr/, archives/, and records.json derived artifacts")
  .action(
    async (
      xxId: string | undefined,
      options: {
        source?: string;
        all?: boolean;
        fleetFile?: string;
        publish?: boolean;
        includeDerived?: boolean;
      },
    ) => {
      if (!requireAuth()) return;

      const { cloneExemplar, loadExemplarFleet } = await import("../lib/exemplar-clone.js");
      const fleetPath = options.fleetFile || defaultExemplarFleetPath();
      const cloneOpts = { publish: options.publish, includeDerived: options.includeDerived };

      if (options.all) {
        if (xxId || options.source) {
          console.error(chalk.red("--all cannot be combined with an xx-id or --source"));
          process.exit(1);
        }
        let entries: Awaited<ReturnType<typeof loadExemplarFleet>>;
        try {
          entries = loadExemplarFleet(fleetPath);
        } catch (err) {
          console.error(chalk.red(`Failed to load fleet file: ${errorDetail(err)}`));
          process.exit(1);
        }

        let failures = 0;
        for (const entry of entries) {
          if (entry.source_id === "nm000000") {
            console.log(
              chalk.yellow(`Skipping ${entry.xx_id}: placeholder source_id not yet finalized`),
            );
            continue;
          }
          try {
            await cloneExemplar({
              xxId: entry.xx_id,
              sourceId: entry.source_id,
              ...cloneOpts,
            });
          } catch (err) {
            failures++;
            console.error(chalk.red(`${entry.xx_id} failed: ${errorDetail(err)}`));
          }
        }
        if (failures > 0) {
          console.error(chalk.red(`\n${failures} of ${entries.length} fleet entries failed`));
          process.exit(1);
        }
        return;
      }

      if (!xxId) {
        console.error(chalk.red("An xx-id argument is required unless --all is passed"));
        process.exit(1);
      }
      if (!EXEMPLAR_ID_RE.test(xxId)) {
        console.error(chalk.red(`Invalid exemplar id "${xxId}". Expected xx099900-xx099999.`));
        process.exit(1);
      }

      // Loaded unconditionally rather than only when --source is omitted. It
      // used to carry the anonymous designation as well as the source, and
      // that designation is gone (#1433, ADR 0068); loading it either way is
      // kept because a fleet file that fails to parse should be reported the
      // same way whichever flags were passed.
      let fleetEntries: Awaited<ReturnType<typeof loadExemplarFleet>>;
      try {
        fleetEntries = loadExemplarFleet(fleetPath);
      } catch (err) {
        console.error(chalk.red(`Failed to load fleet file: ${errorDetail(err)}`));
        process.exit(1);
      }
      const sourceId = options.source ?? fleetEntries.find((e) => e.xx_id === xxId)?.source_id;
      if (!sourceId) {
        console.error(
          chalk.red(
            `No source dataset for ${xxId}. Pass --source <nm/on id> or add it to the fleet file.`,
          ),
        );
        process.exit(1);
      }
      if (!EXEMPLAR_SOURCE_ID_RE.test(sourceId)) {
        console.error(chalk.red(`Invalid source id "${sourceId}". Expected an nm/on dataset id.`));
        process.exit(1);
      }

      try {
        await cloneExemplar({
          xxId,
          sourceId,
          ...cloneOpts,
        });
      } catch (error) {
        console.error(chalk.red(`\nExemplar clone failed: ${errorDetail(error)}`));
        process.exit(1);
      }
    },
  );

exemplarCommand
  .command("status")
  .description("Show which fleet entries have been cloned and their current state")
  .option("--fleet-file <path>", "Path to the fleet JSON (default: scripts/exemplar-fleet.json)")
  .action(async (options: { fleetFile?: string }) => {
    if (!requireAuth()) return;

    const { loadExemplarFleet } = await import("../lib/exemplar-clone.js");
    const fleetPath = options.fleetFile || defaultExemplarFleetPath();
    let entries: Awaited<ReturnType<typeof loadExemplarFleet>>;
    try {
      entries = loadExemplarFleet(fleetPath);
    } catch (err) {
      console.error(chalk.red(`Failed to load fleet file: ${errorDetail(err)}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nExemplar Fleet (${entries.length})\n`));
    for (const entry of entries) {
      try {
        const dataset = await getDataset(entry.xx_id);
        console.log(
          `  ${entry.xx_id.padEnd(10)} ${entry.modality.padEnd(6)} <- ${entry.source_id.padEnd(10)} ${chalk.green(dataset.visibility)}  doi=${dataset.concept_doi ?? "none"}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          console.log(
            `  ${entry.xx_id.padEnd(10)} ${entry.modality.padEnd(6)} <- ${entry.source_id.padEnd(10)} ${chalk.dim("not created")}`,
          );
        } else {
          console.log(
            `  ${entry.xx_id.padEnd(10)} ${entry.modality.padEnd(6)} <- ${entry.source_id.padEnd(10)} ${chalk.red(`status check failed (${errorDetail(err)})`)}`,
          );
        }
      }
    }
  });

exemplarCommand
  .command("remint-dois")
  .description("Re-mint an exemplar's sandbox concept DOI (idempotent)")
  .argument("<xx-id>", "Exemplar dataset id (e.g., xx099900)")
  .action(async (xxId: string) => {
    if (!requireAuth()) return;

    const spinner = ora(`Re-minting DOIs for ${xxId}...`).start();
    try {
      const result = await remintExemplarDois(xxId);
      spinner.succeed(`Re-minted ${result.concept_doi} (status: ${result.status})`);
      for (const w of result.warnings ?? []) {
        console.log(chalk.yellow(`  ${w}`));
      }
    } catch (err) {
      handleCommandError(err, spinner, "Failed to re-mint exemplar DOIs", {
        400: "Not an exemplar dataset",
        403: "Exemplar DOI re-mint is disabled in production",
        404: "Dataset not found",
      });
      process.exit(1);
    }
  });

adminCommand.addCommand(exemplarCommand);

// ============================================================================
// Reindex (epic #417 phase 3): refresh enrichment +
// Phase 2 metadata columns for one or many datasets.
// ============================================================================

/** The summary lines `nemar admin reindex` prints for one dataset. Pure, so
 *  the wording operators act on (warnings, the lookup cap) is testable. */
export function reindexLines(r: ReindexResponse, opts?: { showRef?: boolean }): string[] {
  const enrLabel = r.enrichment.status;
  const enr =
    enrLabel === "ok"
      ? chalk.green("enrich:ok")
      : enrLabel === "failed"
        ? chalk.red("enrich:failed")
        : chalk.dim("enrich:skipped");
  const syncLabel = r.sync.status;
  const sync =
    syncLabel === "ok"
      ? chalk.green("sync:ok")
      : syncLabel === "failed"
        ? chalk.red("sync:failed")
        : chalk.dim("sync:skipped");
  const cols =
    r.sync.metadata_columns_written === true
      ? chalk.green("cols:written")
      : r.sync.metadata_columns_error
        ? chalk.red("cols:failed")
        : "";
  const ref = opts?.showRef && r.enrichment.ref ? chalk.dim(`@${r.enrichment.ref}`) : "";
  const lines = [`  ${r.dataset_id.padEnd(12)} ${enr}${ref}  ${sync}  ${cols}`];
  if (r.enrichment.error) lines.push(chalk.red(`    enrichment: ${r.enrichment.error}`));
  // Warnings carry the actionable part (e.g. failed DOI lookups: reindex
  // again), so the summary shows them; --json carries them in the body.
  for (const warning of r.enrichment.warnings ?? []) {
    lines.push(chalk.yellow(`    warning: ${warning}`));
  }
  const doi = r.enrichment.doi_resolution;
  if (doi) {
    const counts = `    DOI lookups: ${doi.resolved} resolved, ${doi.unresolved} unresolved, ${doi.failed} failed`;
    if (doi.failed > 0) {
      // A backend from before the lookup warning sends the counts alone, so
      // the cue to reindex again has to come from the count itself.
      const warned = (r.enrichment.warnings ?? []).some((w) => w.startsWith("doi_resolution:"));
      lines.push(chalk.yellow(warned ? counts : `${counts} (reindex this dataset again)`));
    } else {
      lines.push(chalk.dim(counts));
    }
    if (doi.skipped > 0) {
      lines.push(
        chalk.yellow(
          `    ${doi.skipped} DOI(s) past the per-run lookup cap were not looked up; their relation labels were chosen without registry metadata`,
        ),
      );
    }
  }
  if (r.sync.metadata_columns_error) {
    lines.push(chalk.red(`    metadata columns: ${r.sync.metadata_columns_error}`));
  }
  return lines;
}

function printReindexLine(r: ReindexResponse, opts?: { showRef?: boolean }): void {
  for (const line of reindexLines(r, opts)) console.log(line);
}

// ============================================================================
// Fleet governance (epic #713)
// ============================================================================

const fleetCommand = new Command("fleet").description(
  "Governance drift reporting and enforcement (epic #713)",
);

fleetCommand
  .command("drift")
  .description("Report dataset repos that are off the governance spec")
  .option("--prefix <prefix>", "Filter datasets by id prefix (e.g. nm, on)")
  .option("--visibility <vis>", "Filter by visibility: public or private")
  .option("--limit <n>", "Max repos to scan (default 25, max 50)", "25")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      process.exit(1);
    }
    if (options.visibility && !["public", "private"].includes(options.visibility)) {
      console.log(chalk.red("Error: --visibility must be public or private"));
      process.exit(1);
    }
    const spinner = ora("Scanning fleet for drift...").start();
    try {
      const r = await getFleetDrift({
        prefix: options.prefix,
        visibility: options.visibility,
        limit: Number.parseInt(options.limit, 10) || 25,
      });
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`Fleet drift (scanned ${r.scanned}):`));
      const order = [
        "PUBLIC_UNPROTECTED",
        "RED_REQUIRED_CHECK",
        "CONTEXT_NAME_MISMATCH",
        "MISSING_REQUIRED_WORKFLOW",
        "PRIVATE_WITH_STRAY_READ",
        "DEFAULT_BRANCH_OUTLIER",
        "DEPRECATED_WORKFLOW_PRESENT",
        "COMPLIANT",
      ];
      for (const b of order) {
        const ids = r.buckets[b];
        if (!ids || ids.length === 0) continue;
        const color = b === "COMPLIANT" ? chalk.green : chalk.yellow;
        console.log(`  ${color(b.padEnd(28))} ${ids.length}`);
        if (b !== "COMPLIANT") {
          const shown = ids.slice(0, 20).join(", ");
          console.log(
            chalk.dim(`    ${shown}${ids.length > 20 ? ` ... +${ids.length - 20}` : ""}`),
          );
        }
      }
      console.log();
    } catch (error) {
      if (error instanceof ApiError) spinner.fail(error.message);
      else {
        spinner.fail("Failed to scan fleet");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

fleetCommand
  .command("enforce")
  .description("Bring dataset repos to the governance spec (single or --all). Dry-run by default.")
  .argument("[dataset-id]", "Dataset to enforce (omit when using --all)")
  .option("--all", "Bulk enforce across a filtered set (owner-only)")
  .option("--apply", "Actually apply changes (default is a dry run)")
  .option("--prefix <prefix>", "Bulk: filter by id prefix")
  .option("--visibility <vis>", "Bulk: filter by visibility (public|private)")
  .option("--limit <n>", "Bulk: max repos (default 25, max 50)", "25")
  .option("--json", "Output raw JSON")
  .action(async (datasetId, options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      process.exit(1);
    }
    if (!datasetId && !options.all) {
      console.log(chalk.red("Error: provide a dataset-id or use --all"));
      process.exit(1);
    }
    if (datasetId && options.all) {
      console.log(chalk.red("Error: provide a dataset-id OR --all, not both"));
      process.exit(1);
    }
    const dryRun = !options.apply;
    const tag = dryRun ? "[dry-run] " : "";
    const spinner = ora(`${tag}Enforcing spec...`).start();
    try {
      if (datasetId) {
        const r = await enforceDataset(datasetId, dryRun);
        spinner.succeed(`${tag}${datasetId} (${r.result.visibility})`);
        if (options.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        for (const [step, s] of Object.entries(r.result.steps)) {
          const color =
            s.status === "ok" ? chalk.green : s.status === "skipped" ? chalk.yellow : chalk.red;
          console.log(
            `  ${color(s.status.padEnd(8))} ${step}${s.detail ? chalk.dim(` (${s.detail})`) : ""}`,
          );
        }
      } else {
        const r = await enforceBulk({
          prefix: options.prefix,
          visibility: options.visibility,
          limit: Number.parseInt(options.limit, 10) || 25,
          dryRun,
        });
        spinner.succeed(`${tag}processed ${r.count} repo(s)`);
        if (options.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        for (const res of r.results) {
          if (res.error) {
            console.log(`  ${chalk.red("error")}  ${res.dataset_id}: ${res.error}`);
            continue;
          }
          const off = Object.entries(res.steps ?? {})
            .filter(([, s]) => s.status !== "ok")
            .map(([k, s]) => `${k}=${s.status}`);
          const label = off.length ? chalk.yellow("drift") : chalk.green("ok");
          console.log(
            `  ${label}    ${res.dataset_id}${off.length ? chalk.dim(` (${off.join(", ")})`) : ""}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError) spinner.fail(error.message);
      else {
        spinner.fail("Enforcement failed");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the green-gated enforce dry-run until the required BIDS check is green on
 * main HEAD (`branch_ruleset.status === "ok"`) or the timeout elapses. Used by
 * single-dataset revalidate to wait out the in-flight central validation.
 * Returns "green" or "timeout" (timeout == still red or still running).
 */
async function pollEnforceGreen(
  datasetId: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ status: "green" } | { status: "timeout"; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "no probe completed";
  while (Date.now() < deadline) {
    try {
      const br = (await enforceDataset(datasetId, true)).result?.steps?.branch_ruleset;
      if (br?.status === "ok") return { status: "green" };
      if (br?.detail) lastDetail = br.detail; // e.g. RED_REQUIRED_CHECK / FETCH_ERROR
    } catch (e) {
      lastDetail = e instanceof ApiError ? e.message : String(e);
    }
    await sleep(intervalMs);
  }
  return { status: "timeout", detail: lastDetail };
}

fleetCommand
  .command("revalidate")
  .description(
    "Re-run BIDS validation on main HEAD for unprotected datasets, then optionally enforce (epic #713)",
  )
  .argument("[dataset-id]", "Dataset to revalidate (omit when using --all/--prefix)")
  .option("--all", "Revalidate across unprotected public datasets")
  .option("--prefix <prefix>", "Filter by id prefix (with --all), e.g. nm000 / on")
  .option("--enforce", "After a dataset goes green, run enforce (dry-run unless --apply)")
  .option("--apply", "With --enforce, actually apply the ruleset (default is a dry run)")
  .option("--force", "Override the live-dataset guard (nm000103-107)")
  .option("--limit <n>", "Max repos for --all/--prefix (default 25)", "25")
  .option("--json", "Output raw JSON")
  .action(async (datasetId, options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      process.exit(1);
    }
    const isBulk = Boolean(options.all || (!datasetId && options.prefix));
    if (!datasetId && !isBulk) {
      console.log(chalk.red("Error: provide a dataset-id, or --all/--prefix"));
      process.exit(1);
    }

    // Resolve targets.
    let targets: string[];
    if (datasetId) {
      targets = [datasetId];
    } else {
      const spinner = ora("Fetching dataset list...").start();
      try {
        // The /datasets endpoint caps a page at 200, so paginate to cover the
        // whole fleet (a higher nm/on prefix would otherwise be silently missed).
        const all: { dataset_id: string; visibility?: string }[] = [];
        for (let offset = 0; ; offset += 200) {
          const res = await listDatasets({ limit: 200, offset });
          all.push(...res.datasets);
          if (res.datasets.length < 200 || all.length >= res.total_count) break;
        }
        const cap = Number.parseInt(options.limit, 10) || 25;
        targets = selectRevalidateTargets(all, { prefix: options.prefix }).slice(0, cap);
        spinner.succeed(`${targets.length} target(s) (from ${all.length} datasets)`);
      } catch (error) {
        handleCommandError(error, spinner, "Failed to fetch datasets");
        return;
      }
    }

    const doEnforce = Boolean(options.enforce);
    const doApply = Boolean(options.apply);
    const tally = { revalidated: 0, green: 0, locked: 0, stillRed: 0, skipped: 0, errors: 0 };
    const raw: unknown[] = [];

    // Bulk: trigger all first (sequential dispatch is self-pacing), drain, then
    // a single enforce pass — mirrors the manual rollout sweep, far faster than
    // polling each repo for minutes. Single: trigger + poll for the live result.
    const triggered: string[] = [];
    let i = 0;
    for (const id of targets) {
      i++;
      if (CLI_LIVE_DATASETS.has(id) && !options.force) {
        console.log(`  [${i}/${targets.length}] ${chalk.dim(`${id}: skip (live; use --force)`)}`);
        tally.skipped++;
        continue;
      }
      try {
        const rv = await revalidateDataset(id, options.force);
        raw.push(rv);
        if (rv.skipped) {
          console.log(`  [${i}/${targets.length}] ${id}: ${chalk.dim(`skipped (${rv.skipped})`)}`);
          tally.skipped++;
        } else {
          tally.revalidated++;
          triggered.push(id);
          console.log(
            `  [${i}/${targets.length}] ${id}: ${chalk.cyan(`revalidating (${rv.triggered_by})`)}`,
          );
        }
      } catch (error) {
        tally.errors++;
        console.log(
          `  [${i}/${targets.length}] ${id}: ${chalk.red(error instanceof ApiError ? error.message : String(error))}`,
        );
      }
      if (i < targets.length) await sleep(4000); // pace the App dispatch limit
    }

    if (doEnforce && triggered.length > 0) {
      if (datasetId) {
        // Single: poll until green (or 5 min), then optionally lock.
        const id = triggered[0];
        const sp = ora(`Waiting for ${id} validation to land...`).start();
        const g = await pollEnforceGreen(id, 5 * 60_000, 15_000);
        if (g.status !== "green") {
          sp.warn(`${id}: not green within 5m — last: ${g.detail} (real errors or still running)`);
          tally.stillRed++;
        } else {
          tally.green++;
          if (!doApply) {
            sp.succeed(`${id}: green (would lock; pass --apply)`);
          } else {
            const en = await enforceDataset(id, false);
            if (en.result?.steps?.branch_ruleset?.status === "ok") {
              sp.succeed(`${id}: LOCKED`);
              tally.locked++;
            } else {
              sp.warn(`${id}: enforce ${en.result?.steps?.branch_ruleset?.status ?? "?"}`);
            }
          }
        }
      } else {
        // Bulk: drain, then one enforce pass over the triggered set.
        const sp = ora("Waiting ~90s for validations to drain...").start();
        await sleep(90_000);
        sp.text = "Enforcing green datasets...";
        for (const id of triggered) {
          try {
            const probe = await enforceDataset(id, true);
            if (probe.result?.steps?.branch_ruleset?.status !== "ok") {
              tally.stillRed++;
              continue;
            }
            tally.green++;
            if (doApply) {
              const en = await enforceDataset(id, false);
              if (en.result?.steps?.branch_ruleset?.status === "ok") tally.locked++;
            }
          } catch {
            tally.errors++;
          }
        }
        sp.stop();
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ tally, raw }, null, 2));
      return;
    }
    console.log();
    console.log(
      chalk.cyan(
        `Done: revalidated=${tally.revalidated} green=${tally.green} locked=${tally.locked} still-red=${tally.stillRed} skipped=${tally.skipped} errors=${tally.errors}`,
      ),
    );
  });

fleetCommand
  .command("annex-policy")
  .description(
    "Report, and optionally fix, dataset repos that NEMAR's annex policy does not actually govern (#1374, ADR 0060)",
  )
  .argument("[dataset-id...]", "Specific datasets to act on (omit to sweep by prefix)")
  .option("--prefix <prefix>", "Dataset id prefix to sweep (default on: the imported fleet)", "on")
  .option("--limit <n>", "Act on at most this many datasets, in id order")
  .option("--apply", "Make the change (default is a read-only report)")
  .option("--include-data", "Also move data a repo keeps in git, which uploads to S3")
  .option("--via-aws-cli", "With --include-data, move the bytes with this machine's aws CLI")
  .option("--no-push", "With --apply, commit locally and push nothing (a rehearsal)")
  .option("--dir <path>", "Where clones go while they are being fixed (default: a temp dir)")
  .option("--keep-clones", "Do not delete each clone after its dataset is done")
  .option("--concurrency <n>", "Parallel GitHub reads during the scan (default 4)", "4")
  .option("--json <path>", "Write the full report as JSON")
  .option("--force", "Include the live datasets (nm000103-107)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Two things govern what git-annex takes, and an imported dataset has neither (#1374):
upstream's .gitattributes outranks NEMAR's configured expression, and the expression
was never written to the git-annex branch at all. The scan reads both from GitHub
without cloning anything, so a sweep of the fleet costs minutes.

  policy           strip the inherited attributes, configure NEMAR's expression.
                   One commit, no data moves, no S3 traffic.
  policy-and-data  ALSO keeps recordings in git. Skipped unless --include-data:
                   that needs credentials and an upload, which is
                   nemar admin annex-normalize <id> with someone watching.

--apply pushes to main and to the git-annex branch for every dataset it touches,
which starts that repo's BIDS validation. Run it in batches (--limit) rather than
across 600 repositories at once (ADR 0020).

Examples:
  $ nemar admin fleet annex-policy                       # report the imported fleet
  $ nemar admin fleet annex-policy --prefix nm           # report the uploaded fleet
  $ nemar admin fleet annex-policy on001810 --apply      # fix one
  $ nemar admin fleet annex-policy --apply --limit 10    # fix a batch
`,
  )
  .action(
    async (
      datasetIds: string[],
      options: {
        prefix: string;
        limit?: string;
        apply?: boolean;
        includeData?: boolean;
        viaAwsCli?: boolean;
        push?: boolean;
        dir?: string;
        keepClones?: boolean;
        concurrency: string;
        json?: string;
        force?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      const {
        POINTER_SUSPECT_MAX_BYTES,
        applyAnnexPolicyToDataset,
        createGitHubReader,
        labelAnnexPolicyState,
        selectAnnexPolicyTargets,
        sweepAnnexPolicy,
      } = await import("../lib/fleet-annex-policy.js");

      const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
      if (options.limit && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
        console.log(chalk.red(`Error: --limit must be a positive number (got ${options.limit})`));
        process.exit(1);
      }
      const concurrency = Number.parseInt(options.concurrency, 10) || 4;

      let reader: Awaited<ReturnType<typeof createGitHubReader>>;
      try {
        reader = await createGitHubReader();
      } catch (error) {
        console.log(chalk.red(errorDetail(error)));
        process.exit(1);
      }

      // Targets: named datasets, or the fleet by prefix.
      // With --apply the limit bounds the work (below); the scan stays whole, because
      // a bounded scan can never see past the datasets it already fixed. Without
      // --apply it bounds the report, which is what an operator asking for a sample
      // means by it.
      const applyLimit = options.apply ? limit : undefined;
      const scanLimit = options.apply ? undefined : limit;
      let targets: string[];
      if (datasetIds.length > 0) {
        targets = scanLimit === undefined ? datasetIds : datasetIds.slice(0, scanLimit);
      } else {
        const listSpinner = ora("Fetching dataset list...").start();
        try {
          const all: { dataset_id: string }[] = [];
          for (let offset = 0; ; offset += 200) {
            const res = await listDatasets({ limit: 200, offset });
            all.push(...res.datasets);
            if (res.datasets.length < 200 || all.length >= res.total_count) break;
          }
          targets = selectAnnexPolicyTargets(all, {
            prefix: options.prefix,
            exclude: CLI_LIVE_DATASETS,
            force: options.force,
            limit: scanLimit,
          });
          listSpinner.succeed(
            `${targets.length} dataset(s) with prefix ${options.prefix} (of ${all.length})`,
          );
        } catch (error) {
          handleCommandError(error, listSpinner, "Failed to fetch datasets");
          return;
        }
      }
      if (targets.length === 0) {
        console.log(chalk.dim("No datasets matched."));
        return;
      }
      // The live fence has to cover BOTH target sources. `selectAnnexPolicyTargets`
      // drops them from a prefix sweep, where naming them was not the operator's
      // intent; naming one explicitly is, so that refuses out loud rather than
      // silently doing nothing. There is no backend behind this command -- it
      // pushes straight to GitHub -- so this is the only fence there is.
      const live = targets.filter((id) => CLI_LIVE_DATASETS.has(id));
      if (live.length > 0 && !options.force) {
        console.log(
          chalk.red(
            `Refusing to touch live dataset(s): ${live.join(", ")}. These hold real data and are not to be modified during development (AGENTS.md). Pass --force if that is genuinely what you mean.`,
          ),
        );
        process.exit(1);
      }

      // --- The read-only report, which --apply also starts from. -----------------
      const scanSpinner = ora(
        `Reading the annex policy of ${targets.length} dataset(s)...`,
      ).start();
      let scanned = 0;
      let summary: Awaited<ReturnType<typeof sweepAnnexPolicy>>;
      try {
        summary = await sweepAnnexPolicy(targets, reader, {
          concurrency,
          onResult: () => {
            scanned++;
            scanSpinner.text = `Read ${scanned}/${targets.length}...`;
          },
        });
      } catch (error) {
        scanSpinner.fail(errorDetail(error));
        const { FleetSweepAborted } = await import("../lib/fleet-annex-policy.js");
        if (error instanceof FleetSweepAborted) {
          // The sweep stopped because every remaining read would fail the same way.
          // What it had already read is still worth the operator's hour.
          console.log(
            chalk.yellow(
              `  Stopped after reading ${error.partial.scanned} of ${targets.length}. That partial inventory is below${options.json ? " and in the JSON report" : ""}.`,
            ),
          );
          for (const [label, ids] of Object.entries(error.partial.byLabel)) {
            if (ids.length > 0) console.log(`  ${label.padEnd(18)} ${ids.length}`);
          }
          if (options.json) {
            writeFileSync(
              options.json,
              `${JSON.stringify({ summary: error.partial, aborted: error.message }, null, 2)}\n`,
            );
            console.log(chalk.dim(`  Partial report written to ${options.json}`));
          }
        }
        process.exit(1);
      }
      scanSpinner.succeed(`Read ${summary.scanned} of ${targets.length}`);

      const rulesToRemove = summary.states.reduce(
        (sum, s) => sum + s.attributeFiles.reduce((n, f) => n + f.rulesRemoved, 0),
        0,
      );
      const filesToRewrite = summary.states.reduce((sum, s) => sum + s.attributeFiles.length, 0);
      const declined = summary.states.filter((s) =>
        s.attributeFiles.some((f) => f.declined.length > 0),
      );
      // Data-shaped paths too small to be recordings, which the scan subtracts from
      // `gitResidentData` as probable unlocked pointers. The heuristic is right
      // almost always and silent when it is not: `shouldAnnex` annexes a 200-byte
      // .edf at any size, so a genuinely tiny git-resident recording disappears from
      // the report with no trace. Name the count.
      const pointerSuspects = summary.states.reduce((sum, s) => sum + s.pointerSuspects.length, 0);

      console.log();
      console.log(chalk.bold("Annex policy across the fleet"));
      for (const [label, ids] of Object.entries(summary.byLabel)) {
        if (ids.length === 0) continue;
        const color = label === "compliant" ? chalk.green : chalk.yellow;
        console.log(`  ${color(label.padEnd(18))} ${ids.length}`);
        if (label !== "compliant") {
          const shown = ids.slice(0, 12).join(", ");
          console.log(
            chalk.dim(`    ${shown}${ids.length > 12 ? ` ... +${ids.length - 12}` : ""}`),
          );
        }
      }
      console.log(
        `  ${chalk.dim("attributes to rewrite")} ${filesToRewrite} file(s), ${rulesToRemove} rule(s)`,
      );
      if (pointerSuspects > 0) {
        console.log(
          chalk.dim(
            `  ${pointerSuspects} data-shaped path(s) under ${POINTER_SUSPECT_MAX_BYTES} bytes read as unlocked pointers, not data. A genuinely tiny recording would look the same; the clone decides.`,
          ),
        );
      }
      if (summary.truncated.length > 0) {
        console.log(
          chalk.dim(
            `  GitHub truncated ${summary.truncated.length} tree(s) (${summary.truncated.slice(0, 5).join(", ")}): their data counts are a lower bound, and the clone decides.`,
          ),
        );
      }
      if (declined.length > 0) {
        console.log(
          chalk.yellow(
            `  ${declined.length} dataset(s) have a quoted attribute line the strip declines: ${declined.map((s) => s.datasetId).join(", ")}`,
          ),
        );
      }
      if (summary.failed.length > 0) {
        console.log(chalk.red(`  unreadable          ${summary.failed.length}`));
        for (const f of summary.failed.slice(0, 5)) {
          console.log(chalk.dim(`    ${f.datasetId}: ${f.error}`));
        }
      }
      console.log();

      if (options.json) {
        writeFileSync(options.json, `${JSON.stringify({ summary }, null, 2)}\n`);
        console.log(chalk.dim(`  Report written to ${options.json}`));
      }

      if (!options.apply) {
        console.log(chalk.dim("Read-only: nothing was changed. Add --apply to fix a batch."));
        return;
      }

      // --- Applying. -------------------------------------------------------------
      // `--limit` bounds the datasets ACTED ON, not the datasets scanned. Bounding
      // the scan meant every re-run selected the same first N ids, found them all
      // compliant, and reported nothing to do: no number of re-runs ever reached
      // dataset N+1, and the operator had to keep the cursor by hand.
      const allFixable = summary.states
        .filter((s) => {
          const label = labelAnnexPolicyState(s);
          if (label === "compliant") return false;
          if (label === "policy") return true;
          return Boolean(options.includeData);
        })
        .map((s) => s.datasetId);
      const fixable = applyLimit === undefined ? allFixable : allFixable.slice(0, applyLimit);
      if (fixable.length < allFixable.length) {
        console.log(
          chalk.dim(
            `  --limit ${applyLimit}: acting on ${fixable.length} of ${allFixable.length} dataset(s) that need the fix. Re-run to take the next ${applyLimit}.`,
          ),
        );
      }
      const needsDataLeg = summary.states.filter(
        (s) => labelAnnexPolicyState(s) !== "compliant" && !fixable.includes(s.datasetId),
      );
      if (needsDataLeg.length > 0) {
        console.log(
          chalk.dim(
            `  ${needsDataLeg.length} dataset(s) are not in this pass because they keep data in git: ${needsDataLeg.map((s) => s.datasetId).join(", ")}. Each needs the S3 leg (nemar admin annex-normalize <id>, or --include-data here).`,
          ),
        );
      }
      if (fixable.length === 0) {
        console.log(
          chalk.green(
            "Nothing to apply: every dataset read is compliant, or needs the S3 leg (--include-data).",
          ),
        );
        return;
      }

      const pushing = options.push !== false;
      const confirmResult = await confirm(
        `${pushing ? "Push" : "Commit locally, without pushing,"} an annex-policy fix to ${fixable.length} dataset repo(s)${pushing ? ", each starting its BIDS validation" : ""}?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(confirmResult === "declined" ? "Declined." : "Cancelled.");
        return;
      }

      const workRoot = options.dir ?? mkdtempSync(join(tmpdir(), "nemar-fleet-annex-policy-"));
      const tally = { applied: 0, compliant: 0, skipped: 0, failed: 0, unverified: 0 };
      const outcomes: unknown[] = [];
      let index = 0;
      for (const datasetId of fixable) {
        index++;
        const prefix = chalk.dim(`[${index}/${fixable.length}]`);
        // One dataset renamed, deleted or made private between the scan and the
        // apply must not throw away the record of the hundreds already pushed --
        // that record is the only list of which repositories now have a new commit
        // and a running CI job. A fatal read still stops, because every remaining
        // dataset would fail identically.
        let outcome: Awaited<ReturnType<typeof applyAnnexPolicyToDataset>>;
        try {
          outcome = await applyAnnexPolicyToDataset(datasetId, reader, {
            workRoot,
            push: pushing,
            includeData: options.includeData,
            keepClone: options.keepClones,
            credentials: options.viaAwsCli ? "ambient" : "backend",
          });
        } catch (error) {
          const { GitHubReadError } = await import("../lib/fleet-annex-policy.js");
          if (error instanceof GitHubReadError && error.fatal) {
            console.log();
            console.log(
              chalk.red(
                `Stopped at ${datasetId} (${error.message}). ${index - 1} dataset(s) were already acted on; their outcomes follow.`,
              ),
            );
            break;
          }
          outcome = {
            datasetId,
            before: undefined as never,
            action: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        outcomes.push(outcome);
        switch (outcome.action) {
          case "applied":
            tally.applied++;
            console.log(
              `${prefix} ${chalk.green(datasetId)} ${outcome.pushed ? "pushed" : "committed locally"}${outcome.notes?.length ? chalk.dim(` (${outcome.notes.join("; ")})`) : ""}`,
            );
            break;
          case "compliant":
            tally.compliant++;
            console.log(`${prefix} ${chalk.dim(`${datasetId} already compliant`)}`);
            break;
          case "skipped-has-data":
            tally.skipped++;
            console.log(
              `${prefix} ${chalk.yellow(datasetId)} skipped: ${outcome.notes?.join("; ") ?? "keeps data in git"}`,
            );
            break;
          case "unverified":
            tally.unverified++;
            console.log(
              `${prefix} ${chalk.red(datasetId)} pushed, but GitHub still reports drift: ${
                outcome.after?.attributeFiles.map((f) => f.path).join(", ") ||
                "policy not configured"
              }`,
            );
            break;
          case "failed":
            tally.failed++;
            console.log(`${prefix} ${chalk.red(datasetId)} failed: ${outcome.error}`);
            break;
        }
      }

      console.log();
      console.log(
        `Applied ${chalk.green(String(tally.applied))}, already compliant ${tally.compliant}, skipped ${tally.skipped}, unverified ${chalk.red(String(tally.unverified))}, failed ${chalk.red(String(tally.failed))}`,
      );
      if (options.json) {
        writeFileSync(options.json, `${JSON.stringify({ summary, outcomes }, null, 2)}\n`);
        console.log(chalk.dim(`  Report written to ${options.json}`));
      }
      if (options.dir || options.keepClones) {
        console.log(chalk.dim(`  Clones under ${workRoot}`));
      }
      if (tally.failed > 0 || tally.unverified > 0) process.exit(1);
    },
  );

fleetCommand
  .command("key-registration")
  .description(
    "Re-register annexed content NEMAR holds in S3 but never recorded in the location log (#1392)",
  )
  .argument("[dataset-id...]", "Specific datasets to act on (omit to sweep by prefix)")
  .option("--prefix <prefix>", "Dataset id prefix to sweep (default on: the imported fleet)", "on")
  .option("--limit <n>", "Act on at most this many datasets, in id order")
  .option("--apply", "Register and push (default is a read-only report)")
  .option("--no-push", "With --apply, register locally and push nothing (a rehearsal)")
  .option(
    "--include-incomplete",
    "Also act on a dataset whose content the bucket cannot fully account for (#1396). Off by default: that is missing content, not a lost registration",
  )
  // One line, like its neighbours: the reasoning lives in the --help-all text,
  // which is where every other "why would I use this" explanation in this file
  // goes. A four-line option description is what the concise-help work removed.
  .option("--retract-false-claims", "Withdraw presence claims the bucket cannot back")
  .option("--dir <path>", "Where clones go while a dataset is being repaired (default: a temp dir)")
  .option("--concurrency <n>", "Datasets in flight at once (default 4)", "4")
  .option("--json <path>", "Write the full report as JSON")
  .option("--force", "Include the live datasets (nm000103-107)")
  .option("-y, --yes", "Skip confirmation and proceed")
  .addHelpText(
    "after",
    `
What this repairs (#1392):
  \`batchSetKeysPresent\` ran fifty \`setpresentkey\` processes at once and counted
  every exit-0 as a registration. It is fixed, but 528 of 600 imported datasets
  were already published with NEMAR's own copy of their content unadvertised:
  720,896 keys sitting in the bucket that no clone is told about. Those clones
  silently fetch from OpenNeuro instead.

What it will not do:
  A dataset with any annexed key that has NO object in the bucket is reported and
  skipped. That is missing content (#1396) and needs the bytes transferred, not a
  registration written. \`--include-incomplete\` overrides it.

The opposite repair, \`--retract-false-claims\`:
  a key can be recorded at NEMAR's remote with NO object behind it, which is what
  a failed copy leaves (#967): the object is there under the right name at zero
  bytes, every name-only check counts it as content, and the log then tells every
  clone to fetch bytes we do not hold. That is worse than an unregistered key,
  which merely fails to appear. Run this only once recovery has reported those
  keys unrecoverable, because while the content is still recoverable the honest
  repair is to fetch it and the claim becomes true. Used on 230 keys across
  on003574, on004475, on004917, on005571 and on005279, whose anatomical images
  OpenNeuro deleted outright.

  It edits the log and leaves the 0-byte objects in place. They are inert once
  nothing claims them, since presence is tested at the declared size, and a later
  recovery overwrites one; but the dataset still reads as damaged to a size audit
  until they are removed.

What "read-only" does and does not mean:
  without --apply nothing is written to any repository or to S3. It is not free of
  side effects though: establishing what the bucket holds needs credentials, and
  minting them stamps last_activity_at on the dataset, which postpones the stale-
  dataset cleanup cron for a private DOI-less one.

How presence is established:
  one \`list-objects-v2\` per dataset with credentials the API mints for it, not a
  HEAD per key: s3://nemar denies anonymous ListBucket, so a missing key answers
  403 and 403 also means private, expired, or signed without a session token.

Examples:
  $ nemar admin fleet key-registration --prefix on --limit 10
  $ nemar admin fleet key-registration --prefix on --limit 10 --apply
  $ nemar admin fleet key-registration on000246 --apply
  $ nemar admin fleet key-registration on004917 --retract-false-claims --apply
`,
  )
  .action(async (datasetIds: string[], options) => {
    if (!requireAuth()) return;
    const { bucketObjectSource, sweepKeyRegistration } = await import(
      "../lib/fleet-key-registration.js"
    );
    const { CLI_LIVE_DATASETS } = await import("../lib/fleet.js");

    let targets = datasetIds;
    if (targets.length === 0) {
      const spinner = ora("Fetching dataset list...").start();
      try {
        const ids: string[] = [];
        for (let offset = 0; ; offset += 200) {
          const page = await listDatasets({ limit: 200, offset });
          ids.push(...page.datasets.map((d) => d.dataset_id));
          // `?? Infinity`, not `?? ids.length`: an absent total would otherwise end
          // the loop after the first page and silently sweep 200 datasets.
          if (
            page.datasets.length < 200 ||
            ids.length >= (page.total_count ?? Number.POSITIVE_INFINITY)
          )
            break;
        }
        targets = ids.filter((id) => id.startsWith(options.prefix)).sort();
        spinner.succeed(`${targets.length} dataset(s) with prefix ${options.prefix}`);
      } catch (err) {
        spinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
    if (!options.force) {
      targets = targets.filter((id) => !CLI_LIVE_DATASETS.has(id));
    }
    if (options.limit) targets = targets.slice(0, Number(options.limit));
    if (targets.length === 0) {
      console.log(chalk.yellow("No datasets to act on."));
      return;
    }

    if (options.apply && options.push !== false) {
      // A push per repository starts that repository's CI (ADR 0020).
      const answer = await confirm(
        `Register keys and push the git-annex branch for ${targets.length} dataset(s)? That is ${targets.length} push(es), each starting that dataset's CI.`,
        options,
      );
      if (answer !== "confirmed") {
        console.log(chalk.yellow(`${answer}; nothing was changed.`));
        return;
      }
    }

    const workRoot = options.dir ?? mkdtempSync(join(tmpdir(), "nemar-key-registration-"));
    mkdirSync(workRoot, { recursive: true });
    console.log();
    const sweep = await sweepKeyRegistration(targets, bucketObjectSource(), {
      workRoot,
      apply: Boolean(options.apply),
      push: options.push !== false,
      includeIncomplete: Boolean(options.includeIncomplete),
      retractFalseClaims: Boolean(options.retractFalseClaims),
      concurrency: Number(options.concurrency) || 4,
      onDataset: (outcome, done, total) => {
        const label =
          outcome.action === "failed"
            ? chalk.red(outcome.datasetId)
            : outcome.action === "repaired" || outcome.action === "would-repair"
              ? chalk.green(outcome.datasetId)
              : chalk.dim(outcome.datasetId);
        const detail = outcome.error ?? outcome.notes[0] ?? outcome.action;
        console.log(`${chalk.dim(`[${done}/${total}]`)} ${label} ${chalk.dim(detail)}`);
      },
    });

    console.log();
    for (const [action, count] of Object.entries(sweep.tally)) {
      if (count > 0) console.log(`  ${action.padEnd(24)} ${count}`);
    }
    console.log(`  ${"keys registered".padEnd(24)} ${sweep.keysRegistered}`);
    if (options.json) {
      writeFileSync(options.json, JSON.stringify(sweep, null, 2));
      console.log(chalk.dim(`\n  Report written to ${options.json}`));
    }
    if (!options.apply) {
      console.log(chalk.dim("\nRead-only: nothing was changed. Add --apply to repair a batch."));
    }
    if (sweep.tally.failed > 0) process.exitCode = 1;
  });

fleetCommand
  .command("content-recovery")
  .description("Copy back annexed content the bucket never received, and prove each copy (#1396)")
  .argument("[dataset-id...]", "Datasets to act on")
  .option("--apply", "Copy (default is a read-only report)")
  .option("--limit <n>", "Act on at most this many keys per dataset, smallest first")
  .option("--concurrency <n>", "Copies in flight per dataset (default 8)", "8")
  .option("--dir <path>", "Where clones go while a dataset is worked on (default: a temp dir)")
  .option("--json <path>", "Write the full report as JSON")
  .option("--force", "Include the live datasets (nm000103-107)")
  .option("-y, --yes", "Skip confirmation and proceed")
  .addHelpText(
    "after",
    `
What this repairs (#1396):
  imports that finalized with content they never transferred. The bucket has no
  object for those keys, so the key-registration sweep refuses them: there is
  nothing to register. This finds the bytes upstream and copies them in.

Where a copy is allowed to come from:
  a source git-annex itself pinned -- the S3 version id in <key>.log.rmet, which
  is the archive's own record of which bytes are this key's -- or, failing that,
  exactly one distinct upstream object whose size matches the key's. A path alone
  is never enough: upstream rewrites paths, and an import is months old.

  A key that declares zero bytes needs no source at all: there is exactly one
  byte string of length zero, and the key's own hash says whether that is what it
  wants. Those are written directly and reported as origin "empty". A pin is not
  consulted, which matters: on006136's empty key carries four, and all four name
  upstream temp objects holding 2 KB of the dataset README.

How a copy is proven:
  S3 computes the SHA-256 of what it wrote and it is compared to the key's own
  hash before anything else happens. A copy that does not match is DELETED, not
  left in the bucket looking like content. Above CopyObject's 5 GB limit a copy
  is multipart and cannot be checksummed that way, so there an unpinned source is
  refused rather than trusted.

  Before any of that, the source is asked its length and refused if it does not
  match the key's. A pin is an index, not a promise: on004624's names an object
  32 KiB longer than its key. Below 5 GB this only saves a copy the checksum
  would refuse anyway; above it there is no checksum behind it, so it is the
  guard. A source that does not answer is not refused -- not finding out is not
  evidence -- and the copy decides instead.

Credentials:
  the copy is server-side, so no dataset bytes pass through this machine, but it
  needs to read the SOURCE bucket. The API's upload credentials cannot: they are
  scoped to one dataset prefix in s3://nemar. This uses the ambient AWS
  environment (AWS_PROFILE, AWS_ACCESS_KEY_ID, ...) for the copy, and API-minted
  credentials only to list what the bucket already holds.

Registering what it recovers:
  this writes no location log. Run \`nemar admin fleet key-registration <id>
  --apply\` afterwards, which lists the bucket again and records what is there.

Examples:
  $ nemar admin fleet content-recovery on008730
  $ nemar admin fleet content-recovery on008730 --apply
  $ nemar admin fleet content-recovery on008730 on008798 --apply --json report.json
`,
  )
  .action(async (datasetIds: string[], options) => {
    if (!requireAuth()) return;
    const { bucketObjectSource } = await import("../lib/fleet-key-registration.js");
    const { sweepContentRecovery } = await import("../lib/fleet-content-recovery.js");
    const { CLI_LIVE_DATASETS } = await import("../lib/fleet.js");

    const targets = datasetIds;
    if (targets.length === 0) {
      console.log(chalk.yellow("Name the datasets to act on."));
      return;
    }
    const live = targets.filter((id) => CLI_LIVE_DATASETS.has(id));
    if (live.length > 0 && !options.force) {
      console.log(chalk.red(`Refusing to touch live dataset(s): ${live.join(", ")}`));
      console.log(chalk.dim("  --force to override."));
      process.exit(1);
    }

    if (options.apply) {
      const answer = await confirm(
        `Copy missing content into s3://nemar for ${targets.length} dataset(s)?`,
        options,
      );
      if (answer !== "confirmed") {
        console.log(chalk.yellow(`${answer}; nothing was changed.`));
        return;
      }
    }

    // `--limit 0` and `--limit abc` used to mean NO limit: the string "0" is
    // truthy, Number("0") is 0, and 0 is falsy where the slice is taken. With
    // --apply that is the difference between a bounded rehearsal and a full run.
    let limit: number | undefined;
    if (options.limit !== undefined) {
      limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        console.log(chalk.red(`Error: --limit must be a positive integer (got ${options.limit})`));
        process.exit(1);
      }
    }

    const workRoot = options.dir ?? mkdtempSync(join(tmpdir(), "nemar-content-recovery-"));
    mkdirSync(workRoot, { recursive: true });
    console.log();
    const leftInBucket: Array<{ datasetId: string; key: string }> = [];
    const sweep = await sweepContentRecovery(targets, bucketObjectSource(), {
      workRoot,
      apply: Boolean(options.apply),
      limit,
      concurrency: Number(options.concurrency) || 8,
      onDataset: (outcome, done, total) => {
        const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
        const label =
          outcome.action === "failed"
            ? chalk.red(outcome.datasetId)
            : outcome.action === "recovered"
              ? chalk.green(outcome.datasetId)
              : chalk.dim(outcome.datasetId);
        // An object that failed verification and would not delete is the one
        // outcome worse than not copying at all (ADR 0063), so it is collected
        // here and printed again at the end rather than left in a JSON detail.
        for (const key of outcome.keys) {
          if (key.leftInBucket) leftInBucket.push({ datasetId: outcome.datasetId, key: key.key });
        }
        // `failed` was missing from this line entirely, so a dataset where every
        // key failed printed "N missing, 0 recovered, 0 unrecoverable".
        const detail = outcome.error
          ? outcome.error
          : !outcome.measured
            ? "not measured"
            : `${outcome.missing} missing (${gib(outcome.missingBytes)}), ` +
              `${outcome.recovered} recovered (${gib(outcome.recoveredBytes)}), ` +
              `${outcome.unrecoverable} unrecoverable (${gib(outcome.unrecoverableBytes)}), ` +
              `${outcome.failed} failed`;
        console.log(`${chalk.dim(`[${done}/${total}]`)} ${label} ${chalk.dim(detail)}`);
      },
    });

    console.log();
    for (const [action, count] of Object.entries(sweep.tally)) {
      if (count > 0) console.log(`  ${action.padEnd(20)} ${count}`);
    }
    console.log(
      `  ${"keys recovered".padEnd(20)} ${sweep.recoveredKeys} ` +
        `(${(sweep.recoveredBytes / 1024 ** 3).toFixed(1)} GiB)`,
    );
    if (leftInBucket.length > 0) {
      // Loud, and with the command to fix it. These objects carry a real key's
      // name at its declared size, so the next `key-registration --apply` would
      // advertise content that is not the content (ADR 0063).
      console.log(
        chalk.red(
          `\n  ${leftInBucket.length} object(s) FAILED verification and could not be deleted.`,
        ),
      );
      console.log(
        chalk.red("  They will be advertised as real content by the next registration sweep."),
      );
      for (const { datasetId, key } of leftInBucket.slice(0, 20)) {
        console.log(chalk.red(`    ${datasetId}  ${key}`));
      }
      if (leftInBucket.length > 20) {
        console.log(chalk.red(`    ... and ${leftInBucket.length - 20} more (see --json)`));
      }
      console.log(
        chalk.dim("  Remove each with: aws s3api delete-object --bucket nemar --key ..."),
      );
    }
    if (options.json) {
      writeFileSync(options.json, JSON.stringify(sweep, null, 2));
      console.log(chalk.dim(`\n  Report written to ${options.json}`));
    }
    if (!options.apply) {
      console.log(chalk.dim("\nRead-only: nothing was copied. Add --apply to recover."));
    } else if (sweep.recoveredKeys > 0) {
      console.log(
        chalk.dim(
          "\nThe location log still says nothing about these objects: run " +
            "`nemar admin fleet key-registration <id> --apply` to record them.",
        ),
      );
    }
    if (sweep.tally.failed > 0) process.exitCode = 1;
  });

adminCommand.addCommand(fleetCommand);

const reindexCommand = new Command("reindex").description(
  "Refresh dataset metadata: enrichment + first-class D1 columns",
);

reindexCommand
  .argument("[dataset-id]", "Dataset ID to reindex (e.g., nm000103)")
  .option("--all", "Reindex every dataset with a GitHub repo")
  .option("--missing-metadata", "Reindex only datasets with NULL metadata columns")
  .option("--stale", "Reindex only datasets whose metadata is older than --older-than days")
  .option(
    "--older-than <days>",
    "Threshold in days. Default 30 for --stale, 1 (24h) for --missing-metadata recency guard.",
  )
  .option("--skip-enrichment", "Skip the LLM enrichment step")
  .option("--skip-sync", "Skip the D1 metadata-column refresh step")
  .option("--ref <ref>", "Ref to enrich from (single-dataset only; default: main)")
  .option("--dry-run", "List matched datasets without firing the reindex (bulk only)")
  .option("--json", "Print the raw JSON response instead of the summary")
  .action(
    async (
      datasetIdArg: string | undefined,
      options: {
        all?: boolean;
        missingMetadata?: boolean;
        stale?: boolean;
        olderThan?: string;
        skipEnrichment?: boolean;
        skipSync?: boolean;
        ref?: string;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      if (!requireAuth()) return;

      const bulkFlags = [options.all, options.missingMetadata, options.stale].filter(
        Boolean,
      ).length;
      if (datasetIdArg && bulkFlags > 0) {
        console.error(
          chalk.red(
            "Provide either a dataset-id OR a bulk flag (--all/--missing-metadata/--stale), not both",
          ),
        );
        process.exit(1);
      }
      if (!datasetIdArg && bulkFlags === 0) {
        console.error(
          chalk.red("Provide a dataset-id or one of: --all, --missing-metadata, --stale"),
        );
        process.exit(1);
      }
      if (bulkFlags > 1) {
        console.error(chalk.red("Use only one of --all, --missing-metadata, --stale"));
        process.exit(1);
      }
      if (options.skipEnrichment && options.skipSync) {
        console.error(chalk.red("--skip-enrichment and --skip-sync cannot both be set"));
        process.exit(1);
      }

      // Single-dataset path
      if (datasetIdArg) {
        const spinner = ora(`Reindexing ${datasetIdArg}...`).start();
        try {
          const reindexOpts: ReindexOptions = {
            skip_enrichment: options.skipEnrichment === true,
            skip_sync: options.skipSync === true,
            ...(options.ref && { ref: options.ref }),
          };
          const result = await reindexDataset(datasetIdArg, reindexOpts);
          const ok = result.enrichment.status !== "failed" && result.sync.status !== "failed";
          if (options.json) {
            spinner.stop();
            console.log(JSON.stringify(result, null, 2));
            if (!ok) process.exit(1);
            return;
          }
          if (ok) {
            spinner.succeed(`${datasetIdArg} reindexed`);
          } else {
            spinner.warn(`${datasetIdArg} reindexed with errors`);
          }
          console.log();
          printReindexLine(result, { showRef: true });
          if (!ok) process.exit(1);
        } catch (err) {
          spinner.fail(`Failed to reindex ${datasetIdArg}`);
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      // Bulk path
      const filter: ReindexFilter = options.all
        ? "all"
        : options.missingMetadata
          ? "missing-metadata"
          : "stale";
      const bulkOpts: ReindexBulkOptions = {
        skip_enrichment: options.skipEnrichment === true,
        skip_sync: options.skipSync === true,
        dry_run: options.dryRun === true,
      };
      // --older-than default depends on the filter chosen.  Without an
      // explicit value, --stale uses 30 days (the historical default)
      // and --missing-metadata uses 1 day (the 24h recency guard added
      // in #579).  Pinning a Commander-level default would always
      // override the server-side branch defaults and hide the
      // missing-metadata recency guard, so the default is resolved
      // here based on filter.
      if (options.olderThan !== undefined) {
        const parsed = Number.parseInt(options.olderThan, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          console.error(chalk.red(`Invalid --older-than: "${options.olderThan}"`));
          process.exit(1);
        }
        bulkOpts.older_than_days = parsed;
      } else if (filter === "missing-metadata") {
        bulkOpts.older_than_days = 1;
      } else if (filter === "stale") {
        bulkOpts.older_than_days = 30;
      }

      const label = options.dryRun
        ? `Listing ${filter} datasets...`
        : `Reindexing ${filter} datasets...`;
      const spinner = ora(label).start();
      let response: ReindexBulkResponse;
      try {
        response = await reindexBulk(filter, bulkOpts);
      } catch (err) {
        spinner.fail("Bulk reindex failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }

      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify(response, null, 2));
        const anyFailed = (response.results ?? []).some(
          (r) => r.enrichment.status === "failed" || r.sync.status === "failed",
        );
        if (anyFailed) process.exit(1);
        return;
      }

      if (response.dry_run) {
        spinner.succeed(`${response.total} datasets match filter=${filter} (dry run, no changes)`);
        if (response.datasets) {
          for (const id of response.datasets) {
            console.log(chalk.dim(`  - ${id}`));
          }
        }
        return;
      }

      const results = response.results ?? [];
      const okCount = results.filter(
        (r) => r.enrichment.status !== "failed" && r.sync.status !== "failed",
      ).length;
      const failed = results.length - okCount;
      if (failed === 0) {
        spinner.succeed(
          `${results.length}/${results.length} datasets reindexed in ${(response.elapsed_ms / 1000).toFixed(1)}s`,
        );
      } else {
        spinner.warn(
          `${okCount}/${results.length} ok; ${failed} failed in ${(response.elapsed_ms / 1000).toFixed(1)}s`,
        );
      }
      console.log();
      for (const r of results) {
        printReindexLine(r);
      }
      // Non-zero exit on partial bulk failure so shell scripts can chain
      // safely (`nemar admin reindex --missing-metadata && do_next_step`).
      if (failed > 0) process.exit(1);
    },
  );

adminCommand.addCommand(reindexCommand);

const availabilityReportCommand = new Command("availability-report")
  .description(
    "Report how much of a dataset's declared data is present in S3, and exactly which files are missing + why (#1000). Dry-run by default. --all backfills every non-sandbox dataset that has a version and no report yet (#1001).",
  )
  .argument("[dataset-id]", "Dataset ID (e.g., nm000103)")
  .option(
    "--write",
    "Commit the report to .nemar/availability-report.json on main (default: preview only)",
  )
  .option(
    "--all",
    "Backfill every non-sandbox dataset that has a version and no report yet, instead of a single one (#1001)",
  )
  .option(
    "--missing-only",
    "With --all, sweep only datasets already known incomplete (data_complete=0)",
  )
  .option("--limit <n>", "With --all, datasets per batch (server clamps to [1,30])", "10")
  .option("--reset", "With --all, clear every stamped sweep row so it re-sweeps from scratch")
  .option("--verbose", "With --all, print per-batch progress")
  .option("--json", "Output raw JSON")
  .action(
    async (
      datasetId: string | undefined,
      options: {
        write?: boolean;
        all?: boolean;
        missingOnly?: boolean;
        limit?: string;
        reset?: boolean;
        verbose?: boolean;
        json?: boolean;
      },
    ) => {
      if (!requireAuth()) return;

      if (!datasetId && !options.all) {
        console.error(chalk.red("Provide a dataset-id or --all"));
        process.exit(1);
      }
      if (datasetId && (options.all || options.reset || options.missingOnly)) {
        console.error(
          chalk.red("--all/--reset/--missing-only cannot be combined with a dataset id"),
        );
        process.exit(1);
      }

      // Single-dataset path (Phase 1, #1000)
      if (datasetId) {
        const spinner = ora(
          options.write
            ? `Generating and writing availability report for ${datasetId}...`
            : `Previewing availability report for ${datasetId}...`,
        ).start();
        let result: AvailabilityReportResult;
        try {
          result = await availabilityReport(datasetId, { write: options.write === true });
        } catch (err) {
          spinner.fail(`Failed to generate availability report for ${datasetId}`);
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }

        const report: AvailabilityReport = "report" in result ? result.report : result;
        const written = "report" in result;
        spinner.succeed(
          written
            ? `${datasetId}: availability report written to .nemar/availability-report.json`
            : `${datasetId}: availability report (dry run, not written)`,
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log();
        if (report.version === null) {
          console.log(
            chalk.yellow(
              "  No published version manifest to compare against; completeness unknown.",
            ),
          );
        } else {
          console.log(`  Version:   ${report.version}`);
        }
        console.log(`  Complete:  ${report.complete ? chalk.green("yes") : chalk.red("no")}`);
        console.log(
          `  Files:     ${report.completeness.files_present}/${report.completeness.files_declared} present`,
        );
        const bytesLine = `${formatBytesCli(report.completeness.bytes_present)}/${formatBytesCli(report.completeness.bytes_declared)}`;
        const pct =
          report.completeness.pct_bytes != null
            ? ` (${(report.completeness.pct_bytes * 100).toFixed(1)}%)`
            : "";
        console.log(`  Bytes:     ${bytesLine}${pct}`);
        if (report.blocklist_reason) {
          console.log(chalk.yellow(`  Blocklisted: ${report.blocklist_reason}`));
        }
        if (report.missing.length > 0) {
          console.log();
          console.log(chalk.dim(`  Missing (${report.missing.length}):`));
          for (const m of report.missing) {
            console.log(chalk.dim(`    - ${m.path} [${m.reason}]`));
          }
        }
        return;
      }

      // Bulk path (--all, Phase 2, #1001)
      if (options.reset) {
        const spinner = ora("Resetting availability-report sweep state...").start();
        try {
          const r = await availabilityReportSweepReset();
          spinner.succeed(
            `Cleared ${r.reset} stamped row(s); eligible datasets are candidates again`,
          );
          if (options.json) console.log(JSON.stringify(r, null, 2));
        } catch (err) {
          spinner.fail("Reset failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      const limit = Number.parseInt(options.limit ?? "10", 10) || 10;
      const missingOnly = options.missingOnly === true;
      const totals = { processed: 0, written: 0, errors: 0 };
      const spinner = ora("Sweeping datasets for availability reports...").start();

      let batch = 0;
      let remaining: number | null = null;
      let prevRemaining: number | null = null;
      try {
        let res: AvailabilityReportSweepBatchResponse;
        do {
          res = await availabilityReportSweep({ limit, missingOnly });
          batch++;
          totals.processed += res.processed;
          totals.written += res.written;
          totals.errors += res.errors.length;
          remaining = res.remaining;

          if (options.verbose) {
            spinner.stop();
            console.log(
              `  [batch ${batch}] processed=${res.processed} written=${res.written} errors=${res.errors.length} remaining=${remaining ?? "?"}`,
            );
            for (const e of res.errors) console.log(`    ${chalk.red(e.dataset_id)}: ${e.error}`);
            spinner.start("Sweeping datasets for availability reports...");
          } else {
            spinner.text = `Sweeping datasets for availability reports... ${totals.processed} processed, ${remaining ?? "?"} remaining`;
          }

          // Progress guard: availability_report_at is stamped only after a
          // successful write, so a persistently failing batch never advances --
          // bail instead of looping forever.
          if (remaining != null && prevRemaining != null && remaining >= prevRemaining) {
            spinner.warn(`No progress (remaining stuck at ${remaining}); stopping - see errors`);
            break;
          }
          prevRemaining = remaining;

          if ((remaining ?? 0) > 0) await sleep(1000); // pace the GitHub-heavy batches
        } while ((remaining ?? 0) > 0);

        spinner.stop();
      } catch (err) {
        spinner.fail("Availability-report sweep failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...totals, batches: batch, remaining }, null, 2));
      } else {
        console.log();
        if (remaining === null) {
          console.log(
            chalk.yellow(
              "Warning: backend returned a null remaining count; the sweep may be incomplete - check server logs.",
            ),
          );
        }
        console.log(
          chalk.cyan(
            `Done in ${batch} batch(es): processed=${totals.processed} written=${totals.written} errors=${totals.errors} remaining=${remaining ?? "unknown"}`,
          ),
        );
      }
      // Non-zero exit on errors OR an indeterminate (null) remaining, so a caller
      // never reads a partial/uncertain sweep as success.
      if (totals.errors > 0 || remaining === null) process.exit(1);
    },
  );

adminCommand.addCommand(availabilityReportCommand);

/** Batch response shape every `nemar admin *-sweep` command shares (PR
 *  #1223 review, suggestion 5). */
interface SweepBatchLike {
  remaining: number | null;
  errors: { dataset_id: string; error: string }[];
}

/**
 * Shared do-while loop for hed-sweep / recording-stats-sweep /
 * signal-defaults-sweep: calls `runBatch()` until `remaining` reaches 0,
 * paces GitHub-heavy batches, and bails with a warning if `remaining`
 * stops strictly decreasing (persistent write errors leave rows
 * unstamped). `onBatch` owns everything sweep-specific -- totals
 * accumulation and the verbose/spinner text -- so this extraction changes
 * no command's actual output. A `runBatch` throw is caught here exactly
 * as each call site did before: `spinner.fail(failLabel)` + the error
 * detail + `process.exit(1)`.
 */
async function runSweepBatchLoop<R extends SweepBatchLike>(
  spinner: Ora,
  failLabel: string,
  runBatch: () => Promise<R>,
  onBatch: (res: R, batch: number, remaining: number | null) => void,
): Promise<{ batches: number; remaining: number | null }> {
  let batch = 0;
  let remaining: number | null = null;
  let prevRemaining: number | null = null;
  try {
    let res: R;
    do {
      res = await runBatch();
      batch++;
      remaining = res.remaining;
      onBatch(res, batch, remaining);

      if (remaining != null && prevRemaining != null && remaining >= prevRemaining) {
        spinner.warn(`No progress (remaining stuck at ${remaining}); stopping - see errors`);
        break;
      }
      prevRemaining = remaining;

      if ((remaining ?? 0) > 0) await sleep(1000); // pace the GitHub-heavy batches
    } while ((remaining ?? 0) > 0);
    spinner.stop();
  } catch (err) {
    spinner.fail(failLabel);
    console.error(chalk.red(errorDetail(err)));
    process.exit(1);
  }
  return { batches: batch, remaining };
}

const hedSweepCommand = new Command("hed-sweep").description(
  "Backfill HED detection (has_hed / hed_version) for existing datasets (#869)",
);

hedSweepCommand
  .option("--limit <n>", "Datasets per batch (server clamps to [1,30])", "15")
  .option("--reset", "Clear every probed HED row so a corrected detector can re-sweep")
  .option("--verbose", "Print per-batch progress")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (options: { limit?: string; reset?: boolean; verbose?: boolean; json?: boolean }) => {
      if (!requireAuth()) return;

      if (options.reset) {
        const spinner = ora("Resetting HED sweep state...").start();
        try {
          const r = await hedSweepReset();
          spinner.succeed(
            `Cleared ${r.reset} probed HED row(s); eligible datasets are candidates again`,
          );
          if (options.json) console.log(JSON.stringify(r, null, 2));
        } catch (err) {
          spinner.fail("Reset failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      const limit = Number.parseInt(options.limit ?? "15", 10) || 15;
      const totals = { processed: 0, withHed: 0, withoutHed: 0, unknown: 0, errors: 0 };
      const spinner = ora("Sweeping datasets for HED...").start();

      const { batches: batch, remaining } = await runSweepBatchLoop<HedSweepBatchResponse>(
        spinner,
        "HED sweep failed",
        () => hedSweep({ limit }),
        (res, batchNum, rem) => {
          totals.processed += res.processed;
          totals.withHed += res.withHed;
          totals.withoutHed += res.withoutHed;
          totals.unknown += res.unknown;
          totals.errors += res.errors.length;

          if (options.verbose) {
            spinner.stop();
            console.log(
              `  [batch ${batchNum}] processed=${res.processed} hed=${res.withHed} no-hed=${res.withoutHed} unknown=${res.unknown} errors=${res.errors.length} remaining=${rem ?? "?"}`,
            );
            for (const e of res.errors) console.log(`    ${chalk.red(e.dataset_id)}: ${e.error}`);
            spinner.start("Sweeping datasets for HED...");
          } else {
            spinner.text = `Sweeping datasets for HED... ${totals.processed} processed, ${rem ?? "?"} remaining`;
          }
        },
      );

      if (options.json) {
        console.log(JSON.stringify({ ...totals, batches: batch, remaining }, null, 2));
      } else {
        console.log();
        if (remaining === null) {
          console.log(
            chalk.yellow(
              "Warning: backend returned a null remaining count; the sweep may be incomplete - check server logs.",
            ),
          );
        }
        console.log(
          chalk.cyan(
            `Done in ${batch} batch(es): processed=${totals.processed} hed=${totals.withHed} no-hed=${totals.withoutHed} unknown=${totals.unknown} errors=${totals.errors} remaining=${remaining ?? "unknown"}`,
          ),
        );
      }
      // Non-zero exit on errors OR an indeterminate (null) remaining, so a caller
      // never reads a partial/uncertain sweep as success.
      if (totals.errors > 0 || remaining === null) process.exit(1);
    },
  );

adminCommand.addCommand(hedSweepCommand);

const recordingStatsSweepCommand = new Command("recording-stats-sweep").description(
  "Backfill dataset-level recording duration/count/channel-range stats from each dataset's zarr index (migration 0070, #1146)",
);

recordingStatsSweepCommand
  .option("--limit <n>", "Datasets per batch (server clamps to [1,200])", "50")
  .option("--reset", "Clear every stamped recording-stats row so it re-sweeps from scratch")
  .option("--verbose", "Print per-batch progress")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (options: { limit?: string; reset?: boolean; verbose?: boolean; json?: boolean }) => {
      if (!requireAuth()) return;

      if (options.reset) {
        const spinner = ora("Resetting recording-stats sweep state...").start();
        try {
          const r = await recordingStatsSweepReset();
          spinner.succeed(
            `Cleared ${r.reset} stamped recording-stats row(s); eligible datasets are candidates again`,
          );
          if (options.json) console.log(JSON.stringify(r, null, 2));
        } catch (err) {
          spinner.fail("Reset failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      const limit = Number.parseInt(options.limit ?? "50", 10) || 50;
      const totals = { processed: 0, measured: 0, unmeasured: 0, errors: 0 };
      const spinner = ora("Sweeping datasets for recording stats...").start();

      const { batches: batch, remaining } =
        await runSweepBatchLoop<RecordingStatsSweepBatchResponse>(
          spinner,
          "Recording-stats sweep failed",
          () => recordingStatsSweep({ limit }),
          (res, batchNum, rem) => {
            totals.processed += res.processed;
            totals.measured += res.measured;
            totals.unmeasured += res.unmeasured;
            totals.errors += res.errors.length;

            if (options.verbose) {
              spinner.stop();
              console.log(
                `  [batch ${batchNum}] processed=${res.processed} measured=${res.measured} unmeasured=${res.unmeasured} errors=${res.errors.length} remaining=${rem ?? "?"}`,
              );
              for (const e of res.errors) console.log(`    ${chalk.red(e.dataset_id)}: ${e.error}`);
              spinner.start("Sweeping datasets for recording stats...");
            } else {
              spinner.text = `Sweeping datasets for recording stats... ${totals.processed} processed, ${rem ?? "?"} remaining`;
            }
          },
        );

      if (options.json) {
        console.log(JSON.stringify({ ...totals, batches: batch, remaining }, null, 2));
      } else {
        console.log();
        if (remaining === null) {
          console.log(
            chalk.yellow(
              "Warning: backend returned a null remaining count; the sweep may be incomplete - check server logs.",
            ),
          );
        }
        console.log(
          chalk.cyan(
            `Done in ${batch} batch(es): processed=${totals.processed} measured=${totals.measured} unmeasured=${totals.unmeasured} errors=${totals.errors} remaining=${remaining ?? "unknown"}`,
          ),
        );
      }
      // Non-zero exit on errors OR an indeterminate (null) remaining, so a caller
      // never reads a partial/uncertain sweep as success.
      if (totals.errors > 0 || remaining === null) process.exit(1);
    },
  );

adminCommand.addCommand(recordingStatsSweepCommand);

const signalDefaultsSweepCommand = new Command("signal-defaults-sweep").description(
  "Backfill BIDS signal defaults (sampling frequency, power line frequency, EEG reference, placement scheme) from each dataset's exemplar sidecar (migrations 0072/0073, #1153)",
);

signalDefaultsSweepCommand
  .option("--limit <n>", "Datasets per batch (server clamps to [1,30])", "15")
  .option("--reset", "Clear every stamped signal-defaults row so it re-sweeps from scratch")
  .option("--verbose", "Print per-batch progress")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (options: { limit?: string; reset?: boolean; verbose?: boolean; json?: boolean }) => {
      if (!requireAuth()) return;

      if (options.reset) {
        const spinner = ora("Resetting signal-defaults sweep state...").start();
        try {
          const r = await signalDefaultsSweepReset();
          spinner.succeed(
            `Cleared ${r.reset} stamped signal-defaults row(s); eligible datasets are candidates again`,
          );
          if (options.json) console.log(JSON.stringify(r, null, 2));
        } catch (err) {
          spinner.fail("Reset failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      const limit = Number.parseInt(options.limit ?? "15", 10) || 15;
      const totals = { processed: 0, populated: 0, noData: 0, errors: 0 };
      const spinner = ora("Sweeping datasets for signal defaults...").start();

      const { batches: batch, remaining } =
        await runSweepBatchLoop<SignalDefaultsSweepBatchResponse>(
          spinner,
          "Signal-defaults sweep failed",
          () => signalDefaultsSweep({ limit }),
          (res, batchNum, rem) => {
            totals.processed += res.processed;
            totals.populated += res.populated;
            totals.noData += res.noData;
            totals.errors += res.errors.length;

            if (options.verbose) {
              spinner.stop();
              console.log(
                `  [batch ${batchNum}] processed=${res.processed} populated=${res.populated} no-data=${res.noData} errors=${res.errors.length} remaining=${rem ?? "?"}`,
              );
              for (const e of res.errors) console.log(`    ${chalk.red(e.dataset_id)}: ${e.error}`);
              spinner.start("Sweeping datasets for signal defaults...");
            } else {
              spinner.text = `Sweeping datasets for signal defaults... ${totals.processed} processed, ${rem ?? "?"} remaining`;
            }
          },
        );

      if (options.json) {
        console.log(JSON.stringify({ ...totals, batches: batch, remaining }, null, 2));
      } else {
        console.log();
        if (remaining === null) {
          console.log(
            chalk.yellow(
              "Warning: backend returned a null remaining count; the sweep may be incomplete - check server logs.",
            ),
          );
        }
        console.log(
          chalk.cyan(
            `Done in ${batch} batch(es): processed=${totals.processed} populated=${totals.populated} no-data=${totals.noData} errors=${totals.errors} remaining=${remaining ?? "unknown"}`,
          ),
        );
      }
      // Non-zero exit on errors OR an indeterminate (null) remaining, so a caller
      // never reads a partial/uncertain sweep as success.
      if (totals.errors > 0 || remaining === null) process.exit(1);
    },
  );

adminCommand.addCommand(signalDefaultsSweepCommand);

/** One data-integrity-sweep batch, as consumed by {@link runReauditLoop}. */
export interface ReauditBatchResult {
  processed: number;
  complete: number;
  incomplete: number;
  unknown: number;
  errors: { dataset_id: string; error: string }[];
  remaining: number | null;
}

export interface ReauditLoopResult {
  batches: number;
  totals: {
    processed: number;
    complete: number;
    incomplete: number;
    unknown: number;
    errors: number;
  };
  remaining: number | null;
  /** Hit the no-progress guard (remaining didn't strictly decrease) and stopped early. */
  stalled: boolean;
}

/**
 * Pure convergence loop driving `nemar admin data-integrity-sweep --reaudit`
 * (#980 review fix). `getBefore()` is called EXACTLY ONCE, before the first
 * `fetchBatch` call, and that single captured value is threaded UNCHANGED
 * into every subsequent `fetchBatch(before)` call -- this is the convergence
 * property itself (an anchored cutoff, not a moving `now()`-relative one; see
 * the `?before=` doc comment on the sweep endpoint in datasets-lifecycle.ts).
 *
 * No Date/network dependency of its own, so both the anchoring property (one
 * capture, reused every call) and the termination property (stop at
 * remaining=0, or on a stalled/non-decreasing `remaining`) are directly
 * unit-testable with a plain callback -- a future regression that re-derives
 * `before` inside the loop (the exact "moving cutoff never converges" bug
 * this whole flag exists to fix) would surface as differing `before` values
 * across `fetchBatch` calls in the test, not just as a slow production
 * incident that's hard to reproduce.
 *
 * `onBatch`/`sleepBetweenBatches` are optional hooks for the CLI's own
 * per-batch UI (spinner text, verbose printing, pacing sleep) -- kept out of
 * the aggregation/termination logic itself so a test can omit them entirely.
 */
export async function runReauditLoop(
  getBefore: () => string | undefined,
  fetchBatch: (before: string | undefined) => Promise<ReauditBatchResult>,
  hooks?: {
    onBatch?: (
      res: ReauditBatchResult,
      totals: ReauditLoopResult["totals"],
      batchNumber: number,
    ) => void;
    sleepBetweenBatches?: () => Promise<void>;
  },
): Promise<ReauditLoopResult> {
  const before = getBefore();
  const totals = { processed: 0, complete: 0, incomplete: 0, unknown: 0, errors: 0 };
  let batches = 0;
  let remaining: number | null = null;
  let prevRemaining: number | null = null;
  let stalled = false;

  do {
    const res = await fetchBatch(before);
    batches++;
    totals.processed += res.processed;
    totals.complete += res.complete;
    totals.incomplete += res.incomplete;
    totals.unknown += res.unknown;
    totals.errors += res.errors.length;
    remaining = res.remaining;
    hooks?.onBatch?.(res, totals, batches);

    // Progress guard: data_checked_at is stamped for every processed row, so
    // `remaining` must strictly decrease. If it doesn't (e.g. persistent D1
    // write errors leave rows unstamped), stop instead of looping forever.
    if (remaining != null && prevRemaining != null && remaining >= prevRemaining) {
      stalled = true;
      break;
    }
    prevRemaining = remaining;

    if ((remaining ?? 0) > 0) await hooks?.sleepBetweenBatches?.();
  } while ((remaining ?? 0) > 0);

  return { batches, totals, remaining, stalled };
}

const dataIntegritySweepCommand = new Command("data-integrity-sweep").description(
  "Audit datasets against their version manifest and backfill data_complete / bytes_present (epic #967 Phase 3, #970)",
);

dataIntegritySweepCommand
  .option("--limit <n>", "Datasets per batch (server clamps to [1,30])", "15")
  .option(
    "--older-than <days>",
    "Also re-audit rows checked more than N days ago (periodic re-audit, not just the one-shot drain)",
  )
  .option(
    "--reaudit",
    "Re-verify every already-checked row using an anchored cutoff so the sweep fully converges to 0 (unlike --older-than's moving now()-relative window, which never reaches 0 on its own)",
  )
  .option("--reset", "Clear every audited row so a corrected verifier can re-sweep")
  .option("--verbose", "Print per-batch progress")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (options: {
      limit?: string;
      olderThan?: string;
      reaudit?: boolean;
      reset?: boolean;
      verbose?: boolean;
      json?: boolean;
    }) => {
      if (!requireAuth()) return;

      if (options.reset) {
        const spinner = ora("Resetting data-integrity sweep state...").start();
        try {
          const r = await dataIntegritySweepReset();
          spinner.succeed(
            `Cleared ${r.reset} audited row(s); eligible datasets are candidates again`,
          );
          if (options.json) console.log(JSON.stringify(r, null, 2));
        } catch (err) {
          spinner.fail("Reset failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      const limit = Number.parseInt(options.limit ?? "15", 10) || 15;
      const olderThan = options.olderThan ? Number.parseInt(options.olderThan, 10) : undefined;
      const spinner = ora("Sweeping datasets for data integrity...").start();

      let loopResult: ReauditLoopResult | undefined;
      try {
        loopResult = await runReauditLoop(
          // Captured ONCE by runReauditLoop, before the first fetchBatch call --
          // every call in this run passes the SAME anchor, so a row re-checked
          // mid-run is stamped with a data_checked_at strictly AFTER `before`
          // and never re-qualifies -- `remaining` strictly decreases to 0.
          () => (options.reaudit ? new Date().toISOString() : undefined),
          async (before) => {
            const res = await dataIntegritySweep({ limit, olderThan, before });
            return {
              processed: res.processed,
              complete: res.complete,
              incomplete: res.incomplete,
              unknown: res.unknown,
              errors: res.errors,
              remaining: res.remaining,
            };
          },
          {
            onBatch: (res, totals, batchNumber) => {
              if (options.verbose) {
                spinner.stop();
                console.log(
                  `  [batch ${batchNumber}] processed=${res.processed} complete=${res.complete} incomplete=${res.incomplete} unknown=${res.unknown} errors=${res.errors.length} remaining=${res.remaining ?? "?"}`,
                );
                for (const e of res.errors)
                  console.log(`    ${chalk.red(e.dataset_id)}: ${e.error}`);
                spinner.start("Sweeping datasets for data integrity...");
              } else {
                spinner.text = `Sweeping datasets for data integrity... ${totals.processed} processed, ${res.remaining ?? "?"} remaining`;
              }
            },
            sleepBetweenBatches: () => sleep(1000), // pace the S3-heavy batches
          },
        );

        if (loopResult.stalled) {
          spinner.warn(
            `No progress (remaining stuck at ${loopResult.remaining}); stopping - see errors`,
          );
        } else {
          spinner.stop();
        }
      } catch (err) {
        spinner.fail("Data-integrity sweep failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }

      const { batches, totals, remaining } = loopResult;

      if (options.json) {
        console.log(JSON.stringify({ ...totals, batches, remaining }, null, 2));
      } else {
        console.log();
        if (remaining === null) {
          console.log(
            chalk.yellow(
              "Warning: backend returned a null remaining count; the sweep may be incomplete - check server logs.",
            ),
          );
        }
        console.log(
          chalk.cyan(
            `Done in ${batches} batch(es): processed=${totals.processed} complete=${totals.complete} incomplete=${totals.incomplete} unknown=${totals.unknown} errors=${totals.errors} remaining=${remaining ?? "unknown"}`,
          ),
        );
        if (totals.incomplete > 0) {
          console.log(
            chalk.yellow(
              `${totals.incomplete} dataset(s) verified incomplete -- see 'nemar dataset list --json' (data_complete=0) for details.`,
            ),
          );
        }
      }
      // Non-zero exit on errors OR an indeterminate (null) remaining, so a caller
      // never reads a partial/uncertain sweep as success.
      if (totals.errors > 0 || remaining === null) process.exit(1);
    },
  );

adminCommand.addCommand(dataIntegritySweepCommand);

// ============================================================================
// Zarr fidelity verification sweep (issue #1068, epic #1181 phase 8)
// ============================================================================

const zarrFidelitySweepCommand = new Command("zarr-fidelity-sweep").description(
  "Re-verify published Zarr stores against their dataset's own BIDS metadata (#1068)",
);

zarrFidelitySweepCommand
  .option("--limit <n>", "Datasets per batch (server clamps to [1,25])", "25")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (options: { limit?: string; json?: boolean }) => {
    if (!requireAuth()) return;

    const limit = Number.parseInt(options.limit ?? "25", 10) || 25;
    const spinner = ora("Verifying Zarr store fidelity...").start();

    let res: ZarrFidelitySweepBatchResponse;
    try {
      res = await zarrFidelitySweep({ limit });
      spinner.stop();
    } catch (err) {
      spinner.fail("Zarr fidelity sweep failed");
      console.error(chalk.red(errorDetail(err)));
      process.exit(1);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log();
      console.log(
        chalk.cyan(
          `processed=${res.processed} verified=${res.verified} failed=${res.failed} unverifiable=${res.unverifiable} errors=${res.errors.length} remaining=${res.remaining ?? "unknown"}${res.budget_exhausted ? " budget_exhausted=true" : ""}`,
        ),
      );
      for (const r of res.results) {
        const color =
          r.verdict === "verified"
            ? chalk.green
            : r.verdict === "failed"
              ? chalk.red
              : chalk.yellow;
        console.log(
          `  ${color(r.verdict.padEnd(12))} ${r.dataset_id}  (sampled=${r.sampled} checked=${r.checked})`,
        );
        for (const ex of r.examples) {
          console.log(`      ${chalk.red(ex.code)}: ${ex.path}`);
        }
        if (r.examples_truncated) {
          console.log(
            `      ${chalk.dim(`(${r.mismatch_count} mismatches total; showing first ${r.examples.length})`)}`,
          );
        }
      }
      for (const e of res.errors) {
        console.log(`  ${chalk.red("error")}       ${e.dataset_id}: ${e.error}`);
      }
    }
    // Non-zero exit on any per-dataset error, an indeterminate (null)
    // remaining, OR a sweep-wide budget cutoff (this batch is partial --
    // candidates past the cutoff were never even attempted), so a caller
    // never reads a partial/uncertain sweep as success -- mirrors
    // data-integrity-sweep/hed-sweep's convention. A 'failed' verdict is
    // NOT itself a non-zero-exit condition: the sweep ran successfully and
    // reported the truth, which is the whole point.
    if (res.errors.length > 0 || res.remaining === null || res.budget_exhausted) {
      process.exit(1);
    }
  });

adminCommand.addCommand(zarrFidelitySweepCommand);

// ============================================================================
// Anonymity verification sweep (issue #1409, epic #1406)
// ============================================================================

const anonymitySweepCommand = new Command("anonymity-sweep").description(
  "Re-check anonymous deposits against the identity-leak inventory (#1409)",
);

anonymitySweepCommand
  .option("--limit <n>", "Datasets per batch (server clamps to [1,25])", "10")
  .option("--reset", "Re-arm every anonymous deposit, then exit")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (options: { limit?: string; reset?: boolean; json?: boolean }) => {
    if (!requireAuth()) return;

    if (options.reset) {
      const spinner = ora("Re-arming anonymous deposits...").start();
      try {
        const res = await anonymitySweepReset();
        spinner.succeed(`Re-armed ${res.reset} anonymous deposit(s).`);
      } catch (err) {
        spinner.fail("Reset failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }
      return;
    }

    const limit = Number.parseInt(options.limit ?? "10", 10) || 10;
    const spinner = ora("Checking anonymous deposits...").start();

    let res: AnonymitySweepBatchResponse;
    try {
      res = await anonymitySweep({ limit });
      spinner.stop();
    } catch (err) {
      spinner.fail("Anonymity sweep failed");
      console.error(chalk.red(errorDetail(err)));
      process.exit(1);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log();
      console.log(
        chalk.cyan(
          `processed=${res.processed} verified=${res.verified} findings=${res.with_findings} unverifiable=${res.unverifiable} errors=${res.errors.length} mail_failures=${res.mail_failures.length} remaining=${res.remaining ?? "unknown"}${res.budget_exhausted ? " budget_exhausted=true" : ""}`,
        ),
      );
      for (const r of res.results) {
        const color =
          r.status === "verified"
            ? chalk.green
            : r.status === "findings"
              ? chalk.red
              : chalk.yellow;
        console.log(
          `  ${color(r.status.padEnd(13))} ${r.dataset_id}  (files ${r.files_scanned}/${r.files_listed})`,
        );
        for (const f of r.findings) {
          const tag = f.severity === "invariant" ? chalk.red("NEMAR") : chalk.yellow("deposit");
          console.log(`      ${tag} ${f.check}: ${f.detail}`);
        }
        // Printed for EVERY dataset, including a verified one. "Verified" here
        // means "everything this sweep can check is fine", and a reader who is
        // not told what it cannot check will hear something stronger.
        if (r.unchecked.length > 0) {
          console.log(`      ${chalk.dim(`not checked: ${r.unchecked.join(", ")}`)}`);
        }
      }
      for (const e of res.errors) {
        console.log(`  ${chalk.red("error")}         ${e.dataset_id}: ${e.error}`);
      }
      // A finding nobody was told about is a finding that did not arrive. The
      // mail IS the depositor's copy.
      for (const m of res.mail_failures) {
        console.log(
          `  ${chalk.red("not mailed")}    ${m.dataset_id} -> ${m.recipient}: ${m.error}`,
        );
      }
    }
    // Same convention as the fidelity sweep: a non-zero exit means the RUN was
    // partial or uncertain, never that it found something. A findings verdict
    // is the sweep working; a finding that reached nobody is not.
    if (
      res.errors.length > 0 ||
      res.mail_failures.length > 0 ||
      res.remaining === null ||
      res.budget_exhausted
    ) {
      process.exit(1);
    }
  });

adminCommand.addCommand(anonymitySweepCommand);

// ============================================================================
// Doctor: diagnostic checks + remediation (#1130)
// ============================================================================

const doctorCommand = new Command("doctor").description(
  "Diagnose and heal stuck-dataset patterns (e.g. missing S3 version manifests)",
);

function printScanResults(res: DoctorScanResponse): number {
  let total = 0;
  for (const [name, r] of Object.entries(res.results)) {
    total += r.count;
    const status = r.count > 0 ? chalk.red(`${r.count} finding(s)`) : chalk.green("clean");
    console.log(`${chalk.bold(name)}: ${status} — ${r.description}`);
    for (const f of r.findings) {
      console.log(`  ${f.dataset_id}${f.version ? `@v${f.version}` : ""}`);
    }
  }
  return total;
}

doctorCommand
  .command("scan")
  .description("Run diagnostic checks (read-only)")
  .argument("[dataset-id]", "Narrow the scan to one dataset")
  .option("--check <name>", "Run a single check (default: all checks)")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (datasetId: string | undefined, options: { check?: string; json?: boolean }) => {
    if (!requireAuth()) return;
    const spinner = ora(
      "Running doctor checks (read-only; a full-catalog scan can take ~1 minute)...",
    ).start();
    try {
      const res = await doctorScan({ check: options.check, datasetId });
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const total = printScanResults(res);
      if (total > 0) {
        console.log(
          chalk.yellow(
            `\n${total} finding(s). Preview the remediation with: nemar admin doctor fix <check> --dry-run`,
          ),
        );
      }
    } catch (err) {
      spinner.fail("Doctor scan failed");
      console.error(chalk.red(errorDetail(err)));
      process.exit(1);
    }
  });

doctorCommand
  .command("fix")
  .description("Apply a check's remediation (writes; use --dry-run first)")
  .argument("<check>", "Check name (see: nemar admin doctor scan)")
  .argument("[dataset-id]", "Narrow to one dataset")
  .option("--dry-run", "List what would be fixed without writing")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (
      check: string,
      datasetId: string | undefined,
      options: { dryRun?: boolean; json?: boolean },
    ) => {
      if (!requireAuth()) return;

      if (options.dryRun) {
        const spinner = ora(`Listing ${check} findings (dry run)...`).start();
        try {
          const res = await doctorFix({ check, datasetId, dryRun: true });
          spinner.stop();
          if (options.json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          console.log(`Would fix ${res.would_fix} finding(s) for ${chalk.bold(check)}:`);
          for (const f of res.findings) {
            console.log(`  ${f.dataset_id}${f.version ? `@v${f.version}` : ""}`);
          }
        } catch (err) {
          spinner.fail("Dry run failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      // Enumerate first, then fix one dataset per request, so the spinner can
      // show which dataset is in flight and a partial failure is visible the
      // moment it happens rather than after one long opaque request. The
      // narrowed fix re-scans its dataset server-side; a finding healed
      // between the scan and its fix turn comes back with zero results and
      // is counted as `resolved` by runDoctorFixLoop, never silently dropped.
      const spinner = ora(`Scanning for ${check} findings...`).start();
      let findings: DoctorScanResponse["results"][string]["findings"];
      try {
        const scan = await doctorScan({ check, datasetId });
        findings = scan.results[check]?.findings ?? [];
      } catch (err) {
        spinner.fail("Doctor scan failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
        return;
      }
      if (findings.length === 0) {
        spinner.succeed(`${check}: nothing to fix`);
        if (options.json) console.log(JSON.stringify({ check, total: 0, results: [] }, null, 2));
        return;
      }
      spinner.stop();
      console.log(`${chalk.bold(check)}: ${findings.length} finding(s) to fix`);

      const datasetIds = [...new Set(findings.map((f) => f.dataset_id))];
      spinner.start();
      const { totals, results } = await runDoctorFixLoop(
        datasetIds,
        (id, index) => {
          const versions = findings
            .filter((f) => f.dataset_id === id && f.version)
            .map((f) => `v${f.version}`)
            .join(", ");
          spinner.text = `Fixing ${id}${versions ? ` (${versions})` : ""} [${index + 1}/${datasetIds.length}]...`;
          return doctorFix({ check, datasetId: id });
        },
        {
          onDataset: (id, perDataset) => {
            spinner.stop();
            if (perDataset.length === 0) {
              console.log(`  resolved ${id}: healed between the scan and its fix turn`);
            }
            for (const r of perDataset) {
              const label = `${r.dataset_id}${r.version ? `@v${r.version}` : ""}`;
              if (r.status === "fixed") {
                console.log(`  ${chalk.green("fixed")}   ${label}`);
              } else if (r.status === "skipped") {
                console.log(`  skipped ${label}: ${r.message ?? "already healthy"}`);
              } else {
                console.log(`  ${chalk.red("FAILED")}  ${label}: ${r.message ?? "unknown error"}`);
              }
            }
            spinner.start();
          },
        },
      );
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify({ check, total: findings.length, ...totals, results }, null, 2));
      } else {
        const resolvedNote = totals.resolved > 0 ? `, ${totals.resolved} already resolved` : "";
        console.log(
          `\n${chalk.bold(check)}: ${chalk.green(`${totals.fixed} fixed`)}, ${totals.skipped} skipped, ${totals.failed > 0 ? chalk.red(`${totals.failed} failed`) : "0 failed"}${resolvedNote}`,
        );
      }
      // Non-zero exit when any fix failed, so a caller never reads a
      // partial remediation as success.
      if (totals.failed > 0) process.exit(1);
    },
  );

/** Aggregated outcome of {@link runDoctorFixLoop}. `resolved` counts datasets
 *  whose findings were healed between enumeration and their fix turn (the
 *  narrowed server-side re-scan returned zero results). */
export interface DoctorFixLoopOutcome {
  totals: { fixed: number; skipped: number; failed: number; resolved: number };
  results: DoctorFixResult[];
}

/**
 * Per-dataset driver for `nemar admin doctor fix` (#1133 review fix). Pure
 * aggregation over a dependency-injected `fixOne`, mirroring runReauditLoop's
 * extraction convention, so two properties are unit-testable without a server:
 * a dataset healed in the interim is counted as `resolved` (never silently
 * dropped from the tally), and a thrown `fixOne` records a failed result and
 * continues with the remaining datasets instead of aborting the run.
 */
export async function runDoctorFixLoop(
  datasetIds: string[],
  fixOne: (datasetId: string, index: number) => Promise<DoctorFixLiveResponse>,
  hooks?: {
    /** Called after each dataset with its per-dataset results (empty = resolved). */
    onDataset?: (datasetId: string, results: DoctorFixResult[]) => void;
  },
): Promise<DoctorFixLoopOutcome> {
  const totals = { fixed: 0, skipped: 0, failed: 0, resolved: 0 };
  const results: DoctorFixResult[] = [];
  for (const [index, id] of datasetIds.entries()) {
    let perDataset: DoctorFixResult[];
    try {
      const res = await fixOne(id, index);
      perDataset = res.results;
      if (perDataset.length === 0) {
        totals.resolved++;
      } else {
        totals.fixed += res.fixed;
        totals.skipped += res.skipped;
        totals.failed += res.failed;
      }
    } catch (err) {
      totals.failed++;
      perDataset = [{ dataset_id: id, status: "failed", message: errorDetail(err) }];
    }
    results.push(...perDataset);
    hooks?.onDataset?.(id, perDataset);
  }
  return { totals, results };
}

doctorCommand
  .command("kinds")
  .description("Check that operational accounts carry their expected account kind (read-only)")
  .action(async () => {
    if (!requireAuth()) return;

    const entries = Object.entries(OPERATIONAL_ACCOUNT_KINDS);
    const spinner = ora(`Checking ${entries.length} operational account kind(s)...`).start();
    const mismatches: string[] = [];
    const absent: string[] = [];
    try {
      for (const [username, expectedKind] of entries) {
        try {
          const { user } = await getAdminUserByUsername(username);
          if (user.account_kind !== expectedKind) {
            mismatches.push(
              `${username}: expected '${expectedKind}', found '${user.account_kind ?? "unknown"}'`,
            );
          }
        } catch (err) {
          if (err instanceof ApiError && err.statusCode === 404) {
            absent.push(username);
          } else {
            throw err;
          }
        }
      }
      spinner.stop();

      if (mismatches.length === 0 && absent.length === 0) {
        console.log(
          chalk.green(`All ${entries.length} operational account(s) carry their expected kind.`),
        );
        return;
      }
      for (const m of mismatches) {
        console.log(`  ${chalk.yellow("kind mismatch")}  ${m}`);
      }
      for (const u of absent) {
        console.log(`  ${chalk.yellow("account absent")} ${u}`);
      }
      console.log(
        chalk.yellow(
          `\n${mismatches.length + absent.length} finding(s). Fix a mismatch with \`nemar admin kind <username> <kind>\`.`,
        ),
      );
    } catch (err) {
      spinner.fail("Doctor kinds check failed");
      console.error(chalk.red(errorDetail(err)));
      process.exit(1);
    }
  });

adminCommand.addCommand(doctorCommand);

// ============================================================================
// Email Notification Preferences
// ============================================================================

const emailPrefsCommand = new Command("email-preferences").description(
  "Manage email notification preferences",
);

emailPrefsCommand
  .command("show")
  .description("Show email notification preferences")
  .option("--user <username>", "(owner only) show another user's preferences")
  .action(async (options: { user?: string }) => {
    if (!isAuthenticated()) {
      console.error(chalk.red("Not authenticated. Run: nemar auth login"));
      process.exit(1);
    }

    const spinner = ora("Fetching email preferences...").start();
    try {
      const prefs = await getEmailPreferences(options.user);
      const whose = prefs.username ? `${prefs.username}'s` : "Your";
      spinner.succeed(`${whose} email notification preferences:`);
      console.log();

      const categories: Array<{ key: keyof EmailPreferences; label: string }> = [
        { key: "user_approval", label: "User approval notifications" },
        { key: "publication_request", label: "Publication request notifications" },
        { key: "announcements", label: "Announcement emails" },
        { key: "dataset_anonymity", label: "Anonymity sweep findings" },
        { key: "identifier_sweep", label: "Identifier sweep weekly report" },
      ];

      for (const cat of categories) {
        const enabled = prefs[cat.key];
        const status = enabled ? chalk.green("enabled") : chalk.dim("disabled");
        console.log(`  ${cat.label.padEnd(40)} ${status}`);
      }

      console.log();
      console.log(chalk.dim("  Use 'nemar admin email-preferences update' to change settings."));
    } catch (err) {
      spinner.fail("Failed to fetch preferences");
      console.error(chalk.red(errorDetail(err)));
    }
  });

emailPrefsCommand
  .command("update")
  .description("Update email notification preferences")
  .option("--user-approval <bool>", "Enable/disable user approval notifications")
  .option("--publication-request <bool>", "Enable/disable publication request notifications")
  .option("--announcements <bool>", "Enable/disable announcement emails")
  .option("--dataset-anonymity <bool>", "Enable/disable anonymity sweep findings")
  .option("--identifier-sweep <bool>", "Enable/disable the identifier sweep weekly report")
  .option("--all <bool>", "Enable/disable all notifications")
  .option("--user <username>", "(owner only) update another user's preferences")
  .action(
    async (options: {
      userApproval?: string;
      publicationRequest?: string;
      announcements?: string;
      datasetAnonymity?: string;
      identifierSweep?: string;
      all?: string;
      user?: string;
    }) => {
      if (!isAuthenticated()) {
        console.error(chalk.red("Not authenticated. Run: nemar auth login"));
        process.exit(1);
      }

      function parseBool(val: string | undefined): boolean | undefined {
        if (val === undefined) return undefined;
        const lower = val.toLowerCase();
        if (lower === "true" || lower === "1" || lower === "on" || lower === "yes") return true;
        if (lower === "false" || lower === "0" || lower === "off" || lower === "no") return false;
        console.error(
          chalk.red(`Invalid boolean value: "${val}". Use true/false, on/off, yes/no.`),
        );
        process.exit(1);
      }

      const updates: Partial<EmailPreferences> = {};

      if (options.all !== undefined) {
        const val = parseBool(options.all);
        updates.user_approval = val;
        updates.publication_request = val;
        updates.announcements = val;
        updates.dataset_anonymity = val;
        updates.identifier_sweep = val;
      } else {
        const ua = parseBool(options.userApproval);
        const pr = parseBool(options.publicationRequest);
        const ann = parseBool(options.announcements);
        const anon = parseBool(options.datasetAnonymity);
        const sweep = parseBool(options.identifierSweep);

        if (
          ua === undefined &&
          pr === undefined &&
          ann === undefined &&
          anon === undefined &&
          sweep === undefined
        ) {
          console.error(chalk.red("No preferences specified."));
          console.log("  --user-approval <bool>        User approval notifications");
          console.log("  --publication-request <bool>   Publication request notifications");
          console.log("  --announcements <bool>         Announcement emails");
          console.log("  --dataset-anonymity <bool>     Anonymity sweep findings");
          console.log("  --identifier-sweep <bool>      Identifier sweep weekly report");
          console.log("  --all <bool>                   All notifications");
          process.exit(1);
        }

        if (ua !== undefined) updates.user_approval = ua;
        if (pr !== undefined) updates.publication_request = pr;
        if (ann !== undefined) updates.announcements = ann;
        if (anon !== undefined) updates.dataset_anonymity = anon;
        if (sweep !== undefined) updates.identifier_sweep = sweep;
      }

      const spinner = ora("Updating email preferences...").start();
      try {
        const result = await updateEmailPreferences(updates, options.user);
        const whose = result.username ? `${result.username}'s` : "Your";
        spinner.succeed(`${whose} email preferences updated:`);
        console.log();
        console.log(
          `  User approval:        ${result.user_approval ? chalk.green("enabled") : chalk.dim("disabled")}`,
        );
        console.log(
          `  Publication request:   ${result.publication_request ? chalk.green("enabled") : chalk.dim("disabled")}`,
        );
        console.log(
          `  Announcements:         ${result.announcements ? chalk.green("enabled") : chalk.dim("disabled")}`,
        );
        console.log(
          `  Anonymity findings:    ${result.dataset_anonymity ? chalk.green("enabled") : chalk.dim("disabled")}`,
        );
        console.log(
          `  Identifier sweep:      ${result.identifier_sweep ? chalk.green("enabled") : chalk.dim("disabled")}`,
        );
      } catch (err) {
        spinner.fail("Failed to update preferences");
        console.error(chalk.red(errorDetail(err)));
      }
    },
  );

adminCommand.addCommand(emailPrefsCommand);

// ============================================================================
// System Notices
// ============================================================================

const noticeCommand = new Command("notice").description(
  "Manage system notices displayed to CLI users",
);

noticeCommand
  .command("list")
  .description("List all notices (including expired)")
  .action(async () => {
    if (!isAuthenticated()) {
      console.error(chalk.red("Not authenticated. Run: nemar auth login"));
      process.exit(1);
    }

    const spinner = ora("Fetching notices...").start();
    try {
      const { notices } = await listAdminNotices();
      if (notices.length === 0) {
        spinner.succeed("No notices found.");
        return;
      }

      spinner.succeed(`${notices.length} notice(s):`);
      console.log();

      for (const notice of notices) {
        // Mirrors the website's banner tones (#1025) so a level reads the
        // same in the terminal as it does on the site. `info` is retained
        // only so pre-0063 rows in a stale local cache still colourize.
        const levelColors: Record<string, (s: string) => string> = {
          critical: chalk.red.bold,
          warning: chalk.yellow,
          maintenance: chalk.magenta,
          announcement: chalk.green,
          tip: chalk.blue,
          info: chalk.blue,
        };
        const colorFn = levelColors[notice.level] || chalk.white;
        const expired =
          notice.expires_at && new Date(notice.expires_at) < new Date()
            ? chalk.dim(" (expired)")
            : "";

        console.log(
          `  ${chalk.dim(`#${notice.id}`)} ${colorFn(`[${notice.level.toUpperCase()}]`)} ${chalk.dim(`scope:${notice.scope}`)}${expired}`,
        );
        console.log(`     ${notice.message}`);
        console.log(`     ${chalk.dim(`Created: ${notice.created_at}`)}`);
        if (notice.expires_at) {
          console.log(`     ${chalk.dim(`Expires: ${notice.expires_at}`)}`);
        }
        console.log();
      }
    } catch (err) {
      handleCommandError(err, spinner, "Failed to fetch notices");
    }
  });

noticeCommand
  .command("set")
  .description("Create a new system notice")
  .requiredOption("-m, --message <text>", "Notice message text")
  .option(
    "-l, --level <level>",
    "Notice level: tip, announcement, maintenance, warning, critical",
    "tip",
  )
  .option("-s, --scope <scope>", "Target scope: all, admins, members", "all")
  .option("-e, --expires <datetime>", "Expiry datetime (ISO 8601)")
  .action(
    async (options: {
      message: string;
      level: string;
      scope: string;
      expires?: string;
    }) => {
      if (!isAuthenticated()) {
        console.error(chalk.red("Not authenticated. Run: nemar auth login"));
        process.exit(1);
      }

      // `info` stays accepted (the API normalizes it to `tip`, #1025) so
      // existing scripts don't break, but it isn't advertised in --help.
      if (![...NOTICE_LEVELS, "info"].includes(options.level as NoticeLevel)) {
        console.error(
          chalk.red(`Invalid level: ${options.level}. Use ${NOTICE_LEVELS.join(", ")}.`),
        );
        process.exit(1);
      }
      if (!["all", "admins", "members"].includes(options.scope)) {
        console.error(chalk.red(`Invalid scope: ${options.scope}. Use all, admins, or members.`));
        process.exit(1);
      }

      const spinner = ora("Creating notice...").start();
      try {
        const notice = await createNotice({
          message: options.message,
          level: options.level,
          scope: options.scope,
          expires_at: options.expires,
        });
        spinner.succeed(`Notice created (ID: ${notice.id})`);
        console.log(`  Level: ${notice.level}`);
        console.log(`  Scope: ${notice.scope}`);
        console.log(`  Message: ${notice.message}`);
        if (notice.expires_at) {
          console.log(`  Expires: ${notice.expires_at}`);
        }
      } catch (err) {
        handleCommandError(err, spinner, "Failed to create notice");
      }
    },
  );

noticeCommand
  .command("clear <id>")
  .description("Delete a notice by ID")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (idStr: string, options: ConfirmOptions) => {
    if (!isAuthenticated()) {
      console.error(chalk.red("Not authenticated. Run: nemar auth login"));
      process.exit(1);
    }

    const id = Number.parseInt(idStr, 10);
    if (Number.isNaN(id)) {
      console.error(chalk.red("Invalid notice ID"));
      process.exit(1);
    }

    const confirmed = await confirm(`Delete notice #${id}?`, options, false);
    if (!confirmed) return;

    const spinner = ora("Deleting notice...").start();
    try {
      await deleteNotice(id);
      spinner.succeed(`Notice #${id} deleted`);
    } catch (err) {
      handleCommandError(err, spinner, "Failed to delete notice");
    }
  });

adminCommand.addCommand(noticeCommand);

// ============================================================================
// Broadcast Notifications
// ============================================================================

adminCommand
  .command("notify")
  .description("Send an email to a group or a single user")
  .option("--to <group>", "Recipient group: all, admins, members")
  .option("--user <username>", "Send to a single user by username")
  .requiredOption("--subject <text>", "Email subject line")
  .option("--body <text>", "Email body (markdown)")
  .option("--body-file <path>", "Read email body from file (markdown)")
  .option("--dry-run", "Preview recipients without sending")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (options: {
      to?: string;
      user?: string;
      subject: string;
      body?: string;
      bodyFile?: string;
      dryRun?: boolean;
      yes?: boolean;
      no?: boolean;
    }) => {
      if (!isAuthenticated()) {
        console.error(chalk.red("Not authenticated. Run: nemar auth login"));
        process.exit(1);
      }

      // Mutual exclusion: exactly one of --to or --user
      if (options.to && options.user) {
        console.error(chalk.red("--to and --user are mutually exclusive. Provide exactly one."));
        process.exit(1);
      }
      if (!options.to && !options.user) {
        console.error(chalk.red("Provide either --to <group> or --user <username>."));
        process.exit(1);
      }

      if (options.to && !["all", "admins", "members"].includes(options.to)) {
        console.error(chalk.red(`Invalid group: ${options.to}. Use all, admins, or members.`));
        process.exit(1);
      }

      // Resolve body content
      let body: string;
      if (options.bodyFile) {
        if (!existsSync(options.bodyFile)) {
          console.error(chalk.red(`File not found: ${options.bodyFile}`));
          process.exit(1);
        }
        body = readFileSync(options.bodyFile, "utf-8");
      } else if (options.body) {
        body = options.body;
      } else {
        console.error(chalk.red("Email body required. Use --body or --body-file."));
        process.exit(1);
      }

      const target = options.user ? `user:${options.user}` : (options.to as string);
      const requestPayload = options.user
        ? { user: options.user, subject: options.subject, body }
        : { to: options.to as string, subject: options.subject, body };

      if (options.dryRun) {
        const spinner = ora("Checking recipients...").start();
        try {
          const result = await sendBroadcast({ ...requestPayload, dry_run: true });
          if ("dry_run" in result) {
            spinner.succeed(
              `Dry run: ${result.recipient_count} recipient(s) for "${result.recipient_group}"`,
            );
            console.log();
            for (const email of result.recipients) {
              console.log(`  ${email}`);
            }
          }
        } catch (err) {
          handleCommandError(err, spinner, "Failed to check recipients");
        }
        return;
      }

      // Preview and confirm
      console.log(chalk.bold("Email preview:"));
      console.log(`  To: ${chalk.cyan(target)}`);
      console.log(`  Subject: ${options.subject}`);
      console.log(`  Body: ${body.length > 100 ? `${body.substring(0, 100)}...` : body}`);
      console.log();

      const confirmPrompt = options.user
        ? `Send this email to ${options.user}?`
        : "Send this broadcast email?";
      const confirmed = await confirm(confirmPrompt, options, false);
      if (!confirmed) return;

      const spinner = ora(
        options.user ? `Sending to ${options.user}...` : "Sending broadcast...",
      ).start();
      try {
        const result = await sendBroadcast(requestPayload);

        if ("broadcast_id" in result) {
          if (result.failure_count > 0) {
            spinner.warn(
              `Email send: ${result.recipient_count} delivered, ${result.failure_count} failed`,
            );
            for (const email of result.failed_recipients) {
              console.log(chalk.red(`  Failed: ${email}`));
            }
          } else {
            const label = options.user
              ? `Email sent to ${options.user}`
              : `Broadcast sent to ${result.recipient_count} recipient(s)`;
            spinner.succeed(`${label} (ID: ${result.broadcast_id})`);
          }
        }
      } catch (err) {
        handleCommandError(err, spinner, "Failed to send email");
      }
    },
  );

// ============================================================================
// nemar admin summary check  (epic #618 / phase 2 #620)
// ============================================================================

/**
 * The dispatch path runs sequentially with a small delay between calls so a
 * bulk backfill doesn't burst GitHub's `repository_dispatch` rate limit
 * (documented at 500 events/hour per repo — sustained that's ~7.2 s between
 * calls). 1.5 s is well under that ceiling but lets a ~150-version backfill
 * finish in ~4 min instead of ~18 min at the sustained rate. The generator
 * itself runs in the runner pool, so server-side concurrency is bounded by
 * GitHub Actions queueing — we don't need additional throttling for the
 * workflow execution itself.
 */
const DISPATCH_THROTTLE_MS = 1500;

function formatState(state: SummaryVersionCoverage["state"]): string {
  switch (state.kind) {
    case "ok":
      return chalk.green(`ok    ${state.schema_version}`);
    case "stale":
      return chalk.yellow(`stale ${state.schema_version}`);
    case "missing":
      return chalk.red("missing");
    case "error":
      return chalk.red(`error ${state.status || "?"}: ${state.message}`);
  }
}

function isStale(state: SummaryVersionCoverage["state"]): boolean {
  return state.kind === "stale" || state.kind === "missing";
}

/**
 * Convert a shell-style glob to an anchored RegExp.
 *
 *   `*` → `.*`  (any run of any chars)
 *   `?` → `.`   (one of any char)
 *
 * Every other regex metacharacter is escaped, so a literal `.` in a glob
 * (e.g. `on00*.draft`) is treated as a literal `.`, not "any char". We do
 * NOT support character classes (`[abc]`) or brace expansion (`{a,b}`) —
 * if the operator needs that, they can fall back to `--id` per-target.
 *
 * Anchored with `^...$` so `on*` matches `on007315` but not `xon007315`.
 */
export function globToRegExp(glob: string): RegExp {
  // Escape regex metacharacters except `*` and `?`. The character class
  // here is the regex spec's metachar set minus the two we treat specially.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`);
}

const summaryCommand = new Command("summary").description(
  "summary.json coverage across published dataset versions",
);

summaryCommand
  .command("check")
  .description("Report which (dataset_id, version) pairs have stale or missing summary.json")
  .option("--fix", "Dispatch generate-manifest for every stale/missing version")
  .option("--id <id>", "Limit to a single dataset_id (exact match)")
  .option(
    "--match <glob>",
    "Limit to dataset_ids matching a glob pattern: `*` matches any run of chars, `?` matches one char. Examples: `on*`, `nm00010?`, `*99999`. Can be combined with --id (id wins if both passed).",
  )
  .option("--only-stale", "Print only rows that are not ok (suppresses ok rows)")
  .option("--json", "Emit the full report as JSON instead of a table")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      options: {
        fix?: boolean;
        id?: string;
        match?: string;
        onlyStale?: boolean;
        json?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      const spinner = ora("Building coverage report...").start();
      let report: Awaited<ReturnType<typeof getSummaryCoverage>>;
      try {
        report = await getSummaryCoverage();
      } catch (err) {
        handleCommandError(err, spinner, "Failed to fetch coverage report");
        return;
      }
      spinner.succeed(
        `Coverage: target=schema ${report.target_schema}, versions=${report.totals.versions}`,
      );

      let rows = report.versions;
      let filterLabel: string | null = null;
      if (options.id) {
        rows = rows.filter((r) => r.dataset_id === options.id);
        filterLabel = `dataset_id=${options.id}`;
        if (rows.length === 0) {
          console.log(chalk.yellow(`No rows for ${filterLabel}`));
          return;
        }
      } else if (options.match) {
        const re = globToRegExp(options.match);
        rows = rows.filter((r) => re.test(r.dataset_id));
        filterLabel = `--match ${options.match}`;
        if (rows.length === 0) {
          console.log(chalk.yellow(`No rows match ${filterLabel}`));
          return;
        }
        console.log(chalk.dim(`Scoped to ${rows.length} version(s) matching ${options.match}`));
      }

      if (options.json) {
        // Re-emit with the same totals so the JSON consumer (cron workflow)
        // doesn't have to re-aggregate.
        console.log(
          JSON.stringify(
            filterLabel ? { ...report, versions: rows, totals: recomputeTotals(rows) } : report,
            null,
            2,
          ),
        );
        return;
      }

      const printable = options.onlyStale ? rows.filter((r) => r.state.kind !== "ok") : rows;
      if (printable.length === 0) {
        console.log(chalk.green("All versions at target schema — no drift."));
      } else {
        const idWidth = Math.max(...printable.map((r) => r.dataset_id.length), 10);
        const verWidth = Math.max(...printable.map((r) => r.version.length), 7);
        for (const r of printable) {
          console.log(
            `  ${r.dataset_id.padEnd(idWidth)}  ${r.version.padEnd(verWidth)}  ${formatState(r.state)}`,
          );
        }
      }

      // Print the totals after the per-row dump so they're the last thing on
      // screen — the operator's eye lands there for the go/no-go decision.
      const totals = filterLabel ? recomputeTotals(rows) : report.totals;
      console.log();
      console.log(
        `  Total: ${totals.versions}  ${chalk.green(`ok=${totals.ok}`)}  ` +
          `${chalk.yellow(`stale=${totals.stale}`)}  ${chalk.red(`missing=${totals.missing}`)}  ` +
          `${chalk.red(`error=${totals.error}`)}`,
      );

      if (!options.fix) {
        if (totals.stale + totals.missing > 0) {
          console.log(
            chalk.dim(
              `\nRun with --fix to dispatch generate-manifest for the ${totals.stale + totals.missing} drifted version(s).`,
            ),
          );
        }
        return;
      }

      const toDispatch = rows.filter((r) => isStale(r.state));
      if (toDispatch.length === 0) {
        console.log(chalk.green("\nNothing to dispatch."));
        return;
      }

      const scopeHint = filterLabel ? ` (scoped to ${filterLabel})` : "";
      const confirmResult = await confirm(
        `Dispatch generate-manifest for ${toDispatch.length} version(s)${scopeHint}? Each dispatch queues a runner job on nemarDatasets/.github.`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      let dispatched = 0;
      let failed = 0;
      console.log();
      for (const [idx, r] of toDispatch.entries()) {
        const ds = `${r.dataset_id}@${r.version}`;
        const dSpinner = ora(`[${idx + 1}/${toDispatch.length}] dispatching ${ds}...`).start();
        try {
          await dispatchManifest(r.dataset_id, r.version);
          dSpinner.succeed(`[${idx + 1}/${toDispatch.length}] dispatched ${ds}`);
          dispatched++;
        } catch (err) {
          dSpinner.fail(`[${idx + 1}/${toDispatch.length}] ${ds}: ${errorDetail(err)}`);
          failed++;
        }
        // Throttle so a bulk backfill doesn't burst GitHub's dispatch rate
        // limit. Skipped on the last iteration.
        if (idx < toDispatch.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, DISPATCH_THROTTLE_MS));
        }
      }

      console.log();
      console.log(
        failed === 0
          ? chalk.green(`All ${dispatched} dispatches succeeded.`)
          : chalk.yellow(`${dispatched} succeeded, ${failed} failed.`),
      );
      console.log(
        chalk.dim(
          "Workflow runs will appear on https://github.com/nemarDatasets/.github/actions. Re-run `nemar admin summary check` once they complete to verify drift cleared.",
        ),
      );
      if (failed > 0) process.exitCode = 1;
    },
  );

function recomputeTotals(rows: SummaryVersionCoverage[]) {
  return {
    versions: rows.length,
    ok: rows.filter((r) => r.state.kind === "ok").length,
    stale: rows.filter((r) => r.state.kind === "stale").length,
    missing: rows.filter((r) => r.state.kind === "missing").length,
    error: rows.filter((r) => r.state.kind === "error").length,
  };
}

adminCommand.addCommand(summaryCommand);

// ============================================================================
// Zarr catalog (issue #1062, epic #1181 phase 2): on-demand refresh of the
// top-level Zarr discovery document (zarr-catalog.json). The daily cron
// publishes it automatically; this is for an operator who doesn't want to
// wait for the next tick.
// ============================================================================

const zarrCatalogCommand = new Command("zarr-catalog").description(
  "Top-level Zarr discovery catalog (zarr-catalog.json)",
);

zarrCatalogCommand
  .command("publish")
  .description("Rebuild and republish zarr-catalog.json to this environment's bucket")
  .action(async () => {
    if (!requireAuth()) return;

    const spinner = ora("Publishing zarr-catalog.json...").start();
    try {
      const result = await publishZarrCatalog();
      spinner.succeed(
        `Published zarr-catalog.json: ${result.count} dataset(s), ${result.bytes} bytes`,
      );
    } catch (err) {
      handleCommandError(err, spinner, "Failed to publish zarr catalog");
      process.exit(1);
    }
  });

adminCommand.addCommand(zarrCatalogCommand);

// ============================================================================
// Researcher-name backfill (#1255, epic #1250)
//
// DOIs cite the uploader by real name and publishing is blocked without one,
// but most accounts predate the signup-time ORCID name lookup. This fills the
// gap from each account's own public ORCID record.
// ============================================================================

const backfillNamesCommand = new Command("backfill-names").description(
  "Fill missing researcher names from users' public ORCID records (dry run by default)",
);

backfillNamesCommand
  .option("--apply", "Write the names (without this flag, only report what would change)")
  .option("--limit <n>", "Users per batch (server clamps to [1,100])", "25")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (options: { apply?: boolean; limit?: string; json?: boolean }) => {
    if (!requireAuth()) return;

    const limit = Number.parseInt(options.limit ?? "25", 10) || 25;
    const apply = options.apply === true;
    const spinner = ora(
      apply ? "Backfilling names from ORCID..." : "Checking ORCID for missing names...",
    ).start();

    let res: BackfillNamesResponse;
    try {
      res = await backfillUserNames({ apply, limit });
      spinner.stop();
    } catch (err) {
      spinner.fail("Name backfill failed");
      console.error(chalk.red(errorDetail(err)));
      process.exit(1);
      return;
    }

    // Computed before the --json branch returns, so a scripted caller reading
    // the exit code sees the same verdict as someone reading the summary below.
    // A lookup failure leaves the row a candidate for the next run, and an
    // unknown remainder means the batch's own bookkeeping failed. Neither is
    // fatal, but a caller must not read either as a clean sweep.
    if (res.lookup_failed > 0 || (res.write_failed ?? 0) > 0 || res.remaining === null) {
      process.exitCode = 1;
    }

    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    console.log();
    if (!res.apply) {
      console.log(chalk.yellow("DRY RUN — nothing was written. Re-run with --apply."));
    }
    console.log(
      chalk.cyan(
        `scanned=${res.scanned} ${res.apply ? "filled" : "would_fill"}=${
          res.apply ? res.filled : res.would_fill
        } no_public_name=${res.no_public_name} lookup_failed=${
          res.lookup_failed
        } write_failed=${res.write_failed ?? 0} remaining=${res.remaining ?? "unknown"}`,
      ),
    );
    for (const r of res.results) {
      const who = r.username ?? `id ${r.id} <${r.email}>`;
      if (r.outcome === "filled" || r.outcome === "would_fill") {
        const verb = r.outcome === "filled" ? chalk.green("filled  ") : chalk.cyan("would fill");
        console.log(`  ${verb} ${who}: ${r.given_name} ${r.family_name}  (${r.orcid})`);
      } else if (r.outcome === "no_public_name") {
        console.log(
          `  ${chalk.yellow("no name ")} ${who}: ORCID ${r.orcid} does not publish a full name`,
        );
      } else if (r.outcome === "write_failed") {
        // Not folded in with the ORCID failure below: the name was READ fine
        // and our own write is what refused it, so the operator is looking at
        // D1 rather than at orcid.org.
        console.log(`  ${chalk.red("write   ")} ${who}: ${r.error}; retry the batch`);
      } else {
        console.log(`  ${chalk.red("error   ")} ${who}: ${r.error}`);
      }
    }
    // `remaining=unknown` above means the count query itself failed; say what
    // failed rather than leaving the operator to guess (#1255 review item 28).
    if (res.warning) {
      console.log(chalk.yellow(`  Warning: ${res.warning}`));
    }
    if (res.no_public_name > 0) {
      console.log();
      console.log(
        chalk.dim(
          "These accounts must make their name public on their ORCID record and sign in again; NEMAR cannot type a name in for an ORCID-linked account, because the record is re-read on every sign-in and would overwrite it. An account with no verified ORCID can set its name in Settings (ADR 0042).",
        ),
      );
    }
  });

adminCommand.addCommand(backfillNamesCommand);

// ============================================================================
// Import-failure issue triage (#1310, epic #1306)
// ============================================================================

/** The shape the route puts under `details` on its 502, narrowed rather than cast
 *  so a body that drifted renders nothing instead of printing `undefined`. */
function isTriageErrorList(
  value: unknown,
): value is { errors: ImportIssueTriageResponse["errors"] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { errors?: unknown }).errors)
  );
}

/** The shape the coverage route puts under `details` on its 502. Narrowed rather
 *  than cast so a drifted body renders nothing instead of `undefined`. */
function isCoverageErrorList(
  value: unknown,
): value is { errors: ImportCoverageResponse["errors"] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { errors?: unknown }).errors)
  );
}

/** Untracked rows and row-less issues listed before truncating. One budget, matching
 *  the backend's `RECONCILE_MAX_LISTED`: two different numbers for the same list is
 *  how a reader learns not to trust either. */
const RECONCILE_LISTED_ROWS = 20;

const importIssueTriageCommand = new Command("import-issue-triage").description(
  "Close recovered import-failure issues and retire stale cause labels (dry run by default)",
);

importIssueTriageCommand
  .option("--apply", "Perform the changes (without this flag, only report what would change)")
  .option("--limit <n>", "Issues per batch (server clamps to [1,30])", "15")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (options: { apply?: boolean; limit?: string; json?: boolean }) => {
    if (!requireAuth()) return;

    // Refused rather than coerced. `parseInt(...) || 15` turned `--limit abc` and
    // `--limit 0` into 15 and `--limit -5` into a server-clamped 1, silently: the
    // operator asked for something and got something else, on a command whose
    // whole point is to bound how many issues it touches.
    // `Number`, not `Number.parseInt`: parseInt stops at the first non-digit and
    // returns what it has, so it still silently coerced `15abc` to 15, `3.9` to 3
    // and `1e9` to 1 -- the same substitution this guard exists to refuse.
    const limitRaw = options.limit ?? "15";
    const limit = limitRaw.trim() === "" ? Number.NaN : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(
        chalk.red(`Invalid --limit ${JSON.stringify(limitRaw)}: expected an integer >= 1.`),
      );
      process.exitCode = 1;
      return;
    }

    const apply = options.apply === true;
    const spinner = ora(
      apply ? "Triaging import-failure issues..." : "Checking import-failure issues...",
    ).start();

    let res: ImportIssueTriageResponse;
    try {
      res = await importIssueTriage({ apply, limit });
      spinner.stop();
    } catch (err) {
      spinner.fail("Import-failure issue triage failed");
      console.error(chalk.red(errorDetail(err)));
      // The 502 "every attempt failed" body carries the per-issue causes, and the
      // message tells the reader to see errors[] -- so dropping the body here left
      // a count with no reasons in the one case where the reasons ARE the point.
      // `request()` keeps the body on the error, so recover it.
      const details = err instanceof ApiError ? err.details : undefined;
      const errors = isTriageErrorList(details) ? details.errors : [];
      if (options.json) {
        // A scripted caller must still get parseable stdout on the interesting
        // outcome; without this the --json contract holds only on success.
        console.log(
          JSON.stringify(
            err instanceof ApiError ? (err.rawBody ?? { errors }) : { errors },
            null,
            2,
          ),
        );
      } else {
        for (const e of errors) {
          console.error(
            `${chalk.red("ERROR".padEnd(15))} #${e.issue} ${e.dataset_id ?? ""}  ${e.stage}: ${e.error}`,
          );
        }
      }
      process.exitCode = 1;
      return;
    }

    // Computed before the --json branch returns so a scripted caller sees the
    // same verdict as someone reading the summary. A per-issue error leaves
    // that issue untouched and still a candidate; it is not fatal, but it must
    // not read as a clean run.
    if (res.errors.length > 0) process.exitCode = 1;

    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    console.log();
    if (!res.applied) {
      console.log(chalk.yellow("DRY RUN \u2014 nothing was written. Re-run with --apply."));
    }
    for (const e of res.plan) {
      // From the entry, not from res.applied: an applied run whose close failed
      // must not print CLOSE as though it had happened.
      const verb = e.failed ? "FAILED " : res.applied ? "" : "WOULD ";
      const who = `#${e.issueNumber} ${e.datasetId ?? "(unknown)"}`;
      if (e.kind === "close") {
        const label = `${verb}CLOSE`.padEnd(15);
        console.log(
          `${e.failed ? chalk.red(label) : chalk.green(label)} ${who}  ${chalk.dim(e.reason)}`,
        );
      } else if (e.kind === "relabel") {
        const label = `${verb}RELABEL`.padEnd(15);
        console.log(
          `${e.failed ? chalk.red(label) : chalk.yellow(label)} ${who}  ${chalk.dim(e.reason)}`,
        );
      } else {
        console.log(`${chalk.dim("KEEP".padEnd(15))} ${who}  ${chalk.dim(e.reason)}`);
      }
    }
    for (const r of res.rollups) {
      // From the rollup's own outcome, not from res.applied: a release whose
      // close failed must not print RELEASE.
      const verb =
        r.outcome === "failed"
          ? "FAILED RELEASE"
          : r.outcome === "released"
            ? "RELEASE"
            : res.mode === "per-dataset"
              ? "WOULD RELEASE"
              : "ROLLUP";
      const label = verb.padEnd(15);
      console.log(
        `${r.outcome === "failed" ? chalk.red(label) : chalk.magenta(label)} #${r.number} ${chalk.dim(r.title)}`,
      );
    }
    for (const e of res.errors) {
      console.log(
        `${chalk.red("ERROR".padEnd(15))} #${e.issue} ${e.dataset_id ?? ""}  ${e.stage}: ${e.error}`,
      );
    }

    console.log();
    console.log(
      chalk.cyan(
        `open=${res.openIssues} mode=${res.mode} examined=${res.examined} ` +
          `attempted=${res.attempted} ` +
          `${res.applied ? "closed" : "would_close"}=${res.closed} ` +
          `${res.applied ? "relabelled" : "would_relabel"}=${res.relabelled} ` +
          `kept=${res.kept} errors=${res.errors.length} remaining=${res.remaining}`,
      ),
    );
    if (res.remaining > 0) {
      console.log(
        chalk.dim(
          `  ${res.remaining} candidate(s) outside this run's window; the window rotates daily.`,
        ),
      );
    }
    if (res.mode === "rollup") {
      console.log(
        chalk.dim(
          "  Rollup mode: new failures with a cause that already has a rollup join it instead of opening their own issue.",
        ),
      );
    }
    if (res.rollupsReleased > 0) {
      console.log(
        chalk.dim(
          `  ${res.applied ? "Released" : "Would release"} ${res.rollupsReleased} rollup(s): the backlog has drained, so per-dataset filing resumes.`,
        ),
      );
    }
    if (res.audit_failed) {
      console.log(
        chalk.yellow(
          `  Changes were applied but the audit row failed to write: ${res.audit_failed}`,
        ),
      );
    }
    if (!res.applied && (res.closed > 0 || res.relabelled > 0 || res.rollupsReleased > 0)) {
      console.log(chalk.dim("  Re-run with --apply to perform these changes."));
    }

    // Reconcile (#1352). Printed after the triage summary because it describes a
    // different question -- whether the two sides agree -- and answering it changes
    // nothing on GitHub.
    // `== null`, so an OLDER BACKEND that omits the field entirely is handled too.
    // `=== null` crashed against production the day this shipped: the reconcile went
    // to dev after the release, so the response had no `reconcile` key at all,
    // `undefined !== null` took the else branch, and the command died on
    // `rec.rowsWithoutIssue` AFTER printing a complete, correct triage report. The
    // CLI is published to npm independently of the Worker, so it is routinely newer
    // or older than the backend it talks to; a field added on one side must never be
    // load-bearing on the other.
    if (res.reconcile == null) {
      // Never silence: "could not compare" and "they agree" are the confusion this
      // epic exists to remove, one level down.
      console.log();
      console.log(
        chalk.yellow(`reconcile=unknown${res.reconcileError ? `: ${res.reconcileError}` : ""}`),
      );
    } else {
      const rec = res.reconcile;
      console.log();
      console.log(
        chalk.cyan(
          `reconcile rows_without_issue=${rec.rowsWithoutIssue.length} ` +
            `issues_without_row=${rec.issuesWithoutRow.length} ` +
            `parked=${rec.parked} quarantined=${rec.quarantined} ` +
            `rows_examined=${rec.rowsExamined} issues_examined=${rec.issuesExamined}`,
        ),
      );
      for (const r of rec.rowsWithoutIssue.slice(0, RECONCILE_LISTED_ROWS)) {
        console.log(
          `${chalk.yellow("UNTRACKED".padEnd(15))} ${r.datasetId} (${r.sourceId}) ${r.status} at ${r.stage}  ${chalk.dim(r.cause)}`,
        );
      }
      const hiddenRows = rec.rowsWithoutIssue.length - RECONCILE_LISTED_ROWS;
      if (hiddenRows > 0) console.log(chalk.dim(`  ... and ${hiddenRows} more untracked`));
      for (const i of rec.issuesWithoutRow.slice(0, RECONCILE_LISTED_ROWS)) {
        console.log(`${chalk.yellow("NO IMPORT ROW".padEnd(15))} #${i.number} ${i.datasetId}`);
      }
      const hiddenIssues = rec.issuesWithoutRow.length - RECONCILE_LISTED_ROWS;
      if (hiddenIssues > 0) console.log(chalk.dim(`  ... and ${hiddenIssues} more`));
      // Always printed, not only on a disagreement: the reason is where the `parked`
      // and `quarantined` glosses live, so a clean run otherwise showed a bare
      // `parked=3` with nothing saying what it means or where those are reported.
      console.log(chalk.dim(`  ${rec.reason}`));
      if (rec.rowsWithoutIssue.length > 0 || rec.issuesWithoutRow.length > 0) {
        console.log(chalk.dim("  Reported only: this command files and closes nothing for these."));
      }
    }
  });

adminCommand.addCommand(importIssueTriageCommand);

// ============================================================================
// Import coverage (#1311, epic #1306 phase 3)
// ============================================================================

const importCoverageCommand = new Command("import-coverage").description(
  "Check whether the import pipeline is keeping up with OpenNeuro (dry run by default)",
);

/**
 * How many outstanding ids to list before falling back to a count.
 *
 * Must equal `MAX_LISTED_IDS` in backend/src/services/import-coverage.ts, so the
 * CLI and the GitHub issue truncate at the same place. The CLI cannot import from
 * backend/src, so `test/import-coverage-cli.test.ts` asserts the two are equal
 * rather than leaving them free to drift.
 */
const COVERAGE_MAX_LISTED_IDS = 20;

/** Actions rendered in the conditional. `would created` was ungrammatical, and a
 *  dry run is the DEFAULT invocation, so it is the string most operators see. */
/** Parked rows the CLI lists before falling back to a count. Fewer than the issue
 *  body's, because a terminal is scrolled rather than searched -- but the "and N
 *  more" line below is not optional: a report that stops at N without saying so
 *  under-counts, and an under-count reads as good news. */
const WEEKLY_CLI_PARKED_ROWS = 5;

const COVERAGE_ACTION_VERB: Record<string, string> = {
  created: "create",
  refreshed: "refresh",
  relabelled: "relabel",
  closed: "close",
};

importCoverageCommand
  .option("--apply", "File, update or close the tracking issue (production only)")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (options: { apply?: boolean; json?: boolean }) => {
    if (!requireAuth()) return;

    const apply = options.apply === true;
    const spinner = ora("Checking import coverage...").start();

    let res: ImportCoverageResponse;
    try {
      res = await importCoverageSweep({ apply });
      spinner.stop();
    } catch (err) {
      spinner.fail("Import coverage check failed");
      console.error(chalk.red(errorDetail(err)));
      // A 502 means the verdict is UNKNOWN, and its body carries the stage that
      // failed. Printing "failed" with no stage would leave the operator unable to
      // tell an OpenNeuro outage from a D1 one.
      const details = err instanceof ApiError ? err.details : undefined;
      const errors = isCoverageErrorList(details) ? details.errors : [];
      if (options.json) {
        console.log(
          JSON.stringify(
            err instanceof ApiError ? (err.rawBody ?? { errors }) : { errors },
            null,
            2,
          ),
        );
      } else {
        for (const e of errors) {
          console.error(`${chalk.red("ERROR".padEnd(12))} ${e.stage}: ${e.error}`);
        }
      }
      // 2, not 1: "could not determine" is a different answer from "not healthy",
      // and a script polling pipeline health has to be able to tell them apart.
      process.exitCode = err instanceof ApiError && err.statusCode === 502 ? 2 : 1;
      return;
    }

    // Set before the --json return so both output modes agree on the verdict. An
    // alarm is a successful RUN but an unhealthy STATE, so it is non-zero.
    if (res.status === "unknown") process.exitCode = 2;
    else if (res.status !== "healthy" || res.errors.length > 0) process.exitCode = 1;
    // The code is the verdict, so suppress the "file a bug" nudge: an alarm is this
    // command working, and 2 means it could not determine -- both are answers.
    if (process.exitCode !== 0) markReportedExit();

    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const b = res.backlog;
    const outstanding = b.neverAttempted.length + b.untracked.length;
    console.log();
    const verdict = `${res.status.toUpperCase()}${res.kind ? ` (${res.kind})` : ""}`;
    console.log(res.status === "healthy" ? chalk.green(verdict) : chalk.red(chalk.bold(verdict)));
    console.log(res.reason);
    console.log();
    console.log(
      chalk.cyan(
        `auto_import=${res.enabled ? "enabled" : chalk.red("DISABLED")} ` +
          // Mirrors the backend's dispatchPhrase: a negative age is a clock anomaly,
          // and "-10h ago" would read as freshness.
          `last_dispatch=${
            res.dispatchAgeHours === null
              ? "never"
              : res.dispatchAgeHours < 0
                ? "dated in the future"
                : `${res.dispatchAgeHours}h ago`
          }` +
          `${res.lastDispatchSourceId ? ` (${res.lastDispatchSourceId})` : ""} ` +
          `dispatch_lost=${res.dispatchLost}`,
      ),
    );
    // The counts balance against `discovered` by construction; a line that does
    // not add up means the run did not get a complete view of the catalogue.
    const accounted =
      res.importedInScan +
      res.inFlight +
      res.terminal +
      outstanding +
      b.tracked.length +
      b.blocklisted.length;
    console.log(
      chalk.cyan(
        `discovered=${res.discovered} in_scan=${res.importedInScan} in_flight=${res.inFlight} ` +
          `terminal=${res.terminal} tracked=${b.tracked.length} blocklisted=${b.blocklisted.length}`,
      ),
    );
    console.log(
      chalk.cyan(
        `outstanding=${outstanding} (never_attempted=${b.neverAttempted.length} untracked=${b.untracked.length})`,
      ),
    );
    if (res.importedNotInScan > 0) {
      console.log(
        chalk.dim(
          `  ${res.importedNotInScan} of ${res.imported} mirror(s) are no longer in the scan (upstream removal, unreadable snapshot, or a modality retag). Drift, not a gap.`,
        ),
      );
    }
    if (accounted !== res.discovered) {
      console.log(
        chalk.yellow(
          `  Counts do not balance (${accounted} accounted for vs ${res.discovered} discovered): this run did not get a complete view, so treat the verdict as unreliable.`,
        ),
      );
    }
    if (b.neverAttempted.length > 0) {
      const shown = b.neverAttempted.slice(0, COVERAGE_MAX_LISTED_IDS).join(", ");
      const extra = b.neverAttempted.length - COVERAGE_MAX_LISTED_IDS;
      console.log(
        chalk.dim(`  never attempted: ${shown}${extra > 0 ? ` ... and ${extra} more` : ""}`),
      );
    }
    if (b.untracked.length > 0) {
      const shown = b.untracked.slice(0, COVERAGE_MAX_LISTED_IDS).join(", ");
      const extra = b.untracked.length - COVERAGE_MAX_LISTED_IDS;
      console.log(
        chalk.dim(`  stale row nothing owns: ${shown}${extra > 0 ? ` ... and ${extra} more` : ""}`),
      );
    }
    for (const e of res.errors) {
      const line = `${e.stage}: ${e.error}`;
      console.log(
        e.stage === "anomaly"
          ? `${chalk.yellow("ANOMALY".padEnd(12))} ${line}`
          : `${chalk.red("ERROR".padEnd(12))} ${line}`,
      );
    }
    if (res.issue) {
      const verb = res.applied
        ? res.issue.action
        : `would ${COVERAGE_ACTION_VERB[res.issue.action] ?? res.issue.action}`;
      const where = res.issue.number === null ? "" : ` #${res.issue.number}`;
      console.log(chalk.dim(`  Issue: ${verb}${where} on nemarDatasets/.github`));
      if (res.issue.labelError) {
        console.log(
          chalk.yellow(`  The body was updated but its labels were not: ${res.issue.labelError}`),
        );
      }
      if (res.issue.commentError) {
        console.log(
          chalk.yellow(`  The issue changed but its comment failed: ${res.issue.commentError}`),
        );
      }
    }
    if (res.audit_failed) {
      console.log(
        chalk.yellow(`  Changes applied but the audit row failed to write: ${res.audit_failed}`),
      );
    }
    if (!res.applied && res.issue) {
      console.log(chalk.dim("  Re-run with --apply to perform this change."));
    }
  });

adminCommand.addCommand(importCoverageCommand);

// ============================================================================
// Weekly import summary (#1312, epic #1306 phase 4)
// ============================================================================

const importWeeklyCommand = new Command("import-weekly").description(
  "Read this week's import summary (dry run by default; the cron posts it on Mondays)",
);

/**
 * Render a count that may be unknown.
 *
 * Mirrors `count` in backend/src/services/import-weekly-summary.ts, and exists for
 * the same reason: a zero and an unknown must never look the same. One renderer,
 * not a ternary per field -- a per-field ternary is how one field eventually prints
 * "0" for something nobody measured.
 */
/**
 * Does this week need a person to look?
 *
 * ONE rule, `weeklyAttention` in shared/contract/weekly-attention.ts, which the report's own
 * headline (backend/src/services/import-weekly-summary.ts) also calls. It used to be restated
 * here by hand, and the Neurobagel reasons were added to the headline and not to this exit
 * code: the issue flagged a week and the command exited 0 for it.
 */
function weeklyNeedsAttention(f: NonNullable<WeeklySummaryResponse["facts"]>): boolean {
  return weeklyAttention(f).attention;
}

function weeklyCount(n: number | null | undefined): string {
  // `== null` catches an absent key as well as an explicit null: a backend that ever
  // drops a field must not have it render as "undefined" (or, worse, coalesce to 0).
  return n == null ? chalk.yellow("unknown") : String(n);
}

importWeeklyCommand
  .option("--apply", "Actually file the issue (production only; the cron normally does this)")
  .option("--json", "Output raw JSON instead of the human summary")
  .option("--body", "Also print the issue body exactly as it would be posted")
  .action(async (options: { apply?: boolean; json?: boolean; body?: boolean }) => {
    if (!requireAuth()) return;

    const apply = options.apply === true;
    const spinner = ora("Building the weekly import summary...").start();

    let res: WeeklySummaryResponse;
    try {
      res = await importWeeklySummary({ apply });
      spinner.stop();
    } catch (err) {
      spinner.fail("Weekly import summary failed");
      console.error(chalk.red(errorDetail(err)));
      process.exitCode = 1;
      return;
    }

    const f = res.facts;

    // Exit codes mirror `nemar admin import-coverage`, so one rule works across the
    // family: 2 = could not determine, 1 = determined and not healthy, 0 = healthy.
    // An earlier version set 1 only when a section failed to READ, so a week with
    // auto-import switched off exited 0 -- the exact condition this epic exists to
    // detect, reported as success. Set before the --json return so both output modes
    // agree on the verdict.
    if (f === null)
      process.exitCode = 0; // the gate declined; nothing was measured
    else if (f.errors.length > 0) process.exitCode = 2;
    else if (weeklyNeedsAttention(f)) process.exitCode = 1;
    // Same as import-coverage: 1 and 2 are answers, not failures to report.
    if (process.exitCode !== 0) markReportedExit();

    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (f === null) {
      // Not "every count is unknown" -- nothing was gathered at all. Rendering the
      // table here would be indistinguishable from a totally blind report.
      console.log();
      console.log(chalk.yellow(`Nothing computed: ${res.gateReason}`));
      console.log(chalk.dim("  The report is built once a week; --apply files it."));
      return;
    }

    console.log();
    console.log(chalk.bold(`Import summary ${f.week}`));
    console.log(chalk.dim(`${f.windowStart} to ${f.windowEnd} (UTC)`));
    console.log();
    console.log(
      chalk.cyan(
        `imported_this_week=${weeklyCount(f.importedThisWeek)} total=${weeklyCount(f.importedTotal)} ` +
          `in_scope=${weeklyCount(f.discovered)} not_in_scope=${weeklyCount(f.importedNotInScan)}`,
      ),
    );
    const coverage =
      f.coverageStatus === null
        ? chalk.yellow("unknown")
        : f.coverageStatus === "healthy"
          ? chalk.green(f.coverageStatus)
          : chalk.red(f.coverageStatus);
    console.log(chalk.cyan(`coverage=${coverage} outstanding=${weeklyCount(f.outstanding)}`));
    console.log(
      chalk.cyan(
        `auto_import=${f.autoImportEnabled === null ? chalk.yellow("unknown") : f.autoImportEnabled ? "enabled" : chalk.red("DISABLED")} ` +
          `last_dispatch=${f.dispatchPhrase ?? chalk.yellow("unknown")} ` +
          `dispatch_lost=${f.dispatchLost === null ? chalk.yellow("unknown") : f.dispatchLost}`,
      ),
    );
    console.log(
      chalk.cyan(
        `open_failures=${weeklyCount(f.openFailureTotal)} parked=${f.parked === null ? chalk.yellow("unknown") : f.parked.length} ` +
          `closed_this_week=${weeklyCount(f.issuesClosed)} relabelled=${weeklyCount(f.issuesRelabelled)}`,
      ),
    );

    if (f.failuresByCause !== null) {
      const nonZero = Object.entries(f.failuresByCause).filter(([, n]) => n > 0);
      for (const [label, n] of nonZero) {
        console.log(chalk.dim(`  ${label}: ${n}`));
      }
    }
    if (f.parked !== null && f.parked.length > 0) {
      for (const p of f.parked.slice(0, WEEKLY_CLI_PARKED_ROWS)) {
        console.log(
          chalk.dim(
            `  parked ${p.datasetId} (${p.reason ?? "unknown"}): ${p.parkedDays == null ? "unknown" : `${p.parkedDays} days`}`,
          ),
        );
      }
      const hiddenParked = f.parked.length - WEEKLY_CLI_PARKED_ROWS;
      if (hiddenParked > 0) {
        console.log(chalk.dim(`  ... and ${hiddenParked} more parked`));
      }
    }
    for (const e of f.errors) {
      console.log(`${chalk.yellow("UNKNOWN".padEnd(10))} ${e.stage}: ${e.error}`);
    }
    // Why the exit code is not 0, in the words of the report's own headline (one rule, shared),
    // so a week flagged for a reason this command does not otherwise print is not a bare number.
    const attention = weeklyAttention(f);
    if (attention.attention) {
      console.log(chalk.yellow(`Needs attention: ${attention.problems.join("; ")}.`));
    }

    console.log();
    if (!res.posted && !apply) {
      // NOT `Not posted: ${gateReason}` -- a dry run forces past the gate, so the
      // reason is the literal string "forced", which reads as a refusal that never
      // happened. Nothing was attempted, so say that instead.
      console.log(chalk.dim("Dry run: nothing was filed."));
      console.log(chalk.dim("  Re-run with --apply to file it (production only)."));
    } else if (!res.posted) {
      console.log(chalk.yellow(`Not posted: ${res.gateReason}`));
    } else {
      console.log(
        chalk.green(
          `Posted${res.issue?.number ? ` #${res.issue.number}` : ""}${res.closedPrevious ? `, closed #${res.closedPrevious}` : ""}`,
        ),
      );
    }
    if (options.body) {
      console.log();
      console.log(chalk.dim("--- rendered issue body ---"));
      console.log(res.renderedBody ?? chalk.yellow("(no body was rendered)"));
    }
  });

adminCommand.addCommand(importWeeklyCommand);

// ============================================================================
// Username backfill (ADR 0042, #1253, epic #1250)
//
// 19 live accounts have no username: web/ORCID sign-ups, where the column has
// been NULL by design since migration 0026. An upload request cannot be
// reviewed or approved without one, so this derives it from the account's own
// name (first initial plus family name) and, for a row it finishes, sends the
// one verify-your-email message that lets the person sign in and use it.
//
// Run `nemar admin backfill-names` FIRST: this reads the names that one fills.
// ============================================================================

const backfillUsernamesCommand = new Command("backfill-usernames").description(
  "Give username-less accounts a username from their name (dry run by default)",
);

backfillUsernamesCommand
  .option("--apply", "Write the usernames and send verification messages")
  .option("--limit <n>", "Users per batch (server clamps to [1,100])", "25")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (options: { apply?: boolean; limit?: string; json?: boolean }) => {
    if (!requireAuth()) return;

    const limit = Number.parseInt(options.limit ?? "25", 10) || 25;
    const apply = options.apply === true;
    const spinner = ora(
      apply ? "Assigning usernames..." : "Checking which accounts need a username...",
    ).start();

    let res: BackfillUsernamesResponse;
    try {
      res = await backfillUsernames({ apply, limit });
      spinner.stop();
    } catch (err) {
      spinner.fail("Username backfill failed");
      console.error(chalk.red(errorDetail(err)));
      process.exit(1);
      return;
    }

    // Computed before the --json branch returns, so a scripted caller reading
    // the exit code sees the same verdict as someone reading the summary below.
    //
    // A lookup failure or a conflict leaves the row a candidate for the next
    // run, an undelivered verify message leaves an account unable to finish
    // onboarding, and an unknown remainder means the batch's own bookkeeping
    // failed. None is fatal, but a caller must not read any of them as a clean
    // sweep -- an unreported verify failure is exactly how "one message per
    // account" quietly became "none" for the accounts it failed on.
    //
    // `exhausted` is in the list because it used to BE a conflict: splitting it
    // out (#1268 review) must not quietly turn a run that finished nothing into
    // a clean exit. It is the stronger case of the two -- a conflict clears
    // itself on the next run and a saturated base never does.
    if (
      res.lookup_failed > 0 ||
      res.conflict > 0 ||
      (res.exhausted ?? 0) > 0 ||
      (res.write_failed ?? 0) > 0 ||
      (res.verify_failed ?? 0) > 0 ||
      (res.verify_rate_limited ?? 0) > 0 ||
      res.remaining === null
    ) {
      process.exitCode = 1;
    }

    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    console.log();
    if (!res.apply) {
      console.log(chalk.yellow("DRY RUN — nothing was written. Re-run with --apply."));
    }
    console.log(
      chalk.cyan(
        `scanned=${res.scanned} ${res.apply ? "assigned" : "would_assign"}=${
          res.apply ? res.assigned : res.would_assign
        } single_name=${res.single_name} no_name=${res.no_name} lookup_failed=${
          res.lookup_failed
        } conflict=${res.conflict} exhausted=${res.exhausted ?? 0} write_failed=${
          res.write_failed ?? 0
        } verify_sent=${res.verify_sent} verify_failed=${
          res.verify_failed ?? 0
        } verify_rate_limited=${res.verify_rate_limited ?? 0} remaining=${
          res.remaining ?? "unknown"
        }`,
      ),
    );
    for (const r of res.results) {
      const who = `id ${r.id} <${r.email}>`;
      const name = [r.given_name, r.family_name].filter(Boolean).join(" ");
      if (r.outcome === "assigned" || r.outcome === "would_assign") {
        const verb =
          r.outcome === "assigned" ? chalk.green("assigned  ") : chalk.cyan("would give");
        // The verify outcome is printed for an assigned row because
        // `skipped_fence` is the NORMAL result outside production and reads as
        // a failure if it is not named (AGENTS.md's non-production email fence).
        const mail = r.outcome === "assigned" ? `  [verify: ${r.verify}]` : "";
        console.log(`  ${verb} ${who}: ${chalk.cyan(r.username ?? "?")}  (${name})${mail}`);
      } else if (r.outcome === "single_name") {
        console.log(
          `  ${chalk.yellow("one name  ")} ${who}: only "${name}" on record; pick a username by hand`,
        );
      } else if (r.outcome === "no_name") {
        console.log(
          `  ${chalk.yellow("no name   ")} ${who}: run 'nemar admin backfill-names --apply' first`,
        );
      } else if (r.outcome === "conflict") {
        console.log(`  ${chalk.yellow("conflict  ")} ${who}: ${r.error}`);
      } else if (r.outcome === "exhausted") {
        // Deliberately not folded in with `conflict` above: re-running the
        // sweep fixes a conflict and can never fix this one.
        console.log(`  ${chalk.yellow("exhausted ")} ${who}: ${r.error}; pick a username by hand`);
      } else if (r.outcome === "write_failed") {
        // A conflict is somebody else holding the handle; this is the write
        // itself failing, so the batch is retryable but the thing to look at
        // is the database.
        console.log(`  ${chalk.red("write     ")} ${who}: ${r.error}; retry the batch`);
      } else {
        console.log(`  ${chalk.red("error     ")} ${who}: ${r.error}`);
      }
    }
    // The retry pass, listed separately: these accounts already have a
    // username, so they are not part of the assignment plan above -- what is
    // being reported is a message that never landed.
    for (const r of res.verify_retries ?? []) {
      const label =
        r.verify === "sent"
          ? chalk.green("re-sent  ")
          : r.verify === "not_attempted"
            ? chalk.cyan("would send")
            : chalk.yellow(`verify ${r.verify}`);
      console.log(`  ${label} id ${r.id} <${r.email}>`);
    }
    if (res.warning) {
      console.log(chalk.yellow(`  Warning: ${res.warning}`));
    }
    if (res.single_name > 0 || res.no_name > 0) {
      console.log();
      console.log(
        chalk.dim(
          "Accounts with one name or none are listed, never guessed at: a username derived from an email address is a handle the person never chose.",
        ),
      );
    }
  });

adminCommand.addCommand(backfillUsernamesCommand);

// ============================================================================
// Duplicate accounts (#1254, epic #1250; ADR 0043)
// ============================================================================

/**
 * `nemar admin duplicates` — live accounts sharing an ORCID iD, an email
 * address, or a GitHub handle, plus the `--clear` half that un-flags a row
 * once its collision is gone.
 *
 * A TOP-LEVEL COMMAND rather than a flag on `nemar admin users`: the listing
 * is one row per account and this is one row per GROUP, so folding it in would
 * mean two incompatible table shapes behind one command. It also reports on
 * something the listing has no column for -- `identity_conflict`, the flag
 * migration 0077 uses to keep a duplicate out of the unique indexes without
 * deleting anybody.
 *
 * This command NEVER merges or deletes. It says which rows collide and which
 * one holds the identifier; resolving it is the person's own Settings change,
 * or an explicit account deletion by an admin.
 */
const duplicatesCommand = new Command("duplicates").description(
  "Report live accounts sharing an ORCID iD, email, or GitHub handle",
);

/** One line per account inside a group. */
function printDuplicateAccount(account: DuplicateGroup["accounts"][number]): void {
  const who = account.username ?? chalk.dim("(no username)");
  const marks: string[] = [];
  if (account.canonical) marks.push(chalk.green("canonical"));
  if (account.identity_conflict === 1) marks.push(chalk.yellow("flagged"));
  if (account.has_oauth_identity) marks.push(chalk.dim("orcid-login"));
  const suffix = marks.length > 0 ? `  [${marks.join(", ")}]` : "";
  const meta = `created ${account.created_at}  datasets=${account.dataset_count}`;
  console.log(
    `    id ${String(account.id).padEnd(5)} ${who}  <${account.email}>  ${meta}${suffix}`,
  );
}

duplicatesCommand
  .option("--json", "Output raw JSON instead of the human report")
  .option(
    "--clear <id>",
    "Clear one account's identity-conflict flag (refuses while the collision remains)",
  )
  .action(async (options: { json?: boolean; clear?: string }) => {
    if (!requireAuth()) return;

    if (options.clear !== undefined) {
      const id = Number.parseInt(options.clear, 10);
      if (!Number.isInteger(id) || id <= 0) {
        console.error(chalk.red(`Invalid user id: ${options.clear}`));
        process.exit(1);
        return;
      }
      const spinner = ora(`Clearing identity-conflict flag on user ${id}...`).start();
      try {
        const res = await clearIdentityConflict(id);
        spinner.stop();
        if (options.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(
          res.cleared
            ? chalk.green(`Cleared the identity-conflict flag on user ${id}.`)
            : chalk.dim(`User ${id} was not flagged; nothing to clear.`),
        );
      } catch (err) {
        // A 409 here is the normal answer, not a crash: the collision is
        // still there. Print the API's own sentence, which names what to fix.
        spinner.fail(
          err instanceof ApiError && err.statusCode === 409
            ? "Still colliding; flag not cleared"
            : "Failed to clear the identity-conflict flag",
        );
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }
      return;
    }

    const spinner = ora("Checking for duplicate accounts...").start();
    let report: Awaited<ReturnType<typeof getUserDuplicates>>;
    try {
      report = await getUserDuplicates();
      spinner.stop();
    } catch (err) {
      spinner.fail("Duplicate report failed");
      console.error(chalk.red(errorDetail(err)));
      process.exit(1);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log();
    if (report.groups.length === 0) {
      console.log(chalk.green("No duplicate accounts."));
      // A flag with no group behind it is a resolved collision waiting to be
      // cleared, and it is invisible in the groups list by definition — so it
      // gets said out loud rather than left to be inferred from a zero.
      if (report.flagged_count > 0) {
        console.log(
          chalk.yellow(
            `${report.flagged_count} account(s) still carry an identity-conflict flag with no remaining collision.`,
          ),
        );
        console.log(chalk.dim("  Clear each with 'nemar admin duplicates --clear <id>'."));
      }
      return;
    }

    console.log(
      chalk.cyan(
        `${report.group_count} duplicate group(s); ${report.flagged_count} account(s) flagged`,
      ),
    );
    for (const group of report.groups) {
      console.log();
      console.log(`  ${chalk.bold(group.kind)}  ${group.value}`);
      for (const account of group.accounts) printDuplicateAccount(account);
    }
    console.log();
    console.log(
      chalk.dim(
        "The fix is self-service on the surviving account: change its email or GitHub username, or unlink/re-link its ORCID iD, in Settings on nemar.org. Merging two accounts is manual.",
      ),
    );
    // Exit non-zero so a scheduled run surfaces a duplicate instead of
    // scrolling past as a successful command.
    process.exitCode = 1;
  });

adminCommand.addCommand(duplicatesCommand);

// ============================================================================
// Neurobagel federation artifacts (epic #1586 phase 4, ADR 0084)
//
// `regenerate` is a DRY RUN unless --execute is given, and the server refuses
// --execute unless the writer is enabled (NEUROBAGEL_WRITER_ENABLED=1). `status`
// is a read: what is eligible, written, stale, and waiting on a person. A null
// count in either means "unknown", and is printed as unknown, never as zero.
// ============================================================================

const neurobagelCommand = new Command("neurobagel").description(
  "Neurobagel federation artifacts: regenerate and inspect the private store (epic #1586)",
);

const neurobagelNum = (n: number | null): string =>
  n === null ? chalk.yellow("unknown") : String(n);

const neurobagelVerdict = (v: NeurobagelVerification["overall"]): string =>
  v === "healthy"
    ? chalk.green(v)
    : v === "alarm"
      ? chalk.red(v)
      : v === "unknown"
        ? chalk.yellow(v)
        : chalk.dim(v);

/**
 * The verification sweep's verdicts, one line each. `unchecked` (not configured here) and
 * `unknown` (could not be answered) are printed as themselves: neither is healthy.
 */
function printNeurobagelVerification(v: NeurobagelVerification): void {
  console.log(
    `${chalk.bold("Verification")}  ${neurobagelVerdict(v.overall)}  ${v.at} (${v.trigger})${v.failed ? chalk.red(`  the sweep itself failed: ${v.error ?? "no reason recorded"}`) : ""}`,
  );
  for (const name of NEUROBAGEL_CHECKS) {
    const c = v.checks[name];
    console.log(`  ${name.padEnd(13)}${neurobagelVerdict(c.verdict)}  ${c.reason}`);
  }
  for (const w of v.warnings) console.log(chalk.yellow(`  warning: ${w}`));
}

function printNeurobagelRun(res: NeurobagelRunResult): void {
  console.log();
  if (res.dry_run) {
    console.log(chalk.yellow("DRY RUN: nothing was written. Re-run with --execute to write."));
  }
  if (res.status !== "ok") {
    const why =
      res.status === "disabled"
        ? "the writer is disabled (NEUROBAGEL_WRITER_ENABLED is not 1)"
        : res.status === "store_unconfigured"
          ? "no NEUROBAGEL bucket is bound"
          : (res.error ?? "the run failed");
    console.log(chalk.red(`status=${res.status}: ${why}`));
  }
  console.log(
    chalk.cyan(
      `eligible=${neurobagelNum(res.eligible)} examined=${res.examined} limit=${res.limit} unexamined=${res.unexamined} removed=${res.removed.length} removals_pending=${res.removals_pending} index_entries=${neurobagelNum(res.index.entries)} index_written=${res.index.written} index_patched=${res.index.patched ?? 0} anonymity_findings=${res.anonymity_findings} ops=${res.ops.spent}/${res.ops.budget}`,
    ),
  );
  for (const r of res.results) {
    switch (r.outcome) {
      case "written":
        console.log(
          `  ${chalk.green("written    ")} ${r.id}${r.flags.length > 0 ? `  needs review: ${r.flags.join(", ")}` : ""}`,
        );
        break;
      case "would_write":
        console.log(`  ${chalk.cyan("would write")} ${r.id}  (${r.reason})`);
        break;
      case "unchanged":
        console.log(`  ${chalk.dim("unchanged  ")} ${r.id}`);
        break;
      case "would_remove":
        console.log(`  ${chalk.cyan("would remove")} ${r.id}`);
        break;
      case "removed":
        console.log(`  ${chalk.green("removed    ")} ${r.id}`);
        break;
      case "refused":
        // A refusal is a decision not to publish; its code says why. An anonymity-class
        // one prints no detail by design.
        console.log(
          `  ${chalk.red("refused    ")} ${r.id}  ${r.code}${r.detail ? `: ${r.detail}` : ""}`,
        );
        break;
      case "error":
        console.log(`  ${chalk.red("error      ")} ${r.id}  ${r.error}`);
        break;
    }
  }
  if (res.stopped === "ops_budget") {
    console.log(
      chalk.yellow(
        `  the run spent its operation budget (${res.ops.spent} of ${res.ops.budget}, ${res.ops.reserved} of it held back to finish) with ${res.unexamined} dataset(s) not yet examined: run the same command again to continue`,
      ),
    );
  } else if (res.unexamined > 0 && res.stopped === null) {
    console.log(
      chalk.yellow(
        `  ${res.unexamined} dataset(s) are still waiting beyond this call's limit: run the same command again to continue`,
      ),
    );
  }
  if (res.index.contended) {
    console.log(
      chalk.red("  the index was replaced by another run during this one; re-run to settle it"),
    );
  }
  for (const problem of res.index.problems ?? []) {
    console.log(chalk.red(`  index not written: ${problem}`));
  }
  for (const w of res.warnings) console.log(chalk.yellow(`  warning: ${w}`));
  if (res.anonymity_findings > 0) {
    console.log(
      chalk.red(
        `  ${res.anonymity_findings} dataset(s) were refused because their data says anonymous. They are in the audit log (neurobagel_anonymity_finding); nothing was filed or mailed.`,
      ),
    );
  }
}

neurobagelCommand
  .command("regenerate")
  .description(
    "Examine datasets and write what changed to the Neurobagel artifact store (dry run unless --execute)",
  )
  .option("--execute", "Write to the store (without it, only report what would change)")
  .option("--dataset <ids...>", "Examine exactly these dataset ids instead of the next ones due")
  .option(
    "--limit <n>",
    `Datasets to examine (default: the server's per-tick bound, at most ${NEUROBAGEL_REGENERATE_MAX}); run again to continue`,
  )
  .option("--force", "Rewrite even when the fingerprint matches")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (options: {
      execute?: boolean;
      dataset?: string[];
      limit?: string;
      force?: boolean;
      json?: boolean;
    }) => {
      if (!requireAuth()) return;

      // A whole positive number, exactly: parseInt would read "1.5" as 1 and "5x" as 5.
      const limit =
        options.limit === undefined
          ? undefined
          : /^[1-9][0-9]*$/.test(options.limit)
            ? Number(options.limit)
            : Number.NaN;
      if (limit !== undefined && !Number.isInteger(limit)) {
        console.error(chalk.red("--limit must be a positive whole number"));
        process.exit(1);
        return;
      }
      // Refused here, before any request: the server holds the same ceiling, and a call
      // that asks for more would only be told so after the round trip.
      if (limit !== undefined && limit > NEUROBAGEL_REGENERATE_MAX) {
        console.error(
          chalk.red(
            `--limit is at most ${NEUROBAGEL_REGENERATE_MAX} per call (each call runs inside one request); run the command again to continue`,
          ),
        );
        process.exit(1);
        return;
      }
      const execute = options.execute === true;
      const spinner = ora(
        execute ? "Regenerating Neurobagel artifacts..." : "Checking what would change...",
      ).start();

      let res: NeurobagelRunResult;
      try {
        res = await neurobagelRegenerate({
          ...(execute ? { execute: true } : {}),
          ...(options.dataset && options.dataset.length > 0 ? { datasets: options.dataset } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(options.force ? { force: true } : {}),
        });
        spinner.stop();
      } catch (err) {
        handleCommandError(err, spinner, "Neurobagel regenerate failed", {
          409: "Set NEUROBAGEL_WRITER_ENABLED=1 (and bind the bucket) to write. A dry run needs neither the switch nor --execute.",
        });
        process.exit(1);
        return;
      }

      if (options.json) console.log(JSON.stringify(res, null, 2));
      else printNeurobagelRun(res);

      // Non-zero means the RUN was partial or uncertain, or that something needs a
      // person NOW: an error, a failed or contended index, or an anonymity-class finding.
      const errors = res.results.some((r) => r.outcome === "error");
      if (
        res.status !== "ok" ||
        errors ||
        res.index.contended ||
        res.stopped === "index_patch" ||
        (res.index.problems?.length ?? 0) > 0 ||
        res.anonymity_findings > 0
      ) {
        process.exitCode = 1;
      }
    },
  );

neurobagelCommand
  .command("status")
  .description(
    "What is eligible, written, stale and waiting on a person in the Neurobagel store, and the latest verification (exit 0 healthy, 1 alarm, 2 unknown)",
  )
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (options: { json?: boolean }) => {
    if (!requireAuth()) return;

    const spinner = ora("Reading the Neurobagel store...").start();
    let s: NeurobagelStatus;
    try {
      s = await getNeurobagelStatus();
      spinner.stop();
    } catch (err) {
      handleCommandError(err, spinner, "Neurobagel status failed");
      process.exit(1);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }

    const mode =
      s.writer.mode === "enabled"
        ? chalk.green("enabled")
        : s.writer.mode === "disabled"
          ? chalk.yellow("disabled (NEUROBAGEL_WRITER_ENABLED is not 1)")
          : chalk.red("store_unconfigured (no NEUROBAGEL bucket is bound)");
    console.log();
    console.log(`${chalk.bold("Writer")}        ${mode}`);
    console.log(
      `${chalk.bold("Read route")}    ${s.read_route.token_configured ? chalk.green("token configured") : chalk.yellow("no NEUROBAGEL_READ_TOKEN: the route answers 404")}`,
    );
    console.log(
      `${chalk.bold("Per tick")}      ${s.limits.reconcile_max} datasets (hard limit ${s.limits.hard_max})`,
    );
    console.log();
    const c = s.counts;
    console.log(
      `${chalk.bold("Datasets")}      eligible=${neurobagelNum(c.eligible)} written=${neurobagelNum(c.written)} missing=${neurobagelNum(c.missing)} stale=${neurobagelNum(c.stale)} incomplete=${neurobagelNum(c.incomplete)} waiting to be removed=${neurobagelNum(c.residue)}`,
    );
    console.log(
      `${chalk.bold("Store")}         objects=${neurobagelNum(s.store.objects)} bytes=${neurobagelNum(s.store.total_bytes)}${s.store.over_loader_cap ? chalk.red("  OVER the loader's total cap") : ""}${(s.store.unexpected_objects ?? 0) > 0 ? chalk.yellow(`  ${s.store.unexpected_objects} object(s) that are not the writer's`) : ""}`,
    );
    const matches =
      s.index.matches_store === null
        ? chalk.yellow("unknown")
        : s.index.matches_store
          ? chalk.green("matches the store")
          : chalk.yellow(
              "differs from what the store and eligibility imply (the next run settles it)",
            );
    console.log(
      `${chalk.bold("Index")}         ${s.index.present === null ? chalk.yellow("unknown") : s.index.present ? `${neurobagelNum(s.index.entries)} entries, generated ${s.index.generated_at ?? "?"}` : chalk.dim("not written yet")}  ${matches}`,
    );
    const lr = s.last_reconcile;
    console.log(
      `${chalk.bold("Last reconcile")} ${lr ? `${lr.at} (${JSON.stringify(lr.summary)})` : chalk.dim("none recorded")}`,
    );
    console.log(
      `${chalk.bold("Anonymity")}     ${s.anonymity_findings === null ? chalk.yellow("unknown") : s.anonymity_findings === 0 ? "no findings" : chalk.red(`${s.anonymity_findings} finding(s): see the audit log (neurobagel_anonymity_finding); ids are not shown here`)}`,
    );
    // One rule, shared with its tests: a record older than 36 hours, or none while the writer is
    // on, is unknown. While the writer is off none is expected, and the command stays quiet.
    const verification = neurobagelVerificationState({
      verification: s.verification,
      writerMode: s.writer.mode,
      now: new Date(),
    });
    if (s.verification) printNeurobagelVerification(s.verification);
    if (verification.note) {
      console.log(
        `${chalk.bold("Verification")}  ${neurobagelVerdict(verification.verdict)}  ${verification.note}`,
      );
    } else if (!s.verification) {
      console.log(
        `${chalk.bold("Verification")}  ${chalk.dim("none recorded; the writer is off, so none is expected")}`,
      );
    }
    if (s.needs_review.length > 0) {
      console.log();
      console.log(chalk.bold(`Needs review (${s.needs_review.length})`));
      for (const n of s.needs_review) {
        console.log(
          `  ${n.id}  ${n.source === "refusal" ? chalk.red(`refused: ${n.code}${n.since ? ` (last confirmed ${n.since})` : ""}`) : chalk.yellow((n.flags ?? []).join(", "))}`,
        );
      }
    }
    for (const w of s.warnings) console.log(chalk.yellow(`warning: ${w}`));

    // The family's exit codes, the same as `verify`: 0 healthy (or nothing to check), 1 an alarm
    // (a writer on with no bucket, a finding, an unreadable catalog, an alarming verification),
    // 2 could not be determined (no record while the writer is on, a stale record, an unknown).
    const alarming =
      s.writer.mode === "store_unconfigured" ||
      (s.anonymity_findings ?? 0) > 0 ||
      s.counts.eligible === null ||
      verification.verdict === "alarm";
    process.exitCode = alarming ? 1 : neurobagelVerdictExitCode(verification.verdict);
  })
  .addHelpText(
    "after",
    "\nExit codes: 0 healthy or nothing to check, 1 an alarm, 2 could not be determined (no verification recorded while the writer is on, a record over 36 hours old, or an unknown verdict). The same as `verify`.",
  );

neurobagelCommand
  .command("verify")
  .description(
    "Run the verification sweep now: the store against eligibility, the node, registration and upstream drift (reports only; exit 0 healthy, 1 alarm, 2 unknown)",
  )
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (options: { json?: boolean }) => {
    if (!requireAuth()) return;

    const spinner = ora("Verifying the Neurobagel federation...").start();
    let res: NeurobagelVerifyResult;
    try {
      res = await neurobagelVerify();
      spinner.stop();
    } catch (err) {
      handleCommandError(err, spinner, "Neurobagel verify failed");
      process.exit(1);
      return;
    }

    if (options.json) console.log(JSON.stringify(res, null, 2));
    else {
      console.log();
      printNeurobagelVerification(res);
      if (!res.heartbeat_written) {
        console.log(chalk.yellow("The heartbeat could not be written: this run is not recorded."));
      }
    }
    // The family's exit codes (import-coverage, import-weekly), the same as `status`: 0 healthy or
    // nothing to check, 1 an alarm, 2 could not be determined. An unchecked check never makes a
    // run healthy, but it is not a failure either.
    process.exitCode = neurobagelVerdictExitCode(res.overall);
  })
  .addHelpText(
    "after",
    "\nExit codes: 0 healthy or nothing to check, 1 an alarm, 2 could not be determined. The same as `status`.",
  );

adminCommand.addCommand(neurobagelCommand);
adminCommand.addCommand(prReviewsCommand);
