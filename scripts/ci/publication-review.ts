#!/usr/bin/env bun
/**
 * The publication review job's script (ADR 0102). Run by the central workflow
 * `run-publication-review.yml` in `nemarDatasets/.github`, after the workflow has claimed the
 * review. This step's environment holds a federated Anthropic identity and the one-shot callback
 * token, and no GitHub credential, and neither does the clone: an earlier step fetched the
 * repository, and with it the blobs this script reads, giving its read-only token to each git
 * command through that command's own environment and writing it nowhere. This script's git calls
 * need nothing from the network and, with lazy fetching off, cannot ask for it, and no git child
 * process inherits any token.
 *
 *   bun run scripts/ci/publication-review.ts review \
 *     --repo-dir DIR --head SHA --fetched-head SHA --tags-file FILE --bids-runs-file FILE \
 *     --review-id N --request-id N --dataset nmNNNNNN --anonymous true|false \
 *     --environment production|dev
 *
 * The callback token comes from the environment (PUBLICATION_REVIEW_CALLBACK_TOKEN), never argv. A
 * job that fails before this script can report is reported by the workflow's own curl step, which
 * needs nothing installed.
 *
 * `calibrate` is the offline calibration run from an operator's machine
 * (`publication-review-calibrate.ts`): the same pre-send, prompt, model call and report assembly
 * over a corpus of published datasets, and it posts nothing.
 *
 * **Nothing in the dispatch is trusted for a decision.** The ref the workflow fetched is GitHub's
 * own record of `main`, and it must be the commit the review was dispatched for before a model is
 * called (`stale_head` otherwise). The callback goes to an origin chosen from a fixed table by the
 * environment's NAME, so a payload cannot steer the report to a host of its choosing. The report
 * echoes the head and the release kind, and the Worker refuses one that does not match its row.
 *
 * **The model sees only cleared text.** Every document goes through `publication-review-presend.ts`
 * and the prompt builder accepts nothing else (ADR 0102, section 2).
 *
 * **The public log carries no value.** `nemarDatasets/.github` is public, so this prints a review
 * id, a request id and a fixed word, never a dataset's text, a finding, a count of findings, the
 * model's output or a token. Every error is reported as a closed word, and only the words a job
 * may post: the Worker's own (`dispatch_failed`, `dispatch_unconfigured`, `review_disabled`) are
 * not in this script's vocabulary.
 *
 * Exits 0 when the callback was delivered (whatever it said), 1 when it could not be, and 2 for
 * bad arguments or a missing callback token.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  type PublicationReviewReport,
  PublicationReviewReportError,
  type PublicationRunError,
  type ReviewerModel,
  type WORKER_ONLY_RUN_ERRORS,
} from "../../shared/publication-review";
import {
  PublicationEvidenceError,
  SHA40,
  evidenceFromDocuments,
  readRootDocuments,
  readTree,
  structuralSummary,
} from "./publication-review-evidence";
import {
  PUBLICATION_OUTPUT_SCHEMA,
  PUBLICATION_REVIEW_MODEL,
  assemblePublicationReport,
  buildPublicationReviewMessages,
} from "./publication-review-prompt";

// RunFailure, mapError, describeError, the callback poster, flag and need, and CALLBACK_ORIGINS
// below are copies of the ones in pr-review.ts, on purpose: the live pull-request review stays
// untouched.

/** The API origin for each environment NAME. A payload never supplies a URL. */
export const CALLBACK_ORIGINS = {
  production: "https://api.nemar.org",
  dev: "https://api-test.nemar.org",
} as const;
export type Environment = keyof typeof CALLBACK_ORIGINS;

const DATASET_ID = /^(nm|xx|on)\d{6}$/;

/** Output budget. Adaptive thinking at high effort counts toward it. */
export const MAX_TOKENS = 16_000;

/** The run errors this script may post: everything the Worker does not write itself. */
export type JobRunError = Exclude<PublicationRunError, (typeof WORKER_ONLY_RUN_ERRORS)[number]>;

export type PublicationReviewResult =
  | { outcome: "reported"; report: PublicationReviewReport }
  | { outcome: "error"; error: JobRunError; diag?: string };

class RunFailure extends Error {
  readonly error: JobRunError;
  constructor(error: JobRunError) {
    super(error);
    this.error = error;
  }
}

export interface ReviewArgs {
  repoDir: string;
  /** The commit the review was dispatched for. */
  head: string;
  /** The commit the workflow fetched as `main`: GitHub's own record. */
  fetchedHead: string;
  /** `git ls-remote --tags` output, one line per ref. */
  tagsFile: string;
  /** The BIDS validation workflow's runs at `head`, or `{"unavailable":true}`. */
  bidsRunsFile: string;
  anonymous: boolean;
}

/** Map anything that went wrong to a fixed word. The error's text is never forwarded. */
export function mapError(e: unknown): JobRunError {
  if (e instanceof RunFailure) return e.error;
  if (e instanceof PublicationEvidenceError) return "evidence_unavailable";
  // Our own evidence block failing the parser is a bug on this side, not the model's doing.
  if (e instanceof PublicationReviewReportError) {
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
 * define, HTTP status numbers, parser codes, and the fixed strings of {@link PublicationEvidenceError}.
 * Never the text of an error that could carry a dataset's content.
 */
export function describeError(e: unknown): string {
  const cls = e instanceof Error ? e.constructor.name : typeof e;
  if (e instanceof Anthropic.APIError) return `${cls} status=${e.status ?? "none"}`;
  if (e instanceof PublicationReviewReportError) return `${cls} code=${e.code}`;
  if (e instanceof PublicationEvidenceError) return `${cls}: ${e.message}`;
  if (e instanceof RunFailure) return `${cls} ${e.error}`;
  return cls;
}

/** What one call to the model cost, in the units the API counts. */
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * One call to the model: Haiku 5.5 at high effort, no tools, a schema-constrained answer. The
 * model can read the prompt and write a JSON object; it cannot do anything else. `model` and
 * `onUsage` are for the offline calibration only; the review never passes them. `onUsage` is told
 * the call's token counts as soon as the answer arrives, before the answer is judged, so a call the
 * job then refuses (a refusal, a cut-off answer) still reports what it cost.
 */
export async function callPublicationReviewModel(
  system: string,
  user: string,
  model: ReviewerModel = PUBLICATION_REVIEW_MODEL,
  onUsage?: (usage: ModelUsage) => void,
): Promise<unknown> {
  // The documents are bounded in characters, not tokens, and the estimate behind the daily caps
  // assumes four characters to a token. Rare characters can cost more, so an adversarial document
  // may cost more than estimated or exceed the model's input limit; the API's refusal of that is a
  // BadRequestError, which `mapError` turns into `model_invalid` (it fails closed), and the daily
  // caps bound the spend. Accepted.
  // A client given no credentials resolves workload identity federation from the environment
  // (ANTHROPIC_FEDERATION_RULE_ID, _ORGANIZATION_ID, _SERVICE_ACCOUNT_ID, _WORKSPACE_ID and
  // ANTHROPIC_IDENTITY_TOKEN_FILE), exchanges the job's OIDC token, and refreshes it.
  const client = new Anthropic({ maxRetries: 2, timeout: 180_000 });
  const res = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: PUBLICATION_OUTPUT_SCHEMA },
    },
  });
  if (
    onUsage &&
    Number.isFinite(res.usage?.input_tokens) &&
    Number.isFinite(res.usage?.output_tokens)
  ) {
    onUsage({ input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens });
  }
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

/** A file the workflow wrote, as text, or null when it cannot be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Review one publication request. Never throws: every failure is a fixed word.
 *
 * The order is the safety argument. The dispatched commit is checked against GitHub's `main` before
 * anything is read, so a model is never called about a commit nobody will publish. The tree, the
 * root documents, the minimums, the version, the tag and the BIDS run are read from git and the
 * runs file, none of which touches a model. Then the pre-send check examines each document, the
 * evidence is built and parsed, the prompt is built from the evidence and the cleared text alone,
 * and only then is the model called.
 */
export async function runPublicationReview(args: ReviewArgs): Promise<PublicationReviewResult> {
  try {
    if (!SHA40.test(args.head) || !SHA40.test(args.fetchedHead)) {
      throw new RunFailure("evidence_unavailable");
    }
    // `main` moved on since the dispatch, so the review is for a commit that is no longer the
    // screened one.
    if (args.fetchedHead !== args.head) throw new RunFailure("stale_head");

    const tree = await readTree(args.repoDir, args.head);
    const docs = readRootDocuments(args.repoDir, tree);
    const { facts, cleared } = evidenceFromDocuments(docs, {
      head: args.head,
      anonymous: args.anonymous,
      tagsText: readText(args.tagsFile),
      bidsRuns: readText(args.bidsRunsFile),
      summary: structuralSummary(args.repoDir, tree),
    });
    const { system, user } = buildPublicationReviewMessages({
      facts,
      cleared,
      nonce: randomUUID().replaceAll("-", ""),
    });
    const modelOutput = await callPublicationReviewModel(system, user);
    return { outcome: "reported", report: assemblePublicationReport(modelOutput, facts) };
  } catch (e) {
    return { outcome: "error", error: mapError(e), diag: describeError(e) };
  }
}

/** POST the result, retrying a network failure or a 5xx. A 4xx will not improve and is not retried. */
export async function postPublicationCallback(
  origin: string,
  token: string,
  body: Record<string, unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ delivered: boolean; status: number | null }> {
  let status: number | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);
    try {
      const res = await fetch(`${origin}/webhooks/publication-review-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
        body: JSON.stringify(body),
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

/** A flag that is not there: exit 2, and the message is the flag's own name, never a value. */
class UsageError extends Error {}

function need(argv: string[], name: string): string {
  const v = flag(argv, name);
  if (!v) throw new UsageError(`missing --${name}`);
  return v;
}

function positive(value: string): number | null {
  const n = Number(value);
  return /^\d{1,12}$/.test(value) && Number.isSafeInteger(n) && n >= 1 ? n : null;
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
  if (cmd === "calibrate") {
    // The offline calibration: its own module, loaded only here, so the review's load path is
    // unchanged. It posts nothing and takes no origin table: `origins` is not passed on.
    const { calibrateMain } = await import("./publication-review-calibrate");
    return calibrateMain(rest);
  }
  if (cmd !== "review") {
    console.error("usage: publication-review.ts review|calibrate ...");
    return 2;
  }
  let flags: Record<
    | "dataset"
    | "review-id"
    | "request-id"
    | "environment"
    | "anonymous"
    | "repo-dir"
    | "head"
    | "fetched-head"
    | "tags-file"
    | "bids-runs-file",
    string
  >;
  try {
    flags = {
      dataset: need(rest, "dataset"),
      "review-id": need(rest, "review-id"),
      "request-id": need(rest, "request-id"),
      environment: need(rest, "environment"),
      anonymous: need(rest, "anonymous"),
      "repo-dir": need(rest, "repo-dir"),
      head: need(rest, "head"),
      "fetched-head": need(rest, "fetched-head"),
      "tags-file": need(rest, "tags-file"),
      "bids-runs-file": need(rest, "bids-runs-file"),
    };
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    return 2;
  }
  const { dataset, environment, anonymous } = flags;
  const reviewId = positive(flags["review-id"]);
  const requestId = positive(flags["request-id"]);
  const token = process.env.PUBLICATION_REVIEW_CALLBACK_TOKEN;
  if (!DATASET_ID.test(dataset) || reviewId === null || requestId === null) {
    console.error("bad --dataset, --review-id or --request-id");
    return 2;
  }
  if (environment !== "production" && environment !== "dev") {
    console.error("bad --environment");
    return 2;
  }
  if (anonymous !== "true" && anonymous !== "false") {
    console.error("bad --anonymous");
    return 2;
  }
  if (!token) {
    console.error("PUBLICATION_REVIEW_CALLBACK_TOKEN is unset");
    return 2;
  }

  const result: PublicationReviewResult = await runPublicationReview({
    repoDir: flags["repo-dir"],
    head: flags.head,
    fetchedHead: flags["fetched-head"],
    tagsFile: flags["tags-file"],
    bidsRunsFile: flags["bids-runs-file"],
    anonymous: anonymous === "true",
  });

  const body: Record<string, unknown> = {
    review_id: reviewId,
    dataset_id: dataset,
    outcome: result.outcome,
    ...(result.outcome === "reported" ? { report: result.report } : { error: result.error }),
  };
  const sent = await postPublicationCallback(origins[environment], token, body);
  // Ids and fixed words only: this log is public.
  console.log(
    `review ${reviewId} (request ${requestId}): ${result.outcome}${
      result.outcome === "error" ? ` (${result.error}${result.diag ? `; ${result.diag}` : ""})` : ""
    }; callback ${sent.delivered ? "delivered" : `not delivered (${sent.status ?? "no response"})`}`,
  );
  return sent.delivered ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      // A fixed word: the text of an unexpected error is not ours to put in a public log.
      console.error(
        `publication-review failed: ${e instanceof Error ? e.constructor.name : "unknown"}`,
      );
      process.exit(1);
    });
}
