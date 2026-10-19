/**
 * The live-test account sweep on Miniflare D1, the implementation `wrangler dev` and
 * `wrangler d1 ... --local` run (#1789).
 *
 * `test-account-sweep.test.ts` runs the sweep on bun:sqlite, which is more lenient than D1: D1
 * refuses a LIKE or GLOB pattern over 50 bytes (`LIKE or GLOB pattern too complex`), and the
 * first version of the candidate query carried GLOBs of 83 to 87 bytes. Every bun:sqlite test
 * passed; on the real database the candidate read threw, the sweep recorded `errors=1` and never
 * tombstoned anything. This file runs the real `sweepCiTestAccounts` through real service code
 * with only the database swapped, so that class of failure cannot pass again.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { TEST_ACCOUNT_SWEEP_BATCH, sweepCiTestAccounts } from "../src/services/test-account-sweep";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

let mf: Miniflare;
let counter = 0;

beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB1", "DB2"],
  });
});

afterAll(async () => {
  await mf?.dispose();
});

async function freshD1(): Promise<D1Database> {
  counter += 1;
  const d1 = (await mf.getD1Database(`DB${counter}`)) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
  return d1;
}

async function seed(d1: D1Database, email: string, ageDays = 30): Promise<number> {
  await d1
    .prepare(
      `INSERT INTO users (email, status, signup_source, role, created_at, updated_at)
       VALUES (?, 'verified', 'web', 'member', datetime('now', ?), datetime('now', ?))`,
    )
    .bind(email, `-${ageDays} days`, `-${ageDays} days`)
    .run();
  const row = await d1
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: number }>();
  if (!row) throw new Error(`seed failed for ${email}`);
  return row.id;
}

async function deletedAt(d1: D1Database, id: number): Promise<string | null> {
  const row = await d1
    .prepare("SELECT deleted_at AS d FROM users WHERE id = ?")
    .bind(id)
    .first<{ d: string | null }>();
  return row?.d ?? null;
}

describe("the sweep on D1", () => {
  test("the candidate query runs, tombstones the generated shapes and leaves everything else", async () => {
    const d1 = await freshD1();
    const swept = [
      await seed(d1, "dcli-full-loop-1760000000001-abc123@nemar.test"),
      await seed(d1, "df-pending-confirm-1760000000002-abc123@nemar.test"),
      await seed(d1, "pl-cookie572-bearerwins-1760000000003-abc123@nemar.test"),
      await seed(d1, "pl-gate-1760000000004-abc123@example.com"),
    ];
    const kept = [
      await seed(d1, "jane.doe@example.org"),
      await seed(d1, "jane.doe@example.com"),
      await seed(d1, "pl-profile-patch@nemar.test"),
      await seed(d1, "test-user@nemar.test"),
      await seed(d1, "dcli-full-loop-1760000000005-abc123@example.com"),
      await seed(d1, "df-gate-1760000000006-abc123@example.com"),
      await seed(d1, "DCLI-FULL-LOOP-1760000000007-ABC123@NEMAR.TEST"),
      await seed(d1, "pl-young-1760000000008-abc123@nemar.test", 1),
    ];
    await d1
      .prepare(
        "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, 'hash', 'pfx12345')",
      )
      .bind(swept[0])
      .run();

    const result = await sweepCiTestAccounts({ DB: d1, ENVIRONMENT: "test" });

    // errors=0 is the assertion that would have failed: the candidate read threw on D1.
    expect(result.errors).toBe(0);
    expect(result.tombstoned).toBe(swept.length);
    for (const id of swept) expect(await deletedAt(d1, id)).not.toBeNull();
    for (const id of kept) expect(await deletedAt(d1, id)).toBeNull();
    const live = await d1
      .prepare("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL")
      .bind(swept[0])
      .first<{ n: number }>();
    expect(live?.n).toBe(0);
  });

  test("a second run pages past the look-alikes and reaches later candidates", async () => {
    const d1 = await freshD1();
    // Look-alikes the SQL prefilter admits and the pattern rejects, older than the real candidate.
    for (let i = 0; i < 30; i++) await seed(d1, `pl-fixture-${i}@nemar.test`, 90);
    const target = await seed(d1, "pl-late-1760000000009-abc123@nemar.test", 10);

    const result = await sweepCiTestAccounts({ DB: d1, ENVIRONMENT: "test" });

    expect(result.errors).toBe(0);
    expect(result.skipped).toBe(30);
    expect(result.tombstoned).toBe(1);
    expect(await deletedAt(d1, target)).not.toBeNull();
    expect(TEST_ACCOUNT_SWEEP_BATCH).toBeGreaterThan(30);
  });
});
