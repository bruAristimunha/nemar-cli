/**
 * The admin and owner bypass (#1709, ADR 0098).
 *
 * A token whose account is an admin or an owner is not counted. The answer still
 * says what the limiter did and for whom: `X-RateLimit-Bucket: admin-bypass` and
 * `X-RateLimit-Caller`. The decision is the database's; the cache only remembers
 * it, so a cache that cannot take the write must not turn a confirmed admin into a
 * stranger.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { __limits, rateLimiter } from "../src/middleware/rateLimit";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";
import {
  type AppEnv,
  PROD_ENV,
  buildApp,
  edge,
  hit,
  useRateLimitHarness,
  viaBinding,
} from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const ADMIN_KEY = `admin-${"k".repeat(42)}`;
const MEMBER_KEY = `member-${"m".repeat(41)}`;
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
const lookups = () =>
  h.warn.mock.calls.filter((c) => String(c[0]).includes("admin-flag lookup failed"));

describe("a cached admin flag", () => {
  test("is not counted, and the answer says for whom it was not counted", async () => {
    await h.seedAdminFlag(await hashApiKey(ADMIN_KEY), { admin: true });
    const app = buildApp();
    const callers: Array<[string, Record<string, string>]> = [
      ["edge", edge("203.0.113.1")],
      ["site", viaBinding("203.0.113.2")],
      ["unattributed", {}],
    ];
    for (const [source, headers] of callers) {
      const res = await hit(app, { ...headers, ...bearer(ADMIN_KEY) }, "/admin/users");
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("admin-bypass");
      expect(res.headers.get("X-RateLimit-Caller")).toBe(source);
      expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    }
    // Nothing was counted for the token.
    expect(await h.stored(`token:${await hashApiKey(ADMIN_KEY)}`)).toBeUndefined();
  });

  test("keeps its headers when the handler builds its own Response", async () => {
    await h.seedAdminFlag(await hashApiKey(ADMIN_KEY), { admin: true });
    for (const headers of [edge("203.0.113.3"), viaBinding("203.0.113.4")]) {
      const res = await hit(buildApp(), { ...headers, ...bearer(ADMIN_KEY) }, "/raw");
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("admin-bypass");
      expect(res.headers.get("X-RateLimit-Caller")).not.toBeNull();
    }
  });

  test("is never refused, however many requests it makes", async () => {
    await h.seedAdminFlag(await hashApiKey(ADMIN_KEY), { admin: true });
    const app = buildApp();
    for (let i = 0; i < __limits.TOKEN_MAX_REQUESTS_AUTHED + 20; i++) {
      expect(
        (await hit(app, { ...viaBinding("203.0.113.5"), ...bearer(ADMIN_KEY) }, "/admin/users"))
          .status,
      ).toBe(200);
    }
  });

  test("that says not an admin is counted in the token bucket", async () => {
    await h.seedAdminFlag(await hashApiKey(MEMBER_KEY), { admin: false });
    const res = await hit(
      buildApp(),
      { ...viaBinding("203.0.113.6"), ...bearer(MEMBER_KEY) },
      "/admin/users",
    );
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("token");
    expect(res.headers.get("X-RateLimit-Caller")).toBe("site");
  });
});

describe("a token the database says is an admin", () => {
  let db: Database;
  let env: Bindings;

  beforeEach(async () => {
    db = freshDb();
    env = { ...PROD_ENV, DB: realD1(db) } as Bindings;
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
       VALUES ('rl-admin', 'rl-admin@example.org', 'x', 'approved', 'admin', 1, 1, 1)`,
    );
    const user = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='rl-admin'")
      .get();
    if (!user) throw new Error("seed failed");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      user.id,
      await hashApiKey(ADMIN_KEY),
      ADMIN_KEY.slice(0, 8),
    );
  });

  const ask = () =>
    hit(buildApp(), { ...edge("203.0.113.10"), ...bearer(ADMIN_KEY) }, "/admin/users", env);

  test("is bypassed and remembered", async () => {
    const res = await ask();
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("admin-bypass");
    expect(await h.storedAdminFlag(await hashApiKey(ADMIN_KEY))).toEqual({ admin: true });
  });

  test("stays an admin when only the cache write fails", async () => {
    class PutFails extends InMemoryCache {
      async put(): Promise<void> {
        throw new Error("the put failed");
      }
    }
    (globalThis as { caches?: unknown }).caches = { default: new PutFails() };
    const res = await ask();
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("admin-bypass");
    expect(lookups().length).toBe(1);
    expect(lookups()[0]?.[1]).toMatchObject({ phase: "put", error: "Error" });
  });

  test("stays an admin when the cache write stalls", async () => {
    class PutStalls extends InMemoryCache {
      put(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }
    (globalThis as { caches?: unknown }).caches = { default: new PutStalls() };
    const res = await ask();
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("admin-bypass");
    expect(lookups()[0]?.[1]).toMatchObject({ phase: "put", error: "CacheStallError" });
  });

  test("is read again from the database when the cached flag is damaged, and the record replaced", async () => {
    const hash = await hashApiKey(ADMIN_KEY);
    for (const damaged of ["this is not json", { admin: "yes" }, { other: true }]) {
      await h.seedAdminFlag(hash, damaged);
      const res = await ask();
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("admin-bypass");
      expect(await h.storedAdminFlag(hash)).toEqual({ admin: true });
    }
  });

  test("a database that fails fails closed: not an admin, and says so once", async () => {
    const broken = { ...env, DB: undefined } as unknown as Bindings;
    const app = buildApp();
    for (let i = 0; i < 5; i++) {
      const res = await hit(
        app,
        { ...edge("203.0.113.11"), ...bearer(ADMIN_KEY) },
        "/admin/users",
        broken,
      );
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("token");
    }
    expect(lookups().length).toBe(1);
    expect(lookups()[0]?.[1]).toMatchObject({ phase: "lookup", error: "TypeError" });
  });
});

describe("a cached admin flag that cannot be read", () => {
  test("a body that never finishes is given up on after the bound", async () => {
    class HangingBody extends InMemoryCache {
      async match(request: RequestInfo | URL): Promise<Response | undefined> {
        if (!(request as Request).url.includes("admin-flag")) return super.match(request);
        return new Response(new ReadableStream<Uint8Array>({ start() {} }));
      }
    }
    (globalThis as { caches?: unknown }).caches = { default: new HangingBody() };
    const started = performance.now();
    const res = await hit(
      buildApp(),
      { ...edge("203.0.113.13"), ...bearer(ADMIN_KEY) },
      "/admin/users",
    );
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("token");
    expect(performance.now() - started).toBeLessThan(4000);
    expect(lookups()[0]?.[1]).toMatchObject({ phase: "read", error: "CacheStallError" });
  });

  test("is a cache fault: not an admin, counted as a token, and logged by phase", async () => {
    class BrokenBody extends InMemoryCache {
      async match(request: RequestInfo | URL): Promise<Response | undefined> {
        if (!(request as Request).url.includes("admin-flag")) return super.match(request);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("network connection lost"));
            },
          }),
        );
      }
    }
    (globalThis as { caches?: unknown }).caches = { default: new BrokenBody() };
    const app = new Hono<AppEnv>();
    app.use("*", rateLimiter);
    app.get("/admin/users", (c) => c.json({ ok: true }));
    const res = await hit(app, { ...edge("203.0.113.12"), ...bearer(ADMIN_KEY) }, "/admin/users");
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("token");
    expect(lookups()[0]?.[1]).toMatchObject({ phase: "read", error: "Error" });
  });
});
