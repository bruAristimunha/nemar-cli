/**
 * License tier classification + `?license=` filter (#653).
 *
 * Three layers, all asserted against ONE explicit expected mapping so the
 * backend TS classifier and the SQL backfill can't silently co-drift:
 *   1. backend/src/lib/license.ts#licenseTier  (the authority; mirrors the
 *      website's src/lib/tags.ts#licenseTier).
 *   2. migration 0034's SQL CASE backfill, run against real bun:sqlite.
 *   3. the GET /datasets `?license=` filter clause + write-path dual-write.
 *
 * The fixture is every distinct license string in the production catalog plus a
 * few drift/edge cases. Real SQLite, no mocks.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LICENSE_TIERS,
  type LicenseTier,
  licenseTier,
  parseLicenseTierFilter,
} from "../backend/src/lib/license";
import { buildDatasetFilterClauses } from "../backend/src/routes/datasets/catalog";
import { MODALITY_TOKENS_SQL } from "../backend/src/services/dataset-filters";
import { writeDatasetCatalogFields } from "../backend/src/services/dataset-metadata-columns";

const MIG = join(import.meta.dir, "..", "backend/src/db/migrations");
const sql = (f: string) => readFileSync(join(MIG, f), "utf8");

// Every distinct license value observed in the prod catalog (2026-06), each
// with the tier the website assigns it, plus edge cases for the regex order
// (combined clauses -> stricter tier) and the UNLICENSE(?!D) lookahead.
const LICENSE_FIXTURE: Array<[string | null, LicenseTier]> = [
  ["CC0", "public"],
  ["CC0-1.0", "public"],
  ["CC0 BY 4.0", "public"],
  ["PD", "public"],
  ["PDDL", "public"],
  ["The Unlicense", "public"],
  ["CC-BY-4.0", "attribution"],
  ["CC-BY-1.0", "attribution"],
  ["CC BY 4.0", "attribution"],
  ["CC-BY 4.0", "attribution"],
  ["ODC-By-1.0", "attribution"],
  ["Open Data Commons Attribution License v1.0", "attribution"],
  ["CC-BY-SA-4.0", "sharealike"],
  ["CC-BY-SA 4.0", "sharealike"],
  ["CC BY-SA 4.0", "sharealike"],
  ["ODbL v1.0", "sharealike"],
  ["CC-BY-NC 4.0", "noncommercial"],
  ["CC BY-NC 4.0", "noncommercial"],
  ["CC-BY-NC-SA-4.0", "noncommercial"],
  ["CC-BY-NC-SA 4.0", "noncommercial"],
  ["Non-commercial research use", "noncommercial"],
  [
    "Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0) for the EEG data. Stimuli can only be used for non-commercial purposes.",
    "noncommercial",
  ],
  ["CC-BY-ND-4.0", "noderiv"],
  ["CC-BY-NC-ND-4.0", "noderiv"],
  ["GPL-3.0", "unknown"],
  ["Creative commons", "unknown"],
  ["Unknown", "unknown"],
  ["COPYRIGHT © 2021 BCMI", "unknown"],
  ["n/a", "unknown"],
  ["UNLICENSED", "unknown"], // all-rights-reserved: must NOT read as public
  [null, "unknown"],
  ["", "unknown"],
];

describe("licenseTier (TS authority)", () => {
  for (const [value, expected] of LICENSE_FIXTURE) {
    test(`${JSON.stringify(value)} -> ${expected}`, () => {
      expect(licenseTier(value)).toBe(expected);
    });
  }

  test("passes an already-classified tier name straight through", () => {
    for (const tier of LICENSE_TIERS) {
      expect(licenseTier(tier)).toBe(tier);
      expect(licenseTier(tier.toUpperCase())).toBe(tier);
    }
  });
});

describe("parseLicenseTierFilter", () => {
  test("parses comma-separated tiers, case/space tolerant", () => {
    expect(parseLicenseTierFilter("public,attribution")).toEqual(["public", "attribution"]);
    expect(parseLicenseTierFilter(" Public , ATTRIBUTION ")).toEqual(["public", "attribution"]);
  });
  test("drops invalid tokens and dedupes", () => {
    expect(parseLicenseTierFilter("public,bogus,public")).toEqual(["public"]);
    expect(parseLicenseTierFilter("nope,still-nope")).toEqual([]);
  });
  test("empty / nullish -> no filter", () => {
    expect(parseLicenseTierFilter("")).toEqual([]);
    expect(parseLicenseTierFilter(undefined)).toEqual([]);
    expect(parseLicenseTierFilter(null)).toEqual([]);
  });
});

// --- DB-backed: schema + 0029 (adds datasets.license), no license_tier yet ---
const BASE_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT NOT NULL UNIQUE,
  password_hash TEXT, github_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','approved','revoked')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  signup_source TEXT NOT NULL DEFAULT 'cli' CHECK (signup_source IN ('cli','web'))
);
CREATE TABLE datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT, owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  github_repo TEXT, concept_doi TEXT, latest_version_doi TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  enrichment_json TEXT, source TEXT, source_id TEXT,
  subject_count INTEGER, modalities TEXT, age_min REAL, age_max REAL, file_size INTEGER,
  total_files INTEGER, tasks TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
INSERT INTO users (id, username, email, status) VALUES (10, 'alice', 'a@x.org', 'approved');
`;

function realD1(db: Database): D1Database {
  return {
    prepare(q: string) {
      const stmt = db.query(q);
      let bound: unknown[] = [];
      const api = {
        bind(...p: unknown[]) {
          bound = p;
          return api;
        },
        run() {
          const r = stmt.run(...(bound as never[]));
          return Promise.resolve({ success: true, meta: { changes: r.changes } });
        },
        first<T>() {
          return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
        },
        all<T>() {
          return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function dbWith0029(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(BASE_SCHEMA);
  db.exec(sql("0029_consolidation_columns_and_sentinel.sql"));
  return db;
}

describe("migration 0034 SQL backfill == licenseTier", () => {
  test("classifies every fixture license identically to the TS authority", () => {
    const db = dbWith0029();
    // Seed rows carrying the raw license BEFORE license_tier exists.
    LICENSE_FIXTURE.forEach(([value], i) => {
      db.query(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, license) VALUES (?,?,?,?,?,?)",
      ).run(`nm${String(900000 + i)}`, `ds ${i}`, 10, "active", "public", value);
    });
    // Apply 0034: adds license_tier (DEFAULT 'unknown') + the CASE backfill.
    db.exec(sql("0034_license_tier.sql"));

    const rows = db
      .query("SELECT dataset_id, license, license_tier FROM datasets ORDER BY id")
      .all() as Array<{ dataset_id: string; license: string | null; license_tier: string }>;

    expect(rows.length).toBe(LICENSE_FIXTURE.length);
    rows.forEach((row, i) => {
      const [value, expected] = LICENSE_FIXTURE[i];
      // SQL == explicit expected AND SQL == TS (both can't co-drift undetected).
      expect(`${value} -> ${row.license_tier}`).toBe(`${value} -> ${expected}`);
      expect(row.license_tier).toBe(licenseTier(value));
    });
  });

  test("license_tier is never NULL (NOT NULL DEFAULT 'unknown')", () => {
    const db = dbWith0029();
    // A row that sets no license at all (like a freshly created managed dataset).
    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility) VALUES (?,?,?,?,?)",
    ).run("nm000950", "no license", 10, "active", "public");
    db.exec(sql("0034_license_tier.sql"));
    const row = db.query("SELECT license_tier FROM datasets WHERE dataset_id='nm000950'").get() as {
      license_tier: string;
    };
    expect(row.license_tier).toBe("unknown");
  });
});

describe("buildDatasetFilterClauses license clause", () => {
  test("emits an IN clause with one placeholder per tier (OR semantics)", () => {
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, {
      licenseTiers: ["public", "attribution"],
    });
    expect(clause).toContain("d.license_tier IN (?, ?)");
    expect(params).toEqual(["public", "attribution"]);
  });

  test("no clause when no tiers requested", () => {
    const params: (string | number)[] = [];
    expect(buildDatasetFilterClauses(params, { licenseTiers: [] })).toBe("");
    expect(buildDatasetFilterClauses(params, {})).toBe("");
    expect(params).toEqual([]);
  });

  test("accumulates params correctly alongside a preceding modality clause", () => {
    // Guards the shared-params spread: each tier must push as a flat value, so a
    // combined modality + license filter binds ['["eeg"]', "public"] (the
    // modality's token list is one JSON-array parameter, #1711), never a nested
    // [['["eeg"]'], ["public"]] that would corrupt the binding.
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, {
      modality: "eeg",
      licenseTiers: ["public"],
    });
    expect(clause).toContain(MODALITY_TOKENS_SQL);
    expect(clause).toContain("d.license_tier IN (?)");
    expect(params).toEqual(['["eeg"]', "public"]);
  });

  test("filters real rows by tier end-to-end", () => {
    const db = dbWith0029();
    LICENSE_FIXTURE.forEach(([value], i) => {
      db.query(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, license) VALUES (?,?,?,?,?,?)",
      ).run(`nm${String(900000 + i)}`, `ds ${i}`, 10, "active", "public", value);
    });
    db.exec(sql("0034_license_tier.sql"));

    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, {
      licenseTiers: ["noncommercial", "noderiv"],
    });
    const rows = db
      .query(`SELECT d.license FROM datasets d WHERE 1=1${clause}`)
      .all(...(params as never[])) as Array<{ license: string | null }>;

    const expectedCount = LICENSE_FIXTURE.filter(
      ([, t]) => t === "noncommercial" || t === "noderiv",
    ).length;
    expect(rows.length).toBe(expectedCount);
    for (const r of rows) {
      expect(["noncommercial", "noderiv"]).toContain(licenseTier(r.license));
    }
  });
});

describe("writeDatasetCatalogFields dual-writes license_tier", () => {
  function dbWith0034(): Database {
    const db = dbWith0029();
    db.exec(sql("0034_license_tier.sql"));
    // These tests pin the schema at 0034 on purpose -- they are about the
    // license_tier dual-write that migration introduced. But the FUNCTION
    // under test is the current one, and since #1407 its single UPDATE reads
    // `anonymous` to decide whether to withhold the authors value. Added here
    // with migration 0085's own default rather than replaying every later
    // migration, so the fixture stays the narrow one these tests describe.
    db.exec("ALTER TABLE datasets ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0");
    return db;
  }

  test("sets license_tier from the license being written", async () => {
    const db = dbWith0034();
    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility) VALUES (?,?,?,?,?)",
    ).run("nm000960", "row", 10, "active", "public");

    await writeDatasetCatalogFields(realD1(db), "nm000960", { license: "CC-BY-NC-SA-4.0" });
    let row = db
      .query("SELECT license, license_tier FROM datasets WHERE dataset_id='nm000960'")
      .get() as {
      license: string;
      license_tier: string;
    };
    expect(row.license).toBe("CC-BY-NC-SA-4.0");
    expect(row.license_tier).toBe("noncommercial");

    // A license-less update must preserve both license and the derived tier.
    await writeDatasetCatalogFields(realD1(db), "nm000960", { authors: "Someone" });
    row = db
      .query("SELECT license, license_tier FROM datasets WHERE dataset_id='nm000960'")
      .get() as {
      license: string;
      license_tier: string;
    };
    expect(row.license).toBe("CC-BY-NC-SA-4.0");
    expect(row.license_tier).toBe("noncommercial");
  });
});
