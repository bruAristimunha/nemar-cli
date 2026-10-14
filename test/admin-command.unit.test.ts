/**
 * The one failure helper of the admin command groups (`lib/admin-command.ts`): what it prints,
 * where, and whether the exit hook may invite a bug report afterwards.
 *
 * Three rules are held here, each also held through the real commands in
 * `admin-publish-exit-codes-cli.test.ts` and the suites of the commands that call it:
 *   - every string that came from the network passes `plain()` before it reaches the terminal (an
 *     ESC sequence rewrites the screen, a bidi override reorders a sentence);
 *   - under `--json` the failure goes to standard error and standard output stays empty;
 *   - a failure is the command's answer (no bug-report hint) when the Worker answered it with a 4xx
 *     or a closed word, and may be a bug otherwise; the hint follows the LAST failure.
 *
 * Mutation checks (each turns a named test red): drop `plain()` from the message or from the error
 * details; print under `--json` on standard output; stop unmarking a failure that may be a bug; let
 * `isAnswered` read only the status; drop the exit code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import chalk from "chalk";
import ora from "ora";
import { failMessage, failWith, handleCommandError, isAnswered } from "../src/lib/admin-command";
import { ApiError } from "../src/lib/api/errors";
import { markReportedExit, resetReportedExit, wasReportedExit } from "../src/lib/debug-log";

/** ESC sequences, a BEL, a bidirectional override and a zero-width space: what `plain()` removes. */
const HOSTILE = "bad\u001b[2J\u001b]0;pwned\u0007 words\u202e\u200b here";
const CLEAN = "bad[2J]0;pwned words here";

/** Anything a terminal could act on: control, format (zero-width, bidi overrides), line and paragraph separators. */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[\\d+m`, "g");

/** The words a spinner wrote to its stream, and what the helper wrote with `console`. */
interface Captured {
  spinner: string;
  out: string;
  err: string;
}

function capture(run: (spinner: ReturnType<typeof ora>) => void): Captured {
  let spinnerText = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      spinnerText += chunk.toString();
      done();
    },
  });
  const spinner = ora({ text: "working", stream, isEnabled: false });
  const log = console.log;
  const error = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    run(spinner);
  } finally {
    console.log = log;
    console.error = error;
  }
  // The spinner colours its own symbol; the colour is not the Worker's bytes.
  const withoutColour = spinnerText.replace(SGR, "");
  return { spinner: withoutColour, out: out.join("\n"), err: err.join("\n") };
}

/** No line of `text` carries a control, a zero-width or a bidirectional character (the newline between lines is not one). */
function expectClean(text: string): void {
  for (const line of text.split("\n")) expect(line).not.toMatch(CONTROL);
}

const apiError = (status: number, message: string, body?: unknown): ApiError => {
  const e = new ApiError(status, message);
  if (body !== undefined) e.rawBody = body;
  return e;
};

let exitCode: typeof process.exitCode;
let colors: typeof chalk.level;
beforeEach(() => {
  exitCode = process.exitCode;
  // Colour codes are control characters too: the assertions are about the Worker's bytes.
  colors = chalk.level;
  chalk.level = 0;
  resetReportedExit();
});
afterEach(() => {
  // Setting it back to undefined does not clear a 1 under Bun, and a 1 would fail the whole run.
  process.exitCode = exitCode ?? 0;
  chalk.level = colors;
  resetReportedExit();
});

describe("isAnswered: the one rule for 'exit 1 is the command's answer'", () => {
  test("a 4xx is an answer, whatever the body says", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(isAnswered(apiError(status, "no"))).toBe(true);
    }
  });

  test("a 5xx that names a closed word other than internal is an answer", () => {
    expect(isAnswered(apiError(502, "x", { code: "dispatch_unconfigured" }))).toBe(true);
    expect(isAnswered(apiError(502, "x", { code: "comment_not_sent" }))).toBe(true);
  });

  test("a 5xx without a word, with the word internal, or with a non-string word may be a bug", () => {
    expect(isAnswered(apiError(500, "x"))).toBe(false);
    expect(isAnswered(apiError(500, "x", { error: "Internal Server Error" }))).toBe(false);
    expect(isAnswered(apiError(500, "x", { code: "internal" }))).toBe(false);
    expect(isAnswered(apiError(502, "x", { code: 7 }))).toBe(false);
  });

  test("a network failure and anything that is not an ApiError may be a bug", () => {
    expect(isAnswered(new Error("fetch failed"))).toBe(false);
    expect(isAnswered("a string")).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
  });
});

describe("failWith", () => {
  test("fails the spinner with the Worker's sentence, plain, and exits 1", () => {
    const got = capture((spinner) => failWith(apiError(409, HOSTILE), spinner, "Failed"));
    expect(got.spinner).toContain(CLEAN);
    expectClean(got.spinner);
    expect(process.exitCode).toBe(1);
  });

  test("prints the caller's status hint and the admin-privileges line", () => {
    const hinted = capture((spinner) =>
      failWith(apiError(422, "refused"), spinner, "Failed", { 422: "fix it" }),
    );
    expect(hinted.out).toContain("fix it");
    const forbidden = capture((spinner) => failWith(apiError(403, "no"), spinner, "Failed"));
    expect(forbidden.out).toContain("This command requires admin privileges");
  });

  test("a block reason's hint outranks the status hint", () => {
    const e = apiError(422, "name missing");
    e.blockReason = "owner_name_missing";
    const got = capture((spinner) => failWith(e, spinner, "Failed", { 422: "fix the CI issues" }));
    expect(got.out).toContain("backfill-names");
    expect(got.out).not.toContain("fix the CI issues");
  });

  test("a failure that is not an ApiError says what the caller said and the details, plain", () => {
    const got = capture((spinner) =>
      failWith(new Error(`connect failed ${HOSTILE}`), spinner, "Could not do it"),
    );
    expect(got.spinner).toContain("Could not do it");
    expect(got.out).toContain(`Error details: connect failed ${CLEAN}`);
    expectClean(got.out);
    expect(process.exitCode).toBe(1);
  });

  test("with no spinner the sentence is printed, and under --json on standard error only", () => {
    const plainRun = capture(() => failWith(apiError(404, HOSTILE), null, "Failed"));
    expect(plainRun.out).toContain(CLEAN);
    expect(plainRun.err).toBe("");

    const json = capture(() =>
      failWith(apiError(403, HOSTILE), null, "Failed", undefined, { json: true }),
    );
    expect(json.out).toBe("");
    expect(json.err).toContain(CLEAN);
    expect(json.err).toContain("This command requires admin privileges");
    expectClean(json.err);
    expect(process.exitCode).toBe(1);
  });

  test("a hint goes to standard error under --json as well", () => {
    const json = capture(() =>
      failWith(new Error("boom"), null, "Could not do it", undefined, { json: true }),
    );
    expect(json.out).toBe("");
    expect(json.err).toContain("Could not do it");
    expect(json.err).toContain("Error details: boom");
  });

  test("the bug-report hint stays once a fault that may be a bug was seen: an answer, then a fault, then an answer", () => {
    capture((spinner) => failWith(apiError(409, "refused"), spinner, "Failed"));
    expect(wasReportedExit()).toBe(true);

    capture((spinner) => failWith(apiError(500, "broke"), spinner, "Failed"));
    expect(wasReportedExit()).toBe(false);

    // A later answer does not hide the earlier fault, which may be a bug.
    capture((spinner) => failWith(apiError(404, "gone"), spinner, "Failed"));
    expect(wasReportedExit()).toBe(false);
  });

  test("a fault that may be a bug, then an answer, keeps the hint", () => {
    capture((spinner) => failWith(apiError(500, "broke"), spinner, "Failed"));
    capture((spinner) => failWith(apiError(409, "refused"), spinner, "Failed"));
    expect(wasReportedExit()).toBe(false);
    capture(() => failMessage("mistyped", { answered: true }));
    expect(wasReportedExit()).toBe(false);
    // Nor can a command's own mark of its exit code as the answer hide it.
    markReportedExit();
    expect(wasReportedExit()).toBe(false);
  });

  test("answers only suppress the hint", () => {
    capture((spinner) => failWith(apiError(409, "refused"), spinner, "Failed"));
    capture((spinner) => failWith(apiError(404, "gone"), spinner, "Failed"));
    capture(() => failMessage("mistyped", { answered: true }));
    expect(wasReportedExit()).toBe(true);
  });

  test("a 5xx with a closed word is an answer, and one with internal is not", () => {
    capture(() => failWith(apiError(502, "not mailed", { code: "comment_not_sent" }), null, "F"));
    expect(wasReportedExit()).toBe(true);
    capture(() => failWith(apiError(500, "oops", { code: "internal" }), null, "F"));
    expect(wasReportedExit()).toBe(false);
  });
});

describe("failMessage", () => {
  test("prints the message plain with its hint, exits 1, and reports an answer", () => {
    const got = capture(() => failMessage(`bad ${HOSTILE}`, { answered: true, hint: "try again" }));
    expect(got.out).toContain(`bad ${CLEAN}`);
    expect(got.out).toContain("try again");
    expectClean(got.out);
    expect(process.exitCode).toBe(1);
    expect(wasReportedExit()).toBe(true);
  });

  test("under --json it writes to standard error, and an unanswered one clears the mark", () => {
    markReportedExit();
    const got = capture(() => failMessage("broke", { json: true, answered: false }));
    expect(got.out).toBe("");
    expect(got.err).toContain("broke");
    expect(wasReportedExit()).toBe(false);
  });
});

describe("handleCommandError", () => {
  test("keeps printing for commands that exit 0, and strips the Worker's sentence", () => {
    process.exitCode = 0;
    const got = capture((spinner) => handleCommandError(apiError(409, HOSTILE), spinner, "Failed"));
    expect(got.spinner).toContain(CLEAN);
    expectClean(got.spinner);
    expect(process.exitCode).toBe(0);
  });

  test("strips the details of a failure that is not an ApiError", () => {
    const got = capture((spinner) =>
      handleCommandError(new Error(`detail ${HOSTILE}`), spinner, "Failed"),
    );
    expect(got.out).toContain(`Error details: detail ${CLEAN}`);
    expectClean(got.out);
  });
});
