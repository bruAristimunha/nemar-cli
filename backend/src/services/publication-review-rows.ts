/**
 * The publication review's rows (ADR 0102, migration 0096): how a `publication_reviews` row is
 * read, and the SQL fragments the statements that must be atomic share.
 *
 * Read-only and dependency-light on purpose. The write path (start, claim, store, watchdog) and the
 * read path (the views and the mail) both import this module and nothing of each other, so the
 * row's shape and the fragments below are declared once.
 *
 * **The nonce never leaves the callback module.** {@link ROW_COLUMNS} lists every column but
 * `nonce`, and every read here selects exactly those columns, so no view, route or log can carry a
 * nonce by selecting the whole row.
 *
 * **A stored report is re-parsed, never trusted.** {@link rowViewOf} runs the stored report through
 * the shared parser every time it is read, and a row whose report no longer parses reads as one
 * that could not be read back, which `reasonsOf` never turns into a pass.
 *
 * **The screen is read the gate's way.** Every TypeScript decision about a request's screen goes
 * through `readStoredState`, `readStoredReport` (`identifier-screen-stored.ts`) and `screenGate`.
 * Two statements must decide in SQL, because each is a single conditional statement: the claim and
 * the mail lease. They read the screened head with {@link screenedHeadSql} and the states with
 * {@link REVIEWABLE_SCREEN_STATES_SQL}, which is derived from `screenGate` and never typed by hand.
 * The two readings can differ only for a report edited by hand, which `readStoredReport` reads as no
 * report (so the gate says "rerun") while `json_extract` may still find a head in it; the claim
 * then also needs the edited row to keep a reviewable state. That risk is accepted.
 */

import {
  DATASET_STATUSES,
  type ScreenState,
  screenGate,
} from "../../../shared/identifier-screen-report.js";
import {
  PUBLICATION_REVIEW_DEADLINE_MINUTES,
  type PublicationReviewReport,
  PublicationReviewReportError,
  REVIEW_OVERDUE_VIEW_MINUTES,
  type ReviewRowView,
  isPublicationDeclineDetail,
  isPublicationOutcome,
  isPublicationReviewState,
  isPublicationRunError,
  parsePublicationReviewReport,
} from "../../../shared/publication-review.js";

export interface PublicationReviewRow {
  id: number;
  requestId: number;
  datasetId: string;
  headSha: string;
  anonymous: boolean;
  requestedBy: number;
  startedBy: number | null;
  /**
   * The words as the database returns them, never narrowed here: the migration's CHECKs keep them
   * closed, but a row edited by hand, or written by another build, can hold another word. A reader
   * narrows with `isPublicationReviewState` and `isPublicationOutcome` and treats a word that does
   * not narrow as unreadable ({@link rowViewOf}), never as a state or a verdict.
   */
  state: string;
  verdict: string | null;
  detail: string | null;
  report: string | null;
  claimedAt: string | null;
  attempts: number;
  overrideBy: number | null;
  overrideAt: string | null;
  overrideReasons: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Every column but `nonce`, which never leaves the callback module. */
export const ROW_COLUMNS =
  "id, request_id, dataset_id, head_sha, anonymous, requested_by, started_by, state, verdict, " +
  "detail, report, claimed_at, attempts, override_by, override_at, override_reasons, " +
  "created_at, decided_at";

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A row as D1 returns it, in the shape the services use. The words are checked by {@link rowViewOf}. */
export function toRow(raw: Record<string, unknown>): PublicationReviewRow {
  return {
    id: num(raw.id),
    requestId: num(raw.request_id),
    datasetId: String(raw.dataset_id),
    headSha: String(raw.head_sha),
    anonymous: num(raw.anonymous) === 1,
    requestedBy: num(raw.requested_by),
    startedBy: numOrNull(raw.started_by),
    state: String(raw.state),
    verdict: strOrNull(raw.verdict),
    detail: strOrNull(raw.detail),
    report: strOrNull(raw.report),
    claimedAt: strOrNull(raw.claimed_at),
    attempts: num(raw.attempts),
    overrideBy: numOrNull(raw.override_by),
    overrideAt: strOrNull(raw.override_at),
    overrideReasons: strOrNull(raw.override_reasons),
    createdAt: String(raw.created_at),
    decidedAt: strOrNull(raw.decided_at),
  };
}

export async function readReview(db: D1Database, id: number): Promise<PublicationReviewRow | null> {
  const r = await db
    .prepare(`SELECT ${ROW_COLUMNS} FROM publication_reviews WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  return r ? toRow(r) : null;
}

/** The row of one (request, screened commit, kind of release): the review in force when they are the request's. */
export async function readReviewByKey(
  db: D1Database,
  requestId: number,
  headSha: string,
  anonymous: boolean,
): Promise<PublicationReviewRow | null> {
  const r = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM publication_reviews
        WHERE request_id = ? AND head_sha = ? AND anonymous = ?`,
    )
    .bind(requestId, headSha, anonymous ? 1 : 0)
    .first<Record<string, unknown>>();
  return r ? toRow(r) : null;
}

/** The coordinates of the review in force: a request, the commit its screen read and its release kind. */
export interface ReviewKey {
  requestId: number;
  headSha: string;
  anonymous: boolean;
}

/** The text a key is looked up by in the map {@link readReviewsByKeys} returns. */
export function reviewKeyText(key: ReviewKey): string {
  return `${key.requestId}:${key.headSha}:${key.anonymous ? 1 : 0}`;
}

/**
 * The most reviews one batched read takes. A read binds two values for each (the request and its
 * commit), and D1 allows 100 bound values in a statement, so 45 keeps it inside the limit.
 */
export const MAX_KEYS_PER_READ = 45;

/**
 * The review in force of several requests in ONE statement, for a list that would otherwise ask
 * once per row. Returns the rows of those requests at those commits, keyed by
 * {@link reviewKeyText}; a key with no row is simply absent, and a caller looks each up by its
 * exact key (the statement matches the request and the commit sets independently, so it may also
 * return a row of another pairing, which no lookup asks for). At most {@link MAX_KEYS_PER_READ}
 * keys: the caller chunks, so that a failed read costs one chunk and not the list.
 */
export async function readReviewsByKeys(
  db: D1Database,
  keys: readonly ReviewKey[],
): Promise<Map<string, PublicationReviewRow>> {
  const found = new Map<string, PublicationReviewRow>();
  if (keys.length === 0) return found;
  if (keys.length > MAX_KEYS_PER_READ) throw new RangeError("too many review keys in one read");
  const ids = [...new Set(keys.map((k) => k.requestId))];
  const heads = [...new Set(keys.map((k) => k.headSha))];
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM publication_reviews
        WHERE request_id IN (${marks(ids.length)}) AND head_sha IN (${marks(heads.length)})`,
    )
    .bind(...ids, ...heads)
    .all<Record<string, unknown>>();
  for (const raw of results ?? []) {
    const row = toRow(raw);
    found.set(reviewKeyText(row), row);
  }
  return found;
}

/** The most rows one history read returns. */
export const MAX_HISTORY_ROWS = 200;

/** A request's reviews, newest first, at most `limit` (clamped to 1 to {@link MAX_HISTORY_ROWS}). */
export async function listReviewsOfRequest(
  db: D1Database,
  requestId: number,
  limit: number,
): Promise<PublicationReviewRow[]> {
  const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), MAX_HISTORY_ROWS) : 1;
  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM publication_reviews
        WHERE request_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .bind(requestId, bounded)
    .all<Record<string, unknown>>();
  return (results ?? []).map(toRow);
}

// ---------------------------------------------------------------------------------------------
// The SQL fragments of the two single-statement decisions
// ---------------------------------------------------------------------------------------------

/** Every value a request's screen state can take: the scanner's verdicts and the Worker's own. */
const SCREEN_STATES: readonly ScreenState[] = [
  "pending",
  ...DATASET_STATUSES,
  "error",
  "unreported",
];

/** Screen states whose gate is clear or acknowledge, derived from `screenGate`, never typed by hand. */
export const REVIEWABLE_SCREEN_STATES: readonly ScreenState[] = SCREEN_STATES.filter((s) => {
  const gate = screenGate(s);
  return gate === "clear" || gate === "acknowledge";
});

/** {@link REVIEWABLE_SCREEN_STATES} as an SQL list: `'clean', 'dates-only', ...`. */
export const REVIEWABLE_SCREEN_STATES_SQL: string = REVIEWABLE_SCREEN_STATES.map((s) => {
  // Closed words of lowercase letters and hyphens; anything else would be SQL, not a word.
  if (!/^[a-z-]+$/.test(s)) throw new Error("a screen state is not a plain word");
  return `'${s}'`;
}).join(", ");

const SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

function alias(name: string): string {
  if (!SQL_ALIAS.test(name)) throw new Error("not an SQL alias");
  return name;
}

/**
 * The screened head of a `publication_requests` row named `name`, for the two statements that must
 * decide in SQL. Every other reader uses `readStoredReport(...)?.head`.
 */
export function screenedHeadSql(name: string): string {
  return `json_extract(${alias(name)}.identifier_screen_report, '$.head')`;
}

/**
 * A whole-second instant as SQLite's `datetime()` text (UTC, no zone), for a statement that must
 * decide at the same instant as a reading made in code. Digits, `-`, `:` and one space by
 * construction (and checked), so it is safe to put in SQL; a value that is not a real instant
 * throws rather than reaching a statement.
 */
export function sqliteInstant(ms: number): string {
  const text = new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) throw new RangeError("not an instant");
  return text;
}

/**
 * True when a review of the request's screened head and flag is dispatched and younger than the
 * deadline: the one condition under which the request's admin mail waits for the review. A row
 * older than the deadline no longer holds the mail, so a review that never reports cannot keep it
 * for good, whether or not a watchdog runs. The mail's own review section reads a dispatched row
 * past this same deadline as one that did not report (`publicationReviewEmailSection`), so what
 * the mail says is true at the moment the lease lets it go.
 *
 * `atMs` is the instant to decide at, in place of the database's own clock. Pass it when a section
 * was built at an instant of the Worker's (the depositor's resend), so the section and the
 * decision cannot straddle the deadline between them; leave it out when the statement IS the
 * moment (the lease, the watchdog).
 */
export function reviewInFlightSql(name: string, atMs?: number): string {
  const a = alias(name);
  const now = atMs === undefined ? "'now'" : `'${sqliteInstant(atMs)}'`;
  return `EXISTS (SELECT 1 FROM publication_reviews AS r
         WHERE r.request_id = ${a}.id
           AND r.anonymous = ${a}.anonymous
           AND r.head_sha = ${screenedHeadSql(a)}
           AND r.state = 'dispatched'
           AND r.created_at >= datetime(${now}, '-${PUBLICATION_REVIEW_DEADLINE_MINUTES} minutes'))`;
}

// ---------------------------------------------------------------------------------------------
// What a row stands for
// ---------------------------------------------------------------------------------------------

/** `datetime('now')` text (UTC, no zone), as milliseconds; NaN when it is not that. */
function sqliteTimeMs(text: string): number {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? Date.parse(`${text.replace(" ", "T")}Z`)
    : Number.NaN;
}

/**
 * The stored report re-parsed by the shared parser, or null when it no longer parses or is not
 * about this row. The write path refuses a report whose echoed commit or release kind differs from
 * the row's (`evidence_mismatch`), but the database has no CHECK that says so, so a row written
 * another way (edited by hand, or by an older build) is held to the same rule here: evidence of
 * another commit, or of the other kind of release, is not evidence of THIS review, and a verdict
 * derived from it could be a pass about content nobody reviewed. It reads as one that no longer
 * parses.
 */
function storedReport(row: PublicationReviewRow): PublicationReviewReport | null {
  try {
    const report = parsePublicationReviewReport(JSON.parse(row.report ?? "null"));
    if (report.evidence.head !== row.headSha || report.evidence.anonymous !== row.anonymous) {
      console.warn(
        `[publication-review] review ${row.id}: stored report refused (evidence_mismatch)`,
      );
      return null;
    }
    return report;
  } catch (err) {
    // A report that no longer parses (the contract moved under it, or the column was edited by
    // hand) reads as one that could not be read back. Anything else is a bug and surfaces.
    if (!(err instanceof PublicationReviewReportError || err instanceof SyntaxError)) throw err;
    const word = err instanceof PublicationReviewReportError ? err.code : "not_json";
    console.warn(`[publication-review] review ${row.id}: stored report refused (${word})`);
    return null;
  }
}

/**
 * The row as `reasonsOf` needs it, with every stored word checked again. A dispatched row older
 * than `overdueMinutes` at `nowMs` is overdue, so a dev Worker with no watchdog still says the
 * review did not report. The window is {@link REVIEW_OVERDUE_VIEW_MINUTES} (the deadline plus one
 * watchdog tick) unless a caller says otherwise: the admin mail passes the deadline itself, because
 * it goes out the moment the lease frees it and must say what is true then. A row whose words do
 * not read back is a review that could not run (`report_invalid`), never one that passed.
 */
export function rowViewOf(
  row: PublicationReviewRow,
  nowMs: number,
  overdueMinutes: number = REVIEW_OVERDUE_VIEW_MINUTES,
): ReviewRowView {
  const unreadable = (field: string): ReviewRowView => {
    console.warn(`[publication-review] review ${row.id}: stored ${field} does not read back`);
    return { kind: "errored", detail: "report_invalid" };
  };
  if (!isPublicationReviewState(row.state)) return unreadable("state");
  switch (row.state) {
    case "dispatched": {
      const created = sqliteTimeMs(row.createdAt);
      const overdue = Number.isNaN(created) || nowMs - created > overdueMinutes * 60_000;
      return { kind: "dispatched", overdue };
    }
    case "unreported":
      return { kind: "unreported" };
    case "declined":
      return isPublicationDeclineDetail(row.detail)
        ? { kind: "declined", detail: row.detail }
        : unreadable("detail");
    case "errored":
      return isPublicationRunError(row.detail)
        ? { kind: "errored", detail: row.detail }
        : unreadable("detail");
    case "reported":
      return {
        kind: "reported",
        report: storedReport(row),
        // An unreadable verdict is not a pass: it reads as needing a person.
        stored: isPublicationOutcome(row.verdict) ? row.verdict : "action_required",
      };
  }
}
