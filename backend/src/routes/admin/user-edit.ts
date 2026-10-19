/**
 * Admin routes: one account's details and an admin edit of it (ADR 0096).
 *
 *   GET   /admin/users/by-id/:id   details, every non-secret column
 *   PATCH /admin/users/by-id/:id   edit a closed set of fields
 *
 * Keyed by id, not username, for the same reason `approve/by-id` and
 * `revoke/by-id` are: a web/ORCID account has username = NULL by design (#1012)
 * and the username-keyed routes cannot reach it. The search route
 * (`GET /admin/users?q=`) is how an admin finds the id.
 *
 * What the edit may change, and who may change it, is declared in
 * `shared/contract/admin-user.ts`; how a request is read and compared is in
 * `services/admin-user-edit.ts`. This file is the part that needs the database
 * and the caller: does the account exist, is it the caller's own or an owner's,
 * does anyone already hold this address or iD, and the one batch that writes the
 * change with its audit row.
 *
 * The ORCID iD is editable here ONLY as an owner's attestation (ADR 0106): it
 * sets the iD and marks it verified, with no ORCID sign-in record behind it, and
 * the audit row says so. An iD the person proved by signing in is never replaced
 * here.
 *
 * Deliberately absent, because each has a route that also carries the side
 * effects this one would skip: role (token revocation on demotion), status and
 * upload access (ADR 0040), account kind (ADR 0048), unlinking an iD (ADR 0022),
 * the identity-conflict flag, and credentials.
 */

import {
  ADMIN_USER_EDITABLE_FIELDS,
  ADMIN_USER_ERROR_MESSAGES,
  ADMIN_USER_NAME_FIELDS,
  isAdminUserIdentityField,
} from "../../../../shared/contract/admin-user.js";
import type { IdentityConflictCode } from "../../../../shared/contract/identity.js";
import type { ProfileEditErrorCode } from "../../../../shared/contract/user.js";
import { applyEditWithAudit } from "../../db/audit-log";
import { flag } from "../../db/flag";
import {
  type AdminUserCurrent,
  type FieldChange,
  adminUserRefusal,
  diffAdminUserPatch,
  emailInboxChanged,
  parseAdminUserEdit,
} from "../../services/admin-user-edit";
import { notifyPreviousEmailAddress } from "../../services/email-change-notice";
import {
  findEmailHolder,
  findGithubHolder,
  findOrcidHolder,
  isUniqueViolationOn,
} from "../../services/identity";
import { profileRefusal } from "../../services/profile";
import { ADMIN_USER_DETAIL_SELECT } from "../../services/user-search";
import type { AdminRouter } from "./shared";

/**
 * A non-zero whole number path segment, or null. Negative ids are accepted
 * because one account has one (the internal system account, id -1, which search
 * lists); the edit route refuses it by name rather than as a malformed id.
 * Rejects `12abc`, `0`, `1e3`, `1.5`.
 */
function parseUserId(raw: string): number | null {
  if (!/^-?\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id !== 0 ? id : null;
}

/**
 * One account's details. The SELECT list is {@link ADMIN_USER_DETAIL_SELECT},
 * an explicit list derived from the column classification, never the whole row.
 */
async function loadUserDetail(
  db: D1Database,
  id: number,
  includeDeleted: boolean,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(
      `SELECT ${ADMIN_USER_DETAIL_SELECT},
        (SELECT COUNT(*) FROM datasets WHERE owner_user_id = u.id) AS dataset_count,
        (SELECT COUNT(*) FROM tokens WHERE user_id = u.id AND revoked_at IS NULL) AS active_tokens,
        (SELECT group_concat(provider, ',')
           FROM (SELECT DISTINCT provider FROM oauth_identities WHERE user_id = u.id ORDER BY provider)
        ) AS linked_identities
      FROM users u
      WHERE u.id = ?1 ${includeDeleted ? "" : "AND u.deleted_at IS NULL"}`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const linked = typeof row.linked_identities === "string" ? row.linked_identities : "";
  return { ...row, linked_identities: linked.split(",").filter((p) => p.length > 0) };
}

/** The editable columns, from the one list, so a field added to it is read here
 *  without anyone remembering to extend a hand-written SELECT. */
const EDIT_TARGET_SQL = `SELECT id, role, orcid, orcid_verified, ${ADMIN_USER_EDITABLE_FIELDS.join(", ")}
   FROM users WHERE id = ?1 AND deleted_at IS NULL`;

type EditTarget = AdminUserCurrent & {
  id: number;
  role: string | null;
  orcid: string | null;
  orcid_verified: number;
};

/** The "someone else holds it" refusals, each taken FROM the vocabulary that
 *  declares it: if a code leaves its vocabulary this type shrinks and the call
 *  that uses it stops compiling, instead of printing a bare token. */
type HeldCode =
  | Extract<ProfileEditErrorCode, "username_taken">
  | Extract<IdentityConflictCode, "email_in_use" | "github_in_use" | "orcid_in_use">;

/** The refusal for a value another live account already holds. Names the
 *  holder: this is an admin route, and "who has it" is what resolves it. */
function heldBy(
  code: HeldCode,
  what: string,
  holder: { id: number; username: string | null },
): { error: HeldCode; message: string; holder: { id: number; username: string | null } } {
  const who = holder.username ? `${holder.username} (id ${holder.id})` : `id ${holder.id}`;
  return {
    error: code,
    message: `That ${what} already belongs to account ${who}. One person has one account (ADR 0043); change or remove it there first.`,
    holder,
  };
}

/** The iD the person proved by signing in, or null. The one question an
 *  attestation asks of `oauth_identities`, asked both before the write and
 *  after a write that changed nothing, so the two answers cannot disagree. */
async function provenOrcid(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT oi.provider_subject FROM oauth_identities oi
         JOIN users u ON u.id = oi.user_id
        WHERE oi.user_id = ?1 AND oi.provider = 'orcid' AND u.deleted_at IS NULL
        LIMIT 1`,
    )
    .bind(userId)
    .first<{ provider_subject: string }>();
  return row?.provider_subject ?? null;
}

export function registerUserEditRoutes(admin: AdminRouter): void {
  /**
   * GET /admin/users/by-id/:id - details for one account (any admin).
   * `?include_deleted=true` reads a tombstoned account, as the listing's does.
   */
  admin.get("/users/by-id/:id", async (c) => {
    const id = parseUserId(c.req.param("id"));
    if (id === null) {
      return c.json(
        adminUserRefusal("invalid_user_id", ADMIN_USER_ERROR_MESSAGES.invalid_user_id),
        400,
      );
    }
    const user = await loadUserDetail(c.env.DB, id, c.req.query("include_deleted") === "true");
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ user });
  });

  /**
   * PATCH /admin/users/by-id/:id - edit an account.
   *
   * Descriptive fields (name, affiliation, city, country): any admin.
   * Identity fields (username, email, GitHub handle): owners only, never on the
   * owner's own account and never on another owner's. See the file header for
   * what is NOT editable.
   *
   * The guards below apply to the fields that would actually CHANGE, not to the
   * keys that were sent: re-sending a value the account already has is a 200
   * that writes nothing, whoever sends it and whatever the account is.
   */
  admin.patch("/users/by-id/:id", async (c) => {
    const id = parseUserId(c.req.param("id"));
    if (id === null) {
      return c.json(
        adminUserRefusal("invalid_user_id", ADMIN_USER_ERROR_MESSAGES.invalid_user_id),
        400,
      );
    }
    if (id < 0) {
      return c.json(
        adminUserRefusal("system_account", ADMIN_USER_ERROR_MESSAGES.system_account),
        400,
      );
    }
    const db = c.env.DB;
    const actor = c.get("user");

    const raw = await c.req.json().catch(() => null);
    const parsed = parseAdminUserEdit(raw, actor.role === "owner");
    if (!parsed.ok) {
      return c.json({ error: parsed.error, message: parsed.message }, parsed.status);
    }
    const patch = parsed.patch;

    const target = await db.prepare(EDIT_TARGET_SQL).bind(id).first<EditTarget>();
    if (!target) return c.json({ error: "User not found" }, 404);

    const changed = diffAdminUserPatch(target, patch);
    const changedFields = ADMIN_USER_EDITABLE_FIELDS.filter((field) => field in changed);
    // An attestation is a change even when the iD on the account is already the
    // one sent: the iD matches, but the verified flag does not yet say so.
    const attestedOrcid =
      patch.orcid !== undefined && (target.orcid !== patch.orcid || target.orcid_verified !== 1)
        ? patch.orcid
        : null;
    if (changedFields.length === 0 && attestedOrcid === null) {
      const user = await loadUserDetail(db, id, false);
      return c.json({ message: "No changes: every value already matches", changed: {}, user });
    }

    const identityTouched = attestedOrcid !== null || changedFields.some(isAdminUserIdentityField);
    if (identityTouched) {
      // The owner's own account goes through the path that asks for proof.
      // Without this, a PATCH to one's own id would be a way around the
      // email-change code (ADR 0044) for the one role that can reach it.
      if (target.id === actor.id) {
        return c.json(
          adminUserRefusal("edit_own_account", ADMIN_USER_ERROR_MESSAGES.edit_own_account),
          400,
        );
      }
      // Sign-in is passwordless: whoever holds an account's email can sign in
      // as it. Letting one owner re-point another owner's email would hand over
      // the highest privilege in one request, so owner accounts are closed to
      // this route and their owners change these in Settings.
      if (target.role === "owner") {
        return c.json(
          adminUserRefusal("owner_account", ADMIN_USER_ERROR_MESSAGES.owner_account),
          403,
        );
      }
    }

    // A verified ORCID record owns the name and rewrites it at the next sign-in
    // (ADR 0041), so an edit here would last until then and look like a bug. The
    // test is the state AFTER this write: an attestation makes the iD verified.
    const postVerified = attestedOrcid !== null || flag(target.orcid_verified);
    const postOrcid = attestedOrcid ?? target.orcid ?? "";
    if (
      ADMIN_USER_NAME_FIELDS.some((field) => field in changed) &&
      postVerified &&
      postOrcid.trim() !== ""
    ) {
      return c.json(
        profileRefusal(
          "name_is_orcid_canonical",
          "This account's name comes from its verified ORCID record and is refreshed on every sign-in, so an edit here would be overwritten. The person updates it at orcid.org and signs in again.",
        ),
        409,
      );
    }

    if (attestedOrcid !== null) {
      // An iD the person proved by signing in is not replaced by an admin: that
      // would discard the proof. The person relinks it, which mints its own
      // intent (ADR 0022).
      if ((await provenOrcid(db, target.id)) !== null) {
        return c.json(
          adminUserRefusal("orcid_already_proven", ADMIN_USER_ERROR_MESSAGES.orcid_already_proven),
          409,
        );
      }
      const holder = await findOrcidHolder(db, attestedOrcid, target.id);
      if (holder) return c.json(heldBy("orcid_in_use", "ORCID iD", holder), 409);
    }

    // Uniqueness, checked up front so an admin gets a sentence naming the
    // account that holds the value (ADR 0043). The database still enforces it;
    // the catch around the write handles the race between this and that.
    if (changed.username?.to) {
      const holder = await db
        .prepare(
          `SELECT id, username FROM users
            WHERE username = ?1 COLLATE NOCASE AND id != ?2 AND deleted_at IS NULL LIMIT 1`,
        )
        .bind(changed.username.to, target.id)
        .first<{ id: number; username: string | null }>();
      if (holder) return c.json(heldBy("username_taken", "username", holder), 409);
    }
    if (changed.email?.to) {
      const holder = await findEmailHolder(db, changed.email.to, target.id);
      if (holder) return c.json(heldBy("email_in_use", "email address", holder), 409);
    }
    if (changed.github_username?.to) {
      const holder = await findGithubHolder(db, changed.github_username.to, target.id);
      if (holder) return c.json(heldBy("github_in_use", "GitHub handle", holder), 409);
    }

    // Column names come from the closed field list above, never from the
    // request, so interpolating them is safe; every VALUE is a numbered bind.
    const values: Array<string | number | null> = [];
    const bindValue = (value: string | number | null): string => `?${values.push(value)}`;
    const sets = changedFields.map(
      (field) => `${field} = ${bindValue(changed[field]?.to ?? null)}`,
    );

    const notes: string[] = [];
    // What the caller is told changed, and what the audit row records. The verified
    // flag is not an editable column, but an attestation that only flips it must
    // still say so: otherwise the answer is an empty change and the audit row
    // carries no iD.
    const reported: Partial<Record<string, FieldChange>> = { ...changed };
    if (attestedOrcid !== null) {
      sets.push("orcid_verified = 1");
      if (target.orcid_verified !== 1) {
        reported.orcid_verified = { from: String(target.orcid_verified), to: "1" };
      }
      notes.push(
        "The ORCID iD is recorded as admin-attested: it is marked verified, but no ORCID sign-in is on record for it. The person adds that record by linking the same iD with 'nemar auth profile orcid link' or in Settings; nothing else changes.",
      );
    }
    const inboxMoved = Boolean(
      changed.email && emailInboxChanged(changed.email.from, changed.email.to),
    );
    if (inboxMoved) {
      // The new inbox is unproven, and any link already mailed to the OLD one
      // must stop working: left live, a pending account fixed after a typo
      // could still be promoted with the token sent to the wrong address, and
      // the correct inbox would never be confirmed. The person asks for a new
      // link, which goes to the new address.
      sets.push(
        "email_verified = 0",
        "verification_token = NULL",
        "verification_expires_at = NULL",
      );
      notes.push(
        "The new email address is unconfirmed (email_verified reset to 0) and any verification link already sent is void; the person confirms the new address in Settings, or requests a new link.",
      );
    }
    if (changed.username) {
      // The name is now an admin's deliberate choice, so the "we picked this,
      // change it if you like" prompt (ADR 0045) no longer applies.
      sets.push("username_auto_assigned = 0");
      notes.push(
        "Anything that refers to the old username by name (scripts, 'nemar admin approve <username>') now needs the new one. API keys are unaffected.",
      );
    }
    if (changed.github_username?.to) {
      notes.push(
        "The GitHub handle was checked for format and uniqueness only, not against GitHub. Confirm it resolves before the account is approved. Repository access already granted to the old handle is not changed.",
      );
    }
    sets.push("updated_at = datetime('now')");
    const idPlaceholder = bindValue(target.id);

    // An attestation re-checks the proof inside the write, so an ORCID link that
    // completed after the read above cannot have its iD overwritten by this one.
    const proofGuard =
      attestedOrcid === null
        ? ""
        : ` AND NOT EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = ${idPlaceholder} AND oi.provider = 'orcid')`;

    let applied: boolean;
    try {
      applied = await applyEditWithAudit(
        db,
        db
          .prepare(
            `UPDATE users SET ${sets.join(", ")} WHERE id = ${idPlaceholder} AND deleted_at IS NULL${proofGuard}`,
          )
          .bind(...values),
        {
          userId: actor.id,
          action: "admin_user_edited",
          resourceType: "user",
          resourceId: String(target.id),
          details: JSON.stringify({
            changed_by: actor.username,
            target_username: target.username,
            changed: reported,
            email_verified_reset: inboxMoved,
            // An admin attestation, not an ORCID sign-in: the audit row is the
            // only record that the verified flag came from an owner, and the iD it
            // vouched for lives nowhere else once a later change overwrites it.
            orcid_attested: attestedOrcid !== null,
            orcid_attested_value: attestedOrcid,
          }),
        },
      );
    } catch (error) {
      // Column-scoped (services/identity.ts): a UNIQUE hit on any OTHER column
      // must not be reported to an admin as "that address is taken".
      if (isUniqueViolationOn(error, "email")) {
        return c.json(
          {
            error: "email_in_use",
            message: "That email address already belongs to another account",
          },
          409,
        );
      }
      if (isUniqueViolationOn(error, "username")) {
        return c.json(
          { error: "username_taken", message: "That username already belongs to another account" },
          409,
        );
      }
      if (isUniqueViolationOn(error, "github_username")) {
        return c.json(
          {
            error: "github_in_use",
            message: "That GitHub handle already belongs to another account",
          },
          409,
        );
      }
      if (isUniqueViolationOn(error, "orcid")) {
        return c.json(
          { error: "orcid_in_use", message: "That ORCID iD already belongs to another account" },
          409,
        );
      }
      throw error;
    }
    // The account was deleted between the read and the write: nothing changed,
    // no audit row was written, and saying so beats a 200 that did not happen.
    if (!applied) {
      // Nothing was written. For an attestation the usual cause is a proof that
      // arrived after the read, which is the person's to keep (ADR 0022).
      if (attestedOrcid !== null && (await provenOrcid(db, target.id)) !== null) {
        return c.json(
          adminUserRefusal("orcid_already_proven", ADMIN_USER_ERROR_MESSAGES.orcid_already_proven),
          409,
        );
      }
      return c.json({ error: "User not found" }, 404);
    }

    // After the commit: telling the previous inbox cannot undo or block the
    // change, only report whether it was heard.
    let previousAddressNotified: boolean | undefined;
    if (inboxMoved && changed.email?.from && changed.email.to) {
      previousAddressNotified = await notifyPreviousEmailAddress(
        c.env,
        target.id,
        changed.email.from,
        changed.email.to,
      );
      notes.push(
        previousAddressNotified
          ? "The previous address was sent a notice that the sign-in email changed."
          : "The previous address could NOT be sent a notice (a non-production worker only mails allow-listed recipients, or the mail provider refused); the change stands. Tell the person through another channel.",
      );
    }

    const user = await loadUserDetail(db, id, false);
    if (!user) return c.json({ error: "User not found" }, 404);
    const label = target.username ?? target.email;
    return c.json({
      message: `Updated ${label}: ${Object.keys(reported).join(", ")}`,
      changed: reported,
      notes: notes.length > 0 ? notes : undefined,
      old_address_notified: previousAddressNotified,
      user,
    });
  });
}
