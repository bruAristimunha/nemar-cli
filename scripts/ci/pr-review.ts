#!/usr/bin/env bun
/**
 * The pull-request review job's script (ADR 0092, ADR 0107). Run by the central workflow
 * `run-pr-review.yml` in `nemarDatasets/.github`, after the workflow has claimed the review. This
 * step's environment holds a federated Anthropic identity and the one-shot callback token, and no
 * GitHub credential. The repository was fetched by an earlier step, whose read-only token stays in
 * the clone's git config for the lazy blob reads this script's git calls make; this script never
 * reads it, prints it or sends it. Those git calls are started without the callback token, without
 * any ANTHROPIC_ variable and without any ACTIONS_ID_TOKEN_REQUEST_ variable (the request for an
 * identity token, which the runner puts in every step of the job): `childEnv` in
 * `pr-review-evidence.ts` builds their environment.
 *
 *   bun run scripts/ci/pr-review.ts review \
 *     --repo-dir DIR --base SHA --head SHA --fetched-head SHA --pr-json FILE \
 *     --review-id N --dataset nmNNNNNN --environment production|dev
 *
 * The callback token comes from the environment (PR_REVIEW_CALLBACK_TOKEN), never argv. A job that
 * fails before this script can report is reported by the workflow's own curl step, which needs
 * nothing installed.
 *
 * **The order of a review.** The facts first, before any model is asked: the naming rule on the
 * title and on a changed dataset name, and whether there is a description at all. When the naming
 * rule fails the pull request, or cannot check a changed name, the review ends there, at the
 * `facts` stage, and no model is asked. Otherwise the screen (stage 1), which sees the pull
 * request's text, the list of changed files and the platform's facts, and may stop only spam. To
 * state those facts the listing reads one file's content, `dataset_description.json` (the version
 * and the name, before and after), and shows the screen the facts and never the file. A stop ends
 * the run with a screen report, and no other file's content is read. Otherwise the content is read
 * and the review (stage 2) answers. Both stages run at max effort and stream, each under
 * {@link STAGE_BUDGETS}; a refusal or a truncation at either is no verdict, which the Worker
 * publishes as a check that does not pass and needs a person.
 *
 * **Nothing in the dispatch is trusted for a decision.** The pull request is re-read from the API
 * (`--pr-json`): it must still be open, still target `main`, and still be at `--head`, and the
 * ref the workflow fetched must be that same commit. The callback goes to an origin chosen from a
 * fixed table by the environment's NAME, so a payload cannot steer the report to a host of its
 * choosing.
 *
 * **The public log carries no value.** `nemarDatasets/.github` is public, so this prints a review
 * id and a fixed word, never a dataset's content, a pull request's text, or the model's output.
 *
 * Exits 0 when the callback was delivered (whatever it said), 1 when it could not be, and 2 for
 * bad arguments or a missing callback token.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { namingProblemOf } from "../../shared/naming-rule";
import {
  type PrReviewReport,
  PrReviewReportError,
  type ReviewEvidence,
  type RunError,
  type StageTokens,
} from "../../shared/pr-review";
import { tidy } from "../../shared/untrusted-text";
import {
  EvidenceError,
  type GitFacts,
  type Listing,
  SHA40,
  type TextFacts,
  buildEvidence,
  buildListingEvidence,
  gatherContent,
  gatherListing,
} from "./pr-review-evidence";
import {
  MAX_BODY_CHARS,
  REVIEW_MODEL,
  REVIEW_OUTPUT_SCHEMA,
  SCREEN_MODEL,
  SCREEN_OUTPUT_SCHEMA,
  assembleFactsReport,
  assembleReport,
  buildReviewMessages,
  buildScreenMessages,
  platformFindings,
  readScreenAnswer,
} from "./pr-review-prompt";

/** The API origin for each environment NAME. A payload never supplies a URL. */
export const CALLBACK_ORIGINS = {
  production: "https://api.nemar.org",
  dev: "https://api-test.nemar.org",
} as const;
export type Environment = keyof typeof CALLBACK_ORIGINS;

const DATASET_ID = /^(nm|xx|on)\d{6}$/;

/** A change this large is not reviewed by a model; a person has to look. */
export const MAX_REVIEWABLE_FILES = 500_000;

/** The two model calls of a review. */
export const STAGES = ["screen", "review"] as const;
export type Stage = (typeof STAGES)[number];

/**
 * What one stage may spend. `maxTokens` is the output budget, which the model's thinking counts
 * toward; `timeoutMs` bounds each attempt's wait for the response to begin (the SDK's own timeout);
 * `deadlineMs` bounds the whole stage, every attempt and the streamed answer together, through an
 * abort signal, because a stream that has begun is not bounded by the SDK's timeout at all.
 * `maxRetries` is the SDK's retry count for a failure it may retry (a 5xx, a 429, a lost connection).
 */
export interface StageBudget {
  model: string;
  maxTokens: number;
  timeoutMs: number;
  deadlineMs: number;
  maxRetries: number;
}

/**
 * The review model's output ceiling: the most a single answer can be (128K tokens on
 * `claude-sonnet-5-5`), thinking included. At effort `max` the model's thinking, not its small JSON
 * answer, is what fills the budget: on 2026-10-20 seven of nine reviews on real pull requests hit
 * 32,000 tokens after about five minutes (some 100 tokens a second) and ended `model_truncated`.
 * The review is given all the room there is; a pull request that still does not fit is too large
 * for one review, and its check tells the author to split it.
 */
export const REVIEW_MAX_TOKENS = 128_000;

/**
 * Each stage's {@link StageBudget}. The workflow test keeps the worst case, both deadlines, the
 * evidence budget and the callback's retries, inside the job's `timeout-minutes`. The review's
 * deadline lets the model decode as slowly as about 71 tokens a second and still reach its ceiling
 * (128,000 tokens in 30 minutes); the one rate observed was about 100, so 128,000 tokens take about
 * 21 minutes. A stage that runs out of time first ends `model_unavailable`, which names no size and
 * advises no split, so a test keeps the deadline well past the ceiling.
 */
export const STAGE_BUDGETS = {
  screen: {
    model: SCREEN_MODEL,
    maxTokens: 32_000,
    timeoutMs: 90_000,
    deadlineMs: 4 * 60_000,
    maxRetries: 1,
  },
  review: {
    model: REVIEW_MODEL,
    maxTokens: REVIEW_MAX_TOKENS,
    timeoutMs: 120_000,
    deadlineMs: 30 * 60_000,
    maxRetries: 1,
  },
} as const satisfies Record<Stage, StageBudget>;

/**
 * How long past its deadline a stage waits for the SDK to give up by itself. The deadline is an
 * abort signal, which the SDK honors for the request and the stream but not for workload identity
 * federation's token exchange, a request it makes with no signal at all. This is the backstop for
 * that part, so a stage never outlives its deadline by more than this.
 */
export const DEADLINE_GRACE_MS = 5_000;

const STAGE_SCHEMAS: Record<Stage, Record<string, unknown>> = {
  screen: SCREEN_OUTPUT_SCHEMA,
  review: REVIEW_OUTPUT_SCHEMA,
};

/** What a test may shorten: a stage's waits and retries, and the backstop's grace. */
export type StageBudgetOverride = Partial<
  Pick<StageBudget, "timeoutMs" | "deadlineMs" | "maxRetries">
> & { graceMs?: number };

/**
 * Budgets a test shortens, merged over {@link STAGE_BUDGETS} where a stage reads its own, so a test
 * of a stall runs the same code with smaller numbers. Production never sets one.
 */
let budgetOverrides: Partial<Record<Stage, StageBudgetOverride>> = {};

export function __setStageBudgetsForTests(
  overrides: Partial<Record<Stage, StageBudgetOverride>> | null,
): void {
  budgetOverrides = overrides ?? {};
}

/** How the callback is retried: the attempts, and the timeout of each. See {@link postCallback}. */
export const CALLBACK_ATTEMPTS = 4;
export const CALLBACK_TIMEOUT_MS = 60_000;

export type ReviewResult =
  | { outcome: "reported"; report: PrReviewReport }
  | { outcome: "error"; error: RunError; diag?: string };

/**
 * A failure of the run, as its fixed word. `marker` is a second fixed word, for the public log only,
 * where the word alone does not say which cause it was (a dropped stream, a backstop).
 */
class RunFailure extends Error {
  readonly error: RunError;
  readonly marker: string | null;
  constructor(error: RunError, marker: string | null = null) {
    super(error);
    this.error = error;
    this.marker = marker;
  }
}

export interface ReviewArgs {
  repoDir: string;
  base: string;
  head: string;
  fetchedHead: string;
  prJson: string;
}

/**
 * Whether the API refused the call because the account's spending allowance is used up: its billing
 * error (a 402, or that error type on any status), or the 400 a usage limit has been answered with,
 * known only by its words. The message is matched here and never forwarded.
 */
export function isSpendLimit(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  if (e.type === "billing_error" || e.status === 402) return true;
  return e.status === 400 && /usage limits?|credit balance|spend(ing)? limits?/i.test(e.message);
}

/** Map anything that went wrong to a fixed word. The error's text is never forwarded. */
export function mapError(e: unknown): RunError {
  if (e instanceof RunFailure) return e.error;
  if (e instanceof EvidenceError) return "evidence_unavailable";
  // Our own evidence block failing the parser is a bug on this side, not the model's doing.
  if (e instanceof PrReviewReportError) {
    return e.code === "bad_evidence" ? "report_invalid" : "model_invalid";
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return "auth_failed";
  }
  // The SDK's federation failures (an identity token it cannot read, an exchange the rule
  // rejects) are plain AnthropicErrors named "Error", not API errors: there is no HTTP response of
  // the messages API yet. The same class after the response began is a dropped stream, which
  // callStage turns into model_unavailable before it gets here.
  if (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)) {
    return "auth_failed";
  }
  // A spent allowance is the service being unavailable to this job, not a malformed request.
  if (isSpendLimit(e)) return "model_unavailable";
  if (e instanceof Anthropic.BadRequestError) return "model_invalid";
  // A stage that ran past its deadline is aborted by its signal, which the SDK reports as a user
  // abort: the model did not finish in time, which is the same answer as an unavailable one.
  if (e instanceof Anthropic.APIError) return "model_unavailable";
  return "workflow_failed";
}

/**
 * Why a run failed, in words that are safe in a public log: class names the SDK and this module
 * define, HTTP status numbers, parser codes, the fixed strings of {@link EvidenceError}, and the
 * fixed markers of this module. Never the text of an error that could carry pull request content.
 */
export function describeError(e: unknown): string {
  const cls = e instanceof Error ? e.constructor.name : typeof e;
  if (e instanceof Anthropic.APIError) {
    return `${cls} status=${e.status ?? "none"}${isSpendLimit(e) ? " spend_limit" : ""}`;
  }
  if (e instanceof PrReviewReportError) return `${cls} code=${e.code}`;
  if (e instanceof EvidenceError) return `${cls}: ${e.message}`;
  if (e instanceof RunFailure) return `${cls} ${e.error}${e.marker ? ` ${e.marker}` : ""}`;
  return cls;
}

/** What one stage's call came to, for an observer: the calibration's timing and token table. */
export interface StageObservation {
  stage: Stage;
  model: string;
  /** Milliseconds from the request to the end of the answer, or to the failure. */
  ms: number;
  /** The tokens the API said the call used; null when no answer arrived. */
  usage: StageTokens | null;
  /** How the call ended: `ok`, or the run error it became. */
  result: "ok" | RunError;
}

export type StageObserver = (o: StageObservation) => void;

/**
 * What the content pass came to, for an observer: the calibration's evidence columns. Numbers and
 * booleans only, counted by the platform, so printing them quotes nothing of the pull request; the
 * summary's first path with a removal is the one fact about it that is text, and it is left out.
 *
 *  - `files` changed in all, `wanted` of them in the areas the review reads (every path shape
 *    listed and the files of those not listed), `cosmetic` proven cosmetic, `read` counted as read
 *    (`files_read`), `unread` the modified and removed ones not covered (`readIncomplete` is
 *    `unread > 0`), and `patches` diffs shown; `listCut`, `readIncomplete` and `truncated` as the
 *    evidence says (`truncated` is either of the other two).
 *  - The change summary: whether it was `summaryAbandoned`, the files it `summarized`, `refused`
 *    and `accounted` for, the `classes` it showed and the ones it `cut`, the characters of its
 *    block (`summaryChars`), its loss facts, and how many `platformFindings` they make.
 *  - How long each evidence pass took, whole, in milliseconds: `listingMs` and `contentMs` (the
 *    content pass includes its one batched prefetch of the blobs, which on a blob-less clone is the
 *    fetch).
 */
export interface EvidenceStats {
  files: number;
  wanted: number;
  cosmetic: number;
  read: number;
  unread: number;
  patches: number;
  listCut: boolean;
  readIncomplete: boolean;
  truncated: boolean;
  summaryAbandoned: boolean;
  summarized: number;
  refused: number;
  accounted: number;
  classes: number;
  cut: number;
  summaryChars: number;
  rowsRemoved: number;
  rowsRemovedFiles: number;
  rowsRelocated: number;
  columnsRemoved: number;
  keysRemoved: number;
  keysRemovedFiles: number;
  keysMoved: number;
  valuesEmptied: number;
  platformFindings: number;
  listingMs: number;
  contentMs: number;
}

export type EvidenceObserver = (s: EvidenceStats) => void;

/** How long the two evidence passes took, in whole milliseconds. */
export interface PassTimes {
  listingMs: number;
  contentMs: number;
}

/** The {@link EvidenceStats} of a content pass, the evidence built from it, and the passes' times. */
export function evidenceStats(
  facts: GitFacts,
  evidence: ReviewEvidence,
  ms: PassTimes,
): EvidenceStats {
  const { summary } = facts;
  const loss = summary.loss;
  return {
    files: evidence.files_changed,
    wanted: facts.groups.reduce((n, g) => n + g.files, 0) + facts.groupsOmittedFiles,
    cosmetic: facts.cosmeticOnlyFiles,
    read: evidence.files_read,
    unread: facts.unreadFiles,
    patches: facts.patches.length,
    listCut: facts.listCut,
    readIncomplete: facts.readIncomplete,
    truncated: evidence.truncated,
    summaryAbandoned: summary.abandoned,
    summarized: summary.facts.files_summarized,
    refused: summary.facts.files_not_summarized,
    accounted: summary.facts.files_accounted_for,
    classes: summary.facts.classes_shown,
    cut: summary.facts.classes_cut,
    summaryChars: summary.text.length,
    rowsRemoved: loss.rowsRemoved,
    rowsRemovedFiles: loss.rowsRemovedFiles,
    rowsRelocated: loss.rowsRelocated,
    columnsRemoved: loss.columnsRemoved,
    keysRemoved: loss.keysRemoved,
    keysRemovedFiles: loss.keysRemovedFiles,
    keysMoved: loss.keysMoved,
    valuesEmptied: loss.valuesEmptied,
    platformFindings: platformFindings(summary).length,
    listingMs: ms.listingMs,
    contentMs: ms.contentMs,
  };
}

/** What `pass` returns, and how long it took in whole milliseconds. */
export function timed<T>(pass: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = pass();
  return { value, ms: Math.round(performance.now() - started) };
}

/** What a stage answered: the model's JSON, and what it cost. */
export interface StageAnswer {
  output: unknown;
  usage: StageTokens;
}

/**
 * The client a review run asks both stages with. Given no credentials it resolves workload identity
 * federation from the environment (ANTHROPIC_FEDERATION_RULE_ID, _ORGANIZATION_ID,
 * _SERVICE_ACCOUNT_ID, _WORKSPACE_ID and ANTHROPIC_IDENTITY_TOKEN_FILE), exchanges the job's OIDC
 * token once, and keeps the access token for the second stage, so one run makes one exchange.
 * Each stage's waits and retries are set on its own request.
 */
export function newModelClient(): Anthropic {
  return new Anthropic();
}

/** A promise that fails the stage after `ms` whatever the SDK is doing, and a way to stop it. */
function deadlineBackstop(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RunFailure("model_unavailable", "deadline_backstop")), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * One call to one stage's model: max effort, a schema-constrained answer, streamed, no tools. The
 * model can read the prompt and write a JSON object; it cannot do anything else. Only an answer
 * that ended its turn is read. A refusal and a truncation are run errors (`model_refused`,
 * `model_truncated`): no verdict, never a pass. `client` is the run's ({@link newModelClient}); a
 * call without one makes its own.
 */
export async function callStage(
  stage: Stage,
  system: string,
  user: string,
  observe?: StageObserver,
  client?: Anthropic,
): Promise<StageAnswer> {
  const override = budgetOverrides[stage] ?? {};
  const budget: StageBudget = { ...STAGE_BUDGETS[stage], ...override };
  const started = performance.now();
  let usage: StageTokens | null = null;
  // Set when the response began. After that, a failure that is not an API error is the stream
  // breaking off (a connection reset, or a body that ended before the message did); before it, the
  // same class of failure is the sign-in, which mapError reads as an auth failure.
  let connected = false;
  const backstop = deadlineBackstop(budget.deadlineMs + (override.graceMs ?? DEADLINE_GRACE_MS));
  const report = (result: "ok" | RunError) =>
    observe?.({
      stage,
      model: budget.model,
      ms: Math.round(performance.now() - started),
      usage,
      result,
    });
  try {
    const stream = (client ?? newModelClient()).messages.stream(
      {
        model: budget.model,
        max_tokens: budget.maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: {
          // Both stages think as long as they need to; thinking cannot be turned off at max.
          effort: "max",
          format: { type: "json_schema", schema: STAGE_SCHEMAS[stage] },
        },
      },
      {
        timeout: budget.timeoutMs,
        maxRetries: budget.maxRetries,
        signal: AbortSignal.timeout(budget.deadlineMs),
      },
    );
    stream.on("connect", () => {
      connected = true;
    });
    let res: Awaited<ReturnType<typeof stream.finalMessage>>;
    try {
      res = await Promise.race([stream.finalMessage(), backstop.promise]);
    } catch (e) {
      // The backstop won: stop whatever the SDK is still waiting for.
      if (e instanceof RunFailure) stream.abort();
      throw e;
    }
    usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
    switch (res.stop_reason) {
      case "end_turn":
        break;
      case "refusal":
        throw new RunFailure("model_refused");
      case "max_tokens":
      case "model_context_window_exceeded":
        throw new RunFailure("model_truncated");
      default:
        // A tool call, a paused turn, a stop sequence, or a reason newer than this script: none
        // is an answer that finished, and the JSON parser is not the place to find that out.
        throw new RunFailure("model_invalid", "unexpected_stop");
    }
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new RunFailure("model_invalid");
    let output: unknown;
    try {
      output = JSON.parse(text.text);
    } catch {
      throw new RunFailure("model_invalid");
    }
    report("ok");
    return { output, usage };
  } catch (e) {
    const failure =
      connected && e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)
        ? new RunFailure("model_unavailable", "stream_dropped")
        : e;
    report(mapError(failure));
    throw failure;
  } finally {
    backstop.cancel();
  }
}

interface PullRequestJson {
  state?: unknown;
  title?: unknown;
  body?: unknown;
  base?: { ref?: unknown; repo?: { full_name?: unknown } };
  head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
}

/**
 * The facts decided before any model is asked (ADR 0107), from the pull request as the API returns
 * it and from the listing: whether the description is empty, how the title breaks the naming rule,
 * and how the dataset's name breaks it when the pull request changes the name. The rule is the
 * shared one the CLI and the Worker use; nothing here is a judgment.
 *
 * A pull request that changes `dataset_description.json` and leaves no readable name in it has no
 * name to ask the rule about, and that is not a clean name: the fact is `unchecked`, which keeps
 * the verdict from passing and sends a person to look.
 *
 * The description is judged as the models read it, after {@link tidy}: a body of zero-width spaces
 * and soft hyphens is blank to them, so it is empty here, though `trim` leaves it. The whole of it is
 * judged, not the cut the models are given (tidy would end a long run of blanks with its `[cut]`
 * mark, and a description of nothing but blanks is empty however long it is). It is cut when the
 * tidied text is longer than {@link MAX_BODY_CHARS}, the cap the prompt cuts at, so the fact is true
 * exactly when a model was shown the `[cut]` mark.
 *
 * Throws the run error `evidence_unavailable` for a title that is not a string.
 */
export function textFactsOf(pr: { title?: unknown; body?: unknown }, listing: Listing): TextFacts {
  // A title that is not text cannot be asked about the rule, and reading it as empty would call it
  // clean: a pass for text nobody read. The Worker's intake refuses such a delivery as malformed;
  // the job fails closed the same way, with the run error for evidence it could not read.
  if (typeof pr.title !== "string") throw new RunFailure("evidence_unavailable", "title_not_text");
  const changedName =
    listing.nameAfter !== null && listing.nameAfter !== listing.nameBefore
      ? listing.nameAfter
      : null;
  const body = tidy(pr.body, Number.POSITIVE_INFINITY);
  return {
    descriptionEmpty: body.trim() === "",
    descriptionCut: body.length > MAX_BODY_CHARS,
    titleProblem: namingProblemOf(pr.title),
    nameProblem:
      changedName !== null
        ? namingProblemOf(changedName)
        : listing.nameUnreadable
          ? "unchecked"
          : null,
  };
}

/** What the stage flow needs about a pull request: where its commits are, and its own text. */
export interface PullRequestUnderReview {
  repoDir: string;
  /** The tip of `main` the pull request is compared against (through the merge base). */
  base: string;
  head: string;
  /** The pull request as the API returns it: its title and its description. */
  pr: { title?: unknown; body?: unknown };
  fromFork: boolean;
}

/**
 * The stage flow, for a pull request whose commits and text are known: the facts first, and the
 * screen and the review only when the naming rule left the pull request standing, the review only
 * when the screen let it through. Throws what it meets; {@link
 * runReview} turns that into a fixed word. The calibration runs exactly this, on pull requests that
 * are no longer open, which is why the dispatch's own checks are not part of it.
 *
 * `observe` is told about each model call; `observeEvidence` is told once what the content pass
 * came to ({@link EvidenceStats}), after the content was read and before the review is asked, and
 * not at all when the review ended at the facts or at the screen, which read no content. Both are
 * for the calibration, and neither may throw: a throw ends the run like any error.
 */
export async function reviewPullRequest(
  input: PullRequestUnderReview,
  observe?: StageObserver,
  observeEvidence?: EvidenceObserver,
): Promise<PrReviewReport> {
  const { repoDir, base, head, pr, fromFork } = input;
  const text = { title: pr.title, body: pr.body };

  // What the screen is shown, with no file's content read but dataset_description.json's. Each pass
  // is timed whole, for the evidence observer only.
  const { value: listing, ms: listingMs } = timed(() => gatherListing(repoDir, base, head));
  if (listing.changes.length > MAX_REVIEWABLE_FILES) throw new RunFailure("too_large");
  // The facts, before any model call.
  const facts = textFactsOf(pr, listing);
  // A title or a dataset name the naming rule refuses, or a changed name nobody could read, decides
  // the review: it fails, or a person must look. The rule needs no model, and the screen and the
  // review would be paid for an answer the facts overrule, so neither is asked.
  if (facts.titleProblem !== null || facts.nameProblem !== null) {
    return assembleFactsReport(buildListingEvidence(listing, facts));
  }

  const screenMessages = buildScreenMessages({
    listing,
    pr: text,
    fromFork,
    nonce: randomUUID().replaceAll("-", ""),
  });
  const client = newModelClient();
  const screen = await callStage(
    "screen",
    screenMessages.system,
    screenMessages.user,
    observe,
    client,
  );
  if (readScreenAnswer(screen.output).decision === "reject") {
    return assembleReport(screen.output, null, buildListingEvidence(listing, facts), {
      screen: screen.usage,
      review: null,
    });
  }

  const { value: content, ms: contentMs } = timed(() => gatherContent(repoDir, listing));
  const all = { ...listing, ...content };
  const evidence = buildEvidence(all, facts);
  // The removals the change summary found and nothing in the pull request keeps: the platform's
  // own findings, decided from git before the review is asked, which can only lower its answer.
  const platform = platformFindings(all.summary);
  observeEvidence?.(evidenceStats(all, evidence, { listingMs, contentMs }));
  const reviewMessages = buildReviewMessages({
    facts: all,
    evidence,
    pr: text,
    fromFork,
    nonce: randomUUID().replaceAll("-", ""),
  });
  const review = await callStage(
    "review",
    reviewMessages.system,
    reviewMessages.user,
    observe,
    client,
  );
  return assembleReport(
    screen.output,
    review.output,
    evidence,
    { screen: screen.usage, review: review.usage },
    platform,
  );
}

/** Review one pull request. Never throws: every failure is a fixed word. */
export async function runReview(args: ReviewArgs, observe?: StageObserver): Promise<ReviewResult> {
  try {
    if (!SHA40.test(args.base) || !SHA40.test(args.head) || !SHA40.test(args.fetchedHead)) {
      throw new RunFailure("evidence_unavailable");
    }
    let pr: PullRequestJson;
    try {
      pr = JSON.parse(readFileSync(args.prJson, "utf8")) as PullRequestJson;
    } catch {
      throw new RunFailure("evidence_unavailable");
    }
    // The pull request moved on, closed, or retargeted since it was dispatched: the review is
    // for a commit nobody will merge.
    if (
      pr.state !== "open" ||
      pr.base?.ref !== "main" ||
      pr.head?.sha !== args.head ||
      args.fetchedHead !== args.head
    ) {
      throw new RunFailure("stale_head");
    }
    const report = await reviewPullRequest(
      { repoDir: args.repoDir, base: args.base, head: args.head, pr, fromFork: isFromFork(pr) },
      observe,
    );
    return { outcome: "reported", report };
  } catch (e) {
    return { outcome: "error", error: mapError(e), diag: describeError(e) };
  }
}

/** Whether the pull request's head lives in another repository; a deleted fork's head reads as one. */
export function isFromFork(pr: {
  base?: { repo?: { full_name?: unknown } };
  head?: { repo?: { full_name?: unknown } | null };
}): boolean {
  return (
    typeof pr.head?.repo?.full_name !== "string" ||
    typeof pr.base?.repo?.full_name !== "string" ||
    pr.head.repo.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase()
  );
}

/** The pause before each retry of the callback: 2, 4, then 8 seconds. */
export function callbackBackoffMs(attempt: number): number {
  return 2 ** attempt * 1000;
}

/** POST the result, retrying a network failure or a 5xx. A 4xx will not improve and is not retried. */
export async function postCallback(
  origin: string,
  token: string,
  body: Record<string, unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ delivered: boolean; status: number | null }> {
  let status: number | null = null;
  for (let attempt = 0; attempt < CALLBACK_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(callbackBackoffMs(attempt));
    try {
      const res = await fetch(`${origin}/webhooks/pr-review-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
        body: JSON.stringify(body),
        // The Worker publishes the check and the comment before it answers.
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      status = res.status;
      if (res.ok) return { delivered: true, status };
      if (res.status < 500) return { delivered: false, status };
    } catch {
      status = null;
    }
  }
  return { delivered: false, status };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function need(argv: string[], name: string): string {
  const v = flag(argv, name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

/**
 * Run the script. `origins` is the callback table; production code never passes it, and a test
 * points it at a server of its own, which is the only way to run this end to end without sending
 * a report to a real Worker.
 */
export async function main(
  argv: string[],
  origins: Record<Environment, string> = CALLBACK_ORIGINS,
): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd !== "review") {
    console.error("usage: pr-review.ts review ...");
    return 2;
  }
  const dataset = need(rest, "dataset");
  const reviewId = Number(need(rest, "review-id"));
  const environment = need(rest, "environment");
  const token = process.env.PR_REVIEW_CALLBACK_TOKEN;
  if (!DATASET_ID.test(dataset) || !Number.isSafeInteger(reviewId) || reviewId < 1) {
    console.error("bad --dataset or --review-id");
    return 2;
  }
  if (environment !== "production" && environment !== "dev") {
    console.error("bad --environment");
    return 2;
  }
  if (!token) {
    console.error("PR_REVIEW_CALLBACK_TOKEN is unset");
    return 2;
  }

  const result: ReviewResult = await runReview({
    repoDir: need(rest, "repo-dir"),
    base: need(rest, "base"),
    head: need(rest, "head"),
    fetchedHead: need(rest, "fetched-head"),
    prJson: need(rest, "pr-json"),
  });

  const body: Record<string, unknown> = {
    review_id: reviewId,
    dataset_id: dataset,
    outcome: result.outcome,
    ...(result.outcome === "reported" ? { report: result.report } : { error: result.error }),
  };
  const sent = await postCallback(origins[environment], token, body);
  // A review id and fixed words only: this log is public. A report's stage is a fixed word too.
  const stage =
    result.outcome === "reported" && result.report.v === 2 ? ` at ${result.report.stage}` : "";
  console.log(
    `review ${reviewId}: ${result.outcome}${stage}${result.outcome === "error" ? ` (${result.error}${result.diag ? `; ${result.diag}` : ""})` : ""}; callback ${
      sent.delivered ? "delivered" : `not delivered (${sent.status ?? "no response"})`
    }`,
  );
  return sent.delivered ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      // A fixed word: the text of an unexpected error is not ours to put in a public log.
      console.error(`pr-review failed: ${e instanceof Error ? e.constructor.name : "unknown"}`);
      process.exit(1);
    });
}
