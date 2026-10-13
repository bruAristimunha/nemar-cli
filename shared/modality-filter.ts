/**
 * The `modality` filter's contract in words and in numbers (#1711), declared
 * once so the backend that enforces it and the three places that describe it
 * (the CLI help, the OpenAPI document, the MCP tool schema) cannot disagree.
 *
 * The matching itself is SQL and lives in
 * `backend/src/services/dataset-filters.ts`; ADR 0032 (amendment 2026-10-12)
 * records why it is a whole-token match.
 *
 * Zero dependencies, so `src/`, `scripts/` and `backend/` all import it.
 */

/**
 * The most distinct modality tokens one request may name. A request with more
 * is REFUSED, not truncated: a filter that quietly dropped its tail would
 * return a confident-looking list for a question nobody asked.
 *
 * Why a number at all: an input contract, NOT a cost guard. The clause's cost
 * is flat in the number of wanted tokens (the wanted set is probed through an
 * index; on bun:sqlite over 1,000 synthetic rows, about 1.3 ms for 1 to 100
 * distinct tokens and 3.4 ms for 8,000, D1 not measured), so the limit does not
 * protect the database. It keeps a request, which is an anonymous caller's URL,
 * small and predictable, and gives clients one documented bound. BIDS defines 14
 * datatypes and the production vocabulary holds 12, so 32 is wider than any real
 * request. Raising it means changing this constant and regenerating
 * `shared/openapi.json`.
 */
export const MAX_MODALITY_FILTER_TOKENS = 32;

/** What the filter does, in one sentence, for the OpenAPI document and the MCP
 *  tool schema. */
export const MODALITY_FILTER_DESCRIPTION = [
  "Filter by modality: a whole-token, case-insensitive match against the dataset's modality",
  "list, so `eeg` does not match `ieeg`. A comma-separated list matches a dataset holding any",
  `of its modalities, at most ${MAX_MODALITY_FILTER_TOKENS} distinct values; more is refused.`,
].join(" ");

/** The `--modality` option's help text on the CLI's `list` and `search`. */
export const MODALITY_FILTER_CLI_HELP = [
  "Filter by modality (eeg, emg, meg, etc.), matched as a whole token;",
  `a comma list matches any of up to ${MAX_MODALITY_FILTER_TOKENS}`,
].join(" ");
