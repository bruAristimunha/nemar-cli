/**
 * The per-call filter cap counts the same filters the query builders act on.
 *
 * `activeFilterNames` decides what "a filter is set" means from the built
 * `DatasetFilterOptions`; `buildDatasetFilterClauses` and `parseFacetFilters`
 * decide it again, independently, from truthiness guards scattered across two
 * modules. If the two disagree, the cap refuses a call over a filter the SQL
 * was never going to carry, or counts one it does. Nothing in the type system
 * connects them, so this file does.
 *
 * An earlier revision counted the RAW WIRE ARGUMENT instead, and was wrong for
 * ten of the thirty filters -- `license: "CC0-1.0"` (a non-empty string that
 * parses to no tiers), an enum facet given `","`, a version facet given `"v"`,
 * and whitespace in `modality`/`task`/`author` (which the builder's bare
 * truthiness accepts and binds). The tests below missed all ten, because they
 * supplied exactly one valid and one empty value per filter, and every
 * divergence lives at a third class of value: supplied, non-empty, and inert.
 * `INERT_VALUES` is that third class, and it is the table to extend first when
 * this file is touched.
 *
 * Real modules throughout, and a real database: `freshDb()`/`realD1()`
 * (helpers/d1.ts) apply every migration to in-memory SQLite and execute the
 * production SQL, so the cap tests run the tool end to end rather than
 * asserting on a boolean.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  SEARCH_DATASETS_FILTER_PARAMS,
  SEARCH_DATASETS_MAX_FILTERS,
  SEARCH_DATASETS_NARROWING_FILTERS,
  type SearchDatasetsInput,
} from "../../shared/contract/mcp";
import { FACETS } from "../../shared/facets";
import {
  activeFilterNames,
  buildFilterOptions,
  searchDatasetsTool,
} from "../src/mcp/tools/search-datasets";
import { parseFacetFilters } from "../src/services/dataset-facets";
import {
  MAX_BOUND_PARAMS,
  buildDatasetFilterClauses,
  buildPublicCatalogBase,
} from "../src/services/dataset-filters";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

/** A value that must make each bespoke filter narrow, with the SQL its clause
 *  must contain. The fragments are the independent witness against a
 *  transposition in `buildFilterOptions`' wire-name-to-field mapping, which is
 *  otherwise invisible: swapping two boolean filters there leaves every count
 *  and every parameter total unchanged. */
const BESPOKE: Record<string, { set: unknown; sql: string }> = {
  modality: { set: "eeg", sql: "d.modalities" },
  task: { set: "rest", sql: "d.tasks" },
  author: { set: "smith", sql: "d.authors" },
  has_hed: { set: true, sql: "d.has_hed = 1" },
  has_zarr: { set: true, sql: "d.zarr_status = 'ready'" },
  has_doi: { set: true, sql: "d.concept_doi" },
  has_zarr_verified: { set: true, sql: "sweep_stamps" },
  data_complete: { set: true, sql: "d.data_complete = 1" },
  recent: { set: 30, sql: "d.publish_date" },
  license: { set: "public", sql: "d.license_tier" },
};

/**
 * Supplied, non-empty, and inert after parsing, or live and narrowing to
 * nothing: values a caller can really send that reach a parser and come back
 * with no usable value. Each is either dropped (no clause, not counted) or
 * kept as a clause that matches nothing (counted); the count and the SQL must
 * settle it the same way. The class the old wire-level count got wrong, and
 * the reason the filter cap now runs after parsing.
 */
const INERT_VALUES: Record<string, unknown> = {
  // `parseLicenseTierFilter` keeps only declared tiers and drops the rest, and
  // the zod4 mirror's own description tells a model exactly that -- so an SPDX
  // identifier here is a caller doing what the schema invited.
  license: "CC0-1.0",
  // Whitespace: `narrows` used to trim and see "unset" while the builder's
  // `if (opts.modality)` sees a truthy string. Since #1711 the builder keeps
  // it as a LIVE filter that names no token: it binds an empty token list
  // (`[]`) and matches nothing, and the count includes it. The other entries
  // here are dropped instead; the assertion only needs the two to agree.
  modality: "  ",
  task: "\t",
  author: " ",
  // An enum facet whose tokens all reduce to empty yields no values, so the
  // key never enters the parsed bag.
  powerline: ",",
  source: " , ",
  // A version facet strips a leading `v`, leaving an empty prefix.
  bids_version: "v",
  hed_version: "V",
};

/** The widest legal value for a facet, by declared kind. */
function facetSetValue(facet: (typeof FACETS)[number]): string {
  switch (facet.valueKind) {
    case "number":
      return "0..999999";
    case "bytes":
      return "0b..900tb";
    case "duration":
      return "0s..9000h";
    case "enum":
      return (facet.enumValues ?? []).join(",");
    case "text":
      return "a";
    case "version":
      return "1";
  }
}

function setValueFor(name: string): unknown {
  const facet = FACETS.find((f) => f.queryParam === name);
  return facet ? facetSetValue(facet) : BESPOKE[name]?.set;
}

/** Options and clauses for one argument object, via the real path the tool
 *  takes: parse the facets, map to options, build the SQL. */
function build(args: Record<string, unknown>): {
  clauses: string;
  params: (string | number)[];
  names: string[];
} {
  const facets = parseFacetFilters((key) => {
    const raw = args[key];
    return typeof raw === "string" ? raw : undefined;
  });
  const options = buildFilterOptions(args as SearchDatasetsInput, facets);
  const params: (string | number)[] = [];
  const clauses = buildDatasetFilterClauses(params, options);
  return { clauses, params, names: activeFilterNames(options) };
}

describe("the filter cap counts what the query builders act on", () => {
  test("covers every declared narrowing filter", () => {
    // Guards the tables above from going stale: a bespoke filter added to the
    // contract without an entry here would otherwise be skipped silently, and
    // every assertion in this file would still pass. It also closes the empty
    // -list hole for the loops below -- they cannot silently iterate zero
    // times while these identities hold.
    expect(SEARCH_DATASETS_NARROWING_FILTERS.filter((n) => !(n in BESPOKE))).toEqual([]);
    expect(
      Object.keys(BESPOKE).filter((n) => !SEARCH_DATASETS_NARROWING_FILTERS.includes(n)),
    ).toEqual([]);
    expect(SEARCH_DATASETS_FILTER_PARAMS.length).toBe(
      SEARCH_DATASETS_NARROWING_FILTERS.length + FACETS.length,
    );
    expect(
      Object.keys(INERT_VALUES).filter((n) => !SEARCH_DATASETS_FILTER_PARAMS.includes(n)),
    ).toEqual([]);
  });

  test("every facet can still be combined in one call", () => {
    // The doc comment on SEARCH_DATASETS_MAX_FILTERS says twenty is the facet
    // count, so no caller has to choose between declared facets. Without this,
    // the sentence goes silently false the day a 21st facet lands -- and the
    // constant itself is pinned by nothing else, since every fixture below
    // sizes itself FROM it.
    expect(SEARCH_DATASETS_MAX_FILTERS).toBeGreaterThanOrEqual(FACETS.length);
  });

  test("a set value both counts and builds its own clause, for every filter", () => {
    for (const name of SEARCH_DATASETS_FILTER_PARAMS) {
      const { names, clauses } = build({ [name]: setValueFor(name) });
      expect({ name, counted: names }).toEqual({ name, counted: [name] });
      // Not just "some clause": the one this filter is supposed to build.
      const fragment = BESPOKE[name]?.sql;
      if (fragment) {
        expect({ name, has: clauses.includes(fragment) }).toEqual({ name, has: true });
      } else {
        expect({ name, narrowed: clauses.trim().length > 0 }).toEqual({ name, narrowed: true });
      }
    }
  });

  test("a value that builds no clause is not counted either", () => {
    // `""` for any string filter, `false` for a boolean one -- `has_doi: false`
    // does NOT mean "datasets without a DOI", it means no clause at all.
    for (const name of SEARCH_DATASETS_FILTER_PARAMS) {
      const set = setValueFor(name);
      const empty = typeof set === "boolean" ? false : typeof set === "number" ? 0 : "";
      const { names, clauses } = build({ [name]: empty });
      expect({ name, counted: names }).toEqual({ name, counted: [] });
      expect({ name, narrowed: clauses.trim().length > 0 }).toEqual({ name, narrowed: false });
    }
  });

  test("a supplied but inert value agrees, whichever way the parser resolves it", () => {
    // The table that fails against a wire-level count. Each of these is
    // non-empty on the wire, so the question is only ever settled after
    // parsing -- and the count and the SQL have to settle it the same way.
    for (const [name, value] of Object.entries(INERT_VALUES)) {
      const { names, clauses, params } = build({ [name]: value });
      const narrowed = clauses.trim().length > 0;
      expect({ name, counted: names.includes(name), narrowed }).toEqual({
        name,
        counted: narrowed,
        narrowed,
      });
      // And whichever way it went, the parameters match the clauses: an inert
      // value must not bind one, a live one must.
      expect({ name, bound: params.length > 0 }).toEqual({ name, bound: narrowed });
    }
  });

  test("include_unknown, query and limit are not filters", () => {
    // `include_unknown` WIDENS every active facet; `query` and `limit` are not
    // filters at all. None may consume the caller's twenty.
    expect(build({ include_unknown: true, query: "eeg", limit: 5 }).names).toEqual([]);
    for (const name of ["include_unknown", "query", "limit"]) {
      expect(SEARCH_DATASETS_FILTER_PARAMS.includes(name)).toBe(false);
    }
  });

  test("every filter at once stays inside D1's bound-parameter ceiling", () => {
    // Counted on the STATEMENT, not on the filter clauses alone: the catalog
    // base contributes its own parameters ahead of them and the page contributes
    // a LIMIT after, and the ceiling applies to the whole statement. Both
    // branches of the tool build the same filter clauses over the same base, so
    // one measurement covers them.
    //
    // `assertBoundParamBudget` (#1193/#1195) throws from inside
    // `buildDatasetFilterClauses` above MAX_BOUND_PARAMS, so building the worst
    // case a caller can construct IS the assertion -- an overflow fails this
    // test by throwing. The exact pin makes a facet that moves it visible in a
    // diff rather than only when the ceiling is reached.
    const everything: Record<string, unknown> = {};
    for (const name of SEARCH_DATASETS_FILTER_PARAMS) everything[name] = setValueFor(name);

    const { params } = buildPublicCatalogBase("active", undefined, undefined);
    const facets = parseFacetFilters((key) => {
      const raw = everything[key];
      return typeof raw === "string" ? raw : undefined;
    });
    buildDatasetFilterClauses(
      params,
      buildFilterOptions(everything as SearchDatasetsInput, facets),
    );
    params.push(25); // the page's LIMIT
    expect(params.length).toBeLessThanOrEqual(MAX_BOUND_PARAMS);
    expect(params.length).toBe(52);
  });
});

/** A public, active row with everything else left NULL -- the "not yet
 *  populated" state `include_unknown` exists to admit. */
function insertDataset(db: Database, datasetId: string, cols: Record<string, unknown> = {}): void {
  const merged: Record<string, unknown> = {
    owner_user_id: -1,
    name: datasetId,
    visibility: "public",
    status: "active",
    is_sandbox: 0,
    ...cols,
  };
  const keys = Object.keys(merged);
  db.query(
    `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
  ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
}

describe("search_datasets refuses more filters than it can combine", () => {
  let db: Database;
  let env: Pick<Bindings, "DB" | "AI" | "VECTORIZE">;

  beforeEach(() => {
    db = freshDb();
    insertDataset(db, "nm000001", { subject_count: 12 });
    insertDataset(db, "nm000002", { subject_count: 400 });
    env = { DB: realD1(db), AI: {} as never, VECTORIZE: {} as never };
  });

  /** The declared facets, all at their widest -- exactly `MAX_FILTERS` of
   *  them, and none overlapping the bespoke names a test may add on top. */
  function everyFacet(): Record<string, unknown> {
    const args: Record<string, unknown> = { include_unknown: true, limit: 10 };
    for (const facet of FACETS) args[facet.queryParam] = facetSetValue(facet);
    return args;
  }

  function payload(outcome: Awaited<ReturnType<typeof searchDatasetsTool>>): string {
    return (outcome.result.content as { text: string }[])[0].text;
  }

  test("exactly the cap runs, and the query it runs is really filtered", async () => {
    const args = everyFacet();
    expect(
      activeFilterNames(buildFilterOptions(args as SearchDatasetsInput, undefined)).length,
    ).toBe(0);
    const outcome = await searchDatasetsTool(env, args as SearchDatasetsInput);
    expect(outcome.result.isError).toBeUndefined();
    const wide = JSON.parse(payload(outcome)) as {
      count: number;
      results: { dataset_id: string }[];
    };
    expect(wide.results.map((r) => r.dataset_id).sort()).toEqual(["nm000001", "nm000002"]);

    // Same twenty filters, one of them narrowed: the row with 400 subjects
    // must drop out. Proves the clauses reached D1 and bound their values,
    // which a count alone cannot.
    const narrowed = await searchDatasetsTool(env, {
      ...args,
      subjects: "0..100",
    } as SearchDatasetsInput);
    expect(narrowed.result.isError).toBeUndefined();
    const hits = JSON.parse(payload(narrowed)) as {
      count: number;
      results: { dataset_id: string }[];
    };
    expect(hits.results.map((r) => r.dataset_id)).toEqual(["nm000001"]);
    expect(hits.count).toBe(1);
  });

  test("one over the cap is refused, and the answer names exactly what to drop", async () => {
    // Composed from every bespoke filter plus enough facets to go one over, so
    // the list carries both `has_zarr` and `has_zarr_verified`. That pair is
    // the reason the check below parses the list instead of matching
    // substrings: one is a prefix of the other.
    const args: Record<string, unknown> = { include_unknown: true, limit: 10 };
    for (const [name, { set }] of Object.entries(BESPOKE)) args[name] = set;
    for (const facet of FACETS.slice(
      0,
      SEARCH_DATASETS_MAX_FILTERS + 1 - Object.keys(BESPOKE).length,
    )) {
      args[facet.queryParam] = facetSetValue(facet);
    }
    const expected = activeFilterNames(
      buildFilterOptions(
        args as SearchDatasetsInput,
        parseFacetFilters((k) => args[k] as string | undefined),
      ),
    );
    expect(expected.length).toBe(SEARCH_DATASETS_MAX_FILTERS + 1);

    const outcome = await searchDatasetsTool(env, args as SearchDatasetsInput);
    expect(outcome.result.isError).toBe(true);
    const text = payload(outcome);
    expect(text).toContain(`Too many filters in one call: ${SEARCH_DATASETS_MAX_FILTERS + 1}`);
    expect(text).toContain(`at most ${SEARCH_DATASETS_MAX_FILTERS}`);
    // Parsed, not substring-matched: `has_zarr` is a prefix of
    // `has_zarr_verified`, so a per-name `toContain` cannot tell a complete
    // list from one missing an entry.
    const listed = text.split("Supplied: ")[1]?.replace(/\.$/, "").split(", ");
    expect(listed).toEqual(expected);
  });

  test("a malformed facet value is reported before the cap", async () => {
    // ADR 0051: the specific complaint wins. A caller who sent both an
    // over-wide call and a bad range gets the range back, which is the one
    // they cannot work out from the parameter list.
    const outcome = await searchDatasetsTool(env, {
      ...everyFacet(),
      modality: "eeg",
      subjects: "not-a-range",
    } as SearchDatasetsInput);
    expect(outcome.result.isError).toBe(true);
    expect(payload(outcome)).toContain("not accepted");
    expect(payload(outcome)).not.toContain("Too many filters");
  });

  test("unset and widening parameters do not consume the cap", async () => {
    // A call at the cap stays legal when a caller adds `query`, `limit`,
    // `include_unknown`, a cleared filter, an inert one and an explicit
    // `false` on top of it.
    const outcome = await searchDatasetsTool(env, {
      ...everyFacet(),
      has_doi: false,
      author: "",
      task: undefined,
      license: "CC0-1.0",
    } as SearchDatasetsInput);
    expect(outcome.result.isError).toBeUndefined();
    expect(payload(outcome)).not.toContain("Too many filters");
  });
});
