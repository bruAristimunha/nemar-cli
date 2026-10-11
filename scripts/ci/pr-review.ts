#!/usr/bin/env bun
/**
 * The pull-request review job's script (ADR 0092). Run by the central workflow
 * `run-pr-review.yml` in `nemarDatasets/.github`, after the workflow has claimed the review. This
 * step's environment holds a federated Anthropic identity and the one-shot callback token, and no
 * GitHub credential. The repository was fetched by an earlier step, whose read-only token stays in
 * the clone's git config for the lazy blob reads this script's git calls make; this script never
 * reads it, prints it or sends it.
 *
 *   bun run scripts/ci/pr-review.ts review \
 *     --repo-dir DIR --base SHA --head SHA --fetched-head SHA --pr-json FILE \
 *     --review-id N --dataset nmNNNNNN --environment production|dev
 *
 * The callback token comes from the environment (PR_REVIEW_CALLBACK_TOKEN), never argv. A job that
 * fails before this script can report is reported by the workflow's own curl step, which needs
 * nothing installed.
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
import { type PrReviewReport, PrReviewReportError, type RunError } from "../../shared/pr-review";
import { EvidenceError, SHA40, buildEvidence, gatherGitFacts } from "./pr-review-evidence";
import {
  REVIEW_MODEL,
  REVIEW_OUTPUT_SCHEMA,
  assembleReport,
  buildReviewMessages,
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
/** Output budget. Adaptive thinking at high effort counts toward it. */
const MAX_TOKENS = 16_000;

export type ReviewResult =
  | { outcome: "reported"; report: PrReviewReport }
  | { outcome: "error"; error: RunError; diag?: string };

class RunFailure extends Error {
  readonly error: RunError;
  constructor(error: RunError) {
    super(error);
    this.error = error;
  }
}

export interface ReviewArgs {
  repoDir: string;
  base: string;
  head: string;
  fetchedHead: string;
  prJson: string;
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
  // the messages API yet.
  if (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)) {
    return "auth_failed";
  }
  if (e instanceof Anthropic.BadRequestError) return "model_invalid";
  if (e instanceof Anthropic.APIError) return "model_unavailable";
  return "workflow_failed";
}

/**
 * Why a run failed, in words that are safe in a public log: class names the SDK and this module
 * define, HTTP status numbers, parser codes, and the fixed strings of {@link EvidenceError}. Never
 * the text of an error that could carry pull request content.
 */
export function describeError(e: unknown): string {
  const cls = e instanceof Error ? e.constructor.name : typeof e;
  if (e instanceof Anthropic.APIError) return `${cls} status=${e.status ?? "none"}`;
  if (e instanceof PrReviewReportError) return `${cls} code=${e.code}`;
  if (e instanceof EvidenceError) return `${cls}: ${e.message}`;
  if (e instanceof RunFailure) return `${cls} ${e.error}`;
  return cls;
}

/**
 * One call to the model: Haiku 5.5 at high effort, no tools, a schema-constrained answer. The
 * model can read the prompt and write a JSON object; it cannot do anything else.
 */
export async function callReviewModel(system: string, user: string): Promise<unknown> {
  // A client given no credentials resolves workload identity federation from the environment
  // (ANTHROPIC_FEDERATION_RULE_ID, _ORGANIZATION_ID, _SERVICE_ACCOUNT_ID, _WORKSPACE_ID and
  // ANTHROPIC_IDENTITY_TOKEN_FILE), exchanges the job's OIDC token, and refreshes it.
  const client = new Anthropic({ maxRetries: 2, timeout: 180_000 });
  const res = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: REVIEW_OUTPUT_SCHEMA },
    },
  });
  if (res.stop_reason === "refusal") throw new RunFailure("model_refused");
  if (res.stop_reason === "max_tokens") throw new RunFailure("model_truncated");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new RunFailure("model_invalid");
  try {
    return JSON.parse(text.text);
  } catch {
    throw new RunFailure("model_invalid");
  }
}

interface PullRequestJson {
  state?: unknown;
  title?: unknown;
  body?: unknown;
  base?: { ref?: unknown; repo?: { full_name?: unknown } };
  head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
}

/** Review one pull request. Never throws: every failure is a fixed word. */
export async function runReview(args: ReviewArgs): Promise<ReviewResult> {
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
    const fromFork =
      typeof pr.head?.repo?.full_name !== "string" ||
      typeof pr.base?.repo?.full_name !== "string" ||
      pr.head.repo.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase();

    const facts = gatherGitFacts(args.repoDir, args.base, args.head);
    if (facts.changes.length > MAX_REVIEWABLE_FILES) throw new RunFailure("too_large");
    const evidence = buildEvidence(facts);
    const { system, user } = buildReviewMessages({
      facts,
      evidence,
      pr: { title: pr.title, body: pr.body },
      fromFork,
      nonce: randomUUID().replaceAll("-", ""),
    });
    const modelOutput = await callReviewModel(system, user);
    return { outcome: "reported", report: assembleReport(modelOutput, evidence) };
  } catch (e) {
    return { outcome: "error", error: mapError(e), diag: describeError(e) };
  }
}

/** POST the result, retrying a network failure or a 5xx. A 4xx will not improve and is not retried. */
export async function postCallback(
  origin: string,
  token: string,
  body: Record<string, unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ delivered: boolean; status: number | null }> {
  let status: number | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);
    try {
      const res = await fetch(`${origin}/webhooks/pr-review-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
        body: JSON.stringify(body),
        // The Worker publishes the check and the comment before it answers.
        signal: AbortSignal.timeout(60_000),
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
  // A review id and fixed words only: this log is public.
  console.log(
    `review ${reviewId}: ${result.outcome}${result.outcome === "error" ? ` (${result.error}${result.diag ? `; ${result.diag}` : ""})` : ""}; callback ${
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
