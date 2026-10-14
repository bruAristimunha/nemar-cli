/**
 * What `nemar admin publish approve` decides before it asks (ADR 0102, sections 8 and 9).
 *
 * `decideApproval` is a pure function of the review the administrator was SHOWN (the detail the
 * command read), the three flags that are theirs (`--force`, `--acknowledge-identifier-screen`,
 * `--resume`) and nothing else. It has no `yes` input on purpose: `--yes` answers the question, and
 * can never stand in for a reason, for the force or for the screen's acknowledgment.
 *
 * The rule these tests hold it to: it may REFUSE only where the Worker's gate would also refuse (or
 * where an explicit flag is missing), and where it lets a run through it sends an override built
 * only from what was shown. The ten steps run in a fixed order, so most cases here are the same
 * review under two different flags. The reasons are made by the Worker's own `reasonViewsOf`, so a
 * sentence, a cure or a class the table changes changes here too, and the agreement with the real
 * gate is tested end to end in `admin-publish-approve-agreement.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { PublicationReviewDetail } from "../shared/contract/publication-review-admin";
import {
  HARD_REASONS,
  OVERRIDE_REASONS,
  REASONS,
  REASON_CODES,
  type ReasonCode,
  reasonLine,
  reviewGateRefusalText,
} from "../shared/publication-review";
import { ApiError } from "../src/lib/api/errors";
import {
  type ApproveDecision,
  type ApproveOptions,
  decideApproval,
  parseReviewDetail,
  reasonViewLine,
} from "../src/lib/publication-review-approve";
import { ID, type Spec, detailOf, read } from "./helpers/review-fixtures";

/** The reasons of `detail` as a Worker that sends `line` sends them: the whole reason in the shared words. */
function withLines(detail: PublicationReviewDetail): PublicationReviewDetail {
  return {
    ...detail,
    reasons: detail.reasons.map((r) => ({
      ...r,
      line: reasonLine({ code: r.code, detail: r.detail }, ID, null, false),
    })),
  };
}

const NO_FLAGS: ApproveOptions = { force: false, acknowledge: undefined, resume: false };
const FORCE: ApproveOptions = { ...NO_FLAGS, force: true };

function decide(spec: Spec, options: ApproveOptions = NO_FLAGS): ApproveDecision {
  return decideApproval(ID, read(spec), options);
}

/** The refusal, or a failed test that says what happened instead. */
function refusal(d: ApproveDecision) {
  if (d.kind !== "refuse") throw new Error(`expected a refusal, got ${JSON.stringify(d)}`);
  return d;
}

function proceeds(d: ApproveDecision) {
  if (d.kind !== "proceed") throw new Error(`expected to proceed, got ${JSON.stringify(d)}`);
  return d;
}

describe("1. a review that could not be read is the Worker's to judge", () => {
  test("unreadable: proceed with no override, and say why", () => {
    const d = proceeds(decideApproval(ID, { kind: "unreadable", why: "HTTP 500" }, NO_FLAGS));
    expect(d.override).toBeNull();
    expect(d.notes).toEqual([
      "The publication review could not be read (HTTP 500); the API still checks it.",
    ]);
  });

  test("a backend with no review route", () => {
    const d = proceeds(decideApproval(ID, { kind: "absent", why: "no_route" }, NO_FLAGS));
    expect(d.override).toBeNull();
    expect(d.notes).toEqual(["This API has no publication review."]);
  });

  test("no active request: the Worker answers 404, the CLI does not decide for it", () => {
    const d = proceeds(decideApproval(ID, { kind: "absent", why: "no_request" }, NO_FLAGS));
    expect(d.override).toBeNull();
    expect(d.notes.join(" ")).toContain("No active publication request");
  });

  test("--force sends nothing when nothing was read: an override is built only from what was shown", () => {
    for (const r of [
      { kind: "unreadable", why: "x" },
      { kind: "absent", why: "no_route" },
      { kind: "absent", why: "no_request" },
    ] as const) {
      expect(proceeds(decideApproval(ID, r, FORCE)).override).toBeNull();
    }
  });

  test("the Worker's own refusal of the read (a bad id, no key, not an administrator) changes nothing for a caller that does not stop on it", () => {
    // `approve` stops on `refused`; `next` does not read it, and decides as it did.
    const refused = new ApiError(403, "Admin access required");
    const d = proceeds(
      decideApproval(ID, { kind: "unreadable", why: "HTTP 403", refused }, NO_FLAGS),
    );
    expect(d.notes).toEqual([
      "The publication review could not be read (HTTP 403); the API still checks it.",
    ]);
  });

  test("--force says it was not sent, for every read that gave nothing to override", () => {
    // Otherwise the API's "approve over it with --force" reaches someone who just passed it.
    const NOT_SENT = "--force was not sent: no review could be read to approve over.";
    const reads = [
      { kind: "unreadable", why: "HTTP 500" },
      { kind: "absent", why: "no_route" },
      { kind: "absent", why: "no_request" },
    ] as const;
    for (const r of reads) {
      const withForce = proceeds(decideApproval(ID, r, FORCE));
      expect(withForce.notes, r.kind + r.why).toHaveLength(2);
      expect(withForce.notes[1]).toBe(NOT_SENT);
      // ... and says nothing about it when it was not given.
      expect(proceeds(decideApproval(ID, r, NO_FLAGS)).notes.join(" ")).not.toContain("--force");
    }
  });
});

describe("2. a run that has started publishing is continued, not gated", () => {
  const spec = {
    status: "approving",
    startedPublishing: true,
    reasons: ["review_running" as const],
  };

  test("without --resume the CLI names the cure and nothing is sent", () => {
    const d = refusal(decide(spec));
    expect(d.why).toBe("needs_resume");
    expect(d.lines.join(" ")).toContain(`nemar admin publish approve ${ID} --resume`);
    expect(refusal(decide(spec, FORCE)).why).toBe("needs_resume");
  });

  test("with --resume it proceeds with no override, whatever the gate", () => {
    for (const gate of ["enforced", "off", "n/a"] as const) {
      const d = proceeds(decide({ ...spec, gate }, { ...NO_FLAGS, resume: true }));
      expect(d.override).toBeNull();
      expect(d.notes.join(" ")).toContain(
        "a resume that has started publishing is not gated again",
      );
    }
  });

  test("not even a hard reason or a missing acknowledgment stops it, and --force adds nothing", () => {
    const hard = { ...spec, reasons: ["identifier_screen_blocks" as const] };
    const d = proceeds(decide(hard, { force: true, acknowledge: undefined, resume: true }));
    expect(d.override).toBeNull();
    const ack = { ...spec, reasons: ["identifier_screen_needs_acknowledgment" as const] };
    expect(proceeds(decide(ack, { ...NO_FLAGS, resume: true })).override).toBeNull();
  });

  test("a blocked run that has started publishing (the owner-name walk-back) is continued the same way, not refused as blocked", () => {
    // The Worker refuses a blocked request only when it never started a step; the detail says
    // `started_publishing` for this one whatever the status string, so the CLI does not refuse
    // what the Worker would pass.
    const blockedMidRun = {
      status: "blocked",
      startedPublishing: true,
      blockReason: "owner_name_missing",
      reasons: ["request_blocked" as const],
    };
    const needs = refusal(decide(blockedMidRun));
    expect(needs.why).toBe("needs_resume");
    expect(needs.lines.join(" ")).toContain(`nemar admin publish approve ${ID} --resume`);
    expect(refusal(decide(blockedMidRun, FORCE)).why).toBe("needs_resume");
    for (const gate of ["enforced", "off", "n/a"] as const) {
      const d = proceeds(decide({ ...blockedMidRun, gate }, { ...NO_FLAGS, resume: true }));
      expect(d.override).toBeNull();
    }
  });

  test("a blocked request that never started publishing is still refused as blocked", () => {
    const never = { status: "blocked", startedPublishing: false, blockReason: "ci_failed" };
    expect(refusal(decide(never, { ...NO_FLAGS, resume: true })).why).toBe("blocked");
  });

  test("an approving run that has NOT started publishing is gated like a fresh one", () => {
    const stopped = {
      status: "approving",
      startedPublishing: false,
      reasons: ["review_running" as const],
    };
    expect(refusal(decide(stopped, { ...NO_FLAGS, resume: true })).why).toBe("needs_force");
  });
});

describe("3. a blocked request that has not started publishing is refused whatever the gate says", () => {
  test("with the gate off, where the reasons are empty, the status is what says so", () => {
    const d = refusal(
      decide({ status: "blocked", gate: "off", blockReason: "min_requirements_failed" }),
    );
    expect(d.why).toBe("blocked");
    expect(d.lines.join("\n")).toContain("The request is blocked (min_requirements_failed).");
    expect(d.lines.join("\n")).toContain(REASONS.request_blocked.cure);
  });

  test("with the gate enforced, and with --force", () => {
    for (const gate of ["enforced", "n/a"] as const) {
      const spec = {
        status: "blocked",
        gate,
        reasons: ["request_blocked" as const],
        blockReason: "ci_failed",
      };
      expect(refusal(decide(spec)).why).toBe("blocked");
      expect(refusal(decide(spec, FORCE)).why).toBe("blocked");
    }
  });

  test("a block reason that has a hint carries it, as the Worker's refusal does", () => {
    const d = refusal(
      decide({ status: "blocked", gate: "off", blockReason: "owner_name_missing" }),
    );
    expect(d.lines.join("\n")).toContain("nemar admin backfill-names");
  });

  test("a blocked request with no block reason still says it is blocked", () => {
    const d = refusal(decide({ status: "blocked", gate: "off", blockReason: null }));
    expect(d.lines[0]).toContain("The request is blocked.");
  });
});

describe("4. a gate that is off or does not apply is not enforced", () => {
  test("off: proceed with no override and no note", () => {
    const d = proceeds(decide({ gate: "off" }));
    expect(d.override).toBeNull();
    expect(d.notes).toEqual([]);
  });

  test("off or n/a with reasons shown (a stored review is advice): still not refused", () => {
    for (const gate of ["off", "n/a"] as const) {
      const spec = { gate, reasons: ["question_failed" as const, "review_running" as const] };
      const d = proceeds(decide(spec));
      expect(d.override).toBeNull();
    }
  });

  test("--force changes nothing there, and the note says so", () => {
    for (const gate of ["off", "n/a"] as const) {
      const d = proceeds(decide({ gate, reasons: ["question_failed"] }, FORCE));
      expect(d.override).toBeNull();
      expect(d.notes).toEqual([`--force changes nothing: the review gate is ${gate}.`]);
    }
  });
});

describe("5. a hard reason is refused, with the cure, even with --force", () => {
  test("the refusal's own sentence is the gate's, then one line per hard reason, from the Worker's own words", () => {
    const spec = {
      reasons: ["request_blocked", "submission_minimum_failed", "question_failed"] as ReasonCode[],
    };
    for (const options of [NO_FLAGS, FORCE]) {
      const d = refusal(decide(spec, options));
      expect(d.why).toBe("hard");
      expect(d.lines).toHaveLength(3);
      expect(d.lines[0]).toBe(reviewGateRefusalText("hard_reason", ID));
      expect(d.lines[1]).toContain(REASONS.request_blocked.sentence.replace(/\.$/, ""));
      expect(d.lines[1]).toContain(REASONS.request_blocked.cure);
      expect(d.lines[2]).toContain(REASONS.submission_minimum_failed.cure);
    }
  });

  test("a reason prints as the line the Worker sent, and as sentence and cure when it sent none", () => {
    const shown: Spec = { reasons: [["submission_minimum_failed", "name_too_short,no_authors"]] };
    // A Worker that sends `line`: the whole reason, as its description words it.
    const withLine = decideApproval(
      ID,
      { kind: "detail", detail: withLines(detailOf(shown)) },
      FORCE,
    );
    const line = reasonLine(
      { code: "submission_minimum_failed", detail: "name_too_short,no_authors" },
      ID,
      null,
      false,
    );
    expect(refusal(withLine).lines[1]).toBe(line);
    // An older Worker sends none: sentence and cure, and not the closed words behind the reason.
    // `detailOf` builds its reasons through the Worker's own `reasonViewsOf`, which now sends a
    // `line`; drop it to stand for a Worker that predates the field.
    const old = detailOf(shown);
    const without = refusal(
      decideApproval(
        ID,
        {
          kind: "detail",
          detail: { ...old, reasons: old.reasons.map(({ line: _line, ...r }) => r) },
        },
        FORCE,
      ),
    );
    expect(without.lines[1]).toBe(
      `${REASONS.submission_minimum_failed.sentence} ${REASONS.submission_minimum_failed.cure}`,
    );
    expect(without.lines[1]).not.toContain("name_too_short");
  });

  test("every hard reason refuses, alone", () => {
    for (const code of HARD_REASONS) {
      expect(refusal(decide({ reasons: [code] }, FORCE)).why, code).toBe("hard");
    }
  });

  test("a hard reason outranks the acknowledgment and the force", () => {
    const spec = {
      reasons: [
        "identifier_screen_blocks",
        "identifier_screen_needs_acknowledgment",
      ] as ReasonCode[],
    };
    expect(
      refusal(decide(spec, { force: true, acknowledge: "a reason long enough", resume: false }))
        .why,
    ).toBe("hard");
  });
});

describe("6. the screen's acknowledgment is its own reason, cleared by its own flag", () => {
  const spec = { reasons: ["identifier_screen_needs_acknowledgment" as const] };

  test("not given and not recorded: refused with that reason's sentence and cure", () => {
    const d = refusal(decide(spec));
    expect(d.why).toBe("needs_ack");
    expect(d.lines.join(" ")).toContain(REASONS.identifier_screen_needs_acknowledgment.sentence);
    expect(d.lines.join(" ")).toContain("--acknowledge-identifier-screen");
  });

  test("--force does not stand in for it", () => {
    expect(refusal(decide(spec, FORCE)).why).toBe("needs_ack");
  });

  test("given this run: it is not the CLI's to refuse, and nothing is overridden by it", () => {
    const d = proceeds(decide(spec, { ...NO_FLAGS, acknowledge: "a reason long enough" }));
    expect(d.override).toBeNull();
  });

  test("recorded earlier (by anyone: the Worker decides whose it must be)", () => {
    expect(proceeds(decide({ ...spec, acknowledged: true })).override).toBeNull();
  });

  test("when the review is not a pass either, the refusal says --force is needed as well", () => {
    const both = {
      reasons: ["identifier_screen_needs_acknowledgment", "review_not_started"] as ReasonCode[],
    };
    const d = refusal(decide(both));
    expect(d.why).toBe("needs_ack");
    expect(d.lines.join(" ")).toContain("--force");
    // ... and does not say so when the one reason is the only one.
    expect(refusal(decide(spec)).lines.join(" ")).not.toContain("--force");
  });

  test("when a recorded override already covers the rest, the refusal does not ask for --force", () => {
    const both = {
      reasons: ["identifier_screen_needs_acknowledgment", "review_not_started"] as ReasonCode[],
      override: {
        by: 3,
        at: "2026-10-13 09:30:00",
        reasons: ["review_not_started"] as ReasonCode[],
      },
    };
    expect(refusal(decide(both)).lines.join(" ")).not.toContain("--force");
  });
});

describe("7. nothing for an override to clear", () => {
  test("a pass proceeds with no override, with and without --force", () => {
    for (const options of [NO_FLAGS, FORCE]) {
      const d = proceeds(decide({ reasons: [] }, options));
      expect(d.override).toBeNull();
      expect(d.notes).toEqual([]);
    }
  });

  test("only the acknowledgment reason, once acknowledged: nothing is overridden", () => {
    const spec = {
      reasons: ["identifier_screen_needs_acknowledgment" as const],
      acknowledged: true,
    };
    expect(proceeds(decide(spec, FORCE)).override).toBeNull();
  });
});

describe("8. --force sends exactly what was shown", () => {
  test("the review id in force and every override-class code shown, in the table's order", () => {
    const shown: ReasonCode[] = ["question_failed", "bids_failed_at_review", "text_withheld"];
    const d = proceeds(decide({ reasons: shown, reviewId: 42 }, FORCE));
    expect(d.override).toEqual({ review_id: 42, reasons: shown });
    expect(d.notes).toEqual([
      "Approving over: question_failed, bids_failed_at_review, text_withheld (--force; recorded with your account).",
    ]);
  });

  test("the acknowledgment reason is not part of an override, nor is anything that was not shown", () => {
    const shown: ReasonCode[] = ["identifier_screen_needs_acknowledgment", "review_running"];
    const d = proceeds(decide({ reasons: shown, acknowledged: true }, FORCE));
    expect(d.override?.reasons).toEqual(["review_running"]);
    for (const code of d.override?.reasons ?? []) expect(OVERRIDE_REASONS).toContain(code);
  });

  test("with no review row the id is null, which the Worker accepts from a terminal", () => {
    const d = proceeds(decide({ reasons: ["review_not_started"], reviewId: null }, FORCE));
    expect(d.override).toEqual({ review_id: null, reasons: ["review_not_started"] });
  });

  test("every override-class reason alone is sent as itself", () => {
    for (const code of OVERRIDE_REASONS) {
      expect(proceeds(decide({ reasons: [code] }, FORCE)).override?.reasons, code).toEqual([code]);
    }
  });

  test("--force with the acknowledgment given sends the same override", () => {
    const shown: ReasonCode[] = ["identifier_screen_needs_acknowledgment", "review_not_started"];
    const d = proceeds(
      decide(
        { reasons: shown },
        { force: true, acknowledge: "a reason long enough", resume: false },
      ),
    );
    expect(d.override).toEqual({ review_id: 11, reasons: ["review_not_started"] });
  });
});

describe("9. a recorded override covers the run without --force", () => {
  const recorded = (reasons: ReasonCode[]) => ({ by: 5, at: "2026-10-13 09:45:00", reasons });

  test("when it names every override-class reason: proceed, send nothing, and say whose it is", () => {
    const shown: ReasonCode[] = ["question_failed", "review_running"];
    const d = proceeds(decide({ reasons: shown, override: recorded(shown) }));
    expect(d.override).toBeNull();
    expect(d.notes.join(" ")).toContain(
      "An override by administrator #5 at 2026-10-13 09:45:00 covers these reasons.",
    );
    expect(d.notes.join(" ")).toContain("only for a run recorded as theirs");
  });

  test("when it misses one code the run is refused, and --force is the way", () => {
    const shown: ReasonCode[] = ["question_failed", "review_running"];
    const d = refusal(decide({ reasons: shown, override: recorded(["question_failed"]) }));
    expect(d.why).toBe("needs_force");
  });

  test("hard and acknowledgment codes in the record cover nothing", () => {
    const d = refusal(
      decide({
        reasons: ["review_running"],
        override: recorded(["identifier_screen_needs_acknowledgment", "request_blocked"]),
      }),
    );
    expect(d.why).toBe("needs_force");
  });

  test("a record that names more than is shown still covers it", () => {
    const d = proceeds(
      decide({
        reasons: ["review_running"],
        override: recorded(["review_running", "question_failed"]),
      }),
    );
    expect(d.override).toBeNull();
  });

  test("--force is the administrator's own act and still sends its own override over a record", () => {
    const d = proceeds(
      decide({ reasons: ["review_running"], override: recorded(["review_running"]) }, FORCE),
    );
    expect(d.override).toEqual({ review_id: 11, reasons: ["review_running"] });
  });
});

describe("10. otherwise the CLI asks for --force", () => {
  const spec = { reasons: ["question_failed" as const] };

  test("the refusal names the command and the way to read the reasons", () => {
    const d = refusal(decide(spec));
    expect(d.why).toBe("needs_force");
    const text = d.lines.join("\n");
    // The gate's own sentence for this refusal, then the exact command.
    expect(d.lines[0]).toBe(reviewGateRefusalText("needs_override", ID));
    expect(text).toContain(`nemar admin publish approve ${ID} --force`);
  });

  test("it repeats the acknowledgment and the resume the administrator gave or needs", () => {
    const d = refusal(
      decide(
        { ...spec, status: "approving" },
        { force: false, acknowledge: "a reason long enough", resume: true },
      ),
    );
    expect(d.lines.join("\n")).toContain(
      `nemar admin publish approve ${ID} --resume --acknowledge-identifier-screen "<reason>" --force`,
    );
    // An approving run that stopped before it published is gated again, so the cure carries --resume.
    expect(refusal(decide({ ...spec, status: "approving" })).lines.join("\n")).toContain(
      "--resume",
    );
    expect(refusal(decide(spec)).lines.join("\n")).not.toContain("--resume");
    expect(refusal(decide(spec)).lines.join("\n")).not.toContain("--acknowledge-identifier-screen");
  });

  test("every override-class reason, alone, needs it", () => {
    for (const code of OVERRIDE_REASONS) {
      expect(refusal(decide({ reasons: [code] })).why, code).toBe("needs_force");
    }
  });
});

describe("--yes is the answer to the question and has no way in", () => {
  test("decideApproval takes no yes, and one smuggled in changes nothing", () => {
    expect(decideApproval.length).toBe(3);
    const spec = { reasons: ["question_failed" as const] };
    const smuggled = { ...NO_FLAGS, yes: true } as unknown as ApproveOptions;
    expect(decide(spec, smuggled)).toEqual(decide(spec, NO_FLAGS));
    expect(refusal(decide(spec, smuggled)).why).toBe("needs_force");
    const ack = { reasons: ["identifier_screen_needs_acknowledgment" as const] };
    expect(refusal(decide(ack, { ...NO_FLAGS, yes: true } as unknown as ApproveOptions)).why).toBe(
      "needs_ack",
    );
    const hard = { reasons: ["request_blocked" as const] };
    expect(refusal(decide(hard, { ...NO_FLAGS, yes: true } as unknown as ApproveOptions)).why).toBe(
      "hard",
    );
  });
});

describe("the whole table: every reason lands in exactly one branch", () => {
  test("hard refuses, the acknowledgment asks for its flag, the rest ask for --force, and --force sends the rest", () => {
    for (const code of REASON_CODES) {
      const rule = REASONS[code];
      const without = decide({ reasons: [code] });
      const forced = decide({ reasons: [code] }, FORCE);
      if (rule.clearedBy === "nothing") {
        expect(refusal(without).why, code).toBe("hard");
        expect(refusal(forced).why, code).toBe("hard");
      } else if (rule.clearedBy === "screen_acknowledgment") {
        expect(refusal(without).why, code).toBe("needs_ack");
        expect(refusal(forced).why, code).toBe("needs_ack");
      } else {
        expect(refusal(without).why, code).toBe("needs_force");
        expect(proceeds(forced).override?.reasons, code).toEqual([code]);
      }
    }
  });
});

describe("reasonViewLine: the words of one reason", () => {
  const view = (over: Partial<Parameters<typeof reasonViewLine>[0]> = {}) => ({
    sentence: "A sentence.",
    cure: "A cure.",
    ...over,
  });

  test("the whole line the Worker sent, when it sent one", () => {
    expect(reasonViewLine(view({ line: "The whole reason (in words). A cure." }))).toBe(
      "The whole reason (in words). A cure.",
    );
  });

  test("the sentence and the cure when it sent none, or an empty one", () => {
    expect(reasonViewLine(view())).toBe("A sentence. A cure.");
    expect(reasonViewLine(view({ line: "" }))).toBe("A sentence. A cure.");
  });

  test("a detailed reason reads as the shared words, not as the closed words", () => {
    // `text_withheld` carries closed words (readme, participants_json); the words for a person are
    // what the review above the question printed, and the refusal below it must say the same.
    const reason = { code: "text_withheld" as const, detail: "readme,participants_json" };
    const line = reasonLine(reason, ID, null, false);
    expect(line).toContain("(README, participants.json)");
    const [shown] = withLines(detailOf({ reasons: [["text_withheld", reason.detail]] })).reasons;
    expect(reasonViewLine(shown)).toBe(line);
    expect(reasonViewLine(shown)).not.toContain("participants_json");
  });
});

describe("parseReviewDetail: a review this CLI cannot read is not guessed at", () => {
  const good = () => JSON.parse(JSON.stringify(detailOf({ reasons: ["review_running"] })));

  test("the detail the Worker sends is read as it is", () => {
    const raw = good();
    expect(parseReviewDetail(raw)).toEqual(raw);
  });

  test("a reason code this CLI does not know (a newer server) is unreadable, not a crash", () => {
    const raw = good();
    raw.reasons[0].code = "a_reason_from_the_future";
    expect(parseReviewDetail(raw)).toBeNull();
  });

  test("a reason the API classifies differently from this CLI's table is unreadable, so the API decides", () => {
    // A newer API that moved a reason from "override" to "nothing" (or back) would otherwise leave
    // this CLI refusing as hard what the API accepts, or sending an override for what it refuses.
    for (const code of REASON_CODES) {
      for (const other of ["nothing", "screen_acknowledgment", "override"] as const) {
        const raw = JSON.parse(JSON.stringify(detailOf({ reasons: [code] })));
        raw.reasons[0].cleared_by = other;
        if (other === REASONS[code].clearedBy) {
          expect(parseReviewDetail(raw), `${code} as ${other}`).not.toBeNull();
        } else {
          expect(parseReviewDetail(raw), `${code} as ${other}`).toBeNull();
        }
      }
    }
    const raw = good();
    raw.reasons[0].cleared_by = "something_new";
    expect(parseReviewDetail(raw)).toBeNull();
  });

  test("a missing or mistyped field the decision reads is unreadable", () => {
    const mutations: Array<(r: Record<string, unknown>) => void> = [
      (r) => Reflect.deleteProperty(r, "gate"),
      (r) => {
        r.gate = "sometimes";
      },
      (r) => {
        r.reasons = "none";
      },
      (r) => {
        r.request_status = 3;
      },
      (r) => {
        r.started_publishing = "no";
      },
      (r) => {
        r.block_reason = 4;
      },
      (r) => {
        r.screen_acknowledgment = "yes";
      },
      (r) => {
        r.review = { id: "x" };
      },
      (r) => {
        r.review = { id: 1, override: { by: 1, at: "t", reasons: "all" } };
      },
      (r) => {
        r.description = null;
      },
    ];
    for (const mutate of mutations) {
      const raw = good();
      mutate(raw);
      expect(parseReviewDetail(raw), mutate.toString()).toBeNull();
    }
    expect(parseReviewDetail(null)).toBeNull();
    expect(parseReviewDetail("nope")).toBeNull();
    expect(parseReviewDetail([])).toBeNull();
  });

  test("an override record may be null or complete", () => {
    const raw = good();
    raw.review.override = { by: 5, at: "2026-10-13 09:45:00", reasons: ["review_running"] };
    expect(parseReviewDetail(raw)).not.toBeNull();
    raw.review = null;
    expect(parseReviewDetail(raw)).not.toBeNull();
  });
});
