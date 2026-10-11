/**
 * What an admin may change on someone else's account, and how a request to do
 * so is read (ADR 0096).
 *
 * Pure functions, so the rules are testable without a Worker; the database
 * reads (does the target exist, does anyone already hold this address) live in
 * the route, which is the only caller.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: the admin edit reuses the self-service
 * field rules instead of restating them. The name, affiliation, location,
 * username and GitHub handle go through `normalizeProfilePatch`, the function
 * `PATCH /auth/profile` validates with; the email goes through
 * `emailFieldSchema`, the one every auth route validates an address with. An
 * admin therefore cannot store a value the person could not have typed
 * themselves.
 *
 * Two things differ from self-service, on purpose. WHO may change a field is
 * declared in `shared/contract/admin-user.ts`. And there is NO username lock:
 * `PATCH /auth/profile` refuses an approved account's rename with
 * `username_locked` and tells the person to "contact an admin to change it",
 * and this route is that admin.
 */

import {
  ADMIN_USER_EDITABLE_FIELDS,
  ADMIN_USER_ERROR_MESSAGES,
  type AdminUserEditableField,
  type AdminUserErrorCode,
  adminUserEditBodySchema,
  isAdminUserEditableField,
  isAdminUserIdentityField,
  notEditableHint,
} from "../../../shared/contract/admin-user.js";
import type { ProfileEditErrorCode } from "../../../shared/contract/user.js";
import { emailFieldSchema } from "./identity";
import { type ProfilePatch, normalizeProfilePatch } from "./profile";

/**
 * The values to write: a field is present only if the caller sent it.
 *
 * `ProfilePatch` already says which fields may be cleared with `null` (the
 * affiliation and the GitHub handle, and nothing else), so this is that type
 * plus the email, which is never null: `users.email` is NOT NULL.
 */
export type AdminUserPatch = ProfilePatch & { email?: string };

/** Compile-time proof that the patch can carry every editable field. */
export const _patchCoversEditableFields: AdminUserEditableField extends keyof AdminUserPatch
  ? true
  : never = true;

/** A refused request. The 403 is always `owner_only_field`; everything else a
 *  parse can refuse is a 400. Tying status to code keeps `403 invalid_edit`
 *  from compiling. */
export type AdminEditRefusal =
  | { ok: false; status: 403; error: "owner_only_field"; message: string }
  | {
      ok: false;
      status: 400;
      error: Exclude<AdminUserErrorCode, "owner_only_field"> | ProfileEditErrorCode;
      message: string;
    };

export type AdminEditParse = { ok: true; patch: AdminUserPatch } | AdminEditRefusal;

function badRequest(
  error: Extract<AdminEditRefusal, { status: 400 }>["error"],
  message: string,
): AdminEditRefusal {
  return { ok: false, status: 400, error, message };
}

/**
 * The body of a refusal, with the code CHECKED. The same idea as
 * `profileRefusal` (ADR 0044): a code that is not in the declared vocabulary,
 * or a typo, is a compile error at the call site instead of a bare token the
 * CLI prints at an operator.
 */
export function adminUserRefusal(
  code: AdminUserErrorCode,
  message: string,
): { error: AdminUserErrorCode; message: string } {
  return { error: code, message };
}

/**
 * Read a raw PATCH body into a normalised patch, or say exactly why not.
 *
 * Order matters and is deliberate. An unknown key is refused FIRST, ahead of the
 * permission check, because telling an admin "owner only" about a field that
 * does not exist at all is a worse answer than "that is not a field". The
 * permission check comes before value validation so a non-owner learns they
 * cannot do this before being told their email is malformed.
 */
export function parseAdminUserEdit(raw: unknown, actorIsOwner: boolean): AdminEditParse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return badRequest("invalid_edit", "The request body must be a JSON object of fields to change");
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return badRequest("empty_patch", "No fields provided");
  }

  const notEditable = keys.filter((key) => !isAdminUserEditableField(key));
  if (notEditable.length > 0) {
    const reasons = notEditable
      .map((key) => `${key}: ${notEditableHint(key) ?? "not an editable field"}`)
      .join("; ");
    return badRequest(
      "field_not_editable",
      `Cannot edit ${notEditable.join(", ")} here (${reasons}). Editable fields: ${ADMIN_USER_EDITABLE_FIELDS.join(", ")}`,
    );
  }

  if (!actorIsOwner && keys.some(isAdminUserIdentityField)) {
    return {
      ok: false,
      status: 403,
      error: "owner_only_field",
      message: ADMIN_USER_ERROR_MESSAGES.owner_only_field,
    };
  }

  const shape = adminUserEditBodySchema.safeParse(raw);
  if (!shape.success) {
    const first = shape.error.issues[0];
    const where = first?.path.join(".") || "body";
    return badRequest("invalid_edit", `${where}: ${first?.message ?? "invalid value"}`);
  }
  const body = shape.data;
  const patch: AdminUserPatch = {};

  // Everything but the email goes through the self-service normaliser, which
  // knows the length, charset and not-empty rules for each.
  const { email, ...profileFields } = body;
  if (Object.values(profileFields).some((value) => value !== undefined)) {
    const normalized = normalizeProfilePatch(profileFields);
    if (!normalized.ok) {
      return badRequest(normalized.error, normalized.message);
    }
    Object.assign(patch, normalized.patch);
  }

  if (email !== undefined) {
    const parsed = emailFieldSchema.safeParse(email);
    if (!parsed.success) {
      return badRequest("invalid_edit", "email: not a valid email address");
    }
    patch.email = parsed.data;
  }

  if (Object.keys(patch).length === 0) {
    return badRequest("empty_patch", "No fields provided");
  }
  return { ok: true, patch };
}

/**
 * The columns of the account that a patch is compared against. Every field may
 * be NULL on the account except the email, which never is.
 */
export type AdminUserCurrent = {
  [K in AdminUserEditableField]: K extends "email" ? string : string | null;
};

export interface FieldChange {
  from: string | null;
  to: string | null;
}

/**
 * Which fields of the patch actually differ from the account. Re-sending a
 * current value is not a change: it is neither written nor audited, so the
 * audit log records edits and not form submissions.
 *
 * Exact comparison, including case. A username, email or handle that differs
 * only in case IS a change worth writing (it re-cases the stored value), and
 * the uniqueness checks around it already compare case-insensitively and
 * exclude the account itself, so a re-case never collides with its own row.
 */
export function diffAdminUserPatch(
  current: AdminUserCurrent,
  patch: AdminUserPatch,
): Partial<Record<AdminUserEditableField, FieldChange>> {
  const changed: Partial<Record<AdminUserEditableField, FieldChange>> = {};
  for (const field of ADMIN_USER_EDITABLE_FIELDS) {
    if (!(field in patch)) continue;
    const from = current[field] ?? null;
    const to = patch[field] ?? null;
    if (from !== to) changed[field] = { from, to };
  }
  return changed;
}

/**
 * Whether an email change is to a DIFFERENT inbox. A change in letter case
 * alone is the same address (the stored form is always lower-cased, so this is
 * how legacy mixed-case rows get tidied), and must not reset `email_verified`:
 * nobody has stopped controlling that inbox.
 */
export function emailInboxChanged(from: string | null, to: string | null): boolean {
  return (from ?? "").toLowerCase() !== (to ?? "").toLowerCase();
}
