/**
 * Measures what a manifest scan holds, in a process of its own (#1502).
 *
 * WHY A PROCESS. A scan's memory is a few hundred kilobytes; the unit-pure job runs 12,000
 * tests in one process, whose heap is whatever the files before this one left behind
 * (finalizers still pending, caches, servers and timers other tests started, allocator
 * fragmentation). Sampling the heap inside that process measures all of it, so the 8 MB bound
 * and the "growth under a tenth of the manifest" rule were comparing a signal in the hundreds
 * of kilobytes with noise that CI showed reaching 6 MB (run 38681347083: 6,330,254 against
 * a limit of 6,312,302). A fresh process holds this module, the scanner and the generator and
 * nothing else, so the same measurement repeats to within about 100 KB on macOS and Linux.
 *
 * The check keeps its teeth: a scan that held the document would hold tens of megabytes at
 * these samples, which is two orders of magnitude over the noise that is left.
 *
 * `measureScan` is what a test calls. Run as a script this file is the child it spawns:
 * it reads one request from argv, scans the generated manifest while sampling live memory
 * every `every` keys, and prints one JSON line.
 */

import { heapStats } from "bun:jsc";
import {
  DigestQuery,
  EntriesQuery,
  EntryCountQuery,
  type ManifestQuery,
  ResolvePathQuery,
} from "../../src/services/manifest-queries";
import { scanManifestStream } from "../../src/services/manifest-scan";
import { type LargeManifestOptions, largeManifestStream } from "./large-manifest";

export type ProbeQuery =
  | { kind: "resolve"; path: string }
  | { kind: "digest" }
  | { kind: "count" }
  | { kind: "entries"; limit: number };

export interface ProbeRequest {
  manifest: LargeManifestOptions;
  query: ProbeQuery;
  /** Sample live memory once per this many keys. */
  every: number;
}

export interface ProbeResult {
  /** `query.finish`'s answer, as JSON. */
  answer: unknown;
  /** Live bytes at each sample, minus the live bytes before the scan began. */
  samples: number[];
}

/** JS-visible live memory: the JSC heap plus the out-of-heap string storage. */
function liveBytes(): number {
  Bun.gc(true);
  const h = heapStats();
  return h.heapSize + h.extraMemorySize;
}

function buildQuery(query: ProbeQuery): ManifestQuery<unknown> {
  switch (query.kind) {
    case "resolve":
      return new ResolvePathQuery(query.path);
    case "digest":
      return new DigestQuery();
    case "count":
      return new EntryCountQuery();
    case "entries":
      return new EntriesQuery(query.limit);
  }
}

async function runProbe(request: ProbeRequest): Promise<ProbeResult> {
  const inner = buildQuery(request.query);
  const baseline = liveBytes();
  const samples: number[] = [];
  let seen = 0;
  // The scan's peak is what matters: a whole-parse path's memory is gone again by the time
  // it returns, so the samples are taken DURING the scan.
  const sampling: ManifestQuery<unknown> = {
    reset: () => inner.reset(),
    key(path) {
      if (++seen % request.every === 0) samples.push(liveBytes() - baseline);
      return inner.key(path);
    },
    value: (path, value) => inner.value(path, value),
    finish: (header) => inner.finish(header),
  };
  const result = await scanManifestStream(largeManifestStream(request.manifest), sampling);
  if (result.kind !== "ok") throw new Error(`scan verdict ${result.kind}`);
  return { answer: sampling.finish(result.header), samples };
}

/** Longest a child may run before it is killed; a scan takes a few seconds. */
const PROBE_DEADLINE_MS = 60_000;

/**
 * Run `request` in a fresh bun process and return what it measured. The child is killed
 * when this returns or throws, and after {@link PROBE_DEADLINE_MS}, so a test that times out
 * does not leave a scan running in the background.
 */
export async function measureScan(request: ProbeRequest): Promise<ProbeResult> {
  const child = Bun.spawn([process.execPath, import.meta.path, JSON.stringify(request)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), PROBE_DEADLINE_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`memory probe exited ${exitCode} (signal ${child.signalCode}): ${stderr}`);
    }
    const line = stdout.trim().split("\n").pop() ?? "";
    return JSON.parse(line) as ProbeResult;
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}

if (import.meta.main) {
  const request = JSON.parse(process.argv[2] ?? "null") as ProbeRequest;
  console.log(JSON.stringify(await runProbe(request)));
}
