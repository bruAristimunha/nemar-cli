/**
 * The Neurobagel writer (epic #1586, phase 4; ADR 0084).
 *
 * For each ELIGIBLE dataset (neurobagel-eligibility.ts: one predicate, decided from
 * the D1 row) it gathers the transform's inputs through the data plane
 * (neurobagel-gather.ts), runs the pure transform (shared/neurobagel), and writes the
 * artifacts, then the index, into the private R2 bucket. A dataset that stops being
 * eligible is dropped from the index and its artifacts are deleted.
 *
 * THIS IS THE ONLY MODULE THAT WRITES THE BUCKET. `put` and `delete` on
 * `env.NEUROBAGEL` appear here and nowhere else; a source scan enforces it. It is
 * also the only module that writes the findings ledger (audit_log), and it sends no
 * mail and dispatches nothing to GitHub: a finding in the anonymity class goes to
 * the audit log and stays there (ADR 0067).
 *
 * ORDERING, for a consumer that may read at any moment (the node's loader):
 *   - an ADDITION or a CHANGE writes its artifacts first, then the index;
 *   - a REMOVAL writes the index first, then deletes the artifacts.
 * A run that does both writes artifacts, then the index (which already omits what is
 * leaving), then deletes. `index.json` is always rebuilt from the bucket LISTING
 * (neurobagel-store.ts), never from what this run remembers, and is replaced only
 * when its entries differ, with a conditional write that loses cleanly to a
 * concurrent run, which then rebuilds.
 *
 * IDEMPOTENT: a second run over unchanged inputs writes NOTHING, to the artifacts or
 * to the index. The fingerprint (neurobagel-fingerprint.ts) is what decides.
 *
 * NEVER A BLOCKER: the hooks (publication, import, a new version) and the daily
 * reconcile live in neurobagel-hooks.ts, which only calls {@link runNeurobagelWriter}
 * and writes nothing itself.
 *
 * OFF BY DEFAULT: nothing here acts unless `NEUROBAGEL_WRITER_ENABLED` is exactly
 * "1", and with no `NEUROBAGEL` binding the writer is a reported no-op.
 */

import {
  NEUROBAGEL_RECONCILE_DEFAULT,
  NEUROBAGEL_REGENERATE_MAX,
  type NeurobagelDatasetResult,
  type NeurobagelRunResult,
} from "../../../shared/contract/neurobagel-admin.js";
import { canonicalJson } from "../../../shared/neurobagel/canonical-json.js";
import {
  NeurobagelRefusal,
  type NeurobagelReport,
  artifactFileNames,
  buildNeurobagelArtifacts,
} from "../../../shared/neurobagel/index.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { CONCEPT_DOI_SQL } from "./anonymity.js";
import { toVersionTag } from "./data-router.js";
import { resolveDataBaseOrigin } from "./environment.js";
import { manifestCacheKey } from "./manifest-source.js";
import {
  type CurationResolution,
  type CurationResolver,
  applyCuration,
  defaultCurationResolver,
} from "./neurobagel-curation.js";
import { eligibleAmong, loadEligibleRow } from "./neurobagel-eligibility.js";
import { inputFingerprint, rowFingerprint, sha256Hex } from "./neurobagel-fingerprint.js";
import {
  GATHER_TABLE_COUNT,
  type GatherDeps,
  GatherRefusal,
  MAX_GATHER_CHUNK_GETS,
  gatherNeurobagelInput,
} from "./neurobagel-gather.js";
import { type OpCounter, countOps, createOpCounter } from "./neurobagel-ops.js";
import {
  LEDGER_ACTIONS,
  type LedgerEntry,
  PARK_WINDOW_MS,
  type PlanRow,
  currentSignature,
  loadPlanRows,
  neededWork,
  planWork,
  readLedger,
  recordLedgerState,
  standingRefusals,
  utcDay,
} from "./neurobagel-plan.js";
import {
  ARTIFACT_CONTENT_TYPE,
  type ArtifactKind,
  type IndexDocument,
  META,
  NEUROBAGEL_INDEX_KEY,
  type StoreListing,
  type StoredDataset,
  artifactName,
  buildIndexDocument,
  indexEntryFor,
  indexProblems,
  listStore,
  readStoredIndex,
  serializeIndex,
  sha256OfBytes,
} from "./neurobagel-store.js";
import { BOUNDED_LIST_MAX_PAGES, headManifestObject } from "./s3.js";

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

export type WriterMode = "enabled" | "disabled" | "store_unconfigured";

/**
 * Whether the writer may act. The flag is the switch (exactly "1"; absent or
 * anything else is OFF), checked FIRST so a deployment that does not carry the flag
 * does nothing, whatever else it carries. Then the binding: enabled with no bucket
 * is a reported no-op, never an error that reaches a flow.
 */
export function neurobagelWriterMode(
  env: Pick<Bindings, "NEUROBAGEL_WRITER_ENABLED" | "NEUROBAGEL">,
): WriterMode {
  if (env.NEUROBAGEL_WRITER_ENABLED !== "1") return "disabled";
  if (!env.NEUROBAGEL) return "store_unconfigured";
  return "enabled";
}

export const RECONCILE_DEFAULT_LIMIT = NEUROBAGEL_RECONCILE_DEFAULT;
/** The most datasets one run examines, whatever a caller or the variable asks for. */
export const RECONCILE_HARD_LIMIT = NEUROBAGEL_REGENERATE_MAX;
/** Datasets whose artifacts one run deletes. The index drops them all at once regardless. */
export const REMOVAL_LIMIT = 50;

/**
 * Operations (D1 statements, R2 calls, HTTP requests) one run may spend. A Worker
 * invocation has 1000 subrequests in all, and the daily reconcile shares its tick with
 * every other job (ADR 0054), so a run takes well under half.
 *
 * Before chunk serving, a REWRITTEN dataset measured about 22 operations (9 D1 statements,
 * 4 R2 calls, the manifest HEAD and the data plane allowance); the current conservative
 * gather allowance raises the measured cost by 16. An UNCHANGED dataset remains 3 operations
 * (two D1 reads and the HEAD). What a run costs besides depends on the SIZE
 * OF THE STORE, because every listing is one call per page (see {@link closingReserve}).
 * A test fails if a dataset ever costs more than {@link DATASET_OPS_WORST}, so the numbers
 * here cannot go stale unnoticed.
 */
export const OP_BUDGET = 400;
/** The most one dataset may cost: 38 under the bounded gather allowance, plus an 8-op margin. */
export const DATASET_OPS_WORST = 46;
/**
 * What the closing steps cost besides listing the store: the index read, the eligibility
 * check and the conditional write of two attempts, and the run record.
 */
export const CLOSING_FIXED_OPS = 10;
/**
 * Objects one `list` call returns. 100 is what Miniflare's R2 returns when custom metadata
 * is asked for (the writer always asks), and it is the number the budget plans with; real R2
 * may return more and cost fewer calls, which this does not rely on.
 */
export const LIST_PAGE_OBJECTS = 100;
/** The fewest list calls that read `objects` objects. */
export function listingPages(objects: number): number {
  return Math.max(1, Math.ceil(objects / LIST_PAGE_OBJECTS));
}
/**
 * What a run holds back to finish with: the closing sync lists the WHOLE store again (one
 * call per page) and may do it twice if it loses a race, then one delete for each dataset
 * leaving. It grows with the store (about 800 datasets are 2,400 objects and 24 pages), so
 * a constant would be right for a small store and short for the real one. A third attempt
 * may spend past the run's budget, but not past the Worker's own 1000.
 */
export function closingReserve(objects: number, leaving: number): number {
  return CLOSING_FIXED_OPS + 2 * listingPages(objects) + Math.min(leaving, REMOVAL_LIMIT);
}
/** Existing measured allowance for manifest, git broker and ordinary file requests. */
export const GATHER_HTTP_BASE_OPS = 8;
/** Two annexed tables can each need one HEAD and two bounded LIST pages. */
export const GATHER_ANNEX_PROBE_OPS = GATHER_TABLE_COUNT * (1 + BOUNDED_LIST_MAX_PAGES);
/** Margin for route and upstream variation beyond the explicit request bounds. */
export const GATHER_HTTP_MARGIN = 2;
/**
 * Conservative per-gather HTTP allowance: the previous 8, plus both table probes,
 * the shared chunk GET cap and a small margin. This keeps the writer's 400-op
 * budget below the Worker subrequest ceiling when a gather sees chunked tables.
 */
export const GATHER_HTTP_OPS =
  GATHER_HTTP_BASE_OPS + GATHER_ANNEX_PROBE_OPS + MAX_GATHER_CHUNK_GETS + GATHER_HTTP_MARGIN;

/** The loader's per-artifact cap (deploy/neurobagel/README.md: NB_MAX_ARTIFACT_BYTES, 6 MiB). */
export const MAX_ARTIFACT_BYTES = 6 * 1024 * 1024;
/** The loader's whole-release cap (NB_MAX_TOTAL_BYTES, 192 MiB). Reported, not enforced here. */
export const LOADER_TOTAL_CAP_BYTES = 192 * 1024 * 1024;
export const R2_METADATA_BUDGET = 1800;
const INDEX_ATTEMPTS = 3;

/** The per-tick bound: `NEUROBAGEL_RECONCILE_MAX`, a positive integer, default 10, never above the hard limit. */
export function reconcileLimit(env: Pick<Bindings, "NEUROBAGEL_RECONCILE_MAX">): number {
  const raw = env.NEUROBAGEL_RECONCILE_MAX?.trim();
  if (raw && /^[0-9]{1,6}$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (n > 0) return Math.min(n, RECONCILE_HARD_LIMIT);
  }
  return RECONCILE_DEFAULT_LIMIT;
}

// ----------------------------------------------------------------------------
// Needs-review flags
// ----------------------------------------------------------------------------

/**
 * The report flags that mean "a person should look at this result", as opposed to the
 * informational ones (`participants_tsv_absent` is ordinary). Every `curation_*` flag
 * is here by prefix, so a flag phase 5 adds is surfaced without a change to this file.
 * A changed result is never published silently: these ride on the stored artifact
 * (R2 custom metadata) and in the run's report, and status lists them.
 */
const NEEDS_REVIEW_EXACT: ReadonlySet<string> = new Set([
  "partial_join",
  "bids_index_empty_fell_back_to_table",
  "participant_ids_do_not_join_bids_index",
  "session_modalities_unreadable",
  "session_modalities_inconsistent",
  "participant_count_disagrees",
  "conflicting_duplicate_participant_ids",
  "dataset_doi_unusable",
]);

export function isNeedsReviewFlag(flag: string): boolean {
  return flag.startsWith("curation_") || NEEDS_REVIEW_EXACT.has(flag);
}

export function needsReviewFlags(report: Pick<NeurobagelReport, "flags">): string[] {
  return report.flags.filter(isNeedsReviewFlag);
}

// ----------------------------------------------------------------------------
// Results
// ----------------------------------------------------------------------------

export type DatasetResult = NeurobagelDatasetResult;

export interface RunOptions {
  /** Who asked: `cron`, `admin`, `hook:publication`, `hook:import`, `hook:version`. */
  trigger: string;
  /** False is a dry run: nothing is written to the bucket, the ledger or the audit log. */
  execute: boolean;
  /** Examine exactly these ids (an admin's list, or a hook's one dataset). */
  only?: readonly string[];
  limit?: number;
  /** Rewrite even when the fingerprint matches. */
  force?: boolean;
  now?: Date;
  /** Operations this run may spend; {@link OP_BUDGET} unless a test narrows it. */
  opBudget?: number;
  /** How long a standing refusal parks a dataset; {@link PARK_WINDOW_MS} unless a test moves it. */
  parkWindowMs?: number;
  /** The loader's per-artifact cap; {@link MAX_ARTIFACT_BYTES} unless a test narrows it (a real 6 MiB document is not worth building for the check). */
  maxArtifactBytes?: number;
  waitUntil?: (work: Promise<unknown>) => void;
  deps?: GatherDeps & { curation?: CurationResolver };
}

export type RunResult = NeurobagelRunResult;

function emptyResult(options: RunOptions, limit: number, mode: WriterMode): RunResult {
  return {
    trigger: options.trigger,
    dry_run: !options.execute,
    status: "ok",
    writer_enabled: mode !== "disabled",
    eligible: null,
    examined: 0,
    limit,
    unexamined: 0,
    stopped: null,
    ops: {
      spent: 0,
      budget: options.opBudget ?? OP_BUDGET,
      reserved: 0,
      loop: 0,
      d1: 0,
      r2: 0,
      http: 0,
    },
    results: [],
    removed: [],
    removals_pending: 0,
    index: { changed: false, written: false, entries: null },
    anonymity_findings: 0,
    needs_review: [],
    warnings: [],
  };
}

/**
 * Refusal codes that are BLIPS: an upstream read that failed, not a fact about the dataset.
 * They are reported in the run and never recorded in the ledger, so they are never parked,
 * and the dataset is examined again on the next tick (a hook is the first attempt, so one
 * blip must not delay federation).
 *   - `fetch_failed`: a read the data plane could not answer (5xx, a throw, a 404 that is
 *     not "this file is not in the manifest").
 *   - `metadata_degraded`: `bids_index` is null exactly when the manifest digest could not
 *     be read, which a body that breaks mid-read or an S3 blink produces.
 * Every code NOT here is a standing finding. A failure of R2 or D1 is an `error` outcome,
 * which is never recorded either.
 */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set(["fetch_failed", "metadata_degraded"]);

function clip(text: string, n = 300): string {
  return text.length > n ? `${text.slice(0, n)}...` : text;
}

function s3Options(env: Bindings) {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpointUrl: env.S3_ENDPOINT_URL,
  };
}

// ----------------------------------------------------------------------------
// One dataset
// ----------------------------------------------------------------------------

interface DatasetDetail {
  name: string | null;
  subject_count: number | null;
  license: string | null;
  concept_doi: string | null;
  enrichment_json: string | null;
  enrichment_length: number | null;
  latest_version: string | null;
}

/** The fields a fingerprint is built from, for ONE dataset. `concept_doi` only through the blinded projection. */
async function loadDetail(db: D1Database, id: string): Promise<DatasetDetail | null> {
  return db
    .prepare(
      `SELECT d.name, d.subject_count, d.license, ${CONCEPT_DOI_SQL} AS concept_doi,
              d.enrichment_json, length(d.enrichment_json) AS enrichment_length,
              (SELECT dv.version FROM dataset_versions dv
                WHERE dv.dataset_id = d.dataset_id
                ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) AS latest_version
         FROM datasets d
        WHERE d.dataset_id = ?`,
    )
    .bind(id)
    .first<DatasetDetail>();
}

type Prepared =
  | {
      kind: "ready";
      detail: DatasetDetail;
      latestVersion: string;
      rowFp: string;
      fingerprint: string;
      etag: string;
      curationHash: string | null;
    }
  | { kind: "refused"; code: string; detail?: string }
  | { kind: "transient"; error: string };

/**
 * Everything a dataset's fingerprint needs, and nothing that moves bytes: one D1
 * read, one curation lookup, one S3 HEAD. Used by a dry run as well as a real one.
 */
async function prepareDataset(
  env: Bindings,
  ops: OpCounter,
  id: string,
  curation: Exclude<CurationResolution, { kind: "failed" }>,
): Promise<Prepared> {
  const detail = await loadDetail(env.DB, id);
  if (!detail) return { kind: "refused", code: "dataset_gone" };
  if (!detail.latest_version) return { kind: "refused", code: "no_latest_version" };
  // The tag form the data plane uses everywhere (legacy rows hold a bare `1.0.0`).
  const latestVersion = toVersionTag(detail.latest_version);

  let head: Awaited<ReturnType<typeof headManifestObject>>;
  try {
    ops.add("http");
    head = await headManifestObject(s3Options(env), id, latestVersion);
  } catch (err) {
    return {
      kind: "transient",
      error: `manifest HEAD failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (head.kind === "absent") return { kind: "refused", code: "manifest_absent" };
  if (!head.etag) return { kind: "refused", code: "manifest_etag_unavailable" };

  const curationHash = curation.kind === "entry" ? curation.hash : null;
  const rowFp = await rowFingerprint(
    {
      dataset_id: id,
      name: detail.name,
      subject_count: detail.subject_count,
      license: detail.license,
      concept_doi: detail.concept_doi,
      latest_version: latestVersion,
    },
    await sha256Hex(detail.enrichment_json ?? ""),
    curationHash,
  );
  return {
    kind: "ready",
    detail,
    latestVersion,
    rowFp,
    fingerprint: await inputFingerprint(rowFp, head.etag),
    etag: head.etag,
    curationHash,
  };
}

/** R2 custom metadata, kept inside R2's 2 KiB: the flags are what gives way. */
export function fitMetadata(meta: Record<string, string>): Record<string, string> {
  const size = (m: Record<string, string>) =>
    Object.entries(m).reduce((n, [k, v]) => n + k.length + v.length, 0);
  if (size(meta) <= R2_METADATA_BUDGET) return meta;
  const trimmed = { ...meta };
  const flags = (trimmed[META.flags] ?? "").split(",").filter(Boolean);
  while (flags.length > 0 && size(trimmed) > R2_METADATA_BUDGET) {
    flags.pop();
    trimmed[META.flags] = `${flags.join(",")}+`;
  }
  return trimmed;
}

/**
 * Write one dataset's set: the companions first, the JSON-LD LAST (it carries the
 * fingerprint, so it is the commit marker: a run interrupted before it leaves the
 * old marker and the next run redoes the set). An artifact whose bytes the store
 * already holds is not written again, except the JSON-LD, whose metadata is the
 * record of what it was built from.
 *
 * Returns what was written and the set as the store now holds it, which is exactly what
 * the dataset's index entry is built from.
 */
async function writeSet(
  bucket: R2Bucket,
  id: string,
  files: Record<string, string>,
  stored: StoredDataset | undefined,
  stamp: Record<string, string>,
): Promise<{ wrote: string[]; now: StoredDataset }> {
  const names = artifactFileNames(id);
  const plan: { kind: ArtifactKind; text: string }[] = [
    { kind: "dictionary", text: files[names.dictionary] as string },
    { kind: "description", text: files[names.datasetDescription] as string },
    { kind: "jsonld", text: files[names.jsonld] as string },
  ];
  const wrote: string[] = [];
  const now: StoredDataset = { id, jsonld: null, dictionary: null, description: null };
  for (const { kind, text } of plan) {
    const bytes = new TextEncoder().encode(text);
    const sha = await sha256OfBytes(bytes);
    const existing = stored?.[kind];
    const customMetadata = fitMetadata({
      [META.sha256]: sha,
      [META.kind]: kind,
      ...(kind === "jsonld" ? stamp : {}),
    });
    now[kind] = {
      key: artifactName(id, kind),
      size: bytes.length,
      sha256: sha,
      kind,
      meta: customMetadata,
    };
    if (kind !== "jsonld" && existing?.sha256 === sha) continue;
    await bucket.put(artifactName(id, kind), bytes, {
      sha256: sha,
      httpMetadata: { contentType: ARTIFACT_CONTENT_TYPE[kind] },
      customMetadata,
    });
    wrote.push(artifactName(id, kind));
  }
  return { wrote, now };
}

interface RunContext {
  env: Bindings;
  bucket: R2Bucket;
  options: RunOptions;
  listing: StoreListing;
  ledger: Map<string, LedgerEntry>;
  result: RunResult;
  signatures: Map<string, string>;
  curations: Map<string, CurationResolution>;
  now: Date;
  /** Datasets whose data said anonymous. Treated as not eligible for the rest of the run. */
  anonymityRefused: Set<string>;
  /** Set when an index patch failed: the run stops examining and goes to its closing sync. */
  indexPatchFailed: boolean;
  ops: OpCounter;
}

async function ledgerNote(
  rc: RunContext,
  id: string,
  label: Parameters<typeof recordLedgerState>[3],
  detail?: Record<string, string | number | boolean | null>,
): Promise<void> {
  if (!rc.options.execute) return;
  try {
    await recordLedgerState(rc.env.DB, rc.ledger, id, label, detail, {
      now: rc.now,
      windowMs: rc.options.parkWindowMs ?? PARK_WINDOW_MS,
    });
  } catch (err) {
    rc.result.warnings.push(
      `ledger write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function refuse(
  rc: RunContext,
  id: string,
  code: string,
  detail?: string,
): Promise<DatasetResult> {
  if (code === "anonymity_disagreement") {
    rc.anonymityRefused.add(id);
    rc.result.anonymity_findings++;
    // The audit log only: no GitHub issue, no mail (ADR 0067). The detail names the
    // KIND of disagreement and never carries the metadata it came from.
    await ledgerNote(rc, id, { state: "anonymity" }, { phase: "gather" });
    return { id, outcome: "refused", code };
  }
  if (!TRANSIENT_CODES.has(code)) {
    // Against the signature the plan read, which is the one the next plan compares: a row
    // edited since changes it, and the dataset is examined again.
    await ledgerNote(
      rc,
      id,
      { state: "refused", code, sig: rc.signatures.get(id) },
      detail ? { detail } : {},
    );
  }
  return { id, outcome: "refused", code, ...(detail ? { detail } : {}) };
}

/**
 * Make the data plane read a manifest at least as new as `currentEtag`.
 *
 * The data plane trusts an edge copy of a manifest for 60 seconds without asking S3
 * (ADR 0072). A writer that fingerprints a dataset by the manifest's CURRENT ETag but
 * builds its artifacts from a copy that is up to a minute older would stamp new
 * metadata on old content, and since the stamp matches the ETag, nothing would ever
 * correct it. So the writer asks first: if the edge copy's ETag is not the current
 * one, the copy is evicted and the data plane reads S3. A copy that is current, or
 * none, is left alone. Content is then never OLDER than the ETag it is stamped with
 * (a manifest that moves again after this check only makes the stamp older than the
 * content, which the next examination notices and redoes).
 *
 * Returns what it did. `unsupported` means a stale copy exists and the cache cannot
 * delete it: the caller must not gather, because the data plane would answer from it.
 */
async function evictStaleManifestCopy(
  env: Bindings,
  datasetId: string,
  version: string,
  currentEtag: string,
): Promise<"none" | "current" | "evicted" | "unsupported"> {
  const cache = (globalThis as { caches?: { default?: Partial<Cache> } }).caches?.default;
  if (!cache?.match) return "none";
  const request = new Request(manifestCacheKey(resolveDataBaseOrigin(env), datasetId, version));
  const hit = await cache.match(request);
  if (!hit) return "none";
  const copyEtag = hit.headers.get("ETag");
  await hit.body?.cancel().catch(() => {});
  if (copyEtag === currentEtag) return "current";
  if (typeof cache.delete !== "function") return "unsupported";
  await cache.delete(request);
  return "evicted";
}

/** What became of the per-dataset index patch. `failed` stops the run. */
type PatchOutcome = "patched" | "unchanged" | "no_index" | "failed";

/**
 * Put one dataset's NEW entry into the index, right after its artifacts.
 *
 * The invariant: never leave artifacts newer than the index across a run boundary. The
 * node's loader checks every artifact's sha256 against the index and stops the WHOLE load
 * on one mismatch, which would also block every removal. A run that is cut off (subrequests
 * spent, CPU or wall-clock killed) after rewriting some datasets and before its closing
 * index write would leave exactly that, so the index is patched after EACH dataset: read it
 * with its ETag, replace this dataset's entry, write conditional on the ETag (two operations).
 * A lost race re-reads and tries again; an index that cannot be patched stops the run
 * (the closing sync, which rebuilds from a fresh listing, then settles what it can).
 *
 * With no usable index there is nothing to disagree with: the loader refuses a missing
 * index outright, and the closing sync creates it from the listing.
 *
 * The window that remains is one dataset's own three writes: a cut-off between its first
 * and its last put leaves that dataset's artifacts ahead of its entry until the next run,
 * which redoes the set (the JSON-LD, written last, is the commit marker) and re-patches it.
 */
async function patchIndexEntry(rc: RunContext, now: StoredDataset): Promise<PatchOutcome> {
  const entry = await indexEntryFor(now);
  if (!entry) return "failed";
  for (let attempt = 1; attempt <= INDEX_ATTEMPTS; attempt++) {
    const previous = await readStoredIndex(rc.bucket);
    if (!previous.document || !previous.etag) return "no_index";
    const before = previous.document.datasets.find((d) => d.id === entry.id);
    if (before && canonicalJson(before as never) === canonicalJson(entry as never)) {
      return "unchanged";
    }
    const document: IndexDocument = {
      schema: previous.document.schema,
      generated_at: rc.now.toISOString(),
      datasets: [...previous.document.datasets.filter((d) => d.id !== entry.id), entry].sort(
        (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ),
    };
    if (indexProblems(document).length > 0) return "failed";
    const written = await rc.bucket.put(NEUROBAGEL_INDEX_KEY, serializeIndex(document), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: previous.etag },
    });
    if (written) return "patched";
  }
  return "failed";
}

/** Examine one dataset and, on a real run, write it when it changed. */
async function processDataset(rc: RunContext, row: PlanRow): Promise<DatasetResult> {
  const { env, options } = rc;
  const id = row.dataset_id;

  // The row again, now: the bulk query was a moment ago, and eligibility is cheap to
  // ask twice. A dataset that stopped being eligible in between is a removal, not a write.
  const fresh = await loadEligibleRow(env.DB, id);
  if (!fresh.eligible) return { id, outcome: "refused", code: "no_longer_eligible" };

  // A dataset with a curation entry is NEVER converted without it, and a lookup that
  // fails stops this dataset: no artifact is written and the existing one is left as it
  // is. There is no fallback to converting un-curated (neurobagel-curation.ts).
  const curation =
    rc.curations.get(id) ?? (await (options.deps?.curation ?? defaultCurationResolver)(id));
  if (curation.kind === "failed") {
    return refuse(rc, id, "curation_unavailable", clip(curation.reason));
  }
  const prepared = await prepareDataset(env, rc.ops, id, curation);
  if (prepared.kind === "refused") return refuse(rc, id, prepared.code, prepared.detail);
  if (prepared.kind === "transient") {
    return { id, outcome: "error", error: prepared.error };
  }

  const stored = rc.listing.datasets.get(id);
  const storedFp = stored?.jsonld?.meta[META.fingerprint];
  const complete = Boolean(stored?.jsonld && stored.dictionary && stored.description);
  if (!options.force && complete && storedFp === prepared.fingerprint) {
    await ledgerNote(rc, id, { state: "clear" });
    return { id, outcome: "unchanged" };
  }
  if (!options.execute) {
    return {
      id,
      outcome: "would_write",
      reason: options.force
        ? "forced"
        : !complete
          ? stored?.jsonld
            ? "incomplete set"
            : "not in the store"
          : "inputs changed",
    };
  }

  // The data plane may answer from a manifest copy up to a minute old; the fingerprint
  // is stamped with the CURRENT ETag, so a stale copy is evicted first (see
  // evictStaleManifestCopy for why content must never be older than its stamp).
  try {
    const evicted = await evictStaleManifestCopy(env, id, prepared.latestVersion, prepared.etag);
    if (evicted === "unsupported") {
      return {
        id,
        outcome: "error",
        error: "a stale manifest copy is cached and cannot be evicted",
      };
    }
  } catch (err) {
    return { id, outcome: "error", error: clip(err instanceof Error ? err.message : String(err)) };
  }

  // Gather: the anonymity guard inside it runs before any depositor file is read.
  let gathered: Awaited<ReturnType<typeof gatherNeurobagelInput>>;
  // The data plane's own D1 and R2 calls are counted at the binding; its HTTP requests are
  // not visible from here, so a gather is charged what it has been measured to make.
  rc.ops.add("http", GATHER_HTTP_OPS);
  try {
    gathered = await gatherNeurobagelInput(env, id, {
      waitUntil: options.waitUntil,
      ...options.deps,
    });
  } catch (err) {
    if (err instanceof GatherRefusal) return refuse(rc, id, err.code, clip(err.message));
    return { id, outcome: "error", error: clip(err instanceof Error ? err.message : String(err)) };
  }

  // Two readers pick "the latest version" by different SQL (the writer breaks a timestamp
  // tie by id, the data plane does not). They must agree, or one version's manifest ETag
  // would be stamped on another version's content, and nothing would ever correct it.
  if (toVersionTag(gathered.latestVersion) !== prepared.latestVersion) {
    return refuse(
      rc,
      id,
      "latest_version_disagreement",
      `the writer reads ${prepared.latestVersion} as latest, the data plane ${gathered.latestVersion}`,
    );
  }

  const input = applyCuration(gathered.input, curation);

  let built: Awaited<ReturnType<typeof buildNeurobagelArtifacts>>;
  try {
    built = await buildNeurobagelArtifacts(input);
  } catch (err) {
    if (err instanceof NeurobagelRefusal) {
      // The transform's own backstop saying anonymous is the same class of finding.
      if (err.code === "anonymous_not_false") return refuse(rc, id, "anonymity_disagreement");
      return refuse(rc, id, `transform_${err.code}`, clip(err.message));
    }
    return { id, outcome: "error", error: clip(err instanceof Error ? err.message : String(err)) };
  }

  const names = artifactFileNames(id);
  for (const name of [names.jsonld, names.dictionary, names.datasetDescription]) {
    const size = new TextEncoder().encode(built.files[name] as string).length;
    // The loader refuses the WHOLE load for one artifact over its cap; such a file is
    // never written, so one dataset cannot stop every other from being loaded.
    if (size > (options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES)) {
      return refuse(rc, id, "artifact_too_large", `${name} is ${size} bytes`);
    }
  }

  const flags = needsReviewFlags(built.report);
  // From the row read for THIS fingerprint (`prepared.detail`), not the plan's earlier one.
  const signature = await currentSignature(
    { dataset_id: id, ...prepared.detail },
    prepared.curationHash,
  );
  const { wrote, now: written } = await writeSet(rc.bucket, id, built.files, stored, {
    [META.fingerprint]: prepared.fingerprint,
    [META.rowFingerprint]: prepared.rowFp,
    [META.manifestEtag]: prepared.etag,
    [META.signature]: signature,
    [META.version]: prepared.latestVersion,
    [META.transformVersion]: String(built.report.transform_version),
    [META.flags]: flags.join(","),
    [META.generatedAt]: rc.now.toISOString(),
  });
  // A patch that THROWS (R2 down, a network error) is a patch that failed: the run stops
  // here and the closing sync, which rebuilds the index from the listing, heals what it can.
  let patch: PatchOutcome;
  try {
    patch = await patchIndexEntry(rc, written);
  } catch (err) {
    patch = "failed";
    rc.result.warnings.push(
      `index patch for ${id} threw: ${clip(err instanceof Error ? err.message : String(err))}`,
    );
  }
  if (patch === "patched") rc.result.index.patched = (rc.result.index.patched ?? 0) + 1;
  if (patch === "failed") rc.indexPatchFailed = true;
  await ledgerNote(rc, id, { state: "clear" });
  if (flags.length > 0) rc.result.needs_review.push({ id, flags });
  return { id, outcome: "written", fingerprint: prepared.fingerprint, flags, wrote };
}

// ----------------------------------------------------------------------------
// The index, and removal
// ----------------------------------------------------------------------------

/** What {@link syncIndex} settled on: the index summary, and what it judged against. */
interface IndexOutcome {
  summary: RunResult["index"];
  /** The listing the index was built from (a fresh one on a real run). */
  listing: StoreListing;
  /** The datasets that may be in the index: eligible NOW, and not refused by this run. */
  indexable: ReadonlySet<string>;
}

/**
 * Bring `index.json` to what the listing says, for the datasets eligible now.
 * Conditional on the index not having changed since it was read; a run that loses
 * rebuilds from a fresh read, up to a few attempts.
 *
 * Two orders matter. The previous index is read BEFORE the listing: the conditional write
 * is conditional on that read, so a run that replaced the index after it makes this write
 * lose, instead of a listing taken before that run's writes overwriting them. And
 * eligibility is decided AFTER the listing, inside every attempt (`decide`): a dataset
 * another run published since this one started is in the listing and must not be judged
 * against a catalog read minutes ago, which would drop it from the index and, on the next
 * line, delete its artifacts.
 */
async function syncIndex(
  rc: RunContext,
  decide: (listing: StoreListing) => Promise<ReadonlySet<string>>,
): Promise<IndexOutcome> {
  const { bucket, options } = rc;
  let listing = rc.listing;
  let indexable: ReadonlySet<string> = new Set();
  for (let attempt = 1; attempt <= INDEX_ATTEMPTS; attempt++) {
    const previous = await readStoredIndex(bucket);
    if (attempt > 1 || options.execute) listing = await listStore(bucket);
    indexable = await decide(listing);
    const built = await buildIndexDocument(
      listing,
      indexable,
      previous.document,
      rc.now.toISOString(),
    );
    const summary = {
      changed: built.changed,
      written: false,
      entries: built.document.datasets.length,
      ...(built.skippedIncomplete.length > 0
        ? { skipped_incomplete: built.skippedIncomplete }
        : {}),
    };
    if (!built.changed) return { summary, listing, indexable };
    const problems = indexProblems(built.document);
    if (problems.length > 0) return { summary: { ...summary, problems }, listing, indexable };
    if (!options.execute) return { summary, listing, indexable };
    // No index yet: a plain write. Two runs creating the first index each build it
    // from the same bucket, and either result is the right one.
    const written = await bucket.put(NEUROBAGEL_INDEX_KEY, serializeIndex(built.document), {
      httpMetadata: { contentType: "application/json" },
      ...(previous.etag ? { onlyIf: { etagMatches: previous.etag } } : {}),
    });
    if (written) return { summary: { ...summary, written: true }, listing, indexable };
    // Another run replaced the index between our read and our write.
  }
  return {
    summary: { changed: true, written: false, entries: null, contended: true },
    listing,
    indexable,
  };
}

async function removeArtifacts(
  rc: RunContext,
  listing: StoreListing,
  ids: readonly string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const id of ids) {
    const stored = listing.datasets.get(id);
    if (!stored) continue;
    const keys = (["jsonld", "dictionary", "description"] as const)
      .map((k) => stored[k]?.key)
      .filter((k): k is string => Boolean(k));
    if (keys.length === 0) continue;
    await rc.bucket.delete(keys);
    removed.push(id);
  }
  return removed;
}

// ----------------------------------------------------------------------------
// A run
// ----------------------------------------------------------------------------

/**
 * One run of the writer: examine up to `limit` datasets, write what changed, bring
 * the index to the listing, delete what left. Never throws for an expected failure;
 * the failure is the result's `status` and `error`.
 */
export async function runNeurobagelWriter(
  callerEnv: Bindings,
  options: RunOptions,
): Promise<RunResult> {
  const mode = neurobagelWriterMode(callerEnv);
  const limit = Math.min(
    RECONCILE_HARD_LIMIT,
    Math.max(1, options.limit ?? reconcileLimit(callerEnv)),
  );
  const result = emptyResult(options, limit, mode);
  const now = options.now ?? new Date();

  // A real run needs the switch. A dry run only reads, so it needs the bucket and
  // not the switch: an operator can see what enabling would do.
  if (options.execute && mode !== "enabled") {
    result.status = mode === "disabled" ? "disabled" : "store_unconfigured";
    return result;
  }
  if (!callerEnv.NEUROBAGEL) {
    result.status = "store_unconfigured";
    return result;
  }
  // Every D1 statement and R2 call below, the data plane's included, is counted at the binding.
  const ops = createOpCounter();
  const env = countOps(callerEnv, ops);
  const bucket = env.NEUROBAGEL as R2Bucket;
  const budget = options.opBudget ?? OP_BUDGET;
  const finishOps = () => {
    result.ops = {
      spent: ops.total,
      budget,
      reserved: result.ops.reserved,
      loop: result.ops.loop,
      d1: ops.d1,
      r2: ops.r2,
      http: ops.http,
    };
  };

  try {
    // A run for named datasets reads only those; the whole catalog only for an unscoped run.
    const only = options.only ? [...new Set(options.only)] : undefined;
    const { rows, refusedByRecheck } = await loadPlanRows(env.DB, only);
    if (refusedByRecheck > 0) {
      result.warnings.push(
        `${refusedByRecheck} row(s) selected by the SQL predicate failed its TypeScript re-check`,
      );
    }
    const listing = await listStore(bucket);
    // `eligible` is the catalog's count, which a scoped run does not read: null, not zero.
    result.eligible = only === undefined ? rows.length : null;
    // Read on a dry run too (it is a read): the plan a dry run shows is the plan a run follows.
    const ledger = await readLedger(env.DB);

    const resolver = options.deps?.curation ?? defaultCurationResolver;
    const curations = new Map<string, CurationResolution>();
    const signatures = new Map<string, string>();
    for (const row of rows) {
      let resolution: CurationResolution;
      try {
        resolution = await resolver(row.dataset_id);
      } catch (err) {
        resolution = {
          kind: "failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      curations.set(row.dataset_id, resolution);
      // A failed lookup has no hash: a signature that cannot match, so it is examined.
      signatures.set(
        row.dataset_id,
        resolution.kind === "failed"
          ? "curation-failed"
          : await currentSignature(row, resolution.kind === "entry" ? resolution.hash : null),
      );
    }

    const plan = planWork({
      rows,
      stored: listing.datasets,
      signatures,
      limit,
      day: utcDay(now),
      requested: only,
      parked: standingRefusals(ledger, signatures, now, options.parkWindowMs ?? PARK_WINDOW_MS),
    });
    result.unexamined = plan.unexamined;

    const rc: RunContext = {
      env,
      bucket,
      options,
      listing,
      ledger,
      result,
      signatures,
      curations,
      now,
      anonymityRefused: new Set(),
      indexPatchFailed: false,
      ops,
    };

    // Work. Sequential on purpose: each dataset moves a manifest digest and two small
    // files through a shared isolate, and the subrequest budget is shared with every
    // other job on the tick (ADR 0054).
    const rowsById = new Map(rows.map((r) => [r.dataset_id, r]));
    // What the closing steps need, held back: the sync, the run record, and one delete per
    // dataset leaving. A run that spends the rest has nothing left to finish with.
    const eligibleIds = new Set(rows.map((r) => r.dataset_id));
    const leavingEstimate = [...listing.datasets.keys()].filter(
      (id) => !eligibleIds.has(id) && (only === undefined || only.includes(id)),
    ).length;
    const reserve = closingReserve(listing.objects, leavingEstimate);
    result.ops.reserved = reserve;
    for (const item of plan.work) {
      // The first dataset is always examined, so a run makes progress however small the
      // budget; after it, a dataset is begun only if its worst case still leaves the reserve.
      if (result.examined > 0 && ops.total + DATASET_OPS_WORST + reserve > budget) {
        result.stopped = "ops_budget";
        result.unexamined += neededWork(plan.work.slice(result.examined));
        break;
      }
      result.examined++;
      const row = rowsById.get(item.id) as PlanRow;
      let outcome: DatasetResult;
      try {
        outcome = await processDataset(rc, row);
      } catch (err) {
        outcome = {
          id: item.id,
          outcome: "error",
          error: clip(err instanceof Error ? err.message : String(err)),
        };
      }
      result.results.push(outcome);
      if (rc.indexPatchFailed) {
        // Artifacts are now ahead of the index. Writing more would widen that; the closing
        // sync rebuilds the index from a fresh listing, which is the one thing left to do.
        result.warnings.push(
          `the index could not be patched after ${item.id}: the run stopped there and rebuilt the index from the listing`,
        );
        result.stopped = "index_patch";
        result.unexamined += neededWork(plan.work.slice(result.examined));
        break;
      }
    }

    // What the examination spent: the closing steps' share of the budget starts here.
    result.ops.loop = ops.total;

    // What leaves: datasets the store holds that are not eligible NOW (decided inside the
    // index sync, after its fresh listing), that proved ineligible while being examined, or
    // whose data said anonymous. Scoped to the requested ids when there are some. Computed
    // from the LISTING, not from memory.
    const droppedWhileExamining = new Set(
      result.results
        .filter((r) => r.outcome === "refused" && r.code === "no_longer_eligible")
        .map((r) => r.id),
    );

    // Index first (it omits what leaves); artifacts of what leaves go after.
    const {
      summary: index,
      listing: indexed,
      indexable,
    } = await syncIndex(rc, async (fresh) => {
      const eligibleNow = await eligibleAmong(env.DB, [...fresh.datasets.keys()]);
      return new Set(
        [...eligibleNow].filter(
          (id) => !rc.anonymityRefused.has(id) && !droppedWhileExamining.has(id),
        ),
      );
    });
    result.index = { ...index, ...(result.index.patched ? { patched: result.index.patched } : {}) };
    const leaving = [...indexed.datasets.keys()]
      .filter((id) => !indexable.has(id) && (only === undefined || only.includes(id)))
      .sort();

    // One delete per dataset, within what the budget has left (the rest waits for the next run;
    // the index and the read route already omit them).
    const room = Math.max(0, budget - ops.total - 4);
    const batch = leaving.slice(0, Math.min(REMOVAL_LIMIT, room));
    result.removals_pending = leaving.length - batch.length;
    if (options.execute) {
      if (index.written || !index.changed) {
        result.removed = await removeArtifacts(rc, indexed, batch);
        for (const id of result.removed) result.results.push({ id, outcome: "removed" });
      } else {
        result.warnings.push(
          "artifacts of leaving datasets were kept: the index could not be updated first",
        );
        result.removals_pending = leaving.length;
      }
    } else {
      for (const id of batch) result.results.push({ id, outcome: "would_remove" });
    }
    finishOps();
    await recordRun(env, result);
  } catch (err) {
    result.status = "error";
    result.error = clip(err instanceof Error ? err.message : String(err));
    console.error(`[neurobagel] run failed trigger=${options.trigger}:`, result.error);
  }
  finishOps();
  return result;
}

/** One audit row per notable real run: the "last reconcile" status reads. */
async function recordRun(env: Bindings, result: RunResult): Promise<void> {
  if (result.dry_run) return;
  const wrote = result.results.filter((r) => r.outcome === "written").length;
  const refused = result.results.filter((r) => r.outcome === "refused").length;
  const errors = result.results.filter((r) => r.outcome === "error").length;
  const activity =
    wrote + result.removed.length + refused + errors + (result.index.written ? 1 : 0);
  const isHook = result.trigger.startsWith("hook:");
  if (isHook && activity === 0) return;
  try {
    await auditLogStatement(env.DB, {
      userId: null,
      action: LEDGER_ACTIONS.run,
      resourceType: "neurobagel",
      resourceId: result.trigger,
      details: JSON.stringify({
        eligible: result.eligible,
        examined: result.examined,
        unexamined: result.unexamined,
        written: wrote,
        unchanged: result.results.filter((r) => r.outcome === "unchanged").length,
        refused,
        errors,
        removed: result.removed.length,
        removals_pending: result.removals_pending,
        index_written: result.index.written,
        index_entries: result.index.entries,
        anonymity_findings: result.anonymity_findings,
        needs_review: result.needs_review.length,
        status: result.status,
        stopped: result.stopped,
        ops: result.ops.spent,
      }),
    }).run();
  } catch (err) {
    result.warnings.push(`run record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
