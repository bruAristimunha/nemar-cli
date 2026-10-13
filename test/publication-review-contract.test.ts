/**
 * The publication review's contract (ADR 0102), and the shared pieces it stands on.
 *
 * Pure: no database and no network. Real parser, real reasons table, real renderer, driven with
 * the inputs a hostile job, a hostile depositor or a hostile model controls.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BIDS_DATATYPES } from "../backend/src/services/datacite";
import * as prompt from "../scripts/ci/pr-review-prompt";
import {
  PUBLICATION_REVIEW_ERROR_CODES,
  PUBLICATION_REVIEW_VIEW_KINDS,
  START_NOT_HANDED_OVER_REASONS,
  START_REASONS,
  START_REFUSED_REASONS,
  START_STARTED_REASONS,
} from "../shared/contract/publication-review-admin";
import { KNOWN_FORMATS, type ScreenGate } from "../shared/identifier-screen-report";
import * as prReview from "../shared/pr-review";
import {
  ANSWERS,
  type Answer,
  BIDS_STATES,
  CALIBRATION_MODELS,
  DEFAULT_PUBLICATION_VERSION,
  DEPOSITOR_DAILY_CAP,
  DESCRIPTION_KEYS_SHOWN,
  DOCUMENT_CHAR_CAPS,
  DOCUMENT_STATES,
  type DocumentState,
  HARD_REASONS,
  type LiveFacts,
  MAX_PUBLICATION_FINDINGS,
  NEVER_REACHED_MODEL,
  NOT_ASSESSED_LINE,
  PLATFORM_DAILY_CAP,
  PUBLICATION_DECLINE_DETAILS,
  PUBLICATION_FINDING_CODES,
  PUBLICATION_OUTCOMES,
  PUBLICATION_REPORT_ERRORS,
  PUBLICATION_REVIEW_DEADLINE_MINUTES,
  PUBLICATION_REVIEW_MODELS,
  PUBLICATION_REVIEW_STATES,
  PUBLICATION_RUN_ERRORS,
  PUBLICATION_SEVERITIES,
  type PublicationOutcome,
  type PublicationReviewReport,
  PublicationReviewReportError,
  QUESTIONS,
  QUESTION_FACTS,
  QUESTION_FACT_TEXT,
  QUESTION_NEEDS,
  type Question,
  REASONS,
  REASON_CODES,
  REVIEW_DATATYPES,
  REVIEW_DOCUMENTS,
  REVIEW_FORMATS,
  REVIEW_OVERDUE_VIEW_MINUTES,
  REVIEW_UNREADABLE_HEADLINE,
  type Reason,
  type ReasonCode,
  type ReviewRowView,
  START_CURE_REASONS,
  TAG_STATES,
  VERSION_SHAPES,
  WORKER_ONLY_RUN_ERRORS,
  answersOf,
  cureOf,
  describePublicationReview,
  describeUnreadableReview,
  effectiveVersionOf,
  isWithheld,
  parsePublicationCallbackOutcome,
  parsePublicationReviewEvidence,
  parsePublicationReviewReport,
  reasonLine,
  reasonsOf,
  reportReasons,
  stricterOf,
  verdictOf,
} from "../shared/publication-review";
import { README_CANDIDATES, firstReadme } from "../shared/readme-candidates";
import {
  MINIMUM_FAILURES,
  type MinimumFailure,
  evaluateSubmissionMinimums,
  minimumFailureSentence,
  submissionMinimumFailures,
} from "../shared/submission-minimums";
import * as untrusted from "../shared/untrusted-text";

/** A value no fixture text contains by accident; finding it in an output means it was quoted. */
const SENTINEL = "Zqxjvw Sentinelname";

describe("the text tools moved to shared/untrusted-text.ts", () => {
  test("the pull-request review re-exports the same sanitizer, not a copy", () => {
    expect(prReview.sanitizeNote).toBe(untrusted.sanitizeNote);
    expect(untrusted.DEFAULT_NOTE_MAX).toBe(prReview.NOTE_MAX);
  });

  test("the prompt module re-exports the same fence and tidy functions, not copies", () => {
    expect(prompt.fence).toBe(untrusted.fence);
    expect(prompt.tidy).toBe(untrusted.tidy);
    expect(prompt.tidyPath).toBe(untrusted.tidyPath);
  });
});

describe("the submission minimums as closed words", () => {
  const LONG_NAME = "A sufficiently descriptive title of a dataset";
  const descriptions: (string | null)[] = [null, "{not json", "[]", "null", '"a string"'];
  for (const name of [undefined, "Short", LONG_NAME]) {
    for (const authors of [
      undefined,
      [],
      ["", "  "],
      [SENTINEL],
      ["Anonymous"],
      ["n/a", SENTINEL],
      [42],
    ]) {
      for (const ethics of [undefined, [""], ["Approved by the board, ref 12"]]) {
        const desc: Record<string, unknown> = {};
        if (name !== undefined) desc.Name = name;
        if (authors !== undefined) desc.Authors = authors;
        if (ethics !== undefined) desc.EthicsApprovals = ethics;
        descriptions.push(JSON.stringify(desc));
      }
    }
  }
  const readmes = [null, "A README with no statement.", "Approved by the IRB of somewhere."];

  test("the words and the sentences agree in count and order, named and anonymous", () => {
    let cases = 0;
    for (const description of descriptions) {
      for (const readme of readmes) {
        for (const anonymousRelease of [false, true]) {
          cases++;
          const words = submissionMinimumFailures(description, readme, { anonymousRelease });
          const sentences = evaluateSubmissionMinimums(description, readme, { anonymousRelease });
          expect(words.length).toBe(sentences.length);
          // Unique, and in the declared order, so a report can be checked against it.
          const indexes = words.map((w) => MINIMUM_FAILURES.indexOf(w));
          expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
          words.forEach((word, i) => {
            if (word === "name_too_short") {
              expect(sentences[i]).toStartWith("Dataset Name must be a descriptive title");
            } else if (word === "authors_not_blinded") {
              expect(sentences[i]).toStartWith("This is an anonymous release, but Authors");
            } else {
              expect(sentences[i]).toBe(minimumFailureSentence(word));
            }
          });
          // The Authors words belong to one kind of release each.
          if (anonymousRelease) expect(words).not.toContain("authors_missing");
          else {
            expect(words).not.toContain("authors_empty_for_anonymous");
            expect(words).not.toContain("authors_not_blinded");
          }
          // A description that cannot be read is the only failure reported.
          if (words.some((w) => w.startsWith("description_"))) expect(words.length).toBe(1);
        }
      }
    }
    expect(cases).toBeGreaterThan(300);
  });

  test("every word is produced by some input, so none is dead", () => {
    const seen = new Set<MinimumFailure>();
    for (const description of descriptions) {
      for (const readme of readmes) {
        for (const anonymousRelease of [false, true]) {
          for (const w of submissionMinimumFailures(description, readme, { anonymousRelease })) {
            seen.add(w);
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...MINIMUM_FAILURES].sort());
  });

  test("the sentence for a word quotes nothing, where the long form names the authors", () => {
    const description = JSON.stringify({ Name: "x", Authors: [SENTINEL] });
    const long = evaluateSubmissionMinimums(description, null, { anonymousRelease: true });
    expect(long.join(" ")).toContain(SENTINEL);
    const words = submissionMinimumFailures(description, null, { anonymousRelease: true });
    expect(words).toEqual(["name_too_short", "authors_not_blinded", "ethics_statement_missing"]);
    for (const w of MINIMUM_FAILURES) {
      expect(minimumFailureSentence(w)).not.toContain(SENTINEL);
      expect(minimumFailureSentence(w)).not.toMatch(/currently \d/);
      expect(minimumFailureSentence(w).length).toBeGreaterThan(20);
    }
  });
});

describe("the two minimum sentences that take a value", () => {
  // Pinned in full, both forms. The short form (a stored, mailed or logged word) and the long form
  // (what the depositor reads) are one template each, so they cannot drift; a change to either
  // sentence is a change to both, and to this test.
  const NAME_TAIL =
    ' If the study is known by a short acronym, expand it with a subtitle, e.g. "ACRO: auditory cortex recordings during natural speech".';
  const BLIND_TAIL =
    ' That file is part of the dataset and is served publicly, so NEMAR cannot conceal what it says. Replace the entries with a placeholder such as "Anonymous", commit, and request the release again. Restore the real names when you publish after acceptance.';

  test("name_too_short: the long form adds the current length to the short one", () => {
    expect(minimumFailureSentence("name_too_short")).toBe(
      `Dataset Name must be a descriptive title of at least 25 characters.${NAME_TAIL}`,
    );
    expect(evaluateSubmissionMinimums(JSON.stringify({ Name: "x" }), "IRB approved")).toEqual([
      `Dataset Name must be a descriptive title of at least 25 characters (currently 1).${NAME_TAIL}`,
      // The Authors rule fires too: a named release needs a real author.
      minimumFailureSentence("authors_missing"),
    ]);
  });

  test("authors_not_blinded: the long form names the authors it found, the short one says somebody", () => {
    expect(minimumFailureSentence("authors_not_blinded")).toBe(
      `This is an anonymous release, but Authors in dataset_description.json still names somebody.${BLIND_TAIL}`,
    );
    const description = JSON.stringify({
      Name: "A sufficiently descriptive title of a dataset",
      Authors: [SENTINEL, "Ada Lovelace"],
      EthicsApprovals: ["Approved by the board, ref 12"],
    });
    expect(evaluateSubmissionMinimums(description, null, { anonymousRelease: true })).toEqual([
      `This is an anonymous release, but Authors in dataset_description.json still names ${SENTINEL}, Ada Lovelace.${BLIND_TAIL}`,
    ]);
  });
});

describe("one README list (shared/readme-candidates.ts)", () => {
  test("is the four forms BIDS allows, in the order the first present one is chosen", () => {
    expect([...README_CANDIDATES]).toEqual(["README.md", "README", "README.rst", "README.txt"]);
  });

  test("firstReadme picks by that order, with exact case, and null when there is none", () => {
    expect(firstReadme(["README.rst", "README.md", "CHANGES"])).toBe("README.md");
    expect(firstReadme(["README.rst"])).toBe("README.rst");
    expect(firstReadme(["README.txt", "README.rst"])).toBe("README.rst");
    expect(firstReadme(new Set(["README", "README.txt"]))).toBe("README");
    expect(firstReadme(["readme.md", "Readme", "sub-01/README.md"])).toBeNull();
    expect(firstReadme([])).toBeNull();
  });

  test("the submission gate and the anonymity sweep import it and keep no list of their own", () => {
    const root = join(import.meta.dir, "..");
    for (const file of [
      "backend/src/services/submission-gate.ts",
      "backend/src/services/anonymity-sweep.ts",
    ]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text).toContain(
        'import { README_CANDIDATES } from "../../../shared/readme-candidates.js";',
      );
      expect(text).not.toMatch(/"README(\.[a-z]+)?"/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures: bodies as the job would post them. Every one goes through the real parser.
// ---------------------------------------------------------------------------------------------

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const ALL_SENT: Record<string, DocumentState> = {
  readme: "sent",
  dataset_description: "sent",
  changes: "sent",
  license: "sent",
  participants_json: "sent",
};

function summaryBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subjects: 12,
    sessions: 24,
    recordings: 30,
    datatypes: ["eeg", "motion"],
    formats: { ".edf": 24, ".set": 4, ".ds/": 2 },
    has_derivatives: true,
    has_sourcedata: false,
    has_code: true,
    sampling_rates_hz: [250, 512.5],
    channel_counts: [32, 64],
    sidecars_read: 30,
    sidecars_total: 30,
    ...over,
  };
}

function evidenceBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    head: HEAD,
    anonymous: false,
    version: "1.2.0",
    version_shape: "ok",
    tag: "absent",
    bids: "pass",
    minimums: "met",
    minimum_failures: [],
    name_length: 48,
    license_field: true,
    authors_count: 2,
    placeholder_authors: 0,
    documents: { ...ALL_SENT },
    withheld_findings: {},
    description_keys_shown: 9,
    description_keys_not_shown: 2,
    summary: summaryBody(),
    ...over,
  };
}

const ALL_PASS: Record<Question, Answer> = {
  complete_and_honest: "pass",
  meets_standards: "pass",
  authors_and_license: "pass",
  name_adequate: "pass",
};

function finding(
  question: Question,
  severity = "concern",
  code = "other",
  document: string | null = null,
  note = "A note.",
): Record<string, unknown> {
  return { question, severity, code, document, note };
}

function reportBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    model: "claude-haiku-5-5",
    questions: { ...ALL_PASS },
    findings: [],
    summary: "The README describes the recordings and how they were made.",
    steering: false,
    evidence: evidenceBody(),
    ...over,
  };
}

/** The parser's fixed word for `raw`, or "accepted". */
function refusal(raw: unknown, options?: { models?: readonly string[] }): string {
  try {
    parsePublicationReviewReport(raw, options as never);
    return "accepted";
  } catch (err) {
    if (err instanceof PublicationReviewReportError) return err.code;
    throw err;
  }
}

/** An evidence block with `over` applied, as the report parser sees it. */
const withEvidence = (over: Record<string, unknown>) =>
  reportBody({ evidence: evidenceBody(over) });
const withSummary = (over: Record<string, unknown>) => withEvidence({ summary: summaryBody(over) });

/** The fail-class reasons, written out from ADR 0102's table rather than read from the module. */
const FAIL_CLASS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "request_blocked",
  "submission_minimum_failed",
  "identifier_screen_blocks",
  "version_kept_after_anonymous_release",
  "question_failed",
  "steering_attempt",
  "bids_failed_at_review",
  "version_already_released",
  "version_malformed",
  "stored_verdict_fail",
]);

/** The outcome the reasons call for, by the test's own table. */
function oracleVerdict(reasons: readonly Reason[]): PublicationOutcome {
  if (reasons.length === 0) return "pass";
  return reasons.some((r) => FAIL_CLASS.has(r.code)) ? "fail" : "action_required";
}

describe("the closed lists are the ones ADR 0102 and the design note name", () => {
  test("questions, answers, severities, findings", () => {
    expect([...QUESTIONS]).toEqual([
      "complete_and_honest",
      "meets_standards",
      "authors_and_license",
      "name_adequate",
    ]);
    expect([...ANSWERS]).toEqual(["pass", "fail", "unknown"]);
    expect([...PUBLICATION_SEVERITIES]).toEqual(["blocker", "concern", "note"]);
    expect([...PUBLICATION_FINDING_CODES]).toEqual([
      "readme_missing_or_stub",
      "readme_mismatch",
      "description_incomplete",
      "ethics_statement_missing",
      "ethics_statement_inadequate",
      "authors_placeholder",
      "authors_inconsistent",
      "license_missing",
      "license_inconsistent",
      "name_not_descriptive",
      "changes_inconsistent",
      "provenance_unclear",
      "source_license_conflict",
      "evidence_incomplete",
      "steering_attempt",
      "other",
    ]);
    // Nothing about privacy, identifiers or the depositors: the model is not asked (section 2).
    for (const code of PUBLICATION_FINDING_CODES) {
      expect(code).not.toMatch(/privacy|identif|depositor|person|name_of/);
    }
  });

  test("states, run errors, declines, outcomes, models", () => {
    expect([...PUBLICATION_REVIEW_STATES]).toEqual([
      "dispatched",
      "reported",
      "declined",
      "errored",
      "unreported",
    ]);
    expect([...PUBLICATION_RUN_ERRORS]).toEqual([
      "evidence_unavailable",
      "stale_head",
      "auth_failed",
      "model_unavailable",
      "model_refused",
      "model_truncated",
      "model_invalid",
      "report_invalid",
      "dispatch_failed",
      "dispatch_unconfigured",
      "review_disabled",
      "workflow_failed",
    ]);
    expect([...WORKER_ONLY_RUN_ERRORS]).toEqual([
      "dispatch_failed",
      "dispatch_unconfigured",
      "review_disabled",
    ]);
    expect([...NEVER_REACHED_MODEL]).toEqual([
      "stale_head",
      "dispatch_failed",
      "dispatch_unconfigured",
      "review_disabled",
    ]);
    expect([...PUBLICATION_DECLINE_DETAILS]).toEqual(["depositor_limit", "platform_limit"]);
    expect([...PUBLICATION_OUTCOMES]).toEqual(["pass", "fail", "action_required"]);
    expect([...PUBLICATION_REVIEW_MODELS]).toEqual(["claude-haiku-5-5"]);
    expect([...CALIBRATION_MODELS]).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect([...PUBLICATION_REPORT_ERRORS]).toEqual([
      "not_an_object",
      "unknown_key",
      "bad_version",
      "bad_model",
      "bad_questions",
      "bad_findings",
      "bad_summary",
      "bad_steering",
      "bad_evidence",
    ]);
  });

  test("documents, states of a document, BIDS, tags, versions", () => {
    expect([...REVIEW_DOCUMENTS]).toEqual([
      "readme",
      "dataset_description",
      "changes",
      "license",
      "participants_json",
    ]);
    expect([...DOCUMENT_STATES]).toEqual([
      "sent",
      "sent_cut",
      "absent",
      "withheld_finding",
      "withheld_unreadable",
      "withheld_not_utf8",
      "withheld_annexed",
      "withheld_not_json",
    ]);
    expect(DOCUMENT_STATES.filter(isWithheld)).toEqual([
      "withheld_finding",
      "withheld_unreadable",
      "withheld_not_utf8",
      "withheld_annexed",
      "withheld_not_json",
    ]);
    expect([...BIDS_STATES]).toEqual(["pass", "fail", "unconcluded", "unknown"]);
    expect([...TAG_STATES]).toEqual(["absent", "at_head", "elsewhere", "not_applicable"]);
    expect([...VERSION_SHAPES]).toEqual(["ok", "missing", "malformed"]);
    expect(DOCUMENT_CHAR_CAPS).toEqual({
      readme: 24_000,
      dataset_description: 16_000,
      changes: 8_000,
      license: 4_000,
      participants_json: 8_000,
    });
    // Version is the platform's fact, never the model's to read.
    expect(DESCRIPTION_KEYS_SHOWN).not.toContain("Version");
    for (const key of [
      "EthicsApprovals",
      "License",
      "Authors",
      "Funding",
      "SourceDatasets",
    ] as const) {
      expect(DESCRIPTION_KEYS_SHOWN).toContain(key);
    }
  });

  test("caps, timings and the standing line", () => {
    expect(DEPOSITOR_DAILY_CAP).toBe(5);
    expect(PLATFORM_DAILY_CAP).toBe(50);
    expect(PUBLICATION_REVIEW_DEADLINE_MINUTES).toBe(30);
    expect(REVIEW_OVERDUE_VIEW_MINUTES).toBe(PUBLICATION_REVIEW_DEADLINE_MINUTES + 30);
    expect(NOT_ASSESSED_LINE).toBe("Not assessed: whether the text names the depositors.");
  });

  test("the admin routes' words", () => {
    expect([...PUBLICATION_REVIEW_VIEW_KINDS]).toEqual([
      "not_applicable",
      "off",
      "not_reviewed",
      "running",
      "decided",
      "unreadable",
    ]);
    expect([...START_STARTED_REASONS]).toEqual(["dispatched", "redispatched", "dispatch_claimed"]);
    expect([...START_REFUSED_REASONS]).toEqual([
      "review_disabled",
      "not_applicable",
      "not_owned_here",
      "request_not_requested",
      "screen_not_ready",
      "running",
      "has_result",
      "platform_limit",
    ]);
    expect([...START_NOT_HANDED_OVER_REASONS]).toEqual([
      "dispatch_failed",
      "dispatch_unconfigured",
    ]);
    // `depositor_limit` is a screen result's answer, never an administrator's: not in the contract.
    expect([...START_REASONS]).toEqual([
      ...START_STARTED_REASONS,
      ...START_REFUSED_REASONS,
      ...START_NOT_HANDED_OVER_REASONS,
    ]);
    expect(START_REASONS as readonly string[]).not.toContain("depositor_limit");
    expect([...PUBLICATION_REVIEW_ERROR_CODES]).toEqual([
      "bad_dataset",
      "not_found",
      "origin_not_allowed",
      "review_disabled",
      "not_applicable",
      "not_owned_here",
      "request_not_requested",
      "screen_not_ready",
      "running",
      "has_result",
      "platform_limit",
      "dispatch_failed",
      "dispatch_unconfigured",
      "internal",
    ]);
    // Every word a refusal or a failed hand-over carries as `reason` is also a `code`, so the one
    // word means one thing wherever a client reads it.
    for (const word of [...START_REFUSED_REASONS, ...START_NOT_HANDED_OVER_REASONS]) {
      expect(PUBLICATION_REVIEW_ERROR_CODES as readonly string[]).toContain(word);
    }
  });

  test("the datatypes are the Worker's BIDS datatypes plus other", () => {
    // The Worker's list is a Set of plain strings, so the comparison is between lists of strings.
    expect<string[]>([...REVIEW_DATATYPES]).toEqual([...BIDS_DATATYPES, "other"]);
  });

  test("the formats are the preflight's closed list plus EDF and BDF, and nothing else", () => {
    for (const f of KNOWN_FORMATS) expect(REVIEW_FORMATS.has(f)).toBe(true);
    expect(REVIEW_FORMATS.has(".edf")).toBe(true);
    expect(REVIEW_FORMATS.has(".bdf")).toBe(true);
    expect(KNOWN_FORMATS.has(".edf")).toBe(false);
    expect(REVIEW_FORMATS.size).toBe(KNOWN_FORMATS.size + 2);
  });
});

describe("the parser refuses what the job must never send", () => {
  test("a clean report parses, and a stored one reads back identical", () => {
    const parsed = parsePublicationReviewReport(reportBody());
    expect(parsed.questions).toEqual(ALL_PASS);
    const again = parsePublicationReviewReport(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  test("an unknown or a missing key, at every level", () => {
    /** `o` without `key`: a missing key, not one set to undefined. */
    const omit = (o: Record<string, unknown>, key: string) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
    expect(refusal(reportBody({ extra: 1 }))).toBe("unknown_key");
    expect(refusal(omit(reportBody(), "summary"))).toBe("unknown_key");
    expect(refusal(reportBody({ questions: { ...ALL_PASS, extra: "pass" } }))).toBe(
      "bad_questions",
    );
    expect(refusal(reportBody({ questions: omit(ALL_PASS, "name_adequate") }))).toBe(
      "bad_questions",
    );
    expect(
      refusal(reportBody({ findings: [{ ...finding("name_adequate"), path: "README" }] })),
    ).toBe("bad_findings");
    expect(refusal(reportBody({ findings: [omit(finding("name_adequate"), "note")] }))).toBe(
      "bad_findings",
    );
    expect(refusal(withEvidence({ extra: 1 }))).toBe("bad_evidence");
    expect(refusal(reportBody({ evidence: omit(evidenceBody(), "head") }))).toBe("bad_evidence");
    expect(refusal(withEvidence({ documents: { ...ALL_SENT, extra: "sent" } }))).toBe(
      "bad_evidence",
    );
    expect(refusal(withEvidence({ documents: omit(ALL_SENT, "license") }))).toBe("bad_evidence");
    expect(refusal(withSummary({ extra: 1 }))).toBe("bad_evidence");
    expect(refusal(withEvidence({ summary: omit(summaryBody(), "subjects") }))).toBe(
      "bad_evidence",
    );
  });

  test("not an object, a wrong version, a model outside the list", () => {
    expect(refusal(null)).toBe("not_an_object");
    expect(refusal([reportBody()])).toBe("not_an_object");
    expect(refusal("report")).toBe("not_an_object");
    expect(refusal(reportBody({ v: 2 }))).toBe("bad_version");
    expect(refusal(reportBody({ v: "1" }))).toBe("bad_version");
    expect(refusal(reportBody({ model: "claude-sonnet-5-5" }))).toBe("bad_model");
    expect(
      refusal(reportBody({ model: "claude-sonnet-5-5" }), { models: CALIBRATION_MODELS }),
    ).toBe("accepted");
    // Even the calibration cannot name a model outside its own list, by cast or otherwise.
    expect(refusal(reportBody({ model: "gpt-x" }), { models: ["gpt-x"] })).toBe("bad_model");
    expect(refusal(reportBody({ steering: "false" }))).toBe("bad_steering");
    expect(refusal(reportBody({ summary: 4 }))).toBe("bad_summary");
  });

  test("a value outside every closed set", () => {
    expect(refusal(reportBody({ questions: { ...ALL_PASS, name_adequate: "yes" } }))).toBe(
      "bad_questions",
    );
    for (const over of [
      { question: "privacy" },
      { severity: "critical" },
      { code: "identifier_found" },
      { document: "participants_tsv" },
      { note: 3 },
    ]) {
      expect(refusal(reportBody({ findings: [{ ...finding("name_adequate"), ...over }] }))).toBe(
        "bad_findings",
      );
    }
    for (const over of [
      { version_shape: "unknown" },
      { tag: "missing" },
      { bids: "passed" },
      { minimums: "ok" },
      { minimum_failures: ["name_short"], minimums: "failed" },
      { documents: { ...ALL_SENT, readme: "sent_whole" } },
      { anonymous: "false" },
      { license_field: 1 },
    ]) {
      expect(refusal(withEvidence(over))).toBe("bad_evidence");
    }
    expect(refusal(withSummary({ datatypes: ["eeg", "xray"] }))).toBe("bad_evidence");
    expect(refusal(withSummary({ has_code: "yes" }))).toBe("bad_evidence");
  });

  test("a count that is not a non-negative integer, wherever it is", () => {
    const evidenceCounts = [
      "name_length",
      "authors_count",
      "placeholder_authors",
      "description_keys_shown",
      "description_keys_not_shown",
    ];
    for (const key of evidenceCounts) {
      for (const bad of [-1, 1.5, "3", null, Number.NaN, 10_000_001]) {
        expect(refusal(withEvidence({ [key]: bad }))).toBe("bad_evidence");
      }
    }
    for (const key of ["subjects", "sessions", "sidecars_read", "sidecars_total"]) {
      for (const bad of [-1, 1.5, "3", null, 10_000_001]) {
        expect(refusal(withSummary({ [key]: bad }))).toBe("bad_evidence");
      }
    }
    expect(refusal(withSummary({ recordings: -1, formats: {} }))).toBe("bad_evidence");
  });

  test("formats that do not add up to the recordings, or name a file", () => {
    expect(refusal(withSummary({ formats: { ".edf": 24, ".set": 4 } }))).toBe("bad_evidence");
    expect(refusal(withSummary({ formats: { ".edf": 31 } }))).toBe("bad_evidence");
    expect(refusal(withSummary({ formats: { ".edf": 30, ".set": 0 } }))).toBe("bad_evidence");
    expect(refusal(withSummary({ formats: { ".john": 30 } }))).toBe("bad_evidence");
    expect(refusal(withSummary({ formats: { "sub-01_task-rest_eeg.edf": 30 } }))).toBe(
      "bad_evidence",
    );
    expect(refusal(withSummary({ formats: { ".edf": 25, ".bdf": 5 } }))).toBe("accepted");
    expect(refusal(withSummary({ recordings: 0, formats: {} }))).toBe("accepted");
  });

  test("datatypes that are not sorted and unique", () => {
    expect(refusal(withSummary({ datatypes: ["motion", "eeg"] }))).toBe("bad_evidence");
    expect(refusal(withSummary({ datatypes: ["eeg", "eeg"] }))).toBe("bad_evidence");
    expect(refusal(withSummary({ datatypes: [] }))).toBe("accepted");
    expect(refusal(withSummary({ datatypes: ["eeg", "other"] }))).toBe("accepted");
  });

  test("sampling rates and channel counts that are not bounded, distinct numbers", () => {
    for (const bad of [
      [0],
      [-250],
      [Number.POSITIVE_INFINITY],
      [1_000_000],
      [250.123],
      [500, 250],
      [250, 250],
      ["250"],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    ]) {
      expect(refusal(withSummary({ sampling_rates_hz: bad }))).toBe("bad_evidence");
    }
    for (const bad of [[0], [32.5], [64, 32], [32, 32], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
      expect(refusal(withSummary({ channel_counts: bad }))).toBe("bad_evidence");
    }
    expect(refusal(withSummary({ sampling_rates_hz: [0.01, 999_999.99] }))).toBe("accepted");
    expect(refusal(withSummary({ sidecars_read: 31, sidecars_total: 30 }))).toBe("bad_evidence");
  });

  test("evidence that does not agree with itself", () => {
    const refused = [
      { version: "1.2.0", version_shape: "missing", tag: "not_applicable" },
      { version: null, version_shape: "ok" },
      { version: "v1.2.0", version_shape: "ok" },
      { version: "1.2", version_shape: "ok" },
      { version: "1.2.0", version_shape: "ok", tag: "not_applicable" },
      // No Version is published as 1.0.0, so there is a tag to look up, and a state for it is required.
      { version: null, version_shape: "missing", tag: "not_applicable" },
      // A malformed Version has no version to look up: any tag state would be invented.
      { version: null, version_shape: "malformed", tag: "absent" },
      { version: null, version_shape: "malformed", tag: "at_head" },
      { version: null, version_shape: "malformed", tag: "elsewhere" },
      { minimums: "failed", minimum_failures: [] },
      { minimums: "met", minimum_failures: ["ethics_statement_missing"] },
      {
        minimums: "failed",
        minimum_failures: ["ethics_statement_missing", "name_too_short"],
      },
      { minimums: "failed", minimum_failures: ["name_too_short", "name_too_short"] },
      { minimums: "failed", minimum_failures: ["description_missing", "name_too_short"] },
      { minimums: "failed", minimum_failures: ["authors_not_blinded"] },
      { anonymous: true, minimums: "failed", minimum_failures: ["authors_missing"] },
      { documents: { ...ALL_SENT, readme: "withheld_finding" } },
      { withheld_findings: { "local-user-path": 1 } },
      {
        documents: { ...ALL_SENT, readme: "withheld_finding" },
        withheld_findings: { "a-new-kind": 1 },
      },
      {
        documents: { ...ALL_SENT, readme: "withheld_finding" },
        withheld_findings: { "local-user-path": 0 },
      },
      { placeholder_authors: 3, authors_count: 2 },
      { description_keys_shown: DESCRIPTION_KEYS_SHOWN.length + 1 },
      { head: HEAD.toUpperCase() },
      { head: HEAD.slice(1) },
      { head: `${HEAD}0` },
    ];
    for (const over of refused) expect(refusal(withEvidence(over))).toBe("bad_evidence");
    const accepted = [
      { version: null, version_shape: "missing", tag: "absent" },
      { version: null, version_shape: "missing", tag: "at_head" },
      { version: null, version_shape: "missing", tag: "elsewhere" },
      { version: null, version_shape: "malformed", tag: "not_applicable" },
      { version: "1.2.0", version_shape: "ok", tag: "elsewhere" },
      {
        minimums: "failed",
        minimum_failures: ["name_too_short", "authors_missing", "ethics_statement_missing"],
      },
      { anonymous: true, minimums: "failed", minimum_failures: ["authors_not_blinded"] },
      { minimums: "failed", minimum_failures: ["description_not_json"] },
      {
        documents: { ...ALL_SENT, readme: "withheld_finding", license: "withheld_finding" },
        withheld_findings: { "local-user-path": 2, "json-identifier-key": 1 },
      },
    ];
    for (const over of accepted) expect(refusal(withEvidence(over))).toBe("accepted");
  });

  test("more than eight findings", () => {
    const nine = Array.from({ length: MAX_PUBLICATION_FINDINGS + 1 }, () =>
      finding("name_adequate"),
    );
    expect(refusal(reportBody({ findings: nine }))).toBe("bad_findings");
    expect(refusal(reportBody({ findings: nine.slice(1) }))).toBe("accepted");
  });

  test("the error is a fixed word that never quotes the input", () => {
    const hostile = [
      reportBody({ model: SENTINEL }),
      reportBody({ questions: { ...ALL_PASS, name_adequate: SENTINEL } }),
      reportBody({ [SENTINEL]: 1 }),
      reportBody({ findings: [{ ...finding("name_adequate"), code: SENTINEL }] }),
      withEvidence({ head: SENTINEL }),
      withEvidence({ version: SENTINEL, version_shape: "ok" }),
      withSummary({ formats: { [SENTINEL]: 30 } }),
      withSummary({ datatypes: [SENTINEL] }),
      withEvidence({
        documents: { ...ALL_SENT, readme: "withheld_finding" },
        withheld_findings: { [SENTINEL]: 1 },
      }),
    ];
    for (const raw of hostile) {
      let message = "";
      try {
        parsePublicationReviewReport(raw);
      } catch (err) {
        expect(err).toBeInstanceOf(PublicationReviewReportError);
        message = String((err as Error).message);
      }
      expect(PUBLICATION_REPORT_ERRORS as readonly string[]).toContain(message);
      expect(message).not.toContain("Zqxjvw");
    }
  });

  test("the evidence parser stands alone for the job's own check", () => {
    expect(parsePublicationReviewEvidence(evidenceBody()).head).toBe(HEAD);
    expect(() => parsePublicationReviewEvidence(evidenceBody({ head: "x" }))).toThrow(
      PublicationReviewReportError,
    );
  });
});

describe("free text is reduced to plain words, never refused for its content", () => {
  const hostile =
    "@admins see [this](https://evil.example/x) <img src=x onerror=1> #12 GH-7 **bold** ‮evil `code` ![i](data:x) www.evil.example";

  test("a hostile note and summary reach the parsed report as plain words", () => {
    const parsed = parsePublicationReviewReport(
      reportBody({
        questions: { ...ALL_PASS, meets_standards: "fail" },
        findings: [finding("meets_standards", "blocker", "other", null, hostile)],
        summary: hostile.repeat(20),
      }),
    );
    for (const text of [parsed.findings[0].note, parsed.summary]) {
      expect(text).not.toMatch(/[@#<>`*‮[\]]/);
      expect(text).not.toContain("evil.example");
      expect(text).not.toMatch(/https?:/);
      expect(text).toContain("(link removed)");
    }
    expect(Array.from(parsed.findings[0].note).length).toBeLessThanOrEqual(200);
    expect(Array.from(parsed.summary).length).toBeLessThanOrEqual(400);
  });

  test("sanitizing is idempotent: a stored report parses back to itself", () => {
    const parsed = parsePublicationReviewReport(
      reportBody({ findings: [finding("name_adequate", "note", "other", null, hostile)] }),
    );
    expect(parsePublicationReviewReport(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

describe("the report agrees with itself, in the safe direction only", () => {
  test("a steering finding sets the steering flag", () => {
    const parsed = parsePublicationReviewReport(
      reportBody({ findings: [finding("complete_and_honest", "note", "steering_attempt")] }),
    );
    expect(parsed.steering).toBe(true);
    expect(reportReasons(parsed).map((r) => r.code)).toContain("steering_attempt");
  });

  test("a question passed with a blocker against it becomes unknown", () => {
    const parsed = parsePublicationReviewReport(
      reportBody({ findings: [finding("name_adequate", "blocker", "name_not_descriptive")] }),
    );
    expect(parsed.questions.name_adequate).toBe("unknown");
    // A concern does not move it.
    const concern = parsePublicationReviewReport(
      reportBody({ findings: [finding("name_adequate", "concern", "name_not_descriptive")] }),
    );
    expect(concern.questions.name_adequate).toBe("pass");
  });

  test("a failed question with no finding gets one, made room for by the model's last", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      finding("complete_and_honest", "note", "other", null, `note ${i}`),
    );
    const parsed = parsePublicationReviewReport(
      reportBody({
        questions: { ...ALL_PASS, meets_standards: "fail", name_adequate: "fail" },
        findings: eight,
      }),
    );
    expect(parsed.findings).toHaveLength(8);
    expect(parsed.findings.slice(0, 6).map((f) => f.note)).toEqual(
      eight.slice(0, 6).map((f) => String(f.note)),
    );
    expect(parsed.findings.slice(6)).toEqual([
      {
        question: "meets_standards",
        severity: "blocker",
        code: "other",
        document: null,
        note: "No detail given.",
      },
      {
        question: "name_adequate",
        severity: "blocker",
        code: "other",
        document: null,
        note: "No detail given.",
      },
    ]);
  });

  /** Parse, serialize as the store does, and parse again: what a read of a stored report does. */
  const reparsed = (report: PublicationReviewReport) =>
    parsePublicationReviewReport(JSON.parse(JSON.stringify(report)));

  test("room is never made by dropping the only finding of another failed question", () => {
    // Seven notes for one question, and the one blocker of a second failed question last: the
    // cut that makes room for the third question's `other` finding used to take the blocker, so
    // the second question read as failed with nothing to read, and a re-parse (every read of a
    // stored report) moved the same hole to the third.
    const notes = Array.from({ length: 7 }, (_, i) =>
      finding("complete_and_honest", "note", "other", null, `note ${i}`),
    );
    const parsed = parsePublicationReviewReport(
      reportBody({
        questions: { ...ALL_PASS, meets_standards: "fail", name_adequate: "fail" },
        findings: [...notes, finding("meets_standards", "blocker", "ethics_statement_missing")],
      }),
    );
    expect(parsed.findings).toHaveLength(8);
    for (const q of QUESTIONS) {
      if (parsed.questions[q] === "fail") {
        expect(parsed.findings.some((f) => f.question === q)).toBe(true);
      }
    }
    // The model's own finding for the second question stands; the third gets the filler; the
    // model's last NOTE made the room.
    expect(parsed.findings.filter((f) => f.question === "meets_standards")).toEqual([
      expect.objectContaining({ code: "ethics_statement_missing" }),
    ]);
    expect(parsed.findings.filter((f) => f.question === "name_adequate")).toEqual([
      expect.objectContaining({ code: "other", note: "No detail given." }),
    ]);
    expect(parsed.findings.filter((f) => f.question === "complete_and_honest")).toHaveLength(6);
    expect(reparsed(parsed)).toEqual(parsed);
  });

  test("parsing is idempotent over random reports, and a failed question always has a finding", () => {
    // mulberry32: a small seeded generator, so a failure is reproducible from the seed alone.
    let state = 0x1ea5e5;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(all: readonly T[]): T => all[Math.floor(next() * all.length)];
    for (let i = 0; i < 4000; i++) {
      const questions = Object.fromEntries(QUESTIONS.map((q) => [q, pick(ANSWERS)])) as Record<
        Question,
        Answer
      >;
      const findings = Array.from(
        { length: Math.floor(next() * (MAX_PUBLICATION_FINDINGS + 1)) },
        () =>
          finding(
            pick(QUESTIONS),
            pick(PUBLICATION_SEVERITIES),
            // Most findings are plain; some steer.
            next() < 0.1 ? "steering_attempt" : "other",
          ),
      );
      const parsed = parsePublicationReviewReport(
        reportBody({ questions, findings, steering: next() < 0.1 }),
      );
      expect(reparsed(parsed)).toEqual(parsed);
      expect(parsed.findings.length).toBeLessThanOrEqual(MAX_PUBLICATION_FINDINGS);
      for (const q of QUESTIONS) {
        if (parsed.questions[q] === "fail") {
          expect(parsed.findings.some((f) => f.question === q)).toBe(true);
        }
      }
      // The cut never lowers what the report says: a steering finding that made room still steers.
      if (findings.some((f) => f.code === "steering_attempt")) expect(parsed.steering).toBe(true);
    }
  });
});

describe("facts only lower an answer (answersOf)", () => {
  const combos: Record<Question, Answer>[] = [];
  for (const a of ANSWERS)
    for (const b of ANSWERS)
      for (const c of ANSWERS)
        for (const d of ANSWERS) {
          combos.push({
            complete_and_honest: a,
            meets_standards: b,
            authors_and_license: c,
            name_adequate: d,
          });
        }
  const RANK: Record<Answer, number> = { pass: 2, unknown: 1, fail: 0 };

  /** Each row of the table: the evidence that triggers it and what it does. */
  const FACTS: Array<{
    name: string;
    evidence: Record<string, unknown>;
    lowers: Partial<Record<Question, { to: "fail" | "unknown"; code: string; fact: string }>>;
  }> = [
    {
      name: "no README",
      evidence: { documents: { ...ALL_SENT, readme: "absent" } },
      lowers: {
        complete_and_honest: { to: "fail", code: "readme_missing_or_stub", fact: "readme_absent" },
      },
    },
    {
      name: "the README was cut",
      evidence: { documents: { ...ALL_SENT, readme: "sent_cut" } },
      lowers: {
        complete_and_honest: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
        meets_standards: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
      },
    },
    {
      name: "the README is annexed (withheld, never a stub)",
      evidence: { documents: { ...ALL_SENT, readme: "withheld_annexed" } },
      lowers: {
        complete_and_honest: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
        meets_standards: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
      },
    },
    {
      name: "the description was withheld",
      evidence: { documents: { ...ALL_SENT, dataset_description: "withheld_not_json" } },
      lowers: {
        meets_standards: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
        authors_and_license: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
        name_adequate: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
      },
    },
    {
      name: "CHANGES had a finding",
      evidence: {
        documents: { ...ALL_SENT, changes: "withheld_finding" },
        withheld_findings: { "local-user-path": 1 },
      },
      lowers: {
        complete_and_honest: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
      },
    },
    {
      name: "LICENSE was cut",
      evidence: { documents: { ...ALL_SENT, license: "sent_cut" } },
      lowers: {
        authors_and_license: {
          to: "unknown",
          code: "evidence_incomplete",
          fact: "text_not_seen_in_full",
        },
      },
    },
    {
      name: "participants.json was withheld (no question needs it)",
      evidence: { documents: { ...ALL_SENT, participants_json: "withheld_not_utf8" } },
      lowers: {},
    },
    {
      name: "no recordings",
      evidence: { summary: summaryBody({ recordings: 0, formats: {} }) },
      lowers: {
        complete_and_honest: { to: "unknown", code: "evidence_incomplete", fact: "no_recordings" },
      },
    },
    {
      name: "no License",
      evidence: { license_field: false },
      lowers: {
        authors_and_license: { to: "fail", code: "license_missing", fact: "license_field_missing" },
      },
    },
    {
      name: "a short name",
      evidence: { name_length: 24 },
      lowers: {
        name_adequate: { to: "fail", code: "name_not_descriptive", fact: "name_too_short" },
      },
    },
    {
      name: "a placeholder author on a named release",
      evidence: { placeholder_authors: 1 },
      lowers: {
        authors_and_license: {
          to: "fail",
          code: "authors_placeholder",
          fact: "placeholder_author",
        },
      },
    },
    {
      name: "a placeholder author on an anonymous release (the minimum answers it)",
      evidence: { anonymous: true, placeholder_authors: 2 },
      lowers: {},
    },
  ];

  test("with no fact, the answers are the model's and nothing is noted", () => {
    for (const questions of combos) {
      const { answers, notes } = answersOf(parsePublicationReviewReport(reportBody({ questions })));
      expect(answers).toEqual(questions);
      expect(notes).toEqual([]);
    }
  });

  test("every fact has a closed word and one sentence, and the table above produces each word", () => {
    expect([...QUESTION_FACTS]).toEqual([
      "readme_absent",
      "text_not_seen_in_full",
      "no_recordings",
      "license_field_missing",
      "name_too_short",
      "placeholder_author",
    ]);
    expect(QUESTION_FACT_TEXT).toEqual({
      readme_absent: "no README was found at the dataset root",
      text_not_seen_in_full: "the reviewer was not shown all of the text this question needs",
      no_recordings: "the dataset's structure shows no recordings",
      license_field_missing: "dataset_description.json sets no License",
      name_too_short: "the Name in dataset_description.json is shorter than 25 characters",
      placeholder_author: "Authors names a placeholder instead of a person",
    });
    const produced = new Set(FACTS.flatMap((f) => Object.values(f.lowers).map((l) => l.fact)));
    expect([...produced].sort()).toEqual([...QUESTION_FACTS].sort());
  });

  test("a fact that lowered an answer is explained in the question's line, never as the reviewer's answer", () => {
    const report = parsePublicationReviewReport(
      reportBody({ evidence: evidenceBody({ license_field: false, name_length: 3 }) }),
    );
    const reasons = reportReasons(report);
    expect(reasons.map((r) => [r.code, r.detail])).toEqual([
      ["question_failed", "authors_and_license"],
      ["question_failed", "name_adequate"],
    ]);
    const lines = describePublicationReview({
      datasetId: "nm000123",
      applies: true,
      enabled: true,
      outcome: "fail",
      reasons,
      row: { kind: "reported", report, stored: "fail" },
      model: report.model,
      head: HEAD,
      version: "1.2.0",
      startable: true,
    }).lines;
    expect(lines[0]).toStartWith(
      "A question of the review failed (the authors and the license are real and consistent; dataset_description.json sets no License).",
    );
    expect(lines[1]).toStartWith(
      "A question of the review failed (the name describes the dataset; the Name in dataset_description.json is shorter than 25 characters).",
    );
    expect(lines.join("\n")).not.toContain("answered no");
    // A question the model failed itself lists its findings, and no fact.
    const own = parsePublicationReviewReport(
      reportBody({
        questions: { ...ALL_PASS, name_adequate: "fail" },
        findings: [finding("name_adequate", "blocker", "name_not_descriptive")],
      }),
    );
    expect(reasonLine(reportReasons(own)[0], "nm000123", own, true)).toStartWith(
      "A question of the review failed (the name describes the dataset; findings: Name not descriptive).",
    );
  });

  for (const fact of FACTS) {
    test(`${fact.name}: never higher than the model, and lowered to exactly its rule`, () => {
      let lowered = 0;
      for (const questions of combos) {
        const report = parsePublicationReviewReport(
          reportBody({ questions, evidence: evidenceBody(fact.evidence) }),
        );
        const { answers, notes } = answersOf(report);
        for (const q of QUESTIONS) {
          expect(RANK[answers[q]]).toBeLessThanOrEqual(RANK[questions[q]]);
          const rule = fact.lowers[q];
          const want =
            rule && RANK[rule.to] < RANK[questions[q]] ? (rule.to as Answer) : questions[q];
          expect(answers[q]).toBe(want);
          const note = notes.find((n) => n.question === q);
          if (want !== questions[q]) {
            lowered++;
            expect(note).toEqual({
              question: q,
              code: rule?.code as never,
              fact: rule?.fact as never,
              result: want as never,
            });
          } else {
            expect(note).toBeUndefined();
          }
        }
      }
      if (Object.keys(fact.lowers).length > 0) expect(lowered).toBeGreaterThan(0);
    });
  }
});

describe("the reasons table", () => {
  test("every code has a rule with words, and only the codes declared", () => {
    expect(Object.keys(REASONS).sort()).toEqual([...REASON_CODES].sort());
    for (const code of REASON_CODES) {
      const rule = REASONS[code];
      expect(["fail", "unknown"]).toContain(rule.class);
      expect(["nothing", "screen_acknowledgment", "override"]).toContain(rule.clearedBy);
      expect(rule.sentence).toMatch(/^[A-Za-z].*\.$/);
      expect(rule.cure.length).toBeGreaterThan(10);
    }
    expect(new Set(REASON_CODES.map((c) => REASONS[c].sentence)).size).toBe(REASON_CODES.length);
  });

  test("the class of each reason is ADR 0102's", () => {
    for (const code of REASON_CODES) {
      expect(`${code}:${REASONS[code].class}`).toBe(
        `${code}:${FAIL_CLASS.has(code) ? "fail" : "unknown"}`,
      );
    }
  });

  test("the hard set is exactly what nothing clears, and the screen's reason is the only acknowledgment", () => {
    expect([...HARD_REASONS]).toEqual([
      "request_blocked",
      "submission_minimum_failed",
      "identifier_screen_blocks",
      "identifier_screen_not_run",
      "identifier_screen_pending",
      "identifier_screen_stale",
      "version_kept_after_anonymous_release",
    ]);
    expect(REASON_CODES.filter((c) => REASONS[c].clearedBy === "screen_acknowledgment")).toEqual([
      "identifier_screen_needs_acknowledgment",
    ]);
    for (const c of REASON_CODES) {
      if (REASONS[c].clearedBy === "override") expect(REASONS[c].cure).toContain("override");
      else expect(REASONS[c].cure).not.toContain("--force");
    }
  });

  test("the order is exactly ADR 0102's: the hard reasons, the screen's acknowledgment, then the overrides", () => {
    expect([...REASON_CODES]).toEqual([
      // Hard: the request, the minimums and the screen's finding (fail), the screen's gaps
      // (unknown), then the release's own (fail).
      "request_blocked",
      "submission_minimum_failed",
      "identifier_screen_blocks",
      "identifier_screen_not_run",
      "identifier_screen_pending",
      "identifier_screen_stale",
      "version_kept_after_anonymous_release",
      "identifier_screen_needs_acknowledgment",
      // Overrides, fail class first.
      "question_failed",
      "steering_attempt",
      "bids_failed_at_review",
      "version_already_released",
      "version_malformed",
      "stored_verdict_fail",
      "review_not_started",
      "review_running",
      "review_did_not_report",
      "review_limit_reached",
      "review_could_not_run",
      "text_withheld",
      "question_unknown",
      "bids_unconcluded_at_review",
      "version_missing",
      "doi_state_unexpected",
    ]);
  });

  test("the order lists what nothing clears first, then the screen's, then the overrides, fail first", () => {
    const by = REASON_CODES.map((c) => REASONS[c]);
    const stage = (r: (typeof by)[number]) =>
      r.clearedBy === "nothing" ? 0 : r.clearedBy === "screen_acknowledgment" ? 1 : 2;
    for (let i = 1; i < by.length; i++) {
      expect(stage(by[i])).toBeGreaterThanOrEqual(stage(by[i - 1]));
      if (stage(by[i]) === 2 && stage(by[i - 1]) === 2 && by[i - 1].class === "unknown") {
        expect(by[i].class).toBe("unknown");
      }
    }
  });
});

describe("verdictOf and stricterOf", () => {
  test("no reason is a pass; one fail-class reason is a fail; anything else needs a person", () => {
    expect(verdictOf([])).toBe("pass");
    for (const code of REASON_CODES) {
      expect(verdictOf([{ code, detail: null }])).toBe(
        FAIL_CLASS.has(code) ? "fail" : "action_required",
      );
      expect(
        verdictOf([
          { code: "review_running", detail: null },
          { code, detail: null },
        ]),
      ).toBe(FAIL_CLASS.has(code) ? "fail" : "action_required");
    }
  });

  test("the stricter of two outcomes: either can lower, neither can raise", () => {
    const table: Array<[PublicationOutcome, PublicationOutcome, PublicationOutcome]> = [
      ["pass", "pass", "pass"],
      ["pass", "action_required", "action_required"],
      ["pass", "fail", "fail"],
      ["action_required", "pass", "action_required"],
      ["action_required", "action_required", "action_required"],
      ["action_required", "fail", "fail"],
      ["fail", "pass", "fail"],
      ["fail", "action_required", "fail"],
      ["fail", "fail", "fail"],
    ];
    for (const [a, b, want] of table) expect(stricterOf(a, b)).toBe(want);
  });
});

// ---------------------------------------------------------------------------------------------
// reasonsOf, over every combination. The one thing most likely to go wrong in this contract is a
// non-reported row, or a screen or request fact, that yields no reason and so reads as a pass.
// The expectations are written from ADR 0102's table, in this file, not read from the module.
// ---------------------------------------------------------------------------------------------

const R = (code: ReasonCode, detail: string | null = null): Reason => ({ code, detail });

/** Representative reports, each with the reasons it must give by itself, written out by hand. */
const REPORTS: Array<{ name: string; body: Record<string, unknown>; own: Reason[] }> = [
  { name: "clean", body: reportBody(), own: [] },
  {
    name: "a failed question",
    body: reportBody({
      questions: { ...ALL_PASS, meets_standards: "fail" },
      findings: [finding("meets_standards", "blocker", "ethics_statement_inadequate", "readme")],
    }),
    own: [R("question_failed", "meets_standards")],
  },
  {
    name: "steering and an unknown",
    body: reportBody({ steering: true, questions: { ...ALL_PASS, name_adequate: "unknown" } }),
    own: [R("steering_attempt"), R("question_unknown", "name_adequate")],
  },
  {
    name: "a failed minimum and a tag elsewhere",
    body: withEvidence({
      minimums: "failed",
      minimum_failures: ["ethics_statement_missing"],
      tag: "elsewhere",
    }),
    own: [
      R("submission_minimum_failed", "ethics_statement_missing"),
      R("version_already_released"),
    ],
  },
  {
    name: "withheld text, BIDS unconcluded, no version",
    body: withEvidence({
      documents: { ...ALL_SENT, readme: "withheld_annexed" },
      bids: "unconcluded",
      version: null,
      version_shape: "missing",
      tag: "absent",
    }),
    own: [
      R("text_withheld", "readme"),
      R("question_unknown", "complete_and_honest"),
      R("question_unknown", "meets_standards"),
      R("bids_unconcluded_at_review"),
      R("version_missing"),
    ],
  },
];

const PARSED_REPORTS = REPORTS.map((r) => ({ ...r, report: parsePublicationReviewReport(r.body) }));

/** Every row the review in force can be, with the reasons its report gives (null: no report). */
const ROWS: Array<{ row: ReviewRowView; own: Reason[] | null; name: string }> = [
  { name: "none", row: { kind: "none" }, own: null },
  { name: "dispatched", row: { kind: "dispatched", overdue: false }, own: null },
  { name: "dispatched, overdue", row: { kind: "dispatched", overdue: true }, own: null },
  { name: "unreported", row: { kind: "unreported" }, own: null },
  ...PUBLICATION_DECLINE_DETAILS.map((detail) => ({
    name: `declined ${detail}`,
    row: { kind: "declined", detail } as ReviewRowView,
    own: null,
  })),
  ...PUBLICATION_RUN_ERRORS.map((detail) => ({
    name: `errored ${detail}`,
    row: { kind: "errored", detail } as ReviewRowView,
    own: null,
  })),
  ...PUBLICATION_OUTCOMES.map((stored) => ({
    name: `reported, unreadable, stored ${stored}`,
    row: { kind: "reported", report: null, stored } as ReviewRowView,
    own: null,
  })),
  ...PARSED_REPORTS.flatMap((p) =>
    PUBLICATION_OUTCOMES.map((stored) => ({
      name: `reported ${p.name}, stored ${stored}`,
      row: { kind: "reported", report: p.report, stored } as ReviewRowView,
      own: p.own,
    })),
  ),
];

const GATES: Array<ScreenGate | "exempt"> = [
  "clear",
  "acknowledge",
  "blocks",
  "rerun",
  "wait",
  "exempt",
];

function* liveFacts(): Generator<LiveFacts> {
  const requests = [
    { status: "requested", block_reason: null },
    { status: "approving", block_reason: null },
    { status: "blocked", block_reason: "min_requirements_failed" },
    { status: "blocked", block_reason: "Not A Word!" },
  ];
  for (const req of requests)
    for (const anonymous of [false, true])
      for (const gate of GATES)
        for (const head of [HEAD, null])
          for (const head_current of [null, true, false])
            for (const version_row_exists of [false, true])
              for (const prior_anonymous_request of [false, true])
                for (const first_published of [false, true])
                  for (const concept_doi_present of [false, true])
                    for (const concept_ezid_status of [null, "reserved", "public"]) {
                      yield {
                        request: { ...req, anonymous },
                        screen: { gate, head, acknowledged_by: null, head_current },
                        versions: { version_row_exists, prior_anonymous_request, first_published },
                        doi: { concept_doi_present, concept_ezid_status },
                      };
                    }
}

/** The reasons ADR 0102's table calls for, in the table's order. */
function expectedReasons(live: LiveFacts, row: ReviewRowView, own: Reason[] | null): Reason[] {
  const out: Reason[] = [];
  const add = (code: ReasonCode, detail: string | null = null) => out.push({ code, detail });
  const gate = live.screen.gate;
  const headKnown = live.screen.head !== null && /^[0-9a-f]{40}$/.test(live.screen.head);
  if (live.request.status === "blocked") {
    add(
      "request_blocked",
      live.request.block_reason === "min_requirements_failed" ? "min_requirements_failed" : null,
    );
  }
  if (gate === "blocks") add("identifier_screen_blocks");
  if (gate === "rerun" || ((gate === "clear" || gate === "acknowledge") && !headKnown)) {
    add("identifier_screen_not_run");
  }
  if (gate === "wait") add("identifier_screen_pending");
  if (live.screen.head_current === false) add("identifier_screen_stale");
  const v = live.versions;
  const kept =
    v.version_row_exists &&
    !live.request.anonymous &&
    v.prior_anonymous_request &&
    !v.first_published;
  if (kept) add("version_kept_after_anonymous_release");
  if (gate === "acknowledge") add("identifier_screen_needs_acknowledgment");
  if (v.version_row_exists && !kept) add("version_already_released");
  if (
    live.doi.concept_doi_present &&
    !(v.prior_anonymous_request && live.doi.concept_ezid_status === "reserved")
  ) {
    add("doi_state_unexpected");
  }
  switch (row.kind) {
    case "none":
      if (gate === "clear" || gate === "acknowledge" || gate === "exempt") {
        add("review_not_started");
      }
      break;
    case "dispatched":
      add(row.overdue ? "review_did_not_report" : "review_running");
      break;
    case "unreported":
      add("review_did_not_report");
      break;
    case "declined":
      add("review_limit_reached", row.detail);
      break;
    case "errored":
      add("review_could_not_run", row.detail);
      break;
    case "reported":
      if (own === null) {
        add("review_could_not_run", "report_invalid");
        if (row.stored === "fail") add("stored_verdict_fail");
      } else {
        out.push(...own);
        if (row.stored === "fail" && !own.some((r) => FAIL_CLASS.has(r.code))) {
          add("stored_verdict_fail");
        }
        if (row.stored === "action_required" && own.length === 0) {
          add("review_could_not_run", "report_invalid");
        }
      }
      break;
  }
  const seen = new Set<string>();
  return out
    .filter((r) => {
      const key = `${r.code}|${r.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => REASON_CODES.indexOf(a.code) - REASON_CODES.indexOf(b.code));
}

describe("reasonsOf, over every row, screen, request, version and DOI fact", () => {
  test("each hand-written report gives exactly the reasons listed for it", () => {
    for (const p of PARSED_REPORTS)
      expect({ [p.name]: reportReasons(p.report) }).toEqual({ [p.name]: p.own });
  });

  test("every combination gives exactly the table's reasons, and only an all-clear one is a pass", () => {
    const mismatches: string[] = [];
    let combinations = 0;
    let passes = 0;
    for (const live of liveFacts()) {
      for (const { row, own, name } of ROWS) {
        combinations++;
        const got = reasonsOf({ live, row });
        const want = expectedReasons(live, row, own);
        const outcome = verdictOf(got);
        if (outcome === "pass") passes++;
        const bad =
          JSON.stringify(got) !== JSON.stringify(want) ||
          outcome !== oracleVerdict(want) ||
          (row.kind !== "reported" && got.length === 0) ||
          (row.kind === "reported" && row.stored !== "pass" && outcome === "pass");
        if (bad && mismatches.length < 5) {
          mismatches.push(
            `${name} ${JSON.stringify(live)}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(combinations).toBeGreaterThan(400_000);
    // The pass set is not empty: a clean report, stored pass, with a clean request.
    expect(passes).toBeGreaterThan(0);
  }, 120_000);

  test("a reported pass with a clean screen and no live facts is the only shape of a pass", () => {
    const clean: LiveFacts = {
      request: { status: "requested", block_reason: null, anonymous: false },
      screen: { gate: "clear", head: HEAD, acknowledged_by: null, head_current: null },
      versions: {
        version_row_exists: false,
        prior_anonymous_request: false,
        first_published: false,
      },
      doi: { concept_doi_present: false, concept_ezid_status: null },
    };
    const report = PARSED_REPORTS[0].report;
    expect(reasonsOf({ live: clean, row: { kind: "reported", report, stored: "pass" } })).toEqual(
      [],
    );
    // The same, live at the gate (head still main), and approving rather than requested.
    expect(
      reasonsOf({
        live: {
          ...clean,
          request: { ...clean.request, status: "approving" },
          screen: { ...clean.screen, head_current: true },
        },
        row: { kind: "reported", report, stored: "pass" },
      }),
    ).toEqual([]);
    // An unreadable stored report with a fail column is never milder than the column.
    expect(
      reasonsOf({ live: clean, row: { kind: "reported", report: null, stored: "fail" } }),
    ).toEqual([R("stored_verdict_fail"), R("review_could_not_run", "report_invalid")]);
  });
});

describe("reportReasons, over every report dimension", () => {
  const PATTERNS: Array<{ questions: Record<Question, Answer>; findings: unknown[] }> = [
    { questions: { ...ALL_PASS }, findings: [] },
    {
      questions: { ...ALL_PASS, meets_standards: "fail" },
      findings: [finding("meets_standards", "blocker", "provenance_unclear")],
    },
    { questions: { ...ALL_PASS, name_adequate: "unknown" }, findings: [] },
  ];
  const VERSIONS = [
    { version: "1.2.0", version_shape: "ok", tag: "absent" },
    { version: "1.2.0", version_shape: "ok", tag: "at_head" },
    { version: "1.2.0", version_shape: "ok", tag: "elsewhere" },
    { version: null, version_shape: "missing", tag: "absent" },
    { version: null, version_shape: "missing", tag: "at_head" },
    { version: null, version_shape: "missing", tag: "elsewhere" },
    { version: null, version_shape: "malformed", tag: "not_applicable" },
  ];
  const DOCS: Array<Record<string, unknown>> = [
    { documents: { ...ALL_SENT } },
    { documents: { ...ALL_SENT, readme: "absent" } },
    { documents: { ...ALL_SENT, readme: "sent_cut" } },
    {
      documents: { ...ALL_SENT, changes: "withheld_finding" },
      withheld_findings: { "local-user-path": 1 },
    },
    { documents: { ...ALL_SENT, participants_json: "withheld_not_json" } },
  ];
  const FACTS: Array<Record<string, unknown>> = [
    {},
    { summary: summaryBody({ recordings: 0, formats: {} }) },
    { license_field: false },
    { name_length: 10 },
    { placeholder_authors: 1 },
  ];
  const RANK: Record<Answer, number> = { pass: 2, unknown: 1, fail: 0 };

  test("the reasons are the table's, and the stored verdict is pass only when everything is clean", () => {
    const mismatches: string[] = [];
    let reports = 0;
    for (const pattern of PATTERNS)
      for (const steering of [false, true])
        for (const bids of BIDS_STATES)
          for (const minimumsFailed of [false, true])
            for (const version of VERSIONS)
              for (const docs of DOCS)
                for (const facts of FACTS)
                  for (const anonymous of [false, true]) {
                    reports++;
                    const evidence = evidenceBody({
                      ...version,
                      ...docs,
                      ...facts,
                      anonymous,
                      bids,
                      minimums: minimumsFailed ? "failed" : "met",
                      minimum_failures: minimumsFailed ? ["ethics_statement_missing"] : [],
                    });
                    const report = parsePublicationReviewReport(
                      reportBody({ ...pattern, steering, evidence }),
                    );
                    // The answers after the facts, from the table.
                    const documents = evidence.documents as Record<string, DocumentState>;
                    const answers = { ...pattern.questions };
                    const lower = (q: Question, to: Answer) => {
                      if (RANK[to] < RANK[answers[q]]) answers[q] = to;
                    };
                    if (documents.readme === "absent") lower("complete_and_honest", "fail");
                    for (const q of QUESTIONS) {
                      if (
                        QUESTION_NEEDS[q].some(
                          (d) =>
                            documents[d] === "sent_cut" || documents[d].startsWith("withheld_"),
                        )
                      ) {
                        lower(q, "unknown");
                      }
                    }
                    const summary = evidence.summary as Record<string, unknown>;
                    if (summary.recordings === 0) lower("complete_and_honest", "unknown");
                    if (evidence.license_field === false) lower("authors_and_license", "fail");
                    if ((evidence.name_length as number) < 25) lower("name_adequate", "fail");
                    if (!anonymous && (evidence.placeholder_authors as number) > 0) {
                      lower("authors_and_license", "fail");
                    }
                    const want: Reason[] = [];
                    if (minimumsFailed) {
                      want.push(R("submission_minimum_failed", "ethics_statement_missing"));
                    }
                    for (const q of QUESTIONS) {
                      if (answers[q] === "fail") want.push(R("question_failed", q));
                    }
                    if (steering) want.push(R("steering_attempt"));
                    if (bids === "fail") want.push(R("bids_failed_at_review"));
                    if (version.tag === "elsewhere") want.push(R("version_already_released"));
                    if (version.version_shape === "malformed") want.push(R("version_malformed"));
                    const withheld = REVIEW_DOCUMENTS.filter((d) =>
                      documents[d].startsWith("withheld_"),
                    );
                    if (withheld.length > 0) want.push(R("text_withheld", withheld.join(",")));
                    for (const q of QUESTIONS) {
                      if (answers[q] === "unknown") want.push(R("question_unknown", q));
                    }
                    if (bids === "unconcluded" || bids === "unknown") {
                      want.push(R("bids_unconcluded_at_review"));
                    }
                    if (version.version_shape === "missing") want.push(R("version_missing"));

                    const got = reportReasons(report);
                    const allClear =
                      pattern === PATTERNS[0] &&
                      !steering &&
                      bids === "pass" &&
                      !minimumsFailed &&
                      version.version_shape === "ok" &&
                      version.tag !== "elsewhere" &&
                      docs === DOCS[0] &&
                      (facts === FACTS[0] || (anonymous && facts === FACTS[4]));
                    const stored = verdictOf(got);
                    if (
                      JSON.stringify(got) !== JSON.stringify(want) ||
                      stored !== oracleVerdict(want) ||
                      (stored === "pass") !== allClear
                    ) {
                      if (mismatches.length < 5) {
                        mismatches.push(
                          `${JSON.stringify({ pattern, steering, bids, minimumsFailed, version, docs, facts, anonymous })}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`,
                        );
                      }
                    }
                  }
    expect(mismatches).toEqual([]);
    expect(reports).toBe(3 * 2 * 4 * 2 * 7 * 5 * 5 * 2);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// describePublicationReview
// ---------------------------------------------------------------------------------------------

describe("describePublicationReview", () => {
  const hostile =
    "@admins [click](https://evil.example) <script>x</script> #1 GH-2 `code` ‮ www.evil.example";
  const hostileReport = parsePublicationReviewReport(
    reportBody({
      summary: hostile,
      questions: { ...ALL_PASS, meets_standards: "fail" },
      findings: [
        finding("meets_standards", "blocker", "ethics_statement_inadequate", null, hostile),
      ],
    }),
  );
  const rows: ReviewRowView[] = ROWS.map((r) => r.row).concat([
    { kind: "reported", report: hostileReport, stored: "fail" },
  ]);
  const reasonSets: Reason[][] = [
    [],
    [R("review_running")],
    [R("question_failed", "meets_standards")],
    [R("identifier_screen_needs_acknowledgment"), R("text_withheld", "readme,license")],
    [R("request_blocked", "min_requirements_failed")],
    [R("identifier_screen_stale"), R("review_not_started")],
    // Every cure that says "start it", without a hard reason ahead of it.
    [R("review_not_started"), R("review_did_not_report")],
    [R("review_limit_reached", "platform_limit"), R("review_could_not_run", "model_refused")],
  ];
  const base = {
    datasetId: "nm000123",
    model: "claude-haiku-5-5",
    head: HEAD,
    version: "1.2.0",
    startable: true,
  };

  test("every rendering ends with the standing line, and none is milder than its reasons", () => {
    let renderings = 0;
    for (const applies of [true, false])
      for (const enabled of [true, false])
        for (const startable of [true, false])
          for (const row of rows)
            for (const reasons of reasonSets)
              for (const outcome of [...PUBLICATION_OUTCOMES, null]) {
                renderings++;
                const d = describePublicationReview({
                  ...base,
                  startable,
                  applies,
                  enabled,
                  outcome,
                  reasons,
                  row,
                });
                expect(d.lines[d.lines.length - 1]).toBe(NOT_ASSESSED_LINE);
                expect(d.lines.filter((l) => l === NOT_ASSESSED_LINE)).toHaveLength(1);
                // A request no start can reach is never sent to one, in a line or in `next`.
                if (!startable) {
                  expect(d.lines.join("\n")).not.toContain("publish start");
                  expect(d.next ?? "").not.toContain("publish start");
                }
                if (!applies) {
                  expect(d.headline).toBe("Publication review: not applicable");
                  expect(d.tone).toBe("note");
                } else if (!enabled) {
                  expect(d.tone).toBe("note");
                  expect(d.headline).toContain("the automated review is off");
                  expect(d.next).toBeNull();
                } else {
                  const shown = stricterOf(outcome ?? "action_required", oracleVerdict(reasons));
                  expect(d.tone).toBe(
                    ({ pass: "ok", action_required: "warn", fail: "stop" } as const)[shown],
                  );
                  if (reasons.length > 0) expect(d.headline).not.toBe("Publication review: pass");
                }
              }
    expect(renderings).toBeGreaterThan(1000);
  });

  test("tone: pass ok, action required warn, fail stop, not applicable and off note", () => {
    const row: ReviewRowView = {
      kind: "reported",
      report: PARSED_REPORTS[0].report,
      stored: "pass",
    };
    const d = (over: Record<string, unknown>) =>
      describePublicationReview({
        ...base,
        applies: true,
        enabled: true,
        outcome: "pass",
        reasons: [],
        row,
        ...over,
      });
    expect(d({})).toMatchObject({ tone: "ok", headline: "Publication review: pass" });
    expect(d({ outcome: "action_required" }).tone).toBe("warn");
    expect(d({ outcome: "fail" }).tone).toBe("stop");
    expect(d({ applies: false }).tone).toBe("note");
    expect(d({ enabled: false }).tone).toBe("note");
    expect(d({ enabled: false }).headline).toBe(
      "Publication review (advice only, the automated review is off): pass",
    );
    expect(d({ enabled: false, row: { kind: "none" } }).headline).toBe(
      "Publication review: not reviewed (the automated review is off)",
    );
  });

  test("a closed request with no review on record reads as not reviewed, with no command; a review on record is still shown", () => {
    const closed = (over: Record<string, unknown>) =>
      describePublicationReview({
        ...base,
        applies: true,
        enabled: true,
        outcome: null,
        reasons: [],
        row: { kind: "none" },
        closed: true,
        ...over,
      });
    const d = closed({});
    expect(d).toEqual({
      headline: "Publication review: not reviewed (the request is closed)",
      tone: "note",
      lines: [
        "This request is no longer waiting for a decision, and no review of it is on record.",
        NOT_ASSESSED_LINE,
      ],
      summary: null,
      next: null,
    });
    // Off wins over closed: the flag is the more basic fact. A review on record is shown as
    // history whatever the request's status, and an open request is assessed.
    expect(closed({ enabled: false }).headline).toContain("the automated review is off");
    expect(
      closed({ row: { kind: "reported", report: PARSED_REPORTS[0].report, stored: "pass" } })
        .headline,
    ).not.toContain("not reviewed");
    expect(closed({ closed: false, reasons: [R("review_not_started")] }).headline).toBe(
      "Publication review: action required",
    );
  });

  test("a hostile summary or note reaches the lines as plain words, or not at all", () => {
    const d = describePublicationReview({
      ...base,
      applies: true,
      enabled: true,
      outcome: "fail",
      reasons: reportReasons(hostileReport),
      row: { kind: "reported", report: hostileReport, stored: "fail" },
    });
    // The model's summary is a field of its own, in plain words; it is never one of the lines.
    expect(d.summary).not.toBeNull();
    expect(d.summary).not.toMatch(/[@#<>`‮]/);
    expect(d.summary).not.toContain("evil.example");
    const text = d.lines.join("\n");
    expect(text).not.toContain("summary");
    expect(text).not.toMatch(/[@#<>`‮]/);
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("script");
    // The question's line names its finding by its closed label, not by the model's note.
    expect(text).toContain("Ethics statement inadequate");
  });

  test("a review that could not be read has its own fixed words, from this module, and is never a pass", () => {
    expect(describeUnreadableReview("nm000123")).toEqual({
      headline: "Publication review: could not be read",
      tone: "warn",
      lines: [
        "The review's state could not be read just now, so it is not known. This is not a pass.",
        NOT_ASSESSED_LINE,
      ],
      summary: null,
      next: "nemar admin publish show nm000123",
    });
    expect(REVIEW_UNREADABLE_HEADLINE).toBe("Publication review: could not be read");
    // No dataset id to show, or one that is not one: no command, and nothing is quoted.
    for (const id of ["", `x ${SENTINEL}`, "nm00012"]) {
      const d = describeUnreadableReview(id);
      expect(d.next).toBeNull();
      expect(JSON.stringify(d)).not.toContain("Zqxjvw");
    }
  });

  test("the cures that say 'start it' are exactly four, and each has what is true for a request no start reaches", () => {
    expect([...START_CURE_REASONS]).toEqual([
      "review_not_started",
      "review_did_not_report",
      "review_limit_reached",
      "review_could_not_run",
    ]);
    for (const code of REASON_CODES) {
      const startCure = START_CURE_REASONS.includes(code);
      expect(REASONS[code].cure.includes("publish start")).toBe(startCure);
      expect(REASONS[code].cureNotStartable !== undefined).toBe(startCure);
      // The cure of a reason that is not a start cure is the same either way.
      if (!startCure) expect(cureOf(code, "nm000123", false)).toBe(cureOf(code, "nm000123", true));
    }
    for (const code of START_CURE_REASONS) {
      expect(cureOf(code, "nm000123", true)).toContain("nemar admin publish start nm000123");
      const plain = cureOf(code, "nm000123", false);
      expect(plain).toBe(
        "A review starts only for a request that is waiting for its decision. An administrator may approve over it; the approval records the override (--force).",
      );
      expect(plain).not.toContain("publish start");
    }
    // A malformed id is never quoted, in either form.
    expect(cureOf("review_not_started", `x ${SENTINEL}`, true)).toContain(
      "publish start <dataset>",
    );
  });

  test("a request no start reaches is never told to start: not in a line, and not as the next command", () => {
    const next = (reasons: Reason[], row: ReviewRowView, startable: boolean) =>
      describePublicationReview({
        ...base,
        applies: true,
        enabled: true,
        outcome: null,
        reasons,
        row,
        startable,
      }).next;
    const errored: ReviewRowView = { kind: "errored", detail: "model_refused" };
    const reasons = [R("review_could_not_run", "model_refused")];
    expect(next(reasons, errored, true)).toBe("nemar admin publish start nm000123");
    // Being approved: the approval is the next thing, with the override its reason needs.
    expect(next(reasons, errored, false)).toBe("nemar admin publish approve nm000123 --force");
    expect(next([R("review_not_started")], { kind: "none" }, false)).toBe(
      "nemar admin publish approve nm000123 --force",
    );
    // Blocked: a hard reason, so there is no command at all, startable or not.
    expect(next([R("request_blocked"), ...reasons], errored, false)).toBeNull();
  });

  test("the next command follows from the reasons, and a malformed dataset id is never quoted", () => {
    const next = (
      reasons: Reason[],
      row: ReviewRowView = { kind: "none" },
      datasetId = "nm000123",
    ) =>
      describePublicationReview({
        ...base,
        datasetId,
        applies: true,
        enabled: true,
        outcome: null,
        reasons,
        row,
      }).next;
    const reported: ReviewRowView = {
      kind: "reported",
      report: PARSED_REPORTS[0].report,
      stored: "pass",
    };
    expect(next([], reported)).toBe("nemar admin publish approve nm000123");
    expect(next([R("review_not_started")])).toBe("nemar admin publish start nm000123");
    expect(next([R("review_running")], { kind: "dispatched", overdue: false })).toBe(
      "nemar admin publish show nm000123",
    );
    expect(
      next([R("review_could_not_run", "report_invalid")], {
        kind: "reported",
        report: null,
        stored: "pass",
      }),
    ).toBe("nemar admin publish approve nm000123 --force");
    expect(next([R("identifier_screen_needs_acknowledgment")], reported)).toBe(
      'nemar admin publish approve nm000123 --acknowledge-identifier-screen "<reason>"',
    );
    expect(
      next([R("identifier_screen_needs_acknowledgment"), R("version_missing")], reported),
    ).toBe(
      'nemar admin publish approve nm000123 --acknowledge-identifier-screen "<reason>" --force',
    );
    expect(next([R("identifier_screen_stale"), R("review_not_started")])).toBe(
      "nemar admin publish screen nm000123",
    );
    expect(next([R("request_blocked"), R("review_not_started")])).toBeNull();
    expect(next([R("review_not_started")], { kind: "none" }, `nm000123; ${SENTINEL}`)).toBe(
      "nemar admin publish start <dataset>",
    );
    const lines = describePublicationReview({
      ...base,
      datasetId: `x ${SENTINEL}`,
      applies: true,
      enabled: true,
      outcome: null,
      reasons: [R("review_not_started")],
      row: { kind: "none" },
    }).lines.join("\n");
    expect(lines).not.toContain("Zqxjvw");
  });

  test("details read as words: questions, documents, run errors and limits", () => {
    const lines = describePublicationReview({
      ...base,
      applies: true,
      enabled: true,
      outcome: null,
      reasons: [
        R("text_withheld", "readme,participants_json"),
        R("review_could_not_run", "model_truncated"),
        R("review_limit_reached", "platform_limit"),
        R("question_unknown", "name_adequate"),
      ],
      row: { kind: "errored", detail: "model_truncated" },
    }).lines;
    expect(lines.join("\n")).toContain("(README, participants.json)");
    expect(lines.join("\n")).toContain("ran out of room");
    expect(lines.join("\n")).toContain("the platform's daily limit");
    expect(lines.join("\n")).toContain("the name describes the dataset");
    expect(lines.join("\n")).toContain("nemar admin publish start nm000123");
    expect(lines.join("\n")).not.toContain("<dataset>");
  });
});

// ---------------------------------------------------------------------------------------------
// The callback body
// ---------------------------------------------------------------------------------------------

describe("parsePublicationCallbackOutcome", () => {
  test("a report is parsed, and a refused one is report_invalid with the parser's word", () => {
    expect(
      parsePublicationCallbackOutcome({
        outcome: "reported",
        report: reportBody(),
        error: undefined,
      }).kind,
    ).toBe("reported");
    const refused: string[] = [];
    const out = parsePublicationCallbackOutcome(
      { outcome: "reported", report: reportBody({ model: "gpt" }), error: undefined },
      (code) => refused.push(code),
    );
    expect(out).toEqual({ kind: "error", error: "report_invalid" });
    expect(refused).toEqual(["bad_model"]);
  });

  test("a claimed pass, a worker-only word, an unknown word or a missing outcome is workflow_failed", () => {
    const failed = { kind: "error", error: "workflow_failed" } as const;
    expect(
      parsePublicationCallbackOutcome({ outcome: "pass", report: reportBody(), error: undefined }),
    ).toEqual(failed);
    for (const error of WORKER_ONLY_RUN_ERRORS) {
      expect(
        parsePublicationCallbackOutcome({ outcome: "error", report: undefined, error }),
      ).toEqual(failed);
    }
    expect(
      parsePublicationCallbackOutcome({ outcome: "error", report: undefined, error: "too_large" }),
    ).toEqual(failed);
    expect(
      parsePublicationCallbackOutcome({
        outcome: undefined,
        report: undefined,
        error: "stale_head",
      }),
    ).toEqual(failed);
    for (const error of PUBLICATION_RUN_ERRORS) {
      if ((WORKER_ONLY_RUN_ERRORS as readonly string[]).includes(error)) continue;
      expect(
        parsePublicationCallbackOutcome({ outcome: "error", report: undefined, error }),
      ).toEqual({
        kind: "error",
        error,
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The brands: only the parsers mint a report or facts, only the job's pre-send mints cleared text
// ---------------------------------------------------------------------------------------------

describe("the brands are minted in one place each", () => {
  const root = join(import.meta.dir, "..");
  const offendersOf = (pattern: RegExp, allowed: string): string[] => {
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", "test", "dist"].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          scanned++;
          if (!path.endsWith(allowed) && pattern.test(readFileSync(path, "utf8"))) {
            offenders.push(path);
          }
        }
      }
    };
    for (const d of ["shared", "src", "backend/src", "scripts"]) walk(join(root, d));
    // Guards the guard: a mistyped directory would scan nothing and pass.
    expect(scanned).toBeGreaterThan(200);
    return offenders;
  };

  test("no file but the contract casts to PublicationReviewReport or ReviewFacts", () => {
    expect(offendersOf(/\bas\s+PublicationReviewReport\b/, "shared/publication-review.ts")).toEqual(
      [],
    );
    expect(offendersOf(/\bas\s+ReviewFacts\b/, "shared/publication-review.ts")).toEqual([]);
  });

  /**
   * Every spelling of "this is cleared text" that does not go through the pre-send module's one cast.
   * Each is a type assertion to a brand only that module may mint (issue #1728: the guard used to
   * look for `as ClearedText` alone, which `as ClearedDocuments`, an angle-bracket cast and a cast
   * inside a generic all walk around). This guard is lexical, and some spellings that typecheck
   * cannot be found by reading source (a type predicate, an assertion function, a generic cast,
   * `JSON.parse`, a suppressed error): the run-time half is the pre-send module's registry, which
   * the prompt builder asks about every document, tested in `publication-review-prompt.test.ts`.
   */
  const CLEARED_CASTS: [string, RegExp][] = [
    ["as <brand>", /\bas\s+Cleared(?:Text|Documents)\b/],
    ["as unknown as <brand>", /\bas\s+unknown\s+as\s+Cleared(?:Text|Documents)\b/],
    ["as <generic over the brand>", /\bas\s+[A-Za-z_.]+<[^;\n]*\bCleared(?:Text|Documents)\b/],
    ["<brand>value", /(?<![\w$)\]>])<\s*Cleared(?:Text|Documents)\s*>\s*[\w$("'`[{]/],
    [
      "x: <brand> = y as any",
      /\bCleared(?:Text|Documents)\b[^;\n]*=\s*[^;\n]*\bas\s+(?:any|unknown)\b/,
    ],
  ];

  test("no file but the job's pre-send module casts to ClearedText or ClearedDocuments, however it is spelled", () => {
    for (const [spelling, pattern] of CLEARED_CASTS) {
      expect(offendersOf(pattern, "scripts/ci/publication-review-presend.ts"), spelling).toEqual(
        [],
      );
    }
  });

  test("the guard sees each spelling: fixtures, not violations", () => {
    const VIOLATIONS: [string, string][] = [
      ["as <brand>", "const t = x as ClearedText;"],
      ["as <brand>", "const d = JSON.parse(x) as ClearedDocuments;"],
      ["as <brand>", "const d = x as\n  ClearedDocuments;"],
      ["as <brand>", "return text as ClearedText | undefined;"],
      ["as unknown as <brand>", "const t = x as unknown as ClearedText;"],
      ["as unknown as <brand>", "const d = x as unknown as ClearedDocuments;"],
      ["as <generic over the brand>", "const d = x as Record<ReviewDocument, ClearedText>;"],
      [
        "as <generic over the brand>",
        "const d = x as Partial<Record<ReviewDocument, ClearedText>>;",
      ],
      ["<brand>value", "const t = <ClearedText>x;"],
      ["<brand>value", "const d = <ClearedDocuments>JSON.parse(x);"],
      ["<brand>value", "f(<ClearedText> (y));"],
      ["<brand>value", "const d = < ClearedDocuments >{ readme: x };"],
      ["x: <brand> = y as any", "const t: ClearedText = y as any;"],
      ["x: <brand> = y as any", "const d: ClearedDocuments = JSON.parse(y) as unknown;"],
    ];
    for (const [spelling, source] of VIOLATIONS) {
      const hit = CLEARED_CASTS.find(([name]) => name === spelling);
      expect(hit, spelling).toBeDefined();
      expect((hit as [string, RegExp])[1].test(source), `${spelling}: ${source}`).toBe(true);
    }
    // Every pattern is exercised by at least one fixture, so none can be dead.
    for (const [spelling] of CLEARED_CASTS) {
      expect(
        VIOLATIONS.some(([name]) => name === spelling),
        spelling,
      ).toBe(true);
    }
  });

  test("the guard does not flag the legitimate uses of the two types", () => {
    const LEGITIMATE = [
      'import { type ClearedDocuments, type ClearedText } from "../../shared/publication-review";',
      "const cleared: ClearedDocuments = {};",
      "cleared: ClearedDocuments;",
      "export type ClearedDocuments = Partial<Record<ReviewDocument, ClearedText>>;",
      "function f(texts: Array<ClearedText>, one: Set<ClearedText>) {}",
      "const text = cleared[d]; // as a ClearedText, it is a string",
      "const n = x as number; const t: ClearedText | undefined = cleared.readme;",
      "if (a < b && c > d) {}",
    ];
    for (const source of LEGITIMATE) {
      for (const [spelling, pattern] of CLEARED_CASTS) {
        expect(pattern.test(source), `${spelling}: ${source}`).toBe(false);
      }
    }
  });
});

describe("the version an approval would publish", () => {
  const evidenceOf = (over: Record<string, unknown>) =>
    parsePublicationReviewEvidence(evidenceBody(over));

  test("the described X.Y.Z, or the orchestrator's default when none is set, and nothing for a malformed one", () => {
    expect(effectiveVersionOf(evidenceOf({}))).toBe("1.2.0");
    expect(
      effectiveVersionOf(evidenceOf({ version: null, version_shape: "missing", tag: "absent" })),
    ).toBe(DEFAULT_PUBLICATION_VERSION);
    expect(
      effectiveVersionOf(
        evidenceOf({ version: null, version_shape: "malformed", tag: "not_applicable" }),
      ),
    ).toBeNull();
    // Every shape is answered, so a new one cannot slip through unlooked-up.
    expect(VERSION_SHAPES.length).toBe(3);
  });

  test("a tag of the version an approval would publish is reported for a dataset with no Version too", () => {
    const reasonCodes = (over: Record<string, unknown>) =>
      reportReasons(
        parsePublicationReviewReport(
          reportBody({
            evidence: evidenceBody({ version: null, version_shape: "missing", ...over }),
          }),
        ),
      ).map((r) => r.code);
    // 1.0.0 is released at another commit: the same fact, and the same reason, as an explicit
    // Version in that position; the overridable word for the missing Version rides beside it.
    expect(reasonCodes({ tag: "elsewhere" })).toEqual([
      "version_already_released",
      "version_missing",
    ]);
    expect(reasonCodes({ tag: "at_head" })).toEqual(["version_missing"]);
    expect(reasonCodes({ tag: "absent" })).toEqual(["version_missing"]);
    // A malformed Version has nothing to look up and says so with its own word.
    expect(
      reportReasons(
        parsePublicationReviewReport(
          reportBody({
            evidence: evidenceBody({
              version: null,
              version_shape: "malformed",
              tag: "not_applicable",
            }),
          }),
        ),
      ).map((r) => r.code),
    ).toContain("version_malformed");
  });

  test('the default is the one the orchestrator\'s `Version || "1.0.0"` publishes', () => {
    expect(DEFAULT_PUBLICATION_VERSION).toBe("1.0.0");
    const src = readFileSync(
      join(import.meta.dir, "../backend/src/services/publication-orchestrator.ts"),
      "utf8",
    );
    expect(src).toContain(`String(datasetDesc.Version || "${DEFAULT_PUBLICATION_VERSION}")`);
  });
});
