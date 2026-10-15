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

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "nemar-publist-api-"));
  process.env.NEMAR_CONFIG_DIR = tmpConfigDir;
  setConfig("apiKey", "test-token-list");
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.search);
      return Response.json({ requests: [], count: 0 });
    },
  });
  process.env.TEST_API_URL = `http://localhost:${server.port}`;
});

afterEach(() => {
  seen = [];
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
    expect(seen).toEqual(["?status=published%2Cdenied&search=nm0001"]);
  });

  test("an options object without statuses sends no status", async () => {
    await listPublishRequests({ search: "alice" });
    expect(seen).toEqual(["?search=alice"]);
  });
});
