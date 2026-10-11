/**
 * Email service using Resend API
 *
 * Handles email notifications (verification, approval, publication, revocation)
 * and admin email preference management.
 * Uses fetch directly for Cloudflare Workers compatibility.
 */

import { datasetLandingUrl } from "../../../shared/datacite-constants.js";
import { escapeHtml } from "../lib/escape";
import { STALENESS_LIMIT_DAYS } from "./staleness";

/** Fallback sender when FROM_EMAIL env var is unset. Mirrors the FROM_EMAIL set
 *  in wrangler-sccn.toml (prod + dev); the retired osc.earth address is gone. */
export const DEFAULT_FROM_EMAIL = "NEMAR Archive <noreply@nemar.org>";
const RESEND_API_URL = "https://api.resend.com/emails";

let warnedMissingFromEmail = false;

/**
 * Resolve sender + reply-to from Workers env.
 * `fromEmail` falls back to DEFAULT_FROM_EMAIL when unset, empty, or whitespace.
 * `replyTo` passes through as-is (undefined when unset or empty/whitespace).
 * Callers pass `c.env` to avoid repeating the fallback at every site.
 *
 * NOTE: The domain in FROM_EMAIL must be verified in the Resend account tied
 * to RESEND_API_KEY, otherwise Resend will reject the send. A deploy that
 * forgets FROM_EMAIL falls back to DEFAULT_FROM_EMAIL (nemar.org); if that
 * domain is not verified on the account, every send fails. We log once per
 * worker instance to surface this in Workers Logs.
 */
export function resolveEmailConfig(env: {
  FROM_EMAIL?: string;
  REPLY_TO?: string;
  ENVIRONMENT?: string;
}): {
  fromEmail: string;
  replyTo?: string;
  isDev: boolean;
} {
  const from = env.FROM_EMAIL?.trim();
  const reply = env.REPLY_TO?.trim();
  if (!from && !warnedMissingFromEmail) {
    warnedMissingFromEmail = true;
    console.error(
      `FROM_EMAIL env var is unset; falling back to ${DEFAULT_FROM_EMAIL}. If the Resend account tied to this worker does not verify nemar.org, every email will fail. Set FROM_EMAIL in wrangler config.`,
    );
  }
  return {
    fromEmail: from || DEFAULT_FROM_EMAIL,
    replyTo: reply || undefined,
    isDev: env.ENVIRONMENT?.trim().toLowerCase() === "development",
  };
}

/**
 * Red banner injected into every email body when sent from the dev backend,
 * so recipients (mostly admins via testAdmin@nemar.org / testOwner@nemar.org)
 * never confuse a dev send with a real production notification.
 */
const DEV_BANNER_HTML = `
<div style="background:#dc2626;color:#ffffff;padding:14px 20px;border-radius:8px;margin:0 0 20px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;">
  <div style="font-size:16px;font-weight:bold;letter-spacing:0.5px;">DEV BACKEND - NOT PRODUCTION</div>
  <div style="font-size:13px;margin-top:4px;">Sent from the NEMAR development backend. Do not act on this email.</div>
</div>
`;

export function applyDevWrap(
  subject: string,
  html: string,
  isDev: boolean | undefined,
): { subject: string; html: string } {
  if (!isDev) return { subject, html };
  const wrappedHtml = html.replace(/<body([^>]*)>/i, (match) => `${match}${DEV_BANNER_HTML}`);
  return {
    subject: `[DEV] ${subject}`,
    html: wrappedHtml === html ? `${DEV_BANNER_HTML}${html}` : wrappedHtml,
  };
}

/**
 * Env fields the delivery fence below needs (issue #957). Structurally
 * typed, not `Bindings`, matching resolveEmailConfig's own loose env
 * parameter -- this module stays decoupled from the full binding surface.
 */
export interface EmailDeliveryEnv {
  ENVIRONMENT?: string;
  DEV_EMAIL_ALLOWLIST?: string;
}

/**
 * Thrown by sendEmail (and, via isEmailDeliveryAllowed, sendBroadcast in
 * services/broadcast.ts) when a non-production worker refuses to deliver to
 * a recipient that is not on DEV_EMAIL_ALLOWLIST (issue #957). Mirrors
 * ProdRepoFenceError (services/deletion.ts): a named, catchable fence error
 * rather than a bare throw, so a caller that wants to distinguish "email
 * service down" from "delivery fenced" can. The recipient is deliberately
 * never in the message -- dev D1 holds roughly 609 real addresses and the
 * dev worker holds a live RESEND_API_KEY, so this error must be safe to log
 * verbatim wherever an existing call site's catch block already does.
 */
export class DevEmailFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevEmailFenceError";
  }
}

/**
 * Parse DEV_EMAIL_ALLOWLIST -- comma-separated exact addresses and/or
 * `@domain` suffixes -- and test `to` against it, case-insensitively.
 * Exported so a test drives this exact parsing/matching instead of a
 * hand-copied re-implementation (`.rules/testing.md`).  An empty/unset
 * allowlist matches nothing (fail-closed): unset means "no one is
 * allow-listed," not "everyone is."
 */
export function isRecipientAllowlisted(to: string, allowlist: string | undefined): boolean {
  const entries = (allowlist ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return false;

  const recipient = to.trim().toLowerCase();
  const at = recipient.lastIndexOf("@");
  const domain = at >= 0 ? recipient.slice(at) : ""; // includes the leading "@"

  return entries.some((entry) => (entry.startsWith("@") ? domain === entry : recipient === entry));
}

/**
 * True when `to` may actually be delivered to, given `env` (issue #957).
 * Production always allows; every other (or unset/unrecognized) ENVIRONMENT
 * requires an exact DEV_EMAIL_ALLOWLIST match. This is the ONE predicate
 * both sendEmail below (single recipient) and services/broadcast.ts's
 * sendBroadcast (per-recipient, batched) gate on, so the two delivery paths
 * can never drift apart on what "fenced" means.
 *
 * Deliberately the STRICT opposite of services/environment.ts's
 * isNonProductionEnv, which treats an unknown ENVIRONMENT as production so
 * a misconfigured prod-only fence does not accidentally restrict real
 * production traffic. Here the risk is inverted: an unrecognized
 * ENVIRONMENT on a worker with a live RESEND_API_KEY must fail toward
 * REFUSING delivery, not toward allowing it -- so only the literal string
 * "production" bypasses the allow-list.
 */
export function isEmailDeliveryAllowed(to: string, env: EmailDeliveryEnv | undefined): boolean {
  const environment = (env?.ENVIRONMENT ?? "").trim().toLowerCase();
  if (environment === "production") return true;
  return isRecipientAllowlisted(to, env?.DEV_EMAIL_ALLOWLIST);
}

/**
 * Redact a recipient for logging: first character of the local part plus
 * the domain (e.g. "a***@example.org"). The suppressed-send log below must
 * never carry a full address -- see DevEmailFenceError's doc comment.
 */
export function redactRecipient(to: string): string {
  const at = to.indexOf("@");
  if (at <= 0) return "***";
  return `${to[0]}***${to.slice(at)}`;
}

/**
 * `message` with every occurrence of `address` redacted (whatever its letter case), for a
 * log line or a stored failure. `sendEmail`'s error text names the recipient in full, so a
 * caller that logs the text after redacting only the address it prints beside it would
 * still log the address once. It takes the text: `sendEmail` sets no `cause` on what it
 * throws, and every caller below logs `message` and never the error object, whose `stack`
 * repeats the message as it was built.
 */
export function redactAddressIn(message: string, address: string): string {
  if (address === "") return message;
  const literal = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const redacted = redactRecipient(address);
  // A function, so a `$` in the replacement is never read as a pattern.
  return message.replace(new RegExp(literal, "gi"), () => redacted);
}

/** A failed send as text for a log line or a stored failure: its message, the recipient redacted. */
function sendFailureText(error: unknown, address: string): string {
  return redactAddressIn(error instanceof Error ? error.message : String(error), address);
}

export interface EmailPreferences {
  user_approval: boolean;
  publication_request: boolean;
  announcements: boolean;
  /**
   * The anonymity sweep found something on an anonymous deposit (#1409).
   *
   * Its own category rather than riding `publication_request`, which is the
   * closest existing one: an admin who stops watching publication requests has
   * said nothing about wanting to stop hearing that a concealed depositor may
   * have been disclosed. Coupling the two would let the second be switched off
   * by accident, and the finding is time-sensitive in a way a request is not.
   */
  dataset_anonymity: boolean;
  /**
   * The scheduled identifier sweep's weekly report (epic #1610 phase 5, ADR 0088).
   *
   * Its own category for the reason `dataset_anonymity` has one: an admin who
   * stops watching publication requests has said nothing about wanting to stop
   * hearing which published datasets carry identifiers. Opted in by default,
   * like every category here, so a stored row from before it existed receives it.
   */
  identifier_sweep: boolean;
}

export type EmailCategory = keyof EmailPreferences;

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  user_approval: true,
  publication_request: true,
  announcements: true,
  dataset_anonymity: true,
  identifier_sweep: true,
};

interface ResendResponse {
  id?: string;
  error?: string;
  message?: string;
}

interface AdminRow {
  email: string;
  email_preferences: string | null;
}

/**
 * Parse email preferences from DB JSON string, defaulting to all enabled
 */
export function parseEmailPreferences(raw: string | null): EmailPreferences {
  if (!raw) return { ...DEFAULT_EMAIL_PREFERENCES };
  try {
    const parsed = JSON.parse(raw);
    return {
      user_approval: parsed.user_approval !== false,
      publication_request: parsed.publication_request !== false,
      announcements: parsed.announcements !== false,
      // `!== false` throughout, so a row stored before this key existed opts
      // IN rather than out. Defaulting a new alert to off would silently give
      // every current admin no anonymity mail at all.
      dataset_anonymity: parsed.dataset_anonymity !== false,
      identifier_sweep: parsed.identifier_sweep !== false,
    };
  } catch (err) {
    console.error("Corrupt email_preferences JSON, defaulting to all enabled:", raw, err);
    return { ...DEFAULT_EMAIL_PREFERENCES };
  }
}

/**
 * Env fields the admin-notification fence below needs. Structurally typed
 * (like EmailDeliveryEnv above), not `Bindings`, so this module stays
 * decoupled from the full binding surface.
 */
export interface AdminNotificationEnv {
  ENVIRONMENT?: string;
  /** Opt-in escape hatch for a DELIBERATE staging test of admin mail: set to
   *  exactly "1" to let a non-production worker generate admin notifications.
   *  Unset/anything else keeps the fence closed. */
  DEV_ADMIN_NOTIFICATIONS?: string;
}

/**
 * True when a non-production worker may generate admin-facing notification
 * mail at all (repo issue: admin notifications must be production-only).
 * Production always allows. Every other (or unset/unrecognized) ENVIRONMENT
 * requires the explicit opt-in `DEV_ADMIN_NOTIFICATIONS === "1"`.
 *
 * Deliberately mirrors isEmailDeliveryAllowed's notion of "production"
 * (only the literal string "production" bypasses; unset/unknown fails
 * toward suppressing) rather than services/environment.ts's
 * isNonProductionEnv, which treats an unknown ENVIRONMENT as production.
 * The risk here is the same as isEmailDeliveryAllowed's: the dev worker
 * shares production's `users` table and holds a live RESEND_API_KEY, and
 * its own admin account is on DEV_EMAIL_ALLOWLIST (so staging sign-in
 * codes reach them) -- which means the per-recipient delivery fence alone
 * does NOT stop admin notifications from reaching that admin in dev. A
 * misconfigured/typo'd ENVIRONMENT on a worker that holds live secrets must
 * fail toward NOT generating admin mail, not toward generating it.
 */
export function isAdminNotificationAllowed(env: AdminNotificationEnv | undefined): boolean {
  const environment = (env?.ENVIRONMENT ?? "").trim().toLowerCase();
  if (environment === "production") return true;
  return (env?.DEV_ADMIN_NOTIFICATIONS ?? "").trim() === "1";
}

/**
 * Get admin/owner emails filtered by notification category.
 * If all admins have opted out, falls back to the first admin
 * to ensure at least one recipient.
 *
 * `env` is the single chokepoint fence (repo issue: admin notifications
 * must be production-only): every call site funnels through here, so no
 * call site can forget the fence. On a non-production worker (and without
 * the DEV_ADMIN_NOTIFICATIONS opt-in) this returns [] before the D1 query
 * even runs, and logs one console.warn naming the category. `env` is a
 * required parameter -- not optional -- so a caller cannot silently allow
 * delivery by forgetting to pass it; TypeScript enforces that here, and
 * isAdminNotificationAllowed's own undefined-safe checks keep the fence
 * closed even if a caller passes an empty object.
 */
export async function getAdminEmailsForCategory(
  db: D1Database,
  category: EmailCategory,
  env: AdminNotificationEnv,
): Promise<string[]> {
  if (!isAdminNotificationAllowed(env)) {
    console.warn(
      `[email] admin notification for "${category}" suppressed: admin notifications are production-only (ENVIRONMENT=${env?.ENVIRONMENT ?? "unset"}). Set DEV_ADMIN_NOTIFICATIONS=1 to opt in for a deliberate staging test.`,
    );
    return [];
  }

  const result = await db
    .prepare(
      "SELECT email, email_preferences FROM users WHERE role IN ('owner', 'admin') AND status = 'approved' AND deleted_at IS NULL",
    )
    .all<AdminRow>();

  if (!result.results || result.results.length === 0) return [];

  const opted = result.results.filter((row) => {
    const prefs = parseEmailPreferences(row.email_preferences);
    return prefs[category];
  });

  // Safety: at least one admin must receive each category
  if (opted.length === 0) {
    console.warn(
      `All admins opted out of "${category}" notifications. Falling back to: ${result.results[0].email}`,
    );
    return [result.results[0].email];
  }

  return opted.map((r) => r.email);
}

/**
 * Resend ANSWERED a send with a 4xx: it refused the message itself (a bad key,
 * a bad address, a malformed body) and delivered nothing. The message keeps the
 * plain error's words. A thrown fetch, a timeout or a 5xx is not this class:
 * the mail may have been accepted and only the answer lost.
 */
export class EmailRejectedError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "EmailRejectedError";
  }
}

/**
 * Send email via Resend API.
 *
 * `deliveryEnv` (issue #957) is the delivery-level fence: when set and not
 * production, a recipient not on DEV_EMAIL_ALLOWLIST is refused BEFORE the
 * Resend fetch ever fires -- see isEmailDeliveryAllowed's doc comment for
 * why an unset/unrecognized ENVIRONMENT fails toward refusing, not
 * allowing. `deliveryEnv` is optional only so this function's own type
 * signature doesn't force every caller to thread it through in one commit;
 * every exported wrapper below does pass it, and an OMITTED deliveryEnv
 * still fails closed (isEmailDeliveryAllowed treats undefined ENVIRONMENT
 * as non-production with an empty allow-list, i.e. refuses).
 *
 * `timeoutMs`, when given, bounds the Resend call (the identifier sweep's weekly
 * report passes one). A 4xx answer throws {@link EmailRejectedError}: Resend
 * refused the message, so nothing was delivered.
 */
async function sendEmail(
  to: string,
  subject: string,
  html: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
  timeoutMs?: number,
): Promise<void> {
  if (!isEmailDeliveryAllowed(to, deliveryEnv)) {
    console.warn(
      `[email] suppressed send to ${redactRecipient(to)} (subject: "${subject}"): ENVIRONMENT=${deliveryEnv?.ENVIRONMENT ?? "unset"} is not production and the recipient is not on DEV_EMAIL_ALLOWLIST`,
    );
    throw new DevEmailFenceError(
      `Refusing to deliver to a non-allow-listed recipient from a non-production worker (ENVIRONMENT=${deliveryEnv?.ENVIRONMENT ?? "unset"}). Add the recipient (or its @domain) to DEV_EMAIL_ALLOWLIST to permit this send.`,
    );
  }

  const wrapped = applyDevWrap(subject, html, isDev);
  const body: Record<string, unknown> = {
    from: fromEmail,
    to: [to],
    subject: wrapped.subject,
    html: wrapped.html,
  };
  if (replyTo) body.reply_to = replyTo;
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as ResendResponse;
    const message = `Failed to send email from ${fromEmail} to ${to}: ${error.message || response.statusText}`;
    if (response.status >= 400 && response.status < 500) {
      throw new EmailRejectedError(response.status, message);
    }
    throw new Error(message);
  }
}

/**
 * Send email verification link to new user
 */
export async function sendVerificationEmail(
  to: string,
  username: string,
  verificationUrl: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Welcome to NEMAR, ${escapeHtml(username)}!</h1>

  <p>Thank you for signing up for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource).</p>

  <p>Please verify your email address by clicking the button below:</p>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${escapeHtml(verificationUrl)}"
       style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
      Verify Email Address
    </a>
  </p>

  <p style="color: #666; font-size: 14px;">
    Or copy and paste this link into your browser:<br>
    <a href="${escapeHtml(verificationUrl)}" style="color: #2563eb; word-break: break-all;">${escapeHtml(verificationUrl)}</a>
  </p>

  <p style="color: #666; font-size: 14px;">This link expires in 24 hours.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #666; font-size: 14px;">
    <strong>What happens next?</strong><br>
    Verifying your email activates your account: you can browse and download
    datasets, and <code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;">nemar auth login</code>
    will sign you in and give you your API key right away.
  </p>

  <p style="color: #666; font-size: 14px;">
    Uploading your own datasets needs one more thing — upload access, a
    one-time approval you request from an administrator once your account is
    active.
  </p>

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource<br>
    If you didn't create this account, you can safely ignore this email.
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "Verify your NEMAR account",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * "Your API key is ready" — sent when a CLI account's EMAIL is verified
 * (ADR 0040 phase 2), not when an admin approves it. The key is base-tier:
 * `nemar auth login` mints it from `verified`, so the mail that explains how
 * to get it has to arrive at that moment or it describes a step the recipient
 * cannot take yet.
 *
 * Never carries the key itself; the CLI mints it when the person signs in
 * from the browser (ADR 0047).
 * Upload access is a separate, later, one-time admin grant and this mail says
 * so rather than implying the account can now upload — that claim is what
 * sendUploadAccessGrantedEmail is for.
 */
export async function sendKeyReadyEmail(
  to: string,
  username: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #16a34a;">Your email is verified, ${escapeHtml(username)}!</h1>

  <p>Your NEMAR account is active. You can get your API key, browse and
  download datasets, and run the sandbox training.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Get Your API Key</h2>

  <p>For security, your API key is not sent via email. Sign in from the CLI; it opens your browser and creates a key for that machine:</p>

  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 13px; white-space: pre-line;">
# Install NEMAR CLI
bunx nemar-cli

# Sign in with your browser (this also creates your API key)
nemar auth login
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #666; font-size: 14px;">
    <strong>Uploading a dataset?</strong><br>
    That needs upload access, a one-time admin approval, plus the sandbox
    training run (<code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px;">nemar sandbox</code>).
    Ask an admin via <a href="https://nemar.org/support" style="color: #2563eb;">nemar.org/support</a>.
  </p>

  <p style="color: #666; font-size: 14px;">
    <strong>Need help?</strong><br>
    Check out the documentation at <a href="https://nemar-cli.pages.dev" style="color: #2563eb;">nemar-cli.pages.dev</a>
  </p>

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "Your NEMAR API key is ready",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * "Upload access granted" for a CLI account — what an admin approval now
 * means (ADR 0040): the one-time grant of `service_access`, on an account
 * that has been usable since it verified its email. It deliberately does NOT
 * repeat the sign-in instructions: by this point the recipient has had a
 * key for as long as they have had an account (sendKeyReadyEmail), and
 * telling them to fetch one again would read as "the old one stopped
 * working".
 */
export async function sendUploadAccessGrantedEmail(
  to: string,
  username: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #16a34a;">Upload access granted, ${escapeHtml(username)}!</h1>

  <p>An administrator has reviewed your request and granted upload access to
  your NEMAR account. You can now create and upload real datasets.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Before your first upload</h2>

  <p>Sandbox training is a one-time run that walks the whole upload flow on a
  throwaway dataset:</p>

  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 13px; white-space: pre-line;">
# Complete the training run (once)
nemar sandbox

# Then upload your dataset
nemar dataset upload &lt;path&gt;
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #666; font-size: 14px;">
    <strong>Need help?</strong><br>
    Check out the documentation at <a href="https://nemar-cli.pages.dev" style="color: #2563eb;">nemar-cli.pages.dev</a>
  </p>

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "Upload access granted on NEMAR",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * "Upload access granted" for web/ORCID accounts (#1012, re-aimed by ADR
 * 0040). These have no username, no password, and never hold an API key — the
 * CLI instructions in sendUploadAccessGrantedEmail would be dead ends — so
 * this variant points at the dashboard instead. Sandbox training is CLI-only,
 * so it is not mentioned here either: a browser upload is gated on the grant
 * alone.
 */
export async function sendWebUploadAccessGrantedEmail(
  to: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #16a34a;">Upload access granted!</h1>

  <p>An administrator has reviewed your request and granted upload access to
  your NEMAR account. You can now upload datasets from your dashboard.</p>

  <p>
    <a href="https://nemar.org/upload" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 10px 20px; border-radius: 8px; text-decoration: none;">Upload a dataset</a>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #666; font-size: 14px;">
    <strong>Need help?</strong><br>
    Check out the documentation at <a href="https://nemar-cli.pages.dev" style="color: #2563eb;">nemar-cli.pages.dev</a>
  </p>

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "Upload access granted on NEMAR",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Send key regeneration verification email
 */
export async function sendKeyRegenerationVerificationEmail(
  to: string,
  username: string,
  confirmUrl: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">API Key Regeneration Request</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>You requested a new API key for your NEMAR account. Click the button below to confirm and generate a new key.</p>

  <p style="color: #dc2626; font-weight: bold; font-size: 14px;">
    This will revoke your current API key. You will need to login again with the new key.
  </p>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${escapeHtml(confirmUrl)}"
       style="background-color: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
      Generate New API Key
    </a>
  </p>

  <p style="color: #666; font-size: 14px;">
    Or copy and paste this link into your browser:<br>
    <a href="${escapeHtml(confirmUrl)}" style="color: #2563eb; word-break: break-all;">${escapeHtml(confirmUrl)}</a>
  </p>

  <p style="color: #666; font-size: 14px;">This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "NEMAR API Key Regeneration",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Notify admins that a new account has verified its email.
 *
 * Fired the moment an account reaches `verified` on EITHER channel (ADR 0040
 * phase 2): the CLI's verification link, and the web account's email code.
 * The account is already usable at that point — this is not a gate the admin
 * has to open before anything works, it is the heads-up that an upload
 * request may follow.
 *
 * `username` and `github_username` are nullable because a web/ORCID account
 * has neither (migration 0026): the mail names the account by id and its
 * approve command by `--id` in that case, rather than rendering an empty
 * GitHub link and a `nemar admin approve` with no argument.
 */
export async function sendAdminNotificationEmail(
  adminEmails: string[],
  user: {
    id?: number;
    username: string | null;
    email: string;
    github_username: string | null;
    description: string;
  },
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const label = user.username ?? (user.id ? `id ${user.id}` : user.email);
  const approveCommand = user.username
    ? `nemar admin approve</span> ${escapeHtml(user.username)}`
    : `nemar admin approve</span> --id ${escapeHtml(String(user.id ?? ""))}`;
  const githubCell = user.github_username
    ? `<a href="https://github.com/${escapeHtml(user.github_username)}" style="color: #2563eb;">${escapeHtml(user.github_username)}</a>`
    : "<em>not linked</em>";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">New Verified Account</h1>

  <p>A new user has verified their email address. The account is active at the
  base tier (browse, dashboard, API key, sandbox); uploading additionally
  requires the one-time upload-access grant below.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">User Details</h2>

  <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
    <tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">Account</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${escapeHtml(label)}</td>
    </tr>
    <tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">Email</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${escapeHtml(user.email)}</td>
    </tr>
    <tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">GitHub</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">
        ${githubCell}
      </td>
    </tr>
  </table>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Reason for Access</h2>
  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(user.description)}</div>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Granting upload access</h2>
  <p>When this user asks to upload, review them and grant it with the CLI:</p>

  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #16a34a;">${approveCommand}
  </div>

  <p style="color: #666; font-size: 14px;">
    To see accounts holding no upload access:<br>
    <code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px;">nemar admin users --awaiting-approval</code>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  // Send to all admins
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `[NEMAR] New verified account: ${label}`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
        deliveryEnv,
      );
    } catch (error) {
      console.error(
        `Failed to send admin notification to ${redactRecipient(adminEmail)}: ${sendFailureText(error, adminEmail)}`,
      );
    }
  }
}

/**
 * The review card an admin gets when someone asks for upload access
 * (ADR 0042, #1253).
 *
 * Same delivery shape as sendAdminNotificationEmail above -- recipient list,
 * per-admin try/catch, the shared `sendEmail` fence -- and deliberately a
 * SEPARATE mail rather than a variant of it: that one announces a new account
 * at the base tier and is informational, this one is the export-control review
 * itself and carries every field the reviewer needs (ADR 0040's "admins act
 * once per uploader, at the upload request"). Folding them together would put
 * an approve command in front of an admin at a moment nobody has asked for
 * anything.
 *
 * Every field here is a REQUIRED precondition of the request except
 * `affiliation` and `orcid`, so the card renders "not set" for exactly those
 * two rather than for anything a reviewer needs. Nothing is sent to the
 * requester: the request is a message to the admins, and the answer arrives as
 * the existing upload-access-granted mail at approval.
 *
 * RETURNS PER-RECIPIENT RESULTS rather than swallowing them, unlike its
 * sibling above. The difference is what the caller does next: a "new verified
 * account" heads-up that nobody receives is a missed notification, but an
 * upload REQUEST that nobody receives is a user waiting forever for a review
 * that was never queued. The route stamps `upload_access_notified_at` only
 * when at least one send landed, and re-sends on the next attempt when it did
 * not -- which it cannot do if the failure never leaves this function.
 *
 * Recipients in `failures` are redacted (`redactRecipient`): this shape is
 * logged, and the addresses are real admins'.
 */
export interface AdminNotificationOutcome {
  /** Admins we tried to reach. 0 means the category had no opted-in recipient. */
  attempted: number;
  /** Sends Resend accepted. `> 0` is what "the admins were told" means. */
  delivered: number;
  /** One entry per failed send, recipient redacted for logging. */
  failures: { recipient: string; error: string }[];
}

export async function sendUploadAccessRequestEmail(
  adminEmails: string[],
  request: {
    id: number;
    username: string;
    given_name: string;
    family_name: string;
    email: string;
    orcid: string | null;
    github_username: string;
    city: string;
    country: string;
    affiliation: string | null;
    why: string;
  },
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<AdminNotificationOutcome> {
  const notSet = "<em>not set</em>";
  const row = (label: string, value: string) =>
    `<tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">${label}</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${value}</td>
    </tr>`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">Upload Access Requested</h1>

  <p>A verified account has asked for upload access. This is the one-time
  export-control review: check the person, their institution and their location,
  then grant or decline.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Requester</h2>

  <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
    ${row("Username", escapeHtml(request.username))}
    ${row("Name", escapeHtml(`${request.given_name} ${request.family_name}`))}
    ${row("Email", escapeHtml(request.email))}
    ${row(
      "ORCID",
      request.orcid
        ? `<a href="https://orcid.org/${escapeHtml(request.orcid)}" style="color: #2563eb;">${escapeHtml(request.orcid)}</a>`
        : notSet,
    )}
    ${row(
      "GitHub",
      `<a href="https://github.com/${escapeHtml(request.github_username)}" style="color: #2563eb;">${escapeHtml(request.github_username)}</a>`,
    )}
    ${row("Affiliation", request.affiliation ? escapeHtml(request.affiliation) : notSet)}
    ${row("City", escapeHtml(request.city))}
    ${row("Country", escapeHtml(request.country))}
  </table>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">What they intend to upload</h2>
  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(request.why)}</div>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Granting upload access</h2>

  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #16a34a;">nemar admin approve</span> ${escapeHtml(request.username)}
  </div>

  <p style="color: #666; font-size: 14px;">
    To see every open request:<br>
    <code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px;">nemar admin users --awaiting-approval</code>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  const outcome: AdminNotificationOutcome = {
    attempted: adminEmails.length,
    delivered: 0,
    failures: [],
  };
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `[NEMAR] Upload access requested: ${request.username}`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
        deliveryEnv,
      );
      outcome.delivered++;
    } catch (error) {
      // Still per-recipient, so one bad address does not cost the others their
      // copy -- the failure is now REPORTED as well as logged.
      const detail = sendFailureText(error, adminEmail);
      console.error(
        `Failed to send upload-access request to ${redactRecipient(adminEmail)}: ${detail}`,
      );
      outcome.failures.push({ recipient: redactRecipient(adminEmail), error: detail });
    }
  }
  return outcome;
}

/**
 * Alert admins that an OpenNeuro import failed and was quarantined (#754).
 * Sent on a terminal import failure that left an orphan; the admin reviews it
 * in `nemar admin import status` and clears it with `nemar admin import
 * rollback <id>` (or it is auto-rolled-back when IMPORT_AUTO_ROLLBACK is on).
 * Best-effort: per-recipient try/catch like sendAdminNotificationEmail.
 */
export async function sendImportQuarantineEmail(
  adminEmails: string[],
  details: {
    datasetId: string;
    sourceId: string;
    stage: string;
    reason: string;
    workflowRunUrl: string | null;
  },
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const runRow = details.workflowRunUrl
    ? `<tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;">Workflow run</td><td style="padding:8px 12px;border:1px solid #e5e7eb;"><a href="${escapeHtml(details.workflowRunUrl)}" style="color:#2563eb;">${escapeHtml(details.workflowRunUrl)}</a></td></tr>`
    : "";
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Import quarantined</h1>
  <p>An OpenNeuro import failed and was quarantined so it would not leave a silent orphan. Review it and decide whether to roll it back (delete the empty repo + partial S3 + D1 row) or retry.</p>
  <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
    <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;">Dataset</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(details.datasetId)} (from ${escapeHtml(details.sourceId)})</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;">Failed stage</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(details.stage)}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;">Reason</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(details.reason)}</td></tr>
    ${runRow}
  </table>
  <p style="font-family: monospace; background:#f3f4f6; padding:12px; border-radius:6px;">nemar admin import status ${escapeHtml(details.datasetId)}<br>nemar admin import rollback ${escapeHtml(details.datasetId)}</p>
</body>
</html>`;
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `NEMAR import quarantined: ${details.datasetId}`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
        deliveryEnv,
      );
    } catch (error) {
      console.error(
        `Failed to send import-quarantine alert to ${redactRecipient(adminEmail)}: ${sendFailureText(error, adminEmail)}`,
      );
    }
  }
}

/**
 * Notify an OpenNeuro maintainer that one or more datasets appear inaccessible
 * to NEMAR's anonymous import reads (public-but-403), so retry has stopped and
 * the datasets were parked on the retry engine's blocklist (#969, epic #967
 * Phase 2). Batches every newly-blocklisted dataset from one sweep tick into a
 * single email rather than one send per dataset. The caller (import-retry.ts)
 * gates the actual send behind OPENNEURO_MAINTAINER_EMAIL_ENABLED and only
 * calls this when the flag is on; a dry-run tick never reaches sendEmail.
 */
export async function sendOpenNeuroMaintainerReport(
  to: string,
  datasets: Array<{
    datasetId: string;
    sourceId: string;
    firstIncompleteAt: string | null;
    recoveryAttempts: number;
  }>,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const rows = datasets
    .map(
      (d) =>
        `<tr><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(d.sourceId)}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(d.datasetId)}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(d.firstIncompleteAt ?? "unknown")}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${d.recoveryAttempts}</td></tr>`,
    )
    .join("");
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">OpenNeuro dataset(s) appear inaccessible</h1>
  <p>NEMAR mirrors OpenNeuro datasets by copying their S3 objects anonymously. The dataset(s) below returned an access-denied response on every retry within a two-week window, so NEMAR's import for them has stopped and they've been parked pending access restoration.</p>
  <p>If these are meant to be public, restoring anonymous read access to their S3 objects will let NEMAR's next scheduled check resume the import automatically -- no action needed on the NEMAR side.</p>
  <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
    <tr><th style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;text-align:left;">OpenNeuro ID</th><th style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;text-align:left;">NEMAR ID</th><th style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;text-align:left;">First seen incomplete</th><th style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;text-align:left;">Retry attempts</th></tr>
    ${rows}
  </table>
</body>
</html>`;
  await sendEmail(
    to,
    `NEMAR: ${datasets.length} OpenNeuro dataset(s) appear inaccessible`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Send revocation notification.
 *
 * `username` is nullable because a web/ORCID account has none (migration
 * 0026) and can now be revoked by id. The greeting drops rather than
 * addressing someone by their email address back at them.
 */
export async function sendRevocationEmail(
  to: string,
  username: string | null,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Account Access Revoked</h1>

  <p>Hello${username ? ` ${escapeHtml(username)}` : ""},</p>

  <p>Your NEMAR account access has been revoked by an administrator.</p>

  <p>If you believe this was done in error, please contact the NEMAR administrators.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "NEMAR account access revoked",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * The identifier screen's part of the publication-request email (epic #1610,
 * phase 4). Built ONLY from `describeScreen` (shared/identifier-screen-report.ts)
 * plus Worker-fixed sentences, so nothing a workflow wrote reaches the mail
 * except the counts and fixed words that module emits.
 */
export interface PublicationScreenSection {
  /** `describeScreen`'s headline, e.g. "Identifier screen: FOUND IDENTIFIERS". */
  headline: string;
  tone: "ok" | "note" | "warn" | "stop";
  /** `describeScreen`'s lines: counts and fixed words, never a value. */
  lines: string[];
  /** What approval may do next, in a Worker-fixed sentence. */
  next?: string;
}

const SCREEN_TONE_COLOR: Record<PublicationScreenSection["tone"], string> = {
  ok: "#16a34a",
  note: "#2563eb",
  warn: "#d97706",
  stop: "#dc2626",
};

/**
 * The verdict as it appears at the end of the subject line:
 * "IDENTIFIER SCREEN: FOUND IDENTIFIERS", "IDENTIFIER SCREEN: clean". The
 * prefix is shouted so the verdict survives an inbox that truncates subjects.
 */
export function screenSubjectSuffix(headline: string): string {
  return headline.replace(/^Identifier screen:/, "IDENTIFIER SCREEN:");
}

/**
 * Notify admins that a user has requested publication of a dataset.
 *
 * Returns per-recipient results (#1610 phase 4), the same shape
 * `sendUploadAccessRequestEmail` returns, for the same reason: the identifier
 * screen's email is claimed before it is sent and must be released when nobody
 * received it, so the caller has to know whether anybody did. Recipients are
 * still tried independently, so one bad address does not cost the others their
 * copy. Callers that do not need the outcome may ignore it.
 */
export async function sendPublicationRequestEmail(
  adminEmails: string[],
  datasetId: string,
  username: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
  opts?: { anonymous?: boolean; screen?: PublicationScreenSection },
): Promise<AdminNotificationOutcome> {
  // #1408: an anonymous release and a publication are different runs with
  // different outcomes -- one keeps the repository private and the DOI
  // reserved, the other makes both public and permanent. The admin approving
  // it is the last human checkpoint, so the mail has to say which one it is.
  const anonymous = opts?.anonymous === true;
  const anonymousNotice = anonymous
    ? `
  <div style="background: #fef3c7; border-left: 4px solid #d97706; padding: 12px 16px; border-radius: 4px; margin: 16px 0;">
    <strong>Anonymous release.</strong> Approving this publishes the data while
    withholding the depositor: the GitHub repository stays private, the DOI stays
    reserved (it will not resolve), and NEMAR names nobody. Attribution is
    restored later, when the depositor requests publication again without
    <code>--anonymous</code>.
  </div>`
    : "";
  const screen = opts?.screen;
  const screenSection = screen
    ? `
  <div style="border-left: 4px solid ${SCREEN_TONE_COLOR[screen.tone]}; background: #f9fafb; padding: 12px 16px; border-radius: 4px; margin: 16px 0;">
    <strong style="color: ${SCREEN_TONE_COLOR[screen.tone]};">${escapeHtml(screen.headline)}</strong>
    ${
      screen.lines.length > 0
        ? `<ul style="margin: 8px 0 0 0; padding-left: 20px;">${screen.lines
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join("")}</ul>`
        : ""
    }
    ${screen.next ? `<p style="margin: 8px 0 0 0;"><strong>${escapeHtml(screen.next)}</strong></p>` : ""}
  </div>`
    : "";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">${anonymous ? "Anonymous Release Request" : "Publication Request"}</h1>

  <p>User <strong>${escapeHtml(username)}</strong> has requested ${anonymous ? "an anonymous release" : "publication"} of dataset <strong>${escapeHtml(datasetId)}</strong>.</p>
${anonymousNotice}
${screenSection}

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <p>Review the dataset and approve or deny the request:</p>

  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #16a34a;">nemar admin publish approve</span> ${escapeHtml(datasetId)}<br>
    <span style="color: #dc2626;">nemar admin publish deny</span> ${escapeHtml(datasetId)} --reason "..."
  </div>

  <p style="color: #666; font-size: 14px;">
    To see all pending requests:<br>
    <code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px;">nemar admin publish list</code>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  const subject = `[NEMAR] ${anonymous ? "Anonymous release" : "Publication"} request: ${datasetId} by ${username}${
    screen ? ` - ${screenSubjectSuffix(screen.headline)}` : ""
  }`;
  const outcome: AdminNotificationOutcome = {
    attempted: adminEmails.length,
    delivered: 0,
    failures: [],
  };
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        subject,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
        deliveryEnv,
      );
      outcome.delivered++;
    } catch (error) {
      const detail = sendFailureText(error, adminEmail);
      console.error(
        `Failed to send publication request email to ${redactRecipient(adminEmail)}: ${detail}`,
      );
      outcome.failures.push({ recipient: redactRecipient(adminEmail), error: detail });
    }
  }
  return outcome;
}

/**
 * Tell a depositor that the identifier screen blocked their publication request
 * (epic #1610, phase 4).
 *
 * Built from `describeScreen`'s lines only: finding KINDS and COUNTS, never a
 * value. The depositor knows their own data; what they need from this mail is
 * where to look and what clears the block, and a mail that quoted the header
 * text it found would itself be a copy of the identifier in an inbox.
 */
export async function sendIdentifierScreenBlockedEmail(
  to: string,
  username: string,
  datasetId: string,
  screen: PublicationScreenSection,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const lines =
    screen.lines.length > 0
      ? screen.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")
      : "<li>The screen found a direct identifier.</li>";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Publication on hold: ${escapeHtml(datasetId)}</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>Before a dataset is published, NEMAR screens it for information that identifies a
  participant: names, birth dates and record numbers in EDF/BDF headers, identifying
  columns and keys in sidecar files, and identifying file names. The screen of
  <strong>${escapeHtml(datasetId)}</strong> found some, so the request is on hold and has not
  been sent for approval. What it found, by kind and count:</p>

  <ul style="background-color: #fef2f2; padding: 16px 16px 16px 36px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #dc2626;">
    ${lines}
  </ul>

  <p>Remove or replace the identifying information in your dataset (for EDF/BDF files, the
  patient and recording fields of the header), push the change, then request publication
  again. Requesting again re-runs the screen:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    nemar dataset publish request ${escapeHtml(datasetId)}
  </div>

  <p style="font-size: 13px; color: #666;">The same summary is shown by
  <code>nemar dataset publish status ${escapeHtml(datasetId)}</code>. If you believe this was
  flagged in error, reply to this email.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  try {
    await sendEmail(
      to,
      `Publication on hold: ${datasetId} - identifying information found`,
      html,
      resendApiKey,
      fromEmail,
      replyTo,
      isDev,
      deliveryEnv,
    );
  } catch (error) {
    // The caller logs this message; the depositor's address is not for a log.
    if (error instanceof Error) error.message = redactAddressIn(error.message, to);
    throw error;
  }
}

/**
 * Notify a dataset owner that a user has requested collaborator access to their
 * (private/unpublished) dataset and is awaiting approval.
 */
export async function sendAccessRequestEmail(
  ownerEmail: string,
  datasetId: string,
  datasetName: string,
  requesterUsername: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Access Request</h1>

  <p>User <strong>${escapeHtml(requesterUsername)}</strong> has requested collaborator access to your dataset <strong>${escapeHtml(datasetName)}</strong> (<strong>${escapeHtml(datasetId)}</strong>).</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <p>Approve or deny the request:</p>

  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #16a34a;">nemar dataset access approve</span> ${escapeHtml(requesterUsername)} ${escapeHtml(datasetId)}<br>
    <span style="color: #dc2626;">nemar dataset access deny</span> ${escapeHtml(requesterUsername)} ${escapeHtml(datasetId)}
  </div>

  <p style="color: #666; font-size: 14px;">
    To see all pending requests:<br>
    <code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px;">nemar dataset access list ${escapeHtml(datasetId)}</code>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    ownerEmail,
    `[NEMAR] Access request: ${datasetId} by ${requesterUsername}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Notify user that their publication request was denied
 */
export async function sendPublicationDeniedEmail(
  to: string,
  username: string,
  datasetId: string,
  reason: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">Publication Request Denied</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>Your publication request for dataset <strong>${escapeHtml(datasetId)}</strong> has been reviewed and denied.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Reason</h2>
  <div style="background-color: #fef3c7; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #f59e0b;">
    ${escapeHtml(reason)}
  </div>

  <p>You can address the issues and submit a new request:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    nemar dataset publish request ${escapeHtml(datasetId)}
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    `Publication request denied: ${datasetId}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Notify a user that the automated pre-screen blocked their publication
 * request (issue #666). Unlike a manual denial, this is a self-serve gate:
 * the listed gaps are the publisher-minimum checks, and a fix + re-request
 * re-runs them automatically.
 */
export async function sendPublicationBlockedEmail(
  to: string,
  username: string,
  datasetId: string,
  reasons: string[],
  issueUrl: string | null,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const reasonItems =
    reasons.length > 0
      ? reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")
      : "<li>The dataset did not meet the minimum publication requirements.</li>";
  const issueBlock = issueUrl
    ? `<p>Details and step-by-step fixes are in the tracking issue on your dataset repository:</p>
  <p><a href="${escapeHtml(issueUrl)}" style="color: #2563eb;">${escapeHtml(issueUrl)}</a></p>`
    : "";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">Publication on hold: ${escapeHtml(datasetId)}</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>Thanks for submitting <strong>${escapeHtml(datasetId)}</strong> for publication on NEMAR.
  NEMAR is a <strong>publisher, not a peer reviewer</strong>; we don't evaluate scientific merit.
  We only check that each dataset carries the bare minimum so others can find, understand, and reuse it.
  The automated pre-screen flagged the following before this could go to an admin:</p>

  <ul style="background-color: #fef3c7; padding: 16px 16px 16px 36px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #f59e0b;">
    ${reasonItems}
  </ul>

  ${issueBlock}

  <p>After addressing these, re-request publication and the checks will re-run automatically:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    nemar dataset publish request ${escapeHtml(datasetId)}
  </div>

  <p style="font-size: 13px; color: #666;">If you believe this was flagged in error, reply to this email and we'll take a look.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    `Publication on hold: ${datasetId}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Notify user that their dataset has been published
 */
export async function sendPublicationApprovedEmail(
  to: string,
  username: string,
  datasetId: string,
  doi: string | null,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
  opts?: { anonymous?: boolean },
): Promise<void> {
  // #1408: an anonymous release ends here too, and almost every sentence below
  // is wrong for it. The DOI exists but is RESERVED -- registered, not
  // advertised, and it does not resolve -- so offering it as "your DOI" with a
  // doi.org link is the one mistake that matters: a depositor mid-submission
  // would paste a dead identifier into a blinded manuscript. What they cite
  // during review is the landing page.
  const anonymous = opts?.anonymous === true;
  const safeDoi = doi ? escapeHtml(doi) : "";
  const landing = escapeHtml(datasetLandingUrl(datasetId));
  const doiSection = !doi
    ? ""
    : anonymous
      ? `<h2 style="color: #333; font-size: 18px; margin-top: 30px;">Citing it during review</h2>
       <p>Cite the dataset page. It shows the data, states that authorship is withheld, and names nobody:</p>
       <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
         <a href="${landing}" style="color: #2563eb;">${landing}</a>
       </div>
       <p style="color: #666; font-size: 14px;">A DOI (<code>${safeDoi}</code>) is reserved for this dataset but is deliberately not active: a live DOI record would carry a public author list. It is activated, with your attribution, when you publish after acceptance. Do not cite it yet, it will not resolve.</p>`
      : `<h2 style="color: #333; font-size: 18px; margin-top: 30px;">DOI</h2>
       <p>Your dataset has been assigned the following DOI:</p>
       <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
         <a href="https://doi.org/${safeDoi}" style="color: #2563eb;">${safeDoi}</a>
       </div>`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #16a34a;">${anonymous ? "Anonymous release is live" : "Dataset Published!"}</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>${
    anonymous
      ? `Your dataset <strong>${escapeHtml(datasetId)}</strong> is now listed, browsable and downloadable, with your identity withheld. Its GitHub repository stays private and NEMAR names nobody.`
      : `Your dataset <strong>${escapeHtml(datasetId)}</strong> has been published and is now publicly available.`
  }</p>

  ${doiSection}
${
  anonymous
    ? `
  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">After acceptance</h2>
  <p>Restore the real <code>Authors</code> in <code>dataset_description.json</code>, commit to <code>main</code> (your repository is still private, so you can commit directly), and request publication again <strong>without</strong> <code>--anonymous</code>. That activates the DOI with your attribution and makes the repository public.</p>
  <p style="color: #666; font-size: 14px;">NEMAR withholds everything it derives about you. It cannot blind your own files: check the README, <code>participants.tsv</code> and any identifiers inside your recordings yourself.</p>
`
    : ""
}
  <p>You can check the status of your dataset:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    nemar dataset publish status ${escapeHtml(datasetId)}
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    anonymous ? `Anonymous release is live: ${datasetId}` : `Dataset published: ${datasetId}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Send a 6-digit passwordless sign-in code to the web dashboard user
 * (#569). The code is the user-facing secret; the email is the only
 * channel that delivers it. Templates intentionally include "didn't
 * request this? ignore" footer to dissuade panic when an attacker
 * triggers a request against someone else's email.
 */
export async function sendPasswordlessCodeEmail(
  to: string,
  code: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Your NEMAR sign-in code</h1>

  <p>Use the code below to finish signing in:</p>

  <p style="text-align: center; margin: 30px 0;">
    <span style="display: inline-block; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 32px; letter-spacing: 8px; padding: 16px 24px; background-color: #f4f4f5; border-radius: 8px; color: #111;">
      ${escapeHtml(code)}
    </span>
  </p>

  <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. After 5 incorrect attempts the code is invalidated; request a new one if that happens.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Didn't request this? You can safely ignore this email. Your account has not been changed.
  </p>
</body>
</html>
  `;

  // Generic subject — keeping the code out of the subject line means
  // it doesn't get echoed into provider-side / client-side mail logs
  // that often retain subjects long after the body is purged.
  await sendEmail(
    to,
    "Your NEMAR sign-in code",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Inbox-proof code for a web account's FIRST email verification (ADR 0040
 * phase 2). Sent to the address collected at ORCID sign-up, and again on
 * demand from the dashboard, because ORCID proves the person and not the
 * inbox — and the base tier's whole content (notifications, the sign-in code,
 * the upload-request thread) is delivered to that inbox.
 *
 * Deliberately NOT sendPasswordlessCodeEmail: that mail says "finish signing
 * in", which is the wrong instruction for someone who is already signed in
 * and being asked to confirm the address. Same code hygiene as the sign-in
 * and email-change mails: the code never appears in the subject line.
 */
export async function sendEmailVerificationCodeEmail(
  to: string,
  code: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Verify your email for NEMAR</h1>

  <p>Enter the code below on NEMAR to confirm this is your email address:</p>

  <p style="text-align: center; margin: 30px 0;">
    <span style="display: inline-block; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 32px; letter-spacing: 8px; padding: 16px 24px; background-color: #f4f4f5; border-radius: 8px; color: #111;">
      ${escapeHtml(code)}
    </span>
  </p>

  <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. After 5 incorrect attempts the code is invalidated; request a new one if that happens.</p>

  <p style="color: #666; font-size: 14px;">Verifying activates your account: browsing, your dashboard, and dataset downloads. Uploading a dataset needs a separate, one-time approval from an administrator.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Didn't request this? You can safely ignore this email. Your account has not been changed.
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "Verify your email for NEMAR",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Ownership-proof code for a self-service email change (#911). Sent to the
 * NEW address; nothing is written to the account until the code is verified.
 * Same code hygiene as the sign-in mail: code kept out of the subject line.
 */
export async function sendEmailChangeCodeEmail(
  to: string,
  code: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Confirm your new NEMAR email address</h1>

  <p>Someone asked to make this address the sign-in email for a NEMAR account. Enter the code below on the Settings page to confirm the change:</p>

  <p style="text-align: center; margin: 30px 0;">
    <span style="display: inline-block; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 32px; letter-spacing: 8px; padding: 16px 24px; background-color: #f4f4f5; border-radius: 8px; color: #111;">
      ${escapeHtml(code)}
    </span>
  </p>

  <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. After 5 incorrect attempts the code is invalidated; request a new one if that happens.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Didn't request this? You can safely ignore this email. Your account has not been changed.
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "Confirm your new NEMAR email address",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Tell the PREVIOUS address that an account's sign-in email was changed
 * (#1054; ADR 0044).
 *
 * NEMAR sign-in is passwordless for the dashboard and token-based for the
 * CLI, so the old inbox is the only channel that can reach a legitimate owner
 * whose address was moved out from under them with a stolen session or key.
 * The change itself has already happened by the time this is sent -- this is
 * a notice, not a confirmation step, so there is nothing to confirm and the
 * only link worth following is the support one, and only if this was not you.
 *
 * `maskedNewEmail` is deliberately masked by the caller (`maskEmail`): the
 * person reading the old inbox may no longer be the account owner, which is
 * the whole reason for the mail, and what they need is that the address
 * changed rather than what it changed to.
 */
export async function sendEmailChangedNoticeEmail(
  to: string,
  maskedNewEmail: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Your NEMAR account email was changed</h1>

  <p>The sign-in email for your NEMAR account was changed from this address to <strong>${escapeHtml(maskedNewEmail)}</strong>.</p>

  <p>This address can no longer be used to sign in to the account, and future NEMAR mail goes to the new one.</p>

  <p style="background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px; margin: 24px 0;">
    <strong>If this was not you</strong>, contact NEMAR support at
    <a href="https://nemar.org/support" style="color: #dc2626;">nemar.org/support</a> right away and say which address this notice reached.
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource<br>
    This is a security notice: there is nothing to confirm. The only link above goes to NEMAR support, for use if this was not you.
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "Your NEMAR account email was changed",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Warn a dataset owner that their private, unpublished dataset is approaching
 * the 90-day inactivity deadline and will be removed unless they act (#662).
 * Sent at 30/14/7/2/1 days remaining; the 1-day notice uses urgent red styling
 * and a "Final notice" subject prefix (when `daysLeft` is 1 or less).
 */
export async function sendStalenessWarningEmail(
  to: string,
  datasetId: string,
  datasetName: string,
  daysLeft: number,
  deletionDate: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<void> {
  const isFinal = daysLeft <= 1;
  const accent = isFinal ? "#dc2626" : "#f59e0b";
  const dayLabel = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: ${accent};">${isFinal ? "Final notice: " : ""}Your dataset will be removed in ${escapeHtml(dayLabel)}</h1>

  <p>Your NEMAR dataset <strong>${escapeHtml(datasetId)}</strong>${
    datasetName ? ` (${escapeHtml(datasetName)})` : ""
  } is private, has no DOI, and has had no activity for over ${STALENESS_LIMIT_DAYS - daysLeft} days (approaching the 90-day removal deadline).</p>

  <p>Under NEMAR's cleanup policy it is scheduled for removal on
     <strong>${escapeHtml(deletionDate)}</strong> (in ${escapeHtml(dayLabel)})
     unless you act. <strong>Removal deletes the GitHub repository, the stored
     data, and all records.</strong></p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">How to keep this dataset</h2>
  <p>Do any one of the following before the deadline:</p>
  <ul>
    <li>Request publication (recommended): <code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;">nemar dataset publish request ${escapeHtml(datasetId)}</code></li>
    <li>Push an update or new version so the dataset is no longer inactive.</li>
    <li>Reply to this email and ask the NEMAR admins to keep it.</li>
  </ul>

  <p style="color: #666; font-size: 14px;">A dataset with a DOI, or one that is published, is never auto-removed.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    `${isFinal ? "[NEMAR] Final notice: " : "[NEMAR] Action needed: "}${datasetId} will be removed in ${dayLabel}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
    deliveryEnv,
  );
}

/**
 * Notify admins that a stale dataset has passed its 90-day deadline (#662).
 * The cron deliberately does NOT auto-delete `nm` datasets; this email asks an
 * admin to delete manually so a human always confirms removal of real archive
 * data. `warnStageReached` is the owner's last delivered warning stage (in
 * days remaining), or null if no warning was delivered, so the body can state
 * accurately how far the runway actually progressed. Returns the number of
 * admin recipients the message was successfully delivered to.
 */
export async function sendStalenessAdminReviewEmail(
  adminEmails: string[],
  datasetId: string,
  datasetName: string,
  ownerEmail: string | null,
  warnStageReached: number | null,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<number> {
  const warningSummary =
    warnStageReached !== null
      ? `The most recent warning delivered to the owner was the ${escapeHtml(String(warnStageReached))}-day notice.`
      : "No warning was delivered to the owner (check <code>staleness_warn_stage</code> in D1 before deleting).";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Stale dataset awaiting manual review</h1>

  <p>Dataset <strong>${escapeHtml(datasetId)}</strong>${
    datasetName ? ` (${escapeHtml(datasetName)})` : ""
  } is private, has no DOI, and has been inactive past the 90-day cleanup deadline.</p>

  <p>The owner${
    ownerEmail ? ` (${escapeHtml(ownerEmail)})` : ""
  } was sent removal warnings as the deadline approached. ${warningSummary} The
  cron does <strong>not</strong> auto-delete <code>nm</code> datasets &mdash;
  deletion is a manual admin step so a human always confirms it.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <p>Review the dataset, then keep or delete it:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #dc2626;">nemar admin delete-dataset</span> ${escapeHtml(datasetId)}
  </div>
  <p style="color: #666; font-size: 14px;">To keep it instead, help the owner publish it or mint a DOI; either removes it from cleanup permanently.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  let delivered = 0;
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `[NEMAR] Stale dataset past deadline: ${datasetId} (awaiting manual deletion)`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
        deliveryEnv,
      );
      delivered++;
    } catch (error) {
      console.error(
        `Failed to send staleness review email to ${redactRecipient(adminEmail)}: ${sendFailureText(error, adminEmail)}`,
      );
    }
  }
  return delivered;
}

/**
 * Alert admins that the staging-only exemplar invariant was violated: an
 * `is_exemplar=1` row exists in PRODUCTION D1 (epic #923). Phase 4's visibility
 * carve-outs admit such rows with no runtime env check, so one in prod is
 * silently public across catalog/search/data-index. This is structurally
 * impossible under normal operation (the creation endpoint 403s in prod), so if
 * it fires a gate was bypassed — page a human, don't just log.
 */
export async function sendExemplarInvariantAlertEmail(
  adminEmails: string[],
  count: number,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<number> {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Exemplar invariant violated in production</h1>
  <p><strong>${escapeHtml(String(count))}</strong> dataset row(s) with <code>is_exemplar = 1</code>
  exist in the <strong>production</strong> database. Exemplars are a staging-only fleet and the
  creation endpoint 403s in production, so this should be impossible.</p>
  <p>These rows are <strong>silently public</strong> across the catalog, search, and data index (the
  Phase 4 visibility carve-outs admit <code>is_exemplar = 1</code> with no runtime environment check).
  A gate was bypassed &mdash; investigate immediately.</p>
  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    SELECT dataset_id FROM datasets WHERE is_exemplar = 1;
  </div>
  <p style="color: #666; font-size: 14px;">Confirm each row, delete it (or clear the flag), and audit the exemplar creation gate.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;"><a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource</p>
</body>
</html>
  `;
  let delivered = 0;
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `[NEMAR] ALERT: ${count} exemplar row(s) leaked into production`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
        deliveryEnv,
      );
      delivered++;
    } catch (error) {
      console.error(
        `Failed to send exemplar-invariant alert to ${redactRecipient(adminEmail)}: ${sendFailureText(error, adminEmail)}`,
      );
    }
  }
  return delivered;
}

/**
 * A finding as the mail renders it. Structurally identical to
 * `AnonymityFinding` in `anonymity-sweep.ts`, re-declared here so `email.ts`
 * does not import a sweep -- the dependency runs the other way.
 */
export interface AnonymityFindingForEmail {
  check: string;
  severity: "invariant" | "deposit";
  detail: string;
  file?: string;
}

/**
 * The anonymity sweep found something on an anonymous deposit (#1409).
 *
 * Two audiences, one template, because the FACTS are the same and only the
 * framing differs: the depositor is told what to fix in their own files, the
 * admin is told that a guarantee NEMAR made may have stopped holding. Sending
 * different facts to the two would be the beginning of the pair disagreeing.
 *
 * It never quotes the matched text. `AnonymityFinding.detail` names the file
 * and the kind of match and stops there, because a mail is forwardable and
 * because the depositor already knows their own name. What they need is the
 * file, and they have it.
 *
 * `unchecked` is rendered on EVERY message, including one with findings.
 * "We found two things" and "we found two things and could not look at three
 * more" are different sentences, and only one of them is true (ADR 0005, 0054).
 */
export async function sendAnonymityFindingsEmail(
  to: string[],
  datasetId: string,
  findings: readonly AnonymityFindingForEmail[],
  unchecked: readonly string[],
  opts: { audience: "depositor" | "admin" },
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<{ delivered: string[]; failed: { recipient: string; error: string }[] }> {
  const depositor = opts.audience === "depositor";
  const invariants = findings.filter((f) => f.severity === "invariant");
  const deposit = findings.filter((f) => f.severity === "deposit");

  const list = (items: readonly AnonymityFindingForEmail[]): string =>
    items
      .map((f) => `<li style="margin-bottom: 8px;">${escapeHtml(f.detail)}</li>`)
      .join("\n      ");

  const depositSection =
    deposit.length === 0
      ? ""
      : `
  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">In the dataset's own files</h2>
  <p>${
    depositor
      ? "These are files you wrote. They are part of the dataset and are served publicly, so NEMAR cannot conceal what they say -- only you can change them."
      : "These are the depositor's own files. NEMAR cannot blind them; the depositor has been told."
  }</p>
  <ul style="padding-left: 20px;">
      ${list(deposit)}
  </ul>`;

  const invariantSection =
    invariants.length === 0
      ? ""
      : `
  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">In what NEMAR controls</h2>
  <p>${
    depositor
      ? "These are ours, not yours. An administrator has been told at the same time as you."
      : "These are NEMAR's own guarantees, and each one is a bug. Nothing was repaired automatically: a dataset that has already been disclosed cannot be un-disclosed by flipping a flag, and an automatic fix would destroy the evidence that the guarantee failed."
  }</p>
  <ul style="padding-left: 20px;">
      ${list(invariants)}
  </ul>`;

  const uncheckedSection =
    unchecked.length === 0
      ? ""
      : `
  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">What this check did NOT look at</h2>
  <p style="color: #666; font-size: 14px;">${escapeHtml(unchecked.join(", "))}</p>
  <p style="color: #666; font-size: 14px;">Identity inside the recordings themselves -- the recording-identification field of an EDF or BDF header, <code>EEG.comments</code> in an EEGLAB file, subject fields in a FIFF header -- is never checked here. A clean result above is not a statement about those.</p>`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #d97706;">Anonymity check: ${escapeHtml(datasetId)}</h1>

  <p>${
    depositor
      ? `Your anonymous deposit <strong>${escapeHtml(datasetId)}</strong> is concealing you, and a scheduled check found something that may not be.`
      : `The scheduled anonymity check found something on <strong>${escapeHtml(datasetId)}</strong>.`
  }</p>
  ${depositSection}
  ${invariantSection}
  ${uncheckedSection}

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Seeing it yourself</h2>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    nemar dataset status ${escapeHtml(datasetId)}
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  // Returns what was delivered rather than swallowing it, the way
  // `sendExemplarInvariantAlertEmail` above already does. For this sweep the
  // mail is the only copy the depositor gets, so "nobody was told" has to be a
  // fact the caller can report rather than a line in a Worker log.
  const delivered: string[] = [];
  const failed: { recipient: string; error: string }[] = [];
  for (const recipient of to) {
    try {
      await sendEmail(
        recipient,
        `[NEMAR] Anonymity check found ${findings.length} item(s): ${datasetId}`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
        deliveryEnv,
      );
      delivered.push(recipient);
    } catch (error) {
      console.error(`Failed to send anonymity findings email to ${recipient}:`, error);
      failed.push({
        recipient,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { delivered, failed };
}

/** How long one send of the identifier sweep's weekly report waits for Resend. */
export const IDENTIFIER_SWEEP_EMAIL_TIMEOUT_MS = 15_000;

/**
 * What the identifier sweep's weekly report says (ADR 0088). Structurally the
 * report `identifier-sweep-report.ts` renders, re-declared here so `email.ts`
 * does not import a sweep; the dependency runs the other way.
 */
export interface IdentifierSweepReportForEmail {
  subject: string;
  headline: string;
  attention: boolean;
  lines: readonly string[];
}

/**
 * Send the identifier sweep's weekly report to each admin, one message each.
 *
 * Every line is escaped: a line carries dataset ids, finding kinds, counts and
 * fixed words, never a value, and escaping is what keeps it that way if a line
 * ever carried anything else. Returns how many admins it reached, so the caller
 * records the week as sent only when someone received it, and how many sends
 * ended without a definite answer (a timeout, a dropped connection, a 5xx), so
 * the caller never treats a send that may have landed as one that reached nobody.
 */
export async function sendIdentifierSweepReportEmail(
  adminEmails: readonly string[],
  report: IdentifierSweepReportForEmail,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
  deliveryEnv?: EmailDeliveryEnv,
): Promise<{ delivered: number; ambiguous: number }> {
  const color = report.attention ? "#d97706" : "#16a34a";
  const body = report.lines.map((line) => escapeHtml(line)).join("\n");
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 720px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #333; font-size: 20px;">Identifier sweep: weekly report</h1>
  <p style="color: ${color}; font-weight: bold;">${escapeHtml(report.headline)}</p>
  <pre style="white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f4f4f5; padding: 16px; border-radius: 8px;">${body}</pre>
  <p style="color: #666; font-size: 14px;">This report arrives every week whether or not anything is wrong; a week without it means the reporter is not running. The sweep reports and never repairs. Read it on demand: <code>GET /admin/identifier-sweep</code>.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;"><a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource</p>
</body>
</html>
  `;
  let delivered = 0;
  let ambiguous = 0;
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        report.subject,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
        deliveryEnv,
        IDENTIFIER_SWEEP_EMAIL_TIMEOUT_MS,
      );
      delivered++;
    } catch (error) {
      // Refused for certain: a 4xx from Resend, or the dev fence before any
      // request. Anything else (a timeout, a dropped connection, a 5xx) may have
      // been accepted, and the caller must not treat it as "reached nobody".
      if (!(error instanceof EmailRejectedError || error instanceof DevEmailFenceError)) {
        ambiguous++;
      }
      // `sendEmail`'s message names the recipient; redact it in the message too.
      console.error(
        `Failed to send the identifier sweep report to ${redactRecipient(adminEmail)}:`,
        sendFailureText(error, adminEmail),
      );
    }
  }
  return { delivered, ambiguous };
}
