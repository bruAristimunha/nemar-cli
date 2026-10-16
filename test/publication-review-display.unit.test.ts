/**
 * What `nemar admin publish` decides from a list row and prints for a review, as the pure
 * functions it is made of (ADR 0102, section 8).
 *
 * The queue predicates (`needsAdministrator`, `startAllCandidates`) are the two places the CLI
 * could decide something the Worker did not say: which requests are an administrator's to act on,
 * and which `start --all` would spend a model call on. They are tested over every status and every
 * reason code, because a rule that holds for the cases somebody thought of is the failure mode.
 * The rendering functions are tested with hostile text fed straight in: the spawned-CLI suite goes
 * through the real Worker, which has already reduced the model's words to plain ones, so it would
 * pass with every `plain()` call of the CLI deleted.
 *
 * Mutation checks (each turns a named test red): drop the pending-screen wait of `needsAdministrator`;
 * drop `plain()` from `screenViewLines`.
 */

import { describe, expect, test } from "bun:test";
import { evidenceFor, failingReport } from "../backend/test/helpers/publication-review";
import type {
  PublicationReviewDetail,
  PublicationReviewRecord,
} from "../shared/contract/publication-review-admin";
import {
  type PublicationReviewEvidence,
  REASON_CODES,
  type ReasonCode,
  describePublicationReview,
  parsePublicationReviewEvidence,
  parsePublicationReviewReport,
  reasonsOf,
} from "../shared/publication-review";
import {
  approveEvidenceLines,
  evidenceLine,
  historyLines,
  reviewDetailLines,
  reviewListLine,
  screenViewLines,
  shownLine,
  startedSentence,
  withheldLine,
} from "../src/lib/publication-review-display";
import {
  byOldestFirst,
  needsAdministrator,
  startAllCandidates,
} from "../src/lib/publication-review-queue";
import { row, summary } from "./helpers/review-fixtures";

/** The reasons that mean "wait for the platform"; nothing an administrator can do about them. */
const WAITS: readonly ReasonCode[] = ["review_running", "identifier_screen_pending"];

describe("needsAdministrator", () => {
  test("a requested request is the administrator's, whatever the outcome", () => {
    expect(needsAdministrator(row())).toBe(true);
    expect(
      needsAdministrator(
        row({ publication_review: summary({ outcome: "pass", reasons: [], tone: "ok" }) }),
      ),
    ).toBe(true);
    expect(
      needsAdministrator(
        row({ publication_review: summary({ outcome: "fail", reasons: ["question_failed"] }) }),
      ),
    ).toBe(true);
  });

  test("blocked, published and denied are not: the depositor acts, or nothing is left to do", () => {
    for (const status of ["blocked", "published", "denied"]) {
      expect(needsAdministrator(row({ status }))).toBe(false);
    }
  });

  test("an approving request is the administrator's unless an approval is running", () => {
    expect(needsAdministrator(row({ status: "approving" }))).toBe(true);
    expect(needsAdministrator(row({ status: "approving", approval_in_flight: true }))).toBe(false);
  });

  test("a request with an approval in flight is not, whatever its review says", () => {
    expect(needsAdministrator(row({ approval_in_flight: true }))).toBe(false);
    expect(
      needsAdministrator(
        row({
          approval_in_flight: true,
          publication_review: summary({ outcome: "pass", reasons: [], tone: "ok" }),
        }),
      ),
    ).toBe(false);
  });

  test("a request that is only waiting is not: every reason a wait", () => {
    expect(
      needsAdministrator(row({ publication_review: summary({ reasons: ["review_running"] }) })),
    ).toBe(false);
    expect(
      needsAdministrator(
        row({ publication_review: summary({ reasons: ["identifier_screen_pending"] }) }),
      ),
    ).toBe(false);
    expect(
      needsAdministrator(
        row({
          publication_review: summary({ reasons: ["identifier_screen_pending", "review_running"] }),
        }),
      ),
    ).toBe(false);
  });

  // The review is off in production today: its summary has no reason at all, so the screen's own
  // state is the only word that a request is still waiting for the platform.
  const SCREEN_PENDING = {
    state: "pending",
    headline: "Identifier screen: RUNNING",
    tone: "note" as const,
    lines: [],
  };
  const OFF = () =>
    summary({ kind: "off", enabled: false, outcome: null, reasons: [], gate: "off" });

  test("a request whose identifier screen is still running is only waiting, whatever the review says", () => {
    // The review is off (no reasons): the screen is the wait.
    expect(
      needsAdministrator(row({ identifier_screen: SCREEN_PENDING, publication_review: OFF() })),
    ).toBe(false);
    // No summary at all (an older backend) but a row that says its screen is running.
    expect(
      needsAdministrator(row({ identifier_screen: SCREEN_PENDING, publication_review: undefined })),
    ).toBe(false);
    // The review is on and says something else: the screen still has to report first.
    expect(
      needsAdministrator(
        row({
          identifier_screen: SCREEN_PENDING,
          publication_review: summary({ reasons: ["question_failed"] }),
        }),
      ),
    ).toBe(false);
  });

  test("a screen that reported, did not run or is not on the row does not make a request wait", () => {
    for (const state of [
      "clean",
      "dates-only",
      "review",
      "direct-identifiers",
      "error",
      "unreported",
    ]) {
      expect(
        needsAdministrator(
          row({ identifier_screen: { ...SCREEN_PENDING, state }, publication_review: OFF() }),
        ),
      ).toBe(true);
    }
    expect(
      needsAdministrator(
        row({ identifier_screen: { ...SCREEN_PENDING, state: null }, publication_review: OFF() }),
      ),
    ).toBe(true);
    expect(
      needsAdministrator(row({ identifier_screen: undefined, publication_review: OFF() })),
    ).toBe(true);
  });

  test("a screen that is running does not hide an approval that stopped, and an approving request is never only waiting", () => {
    expect(
      needsAdministrator(
        row({ status: "approving", identifier_screen: SCREEN_PENDING, publication_review: OFF() }),
      ),
    ).toBe(true);
  });

  test("a wait next to anything else is still the administrator's", () => {
    expect(
      needsAdministrator(
        row({ publication_review: summary({ reasons: ["review_running", "question_failed"] }) }),
      ),
    ).toBe(true);
  });

  // Walks the whole vocabulary: a reason a later phase adds is the administrator's unless someone
  // adds it to the waits on purpose, which this test then says out loud.
  test("over every reason code, exactly the two waits keep a requested request from the queue", () => {
    for (const code of REASON_CODES) {
      const row1 = row({ publication_review: summary({ reasons: [code] }) });
      expect(needsAdministrator(row1)).toBe(!WAITS.includes(code));
    }
  });

  test("a row with no reasons is assessed by its status alone, so a pass and an unreadable review count", () => {
    // `unreadable` is action_required with no reason: nobody can say it is only waiting.
    expect(
      needsAdministrator(row({ publication_review: summary({ kind: "unreadable", reasons: [] }) })),
    ).toBe(true);
    // Not assessed (the review is off): no reasons, the request still waits for a person.
    expect(
      needsAdministrator(
        row({
          publication_review: summary({ kind: "off", enabled: false, outcome: null, reasons: [] }),
        }),
      ),
    ).toBe(true);
  });

  test("a row from an older backend, with no summary and no in-flight field, is by its status", () => {
    const old = row();
    old.publication_review = undefined;
    old.approval_in_flight = undefined;
    expect(needsAdministrator(old)).toBe(true);
    expect(needsAdministrator({ ...old, status: "blocked" })).toBe(false);
    expect(needsAdministrator({ ...old, status: "approving" })).toBe(true);
    expect(needsAdministrator({ ...old, approval_in_flight: true })).toBe(false);
  });
});

describe("startAllCandidates", () => {
  test("is the requested rows whose summary offers a start", () => {
    const offered = row({ id: 1, publication_review: summary({ start_offered: true }) });
    const notOffered = row({ id: 2, publication_review: summary({ start_offered: false }) });
    expect(startAllCandidates([notOffered, offered]).map((r) => r.id)).toEqual([1]);
  });

  test("never decides from the reason codes: the summary's start_offered is the rule", () => {
    // Reasons whose cure is "start it", and the server says no (a reported review whose report no
    // longer parses reads review_could_not_run and the route refuses has_result).
    const notOffered = row({
      id: 1,
      publication_review: summary({ reasons: ["review_not_started"], start_offered: false }),
    });
    // No reason at all, and the server says yes.
    const offered = row({
      id: 2,
      publication_review: summary({ reasons: [], outcome: "pass", start_offered: true }),
    });
    expect(startAllCandidates([notOffered, offered]).map((r) => r.id)).toEqual([2]);
  });

  test("a row that is not requested is never a candidate, whatever its summary says", () => {
    for (const status of ["approving", "blocked", "published", "denied"]) {
      expect(
        startAllCandidates([row({ status, publication_review: summary({ start_offered: true }) })]),
      ).toEqual([]);
    }
  });

  test("a row from an older backend has no offer and is not a candidate", () => {
    const old = row();
    old.publication_review = undefined;
    expect(startAllCandidates([old])).toEqual([]);
  });

  test("answers oldest first, which is not the order the Worker lists them in", () => {
    const offered = summary({ start_offered: true });
    const newest = row({ id: 3, requested_at: "2026-10-12 09:14:03", publication_review: offered });
    const middle = row({ id: 2, requested_at: "2026-10-11 16:02:10", publication_review: offered });
    const oldest = row({ id: 1, requested_at: "2026-10-10 08:00:00", publication_review: offered });
    expect(startAllCandidates([newest, middle, oldest]).map((r) => r.id)).toEqual([1, 2, 3]);
    // The same second: the request that came first.
    const a = row({ id: 5, requested_at: "2026-10-10 08:00:00", publication_review: offered });
    const b = row({ id: 4, requested_at: "2026-10-10 08:00:00", publication_review: offered });
    expect(startAllCandidates([a, b]).map((r) => r.id)).toEqual([4, 5]);
  });
});

describe("byOldestFirst", () => {
  test("orders by request time then id, and leaves its input alone", () => {
    const rows = [
      row({ id: 3, requested_at: "2026-10-12 09:14:03" }),
      row({ id: 1, requested_at: "2026-10-10 08:00:00" }),
    ];
    expect(byOldestFirst(rows).map((r) => r.id)).toEqual([1, 3]);
    expect(rows.map((r) => r.id)).toEqual([3, 1]);
  });
});

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const ESC = String.fromCharCode(27);
/** Colour sequences, which are the CLI's own and not what a terminal must be protected from. */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const plainText = (line: string) => line.replace(ANSI, "");
/** Anything a terminal could act on: control, format (zero-width, bidi overrides), line and paragraph separators. */
const DANGEROUS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/**
 * An escape sequence that rewrites the screen, a bidirectional override, a zero-width space, a
 * line separator and a bell, written as escapes so the fixture is readable in a diff.
 */
const HOSTILE = `${ESC}[2J${ESC}]0;title\u0007x\u202ey\u200bz\u2028w`;

const evidenceOf = (over: Partial<PublicationReviewEvidence> = {}) =>
  parsePublicationReviewEvidence(evidenceFor(undefined, false, over));

describe("evidenceLine", () => {
  test("is the counts and closed words of the evidence, as one line", () => {
    expect(plainText(evidenceLine(evidenceOf({ version: "1.2.0" })))).toBe(
      "Evidence: version 1.2.0 (tag absent), BIDS pass, minimums met, 4 subjects, 0 sessions, 4 recordings (.edf 4), datatypes eeg, sampling rates 256 Hz, channel counts 32, sidecars read 4 of 4",
    );
  });

  test("a missing Version is the version an approval publishes, and says where it came from", () => {
    const line = evidenceLine(evidenceOf({ version: null, version_shape: "missing" }));
    expect(line).toContain("version 1.0.0 (dataset_description.json sets no Version; tag absent)");
  });

  test("a malformed Version has no version to name", () => {
    const line = evidenceLine(
      evidenceOf({ version: null, version_shape: "malformed", tag: "not_applicable" }),
    );
    expect(line).toContain("version malformed (X.Y.Z expected)");
    expect(line).not.toContain("tag");
  });

  test("names where the tag of the version is", () => {
    expect(evidenceLine(evidenceOf({ tag: "at_head" }))).toContain(
      "version 1.0.0 (tag at the reviewed commit)",
    );
    expect(evidenceLine(evidenceOf({ tag: "elsewhere" }))).toContain(
      "version 1.0.0 (tag at another commit)",
    );
  });

  test("a failed minimum names what failed, and a lone subject is not plural", () => {
    const base = evidenceFor();
    const raw = {
      ...base,
      minimums: "failed",
      minimum_failures: ["name_too_short"],
      summary: {
        ...(base.summary as object),
        subjects: 1,
        sessions: 1,
        recordings: 1,
        formats: { ".edf": 1 },
        sampling_rates_hz: [],
        channel_counts: [],
        datatypes: [],
      },
    };
    const line = evidenceLine(parsePublicationReviewEvidence(raw));
    expect(line).toContain("minimums failed (name_too_short)");
    expect(line).toContain("1 subject,");
    expect(line).toContain("1 session,");
    expect(line).toContain("1 recording (.edf 1)");
    expect(line).toContain("datatypes none");
    expect(line).not.toContain("sampling rates");
    expect(line).not.toContain("channel counts");
  });
});

describe("shownLine and withheldLine", () => {
  test("say what reached the model, document by document", () => {
    const e = evidenceOf({
      documents: {
        readme: "sent",
        dataset_description: "sent_cut",
        changes: "absent",
        license: "withheld_annexed",
        participants_json: "withheld_finding",
      },
      withheld_findings: { "edf-patient-name": 2 },
    });
    expect(shownLine(e)).toBe(
      "Shown to the model: README sent, dataset_description.json sent (cut) (9 keys shown, 1 not), CHANGES absent, LICENSE withheld (annexed), participants.json withheld (finding)",
    );
    expect(withheldLine(e)).toBe("Withheld for findings: edf-patient-name 2");
  });

  test("nothing withheld for a finding, nothing said", () => {
    expect(withheldLine(evidenceOf())).toBeNull();
  });
});

describe("approveEvidenceLines", () => {
  const review = (evidence: unknown) => ({ id: 1, evidence }) as unknown as PublicationReviewRecord;
  const POINTER =
    "The whole review, with the model's questions and findings: nemar admin publish show nm000480";
  const full = () =>
    evidenceOf({
      documents: {
        readme: "sent",
        dataset_description: "sent",
        changes: "absent",
        license: "withheld_annexed",
        participants_json: "withheld_finding",
      },
      withheld_findings: { "edf-patient-name": 2 },
    });

  test("what was shown, what was withheld for findings, then the pointer: the lines show prints, no more", () => {
    const e = full();
    expect(approveEvidenceLines(review(e), "nm000480")).toEqual([
      shownLine(e),
      withheldLine(e) as string,
      POINTER,
    ]);
    expect(approveEvidenceLines(review(e), "nm000480")[1]).toBe(
      "Withheld for findings: edf-patient-name 2",
    );
  });

  test("nothing withheld for a finding: the shown line and the pointer", () => {
    const e = evidenceOf();
    expect(approveEvidenceLines(review(e), "nm000480")).toEqual([shownLine(e), POINTER]);
  });

  test("no review, or a review with no evidence yet, has nothing to show", () => {
    expect(approveEvidenceLines(null, "nm000480")).toEqual([]);
    expect(approveEvidenceLines(undefined, "nm000480")).toEqual([]);
    expect(approveEvidenceLines(review(null), "nm000480")).toEqual([]);
    expect(approveEvidenceLines(review(undefined), "nm000480")).toEqual([]);
  });

  test("evidence this CLI cannot read is left out whole: no throw, no half a block, no pointer", () => {
    const good = evidenceFor(undefined, false, { withheld_findings: { "edf-patient-name": 2 } });
    const without = (key: string) => {
      const { [key]: _gone, ...rest } = good;
      return rest;
    };
    const documents = good.documents as Record<string, unknown>;
    const unreadable: Array<[string, unknown]> = [
      ["a string", "evidence"],
      ["a number", 7],
      ["an array", [good]],
      ["an empty object", {}],
      ["no documents", without("documents")],
      ["documents null", { ...good, documents: null }],
      ["documents a string", { ...good, documents: "sent" }],
      ["documents an array", { ...good, documents: ["sent"] }],
      ["a document missing", { ...good, documents: { ...documents, readme: undefined } }],
      ["a document state a number", { ...good, documents: { ...documents, readme: 3 } }],
      ["a document state null", { ...good, documents: { ...documents, license: null } }],
      ["the keys shown a string", { ...good, description_keys_shown: "9" }],
      ["the keys shown missing", without("description_keys_shown")],
      ["the keys not shown null", { ...good, description_keys_not_shown: null }],
      ["a finding count a string", { ...good, withheld_findings: { "edf-patient-name": "2" } }],
      ["findings a string", { ...good, withheld_findings: "edf-patient-name" }],
      ["findings an array", { ...good, withheld_findings: [2] }],
    ];
    for (const [what, evidence] of unreadable) {
      let lines: string[] = ["not run"];
      expect(() => {
        lines = approveEvidenceLines(review(evidence), "nm000480");
      }, what).not.toThrow();
      expect({ what, lines }).toEqual({ what, lines: [] });
    }
    // Findings that were never sent (null, or absent) are what `withheldLine` already reads as none.
    for (const evidence of [{ ...good, withheld_findings: null }, without("withheld_findings")]) {
      expect(approveEvidenceLines(review(evidence), "nm000480")).toHaveLength(2);
    }
  });

  test("the dataset id in the pointer is reduced to plain text", () => {
    const pointer = approveEvidenceLines(review(evidenceOf()), `nm000480${HOSTILE}`).at(-1) ?? "";
    expect(pointer).not.toMatch(DANGEROUS);
    expect(pointer).toContain("nemar admin publish show nm000480");
  });
});

describe("reviewListLine", () => {
  test("is the headline and the reason codes, indented under the request", () => {
    expect(
      plainText(
        reviewListLine(summary({ reasons: ["question_failed", "text_withheld"] }), 4) ?? "",
      ),
    ).toBe("    Publication review: action required  question_failed, text_withheld");
    expect(plainText(reviewListLine(summary({ reasons: [] }), 2) ?? "")).toBe(
      "  Publication review: action required",
    );
  });

  test("is nothing for a request that is not assessed, and for a row with no summary", () => {
    expect(reviewListLine(undefined)).toBeNull();
    for (const kind of ["off", "not_applicable", "not_reviewed"] as const) {
      expect(reviewListLine(summary({ kind, outcome: null, reasons: [] }))).toBeNull();
    }
    // Advice: a stored review of a Worker that has the review off has an outcome, and is shown.
    expect(
      reviewListLine(
        summary({ kind: "off", enabled: false, outcome: "fail", reasons: ["question_failed"] }),
      ),
    ).not.toBeNull();
  });

  test("passes the Worker's text through plain()", () => {
    const line = reviewListLine(
      summary({ headline: `Publication review: ${HOSTILE}`, reasons: [HOSTILE as ReasonCode] }),
    );
    expect(plainText(line ?? "")).not.toMatch(DANGEROUS);
  });
});

describe("screenViewLines", () => {
  const view = (over: Record<string, unknown> = {}) => ({
    state: "review",
    headline: "Identifier screen: needs review",
    tone: "warn" as const,
    lines: ["3 files hold an identifier-like word."],
    ...over,
  });

  test("is the headline and its lines, indented", () => {
    const lines = screenViewLines(view(), 4).map(plainText);
    expect(lines[0]).toBe("    Identifier screen: needs review");
    expect(lines[1]).toBe("      3 files hold an identifier-like word.");
  });

  test("passes the headline and every line through plain()", () => {
    const lines = screenViewLines(
      view({ headline: HOSTILE, lines: [HOSTILE, `a ${HOSTILE} b`] }),
      2,
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(plainText(line)).not.toMatch(DANGEROUS);
  });

  test("is nothing for a view an older backend did not send or one with no headline", () => {
    expect(screenViewLines(undefined, 4)).toEqual([]);
    expect(screenViewLines(view({ headline: undefined }), 4)).toEqual([]);
  });

  test("a view whose lines are not a list prints its headline alone", () => {
    expect(screenViewLines(view({ lines: "not a list" }), 0).map(plainText)).toEqual([
      "Identifier screen: needs review",
    ]);
  });
});

describe("startedSentence", () => {
  test("says started, started again, or that the run already stands", () => {
    expect(startedSentence("dispatched", "nm000480")).toBe("nm000480: review started.");
    expect(startedSentence("redispatched", "nm000480")).toBe("nm000480: review started again.");
    expect(startedSentence("dispatch_claimed", "nm000480")).toBe(
      "nm000480: a review of this commit was already handed over and stands.",
    );
  });

  test("a word a newer Worker invents is said as it is", () => {
    expect(startedSentence("queued", "nm000480")).toBe("nm000480: review started (queued).");
  });
});

describe("historyLines", () => {
  const entry = (id: number) => ({
    id,
    head_sha: "a".repeat(40),
    anonymous: false,
    state: "reported" as const,
    stored_verdict: "pass" as const,
    created_at: "2026-10-13 09:00:00",
    decided_at: "2026-10-13 09:05:00",
  });

  test("is nothing when the only review is the one in force", () => {
    expect(
      historyLines({
        history: [entry(1)],
        history_truncated: false,
        review: { id: 1 } as PublicationReviewRecord,
      }),
    ).toEqual([]);
    expect(historyLines({ history: [], history_truncated: false, review: null })).toEqual([]);
  });

  test("lists the reviews, marks the one in force and says when older ones are left out", () => {
    const lines = historyLines({
      history: [entry(2), entry(1)],
      history_truncated: true,
      review: { id: 2 } as PublicationReviewRecord,
    }).map(plainText);
    expect(lines[0]).toBe("History");
    expect(lines[1]).toContain("in force");
    expect(lines[2]).not.toContain("in force");
    expect(lines.at(-1)).toContain("older reviews not shown");
  });
});

describe("reviewDetailLines", () => {
  /** A detail built from the production parser and the production description, then made hostile. */
  function detailWith(text: string): PublicationReviewDetail {
    const report = parsePublicationReviewReport(failingReport());
    const reasons = reasonsOf({
      live: {
        request: { status: "requested", block_reason: null, anonymous: false },
        screen: {
          gate: "clear",
          head: report.evidence.head,
          acknowledged_by: null,
          head_current: null,
        },
        versions: {
          version_row_exists: false,
          prior_anonymous_request: false,
          first_published: false,
        },
        doi: { concept_doi_present: false, concept_ezid_status: null },
      },
      row: { kind: "reported", report, stored: "fail" },
    });
    const description = describePublicationReview({
      datasetId: "nm000480",
      applies: true,
      enabled: true,
      outcome: "fail",
      reasons,
      row: { kind: "reported", report, stored: "fail" },
      model: report.model,
      head: report.evidence.head,
      version: "1.0.0",
      startable: true,
    });
    const evidence = { ...report.evidence } as PublicationReviewEvidence;
    return {
      environment: "production",
      enabled: true,
      dataset_id: "nm000480",
      request_id: 7,
      request_status: "requested",
      anonymous: false,
      identifier_screen: {
        state: "clean",
        headline: `Identifier screen: ${text}`,
        tone: "ok",
        lines: [text],
      },
      screen_acknowledgment: { by: 3, at: text },
      block_reason: text,
      started_publishing: false,
      total_files: null,
      applies: true,
      gate: "enforced",
      outcome: "fail",
      reasons: [],
      description: {
        ...description,
        headline: `${description.headline} ${text}`,
        lines: [text, ...description.lines],
        summary: text,
        next: `nemar ${text}`,
      },
      review: {
        id: 9,
        head_sha: text,
        anonymous: false,
        state: "reported",
        detail: null,
        stored_verdict: "fail",
        model: "claude-haiku-5-5",
        version: "1.0.0",
        created_at: text,
        decided_at: null,
        started_by: null,
        override: { by: 3, at: text, reasons: [text as ReasonCode] },
        questions: {
          complete_and_honest: text as never,
          meets_standards: "pass",
          authors_and_license: "pass",
          name_adequate: "pass",
        },
        fact_notes: [{ question: "complete_and_honest", fact: text, result: "fail", text }],
        findings: [
          {
            question: "complete_and_honest",
            severity: text,
            code: text,
            document: text,
            note: text,
          },
        ],
        summary: text,
        evidence: {
          ...evidence,
          bids: text as never,
          minimums: "failed",
          minimum_failures: [text as never],
          summary: { ...evidence.summary, formats: { [text]: 1 }, datatypes: [text as never] },
          withheld_findings: { [text]: 1 } as never,
        },
      },
      history: [
        {
          id: 9,
          head_sha: text,
          anonymous: false,
          state: text as never,
          stored_verdict: text as never,
          created_at: text,
          decided_at: null,
        },
        {
          id: 8,
          head_sha: text,
          anonymous: false,
          state: "errored",
          stored_verdict: null,
          created_at: text,
          decided_at: null,
        },
      ],
      history_truncated: false,
    };
  }

  test("prints nothing a terminal could act on, whatever the Worker sent", () => {
    const lines = reviewDetailLines(detailWith(HOSTILE));
    expect(lines.length).toBeGreaterThan(20);
    for (const line of lines) expect(plainText(line)).not.toMatch(DANGEROUS);
    // The hostile text's visible part survives: it was cleaned, not dropped.
    expect(lines.map(plainText).join("\n")).toContain("xyzw");
  });

  test("prints the model's words under their labels and nowhere else", () => {
    const lines = reviewDetailLines(detailWith("steered words")).map(plainText);
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(
      lines[at("Summary (written by the model; the depositor's text can steer it):") + 1],
    ).toBe("    steered words");
    expect(
      at("Findings (written by the model; the depositor's text can steer them):"),
    ).toBeGreaterThan(-1);
    // The Worker's own sentences are not under a label: they are the platform's.
    expect(lines.filter((l) => l.includes("Summary (written by the model"))).toHaveLength(1);
  });

  test("a detail with no review prints the Worker's description and nothing of a review", () => {
    const d = detailWith("x");
    const lines = reviewDetailLines({ ...d, review: null, history: [] }).map(plainText);
    expect(lines.join("\n")).not.toContain("Questions:");
    expect(lines.join("\n")).not.toContain("Evidence:");
    expect(lines.at(-1)).toContain("Next:");
  });
});
