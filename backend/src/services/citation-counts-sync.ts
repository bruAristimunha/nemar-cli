/**
 * Citation Counts Sync Service (#804)
 *
 * Pulls per-dataset citation counts from the citations dashboard manifest and
 * UPDATEs them onto the `datasets` source of truth so the catalog can order by
 * citation count (GET /datasets?sort=citations). Counts only — the per-paper
 * detail stays in the dashboard API (…/citations/api/dataset/<id>.json), fetched
 * lazily by the nemar.org citation modal, so D1 isn't inflated. Best-effort and
 * idempotent: a transient dashboard outage must not break the scheduled run.
 * See dataset_citations#170.
 *
 * Manifest: GET https://dashboard.nemar.org/citations/api/index.json
 *   { schema, last_updated, datasets: [{ dataset_id, num_citations,
 *     num_dataset_citations, num_datapaper_citations }, ...] }
 */

const MANIFEST_URL = "https://dashboard.nemar.org/citations/api/index.json";
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 10; // D1 bound-parameter batch limit (mirrors catalog-sync)

export interface CitationCountRow {
  dataset_id: string;
  num_citations: number;
  num_dataset_citations: number;
  num_datapaper_citations: number;
}

function isCitationCountRow(value: unknown): value is CitationCountRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.dataset_id === "string" &&
    r.dataset_id.length > 0 &&
    typeof r.num_citations === "number" &&
    typeof r.num_dataset_citations === "number" &&
    typeof r.num_datapaper_citations === "number"
  );
}

/**
 * Fetch + validate the citation counts manifest. Returns [] on any failure
 * (non-2xx, timeout, bad shape) — the caller logs and proceeds; counts simply
 * are not refreshed this run.
 */
export async function fetchCitationManifest(
  url: string = MANIFEST_URL,
): Promise<CitationCountRow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[citation-sync] manifest fetch ${res.status} from ${url}`);
      return [];
    }
    const body = (await res.json()) as { datasets?: unknown };
    if (!Array.isArray(body.datasets)) {
      console.warn("[citation-sync] manifest missing datasets array");
      return [];
    }
    return body.datasets.filter(isCitationCountRow);
  } catch (err) {
    console.warn(
      `[citation-sync] manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * UPDATE citation counts onto existing datasets, matched by `dataset_id`.
 * The manifest is keyed by the catalog `dataset_id` (the
 * dataset_citations pipeline discovers datasets from api.nemar.org/datasets), so
 * `dataset_id` (a UNIQUE column) is the exact join key — at most one row per
 * manifest entry. Rows whose id is not in the catalog are left untouched: the
 * catalog owns dataset existence, this never INSERTs. Returns rows updated.
 */
export async function syncCitationCounts(
  db: D1Database,
  rows: CitationCountRow[],
): Promise<{ updated: number; skipped: number }> {
  if (rows.length === 0) return { updated: 0, skipped: 0 };
  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const statements = batch.map((r) =>
      db
        .prepare(
          `UPDATE datasets
             SET num_citations = ?,
                 num_dataset_citations = ?,
                 num_datapaper_citations = ?,
                 citations_updated_at = datetime('now')
           WHERE dataset_id = ?`,
        )
        .bind(r.num_citations, r.num_dataset_citations, r.num_datapaper_citations, r.dataset_id),
    );
    const results = await db.batch(statements);
    for (const res of results) {
      updated += res.meta?.changes ?? 0;
    }
  }
  return { updated, skipped: rows.length - updated };
}

/** Fetch the manifest and sync it. For the scheduled handler. */
export async function fetchAndSyncCitationCounts(
  db: D1Database,
): Promise<{ fetched: number; updated: number; skipped: number }> {
  const rows = await fetchCitationManifest();
  const { updated, skipped } = await syncCitationCounts(db, rows);
  return { fetched: rows.length, updated, skipped };
}
