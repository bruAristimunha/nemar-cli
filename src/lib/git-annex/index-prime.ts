/**
 * git-annex service: record index stat data for large annexed files without streaming
 * their content through `git-annex filter-process`. See ADR 0100 and
 * {@link primeIndexStat}.
 */

import { spawnSync } from "node:child_process";
import { displayName, isPrintableInCommand } from "../display-name.js";
import { INTERRUPT_SIGNALS, sleepSync, stopChildren, writeStderrSync } from "./clone-push.js";
import { chunkAddTargets } from "./init.js";
import { runCommand } from "./run-command.js";

/** The long-running filter git pipes every file's whole content into. */
export const FILTER_PROCESS_KEY = "filter.annex.process";

/**
 * git-annex's own record of a filter process it took out of the configuration for a
 * restage. git-annex writes it before it unsets {@link FILTER_PROCESS_KEY}, and its next
 * restage puts the value back from it, so using the same key means either program
 * recovers what the other left behind.
 */
export const FILTER_PROCESS_MARKER = "filter.annex.process-temp-disabled";

/**
 * Recorded size at or above which a tracked file's index stat data is recorded through
 * git-annex's per-file clean filter instead of being left for a later git command to
 * re-read through filter-process.
 *
 * The per-file filter costs one git-annex process per file, and that cost does not
 * depend on the file's size: 0.06 to 0.26 s a file on local APFS (6 to 6,000 annexed
 * files in the index), and the issue that motivated this (#1704) reports 3.7 s for one
 * 25 GB file on CephFS. The read it replaces costs the file's size over filter-process
 * throughput: about 1.7 GB/s on local APFS, 75 to 95 MB/s a stream on that CephFS. A
 * 1 GiB file therefore takes about 0.6 s to re-read locally and 11 to 14 s on CephFS,
 * against which the per-file filter is about 2.4 times cheaper locally at worst (a thin
 * margin, but the read there is fast anyway) and 3 times on CephFS. The break-even is about
 * 280 to 350 MB a file on the issue's figures for the call after the add (one read saved)
 * and about half that for the call before it (two reads saved); ADR 0100 tabulates it.
 * The value is a maintainer's decision on that data, not a measured crossover: re-measure
 * on the target host before moving it.
 */
export const PRIME_MIN_FILE_BYTES = 1024 ** 3;

/** How long one synchronous restore may run inside a signal handler. */
const SIGNAL_RESTORE_TIMEOUT_MS = 5_000;

/** How long a signal handler keeps retrying a restore that fails, usually on `config.lock`. */
const SIGNAL_RESTORE_RETRY_MS = 2_500;

/** Pause between those retries. */
const SIGNAL_RESTORE_PAUSE_MS = 100;

/** Paths per `git add --refresh`; small enough that a progress callback means something. */
const REFRESH_CHUNK_PATHS = 100;

/** `git config --unset-all` exits 5 when the key is already absent, which is the goal. */
const CONFIG_KEY_ABSENT = 5;

/** What {@link primeIndexStat} did. */
export type PrimeResult =
  /** `primed` indexed paths were handed to git's refresh (zero when none was in the index). */
  | { status: "primed"; primed: number }
  /**
   * Nothing more was primed, by choice or because a step failed in a way that cannot have
   * changed anything but stat data. The caller says so: git will read the rest the old way.
   * `primed` counts the paths earlier chunks handed to git before it stopped, when any did.
   */
  | { status: "skipped"; reason: string; primed?: number }
  /**
   * The repository's configuration could not be read or put back. The caller must fail its
   * step: this says what is wrong and what to do.
   */
  | { status: "error"; error: string };

/** What {@link restoreSuspendedFilterProcess} found and did. */
export type RestoreResult =
  /** No marker, or a marker next to a filter process that is set, now removed. */
  | { status: "unchanged" }
  /** The filter process was missing and has been put back from the marker. */
  | { status: "restored" }
  /** A marker next to a set filter process that could not be removed; harmless. */
  | { status: "warning"; warning: string }
  /** The configuration could not be read or put back; the caller fails its step. */
  | { status: "error"; error: string };

/**
 * What git falls back to while the filter process is out of the configuration:
 * `per-file` when no filter process was left in any scope (checked), `unchecked` otherwise.
 */
type Fallback = "per-file" | "unchecked";

/**
 * Values of `key` in one scope (`--local`) or in every scope, NUL-separated so any value
 * is safe. Empty values are kept: git reads an empty filter process as no filter at all,
 * which is the one value that must never be overlooked.
 */
async function readConfigValues(
  path: string,
  key: string,
  scope: "local" | "all",
): Promise<{ values: string[] } | { error: string }> {
  const args =
    scope === "local"
      ? ["git", "config", "--local", "--null", "--get-all", key]
      : ["git", "config", "--null", "--get-all", key];
  try {
    const out = await runCommand(args, { cwd: path });
    // Exit 1 is "no such key", which is an answer.
    if (out.exitCode === 1 && out.stderr.trim() === "") return { values: [] };
    if (out.exitCode !== 0) {
      return { error: out.stderr.trim() || `git config exited ${out.exitCode}` };
    }
    // Each value is followed by a NUL, so the last piece is always the empty remainder.
    return { values: out.stdout.split("\0").slice(0, -1) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function gitConfig(path: string, args: string[]): Promise<string | undefined> {
  try {
    const out = await runCommand(["git", "config", "--local", ...args], { cwd: path });
    if (out.exitCode === 0) return undefined;
    if (args[0] === "--unset-all" && out.exitCode === CONFIG_KEY_ABSENT) return undefined;
    return out.stderr.trim() || `git config exited ${out.exitCode}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Why a restore did not leave a filter process and no marker. */
interface RestoreFailure {
  error: string;
  /** An empty filter process is in this repository's configuration: no filter at all. */
  filterOff: boolean;
}

/** The failure text when the repository's own configuration holds an empty filter process. */
const EMPTY_LOCAL_FILTER = `${FILTER_PROCESS_KEY} is empty in this repository's configuration, which turns git-annex's filter off`;

/**
 * Put `value` back as the repository's filter process and drop the marker, then read
 * both back. A non-empty value someone set in the repository while it was out is theirs
 * and is left as it is; only the marker is removed. An empty value is never theirs to
 * keep: git reads it as no filter at all, so the restore refuses, keeps the marker, and the
 * caller fails its step. Returns why it did not succeed, or nothing when the configuration
 * holds a filter process again and no marker.
 */
async function restoreFilterProcess(
  path: string,
  value: string,
): Promise<RestoreFailure | undefined> {
  const fail = (error: string, filterOff = false): RestoreFailure => ({ error, filterOff });
  const before = await readConfigValues(path, FILTER_PROCESS_KEY, "local");
  if ("error" in before) return fail(before.error);
  if (before.values.includes("")) return fail(EMPTY_LOCAL_FILTER, true);
  if (before.values.length === 0) {
    const set = await gitConfig(path, [FILTER_PROCESS_KEY, value]);
    if (set) return fail(set);
  }
  const unset = await gitConfig(path, ["--unset-all", FILTER_PROCESS_MARKER]);
  if (unset) return fail(unset);
  const now = await readConfigValues(path, FILTER_PROCESS_KEY, "local");
  if ("error" in now) return fail(now.error);
  const expected = before.values.length === 0 ? [value] : before.values;
  if (JSON.stringify(now.values) !== JSON.stringify(expected)) {
    return fail(
      `${FILTER_PROCESS_KEY} reads back as ${JSON.stringify(now.values)}, not ${JSON.stringify(expected)}`,
    );
  }
  const marker = await readConfigValues(path, FILTER_PROCESS_MARKER, "local");
  if ("error" in marker) return fail(marker.error);
  if (marker.values.length > 0) return fail(`${FILTER_PROCESS_MARKER} is still set`);
  return undefined;
}

/** One shell word, single-quoted. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The two commands that put the filter process back, for a person to run. */
function manualRestore(path: string, value: string): string {
  if (!isPrintableInCommand(path) || !isPrintableInCommand(value)) {
    return "Run the upload again, which puts it back first.";
  }
  return `Run the upload again, which puts it back first, or by hand: git -C ${shellQuote(path)} config ${FILTER_PROCESS_KEY} ${shellQuote(value)} && git -C ${shellQuote(path)} config --unset-all ${FILTER_PROCESS_MARKER}`;
}

/**
 * The failure text for a filter process that could not be put back. What git does
 * meanwhile depends on what else is configured, so it is only called harmless when no
 * filter process was left in any scope.
 */
function describeRestoreFailure(
  path: string,
  value: string,
  error: string,
  fallback: Fallback,
): string {
  const meanwhile =
    fallback === "per-file"
      ? "Until it is back, git uses git-annex's per-file filters (no other filter process was set when it was taken out), which store files the same way but start one git-annex process per file."
      : "Until it is back, git may not run git-annex's filter at all, so do not run git add or git commit in this repository before it is restored.";
  return `Could not put git-annex's filter process back into ${displayName(path)}'s configuration (${displayName(error)}). ${meanwhile} ${manualRestore(path, value)}`;
}

/**
 * Whether git, with the repository's own value out, falls back to git-annex's per-file
 * filters: no filter process in any scope, and git-annex's clean filter in effect.
 */
async function fallbackNow(path: string): Promise<Fallback> {
  const all = await readConfigValues(path, FILTER_PROCESS_KEY, "all");
  if (!("values" in all) || all.values.length > 0) return "unchecked";
  const clean = await readConfigValues(path, "filter.annex.clean", "all");
  if (!("values" in clean)) return "unchecked";
  const effective = clean.values[clean.values.length - 1];
  return effective !== undefined && isAnnexCleanFilter(effective) ? "per-file" : "unchecked";
}

/**
 * Put back a filter process an interrupted run took out of the configuration.
 *
 * {@link primeIndexStat} records the value under {@link FILTER_PROCESS_MARKER} before it
 * unsets {@link FILTER_PROCESS_KEY}, and so does git-annex's own restage. A SIGKILL or a
 * power loss in between leaves the marker set. When the key is then missing it is set
 * back from the marker; when the key is present (`git annex init` sets it again, for
 * one) it is left alone. The marker is removed either way. Like git-annex's restage, this
 * also puts back a filter process someone removed by hand after the marker was written.
 *
 * A repository without the marker costs one `git config` read. A failure to read or
 * restore fails the caller's step (`error`): the priming only takes the value out after
 * checking that no filter process is left in any scope, so git meanwhile uses git-annex's
 * per-file filters, but that is still a change to the person's configuration that nothing
 * else would undo, and nothing guarantees the other scopes stayed empty. A marker that
 * cannot be removed next to a filter process that is set is only a `warning`: nothing is
 * out of the configuration, and git-annex's next restage removes it too.
 */
export async function restoreSuspendedFilterProcess(path: string): Promise<RestoreResult> {
  const marker = await readConfigValues(path, FILTER_PROCESS_MARKER, "local");
  if ("error" in marker) {
    return {
      status: "error",
      error: `Could not check whether an earlier upload left git-annex's filter process out of the configuration (${displayName(marker.error)}). Run the upload again; if git keeps failing, the repository needs attention.`,
    };
  }
  if (marker.values.length === 0) return { status: "unchanged" };
  const saved = marker.values[marker.values.length - 1];
  const current = await readConfigValues(path, FILTER_PROCESS_KEY, "local");
  if ("error" in current) {
    return {
      status: "error",
      error: describeRestoreFailure(path, saved, current.error, await fallbackNow(path)),
    };
  }
  if (current.values.includes("")) {
    // Not the person's value to keep: git reads it as no filter at all. The marker stays.
    return {
      status: "error",
      error: describeRestoreFailure(path, saved, EMPTY_LOCAL_FILTER, "unchecked"),
    };
  }
  if (current.values.length > 0) {
    const unset = await gitConfig(path, ["--unset-all", FILTER_PROCESS_MARKER]);
    if (unset) return { status: "warning", warning: describeStaleMarker(path, unset) };
    return { status: "unchanged" };
  }
  let failure = await restoreFilterProcess(path, saved);
  if (failure) failure = await restoreFilterProcess(path, saved);
  if (failure) {
    const fallback = failure.filterOff ? "unchecked" : await fallbackNow(path);
    return { status: "error", error: describeRestoreFailure(path, saved, failure.error, fallback) };
  }
  return { status: "restored" };
}

/** The warning for a leftover marker that could not be removed while the filter process is set. */
function describeStaleMarker(path: string, error: string): string {
  const command = isPrintableInCommand(path)
    ? ` Remove it with: git -C ${shellQuote(path)} config --unset-all ${FILTER_PROCESS_MARKER}`
    : "";
  return `Could not remove a leftover ${FILTER_PROCESS_MARKER} setting (${displayName(error)}). git-annex's filter process itself is set, so nothing is out of the configuration; git-annex's next restage removes the setting too.${command}`;
}

/** One synchronous restore, for a signal handler that cannot await; git's complaint on failure. */
function restoreSync(path: string, value: string): string | undefined {
  const run = (args: string[]) =>
    spawnSync("git", ["config", "--local", ...args], {
      cwd: path,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SIGNAL_RESTORE_TIMEOUT_MS,
    });
  // A non-empty value someone set while it was out is theirs. An empty one is not: git
  // reads it as no filter at all, so it is replaced like a missing one.
  const present = run(["--null", "--get-all", FILTER_PROCESS_KEY]);
  if (present.error) return present.error.message;
  const values =
    present.status === 0 ? (present.stdout?.toString() ?? "").split("\0").slice(0, -1) : [];
  if (!values.some((v) => v !== "")) {
    const set = run(["--replace-all", FILTER_PROCESS_KEY, value]);
    if (set.error) return set.error.message;
    if (set.status !== 0) return set.stderr?.toString().trim() || `git config exited ${set.status}`;
  }
  const unset = run(["--unset-all", FILTER_PROCESS_MARKER]);
  if (unset.error) return unset.error.message;
  if (unset.status !== 0 && unset.status !== CONFIG_KEY_ABSENT) {
    return unset.stderr?.toString().trim() || `git config exited ${unset.status}`;
  }
  return undefined;
}

/**
 * Put the filter process back if the process is interrupted while the priming runs, then
 * stop the `git add --refresh` it started. The handler is armed for the whole call; between
 * chunks the value is already back, and setting it again changes nothing. `git config`
 * takes `.git/config.lock`, not the `index.lock` the refresh holds, so the restore does not
 * wait on the refresh; it is retried for {@link SIGNAL_RESTORE_RETRY_MS} in case this
 * process's own `git config` holds `config.lock` at that moment. A signal sent to the CLI
 * alone, unlike a terminal's Ctrl-C, does not reach its children, and a refresh left
 * running would hold `index.lock` for as long as it has files to go (minutes on a slow
 * filesystem), so a re-run's add or save would fail on it; the children are asked to stop,
 * as the save's handler does. The handler then removes itself and re-raises the signal;
 * the process dies the way the signal says only when no other handler for it is
 * registered. SIGKILL cannot be caught: the marker it leaves is restored by the next
 * upload's {@link restoreSuspendedFilterProcess}, or by git-annex's next restage. Returns
 * the function that disarms it. `fallback` says what git does while the value is out.
 */
function armRestoreOnInterrupt(path: string, value: string, fallback: () => Fallback): () => void {
  function disarm(): void {
    for (const signal of INTERRUPT_SIGNALS) process.removeListener(signal, onSignal);
  }
  function onSignal(signal: NodeJS.Signals): void {
    const deadline = Date.now() + SIGNAL_RESTORE_RETRY_MS;
    let failure = restoreSync(path, value);
    while (failure && Date.now() < deadline) {
      sleepSync(SIGNAL_RESTORE_PAUSE_MS);
      failure = restoreSync(path, value);
    }
    stopChildren();
    if (failure) {
      writeStderrSync(`\n${describeRestoreFailure(path, value, failure, fallback())}\n`);
    }
    disarm();
    process.kill(process.pid, signal);
  }
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, onSignal);
  return disarm;
}

/** The subset of `paths` that is in the index; `git add --refresh` refuses a whole list over one that is not. */
async function indexedPaths(
  path: string,
  paths: string[],
): Promise<{ paths: string[] } | { error: string }> {
  const indexed: string[] = [];
  try {
    for (const chunk of chunkAddTargets(paths)) {
      const out = await runCommand(
        ["git", "--literal-pathspecs", "ls-files", "-z", "--", ...chunk],
        { cwd: path },
      );
      if (out.exitCode !== 0) return { error: out.stderr.trim() || "git ls-files failed" };
      indexed.push(...out.stdout.split("\0").filter(Boolean));
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { paths: indexed };
}

/** True when `filter.annex.clean` is git-annex's per-file clean filter. */
function isAnnexCleanFilter(value: string): boolean {
  return /\bgit-annex\b.*\bsmudge\b.*--clean\b/.test(value);
}

/**
 * Take the repository's filter process out for one chunk (the marker is already written),
 * and then require that no filter process is left in any scope and that git-annex's clean
 * filter is still the one in effect. Returns the reason it could not, or nothing when git
 * will use git-annex's per-file filter for this chunk. `onSuspended` runs between the
 * unset and those checks, so a test can act in the window.
 */
async function suspendForChunk(
  path: string,
  saved: string | undefined,
  chunk: number,
  onSuspended: ((chunk: number) => void) | undefined,
): Promise<string | undefined> {
  if (saved !== undefined) {
    const unset = await gitConfig(path, ["--unset-all", FILTER_PROCESS_KEY]);
    if (unset) return `could not unset ${FILTER_PROCESS_KEY}: ${unset}`;
  }
  onSuspended?.(chunk);
  // Whatever the check before missed (an empty value it could not see, a value added
  // since), git must find no filter process at all before anything is refreshed: an
  // empty one left anywhere means no filter, and the refresh would hash raw content.
  const left = await readConfigValues(path, FILTER_PROCESS_KEY, "all");
  if ("error" in left) return `could not check ${FILTER_PROCESS_KEY}: ${left.error}`;
  if (left.values.length > 0) {
    return `a filter process is set once this repository's value is out (${FILTER_PROCESS_KEY} came back, or is set in another scope)`;
  }
  const clean = await readConfigValues(path, "filter.annex.clean", "all");
  if ("error" in clean) return `could not check filter.annex.clean: ${clean.error}`;
  const effective = clean.values[clean.values.length - 1];
  if (effective === undefined || !isAnnexCleanFilter(effective)) {
    return "filter.annex.clean is no longer git-annex's clean filter";
  }
  return undefined;
}

/**
 * Record index stat data for `paths` so git stops treating them as possibly modified,
 * without streaming their content through `git-annex filter-process`.
 *
 * `git annex add` stages an unlocked file through `git update-index --index-info`,
 * which leaves its index entry with zero stat data. Every later git command that
 * compares the worktree with the index (`git status`, `git diff`, `git add -A`, the
 * tracking step's own check of already-indexed paths) then runs the file through the
 * clean filter. With `filter.annex.process` configured that is the long-running filter,
 * and git sends it the whole content over a pipe before git-annex can answer from its
 * inode cache that nothing changed: the tracking check reads a file twice, `git status`
 * once. git-annex's per-file clean filter (`filter.annex.clean`) is given the path and
 * answers from the same inode cache without reading the content; git consumes only a
 * pipe buffer's worth. git uses it only when no filter process is configured, so for
 * each chunk of {@link REFRESH_CHUNK_PATHS} paths the filter process is taken out of the
 * repository's configuration for one `git add --refresh`, exactly as git-annex's own
 * restage does, under the same marker key, and put back before the next chunk.
 *
 * What this cannot do is change what is committed. `git add --refresh` only records
 * stat data for an entry whose content cleans to the blob already staged; it never
 * stages anything. A file that changed since it was tracked cleans to a different
 * pointer and keeps zero stat data, so git still reads it and still sees the change
 * (git-annex stores the new content as an unreferenced object while it cleans, as it does
 * for `git status`). Both filter forms answer from the same inode cache (inode, size,
 * mtime), so they agree on which files are unchanged, including the one case the cache
 * cannot see: an edit in place that puts the size and the exact mtime back is missed by
 * `git status` through filter-process as well. The only difference is the bytes git
 * sends first.
 *
 * Guards, each a way the configuration change could outlive the call or do harm:
 *  - Nothing is primed unless `filter.annex.clean` is git-annex's, and the filter process,
 *    if any, is set once, only in the repository's own configuration, and not empty. One
 *    set anywhere else (an empty one included, which git reads as no filter at all)
 *    cannot be taken out for one command, so those files are left to be read as before
 *    (`skipped`). With no filter process at all, git already uses the per-file filter and
 *    nothing is changed.
 *  - The value is recorded under {@link FILTER_PROCESS_MARKER} before the key is unset,
 *    and after the unset no filter process may be left in any scope, or the chunk is not
 *    refreshed. It is put back after each chunk, retried once and read back, and on
 *    SIGINT, SIGTERM and SIGHUP before the process dies.
 *  - Only paths that are in the index are handed to git, literally.
 *  - A refresh that fails, or a marker that cannot be written, is a degradation
 *    (`skipped`): neither can have changed more than stat data. A configuration that
 *    cannot be read or put back is an `error`.
 *
 * A value someone sets in the repository while the call runs is theirs: a restore leaves
 * it in place, and a chunk that finds the value changed since the first read stops
 * (`skipped`) instead of writing the old value back.
 *
 * `onSuspended` runs in every chunk's window, with the chunk's index, after the unset and
 * before the checks of the other scopes; it exists so a test can act there. `onProgress`
 * reports paths handed to git so far, after each chunk's value is back. `chunkPaths` is the
 * chunk size, {@link REFRESH_CHUNK_PATHS} unless a test needs several chunks.
 */
export async function primeIndexStat(
  path: string,
  paths: string[],
  options: {
    onSuspended?: (chunk: number) => void;
    onProgress?: (done: number, total: number) => void;
    chunkPaths?: number;
  } = {},
): Promise<PrimeResult> {
  if (paths.length === 0) return { status: "primed", primed: 0 };

  const listed = await indexedPaths(path, paths);
  if ("error" in listed) {
    return { status: "skipped", reason: `could not read the index: ${listed.error}` };
  }
  if (listed.paths.length === 0) return { status: "primed", primed: 0 };

  const clean = await readConfigValues(path, "filter.annex.clean", "all");
  if ("error" in clean) return { status: "error", error: describeConfigReadFailure(clean.error) };
  const cleanValue = clean.values[clean.values.length - 1];
  if (cleanValue === undefined || !isAnnexCleanFilter(cleanValue)) {
    return { status: "skipped", reason: "filter.annex.clean is not git-annex's clean filter" };
  }
  const local = await readConfigValues(path, FILTER_PROCESS_KEY, "local");
  if ("error" in local) return { status: "error", error: describeConfigReadFailure(local.error) };
  const all = await readConfigValues(path, FILTER_PROCESS_KEY, "all");
  if ("error" in all) return { status: "error", error: describeConfigReadFailure(all.error) };
  if (
    local.values.length > 1 ||
    all.values.length > local.values.length ||
    all.values.some((value) => value === "")
  ) {
    return {
      status: "skipped",
      reason: `${FILTER_PROCESS_KEY} is set outside this repository's configuration, more than once, or empty`,
    };
  }
  const saved = local.values[0];

  let fallback: Fallback = "unchecked";
  const disarm =
    saved === undefined ? () => {} : armRestoreOnInterrupt(path, saved, () => fallback);
  let primed = 0;
  const partial = () => (primed > 0 ? { primed } : {});
  try {
    const chunks = chunkAddTargets(listed.paths, options.chunkPaths ?? REFRESH_CHUNK_PATHS);
    for (const [index, chunk] of chunks.entries()) {
      if (saved !== undefined) {
        if (index > 0) {
          // The value is back between chunks, and someone may have changed it since the
          // first read; writing `saved` back after the next chunk would undo that.
          const now = await readConfigValues(path, FILTER_PROCESS_KEY, "local");
          if ("error" in now) {
            return { status: "error", error: describeConfigReadFailure(now.error) };
          }
          if (now.values.length !== 1 || now.values[0] !== saved) {
            return {
              status: "skipped",
              reason: `${FILTER_PROCESS_KEY} changed while the priming ran`,
              ...partial(),
            };
          }
        }
        const marked = await gitConfig(path, [FILTER_PROCESS_MARKER, saved]);
        if (marked) {
          // Nothing was unset, so nothing is out of the configuration; a marker git may
          // have left beside the set value is harmless and git-annex removes it too.
          const undo = await gitConfig(path, ["--unset-all", FILTER_PROCESS_MARKER]);
          const stale = undo ? ` ${describeStaleMarker(path, undo)}` : "";
          return {
            status: "skipped",
            reason: `could not record ${FILTER_PROCESS_MARKER}: ${marked}.${stale}`,
            ...partial(),
          };
        }
      }
      fallback = "unchecked";
      let suspendFailure: string | undefined;
      let refreshFailure: string | undefined;
      let restoreFailure: RestoreFailure | undefined;
      try {
        suspendFailure = await suspendForChunk(path, saved, index, options.onSuspended);
        if (!suspendFailure) {
          fallback = "per-file";
          const out = await runCommand(
            ["git", "--literal-pathspecs", "add", "--refresh", "--", ...chunk],
            { cwd: path },
          );
          if (out.exitCode !== 0) {
            refreshFailure = out.stderr.trim() || `git add --refresh exited ${out.exitCode}`;
          }
        }
      } finally {
        if (saved !== undefined) {
          restoreFailure = await restoreFilterProcess(path, saved);
          if (restoreFailure) restoreFailure = await restoreFilterProcess(path, saved);
        }
      }
      if (restoreFailure && saved !== undefined) {
        return {
          status: "error",
          error: describeRestoreFailure(
            path,
            saved,
            restoreFailure.error,
            restoreFailure.filterOff ? "unchecked" : fallback,
          ),
        };
      }
      if (suspendFailure) return { status: "skipped", reason: suspendFailure, ...partial() };
      if (refreshFailure) {
        return {
          status: "skipped",
          reason: `git add --refresh failed: ${refreshFailure}`,
          ...partial(),
        };
      }
      primed += chunk.length;
      options.onProgress?.(primed, listed.paths.length);
    }
  } finally {
    // Disarmed only after the last restore: a signal that lands while it runs must still
    // find a handler, or the filter process stays out of the configuration.
    disarm();
  }
  return { status: "primed", primed };
}

function describeConfigReadFailure(error: string): string {
  return `Could not read the repository's git-annex filter configuration (${displayName(error)}). Run the upload again; if git keeps failing, the repository needs attention.`;
}
