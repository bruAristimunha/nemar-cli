/**
 * The two routes that took a password answer 410 and do nothing (ADR 0097).
 *
 * Driven through `worker.fetch`, the production entry point, and not through a
 * local Hono app. A local app with `authRoutes` alone cannot see a route added
 * to another router, a different mount prefix, or the worker's own 404 handler,
 * which is what an older CLI would otherwise meet. `ENVIRONMENT: "development"`
 * is the documented rate-limit bypass, the same concession the other tests that
 * drive this entry point make.
 *
 * Real engine, no mocks: bun:sqlite behind realD1 with every migration applied.
 * The point of the 410 is that an installed CLI which still has `retrieve-key`
 * or the old signup form prints the sentence in `error`, so the body is compared
 * against the exported constant and also against the words the person must see.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { PASSWORD_SIGN_IN_RETIRED_BODY } from "../src/routes/auth";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let db: Database;

function workerEnv(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "development" } as unknown as Bindings;
}

function post(path: string, body: string, contentType = "application/json"): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.nemar.org${path}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }),
    workerEnv(),
    ctx,
  );
}

const count = (table: string): number =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;

/** A verified account that holds no key: the shape `retrieve-key` used to serve. */
function seedKeylessVerifiedUser(): void {
  db.run(
    `INSERT INTO users (username, email, github_username, status, role, signup_source, email_verified)
     VALUES ('keyless', 'keyless@example.org', 'keyless-gh', 'verified', 'member', 'cli', 1)`,
  );
}

beforeEach(() => {
  db = freshDb();
});

describe("POST /auth/retrieve-key", () => {
  test("answers 410 with the sentence an old CLI prints, and mints no key", async () => {
    seedKeylessVerifiedUser();
    const tokens = count("tokens");

    const res = await post(
      "/auth/retrieve-key",
      JSON.stringify({ email: "keyless@example.org", password: "correct horse battery staple" }),
    );

    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; code: string };
    expect(body).toEqual({ ...PASSWORD_SIGN_IN_RETIRED_BODY });
    // The words the person has to read: what happened and what to run.
    expect(body.error).toContain("Password sign-in was removed");
    expect(body.error).toContain("nemar auth login");
    expect(count("tokens")).toBe(tokens);
  });

  test("does not parse the body, so a malformed one gets the same answer", async () => {
    const res = await post("/auth/retrieve-key", "not json at all", "text/plain");
    expect(res.status).toBe(410);
  });

  test("the same answer on the /nemar mount", async () => {
    const res = await post("/nemar/auth/retrieve-key", "{}");
    expect(res.status).toBe(410);
  });
});

describe("POST /auth/signup", () => {
  test("answers 410 and creates no account", async () => {
    const users = count("users");

    const res = await post(
      "/auth/signup",
      JSON.stringify({
        username: "signupgone",
        email: "signupgone@example.org",
        password: "correct horse battery staple",
        github_username: "signupgone-gh",
        description: "A request that used to be a registration",
        orcid: "0000-0002-1825-0097",
        city: "San Diego",
        country: "USA",
      }),
    );

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ ...PASSWORD_SIGN_IN_RETIRED_BODY });
    expect(count("users")).toBe(users);
  });

  test("only POST is retired: a GET stays an ordinary unrouted 404", async () => {
    const res = await worker.fetch(
      new Request("https://api.nemar.org/auth/signup", { method: "GET" }),
      workerEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("the harness reaches the routes that stay", () => {
  // A positive control. Without it, "410 from both routes" would also pass if
  // every /auth path were answering 410 for some other reason.
  test("POST /auth/resend-verification still answers, for an address with no account", async () => {
    const res = await post(
      "/auth/resend-verification",
      JSON.stringify({ email: "nobody@example.org" }),
    );
    expect(res.status).toBe(200);
  });

  test("POST /auth/login still rejects an unknown API key with 401", async () => {
    const res = await post(
      "/auth/login",
      JSON.stringify({ api_key: "nemar_not_a_real_key_0000000000000000" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("regenerate-key is now the only way to replace a lost key", () => {
  test("the emailed link mints a key and the page tells the person how to use it", async () => {
    // A bare `nemar auth login` starts the browser flow and ignores a pasted
    // key, so the page must name the form that takes one: `-k`.
    seedKeylessVerifiedUser();
    db.run(
      "UPDATE users SET verification_token = ?, verification_expires_at = ? WHERE username = ?",
      ["regen-page-token", new Date(Date.now() + 60 * 60 * 1000).toISOString(), "keyless"],
    );

    const res = await worker.fetch(
      new Request("https://api.nemar.org/auth/confirm-key-regeneration?token=regen-page-token"),
      workerEnv(),
      ctx,
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("nemar auth login -k &lt;your-new-key&gt;");
    expect(html).not.toContain("retrieve-key");
    expect(count("tokens")).toBe(1);
  });
});
