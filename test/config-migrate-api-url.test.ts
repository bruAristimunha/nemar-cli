import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY_URL = "https://api.osc.earth/nemar";
const LEGACY_URL_TRAILING_SLASH = "https://api.osc.earth/nemar/";
const LEGACY_URL_UPPERCASE_HOST = "HTTPS://API.OSC.EARTH/nemar";
const LEGACY_PERSONAL_PROD = "https://nemar-api.neuromechanist.workers.dev";
const LEGACY_PERSONAL_DEV = "https://nemar-api-dev.shirazi-10f.workers.dev";
const NEW_URL = "https://api.nemar.org";
const SCCN_DEV_URL = "https://nemar-api-dev.sccn-org.workers.dev";
const CUSTOM_URL = "https://api.example.com/nemar";

// src/lib/config.ts reads NEMAR_CONFIG_DIR lazily on each getStore() call
// (issue #489: a previous module-load capture made test ordering matter).
// Tests trigger migrations explicitly via migrateApiUrl() so the dir-aware
// store cache rebuilds against this test's NEMAR_CONFIG_DIR regardless of
// which test file imported src/lib/config.ts first.

const testDir = join(tmpdir(), `nemar-cfg-migrate-${Date.now()}-${process.pid}`);
const configPath = join(testDir, "config.json");

function readConfig(): {
  accounts?: Record<string, { apiUrl?: string; apiKey?: string }>;
  apiUrl?: string;
} {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

// `bun test` runs every file in one process: put the variable back as found, gone if it was unset.
const previousConfigDir = process.env.NEMAR_CONFIG_DIR;

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  process.env.NEMAR_CONFIG_DIR = testDir;
  writeFileSync(
    configPath,
    JSON.stringify({
      activeAccount: "alice",
      accounts: {
        alice: { apiUrl: LEGACY_URL, apiKey: "k1" },
        bob: { apiUrl: LEGACY_URL, apiKey: "k2" },
        carol: { apiUrl: NEW_URL, apiKey: "k3" },
        sccnDev: { apiUrl: SCCN_DEV_URL, apiKey: "k4" },
        custom: { apiUrl: CUSTOM_URL, apiKey: "k5" },
        // Legacy-flat migration produces accounts with no apiUrl when none
        // was stored. Optional chaining in migrateApiUrl must not crash here
        // and must leave the field absent.
        partial: { apiKey: "k6" },
        // Trailing-slash variant of the legacy default; must be normalized
        // and rewritten just like the canonical legacy URL.
        slashed: { apiUrl: LEGACY_URL_TRAILING_SLASH, apiKey: "k7" },
        // Pre-Phase-10 personal prod worker; now read-only, must rewrite.
        personalProd: { apiUrl: LEGACY_PERSONAL_PROD, apiKey: "k8" },
        // Pre-Phase-10 personal dev worker; was the shipped dev default in
        // 0.7.x, now dead. Must rewrite even though host contains workers.dev.
        personalDev: { apiUrl: LEGACY_PERSONAL_DEV, apiKey: "k9" },
        // Hand-edited or future legacy variant with uppercase scheme/host.
        // normalizeApiUrl lowercases scheme+host so this must match the set.
        upper: { apiUrl: LEGACY_URL_UPPERCASE_HOST, apiKey: "k10" },
        // Empty-string apiUrl is a realistic corruption mode (failed write,
        // hand edit). Migration must not crash on `new URL("")` and must
        // leave the field as-is so downstream `apiUrl || DEFAULT` falls back.
        empty: { apiUrl: "", apiKey: "k11" },
      },
      // Stale top-level apiUrl from pre-multi-account configs. migrateApiUrl
      // must drop this when accounts is already populated, otherwise users
      // see two apiUrls in config.json with no signal which one wins.
      apiUrl: LEGACY_URL,
    }),
  );
});

afterAll(() => {
  // Never `= undefined`: Bun would store the literal string "undefined".
  if (previousConfigDir === undefined) Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
  else process.env.NEMAR_CONFIG_DIR = previousConfigDir;
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("migrateApiUrl", () => {
  test("first launch rewrites legacy URLs, drops top-level field, leaves live URLs alone", async () => {
    // Migrations are lazy; trigger them explicitly so this test is
    // independent of whether another test file has already imported
    // src/lib/config.ts.
    const { migrateApiUrl } = await import("../src/lib/config.ts");
    migrateApiUrl();

    const after = readConfig();
    const accounts = after.accounts ?? {};

    // Canonical legacy URL rewritten.
    expect(accounts.alice?.apiUrl).toBe(NEW_URL);
    expect(accounts.bob?.apiUrl).toBe(NEW_URL);
    // Already-correct URL stays.
    expect(accounts.carol?.apiUrl).toBe(NEW_URL);
    // Live SCCN dev worker untouched (real dev builds depend on it).
    expect(accounts.sccnDev?.apiUrl).toBe(SCCN_DEV_URL);
    // Arbitrary self-hosted URL untouched.
    expect(accounts.custom?.apiUrl).toBe(CUSTOM_URL);
    // Account with no apiUrl: must not crash, must not invent one.
    expect(accounts.partial?.apiUrl).toBeUndefined();
    // Trailing-slash variant normalized and rewritten.
    expect(accounts.slashed?.apiUrl).toBe(NEW_URL);
    // Dead personal-account workers rewritten despite workers.dev substring.
    expect(accounts.personalProd?.apiUrl).toBe(NEW_URL);
    expect(accounts.personalDev?.apiUrl).toBe(NEW_URL);
    // Uppercase scheme/host normalized and rewritten.
    expect(accounts.upper?.apiUrl).toBe(NEW_URL);
    // Empty string preserved (downstream falls back via `apiUrl || DEFAULT`).
    expect(accounts.empty?.apiUrl).toBe("");
    // Stale top-level apiUrl dropped.
    expect(after.apiUrl).toBeUndefined();
  });

  test("second invocation is a no-op on a clean config", async () => {
    const { migrateApiUrl } = await import("../src/lib/config.ts");
    const before = readConfig();
    migrateApiUrl();
    const after = readConfig();
    expect(after).toEqual(before);
  });

  test("only top-level field stale: accounts already clean, still drops the field", async () => {
    // Overwrite the config file with a clean accounts map plus a stale
    // top-level apiUrl. Conf.store re-reads from disk on every access, so
    // migrateApiUrl() sees this freshly written snapshot even though the
    // cached Conf instance was built for testDir in earlier tests. This
    // exercises the "drop stale top-level only" branch in isolation.
    const { migrateApiUrl } = await import("../src/lib/config.ts");
    writeFileSync(
      configPath,
      JSON.stringify({
        activeAccount: "alice",
        accounts: { alice: { apiUrl: NEW_URL, apiKey: "k1" } },
        apiUrl: LEGACY_URL,
      }),
    );
    migrateApiUrl();
    const after = readConfig();
    expect(after.accounts?.alice?.apiUrl).toBe(NEW_URL);
    expect(after.apiUrl).toBeUndefined();
  });
});
