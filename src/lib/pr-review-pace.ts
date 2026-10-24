/**
 * Pace a bulk start of dataset pull request reviews (ADR 0093, amendments of 2026-10-24).
 *
 * Every review reserves its output budget against the workspace's output-tokens-per-minute limit
 * the moment its request begins (ADR 0107, Consequences), so starting a hundred at once asks for a
 * hundred budgets at once. `runPaced` keeps at most `concurrency` of the reviews THIS run started
 * in progress: it starts the next one as each leaves `in_progress`. That is a sliding window, not
 * fixed batches: a batch would wait for its slowest review (one that truncates runs half an hour)
 * while the other slots sat idle.
 *
 * The scheduling is separate from the command so it can be tested on its own: the command passes
 * the real start and the real queue read, and the tests pass functions that simulate a pool of jobs.
 * Only reviews this run started count. Reviews that other people's pushes started are running too,
 * but counting them would let a busy hour stall the run for something it did not cause.
 *
 * Leaving the in-progress list is not proof that a review finished: a pull request that was closed
 * or merged, or that GitHub's search leaves out for a moment, drops out of it while its job may
 * still be running. So a review that left the list is confirmed finished by `confirmFinished`
 * before its slot is freed, and only an answer of true frees it. No slot is held for ever: a job
 * cannot run longer than its limit, so `maxHoldMs` frees one regardless.
 */

/** The shape of a queue entry or a start target: a pull request of a dataset. */
export interface PaceEntry {
  dataset_id: string;
  pr_number: number;
}

/** The key a pull request has in the set of reviews in progress. */
export function paceKey(e: PaceEntry): string {
  return `${e.dataset_id}#${e.pr_number}`;
}

export interface PaceDeps<E extends PaceEntry, R> {
  /** Start one review. Throws when the start itself failed. */
  start(entry: E): Promise<R>;
  /** Whether the answer put a review in progress. A start that was declined takes no slot. */
  isRunning(answer: R): boolean;
  /**
   * A start threw: true when the review might nevertheless be running (the request may have reached
   * the Worker before the connection failed), so it takes a slot until the queue shows otherwise.
   * Absent means a failed start never takes one.
   */
  maybeRunning?(error: unknown): boolean;
  /** The reviews in progress now, or null when that cannot be told (an incomplete list, an error). */
  inProgress(): Promise<ReadonlySet<string> | null>;
  /**
   * A started review is no longer in that list: true only when it can be confirmed finished.
   * False, or a throw, keeps the slot. Absent means leaving the list is taken as finished.
   */
  confirmFinished?(entry: E): Promise<boolean>;
  /** Wait `ms`, or until the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** The clock, in milliseconds (the tests give it a virtual one). */
  now?(): number;
  /** Called with each outcome as it happens, so the command can print it. */
  onResult(entry: E, outcome: { answer: R } | { error: unknown }): void;
  /** Called before each wait for a slot, with the numbers to show. */
  onWait?(info: { running: number; remaining: number }): void;
  /** Called when a read of the queue could not tell. */
  onUnknown?(info: { count: number; max: number }): void;
  /** After an answer: true ends the run there (the older-Worker check of `--redo`). */
  stopAfter?(answer: R): boolean;
}

export interface PaceOptions {
  /** At most this many reviews started by this run in progress at once. `Infinity` never waits. */
  concurrency: number;
  /** Milliseconds between two reads of the queue while waiting for a slot. */
  pollMs: number;
  /** How many reads in a row may fail to tell before the run stops. */
  maxUnknownPolls: number;
  /** A slot held this long is freed whatever the queue says (a job cannot outlive its limit). */
  maxHoldMs: number;
  /** Aborted by Ctrl-C: the run stops after the start in flight. */
  signal: AbortSignal;
}

export type PaceStop = "interrupted" | "unknown_polls" | "answer";

export interface PaceOutcome<E extends PaceEntry, R> {
  results: Array<{ entry: E; answer: R } | { entry: E; error: unknown }>;
  /** Entries the run never tried, in order. */
  notStarted: E[];
  /** Why the run ended before the list was done; null when it was done. */
  stoppedBy: PaceStop | null;
}

/** The result of waiting for a promise that Ctrl-C can cut short. */
type Raced<T> = { aborted: true } | { aborted: false; value: T };

/** Wait for `p`, or return at once when the signal aborts (the request itself is left to finish). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<Raced<T>> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Start `todo` in order, never more than `options.concurrency` in progress from this run.
 *
 * A read of the queue that cannot tell (null, or a throw) is not "finished": the review might still
 * be running, so the window stays full. After `maxUnknownPolls` of them in a row the run stops,
 * because it cannot keep its limit blind. A review that never reports leaves `in_progress` when the
 * Worker calls it overdue and is confirmed finished then, so no wait is unbounded.
 */
export async function runPaced<E extends PaceEntry, R>(
  todo: readonly E[],
  deps: PaceDeps<E, R>,
  options: PaceOptions,
): Promise<PaceOutcome<E, R>> {
  const results: PaceOutcome<E, R>["results"] = [];
  const now = deps.now ?? Date.now;
  const mine = new Map<string, { entry: E; since: number }>();
  let next = 0;
  let unknown = 0;
  let stoppedBy: PaceStop | null = null;

  while (next < todo.length) {
    if (options.signal.aborted) {
      stoppedBy = "interrupted";
      break;
    }
    if (mine.size >= options.concurrency) {
      deps.onWait?.({ running: mine.size, remaining: todo.length - next });
      // A review started a moment ago is certainly still in progress, so wait before asking.
      await deps.sleep(options.pollMs, options.signal);
      if (options.signal.aborted) continue;
      for (const [key, held] of [...mine]) {
        if (now() - held.since >= options.maxHoldMs) mine.delete(key);
      }
      if (mine.size < options.concurrency) continue;
      const polled = await raceAbort(
        deps.inProgress().catch(() => null),
        options.signal,
      );
      // A Ctrl-C during the read ends the run as interrupted, not as an unreadable queue.
      if (polled.aborted) continue;
      const running = polled.value;
      if (running === null) {
        unknown++;
        deps.onUnknown?.({ count: unknown, max: options.maxUnknownPolls });
        if (unknown >= options.maxUnknownPolls) {
          stoppedBy = "unknown_polls";
          break;
        }
        continue;
      }
      unknown = 0;
      for (const [key, held] of [...mine]) {
        if (running.has(key)) continue;
        if (!deps.confirmFinished) {
          mine.delete(key);
          continue;
        }
        const confirmed = await raceAbort(
          deps.confirmFinished(held.entry).catch(() => false),
          options.signal,
        );
        if (confirmed.aborted) break;
        if (confirmed.value) mine.delete(key);
      }
      continue;
    }
    const entry = todo[next++] as E;
    let outcome: { answer: R } | { error: unknown };
    try {
      outcome = { answer: await deps.start(entry) };
    } catch (error) {
      outcome = { error };
    }
    results.push({ entry, ...outcome });
    deps.onResult(entry, outcome);
    if ("answer" in outcome) {
      if (deps.isRunning(outcome.answer)) mine.set(paceKey(entry), { entry, since: now() });
      if (deps.stopAfter?.(outcome.answer)) {
        stoppedBy = "answer";
        break;
      }
    } else if (deps.maybeRunning?.(outcome.error)) {
      mine.set(paceKey(entry), { entry, since: now() });
    }
  }
  return { results, notStarted: todo.slice(next), stoppedBy };
}

/** A sleep that ends at once when the signal aborts. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The value of `--concurrency`: a whole number of at least 1, written as digits. Null for anything
 * else (zero, a sign, a fraction, an exponent, a word), so the command refuses it before the API is
 * asked.
 */
export function parseConcurrency(raw: string): number | null {
  if (!/^[1-9][0-9]{0,5}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}
