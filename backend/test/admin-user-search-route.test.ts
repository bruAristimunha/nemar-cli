/**
 * GET /admin/users?q= and GET /admin/users/by-id/:id (ADR 0096).
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real
 * admin router (authMiddleware + adminMiddleware, real hashed tokens). No mocks.
 *
 * The first describe block is the guard that keeps "search every field" true:
 * it compares the column classification with the live schema in both
 * directions, so a migration that adds a column fails here until someone says
 * whether the column is searched, returned, or a secret.
 *
 * What this file cannot show, and why: the 100-bound-parameter limit is
 * Cloudflare D1's, not SQLite's, so bun:sqlite will happily run a statement D1
 * would refuse. The parameter-budget test therefore asserts the property that
 * keeps D1 happy (the number of DISTINCT placeholders in the generated SQL)
 * rather than pretending the engine enforces it.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  ADMIN_USER_SEARCH_MAX_TERMS,
  ADMIN_USER_SEARCH_MAX_TERM_CHARS,
  adminUserDetailSchema,
} from "../../shared/contract/admin-user.js";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import {
  ADMIN_USER_DETAIL_SELECT,
  USER_COLUMN_ROLES,
  USER_SEARCH_TEXT_COLUMNS,
  USER_SECRET_COLUMNS,
  buildUserSearchSql,
} from "../src/services/user-search";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "search-admin-key-0123456789abcdef0123456789ab";
const MEMBER_KEY = "search-member-key-0123456789abcdef0123456789";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

async function seedActor(username: string, role: string, apiKey: string): Promise<void> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed: actor insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
}

function userId(username: string): number {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`no such user ${username}`);
  return row.id;
}

interface Row {
  id: number;
  username: string | null;
  matched_in?: string[];
  [key: string]: unknown;
}

async function search(
  query: string,
  key = ADMIN_KEY,
): Promise<{ status: number; users: Row[]; body: Record<string, unknown> }> {
  const res = await app.request(
    `/admin/users${query}`,
    { headers: { Authorization: `Bearer ${key}` } },
    env(),
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, users: (body.users as Row[]) ?? [], body };
}

async function detail(
  id: number | string,
  query = "",
  key = ADMIN_KEY,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(
    `/admin/users/by-id/${id}${query}`,
    { headers: { Authorization: `Bearer ${key}` } },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedActor("searchadmin", "admin", ADMIN_KEY);
});

describe("the column classification", () => {
  test("names exactly the columns of the migrated users table, in both directions", () => {
    const live = db
      .query<{ name: string }, []>("PRAGMA table_info(users)")
      .all()
      .map((c) => c.name)
      .sort();
    const classified = Object.keys(USER_COLUMN_ROLES).sort();
    // A column in the table and not the classification would be unsearched AND
    // unreturned by default; one in the classification and not the table is a
    // SELECT that fails at request time. Both are caught here, at test time.
    expect(classified).toEqual(live);
  });

  test("the detail contract names exactly the columns the detail route selects, plus its computed values", () => {
    const selected = ADMIN_USER_DETAIL_SELECT.split(", ")
      .map((column) => column.replace(/^u\./, ""))
      .sort();
    const computed = ["dataset_count", "active_tokens", "linked_identities"];
    const declared = Object.keys(adminUserDetailSchema.shape)
      .filter((key) => !computed.includes(key))
      .sort();
    // The contract's header leans on USER_COLUMN_ROLES being the single
    // classification; this is what makes a drift between the two a failure.
    expect(declared).toEqual(selected);
  });

  test("every credential column is a secret and none is searched or selected", () => {
    for (const column of [
      "password_hash",
      "verification_token",
      "verification_expires_at",
      "aws_access_key_id_encrypted",
      "aws_secret_access_key_encrypted",
    ]) {
      expect((USER_COLUMN_ROLES as Record<string, string>)[column]).toBe("secret");
      expect(USER_SEARCH_TEXT_COLUMNS).not.toContain(column);
      expect(ADMIN_USER_DETAIL_SELECT).not.toContain(column);
    }
    expect([...USER_SECRET_COLUMNS].sort()).toEqual(
      Object.entries(USER_COLUMN_ROLES)
        .filter(([, role]) => role === "secret")
        .map(([name]) => name)
        .sort(),
    );
  });
});

describe("GET /admin/users?q= finds an account by any text field", () => {
  // One value per text column, distinct from every other so that a hit names
  // exactly one column. Constrained columns (status, signup_source, role,
  // account_kind) use a value the schema allows and are searched by it; the
  // free-form ones get a made-up token.
  const FREE_TEXT: Record<string, string> = {
    username: "zqusernamezq",
    email: "zqemailzq@example.org",
    github_username: "zqgithubzq",
    orcid: "0000-0003-1415-9265",
    given_name: "Zqgivenzq",
    family_name: "Zqfamilyzq",
    affiliation: "Zqaffiliationzq University",
    city: "Zqcityzq",
    country: "Zqcountryzq",
    description: "zqdescriptionzq about this account",
    aws_iam_username: "zqiamzq",
    sandbox_dataset_id: "xx0zqsandboxzq",
    created_at: "2041-01-01T00:00:01Z",
    updated_at: "2042-01-01T00:00:02Z",
    approved_at: "2043-01-01T00:00:03Z",
    revoked_at: "2044-01-01T00:00:04Z",
    sandbox_completed_at: "2045-01-01T00:00:05Z",
    service_access_granted_at: "2046-01-01T00:00:06Z",
    upload_access_requested_at: "2047-01-01T00:00:07Z",
    upload_access_notified_at: "2048-01-01T00:00:08Z",
  };
  const CONSTRAINED: Record<string, { value: string; search: string }> = {
    status: { value: "revoked", search: "revoked" },
    role: { value: "admin", search: "admin" },
    account_kind: { value: "service", search: "service" },
    signup_source: { value: "web", search: "web" },
    deleted_at: { value: "2049-01-01T00:00:09Z", search: "2049-01-01t00:00:09z" },
  };

  test("the table covers every searchable column, so a new one cannot be forgotten", () => {
    const covered = [...Object.keys(FREE_TEXT), ...Object.keys(CONSTRAINED)].sort();
    expect([...USER_SEARCH_TEXT_COLUMNS].sort()).toEqual(covered);
  });

  for (const column of Object.keys(FREE_TEXT)) {
    test(`finds the account by ${column}, and reports that column`, async () => {
      db.query(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified, signup_source)
         VALUES ('bystander', 'bystander@example.org', 'x', 'verified', 'member', 1, 'cli')`,
      ).run();
      // Build the target with ONLY this column set to its distinctive value, so
      // the assertion proves this column is what matched.
      const base: Record<string, string | null> = {
        username: "targetuser",
        email: "target@example.org",
        status: "verified",
        signup_source: "cli",
        role: "member",
      };
      base[column] = FREE_TEXT[column];
      const names = Object.keys(base);
      db.query(
        `INSERT INTO users (${names.join(", ")}, password_hash) VALUES (${names.map(() => "?").join(", ")}, 'x')`,
      ).run(...names.map((n) => base[n]));

      // Searched by the made-up token's own lower-cased form: case must not matter.
      const word = FREE_TEXT[column].split(/\s+/)[0];
      const { status, users } = await search(`?q=${encodeURIComponent(word.toUpperCase())}`);
      expect(status).toBe(200);
      expect(users.map((u) => u.id)).toEqual([userId(base.username ?? "targetuser")]);
      expect(users[0].matched_in).toEqual([column]);
    });
  }

  for (const [column, { value, search: word }] of Object.entries(CONSTRAINED)) {
    test(`finds the account by ${column}`, async () => {
      // A background of ordinary accounts that do NOT carry the value, so the
      // hit is selective rather than "everyone".
      db.query(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified, signup_source, account_kind)
         VALUES ('plainone', 'plain1@example.org', 'x', 'verified', 'member', 1, 'cli', 'person')`,
      ).run();
      const base: Record<string, string> = {
        username: "constrained",
        email: "constrained@example.org",
        status: "verified",
        signup_source: "cli",
        role: "member",
        account_kind: "person",
      };
      base[column] = value;
      const names = Object.keys(base);
      db.query(
        `INSERT INTO users (${names.join(", ")}, password_hash) VALUES (${names.map(() => "?").join(", ")}, 'x')`,
      ).run(...names.map((n) => base[n]));

      const path = `?q=${encodeURIComponent(word)}${column === "deleted_at" ? "&include_deleted=true" : ""}`;
      const { users } = await search(path);
      const hit = users.find((u) => u.username === "constrained");
      expect(hit).toBeDefined();
      expect(hit?.matched_in).toContain(column);
      expect(users.find((u) => u.username === "plainone")).toBeUndefined();
    });
  }
});

describe("GET /admin/users?q= matching rules", () => {
  beforeEach(() => {
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                          given_name, family_name, affiliation, orcid, created_at)
       VALUES ('alovelace', 'ada@lab.org', 'x', 'verified', NULL, 1,
               'Ada', 'Lovelace', 'UC San Diego', '0000-0002-1825-0097', '2026-09-14 10:00:00')`,
    ).run();
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                          given_name, family_name, affiliation, created_at)
       VALUES ('cbabbage', 'charles@lab.org', 'x', 'approved', 'admin', 1,
               'Charles', 'Babbage', 'University of Cambridge', '2025-01-02 03:04:05')`,
    ).run();
  });

  test("words are ANDed across different fields", async () => {
    // "ada" is a given name (and part of the email), "diego" an affiliation.
    const hit = await search("?q=ada+diego");
    expect(hit.users.map((u) => u.username)).toEqual(["alovelace"]);
    // One word from each of two accounts matches neither.
    const miss = await search("?q=lovelace+cambridge");
    expect(miss.users).toEqual([]);
  });

  test("the match is case-insensitive and a substring", async () => {
    expect((await search("?q=LOVELA")).users.map((u) => u.username)).toEqual(["alovelace"]);
    expect((await search("?q=1825-0097")).users.map((u) => u.username)).toEqual(["alovelace"]);
  });

  test("% and _ are ordinary characters, not wildcards", async () => {
    expect((await search("?q=%25")).users).toEqual([]);
    expect((await search("?q=a_a")).users).toEqual([]);
    // "alovelace" contains "lo", and "l_v" would match it if _ were a wildcard.
    expect((await search("?q=l_v")).users).toEqual([]);
  });

  test("the word 'member' finds an account whose role is stored as NULL", async () => {
    const { users } = await search("?q=member");
    expect(users.map((u) => u.username)).toContain("alovelace");
    expect(users.find((u) => u.username === "alovelace")?.matched_in).toContain("role");
    expect(users.map((u) => u.username)).not.toContain("cbabbage");
  });

  test("a numeric word also matches the account id exactly", async () => {
    const id = userId("cbabbage");
    const { users } = await search(`?q=${id}`);
    const hit = users.find((u) => u.id === id);
    expect(hit?.matched_in).toContain("id");
  });

  test("a search narrows within a status, role or kind filter", async () => {
    expect((await search("?q=lab.org&role=admin")).users.map((u) => u.username)).toEqual([
      "cbabbage",
    ]);
    expect((await search("?q=lab.org&role=member")).users.map((u) => u.username)).toEqual([
      "alovelace",
    ]);
    expect((await search("?q=lab.org&status=approved")).users.map((u) => u.username)).toEqual([
      "cbabbage",
    ]);
    expect((await search("?q=lab.org&kind=service")).users).toEqual([]);
  });

  test("a tombstoned account is hidden unless include_deleted is asked for", async () => {
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE username = 'cbabbage'").run();
    expect((await search("?q=babbage")).users).toEqual([]);
    expect((await search("?q=babbage&include_deleted=true")).users).toHaveLength(1);
  });

  test("a listing that is not a search carries no matched_in", async () => {
    const { users } = await search("?role=admin");
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) expect("matched_in" in u).toBe(false);
  });

  test("an empty, over-long or over-wide query is refused, never answered with everyone", async () => {
    const empty = await search("?q=");
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("invalid_search");

    const blank = await search("?q=%20%20");
    expect(blank.status).toBe(400);

    const many = Array.from({ length: ADMIN_USER_SEARCH_MAX_TERMS + 1 }, (_, i) => `w${i}`).join(
      "+",
    );
    const tooMany = await search(`?q=${many}`);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toBe("invalid_search");

    const long = await search(`?q=${"x".repeat(ADMIN_USER_SEARCH_MAX_TERM_CHARS + 1)}`);
    expect(long.status).toBe(400);
  });

  test("a numeric word is ANDed with the other words, and matches the id on its own", async () => {
    // The id's digits appear nowhere else in these rows, so only the
    // `OR id = ...` branch can satisfy the numeric word.
    db.query("UPDATE users SET id = 987654 WHERE username = 'alovelace'").run();
    const hit = await search("?q=987654+lovelace");
    expect(hit.users.map((u) => u.username)).toEqual(["alovelace"]);
    const miss = await search("?q=987654+babbage");
    expect(miss.users).toEqual([]);
  });

  test("a word never matches across two fields", async () => {
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, given_name, family_name)
       VALUES ('splitname', 'split@example.org', 'x', 'verified', 'member', 1, 'Ab', 'Cd')`,
    ).run();
    expect((await search("?q=abcd")).users).toEqual([]);
    expect((await search("?q=ab+cd")).users.map((u) => u.username)).toEqual(["splitname"]);
  });

  test("a word of exactly the maximum length is accepted, one more is not", async () => {
    const atLimit = "x".repeat(ADMIN_USER_SEARCH_MAX_TERM_CHARS);
    expect((await search(`?q=${atLimit}`)).status).toBe(200);
    expect((await search(`?q=${atLimit}x`)).status).toBe(400);
  });

  test("equal creation times list the newest account first", async () => {
    for (const name of ["tie-a", "tie-b", "tie-c"]) {
      db.query(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified, family_name, created_at)
         VALUES (?, ?, 'x', 'verified', 'member', 1, 'Tiebreak', '2030-01-01 00:00:00')`,
      ).run(name, `${name}@example.org`);
    }
    const { users } = await search("?q=tiebreak");
    expect(users.map((u) => u.username)).toEqual(["tie-c", "tie-b", "tie-a"]);
  });

  test("real-world punctuation is searched as written", async () => {
    const cases: Array<[string, string]> = [
      ["o'brien", "obrien"],
      ["R&D Lab", "randd"],
      ["c++ group", "cppgroup"],
      ["100% Open", "openpct"],
      ["#1 Institute", "firstinst"],
    ];
    for (const [affiliation, username] of cases) {
      db.query(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified, affiliation)
         VALUES (?, ?, 'x', 'verified', 'member', 1, ?)`,
      ).run(username, `${username}@example.org`, affiliation);
    }
    for (const [affiliation, username] of cases) {
      const word = affiliation.split(" ")[0];
      const { status, users } = await search(`?q=${encodeURIComponent(word)}`);
      expect(status, word).toBe(200);
      expect(
        users.map((u) => u.username),
        word,
      ).toContain(username);
    }
  });

  test("the widest allowed search still runs", async () => {
    const words = Array.from({ length: ADMIN_USER_SEARCH_MAX_TERMS }, () => "a").join("+");
    const { status } = await search(`?q=${words}`);
    expect(status).toBe(200);
  });

  test("the generated SQL stays inside D1's 100-parameter limit at the widest search", () => {
    // D1, not SQLite, enforces the limit, so assert the property that keeps it
    // satisfied: one distinct placeholder per word, however many columns.
    const bound: string[] = [];
    const sql = buildUserSearchSql(
      Array.from({ length: ADMIN_USER_SEARCH_MAX_TERMS }, (_, i) => `1234${i}`),
      (term) => {
        bound.push(term);
        return `?${bound.length}`;
      },
    );
    const placeholders = new Set(`${sql.where} ${sql.matchedIn}`.match(/\?\d+/g));
    expect(placeholders.size).toBe(ADMIN_USER_SEARCH_MAX_TERMS);
    expect(placeholders.size).toBeLessThanOrEqual(100);
    // And the statement itself is far under D1's 100 KB statement cap.
    expect(sql.where.length + sql.matchedIn.length).toBeLessThan(60_000);
  });
});

describe("credentials are neither searched nor returned", () => {
  const SECRETS = {
    password_hash: "pwhash-zzsecretvalue-1",
    verification_token: "vtoken-zzsecretvalue-2",
    verification_expires_at: "2099-12-31T23:59:59Z",
    aws_access_key_id_encrypted: "awsid-zzsecretvalue-3",
    aws_secret_access_key_encrypted: "awssecret-zzsecretvalue-4",
  };

  beforeEach(() => {
    db.query(
      `INSERT INTO users (username, email, status, role, email_verified,
                          password_hash, verification_token, verification_expires_at,
                          aws_access_key_id_encrypted, aws_secret_access_key_encrypted)
       VALUES ('holdssecrets', 'holds@example.org', 'verified', 'member', 1, ?, ?, ?, ?, ?)`,
    ).run(
      SECRETS.password_hash,
      SECRETS.verification_token,
      SECRETS.verification_expires_at,
      SECRETS.aws_access_key_id_encrypted,
      SECRETS.aws_secret_access_key_encrypted,
    );
  });

  for (const [column, value] of Object.entries(SECRETS)) {
    test(`searching for a stored ${column} finds nothing`, async () => {
      const { users } = await search(`?q=${encodeURIComponent(value)}`);
      expect(users).toEqual([]);
    });
  }

  test("the detail route returns none of the credential columns or their values", async () => {
    const { status, body } = await detail(userId("holdssecrets"));
    expect(status).toBe(200);
    const user = body.user as Record<string, unknown>;
    for (const column of Object.keys(SECRETS)) expect(column in user).toBe(false);
    const text = JSON.stringify(body);
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
  });

  test("the listing returns none of them either", async () => {
    const { body } = await search("?q=holdssecrets");
    const text = JSON.stringify(body);
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
  });

  // The username-keyed route is the older one, and used to return the whole
  // row. It is fixed in the same change; this is what keeps it fixed.
  describe("GET /admin/users/:username", () => {
    async function byUsername(
      username: string,
      key = ADMIN_KEY,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await app.request(
        `/admin/users/${username}`,
        { headers: { Authorization: `Bearer ${key}` } },
        env(),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    test("returns none of the credential columns or their values, to an admin", async () => {
      const { status, body } = await byUsername("holdssecrets");
      expect(status).toBe(200);
      const user = body.user as Record<string, unknown>;
      for (const column of Object.keys(SECRETS)) expect(column in user).toBe(false);
      const text = JSON.stringify(body);
      for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
    });

    test("still returns what its callers read, and the two counts", async () => {
      db.query(
        "UPDATE users SET account_kind = 'test', email_preferences = '{\"digest\":false}' WHERE username = 'holdssecrets'",
      ).run();
      const { body } = await byUsername("holdssecrets");
      expect(body.user).toMatchObject({
        username: "holdssecrets",
        email: "holds@example.org",
        status: "verified",
        // `nemar admin doctor kinds` reads these two.
        account_kind: "test",
        // A non-secret column the route has always returned stays returned.
        email_preferences: '{"digest":false}',
        dataset_count: 0,
        active_tokens: 0,
      });
    });

    test("404 for an unknown or deleted username", async () => {
      expect((await byUsername("nobodyatall")).status).toBe(404);
      db.query(
        "UPDATE users SET deleted_at = datetime('now') WHERE username = 'holdssecrets'",
      ).run();
      expect((await byUsername("holdssecrets")).status).toBe(404);
    });
  });
});

describe("GET /admin/users/by-id/:id", () => {
  test("returns every non-secret column plus the computed counts", async () => {
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                          given_name, family_name, affiliation, city, country, orcid, orcid_verified)
       VALUES ('detailed', 'detailed@example.org', 'x', 'approved', 'member', 1,
               'Dee', 'Tail', 'Lab', 'Berlin', 'Germany', '0000-0002-1825-0097', 1)`,
    ).run();
    const id = userId("detailed");
    db.query(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', '0000-0002-1825-0097')",
    ).run(id);
    db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, 'h1', 'p1')",
    ).run(id);
    db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, revoked_at) VALUES (?, 'h2', 'p2', datetime('now'))",
    ).run(id);

    const { status, body } = await detail(id);
    expect(status).toBe(200);
    const user = body.user as Record<string, unknown>;
    expect(user).toMatchObject({
      id,
      username: "detailed",
      email: "detailed@example.org",
      given_name: "Dee",
      family_name: "Tail",
      affiliation: "Lab",
      city: "Berlin",
      country: "Germany",
      orcid: "0000-0002-1825-0097",
      orcid_verified: 1,
      status: "approved",
      account_kind: "person",
      dataset_count: 0,
      active_tokens: 1,
      linked_identities: ["orcid"],
    });
  });

  test("an account with no linked sign-in reports an empty list, not null", async () => {
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('nolink', 'nolink@example.org', 'x', 'verified', 'member', 1)`,
    ).run();
    const { body } = await detail(userId("nolink"));
    expect((body.user as Record<string, unknown>).linked_identities).toEqual([]);
  });

  test("reaches a web/ORCID account that has no username", async () => {
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, signup_source)
       VALUES (NULL, 'weborcid@example.org', 'x', 'verified', 'member', 1, 'web')`,
    ).run();
    const id = Number(
      db
        .query<{ id: number }, []>("SELECT id FROM users WHERE email = 'weborcid@example.org'")
        .get()?.id,
    );
    const { status, body } = await detail(id);
    expect(status).toBe(200);
    expect((body.user as Record<string, unknown>).username).toBeNull();
  });

  test("404 for an unknown id and for a tombstoned account, unless include_deleted", async () => {
    expect((await detail(999999)).status).toBe(404);
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, deleted_at)
       VALUES ('gone', 'gone@example.org', 'x', 'revoked', 'member', 1, datetime('now'))`,
    ).run();
    const id = userId("gone");
    expect((await detail(id)).status).toBe(404);
    expect((await detail(id, "?include_deleted=true")).status).toBe(200);
  });

  test("400 for an id that is not a whole number", async () => {
    for (const bad of ["abc", "0", "1.5", "1e3", "12abc"]) {
      const { status, body } = await detail(bad);
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_user_id");
    }
  });

  test("the internal system account can be read, because search lists it", async () => {
    const listed = await search("?q=nemar-system");
    expect(listed.users.map((u) => u.username)).toContain("nemar-system");
    const { status, body } = await detail(-1);
    expect(status).toBe(200);
    expect((body.user as Record<string, unknown>).username).toBe("nemar-system");
    expect((await detail(-424242)).status).toBe(404);
  });

  test("a member cannot read it", async () => {
    await seedActor("plainmember", "member", MEMBER_KEY);
    const { status } = await detail(userId("searchadmin"), "", MEMBER_KEY);
    expect(status).toBe(403);
    const listed = await search("?q=searchadmin", MEMBER_KEY);
    expect(listed.status).toBe(403);
  });
});
