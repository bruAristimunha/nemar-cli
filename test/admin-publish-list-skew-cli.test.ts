/**
 * `nemar admin publish list`, and the commands this release added, across a Worker of another
 * version: the package is published and the Worker deployed by separate workflows within minutes
 * of each other, in either order, so the CLI has to be correct against BOTH.
 *
 * The 0.10.18 Worker ran `WHERE pr.status = ?` with the whole `status` string and never read
 * `search`, so the new default scope (`requested,approving,blocked`) matched nothing there, the
 * list said "No active requests found" while requests existed, and `--search` was ignored without
 * a sign. The real command (`bun run src/index.ts ...`) runs here against:
 *
 *   1. the real current Worker routes over real SQLite (`helpers/admin-publish-cli.ts`): what a
 *      new CLI shows a new Worker's answer is unchanged, and
 *   2. a stand-in at the HTTP boundary that reproduces the OLD Worker's filtering over the same
 *      real rows (`helpers/old-worker.ts`), the one place a stand-in is allowed: skew is the thing
 *      under test.
 *
 * Mutation checks (each turns a named group red; see the pull request for the run):
 *   - drop the per-status fallback of `listPublishRequests`: the default scope, combined-flag and
 *     search rows against the old Worker go red, the new-Worker rows stay green;
 *   - drop the client-side search check: the old-Worker search rows go red;
 *   - drop `dataset_name` from the fields the check reads: the new-Worker name search goes red.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend and the old Worker's boundary, no live network.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { seedScreenedRequest } from "../backend/test/helpers/publication-review";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import { type OldWorker, startOldWorker } from "./helpers/old-worker";

setDefaultTimeout(60_000);

const ADMIN_KEY = "skew-admin-key-0123456789abcdef0123456789abcdef";

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

type RequestStatus = "requested" | "approving" | "blocked" | "denied" | "published";

/** One request, with its own time so the order the Worker lists in is not a tie. */
function seed(datasetId: string, requestStatus: RequestStatus, minute: number): void {
  const { requestId } = seedScreenedRequest(h.db, { datasetId, requestStatus });
  h.db.run("UPDATE publication_requests SET requested_at = ? WHERE id = ?", [
    `2026-10-01 10:${String(minute).padStart(2, "0")}:00`,
    requestId,
  ]);
}

/** The dataset ids on the rows a list printed, in the order printed. */
function listedIds(r: CliResult): string[] {
  return [...r.stdout.matchAll(/^ {2}(nm\d{6}) {2}/gm)].map((m) => m[1]);
}

function seedMixed(): void {
  seed("nm000501", "requested", 1);
  seed("nm000502", "approving", 2);
  seed("nm000503", "blocked", 3);
  seed("nm000504", "published", 4);
  seed("nm000505", "denied", 5);
}

/** The query strings of the list requests the command made to the old Worker, in order. */
function listCalls(): string[] {
  return old.calls.filter((c) => c.path === "/admin/publish/requests").map((c) => c.search);
}

function listOn(worker: OldWorker | null, args: string[]): Promise<CliResult> {
  return h.cli(["admin", "publish", "list", ...args], worker ? { apiUrl: worker.url } : {});
}

describe("a Worker of this release: what the list shows is unchanged", () => {
  test("the default scope lists the active requests, newest first, in one request", async () => {
    seedMixed();

    const r = await listOn(null, []);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (3, active requests)");
    expect(listedIds(r)).toEqual(["nm000503", "nm000502", "nm000501"]);
    expect(h.requests.filter((c) => c.path === "/admin/publish/requests")).toHaveLength(1);
  });

  test("combined state flags are the union, and --all is every request", async () => {
    seedMixed();

    const two = await listOn(null, ["--blocked", "--denied"]);
    const all = await listOn(null, ["--all"]);

    expect(listedIds(two)).toEqual(["nm000505", "nm000503"]);
    expect(listedIds(all)).toEqual(["nm000505", "nm000504", "nm000503", "nm000502", "nm000501"]);
  });

  test("an empty active scope is true there: it says so, and the three extra reads change nothing", async () => {
    seed("nm000504", "published", 4);

    const r = await listOn(null, []);

    // The Worker answered the union query with nothing. The CLI cannot tell that from a Worker
    // that matches nothing for a comma list, so it asks once per status; on this Worker those are
    // empty too (three small indexed reads, once per empty list), and the answer is the same.
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No active requests found.");
    const listCalls = h.requests.filter((c) => c.path === "/admin/publish/requests");
    expect(listCalls).toHaveLength(4);
    expect(listCalls.every((c) => c.method === "GET" && c.status === 200)).toBe(true);
    expect(h.requests.some((c) => c.method !== "GET")).toBe(false);
  });

  test("--search finds a row by id, depositor or name alone, and the check drops none of them", async () => {
    seedMixed();

    // Each of these matches through ONE field only, and in a letter case the stored text does not
    // have: LIKE folds ASCII letters, and so must the check.
    const byId = await listOn(null, ["--search", "NM000502", "--all"]);
    const byUser = await listOn(null, ["--search", "DEPOSITOR_nm000503", "--all"]);
    const byName = await listOn(null, ["--search", "descriptive TITLE for nm000504", "--all"]);

    expect(listedIds(byId)).toEqual(["nm000502"]);
    expect(listedIds(byUser)).toEqual(["nm000503"]);
    expect(listedIds(byName)).toEqual(["nm000504"]);
  });

  test("--search lists an exact dataset id first", async () => {
    // The exact id is the OLDER request: a plain newest-first order would bury it.
    seed("nm000501", "requested", 1);
    seed("nm000511", "requested", 9);
    h.db.run("UPDATE users SET username = 'fan_of_nm000501' WHERE username = 'depositor_nm000511'");

    const r = await listOn(null, ["--search", "nm000501"]);

    expect(listedIds(r)).toEqual(["nm000501", "nm000511"]);
  });

  test("--json keeps its shape", async () => {
    seedMixed();

    const r = await listOn(null, ["--json"]);

    const body = JSON.parse(r.stdout);
    expect(Object.keys(body).sort()).toEqual(["count", "requests"]);
    expect(body.count).toBe(3);
    expect(body.requests.map((x: { dataset_id: string }) => x.dataset_id)).toEqual([
      "nm000503",
      "nm000502",
      "nm000501",
    ]);
    // A new Worker's rows carry the new keys.
    expect(body.requests[0]).toHaveProperty("dataset_name");
    expect(body.requests[0]).toHaveProperty("publication_review");
  });
});

describe("the 0.10.18 Worker: the list is correct, not falsely empty", () => {
  test("the stand-in is the old route: a comma list matches nothing and search is ignored", async () => {
    seedMixed();

    // Straight at the stand-in, no CLI: the premise of every row below.
    const base = old.url;
    const get = async (qs: string) => {
      const res = await fetch(`${base}/admin/publish/requests${qs}`, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      return (await res.json()) as { requests: Array<Record<string, unknown>>; count: number };
    };
    expect((await get("?status=requested,approving,blocked")).requests).toEqual([]);
    expect((await get("?status=requested&search=zzz")).requests).toHaveLength(1);
    expect((await get("")).requests).toHaveLength(5);
    const row = (await get("?status=requested")).requests[0];
    expect(row).not.toHaveProperty("dataset_name");
    expect(row).not.toHaveProperty("publication_review");
  });

  test("the default scope lists the active requests, newest first", async () => {
    seedMixed();

    const r = await listOn(old, []);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("No active requests found");
    expect(r.stdout).toContain("Publication Requests (3, active requests)");
    expect(listedIds(r)).toEqual(["nm000503", "nm000502", "nm000501"]);
    // One question with the union, then one per status.
    expect(listCalls()).toEqual([
      "?status=requested%2Capproving%2Cblocked",
      "?status=requested",
      "?status=approving",
      "?status=blocked",
    ]);
  });

  test("combined state flags are the union of their rows, newest first across the states", async () => {
    seedMixed();

    const r = await listOn(old, ["--blocked", "--denied", "--published"]);

    expect(listedIds(r)).toEqual(["nm000505", "nm000504", "nm000503"]);
    expect(r.stdout).toContain("(3, requests with status blocked or published or denied)");
  });

  test("a state flag and -s that name one status ask once, and --all asks for everything", async () => {
    seedMixed();

    const one = await listOn(old, ["--denied"]);
    expect(listedIds(one)).toEqual(["nm000505"]);
    expect(listCalls()).toEqual(["?status=denied"]);

    old.reset();
    const all = await listOn(old, ["--all"]);
    expect(listedIds(all)).toEqual(["nm000505", "nm000504", "nm000503", "nm000502", "nm000501"]);
    expect(listCalls()).toEqual([""]);
  });

  test("the history of an empty active scope is still empty", async () => {
    seed("nm000504", "published", 4);

    const r = await listOn(old, []);

    expect(r.stdout).toContain("No active requests found.");
  });

  test("--search shows only the rows that match, as the new Worker would", async () => {
    seedMixed();

    // The old Worker ignores `search` and returns every row of the status asked for.
    const byId = await listOn(old, ["--search", "nm000502"]);
    expect(listedIds(byId)).toEqual(["nm000502"]);
    expect(byId.stdout).toContain("Publication Requests (1, active requests)");

    const byUser = await listOn(old, ["--search", "DEPOSITOR_nm000503", "--all"]);
    expect(listedIds(byUser)).toEqual(["nm000503"]);

    const none = await listOn(old, ["--search", "nm000504"]);
    expect(none.stdout).toContain('No active requests found matching "nm000504".');
    expect(none.stdout).toContain("Use --all");
  });

  test("--search with one status drops the rows it did not match", async () => {
    seed("nm000501", "denied", 1);
    seed("nm000502", "denied", 2);

    const r = await listOn(old, ["--denied", "--search", "nm000501"]);

    expect(listedIds(r)).toEqual(["nm000501"]);
  });

  test("--search lists an exact dataset id first, which the old Worker did not", async () => {
    seed("nm000501", "requested", 1);
    seed("nm000511", "requested", 9);
    h.db.run("UPDATE users SET username = 'fan_of_nm000501' WHERE username = 'depositor_nm000511'");

    const r = await listOn(old, ["--search", "nm000501"]);

    // The old Worker lists newest first, so the longer id came first; the exact one leads now.
    expect(listedIds(r)).toEqual(["nm000501", "nm000511"]);
  });

  test("a row that matches only by its dataset's name cannot be confirmed from an old row, so it is not shown", async () => {
    seed("nm000504", "published", 4);

    // The old Worker sent no name, so the check has nothing to read for it; a new Worker's row
    // always carries one (previous group).
    const r = await listOn(old, ["--search", "descriptive title", "--all"]);

    expect(listedIds(r)).toEqual([]);
  });

  test("--json keeps its shape, and its count is the rows", async () => {
    seedMixed();

    const r = await listOn(old, ["--json"]);

    const body = JSON.parse(r.stdout);
    expect(Object.keys(body).sort()).toEqual(["count", "requests"]);
    expect(body.count).toBe(3);
    expect(body.requests.map((x: { dataset_id: string }) => x.dataset_id)).toEqual([
      "nm000503",
      "nm000502",
      "nm000501",
    ]);
  });

  test("--json with --search counts the rows kept", async () => {
    seedMixed();

    const r = await listOn(old, ["--json", "--search", "nm000501"]);

    const body = JSON.parse(r.stdout);
    expect(body.count).toBe(1);
    expect(body.requests).toHaveLength(1);
  });

  test("--needs-me works on the merged rows", async () => {
    seedMixed();

    const r = await listOn(old, ["--needs-me"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (");
    expect(r.stdout).not.toContain("No active requests found");
  });
});
