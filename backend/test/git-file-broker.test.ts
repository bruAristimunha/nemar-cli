/**
 * The data plane's git-file broker (#1403, epic #1406).
 *
 * Real engines: a real `Bun.serve()` stands in for the raw content host and
 * for api.github.com (reached through the `NEMAR_GITHUB_API_URL` override the
 * other GitHub-facing suites use), and the route test drives the real
 * `dataRoutes` Hono app against a real D1. Nothing is mocked; the server
 * records every request, so the assertions are about what was actually sent.
 *
 * The route half is DIFFERENTIAL on purpose. An earlier version asserted
 * only that a private dataset produced no upstream request, and that assertion
 * held for the wrong reason: the test env carried no S3 credentials, so
 * `loadManifest` failed three steps before the gate mattered, and the same
 * test passed for a PUBLIC dataset too. It would have stayed green with the
 * visibility check deleted outright. So the public case now serves a real
 * manifest (through `S3_ENDPOINT_URL`, the same origin-override idiom the
 * zarr suites use) and MUST reach GitHub; the private one must not. Only the
 * pair proves the ordering.
 *
 * WHAT THIS SUITE CANNOT SEE, stated here because it is what a reader needs
 * before trusting a green run. It drives the route in-process, where no HTTP
 * serialization happens at all, so `headers.set("Content-Length", ...)`
 * always sticks. That makes it structurally blind to what caused #1419:
 * workerd DROPS a hand-set `Content-Length` when the body is a stream. A
 * green run here is not evidence about the deployed data plane; the oracle
 * for that is `test/git-broker-live.test.ts`, which is what caught #1419 and
 * what will confirm the fix once it reaches the staging worker. That file
 * SKIPS until then, so its silence on a feature branch is not evidence
 * either.
 *
 * What this suite can do about that class is pin the INTENT: the header is
 * asserted present on the buffered branch and asserted null on the streamed
 * one. Without the second assertion, restoring the unconditional set that
 * #1420 shipped passes every test here -- measured, not supposed.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { __limits } from "../src/middleware/rateLimit";
import { dataRoutes } from "../src/routes/data";
import { gitFileCacheKey } from "../src/services/git-file-cache";
import { fetchGitTrackedFile } from "../src/services/github/git-file-broker";
import { MANIFEST_TRUST_WINDOW_MS, resetManifestAnswerMemo } from "../src/services/manifest-source";
import type { Bindings, Variables } from "../src/types/bindings";
import { DrainingCache, StalledCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";

/**
 * The real `git hash-object` of FILE_BODY, not an arbitrary 40 hex digits.
 * Since #1419 the route verifies that the bytes it brokered ARE the blob the
 * manifest named, so a fixture whose SHA does not match its body would 502
 * every happy path. Recompute with:
 *   printf '%s' '<FILE_BODY>' | git hash-object --stdin
 */
const BLOB_SHA = "8cb31ee475b57f9caf41c02a1e4de7862cde420c";
const FILE_BODY = '{"Name":"A dataset","BIDSVersion":"1.11.0"}';

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  accept: string | null;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
/** Per-path behavior the current test wants from the stand-in. */
let routes: Record<string, () => Response> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("Authorization"),
        accept: request.headers.get("Accept"),
      });
      const handler = routes[url.pathname];
      return handler ? handler() : new Response("no route", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = base;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

function reset(next: Record<string, () => Response>): void {
  seen = [];
  routes = next;
}

const rawPath = "/nemarDatasets/nm099999/v1.0.0/dataset_description.json";
const blobPath = `/repos/nemarDatasets/nm099999/git/blobs/${BLOB_SHA}`;

function request(over: Partial<Parameters<typeof fetchGitTrackedFile>[0]> = {}) {
  return fetchGitTrackedFile({
    repo: "nm099999",
    ref: "v1.0.0",
    path: "dataset_description.json",
    blobSha: BLOB_SHA,
    token: "test-installation-token",
    rawBase: base,
    ...over,
  });
}

describe("fetchGitTrackedFile", () => {
  test("serves from the raw host and sends the installation token", async () => {
    reset({ [rawPath]: () => new Response(FILE_BODY, { status: 200 }) });

    const out = await request();

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    expect(out.source).toBe("raw");
    expect(await new Response(out.body).text()).toBe(FILE_BODY);
    // The token is what makes a private repo readable; without it this whole
    // phase does nothing that the old redirect did not.
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe("Bearer test-installation-token");
    // The REST API must not be touched on the happy path: its budget is
    // shared with publishing and one download is thousands of files.
    expect(seen.some((s) => s.path.startsWith("/repos/"))).toBe(false);
  });

  test("reads anonymously when no token is configured", async () => {
    reset({ [rawPath]: () => new Response(FILE_BODY, { status: 200 }) });

    const out = await request({ token: null });

    expect(out.kind).toBe("ok");
    expect(seen[0].authorization).toBeNull();
  });

  test("falls back to the blob SHA when the path is not at that ref", async () => {
    reset({
      [rawPath]: () => new Response("not found", { status: 404 }),
      [blobPath]: () => new Response(FILE_BODY, { status: 200 }),
    });

    const out = await request();

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    expect(out.source).toBe("blob");
    // The fallback asks for the object the manifest named, by SHA, with the
    // media type that returns bytes rather than base64 JSON.
    const blobCall = seen.find((s) => s.path === blobPath);
    expect(blobCall?.accept).toBe("application/vnd.github.raw");
  });

  test("absent means both sources answered 404, not one", async () => {
    reset({
      [rawPath]: () => new Response("not found", { status: 404 }),
      [blobPath]: () => new Response("not found", { status: 404 }),
    });

    const out = await request();

    expect(out.kind).toBe("absent");
    expect(seen.map((s) => s.path)).toEqual([rawPath, blobPath]);
  });

  test("a throttle is reported as unavailable, never as absence", async () => {
    // The distinction ADR 0005 draws: telling a user their file does not
    // exist because we were rate limited is the failure worth preventing.
    reset({
      [rawPath]: () =>
        new Response("rate limited", { status: 429, headers: { "Retry-After": "42" } }),
    });

    const out = await request();

    expect(out.kind).toBe("unavailable");
    if (out.kind !== "unavailable") throw new Error("unreachable");
    expect(out.status).toBe(503);
    expect(out.retryAfter).toBe("42");
    // No blob fallback: a 429 says nothing about whether the path is there.
    expect(seen.some((s) => s.path === blobPath)).toBe(false);
  });

  test("a refused credential is a 502, and does not fall through to the blob", async () => {
    reset({ [rawPath]: () => new Response("bad credentials", { status: 401 }) });

    const out = await request();

    expect(out.kind).toBe("unavailable");
    if (out.kind !== "unavailable") throw new Error("unreachable");
    expect(out.status).toBe(502);
    expect(seen.some((s) => s.path === blobPath)).toBe(false);
  });

  test("an unreachable host is unavailable, not absent", async () => {
    reset({});
    // Port 1 with nothing listening: a real connection failure, not a status.
    const out = await request({ rawBase: "http://127.0.0.1:1" });

    expect(out.kind).toBe("unavailable");
    if (out.kind !== "unavailable") throw new Error("unreachable");
    expect(out.status).toBe(502);
  });

  test("a path with a space is encoded per segment", async () => {
    const encoded = "/nemarDatasets/nm099999/v1.0.0/sub-01/eeg/sub-01_task-rest%20events.tsv";
    reset({ [encoded]: () => new Response("onset\tduration\n", { status: 200 }) });

    const out = await request({ path: "sub-01/eeg/sub-01_task-rest events.tsv" });

    // The space has to reach the wire percent-encoded, and the slashes have
    // to survive: a whole-path encode would send %2F and miss the file.
    expect(out.kind).toBe("ok");
    expect(seen[0].path).toBe(encoded);
  });
});

describe("the route: the gate, then the bytes", () => {
  const VERSION = "v1.0.0";
  const PATH = "dataset_description.json";
  const manifestKey = `/nm000862/version/${VERSION}.json`;
  const publicRawPath = `/nemarDatasets/nm000862/${VERSION}/${PATH}`;

  /** The empty file: its git object name is the SHA-1 of `blob 0\0`. */
  function emptyManifestBody(): string {
    const emptySha = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    return JSON.stringify({
      dataset_id: "nm000862",
      version: "1.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-01-01T00:00:00Z",
      files: { [PATH]: { key: `git:${emptySha}`, size: 0, checksum: `git:${emptySha}` } },
    });
  }

  function manifestBody(size = FILE_BODY.length): string {
    return JSON.stringify({
      dataset_id: "nm000862",
      version: "1.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-01-01T00:00:00Z",
      files: { [PATH]: { key: `git:${BLOB_SHA}`, size, checksum: `git:${BLOB_SHA}` } },
    });
  }

  function seed(db: Database, id: string, visibility: "public" | "private"): void {
    db.prepare(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
       VALUES (?, ?, 1, 'active', ?, 0)`,
    ).run(id, id, visibility);
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?, '1.0.0', '10.5072/FK2test', 'ezid', datetime('now'))`,
    ).run(id);
  }

  function app(): Hono<{ Bindings: Bindings; Variables: Variables }> {
    const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    hono.route("/", dataRoutes);
    return hono;
  }

  function env(db: Database): Bindings {
    return {
      DB: realD1(db),
      ENVIRONMENT: "test",
      GITHUB_RAW_BASE: base,
      S3_ENDPOINT_URL: base,
      S3_BUCKET: "nemar",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "AKIATEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_ADMIN_PAT: "test-pat",
    } as Bindings;
  }

  test("a public dataset's git file is streamed, and it DOES reach GitHub", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () =>
        new Response(FILE_BODY, {
          status: 200,
          headers: { "Content-Length": String(FILE_BODY.length) },
        }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILE_BODY);
    // The other half of the differential: this request MUST have gone
    // upstream. Without it, the private case below proves nothing.
    expect(seen.some((s) => s.path === publicRawPath)).toBe(true);
    expect(seen.find((s) => s.path === publicRawPath)?.authorization).toBe("Bearer test-pat");
  });

  test("the streamed response carries the headers that keep it inert and cacheable-but-revocable", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () =>
        new Response(FILE_BODY, {
          status: 200,
          headers: { "Content-Length": String(FILE_BODY.length), "Content-Type": "text/plain" },
        }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Deliberately NOT immutable: visibility can be revoked and nothing
    // purges the edge, so the staleness bound on an authorization decision
    // stays where the redirect had it.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("ETag")).toBe(`"git:${BLOB_SHA}"`);
  });

  test("a length that disagrees with the manifest is refused, not served", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(999), { status: 200 }),
      [publicRawPath]: () =>
        new Response(FILE_BODY, {
          status: 200,
          headers: { "Content-Length": String(FILE_BODY.length) },
        }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  /**
   * A body the stand-in sends WITHOUT declaring a length, which is what the
   * broker actually meets in production: workerd owns `Accept-Encoding`, the
   * raw host gzips, and the runtime strips `Content-Length` when it decodes.
   * A `Response` built from a stream is chunked, so the client sees no length
   * -- the same shape, reproduced with a real server rather than asserted.
   */
  function streamed(text: string): Response {
    const bytes = new TextEncoder().encode(text);
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          // Two chunks with a turn of the event loop between them. A stream
          // that closes synchronously is small enough for Bun to buffer and
          // declare a length for, which would make these tests pass through
          // the header check they are here to bypass; yielding forces the
          // chunked response the runtime actually hands the broker.
          controller.enqueue(bytes.subarray(0, 1));
          await Bun.sleep(1);
          controller.enqueue(bytes.subarray(1));
          controller.close();
        },
      }),
    );
  }

  /** A stand-in whose body fails partway, which is what a dropped upstream
   *  connection looks like to the route: bytes, then an error. */
  function diesMidBody(prefix: string): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(prefix));
          await Bun.sleep(1);
          controller.error(new Error("upstream died"));
        },
      }),
    );
  }

  // The control for `streamed()`. Everything below that targets the
  // measurement depends on the stand-in really sending a chunked body with no
  // length; if Bun ever buffers it anyway, three tests would silently reroute
  // through the upstream-header fast path and keep passing while proving
  // something else. This fails in milliseconds when that happens.
  test("the stand-in really sends a chunked body with no declared length", async () => {
    reset({ [publicRawPath]: () => streamed(FILE_BODY) });

    const direct = await fetch(`${base}${publicRawPath}`);

    expect(direct.headers.get("Content-Length")).toBeNull();
    expect(direct.headers.get("Transfer-Encoding")).toBe("chunked");
    await direct.text();
  });

  test("a length upstream never declared is still declared to the client", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(200);
    // What this pins is the BUFFERED branch declaring a length it measured,
    // with upstream declaring none. It does not pin #1419 itself: under Bun
    // the pre-fix code declared the header too (mutation-tested), which is
    // why the streamed-branch assertion below exists and why the live test is
    // the oracle.
    expect(res.headers.get("Content-Length")).toBe(String(FILE_BODY.length));
    expect(await res.text()).toBe(FILE_BODY);
  });

  test("a body shorter than the manifest is refused, not served", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      // Upstream declares nothing, so the header check cannot fire and only
      // the measurement stands between a truncated file and a 200 that looks
      // healthy.
      [manifestKey]: () => new Response(manifestBody(FILE_BODY.length + 10), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a body longer than the manifest is refused, not served", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(4), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
  });

  test("the right number of bytes is not enough: a same-size edit is refused", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    const sameLength = FILE_BODY.replace("1.11.0", "1.10.0");
    expect(sameLength.length).toBe(FILE_BODY.length);
    expect(sameLength).not.toBe(FILE_BODY);
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(sameLength),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    // The scenario the length check was written for and could not see. The
    // raw fetch is by REF, so a moved tag serves the new blob at the same
    // path; when the edit does not change the size, every length comparison
    // passes and the response would carry an ETag naming the OLD blob.
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a body that dies mid-read is refused, and says so distinctly", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => diesMidBody("partial"),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    // Never cacheable: a transient upstream drop pinned at the edge would
    // turn one dropped connection into five minutes of failure per URL.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // Its own sentence, not the "refused us" one, and a hint about when to
    // come back -- this is the most transient failure in the function.
    expect(await res.json()).toMatchObject({
      error: "Upstream content host dropped the transfer",
    });
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  test("a zero-length file is served, with a zero length", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(emptyManifestBody(), { status: 200 }),
      [publicRawPath]: () => new Response("", { status: 200 }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("0");
    expect(await res.text()).toBe("");
  });

  test("a body larger than the manifest is not read past what was promised", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    // The failure this guards: both size gates test the MANIFEST's number, so
    // nothing bounds what upstream sends. Draining first and comparing after
    // would read a retagged recording into a 128 MB isolate in full -- a kill
    // that cannot even be caught and logged, taking every unrelated in-flight
    // request with it.
    const CHUNK = 64 * 1024;
    const TOTAL = 256;
    let pushed = 0;
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (pushed >= TOTAL) {
                controller.close();
                return;
              }
              pushed++;
              controller.enqueue(new Uint8Array(CHUNK));
              await Bun.sleep(0);
            },
          }),
        ),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    // The assertion that makes this a test rather than a duplicate of the
    // short/long ones: it is 502 either way, so only the byte count shows
    // whether the read was bounded.
    //
    // The bound is deliberately loose, and the tight one was wrong. `pushed`
    // counts chunks the SERVER produced, and the client performs exactly one
    // read: 64 KB already exceeds the 43 bytes the manifest promised, so
    // sizeCheckedBody cancels on the first chunk. But this stand-in is a real
    // Bun.serve over a real socket, so between the client's cancel and the
    // server noticing it, the server can write several chunks into socket
    // buffers. That count is a property of the kernel and of machine load, not
    // of this code: `< 4 * CHUNK` passed deterministically at 1 chunk unloaded
    // and failed in CI at exactly 4 under load.
    //
    // What is worth pinning is the memory claim -- a 16 MB body is not drained
    // into a 128 MB isolate, which is a kill that cannot be caught and logged
    // -- so the bound is an eighth of the body, far above any socket buffer
    // and far below draining. Cancellation itself cannot be asserted from
    // here: the server-side stream's cancel() is a different object and a real
    // HTTP server does not reliably forward the client's abort to it.
    expect(pushed).toBeLessThan(TOTAL / 8);
  });

  test("above the buffer ceiling it streams, with NO declared length", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: String(FILE_BODY.length - 1) },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILE_BODY);
    // THE assertion of this PR. Without it, restoring the unconditional
    // `headers.set("Content-Length", ...)` that #1420 shipped -- the change
    // that deployed and did not work -- passes the entire suite.
    expect(res.headers.get("Content-Length")).toBeNull();
  });

  test("a file exactly at the ceiling is buffered, not streamed", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: String(FILE_BODY.length) },
    );

    // "At or below" is the documented boundary, so the ceiling itself
    // buffers. Pins `>` against a drift to `>=`.
    expect(res.headers.get("Content-Length")).toBe(String(FILE_BODY.length));
  });

  test("a ceiling that is not a byte count falls back to the default", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    // "8MB" is the obvious spelling and the one this binding's doc comment
    // writes in prose. `Number.parseInt` would read it as EIGHT BYTES, put
    // every file in the catalog on the streamed branch, and reproduce #1419's
    // production symptom through a config typo, silently.
    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: "8MB" },
    );

    expect(res.headers.get("Content-Length")).toBe(String(FILE_BODY.length));
  });

  test("above the ceiling, a short body still fails the transfer", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(FILE_BODY.length + 10), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: "0" },
    );

    // Streamed: the status is committed before the length is known, so the
    // only honest refusal left is a transfer the client cannot complete. A
    // ceiling of 0 reaches this branch without a multi-megabyte fixture; what
    // it does NOT reproduce is the real shape, an 8-32 MB body arriving in
    // many chunks under backpressure.
    expect(res.status).toBe(200);
    expect(res.text()).rejects.toThrow(/did not match the manifest/);
  });

  test("above the ceiling, an upstream-declared mismatch is still a clean 502", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(999), { status: 200 }),
      [publicRawPath]: () =>
        new Response(FILE_BODY, {
          status: 200,
          headers: { "Content-Length": String(FILE_BODY.length) },
        }),
    });

    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: "0" },
    );

    // The only place the upstream-header fast path is still observable: on
    // the buffered branch it produces the same 502 as the measurement, so
    // deleting it changes nothing there. Here it is the difference between a
    // clean refusal and a 200 that aborts mid-transfer.
    expect(res.status).toBe(502);
  });

  test("a refused body is not recorded as bytes delivered, and a served one is", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const collecting = {
      ...env(db),
      ANALYTICS: {
        writeDataPoint: (p: { blobs: string[]; doubles: number[] }) => {
          points.push(p);
        },
      },
    } as unknown as Bindings;

    // Refused: the manifest promises more than upstream sends.
    reset({
      [manifestKey]: () => new Response(manifestBody(FILE_BODY.length + 10), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });
    const refused = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, collecting);
    expect(refused.status).toBe(502);
    expect(points).toEqual([]);

    // Served: the same collector, so the negative half above cannot pass by
    // `recordAccess` having been deleted outright.
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });
    const served = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, collecting);
    expect(served.status).toBe(200);
    expect(points).toHaveLength(1);
    expect(points[0].doubles[0]).toBe(FILE_BODY.length);
  });

  test("an upstream throttle is a 5xx with Retry-After, never a 404", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () =>
        new Response("slow down", { status: 429, headers: { "Retry-After": "30" } }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("a missing backing object contradicting a manifest entry is a 502, not a 404", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => new Response("nope", { status: 404 }),
      [`/repos/nemarDatasets/nm000862/git/blobs/${BLOB_SHA}`]: () =>
        new Response("nope", { status: 404 }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a private dataset 404s without a single upstream request", async () => {
    const db = freshDb();
    seed(db, "nm000862", "private");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => new Response(FILE_BODY, { status: 200 }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(404);
    // Not even the manifest is read: the gate is the first thing that runs,
    // so no token is minted and nothing about this dataset leaves the Worker.
    expect(seen).toHaveLength(0);
  });

  test("an unknown dataset 404s without a single upstream request", async () => {
    const db = freshDb();
    reset({ [manifestKey]: () => new Response(manifestBody(), { status: 200 }) });

    const res = await app().request(`/nm000863/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  describe("the edge cache (#1516)", () => {
    let originalCaches: unknown;

    beforeAll(() => {
      originalCaches = (globalThis as { caches?: unknown }).caches;
    });

    afterEach(() => {
      (globalThis as { caches?: unknown }).caches = originalCaches;
    });

    function install(cache: unknown): void {
      (globalThis as { caches?: unknown }).caches = { default: cache };
    }

    /** Same shape as `manifestBody`, naming an arbitrary sha and size --
     *  needed to simulate a manifest rewrite (ADR 0072) at the same path. */
    function manifestBodyNaming(sha: string, size: number): string {
      return JSON.stringify({
        dataset_id: "nm000862",
        version: "1.0.0",
        doi: null,
        concept_doi: null,
        created: "2026-01-01T00:00:00Z",
        files: { [PATH]: { key: `git:${sha}`, size, checksum: `git:${sha}` } },
      });
    }

    // A second real file body and its real git blob SHA (`git hash-object`),
    // standing in for what a manifest rewrite would point the same path at.
    const FILE_BODY_V2 = '{"Name":"A dataset","BIDSVersion":"1.12.0"}';
    const BLOB_SHA_V2 = "a4713cbe03fc942b472d586c7b8ddeb40b0b9124";

    function rawHits(): number {
      return seen.filter((s) => s.path === publicRawPath).length;
    }

    test("a miss fetches and stores; the identical next request is a hit with no upstream traffic", async () => {
      const cache = new DrainingCache();
      install(cache);
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });

      const first = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      expect(first.status).toBe(200);
      expect(await first.text()).toBe(FILE_BODY);
      expect(rawHits()).toBe(1);
      expect(
        cache.store.get(gitFileCacheKey("http://localhost", "nm000862", VERSION, PATH)),
      ).toBeDefined();

      const second = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      expect(second.status).toBe(200);
      expect(await second.text()).toBe(FILE_BODY);
      // The bytes came back with zero new requests to the raw host or the
      // blob API -- the strongest evidence available (under the PAT auth
      // this suite uses throughout) that no token mint was attempted either:
      // `getDatasetsToken` is called from inside `streamGitTrackedFile`,
      // which a hit never reaches at all.
      expect(rawHits()).toBe(1);
    });

    test("headers on a hit match what a miss would have sent, plus nothing extra", async () => {
      install(new DrainingCache());
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length), "Content-Type": "text/plain" },
          }),
      });
      const first = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      const second = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

      for (const name of [
        "Content-Type",
        "Content-Length",
        "ETag",
        "Cache-Control",
        "Access-Control-Allow-Origin",
        "X-Content-Type-Options",
        "Content-Security-Policy",
      ]) {
        expect(second.headers.get(name)).toBe(first.headers.get(name));
      }
      // No internal bookkeeping header leaks to the client.
      expect([...second.headers.keys()].some((k) => k.toLowerCase().includes("blob-sha"))).toBe(
        false,
      );
      expect(second.headers.has("X-Nemar-Cache-Client-Cache-Control")).toBe(false);
      // The literal value, not just "equal to the miss's" -- ADR 0066's
      // number, unchanged by #1516.
      expect(second.headers.get("Cache-Control")).toBe("public, max-age=300");
    });

    test("the stored copy's OWN freshness is not the client's 300s (review: the TTL bug)", async () => {
      // The bug this test exists to catch: an earlier version of this cache
      // reused the client-facing `public, max-age=300` verbatim as the
      // STORED response's own `Cache-Control`. The real Workers Cache API
      // honors that for the entry's OWN freshness, so `cache.match` would
      // have started answering `undefined` after 300 seconds regardless of
      // what the route decided -- defeating #1494's cross-session scenario
      // silently, since every symptom looks identical to "there was no
      // traffic in between." `DrainingCache.getNow` simulates the clock
      // advancing without a real five-minute sleep.
      const cache = new DrainingCache();
      install(cache);
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });

      const first = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      expect(first.status).toBe(200);
      const storedAt = Date.now();

      // 301 seconds later: past the CLIENT'S 300s Cache-Control, well inside
      // GIT_FILE_CACHE_TTL_SECONDS (seven days).
      cache.getNow = () => storedAt + 301_000;
      const hitsBefore = rawHits();
      const second = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

      expect(second.status).toBe(200);
      expect(await second.text()).toBe(FILE_BODY);
      // Still a hit: no new upstream request, and the client still sees
      // exactly today's 300s value, not the internal seven-day one.
      expect(rawHits()).toBe(hitsBefore);
      expect(second.headers.get("Cache-Control")).toBe("public, max-age=300");
    });

    test("a manifest rewrite (ADR 0072) makes the cached entry a miss, and the NEW blob is served and stored", async () => {
      install(new DrainingCache());
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });
      const first = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      expect(await first.text()).toBe(FILE_BODY);

      // Same path, a different blob -- exactly what a retag or a same-size
      // edit behind a moved tag looks like (ADR 0066's 2026-09-16 amendment).
      reset({
        [manifestKey]: () =>
          new Response(manifestBodyNaming(BLOB_SHA_V2, FILE_BODY_V2.length), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY_V2, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY_V2.length) },
          }),
      });

      const second = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      expect(second.status).toBe(200);
      expect(await second.text()).toBe(FILE_BODY_V2);
      // The rewrite forced a real upstream fetch: this is not the stale entry.
      expect(rawHits()).toBe(1);

      // And the replacement sticks: a third request answers from the cache
      // again, with the NEW content and no further upstream traffic.
      const third = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      expect(await third.text()).toBe(FILE_BODY_V2);
      expect(rawHits()).toBe(1);
    });

    test("a dataset that goes private is never served from the git-file cache", async () => {
      const cache = new DrainingCache();
      install(cache);
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });
      const first = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      expect(first.status).toBe(200);
      expect(cache.store.size).toBeGreaterThan(0);

      db.prepare("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?").run("nm000862");
      const matchesBefore = cache.matches;
      const hitsBefore = rawHits();

      const second = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

      expect(second.status).toBe(404);
      // The gate ran first and rejected the request before the cache was
      // ever asked (ADR 0066's amendment: nothing to purge, because nothing
      // reaches the cache without re-proving visibility first) -- not merely
      // that its answer went unused.
      expect(cache.matches).toBe(matchesBefore);
      expect(rawHits()).toBe(hitsBefore);
    });

    /** A Workers execution context: `waitUntil` collects, nothing else runs. */
    function executionContext() {
      const deferred: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (work: Promise<unknown>) => {
          deferred.push(work);
        },
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext;
      return { ctx, deferred };
    }

    test("a cache whose put never settles is handed to waitUntil, not awaited", async () => {
      const cache = new StalledCache();
      install(cache);
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });
      const { ctx, deferred } = executionContext();

      const started = performance.now();
      const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db), ctx);
      const elapsed = performance.now() - started;

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(FILE_BODY);
      // Far under GIT_FILE_CACHE_STALL_MS's no-waitUntil fallback bound: the
      // wedged put was handed off instead of being waited for.
      expect(elapsed).toBeLessThan(200);
      // Two writes share this one stalled cache: the git-file entry itself,
      // and the miss-budget counter (#1516 review) -- both handed to
      // waitUntil, neither awaited.
      expect(cache.puts).toBe(2);
      expect(deferred).toHaveLength(2);
    });

    test("without an execution context, a stalled cache write is bounded and the answer is still right", async () => {
      install(new StalledCache());
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });

      const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(FILE_BODY);
    }, 5_000);

    test("a cache that throws on match and on put still answers", async () => {
      const broken = {
        match: async () => {
          throw new Error("cache down");
        },
        put: async () => {
          throw new Error("cache down");
        },
      };
      install(broken);
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });

      const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(FILE_BODY);
    });

    test("above the buffer ceiling, the streamed branch is never cached", async () => {
      const cache = new DrainingCache();
      install(cache);
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () => streamed(FILE_BODY),
      });

      const res = await app().request(
        `/nm000862/${VERSION}/${PATH}`,
        {},
        { ...env(db), BROKER_BUFFER_MAX_BYTES: String(FILE_BODY.length - 1) },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Length")).toBeNull();
      // Not "the store is empty": it legitimately holds the miss-budget
      // counter entry (#1516 review) now, which shares this same cache. Only
      // the GIT-FILE entry itself must be absent.
      expect(
        cache.store.get(gitFileCacheKey("http://localhost", "nm000862", VERSION, PATH)),
      ).toBeUndefined();

      // And the next request fetches again -- there was nothing to answer from.
      const before = rawHits();
      await app().request(
        `/nm000862/${VERSION}/${PATH}`,
        {},
        { ...env(db), BROKER_BUFFER_MAX_BYTES: String(FILE_BODY.length - 1) },
      );
      expect(rawHits()).toBeGreaterThan(before);
    });

    test("HEAD is unaffected: same headers, and it never touches the cache", async () => {
      const cache = new DrainingCache();
      install(cache);
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });
      // Warm the cache with a GET first.
      await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      const gitFileEntryBefore = cache.store.get(
        gitFileCacheKey("http://localhost", "nm000862", VERSION, PATH),
      );
      expect(gitFileEntryBefore).toBeDefined();
      const hitsBefore = rawHits();

      const head = await app().request(`/nm000862/${VERSION}/${PATH}`, { method: "HEAD" }, env(db));
      expect(head.status).toBe(200);
      expect(head.headers.get("Content-Length")).toBe(String(FILE_BODY.length));
      expect(head.headers.get("ETag")).toBe(`"git:${BLOB_SHA}"`);
      expect(await head.text()).toBe("");
      // HEAD never reaches GitHub (unchanged from before #1516) and the
      // git-file cache entry it would have consulted is untouched -- HEAD's
      // own branch in `fileOrIndexHandler` returns before `serveGitTrackedFile`
      // is ever called.
      expect(rawHits()).toBe(hitsBefore);
      expect(
        cache.store.get(gitFileCacheKey("http://localhost", "nm000862", VERSION, PATH)),
      ).toEqual(gitFileEntryBefore);
    });

    test("a Range request is still ignored: full 200 body, on a hit exactly as on a miss", async () => {
      install(new DrainingCache());
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });
      const miss = await app().request(
        `/nm000862/${VERSION}/${PATH}`,
        { headers: { Range: "bytes=0-3" } },
        env(db),
      );
      expect(miss.status).toBe(200);
      expect(await miss.text()).toBe(FILE_BODY);

      const hit = await app().request(
        `/nm000862/${VERSION}/${PATH}`,
        { headers: { Range: "bytes=0-3" } },
        env(db),
      );
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(FILE_BODY);
    });

    test("Server-Timing is present and well formed, with `upstream` only when it ran", async () => {
      function parse(header: string | null): Record<string, number> {
        expect(header).not.toBeNull();
        const out: Record<string, number> = {};
        for (const part of (header as string).split(", ")) {
          // `manifest` alone may carry a trailing `;desc="..."` naming which
          // trust-window tier answered it (#1494 amendment); the other
          // stages never do.
          const m = part.match(
            /^(gate|manifest|cache|upstream);dur=(\d+(?:\.\d+)?)(?:;desc="\w+")?$/,
          );
          expect(m).not.toBeNull();
          if (m) out[m[1]] = Number(m[2]);
        }
        return out;
      }

      install(new DrainingCache());
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });

      const miss = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      const missTiming = parse(miss.headers.get("Server-Timing"));
      expect(missTiming.gate).toBeGreaterThanOrEqual(0);
      expect(missTiming.manifest).toBeGreaterThanOrEqual(0);
      expect(missTiming.cache).toBeGreaterThanOrEqual(0);
      expect(missTiming.upstream).toBeGreaterThanOrEqual(0);

      const hit = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      const hitTiming = parse(hit.headers.get("Server-Timing"));
      expect(hitTiming.cache).toBeGreaterThanOrEqual(0);
      // No upstream stage ran on a hit.
      expect(hitTiming.upstream).toBeUndefined();
    });

    test("without an edge cache at all (no globalThis.caches), the route behaves exactly as before #1516", async () => {
      (globalThis as { caches?: unknown }).caches = undefined;
      const db = freshDb();
      seed(db, "nm000862", "public");
      reset({
        [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
        [publicRawPath]: () =>
          new Response(FILE_BODY, {
            status: 200,
            headers: { "Content-Length": String(FILE_BODY.length) },
          }),
      });
      const first = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      const second = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
      expect(await first.text()).toBe(FILE_BODY);
      expect(await second.text()).toBe(FILE_BODY);
      // No cache anywhere -- every GET is a real upstream fetch.
      expect(rawHits()).toBe(2);
    });

    describe("the miss budget (#1516 review)", () => {
      const PATH2 = "CHANGES.md";
      const SECOND_BODY = "nothing changed";
      const SECOND_BLOB_SHA = "f906b97310d39c554b0f699aea54901533f2076b";
      const ANNEX_PATH = "sub-01/eeg/data.set";
      const ANNEX_OBJECT_PATH = "/nm000862/objects/SHA256E-s10--aaaa.set";
      const MISS_IP = "203.0.113.50";
      const secondRawPath = `/nemarDatasets/nm000862/${VERSION}/${PATH2}`;

      function manifestBodyTwoFilesAndAnAnnex(): string {
        return JSON.stringify({
          dataset_id: "nm000862",
          version: "1.0.0",
          doi: null,
          concept_doi: null,
          created: "2026-01-01T00:00:00Z",
          files: {
            [PATH]: { key: `git:${BLOB_SHA}`, size: FILE_BODY.length, checksum: `git:${BLOB_SHA}` },
            [PATH2]: {
              key: `git:${SECOND_BLOB_SHA}`,
              size: SECOND_BODY.length,
              checksum: `git:${SECOND_BLOB_SHA}`,
            },
            [ANNEX_PATH]: { key: "SHA256E-s10--aaaa.set", size: 10, checksum: "sha256:aaaa" },
          },
        });
      }

      /** Seed the miss budget's own counter directly, the same shape
       *  `checkDataMissBudget` itself writes, so a test can put the counter
       *  AT the limit without a 10,000-request loop. */
      function seedMissBudgetCount(cache: DrainingCache, ip: string, count: number): void {
        cache.store.set(`https://rate-limit.internal/rl:data-miss-ip:${ip}`, {
          body: new TextEncoder().encode(JSON.stringify({ count })),
          status: 200,
          headers: new Headers({
            "Content-Type": "application/json",
            "Cache-Control": "max-age=60",
          }),
          // Without this, the stricter cache double (#1516 review) treats a
          // directly-injected entry as stored at time 0 and therefore always
          // already past its own 60s max-age -- the exact class of bug that
          // review caught in the git-file cache itself.
          storedAtMs: cache.getNow(),
        });
      }

      test("a miss counts toward its own per-IP budget, independent of data-ip, and trips at the limit", async () => {
        const cache = new DrainingCache();
        install(cache);
        const db = freshDb();
        seed(db, "nm000862", "public");
        reset({
          [manifestKey]: () => new Response(manifestBodyTwoFilesAndAnAnnex(), { status: 200 }),
          [publicRawPath]: () =>
            new Response(FILE_BODY, {
              status: 200,
              headers: { "Content-Length": String(FILE_BODY.length) },
            }),
          [secondRawPath]: () =>
            new Response(SECOND_BODY, {
              status: 200,
              headers: { "Content-Length": String(SECOND_BODY.length) },
            }),
        });
        seedMissBudgetCount(cache, MISS_IP, __limits.DATA_MISS_MAX_REQUESTS - 1);

        // The request that reaches the limit: still a genuine miss, still served.
        const atLimit = await app().request(
          `/nm000862/${VERSION}/${PATH}`,
          { headers: { "CF-Connecting-IP": MISS_IP } },
          env(db),
        );
        expect(atLimit.status).toBe(200);
        expect(await atLimit.text()).toBe(FILE_BODY);

        // A second, DIFFERENT file -- still a genuine miss -- is refused.
        const overLimit = await app().request(
          `/nm000862/${VERSION}/${PATH2}`,
          { headers: { "CF-Connecting-IP": MISS_IP } },
          env(db),
        );
        expect(overLimit.status).toBe(429);
        expect(overLimit.headers.get("X-RateLimit-Bucket")).toBe("data-miss-ip");
        expect(overLimit.headers.get("Retry-After")).toBe("60");
        expect(overLimit.headers.get("X-RateLimit-Remaining")).toBe("0");
        expect(await overLimit.json()).toMatchObject({ error: "Rate limit exceeded" });
      });

      test("a hit is still served after the miss budget is exhausted", async () => {
        const cache = new DrainingCache();
        install(cache);
        const db = freshDb();
        seed(db, "nm000862", "public");
        reset({
          [manifestKey]: () => new Response(manifestBodyTwoFilesAndAnAnnex(), { status: 200 }),
          [publicRawPath]: () =>
            new Response(FILE_BODY, {
              status: 200,
              headers: { "Content-Length": String(FILE_BODY.length) },
            }),
          [secondRawPath]: () =>
            new Response(SECOND_BODY, {
              status: 200,
              headers: { "Content-Length": String(SECOND_BODY.length) },
            }),
        });

        // Warm the content cache for PATH from an UNTHROTTLED IP first.
        const warm = await app().request(
          `/nm000862/${VERSION}/${PATH}`,
          { headers: { "CF-Connecting-IP": "203.0.113.51" } },
          env(db),
        );
        expect(warm.status).toBe(200);

        // Now exhaust the miss budget for a DIFFERENT ip.
        seedMissBudgetCount(cache, MISS_IP, __limits.DATA_MISS_MAX_REQUESTS);
        const missRefused = await app().request(
          `/nm000862/${VERSION}/${PATH2}`,
          { headers: { "CF-Connecting-IP": MISS_IP } },
          env(db),
        );
        expect(missRefused.status).toBe(429);

        // The already-cached PATH is still served to the SAME exhausted IP --
        // a hit is never charged against, or blocked by, the miss budget.
        const hitStillServed = await app().request(
          `/nm000862/${VERSION}/${PATH}`,
          { headers: { "CF-Connecting-IP": MISS_IP } },
          env(db),
        );
        expect(hitStillServed.status).toBe(200);
        expect(await hitStillServed.text()).toBe(FILE_BODY);
      });

      test("HEAD, a verified plain-annex redirect, and an ordinary 404 do not count against the miss budget", async () => {
        const cache = new DrainingCache();
        install(cache);
        const db = freshDb();
        seed(db, "nm000862", "public");
        reset({
          [manifestKey]: () => new Response(manifestBodyTwoFilesAndAnAnnex(), { status: 200 }),
          [publicRawPath]: () =>
            new Response(FILE_BODY, {
              status: 200,
              headers: { "Content-Length": String(FILE_BODY.length) },
            }),
          [ANNEX_OBJECT_PATH]: () =>
            new Response(null, { status: 200, headers: { "Content-Length": "10" } }),
        });
        seedMissBudgetCount(cache, MISS_IP, __limits.DATA_MISS_MAX_REQUESTS - 1);

        const head = await app().request(
          `/nm000862/${VERSION}/${PATH2}`,
          { method: "HEAD", headers: { "CF-Connecting-IP": MISS_IP } },
          env(db),
        );
        expect(head.status).toBe(200);

        const redirect = await app().request(
          `/nm000862/${VERSION}/${ANNEX_PATH}`,
          { headers: { "CF-Connecting-IP": MISS_IP }, redirect: "manual" },
          env(db),
        );
        expect(redirect.status).toBe(302);

        const notFound = await app().request(
          `/nm000862/${VERSION}/does-not-exist.json`,
          { headers: { "CF-Connecting-IP": MISS_IP } },
          env(db),
        );
        expect(notFound.status).toBe(404);

        // None of the three spent the one remaining slot: this genuine miss
        // is still the request AT the limit, not over it.
        const stillAllowed = await app().request(
          `/nm000862/${VERSION}/${PATH}`,
          { headers: { "CF-Connecting-IP": MISS_IP } },
          env(db),
        );
        expect(stillAllowed.status).toBe(200);
      });

      test("an exhausted budget still costs a COLD manifest fetch: the budget is charged AFTER the manifest resolves, not before (0.10.8 review)", async () => {
        // `serveGitTrackedFile` (routes/data.ts) -- where `checkDataMissBudget`
        // is called -- only runs once `fileOrIndexHandler` has already resolved
        // the manifest and named a git-tracked file entry to serve. So an IP at
        // its miss-budget limit is refused the UPSTREAM git-content fetch, but
        // NOT the manifest read that had to happen first to even know this was
        // a git-tracked file. This pins that ordering: without any pre-warm at
        // all for this dataset/version, the request still costs one manifest
        // fetch before it is refused.
        const cache = new DrainingCache();
        install(cache);
        const db = freshDb();
        seed(db, "nm000862", "public");
        reset({
          [manifestKey]: () => new Response(manifestBodyTwoFilesAndAnAnnex(), { status: 200 }),
          [publicRawPath]: () =>
            new Response(FILE_BODY, {
              status: 200,
              headers: { "Content-Length": String(FILE_BODY.length) },
            }),
        });
        seedMissBudgetCount(cache, MISS_IP, __limits.DATA_MISS_MAX_REQUESTS);

        const res = await app().request(
          `/nm000862/${VERSION}/${PATH}`,
          { headers: { "CF-Connecting-IP": MISS_IP } },
          env(db),
        );

        expect(res.status).toBe(429);
        // The manifest WAS fetched: the budget did not, and structurally
        // cannot, protect this cold read.
        expect(seen.filter((s) => s.path === manifestKey)).toHaveLength(1);
        // But the upstream git-content fetch never happened: THAT is what the
        // budget actually refused.
        expect(seen.some((s) => s.path === publicRawPath)).toBe(false);
      });
    });

    describe("the manifest trust window and answer memo (0.10.8 review)", () => {
      // Every fixture above answers `manifestKey` with NO `ETag` header, which
      // means the manifest edge copy is never actually stored (`fromS3`'s sink
      // is only built `source.cache && etag ? ... : null`) and every request in
      // this whole file re-fetches the manifest from "S3" from scratch --
      // the trust window (`manifest-source.ts`) and the per-isolate answer
      // memo (`manifest-answer-memo.ts`) never engage here at all. These tests
      // give the manifest a real, content-derived ETag (mirroring
      // `helpers/s3-manifest-standin.ts`'s `etagFor`) so that machinery is
      // actually exercised through this file's real GET route, alongside the
      // git-file cache it sits in front of.
      function etagFor(body: string): string {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(body);
        return `"${hasher.digest("hex")}"`;
      }

      /** `Server-Timing`'s `manifest` stage carries `desc="<source>"` (#1494
       *  amendment): "memo" or "fresh" never asked S3 at all. */
      function manifestDesc(res: Response): string | undefined {
        return res.headers.get("Server-Timing")?.match(/manifest;dur=[\d.]+;desc="(\w+)"/)?.[1];
      }

      function manifestHits(): number {
        return seen.filter((s) => s.path === manifestKey).length;
      }

      /** Same monkey-patch `data-route-manifest-stream.test.ts` uses: the
       *  route builds its own `ManifestSource` per request with no clock seam
       *  exposed to a caller, so pushing a cached copy outside the trust
       *  window without a real 60s sleep means patching the global clock. */
      async function withClockAdvanced<T>(ms: number, fn: () => Promise<T>): Promise<T> {
        const real = Date.now;
        Date.now = () => real() + ms;
        try {
          return await fn();
        } finally {
          Date.now = real;
        }
      }

      test("a same-window repeat hits the memo; a manifest rewrite inside the window still serves the OLD blob until the window passes, then the NEW one", async () => {
        install(new DrainingCache());
        resetManifestAnswerMemo();
        const db = freshDb();
        seed(db, "nm000862", "public");

        const bodyV1 = manifestBody();
        reset({
          [manifestKey]: () =>
            new Response(bodyV1, { status: 200, headers: { ETag: etagFor(bodyV1) } }),
          [publicRawPath]: () =>
            new Response(FILE_BODY, {
              status: 200,
              headers: { "Content-Length": String(FILE_BODY.length) },
            }),
        });

        // Cold: a real manifest fetch and a real upstream fetch.
        const first = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
        expect(first.status).toBe(200);
        expect(await first.text()).toBe(FILE_BODY);
        expect(manifestHits()).toBe(1);
        expect(rawHits()).toBe(1);

        // A same-window repeat: the per-isolate answer memo already holds this
        // exact (dataset, version, ETag, query) answer, so neither the
        // manifest nor the git-tracked file is asked for again.
        const second = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
        expect(second.status).toBe(200);
        expect(await second.text()).toBe(FILE_BODY);
        expect(manifestDesc(second)).toBe("memo");
        expect(manifestHits()).toBe(1);
        expect(rawHits()).toBe(1);

        // Rewrite the manifest to point PATH at a DIFFERENT blob (a retag,
        // ADR 0066's 2026-09-16 amendment) -- still inside the trust window,
        // no time advanced. `reset` swaps in the new routes AND clears `seen`,
        // so the counts below are fresh from this point.
        const bodyV2 = manifestBodyNaming(BLOB_SHA_V2, FILE_BODY_V2.length);
        reset({
          [manifestKey]: () =>
            new Response(bodyV2, { status: 200, headers: { ETag: etagFor(bodyV2) } }),
          [publicRawPath]: () =>
            new Response(FILE_BODY_V2, {
              status: 200,
              headers: { "Content-Length": String(FILE_BODY_V2.length) },
            }),
        });
        const third = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));
        expect(third.status).toBe(200);
        // Still the OLD bytes: the edge copy (and the memo keyed under its
        // ETag) is trusted for the whole window, so the rewrite above is
        // invisible until it passes -- neither "S3" nor the raw host was asked.
        expect(await third.text()).toBe(FILE_BODY);
        expect(manifestHits()).toBe(0);
        expect(rawHits()).toBe(0);

        // Advance past the 60s trust window (no further `reset`, so the v2
        // routes above are still in effect): the manifest read now revalidates
        // for real, sees the new ETag, and the NEW blob is fetched and served.
        const fourth = await withClockAdvanced(MANIFEST_TRUST_WINDOW_MS + 1, () =>
          app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db)),
        );
        expect(fourth.status).toBe(200);
        expect(await fourth.text()).toBe(FILE_BODY_V2);
        expect(manifestHits()).toBe(1);
        expect(rawHits()).toBe(1);
      });
    });
  });
});
