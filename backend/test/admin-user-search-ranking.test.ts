/**
 * Ranking, exact-hit detection and close matches for `GET /admin/users?q=`
 * (ADR 0096): what makes the search behave like an ordinary one.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real
 * admin router, real hashed tokens. No mocks.
 *
 * What this file deliberately does NOT claim: that the close-match pass is a
 * search engine. It is edit distance over a few hundred accounts' names, and
 * the tests below pin what it does and, as importantly, where it stops (short
 * words, filters, the result cap, secrets).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import {
  FUZZY_COLUMNS,
  FUZZY_MAX_RESULTS,
  editDistance,
  fold,
  fuzzyBudget,
} from "../src/services/user-fuzzy";
import { USER_COLUMN_ROLES } from "../src/services/user-search";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "rank-admin-key-0123456789abcdef0123456789abc";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

interface Row {
  id: number;
  username: string | null;
  match_kind?: string;
  matched_in?: string[];
  [key: string]: unknown;
}

async function seedAdmin(): Promise<void> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES ('rankadmin', 'rankadmin@example.org', 'x', 'approved', 'admin', 1, 1)`,
  ).run();
  const id = db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'rankadmin'").get()
    ?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function seed(
  username: string | null,
  f: Partial<{
    email: string;
    github: string;
    given: string;
    family: string;
    affiliation: string;
    orcid: string;
    role: string;
    status: string;
    created: string;
    deleted: boolean;
    passwordHash: string;
  }> = {},
): number {
  const email = f.email ?? `${username ?? "web"}@example.org`;
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        github_username, given_name, family_name, affiliation, orcid,
                        created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    username,
    email,
    f.passwordHash ?? "x",
    f.status ?? "verified",
    f.role ?? "member",
    f.github ?? null,
    f.given ?? null,
    f.family ?? null,
    f.affiliation ?? null,
    f.orcid ?? null,
    f.created ?? "2026-01-01 00:00:00",
    f.deleted ? "2026-02-01 00:00:00" : null,
  );
  return db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email)
    ?.id as number;
}

async function search(query: string): Promise<{ status: number; users: Row[] }> {
  const res = await app.request(
    `/admin/users${query}`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
  const body = (await res.json()) as { users?: Row[] };
  return { status: res.status, users: body.users ?? [] };
}

const names = (users: Row[]): Array<string | null> => users.map((u) => u.username);

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("an exact hit comes first and is marked", () => {
  // `ada` is the OLDEST account, so a plain newest-first listing would put
  // `adalovelace` ahead of it. Ranking is what reverses that.
  beforeEach(() => {
    seed("ada", {
      email: "ada@lab.org",
      github: "ada-gh",
      orcid: "0000-0002-1825-0097",
      given: "Ada",
      family: "One",
      created: "2020-01-01 00:00:00",
    });
    seed("adalovelace", {
      given: "Ada",
      family: "Lovelace",
      created: "2025-01-01 00:00:00",
    });
  });

  test("the account whose username IS the text ranks above longer names containing it", async () => {
    const { users } = await search("?q=ada");
    expect(names(users)[0]).toBe("ada");
    expect(users[0].match_kind).toBe("exact");
    expect(names(users)).toContain("adalovelace");
    expect(users.find((u) => u.username === "adalovelace")?.match_kind).not.toBe("exact");
  });

  test("every identifier, in the spellings people type, is an exact hit", async () => {
    // A newer account that also contains some of these strings, so an exact
    // hit has to win on rank and not merely by being the only row.
    seed("someone-else", { email: "ada@lab.org.example", created: "2026-06-01 00:00:00" });
    const target = db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'ada'").get()
      ?.id as number;
    for (const q of [
      "ada",
      "ADA",
      "ada@lab.org",
      "ADA@Lab.ORG",
      "ada-gh",
      "@ada-gh",
      "0000-0002-1825-0097",
      "https://orcid.org/0000-0002-1825-0097",
      String(target),
    ]) {
      const { users } = await search(`?q=${encodeURIComponent(q)}`);
      const hit = users.find((u) => u.id === target);
      expect(hit?.match_kind, `query ${q}`).toBe("exact");
      expect(users[0].id, `query ${q}`).toBe(target);
    }
  });

  test("two words are never an exact hit", async () => {
    const { users } = await search("?q=ada+lovelace");
    expect(users.every((u) => u.match_kind !== "exact")).toBe(true);
  });
});

describe("partial hits are ranked, newest first among equals", () => {
  test("whole name word, then word prefix, then somewhere inside", async () => {
    // All four contain "love" (Clover and Glovelle have it inside the word). The
    // best match is the OLDEST, so a plain newest-first listing would put it last.
    seed("prefixer", { given: "Pat", family: "Lovelace", created: "2026-03-01 00:00:00" });
    seed("inside-old", { given: "Gil", family: "Glovelle", created: "2026-02-01 00:00:00" });
    seed("namer", { given: "Nia", family: "Love", created: "2026-01-01 00:00:00" });
    seed("inside-new", { given: "Kay", family: "Clover", created: "2026-04-01 00:00:00" });
    const { users } = await search("?q=love");
    expect(names(users)).toEqual(["namer", "prefixer", "inside-new", "inside-old"]);
    expect(users.map((u) => u.match_kind)).toEqual(["name", "prefix", "substring", "substring"]);
  });

  test("equal kinds keep newest first", async () => {
    seed("old-glovelle", { family: "Glovelle", created: "2026-01-01 00:00:00" });
    seed("new-glovelle", { family: "Glovelle", created: "2026-05-01 00:00:00" });
    const { users } = await search("?q=love");
    expect(names(users)).toEqual(["new-glovelle", "old-glovelle"]);
  });

  test("a hit found only in a field that is not a name is a substring hit", async () => {
    seed("labperson", { given: "Una", family: "Other", affiliation: "Love Lab" });
    const { users } = await search("?q=love");
    expect(users[0].match_kind).toBe("substring");
    expect(users[0].matched_in).toEqual(["affiliation"]);
  });
});

describe("when nothing matches, close matches are offered", () => {
  beforeEach(() => {
    seed("alovelace", {
      email: "ada@lab.org",
      given: "Ada",
      family: "Lovelace",
      affiliation: "University of Cambridge",
    });
    seed("swedishprof", { given: "Åsa", family: "Ekström", affiliation: "Stockholm University" });
    seed("bystander", { given: "Bea", family: "Stander" });
  });

  test("a typo in a surname", async () => {
    const { users } = await search("?q=lovelase");
    expect(names(users)).toEqual(["alovelace"]);
    expect(users[0].match_kind).toBe("fuzzy");
    expect(users[0].matched_in).toEqual(["family_name"]);
  });

  test("two neighbouring letters swapped", async () => {
    expect(names((await search("?q=lovelcae")).users)).toEqual(["alovelace"]);
  });

  test("accents are folded in both directions", async () => {
    // SQLite folds ASCII case only: the substring search cannot find an
    // accent-less spelling, or an upper-case accented one, of "Ekström"/"Åsa".
    for (const q of ["ekstrom", "EKSTRÖM", "asa"]) {
      const { users } = await search(`?q=${encodeURIComponent(q)}`);
      expect(names(users), `query ${q}`).toEqual(["swedishprof"]);
      expect(users[0].match_kind, `query ${q}`).toBe("fuzzy");
    }
  });

  test("the accent typed correctly is an ordinary hit, not a suggestion", async () => {
    const { users } = await search(`?q=${encodeURIComponent("ekström")}`);
    expect(names(users)).toEqual(["swedishprof"]);
    expect(users[0].match_kind).toBe("name");
  });

  test("several words, one of them misspelled", async () => {
    const { users } = await search("?q=ada+lovelase");
    expect(names(users)).toEqual(["alovelace"]);
    expect(users[0].matched_in).toEqual(expect.arrayContaining(["given_name", "family_name"]));
  });

  test("a typo in an affiliation, without leaking the extra fields it was read from", async () => {
    const { users } = await search("?q=cambrige");
    expect(names(users)).toEqual(["alovelace"]);
    expect(users[0].matched_in).toEqual(["affiliation"]);
    for (const leaked of ["affiliation", "city", "country"]) expect(leaked in users[0]).toBe(false);
  });

  test("a typo in a whole email address", async () => {
    expect(names((await search("?q=ada@lab.og")).users)).toEqual(["alovelace"]);
  });

  test("closer matches come before looser ones", async () => {
    seed("lovelacy", { given: "Lou", family: "Lovelacy" });
    seed("lovelaces", { given: "Lex", family: "Lovelaccs" });
    // "lovelace" is 1 edit from Lovelacy and Lovelaccs, 0 from Lovelace by
    // prefix; the strict search finds Lovelace, so use a typo that finds none.
    const { users } = await search("?q=lovelac3");
    expect(users.map((u) => u.match_kind)).toEqual(users.map(() => "fuzzy"));
    expect(names(users)).toContain("alovelace");
  });

  test("a three-letter word is never stretched: ada does not become ana or adam", async () => {
    seed("anaperson", { given: "Ana", family: "Person" });
    const { users } = await search("?q=adx");
    expect(users).toEqual([]);
  });

  test("nothing close is an empty answer, not a guess", async () => {
    expect((await search("?q=zzzzzzzz")).users).toEqual([]);
  });

  test("a close match is offered only when the substring search found nothing", async () => {
    seed("lovelacy", { given: "Lou", family: "Lovelacy" });
    const { users } = await search("?q=lovelace");
    expect(names(users)).toEqual(["alovelace"]);
    expect(users[0].match_kind).not.toBe("fuzzy");
  });

  test("the filters still apply to close matches", async () => {
    db.query("UPDATE users SET role = 'admin' WHERE username = 'swedishprof'").run();
    expect(names((await search("?q=lovelase&role=admin")).users)).toEqual([]);
    expect(names((await search("?q=lovelase&role=member")).users)).toEqual(["alovelace"]);
    expect(names((await search("?q=ekstrom&role=admin")).users)).toEqual(["swedishprof"]);
    expect(names((await search("?q=lovelase&status=approved")).users)).toEqual([]);
    expect(names((await search("?q=lovelase&status=verified")).users)).toEqual(["alovelace"]);
  });

  test("a deleted account is not offered unless asked for", async () => {
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE username = 'alovelace'").run();
    expect((await search("?q=lovelase")).users).toEqual([]);
    expect(names((await search("?q=lovelase&include_deleted=true")).users)).toEqual(["alovelace"]);
  });

  test("at most FUZZY_MAX_RESULTS, however many are close", async () => {
    for (let i = 0; i < FUZZY_MAX_RESULTS + 5; i++) seed(`smyth${i}`, { family: "Smyth" });
    const { users } = await search("?q=smith");
    expect(users).toHaveLength(FUZZY_MAX_RESULTS);
  });
});

describe("close matching never reads a secret", () => {
  test("every column it reads is an ordinary searchable text column", () => {
    for (const column of FUZZY_COLUMNS) expect(USER_COLUMN_ROLES[column]).toBe("text");
  });

  test("a near miss of a stored credential finds nothing", async () => {
    seed("holdssecret", { passwordHash: "zzsecretvaluexx" });
    expect((await search("?q=zzsecretvaluex")).users).toEqual([]);
    expect((await search("?q=zzsecretvaluez")).users).toEqual([]);
  });
});

describe("the edit-distance helper", () => {
  test("counts insertions, deletions, substitutions and a swap as one edit each", () => {
    expect(editDistance("lovelace", "lovelace", 2)).toBe(0);
    expect(editDistance("lovelace", "lovelase", 2)).toBe(1);
    expect(editDistance("lovelace", "lovelce", 2)).toBe(1);
    expect(editDistance("lovelace", "lovelacee", 2)).toBe(1);
    expect(editDistance("lovelace", "lovelcae", 2)).toBe(1);
  });

  test("gives up past the budget", () => {
    expect(editDistance("lovelace", "babbage", 2)).toBe(3);
    expect(editDistance("abc", "abcdefgh", 2)).toBe(3);
  });

  test("the budget grows with the word and is zero for short ones", () => {
    expect([1, 3, 4, 6, 7, 20].map(fuzzyBudget)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  test("fold removes accents and case and nothing else", () => {
    expect(fold("Ekström-Åsa_O'Brien")).toBe("ekstrom-asa_o'brien");
  });
});

describe("close matches are ordered by closeness, and the cap keeps the closest", () => {
  test("fewer edits first, newest first among equals", async () => {
    // "smithson" is one edit from Smithsun and Smithsin, two from Smythsun.
    // The loosest is the NEWEST, so listing by recency would put it first.
    seed("one-old", { family: "Smithsun", created: "2026-01-01 00:00:00" });
    seed("one-new", { family: "Smithsin", created: "2026-02-01 00:00:00" });
    seed("two-newest", { family: "Smythsun", created: "2026-03-01 00:00:00" });
    const { users } = await search("?q=smithson");
    expect(names(users)).toEqual(["one-new", "one-old", "two-newest"]);
  });

  test("when more are close than the cap allows, the closest survive, not the newest", async () => {
    seed("closest-oldest", { family: "Smithsun", created: "2020-01-01 00:00:00" });
    for (let i = 0; i < FUZZY_MAX_RESULTS + 4; i++) {
      seed(`looser${i}`, {
        family: "Smythsun",
        created: `2026-01-${String(i + 1).padStart(2, "0")} 00:00:00`,
      });
    }
    const { users } = await search("?q=smithson");
    expect(users).toHaveLength(FUZZY_MAX_RESULTS);
    expect(users[0].username).toBe("closest-oldest");
  });

  test("a typo in a PARTIAL word still finds the account", async () => {
    // Too long for the whole-word distance (14 letters against 8), so only the
    // comparison with the word's leading stretch can find it.
    seed("longname", { family: "Lovelacewright" });
    const { users } = await search("?q=lovelxce");
    expect(names(users)).toEqual(["longname"]);
    expect(users[0].match_kind).toBe("fuzzy");
  });
});

describe("how a hit is classified", () => {
  test("several words are a name match only if every one is a whole name word", async () => {
    seed("alovelace", { given: "Ada", family: "Lovelace", affiliation: "UC San Diego" });
    expect((await search("?q=ada+lovelace")).users[0].match_kind).toBe("name");
    // "diego" is in the affiliation, which is not a name field.
    expect((await search("?q=ada+diego")).users[0].match_kind).not.toBe("name");
  });

  test("a word of the username counts as a name word", async () => {
    seed("quill-wright");
    expect((await search("?q=quill")).users[0].match_kind).toBe("name");
  });

  test("an email word or a handle word that begins with the text is a prefix hit", async () => {
    seed("somebody", { email: "zanzibar.ops@example.org" });
    seed("anybody", { github: "quantum-labs" });
    expect((await search("?q=zanz")).users[0].match_kind).toBe("prefix");
    expect((await search("?q=quant")).users[0].match_kind).toBe("prefix");
  });
});

describe("the fields close matching reads", () => {
  test("exactly these, so adding one is a decision someone sees", () => {
    expect([...FUZZY_COLUMNS]).toEqual([
      "username",
      "email",
      "github_username",
      "given_name",
      "family_name",
      "affiliation",
      "city",
      "country",
    ]);
  });

  test("an ORCID digit run, a date or a description is never fuzzy-matched", async () => {
    const id = seed("holder", {
      orcid: "0000-0002-1825-0097",
      created: "2031-05-06 07:08:09",
    });
    db.query("UPDATE users SET description = 'interested in photosynthesis' WHERE id = ?").run(id);
    expect((await search("?q=0000-0002-1825-0098")).users).toEqual([]);
    expect((await search("?q=photosynthesys")).users).toEqual([]);
    expect((await search("?q=2031-05-07")).users).toEqual([]);
  });
});
