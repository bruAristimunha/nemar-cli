/**
 * Unit tests for the dataset list endpoint's search WHERE-clause builder.
 *
 * Deterministic (no DB): verifies which columns the search pattern is matched
 * against on the single-table `datasets` read (#646). The contract: dataset_id
 * (and source_id for openneuro mirrors) MUST appear in the LIKE clause, and
 * free-text routes through the FTS5 index, regardless of any precomputed state.
 */

import { describe, expect, test } from "bun:test";
import {
  buildDatasetFilterClauses,
  escapeLikePattern,
} from "../backend/src/routes/datasets/catalog";
import {
  MODALITY_TOKENS_SQL,
  ModalityTokenLimitError,
  PUBLISHED_AT_SQL,
  parseModalityFilter,
  parseTokenList,
} from "../backend/src/services/dataset-filters";
import { MAX_MODALITY_FILTER_TOKENS } from "../shared/modality-filter";

describe("buildDatasetFilterClauses search clause", () => {
  test("search includes dataset_id + source_id LIKE and routes free-text through FTS5", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { search: "nm000166" });
    expect(clauses).toContain("LOWER(d.dataset_id) LIKE ? ESCAPE '\\'");
    expect(clauses).toContain("LOWER(COALESCE(d.source_id, '')) LIKE ? ESCAPE '\\'");
    expect(clauses).toContain(
      "d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?)",
    );
    // pattern (dataset_id), pattern (source_id), FTS match expression
    expect(params).toEqual(["%nm000166%", "%nm000166%", '"nm000166"*']);
  });

  test("punctuation-only search (no FTS tokens) falls back to id/name/description LIKE", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { search: "!!" });
    expect(clauses).toContain("LOWER(d.name) LIKE ? ESCAPE '\\'");
    expect(clauses).toContain("LOWER(COALESCE(d.description, '')) LIKE ? ESCAPE '\\'");
    expect(clauses).not.toContain("datasets_fts");
    expect(params).toEqual(["%!!%", "%!!%", "%!!%", "%!!%"]);
  });

  test("modality/author/task/hasDoi/recent filter on d.* columns", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, {
      modality: "EEG",
      author: "Ada",
      task: "rest",
      hasDoi: true,
      recent: 30,
    });
    // #1711: modality is a whole-token match over the shared token expression,
    // not a LIKE, and its wanted tokens travel as one JSON-array parameter.
    expect(clauses).toContain(MODALITY_TOKENS_SQL);
    expect(clauses).not.toContain("LOWER(COALESCE(d.modalities, '')) LIKE");
    expect(clauses).toContain("LOWER(COALESCE(d.authors, '')) LIKE ?");
    expect(clauses).toContain("LOWER(COALESCE(d.tasks, '')) LIKE ?");
    expect(clauses).toContain("d.concept_doi IS NOT NULL");
    // #1477: recent= reads the shared publication date, not a hand-copied SQL.
    expect(clauses).toContain(`${PUBLISHED_AT_SQL} > datetime('now', ?)`);
    expect(params).toEqual(['["eeg"]', "%ada%", "%rest%", "-30 days"]);
  });

  test("hasHed adds `d.has_hed = 1` with no bind param (#869)", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { hasHed: true });
    expect(clauses).toContain("d.has_hed = 1");
    expect(params).toEqual([]); // literal clause, no placeholder
  });

  test("hasHed coexists with a modality filter without consuming its param", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { modality: "EEG", hasHed: true });
    expect(clauses).toContain(MODALITY_TOKENS_SQL);
    expect(clauses).toContain("d.has_hed = 1");
    expect(params).toEqual(['["eeg"]']); // only modality pushed a param
  });

  test("no filters returns empty clauses (nothing pushed)", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, {});
    expect(clauses).toBe("");
    expect(params).toEqual([]);
  });
});

describe("parseTokenList (#1711)", () => {
  test("trims, lower-cases and de-duplicates, keeping first-seen order", () => {
    expect(parseTokenList("EEG, meg,eeg")).toEqual(["eeg", "meg"]);
  });

  test("a single value is a one-token list", () => {
    expect(parseTokenList("iEEG")).toEqual(["ieeg"]);
  });

  test("a value with no token in it is the empty list, not a token of its own", () => {
    expect(parseTokenList(" ")).toEqual([]);
    expect(parseTokenList(",")).toEqual([]);
    expect(parseTokenList(" , ,, ")).toEqual([]);
  });

  test("a modality filter that names no token still binds, as an empty list", () => {
    // Bound as `[]`, so the clause exists and matches nothing; the filter was
    // asked for, so it must not vanish into an unfiltered list.
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { modality: " , " });
    expect(clauses).toContain(MODALITY_TOKENS_SQL);
    expect(params).toEqual(["[]"]);
  });
});

describe("parseModalityFilter and the clause builder's backstop (#1711)", () => {
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join(",");

  test("the limit is accepted and the next distinct token is refused with both numbers", () => {
    expect(parseModalityFilter(tokens(MAX_MODALITY_FILTER_TOKENS))).toHaveLength(
      MAX_MODALITY_FILTER_TOKENS,
    );
    try {
      parseModalityFilter(tokens(MAX_MODALITY_FILTER_TOKENS + 1));
      throw new Error("expected a ModalityTokenLimitError");
    } catch (err) {
      expect(err).toBeInstanceOf(ModalityTokenLimitError);
      const refusal = err as ModalityTokenLimitError;
      expect(refusal.distinct).toBe(MAX_MODALITY_FILTER_TOKENS + 1);
      expect(refusal.limit).toBe(MAX_MODALITY_FILTER_TOKENS);
    }
  });

  test("repeats and empty entries are not counted", () => {
    expect(parseModalityFilter("eeg,EEG, eeg ,,".repeat(20))).toEqual(["eeg"]);
  });

  test("a caller that skips the parse still cannot reach the clause with an over-long list", () => {
    const params: (string | number)[] = [];
    expect(() =>
      buildDatasetFilterClauses(params, { modality: tokens(MAX_MODALITY_FILTER_TOKENS + 1) }),
    ).toThrow(ModalityTokenLimitError);
    expect(params).toEqual([]);
    const ok: (string | number)[] = [];
    buildDatasetFilterClauses(ok, { modality: tokens(MAX_MODALITY_FILTER_TOKENS) });
    expect(ok).toHaveLength(1);
  });
});

describe("escapeLikePattern", () => {
  test("escapes % so a literal-percent search doesn't match every row", () => {
    expect(escapeLikePattern("%")).toBe("\\%");
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("a%b%c")).toBe("a\\%b\\%c");
  });

  test("escapes _ so a literal-underscore search doesn't match any single char", () => {
    expect(escapeLikePattern("foo_bar")).toBe("foo\\_bar");
  });

  test("escapes backslash so the escape-char itself can be matched literally", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  test("leaves ordinary input untouched", () => {
    expect(escapeLikePattern("nm000166")).toBe("nm000166");
    expect(escapeLikePattern("ds002718.v1.0.0")).toBe("ds002718.v1.0.0");
  });
});
