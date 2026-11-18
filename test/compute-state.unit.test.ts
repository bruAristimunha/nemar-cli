/**
 * The compute gateway's state machine and fixed words (epic #2005, phase A1 #2006; ADR 0118).
 *
 * The edge table is checked against an independent list written out here edge by edge, so a
 * change to the table must also change this test, and every other pair of the 10 x 10 is asserted
 * refused. That is what makes "the only edges a write may take" a tested sentence. The module is
 * pure and import-free; the test reads its source to hold it to that.
 *
 * The Tapis conditions below are copied from the `Job.condition` enum of Tapis's published Jobs
 * OpenAPI specification (read 2026-11-03). No response has been recorded from a real tenant yet,
 * so this is the published vocabulary, not an observation.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as words from "../shared/compute-state";
import {
  COMPUTE_ACCESS_REPORT_ERRORS,
  COMPUTE_ACCESS_REPORT_STATES,
  COMPUTE_CANCEL_REASONS,
  COMPUTE_FAILURE_CODES,
  COMPUTE_JOB_FLAGS,
  COMPUTE_KINDS,
  COMPUTE_LEDGER_REASONS,
  COMPUTE_REFUSAL_CODES,
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_ROUTE_SENTENCES,
  COMPUTE_SOURCES,
  COMPUTE_STATES,
  COMPUTE_TRANSITIONS,
  COMPUTE_WORD_RE,
  type ComputeState,
  LAUNCHER_DETAILS,
  LAUNCHER_FAILURE_CODES,
  LEDGER_ENTRY_KINDS,
  LIVE_COMPUTE_STATES,
  PLATFORM_FAILURE_CODES,
  PLATFORM_LAUNCHER_DETAILS,
  RECORDS_UNREADABLE,
  RESULT_REFUSAL_DETAILS,
  TAPIS_REPORTING_STATES,
  TERMINAL_COMPUTE_STATES,
  VERIFY_REASONS,
  canTransitionCompute,
  failureCodeFromTapisCondition,
  isPlatformFailure,
  isTerminalComputeState,
  launcherExitNumber,
  resultRefusalOf,
  stateFromTapisStatus,
} from "../shared/compute-state";

/** The edges, written out once more so the table cannot drift unseen. 53 of the 100 pairs. */
const EDGES: ReadonlyArray<readonly [ComputeState, ComputeState]> = [
  ["created", "created"],
  ["created", "uploading"],
  ["created", "submitted"],
  ["created", "queued"],
  ["created", "running"],
  ["created", "archiving"],
  ["created", "finished"],
  ["created", "failed"],
  ["created", "cancelled"],
  ["created", "unreported"],

  ["uploading", "uploading"],
  ["uploading", "submitted"],
  ["uploading", "queued"],
  ["uploading", "running"],
  ["uploading", "archiving"],
  ["uploading", "finished"],
  ["uploading", "failed"],
  ["uploading", "cancelled"],
  ["uploading", "unreported"],

  ["submitted", "submitted"],
  ["submitted", "queued"],
  ["submitted", "running"],
  ["submitted", "archiving"],
  ["submitted", "finished"],
  ["submitted", "failed"],
  ["submitted", "cancelled"],
  ["submitted", "unreported"],

  ["queued", "queued"],
  ["queued", "running"],
  ["queued", "archiving"],
  ["queued", "finished"],
  ["queued", "failed"],
  ["queued", "cancelled"],
  ["queued", "unreported"],

  ["running", "running"],
  ["running", "archiving"],
  ["running", "finished"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["running", "unreported"],

  ["archiving", "archiving"],
  ["archiving", "finished"],
  ["archiving", "failed"],
  ["archiving", "cancelled"],
  ["archiving", "unreported"],

  // `unreported` leaves to any state from `submitted` on, never back to `created` or `uploading`.
  ["unreported", "unreported"],
  ["unreported", "submitted"],
  ["unreported", "queued"],
  ["unreported", "running"],
  ["unreported", "archiving"],
  ["unreported", "finished"],
  ["unreported", "failed"],
  ["unreported", "cancelled"],
];

describe("the edges", () => {
  test("there are ten states and a hundred ordered pairs", () => {
    expect([...COMPUTE_STATES]).toEqual([
      "created",
      "uploading",
      "submitted",
      "queued",
      "running",
      "archiving",
      "finished",
      "failed",
      "cancelled",
      "unreported",
    ]);
    expect(new Set(COMPUTE_STATES).size).toBe(10);
  });

  test("every listed edge is allowed", () => {
    for (const [from, to] of EDGES) {
      expect(canTransitionCompute(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  test("every other pair of the hundred is refused", () => {
    const allowed = new Set(EDGES.map(([a, b]) => `${a}>${b}`));
    expect(allowed.size).toBe(EDGES.length);
    expect(EDGES.length).toBe(53);
    let refused = 0;
    for (const from of COMPUTE_STATES) {
      for (const to of COMPUTE_STATES) {
        if (allowed.has(`${from}>${to}`)) continue;
        expect(canTransitionCompute(from, to), `${from} -> ${to}`).toBe(false);
        refused++;
      }
    }
    expect(refused).toBe(100 - EDGES.length);
  });

  test("the table holds exactly the listed edges and no others", () => {
    const fromTable = new Set<string>();
    for (const from of COMPUTE_STATES) {
      for (const to of COMPUTE_TRANSITIONS[from]) fromTable.add(`${from}>${to}`);
    }
    expect(fromTable).toEqual(new Set(EDGES.map(([a, b]) => `${a}>${b}`)));
  });

  test("a terminal state has no edge out, not even to itself", () => {
    for (const s of TERMINAL_COMPUTE_STATES) {
      expect(COMPUTE_TRANSITIONS[s]).toEqual([]);
      expect(canTransitionCompute(s, s)).toBe(false);
    }
  });

  test("isTerminalComputeState is true for finished, failed and cancelled and for no other state", () => {
    const expected: Record<ComputeState, boolean> = {
      created: false,
      uploading: false,
      submitted: false,
      queued: false,
      running: false,
      archiving: false,
      finished: true,
      failed: true,
      cancelled: true,
      unreported: false,
    };
    expect(Object.keys(expected)).toHaveLength(10);
    for (const state of COMPUTE_STATES) {
      expect(isTerminalComputeState(state), state).toBe(expected[state]);
    }
  });

  test("terminal and live states split the ten, and unreported is live", () => {
    expect([...TERMINAL_COMPUTE_STATES]).toEqual(["finished", "failed", "cancelled"]);
    expect([...LIVE_COMPUTE_STATES].sort() as string[]).toEqual(
      ["created", "uploading", "submitted", "queued", "running", "archiving", "unreported"].sort(),
    );
    expect(LIVE_COMPUTE_STATES).toContain("unreported");
    const union = new Set([...LIVE_COMPUTE_STATES, ...TERMINAL_COMPUTE_STATES]);
    expect(union.size).toBe(10);
    expect(LIVE_COMPUTE_STATES.length + TERMINAL_COMPUTE_STATES.length).toBe(10);
  });

  test("every live state may repeat itself and may end failed or cancelled", () => {
    for (const s of LIVE_COMPUTE_STATES) {
      expect(canTransitionCompute(s, s)).toBe(true);
      expect(canTransitionCompute(s, "failed")).toBe(true);
      expect(canTransitionCompute(s, "cancelled")).toBe(true);
    }
  });

  test("unreported is reachable from every live state", () => {
    for (const s of LIVE_COMPUTE_STATES) expect(canTransitionCompute(s, "unreported")).toBe(true);
    for (const s of TERMINAL_COMPUTE_STATES) {
      expect(canTransitionCompute(s, "unreported")).toBe(false);
    }
  });

  test("no edge goes backwards along the happy path", () => {
    const path = [
      "created",
      "uploading",
      "submitted",
      "queued",
      "running",
      "archiving",
      "finished",
    ] as const;
    for (const [from, to] of EDGES) {
      const a = (path as readonly string[]).indexOf(from);
      const b = (path as readonly string[]).indexOf(to);
      if (a < 0 || b < 0) continue;
      expect(b, `${from} -> ${to}`).toBeGreaterThanOrEqual(a);
    }
  });

  test("a value that is not a state is refused, including names on Object.prototype", () => {
    for (const bad of ["bogus", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(canTransitionCompute(bad as ComputeState, "created")).toBe(false);
      expect(canTransitionCompute("created", bad as ComputeState)).toBe(false);
    }
  });
});

describe("Tapis statuses", () => {
  // The thirteen statuses of the published specification and the one state each maps to.
  const EXPECTED: ReadonlyArray<readonly [string, ComputeState]> = [
    ["PENDING", "submitted"],
    ["PROCESSING_INPUTS", "submitted"],
    ["STAGING_INPUTS", "submitted"],
    ["STAGING_JOB", "submitted"],
    ["SUBMITTING_JOB", "submitted"],
    ["BLOCKED", "submitted"],
    ["PAUSED", "submitted"],
    ["QUEUED", "queued"],
    ["RUNNING", "running"],
    ["ARCHIVING", "archiving"],
    ["FINISHED", "finished"],
    ["FAILED", "failed"],
    ["CANCELLED", "cancelled"],
  ];

  test("each of the thirteen maps to one state", () => {
    expect(EXPECTED).toHaveLength(13);
    expect(new Set(EXPECTED.map(([s]) => s)).size).toBe(13);
    for (const [status, expected] of EXPECTED) {
      expect(stateFromTapisStatus(status), status).toBe(expected);
    }
  });

  test("BLOCKED and PAUSED map to submitted", () => {
    expect(stateFromTapisStatus("BLOCKED")).toBe("submitted");
    expect(stateFromTapisStatus("PAUSED")).toBe("submitted");
  });

  test("an unknown status is null, never guessed", () => {
    for (const bad of [
      "",
      "running",
      "Running",
      "HIDDEN",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(stateFromTapisStatus(bad), bad).toBeNull();
    }
  });

  test("the module lists exactly the thirteen", () => {
    expect([...words.TAPIS_JOB_STATUSES].sort() as string[]).toEqual(
      EXPECTED.map(([s]) => s).sort(),
    );
  });

  test("a mapped state is never `created`, `uploading` or `unreported`", () => {
    for (const [status] of EXPECTED) {
      expect(["created", "uploading", "unreported"]).not.toContain(stateFromTapisStatus(status));
    }
  });
});

describe("fixed words", () => {
  test("COMPUTE_WORD_RE is lowercase letters, digits and underscore, 1 to 64", () => {
    for (const ok of ["a", "z9", "snake_case", "_", "0", "a".repeat(64)]) {
      expect(COMPUTE_WORD_RE.test(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "A",
      "kebab-case",
      "a b",
      " a",
      "a ",
      "a\n",
      "a.b",
      "é",
      "a".repeat(65),
    ]) {
      expect(COMPUTE_WORD_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("every word list the module exports matches COMPUTE_WORD_RE", () => {
    // Walk the module's exports so a list added later cannot skip the check. The Tapis statuses
    // are Tapis's own upper-case vocabulary and are not NEMAR words.
    const lists = Object.entries(words).filter(
      ([name, value]) =>
        name !== "TAPIS_JOB_STATUSES" &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((v) => typeof v === "string"),
    );
    expect(lists.length).toBeGreaterThanOrEqual(10);
    for (const [name, list] of lists) {
      for (const w of list as string[]) expect(COMPUTE_WORD_RE.test(w), `${name}: ${w}`).toBe(true);
    }
  });

  test("a word list has no duplicates", () => {
    for (const [name, value] of Object.entries(words)) {
      if (!Array.isArray(value)) continue;
      expect(new Set(value).size, name).toBe(value.length);
    }
  });

  test("the smaller vocabularies are exactly the ones the design names", () => {
    expect([...LEDGER_ENTRY_KINDS]).toEqual([
      "grant",
      "hold",
      "release",
      "charge",
      "refund",
      "adjust",
      "overrun",
      "expire",
    ]);
    expect([...COMPUTE_SOURCES]).toEqual(["cli", "web", "partner", "pipeline"]);
    expect([...COMPUTE_KINDS]).toEqual(["batch", "interactive"]);
    expect([...COMPUTE_JOB_FLAGS]).toEqual(["unreserved", "unattributed", "mismatch", "overrun"]);
    expect([...COMPUTE_CANCEL_REASONS]).toEqual([
      "user",
      "admin",
      "account_ended",
      "unreserved",
      "unattributed",
      "scheduler",
    ]);
    expect([...RESULT_REFUSAL_DETAILS]).toEqual([
      "results_too_large",
      "results_quota_exceeded",
      "too_many_outputs",
    ]);
  });
});

describe("refusal codes", () => {
  // Section 6's seven, then the rest in the order the phase issue lists them, each with the HTTP
  // status a route answers. The statuses are the module's to declare once (the phase issue names
  // the table, not its values); a route that disagrees with this table is the bug.
  const EXPECTED: ReadonlyArray<readonly [string, number]> = [
    ["no_compute_access", 403],
    ["suspended", 403],
    ["insufficient_balance", 409],
    ["over_job_limit", 422],
    ["over_concurrency", 409],
    ["platform_budget_exhausted", 409],
    ["client_cap_reached", 409],
    ["invalid_spec", 400],
    ["partition_not_offered", 422],
    ["runtime_unavailable", 422],
    ["registry_not_allowed", 422],
    ["compute_disabled", 503],
    ["dataset_not_eligible", 422],
    ["recipe_unknown", 422],
    ["pipelines_account_missing", 503],
    ["live_attempt_exists", 409],
    ["bundle_too_large", 413],
    ["bundle_too_many_files", 413],
    ["results_too_large", 413],
    ["results_quota_exceeded", 409],
    ["too_many_outputs", 413],
    ["results_expired", 410],
    ["job_not_found", 404],
    ["bad_state", 409],
    // Phase A2 (#2007): a hold the caller's own guard refused. It names no limit of its own
    // because the caller knows which guard it passed; the ledger answers it as one word.
    ["guard_refused", 409],
    // Phase A5 (#2010): the launcher called `complete` and an object it declared is missing or short.
    ["results_incomplete", 409],
    // Review fixes of 2026-11-06: a transient fault reading the owner's policy; not `compute_disabled`.
    ["policy_unavailable", 503],
    // Issue #2121, phase P2: NEMAR's tenant-wide ceiling on live jobs is full for the job's class.
    ["platform_busy", 409],
  ];

  test("the list is the seven of section 6 plus the seventeen the phase names, the ledger's one and the outputs route's, and the tenant ceiling's", () => {
    expect([...COMPUTE_REFUSAL_CODES] as string[]).toEqual(EXPECTED.map(([c]) => c));
    expect(COMPUTE_REFUSAL_CODES).toHaveLength(28);
    // The per-job limit refusal is `over_job_limit`; there is no second word for it.
    expect(COMPUTE_REFUSAL_CODES).not.toContain("over_ceiling");
  });

  test("every code has a status and the table has no stray key", () => {
    expect(Object.keys(COMPUTE_REFUSAL_STATUS).sort()).toEqual([...COMPUTE_REFUSAL_CODES].sort());
    for (const [code, status] of EXPECTED) {
      expect(
        COMPUTE_REFUSAL_STATUS[code as keyof typeof COMPUTE_REFUSAL_STATUS] as number,
        code,
      ).toBe(status);
    }
  });

  test("every status is a client or server error", () => {
    for (const status of Object.values(COMPUTE_REFUSAL_STATUS)) {
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  test("the three result refusal details are also refusal codes", () => {
    for (const d of RESULT_REFUSAL_DETAILS) expect(COMPUTE_REFUSAL_CODES).toContain(d);
  });
});

describe("ledger reasons", () => {
  test("the words the ledger writes of itself, each a valid word, once", () => {
    expect([...COMPUTE_LEDGER_REASONS]).toEqual([
      "admin_grant",
      "grant",
      "released",
      "refund",
      "expired",
      "final_settlement",
      "unreserved_usage",
    ]);
    expect(new Set(COMPUTE_LEDGER_REASONS).size).toBe(COMPUTE_LEDGER_REASONS.length);
    for (const w of COMPUTE_LEDGER_REASONS) expect(COMPUTE_WORD_RE.test(w), w).toBe(true);
  });
});

describe("the ACCESS report words (phase A8, #2013)", () => {
  test("the four states and the seven error words are exactly the ones the design names, each a valid word, once", () => {
    expect([...COMPUTE_ACCESS_REPORT_STATES]).toEqual(["pending", "attempting", "sent", "failed"]);
    expect([...COMPUTE_ACCESS_REPORT_ERRORS]).toEqual([
      "unconfigured",
      "no_submit_time",
      "no_gateway_user",
      "refused",
      "busy",
      "unavailable",
      "outcome_unknown",
    ]);
    for (const list of [COMPUTE_ACCESS_REPORT_STATES, COMPUTE_ACCESS_REPORT_ERRORS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const w of list) expect(COMPUTE_WORD_RE.test(w), w).toBe(true);
    }
  });
});

describe("failure codes", () => {
  test("COMPUTE_FAILURE_CODES is the launcher's seven then the platform's other ten, in order", () => {
    // Phase A5 checks a failure code read from launcher/result.json against this list.
    expect([...COMPUTE_FAILURE_CODES]).toEqual([
      "code_fetch_failed",
      "dataset_fetch_failed",
      "entry_not_found",
      "runtime_error",
      "out_of_memory",
      "time_limit",
      "result_upload_failed",
      "tapis_submit_failed",
      "submit_timeout",
      "staging_failed",
      "launch_failed",
      "archive_failed",
      "tapis_error",
      "result_verification_failed",
      "records_unavailable",
      "tapis_record_lost",
      "runner_lost",
    ]);
  });

  test("an exit number is only ever asked for a launcher code", () => {
    // Without the guard an unknown code gave 9 (index -1 plus 10) instead of failing.
    expect(() => launcherExitNumber("tapis_error" as never)).toThrow(RangeError);
    expect(() => launcherExitNumber("" as never)).toThrow(RangeError);
    expect(() => launcherExitNumber("constructor" as never)).toThrow(RangeError);
  });

  test("the launcher codes number seven, with exit numbers 10 to 16 in order", () => {
    expect([...LAUNCHER_FAILURE_CODES]).toEqual([
      "code_fetch_failed",
      "dataset_fetch_failed",
      "entry_not_found",
      "runtime_error",
      "out_of_memory",
      "time_limit",
      "result_upload_failed",
    ]);
    expect(LAUNCHER_FAILURE_CODES.map((c) => launcherExitNumber(c))).toEqual([
      10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(launcherExitNumber("code_fetch_failed")).toBe(10);
    expect(launcherExitNumber("result_upload_failed")).toBe(16);
  });

  test("the platform codes are the eleven the phase names, the one the review added and the runner's", () => {
    expect([...PLATFORM_FAILURE_CODES]).toEqual([
      "code_fetch_failed",
      "dataset_fetch_failed",
      "tapis_submit_failed",
      "submit_timeout",
      "staging_failed",
      "launch_failed",
      "archive_failed",
      "tapis_error",
      "result_verification_failed",
      "records_unavailable",
      "result_upload_failed",
      "tapis_record_lost",
      "runner_lost",
    ]);
  });

  test("the four user-caused launcher codes are not platform failures", () => {
    const userCaused = ["entry_not_found", "runtime_error", "out_of_memory", "time_limit"];
    for (const c of userCaused) {
      expect(isPlatformFailure(c), c).toBe(false);
      expect(isPlatformFailure(c, "results_too_large"), c).toBe(false);
    }
    // Exactly the launcher codes that are not on the platform list.
    expect(LAUNCHER_FAILURE_CODES.filter((c) => !isPlatformFailure(c)).sort() as string[]).toEqual(
      [...userCaused].sort(),
    );
  });

  test("every platform code is a platform failure", () => {
    for (const c of PLATFORM_FAILURE_CODES) expect(isPlatformFailure(c), c).toBe(true);
  });

  test("result_upload_failed is a platform failure unless its detail is a refusal detail", () => {
    expect(isPlatformFailure("result_upload_failed")).toBe(true);
    expect(isPlatformFailure("result_upload_failed", undefined)).toBe(true);
    expect(isPlatformFailure("result_upload_failed", null)).toBe(true);
    expect(isPlatformFailure("result_upload_failed", "")).toBe(true);
    expect(isPlatformFailure("result_upload_failed", "put_failed")).toBe(true);
    for (const d of RESULT_REFUSAL_DETAILS) {
      expect(isPlatformFailure("result_upload_failed", d), d).toBe(false);
    }
  });

  test("a refusal detail changes no platform code but result_upload_failed", () => {
    for (const c of PLATFORM_FAILURE_CODES) {
      if (c === "result_upload_failed") continue;
      for (const d of RESULT_REFUSAL_DETAILS)
        expect(isPlatformFailure(c, d), `${c} ${d}`).toBe(true);
    }
  });

  test("a word that is no failure code is not a platform failure", () => {
    for (const bad of ["", "nonsense", "constructor", "__proto__", "RESULT_UPLOAD_FAILED"]) {
      expect(isPlatformFailure(bad), bad).toBe(false);
    }
  });

  test("every RESULT_REFUSAL_DETAILS word is a valid word", () => {
    expect(RESULT_REFUSAL_DETAILS.length).toBe(3);
    for (const d of RESULT_REFUSAL_DETAILS) expect(COMPUTE_WORD_RE.test(d), d).toBe(true);
  });
});

describe("launcher details and who pays", () => {
  /**
   * Every fixed-word detail the launcher may carry with each of its seven codes, sorted into the
   * platform's (a NEMAR, node, runtime or contract fault, refunded) and the submitter's (charged),
   * written out here once more so a change to the module's lists must also change this table. The
   * rule behind the sorting: platform if and only if a submitter cannot cause it with a valid
   * specification and bundle.
   */
  const TABLE: Record<string, { platform: string[]; submitter: string[] }> = {
    code_fetch_failed: {
      platform: [
        "bad_response",
        "fetch_failed",
        "checksum_mismatch",
        "digest_mismatch",
        "size_mismatch",
        "content_missing",
        "disk_error",
      ],
      submitter: ["unsafe_archive", "archive_too_large"],
    },
    dataset_fetch_failed: {
      platform: [
        "dataset_not_found",
        "bad_manifest",
        "manifest_too_large",
        "unsafe_path",
        "bad_response",
        "fetch_failed",
        "checksum_mismatch",
        "size_mismatch",
        "content_missing",
        "file_not_found",
        "disk_error",
      ],
      submitter: ["bad_include", "too_many_files", "too_many_bytes"],
    },
    entry_not_found: { platform: [], submitter: [] },
    runtime_error: {
      platform: [
        "invalid_spec",
        "unsupported_runtime",
        "scratch_in_output",
        "scratch_unavailable",
        "no_container_runtime",
        "image_missing",
        "image_unverified",
        "runtime_unusable",
        "internal_error",
        "output_dir_not_empty",
        "bind_source_unsafe",
        "pid_namespace_unavailable",
      ],
      submitter: ["entry_failed", "terminated", "outputs_unreadable"],
    },
    out_of_memory: { platform: [], submitter: [] },
    time_limit: { platform: [], submitter: [] },
    result_upload_failed: {
      platform: [
        "bad_response",
        "fetch_failed",
        "incomplete_plan",
        "upload_failed",
        "outputs_refused",
        "complete_refused",
        "internal_error",
      ],
      submitter: [
        "results_too_large",
        "results_quota_exceeded",
        "too_many_outputs",
        "outputs_unreadable",
      ],
    },
  };
  const CODES = Object.keys(TABLE);
  const sorted = (list: readonly string[]) => [...list].sort();
  /** Every word the table names, once. */
  const ALL_WORDS = [
    ...new Set(CODES.flatMap((c) => [...TABLE[c].platform, ...TABLE[c].submitter])),
  ].sort();
  /** What a failure with no (or an undeclared) detail does: the code alone decides. */
  const BY_CODE_ALONE = (code: string) =>
    (PLATFORM_FAILURE_CODES as readonly string[]).includes(code);

  test("LAUNCHER_DETAILS names the seven launcher codes in order, each with its details", () => {
    expect(Object.keys(LAUNCHER_DETAILS)).toEqual([...LAUNCHER_FAILURE_CODES]);
    expect(Object.keys(LAUNCHER_DETAILS)).toEqual(CODES);
    for (const code of CODES) {
      const declared = (LAUNCHER_DETAILS as Record<string, readonly string[]>)[code];
      expect(sorted(declared), code).toEqual(
        sorted([...TABLE[code].platform, ...TABLE[code].submitter]),
      );
      expect(new Set(declared).size, `${code}: no word twice`).toBe(declared.length);
    }
  });

  test("three launcher codes carry no detail at all", () => {
    expect(LAUNCHER_DETAILS.entry_not_found).toEqual([]);
    expect(LAUNCHER_DETAILS.out_of_memory).toEqual([]);
    expect(LAUNCHER_DETAILS.time_limit).toEqual([]);
  });

  test("every declared detail is a fixed word", () => {
    for (const code of CODES) {
      for (const word of (LAUNCHER_DETAILS as Record<string, readonly string[]>)[code]) {
        expect(COMPUTE_WORD_RE.test(word), `${code}: ${word}`).toBe(true);
      }
    }
  });

  test("PLATFORM_LAUNCHER_DETAILS is exactly the platform words of the table", () => {
    const platform = CODES.flatMap((c) => TABLE[c].platform);
    expect(sorted(PLATFORM_LAUNCHER_DETAILS)).toEqual(sorted([...new Set(platform)]));
    expect(new Set(PLATFORM_LAUNCHER_DETAILS).size).toBe(PLATFORM_LAUNCHER_DETAILS.length);
  });

  test("no word is both the platform's and the submitter's, under any code", () => {
    const platform = new Set(CODES.flatMap((c) => TABLE[c].platform));
    const submitter = new Set(CODES.flatMap((c) => TABLE[c].submitter));
    for (const word of platform) expect(submitter.has(word), word).toBe(false);
    for (const word of PLATFORM_LAUNCHER_DETAILS) expect(submitter.has(word), word).toBe(false);
  });

  test("the result refusal details are declared for result_upload_failed, and are not the platform's", () => {
    for (const word of RESULT_REFUSAL_DETAILS) {
      expect(LAUNCHER_DETAILS.result_upload_failed as readonly string[], word).toContain(word);
      expect(PLATFORM_LAUNCHER_DETAILS as readonly string[], word).not.toContain(word);
    }
  });

  test("every word the design and the launcher name as the platform's is declared as such", () => {
    // The seven words and the rest of the list the driver settled for the launcher.
    for (const word of [
      "invalid_spec",
      "unsupported_runtime",
      "scratch_in_output",
      "scratch_unavailable",
      "no_container_runtime",
      "image_missing",
      "image_unverified",
      "runtime_unusable",
      "internal_error",
      "output_dir_not_empty",
      "bind_source_unsafe",
      "pid_namespace_unavailable",
      "content_missing",
      "dataset_not_found",
      "bad_response",
      "checksum_mismatch",
      "fetch_failed",
    ]) {
      expect(PLATFORM_LAUNCHER_DETAILS as readonly string[], word).toContain(word);
    }
    for (const word of [
      "unsafe_archive",
      "archive_too_large",
      "too_many_files",
      "too_many_bytes",
      "bad_include",
      "outputs_unreadable",
      "terminated",
      "entry_failed",
    ]) {
      expect(PLATFORM_LAUNCHER_DETAILS as readonly string[], word).not.toContain(word);
      expect(ALL_WORDS, word).toContain(word);
    }
  });

  test("a platform detail is a platform failure under the code that declares it, runtime_error included", () => {
    for (const code of CODES) {
      for (const word of TABLE[code].platform) {
        expect(isPlatformFailure(code, word), `${code} ${word}`).toBe(true);
      }
    }
  });

  test("a submitter detail is not a platform failure, even under code_fetch_failed or dataset_fetch_failed", () => {
    for (const code of CODES) {
      for (const word of TABLE[code].submitter) {
        expect(isPlatformFailure(code, word), `${code} ${word}`).toBe(false);
      }
    }
    expect(isPlatformFailure("code_fetch_failed", "unsafe_archive")).toBe(false);
    expect(isPlatformFailure("code_fetch_failed", "archive_too_large")).toBe(false);
    expect(isPlatformFailure("dataset_fetch_failed", "bad_include")).toBe(false);
    expect(isPlatformFailure("dataset_fetch_failed", "too_many_files")).toBe(false);
    expect(isPlatformFailure("dataset_fetch_failed", "too_many_bytes")).toBe(false);
    expect(isPlatformFailure("result_upload_failed", "outputs_unreadable")).toBe(false);
  });

  test("a missing or undeclared detail keeps the behaviour of the code alone", () => {
    for (const code of [...CODES, "tapis_error", "launch_failed", "nope"]) {
      for (const detail of [undefined, null, "", "made_up_word", "Not A Word", "http_500"]) {
        expect(isPlatformFailure(code, detail), `${code} ${JSON.stringify(detail)}`).toBe(
          BY_CODE_ALONE(code),
        );
      }
    }
    expect(isPlatformFailure("runtime_error")).toBe(false);
    expect(isPlatformFailure("runtime_error", "made_up_word")).toBe(false);
    expect(isPlatformFailure("code_fetch_failed", "http_500")).toBe(true);
    expect(isPlatformFailure("dataset_fetch_failed")).toBe(true);
    expect(isPlatformFailure("dataset_fetch_failed", "network_error")).toBe(true);
  });

  test("a detail declared under another code does not carry over: every (code, detail) pair", () => {
    // The whole cross product of the seven codes and every word any of them declares.
    for (const code of CODES) {
      for (const word of ALL_WORDS) {
        const isPlatform = TABLE[code].platform.includes(word);
        const isSubmitter = TABLE[code].submitter.includes(word);
        const expected = isPlatform ? true : isSubmitter ? false : BY_CODE_ALONE(code);
        expect(isPlatformFailure(code, word), `${code} ${word}`).toBe(expected);
      }
    }
    // A few of them, by name, so the reading is plain.
    expect(isPlatformFailure("entry_not_found", "invalid_spec")).toBe(false);
    expect(isPlatformFailure("out_of_memory", "image_missing")).toBe(false);
    expect(isPlatformFailure("time_limit", "internal_error")).toBe(false);
    expect(isPlatformFailure("runtime_error", "bad_response")).toBe(false);
    expect(isPlatformFailure("runtime_error", "dataset_not_found")).toBe(false);
    expect(isPlatformFailure("code_fetch_failed", "bad_include")).toBe(true);
    expect(isPlatformFailure("dataset_fetch_failed", "unsafe_archive")).toBe(true);
    expect(isPlatformFailure("code_fetch_failed", "results_too_large")).toBe(true);
  });

  test("the other platform codes are untouched by a launcher detail", () => {
    for (const code of PLATFORM_FAILURE_CODES) {
      if ((LAUNCHER_FAILURE_CODES as readonly string[]).includes(code)) continue;
      for (const word of ALL_WORDS)
        expect(isPlatformFailure(code, word), `${code} ${word}`).toBe(true);
    }
  });

  test("the records state the rules a charge decision rests on", () => {
    const adrPath = readdirSync(join(import.meta.dir, "..", ".context", "decisions")).find((f) =>
      f.startsWith("0118-"),
    );
    expect(adrPath).toBeDefined();
    const adr = readFileSync(
      join(import.meta.dir, "..", ".context", "decisions", adrPath as string),
      "utf8",
    );
    const notes = readFileSync(
      join(import.meta.dir, "..", ".context", "compute-program", "implementation-notes.md"),
      "utf8",
    );
    for (const [name, text] of [
      ["the ADR", adr],
      ["the notes", notes],
    ] as const) {
      // Who pays: the Worker's refusal, the cancel record, the default, the pair of pull requests.
      expect(text, name).toContain("dataset_not_eligible");
      // The gate that makes the classification true runs on the pipeline path only today (the reword of
      // the review of PR #2063): the records must say so, and that the person's route must call it.
      expect(text, name).toContain("38,000 entries");
      expect(text, name).toContain("pipeline path only");
      expect(text, name).toContain("#2024");
      expect(text, name).toContain("`dataset_not_found`");
      expect(text, name).toContain("cancel record overrules the launcher's `terminated` detail");
      expect(text, name).toContain("an undeclared `runtime_error` detail is deliberate");
      expect(text, name).toContain("same pair of pull requests");
      expect(text, name).toContain("drift test");
    }
    expect(adr).toContain("a dataset that was eligible when the job was submitted");
    expect(notes).toContain("a dataset eligible at submit");
    expect(notes).toContain("Known launcher limitations");
    expect(notes).toContain("`disk_error`");
    // A character class never matches /: the driver's settled answer, in both records.
    for (const [name, text] of [
      ["the ADR", adr],
      ["the notes", notes],
    ] as const) {
      expect(text, name).toContain("a character class never matches `/`");
      expect(text, name).toContain(
        "a negated class `[!a]` matches any single character except `a` and `/`",
      );
    }
    expect(adr).toContain("`includePatternProblem`");
    expect(notes).toContain("`includePatternProblem(pattern)`");
    expect(adr).toContain("`image.uri` ends with `@sha256:");
    expect(adr).toContain("`datasetVersionWithoutTag`");
    expect(notes).toContain("`datasetVersionWithoutTag(datasets)`");
  });

  test("a word that is not a launcher code is never looked up in the table", () => {
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty", "", "nope"]) {
      expect(isPlatformFailure(code, "internal_error"), code).toBe(false);
      expect(isPlatformFailure(code, "unsafe_archive"), code).toBe(false);
      expect(isPlatformFailure(code), code).toBe(false);
    }
  });
});

describe("Tapis conditions", () => {
  // The whole `Job.condition` enum of the published specification, each with the code it must
  // give. Written out here so a condition that moves from one code to another fails a test.
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ["CANCELLED_BY_USER", "tapis_error"],
    ["JOB_ARCHIVING_FAILED", "archive_failed"],
    ["JOB_DATABASE_ERROR", "tapis_error"],
    ["JOB_EXECUTION_MONITORING_ERROR", "tapis_error"],
    ["JOB_EXECUTION_MONITORING_ERROR_TIMEOUT", "tapis_error"],
    ["JOB_EXECUTION_MONITORING_TIMEOUT", "tapis_error"],
    ["JOB_FILES_SERVICE_ERROR", "staging_failed"],
    ["JOB_INTERNAL_ERROR", "tapis_error"],
    ["JOB_INVALID_DEFINITION", "launch_failed"],
    ["JOB_LAUNCH_FAILURE", "launch_failed"],
    ["JOB_QUEUE_MONITORING_ERROR", "tapis_error"],
    ["JOB_RECOVERY_FAILURE", "tapis_error"],
    ["JOB_RECOVERY_TIMEOUT", "tapis_error"],
    ["JOB_REMOTE_ACCESS_ERROR", "tapis_error"],
    ["JOB_REMOTE_OUTCOME_ERROR", "runtime_error"],
    ["JOB_UNABLE_TO_STAGE_INPUTS", "staging_failed"],
    ["JOB_UNABLE_TO_STAGE_JOB", "staging_failed"],
    ["JOB_TRANSFER_FAILED_OR_CANCELLED", "staging_failed"],
    ["JOB_TRANSFER_MONITORING_TIMEOUT", "staging_failed"],
    ["NORMAL_COMPLETION", "tapis_error"],
    ["SCHEDULER_CANCELLED", "tapis_error"],
    ["SCHEDULER_DEADLINE", "time_limit"],
    ["SCHEDULER_OUT_OF_MEMORY", "out_of_memory"],
    ["SCHEDULER_STOPPED", "tapis_error"],
    ["SCHEDULER_TIMEOUT", "time_limit"],
    ["SCHEDULER_TERMINATED", "tapis_error"],
  ];

  test("every condition of the Tapis enum, as transcribed above, maps to the code named beside it", () => {
    expect(EXPECTED).toHaveLength(26);
    for (const [condition, code] of EXPECTED) {
      expect(failureCodeFromTapisCondition(condition) as string, condition).toBe(code);
    }
  });

  test("the named conditions map to the named codes", () => {
    expect(failureCodeFromTapisCondition("SCHEDULER_TIMEOUT")).toBe("time_limit");
    expect(failureCodeFromTapisCondition("SCHEDULER_DEADLINE")).toBe("time_limit");
    expect(failureCodeFromTapisCondition("SCHEDULER_OUT_OF_MEMORY")).toBe("out_of_memory");
    expect(failureCodeFromTapisCondition("JOB_ARCHIVING_FAILED")).toBe("archive_failed");
    expect(failureCodeFromTapisCondition("JOB_REMOTE_OUTCOME_ERROR")).toBe("runtime_error");
  });

  test("anything else is tapis_error", () => {
    for (const other of [
      undefined,
      null,
      "",
      "NEW_CONDITION",
      "scheduler_timeout",
      "constructor",
    ]) {
      expect(failureCodeFromTapisCondition(other as string | null | undefined), String(other)).toBe(
        "tapis_error",
      );
    }
  });

  test("every code a condition gives is a known failure code", () => {
    const known = new Set<string>([...LAUNCHER_FAILURE_CODES, ...PLATFORM_FAILURE_CODES]);
    for (const [condition] of EXPECTED) {
      expect(known.has(failureCodeFromTapisCondition(condition)), condition).toBe(true);
    }
  });
});

// Round 1 of #2041: the words the Worker chooses for a job are declared once, here, and these are the
// literals a reader finds them by.
describe("the words the job routes and the lifecycle share", () => {
  test("the sixteen verification reasons, and the one more word for an unreadable record", () => {
    expect([...VERIFY_REASONS]).toEqual([
      "not_completed",
      "declared_missing",
      "result_missing",
      "provenance_missing",
      "manifest_missing",
      "job_id_mismatch",
      "launch_digest_mismatch",
      "bundle_digest_mismatch",
      "image_digest_mismatch",
      "result_reports_failure",
      "exit_mismatch",
      "output_missing",
      "output_size_mismatch",
      "output_checksum_mismatch",
      "manifest_mismatch",
      "launcher_file_missing",
    ]);
    expect(RECORDS_UNREADABLE).toBe("records_unreadable");
    for (const word of [...VERIFY_REASONS, RECORDS_UNREADABLE]) {
      expect(COMPUTE_WORD_RE.test(word), word).toBe(true);
    }
  });

  test("resultRefusalOf is the three refusal words and nothing else", () => {
    for (const word of RESULT_REFUSAL_DETAILS) expect(resultRefusalOf(word)).toBe(word);
    for (const other of [null, undefined, "", "output_missing", "TOO_MANY_OUTPUTS", "bad_state"]) {
      expect(resultRefusalOf(other as string | null | undefined), String(other)).toBeNull();
    }
  });

  test("a sentence for every refusal a job route answers with, a whole sentence each, and each code has a status", () => {
    expect(Object.keys(COMPUTE_ROUTE_SENTENCES).sort()).toEqual([
      "bad_state",
      "compute_disabled",
      "invalid_spec",
      "job_not_found",
      "policy_unavailable",
      "results_expired",
      "results_incomplete",
      "results_quota_exceeded",
      "results_too_large",
      "too_many_outputs",
    ]);
    for (const [code, sentence] of Object.entries(COMPUTE_ROUTE_SENTENCES)) {
      expect(sentence.endsWith("."), code).toBe(true);
      expect(sentence.includes("\u2014"), code).toBe(false);
      expect(Object.hasOwn(COMPUTE_REFUSAL_STATUS, code), code).toBe(true);
    }
    expect(COMPUTE_ROUTE_SENTENCES.job_not_found).toBe("No such job.");
  });

  test("the states a long silence can turn `unreported` are the live states that have a Tapis job and are not that state", () => {
    expect([...TAPIS_REPORTING_STATES]).toEqual(["submitted", "queued", "running", "archiving"]);
    for (const state of TAPIS_REPORTING_STATES) {
      expect(LIVE_COMPUTE_STATES.includes(state as never), state).toBe(true);
    }
  });
});

describe("the module imports nothing", () => {
  test("shared/compute-state.ts has no import, require or dynamic import", () => {
    const src = readFileSync(join(import.meta.dir, "../shared/compute-state.ts"), "utf8")
      // Comments may say the word; only code counts.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bfrom\s+["']/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    // A guard against a vacuous pass: the file is code, not an empty string.
    expect(src).toContain("COMPUTE_STATES");
  });
});
