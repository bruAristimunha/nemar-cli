/**
 * The cure of a reason, as a terminal prints it, pinned reason by reason (ADR 0102, section 5).
 *
 * Phase 4 splits each cure into text a page can print and the command a terminal runs. The
 * split must not move one byte of what the CLI, the email and the gate's refusal message print,
 * so this block holds the composed cures as test-local literals captured from the tree BEFORE
 * the split, and imports no constant that the split touches. It is never edited by a later
 * commit: that is the proof that the CLI's text did not move.
 *
 * CI TIER: unit-pure. Pure: no database, no network, no spawn.
 */

import { describe, expect, test } from "bun:test";
import {
  REASONS,
  REASON_CODES,
  type ReasonCode,
  cureOf,
  reasonLine,
} from "../shared/publication-review";

const ID = "nm000123";

const TERM_OVERRIDE =
  "An administrator may approve over it; the approval records the override (--force).";
const TERM_NOT_STARTABLE = `A review starts only for a request that is waiting for its decision. ${TERM_OVERRIDE}`;

/** `notStartable` is absent where it equals `startable`. */
const GOLDEN: Record<string, { startable: string; notStartable?: string }> = {
  request_blocked: {
    startable: "The depositor fixes what blocked it and requests publication again.",
  },
  submission_minimum_failed: {
    startable:
      "The depositor fixes the dataset and requests publication again; a request still waiting for its decision is moved to blocked.",
  },
  identifier_screen_blocks: {
    startable:
      "The depositor removes it and requests publication again, which runs the screen again.",
  },
  identifier_screen_not_run: {
    startable: "An administrator runs the screen again: nemar admin publish screen nm000123.",
  },
  identifier_screen_pending: {
    startable: "Wait for it to report; the review starts when it does.",
  },
  identifier_screen_stale: {
    startable: "An administrator runs the screen again: nemar admin publish screen nm000123.",
  },
  version_kept_after_anonymous_release: {
    startable:
      "The depositor raises Version in dataset_description.json and requests publication again.",
  },
  identifier_screen_needs_acknowledgment: {
    startable:
      'An administrator reads what the screen reported and approves with a recorded reason: nemar admin publish approve nm000123 --acknowledge-identifier-screen "<reason>".',
  },
  question_failed: { startable: `Read any findings and the dataset's text. ${TERM_OVERRIDE}` },
  steering_attempt: {
    startable: `Read the dataset's text yourself; the review's answers cannot be relied on. ${TERM_OVERRIDE}`,
  },
  bids_failed_at_review: {
    startable: `The depositor fixes the validation errors and requests publication again. ${TERM_OVERRIDE}`,
  },
  version_already_released: {
    startable: `The depositor raises Version in dataset_description.json. ${TERM_OVERRIDE}`,
  },
  version_malformed: { startable: `The depositor corrects Version. ${TERM_OVERRIDE}` },
  stored_verdict_fail: {
    startable: `Read the review's record: nemar admin publish show nm000123. ${TERM_OVERRIDE}`,
  },
  review_not_started: {
    startable: `Start it: nemar admin publish start nm000123. ${TERM_OVERRIDE}`,
    notStartable: TERM_NOT_STARTABLE,
  },
  review_running: {
    startable: `Wait for it to report; it usually takes minutes. ${TERM_OVERRIDE}`,
  },
  review_did_not_report: {
    startable: `Start it again: nemar admin publish start nm000123. ${TERM_OVERRIDE}`,
    notStartable: TERM_NOT_STARTABLE,
  },
  review_limit_reached: {
    startable: `Start it later: nemar admin publish start nm000123; an administrator's start is held by the platform's limit only. ${TERM_OVERRIDE}`,
    notStartable: TERM_NOT_STARTABLE,
  },
  review_could_not_run: {
    startable: `Once the cause is fixed, start it again: nemar admin publish start nm000123. ${TERM_OVERRIDE}`,
    notStartable: TERM_NOT_STARTABLE,
  },
  text_withheld: { startable: `Read the withheld documents yourself. ${TERM_OVERRIDE}` },
  question_unknown: { startable: `Answer it yourself from the dataset. ${TERM_OVERRIDE}` },
  bids_unconcluded_at_review: {
    startable: `Check the validation run of that commit. ${TERM_OVERRIDE}`,
  },
  version_missing: {
    startable: `Confirm that 1.0.0 is right, or have the depositor set Version. ${TERM_OVERRIDE}`,
  },
  doi_state_unexpected: { startable: `Check the DOI record before approving. ${TERM_OVERRIDE}` },
};

/** The terminal's cure for a code, for the stated standing of the request. */
function expected(code: string, startable: boolean): string {
  const g = GOLDEN[code];
  if (g === undefined) throw new Error(`no golden entry for ${code}`);
  return startable ? g.startable : (g.notStartable ?? g.startable);
}

describe("the terminal's cure is pinned for every reason code", () => {
  test("the golden names exactly the reason codes, so a new code needs an entry", () => {
    expect(Object.keys(GOLDEN)).toEqual([...REASON_CODES]);
  });

  test("cureOf returns the pinned text for every code, startable or not", () => {
    let visited = 0;
    for (const code of REASON_CODES) {
      for (const startable of [true, false]) {
        expect(cureOf(code, ID, startable)).toBe(expected(code, startable));
        visited++;
      }
    }
    expect(visited).toBe(REASON_CODES.length * 2);
  });

  test("reasonLine is the sentence, a space and the pinned cure", () => {
    for (const code of REASON_CODES) {
      for (const startable of [true, false]) {
        const line = reasonLine({ code, detail: null }, ID, null, startable);
        expect(line).toBe(`${REASONS[code].sentence} ${expected(code, startable)}`);
      }
    }
  });

  test("a malformed id keeps the placeholder and is never quoted, for every code", () => {
    for (const code of REASON_CODES as readonly ReasonCode[]) {
      for (const bad of ["x y", "", "nm00012"]) {
        for (const startable of [true, false]) {
          const text = cureOf(code, bad, startable);
          const want = expected(code, startable).replaceAll(ID, "<dataset>");
          expect(text).toBe(want);
          if (bad !== "") expect(text).not.toContain(bad);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The split: what a page prints (`neutralCureOf`), what a terminal runs (`commandOf`), and the
// words of a reason without its cure (`reasonStatement`). Everything above this line is the
// golden, captured before the split and not edited since.
// ---------------------------------------------------------------------------------------------

import { failingReport, goodPublicationReport } from "../backend/test/helpers/publication-review";
import {
  APPROVAL_STOPPED_HARD_LINE,
  REVIEW_GATE_REFUSAL_TEXT,
  START_CURE_REASONS,
  commandOf,
  describePublicationReview,
  neutralCureOf,
  parsePublicationReviewReport,
  reasonStatement,
  reviewGateRefusalText,
} from "../shared/publication-review";
import { terminalFlaws } from "./helpers/terminal-words";

const NEUTRAL_OVERRIDE = "An administrator may approve over it; the approval records the override.";
const NEUTRAL_NOT_STARTABLE = `A review starts only for a request that is waiting for its decision. ${NEUTRAL_OVERRIDE}`;

/** What a page prints for each cure, written out by hand; `notStartable` absent means the same. */
const NEUTRAL: Record<string, { startable: string; notStartable?: string }> = {
  request_blocked: {
    startable: "The depositor fixes what blocked it and requests publication again.",
  },
  submission_minimum_failed: {
    startable:
      "The depositor fixes the dataset and requests publication again; a request still waiting for its decision is moved to blocked.",
  },
  identifier_screen_blocks: {
    startable:
      "The depositor removes it and requests publication again, which runs the screen again.",
  },
  identifier_screen_not_run: { startable: "An administrator runs the screen again." },
  identifier_screen_pending: {
    startable: "Wait for it to report; the review starts when it does.",
  },
  identifier_screen_stale: { startable: "An administrator runs the screen again." },
  version_kept_after_anonymous_release: {
    startable:
      "The depositor raises Version in dataset_description.json and requests publication again.",
  },
  identifier_screen_needs_acknowledgment: {
    startable:
      "An administrator reads what the screen reported and approves with a recorded reason.",
  },
  question_failed: { startable: `Read any findings and the dataset's text. ${NEUTRAL_OVERRIDE}` },
  steering_attempt: {
    startable: `Read the dataset's text yourself; the review's answers cannot be relied on. ${NEUTRAL_OVERRIDE}`,
  },
  bids_failed_at_review: {
    startable: `The depositor fixes the validation errors and requests publication again. ${NEUTRAL_OVERRIDE}`,
  },
  version_already_released: {
    startable: `The depositor raises Version in dataset_description.json. ${NEUTRAL_OVERRIDE}`,
  },
  version_malformed: { startable: `The depositor corrects Version. ${NEUTRAL_OVERRIDE}` },
  stored_verdict_fail: { startable: `Read the review's record. ${NEUTRAL_OVERRIDE}` },
  review_not_started: {
    startable: `Start it. ${NEUTRAL_OVERRIDE}`,
    notStartable: NEUTRAL_NOT_STARTABLE,
  },
  review_running: {
    startable: `Wait for it to report; it usually takes minutes. ${NEUTRAL_OVERRIDE}`,
  },
  review_did_not_report: {
    startable: `Start it again. ${NEUTRAL_OVERRIDE}`,
    notStartable: NEUTRAL_NOT_STARTABLE,
  },
  review_limit_reached: {
    startable: `Start it later; an administrator's start is held by the platform's limit only. ${NEUTRAL_OVERRIDE}`,
    notStartable: NEUTRAL_NOT_STARTABLE,
  },
  review_could_not_run: {
    startable: `Once the cause is fixed, start it again. ${NEUTRAL_OVERRIDE}`,
    notStartable: NEUTRAL_NOT_STARTABLE,
  },
  text_withheld: { startable: `Read the withheld documents yourself. ${NEUTRAL_OVERRIDE}` },
  question_unknown: { startable: `Answer it yourself from the dataset. ${NEUTRAL_OVERRIDE}` },
  bids_unconcluded_at_review: {
    startable: `Check the validation run of that commit. ${NEUTRAL_OVERRIDE}`,
  },
  version_missing: {
    startable: `Confirm that 1.0.0 is right, or have the depositor set Version. ${NEUTRAL_OVERRIDE}`,
  },
  doi_state_unexpected: { startable: `Check the DOI record before approving. ${NEUTRAL_OVERRIDE}` },
};

const SCREEN_CMD = "nemar admin publish screen nm000123";
const START_CMD = "nemar admin publish start nm000123";
const SHOW_CMD = "nemar admin publish show nm000123";
const ACK_CMD = 'nemar admin publish approve nm000123 --acknowledge-identifier-screen "<reason>"';

/** The command each terminal cure names; every other code names none. */
const COMMANDS: Record<string, string> = {
  identifier_screen_not_run: SCREEN_CMD,
  identifier_screen_stale: SCREEN_CMD,
  identifier_screen_needs_acknowledgment: ACK_CMD,
  stored_verdict_fail: SHOW_CMD,
  review_not_started: START_CMD,
  review_did_not_report: START_CMD,
  review_limit_reached: START_CMD,
  review_could_not_run: START_CMD,
};

const neutralExpected = (code: string, startable: boolean): string => {
  const g = NEUTRAL[code];
  if (g === undefined) throw new Error(`no neutral golden entry for ${code}`);
  return startable ? g.startable : (g.notStartable ?? g.startable);
};

describe("the neutral cure is what a page prints", () => {
  test("the neutral golden names exactly the reason codes", () => {
    expect(Object.keys(NEUTRAL)).toEqual([...REASON_CODES]);
  });

  test("neutralCureOf is the pinned text for every code, startable or not", () => {
    let visited = 0;
    for (const code of REASON_CODES) {
      for (const startable of [true, false]) {
        expect(neutralCureOf(code, ID, startable)).toBe(neutralExpected(code, startable));
        visited++;
      }
    }
    expect(visited).toBe(REASON_CODES.length * 2);
  });

  test("a malformed id leaves no placeholder and no echo of what was sent", () => {
    for (const code of REASON_CODES) {
      for (const bad of ["x y", "", "nm00012"]) {
        for (const startable of [true, false]) {
          const text = neutralCureOf(code, bad, startable);
          expect(text).toBe(neutralExpected(code, startable));
          expect(text).not.toContain("<dataset>");
          if (bad !== "") expect(text).not.toContain(bad);
        }
      }
    }
  });

  test("the neutral cure is shorter than the terminal's exactly where a command or the flag was removed", () => {
    for (const code of REASON_CODES) {
      const terminal = cureOf(code, ID, true);
      const neutral = neutralCureOf(code, ID, true);
      const named = commandOf(code, ID, true) !== null;
      const flagged = REASONS[code].clearedBy === "override";
      expect(neutral === terminal).toBe(!named && !flagged);
    }
  });
});

describe("the command is what a terminal runs", () => {
  test("commandOf is the pinned command for the eight cures that name one, and null for the rest", () => {
    let named = 0;
    for (const code of REASON_CODES) {
      const want = COMMANDS[code] ?? null;
      expect(commandOf(code, ID, true)).toBe(want);
      if (want !== null) named++;
    }
    expect(named).toBe(8);
  });

  test("the four start codes name no command for a request no start can reach", () => {
    for (const code of START_CURE_REASONS) {
      expect(commandOf(code, ID, false)).toBeNull();
    }
    // Every other code is the same whether or not a start can reach the request.
    for (const code of REASON_CODES) {
      if (START_CURE_REASONS.includes(code)) continue;
      expect(commandOf(code, ID, false)).toBe(commandOf(code, ID, true));
    }
  });

  test("a malformed id keeps the placeholder and is never quoted", () => {
    for (const code of Object.keys(COMMANDS) as ReasonCode[]) {
      for (const bad of ["x y", "", "nm00012"]) {
        const text = commandOf(code, bad, true);
        expect(text).toBe((COMMANDS[code] ?? "").replaceAll(ID, "<dataset>"));
        if (bad !== "" && text !== null) expect(text).not.toContain(bad);
      }
    }
  });
});

describe("the reasons table holds the split together", () => {
  const codes = Object.keys(REASONS) as ReasonCode[];

  test("I1: a command sits in the terminal cure as `: <command>`, whole, closed by a period or a semicolon", () => {
    for (const code of codes) {
      const { command, cure } = REASONS[code];
      if (command === undefined) continue;
      const at = cure.indexOf(`: ${command}`);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(cure.charAt(at + 2 + command.length)).toMatch(/^[.;]$/);
    }
  });

  test("I2: every command is an administrator's publish command", () => {
    for (const code of codes) {
      const { command } = REASONS[code];
      if (command !== undefined) expect(command).toStartWith("nemar admin publish ");
    }
  });

  test("I3: an override-class cure ends with the override sentence, and so does its alternative, which names no command", () => {
    for (const code of codes) {
      const rule = REASONS[code];
      if (rule.clearedBy !== "override") continue;
      expect(rule.cure).toEndWith(TERM_OVERRIDE);
      if (rule.cureNotStartable !== undefined) {
        expect(rule.cureNotStartable).toEndWith(TERM_OVERRIDE);
        expect(terminalFlaws(rule.cureNotStartable.replace(TERM_OVERRIDE, ""), 1)).toEqual([]);
      }
    }
  });

  test("I4: a rule with no command names no command in its cure", () => {
    for (const code of codes) {
      const rule = REASONS[code];
      if (rule.command !== undefined) continue;
      expect(rule.cure.replace(TERM_OVERRIDE, "")).not.toContain("nemar ");
    }
  });

  test("I5: the start codes are exactly the codes whose command is the start command", () => {
    const byCommand = codes.filter(
      (c) => REASONS[c].command === "nemar admin publish start <dataset>",
    );
    expect([...START_CURE_REASONS].sort()).toEqual([...byCommand].sort());
    expect(START_CURE_REASONS.length).toBe(4);
  });
});

describe("a reason's line is its statement and its terminal cure", () => {
  const report = parsePublicationReviewReport(failingReport());
  const reports = [null, report];
  const reasonsFor = (code: ReasonCode) => [
    { code, detail: null },
    ...(code === "question_failed" ? [{ code, detail: "complete_and_honest" }] : []),
    ...(code === "review_could_not_run" ? [{ code, detail: "model_refused" }] : []),
  ];

  test("for every code, detail, report and standing", () => {
    let visited = 0;
    for (const code of REASON_CODES) {
      for (const reason of reasonsFor(code)) {
        for (const r of reports) {
          for (const startable of [true, false]) {
            expect(reasonLine(reason, ID, r, startable)).toBe(
              `${reasonStatement(reason, r)} ${cureOf(code, ID, startable)}`,
            );
            visited++;
          }
        }
      }
    }
    expect(visited).toBeGreaterThan(REASON_CODES.length * 4);
  });

  test("a statement with a detail is the sentence without its period, then the detail in brackets", () => {
    const statement = reasonStatement(
      { code: "question_failed", detail: "complete_and_honest" },
      report,
    );
    expect(statement).toBe(
      "A question of the review failed (the README is complete and agrees with the dataset; findings: README does not match the dataset).",
    );
    expect(reasonStatement({ code: "question_failed", detail: "complete_and_honest" }, null)).toBe(
      "A question of the review failed (the README is complete and agrees with the dataset).",
    );
    expect(reasonStatement({ code: "review_could_not_run", detail: "model_refused" }, null)).toBe(
      "The review could not run (the reviewing model declined to review).",
    );
  });

  test("a statement with no detail is the rule's sentence, unchanged", () => {
    for (const code of REASON_CODES) {
      expect(reasonStatement({ code, detail: null }, null)).toBe(REASONS[code].sentence);
    }
    // A good report has nothing to add to a reason that has no detail.
    const good = parsePublicationReviewReport(goodPublicationReport());
    expect(reasonStatement({ code: "text_withheld", detail: null }, good)).toBe(
      REASONS.text_withheld.sentence,
    );
  });
});

describe("a reason's command is the command `next` names", () => {
  const common = {
    datasetId: ID,
    applies: true,
    enabled: true,
    outcome: null,
    model: "claude-haiku-5-5",
    head: "a".repeat(40),
    version: "1.2.0",
  } as const;
  const nextOf = (code: ReasonCode) =>
    describePublicationReview({
      ...common,
      reasons: [{ code, detail: null }],
      row: { kind: "none" },
      startable: true,
    }).next;

  test("for the screen's hard reasons, the start codes and the acknowledgment", () => {
    const agreeing: ReasonCode[] = [
      "identifier_screen_not_run",
      "identifier_screen_stale",
      "identifier_screen_needs_acknowledgment",
      ...START_CURE_REASONS,
    ];
    expect(agreeing).toHaveLength(7);
    for (const code of agreeing) {
      const command = commandOf(code, ID, true);
      expect(command).not.toBeNull();
      expect(nextOf(code)).toBe(command);
    }
  });

  test("the acknowledgment command is `next` only until the state adds a flag to it", () => {
    // `next` appends `--resume` (a stopped approval) before the acknowledgment and `--force` after
    // it (an override-class reason also stands); the reason's own command carries neither, so the
    // two agree for the plain case above and `next` is the longer one in these.
    const ack = commandOf("identifier_screen_needs_acknowledgment", ID, true);
    expect(ack).toBe(
      `nemar admin publish approve ${ID} --acknowledge-identifier-screen "<reason>"`,
    );
    const stopped = describePublicationReview({
      ...common,
      reasons: [{ code: "identifier_screen_needs_acknowledgment", detail: null }],
      row: { kind: "none" },
      startable: false,
      approval: "stopped",
    }).next;
    expect(stopped).toBe(
      `nemar admin publish approve ${ID} --resume --acknowledge-identifier-screen "<reason>"`,
    );
    const forced = describePublicationReview({
      ...common,
      reasons: [
        { code: "identifier_screen_needs_acknowledgment", detail: null },
        { code: "question_failed", detail: "complete_and_honest" },
      ],
      row: { kind: "none" },
      startable: false,
    }).next;
    expect(forced).toBe(`${ack} --force`);
  });
});

describe("the sentences built from the command constants keep their text", () => {
  // These were string literals and are now built from `COMMAND_*`; the literals here are what they
  // said before, so moving a constant's spelling cannot move a sentence silently.
  test("the gate's refusal sentences and the stopped-approval line", () => {
    expect(REVIEW_GATE_REFUSAL_TEXT.needs_override).toBe(
      "The publication review is not a pass. Read it (nemar admin publish show <dataset>), then approve over it with --force, which records the override with your account.",
    );
    expect(REVIEW_GATE_REFUSAL_TEXT.override_not_covering).toBe(
      "The review now gives a reason the override was not given for. Read it again (nemar admin publish show <dataset>) before approving.",
    );
    expect(REVIEW_GATE_REFUSAL_TEXT.review_changed).toBe(
      "The review the override was given for is no longer the review of this request, or it changed while the approval was being checked. Read it again (nemar admin publish show <dataset>) before approving.",
    );
    expect(REVIEW_GATE_REFUSAL_TEXT.no_review_row).toBe(
      "No review of this commit is on record to attach the override to. Start it (nemar admin publish start <dataset>), or approve from a terminal with --force.",
    );
    expect(APPROVAL_STOPPED_HARD_LINE).toBe(
      "This approval stopped before it started publishing, and a reason that nothing clears now stands, so it cannot be resumed. Deny it with a reason (nemar admin publish deny <dataset>); the depositor can request again.",
    );
  });

  test("a gate sentence fills the id, and a malformed id is never quoted", () => {
    expect(reviewGateRefusalText("needs_override", ID)).toContain(`show ${ID})`);
    expect(reviewGateRefusalText("needs_override", "x y")).toContain("show <dataset>)");
    expect(reviewGateRefusalText("needs_override", "x y")).not.toContain("x y");
  });
});

describe("what a page prints names no terminal", () => {
  test("every neutral cure and every sentence is free of a command, a flag, a placeholder and the words that point at a terminal", () => {
    let visited = 0;
    for (const code of REASON_CODES) {
      expect(terminalFlaws(REASONS[code].sentence)).toEqual([]);
      for (const startable of [true, false]) {
        expect(terminalFlaws(neutralCureOf(code, ID, startable))).toEqual([]);
        expect(terminalFlaws(neutralCureOf(code, "x y", startable))).toEqual([]);
        visited++;
      }
    }
    expect(visited).toBeGreaterThan(0);
  });

  test("the terminal cures do hold what the checker forbids, so the boundary is recorded", () => {
    for (const code of Object.keys(COMMANDS)) {
      expect(terminalFlaws(cureOf(code as ReasonCode, ID, true), 1)).not.toEqual([]);
    }
    expect(terminalFlaws(cureOf("question_failed", ID, true), 1)).toEqual(["a flag"]);
  });
});
