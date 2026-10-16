/**
 * Who is exempt from the dataset pull-request review (ADR 0107).
 *
 * `isReviewExempt` is asked about a GitHub login. The accounts answer first, so the tests seed real
 * accounts into the real schema (bun:sqlite behind realD1, every migration applied) and ask; GitHub
 * answers second, as a `Bun.serve()` stand-in for api.github.com. The callers that act on the
 * answer (the webhook, the allowance check, the admin queue) are exercised through their own entry
 * points in `pr-review-flow.test.ts` and `pr-review-queue.test.ts`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { ACCOUNT_KIND_VALUES } from "../../shared/contract/user";
import {
  type AdminAnswers,
  REVIEW_EXEMPT_KINDS,
  REVIEW_EXEMPT_ROLES,
  REVIEW_EXEMPT_SQL,
  __setPermissionTimeoutForTests,
  isReviewExempt,
} from "../src/services/pr-review-exemption";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";
import { type PermissionAnswer, permissionResponse } from "./helpers/github-permission";

const REPO = "nm000460";
const TOKEN = "ghp_exemption_test_token";

interface Asked {
  path: string;
  auth: string | null;
}

let server: Server;
let asked: Asked[] = [];
/** What GitHub says each login holds on a repository (see helpers/github-permission.ts). */
let permissions: Record<string, PermissionAnswer> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      asked.push({ path: url.pathname, auth: req.headers.get("authorization") });
      return (await permissionResponse(url, permissions)) ?? new Response("{}", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

let db: Database;
let envOverrides: Partial<Bindings> = {};

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  asked = [];
  permissions = {};
  envOverrides = {};
  __setPermissionTimeoutForTests(null);
});

function env(): Bindings {
  return { DB: realD1(db), GITHUB_ADMIN_PAT: TOKEN, ...envOverrides } as Bindings;
}

let nextId = 100;

/** A real account row. Everything not named is what a signed-up, approved person has. */
function seedAccount(o: {
  github: string | null;
  role?: string;
  status?: string;
  kind?: string;
  deleted?: boolean;
}): number {
  const id = nextId++;
  const status = o.status ?? "approved";
  db.run(
    `INSERT INTO users (id, username, email, status, role, email_verified, github_username,
                        account_kind, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${o.deleted ? "datetime('now')" : "NULL"})`,
    [
      id,
      `account-${id}`,
      `account-${id}@example.org`,
      status,
      o.role ?? "member",
      status === "pending" ? 0 : 1,
      o.github,
      o.kind ?? "person",
    ],
  );
  return id;
}

const exempt = (login: string) => isReviewExempt(env(), { login, repo: REPO });

describe("who is exempt from the review", () => {
  test("an approved owner's login is exempt", async () => {
    seedAccount({ github: "owner-gh", role: "owner" });
    expect(await exempt("owner-gh")).toBe(true);
  });

  test("an approved admin's login is exempt, matched without regard to case", async () => {
    seedAccount({ github: "Admin-GH", role: "admin" });
    for (const asked of ["Admin-GH", "admin-gh", "ADMIN-GH", "aDmIn-Gh"]) {
      expect(await exempt(asked), asked).toBe(true);
    }
  });

  test("an approved member's login is not exempt", async () => {
    // The control: the same account in every respect but the role.
    seedAccount({ github: "member-gh", role: "member" });
    expect(await exempt("member-gh")).toBe(false);
  });

  test("an operational service account that holds the role is exempt", async () => {
    seedAccount({ github: "service-gh", role: "admin", kind: "service" });
    expect(await exempt("service-gh")).toBe(true);
  });

  test("a test-kind admin or owner is not exempt", async () => {
    seedAccount({ github: "persona-admin-gh", role: "admin", kind: "test" });
    seedAccount({ github: "persona-owner-gh", role: "owner", kind: "test" });
    expect(await exempt("persona-admin-gh")).toBe(false);
    expect(await exempt("persona-owner-gh")).toBe(false);
  });

  test("a revoked, pending, merely verified or deleted admin is not exempt", async () => {
    seedAccount({ github: "revoked-gh", role: "admin", status: "revoked" });
    seedAccount({ github: "pending-gh", role: "admin", status: "pending" });
    seedAccount({ github: "verified-gh", role: "admin", status: "verified" });
    seedAccount({ github: "deleted-gh", role: "admin", deleted: true });
    for (const login of ["revoked-gh", "pending-gh", "verified-gh", "deleted-gh"]) {
      expect(await exempt(login), login).toBe(false);
    }
  });

  test("an unknown login is not exempt", async () => {
    seedAccount({ github: "owner-gh", role: "owner" });
    expect(await exempt("someone-else")).toBe(false);
    // Nor is a longer or shorter name that merely contains an exempt one.
    expect(await exempt("owner-gh-2")).toBe(false);
    expect(await exempt("owner-g")).toBe(false);
  });

  test("a NEMAR username is not a GitHub login", async () => {
    // An owner whose account names no GitHub login cannot be matched, and a username that happens
    // to be someone's GitHub login does not make that person exempt.
    db.run(
      `INSERT INTO users (id, username, email, status, role, email_verified, github_username)
       VALUES (7, 'ghost-gh', 'ghost@example.org', 'approved', 'owner', 1, NULL)`,
    );
    expect(await exempt("ghost-gh")).toBe(false);
  });

  test("a login that is not shaped like one is never exempt, and is not looked up", async () => {
    // A stored empty handle would match an empty login if the shape were not checked first.
    seedAccount({ github: "", role: "owner" });
    for (const login of ["", " ", "a b", "x[bot]", "-lead", "a".repeat(40), "owner\u0000"]) {
      expect(await exempt(login), JSON.stringify(login)).toBe(false);
    }
    // Not looked up: neither the accounts' answer nor GitHub's was needed, and GitHub was not asked
    // (the stored empty handle above would otherwise have reached `collaborators//permission`).
    expect(asked).toEqual([]);
  });

  test("a database failure on the accounts' read throws, and GitHub is not asked", async () => {
    seedAccount({ github: "owner-gh", role: "owner" });
    const failing = wrapD1(realD1(db), (sql) => {
      if (sql === REVIEW_EXEMPT_SQL) throw new Error("D1 unavailable");
    });
    await expect(
      isReviewExempt({ ...env(), DB: failing } as Bindings, { login: "owner-gh", repo: REPO }),
    ).rejects.toThrow("D1 unavailable");
    expect(asked).toEqual([]);
  });

  test("every combination of role, kind, status and deletion, against the written rule", async () => {
    // The rule is written out here by hand, not read from the constants the query is built from,
    // so editing one condition of the query (or one list) fails a row of this table.
    const roles = ["owner", "admin", "member"];
    const statuses = ["pending", "verified", "approved", "revoked"];
    const cases: { login: string; expected: boolean }[] = [];
    for (const role of roles) {
      for (const kind of ACCOUNT_KIND_VALUES) {
        for (const status of statuses) {
          for (const deleted of [false, true]) {
            const login = `acct-${role}-${kind}-${status}-${deleted ? "gone" : "live"}`;
            seedAccount({ github: login, role, kind, status, deleted });
            cases.push({
              login,
              expected:
                (role === "owner" || role === "admin") &&
                (kind === "person" || kind === "service") &&
                status === "approved" &&
                !deleted,
            });
          }
        }
      }
    }
    expect(cases.filter((c) => c.expected)).toHaveLength(4);
    for (const c of cases) expect(await exempt(c.login), c.login).toBe(c.expected);
  });
});

describe("GitHub has to agree", () => {
  const admin = () => seedAccount({ github: "Admin-GH", role: "admin" });

  test("an account that matched is exempt when GitHub reports admin, and the question is about this repository and this login", async () => {
    admin();
    expect(await exempt("Admin-GH")).toBe(true);
    expect(asked).toEqual([
      {
        path: `/repos/nemarDatasets/${REPO}/collaborators/Admin-GH/permission`,
        auth: `Bearer ${TOKEN}`,
      },
    ]);
  });

  test("an account that matched but holds a lesser role on the repository is not exempt", async () => {
    admin();
    for (const held of ["maintain", "write", "triage", "read", "none"] as const) {
      permissions = { "admin-gh": held };
      expect(await exempt("Admin-GH"), held).toBe(false);
    }
  });

  test("the answer is about one repository: admin elsewhere is not admin here", async () => {
    admin();
    permissions = { [`${REPO}#admin-gh`]: "write", "nm000461#admin-gh": "admin" };
    expect(await isReviewExempt(env(), { login: "Admin-GH", repo: REPO })).toBe(false);
    expect(await isReviewExempt(env(), { login: "Admin-GH", repo: "nm000461" })).toBe(true);
  });

  test("every way GitHub can fail to say is not exempt", async () => {
    admin();
    const failures: [string, PermissionAnswer][] = [
      ["a login GitHub does not have", 404],
      ["a refusal", 403],
      ["a throttle", 429],
      ["a server error", 500],
      ["a gateway error", 502],
      ["a body that is not JSON", "garbage"],
      ["a body with no role_name", "no_role_name"],
    ];
    for (const [why, answer] of failures) {
      permissions = { "admin-gh": answer };
      expect(await exempt("Admin-GH"), why).toBe(false);
    }
  });

  test("a login GitHub does not know is a warning, and every other failure is an error, with no token or login in any line", async () => {
    admin();
    const lines: { level: "warn" | "error"; text: string }[] = [];
    const originals = { warn: console.warn, error: console.error };
    const grab =
      (level: "warn" | "error") =>
      (...args: unknown[]) => {
        lines.push({ level, text: args.map(String).join(" ") });
      };
    console.warn = grab("warn");
    console.error = grab("error");
    const levels: [string, PermissionAnswer, "warn" | "error"][] = [
      ["a login GitHub does not have", 404, "warn"],
      ["a refusal", 403, "error"],
      ["a bad credential", 401, "error"],
      ["a server error", 500, "error"],
      ["a body that is not JSON", "garbage", "error"],
      ["a body with no role_name", "no_role_name", "error"],
    ];
    const seen: ("warn" | "error")[] = [];
    try {
      for (const [, answer] of levels) {
        permissions = { "admin-gh": answer };
        const before = lines.filter((l) => l.text.startsWith("[pr-review-exempt]")).length;
        await exempt("Admin-GH");
        const ours = lines.filter((l) => l.text.startsWith("[pr-review-exempt]"));
        // Exactly one of our lines per failure (the transport's retry notices are not ours).
        expect(ours.length - before).toBe(1);
        seen.push(ours.at(-1)?.level ?? "warn");
      }
    } finally {
      Object.assign(console, originals);
    }
    expect(seen).toEqual(levels.map(([, , level]) => level));
    for (const l of lines.filter((x) => x.text.startsWith("[pr-review-exempt]"))) {
      expect(l.text).not.toContain(TOKEN);
      expect(l.text.toLowerCase()).not.toContain("admin-gh");
    }
  });

  test("one delivery asks GitHub once per login and repository, however many questions it asks", async () => {
    admin();
    const answers: AdminAnswers = new Map();
    const who = { login: "Admin-GH", repo: REPO };
    expect(await isReviewExempt(env(), who, answers)).toBe(true);
    expect(await isReviewExempt(env(), who, answers)).toBe(true);
    // Case does not make it a second question, and another repository is one.
    expect(await isReviewExempt(env(), { ...who, login: "admin-gh" }, answers)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(await isReviewExempt(env(), { ...who, repo: "nm000461" }, answers)).toBe(true);
    expect(asked).toHaveLength(2);
    // Without the memory every question is asked.
    expect(await isReviewExempt(env(), who)).toBe(true);
    expect(asked).toHaveLength(3);
  });

  test("only GitHub's half is remembered: the accounts are read again, so a demotion is seen", async () => {
    admin();
    const answers: AdminAnswers = new Map();
    const who = { login: "Admin-GH", repo: REPO };
    expect(await isReviewExempt(env(), who, answers)).toBe(true);
    db.run("UPDATE users SET role = 'member' WHERE github_username = 'Admin-GH'");
    expect(await isReviewExempt(env(), who, answers)).toBe(false);
    expect(asked).toHaveLength(1);
  });

  test("a GitHub that does not answer in time is not exempt", async () => {
    admin();
    __setPermissionTimeoutForTests(100);
    permissions = { "admin-gh": { delayMs: 6000 } };
    const started = Date.now();
    expect(await exempt("Admin-GH")).toBe(false);
    // It gave up at the timeout (and one retry's pause), not when GitHub finally answered.
    expect(Date.now() - started).toBeLessThan(3500);
  });

  test("no GitHub credential is not exempt, and nothing is asked", async () => {
    admin();
    envOverrides = { GITHUB_ADMIN_PAT: undefined };
    expect(await exempt("Admin-GH")).toBe(false);
    expect(asked).toEqual([]);
  });

  test("GitHub is asked only after an account has matched", async () => {
    seedAccount({ github: "member-gh", role: "member" });
    seedAccount({ github: "persona-gh", role: "admin", kind: "test" });
    seedAccount({ github: "revoked-gh", role: "admin", status: "revoked" });
    seedAccount({ github: "deleted-gh", role: "admin", deleted: true });
    for (const login of [
      "member-gh",
      "persona-gh",
      "revoked-gh",
      "deleted-gh",
      "stranger-gh",
      "x[bot]",
    ]) {
      expect(await exempt(login), login).toBe(false);
    }
    expect(asked).toEqual([]);
  });
});

describe("the rule is written once", () => {
  test("the exempt roles are owner and admin, and the exempt kinds are person and service", () => {
    expect([...REVIEW_EXEMPT_ROLES]).toEqual(["owner", "admin"]);
    expect([...REVIEW_EXEMPT_KINDS]).toEqual(["person", "service"]);
    // `test` is a real kind that is deliberately left out.
    expect(ACCOUNT_KIND_VALUES).toContain("test");
    expect([...REVIEW_EXEMPT_KINDS] as string[]).not.toContain("test");
  });

  test("the query is built from those lists, and nothing else decides", () => {
    for (const word of [...REVIEW_EXEMPT_ROLES, ...REVIEW_EXEMPT_KINDS]) {
      expect(REVIEW_EXEMPT_SQL).toContain(`'${word}'`);
    }
    expect(REVIEW_EXEMPT_SQL).not.toContain("'member'");
    expect(REVIEW_EXEMPT_SQL).not.toContain("'test'");
  });

  test("the lookup is a search of the case-insensitive GitHub index, not a scan", () => {
    const plan = db.query(`EXPLAIN QUERY PLAN ${REVIEW_EXEMPT_SQL}`).all("anyone") as {
      detail: string;
    }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("USING INDEX idx_users_github");
    expect(plan.map((p) => p.detail).join("\n")).not.toMatch(/\bSCAN\b/);
  });

  test("no login is written into the review's code", () => {
    // Who is exempt is data in `users`. A login in the review's source would exempt that name in
    // every environment, including a dev worker that shares production's users.
    const dir = join(import.meta.dir, "../src/services");
    const files = readdirSync(dir).filter((f) => /^pr-review.*\.ts$/.test(f));
    expect(files).toContain("pr-review-exemption.ts");
    expect(files.length).toBeGreaterThanOrEqual(4);
    const offending = files.filter((f) =>
      /nemarAdmin|nemarOwner|test-admin|test-owner/i.test(readFileSync(join(dir, f), "utf8")),
    );
    expect(offending).toEqual([]);
  });
});
