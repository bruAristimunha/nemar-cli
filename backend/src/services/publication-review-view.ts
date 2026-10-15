/**
 * What every surface shows about a publication request's review (ADR 0102, section 5): the
 * admin list, the detail view and the admin email all read it from here, so none of them can
 * disagree about an outcome, a reason or a sentence.
 *
 * **The verdict is stored when decided and re-derived when used.** {@link derivePublicationReview}
 * rebuilds the reasons from the stored report ({@link rowViewOf} re-parses it every time) and
 * from facts read now ({@link LiveFacts}), and shows the STRICTER of the stored verdict and the
 * re-derived outcome. Either can lower an outcome and neither can raise it. A fact that cannot be
 * read is never guessed: the read throws, and the caller says so (the mail names it, the detail
 * route answers 500, and the list shows that one row as unreadable and still answers), because an
 * outcome built on a guess could be a pass.
 *
 * **The review in force is the row of the screened head and the request's flag.** The head comes
 * from `readStoredReport(...)?.head`, the gate's own reader. A row of another head or flag is
 * history in the detail view and never the outcome here.
 *
 * **A dispatched review is waited for in two statuses, `requested` and `approving`.** Only a request
 * in `requested` is claimed for a review (ADR 0102, section 7: the claim requires it), but an
 * approval that has not started publishing is gated again when it resumes, so a review claimed
 * before the approval began can still report and settle that gate; none starts once the request is
 * `approving`. A request in any other state shows its stored review as history and never as a wait:
 * a dispatched row of such a request reads as one that did not report, so no surface says
 * "running" about a review whose result can no longer settle anything. Its live facts are not read
 * either, with one exception, `blocked` ({@link LIVE_FACT_STATUSES}): a blocked request that is not
 * a run that started publishing has written nothing of an approval, so a version row or a concept
 * DOI can only belong to an EARLIER release, and is shown beside the hard `request_blocked`. A
 * request that is over (`published`, `denied`) would read as one whose own release "was already
 * released", and an `approving` request that has started publishing, or a `blocked` one the
 * owner-name walk-back stopped half way (`publishingStanding`), has written those facts itself, so
 * they show their stored review only. An `approving` request that stopped before it published has
 * written neither, is gated again when it resumes, and reads them like a `requested` one.
 *
 * **What a viewer may read** is counts, closed words and the shared sentences. The model's summary
 * and the notes of its findings, both sanitized by the parser, appear in the detail view and
 * nowhere else: the list carries the headline and the reason codes, and the email carries the
 * headline, the reasons, the next command and no model-written text at all. No nonce is read:
 * every statement here selects named columns, and `publication-review-rows.ts` never selects it.
 *
 * **Not assessed is not "action required".** A request with no review on record and no gate on it
 * (the review is off, or the request is over) has no outcome and no reasons, like a mirror, so the
 * outcome never contradicts a headline that says "not reviewed".
 *
 * **The detail carries what `approve` and `next` show from one read** (Phase 2): the request's screen
 * ({@link screenView}, the function the list row uses), the acknowledgment on record, the block
 * reason, whether the approval has started publishing and the dataset's size. The list row carries
 * one more fact, `start_offered`, the rule `describePublicationReview` uses for its next command.
 *
 * The module imports the row readers, the stored-screen readers and the screen's status view, and
 * nothing of the screen's mail or the review's write path, so `identifier-screen.ts` can import it
 * without a cycle. That is why `screenView` lives beside those readers, and `hasStartedPublishing`
 * in `shared/publication-steps.ts` (with `publishingStanding`, the rule over it): both moved out of
 * `identifier-screen.ts` for it.
 */

import type {
  PublicationReviewDetail,
  PublicationReviewGateState,
  PublicationReviewHistoryEntry,
  PublicationReviewRecord,
  PublicationReviewSummary,
  PublicationReviewViewKind,
  ReasonView,
} from "../../../shared/contract/publication-review-admin.js";
import { type ScreenGate, screenGate } from "../../../shared/identifier-screen-report.js";
import {
  type ApprovalStanding,
  DOCUMENT_LABEL,
  type LiveFacts,
  PUBLICATION_FINDING_LABEL,
  PUBLICATION_REVIEW_DEADLINE_MINUTES,
  type PublicationDeclineDetail,
  type PublicationOutcome,
  type PublicationReviewDescription,
  type PublicationReviewReport,
  type PublicationReviewState,
  type PublicationRunError,
  REASONS,
  REASON_CODES,
  REVIEW_OVERDUE_VIEW_MINUTES,
  REVIEW_UNREADABLE_HEADLINE,
  type Reason,
  type ReasonCode,
  type ReviewRowView,
  answersOf,
  commandOf,
  describePublicationReview,
  describeUnreadableReview,
  effectiveVersionOf,
  factNotesOf,
  isPublicationDeclineDetail,
  isPublicationOutcome,
  isPublicationReviewState,
  isPublicationRunError,
  neutralCureOf,
  reasonLine,
  reasonStatement,
  reasonsOf,
  shownBlockReason,
  startOffered,
  stricterOf,
  verdictOf,
} from "../../../shared/publication-review.js";
import { publishingStanding } from "../../../shared/publication-steps.js";
import type { Bindings } from "../types/bindings.js";
import { ACTIVE_REQUEST_TAIL_SQL } from "./approval-dispatch.js";
import type { PublicationReviewSection } from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import {
  isScreenExempt,
  readStoredReport,
  readStoredState,
  screenView,
} from "./identifier-screen-stored.js";
import { SHA40, errorWords } from "./publication-review-log.js";
import {
  MAX_KEYS_PER_READ,
  type PublicationReviewRow,
  type ReviewKey,
  listReviewsOfRequest,
  readReviewByKey,
  readReviewsByKeys,
  reviewKeyText,
  rowViewOf,
} from "./publication-review-rows.js";
import { requiresUploaderName } from "./uploader-identity.js";

// ---------------------------------------------------------------------------------------------
// The two predicates every part of the review asks first
// ---------------------------------------------------------------------------------------------

/** The flag: exactly `"1"`. Any other value, unset included, is off. */
export function reviewEnabled(env: Pick<Bindings, "PUBLICATION_REVIEW_ENABLED">): boolean {
  return env.PUBLICATION_REVIEW_ENABLED === "1";
}

/**
 * Does the review apply to this dataset at all? OpenNeuro mirrors and exemplars passed an
 * upstream review (ADR 0014, ADR 0026), so the review is "not applicable" for them. A named
 * wrapper over `requiresUploaderName`, so that a change to the name rule cannot silently change
 * the review's scope (ADR 0102, section 5).
 */
export function publicationReviewApplies(dataset: {
  source?: string | null;
  is_exemplar?: number | null;
}): boolean {
  return requiresUploaderName(dataset);
}

/**
 * The statuses whose live version and DOI facts are read: those where nothing of an approval has
 * been written yet, so a `dataset_versions` row or a concept DOI on the dataset can only belong to
 * an EARLIER release, which is what the checks look for.
 *
 *  - `requested`: waiting for its decision.
 *  - `blocked`: a request that is not a run that started publishing has written nothing either. Its
 *    facts are informative, and the hard `request_blocked` stands beside them. One that HAS started
 *    publishing is a run the owner-name walk-back blocked half way (the check runs on every call
 *    of a run; `publishingStanding` reads the reason too), so it wrote its own version row and DOI
 *    and reads none, like `approving`.
 *
 * Not `approving` as such: a run that HAS started publishing has by then written its own
 * `dataset_versions` row and concept DOI, and read as live facts they would say "already released"
 * and "unexpected DOI" about a run that should be RESUMED, with `approve --force` as its next
 * command. It, like every request that is over (`published`, `denied`), shows its stored review and
 * the stored verdict only; the approval gate skips such a run for the same reason
 * (`publishingStanding`). An `approving` run that STOPPED before it published (`approval ===
 * "stopped"`: only the validation-only steps, `ci_check` and `enrichment_check`, completed) is
 * gated again when it resumes and has written neither a version row nor a DOI, so its facts are
 * about an earlier release and are read, whatever its status says.
 */
const LIVE_FACT_STATUSES: ReadonlySet<string> = new Set(["requested", "blocked"]);

/**
 * The statuses of a request an approval could still act on, the same set as
 * `ACTIVE_REQUEST_TAIL_SQL`: a request in any other status is over, and with no review on record
 * there is nothing to assess about it.
 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["requested", "approving", "blocked"]);

// ---------------------------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------------------------

/** The request columns the derivation reads. Never a nonce. */
export interface ReviewRequestFields {
  id: number;
  dataset_id: string;
  status: string;
  block_reason: string | null;
  anonymous: number | null;
  identifier_screen_status: string | null;
  identifier_screen_report: string | null;
  identifier_screen_ack_by: number | null;
  /** When the acknowledgment was recorded; carried to the detail with `identifier_screen_ack_by`. */
  identifier_screen_ack_at: string | null;
  /** The approval's completed steps, a JSON list: whether it has started publishing. */
  steps_completed: string | null;
}

/** The dataset columns the derivation reads; the whole object is null when the dataset row is gone. */
export interface ReviewDatasetFields {
  source: string | null;
  is_exemplar: number | null;
  concept_doi: string | null;
  ezid_status: string | null;
  first_published_at: string | null;
  /** `datasets.total_files`; read for the detail only, so a list passes null. */
  total_files: number | null;
}

export interface ReviewContext {
  env: Bindings;
  /** The clock, in milliseconds, so a test can age a row without waiting. */
  nowMs: number;
  request: ReviewRequestFields;
  dataset: ReviewDatasetFields | null;
  /**
   * How old a dispatched row is before it reads as one that did not report. Default
   * {@link REVIEW_OVERDUE_VIEW_MINUTES}, which the list and the detail use. The admin mail passes
   * {@link PUBLICATION_REVIEW_DEADLINE_MINUTES}: see {@link publicationReviewEmailSection}.
   */
  overdueMinutes?: number;
  /**
   * The review in force, when the caller has already read it (the list reads every row's in one
   * statement, {@link readReviewsByKeys}): the row, or null for "none on record". Left out, the
   * derivation reads it itself.
   */
  reviewRow?: PublicationReviewRow | null;
}

export interface DerivedPublicationReview {
  applies: boolean;
  enabled: boolean;
  gate: PublicationReviewGateState;
  /** The review in force: the row of the screened head and the request's flag. */
  row: PublicationReviewRow | null;
  rowView: ReviewRowView;
  live: LiveFacts;
  reasons: Reason[];
  /**
   * The stricter of the stored verdict and the re-derived one. Null when the request is not
   * assessed: the review does not apply to it, or no review is on record and none gates it (the
   * review is off, or the request is over).
   */
  outcome: PublicationOutcome | null;
  /** An administrator's start can reach this request (it is `requested`); the cures and `next` say so. */
  startable: boolean;
  description: PublicationReviewDescription;
}

/** The report of the review in force, when it reported and still parses. */
export function reportOf(view: ReviewRowView): PublicationReviewReport | null {
  return view.kind === "reported" ? view.report : null;
}

async function exists(db: D1Database, sql: string, ...binds: unknown[]): Promise<boolean> {
  return (
    (await db
      .prepare(sql)
      .bind(...binds)
      .first()) !== null
  );
}

/** A `dataset_versions` row exists for the version the review read. */
const VERSION_ROW_SQL =
  "SELECT 1 AS found FROM dataset_versions WHERE dataset_id = ? AND version = ?";

/**
 * An EARLIER request of the dataset asked for an anonymous release: the rule of
 * `PRIOR_ANONYMOUS_REQUEST_SQL` (`services/anonymity.ts`), restricted to earlier request ids so a
 * request is never its own predecessor.
 */
const EARLIER_ANONYMOUS_REQUEST_SQL =
  "SELECT 1 AS found FROM publication_requests WHERE dataset_id = ? AND anonymous = 1 AND id < ? LIMIT 1";

/** The screen's side of a request: the commit it read and the gate its state gives. */
function screenOf(request: ReviewRequestFields): {
  head: string | null;
  gate: ScreenGate | "exempt";
} {
  const state = readStoredState(request.identifier_screen_status);
  const screenReport = state === null ? null : readStoredReport(request.identifier_screen_report);
  return {
    head: screenReport?.head ?? null,
    gate: isScreenExempt(request.dataset_id) ? "exempt" : screenGate(state),
  };
}

/**
 * The coordinates of the review in force: the request, the commit its screen read and its release
 * kind. Null when the review does not apply to the dataset, or the screen read no commit, so there
 * is no row to look for.
 */
function reviewKeyOf(
  request: ReviewRequestFields,
  dataset: ReviewDatasetFields | null,
): ReviewKey | null {
  const { head } = screenOf(request);
  if (!publicationReviewApplies(dataset ?? {}) || head === null || !SHA40.test(head)) return null;
  return { requestId: request.id, headSha: head, anonymous: request.anonymous === 1 };
}

/**
 * Everything a surface shows, re-derived now. Reads the review in force and, for a request whose
 * approval has written nothing yet ({@link LIVE_FACT_STATUSES}, or a run that stopped before it
 * published), three facts: a version row for the version an approval would publish, an earlier
 * anonymous request and the concept DOI. No GitHub call is made anywhere in this module, and the
 * review's approval gate makes none either: `head_current` stays null for every caller, so
 * `identifier_screen_stale` is never derived here. Whether the screened commit is still `main` is
 * asked by the identifier screen's own gate (`verifyScreenHead`), and the stale refusal is its.
 *
 * Throws when a read fails. It never answers from a fact it could not read.
 */
export async function derivePublicationReview(
  ctx: ReviewContext,
): Promise<DerivedPublicationReview> {
  const { env, request, dataset } = ctx;
  const db = env.DB;
  const enabled = reviewEnabled(env);
  const applies = publicationReviewApplies(dataset ?? {});
  const anonymous = request.anonymous === 1;
  // An administrator's start is refused for any request that is not waiting for its decision, so
  // only such a request is ever told to start a review.
  const startable = request.status === "requested";
  // Where an approval stands: a run that has started publishing is continued without a gate, one
  // that stopped before it did is gated like a fresh run (`describePublicationReview`'s `approval`).
  // The one rule the approval itself asks (`publishingStanding`), so the words, the next command
  // and `started_publishing` agree with what the Worker does: a run the owner-name walk-back
  // blocked half way is `publishing` too, and any other blocked request is `none`.
  const approval: ApprovalStanding = publishingStanding(request);

  const { head, gate } = screenOf(request);

  let row: PublicationReviewRow | null = null;
  let rowView: ReviewRowView = { kind: "none" };
  if (applies && head !== null && SHA40.test(head)) {
    row =
      ctx.reviewRow !== undefined
        ? ctx.reviewRow
        : await readReviewByKey(db, request.id, head, anonymous);
    if (row !== null) {
      rowView = rowViewOf(row, ctx.nowMs, ctx.overdueMinutes);
      // A review is waited for only while it can still settle something: for a request that is
      // `requested`, and for one that is `approving`, because an approval that has not started
      // publishing is gated again when it resumes, and a review claimed before the approval began
      // can still report before then (the claim requires `requested`, so none starts once the
      // request is approving). The gate, the detail, the list and the mail therefore read a
      // dispatched row one way, by time alone. A run that HAS started publishing is never gated again, so its reasons do not
      // matter to the gate, and reading its row as running is harmless. For any other status a
      // dispatched row is not waited for.
      if (
        request.status !== "requested" &&
        request.status !== "approving" &&
        rowView.kind === "dispatched"
      ) {
        rowView = { kind: "dispatched", overdue: true };
      }
    }
  }

  // Not assessed: no review is on record AND nothing of the review gates this request (the review
  // is off, or the request is over). Such a request has no outcome and no reason, as a mirror has
  // none, so a client that renders `outcome` cannot contradict the headline ("not reviewed"), and
  // no live fact is read for it. An open request with the review on and no row IS assessed: the
  // missing review is its reason.
  const closed = !ACTIVE_STATUSES.has(request.status);
  const assessed = !(row === null && (!enabled || closed));

  const report = reportOf(rowView);
  const version = report?.evidence.version ?? null;
  // What an approval would publish: a dataset with no Version is published as 1.0.0, so that is
  // the version whose release the live checks must look for (a malformed one has none).
  const publishedVersion = report === null ? null : effectiveVersionOf(report.evidence);
  // A blocked request whose run had started publishing (the owner-name walk-back, which runs on
  // every call of a run) wrote its own version row and DOI, so it reads no live fact either.
  const ownRun = request.status === "blocked" && approval === "publishing";
  const readFacts =
    applies &&
    assessed &&
    !ownRun &&
    (LIVE_FACT_STATUSES.has(request.status) || approval === "stopped");
  const versionRowExists =
    readFacts && publishedVersion !== null
      ? await exists(db, VERSION_ROW_SQL, request.dataset_id, publishedVersion)
      : false;
  const conceptDoiPresent = readFacts && (dataset?.concept_doi ?? "").trim() !== "";
  // Asked only when a rule below can use the answer: a version row (which of the two version
  // reasons) or a concept DOI (whether an anonymous release reserved it).
  const priorAnonymousRequest =
    versionRowExists || conceptDoiPresent
      ? await exists(db, EARLIER_ANONYMOUS_REQUEST_SQL, request.dataset_id, request.id)
      : false;

  const live: LiveFacts = {
    request: { status: request.status, block_reason: request.block_reason, anonymous },
    screen: {
      gate,
      head,
      acknowledged_by: request.identifier_screen_ack_by,
      head_current: null,
    },
    versions: {
      version_row_exists: versionRowExists,
      prior_anonymous_request: priorAnonymousRequest,
      first_published: readFacts && Boolean(dataset?.first_published_at),
    },
    doi: {
      concept_doi_present: conceptDoiPresent,
      concept_ezid_status: readFacts ? (dataset?.ezid_status ?? null) : null,
    },
  };

  if (!applies) {
    return {
      applies,
      enabled,
      gate: "n/a",
      row: null,
      rowView,
      live,
      reasons: [],
      outcome: null,
      startable,
      description: describePublicationReview({
        datasetId: request.dataset_id,
        applies,
        enabled,
        outcome: null,
        reasons: [],
        row: rowView,
        model: null,
        head: null,
        version: null,
        startable,
        approval,
      }),
    };
  }

  if (!assessed) {
    return {
      applies,
      enabled,
      gate: enabled ? "enforced" : "off",
      row: null,
      rowView,
      live,
      reasons: [],
      outcome: null,
      startable,
      description: describePublicationReview({
        datasetId: request.dataset_id,
        applies,
        enabled,
        outcome: null,
        reasons: [],
        row: rowView,
        model: null,
        head: null,
        version: null,
        startable,
        closed,
        approval,
      }),
    };
  }

  const reasons = reasonsOf({ live, row: rowView });
  // The stricter of the stored verdict and the outcome of the reasons just derived. `reasonsOf`
  // already says why a stored verdict is stricter than its report, so the two agree in practice;
  // taking the stricter keeps it true whatever a later rule change does to an old report.
  let outcome = verdictOf(reasons);
  if (rowView.kind === "reported") outcome = stricterOf(rowView.stored, outcome);
  return {
    applies,
    enabled,
    gate: enabled ? "enforced" : "off",
    row,
    rowView,
    live,
    reasons,
    outcome,
    startable,
    description: describePublicationReview({
      datasetId: request.dataset_id,
      applies,
      enabled,
      outcome,
      reasons,
      row: rowView,
      model: report?.model ?? null,
      head: row?.headSha ?? head,
      version,
      startable,
      closed,
      approval,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// The list's summary
// ---------------------------------------------------------------------------------------------

function viewKindOf(d: DerivedPublicationReview): PublicationReviewViewKind {
  if (!d.applies) return "not_applicable";
  if (!d.enabled) return "off";
  if (d.rowView.kind === "none") return "not_reviewed";
  if (d.rowView.kind === "dispatched" && !d.rowView.overdue) return "running";
  return "decided";
}

/**
 * Whether an administrator's start is offered for this request: the review is on and applies, the
 * screen has a clear (or acknowledgeable) result for a commit, which is what the start route asks
 * of the screen before anything else, and {@link startOffered} says so, the rule behind the
 * detail's next command. A request that is not `requested` is never offered one, because
 * `startable` is false for it. Never true for a request the route would refuse for a reason this
 * view can see; the platform's allowance and the Worker's ownership of the dataset it cannot see
 * (a refusal there is a 409 that writes nothing).
 */
function startOfferedFor(d: DerivedPublicationReview): boolean {
  if (!d.enabled || !d.applies) return false;
  const { gate, head } = d.live.screen;
  if ((gate !== "clear" && gate !== "acknowledge") || head === null || !SHA40.test(head)) {
    return false;
  }
  return startOffered({ reasons: d.reasons, row: d.rowView, startable: d.startable });
}

/**
 * One row of `GET /admin/publish/requests`: the outcome, the headline and the reason codes. No
 * sentence of the model's, and no sentence a client could not take from the shared words.
 */
function summaryOf(d: DerivedPublicationReview): PublicationReviewSummary {
  return {
    kind: viewKindOf(d),
    enabled: d.enabled,
    gate: d.gate,
    outcome: d.outcome,
    headline: d.description.headline,
    tone: d.description.tone,
    reasons: d.reasons.map((r) => r.code),
    start_offered: startOfferedFor(d),
    review_id: d.row?.id ?? null,
    head_sha: d.row?.headSha ?? null,
  };
}

/**
 * The summary of a request whose review could not be read: not a reason to fail the rest of a list.
 *
 * With the review ON it is the `unreadable` kind: `action_required`, never a pass, in the shared
 * words, with no reason (the cure of `review_could_not_run`, "start it again", is wrong advice for
 * a read fault). With it OFF nothing is gated and nothing is assessed, so it is what a request with
 * no review on record is while the review is off: the not-assessed `off` summary, with no outcome
 * and no reason. That is also what the admin email does, so the list and the mail cannot disagree
 * about a request whose rows cannot be read.
 */
function unreadableSummary(enabled: boolean, datasetId: string): PublicationReviewSummary {
  if (!enabled) {
    const off = describePublicationReview({
      datasetId,
      applies: true,
      enabled: false,
      outcome: null,
      reasons: [],
      row: { kind: "none" },
      model: null,
      head: null,
      version: null,
      // Not an offer of anything: the review is off, so no command is built.
      startable: false,
    });
    return {
      kind: "off",
      enabled: false,
      gate: "off",
      outcome: null,
      headline: off.headline,
      tone: off.tone,
      reasons: [],
      start_offered: false,
      review_id: null,
      head_sha: null,
    };
  }
  return {
    kind: "unreadable",
    enabled: true,
    gate: "enforced",
    outcome: "action_required",
    headline: REVIEW_UNREADABLE_HEADLINE,
    tone: "warn",
    reasons: [],
    start_offered: false,
    review_id: null,
    head_sha: null,
  };
}

/** One request of a list, with the dataset columns the derivation reads. */
export interface ReviewListItem {
  request: ReviewRequestFields;
  dataset: ReviewDatasetFields | null;
}

/** How many requests of a list derive at once: each can ask D1 for up to two live facts. */
export const LIST_CONCURRENCY = 8;

/**
 * The summaries of a whole list, in order, at a cost that does not grow with what each row needs.
 *
 *  - The review in force of every row is read in batches of {@link MAX_KEYS_PER_READ} requests (one
 *    statement each), never once per row. A request that is over, or that has started
 *    publishing, then needs no other statement: its live facts are not read
 *    ({@link LIVE_FACT_STATUSES}). A stopped `approving` run reads up to two live-fact
 *    statements, like a `requested` one.
 *  - The rest of a row's derivation (a version row, an earlier anonymous request) runs
 *    {@link LIST_CONCURRENCY} rows at a time, so a long list does not put a request for every row
 *    in flight at once.
 *  - Each row stands alone. A read that fails costs the rows it was for, and nothing else: they
 *    read as {@link unreadableSummary} (never a pass), only ids and a closed class are logged, and
 *    the list still answers.
 */
export async function publicationReviewSummaries(
  env: Bindings,
  items: readonly ReviewListItem[],
  nowMs: number = Date.now(),
): Promise<PublicationReviewSummary[]> {
  const enabled = reviewEnabled(env);
  const keys = items.map((i) => reviewKeyOf(i.request, i.dataset));

  // The review rows, one statement per chunk. A chunk that cannot be read marks its rows.
  const rows = new Map<string, PublicationReviewRow>();
  const unreadable = new Set<number>();
  const wanted = keys.flatMap((key, index) => (key === null ? [] : [{ key, index }]));
  for (let i = 0; i < wanted.length; i += MAX_KEYS_PER_READ) {
    const chunk = wanted.slice(i, i + MAX_KEYS_PER_READ);
    try {
      const got = await readReviewsByKeys(
        env.DB,
        chunk.map((w) => w.key),
      );
      for (const [text, row] of got) rows.set(text, row);
    } catch (err) {
      console.error(
        `[publication-review] could not read the reviews of ${chunk.length} requests for the list (${errorWords(err)})`,
      );
      for (const w of chunk) unreadable.add(w.index);
    }
  }

  const summaries: PublicationReviewSummary[] = [];
  for (let start = 0; start < items.length; start += LIST_CONCURRENCY) {
    const batch = items.slice(start, start + LIST_CONCURRENCY);
    summaries.push(
      ...(await Promise.all(
        batch.map(async (item, offset) => {
          const index = start + offset;
          if (unreadable.has(index)) return unreadableSummary(enabled, item.request.dataset_id);
          try {
            const key = keys[index];
            return summaryOf(
              await derivePublicationReview({
                env,
                nowMs,
                request: item.request,
                dataset: item.dataset,
                reviewRow: key === null ? undefined : (rows.get(reviewKeyText(key)) ?? null),
              }),
            );
          } catch (err) {
            console.error(
              `[publication-review] could not read the review of request ${item.request.id} for the list (${errorWords(err)})`,
            );
            return unreadableSummary(enabled, item.request.dataset_id);
          }
        }),
      )),
    );
  }
  return summaries;
}

// ---------------------------------------------------------------------------------------------
// The detail view
// ---------------------------------------------------------------------------------------------

/** The most past reviews the detail view lists; one more is read to know whether there were others. */
export const HISTORY_LIMIT = 20;

const REASON_CODE_SET: ReadonlySet<string> = new Set(REASON_CODES);

/**
 * The reason codes an override was given for. Stored as a JSON array of codes, or a list joined
 * by commas; anything that is not a known code is dropped, so an unreadable override covers
 * nothing rather than everything.
 */
export function overrideReasonsOf(raw: string | null): ReasonCode[] {
  if (raw === null) return [];
  let items: unknown;
  try {
    items = JSON.parse(raw);
  } catch {
    items = raw.split(",");
  }
  if (!Array.isArray(items)) return [];
  const known = items
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x): x is ReasonCode => REASON_CODE_SET.has(x));
  return [...new Set(known)];
}

/**
 * The reasons in the shared words, each with the statement of it, its cure for this dataset
 * without a command or a flag (`neutralCureOf`), the command the terminal's cure names
 * (`commandOf`), and the whole reason as the one line `description.lines` prints for it
 * (`reasonLine`, which needs the report of the review in force for a failed question's findings):
 * the detail's `reasons`, and what the approval gate's refusal carries, so the two say the same
 * thing. A web page prints `statement` and `cure`; `command` and `line` are the terminal's. Every
 * reason carries `statement` and `command` always, because a page reads a missing `statement` as
 * a Worker that predates it. `cure` and `command` follow `startable`, not the detail's
 * `start_offered`, by design (see `neutralCureOf`). The report is required so that a caller cannot
 * leave it out by accident: one that has no report passes `null`, and the line then lacks only
 * what the report adds.
 */
export function reasonViewsOf(
  reasons: readonly Reason[],
  datasetId: string,
  startable: boolean,
  report: PublicationReviewReport | null,
): ReasonView[] {
  return reasons.map((r) => {
    const rule = REASONS[r.code];
    return {
      code: r.code,
      class: rule.class,
      cleared_by: rule.clearedBy,
      detail: r.detail,
      statement: reasonStatement(r, report),
      sentence: rule.sentence,
      cure: neutralCureOf(r.code, datasetId, startable),
      command: commandOf(r.code, datasetId, startable),
      line: reasonLine(r, datasetId, report, startable),
    };
  });
}

function recordOf(row: PublicationReviewRow, view: ReviewRowView): PublicationReviewRecord {
  const report = reportOf(view);
  const detail: PublicationDeclineDetail | PublicationRunError | null = isPublicationDeclineDetail(
    row.detail,
  )
    ? row.detail
    : isPublicationRunError(row.detail)
      ? row.detail
      : null;
  return {
    id: row.id,
    head_sha: row.headSha,
    anonymous: row.anonymous,
    state: isPublicationReviewState(row.state) ? row.state : "errored",
    detail,
    stored_verdict: isPublicationOutcome(row.verdict) ? row.verdict : null,
    model: report?.model ?? null,
    version: report?.evidence.version ?? null,
    created_at: row.createdAt,
    decided_at: row.decidedAt,
    started_by: row.startedBy,
    override:
      row.overrideBy !== null && row.overrideAt !== null
        ? {
            by: row.overrideBy,
            at: row.overrideAt,
            reasons: overrideReasonsOf(row.overrideReasons),
          }
        : null,
    questions: report === null ? null : answersOf(report).answers,
    fact_notes: report === null ? [] : factNotesOf(report),
    findings: (report?.findings ?? []).map((f) => ({
      question: f.question,
      severity: f.severity,
      code: f.code,
      label: PUBLICATION_FINDING_LABEL[f.code],
      document: f.document,
      document_label: f.document === null ? null : DOCUMENT_LABEL[f.document],
      note: f.note,
    })),
    summary: report === null || report.summary === "" ? null : report.summary,
    evidence: report?.evidence ?? null,
  };
}

function historyEntryOf(row: PublicationReviewRow): PublicationReviewHistoryEntry {
  const state: PublicationReviewState = isPublicationReviewState(row.state) ? row.state : "errored";
  return {
    id: row.id,
    head_sha: row.headSha,
    anonymous: row.anonymous,
    state,
    stored_verdict: isPublicationOutcome(row.verdict) ? row.verdict : null,
    created_at: row.createdAt,
    decided_at: row.decidedAt,
  };
}

/**
 * Read one request with its dataset, the columns the derivation needs and no others (never a
 * nonce). The approval gate reads the request through this, so it and the detail view derive from
 * the same read. Null when there is no such request; throws when the read fails.
 */
export async function readReviewContext(
  env: Bindings,
  requestId: number,
): Promise<{ request: ReviewRequestFields; dataset: ReviewDatasetFields | null } | null> {
  const r = await env.DB.prepare(
    `SELECT pr.id, pr.dataset_id, pr.status, pr.block_reason, pr.anonymous,
            pr.identifier_screen_status, pr.identifier_screen_report, pr.identifier_screen_ack_by,
            pr.identifier_screen_ack_at, pr.steps_completed,
            d.dataset_id AS ds_id, d.source AS ds_source, d.is_exemplar AS ds_is_exemplar,
            d.concept_doi AS ds_concept_doi, d.ezid_status AS ds_ezid_status,
            d.first_published_at AS ds_first_published_at, d.total_files AS ds_total_files
       FROM publication_requests pr
       LEFT JOIN datasets d ON d.dataset_id = pr.dataset_id
      WHERE pr.id = ?`,
  )
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!r) return null;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const whole = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    request: {
      id: Number(r.id),
      dataset_id: String(r.dataset_id),
      status: String(r.status),
      block_reason: text(r.block_reason),
      anonymous: whole(r.anonymous),
      identifier_screen_status: text(r.identifier_screen_status),
      identifier_screen_report: text(r.identifier_screen_report),
      identifier_screen_ack_by: whole(r.identifier_screen_ack_by),
      identifier_screen_ack_at: text(r.identifier_screen_ack_at),
      steps_completed: text(r.steps_completed),
    },
    dataset:
      r.ds_id === null || r.ds_id === undefined
        ? null
        : {
            source: text(r.ds_source),
            is_exemplar: whole(r.ds_is_exemplar),
            concept_doi: text(r.ds_concept_doi),
            ezid_status: text(r.ds_ezid_status),
            first_published_at: text(r.ds_first_published_at),
            total_files: whole(r.ds_total_files),
          },
  };
}

/**
 * `GET /admin/publish/:id/review`: the review of the dataset's active request, with its history.
 * Null when the dataset has no active request. Throws when a read fails.
 */
export async function publicationReviewDetail(
  env: Bindings,
  datasetId: string,
  nowMs: number = Date.now(),
): Promise<PublicationReviewDetail | null> {
  const active = await env.DB.prepare(`SELECT id ${ACTIVE_REQUEST_TAIL_SQL}`)
    .bind(datasetId)
    .first<{ id: number }>();
  if (!active) return null;
  const ctx = await readReviewContext(env, active.id);
  if (!ctx) return null;
  const d = await derivePublicationReview({ env, nowMs, ...ctx });
  const past = await listReviewsOfRequest(env.DB, ctx.request.id, HISTORY_LIMIT + 1);
  return {
    environment: isNonProductionEnv(env) ? "non-production" : "production",
    enabled: d.enabled,
    dataset_id: ctx.request.dataset_id,
    request_id: ctx.request.id,
    request_status: ctx.request.status,
    anonymous: ctx.request.anonymous === 1,
    // The same reading of the screen the list row carries (`screenView`), so the two cannot say
    // different things about one request.
    identifier_screen: screenView(
      ctx.request.dataset_id,
      ctx.request.identifier_screen_status,
      ctx.request.identifier_screen_report,
    ),
    // Who and when, never why: the reason is the administrator's own text and stays in the row.
    screen_acknowledgment:
      ctx.request.identifier_screen_ack_by !== null && ctx.request.identifier_screen_ack_at !== null
        ? { by: ctx.request.identifier_screen_ack_by, at: ctx.request.identifier_screen_ack_at }
        : null,
    // Not read from the reasons: with the review off they are empty, and a blocked request must
    // still be told apart.
    block_reason: shownBlockReason(ctx.request),
    started_publishing: publishingStanding(ctx.request) === "publishing",
    total_files: ctx.dataset?.total_files ?? null,
    applies: d.applies,
    gate: d.gate,
    outcome: d.outcome,
    // The list row's flag, from the same function, so the detail and the list cannot disagree.
    start_offered: startOfferedFor(d),
    // The screen's gate for an approval, review on or off: `reasons` is empty with the review off
    // and no row, yet the approval is still refused or asked for a reason by the screen.
    screen_gate: d.live.screen.gate,
    reasons: reasonViewsOf(d.reasons, ctx.request.dataset_id, d.startable, reportOf(d.rowView)),
    description: d.description,
    review: d.row === null ? null : recordOf(d.row, d.rowView),
    history: past.slice(0, HISTORY_LIMIT).map(historyEntryOf),
    history_truncated: past.length > HISTORY_LIMIT,
  };
}

// ---------------------------------------------------------------------------------------------
// The mail's section
// ---------------------------------------------------------------------------------------------

/**
 * The review's part of the publication-request email: the headline, each reason in its shared
 * words, the next command and the standing line. Never the model's summary, and never any text
 * the model wrote.
 *
 * Null when there is nothing to add: the request is gone, or the review is off and has no row
 * (or its rows cannot be read), which leaves the mail exactly as it was before the review
 * existed. A request the review does not apply to says so while the review is on, as the screen's
 * section does for a sandbox.
 *
 * **The mail ages a dispatched row by the deadline, the lists by the deadline plus a tick.** The
 * mail lease frees a held request when its review is older than
 * {@link PUBLICATION_REVIEW_DEADLINE_MINUTES} (`reviewInFlightSql`), and the mail then goes out and
 * is marked sent, so what it says about the review has to be true at that moment and cannot be
 * corrected later by the watchdog, whose own mail would find nothing left to send. A row past the
 * deadline is therefore read here as one that did not report, whether or not a watchdog has marked
 * it yet, ran, or reached it among the rows it takes in a tick. The lists and the detail have no
 * lease to explain and keep the longer window (ADR 0102, section 7: the deadline plus one tick),
 * so they do not say "did not report" about a review the watchdog is about to close. (The lease
 * reads SQLite's clock and this the Worker's, so a row within their skew of the deadline can be
 * read either way: a matter of milliseconds.)
 *
 * Never throws: a read that fails is logged (ids and fixed words only) and, while the review is
 * on, the mail says the review could not be read, so an administrator is never told less than the
 * truth.
 */
export async function publicationReviewEmailSection(
  env: Bindings,
  requestId: number,
  nowMs: number = Date.now(),
): Promise<PublicationReviewSection | null> {
  let datasetId = "";
  try {
    const ctx = await readReviewContext(env, requestId);
    if (!ctx) return null;
    datasetId = ctx.request.dataset_id;
    const d = await derivePublicationReview({
      env,
      nowMs,
      ...ctx,
      overdueMinutes: PUBLICATION_REVIEW_DEADLINE_MINUTES,
    });
    if (!d.enabled && d.row === null) return null;
    return {
      headline: d.description.headline,
      tone: d.description.tone,
      lines: d.description.lines,
      next: d.description.next ?? undefined,
    };
  } catch (err) {
    console.error(
      `[publication-review] could not read the review of request ${requestId} for the admin email (${errorWords(err)})`,
    );
    // With the review off there is nothing to add to the mail unless a stored review shows as
    // advice, and the mail must then be exactly what it was before the review existed: a deploy
    // before the review's migration is applied has no table to read, and no administrator should
    // be told a review "could not be read" that nothing was ever going to start. With it on, the
    // review is a gate, and not knowing its state is said so.
    if (!reviewEnabled(env)) return null;
    const unreadable = describeUnreadableReview(datasetId);
    return {
      headline: unreadable.headline,
      tone: unreadable.tone,
      lines: unreadable.lines,
      next: unreadable.next ?? undefined,
    };
  }
}
