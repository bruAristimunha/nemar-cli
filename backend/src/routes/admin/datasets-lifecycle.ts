/**
 * Admin routes: dataset lifecycle operations — backfill sweeps (archive,
 * zarr, channel-montage, HED), manifest generation/dispatch and coverage,
 * doctor scan/fix, dataset reset/delete/bulk-delete, metadata reindex, and
 * Vectorize re-embedding.
 *
 * Moved verbatim from routes/admin.ts in #903 (epic #902); the only
 * intentional changes are import paths, `adminRoutes` -> `admin`, and
 * audit-log INSERTs routed through auditLogStatement().
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { auditLogStatement } from "../../db/audit-log";
import { SYSTEM_USER_ID } from "../../lib/constants";
import {
  ANONYMITY_SWEEP_DEFAULT,
  ANONYMITY_SWEEP_RESET_SQL,
  runAnonymitySweep,
} from "../../services/anonymity-sweep";
import { ARCHIVE_SKIP_UPDATE_SQL, decideArchiveSweepOutcome } from "../../services/archive-policy";
import {
  AVAILABILITY_REPORT_SWEEP_MAX,
  AvailabilityReportError,
  runAvailabilityReportSweep,
  writeAvailabilityReport,
} from "../../services/availability-report";
import { stampDatasetIntegrity, writeVersionHed } from "../../services/dataset-metadata-columns";
import {
  DatasetReindexError,
  type ReindexFilter,
  buildReindexFilterQuery,
  refreshDatasetMetadata,
  runEnrichmentForDataset,
} from "../../services/dataset-reindex";
import { reembedDatasetVector } from "../../services/dataset-search";
import { ProdRepoFenceError, deleteDatasetCascade } from "../../services/deletion";
import { DOCTOR_CHECKS, getCheck, listChecks } from "../../services/doctor/registry";
import type { CheckContext, Finding } from "../../services/doctor/types";
import type { DoiResolutionSummary } from "../../services/doi-metadata";
import { exemplarOrFragment } from "../../services/exemplar";
import {
  addCollaborator,
  createRepository,
  deleteRepository,
  getBidsTreeStats,
  triggerManifestGeneration,
} from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { verifyDatasetVersionS3 } from "../../services/import-integrity";
import type { LlmUsageTotals } from "../../services/llm-enrich";
import { generateManifest } from "../../services/manifest";
import { buildCoverageReport } from "../../services/manifest-coverage";
import {
  RECORDING_STATS_SWEEP_RESET_SQL,
  runRecordingStatsSweep,
} from "../../services/recording-stats-sweep";
import { errorMessage } from "../../services/repo-metadata";
import {
  deleteDatasetObjects,
  getArchiveSize,
  getManifest,
  getZarrIndex,
  uploadManifest,
} from "../../services/s3";
import {
  SIGNAL_DEFAULTS_SWEEP_RESET_SQL,
  runSignalDefaultsSweep,
} from "../../services/signal-defaults-sweep";
import { hasRole } from "../../types/bindings";
import { getS3Config } from "./shared";
import type { AdminRouter } from "./shared";

/**
 * Every sweep below that skips sandbox rows carves the exemplar fleet back in with
 * `exemplarOrFragment()` (#1496, as #1168 did for the signal-defaults sweep and the
 * availability report): exemplars are inserted `is_sandbox = 1`, and they are the
 * staging catalog's copies of real datasets, so they must carry the facts these
 * sweeps give production's datasets, or test.nemar.org describes them differently
 * (a converted exemplar with no Zarr tag). No `is_exemplar = 1` row exists in
 * production (migration 0057), so the carve-out selects nothing more there.
 */

/**
 * Per-candidate stamp writes for the four inline route sweeps below
 * (archive / zarr / channel-montage / hed), exported so tests can exercise
 * the exact SQL text: each is only reachable end-to-end after a real
 * S3 LIST/GET or GitHub tree walk, which tests cannot perform. The
 * COALESCE in every one is load-bearing (#1183): json_set on a NULL
 * sweep_stamps column returns NULL and silently discards the stamp,
 * leaving the row a permanent re-sweep candidate -- the sweep would
 * reprocess it every run, forever, under a green log.
 */
export const ARCHIVE_SWEEP_READY_SQL =
  "UPDATE datasets SET archive_status = 'ready', archive_size = ?, sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now')), archive_skip_reason = NULL WHERE dataset_id = ?";
/**
 * The sweep's skip path (#1514): literally `ARCHIVE_SKIP_UPDATE_SQL`, not a
 * hand-copy. The prior copy here only set `archive_skip_reason` and left
 * `archive_status` untouched, so a dataset that grew over the size policy
 * after an old zip was marked 'ready' kept reading 'ready' forever -- the
 * skip never cleared it, unlike the webhook's own skip branch.
 */
export const ARCHIVE_SWEEP_SKIP_SQL = ARCHIVE_SKIP_UPDATE_SQL;
export const ARCHIVE_SWEEP_STAMP_ONLY_SQL =
  "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now')) WHERE dataset_id = ?";
export const ZARR_SWEEP_READY_SQL = `UPDATE datasets
             SET zarr_status = 'ready',
                 zarr_store_count = ?,
                 zarr_index_etag = COALESCE(?, zarr_index_etag),
                 zarr_source_commit = COALESCE(?, zarr_source_commit),
                 sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.zarr_checked_at', datetime('now'))
             WHERE dataset_id = ?`;
export const ZARR_SWEEP_STAMP_ONLY_SQL =
  "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.zarr_checked_at', datetime('now')) WHERE dataset_id = ?";
/**
 * The two GitHub-backed sweeps' `remaining` counts, exported for the same reason
 * as the writes above: each runs only after a real GitHub token fetch and tree
 * walk, which tests cannot perform, so a test exercises the exact SQL text on a
 * real database instead of a hand copy.
 */
export const CHANNEL_MONTAGE_SWEEP_REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets
       WHERE github_repo IS NOT NULL
         AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
         AND modalities LIKE '%eeg%'
         AND json_extract(sweep_stamps, '$.channel_montage_checked_at') IS NULL`;
export const HED_SWEEP_REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets
       WHERE github_repo IS NOT NULL
         AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
         AND json_extract(sweep_stamps, '$.hed_checked_at') IS NULL`;
export const CHANNEL_MONTAGE_SWEEP_WRITE_SQL = `UPDATE datasets
           SET n_channels = ?, electrode_system = ?,
               sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.channel_montage_checked_at', datetime('now'))
           WHERE dataset_id = ?`;
export const HED_SWEEP_WRITE_SQL = `UPDATE datasets
             SET has_hed = ?, hed_version = ?,
                 sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.hed_checked_at', datetime('now'))
             WHERE dataset_id = ?`;
export const HED_SWEEP_STAMP_ONLY_SQL =
  "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.hed_checked_at', datetime('now')) WHERE dataset_id = ?";

/**
 * Bound on how many findings an UN-NARROWED `POST /admin/doctor/fix` call
 * (no `dataset_id`) applies in one Worker invocation (issue #1135). The
 * 2026-08-23 nm000225 incident (see AGENTS.md's manifest-healing note and
 * the memory it left behind) hit this exact shape: the missing-manifest
 * check's remediation calls GitHub REST + S3 per finding, and a
 * catalog-wide call re-scans (up to ~800 GETs) AND fixes everything in one
 * request, which starves under GitHub App rate limits and the Worker's
 * subrequest budget well before it finishes.
 *
 * Default 25, clamped to a max of 100 (mirrors the hed-sweep /
 * data-integrity-sweep clamp pattern below, `Math.min(Math.max(n, 1), MAX)`)
 * -- a caller can request more per call via `limit` in the body, but never
 * an unbounded one. 100 findings at missing-manifest's ~3 subrequests each
 * (S3 head-check, GitHub generateManifest, S3 upload) stays a small
 * fraction of the Workers Paid plan's 1,000-subrequest cap.
 *
 * A dataset_id-narrowed call is UNAFFECTED (no cap, no `remaining`): its
 * findings are already scoped to one dataset and stay small -- this is
 * exactly the `nemar admin doctor fix` per-dataset shape the incident
 * write-up says to prefer.
 */
export const DOCTOR_FIX_DEFAULT_LIMIT = 25;
export const DOCTOR_FIX_MAX_LIMIT = 100;

export function registerDatasetLifecycleRoutes(admin: AdminRouter): void {
  /**
   * POST /admin/datasets/archive-sweep?limit=N — one-time/periodic backfill that
   * seeds the archive_status / archive_size columns (migration 0036) from S3 for
   * the observability dashboard (epic #695). Going-forward writes land via
   * /webhooks/archive-ready; this seeds historical archives that predate it.
   *
   * Bounded per invocation (default 50, max 200) to stay under the Worker
   * subrequest cap — getArchiveSize LISTs `<id>/archives/` once per dataset. Run
   * repeatedly until `remaining` reaches 0. Idempotent: only rows never checked
   * (archive_checked_at IS NULL) are candidates, so a re-run picks up where it
   * left off.
   */
  admin.post("/datasets/archive-sweep", async (c) => {
    const db = c.env.DB;
    const limitRaw = Number.parseInt(c.req.query("limit") || "50", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    // Candidates: real (non-catalog), public, non-sandbox (exemplars included) datasets we have never
    // checked for an archive. Public-only because archives are a published-data
    // concern and the data-plane download is public-only (loadPublishedDataset).
    // A bare throw here (e.g. migration 0036 not yet applied) would surface a
    // contextless 500, so handle it explicitly.
    let candidates: { dataset_id: string; file_size: number | null; total_files: number | null }[];
    try {
      const candidateRows = await db
        .prepare(
          // file_size/total_files (migration 0020) let us mark an oversized dataset
          // with no archive as 'skipped' (#752) instead of just 'absent'.
          `SELECT dataset_id, file_size, total_files FROM datasets
         WHERE owner_user_id != ${SYSTEM_USER_ID}
           AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
           AND visibility = 'public'
           AND json_extract(sweep_stamps, '$.archive_checked_at') IS NULL
         ORDER BY dataset_id
         LIMIT ?`,
        )
        .bind(limit)
        .all<{ dataset_id: string; file_size: number | null; total_files: number | null }>();
      candidates = candidateRows.results ?? [];
    } catch (err) {
      console.error("[archive-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (is migration 0036 applied?)" },
        500,
      );
    }

    const s3 = getS3Config(c.env);
    let ready = 0;
    let absent = 0;
    let skipped = 0;
    const errors: { dataset_id: string; error: string }[] = [];

    for (const { dataset_id, file_size, total_files } of candidates) {
      // Separate try/catch per phase so an error is attributed to the operation
      // that failed (S3 LIST vs D1 write), not lumped together.
      let size: number;
      try {
        size = await getArchiveSize(s3, dataset_id);
      } catch (err) {
        errors.push({
          dataset_id,
          error: `s3: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      // Policy wins over "a zip happens to exist" (#1514): a dataset over the
      // size policy is ALWAYS 'skip', regardless of whether getArchiveSize
      // found a zip under its archive prefix (grew past the ceiling since an
      // old build, or a zip left over from before the policy existed).
      const outcome = decideArchiveSweepOutcome(size, { file_size, total_files });
      try {
        // Exhaustive on `outcome.action` (matching `processOne`'s switch in
        // `scripts/rename-archives.ts`): the `default` branch's `never`
        // assignment fails the build if `ArchiveSweepOutcome` ever grows a
        // new action without a case here to handle it.
        switch (outcome.action) {
          case "ready":
            // Clear any stale archive_skip_reason: a real, in-policy zip exists (#752).
            await db.prepare(ARCHIVE_SWEEP_READY_SQL).bind(outcome.size, dataset_id).run();
            ready++;
            break;
          case "skip":
            // Over the size policy: record WHY no zip is advertised
            // (archive_skip_reason) so the UI shows the direct-download recipe
            // instead of "missing archive", and clear archive_status the same
            // way the ready webhook's skip branch does (#1514) -- a leftover
            // zip must not keep reading as 'ready'.
            await db.prepare(ARCHIVE_SWEEP_SKIP_SQL).bind(outcome.reason, dataset_id).run();
            skipped++;
            break;
          case "absent":
            // Checked, no archive on S3, and in policy: genuinely absent.
            await db.prepare(ARCHIVE_SWEEP_STAMP_ONLY_SQL).bind(dataset_id).run();
            absent++;
            break;
          default: {
            const _exhaustive: never = outcome;
            throw new Error(`unhandled ArchiveSweepOutcome action: ${JSON.stringify(_exhaustive)}`);
          }
        }
      } catch (err) {
        // S3 confirmed the size; only the D1 write failed. Note the branch
        // (ready vs skip/absent) + size so a re-run's duplicate entry is
        // explicable and a dropped archive_skip_reason write is attributable,
        // not masked as "ready".
        errors.push({
          dataset_id,
          error: `d1 write [${outcome.action}] (s3 size=${size}): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const remainingRow = await db
      .prepare(
        `SELECT COUNT(*) as n FROM datasets
       WHERE owner_user_id != ${SYSTEM_USER_ID}
         AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
         AND visibility = 'public'
         AND json_extract(sweep_stamps, '$.archive_checked_at') IS NULL`,
      )
      .first<{ n: number }>()
      .catch((err) => {
        console.error("[archive-sweep] remaining count failed:", err);
        return null;
      });

    // ok=false when any candidate errored so a scripted caller can gate on it
    // instead of seeing a 200 while nothing was written.
    if (candidates.length > 0 && errors.length === candidates.length) {
      console.error(
        `[archive-sweep] all ${candidates.length} candidates failed; first: ${errors[0]?.error}`,
      );
    }
    return c.json({
      ok: errors.length === 0,
      checked: candidates.length,
      ready,
      absent,
      skipped,
      errors,
      remaining: remainingRow?.n ?? null,
    });
  });

  /**
   * POST /admin/datasets/zarr-sweep?limit=N — one-time/periodic backfill that
   * reconciles the datasets.zarr_status column (migration 0035) from S3 truth for
   * the observability dashboard (epic #695). The Hallu backfill cron wrote zarr
   * stores to S3 but never POSTed /webhooks/zarr-ready, so ~213 already-converted
   * public datasets sit at zarr_status NULL while the viewer streams them fine.
   * This is the zarr analogue of /datasets/archive-sweep; the going-forward fix is
   * a /webhooks/zarr-ready POST from the Hallu driver.
   *
   * Bounded per invocation (default 50, max 200): getZarrIndex does ONE signed GET
   * of `<id>/zarr/index.json` per dataset (cheaper than a LIST). Idempotent via
   * the zarr_checked_at column (migration 0038): only rows never confirmed by the
   * webhook AND never checked by the sweep are candidates, so an absent-zarr
   * dataset is stamped once and never rescanned. Run until `remaining` reaches 0.
   */
  admin.post("/datasets/zarr-sweep", async (c) => {
    const db = c.env.DB;
    const limitRaw = Number.parseInt(c.req.query("limit") || "50", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    // Candidates: real (non-catalog), public, non-sandbox (exemplars included) datasets whose zarr
    // state is still unknown — neither the webhook (zarr_status) nor a prior sweep
    // (zarr_checked_at) has touched them. Public-only because zarr.nemar.org only
    // serves public datasets (zarr-data.ts). Mirrors archive-sweep's candidacy.
    let candidates: { dataset_id: string }[];
    try {
      const candidateRows = await db
        .prepare(
          `SELECT dataset_id FROM datasets
         WHERE owner_user_id != ${SYSTEM_USER_ID}
           AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
           AND visibility = 'public'
           AND zarr_status IS NULL
           AND json_extract(sweep_stamps, '$.zarr_checked_at') IS NULL
         ORDER BY dataset_id
         LIMIT ?`,
        )
        .bind(limit)
        .all<{ dataset_id: string }>();
      candidates = candidateRows.results ?? [];
    } catch (err) {
      console.error("[zarr-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (is migration 0038 applied?)" },
        500,
      );
    }

    const s3 = getS3Config(c.env);
    let ready = 0;
    let absent = 0;
    const errors: { dataset_id: string; error: string }[] = [];

    for (const { dataset_id } of candidates) {
      // ONE signed GET of <id>/zarr/index.json. Returns null on 404 OR 403 (both
      // treated as absent -> stamp checked, see getZarrIndex); only a non-2xx infra
      // error or bad JSON throws, which is recorded below and keeps the row a
      // candidate for the next run (not mis-stamped absent).
      let index: Awaited<ReturnType<typeof getZarrIndex>>;
      try {
        index = await getZarrIndex(s3, dataset_id);
      } catch (err) {
        errors.push({
          dataset_id,
          error: `s3: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      try {
        if (index) {
          // Converted: record latest-only state, mirroring /webhooks/zarr-ready.
          // zarr_converted_at is left untouched (we don't know the true backfill
          // time and won't fabricate one); zarr_status='ready' is the truth signal
          // the dashboard reads. ETag + source_commit are seeded for free.
          await db
            .prepare(ZARR_SWEEP_READY_SQL)
            .bind(index.storeCount, index.etag, index.sourceCommit, dataset_id)
            .run();
          ready++;
        } else {
          // No index.json: stamp checked so the sweep won't rescan, but leave
          // zarr_status NULL (absence is not a 'failed' conversion).
          await db.prepare(ZARR_SWEEP_STAMP_ONLY_SQL).bind(dataset_id).run();
          absent++;
        }
      } catch (err) {
        errors.push({
          dataset_id,
          error: `d1${index ? ` (stores=${index.storeCount})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const remainingRow = await db
      .prepare(
        `SELECT COUNT(*) as n FROM datasets
       WHERE owner_user_id != ${SYSTEM_USER_ID}
         AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
         AND visibility = 'public'
         AND zarr_status IS NULL
         AND json_extract(sweep_stamps, '$.zarr_checked_at') IS NULL`,
      )
      .first<{ n: number }>()
      .catch((err) => {
        console.error("[zarr-sweep] remaining count failed:", err);
        return null;
      });

    if (candidates.length > 0 && errors.length === candidates.length) {
      console.error(
        `[zarr-sweep] all ${candidates.length} candidates failed; first: ${errors[0]?.error}`,
      );
    }
    return c.json({
      ok: errors.length === 0,
      checked: candidates.length,
      ready,
      absent,
      errors,
      remaining: remainingRow?.n ?? null,
    });
  });

  /**
   * POST /admin/datasets/channel-montage-sweep?limit=N — one-time backfill that
   * seeds n_channels / electrode_system (migration 0054) for existing EEG datasets
   * (epic #854 phase 3, #859). Going-forward writes land via the reindex/enrichment
   * walk; this seeds the rows that predate it.
   *
   * Bounded per invocation (default 15, max 30): getBidsTreeStats fetches the root
   * tree + up to 25 subject subtrees + the two exemplar sidecar blobs per dataset,
   * so the cap keeps the run under the Worker subrequest limit. Run repeatedly until
   * `remaining` reaches 0. Idempotent: only rows never checked
   * (channel_montage_checked_at IS NULL) are candidates, so a re-run resumes.
   *
   * Writes the two columns DIRECTLY (not via writeDatasetMetadataColumns) so the
   * backfill does not bump updated_at/metadata_updated_at across every EEG dataset.
   */
  admin.post("/datasets/channel-montage-sweep", async (c) => {
    const db = c.env.DB;

    // ?reset=1 clears every probed row (channel_montage_checked_at + the two
    // columns -> NULL) so a corrected classifier can re-sweep from scratch. Used
    // after the BioSemi-detection fix (#865) to redo the dry-run batch. Direct
    // write, no updated_at bump. Returns the count cleared and does nothing else.
    if (c.req.query("reset") === "1") {
      const res = await db
        .prepare(
          `UPDATE datasets
         SET sweep_stamps = json_remove(sweep_stamps, '$.channel_montage_checked_at'),
             n_channels = NULL, electrode_system = NULL
         WHERE json_extract(sweep_stamps, '$.channel_montage_checked_at') IS NOT NULL`,
        )
        .run();
      return c.json({ reset: res.meta?.changes ?? 0 });
    }

    const limitRaw = Number.parseInt(c.req.query("limit") || "15", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 30) : 15;

    // Candidates: datasets backed by a GitHub repo (managed nm*/on*; catalog ds*
    // rows have none), with EEG in their modalities, not yet probed. `eeg` LIKE
    // also matches `ieeg`, but the probe only reads the `eeg/` datatype dir, so an
    // intracranial-only dataset simply yields no channel data and is marked checked.
    let candidates: { dataset_id: string; github_repo: string }[];
    try {
      const rows = await db
        .prepare(
          `SELECT dataset_id, github_repo FROM datasets
         WHERE github_repo IS NOT NULL
           AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
           AND modalities LIKE '%eeg%'
           AND json_extract(sweep_stamps, '$.channel_montage_checked_at') IS NULL
         ORDER BY dataset_id
         LIMIT ?`,
        )
        .bind(limit)
        .all<{ dataset_id: string; github_repo: string }>();
      candidates = rows.results ?? [];
    } catch (err) {
      console.error("[channel-montage-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (are migrations 0054/0055 applied?)" },
        500,
      );
    }

    let pat: string;
    try {
      pat = await getDatasetsToken(c.env);
    } catch (err) {
      console.error("[channel-montage-sweep] token fetch failed:", err);
      return c.json({ error: "Failed to obtain GitHub token" }, 500);
    }

    let populated = 0;
    let noData = 0;
    const errors: { dataset_id: string; error: string }[] = [];

    for (const { dataset_id, github_repo } of candidates) {
      const repoName = github_repo.split("/")[1];
      let nChannels: number | null = null;
      let electrodeSystem: string | null = null;
      if (!repoName) {
        errors.push({ dataset_id, error: `invalid github_repo: ${github_repo}` });
      } else {
        try {
          const stats = await getBidsTreeStats(repoName, "main", pat);
          nChannels = stats.nChannels ?? null;
          electrodeSystem = stats.electrodeSystem ?? null;
          if (nChannels != null || electrodeSystem != null) populated++;
          else noData++;
        } catch (err) {
          errors.push({
            dataset_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Mark checked regardless of outcome so `remaining` converges; write the two
      // columns directly (no updated_at bump). channel_montage_checked_at advances
      // even on a probe miss/error, so a failed dataset is not retried forever.
      try {
        await db
          .prepare(CHANNEL_MONTAGE_SWEEP_WRITE_SQL)
          .bind(nChannels, electrodeSystem, dataset_id)
          .run();
      } catch (err) {
        errors.push({
          dataset_id,
          error: `d1 write: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const remainingRow = await db
      .prepare(CHANNEL_MONTAGE_SWEEP_REMAINING_SQL)
      .first<{ n: number }>();

    return c.json({
      processed: candidates.length,
      populated,
      noData,
      errors,
      remaining: remainingRow?.n ?? null,
    });
  });

  /**
   * POST /admin/datasets/recording-stats-sweep?limit=N — backfill that seeds
   * dataset-level recording duration / count / channel-range stats (migration
   * 0070) from each dataset's zarr index (epic #1144 Phase 2, issue #1146).
   * Modelled directly on channel-montage-sweep above.
   *
   * One implementation, shared with the daily cron (backend/src/index.ts) --
   * the candidate query, the cap, the two write paths (success vs.
   * stamp-only) and the error collection all live in runRecordingStatsSweep
   * (services/recording-stats-sweep.ts) so the two callers cannot drift.
   * `?reset=1` clears the stamp + every stat column via the same file's
   * exported RECORDING_STATS_SWEEP_RESET_SQL, so a corrected aggregator can
   * re-sweep from scratch; the branch stays inline here (only the admin
   * route ever needs it) but the SQL text itself is imported, not
   * hand-copied.
   */
  admin.post("/datasets/recording-stats-sweep", async (c) => {
    const db = c.env.DB;

    if (c.req.query("reset") === "1") {
      try {
        const res = await db.prepare(RECORDING_STATS_SWEEP_RESET_SQL).run();
        return c.json({ reset: res.meta?.changes ?? 0 });
      } catch (err) {
        console.error("[recording-stats-sweep] reset failed:", err);
        return c.json({ error: "Failed to reset recording stats" }, 500);
      }
    }

    const limitRaw = Number.parseInt(c.req.query("limit") || "50", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

    try {
      const result = await runRecordingStatsSweep(c.env, { limit });
      return c.json(result);
    } catch (err) {
      console.error("[recording-stats-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (is migration 0070 applied?)" },
        500,
      );
    }
  });

  /**
   * POST /admin/datasets/signal-defaults-sweep?limit=N — backfill that seeds
   * BIDS signal defaults (migration 0072: sampling_frequency,
   * power_line_frequency, eeg_reference, placement_scheme) from each
   * dataset's exemplar `*_eeg.json` sidecar (epic #1144 Phase 2b, issue
   * #1153). Modelled on recording-stats-sweep above: one implementation
   * (services/signal-defaults-sweep.ts) so this route cannot drift from any
   * future caller. `?reset=1` clears the stamp + the four value columns via
   * the same file's exported SIGNAL_DEFAULTS_SWEEP_RESET_SQL.
   *
   * Bound tighter than recording-stats-sweep (default 15, max 30, not 200):
   * this hits the GitHub API (getBidsTreeStats: root tree + up to 25 subject
   * subtrees + up to 2 sidecar blobs per dataset), not S3 -- same cap as
   * channel-montage-sweep / hed-sweep.
   *
   * The catch below is now ACCURATE about what it catches (#1162 review,
   * I5): `runSignalDefaultsSweep` itself absorbs a GitHub-auth failure
   * (missing/invalid App credentials) into a normal 200 response with a
   * batch-level `errors` entry, rather than letting it propagate here to be
   * misreported as a missing migration -- so a throw reaching this catch
   * really does mean the candidate query failed.
   */
  admin.post("/datasets/signal-defaults-sweep", async (c) => {
    const db = c.env.DB;

    if (c.req.query("reset") === "1") {
      try {
        const res = await db.prepare(SIGNAL_DEFAULTS_SWEEP_RESET_SQL).run();
        return c.json({ reset: res.meta?.changes ?? 0 });
      } catch (err) {
        console.error("[signal-defaults-sweep] reset failed:", err);
        return c.json({ error: "Failed to reset signal defaults" }, 500);
      }
    }

    const limitRaw = Number.parseInt(c.req.query("limit") || "15", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 15;

    try {
      const result = await runSignalDefaultsSweep(c.env, { limit });
      return c.json(result);
    } catch (err) {
      console.error("[signal-defaults-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (are migrations 0072/0073 applied?)" },
        500,
      );
    }
  });

  /**
   * POST /admin/datasets/anonymity-sweep?limit=N — re-check anonymous deposits
   * against the identity-leak inventory (#1409, epic #1406).
   *
   * Reports; never repairs. A dataset that has already been disclosed cannot be
   * un-disclosed by flipping a flag, and an automatic fix would destroy the
   * evidence that the guarantee failed. Findings land in `sweep_stamps`, in an
   * `audit_log` row, and in mail to the depositor and the admins.
   *
   * `?reset=1` re-arms every anonymous deposit, clearing the ATTEMPT stamp as
   * well as the verdict — leaving the attempt would hold the row outside the
   * candidate window for another 20 hours, which is not a reset.
   *
   * Unguarded on purpose so an operator can run it against staging; the daily
   * cron goes through `runAnonymitySweepCron`, which is production-only because
   * this mints a GitHub App token against the shared org and emails a real
   * depositor.
   */
  admin.post("/datasets/anonymity-sweep", async (c) => {
    const db = c.env.DB;

    if (c.req.query("reset") === "1") {
      try {
        const res = await db.prepare(ANONYMITY_SWEEP_RESET_SQL).run();
        return c.json({ reset: res.meta?.changes ?? 0 });
      } catch (err) {
        console.error("[anonymity-sweep] reset failed:", err);
        return c.json({ error: "Failed to reset anonymity verdicts" }, 500);
      }
    }

    const limitRaw = Number.parseInt(c.req.query("limit") || String(ANONYMITY_SWEEP_DEFAULT), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : ANONYMITY_SWEEP_DEFAULT;

    try {
      const result = await runAnonymitySweep(c.env, { limit });
      // A batch in which every dataset errored is not a successful run. The CLI
      // already exits non-zero on it, but a dashboard, a curl or a future
      // scheduled caller reads the status code, and 200 tells all of them the
      // sweep is healthy while it is checking nothing.
      if (result.errors.length > 0 && result.results.length === 0) {
        return c.json(result, 503);
      }
      return c.json(result);
    } catch (err) {
      console.error("[anonymity-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (is migration 0085 applied?)" },
        500,
      );
    }
  });

  /**
   * POST /admin/datasets/hed-sweep?limit=N — one-time backfill that seeds HED
   * (has_hed / hed_version, migration 0056) for existing datasets (epic #869 phase
   * 3, #872). Going-forward writes land via the version-DOI reindex walk (phase 2);
   * this seeds rows that predate it.
   *
   * Unlike channel-montage-sweep there is NO modality filter: HED lives in
   * *_events.{json,tsv} across eeg/meg/ieeg/beh/func, so every managed dataset is a
   * candidate. getBidsTreeStats is subrequest-heavy, so the per-call cap (default
   * 15, max 30) matters more here. Run repeatedly until `remaining` reaches 0.
   * Idempotent: only rows never checked (hed_checked_at IS NULL) are candidates.
   *
   * Writes datasets.has_hed/hed_version DIRECTLY (no updated_at bump) and also the
   * LATEST version's dataset_versions row via writeVersionHed (HED is per-version).
   * Non-latest historical versions are not back-probed (would re-fetch each tagged
   * tree); they fill going forward at publish.
   */
  admin.post("/datasets/hed-sweep", async (c) => {
    const db = c.env.DB;

    // ?reset=1 clears every probed row (hed_checked_at + the two columns -> NULL)
    // so a corrected detector can re-sweep from scratch. datasets-level only: the
    // per-version dataset_versions rows are publish-time truth and get overwritten
    // when the re-sweep re-probes each dataset's latest version.
    if (c.req.query("reset") === "1") {
      const res = await db
        .prepare(
          `UPDATE datasets
         SET sweep_stamps = json_remove(sweep_stamps, '$.hed_checked_at'),
             has_hed = NULL, hed_version = NULL
         WHERE json_extract(sweep_stamps, '$.hed_checked_at') IS NOT NULL`,
        )
        .run();
      return c.json({ reset: res.meta?.changes ?? 0 });
    }

    const limitRaw = Number.parseInt(c.req.query("limit") || "15", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 30) : 15;

    // Candidates: every managed dataset (github_repo IS NOT NULL; catalog ds* rows
    // have none), not sandbox (exemplars included), not yet probed. latest_version drives the per-version
    // write -- null for unpublished datasets, which then get only the datasets-level
    // write (writeVersionHed is skipped, no spurious 0-row error).
    let candidates: { dataset_id: string; github_repo: string; latest_version: string | null }[];
    try {
      const rows = await db
        .prepare(
          `SELECT d.dataset_id, d.github_repo,
           (SELECT version FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id
            ORDER BY created_at DESC LIMIT 1) AS latest_version
         FROM datasets d
         WHERE d.github_repo IS NOT NULL
           AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR ${exemplarOrFragment("d")})
           AND json_extract(d.sweep_stamps, '$.hed_checked_at') IS NULL
         ORDER BY d.dataset_id
         LIMIT ?`,
        )
        .bind(limit)
        .all<{ dataset_id: string; github_repo: string; latest_version: string | null }>();
      candidates = rows.results ?? [];
    } catch (err) {
      console.error("[hed-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (is migration 0056 applied?)" },
        500,
      );
    }

    let pat: string;
    try {
      pat = await getDatasetsToken(c.env);
    } catch (err) {
      console.error("[hed-sweep] token fetch failed:", err);
      return c.json({ error: "Failed to obtain GitHub token" }, 500);
    }

    let withHed = 0;
    let withoutHed = 0;
    let unknown = 0;
    const errors: { dataset_id: string; error: string }[] = [];

    for (const { dataset_id, github_repo, latest_version } of candidates) {
      const repoName = github_repo.split("/")[1];
      // null = unclassified (probe couldn't run); 0 = checked, no HED; 1 = HED.
      let hasHedInt: number | null = null;
      let hedVersion: string | null = null;
      if (!repoName) {
        errors.push({ dataset_id, error: `invalid github_repo: ${github_repo}` });
        unknown++;
      } else {
        try {
          const stats = await getBidsTreeStats(repoName, "main", pat);
          hasHedInt = stats.hasHed == null ? null : stats.hasHed ? 1 : 0;
          hedVersion = stats.hedVersion ?? null;
          if (stats.hasHed === true) withHed++;
          else if (stats.hasHed === false) withoutHed++;
          else unknown++;
        } catch (err) {
          errors.push({ dataset_id, error: err instanceof Error ? err.message : String(err) });
          unknown++;
        }
      }
      // Persist HED. Order is deliberate for recoverability: write the per-version
      // row FIRST, then stamp datasets (hed_checked_at) LAST. A failure in either
      // write leaves the dataset UNstamped, so a plain re-run re-probes and retries
      // both (idempotent) -- never a split state where datasets is stamped but the
      // dataset_versions row stays NULL. The per-version write runs only when we
      // have a classification (hasHedInt != null) for a published version
      // (latest_version); with an explicit version it never 0-rows.
      try {
        if (hasHedInt != null && latest_version) {
          await writeVersionHed(db, dataset_id, latest_version, hasHedInt, hedVersion);
        }
        // Stamp checked regardless of probe outcome so `remaining` converges
        // (advances even on a probe miss/error -> a failing dataset is not retried
        // forever). A D1 write failure above skips this stamp and is retried.
        //
        // When the probe COULD NOT classify (hasHedInt null), only stamp -- do NOT
        // write NULL over an existing classification. The reindex/enrich path writes
        // has_hed without stamping hed_checked_at, so such a row is still a sweep
        // candidate; a transient probe miss here must not clobber that value to NULL.
        if (hasHedInt != null) {
          await db.prepare(HED_SWEEP_WRITE_SQL).bind(hasHedInt, hedVersion, dataset_id).run();
        } else {
          await db.prepare(HED_SWEEP_STAMP_ONLY_SQL).bind(dataset_id).run();
        }
      } catch (err) {
        errors.push({
          dataset_id,
          error: `d1 write: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const remainingRow = await db.prepare(HED_SWEEP_REMAINING_SQL).first<{ n: number }>();

    return c.json({
      processed: candidates.length,
      withHed,
      withoutHed,
      unknown,
      errors,
      remaining: remainingRow?.n ?? null,
    });
  });

  /**
   * POST /admin/datasets/data-integrity-sweep?limit=N[&older-than=N|&before=<ISO8601>]
   * — audits published datasets against their version manifest (epic #967
   * Phase 3, #970): per-key S3 presence at declared size
   * (verifyDatasetVersionS3), writing the honest bytes_present/data_complete
   * tri-state (migration 0059).
   *
   * Unlike hed-sweep this is a GENERAL, RE-RUNNABLE audit, not a one-shot
   * backfill: `?older-than=<days>` widens candidacy to already-checked rows
   * older than N days, so bit-rot (an object later deleted/corrupted after a
   * clean check) gets caught on an ongoing basis, not just once -- this is the
   * cron's moving re-audit window and must keep behaving that way. Without
   * either flag it behaves like hed-sweep -- drain `data_checked_at IS NULL`
   * and stop.
   *
   * `?before=<ISO8601>` (#980) is a DIFFERENT shape of widening: an ANCHORED
   * cutoff rather than a `now()`-relative one. A caller-driven convergence
   * loop (the CLI's `--reaudit`) captures ONE timestamp before its first call
   * and passes it on every call, so `remaining` strictly decreases to 0 as
   * each pass stamps `data_checked_at` to the current (later) time -- a row
   * just re-checked never re-qualifies against the fixed anchor. `older-than`
   * cannot converge this way: its window is relative to the ever-advancing
   * `now()`, so a row stamped mid-sweep can still be "more than N days old"
   * relative to a later tick's `now()` if the sweep runs long enough, and
   * `remaining` never reaches 0. `before` wins when both are supplied (it is
   * strictly more specific); bound through SQL's own `datetime()` so the
   * comparison normalizes the caller's ISO string to the same space-separated
   * `datetime('now')` format `data_checked_at` is always stamped with --
   * naive string comparison against a raw `T...Z` ISO literal would sort
   * incorrectly against that format for same-day timestamps.
   *
   * Only reads S3 and writes its own D1 columns -- no GitHub dispatch, no
   * email, no DOI mutation -- so unlike the Phase 2 retry engine (prod-only,
   * because it dispatches GitHub work and can email) this is safe to run in
   * every environment, including dev (dev D1 is exemplars-only, so it just
   * audits the exemplar fleet there).
   *
   * Bounded per invocation (default 15, max 30, mirroring hed-sweep's cap: a
   * manifest fetch + a full `<id>/objects/` LIST is real per-dataset work even
   * without any GitHub calls). Run repeatedly until `remaining` reaches 0.
   */
  admin.post("/datasets/data-integrity-sweep", async (c) => {
    const db = c.env.DB;

    // ?reset=1 clears every audited row (data_checked_at + the two columns ->
    // NULL) so a corrected verifier can re-sweep from scratch. datasets-level
    // only: the per-version dataset_versions rows are overwritten on re-sweep,
    // same asymmetry hed-sweep's reset uses.
    if (c.req.query("reset") === "1") {
      const res = await db
        .prepare(
          `UPDATE datasets
         SET sweep_stamps = json_remove(sweep_stamps, '$.data_checked_at'),
             data_complete = NULL, bytes_present = NULL
         WHERE json_extract(sweep_stamps, '$.data_checked_at') IS NOT NULL`,
        )
        .run();
      return c.json({ reset: res.meta?.changes ?? 0 });
    }

    const limitRaw = Number.parseInt(c.req.query("limit") || "15", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 30) : 15;

    const olderThanRaw = c.req.query("older-than");
    let olderThanDays: number | undefined;
    if (olderThanRaw !== undefined) {
      olderThanDays = Number.parseInt(olderThanRaw, 10);
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        return c.json({ error: `Invalid older-than: ${olderThanRaw}` }, 400);
      }
    }

    const beforeRaw = c.req.query("before");
    let beforeIso: string | undefined;
    if (beforeRaw !== undefined) {
      const beforeDate = new Date(beforeRaw);
      if (Number.isNaN(beforeDate.getTime())) {
        return c.json({ error: `Invalid before: ${beforeRaw}` }, 400);
      }
      beforeIso = beforeDate.toISOString();
    }

    // Default: one-shot drain (never-checked rows only). `before` (anchored,
    // convergent) wins over `older-than` (moving window, non-convergent) when
    // both are supplied -- see the doc comment above.
    let candidacyClause: string;
    let candidacyParams: (string | number)[];
    if (beforeIso != null) {
      candidacyClause =
        "(json_extract(d.sweep_stamps, '$.data_checked_at') IS NULL OR json_extract(d.sweep_stamps, '$.data_checked_at') < datetime(?))";
      candidacyParams = [beforeIso];
    } else if (olderThanDays != null) {
      candidacyClause =
        "(json_extract(d.sweep_stamps, '$.data_checked_at') IS NULL OR json_extract(d.sweep_stamps, '$.data_checked_at') < datetime('now', ?))";
      candidacyParams = [`-${olderThanDays} days`];
    } else {
      candidacyClause = "json_extract(d.sweep_stamps, '$.data_checked_at') IS NULL";
      candidacyParams = [];
    }

    // Candidates: every managed dataset (github_repo IS NOT NULL; catalog ds*
    // rows have none), not sandbox (exemplars included), not yet checked (or stale past --older-than).
    let candidates: { dataset_id: string }[];
    try {
      const rows = await db
        .prepare(
          `SELECT d.dataset_id
         FROM datasets d
         WHERE d.github_repo IS NOT NULL
           AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR ${exemplarOrFragment("d")})
           AND ${candidacyClause}
         ORDER BY d.dataset_id
         LIMIT ?`,
        )
        .bind(...candidacyParams, limit)
        .all<{ dataset_id: string }>();
      candidates = rows.results ?? [];
    } catch (err) {
      console.error("[data-integrity-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (is migration 0059 applied?)" },
        500,
      );
    }

    let complete = 0;
    let incomplete = 0;
    let unknown = 0;
    const errors: { dataset_id: string; error: string }[] = [];

    for (const { dataset_id } of candidates) {
      let integrity: Awaited<ReturnType<typeof verifyDatasetVersionS3>> | null = null;
      try {
        integrity = await verifyDatasetVersionS3(c.env, dataset_id);
      } catch (err) {
        errors.push({ dataset_id, error: err instanceof Error ? err.message : String(err) });
      }

      // Persist via the shared helper (#980) -- it mirrors the write order
      // that used to be inlined here: per-version row FIRST, then datasets
      // LAST, so a failure between the two leaves the dataset UNstamped and a
      // plain re-run redoes both (idempotent) rather than a split state.
      try {
        const outcome = await stampDatasetIntegrity(db, dataset_id, integrity);
        if (outcome === "complete") complete++;
        else if (outcome === "incomplete") incomplete++;
        else unknown++;
      } catch (err) {
        errors.push({
          dataset_id,
          error: `d1 write: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const remainingRow = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM datasets d
       WHERE d.github_repo IS NOT NULL
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR ${exemplarOrFragment("d")})
         AND ${candidacyClause}`,
      )
      .bind(...candidacyParams)
      .first<{ n: number }>();

    return c.json({
      processed: candidates.length,
      complete,
      incomplete,
      unknown,
      errors,
      remaining: remainingRow?.n ?? null,
    });
  });

  /**
   * POST /admin/datasets/availability-report-sweep?limit=N[&missing-only=1] —
   * backfill that generates + commits `.nemar/availability-report.json`
   * (services/availability-report.ts, epic #999 phase 1 #1000) for every
   * non-sandbox dataset (plus the exemplar fleet) that has a version and no
   * report yet, stamping availability_report_at (migration 0061).
   * Mirrors hed-sweep's shape (candidate/stamp/remaining) exactly. Candidate/
   * remaining SQL is built from availabilityReportSweepCandidateQuery /
   * availabilityReportSweepRemainingQuery (services/availability-report.ts) so
   * this handler and its test share one source of truth instead of a
   * hand-copied duplicate that can drift.
   *
   * Unlike data-integrity-sweep this WRITES to GitHub (writeAvailabilityReport
   * -> createOrUpdateFile), so it is a separate, GitHub-writing sweep on
   * purpose: data-integrity-sweep's "no GitHub side-effects" property (safe to
   * run in every environment, including dev/staging D1) is load-bearing and
   * must not be diluted by folding this in.
   *
   * `?missing-only=1` narrows candidacy to datasets already known incomplete
   * (data_complete = 0, migration 0059) — for a targeted re-run once recovery
   * work lands, without re-touching every already-complete dataset.
   *
   * Bounded per invocation by AVAILABILITY_REPORT_SWEEP_MAX (30, matching the
   * read-only sweeps; see the rationale on that constant). Each candidate here
   * still does a GitHub commit unlike hed-sweep/data-integrity-sweep: a ref
   * lookup (branchExists), then createOrUpdateFile's GET sha and PUT, so three
   * API calls (a refused row costs one, or two when the ref lookup 404s and
   * the repository is probed). A burst of write calls can trip GitHub's
   * secondary rate limit (the same failure mode the bulk-approval-rate-limit
   * precedent hit); what keeps 30 safe is that the loop is sequential and each
   * iteration is dominated by an S3 LIST plus a manifest walk, so the writes
   * are naturally spread. No in-Worker sleep between writes (that would eat
   * into the Worker's request duration budget), and none inside the calls
   * either: branchExists makes one interactive attempt and createOrUpdateFile
   * has no 403 backoff (its retry loop only covers a stale-SHA conflict), so a
   * rate-limited candidate just throws, lands in `errors`, and stays
   * unstamped. A candidate the write REFUSES (the repository has no `main`, or
   * is not visible to NEMAR) also lands in `errors`, with its `status`; see
   * AVAILABILITY_REPORT_SWEEP_BASE_WHERE for what that costs. The pacing
   * strategy is entirely external to this handler: the
   * small per-batch cap plus the CLI's inter-batch sleep between calls, and
   * an unstamped candidate is simply retried on the next sweep invocation
   * once GitHub's limit window has passed. Run repeatedly until `remaining`
   * reaches 0. Idempotent: only rows never stamped (availability_report_at IS
   * NULL) are candidates.
   */
  admin.post("/datasets/availability-report-sweep", async (c) => {
    const db = c.env.DB;

    // ?reset=1 clears every stamped row (availability_report_at -> NULL) so a
    // corrected report generator can re-sweep from scratch.
    if (c.req.query("reset") === "1") {
      const res = await db
        .prepare(
          `UPDATE datasets
         SET sweep_stamps = json_remove(sweep_stamps, '$.availability_report_at')
         WHERE json_extract(sweep_stamps, '$.availability_report_at') IS NOT NULL`,
        )
        .run();
      return c.json({ reset: res.meta?.changes ?? 0 });
    }

    const limitRaw = Number.parseInt(c.req.query("limit") || "10", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : AVAILABILITY_REPORT_SWEEP_MAX;
    const missingOnly = c.req.query("missing-only") === "1";

    // One implementation, shared with the daily cron (#1041) -- the candidate
    // query, the cap, the stamp-only-on-success rule and the error collection
    // all live in runAvailabilityReportSweep so the two callers cannot drift.
    try {
      const result = await runAvailabilityReportSweep(c.env, { limit, missingOnly });
      return c.json(result);
    } catch (err) {
      console.error("[availability-report-sweep] candidate query failed:", err);
      return c.json(
        { error: "Failed to query sweep candidates (is migration 0061 applied?)" },
        500,
      );
    }
  });

  // ============================================================================
  // Manifest Generation
  // ============================================================================

  /**
   * POST /admin/datasets/:id/manifest/:version - Generate or regenerate a version manifest
   *
   * Traverses the git tree at the given version tag and generates a JSON manifest
   * mapping file paths to their S3 annex keys.
   *
   * Optional body `{ doi?: string }`: explicit version DOI. If omitted, the
   * handler tries to read the DOI from the existing manifest.json on S3. Under
   * the central manifest workflow (`MANIFEST_VIA_CENTRAL_WORKFLOW=true`),
   * publish-time `dataset_versions` inserts happen on the `/webhooks/manifest-ready`
   * callback path, so admin recovery of a stranded version may need to backfill
   * the `dataset_versions` row here. The caller must supply `doi` explicitly
   * when no manifest.json exists on S3 (or the existing manifest carries no
   * DOI), because there is no inline DOI minting in this admin path.
   */
  admin.post("/datasets/:id/manifest/:version", async (c) => {
    const datasetId = c.req.param("id");
    const version = c.req.param("version");
    const db = c.env.DB;

    // Accept optional DOI in request body
    const body = await c.req.json<{ doi?: string }>().catch(() => ({}));

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo, concept_doi FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{
        dataset_id: string;
        github_repo: string | null;
        concept_doi: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const pat = await getDatasetsToken(c.env);

    // Resolve version DOI: use provided value, or try existing manifest
    let versionDoi: string | null = "doi" in body ? (body.doi ?? null) : null;
    if (!versionDoi) {
      const s3Options = getS3Config(c.env);
      const existing = await getManifest(s3Options, datasetId, version);
      if (existing) {
        const parsed = JSON.parse(existing) as { doi?: string | null };
        versionDoi = parsed.doi ?? null;
      }
    }

    try {
      const manifest = await generateManifest(
        repoName,
        version,
        pat,
        datasetId,
        versionDoi,
        dataset.concept_doi,
      );

      await uploadManifest(
        getS3Config(c.env),
        datasetId,
        version,
        JSON.stringify(manifest, null, 2),
      );

      // Backfill dataset_versions row if missing. Under the central manifest
      // workflow (#557), publish-time inserts run on /webhooks/manifest-ready;
      // a stranded version (manifest+S3 present, D1 row absent) needs this
      // admin path to repair the gap. OR IGNORE keeps the legacy double-write
      // path safe.
      const versionDoiForRow = versionDoi ?? manifest.doi ?? null;
      let dataset_versions_backfilled = false;
      if (versionDoiForRow) {
        const existing = await db
          .prepare("SELECT doi FROM dataset_versions WHERE dataset_id = ? AND version = ?")
          .bind(datasetId, version)
          .first<{ doi: string }>();
        if (!existing) {
          // EZID is the sole provider (ADR 0007, #1182).
          const provider = "ezid";
          try {
            await db
              .prepare(
                "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, ?)",
              )
              .bind(datasetId, version, versionDoiForRow, provider)
              .run();
            dataset_versions_backfilled = true;
          } catch (err) {
            console.error(
              `[admin manifest regen] dataset_versions backfill failed for ${datasetId}@${version}:`,
              err,
            );
          }
        }
      } else {
        console.warn(
          `[admin manifest regen] no DOI resolved for ${datasetId}@${version}; skipping dataset_versions backfill (caller must pass {doi: "..."} body to repair)`,
        );
      }

      return c.json({
        message: "Manifest generated and uploaded",
        dataset_id: datasetId,
        version: manifest.version,
        files_count: Object.keys(manifest.files).length,
        dataset_versions_backfilled,
      });
    } catch (err) {
      const msg = errorMessage(err);
      return c.json({ error: `Manifest generation failed: ${msg}` }, 500);
    }
  });

  /**
   * POST /admin/datasets/:id/availability-report[?dry_run=1] — generate the
   * per-dataset availability report (`.nemar/availability-report.json`, epic
   * #999 Phase 1, #1000): how much of the published version manifest is
   * actually present in S3, and exactly which files are missing + why.
   * Reuses the completeness math from verifyDatasetVersionS3
   * (import-integrity.ts) via services/availability-report.ts.
   *
   * `?dry_run=1` returns the report without committing it. Otherwise the
   * report is committed to `.nemar/availability-report.json` on the repo's
   * `main` branch via the admin Contents-API path (the same last-writer-wins
   * `createOrUpdateFile` enrichment uses for `.nemar/metadata.json`).
   */
  admin.post("/datasets/:id/availability-report", async (c) => {
    const datasetId = c.req.param("id");
    const dryRun = c.req.query("dry_run") === "1";

    try {
      const report = await writeAvailabilityReport(c.env, datasetId, { dryRun });
      return c.json(dryRun ? report : { written: true, report });
    } catch (err) {
      if (err instanceof AvailabilityReportError) {
        // A 4xx names the dataset's own state; a 5xx is a fault (GitHub auth,
        // a branch lookup that failed) and would otherwise leave no server log.
        if (err.statusCode >= 500) {
          console.error(`[availability-report] Failed for ${datasetId}:`, err);
        }
        return c.json({ error: err.message }, err.statusCode);
      }
      console.error(`[availability-report] Failed for ${datasetId}:`, err);
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ============================================================================
  // Admin Doctor: scan + fix stuck-dataset patterns
  // ============================================================================

  /**
   * POST /admin/doctor/scan - Run diagnostic checks across datasets.
   *
   * Body (all optional):
   *   - check: name of a single check (omit to run all)
   *   - dataset_id: narrow the scan to one dataset
   *
   * Read-only. Returns findings per check.
   */
  admin.post("/doctor/scan", async (c) => {
    type ScanBody = { check?: string; dataset_id?: string };
    const body = (await c.req.json<ScanBody>().catch(() => ({}))) as ScanBody;

    let checks = DOCTOR_CHECKS;
    if (body.check) {
      const found = getCheck(body.check);
      if (!found) {
        return c.json({ error: `Unknown check: ${body.check}`, available: listChecks() }, 400);
      }
      checks = [found];
    }

    const ctx: CheckContext = {
      db: c.env.DB,
      s3: getS3Config(c.env),
      githubPat: await getDatasetsToken(c.env),
    };

    const results: Record<string, { description: string; count: number; findings: Finding[] }> = {};
    for (const check of checks) {
      const findings = await check.scan(ctx, body.dataset_id);
      results[check.name] = {
        description: check.description,
        count: findings.length,
        findings,
      };
    }

    return c.json({
      scanned: checks.map((c) => c.name),
      results,
    });
  });

  /**
   * POST /admin/doctor/fix - Apply a check's remediation.
   *
   * Body:
   *   - check (required): name of the check
   *   - dataset_id (optional): narrow to one dataset
   *   - dry_run (optional, default false): list findings without writing
   *   - limit (optional, un-narrowed calls only): cap findings fixed this
   *     call, default DOCTOR_FIX_DEFAULT_LIMIT, clamped to
   *     DOCTOR_FIX_MAX_LIMIT (issue #1135)
   *
   * Returns per-dataset fix results. Fixes are serial to bound worker memory
   * and respect downstream rate limits (GitHub, S3, EZID).
   *
   * Un-narrowed (no dataset_id) calls are BOUNDED: only up to `limit`
   * findings are fixed this invocation, and `remaining` reports how many
   * were left for the caller to pick up on a subsequent call (repeat until
   * it reaches 0, same convergence contract as hed-sweep / data-integrity-
   * sweep). A dataset_id-narrowed call is NOT capped -- its findings are
   * already scoped to one dataset -- and always reports `remaining: 0`.
   */
  admin.post("/doctor/fix", async (c) => {
    type FixBody = { check?: string; dataset_id?: string; dry_run?: boolean; limit?: number };
    const body = (await c.req.json<FixBody>().catch(() => ({}))) as FixBody;

    if (!body.check) {
      return c.json({ error: "check is required", available: listChecks() }, 400);
    }
    const check = getCheck(body.check);
    if (!check) {
      return c.json({ error: `Unknown check: ${body.check}`, available: listChecks() }, 400);
    }

    const ctx: CheckContext = {
      db: c.env.DB,
      s3: getS3Config(c.env),
      githubPat: await getDatasetsToken(c.env),
    };

    const findings = await check.scan(ctx, body.dataset_id);

    if (body.dry_run) {
      return c.json({
        check: body.check,
        dry_run: true,
        would_fix: findings.length,
        findings,
      });
    }

    // Cap only applies to un-narrowed calls; a dataset_id-narrowed call's
    // findings are already scoped to one dataset and stay small.
    const requestedLimit = Number.isFinite(body.limit)
      ? Math.trunc(Number(body.limit))
      : DOCTOR_FIX_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requestedLimit, 1), DOCTOR_FIX_MAX_LIMIT);
    const toFix = body.dataset_id ? findings : findings.slice(0, limit);

    const results: Array<{
      dataset_id: string;
      version?: string;
      status: "fixed" | "skipped" | "failed";
      message?: string;
      details?: Record<string, unknown>;
    }> = [];
    for (const finding of toFix) {
      const result = await check.fix(ctx, finding);
      results.push({
        dataset_id: finding.dataset_id,
        version: finding.version,
        ...result,
      });
    }

    return c.json({
      check: body.check,
      total: findings.length,
      fixed: results.filter((r) => r.status === "fixed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
      remaining: body.dataset_id ? 0 : findings.length - toFix.length,
    });
  });

  // ---------------------------------------------------------------------------
  // Dataset deletion
  // ---------------------------------------------------------------------------

  /**
   * POST /admin/datasets/:id/reset - Reset a test dataset to clean state
   *
   * Hardcoded to nm099999 only. Deletes S3 objects, recreates GitHub repo,
   * cleans D1 version/publication records, re-adds caller as collaborator.
   */
  admin.post("/datasets/:id/reset", async (c) => {
    const datasetId = c.req.param("id");

    if (datasetId !== "nm099999") {
      return c.json({ error: "Reset is only allowed for test dataset nm099999" }, 400);
    }

    const requestingUser = c.get("user");
    const db = c.env.DB;

    // Ensure nm099999 row exists (another process may have deleted it)
    const dataset = await db
      .prepare("SELECT * FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ id: number; dataset_id: string; name: string; github_repo: string | null }>();

    if (!dataset) {
      await db
        .prepare(
          "INSERT INTO datasets (dataset_id, name, description, owner_user_id, status, github_repo, visibility, is_sandbox) VALUES (?, 'E2E Test Dataset', 'Persistent test dataset for E2E testing', ?, 'active', 'nemarDatasets/nm099999', 'private', 0)",
        )
        .bind(datasetId, requestingUser.id)
        .run();
    }

    const steps: { s3_deleted: number; github_recreated: boolean; d1_cleaned: boolean } = {
      s3_deleted: 0,
      github_recreated: false,
      d1_cleaned: false,
    };

    // 1. Delete S3 objects
    try {
      const s3Options = {
        bucket: c.env.S3_BUCKET,
        region: c.env.AWS_REGION,
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      };
      const s3Result = await deleteDatasetObjects(s3Options, datasetId, true);
      steps.s3_deleted = s3Result.deleted;
    } catch (err) {
      console.error(
        `[reset] S3 cleanup failed for ${datasetId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // 2. Recreate GitHub repo
    try {
      const pat = await getDatasetsToken(c.env);
      const repoName = datasetId;
      await deleteRepository(repoName, pat);
      await createRepository(repoName, "E2E test dataset (auto-reset)", true, pat);
      await addCollaborator(repoName, requestingUser.github_username, "push", pat);
      steps.github_recreated = true;
    } catch (err) {
      console.error(
        `[reset] GitHub recreate failed for ${datasetId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // 3. Clean D1 records (keep datasets row)
    try {
      await db.batch([
        db.prepare("DELETE FROM dataset_versions WHERE dataset_id = ?").bind(datasetId),
        db.prepare("DELETE FROM publication_requests WHERE dataset_id = ?").bind(datasetId),
        db
          .prepare(
            "DELETE FROM dataset_collaborators WHERE dataset_id IN (SELECT id FROM datasets WHERE dataset_id = ?)",
          )
          .bind(datasetId),
        db.prepare("DELETE FROM user_s3_permissions WHERE s3_prefix = ?").bind(datasetId),
      ]);
      // Reset DOI and Zenodo fields on the dataset
      await db
        .prepare(
          "UPDATE datasets SET concept_doi = NULL, latest_version_doi = NULL, ezid_status = NULL, zenodo_concept_id = NULL, enrichment_json = NULL, sweep_stamps = json_remove(sweep_stamps, '$.enrichment_updated_at'), visibility = 'private' WHERE dataset_id = ?",
        )
        .bind(datasetId)
        .run();
      steps.d1_cleaned = true;
    } catch (err) {
      console.error(
        `[reset] D1 cleanup failed for ${datasetId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    const githubRepo = `nemarDatasets/${datasetId}`;
    const allOk = steps.s3_deleted >= 0 && steps.github_recreated && steps.d1_cleaned;
    return c.json(
      {
        message: allOk ? `Dataset ${datasetId} reset` : `Dataset ${datasetId} partially reset`,
        success: allOk,
        github_ssh_url: `git@github.com:${githubRepo}.git`,
        steps,
      },
      allOk ? 200 : 207,
    );
  });

  const deleteDatasetSchema = z.object({
    force: z.boolean().optional().default(false),
  });

  /**
   * DELETE /admin/datasets/:id - Delete a dataset and all associated resources
   *
   * Permission:
   * - Unpublished datasets (no DOI, private): admin or owner
   * - Published datasets (with DOI or public visibility): owner only, requires force=true
   */
  admin.delete("/datasets/:id", async (c) => {
    const datasetId = c.req.param("id");
    const requestingUser = c.get("user");

    // Parse optional JSON body (DELETE requests may have no body)
    let force = false;
    try {
      const body = await c.req.json();
      const parsed = deleteDatasetSchema.safeParse(body);
      if (parsed.success) {
        force = parsed.data.force;
      }
    } catch {
      // No body or invalid JSON: default force=false
    }
    const db = c.env.DB;

    // Look up dataset
    const dataset = await db
      .prepare("SELECT * FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        name: string;
        owner_user_id: number;
        status: string;
        visibility: string;
        concept_doi: string | null;
        latest_version_doi: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Folded legacy catalog rows (#646) are sentinel-owned, with no GitHub repo /
    // S3 of their own, and are re-created from the upstream nemar.org catalog on
    // the next catalog sync, so deleting one here is futile. Refuse with a clear
    // 400. deleteDatasetCascade also refuses (defense-in-depth for other callers).
    if (dataset.owner_user_id === SYSTEM_USER_ID) {
      return c.json(
        {
          error: `"${datasetId}" is a system catalog entry (owner=nemar-system) managed by the nemar.org catalog sync and cannot be deleted here.`,
          dataset_id: datasetId,
        },
        400,
      );
    }

    // Permission check: published datasets require owner role
    const hasDoiOrPublished = dataset.concept_doi !== null || dataset.visibility === "public";
    if (hasDoiOrPublished) {
      if (!hasRole(requestingUser.role, "owner")) {
        return c.json(
          { error: "Published datasets with DOIs can only be deleted by the NEMAR owner" },
          403,
        );
      }
      if (!force) {
        return c.json(
          {
            error: "This dataset has a DOI or is published. Set force=true to confirm deletion.",
            dataset_id: datasetId,
            concept_doi: dataset.concept_doi,
            visibility: dataset.visibility,
          },
          400,
        );
      }
    }

    // Check for active publication requests
    const activePubReq = await db
      .prepare(
        "SELECT COUNT(*) as count FROM publication_requests WHERE dataset_id = ? AND status NOT IN ('published', 'denied')",
      )
      .bind(datasetId)
      .first<{ count: number }>();

    if (activePubReq && activePubReq.count > 0) {
      return c.json(
        {
          error: `Cannot delete dataset with ${activePubReq.count} active publication request(s). Deny or complete them first.`,
        },
        409,
      );
    }

    // Perform cascade deletion. A ProdRepoFenceError is a deliberate refusal
    // (non-production worker, non-dev-range id), not a server fault, so answer
    // 403 with the reason rather than letting it read as an opaque 500.
    let result: Awaited<ReturnType<typeof deleteDatasetCascade>>;
    try {
      result = await deleteDatasetCascade(db, c.env, datasetId, {
        bypassGovernance: force,
      });
    } catch (err) {
      if (err instanceof ProdRepoFenceError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }

    // Audit log (best-effort; don't fail the response if audit write fails)
    try {
      await auditLogStatement(db, {
        userId: requestingUser.id,
        action: "dataset_deleted",
        details: JSON.stringify({
          dataset_id: datasetId,
          dataset_name: dataset.name,
          owner_user_id: dataset.owner_user_id,
          had_doi: dataset.concept_doi !== null,
          force,
          steps: result.steps,
          warnings: result.warnings,
        }),
      }).run();
    } catch (err) {
      console.error("Failed to write deletion audit log:", err);
      result.warnings.push("Audit log write failed");
    }

    return c.json(result, result.deleted ? 200 : 207);
  });

  // ─── Bulk delete datasets ────────────────────────────────────────────────────

  const bulkDeleteSchema = z.object({
    dataset_ids: z
      .array(z.string().regex(/^(nm|xx|on)\d{6}$/, "Invalid dataset ID format"))
      .min(1)
      .max(200)
      .transform((ids) => [...new Set(ids)]),
  });

  /**
   * POST /admin/datasets/bulk-delete - Delete multiple datasets at once
   *
   * Only works on unpublished datasets (private, no DOI, no active pub requests).
   * Intended for cleaning up phantom/orphaned datasets.
   * Requires owner role.
   */
  admin.post("/datasets/bulk-delete", zValidator("json", bulkDeleteSchema), async (c) => {
    const requestingUser = c.get("user");
    if (!hasRole(requestingUser.role, "owner")) {
      return c.json({ error: "Only the NEMAR owner can bulk-delete datasets" }, 403);
    }

    const { dataset_ids } = c.req.valid("json");
    const db = c.env.DB;
    const results: Array<{ dataset_id: string; deleted: boolean; error?: string }> = [];

    for (const datasetId of dataset_ids) {
      try {
        // Safety: only delete private datasets with no DOI
        const dataset = await db
          .prepare("SELECT visibility, concept_doi FROM datasets WHERE dataset_id = ?")
          .bind(datasetId)
          .first<{ visibility: string; concept_doi: string | null }>();

        if (!dataset) {
          results.push({ dataset_id: datasetId, deleted: false, error: "not found" });
          continue;
        }
        if (dataset.concept_doi || dataset.visibility === "public") {
          results.push({ dataset_id: datasetId, deleted: false, error: "has DOI or is public" });
          continue;
        }

        const result = await deleteDatasetCascade(db, c.env, datasetId);
        results.push({
          dataset_id: datasetId,
          deleted: result.deleted,
          error: result.warnings.join("; ") || undefined,
        });
      } catch (err) {
        results.push({
          dataset_id: datasetId,
          deleted: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const deletedCount = results.filter((r) => r.deleted).length;
    const failedCount = results.filter((r) => !r.deleted).length;

    // Audit log (non-fatal; don't fail the response if audit write fails)
    try {
      await auditLogStatement(db, {
        userId: requestingUser.id,
        action: "bulk_delete",
        resourceType: "dataset",
        resourceId: dataset_ids.join(","),
        details: JSON.stringify({ deleted: deletedCount, failed: failedCount, ids: dataset_ids }),
      }).run();
    } catch (auditErr) {
      console.error(
        `[bulk-delete] Failed to write audit log (${deletedCount} deleted, ${failedCount} failed):`,
        auditErr,
      );
    }

    return c.json({ deleted: deletedCount, failed: failedCount, results });
  });

  // ---------------------------------------------------------------------------
  // nemar.org Datapipeline Sync
  // ---------------------------------------------------------------------------

  /**
   * POST /admin/datasets/:id/reindex - Refresh enrichment + Phase 2 metadata
   * columns for a single dataset (epic #417 phase 3).
   *
   * Body: { skip_enrichment?: boolean, skip_sync?: boolean, ref?: string }
   *
   * Returns per-step status so a transient failure in one path does not
   * cause the operator to repeat the entire reindex.
   */
  admin.post("/datasets/:id/reindex", async (c) => {
    const datasetId = c.req.param("id");
    // Parse body directly so chunked-transfer requests (no Content-Length
    // header) still produce a body. An empty body is treated as defaults.
    let body: { skip_enrichment?: boolean; skip_sync?: boolean; ref?: string } = {};
    try {
      const raw = await c.req.text();
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const skipEnrichment = body.skip_enrichment === true;
    const skipSync = body.skip_sync === true;
    if (skipEnrichment && skipSync) {
      return c.json({ error: "skip_enrichment and skip_sync cannot both be true" }, 400);
    }

    const result: {
      dataset_id: string;
      enrichment: {
        status: "ok" | "failed" | "skipped";
        ref?: string;
        error?: string;
        /** Deliberate skips on an otherwise successful run (#1255). */
        warnings?: string[];
        /** Stage 1d DOI lookup counts (#1549); `failed > 0` warrants a retry. */
        doi_resolution?: DoiResolutionSummary;
      };
      sync: {
        status: "ok" | "failed" | "skipped";
        metadata_columns_written?: boolean;
        metadata_columns_error?: string;
      };
    } = {
      dataset_id: datasetId,
      enrichment: { status: "skipped" },
      sync: { status: "skipped" },
    };

    if (!skipEnrichment) {
      const enr = await runEnrichmentForDataset(c.env, datasetId, { ref: body.ref });
      // llm_usage rides along on BOTH branches: a run that fails after its
      // LLM calls (e.g. commit error) still spent the tokens.
      result.enrichment = enr.ok
        ? {
            status: "ok",
            ref: enr.ref,
            ...(enr.llm_usage && { llm_usage: enr.llm_usage }),
            // A deliberate skip keeps the run "ok" and rides along as a
            // warning; "failed" stays reserved for real errors (#1255).
            ...(enr.warnings && { warnings: enr.warnings }),
            ...(enr.doi_resolution && { doi_resolution: enr.doi_resolution }),
          }
        : {
            status: "failed",
            ref: enr.ref,
            error: enr.error,
            ...(enr.llm_usage && { llm_usage: enr.llm_usage }),
            ...(enr.doi_resolution && { doi_resolution: enr.doi_resolution }),
          };
    }

    if (!skipSync) {
      try {
        const refreshed = await refreshDatasetMetadata(c.env, datasetId);
        result.sync = {
          status: refreshed.metadata_columns_written ? "ok" : "failed",
          metadata_columns_written: refreshed.metadata_columns_written,
          ...(refreshed.metadata_columns_error && {
            metadata_columns_error: refreshed.metadata_columns_error,
          }),
        };
      } catch (err) {
        if (err instanceof DatasetReindexError) {
          return c.json(
            { ...result, sync: { status: "failed", errors: [err.message] } },
            err.statusCode,
          );
        }
        console.error(`[admin/reindex] Unexpected sync error for ${datasetId}:`, err);
        return c.json({ ...result, sync: { status: "failed", errors: [errorMessage(err)] } }, 500);
      }
    }

    return c.json(result);
  });

  /**
   * POST /admin/datasets/reindex/bulk - Run reindex across a filtered set of
   * datasets. Sequential to respect upstream rate limits (epic #417 phase 3).
   *
   * Body: {
   *   filter: "all" | "missing-metadata" | "stale",
   *   older_than_days?: number,
   *   skip_enrichment?: boolean,
   *   skip_sync?: boolean,
   *   dry_run?: boolean,
   * }
   */
  admin.post("/datasets/reindex/bulk", async (c) => {
    let body: {
      filter?: string;
      older_than_days?: number;
      skip_enrichment?: boolean;
      skip_sync?: boolean;
      dry_run?: boolean;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const validFilters: ReindexFilter[] = ["all", "missing-metadata", "stale"];
    if (!body.filter || !validFilters.includes(body.filter as ReindexFilter)) {
      return c.json({ error: `filter must be one of: ${validFilters.join(", ")}` }, 400);
    }
    const filter = body.filter as ReindexFilter;
    const skipEnrichment = body.skip_enrichment === true;
    const skipSync = body.skip_sync === true;
    if (skipEnrichment && skipSync) {
      return c.json({ error: "skip_enrichment and skip_sync cannot both be true" }, 400);
    }

    let query: { sql: string; params: unknown[] };
    try {
      query = buildReindexFilterQuery(filter, { olderThanDays: body.older_than_days });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }

    // Guard against the Worker-deployed-before-migration partial-deploy window:
    // the filter SQL references Phase 2 columns (subject_count, modalities,
    // metadata_updated_at, etc.). If migration 0020 hasn't been applied yet,
    // D1 returns a column-not-found error. Map that to 503 with a clear
    // message instead of a generic 500 so operators know what to do.
    let datasetIds: string[];
    const startedAt = Date.now();
    try {
      const rows = await c.env.DB.prepare(query.sql)
        .bind(...query.params)
        .all<{ dataset_id: string }>();
      datasetIds = (rows.results ?? []).map((r) => r.dataset_id);
    } catch (err) {
      const msg = errorMessage(err);
      if (/no such column|undefined column/i.test(msg)) {
        console.error(
          "[admin/reindex/bulk] D1 query failed; migration 0020 may not be applied:",
          err,
        );
        return c.json(
          {
            error:
              "Bulk reindex query references columns added by migration 0020. Apply the migration (wrangler d1 migrations apply) and retry.",
            details: msg,
          },
          503,
        );
      }
      console.error("[admin/reindex/bulk] D1 query failed unexpectedly:", err);
      return c.json({ error: msg }, 500);
    }

    if (body.dry_run === true) {
      return c.json({
        filter,
        dry_run: true,
        total: datasetIds.length,
        datasets: datasetIds,
        elapsed_ms: Date.now() - startedAt,
      });
    }

    type PerDataset = {
      dataset_id: string;
      enrichment: {
        status: "ok" | "failed" | "skipped";
        error?: string;
        /** Deliberate skips on an otherwise successful run (#1255). */
        warnings?: string[];
        llm_usage?: LlmUsageTotals;
        /** Stage 1d DOI lookup counts (#1549); `failed > 0` warrants a retry. */
        doi_resolution?: DoiResolutionSummary;
      };
      sync: {
        status: "ok" | "failed" | "skipped";
        metadata_columns_error?: string;
      };
    };
    const results: PerDataset[] = [];
    // Aggregate spend across the batch — the bulk route is the
    // highest-spend caller, so it must report what it cost.
    const usageTotal: LlmUsageTotals = {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      est_cost_usd: 0,
    };

    // Sequential to keep per-dataset failures isolated and respect upstream
    // rate limits (Claude API, GitHub). The runtime budget for a
    // Cloudflare Worker request is the limiting factor for very large batches;
    // operators should narrow the filter or split into multiple runs.
    for (const datasetId of datasetIds) {
      const entry: PerDataset = {
        dataset_id: datasetId,
        enrichment: { status: "skipped" },
        sync: { status: "skipped" },
      };
      if (!skipEnrichment) {
        const enr = await runEnrichmentForDataset(c.env, datasetId);
        entry.enrichment = enr.ok
          ? {
              status: "ok",
              ...(enr.llm_usage && { llm_usage: enr.llm_usage }),
              ...(enr.warnings && { warnings: enr.warnings }),
              ...(enr.doi_resolution && { doi_resolution: enr.doi_resolution }),
            }
          : {
              status: "failed",
              error: enr.error,
              ...(enr.llm_usage && { llm_usage: enr.llm_usage }),
              ...(enr.doi_resolution && { doi_resolution: enr.doi_resolution }),
            };
        if (enr.llm_usage) {
          usageTotal.calls += enr.llm_usage.calls;
          usageTotal.input_tokens += enr.llm_usage.input_tokens;
          usageTotal.output_tokens += enr.llm_usage.output_tokens;
          usageTotal.est_cost_usd =
            Math.round((usageTotal.est_cost_usd + enr.llm_usage.est_cost_usd) * 10000) / 10000;
        }
      }
      if (!skipSync) {
        try {
          const refreshed = await refreshDatasetMetadata(c.env, datasetId);
          entry.sync = {
            status: refreshed.metadata_columns_written ? "ok" : "failed",
            ...(refreshed.metadata_columns_error && {
              metadata_columns_error: refreshed.metadata_columns_error,
            }),
          };
        } catch (err) {
          // Per-dataset failure must surface in server logs in addition to the
          // response body so an operator running with -i (or a CI job that
          // only checks HTTP status) still gets a trace.
          console.error(`[admin/reindex/bulk] ${datasetId} reindex threw:`, err);
          entry.sync = { status: "failed" };
        }
      }
      if (entry.enrichment.status === "failed") {
        console.warn(
          `[admin/reindex/bulk] ${datasetId} enrichment failed: ${entry.enrichment.error}`,
        );
      }
      results.push(entry);
    }

    return c.json({
      filter,
      total: results.length,
      results,
      llm_usage_total: usageTotal,
      elapsed_ms: Date.now() - startedAt,
    });
  });

  /**
   * POST /admin/vectorize/reindex-all - Re-embed datasets' vectors from the
   * `datasets` source of truth (#646 Phase 4). Fixes the stale-vector backlog.
   *
   * Keyset-paginated to stay within Worker limits: pass `after` = the previous
   * response's `last_id` and repeat until `has_more` is false.
   * Body: { limit?: number (1..500, default 200), after?: string, dry_run?: boolean }
   */
  admin.post("/vectorize/reindex-all", async (c) => {
    if (!c.env.AI || !c.env.VECTORIZE) {
      return c.json({ error: "AI or VECTORIZE binding not configured" }, 400);
    }
    let body: { limit?: number; after?: string; dry_run?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is fine; defaults apply
    }
    const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 500);
    const after = typeof body.after === "string" ? body.after : "";
    const startedAt = Date.now();

    const rows = await c.env.DB.prepare(
      `SELECT dataset_id FROM datasets
     WHERE status = 'active' AND visibility = 'public'
       AND (is_sandbox = 0 OR is_sandbox IS NULL OR ${exemplarOrFragment("")})
       AND dataset_id > ?
     ORDER BY dataset_id
     LIMIT ?`,
    )
      .bind(after, limit)
      .all<{ dataset_id: string }>();
    const ids = (rows.results ?? []).map((r) => r.dataset_id);
    const lastId = ids.at(-1) ?? after;
    const hasMore = ids.length === limit;

    if (body.dry_run === true) {
      return c.json({
        dry_run: true,
        total: ids.length,
        last_id: lastId,
        has_more: hasMore,
        elapsed_ms: Date.now() - startedAt,
      });
    }

    let embedded = 0;
    for (const id of ids) {
      if (await reembedDatasetVector(c.env.DB, c.env.AI, c.env.VECTORIZE, id)) embedded++;
    }
    return c.json({
      scanned: ids.length,
      embedded,
      failed: ids.length - embedded,
      last_id: lastId,
      has_more: hasMore,
      elapsed_ms: Date.now() - startedAt,
    });
  });

  /**
   * GET /admin/summary/coverage
   *
   * Reports which published (dataset_id, version) pairs have summary.json
   * at the current target schema (1.1) vs which are stale or missing.
   * Powers `nemar admin summary check` and the weekly drift cron.
   *
   * Read-only: walks the version table and probes data.nemar.org for the
   * schema string. Bounded parallelism keeps us within data.nemar.org's
   * rate limit. No GitHub API calls.
   *
   * Epic #618 / phase 2 (#620).
   */
  admin.get("/summary/coverage", async (c) => {
    try {
      const report = await buildCoverageReport(c.env);
      // no-store on every response: the weekly drift cron and on-demand
      // operator CLI both pull this through the same Cloudflare edge POP that
      // would otherwise apply heuristic TTL to a 200. A cached coverage report
      // can silently mask a real drift week (cron sees yesterday's "all green"
      // when probes failed for half the catalog). Phase 3's page-bundle is
      // meticulous about no-store on partial failure; the coverage endpoint
      // — which feeds page-bundle's repair loop — must match that discipline.
      c.header("Cache-Control", "no-store, must-revalidate");
      return c.json(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[summary/coverage] failed:", msg);
      return c.json({ error: `Failed to build coverage report: ${msg}` }, 500);
    }
  });

  const dispatchManifestSchema = z.object({
    dataset_id: z.string().min(1),
    version: z.string().min(1),
    skip_canary: z.boolean().optional(),
  });

  /**
   * POST /admin/manifest/dispatch
   *
   * Fires `repository_dispatch[generate-manifest]` at `nemarDatasets/.github`
   * for a specific (dataset_id, version) pair WITHOUT seeding a manifest_jobs
   * row. The workflow runs with `skip_callback: true` so it just regenerates
   * manifest.json + summary.json on S3 without trying to phone back to a
   * non-existent in-flight job.
   *
   * Use case: backfill stale summary.json schema versions, or manually
   * re-run after a generator change. Looks up `doi` + `concept_doi` from
   * D1 so the caller only needs (dataset_id, version).
   *
   * Epic #618 / phase 2 (#620). Sibling: `triggerManifestGeneration` in
   * webhooks.ts handles the live-publish path with the full HMAC handshake.
   */
  admin.post("/manifest/dispatch", zValidator("json", dispatchManifestSchema), async (c) => {
    const { dataset_id, version, skip_canary } = c.req.valid("json");

    const row = await c.env.DB.prepare(
      `SELECT v.doi, d.concept_doi
         FROM dataset_versions v
         JOIN datasets d ON d.dataset_id = v.dataset_id
         WHERE v.dataset_id = ? AND v.version = ?
         LIMIT 1`,
    )
      .bind(dataset_id, version)
      .first<{ doi: string; concept_doi: string | null }>();

    if (!row) {
      return c.json({ error: `No published version row for ${dataset_id}@${version}` }, 404);
    }

    // Token fetch is intentionally OUTSIDE the try/catch below so a programming
    // error here (e.g. renamed env var, App-auth failure) surfaces as 500 with
    // its real message instead of being collapsed into a 502 "Dispatch failed"
    // that points the operator at GitHub instead of at our config.
    const pat = await getDatasetsToken(c.env);

    // Hard invariant pinning the security note: callback_token / callback_url
    // are safe to leave empty ONLY when skip_callback is true (the workflow
    // won't validate the token, so a real secret would just leak into runner
    // logs). If a future refactor flips skipCallback to false here the
    // assertion fires loudly instead of silently dispatching with empty
    // credentials. Mirrors the comment on `triggerManifestGeneration`'s
    // `skipCallback` option in services/github/dispatch.ts.
    const skipCallback = true;
    const callbackToken = "";
    const callbackUrl = "";
    if (!skipCallback && (callbackToken === "" || callbackUrl === "")) {
      throw new Error("internal: empty callback_token/callback_url requires skipCallback=true");
    }

    try {
      await triggerManifestGeneration(
        dataset_id,
        version,
        row.doi,
        row.concept_doi,
        callbackToken,
        callbackUrl,
        pat,
        { skipCanary: skip_canary ?? false, skipCallback, s3Bucket: c.env.S3_BUCKET },
      );
      return c.json({ dispatched: true, dataset_id, version });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[manifest/dispatch] failed dataset=${dataset_id} version=${version}:`, msg);
      return c.json({ error: `Dispatch failed: ${msg}` }, 502);
    }
  });
}
