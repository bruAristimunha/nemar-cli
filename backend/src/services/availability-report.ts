/**
 * Per-dataset availability report (`.nemar/availability-report.json`) — epic
 * #999 Phase 1, issue #1000.
 *
 * Records how much of a dataset's declared version-manifest content is
 * actually present in S3, and exactly which files are missing (+ why),
 * committed to the repo's `main` branch via the admin Contents-API path
 * (mirrors how enrichment commits `.nemar/metadata.json`). Reuses the
 * completeness math from services/import-integrity.ts
 * (verifyDatasetVersionS3) instead of recomputing it.
 */

import type { Bindings } from "../types/bindings.js";
import { datasetHasVersionSql } from "./archive-retry.js";
import { isNonProductionEnv } from "./environment.js";
import { exemplarOrFragment } from "./exemplar.js";
import { getDatasetsToken } from "./github-auth.js";
import { branchExists, createOrUpdateFile } from "./github/contents.js";
import {
  type DatasetVersionIntegrityResult,
  type ExpectedManifestFile,
  parseManifestFiles,
  verifyDatasetVersionS3,
  versionReadS3Options,
} from "./import-integrity.js";
import { errorMessage } from "./repo-metadata.js";
import { getManifest } from "./s3.js";

/** One manifest PATH whose declared annex key is not present in S3 at its
 *  declared size. Entries are built by walking manifest PATHS (not annex
 *  keys): git-annex is content-addressed, so two distinct paths (repeated
 *  calibration/empty-room/identical-stimulus files are common in BIDS) can
 *  share one key -- keying off `key` alone would collapse two genuinely
 *  missing paths into a single (wrong, duplicated) entry. */
export interface AvailabilityReportMissingEntry {
  path: string;
  key: string;
  declared_size: number;
  reason: "zero_byte" | "absent";
}

export interface AvailabilityReportCompleteness {
  files_present: number;
  files_declared: number;
  bytes_present: number;
  bytes_declared: number;
  /** bytes_present / bytes_declared, or null whenever bytes_declared is not
   *  > 0 (a 0-declared-bytes dataset, with or without a manifest -- avoids a
   *  0/0 NaN either way). */
  pct_bytes: number | null;
}

export interface AvailabilityReport {
  dataset_id: string;
  version: string | null;
  generated_at: string;
  source: { type: string; id: string } | null;
  complete: boolean;
  completeness: AvailabilityReportCompleteness;
  missing: AvailabilityReportMissingEntry[];
  blocklist_reason?: string;
}

export interface BuildAvailabilityReportArgs {
  datasetId: string;
  version: string | null;
  source: { type: string; id: string } | null;
  integrity: DatasetVersionIntegrityResult;
  manifest: Record<string, ExpectedManifestFile> | null;
  generatedAt: string;
  blocklistReason?: string | null;
}

/**
 * Pure builder: turns an already-computed integrity result + the manifest it
 * was computed against into the on-disk report shape. Deterministic --
 * `generatedAt` is injected by the caller, never read from the clock here.
 *
 * When `integrity.version` is null (no manifest could be resolved/parsed --
 * see verifyDatasetVersionS3's own conservative contract) OR `manifest` is
 * null, completeness is genuinely unknown, not a bogus zero: returns a
 * minimal report with `version: null`, `complete: false`, `missing: []`, and
 * whatever raw present/declared counts `integrity` still carries (both stay
 * 0 when there was never a manifest to compare against at all).
 */
export function buildAvailabilityReport(args: BuildAvailabilityReportArgs): AvailabilityReport {
  const { datasetId, version, source, integrity, manifest, generatedAt, blocklistReason } = args;
  const blocklistFields = blocklistReason ? { blocklist_reason: blocklistReason } : {};

  if (integrity.version === null || manifest === null) {
    return {
      dataset_id: datasetId,
      version: null,
      generated_at: generatedAt,
      source,
      complete: false,
      completeness: {
        files_present: integrity.presentCount,
        files_declared: integrity.expectedCount,
        bytes_present: integrity.bytesPresent,
        bytes_declared: integrity.declaredBytes,
        pct_bytes: null,
      },
      missing: [],
      ...blocklistFields,
    };
  }

  // Walk manifest PATHS (not integrity.missingKeys) so a key shared by
  // multiple paths -- git-annex is content-addressed, so repeated
  // calibration/empty-room/identical-stimulus files commonly share one key
  // -- produces one entry per genuinely-missing path instead of collapsing
  // them all onto whichever path last won a key->path lookup.
  const missingKeySet = new Set(integrity.missingKeys);
  const zeroByteKeys = new Set(integrity.zeroByteKeys);
  const missing: AvailabilityReportMissingEntry[] = [];
  for (const [path, file] of Object.entries(manifest)) {
    if (!missingKeySet.has(file.key)) continue;
    missing.push({
      path,
      key: file.key,
      declared_size: file.size,
      reason: zeroByteKeys.has(file.key) ? "zero_byte" : "absent",
    });
  }
  missing.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    dataset_id: datasetId,
    version,
    generated_at: generatedAt,
    source,
    complete: integrity.complete,
    completeness: {
      files_present: integrity.presentCount,
      files_declared: integrity.expectedCount,
      bytes_present: integrity.bytesPresent,
      bytes_declared: integrity.declaredBytes,
      pct_bytes:
        integrity.declaredBytes > 0 ? integrity.bytesPresent / integrity.declaredBytes : null,
    },
    missing,
    ...blocklistFields,
  };
}

/** The branch the report is committed to, and the one whose existence is
 *  checked first. One constant, so the guard and the write cannot name
 *  different branches. */
const REPORT_BRANCH = "main";

/**
 * Thrown by {@link writeAvailabilityReport} for failures the admin route maps
 * to a specific HTTP status instead of a generic 500:
 *   - 404: no such dataset row;
 *   - 400: no GitHub repository, or a malformed `github_repo`;
 *   - 409: the repository has no `main` branch (empty, or never pushed), so the
 *     report is refused rather than creating `main` as a root commit (#1643);
 *   - 500: a failure that is not the dataset's own state, wrapped with its
 *     `cause`: GitHub auth, or a branch lookup that failed or could not be
 *     trusted (including a repository not visible to NEMAR).
 * Mirrors DatasetReindexError (services/dataset-reindex.ts).
 */
export class AvailabilityReportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 500,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AvailabilityReportError";
  }
}

/**
 * Where the report is committed, or the reason it must not be. Runs before any
 * S3 work on the write path: it is a handful of cheap checks, and the S3 pass
 * is the most expensive thing a sweep row does.
 */
async function resolveReportTarget(
  env: Bindings,
  githubRepo: string | null,
  datasetId: string,
): Promise<{ repoName: string; pat: string }> {
  if (!githubRepo) {
    throw new AvailabilityReportError(`Dataset has no GitHub repository: ${datasetId}`, 400);
  }
  const repoName = githubRepo.split("/")[1];
  if (!repoName) {
    throw new AvailabilityReportError(`Invalid github_repo format: ${githubRepo}`, 400);
  }
  let pat: string;
  try {
    pat = await getDatasetsToken(env);
  } catch (err) {
    throw new AvailabilityReportError(`Failed to resolve GitHub auth: ${errorMessage(err)}`, 500, {
      cause: err,
    });
  }
  // Never create `main` (#1643). On a repository nothing has been pushed to
  // yet (a dataset created but still uploading) the Contents API PUT makes
  // `main` an unrelated ROOT commit. The depositor's first push is then
  // rejected as non-fast-forward, and the git-annex adjusted branch cannot be
  // auto-rebased onto the unrelated root; the upload only recovered through a
  // manual merge.
  //
  // `branchExists` answers false only for a branch that is absent from a
  // repository NEMAR can see, so the 409 below can say exactly that. Every
  // other outcome (a repository not visible to NEMAR, a rate limit, a 5xx, a
  // body that is not a ref) throws, and is reported as a 500 because it is not
  // a fact about the dataset.
  let hasReportBranch: boolean;
  try {
    hasReportBranch = await branchExists(repoName, REPORT_BRANCH, pat);
  } catch (err) {
    throw new AvailabilityReportError(
      `Could not check for ${REPORT_BRANCH} in ${githubRepo}: ${errorMessage(err)}. Nothing was written`,
      500,
      { cause: err },
    );
  }
  if (!hasReportBranch) {
    throw new AvailabilityReportError(
      `${githubRepo} has no ${REPORT_BRANCH} branch (empty repository, or ${REPORT_BRANCH} was never pushed). Nothing was written; the availability report never creates ${REPORT_BRANCH}`,
      409,
    );
  }
  return { repoName, pat };
}

export interface WriteAvailabilityReportOptions {
  /** When true, compute and return the report without committing it. */
  dryRun?: boolean;
  /** Injected timestamp for deterministic tests; defaults to now. */
  generatedAt?: string;
}

/**
 * Resolve a dataset's current availability report and, unless `dryRun`,
 * commit it to `.nemar/availability-report.json` on the repo's `main`
 * branch via the admin Contents-API path (the same last-writer-wins
 * `createOrUpdateFile` enrichment uses for `.nemar/metadata.json`).
 *
 * Throws {@link AvailabilityReportError} for the dataset-not-found case (and,
 * on the write path only, a missing/invalid github_repo, a GitHub auth
 * failure, or a repository with no `main` branch) so callers can map them to
 * specific HTTP statuses; a dry-run never needs a repo at all, so those checks
 * are skipped when `dryRun` is true.
 *
 * On the write path the GitHub checks run BEFORE the S3 work. Verifying a
 * dataset is a paginated LIST plus a manifest walk, the dominant cost of a
 * sweep row, so a row the write is going to refuse anyway must not pay it.
 */
export async function writeAvailabilityReport(
  env: Bindings,
  datasetId: string,
  opts?: WriteAvailabilityReportOptions,
): Promise<AvailabilityReport> {
  const db = env.DB;

  const dataset = await db
    .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null }>();
  if (!dataset) {
    throw new AvailabilityReportError(`Dataset not found: ${datasetId}`, 404);
  }

  // Write path only: resolve the target and refuse BEFORE the S3 work below.
  const target = opts?.dryRun
    ? null
    : await resolveReportTarget(env, dataset.github_repo, datasetId);

  // import_jobs carries OpenNeuro provenance for imported (on*) datasets
  // only; a native NEMAR submission has no row here, so `source` stays null.
  const importJob = await db
    .prepare("SELECT source, source_id, blocklist_reason FROM import_jobs WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ source: string; source_id: string; blocklist_reason: string | null }>();

  const integrity = await verifyDatasetVersionS3(env, datasetId);

  // Re-fetch + re-parse the same manifest verifyDatasetVersionS3 already
  // resolved (integrity.version) so the path <-> key mapping is available for
  // buildAvailabilityReport -- verifyDatasetVersionS3 only returns the
  // comparison result, not the parsed files map itself.
  let manifest: Record<string, ExpectedManifestFile> | null = null;
  if (integrity.version) {
    const manifestJson = await getManifest(versionReadS3Options(env), datasetId, integrity.version);
    if (manifestJson) {
      manifest = parseManifestFiles(manifestJson);
    }
  }

  const generatedAt = opts?.generatedAt ?? new Date().toISOString();
  const report = buildAvailabilityReport({
    datasetId,
    version: integrity.version,
    source: importJob ? { type: importJob.source, id: importJob.source_id } : null,
    integrity,
    manifest,
    generatedAt,
    blocklistReason: importJob?.blocklist_reason ?? null,
  });

  if (target) {
    await createOrUpdateFile(
      target.repoName,
      ".nemar/availability-report.json",
      JSON.stringify(report, null, 2),
      "Update NEMAR availability report",
      target.pat,
      REPORT_BRANCH,
    );
  }

  return report;
}

// ============================================================================
// Availability-report backfill sweep SQL (epic #999 phase 2, #1001)
// ============================================================================
//
// Exported so routes/admin/datasets-lifecycle.ts's POST
// /admin/datasets/availability-report-sweep handler and its test both build
// from the SAME query text instead of a hand-copied duplicate that can
// silently drift (the pattern ARCHIVE_RETRY_SWEEP_QUERY and
// NON_PROD_SANDBOX_CLEANUP_QUERY already use). The candidate SELECT and the
// `remaining` COUNT must stay scoped identically -- `remaining` is a promise
// that "0 means the sweep is done" -- so both are derived from the one
// `availabilityReportSweepWhere` builder rather than two copies of the WHERE
// clause that could drift apart.

/** Base candidacy predicate: a dataset with a GitHub repository
 *  (`github_repo IS NOT NULL`; catalog `ds*` rows have none), not sandbox, with
 *  a version, and not yet stamped. The curated exemplar fleet
 *  (`is_exemplar = 1`) is inserted `is_sandbox = 1` but is permanent, not
 *  churning (AGENTS.md's dataset ID bands, "never" cleaned), so
 *  `exemplarOrFragment()` carves it back into candidacy (issue #1168), matching
 *  the visibility predicates in dataset-search.ts / catalog.ts.
 *
 *  A dataset with no version yet (no version DOI, no dataset_versions row) is
 *  not a candidate: its report has nothing to compare against, and its
 *  repository may still be empty mid-upload. A never-versioned row would hold
 *  one of the LIMIT slots on every pass (ORDER BY dataset_id), as it would in
 *  ARCHIVE_RETRY_SWEEP_QUERY. This predicate removes only that case.
 *
 *  KNOWN LIMITATION (tracked as a follow-up to #1643): a row the write REFUSES
 *  (the repository has no `main`, or is not visible to NEMAR) stays a candidate
 *  and unstamped, so it is retried on every pass and holds a LIMIT slot, and
 *  because candidates are ordered by dataset_id it starves the valid rows behind
 *  it. The version rule is `datasetHasVersionSql`, which that query also builds
 *  from. */
const AVAILABILITY_REPORT_SWEEP_BASE_WHERE = `github_repo IS NOT NULL
     AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
     AND json_extract(sweep_stamps, '$.availability_report_at') IS NULL
     AND ${datasetHasVersionSql("datasets")}`;

/** Appended to the base predicate when `?missing-only=1` narrows candidacy to
 *  datasets already known incomplete (data_complete = 0, migration 0059). */
const AVAILABILITY_REPORT_SWEEP_MISSING_ONLY_WHERE = "AND data_complete = 0";

/** Single source of truth for the sweep's WHERE clause, with or without the
 *  missing-only narrowing -- shared by the candidate query and the remaining
 *  query below so they can never scope differently from each other. */
export function availabilityReportSweepWhere(missingOnly: boolean): string {
  return missingOnly
    ? `${AVAILABILITY_REPORT_SWEEP_BASE_WHERE}\n     ${AVAILABILITY_REPORT_SWEEP_MISSING_ONLY_WHERE}`
    : AVAILABILITY_REPORT_SWEEP_BASE_WHERE;
}

/** Candidate SELECT for the sweep. `LIMIT ?` is the only bound parameter. */
export function availabilityReportSweepCandidateQuery(missingOnly: boolean): string {
  return `SELECT dataset_id FROM datasets
     WHERE ${availabilityReportSweepWhere(missingOnly)}
     ORDER BY dataset_id
     LIMIT ?`;
}

/**
 * The stamp write on a successful report commit. Exported so a test can
 * exercise the exact SQL text (the write is only reachable end-to-end after
 * a real GitHub commit, which tests cannot perform): the COALESCE is
 * load-bearing -- json_set on a NULL sweep_stamps column returns NULL and
 * would silently discard the stamp (#1183), leaving the row a permanent
 * re-sweep candidate.
 */
export const AVAILABILITY_REPORT_STAMP_SQL =
  "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.availability_report_at', datetime('now')) WHERE dataset_id = ?";

/** `remaining` COUNT for the sweep -- identical scoping to the candidate query. */
export function availabilityReportSweepRemainingQuery(missingOnly: boolean): string {
  return `SELECT COUNT(*) AS n FROM datasets WHERE ${availabilityReportSweepWhere(missingOnly)}`;
}

/** Hard ceiling on candidates per sweep invocation, matching the read-only
 *  sweeps (hed-sweep, data-integrity-sweep).
 *
 *  This one is not read-only: each candidate does a GitHub commit
 *  (createOrUpdateFile = a GET-sha + PUT pair on raw fetch, with NO rate-limit
 *  retry, after the one-attempt branchExists ref lookup) on the shared
 *  GITHUB_ADMIN_PAT that also drives repo creation, publication and DOI work.
 *  It was 10 for that reason, citing the bulk-approval-rate-limit precedent.
 *
 *  30 is still comfortable because the loop is sequential and each iteration is
 *  dominated by an S3 LIST plus a manifest walk (verifyDatasetVersionS3), not by
 *  the three GitHub calls. 30 candidates is 90 GitHub requests, 30 of them
 *  writes, spread across the seconds-per-dataset those S3 passes take, so it
 *  does not resemble the tight burst the precedent hit. A refused row skips the
 *  S3 pass and costs one ref lookup (two on a 404, with the repository probe),
 *  so a pass made of refused rows is a quick burst of reads, never of writes.
 *  If the pacing ever changes -- a fast path that skips the S3 verify, or
 *  parallelising the loop -- this number has to come back down, because the
 *  pacing is incidental to the work, not enforced. */
export const AVAILABILITY_REPORT_SWEEP_MAX = 30;

/** One candidate the pass could not complete. */
export interface AvailabilityReportSweepError {
  dataset_id: string;
  error: string;
  /** The HTTP status the single-dataset route answers for this failure, so a
   *  refusal reads differently from a fault without parsing `error`: 409 =
   *  refused because the repository has no `main`; 400/404 = the dataset's own
   *  configuration; 500 = anything else (S3, GitHub or auth failure, a
   *  repository not visible to NEMAR, the stamp write). */
  status: number;
}

export interface AvailabilityReportSweepResult {
  processed: number;
  written: number;
  errors: AvailabilityReportSweepError[];
  /** Candidates still unstamped after this run, refused and failed rows
   *  included (see AVAILABILITY_REPORT_SWEEP_BASE_WHERE); 0 means nothing is left
   *  to try. Null if the count query failed. */
  remaining: number | null;
}

/**
 * Run one bounded pass of the availability-report sweep: take up to `limit`
 * unstamped candidates, regenerate each one's `.nemar/availability-report.json`,
 * and stamp `availability_report_at` on success.
 *
 * Shared by the admin route and the daily cron so the two can never drift.
 * The stamp is written ONLY after a successful commit — a failure leaves the
 * row unstamped, so it stays a candidate and the next pass simply retries it.
 * That is also what makes this safe to run repeatedly: it is self-limiting,
 * draining `limit` per pass until nothing is stale.
 *
 * Throws only if the candidate query itself fails (e.g. migration 0061 not
 * applied). Per-dataset failures are collected into `errors`, never thrown, so
 * one broken repo cannot stop the rest of the pass.
 */
export async function runAvailabilityReportSweep(
  env: Bindings,
  opts?: { limit?: number; missingOnly?: boolean },
): Promise<AvailabilityReportSweepResult> {
  const missingOnly = opts?.missingOnly ?? false;
  const requested = opts?.limit ?? AVAILABILITY_REPORT_SWEEP_MAX;
  const limit = Math.min(Math.max(requested, 1), AVAILABILITY_REPORT_SWEEP_MAX);

  const rows = await env.DB.prepare(availabilityReportSweepCandidateQuery(missingOnly))
    .bind(limit)
    .all<{ dataset_id: string }>();
  const candidates = rows.results ?? [];

  let written = 0;
  const errors: AvailabilityReportSweepError[] = [];
  for (const { dataset_id } of candidates) {
    try {
      await writeAvailabilityReport(env, dataset_id);
      await env.DB.prepare(AVAILABILITY_REPORT_STAMP_SQL).bind(dataset_id).run();
      written++;
    } catch (err) {
      errors.push({
        dataset_id,
        error: errorMessage(err),
        status: err instanceof AvailabilityReportError ? err.statusCode : 500,
      });
    }
  }

  const remainingRow = await env.DB.prepare(availabilityReportSweepRemainingQuery(missingOnly))
    .first<{ n: number }>()
    .catch(() => null);

  return { processed: candidates.length, written, errors, remaining: remainingRow?.n ?? null };
}

/**
 * Cron-only wrapper (issue #1166, Option 2). `runAvailabilityReportSweep`
 * itself stays UNGUARDED on purpose: `POST
 * /admin/datasets/availability-report-sweep` calls it directly and is not
 * environment-gated, so an operator can still drive a backfill outside
 * production. On staging AVAILABILITY_REPORT_SWEEP_BASE_WHERE's
 * `exemplarOrFragment()` carve-out (issue #1168) reaches the exemplar fleet
 * in addition to `nm099999`, since the fleet is inserted `is_sandbox = 1`
 * but is exempted from the sandbox exclusion via `is_exemplar = 1`. Only
 * the recurring daily-cron caller needs the production fence, so the guard
 * lives here instead of inside the sweep -- guarding the sweep itself would
 * quietly take the admin route down outside production too.
 *
 * Returns `null` when skipped so the `scheduled()` call site can tell "ran
 * with nothing to do" (a real result with `processed: 0`) apart from "did not
 * run at all". The call site's `if (!r) return` is what acts on that. Without
 * it the summary line would not be "fabricated" -- its own
 * `processed > 0 || remaining > 0` gate already suppresses an all-zero
 * result -- the failure is that reading `r.processed` off `null` throws, and
 * the chained `.catch()` then reports a skipped run as a crashed one
 * ("sweep failed: TypeError"). #1167 review, finding 2.
 */
export async function runAvailabilityReportSweepCron(
  env: Bindings,
): Promise<AvailabilityReportSweepResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[availability-report-sweep] skipped (non-production)");
    return null;
  }
  return runAvailabilityReportSweep(env);
}
