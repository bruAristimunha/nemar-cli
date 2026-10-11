/**
 * The parts of the fleet annex-policy sweep that are pure (#1374).
 *
 * The tree entries and `.gitattributes` bodies here are copied from real imported
 * datasets (`on001810`, `on004446`), including DataLad's nested file, because the
 * shapes that matter -- a symlink for an annexed recording, a plain blob for one
 * upstream left in git, a rule set spread over two files -- are exactly what a
 * hand-written fixture gets wrong.
 */

import { describe, expect, test } from "bun:test";
import {
  type FleetTreeEntry,
  POINTER_SUSPECT_MAX_BYTES,
  classifyAnnexPolicy,
  gitattributesPaths,
  isAnnexPolicyInForce,
  labelAnnexPolicyState,
  mapWithConcurrency,
  parseAnnexConfigLog,
  selectAnnexPolicyTargets,
} from "../src/lib/fleet-annex-policy";
import { buildLargefilesExpression } from "../src/lib/git-annex/policy";

/** `on001810`'s root file, verbatim except for trimming to the rules that matter. */
const UPSTREAM_ROOT = `* annex.backend=SHA256E
**/.git* annex.largefiles=nothing
*.tsv text eol=lf annex.largefiles=largerthan=1mb
*.json text eol=lf annex.largefiles=largerthan=1mb
dataset_description.json annex.largefiles=nothing
README annex.largefiles=nothing
CHANGES annex.largefiles=nothing
`;

/** DataLad writes this into every dataset it creates. */
const DATALAD_NESTED = `config annex.largefiles=nothing
metadata/aggregate* annex.largefiles=nothing
metadata/objects/** annex.largefiles=(largerthan=20kb)
`;

const MOTION = "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv";

function state(overrides: Partial<Parameters<typeof classifyAnnexPolicy>[0]> = {}) {
  return classifyAnnexPolicy({
    datasetId: "on001810",
    entries: [],
    treeTruncated: false,
    attributeContents: new Map(),
    configLog: null,
    ...overrides,
  });
}

describe("parseAnnexConfigLog", () => {
  test("reads the value in force, newest record wins", () => {
    const log = [
      "1750000000s annex.largefiles largerthan=1mb",
      "1789332452s annex.largefiles (include=*.edf) and exclude=*.tsv",
      "1789332452s annex.autoenable true",
      "",
    ].join("\n");
    const config = parseAnnexConfigLog(log);
    expect(config.get("annex.largefiles")).toBe("(include=*.edf) and exclude=*.tsv");
    expect(config.get("annex.autoenable")).toBe("true");
  });

  test("an unset key reads as absent, not as an empty expression", () => {
    // git-annex records an unset by appending the key with no value, so the newest
    // record for it is blank. Treating that as "configured" would report a
    // repository with no policy as governed.
    const log = [
      "1750000000s annex.largefiles largerthan=1mb",
      "1789332452s annex.largefiles",
    ].join("\n");
    expect(parseAnnexConfigLog(log).has("annex.largefiles")).toBe(false);
  });

  test("ignores lines that are not records", () => {
    expect(parseAnnexConfigLog("not a record\n\n").size).toBe(0);
  });
});

describe("classifyAnnexPolicy", () => {
  test("counts the removable rules per file and keeps the plumbing line", () => {
    const result = state({
      attributeContents: new Map([
        [".gitattributes", UPSTREAM_ROOT],
        [".datalad/.gitattributes", DATALAD_NESTED],
      ]),
    });
    expect(result.attributeFiles.map((f) => f.path)).toEqual([
      ".datalad/.gitattributes",
      ".gitattributes",
    ]);
    // Root: five rules, minus the `**/.git*` line that is kept on purpose.
    expect(result.attributeFiles[1].rulesRemoved).toBe(5);
    // Nested: DataLad's three, none of which is a plumbing pattern.
    expect(result.attributeFiles[0].rulesRemoved).toBe(3);
  });

  test("a file with nothing to remove is not reported at all", () => {
    // What an `nm` dataset carries, and what a fixed imported one looks like.
    const result = state({
      attributeContents: new Map([[".gitattributes", "**/.git* annex.largefiles=nothing\n"]]),
    });
    expect(result.attributeFiles).toEqual([]);
  });

  test("a quoted line is reported even though it is not rewritten", () => {
    // The strip declines it rather than cutting a quoted pattern in half, and a
    // sweep that dropped it from the report would call the dataset compliant.
    const result = state({
      attributeContents: new Map([
        [".gitattributes", '"sub 01/*.tsv" annex.largefiles=largerthan=1mb\n'],
      ]),
    });
    expect(result.attributeFiles).toHaveLength(1);
    expect(result.attributeFiles[0].rulesRemoved).toBe(0);
    expect(result.attributeFiles[0].declined[0]).toContain("sub 01");
  });

  test("only the current expression counts as configured", () => {
    // Every `nm` dataset has AN expression; the ones written before `*_motion.tsv`
    // joined the policy would still put a motion recording in git.
    const stale =
      "(include=*.edf or include=*.bdf or largerthan=100kb) and exclude=*.tsv and exclude=*.json";
    expect(state({ configLog: `1750000000s annex.largefiles ${stale}` }).policyConfigured).toBe(
      false,
    );
    expect(
      state({ configLog: `1750000000s annex.largefiles ${buildLargefilesExpression()}` })
        .policyConfigured,
    ).toBe(true);
  });

  test("the largerthan=100kb spelling every earlier dataset carries is still configured", () => {
    // Verbatim what `configureLargefiles` wrote before the threshold was rendered in
    // exact bytes (ADR 0031, amendment of 2026-10-07). git-annex reads `100kb` as
    // 100,000 bytes, the rule the new spelling states, so reading these datasets as
    // drifted would have the sweep clone the whole fleet to rewrite one config line.
    // test/annex-policy.test.ts proves the two annex the same files at the boundary.
    const legacy =
      "(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or include=*_motion.tsv or largerthan=100kb) and (exclude=*.tsv or include=*_motion.tsv) and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore";
    expect(state({ configLog: `1750000000s annex.largefiles ${legacy}` }).policyConfigured).toBe(
      true,
    );
    // A different threshold under the same unit is a different rule, not a spelling.
    const other = legacy.replace("largerthan=100kb", "largerthan=1mb");
    expect(state({ configLog: `1750000000s annex.largefiles ${other}` }).policyConfigured).toBe(
      false,
    );
  });

  test("a symlink is annexed content; a plain blob of the same path is not", () => {
    const entries: FleetTreeEntry[] = [
      { path: MOTION, mode: "120000", size: 132 },
      {
        path: "sub-02/motion/sub-02_task-walk_tracksys-imu_motion.tsv",
        mode: "100644",
        size: 300_000,
      },
      {
        path: "sub-02/motion/sub-02_task-walk_tracksys-imu_channels.tsv",
        mode: "100644",
        size: 200_000,
      },
      { path: "dataset_description.json", mode: "100644", size: 412 },
      { path: "derivatives/report.pdf", mode: "100644", size: 231_733 },
    ];
    const result = state({ entries });
    expect(result.gitResidentData.map((f) => f.path)).toEqual([
      "sub-02/motion/sub-02_task-walk_tracksys-imu_motion.tsv",
      // Over the size threshold and not metadata by extension: data under NEMAR
      // policy wherever it sits in the tree.
      "derivatives/report.pdf",
    ]);
  });

  test("a blob too small to be a recording is a suspected pointer, not data", () => {
    // An unlocked annexed file is a plain blob holding one line of text. Counting it
    // as data would have the sweep report work that does not exist; the clone the fix
    // makes asks git-annex and is the authority.
    const result = state({
      entries: [{ path: MOTION, mode: "100644", size: POINTER_SUSPECT_MAX_BYTES }],
    });
    expect(result.gitResidentData).toEqual([]);
    expect(result.pointerSuspects).toEqual([MOTION]);
  });

  test("carries the truncation flag through, because it bounds the data count", () => {
    expect(state({ treeTruncated: true }).treeTruncated).toBe(true);
  });
});

describe("labelAnnexPolicyState", () => {
  test("names the four states a sweep has to act on differently", () => {
    const base = state();
    expect(labelAnnexPolicyState({ ...base, policyConfigured: true })).toBe("compliant");
    expect(labelAnnexPolicyState({ ...base, policyConfigured: false })).toBe("policy");
    expect(
      labelAnnexPolicyState({
        ...base,
        policyConfigured: true,
        gitResidentData: [{ path: MOTION, size: 300_000 }],
      }),
    ).toBe("data");
    expect(
      labelAnnexPolicyState({
        ...base,
        policyConfigured: false,
        gitResidentData: [{ path: MOTION, size: 300_000 }],
      }),
    ).toBe("policy-and-data");
  });
});

describe("isAnnexPolicyInForce", () => {
  test("a quoted line nothing will rewrite still counts as in force", () => {
    // Otherwise such a dataset reports as a failed push forever: the strip declines
    // the line by design, so no number of re-runs clears the finding. It is a hand
    // fix, and the run says which file.
    const declinedOnly = state({
      attributeContents: new Map([
        [".gitattributes", '"sub 01/*.tsv" annex.largefiles=largerthan=1mb\n'],
      ]),
      configLog: `1750000000s annex.largefiles ${buildLargefilesExpression()}`,
    });
    expect(declinedOnly.attributeFiles).toHaveLength(1);
    expect(isAnnexPolicyInForce(declinedOnly)).toBe(true);
  });

  test("a removable rule left standing is not in force", () => {
    const pending = state({
      attributeContents: new Map([[".gitattributes", UPSTREAM_ROOT]]),
      configLog: `1750000000s annex.largefiles ${buildLargefilesExpression()}`,
    });
    expect(isAnnexPolicyInForce(pending)).toBe(false);
  });

  test("clean attributes with no expression configured is not in force either", () => {
    expect(isAnnexPolicyInForce(state())).toBe(false);
  });
});

describe("gitattributesPaths", () => {
  test("finds the root and nested files and nothing that merely looks like one", () => {
    const entries: FleetTreeEntry[] = [
      { path: ".gitattributes", mode: "100644" },
      { path: "derivatives/.gitattributes", mode: "100644" },
      { path: ".datalad/.gitattributes", mode: "100644" },
      { path: "docs/my.gitattributes.md", mode: "100644" },
      { path: "sub-01/data.tsv", mode: "100644" },
    ];
    expect(gitattributesPaths(entries)).toEqual([
      ".datalad/.gitattributes",
      ".gitattributes",
      "derivatives/.gitattributes",
    ]);
  });
});

describe("selectAnnexPolicyTargets", () => {
  const fleet = [
    { dataset_id: "on000002" },
    { dataset_id: "on000001" },
    { dataset_id: "nm000103" },
    { dataset_id: "nm000281" },
    { dataset_id: "xx099901" },
  ];

  test("imported datasets by default, sorted", () => {
    expect(selectAnnexPolicyTargets(fleet, {})).toEqual(["on000001", "on000002"]);
  });

  test("another prefix on request, with the live datasets held back", () => {
    const live = new Set(["nm000103"]);
    expect(selectAnnexPolicyTargets(fleet, { prefix: "nm", exclude: live })).toEqual(["nm000281"]);
    expect(selectAnnexPolicyTargets(fleet, { prefix: "nm", exclude: live, force: true })).toEqual([
      "nm000103",
      "nm000281",
    ]);
  });

  test("a limit takes the first n of the sorted list, so batches do not overlap", () => {
    expect(selectAnnexPolicyTargets(fleet, { limit: 1 })).toEqual(["on000001"]);
  });
});

describe("mapWithConcurrency", () => {
  test("keeps input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 1, 20, 2], 4, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(out).toEqual([30, 1, 20, 2]);
  });

  test("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  test("an empty list runs nothing and returns nothing", async () => {
    let calls = 0;
    expect(
      await mapWithConcurrency([], 4, async () => {
        calls++;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });
});
