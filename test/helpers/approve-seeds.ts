/**
 * The requests and reviews the approval's tests seed (`admin-publish-approve-cli.test.ts`,
 * `admin-publish-approve-agreement.test.ts`), written as real rows over the harness's database:
 * the review reports are the production parser's output (`goodPublicationReport` parses before it
 * returns), and the screen's report is the production screen parser's. Nothing here decides
 * anything; each helper only puts a state in the database for the real command and the real Worker
 * to read.
 */

import type { Database } from "bun:sqlite";
import { SCREENED_HEAD } from "../../backend/test/helpers/identifier-screen";
import {
  DONE,
  type SeedScreenedRequest,
  evidenceFor,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
} from "../../backend/test/helpers/publication-review";

export const DATASET = "nm000460";

/** A request waiting for its decision (or in `over.requestStatus`), with every step but the two no-ops done. */
export function seedGolden(db: Database, over: Partial<SeedScreenedRequest> = {}): number {
  const { requestId } = seedScreenedRequest(db, { datasetId: DATASET, ...over });
  db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(DONE),
    requestId,
  ]);
  return requestId;
}

/**
 * A request waiting for its decision that has run no step. The golden seed above carries every
 * step but the two no-ops, so that an approval can resume to its end with no network, and a denial
 * is refused for a request with a step done outside the validation-only ones (the dataset may be
 * public): a test that denies seeds this one.
 */
export function seedUnstarted(db: Database, over: Partial<SeedScreenedRequest> = {}): number {
  return seedScreenedRequest(db, { datasetId: DATASET, ...over }).requestId;
}

/** The review in force of `requestId`, reported with `report` (a pass by default); returns its id. */
export function seedReport(
  db: Database,
  requestId: number,
  report?: Record<string, unknown>,
): number {
  return seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported", report });
}

/** A report with the given evidence; every question passes. */
export const reportWith = (evidence: Parameters<typeof evidenceFor>[2]) =>
  goodPublicationReport({ evidence: evidenceFor(SCREENED_HEAD, false, evidence) });

/** A failed question and no Version: two override-class reasons (`question_failed`, `version_missing`). */
export const twoReasons = () => ({
  ...failingReport(),
  evidence: evidenceFor(SCREENED_HEAD, false, { version: null, version_shape: "missing" }),
});

/** A report whose evidence failed ADR 0026's minimums: a hard reason (`submission_minimum_failed`). */
export const hardReport = () =>
  reportWith({ minimums: "failed", minimum_failures: ["name_too_short"], name_length: 5 });

/**
 * A failed question over evidence that withheld two documents for findings: `question_failed`,
 * `text_withheld` and the `question_unknown` the withheld README leaves. The model's summary and
 * its finding's note are the usual sentinels.
 */
export const withheldReport = () => ({
  ...failingReport(),
  evidence: evidenceFor(SCREENED_HEAD, false, {
    documents: {
      readme: "withheld_finding",
      dataset_description: "sent",
      changes: "absent",
      license: "sent_cut",
      participants_json: "withheld_finding",
    },
    withheld_findings: { "edf-patient-name": 2, "local-user-path": 1 },
  }),
});
