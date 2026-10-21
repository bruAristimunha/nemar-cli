/**
 * The offline half of the validation report checks: the Validator line of the text report, the
 * rule that a `--json` report is only ever a JSON object with the release added to it, the choice
 * of the line that says why a validator run failed, and how a report file named by `--outfile`
 * is found and given the release.
 *
 * These call the real functions on real strings and real files in temporary directories, with no
 * validator run and no network. The failure inputs have the shape of stderr that validator 3.0.2
 * wrote in real runs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BidsValidationResult } from "../src/lib/bids-validator";
import {
  addValidatorVersionToReport,
  formatValidationResult,
  reportFileFromArgs,
  validatorFailureReason,
  withValidatorVersion,
} from "../src/lib/bids-validator";
import validatorPin from "../validator-version.json" with { type: "json" };

const ESC = "\u001b";

/** Every directory a test creates, removed when the file's tests finish. */
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "validator-report-"));
  created.push(dir);
  return dir;
}

function resultFor(validatorVersion: string): BidsValidationResult {
  return {
    valid: true,
    issues: [],
    codeMessages: {},
    summary: {
      sessions: [],
      subjects: [],
      tasks: [],
      modalities: [],
      totalFiles: 1,
      size: 1,
      dataProcessed: true,
      schemaVersion: "1.0.0",
    },
    errorCount: 0,
    warningCount: 0,
    validatorVersion,
  };
}

describe("the text report names its validator release", () => {
  test("the Validator line carries the release the result was produced by", () => {
    expect(formatValidationResult(resultFor("9.9.9"), false)).toContain(
      "  Validator: @bids/validator 9.9.9\n",
    );
  });
});

describe("withValidatorVersion", () => {
  test("adds the release as a top-level key and keeps the report on one line", () => {
    const report = withValidatorVersion('{"issues":{"issues":[],"codeMessages":{}},"summary":{}}');
    expect(report).not.toContain("\n");
    expect(JSON.parse(report)).toEqual({
      issues: { issues: [], codeMessages: {} },
      summary: {},
      validatorVersion: validatorPin.version,
    });
  });

  test("refuses output that is not a JSON object, so a --json consumer never reads it as a report", () => {
    for (const text of ["not json", "[1, 2]", "null", "42", ""]) {
      expect(() => withValidatorVersion(text)).toThrow();
    }
  });
});

describe("validatorFailureReason", () => {
  const errorLine =
    "error: Uncaught (in promise) NotFound: No such file or directory (os error 2): readfile '/nonexistent.json'";
  // A crash as validator 3.0.2 wrote it for a --config file that does not exist: the error line,
  // a source excerpt with a caret, then stack frames. The run ends on a frame.
  const crash = [
    errorLine,
    "  const config = options.config ? JSON.parse(Deno.readTextFileSync(options.config)) as Config : {}",
    "                                                  ^",
    "    at Object.readTextFileSync (ext:deno_fs/30_fs.js:852:10)",
    "    at main (https://jsr.io/@bids/validator/3.0.2/src/main.ts:38:51)",
    "    at async https://jsr.io/@bids/validator/3.0.2/src/api/app.ts:34:16",
    "",
  ].join("\n");

  test("names the error line, not the stack frame the run ends with", () => {
    expect(validatorFailureReason(crash)).toBe(errorLine);
  });

  test("returns the error line plain when Deno wraps the output in colour codes", () => {
    // The same crash with the codes Deno wrote around the error word, the caret and the frames.
    const coloured = [
      `${ESC}[0m${ESC}[1m${ESC}[31merror${ESC}[0m${errorLine.slice("error".length)}`,
      "  const config = options.config ? JSON.parse(Deno.readTextFileSync(options.config)) as Config : {}",
      `${ESC}[0m${ESC}[31m                                                  ^${ESC}[0m`,
      `    ${ESC}[0m${ESC}[2m${ESC}[38;5;245mat ${ESC}[0m${ESC}[2m${ESC}[38;5;245mObject.readTextFileSync${ESC}[0m (ext:deno_fs/30_fs.js:852:10)`,
      `    at ${ESC}[0m${ESC}[1m${ESC}[3mmain${ESC}[0m (${ESC}[0m${ESC}[36mhttps://jsr.io/@bids/validator/3.0.2/src/main.ts${ESC}[0m:38:51)`,
      `    at async ${ESC}[0m${ESC}[36mhttps://jsr.io/@bids/validator/3.0.2/src/api/app.ts${ESC}[0m:34:16`,
      "",
    ].join("\n");
    expect(coloured).toContain(ESC);
    expect(validatorFailureReason(coloured)).toBe(errorLine);
  });

  test("the first error line wins, and download progress lines are never the reason", () => {
    const stderr = [
      `${ESC}[0m${ESC}[32mDownload${ESC}[0m https://jsr.io/@bids/validator/meta.json`,
      "Download https://jsr.io/@bids/validator/3.0.2_meta.json",
      "error: first failure",
      "error: second failure",
      "",
    ].join("\n");
    expect(validatorFailureReason(stderr)).toBe("error: first failure");
    expect(validatorFailureReason("Download https://jsr.io/@bids/validator/meta.json\n")).toBe(
      undefined,
    );
  });

  test("without an error line, returns the last line that is not a stack frame", () => {
    const stderr = [
      "Download https://jsr.io/@bids/validator/meta.json",
      "The validator stopped before it printed an error",
      "  a detail that comes last",
      "    at async main (https://jsr.io/@bids/validator/3.0.2/src/main.ts:36:7)",
      "",
    ].join("\n");
    expect(validatorFailureReason(stderr)).toBe("a detail that comes last");
  });

  test("returns undefined when stderr has no line that could say why", () => {
    expect(validatorFailureReason("")).toBeUndefined();
    expect(validatorFailureReason("  \n\t\n")).toBeUndefined();
    expect(validatorFailureReason("    at async main (file:///x.ts:1:1)\n")).toBeUndefined();
  });
});

describe("reportFileFromArgs", () => {
  test("finds the file in each form the validator accepts", () => {
    expect(reportFileFromArgs(["--outfile", "r.json"])).toBe("r.json");
    expect(reportFileFromArgs(["--outfile=r.json"])).toBe("r.json");
    expect(reportFileFromArgs(["-o", "r.json"])).toBe("r.json");
  });

  test("finds nothing when the flag is absent or has no value after it", () => {
    expect(reportFileFromArgs(["--json"])).toBeUndefined();
    expect(reportFileFromArgs(["--outfile"])).toBeUndefined();
    expect(reportFileFromArgs(["--max-rows", "1000", "-o"])).toBeUndefined();
    expect(reportFileFromArgs(["--outfile="])).toBeUndefined();
    expect(reportFileFromArgs([])).toBeUndefined();
  });

  test("takes the last of several and skips other flags with their values", () => {
    expect(reportFileFromArgs(["-o", "a.json", "--max-rows", "5", "--outfile=b.json"])).toBe(
      "b.json",
    );
    expect(reportFileFromArgs(["--max-rows", "1000"])).toBeUndefined();
  });
});

describe("addValidatorVersionToReport", () => {
  const release = `Validator: @bids/validator ${validatorPin.version}`;

  function reportFile(name: string, content: string): string {
    const path = join(freshDir(), name);
    writeFileSync(path, content);
    return path;
  }

  test("a JSON report keeps its fields, gains the release, and stays on one line", () => {
    const path = reportFile(
      "report.json",
      '{"issues":{"issues":[],"codeMessages":{}},"summary":{}}',
    );
    addValidatorVersionToReport(path, true);
    const written = readFileSync(path, "utf-8");
    expect(written).not.toContain("\n");
    expect(JSON.parse(written)).toEqual({
      issues: { issues: [], codeMessages: {} },
      summary: {},
      validatorVersion: validatorPin.version,
    });
  });

  test("a text report that ends in a newline gets the Validator line straight after it", () => {
    const path = reportFile("report.txt", "Summary:\n  Files: 7\n\n");
    addValidatorVersionToReport(path, false);
    expect(readFileSync(path, "utf-8")).toBe(`Summary:\n  Files: 7\n\n${release}\n`);
  });

  test("a text report without a final newline gets one before the Validator line", () => {
    const path = reportFile("report.txt", "Summary:\n  Files: 7");
    addValidatorVersionToReport(path, false);
    expect(readFileSync(path, "utf-8")).toBe(`Summary:\n  Files: 7\n${release}\n`);
  });

  test("a missing report file is a failure: the validator exited as if it had written one", () => {
    const missing = join(freshDir(), "never-written.json");
    expect(() => addValidatorVersionToReport(missing, true)).toThrow("wrote no report");
    expect(() => addValidatorVersionToReport(missing, false)).toThrow("wrote no report");
  });

  test("a JSON report file that is not a JSON object is refused and left as it was", () => {
    const path = reportFile("report.json", "not a report");
    expect(() => addValidatorVersionToReport(path, true)).toThrow("does not hold a JSON report");
    expect(readFileSync(path, "utf-8")).toBe("not a report");
  });

  test("a target that is not a regular file, such as /dev/null, has no report to add to", () => {
    expect(() => addValidatorVersionToReport("/dev/null", true)).not.toThrow();
    expect(() => addValidatorVersionToReport("/dev/null", false)).not.toThrow();
  });
});
