/**
 * Library behind `scripts/identifier-fleet-scan.ts`: fleet identifier screening over HTTP.
 *
 * Everything with a decision in it lives here so a test can drive it against a real HTTP
 * stand-in: the bounded pool, the retry policy, the byte-range read, the dataset status,
 * the completeness rule and the summary. The script is a thin CLI over this file.
 *
 * **Tri-state, never fail-open.** A read that failed, a cap that was hit and a format the
 * scanner does not parse are each COUNTED, and none of them is ever read as "clean".
 * `incomplete` is derived from the counts (every EDF/BDF header read, every side file read,
 * no sampling cap hit), never from "no failure was recorded" (ADR 0053, ADR 0067).
 *
 * **Output carries no values.** A record holds kinds, counts, field names the module draws
 * from a closed set, and distinct-value COUNTS. Failure classes are HTTP statuses or fixed
 * words, never an error message, because a parser's message can quote the input.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATE_KINDS,
  DIRECT_KINDS,
  EDF_HEADER_BYTES,
  type Finding,
  type FindingKind,
  countByKind,
  edfIdentificationText,
  formatCoverage,
  scanEdfHeader,
  scanJsonKeys,
  scanParticipantIds,
  scanPaths,
  scanScansTable,
  scanTableColumns,
  scanTextForLocalPaths,
} from "../shared/identifier-scan";
import type {
  DatasetRecord,
  DatasetStatus,
  ManifestSource,
  SamplingStat,
} from "../shared/identifier-screen-report";

export type { DatasetRecord, DatasetStatus, ManifestSource, SamplingStat };

export const USER_AGENT = "nemar-identifier-scan/1.0 (+https://docs.nemar.org/policies/takedown/)";
export const DEFAULT_API = "https://api.nemar.org";
export const DEFAULT_DATA = "https://data.nemar.org";
export const DEFAULT_S3 = "https://nemar.s3.us-east-2.amazonaws.com";
export const DEFAULT_GITHUB_API = "https://api.github.com";

// ---------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------

/** A bad command line or a bad `--only` list: the CLI exits 2 with the message. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE =
  "usage: identifier-fleet-scan.ts --out <dir> [--only id,id] [--concurrency N] " +
  "[--worker-concurrency N] [--datasets N] [--abort-streak N] [--aws-timeout SECONDS] [--force]";

/** A positive integer from text, or a UsageError naming the flag. */
export function parsePositiveInt(name: string, raw: string): number {
  if (!/^\d+$/.test(raw))
    throw new UsageError(`--${name} must be a positive integer, got "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export interface CliOptions {
  out: string;
  only: string[] | undefined;
  /** Concurrent file reads within one dataset (direct S3 reads are bounded only by this). */
  fileConcurrency: number;
  /** Concurrent requests to the Worker across ALL datasets. */
  workerConcurrency: number;
  datasetConcurrency: number;
  /** Consecutive 429, 5xx, timeout or network failures from one request class that stop the run. */
  abortStreak: number;
  /** Seconds before a hung `aws s3 cp` is killed. */
  awsTimeoutSeconds: number;
  force: boolean;
}

const VALUE_FLAGS = new Set([
  "out",
  "only",
  "concurrency",
  "worker-concurrency",
  "datasets",
  "abort-streak",
  "aws-timeout",
]);

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--force") {
      force = true;
    } else if (token.startsWith("--") && VALUE_FLAGS.has(token.slice(2))) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${token} needs a value`);
      }
      values.set(token.slice(2), value);
      i++;
    } else {
      throw new UsageError(`unknown argument "${token}"`);
    }
  }
  const out = values.get("out");
  if (!out) throw new UsageError("--out <dir> is required");
  const onlyRaw = values.get("only");
  const only = onlyRaw === undefined ? undefined : [...new Set(onlyRaw.split(",").filter(Boolean))];
  if (only && only.length === 0) throw new UsageError("--only names no dataset id");
  return {
    out,
    only,
    fileConcurrency: parsePositiveInt("concurrency", values.get("concurrency") ?? "24"),
    workerConcurrency: parsePositiveInt(
      "worker-concurrency",
      values.get("worker-concurrency") ?? "6",
    ),
    datasetConcurrency: parsePositiveInt("datasets", values.get("datasets") ?? "4"),
    abortStreak: parsePositiveInt("abort-streak", values.get("abort-streak") ?? "25"),
    awsTimeoutSeconds: parsePositiveInt("aws-timeout", values.get("aws-timeout") ?? "600"),
    force,
  };
}

// ---------------------------------------------------------------------------------------
// Pool, limiter and retry
// ---------------------------------------------------------------------------------------

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * Run `fn` over `items` with at most `size` in flight. A size that would start no worker
 * (zero, negative, NaN, fractional) throws rather than silently doing nothing. Every worker
 * is allowed to finish before the first failure is rethrown, so no work outlives the call.
 */
export async function pool<T>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  assertPositiveInt("pool size", size);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** A counting semaphore: at most `max` calls to `fn` run at once, across every caller. */
export function createLimiter(max: number): Limiter {
  assertPositiveInt("limit", max);
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // A released slot is handed straight to the next waiter, so `active` never dips and a
    // caller arriving in between cannot take a slot the waiter was promised.
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** A failed read, classed by a fixed word or an HTTP status. Never carries a value. */
export class ReadFailure extends Error {
  readonly cls: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** How long the server asked us to wait (Retry-After), when it said. */
  readonly retryAfterMs: number | undefined;
  constructor(
    cls: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(cls);
    this.name = "ReadFailure";
    this.cls = cls;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; undefined when absent or unusable. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const when = Date.parse(text);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** 5xx and 429 are worth another try, after the wait the server asked for; every other status is an answer. */
export function httpFailure(status: number, retryAfter?: string | null): ReadFailure {
  const retryable = status >= 500 || status === 429;
  return new ReadFailure(`http-${status}`, {
    status,
    retryable,
    retryAfterMs: retryable ? parseRetryAfter(retryAfter) : undefined,
  });
}

/** Stops the whole run, not one request: the server is struggling or asked us to stay away. */
export class RunAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunAborted";
  }
}

export interface Breaker {
  /** Throws {@link RunAborted} once either request class has tripped. */
  check(): void;
  /** The server answered: the streak is over. */
  ok(): void;
  /** A failed attempt; may trip the breaker. */
  observe(error: ReadFailure): void;
  /** Epoch milliseconds before which no request of this class should start: the latest Retry-After. */
  pausedUntilMs(): number;
}

/**
 * One breaker per request class (the Worker and direct reads), sharing a trip: when either
 * stops, everything stops. It trips on a streak of consecutive retryable failures (429, 5xx,
 * timeout, network; any answer in between, including a 404, ends the streak) and at once on a
 * Retry-After longer than the cap, which means maintenance, not congestion.
 */
export function createBreakers(options: {
  streak: number;
  retryAfterCapMs: number;
  now?: () => number;
}): {
  worker: Breaker;
  direct: Breaker;
} {
  assertPositiveInt("abort streak", options.streak);
  const now = options.now ?? Date.now;
  const state: { tripped: RunAborted | null } = { tripped: null };
  const make = (name: string): Breaker => {
    let consecutive = 0;
    let pausedUntil = 0;
    const trip = (message: string): never => {
      state.tripped = new RunAborted(message);
      throw state.tripped;
    };
    return {
      check() {
        if (state.tripped) throw state.tripped;
      },
      ok() {
        consecutive = 0;
      },
      pausedUntilMs() {
        return pausedUntil;
      },
      observe(error) {
        if (state.tripped) throw state.tripped;
        if (error.retryAfterMs !== undefined && error.retryAfterMs > options.retryAfterCapMs) {
          trip(
            `${name} asked to wait ${Math.round(error.retryAfterMs / 1000)} s (Retry-After), ` +
              `over the ${Math.round(options.retryAfterCapMs / 1000)} s cap (${error.cls})`,
          );
        }
        // A Retry-After within the cap pauses the whole request class, not only this request.
        if (error.retryAfterMs !== undefined) {
          pausedUntil = Math.max(pausedUntil, now() + error.retryAfterMs);
        }
        if (!error.retryable) {
          consecutive = 0;
          return;
        }
        consecutive++;
        if (consecutive >= options.streak) {
          trip(
            `${consecutive} consecutive 429, 5xx, timeout or network failures from ${name} ` +
              `(last ${error.cls})`,
          );
        }
      },
    };
  };
  return { worker: make("the Worker"), direct: make("direct reads") };
}

/** A fetch or body read that threw: a timeout or a dropped connection, both retryable. */
export function networkFailure(error: unknown): ReadFailure {
  const name = error instanceof Error ? error.name : "";
  const timedOut = name === "TimeoutError" || name === "AbortError";
  return new ReadFailure(timedOut ? "timeout" : "network", { retryable: true });
}

export function failureClass(error: unknown): string {
  if (error instanceof ReadFailure) return error.cls;
  return `error-${error instanceof Error ? error.name : "unknown"}`;
}

export interface RetryOptions {
  tries?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A Retry-After above this is not waited out and not retried (default 30 s). */
  retryAfterCapMs?: number;
}

/**
 * Retry `fn` on a network error, a timeout, HTTP 5xx or 429, and nowhere else: a 403, 404,
 * 413 or 416 is the server's answer and asking again cannot change it. A Retry-After the
 * server sent is waited out when it is longer than the backoff and within the cap; above the
 * cap the request is not retried. It does not sleep after the final attempt.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const tries = options.tries ?? 3;
  const baseMs = options.baseMs ?? 400;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  assertPositiveInt("tries", tries);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable = error instanceof ReadFailure && error.retryable;
      if (!retryable || attempt >= tries) throw error;
      const asked = error.retryAfterMs ?? 0;
      if (asked > (options.retryAfterCapMs ?? 30_000)) throw error;
      await sleep(Math.max(baseMs * 2 ** (attempt - 1), asked));
    }
  }
}

// ---------------------------------------------------------------------------------------
// Reading bytes
// ---------------------------------------------------------------------------------------

async function cancelBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

export interface ReadHeadOptions {
  /** Fewer bytes than this is a failed read (`short-body`), not a short file. */
  minBytes?: number;
  userAgent?: string;
  timeoutMs?: number;
}

/**
 * Read at most `n` bytes from the start of a URL.
 *
 * Only 200 and 206 are reads. A server that ignores `Range` answers 200 with the whole file:
 * this takes the first `n` bytes and cancels the body, so a recording is never downloaded.
 * 404, 416 (an empty object), a short body and a dropped connection are failures to read,
 * thrown as {@link ReadFailure} so the caller counts them; they are never an empty header.
 */
export async function readHead(
  url: string,
  n: number,
  options: ReadHeadOptions = {},
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Range: `bytes=0-${n - 1}`,
        "Accept-Encoding": "identity",
        "User-Agent": options.userAgent ?? USER_AGENT,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw networkFailure(error);
  }
  if (res.status !== 200 && res.status !== 206) {
    await cancelBody(res);
    throw httpFailure(res.status, res.headers.get("retry-after"));
  }
  const reader = res.body?.getReader();
  if (!reader) throw new ReadFailure("no-body");
  const out = new Uint8Array(n);
  let got = 0;
  try {
    while (got < n) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, n - got);
      out.set(value.subarray(0, take), got);
      got += take;
    }
  } catch (error) {
    throw networkFailure(error);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (got < (options.minBytes ?? 0)) throw new ReadFailure("short-body");
  return out.subarray(0, got);
}

// ---------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------

export interface FleetLimits {
  /** EDF/BDF headers read when the manifest came from the git tree (every read is a Worker request). */
  treeHeaderSample: number;
  /** `_scans.tsv` tables read per dataset. */
  scansTables: number;
  /** Non-BIDS JSON files read per dataset. */
  jsonFiles: number;
  /** Code and text files read per dataset. */
  textFiles: number;
  /** A JSON or text file larger than this is not read (and is counted). */
  sideFileBytes: number;
  /** Bytes read of participants.tsv (the header row and the participant labels). */
  participantsBytes: number;
}

/**
 * Byte limits for a scan of bytes read locally: the publication screen's metadata-only clone and
 * the uploader preflight's own tree (ADR 0086, ADR 0087). One definition, so the two read side
 * files and tables the same way. One JSON or text file (and one scans table) is read up to
 * `sideFileBytes`; `participants.tsv` is one row per participant, and 36,000 participants is a
 * few megabytes.
 */
export const LOCAL_SCAN_LIMITS: Readonly<Pick<FleetLimits, "sideFileBytes" | "participantsBytes">> =
  {
    sideFileBytes: 2 * 1024 * 1024,
    participantsBytes: 16 * 1024 * 1024,
  };

export interface FleetContext {
  api: string;
  data: string;
  s3Base: string;
  githubApi: string;
  userAgent: string;
  /** Concurrent file reads within one dataset. */
  fileConcurrency: number;
  /** Bounds every request to the Worker across all datasets. */
  workerLimit: Limiter;
  timeoutMs: number;
  manifestTimeoutMs: number;
  retryBaseMs: number;
  /** Waits between retries; tests record it instead of sleeping. */
  sleep: (ms: number) => Promise<void>;
  /** The clock, in epoch milliseconds; tests advance it from their recorded sleeps. */
  now: () => number;
  /** A Retry-After above this stops the run (and is never waited out). */
  retryAfterCapMs: number;
  /** Stops the run on a streak of failures, or a Retry-After over the cap. */
  breakers: { worker: Breaker; direct: Breaker };
  limits: FleetLimits;
  /** Raw text of `<id>/version/<tag>.json` in S3. The default shells out to the `aws` CLI. */
  readVersionManifest: (id: string, version: string) => Promise<string>;
  /** A GitHub token for the git-tree fallback, or null. */
  githubToken: () => Promise<string | null>;
  /**
   * Reads the first bytes of an entry in place of `readHead(entry.url)`. The publication screen
   * reads a git blob or a presigned S3 object through it. It runs inside the same retry,
   * breaker and pool as the HTTP read, so it must throw {@link ReadFailure} for a read that
   * failed (never return fewer than `minBytes`), and it never sees a Worker URL.
   */
  readEntryHead?: EntryReader;
}

/** What {@link FleetContext.readEntryHead} receives besides the entry and the byte count. */
export interface EntryReadOptions {
  minBytes: number;
  userAgent: string;
  timeoutMs: number;
}

export type EntryReader = (
  entry: ManifestEntry,
  n: number,
  options: EntryReadOptions,
) => Promise<Uint8Array>;

export interface ContextOptions
  extends Partial<Omit<FleetContext, "workerLimit" | "limits" | "fileConcurrency" | "breakers">> {
  fileConcurrency?: number;
  workerConcurrency?: number;
  /** Consecutive retryable failures that stop the run (default 25). */
  abortStreak?: number;
  /** Kill a hung `aws s3 cp` after this long (default 10 minutes). */
  awsTimeoutMs?: number;
  /** The environment for the `aws` subprocess; it REPLACES the ambient one when given. */
  awsEnv?: Record<string, string>;
  limits?: Partial<FleetLimits>;
}

/** What the `aws` CLI said went wrong, as a fixed class: an HTTP status or an error code, never text. */
function awsFailureClass(stderr: string, code: number): string {
  const found = /An error occurred \(([A-Za-z0-9]{1,40})\)/.exec(stderr)?.[1];
  if (found) return /^\d+$/.test(found) ? `aws/http-${found}` : `aws/error-${found}`;
  return `aws/exit-${code}`;
}

export interface AwsOptions {
  /** Kill the subprocess after this long (default 10 minutes). */
  timeoutMs?: number;
  /** Replaces the ambient environment of the subprocess. */
  env?: Record<string, string>;
}

/**
 * The ambient-credential fallback: `aws s3 cp` of the raw version manifest, killed after
 * `timeoutMs`. Failures are classed `aws/timeout`, `aws/http-<status>`, `aws/error-<Code>`,
 * `aws/exit-<n>` or `aws/unavailable` (no `aws` binary); stderr is read only for that class.
 */
export async function readVersionManifestViaAws(
  id: string,
  version: string,
  options: AwsOptions = {},
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(["aws", "s3", "cp", `s3://nemar/${id}/version/${version}.json`, "-"], {
      stdout: "pipe",
      stderr: "pipe",
      ...(options.env ? { env: options.env } : {}),
    });
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, options.timeoutMs ?? 600_000);
    const [text, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) throw new ReadFailure("aws/timeout");
    if (code !== 0) throw new ReadFailure(awsFailureClass(stderr, code));
    return text;
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure("aws/unavailable");
  } finally {
    clearTimeout(timer);
  }
}

/** The ambient-credential fallback: `GITHUB_TOKEN`, else `gh auth token`, else none. */
export function createGithubTokenReader(): () => Promise<string | null> {
  let cached: string | null | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    if (process.env.GITHUB_TOKEN) {
      cached = process.env.GITHUB_TOKEN;
      return cached;
    }
    try {
      const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
      const text = (await new Response(proc.stdout).text()).trim();
      cached = text === "" ? null : text;
    } catch {
      cached = null;
    }
    return cached;
  };
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export function createContext(options: ContextOptions = {}): FleetContext {
  const retryAfterCapMs = options.retryAfterCapMs ?? 30_000;
  const awsTimeoutMs = options.awsTimeoutMs ?? 600_000;
  return {
    api: trimSlash(options.api ?? process.env.NEMAR_API_BASE ?? DEFAULT_API),
    data: trimSlash(options.data ?? process.env.NEMAR_DATA_BASE ?? DEFAULT_DATA),
    s3Base: trimSlash(options.s3Base ?? DEFAULT_S3),
    githubApi: trimSlash(options.githubApi ?? DEFAULT_GITHUB_API),
    userAgent: options.userAgent ?? USER_AGENT,
    fileConcurrency: options.fileConcurrency ?? 24,
    workerLimit: createLimiter(options.workerConcurrency ?? 6),
    timeoutMs: options.timeoutMs ?? 30_000,
    manifestTimeoutMs: options.manifestTimeoutMs ?? 120_000,
    retryBaseMs: options.retryBaseMs ?? 400,
    sleep:
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: options.now ?? Date.now,
    retryAfterCapMs,
    breakers: createBreakers({
      streak: options.abortStreak ?? 25,
      retryAfterCapMs,
      now: options.now ?? Date.now,
    }),
    limits: {
      treeHeaderSample: 300,
      scansTables: 1,
      jsonFiles: 300,
      textFiles: 300,
      sideFileBytes: 65_536,
      participantsBytes: 1_048_576,
      ...options.limits,
    },
    readVersionManifest:
      options.readVersionManifest ??
      ((id, version) =>
        readVersionManifestViaAws(id, version, { timeoutMs: awsTimeoutMs, env: options.awsEnv })),
    githubToken: options.githubToken ?? createGithubTokenReader(),
    ...(options.readEntryHead ? { readEntryHead: options.readEntryHead } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------

const isWorkerUrl = (ctx: FleetContext, url: string) => url.startsWith(`${ctx.data}/`);

/** The Worker serves the data plane and the catalog API; everything else is a direct read. */
const breakerFor = (ctx: FleetContext, url: string): Breaker =>
  isWorkerUrl(ctx, url) || url.startsWith(`${ctx.api}/`)
    ? ctx.breakers.worker
    : ctx.breakers.direct;

/** One attempt, watched by its request class's breaker (checked before, observed after). */
async function guarded<T>(ctx: FleetContext, url: string, run: () => Promise<T>): Promise<T> {
  const breaker = breakerFor(ctx, url);
  breaker.check();
  const wait = breaker.pausedUntilMs() - ctx.now();
  if (wait > 0) {
    await ctx.sleep(wait);
    breaker.check();
  }
  try {
    const value = await run();
    breaker.ok();
    return value;
  } catch (error) {
    if (error instanceof ReadFailure) breaker.observe(error);
    throw error;
  }
}

const retryOptions = (ctx: FleetContext, tries?: number): RetryOptions => ({
  ...(tries === undefined ? {} : { tries }),
  baseMs: ctx.retryBaseMs,
  sleep: ctx.sleep,
  retryAfterCapMs: ctx.retryAfterCapMs,
});

async function request(
  ctx: FleetContext,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      headers: { "User-Agent": ctx.userAgent, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw networkFailure(error);
  }
}

async function jsonBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    throw networkFailure(error);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReadFailure("json-parse");
  }
}

/** One GET that must return 2xx JSON; failures are classed, the Worker limit applies if asked. */
async function getJson(
  ctx: FleetContext,
  url: string,
  options: { headers?: Record<string, string>; timeoutMs: number; tries: number; limited: boolean },
): Promise<unknown> {
  const attempt = (): Promise<unknown> =>
    guarded(ctx, url, async () => {
      const res = await request(ctx, url, options.headers ?? {}, options.timeoutMs);
      if (!res.ok) {
        await cancelBody(res);
        throw httpFailure(res.status, res.headers.get("retry-after"));
      }
      return jsonBody(res);
    });
  return withRetry(
    () => (options.limited ? ctx.workerLimit(attempt) : attempt()),
    retryOptions(ctx, options.tries),
  );
}

// ---------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------

const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface CatalogEntry {
  id: string;
  version: string | null;
}

export async function listPublicDatasets(ctx: FleetContext): Promise<CatalogEntry[]> {
  const out: CatalogEntry[] = [];
  for (let offset = 0; ; offset += 100) {
    const body = await getJson(ctx, `${ctx.api}/datasets?limit=100&offset=${offset}`, {
      timeoutMs: ctx.timeoutMs,
      tries: 3,
      limited: false,
    });
    const page = (body as { datasets?: unknown } | null)?.datasets;
    if (!Array.isArray(page)) throw new ReadFailure("catalog-shape");
    for (const d of page as Record<string, unknown>[]) {
      if (typeof d?.dataset_id !== "string" || !DATASET_ID.test(d.dataset_id)) {
        throw new ReadFailure("catalog-shape");
      }
      if (d.visibility === "public") {
        out.push({
          id: d.dataset_id,
          version:
            typeof d.latest_version === "string" && d.latest_version ? d.latest_version : null,
        });
      }
    }
    const total = Number((body as { total_count?: unknown }).total_count);
    if (!Number.isFinite(total) || offset + 100 >= total || page.length === 0) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------------------

export interface ManifestEntry {
  path: string;
  /** Null when the manifest did not say; only a size of exactly 0 means "empty". */
  size: number | null;
  url: string;
  /**
   * True when something other than the path says this is an EDF or BDF recording (a clone entry
   * whose annex key ends `.edf` or `.bdf` in any letter case, though the file was renamed since).
   * A path that ends `.edf` or `.bdf` is one without this flag.
   */
  edf?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const sizeOf = (v: unknown): number | null => (typeof v === "number" && v >= 0 ? v : null);

/** A `manifest.json` body as entries, or `manifest-shape`: never a TypeError downstream. */
export function parseManifest(body: unknown): ManifestEntry[] {
  if (!Array.isArray(body)) throw new ReadFailure("manifest-shape");
  return body.map((e: unknown) => {
    if (!isRecord(e)) throw new ReadFailure("manifest-shape");
    if (typeof e.path !== "string" || e.path === "") throw new ReadFailure("manifest-shape");
    if (typeof e.url !== "string" || e.url === "") throw new ReadFailure("manifest-shape");
    return { path: e.path, size: sizeOf(e.size), url: e.url };
  });
}

/**
 * Entries from a raw version manifest (`<id>/version/<tag>.json`). Every file is read through
 * the stable data-plane route, whether its annex bytes are plain or chunked. Raw S3 is used to
 * retrieve the manifest document itself, not as the file URL contract.
 */
export function entriesFromVersionManifest(
  doc: unknown,
  id: string,
  version: string,
  bases: { data: string },
): ManifestEntry[] {
  const files = isRecord(doc) ? doc.files : undefined;
  if (!isRecord(files)) throw new ReadFailure("manifest-shape");
  return Object.entries(files).map(([path, f]) => {
    if (!isRecord(f) || typeof f.key !== "string" || f.key === "") {
      throw new ReadFailure("manifest-shape");
    }
    const url = `${bases.data}/${id}/${version}/${encodePath(path)}`;
    return { path, size: sizeOf(f.size), url };
  });
}

/** Entries from a GitHub git tree: paths from the tree, bytes through the data plane. */
export function entriesFromGitTree(
  body: unknown,
  id: string,
  version: string,
  data: string,
): ManifestEntry[] {
  if (!isRecord(body) || !Array.isArray(body.tree)) throw new ReadFailure("manifest-shape");
  if (body.truncated === true) throw new ReadFailure("tree-truncated");
  const out: ManifestEntry[] = [];
  for (const n of body.tree as unknown[]) {
    if (!isRecord(n) || typeof n.path !== "string" || n.path === "") {
      throw new ReadFailure("manifest-shape");
    }
    if (n.type !== "blob") continue;
    out.push({
      path: n.path,
      size: sizeOf(n.size),
      url: `${data}/${id}/${version}/${encodePath(n.path)}`,
    });
  }
  return out;
}

export type LoadedManifest =
  | { ok: true; entries: ManifestEntry[]; source: ManifestSource }
  | { ok: false; reason: string };

/**
 * The latest manifest, from the data plane, or, when the data plane refuses it as too large
 * (ADR 0072, HTTP 413, never retried), from the raw version manifest in S3 and then the git
 * tree. Both fallbacks use ambient credentials the caller may not have; each failure is
 * classed in the reason.
 */
export async function loadManifest(
  ctx: FleetContext,
  id: string,
  version: string,
): Promise<LoadedManifest> {
  try {
    const body = await getJson(ctx, `${ctx.data}/${id}/${version}/manifest.json`, {
      timeoutMs: ctx.manifestTimeoutMs,
      tries: 2,
      limited: true,
    });
    return { ok: true, entries: parseManifest(body), source: "manifest.json" };
  } catch (error) {
    if (error instanceof RunAborted) throw error;
    if (!(error instanceof ReadFailure) || error.status !== 413) {
      return { ok: false, reason: `manifest:${failureClass(error)}` };
    }
  }
  let s3Class: string;
  try {
    const text = await ctx.readVersionManifest(id, version);
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new ReadFailure("json-parse");
    }
    return {
      ok: true,
      entries: entriesFromVersionManifest(doc, id, version, { data: ctx.data }),
      source: "s3-version-manifest",
    };
  } catch (error) {
    if (error instanceof RunAborted) throw error;
    s3Class = failureClass(error);
  }
  try {
    const token = await ctx.githubToken();
    const body = await getJson(
      ctx,
      `${ctx.githubApi}/repos/nemarDatasets/${id}/git/trees/${version}?recursive=1`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeoutMs: ctx.manifestTimeoutMs,
        tries: 3,
        limited: false,
      },
    );
    return {
      ok: true,
      entries: entriesFromGitTree(body, id, version, ctx.data),
      source: "git-tree",
    };
  } catch (error) {
    if (error instanceof RunAborted) throw error;
    return {
      ok: false,
      reason: `manifest:too-large(s3:${s3Class},tree:${failureClass(error)})`,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------------------

/** The first `sub-<label>` in a path, or "?". The label is only ever a grouping key. */
export const subjectOf = (path: string): string => /sub-([^/_]+)/.exec(path)?.[1] ?? "?";

/**
 * At most `max` items spread evenly over the groups (subjects), and evenly within each
 * group; every group is represented when there are at most `max` of them, and `max` groups
 * evenly spaced when there are more. Deterministic. The input is returned whole when it fits.
 */
export function sampleEvenly<T>(
  items: readonly T[],
  max: number,
  groupOf: (item: T) => string,
): T[] {
  if (max < 1) return [];
  if (items.length <= max) return [...items];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = groupOf(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, list]) => list);
  if (ordered.length > max) {
    return Array.from({ length: max }, (_, i) => {
      const list = ordered[Math.floor(((i + 0.5) * ordered.length) / max)] as T[];
      return list[0] as T;
    });
  }
  // Small groups give everything they have; the larger ones share what is left.
  const bySize = ordered
    .map((list, index) => ({ list, index }))
    .sort((a, b) => a.list.length - b.list.length || a.index - b.index);
  let remaining = max;
  const out: T[] = [];
  bySize.forEach(({ list }, position) => {
    const quota = Math.min(list.length, Math.ceil(remaining / (bySize.length - position)));
    for (let j = 0; j < quota; j++) {
      out.push(list[Math.floor(((j + 0.5) * list.length) / quota)] as T);
    }
    remaining -= quota;
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/** An identifier-severity finding of a kind that names a person or a clinical record. */
export const isDirectFinding = (f: Finding): boolean =>
  f.severity === "identifier" && DIRECT_KINDS.has(f.kind);

/**
 * A calendar date finer than year in a header. Acceptable when nothing links the recording to a
 * person (policy 2026-10-04), so it is reported but never changes whether a dataset is clean.
 */
export const isDateFinding = (f: Finding): boolean => DATE_KINDS.has(f.kind);

export interface ClassifyInput {
  findings: readonly Finding[];
  /** EDF/BDF files in the manifest, whether or not they were all read. */
  edfCount: number;
  /** EDF/BDF headers read AND scanned. */
  headerRead: number;
  /** Recording files in formats the scanner cannot parse. */
  unscreenedCount: number;
  /** Reasons the scan did not cover everything it could have. */
  incompleteReasons: readonly string[];
}

/**
 * Complete means every EDF/BDF header was read and scanned, every side read succeeded and no
 * sampling cap was hit. It is computed from counts, never inferred from the absence of a
 * recorded failure.
 */
export function isComplete(input: ClassifyInput): boolean {
  return input.headerRead === input.edfCount && input.incompleteReasons.length === 0;
}

/**
 * The dataset's verdict. A finding already made is never hidden by incompleteness; only a
 * dataset with no finding can be `unchecked`, and `clean` needs a complete scan of EDF/BDF
 * headers and NO recording in a format the scanner cannot parse.
 */
export function classifyDataset(input: ClassifyInput): DatasetStatus {
  if (input.findings.some(isDirectFinding)) return "direct-identifiers";
  // Any finding that is not just an acceptable date needs a person to look.
  if (input.findings.some((f) => !isDateFinding(f))) return "review";
  if (!isComplete(input)) return "unchecked";
  if (input.edfCount > 0 && input.unscreenedCount > 0) return "clean-edf-only-others-unscreened";
  if (input.edfCount === 0) return input.unscreenedCount > 0 ? "not-screened" : "no-recordings";
  // Complete, EDF/BDF only: clean, noting acceptable dates when there are any.
  return input.findings.length > 0 ? "dates-only" : "clean";
}

// ---------------------------------------------------------------------------------------
// One dataset
// ---------------------------------------------------------------------------------------

const EDF_FILE = /\.(edf|bdf)$/i;
const isEdfEntry = (e: ManifestEntry): boolean => e.edf === true || EDF_FILE.test(e.path);

/** The entries a scan may read, by kind. The byte limit on side files is applied by the scan. */
export interface ReadCandidates {
  edf: ManifestEntry[];
  participants: ManifestEntry | undefined;
  scans: ManifestEntry[];
  json: ManifestEntry[];
  text: ManifestEntry[];
}

/**
 * Which entries of a manifest {@link scanDatasetFromManifest} would read. One definition, so a
 * caller that must fetch content before the scan (the publication screen prefetches the git
 * blobs a partial clone left behind) asks for exactly what the scan will ask for.
 */
export function readCandidates(manifest: readonly ManifestEntry[]): ReadCandidates {
  return {
    edf: manifest.filter(isEdfEntry),
    participants: manifest.find((e) => e.path === "participants.tsv"),
    scans: manifest.filter((e) => e.path.endsWith("_scans.tsv")),
    json: manifest
      .filter((e) => e.path.endsWith(".json"))
      .filter((e) => e.path.startsWith("sourcedata/") || !BIDS_SIDECAR.test(e.path))
      .filter((e) => !JSON_EXCLUDED.test(e.path)),
    text: manifest
      .filter((e) => TEXT_FILE.test(e.path))
      .filter((e) => e.path.startsWith("sourcedata/") || e.path.startsWith("code/")),
  };
}
const BIDS_SIDECAR =
  /_(eeg|ieeg|meg|emg|nirs|beh|events|channels|electrodes|coordsystem|scans|physio|stim|photo|T1w|bold)\.(json|tsv)$/;
const JSON_EXCLUDED = /(^|\/)(dataset_description|participants|genetic_info)\.json$/;
const TEXT_FILE = /\.(py|m|r|txt|md|ya?ml|xml|iml|cfg|ini)$/i;

/** Read at most `n` bytes of an entry, retried by policy, bounded if it goes through the Worker. */
function readEntry(
  ctx: FleetContext,
  entry: ManifestEntry,
  n: number,
  minBytes = 0,
): Promise<Uint8Array> {
  const attempt = () =>
    guarded(ctx, entry.url, () => {
      const options = { minBytes, userAgent: ctx.userAgent, timeoutMs: ctx.timeoutMs };
      return ctx.readEntryHead
        ? ctx.readEntryHead(entry, n, options)
        : readHead(entry.url, n, options);
    });
  return withRetry(
    () => (isWorkerUrl(ctx, entry.url) ? ctx.workerLimit(attempt) : attempt()),
    retryOptions(ctx),
  );
}

async function readText(
  ctx: FleetContext,
  entry: ManifestEntry,
  bytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const head = await readEntry(ctx, entry, bytes);
  const truncated = entry.size === null ? head.length >= bytes : entry.size > bytes;
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(head), truncated };
}

function unchecked(
  base: { id: string; version: string | null; scanned_at: string },
  reason: string,
): DatasetRecord {
  return { ...base, status: "unchecked", incomplete: true, incomplete_reasons: [reason] };
}

/**
 * Append `items` to `target` one by one. `target.push(...items)` is not a substitute: a call spreads
 * its arguments onto the stack, and Bun throws a RangeError once there are somewhere between
 * 500,000 and 1,000,000 of them. A participants table of 16 MB can yield more findings than that,
 * and the scrub's `appendAll` (#1640) was written for the same reason. A throw here would be read
 * as an unreadable file and the record would be `unchecked`, which is safe but wrong for a table
 * that was read in full.
 */
function addFindings(target: Finding[], items: readonly Finding[]): void {
  for (const item of items) target.push(item);
}

/** What a caller adds to a scan of a tree that the tree itself cannot say. */
export interface ScanExtras {
  /**
   * Paths that existed on some ref but are not in the scanned tree. They get the path rules
   * and nothing else: their content is never read, they are not counted in `files`, and they
   * do not count toward format coverage.
   */
  extraPaths?: readonly string[];
  /** Reasons the caller already knows the scan fell short, for example `history-unread`. */
  extraIncompleteReasons?: readonly string[];
  /**
   * Recordings that were in an earlier commit but are not in the scanned tree. Their bytes are
   * as public as the tree's (git history and the bucket), so each header is read and counted with
   * the tree's recordings: an unreadable one makes the record `unchecked`. The exception is an
   * object the store answers 404 for, which is gone and leaks nothing: it is counted under the
   * fixed read-failure class `edf/superseded-absent`, left out of the recording counts, and does
   * not make the record incomplete. Any other failure (403, a timeout) is a failure like any other.
   */
  supersededEdf?: readonly ManifestEntry[];
}

/** The read-failure class of a superseded recording whose object no longer exists. */
export const SUPERSEDED_ABSENT = "edf/superseded-absent";

/**
 * Scan one dataset from its manifest: EDF/BDF headers, the participants table, scans tables,
 * non-BIDS JSON and small code and text files. Reads only the first bytes of each file.
 *
 * `source: "clone"` is a local read of a metadata-only clone, so it is uncapped: every EDF/BDF
 * header, every scans table and every candidate JSON and text file is read. Any cap would make
 * a screen `unchecked` for a reason that costs nothing to remove. The byte limit on one side
 * file (`limits.sideFileBytes`) is still the caller's, and a file over it is still counted.
 */
export async function scanDatasetFromManifest(
  ctx: FleetContext,
  id: string,
  version: string | null,
  manifest: readonly ManifestEntry[],
  source: ManifestSource,
  extras: ScanExtras = {},
): Promise<DatasetRecord> {
  const paths = manifest.map((e) => e.path);
  const uncapped = source === "clone";
  const pick = <T>(items: readonly T[], max: number, groupOf: (item: T) => string): T[] =>
    uncapped ? [...items] : sampleEvenly(items, max, groupOf);
  const findings: Finding[] = [...scanPaths([...paths, ...(extras.extraPaths ?? [])])];
  const coverage = formatCoverage(paths);
  const unscreenedCount = Object.values(coverage.unscreened).reduce((a, b) => a + b, 0);
  const failures: Record<string, number> = {};
  const fail = (what: string, error: unknown) => {
    // A stopped run is not a failed read: let it end the scan, record nothing.
    if (error instanceof RunAborted) throw error;
    const key = `${what}/${failureClass(error)}`;
    failures[key] = (failures[key] ?? 0) + 1;
  };
  const subjectKey = (e: ManifestEntry) => subjectOf(e.path);

  // EDF/BDF headers: 256 bytes each. A tree-sourced manifest reads everything through the
  // Worker, so it is sampled; every other source reads every header.
  const candidates = readCandidates(manifest);
  const superseded = new Set(extras.supersededEdf ?? []);
  const edfAll = [...candidates.edf, ...superseded];
  const { participants, scans: scansAll, json: jsonCandidates, text: textCandidates } = candidates;
  const edfSelected =
    source === "git-tree"
      ? sampleEvenly(edfAll, ctx.limits.treeHeaderSample, subjectKey)
      : [...edfAll];
  let headerRead = 0;
  let headerFailed = 0;
  let supersededAbsent = 0;
  let flaggedFileCount = 0;
  const flaggedKinds: Partial<Record<FindingKind, number>> = {};
  const patientValues = new Set<string>();
  const flaggedPatientValues = new Set<string>();
  const codeValues = new Set<string>();
  const nameValues = new Set<string>();
  const birthValues = new Set<string>();
  const subjects = new Set<string>();
  await pool(edfSelected, ctx.fileConcurrency, async (entry) => {
    try {
      const head = await readEntry(ctx, entry, EDF_HEADER_BYTES, EDF_HEADER_BYTES);
      const found = scanEdfHeader(head);
      const { patient } = edfIdentificationText(head);
      // Everything below only commits; nothing that can throw runs after `headerRead++`.
      if (!found.some((f) => f.kind === "edf-unreadable")) {
        patientValues.add(patient);
        const parts = patient.split(/\s+/);
        if (parts.length >= 4) {
          codeValues.add(parts[0] as string);
          birthValues.add(parts[2] as string);
          nameValues.add(parts[3] as string);
        }
      }
      subjects.add(subjectOf(entry.path));
      if (found.some((f) => f.severity === "identifier")) {
        flaggedFileCount++;
        flaggedPatientValues.add(patient);
      }
      addFindings(findings, found);
      for (const kind of new Set(found.map((f) => f.kind))) {
        flaggedKinds[kind] = (flaggedKinds[kind] ?? 0) + 1;
      }
      headerRead++;
    } catch (error) {
      if (superseded.has(entry) && error instanceof ReadFailure && error.status === 404) {
        supersededAbsent++;
        failures[SUPERSEDED_ABSENT] = (failures[SUPERSEDED_ABSENT] ?? 0) + 1;
        return;
      }
      headerFailed++;
      fail("edf", error);
    }
  });
  // A recording that no longer exists is not a recording that was not read.
  const edfCount = edfAll.length - supersededAbsent;

  // participants.tsv: identifier columns in the header row, name-like participant labels below.
  let participantsUnread = false;
  let participantsTruncated = false;
  if (participants && participants.size !== 0) {
    try {
      const { text, truncated } = await readText(ctx, participants, ctx.limits.participantsBytes);
      const newline = text.indexOf("\n");
      if (newline < 0 && truncated) throw new ReadFailure("header-truncated");
      addFindings(findings, scanTableColumns(newline < 0 ? text : text.slice(0, newline)));
      addFindings(findings, scanParticipantIds(text));
      participantsTruncated = truncated;
    } catch (error) {
      participantsUnread = true;
      fail("participants", error);
    }
  }

  // Scans tables: the dated `acq_time` values.
  const scansSelected = pick(scansAll, ctx.limits.scansTables, subjectKey);
  let scansScanned = 0;
  await pool(scansSelected, ctx.fileConcurrency, async (entry) => {
    if (entry.size === 0) {
      scansScanned++;
      return;
    }
    try {
      const { text } = await readText(ctx, entry, ctx.limits.sideFileBytes);
      // The decoder already drops a leading BOM; `acqTimeCells` drops one more, so the header
      // match is independent of it. The same reading is what the importer's date rule edits.
      addFindings(findings, scanScansTable(text));
      scansScanned++;
    } catch (error) {
      fail("scans", error);
    }
  });

  // Non-BIDS JSON (acquisition-software exports) and small code and text files.
  const sideBytes = ctx.limits.sideFileBytes;
  const tooBig = (e: ManifestEntry) => e.size !== null && e.size > sideBytes;
  const jsonSelected = pick(
    jsonCandidates.filter((e) => !tooBig(e)),
    ctx.limits.jsonFiles,
    subjectKey,
  );
  const textSelected = pick(
    textCandidates.filter((e) => !tooBig(e)),
    ctx.limits.textFiles,
    subjectKey,
  );
  let jsonScanned = 0;
  let textScanned = 0;
  await pool(jsonSelected, ctx.fileConcurrency, async (entry) => {
    if (entry.size === 0) {
      jsonScanned++;
      return;
    }
    try {
      const { text } = await readText(ctx, entry, sideBytes);
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new ReadFailure("json-parse");
      }
      addFindings(findings, scanJsonKeys(doc));
      jsonScanned++;
    } catch (error) {
      fail("json", error);
    }
  });
  await pool(textSelected, ctx.fileConcurrency, async (entry) => {
    if (entry.size === 0) {
      textScanned++;
      return;
    }
    try {
      const { text } = await readText(ctx, entry, sideBytes);
      addFindings(findings, scanTextForLocalPaths(text));
      textScanned++;
    } catch (error) {
      fail("text", error);
    }
  });

  const sampling: NonNullable<DatasetRecord["sampling"]> = {
    edf_headers: {
      candidates: edfCount,
      oversize: 0,
      selected: edfSelected.length - supersededAbsent,
      scanned: headerRead,
    },
    scans_tables: {
      candidates: scansAll.length,
      oversize: 0,
      selected: scansSelected.length,
      scanned: scansScanned,
    },
    json_files: {
      candidates: jsonCandidates.length,
      oversize: jsonCandidates.filter(tooBig).length,
      selected: jsonSelected.length,
      scanned: jsonScanned,
    },
    text_files: {
      candidates: textCandidates.length,
      oversize: textCandidates.filter(tooBig).length,
      selected: textSelected.length,
      scanned: textScanned,
    },
  };

  // Every way this scan fell short of covering what it could have covered.
  const reasons = new Set<string>();
  const shortfall = (name: string, stat: SamplingStat) => {
    if (stat.oversize > 0) reasons.add(`${name}-oversize`);
    if (stat.candidates - stat.oversize > stat.selected) reasons.add(`${name}-sampled`);
    if (stat.scanned < stat.selected) reasons.add(`${name}-unread`);
  };
  shortfall("edf-headers", sampling.edf_headers);
  // Scans tables only carry dated acq_time values, which are review findings and never block
  // (acquisition dates are acceptable when nothing links them to a person), so sampling or
  // truncating them is recorded in `sampling` but does not make a dataset incomplete.
  shortfall("json", sampling.json_files);
  shortfall("text", sampling.text_files);
  // A scans table that could not be read is a read nobody made, however acceptable its dates.
  if (sampling.scans_tables.scanned < sampling.scans_tables.selected) reasons.add("scans-unread");
  if (participantsUnread) reasons.add("participants-unread");
  if (participantsTruncated) reasons.add("participants-truncated");
  for (const reason of extras.extraIncompleteReasons ?? []) reasons.add(reason);
  const incompleteReasons = [...reasons].sort();

  const classify: ClassifyInput = {
    findings,
    edfCount,
    headerRead,
    unscreenedCount,
    incompleteReasons,
  };
  const identifier = findings.filter((f) => f.severity === "identifier");
  const sideFailed = Object.entries(failures)
    .filter(([key]) => !key.startsWith("edf/"))
    .reduce((sum, [, n]) => sum + n, 0);
  return {
    id,
    version,
    scanned_at: new Date().toISOString(),
    manifest_source: source,
    status: classifyDataset(classify),
    incomplete: !isComplete(classify),
    incomplete_reasons: incompleteReasons,
    files: {
      total: manifest.length,
      edf_bdf: edfCount,
      header_read: headerRead,
      header_read_failed: headerFailed,
    },
    sampling,
    read_failures: failures,
    edf_bdf_files_flagged: flaggedFileCount,
    distinct_patient_field_values: patientValues.size,
    distinct_subjects_with_edf_bdf: subjects.size,
    distinct_patient_code_subfield: codeValues.size,
    distinct_patient_name_subfield: nameValues.size,
    distinct_patient_birth_subfield: birthValues.size,
    distinct_patient_field_values_in_flagged_files: flaggedPatientValues.size,
    findings_by_kind: countByKind(findings),
    edf_bdf_files_by_kind: flaggedKinds,
    unscreened_formats: coverage.unscreened,
    side_reads_failed: sideFailed,
    finding_fields: [...new Set(identifier.map((f) => `${f.kind}:${f.field}`))].sort(),
  };
}

/** Load a dataset's manifest (with fallbacks) and scan it. */
export async function scanDataset(
  ctx: FleetContext,
  id: string,
  version: string | null,
): Promise<DatasetRecord> {
  const base = { id, version, scanned_at: new Date().toISOString() };
  if (!version) return unchecked(base, "no-latest-version");
  const loaded = await loadManifest(ctx, id, version);
  if (!loaded.ok) return unchecked(base, loaded.reason);
  return scanDatasetFromManifest(ctx, id, version, loaded.entries, loaded.source);
}

// ---------------------------------------------------------------------------------------
// Summary and run
// ---------------------------------------------------------------------------------------

export interface SummaryRecord {
  id: string;
  status: string;
  incomplete?: boolean;
  incomplete_reasons?: string[];
}

export interface Summary {
  datasets: number;
  by_status: Record<string, { count: number; ids: string[] }>;
  /** Datasets whose scan did not cover everything, whatever their status says. */
  incomplete: { count: number; ids: string[] };
  incomplete_reasons: Record<string, number>;
}

const sortedEntries = <T>(rec: Record<string, T>): [string, T][] =>
  Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export function buildSummary(records: readonly SummaryRecord[]): Summary {
  const byStatus: Record<string, string[]> = {};
  const incompleteIds: string[] = [];
  const reasons: Record<string, number> = {};
  for (const r of records) {
    const ids = byStatus[r.status] ?? [];
    ids.push(r.id);
    byStatus[r.status] = ids;
    // Only a record that says `incomplete: false` is complete; a missing field is not.
    if (r.incomplete !== false) {
      incompleteIds.push(r.id);
      for (const reason of r.incomplete_reasons ?? []) reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }
  return {
    datasets: records.length,
    by_status: Object.fromEntries(
      sortedEntries(byStatus).map(([status, ids]) => [
        status,
        { count: ids.length, ids: ids.sort() },
      ]),
    ),
    incomplete: { count: incompleteIds.length, ids: incompleteIds.sort() },
    incomplete_reasons: Object.fromEntries(sortedEntries(reasons)),
  };
}

/**
 * True when an earlier run's file is final: a verdict other than `unchecked`, complete, and made
 * at the version the catalog names now (a dataset published since then has no verdict yet).
 */
export function isFinalRecord(record: unknown, version: string | null): boolean {
  return (
    isRecord(record) &&
    record.version === version &&
    typeof record.status === "string" &&
    record.status !== "unchecked" &&
    record.incomplete === false
  );
}

function readRecord(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface RunOptions {
  outDir: string;
  only?: string[];
  force: boolean;
  datasetConcurrency: number;
  log?: (line: string) => void;
}

/**
 * Scan the public catalog (or `only`), write one file per dataset and `_summary.json`.
 *
 * A stopped run ({@link RunAborted}: a streak of failures, or a Retry-After over the cap)
 * rejects before any summary is written: the datasets finished so far keep their files and a
 * rerun resumes from them, but a partial summary would read as a complete one.
 */
export async function runFleet(ctx: FleetContext, options: RunOptions): Promise<Summary> {
  assertPositiveInt("dataset concurrency", options.datasetConcurrency);
  const log = options.log ?? (() => undefined);
  const summaryPath = join(options.outDir, "_summary.json");
  // A summary from an earlier run must never read as this run's. A catalog that cannot be read
  // removes it; a mistyped --only (a usage error, checked below) leaves a good one alone.
  let catalog: Awaited<ReturnType<typeof listPublicDatasets>>;
  try {
    catalog = await listPublicDatasets(ctx);
  } catch (error) {
    rmSync(summaryPath, { force: true });
    throw error;
  }
  let targets = catalog;
  if (options.only) {
    const known = new Set(catalog.map((d) => d.id));
    const missing = options.only.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new UsageError(`--only ids not in the public catalog: ${missing.join(", ")}`);
    }
    const wanted = new Set(options.only);
    targets = catalog.filter((d) => wanted.has(d.id));
  }
  rmSync(summaryPath, { force: true });
  mkdirSync(options.outDir, { recursive: true });
  log(`public datasets: ${catalog.length}; scanning ${targets.length}`);
  let done = 0;
  await pool(targets, options.datasetConcurrency, async ({ id, version }) => {
    const file = join(options.outDir, `${id}.json`);
    if (!options.force && isFinalRecord(readRecord(file), version)) {
      done++;
      return;
    }
    const t0 = Date.now();
    let record: DatasetRecord;
    try {
      record = await scanDataset(ctx, id, version);
    } catch (error) {
      // A stopped run writes nothing further: the next request of any class rethrows it.
      if (error instanceof RunAborted) throw error;
      record = unchecked(
        { id, version, scanned_at: new Date().toISOString() },
        `internal:${failureClass(error)}`,
      );
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 1)}\n`);
    renameSync(tmp, file);
    done++;
    log(
      `[${done}/${targets.length}] ${id} ${version ?? "-"} ${record.status}` +
        `${record.incomplete ? " incomplete" : ""} edf_bdf=${record.files?.edf_bdf ?? "-"} ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  });

  const records: SummaryRecord[] = targets.map((d) => {
    const r = readRecord(join(options.outDir, `${d.id}.json`));
    if (r && typeof r.status === "string") {
      return {
        id: d.id,
        status: r.status,
        incomplete: r.incomplete !== false,
        incomplete_reasons: Array.isArray(r.incomplete_reasons)
          ? r.incomplete_reasons.filter((x): x is string => typeof x === "string")
          : [],
      };
    }
    return {
      id: d.id,
      status: "unchecked",
      incomplete: true,
      incomplete_reasons: ["result-file-unreadable"],
    };
  });
  const summary = buildSummary(records);
  writeFileSync(join(options.outDir, "_summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
  return summary;
}
