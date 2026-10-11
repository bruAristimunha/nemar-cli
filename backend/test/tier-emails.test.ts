/**
 * Which email fires at which moment, now that the tiers moved (ADR 0040
 * phase 2, #1252).
 *
 * The key-ready mail used to be sent at admin approval, because that was when
 * the API key became retrievable. It is retrievable at email verification now,
 * so the mail that explains how to retrieve it has to arrive then — and what
 * approval announces is the thing approval actually grants, upload access. Get
 * this pairing wrong in either direction and the product lies to someone:
 * "your account is approved, fetch your key" to a user who has had one for
 * weeks, or nothing at all to a user who could already be working.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, real
 * Hono dispatch, the real services/email.ts building real HTML and issuing a
 * real fetch. Only the DESTINATION moves — helpers/resend.ts redirects
 * api.resend.com to a local server — so these assert on what would genuinely
 * have been mailed. No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { authRoutes } from "../src/routes/auth";
import { sendVerificationEmail } from "../src/services/email";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { sendsTo, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "tiermail-admin-key-0123456789abcdef0123456789";
const ADMIN_EMAIL = "mailadmin@nemar.test";
const USER_EMAIL = "newcli@nemar.test";
const WEB_EMAIL = "newweb@nemar.test";
const VERIFY_TOKEN = "verify-token-for-the-tier-email-test";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    // The delivery fence admits these recipients, so the sends reach the
    // local stand-in rather than being refused before the fetch.
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    RESEND_API_KEY: "fake-resend-key",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    API_BASE_URL: "https://api.test",
  } as unknown as Bindings;
}

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, github_username, status, role,
                        email_verified, service_access)
     VALUES ('mailadmin', ?, 'mailadmin-gh', 'approved', 'admin', 1, 1)`,
    [ADMIN_EMAIL],
  );
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'mailadmin'")
    .get();
  if (!row) throw new Error("admin seed failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

/** A historical CLI account mid-flow; migration 0093 has cleared its hash. */
function seedUnverifiedCliUser(): void {
  db.run(
    `INSERT INTO users (username, email, github_username, description, status,
                        signup_source, email_verified, verification_token,
                        verification_expires_at, service_access)
     VALUES ('newcli', ?, 'newcli-gh', 'Studying auditory oddball responses', 'pending',
             'cli', 0, ?, datetime('now', '+1 day'), 0)`,
    [USER_EMAIL, VERIFY_TOKEN],
  );
}

/** A verified CLI account awaiting the upload decision. */
function seedVerifiedCliUser(): void {
  db.run(
    `INSERT INTO users (username, email, github_username, status, signup_source,
                        email_verified, service_access)
     VALUES ('waiting', ?, 'waiting-gh', 'verified', 'cli', 1, 0)`,
    ["waiting@nemar.test"],
  );
}

/** A verified web account (username NULL) awaiting the upload decision. */
function seedVerifiedWebUser(): number {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, orcid, orcid_verified,
                        service_access)
     VALUES (?, 'verified', 'web', 1, '0000-0002-1825-0097', 1, 0)`,
    [WEB_EMAIL],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
    .get(WEB_EMAIL);
  if (!row) throw new Error("web seed failed");
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authRoutes);
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("GET /auth/verify (the CLI verification link)", () => {
  test("mails the key-ready instructions to the user, at the moment the key becomes retrievable", async () => {
    seedUnverifiedCliUser();

    const calls = await withFakeResend(async (calls) => {
      const res = await app.request(`/auth/verify?token=${VERIFY_TOKEN}`, {}, env());
      expect(res.status).toBe(200);
      return calls;
    });

    const toUser = sendsTo(calls, USER_EMAIL);
    expect(toUser.length).toBe(1);
    expect(toUser[0].subject).toBe("Your NEMAR API key is ready");
    expect(toUser[0].html).toContain("nemar auth login");
    // The command that took a password is gone, and the mail must not name it.
    expect(toUser[0].html).not.toContain("retrieve-key");
    expect(toUser[0].html).not.toMatch(/password/i);
    // The claim it must NOT make: verification is not approval, and this
    // account cannot upload anything yet.
    expect(toUser[0].html).not.toContain("account has been approved");

    const row = db
      .query<{ status: string; service_access: number }, [string]>(
        "SELECT status, service_access FROM users WHERE email = ?",
      )
      .get(USER_EMAIL);
    expect(row?.status).toBe("verified");
    expect(row?.service_access).toBe(0);
  });

  test("in production, notifies the admins that a new account is verified", async () => {
    // Admin notifications are production-only (getAdminEmailsForCategory's
    // fence in services/email.ts), so this now has to run against a
    // production-configured app to actually observe the send -- production
    // bypasses DEV_EMAIL_ALLOWLIST entirely, so no allow-list entry is
    // needed for ADMIN_EMAIL here.
    seedUnverifiedCliUser();

    const calls = await withFakeResend(async (calls) => {
      await app.request(
        `/auth/verify?token=${VERIFY_TOKEN}`,
        {},
        { ...env(), ENVIRONMENT: "production" },
      );
      return calls;
    });

    const toAdmin = sendsTo(calls, ADMIN_EMAIL);
    expect(toAdmin.length).toBe(1);
    expect(toAdmin[0].subject).toContain("New verified account");
    // The admin's action is the upload grant, so that is the command the
    // mail names.
    expect(toAdmin[0].html).toContain("nemar admin approve");
  });

  test("outside production, the admin notification is suppressed by default", async () => {
    // env() is a dev/test-configured app (ENVIRONMENT: "test") with
    // ADMIN_EMAIL itself on DEV_EMAIL_ALLOWLIST -- proving that the
    // per-recipient delivery fence alone would NOT have stopped this send
    // (the admin's own address is deliverable to). getAdminEmailsForCategory's
    // production-only fence is what actually suppresses it, before the
    // recipient list is even built.
    seedUnverifiedCliUser();

    const calls = await withFakeResend(async (calls) => {
      const res = await app.request(`/auth/verify?token=${VERIFY_TOKEN}`, {}, env());
      expect(res.status).toBe(200);
      return calls;
    });

    // The user-facing key-ready mail is unrelated to the admin-notification
    // fence and still goes out, so this isn't the whole route going dark.
    expect(sendsTo(calls, USER_EMAIL).length).toBe(1);
    expect(sendsTo(calls, ADMIN_EMAIL).length).toBe(0);
  });

  test("outside production, DEV_ADMIN_NOTIFICATIONS=1 opts back in for a deliberate staging test", async () => {
    seedUnverifiedCliUser();

    const calls = await withFakeResend(async (calls) => {
      await app.request(
        `/auth/verify?token=${VERIFY_TOKEN}`,
        {},
        { ...env(), DEV_ADMIN_NOTIFICATIONS: "1" },
      );
      return calls;
    });

    expect(sendsTo(calls, ADMIN_EMAIL).length).toBe(1);
  });
});

describe("the signup verification email (the first one anyone gets)", () => {
  test("says the account is active after verifying, not that an admin will review it", async () => {
    // Driven through the real exported wrapper at its real boundary (the
    // same shape email-delivery-fence.test.ts uses), because this template is
    // what sets a new user's expectations before any other copy reaches them:
    // it used to promise "an administrator will review your account. Once
    // approved, you'll receive your API key", which is now two wrong claims.
    const captured = await withFakeResend(async (calls) => {
      await sendVerificationEmail(
        USER_EMAIL,
        "newcli",
        "https://api.test/auth/verify?token=x",
        "fake-resend-key",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        { ENVIRONMENT: "test", DEV_EMAIL_ALLOWLIST: "@nemar.test" },
      );
      return sendsTo(calls, USER_EMAIL);
    });

    expect(captured.length).toBe(1);
    expect(captured[0].html).toContain("nemar auth login");
    expect(captured[0].html).not.toContain("retrieve-key");
    expect(captured[0].html).not.toContain("an administrator will review your account");
    expect(captured[0].html).not.toContain("Once approved, you'll receive your API key");
    // Not just the two old sentences: ANY sentence that ties the key to an
    // approval is the same wrong claim rephrased, in either word order.
    // Bounded to one sentence (no "." and no tag between) so the separate
    // upload-access paragraph below does not trip it.
    expect(captured[0].html).not.toMatch(/approv[a-z]*[^.<]{0,80}API key/i);
    expect(captured[0].html).not.toMatch(/API key[^.<]{0,80}approv/i);
    // Upload access is still named -- dropping the false claim must not drop
    // the true one, that uploading needs a separate approval.
    expect(captured[0].html).toContain("upload access");
  });
});

describe("GET /auth/verify when the mail does not go", () => {
  test("the page tells the user to run `nemar auth login`, and promises no email", async () => {
    // RESEND_API_KEY unset is the dev/test shape, and the delivery fence and
    // a Resend outage land in the same place: the page is then the ONLY
    // remaining channel telling this user how to get their key, so it must
    // not point at an inbox nothing was sent to.
    seedUnverifiedCliUser();
    const noMailEnv = { ...env(), RESEND_API_KEY: undefined } as unknown as Bindings;

    const calls = await withFakeResend(async (calls) => {
      const res = await app.request(`/auth/verify?token=${VERIFY_TOKEN}`, {}, noMailEnv);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("nemar auth login");
      expect(html).not.toContain("retrieve-key");
      expect(html).not.toContain("we've emailed you");
      return calls;
    });

    // Nothing was mailed to the USER, so the page's claim and the behaviour
    // agree. (The admin notification is a separate, pre-existing path that
    // does not gate on RESEND_API_KEY; it is not what this page promises.)
    expect(sendsTo(calls, USER_EMAIL).length).toBe(0);
    // The verification itself still committed; only the mail is missing.
    expect(
      db
        .query<{ status: string }, [string]>("SELECT status FROM users WHERE email = ?")
        .get(USER_EMAIL)?.status,
    ).toBe("verified");
  });

  test("the page promises the email only when one was actually sent", async () => {
    seedUnverifiedCliUser();
    await withFakeResend(async () => {
      const res = await app.request(`/auth/verify?token=${VERIFY_TOKEN}`, {}, env());
      expect(await res.text()).toContain("we've emailed you");
    });
  });
});

describe("POST /admin/approve/:username", () => {
  test("mails upload-access-granted, not the key-ready instructions", async () => {
    seedVerifiedCliUser();

    const calls = await withFakeResend(async (calls) => {
      const res = await app.request(
        "/admin/approve/waiting",
        { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env(),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).email_sent).toBe(true);
      return calls;
    });

    const toUser = sendsTo(calls, "waiting@nemar.test");
    expect(toUser.length).toBe(1);
    expect(toUser[0].subject).toBe("Upload access granted on NEMAR");
    expect(toUser[0].html).toContain("nemar sandbox");
    // Re-sending sign-in instructions to someone who has had a key since
    // they verified reads as "your old key stopped working".
    expect(toUser[0].html).not.toContain("nemar auth login");
    expect(toUser[0].html).not.toContain("retrieve-key");
  });

  test("a web account gets the dashboard-flavoured variant", async () => {
    const id = seedVerifiedWebUser();

    const calls = await withFakeResend(async (calls) => {
      const res = await app.request(
        `/admin/approve/by-id/${id}`,
        { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env(),
      );
      expect(res.status).toBe(200);
      return calls;
    });

    const toUser = sendsTo(calls, WEB_EMAIL);
    expect(toUser.length).toBe(1);
    expect(toUser[0].subject).toBe("Upload access granted on NEMAR");
    // No username, no password, no API key: CLI instructions would be dead
    // ends, so this variant points at the dashboard.
    expect(toUser[0].html).toContain("nemar.org/upload");
    expect(toUser[0].html).not.toContain("nemar auth");
  });
});
