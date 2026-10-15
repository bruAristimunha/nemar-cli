/**
 * Real route tests for a web account's road to `verified` (ADR 0040 phase 2,
 * #1252).
 *
 * ORCID sign-up used to write `status='approved'` itself, so 19 accounts held
 * the upload tier with no admin, no audit row and an unconfirmed email. It now
 * lands at `pending` and mails a code; redeeming that code — through the
 * dedicated endpoint or through an email-code sign-in, which proves the same
 * inbox by the same means — is what makes an account `verified`.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration
 * applied, real Hono dispatch, real session issuance via issueSession(), real
 * HMAC code hashing via the production hashAuthCode, and a local Bun.serve
 * standing in for ORCID's token endpoint and for Resend (helpers/resend.ts) —
 * the two external boundaries. No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { MAX_CODE_ATTEMPTS, hashAuthCode } from "../src/services/auth-code";
import { PENDING_COOKIE_NAME, signPending } from "../src/services/orcid-auth";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { sendsTo, withFakeResend } from "./helpers/resend";

const ORIGIN = "https://nemar.org";
const ENCRYPTION_KEY = "web-verify-test-encryption-key-0123456789";
const ORCID_ID = "0000-0002-1825-0097";
/** `@nemar.test` is the synthetic-target suffix the non-production fence
 *  admits (services/auth-code.ts), so codes for it are echoed rather than
 *  mailed — and the allow-list below lets the ADMIN notification through to
 *  the fake Resend so it can be counted. */
const USER_EMAIL = "newweb@nemar.test";
const ADMIN_EMAIL = "tieradmin@nemar.test";
/** The address an /auth/email/change/* flow moves TO. Same synthetic suffix,
 *  so its code is echoed rather than mailed. */
const NEW_EMAIL = "movedweb@nemar.test";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
/** Bumped per seeded row so each gets its own iD; reset with the database. */
let seededOrcidCount = 0;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: "",
    RESEND_API_KEY: "fake-resend-key",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    // Admin notifications are production-only by default
    // (getAdminEmailsForCategory's fence in services/email.ts); this suite is
    // about WHEN the admin notification fires (once, on the pending->verified
    // transition, through either road), not about that fence, so it opts back
    // in deliberately. The fence itself is covered in tier-emails.test.ts and
    // email-delivery-fence.test.ts.
    DEV_ADMIN_NOTIFICATIONS: "1",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as unknown as Bindings;
}

/**
 * Redirect ORCID's PUBLIC API to a local server for the duration of `fn`.
 *
 * finalize kicks off a best-effort name refresh AFTER the response
 * (`afterResponse` + refreshUserName), and orcidPubBase() derives its host
 * from a fixed map rather than from ORCID_API_BASE, so there is no env knob
 * that keeps that call off the live internet. Same redirect shape as
 * helpers/resend.ts: fetch stays real, only the destination moves.
 */
async function withLocalOrcidPub<T>(fn: () => Promise<T>): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({
          name: { "given-names": { value: "Ada" }, "family-name": { value: "Lovelace" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith("orcid.org")) {
      const local = new URL(url.pathname + url.search, `http://127.0.0.1:${server.port}`);
      return realFetch(new Request(local, req));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    server.stop(true);
  }
}

function seedAdmin(): void {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES ('tieradmin', ?, 'x', 'approved', 'admin', 1, 1)`,
    [ADMIN_EMAIL],
  );
}

/**
 * A web/ORCID-shaped row: username NULL, ORCID verified, email unverified.
 *
 * Each seeded row gets a DISTINCT iD. It used to reuse ORCID_ID for every
 * call, which migration 0077 now refuses outright (an iD backs one live
 * account, ADR 0043) -- the fixture was manufacturing exactly the duplicate
 * this suite's sibling tests exist to prevent. Keeping ORCID_ID off these rows
 * also means the finalize tests below, which sign a pending token FOR
 * ORCID_ID, are exercising an unclaimed iD rather than colliding with a
 * fixture.
 */
function seedWebUser(email: string, status = "pending"): number {
  seededOrcidCount += 1;
  const orcid = `0000-0002-9999-${String(seededOrcidCount).padStart(4, "0")}`;
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, orcid, orcid_verified,
                        given_name, family_name, service_access)
     VALUES (?, ?, 'web', 0, ?, 1, 'Ada', 'Lovelace', 0)`,
    [email, status, orcid],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row.id;
}

async function sessionCookie(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, null, null, "orcid");
  return `nemar_session=${cookieIdRaw}`;
}

function post(path: string, cookie: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
    env(),
  );
}

/** Insert a code for (email, userId), using the production hasher so the
 *  route's compare is the real one. `expiresIn` is an SQLite datetime
 *  modifier so a test can plant an EXPIRED code (nothing else in the suite
 *  does, and the TTL is otherwise unfalsifiable); `attempts` pre-loads the
 *  guess counter. */
async function plantCode(
  email: string,
  userId: number | null,
  code: string,
  {
    expiresIn = "+10 minutes",
    attempts = 0,
    createdIn = "+0 seconds",
  }: { expiresIn?: string; attempts?: number; createdIn?: string } = {},
): Promise<void> {
  db.run(
    `INSERT INTO auth_codes (email, code_hash, expires_at, user_id, attempts, created_at)
     VALUES (?, ?, datetime('now', ?), ?, ?, datetime('now', ?))`,
    [email, await hashAuthCode(code, env()), expiresIn, userId, attempts, createdIn],
  );
}

function userRow(id: number) {
  const row = db
    .query<{ status: string; email_verified: number; service_access: number }, [number]>(
      "SELECT status, email_verified, service_access FROM users WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error(`no user ${id}`);
  return row;
}

function liveCodes(email: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM auth_codes WHERE email = ? AND used_at IS NULL",
      )
      .get(email)?.n ?? 0
  );
}

/**
 * Make every UPDATE on `users` fail, for real, using SQLite's own trigger
 * machinery — the same kind of fault injection the phase 1 tests use when
 * they DROP the audit table. Nothing is mocked: the production statements run
 * against a database that genuinely refuses them, which is the only way to
 * reach the post-consumption failure branch of the two verify routes.
 */
function blockUserWrites(): void {
  db.run(
    `CREATE TRIGGER refuse_user_updates BEFORE UPDATE ON users
     BEGIN SELECT RAISE(ABORT, 'user writes are blocked in this test'); END`,
  );
}

/**
 * Make every read of `users` fail, and let it be undone.
 *
 * `blockUserWrites` cannot do this: SQLite has no SELECT trigger, so a fault
 * on the READ path has to come from the schema. Renaming the table makes the
 * next `SELECT ... FROM users` fail to prepare with "no such table", which is
 * the shape of a transient storage failure and is reversible -- every row
 * survives the round trip, so the same request can be replayed once the fault
 * clears. Still the real engine: nothing is stubbed, the statement genuinely
 * fails.
 */
function hideUsersTable(): void {
  db.run("ALTER TABLE users RENAME TO users_hidden");
}

function restoreUsersTable(): void {
  db.run("ALTER TABLE users_hidden RENAME TO users");
}

function codeRow(email: string) {
  const row = db
    .query<{ id: number; used_at: string | null }, [string]>(
      "SELECT id, used_at FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1",
    )
    .get(email);
  if (!row) throw new Error(`no code for ${email}`);
  return row;
}

beforeEach(() => {
  db = freshDb();
  seededOrcidCount = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authOrcidRoutes);
});

describe("POST /auth/orcid/finalize", () => {
  async function finalize(email = USER_EMAIL): Promise<Response> {
    const pending = await signPending(
      { orcid: ORCID_ID, name: "Ada Lovelace", exp: Date.now() + 60_000 },
      ENCRYPTION_KEY,
    );
    return withLocalOrcidPub(() =>
      app.request(
        "/auth/orcid/finalize",
        {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            Cookie: `${PENDING_COOKIE_NAME}=${pending}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email, city: "Cambridge", country: "GB" }),
        },
        env(),
      ),
    );
  }

  test("lands the account at `pending`, unverified, with no approval stamps", async () => {
    const res = await finalize();
    expect(res.status).toBe(200);
    const body = await res.json();
    // The dashboard reads this to decide whether to show the verify step.
    expect(body.user.status).toBe("pending");

    const row = db
      .query<
        {
          status: string;
          email_verified: number;
          approved_at: string | null;
          service_access: number;
        },
        [string]
      >("SELECT status, email_verified, approved_at, service_access FROM users WHERE email = ?")
      .get(USER_EMAIL);
    expect(row?.status).toBe("pending");
    expect(row?.email_verified).toBe(0);
    // Auto-approval is what ADR 0040 removed: no stamp, no grant, no admin
    // was ever involved, and the row must not pretend otherwise.
    expect(row?.approved_at).toBeNull();
    expect(row?.service_access).toBe(0);
  });

  test("mails exactly one verification code, bound to the new account", async () => {
    const res = await finalize();
    const body = await res.json();
    expect(body.code_sent).toBe(true);

    const userId = db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
      .get(USER_EMAIL)?.id;
    const codes = db
      .query<{ n: number; user_id: number | null }, [string]>(
        "SELECT COUNT(*) AS n, user_id FROM auth_codes WHERE email = ?",
      )
      .get(USER_EMAIL);
    expect(codes?.n).toBe(1);
    // user_id set is what keeps this code out of the sign-in lookup, which
    // filters `user_id IS NULL`.
    expect(codes?.user_id).toBe(userId ?? -1);
  });

  test("a duplicate email is refused before any account or code exists", async () => {
    seedWebUser("taken@nemar.test", "verified");
    const res = await finalize("taken@nemar.test");
    expect(res.status).toBe(409);
    expect(liveCodes("taken@nemar.test")).toBe(0);
  });
});

describe("POST /auth/email/verify", () => {
  test("flips pending -> verified, audits it, and notifies the admins once", async () => {
    seedAdmin();
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(USER_EMAIL, id, "123456");

    const calls = await withFakeResend(async (calls) => {
      const res = await post("/auth/email/verify", cookie, { code: "123456" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.status).toBe("active");
      expect(body.user.email_verified).toBe(true);
      return calls;
    });

    const row = userRow(id);
    expect(row.status).toBe("verified");
    expect(row.email_verified).toBe(1);
    // Verification is not approval: the upload grant has exactly one writer
    // and it is not this route.
    expect(row.service_access).toBe(0);

    const audit = db
      .query<{ details: string }, [string]>(
        "SELECT details FROM audit_log WHERE action = 'email_verified' AND resource_id = ?",
      )
      .get(String(id));
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit?.details ?? "{}").via).toBe("verify_endpoint");

    expect(sendsTo(calls, ADMIN_EMAIL).length).toBe(1);
  });

  test("a second call is idempotent: 200, no second notification, no second audit row", async () => {
    seedAdmin();
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(USER_EMAIL, id, "123456");

    // BOTH calls run behind the fake Resend: the first one legitimately
    // notifies, and letting it reach the real api.resend.com from a test
    // suite is not an option. The assertion is on the SECOND call's sends.
    const [before, after] = await withFakeResend(async (calls) => {
      await post("/auth/email/verify", cookie, { code: "123456" });
      const notifiedOnce = sendsTo(calls, ADMIN_EMAIL).length;

      const res = await post("/auth/email/verify", cookie, { code: "123456" });
      // The code is spent, but the honest answer to "verify me" from a
      // verified account is "done" -- not "invalid code".
      expect(res.status).toBe(200);
      expect((await res.json()).already_verified).toBe(true);
      return [notifiedOnce, sendsTo(calls, ADMIN_EMAIL).length];
    });

    expect(before).toBe(1);
    expect(after).toBe(1);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'email_verified' AND resource_id = ?",
        )
        .get(String(id))?.n,
    ).toBe(1);
  });

  test("a wrong code is refused, counted, and changes nothing", async () => {
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(USER_EMAIL, id, "123456");

    const res = await post("/auth/email/verify", cookie, { code: "654321" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("code_incorrect");
    expect(userRow(id).status).toBe("pending");
    expect(
      db.query<{ attempts: number }, []>("SELECT attempts FROM auth_codes LIMIT 1").get()?.attempts,
    ).toBe(1);
  });

  test("another account's code for the same address cannot be redeemed", async () => {
    // The (email, user_id) pairing from migration 0066 is what makes this
    // impossible; without it a shared inbox would be a takeover vector.
    const mine = seedWebUser(USER_EMAIL);
    const other = seedWebUser("other@nemar.test");
    const cookie = await sessionCookie(mine);
    await plantCode(USER_EMAIL, other, "123456");

    const res = await post("/auth/email/verify", cookie, { code: "123456" });
    expect(res.status).toBe(401);
    expect(userRow(mine).status).toBe("pending");
  });

  test("an EXPIRED code is refused and the account stays pending", async () => {
    // The TTL is enforced in the lookup SQL (`expires_at > datetime('now')`).
    // Without a code planted in the past, dropping that clause changes
    // nothing anywhere in the suite.
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(USER_EMAIL, id, "123456", { expiresIn: "-1 minute" });

    const res = await post("/auth/email/verify", cookie, { code: "123456" });
    expect(res.status).toBe(401);
    // Expired is reported as gone, not as mistyped: the user needs a new
    // code, not another look at the digits.
    expect((await res.json()).error).toBe("code_expired");
    expect(userRow(id).status).toBe("pending");
    expect(userRow(id).email_verified).toBe(0);
  });

  test("after MAX_CODE_ATTEMPTS wrong guesses the CORRECT code no longer works", async () => {
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(USER_EMAIL, id, "123456");

    for (let i = 1; i <= MAX_CODE_ATTEMPTS; i++) {
      const res = await post("/auth/email/verify", cookie, { code: "000000" });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("code_incorrect");
      // The count is part of the answer on a session-bound route, and it
      // reaches 0 on the guess that burns the code.
      expect(body.attempts_remaining).toBe(MAX_CODE_ATTEMPTS - i);
    }

    const res = await post("/auth/email/verify", cookie, { code: "123456" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("code_expired");
    expect(userRow(id).status).toBe("pending");
  });

  test("no session is a 401, not a verification", async () => {
    const id = seedWebUser(USER_EMAIL);
    await plantCode(USER_EMAIL, id, "123456");
    const res = await post("/auth/email/verify", "", { code: "123456" });
    expect(res.status).toBe(401);
    expect(userRow(id).status).toBe("pending");
  });
});

describe("when the write after the code is consumed fails", () => {
  test("/auth/email/verify says so, changes nothing, and puts the code back", async () => {
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(USER_EMAIL, id, "123456");
    blockUserWrites();

    const res = await post("/auth/email/verify", cookie, { code: "123456" });

    expect(res.status).toBe(500);
    const body = await res.json();
    // NOT the generic "Verification failed": the caller has to be able to
    // tell "your code was wrong" from "your code was right and we dropped it".
    expect(body.error).toBe("verification_incomplete");
    expect(body.message).toContain("nothing was changed");

    // The account is untouched...
    const row = userRow(id);
    expect(row.status).toBe("pending");
    expect(row.email_verified).toBe(0);
    // ...and the code they correctly typed still works, so the advice the
    // message gives them is advice they can act on.
    expect(codeRow(USER_EMAIL).used_at).toBeNull();
  });

  test("the restored code really is redeemable once the fault clears", async () => {
    // The assertion above reads a column; this one proves the column means
    // what it says by driving the same code back through the route.
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(USER_EMAIL, id, "123456");
    blockUserWrites();
    expect((await post("/auth/email/verify", cookie, { code: "123456" })).status).toBe(500);

    db.run("DROP TRIGGER refuse_user_updates");

    const res = await post("/auth/email/verify", cookie, { code: "123456" });
    expect(res.status).toBe(200);
    expect(userRow(id).status).toBe("verified");
  });

  test("/auth/code/verify says so, and issues no session", async () => {
    const id = seedWebUser(USER_EMAIL);
    await plantCode(USER_EMAIL, null, "222222");
    blockUserWrites();

    const res = await app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: USER_EMAIL, code: "222222", remember: false }),
      },
      env(),
    );

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("sign_in_incomplete");
    // The session INSERT is in the same batch as the promotion, so the
    // rollback takes it with it: no half-signed-in state, and no Set-Cookie
    // for a session row that does not exist.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM web_sessions").get()?.n).toBe(0);
    expect(res.headers.getSetCookie().some((ck) => ck.startsWith("nemar_session="))).toBe(false);
    expect(userRow(id).status).toBe("pending");
    expect(codeRow(USER_EMAIL).used_at).toBeNull();
  });

  test("/auth/email/change/verify says so, changes nothing, and puts the code back", async () => {
    // The third consumer of a code, and the one that used to rethrow: its
    // catch special-cased a users.email UNIQUE violation and let everything
    // else fall to the outer catch, which answers a generic "Verification
    // failed" 500 and never restores. The address the user just proved they
    // control would then be unreachable until they requested another code.
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    // A code for the NEW address, bound to this account, exactly as
    // /email/change/request writes it.
    await plantCode(NEW_EMAIL, id, "654321");
    blockUserWrites();

    const res = await post("/auth/email/change/verify", cookie, {
      email: NEW_EMAIL,
      code: "654321",
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("email_change_incomplete");
    expect(body.message).toContain("nothing was changed");

    // The address did not move...
    expect(
      db.query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(id)?.email,
    ).toBe(USER_EMAIL);
    // ...and the code is usable again, which is what the message promises.
    expect(codeRow(NEW_EMAIL).used_at).toBeNull();
  });

  test("/auth/email/change/verify promotes a pending account whose inbox it just proved", async () => {
    // A web sign-up lands `pending` with email_verified=0. Changing the
    // address and redeeming the code proves the inbox, so it must reach
    // `verified` like /email/verify does. Stamping the flag alone left the
    // account at `pending` with a verified email, where /email/verify then
    // answers already_verified and no road out of `pending` remained.
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(NEW_EMAIL, id, "654321");

    const res = await post("/auth/email/change/verify", cookie, {
      email: NEW_EMAIL,
      code: "654321",
    });

    expect(res.status).toBe(200);
    const row = userRow(id);
    expect(row.status).toBe("verified");
    expect(row.email_verified).toBe(1);
    expect(row.service_access).toBe(0);
  });

  test("the restored email-change code really is redeemable once the fault clears", async () => {
    // Reads the column above; drives it here, so "usable again" is a claim the
    // route itself has honoured rather than one a SELECT infers.
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(NEW_EMAIL, id, "654321");
    blockUserWrites();
    expect(
      (await post("/auth/email/change/verify", cookie, { email: NEW_EMAIL, code: "654321" }))
        .status,
    ).toBe(500);

    db.run("DROP TRIGGER refuse_user_updates");

    const res = await post("/auth/email/change/verify", cookie, {
      email: NEW_EMAIL,
      code: "654321",
    });
    expect(res.status).toBe(200);
    expect(
      db.query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(id)?.email,
    ).toBe(NEW_EMAIL);
  });

  test("/auth/code/verify does not burn a code when the account read fails", async () => {
    // The window this closes: the code used to be consumed immediately after
    // the hash compare, with the account SELECT, the revoked check and the
    // session-statement build all sitting between the burn and the catch that
    // restores it. A failure in any of them reached the outer catch, answered
    // a generic 500, and left the user holding a correctly-typed code that
    // would thereafter read "Invalid or expired code".
    const id = seedWebUser(USER_EMAIL);
    await plantCode(USER_EMAIL, null, "222222");
    const planted = codeRow(USER_EMAIL).id;
    hideUsersTable();

    const res = await app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: USER_EMAIL, code: "222222", remember: false }),
      },
      env(),
    );
    expect(res.status).toBe(500);
    // Nothing was signed in, and no cookie was handed out for a session that
    // does not exist.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM web_sessions").get()?.n).toBe(0);
    expect(res.headers.getSetCookie().some((ck) => ck.startsWith("nemar_session="))).toBe(false);
    // The point of the test: the code is still spendable.
    expect(
      db
        .query<{ used_at: string | null }, [number]>("SELECT used_at FROM auth_codes WHERE id = ?")
        .get(planted)?.used_at,
    ).toBeNull();

    // And spendable in practice, not just on paper.
    restoreUsersTable();
    const retry = await app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: USER_EMAIL, code: "222222", remember: false }),
      },
      env(),
    );
    expect(retry.status).toBe(200);
    expect(userRow(id).status).toBe("verified");
    expect(retry.headers.getSetCookie().some((ck) => ck.startsWith("nemar_session="))).toBe(true);
  });

  test("a code is NOT restored behind a newer one", async () => {
    // Reviving a code that a rotation had retired would leave two live codes
    // for one inbox, so the restore is skipped when a newer row exists.
    //
    // The fixture is deliberately inside-out: the redeemed code is the newest
    // by TIMESTAMP (which is what the lookup orders by) while a later-id row
    // sits behind it (which is what the guard tests, and what rotation
    // actually produces). The real sequence -- a /request landing between
    // this call's lookup and its restore -- is a race that cannot be staged
    // from outside the route, so this stands in for it; without a fixture
    // like this the guard has no coverage at all.
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);
    await plantCode(USER_EMAIL, id, "123456");
    const redeemed = codeRow(USER_EMAIL).id;
    await plantCode(USER_EMAIL, id, "999999", { createdIn: "-1 minute" });

    blockUserWrites();
    expect((await post("/auth/email/verify", cookie, { code: "123456" })).status).toBe(500);

    // Spent and left spent: the user is told to request a new one, and the
    // message says that too.
    expect(
      db
        .query<{ used_at: string | null }, [number]>("SELECT used_at FROM auth_codes WHERE id = ?")
        .get(redeemed)?.used_at,
    ).not.toBeNull();
  });
});

describe("POST /auth/email/verify/request", () => {
  test("issues a code for the session's own address and echoes it in non-production", async () => {
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);

    const res = await post("/auth/email/verify/request", cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dev_code).toMatch(/^\d{6}$/);
    expect(liveCodes(USER_EMAIL)).toBe(1);

    // Round-trip the echoed code through the real endpoint: the two halves
    // agree on the hashing, the (email, user) binding and the TTL.
    const verified = await post("/auth/email/verify", cookie, { code: body.dev_code });
    expect(verified.status).toBe(200);
    expect(userRow(id).status).toBe("verified");
  });

  test("an already-verified account gets an answer, not a code", async () => {
    const id = seedWebUser(USER_EMAIL, "approved");
    db.run("UPDATE users SET email_verified = 1 WHERE id = ?", [id]);
    const cookie = await sessionCookie(id);

    const res = await post("/auth/email/verify/request", cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).already_verified).toBe(true);
    expect(liveCodes(USER_EMAIL)).toBe(0);
  });

  test("without a session it is a 401, and no code is issued", async () => {
    const id = seedWebUser(USER_EMAIL);
    const res = await post("/auth/email/verify/request", "");
    expect(res.status).toBe(401);
    expect(liveCodes(USER_EMAIL)).toBe(0);
    expect(userRow(id).status).toBe("pending");
  });

  test("the per-minute bucket refuses a second request", async () => {
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);

    expect((await post("/auth/email/verify/request", cookie)).status).toBe(200);
    const second = await post("/auth/email/verify/request", cookie);
    expect(second.status).toBe(429);
    expect(liveCodes(USER_EMAIL)).toBe(1);
  });
});

describe("POST /auth/code/verify (the sign-in road to verified)", () => {
  test("signing in with an emailed code promotes a pending account", async () => {
    seedAdmin();
    const id = seedWebUser(USER_EMAIL);
    // A sign-in code carries no user_id (0066): that is what separates it
    // from the account-bound verification and email-change codes.
    await plantCode(USER_EMAIL, null, "222222");

    let signIn!: Response;
    const calls = await withFakeResend(async (calls) => {
      signIn = await app.request(
        "/auth/code/verify",
        {
          method: "POST",
          headers: { Origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email: USER_EMAIL, code: "222222", remember: false }),
        },
        env(),
      );
      expect(signIn.status).toBe(200);
      expect((await signIn.clone().json()).user.status).toBe("active");
      return calls;
    });

    const row = userRow(id);
    expect(row.status).toBe("verified");
    expect(row.email_verified).toBe(1);
    expect(sendsTo(calls, ADMIN_EMAIL).length).toBe(1);
    // The session row rides in the SAME transaction as the promotion, so the
    // cookie the response set must actually resolve. A batch that silently
    // dropped the session INSERT would still return 200 with a Set-Cookie
    // for a session that does not exist.
    const setCookie = signIn.headers.getSetCookie().find((c) => c.startsWith("nemar_session="));
    expect(setCookie).toBeDefined();
    const me = await app.request(
      "/auth/me",
      { headers: { Cookie: (setCookie ?? "").split(";")[0] } },
      env(),
    );
    expect((await me.json()).user?.status).toBe("active");
    expect(
      db
        .query<{ details: string }, [string]>(
          "SELECT details FROM audit_log WHERE action = 'email_verified' AND resource_id = ?",
        )
        .get(String(id))?.details,
    ).toContain("code_signin");
  });

  test("a revoked account is refused, and nothing about it is touched", async () => {
    // The revoked check sits between the code compare and the write, so a
    // reordering that moved the promotion above it would silently re-activate
    // an account an admin had revoked.
    const id = seedWebUser(USER_EMAIL, "revoked");
    await plantCode(USER_EMAIL, null, "444444");

    const res = await app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: USER_EMAIL, code: "444444", remember: false }),
      },
      env(),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Account revoked");

    const row = userRow(id);
    expect(row.status).toBe("revoked");
    expect(row.email_verified).toBe(0);
    // No session was issued either -- a revoked account must not end the
    // request holding a cookie.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM web_sessions").get()?.n).toBe(0);
  });

  test("an approved account signing in keeps its tier and re-notifies nobody", async () => {
    // The promotion is conditional on `status = 'pending'`. If it were an
    // unconditional write, every sign-in would demote an approved account to
    // the base tier and silently revoke its upload access.
    seedAdmin();
    const id = seedWebUser(USER_EMAIL, "approved");
    db.run("UPDATE users SET service_access = 1 WHERE id = ?", [id]);
    await plantCode(USER_EMAIL, null, "333333");

    const calls = await withFakeResend(async (calls) => {
      const res = await app.request(
        "/auth/code/verify",
        {
          method: "POST",
          headers: { Origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email: USER_EMAIL, code: "333333", remember: false }),
        },
        env(),
      );
      expect(res.status).toBe(200);
      return calls;
    });

    const row = userRow(id);
    expect(row.status).toBe("approved");
    expect(row.service_access).toBe(1);
    expect(row.email_verified).toBe(1);
    expect(sendsTo(calls, ADMIN_EMAIL).length).toBe(0);
  });
});

describe("GET /auth/me", () => {
  test("reports a `verified` account as active, and says the email is verified", async () => {
    const id = seedWebUser(USER_EMAIL, "verified");
    db.run("UPDATE users SET email_verified = 1 WHERE id = ?", [id]);
    const cookie = await sessionCookie(id);

    const res = await app.request("/auth/me", { headers: { Cookie: cookie } }, env());
    expect(res.status).toBe(200);
    const { user } = await res.json();
    // The mapping that migration 0075 depends on: without it every account
    // it moved to `verified` reads as pending with nothing to act on.
    expect(user.status).toBe("active");
    expect(user.email_verified).toBe(true);
    // Active, but not yet allowed to upload -- two fields, two meanings.
    expect(user.service_access).toBe(false);
  });

  test("reports a `pending` account as pending with an unverified email", async () => {
    const id = seedWebUser(USER_EMAIL);
    const cookie = await sessionCookie(id);

    const { user } = await (
      await app.request("/auth/me", { headers: { Cookie: cookie } }, env())
    ).json();
    expect(user.status).toBe("pending");
    expect(user.email_verified).toBe(false);
  });
});
