/**
 * The `modality` filter matches a whole modality token, not a substring (#1711).
 *
 * `datasets.modalities` is a comma-joined list (`eeg,ieeg,meg`), and the filter
 * used to be `LOWER(modalities) LIKE '%<value>%'`. `eeg` is a substring of
 * `ieeg`, so `modality=EEG` returned intracranial-only datasets. Production
 * showed it: a search for `ieeg` with `modality=EEG` returned 97 of 100 rows
 * that held no `eeg` token at all.
 *
 * Every assertion goes through a real entry point -- the registered catalog
 * routes (`GET /datasets`, `GET /datasets/search`), the MCP `search_datasets`
 * tool, and `GET /datasets/facets` -- against a real bun:sqlite database with
 * every migration applied. There is no hand-copied SQL: the one place that
 * decides what a modality token is lives in `dataset-filters.ts`, and all three
 * entry points reach it, so a test that drove only the clause builder could
 * stay green while a caller stopped passing the filter in.
 *
 * The fixture is built so that substring and token matching DISAGREE on almost
 * every row. A fixture of lowercase single-token rows cannot tell them apart:
 * `eeg` and `ieeg` are the only collision in it, and a `meg` or `emg` query
 * agrees under both.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SearchDatasetsInput } from "../../shared/contract/mcp";
import { MAX_MODALITY_FILTER_TOKENS } from "../../shared/modality-filter";
import { searchDatasetsTool } from "../src/mcp/tools/search-datasets";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import { buildDatasetFilterClauses } from "../src/services/dataset-filters";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(db: Database): Bindings {
  // No AI/VECTORIZE bound: GET /datasets/search takes its text (FTS) tier, which
  // is the tier that carries the filter clauses in the production failure.
  return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
}

function newApp(): App {
  const app: App = new Hono();
  registerCatalogRoutes(app);
  return app;
}

function insertDataset(
  db: Database,
  datasetId: string,
  cols: Record<string, string | number | null> = {},
): void {
  const merged: Record<string, string | number | null> = {
    owner_user_id: -1,
    name: `Fixture ${datasetId}`,
    visibility: "public",
    status: "active",
    is_sandbox: 0,
    ...cols,
  };
  const keys = Object.keys(merged);
  db.query(
    `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys
      .map(() => "?")
      .join(", ")})`,
  ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
}

/**
 * One row per way a modality list can be written. The comment on each row says
 * which token set it carries, because the expectations below are derived from
 * that and nothing else.
 */
const ROWS = {
  eegOnly: { id: "nm500001", modalities: "eeg" },
  ieegOnly: { id: "nm500002", modalities: "ieeg" },
  eegAndIeeg: { id: "nm500003", modalities: "eeg,ieeg" },
  megOnly: { id: "nm500004", modalities: "meg" },
  // Legacy capitalisation: the column is lowercase when written by the current
  // code (BIDS datatype directory names), but the filter has always been
  // case-insensitive and must stay so.
  upperEeg: { id: "nm500005", modalities: "EEG" },
  upperIeeg: { id: "nm500006", modalities: "iEEG" },
  // A space after the comma, the shape an older writer or a hand edit leaves.
  spacedList: { id: "nm500007", modalities: "beh, EEG" },
  // `ieeg` in the MIDDLE of a list, and no `eeg` token at all.
  middleIeeg: { id: "nm500008", modalities: "anat,ieeg,meg" },
  // `eeg` as a PREFIX of a different token: the other direction a substring
  // match leaks, which a suffix-only (`ieeg`) fixture never exercises.
  eegPrefix: { id: "nm500009", modalities: "eegx" },
  emgOnly: { id: "nm500010", modalities: "emg" },
  nullModalities: { id: "nm500011", modalities: null },
  emptyModalities: { id: "nm500012", modalities: "" },
  // Padded storage: the whole value wrapped in spaces. Only a per-token trim
  // finds `eeg` in it; replacing just ", " with "," does not.
  paddedEeg: { id: "nm500013", modalities: " eeg " },
  // Whitespace INSIDE a token is part of the token: this row holds the one
  // token `e eg`, which is not `eeg`. The vocabulary tallies it that way too.
  innerSpace: { id: "nm500014", modalities: "e eg" },
  // Tab and CR+LF padding around a token, the other whitespace a pasted or
  // hand-edited list carries. The clause trims them, and so does the
  // vocabulary's JS `trim`, so both must agree on these too.
  tabPadded: { id: "nm500015", modalities: "beh,\teeg\t" },
  crlfPadded: { id: "nm500016", modalities: "beh,\r\neeg\r\n" },
} as const;

/** The rows that hold an `eeg` token, in any case or padding. */
const EEG_ROWS = [
  ROWS.eegOnly,
  ROWS.eegAndIeeg,
  ROWS.upperEeg,
  ROWS.spacedList,
  ROWS.paddedEeg,
  ROWS.tabPadded,
  ROWS.crlfPadded,
];

const ALL_IDS = Object.values(ROWS).map((r) => r.id);

function ids(...rows: (typeof ROWS)[keyof typeof ROWS][]): string[] {
  return rows.map((r) => r.id).sort();
}

function seed(db: Database): void {
  for (const row of Object.values(ROWS)) {
    insertDataset(db, row.id, { modalities: row.modalities });
  }
}

async function listIds(app: App, db: Database, qs: string): Promise<string[]> {
  const res = await app.request(`/?${qs}`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { datasets: { dataset_id: string }[] };
  return body.datasets.map((d) => d.dataset_id).sort();
}

async function listTotal(app: App, db: Database, qs: string): Promise<number> {
  const res = await app.request(`/?${qs}`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { total_count: number };
  return body.total_count;
}

async function searchIds(app: App, db: Database, qs: string): Promise<string[]> {
  const res = await app.request(`/search?${qs}`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: { id: string }[] };
  return body.results.map((r) => r.id).sort();
}

/**
 * `count` DISTINCT modality tokens, the first being `eeg` so a request that is
 * accepted still has rows to return. The rest are `m01`, `m02`, ... which no
 * fixture row holds, so they widen the list without changing the answer.
 */
function distinctTokens(count: number): string[] {
  return [
    "eeg",
    ...Array.from({ length: count - 1 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`),
  ];
}

describe("GET /datasets: modality is a whole-token match", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    seed(db);
  });

  test("control: no modality filter returns every row, so the fixture is all visible", async () => {
    // Without this, an expectation below that a row is ABSENT could be satisfied
    // by the row never being listable at all.
    expect(await listIds(app, db, "")).toEqual([...ALL_IDS].sort());
  });

  test("modality=EEG returns datasets with an eeg token and not iEEG-only ones (#1711 browse)", async () => {
    expect(await listIds(app, db, "modality=EEG")).toEqual(ids(...EEG_ROWS));
  });

  test("the same answer in any case", async () => {
    const expected = ids(...EEG_ROWS);
    for (const value of ["eeg", "EEG", "Eeg", "eEg"]) {
      expect({ value, ids: await listIds(app, db, `modality=${value}`) }).toEqual({
        value,
        ids: expected,
      });
    }
  });

  test("modality=iEEG returns the datasets that hold an ieeg token", async () => {
    expect(await listIds(app, db, "modality=iEEG")).toEqual(
      ids(ROWS.ieegOnly, ROWS.eegAndIeeg, ROWS.upperIeeg, ROWS.middleIeeg),
    );
  });

  test("a token in the middle of a list matches, and so does the last one", async () => {
    expect(await listIds(app, db, "modality=meg")).toEqual(ids(ROWS.megOnly, ROWS.middleIeeg));
    expect(await listIds(app, db, "modality=beh")).toEqual(
      ids(ROWS.spacedList, ROWS.tabPadded, ROWS.crlfPadded),
    );
  });

  test("a prefix or a suffix of a token is not that token", async () => {
    expect(await listIds(app, db, "modality=ee")).toEqual([]);
    expect(await listIds(app, db, "modality=eegx")).toEqual(ids(ROWS.eegPrefix));
    expect(await listIds(app, db, "modality=ieeg")).not.toContain(ROWS.eegOnly.id);
    expect(await listIds(app, db, "modality=eeg")).not.toContain(ROWS.eegPrefix.id);
  });

  test("a comma list matches a dataset holding ANY of its tokens", async () => {
    expect(await listIds(app, db, "modality=eeg,meg")).toEqual(
      ids(...EEG_ROWS, ROWS.megOnly, ROWS.middleIeeg),
    );
  });

  test("a comma list tolerates spaces and repeats", async () => {
    const plain = await listIds(app, db, "modality=eeg,meg");
    expect(await listIds(app, db, "modality=%20eeg%20,%20MEG%20,eeg")).toEqual(plain);
  });

  test("rows with no modality at all match no modality filter", async () => {
    for (const value of ["eeg", "ieeg", "meg", "emg", "beh", "eeg,meg"]) {
      const listed = await listIds(app, db, `modality=${value}`);
      expect({ value, null: listed.includes(ROWS.nullModalities.id) }).toEqual({
        value,
        null: false,
      });
      expect({ value, empty: listed.includes(ROWS.emptyModalities.id) }).toEqual({
        value,
        empty: false,
      });
    }
  });

  test("LIKE wildcards in the value are literal characters, not patterns", async () => {
    // The old clause bound `%<value>%` unescaped, so `%` matched EVERY row (NULL
    // and empty ones included, through the COALESCE) and `_eg` matched meg, eeg
    // and emg. Both are the dangerous direction: they widen instead of narrow.
    expect(await listIds(app, db, "modality=%25")).toEqual([]);
    expect(await listIds(app, db, "modality=_eg")).toEqual([]);
    expect(await listIds(app, db, "modality=e%25")).toEqual([]);
    expect(await listIds(app, db, "modality=e_g")).toEqual([]);
  });

  test("a value that names no modality matches nothing; it does not fall back to everything", async () => {
    // Whitespace and bare commas are supplied-but-inert. The filter was asked
    // for, so the answer is the empty list, never the unfiltered catalog.
    for (const value of ["%20", "%20%20", ",", "%20,%20", ",,"]) {
      expect({ value, ids: await listIds(app, db, `modality=${value}`) }).toEqual({
        value,
        ids: [],
      });
    }
    // An EMPTY value is not a supplied filter, and stays unfiltered.
    expect(await listIds(app, db, "modality=")).toEqual([...ALL_IDS].sort());
  });

  test("total_count counts the same rows the page lists", async () => {
    // The browse failure was visible in the first page of a paged list; the
    // count has to follow the rows rather than the old substring.
    const total = await listTotal(app, db, "modality=EEG&limit=1");
    expect(total).toBe(EEG_ROWS.length);
    expect(await listTotal(app, db, "modality=iEEG&limit=1")).toBe(4);
    expect(await listTotal(app, db, "modality=eeg,meg&limit=1")).toBe(EEG_ROWS.length + 2);
  });

  test("a trailing or leading comma leaves the one token", async () => {
    const expected = ids(...EEG_ROWS);
    expect(await listIds(app, db, "modality=eeg,")).toEqual(expected);
    expect(await listIds(app, db, "modality=,eeg")).toEqual(expected);
    expect(await listIds(app, db, "modality=,,eeg,,")).toEqual(expected);
  });

  test("padded storage still holds the token", async () => {
    // ` eeg ` has no comma to anchor on, so only trimming each token finds it.
    expect(await listIds(app, db, "modality=eeg")).toContain(ROWS.paddedEeg.id);
    expect(await listIds(app, db, "modality=eeg")).toHaveLength(EEG_ROWS.length);
  });

  test("tab and CR+LF padding is trimmed like a space", async () => {
    const listed = await listIds(app, db, "modality=eeg");
    expect(listed).toContain(ROWS.tabPadded.id);
    expect(listed).toContain(ROWS.crlfPadded.id);
    // The padding is not left inside the token: `beh` is found in both too.
    const beh = await listIds(app, db, "modality=beh");
    expect(beh).toContain(ROWS.tabPadded.id);
    expect(beh).toContain(ROWS.crlfPadded.id);
  });

  test("whitespace inside a token is part of it, never a separator", async () => {
    // Stored side: `e eg` is the one token `e eg`, not `eeg`.
    expect(await listIds(app, db, "modality=eeg")).not.toContain(ROWS.innerSpace.id);
    // Wanted side: a space is not a list separator, so `eeg meg` is a single
    // token that no row holds, rather than the two tokens `eeg` and `meg`.
    expect(await listIds(app, db, "modality=eeg%20meg")).toEqual([]);
    expect(await listIds(app, db, "modality=eeg;meg")).toEqual([]);
    // ... and inner whitespace is not stripped to make `e eg` into `eeg`. The
    // token `e eg` exists, so it finds exactly the row that holds it.
    expect(await listIds(app, db, "modality=e%20eg")).toEqual(ids(ROWS.innerSpace));
    // Spaces AROUND a comma are padding, not part of either token.
    expect(await listIds(app, db, "modality=eeg%20,%20meg")).toEqual(
      await listIds(app, db, "modality=eeg,meg"),
    );
  });

  test("a value naming more distinct modalities than the limit is refused, not truncated", async () => {
    expect(MAX_MODALITY_FILTER_TOKENS).toBe(32); // the number the docs state
    const atLimit = distinctTokens(MAX_MODALITY_FILTER_TOKENS).join(",");
    expect(await listIds(app, db, `modality=${atLimit}`)).toEqual(ids(...EEG_ROWS));

    const overLimit = distinctTokens(MAX_MODALITY_FILTER_TOKENS + 1).join(",");
    const res = await app.request(`/?modality=${overLimit}`, {}, env(db));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(String(MAX_MODALITY_FILTER_TOKENS + 1));
    expect(body.error).toContain(String(MAX_MODALITY_FILTER_TOKENS));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // A refusal names the count and the limit and does not echo the value.
    expect(body.error).not.toContain("m01");
  });

  test("the limit counts DISTINCT tokens after normalising, so repeats are free", async () => {
    // 40 copies of one token, in three spellings.
    const repeats = Array.from({ length: 40 }, (_, i) => ["eeg", "EEG", " eeg "][i % 3]).join(",");
    expect(await listIds(app, db, `modality=${repeats}`)).toEqual(ids(...EEG_ROWS));
    // The limit's worth of distinct tokens PLUS case and padding variants of
    // them: more than the limit by entry count, exactly the limit by distinct
    // count.
    const variants = [...distinctTokens(MAX_MODALITY_FILTER_TOKENS), "EEG", " M01 ", "m02"].join(
      ",",
    );
    expect(await listIds(app, db, `modality=${variants}`)).toEqual(ids(...EEG_ROWS));
    // Empty entries are not tokens either.
    const gappy = `${distinctTokens(MAX_MODALITY_FILTER_TOKENS).join(",,")},,,`;
    expect(await listIds(app, db, `modality=${gappy}`)).toEqual(ids(...EEG_ROWS));
  });

  test("modality combines with another filter instead of replacing it", async () => {
    db.query("UPDATE datasets SET has_hed = 1 WHERE dataset_id IN (?, ?)").run(
      ROWS.eegOnly.id,
      ROWS.ieegOnly.id,
    );
    expect(await listIds(app, db, "modality=eeg&has_hed=1")).toEqual(ids(ROWS.eegOnly));
    expect(await listIds(app, db, "modality=ieeg&has_hed=1")).toEqual(ids(ROWS.ieegOnly));
  });
});

describe("GET /datasets?mine=true: modality is a whole-token match", () => {
  // The signed-in branch builds its own query and calls the clause builder on
  // its own; a regression there (dropping `filters`, or passing none) leaves
  // every public-route test green, and `?mine` is the branch a depositor hits.
  const API_KEY = "modality-mine-key-0123456789abcdef0123456789";
  let db: Database;
  let app: App;

  beforeEach(async () => {
    db = freshDb();
    app = newApp();
    seed(db);
    db.run(
      "INSERT INTO users (id, username, email, password_hash, status, role, email_verified) VALUES (9, 'mineuser', 'mine@example.org', 'x', 'approved', 'member', 1)",
    );
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (9, ?, ?)").run(
      await hashApiKey(API_KEY),
      API_KEY.slice(0, 8),
    );
    // The caller owns every fixture row except the iEEG-only one, which is
    // someone else's: it must be absent for ownership, not for the filter.
    db.query("UPDATE datasets SET owner_user_id = 9 WHERE dataset_id != ?").run(ROWS.ieegOnly.id);
  });

  async function mineIds(qs: string): Promise<string[]> {
    const res = await app.request(
      `/?mine=true&${qs}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: { dataset_id: string }[] };
    return body.datasets.map((d) => d.dataset_id).sort();
  }

  test("control: the caller's own list is every row they own", async () => {
    expect(await mineIds("")).toEqual(ALL_IDS.filter((id) => id !== ROWS.ieegOnly.id).sort());
  });

  test("modality=EEG returns the caller's rows holding an eeg token", async () => {
    expect(await mineIds("modality=EEG")).toEqual(ids(...EEG_ROWS));
  });

  test("modality=iEEG returns the caller's ieeg rows and not another owner's", async () => {
    expect(await mineIds("modality=iEEG")).toEqual(
      ids(ROWS.eegAndIeeg, ROWS.upperIeeg, ROWS.middleIeeg),
    );
  });

  test("a value over the token limit is a 400 here too", async () => {
    const overLimit = distinctTokens(MAX_MODALITY_FILTER_TOKENS + 1).join(",");
    const res = await app.request(
      `/?mine=true&modality=${overLimit}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /datasets/search: modality is a whole-token match", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    seed(db);
  });

  test("control: the text tier finds every row that carries an ieeg token", async () => {
    // The query is the one from the production report. Without this, the
    // narrowing assertions below could pass because the search found nothing.
    expect(await searchIds(app, db, "q=ieeg")).toEqual(
      ids(ROWS.ieegOnly, ROWS.eegAndIeeg, ROWS.upperIeeg, ROWS.middleIeeg),
    );
  });

  test("q=ieeg with modality=EEG returns only datasets that also hold an eeg token (#1711 search)", async () => {
    // Production returned 97 of 100 rows with no exact EEG token for this call.
    expect(await searchIds(app, db, "q=ieeg&modality=EEG")).toEqual(ids(ROWS.eegAndIeeg));
  });

  test("q=ieeg with modality=iEEG keeps every row the query found", async () => {
    expect(await searchIds(app, db, "q=ieeg&modality=iEEG")).toEqual(
      ids(ROWS.ieegOnly, ROWS.eegAndIeeg, ROWS.upperIeeg, ROWS.middleIeeg),
    );
  });

  test("q=eeg with modality=eeg does not let an eeg-prefixed token through", async () => {
    // `eeg*` is a prefix match in the FTS tier, so `eegx` is a text hit that only
    // the modality filter can remove.
    expect(await searchIds(app, db, "q=eeg&modality=eeg")).toEqual(ids(...EEG_ROWS));
  });

  test("a comma list is OR here too", async () => {
    expect(await searchIds(app, db, "q=ieeg&modality=eeg,meg")).toEqual(
      ids(ROWS.eegAndIeeg, ROWS.middleIeeg),
    );
  });

  test("the token limit applies here too: the limit is accepted, one more is a 400", async () => {
    const atLimit = distinctTokens(MAX_MODALITY_FILTER_TOKENS).join(",");
    expect(await searchIds(app, db, `q=eeg&modality=${atLimit}`)).toEqual(ids(...EEG_ROWS));
    const overLimit = distinctTokens(MAX_MODALITY_FILTER_TOKENS + 1).join(",");
    const res = await app.request(`/search?q=eeg&modality=${overLimit}`, {}, env(db));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(String(MAX_MODALITY_FILTER_TOKENS + 1));
    // Repeats are not distinct tokens.
    const repeats = Array.from({ length: 40 }, () => "eeg").join(",");
    expect(await searchIds(app, db, `q=eeg&modality=${repeats}`)).toEqual(ids(...EEG_ROWS));
  });

  test("every 400 from /search is no-store, so a shared cache never keeps a refusal", async () => {
    // The handler used to send no Cache-Control at all, while the same refusals
    // on GET /datasets were no-store. Covers each early return: the new
    // over-limit modality list, an existing bad-range filter, and a missing q.
    const overLimit = distinctTokens(MAX_MODALITY_FILTER_TOKENS + 1).join(",");
    for (const qs of [`q=eeg&modality=${overLimit}`, "q=eeg&subjects=not-a-range", ""]) {
      const res = await app.request(`/search?${qs}`, {}, env(db));
      expect({ qs: qs.slice(0, 40), status: res.status }).toEqual({
        qs: qs.slice(0, 40),
        status: 400,
      });
      expect({ qs: qs.slice(0, 40), cc: res.headers.get("Cache-Control") }).toEqual({
        qs: qs.slice(0, 40),
        cc: "no-store",
      });
    }
    // The success response carries the same safe default; nothing on this
    // handler is shareable.
    const ok = await app.request("/search?q=eeg&modality=eeg", {}, env(db));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
  });

  test("the reported count follows the filtered rows", async () => {
    const res = await app.request("/search?q=ieeg&modality=EEG", {}, env(db));
    const body = (await res.json()) as { count: number; results: unknown[] };
    expect(body.count).toBe(1);
    expect(body.results).toHaveLength(1);
  });

  test("an exact-id hit is held to the same token rule", async () => {
    // The exact-id tier short-circuits the text tier, so it is a second place a
    // filter could be applied loosely. nm500002 is ieeg-only.
    const res = await app.request(`/search?q=${ROWS.ieegOnly.id}&modality=EEG`, {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { method: string; results: { id: string }[] };
    expect(body.results.map((r) => r.id)).not.toContain(ROWS.ieegOnly.id);
    const kept = await app.request(`/search?q=${ROWS.ieegOnly.id}&modality=ieeg`, {}, env(db));
    const keptBody = (await kept.json()) as { method: string; results: { id: string }[] };
    expect(keptBody.method).toBe("exact_id");
    expect(keptBody.results.map((r) => r.id)).toEqual([ROWS.ieegOnly.id]);
  });
});

describe("MCP search_datasets: modality is a whole-token match", () => {
  let db: Database;
  let toolEnv: Pick<Bindings, "DB" | "AI" | "VECTORIZE">;

  beforeEach(() => {
    db = freshDb();
    seed(db);
    toolEnv = { DB: realD1(db), AI: {} as never, VECTORIZE: {} as never };
  });

  async function call(args: SearchDatasetsInput): Promise<string[]> {
    const outcome = await searchDatasetsTool(toolEnv, args);
    expect(outcome.result.isError).toBeUndefined();
    const text = (outcome.result.content as { text: string }[])[0].text;
    const parsed = JSON.parse(text) as { results: { dataset_id: string }[] };
    return parsed.results.map((r) => r.dataset_id).sort();
  }

  test("browsing with modality eeg returns no iEEG-only dataset", async () => {
    expect(await call({ modality: "EEG", limit: 100 })).toEqual(ids(...EEG_ROWS));
  });

  test("a query narrowed by modality honours the same rule", async () => {
    expect(await call({ query: "ieeg", modality: "EEG", limit: 100 })).toEqual(
      ids(ROWS.eegAndIeeg),
    );
  });

  test("a comma list is OR", async () => {
    expect(await call({ modality: "ieeg,meg", limit: 100 })).toEqual(
      ids(ROWS.ieegOnly, ROWS.eegAndIeeg, ROWS.upperIeeg, ROWS.middleIeeg, ROWS.megOnly),
    );
  });

  test("the token limit: the limit is accepted, one more is refused by name", async () => {
    const atLimit = distinctTokens(MAX_MODALITY_FILTER_TOKENS).join(",");
    expect(await call({ modality: atLimit, limit: 100 })).toEqual(ids(...EEG_ROWS));

    const overLimit = distinctTokens(MAX_MODALITY_FILTER_TOKENS + 1).join(",");
    const outcome = await searchDatasetsTool(toolEnv, { modality: overLimit, limit: 100 });
    expect(outcome.result.isError).toBe(true);
    const text = (outcome.result.content as { text: string }[])[0].text;
    expect(text).toContain(String(MAX_MODALITY_FILTER_TOKENS + 1));
    expect(text).toContain(String(MAX_MODALITY_FILTER_TOKENS));
    // Repeats are not distinct tokens.
    const repeats = Array.from({ length: 40 }, () => "EEG").join(",");
    expect(await call({ modality: repeats, limit: 100 })).toEqual(ids(...EEG_ROWS));
  });
});

describe("an empty wanted token cannot match every row", () => {
  // `parseTokenList` drops empty tokens, so no request reaches the clause with
  // one. The clause must not DEPEND on that: its seed token is NULL, which
  // equals nothing, so an empty wanted token matches only a row that holds an
  // empty token. Injected through the bound parameter of the real clause, which
  // is what a tokenizer that stopped dropping empties would bind.
  test("[''] matches only the row that really holds an empty token", () => {
    const db = freshDb();
    seed(db);
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { modality: "eeg" });
    expect(params).toEqual(['["eeg"]']);
    params[0] = JSON.stringify([""]);
    const rows = db
      .query(`SELECT d.dataset_id AS id FROM datasets d WHERE 1 = 1${clauses}`)
      .all(...(params as never[])) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([ROWS.emptyModalities.id]);
    db.close();
  });
});

describe("the modality vocabulary and the modality filter agree", () => {
  // `GET /datasets/facets` tells a client which values exist and how many
  // datasets carry each; the client then passes one back as `modality=`. The
  // two were written separately (the vocabulary tallies tokens in JS, the filter
  // used to be a substring in SQL) and disagreed for `eeg`: the vocabulary said
  // 4, the filter returned 8. Each is tested against the other because either
  // can be changed alone.
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    seed(db);
  });

  test("every advertised value filters to exactly its advertised count", async () => {
    const res = await app.request("/facets", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modality?: { value: string; count: number }[] };
    const vocabulary = body.modality ?? [];
    // Not vacuous: the fixture has these distinct tokens.
    expect(vocabulary.map((e) => e.value).sort()).toEqual(
      ["anat", "beh", "e eg", "eeg", "eegx", "emg", "ieeg", "meg"].sort(),
    );
    for (const { value, count } of vocabulary) {
      expect({ value, total: await listTotal(app, db, `modality=${value}&limit=1`) }).toEqual({
        value,
        total: count,
      });
    }
  });
});
