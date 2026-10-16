/**
 * The commands this release added, against the 0.10.18 Worker that does not have their routes:
 * the package and the Worker are released by separate workflows within minutes of each other, in
 * either order, so for a while a new CLI talks to an old Worker.
 *
 * What an old Worker answers for a route it does not have is the plain 404 body
 * (`{ error: "Not Found", message: "Route ... not found" }`), reproduced at its HTTP boundary by
 * `helpers/old-worker.ts`; the real command runs against it as a child process. The answer is the
 * Worker's own, so exit 1 is the command's answer and not a crash, and no command invites a bug
 * report for it or adds a hint that belongs to a different failure ("User not found" under a
 * missing ROUTE).
 *
 * Each group also has a control against the real current routes, so the words an existing answer
 * already had (a missing user, a missing dataset) are kept.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend and the old Worker's boundary, no live network.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { seedScreenedRequest } from "../backend/test/helpers/publication-review";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import { seedGolden } from "./helpers/approve-seeds";
import { type OldWorker, startOldWorker } from "./helpers/old-worker";

setDefaultTimeout(60_000);

const ADMIN_KEY = "skew-admin-key-0123456789abcdef0123456789abcdef";
const OWNER_KEY = "skew-owner-key-0123456789abcdef0123456789abcdef";
const BUG_HINT = "attach the log to a new issue";

const h = startPublishCli();
const old: OldWorker = startOldWorker(h.apiUrl);
afterAll(() => {
  old.stop();
  h.stop();
});

beforeEach(async () => {
  h.reset();
  old.reset();
  await h.admin("skewadmin", ADMIN_KEY);
});

const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

function seed(datasetId: string): void {
  seedScreenedRequest(h.db, { datasetId });
}

describe("the 0.10.18 Worker: a route it does not have says so, and is an answer", () => {
  async function onOld(args: string[]): Promise<CliResult> {
    return h.cli(args, { apiUrl: old.url });
  }

  test("`show` says the backend does not support it, exit 1, no bug invitation", async () => {
    seed("nm000501");

    const r = await onOld(["admin", "publish", "show", "nm000501"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("This NEMAR backend does not support this command yet.");
    expect(output(r)).not.toContain(BUG_HINT);
  });

  test("`start` says the same", async () => {
    seed("nm000501");

    const r = await onOld(["admin", "publish", "start", "nm000501"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("This NEMAR backend does not support this command yet.");
    expect(output(r)).not.toContain(BUG_HINT);
  });

  test("`start --all` says the Worker is older than the review and starts nothing", async () => {
    seed("nm000501");

    const r = await onOld(["admin", "publish", "start", "--all", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("older than the review");
    expect(output(r)).not.toContain(BUG_HINT);
    expect(old.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("`dataset publish withdraw` says only that the backend does not support it", async () => {
    const r = await onOld(["dataset", "publish", "withdraw", "nm000501", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("This NEMAR backend does not support this command yet.");
    // The nudge to file a bug is for a failure that may be one; this is the Worker's own answer.
    expect(output(r)).not.toContain(BUG_HINT);
    expect(output(r)).not.toContain("There is no active publication request");
  });

  test("`admin verify` says only that the backend does not support it, not that the user is missing", async () => {
    await h.user("skewowner", "owner", OWNER_KEY);

    const r = await onOld(["admin", "verify", "80", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("Route POST /admin/users/by-id/80/verify not found");
    expect(output(r)).toContain("This NEMAR backend does not support this command yet.");
    expect(output(r)).not.toContain("User not found");
    expect(output(r)).not.toContain(BUG_HINT);
  });
});

describe("the 0.10.18 Worker: `approve` reads no review and asks the Worker to decide", () => {
  test("it says there is no review, sends no identity and no override, and the approval runs", async () => {
    seedGolden(h.db);

    const r = await h.cli(["admin", "publish", "approve", "nm000460", "--resume", "--yes"], {
      apiUrl: old.url,
    });

    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain("This API has no publication review.");
    // The review was asked for, answered 404 for the route, and the approval went on without it.
    const calls = old.calls
      .map((c) => `${c.method} ${c.path}`)
      .filter((c) => c !== "GET /notices" && !c.includes("/publish/status"));
    expect(calls).toEqual([
      "GET /admin/publish/nm000460/review",
      "POST /admin/publish/nm000460/approve",
    ]);
    // Nothing the old Worker's schema does not know is sent: the request the administrator looked
    // at is unknown to the CLI (the review was where it came from), so there is no `request_id`
    // for the old Worker to ignore, and no override.
    const [body] = h.posted.map((p) => p.body ?? {});
    expect(Object.keys(body)).not.toContain("request_id");
    expect(Object.keys(body)).not.toContain("publication_review_override");
  });

  test("--force is not sent, and the command says so", async () => {
    seedGolden(h.db);

    const r = await h.cli(
      ["admin", "publish", "approve", "nm000460", "--resume", "--yes", "--force"],
      { apiUrl: old.url },
    );

    expect(output(r)).toContain("--force was not sent: no review could be read to approve over.");
    const [body] = h.posted.map((p) => p.body ?? {});
    expect(Object.keys(body)).not.toContain("publication_review_override");
  });
});

describe("a Worker of this release: the answers those two commands already had are kept", () => {
  test("`admin verify` of an unknown account still says the user was not found", async () => {
    await h.user("skewowner", "owner", OWNER_KEY);

    const r = await h.cli(["admin", "verify", "99999", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("User not found");
    expect(output(r)).not.toContain("does not support this command");
    expect(output(r)).not.toContain(BUG_HINT);
  });

  test("`dataset publish withdraw` of an unknown dataset exits 1 as the Worker's answer", async () => {
    const r = await h.cli(["dataset", "publish", "withdraw", "nm000599", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("Dataset not found");
    expect(output(r)).not.toContain(BUG_HINT);
  });
});
