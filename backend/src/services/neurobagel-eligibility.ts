/**
 * Which datasets may be federated (epic #1586, phase 4; ADR 0084).
 *
 * ONE predicate, written once as a list of named terms. Each term carries its SQL
 * and its TypeScript form side by side, so the query that selects candidates and
 * the check that re-confirms a row cannot drift apart: a test drives the same
 * generated rows through both and fails on any disagreement.
 *
 * DECIDED FROM THE D1 ROW, never from an HTTP `anonymous` value (ADR 0065). The
 * writer then refuses a dataset whose gathered `metadata.json` does not say
 * `anonymous: false` as well, as a second and independent guard; the two
 * disagreeing is an anonymity-class finding (see neurobagel-writer.ts).
 *
 * A dataset is eligible when it is:
 *   - active (`status`), public (`visibility`), and NOT anonymous (`anonymous = 0`;
 *     NULL is unknown, and unknown is not false);
 *   - first published (`first_published_at`), not withdrawn (`withdrawn_at`), and its
 *     concept DOI not tombstoned (`ezid_status` is not `unavailable`);
 *   - holding at least one `dataset_versions` row;
 *   - a real dataset: an `nm` id below the reserved fixture band (ADR 0068), or an
 *     `on` OpenNeuro mirror (INCLUDED by the owner's decision), and neither a
 *     sandbox nor an exemplar row. `xx` ids (sandboxes and the exemplar fleet) and the
 *     reserved `nm0999xx` fixtures are excluded by that term, in EVERY environment:
 *     the store and the index schema hold `nm` and `on` ids only, so an exemplar that
 *     the predicate admitted would be rewritten on every run and never indexed.
 *
 * "Deleted" is not a separate term: deleting a dataset removes its row, and a row
 * with `status = 'deleted'` fails the `active` term.
 *
 * WHAT THE REAL TAKEDOWN FLOWS LEAVE BEHIND, and which term catches each (the tests
 * drive the repository's own D1 helpers and the real cascade, not a copy):
 *   - `nemar admin repo withdraw` (services/withdraw.ts): `visibility = 'private'` (the first
 *     write), then `withdrawn_at` and `withdrawn_reason`, then the concept DOI's and
 *     every version DOI's `ezid_status = 'unavailable'`; `status` and the version rows
 *     are untouched. `public` and `not_withdrawn` each reject it; so does
 *     `not_tombstoned`, and so does the state an interrupted withdrawal stops in.
 *   - a DOI tombstoned on its own (`POST /admin/datasets/:id/doi/update`, status
 *     `unavailable`): writes ONLY `datasets.ezid_status`, leaving a dataset public,
 *     active and not withdrawn. Only `not_tombstoned` rejects that, which is why it is a
 *     term: a dataset whose DOI is deliberately unavailable must not stay federated.
 *   - `DELETE /admin/datasets/:id` (services/deletion.ts): the row, its versions and its
 *     collaborators are removed in one batch after the repository and objects go, so the
 *     row is simply absent.
 */

import { RESERVED_FIXTURE_FLOOR, formatDatasetId } from "./datasetId.js";

/** The first reserved `nm` id: real datasets are strictly below it (ADR 0068). */
export const NEUROBAGEL_REAL_NM_CEILING = formatDatasetId("nm", RESERVED_FIXTURE_FLOOR);

const NM_ID = /^nm\d{6}$/;
const ON_ID = /^on\d{6}$/;

/** A `datasets` row as the eligibility query projects it. `has_version` is 0 or 1. */
export interface FederationRow {
  dataset_id: string;
  status: string | null;
  visibility: string | null;
  anonymous: number | null;
  first_published_at: string | null;
  withdrawn_at: string | null;
  /** The concept DOI's EZID status; `unavailable` is a tombstone. */
  ezid_status: string | null;
  is_sandbox: number | null;
  is_exemplar: number | null;
  has_version: number | null;
}

export type FederationTermId =
  | "active"
  | "public"
  | "not_anonymous"
  | "first_published"
  | "not_withdrawn"
  | "not_tombstoned"
  | "has_version"
  | "real_dataset";

export interface FederationTerm {
  id: FederationTermId;
  /** SQL over the `datasets d` alias. No term binds a parameter: every id it names is a literal. */
  sql: string;
  /** The same term over a row. */
  holds(row: FederationRow): boolean;
}

const NM_GLOB = "nm[0-9][0-9][0-9][0-9][0-9][0-9]";
const ON_GLOB = "on[0-9][0-9][0-9][0-9][0-9][0-9]";

/** Order is the order the terms appear in {@link NEUROBAGEL_ELIGIBLE_SQL}. */
export const FEDERATION_TERMS: readonly FederationTerm[] = [
  {
    id: "active",
    sql: "d.status = 'active'",
    holds: (row) => row.status === "active",
  },
  {
    id: "public",
    sql: "d.visibility = 'public'",
    holds: (row) => row.visibility === "public",
  },
  {
    id: "not_anonymous",
    // `= 0`, not `<> 1`: NULL is unknown, and unknown is not false.
    sql: "d.anonymous = 0",
    holds: (row) => row.anonymous === 0,
  },
  {
    id: "first_published",
    sql: "d.first_published_at IS NOT NULL",
    holds: (row) => row.first_published_at !== null && row.first_published_at !== undefined,
  },
  {
    id: "not_withdrawn",
    sql: "d.withdrawn_at IS NULL",
    holds: (row) => row.withdrawn_at === null || row.withdrawn_at === undefined,
  },
  {
    id: "not_tombstoned",
    // NULL is "never classified", which most datasets are, and is not a tombstone.
    sql: "COALESCE(d.ezid_status, '') <> 'unavailable'",
    holds: (row) => row.ezid_status !== "unavailable",
  },
  {
    id: "has_version",
    sql: "EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id)",
    holds: (row) => row.has_version === 1,
  },
  {
    id: "real_dataset",
    sql: `(
        ((d.dataset_id GLOB '${NM_GLOB}' AND d.dataset_id < '${NEUROBAGEL_REAL_NM_CEILING}')
          OR d.dataset_id GLOB '${ON_GLOB}')
        AND COALESCE(d.is_sandbox, 0) = 0 AND COALESCE(d.is_exemplar, 0) = 0
      )`,
    // An id with an embedded NUL can pass SQLite's GLOB (it stops at the NUL) while this
    // anchored pattern refuses it. That is the fail-safe direction and unreachable: ids
    // are validated at creation, and a disagreement is a refusal, never a dataset served.
    holds: (row) =>
      ((NM_ID.test(row.dataset_id) && row.dataset_id < NEUROBAGEL_REAL_NM_CEILING) ||
        ON_ID.test(row.dataset_id)) &&
      (row.is_sandbox ?? 0) === 0 &&
      (row.is_exemplar ?? 0) === 0,
  },
];

/**
 * The eligibility predicate as one SQL fragment over `datasets d`: every term,
 * ANDed. It holds NO bound parameter, so a statement that embeds it binds only its own.
 *
 * Embed it; never copy it (.rules/testing.md): a copy is a predicate that can
 * disagree with this one.
 */
export const NEUROBAGEL_ELIGIBLE_SQL = FEDERATION_TERMS.map((t) => t.sql).join("\n    AND ");

/**
 * The columns {@link isFederationEligible} reads, with `has_version` computed.
 * `FROM datasets d` is the caller's. Deliberately projects no `concept_doi` and no
 * identity column: eligibility is a decision, not a document.
 */
export const NEUROBAGEL_ROW_COLUMNS = `d.dataset_id, d.status, d.visibility, d.anonymous,
    d.first_published_at, d.withdrawn_at, d.ezid_status, d.is_sandbox, d.is_exemplar,
    EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id) AS has_version`;

/** One dataset's row regardless of eligibility, for the re-check. */
const NEUROBAGEL_ROW_BY_ID_SQL = `SELECT ${NEUROBAGEL_ROW_COLUMNS}
  FROM datasets d
 WHERE d.dataset_id = ?`;

/**
 * Could this id EVER be federated? A pure look at the id, no I/O: an `nm` id below the
 * reserved band or an `on` mirror. The hooks use it to return before any read for an
 * `xx` sandbox, an exemplar or a reserved fixture, which are never federated; it
 * decides nothing about a dataset that passes, which still needs its row checked.
 */
export function couldBeFederated(datasetId: string): boolean {
  if (NM_ID.test(datasetId)) return datasetId < NEUROBAGEL_REAL_NM_CEILING;
  return ON_ID.test(datasetId);
}

/** The pure re-check over a row. True only when every term holds. */
export function isFederationEligible(row: FederationRow | null | undefined): boolean {
  if (!row) return false;
  return FEDERATION_TERMS.every((t) => t.holds(row));
}

/**
 * The ids of the terms a row fails. Empty means eligible. Exported for the necessity
 * tests (each term must be the ONLY one a crafted row fails) and for any report that
 * has to say why a row is out; no production path calls it today.
 */
export function failedFederationTerms(row: FederationRow | null | undefined): FederationTermId[] {
  if (!row) return ["real_dataset"];
  return FEDERATION_TERMS.filter((t) => !t.holds(row)).map((t) => t.id);
}

/** Load one row and re-check it: the SQL selects, the TypeScript confirms. */
export async function loadEligibleRow(
  db: D1Database,
  datasetId: string,
): Promise<{ row: FederationRow | null; eligible: boolean }> {
  const row = await db.prepare(NEUROBAGEL_ROW_BY_ID_SQL).bind(datasetId).first<FederationRow>();
  return { row: row ?? null, eligible: isFederationEligible(row) };
}

/**
 * The ids, among `ids`, that are eligible NOW: the SQL decides and the TypeScript
 * re-checks every row it returns, so a drift between the two shows as a refusal
 * rather than as a dataset served.
 */
export async function eligibleAmong(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await db
    .prepare(
      `SELECT ${NEUROBAGEL_ROW_COLUMNS}
         FROM datasets d
        WHERE ${NEUROBAGEL_ELIGIBLE_SQL}
          AND d.dataset_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(ids))
    .all<FederationRow>();
  const out = new Set<string>();
  for (const row of result.results ?? []) {
    if (isFederationEligible(row)) out.add(row.dataset_id);
  }
  return out;
}
