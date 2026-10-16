/**
 * The administrator web page prints the Worker's words as they arrive, so none of them may name a
 * terminal (ADR 0102, section 8; Phase 4 of epic #1726). This file pins that, by iterating the
 * real tables and calling the real producers; no list here is a hand-copied one.
 *
 * What a page prints: a reason's `sentence`, `statement` and neutral `cure` (made by the
 * Worker's own `reasonViewsOf`), the finding, document, fact and question word tables they are
 * composed from, the description's headline, the identifier screen's headline and lines, and the
 * start and request refusals' sentences. What it never prints, and so is allowed
 * to name a command: `command`, `line`, `description.lines`, `description.next` and the
 * review gate's refusal message. The last test records that boundary, so a change that moves a
 * command into a printed field, or a terminal sentence into a page-owned one, is noticed.
 *
 * Every loop counts what it visited, so one that visited nothing cannot pass.
 *
 * CI TIER: unit-pure. Pure: no database, no network, no spawn.
 */

import { describe, expect, test } from "bun:test";
import { ORIGIN_NOT_ALLOWED_MESSAGE } from "../backend/src/middleware/auth";
import { NOT_HANDED_OVER, START_REFUSALS } from "../backend/src/routes/admin/publication-review";
import { EXEMPT_SCREEN_DESCRIPTION } from "../backend/src/services/identifier-screen-stored";
import { reasonViewsOf } from "../backend/src/services/publication-review-view";
import { failingReport, screenReportBodyFor } from "../backend/test/helpers/publication-review";
import {
  APPROVAL_CLOSED_DURING_RUN_MESSAGE,
  APPROVAL_IN_FLIGHT_MESSAGE,
  APPROVAL_RELEASE_REASON_TEXT,
  DENY_AFTER_PUBLISHING_MESSAGE,
  INVALID_DATASET_ID_MESSAGE,
  REQUEST_MISMATCH_MESSAGE,
} from "../shared/contract/publication";
import {
  DATASET_STATUSES,
  SCREEN_ERRORS,
  SCREEN_NOT_READ,
  type ScreenReport,
  type ScreenState,
  dateWarningLines,
  describeScreen,
  parseScreenReport,
} from "../shared/identifier-screen-report";
import {
  APPROVAL_PUBLISHING_LINE,
  APPROVAL_STOPPED_HARD_LINE,
  DOCUMENT_LABEL,
  NOT_ASSESSED_LINE,
  PUBLICATION_DECLINE_DETAILS,
  PUBLICATION_FINDING_LABEL,
  PUBLICATION_OUTCOMES,
  PUBLICATION_RUN_ERRORS,
  type PublicationReviewReport,
  QUESTIONS,
  QUESTION_FACT_TEXT,
  QUESTION_LABEL,
  REASONS,
  REASON_CODES,
  REVIEW_DOCUMENTS,
  REVIEW_GATE_REFUSAL_TEXT,
  type ReasonCode,
  type ReviewRowView,
  describePublicationReview,
  describeUnreadableReview,
  neutralCureOf,
  parsePublicationReviewReport,
} from "../shared/publication-review";
import { MINIMUM_FAILURES } from "../shared/submission-minimums";
import { terminalFlaws } from "./helpers/terminal-words";

const ID = "nm000123";

describe("the checker itself", () => {
  test("flags every kind of terminal text and spares the platform's name", () => {
    const flagged: Array<[string, string]> = [
      ["nemar admin publish start nm000123", "a nemar command"],
      ["Start it (nemar admin publish start nm000123).", "a nemar command"],
      ["An administrator may approve over it (--force).", "a flag"],
      ['approve --acknowledge-identifier-screen "<reason>"', "a flag"],
      ["nemar admin publish show <dataset>", "a placeholder"],
      ["run `show`", "a backtick"],
      ["or approve it from a terminal", "the word terminal"],
      ["run this command", "the word command"],
      ["the CLI prints it", "the word CLI"],
      // Shapes a narrower rule let through (each was a gap before the rule was widened).
      ["Run nemar.", "a nemar command"],
      ["install the nemar-cli tool", "a nemar command"],
      ["use <dataset-id> here", "a placeholder"],
      ["use <Dataset> here", "a placeholder"],
      ["use <dataset id> here", "a placeholder"],
      ["pass -f to it", "a flag"],
      ["add it (-v)", "a flag"],
      ["open a shell", "the word shell"],
      ["from the terminals", "the word terminal"],
    ];
    for (const [text, rule] of flagged) {
      expect(terminalFlaws(text)).toContain(rule);
    }
    expect(terminalFlaws("NEMAR has a release of it")).toEqual([]);
    expect(terminalFlaws("NEMAR does not change them.")).toEqual([]);
    // Words the wider rules must still spare: a domain, a hyphenated compound, a dash in prose.
    expect(terminalFlaws("see nemar.org for the catalog")).toEqual([]);
    expect(terminalFlaws("a well-known, built-in rule - and the next")).toEqual([]);
    expect(terminalFlaws("the review is 10 < 20 and 5 > 3")).toEqual([]);
  });

  test("tier 1 spares the words that only point at a terminal", () => {
    expect(terminalFlaws("approve it from a terminal", 1)).toEqual([]);
    expect(terminalFlaws("the command line tool", 1)).toEqual([]);
    expect(terminalFlaws("approve it from a terminal", 2)).toContain("the word terminal");
  });
});

describe("every reason's sentence", () => {
  test("names no terminal, for every code in the table", () => {
    const codes = REASON_CODES.map((c) => c);
    expect(Object.keys(REASONS)).toEqual([...REASON_CODES]);
    let visited = 0;
    for (const code of codes) {
      expect(terminalFlaws(REASONS[code].sentence)).toEqual([]);
      visited++;
    }
    expect(visited).toBeGreaterThan(0);
  });
});

describe("the word tables the page prints", () => {
  // The page prints a finding's `label` and `document_label` and each fact note's `text`, and a
  // statement composes the question's label and the fact words. They reach a statement only for
  // the one failing question the other tests build, so each table is visited here, whole.
  test("a finding label, a document label, a fact text and a question label name no terminal", () => {
    const tables: Array<[string, Record<string, string>]> = [
      ["PUBLICATION_FINDING_LABEL", PUBLICATION_FINDING_LABEL],
      ["DOCUMENT_LABEL", DOCUMENT_LABEL],
      ["QUESTION_FACT_TEXT", QUESTION_FACT_TEXT],
      ["QUESTION_LABEL", QUESTION_LABEL],
    ];
    let visited = 0;
    for (const [table, words] of tables) {
      expect(Object.keys(words).length, table).toBeGreaterThan(0);
      for (const [key, text] of Object.entries(words)) {
        expect(text.length, `${table}.${key}`).toBeGreaterThan(0);
        expect(terminalFlaws(text), `${table}.${key}: ${text}`).toEqual([]);
        visited++;
      }
    }
    expect(visited).toBeGreaterThan(0);
  });
});

/** A block reason as the request's column holds it: a plain lowercase word. */
const BLOCK_REASON = "min_requirements_failed";

/** The details a reason of this code can carry, so every wording the producer can make is visited. */
function detailsOf(code: ReasonCode): Array<string | null> {
  switch (code) {
    case "question_failed":
    case "question_unknown":
      return [...QUESTIONS];
    case "text_withheld":
      return [...REVIEW_DOCUMENTS, REVIEW_DOCUMENTS.join(",")];
    case "review_could_not_run":
      return [...PUBLICATION_RUN_ERRORS];
    case "review_limit_reached":
      return [...PUBLICATION_DECLINE_DETAILS];
    case "submission_minimum_failed":
      return [...MINIMUM_FAILURES, MINIMUM_FAILURES.join(",")];
    case "request_blocked":
      return [BLOCK_REASON];
    default:
      return [null];
  }
}

const REPORTS: Array<PublicationReviewReport | null> = [
  null,
  parsePublicationReviewReport(failingReport()),
];
const STARTABLE = [true, false];
const IDS = [ID, "x y", ""];

describe("every reason, as the Worker sends it", () => {
  test("the page's fields hold no terminal text and the terminal's fields keep theirs", () => {
    const visitedCodes = new Set<ReasonCode>();
    let views = 0;
    for (const code of REASON_CODES) {
      for (const detail of detailsOf(code)) {
        for (const startable of STARTABLE) {
          for (const id of IDS) {
            for (const report of REPORTS) {
              const [view] = reasonViewsOf([{ code, detail }], id, startable, report);
              if (view === undefined) throw new Error(`no view for ${code}`);
              visitedCodes.add(code);
              views++;

              const where = `${code} detail=${detail} startable=${startable} id=${JSON.stringify(id)}`;
              // What the page prints.
              expect(terminalFlaws(view.cure), `cure of ${where}`).toEqual([]);
              expect(terminalFlaws(view.sentence), `sentence of ${where}`).toEqual([]);
              expect(view.statement, `statement of ${where}`).toBeDefined();
              expect(terminalFlaws(view.statement ?? ""), `statement of ${where}`).toEqual([]);
              expect(view.cure, `cure of ${where}`).toBe(neutralCureOf(code, id, startable));
              expect(view.cure.length, `cure of ${where}`).toBeGreaterThan(0);

              // What the page never prints: the command, and the line that holds it.
              expect(
                view.command === null || view.command?.startsWith("nemar admin publish "),
              ).toBe(true);
              if (view.command !== null && view.command !== undefined) {
                expect(view.cure, `cure of ${where}`).not.toContain(view.command);
                expect(view.line, `line of ${where}`).toContain(view.command);
              }
              expect(view.line, `line of ${where}`).toBeDefined();
              // A malformed id is never quoted, in a printed field or an unprinted one.
              if (id === "x y") {
                for (const text of [view.cure, view.statement, view.command, view.line]) {
                  expect(text ?? "", `quoted id in ${where}`).not.toContain(id);
                }
              }
            }
          }
        }
      }
    }
    expect(visitedCodes.size).toBe(REASON_CODES.length);
    expect(views).toBeGreaterThan(REASON_CODES.length);
  });

  test("a statement prints a closed word where no table of words exists for it, as the CLI's line does", () => {
    // The two codes whose detail has no word table: the request's block reason and the failed
    // minimums. Their statement is the CLI's own wording (`reasonLine` starts with it), so a
    // change to it moves the terminal's text too; this records that it is kept, not an oversight.
    // The closed word is snake case, never a command.
    const blocked = reasonViewsOf(
      [{ code: "request_blocked", detail: BLOCK_REASON }],
      ID,
      true,
      null,
    )[0];
    expect(blocked?.statement).toBe("The request is blocked (min_requirements_failed).");
    expect(blocked?.line?.startsWith(blocked?.statement ?? "\0")).toBe(true);
    const minimum = reasonViewsOf(
      [{ code: "submission_minimum_failed", detail: "name_too_short,no_authors" }],
      ID,
      true,
      null,
    )[0];
    expect(minimum?.statement).toContain("(name_too_short, no_authors)");
    expect(minimum?.line?.startsWith(minimum?.statement ?? "\0")).toBe(true);
  });

  test("a statement names the question and the findings, not the closed words", () => {
    let visited = 0;
    for (const code of ["question_failed", "question_unknown"] as const) {
      for (const question of QUESTIONS) {
        const [view] = reasonViewsOf([{ code, detail: question }], ID, true, REPORTS[1] ?? null);
        expect(view?.statement).toContain(QUESTION_LABEL[question]);
        expect(view?.statement).not.toContain(question);
        visited++;
      }
    }
    expect(visited).toBeGreaterThan(0);
    const [failed] = reasonViewsOf(
      [{ code: "question_failed", detail: "complete_and_honest" }],
      ID,
      true,
      REPORTS[1] ?? null,
    );
    expect(failed?.statement).toContain("README does not match the dataset");
  });
});

/** Every row a description can be built for, so every headline is reached. */
function rowsFor(report: PublicationReviewReport): ReviewRowView[] {
  return [
    { kind: "none" },
    { kind: "dispatched", overdue: false },
    { kind: "unreported" },
    { kind: "declined", detail: "platform_limit" },
    { kind: "errored", detail: "workflow_failed" },
    { kind: "reported", report, stored: "pass" },
    { kind: "reported", report: null, stored: "fail" },
  ];
}

describe("every description headline", () => {
  test("names no terminal, whatever the request, the flag and the approval", () => {
    const report = REPORTS[1];
    if (report === null || report === undefined) throw new Error("no report");
    const headlines = new Set<string>();
    let visited = 0;
    const base = {
      datasetId: ID,
      model: null,
      head: null,
      version: null,
    } as const;
    const add = (headline: string) => {
      expect(terminalFlaws(headline), headline).toEqual([]);
      headlines.add(headline);
      visited++;
    };
    // Not applicable, off with no row, and closed with no row.
    add(
      describePublicationReview({
        ...base,
        applies: false,
        outcome: null,
        enabled: true,
        reasons: [],
        row: { kind: "none" },
        startable: true,
      }).headline,
    );
    add(
      describePublicationReview({
        ...base,
        applies: true,
        outcome: null,
        enabled: false,
        reasons: [],
        row: { kind: "none" },
        startable: true,
      }).headline,
    );
    add(
      describePublicationReview({
        ...base,
        applies: true,
        outcome: null,
        enabled: true,
        closed: true,
        reasons: [],
        row: { kind: "none" },
        startable: true,
      }).headline,
    );
    // Each outcome, review on and off, for every reason alone and for none.
    for (const outcome of PUBLICATION_OUTCOMES) {
      for (const enabled of [true, false]) {
        for (const approval of ["none", "stopped", "publishing"] as const) {
          for (const startable of STARTABLE) {
            for (const row of rowsFor(report)) {
              if (!enabled && row.kind === "none") continue;
              const sets: Array<Array<{ code: ReasonCode; detail: string | null }>> = [
                [],
                ...REASON_CODES.map((code) => [{ code, detail: detailsOf(code)[0] ?? null }]),
              ];
              for (const reasons of sets) {
                const d = describePublicationReview({
                  ...base,
                  applies: true,
                  outcome,
                  enabled,
                  reasons,
                  row,
                  startable,
                  approval,
                });
                add(d.headline);
              }
            }
          }
        }
      }
    }
    add(describeUnreadableReview(ID).headline);
    expect(visited).toBeGreaterThan(REASON_CODES.length);
    // Each outcome's word, for the review on and off, and the three standing headlines.
    expect(headlines.size).toBeGreaterThanOrEqual(10);
  });
});

/** The states a screen can be in, with no report to say more. */
const SCREEN_STATES: ScreenState[] = ["pending", ...DATASET_STATUSES, "error", "unreported"];

function scanned(status: (typeof DATASET_STATUSES)[number]): ScreenReport {
  return parseScreenReport(screenReportBodyFor(ID, status));
}

describe("the identifier screen's words", () => {
  test("hold no terminal text in any state, cause or scan", () => {
    const seen: Array<[string, string[]]> = [];
    const note = (label: string, d: { headline: string; lines: string[] }) => {
      seen.push([`${label} headline`, [d.headline]]);
      seen.push([`${label} lines`, d.lines]);
    };

    note("no screen", describeScreen(null, null));
    for (const state of SCREEN_STATES) note(`state ${state}`, describeScreen(state, null));
    for (const error of SCREEN_ERRORS) {
      const report = parseScreenReport({ version: 1, scanner: null, head: null, error });
      note(`error ${error}`, describeScreen("error", report));
      note(`unreported ${error}`, describeScreen("unreported", report));
    }
    for (const status of DATASET_STATUSES) {
      note(`scan ${status}`, describeScreen(status, scanned(status)));
    }
    note("exempt", EXEMPT_SCREEN_DESCRIPTION);
    seen.push(["not read", [SCREEN_NOT_READ]]);
    seen.push(["dates-only", dateWarningLines({ status: "dates-only" })]);
    seen.push([
      "dates incomplete",
      dateWarningLines({ status: "dates-only", incomplete: true, findings_by_kind: {} }),
    ]);

    let strings = 0;
    for (const [label, texts] of seen) {
      for (const text of texts) {
        expect(terminalFlaws(text), `${label}: ${text}`).toEqual([]);
        strings++;
      }
    }
    expect(seen.length).toBeGreaterThan(SCREEN_STATES.length + SCREEN_ERRORS.length);
    expect(strings).toBeGreaterThan(SCREEN_STATES.length);
    // The date warning is in the loop: a screen that said nothing about dates would not count.
    expect(dateWarningLines({ status: "dates-only" }).length).toBeGreaterThan(0);
    expect(describeScreen("dates-only", scanned("dates-only")).lines.length).toBeGreaterThan(0);
  });
});

describe("the Worker sentences the page prints as they arrive", () => {
  test("the start refusals, the origin guard and the request refusals name no terminal", () => {
    const sentences: Array<[string, string]> = [
      ...Object.entries(START_REFUSALS).map(([k, v]): [string, string] => [`start ${k}`, v.error]),
      ...Object.entries(NOT_HANDED_OVER).map(([k, v]): [string, string] => [
        `not handed over ${k}`,
        v.error,
      ]),
      ["origin", ORIGIN_NOT_ALLOWED_MESSAGE],
      ["request mismatch", REQUEST_MISMATCH_MESSAGE],
      ["invalid dataset id", INVALID_DATASET_ID_MESSAGE],
      ["approval in flight", APPROVAL_IN_FLIGHT_MESSAGE],
      ["deny after publishing", DENY_AFTER_PUBLISHING_MESSAGE],
    ];
    for (const [label, text] of sentences) {
      expect(text.length, label).toBeGreaterThan(0);
      expect(terminalFlaws(text), `${label}: ${text}`).toEqual([]);
    }
    expect(Object.keys(START_REFUSALS).length).toBeGreaterThan(0);
    expect(Object.keys(NOT_HANDED_OVER).length).toBeGreaterThan(0);
  });

  test("the release reasons and the standing lines hold no command or flag", () => {
    const texts: Array<[string, string]> = [
      ...Object.entries(APPROVAL_RELEASE_REASON_TEXT).map(([k, v]): [string, string] => [k, v]),
      ["not assessed", NOT_ASSESSED_LINE],
      ["publishing", APPROVAL_PUBLISHING_LINE],
    ];
    for (const [label, text] of texts) {
      expect(terminalFlaws(text, 1), `${label}: ${text}`).toEqual([]);
    }
    expect(Object.keys(APPROVAL_RELEASE_REASON_TEXT).length).toBeGreaterThan(0);
  });
});

describe("the boundary: what the page must not print holds terminal text today", () => {
  test("the gate's terminal sentences, the stopped line and the closed-run message", () => {
    const texts: Array<[string, string]> = [
      ["gate needs_override", REVIEW_GATE_REFUSAL_TEXT.needs_override],
      ["gate override_not_covering", REVIEW_GATE_REFUSAL_TEXT.override_not_covering],
      ["gate review_changed", REVIEW_GATE_REFUSAL_TEXT.review_changed],
      ["gate no_review_row", REVIEW_GATE_REFUSAL_TEXT.no_review_row],
      ["approval stopped", APPROVAL_STOPPED_HARD_LINE],
      ["approval closed during run", APPROVAL_CLOSED_DURING_RUN_MESSAGE],
    ];
    for (const [label, text] of texts) {
      expect(terminalFlaws(text, 1).length, label).toBeGreaterThan(0);
    }
  });

  test("a reason's line and a description's next keep their commands", () => {
    const [view] = reasonViewsOf([{ code: "review_not_started", detail: null }], ID, true, null);
    expect(terminalFlaws(view?.line ?? "", 1)).toContain("a nemar command");
    expect(terminalFlaws(view?.command ?? "", 1)).toContain("a nemar command");
  });
});
