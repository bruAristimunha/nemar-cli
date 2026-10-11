/**
 * git-annex service: annexed-data transfer (get/copy/drop) and key/location
 * queries.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim.
 */

import { lstatSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { displayName } from "../display-name.js";
import { annexKeyDeclaredSize } from "../s3-server-copy.js";
import { chunkAddTargets } from "./init.js";
import { shouldAnnex } from "./policy.js";
import { credentialValues, redactCredentials, runCommand } from "./run-command.js";
import { type S3Credentials, awsCredentialEnv } from "./s3-remote.js";

/**
 * Dataset upload progress
 */
export interface UploadProgress {
  phase: "metadata" | "data" | "finalize";
  current: number;
  total: number;
  currentFile?: string;
  bytesTransferred?: number;
  bytesTotal?: number;
}

/**
 * git-annex JSON progress line (from --json-progress output).
 *
 * For byte-progress events, git-annex nests file/key/command under `action`:
 *   {"action":{"command":"get","file":"x.bin","key":"..."},
 *    "byte-progress":1024,"total-size":2048}
 *
 * For completion events, file/key/command are top-level (no `action`):
 *   {"command":"get","file":"x.bin","key":"...","success":true}
 *
 * Consumers should read the file path from `line.file ?? line.action?.file`.
 */
interface GitAnnexAction {
  command?: string;
  file?: string;
  key?: string;
}

interface GitAnnexProgressLine {
  action?: GitAnnexAction;
  file?: string;
  "byte-progress"?: number;
  "total-size"?: number;
  "percent-progress"?: string;
  key?: string;
  ok?: boolean;
  success?: boolean;
  note?: string;
  "error-messages"?: string[];
  error?: string;
}

/**
 * Progress callback for getDatasetData streaming mode
 */
export type DownloadProgressCallback = (line: GitAnnexProgressLine) => void;

/**
 * Count files and bytes pending download from remote(s).
 *
 * Wraps `git annex find --not --in=here --json` and sums the `bytesize`
 * field. Used to seed progress totals before calling `git annex get` so the
 * progress bar has an authoritative denominator.
 *
 * Returns {fileCount: 0, totalBytes: 0} when nothing is pending.
 * Returns null when the command fails (e.g., git-annex too old) so callers
 * can degrade gracefully rather than aborting.
 */
export async function countPendingDownload(
  datasetPath: string,
  paths?: string[],
  extraArgs?: string[],
): Promise<{ fileCount: number; totalBytes: number } | null> {
  const targets = paths && paths.length > 0 ? paths : ["."];
  const matchArgs = extraArgs && extraArgs.length > 0 ? extraArgs : [];
  try {
    const { stdout, stderr, exitCode } = await runCommand(
      ["git", "annex", "find", "--not", "--in=here", ...matchArgs, "--json", ...targets],
      { cwd: datasetPath },
    );
    if (exitCode !== 0) {
      if (process.env.VERBOSE && stderr.trim()) {
        console.warn(`countPendingDownload: git annex find failed: ${stderr.trim()}`);
      }
      return null;
    }

    let fileCount = 0;
    let totalBytes = 0;
    let sawNonJson = false;
    let sawAnyContent = false;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      sawAnyContent = true;
      if (!trimmed.startsWith("{")) {
        sawNonJson = true;
        continue;
      }
      try {
        const entry = JSON.parse(trimmed) as { bytesize?: string };
        fileCount++;
        if (entry.bytesize) {
          const n = Number.parseInt(entry.bytesize, 10);
          if (Number.isFinite(n)) totalBytes += n;
        }
      } catch {
        sawNonJson = true;
      }
    }

    // Distinguish "annex find succeeded with truly empty output" (zero pending)
    // from "annex emitted only warnings/non-JSON" (unknown). The former is
    // authoritative; the latter must degrade so the caller does not
    // misreport "All data files already present".
    if (fileCount === 0 && sawAnyContent && sawNonJson) return null;

    return { fileCount, totalBytes };
  } catch (err) {
    if (process.env.VERBOSE) {
      console.warn(`countPendingDownload: ${(err as Error).message}`);
    }
    return null;
  }
}

/** Outcome of a `git annex get` run. See {@link classifyGetOutcome}. */
export type GetOutcome = "complete" | "partial" | "failed";

/** Most unavailable paths to retain for reporting; the rest are counted only. */
export const MAX_UNAVAILABLE_SAMPLE = 10;

interface GetDataCounts {
  filesDownloaded: number;
  /** Files whose content no configured remote could supply. */
  filesUnavailable: number;
  /** Bounded sample of unavailable paths, for user-facing reporting. */
  unavailablePaths: string[];
  /**
   * Among this run's retrieved files, how many had a key declaring no size
   * (a `URL--` key from `addurl --relaxed`, a WORM key, ...) and so could be
   * checked by NEITHER hash NOR size under `--no-verify` -- the same gap
   * `import-openneuro.ts`'s tree gate counts and reports rather than folding
   * into a reassuring total. Always 0 when `noVerify` was not requested.
   */
  unsizedFiles: number;
  /**
   * Print-ready lines for every `--no-verify` size mismatch this run found,
   * each ending in the manual recovery command -- present on EVERY arm
   * (`success: true` included), because the common shape is a `"partial"`
   * outcome (most files fine, one corrupt), and `failureText`/`error` is
   * only carried on `success: false`. `printPartialRetrieval`'s own text
   * points at a report this local check never writes, so the caller must
   * print these itself rather than relying on that generic path. A file
   * whose removal could not be confirmed gets a line here too, worded as an
   * unresolved warning rather than a completed reset (see the option doc on
   * `noVerify` above). Always `[]` when `noVerify` was not requested.
   */
  noVerifyMismatches: string[];
}

/**
 * Result of a retrieval. Discriminated on `success` so callers narrow to a
 * guaranteed `error` on the failure arm -- a step up from the flat
 * `{ success: boolean; error?: string }` shape used elsewhere in lib/git-annex,
 * where `error` is optional on both arms. Keeping the counts required on BOTH
 * arms means callers never need `?? 0` defaults, and `success` can never
 * disagree with `outcome`.
 */
export type GetDataResult =
  | ({ success: true; outcome: "complete" | "partial"; error?: undefined } & GetDataCounts)
  | ({ success: false; outcome: "failed"; error: string } & GetDataCounts);

/**
 * Build the result for a run that reached classification, keeping `success` and
 * `outcome` in lockstep. The two pre-classification failure returns (whole-run
 * non-zero exit, thrown exception) build the failed shape directly; every
 * classified outcome must route through here.
 * `errorText` is git-annex's own output, which carries the actionable detail
 * (no remotes configured, credentials rejected, host unreachable) that a bare
 * count throws away; the generic fallback fires only when it produced nothing.
 */
function toGetDataResult(
  outcome: GetOutcome,
  counts: GetDataCounts,
  errorText: string,
): GetDataResult {
  if (outcome === "failed") {
    return {
      success: false,
      outcome,
      error:
        errorText.trim() ||
        `${counts.filesUnavailable} file(s) unavailable from every configured remote`,
      ...counts,
    };
  }
  return { success: true, outcome, ...counts };
}

/**
 * Signals that the object is genuinely absent from the remote: the request was
 * answered, and the answer was "no such object".
 */
const CONTENT_ABSENT_RE = /not found|nosuchkey|no such key|does not exist/i;

/**
 * Signals that point at credentials, permissions, or connectivity rather than
 * missing content.
 *
 * Deliberately matches only TEXTUAL signals, never bare HTTP status numbers.
 * `\b40[13]\b` looked equivalent but matches BIDS subject directories: a run
 * over `sub-403/eeg/...` or `sub-501/anat/...` would be read as a permissions
 * or server failure purely because of a participant label. git-annex spells the
 * real causes out in words ("download failed: AccessDenied"), so the words are
 * both safer and sufficient.
 *
 * Note that git-annex's generic "Unable to access these remotes: <name>"
 * summary is intentionally NOT here: it is printed for plain 404s too (it
 * appears verbatim in the on003574 capture), so treating it as a transport
 * signal would misread every legitimately-absent file as a transport fault.
 */
const TRANSPORT_FAIL_RE =
  /access ?denied|forbidden|unauthori[sz]ed|invalid[^\n]*(key|token|credential)|expired|signaturedoesnotmatch|requesttimetooskewed|slow ?down|serviceunavailable|internalerror|throttl|could ?n[o']?t connect|connection (refused|reset|timed ?out)|network is unreachable|(?:could not |unable to )?resolve host|timed ?out/i;

/**
 * Decide the outcome of a `git annex get` run.
 *
 * git-annex retrieves every key it can and reports the rest as individual file
 * failures, so a non-zero exit means "something was unavailable", not "the
 * download did not happen". Availability is a property NEMAR reports, not a
 * precondition for serving (#1038): a dataset that is 99.998% present -- one
 * stray upstream temp file out of 65,063 -- must still download.
 *
 *   - Nothing unavailable         -> `complete`. Zero retrieved just means every
 *                                    requested file was already local.
 *   - Transport fault in output   -> `failed`, whatever the tallies. Checked
 *                                    BEFORE the retrieved count, because a
 *                                    fault can develop mid-run: STS credentials
 *                                    are short-lived (see s3-remote.ts), so a
 *                                    parallel `-J` run over a large dataset can
 *                                    easily land a few files and then 403 on
 *                                    every remaining one. Reading that as
 *                                    `partial` would exit 0 and tell the user
 *                                    the data is missing upstream when in fact
 *                                    a retry would fetch all of it.
 *   - Some retrieved, some not    -> `partial`.
 *   - Nothing retrieved, some not -> `failureText` breaks the tie. This is the
 *                                    ordinary re-run case: on a partially
 *                                    downloaded dataset git-annex silently skips
 *                                    the files already present, so a second
 *                                    `get` retrieves nothing and re-reports the
 *                                    same absent files. Treating that as fatal
 *                                    would make every repeat run exit 1.
 *
 * The tie-break reads git-annex's failure output because that is the only place
 * the distinction survives: "not found" means the archive answered and does not
 * have the object, while denied/expired/connection errors mean we never got a
 * usable answer. An unrecognised failure stays `failed`, so the ambiguous path
 * only ever downgrades to `partial` on positive evidence of absence.
 *
 * `requireComplete` (the CLI's --require-complete) collapses `partial` into
 * `failed` for pipelines that need all-or-nothing semantics.
 *
 * Pure -- no I/O; unit-tested without git-annex.
 */
export function classifyGetOutcome(input: {
  retrieved: number;
  unavailable: number;
  requireComplete?: boolean;
  /** git-annex stderr plus any per-file failure notes, for the tie-break. */
  failureText?: string;
}): GetOutcome {
  const { retrieved, unavailable, requireComplete = false, failureText = "" } = input;
  if (unavailable <= 0) return "complete";
  if (requireComplete) return "failed";
  if (TRANSPORT_FAIL_RE.test(failureText)) return "failed";
  if (retrieved > 0) return "partial";
  return CONTENT_ABSENT_RE.test(failureText) ? "partial" : "failed";
}

/**
 * Whether the location log currently claims `file`'s content is present
 * "here" (this clone), read directly from `whereis --json` rather than
 * trusted from another command's exit code -- an exit code is not evidence
 * (`.memory/git-annex-flag-and-log-truths.md`). Returns null when the
 * answer could not be read at all, which callers must treat as NOT
 * confirmed absent, the same fail-closed rule `batchSetKeyPresence` uses
 * for a retraction.
 */
async function isRecordedHere(datasetPath: string, file: string): Promise<boolean | null> {
  const { stdout } = await runCommand(["git", "annex", "whereis", "--json", "--", file], {
    cwd: datasetPath,
  });
  const line = stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as { whereis?: Array<{ here?: boolean }> };
    if (!Array.isArray(parsed.whereis)) return null;
    return parsed.whereis.some((location) => location.here === true);
  } catch {
    return null;
  }
}

/**
 * POSIX single-quoted, safe to paste into any shell: spaces, parentheses, a
 * leading dash, and an embedded quote all survive (review of #1523: a bare
 * `rm <file>` breaks on the first three).
 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The one manual-recovery line for a no-verify mismatch, `--`-guarded and quoted. */
function recoveryCommand(file: string): string {
  const quoted = shQuote(file);
  return `rm -- ${quoted} && git checkout -- ${quoted} && git annex get -- ${quoted}`;
}

/**
 * Get data files from remote (S3) for a cloned dataset.
 *
 * Always runs with `--json --json-progress` and tallies the per-file completion
 * events; `onProgress`, when supplied, just observes the same stream. There is
 * deliberately no plain-text path: under `-J` git-annex's human output is not
 * stable enough to parse. On 10.20240129 (what Ubuntu, and therefore CI, ships)
 * a parallel run interleaves the per-file headers onto one line and emits bare
 * `ok` lines afterwards, so a `get <file> ok` scan matches nothing; on
 * 10.20260717 the same run emits one clean line per file. The stream a line
 * lands on also shifts with whether stdout is a TTY. `--json` is identical on
 * both versions -- verified by running each in turn.
 *
 * Partial retrieval is reported, not treated as failure -- see
 * {@link classifyGetOutcome}.
 */
export async function getDatasetData(
  datasetPath: string,
  options: {
    jobs?: number;
    paths?: string[]; // Specific paths to get, or all if empty
    /**
     * Extra arguments inserted before the path arguments. Used by callers to
     * pass git-annex matching options like --include/--exclude/--and/--or
     * (and the literal "-(" / "-)" group delimiters).
     */
    extraArgs?: string[];
    credentials?: S3Credentials;
    onProgress?: DownloadProgressCallback;
    /** Treat any unavailable file as a failure (CLI --require-complete). */
    requireComplete?: boolean;
    /**
     * Run this invocation with `-c annex.verify=false`: git-annex skips
     * hashing each file against its key on receipt. Passed as a one-off `-c`
     * override, never written to repo or global git config (#1523).
     *
     * **Measured on git-annex 10.20260901: with verify off, `get` does not
     * even enforce the declared SIZE.** A remote object truncated to half its
     * key's `-s<bytes>` length, or swapped for different same-size content,
     * both come back `"success":true`. So when this is set, every file this
     * call reports as newly retrieved is re-checked here against the size
     * encoded in its key (the same size-only guarantee ADR 0062 gives the
     * HTTP path), and a mismatch is downgraded to a failure rather than
     * trusted. A mismatching file is also hunted with a local `fsck --fast`
     * (a stat, not a re-hash) so git-annex's own location log stops
     * claiming "here" holds good content -- the same reasoning ADR 0063
     * gives for never keeping an unproven copy.
     */
    noVerify?: boolean;
  } = {},
): Promise<GetDataResult> {
  const jobs = options.jobs || 4;
  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."];
  const extraArgs = options.extraArgs ?? [];

  const env = awsCredentialEnv(options.credentials) ?? {};

  const mergedEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => e[1] != null),
  );

  try {
    // Streaming mode: parse --json-progress lines as they arrive.
    // `-c annex.verify=false` (a git global option) must precede `annex`, not
    // follow it -- git-annex has no such flag of its own, and it is never
    // written to config (see the option doc above).
    const args = [
      "git",
      ...(options.noVerify ? ["-c", "annex.verify=false"] : []),
      "annex",
      "get",
      "--json",
      "--json-progress",
      "-J",
      jobs.toString(),
      ...extraArgs,
      ...paths,
    ];

    const proc = spawn({
      cmd: args,
      cwd: datasetPath,
      stdout: "pipe",
      stderr: "pipe",
      env: mergedEnv,
    });

    let filesDownloaded = 0;
    let filesUnavailable = 0;
    let unsizedFiles = 0;
    // Print-ready per-mismatch lines (see the field doc on GetDataCounts).
    // Not capped like unavailablePaths/failureNotes: this only ever holds
    // entries for a run's own `--no-verify` corruption, which -- unlike a
    // dataset with thousands of legitimately-missing upstream files -- is
    // rare by construction (it requires a bad transfer, not just an absent
    // file), so there is no realistic unbounded-growth case to guard here.
    const noVerifyMismatches: string[] = [];
    const unavailablePaths: string[] = [];
    // Per-file failure notes, joined with stderr for the classifier tie-break.
    // Capped like unavailablePaths: a many-file failure must not build an
    // unbounded string, and the "X more omitted" line still says the total.
    const failureNotes: string[] = [];
    let failureNotesOmitted = 0;
    const addFailureNote = (note: string): void => {
      if (failureNotes.length < MAX_UNAVAILABLE_SAMPLE) {
        failureNotes.push(note);
      } else {
        failureNotesOmitted++;
      }
    };
    let stderrOutput = "";
    const stderrChunks: Uint8Array[] = [];
    // Files this run reported as retrieved, kept only to re-check their size
    // when `noVerify` is set (see the option doc above); unused otherwise.
    const retrievedThisRun: Array<{ file: string; key: string }> = [];

    // Tally a completion line. Byte-progress lines carry neither `ok` nor
    // `success`, so they fall through both branches and are only forwarded to
    // onProgress. A per-file failure (`success:false`) is content git-annex
    // could not source from any remote -- recorded, not fatal (#1038).
    const recordLine = (parsed: GitAnnexProgressLine): void => {
      options.onProgress?.(parsed);
      if (parsed.ok === true || parsed.success === true) {
        filesDownloaded++;
        if (options.noVerify) {
          const file = parsed.file ?? parsed.action?.file;
          if (file && parsed.key) retrievedThisRun.push({ file, key: parsed.key });
        }
      } else if (parsed.ok === false || parsed.success === false) {
        filesUnavailable++;
        const file = parsed.file ?? parsed.action?.file;
        if (file && unavailablePaths.length < MAX_UNAVAILABLE_SAMPLE) {
          unavailablePaths.push(file);
        }
        // Real `-J --json-progress` failure events carry the cause in `note`
        // ("from s3-PUBLIC...\nUnable to access these remotes: ...") alongside
        // an `error-messages` array; the scalar `error` is belt-and-braces.
        if (parsed.note) addFailureNote(parsed.note);
        for (const message of parsed["error-messages"] ?? []) addFailureNote(message);
        if (parsed.error) addFailureNote(parsed.error);
      }
    };

    // Collect stderr in background
    const stderrPromise = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(value);
      }
      stderrOutput = decoder.decode(
        stderrChunks.reduce((acc, chunk) => {
          const merged = new Uint8Array(acc.length + chunk.length);
          merged.set(acc);
          merged.set(chunk, acc.length);
          return merged;
        }, new Uint8Array()),
      );
    })();

    // Stream and parse stdout JSON lines
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep partial last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          recordLine(JSON.parse(trimmed) as GitAnnexProgressLine);
        } catch {
          // Non-JSON lines are ignored
        }
      }
    }

    // Process any remaining buffer content
    if (buffer.trim().startsWith("{")) {
      try {
        recordLine(JSON.parse(buffer.trim()) as GitAnnexProgressLine);
      } catch {
        // Ignore partial lines
      }
    }

    await stderrPromise;
    const exitCode = await proc.exited;

    // A non-zero exit with no per-file failure lines is a whole-run error
    // (bad repo, unusable remote, git-annex itself failed) rather than
    // missing content -- keep those fatal and surface stderr.
    if (exitCode !== 0 && filesUnavailable === 0) {
      return {
        success: false,
        outcome: "failed",
        error: stderrOutput.trim() || "Failed to get dataset data",
        filesDownloaded,
        filesUnavailable,
        unavailablePaths,
        unsizedFiles: 0,
        noVerifyMismatches: [],
      };
    }

    // Re-check size for everything this run retrieved, when verification was
    // skipped. Deliberately AFTER the whole-run-error return above (that one
    // reads git-annex's own exit code and tally, untouched by this) and
    // AFTER `proc.exited` (running `fsck` while `get` is still writing to the
    // shared git-annex branch journal risks the two racing on it). A mismatch
    // downgrades the file from downloaded to unavailable, which is exactly
    // what an absent file looks like to `classifyGetOutcome` below -- a
    // corrupted no-verify fetch is reported the same way a genuinely missing
    // file is, not silently kept as a success.
    if (options.noVerify && retrievedThisRun.length > 0) {
      interface Mismatch {
        file: string;
        /** A locked tree's entry is a symlink into `.git/annex/objects/`. */
        isSymlink: boolean;
        reason: string;
      }
      const mismatches: Mismatch[] = [];
      for (const { file, key } of retrievedThisRun) {
        const declaredSize = annexKeyDeclaredSize(key);
        if (declaredSize === null) {
          // No embedded length to check against (a URL key from `addurl
          // --relaxed`, a WORM key, ...): accepted on the key's name alone,
          // same as import-openneuro.ts's tree gate. Counted, not silently
          // folded into a success this run cannot actually back up.
          unsizedFiles++;
          continue;
        }
        const fullPath = join(datasetPath, file);
        let actualSize: number | null;
        try {
          actualSize = statSync(fullPath).size;
        } catch {
          actualSize = null;
        }
        if (actualSize === declaredSize) continue;
        filesDownloaded--;
        // Counted here (the totals `classifyGetOutcome` and the CLI's
        // summary line report stay correct) but deliberately NOT added to
        // `unavailablePaths`: that list backs `printPartialRetrieval`'s
        // generic "not available from the archive" text, which points at a
        // server-side report this local check never wrote. A no-verify
        // mismatch gets its own reason and recovery command from
        // `noVerifyMismatches` instead, so it must not also show up in the
        // generic list meant for genuinely-missing-upstream files.
        filesUnavailable++;
        let isSymlink = false;
        try {
          isSymlink = lstatSync(fullPath).isSymbolicLink();
        } catch {
          // Already gone -- treated as unlocked below; there is no symlink
          // left to leave alone, and the cleanup step is a safe no-op on an
          // absent path either way.
        }
        mismatches.push({
          file,
          isSymlink,
          reason: `--no-verify accepted ${actualSize === null ? "a file that is no longer readable" : `${actualSize} byte(s)`}, but the key declares ${declaredSize}`,
        });
      }

      if (mismatches.length > 0) {
        // Best-effort quarantine through git-annex's own fsck. ITS EXIT CODE
        // IS NOT TRUSTED (an exit code is not evidence -- .memory/git-annex-
        // flag-and-log-truths.md): every path below is confirmed directly
        // against the location log, with `drop --force` as the fallback when
        // fsck did not manage to retract the claim. Measured: a `.git/annex
        // /bad` that fsck cannot create (a permissions issue, or something
        // already at that path) fails fsck's quarantine for that key while
        // leaving the rest of the repository -- and `drop --force`, whose
        // only job is making the log agree, not verifying content -- fully
        // writable.
        await runCommand(
          ["git", "annex", "fsck", "--fast", "--", ...mismatches.map((m) => m.file)],
          { cwd: datasetPath },
        );

        for (const { file, isSymlink, reason } of mismatches) {
          let confirmedGone = (await isRecordedHere(datasetPath, file)) === false;
          if (!confirmedGone) {
            await runCommand(["git", "annex", "drop", "--force", "--", file], {
              cwd: datasetPath,
            });
            confirmedGone = (await isRecordedHere(datasetPath, file)) === false;
          }

          if (!confirmedGone) {
            // Neither fsck nor a forced drop got the location log to agree
            // the content is gone. Do not touch the working tree, and do not
            // claim this file was cleaned: silently resetting a file the log
            // still calls present risks losing the only signal that
            // something here is still wrong.
            const warning = `${file}: ${reason}. Could not confirm this file was removed after a failed --no-verify fetch -- it may still hold corrupted content. Recover by hand: ${recoveryCommand(file)}`;
            addFailureNote(warning);
            noVerifyMismatches.push(warning);
            continue;
          }

          if (!isSymlink) {
            // A confirmed retraction already leaves a LOCKED tree's symlink
            // correctly dangling -- nothing further needed there. An
            // unlocked/adjusted tree's entry is an INDEPENDENT regular-file
            // copy, not a hardlink (measured: a distinct inode from the
            // object store even with `annex.thin` unset, which is NEMAR's
            // default), and neither fsck nor `drop --force` reliably resets
            // it once the location log already agrees content is gone
            // (measured in both orders). Removing it and letting `git
            // checkout --` restore whatever git-annex now legitimately has
            // for that path -- a pointer, since no copy is recorded here --
            // is the one mechanism that was reliable in every case tried.
            try {
              rmSync(join(datasetPath, file), { force: true });
            } catch {
              // Best effort; the recovery note below still covers it by hand.
            }
            await runCommand(["git", "checkout", "--", file], { cwd: datasetPath });
          }

          const message = `${file}: ${reason}. Recover with: ${recoveryCommand(file)}`;
          addFailureNote(message);
          noVerifyMismatches.push(message);
        }
      }
    }

    if (failureNotesOmitted > 0) {
      failureNotes.push(`...(${failureNotesOmitted} more failure note(s) omitted)`);
    }
    const failureText = `${stderrOutput}\n${failureNotes.join("\n")}`;
    const outcome = classifyGetOutcome({
      retrieved: filesDownloaded,
      unavailable: filesUnavailable,
      requireComplete: options.requireComplete,
      failureText,
    });
    return toGetDataResult(
      outcome,
      { filesDownloaded, filesUnavailable, unavailablePaths, unsizedFiles, noVerifyMismatches },
      // `failureText` (stderr plus per-file notes), not bare stderr: a
      // no-verify size mismatch has nothing in git-annex's own stderr --
      // git-annex thought the transfer succeeded -- so the only place the
      // reason lives is the note this function pushed above.
      failureText,
    );
  } catch (e) {
    return {
      success: false,
      outcome: "failed",
      error: (e as Error).message,
      filesDownloaded: 0,
      filesUnavailable: 0,
      unavailablePaths: [],
      unsizedFiles: 0,
      noVerifyMismatches: [],
    };
  }
}

/**
 * Drop local copies of annexed files (keeps remote copies intact).
 * Git-annex verifies remote copies exist before dropping.
 */
export async function dropFiles(
  datasetPath: string,
  paths?: string[],
): Promise<{ success: boolean; error?: string; dropped: number; kept: string[] }> {
  const targets = paths && paths.length > 0 ? paths : ["."];

  try {
    const args = ["git", "annex", "drop", ...targets];
    const { stdout, stderr, exitCode } = await runCommand(args, { cwd: datasetPath });

    if (exitCode !== 0) {
      // git-annex drop returns non-zero if some files couldn't be dropped
      // (e.g., no remote copies). Parse output for details.
      const kept: string[] = [];
      for (const line of stderr.split("\n")) {
        const match = line.match(/^drop (.+) \(unsafe\)/);
        if (match) kept.push(match[1]);
      }
      const dropMatches = stdout.match(/^drop .+ ok$/gm);
      const dropped = dropMatches ? dropMatches.length : 0;
      return { success: false, error: stderr.trim(), dropped, kept };
    }

    const dropMatches = stdout.match(/^drop .+ ok$/gm);
    const dropped = dropMatches ? dropMatches.length : 0;
    return { success: true, dropped, kept: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg || "Unknown error during drop", dropped: 0, kept: [] };
  }
}

/** Lines from git-annex copy output worth surfacing as the failure cause. */
const COPY_ERROR_RE =
  /fail|error|denied|forbidden|entitytoolarge|too large|multipart|exceed|timed?\s*out|not\s+enough|no\s+space|access\s+key/i;

/**
 * Extract a useful error message from a failed `git annex copy`.
 *
 * git-annex writes the real S3 failure (e.g. 400 EntityTooLarge on a >5 GB
 * single-part PUT) to STDOUT, not stderr, so surfacing only `stderr.trim()`
 * left users with the generic "Failed to copy to remote" and no diagnosable
 * cause (#886). Prefer stderr; otherwise pull the informative lines from stdout
 * (falling back to its tail), so the actual reason reaches the CLI.
 *
 * Exported for unit testing; not part of the CLI-facing surface.
 */
const MAX_COPY_ERROR_LINES = 20;

export function extractCopyError(stdout: string, stderr: string): string {
  const err = stderr.trim();
  if (err) return err;
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const relevant = lines.filter((l) => COPY_ERROR_RE.test(l));
  // Cap the output: `git annex copy -J . ` fails per-file, and COPY_ERROR_RE
  // matches generic words (fail/error), so a many-file failure could otherwise
  // surface hundreds of lines into the CLI. Keep the last N (the tail carries
  // git-annex's summary line), noting how many were dropped. Matches the bounded
  // subprocess-error convention in github.ts / import-openneuro.ts.
  let chosen: string[];
  if (relevant.length > MAX_COPY_ERROR_LINES) {
    const omitted = relevant.length - MAX_COPY_ERROR_LINES;
    chosen = [
      `...(${omitted} earlier error lines omitted)`,
      ...relevant.slice(-MAX_COPY_ERROR_LINES),
    ];
  } else if (relevant.length) {
    chosen = relevant;
  } else {
    chosen = lines.slice(-8);
  }
  const picked = chosen.join("\n").trim();
  return picked || "Failed to copy to remote";
}

/** One parsed `--json` record of `git annex copy` or `git annex fsck`. */
export interface CopyJsonRecord {
  file: string | null;
  key: string | null;
  success: boolean;
  /**
   * True when git-annex moved the content in this copy, false when it found the
   * remote already holding it. A transfer carries the progress note ("to nemar-s3...");
   * an object found already present carries no note at all (measured against
   * git-annex 10.20260901 with a `directory` remote). A git-annex that words or omits
   * the note differently makes this count LOW, which changes what a summary says and
   * never whether a step succeeds: success rests on the exit status and the location log.
   */
  transferred: boolean;
  /**
   * Why a failed record failed. Empty on success, and also possibly empty on a
   * failure that gave no reason; see {@link parseCopyJson}. Credentials are removed
   * from it ({@link redactCredentials}).
   */
  errors: string[];
}

/**
 * Progress text git-annex puts in `note` of a record that moved content ("to
 * nemar-s3..."). It is not a reason, so a failed record that carries only this has
 * none.
 */
const COPY_PROGRESS_NOTE = /^(?:to|from) \S+\.\.\.$/;

/** The longest reason worth printing; a printed HTTP request is far longer. */
const MAX_REASON_CHARS = 600;

/** One printable line for a reason: whitespace collapsed, the middle of a long one cut. */
function shortenReason(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_REASON_CHARS) return flat;
  const head = Math.floor(MAX_REASON_CHARS * 0.35);
  return `${flat.slice(0, head)} ... ${flat.slice(flat.length - (MAX_REASON_CHARS - head))}`;
}

function parseJsonRecords(
  stdout: string,
  command: string,
  secrets: readonly string[],
): CopyJsonRecord[] {
  // Every reason is credential-free, one line, and safe for a terminal: git-annex echoes
  // file names inside its messages ("** Based on the location log, <name>").
  const clean = (text: string): string =>
    displayName(shortenReason(redactCredentials(text, secrets)));
  const records: CopyJsonRecord[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    if (rec.command !== undefined && rec.command !== command) continue;
    if (typeof rec.success !== "boolean") continue;
    const messages = Array.isArray(rec["error-messages"])
      ? (rec["error-messages"] as unknown[])
          .filter((m): m is string => typeof m === "string")
          .map((m) => clean(m))
          .filter(Boolean)
      : [];
    const note = typeof rec.note === "string" ? rec.note.trim() : "";
    let errors: string[] = [];
    if (!rec.success) {
      errors = [...new Set(messages)];
      if (errors.length === 0 && note && !COPY_PROGRESS_NOTE.test(note)) errors = [clean(note)];
    }
    records.push({
      file: typeof rec.file === "string" ? rec.file : null,
      key: typeof rec.key === "string" ? rec.key : null,
      success: rec.success,
      transferred: rec.success && COPY_PROGRESS_NOTE.test(note),
      errors,
    });
  }
  return records;
}

/**
 * Parse the `--json --json-error-messages` output of `git annex copy`.
 *
 * The JSON records are git-annex's machine interface, one object per line; the
 * `copy <file> ok` lines it prints for people are display text. Lines that are not
 * JSON objects (git-annex can still print bookkeeping such as "(recording state in
 * git...)") are ignored. Exported for unit tests.
 *
 * A failed record's reason is in one of two places, both measured against
 * git-annex 10.20260901 with a `directory` remote. A transfer that was attempted
 * and failed (a read-only store) fills `error-messages`, with each message
 * repeated; a remote git-annex declined to use before trying (a store directory
 * that is gone) leaves `error-messages` EMPTY and says why in `note`. Reading only
 * the first would turn the second into "file: failed" with no cause, so the reason
 * is the de-duplicated messages, else the note unless it is progress text. Either
 * can be a printed HTTP request for an S3 remote; it is stripped of credentials and
 * cut to one line before it is kept. `secrets` are values to blank wherever they occur.
 */
export function parseCopyJson(stdout: string, secrets: readonly string[] = []): CopyJsonRecord[] {
  return parseJsonRecords(stdout, "copy", secrets);
}

/** The same for `git annex fsck --json`. Exported for unit tests. */
export function parseFsckJson(stdout: string, secrets: readonly string[] = []): CopyJsonRecord[] {
  return parseJsonRecords(stdout, "fsck", secrets);
}

/**
 * Error text for a failed JSON-mode `git annex` run (`command` says which: `copy`, or
 * `fsck` for the presence check): the per-file error messages git-annex reported
 * (bounded like extractCopyError), falling back to the human-output extraction when no
 * record failed. File names are shown escaped. Exported for unit tests.
 *
 * When no record failed, stdout is NOT searched for error words: in JSON mode every
 * record carries an `error-messages` key, so the word "error" matches a success
 * record and the raw JSON line would become the message. What is left to say is
 * stderr, the exit code (a killed process has no other trace), and, when stdout had
 * content but none of it was a copy record, that the output was not recognized.
 */
export function extractCopyJsonError(
  records: CopyJsonRecord[],
  stdout: string,
  stderr: string,
  exitCode?: number,
  command: "copy" | "fsck" = "copy",
): string {
  const failed = records.filter((r) => !r.success);
  const lines = failed.map((r) => {
    const why =
      r.errors
        .map((e) => e.trim())
        .filter(Boolean)
        .join("; ") || "failed";
    return `${displayName(r.file ?? r.key ?? "(unknown file)")}: ${why}`;
  });
  const err = stderr.trim();
  if (lines.length === 0) {
    const code = exitCode === undefined ? "" : ` with exit code ${exitCode}`;
    if (records.length === 0 && stdout.trim()) {
      return `git annex ${command} failed${code}; its output was not recognized as ${command} records${err ? `: ${err}` : ""}`;
    }
    return err
      ? `git annex ${command} failed${code}: ${err}`
      : `git annex ${command} failed${code} without saying why`;
  }
  const shown =
    lines.length > MAX_COPY_ERROR_LINES
      ? [
          `...(${lines.length - MAX_COPY_ERROR_LINES} earlier failed files omitted)`,
          ...lines.slice(-MAX_COPY_ERROR_LINES),
        ]
      : lines;
  const what = command === "copy" ? "to copy" : "the presence check";
  return [`${failed.length} file(s) failed ${what}:`, ...shown, ...(err ? [err] : [])].join("\n");
}

/**
 * Whether output was considered complete (`understood`), had fewer records than an expected
 * count, including none (`partial`), or was nonempty but parsed no records (`unrecognized`).
 * Completeness is based on record count, not path identity; the exit status is separate.
 */
export type OutputState = "understood" | "partial" | "unrecognized";

/** What a JSON-mode `git annex copy` run amounted to. */
export interface CopyOutcome {
  success: boolean;
  error?: string;
  /** Successful records: files git-annex reported at the remote after this run. */
  filesCopied: number;
  /** Of those, the ones git-annex actually transferred rather than found already there. */
  filesSent: number;
  /** Paths transferred, retained so an expired-chunk retry can count unique sends. */
  sentPaths: string[];
  /** Whether the counts above are evidence: anything but `understood` makes them not. */
  output: OutputState;
}

/**
 * Run one JSON-mode `git annex copy --to <remote>` over `pathspecs` and say what it
 * amounted to. Deliberately NOT `--fast`: without it git-annex checks the remote
 * for the content of each key and re-sends one the location log wrongly says is
 * there, which is how this step notices a store that lost objects. `expectedRecords`
 * is how many paths were named explicitly; a clean exit with fewer records than that
 * means git-annex skipped some (a path whose content is not in this repository gets no
 * record and no remote contact).
 */
async function runJsonCopy(
  datasetPath: string,
  remoteName: string,
  jobs: number,
  pathspecs: string[],
  env: Record<string, string> | undefined,
  expectedRecords?: number,
): Promise<CopyOutcome> {
  const { stdout, stderr, exitCode } = await runCommand(
    [
      "git",
      "annex",
      "copy",
      "--to",
      remoteName,
      "-J",
      jobs.toString(),
      "--json",
      "--json-error-messages",
      "--",
      ...pathspecs,
    ],
    { cwd: datasetPath, env },
  );
  const secrets = credentialValues(env);
  const records = parseCopyJson(stdout, secrets);
  const filesCopied = records.filter((r) => r.success).length;
  const sentPaths = records.flatMap((r) => (r.transferred && r.file !== null ? [r.file] : []));
  const filesSent = records.filter((r) => r.transferred).length;
  const printed = records.length > 0 || !stdout.trim();
  const complete = expectedRecords === undefined || records.length >= expectedRecords;
  let output: OutputState = "understood";
  if (!printed) output = "unrecognized";
  else if (!complete) output = "partial";
  // A failed record means a failed copy, whatever the exit status says.
  if (exitCode !== 0 || records.some((r) => !r.success)) {
    return {
      success: false,
      error: extractCopyJsonError(records, stdout, redactCredentials(stderr, secrets), exitCode),
      filesCopied,
      filesSent,
      sentPaths,
      output,
    };
  }
  return { success: true, filesCopied, filesSent, sentPaths, output };
}

/** What {@link checkRemoteHolds} found. */
export interface RemoteHoldsOutcome {
  /** False when the check itself could not run (the remote is unreachable, git-annex was killed). */
  success: boolean;
  error?: string;
  /** Files git-annex reported as present at the remote. */
  present: number;
  /**
   * Files whose fsck record FAILED, with its reason: either the remote lacks them (fsck
   * then also strikes them from the location log) or fsck could not ask. Which of the two
   * is told by the location log afterwards, never by the wording.
   */
  absent: Array<{ file: string; errors: string[] }>;
  /**
   * Paths fsck printed no record for at all: not asked, whatever the exit status said.
   * A caller must not read these as present.
   */
  unanswered: string[];
  /** `partial` when any path has no record; `unrecognized` when nonempty output has no records. */
  output: OutputState;
}

/**
 * Ask the remote itself whether it holds the content of `paths`, for files whose content
 * is NOT in this repository. `git annex copy --to` cannot do that: it has no content to
 * send, so it skips such a path with exit 0, no record and no contact with the remote,
 * and a clone that holds only pointers hits this on every file. `git annex fsck --fast
 * --from <remote>` checks presence only (no content is read), exits 1 with a failed
 * record for each file the remote lacks, and corrects the location log to say so, so the
 * walk that follows sees it. Run with `-J jobs`, in argv-safe chunks.
 *
 * `--numcopies=1 --mincopies=1`: fsck also enforces the repository's numcopies, so with
 * `git annex numcopies 2` configured and the one copy at this remote it fails a file the
 * remote DOES hold ("Only 1 of 2 trustworthy copies exist"), and no re-run could help.
 * This question is whether the remote holds the file, not whether there are enough copies.
 */
export async function checkRemoteHolds(
  datasetPath: string,
  remoteName: string,
  paths: string[],
  jobs = 4,
  credentials?: S3Credentials,
): Promise<RemoteHoldsOutcome> {
  const env = awsCredentialEnv(credentials);
  const secrets = credentialValues(env);
  let present = 0;
  let unrecognized = false;
  const unanswered: string[] = [];
  const absent: Array<{ file: string; errors: string[] }> = [];
  const state = (): OutputState => {
    if (unrecognized) return "unrecognized";
    return unanswered.length > 0 ? "partial" : "understood";
  };
  try {
    for (const chunk of chunkAddTargets(paths)) {
      const { stdout, stderr, exitCode } = await runCommand(
        [
          "git",
          "annex",
          "fsck",
          "--fast",
          "--numcopies=1",
          "--mincopies=1",
          "--from",
          remoteName,
          "-J",
          jobs.toString(),
          "--json",
          "--json-error-messages",
          "--",
          ...chunk,
        ],
        { cwd: datasetPath, env },
      );
      const records = parseFsckJson(stdout, secrets);
      const failed = records.filter((r) => !r.success);
      present += records.length - failed.length;
      if (records.length === 0 && stdout.trim()) unrecognized = true;
      const answered = new Set(records.map((r) => r.file));
      for (const p of chunk) if (!answered.has(p)) unanswered.push(p);
      for (const r of failed)
        absent.push({ file: r.file ?? r.key ?? "(unknown file)", errors: r.errors });
      if (exitCode !== 0 && failed.length === 0) {
        // Non-zero with no failed record: the check did not run, which says nothing about the files.
        return {
          success: false,
          error: extractCopyJsonError(
            records,
            stdout,
            redactCredentials(stderr, secrets),
            exitCode,
            "fsck",
          ),
          present,
          absent,
          unanswered,
          output: state(),
        };
      }
    }
    return { success: true, present, absent, unanswered, output: state() };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      present,
      absent,
      unanswered,
      output: state(),
    };
  }
}

/**
 * Copy annexed content to a remote.
 *
 * When credentials are provided, they are passed as env vars to the subprocess.
 * Otherwise inherits environment credentials (AWS_ACCESS_KEY_ID, etc.).
 *
 * `filesCopied` counts the successful `--json` copy records: files git-annex
 * confirmed are at the remote after this run (whether transferred now or
 * already there). It is a number for the operator, not proof of availability;
 * ask the location log for that (`listAnnexedPaths(path, remote)`).
 */
export async function copyToAnnexRemote(
  datasetPath: string,
  remoteName: string,
  jobs = 4,
  credentials?: S3Credentials,
): Promise<CopyOutcome> {
  try {
    return await runJsonCopy(datasetPath, remoteName, jobs, ["."], awsCredentialEnv(credentials));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: msg || "Unknown error during copy",
      filesCopied: 0,
      filesSent: 0,
      sentPaths: [],
      output: "understood",
    };
  }
}

/** Drop orphan annex keys (no longer referenced by any branch). */
export async function dropUnusedAnnexObjects(
  datasetPath: string,
): Promise<{ success: boolean; error?: string; dropped?: number }> {
  // Without --prune-tags here, stale local tags would keep their content
  // 'reachable' and `git annex unused` would skip those keys.
  const { stderr: pruneStderr, exitCode: pruneCode } = await runCommand(
    ["git", "fetch", "--prune", "--prune-tags", "origin"],
    { cwd: datasetPath },
  );
  if (pruneCode !== 0) {
    return {
      success: false,
      error: pruneStderr.trim() || "git fetch --prune-tags failed",
    };
  }

  const { exitCode: unusedCode, stderr: unusedStderr } = await runCommand(
    ["git", "annex", "unused"],
    { cwd: datasetPath },
  );
  if (unusedCode !== 0) {
    return { success: false, error: unusedStderr.trim() || "git annex unused failed" };
  }

  const { stdout, stderr, exitCode } = await runCommand(
    ["git", "annex", "dropunused", "--force", "all"],
    { cwd: datasetPath },
  );
  if (exitCode !== 0) {
    return { success: false, error: stderr.trim() || "git annex dropunused failed" };
  }

  const dropMatches = stdout.match(/^dropunused .+ ok$/gm);
  return { success: true, dropped: dropMatches ? dropMatches.length : 0 };
}

// =============================================================================
// File Manifest Collection
// =============================================================================

/**
 * File info for upload manifest
 */
export interface DatasetFileInfo {
  path: string;
  size: number;
  type: "metadata" | "data";
  /** Working-tree mtime; drives upload-progress change detection (#884). */
  mtimeMs?: number;
}

/**
 * Collect file manifest for a dataset.
 *
 * "data" means git-annex will take it (S3); "metadata" means it stays in plain
 * git (GitHub). The split is decided by the shared policy in `policy.ts` -- the
 * same rule that renders `annex.largefiles` -- so the plan shown to the user and
 * the files actually uploaded cannot disagree.
 */
export async function collectFileManifest(datasetPath: string): Promise<{
  files: DatasetFileInfo[];
  totalSize: number;
  dataFiles: number;
  metadataFiles: number;
}> {
  const files: DatasetFileInfo[] = [];
  let totalSize = 0;
  let dataFiles = 0;
  let metadataFiles = 0;

  // Use find to get all files and symlinks (excluding .git, .nemar, and .gitattributes)
  // Git-annex replaces data files with symlinks to .git/annex/objects/
  const { stdout, exitCode } = await runCommand(
    [
      "find",
      ".",
      "(",
      "-type",
      "f",
      "-o",
      "-type",
      "l",
      ")",
      "-not",
      "-path",
      "./.git/*",
      "-not",
      "-path",
      "./.nemar/*",
      "-not",
      "-name",
      ".gitattributes",
    ],
    { cwd: datasetPath },
  );

  if (exitCode !== 0) {
    return { files, totalSize, dataFiles, metadataFiles };
  }

  const filePaths = stdout.trim().split("\n").filter(Boolean);

  for (const filePath of filePaths) {
    // Clean up path (remove leading ./)
    const relativePath = filePath.startsWith("./") ? filePath.slice(2) : filePath;
    const absolutePath = join(datasetPath, relativePath);

    try {
      const stats = statSync(absolutePath);
      const size = stats.size;
      totalSize += size;

      // "data" means "git-annex will take this, or the upload forces it" (see
      // `isCaseVariantData`), so the caller's addTargets are the files that end up in
      // S3. A file this rule calls metadata never reaches `git annex add`, but the
      // save's `git add -A` still runs git-annex's clean filter, which annexes it when
      // it is over the size threshold under a name the case-sensitive exclusions miss
      // (ADR 0031, amendment of 2026-10-07).
      const isDataFile = shouldAnnex(relativePath, size);
      const fileType: "metadata" | "data" = isDataFile ? "data" : "metadata";

      if (isDataFile) {
        dataFiles++;
      } else {
        metadataFiles++;
      }

      files.push({
        path: relativePath,
        size,
        type: fileType,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // Skip files we can't stat
    }
  }

  return { files, totalSize, dataFiles, metadataFiles };
}

// =============================================================================
// S3-to-S3 copy helpers (OpenNeuro import)
// =============================================================================

/**
 * Get git-annex keys and their known URLs for files in the current tree.
 * Returns a Map of key -> source S3 URL (first HTTP/S3 URL found).
 */
/**
 * Parse one `git annex whereis --json` line and record its key -> first usable
 * (http/s3) source URL into `keyUrlMap`. Pure + exported so the streaming reader
 * and tests share the exact extraction. Malformed JSON is skipped silently.
 */
export function extractWhereisKeyUrl(line: string, keyUrlMap: Map<string, string>): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const entry = JSON.parse(trimmed);
    const key = entry.key;
    if (!key) return;
    // Collect URLs from all whereis entries (trusted + untrusted).
    const whereis = [...(entry.whereis || []), ...(entry.untrusted || [])];
    for (const remote of whereis) {
      if (!Array.isArray(remote.urls)) continue;
      for (const url of remote.urls) {
        if (typeof url === "string" && (url.startsWith("http") || url.startsWith("s3://"))) {
          keyUrlMap.set(key, url);
          break;
        }
      }
      if (keyUrlMap.has(key)) break;
    }
  } catch (err) {
    if (err instanceof SyntaxError) return;
    console.error(
      `Warning: failed to process whereis entry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getAnnexWhereisAll(
  datasetPath: string,
): Promise<{ urlMap: Map<string, string>; fileCount: number }> {
  // STREAM the output, never buffering it whole. A large dataset (e.g. ds006110
  // = 66k annexed files) emits ~100MB+ of JSON; collecting that into one string
  // (the old runCommand path) spiked memory and got the 2-core import runner
  // OOM-killed mid-"Mapping annexed files" ("operation canceled"), file-count-
  // bound (#808). Reading line-by-line keeps only the compact key->URL map in
  // memory. "-- ." (not "--all") skips orphaned keys from old history (ds000117
  // had 718 such spurious failures).
  const proc = spawn({
    cmd: ["git", "annex", "whereis", "--json", "--", "."],
    cwd: datasetPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  // Drain stderr CONCURRENTLY with stdout. git-annex can emit a stderr line per
  // file (offline remote, URL check) -- on a 66k-file dataset that exceeds the
  // ~64KB OS pipe buffer, and if we only read stderr AFTER the stdout loop the
  // child blocks writing stderr while we block reading stdout (deadlock). The
  // promise reads stderr in the background; we await it after the loop.
  const stderrPromise = new Response(proc.stderr).text();

  const keyUrlMap = new Map<string, string>();
  const decoder = new TextDecoder();
  let pending = "";
  let sawOutput = false;
  // One whereis --json line == one annexed file (with or without a usable URL).
  // fileCount counts them so the import can tell "no annexed data at all" from
  // "annexed data exists but none mapped to a copyable URL" (#828): the latter
  // must not publish an empty dataset.
  let fileCount = 0;
  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) {
        sawOutput = true;
        fileCount++;
        extractWhereisKeyUrl(line, keyUrlMap);
      }
      nl = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    sawOutput = true;
    fileCount++;
    extractWhereisKeyUrl(pending, keyUrlMap);
  }

  const stderr = (await stderrPromise).trim();
  const exitCode = await proc.exited;
  if (exitCode !== 0 && !sawOutput) {
    throw new Error(`git annex whereis failed: ${stderr}`);
  }
  if (exitCode !== 0) {
    // Only tolerate the expected "whereis: N failed" pattern (files with no
    // known location). Any other non-zero exit is an unexpected error.
    const failMatch = stderr.match(/whereis:\s*(\d+)\s*failed/);
    if (failMatch) {
      console.warn(
        `  Warning: ${failMatch[1]} files had no location info (continuing with available files)`,
      );
    } else {
      throw new Error(`git annex whereis failed (exit ${exitCode}): ${stderr}`);
    }
  }

  return { urlMap: keyUrlMap, fileCount };
}

/**
 * Get the hash directory path for a git-annex key.
 * Used to construct the S3 destination path.
 */
export async function getKeyHashDir(datasetPath: string, key: string): Promise<string> {
  const result = await runCommand(["git", "annex", "examinekey", "--format=${hashdirlower}", key], {
    cwd: datasetPath,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git annex examinekey failed for ${key}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Batch get hash directories for multiple keys.
 * More efficient than calling getKeyHashDir one at a time.
 */
export async function getKeyHashDirs(
  datasetPath: string,
  keys: string[],
): Promise<Map<string, string>> {
  const hashDirMap = new Map<string, string>();
  // Limit concurrency to avoid overwhelming the system with subprocesses
  const batchSize = 50;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (key) => {
        const hashDir = await getKeyHashDir(datasetPath, key);
        return { key, hashDir };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        hashDirMap.set(r.value.key, r.value.hashDir);
      } else {
        console.error(`Warning: failed to resolve hash dir: ${r.reason?.message || "unknown"}`);
      }
    }
  }
  return hashDirMap;
}

/**
 * Get the UUID of a configured git-annex remote.
 */
export async function getRemoteUuid(
  datasetPath: string,
  remoteName: string,
): Promise<string | null> {
  const result = await runCommand(["git", "config", `remote.${remoteName}.annex-uuid`], {
    cwd: datasetPath,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Mark ONE git-annex key as present in a remote, trusting the exit code.
 *
 * It has no callers left, and it must not get any for bulk work: running this
 * per key concurrently is #1392 exactly -- every process exits 0 and their writes
 * to the shared git-annex branch journal do not all survive. `batchSetKeysPresent`
 * is the bulk path; it uses one `setpresentkey --batch` process and then reads the
 * location log back instead of believing the exit codes.
 */
export async function setKeyPresent(
  datasetPath: string,
  key: string,
  remoteUuid: string,
): Promise<boolean> {
  const result = await runCommand(["git", "annex", "setpresentkey", key, remoteUuid, "1"], {
    cwd: datasetPath,
  });
  return result.exitCode === 0;
}

/** What the location log says after a registration, which is the only thing that counts. */
export interface KeyRegistrationResult {
  /** Keys the location log now records at the remote. */
  success: number;
  /** Keys it does not, after asking it directly. */
  failed: number;
  /** Up to ten of those, for the caller's error message. */
  missing: string[];
}

/**
 * Keys the location log records as present at `remoteUuid`, among those the
 * tree names, or `null` when the question could not be answered at all.
 *
 * The null matters more than it looks. This used to return an EMPTY SET on
 * failure, justified by "every key then falls through to the per-key whereis".
 * That is true only when asserting: the shared filter is
 * `recorded.has(key) !== present`, so for a RETRACTION an empty set means no key
 * is unconfirmed, nothing is probed, and every claim is reported withdrawn
 * without one being checked. `git annex find --in <uuid>` exits 1 with an
 * uncaught exception whenever the uuid is not resolvable as a remote in that
 * clone, which is an ordinary condition in a fresh fleet clone, so this was
 * reachable rather than theoretical.
 */
async function keysRecordedAt(
  datasetPath: string,
  remoteUuid: string,
): Promise<Set<string> | null> {
  const { stdout, stderr, exitCode } = await runCommand(
    ["git", "annex", "find", "--include", "*", "--in", remoteUuid, "--format=${key}\n"],
    { cwd: datasetPath },
  );
  if (exitCode !== 0) {
    console.warn(
      `git annex find --in ${remoteUuid} failed (${stderr.trim() || `exit ${exitCode}`}); falling back to one whereis per key, which is slow on a large dataset.`,
    );
    return null;
  }
  return new Set(stdout.split("\n").filter(Boolean));
}

/**
 * Whether the location log records `key` at `remoteUuid`, asked per key.
 *
 * Reads `--json` rather than the exit code, because the exit code answers a
 * different question: `whereis` exits 1 for a key with ZERO copies, which is
 * precisely the state a fully retracted key is in, so an `exitCode !== 0` test
 * reports every correct final retraction as a failure. Measured on git-annex
 * 10.20260901: 0 copies gives exit 1 with `{"success":false,"whereis":[]}`.
 *
 * Returns null when the answer could not be read, which callers must treat as
 * unconfirmed rather than as either verdict.
 */
async function keyRecordedAt(
  datasetPath: string,
  key: string,
  remoteUuid: string,
): Promise<boolean | null> {
  const { stdout } = await runCommand(["git", "annex", "whereis", "--key", key, "--json"], {
    cwd: datasetPath,
  });
  const line = stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as {
      whereis?: Array<{ uuid?: string }>;
      untrusted?: Array<{ uuid?: string }>;
    };
    // `untrusted` holds copies too; a claim there is still a claim.
    return [...(parsed.whereis ?? []), ...(parsed.untrusted ?? [])].some(
      (location) => location.uuid === remoteUuid,
    );
  } catch {
    return null;
  }
}

/**
 * Mark keys as present in a remote, and prove it from the location log.
 *
 * **One process, not one per key.** This used to run fifty `git annex setpresentkey`
 * processes concurrently and count every exit-0 as a registration. They all exit 0;
 * their writes to the shared git-annex branch journal do not all survive. An import
 * of 117 keys reported "Registered 117 files" and recorded NONE of them, then
 * published the dataset -- public, permanent DOI -- with content no clone could
 * resolve from NEMAR (#1392). `setpresentkey --batch` is the interface built for
 * this: one process, one journal, keys fed on stdin.
 *
 * **Then it asks the log.** An exit code says a command ran, not that a record
 * exists, and the caller's decision to publish rests on the record. `find --in
 * <uuid>` answers for every key the tree names; a key the tree does not name -- which
 * `find` cannot see -- is checked individually with `whereis --key`, so an unusual
 * caller pays per-key cost only for the keys that need it.
 *
 * One malformed key aborts the rest of ITS chunk (git-annex stops the batch with
 * "Batch input parse failure"), which is why the read-back is not optional: the keys
 * behind the bad one come back as missing and the caller stops, rather than a
 * publish proceeding on a partial registration nobody counted.
 */
export async function batchSetKeysPresent(
  datasetPath: string,
  keys: string[],
  remoteUuid: string,
): Promise<KeyRegistrationResult> {
  return batchSetKeyPresence(datasetPath, keys, remoteUuid, true);
}

/**
 * Withdraw a presence claim, and prove from the log that it is gone.
 *
 * The counterpart, and it exists because a claim can outlive the content. A
 * failed copy leaves a zero-byte object under the right key name, every check
 * that asks only whether the key exists counts it as content (#967), and this
 * registration then tells every clone to fetch bytes NEMAR does not hold. When
 * the content cannot be recovered -- upstream deleted it, or never exported it
 * -- the claim cannot be made true, so the only honest repair is to retract it:
 * 230 keys across five datasets whose anatomical images OpenNeuro removed.
 *
 * Retracting is not the same shape as asserting, so the read-back is inverted:
 * success is the key NO LONGER being recorded at the remote. Reusing the
 * assert-side check would report every retraction as a failure.
 */
export async function batchSetKeysAbsent(
  datasetPath: string,
  keys: string[],
  remoteUuid: string,
): Promise<KeyRegistrationResult> {
  return batchSetKeyPresence(datasetPath, keys, remoteUuid, false);
}

async function batchSetKeyPresence(
  datasetPath: string,
  keys: string[],
  remoteUuid: string,
  present: boolean,
): Promise<KeyRegistrationResult> {
  if (keys.length === 0) return { success: 0, failed: 0, missing: [] };

  const flag = present ? "1" : "0";
  const CHUNK = 5000;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const stdin = `${chunk.map((key) => `${key} ${remoteUuid} ${flag}`).join("\n")}\n`;
    // A non-zero exit is not the failure signal this function reports -- the log is --
    // but it is worth surfacing, because it usually means the batch never ran at all.
    const { exitCode, stderr } = await runCommand(["git", "annex", "setpresentkey", "--batch"], {
      cwd: datasetPath,
      stdin,
    });
    if (exitCode !== 0) {
      console.warn(
        `[git-annex] setpresentkey --batch exited ${exitCode} for ${chunk.length} key(s): ${stderr.trim().slice(0, 300)}`,
      );
    }
  }

  const recorded = await keysRecordedAt(datasetPath, remoteUuid);
  // `find --in <uuid>` only sees keys the working tree names, so its silence is
  // not evidence either way: a key it did not report is asked about directly.
  // And when it could not answer AT ALL, every key is unconfirmed -- in both
  // directions. Scoring "the oracle failed" as "the claim is gone" is how a
  // retraction that never ran reports total success.
  const unconfirmed =
    recorded === null ? keys : keys.filter((key) => recorded.has(key) !== present);
  const missing: string[] = [];
  for (const key of unconfirmed) {
    const stillRecorded = await keyRecordedAt(datasetPath, key, remoteUuid);
    // null is unreadable, which is not proof of either state, so it counts as
    // not done. The caller stops and the operator re-runs.
    if (stillRecorded === null || stillRecorded !== present) missing.push(key);
  }

  return {
    success: keys.length - missing.length,
    failed: missing.length,
    missing: missing.slice(0, 10),
  };
}

/**
 * Map each given working-tree path to the annex key holding its content.
 *
 * `git annex find` is the oracle rather than `readlink` on the symlink: a repo
 * on an adjusted-unlock branch stores a pointer file, not a symlink, so reading
 * the link target silently finds nothing there (the same trap `findUnannexedData`
 * documents).
 *
 * **Presence-filtered, deliberately.** Bare `git annex find` reports only files
 * whose content is in the local annex, so a path is absent from the map when it
 * is still in plain git AND when it is annexed with the content elsewhere. That
 * makes this "annexed and held here", which is the stronger question for a caller
 * about to upload from this clone -- it can fail closed, never open. A caller
 * that wants every annexed path regardless of presence wants
 * `listAnnexedPaths`, which passes `--include '*'`.
 *
 * A path git itself does not know is an error, not an absence: `git annex find`
 * exits non-zero on an unmatched pathspec and this throws.
 *
 * Paths are passed in argv-safe chunks; a dataset can name thousands at once.
 */
export async function getAnnexKeysForPaths(
  datasetPath: string,
  paths: string[],
): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  if (paths.length === 0) return keys;

  for (const chunk of chunkAddTargets(paths)) {
    const { stdout, exitCode, stderr } = await runCommand(
      ["git", "annex", "find", "--format=${key}\\t${file}\\n", "--", ...chunk],
      { cwd: datasetPath },
    );
    if (exitCode !== 0) {
      throw new Error(`git annex find failed: ${stderr.trim() || `exit ${exitCode}`}`);
    }
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      keys.set(line.slice(tab + 1), line.slice(0, tab));
    }
  }
  return keys;
}

/**
 * Every annexed working-tree path mapped to its key, whether or not the content
 * is in this clone.
 *
 * The presence-independent counterpart to {@link getAnnexKeysForPaths}. `--include
 * '*'` is what makes it presence-independent, the same way `listAnnexedPaths` does
 * it. A re-import needs this shape: its tree is full of annexed paths whose
 * content lives only in S3, and their keys still have to reach the manifest.
 */
export async function listAnnexedKeys(datasetPath: string): Promise<Map<string, string>> {
  const { stdout, exitCode, stderr } = await runCommand(
    ["git", "annex", "find", "--include", "*", "--format=${key}\\t${file}\\n"],
    { cwd: datasetPath },
  );
  if (exitCode !== 0) {
    throw new Error(`git annex find failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  const keys = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    keys.set(line.slice(tab + 1), line.slice(0, tab));
  }
  return keys;
}

/**
 * Copy the annexed content of specific paths to a remote.
 *
 * The path-scoped sibling of {@link copyToAnnexRemote}, which copies the whole
 * tree. The import path needs the scoped form (#1159): its clone holds content
 * for the handful of files it just annexed and nothing else, and `copy --to .`
 * would walk every upstream pointer in the dataset to find that out (it skips
 * content-absent files in silence, so the cost is the walk, not the noise).
 *
 * `filesCopied` counts the successful `--json` copy records, which means "the
 * remote has it", not "it was transferred now" -- an already-present key
 * reports success too; `filesSent` counts the ones git-annex actually moved. Both
 * are numbers for the operator, NOT evidence the content arrived: a path git-annex
 * does not consider annexed is skipped silently with exit 0 and simply never
 * appears. A caller that needs proof should ask the location log afterwards
 * (`listAnnexedPaths(path, remote)`). The paths go in argv-safe chunks, each run
 * with `-J jobs`.
 */
export async function copyPathsToAnnexRemote(
  datasetPath: string,
  remoteName: string,
  paths: string[],
  jobs = 4,
  credentials?: S3Credentials,
): Promise<CopyOutcome> {
  if (paths.length === 0) {
    return { success: true, filesCopied: 0, filesSent: 0, sentPaths: [], output: "understood" };
  }

  const env = awsCredentialEnv(credentials);
  let filesCopied = 0;
  let filesSent = 0;
  const sentPaths = new Set<string>();
  let output: OutputState = "understood";
  // The worst state of any chunk: unrecognized beats partial beats understood.
  const worse = (a: OutputState, b: OutputState): OutputState =>
    a === "unrecognized" || b === "unrecognized"
      ? "unrecognized"
      : a === "partial" || b === "partial"
        ? "partial"
        : "understood";
  try {
    for (const chunk of chunkAddTargets(paths)) {
      const run = await runJsonCopy(datasetPath, remoteName, jobs, chunk, env, chunk.length);
      filesCopied += run.filesCopied;
      filesSent += run.filesSent;
      for (const path of run.sentPaths) sentPaths.add(path);
      output = worse(output, run.output);
      if (!run.success) {
        return {
          success: false,
          error: run.error,
          filesCopied,
          filesSent,
          sentPaths: [...sentPaths],
          output,
        };
      }
    }
    return { success: true, filesCopied, filesSent, sentPaths: [...sentPaths], output };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: msg || "Unknown error during copy",
      filesCopied,
      filesSent,
      sentPaths: [...sentPaths],
      output,
    };
  }
}
