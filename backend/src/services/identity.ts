/**
 * Identity uniqueness: one person, one account (#1254, epic #1250; ADR 0043).
 *
 * An ORCID iD, an email address (case-insensitively) or a GitHub handle may
 * back at most one LIVE account. Migration 0077 enforces the first two in the
 * database with partial unique indexes; `idx_users_github` (0012) has always
 * enforced the third. This module is the application half: the normalisation
 * every write must apply before it stores an identifier, and the pre-flight
 * lookups that turn a would-be constraint violation into a typed refusal that
 * tells the person what to do instead.
 *
 * WHY ONE MODULE. The rules were previously spelled out at each call site and
 * they disagreed. `users.email` was written verbatim by CLI signup (never
 * lowercased) and lowercased by the web routes; ORCID finalize checked
 * `oauth_identities` but not `users.orcid`; the GitHub "@" strip existed only
 * in `services/profile.ts`. Every one of those gaps is a way to end up with
 * two accounts for one person, which is what production rows 42 and 43 are.
 *
 * NOTHING HERE DELETES OR MERGES. A refusal points at the account that already
 * exists; merging two accounts stays a manual, human decision.
 */

import { z } from "zod";
import {
  IDENTITY_CONFLICT_MESSAGES,
  type IdentityConflictCode,
} from "../../../shared/contract/identity.js";
import { ORCID_ID_PATTERN } from "../../../shared/contract/publication.js";

/**
 * Body of a typed identity refusal.
 *
 * `code` is what the website switches on; `message` is the sentence a human
 * reads. `error` is set by the CALLER, not here, because the two families of
 * route disagree about what belongs in it and both are right: the
 * browser-facing routes have always put the CODE in `error` (the website reads
 * it there, and `email_in_use` predates this phase), while the CLI-facing
 * signup puts a short human label there because that is the field the CLI
 * prints. Neither is changed by #1254.
 */
export function identityRefusal(code: IdentityConflictCode): {
  code: IdentityConflictCode;
  message: string;
} {
  return { code, message: IDENTITY_CONFLICT_MESSAGES[code] };
}

/**
 * Canonical stored form of an email address: trimmed and lowercased.
 *
 * Lowercasing the local part is technically lossy (RFC 5321 leaves its case
 * significant), and it is the right trade anyway: no provider anyone signs up
 * with treats `Ada@` and `ada@` as two people, while storing both is exactly
 * how one person ends up with two accounts. This is also what the web routes
 * have always done via their Zod transform, so the CLI path was the outlier.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The email field every auth route validates, with normalisation running
 * BEFORE `.email()` rather than after it.
 *
 * Order matters and the five hand-rolled copies this replaces all had it
 * backwards: `z.string().email().transform(trim+lowercase)` rejects a pasted
 * `" ada@lab.org "` outright, because the trim never runs. Normalising first
 * accepts it and stores the canonical form -- which is the whole rule (ADR
 * 0043), not a convenience.
 */
export const emailFieldSchema = z.preprocess(
  (v) => (typeof v === "string" ? normalizeEmail(v) : v),
  z.string().email().max(320),
);

/**
 * Canonical stored form of an ORCID iD, or `null` when the input is not one.
 *
 * Accepts EXACTLY two shapes, both anchored at BOTH ends: a bare iD, or an
 * `orcid.org` / `sandbox.orcid.org` URI wrapping one. Anchoring only the tail
 * -- which this did until the #1254 review -- accepts
 * `garbage0000-0002-1825-0097` and "normalises" it into a valid iD, so a
 * fat-fingered paste would silently claim somebody else's identifier and then
 * pass the uniqueness checks as that person.
 *
 * The check digit is uppercased: `X` is the canonical spelling of a
 * non-numeric checksum, and the unique index compares `users.orcid` exactly, so
 * a lowercase `x` would read as a different person's iD. Migration 0077
 * canonicalises the existing rows for the same reason.
 *
 * Deliberately NOT `orcid-auth.ts`'s `normalizeOrcidId`: that one matches only
 * an uppercase `X` and would reject `...353x` outright rather than fixing it.
 */
const BARE_ORCID_RE = /^(\d{4}-\d{4}-\d{4}-\d{3}[\dXx])$/;
const ORCID_URI_RE = /^https?:\/\/(?:sandbox\.)?orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dXx])\/?$/i;

export function normalizeOrcid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const id = (BARE_ORCID_RE.exec(trimmed) ?? ORCID_URI_RE.exec(trimmed))?.[1];
  if (!id) return null;
  const canonical = id.toUpperCase();
  return ORCID_ID_PATTERN.test(canonical) ? canonical : null;
}

/**
 * Canonical stored form of a GitHub handle: trimmed with a leading `@`
 * stripped, because people paste their handle that way.
 *
 * Case is NOT folded: GitHub's own canonical login has case (`Octocat`), and
 * `idx_users_github` is already `COLLATE NOCASE`, so the comparison is
 * case-insensitive without the stored value having to be flattened.
 */
export function normalizeGithubHandle(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

// ---------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------

/**
 * The account that already holds an identifier. Only non-identifying fields
 * beyond the id: a refusal must not become an oracle that dumps someone
 * else's email back to an anonymous caller.
 */
export interface IdentityHolder {
  id: number;
  username: string | null;
}

/**
 * The `table.column` names a caught UNIQUE violation actually names, or `[]`
 * when the error is not one.
 *
 * SQLite spells the failure as
 * `UNIQUE constraint failed: <table>.<column>[, <table>.<column>]*`,
 * and names the COLUMNS even when the violated index is a named partial one
 * (verified against 0077's two indexes on real D1, where the message reads
 * `UNIQUE constraint failed: users.orcid: SQLITE_CONSTRAINT (extended: ...)`).
 * The capture stops at the next `:` so that D1 suffix is not swallowed.
 *
 * Parsed into an exact list rather than substring-matched, because substring
 * matching is wrong in a way that is easy to miss: `users.email` is a
 * substring of `users.email_verified`, so a violation on the latter would be
 * reported to a user as "that address is taken".
 */
export function uniqueViolationColumns(err: unknown): string[] {
  const msg = err instanceof Error ? err.message : String(err);
  const match = /UNIQUE constraint failed:\s*([^\n:]+)/.exec(msg);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Whether a caught D1/SQLite error is a UNIQUE violation on one of the user
 * identifier columns.
 *
 * Column-scoped on purpose: a UNIQUE hit on some other column must not be
 * reported to a user as "that address is taken".
 */
export function isUniqueViolationOn(
  err: unknown,
  column: "email" | "orcid" | "username" | "github_username",
): boolean {
  return uniqueViolationColumns(err).includes(`users.${column}`);
}

/**
 * Whether a caught error is the `UNIQUE(provider, provider_subject)` violation
 * on `oauth_identities` -- i.e. another account claimed this iD's identity row
 * in the moment between a check and an insert.
 *
 * Separate from {@link isUniqueViolationOn} because it is a different table:
 * that one only ever answers about `users`, and widening it would make every
 * call site's meaning depend on a string.
 */
export function isOrcidIdentityUniqueViolation(err: unknown): boolean {
  return uniqueViolationColumns(err).includes("oauth_identities.provider_subject");
}

// ---------------------------------------------------------------------------
// Pre-flight lookups
// ---------------------------------------------------------------------------

/**
 * Live account holding an ORCID iD, through EITHER `users.orcid` or an
 * `oauth_identities` row.
 *
 * The union is the point. `oauth_identities` alone -- the only check ORCID
 * finalize did before #1254 -- misses a row whose identity row was removed
 * while `users.orcid` stayed behind, and that row is production id 42. A
 * tombstoned row is not a holder: the tombstone NULLs `orcid`, and an identity
 * row that outlives its user cannot be signed into.
 */
export const ORCID_HOLDER_SQL = `SELECT u.id, u.username
   FROM users u
  WHERE u.deleted_at IS NULL
    AND (?2 IS NULL OR u.id != ?2)
    AND (
      u.orcid = ?1
      OR EXISTS (SELECT 1 FROM oauth_identities oi
                  WHERE oi.user_id = u.id
                    AND oi.provider = 'orcid'
                    AND oi.provider_subject = ?1)
    )
  ORDER BY u.id
  LIMIT 1`;

/** Live account holding an email address, compared case-insensitively. */
export const EMAIL_HOLDER_SQL = `SELECT id, username FROM users
  WHERE deleted_at IS NULL AND email = ? COLLATE NOCASE
  ORDER BY id LIMIT 1`;

/** Live account holding a GitHub handle, compared case-insensitively. */
export const GITHUB_HOLDER_SQL = `SELECT id, username FROM users
  WHERE deleted_at IS NULL AND github_username = ? COLLATE NOCASE
  ORDER BY id LIMIT 1`;

/**
 * Find the live account holding `orcid`, if any. Pass `exceptUserId` when the
 * caller is checking on behalf of an existing account (a link, a relink or an
 * attestation), so the account's own iD is not reported as a conflict with
 * itself. The exclusion is in the query, not after it: a filter applied to the
 * one row `LIMIT 1` returns would hide a different holder behind the account's
 * own row.
 */
export async function findOrcidHolder(
  db: D1Database,
  orcid: string,
  exceptUserId?: number,
): Promise<IdentityHolder | null> {
  return db
    .prepare(ORCID_HOLDER_SQL)
    .bind(orcid, exceptUserId ?? null)
    .first<IdentityHolder>();
}

/** Find the live account holding `email` (case-insensitively), if any. */
export async function findEmailHolder(
  db: D1Database,
  email: string,
  exceptUserId?: number,
): Promise<IdentityHolder | null> {
  const row = await db.prepare(EMAIL_HOLDER_SQL).bind(email).first<IdentityHolder>();
  if (!row) return null;
  return exceptUserId !== undefined && row.id === exceptUserId ? null : row;
}

/** Find the live account holding `github` (case-insensitively), if any. */
export async function findGithubHolder(
  db: D1Database,
  github: string,
  exceptUserId?: number,
): Promise<IdentityHolder | null> {
  const row = await db.prepare(GITHUB_HOLDER_SQL).bind(github).first<IdentityHolder>();
  if (!row) return null;
  return exceptUserId !== undefined && row.id === exceptUserId ? null : row;
}
