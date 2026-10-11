/**
 * GET /auth/orcid-name (#1255, epic #1250).
 *
 * Reads the given and family name on a public ORCID record. It was written for
 * the CLI's old signup form, which asked for a name only when the record hid
 * one. The form went with the password routes (ADR 0097) but the route stays,
 * and these six cases lived in `signup-real-name.test.ts`, which was deleted
 * with `POST /auth/signup`, so they are kept here.
 *
 * The three outcomes are reported separately because the caller's wording
 * differs: an ORCID outage must never be reported as "your record hides your
 * name".
 *
 * Real engine end to end: the real Hono route and real zod validation. ORCID's
 * public record API is a local `Bun.serve()` reached through the
 * ORCID_PUB_API_BASE binding (the same override an ORCID mirror would use), so
 * the production fetch and parse path in `fetchOrcidName` runs. No mocks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authRoutes } from "../src/routes/auth";
import type { Bindings, Variables } from "../src/types/bindings";

const ORCID = "0000-0002-1825-0097";

/** What the local ORCID server returns for the next personal-details read. */
let orcidRecord: { status: number; body: unknown };
/** How many times the local ORCID server was asked, to prove a 400 never calls it. */
let orcidCalls = 0;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

const NAMED_RECORD = {
  status: 200,
  body: { name: { "given-names": { value: "Ada" }, "family-name": { value: "Lovelace" } } },
};
/** ORCID's shape for a record whose owner made their name private. */
const PRIVATE_RECORD = { status: 200, body: { name: null } };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/personal-details")) {
        orcidCalls += 1;
        return new Response(JSON.stringify(orcidRecord.body), {
          status: orcidRecord.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  orcidRecord = NAMED_RECORD;
  orcidCalls = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authRoutes);
});

function env(): Bindings {
  return { ENVIRONMENT: "test", ORCID_PUB_API_BASE: base } as unknown as Bindings;
}

function lookup(query: string): Promise<Response> {
  return app.request(`/auth/orcid-name${query}`, {}, env());
}

describe("GET /auth/orcid-name", () => {
  test("status 'found' with the record's name", async () => {
    const res = await lookup(`?orcid=${ORCID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "found",
      given_name: "Ada",
      family_name: "Lovelace",
    });
  });

  test("status 'no_public_name' when the record hides its name", async () => {
    orcidRecord = PRIVATE_RECORD;
    const res = await lookup(`?orcid=${ORCID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "no_public_name",
      given_name: null,
      family_name: null,
    });
  });

  test("status 'lookup_failed' (not an error, and NOT no_public_name) when ORCID is down", async () => {
    // The distinction the caller's wording depends on: an outage must not be
    // reported to the user as "your record hides your name".
    orcidRecord = { status: 500, body: {} };
    const res = await lookup(`?orcid=${ORCID}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("lookup_failed");
  });

  test("400 on a malformed iD, without calling ORCID", async () => {
    const res = await lookup("?orcid=not-an-orcid");
    expect(res.status).toBe(400);
    expect(orcidCalls).toBe(0);
  });

  test("400 when the iD is missing", async () => {
    const res = await lookup("");
    expect(res.status).toBe(400);
    expect(orcidCalls).toBe(0);
  });

  test("status 'no_public_name' when only one name part is published", async () => {
    // Half a name is not citable, so it is not a name the caller can accept,
    // but the half that IS public is still reported.
    orcidRecord = {
      status: 200,
      body: { name: { "given-names": { value: "Ada" }, "family-name": null } },
    };
    const res = await lookup(`?orcid=${ORCID}`);
    expect(await res.json()).toEqual({
      status: "no_public_name",
      given_name: "Ada",
      family_name: null,
    });
  });
});
