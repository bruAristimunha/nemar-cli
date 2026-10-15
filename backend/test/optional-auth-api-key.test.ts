/**
 * `optionalAuthMiddleware`'s bearer path reads keys through the one API-key
 * lookup, `resolveApiKeyUser`, so it refuses exactly what the API refuses.
 *
 * It used to carry its own copy of that SELECT without the `expires_at`
 * predicate, so an EXPIRED key still identified its account on every route
 * behind this middleware (the catalog list with `?mine=true`, the notices
 * feed). Real engine throughout: bun:sqlite behind `realD1` with every
 * migration applied, a real Hono app with the real middleware, real key
 * hashing. No mocks.
 *
 * AND IT STAYS A PURE READ. The old copy never wrote, and the shared lookup
 * touches `tokens.last_used_at` by default, so this middleware asks it not to:
 * an awaited write would turn a failed UPDATE into a 500 on routes that have
 * an anonymous answer, and `/notices` is served even in `full` maintenance
 * mode. The write is made impossible with a trigger rather than assumed
 * absent.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import worker from "../src/index";
import { authMiddleware, optionalAuthMiddleware } from "../src/middleware/auth";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const KEY = "nm_optional-auth-key-0123456789abcdef0123456";

let db: Database;
let userId: number;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.use("*", optionalAuthMiddleware);
app.get("/probe", (c) =>
  c.json({ user: c.var.user?.username ?? null, attempted: c.var.authAttempted === true }),
);

async function probe(authorization?: string) {
  const res = await app.request(
    "/probe",
    authorization ? { headers: { Authorization: authorization } } : {},
    env(),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { user: string | null; attempted: boolean };
}

function lastUsed(): string | null {
  return (
    db
      .query<{ last_used_at: string | null }, [number]>(
        "SELECT last_used_at FROM tokens WHERE user_id = ?",
      )
      .get(userId)?.last_used_at ?? null
  );
}

/** Make every write to `tokens.last_used_at` abort, so a write cannot hide. */
function forbidTouch(): void {
  db.run(
    `CREATE TRIGGER forbid_last_used_touch BEFORE UPDATE OF last_used_at ON tokens
     BEGIN SELECT RAISE(ABORT, 'last_used_at is read-only in this test'); END`,
  );
}

async function seedKey(expiresSql = "NULL"): Promise<void> {
  db.run(
    `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, expires_at)
     VALUES (?, ?, ?, ${expiresSql})`,
    [userId, await hashApiKey(KEY), KEY.slice(0, 8)],
  );
}

beforeEach(() => {
  db = freshDb();
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified)
     VALUES ('optional', 'optional@nemar.test', 'x', 'verified', 'member', 'web', 1)`,
  );
  userId =
    db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'optional'").get()?.id ?? 0;
});

describe("optionalAuthMiddleware with an API key", () => {
  test("a live key identifies its account, and last_used_at is left alone", async () => {
    await seedKey();
    db.run("UPDATE tokens SET last_used_at = '2020-01-01 00:00:00' WHERE user_id = ?", [userId]);
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: "optional", attempted: true });
    expect(lastUsed()).toBe("2020-01-01 00:00:00");
  });

  test("with every write to last_used_at made to fail, it still answers 200", async () => {
    await seedKey();
    forbidTouch();
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: "optional", attempted: true });
  });

  test("a real optional-auth route (/notices) answers 200 through the worker with writes forbidden", async () => {
    await seedKey();
    forbidTouch();
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        p.catch(() => {});
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    for (const path of ["/notices", "/datasets"]) {
      const res = await worker.fetch(
        new Request(`https://api.nemar.org${path}`, {
          headers: { Authorization: `Bearer ${KEY}` },
        }),
        { ...env(), ENVIRONMENT: "development" } as Bindings,
        ctx,
      );
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  test("the strict bearer path still touches last_used_at, as it always has", async () => {
    // The guard on the other side: `touch: false` is the optional path's, and
    // `authMiddleware` keeps the awaited write.
    await seedKey();
    db.run("UPDATE tokens SET last_used_at = '2020-01-01 00:00:00' WHERE user_id = ?", [userId]);
    const strict = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    strict.use("*", authMiddleware);
    strict.get("/probe", (c) => c.json({ user: c.var.user.username }));
    const res = await strict.request(
      "/probe",
      { headers: { Authorization: `Bearer ${KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    expect(lastUsed()).not.toBe("2020-01-01 00:00:00");
  });

  test("an EXPIRED key is ignored, and the attempt is still flagged", async () => {
    await seedKey("datetime('now', '-1 second')");
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: null, attempted: true });
  });

  test("a key whose expiry is still ahead identifies its account", async () => {
    await seedKey("datetime('now', '+1 day')");
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: "optional", attempted: true });
  });

  test("a revoked key is ignored", async () => {
    await seedKey();
    db.run("UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: null, attempted: true });
  });

  test("a key on an inactive account is ignored", async () => {
    await seedKey();
    db.run("UPDATE users SET status = 'pending', email_verified = 0 WHERE id = ?", [userId]);
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: null, attempted: true });
  });

  test("a malformed key is ignored, and flagged as an attempt", async () => {
    expect(await probe("Bearer short")).toEqual({ user: null, attempted: true });
  });

  test("no header is anonymous and no attempt", async () => {
    expect(await probe()).toEqual({ user: null, attempted: false });
  });
});
