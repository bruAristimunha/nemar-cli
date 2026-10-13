/**
 * CLI facet-flag behaviour driven through the real `nemar dataset list` /
 * `nemar dataset search` entry points (epic #1144 phase 4, #1148 -- plan
 * verification cases 2 through 6).
 *
 * Every case spawns the actual CLI from source (`bun run src/index.ts ...`),
 * the same subprocess pattern test/manifest.test.ts and test/cli.test.ts use,
 * pointed at a REAL local HTTP server via TEST_API_URL
 * (src/lib/api/client.ts#getApiUrl). Subprocess, not an in-process Commander
 * call, because a bad range/enum value makes the command call
 * `process.exit(1)` -- in-process that would kill the test runner itself.
 *
 * The local server is a real transport-layer boundary, not a mock of
 * business logic: it records every request that actually arrives and
 * returns a fixed, schema-shaped envelope. "Zero requests recorded" is proof
 * a bad value never reached the network -- not an inference from timing --
 * and "the recorded request's query string" is what the CLI's own
 * `fetch()` call actually sent, not a re-implementation of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { FACETS, type FacetDefinition } from "../shared/facets";
import { MAX_MODALITY_FILTER_TOKENS, MODALITY_FILTER_CLI_HELP } from "../shared/modality-filter";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface CaptureServer {
  url: string;
  requests: URL[];
  stop: () => void;
}

function startCaptureServer(body: unknown, status = 200): CaptureServer {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // Every real `nemar` invocation fires a `GET /notices` preAction hook
      // (src/index.ts) before the command itself runs (fetchAndDisplayNotices,
      // src/lib/notices.ts) -- a genuine second request this capture server
      // must answer, but not part of what these tests are checking. Answered
      // with an empty notice list and excluded from the recorded requests so
      // "exactly one request" below means the dataset list/search call.
      if (url.pathname === "/notices") {
        return new Response(JSON.stringify({ notices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Phase 5b (#1149, D3): a successful list/search also fires a
      // fire-and-forget `GET /datasets/facets` AFTER its own output is
      // rendered, to opportunistically refresh the shell-completion cache
      // (src/lib/completion/refresh.ts). Genuine traffic this capture
      // server has to answer, same reasoning as /notices above, but not
      // part of what these tests are checking -- excluded from the
      // recorded requests so "exactly one request" below still means the
      // list/search call itself.
      if (url.pathname === "/datasets/facets") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      requests.push(url);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

let configDir: string;

beforeEach(() => {
  // Fresh, empty config dir per test: no apiKey, no real user state. The
  // config module resolves NEMAR_CONFIG_DIR lazily on each call (issue
  // #489), so setting it per-subprocess is enough isolation -- it never
  // touches the real ~/.config/nemar.
  configDir = mkdtempSync(join(tmpdir(), "nemar-facet-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  testApiUrl: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: testApiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  // FORCE_COLOR (inherited from some terminals/CI), if set, overrides
  // NO_COLOR in chalk -- drop it so output is deterministic plain text, same
  // idiom as test/cli-output.unit.test.ts's harness.
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const EMPTY_LIST_ENVELOPE = { datasets: [], count: 0, total_count: 0, limit: 20, offset: 0 };
const EMPTY_SEARCH_ENVELOPE = { results: [], count: 0 };

/** One representative valid raw CLI value per value kind, plus the wire
 *  value `buildFacetParams` (src/lib/facet-options.ts) must produce for it. */
function sampleFor(facet: FacetDefinition): { raw: string; expectedWire: string } {
  switch (facet.valueKind) {
    case "number":
      return { raw: "10..50", expectedWire: "10..50" };
    case "bytes":
      // Both bounds a real range (not a bare exact value) so this, like the
      // "number" case above, exercises serializeBounds's general two-sided
      // branch rather than its exact-value shortcut. 10/50 GiB are exactly
      // representable as doubles -- no rounding to account for.
      return {
        raw: "10gb..50gb",
        expectedWire: `${10 * 1024 ** 3}..${50 * 1024 ** 3}`,
      };
    case "duration":
      return { raw: "10m..2h", expectedWire: `${10 * 60}..${2 * 3600}` };
    case "enum": {
      const v = facet.enumValues?.[0] ?? "x";
      return { raw: v, expectedWire: v };
    }
    case "text":
      return { raw: "average", expectedWire: "average" };
    case "version":
      return { raw: "1.10.0", expectedWire: "1.10.0" };
  }
}

describe("verification case 2: every facet flag maps to its queryParam", () => {
  for (const facet of FACETS) {
    test(`list ${facet.flag} -> ?${facet.queryParam}=<canonical>`, async () => {
      const { raw, expectedWire } = sampleFor(facet);
      const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
      try {
        const result = await runCli(["dataset", "list", "--json", facet.flag, raw], server.url);
        expect(result.exitCode).toBe(0);
        expect(server.requests.length).toBe(1);
        const params = server.requests[0].searchParams;
        expect(params.get(facet.queryParam)).toBe(expectedWire);
        // Trap #2: for the four facets whose internal `key` is hyphenated
        // but whose wire `queryParam` is snake_case, the hyphenated form
        // must never reach the query string.
        if (facet.key !== facet.queryParam) {
          expect(params.has(facet.key)).toBe(false);
        }
      } finally {
        server.stop();
      }
    });
  }
});

describe("verification case 3: bad ranges never reach the network", () => {
  const BAD_CASES: Array<{ label: string; args: string[] }> = [
    {
      label: "non-numeric-ish (unit not allowed on a plain number)",
      args: ["--subjects", "100xyz"],
    },
    { label: "inverted", args: ["--subjects", "300..100"] },
    { label: "too many .. separators", args: ["--subjects", "1..2..3"] },
    { label: "bare ..", args: ["--subjects", ".."] },
    { label: "negative", args: ["--subjects=-5"] },
    { label: "unknown unit (bytes facet)", args: ["--size", "10zz"] },
  ];

  for (const { label, args } of BAD_CASES) {
    test(`list ${args.join(" ")} (${label}): exits 1 before any request`, async () => {
      const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
      try {
        const result = await runCli(["dataset", "list", ...args], server.url);
        expect(result.exitCode).toBe(1);
        expect(server.requests.length).toBe(0);
        expect(result.stdout).toContain("Error:");
      } finally {
        server.stop();
      }
    });
  }
});

describe("verification case 4: enum tokens", () => {
  test("a bad token in a comma list is rejected, naming the token and the valid set", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--source", "openneuro,bogus"], server.url);
      expect(result.exitCode).toBe(1);
      expect(server.requests.length).toBe(0);
      expect(result.stdout).toContain("bogus");
      expect(result.stdout).toContain("openneuro");
      expect(result.stdout).toContain("gin");
    } finally {
      server.stop();
    }
  });

  test("a valid multi-token list passes through intact", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(
        ["dataset", "list", "--json", "--source", "openneuro,nemar"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].searchParams.get("source")).toBe("openneuro,nemar");
    } finally {
      server.stop();
    }
  });
});

describe("verification case 5: the excluded_unknown / excluded_unknown_by_facet note (D5, revised)", () => {
  test("one active facet: note attributes the single bucket by name, on stderr", async () => {
    const server = startCaptureServer({
      ...EMPTY_LIST_ENVELOPE,
      excluded_unknown: 210,
      excluded_unknown_by_facet: { channels: 210 },
    });
    try {
      const result = await runCli(["dataset", "list", "--channels", "10..50"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "note: 210 datasets excluded for unknown values - channels 210",
      );
      expect(result.stderr).toContain(
        "(a dataset can be unknown in more than one field; --include-unknown keeps them)",
      );
      expect(result.stdout).not.toContain("note:");
    } finally {
      server.stop();
    }
  });

  // D5 revision: Phase 3's vague "a filtered field is unknown" fallback for
  // two-or-more active facets is gone -- every facet that excluded at least
  // one row is named with its own count, never lumped into one number with
  // no attribution.
  test("two active facets: EACH bucket is named with its own count, never a vague fallback", async () => {
    const server = startCaptureServer({
      ...EMPTY_LIST_ENVELOPE,
      excluded_unknown: 210,
      excluded_unknown_by_facet: { channels: 205, rate: 8 },
    });
    try {
      const result = await runCli(
        ["dataset", "list", "--channels", "10..50", "--rate", "5..10"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "note: 210 datasets excluded for unknown values - channels 205, rate 8",
      );
      expect(result.stderr).not.toContain("filtered field is unknown for them");
    } finally {
      server.stop();
    }
  });

  test("suppressed under --json; stdout stays valid JSON and carries both raw fields", async () => {
    const server = startCaptureServer({
      ...EMPTY_LIST_ENVELOPE,
      excluded_unknown: 210,
      excluded_unknown_by_facet: { channels: 210 },
    });
    try {
      const result = await runCli(
        ["dataset", "list", "--json", "--channels", "10..50"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("note:");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.excluded_unknown).toBe(210);
      expect(parsed.excluded_unknown_by_facet).toEqual({ channels: 210 });
    } finally {
      server.stop();
    }
  });

  // Mirrors the backend's own gate (both fields are computed by one query
  // and omitted together on failure, e.g. the primary count degrading) --
  // from the CLI's side this just means: no field, no note, nothing to
  // suppress or misattribute.
  test("both fields absent (e.g. a degraded primary count server-side): no note printed", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--channels", "10..50"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("note:");
    } finally {
      server.stop();
    }
  });

  test("search: one active facet also gets the attributed stderr note", async () => {
    const server = startCaptureServer({
      ...EMPTY_SEARCH_ENVELOPE,
      excluded_unknown: 42,
      excluded_unknown_by_facet: { channels: 42 },
    });
    try {
      const result = await runCli(["dataset", "search", "eeg", "--channels", "10..50"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "note: 42 datasets excluded for unknown values - channels 42",
      );
    } finally {
      server.stop();
    }
  });
});

describe("verification case 6: legacy filters reach search (D6)", () => {
  const CASES: Array<{ args: string[]; queryParam: string; expectedValue: string }> = [
    {
      args: ["--license", "public,attribution"],
      queryParam: "license",
      expectedValue: "public,attribution",
    },
    { args: ["--author", "Ada Lovelace"], queryParam: "author", expectedValue: "Ada Lovelace" },
    { args: ["--task", "rest"], queryParam: "task", expectedValue: "rest" },
    { args: ["--doi"], queryParam: "has_doi", expectedValue: "true" },
    { args: ["--recent", "30"], queryParam: "recent", expectedValue: "30" },
    { args: ["--complete"], queryParam: "data_complete", expectedValue: "1" },
  ];

  for (const { args, queryParam, expectedValue } of CASES) {
    test(`search ${args[0]} sends ?${queryParam}=${expectedValue}`, async () => {
      const server = startCaptureServer(EMPTY_SEARCH_ENVELOPE);
      try {
        const result = await runCli(["dataset", "search", "eeg", "--json", ...args], server.url);
        expect(result.exitCode).toBe(0);
        expect(server.requests.length).toBe(1);
        const params = server.requests[0].searchParams;
        expect(params.get(queryParam)).toBe(expectedValue);
        // D6 constraint: search's free text is the `q` argument; `search` is
        // list-only and must never be sent by this command.
        expect(params.has("search")).toBe(false);
        expect(params.get("q")).toBe("eeg");
      } finally {
        server.stop();
      }
    });
  }
});

// #1169 review, test-analyzer findings. Each block below was added because a
// mutation to the production line it targets produced ZERO failures against
// the original suite -- the implementer's own 18-mutation pass did not reach
// them. They are ordered by the severity the reviewer assigned.
describe("verification case 8: gaps found by mutation after the first review round", () => {
  // Rating 7/10. Both commands register --include-unknown and both API-client
  // functions serialize it, but nothing confirmed it survives the trip. A
  // hardcoded `includeUnknown: false` in the two actions broke nothing.
  for (const cmd of ["list", "search"] as const) {
    test(`${cmd}: --include-unknown reaches the wire as include_unknown=1`, async () => {
      const server = startCaptureServer(
        cmd === "list" ? EMPTY_LIST_ENVELOPE : EMPTY_SEARCH_ENVELOPE,
      );
      try {
        const args =
          cmd === "list"
            ? ["dataset", "list", "--channels", "10..50", "--include-unknown"]
            : ["dataset", "search", "sleep", "--channels", "10..50", "--include-unknown"];
        const result = await runCli(args, server.url);
        expect(result.exitCode).toBe(0);
        expect(server.requests.length).toBe(1);
        expect(server.requests[0].searchParams.get("include_unknown")).toBe("1");
      } finally {
        server.stop();
      }
    });

    test(`${cmd}: include_unknown is absent when the flag is not passed`, async () => {
      const server = startCaptureServer(
        cmd === "list" ? EMPTY_LIST_ENVELOPE : EMPTY_SEARCH_ENVELOPE,
      );
      try {
        const args =
          cmd === "list"
            ? ["dataset", "list", "--channels", "10..50"]
            : ["dataset", "search", "sleep", "--channels", "10..50"];
        await runCli(args, server.url);
        expect(server.requests[0].searchParams.has("include_unknown")).toBe(false);
      } finally {
        server.stop();
      }
    });
  }

  // Rating 6/10. D4 deleted the duplicated tier array, and case 7 pins that
  // the literal cannot come back -- but nothing ran the validator. Neutering
  // it entirely failed no test anywhere in the repo, including before this
  // phase, so this covers behaviour the CLI has had since #653.
  for (const cmd of ["list", "search"] as const) {
    test(`${cmd}: an invalid --license tier exits 1 before any network call`, async () => {
      const server = startCaptureServer(
        cmd === "list" ? EMPTY_LIST_ENVELOPE : EMPTY_SEARCH_ENVELOPE,
      );
      try {
        const args =
          cmd === "list"
            ? ["dataset", "list", "--license", "public,bogus"]
            : ["dataset", "search", "sleep", "--license", "public,bogus"];
        const result = await runCli(args, server.url);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("invalid license tier(s): bogus");
        // The valid set is echoed so the fix does not need the docs.
        expect(result.stdout).toContain("attribution");
        // The point of validating client-side: nothing was sent.
        expect(server.requests.length).toBe(0);
      } finally {
        server.stop();
      }
    });
  }

  test("a valid comma-separated --license list passes through untouched", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(
        ["dataset", "list", "--license", "public,attribution"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("license")).toBe("public,attribution");
    } finally {
      server.stop();
    }
  });

  // Rating 5/10. Cosmetic but on every filtered call: dropping the `> 0`
  // gate makes the CLI print "note: 0 datasets excluded ..." whenever a facet
  // is merely active. Only the field-ABSENT case was covered.
  test("excluded_unknown present but ZERO prints no note", async () => {
    const server = startCaptureServer({
      ...EMPTY_LIST_ENVELOPE,
      excluded_unknown: 0,
      excluded_unknown_by_facet: { channels: 0 },
    });
    try {
      const result = await runCli(["dataset", "list", "--channels", "10..50"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("note:");
      expect(result.stdout).not.toContain("note:");
    } finally {
      server.stop();
    }
  });

  // Rating 4/10. sampleFor() only ever builds two-sided ranges, so the
  // min===max collapse in serializeBounds was never exercised end to end. A
  // bare `42` must stay `42` on the wire, not become `42..42`.
  test("a bare exact value serializes as itself, not as a degenerate range", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--subjects", "42"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("subjects")).toBe("42");
    } finally {
      server.stop();
    }
  });

  test("a range rejection echoes the accepted forms, not just the error", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--subjects", "100xyz"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Accepted forms:");
      expect(result.stdout).toContain("a bare number (exact)");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  // --sort gained `citations` in this phase (the backend has supported it
  // since #804; only the help text and the choices list lagged).
  test("--sort citations is accepted and reaches the wire", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--sort", "citations"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("sort")).toBe("citations");
    } finally {
      server.stop();
    }
  });

  test("--sort rejects a value outside its choices, before any network call", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--sort", "bogus"], server.url);
      expect(result.exitCode).not.toBe(0);
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("--modality (#1711)", () => {
  // The match is the server's; the CLI's part is to say what it does and to
  // send the value through untouched, so a comma list reaches the wire whole.
  const collapse = (text: string) => text.replace(/\s+/g, " ");

  test("both commands describe the whole-token match, the comma list and the limit", async () => {
    for (const command of ["list", "search"]) {
      const result = await runCli(["dataset", command, "--help"], "http://127.0.0.1:1");
      expect(result.exitCode).toBe(0);
      expect(collapse(result.stdout)).toContain(collapse(MODALITY_FILTER_CLI_HELP));
    }
    expect(MODALITY_FILTER_CLI_HELP).toContain("whole token");
    expect(MODALITY_FILTER_CLI_HELP).toContain(String(MAX_MODALITY_FILTER_TOKENS));
  });

  test("a comma list is sent to the server as typed", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--modality", "eeg,meg"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("modality")).toBe("eeg,meg");
    } finally {
      server.stop();
    }
  });
});
