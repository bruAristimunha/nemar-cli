/**
 * Every failure of `nemar admin publish` exits non-zero (#1581, ADR 0102 section 8).
 *
 * `list`, `deny`, `screen` and `approve` used to print what went wrong and exit 0 for most of it:
 * a refused approval, an API error, a missing key. A script that approved a dataset could not tell
 * that nothing had been approved. The table below drives each kind of failure through the real
 * command (`bun run src/index.ts ...`) against the real backend app (`helpers/admin-publish-cli.ts`),
 * so the exit code asserted is the code a person's shell would see, for a refusal the Worker
 * itself made.
 *
 * What a failure must also do is stop short of the write: every refusal here is checked for the
 * request the backend saw, because "exits 1 and approved anyway" is the worse bug.
 *
 * Mutation checks (each turns a named group red): drop `process.exitCode = 1` from `failWith`
 * (the API-error, refusal and run-failure rows); from `requireSignedIn` (the signed-out rows); from
 * the declined branch of `deny` or `approve` (the declined rows). Each `markReportedExit` call
 * guards the rows that end in it, and widening the 4xx rule of `failWith` to 5xx turns the
 * backend-500 rows red. Narrowing the answer rule (`isAnswered`) to 4xx turns the closed-word
 * rows red; counting `internal` as a word turns the `internal` row red. Removing the terminal
 * guard of `deny`'s reason prompt turns the no-terminal rows red, and dropping the dataset id check
 * of `deny` or `screen` turns the mistyped-id rows red.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { markScreen } from "../backend/test/helpers/identifier-screen";
import { seedScreenedRequest } from "../backend/test/helpers/publication-review";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import { seedGolden, seedUnstarted } from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const DATASET = "nm000460";
const ADMIN_KEY = "exit-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "exit-member-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

beforeEach(async () => {
  h.reset();
  await h.admin("exitadmin", ADMIN_KEY);
});

/** Everything the command printed. The spinner writes its verdict to standard error. */
const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

/**
 * The generic nudge the exit hook prints on a non-zero exit (src/index.ts). Where exit 1 is the
 * command's answer (not signed in, a refusal, a declined prompt) it is noise, and
 * `markReportedExit` suppresses it; where the Worker itself failed it stays, because that may be
 * a bug worth a report.
 */
const BUG_HINT = "attach the log to a new issue";

const posts = () => h.requests.filter((c) => c.method === "POST");

const requestStatus = (id: number) =>
  h.db
    .query<{ status: string }, [number]>("SELECT status FROM publication_requests WHERE id = ?")
    .get(id)?.status;

/** A dataset with no publication request at all. */
function seedDatasetOnly(): void {
  seedScreenedRequest(h.db, { datasetId: DATASET });
  h.db.run("DELETE FROM publication_requests");
}

const WHY = ["--reason", "Please add the participants file"];

/** The four commands, each with the arguments that get it past its own argument checks. */
const COMMANDS: ReadonlyArray<{ name: string; args: string[] }> = [
  { name: "list", args: ["admin", "publish", "list"] },
  { name: "deny", args: ["admin", "publish", "deny", DATASET, ...WHY, "--yes"] },
  { name: "screen", args: ["admin", "publish", "screen", DATASET] },
  { name: "approve", args: ["admin", "publish", "approve", DATASET, "--resume", "--yes"] },
];

describe("not signed in", () => {
  for (const { name, args } of COMMANDS) {
    test(`${name} says so, exits 1 and sends nothing`, async () => {
      seedGolden(h.db);
      const r = await h.cli(args, { signedOut: true });
      expect(r.exitCode).toBe(1);
      expect(output(r)).not.toContain(BUG_HINT);
      expect(r.stdout).toContain("Error: Not authenticated");
      expect(r.stdout).toContain("nemar auth login");
      expect(h.requests).toEqual([]);
    });
  }
});

describe("an API error", () => {
  // The dataset exists and nothing is waiting to be decided: the backend answers 404.
  // `screen` answers with its closed word (`not_found`) where the others answer with the sentence.
  const NOT_FOUND = {
    deny: "No active publication request found",
    screen: "not_found",
    approve: "No active publication request found",
  };
  for (const [name, says] of Object.entries(NOT_FOUND)) {
    test(`${name} of a dataset with no active request exits 1`, async () => {
      seedDatasetOnly();
      const args = COMMANDS.find((c) => c.name === name)?.args ?? [];
      const r = await h.cli(args);
      expect(r.exitCode).toBe(1);
      expect(output(r)).not.toContain(BUG_HINT);
      expect(output(r)).toContain(says);
      expect(h.requests.at(-1)?.status).toBe(404);
    });
  }

  // A fault of the Worker itself: the real route fails on a real read. `approve` is left out
  // because it retries a 5xx for a minute by design (the orchestrator's CLI-driven retry).
  for (const name of ["list", "deny", "screen"]) {
    test(`${name} exits 1 when the backend answers 500`, async () => {
      seedGolden(h.db);
      h.hookDb({
        statement(sql) {
          if (/FROM publication_requests/.test(sql)) throw new Error("simulated read failure");
        },
      });
      const args = COMMANDS.find((c) => c.name === name)?.args ?? [];
      const r = await h.cli(args);
      expect(r.exitCode).toBe(1);
      expect(h.requests.at(-1)?.status).toBe(500);
      // A fault of the Worker may be a bug, so the hint to file one stays.
      expect(output(r)).toContain(BUG_HINT);
    });
  }
});

describe("a key without the role (403)", () => {
  for (const { name, args } of COMMANDS) {
    test(`${name} exits 1 and does not change the request`, async () => {
      const requestId = seedGolden(h.db);
      await h.user("exitmember", "member", MEMBER_KEY);
      const r = await h.cli(args);
      expect(r.exitCode).toBe(1);
      expect(output(r)).not.toContain(BUG_HINT);
      expect(output(r)).toContain("This command requires admin privileges");
      expect(requestStatus(requestId)).toBe("requested");
      // Whatever the command sent was refused: no write got through.
      expect(posts().every((c) => c.status === 403)).toBe(true);
    });
  }
});

describe("a call the Worker refuses", () => {
  test("approve over a screen that did not run exits 1 and the request stays requested", async () => {
    const requestId = seedGolden(h.db);
    h.db.run("UPDATE publication_requests SET identifier_screen_status = 'error' WHERE id = ?", [
      requestId,
    ]);

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain(BUG_HINT);
    expect(output(r)).toContain("Identifier screen: DID NOT RUN");
    expect(requestStatus(requestId)).toBe("requested");
    expect(posts().map((c) => c.status)).toEqual([409]);
  });

  test("approve over a screen that found direct identifiers exits 1", async () => {
    const requestId = seedGolden(h.db);
    markScreen(h.db, requestId, DATASET, { status: "direct-identifiers" });

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain(BUG_HINT);
    expect(requestStatus(requestId)).toBe("requested");
  });

  test("approve of a screen whose commit is no longer main exits 1", async () => {
    const requestId = seedGolden(h.db);
    h.mainHead.value = "fedcba9876543210fedcba9876543210fedcba98";

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain(BUG_HINT);
    expect(output(r)).toContain("main is now at fedcba987654");
    expect(requestStatus(requestId)).toBe("requested");
  });

  test("approve exits 1 when the run itself fails at the CI check", async () => {
    // Not the golden path: no step is done, so the run starts at the validation step, which the
    // GitHub stand-in reports as failing. The Worker answers 422, which the CLI does not retry.
    const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });
    h.bidsConclusion.value = "failure";

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain(BUG_HINT);
    expect(output(r)).toContain("Fix the CI issues and retry with --resume");
    expect(requestStatus(requestId)).toBe("approving");
  });

  test("approve exits 1 for an acknowledgment that is too short, before it sends anything", async () => {
    seedGolden(h.db);

    const r = await h.cli([
      "admin",
      "publish",
      "approve",
      DATASET,
      "--resume",
      "--yes",
      "--acknowledge-identifier-screen",
      "short",
    ]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain(BUG_HINT);
    expect(r.stdout).toContain("--acknowledge-identifier-screen needs a reason of 10 to 500");
    expect(h.requests).toEqual([]);
  });

  test("deny with no reason exits 1 and sends nothing", async () => {
    const requestId = seedGolden(h.db);

    // The command asks for the reason on standard input; an empty line is no reason.
    const r = await h.cli(["admin", "publish", "deny", DATASET, "--yes"], { input: "\n" });

    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain(BUG_HINT);
    expect(r.stdout).toContain("Reason is required");
    expect(posts()).toEqual([]);
    expect(requestStatus(requestId)).toBe("requested");
  });
});

describe("a confirmation that is declined or cannot be asked", () => {
  const DECLINED: ReadonlyArray<{ name: string; args: string[] }> = [
    { name: "deny", args: ["admin", "publish", "deny", DATASET, ...WHY, "--no"] },
    { name: "approve", args: ["admin", "publish", "approve", DATASET, "--resume", "--no"] },
  ];
  for (const { name, args } of DECLINED) {
    test(`${name} --no exits 1, says Skipped and posts nothing`, async () => {
      const requestId = seedGolden(h.db);
      const r = await h.cli(args);
      expect(r.exitCode).toBe(1);
      expect(output(r)).not.toContain(BUG_HINT);
      expect(r.stdout).toContain("Skipped");
      expect(posts()).toEqual([]);
      expect(requestStatus(requestId)).toBe("requested");
    });
  }

  const UNASKED: ReadonlyArray<{ name: string; args: string[] }> = [
    { name: "deny", args: ["admin", "publish", "deny", DATASET, ...WHY] },
    { name: "approve", args: ["admin", "publish", "approve", DATASET, "--resume"] },
  ];
  for (const { name, args } of UNASKED) {
    test(`${name} with no terminal and no --yes exits 1 and posts nothing`, async () => {
      const requestId = seedGolden(h.db);
      const r = await h.cli(args);
      expect(r.exitCode).toBe(1);
      expect(output(r)).not.toContain(BUG_HINT);
      expect(r.stderr).toContain("Interactive prompt unavailable; use --yes or --no");
      expect(r.stdout).toContain("Cancelled");
      expect(posts()).toEqual([]);
      expect(requestStatus(requestId)).toBe("requested");
    });
  }
});

describe("a mistyped dataset id is refused before any request is made", () => {
  const MISTYPED: ReadonlyArray<{ name: string; args: string[] }> = [
    { name: "deny", args: ["admin", "publish", "deny", "nm0004", ...WHY, "--yes"] },
    { name: "screen", args: ["admin", "publish", "screen", "nm0004"] },
  ];
  for (const { name, args } of MISTYPED) {
    test(`${name} nm0004 exits 1 and sends nothing`, async () => {
      const requestId = seedGolden(h.db);
      const r = await h.cli(args);
      expect(r.exitCode).toBe(1);
      expect(output(r)).toContain('"nm0004" is not a dataset id');
      expect(output(r)).not.toContain(BUG_HINT);
      expect(h.requests).toEqual([]);
      expect(requestStatus(requestId)).toBe("requested");
    });
  }
});

describe("deny with no reason and nothing to ask on", () => {
  // `inquirer` on a stdin that is not a terminal dies with an uncatchable ERR_USE_AFTER_CLOSE
  // stack trace (the case `confirm()` already guards), so the reason prompt is guarded the same way.
  test("a closed stdin exits 1 with a sentence, no stack trace and nothing posted", async () => {
    const requestId = seedGolden(h.db);
    const r = await h.cli(["admin", "publish", "deny", DATASET, "--yes"]);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("Reason is required");
    expect(output(r)).toContain("--reason");
    expect(output(r)).not.toContain("ERR_USE_AFTER_CLOSE");
    expect(output(r)).not.toMatch(/\n\s+at /);
    expect(output(r)).not.toContain(BUG_HINT);
    expect(posts()).toEqual([]);
    expect(requestStatus(requestId)).toBe("requested");
  });

  test("--help-all says where the reason comes from, and that a script passes --reason", async () => {
    const r = await h.cli(["admin", "publish", "deny", "--help-all"]);
    expect(r.exitCode).toBe(0);
    const text = output(r).replace(/\s+/g, " ");
    expect(text).toContain(
      "with no --reason, one typed at a terminal or the first line of piped input (in a script, pass --reason)",
    );
    expect(text).not.toContain("nothing is asked when there is neither");
  });

  test("a reason piped in is read as the reason, and nothing is asked", async () => {
    const requestId = seedUnstarted(h.db);
    const r = await h.cli(["admin", "publish", "deny", DATASET, "--yes"], {
      input: "Please add the participants file\n",
    });
    expect(r.exitCode).toBe(0);
    expect(requestStatus(requestId)).toBe("denied");
  });

  describe.skipIf(process.platform === "win32")("on a terminal", () => {
    test("the reason is asked for, and an empty one is refused", async () => {
      const requestId = seedGolden(h.db);
      const r = await h.cli(["admin", "publish", "deny", DATASET, "--yes"], {
        terminal: async (t) => {
          const asked = await t.waitFor("Reason for denial:");
          t.type("\n");
          await t.waitFor("Reason is required", { after: asked });
        },
      });
      expect(r.exitCode).toBe(1);
      expect(posts()).toEqual([]);
      expect(requestStatus(requestId)).toBe("requested");
    });

    test("a typed reason is sent", async () => {
      const requestId = seedUnstarted(h.db);
      const r = await h.cli(["admin", "publish", "deny", DATASET, "--yes"], {
        terminal: async (t) => {
          const asked = await t.waitFor("Reason for denial:");
          t.type("Please add the participants file\n");
          await t.waitFor(`Publication denied for ${DATASET}`, { after: asked });
        },
      });
      expect(r.exitCode).toBe(0);
      expect(requestStatus(requestId)).toBe("denied");
    });
  });
});

describe("under --json a failure goes to standard error and standard output stays empty", () => {
  const JSON_COMMANDS: ReadonlyArray<{ name: string; args: string[] }> = [
    { name: "list", args: ["admin", "publish", "list", "--json"] },
    { name: "show", args: ["admin", "publish", "show", DATASET, "--json"] },
    { name: "start", args: ["admin", "publish", "start", DATASET, "--json"] },
    { name: "start --all", args: ["admin", "publish", "start", "--all", "--json"] },
  ];

  for (const { name, args } of JSON_COMMANDS) {
    test(`${name} signed out`, async () => {
      seedGolden(h.db);
      const r = await h.cli(args, { signedOut: true });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("Error: Not authenticated");
      expect(h.requests).toEqual([]);
    });

    test(`${name} with a member's key: the Worker's refusal and its hint`, async () => {
      seedGolden(h.db);
      await h.user("exitmember", "member", MEMBER_KEY);
      const r = await h.cli(args);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("This command requires admin privileges");
      expect(posts().every((c) => c.status === 403)).toBe(true);
    });
  }

  for (const { name, args } of JSON_COMMANDS.filter(
    (c) => c.name !== "list" && c.name !== "start --all",
  )) {
    test(`${name} of a mistyped id`, async () => {
      const r = await h.cli(args.map((a) => (a === DATASET ? "nm0004" : a)));
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain('"nm0004" is not a dataset id');
      expect(h.requests).toEqual([]);
    });
  }

  test("a fault of the Worker is on standard error too", async () => {
    seedGolden(h.db);
    h.hookDb({
      statement(sql) {
        if (/FROM publication_requests/.test(sql)) throw new Error("simulated read failure");
      },
    });
    const r = await h.cli(["admin", "publish", "list", "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toBe("");
    expect(h.requests.at(-1)?.status).toBe(500);
  });
});

describe("whether a 5xx may be a bug: the Worker's closed word makes it an answer", () => {
  test("start of a Worker with no way to dispatch (502, dispatch_unconfigured) exits 1, no bug-report hint", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1", PRESCREEN_CALLBACK_SECRET: undefined });
    seedScreenedRequest(h.db, { datasetId: DATASET });
    const r = await h.cli(["admin", "publish", "start", DATASET]);
    expect(r.exitCode).toBe(1);
    expect(h.requests.at(-1)?.status).toBe(502);
    expect(output(r)).toContain("(dispatch_unconfigured)");
    expect(output(r)).not.toContain(BUG_HINT);
  });

  test("a comment the Worker could not mail (502, comment_not_sent) exits 1, no bug-report hint", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
    seedGolden(h.db);
    const r = await h.cli(["admin", "publish", "next"], {
      input: "c\nCould you check the README?\n",
      resend: { status: 422 },
    });
    expect(r.exitCode).toBe(1);
    expect(h.requests.filter((c) => c.path.endsWith("/comment")).map((c) => c.status)).toEqual([
      502,
    ]);
    expect(output(r)).not.toContain(BUG_HINT);
  });

  test("a 5xx that names the word internal may be a bug: show keeps the hint", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
    seedGolden(h.db);
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });
    const r = await h.cli(["admin", "publish", "show", DATASET]);
    expect(r.exitCode).toBe(1);
    expect(h.requests.at(-1)?.status).toBe(500);
    expect(output(r)).toContain(BUG_HINT);
  });
});

describe("success still exits 0", () => {
  test("list of requests", async () => {
    seedGolden(h.db);
    const r = await h.cli(["admin", "publish", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(DATASET);
  });

  test("list when there are none", async () => {
    const r = await h.cli(["admin", "publish", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No active requests found");
  });

  test("deny --yes of an active request", async () => {
    const requestId = seedUnstarted(h.db);
    const r = await h.cli(["admin", "publish", "deny", DATASET, ...WHY, "--yes"]);
    expect(r.exitCode).toBe(0);
    expect(requestStatus(requestId)).toBe("denied");
  });

  test("approve --resume --yes of a golden-path request", async () => {
    const requestId = seedGolden(h.db);
    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);
    expect(r.exitCode).toBe(0);
    expect(requestStatus(requestId)).toBe("published");
  });

  test("screen dispatches the identifier screen again", async () => {
    seedGolden(h.db);
    const r = await h.cli(["admin", "publish", "screen", DATASET]);
    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain(`Identifier screen dispatched for ${DATASET}`);
    expect(h.github.dispatches).toHaveLength(1);
  });
});
