/**
 * `--debug` / `NEMAR_DEBUG=1` diagnostic bundle (issue #1256, epic #1250 phase 6).
 *
 * Motivated by #1249: a user's upload failed at "Creating dataset in NEMAR"
 * and it took three emails and three screenshots to learn the CLI version
 * and the failing step. This module lets a user hand over one file instead.
 *
 * Design constraints that shaped this:
 * - `src/lib/api/client.ts`'s `request()` is the ONLY place a NEMAR API call
 *   goes through, so it is the one place HTTP entries are recorded. Nothing
 *   here talks to the network itself. This does NOT cover every fetch() in
 *   the CLI: lib/update-check.ts (npm registry), lib/openneuro.ts, and
 *   lib/import-openneuro.ts call fetch() directly against OpenNeuro/npm, not
 *   the NEMAR API, and are not captured here (review finding, PR #1257;
 *   tracked in the follow-up issue referenced from recordStep's docstring
 *   below).
 * - The debug log must never contain a credential. Headers and bodies are
 *   redacted at record time (before they are ever held in memory here), not
 *   at write time, so there is no path that skips it.
 * - Environment info (tool versions in particular) requires spawning
 *   subprocesses, which is async. `process.on("exit", ...)` callbacks in
 *   Node/Bun MUST be synchronous, and any of ~270 call sites across the CLI
 *   can call `process.exit()` at any point. So the environment snapshot is
 *   captured once, eagerly, at startup (`primeEnvironmentSnapshot`), cached
 *   as a plain string, and the actual file write at exit is 100% synchronous
 *   (`writeDebugLogSync`).
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorDetail } from "./api/errors.js";
import { getConfig, getConfigDir } from "./config.js";
import { checkAllTools } from "./prerequisites.js";
import { version } from "./version.js";

/** Keep only the N most recent debug logs (issue #1256). */
export const MAX_DEBUG_LOGS = 10;

/** Truncate a logged HTTP body to this many bytes. */
export const MAX_BODY_BYTES = 2048;

let debugEnabled = false;
let usageExit = false;
let reportedExit = false;
let possibleBugSeen = false;
let lastStep: string | undefined;
let cachedEnvironmentSection: string | undefined;
const httpEntries: HttpLogEntry[] = [];

export function enableDebug(): void {
  debugEnabled = true;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/** Whether `--debug` or `NEMAR_DEBUG=1` requests debug mode for this run. */
export function shouldEnableDebug(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes("--debug") || env.NEMAR_DEBUG === "1";
}

/**
 * Records the TITLE string passed to `printStepFailure` (lib/cli-output.ts)
 * -- not a spinner's running/in-progress text, which this module never reads.
 *
 * Coverage is narrow (review finding, PR #1257): `printStepFailure` has 8
 * call sites, all in the dataset-upload flow (lib/upload/{preflight,
 * transfer,finalize}.ts). Roughly 220 other `spinner.fail(...)` call sites
 * elsewhere in the CLI (admin, sandbox, auth, and non-upload dataset
 * commands) do not route through it and so never call this function -- a
 * failure there leaves the debug log's "Failing step" line at its default,
 * `(none recorded)`, rather than a fabricated guess. Widening this is
 * tracked in https://github.com/nemarOrg/nemar-cli/issues/1259.
 *
 * Cheap enough to call unconditionally; it is a no-op string assignment
 * when debug mode is off.
 */
export function recordStep(label: string): void {
  lastStep = label;
  dlog(`Step: ${label}`);
}

/** Marks that the process is exiting through Commander's own `_exit` (help,
 * `--version`, or a usage/validation error) rather than a command's own
 * `process.exit()` call. See `markCommanderExitsRecursively` in src/index.ts. */
export function markUsageExit(): void {
  usageExit = true;
}

export function wasUsageExit(): boolean {
  return usageExit;
}

/**
 * Marks that this command's non-zero exit code IS its answer, not a failure.
 *
 * `nemar admin import-coverage` and `import-weekly` exit 1 for "unhealthy" and 2 for
 * "could not determine": a monitoring caller reads those, and both are successful
 * RUNS reporting an unhealthy or unknown STATE. Without this the exit hook printed
 * "Run again with --debug and attach the log to a new issue" underneath a correct
 * report -- observed on the first real production run of the weekly summary, whose
 * `closed_this_week=unknown` is the designed first-week answer. Inviting a bug report
 * for a working command teaches people to ignore the hint that matters.
 *
 * Deliberately separate from `markUsageExit`: that one means Commander rejected the
 * invocation, and conflating "you typed it wrong" with "the fleet is unwell" would
 * make both harder to read later.
 */
export function markReportedExit(): void {
  // A failure that may be a bug was already seen in this run ({@link unmarkReportedExit}), and an
  // answer after it does not hide it.
  if (possibleBugSeen) return;
  reportedExit = true;
}

/**
 * Records that a failure that may be a bug was seen, for a command that can fail more than once in
 * one run: it clears the mark and, from then on, {@link markReportedExit} does nothing. The state
 * is process-wide, so a walk that has one request fail for a reason that may be a bug must keep
 * the exit hook's invitation to attach the log, whatever answers (refusals the Worker made) come
 * before or after it. Only answers suppress the hint.
 */
export function unmarkReportedExit(): void {
  reportedExit = false;
  possibleBugSeen = true;
}

/**
 * Starts the exit state over, as a fresh process has it. TEST-ONLY: nothing in the CLI calls it.
 * It lives here because the state it clears is module-private and process-wide, and the unit test
 * of `admin-command.ts` runs several commands in one process: a second entry point on the module
 * is the one way to start each case clean without a process per case or a cache-busted import,
 * which would load a second copy of the module that the code under test does not use.
 */
export function resetReportedExit(): void {
  reportedExit = false;
  possibleBugSeen = false;
}

export function wasReportedExit(): boolean {
  return reportedExit;
}

/** Print to stderr only when debug mode is on (mirrors lib/verbose.ts). */
export function dlog(message: string): void {
  if (debugEnabled) {
    process.stderr.write(`[debug] ${message}\n`);
  }
}

// ============================================================================
// Redaction
// ============================================================================

// "set-cookie" is a RESPONSE header; nothing here captures response headers
// today (only `entry.requestHeaders` exists on HttpLogEntryInput). It's kept
// in this set so redaction is correct by construction the day a caller does
// start passing response headers through, rather than something someone has
// to remember to add then.
//
// "x-approval-dispatch-token" is the per-claim token the executor of a web approval presents on
// `/approve` (shared/contract/publication.ts, APPROVAL_DISPATCH_TOKEN_HEADER). It authorizes
// nothing alone, but it is what lets that call be recorded as the administrator who clicked, and
// the debug log is the file users are told to attach to public issues. A test holds this spelling
// to the shared constant.
const REDACT_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-approval-dispatch-token",
]);

/** Redact sensitive header values. Exported for direct unit testing. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = REDACT_HEADER_NAMES.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
}

/** JSON body keys whose values are always secrets, regardless of content.
 *  `device[_-]?code` covers the device authorization grant's polling secret
 *  (epic #1272 phase 3; ADR 0047): `device_code` is the bearer of
 *  `POST /auth/device/token`, equivalent to holding the key it mints, and
 *  the CLI's own request bodies carry it verbatim on every poll.
 *
 *  BARE `session` IS HERE BECAUSE `session_token` WAS NOT ENOUGH. The docs
 *  credential exchange (epic #1336 phase 3) returns its value under the key
 *  `session` -- see `DocsCliSessionResponse` -- and this pattern matched only
 *  the `session_token` spelling, so `--debug` wrote a live admin-docs
 *  credential to the log file in plaintext while redacting the long-lived API
 *  key on the line above it. The CLI tells people to re-run with `--debug` and
 *  attach the log to an issue, so the path from "a docs page 404'd" to "a live
 *  credential in a public issue" was two steps. Add the exact key, not a
 *  prefix: a `*session*` wildcard would also redact `session_id` and
 *  `expires_at`-style diagnostics that are the reason the log exists. */
const SENSITIVE_BODY_KEY_RE =
  /^(api[_-]?key|apikey|password|token|secret|access[_-]?key(_id)?|secret[_-]?access[_-]?key|session|session[_-]?token|authorization|ssh[_-]?key|private[_-]?key|device[_-]?code)$/i;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Mask an email as `f***@domain.tld` (same shape as backend redactRecipient). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Recursion cap for `redactJsonValue` (review finding, PR #1257): with no
 * bound, a pathologically deep body threw a raw `RangeError` (stack
 * overflow) out of `recordHttpExchange`, which -- unlike a normal API
 * error -- would have failed an otherwise-successful `request()` call just
 * because debug mode happened to be on. Anything nested deeper than this is
 * replaced outright rather than descended into; `recordHttpExchange` below
 * is still wrapped in try/catch as a second line of defense for whatever
 * this cap doesn't anticipate.
 */
const MAX_REDACT_DEPTH = 32;

function redactJsonValue(key: string, value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[REDACTED: depth]";
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(key, v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactJsonValue(k, v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    if (SENSITIVE_BODY_KEY_RE.test(key)) return "[REDACTED]";
    return value.replace(EMAIL_RE, maskEmail);
  }
  return value;
}

const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/=]+/gi;
// AWS access key IDs have a fixed, recognizable shape (AKIA/ASIA + 16 chars).
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
// Secret access keys don't have a distinct shape, so match them by the
// field name that carries one (JSON, form, or query-string style).
const AWS_SECRET_ASSIGN_RE =
  /((?:aws_)?secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{20,}/gi;
// Presigned S3 URLs (upload_url / download_url fields, and the request URL
// itself for a direct-to-S3 PUT) carry the credential in the query string,
// not the body (review finding, PR #1257). Captures the separator char in a
// group of its own so it survives the replace -- dropping it would merge
// the previous param's value into this one with no "&"/"?" between them.
const PRESIGNED_PARAM_RE =
  /([?&])(X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential|Signature|AWSAccessKeyId)=[^&\s"']+/gi;

/** Regex-only secret scrubbing, usable on JSON, a URL, or arbitrary text. */
function scrubSecretPatterns(text: string): string {
  return text
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(AWS_ACCESS_KEY_RE, "[REDACTED_AWS_KEY]")
    .replace(AWS_SECRET_ASSIGN_RE, "$1[REDACTED]")
    .replace(PRESIGNED_PARAM_RE, "$1$2=[REDACTED]")
    .replace(EMAIL_RE, maskEmail);
}

/**
 * Redact a URL: presigned-S3 query params (`X-Amz-Signature` and friends)
 * and any embedded email (e.g. an admin email-preference route's `?user=`)
 * are masked. Exported for direct unit testing.
 */
export function redactUrl(url: string): string {
  return scrubSecretPatterns(url);
}

/**
 * Redact a request/response body. Masked, regardless of nesting depth (see
 * MAX_REDACT_DEPTH above): values under a key that is itself always a
 * secret (`api_key`, `password`, `token`/`session_token`, `secret`,
 * `ssh_key`/`private_key`, `access_key`/`access_key_id`,
 * `secret_access_key`, `authorization`) are replaced outright regardless of
 * their content; independently of key name, every string value is scanned
 * for an email address, a `Bearer ...` token, an AWS access key ID
 * (`AKIA`/`ASIA` + 16 chars), an `aws_secret_access_key` assignment (which
 * does not match the key-name allowlist above verbatim, so needs its own
 * pattern), and a presigned-S3 URL's signature/credential/security-token
 * query params (e.g. inside an `upload_url` field). The result is
 * truncated to `maxBytes`. Exported for direct unit testing.
 */
export function redactBody(raw: string | undefined, maxBytes = MAX_BODY_BYTES): string | undefined {
  if (raw === undefined) return undefined;
  let result = raw;
  try {
    const parsed = JSON.parse(raw);
    result = JSON.stringify(redactJsonValue("", parsed));
  } catch {
    // Not JSON (form data, plain text, empty body) -- fall through to the
    // regex-only pass below.
  }
  result = scrubSecretPatterns(result);
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    const truncated = Buffer.from(result, "utf8").subarray(0, maxBytes).toString("utf8");
    result = `${truncated}... [truncated]`;
  }
  return result;
}

// ============================================================================
// HTTP request/response log
// ============================================================================

export interface HttpLogEntryInput {
  method: string;
  url: string;
  /** null when the request never got a response (network error). */
  status: number | null;
  durationMs: number;
  /** Absent on the placeholder entry recordHttpExchange pushes when
   * redaction itself throws -- see `note` below. */
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  error?: string;
  /** Set instead of the body fields when redacting this entry itself failed. */
  note?: string;
}

/** Same shape as the input; kept as a distinct alias for readability at call sites. */
export type HttpLogEntry = HttpLogEntryInput;

/**
 * Record one HTTP exchange made through `lib/api/client.ts`'s `request()`.
 * Redaction happens here, at record time, so a plaintext secret is never
 * held anywhere in this module's state.
 *
 * The URL is redacted (`redactUrl`) OUTSIDE the try block, before anything
 * that recurses over the body: it's simple, non-recursive regex work that
 * realistically can't throw, so it's always safe to include in the
 * placeholder entry pushed from the catch branch below (review finding, PR
 * #1257) -- unlike `redactBody`, which recurses into arbitrary caller-
 * supplied JSON and is exactly the thing that catch branch exists for.
 */
export function recordHttpExchange(entry: HttpLogEntryInput): void {
  if (!debugEnabled) return;
  const url = redactUrl(entry.url);
  try {
    const redacted: HttpLogEntry = {
      ...entry,
      url,
      requestHeaders: entry.requestHeaders ? redactHeaders(entry.requestHeaders) : undefined,
      requestBody: redactBody(entry.requestBody),
      responseBody: redactBody(entry.responseBody),
    };
    httpEntries.push(redacted);
    dlog(`${entry.method} ${url} -> ${entry.status ?? "ERROR"} (${entry.durationMs}ms)`);
  } catch (err) {
    // A body that defeats redaction (see MAX_REDACT_DEPTH) must not fail an
    // otherwise-successful request() call just because --debug is on: drop
    // the body fields rather than let the exception escape recordHttpExchange.
    const message = errorDetail(err);
    httpEntries.push({
      method: entry.method,
      url,
      status: entry.status,
      durationMs: entry.durationMs,
      note: `redaction failed: ${message}`,
    });
    dlog(`redaction failed for ${entry.method} ${url}: ${message}`);
  }
}

/** Read-only snapshot of recorded HTTP entries. For tests. */
export function getRecordedHttpEntries(): readonly HttpLogEntry[] {
  return httpEntries;
}

// ============================================================================
// Environment section (shared by the debug log and `nemar doctor --report`)
// ============================================================================

/**
 * Fields from the active account worth showing in a bug report. Deliberately
 * short: NEVER apiKey, and only fields the local config actually has today.
 * `role` is populated at login/`auth status --refresh` (see commands/auth.ts).
 * A future account-tiers field (upload access / tier) belongs here once it
 * exists in `Config` -- there is nothing to report yet on this branch.
 *
 * Each section is isolated in its own try/catch (review finding, PR #1257):
 * `getConfig()` throws on a corrupt config.json (conf's `clearInvalidConfig`
 * defaults to false), which used to take the whole report down with it --
 * `nemar doctor --debug` failed where plain `nemar doctor` succeeded (it
 * never touches config), and `nemar doctor --report` printed nothing at
 * all. Now a broken section says so and the rest of the report still prints.
 */
async function buildEnvironmentLines(): Promise<string[]> {
  const lines: string[] = [];
  try {
    const runtime = process.versions.bun
      ? `Bun ${process.versions.bun}`
      : `Node ${process.version}`;
    lines.push(`CLI version: ${version}`);
    lines.push(`OS/Arch: ${process.platform}/${process.arch}`);
    lines.push(`Runtime: ${runtime}`);
  } catch (err) {
    lines.push(`(could not read CLI/OS/runtime info: ${errorDetail(err)})`);
  }

  lines.push("");
  lines.push("Active account:");
  try {
    const cfg = getConfig();
    if (cfg.apiKey) {
      if (cfg.username) lines.push(`  Username: ${cfg.username}`);
      lines.push(`  API URL: ${cfg.apiUrl}`);
      if (cfg.role) lines.push(`  Role: ${cfg.role}`);
      lines.push(`  Sandbox completed: ${!!cfg.sandboxCompleted}`);
    } else {
      lines.push("  (not authenticated)");
    }
  } catch (err) {
    lines.push(`  (could not read account config: ${errorDetail(err)})`);
  }

  lines.push("");
  lines.push("External tools:");
  try {
    const tools = await checkAllTools();
    for (const tool of tools) {
      const status = tool.available
        ? (tool.version ?? "installed")
        : tool.timedOut
          ? "(timed out)"
          : "not installed";
      lines.push(`  ${tool.name}: ${status}`);
    }
  } catch (err) {
    lines.push(`  (could not probe external tools: ${errorDetail(err)})`);
  }

  return lines;
}

/**
 * The environment section of the diagnostic bundle: CLI/OS/Bun version,
 * active account (no credential), and external tool versions. No HTTP
 * trace -- this is what `nemar doctor --report` prints standalone, and what
 * the debug log embeds verbatim.
 */
export async function getEnvironmentReport(): Promise<string> {
  return (await buildEnvironmentLines()).join("\n");
}

/**
 * Capture the environment section once, up front, so the synchronous exit
 * handler never has to await anything. No-op when debug mode is off.
 *
 * `buildEnvironmentLines` already isolates each of its sections in its own
 * try/catch, so this outer one is a second line of defense (review finding,
 * PR #1257) -- without it, any surprise here would still propagate out of
 * `main()`'s `await primeEnvironmentSnapshot()` and fail the whole command
 * before it even started, which is exactly the failure mode this feature
 * exists to help diagnose, not cause.
 */
export async function primeEnvironmentSnapshot(): Promise<void> {
  if (!debugEnabled || cachedEnvironmentSection !== undefined) return;
  try {
    cachedEnvironmentSection = await getEnvironmentReport();
  } catch (err) {
    const message = errorDetail(err);
    cachedEnvironmentSection = `(could not build environment report: ${message})`;
    dlog(`environment snapshot failed: ${message}`);
  }
}

// ============================================================================
// Command line (for the log filename and the "Command:" line)
// ============================================================================

/** Flags that take a secret value on the command line. */
const SECRET_FLAGS = new Set(["-k", "--key", "--password", "--api-key"]);

/**
 * How a secret flag showed up in one argv token. `kind` is undefined for a
 * bare flag token (`--key`, `-k`) whose value is a SEPARATE following
 * token; `"long-eq"` for `--flag=value` (one token, split on `=`);
 * `"short-attached"` for `-fvalue` (one token, a one-letter short flag
 * with no separator at all -- only `-k` today).
 */
interface SecretFlagMatch {
  flag: string;
  kind?: "long-eq" | "short-attached";
}

/**
 * Recognize a secret-bearing flag in any of the three spellings Commander
 * accepts for an option that takes a value. CRITICAL FIX (review finding,
 * PR #1257, reproduced): matching only the bare flag token by exact string
 * equality missed the two attached spellings entirely, so `nemar --debug
 * login --key=sk-...` and `nemar --debug login -ksk-...` both wrote the raw
 * key into the debug log's "Command:" line (the filename was never at risk
 * from these two spellings specifically: a token starting with "-" is
 * already excluded from buildCommandLabel's scan below regardless of this
 * function).
 */
function matchSecretFlag(token: string): SecretFlagMatch | null {
  if (SECRET_FLAGS.has(token)) return { flag: token };
  for (const flag of SECRET_FLAGS) {
    if (!token.startsWith(flag) || token.length <= flag.length) continue;
    // A one-letter short flag ("-k") takes its value concatenated directly,
    // with no separator: "-ksecret". A long flag ("--key") never does --
    // its only attached spelling uses "=", checked below.
    if (flag.length === 2) return { flag, kind: "short-attached" };
    if (token[flag.length] === "=") return { flag, kind: "long-eq" };
  }
  return null;
}

/** Redact secret-bearing flags/values before a command line is ever logged
 * (used for the human-readable "Command:" line; a bare flag's value
 * survives as a "[REDACTED]" TOKEN, which is fine there but must never
 * reach buildCommandLabel below -- see stripSecretFlagValues). */
export function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const match = matchSecretFlag(token);
    if (!match) {
      out.push(token);
      continue;
    }
    if (match.kind === "long-eq") {
      out.push(`${match.flag}=[REDACTED]`);
    } else if (match.kind === "short-attached") {
      out.push(`${match.flag}[REDACTED]`);
    } else {
      out.push(token);
      if (i + 1 < argv.length) {
        out.push("[REDACTED]");
        i++;
      }
    }
  }
  return out;
}

/**
 * Drop a secret flag AND its value entirely, rather than masking the value
 * in place (contrast `redactArgv`). CRITICAL FIX (review finding, PR #1257,
 * reported reproducible): `buildCommandLabel` used to scan the RAW argv for
 * its first two non-flag tokens, so `nemar login -k <key>` -- a single word
 * before the flag -- put the key itself in the SECOND slot and the log was
 * written as `nemar-<ts>-login-<THE-KEY>.log`, on every exit including
 * success, which is the exact file the issue form tells users to attach.
 * Masking in place (a "[REDACTED]" token, like redactArgv does) would have
 * only swapped the leaked key for a still-wrong `login-REDACTED` label;
 * dropping the flag and its value lets the real next token (if any) fall
 * into that slot instead, so `nemar login -k <key>` labels correctly as
 * `login`.
 */
function stripSecretFlagValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const match = matchSecretFlag(token);
    if (!match) {
      out.push(token);
      continue;
    }
    // A bare flag token's value is the NEXT array element; skip it too.
    // An attached-value token (kind set) already starts with "-" and is
    // dropped by buildCommandLabel's own scan regardless, but dropping it
    // here too keeps this function's contract consistent on its own terms.
    if (!match.kind && i + 1 < argv.length) i++;
  }
  return out;
}

/**
 * A filesystem-safe label for the log filename: up to the first two
 * non-flag tokens of the command line with any secret flag's value removed
 * first (e.g. `dataset upload ./my-dataset` -> "dataset-upload"), capped at
 * two so a positional argument (dataset path, username, ...) never ends up
 * in the filename.
 */
export function buildCommandLabel(argv: string[]): string {
  const parts: string[] = [];
  for (const token of stripSecretFlagValues(argv)) {
    if (token.startsWith("-")) continue;
    parts.push(token);
    if (parts.length === 2) break;
  }
  const label = parts.length > 0 ? parts.join("-") : "nemar";
  return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ============================================================================
// Writing the log file
// ============================================================================

function buildLogContent(argv: string[], exitCode: number): string {
  const lines: string[] = [];
  lines.push("NEMAR CLI Debug Log");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Command: nemar ${scrubSecretPatterns(redactArgv(argv).join(" "))}`);
  lines.push("");
  lines.push(cachedEnvironmentSection ?? "(environment snapshot unavailable)");
  lines.push("");
  lines.push("HTTP requests:");
  if (httpEntries.length === 0) {
    lines.push("  (none)");
  } else {
    httpEntries.forEach((entry, index) => {
      lines.push(
        `  [${index + 1}] ${entry.method} ${entry.url} -> ${entry.status ?? "ERROR"} (${entry.durationMs}ms)`,
      );
      if (entry.error) lines.push(`      Error: ${entry.error}`);
      if (entry.note) lines.push(`      Note: ${entry.note}`);
      if (entry.requestHeaders) {
        lines.push(`      Request headers: ${JSON.stringify(entry.requestHeaders)}`);
      }
      if (entry.requestBody) lines.push(`      Request body: ${entry.requestBody}`);
      if (entry.responseBody) lines.push(`      Response body: ${entry.responseBody}`);
    });
  }
  lines.push("");
  lines.push(`Failing step: ${lastStep ?? "(none recorded)"}`);
  lines.push(`Exit code: ${exitCode}`);
  return `${lines.join("\n")}\n`;
}

/** Remove all but the `keep` most recent `nemar-*.log` files in `dir`. Names
 * are ISO-timestamp-prefixed, so lexicographic sort is chronological.
 * Exported for direct unit testing of the rotation policy.
 *
 * A missing directory (ENOENT) is expected and silent -- nothing has ever
 * written a log there yet, or another process's own prune already removed
 * it. Anything else (EACCES, EPERM, ...) is dlog'd rather than swallowed
 * bare (review finding, PR #1257), on both the readdir and the per-file
 * unlink, so a permissions problem shows up in `[debug]` output instead of
 * silently leaving the window over MAX_DEBUG_LOGS. */
export function pruneLogsDir(dir: string, keep: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.startsWith("nemar-") && name.endsWith(".log"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      dlog(`could not list ${dir} for log rotation: ${errorDetail(err)}`);
    }
    return;
  }
  entries.sort();
  const excess = entries.length - keep;
  for (let i = 0; i < excess; i++) {
    try {
      unlinkSync(join(dir, entries[i]));
    } catch (err) {
      // ENOENT: a log another process already removed isn't an error.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        dlog(`could not remove old log ${entries[i]}: ${errorDetail(err)}`);
      }
    }
  }
}

/** The reason the most recent `writeDebugLogSync` call returned null while
 * debug mode was on (as opposed to returning null because debug mode was
 * off, which callers already distinguish via `isDebugEnabled()`). Read by
 * src/index.ts to print a specific "could not be written" message instead
 * of the generic failure hint, which would otherwise tell the user to
 * re-run with the exact flag they just ran with. */
let lastWriteFailureReason: string | undefined;

export function getLastWriteFailureReason(): string | undefined {
  return lastWriteFailureReason;
}

/**
 * Write the debug log for this run and prune to the 10 most recent. Fully
 * synchronous so it can run from a `process.on("exit", ...)` handler, which
 * cannot await anything. No-op (returns null) when debug mode is off, or if
 * the log directory can't be created or written to -- both failures are
 * dlog'd (review finding, PR #1257: these used to be a bare `catch {}`) and
 * the reason is recorded for `getLastWriteFailureReason()`.
 */
export function writeDebugLogSync(argv: string[], exitCode: number): string | null {
  if (!debugEnabled) return null;
  const dir = join(getConfigDir(), "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    lastWriteFailureReason = errorDetail(err);
    dlog(`could not create log directory ${dir}: ${lastWriteFailureReason}`);
    return null;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `nemar-${timestamp}-${buildCommandLabel(argv)}.log`;
  const filePath = join(dir, fileName);
  try {
    writeFileSync(filePath, buildLogContent(argv, exitCode), "utf8");
  } catch (err) {
    lastWriteFailureReason = errorDetail(err);
    dlog(`could not write log file ${filePath}: ${lastWriteFailureReason}`);
    return null;
  }
  pruneLogsDir(dir, MAX_DEBUG_LOGS);
  return filePath;
}

/** Reset all module state. Test-only. */
export function resetDebugStateForTesting(): void {
  debugEnabled = false;
  usageExit = false;
  lastStep = undefined;
  cachedEnvironmentSection = undefined;
  lastWriteFailureReason = undefined;
  httpEntries.length = 0;
}
