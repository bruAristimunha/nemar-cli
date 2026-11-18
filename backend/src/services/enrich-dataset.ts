/**
 * LLM-driven metadata enrichment pipeline as a callable service function.
 *
 * Extracted from the /webhooks/llm-enrich Hono handler so it can be invoked
 * directly from inside the Worker (e.g. by runEnrichmentForDataset in
 * dataset-reindex.ts) without an HTTP self-fetch. Cloudflare Workers reject
 * self-fetches at the edge with HTTP 522, regardless of whether the target
 * URL is the custom domain or the *.workers.dev fallback (#523), so the
 * webhook contract is preserved by keeping the route as a thin wrapper that
 * authenticates, parses the body, and forwards to enrichDataset.
 *
 * The function returns a discriminated outcome that mirrors the original
 * webhook responses one-to-one (200 success / 200 skipped / 400 / 404 /
 * 422 / 500), so both callers can map it to the same HTTP shape or to a
 * structured EnrichmentRunResult without re-implementing the matrix.
 */

import { formatFileSize } from "../../../shared/bytes.js";
import { type NemarMetadataV2, datasetLandingUrl } from "../../../shared/datacite-constants.js";
import type { Bindings } from "../types/bindings.js";
import { ANONYMOUS_DEPOSIT_REASON, blindEnrichmentMetadata, isAnonymous } from "./anonymity.js";
import { countSessionDirs } from "./bids-tree.js";
import {
  bidsToDataCite,
  buildDataCiteXml,
  nemarMetadataToEnrichment,
  parseNemarMetadata,
} from "./datacite.js";
import {
  authorsFromEnrichment,
  computeDatasetMetadataColumns,
  writeDatasetCatalogFields,
  writeDatasetMetadataColumns,
} from "./dataset-metadata-columns.js";
import { embedsNonPublic, reembedDatasetVector } from "./dataset-search.js";
import {
  type DoiResolution,
  type DoiResolutionSummary,
  EMPTY_DOI_RESOLUTION,
  MAX_RESOLVED_DOIS,
  collectCandidateDois,
  datasetDoisOf,
  resolveDoisForEnrichment,
  summarizeDoiResolution,
  titlesByDoi,
} from "./doi-metadata.js";
import {
  discoverOrcidsFromReferencedDois,
  extractDoisFromBids,
  extractDoisFromRelatedIdentifiers,
  mergeOrcidDiscoveries,
} from "./doi-orcid-discovery.js";
import type { RegistryCache } from "./doi-registry.js";
import { buildOrcidEnrichment, resolveEzidAuth } from "./doi.js";
import { resolveDatasetLandingBase } from "./environment.js";
import { conceptEzidIdentifier, extractDoi, updateIdentifier } from "./ezid.js";
import { getDatasetsToken, getDatasetsTokenWithRefresher } from "./github-auth.js";
import {
  EnrichmentCommitError,
  commitEnrichmentWithBidsignore,
  ensureMainBranch,
  getBlobContent,
  getTreeAtRef,
  setRepoDescription,
} from "./github.js";
import {
  type LlmUsageTotals,
  type RelationGuardContext,
  correctFromFeedback,
  enforceNeverDataPaper,
  enrichFromReadme,
  estimateUsageCostUsd,
  mergeWithExisting,
  pruneUnsourcedDois,
  seedFromBids,
  validateMeshTerms,
  validateMetadata,
} from "./llm-enrich.js";
import { recordLlmUsage } from "./llm-metrics.js";
import { ensureParticipantsTsv } from "./participants-tsv.js";
import { errorMessage, extractRepoName } from "./repo-metadata.js";
import { extractExtensions, getDatasetS3Stats } from "./s3.js";
import {
  OWNER_NAME_MISSING_REASON,
  refreshWouldStripAttribution,
  resolveOwnerIdentity,
} from "./uploader-identity.js";

export interface EnrichmentOpts {
  datasetId: string;
  force?: boolean;
  clientCommits?: boolean;
  ref?: string;
}

export interface EnrichmentCommitPayload {
  metadata_path: string;
  metadata_content: string;
  bidsignore_entries: string[];
  commit_message: string;
}

/**
 * Canonical shape of the commit payload returned to an Action that opted into
 * `client_commits: true`. The Action's jq script in
 * `nemarDatasets/.github/.github/workflows/run-enrichment.yml` (Phase 1 of
 * #601) reads these exact field names; `run-version-doi.yml`'s defensive
 * pre-DOI refresh step does too.
 */
export function buildEnrichmentCommitPayload(
  metadataContent: string,
  bidsignoreEntries: string[],
  commitMessage: string,
): EnrichmentCommitPayload {
  return {
    metadata_path: ".nemar/metadata.json",
    metadata_content: metadataContent,
    bidsignore_entries: bidsignoreEntries,
    commit_message: commitMessage,
  };
}

export interface EnrichmentSuccessBody {
  message: string;
  dataset_id: string;
  pipeline_stage: NemarMetadataV2["pipeline_stage"];
  seeded_fields: {
    authors: number;
    related_identifiers: number;
    funding_references: number;
    orcids_discovered: number;
  };
  enriched_fields: string[];
  validation: {
    valid: boolean;
    blocking_issues: string[];
    warnings: string[];
  } | null;
  commit_mode: "batched" | "single" | "client";
  client_commits?: true;
  metadata_path?: string;
  metadata_content?: string;
  bidsignore_entries?: string[];
  commit_message?: string;
  commit_error?: string;
  bidsignore_error?: string;
  cache_error?: string;
  metadata_columns_error?: string;
  issue_creation_error?: string;
  doi_sync_error?: string;
  /** Present when the DOI metadata sync was deliberately NOT performed
   *  (#1255): rebuilding the record from a nameless owner would have deleted
   *  an existing DataCurator from a permanent DOI. */
  doi_sync?: DoiSyncOutcome;
  /** Token usage across this run's LLM calls, with an estimated USD cost
   *  at claude-sonnet-5-5 standard rates. */
  llm_usage?: LlmUsageTotals;
  /** DOIs removed by the unsourced-DOI guard this run (see
   *  pruneUnsourcedDois). Surfaced so silent metadata loss is impossible. */
  pruned_dois?: string[];
  /** DOIs forced from a data-describing relation to `References` by the
   *  never-data-paper guard this run (see enforceNeverDataPaper, #1549). */
  demoted_dois?: string[];
  /** The dataset's own NEMAR DOIs removed from related_identifiers this run
   *  (see enforceNeverDataPaper, #1549). */
  self_dois_dropped?: string[];
  /** Stage 1d DOI lookups (#1549). `failed` counts DOIs no registry answered
   *  for (429, 5xx, timeout, the stage deadline); only reindexing the dataset
   *  again recovers them. `unresolved` counts DOIs the registries say do not
   *  exist. */
  doi_resolution: DoiResolutionSummary;
}

/** Why a DOI metadata sync did not run. One typed object rather than a
 *  parallel pair of string fields, so status and reason cannot disagree. */
export interface DoiSyncOutcome {
  status: "skipped";
  reason: typeof OWNER_NAME_MISSING_REASON | typeof ANONYMOUS_DEPOSIT_REASON;
  message: string;
}

export interface EnrichmentSkippedBody {
  message?: string;
  error?: string;
  dataset_id?: string;
  skipped: true;
  pipeline_stage?: NemarMetadataV2["pipeline_stage"];
}

export interface EnrichmentErrorBody {
  error: string;
  details?: string;
}

export type EnrichmentOutcome =
  | { ok: true; status: 200; body: EnrichmentSuccessBody | EnrichmentSkippedBody }
  | { ok: false; status: 400 | 404 | 422 | 500; body: EnrichmentErrorBody };

/** Pipeline stages whose metadata is considered "cached" enough to short-circuit
 *  on unchanged sources. `"seeded"` is intentionally excluded — a seeded-only
 *  record hasn't had its LLM passes yet, so a re-trigger should run them. */
const CACHED_PIPELINE_STAGES: ReadonlySet<string> = new Set(["validated", "enriched"]);

/** Decision returned by {@link decideSkipEnrichment}.
 *
 *  - `skip:true` — the pipeline should return early with a 200 "skipped"
 *    response; `reason` is the human-readable log line.
 *  - `skip:false` — the pipeline should run; `proceedReason` (when present)
 *    is the human-readable log line explaining why the guard let it
 *    through. Both fields are optional so callers can log only when there
 *    is something interesting to log. */
export type SkipEnrichmentDecision =
  | { skip: true; reason: string }
  | { skip: false; proceedReason?: string };

/** Pure decision helper for the source-hash skip guard in {@link enrichDataset}.
 *
 *  Exported for unit testing — the production callsite passes the runtime
 *  hash and the `existingMetadata` fields from `.nemar/metadata.json`. The
 *  three skip-relevant inputs (`pipelineStage`, `existingSourceHash`,
 *  `currentSourceHash`) plus `forceReenrich` produce a deterministic
 *  decision; pinning the table here prevents a future refactor from
 *  silently re-opening the #643 self-fire loop.
 *
 *  Rules:
 *   - `forceReenrich` always proceeds (manual recovery / release flow).
 *   - No `pipelineStage`, or a stage outside {@link CACHED_PIPELINE_STAGES}
 *     (e.g., `"seeded"`), proceeds.
 *   - `existingSourceHash === undefined` proceeds with a "migration" reason —
 *     covers the one-time backfill case where pre-#643 records lack the
 *     field. Once the next run writes a hash, this branch stops firing.
 *   - Matching hash on a cached stage skips; mismatched hash proceeds with a
 *     "sources changed" reason. */
export function decideSkipEnrichment(args: {
  pipelineStage: string | undefined;
  existingSourceHash: string | undefined;
  currentSourceHash: string;
  forceReenrich: boolean;
}): SkipEnrichmentDecision {
  const { pipelineStage, existingSourceHash, currentSourceHash, forceReenrich } = args;

  if (forceReenrich) {
    return { skip: false, proceedReason: "force=true requested" };
  }
  if (!pipelineStage || !CACHED_PIPELINE_STAGES.has(pipelineStage)) {
    return { skip: false };
  }
  if (existingSourceHash === undefined) {
    return {
      skip: false,
      proceedReason: `no source_hash in existing ${pipelineStage} metadata (migration)`,
    };
  }
  if (existingSourceHash === currentSourceHash) {
    return {
      skip: true,
      reason: `stage="${pipelineStage}" and sources unchanged`,
    };
  }
  return {
    skip: false,
    proceedReason: `sources changed since last ${pipelineStage} run`,
  };
}

/**
 * Run the full LLM-driven metadata enrichment pipeline for a single dataset.
 *
 * Pipeline stages (matching the original /webhooks/llm-enrich handler):
 *   1.  Seed metadata deterministically from BIDS dataset_description.json
 *   1a. Compute file sizes/extensions from S3 and the repo tree
 *   1b. Discover author ORCIDs from referenced DOIs
 *   1c. Read participants.tsv for the metadata-columns writer
 *   2.  LLM enrichment (description, keywords, methods, ...)
 *   2b. MeSH term validation via NLM API
 *   2c. Second ORCID discovery pass on LLM-extracted DOIs
 *   3.  LLM validation with up to 3 correction attempts
 *
 * Side effects (each isolated in try/catch so a failure in one stage does
 * not unwind the others):
 *   - Commits .nemar/metadata.json + .bidsignore to the dataset repo (unless
 *     clientCommits=true, in which case the commit payload is returned for
 *     the caller's GitHub Actions workflow to apply)
 *   - Updates datasets.enrichment_json + enrichment_updated_at in D1
 *   - Writes Phase 2 metadata columns (subject_count, modalities, ...)
 *   - Syncs DOI metadata to EZID when the dataset has a concept DOI (the
 *     EZID identifier derives from it, #1182)
 *   - Creates a GitHub issue on the dataset repo when validation fails
 *     after all correction attempts
 *   - Updates the dataset name in D1 + the GitHub repo description when
 *     the BIDS Name field changed
 */
export async function enrichDataset(
  env: Bindings,
  opts: EnrichmentOpts,
): Promise<EnrichmentOutcome> {
  if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_WORKSPACE_ID) {
    return {
      ok: false,
      status: 500,
      body: {
        error:
          "Claude API not configured (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_WORKSPACE_ID)",
      },
    };
  }
  const llmUsage = { calls: 0, input_tokens: 0, output_tokens: 0 };
  const llmConfig = {
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL,
    workspaceId: env.ANTHROPIC_WORKSPACE_ID,
    usage: llmUsage,
  };

  const datasetId = opts.datasetId;
  const forceReenrich = opts.force === true;
  // Resolved once; reused for the repo-description link and the seed related-id.
  const landingBase = resolveDatasetLandingBase(env);
  // When true, the caller (the central `run-enrichment.yml` Action on
  // `nemarDatasets/.github`, or the `run-version-doi.yml` pre-DOI refresh
  // step) will write the metadata commit using its own per-repo App token;
  // the Worker just returns the would-be commit payload and skips the
  // admin-PAT REST commit. Phase 1 of #601.
  const clientCommits = opts.clientCommits === true;
  // Branch or ref to read from / commit to. Defaults to "main" for back-compat.
  // Release-branch and tag-driven enrichment pass the current ref so the
  // pipeline operates on the right snapshot (e.g., release/v1.0.1 or v1.0.1).
  const ref = opts.ref ?? "main";

  // Look up dataset in D1 (includes EZID/owner fields for DOI title sync).
  // Wrapped so a D1 transport or schema failure surfaces as a typed
  // EnrichmentOutcome with the underlying message in `details`, instead of
  // escaping to Hono's generic 500 handler which drops the diagnostic.
  let dataset: {
    dataset_id: string;
    name: string | null;
    github_repo: string | null;
    enrichment_json: string | null;
    concept_doi: string | null;
    is_sandbox: number | null;
    // source + is_exemplar decide whether an owner name is REQUIRED here
    // (requiresUploaderName); without them the attribution guard below cannot
    // tell a researcher deposit from an OpenNeuro import.
    source: string | null;
    is_exemplar: number | null;
    anonymous: number | null;
    owner_username: string | null;
    owner_orcid: string | null;
    owner_given_name: string | null;
    owner_family_name: string | null;
  } | null;
  try {
    dataset = await env.DB.prepare(
      `SELECT d.dataset_id, d.name, d.github_repo, d.enrichment_json,
              d.concept_doi, d.is_sandbox, d.source, d.is_exemplar, d.anonymous,
              u.username AS owner_username, u.orcid AS owner_orcid,
              u.given_name AS owner_given_name, u.family_name AS owner_family_name
       FROM datasets d
       LEFT JOIN users u ON d.owner_user_id = u.id
       WHERE d.dataset_id = ?`,
    )
      .bind(datasetId)
      .first<{
        dataset_id: string;
        name: string | null;
        github_repo: string | null;
        enrichment_json: string | null;
        concept_doi: string | null;
        is_sandbox: number | null;
        source: string | null;
        is_exemplar: number | null;
        anonymous: number | null;
        owner_username: string | null;
        owner_orcid: string | null;
        owner_given_name: string | null;
        owner_family_name: string | null;
      }>();
  } catch (err) {
    return {
      ok: false,
      status: 500,
      body: { error: "D1 lookup failed", details: errorMessage(err) },
    };
  }

  if (!dataset) {
    return { ok: false, status: 404, body: { error: "Dataset not found" } };
  }
  if (!dataset.github_repo) {
    return { ok: false, status: 400, body: { error: "Dataset has no GitHub repository" } };
  }
  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    return { ok: false, status: 400, body: { error: "Invalid github_repo format" } };
  }

  // GitHub auth resolution can throw if neither App nor PAT is configured;
  // mirror the D1 catch so the webhook caller gets a structured response.
  // We use the refresher variant so the first round of GitHub reads can
  // self-heal from a one-off stale-App-token 401. Issue #596.
  let pat: string;
  let refreshGitHubToken: () => Promise<string>;
  try {
    const auth = await getDatasetsTokenWithRefresher(env);
    pat = auth.token;
    refreshGitHubToken = auth.refresh;
  } catch (err) {
    return {
      ok: false,
      status: 500,
      body: { error: "Failed to resolve GitHub auth", details: errorMessage(err) },
    };
  }

  console.log(
    `[llm-enrich] Starting ${datasetId} on ref="${ref}" (force=${forceReenrich}, client_commits=${clientCommits})`,
  );

  // Ensure default branch is "main" before reading from it. Only relevant
  // for the main-branch flow; release branches and tags are explicit refs
  // and do not depend on the default-branch rename helper.
  if (ref === "main") {
    try {
      await ensureMainBranch(repoName, pat);
    } catch (error) {
      console.error(`[llm-enrich] Failed to verify default branch for ${repoName}:`, error);
      // Continue anyway; getTreeAtRef will fail with a clear error if "main" doesn't exist
    }
  }

  try {
    const tree = await getTreeAtRef(repoName, ref, pat, refreshGitHubToken);

    const readmeFile = tree.find(
      (f) => f.path === "README.md" || f.path === "README" || f.path === "readme.md",
    );
    if (!readmeFile) {
      return {
        ok: true,
        status: 200,
        body: { error: "No README found in repository", skipped: true },
      };
    }
    const readmeContent = await getBlobContent(repoName, readmeFile.sha, pat, refreshGitHubToken);

    let bidsDescription: Record<string, unknown> = {};
    const descFile = tree.find((f) => f.path === "dataset_description.json");
    if (descFile) {
      const descContent = await getBlobContent(repoName, descFile.sha, pat, refreshGitHubToken);
      try {
        bidsDescription = JSON.parse(descContent) as Record<string, unknown>;
      } catch (parseErr) {
        console.error(
          `[llm-enrich] Could not parse dataset_description.json for ${datasetId}: ${errorMessage(parseErr)}`,
        );
        return {
          ok: false,
          status: 422,
          body: {
            error: "dataset_description.json exists but contains invalid JSON",
            details: errorMessage(parseErr),
          },
        };
      }
    }

    // Sync BIDS Name to D1 and GitHub repo description if changed.
    // Done here because llm-enrich already reads dataset_description.json,
    // and BIDS Name may change across versions.
    const bidsName =
      typeof bidsDescription.Name === "string"
        ? bidsDescription.Name.replace(/[\r\n]+/g, " ")
            .trim()
            .slice(0, 200)
        : null;
    if (bidsName && bidsName !== dataset.name) {
      try {
        await env.DB.prepare("UPDATE datasets SET name = ? WHERE dataset_id = ?")
          .bind(bidsName, datasetId)
          .run();
      } catch (dbErr) {
        console.error(
          `[llm-enrich] Failed to update BIDS Name in D1 for ${datasetId}: ${errorMessage(dbErr)}`,
        );
      }
      const nemarUrl = datasetLandingUrl(datasetId, landingBase);
      const repoResult = await setRepoDescription(repoName, bidsName, pat, nemarUrl);
      if (!repoResult.ok) {
        console.error(
          `[llm-enrich] Failed to set GitHub repo description for ${datasetId}: HTTP ${repoResult.status} - ${repoResult.error}`,
        );
      } else {
        console.log(`[llm-enrich] Synced BIDS Name for ${datasetId}: "${bidsName}"`);
      }
    }

    // Read existing .nemar/metadata.json to preserve author ORCIDs
    let existingMetadata: NemarMetadataV2 | null = null;
    const nemarMetaFile =
      tree.find((f) => f.path === ".nemar/metadata.json") ||
      tree.find((f) => f.path === "nemar_metadata.json");
    if (nemarMetaFile) {
      const nemarContent = await getBlobContent(
        repoName,
        nemarMetaFile.sha,
        pat,
        refreshGitHubToken,
      );
      try {
        const parsed = parseNemarMetadata(JSON.parse(nemarContent));
        if (parsed?.version === "2.0") {
          existingMetadata = parsed;
        } else if (parsed?.version === "1.0" && parsed.authors) {
          const v2Authors: Record<
            string,
            { orcid?: string; affiliations?: Array<{ name: string }> }
          > = {};
          for (const [name, entry] of Object.entries(parsed.authors)) {
            v2Authors[name] = {};
            if (entry.orcid) v2Authors[name].orcid = entry.orcid;
            if (entry.affiliation) v2Authors[name].affiliations = [{ name: entry.affiliation }];
          }
          existingMetadata = { version: "2.0", authors: v2Authors };
        }
      } catch (parseErr) {
        console.error(
          `[llm-enrich] Existing metadata for ${datasetId} has invalid JSON: ${errorMessage(parseErr)}`,
        );
        // Attempt to recover author ORCIDs from corrupt JSON via regex.
        // The ORCID data is too valuable to silently discard when manual
        // edits introduce typos (e.g. double braces).
        try {
          const recoveredAuthors: Record<string, { orcid?: string }> = {};
          const orcidValues = nemarContent.matchAll(/"orcid":\s*"(\d{4}-\d{4}-\d{4}-[\dX]{4})"/g);
          for (const match of orcidValues) {
            const before = nemarContent.slice(0, match.index);
            const nameMatch = before.match(/"([^"]+)":\s*\{[^{}]*$/);
            if (nameMatch) {
              recoveredAuthors[nameMatch[1]] = { orcid: match[1] };
            }
          }
          const recoveredCount = Object.keys(recoveredAuthors).length;
          if (recoveredCount > 0) {
            existingMetadata = { version: "2.0", authors: recoveredAuthors };
            console.log(
              `[llm-enrich] Recovered ${recoveredCount} author ORCIDs from corrupt JSON for ${datasetId}`,
            );
          } else {
            console.warn(
              `[llm-enrich] Could not recover any data from corrupt metadata for ${datasetId}`,
            );
          }
        } catch (recoveryErr) {
          console.error(
            `[llm-enrich] Recovery from corrupt JSON also failed for ${datasetId}: ${errorMessage(recoveryErr)}`,
          );
        }
      }
    }

    // Compute source content hash for change detection
    const sourceContent = `${readmeContent}\n---\n${JSON.stringify(bidsDescription)}`;
    const sourceHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sourceContent),
    );
    const sourceHash = Array.from(new Uint8Array(sourceHashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Guard: skip re-enrichment when sources are unchanged.
    const skipDecision = decideSkipEnrichment({
      pipelineStage: existingMetadata?.pipeline_stage,
      existingSourceHash: existingMetadata?.source_hash,
      currentSourceHash: sourceHash,
      forceReenrich,
    });
    if (skipDecision.skip) {
      console.log(`[llm-enrich] Skipping ${datasetId}: ${skipDecision.reason}`);
      return {
        ok: true,
        status: 200,
        body: {
          message: "Metadata already up-to-date and sources unchanged",
          dataset_id: datasetId,
          skipped: true,
          pipeline_stage: existingMetadata?.pipeline_stage,
        },
      };
    }
    if (skipDecision.proceedReason) {
      console.log(`[llm-enrich] Re-enriching ${datasetId}: ${skipDecision.proceedReason}`);
    }

    // Stage 1: Seed from BIDS (deterministic, no LLM call). Prune DOI
    // related-identifiers that no longer appear in the source material so
    // hallucinated DOIs from past runs self-heal on re-enrichment.
    const treePaths = tree.map((f) => f.path);
    const prunedDois: string[] = [];
    const logPrune = (stage: string, outcome: { pruned: { identifier: string }[] }) => {
      if (outcome.pruned.length === 0) return;
      const ids = outcome.pruned.map((p) => p.identifier);
      prunedDois.push(...ids);
      console.warn(
        `[llm-enrich] Pruned ${ids.length} unsourced DOI(s) at ${stage} for ${datasetId}: ${ids.join(", ")}`,
      );
    };
    // Standards, software, and platform papers are never this dataset's data
    // paper, and the dataset's own DOI is never a relation (#1549). Enforce
    // both after every stage that can write a relation (the seed carries
    // older metadata.json entries forward) and log it. guardContext gains the
    // resolved titles once stage 1d has run.
    const demotedDois: string[] = [];
    const droppedSelfDois: string[] = [];
    const logDemote = (
      stage: string,
      outcome: { demoted: { identifier: string }[]; dropped: { identifier: string }[] },
    ) => {
      for (const [list, entries, what] of [
        [demotedDois, outcome.demoted, "never-data-paper DOI(s) demoted to References"],
        [droppedSelfDois, outcome.dropped, "self-referencing DOI(s) dropped"],
      ] as const) {
        if (entries.length === 0) continue;
        const ids = entries.map((d) => d.identifier);
        for (const id of ids) if (!list.includes(id)) list.push(id);
        console.warn(
          `[llm-enrich] ${ids.length} ${what} at ${stage} for ${datasetId}: ${ids.join(", ")}`,
        );
      }
    };
    let guardContext: RelationGuardContext = { datasetId };
    const seedPrune = pruneUnsourcedDois(
      seedFromBids(bidsDescription, existingMetadata, datasetId, treePaths, landingBase),
      readmeContent,
      bidsDescription,
    );
    logPrune("seed", seedPrune);
    const seedDemote = enforceNeverDataPaper(seedPrune.result, guardContext);
    logDemote("seed", seedDemote);
    const seeded = seedDemote.result;
    console.log(
      `[llm-enrich] Stage 1 (seed): ${datasetId} - ${Object.keys(seeded.authors || {}).length} authors, ${(seeded.related_identifiers || []).length} related IDs`,
    );

    // Stage 1a: Compute sizes from S3 and formats from tree. s3Stats is
    // hoisted so the metadata-columns writer (post-cache, below) can reuse it
    // without re-querying S3.
    let s3Stats: { totalSize: number; objectCount: number | undefined } | null = null;
    try {
      s3Stats = await getDatasetS3Stats(
        {
          bucket: env.S3_BUCKET,
          region: env.AWS_REGION,
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
        datasetId,
      );

      // formatFileSize returns null for a non-positive total (shared/bytes.ts),
      // which getDatasetS3Stats does report: totalSize starts at 0 and stays
      // there for a metadata-only dataset, or when enrichment runs before the
      // S3 objects land. The formatter this replaced returned a string for
      // every input, so interpolating unguarded would seed the literal
      // "null (0 files)" into `sizes` -- and that field reaches the minted
      // DataCite <sizes> element (services/datacite.ts). Omit the field
      // instead: an absent size is honest, a stringified null is not (#1225
      // review).
      const sizeStr = formatFileSize(s3Stats.totalSize);
      const countLabel =
        s3Stats.objectCount !== undefined ? `${s3Stats.objectCount} files` : "files";
      if (sizeStr) seeded.sizes = [`${sizeStr} (${countLabel})`];

      const extensions = extractExtensions(treePaths);
      if (extensions.length > 0) seeded.formats = extensions;

      console.log(
        `[llm-enrich] Stage 1a (sizes): ${datasetId} - ${sizeStr ?? "size unavailable"} (${countLabel}), ${extensions.length} formats`,
      );
    } catch (sizeErr) {
      console.warn(
        `[llm-enrich] Stage 1a (sizes) failed for ${datasetId}, continuing: ${errorMessage(sizeErr)}`,
      );
    }

    // Stage 1c: Read participants.tsv so the metadata-columns writer below
    // can populate subject_count and age range. When the dataset shipped
    // without one (BIDS treats it as RECOMMENDED, not REQUIRED, so the
    // validator passes), auto-generate a placeholder from the sub-* dirs
    // and queue it for the enrichment commit. This is the single point
    // that catches both paths -- `nemar upload` (user forgot the file)
    // and `--trust-upstream` OpenNeuro import (upstream itself lacks one,
    // e.g. ds005262). Non-fatal: if subjects don't exist either, leave
    // subject_count NULL in D1 rather than fabricate values.
    let participantsTsv: string | null = null;
    let autoParticipantsToCommit: string | null = null;
    // Case-sensitive by design — see comment in shared/standard-edits/participants.ts.
    // BIDS canonical filename is lowercase `participants.tsv`.
    const participantsFile = tree.find((f) => f.path === "participants.tsv");
    if (participantsFile) {
      try {
        participantsTsv = await getBlobContent(
          repoName,
          participantsFile.sha,
          pat,
          refreshGitHubToken,
        );
      } catch (partErr) {
        console.warn(
          `[llm-enrich] Failed to read participants.tsv for ${datasetId}, continuing: ${errorMessage(partErr)}`,
        );
      }
    } else {
      const ensured = ensureParticipantsTsv(tree);
      if (ensured.contentToCommit) {
        autoParticipantsToCommit = ensured.contentToCommit;
        participantsTsv = ensured.contentToCommit;
        // "pending commit": the in-memory content drives subject_count for
        // this enrichment run, but the file isn't in the repo until the
        // commit at the bottom of this function succeeds. If that commit
        // fails, D1 will carry a subject_count derived from a file the
        // repo doesn't have until the next sweep regenerates it.
        console.log(
          `[llm-enrich] Auto-generated placeholder participants.tsv for ${datasetId} (pending commit): ${ensured.subjects.length} subjects (${ensured.subjects.slice(0, 3).join(", ")}${ensured.subjects.length > 3 ? ", ..." : ""})`,
        );
      }
    }

    // One registry cache for the run: stages 1b, 1d, and 2c all look DOIs up
    // in DataCite / Crossref, and each (registry, DOI) pair is fetched once.
    const registryCache: RegistryCache = new Map();

    // Stage 1b: ORCID discovery from referenced DOIs (deterministic, no LLM)
    let seededWithOrcids = seeded;
    let orcidDiscoveryCount = 0;
    try {
      const orcidResult = await discoverOrcidsFromReferencedDois(
        bidsDescription,
        seeded.authors,
        undefined,
        registryCache,
      );
      orcidDiscoveryCount = Object.keys(orcidResult.discoveries).length;
      if (orcidDiscoveryCount > 0) {
        seededWithOrcids = {
          ...seeded,
          authors: mergeOrcidDiscoveries(seeded.authors || {}, orcidResult.discoveries),
        };
        console.log(
          `[llm-enrich] Stage 1b (ORCID discovery): ${datasetId} - found ${orcidDiscoveryCount} ORCIDs from ${orcidResult.totalDoisQueried} DOIs`,
        );
      } else {
        console.log(
          `[llm-enrich] Stage 1b (ORCID discovery): ${datasetId} - no matches from ${orcidResult.totalDoisQueried} DOIs`,
        );
      }
    } catch (orcidErr) {
      console.warn(
        `[llm-enrich] Stage 1b (ORCID discovery) failed for ${datasetId}, continuing: ${errorMessage(orcidErr)}`,
      );
    }

    // Stage 1d: look up what each candidate DOI actually is (#1549), so the
    // LLM stages compare real titles/authors/years against this dataset
    // instead of guessing from bare DOI strings, and so the never-data-paper
    // guard can match BIDS-spec titles that are not on its DOI list.
    // Non-fatal: an empty resolution reproduces the pre-#1549 behavior, and
    // lookups that got no answer are counted as `failed` in the response.
    const candidateDois = collectCandidateDois(
      readmeContent,
      bidsDescription,
      seededWithOrcids.related_identifiers,
      datasetId,
    );
    let doiResolution: DoiResolution = EMPTY_DOI_RESOLUTION;
    try {
      doiResolution = await resolveDoisForEnrichment(candidateDois, registryCache);
      const { resolved, unresolved, failed, skipped } = doiResolution;
      const notes = [
        unresolved.length > 0 && `unresolved: ${unresolved.join(", ")}`,
        failed.length > 0 && `lookup failed: ${failed.join(", ")}`,
        skipped.length > 0 && `${skipped.length} over the cap not looked up`,
      ].filter(Boolean);
      console.log(
        `[llm-enrich] Stage 1d (DOI metadata): ${datasetId} - resolved ${resolved.length}/${resolved.length + unresolved.length + failed.length}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`,
      );
    } catch (resolveErr) {
      doiResolution = {
        ...EMPTY_DOI_RESOLUTION,
        failed: candidateDois.slice(0, MAX_RESOLVED_DOIS),
        skipped: candidateDois.slice(MAX_RESOLVED_DOIS),
      };
      console.warn(
        `[llm-enrich] Stage 1d (DOI metadata) failed for ${datasetId}, continuing without it: ${errorMessage(resolveErr)}`,
      );
    }
    guardContext = { datasetId, resolvedTitles: titlesByDoi(doiResolution) };
    // Only a DataCite `Dataset` may be marked IsDerivedFrom by the LLM.
    const derivableDois = datasetDoisOf(doiResolution);
    const resolveDemote = enforceNeverDataPaper(seededWithOrcids, guardContext);
    logDemote("resolve", resolveDemote);
    seededWithOrcids = resolveDemote.result;

    // Stage 2: LLM enrichment (adds description, keywords, methods, etc.)
    const llmPrune = pruneUnsourcedDois(
      await enrichFromReadme(readmeContent, bidsDescription, llmConfig, doiResolution),
      readmeContent,
      bidsDescription,
    );
    logPrune("enrich", llmPrune);
    const llmResult = llmPrune.result;
    const enrichDemote = enforceNeverDataPaper(
      mergeWithExisting(seededWithOrcids, llmResult, derivableDois),
      guardContext,
    );
    logDemote("enrich", enrichDemote);
    const enriched = enrichDemote.result;
    const enrichedFields = Object.keys(llmResult).filter(
      (k) => llmResult[k as keyof typeof llmResult] !== undefined,
    );
    console.log(
      `[llm-enrich] Stage 2 (enrich): ${datasetId} - extracted: ${enrichedFields.join(", ")}`,
    );

    // Stage 2b: MeSH term validation (NLM API, deterministic)
    let meshValidated = enriched;
    try {
      const meshResult = await validateMeshTerms(enriched);
      meshValidated = meshResult.metadata;
      if (meshResult.log.length > 0) {
        const counts = { confirmed: 0, corrected: 0, scheme_removed: 0 };
        for (const entry of meshResult.log) {
          counts[entry.action]++;
          if (entry.action === "corrected") {
            console.log(`[llm-enrich]   MeSH corrected: "${entry.term}" -> "${entry.mesh_label}"`);
          } else if (entry.action === "scheme_removed") {
            console.log(`[llm-enrich]   MeSH not found: "${entry.term}" (scheme stripped)`);
          }
        }
        console.log(
          `[llm-enrich] Stage 2b (MeSH): ${datasetId} - ${counts.confirmed} confirmed, ${counts.corrected} corrected, ${counts.scheme_removed} scheme removed`,
        );
      }
    } catch (meshErr) {
      console.warn(
        `[llm-enrich] Stage 2b (MeSH) failed for ${datasetId}, continuing with unchecked keywords: ${errorMessage(meshErr)}`,
      );
    }

    // Stage 2c: Second ORCID discovery pass using LLM-discovered DOIs.
    // The LLM may have found DOIs in the README that weren't in BIDS fields.
    try {
      const enrichedRels = meshValidated.related_identifiers || [];
      const alreadySeen = new Set(extractDoisFromBids(bidsDescription).map((e) => e.doi));
      const llmDois = extractDoisFromRelatedIdentifiers(enrichedRels, alreadySeen);
      if (llmDois.length > 0) {
        // Only pass Authors (not DOI fields) to avoid re-querying BIDS DOIs
        // already resolved in Stage 1b; only llmDois should be queried
        const secondPass = await discoverOrcidsFromReferencedDois(
          { Authors: bidsDescription.Authors },
          meshValidated.authors,
          llmDois,
          registryCache,
        );
        const newOrcids = Object.keys(secondPass.discoveries).length;
        if (newOrcids > 0) {
          meshValidated = {
            ...meshValidated,
            authors: mergeOrcidDiscoveries(meshValidated.authors || {}, secondPass.discoveries),
          };
          console.log(
            `[llm-enrich] Stage 2c (ORCID pass 2): ${datasetId} - found ${newOrcids} ORCIDs from ${llmDois.length} LLM-discovered DOIs`,
          );
        } else {
          console.log(
            `[llm-enrich] Stage 2c (ORCID pass 2): ${datasetId} - no matches from ${llmDois.length} LLM-discovered DOIs`,
          );
        }
      }
    } catch (orcid2Err) {
      console.warn(
        `[llm-enrich] Stage 2c (ORCID pass 2) failed for ${datasetId}, continuing: ${errorMessage(orcid2Err)}`,
      );
    }

    // Stage 3: LLM validation with feedback loop (up to 3 correction attempts)
    const MAX_CORRECTIONS = 3;
    let finalMetadata = meshValidated;
    let validationResult: {
      valid: boolean;
      blocking_issues: string[];
      warnings: string[];
    } | null = null;
    let correctionAttempts = 0;
    let issueCreationError: string | undefined;

    try {
      let currentMetadata = meshValidated;
      for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
        const validated = await validateMetadata(
          currentMetadata,
          readmeContent,
          bidsDescription,
          llmConfig,
          doiResolution,
        );
        validationResult = validated.validation;
        finalMetadata = validated.metadata;

        const label = attempt === 0 ? "validate" : `correction-${attempt}`;
        console.log(
          `[llm-enrich] Stage 3 (${label}): ${datasetId} - ${validated.validation.valid ? "PASSED" : "FAILED"}, blocking: ${validated.validation.blocking_issues.length}, warnings: ${validated.validation.warnings.length}`,
        );

        if (validated.validation.valid || attempt === MAX_CORRECTIONS) break;

        correctionAttempts++;
        console.log(
          `[llm-enrich] Correction attempt ${correctionAttempts}/${MAX_CORRECTIONS} for ${datasetId}`,
        );
        try {
          const correctionPrune = pruneUnsourcedDois(
            await correctFromFeedback(
              currentMetadata,
              validated.validation.blocking_issues,
              validated.validation.warnings,
              readmeContent,
              bidsDescription,
              llmConfig,
              doiResolution,
            ),
            readmeContent,
            bidsDescription,
          );
          logPrune(`correction-${correctionAttempts}`, correctionPrune);
          const correctionDemote = enforceNeverDataPaper(
            mergeWithExisting(currentMetadata, correctionPrune.result, derivableDois),
            guardContext,
          );
          logDemote(`correction-${correctionAttempts}`, correctionDemote);
          currentMetadata = correctionDemote.result;
        } catch (corrErr) {
          console.warn(
            `[llm-enrich] Correction attempt ${correctionAttempts} failed for ${datasetId}: ${errorMessage(corrErr)}`,
          );
          break;
        }
      }
    } catch (valErr) {
      console.warn(
        `[llm-enrich] Stage 3 (validate) failed for ${datasetId}, staying at 'enriched': ${errorMessage(valErr)}`,
      );
    }

    // If still not validated after all attempts, create a GitHub issue (if not already reported)
    if (
      finalMetadata.pipeline_stage !== "validated" &&
      validationResult &&
      validationResult.blocking_issues.length > 0
    ) {
      try {
        const issueTitle = `Metadata validation failed for ${datasetId}`;

        const existingResp = await fetch(
          `https://api.github.com/repos/nemarDatasets/${repoName}/issues?state=open&labels=metadata&per_page=100`,
          {
            headers: {
              Authorization: `token ${pat}`,
              Accept: "application/vnd.github+json",
            },
          },
        );
        let alreadyReported = false;
        if (existingResp.ok) {
          const existing = (await existingResp.json()) as Array<{ title: string }>;
          alreadyReported = existing.some((i) => i.title === issueTitle);
        } else {
          // Token missing issues:read, repo not found, or GitHub 5xx. We
          // fall through to issue creation rather than aborting, but log
          // loudly because the de-duplication guard is now bypassed and
          // repeated failures may file duplicate "Metadata validation
          // failed" issues.
          console.warn(
            `[llm-enrich] Could not list existing issues for ${datasetId} (HTTP ${existingResp.status}); proceeding with issue creation may duplicate`,
          );
        }

        if (alreadyReported) {
          console.log(
            `[llm-enrich] GitHub issue already exists for ${datasetId}, skipping creation`,
          );
        } else {
          const issueBody = [
            "## Metadata Validation Failed",
            "",
            `The automated metadata pipeline for **${datasetId}** could not reach the "validated" stage after ${correctionAttempts} correction attempt(s).`,
            "",
            "### Blocking Issues",
            ...validationResult.blocking_issues.map((i) => `- ${i}`),
            "",
            ...(validationResult.warnings.length > 0
              ? ["### Warnings", ...validationResult.warnings.map((w) => `- ${w}`), ""]
              : []),
            "### Next Steps",
            "1. Review the issues above and fix the underlying data (e.g., `dataset_description.json`)",
            "2. Push the fix to `main` to re-trigger the enrichment pipeline",
            "3. Or manually trigger the LLM Metadata Enrichment workflow",
            "",
            "*This issue was created automatically by the metadata pipeline.*",
          ].join("\n");

          const issueResp = await fetch(
            `https://api.github.com/repos/nemarDatasets/${repoName}/issues`,
            {
              method: "POST",
              headers: {
                Authorization: `token ${pat}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                title: issueTitle,
                body: issueBody,
                labels: ["metadata"],
              }),
            },
          );
          if (issueResp.ok) {
            console.log(
              `[llm-enrich] Created GitHub issue for unresolved validation failures on ${datasetId}`,
            );
          } else {
            const respBody = await issueResp.text();
            console.error(
              `[llm-enrich] Failed to create GitHub issue for ${datasetId}: HTTP ${issueResp.status}: ${respBody}`,
            );
          }
        }
      } catch (issueErr) {
        issueCreationError = errorMessage(issueErr);
        console.warn(
          `[llm-enrich] Failed to create GitHub issue for ${datasetId}: ${issueCreationError}`,
        );
      }
    }

    // Last word on relation types: whatever the stages above did, a
    // never-data-paper DOI leaves this function as References.
    const finalDemote = enforceNeverDataPaper(finalMetadata, guardContext);
    logDemote("final", finalDemote);
    finalMetadata = finalDemote.result;

    // Store source hash for future change detection
    finalMetadata.source_hash = sourceHash;

    // Pipeline LLM work is complete. Commit results; individual failures are
    // non-fatal since the expensive LLM calls already succeeded.
    // An anonymous deposit's committed metadata carries no attribution. This
    // is the last point before the document is both committed to the repo and
    // cached in D1, and it is a WRITER-side blind on purpose: the file is
    // backend-authored and publicly served, so filtering it at read time
    // would leave the names in the repo and in the manifest.
    const documentToCommit = isAnonymous(dataset)
      ? blindEnrichmentMetadata(finalMetadata)
      : finalMetadata;
    const metadataContent = JSON.stringify(documentToCommit, null, 2);
    let commitError: string | undefined;
    let bidsignoreError: string | undefined;
    let cacheError: string | undefined;
    const commitPayload = buildEnrichmentCommitPayload(
      metadataContent,
      [".nemar/"],
      `Update NEMAR metadata (pipeline: ${finalMetadata.pipeline_stage})`,
    );
    const commitMessage = commitPayload.commit_message;
    const bidsignoreEntries = commitPayload.bidsignore_entries;

    let commitMode: "batched" | "single" | "client" = "single";
    if (clientCommits) {
      // Caller (Action) will perform the commit using its own GITHUB_TOKEN.
      commitMode = "client";
    } else {
      try {
        // Include the auto-generated participants.tsv in the same commit
        // when stage 1c built one. Lands alongside .nemar/metadata.json
        // so a publish triggered on the same head sees the file.
        const additionalFiles = autoParticipantsToCommit
          ? [{ path: "participants.tsv", content: autoParticipantsToCommit }]
          : [];
        const result = await commitEnrichmentWithBidsignore(
          repoName,
          ref,
          ".nemar/metadata.json",
          metadataContent,
          bidsignoreEntries,
          commitMessage,
          pat,
          additionalFiles,
        );
        commitMode = result.commitMode;
        if (result.bidsignoreReadError) {
          bidsignoreError = result.bidsignoreReadError;
          console.warn(
            `[llm-enrich] Could not read .bidsignore for ${datasetId}; committed metadata alone (next validation may fail if .nemar/ is missing): ${result.bidsignoreReadError}`,
          );
        }
      } catch (err) {
        const msg = errorMessage(err);
        commitError = msg;
        if (err instanceof EnrichmentCommitError) {
          commitMode = err.commitMode;
          if (err.commitMode === "batched") bidsignoreError = msg;
          if (err.bidsignoreReadError && !bidsignoreError) {
            bidsignoreError = err.bidsignoreReadError;
          }
        }
        console.error(`[llm-enrich] Failed enrichment commit for ${datasetId}:`, err);
      }
    }

    // Cache in D1
    try {
      await env.DB.prepare(
        "UPDATE datasets SET enrichment_json = ?, sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.enrichment_updated_at', datetime('now')), updated_at = datetime('now') WHERE dataset_id = ?",
      )
        .bind(metadataContent, datasetId)
        .run();
    } catch (err) {
      cacheError = errorMessage(err);
      console.error(`[llm-enrich] Failed to cache enrichment in D1 for ${datasetId}:`, err);
    }

    // Populate first-class metadata columns (epic #417 phase 2). Reuses the
    // tree and participants.tsv already gathered above so no additional API
    // calls are needed beyond the one participants.tsv blob read. Non-fatal: a
    // failure here does not roll back the enrichment.
    //
    // s3Stats (Stage 1a above) is deliberately NOT threaded into file_size/
    // total_files here (#970, epic #967 Phase 3): it's the annex-blind
    // S3-objects sum, the exact source of the #967 incident, and this path has
    // no well-defined "is a version manifest available yet" point (enrichment
    // runs both pre-publish, when no manifest exists at all, and post-publish,
    // interleaved with the version-DOI refresh) to safely verify against one.
    // Leaving file_size/total_files/bytes_present/data_complete unset here lets
    // COALESCE preserve whatever refreshDatasetMetadata (dataset-reindex.ts,
    // which runs right after every version-DOI mint and DOES verify the
    // manifest) or the `admin data-integrity-sweep` backfill last wrote,
    // instead of this run clobbering the honest value back to the S3 sum on
    // every re-enrichment. s3Stats itself stays in use above for the
    // human-readable `seeded.sizes` LLM-prompt field, unrelated to these columns.
    let metadataColumnsError: string | undefined;
    try {
      const cols = computeDatasetMetadataColumns({
        treePaths,
        participantsTsv,
        s3Stats: null,
      });
      await writeDatasetMetadataColumns(env.DB, datasetId, cols);
      console.log(
        `[llm-enrich] Metadata columns: ${datasetId} - subjects=${cols.subject_count}, modalities=${cols.modalities}, files=${cols.total_files}`,
      );

      const license = typeof finalMetadata.license === "string" ? finalMetadata.license : null;
      // Prefer the LLM-polished title; fall back to null (NOT the dataset id)
      // so COALESCE preserves the existing/BIDS name when the LLM produced no
      // title. description is null-preserved the same way.
      const enrichedTitle =
        (typeof finalMetadata.title === "string" && finalMetadata.title) || null;
      const enrichedDescription =
        (typeof finalMetadata.description === "string" && finalMetadata.description) || null;
      // Anonymity is NOT applied here. `writeDatasetCatalogFields` is the one
      // writer of `datasets.authors` and withholds the value in its own
      // UPDATE, deciding from the row rather than from an argument -- so this
      // call site passes the real authors and cannot get the rule wrong, and
      // neither can the next caller.
      const enrichedAuthors = authorsFromEnrichment(finalMetadata);
      const bidsVersion =
        typeof bidsDescription.BIDSVersion === "string" ? bidsDescription.BIDSVersion : null;
      // BIDS-native sessions_count from ses-* dirs (#657). 0 (no session layer)
      // -> null so COALESCE preserves any backfilled value rather than writing 0.
      const sessionsCount = treePaths.length ? countSessionDirs(treePaths) || null : null;

      // #646: write the metadata columns on the `datasets` source of truth. A
      // failure here is a real error, so we deliberately let it propagate to the
      // outer catch (-> metadataColumnsError, persisted on the row and surfaced
      // in the response) rather than swallow it.
      await writeDatasetCatalogFields(env.DB, datasetId, {
        name: enrichedTitle,
        description: enrichedDescription,
        authors: enrichedAuthors,
        license,
        readme: readmeContent || null, // empty README -> preserve existing
        bids_version: bidsVersion,
        sessions_count: sessionsCount,
      });

      // Best-effort re-embed (internally guarded, never throws).
      await reembedDatasetVector(env.DB, env.AI, env.VECTORIZE, datasetId, embedsNonPublic(env));
    } catch (err) {
      metadataColumnsError = errorMessage(err);
      console.error(`[llm-enrich] Failed to write metadata columns for ${datasetId}:`, err);
    }
    try {
      await env.DB.prepare(
        `UPDATE datasets SET metadata_columns_error = ?, updated_at = datetime('now') WHERE dataset_id = ?`,
      )
        .bind(metadataColumnsError ?? null, datasetId)
        .run();
    } catch (errFieldErr) {
      console.warn(
        `[llm-enrich] Failed to record metadata_columns_error for ${datasetId}: ${errorMessage(errFieldErr)}`,
      );
    }

    // Sync DOI metadata after enrichment if dataset has an EZID DOI.
    // Covers title, description, keywords, related identifiers, etc.
    let doiSyncError: string | undefined;
    let doiSyncOutcome: DoiSyncOutcome | undefined;
    const doiUploader = resolveOwnerIdentity(dataset);
    if (dataset.concept_doi && isAnonymous(dataset)) {
      // DO NOT SYNC (#1407). This block rebuilds the DataCite document from
      // live DB state and pushes it to EZID, and it reads `finalMetadata` and
      // `resolveOwnerIdentity` -- the UNBLINDED document and the real
      // depositor -- so running it would undo, in the same function call, the
      // blind applied a hundred lines above: the curator, the authors, the
      // funders and the geo-locations would all land in the record.
      //
      // Skipping rather than pushing a blinded document is the conservative
      // half: an anonymous deposit's identifier is `reserved` and therefore
      // not harvested, so there is nothing to keep current, and a blinded
      // push would still be a write whose correctness depends on this blind
      // never being bypassed. The record is rebuilt at publication, when the
      // attribution is real.
      const message = `DOI metadata sync skipped for ${datasetId}: the dataset is an anonymous deposit, so the rebuilt record would name the concealed depositor. The record is refreshed when the deposit is de-anonymized and published.`;
      console.log(`[llm-enrich] ANONYMITY SKIP ${message}`);
      doiSyncOutcome = { status: "skipped", reason: ANONYMOUS_DEPOSIT_REASON, message };
    } else if (dataset.concept_doi && refreshWouldStripAttribution(dataset, doiUploader)) {
      // DO NOT SYNC (#1255). This path runs automatically from the
      // README/dataset_description webhook and from `nemar admin reindex
      // --bulk`, and it rebuilds the DataCite document from live DB state.
      // For a published dataset whose owner has no researcher name on file
      // -- most of the catalogue until `nemar admin backfill-names --apply`
      // has been run -- the rebuilt document has NO DataCurator, and pushing
      // it would delete the curator from a permanent record while logging
      // success. Skipping leaves the existing record intact; the metadata
      // this run would have refreshed is re-synced by the next enrichment
      // after the name lands.
      const message = `DOI metadata sync skipped for ${datasetId}: the owner has no researcher name on file, so the rebuilt record would drop the existing DataCurator. Run \`nemar admin backfill-names --apply\`, then re-run enrichment.`;
      console.error(`[llm-enrich] ATTRIBUTION SKIP ${message}`);
      doiSyncOutcome = { status: "skipped", reason: OWNER_NAME_MISSING_REASON, message };
    } else if (dataset.concept_doi) {
      try {
        const ezidAuth = resolveEzidAuth(
          {
            EZID_USERNAME: env.EZID_USERNAME,
            EZID_PASSWORD: env.EZID_PASSWORD,
            EZID_SANDBOX_USERNAME: env.EZID_SANDBOX_USERNAME,
            EZID_SANDBOX_PASSWORD: env.EZID_SANDBOX_PASSWORD,
          },
          !!dataset.is_sandbox,
        );

        const conceptIdentifier = conceptEzidIdentifier(dataset.concept_doi);
        const doi = extractDoi(conceptIdentifier);
        let doiEnrichment = buildOrcidEnrichment(bidsDescription, doiUploader);
        const committedMeta = parseNemarMetadata(finalMetadata);
        if (committedMeta) {
          doiEnrichment = nemarMetadataToEnrichment(committedMeta, doiEnrichment);
        }
        const dataciteMetadata = bidsToDataCite(datasetId, doi, bidsDescription, doiEnrichment);
        const dataciteXml = buildDataCiteXml(dataciteMetadata);
        await updateIdentifier(ezidAuth, conceptIdentifier, { dataciteXml });
        console.log(`[llm-enrich] Synced DOI metadata for ${datasetId}`);
      } catch (doiErr) {
        doiSyncError = errorMessage(doiErr);
        const isConfigError = doiSyncError.includes("not configured");
        if (isConfigError) {
          console.error(
            `[llm-enrich] EZID credentials missing for ${datasetId}; DOI metadata will not be updated`,
          );
        } else {
          console.error(`[llm-enrich] Failed to sync DOI metadata for ${datasetId}:`, doiErr);
        }
      }
    }

    const estCostUsd = estimateUsageCostUsd(llmUsage);
    console.log(
      `[llm-enrich] LLM usage for ${datasetId}: ${llmUsage.calls} calls, ${llmUsage.input_tokens} in, ${llmUsage.output_tokens} out (~$${estCostUsd})`,
    );
    recordLlmUsage(env, {
      datasetId,
      outcome: "ok",
      calls: llmUsage.calls,
      inputTokens: llmUsage.input_tokens,
      outputTokens: llmUsage.output_tokens,
      estCostUsd,
    });

    return {
      ok: true,
      status: 200,
      body: {
        message: `Metadata pipeline completed (stage: ${finalMetadata.pipeline_stage})`,
        dataset_id: datasetId,
        pipeline_stage: finalMetadata.pipeline_stage,
        llm_usage: { ...llmUsage, est_cost_usd: estCostUsd },
        ...(prunedDois.length > 0 && { pruned_dois: prunedDois }),
        ...(demotedDois.length > 0 && { demoted_dois: demotedDois }),
        ...(droppedSelfDois.length > 0 && { self_dois_dropped: droppedSelfDois }),
        doi_resolution: summarizeDoiResolution(doiResolution),
        seeded_fields: {
          authors: Object.keys(seeded.authors || {}).length,
          related_identifiers: (seeded.related_identifiers || []).length,
          funding_references: (seeded.funding_references || []).length,
          orcids_discovered: orcidDiscoveryCount,
        },
        enriched_fields: enrichedFields,
        validation: validationResult
          ? {
              valid: validationResult.valid,
              blocking_issues: validationResult.blocking_issues,
              warnings: validationResult.warnings,
            }
          : null,
        commit_mode: commitMode,
        // Returned only when the caller requested `client_commits: true`.
        // The Action picks up these fields and performs the commit itself
        // using GITHUB_TOKEN. See buildEnrichmentCommitPayload for the
        // canonical shape.
        ...(clientCommits ? { client_commits: true as const, ...commitPayload } : {}),
        ...(commitError && { commit_error: commitError }),
        ...(bidsignoreError && { bidsignore_error: bidsignoreError }),
        ...(cacheError && { cache_error: cacheError }),
        ...(metadataColumnsError && { metadata_columns_error: metadataColumnsError }),
        ...(issueCreationError && { issue_creation_error: issueCreationError }),
        ...(doiSyncError && { doi_sync_error: doiSyncError }),
        ...(doiSyncOutcome && { doi_sync: doiSyncOutcome }),
      },
    };
  } catch (error) {
    console.error(`[llm-enrich] Failed for ${datasetId}:`, error);
    // Meter spend even on failure: the LLM calls that ran were still billed.
    recordLlmUsage(env, {
      datasetId,
      outcome: "failed",
      calls: llmUsage.calls,
      inputTokens: llmUsage.input_tokens,
      outputTokens: llmUsage.output_tokens,
      estCostUsd: estimateUsageCostUsd(llmUsage),
    });
    return {
      ok: false,
      status: 500,
      body: {
        error: "LLM enrichment failed",
        details: errorMessage(error),
      },
    };
  }
}
