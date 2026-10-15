/**
 * Email verification for web accounts (ADR 0040 phase 2, #1252).
 *
 * A web account is created by ORCID sign-up, which proves the person and not
 * the inbox: ORCID never returns an email, so the address is typed into a form
 * and taken on trust. ADR 0040 makes the base tier need both, so a web account
 * lands at `pending` and reaches `verified` by repeating a 6-digit code mailed
 * to that address.
 *
 * Three things live here because more than one route needs each of them:
 * issuing a code, performing the `pending` -> `verified` transition, and
 * telling the admins an account reached `verified`. The email-code sign-in
 * (`POST /auth/code/verify`) proves the same inbox by the same means, so it
 * performs the same transition rather than a similar one.
 *
 * Non-production delivery is fenced, for the reason recorded in AGENTS.md: the
 * dev D1 holds roughly 609 real addresses and the dev worker holds a live
 * RESEND_API_KEY. Outside production a code is only ever issued for a
 * synthetic test address, and there it is echoed in the response instead of
 * mailed — the same rule /auth/email/change/request follows, with no
 * admin/owner bypass, because this endpoint's target is an address chosen by
 * whoever is signed in.
 */

import { auditLogStatement } from "../db/audit-log";
import type { Bindings } from "../types/bindings";
import {
  CODE_TTL_MINUTES,
  PER_HOUR_LIMIT,
  PER_MINUTE_LIMIT,
  USER_BOUND_CODE_INSERT_SQL,
  generateAuthCode,
  hashAuthCode,
  maskEmail,
  nonProdCodeEchoAllowed,
} from "./auth-code";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendAdminNotificationEmail,
  sendEmailVerificationCodeEmail,
} from "./email";

export type VerificationCodeIssue =
  /** A code exists for this address. `devCode` is non-null only outside
   *  production for a synthetic target, where the echo IS the delivery. */
  | { ok: true; devCode: string | null; skipped: false }
  /** Non-production, non-synthetic target: nothing was written and nothing
   *  was sent. Callers report the same shape as success (no enumeration
   *  channel) with a `dev_skip` marker. */
  | { ok: true; devCode: null; skipped: true }
  /** The per-address or per-account bucket is full; no code was written. */
  | { ok: false; error: "rate_limited" }
  /** Resend refused the send. The row is rolled back so the per-minute cap
   *  does not punish the retry. */
  | { ok: false; error: "send_failed" };

function isDevOrTest(env: Bindings): boolean {
  return env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test";
}

/**
 * Mint, store and deliver an email-verification code for `email`, bound to
 * `userId`. `email` must be the account's own address — the redeeming lookup
 * pairs (address, user), and proving that address is the entire point.
 *
 * Never throws for an expected outcome; the two callers want different things
 * from a failure (ORCID sign-up must not fail over an undelivered code, the
 * on-demand endpoint must report 429/503), so the outcome is returned.
 */
export async function issueEmailVerificationCode(
  env: Bindings,
  userId: number,
  email: string,
): Promise<VerificationCodeIssue> {
  const db = env.DB;

  // Fence check BEFORE any code generation or write, like /code/request and
  // /email/change/request: nothing is stored for a target that can never be
  // delivered to, and the timing is the same as an unregistered address.
  const echoOnly = isDevOrTest(env) && nonProdCodeEchoAllowed(email);
  if (isDevOrTest(env) && !echoOnly) {
    return { ok: true, devCode: null, skipped: true };
  }

  const code = generateAuthCode();
  const codeHash = await hashAuthCode(code, env);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

  const insertResult = await db
    .prepare(USER_BOUND_CODE_INSERT_SQL)
    .bind(
      email,
      codeHash,
      expiresAt,
      userId,
      email,
      PER_MINUTE_LIMIT,
      email,
      PER_HOUR_LIMIT,
      userId,
      PER_HOUR_LIMIT,
    )
    .run();
  if ((insertResult.meta?.changes ?? 0) === 0) {
    return { ok: false, error: "rate_limited" };
  }
  const newCodeId = insertResult.meta?.last_row_id ?? 0;

  // Rotate this account's earlier codes for the address so a previously
  // mailed code cannot still verify. Scoped by user_id like the email-change
  // rotation: another account's pending code is not ours to invalidate.
  await db
    .prepare(
      `UPDATE auth_codes SET used_at = datetime('now')
        WHERE email = ? AND user_id = ? AND used_at IS NULL AND id != ?`,
    )
    .bind(email, userId, newCodeId)
    .run();

  if (!echoOnly) {
    try {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
      await sendEmailVerificationCodeEmail(
        email,
        code,
        env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        env,
      );
    } catch (emailError) {
      // Named: this is per-user work, and "a code failed to send" with no
      // account attached cannot be chased. The address is MASKED rather than
      // logged whole (maskEmail, the same treatment the code endpoints give a
      // recipient) -- the domain is what an operator needs to see a bounce
      // pattern, the local part is the user's.
      console.error(
        `[email-verification] failed to send verification code email to ${maskEmail(email)} (user id=${userId})`,
        emailError,
      );
      await db
        .prepare("DELETE FROM auth_codes WHERE id = ?")
        .bind(newCodeId)
        .run()
        .catch((cleanupErr) =>
          console.error(
            `[email-verification] failed to roll back auth_codes row id=${newCodeId} (user id=${userId}); an undeliverable code is left live until it expires`,
            cleanupErr,
          ),
        );
      return { ok: false, error: "send_failed" };
    }
  }

  return { ok: true, devCode: echoOnly ? code : null, skipped: false };
}

/** How the account reached `verified`, recorded in the audit row's details so
 *  the roads stay distinguishable after the fact. Three prove an inbox (the
 *  link, the sign-in code, an email change) and `owner_override` proves
 *  nothing: an owner asserted it. */
export type EmailVerificationRoute =
  | "verify_endpoint"
  | "code_signin"
  | "email_change"
  | "owner_override";

/** Just the half of a D1 batch result anyone here reads. D1's own types do not
 *  narrow `batch()` results per statement, so the cast is unavoidable; naming
 *  it once keeps it from being spelled three different ways. */
type BatchMeta = { meta?: { changes?: number } };

/**
 * Record that an account proved its inbox, promote it out of `pending`, and
 * land any statements the CALLER must not outlive that promotion (the sign-in
 * path passes its web_sessions INSERT) — all in ONE `db.batch`, which D1
 * executes as a single implicit transaction.
 *
 * Two statements rather than one CASE expression, because the caller needs to
 * know whether the tier actually moved: the admin notification belongs to the
 * transition, not to every re-proof of an inbox. The first is conditional on
 * `status = 'pending'`, which is what makes that answer race-free and
 * idempotent — only one of two concurrent verifications can match it — and
 * `changes` on its result is the answer. The second stamps `email_verified`
 * for a row that was already past `pending`; inside the same transaction the
 * first statement's write is visible, so it matches nothing when the
 * promotion just happened.
 *
 * `approved` and `revoked` rows are never re-tiered; they only ever gain the
 * `email_verified` stamp, which is a fact about the inbox and true regardless
 * of tier. The one exception is `owner_override`: it proves no inbox, so it
 * omits the stamp statement and a row that is not `pending` is left untouched.
 *
 * THROWS if the batch fails, and then nothing landed — no promotion, no
 * session, no stamp. Callers that have already consumed a single-use code by
 * the time they get here must catch that and say so; see the two verify
 * routes.
 *
 * The audit row is written here rather than by the callers so a new road to
 * `verified` cannot arrive without one. It is deliberately NOT in the batch:
 * by then the transition has committed, and rolling a verified account back
 * because an audit insert failed would be the worse outcome (that trade-off
 * is the same one finalizeApproval makes, for the same reason).
 */
export async function applyEmailVerification(
  db: D1Database,
  userId: number,
  via: EmailVerificationRoute,
  alsoInTransaction: D1PreparedStatement[] = [],
): Promise<{ promoted: boolean; extra: BatchMeta[] }> {
  const promote = db
    .prepare(
      `UPDATE users
            SET status = 'verified',
                email_verified = 1,
                updated_at = datetime('now')
          WHERE id = ? AND status = 'pending' AND deleted_at IS NULL`,
    )
    .bind(userId);
  // The inbox-stamp statement is a fact about an inbox that was proved, so the
  // owner override, which proves nothing, never runs it: losing a race to a
  // revoke must leave the revoked row's flag alone. The promotion already sets
  // the flag on the row it moves.
  const stampStatements =
    via === "owner_override"
      ? []
      : [
          db
            .prepare(
              `UPDATE users
            SET email_verified = 1,
                updated_at = datetime('now')
          WHERE id = ? AND email_verified = 0 AND deleted_at IS NULL`,
            )
            .bind(userId),
        ];
  const results = await db.batch([promote, ...stampStatements, ...alsoInTransaction]);

  // The caller's own statements, in the order it passed them, so it can read
  // `changes` off a conditional UPDATE it batched in here (#1268: the sign-in
  // path claims a username this way, and has to know whether it landed).
  const extra = results.slice(1 + stampStatements.length) as BatchMeta[];
  const promoted = ((results[0] as BatchMeta)?.meta?.changes ?? 0) > 0;
  if (!promoted) return { promoted: false, extra };

  try {
    await auditLogStatement(db, {
      userId,
      action: "email_verified",
      resourceType: "user",
      resourceId: String(userId),
      details: JSON.stringify({ via, status: "verified" }),
    }).run();
  } catch (err) {
    console.error(
      `AUDIT GAP: email_verified row not written for id=${userId} (the promotion DID commit):`,
      err,
    );
  }
  return { promoted: true, extra };
}

/**
 * Tell the admins a new account reached `verified` — the same notification a
 * CLI signup triggers from its verification link (routes/auth.ts), fired from
 * the web flow at the equivalent moment.
 *
 * Best-effort by construction: a mail failure must never undo a transition
 * that has already committed. Call it only when `markEmailVerified` reported
 * `promoted`, which is what keeps it to exactly one send per account.
 */
export async function notifyAdminsOfVerifiedAccount(
  env: Bindings,
  user: { id: number; email: string; github_username: string | null; description: string },
): Promise<void> {
  try {
    const adminEmails = await getAdminEmailsForCategory(env.DB, "user_approval", env);
    if (adminEmails.length === 0) return;
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
    await sendAdminNotificationEmail(
      adminEmails,
      {
        id: user.id,
        username: null,
        email: user.email,
        github_username: user.github_username,
        description: user.description,
      },
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      env,
    );
  } catch (err) {
    console.error(`[email-verification] admin notification failed for user id=${user.id}`, err);
  }
}
