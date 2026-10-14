/**
 * What `nemar admin publish approve` prints from the network, and the rule that none of it can act
 * on a terminal (ADR 0102, section 8; P2-1 of the Phase 2 review).
 *
 * Text that came from the network passes `plain()` where `approve` prints it: the screen and the
 * review, the notes, the refusal, the reasons of a Worker's refusal, the retry notice, the result
 * of a run and the failure. The Worker has already reduced the words it stores, and the spawned
 * command's suite (`admin-publish-approve-cli.test.ts`) goes through that Worker, so it would pass
 * with every `plain()` of this command deleted. This file feeds hostile text straight in:
 *
 *  - the pure line builders the command prints from, one by one;
 *  - the whole `runApproval` loop in this process, against a stand-in for the Worker that answers
 *    what a hostile or broken one could: a 5xx that is retried, then a refusal, then a result,
 *    each carrying an escape sequence that clears the screen, a title sequence, a bell and a
 *    bidirectional override. Nothing but the Worker's answers is canned.
 *
 * CI TIER: integration, like the other suites that point the client at a local server.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { reasonViewsOf } from "../backend/src/services/publication-review-view";
import { evidenceFor, failingReport } from "../backend/test/helpers/publication-review";
import type { PublicationReviewDetail } from "../shared/contract/publication-review-admin";
import { NOT_ASSESSED_LINE } from "../shared/publication-review";
import {
  noteLines,
  refusalLines,
  refusalReasons,
  registerApproveCommand,
  resultLines,
  retryNoticeLines,
  reviewLines,
  reviewRefusalLines,
  runApproval,
  timelineLines,
} from "../src/commands/admin-publish-approve";
import { ApiError } from "../src/lib/api/errors";
import { decideApproval } from "../src/lib/publication-review-approve";

const ESC = String.fromCharCode(27);
/** Colour sequences, which are the CLI's own and not what a terminal must be protected from. */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const plainText = (line: string) => line.replace(ANSI, "");
/** Anything a terminal could act on: control, format (zero-width, bidi overrides), line and paragraph separators. */
const DANGEROUS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/**
 * An escape sequence that rewrites the screen, a title sequence, a bell, a bidirectional override,
 * a zero-width space and a line separator, written as escapes so the fixture is readable in a diff.
 */
const HOSTILE = `${ESC}[2J${ESC}]0;title\u0007x\u202ey\u200bz\u2028w`;
/** What the hostile text leaves once it is cleaned: its visible part, with nothing to act on. */
const CLEANED = "[2J]0;titlexyzw";

const ID = "nm000460";

function expectClean(lines: readonly string[]) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(plainText(line)).not.toMatch(DANGEROUS);
}

/** Everything a run wrote, line by line: a line end is the run's own and is not what is tested for. */
const expectCleanText = (text: string) => expectClean(text.split("\n"));

/** A detail whose every network string is hostile. */
function hostileDetail(): PublicationReviewDetail {
  // No report: these lines lack the report-derived findings text of a failed question.
  const reasons = reasonViewsOf([{ code: "question_failed", detail: null }], ID, true, null);
  return {
    environment: "production",
    enabled: true,
    dataset_id: ID,
    request_id: 7,
    request_status: "requested",
    anonymous: false,
    identifier_screen: {
      state: "clean",
      headline: `Identifier screen: ${HOSTILE}`,
      tone: "ok",
      lines: [`Files: ${HOSTILE}`, HOSTILE],
    },
    screen_acknowledgment: null,
    block_reason: null,
    started_publishing: false,
    total_files: null,
    applies: true,
    gate: "enforced",
    outcome: "fail",
    reasons,
    description: {
      headline: `Publication review: ${HOSTILE}`,
      tone: "stop",
      lines: [
        `A reason ${HOSTILE}`,
        `Another ${HOSTILE}`,
        `Reviewed ${HOSTILE}. ${NOT_ASSESSED_LINE}`,
      ],
      summary: null,
      next: null,
    },
    review: {
      id: 11,
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      anonymous: false,
      state: "reported",
      detail: null,
      stored_verdict: "fail",
      model: "claude-haiku-5-5",
      version: "1.0.0",
      created_at: "2026-10-13 10:00:00",
      decided_at: "2026-10-13 10:05:00",
      started_by: null,
      override: null,
      questions: null,
      fact_notes: [],
      findings: [],
      summary: null,
      evidence: JSON.parse(JSON.stringify(evidenceFor(undefined, false))),
    },
    history: [],
    history_truncated: false,
  };
}

describe("the lines approve prints are clean of anything a terminal could act on", () => {
  test("the screen and the review of the request", () => {
    const lines = reviewLines(hostileDetail(), ID);
    expectClean(lines);
    // Cleaned, not dropped: the visible part of what the Worker said is still there.
    const text = lines.map(plainText).join("\n");
    expect(text).toContain(`Identifier screen: ${CLEANED}`);
    expect(text).toContain(`Publication review: ${CLEANED}`);
    expect(text).toContain(`A reason ${CLEANED}`);
    expect(text).toContain("Gate: enforced");
    // ... and the screen's lines, which came from the same detail.
    expect(text).toContain(`Files: ${CLEANED}`);
  });

  test("the review of a detail with a gate the CLI does not know", () => {
    const detail = {
      ...hostileDetail(),
      gate: `off${HOSTILE}`,
    } as unknown as PublicationReviewDetail;
    expectClean(reviewLines(detail, ID));
  });

  test("the notes of a decision that goes on: a read that failed, an override on record", () => {
    const unread = decideApproval(
      ID,
      { kind: "unreadable", why: `HTTP ${HOSTILE}` },
      { force: true, acknowledge: undefined, resume: false },
    );
    expect(unread.kind).toBe("proceed");
    if (unread.kind === "proceed") {
      expectClean(noteLines(unread.notes));
      expect(noteLines(unread.notes).map(plainText).join("\n")).toContain(`HTTP ${CLEANED}`);
    }

    const detail = hostileDetail();
    detail.review = {
      ...(detail.review as NonNullable<typeof detail.review>),
      override: { by: 5, at: `2026-10-13 ${HOSTILE}`, reasons: ["question_failed"] },
    };
    const covered = decideApproval(
      ID,
      { kind: "detail", detail },
      { force: false, acknowledge: undefined, resume: false },
    );
    expect(covered.kind).toBe("proceed");
    if (covered.kind === "proceed") {
      expect(covered.notes.join(" ")).toContain("An override by administrator #5");
      expectClean(noteLines(covered.notes));
    }
    expect(noteLines([])).toEqual([]);
  });

  test("a refusal: its reasons, its blocked word and its cure", () => {
    const detail = hostileDetail();
    detail.reasons = detail.reasons.map((r) => ({ ...r, line: `${r.sentence} ${HOSTILE}` }));
    const needs = decideApproval(
      ID,
      { kind: "detail", detail },
      { force: false, acknowledge: undefined, resume: false },
    );
    expect(needs.kind).toBe("refuse");
    if (needs.kind === "refuse") expectClean(refusalLines(needs));

    const hard = {
      ...hostileDetail(),
      reasons: [
        {
          // No report: this line lacks the report-derived findings text (the test replaces it anyway).
          ...reasonViewsOf([{ code: "request_blocked", detail: null }], ID, true, null)[0],
          line: `Blocked ${HOSTILE}`,
        },
      ],
    };
    const refused = decideApproval(
      ID,
      { kind: "detail", detail: hard },
      { force: true, acknowledge: undefined, resume: false },
    );
    expect(refused.kind).toBe("refuse");
    if (refused.kind === "refuse") {
      expectClean(refusalLines(refused));
      expect(refusalLines(refused).map(plainText).join("\n")).toContain(`Blocked ${CLEANED}`);
    }

    const blocked = decideApproval(
      ID,
      {
        kind: "detail",
        detail: { ...hostileDetail(), request_status: "blocked", block_reason: HOSTILE },
      },
      { force: false, acknowledge: undefined, resume: false },
    );
    expect(blocked.kind).toBe("refuse");
    if (blocked.kind === "refuse") expectClean(refusalLines(blocked));
  });

  test("the reasons of a Worker's refusal, in whatever shape it sends them", () => {
    const err = new ApiError(409, HOSTILE);
    err.rawBody = {
      reasons: [
        { sentence: HOSTILE, cure: HOSTILE, line: HOSTILE },
        { sentence: `Sentence ${HOSTILE}`, cure: `Cure ${HOSTILE}` },
        { sentence: 3, cure: "not a reason" },
      ],
    };
    const reasons = refusalReasons(err);
    expect(reasons).toHaveLength(2);
    expectClean(reasons);
    expect(reasons[1]).toBe(`Sentence ${CLEANED} Cure ${CLEANED}`);
    expectClean(reviewRefusalLines(err, ID));
    expect(reviewRefusalLines(new ApiError(409, "x"), ID)).toEqual([]);
  });

  test("the retry notice, the result of a run and the timeline of one that failed", () => {
    expectClean(
      retryNoticeLines({
        attempt: 1,
        maxAttempts: 5,
        delayMs: 10_000,
        step: `s3_lock${HOSTILE}`,
        error: HOSTILE,
      }),
    );
    const steps = [
      { step: `ci_check${HOSTILE}`, status: "completed", attempts: 2, duration_ms: 1500 },
      { step: "s3_lock", status: "failed", attempts: 1, duration_ms: 10, error: HOSTILE },
      { step: "sync_nemar", status: "skipped", attempts: 0, duration_ms: 0 },
    ] as const;
    const result = resultLines({ step_results: [...steps], warning: `Mail ${HOSTILE}` });
    expectClean(result);
    expect(result.map(plainText).join("\n")).toContain(`Warning: Mail ${CLEANED}`);
    expectClean(resultLines({ steps_completed: [`ci_check${HOSTILE}`] }));
    expectClean(timelineLines([...steps]));
    expect(timelineLines(undefined)).toEqual([]);
    expect(timelineLines([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The whole loop, against a stand-in for the Worker
// ---------------------------------------------------------------------------------------------

/** The variable a web approval's executor is handed its token in; the command reads it. */
const DISPATCH_TOKEN_VARIABLE = "NEMAR_APPROVAL_DISPATCH_TOKEN";

describe("runApproval against a Worker that answers with hostile text", () => {
  let server: ReturnType<typeof Bun.serve>;
  let configDir: string;
  const previous: Record<string, string | undefined> = {};
  let scripted: Array<{ status: number; body: unknown }> = [];

  const setEnv = (name: string, value: string) => {
    previous[name] = process.env[name];
    process.env[name] = value;
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch() {
        const next = scripted.shift();
        return next
          ? Response.json(next.body, { status: next.status })
          : Response.json({ error: "nothing scripted" }, { status: 500 });
      },
    });
    configDir = mkdtempSync(join(tmpdir(), "nemar-approve-print-"));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "p",
        accounts: { p: { apiKey: "approve-print-key-0123456789abcdef" } },
      }),
    );
    setEnv("NEMAR_CONFIG_DIR", configDir);
    setEnv("TEST_API_URL", `http://localhost:${server.port}`);
    setEnv("NEMAR_APPROVE_RETRY_DELAY_MS", "0");
    // Colour and a spinner are not what is under test; plain text is.
    setEnv("NO_COLOR", "1");
    setEnv("CI", "1");
    // The command reads the dispatch token variable of the runner's own environment when it runs
    // in this process: a malformed value stops it before it reads anything, and a good one would
    // make every call an executor's (ADR 0103, decision 3). The spawned commands of the other
    // suites are cleaned by their harness; this one is not spawned, so it is cleared here and put
    // back afterwards.
    previous[DISPATCH_TOKEN_VARIABLE] = process.env[DISPATCH_TOKEN_VARIABLE];
    Reflect.deleteProperty(process.env, DISPATCH_TOKEN_VARIABLE);
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    rmSync(configDir, { recursive: true, force: true });
    server.stop(true);
  });

  afterEach(() => {
    scripted = [];
    process.exitCode = 0;
  });

  /** Everything `runApproval` wrote to the console and to the spinner's stream. */
  async function printed<T>(run: () => Promise<T>): Promise<{ value: T; text: string }> {
    const chunks: string[] = [];
    const log = console.log;
    const write = process.stderr.write.bind(process.stderr);
    console.log = (...args: unknown[]) => {
      chunks.push(args.map(String).join(" "));
    };
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      return { value: await run(), text: chunks.join("\n") };
    } finally {
      console.log = log;
      process.stderr.write = write;
    }
  }

  const options = { resume: true, sandbox: false, skipCiCheck: false, override: null };

  test("a retried 5xx, then a result with a hostile message, step and warning", async () => {
    scripted = [
      { status: 500, body: { error: `Step failed: ${HOSTILE}`, step: `ci_check${HOSTILE}` } },
      {
        status: 200,
        body: {
          message: `Published ${HOSTILE}`,
          dataset_id: ID,
          step_results: [
            { step: `ci_check${HOSTILE}`, status: "completed", attempts: 2, duration_ms: 90 },
            { step: "s3_lock", status: "failed", attempts: 1, duration_ms: 1, error: HOSTILE },
          ],
          warning: `Mail ${HOSTILE}`,
        },
      },
    ];

    const { value, text } = await printed(() => runApproval(ID, options));

    expect(value).toEqual({ ok: true });
    expect(text).toContain("Retrying in 0s");
    expectCleanText(text);
    expect(text).toContain(`Published ${CLEANED}`);
    expect(text).toContain(`Warning: Mail ${CLEANED}`);
  });

  for (const [what, total, line] of [
    ["with a total", "5\u2028", /Locking S3 objects: 03\/5 \(60\.0%\)$/m],
    ["without one", undefined, /Locking S3 objects: 03$/m],
  ] as const) {
    test(`the lock progress the Worker reports, ${what}, in the spinner line the retry notice puts back`, async () => {
      // The counts are numbers in the Worker's contract, and nothing here checks that they are: a
      // string with a line separator in it passes the `> 0` test (it reads as a number) and is
      // printed as it came. The spinner line is shown again after a retry notice, which is how it
      // reaches the stream in a test (a spinner that is not on a terminal prints only then).
      scripted = [
        {
          status: 200,
          body: {
            step: "s3_lock",
            hasMore: true,
            s3_lock_continuation_token: "token-1",
            s3_lock_batch_count: "3\u2028",
            s3_lock_total: total,
          },
        },
        { status: 500, body: { error: "a transient fault" } },
        { status: 200, body: { message: "Published", dataset_id: ID, step_results: [] } },
      ];

      const { value, text } = await printed(() => runApproval(ID, options));

      expect(value).toEqual({ ok: true });
      expect(plainText(text)).toMatch(line);
      expectCleanText(text);
    });
  }

  test("a refusal whose message and reasons are hostile", async () => {
    scripted = [
      {
        status: 409,
        body: {
          error: "publication_review_not_clear",
          refusal: "needs_override",
          message: `Not clear ${HOSTILE}`,
          headline: HOSTILE,
          outcome: "fail",
          reasons: [
            {
              code: "question_failed",
              class: "fail",
              cleared_by: "override",
              detail: HOSTILE,
              sentence: `Failed ${HOSTILE}`,
              cure: `Cure ${HOSTILE}`,
              line: `Whole ${HOSTILE}`,
            },
          ],
          uncovered: ["question_failed"],
          review_id: 11,
        },
      },
    ];

    const { value, text } = await printed(() => runApproval(ID, options));

    expect(value).toEqual({ ok: false });
    expect(process.exitCode).toBe(1);
    expectCleanText(text);
    // The message reaches the spinner's failure line, and the reason its own line, cleaned.
    expect(text).toContain(`Not clear ${CLEANED}`);
    expect(text).toContain(`Whole ${CLEANED}`);
    expect(text).toContain(`Next: nemar admin publish show ${ID}`);
  });

  test("the command itself stops on a refused read and prints the Worker's sentence, cleaned", async () => {
    scripted = [{ status: 403, body: { error: `Admin access required ${HOSTILE}` } }];
    const group = new Command("publish");
    registerApproveCommand(group);

    const { text } = await printed(() =>
      group.parseAsync(["approve", ID, "--yes"], { from: "user" }),
    );

    expect(process.exitCode).toBe(1);
    expectCleanText(text);
    expect(text).toContain(`Admin access required ${CLEANED}`);
    // It never got as far as the question, and nothing else was asked of the Worker.
    expect(text).not.toContain(`Approve and publish ${ID}?`);
    expect(text).not.toContain("could not be read (HTTP 403)");
    expect(scripted).toEqual([]);
  });

  test("a failure that is not a refusal, with a timeline", async () => {
    // A 422 is not retried: the message and the step timeline are what is printed.
    const err = { error: `CI failed ${HOSTILE}`, step: "ci_check" };
    scripted = [{ status: 422, body: err }];

    const { value, text } = await printed(() => runApproval(ID, options));

    expect(value).toEqual({ ok: false });
    expectCleanText(text);
    expect(text).toContain(`CI failed ${CLEANED}`);
  });
});
