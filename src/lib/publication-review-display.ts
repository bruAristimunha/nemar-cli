/**
 * How the terminal prints a publication request's review (ADR 0102, section 8): the one line of
 * `nemar admin publish list` and the whole of `nemar admin publish show`.
 *
 * NOTHING IS DECIDED HERE. The Worker sends the words: a headline and a tone, the reasons with
 * their sentences and cures, the next command. This module owns colour, indentation and the
 * layout of the review's counts, and it prints the words as they arrived, so the list, the detail,
 * the email and the web page cannot say different things about one review. It never reads a reason
 * code to decide what to do next; `description.next` is the server's.
 *
 * Every string that came from the network passes `plain()` first (control characters, zero-width
 * and bidirectional-override characters removed): the Worker already reduced the model's words to
 * plain ones, and a terminal should not depend on that alone. The two things the model wrote, the
 * summary and the notes of its findings, are printed under labels that say so.
 */

import chalk from "chalk";
import type {
  PublicationReviewDetail,
  PublicationReviewHistoryEntry,
  PublicationReviewRecord,
  PublicationReviewSummary,
} from "../../shared/contract/publication-review-admin.js";
import {
  DOCUMENT_LABEL,
  PUBLICATION_FINDING_LABEL,
  type PublicationReviewEvidence,
  QUESTIONS,
  QUESTION_LABEL,
  REVIEW_DOCUMENTS,
  type ReviewDocument,
  effectiveVersionOf,
} from "../../shared/publication-review.js";
import { type IdentifierScreenView, identifierScreenLines } from "./identifier-screen-display.js";
import { plain } from "./terminal-text.js";

type Tone = "ok" | "note" | "warn" | "stop";

const TONE: Record<Tone, (text: string) => string> = {
  ok: chalk.green,
  note: chalk.cyan,
  warn: chalk.yellow,
  stop: chalk.red,
};

/** The colour of a tone; a tone a newer server invents is shown as a warning, never as a pass. */
export function toneColor(tone: string): (text: string) => string {
  return TONE[tone as Tone] ?? chalk.yellow;
}

/** What `show` and the start commands say when the Worker is not production's. */
export const NON_PRODUCTION_NOTE =
  "This is the non-production Worker. It holds its own record and answers only for the datasets it owns; it does not change what production reviews.";

/** The label every rendering of the model's words carries. */
export const MODEL_WRITTEN_FINDINGS = "written by the model; the depositor's text can steer them";
export const MODEL_WRITTEN_SUMMARY = "written by the model; the depositor's text can steer it";

// ---------------------------------------------------------------------------------------------
// A start that went
// ---------------------------------------------------------------------------------------------

/**
 * What `start` says for an answer of 202. `dispatch_claimed` is a failed hand-over that found its
 * run already claimed: the review exists and stands, which "started" would misstate. A word a newer
 * Worker invents is said as it is, and never as a start that did not happen.
 */
export function startedSentence(reason: string, datasetId: string): string {
  const id = plain(datasetId);
  switch (reason) {
    case "dispatched":
      return `${id}: review started.`;
    case "redispatched":
      return `${id}: review started again.`;
    case "dispatch_claimed":
      return `${id}: a review of this commit was already handed over and stands.`;
    default:
      return `${id}: review started (${plain(reason)}).`;
  }
}

// ---------------------------------------------------------------------------------------------
// The list's line
// ---------------------------------------------------------------------------------------------

/**
 * The identifier screen of a request as the lines to print, `indent` spaces in. The headline and
 * every line crossed the network, so each passes `plain()` before `identifierScreenLines` colours
 * it: the colour's own escape sequences are the CLI's, anything else is not. Nothing for a view an
 * older backend did not send, as `identifierScreenLines` itself says.
 */
export function screenViewLines(
  screen: IdentifierScreenView | undefined,
  indent: number,
): string[] {
  if (!screen || typeof screen.headline !== "string") return [];
  return identifierScreenLines(
    {
      ...screen,
      headline: plain(screen.headline),
      lines: Array.isArray(screen.lines) ? screen.lines.map(plain) : [],
    },
    indent,
  );
}

/**
 * The review line under a request in `list`: the headline in its tone's colour, then the reason
 * codes dim. Null for a request that is not assessed (no outcome: the review is off and none is on
 * record, the dataset is a mirror, the request is over) and for a row from a backend that sends no
 * summary: a line saying "not reviewed" under every published request would be noise, and the
 * footer already says when the whole review is off.
 */
export function reviewListLine(
  summary: PublicationReviewSummary | undefined,
  indent = 4,
): string | null {
  if (!summary || summary.outcome === null || summary.outcome === undefined) return null;
  const codes = (Array.isArray(summary.reasons) ? summary.reasons : []).map(plain).join(", ");
  return `${" ".repeat(indent)}${toneColor(summary.tone)(plain(summary.headline))}${
    codes === "" ? "" : `  ${chalk.dim(codes)}`
  }`;
}

// ---------------------------------------------------------------------------------------------
// The detail's parts
// ---------------------------------------------------------------------------------------------

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const TAG_WORD: Record<string, string> = {
  absent: "tag absent",
  at_head: "tag at the reviewed commit",
  elsewhere: "tag at another commit",
};

/**
 * The version an approval would publish and what is known about its tag. The version is
 * `effectiveVersionOf(evidence)`, not the evidence's own `version`: a dataset whose description
 * sets none is published as 1.0.0, and that is the version whose release was looked for.
 */
function versionPiece(e: PublicationReviewEvidence): string {
  const version = effectiveVersionOf(e);
  if (version === null) return "version malformed (X.Y.Z expected)";
  const notes: string[] = [];
  if (e.version_shape === "missing") notes.push("dataset_description.json sets no Version");
  const tag = TAG_WORD[e.tag];
  if (tag) notes.push(tag);
  return `version ${plain(version)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * `Evidence: ...`: the facts the job computed, as one line. Counts and closed words only, so
 * nothing here is a word the model or the depositor chose.
 */
export function evidenceLine(e: PublicationReviewEvidence): string {
  const s = e.summary;
  const parts: string[] = [versionPiece(e), `BIDS ${plain(e.bids)}`];
  parts.push(
    e.minimums === "met"
      ? "minimums met"
      : `minimums failed (${e.minimum_failures.map(plain).join(", ")})`,
  );
  parts.push(plural(s.subjects, "subject"), plural(s.sessions, "session"));
  const formats = Object.entries(s.formats)
    .map(([ext, n]) => `${plain(ext)} ${n}`)
    .join(", ");
  parts.push(`${plural(s.recordings, "recording")}${formats === "" ? "" : ` (${formats})`}`);
  parts.push(`datatypes ${s.datatypes.length === 0 ? "none" : s.datatypes.map(plain).join(", ")}`);
  if (s.sampling_rates_hz.length > 0)
    parts.push(`sampling rates ${s.sampling_rates_hz.join(", ")} Hz`);
  if (s.channel_counts.length > 0) parts.push(`channel counts ${s.channel_counts.join(", ")}`);
  parts.push(`sidecars read ${s.sidecars_read} of ${s.sidecars_total}`);
  return `Evidence: ${parts.join(", ")}`;
}

/** What happened to a document, in words: `sent`, `sent (cut)`, `absent`, `withheld (finding)`. */
function documentWord(state: string): string {
  if (state === "sent_cut") return "sent (cut)";
  if (state.startsWith("withheld_")) {
    return `withheld (${plain(state.slice("withheld_".length)).replaceAll("_", " ")})`;
  }
  return plain(state).replaceAll("_", " ");
}

/** `Shown to the model: README sent, dataset_description.json sent (9 keys shown, 2 not), ...`. */
export function shownLine(e: PublicationReviewEvidence): string {
  const parts = REVIEW_DOCUMENTS.map((doc: ReviewDocument) => {
    const state = e.documents[doc];
    let part = `${DOCUMENT_LABEL[doc]} ${documentWord(state)}`;
    if (doc === "dataset_description" && (state === "sent" || state === "sent_cut")) {
      part += ` (${e.description_keys_shown} keys shown, ${e.description_keys_not_shown} not)`;
    }
    return part;
  });
  return `Shown to the model: ${parts.join(", ")}`;
}

/** `Withheld for findings: local_user_path 1`, or null when nothing was withheld for a finding. */
export function withheldLine(e: PublicationReviewEvidence): string | null {
  const entries = Object.entries(e.withheld_findings ?? {});
  if (entries.length === 0) return null;
  return `Withheld for findings: ${entries.map(([kind, n]) => `${plain(kind)} ${n}`).join(", ")}`;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Whether `e` has what {@link shownLine} and {@link withheldLine} read, as the types they read it
 * as: a state for each of the review's documents, the two counts of description keys, and a count
 * for every finding kind withheld (none sent is none withheld). The shape is checked, not caught:
 * `approve` prints this before the gate speaks, and a detail from another version of the server is
 * not read by `parseReviewDetail`, so evidence it does not recognize must cost the lines, never the
 * approval.
 */
function readsAsEvidence(e: unknown): e is PublicationReviewEvidence {
  if (!isRecord(e)) return false;
  const documents = e.documents;
  if (!isRecord(documents)) return false;
  if (!REVIEW_DOCUMENTS.every((d) => typeof documents[d] === "string")) return false;
  if (typeof e.description_keys_shown !== "number") return false;
  if (typeof e.description_keys_not_shown !== "number") return false;
  const withheld = e.withheld_findings;
  if (withheld === undefined || withheld === null) return true;
  return isRecord(withheld) && Object.values(withheld).every((n) => typeof n === "number");
}

/**
 * What `approve` adds to the review it prints, so an administrator is not asked to `--force` over a
 * reason such as `text_withheld` blind: what the model was shown, what was withheld for findings,
 * and a pointer to `show` for the rest. The same two lines `show` prints, from the same helpers;
 * the model's own summary and notes stay in `show`, under their labels. Empty for a request with no
 * review in force, one whose review has no evidence yet, and evidence of a shape this CLI does not
 * read ({@link readsAsEvidence}).
 */
export function approveEvidenceLines(
  review: PublicationReviewRecord | null | undefined,
  datasetId: string,
): string[] {
  const evidence = review?.evidence;
  if (!readsAsEvidence(evidence)) return [];
  const withheld = withheldLine(evidence);
  return [
    shownLine(evidence),
    ...(withheld === null ? [] : [withheld]),
    `The whole review, with the model's questions and findings: nemar admin publish show ${plain(datasetId)}`,
  ];
}

const ANSWER_COLOR: Record<string, (s: string) => string> = {
  pass: chalk.green,
  fail: chalk.red,
  unknown: chalk.yellow,
};

/** The four questions with their answers after the facts, in the vocabulary's order. */
export function questionLines(questions: PublicationReviewRecord["questions"]): string[] {
  if (questions === null) return [];
  const names = [
    ...QUESTIONS.filter((q) => q in questions),
    ...Object.keys(questions).filter((q) => !(QUESTIONS as readonly string[]).includes(q)),
  ];
  const width = Math.max(0, ...names.map((q) => q.length));
  return names.map((q) => {
    const answer = plain((questions as Record<string, string>)[q]);
    const label = (QUESTION_LABEL as Record<string, string | undefined>)[q] ?? "";
    return `    ${plain(q).padEnd(width)}   ${(ANSWER_COLOR[answer] ?? chalk.yellow)(answer.padEnd(7))}  ${label}`;
  });
}

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
  blocker: chalk.red,
  concern: chalk.yellow,
  note: chalk.dim,
};

/** One finding of the model's, `[blocker] README does not match the dataset (README): <note>`. */
export function findingLines(findings: PublicationReviewRecord["findings"]): string[] {
  return findings.map((f) => {
    const what =
      (PUBLICATION_FINDING_LABEL as Record<string, string | undefined>)[f.code] ?? plain(f.code);
    const doc =
      f.document === null
        ? ""
        : ` (${(DOCUMENT_LABEL as Record<string, string | undefined>)[f.document] ?? plain(f.document)})`;
    const note = plain(f.note);
    const severity = plain(f.severity);
    return `    ${(SEVERITY_COLOR[severity] ?? chalk.yellow)(`[${severity}]`)} ${what}${doc}${
      note === "" ? "" : `: ${note}`
    }`;
  });
}

/** The reviews of the request, newest first, when there is more than the one in force. */
export function historyLines(
  d: Pick<PublicationReviewDetail, "history" | "history_truncated" | "review">,
): string[] {
  const inForce = d.review?.id ?? null;
  const only = d.history.length === 1 && d.history[0].id === inForce;
  if (d.history.length === 0 || only) return [];
  const out = [chalk.bold("History")];
  for (const h of d.history as PublicationReviewHistoryEntry[]) {
    const stored = h.stored_verdict === null ? "-" : plain(h.stored_verdict);
    out.push(
      `  #${plain(String(h.id)).padEnd(5)} ${plain(h.head_sha).slice(0, 12)}  ${plain(h.state).padEnd(10)}  ${stored.padEnd(15)}  ${chalk.dim(plain(h.created_at))}${
        h.id === inForce ? chalk.dim("  in force") : ""
      }`,
    );
  }
  if (d.history_truncated) out.push(chalk.dim("  (older reviews not shown)"));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The whole of `show`
// ---------------------------------------------------------------------------------------------

const GATE_WORD: Record<string, string> = {
  enforced: "enforced",
  off: "off (advice only)",
  "n/a": "n/a",
};

/**
 * `GET /admin/publish/:id/review` as the lines `show` prints: the request, the screen, then the
 * review in the Worker's words (its headline, the gate, every reason with what clears it), the
 * model's answers, the platform facts that lowered one, the model's findings and summary under
 * their labels, the evidence, what the model was shown, an override on record, the standing line
 * and the next command, then the history. Pure.
 */
export function reviewDetailLines(d: PublicationReviewDetail): string[] {
  const out: string[] = [];
  const kind = d.anonymous ? chalk.yellow("ANONYMOUS RELEASE") : "named publication";
  const status =
    d.block_reason === null || d.block_reason === undefined
      ? plain(d.request_status)
      : `${plain(d.request_status)} (${plain(d.block_reason)})`;
  out.push(
    `${chalk.bold(plain(d.dataset_id))}  request ${plain(String(d.request_id))}, ${status}, ${kind}`,
  );
  if (d.environment !== "production") out.push(`  ${chalk.yellow(NON_PRODUCTION_NOTE)}`);

  out.push("");
  out.push(...screenViewLines(d.identifier_screen, 0));
  if (d.screen_acknowledgment) {
    out.push(
      `  Acknowledged by administrator ${plain(String(d.screen_acknowledgment.by))} at ${plain(d.screen_acknowledgment.at)}.`,
    );
  }

  out.push("");
  const desc = d.description;
  out.push(chalk.bold(toneColor(desc.tone)(plain(desc.headline))));
  out.push(`  Gate: ${GATE_WORD[d.gate] ?? plain(d.gate)}`);
  // Fixed and closed words, one per line, the standing line last: the reasons with what clears
  // them, then who reviewed which commit. The standing line is printed at the end.
  const standing = desc.lines.length > 0 ? desc.lines[desc.lines.length - 1] : null;
  for (const line of desc.lines.slice(0, -1)) out.push(`  ${plain(line)}`);

  const review = d.review;
  if (review !== null) {
    const questions = questionLines(review.questions);
    if (questions.length > 0) out.push("  Questions:", ...questions);
    if (review.fact_notes.length > 0) {
      out.push("  Platform facts that lowered an answer:");
      for (const n of review.fact_notes) out.push(`    ${plain(n.question)}: ${plain(n.text)}`);
    }
    if (review.findings.length > 0) {
      out.push(`  Findings (${MODEL_WRITTEN_FINDINGS}):`, ...findingLines(review.findings));
    }
    const summary = review.summary ?? desc.summary;
    if (summary !== null && summary !== undefined && plain(summary) !== "") {
      out.push(`  Summary (${MODEL_WRITTEN_SUMMARY}):`, `    ${plain(summary)}`);
    }
    if (review.evidence !== null) {
      out.push(`  ${evidenceLine(review.evidence)}`, `  ${shownLine(review.evidence)}`);
      const withheld = withheldLine(review.evidence);
      if (withheld !== null) out.push(`  ${withheld}`);
    }
    if (review.override !== null) {
      out.push(
        `  Override: by administrator ${plain(String(review.override.by))} at ${plain(review.override.at)} for ${review.override.reasons.map(plain).join(", ")}`,
      );
    }
  }
  if (standing !== null) out.push(`  ${chalk.dim(plain(standing))}`);
  if (desc.next !== null && desc.next !== undefined) out.push(`  Next: ${plain(desc.next)}`);

  const history = historyLines(d);
  if (history.length > 0) out.push("", ...history);
  return out;
}
