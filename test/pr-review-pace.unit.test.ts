/**
 * The scheduler behind `nemar admin pr-reviews start --all --concurrency <n>` (ADR 0093).
 *
 * `runPaced` takes its start, its read of the queue and its sleep as arguments, so these tests give
 * it a small simulated pool of jobs on a virtual clock: a job finishes when the clock reaches its
 * finish time, and `sleep` is what moves the clock. The invariant is checked at every start.
 */

import { describe, expect, test } from "bun:test";
import {
  type PaceDeps,
  type PaceEntry,
  paceKey,
  parseConcurrency,
  runPaced,
  sleepUnlessAborted,
} from "../src/lib/pr-review-pace";

interface Answer {
  dispatched: boolean;
}

const entry = (n: number): PaceEntry => ({ dataset_id: "nm000201", pr_number: n });

/** A scheduler that waits without end fails the test instead of hanging it. */
function runaway(sleeps: number): void {
  if (sleeps > 500) throw new Error("runaway: the scheduler kept waiting and never finished");
}

/** A pool of jobs on a virtual clock. `durations[n]` is how long pull request n runs. */
function pool(
  durations: Record<number, number>,
  over: {
    declined?: number[];
    failing?: number[];
    pollAnswers?: Array<"unknown" | "throw" | "ok">;
    /** Pull requests whose start throws but whose review the Worker did begin. */
    failingButRunning?: number[];
    /** Whether a review that left the list is confirmed finished (default: when it is really done). */
    confirm?: (e: PaceEntry) => Promise<boolean>;
  } = {},
) {
  let now = 0;
  const finishAt = new Map<string, number>();
  const log = {
    starts: [] as Array<{ pr: number; at: number; runningAfter: number }>,
    sleeps: 0,
    polls: 0,
    waits: [] as Array<{ running: number; remaining: number }>,
    unknowns: [] as Array<{ count: number; max: number }>,
  };
  const running = () => new Set([...finishAt].filter(([, end]) => end > now).map(([key]) => key));
  const pollAnswers = [...(over.pollAnswers ?? [])];
  const deps: PaceDeps<PaceEntry, Answer> = {
    async start(e) {
      if (over.failingButRunning?.includes(e.pr_number)) {
        finishAt.set(paceKey(e), now + (durations[e.pr_number] ?? 10));
        throw new Error("connection lost after the request was sent");
      }
      if (over.failing?.includes(e.pr_number)) throw new Error("start failed");
      if (over.declined?.includes(e.pr_number)) {
        log.starts.push({ pr: e.pr_number, at: now, runningAfter: running().size });
        return { dispatched: false };
      }
      finishAt.set(paceKey(e), now + (durations[e.pr_number] ?? 10));
      log.starts.push({ pr: e.pr_number, at: now, runningAfter: running().size });
      return { dispatched: true };
    },
    isRunning: (a) => a.dispatched,
    async inProgress() {
      runaway(++log.polls);
      const mode = pollAnswers.shift() ?? "ok";
      if (mode === "throw") throw new Error("queue unreadable");
      if (mode === "unknown") return null;
      return running();
    },
    async sleep(ms) {
      runaway(++log.sleeps);
      now += ms;
    },
    onResult() {},
    onWait: (info) => log.waits.push(info),
    now: () => now,
    ...(over.confirm ? { confirmFinished: over.confirm } : {}),
    ...(over.failingButRunning ? { maybeRunning: () => true } : {}),
    onUnknown: (info) => log.unknowns.push(info),
  };
  return { deps, log, now: () => now };
}

const options = (concurrency: number, signal = new AbortController().signal) => ({
  concurrency,
  pollMs: 10,
  maxUnknownPolls: 3,
  maxHoldMs: 100 * 60_000,
  signal,
});

describe("runPaced", () => {
  test("never has more than the limit in progress at any start, and starts every entry in order", async () => {
    const { deps, log } = pool({ 1: 35, 2: 5, 3: 50, 4: 5, 5: 5, 6: 40, 7: 5, 8: 5, 9: 25, 10: 5 });
    const todo = Array.from({ length: 10 }, (_, i) => entry(i + 1));

    const out = await runPaced(todo, deps, options(3));

    expect(out.stoppedBy).toBeNull();
    expect(out.notStarted).toEqual([]);
    expect(log.starts.map((s) => s.pr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const s of log.starts) expect(s.runningAfter).toBeLessThanOrEqual(3);
    // The limit is used, not just respected: it was full at some start.
    expect(Math.max(...log.starts.map((s) => s.runningAfter))).toBe(3);
  });

  test("is a sliding window: a short review frees its slot while a long one still runs", async () => {
    const { deps, log } = pool({ 1: 1000, 2: 5, 3: 5, 4: 5 });

    await runPaced([entry(1), entry(2), entry(3), entry(4)], deps, options(2));

    const at = (pr: number) => log.starts.find((s) => s.pr === pr)?.at ?? -1;
    // The third and the fourth start long before the first review (1,000) could have finished.
    expect(at(3)).toBeLessThan(1000);
    expect(at(4)).toBeLessThan(1000);
  });

  test("a declined start takes no slot, so it never waits", async () => {
    const { deps, log } = pool({}, { declined: [2, 3] });

    const out = await runPaced([entry(1), entry(2), entry(3), entry(4)], deps, options(1));

    expect(out.results).toHaveLength(4);
    // Entry 1 fills the only slot, so 2 waits once for it; 3 and 4 follow 2 and 3 without a wait
    // between 2 and 3 (declined), then 4 waits for 1 to be gone.
    expect(log.starts.map((s) => s.pr)).toEqual([1, 2, 3, 4]);
    expect(log.starts.find((s) => s.pr === 3)?.at).toBe(log.starts.find((s) => s.pr === 2)?.at);
  });

  test("a start that throws is recorded, takes no slot and does not end the run", async () => {
    const { deps, log } = pool({}, { failing: [2] });

    const out = await runPaced([entry(1), entry(2), entry(3)], deps, options(1));

    expect(out.stoppedBy).toBeNull();
    expect(out.results.map((r) => ("error" in r ? "error" : "answer"))).toEqual([
      "answer",
      "error",
      "answer",
    ]);
    expect(log.starts.map((s) => s.pr)).toEqual([1, 3]);
  });

  test("a limit at or above the list size never waits and never reads the queue", async () => {
    for (const concurrency of [4, 100, Number.POSITIVE_INFINITY]) {
      const { deps, log } = pool({});
      await runPaced([entry(1), entry(2), entry(3), entry(4)], deps, options(concurrency));
      expect(log.sleeps).toBe(0);
      expect(log.polls).toBe(0);
    }
  });

  test("an unreadable queue is not 'finished': the window stays full, and three in a row stop the run", async () => {
    const { deps, log } = pool({ 1: 10_000 }, { pollAnswers: ["unknown", "throw", "unknown"] });

    const out = await runPaced([entry(1), entry(2), entry(3)], deps, options(1));

    expect(out.stoppedBy).toBe("unknown_polls");
    expect(log.starts.map((s) => s.pr)).toEqual([1]);
    expect(out.notStarted.map((e) => e.pr_number)).toEqual([2, 3]);
    expect(log.polls).toBe(3);
  });

  test("a readable queue between two unreadable ones resets the count", async () => {
    // The review runs 65, so the reads at 10 and 20 cannot tell, 30 can, 40 and 50 cannot, and 60
    // and 70 can: never three in a row, so the run must finish.
    const { deps } = pool(
      { 1: 65 },
      { pollAnswers: ["unknown", "unknown", "ok", "unknown", "unknown"] },
    );

    const out = await runPaced([entry(1), entry(2)], deps, options(1));

    expect(out.stoppedBy).toBeNull();
    expect(out.notStarted).toEqual([]);
  });

  test("Ctrl-C during a wait ends it at once and reports what was never tried", async () => {
    const abort = new AbortController();
    const { deps, log } = pool({ 1: 10_000 });
    deps.sleep = async () => {
      runaway(++log.sleeps);
      abort.abort();
    };

    const out = await runPaced([entry(1), entry(2), entry(3)], deps, options(1, abort.signal));

    expect(out.stoppedBy).toBe("interrupted");
    expect(out.notStarted.map((e) => e.pr_number)).toEqual([2, 3]);
    expect(log.polls).toBe(0);
  });

  test("Ctrl-C during a start lets that start finish, then stops", async () => {
    const abort = new AbortController();
    const { deps, log } = pool({});
    const inner = deps.start;
    deps.start = async (e) => {
      const answer = await inner(e);
      if (e.pr_number === 2) abort.abort();
      return answer;
    };

    const out = await runPaced(
      [entry(1), entry(2), entry(3), entry(4)],
      deps,
      options(10, abort.signal),
    );

    expect(out.stoppedBy).toBe("interrupted");
    expect(log.starts.map((s) => s.pr)).toEqual([1, 2]);
    expect(out.notStarted.map((e) => e.pr_number)).toEqual([3, 4]);
  });

  test("stopAfter ends the run after an answer and keeps it", async () => {
    const { deps } = pool({});
    deps.stopAfter = (a) => a.dispatched;

    const out = await runPaced([entry(1), entry(2)], deps, options(10));

    expect(out.stoppedBy).toBe("answer");
    expect(out.results).toHaveLength(1);
    expect(out.notStarted.map((e) => e.pr_number)).toEqual([2]);
  });

  test("onWait reports the running count and what remains", async () => {
    const { deps, log } = pool({ 1: 30, 2: 30 });

    await runPaced([entry(1), entry(2), entry(3)], deps, options(2));

    expect(log.waits[0]).toEqual({ running: 2, remaining: 1 });
  });
});

describe("runPaced: leaving the list is not proof of finishing", () => {
  test("a review that left the list but is not confirmed finished keeps its slot", async () => {
    // The queue stops showing it (a closed pull request, a lagging search) while the job still runs.
    let clock = () => 0;
    let confirms = 0;
    const p = pool(
      { 1: 10, 2: 5 },
      {
        confirm: async () => {
          confirms++;
          return clock() >= 80;
        },
      },
    );
    clock = p.now;

    await runPaced([entry(1), entry(2)], p.deps, options(1));

    expect(confirms).toBeGreaterThan(1);
    expect(p.log.starts.find((s) => s.pr === 2)?.at).toBeGreaterThanOrEqual(80);
  });

  test("a confirmation that throws keeps the slot as well", async () => {
    let clock = () => 0;
    const p = pool(
      { 1: 10, 2: 5 },
      {
        confirm: async () => {
          if (clock() < 50) throw new Error("detail unreadable");
          return true;
        },
      },
    );
    clock = p.now;

    await runPaced([entry(1), entry(2)], p.deps, options(1));

    expect(p.log.starts.find((s) => s.pr === 2)?.at).toBeGreaterThanOrEqual(50);
  });

  test("a review still in the list is not asked about", async () => {
    let clock = () => 0;
    const askedAt: number[] = [];
    const p = pool(
      { 1: 100, 2: 5 },
      {
        confirm: async () => {
          askedAt.push(clock());
          return true;
        },
      },
    );
    clock = p.now;

    await runPaced([entry(1), entry(2)], p.deps, options(1));

    expect(askedAt.length).toBeGreaterThan(0);
    for (const at of askedAt) expect(at).toBeGreaterThanOrEqual(100);
  });

  test("a slot is freed after the hold limit even when it is never confirmed", async () => {
    const p = pool({ 1: 10, 2: 5 }, { confirm: async () => false });

    await runPaced([entry(1), entry(2)], p.deps, { ...options(1), maxHoldMs: 50 });

    const at = p.log.starts.find((s) => s.pr === 2)?.at ?? -1;
    expect(at).toBeGreaterThanOrEqual(50);
    expect(at).toBeLessThan(100);
  });
});

describe("runPaced: a start that throws", () => {
  test("after the request may have reached the Worker it takes a slot until the queue shows it done", async () => {
    const p = pool({ 1: 30, 2: 5 }, { failingButRunning: [1] });

    const out = await runPaced([entry(1), entry(2)], p.deps, options(1));

    expect(out.results.map((r) => ("error" in r ? "error" : "answer"))).toEqual([
      "error",
      "answer",
    ]);
    expect(p.log.starts[0]?.pr).toBe(2);
    expect(p.log.starts[0]?.at).toBeGreaterThanOrEqual(30);
  });

  test("when it surely did not, the next one starts at once", async () => {
    const p = pool({ 2: 5 }, { failing: [1] });

    await runPaced([entry(1), entry(2)], p.deps, options(1));

    expect(p.log.starts[0]).toMatchObject({ pr: 2, at: 0 });
  });
});

describe("runPaced: Ctrl-C and unreadable reads", () => {
  test("Ctrl-C during a read that never answers ends the run at once", async () => {
    const abort = new AbortController();
    const p = pool({ 1: 10_000 });
    p.deps.inProgress = () => new Promise(() => {});
    setTimeout(() => abort.abort(), 20);
    const t0 = performance.now();

    const out = await runPaced([entry(1), entry(2), entry(3)], p.deps, options(1, abort.signal));

    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(out.stoppedBy).toBe("interrupted");
    expect(out.notStarted.map((e) => e.pr_number)).toEqual([2, 3]);
  });

  test("Ctrl-C during a confirmation that never answers ends the run at once", async () => {
    const abort = new AbortController();
    const p = pool({ 1: 10 }, { confirm: () => new Promise(() => {}) });
    setTimeout(() => abort.abort(), 20);

    const out = await runPaced([entry(1), entry(2)], p.deps, options(1, abort.signal));

    expect(out.stoppedBy).toBe("interrupted");
    expect(out.notStarted.map((e) => e.pr_number)).toEqual([2]);
  });

  test("Ctrl-C during the read that would have been the last unreadable one ends as interrupted", async () => {
    const abort = new AbortController();
    const p = pool({ 1: 10_000 }, { pollAnswers: ["unknown", "unknown"] });
    const inner = p.deps.inProgress;
    let reads = 0;
    p.deps.inProgress = async () => {
      reads++;
      if (reads === 3) {
        abort.abort();
        return null;
      }
      return await inner();
    };

    const out = await runPaced([entry(1), entry(2)], p.deps, options(1, abort.signal));

    expect(out.stoppedBy).toBe("interrupted");
  });

  test("each unreadable read is reported with its count and the maximum", async () => {
    const p = pool({ 1: 10_000 }, { pollAnswers: ["unknown", "throw", "unknown"] });

    await runPaced([entry(1), entry(2)], p.deps, options(1));

    expect(p.log.unknowns).toEqual([
      { count: 1, max: 3 },
      { count: 2, max: 3 },
      { count: 3, max: 3 },
    ]);
  });
});

describe("parseConcurrency", () => {
  test.each([
    ["1", 1],
    ["4", 4],
    [" 12 ", 12],
    ["100000", 100000],
  ])("%p is %p", (raw, expected) => {
    expect(parseConcurrency(raw)).toBe(expected);
  });

  test.each(["0", "-1", "+2", "1.5", "1e3", "abc", "", " ", "07", "1000000", "0x10", "2 3"])(
    "%p is refused",
    (raw) => {
      expect(parseConcurrency(raw)).toBeNull();
    },
  );
});

describe("sleepUnlessAborted", () => {
  test("waits the time it is given", async () => {
    const t0 = performance.now();
    await sleepUnlessAborted(30, new AbortController().signal);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(25);
  });

  test("ends at once when the signal aborts, even a long wait", async () => {
    const abort = new AbortController();
    const t0 = performance.now();
    setTimeout(() => abort.abort(), 10);
    await sleepUnlessAborted(60_000, abort.signal);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  test("does not wait at all when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const t0 = performance.now();
    await sleepUnlessAborted(60_000, abort.signal);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
