/**
 * The repair that puts a stranded concept DOI onto `main` (#1386).
 *
 * `test/concept-doi-description.test.ts` covers the pure edit. This covers the
 * program: which datasets it calls `ok`, `needs-repair` or `skipped`, and above
 * all the gate its header promises -- two independent witnesses agreeing on the
 * concept DOI before anything is written to published metadata.
 *
 * Driven against Bun.serve stand-ins for both sources: the NEMAR API (which is
 * D1's answer) and the GitHub Contents API (which is the repository's). Both
 * record what they were asked, so the assertions are about what was actually sent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

interface Recorded {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

// What these held before this file touched them. `bun test` runs every file in one process, so
// they are put back in afterAll: gone if they were unset (assigning `undefined` would store the
// STRING "undefined"), their old value otherwise.
const originalApiBase = process.env.NEMAR_API_BASE;
const originalGhToken = process.env.GH_TOKEN;

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = original;
}

let github: ReturnType<typeof Bun.serve>;
let api: ReturnType<typeof Bun.serve>;
const seen: Recorded[] = [];

/** What each stand-in should say. Per-test, reset in afterEach. */
const state = {
  /** D1's concept DOI for the dataset. */
  conceptDoi: "10.82901/nemar.on002720" as string | null,
  /** `dataset_description.json` and `README.md` per ref. */
  files: new Map<string, string>(),
};

const CONCEPT = "10.82901/nemar.on002720";
const UPSTREAM = "10.18112/openneuro.ds002720.v1.0.1";

function key(ref: string, path: string): string {
  return `${ref}:${path}`;
}

let inspect: typeof import("../scripts/repair-doi-metadata").inspect;

beforeAll(async () => {
  api = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/datasets/")) {
        return state.conceptDoi === null
          ? new Response('{"error":"not found"}', { status: 404 })
          : Response.json({ dataset: { concept_doi: state.conceptDoi } });
      }
      return new Response("{}", { status: 404 });
    },
  });
  github = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let body: Record<string, unknown> | null = null;
      if (request.method !== "GET") {
        body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      }
      seen.push({ method: request.method, path: url.pathname, query: url.search, body });

      const match = url.pathname.match(/\/repos\/nemarDatasets\/[^/]+\/contents\/(.+)$/);
      if (match) {
        const path = decodeURIComponent(match[1]);
        if (request.method === "GET") {
          const ref = url.searchParams.get("ref") ?? "";
          const content = state.files.get(key(ref, path));
          return content === undefined
            ? new Response('{"message":"Not Found"}', { status: 404 })
            : Response.json({
                sha: `sha-${ref}`,
                content: Buffer.from(content).toString("base64"),
                encoding: "base64",
              });
        }
        const branch = String(body?.branch ?? "");
        state.files.set(
          key(branch, path),
          Buffer.from(String(body?.content ?? ""), "base64").toString("utf8"),
        );
        return Response.json({ content: { sha: "written" } });
      }
      return new Response('{"message":"unexpected"}', { status: 500 });
    },
  });

  process.env.NEMAR_API_BASE = `http://127.0.0.1:${api.port}`;
  process.env.GH_TOKEN = "test-token";
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${github.port}`;
  ({ inspect } = await import("../scripts/repair-doi-metadata"));
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  restoreEnv("NEMAR_API_BASE", originalApiBase);
  restoreEnv("GH_TOKEN", originalGhToken);
  github.stop(true);
  api.stop(true);
});

afterEach(() => {
  seen.length = 0;
  state.conceptDoi = CONCEPT;
  state.files = new Map();
});

/** A repository in the state #1386 left: main stale, the concept DOI on git-annex. */
function seedStranded(): void {
  state.files.set(
    key("main", "dataset_description.json"),
    JSON.stringify({ Name: "ds", DatasetDOI: UPSTREAM, Version: "1.0.1" }),
  );
  state.files.set(key("main", "README.md"), "# ds\n\nA dataset.\n");
  state.files.set(
    key("git-annex", "dataset_description.json"),
    JSON.stringify({ Name: "ds", DatasetDOI: CONCEPT, Version: "1.0.1" }),
  );
}

describe("inspect", () => {
  test("a stranded dataset needs repair, and both witnesses were consulted", async () => {
    seedStranded();
    const verdict = await inspect("on002720", "pat");

    expect(verdict.action).toBe("needs-repair");
    expect(verdict.conceptDoi).toBe(CONCEPT);
    expect(verdict.mainDoi).toBe(UPSTREAM);
    expect(verdict.strandedDoi).toBe(CONCEPT);
    // The gate the header promises is a real read, not a claim.
    expect(seen.some((r) => r.query === "?ref=git-annex")).toBe(true);
    expect(seen.some((r) => r.query === "?ref=main")).toBe(true);
  });

  test("REFUSES when the two witnesses disagree", async () => {
    // A re-minted or rolled-back DOI. Writing D1's answer here would put a
    // confidently wrong DOI onto published metadata, and the post-write check --
    // which compares main against that same D1 value -- would agree with itself
    // and report it repaired.
    seedStranded();
    state.files.set(
      key("git-annex", "dataset_description.json"),
      JSON.stringify({ DatasetDOI: "10.82901/nemar.SOMETHING-ELSE" }),
    );

    const verdict = await inspect("on002720", "pat");

    expect(verdict.action).toBe("skipped");
    expect(verdict.detail).toContain("refusing to guess");
    expect(seen.some((r) => r.method === "PUT")).toBe(false);
  });

  test("a dataset the catalog has no DOI for is skipped, not failed", async () => {
    state.conceptDoi = null;
    seedStranded();
    const verdict = await inspect("on002720", "pat");
    expect(verdict.action).toBe("skipped");
    expect(verdict.detail).toContain("no concept DOI");
  });

  test("a repository with no dataset_description.json on main fails", async () => {
    state.files.set(key("main", "README.md"), "# ds\n");
    const verdict = await inspect("on002720", "pat");
    expect(verdict.action).toBe("failed");
    expect(verdict.detail).toContain("no dataset_description.json");
  });

  test("a README that only mentions the DOI in prose is not a badge", async () => {
    // Two definitions of "has a badge" used to disagree, and the looser one gated
    // the verdict: a dataset whose DatasetDOI was already right but whose README
    // merely cited the DOI was reported `ok` and never got a badge.
    state.files.set(
      key("main", "dataset_description.json"),
      JSON.stringify({ Name: "ds", DatasetDOI: CONCEPT }),
    );
    state.files.set(key("main", "README.md"), `# ds\n\nCite as ${CONCEPT}.\n`);
    state.files.set(
      key("git-annex", "dataset_description.json"),
      JSON.stringify({ DatasetDOI: CONCEPT }),
    );

    const verdict = await inspect("on002720", "pat");

    expect(verdict.badgeOnMain).toBe(false);
    expect(verdict.action).toBe("needs-repair");
  });

  test("a dataset already carrying the DOI and a real badge is ok", async () => {
    state.files.set(
      key("main", "dataset_description.json"),
      JSON.stringify({ Name: "ds", DatasetDOI: CONCEPT }),
    );
    state.files.set(
      key("main", "README.md"),
      `[![DOI](https://img.shields.io/badge/DOI-${encodeURIComponent(CONCEPT)}-blue)](https://doi.org/${CONCEPT})\n\n# ds\n`,
    );
    state.files.set(
      key("git-annex", "dataset_description.json"),
      JSON.stringify({ DatasetDOI: CONCEPT }),
    );

    const verdict = await inspect("on002720", "pat");

    expect(verdict.badgeOnMain).toBe(true);
    expect(verdict.action).toBe("ok");
  });

  test("a repository with nothing on git-annex still inspects, with no second witness", async () => {
    // Not every dataset has a stranded write; those are repairable only when named
    // explicitly, which is what the --apply/--scan split enforces.
    state.files.set(
      key("main", "dataset_description.json"),
      JSON.stringify({ Name: "ds", DatasetDOI: UPSTREAM }),
    );
    state.files.set(key("main", "README.md"), "# ds\n");

    const verdict = await inspect("on002720", "pat");

    expect(verdict.strandedDoi).toBeNull();
    expect(verdict.action).toBe("needs-repair");
  });
});
