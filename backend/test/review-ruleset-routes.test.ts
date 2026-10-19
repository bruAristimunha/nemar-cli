/**
 * The admin routes that put the "NEMAR PR review required" ruleset on dataset repositories, and
 * take it off (ADR 0107): POST /admin/datasets/:id/review-ruleset and
 * POST /admin/datasets/review-ruleset/bulk.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration applied, the real admin
 * router with its real auth (a seeded admin and a seeded owner, each with a hashed token), and a
 * stateful `Bun.serve()` stand-in for api.github.com (helpers/github-rulesets.ts) that holds each
 * repository's rulesets. What is asserted is what a repository holds afterwards, and what the audit
 * log says, not what a function was called with.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import {
  BRANCH_RULESET_NAME,
  REVIEW_RULESET_NAME,
  buildReviewRulesetPayload,
  deriveContexts,
  ensureBranchRuleset,
  ensureReviewRuleset,
} from "../src/services/github";
import { REMOVAL_IS_NEVER_REFUSED } from "../src/services/pr-review-eligibility";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  REVIEW_APP_BINDINGS,
  type RulesetStandIn,
  dropStandInAppToken,
  seedStandInAppToken,
  startRulesetStandIn,
} from "./helpers/github-rulesets";

const ADMIN_KEY = "review-ruleset-admin-key-0123456789abcdef0123456789abcdef";
const OWNER_KEY = "review-ruleset-owner-key-0123456789abcdef0123456789abcdef";
const PAT = "ghp_review_ruleset_routes";
// What the Worker finds when it signs in as the App. It differs from the PAT in `env()`, so a
// request the stand-in saw tells which of the two the Worker used.
const APP_TOKEN = "ghs_review_ruleset_routes_installation";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let standIn: RulesetStandIn;
let envOverrides: Partial<Bindings> = {};
let adminId = 0;

beforeAll(() => {
  standIn = startRulesetStandIn();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standIn.url;
  // The Worker signs in as the App (see REVIEW_APP_BINDINGS), and this is the token it finds.
  seedStandInAppToken(APP_TOKEN);
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  dropStandInAppToken();
  standIn.stop();
});

async function seedAccount(username: string, role: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (?, ?, 'x', ?, 'approved', ?, 'cli', 1, 0)`,
    [username, `${username}@example.org`, `${username}-gh`, role],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`seed failed for ${username}`);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  standIn.reset();
  envOverrides = {};
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedAccount("revadmin", "admin", ADMIN_KEY);
  await seedAccount("revowner", "owner", OWNER_KEY);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: PAT,
    // The App this Worker posts the review check as, which is the one the ruleset requires it
    // from, with the key and installation it signs in with.
    ...REVIEW_APP_BINDINGS,
    PR_REVIEW_ENABLED: "1",
    ...envOverrides,
  } as Bindings;
}

interface DatasetOpts {
  status?: string;
  visibility?: string;
  anonymous?: number;
  first_published_at?: string | null;
  github_repo?: string | null;
}

/** A published, public, named dataset unless said otherwise: the kind the Worker reviews. */
function seedDataset(id: string, o: DatasetOpts = {}): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo,
                           status, visibility, anonymous, first_published_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      adminId,
      o.github_repo === undefined ? `nemarDatasets/${id}` : o.github_repo,
      o.status ?? "active",
      o.visibility ?? "public",
      o.anonymous ?? 0,
      o.first_published_at === undefined ? "2026-01-01 00:00:00" : o.first_published_at,
    ],
  );
}

// biome-ignore lint/suspicious/noExplicitAny: a response body is read field by field
type Json = Record<string, any>;

async function post(
  path: string,
  body: unknown,
  key = ADMIN_KEY,
): Promise<{ status: number; body: Json }> {
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

const single = (id: string, body: unknown = {}, key = ADMIN_KEY) =>
  post(`/admin/datasets/${id}/review-ruleset`, body, key);
const bulk = (body: unknown = {}, key = OWNER_KEY) =>
  post("/admin/datasets/review-ruleset/bulk", body, key);

const held = (repo: string) => (standIn.rulesets.get(repo) ?? []).map((r) => r.name).sort();
const audits = () =>
  db
    .query<{ action: string; resource_id: string; details: string; user_id: number }, []>(
      "SELECT action, resource_id, details, user_id FROM audit_log WHERE action LIKE 'review_ruleset_%' ORDER BY id",
    )
    .all();

describe("POST /admin/datasets/:id/review-ruleset", () => {
  test("a bare request is a dry run: it reports the payload and writes nothing", async () => {
    seedDataset("nm000201");

    const r = await single("nm000201");

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dataset_id: "nm000201",
      dry_run: true,
      review_enabled: true,
      reviewable: true,
      not_reviewable_because: null,
      intent: "require",
      action: "create",
      applied: false,
    });
    expect(r.body.payload).toStrictEqual(buildReviewRulesetPayload());
    expect(r.body.payload.bypass_actors.map((a: Json) => a.actor_type)).toEqual([
      "Integration",
      "OrganizationAdmin",
      "RepositoryRole",
    ]);
    expect(standIn.writes()).toHaveLength(0);
    expect(held("nm000201")).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test("only an explicit dry_run:false writes, and the audit row names who did it", async () => {
    seedDataset("nm000201");

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dry_run: false,
      intent: "require",
      action: "create",
      applied: true,
    });
    expect(held("nm000201")).toEqual([REVIEW_RULESET_NAME]);
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "review_ruleset_applied",
      resource_id: "nm000201",
      user_id: adminId,
    });
    expect(JSON.parse(rows[0].details)).toEqual({ by: "revadmin", action: "create", bulk: false });
  });

  test("applying again updates the same ruleset in place", async () => {
    seedDataset("nm000201");
    await single("nm000201", { dry_run: false });

    const again = await single("nm000201", { dry_run: false });

    expect(again.body).toMatchObject({ action: "update", applied: true });
    expect(held("nm000201")).toEqual([REVIEW_RULESET_NAME]);
  });

  test("a dataset the Worker does not review calls for removal, and is never given the ruleset", async () => {
    const cases: Array<[string, DatasetOpts, string]> = [
      ["nm000211", { visibility: "private" }, "private"],
      ["nm000212", { status: "archived" }, "inactive"],
      ["nm000213", { first_published_at: null }, "unpublished"],
      ["nm000214", { anonymous: 1, first_published_at: null }, "anonymous"],
    ];
    for (const [id, opts, because] of cases) {
      seedDataset(id, opts);
      const r = await single(id, { dry_run: false });
      expect(r.status, id).toBe(200);
      expect(r.body, id).toMatchObject({
        reviewable: false,
        not_reviewable_because: because,
        intent: "remove",
        action: "none",
        applied: false,
      });
      expect(held(id), id).toEqual([]);
    }
    expect(standIn.writes()).toHaveLength(0);
  });

  test("a dataset that stopped being reviewed has the ruleset taken off, and the audit says removed", async () => {
    seedDataset("nm000201", { visibility: "private" });
    await ensureReviewRuleset("nm000201", PAT);
    standIn.calls.length = 0;

    const r = await single("nm000201", { dry_run: false });

    expect(r.body).toMatchObject({ intent: "remove", action: "remove", applied: true });
    expect(held("nm000201")).toEqual([]);
    expect(audits().map((a) => a.action)).toEqual(["review_ruleset_removed"]);
  });

  test("remove:true takes it off a reviewed dataset too, and leaves the branch ruleset", async () => {
    seedDataset("nm000201");
    await ensureBranchRuleset("nm000201", PAT, { checks: deriveContexts("nm000201") });
    await ensureReviewRuleset("nm000201", PAT);

    const r = await single("nm000201", { dry_run: false, remove: true });

    expect(r.body).toMatchObject({ reviewable: true, intent: "remove", action: "remove" });
    expect(held("nm000201")).toEqual([BRANCH_RULESET_NAME]);
  });

  test("a repository whose default branch is not main is skipped, not written", async () => {
    seedDataset("nm000201");
    standIn.defaultBranches.set("nm000201", "master");

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      intent: "require",
      action: "skip",
      applied: false,
      reason: "default_branch_not_main",
      default_branch: "master",
    });
    expect(standIn.writes()).toHaveLength(0);
    expect(audits()).toEqual([]);
  });

  describe("while the review is off", () => {
    test.each([undefined, "", "0", "true", "yes"])(
      "a live request to require it is refused with review_disabled before GitHub is asked (%j)",
      async (flag) => {
        seedDataset("nm000201");
        envOverrides = { PR_REVIEW_ENABLED: flag };

        const r = await single("nm000201", { dry_run: false });

        expect(r.status).toBe(409);
        expect(r.body.code).toBe("review_disabled");
        expect(r.body.error).toContain("PR_REVIEW_ENABLED");
        expect(standIn.calls).toHaveLength(0);
        expect(audits()).toEqual([]);
      },
    );

    test("what is refused is the requirement, not the request: a live request for a dataset that is not reviewed is a removal and goes through", async () => {
      // A private dataset is only ever taken off, so the review being off is no reason to refuse
      // it, and refusing it would leave a ruleset that nothing satisfies where it stands.
      seedDataset("nm000201", { visibility: "private" });
      await ensureReviewRuleset("nm000201", PAT);
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await single("nm000201", { dry_run: false });

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        intent: "remove",
        action: "remove",
        applied: true,
        review_enabled: false,
      });
      expect(held("nm000201")).toEqual([]);
      expect(audits().map((a) => a.action)).toEqual(["review_ruleset_removed"]);
    });

    test("an unpublished dataset, an archived one and an anonymous deposit are removals too", async () => {
      envOverrides = { PR_REVIEW_ENABLED: undefined };
      seedDataset("nm000211", { first_published_at: null });
      seedDataset("nm000212", { status: "archived" });
      seedDataset("nm000213", { anonymous: 1, first_published_at: null });

      for (const id of ["nm000211", "nm000212", "nm000213"]) {
        const r = await single(id, { dry_run: false });
        expect(r.status, id).toBe(200);
        expect(r.body, id).toMatchObject({ intent: "remove", action: "none" });
      }
    });

    test("the refusal comes before GitHub is asked anything", async () => {
      seedDataset("nm000201");
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await single("nm000201", { dry_run: false });

      expect(r.status).toBe(409);
      expect(r.body.code).toBe("review_disabled");
      expect(standIn.calls).toHaveLength(0);
      expect(held("nm000201")).toEqual([]);
    });

    test("a dry run still answers, and says the review is off", async () => {
      seedDataset("nm000201");
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await single("nm000201");

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ review_enabled: false, intent: "require", action: "create" });
      expect(standIn.writes()).toHaveLength(0);
    });

    test("taking the requirement off is never refused: it is the way out", async () => {
      seedDataset("nm000201");
      await ensureReviewRuleset("nm000201", PAT);
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await single("nm000201", { dry_run: false, remove: true });

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ action: "remove", applied: true, review_enabled: false });
      expect(held("nm000201")).toEqual([]);
    });
  });

  describe("the fixture band nm099900 to nm099999", () => {
    test.each(["nm099999", "nm099998", "nm099997", "nm099950", "nm099900"])(
      "%s is refused whatever is asked, before the catalog or GitHub is read",
      async (id) => {
        seedDataset(id);
        for (const body of [{}, { dry_run: false }, { dry_run: false, remove: true }]) {
          const r = await single(id, body);
          // A 409, not a 403: the administrator may ask, and the dataset is what refuses.
          expect(r.status, JSON.stringify(body)).toBe(409);
          expect(r.body.code).toBe("reserved_fixture_id");
        }
        expect(standIn.calls).toHaveLength(0);
        expect(audits()).toEqual([]);
      },
    );

    test("the id just below the band, and the staging exemplars, are ordinary datasets", async () => {
      seedDataset("nm099899");
      seedDataset("xx099900");

      expect((await single("nm099899", { dry_run: false })).status).toBe(200);
      expect((await single("xx099900", { dry_run: false })).status).toBe(200);
      expect(held("nm099899")).toEqual([REVIEW_RULESET_NAME]);
      expect(held("xx099900")).toEqual([REVIEW_RULESET_NAME]);
    });
  });

  test.each(["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"])(
    "%s is an ordinary dataset: no override is asked for, and none is accepted",
    async (id) => {
      seedDataset(id);

      const applied = await single(id, { dry_run: false });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ action: "create", applied: true });
      expect(held(id)).toEqual([REVIEW_RULESET_NAME]);

      // The override the first design had is gone, and a request that still sends it is refused
      // rather than read as having been honored.
      const forced = await single(id, { dry_run: false, force_live: true });
      expect(forced.status).toBe(400);
    },
  );

  test("a body with a key the route does not know is refused, and nothing is done", async () => {
    seedDataset("nm000201");

    for (const body of [{ force: true }, { dry_run: "false" }, { remove: "yes" }]) {
      const r = await single("nm000201", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(standIn.calls).toHaveLength(0);
  });

  test("an unknown dataset is 404 and a dataset without a repository is 400", async () => {
    expect((await single("nm000299")).status).toBe(404);
    seedDataset("nm000202", { github_repo: null });
    const r = await single("nm000202", { dry_run: false });
    expect(r.status).toBe(400);
    expect(standIn.calls).toHaveLength(0);
  });

  describe("when GitHub fails", () => {
    /** Run `fn` and return what it wrote to console.error. */
    async function logged(fn: () => Promise<void>): Promise<string[]> {
      const lines: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        await fn();
      } finally {
        console.error = realError;
      }
      return lines;
    }

    test("a refusal is a 502 whose error is a sentence with the status, and GitHub's own words are not in it", async () => {
      seedDataset("nm000201");
      standIn.failNext("POST", /\/rulesets$/, 422);

      const r = await single("nm000201", { dry_run: false });

      expect(r.status).toBe(502);
      expect(r.body.error).toBe(
        "GitHub refused the request for nm000201 (HTTP 422). Nothing was changed for this dataset.",
      );
      expect(r.body.code).toBe("github_request_failed");
      // The cause is in `error`, where the CLI prints it, and not behind a title in `details`.
      expect(r.body.details).toBeUndefined();
      expect(JSON.stringify(r.body)).not.toContain("refused by the stand-in");
      expect(held("nm000201")).toEqual([]);
      expect(audits()).toEqual([]);
    });

    test("the status and a short message go to the server log", async () => {
      seedDataset("nm000201");
      standIn.failNext("POST", /\/rulesets$/, 422);

      const lines = await logged(async () => {
        await single("nm000201", { dry_run: false });
      });

      const line = lines.find((l) => l.includes("[review-ruleset]"));
      expect(line).toBeDefined();
      expect(line).toContain("nm000201");
      expect(line).toContain("HTTP 422");
      expect(line).toContain("Review ruleset create failed for nm000201");
    });

    test("a 5xx says it is not known whether the change was made, and that the command can be run again", async () => {
      seedDataset("nm000201");
      // The transport tries three times before it gives GitHub's 503 to the caller.
      standIn.failNext("GET", /\/rulesets$/, 503, 3);

      const r = await single("nm000201", { dry_run: false });

      expect(r.status).toBe(502);
      expect(r.body.error).toContain("(HTTP 503)");
      expect(r.body.error).toContain("not known whether the change was made");
      expect(r.body.error).toContain("Run the same command again");
      expect(r.body.error).not.toContain("Nothing was changed");
    }, 20_000);

    test("no answer at all says the same, without a status", async () => {
      seedDataset("nm000201");
      const real = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
      // Nothing listens on port 1, so every attempt is refused at the socket.
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = "http://127.0.0.1:1";
      let r: { status: number; body: Json };
      try {
        r = await single("nm000201", { dry_run: false });
      } finally {
        (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = real;
      }

      expect(r.status).toBe(502);
      expect(r.body.error).toBe(
        "The request to GitHub for nm000201 did not complete, so it is not known whether the change was made. Run the same command again: it reads before it writes.",
      );
      expect(r.body.code).toBe("github_request_failed");
    }, 20_000);
  });

  test("an administrator may use it, and a member may not", async () => {
    seedDataset("nm000201");
    expect((await single("nm000201", {}, ADMIN_KEY)).status).toBe(200);

    db.run(
      `INSERT INTO users (username, email, password_hash, github_username, status, role,
                          signup_source, email_verified, service_access)
       VALUES ('revmember', 'revmember@example.org', 'x', 'revmember-gh', 'verified', 'member',
               'cli', 1, 0)`,
    );
    const id = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='revmember'")
      .get();
    const key = "review-ruleset-member-key-0123456789abcdef0123456789abcdef";
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      id?.id,
      await hashApiKey(key),
      key.slice(0, 8),
    );
    expect((await single("nm000201", { dry_run: false }, key)).status).toBe(403);
    expect(held("nm000201")).toEqual([]);
  });
});

describe("POST /admin/datasets/review-ruleset/bulk", () => {
  function seedFleet(): void {
    seedDataset("nm000301"); // reviewed
    seedDataset("nm000302"); // reviewed
    seedDataset("nm000303", { visibility: "private" });
    seedDataset("nm000304", { first_published_at: null });
    seedDataset("on000305"); // reviewed, imported
  }

  test("only the owner may use it", async () => {
    seedFleet();

    const asAdmin = await bulk({}, ADMIN_KEY);
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error).toBe("Only the NEMAR owner can bulk-apply the review ruleset");
    expect(standIn.calls).toHaveLength(0);

    expect((await bulk({}, OWNER_KEY)).status).toBe(200);
  });

  test("a bare request is a dry run: each row says what it would do, and nothing is written", async () => {
    seedFleet();
    await ensureReviewRuleset("nm000303", PAT); // a ruleset left on a dataset that is now private
    standIn.calls.length = 0;

    const r = await bulk({});

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dry_run: true, review_enabled: true, remove: false, limit: 25 });
    expect(r.body.payload).toStrictEqual(buildReviewRulesetPayload());
    const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
    expect(byId.nm000301).toMatchObject({ intent: "require", action: "create", applied: false });
    expect(byId.nm000302).toMatchObject({ intent: "require", action: "create", applied: false });
    expect(byId.on000305).toMatchObject({ intent: "require", action: "create", applied: false });
    expect(byId.nm000303).toMatchObject({
      reviewable: false,
      not_reviewable_because: "private",
      intent: "remove",
      action: "remove",
      applied: false,
    });
    expect(byId.nm000304).toMatchObject({
      not_reviewable_because: "unpublished",
      intent: "remove",
      action: "none",
    });
    expect(r.body.results.map((x: Json) => x.dataset_id)).toEqual([
      "nm000301",
      "nm000302",
      "nm000303",
      "nm000304",
      "on000305",
    ]);
    expect(standIn.writes()).toHaveLength(0);
    expect(audits()).toEqual([]);
  });

  test("applying puts the ruleset on the reviewed datasets and takes it off the rest", async () => {
    seedFleet();
    await ensureReviewRuleset("nm000303", PAT);

    const r = await bulk({ dry_run: false });

    expect(r.status).toBe(200);
    expect(held("nm000301")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("nm000302")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("on000305")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("nm000303")).toEqual([]);
    expect(held("nm000304")).toEqual([]);
    // One audit row for each change and none for the dataset that needed nothing.
    expect(audits().map((a) => `${a.action} ${a.resource_id}`)).toEqual([
      "review_ruleset_applied nm000301",
      "review_ruleset_applied nm000302",
      "review_ruleset_removed nm000303",
      "review_ruleset_applied on000305",
    ]);
    expect(JSON.parse(audits()[0].details)).toEqual({
      by: "revowner",
      action: "create",
      bulk: true,
    });
  });

  test("remove takes the ruleset off every dataset it is asked about, reviewed or not", async () => {
    seedFleet();
    await bulk({ dry_run: false });
    expect(held("nm000301")).toEqual([REVIEW_RULESET_NAME]);

    const r = await bulk({ dry_run: false, remove: true });

    expect(r.body).toMatchObject({ remove: true, payload: null });
    expect(held("nm000301")).toEqual([]);
    expect(held("nm000302")).toEqual([]);
    expect(held("on000305")).toEqual([]);
  });

  test("the fixture band is never selected, and the datasets around it are", async () => {
    for (const id of ["nm099899", "nm099900", "nm099950", "nm099997", "nm099998", "nm099999"]) {
      seedDataset(id);
    }
    seedDataset("xx099900");

    const r = await bulk({ dry_run: false });

    const ids = r.body.results.map((x: Json) => x.dataset_id);
    expect(ids).toEqual(["nm099899", "xx099900"]);
    for (const fixture of ["nm099900", "nm099950", "nm099997", "nm099998", "nm099999"]) {
      expect(held(fixture), fixture).toEqual([]);
      expect(
        standIn.calls.filter((c) => c.path.includes(`/repos/nemarDatasets/${fixture}`)),
        fixture,
      ).toHaveLength(0);
    }
    expect(held("nm099899")).toEqual([REVIEW_RULESET_NAME]);
  });

  test("the five datasets an old rule protected are ordinary rows in a batch", async () => {
    for (const id of ["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"]) seedDataset(id);

    const r = await bulk({ dry_run: false });

    expect(r.body.results.map((x: Json) => x.dataset_id)).toEqual([
      "nm000103",
      "nm000104",
      "nm000105",
      "nm000106",
      "nm000107",
    ]);
    for (const id of ["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"]) {
      expect(held(id), id).toEqual([REVIEW_RULESET_NAME]);
    }
  });

  test("pages are bounded and follow one another by id", async () => {
    for (let n = 1; n <= 5; n++) seedDataset(`nm00040${n}`);

    const first = await bulk({ limit: 2 });
    expect(first.body.results.map((x: Json) => x.dataset_id)).toEqual(["nm000401", "nm000402"]);
    expect(first.body).toMatchObject({ limit: 2, count: 2, next_after: "nm000402" });

    const second = await bulk({ limit: 2, after: first.body.next_after });
    expect(second.body.results.map((x: Json) => x.dataset_id)).toEqual(["nm000403", "nm000404"]);
    expect(second.body.next_after).toBe("nm000404");

    const last = await bulk({ limit: 2, after: second.body.next_after });
    expect(last.body.results.map((x: Json) => x.dataset_id)).toEqual(["nm000405"]);
    // A page that is not full is the last one.
    expect(last.body).toMatchObject({ count: 1, next_after: null });
  });

  test("a page is at most 50: more is refused, and so is a limit that is not a count", async () => {
    for (const limit of [51, 100, 0, -1, 2.5, "10"]) {
      const r = await bulk({ limit });
      expect(r.status, String(limit)).toBe(400);
    }
    expect(standIn.calls).toHaveLength(0);
    expect((await bulk({ limit: 50 })).status).toBe(200);
  });

  test("a prefix narrows the page, and something that is not a prefix is refused", async () => {
    seedFleet();

    const on = await bulk({ prefix: "on" });
    expect(on.body.results.map((x: Json) => x.dataset_id)).toEqual(["on000305"]);

    const narrow = await bulk({ prefix: "nm0003" });
    expect(narrow.body.count).toBe(4);

    for (const prefix of ["nm%", "n_", "NM", "nm0000000", "", "../"]) {
      expect((await bulk({ prefix })).status, JSON.stringify(prefix)).toBe(400);
    }
    expect((await bulk({ after: "nm0003" })).status).toBe(400);
  });

  test("a dataset without a repository is not selected", async () => {
    seedDataset("nm000501", { github_repo: null });
    seedDataset("nm000502");

    const r = await bulk({});

    expect(r.body.results.map((x: Json) => x.dataset_id)).toEqual(["nm000502"]);
  });

  test("a repository that fails is an error on its row, and the page goes on", async () => {
    seedFleet();
    standIn.failNext("GET", /\/repos\/nemarDatasets\/nm000302\/rulesets$/, 403);

    const r = await bulk({ dry_run: false });

    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
    expect(byId.nm000302.action).toBeNull();
    expect(byId.nm000302.applied).toBe(false);
    // A sentence with the status, and none of GitHub's own words.
    expect(byId.nm000302.error).toBe(
      "GitHub refused the request for nm000302 (HTTP 403). Nothing was changed for this dataset.",
    );
    expect(byId.nm000302.code).toBe("github_request_failed");
    expect(JSON.stringify(byId.nm000302)).not.toContain("refused by the stand-in");
    expect(held("nm000301")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("on000305")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("nm000302")).toEqual([]);
    expect(audits().map((a) => a.resource_id)).not.toContain("nm000302");
  });

  test("a repository on another default branch is skipped on its row", async () => {
    seedFleet();
    standIn.defaultBranches.set("nm000301", "master");

    const r = await bulk({ dry_run: false });

    const row = r.body.results.find((x: Json) => x.dataset_id === "nm000301");
    expect(row).toMatchObject({
      action: "skip",
      reason: "default_branch_not_main",
      applied: false,
    });
    expect(held("nm000301")).toEqual([]);
    expect(held("nm000302")).toEqual([REVIEW_RULESET_NAME]);
  });

  describe("while the review is off", () => {
    test("a live page refuses each row that would require the review, and still applies the removals", async () => {
      seedFleet();
      await ensureReviewRuleset("nm000303", PAT); // a ruleset left on a dataset that is now private
      standIn.calls.length = 0;
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await bulk({ dry_run: false });

      expect(r.status).toBe(200);
      const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
      // The three the Worker reviews are refused on their own rows, in the Worker's words.
      for (const id of ["nm000301", "nm000302", "on000305"]) {
        expect(byId[id], id).toMatchObject({
          intent: "require",
          action: null,
          applied: false,
          code: "review_disabled",
        });
        expect(byId[id].error, id).toContain("PR_REVIEW_ENABLED");
        expect(held(id), id).toEqual([]);
      }
      // The two that it does not review went through: one lost its ruleset, one had none to lose.
      expect(byId.nm000303).toMatchObject({ intent: "remove", action: "remove", applied: true });
      expect(byId.nm000304).toMatchObject({ intent: "remove", action: "none", applied: false });
      expect(byId.nm000303.error).toBeUndefined();
      expect(held("nm000303")).toEqual([]);
      expect(audits().map((a) => `${a.action} ${a.resource_id}`)).toEqual([
        "review_ruleset_removed nm000303",
      ]);
      // And GitHub was not asked about a repository whose row was refused.
      for (const id of ["nm000301", "nm000302", "on000305"]) {
        expect(
          standIn.calls.filter((c) => c.path.includes(`/repos/nemarDatasets/${id}`)),
          id,
        ).toHaveLength(0);
      }
    });

    test("a live page of reviewed datasets only is refused row by row, and nothing is written", async () => {
      seedDataset("nm000301");
      seedDataset("nm000302");
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await bulk({ dry_run: false });

      expect(r.status).toBe(200);
      expect(r.body.results.map((x: Json) => x.code)).toEqual([
        "review_disabled",
        "review_disabled",
      ]);
      expect(standIn.calls).toHaveLength(0);
      expect(audits()).toEqual([]);
    });

    test("a dry run answers, and so does a live removal", async () => {
      seedFleet();
      await ensureReviewRuleset("nm000301", PAT);
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const dry = await bulk({});
      expect(dry.status).toBe(200);
      expect(dry.body.review_enabled).toBe(false);

      const off = await bulk({ dry_run: false, remove: true });
      expect(off.status).toBe(200);
      expect(held("nm000301")).toEqual([]);
    });
  });

  test("a body with a key it does not know, the retired override included, is refused", async () => {
    seedFleet();
    for (const body of [{ force_live: true }, { force: true }, { dry_run: "false" }]) {
      expect((await bulk(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(standIn.calls).toHaveLength(0);
  });
});

// The ruleset requires the NEMAR PR Review check from the GitHub App with id 3679074, and this Worker
// posts the check as the App whose id is its GITHUB_APP_ID binding. If they differ the check never
// arrives and the ruleset blocks every merge on the repository, so a live requirement is refused
// and a removal, which needs no check, is not.
describe("a Worker that posts the review check as another GitHub App", () => {
  const OTHER_APP = "1234567";

  test("a live require is refused with 409, a sentence that names both ids, and no call to GitHub", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_ID: OTHER_APP };

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe("review_app_mismatch");
    expect(r.body.error).toContain("3679074");
    expect(r.body.error).toContain(OTHER_APP);
    expect(r.body.error).toContain("Nothing was changed");
    expect(standIn.calls).toHaveLength(0);
    expect(held("nm000201")).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test("an unset App id is refused the same way, and said to be unset", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_ID: undefined };

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe("review_app_mismatch");
    expect(r.body.error).toContain("3679074");
    expect(r.body.error).toContain("GITHUB_APP_ID is not set");
    // It names the one thing to fix: the binding is not there, which is not "not a number".
    expect(r.body.error).not.toContain("plain number");
    expect(standIn.calls).toHaveLength(0);

    const dry = await single("nm000201");
    expect(dry.body).toMatchObject({ github_app_id: null, github_app_id_state: "unset" });
  });

  test("the same request goes through when the Worker posts as the App the ruleset names", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_ID: "3679074" };

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ action: "create", applied: true, app_id_matches: true });
    expect(held("nm000201")).toEqual([REVIEW_RULESET_NAME]);
  });

  test("a dry run still answers, and prints both ids and that they differ", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_ID: OTHER_APP };

    const r = await single("nm000201");

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dry_run: true,
      action: "create",
      applied: false,
      github_app_id: OTHER_APP,
      github_app_id_state: "id",
      ruleset_app_id: 3679074,
      app_id_matches: false,
    });
    expect(standIn.writes()).toHaveLength(0);
  });

  test("a dry run shows the ids agreeing, too", async () => {
    seedDataset("nm000201");

    const r = await single("nm000201");

    expect(r.body).toMatchObject({
      github_app_id: "3679074",
      github_app_id_state: "id",
      ruleset_app_id: 3679074,
      app_id_matches: true,
    });
  });

  test("an App id that is not a number is never repeated in an answer", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_ID: "-----BEGIN PRIVATE KEY-----" };

    const dry = await single("nm000201");
    const live = await single("nm000201", { dry_run: false });

    expect(dry.body).toMatchObject({
      github_app_id: null,
      github_app_id_state: "not_a_number",
      app_id_matches: false,
    });
    expect(JSON.stringify(dry.body)).not.toContain("PRIVATE KEY");
    expect(live.status).toBe(409);
    expect(JSON.stringify(live.body)).not.toContain("PRIVATE KEY");
    // It names the one thing to fix: the binding is set, to something that is not an id.
    expect(live.body.error).toContain("GITHUB_APP_ID is set but is not a plain number");
    expect(live.body.error).not.toContain("is not set");
  });

  test("a removal is not refused by it: remove:true, and a dataset the Worker does not review", async () => {
    seedDataset("nm000201");
    seedDataset("nm000202", { visibility: "private" });
    await ensureReviewRuleset("nm000201", PAT);
    await ensureReviewRuleset("nm000202", PAT);
    envOverrides = { GITHUB_APP_ID: OTHER_APP };

    const removed = await single("nm000201", { dry_run: false, remove: true });
    const stray = await single("nm000202", { dry_run: false });

    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ action: "remove", applied: true });
    expect(stray.status).toBe(200);
    expect(stray.body).toMatchObject({ intent: "remove", action: "remove", applied: true });
    expect(held("nm000201")).toEqual([]);
    expect(held("nm000202")).toEqual([]);
  });

  test("a live page refuses each row that would require the ruleset and applies the removals", async () => {
    seedDataset("nm000301");
    seedDataset("nm000302", { visibility: "private" });
    await ensureReviewRuleset("nm000302", PAT);
    standIn.calls.length = 0;
    envOverrides = { GITHUB_APP_ID: OTHER_APP };

    const r = await bulk({ dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ github_app_id: OTHER_APP, app_id_matches: false });
    const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
    expect(byId.nm000301).toMatchObject({
      action: null,
      applied: false,
      code: "review_app_mismatch",
    });
    expect(byId.nm000301.error).toContain("3679074");
    expect(byId.nm000301.error).toContain(OTHER_APP);
    expect(byId.nm000302).toMatchObject({ intent: "remove", action: "remove", applied: true });
    expect(held("nm000301")).toEqual([]);
    expect(held("nm000302")).toEqual([]);
    expect(standIn.calls.filter((c) => c.path.includes("/nm000301"))).toHaveLength(0);
  });

  test("a dry run page answers with the ids and no refusal", async () => {
    seedDataset("nm000301");
    envOverrides = { GITHUB_APP_ID: OTHER_APP };

    const r = await bulk({});

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ app_id_matches: false, ruleset_app_id: 3679074 });
    expect(r.body.results[0]).toMatchObject({ action: "create", applied: false });
    expect(r.body.results[0].error).toBeUndefined();
  });

  test("the review being off is said first when both apply", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_ID: OTHER_APP, PR_REVIEW_ENABLED: undefined };

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe("review_disabled");
  });
});

// The right App id is not enough. The check is posted with an installation token for
// nemarDatasets, and a Worker without the App's private key or that installation id falls back to
// the personal access token, which GitHub does not let post a check run. So the ruleset would wait
// for a check that never comes, and a live requirement is refused. A removal is not.
describe("a Worker with the right App id and no way to sign in as the App", () => {
  /** What leaves the Worker without an installation of the App for nemarDatasets, in four ways. */
  const WITHOUT: Array<[string, Partial<Bindings>]> = [
    ["no private key", { GITHUB_APP_PRIVATE_KEY: undefined }],
    ["no installation id", { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined }],
    [
      "an installation id that is not a number",
      { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "x42" },
    ],
    [
      "an installation id for the other organization only",
      {
        GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined,
        GITHUB_APP_INSTALLATION_ID_NEMAR_ORG: "424242",
      },
    ],
  ];

  /** Run `fn` with the warning for a malformed installation id silenced. */
  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      return await fn();
    } finally {
      console.warn = realWarn;
    }
  }

  test.each(WITHOUT)(
    "a live require is refused with 409, a plain sentence, and no call to GitHub (%s)",
    async (_name, config) => {
      seedDataset("nm000201");
      envOverrides = config;

      const r = await quietly(() => single("nm000201", { dry_run: false }));

      expect(r.status).toBe(409);
      expect(r.body.code).toBe("review_app_not_configured");
      expect(r.body.error).toContain("cannot sign in as the GitHub App for the nemarDatasets");
      expect(r.body.error).toContain("GITHUB_APP_PRIVATE_KEY");
      expect(r.body.error).toContain("GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS");
      expect(r.body.error).toContain("personal access token");
      expect(r.body.error).toContain("Nothing was changed");
      // The id is right, so it is not what the sentence is about.
      expect(r.body.error).not.toContain("3679074");
      expect(standIn.calls).toHaveLength(0);
      expect(held("nm000201")).toEqual([]);
      expect(audits()).toEqual([]);
    },
  );

  test("a dry run still answers, and says the id is right and the installation is not", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined };

    const r = await single("nm000201");

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dry_run: true,
      action: "create",
      applied: false,
      github_app_id: "3679074",
      app_id_matches: true,
      installation_configured: false,
    });
    expect(standIn.writes()).toHaveLength(0);
  });

  test("the same request goes through when the Worker can sign in as the App, and does so", async () => {
    seedDataset("nm000201");

    const dry = await single("nm000201");
    expect(dry.body).toMatchObject({ app_id_matches: true, installation_configured: true });
    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      action: "create",
      applied: true,
      installation_configured: true,
    });
    expect(held("nm000201")).toEqual([REVIEW_RULESET_NAME]);
    // It reached GitHub as the App's installation and not as the personal access token.
    const sent = standIn.rulesetWrites();
    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe(`Bearer ${APP_TOKEN}`);
  });

  test("a removal is not refused, and is made with the personal access token the Worker has", async () => {
    seedDataset("nm000201");
    seedDataset("nm000202", { visibility: "private" });
    await ensureReviewRuleset("nm000201", PAT);
    await ensureReviewRuleset("nm000202", PAT);
    standIn.calls.length = 0;
    envOverrides = { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined };

    const removed = await single("nm000201", { dry_run: false, remove: true });
    const stray = await single("nm000202", { dry_run: false });

    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ action: "remove", applied: true });
    expect(stray.status).toBe(200);
    expect(stray.body).toMatchObject({ intent: "remove", action: "remove", applied: true });
    expect(held("nm000201")).toEqual([]);
    expect(held("nm000202")).toEqual([]);
    // This is the fallback the refusal is about: with no installation, the PAT is what is sent.
    for (const call of standIn.calls) expect(call.auth).toBe(`Bearer ${PAT}`);
  });

  test("a live page refuses each row that would require the ruleset, and applies the removals", async () => {
    seedDataset("nm000301");
    seedDataset("nm000302", { visibility: "private" });
    await ensureReviewRuleset("nm000302", PAT);
    standIn.calls.length = 0;
    envOverrides = { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined };

    const r = await bulk({ dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ app_id_matches: true, installation_configured: false });
    const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
    expect(byId.nm000301).toMatchObject({
      action: null,
      applied: false,
      code: "review_app_not_configured",
    });
    expect(byId.nm000301.error).toContain("GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS");
    expect(byId.nm000302).toMatchObject({ intent: "remove", action: "remove", applied: true });
    expect(held("nm000301")).toEqual([]);
    expect(held("nm000302")).toEqual([]);
    expect(standIn.calls.filter((c) => c.path.includes("/nm000301"))).toHaveLength(0);
  });

  test("a dry run page answers with the state and no refusal", async () => {
    seedDataset("nm000301");
    envOverrides = { GITHUB_APP_PRIVATE_KEY: undefined };

    const r = await bulk({});

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ app_id_matches: true, installation_configured: false });
    expect(r.body.results[0]).toMatchObject({ action: "create", applied: false });
    expect(r.body.results[0].error).toBeUndefined();
  });

  test("the id is said first when it is wrong too, and the review being off before both", async () => {
    seedDataset("nm000201");
    envOverrides = {
      GITHUB_APP_ID: "1234567",
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined,
    };
    const wrongId = await single("nm000201", { dry_run: false });
    expect(wrongId.status).toBe(409);
    expect(wrongId.body.code).toBe("review_app_mismatch");
    expect(wrongId.body.error).not.toContain("GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS");

    envOverrides = {
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined,
      PR_REVIEW_ENABLED: undefined,
    };
    const off = await single("nm000201", { dry_run: false });
    expect(off.status).toBe(409);
    expect(off.body.code).toBe("review_disabled");
    expect(standIn.calls).toHaveLength(0);
  });
});

// A refusal is one sentence, and it is said in two places. The route for one dataset answers with
// it, and adds that nothing was changed, which is the whole of that request. A page puts it on each
// refused row and the CLI prints it once for the page, where the other rows may have been changed,
// so on a row it says nothing about what was changed.
describe("what a refusal says about what was changed", () => {
  const CASES: Array<[string, string, Partial<Bindings>]> = [
    ["review_disabled", "PR_REVIEW_ENABLED", { PR_REVIEW_ENABLED: undefined }],
    ["review_app_mismatch", "1234567", { GITHUB_APP_ID: "1234567" }],
    [
      "review_app_not_configured",
      "GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS",
      { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined },
    ],
  ];

  test.each(CASES)(
    "%s: the answer for one dataset ends with the fact that nothing was changed",
    async (code, word, config) => {
      seedDataset("nm000201");
      envOverrides = config;

      const r = await single("nm000201", { dry_run: false });

      expect(r.status).toBe(409);
      expect(r.body.code).toBe(code);
      expect(r.body.error).toContain(word);
      expect(r.body.error).toEndWith(` ${REMOVAL_IS_NEVER_REFUSED} Nothing was changed.`);
      expect(standIn.calls).toHaveLength(0);
    },
  );

  test.each(CASES)(
    "%s: a refused row of a page says nothing about what was changed, and the removals on it were",
    async (code, word, config) => {
      seedDataset("nm000301");
      seedDataset("nm000302", { visibility: "private" });
      await ensureReviewRuleset("nm000302", PAT);
      envOverrides = config;

      const r = await bulk({ dry_run: false });

      expect(r.status).toBe(200);
      const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
      expect(byId.nm000301.code).toBe(code);
      expect(byId.nm000301.error).toContain(word);
      expect(byId.nm000301.error).toEndWith(REMOVAL_IS_NEVER_REFUSED);
      // Said of a row of a page, it would be false: this page changed the other dataset.
      expect(byId.nm000301.error).not.toContain("Nothing was changed");
      expect(byId.nm000302).toMatchObject({ action: "remove", applied: true });
      expect(held("nm000302")).toEqual([]);
    },
  );
});

describe("the enforce routes and the review", () => {
  const enforce = (id: string, body: unknown = {}) =>
    post(`/admin/datasets/${id}/enforce`, body, ADMIN_KEY);

  // Enforce manages the review ruleset on its own, so it waits for the owner's switch
  // (PR_REVIEW_AUTO_REQUIRE). These tests are about what it does once that is on; the ones that
  // are about the switch itself are in the describe below. The explicit routes above run without
  // it, which is also what shows they do not read it.
  beforeEach(() => {
    envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1" };
  });

  test("a dry run of enforce on a reviewed dataset reports the review step and writes nothing", async () => {
    seedDataset("nm000201");

    const r = await enforce("nm000201");

    expect(r.status).toBe(200);
    expect(r.body.result.steps.review_ruleset).toEqual({ status: "ok", detail: "would create" });
    expect(standIn.writes()).toHaveLength(0);
  });

  test("applying enforce puts the requirement on a reviewed dataset, next to the branch ruleset", async () => {
    seedDataset("nm000201");

    const r = await enforce("nm000201", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body.result.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
    expect(held("nm000201")).toContain(REVIEW_RULESET_NAME);
    expect(held("nm000201")).toContain(BRANCH_RULESET_NAME);
  });

  test("while the review is off enforce says nothing about the review, and leaves its ruleset as it is", async () => {
    seedDataset("nm000201");
    await ensureReviewRuleset("nm000201", PAT);
    const before = structuredClone(standIn.rulesets.get("nm000201"));
    // The automatic switch stays on: it is the review itself that is off here.
    envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1", PR_REVIEW_ENABLED: undefined };

    const r = await enforce("nm000201", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body.result.steps.review_ruleset).toBeUndefined();
    expect(
      standIn.rulesets.get("nm000201")?.filter((x) => x.name === REVIEW_RULESET_NAME),
    ).toStrictEqual(before);
  });

  test("a dataset that is no longer reviewed has the ruleset taken off by enforce", async () => {
    seedDataset("nm000201", { visibility: "private" });
    await ensureReviewRuleset("nm000201", PAT);

    const r = await enforce("nm000201", { dry_run: false });

    expect(r.body.result.steps.review_ruleset).toEqual({ status: "ok", detail: "removed" });
    expect(held("nm000201")).not.toContain(REVIEW_RULESET_NAME);
  });

  // `nemar admin fleet enforce` prints each step's detail as the route sends it, so a step GitHub
  // refuses must reach the answer as GitHub's status and a sentence, never as GitHub's own body.
  test("a review step GitHub refuses is a status and a sentence in the answer of both routes, and not GitHub's body", async () => {
    seedDataset("nm000201");
    await ensureReviewRuleset("nm000201", PAT);
    // The review ruleset's own address, so the branch ruleset's write is not the one refused.
    const reviewId = standIn.rulesets
      .get("nm000201")
      ?.find((x) => x.name === REVIEW_RULESET_NAME)?.id;
    const review = new RegExp(`/repos/nemarDatasets/nm000201/rulesets/${reviewId}$`);
    const quiet = console.error;
    console.error = () => {};
    try {
      standIn.failNext("PUT", review, 403);
      const one = await enforce("nm000201", { dry_run: false });
      standIn.failNext("PUT", review, 403);
      const many = await post("/admin/datasets/enforce/bulk", { dry_run: false }, OWNER_KEY);

      expect(one.status).toBe(200);
      expect(one.body.result.steps.review_ruleset).toEqual({
        status: "failed",
        detail: "GitHub refused the review ruleset with HTTP 403",
      });
      expect(many.status).toBe(200);
      expect(many.body.results[0].steps.review_ruleset).toEqual({
        status: "failed",
        detail: "GitHub refused the review ruleset with HTTP 403",
      });
      for (const body of [one.body, many.body]) {
        expect(JSON.stringify(body)).not.toContain("refused by the stand-in");
        expect(JSON.stringify(body)).not.toContain("Review ruleset update failed");
      }
    } finally {
      console.error = quiet;
    }
  });

  test("enforce leaves a standing fixture's rulesets alone, in either direction", async () => {
    seedDataset("nm099998", { visibility: "private" });
    await ensureReviewRuleset("nm099998", PAT);
    const before = structuredClone(standIn.rulesets.get("nm099998"));

    const r = await enforce("nm099998", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body.result.steps.review_ruleset).toBeUndefined();
    expect(standIn.rulesets.get("nm099998")).toStrictEqual(before);
  });

  test("bulk enforce gives each dataset the review step its own row calls for", async () => {
    seedDataset("nm000301");
    seedDataset("nm000302", { visibility: "private" });
    await ensureReviewRuleset("nm000302", PAT);

    const r = await post("/admin/datasets/enforce/bulk", { dry_run: false }, OWNER_KEY);

    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
    expect(byId.nm000301.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
    expect(byId.nm000302.steps.review_ruleset).toEqual({ status: "ok", detail: "removed" });
    expect(held("nm000301")).toContain(REVIEW_RULESET_NAME);
    expect(held("nm000302")).not.toContain(REVIEW_RULESET_NAME);
  });
});

// PR_REVIEW_AUTO_REQUIRE is the owner's switch for the paths that manage the review ruleset on
// their own. The production Worker already runs the review (PR_REVIEW_ENABLED), so without this
// an enforce run would require the check on every reviewable dataset before the canary and the
// calibration gate. Each test runs through BOTH routes, the single one and the bulk one, and the
// stand-in is what is asked: not what a function was called with.
describe("the enforce routes and the automatic switch", () => {
  type Steps = Record<string, { status: string; detail?: string }> | undefined;

  /** One enforce of one dataset through the named route, and the steps that route reports for it. */
  async function enforceVia(
    route: "single" | "bulk",
    id: string,
    dryRun: boolean,
  ): Promise<{ status: number; steps: Steps }> {
    if (route === "single") {
      const r = await post(`/admin/datasets/${id}/enforce`, { dry_run: dryRun }, ADMIN_KEY);
      return { status: r.status, steps: r.body.result?.steps };
    }
    const r = await post("/admin/datasets/enforce/bulk", { dry_run: dryRun }, OWNER_KEY);
    const row = (r.body.results ?? []).find((x: Json) => x.dataset_id === id);
    return { status: r.status, steps: row?.steps };
  }

  /** The review rulesets a repository holds, as the stand-in keeps them. */
  const reviewRulesetsOf = (repo: string) =>
    (standIn.rulesets.get(repo) ?? []).filter((x) => x.name === REVIEW_RULESET_NAME);

  /**
   * The writes that created, replaced or deleted a REVIEW ruleset. The branch ruleset enforce
   * writes on a public repository is not counted. A delete carries no body, so it is told by the
   * id of the ruleset it names.
   */
  const reviewWrites = (ids: number[] = []) =>
    standIn
      .rulesetWrites()
      .filter(
        (c) =>
          c.body?.name === REVIEW_RULESET_NAME ||
          ids.some((id) => c.path.endsWith(`/rulesets/${id}`)),
      );

  describe.each(["single", "bulk"] as const)("the %s route", (route) => {
    test("off, a dry run reports no review step and asks GitHub nothing about rulesets", async () => {
      seedDataset("nm000201");

      const r = await enforceVia(route, "nm000201", true);

      expect(r.status).toBe(200);
      // The route ran: it planned the repository, and said nothing of the review.
      expect(r.steps?.plan).toBeDefined();
      expect(r.steps?.review_ruleset).toBeUndefined();
      expect(standIn.calls.filter((c) => c.path.includes("/rulesets"))).toEqual([]);
    });

    test("on, the same dry run reads the repository's rulesets and reports the step", async () => {
      envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1" };
      seedDataset("nm000201");

      const r = await enforceVia(route, "nm000201", true);

      expect(r.steps?.review_ruleset).toEqual({ status: "ok", detail: "would create" });
      expect(
        standIn.calls.filter((c) => c.method === "GET" && c.path.endsWith("/rulesets")),
      ).not.toHaveLength(0);
      expect(standIn.writes()).toHaveLength(0);
    });

    test("off, a live run writes no review ruleset and still does the rest of its work", async () => {
      seedDataset("nm000201");

      const r = await enforceVia(route, "nm000201", false);

      expect(r.status).toBe(200);
      expect(r.steps?.review_ruleset).toBeUndefined();
      expect(reviewWrites()).toEqual([]);
      expect(held("nm000201")).not.toContain(REVIEW_RULESET_NAME);
      // Not a route that did nothing: the branch protection enforce always writes is there.
      expect(held("nm000201")).toContain(BRANCH_RULESET_NAME);
    });

    test("off, a review ruleset already on a reviewed dataset is left exactly as it is", async () => {
      seedDataset("nm000201");
      await ensureReviewRuleset("nm000201", PAT);
      const before = structuredClone(reviewRulesetsOf("nm000201"));
      standIn.calls.length = 0;

      const r = await enforceVia(route, "nm000201", false);

      expect(r.status).toBe(200);
      expect(r.steps?.review_ruleset).toBeUndefined();
      expect(reviewRulesetsOf("nm000201")).toStrictEqual(before);
      expect(reviewWrites(before.map((x) => x.id))).toEqual([]);
    });

    // The switch gates the requirement being added, and nothing else: a dataset made private
    // while it is off must not keep a ruleset that nothing will satisfy.
    test("off, the ruleset is still taken off a dataset that is no longer reviewed", async () => {
      seedDataset("nm000201", { visibility: "private" });
      await ensureReviewRuleset("nm000201", PAT);
      const ids = reviewRulesetsOf("nm000201").map((x) => x.id);
      standIn.calls.length = 0;

      const r = await enforceVia(route, "nm000201", false);

      expect(r.status).toBe(200);
      expect(r.steps?.review_ruleset).toEqual({ status: "ok", detail: "removed" });
      expect(reviewWrites(ids).map((c) => c.method)).toEqual(["DELETE"]);
      expect(reviewRulesetsOf("nm000201")).toEqual([]);
    });

    test("off, a dry run plans the removal for a dataset that is no longer reviewed, and writes nothing", async () => {
      seedDataset("nm000201", { visibility: "private" });
      await ensureReviewRuleset("nm000201", PAT);
      standIn.calls.length = 0;

      const r = await enforceVia(route, "nm000201", true);

      expect(r.steps?.review_ruleset).toEqual({ status: "ok", detail: "would remove" });
      expect(standIn.writes()).toHaveLength(0);
      expect(reviewRulesetsOf("nm000201")).toHaveLength(1);
    });

    test("on, a live run creates the review ruleset with the pinned payload, then updates it", async () => {
      envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1" };
      seedDataset("nm000201");

      const created = await enforceVia(route, "nm000201", false);

      expect(created.steps?.review_ruleset).toEqual({ status: "ok", detail: "created" });
      const posts = reviewWrites();
      expect(posts.map((c) => c.method)).toEqual(["POST"]);
      expect(posts[0].body).toStrictEqual(buildReviewRulesetPayload());

      const ids = reviewRulesetsOf("nm000201").map((x) => x.id);
      standIn.calls.length = 0;
      const updated = await enforceVia(route, "nm000201", false);

      expect(updated.steps?.review_ruleset).toEqual({ status: "ok", detail: "updated" });
      const puts = reviewWrites(ids);
      expect(puts.map((c) => c.method)).toEqual(["PUT"]);
      expect(puts[0].body).toStrictEqual(buildReviewRulesetPayload());
    });

    test("on, the ruleset is deleted from a dataset that is no longer reviewed", async () => {
      envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1" };
      seedDataset("nm000201", { visibility: "private" });
      await ensureReviewRuleset("nm000201", PAT);
      const ids = reviewRulesetsOf("nm000201").map((x) => x.id);
      standIn.calls.length = 0;

      const r = await enforceVia(route, "nm000201", false);

      expect(r.steps?.review_ruleset).toEqual({ status: "ok", detail: "removed" });
      expect(reviewWrites(ids).map((c) => c.method)).toEqual(["DELETE"]);
      expect(reviewRulesetsOf("nm000201")).toEqual([]);
    });
  });

  test("off, one bulk page puts no ruleset on a reviewed dataset and takes the stray one off the rest", async () => {
    seedDataset("nm000301"); // reviewed, without the ruleset
    seedDataset("nm000302"); // reviewed, with it
    seedDataset("nm000303", { visibility: "private" }); // not reviewed, with a stray one
    await ensureReviewRuleset("nm000302", PAT);
    await ensureReviewRuleset("nm000303", PAT);
    const reviewed = Object.fromEntries(
      ["nm000301", "nm000302"].map((id) => [id, structuredClone(reviewRulesetsOf(id))]),
    );
    const stray = reviewRulesetsOf("nm000303").map((x) => x.id);
    standIn.calls.length = 0;

    const r = await post("/admin/datasets/enforce/bulk", { dry_run: false }, OWNER_KEY);

    expect(r.status).toBe(200);
    expect(r.body.count).toBe(3);
    const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
    // A reviewed dataset has no review step at all, and keeps the ruleset it has (or lacks).
    for (const id of ["nm000301", "nm000302"]) {
      expect(byId[id].steps.review_ruleset, id).toBeUndefined();
      expect(reviewRulesetsOf(id), id).toStrictEqual(reviewed[id]);
    }
    // The dataset that is not reviewed had its ruleset taken off, and nothing else was touched.
    expect(byId.nm000303.steps.review_ruleset).toEqual({ status: "ok", detail: "removed" });
    expect(reviewRulesetsOf("nm000303")).toEqual([]);
    expect(
      reviewWrites([...stray, ...Object.values(reviewed).flatMap((x) => x.map((y) => y.id))]).map(
        (c) => `${c.method} ${c.path.split("/")[3]}`,
      ),
    ).toEqual(["DELETE nm000303"]);
  });

  describe("the explicit routes do not read the switch", () => {
    test("the single route applies and removes with the switch off, and a dry run still answers", async () => {
      envOverrides = { PR_REVIEW_AUTO_REQUIRE: "0" };
      seedDataset("nm000201");

      const dry = await single("nm000201");
      expect(dry.body).toMatchObject({ review_enabled: true, intent: "require", action: "create" });

      const applied = await single("nm000201", { dry_run: false });
      expect(applied.body).toMatchObject({ action: "create", applied: true });
      expect(held("nm000201")).toEqual([REVIEW_RULESET_NAME]);

      const removed = await single("nm000201", { dry_run: false, remove: true });
      expect(removed.body).toMatchObject({ action: "remove", applied: true });
      expect(held("nm000201")).toEqual([]);
    });

    test("the bulk route applies the same way", async () => {
      envOverrides = { PR_REVIEW_AUTO_REQUIRE: "0" };
      seedDataset("nm000301");
      seedDataset("nm000302", { visibility: "private" });

      const r = await bulk({ dry_run: false });

      expect(r.status).toBe(200);
      expect(held("nm000301")).toEqual([REVIEW_RULESET_NAME]);
      expect(held("nm000302")).toEqual([]);
    });

    // The configuration file cannot show a switch that was set as a Worker secret, so the answers
    // carry what the Worker reads: beside review_enabled, and as a boolean, never a missing field.
    test("both answer with the switch as the Worker reads it, exactly 1 and nothing else", async () => {
      seedDataset("nm000301");
      const reads = async () => {
        const one = await single("nm000301");
        const many = await bulk({});
        expect(one.status).toBe(200);
        expect(many.status).toBe(200);
        return [one.body.auto_require, many.body.auto_require];
      };

      expect(await reads()).toEqual([false, false]);
      envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1" };
      expect(await reads()).toEqual([true, true]);
      for (const value of ["0", "true", "yes", " 1", "01", ""]) {
        envOverrides = { PR_REVIEW_AUTO_REQUIRE: value };
        expect(await reads(), JSON.stringify(value)).toEqual([false, false]);
      }
      // Independent of the review itself: the two are reported side by side.
      envOverrides = { PR_REVIEW_AUTO_REQUIRE: "1", PR_REVIEW_ENABLED: undefined };
      const off = await single("nm000301");
      expect(off.body).toMatchObject({ review_enabled: false, auto_require: true });
      const page = await bulk({});
      expect(page.body).toMatchObject({ review_enabled: false, auto_require: true });
    });

    test("they still refuse a live require while the review itself is off, switch or no switch", async () => {
      seedDataset("nm000201");
      for (const auto of [undefined, "1"]) {
        envOverrides = { PR_REVIEW_ENABLED: undefined, PR_REVIEW_AUTO_REQUIRE: auto };

        const one = await single("nm000201", { dry_run: false });
        const many = await bulk({ dry_run: false });

        // The single request is refused outright. The page is answered, with the row refused.
        expect(one.status, `single, switch ${auto}`).toBe(409);
        expect(one.body.code).toBe("review_disabled");
        expect(many.status, `bulk, switch ${auto}`).toBe(200);
        expect(many.body.results.map((x: Json) => x.code)).toEqual(["review_disabled"]);
      }
      expect(standIn.calls).toHaveLength(0);
    });
  });
});

describe("GET /admin/fleet/drift and the review", () => {
  const drift = async (query = "?prefix=nm&limit=50") => {
    const res = await app.request(
      `/admin/fleet/drift${query}`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    return { status: res.status, body: (await res.json()) as Json };
  };

  // The requirement is the target only with the review on AND the owner's switch on. The tests
  // that expect a ruleset to be missing set both; the ones about the switches are below.
  const requirementOn = { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "1" } as const;

  test("a reviewed dataset without the ruleset is missing it, and one with it is not", async () => {
    envOverrides = requirementOn;
    seedDataset("nm000401");
    seedDataset("nm000402");
    await ensureReviewRuleset("nm000402", PAT);

    const r = await drift();

    expect(r.status).toBe(200);
    expect(r.body.buckets.REVIEW_RULESET_MISSING).toEqual(["nm000401"]);
    expect(r.body.buckets.REVIEW_RULESET_STRAY).toBeUndefined();
  });

  test("a dataset the Worker does not review is stray when its repository still has the ruleset", async () => {
    seedDataset("nm000403", { visibility: "private" });
    await ensureReviewRuleset("nm000403", PAT);
    seedDataset("nm000404", { visibility: "private" });

    const r = await drift();

    expect(r.body.buckets.REVIEW_RULESET_STRAY).toEqual(["nm000403"]);
    expect(r.body.buckets.REVIEW_RULESET_MISSING).toBeUndefined();
  });

  test.each<[string, Partial<Bindings>]>([
    ["the review is off", { PR_REVIEW_ENABLED: undefined, PR_REVIEW_AUTO_REQUIRE: "1" }],
    ["the owner's switch is off", { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: undefined }],
    ["both are off", { PR_REVIEW_ENABLED: undefined, PR_REVIEW_AUTO_REQUIRE: undefined }],
    [
      "the owner's switch is not exactly 1",
      { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "true" },
    ],
  ])("while %s nothing is missing, but a stray ruleset still is", async (_name, overrides) => {
    seedDataset("nm000401");
    seedDataset("nm000403", { visibility: "private" });
    await ensureReviewRuleset("nm000403", PAT);
    envOverrides = overrides;

    const r = await drift();

    expect(r.body.buckets.REVIEW_RULESET_MISSING).toBeUndefined();
    expect(r.body.buckets.REVIEW_RULESET_STRAY).toEqual(["nm000403"]);
  });

  test("right after a deploy, with the owner's switch off, no reviewed dataset is reported missing the ruleset", async () => {
    // The review has run since the deploy, and not one repository has been asked to require it:
    // that every reviewed public dataset lacks the ruleset is the state nobody has changed yet.
    for (let n = 1; n <= 5; n++) seedDataset(`nm00050${n}`);
    envOverrides = { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: undefined };

    const r = await drift();

    expect(r.status).toBe(200);
    expect(r.body.buckets.REVIEW_RULESET_MISSING).toBeUndefined();
    expect(r.body.buckets.REVIEW_RULESET_STRAY).toBeUndefined();
    // Not a report that saw nothing: it scanned the five repositories.
    expect(r.body.scanned).toBe(5);
    // With the switch on, the same five are every one of them missing it.
    envOverrides = requirementOn;
    const on = await drift();
    expect(on.body.buckets.REVIEW_RULESET_MISSING).toHaveLength(5);
  });

  test("a ruleset that was switched off by hand counts as missing", async () => {
    envOverrides = requirementOn;
    seedDataset("nm000401");
    await ensureReviewRuleset("nm000401", PAT);
    const held = standIn.rulesets.get("nm000401")?.[0];
    if (!held) throw new Error("the ruleset was not created");
    held.body = { ...held.body, enforcement: "disabled" };

    const r = await drift();

    expect(r.body.buckets.REVIEW_RULESET_MISSING).toEqual(["nm000401"]);
  });

  // Both the branch-ruleset read and the review-ruleset read list the repository's own rulesets,
  // with the same URL, so the review read is told by the count: one list request when the review
  // ruleset is not asked about, two when it is.
  const listRequests = (id: string) =>
    standIn.calls.filter(
      (c) =>
        c.method === "GET" &&
        c.path === `/repos/nemarDatasets/${id}/rulesets` &&
        c.search === "?includes_parents=false",
    );

  test("a repository GitHub cannot answer for is not reported missing, so an outage is not a finding", async () => {
    seedDataset("nm000401");

    // The requirement is not the target, so the review ruleset is not even read.
    envOverrides = { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: undefined };
    await drift();
    expect(listRequests("nm000401")).toHaveLength(1);

    // With the requirement the target the review read is made, and a ruleset that is not there is
    // a finding. This is what an outage must not be taken for.
    envOverrides = requirementOn;
    standIn.calls.length = 0;
    const answered = await drift();
    expect(listRequests("nm000401")).toHaveLength(2);
    expect(answered.body.buckets.REVIEW_RULESET_MISSING).toEqual(["nm000401"]);

    // GitHub refuses every list: the review read is made, fails, and reports nothing.
    standIn.failNext("GET", /\/repos\/nemarDatasets\/nm000401\/rulesets$/, 403, 100);
    standIn.calls.length = 0;
    const refused = await drift();

    expect(refused.status).toBe(200);
    expect(refused.body.scanned).toBe(1);
    expect(listRequests("nm000401")).toHaveLength(2);
    expect(refused.body.buckets.REVIEW_RULESET_MISSING).toBeUndefined();
    expect(refused.body.buckets.REVIEW_RULESET_STRAY).toBeUndefined();
  });

  test("and a ruleset on a repository GitHub cannot answer for is not called stray either", async () => {
    // A dataset the Worker does not review calls for a removal whatever the switches say, so its
    // ruleset is read with the requirement not the target as well.
    seedDataset("nm000403", { visibility: "private" });
    await ensureReviewRuleset("nm000403", PAT);
    standIn.calls.length = 0;
    const answered = await drift();
    expect(listRequests("nm000403")).toHaveLength(2);
    expect(answered.body.buckets.REVIEW_RULESET_STRAY).toEqual(["nm000403"]);

    standIn.failNext("GET", /\/repos\/nemarDatasets\/nm000403\/rulesets$/, 403, 100);
    standIn.calls.length = 0;
    const refused = await drift();

    expect(refused.status).toBe(200);
    expect(refused.body.scanned).toBe(1);
    expect(listRequests("nm000403")).toHaveLength(2);
    expect(refused.body.buckets.REVIEW_RULESET_STRAY).toBeUndefined();
    expect(refused.body.buckets.REVIEW_RULESET_MISSING).toBeUndefined();
  });
});
