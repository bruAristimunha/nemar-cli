/**
 * Unit tests for the pure helpers in src/lib/withdrawn-datasets.ts (epic
 * #967 phase 4, #971). Mirrors test/exemplar-clone.test.ts's
 * parseExemplarFleet coverage.
 */

import { describe, expect, test } from "bun:test";
import { MIN_DATA_AVAILABILITY } from "../src/lib/s3-server-copy";
import {
  type WithdrawnDatasetEntry,
  parseWithdrawnDatasets,
  resolveWithdrawTargets,
  stillWithdrawn,
} from "../src/lib/withdrawn-datasets";

describe("parseWithdrawnDatasets", () => {
  const valid: unknown = [
    { dataset_id: "on004148", reason: "upstream_403", note: "blocked upstream" },
    { dataset_id: "on005279", reason: "no_source", note: "no source found" },
  ];

  test("accepts a well-formed entry array, and normalizes `withdrawn`", () => {
    // The field is optional on disk and REQUIRED in memory: an entry written
    // before it existed means "still down", and defaulting it here is what
    // stops every call site from having to remember an `!== false` convention.
    const parsed = parseWithdrawnDatasets(valid);
    expect(parsed).toEqual([
      { dataset_id: "on004148", reason: "upstream_403", note: "blocked upstream", withdrawn: true },
      { dataset_id: "on005279", reason: "no_source", note: "no source found", withdrawn: true },
    ]);
  });

  test("rejects a non-array payload", () => {
    expect(() => parseWithdrawnDatasets({ not: "an array" })).toThrow(/must be a JSON array/);
  });

  test("rejects a non-object entry", () => {
    expect(() => parseWithdrawnDatasets(["not an object"])).toThrow(/is not an object/);
  });

  test("rejects a malformed dataset_id", () => {
    const bad = [{ dataset_id: "ds007262", reason: "upstream_403", note: "x" }];
    expect(() => parseWithdrawnDatasets(bad)).toThrow(/is not valid/);
  });

  test("rejects a reason outside {upstream_403, no_source, recovered}", () => {
    const bad = [{ dataset_id: "on004148", reason: "dmca", note: "x" }];
    expect(() => parseWithdrawnDatasets(bad)).toThrow(/must be one of/);
  });

  test("rejects a missing/empty note", () => {
    const bad = [{ dataset_id: "on004148", reason: "upstream_403", note: "" }];
    expect(() => parseWithdrawnDatasets(bad)).toThrow(/note is required/);
  });

  test("the repo's checked-in withdrawn-datasets file parses and validates", async () => {
    const raw = await Bun.file(`${import.meta.dir}/../scripts/withdrawn-datasets.json`).json();
    const entries: WithdrawnDatasetEntry[] = parseWithdrawnDatasets(raw);

    // 11 unique ids total: the entry stays even after a dataset is reinstated,
    // because the list is the record of what was taken down.
    const ids = new Set(entries.map((e) => e.dataset_id));
    expect(ids.size).toBe(entries.length);
    expect(entries.length).toBe(11);

    // The filed split was 9 `upstream_403` and 2 `no_source`, and it was never
    // measured per dataset. #1396 tried every key against both routes OpenNeuro
    // publishes: six of the eleven were fetchable by the advertised route the
    // whole time they sat private with tombstoned DOIs. Those now read
    // `recovered`, and 5 are still genuinely refused upstream.
    const byReason = (reason: string) => entries.filter((e) => e.reason === reason);
    expect(byReason("upstream_403").length).toBe(5);
    expect(byReason("recovered").length).toBe(6);
    expect(byReason("no_source").length).toBe(0);

    expect(new Set(byReason("upstream_403").map((e) => e.dataset_id))).toEqual(
      new Set(["on008014", "on008017", "on008092", "on008099", "on008115"]),
    );
    expect(new Set(byReason("recovered").map((e) => e.dataset_id))).toEqual(
      new Set(["on004148", "on007816", "on007987", "on008065", "on005279", "on005516"]),
    );
  });

  test("every still-withdrawn entry is under the 90% availability threshold", async () => {
    // The two halves have to agree: an entry that is still down must be one the
    // policy would take down (ADR 0064), or the list and the rule disagree about
    // the same dataset.
    const raw = await Bun.file(`${import.meta.dir}/../scripts/withdrawn-datasets.json`).json();
    for (const entry of parseWithdrawnDatasets(raw)) {
      if (entry.withdrawn === false) continue;
      expect(entry.data_available).toBeDefined();
      expect(entry.data_available as number).toBeLessThan(MIN_DATA_AVAILABILITY);
    }
  });

  test("a reinstated entry records how much of its data is available", async () => {
    const raw = await Bun.file(`${import.meta.dir}/../scripts/withdrawn-datasets.json`).json();
    const reinstated = parseWithdrawnDatasets(raw).filter((e) => e.withdrawn === false);
    expect(reinstated.length).toBe(6);
    for (const entry of reinstated) {
      // Reinstated means it cleared the threshold, not necessarily that it is
      // whole: on005279 is at 97.6% because 30 anatomical images are gone.
      expect(entry.data_available as number).toBeGreaterThanOrEqual(MIN_DATA_AVAILABILITY);
    }
  });

  test("stillWithdrawn is what --all acts on, and it excludes the reinstated", async () => {
    const raw = await Bun.file(`${import.meta.dir}/../scripts/withdrawn-datasets.json`).json();
    const entries = parseWithdrawnDatasets(raw);
    const targets = stillWithdrawn(entries);
    expect(targets.length).toBe(5);
    expect(targets.every((e) => e.withdrawn !== false)).toBe(true);
    // The guard that matters: a dataset we restored must not be a withdraw target.
    expect(targets.map((e) => e.dataset_id)).not.toContain("on008065");
  });

  test("an entry with no `withdrawn` field counts as still withdrawn", () => {
    // Backward compatibility: the field is new, and absence must not silently
    // drop a dataset out of the target list. Parsed rather than hand-built, so
    // the default this depends on is the one production applies.
    const entries = parseWithdrawnDatasets([
      { dataset_id: "on004148", reason: "upstream_403", note: "filed before the field existed" },
    ]);
    expect(entries[0].withdrawn).toBe(true);
    expect(stillWithdrawn(entries)).toHaveLength(1);
  });

  test("refuses `recovered` on an entry that is still marked withdrawn", () => {
    // A contradiction the type permits: `recovered` says the content came back,
    // so the dataset cannot still be down. The converse is legitimate and is
    // deliberately not checked -- `upstream_403` with `withdrawn: false` is
    // "upstream fixed it".
    expect(() =>
      parseWithdrawnDatasets([
        { dataset_id: "on008065", reason: "recovered", note: "came back", withdrawn: true },
      ]),
    ).toThrow(/withdrawn must be false/);
    expect(() =>
      parseWithdrawnDatasets([
        {
          dataset_id: "on008065",
          reason: "upstream_403",
          note: "upstream fixed it",
          withdrawn: false,
        },
      ]),
    ).not.toThrow();
  });

  test("checks the key counts against each other and against data_available", () => {
    // Hand-edited numbers feeding a command that tombstones DOIs.
    const base = { dataset_id: "on008014", reason: "upstream_403" as const, note: "n" };
    expect(() => parseWithdrawnDatasets([{ ...base, data_keys_missing: 5 }])).toThrow(/together/);
    expect(() =>
      parseWithdrawnDatasets([{ ...base, data_keys_missing: 9, data_keys_total: 5 }]),
    ).toThrow(/not possible/);
    expect(() =>
      parseWithdrawnDatasets([
        { ...base, data_keys_missing: 37, data_keys_total: 171, data_available: 0.5 },
      ]),
    ).toThrow(/disagrees with/);
    // The real on008017 row: 134 of 171 available is 0.7836.
    expect(() =>
      parseWithdrawnDatasets([
        { ...base, data_keys_missing: 37, data_keys_total: 171, data_available: 0.7836 },
      ]),
    ).not.toThrow();
  });

  test("rejects a data_available outside 0..1", () => {
    const bad = [{ dataset_id: "on004148", reason: "recovered", note: "n", data_available: 1.5 }];
    expect(() => parseWithdrawnDatasets(bad)).toThrow(/between 0 and 1/);
  });
});

describe("resolveWithdrawTargets (not-on-list --force guard)", () => {
  const entries: WithdrawnDatasetEntry[] = [
    { dataset_id: "on004148", reason: "upstream_403", note: "blocked upstream", withdrawn: true },
    { dataset_id: "on005279", reason: "no_source", note: "no source found", withdrawn: true },
  ];

  test("an id on the list resolves to its own reason", () => {
    const result = resolveWithdrawTargets(["on004148"], entries, {});
    expect(result).toEqual({ targets: [{ datasetId: "on004148", reason: "upstream_403" }] });
  });

  test("an explicit --reason overrides the list entry's reason", () => {
    const result = resolveWithdrawTargets(["on004148"], entries, { reason: "dmca" });
    expect(result).toEqual({ targets: [{ datasetId: "on004148", reason: "dmca" }] });
  });

  test("an id NOT on the list is refused without --force", () => {
    const result = resolveWithdrawTargets(["nm000132"], entries, {});
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/not on the checked-in.*--force/);
  });

  test("an id NOT on the list is allowed with --force + an explicit --reason", () => {
    const result = resolveWithdrawTargets(["nm000132"], entries, {
      force: true,
      reason: "upstream_403",
    });
    expect(result).toEqual({ targets: [{ datasetId: "nm000132", reason: "upstream_403" }] });
  });

  test("--force alone without --reason still fails (no default to fall back to)", () => {
    const result = resolveWithdrawTargets(["nm000132"], entries, { force: true });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/no --reason given/);
  });

  test("multiple ids: the first failure short-circuits the rest", () => {
    const result = resolveWithdrawTargets(["on004148", "nm000132"], entries, {});
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("nm000132");
  });

  test("a REINSTATED entry is refused, though it is on the list", () => {
    // The gap the `withdrawn` field was added to close, on the path it was
    // never wired into. `--all` learned it via stillWithdrawn; an explicit id
    // goes through here, where the only guard asked whether the id is on the
    // list at all. A reinstated entry IS on the list -- it stays as the record
    // of a withdrawal that was reversed -- so `nemar admin repo withdraw on008065
    // --execute` would take a dataset this PR just proved whole, make it
    // private, tombstone its DOIs, and file the reason as "recovered".
    const reinstated: WithdrawnDatasetEntry[] = [
      ...entries,
      { dataset_id: "on008065", reason: "recovered", note: "came back", withdrawn: false },
    ];

    const result = resolveWithdrawTargets(["on008065"], reinstated, {});

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/reinstated.*--force/);
  });

  test("--force still withdraws a reinstated entry, for a deliberate re-take", () => {
    const reinstated: WithdrawnDatasetEntry[] = [
      { dataset_id: "on008065", reason: "recovered", note: "came back", withdrawn: false },
    ];

    const result = resolveWithdrawTargets(["on008065"], reinstated, {
      force: true,
      reason: "upstream_403",
    });

    expect(result).toEqual({ targets: [{ datasetId: "on008065", reason: "upstream_403" }] });
  });
});
