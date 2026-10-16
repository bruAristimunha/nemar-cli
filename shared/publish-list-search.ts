/**
 * The search text of `GET /admin/publish/requests`, and the one limit it has to
 * respect, shared so the CLI can refuse what the server would.
 *
 * The route matches the text as a literal substring with
 * `LIKE '%<text>%' ESCAPE '\'`. D1 (SQLite on workerd) refuses a LIKE pattern
 * longer than 50 BYTES with "LIKE or GLOB pattern too complex: SQLITE_ERROR",
 * and `bun:sqlite`, which the backend tests run on, does not, so a search that
 * passes every local test can still be a 500 in production. The pattern is the
 * text with `\`, `%` and `_` escaped (two bytes each) between two `%`, and the
 * engine counts UTF-8 bytes rather than characters, so the length of the text
 * says little: 48 plain characters fit, 24 underscores fit, 16 kanji fit.
 *
 * Measured against the real engine with
 * `wrangler d1 execute nemar-db -c wrangler-sccn.toml --local`: a 50-byte
 * pattern ran and a 51-byte one failed, for plain letters, for two-byte
 * letters and for escaped underscores alike.
 *
 * Zero dependencies, like `publication-steps.ts`, so either side can import it.
 */

/** The longest LIKE pattern D1 accepts, in UTF-8 bytes. */
export const MAX_LIKE_PATTERN_BYTES = 50;

/** The LIKE pattern for a literal substring match, to be used with `ESCAPE '\'`. */
export function substringLikePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/** The UTF-8 byte length D1 measures for this search text's pattern. */
export function likePatternBytes(text: string): number {
  return new TextEncoder().encode(substringLikePattern(text)).length;
}

/**
 * Why this search text cannot be run, or null when it can. The text is the
 * trimmed one the route uses.
 */
export function searchLimitProblem(text: string): string | null {
  if (likePatternBytes(text) <= MAX_LIKE_PATTERN_BYTES) return null;
  return [
    `search is too long: its match pattern may be at most ${MAX_LIKE_PATTERN_BYTES} bytes,`,
    "which is about 48 plain characters (each of _ % \\ counts twice and a non-ASCII",
    "character counts by its UTF-8 length)",
  ].join(" ");
}

/**
 * SQLite's LIKE and LOWER fold the 26 ASCII letters and nothing else (no ICU on D1 or on
 * `bun:sqlite`), so `É` and `é` are different letters to the route. JavaScript's own
 * `toLowerCase` folds far more, which is why it is not used here.
 */
export function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Whether the route's search condition holds for a row, given the fields it reads (the dataset id,
 * the depositor's username and the dataset's name): `LIKE '%text%' ESCAPE '\'` on any of them. A
 * NULL or missing field never matches, and an empty text is no condition, as in the route.
 *
 * The CLI runs this over a Worker's answer, so that a Worker which did not read `search` (the
 * 0.10.18 route never did) is not shown as if it had. On a Worker that did, every row already
 * satisfies it and nothing is dropped. `test/publish-list-search-parity.unit.test.ts` checks it
 * against the SQL engine itself.
 */
export function matchesListSearch(
  text: string,
  fields: ReadonlyArray<string | null | undefined>,
): boolean {
  if (text === "") return true;
  const needle = foldAsciiCase(text);
  return fields.some((field) => typeof field === "string" && foldAsciiCase(field).includes(needle));
}

/** The route's ordering key for a search: `LOWER(pr.dataset_id) = LOWER(text)`, an exact id first. */
export function isExactIdMatch(datasetId: string, text: string): boolean {
  return foldAsciiCase(datasetId) === foldAsciiCase(text);
}
