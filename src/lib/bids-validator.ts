/**
 * BIDS Validator Service
 *
 * Wraps the BIDS validator (via Deno subprocess) to validate datasets.
 * The validator version is pinned exactly via `validator-version.json` so the
 * CLI and the per-dataset CI workflow always resolve the same release (see
 * issue #586). The monthly `bump-validator.yml` workflow opens a PR when JSR
 * publishes a newer stable release, of any major version (issue #1036).
 *
 * Requirements:
 * - Deno must be installed (https://deno.com)
 * - Network access for first run or when updating
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { formatBytesTrimmed } from "../../shared/bytes.js";
import validatorPin from "../../validator-version.json" with { type: "json" };

export const VALIDATOR_VERSION = validatorPin.version;
const VALIDATOR_JSR_SPECIFIER = `${validatorPin.specifier}@${VALIDATOR_VERSION}`;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 1 day — pin changes monthly via bump-validator.yml

/** The validator's exit code when it finds errors in a dataset. 0 means valid; any other exit is a failed run. */
export const VALIDATOR_ERRORS_FOUND_EXIT = 16;

/**
 * BIDS validation issue from the validator
 */
export interface BidsIssue {
  code: string;
  severity: "error" | "warning";
  location: string;
  rule: string;
  subCode?: string;
  issueMessage?: string;
}

/**
 * BIDS validation summary
 */
export interface BidsSummary {
  sessions: string[];
  subjects: string[];
  tasks: string[];
  modalities: string[];
  totalFiles: number;
  size: number;
  dataProcessed: boolean;
  schemaVersion: string;
}

/**
 * BIDS validation result
 */
export interface BidsValidationResult {
  valid: boolean;
  issues: BidsIssue[];
  codeMessages: Record<string, string>;
  summary: BidsSummary;
  errorCount: number;
  warningCount: number;
  /** The @bids/validator release that produced this result: the pin, which runs at that exact version. */
  validatorVersion: string;
}

/**
 * Validation options
 */
export interface ValidateOptions {
  /** Path to config file for ignoring/promoting issues */
  config?: string;
  /** Ignore warnings, only report errors */
  ignoreWarnings?: boolean;
  /** Validate derivatives subdirectories recursively */
  recursive?: boolean;
  /** Skip sourcedata and derivatives to speed up validation */
  prune?: boolean;
  /** Verbose output */
  verbose?: boolean;
}

/**
 * Check if Deno is installed
 */
export async function checkDenoInstalled(): Promise<{ installed: boolean; version?: string }> {
  try {
    const proc = spawn({
      cmd: ["deno", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const match = output.match(/deno\s+(\d+\.\d+\.\d+)/);
    return {
      installed: true,
      version: match ? match[1] : undefined,
    };
  } catch {
    return { installed: false };
  }
}

/**
 * Check if the Deno cache for the BIDS validator is stale.
 * Uses the modification time of the Deno cache directory as a heuristic.
 * Returns true if cache is older than STALE_THRESHOLD_MS or doesn't exist.
 */
export function isValidatorCacheStale(): boolean {
  try {
    // Deno stores JSR deps in DENO_DIR or ~/.cache/deno (Linux) / ~/Library/Caches/deno (macOS)
    const platform = process.platform;
    const denoDir =
      process.env.DENO_DIR ||
      (platform === "darwin"
        ? join(homedir(), "Library", "Caches", "deno")
        : platform === "win32"
          ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "deno")
          : join(homedir(), ".cache", "deno"));

    const registryDir = join(denoDir, "deps");
    if (!existsSync(registryDir)) return true;

    const stats = statSync(registryDir);
    const ageMs = Date.now() - stats.mtimeMs;
    return ageMs > STALE_THRESHOLD_MS;
  } catch {
    return true;
  }
}

/**
 * Force-refresh the BIDS validator cache by running with --reload.
 * Returns the new version string, or null on failure.
 */
export async function updateValidatorCache(): Promise<string | null> {
  try {
    const proc = spawn({
      cmd: [
        "deno",
        "run",
        "--node-modules-dir=none",
        `--reload=${VALIDATOR_JSR_SPECIFIER}`,
        "-ERWN",
        VALIDATOR_JSR_SPECIFIER,
        "--version",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Get BIDS validator version from the current cache (does not refresh).
 */
export async function getValidatorVersion(): Promise<string | null> {
  try {
    const proc = spawn({
      cmd: [
        "deno",
        "run",
        "--node-modules-dir=none",
        "-ERWN",
        VALIDATOR_JSR_SPECIFIER,
        "--version",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Build the deno + bids-validator argument list from common options.
 * When forceReload is true, adds --reload to fetch the latest validator from JSR.
 */
function buildValidatorArgs(
  datasetPath: string,
  options: ValidateOptions & { json?: boolean; extraArgs?: string[]; forceReload?: boolean } = {},
): string[] {
  // --node-modules-dir=none forces Deno to resolve the validator's npm
  // dependency (npm:hash-wasm, used during hashing) from its own global cache
  // rather than an ambient project node_modules. Without it, running from a
  // directory that HAS a node_modules but lacks hash-wasm (e.g. nemar-cli's own
  // tree, or any Node project a user validates from) makes Deno switch to local
  // node_modules resolution and crash with "Could not find a matching package
  // for 'npm:hash-wasm'" -- validation fails with empty output (#1010).
  const args = ["run", "--node-modules-dir=none"];
  if (options.forceReload) {
    args.push(`--reload=${VALIDATOR_JSR_SPECIFIER}`);
  }
  args.push("-ERWN", VALIDATOR_JSR_SPECIFIER, datasetPath);

  if (options.json) {
    args.push("--json");
  }
  if (options.config) {
    args.push("--config", options.config);
  }
  if (options.ignoreWarnings) {
    args.push("--ignoreWarnings");
  }
  if (options.recursive) {
    args.push("--recursive");
  }
  if (options.prune) {
    args.push("--prune");
  }
  if (options.verbose) {
    args.push("--verbose");
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  return args;
}

/**
 * A colour or cursor sequence. Deno writes these to stderr unless NO_COLOR reaches it, and it lets
 * FORCE_COLOR override NO_COLOR, so a failure message is stripped here rather than trusted.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * The line of a failed validator run's stderr that says why it failed, or undefined when stderr has
 * nothing to say. The validator is a Deno program: an uncaught error prints an `error:` line and
 * then stack-frame lines (`at ...`), and a cold cache prints `Download` progress lines before
 * either. So the reason is the first `error:` line, or else the last line that is not a stack
 * frame, with colour codes removed first so the prefixes match.
 */
export function validatorFailureReason(stderr: string): string | undefined {
  const lines = stderr
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Download"));
  return (
    lines.find((line) => line.startsWith("error:")) ??
    lines.filter((line) => !line.startsWith("at ")).pop()
  );
}

/**
 * Validate a BIDS dataset (JSON mode, for programmatic use by upload command).
 *
 * @param datasetPath - Path to the BIDS dataset directory
 * @param options - Validation options
 * @returns Validation result with issues and summary
 */
export async function validateBidsDataset(
  datasetPath: string,
  options: ValidateOptions & { forceReload?: boolean } = {},
): Promise<BidsValidationResult> {
  const args = buildValidatorArgs(datasetPath, { ...options, json: true });

  const proc = spawn({
    cmd: ["deno", ...args],
    stdout: "pipe",
    stderr: "pipe",
    // NO_COLOR asks Deno for plain output, but Deno lets FORCE_COLOR override it (checked on Deno 2.9
    // with both set), so the request is not a guarantee. validatorFailureReason strips colour codes
    // itself, which is why FORCE_COLOR stays in the environment: nothing else reads this stderr.
    env: { ...process.env, NO_COLOR: "1" },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // 0 means valid and 16 means the validator found errors. Any other exit is a failed run, and the
  // validator's own error line says why.
  if (exitCode !== 0 && exitCode !== VALIDATOR_ERRORS_FOUND_EXIT) {
    const reason = validatorFailureReason(stderr);
    throw new Error(
      reason
        ? `BIDS validator failed (exit ${exitCode}): ${reason}`
        : `BIDS validator failed with exit code ${exitCode}`,
    );
  }

  // Parse JSON output
  let result: {
    issues: {
      issues: BidsIssue[];
      codeMessages: Record<string, string>;
    };
    summary: BidsSummary;
  };

  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse validator output: ${stdout.slice(0, 200)}`);
  }

  // A report without a list of issues is not a clean report: refuse it rather than read it as valid.
  if (!Array.isArray(result?.issues?.issues)) {
    throw new Error("The BIDS validator's report has no list of issues");
  }
  const issues = result.issues.issues;
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    valid: errorCount === 0,
    issues,
    codeMessages: result.issues.codeMessages || {},
    summary: result.summary,
    errorCount,
    warningCount,
    validatorVersion: VALIDATOR_VERSION,
  };
}

/**
 * Run the BIDS validator directly, returning raw stdout/stderr and exit code.
 * Used by the validate command for native text output passthrough.
 */
export async function runBidsValidatorDirect(
  datasetPath: string,
  options: ValidateOptions & { json?: boolean; extraArgs?: string[]; forceReload?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = buildValidatorArgs(datasetPath, options);

  const proc = spawn({
    cmd: ["deno", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Add the validator version to a `--json` report. The report is the validator's own JSON object,
 * so the version is one more top-level key, and the report stays on one line. Output that is not a
 * JSON object is refused: a `--json` consumer must not read it as a report.
 */
export function withValidatorVersion(report: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(report);
  } catch {
    throw new Error("The BIDS validator did not print a JSON report");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The BIDS validator's JSON report is not an object");
  }
  return JSON.stringify({ ...parsed, validatorVersion: VALIDATOR_VERSION });
}

/**
 * The file the validator is asked to write its report to, found among the pass-through arguments
 * of `nemar dataset validate`: `--outfile <file>`, `--outfile=<file>` or `-o <file>`. The last one
 * wins. The value is the next argument whatever it looks like, because that is how the validator
 * reads it, and a flag with nothing after it names no file.
 */
export function reportFileFromArgs(args: string[]): string | undefined {
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--outfile" || arg === "-o") {
      const value = args[i + 1];
      if (value) {
        file = value;
        i++;
      }
    } else if (arg.startsWith("--outfile=") && arg.length > "--outfile=".length) {
      file = arg.slice("--outfile=".length);
    }
  }
  return file;
}

/**
 * Add the validator release to the report file the validator wrote for `--outfile`, so a report on
 * disk names its release just as one on stdout does. A `--json` report gets the key that
 * withValidatorVersion adds and stays on one line. A text report gets the Validator line that the
 * console report ends with. A target that is not a regular file, such as /dev/null, holds no
 * report to add to and is left alone. A missing file throws: the validator exited as if it had
 * written a report, and it wrote none.
 */
export function addValidatorVersionToReport(reportPath: string, json: boolean): void {
  try {
    if (!statSync(reportPath).isFile()) return;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(`The BIDS validator exited normally but wrote no report to ${reportPath}`);
    }
    throw error;
  }

  const report = readFileSync(reportPath, "utf-8");
  if (json) {
    let stamped: string;
    try {
      stamped = withValidatorVersion(report);
    } catch {
      throw new Error(
        `The BIDS validator's report file does not hold a JSON report: ${reportPath}`,
      );
    }
    writeFileSync(reportPath, stamped);
    return;
  }
  const separator = report === "" || report.endsWith("\n") ? "" : "\n";
  writeFileSync(
    reportPath,
    `${report}${separator}Validator: @bids/validator ${VALIDATOR_VERSION}\n`,
  );
}

/**
 * Format validation result for console output
 */
export function formatValidationResult(result: BidsValidationResult, color = true): string {
  const lines: string[] = [];

  // Group issues by severity
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  // Header
  if (result.valid) {
    lines.push(color ? "\x1b[32m✓ Dataset is valid BIDS\x1b[0m" : "✓ Dataset is valid BIDS");
  } else {
    lines.push(
      color ? "\x1b[31m✗ Dataset has validation errors\x1b[0m" : "✗ Dataset has validation errors",
    );
  }
  lines.push("");

  // Errors
  if (errors.length > 0) {
    lines.push(color ? "\x1b[31mErrors:\x1b[0m" : "Errors:");
    for (const issue of errors) {
      const code = color ? `\x1b[31m${issue.code}\x1b[0m` : issue.code;
      const msg = result.codeMessages[issue.code]?.split("\n")[0] || "";
      lines.push(`  ${code}: ${msg}`);
      lines.push(`    ${issue.location}`);
      if (issue.issueMessage) {
        lines.push(`    ${issue.issueMessage.split("\n")[0]}`);
      }
    }
    lines.push("");
  }

  // Warnings
  if (warnings.length > 0) {
    lines.push(color ? "\x1b[33mWarnings:\x1b[0m" : "Warnings:");
    for (const issue of warnings) {
      const code = color ? `\x1b[33m${issue.code}\x1b[0m` : issue.code;
      const msg = result.codeMessages[issue.code]?.split("\n")[0] || "";
      lines.push(`  ${code}: ${msg}`);
      lines.push(`    ${issue.location}`);
    }
    lines.push("");
  }

  // Summary
  lines.push("Summary:");
  lines.push(`  Files: ${result.summary.totalFiles}`);
  lines.push(`  Size: ${formatBytesTrimmed(result.summary.size)}`);
  if (result.summary.subjects.length > 0) {
    lines.push(`  Subjects: ${result.summary.subjects.length}`);
  }
  if (result.summary.sessions.length > 0) {
    lines.push(`  Sessions: ${result.summary.sessions.length}`);
  }
  if (result.summary.tasks.length > 0) {
    lines.push(`  Tasks: ${result.summary.tasks.join(", ")}`);
  }
  if (result.summary.modalities.length > 0) {
    lines.push(`  Modalities: ${result.summary.modalities.join(", ")}`);
  }
  lines.push(`  Schema: BIDS ${result.summary.schemaVersion}`);
  lines.push(`  Validator: @bids/validator ${result.validatorVersion}`);
  lines.push("");

  // Final count
  const errStr = result.errorCount === 1 ? "error" : "errors";
  const warnStr = result.warningCount === 1 ? "warning" : "warnings";
  lines.push(`${result.errorCount} ${errStr}, ${result.warningCount} ${warnStr}`);

  return lines.join("\n");
}
