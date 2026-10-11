/**
 * branchExists and getMainBranchSha: the two readers of a branch's ref.
 *
 * The availability-report writer asks branchExists before committing, so that
 * the Contents API never creates `main` on an empty dataset repository
 * (#1643, nm000358: the report became an unrelated root commit on `main` while
 * the upload was still running, and every push of the upload was then rejected
 * as non-fast-forward).
 *
 * A local server stands in for api.github.com through the NEMAR_GITHUB_API_URL
 * override the other GitHub-facing suites use. Each repository name below
 * selects one behavior, and the server records every request so the tests
 * assert on what was actually sent, not on what the code says it did.
 *
 * The 409 body is what api.github.com returns for an empty repository
 * (`{"message":"Git Repository is empty."}`, observed on two empty public
 * repositories on 2026-10-07; it is not in GitHub's reference). An anonymous
 * ref lookup on a private repository answers 404, which is why a 404 is
 * ambiguous and branchExists probes the repository on one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { branchExists, getMainBranchSha } from "../src/services/github/contents";
import {
  __resetRateLimitStateForTests,
  __seedRateLimitStateForTests,
} from "../src/services/github/transport";
import { HttpError } from "../src/services/retry";
import { rejection } from "./helpers/rejection";

type Responder = () => Response;

const SHA_A = "a".repeat(40);
const refOk = () => Response.json({ ref: "refs/heads/main", object: { sha: SHA_A } });
const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });

/** repo -> what its ref lookup answers. */
const refBehavior = new Map<string, Responder>();
/** repo -> what the repository probe answers; absent means a visible repository. */
const repoBehavior = new Map<string, Responder>();

let server: ReturnType<typeof Bun.serve>;
/** "METHOD pathname" of every request, in order. */
const seen: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}`);
      const ref = /^\/repos\/nemarDatasets\/([^/]+)\/git\/ref\/heads\/.+$/.exec(url.pathname);
      if (ref) {
        return (
          refBehavior.get(ref[1] ?? "") ??
          (() => Response.json({ message: "boom" }, { status: 500 }))
        )();
      }
      const repoProbe = /^\/repos\/nemarDatasets\/([^/]+)$/.exec(url.pathname);
      if (repoProbe) {
        const responder = repoBehavior.get(repoProbe[1] ?? "");
        return responder ? responder() : Response.json({ full_name: "nemarDatasets/x" });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
  __resetRateLimitStateForTests();
});

beforeEach(() => {
  seen.length = 0;
  refBehavior.clear();
  repoBehavior.clear();
  __resetRateLimitStateForTests();
});

const REF = (repo: string, branch = "main") =>
  `GET /repos/nemarDatasets/${repo}/git/ref/heads/${branch}`;
const REPO = (repo: string) => `GET /repos/nemarDatasets/${repo}`;

describe("branchExists", () => {
  test("an existing branch is true", async () => {
    refBehavior.set("nm000360", refOk);
    expect(await branchExists("nm000360", "main", "pat")).toBe(true);
    expect(seen).toEqual([REF("nm000360")]);
  });

  test("a missing branch in a visible repository (404, then a 200 probe) is false, without retrying", async () => {
    refBehavior.set("nm000361", notFound);
    expect(await branchExists("nm000361", "main", "pat")).toBe(false);
    // One ref lookup and one probe: a 404 is not retried as a propagation delay.
    expect(seen).toEqual([REF("nm000361"), REPO("nm000361")]);
  });

  test("a 404 on the ref AND on the repository is an error, not 'no branch'", async () => {
    refBehavior.set("nm000363", notFound);
    repoBehavior.set("nm000363", notFound);

    const err = await rejection(branchExists("nm000363", "main", "pat"));

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).message).toContain("repository not visible to NEMAR");
    expect(seen).toEqual([REF("nm000363"), REPO("nm000363")]);
  });

  test("an unexpected status on the repository probe throws it", async () => {
    refBehavior.set("nm000364", notFound);
    repoBehavior.set("nm000364", () => Response.json({ message: "Forbidden" }, { status: 403 }));

    const err = await rejection(branchExists("nm000364", "main", "pat"));

    expect((err as HttpError).status).toBe(403);
  });

  test("an empty repository (409 'Git Repository is empty') is false, with no probe and no retry", async () => {
    refBehavior.set("nm000358", () =>
      Response.json({ message: "Git Repository is empty." }, { status: 409 }),
    );
    expect(await branchExists("nm000358", "main", "pat")).toBe(false);
    expect(seen).toEqual([REF("nm000358")]);
  });

  test("a 409 that does not say the repository is empty throws", async () => {
    refBehavior.set("nm000365", () =>
      Response.json({ message: "Reference update conflict" }, { status: 409 }),
    );

    const err = await rejection(branchExists("nm000365", "main", "pat"));

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
  });

  test("a 2xx that is not a ref (a proxy's HTML page) throws instead of reading as 'main exists'", async () => {
    refBehavior.set(
      "nm000366",
      () => new Response("<html>Sign in to continue</html>", { status: 200 }),
    );

    const err = await rejection(branchExists("nm000366", "main", "pat"));

    expect((err as Error).message).toContain("Unexpected response format");
  });

  test("a 2xx JSON body without object.sha throws", async () => {
    refBehavior.set("nm000367", () => Response.json({ ref: "refs/heads/main" }));

    const err = await rejection(branchExists("nm000367", "main", "pat"));

    expect((err as Error).message).toContain("Unexpected response format");
  });

  test("any other failure (an immediate 403) throws after one request", async () => {
    refBehavior.set("nm000368", () =>
      Response.json({ message: "Resource not accessible" }, { status: 403 }),
    );

    const err = await rejection(branchExists("nm000368", "main", "pat"));

    expect((err as HttpError).status).toBe(403);
    expect(seen).toEqual([REF("nm000368")]);
  });

  // Bounded policy (interactive kind, one attempt): none of these may sleep or
  // retry. With the default background policy each of them costs a second or
  // more of wall clock and extra requests, and a drained bucket costs a minute.
  test("a 500 is not retried", async () => {
    refBehavior.set("nm000369", () => Response.json({ message: "boom" }, { status: 500 }));

    const err = await rejection(branchExists("nm000369", "main", "pat"));

    expect((err as HttpError).status).toBe(500);
    expect(seen).toEqual([REF("nm000369")]);
  });

  test("a secondary rate limit with Retry-After throws at once instead of sleeping", async () => {
    refBehavior.set(
      "nm000370",
      () =>
        new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
          status: 403,
          headers: { "Retry-After": "30" },
        }),
    );

    const started = Date.now();
    const err = await rejection(branchExists("nm000370", "main", "pat"));

    expect((err as HttpError).status).toBe(403);
    expect(seen).toEqual([REF("nm000370")]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a drained rate-limit bucket throws 503 at once, before any request, instead of sleeping until reset", async () => {
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 0,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });
    refBehavior.set("nm000371", refOk);

    const started = Date.now();
    const err = await rejection(branchExists("nm000371", "main", "pat"));

    expect((err as HttpError).status).toBe(503);
    expect((err as HttpError).message).toContain("rate limit");
    expect(seen).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // The branch is encoded per path segment: `/` stays a separator, while `#`,
  // `?` and `%` cannot change the URL. GitHub accepts `release%2F1.0` too, so
  // the exact path asserted on `seen` pins the URL the builder produces, not a
  // requirement of the API.
  test("a branch containing a slash keeps the slash in the ref path", async () => {
    refBehavior.set("nm000362", refOk);
    expect(await branchExists("nm000362", "release/1.0", "pat")).toBe(true);
    expect(seen).toEqual([REF("nm000362", "release/1.0")]);
  });

  test("a segment with URL-significant characters is escaped", async () => {
    // Raw, '#' would start a fragment and the request would name `feature/a b`.
    refBehavior.set("nm000362", refOk);
    expect(await branchExists("nm000362", "feature/a b#c", "pat")).toBe(true);
    expect(seen).toEqual([REF("nm000362", "feature/a%20b%23c")]);
  });
});

// getMainBranchSha shares branchExists' request, so the same URL rules hold
// for it; it differs in retrying a 404 (its caller knows the branch exists)
// and in throwing instead of answering "no".
describe("getMainBranchSha (shares branchExists' ref request)", () => {
  test("resolves the sha of an existing branch", async () => {
    refBehavior.set("nm000360", refOk);
    expect(await getMainBranchSha("nm000360", "main", "pat")).toBe(SHA_A);
  });

  test("resolves a slash-containing branch", async () => {
    refBehavior.set("nm000362", refOk);
    expect(await getMainBranchSha("nm000362", "release/1.0", "pat")).toBe(SHA_A);
    expect(seen).toEqual([REF("nm000362", "release/1.0")]);
  });

  test("an empty repository (409) throws the HTTP error instead of answering", async () => {
    refBehavior.set("nm000358", () =>
      Response.json({ message: "Git Repository is empty." }, { status: 409 }),
    );
    await expect(getMainBranchSha("nm000358", "main", "pat")).rejects.toThrow(
      "Failed to get main branch ref: HTTP 409",
    );
  });

  // retryOn404 is what separates it from branchExists: a ref GitHub has not
  // propagated yet is a 404 that resolves a moment later.
  test("a 404 is retried: 404 once, then 200, resolves after two requests", async () => {
    let lookups = 0;
    refBehavior.set("nm000372", () => (++lookups === 1 ? notFound() : refOk()));

    expect(await getMainBranchSha("nm000372", "main", "pat")).toBe(SHA_A);

    expect(seen).toEqual([REF("nm000372"), REF("nm000372")]);
  });

  test("a permanent 404 is attempted three times, then throws the 404", async () => {
    refBehavior.set("nm000373", notFound);

    const err = await rejection(getMainBranchSha("nm000373", "main", "pat"));

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(seen).toEqual([REF("nm000373"), REF("nm000373"), REF("nm000373")]);
  });

  test("a 2xx that is not a ref throws", async () => {
    refBehavior.set("nm000374", () => new Response("<html></html>", { status: 200 }));

    const err = await rejection(getMainBranchSha("nm000374", "main", "pat"));

    expect((err as Error).message).toContain("Unexpected response format");
  });
});
