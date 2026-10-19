/**
 * The rules of `nemar admin publish next` (ADR 0102, section 8) that need no terminal and no
 * server: what each typed answer means, whether `y` is offered for a card and what it will ask,
 * which requests the walk shows and in what order, the size line and the card.
 *
 * `yAnswer` is built on `decideApproval` (which `approve` uses), so what is hard, what an override
 * covers and what the screen's acknowledgment is are the same rules here as there. The reasons are
 * made by the Worker's own `reasonViewsOf`, so a sentence or a class the table changes changes here
 * too; the walk against the real Worker is `admin-publish-next-cli.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { evidenceFor } from "../backend/test/helpers/publication-review";
import {
  HARD_REASONS,
  OVERRIDE_REASONS,
  type PublicationReviewEvidence,
  REASONS,
  type ReasonCode,
  cureOf,
  parsePublicationReviewEvidence,
} from "../shared/publication-review";
import { LineReader } from "../src/lib/prompt-lines";
import { type ReviewRead, reasonViewLine } from "../src/lib/publication-review-approve";
import {
  type NextTally,
  OBJECTS_PER_LOCK_CALL,
  SIZE_LINE_THRESHOLD,
  type YAnswer,
  cardLines,
  emptyTally,
  exitCodeOf,
  nextQueue,
  parseChoice,
  requestedAge,
  resumeOf,
  sizeLine,
  stillNeedYou,
  tallyLine,
  yAnswer,
} from "../src/lib/publication-review-next";
import { ID, type Spec, read, row, summary } from "./helpers/review-fixtures";

/** A card as plain text: the colour codes `chalk` adds, and only those, removed. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape that chalk writes.
const uncolored = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** `yAnswer` for a request that is not being resumed, unless the test says. */
const answerOf = (spec: Spec, force = false, resume = false) =>
  yAnswer(ID, read(spec), force, resume);

function offered(a: YAnswer) {
  if (!a.offered) throw new Error(`expected y to be offered, got: ${a.why}`);
  return a;
}

function refused(a: YAnswer) {
  if (a.offered) throw new Error(`expected y not to be offered, got ${JSON.stringify(a)}`);
  return a;
}

// ---------------------------------------------------------------------------------------------

describe("parseChoice: what a typed answer means", () => {
  test("y n c d s q, in either case and with spaces, and the words they stand for", () => {
    expect(["y", "Y", " yes "].map(parseChoice)).toEqual(["approve", "approve", "approve"]);
    expect(["n", "N", "no"].map(parseChoice)).toEqual(["deny", "deny", "deny"]);
    expect(["c", "comment"].map(parseChoice)).toEqual(["comment", "comment"]);
    expect(["d", "Details"].map(parseChoice)).toEqual(["details", "details"]);
    expect(["s", "skip"].map(parseChoice)).toEqual(["skip", "skip"]);
    expect(["q", "Quit"].map(parseChoice)).toEqual(["quit", "quit"]);
  });

  test("anything else, including an empty line, is not an answer", () => {
    for (const raw of ["", "  ", "x", "yy", "ok", "approve", "deny", "y n"]) {
      expect(parseChoice(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("yAnswer: a pass", () => {
  test("is offered, asks nothing, and sends no override", () => {
    for (const force of [false, true]) {
      const a = offered(answerOf({}, force));
      expect(a.askAcknowledgment).toBe(false);
      expect(a.overrideReasons).toEqual([]);
      expect(a.override).toBeNull();
    }
  });

  test("a gate that is off or does not apply gates nothing: offered, nothing to ask", () => {
    for (const gate of ["off", "n/a"] as const) {
      const a = offered(answerOf({ gate, reasons: ["question_failed"] }));
      expect(a.overrideReasons).toEqual([]);
      expect(a.override).toBeNull();
    }
  });
});

describe("yAnswer: a review that is not a pass needs --force", () => {
  const spec: Spec = { reasons: ["question_failed", "version_missing"] };

  test("without --force y is not offered, and the words name both ways forward", () => {
    const a = refused(answerOf(spec));
    expect(a.why).toContain("nemar admin publish next --force");
    expect(a.why).toContain(`nemar admin publish approve ${ID} --force`);
  });

  test("a stopped run's cure carries --resume, as approve's does", () => {
    const a = refused(answerOf({ ...spec, status: "approving" }, false, true));
    expect(a.why).toContain(`nemar admin publish approve ${ID} --resume --force`);
  });

  test("with --force it is offered, naming exactly the override-class reasons shown", () => {
    const a = offered(answerOf(spec, true));
    expect(a.overrideReasons).toEqual(["question_failed", "version_missing"]);
    expect(a.override).toEqual({ review_id: 11, reasons: ["question_failed", "version_missing"] });
    expect(a.askAcknowledgment).toBe(false);
  });

  test("the override is built from the review the card shows: its id, or null when there is none", () => {
    expect(offered(answerOf({ ...spec, reviewId: 42 }, true)).override?.review_id).toBe(42);
    expect(offered(answerOf({ ...spec, reviewId: null }, true)).override?.review_id).toBeNull();
  });

  test("every override-class reason, alone, needs --force and is then named", () => {
    for (const code of OVERRIDE_REASONS) {
      expect(refused(answerOf({ reasons: [code] })).why, code).toContain("--force");
      expect(offered(answerOf({ reasons: [code] }, true)).overrideReasons, code).toEqual([code]);
    }
  });

  test("an override already recorded for this review covers it: offered without --force, and the card says so", () => {
    const recorded = { by: 3, at: "2026-10-13 10:30:00", reasons: ["question_failed" as const] };
    const a = offered(answerOf({ reasons: ["question_failed"], override: recorded }));
    expect(a.overrideReasons).toEqual([]);
    expect(a.override).toBeNull();
    expect(a.notes.join(" ")).toContain("An override by administrator #3");
    // One that misses a reason does not cover it.
    const partial = answerOf({
      reasons: ["question_failed", "version_missing"],
      override: recorded,
    });
    expect(refused(partial).why).toContain("--force");
  });
});

describe("yAnswer: what nothing clears is never offered", () => {
  test("every hard reason, with and without --force, with and without the acknowledgment", () => {
    for (const code of HARD_REASONS) {
      for (const force of [false, true]) {
        const a = refused(answerOf({ reasons: [code] }, force));
        expect(a.why, code).toContain(cureOf(code, ID, true));
      }
    }
  });

  test("a hard reason next to an override-class one is still refused under --force", () => {
    const a = refused(
      answerOf({ reasons: ["submission_minimum_failed", "question_failed"] }, true),
    );
    expect(a.why).toContain(cureOf("submission_minimum_failed", ID, true));
  });

  test("a blocked request, whatever the gate says, with the block reason's words", () => {
    for (const gate of ["enforced", "off", "n/a"] as const) {
      const a = refused(answerOf({ status: "blocked", gate, blockReason: "ci_failed" }, true));
      expect(a.why).toContain("The request is blocked (ci_failed).");
    }
  });

  test("a run that has started publishing is offered only as a resume, and is not gated", () => {
    const spec: Spec = {
      status: "approving",
      startedPublishing: true,
      reasons: ["question_failed"],
    };
    expect(refused(answerOf(spec, false, false)).why).toContain("--resume");
    const a = offered(answerOf(spec, true, true));
    expect(a.override).toBeNull();
    expect(a.overrideReasons).toEqual([]);
    expect(a.askAcknowledgment).toBe(false);
  });
});

describe("yAnswer: the screen's acknowledgment is asked, never assumed", () => {
  const ack: ReasonCode = "identifier_screen_needs_acknowledgment";

  test("alone: offered, and y asks for the reason", () => {
    const a = offered(answerOf({ reasons: [ack] }));
    expect(a.askAcknowledgment).toBe(true);
    expect(a.overrideReasons).toEqual([]);
    expect(a.override).toBeNull();
  });

  test("already on record: nothing to ask, and the screen gate decides", () => {
    const a = offered(answerOf({ reasons: [ack], acknowledged: true }));
    expect(a.askAcknowledgment).toBe(false);
  });

  test("next to an override-class reason it needs --force as well, and with it asks both", () => {
    const spec: Spec = { reasons: [ack, "question_failed"] };
    expect(refused(answerOf(spec)).why).toContain("--force");
    const a = offered(answerOf(spec, true));
    expect(a.askAcknowledgment).toBe(true);
    // The acknowledgment reason is the screen's, not the override's.
    expect(a.overrideReasons).toEqual(["question_failed"]);
  });

  test("next to a hard reason it is refused, whatever is typed", () => {
    expect(refused(answerOf({ reasons: ["identifier_screen_blocks", ack] }, true)).why).toContain(
      cureOf("identifier_screen_blocks", ID, true),
    );
  });
});

describe("yAnswer: a review that could not be read is the Worker's to judge", () => {
  test("unreadable and absent: offered with nothing to send, and the note says why", () => {
    for (const r of [
      { kind: "unreadable", why: "HTTP 500" },
      { kind: "absent", why: "no_route" },
      { kind: "absent", why: "no_request" },
    ] as const) {
      const a = offered(yAnswer(ID, r, true, false));
      expect(a.override).toBeNull();
      expect(a.overrideReasons).toEqual([]);
      expect(a.askAcknowledgment).toBe(false);
      // The note that says why nothing was read, and the one that says `--force` was not sent
      // because there was no review to approve over.
      expect(a.notes.length).toBe(2);
      expect(a.notes[1]).toContain("--force was not sent");
      // Without `--force` there is nothing to say about it.
      expect(offered(yAnswer(ID, r, false, false)).notes.length).toBe(1);
    }
  });
});

describe("resumeOf", () => {
  test("a stopped run continues: steps done, or approving", () => {
    expect(resumeOf(row())).toBe(false);
    expect(resumeOf(row({ steps_completed: ["ci_check"] }))).toBe(true);
    expect(resumeOf(row({ status: "approving", steps_completed: [] }))).toBe(true);
  });
});

describe("nextQueue", () => {
  test("oldest request first, and the request id breaks a tie", () => {
    const rows = [
      row({ id: 3, dataset_id: "nm000003", requested_at: "2026-10-12 09:00:00" }),
      row({ id: 2, dataset_id: "nm000002", requested_at: "2026-10-10 09:00:00" }),
      row({ id: 5, dataset_id: "nm000005", requested_at: "2026-10-11 09:00:00" }),
      row({ id: 4, dataset_id: "nm000004", requested_at: "2026-10-11 09:00:00" }),
    ];
    expect(nextQueue(rows, new Set()).map((r) => r.dataset_id)).toEqual([
      "nm000002",
      "nm000004",
      "nm000005",
      "nm000003",
    ]);
  });

  test("only what needs an administrator: not blocked, in flight, over, or only waiting", () => {
    const rows = [
      row({ id: 1, dataset_id: "nm000001" }),
      row({ id: 2, dataset_id: "nm000002", status: "blocked" }),
      row({ id: 3, dataset_id: "nm000003", status: "approving", approval_in_flight: true }),
      row({
        id: 4,
        dataset_id: "nm000004",
        publication_review: summary({ reasons: ["review_running"] }),
      }),
      row({ id: 5, dataset_id: "nm000005", status: "published" }),
      row({ id: 6, dataset_id: "nm000006", status: "denied" }),
      row({ id: 7, dataset_id: "nm000007", status: "approving" }),
    ];
    expect(nextQueue(rows, new Set()).map((r) => r.dataset_id)).toEqual(["nm000001", "nm000007"]);
  });

  test("what was handled in this run is not shown again", () => {
    const rows = [
      row({ id: 1, dataset_id: "nm000001" }),
      row({ id: 2, dataset_id: "nm000002", requested_at: "2026-10-12 10:00:00" }),
    ];
    expect(nextQueue(rows, new Set(["nm000001"])).map((r) => r.dataset_id)).toEqual(["nm000002"]);
    expect(nextQueue(rows, new Set(["nm000001", "nm000002"]))).toEqual([]);
  });

  test("the list it was given is left as it was", () => {
    const rows = [
      row({ id: 2, dataset_id: "nm000002", requested_at: "2026-10-12 10:00:00" }),
      row({ id: 1, dataset_id: "nm000001", requested_at: "2026-10-10 10:00:00" }),
    ];
    const before = JSON.stringify(rows);
    nextQueue(rows, new Set());
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("sizeLine", () => {
  test("below the threshold, and when the count is not known, there is no line", () => {
    expect(sizeLine(SIZE_LINE_THRESHOLD - 1)).toBeNull();
    expect(sizeLine(4_999)).toBeNull();
    expect(sizeLine(0)).toBeNull();
    expect(sizeLine(null)).toBeNull();
  });

  test("at the threshold: the files, and the calls it takes to lock them", () => {
    expect(SIZE_LINE_THRESHOLD).toBe(5_000);
    expect(OBJECTS_PER_LOCK_CALL).toBe(100);
    expect(sizeLine(5_000)).toBe("about 5,000 files; locking them takes about 50 calls to the API");
    expect(sizeLine(12_400)).toBe(
      "about 12,400 files; locking them takes about 124 calls to the API",
    );
  });

  test("a count that is not a number is not believed", () => {
    // An older Worker sends no count; the type says number | null, the network says anything.
    for (const odd of [undefined, "12400", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sizeLine(odd as unknown as number | null)).toBeNull();
    }
  });

  test("a part of a call is a call", () => {
    expect(sizeLine(12_401)).toBe(
      "about 12,401 files; locking them takes about 125 calls to the API",
    );
  });

  test("says the duration in calls only: no minutes are claimed", () => {
    expect(sizeLine(50_000)).not.toMatch(/minute|second|hour/);
  });
});

/**
 * Run `body` with the process in time zone `zone` (Bun honours a change of `TZ` at run time), and
 * put the zone back afterwards. A test of a timestamp that carries no zone must not pass only
 * because the machine it runs on is in UTC, as a CI runner is.
 *
 * The zone is put back by assigning it, never by deleting `TZ`: Bun keeps the last zone it was
 * given after the key is deleted, so a delete would leave every later file in this process in the
 * zone of the call. `bun test` runs in UTC when `TZ` is unset, so UTC is what an unset one means.
 */
function inZone(zone: string, body: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    body();
  } finally {
    process.env.TZ = previous ?? "UTC";
  }
}

/** Zones west and east of UTC: a timestamp read in either as local time is hours off. */
const ZONES = ["America/Los_Angeles", "Pacific/Auckland"] as const;

describe("inZone", () => {
  // A date in October 2026: Los Angeles is on daylight time (UTC-7), Auckland too (UTC+13).
  const offsetNow = () => new Date("2026-10-13 12:00:00").getTimezoneOffset();

  // First of the file's uses of `inZone`: a restore that leaks would leave the next measurement
  // of "before" in the zone it leaked, and the test could not see it.
  test("puts the zone back, so no later test in the process is left in it", () => {
    // Bun keeps the last zone it was given when `TZ` is deleted, so a restore that deletes the key
    // leaves the process in the zone of the call: every later file would then read a timestamp
    // with no zone (SQLite's UTC ones) as local time.
    const before = offsetNow();
    inZone("America/Los_Angeles", () => {});
    expect(offsetNow()).toBe(before);
    inZone("Pacific/Auckland", () => {});
    expect(offsetNow()).toBe(before);
  });

  test("really changes the zone inside the call", () => {
    inZone("America/Los_Angeles", () => expect(offsetNow()).toBe(420));
    inZone("Pacific/Auckland", () => expect(offsetNow()).toBe(-780));
  });
});

describe("requestedAge", () => {
  test("a timestamp the database wrote (UTC, no zone) is read as UTC, in any time zone", () => {
    const now = Date.parse("2026-10-14T09:14:03Z");
    for (const zone of ["UTC", ...ZONES]) {
      inZone(zone, () => {
        expect(requestedAge("2026-10-12 09:14:03", now)).toBe("2d");
        expect(requestedAge("2026-10-14 08:14:03", now)).toBe("1h");
        expect(requestedAge("2026-10-14T09:04:03Z", now)).toBe("10m");
      });
    }
  });

  test("a timestamp that is not one says so", () => {
    expect(requestedAge("not a time")).toBe("?");
  });
});

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

describe("cardLines", () => {
  const now = Date.parse("2026-10-14T09:14:03Z");
  const card = (spec: Spec, force = false, over: Partial<Parameters<typeof cardLines>[0]> = {}) => {
    const r = read(spec);
    return uncolored(
      cardLines({
        position: 1,
        total: 3,
        row: row(),
        read: r,
        answer: yAnswer(ID, r, force, false),
        force,
        now,
        ...over,
      }).join("\n"),
    );
  };

  test("the first line says where it is, who asked, what kind and how long ago", () => {
    const text = card({});
    expect(text.split("\n")[0]).toBe(`[1 of 3] ${ID}  alice  named publication  requested 2d ago`);
  });

  test("how long ago does not depend on the zone the machine is in", () => {
    for (const zone of ZONES) {
      inZone(zone, () => {
        expect(card({}).split("\n")[0]).toBe(
          `[1 of 3] ${ID}  alice  named publication  requested 2d ago`,
        );
      });
    }
  });

  test("an anonymous release is said as one", () => {
    expect(card({ anonymous: true })).toContain("ANONYMOUS RELEASE");
    expect(card({ anonymous: true })).not.toContain("named publication");
  });

  test("the screen and the review in the Worker's words", () => {
    const text = card({ reasons: ["question_failed"] });
    expect(text).toContain("Screen:   Identifier screen: clean");
    expect(text).toContain("Review:   Publication review: action required");
    expect(text).toContain(REASONS.question_failed.sentence);
  });

  test("a reason reads as the line the Worker sent, the same words approve prints", () => {
    // `text_withheld` carries closed words (readme, participants_json); the words for a person are
    // the shared ones, and the card, `d` and the refusal of `approve` all say the same thing.
    const reasons: Spec["reasons"] = [["text_withheld", "readme,participants_json"]];
    const text = card({ reasons }, true);
    expect(text).toContain("(README, participants.json)");
    expect(text).not.toContain("(readme, participants_json)");
    expect(text).not.toContain("participants_json");
    const r = read({ reasons });
    if (r.kind !== "detail") throw new Error("expected a detail");
    expect(text).toContain(reasonViewLine(r.detail.reasons[0]));
  });

  test("a Worker that sent no line is read as approve reads it: the sentence and the cure, never the closed words", () => {
    const r = read({ reasons: [["text_withheld", "readme,participants_json"]] });
    if (r.kind !== "detail") throw new Error("expected a detail");
    // An old Worker sent neither `line`, `statement` nor `command`, nor the detail's
    // `start_offered` and `screen_gate`, and its `cure` was the terminal's text (`cureOf`, for a
    // request `start` can reach), where the Worker now sends the neutral one.
    const { start_offered: _offered, screen_gate: _gate, ...oldDetail } = r.detail;
    const old: ReviewRead = {
      kind: "detail",
      detail: {
        ...(oldDetail as typeof r.detail),
        reasons: r.detail.reasons.map(
          ({ line: _line, statement: _statement, command: _command, ...rest }) => ({
            ...rest,
            cure: cureOf(rest.code, ID, true),
          }),
        ),
      },
    };
    expect(old.detail.reasons[0].cure).toContain("--force");
    const text = uncolored(
      cardLines({
        position: 1,
        total: 3,
        row: row(),
        read: old,
        answer: yAnswer(ID, old, true, false),
        force: true,
        now,
      }).join("\n"),
    );
    expect(text).toContain(
      `${REASONS.text_withheld.sentence} ${cureOf("text_withheld", ID, true)}`,
    );
    expect(text).not.toContain("participants_json");
    expect(text).not.toContain("readme");
  });

  test("at most six reasons, then how many more", () => {
    const eight: ReasonCode[] = [
      "question_failed",
      "steering_attempt",
      "bids_failed_at_review",
      "version_already_released",
      "version_malformed",
      "stored_verdict_fail",
      "review_not_started",
      "text_withheld",
    ];
    const lines = card({ reasons: eight }).split("\n");
    const shown = lines.filter((l) => /^ {12}\S/.test(l) && !l.includes("+"));
    expect(shown).toHaveLength(6);
    expect(lines.some((l) => l.trim() === "+2 more (d shows them)")).toBe(true);
    const six = card({ reasons: eight.slice(0, 6) });
    expect(six).not.toContain("more (d shows them)");
  });

  test("the version it would publish, or that none was read", () => {
    const evidence = (over: Partial<PublicationReviewEvidence>) =>
      parsePublicationReviewEvidence(evidenceFor(undefined, false, over));
    expect(card({ evidence: evidence({ version: "1.2.0" }) })).toContain("Version:  1.2.0");
    // The version an approval publishes, not the evidence's own: a description with none is 1.0.0.
    expect(card({ evidence: evidence({ version: null, version_shape: "missing" }) })).toContain(
      "Version:  1.0.0",
    );
    expect(
      card({
        evidence: evidence({ version: null, version_shape: "malformed", tag: "not_applicable" }),
      }),
    ).toContain("Version:  malformed (X.Y.Z expected)");
    expect(card({ reasons: [] })).toContain("Version:  not read (no report)");
    expect(card({ reviewId: null })).toContain("Version:  not read (no report)");
  });

  test("the size line only for a large dataset", () => {
    expect(card({ totalFiles: 12_400 })).toContain(
      "Size:     about 12,400 files; locking them takes about 124 calls to the API",
    );
    expect(card({ totalFiles: 4_999 })).not.toContain("Size:");
    expect(card({ totalFiles: null })).not.toContain("Size:");
  });

  test("y not offered says why; offered under --force says it will ask; a pass says neither", () => {
    expect(card({ reasons: ["question_failed"] })).toContain("y is not offered:");
    expect(card({ reasons: ["submission_minimum_failed"] }, true)).toContain("y is not offered:");
    expect(card({ reasons: ["question_failed"] }, true)).toContain(
      "--force: y will ask you to confirm each reason",
    );
    const pass = card({});
    expect(pass).not.toContain("y is not offered");
    expect(pass).not.toContain("--force");
  });

  test("an acknowledgment that y will ask for is said before it is asked", () => {
    expect(card({ reasons: ["identifier_screen_needs_acknowledgment"] })).toContain(
      "y will ask for your reason",
    );
  });

  test("a review that could not be read still has a card, from the list row", () => {
    const unread: ReviewRead = { kind: "unreadable", why: "HTTP 500" };
    const text = uncolored(
      cardLines({
        position: 2,
        total: 2,
        row: row({
          publication_review: summary({ headline: "Publication review: action required" }),
        }),
        read: unread,
        answer: yAnswer(ID, unread, false, false),
        force: false,
        now,
      }).join("\n"),
    );
    expect(text).toContain(`[2 of 2] ${ID}  alice`);
    expect(text).toContain("Publication review: action required");
    expect(text).toContain("could not be read (HTTP 500)");
    expect(text).toContain("Version:  not read");
  });

  test("everything that came from the network passes through plain()", () => {
    // An escape sequence that rewrites the screen, and a bidirectional override.
    const hostile = `${String.fromCharCode(0x1b)}[2Jbob${String.fromCharCode(0x202e)}`;
    const r = read({});
    const text = uncolored(
      cardLines({
        position: 1,
        total: 1,
        row: row({ requested_by_username: hostile }),
        read: r,
        answer: yAnswer(ID, r, false, false),
        force: false,
        now,
      }).join("\n"),
    );
    expect(text).toContain("[2Jbob");
    for (const line of text.split("\n")) expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });
});

describe("the tally and the exit code", () => {
  const tally = (over: Partial<NextTally> = {}): NextTally => ({ ...emptyTally(), ...over });

  test("nothing done says so; what was done is counted in the order it was asked", () => {
    expect(tallyLine(tally())).toBe("Nothing was changed.");
    expect(tallyLine(tally({ approved: 2, denied: 1, commented: 3, skipped: 4, failed: 5 }))).toBe(
      "Done: 2 approved, 1 denied, 3 commented, 4 skipped, 5 failed.",
    );
    expect(tallyLine(tally({ skipped: 1 }))).toBe("Done: 1 skipped.");
  });

  test("skipped and failed are what still needs the administrator; the rest is done", () => {
    expect(stillNeedYou(tally({ approved: 3, denied: 2, commented: 1 }))).toBe(0);
    expect(stillNeedYou(tally({ skipped: 2, failed: 1 }))).toBe(3);
  });

  test("0 when nothing failed, 1 when anything did, 130 when interrupted, whatever else", () => {
    expect(exitCodeOf(tally(), false)).toBe(0);
    expect(exitCodeOf(tally({ approved: 2, skipped: 1, commented: 1 }), false)).toBe(0);
    expect(exitCodeOf(tally({ failed: 1 }), false)).toBe(1);
    expect(exitCodeOf(tally({ approved: 5, failed: 1 }), false)).toBe(1);
    expect(exitCodeOf(tally(), true)).toBe(130);
    expect(exitCodeOf(tally({ failed: 2 }), true)).toBe(130);
  });
});

describe("LineReader.open", () => {
  test("is true while the input can still be read, false once it has ended or the reader was closed", async () => {
    const ended = new LineReader(new PassThrough(), new PassThrough());
    expect(ended.open).toBe(true);
    ended.close();
    expect(ended.open).toBe(false);

    const input = new PassThrough();
    const piped = new LineReader(input, new PassThrough());
    const waiting = piped.ask("? ");
    input.end();
    expect(await waiting).toBeNull();
    expect(piped.open).toBe(false);
  });
});

describe("LineReader.canAnswer and interrupt", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("canAnswer: an input that ended still answers with the lines it left, then no longer", async () => {
    // A piped script is read to its end at once: the input has ended while its answers are waiting.
    const input = new PassThrough();
    const reader = new LineReader(input, new PassThrough());
    expect(reader.canAnswer).toBe(true);
    input.write("y\nq\n");
    input.end();
    await tick();
    expect(reader.open).toBe(false);
    expect(reader.canAnswer).toBe(true);
    expect(await reader.ask("? ")).toBe("y");
    expect(reader.canAnswer).toBe(true);
    expect(await reader.ask("? ")).toBe("q");
    expect(reader.canAnswer).toBe(false);
    expect(await reader.ask("? ")).toBeNull();
  });

  test("canAnswer: false once the reader was closed with nothing queued, true while it is open", () => {
    const reader = new LineReader(new PassThrough(), new PassThrough());
    expect(reader.canAnswer).toBe(true);
    reader.close();
    expect(reader.canAnswer).toBe(false);
  });

  test("interrupt: ends the input as Ctrl+C does, drops what was queued and says it was an interrupt", async () => {
    const input = new PassThrough();
    const reader = new LineReader(input, new PassThrough());
    input.write("y\n");
    await tick();

    reader.interrupt();

    expect(reader.interrupted).toBe(true);
    expect(reader.open).toBe(false);
    expect(reader.canAnswer).toBe(false);
    expect(await reader.ask("? ")).toBeNull();
  });
});
