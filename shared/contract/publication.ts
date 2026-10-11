/**
 * Publication wire-shape vocabulary (#1255, epic #1250).
 *
 * The two enums here were each hand-duplicated in a backend module and again
 * in the CLI client, which is how a value gets added on one side only. They
 * follow the same pattern as `zarr_status` / `attestation_*` in dataset.ts:
 * declared once in Zod, consumed as a type by both halves.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";

/**
 * ORCID iD: four groups of four digits, last character may be X (checksum).
 *
 * ONE definition (#1255 review item 11). It was previously spelled out
 * separately in the CLI, in the signup schema, in the ORCID service, and not
 * at all in the admin test-fixture route, which checked only `max(19)` and so
 * accepted any 19-character string as an iD.
 */
export const ORCID_ID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** Zod form of {@link ORCID_ID_PATTERN}, with the message users see. */
export const orcidIdSchema = z
  .string()
  .regex(ORCID_ID_PATTERN, "ORCID must be in format 0000-0000-0000-000X");

/**
 * What a public ORCID record lookup produced.
 *
 * `no_public_name` and `lookup_failed` are kept apart for the same reason
 * {@link backfillNameOutcomeSchema} keeps them apart: one is a settled fact
 * about the record and the other is a transient failure, and the advice a
 * user needs differs.
 */
export const orcidNameLookupStatusSchema = z.enum(["found", "no_public_name", "lookup_failed"]);
export type OrcidNameLookupStatus = z.infer<typeof orcidNameLookupStatusSchema>;

/**
 * Why a publication request is blocked (`publication_requests.block_reason`).
 *
 * The column itself is free TEXT (migration 0015) and holds legacy values, so
 * this is the vocabulary a CURRENT backend writes, not a database constraint.
 * Readers must therefore degrade gracefully on an unrecognised value rather
 * than narrow to this union and drop the row -- which is exactly what the
 * backend's BLOCK_MESSAGES lookup does (falling back to a generic sentence)
 * and what the website's admin queue does (rendering the raw code).
 */
export const publicationBlockReasonSchema = z.enum([
  "bids_validation_failed",
  "bids_validation_pending",
  "bids_validation_in_progress",
  /** Legacy: the pre-screen stopped blocking in #756. */
  "prescreen_failed",
  "min_requirements_failed",
  /** #1255: the owner has no researcher name, so a DOI cannot cite them. */
  "owner_name_missing",
  /** Epic #1610 phase 4: the identifier screen found a direct identifier. */
  "identifier_screen_findings",
]);
export type PublicationBlockReason = z.infer<typeof publicationBlockReasonSchema>;

/**
 * The two block reasons that only say BIDS validation has not concluded (no run
 * yet, or one going), as opposed to `bids_validation_failed`. A request blocked
 * for either is waiting, not rejected: the sweep releases it when validation
 * passes, and the CLI reports it as a state. Declared once here for the route,
 * the sweep and the CLI.
 */
export const CI_PENDING_BLOCK_REASONS = [
  "bids_validation_pending",
  "bids_validation_in_progress",
] as const satisfies readonly PublicationBlockReason[];

export type CiPendingReason = (typeof CI_PENDING_BLOCK_REASONS)[number];

/** Is this block reason one of the two that only say validation has not concluded? */
export function isCiPendingReason(reason: unknown): reason is CiPendingReason {
  return (
    typeof reason === "string" && (CI_PENDING_BLOCK_REASONS as readonly string[]).includes(reason)
  );
}

/**
 * `error` code of the 503 a publication request gets when NEMAR could not check
 * BIDS validation status at all (token, workflow deploy, GitHub outage), as
 * opposed to checking and finding no run yet. It is not a block reason, so the
 * vocabulary above is unchanged; the sentence is in `message`, and the CLI's
 * client leads with it ({@link PUBLICATION_REFUSAL_ERROR_CODES}).
 */
export const CI_CHECK_UNAVAILABLE_CODE = "ci_check_unavailable";

/**
 * Codes a publication-request refusal carries in `error` with the human
 * sentence in `message`, so the CLI's client prints the sentence and not the
 * bare token.
 */
export const PUBLICATION_REFUSAL_ERROR_CODES: readonly string[] = [CI_CHECK_UNAVAILABLE_CODE];

/**
 * The codes the identifier screen's refusals carry in `error` (epic #1610,
 * phase 4), with the human sentence in `message`. Declared here so the CLI's
 * client knows to lead with the sentence rather than print a bare token.
 */
export const IDENTIFIER_SCREEN_ERROR_CODES: readonly string[] = [
  /** Resend while the screen still runs: the admins are mailed when it finishes. */
  "identifier_screen_pending",
  /** An approval the screen does not allow (stale, unverifiable, not run, findings). */
  "identifier_screen_not_clear",
  /** A sandbox (xx) dataset, which is not screened. */
  "identifier_screen_not_applicable",
];

/**
 * Per-user outcome of `POST /admin/users/backfill-names` (#1255).
 *
 * `no_public_name` and `lookup_failed` are deliberately distinct: the first is
 * a settled fact about the ORCID record (the owner must act), the second is a
 * transient infrastructure failure (retry the batch). Collapsing them would
 * tell an operator to chase a user over a 503.
 *
 * `write_failed` is the same distinction one step later (#1274). The ORCID
 * read was already wrapped per row, so one unreadable record could not stop
 * the other 600 -- but the UPDATE that followed it was not, so one failed
 * write threw out of the loop, answered a bare 500, and discarded the summary
 * of every row the batch had already filled. The row stays a candidate and the
 * next run retries it, exactly like `lookup_failed`.
 */
export const backfillNameOutcomeSchema = z.enum([
  "filled",
  "would_fill",
  "no_public_name",
  "lookup_failed",
  "write_failed",
]);
export type BackfillNameOutcome = z.infer<typeof backfillNameOutcomeSchema>;
