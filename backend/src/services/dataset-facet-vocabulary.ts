/**
 * Facet vocabulary for `GET /datasets/facets` (epic #1144 phase 5a, #1170).
 *
 * Phase 4 put twenty facets on the CLI, but a user cannot discover what to
 * pass to most of them: `--task` accepts free text over 1040 distinct
 * labels, `--electrode-system` accepts six values nobody has written down
 * outside the source. This file computes the vocabulary -- distinct values
 * with counts -- for the nine keys the plan (D2) declares:
 *
 *   electrode-system, source, zarr, powerline   -- the four ENUM-kind facets
 *   bids-version, hed-version                   -- the two VERSION-kind facets
 *   license, modality, task                     -- pre-existing legacy filters
 *                                                   (never in shared/facets.ts)
 *
 * Six of the nine reuse their `shared/facets.ts` FacetKey as the response
 * key verbatim (D2's table), which is what lets the "every enum facet has a
 * vocabulary key" correspondence test walk FACETS directly rather than
 * maintaining a translation table.
 *
 * D3: `modalities`/`tasks` are comma-joined TEXT columns with no SQLite
 * split function; the catalog is 755 rows, so both are fetched in one query
 * and tallied here in JS rather than via a recursive CTE.
 *
 * D4/ADR 0005: every query here runs over `buildPublicCatalogBase("active",
 * undefined, undefined)` -- the SAME base `GET /datasets`' public branch
 * uses for an anonymous, unfiltered request (see dataset-filters.ts) -- so
 * the vocabulary can never advertise a value no list query can return.
 *
 * D5/ADR 0005: each vocabulary's query is isolated (Promise.allSettled), so
 * one failing omits only that vocabulary (and sets `warning`) rather than
 * 500ing the whole response. `modality` and `task` share one query (the
 * combined `SELECT modalities, tasks ...`), so a failure there omits BOTH
 * together -- documented, not an oversight.
 */

import { buildPublicCatalogBase, parseTokenList } from "./dataset-filters";

/** One vocabulary entry: a distinct value and how many datasets carry it. */
export interface FacetVocabularyEntry {
  readonly value: string;
  readonly count: number;
}

/**
 * `task`'s shape (D2): a truncated list that looks complete is the exact
 * failure mode this whole epic keeps producing, so `task` alone carries
 * `distinct_total`/`truncated` instead of a bare array -- 1040 distinct
 * labels measured against the real catalog, only the top `TASK_TOP_N` are
 * returned in `values`.
 */
export interface FacetTaskVocabulary {
  readonly values: readonly FacetVocabularyEntry[];
  readonly distinct_total: number;
  readonly truncated: boolean;
}

/**
 * The seven vocabulary keys computed via a plain `GROUP BY` over a single
 * scalar/enum column (D2). Four reuse an ENUM-kind FacetKey
 * (electrode-system, source, zarr, powerline), two reuse a VERSION-kind
 * FacetKey (bids-version, hed-version), and `license` is the pre-existing
 * `license_tier` legacy filter, which never had a facet-table entry to
 * reuse a key from. `modality`/`task` are NOT here -- they're comma-joined
 * columns tallied separately (D3), not a `GROUP BY`.
 *
 * Declared as a literal array (not derived from `shared/facets.ts`) on
 * purpose: the correspondence test below walks FACETS and checks each
 * enum-kind key is a member of this array, so adding a facet to
 * shared/facets.ts without extending this array is exactly the gap that
 * test exists to fail on -- deriving this list FROM FACETS would make that
 * failure impossible to produce.
 */
const GROUPED_VOCAB_KEYS = [
  "electrode-system",
  "source",
  "zarr",
  "powerline",
  "bids-version",
  "hed-version",
  "license",
] as const;
export type GroupedVocabKey = (typeof GROUPED_VOCAB_KEYS)[number];

/** The `datasets` column each grouped vocabulary key reads (D2's "Source column"). */
/** Exported so a test can assert this binds each key to the SAME column as
 *  dataset-facets.ts's FACET_DEFINITIONS does (#1177 integration review).
 *  The duplication is deliberate -- see the note above -- but only the KEY
 *  sets were ever checked, so a column rename touching one map would make
 *  filtering and the vocabulary endpoint disagree with every test green. */
export const GROUPED_VOCAB_COLUMNS: Record<GroupedVocabKey, string> = {
  "electrode-system": "d.electrode_system",
  source: "d.source",
  zarr: "d.zarr_status",
  powerline: "d.power_line_frequency",
  "bids-version": "d.bids_version",
  "hed-version": "d.hed_version",
  license: "d.license_tier",
};

/** Every key this endpoint can return. Exported so a test can assert the
 *  response shape against this list instead of hand-listing the strings a
 *  second time and letting the two drift. */
export const FACET_VOCABULARY_KEYS = [...GROUPED_VOCAB_KEYS, "modality", "task"] as const;
export type FacetVocabularyKey = (typeof FACET_VOCABULARY_KEYS)[number];

const TASK_TOP_N = 50;

/** Response shape: every key is OPTIONAL and ABSENT (not `[]`, not `null`)
 *  when its underlying query failed (D5) -- `[]` means the query succeeded
 *  and genuinely found no values. `hed-version`/`powerline` may legitimately
 *  be `[]` today, and an empty vocabulary is a population fact rather than
 *  evidence that any particular job has not run.
 *
 *  The general rule, stated as a rule because enumerating the columns is how
 *  this keeps being got wrong (#1171 review, and twice before it): EVERY
 *  column `computeDatasetMetadataColumns` writes is reachable from ordinary
 *  reindex traffic via `refreshDatasetMetadata`, not from a sweep alone.
 *  That includes `hed_version` and `power_line_frequency`, which land in the
 *  same `writeDatasetMetadataColumns` UPDATE. A column is sweep-only when
 *  NOTHING in that write path sets it -- `total_recording_duration` and
 *  `recording_count` (migration 0070) are the real examples. Check the write
 *  path before attributing an empty vocabulary to a pending sweep. */
export type FacetVocabulary = Partial<Record<GroupedVocabKey, FacetVocabularyEntry[]>> & {
  modality?: FacetVocabularyEntry[];
  task?: FacetTaskVocabulary;
};

export interface FacetVocabularyResult {
  readonly vocabulary: FacetVocabulary;
  /** Set only when at least one key above was omitted because its query
   *  failed -- mirrors the `warning` vocabulary GET /datasets already
   *  surfaces on its own catalog-fallback path. */
  readonly warning?: string;
}

function sortVocabulary(counts: Map<string, number>): FacetVocabularyEntry[] {
  // Deterministic for ties (verification case 6): count descending, then
  // value ascending -- never insertion/iteration order, which Map does not
  // guarantee is stable across engines for this purpose.
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * One `GROUP BY` query per grouped key, over the exact anonymous-visible
 * population (D4). `IS NOT NULL` excludes unclassified rows from the
 * vocabulary entirely -- an omitted value there is a real "not yet known"
 * dataset, not a vocabulary member.
 */
async function fetchGroupedVocabulary(
  db: D1Database,
  key: GroupedVocabKey,
): Promise<FacetVocabularyEntry[]> {
  const column = GROUPED_VOCAB_COLUMNS[key];
  const { from, params } = buildPublicCatalogBase("active", undefined, undefined);
  const sql = `SELECT ${column} AS value, COUNT(*) AS count ${from} AND ${column} IS NOT NULL GROUP BY ${column} ORDER BY count DESC, value ASC`;
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<{ value: string | number; count: number }>();
  return (result.results ?? []).map((row) => ({
    value: String(row.value),
    count: Number(row.count),
  }));
}

/**
 * D3: tokenize each row's comma-joined column with `parseTokenList` (split,
 * trim, lower-case, drop empties, DEDUPE WITHIN THE ROW) before tallying, so
 * `eeg,eeg` in one dataset counts once for that dataset -- this tallies
 * DATASETS CARRYING THE VALUE, not raw token occurrences. A dataset with an
 * empty or NULL column contributes to no bucket at all.
 *
 * That tokenizer is deliberately the one the `modality` FILTER uses
 * (`MODALITY_TOKENS_SQL` in dataset-filters.ts is its SQL twin), so a value
 * advertised here filters to exactly the count advertised here; the
 * "vocabulary and filter agree" test in modality-exact-token.test.ts holds
 * them to it. Only `modality` is filtered by whole token: `tasks`, tallied
 * here the same way, is still a substring filter.
 */
function tallyCommaJoinedColumn(values: readonly (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of values) {
    if (!raw) continue;
    for (const token of parseTokenList(raw)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

interface ModalityTaskVocabularies {
  readonly modality: FacetVocabularyEntry[];
  readonly task: FacetTaskVocabulary;
}

/**
 * One query fetches BOTH comma-joined columns (D3: "fetch the two columns
 * and tally in JS" -- one round trip, not two), over the same anonymous-
 * visible population every other vocabulary uses.
 */
async function fetchModalityAndTaskVocabularies(db: D1Database): Promise<ModalityTaskVocabularies> {
  const { from, params } = buildPublicCatalogBase("active", undefined, undefined);
  const sql = `SELECT d.modalities AS modalities, d.tasks AS tasks ${from}`;
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<{ modalities: string | null; tasks: string | null }>();
  const rows = result.results ?? [];

  const modality = sortVocabulary(tallyCommaJoinedColumn(rows.map((r) => r.modalities)));
  const allTasks = sortVocabulary(tallyCommaJoinedColumn(rows.map((r) => r.tasks)));
  const distinct_total = allTasks.length;
  const truncated = distinct_total > TASK_TOP_N;

  return {
    modality,
    task: { values: allTasks.slice(0, TASK_TOP_N), distinct_total, truncated },
  };
}

/**
 * Compute every facet vocabulary, degrading per-key on failure (D5). Never
 * throws: a query failure is reflected as an omitted key plus `warning`,
 * never a rejected promise the route handler would have to turn into a 500.
 */
export async function getFacetVocabulary(db: D1Database): Promise<FacetVocabularyResult> {
  const vocabulary: FacetVocabulary = {};
  const failedKeys: string[] = [];

  // Two separate allSettled calls (not one array mixing both promise types):
  // a single array literal combining FacetVocabularyEntry[] results with the
  // {modality, task} shape loses per-index typing to a union, and both
  // batches still run concurrently since neither awaits the other's result.
  const [groupedSettled, modalityTaskOutcome] = await Promise.all([
    Promise.allSettled(GROUPED_VOCAB_KEYS.map((key) => fetchGroupedVocabulary(db, key))),
    fetchModalityAndTaskVocabularies(db).then(
      (value) => ({ status: "fulfilled", value }) as const,
      (reason) => ({ status: "rejected", reason }) as const,
    ),
  ]);

  GROUPED_VOCAB_KEYS.forEach((key, i) => {
    const outcome = groupedSettled[i];
    if (outcome.status === "fulfilled") {
      vocabulary[key] = outcome.value;
    } else {
      failedKeys.push(key);
      console.warn(
        `[facets] vocabulary query failed for "${key}":`,
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      );
    }
  });

  if (modalityTaskOutcome.status === "fulfilled") {
    vocabulary.modality = modalityTaskOutcome.value.modality;
    vocabulary.task = modalityTaskOutcome.value.task;
  } else {
    failedKeys.push("modality", "task");
    console.warn(
      "[facets] modality/task vocabulary query failed:",
      modalityTaskOutcome.reason instanceof Error
        ? modalityTaskOutcome.reason.message
        : String(modalityTaskOutcome.reason),
    );
  }

  return {
    vocabulary,
    ...(failedKeys.length > 0
      ? { warning: `Vocabulary unavailable for: ${failedKeys.join(", ")}` }
      : {}),
  };
}
