/**
 * `listPublishRequests` keeps both of its call shapes (#1774): the string
 * status it began with, which `admin-publish-next` and `admin-publish-review`
 * on the publication-review epic branch still pass, and the options object the
 * list command passes now. Real HTTP against a local server, no stand-in for
 * the client.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./setup";
import { listPublishRequests } from "../src/lib/api/publish";
import { setConfig } from "../src/lib/config";

const originalTestApiUrl = process.env.TEST_API_URL;
const originalConfigDir = process.env.NEMAR_CONFIG_DIR;
let tmpConfigDir: string;
let server: ReturnType<typeof Bun.serve>;
let seen: string[] = [];
const EMPTY = () => ({ requests: [], count: 0 });
let reply: (url: URL) => unknown = EMPTY;

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "nemar-publist-api-"));
  process.env.NEMAR_CONFIG_DIR = tmpConfigDir;
  setConfig("apiKey", "test-token-list");
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.search);
      return Response.json(reply(url));
    },
  });
  process.env.TEST_API_URL = `http://localhost:${server.port}`;
});

afterEach(() => {
  seen = [];
  reply = EMPTY;
});

afterAll(() => {
  server.stop(true);
  // Reflect.deleteProperty, not `= undefined`: Bun would store the STRING "undefined".
  if (originalTestApiUrl === undefined) Reflect.deleteProperty(process.env, "TEST_API_URL");
  else process.env.TEST_API_URL = originalTestApiUrl;
  if (originalConfigDir === undefined) Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
  else process.env.NEMAR_CONFIG_DIR = originalConfigDir;
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

describe("listPublishRequests", () => {
  test("a string is one status, as it always was", async () => {
    await listPublishRequests("requested");
    await listPublishRequests("approving");
    expect(seen).toEqual(["?status=requested", "?status=approving"]);
  });

  test("an empty string means no filter, as it did before", async () => {
    await listPublishRequests("");
    expect(seen).toEqual([""]);
  });

  test("no argument asks for everything", async () => {
    await listPublishRequests();
    expect(seen).toEqual([""]);
  });

  test("the options object carries statuses and search", async () => {
    await listPublishRequests({ statuses: ["published", "denied"], search: "nm0001" });
    // The server here answers nothing, so the union is followed by one question per status (an
    // empty union is how a Worker that cannot take a comma list answers; test/admin-publish-
    // list-skew-cli.test.ts runs that case end to end).
    expect(seen).toEqual([
      "?status=published%2Cdenied&search=nm0001",
      "?status=published&search=nm0001",
      "?status=denied&search=nm0001",
    ]);
  });

  test("an options object without statuses sends no status", async () => {
    await listPublishRequests({ search: "alice" });
    expect(seen).toEqual(["?search=alice"]);
  });
});

/**
 * A row as the 0.10.18 route sends it (no dataset name unless a test gives one): only the fields
 * the list's checks read. These two tests stand in for the OLD Worker at its HTTP boundary, which
 * is what the policy allows when skew is the thing under test; the current Worker's answers are
 * tested against its real routes in test/admin-publish-list-skew-cli.test.ts.
 */
function row(id: string, status: string, at: string, user = "someone", name?: string) {
  return {
    id: 1,
    dataset_id: id,
    status,
    requested_at: at,
    requested_by_username: user,
    ...(name === undefined ? {} : { dataset_name: name }),
  };
}

describe("listPublishRequests across Worker versions", () => {
  test("a Worker that takes one status only: the union is empty, so each status is asked and merged newest first", async () => {
    const rows = [
      row("nm000001", "requested", "2026-10-01 10:01:00"),
      row("nm000002", "approving", "2026-10-01 10:03:00"),
      row("nm000003", "blocked", "2026-10-01 10:02:00"),
    ];
    // The 0.10.18 route: equality on the whole status string.
    reply = (url) => {
      const status = url.searchParams.get("status");
      const requests = rows.filter((r) => !status || r.status === status);
      return { requests, count: requests.length };
    };

    const answer = await listPublishRequests({ statuses: ["requested", "approving", "blocked"] });

    expect(answer.requests.map((r) => r.dataset_id)).toEqual(["nm000002", "nm000003", "nm000001"]);
    expect(answer.count).toBe(3);
  });

  test("a search keeps the rows that match by id, depositor or name, and the count is the rows kept", async () => {
    const rows = [
      row("nm000001", "requested", "2026-10-01 10:01:00", "alice", "Gait study"),
      row("nm000002", "requested", "2026-10-01 10:02:00", "bob"),
      row("nm000003", "requested", "2026-10-01 10:03:00", "carol", "GAIT again"),
      row("nm000004", "requested", "2026-10-01 10:04:00", "GaitFan"),
    ];
    // A Worker that never read `search`.
    reply = () => ({ requests: rows, count: rows.length });

    const answer = await listPublishRequests({ statuses: ["requested"], search: "gait" });

    expect(answer.requests.map((r) => r.dataset_id)).toEqual(["nm000004", "nm000003", "nm000001"]);
    expect(answer.count).toBe(3);
  });
});
