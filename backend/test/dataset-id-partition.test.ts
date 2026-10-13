/**
 * Dataset-ID sandbox partition tests (epic #923, phase 1 / #930).
 *
 * Verifies the xx-range partition that keeps dev/test-created sandbox datasets
 * (xx090001-xx099999) from colliding with prod-created ones (xx000001-xx089999)
 * in the shared nemarDatasets GitHub org, plus the isDevRangeDatasetId helper the
 * prod webhook receiver uses to refuse dispatching against staging repos.
 *
 * Real in-memory SQLite via the shared realD1 helper (no mocks); every result
 * comes from SQLite executing the production allocation SQL against the full
 * migrated schema.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EXEMPLAR_ID_RE } from "../src/routes/admin/exemplar";
import {
  ABSENT_DATASET_ID,
  DEV_EPHEMERAL_BAND_END,
  DEV_OWNED_FIXTURE_IDS,
  DEV_SANDBOX_RANGE_RE,
  NEVER_DEV_OWNED_IDS,
  RESERVED_FIXTURE_FLOOR,
  formatDatasetId,
  generateDatasetId,
  isDevEphemeralSandboxId,
  isDevOwnedDatasetId,
  isDevRangeDatasetId,
  isReservedFixtureId,
  isValidDatasetId,
} from "../src/services/datasetId";
import { freshDb, realD1 } from "./helpers/d1";

function seedIds(db: Database, ids: string[]): void {
  const stmt = db.query(
    "INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES (?, 'test', 1)",
  );
  for (const id of ids) stmt.run(id);
}

/**
 * Seed every id in [from, to] for a prefix, inclusive, in one statement.
 *
 * Exists so the allocator can be tested against a FULL band. The reserved-band
 * tests below are the only ones that need it, and they need it for the reason
 * the reservation exists: a band is only crossed when everything below it is
 * gone, so a test that seeds a handful of rows never reaches the boundary it
 * claims to be testing.
 */
function seedRange(db: Database, prefix: string, from: number, to: number): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id)
     WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x + 1 FROM n WHERE x < ?)
     SELECT ? || substr('000000' || x, -6), 'test', 1 FROM n`,
    [from, to, prefix],
  );
}

describe("isDevRangeDatasetId / DEV_SANDBOX_RANGE_RE", () => {
  test("matches the dev/test band xx090000-xx099999", () => {
    expect(isDevRangeDatasetId("xx090000")).toBe(true);
    expect(isDevRangeDatasetId("xx090001")).toBe(true);
    expect(isDevRangeDatasetId("xx099900")).toBe(true); // exemplar sub-band
    expect(isDevRangeDatasetId("xx099999")).toBe(true);
  });

  test("rejects the prod sandbox band and other prefixes", () => {
    expect(isDevRangeDatasetId("xx089999")).toBe(false); // prod ceiling
    expect(isDevRangeDatasetId("xx000001")).toBe(false);
    expect(isDevRangeDatasetId("nm090000")).toBe(false);
    expect(isDevRangeDatasetId("on090000")).toBe(false);
    expect(isDevRangeDatasetId("xx900001")).toBe(false); // out-of-cap, xx90.. not xx09..
    expect(isDevRangeDatasetId("")).toBe(false);
  });

  test("the regex and helper agree on the exact boundary", () => {
    // xx089999 -> prod, xx090000 -> dev: the two adjacent numbers straddle the line.
    expect(DEV_SANDBOX_RANGE_RE.test("xx089999")).toBe(false);
    expect(DEV_SANDBOX_RANGE_RE.test("xx090000")).toBe(true);
  });
});

describe("generateDatasetId sandbox partition", () => {
  test("dev floor allocates from xx090001 on an empty DB", async () => {
    const db = realD1(freshDb());
    const id = await generateDatasetId(db, true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090001");
    expect(isDevRangeDatasetId(id)).toBe(true);
  });

  test("prod sandbox (no floor, ceiling 89999) still allocates low", async () => {
    const db = realD1(freshDb());
    const id = await generateDatasetId(db, true, { sandboxIdCeiling: 89999 });
    expect(id).toBe("xx000001");
    expect(isDevRangeDatasetId(id)).toBe(false);
  });

  test("dev floor skips pre-existing low (legacy) xx rows, no reuse below floor", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx000001", "xx000002"]); // legacy dev-era low ids
    const id = await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090001"); // does NOT gap-fill xx000003
  });

  test("gap-fills within the floored range", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx090001", "xx090003"]); // gap at 90002
    const id = await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090002");
  });

  test("advances past contiguous floored ids", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx090001", "xx090002"]);
    const id = await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090003");
  });

  test("throws with the effective range when a narrow band is exhausted", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx090001", "xx090002"]);
    await expect(
      generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001, sandboxIdCeiling: 90002 }),
    ).rejects.toThrow(/90001 to 90002/);
  });

  test("nm allocation ignores sandbox range opts", async () => {
    const db = realD1(freshDb());
    const id = await generateDatasetId(db, false, {
      sandboxIdFloor: 90001,
      sandboxIdCeiling: 90002,
    });
    expect(id).toBe("nm000108"); // START_NUMBER.nm, unaffected
  });

  test("bad/absent range strings do not corrupt allocation (clamped)", async () => {
    const db = realD1(freshDb());
    // Undefined bounds -> full xx range, starts at xx000001.
    const id = await generateDatasetId(db, true, {});
    expect(id).toBe("xx000001");
  });

  test("non-finite bounds are treated as absent at the function layer", async () => {
    // Pins the resolveRange guarantee independent of upload.ts's parseRangeBound:
    // NaN/Infinity floor must NOT disable the lower bound; it falls back to the
    // natural xx start (1), so allocation stays inside the valid id range.
    const db1 = realD1(freshDb());
    expect(await generateDatasetId(db1, true, { sandboxIdFloor: Number.NaN })).toBe("xx000001");
    const db2 = realD1(freshDb());
    expect(
      await generateDatasetId(db2, true, {
        sandboxIdFloor: Number.POSITIVE_INFINITY,
        sandboxIdCeiling: Number.NaN,
      }),
    ).toBe("xx000001");
  });
});

describe("isReservedFixtureId", () => {
  test("the boundary is exact for both reserving prefixes", () => {
    expect(isReservedFixtureId("nm099899")).toBe(false);
    expect(isReservedFixtureId("nm099900")).toBe(true);
    expect(isReservedFixtureId("nm099998")).toBe(true); // designated, built by #1434
    expect(isReservedFixtureId("nm099999")).toBe(true); // the e2e dataset
    expect(isReservedFixtureId("xx099899")).toBe(false);
    expect(isReservedFixtureId("xx099900")).toBe(true); // the exemplar fleet
  });

  test("on is not a reserving prefix: its ids are mirrored, never allocated", () => {
    expect(isReservedFixtureId("on099900")).toBe(false);
    expect(isReservedFixtureId("on099999")).toBe(false);
  });

  test("an invalid id is not reserved, whatever its digits", () => {
    expect(isReservedFixtureId("nm100000")).toBe(false); // over the validity cap
    expect(isReservedFixtureId("zz099900")).toBe(false);
    expect(isReservedFixtureId("nm99900")).toBe(false); // 5 digits
    expect(isReservedFixtureId("")).toBe(false);
  });

  test("reserved means not ALLOCATABLE, not invalid (ADR 0068)", () => {
    // Routes must still serve these ids; only generateDatasetId is bound.
    expect(isValidDatasetId("nm099998")).toBe(true);
    expect(isValidDatasetId("nm099999")).toBe(true);
    expect(isValidDatasetId("xx099907")).toBe(true);
  });

  test("the cleanup cron's boundary IS the allocator's boundary", () => {
    // DEV_EPHEMERAL_BAND_END is derived from RESERVED_FIXTURE_FLOOR. Pinned as a
    // literal here so the derivation cannot quietly change what the dev cleanup
    // cron is allowed to delete.
    expect(DEV_EPHEMERAL_BAND_END).toBe("xx099900");
    expect(RESERVED_FIXTURE_FLOOR).toBe(99900);
    expect(isDevEphemeralSandboxId("xx099899")).toBe(true);
    expect(isDevEphemeralSandboxId("xx099900")).toBe(false);
  });
});

describe("generateDatasetId reserved fixture band (ADR 0068)", () => {
  test("nm exhausts at 99899 rather than minting a fixture id", async () => {
    // The band is only crossed once everything below it is gone, so the test
    // seeds that state directly rather than approximating it: production holds
    // 197 rows in [108, 99899] and is nowhere near exhaustion. Before the
    // reservation this call returned nm099900.
    const raw = freshDb();
    seedRange(raw, "nm", 108, 99899);
    await expect(generateDatasetId(realD1(raw), false)).rejects.toThrow(/108 to 99899/);
  });

  test("the exhaustion error names the reservation, not just the ceiling", async () => {
    const raw = freshDb();
    seedRange(raw, "nm", 108, 99899);
    // An operator reading the log, or a dev/staging caller, told "all IDs from
    // 108 to 99899 are allocated" with no further explanation would reasonably
    // conclude the cap is a bug, since MAX_NUMBER is 99999. The clause is what
    // stops someone from "fixing" it. In production the message reaches the log
    // only: index.ts replaces err.message outside non-production.
    await expect(generateDatasetId(realD1(raw), false)).rejects.toThrow(
      /nm099900-nm099999 is the reserved fixture band/,
    );
  });

  test("nm still allocates normally one id below the band", async () => {
    const raw = freshDb();
    seedRange(raw, "nm", 108, 99898);
    expect(await generateDatasetId(realD1(raw), false)).toBe("nm099899");
  });

  test("xx with no ceiling stops below the exemplar fleet", async () => {
    // A narrow floor stands in for the live dev config (floor 90001, no
    // ceiling) so the boundary is reached without seeding 10k rows; the test
    // above does exercise the real floor. What matters in both is that no
    // ceiling is passed, which is the shape that used to run to xx099999.
    const raw = freshDb();
    seedRange(raw, "xx", 99898, 99899);
    await expect(generateDatasetId(realD1(raw), true, { sandboxIdFloor: 99898 })).rejects.toThrow(
      /xx099900-xx099999 is the reserved fixture band/,
    );
  });

  test("dev xx still allocates the last id below the fleet", async () => {
    const raw = freshDb();
    seedRange(raw, "xx", 99898, 99898);
    expect(await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 99898 })).toBe("xx099899");
  });

  test("an explicit ceiling inside the band cannot raise the cap", async () => {
    // resolveRange takes the MINIMUM of the caller's ceiling and the reserved
    // cap, so a caller cannot opt back into the band by asking for it.
    const raw = freshDb();
    seedRange(raw, "xx", 99898, 99899);
    await expect(
      generateDatasetId(realD1(raw), true, { sandboxIdFloor: 99898, sandboxIdCeiling: 99999 }),
    ).rejects.toThrow(/99898 to 99899/);
  });

  test("an existing fixture row does not drag allocation into the band", async () => {
    // nm099999 contributes candidate 100000 and nm099998 contributes 99999.
    // Seeding only those two and asserting nm000108 would prove nothing: the
    // start of the window is free, so it wins whatever the cap is. Everything
    // below the band is taken here, leaving exactly nm099899 and the band, so
    // the reservation is the only thing that can decide the answer.
    const raw = freshDb();
    seedRange(raw, "nm", 108, 99898);
    seedIds(raw, ["nm099998", "nm099999"]);
    const id = await generateDatasetId(realD1(raw), false);
    expect(id).toBe("nm099899");
    expect(isReservedFixtureId(id)).toBe(false);
  });

  test("the LIVE dev config refuses rather than reaching into the fleet", async () => {
    // SANDBOX_ID_FLOOR=90001 with NO ceiling, exactly as backend/wrangler-sccn.toml
    // sets it, against a full dev band. Three fleet ids are present and 99902-99999
    // are free, so before the reservation this call returned xx099902 -- a repo
    // name in the reserved band, in the GitHub org production shares.
    const raw = freshDb();
    seedRange(raw, "xx", 90001, 99899);
    seedIds(raw, ["xx099900", "xx099901", "xx099907"]);
    await expect(generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001 })).rejects.toThrow(
      /xx099900-xx099999 is the reserved fixture band/,
    );
  });
});

describe("reserved band: the gaps the first round of tests left", () => {
  test("a non-integer bound cannot mint a malformed id", async () => {
    // Bounds are rounded INWARD. Before that, a fractional floor reached
    // formatDatasetId, where (90001.5).toString() is already 7 characters and
    // padStart(6) does nothing, so the allocator returned "xx90001.5": not a
    // dataset id, invisible to every band predicate, and therefore unreachable
    // by both the prod webhook's staging guard and the dev cleanup cron.
    // Production is safe today only because upload.ts parses with
    // Number.parseInt, which truncates; that is one edit from Number().
    const db = realD1(freshDb());
    const id = await generateDatasetId(db, true, { sandboxIdFloor: 90001.5 });
    expect(isValidDatasetId(id)).toBe(true); // the load-bearing assertion
    expect(id).toBe("xx090002"); // narrowed up, never 90001.5
    expect(isDevEphemeralSandboxId(id)).toBe(true); // the cron can still reach it
  });

  test("a non-integer ceiling narrows down rather than up", async () => {
    const raw = freshDb();
    seedRange(raw, "xx", 90001, 90002);
    // floor(90002.9) = 90002, so the window is [90001, 90002] and exhausted.
    // Anchored on the word after the number: an unfloored ceiling still throws
    // here (90003 > 90002.9 is skipped either way), and only the rendered
    // message distinguishes the two, so /90001 to 90002/ alone would match
    // "90001 to 90002.9" as a substring and pin nothing.
    await expect(
      generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001, sandboxIdCeiling: 90002.9 }),
    ).rejects.toThrow(/from 90001 to 90002 are allocated/);
  });

  test("a floor inside the reserved band refuses rather than allocating", async () => {
    // resolveRange clamps the ceiling against the cap but deliberately does not
    // clamp the start, so the window inverts and nothing is allocatable. The
    // inverted message reads like a bug; the obvious "tidy-up" (raise max to
    // start) would mint xx099950, which is a fixture id. This pins the refusal
    // so that tidy-up fails loudly.
    await expect(
      generateDatasetId(realD1(freshDb()), true, { sandboxIdFloor: 99950 }),
    ).rejects.toThrow(/Failed to generate dataset ID/);
  });

  test("the exemplar route's band IS the allocator's reserved band", () => {
    // EXEMPLAR_ID_RE declares the same boundary independently, as a regex, and
    // three more copies exist in the CLI. The dangerous direction is raising
    // RESERVED_FIXTURE_FLOOR: the allocator would then mint xx099900 while the
    // exemplar route still accepts it as a fixture id, which is a repo-name
    // collision in the org production shares, i.e. exactly what ADR 0068 exists
    // to prevent. Cross-check rather than restate.
    for (let n = RESERVED_FIXTURE_FLOOR - 2; n <= 99999; n++) {
      const id = formatDatasetId("xx", n);
      expect(EXEMPLAR_ID_RE.test(id)).toBe(isReservedFixtureId(id));
    }
  });

  test("the fallback ceiling is the reserved cap, not MAX_NUMBER", async () => {
    // Four pre-existing tests in this file resolve the fallback ceiling and all
    // assert on the START of the window, so none of them can see it move. This
    // one reads the ceiling back out of the exhaustion message instead.
    const raw = freshDb();
    seedRange(raw, "xx", 1, 99899);
    await expect(generateDatasetId(realD1(raw), true)).rejects.toThrow(/1 to 99899/);
  });

  test("the reserved clause is omitted when a lower ceiling is the real limit", async () => {
    // Prod xx caps at SANDBOX_ID_CEILING=89999. Blaming the reserved band there
    // would send an operator to the wrong constant.
    const raw = freshDb();
    seedRange(raw, "xx", 1, 89999);
    const err = await generateDatasetId(realD1(raw), true, { sandboxIdCeiling: 89999 }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/1 to 89999/);
    expect(err?.message).not.toMatch(/reserved fixture band/);
  });
});

describe("the declared ownership set cannot drift (#1440)", () => {
  // Every other guarantee in this design is a rule that holds for ids nobody
  // named. The ownership set is the one piece that is a LIST, so it is the one
  // piece where a member nobody thought to name can be wrong. These are the
  // properties that hold for any future edit, not for the members it has today.

  test("every member is a reserved fixture id", () => {
    // The failure this prevents: a typo that lands an ALLOCATABLE production id
    // in the set. "nm000998" for "nm099998" is one keystroke, and it would make
    // the production worker silently stop dispatching enrichment for a real
    // dataset AND let a non-production worker cascade-delete its shared
    // nemarDatasets repository -- the exact blast radius the deletion fence
    // exists to prevent.
    for (const id of DEV_OWNED_FIXTURE_IDS) {
      expect(isValidDatasetId(id)).toBe(true);
      expect(isReservedFixtureId(id)).toBe(true);
    }
  });

  test("no member is on the never-dev-owned list", () => {
    for (const id of NEVER_DEV_OWNED_IDS) {
      expect(DEV_OWNED_FIXTURE_IDS.has(id)).toBe(false);
      expect(isDevOwnedDatasetId(id)).toBe(false);
    }
  });

  test("the two lists are disjoint and the never-list is itself reserved", () => {
    // If nm099999 stopped being a reserved id, the never-list would be guarding
    // something the allocator could hand to a depositor, which is a different
    // bug wearing the same name.
    for (const id of NEVER_DEV_OWNED_IDS) {
      expect(isReservedFixtureId(id)).toBe(true);
    }
  });

  test("dev-owned is a strict superset of dev-range, by exactly the declared set", () => {
    // Pins the shape of the predicate rather than its current membership: no id
    // is dev-owned unless it is dev-range or declared.
    for (const id of ["xx090001", "xx099899", "xx099900", "xx099999"]) {
      expect(isDevOwnedDatasetId(id)).toBe(true);
    }
    for (const id of ["nm000104", "nm000108", "nm099899", "nm099999", "on008062", "xx000001"]) {
      expect(isDevOwnedDatasetId(id)).toBe(DEV_OWNED_FIXTURE_IDS.has(id));
      expect(isDevOwnedDatasetId(id)).toBe(false);
    }
  });
});

describe("the soak fixture is declared before it exists (ADR 0102)", () => {
  // nm099997 is where the publication review is exercised on the dev worker. It is declared
  // BEFORE the fixture is created, in the release that ships the review, because an undeclared
  // fixture is invisible to the dev worker and claimed by the production one.
  const SOAK_FIXTURE = "nm099997";

  test("is declared dev-owned, so the dev worker owns it and production does not", () => {
    expect(DEV_OWNED_FIXTURE_IDS.has(SOAK_FIXTURE)).toBe(true);
    expect(isDevOwnedDatasetId(SOAK_FIXTURE)).toBe(true);
  });

  test("is a reserved fixture id, so the allocator can never return it", () => {
    expect(isValidDatasetId(SOAK_FIXTURE)).toBe(true);
    expect(isReservedFixtureId(SOAK_FIXTURE)).toBe(true);
  });

  test("is neither the absent id nor the never-dev-owned one", () => {
    expect(SOAK_FIXTURE).not.toBe(ABSENT_DATASET_ID);
    expect(NEVER_DEV_OWNED_IDS.has(SOAK_FIXTURE)).toBe(false);
  });

  test("is assigned downward from nm099999 and nm099998, the order ADR 0068 sets", () => {
    // The next undeclared fixture id is the one after it, and stays refused until declared.
    expect(isDevOwnedDatasetId("nm099996")).toBe(false);
    expect(isReservedFixtureId("nm099996")).toBe(true);
  });
});

describe("the id a test may rely on being absent (#1434)", () => {
  test("is reserved, so the allocator can never return it", () => {
    // The property that makes it usable at all. Four live tests had picked
    // `nm099998` for this on the strength of "unlikely to be allocated", and
    // epic #1430 then allocated it as a standing fixture.
    expect(isReservedFixtureId(ABSENT_DATASET_ID)).toBe(true);
    expect(isValidDatasetId(ABSENT_DATASET_ID)).toBe(true);
  });

  test("is not dev-owned, so no explicit-id create can claim it either", () => {
    // `explicitDatasetIdGate` requires reserved AND declared dev-owned, so this
    // is the second half of "cannot become real". A future fixture that wants
    // this id has to add it here, which fails this test and sends them to the
    // four live tests that depend on its absence.
    expect(isDevOwnedDatasetId(ABSENT_DATASET_ID)).toBe(false);
    expect(DEV_OWNED_FIXTURE_IDS.has(ABSENT_DATASET_ID)).toBe(false);
  });

  test("is the FLOOR of the band, furthest from the next fixture assignment", () => {
    // Fixtures are assigned downward from nm099999 (ADR 0068), so the floor is
    // the last id a fixture would reach. Moving it to, say, nm099997 would put
    // the sentinel directly in the path of the next one.
    //
    // The literal, not `formatDatasetId("nm", RESERVED_FIXTURE_FLOOR)`: that is
    // the constant's own definition, so asserting it says only that `=` works.
    // Four live tests hard-code this id in their expectations, and pinning the
    // string is what makes a change to the floor fail HERE rather than there.
    expect(ABSENT_DATASET_ID).toBe("nm099900");
    expect(isReservedFixtureId(formatDatasetId("nm", RESERVED_FIXTURE_FLOOR - 1))).toBe(false);
  });
});
