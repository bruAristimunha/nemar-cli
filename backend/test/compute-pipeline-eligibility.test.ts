/**
 * Which datasets NEMAR's own pipelines may process (epic #2005 phase A6, #2011; ADR 0065; ADR 0118).
 *
 * The predicate is one list of named terms, each with its SQL and its TypeScript form. This file proves,
 * against the real schema:
 *
 *  1. SQL and TypeScript AGREE: every id class crossed with every fact vector goes through both, and
 *     any disagreement fails the test.
 *  2. EACH TERM IS NECESSARY (mutation-style): for every term there is a row that breaks exactly that
 *     term and no other, the real predicate rejects it, and the predicate with that one term REMOVED
 *     accepts it. A term nothing depends on would leave the mutant rejecting the row too.
 *  3. The rows the phase names come out the way the issue says: an anonymous, private, withdrawn,
 *     non-EEG, versionless and fixture-band row each fail exactly their term, and `ieeg` is not `eeg`.
 *  4. The version helpers: the SQL tag expression is `dataTagForVersion` over generated versions, and
 *     the newest version is the data plane's `latest`.
 *
 * The predicate is imported, never retyped (.rules/testing.md).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { dataTagForVersion } from "../../shared/contract/compute";
import {
  PIPELINE_ELIGIBLE_SQL,
  PIPELINE_REAL_NM_CEILING,
  PIPELINE_ROW_COLUMNS,
  PIPELINE_TERMS,
  type PipelineRow,
  type PipelineTermId,
  VERSIONS_OF_SQL,
  VERSION_TAG_SQL,
  failedPipelineTerms,
  isPipelineEligible,
  loadPipelineRow,
  pickVersion,
} from "../src/services/compute-pipeline-eligibility";
import { RESERVED_FIXTURE_FLOOR, formatDatasetId } from "../src/services/datasetId";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { seedDatasetRow } from "./helpers/neurobagel-harness";

/**
 * This file is about the PRODUCTION predicate, `PIPELINE_ELIGIBLE_SQL`: every function that decides takes the
 * environment (plan S1), and production's is the one whose text and terms this file pins. What a
 * non-production environment lets through in addition is `compute-fixture-eligibility.test.ts`'s.
 */
const PRODUCTION = { ENVIRONMENT: "production" } as Pick<Bindings, "ENVIRONMENT">;

let db: Database;
beforeEach(() => {
  db = freshDb();
});

/** A dataset row with a modality list (the shared seed has none). */
function seed(
  id: string,
  seedOver: Parameters<typeof seedDatasetRow>[2] = {},
  modalities: string | null = "eeg",
): void {
  seedDatasetRow(db, id, seedOver);
  db.run("UPDATE datasets SET modalities = ? WHERE dataset_id = ?", [modalities, id]);
}

/** The ids the real predicate selects. */
async function selected(sqlOverride?: string): Promise<string[]> {
  const sql =
    sqlOverride ??
    `SELECT d.dataset_id FROM datasets d WHERE ${PIPELINE_ELIGIBLE_SQL} ORDER BY d.dataset_id`;
  const result = await realD1(db).prepare(sql).all<{ dataset_id: string }>();
  return result.results.map((r) => r.dataset_id);
}

/** The predicate with ONE term left out: the mutant. */
const predicateWithout = (term: PipelineTermId) =>
  PIPELINE_TERMS.filter((t) => t.id !== term)
    .map((t) => t.sql)
    .join(" AND ");

describe("the predicate's shape", () => {
  test("binds no parameter: every literal a term names is inline", () => {
    expect(PIPELINE_ELIGIBLE_SQL.match(/\?/g)).toBeNull();
    expect(isPipelineEligible.length).toBe(2);
    for (const t of PIPELINE_TERMS) expect(t.holds.length).toBe(1);
  });

  test("names every term it ANDs, and each id once", () => {
    const ids = PIPELINE_TERMS.map((t) => t.id);
    expect(ids).toEqual([
      "active",
      "public",
      "not_anonymous",
      "first_published",
      "not_withdrawn",
      "not_tombstoned",
      "has_version",
      "eeg",
      "real_dataset",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of PIPELINE_TERMS) expect(PIPELINE_ELIGIBLE_SQL).toContain(t.sql);
  });

  test("the anonymity term is `anonymous = 0`, and never `<> 1`: NULL is unknown and unknown is not false", () => {
    const term = PIPELINE_TERMS.find((t) => t.id === "not_anonymous");
    expect(term?.sql).toBe("d.anonymous = 0");
    expect(term?.sql).not.toMatch(/IS NOT 1|<>\s*1|!=\s*1/);
  });

  test("the real-id ceiling is the reserved fixture band's floor, derived and not retyped", () => {
    expect(PIPELINE_REAL_NM_CEILING).toBe(formatDatasetId("nm", RESERVED_FIXTURE_FLOOR));
    expect(PIPELINE_REAL_NM_CEILING).toBe("nm099900");
    expect(PIPELINE_ELIGIBLE_SQL).toContain(`'${PIPELINE_REAL_NM_CEILING}'`);
  });

  test("projects no identity and no DOI column", () => {
    expect(PIPELINE_ROW_COLUMNS).not.toMatch(/concept_doi|owner|authors|enrichment/);
  });
});

/** A row that satisfies every term, as the baseline each mutant departs from. */
const BASE: PipelineRow = {
  dataset_id: "nm000500",
  status: "active",
  visibility: "public",
  anonymous: 0,
  first_published_at: "2026-01-02 03:04:05",
  withdrawn_at: null,
  ezid_status: null,
  is_sandbox: 0,
  is_exemplar: 0,
  modalities: "eeg",
  has_version: 1,
};

/** The one row per term that breaks that term and no other. */
const BREAKS: Record<
  PipelineTermId,
  {
    seed: Parameters<typeof seedDatasetRow>[2];
    modalities?: string | null;
    id?: string;
    withoutTriggers?: boolean;
  }
> = {
  active: { seed: { status: "archived" } },
  public: { seed: { visibility: "private" } },
  // The schema's triggers (migration 0085) make `anonymous = 1` imply `first_published_at IS NULL`, so
  // with them in place `first_published` ALONE would reject an anonymous row. It is the SECOND line,
  // not a duplicate: a table rebuild drops triggers. So the row that proves it is the one the triggers
  // would have refused, built after dropping them, which is the state a bad migration leaves.
  not_anonymous: {
    seed: { anonymous: 1, firstPublishedAt: "2026-01-02 03:04:05" },
    withoutTriggers: true,
  },
  first_published: { seed: { firstPublishedAt: null } },
  not_withdrawn: { seed: { withdrawnAt: "2026-02-01 00:00:00" } },
  not_tombstoned: { seed: { ezidStatus: "unavailable" } },
  has_version: { seed: { versions: [] } },
  eeg: { seed: {}, modalities: "meg" },
  real_dataset: { seed: {}, id: "nm099950" },
};

describe("each term is necessary (mutation-style)", () => {
  for (const term of PIPELINE_TERMS) {
    test(`${term.id}: a row breaking only it is rejected, and accepted once the term is removed`, async () => {
      const broken = BREAKS[term.id];
      const id = broken.id ?? "nm000500";
      seed("nm000501", {}); // a clean control that every variant accepts
      if (broken.withoutTriggers) {
        db.exec("DROP TRIGGER datasets_anonymous_unpublished_ai");
        db.exec("DROP TRIGGER datasets_anonymous_unpublished_au");
      }
      seed(id, broken.seed, broken.modalities === undefined ? "eeg" : broken.modalities);

      expect(await selected()).toEqual(["nm000501"]);
      // The mutant: the same predicate minus this one term accepts the broken row.
      expect(
        await selected(
          `SELECT d.dataset_id FROM datasets d WHERE ${predicateWithout(term.id)} ORDER BY d.dataset_id`,
        ),
      ).toContain(id);

      const row = await realD1(db)
        .prepare(`SELECT ${PIPELINE_ROW_COLUMNS} FROM datasets d WHERE d.dataset_id = ?`)
        .bind(id)
        .first<PipelineRow>();
      expect(isPipelineEligible(row, PRODUCTION)).toBe(false);
      expect(failedPipelineTerms(row, PRODUCTION)).toEqual([term.id]);
      expect(
        PIPELINE_TERMS.filter((t) => t.id !== term.id).every((t) => t.holds(row as PipelineRow)),
      ).toBe(true);
    });
  }

  test("changing `anonymous = 0` to `IS NOT 1` flips the NULL row: unknown must fail", () => {
    // `anonymous` is NOT NULL in the schema, so the row that would separate the two forms cannot be
    // stored; the TypeScript form is the one that sees it, and the SQL term is pinned to `= 0` above.
    const unknown: PipelineRow = { ...BASE, anonymous: null };
    expect(isPipelineEligible(unknown, PRODUCTION)).toBe(false);
    expect(failedPipelineTerms(unknown, PRODUCTION)).toEqual(["not_anonymous"]);
    // The mutant `IS NOT 1` would hold for NULL; this is the row it would wrongly let through.
    expect(unknown.anonymous !== 1).toBe(true);
    seed("nm000502");
    expect(() =>
      db.run("UPDATE datasets SET anonymous = NULL WHERE dataset_id = 'nm000502'"),
    ).toThrow(/NOT NULL constraint failed: datasets\.anonymous/);
  });

  test("with the schema's triggers in place an anonymous row fails two terms, which back each other up", async () => {
    seed("nm000503", { anonymous: 1, firstPublishedAt: null });
    const row = (await loadPipelineRow(realD1(db), "nm000503", PRODUCTION)).row as PipelineRow;
    expect(failedPipelineTerms(row, PRODUCTION)).toEqual(["not_anonymous", "first_published"]);
  });
});

describe("the rows the issue names, each failing exactly its term", () => {
  test("anonymous, private, withdrawn, non-EEG, versionless and fixture-band", async () => {
    db.exec("DROP TRIGGER datasets_anonymous_unpublished_ai");
    db.exec("DROP TRIGGER datasets_anonymous_unpublished_au");
    seed("nm000600"); // eligible
    seed("nm000601", { anonymous: 1 });
    seed("nm000602", { visibility: "private" });
    seed("nm000603", { withdrawnAt: "2026-02-01 00:00:00" });
    seed("nm000604", {}, "meg");
    seed("nm000605", { versions: [] });
    seed("nm099901"); // the fixture band
    const d1 = realD1(db);
    const expected: Record<string, PipelineTermId[]> = {
      nm000600: [],
      nm000601: ["not_anonymous"],
      nm000602: ["public"],
      nm000603: ["not_withdrawn"],
      nm000604: ["eeg"],
      nm000605: ["has_version"],
      nm099901: ["real_dataset"],
    };
    for (const [id, terms] of Object.entries(expected)) {
      const { eligible, blockedBy } = await loadPipelineRow(d1, id, PRODUCTION);
      expect([id, blockedBy, eligible]).toEqual([id, terms, terms.length === 0]);
    }
    expect(await selected()).toEqual(["nm000600"]);
  });

  test("a dataset that is not there is blocked by every term, and is not eligible", async () => {
    const loaded = await loadPipelineRow(realD1(db), "nm000777", PRODUCTION);
    expect(loaded.row).toBeNull();
    expect(loaded.eligible).toBe(false);
    expect(loaded.blockedBy).toEqual(PIPELINE_TERMS.map((t) => t.id));
  });

  test("a mirror is in, a sandbox and an exemplar are out, in every environment", async () => {
    seed("on000100");
    seed("nm000610", { isSandbox: 1 });
    seed("nm000611", { isExemplar: 1 });
    seed("xx000100");
    seed("xx099900");
    expect(await selected()).toEqual(["on000100"]);
  });

  test("the modality is a WHOLE token: ieeg is not eeg, and case and spaces around a token do not matter", async () => {
    const cases: Array<[string | null, boolean]> = [
      ["eeg", true],
      ["EEG", true],
      [" eeg ", true],
      ["meg,eeg", true],
      ["beh , EEG", true],
      ["eeg,ieeg", true],
      ["ieeg", false],
      ["e eg", false],
      ["eegx", false],
      ["meg", false],
      ["", false],
      [null, false],
    ];
    let n = 700;
    for (const [modalities, wanted] of cases) {
      const id = `nm000${n++}`;
      seed(id, {}, modalities);
      const sql = (await selected()).includes(id);
      const row = await loadPipelineRow(realD1(db), id, PRODUCTION);
      expect([modalities, sql, row.eligible]).toEqual([modalities, wanted, wanted]);
    }
  });
});

describe("SQL and TypeScript agree on every combination", () => {
  const CLASSES = [
    { prefix: "nm", base: 108 },
    { prefix: "nm", base: 99900 },
    { prefix: "on", base: 100 },
    { prefix: "xx", base: 100 },
    { prefix: "xx", base: 99900 },
    { prefix: "ds", base: 1 },
  ];
  const published = "2026-01-02 03:04:05";
  const VECTORS: Array<[Parameters<typeof seedDatasetRow>[2], string | null]> = [
    [{}, "eeg"],
    [{ status: "archived" }, "eeg"],
    [{ status: "deleted" }, "eeg"],
    [{ visibility: "private" }, "eeg"],
    [{ anonymous: 1, firstPublishedAt: null }, "eeg"],
    [{ firstPublishedAt: null }, "eeg"],
    [{ withdrawnAt: "2026-02-01 00:00:00" }, "eeg"],
    [{ ezidStatus: "unavailable" }, "eeg"],
    [{ ezidStatus: "public" }, "eeg"],
    [{ versions: [] }, "eeg"],
    [{ isSandbox: 1 }, "eeg"],
    [{ isExemplar: 1 }, "eeg"],
    [{}, "meg"],
    [{}, "ieeg"],
    [{}, "meg,eeg"],
    [{}, null],
    [{ visibility: "private", withdrawnAt: published }, "eeg"],
    [{ anonymous: 1, firstPublishedAt: null, isExemplar: 1, isSandbox: 1 }, "ieeg"],
  ];

  test("every id class crossed with every fact vector is judged the same by both", async () => {
    let seeded = 0;
    for (const klass of CLASSES) {
      for (const [i, [vector, modalities]] of VECTORS.entries()) {
        seed(`${klass.prefix}${String(klass.base + i).padStart(6, "0")}`, vector, modalities);
        seeded++;
      }
    }
    const bySql = new Set(await selected());
    const rows = await realD1(db)
      .prepare(`SELECT ${PIPELINE_ROW_COLUMNS} FROM datasets d ORDER BY d.dataset_id`)
      .all<PipelineRow>();
    expect(rows.results).toHaveLength(seeded);
    let accepted = 0;
    for (const row of rows.results) {
      const byTs = isPipelineEligible(row, PRODUCTION);
      if (byTs) accepted++;
      expect(`${row.dataset_id}:${byTs}`).toBe(`${row.dataset_id}:${bySql.has(row.dataset_id)}`);
    }
    expect(accepted).toBeGreaterThan(2);
    expect(accepted).toBeLessThan(seeded / 2);
  });
});

describe("the version a run reads", () => {
  test("the SQL tag expression is dataTagForVersion over generated versions that have a tag", async () => {
    const versions = ["1.0.0", "v1.0.0", "2.10.3", "v10.0.1", "latest", "0.0.1"];
    for (const v of versions) {
      const row = await realD1(db)
        .prepare(`SELECT ${VERSION_TAG_SQL("?1")} AS tag`)
        .bind(v)
        .first<{ tag: string }>();
      expect([v, row?.tag]).toEqual([v, dataTagForVersion(v)]);
    }
  });

  test("the newest version row is the data plane's latest: by created_at, with the id as the tie", async () => {
    seed("nm000800", {
      versions: [
        ["1.0.0", "2026-01-01 00:00:00"],
        ["1.1.0", "2026-03-01 00:00:00"],
        ["1.0.1", "2026-02-01 00:00:00"],
      ],
    });
    const rows = (
      await realD1(db)
        .prepare(VERSIONS_OF_SQL)
        .bind("nm000800")
        .all<{ version: string; total_files: number | null }>()
    ).results;
    expect(rows.map((r) => r.version)).toEqual(["1.1.0", "1.0.1", "1.0.0"]);
    const picked = pickVersion(rows, undefined);
    expect(picked).toMatchObject({ ok: true, tag: "v1.1.0" });
    expect(pickVersion(rows, "latest")).toMatchObject({ ok: true, tag: "v1.1.0" });
    expect(pickVersion(rows, "1.0.1")).toMatchObject({ ok: true, tag: "v1.0.1" });
    expect(pickVersion(rows, "v1.0.0")).toMatchObject({ ok: true, tag: "v1.0.0" });
    expect(pickVersion(rows, "9.9.9")).toEqual({ ok: false, code: "version_not_found" });
    expect(pickVersion(rows, "not-a-version")).toEqual({ ok: false, code: "version_not_found" });
    expect(pickVersion([], undefined)).toEqual({ ok: false, code: "version_not_found" });
  });

  test("a version with no data-plane tag is refused, not guessed", () => {
    expect(pickVersion([{ version: "1.0", total_files: null }], undefined)).toEqual({
      ok: false,
      code: "version_untagged",
    });
    expect(pickVersion([{ version: "2.0.0-rc.1", total_files: null }], undefined)).toEqual({
      ok: false,
      code: "version_untagged",
    });
  });
});
