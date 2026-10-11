/**
 * Authentication routes
 *
 * Handles email verification, API-key login and key regeneration. There is no
 * password and no registration route here: an account is created by the
 * ORCID browser flow (`auth-orcid.ts`) and a key is minted by the device flow
 * (ADR 0047) or by `confirm-key-regeneration` below.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  ORCID_ID_PATTERN,
  type OrcidNameLookupStatus,
} from "../../../shared/contract/publication.js";
import { escapeHtml } from "../lib/escape";
import { inactiveAccountBody, isActiveAccountStatus } from "../services/account-tier";
import { revokeDocsCredentials } from "../services/docs-auth";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendAdminNotificationEmail,
  sendKeyReadyEmail,
  sendKeyRegenerationVerificationEmail,
  sendVerificationEmail,
} from "../services/email";
import { validateGitHubUsername } from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import { emailFieldSchema } from "../services/identity";
import { fetchOrcidName, orcidPubBase } from "../services/orcid-auth";
import {
  generateApiKey,
  generateExpirationTimestamp,
  generateVerificationToken,
  hashApiKey,
} from "../services/token";
import type { Bindings, Variables } from "../types/bindings";

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * The two routes that took a password, answered with a 410 that says where to go
 * (ADR 0097).
 *
 * They are retired, not unrouted. An already-installed CLI still has the
 * commands that call them, and an unrouted path answers 404 `Not Found`, which
 * that CLI renders as "This NEMAR backend does not support this command yet":
 * it blames the server and never names the command that works. The sentence is
 * in `error` on purpose: the client prints `error` first for any code it does
 * not know, and an older client knows none of this one.
 *
 * These handlers read nothing and write nothing: no body parse, no database,
 * no password check. A request cannot create an account or a key here.
 */
export const PASSWORD_SIGN_IN_RETIRED_BODY = {
  error: "Password sign-in was removed. Run `nemar auth login` to sign in with your browser.",
  code: "password_sign_in_retired",
} as const;
authRoutes.post("/signup", (c) => c.json(PASSWORD_SIGN_IN_RETIRED_BODY, 410));
authRoutes.post("/retrieve-key", (c) => c.json(PASSWORD_SIGN_IN_RETIRED_BODY, 410));

/**
 * GET /auth/check-username - Check if username is available
 */
authRoutes.get("/check-username", async (c) => {
  const username = c.req.query("username")?.trim();

  if (!username) {
    return c.json({ error: "Username required" }, 400);
  }

  // Validate format
  if (username.length < 3 || username.length > 30) {
    return c.json({ available: false, reason: "Username must be 3-30 characters" });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return c.json({
      available: false,
      reason: "Username can only contain letters, numbers, underscores, and hyphens",
    });
  }

  try {
    const db = c.env.DB;
    const existing = await db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .bind(username)
      .first();

    return c.json({ available: !existing });
  } catch (error) {
    console.error("Database error in check-username:", error);
    return c.json({ error: "Unable to check username availability" }, 503);
  }
});

/**
 * GET /auth/check-github - Check if GitHub username exists
 */
authRoutes.get("/check-github", async (c) => {
  const username = c.req.query("username")?.trim();

  if (!username) {
    return c.json({ error: "GitHub username required" }, 400);
  }

  // #1052: a lookup has three answers, and only a 404 is evidence about the
  // account. `unavailable` (5xx, 429, a transport failure) used to arrive here
  // as `null` and be reported to the caller as `valid: false` -- telling
  // someone mid-signup that their own handle does not exist because GitHub was
  // having a bad minute.
  let lookup: Awaited<ReturnType<typeof validateGitHubUsername>>;
  try {
    lookup = await validateGitHubUsername(username, await getDatasetsToken(c.env));
  } catch (error) {
    // The helper does not throw for a lookup failure; reaching here means
    // getDatasetsToken did (no App key, no PAT).
    console.error("GitHub auth error in check-github:", error);
    return c.json({ error: "Unable to verify GitHub username" }, 503);
  }
  if (lookup.status === "unavailable") {
    console.error(`GitHub API error in check-github: ${lookup.detail}`);
    return c.json({ error: "Unable to verify GitHub username" }, 503);
  }
  const githubUser = lookup.status === "found" ? lookup.user : null;

  // Only check registration if GitHub user exists (use canonical login for case-insensitive match)
  let registered = false;
  if (githubUser) {
    try {
      const db = c.env.DB;
      const existingUser = await db
        .prepare("SELECT id FROM users WHERE github_username = ? COLLATE NOCASE")
        .bind(githubUser.login)
        .first();
      registered = !!existingUser;
    } catch (dbError) {
      console.error("Database error checking GitHub registration:", dbError);
      return c.json({ error: "Unable to check registration status" }, 503);
    }
  }

  return c.json({ valid: !!githubUser, username: githubUser?.login, registered });
});

/**
 * GET /auth/orcid-name - Read the given/family name on a public ORCID record
 *
 * Written for the CLI's old signup form (#1255), alongside check-username and
 * check-github: ORCID is the canonical source of the researcher name that DOIs
 * cite, but a record may hide its name, so the form asked for one ONLY in that
 * case. The form went with the password routes (ADR 0097) and nothing in this
 * repository calls this route now; it stays because removing a public route is
 * a separate decision. It is idempotent and costs one public ORCID read.
 *
 * The three outcomes are reported separately (`found` / `no_public_name` /
 * `lookup_failed`): the caller prompts for a name in the last two, but the
 * sentence it shows the user differs, and blaming a private record for an
 * ORCID outage is the kind of small lie that costs a support round-trip.
 */
authRoutes.get("/orcid-name", async (c) => {
  const orcid = c.req.query("orcid")?.trim();

  if (!orcid) {
    return c.json({ error: "ORCID iD required" }, 400);
  }
  if (!ORCID_ID_PATTERN.test(orcid)) {
    return c.json({ error: "ORCID must be in format 0000-0000-0000-000X" }, 400);
  }

  try {
    const name = await fetchOrcidName(orcid, orcidPubBase(c.env));
    // Half a name is not citable, so it is not "found".
    const status: OrcidNameLookupStatus = name.given && name.family ? "found" : "no_public_name";
    return c.json({ status, given_name: name.given, family_name: name.family });
  } catch (err) {
    // Distinct from no_public_name on purpose (#1255 review item 10): the
    // caller must be able to say "ORCID is unreachable right now" rather than
    // accusing the user's record of hiding a name it may well publish.
    console.warn(`[orcid-name] lookup failed for ${orcid}:`, err);
    return c.json({
      status: "lookup_failed" satisfies OrcidNameLookupStatus,
      given_name: null,
      family_name: null,
    });
  }
});

/**
 * GET /auth/verify - Verify email address
 */
authRoutes.get("/verify", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "Verification token required" }, 400);
  }

  const db = c.env.DB;

  // Find user with this token
  const user = await db
    .prepare(
      `
    SELECT id, username, email, github_username, description, status, verification_expires_at
    FROM users
    WHERE verification_token = ?
      AND deleted_at IS NULL
  `,
    )
    .bind(token)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      description: string | null;
      status: string;
      verification_expires_at: string;
    }>();

  if (!user) {
    return c.json({ error: "Invalid verification token" }, 400);
  }

  if (user.status !== "pending") {
    // Already verified or other status - return HTML page directly
    return c.html(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Already Verified - NEMAR</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 40px 20px; text-align: center;">
  <div style="background: #2563eb; color: white; padding: 40px 20px; border-radius: 12px; margin-bottom: 30px;">
    <h1 style="margin: 0 0 10px 0; font-size: 28px;">Already Verified</h1>
    <p style="margin: 0; font-size: 18px; opacity: 0.9;">Your email has already been verified</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 12px;">
    <p>Your NEMAR account is ${user.status === "revoked" ? "no longer active" : "active and ready to use"}.</p>
    ${
      user.status === "revoked"
        ? "<p>Contact a NEMAR administrator if you believe this is an error.</p>"
        : "<p>Run <code style='background: #e5e7eb; padding: 2px 6px; border-radius: 4px;'>nemar auth login</code> to sign in with your browser; it also creates your API key.</p>"
    }
  </div>

  <p style="color: #9ca3af; font-size: 12px; margin-top: 40px;">
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
    `);
  }

  // Check if token expired
  const expiresAt = new Date(user.verification_expires_at);
  if (expiresAt < new Date()) {
    return c.json(
      {
        error: "Verification token has expired",
        message: "Please request a new verification email",
      },
      400,
    );
  }

  // Update user status
  await db
    .prepare(
      `
    UPDATE users
    SET email_verified = 1,
        status = 'verified',
        verification_token = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .bind(user.id)
    .run();

  // Log audit event
  await db
    .prepare(
      `
    INSERT INTO audit_log (user_id, action, resource_type, resource_id)
    VALUES (?, 'email_verified', 'user', ?)
  `,
    )
    .bind(user.id, user.username)
    .run();

  // The account is now active (ADR 0040 phase 2), so this is the moment the
  // API key becomes obtainable, and therefore the moment the mail that
  // explains how to get it belongs. It used to be sent at approval,
  // which is no longer when the key becomes available. Best-effort: a mail
  // failure must not undo a verification that has already committed, and the
  // user can still run `nemar auth login` without ever seeing it.
  //
  // Whether it actually went is tracked, because the success page below is
  // the ONLY other place this user is told how to get their key. Promising
  // an email that was never sent (delivery fenced in dev, RESEND_API_KEY
  // unset, Resend refusing) leaves them waiting on an inbox instead of
  // running one command.
  let keyEmailSent = false;
  try {
    if (c.env.RESEND_API_KEY) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendKeyReadyEmail(
        user.email,
        user.username,
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        c.env,
      );
      keyEmailSent = true;
    } else {
      console.error(`RESEND_API_KEY unset; key-ready email not sent for user id=${user.id}`);
    }
  } catch (emailError) {
    // With the id: this runs per user, and a failure nobody can attribute to
    // an account is a failure nobody can follow up on.
    console.error(`Failed to send key-ready email for user id=${user.id}:`, emailError);
  }

  // Notify admins who have user_approval notifications enabled
  try {
    const adminEmails = await getAdminEmailsForCategory(db, "user_approval", c.env);
    if (adminEmails.length > 0) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendAdminNotificationEmail(
        adminEmails,
        {
          id: user.id,
          username: user.username,
          email: user.email,
          github_username: user.github_username,
          description: user.description || "No description provided",
        },
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        c.env,
      );
    }
  } catch (emailError) {
    console.error("Failed to send admin notification:", emailError);
    // Don't fail verification if admin notification fails
  }

  // Return success page directly (no frontend dependency)
  return c.html(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Verified - NEMAR</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 40px 20px; text-align: center;">
  <div style="background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%); color: white; padding: 40px 20px; border-radius: 12px; margin-bottom: 30px;">
    <h1 style="margin: 0 0 10px 0; font-size: 28px;">Email Verified!</h1>
    <p style="margin: 0; font-size: 18px; opacity: 0.9;">Welcome to NEMAR, ${escapeHtml(user.username)}</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 12px; text-align: left;">
    <h2 style="color: #333; font-size: 18px; margin: 0 0 20px 0;">What happens next?</h2>

    <div style="margin-bottom: 20px;">
      <div style="display: flex; align-items: flex-start; margin-bottom: 15px;">
        <span style="background: #16a34a; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0; font-size: 12px;">✓</span>
        <span><strong>Email verified</strong> - You've completed this step</span>
      </div>
      <div style="display: flex; align-items: flex-start; margin-bottom: 15px;">
        <span style="background: #f59e0b; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0; font-size: 12px;">2</span>
        <span><strong>Get your API key</strong> - Run <code>nemar auth login</code> and sign in with your browser</span>
      </div>
      <div style="display: flex; align-items: flex-start;">
        <span style="background: #e5e7eb; color: #6b7280; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0; font-size: 12px;">3</span>
        <span><strong>To upload</strong> - Run <code>nemar sandbox</code> for the training run, and ask an admin for upload access</span>
      </div>
    </div>
  </div>

  <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
    You can close this page. Your account is active${
      keyEmailSent
        ? "; we've emailed you the steps to get your API key."
        : "; run <code>nemar auth login</code> to get your API key."
    }
  </p>

  <p style="color: #9ca3af; font-size: 12px; margin-top: 40px;">
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    <a href="https://nemar-cli.pages.dev" style="color: #9ca3af;">Documentation</a>
  </p>
</body>
</html>
  `);
});

// Login request schema
const loginSchema = z.object({
  api_key: z.string().min(32, "Invalid API key format"),
});

/**
 * POST /auth/login - Validate API key and return user info
 */
authRoutes.post("/login", zValidator("json", loginSchema), async (c) => {
  const { api_key } = c.req.valid("json");
  const db = c.env.DB;

  // Import hash function
  const { hashApiKey } = await import("../services/token");
  const hashedKey = await hashApiKey(api_key);

  // Find token and user
  const result = await db
    .prepare(
      `
    SELECT
      t.id as token_id,
      u.id as user_id,
      u.username,
      u.email,
      u.github_username,
      u.status,
      u.role,
      u.sandbox_completed,
      u.sandbox_dataset_id
    FROM tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.api_key_hash = ?
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
      AND u.deleted_at IS NULL
  `,
    )
    .bind(hashedKey)
    .first<{
      token_id: number;
      user_id: number;
      username: string;
      email: string;
      github_username: string;
      status: string;
      role: string | null;
      sandbox_completed: number;
      sandbox_dataset_id: string | null;
    }>();

  if (!result) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // ADR 0040 phase 2: an API key is issued at `verified`, so logging in with
  // one has to work at `verified` too. `pending` and `revoked` are refused
  // with the shared body (services/account-tier.ts).
  if (!isActiveAccountStatus(result.status)) {
    return c.json(inactiveAccountBody(result.status), 403);
  }

  // Update last_used_at
  await db
    .prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?")
    .bind(result.token_id)
    .run();

  return c.json({
    valid: true,
    user: {
      username: result.username,
      email: result.email,
      github_username: result.github_username,
      role: result.role || "member",
      sandbox_completed: result.sandbox_completed === 1,
      sandbox_dataset_id: result.sandbox_dataset_id,
    },
  });
});

/**
 * POST /auth/resend-verification - Resend verification email
 */
const resendSchema = z.object({
  // Normalised before validation, and looked up NOCASE below (ADR 0043):
  // signup stores the address lowercased, so an exact-case lookup would miss
  // every LEGACY row whose address was stored exactly as typed.
  email: emailFieldSchema,
});

authRoutes.post("/resend-verification", zValidator("json", resendSchema), async (c) => {
  const { email } = c.req.valid("json");
  const db = c.env.DB;

  // Find user
  const user = await db
    .prepare(
      "SELECT id, username, status FROM users WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL",
    )
    .bind(email)
    .first<{ id: number; username: string; status: string }>();

  if (!user) {
    // Don't reveal if email exists
    return c.json({
      message: "If an account exists with this email, a verification link will be sent",
    });
  }

  if (user.status !== "pending") {
    return c.json({ message: "Email already verified" });
  }

  // Generate new token
  const verificationToken = generateVerificationToken();
  const verificationExpires = generateExpirationTimestamp(24);

  // Update user
  await db
    .prepare(
      `
    UPDATE users
    SET verification_token = ?,
        verification_expires_at = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .bind(verificationToken, verificationExpires, user.id)
    .run();

  // Send email
  const verificationUrl = `${c.env.API_BASE_URL}/auth/verify?token=${verificationToken}`;
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
  await sendVerificationEmail(
    email,
    user.username,
    verificationUrl,
    c.env.RESEND_API_KEY,
    fromEmail,
    replyTo,
    isDev,
    c.env,
  );

  return c.json({ message: "Verification email sent" });
});

// ============================================================================
// Request API Key Regeneration (sends verification email)
// ============================================================================

const regenRequestSchema = z.object({
  email: emailFieldSchema,
});

/**
 * POST /auth/request-key-regeneration - Request a new API key.
 * Sends a verification email; clicking the link generates a new key and revokes the old one.
 */
authRoutes.post("/request-key-regeneration", zValidator("json", regenRequestSchema), async (c) => {
  const { email } = c.req.valid("json");
  const db = c.env.DB;

  // Find user
  const user = await db
    .prepare(
      "SELECT id, username, email, status FROM users WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL",
    )
    .bind(email)
    .first<{ id: number; username: string; email: string; status: string }>();

  // Regeneration follows the key: it is issuable at `verified` (ADR 0040
  // phase 2), so losing it must be recoverable at `verified` too.
  if (!user || !isActiveAccountStatus(user.status)) {
    // Intentionally vague
    return c.json({
      message: "If an active account exists with this email, a verification link will be sent",
    });
  }

  // Generate a regeneration verification token
  const regenToken = generateVerificationToken();
  const regenExpires = generateExpirationTimestamp(1); // 1 hour

  // Store the token on the user record
  await db
    .prepare(
      `UPDATE users
         SET verification_token = ?,
             verification_expires_at = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
    )
    .bind(regenToken, regenExpires, user.id)
    .run();

  // Send verification email
  const confirmUrl = `${c.env.API_BASE_URL}/auth/confirm-key-regeneration?token=${regenToken}`;
  try {
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
    await sendKeyRegenerationVerificationEmail(
      user.email,
      user.username,
      confirmUrl,
      c.env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      c.env,
    );
  } catch (emailError) {
    console.error("Failed to send key regeneration email:", emailError);
  }

  return c.json({
    message: "If an active account exists with this email, a verification link will be sent",
  });
});

// ============================================================================
// Confirm Key Regeneration (via email link)
// ============================================================================

/**
 * GET /auth/confirm-key-regeneration?token=... - Confirm key regeneration.
 * Revokes old tokens, generates a new API key, and shows it in a success page.
 */
authRoutes.get("/confirm-key-regeneration", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "Token required" }, 400);
  }

  const db = c.env.DB;

  const user = await db
    .prepare(
      `SELECT id, username, email, status, verification_expires_at
       FROM users WHERE verification_token = ? AND deleted_at IS NULL`,
    )
    .bind(token)
    .first<{
      id: number;
      username: string;
      email: string;
      status: string;
      verification_expires_at: string;
    }>();

  if (!user) {
    return c.json({ error: "Invalid or expired token" }, 400);
  }

  if (!isActiveAccountStatus(user.status)) {
    return c.json(inactiveAccountBody(user.status), 403);
  }

  // Check expiration
  const expiresAt = new Date(user.verification_expires_at);
  if (expiresAt < new Date()) {
    return c.json(
      {
        error: "Token has expired",
        message: "Please request a new key regeneration link",
      },
      400,
    );
  }

  // Revoke all existing tokens
  const revokeResult = await db
    .prepare(
      `UPDATE tokens SET revoked_at = datetime('now')
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(user.id)
    .run();

  // Every key just died, and a docs session can be minted from any of them,
  // so the account's docs credential goes too (the same best-effort cascade
  // every key revocation runs; see revokeDocsCredentials).
  await revokeDocsCredentials(db, user.id);

  // Generate new API key
  const { apiKey, apiKeyPrefix } = generateApiKey();
  const hashedKey = await hashApiKey(apiKey);

  await db
    .prepare(
      `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
       VALUES (?, ?, ?, 'Regenerated Token')`,
    )
    .bind(user.id, hashedKey, apiKeyPrefix)
    .run();

  // Clear the verification token
  await db
    .prepare(
      `UPDATE users
       SET verification_token = NULL,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(user.id)
    .run();

  // Audit log
  await db
    .prepare(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, 'key_regenerated', 'user', ?, ?)`,
    )
    .bind(
      user.id,
      user.username,
      JSON.stringify({ tokens_revoked: revokeResult.meta?.changes || 0 }),
    )
    .run();

  // Return HTML page with the new API key (prevent browser caching)
  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  c.header("Pragma", "no-cache");
  return c.html(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New API Key - NEMAR</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 40px 20px; text-align: center;">
  <div style="background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%); color: white; padding: 40px 20px; border-radius: 12px; margin-bottom: 30px;">
    <h1 style="margin: 0 0 10px 0; font-size: 28px;">New API Key Generated</h1>
    <p style="margin: 0; font-size: 18px; opacity: 0.9;">Your old key has been revoked</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 12px; text-align: left;">
    <h2 style="color: #333; font-size: 18px; margin: 0 0 15px 0;">Your New API Key</h2>
    <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 16px 0;">
      ${apiKey}
    </div>
    <p style="color: #dc2626; font-weight: bold; font-size: 14px;">
      Copy this key now. It will not be shown again.
    </p>

    <h2 style="color: #333; font-size: 18px; margin: 25px 0 15px 0;">Login with your new key</h2>
    <div style="background-color: #f4f4f5; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px;">
      nemar auth login -k &lt;your-new-key&gt;
    </div>
  </div>

  <p style="color: #9ca3af; font-size: 12px; margin-top: 40px;">
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `);
});
