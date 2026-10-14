// Publication-review fixtures for backend tests (ADR 0102).
//
// Every review test needs a native request whose identifier screen reported a commit, and review
// rows in each state with reports a job could really have posted. These helpers write REAL rows:
// a report is built here and then run through the production parser (`parsePublicationReviewReport`)
// before it is stored, its verdict is derived by the production `verdictOf(reportReasons(...))`,
// and a screen report is built by the production screen parser. Nothing bypasses a rule; a body
// the parser refuses throws here, in the test that asked for it.

import type { Database } from "bun:sqlite";
import { type ScreenState, parseScreenReport } from "../../../shared/identifier-screen-report";
import {
  type PublicationOutcome,
  type PublicationReviewEvidence,
  type PublicationReviewState,
  parsePublicationReviewReport,
  reportReasons,
  verdictOf,
} from "../../../shared/publication-review";
import { PUBLICATION_STEPS } from "../../../shared/publication-steps";
import { hashApiKey } from "../../src/services/token";
import { SCREENED_HEAD, cleanScreenReportBody, markScreen } from "./identifier-screen";

export { SCREENED_HEAD };

/** Every step but the two logged no-ops: a run the gates let through reaches `published`. */
export const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

/** Words a model wrote: they must reach a person through the detail view and never through a list or a mail. */
export const SUMMARY_SENTINEL = "SUMMARY-SENTINEL-the-model-wrote-this";
export const NOTE_SENTINEL = "NOTE-SENTINEL-the-model-wrote-this-too";

/**
 * A report whose first question failed with one blocker finding, and whose model wrote the two
 * sentinels above. Parsed by the production parser before it is returned, like every report here.
 */
export function failingReport(head: string = SCREENED_HEAD): Record<string, unknown> {
  return goodPublicationReport({
    summary: SUMMARY_SENTINEL,
    questions: {
      complete_and_honest: "fail",
      meets_standards: "pass",
      authors_and_license: "pass",
      name_adequate: "pass",
    },
    findings: [
      {
        question: "complete_and_honest",
        severity: "blocker",
        code: "readme_mismatch",
        document: "readme",
        note: NOTE_SENTINEL,
      },
    ],
    evidence: evidenceFor(head),
  });
}

/** The visible text of a mail: tags dropped, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/**
 * An approved user with `role` and a bearer key, returning the user's id. The email is
 * `<username>@example.org` unless told otherwise, so nothing leaves the machine.
 */
export async function seedUser(
  db: Database,
  username: string,
  role: string,
  key: string,
  over: { email?: string; givenName?: string; familyName?: string } = {},
): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, ?, ?)`,
    [
      username,
      over.email ?? `${username}@example.org`,
      role,
      over.givenName ?? "Ada",
      over.familyName ?? "Lovelace",
    ],
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

/** An evidence block as the job would post it for a clean, named release of `head`. */
export function evidenceFor(
  head: string = SCREENED_HEAD,
  anonymous = false,
  over: Partial<PublicationReviewEvidence> = {},
): Record<string, unknown> {
  return {
    head,
    anonymous,
    version: "1.0.0",
    version_shape: "ok",
    tag: "absent",
    bids: "pass",
    minimums: "met",
    minimum_failures: [],
    name_length: 48,
    license_field: true,
    authors_count: 2,
    placeholder_authors: anonymous ? 2 : 0,
    documents: {
      readme: "sent",
      dataset_description: "sent",
      changes: "sent",
      license: "sent",
      participants_json: "absent",
    },
    withheld_findings: {},
    description_keys_shown: 9,
    description_keys_not_shown: 1,
    summary: {
      subjects: 4,
      sessions: 0,
      recordings: 4,
      datatypes: ["eeg"],
      formats: { ".edf": 4 },
      has_derivatives: false,
      has_sourcedata: false,
      has_code: false,
      sampling_rates_hz: [256],
      channel_counts: [32],
      sidecars_read: 4,
      sidecars_total: 4,
    },
    ...over,
  };
}

/**
 * A report body as the job would post it: every question passed, no finding, clean evidence of
 * `SCREENED_HEAD`, unless `over` says otherwise. It is checked by the production parser before it
 * is returned, so a test never posts a body the job could not have built.
 */
export function goodPublicationReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    v: 1,
    model: "claude-haiku-5-5",
    questions: {
      complete_and_honest: "pass",
      meets_standards: "pass",
      authors_and_license: "pass",
      name_adequate: "pass",
    },
    findings: [],
    summary: "The README describes the recordings, how they were made and how to use them.",
    steering: false,
    evidence: evidenceFor(),
    ...over,
  };
  parsePublicationReviewReport(body);
  return body;
}

export interface SeedReview {
  requestId: number;
  datasetId: string;
  head?: string;
  anonymous?: boolean;
  state: PublicationReviewState;
  /** The closed word of a declined or errored row. */
  detail?: string;
  /** A report body, parsed before it is stored. Defaults to {@link goodPublicationReport} for a reported row. */
  report?: Record<string, unknown>;
  /** A report column stored as given, unparsed: for the "no longer parses" case only. */
  rawReport?: string;
  /** The verdict column. Defaults to the one the Worker derives from the report. */
  verdict?: PublicationOutcome;
  /** Defaults to the request's own `requested_by`. */
  requestedBy?: number;
  startedBy?: number | null;
  createdMinutesAgo?: number;
  /** Defaults to a fresh random nonce for a row that may still be answered, and NULL otherwise. */
  nonce?: string | null;
  claimed?: boolean;
  attempts?: number;
  /**
   * An override recorded on the row, as the approval gate writes it: the administrator and the
   * reason codes it was given for, stored as a JSON array. All three columns or none (the
   * migration's CHECKs). Left out, the row has none.
   */
  override?: { by: number; reasons: readonly string[] };
}

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Insert a review row the way the Worker leaves it in `state`, and return its id. A `report` goes
 * through `parsePublicationReviewReport` before it is stored, and the default verdict is
 * `verdictOf(reportReasons(parsed))`, exactly as the result route stores it. The migration's CHECKs
 * still apply, so asking for an impossible row throws.
 */
export function seedPublicationReview(db: Database, r: SeedReview): number {
  const head = r.head ?? SCREENED_HEAD;
  const anonymous = r.anonymous ?? false;
  const waiting = r.state === "dispatched" || r.state === "unreported";
  let report: string | null = null;
  let verdict: PublicationOutcome | null = null;
  if (r.state === "reported") {
    if (r.rawReport !== undefined) {
      report = r.rawReport;
      verdict = r.verdict ?? "pass";
    } else {
      const parsed = parsePublicationReviewReport(
        r.report ?? goodPublicationReport({ evidence: evidenceFor(head, anonymous) }),
      );
      report = JSON.stringify(parsed);
      verdict = r.verdict ?? verdictOf(reportReasons(parsed));
    }
  }
  const minutes = Math.max(0, Math.floor(r.createdMinutesAgo ?? 0));
  const row = db
    .query<{ id: number }, (string | number | null)[]>(
      `INSERT INTO publication_reviews
         (request_id, dataset_id, head_sha, anonymous, requested_by, started_by, state, verdict,
          detail, report, nonce, claimed_at, attempts, created_at, decided_at,
          override_by, override_at, override_reasons)
       VALUES (?, ?, ?, ?,
               COALESCE(?, (SELECT requested_by FROM publication_requests WHERE id = ?), 1),
               ?, ?, ?, ?, ?, ?,
               CASE WHEN ? = 1 THEN datetime('now', ?) END,
               ?, datetime('now', ?),
               CASE WHEN ? = 'dispatched' THEN NULL ELSE datetime('now', ?) END,
               ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, ?)
       RETURNING id`,
    )
    .get(
      r.requestId,
      r.datasetId,
      head,
      anonymous ? 1 : 0,
      r.requestedBy ?? null,
      r.requestId,
      r.startedBy ?? null,
      r.state,
      verdict,
      r.detail ?? null,
      report,
      r.nonce === undefined ? (waiting ? randomHex(16) : null) : r.nonce,
      r.claimed ? 1 : 0,
      `-${minutes} minutes`,
      r.attempts ?? 1,
      `-${minutes} minutes`,
      r.state,
      `-${minutes} minutes`,
      r.override?.by ?? null,
      r.override?.by ?? null,
      r.override ? JSON.stringify(r.override.reasons) : null,
    );
  if (!row) throw new Error("seedPublicationReview inserted nothing");
  return row.id;
}

/**
 * Record an override on a review row that exists already, as the approval gate writes it: the
 * administrator, the instant (now, unless `at` says otherwise) and the reason codes, all three at
 * once because the migration's CHECKs need them together. A row created in the same test takes the
 * same override through {@link seedPublicationReview}'s `override` option instead.
 */
export function setOverride(
  db: Database,
  reviewId: number,
  by: number,
  reasons: readonly string[],
  at?: string,
): void {
  db.run(
    `UPDATE publication_reviews
        SET override_by = ?, override_at = COALESCE(?, datetime('now')), override_reasons = ?
      WHERE id = ?`,
    [by, at ?? null, JSON.stringify(reasons), reviewId],
  );
}

/** A screen report body that the production parser accepts for `status`, at `head`. */
export function screenReportBodyFor(
  datasetId: string,
  status: string,
  head: string = SCREENED_HEAD,
): Record<string, unknown> {
  if (status === "error" || status === "unreported") {
    return {
      version: 1,
      scanner: null,
      head: null,
      error: status === "error" ? "workflow-failed" : "no-report-in-time",
    };
  }
  const body = cleanScreenReportBody(datasetId, head, status);
  const scan = body.scan as Record<string, unknown>;
  // The parser holds a verdict to its own counts: no recordings means no EDF/BDF headers, and an
  // unchecked scan is an incomplete one.
  if (status === "no-recordings") {
    scan.files = { total: 10, edf_bdf: 0, header_read: 0, header_read_failed: 0 };
  }
  if (status === "unchecked") {
    scan.incomplete = true;
    scan.incomplete_reasons = ["edf-headers-unread"];
    scan.files = { total: 10, edf_bdf: 4, header_read: 3, header_read_failed: 1 };
  }
  return body;
}

/** States whose report `markScreen`'s clean body cannot stand for. */
const NEEDS_OWN_BODY: ReadonlySet<string> = new Set([
  "no-recordings",
  "unchecked",
  "error",
  "unreported",
]);

export interface SeedScreenedRequest {
  datasetId: string;
  head?: string;
  /** The stored screen state; `pending` stores no report. Default `clean`. */
  status?: ScreenState;
  anonymous?: boolean;
  /** `datasets.source`; `openneuro` makes a mirror, which the review does not apply to. */
  source?: string | null;
  isExemplar?: 0 | 1;
  /** The depositor; a member account is created for the dataset when absent. */
  requestedBy?: number;
  /** The request's status. Default `requested`. */
  requestStatus?: "requested" | "approving" | "blocked" | "denied" | "published";
  blockReason?: string | null;
  /** Whether the screen's admin mail has gone out. Default true, as `markScreen` leaves it. */
  mailed?: boolean;
}

/**
 * A native, named request (unless told otherwise) whose identifier screen reported `status` at
 * `head`. Creates the depositor and the dataset when they do not exist; the screen report is the
 * production parser's output, so it is exactly what the screen callback would have stored.
 */
export function seedScreenedRequest(
  db: Database,
  o: SeedScreenedRequest,
): { requestId: number; userId: number } {
  const status = o.status ?? "clean";
  const head = o.head ?? SCREENED_HEAD;
  let userId = o.requestedBy;
  if (userId === undefined) {
    const username = `depositor_${o.datasetId}`;
    db.run(
      `INSERT OR IGNORE INTO users (username, email, password_hash, status, role, email_verified,
                                    service_access, given_name, family_name)
       VALUES (?, ?, 'x', 'approved', 'member', 1, 1, 'Ada', 'Lovelace')`,
      [username, `${username}@example.org`],
    );
    userId = db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
      .get(username)?.id as number;
  }
  db.run(
    `INSERT OR IGNORE INTO datasets (dataset_id, name, owner_user_id, status, visibility,
                                     is_sandbox, github_repo, source, is_exemplar)
     VALUES (?, ?, ?, 'active', 'private', 0, ?, ?, ?)`,
    [
      o.datasetId,
      `A sufficiently descriptive title for ${o.datasetId}`,
      userId,
      `nemarDatasets/${o.datasetId}`,
      o.source ?? null,
      o.isExemplar ?? 0,
    ],
  );
  const request = db
    .query<{ id: number }, (string | number | null)[]>(
      `INSERT INTO publication_requests (dataset_id, requested_by, status, block_reason, anonymous)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      o.datasetId,
      userId,
      o.requestStatus ?? "requested",
      o.blockReason ?? null,
      o.anonymous ? 1 : 0,
    );
  const requestId = request?.id as number;
  if (status === "pending") {
    db.run(
      `UPDATE publication_requests
          SET identifier_screen_status = 'pending', identifier_screen_nonce = 'n',
              identifier_screen_dispatched_at = datetime('now')
        WHERE id = ?`,
      [requestId],
    );
  } else if (!NEEDS_OWN_BODY.has(status)) {
    // The shared helper's body parses for these states as it is.
    markScreen(db, requestId, o.datasetId, { status, head });
  } else {
    const report = parseScreenReport(screenReportBodyFor(o.datasetId, status, head));
    db.run(
      `UPDATE publication_requests
          SET identifier_screen_status = ?, identifier_screen_report = ?,
              identifier_screen_at = datetime('now'), identifier_screen_emailed_at = datetime('now')
        WHERE id = ?`,
      [status, JSON.stringify(report), requestId],
    );
  }
  if (o.mailed === false) {
    db.run(
      `UPDATE publication_requests
          SET identifier_screen_emailed_at = NULL, identifier_screen_mail_claimed_at = NULL
        WHERE id = ?`,
      [requestId],
    );
  }
  return { requestId, userId };
}
