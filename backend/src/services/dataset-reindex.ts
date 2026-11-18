/**
 * Dataset reindex helpers (epic #417 phase 3).
 *
 * Three reusable building blocks:
 *
 * - refreshDatasetMetadata: gathers the GitHub tree + dataset_description.json +
 *   README + participants.tsv + S3 stats for a dataset and refreshes the Phase 2
 *   metadata columns + catalog fields + Vectorize embedding in D1. (The legacy
 *   nemar.org datapipeline push was removed in epic #837 Phase 3.)
 *
 * - runEnrichmentForDataset: invokes enrichDataset() in services/enrich-dataset.ts
 *   directly so callers reuse the full enrichment pipeline without an HTTP
 *   round-trip (Cloudflare rejects Worker self-fetch at the edge; see #523).
 *
 * - buildReindexFilterQuery: pure SQL-builder for the bulk admin endpoint
 *   so the filter matrix is unit-testable without a D1 harness.
 */

import type { Bindings } from "../types/bindings.js";
import { countSessionDirs } from "./bids-tree.js";
import {
  computeDatasetMetadataColumns,
  writeDatasetCatalogFields,
  writeDatasetMetadataColumns,
  writeVersionHed,
  writeVersionSize,
} from "./dataset-metadata-columns.js";
import { embedsNonPublic, reembedDatasetVector } from "./dataset-search.js";
import { enrichDataset } from "./enrich-dataset.js";
import { exemplarOrFragment, isExemplarReindexAllowed } from "./exemplar.js";
import { getDatasetsToken } from "./github-auth.js";
import { getBidsTreeStats, getBlobContent, getTreeAtRef } from "./github.js";
import { verifyDatasetVersionS3 } from "./import-integrity.js";
import { errorMessage } from "./repo-metadata.js";
import { getDatasetS3Stats } from "./s3.js";

export interface RefreshMetadataResult {
  metadata_columns_written: boolean;
  metadata_columns_error?: string;
}

/**
 * Typed error class so admin routes can map refreshDatasetMetadata failures to
 * the right HTTP status without substring-matching error messages. Status codes
 * are intentionally narrow: 400 for caller-side issues (bad dataset config),
 * 404 when the dataset row is missing, 500 for upstream / config failures.
 */
export class DatasetReindexError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 500,
  ) {
    super(message);
    this.name = "DatasetReindexError";
  }
}

function s3Cfg(env: Bindings) {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

/**
 * Gather upstream data and refresh D1 metadata columns + catalog fields +
 * Vectorize embedding for a dataset.
 *
 * Throws DatasetReindexError for caller-recoverable validation failures
 * (missing dataset row, sandbox xx* dataset, bad github_repo) so admin routes
 * can map them to specific HTTP status codes. Re-throws the underlying error
 * (wrapped with context) when the initial GitHub tree fetch fails. Once the
 * tree is in hand, every downstream sub-step has its own try/catch and is
 * reported through the return value or the metadata_columns_error D1 field.
 */
export async function refreshDatasetMetadata(
  env: Bindings,
  datasetId: string,
  // The published version this refresh reflects (#869). When provided, the
  // per-version HED row is written for exactly that version; when omitted (e.g.
  // admin reindex) writeVersionHed targets the latest version.
  version?: string,
): Promise<RefreshMetadataResult> {
  const db = env.DB;

  const dataset = await db
    .prepare("SELECT dataset_id, github_repo, is_exemplar FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null; is_exemplar: number | null }>();

  if (!dataset) {
    throw new DatasetReindexError(`Dataset not found: ${datasetId}`, 404);
  }
  if (!dataset.github_repo) {
    throw new DatasetReindexError(`Dataset has no GitHub repository: ${datasetId}`, 400);
  }
  // Sandbox xx datasets are not eligible for reindex, except staging exemplars
  // (epic #923). The REINDEX gate, not the publish gate: an anonymous deposit
  // must stay reindexable, because a fresh enrichment commit is what re-blinds
  // the `.nemar/metadata.json` that otherwise still names the depositor.
  if (datasetId.startsWith("xx") && !isExemplarReindexAllowed(env, dataset)) {
    throw new DatasetReindexError(`Sandbox dataset ${datasetId} is not eligible for reindex`, 400);
  }

  const repoParts = dataset.github_repo.split("/");
  const repoName = repoParts[1];
  if (!repoName) {
    throw new DatasetReindexError(`Invalid github_repo format: ${dataset.github_repo}`, 400);
  }
  // Wrap so a GitHub-auth failure surfaces as a DatasetReindexError; bulk
  // callers (admin reindex endpoint) report typed throws — an unguarded throw
  // here would be a generic 500.
  let pat: string;
  try {
    pat = await getDatasetsToken(env);
  } catch (err) {
    throw new DatasetReindexError(`Failed to resolve GitHub auth: ${errorMessage(err)}`, 500);
  }
  const s3 = s3Cfg(env);

  // Read repo tree first; everything else depends on it. Wrap to give the
  // caller a clear error context (most-likely cause: GitHub auth or repo
  // visibility, not anything in our code).
  let tree: Awaited<ReturnType<typeof getTreeAtRef>>;
  try {
    tree = await getTreeAtRef(repoName, "main", pat);
  } catch (err) {
    throw new DatasetReindexError(
      `Failed to read GitHub tree for ${repoName}@main: ${errorMessage(err)}`,
      500,
    );
  }

  // dataset_description.json -> bids_version; README -> catalog readme field.
  let bidsDescription: Record<string, unknown> = {};
  const bidsFile = tree.find((f) => f.path === "dataset_description.json");
  if (bidsFile) {
    try {
      bidsDescription = JSON.parse(await getBlobContent(repoName, bidsFile.sha, pat));
    } catch (err) {
      console.warn(
        `[reindex] Failed to parse dataset_description.json for ${datasetId}: ${errorMessage(err)}`,
      );
    }
  }
  const readmeFile = tree.find((f) => f.path === "README" || f.path === "README.md");
  let readme = "";
  if (readmeFile) {
    try {
      readme = await getBlobContent(repoName, readmeFile.sha, pat);
    } catch (err) {
      console.warn(`[reindex] Failed to read README for ${datasetId}: ${errorMessage(err)}`);
    }
  }

  // S3 stats: null on failure so the metadata-column writer doesn't overwrite
  // valid values with zeros.
  let s3StatsForColumns: { totalSize: number; objectCount: number | undefined } | null = null;
  try {
    s3StatsForColumns = await getDatasetS3Stats(s3, datasetId);
  } catch (err) {
    console.warn(`[reindex] S3 stats failed for ${datasetId}: ${err}`);
  }

  // participants.tsv for subject_count/age fields.
  let participantsTsv: string | null = null;
  const participantsFile = tree.find((f) => f.path === "participants.tsv");
  if (participantsFile) {
    try {
      participantsTsv = await getBlobContent(repoName, participantsFile.sha, pat);
    } catch (err) {
      console.warn(
        `[reindex] Failed to read participants.tsv for ${datasetId}: ${errorMessage(err)}`,
      );
    }
  }

  // Refresh Phase 2 metadata columns + catalog fields + embedding.
  let metadataColumnsError: string | undefined;
  let metadataColumnsWritten = false;
  try {
    // Resolve the published version this refresh targets, shared by every
    // per-version write below (HED, honest size). `version` (freshly minted by
    // the caller) wins; otherwise fall back to the latest published version by
    // created_at -- an unpublished dataset (no dataset_versions row) resolves to
    // null and every per-version write below is skipped, not a spurious 0-row
    // error.
    const targetVersion =
      version ??
      (
        await db
          .prepare(
            "SELECT version FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .bind(datasetId)
          .first<{ version: string }>()
      )?.version ??
      null;

    // Resolve modalities/subject_count/tasks truncation-immune (#820, #827): the
    // recursive `tree` above can be truncated on large datasets (derivatives/
    // fills the cap, dropping raw sub-*/<datatype>/), which gave on006110
    // `anat,func` (eeg missing) AND subject_count NULL. getBidsTreeStats walks
    // only the raw BIDS tree. A failure falls back to the tree-path detectors.
    let modalitiesOverride: string[] | undefined;
    let subjectCountOverride: number | undefined;
    let tasksOverride: string[] | undefined;
    let nChannelsOverride: number | undefined;
    let electrodeSystemOverride: string | undefined;
    let hasHedOverride: boolean | undefined;
    let hedVersionOverride: string | undefined;
    // signal_defaults overrides (epic #1144 Phase 2b, #1153): same probe,
    // same root-preferred `*_eeg.json` sidecar as nChannels/electrodeSystem
    // above -- no extra GitHub call. Note this does NOT stamp
    // signal_defaults_at (that column is written only by
    // signal-defaults-sweep.ts, mirroring channel_montage_checked_at's
    // sweep-only ownership at migration 0055): a live reindex can populate
    // these columns without making the row look already-swept.
    let samplingFrequencyOverride: number | undefined;
    let powerLineFrequencyOverride: number | undefined;
    let eegReferenceOverride: string | undefined;
    let placementSchemeOverride: string | undefined;
    try {
      const stats = await getBidsTreeStats(repoName, "main", pat);
      if (stats.modalities.length) modalitiesOverride = stats.modalities;
      if (stats.subjectCount > 0) subjectCountOverride = stats.subjectCount;
      if (stats.tasks.length) tasksOverride = stats.tasks;
      nChannelsOverride = stats.nChannels;
      electrodeSystemOverride = stats.electrodeSystem;
      hasHedOverride = stats.hasHed;
      hedVersionOverride = stats.hedVersion;
      samplingFrequencyOverride = stats.samplingFrequency;
      powerLineFrequencyOverride = stats.powerLineFrequency;
      eegReferenceOverride = stats.eegReference;
      placementSchemeOverride = stats.placementScheme;
    } catch (err) {
      console.warn(
        `[reindex] BIDS tree walk failed for ${datasetId}; using tree paths: ${errorMessage(err)}`,
      );
    }

    // Honest size/completeness from the version manifest (#970, epic #967 Phase
    // 3): declared logical size, not the annex-blind S3-objects sum. Only
    // meaningful for a published version; `manifestVerification` stays
    // undefined for an unpublished dataset or when no manifest can be verified,
    // so computeDatasetMetadataColumns falls back to `s3StatsForColumns`
    // (pre-manifest datasets) and data_complete stays NULL (not audited).
    let manifestVerification:
      | { totals: { bytes: number; files: number }; bytesPresent: number; complete: boolean }
      | undefined;
    if (targetVersion) {
      try {
        const integrity = await verifyDatasetVersionS3(env, datasetId, targetVersion);
        if (integrity.version) {
          manifestVerification = {
            totals: { bytes: integrity.declaredBytes, files: integrity.declaredFiles },
            bytesPresent: integrity.bytesPresent,
            complete: integrity.complete,
          };
        }
      } catch (err) {
        console.warn(
          `[reindex] Data-integrity verify failed for ${datasetId}@${targetVersion}: ${errorMessage(err)}`,
        );
      }
    }

    const cols = computeDatasetMetadataColumns({
      treePaths: tree.map((f) => f.path),
      participantsTsv,
      s3Stats: s3StatsForColumns,
      modalities: modalitiesOverride,
      subjectCount: subjectCountOverride,
      tasks: tasksOverride,
      nChannels: nChannelsOverride,
      electrodeSystem: electrodeSystemOverride,
      hasHed: hasHedOverride,
      hedVersion: hedVersionOverride,
      samplingFrequency: samplingFrequencyOverride,
      powerLineFrequency: powerLineFrequencyOverride,
      eegReference: eegReferenceOverride,
      placementScheme: placementSchemeOverride,
      manifestVerification,
    });
    await writeDatasetMetadataColumns(db, datasetId, cols);
    // Persist the per-version HED row (#869) only when we actually classified it
    // (cols.has_hed != null) AND the dataset has a published version to stamp.
    // Mirrors the phase-3 sweep, which guards via its latest_version select.
    if (cols.has_hed != null && targetVersion) {
      await writeVersionHed(db, datasetId, targetVersion, cols.has_hed, cols.hed_version);
    }
    // Persist the per-version honest size (#970) only when the manifest verify
    // above actually resolved a version -- same guard shape as HED, so an
    // unpublished dataset or an unverifiable manifest never 0-rows this write.
    if (manifestVerification && targetVersion) {
      await writeVersionSize(db, datasetId, targetVersion, {
        file_size: cols.file_size,
        total_files: cols.total_files,
        bytes_present: cols.bytes_present,
        data_complete: cols.data_complete,
      });
    }
    metadataColumnsWritten = true;
    console.log(
      `[reindex] Metadata columns refreshed for ${datasetId}: subjects=${cols.subject_count}, modalities=${cols.modalities}, files=${cols.total_files}`,
    );

    // #646: write metadata columns on the `datasets` source of truth. A reindex
    // refreshes the BIDS-derived readme + bids_version; name/description/authors/
    // license are null -> COALESCE-preserved (they are owned by the LLM enrich
    // path, not reindex). A failure here is a real error, so let it propagate to
    // the outer catch (-> metadataColumnsError, persisted + surfaced).
    const bidsVersion =
      typeof bidsDescription.BIDSVersion === "string" ? bidsDescription.BIDSVersion : null;
    // BIDS-native sessions_count from ses-* dirs (#657). 0 (no session layer)
    // -> null so COALESCE preserves any backfilled value rather than writing 0.
    const sessionsCount = tree.length ? countSessionDirs(tree.map((f) => f.path)) || null : null;
    await writeDatasetCatalogFields(db, datasetId, {
      readme: readme || null, // empty (no README) -> preserve existing
      bids_version: bidsVersion,
      sessions_count: sessionsCount,
    });

    // Best-effort re-embed (internally guarded, never throws).
    await reembedDatasetVector(db, env.AI, env.VECTORIZE, datasetId, embedsNonPublic(env));
  } catch (colErr) {
    metadataColumnsError = errorMessage(colErr);
    console.error(`[reindex] Failed to write metadata columns for ${datasetId}:`, colErr);
  }
  try {
    await db
      .prepare(
        "UPDATE datasets SET metadata_columns_error = ?, updated_at = datetime('now') WHERE dataset_id = ?",
      )
      .bind(metadataColumnsError ?? null, datasetId)
      .run();
  } catch (errFieldErr) {
    console.warn(
      `[reindex] Failed to record metadata_columns_error for ${datasetId}: ${errorMessage(errFieldErr)}`,
    );
  }

  return {
    metadata_columns_written: metadataColumnsWritten,
    metadata_columns_error: metadataColumnsError,
  };
}

/**
 * Background metadata-columns refresh after a version DOI is published.
 * Non-fatal: the DOI is already minted, this is downstream cleanup. On a
 * pre-refresh throw (e.g. a transient GitHub auth / tree-fetch failure, before
 * refreshDatasetMetadata reaches its own metadata_columns_error write) the
 * error is recorded to D1 so operators don't read a stale "success". (The
 * legacy nemar.org sync this replaced was removed in epic #837.)
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); log strings keep
 * the historical `[webhook]` prefix. Exported: called from the version-DOI
 * handlers and the /webhooks/manifest-ready callback.
 */
export async function refreshMetadataAfterVersionDoi(
  env: Bindings,
  datasetId: string,
  version?: string,
): Promise<void> {
  try {
    await refreshDatasetMetadata(env, datasetId, version);
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[webhook] metadata refresh failed for ${datasetId} (non-fatal):`, msg);
    try {
      await env.DB.prepare(
        "UPDATE datasets SET metadata_columns_error = ?, updated_at = datetime('now') WHERE dataset_id = ?",
      )
        .bind(`metadata refresh threw before columns write: ${msg}`, datasetId)
        .run();
    } catch (d1Err) {
      console.warn(
        `[webhook] Failed to record metadata refresh error in D1 for ${datasetId}: ${d1Err}`,
      );
    }
  }
}

import type { DoiResolutionSummary } from "./doi-metadata.js";
import type { LlmUsageTotals } from "./llm-enrich.js";

export interface EnrichmentRunResult {
  ok: boolean;
  error?: string;
  /**
   * Sub-steps the pipeline deliberately DECLINED to run, on an otherwise
   * successful run (#1255). Never populated for an error: "failed" stays
   * reserved for something that actually broke, so an operator scanning a
   * bulk reindex for failures is not reading past a hundred correct skips.
   */
  warnings?: string[];
  ref: string;
  /** Token usage + estimated USD cost of this run's LLM calls, when the
   *  pipeline completed and reported it. */
  llm_usage?: LlmUsageTotals;
  /** Stage 1d DOI lookup counts (#1549). `failed > 0` means a registry did
   *  not answer, so the relation labels were chosen without some DOIs'
   *  metadata. Nothing here retries: the result carries a warning (see
   *  doiLookupWarnings), and re-running the reindex is up to the operator or
   *  the sweep script in the description of nemarOrg/nemar-cli#1550. */
  doi_resolution?: DoiResolutionSummary;
}

/**
 * Field names that enrichDataset surfaces in a 200 response body when a
 * non-fatal sub-step (commit, D1 cache write, EZID DOI sync, ...) fails.
 * Kept in sync with the EnrichmentSuccessBody spread in enrich-dataset.ts.
 * (The workflow-template shell loop that also consumed these fields left this
 * repo when enrichment moved to the central nemarDatasets/.github workflow;
 * the old services/github.ts pointer was already stale.) The Claude API
 * call is intentionally not in this list: it's the load-bearing Stage 2,
 * and any failure there aborts the pipeline with a 500 rather than a
 * 200-with-warning.
 */
const ENRICHMENT_SUBERROR_FIELDS = [
  "commit_error",
  "doi_sync_error",
  "cache_error",
  "bidsignore_error",
  "metadata_columns_error",
  "issue_creation_error",
] as const;

/**
 * Pull named *_error fields from a parsed enrichment response body and emit
 * "<field>: <message>" for each one populated with a non-empty string. Pure
 * function so the surfacing matrix is unit-testable.
 */
export function extractEnrichmentSubErrors(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const out: string[] = [];
  for (const field of ENRICHMENT_SUBERROR_FIELDS) {
    const v = record[field];
    if (typeof v === "string" && v.length > 0) out.push(`${field}: ${v}`);
  }
  return out;
}

/**
 * Pull DELIBERATE skips out of an enrichment response body.
 *
 * Separate from {@link extractEnrichmentSubErrors} on purpose (#1255 review
 * item 26). A skip is not a failure: `doi_sync: skipped` means the pipeline
 * declined to push a DOI record that would have deleted an existing
 * DataCurator, which is the correct outcome, not a broken run. Folding it
 * into the sub-error list made every reindex of a dataset whose owner has no
 * name yet -- most of the catalogue until `nemar admin backfill-names --apply`
 * has been run -- report `status: "failed"` and log "enrichment failed",
 * burying the real failures in the same batch.
 *
 * Operators still need to see it, so it travels as a WARNING alongside an
 * `ok` result.
 */
export function extractEnrichmentSkips(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const sync = (body as Record<string, unknown>).doi_sync;
  if (!sync || typeof sync !== "object") return [];
  const s = sync as { status?: unknown; reason?: unknown; message?: unknown };
  if (s.status !== "skipped") return [];
  const reason = typeof s.reason === "string" ? s.reason : "unknown";
  const message = typeof s.message === "string" ? s.message : "";
  return [`doi_sync: skipped (${reason})${message ? ` — ${message}` : ""}`];
}

/**
 * Warnings for DOI lookups that got no registry answer (429, 5xx, timeout, or
 * the stage deadline). Such a run still succeeds, so this is a warning on the
 * same list as a deliberate skip, never a failure; it tells the operator the
 * relation labels were chosen without some DOIs' metadata and that
 * reindexing the dataset again is worthwhile.
 */
export function doiLookupWarnings(summary: DoiResolutionSummary | undefined): string[] {
  if (!summary || summary.failed <= 0) return [];
  const asked = summary.resolved + summary.unresolved + summary.failed;
  return [
    `doi_resolution: ${summary.failed} of ${asked} DOI lookup(s) got no registry answer; reindex this dataset again to label them with registry metadata`,
  ];
}

/**
 * Heuristic: does the given ref look like a version tag (immutable)?
 * Matches `v` followed by a digit, the conventional shape for semver-style
 * release tags produced by pr-merge.yml. Tag refs must use client_commits=true
 * because the Worker's commit path resolves refs/heads/<ref> and gets 404
 * for tags; the worse failure mode is the bare-Contents-API write silently
 * landing on main. Exported for unit tests.
 */
export function looksLikeTagRef(ref: string): boolean {
  return /^v\d/.test(ref);
}

/**
 * Run the LLM enrichment pipeline for a dataset in-process by calling the
 * extracted enrichDataset service function directly. Defaults to ref="main"
 * and force=true (admin paths always want a fresh enrichment regardless of
 * source_hash). The caller can override either.
 *
 * History (#523): previously this used `fetch(API_BASE_URL/webhooks/llm-enrich)`
 * to forward to the webhook handler on the same Worker, but Cloudflare rejects
 * Worker self-fetches at the edge with HTTP 522 (regardless of whether the
 * target is the custom domain or *.workers.dev). The handler body now lives
 * in services/enrich-dataset.ts and is invoked directly, so no HTTP round-trip
 * is involved on the admin-reindex path.
 */
export async function runEnrichmentForDataset(
  env: Bindings,
  datasetId: string,
  options?: { ref?: string; clientCommits?: boolean },
): Promise<EnrichmentRunResult> {
  const ref = options?.ref ?? "main";
  if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_WORKSPACE_ID) {
    return { ok: false, error: "Claude API not configured (ANTHROPIC_* bindings)", ref };
  }

  // Tag refs are immutable; force client_commits=true so the inner pipeline
  // skips its REST commit path. If the explicit caller already opted into
  // client_commits we honor that. Branch refs default to false unless the
  // caller asked otherwise (mirroring the existing behavior).
  const clientCommits = options?.clientCommits === true || looksLikeTagRef(ref);

  try {
    const outcome = await enrichDataset(env, {
      datasetId,
      force: true,
      ref,
      clientCommits,
    });
    if (!outcome.ok) {
      const detail = outcome.body.details ? `: ${outcome.body.details}` : "";
      return {
        ok: false,
        error: `HTTP ${outcome.status}: ${outcome.body.error}${detail}`,
        ref,
      };
    }
    // Carried on both branches: a run that fails after its LLM calls still
    // spent the tokens and made the DOI lookups.
    const reported = {
      llm_usage: "llm_usage" in outcome.body ? outcome.body.llm_usage : undefined,
      doi_resolution: "doi_resolution" in outcome.body ? outcome.body.doi_resolution : undefined,
    };
    const subErrors = extractEnrichmentSubErrors(outcome.body);
    if (subErrors.length > 0) {
      return { ok: false, error: subErrors.join("; "), ref, ...reported };
    }
    const skips = extractEnrichmentSkips(outcome.body);
    const warnings = [...skips, ...doiLookupWarnings(reported.doi_resolution)];
    return {
      ok: true,
      ref,
      ...reported,
      ...(warnings.length > 0 && { warnings }),
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err), ref };
  }
}

export type ReindexFilter = "all" | "missing-metadata" | "stale";

export interface ReindexFilterOptions {
  olderThanDays?: number;
}

/**
 * Pure SQL builder for the bulk reindex admin endpoint. Returns the SQL plus
 * the parameter bindings so the route can prepare/bind without composing
 * strings itself. Throws on unknown filter values so a typo is loud.
 */
export function buildReindexFilterQuery(
  filter: ReindexFilter,
  options?: ReindexFilterOptions,
): { sql: string; params: unknown[] } {
  // Excludes xx% datasets (sandbox/throwaway, not eligible for reindex — see
  // dataset deletion/publish handlers for the same short-circuit) EXCEPT staging
  // exemplars (is_exemplar=1, epic #923; never present in prod). nm% and on%
  // datasets are both refreshed: refreshDatasetMetadata recomputes their D1
  // metadata columns + LLM enrichment, which the catalog endpoint and
  // data.nemar.org/<id>/metadata.json need (#512).
  const base = `SELECT dataset_id FROM datasets WHERE github_repo IS NOT NULL AND (dataset_id NOT LIKE 'xx%' OR ${exemplarOrFragment("")})`;
  if (filter === "all") {
    return { sql: `${base} ORDER BY dataset_id`, params: [] };
  }
  if (filter === "missing-metadata") {
    // Recency guard: skip rows we've already attempted in the last 24h.
    // Without this, datasets whose upstream genuinely lacks a column we
    // require (e.g. no participants.tsv -> subject_count stays NULL)
    // re-match every sweep and get reindexed forever with no progress.
    // 24h gives upstream time to ship a fix; operators who need to force
    // an immediate retry can use `--all`.
    const recencyDays = options?.olderThanDays ?? 1;
    if (!Number.isFinite(recencyDays) || recencyDays < 0) {
      throw new Error(`Invalid older_than_days: ${recencyDays}`);
    }
    return {
      sql: `${base} AND (subject_count IS NULL OR modalities IS NULL OR file_size IS NULL OR total_files IS NULL) AND (json_extract(sweep_stamps, '$.metadata_updated_at') IS NULL OR json_extract(sweep_stamps, '$.metadata_updated_at') < datetime('now', ?)) ORDER BY dataset_id`,
      params: [`-${recencyDays} days`],
    };
  }
  if (filter === "stale") {
    const days = options?.olderThanDays ?? 30;
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`Invalid older_than_days: ${days}`);
    }
    return {
      sql: `${base} AND (json_extract(sweep_stamps, '$.metadata_updated_at') IS NULL OR json_extract(sweep_stamps, '$.metadata_updated_at') < datetime('now', ?)) ORDER BY dataset_id`,
      params: [`-${days} days`],
    };
  }
  throw new Error(`Unknown reindex filter: ${filter}`);
}
