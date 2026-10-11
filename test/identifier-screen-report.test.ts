/**
 * The screen report is the door through which a workflow's words reach the database, the admin
 * email and the status views. These tests hold the door: what a real report looks like passes,
 * and each way of smuggling a value through (a free-text key, a string where a count belongs, an
 * unknown field, a kind nobody declared) is refused with a fixed word that does not quote it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { DATE_KINDS, type FindingKind } from "../shared/identifier-scan";
import {
  DATASET_STATUSES,
  FINDING_KINDS,
  ReportError,
  SCREEN_ERRORS,
  type ScreenReport,
  type ScreenState,
  dateFindingCount,
  dateWarningLines,
  describeScreen,
  isDateWarningLine,
  isScreenState,
  parseScreenReport,
  publicationRequestNotice,
  screenGate,
  screenStateLabel,
  stateOf,
} from "../shared/identifier-screen-report";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function scan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "nm000186",
    version: null,
    scanned_at: "2026-10-05T12:00:00.000Z",
    manifest_source: "clone",
    status: "direct-identifiers",
    incomplete: false,
    incomplete_reasons: [],
    files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    sampling: {
      edf_headers: { candidates: 4, oversize: 0, selected: 4, scanned: 4 },
      scans_tables: { candidates: 0, oversize: 0, selected: 0, scanned: 0 },
      json_files: { candidates: 1, oversize: 0, selected: 1, scanned: 1 },
      text_files: { candidates: 0, oversize: 0, selected: 0, scanned: 0 },
    },
    read_failures: { "edf/http-403": 2 },
    edf_bdf_files_flagged: 4,
    distinct_patient_field_values: 4,
    distinct_subjects_with_edf_bdf: 4,
    findings_by_kind: { "edf-patient-name": 4, "acq-time-dated": 2 },
    edf_bdf_files_by_kind: { "edf-patient-name": 4 },
    unscreened_formats: { ".set": 3, ".ds/": 1, "(no extension)": 1 },
    side_reads_failed: 0,
    ...overrides,
  };
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: scan(),
    ...over,
  };
}

function refusal(input: unknown): string {
  try {
    parseScreenReport(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ReportError);
    return (error as ReportError).message;
  }
  throw new Error("accepted a report it should have refused");
}

describe("parseScreenReport: what passes", () => {
  test("a real-shaped scan report round-trips unchanged", () => {
    const input = report();
    expect(parseScreenReport(input)).toEqual(input as unknown as ScreenReport);
  });

  test("an error report carries a fixed word and no scan", () => {
    for (const error of SCREEN_ERRORS) {
      const parsed = parseScreenReport({
        version: 1,
        scanner: "identifier-scan@abcdef1",
        head: null,
        error,
      });
      expect(parsed.error).toBe(error);
      expect(stateOf(parsed)).toBe("error");
    }
  });

  test("an error report may have no scanner; a scan report may not", () => {
    expect(
      parseScreenReport({ version: 1, scanner: null, head: null, error: "workflow-failed" })
        .scanner,
    ).toBeNull();
    expect(refusal(report({ scanner: null }))).toBe("report-scanner");
  });

  test("every status the scanner can conclude is a state a report can carry", () => {
    // One coherent record per status: the parser refuses a status cleaner than its counts.
    const base = {
      findings_by_kind: {},
      edf_bdf_files_by_kind: {},
      edf_bdf_files_flagged: 0,
      unscreened_formats: {},
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    };
    const byStatus: Record<(typeof DATASET_STATUSES)[number], Record<string, unknown>> = {
      clean: {},
      "dates-only": { findings_by_kind: { "edf-startdate": 4 } },
      "no-recordings": { files: { total: 3, edf_bdf: 0, header_read: 0, header_read_failed: 0 } },
      "direct-identifiers": {
        findings_by_kind: { "edf-patient-name": 4 },
        edf_bdf_files_flagged: 4,
      },
      review: { findings_by_kind: { "tooling-debris": 1 } },
      unchecked: {
        incomplete: true,
        incomplete_reasons: ["edf-headers-unread"],
        files: { total: 10, edf_bdf: 4, header_read: 2, header_read_failed: 2 },
      },
      "not-screened": {
        unscreened_formats: { ".set": 2 },
        files: { total: 3, edf_bdf: 0, header_read: 0, header_read_failed: 0 },
      },
      "clean-edf-only-others-unscreened": { unscreened_formats: { ".set": 2 } },
    };
    for (const status of DATASET_STATUSES) {
      const parsed = parseScreenReport(
        report({ scan: scan({ ...base, status, ...byStatus[status] }) }),
      );
      expect(stateOf(parsed)).toBe(status);
    }
  });

  test("every finding kind is accepted as a key", () => {
    const kinds = Object.fromEntries(FINDING_KINDS.map((k) => [k, 1]));
    expect(
      parseScreenReport(report({ scan: scan({ findings_by_kind: kinds }) })).scan?.findings_by_kind,
    ).toEqual(kinds as never);
  });
});

describe("parseScreenReport: what is refused, without quoting it", () => {
  const LEAK = "JOHN-Q-SMITH 1971";

  test("an unknown key anywhere is refused", () => {
    expect(refusal(report({ patient: LEAK }))).toBe("report-key");
    expect(refusal(report({ scan: scan({ note: LEAK }) }))).toBe("scan-key");
    expect(
      refusal(
        report({
          scan: scan({
            files: { total: 1, edf_bdf: 1, header_read: 1, header_read_failed: 0, x: 1 },
          }),
        }),
      ),
    ).toBe("scan-files");
  });

  test("a key that is not a declared kind is refused", () => {
    expect(refusal(report({ scan: scan({ findings_by_kind: { [LEAK]: 1 } }) }))).toBe("scan-kinds");
    expect(refusal(report({ scan: scan({ edf_bdf_files_by_kind: { [LEAK]: 1 } }) }))).toBe(
      "scan-kinds",
    );
  });

  test("a string, a fraction or a negative where a count belongs is refused", () => {
    for (const bad of [LEAK, 1.5, -1, Number.NaN, null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        refusal(report({ scan: scan({ findings_by_kind: { "edf-patient-name": bad } }) })),
      ).toBe("scan-kinds");
      expect(refusal(report({ scan: scan({ edf_bdf_files_flagged: bad }) }))).toBe("scan-count");
    }
  });

  test("a format key must look like an extension, so a file name cannot ride in it", () => {
    for (const key of [
      LEAK,
      "john.smith.edf",
      "sub-01_task-rest.set",
      ".set .set",
      "/etc/passwd",
    ]) {
      expect(refusal(report({ scan: scan({ unscreened_formats: { [key]: 1 } }) }))).toBe(
        "scan-formats",
      );
    }
  });

  test("a reason and a failure key come from closed lists, not from a pattern", () => {
    // Lowercase and hyphenated, so a pattern would let every one of these through.
    for (const word of [
      LEAK.toLowerCase().replace(/ /g, "-"),
      "john-smith-1971",
      "edf-headers-unreadable",
    ]) {
      expect(refusal(report({ scan: scan({ incomplete_reasons: [word] }) }))).toBe("scan-reasons");
    }
    expect(refusal(report({ scan: scan({ incomplete_reasons: ["Has Space"] }) }))).toBe(
      "scan-reasons",
    );
    for (const key of [
      LEAK,
      "read/johnsmith",
      "edf/johnsmith",
      "johnsmith/internal",
      "edf/http-99",
      "edf/error-johnsmith",
    ]) {
      expect(refusal(report({ scan: scan({ read_failures: { [key]: 1 } }) }))).toBe(
        "scan-failures",
      );
    }
    // What the producers really emit still passes.
    const ok = parseScreenReport(
      report({
        scan: scan({
          incomplete_reasons: ["edf-headers-unread", "history-unread", "submodule-unread"],
          files: { total: 10, edf_bdf: 4, header_read: 3, header_read_failed: 1 },
          incomplete: true,
          read_failures: {
            "edf/http-403": 1,
            "json/error-rangeerror": 1,
            "edf/superseded-absent": 1,
            "scans/timeout": 1,
          },
        }),
      }),
    );
    expect(Object.keys(ok.scan?.read_failures ?? {}).length).toBe(4);
  });

  test("finding_fields is the fleet scan's field, not the report's", () => {
    expect(refusal(report({ scan: scan({ finding_fields: ["edf-patient-name:patient"] }) }))).toBe(
      "scan-key",
    );
  });

  test("a status cannot be cleaner than its own counts", () => {
    const clean = (over: Record<string, unknown>) =>
      scan({
        status: "clean",
        findings_by_kind: {},
        edf_bdf_files_by_kind: {},
        edf_bdf_files_flagged: 0,
        unscreened_formats: {},
        incomplete: false,
        incomplete_reasons: [],
        files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
        ...over,
      });
    expect(parseScreenReport(report({ scan: clean({}) })).scan?.status).toBe("clean");
    const lies: Record<string, unknown>[] = [
      { findings_by_kind: { "edf-patient-name": 3 } },
      { incomplete: true },
      { incomplete_reasons: ["json-unread"] },
      { files: { total: 10, edf_bdf: 4, header_read: 0, header_read_failed: 4 } },
      { unscreened_formats: { ".set": 2 } },
      { edf_bdf_files_flagged: 1 },
      { files: { total: 10, edf_bdf: 0, header_read: 0, header_read_failed: 0 } },
      { files: undefined },
    ];
    for (const lie of lies) {
      expect(refusal(report({ scan: clean(lie) }))).toBe("scan-status");
    }
    // dates-only may carry dates and nothing else; no-recordings needs no EDF and nothing unparsed.
    const dates = clean({ status: "dates-only", findings_by_kind: { "edf-startdate": 4 } });
    expect(parseScreenReport(report({ scan: dates })).scan?.status).toBe("dates-only");
    expect(
      refusal(
        report({
          scan: clean({ status: "dates-only", findings_by_kind: { "edf-patient-name": 1 } }),
        }),
      ),
    ).toBe("scan-status");
    expect(
      parseScreenReport(
        report({
          scan: clean({
            status: "no-recordings",
            files: { total: 3, edf_bdf: 0, header_read: 0, header_read_failed: 0 },
          }),
        }),
      ).scan?.status,
    ).toBe("no-recordings");
    expect(refusal(report({ scan: clean({ status: "no-recordings" }) }))).toBe("scan-status");
    // A scan that fell short cannot call itself finished, and cannot hide the shortfall in `incomplete`.
    expect(refusal(report({ scan: clean({ status: "unchecked" }) }))).toBe("scan-status");
    expect(
      refusal(
        report({
          scan: clean({
            status: "review",
            incomplete: false,
            incomplete_reasons: ["json-unread"],
          }),
        }),
      ),
    ).toBe("scan-status");
  });

  test("exactly one of scan and error", () => {
    expect(refusal(report({ error: "workflow-failed" }))).toBe("report-outcome");
    expect(refusal({ version: 1, scanner: "identifier-scan@abcdef1", head: null })).toBe(
      "report-outcome",
    );
    expect(
      refusal({ version: 1, scanner: "identifier-scan@abcdef1", head: null, error: LEAK }),
    ).toBe("report-error");
  });

  test("a scan of no commit cannot be matched to anything, so it is refused", () => {
    expect(refusal(report({ head: null }))).toBe("report-head");
    expect(refusal(report({ head: "abc123" }))).toBe("report-head");
  });

  test("the version, the scanner revision, the id and the time are checked", () => {
    expect(refusal(report({ version: 2 }))).toBe("report-version");
    expect(refusal(report({ scanner: LEAK }))).toBe("report-scanner");
    expect(refusal(report({ scan: scan({ id: LEAK }) }))).toBe("scan-id");
    expect(refusal(report({ scan: scan({ scanned_at: LEAK }) }))).toBe("scan-time");
    expect(refusal(report({ scan: scan({ status: LEAK }) }))).toBe("scan-status");
    expect(refusal(report({ scan: scan({ manifest_source: LEAK }) }))).toBe("scan-source");
  });

  test("a body that is not an object is refused", () => {
    for (const body of [null, undefined, "x", 3, [], [report()]]) {
      expect(refusal(body)).toBe("report-shape");
    }
  });

  test("no refusal message contains any part of the input", () => {
    const inputs = [
      report({ scan: scan({ findings_by_kind: { [LEAK]: 1 } }) }),
      report({ scan: scan({ unscreened_formats: { [LEAK]: 1 } }) }),
      report({ scan: scan({ incomplete_reasons: [LEAK] }) }),
      report({ scanner: LEAK }),
    ];
    for (const input of inputs) expect(refusal(input)).not.toContain("SMITH");
  });
});

describe("screenGate: unknown is never clear", () => {
  const expected: Record<ScreenState | "null", string> = {
    pending: "wait",
    clean: "clear",
    "dates-only": "clear",
    "no-recordings": "clear",
    "direct-identifiers": "blocks",
    review: "acknowledge",
    unchecked: "acknowledge",
    "not-screened": "acknowledge",
    "clean-edf-only-others-unscreened": "acknowledge",
    error: "rerun",
    unreported: "rerun",
    null: "rerun",
  };

  test("every state has the documented answer", () => {
    for (const [state, gate] of Object.entries(expected)) {
      expect(screenGate(state === "null" ? null : (state as ScreenState))).toBe(gate as never);
    }
  });

  test("a stored value that is not a state is not clear either", () => {
    for (const junk of ["", "CLEAN", "ok", "passed", "clean ", "0"]) {
      expect(isScreenState(junk)).toBe(false);
      expect(screenGate(junk as ScreenState)).toBe("rerun");
    }
  });

  test("only clean-class states are clear", () => {
    const clear = [...DATASET_STATUSES, "pending", "error", "unreported"].filter(
      (s) => screenGate(s as ScreenState) === "clear",
    );
    expect(clear.sort()).toEqual(["clean", "dates-only", "no-recordings"]);
  });
});

describe("describeScreen", () => {
  test("a screen that did not run says so in the headline and gives a cause", () => {
    const parsed = parseScreenReport({
      version: 1,
      scanner: "identifier-scan@abcdef1",
      head: null,
      error: "dispatch-failed",
    });
    const d = describeScreen("error", parsed);
    expect(d.headline).toContain("DID NOT RUN");
    expect(d.tone).toBe("stop");
    expect(d.lines.join(" ")).toContain("refused to start");
  });

  test("a screen that never reported is its own headline", () => {
    const d = describeScreen("unreported", null);
    expect(d.headline).toContain("DID NOT REPORT");
    expect(d.lines.join(" ")).toContain("no report arrived from the screen workflow in time");
  });

  test("an unreported screen stored with its error report states the cause once", () => {
    // The watchdog stores 'unreported' together with the `no-report-in-time`
    // report, so both the state and the report carry the same cause.
    const stored = parseScreenReport({
      version: 1,
      scanner: null,
      head: null,
      error: "no-report-in-time",
    });
    const d = describeScreen("unreported", stored);
    expect(d.headline).toContain("DID NOT REPORT");
    expect(d.lines.filter((l) => l.includes("no report arrived"))).toHaveLength(1);
  });

  test("a request with no screen is not described as clean", () => {
    const d = describeScreen(null, null);
    expect(d.tone).toBe("stop");
    expect(d.headline).toContain("NOT RUN");
  });

  test("a finding is described by kind and count, with the commit, and no value", () => {
    const parsed = parseScreenReport(report());
    const d = describeScreen("direct-identifiers", parsed);
    expect(d.tone).toBe("stop");
    const text = d.lines.join("\n");
    expect(text).toContain("edf-patient-name x4");
    expect(text).toContain(HEAD.slice(0, 12));
    expect(text).toContain("earlier commits");
    expect(text).toContain(".set x3");
  });

  test("every state has a headline, and only the clean ones are ok", () => {
    for (const state of [...DATASET_STATUSES, "pending", "error", "unreported"] as ScreenState[]) {
      const d = describeScreen(state, null);
      expect(d.headline.startsWith("Identifier screen:")).toBe(true);
      expect(d.tone === "ok").toBe(screenGate(state) === "clear");
    }
  });
});

// ---------------------------------------------------------------------------------------
// The acquisition-date warning (ADR 0090)
// ---------------------------------------------------------------------------------------

/** The warning exactly as ADR 0090 words it, for a count of `n`. */
const warningFor = (n: number, options: { atLeast?: boolean } = {}) => [
  `Warning: acquisition dates finer than year and month were found in recording headers or scans tables (${options.atLeast ? "at least " : ""}${n} ${n === 1 ? "entry" : "entries"}).`,
  ...FIXED_AFTER_THE_FIRST,
];

const FIXED_AFTER_THE_FIRST = [
  "NEMAR does not change them.",
  "A date can help identify a participant when it is combined with other information.",
  "Remove or coarsen any date that could identify someone before uploading or requesting publication.",
  "Administrators are told of these findings when publication is requested.",
];

/** The same warning for a verdict that says dates were found and a count that did not survive. */
const WARNING_WITHOUT_COUNT = [
  "Warning: acquisition dates finer than year and month were found in recording headers or scans tables.",
  ...FIXED_AFTER_THE_FIRST,
];

describe("dateFindingCount and dateWarningLines", () => {
  test("the sentence is pinned: five lines, one count, singular for one", () => {
    expect(dateWarningLines({ findings_by_kind: { "edf-startdate": 3 } })).toEqual(warningFor(3));
    expect(dateWarningLines({ findings_by_kind: { "acq-time-dated": 1 } })).toEqual(warningFor(1));
    expect(dateWarningLines({ findings_by_kind: { "edf-recording-startdate": 12 } })).toEqual(
      warningFor(12),
    );
  });

  test("the count is the sum over the three date kinds, and nothing else is added", () => {
    expect(
      dateWarningLines({
        findings_by_kind: {
          "edf-startdate": 2,
          "edf-recording-startdate": 3,
          "acq-time-dated": 4,
          "edf-patient-name": 50,
          "tooling-debris": 7,
        },
      })[0],
    ).toBe(warningFor(9)[0]);
    expect(dateFindingCount({ "edf-startdate": 2, "acq-time-dated": 4 })).toBe(6);
  });

  test("exactly the date kinds raise it: every kind the scanner can report is checked", () => {
    for (const kind of FINDING_KINDS) {
      const raised = dateWarningLines({ findings_by_kind: { [kind]: 1 } }).length > 0;
      expect(raised).toBe(DATE_KINDS.has(kind as FindingKind));
    }
    expect([...DATE_KINDS].sort()).toEqual([
      "acq-time-dated",
      "edf-recording-startdate",
      "edf-startdate",
    ]);
    // Text in a date slot that is not a date is a different kind, and does not warn.
    expect(dateWarningLines({ findings_by_kind: { "edf-startdate-unparsed": 5 } })).toEqual([]);
  });

  test("no date finding, no warning", () => {
    expect(dateWarningLines(undefined)).toEqual([]);
    expect(dateWarningLines({})).toEqual([]);
    expect(dateWarningLines({ findings_by_kind: {} })).toEqual([]);
    expect(dateWarningLines({ findings_by_kind: { "edf-startdate": 0 } })).toEqual([]);
    // Only the verdict `dates-only` stands in for a count.
    for (const status of DATASET_STATUSES.filter((x) => x !== "dates-only")) {
      expect(dateWarningLines({ status })).toEqual([]);
    }
    expect(dateFindingCount(undefined)).toBe(0);
  });

  test("an incomplete scan says its count is a lower bound", () => {
    expect(
      dateWarningLines({ findings_by_kind: { "edf-startdate": 3 }, incomplete: true }),
    ).toEqual(warningFor(3, { atLeast: true }));
    expect(
      dateWarningLines({ findings_by_kind: { "acq-time-dated": 1 }, incomplete: true })[0],
    ).toContain("(at least 1 entry)");
    for (const incomplete of [false, undefined]) {
      expect(dateWarningLines({ findings_by_kind: { "edf-startdate": 3 }, incomplete })).toEqual(
        warningFor(3),
      );
    }
  });

  test("a dates-only verdict warns even when the counts did not survive, without a count", () => {
    for (const input of [
      { status: "dates-only" as const },
      { status: "dates-only" as const, findings_by_kind: {} },
      { status: "dates-only" as const, findings_by_kind: { "edf-startdate": 0 } },
      { status: "dates-only" as const, incomplete: true },
    ]) {
      expect(dateWarningLines(input)).toEqual(WARNING_WITHOUT_COUNT);
    }
    // Counts, when there are any, still win: the verdict is not a second source of the number.
    expect(
      dateWarningLines({ status: "dates-only", findings_by_kind: { "edf-startdate": 2 } }),
    ).toEqual(warningFor(2));
    expect(WARNING_WITHOUT_COUNT.join("\n")).not.toMatch(/\d/);
  });

  test("a count that is not a non-negative integer is ignored, never added", () => {
    const hostile = {
      "edf-startdate": "SMITH 1985-03-15",
      "acq-time-dated": -4,
      "edf-recording-startdate": 2.5,
    } as unknown as Partial<Record<FindingKind, number>>;
    expect(dateFindingCount(hostile)).toBe(0);
    expect(dateWarningLines({ findings_by_kind: hostile })).toEqual([]);
    const mixed = { "edf-startdate": 2, "acq-time-dated": Number.NaN } as Partial<
      Record<FindingKind, number>
    >;
    expect(dateWarningLines({ findings_by_kind: mixed })).toEqual(warningFor(2));
  });

  test("the words carry no digit but the count, no path, no date and no value", () => {
    for (const n of [1, 7, 4096]) {
      const text = dateWarningLines({ findings_by_kind: { "edf-startdate": n } }).join("\n");
      const withoutCount = text.replace(`(${n} ${n === 1 ? "entry" : "entries"})`, "()");
      expect(withoutCount).not.toMatch(/\d/);
      expect(text).not.toMatch(/\d{4}-\d{2}|\d{2}\.\d{2}\.\d{2}/);
      expect(text).not.toMatch(/[\\/]|\.\.|sub-|\.edf|\.tsv|\.json/i);
      // The count is the only thing that varies: the other four lines are the same for every n.
      const lines = dateWarningLines({ findings_by_kind: { "edf-startdate": n } });
      expect(lines.slice(1)).toEqual(warningFor(1).slice(1));
      expect(lines[0]?.replace(/\(\d+ \w+\)/, "()")).toBe(
        warningFor(1)[0]?.replace("(1 entry)", "()"),
      );
    }
  });

  test("isDateWarningLine recognizes the warning's lines and no count or footer line", () => {
    for (const line of warningFor(5)) expect(isDateWarningLine(line)).toBe(true);
    for (const line of [...warningFor(5, { atLeast: true }), ...WARNING_WITHOUT_COUNT]) {
      expect(isDateWarningLine(line)).toBe(true);
    }
    for (const line of [
      "Findings by kind: edf-startdate x5.",
      "Files: 10; EDF/BDF headers read: 4 of 4.",
      "Not read: the contents of sidecars and tables in earlier commits.",
      "Warning: something else entirely.",
      "",
    ]) {
      expect(isDateWarningLine(line)).toBe(false);
    }
  });
});

describe("describeScreen carries the warning and changes nothing else", () => {
  const withKinds = (status: string, kinds: Record<string, number>, over = {}) =>
    parseScreenReport(
      report({
        scan: scan({
          status,
          findings_by_kind: kinds,
          edf_bdf_files_flagged: status === "direct-identifiers" ? 4 : 0,
          unscreened_formats: {},
          ...over,
        }),
      }),
    );

  test("dates only: still clean for the gate, the same headline and tone, plus the warning", () => {
    const dated = withKinds("dates-only", { "edf-startdate": 4 });
    const d = describeScreen("dates-only", dated);
    expect(d.headline).toBe("Identifier screen: clean (acquisition dates only)");
    expect(d.tone).toBe("ok");
    expect(screenGate("dates-only")).toBe("clear");
    expect(d.lines).toEqual(expect.arrayContaining(warningFor(4)));
    expect(d.lines).toContain("Findings by kind: edf-startdate x4.");
    // The warning sits with the counts, before the footers.
    expect(d.lines.indexOf(warningFor(4)[0])).toBeGreaterThan(
      d.lines.indexOf("Findings by kind: edf-startdate x4."),
    );
    expect(d.lines.indexOf(warningFor(4)[4])).toBeLessThan(
      d.lines.findIndex((l) => l.startsWith("Not read:")),
    );
  });

  test("dates beside a review finding or a direct one still warn, and the verdict is untouched", () => {
    const review = withKinds("review", { "tooling-debris": 1, "acq-time-dated": 2 });
    const direct = withKinds("direct-identifiers", {
      "edf-patient-name": 4,
      "edf-recording-startdate": 4,
    });
    expect(describeScreen("review", review).lines).toEqual(expect.arrayContaining(warningFor(2)));
    expect(describeScreen("review", review).headline).toBe("Identifier screen: needs review");
    expect(describeScreen("direct-identifiers", direct).lines).toEqual(
      expect.arrayContaining(warningFor(4)),
    );
    expect(describeScreen("direct-identifiers", direct).tone).toBe("stop");
  });

  test("an incomplete scan with dates warns too, and stays INCOMPLETE", () => {
    const unchecked = parseScreenReport(
      report({
        scan: scan({
          status: "unchecked",
          incomplete: true,
          incomplete_reasons: ["edf-headers-unread"],
          files: { total: 10, edf_bdf: 4, header_read: 3, header_read_failed: 1 },
          findings_by_kind: { "edf-startdate": 3 },
          edf_bdf_files_flagged: 0,
          unscreened_formats: {},
        }),
      }),
    );
    const d = describeScreen("unchecked", unchecked);
    expect(d.headline).toBe("Identifier screen: INCOMPLETE");
    expect(d.lines).toEqual(expect.arrayContaining(warningFor(3, { atLeast: true })));
  });

  test("a dates-only verdict whose report does not read back still warns, without a count", () => {
    // The stored report is gone or unreadable (null), or the counts were lost (none recorded):
    // the verdict column alone says a date was found, and silence here would be silent.
    const noCounts = parseScreenReport(
      report({
        scan: scan({
          status: "dates-only",
          findings_by_kind: undefined,
          edf_bdf_files_flagged: 0,
          unscreened_formats: {},
        }),
      }),
    );
    for (const stored of [null, noCounts]) {
      const d = describeScreen("dates-only", stored);
      expect(d.headline).toBe("Identifier screen: clean (acquisition dates only)");
      expect(d.tone).toBe("ok");
      expect(d.lines).toEqual(expect.arrayContaining(WARNING_WITHOUT_COUNT));
    }
  });

  test("no date finding, no warning, in any state", () => {
    const none = withKinds("review", { "tooling-debris": 1 });
    expect(describeScreen("review", none).lines.some(isDateWarningLine)).toBe(false);
    const clean = withKinds("clean", {});
    expect(describeScreen("clean", clean).lines.some(isDateWarningLine)).toBe(false);
    // With no report at all, only the verdict `dates-only` says a date was found.
    for (const state of [...DATASET_STATUSES, "pending", "error", "unreported"] as ScreenState[]) {
      expect(describeScreen(state, null).lines.some(isDateWarningLine)).toBe(
        state === "dates-only",
      );
    }
    const failed = parseScreenReport({
      version: 1,
      scanner: "identifier-scan@abcdef1",
      head: null,
      error: "deadline",
    });
    expect(describeScreen("error", failed).lines.some(isDateWarningLine)).toBe(false);
  });

  test("the report contract gained no field: a warning cannot be smuggled in as one", () => {
    for (const key of ["date_warning", "warnings", "warning"]) {
      expect(refusal(report({ scan: scan({ [key]: ["Warning: SMITH"] }) }))).toBe("scan-key");
    }
  });
});

describe("publicationRequestNotice: what an accepted request is told (ADR 0090)", () => {
  test("the wording is pinned, one sentence per line, and names the real status command", () => {
    expect(publicationRequestNotice("nm000321")).toEqual([
      "Your request was received.",
      "NEMAR is checking publication eligibility.",
      "If every check passes, an administrator is notified to approve it.",
      "You will be emailed if a check needs your attention, and when an administrator decides.",
      "Run 'nemar dataset publish status nm000321' to see where it stands.",
    ]);
    // The maintainer's paragraph, as one piece.
    expect(publicationRequestNotice("nm000321").join(" ")).toBe(
      "Your request was received. NEMAR is checking publication eligibility. If every check passes, an administrator is notified to approve it. You will be emailed if a check needs your attention, and when an administrator decides. Run 'nemar dataset publish status nm000321' to see where it stands.",
    );
  });

  test("the dataset id is the only thing that varies", () => {
    const a = publicationRequestNotice("nm000321");
    const b = publicationRequestNotice("xx099901");
    expect(b.slice(0, 4)).toEqual(a.slice(0, 4));
    expect(b[4]).toBe("Run 'nemar dataset publish status xx099901' to see where it stands.");
    expect(a.slice(0, 4).join(" ")).not.toMatch(/\d/);
  });

  test("it is neutral: no verdict, finding kind, count or date warning", () => {
    // What it says shares nothing with the words a screen is described in:
    // the screen has not reported when this is shown, and a verdict printed
    // now could be stale by the time anyone acts on it.
    const text = publicationRequestNotice("nm000321").join("\n");
    for (const state of [...DATASET_STATUSES, "pending", "error", "unreported"] as ScreenState[]) {
      expect(text).not.toContain(screenStateLabel(state));
    }
    for (const kind of FINDING_KINDS) expect(text).not.toContain(kind);
    for (const line of publicationRequestNotice("nm000321")) {
      expect(isDateWarningLine(line)).toBe(false);
    }
    expect(text).not.toMatch(
      /\b(warning|acquisition|dates?|findings?|found|clean|review|blocked)\b/i,
    );
  });

  test("no other source file spells the sentences: they are declared once", () => {
    // One distinctive phrase per sentence that makes a claim, so a copy that
    // rewords one of them is still found. The status pointer is built from the
    // command's name, which other files legitimately spell.
    const phrases = [
      /Your request was received/i,
      /publication eligibility/i,
      /If every check passes/i,
      /emailed if a check needs your attention/i,
      /to see where it stands/i,
    ];
    const root = join(import.meta.dir, "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          if (phrases.some((phrase) => phrase.test(text))) hits.push(relative(root, full));
        }
      }
    };
    for (const dir of ["src", "backend/src", "shared"]) walk(join(root, dir));
    expect(hits).toEqual(["shared/identifier-screen-report.ts"]);
  });
});
