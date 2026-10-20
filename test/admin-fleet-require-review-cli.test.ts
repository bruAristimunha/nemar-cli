/**
 * `nemar admin fleet require-review` (ADR 0107): put the "NEMAR PR review required" ruleset on the
 * datasets the automated review covers, and take it off the rest. Driven through the real entry
 * point (`bun run src/index.ts ...`) like its sibling suites.
 *
 * The NEMAR API is the REAL admin router over bun:sqlite with every migration applied, served on a
 * local port and reached through TEST_API_URL, with the account a real hashed key. GitHub is a
 * stateful `Bun.serve()` stand-in (backend/test/helpers/github-rulesets.ts) that holds each
 * repository's rulesets, so what is asserted is what a repository holds afterwards. Isolated
 * NEMAR_CONFIG_DIR, no mocks.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { isValidDatasetId } from "../backend/src/services/datasetId";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import {
  REVIEW_APP_BINDINGS,
  type RulesetStandIn,
  dropStandInAppToken,
  seedStandInAppToken,
  startRulesetStandIn,
} from "../backend/test/helpers/github-rulesets";
import { makePrQueueApp } from "../backend/test/helpers/pr-queue-app";
import { isBoundedDatasetId, isDatasetIdPrefix } from "../src/lib/admin-command";

setDefaultTimeout(30_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const OWNER_KEY = "cli-review-owner-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "cli-review-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "cli-review-member-key-0123456789abcdef0123456789abcdef";
const REVIEW_RULESET = "NEMAR PR review required";
const PAT = "ghp_cli_review_ruleset";

let standIn: RulesetStandIn;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
let envOverrides: Partial<Bindings> = {};
let handle: ReturnType<typeof makePrQueueApp>;
/** The review-ruleset requests the Worker received, so a test can say that none was sent. */
const sent: string[] = [];

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

beforeAll(() => {
  standIn = startRulesetStandIn();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standIn.url;
  // The Worker signs in as the App (see REVIEW_APP_BINDINGS), and this is the token it finds.
  seedStandInAppToken(PAT);
  handle = makePrQueueApp();
  apiServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.includes("review-ruleset")) sent.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      return handle(req, env());
    },
  });
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  dropStandInAppToken();
  apiServer.stop(true);
  standIn.stop();
});

async function seedAccount(username: string, role: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (?, ?, 'x', ?, 'approved', ?, 'cli', 1, 1)`,
    [username, `${username}@example.org`, `${username}-gh`, role],
  );
  const row = db.query("SELECT id FROM users WHERE username = ?").get(username) as { id: number };
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return row.id;
}

let ownerId = 0;

function seedDataset(
  id: string,
  o: { visibility?: string; first_published_at?: string | null } = {},
): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo,
                           status, visibility, anonymous, first_published_at)
     VALUES (?, ?, ?, 0, ?, 'active', ?, 0, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      ownerId,
      `nemarDatasets/${id}`,
      o.visibility ?? "public",
      o.first_published_at === undefined ? "2026-01-01 00:00:00" : o.first_published_at,
    ],
  );
}

function writeConfig(dir: string, account: string, key: string): void {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ activeAccount: account, accounts: { [account]: { apiKey: key } } }),
  );
}

beforeEach(async () => {
  db = freshDb();
  sent.length = 0;
  standIn.reset();
  envOverrides = {};
  configDir = mkdtempSync(join(tmpdir(), "nemar-review-ruleset-cli-"));
  ownerId = await seedAccount("cliowner", "owner", OWNER_KEY);
  await seedAccount("cliadmin", "admin", ADMIN_KEY);
  writeConfig(configDir, "cliowner", OWNER_KEY);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function cli(
  args: string[],
  dir = configDir,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: dir,
    TEST_API_URL: `http://127.0.0.1:${apiServer.port}`,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(childEnv)) if (v !== undefined) clean[k] = v;
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, "admin", "fleet", "require-review", ...args],
    cwd: REPO_ROOT,
    env: clean,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

const held = (repo: string) => (standIn.rulesets.get(repo) ?? []).map((r) => r.name);

describe("one dataset", () => {
  test("a dry run says what it would do, prints the body with its three bypass actors, and changes nothing", async () => {
    seedDataset("nm000201");

    const r = await cli(["nm000201"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[dry run] would create");
    expect(r.stdout).toContain("nm000201");
    expect(r.stdout).toContain("The body that would be sent to GitHub");
    expect(r.stdout).toContain('"actor_type": "Integration"');
    expect(r.stdout).toContain('"actor_type": "OrganizationAdmin"');
    expect(r.stdout).toContain('"actor_type": "RepositoryRole"');
    expect(r.stdout).toContain('"context": "NEMAR PR Review"');
    expect(r.stdout).toContain("Dry run: nothing was changed. Add --apply to change it.");
    expect(standIn.writes()).toHaveLength(0);
    expect(held("nm000201")).toEqual([]);
  });

  test("--apply puts the ruleset on the repository and says so", async () => {
    seedDataset("nm000201");

    const r = await cli(["nm000201", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("created");
    expect(r.stdout).toContain("Done.");
    expect(r.stdout).not.toContain("Dry run");
    expect(held("nm000201")).toEqual([REVIEW_RULESET]);
  });

  test("a dataset the review does not cover has the ruleset taken off, and the reason is said", async () => {
    seedDataset("nm000202", { visibility: "private" });
    // A ruleset left behind by a dataset that has since gone private.
    standIn.rulesets.set("nm000202", [
      {
        id: 4242,
        name: REVIEW_RULESET,
        source_type: "Repository",
        body: { name: REVIEW_RULESET, target: "branch", enforcement: "active", rules: [] },
      },
    ]);

    const r = await cli(["nm000202", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("removed");
    expect(r.stdout).toContain("not reviewed: private");
    expect(held("nm000202")).toEqual([]);
  });

  test("--json prints the Worker's answer and nothing else", async () => {
    seedDataset("nm000201");

    const r = await cli(["nm000201", "--json"]);

    expect(r.exitCode).toBe(0);
    const answer = JSON.parse(r.stdout);
    expect(answer).toMatchObject({
      dataset_id: "nm000201",
      dry_run: true,
      review_enabled: true,
      auto_require: false,
      intent: "require",
      action: "create",
      applied: false,
    });
    expect(answer.payload.bypass_actors).toHaveLength(3);
  });

  test("--remove --apply is the rollback", async () => {
    seedDataset("nm000201");
    await cli(["nm000201", "--apply"]);
    expect(held("nm000201")).toEqual([REVIEW_RULESET]);

    const r = await cli(["nm000201", "--remove", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("removed");
    expect(held("nm000201")).toEqual([]);
  });

  test("with the review off, --apply is refused in the Worker's words and exits 1; --remove --apply is not", async () => {
    seedDataset("nm000201");
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    const refused = await cli(["nm000201", "--apply"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout + refused.stderr).toContain("PR_REVIEW_ENABLED");
    // One dataset, refused: the whole request changed nothing, and that is said.
    expect(refused.stdout + refused.stderr).toContain("Nothing was changed.");
    expect(standIn.writes()).toHaveLength(0);

    const dry = await cli(["nm000201"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("--apply would be refused");

    // Taking it off is not refused for that reason, even where there is nothing to take off.
    const off = await cli(["nm000201", "--remove", "--apply"]);
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toContain("nothing to remove");
  });

  test("with the review off a dataset the Worker does not review is not refused: it is a removal", async () => {
    seedDataset("nm000202", { visibility: "private" });
    standIn.rulesets.set("nm000202", [
      {
        id: 4244,
        name: REVIEW_RULESET,
        source_type: "Repository",
        body: { name: REVIEW_RULESET, target: "branch", enforcement: "active", rules: [] },
      },
    ]);
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    // The dry run does not say --apply would be refused, because it would not be.
    const dry = await cli(["nm000202"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("would remove");
    expect(dry.stdout).not.toContain("would be refused");

    const applied = await cli(["nm000202", "--apply"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("removed");
    expect(held("nm000202")).toEqual([]);
  });

  test("with --json a refusal goes to standard error and standard output stays empty", async () => {
    seedDataset("nm000201");
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    const r = await cli(["nm000201", "--apply", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("PR_REVIEW_ENABLED");
  });

  test("a GitHub failure on one dataset says what failed, with the status, and not the generic title", async () => {
    seedDataset("nm000201");
    standIn.failNext("POST", /\/rulesets$/, 422);

    const r = await cli(["nm000201", "--apply"]);

    expect(r.exitCode).toBe(1);
    const said = r.stdout + r.stderr;
    expect(said).toContain(
      "GitHub refused the request for nm000201 (HTTP 422). Nothing was changed for this dataset.",
    );
    expect(said).not.toContain("Review ruleset request failed");
    expect(said).not.toContain("refused by the stand-in");
    expect(held("nm000201")).toEqual([]);
  });

  test("with --json the failure is on standard error, as a sentence, and standard output stays empty", async () => {
    seedDataset("nm000201");
    standIn.failNext("POST", /\/rulesets$/, 422);

    const r = await cli(["nm000201", "--apply", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("GitHub refused the request for nm000201 (HTTP 422)");
  });

  test("a standing fixture is refused and exits 1", async () => {
    seedDataset("nm099999");

    const r = await cli(["nm099999", "--apply"]);

    expect(r.exitCode).toBe(1);
    const said = r.stdout + r.stderr;
    expect(said).toContain("standing test fixture");
    // It is the dataset that refuses, not a lack of privileges: the hint for a 403 is not printed.
    expect(said).not.toContain("requires admin privileges");
    expect(standIn.calls).toHaveLength(0);
  });

  test("a repository on another default branch is skipped, said so, and nothing is written", async () => {
    seedDataset("nm000201");
    standIn.defaultBranches.set("nm000201", "master");

    const r = await cli(["nm000201", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("skipped");
    expect(r.stdout).toContain("default branch is master, not main");
    expect(r.stdout).toContain("the default branch has to be main first");
    expect(standIn.rulesetWrites()).toHaveLength(0);

    // A dry run does not suggest that --apply would change it.
    const dry = await cli(["nm000201"]);
    expect(dry.stdout).toContain("would skip");
    expect(dry.stdout).toContain("the default branch has to be main first");
    expect(dry.stdout).not.toContain("Add --apply");
  });
});

// The ruleset requires the check from the GitHub App with id 3679074, and the Worker posts it as the
// App whose id is its GITHUB_APP_ID. They have to be the same or the check never arrives, so the
// dry run prints both and a live requirement is refused when they differ.
describe("the GitHub App the ruleset requires the check from", () => {
  test("a dry run prints both ids, and that they agree", async () => {
    seedDataset("nm000201");

    const r = await cli(["nm000201"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "GitHub App: this Worker posts the check as App 3679074, the App the ruleset requires it from.",
    );
    expect(r.stdout).not.toContain("would be refused");
  });

  test("a dry run on a Worker with another App prints both ids and says --apply would be refused", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_ID: "1234567" };

    const r = await cli(["nm000201"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("this Worker posts the check as App 1234567");
    expect(r.stdout).toContain("the ruleset requires it from App 3679074");
    expect(r.stdout).toContain("--apply would be refused");
    expect(standIn.writes()).toHaveLength(0);
  });

  // An unset binding, a value that is not an id and another App are three different things to fix,
  // and the Worker's answer used to leave the first two both as a null id.
  test("a dry run says which of three things is wrong with GITHUB_APP_ID: unset, not a number, or another App", async () => {
    seedDataset("nm000201");
    const dryRun = async (value: string | undefined) => {
      envOverrides = { GITHUB_APP_ID: value };
      const r = await cli(["nm000201"]);
      expect(r.exitCode).toBe(0);
      return r.stdout;
    };

    const unset = await dryRun(undefined);
    expect(unset).toContain("this Worker posts the check as no App (GITHUB_APP_ID is not set)");
    expect(unset).not.toContain("plain number");
    expect(unset).toContain("--apply would be refused");

    const pasted = await dryRun("-----BEGIN PRIVATE KEY-----");
    expect(pasted).toContain(
      "this Worker posts the check as an App whose id is not a number (GITHUB_APP_ID is set but is not a plain number)",
    );
    expect(pasted).not.toContain("is not set");
    expect(pasted).not.toContain("PRIVATE KEY");
    expect(pasted).toContain("--apply would be refused");

    const other = await dryRun("1234567");
    expect(other).toContain("this Worker posts the check as App 1234567");
    expect(other).not.toContain("is not set");
    expect(other).not.toContain("plain number");
    expect(standIn.writes()).toHaveLength(0);
  });

  test("--apply is refused naming the right one of the three, and writes nothing", async () => {
    seedDataset("nm000201");

    envOverrides = { GITHUB_APP_ID: undefined };
    const unset = await cli(["nm000201", "--apply"]);
    envOverrides = { GITHUB_APP_ID: "-----BEGIN PRIVATE KEY-----" };
    const pasted = await cli(["nm000201", "--apply"]);

    expect(unset.exitCode).toBe(1);
    expect(unset.stdout + unset.stderr).toContain("GITHUB_APP_ID is not set");
    expect(unset.stdout + unset.stderr).not.toContain("plain number");
    expect(pasted.exitCode).toBe(1);
    expect(pasted.stdout + pasted.stderr).toContain(
      "GITHUB_APP_ID is set but is not a plain number",
    );
    expect(pasted.stdout + pasted.stderr).not.toContain("is not set");
    expect(pasted.stdout + pasted.stderr).not.toContain("PRIVATE KEY");
    expect(standIn.calls).toHaveLength(0);
  });

  test("--apply is refused in a sentence that names both ids, and exits 1 with nothing written", async () => {
    seedDataset("nm000201");
    envOverrides = { GITHUB_APP_ID: "1234567" };

    const r = await cli(["nm000201", "--apply"]);

    expect(r.exitCode).toBe(1);
    const said = r.stdout + r.stderr;
    expect(said).toContain("3679074");
    expect(said).toContain("1234567");
    expect(said).toContain("would never arrive");
    expect(said).toContain("Nothing was changed.");
    expect(standIn.calls).toHaveLength(0);
  });

  test("--remove --apply is not refused by it", async () => {
    seedDataset("nm000201");
    standIn.rulesets.set("nm000201", [
      {
        id: 4245,
        name: REVIEW_RULESET,
        source_type: "Repository",
        body: { name: REVIEW_RULESET, target: "branch", enforcement: "active", rules: [] },
      },
    ]);
    envOverrides = { GITHUB_APP_ID: "1234567" };

    const r = await cli(["nm000201", "--remove", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("removed");
    expect(held("nm000201")).toEqual([]);
  });

  test("a live page says each refused row in a line and explains the refusal once", async () => {
    for (const id of ["nm000301", "nm000302", "nm000303"]) seedDataset(id);
    envOverrides = { GITHUB_APP_ID: "1234567" };

    const r = await cli(["--all", "--prefix", "nm", "--apply"]);

    expect(r.exitCode).toBe(1);
    for (const id of ["nm000301", "nm000302", "nm000303"]) {
      expect(r.stdout).toMatch(new RegExp(`error\\s+${id}: refused: this Worker posts the check`));
    }
    // The long sentence is there once, however many rows it refused.
    expect(r.stdout.split("would never arrive")).toHaveLength(2);
    expect(r.stdout).toContain("3679074");
    expect(r.stdout).toContain("1234567");
    // A page is not one request to one dataset: its sentence does not say what was changed.
    expect(r.stdout).not.toContain("Nothing was changed");
    expect(standIn.calls).toHaveLength(0);
  });

  // The right id is not enough. The check is posted with an installation token for nemarDatasets,
  // and a Worker without the App's private key or that installation id would post with a personal
  // access token, which GitHub does not let post a check run.
  describe("the right id and no way to sign in as the App", () => {
    const WITHOUT: Array<[string, Partial<Bindings>]> = [
      ["no private key", { GITHUB_APP_PRIVATE_KEY: undefined }],
      ["no installation id", { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined }],
    ];

    test.each(WITHOUT)(
      "a dry run says so and that --apply would be refused (%s)",
      async (_n, config) => {
        seedDataset("nm000201");
        envOverrides = config;

        const r = await cli(["nm000201"]);

        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain(
          "this Worker is set to App 3679074, the App the ruleset requires it from, but it cannot sign in as that App for nemarDatasets",
        );
        expect(r.stdout).toContain(
          "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS",
        );
        expect(r.stdout).toContain("personal access token");
        expect(r.stdout).toContain("--apply would be refused");
        // The id is right, so the line that says the Worker posts as the right App is not printed.
        expect(r.stdout).not.toContain("this Worker posts the check as App 3679074");
        expect(standIn.writes()).toHaveLength(0);
      },
    );

    test("--apply is refused in a plain sentence, and exits 1 with nothing written", async () => {
      seedDataset("nm000201");
      envOverrides = { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined };

      const r = await cli(["nm000201", "--apply"]);

      expect(r.exitCode).toBe(1);
      const said = r.stdout + r.stderr;
      expect(said).toContain("cannot sign in as the GitHub App for the nemarDatasets organization");
      expect(said).toContain("personal access token");
      expect(said).toContain("Nothing was changed");
      expect(standIn.calls).toHaveLength(0);
    });

    test("--remove --apply is not refused by it", async () => {
      seedDataset("nm000201");
      standIn.rulesets.set("nm000201", [
        {
          id: 4246,
          name: REVIEW_RULESET,
          source_type: "Repository",
          body: { name: REVIEW_RULESET, target: "branch", enforcement: "active", rules: [] },
        },
      ]);
      envOverrides = { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined };

      const r = await cli(["nm000201", "--remove", "--apply"]);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("removed");
      expect(held("nm000201")).toEqual([]);
    });

    test("a live page says each refused row in a line and explains the refusal once", async () => {
      for (const id of ["nm000301", "nm000302", "nm000303"]) seedDataset(id);
      envOverrides = { GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined };

      const r = await cli(["--all", "--prefix", "nm", "--apply"]);

      expect(r.exitCode).toBe(1);
      for (const id of ["nm000301", "nm000302", "nm000303"]) {
        expect(r.stdout).toMatch(
          new RegExp(`error\\s+${id}: refused: this Worker cannot sign in as the GitHub App`),
        );
      }
      // The long sentence is there once, however many rows it refused.
      expect(
        r.stdout.split("cannot sign in as the GitHub App for the nemarDatasets organization"),
      ).toHaveLength(2);
      expect(r.stdout).not.toContain("Nothing was changed");
      expect(standIn.calls).toHaveLength(0);
    });

    test("a dry run of a page says it too", async () => {
      seedDataset("nm000301");
      envOverrides = { GITHUB_APP_PRIVATE_KEY: undefined };

      const r = await cli(["--all", "--prefix", "nm"]);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("it cannot sign in as that App for nemarDatasets");
      expect(r.stdout).toContain("--apply would be refused");
    });
  });

  test("a dry run of a page prints both ids", async () => {
    seedDataset("nm000301");
    envOverrides = { GITHUB_APP_ID: "1234567" };

    const r = await cli(["--all", "--prefix", "nm"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("this Worker posts the check as App 1234567");
    expect(r.stdout).toContain("the ruleset requires it from App 3679074");
  });
});

describe("a page of datasets", () => {
  function seedFleet(): void {
    for (const id of ["nm000301", "nm000302", "nm000303", "nm000304", "nm000305"]) seedDataset(id);
    seedDataset("nm000306", { visibility: "private" });
    seedDataset("on000307");
  }

  test("a dry run lists each dataset, tallies them, and names the next page", async () => {
    seedFleet();

    const r = await cli(["--all", "--prefix", "nm", "--limit", "3"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[dry run] 3 dataset(s) (nm000301 to nm000303)");
    expect(r.stdout).toMatch(/would create\s+nm000301/);
    expect(r.stdout).toMatch(/would create\s+nm000303/);
    expect(r.stdout).toContain("3 would create");
    expect(r.stdout).toContain(
      "Next page: nemar admin fleet require-review --all --prefix nm --limit 3 --after nm000303",
    );
    expect(standIn.writes()).toHaveLength(0);
  });

  test("--apply works through the pages with --after, and the last page names no next one", async () => {
    seedFleet();

    const first = await cli(["--all", "--prefix", "nm", "--limit", "4", "--apply"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("4 created");
    expect(first.stdout).toContain("--after nm000304 --apply");
    expect(held("nm000304")).toEqual([REVIEW_RULESET]);
    expect(held("nm000305")).toEqual([]);

    const second = await cli([
      "--all",
      "--prefix",
      "nm",
      "--limit",
      "4",
      "--after",
      "nm000304",
      "--apply",
    ]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("1 created");
    expect(second.stdout).toMatch(/nothing to remove\s+nm000306/);
    expect(second.stdout).toContain("not reviewed: private");
    expect(second.stdout).not.toContain("Next page");
    expect(held("nm000305")).toEqual([REVIEW_RULESET]);
    expect(held("nm000306")).toEqual([]);
    // The other prefix was not asked about.
    expect(held("on000307")).toEqual([]);
  });

  test("the fixture band is not in a page", async () => {
    seedDataset("nm099899");
    seedDataset("nm099998");
    seedDataset("nm099999");

    const r = await cli(["--all", "--prefix", "nm", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm099899");
    expect(r.stdout).not.toContain("nm099998");
    expect(r.stdout).not.toContain("nm099999");
    expect(held("nm099998")).toEqual([]);
    expect(held("nm099999")).toEqual([]);
  });

  test("an administrator is refused, and told the bulk apply is owner-only and not that admin privileges are needed", async () => {
    seedFleet();
    const adminDir = mkdtempSync(join(tmpdir(), "nemar-review-ruleset-cli-admin-"));
    try {
      writeConfig(adminDir, "cliadmin", ADMIN_KEY);

      const r = await cli(["--all", "--prefix", "nm"], adminDir);

      expect(r.exitCode).toBe(1);
      const said = r.stdout + r.stderr;
      expect(said).toContain("Only the NEMAR owner can bulk-apply the review ruleset");
      expect(said).toContain("The bulk apply is owner-only");
      // They are an administrator: the generic 403 line would be wrong.
      expect(said).not.toContain("requires admin privileges");
      expect(said).toContain("nemar admin fleet require-review <dataset-id>");
      expect(standIn.calls).toHaveLength(0);
    } finally {
      rmSync(adminDir, { recursive: true, force: true });
    }
  });

  test("a member refused on one dataset keeps the line that says what is needed", async () => {
    seedDataset("nm000201");
    await seedAccount("climember", "member", MEMBER_KEY);
    const memberDir = mkdtempSync(join(tmpdir(), "nemar-review-ruleset-cli-member-"));
    try {
      writeConfig(memberDir, "climember", MEMBER_KEY);

      const r = await cli(["nm000201", "--apply"], memberDir);

      expect(r.exitCode).toBe(1);
      const said = r.stdout + r.stderr;
      expect(said).toContain("requires admin privileges");
      expect(said).not.toContain("owner-only");
      expect(standIn.calls).toHaveLength(0);
    } finally {
      rmSync(memberDir, { recursive: true, force: true });
    }
  });

  test("a dataset that fails is an error row, the others are done, and the exit code is 1", async () => {
    seedFleet();
    standIn.failNext("GET", /\/repos\/nemarDatasets\/nm000302\/rulesets$/, 403);

    const r = await cli(["--all", "--prefix", "nm", "--limit", "3", "--apply"]);

    expect(r.exitCode).toBe(1);
    // A sentence with the status, on its row. GitHub's own body (its JSON, here "refused by the
    // stand-in") and the name of the function that threw are not printed.
    expect(r.stdout).toMatch(
      /error\s+nm000302: GitHub refused the request for nm000302 \(HTTP 403\)\. Nothing was changed/,
    );
    expect(r.stdout + r.stderr).not.toContain("refused by the stand-in");
    expect(r.stdout + r.stderr).not.toContain("Review ruleset list failed");
    expect(r.stdout + r.stderr).not.toContain("{");
    expect(held("nm000301")).toEqual([REVIEW_RULESET]);
    expect(held("nm000303")).toEqual([REVIEW_RULESET]);
    expect(held("nm000302")).toEqual([]);
  });

  test("--json prints the page as the Worker answered it", async () => {
    seedFleet();

    const r = await cli(["--all", "--prefix", "nm", "--limit", "2", "--json"]);

    expect(r.exitCode).toBe(0);
    const answer = JSON.parse(r.stdout);
    expect(answer).toMatchObject({ dry_run: true, limit: 2, count: 2, next_after: "nm000302" });
    expect(answer.results.map((x: { dataset_id: string }) => x.dataset_id)).toEqual([
      "nm000301",
      "nm000302",
    ]);
    expect(answer.payload.name).toBe(REVIEW_RULESET);
  });

  test("with the review off a live page refuses the datasets that would get the ruleset, row by row, and still takes it off the rest", async () => {
    seedFleet();
    // A ruleset left on the dataset that is now private.
    standIn.rulesets.set("nm000306", [
      {
        id: 4243,
        name: REVIEW_RULESET,
        source_type: "Repository",
        body: { name: REVIEW_RULESET, target: "branch", enforcement: "active", rules: [] },
      },
    ]);
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    const r = await cli(["--all", "--prefix", "nm", "--apply"]);

    // Five rows were refused, so the exit code says the run is not done.
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/error\s+nm000301: .*PR_REVIEW_ENABLED/);
    expect(r.stdout).toMatch(/error\s+nm000305: .*PR_REVIEW_ENABLED/);
    expect(r.stdout).toContain("5 error");
    // The private dataset is a removal, and the review being off did not stop it.
    expect(r.stdout).toMatch(/removed\s+nm000306/);
    expect(r.stdout).toContain("1 removed");
    expect(held("nm000306")).toEqual([]);
    // The page changed something, so it must not go on to say that nothing was changed. The
    // refusal is explained once, after the tally, in a plain sentence of the Worker's.
    expect(r.stdout).toContain("5 error, 1 removed");
    expect(r.stdout).not.toContain("Nothing was changed");
    expect(r.stdout).not.toContain("neither remove");
    const explained = r.stdout.split("Taking the ruleset off is never refused");
    expect(explained).toHaveLength(2);
    expect(r.stdout.indexOf("Taking the ruleset off is never refused")).toBeGreaterThan(
      r.stdout.indexOf("5 error, 1 removed"),
    );
    for (const id of ["nm000301", "nm000302", "nm000303", "nm000304", "nm000305"]) {
      expect(held(id), id).toEqual([]);
      expect(
        standIn.calls.filter((c) => c.path.includes(`/repos/nemarDatasets/${id}`)),
        id,
      ).toHaveLength(0);
    }
  });

  test("with the review off a dry run warns only when something on the page would be refused", async () => {
    seedFleet();
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    const mixed = await cli(["--all", "--prefix", "nm"]);
    expect(mixed.exitCode).toBe(0);
    expect(mixed.stdout).toContain(
      "--apply would refuse the 5 dataset(s) that would get the ruleset",
    );

    // Only a dataset the Worker does not review: it is all removals, and nothing would be refused.
    db.run("DELETE FROM datasets WHERE dataset_id != 'nm000306'");
    const removalsOnly = await cli(["--all", "--prefix", "nm"]);
    expect(removalsOnly.exitCode).toBe(0);
    expect(removalsOnly.stdout).not.toContain("would be refused");
    expect(removalsOnly.stdout).not.toContain("--apply would refuse");
  });
});

describe("what is asked for is checked before anything is sent", () => {
  test.each([
    [[], "Name a dataset, or use --all"],
    [["nm000201", "--all"], "Name a dataset OR use --all"],
    [["nm000201", "--prefix", "nm"], "go with --all"],
    [["nm000201", "--after", "nm000100"], "go with --all"],
    [["nm000201", "--limit", "5"], "go with --all"],
    [["--all", "--limit", "51"], "from 1 to 50"],
    [["--all", "--limit", "0"], "from 1 to 50"],
    [["--all", "--limit", "ten"], "from 1 to 50"],
    [["nm20"], "is not a dataset id"],
  ])("%j exits 1 and says %j", async (args, words) => {
    const r = await cli(args as string[]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain(words);
    expect(standIn.calls).toHaveLength(0);
  });

  // The Worker refuses a bad prefix or id with a validation object, which the CLI would print as
  // "[object Object]". Both are checked here first, in a sentence, and nothing is sent.
  test.each<[string[], string]>([
    [["--all", "--prefix", "NM"], "is not a dataset id prefix"],
    [["--all", "--prefix", "n"], "is not a dataset id prefix"],
    [["--all", "--prefix", "nm1234567"], "is not a dataset id prefix"],
    [["--all", "--prefix", "nm%"], "is not a dataset id prefix"],
    [["--all", "--prefix", "../"], "is not a dataset id prefix"],
    [["--all", "--prefix", ""], "is not a dataset id prefix"],
    [["--all", "--after", "nm0003"], "is not a dataset id"],
    [["--all", "--after", "NM000312"], "is not a dataset id"],
    [["--all", "--after", "nm100000"], "is not a dataset id"],
    [["--all", "--after", ""], "is not a dataset id"],
    [["--all", "--after", "nm000312 "], "is not a dataset id"],
  ])("%j exits 1, says %j, and sends nothing", async (args, words) => {
    const r = await cli(args);

    expect(r.exitCode).toBe(1);
    const said = r.stdout + r.stderr;
    expect(said).toContain(words);
    expect(said).not.toContain("[object Object]");
    expect(sent).toEqual([]);
    expect(standIn.calls).toHaveLength(0);
  });

  test("the refusal of a prefix says what a prefix is, and the one of --after says what it takes", async () => {
    const prefix = await cli(["--all", "--prefix", "NM"]);
    expect(prefix.stdout + prefix.stderr).toContain(
      '"NM" is not a dataset id prefix: use two lowercase letters, then up to six digits (like nm or nm0001).',
    );
    const after = await cli(["--all", "--after", "nm0003"]);
    expect(after.stdout + after.stderr).toContain(
      '"nm0003" is not a dataset id (like nm000312). --after takes the last id of the previous page.',
    );
  });

  test("with --json a refused prefix goes to standard error and standard output stays empty", async () => {
    const r = await cli(["--all", "--prefix", "NM", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("is not a dataset id prefix");
  });

  test("a prefix and an id that are right are sent", async () => {
    seedDataset("nm000401");
    seedDataset("nm000402");

    const r = await cli(["--all", "--prefix", "nm0004", "--after", "nm000401"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000402");
    expect(r.stdout).not.toContain("nm000401 ");
    expect(sent).toEqual(["POST /admin/datasets/review-ruleset/bulk"]);
  });

  test("--prefix and --after without --all are refused even when empty", async () => {
    for (const args of [
      ["nm000201", "--prefix", ""],
      ["nm000201", "--after", ""],
    ]) {
      const r = await cli(args);
      expect(r.exitCode, args.join(" ")).toBe(1);
      expect(r.stdout + r.stderr).toContain("go with --all");
    }
    expect(sent).toEqual([]);
  });

  test("the override the first design had is gone: --force-live is not an option", async () => {
    seedDataset("nm000103");

    const r = await cli(["nm000103", "--apply", "--force-live"]);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown option '--force-live'");
    expect(standIn.calls).toHaveLength(0);
  });

  test("a live dataset needs no override: nm000103 is an ordinary dataset", async () => {
    seedDataset("nm000103");

    const r = await cli(["nm000103", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(held("nm000103")).toEqual([REVIEW_RULESET]);
  });

  test("nobody signed in is told so and exits 1", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "nemar-review-ruleset-cli-empty-"));
    try {
      const r = await cli(["nm000201"], emptyDir);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("Not authenticated");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// The CLI cannot import the Worker's validators, so it states the same two rules itself. Two
// statements of one rule can drift, and the first sign of it would be a prefix the CLI sends and
// the Worker refuses as "[object Object]", or one the CLI refuses and the Worker would take. So the
// same table is put to both, the id rule to `isValidDatasetId` itself and the prefix rule to the
// real route.
describe("the checks the CLI makes are the Worker's own", () => {
  const PREFIXES = [
    "nm",
    "on",
    "xx",
    "zz",
    "nm0",
    "nm0001",
    "nm000108",
    "nm0000000",
    "nm1",
    "NM",
    "Nm",
    "n",
    "",
    "1m",
    "nm%",
    "n_",
    "../",
    "nm 1",
    "nm\n",
    "nm00010a",
  ];
  const IDS = [
    "nm000312",
    "on000001",
    "xx099999",
    "nm099999",
    "nm099900",
    "nm100000",
    "nm999999",
    "xx100000",
    "nm00031",
    "nm0003120",
    "NM000312",
    "ab000312",
    "zz000001",
    "",
    "nm00031x",
    " nm000312",
    "nm000312 ",
    "nm000312\n",
  ];

  test("an id is one to the CLI exactly when isValidDatasetId says so", () => {
    for (const id of IDS) {
      expect(isBoundedDatasetId(id), JSON.stringify(id)).toBe(isValidDatasetId(id));
    }
    // Not vacuous: both answers occur in the table.
    expect(IDS.filter(isValidDatasetId).length).toBeGreaterThan(0);
    expect(IDS.filter((id) => !isValidDatasetId(id)).length).toBeGreaterThan(0);
  });

  test("a prefix is one to the CLI exactly when the route takes it", async () => {
    let taken = 0;
    for (const prefix of PREFIXES) {
      const res = await fetch(
        `http://127.0.0.1:${apiServer.port}/admin/datasets/review-ruleset/bulk`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix }),
        },
      );
      expect(isDatasetIdPrefix(prefix), JSON.stringify(prefix)).toBe(res.status === 200);
      if (res.status === 200) taken++;
    }
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(PREFIXES.length);
  });
});
