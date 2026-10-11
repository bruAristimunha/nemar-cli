/**
 * User wire-shape contract (epic #896, #898).
 *
 * GET /users/me returns a NESTED envelope `{ user, token }`, not a flat user.
 * The CLI's getCurrentUser() declared it as a flat UserInfo and read fields off
 * the top level (all undefined at runtime) — the #899 drift fix unwraps `.user`;
 * this schema is the shape it validates against.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";
import type { GapFieldsStayOptional } from "./profile-gaps.js";

/**
 * What `users.status` holds — the account tier, declared once (#1268, ADR 0040).
 *
 * CLOSED, and closed by the database rather than by optimism: migration 0001
 * put `CHECK (status IN ('pending', 'verified', 'approved', 'revoked'))` on the
 * column and 0026's table rebuild carried the same four values over, so a fifth
 * cannot be written without a migration. Every `SET status =` in `backend/src`
 * writes one of them — `'verified'` (email-verification.ts, auth.ts),
 * `'approved'` (routes/admin/users.ts, migration 0062), `'revoked'`
 * (db/user-tombstone.ts) — and signup inserts the `'pending'` default.
 *
 * Declared here because it was being compared as a bare string on both sides of
 * the wire (`status === "pending"` decides the `email_verified` gap in
 * ./profile-gaps.ts) while typed `z.string()`, so a typo in either place was a
 * silently-false comparison rather than a compile error. Adding a status is a
 * schema change AND a contract change on both surfaces already; a closed enum
 * on the wire costs nothing that was not already owed.
 */
export const accountStatusSchema = z.enum(["pending", "verified", "approved", "revoked"]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/**
 * What `users.account_kind` holds — what an account IS, not what it may do
 * (epic #1272 phase 4, #1284; ADR 0048).
 *
 * `person` (the default) is a human's own account. `service` is operational
 * automation with no human signing in to it directly (`nemarOwner`,
 * `nemarAdmin`); its keys are minted only by an owner. `test` is a human's
 * secondary persona (`cool-vibers`, the seeded `test-*` fixtures) — it signs
 * in and uploads like a person, but on production may only own `xx` sandbox
 * datasets (`realDatasetCreateGate`, backend/src/services/upload-gate.ts),
 * so a real DOI never attaches to it.
 *
 * CLOSED by migration 0082's `CHECK (account_kind IN ('person', 'service',
 * 'test'))`, the same pattern {@link accountStatusSchema} documents above.
 */
export const accountKindSchema = z.enum(["person", "service", "test"]);
export type AccountKind = z.infer<typeof accountKindSchema>;

/** The three kinds as a plain array, for a runtime membership test or a
 *  `--kind must be one of: ...` message -- the ONE place the literal set is
 *  spelled, so validation call sites (`backend/src/routes/admin/users.ts`,
 *  `src/commands/admin.ts`) stop hand-copying `["person", "service",
 *  "test"]` (epic #1272 phase 4, #1284 review). */
export const ACCOUNT_KIND_VALUES: readonly AccountKind[] = accountKindSchema.options;

/** Runtime check AND type-narrow against {@link ACCOUNT_KIND_VALUES}, for a
 *  caller holding a plain `string` (a CLI argument, a query param) that
 *  needs to become an `AccountKind` without a cast at the call site. */
export function isAccountKind(value: string): value is AccountKind {
  return (ACCOUNT_KIND_VALUES as readonly string[]).includes(value);
}

/**
 * The operational accounts migration 0082 moves off the `person` default,
 * keyed by username (epic #1272 phase 4, #1284 review; ADR 0048). ONE
 * shared source for what used to be three independent copies -- the
 * migration's own data half, `scripts/seed-dev-db.sql`'s repeat of it for a
 * database seeded fresh after that migration ran, and `nemar admin doctor
 * kinds`' read-only check -- so the three cannot drift apart silently.
 *
 * The migration and the seed script are SQL and cannot import this
 * (migration 0082's header says so); this is the source the migration's own
 * test (`backend/test/account-kind-migration.test.ts`) and the doctor check
 * both read, so at least those two stay in lockstep, and a change here is a
 * loud reminder to update the two SQL files by hand.
 */
export const OPERATIONAL_ACCOUNT_KINDS: Readonly<Record<string, AccountKind>> = {
  nemarOwner: "service",
  nemarAdmin: "service",
  "test-admin": "service",
  "test-owner": "service",
  "cool-vibers": "test",
  "test-user": "test",
  "test-pending": "test",
  "test-verified": "test",
  "test-revoked": "test",
};

/**
 * Why `POST /admin/users/:username/kind` refused (epic #1272 phase 4, #1284
 * review; ADR 0048). The route's OWN-account and not-found refusals use this
 * same `{ error: <code>, message }` shape too, but "not found" is a generic
 * 404 shared with every other username-keyed admin route and does not need
 * its own vocabulary entry here.
 */
export const accountKindErrorCodeSchema = z.enum([
  "same_kind",
  "orcid_linked",
  "own_account",
  "kind_changed_concurrently",
]);
export type AccountKindErrorCode = z.infer<typeof accountKindErrorCodeSchema>;

/** The kind-change refusal codes as a plain array, for `lib/api/client.ts`'s
 *  `prefersMessage` runtime membership test. */
export const ACCOUNT_KIND_ERROR_CODES: readonly string[] = accountKindErrorCodeSchema.options;

/** One sentence plus one next step per refusal code, matching the
 *  `DEVICE_AUTH_MESSAGES` convention (shared/contract/device-auth.ts): a
 *  fact, then what to do about it. */
export const ACCOUNT_KIND_ERROR_MESSAGES: Record<AccountKindErrorCode, string> = {
  same_kind: "This account already has that kind. Pick a different kind, or leave it as it is.",
  orcid_linked:
    "An ORCID iD identifies a person, and this account has one verified and linked. Run `nemar auth profile orcid unlink` on that account first, then retry.",
  own_account:
    "You cannot change your own account kind. Ask another owner to make the change instead.",
  kind_changed_concurrently:
    "This account's kind changed between the read and the write. Re-check its current kind, then retry if the change is still needed.",
};

/**
 * What `/auth/me` reports as `status`, which is NOT {@link accountStatusSchema}.
 *
 * `userStatusForDashboard` (backend routes/auth-web.ts) collapses `approved`
 * and `verified` into `"active"`, because the dashboard's second state exists
 * to carry a button — "pending" means exactly "verify your email" and nothing
 * else. `"revoked"` is the defensive tail of that mapping (`?? row.status` for
 * a status it will not translate) and is unreachable today: every door that
 * calls `publicUser` refuses a revoked account before it gets there.
 *
 * Two enums rather than one because they are two vocabularies, and folding
 * them would let a wire value that means "verify your inbox" be compared
 * against a column value that means "an admin has not looked yet".
 */
export const webAccountStatusSchema = z.enum(["active", "pending", "revoked"]);
export type WebAccountStatus = z.infer<typeof webAccountStatusSchema>;

/**
 * One `profile_gaps` entry (#1268, ADR 0045).
 *
 * Carried by BOTH user payloads — `GET /users/me` for the CLI and
 * `GET /auth/me` for the dashboard — and computed by the one function in
 * ./profile-gaps.ts that the upload-access preconditions also build their
 * `missing` array from, so the two cannot disagree about what an account still
 * needs.
 *
 * `field` is a plain string rather than the `GapField` union: the vocabulary is
 * closed today, and a client that dropped an entry it did not recognise would
 * tell a user their request failed for no reason at all. `blocks` says what the
 * absence stops, nearest first; `set_on` says which surfaces can set it, and is
 * `["web"]` alone for a name owned by a verified ORCID record, where no CLI
 * command applies. Both are `.passthrough()`-friendly enums-as-strings for the
 * same reason `field` is.
 *
 * ONLY `field` IS REQUIRED, and that is not laxity — it is the same rule the
 * two renderers already follow. `resolveWireProfileGaps` treats a missing or
 * unusable `blocks` as "fall back to the matrix" and reads `set_on` not at all;
 * the CLI's own config-cache schema (src/lib/config.ts) has both `.optional()`
 * so a cache written by an older build still parses. Demanding them HERE would
 * have been the strictest link in a chain nothing else tightens, and
 * `getCurrentUser` throws `ApiError` on any schema mismatch — so one entry
 * missing one key would take down every `/users/me` consumer over a field the
 * renderer was ready to do without.
 */
export const profileGapSchema = z
  .object({
    field: z.string(),
    blocks: z.array(z.string()).optional(),
    set_on: z.array(z.string()).optional(),
  })
  .passthrough();
export type ProfileGapWire = z.infer<typeof profileGapSchema>;

/** What this schema parses must remain something the renderers accept: neither
 *  `blocks` nor `set_on` may become required. The alias resolves to `never`
 *  and stops compiling the moment either one does; the runtime half of the
 *  same rule is test/contract-schemas.test.ts "a profile_gaps entry may carry
 *  only its field name". */
export const _profileGapWireIsRenderable: GapFieldsStayOptional<ProfileGapWire> = true;

/** A NEMAR user as returned inside the /users/me envelope. */
export const userSchema = z
  .object({
    id: z.number().int(),
    username: z.string().nullable(),
    email: z.string(),
    github_username: z.string().nullable(),
    role: z.string(),
    orcid: z.string().nullable().optional(),
    created_at: z.string().optional(),
    approved_at: z.string().nullable().optional(),
    dataset_count: z.number().int().optional(),
    sandbox_completed: z.boolean().optional(),
    sandbox_completed_at: z.string().nullable().optional(),
    sandbox_dataset_id: z.string().nullable().optional(),
    /**
     * Upload access: the one-time admin approval (ADR 0040). Optional because
     * an older backend does not send it; `undefined` is "unknown", not "no".
     */
    service_access: z.boolean().optional(),
    /**
     * Account tier and identifier-verification state, for `nemar auth profile`
     * (#1254, ADR 0043).
     *
     * All five are `.optional()` for the same reason `service_access` is: a
     * CLI talking to a backend deployed before #1254 receives no such key, and
     * absence must render as "unknown" rather than as a confident "no". That
     * matters most for `email_verified` -- telling someone their confirmed
     * inbox is unconfirmed sends them to redeem a code they do not need.
     */
    status: accountStatusSchema.optional(),
    email_verified: z.boolean().optional(),
    orcid_verified: z.boolean().optional(),
    given_name: z.string().nullable().optional(),
    family_name: z.string().nullable().optional(),
    /**
     * What this account is still missing, and what each absence blocks (#1268,
     * ADR 0045). `.optional()` like everything else added since #1254: a
     * backend that predates phase 8 sends no such key, and an ABSENT list is
     * "this API cannot say" while an EMPTY one is "nothing is missing". The CLI
     * renders those two differently and must not collapse them.
     */
    profile_gaps: z.array(profileGapSchema).optional(),
    /**
     * True when the username on this account was derived from the name rather
     * than chosen (#1268, ADR 0045) — by the backfill sweep or at a web sign-in
     * — and has not been changed since. Optional for the same reason; it is
     * what lets a surface offer "we picked this, change it if you like".
     */
    username_auto_assigned: z.boolean().optional(),
    /**
     * What this account IS (epic #1272 phase 4, #1284; ADR 0048). Optional
     * for the same reason `service_access` is: a backend deployed before
     * this phase sends no such key, and absence must render as "unknown",
     * not as a confident "person". `nemar auth status` prints a `Kind:`
     * line only when this is present and not `"person"`.
     */
    account_kind: accountKindSchema.optional(),
  })
  .passthrough();
export type ContractUser = z.infer<typeof userSchema>;

/** The API-token summary block of the /users/me envelope (null when no token). */
export const tokenInfoSchema = z
  .object({
    prefix: z.string(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
  })
  .passthrough()
  .nullable();

/** GET /users/me — the nested envelope. `getCurrentUser()` must read `.user`. */
export const userMeResponseSchema = z
  .object({
    user: userSchema,
    token: tokenInfoSchema.optional(),
  })
  .passthrough();
export type UserMeResponse = z.infer<typeof userMeResponseSchema>;

/**
 * One row of GET /admin/users (ADR 0040, #1251).
 *
 * Every field a web/ORCID account can legitimately lack is `.nullable()` here
 * rather than assumed present — `username` and `github_username` are NULL by
 * design on those rows (#1012), and reading them as strings is what put the
 * literal "null" in the admin listing.
 *
 * `service_access` is `.optional()` on purpose and MUST NOT be given a default:
 * a CLI talking to a backend deployed before #1251 (or mid-rollout) receives no
 * such key, and coercing that absence to 0 would report an uploader as
 * browse-only. Absent means unknown; the caller renders a third state.
 */
export const adminUserListItemSchema = z
  .object({
    id: z.number().int(),
    username: z.string().nullable(),
    email: z.string(),
    github_username: z.string().nullable(),
    status: z.string(),
    email_verified: z.number().int().nullable().optional(),
    role: z.string().nullable(),
    created_at: z.string(),
    approved_at: z.string().nullable().optional(),
    revoked_at: z.string().nullable().optional(),
    signup_source: z.string().nullable().optional(),
    service_access: z.number().int().nullable().optional(),
    service_access_granted_at: z.string().nullable().optional(),
    given_name: z.string().nullable().optional(),
    family_name: z.string().nullable().optional(),
    orcid: z.string().nullable().optional(),
    /**
     * When this account asked for upload access (ADR 0042, #1253). `.optional()`
     * for the same reason `service_access` is: a backend deployed before #1253
     * omits the key, and absence means "this API cannot say", not "never asked".
     * An OPEN request is this being set while `service_access` is 0 — once an
     * admin approves, the stamp stays as the record of when they asked.
     */
    upload_access_requested_at: z.string().nullable().optional(),
    /** What this account IS (epic #1272 phase 4, #1284; ADR 0048). Optional
     *  for the same reason as the other post-#1251 additions above: a
     *  backend deployed before this phase omits the key. `nemar admin
     *  users --kind` and the `Kind:` row line both read this. */
    account_kind: accountKindSchema.optional(),
    /**
     * Which fields the search words were found in (ADR 0096), present only on a
     * `?q=` listing. An unfiltered or tier-filtered listing omits it, so absent
     * means "this was not a search", never "matched nowhere". Column names, in
     * the order the backend checks them (`id` first when a word is a number).
     */
    matched_in: z.array(z.string()).optional(),
    /**
     * How this row matched a `?q=` search, best first (ADR 0096): `exact` the
     * text IS the account's id, username, email, GitHub handle or ORCID iD;
     * `name` every word is a whole word of the name or username; `prefix` every
     * word begins a word of the name, username, email or GitHub handle;
     * `substring` found somewhere inside a field; `fuzzy` a close match (a typo
     * or an accent away) offered only when nothing else matched. Absent on a
     * listing that is not a search. A plain string rather than an enum so a kind
     * added later does not fail an older CLI's parse; the known kinds are
     * `MATCH_KINDS` in ./admin-user.ts, where the CLI types them.
     */
    match_kind: z.string().optional(),
  })
  .passthrough();
export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;

/** GET /admin/users — the listing envelope. */
export const adminUsersListResponseSchema = z
  .object({
    users: z.array(adminUserListItemSchema),
    count: z.number().int(),
  })
  .passthrough();
export type AdminUsersListResponse = z.infer<typeof adminUsersListResponseSchema>;

/**
 * Per-user outcome of `POST /admin/users/backfill-usernames` (ADR 0042, #1253).
 *
 * The five terminal values are kept apart because each one asks a different
 * thing of the operator, exactly as `backfillNameOutcomeSchema` splits
 * `no_public_name` from `lookup_failed`:
 *
 *   assigned / would_assign  the sweep can finish this row on its own.
 *   single_name              a given name and no family name. NOT guessed at:
 *                            deriving a handle from the email local part
 *                            invents an identity the person never chose
 *                            (ADR 0042), so these are listed for a human.
 *   no_name                  neither part, and no ORCID record to read one
 *                            from. Run `nemar admin backfill-names` first.
 *   lookup_failed            transient: the ORCID read failed. Retry the batch.
 *   conflict                 the suggested username was claimed between the
 *                            scan and the write. Retry picks the next suffix.
 *   exhausted                a base exists and EVERY variant of it up to the
 *                            suffix limit is already taken. Split out from
 *                            `conflict` because that one is retry-safe by
 *                            definition and this one is the opposite: the next
 *                            run scans the same base and reaches the same
 *                            answer. It needs a human to pick a handle, like
 *                            `single_name`, and it is an operational fact about
 *                            a saturated name worth seeing in the summary.
 *   write_failed             the claim or its audit row threw (#1274). Distinct
 *                            from `conflict`, which is the claim landing on 0
 *                            rows because somebody else took the handle: that
 *                            is a normal race with a normal answer, while this
 *                            is the storage layer failing. It used to abort the
 *                            whole request with a bare 500, discarding the
 *                            summary of every row already assigned; now the row
 *                            is reported and the batch continues.
 */
export const backfillUsernameOutcomeSchema = z.enum([
  "assigned",
  "would_assign",
  "single_name",
  "no_name",
  "lookup_failed",
  "conflict",
  "exhausted",
  "write_failed",
]);
export type BackfillUsernameOutcome = z.infer<typeof backfillUsernameOutcomeSchema>;

/**
 * What happened to the one verify-your-email message an `--apply` run sends to
 * a row it just gave a username to (ADR 0042, #1253).
 *
 * `skipped_fence` is not a failure: outside production `issueEmailVerificationCode`
 * refuses any address that is not a synthetic test target and writes nothing at
 * all (AGENTS.md — the dev D1 holds ~609 real addresses behind a live Resend
 * key). Reporting it as `failed` would send an operator hunting a bug in the
 * one behaviour that is protecting real people.
 */
export const backfillVerifyOutcomeSchema = z.enum([
  "sent",
  "already_verified",
  "skipped_fence",
  "rate_limited",
  "failed",
  "not_attempted",
]);
export type BackfillVerifyOutcome = z.infer<typeof backfillVerifyOutcomeSchema>;

/**
 * `GET /auth/profile/username-suggestion` (ADR 0042, #1253).
 *
 * `suggestion` is null for both non-"name" cases, and they are kept apart
 * because they are different problems:
 *
 *   unavailable  the account has no family name to build one from, or the name
 *                folds to nothing usable in ASCII. The user types one.
 *   exhausted    a default EXISTS but every variant of it up to the suffix
 *                limit is taken. The user types one too, but the operator has
 *                a saturated base to look at -- so the backend also logs it.
 *
 * The two fields are reported separately so the website can tell "here is a
 * default, edit it if you like" from "type one yourself" without inspecting a
 * null.
 */
export const usernameSuggestionResponseSchema = z
  .object({
    suggestion: z.string().nullable(),
    based_on: z.enum(["name", "unavailable", "exhausted"]),
  })
  .passthrough();
export type UsernameSuggestionResponse = z.infer<typeof usernameSuggestionResponseSchema>;

/**
 * Why `POST /users/me/upload-access/request` refused (ADR 0042, #1253).
 *
 * The closed vocabulary the website's Settings form and the CLI both switch on.
 * Declared here rather than in the backend service because three consumers read
 * it: the route that raises it, the CLI client that decides how to render such
 * a body, and nemarOrg/website#301.
 *
 * Every refusal carries `{ error, message, missing }`, and `missing` is present
 * (possibly empty) on all of them so one renderer covers the set:
 *
 *   why_required                the submitted text is outside 20-500 chars.
 *   email_not_verified          the inbox is unconfirmed; POST /auth/email/verify/request.
 *   profile_incomplete          `missing` names the account fields still blank.
 *   github_username_unverified  the handle is set but GitHub does not resolve it.
 *   github_unavailable          GitHub could not be reached (503, #1052). NOTHING
 *                               about the account is wrong and `missing` is empty:
 *                               retry the same request later.
 *   already_approved            409; the grant is already held.
 */
export const uploadAccessErrorCodeSchema = z.enum([
  "why_required",
  "email_not_verified",
  "profile_incomplete",
  "github_username_unverified",
  "github_unavailable",
  "already_approved",
]);
export type UploadAccessErrorCode = z.infer<typeof uploadAccessErrorCodeSchema>;

/** The refusal codes as a plain array, for a runtime membership test (the CLI
 *  client uses it to decide whether a body leads with `message`). */
export const UPLOAD_ACCESS_ERROR_CODES: readonly string[] = uploadAccessErrorCodeSchema.options;

/**
 * Why a self-service identity edit was refused (#1266, ADR 0044).
 *
 * `PATCH /auth/profile`, `POST /auth/email/change/{request,verify}` and
 * `POST /auth/orcid/cli-start` all answer a refusal with a machine CODE in
 * `error` and the sentence in `message` — the shape the website's Settings
 * form has always switched on. That shape is unreadable in a terminal, where
 * `error` is what the CLI prints, so the client needs to know which strings
 * are codes rather than sentences. Declaring the set here means the routes
 * and the renderer cannot drift; the same reason
 * {@link uploadAccessErrorCodeSchema} lives here.
 *
 * The identity-uniqueness codes (`email_in_use`, `github_in_use`,
 * `orcid_in_use`, ...) are NOT repeated here — they are declared once in
 * shared/contract/identity.ts and the CLI checks both sets.
 *
 * Enforced on the backend side, not merely documented: every refusal in this
 * vocabulary is built by `profileRefusal(code, message)` (backend
 * services/profile.ts), whose parameter is this union, so an undeclared code
 * is a compile error at the call site rather than a bare token printed at a
 * person. The codes `normalizeProfilePatch` returns are additionally pinned by
 * `_profileErrorsAreDeclared` in the same module.
 */
export const profileEditErrorCodeSchema = z.enum([
  // normalizeProfilePatch (services/profile.ts)
  "invalid_github_username",
  "city_required",
  "country_required",
  "empty_patch",
  "username_too_short",
  "username_too_long",
  "username_charset",
  "given_name_required",
  "family_name_required",
  // PATCH /auth/profile, decided against the account rather than the value
  "username_taken",
  "username_locked",
  "name_is_orcid_canonical",
  "account_revoked",
  "github_unavailable",
  // email change
  "same_email",
  "code_expired",
  "code_incorrect",
  // ORCID link intent
  "orcid_already_have",
  "orcid_unavailable",
]);
export type ProfileEditErrorCode = z.infer<typeof profileEditErrorCodeSchema>;

/** The profile-edit refusal codes as a plain array, for a runtime membership
 *  test (the CLI client uses it to decide whether a body leads with
 *  `message`). */
export const PROFILE_EDIT_ERROR_CODES: readonly string[] = profileEditErrorCodeSchema.options;

/**
 * Bounds on the upload request's why text (ADR 0042, #1253).
 *
 * Declared here because three places must agree on them: the backend rule that
 * refuses `why_required`, the CLI prompt that stops a user submitting a text it
 * will refuse, and the website form. They match CLI signup's `description`
 * bounds -- the same column, and the same question.
 */
export const UPLOAD_ACCESS_WHY_MIN_CHARS = 20;
export const UPLOAD_ACCESS_WHY_MAX_CHARS = 500;

/**
 * The user payload the web dashboard reads: `GET /auth/me`, and the same shape
 * echoed by `/auth/code/verify`, `PATCH /auth/profile` and `/auth/email/verify`
 * (backend `publicUser`).
 *
 * NOT the same shape as {@link userSchema}, which is the CLI's `/users/me`
 * envelope: this one reports `status` as the dashboard's collapsed value
 * ({@link webAccountStatusSchema}, not the column's own vocabulary), carries
 * the profile fields the Settings page edits,
 * and omits everything about API tokens and sandbox state. They are two
 * audiences, not one shape with optional halves.
 *
 * `username`, `service_access_granted_at` and `upload_access_requested_at`
 * arrived in #1253 (nemarOrg/website#306): the dashboard was fetching the
 * username from `/users/me` separately because it was absent here, and could
 * report "granted" and "requested" but not when. `upload_access_notified_at` is
 * deliberately absent -- whether an admin's copy of the email landed drives the
 * requester's retry and the admin queue, and is not profile content.
 */
export const webUserSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    username: z.string().nullable(),
    role: z.string(),
    status: webAccountStatusSchema,
    email_verified: z.boolean(),
    given_name: z.string().nullable(),
    family_name: z.string().nullable(),
    orcid: z.string().nullable(),
    orcid_verified: z.boolean(),
    github_username: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string().nullable(),
    affiliation: z.string().nullable(),
    service_access: z.boolean(),
    service_access_granted_at: z.string().nullable(),
    upload_access_requested_at: z.string().nullable(),
    /**
     * The two phase-8 additions (#1268, ADR 0045). REQUIRED here, unlike their
     * `.optional()` twins on {@link userSchema}: that schema is what the CLI
     * parses a possibly-older backend's `/users/me` with, while this one is
     * only ever used to assert what THIS backend sends, and a `publicUser`
     * that stopped sending either should fail the route test rather than
     * quietly serve a dashboard that can no longer say what is missing.
     */
    profile_gaps: z.array(profileGapSchema),
    username_auto_assigned: z.boolean(),
  })
  .passthrough();
export type WebUser = z.infer<typeof webUserSchema>;

/** `GET /auth/me` — the user, or `{ user: null }` for an anonymous browser. */
export const authMeResponseSchema = z.object({ user: webUserSchema.nullable() }).passthrough();
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
