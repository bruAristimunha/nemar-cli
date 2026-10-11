/**
 * What `nemar dataset upload` prints once the upload is done.
 *
 * BIDS validation runs on GitHub after an upload and must pass before a
 * publication request can go through; a request made earlier is only recorded.
 * The success output names the two commands in that order. When the upload could
 * not set up CI (an owner is refused by the admin-only route), `nemar dataset ci`
 * has nothing to show, so the output names the one command that does set it up:
 * the publication request.
 *
 * `printUploadSuccess` and `deployCiStep` are the real functions, run against a
 * real (temporary) dataset directory. `printUploadSuccess` prints through
 * console.log, so the test reads what it printed by wrapping console.log for the
 * length of the call and restoring it in `finally`; nothing about the function
 * is replaced. `deployCiStep` is driven against a local stand-in for the API.
 */

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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployCiStep, printUploadSuccess } from "../src/lib/upload/finalize";
import type { CiOutcome } from "../src/lib/upload/finalize";
import type { DatasetInfo } from "../src/lib/upload/types";

import { makeConfigDir, removeConfigDir, spawnBun } from "./helpers/pending-cli";

// The tests that run a subprocess need more than the default five seconds.
setDefaultTimeout(30_000);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nemar-upload-success-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function infoFor(datasetId: string): DatasetInfo {
  return {
    dataset_id: datasetId,
    ssh_url: `git@github.com:nemarDatasets/${datasetId}.git`,
    s3_prefix: `${datasetId}/`,
    github_url: `https://github.com/nemarDatasets/${datasetId}`,
    upload_urls: {},
    s3_config: {
      bucket: "nemar",
      region: "us-east-2",
      public_url: "https://nemar.s3.amazonaws.com",
    },
  };
}

/** The lines printUploadSuccess prints, without terminal color codes. */
function printedLines(datasetId: string, ci?: CiOutcome): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printUploadSuccess(dir, infoFor(datasetId), ci);
  } finally {
    console.log = original;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escape sequences is the point
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

describe("printUploadSuccess: what happens next", () => {
  test("says validation runs on GitHub, how to check it, and when to request publication", () => {
    for (const ci of [undefined, "configured", "unknown"] as const) {
      const lines = printedLines("nm099999", ci);
      const start = lines.indexOf("BIDS validation runs on GitHub after the upload.");
      expect(start, String(ci)).toBeGreaterThan(-1);
      // Three lines, in order: what runs, how to check it, what comes after.
      expect(lines[start + 1]).toBe("  Check it with: nemar dataset ci nm099999");
      expect(lines[start + 2]).toBe(
        "  Once it has passed, request publication: nemar dataset publish request nm099999",
      );
      expect(lines[start + 3]).toBe("");
    }
  });

  test("the dataset id in the commands is the uploaded one", () => {
    const text = printedLines("nm000358").join("\n");
    expect(text).toContain("nemar dataset ci nm000358");
    expect(text).toContain("nemar dataset publish request nm000358");
    expect(text).not.toContain("nm099999");
  });

  test("it follows the existing summary and does not replace any of it", () => {
    const lines = printedLines("nm099999");
    const text = lines.join("\n");
    expect(lines[1]).toBe("Upload complete!");
    expect(text).toContain("Dataset ID: nm099999");
    expect(text).toContain("GitHub: https://github.com/nemarDatasets/nm099999");
    expect(text).toContain("nemar dataset download nm099999");
    expect(text).toContain("Note: This dataset is private.");
    expect(lines.indexOf("BIDS validation runs on GitHub after the upload.")).toBeGreaterThan(
      lines.indexOf("  nemar dataset download nm099999"),
    );
  });

  test("a sandbox dataset can check CI but is not told to request publication", () => {
    // The backend refuses a publication request for an xx dataset, so naming
    // that command would send a trainee to a certain refusal.
    const text = printedLines("xx012345").join("\n");
    expect(text).toContain("nemar dataset ci xx012345");
    expect(text).not.toContain("publish request");
  });

  test("CI that the upload could not set up is not offered for checking", () => {
    // `nemar dataset ci` would answer "not configured, ask an admin", which an
    // owner cannot act on. The publication request is what deploys CI for them.
    const lines = printedLines("nm099999", "not-configured");
    const text = lines.join("\n");
    expect(text).toContain("BIDS validation is not set up yet.");
    expect(text).toContain(
      "  CI is set up when you request publication: nemar dataset publish request nm099999",
    );
    expect(text).not.toContain("nemar dataset ci");
    expect(text).not.toContain("BIDS validation runs on GitHub");
    expect(text).toContain("Note: This dataset is private.");
  });

  test("a sandbox dataset whose CI was not set up is told nothing about either command", () => {
    const text = printedLines("xx012345", "not-configured").join("\n");
    expect(text).not.toContain("nemar dataset ci");
    expect(text).not.toContain("publish request");
    expect(text).toContain("Upload complete!");
  });
});

describe("deployCiStep reports how the CI step ended", () => {
  // The real function in a subprocess, with its own config directory pointing
  // at a local stand-in for POST /admin/datasets/<id>/ci. The real route is
  // admin-only, so an owner is refused with 403 and any other failure is a
  // server fault. A subprocess keeps the environment of this process (and its
  // API settings) out of the call.
  const FINALIZE = join(import.meta.dir, "..", "src", "lib", "upload", "finalize.ts");
  const PROGRESS = join(import.meta.dir, "..", "src", "lib", "upload-progress.ts");
  const SCRIPT = `
    import { deployCiStep } from ${JSON.stringify(FINALIZE)};
    import { initUploadProgress, markStepCompleted } from ${JSON.stringify(PROGRESS)};
    const dir = process.env.UPLOAD_DIR as string;
    const progress = initUploadProgress(dir, "nm099999", []);
    if (process.env.CI_STEP_DONE === "1") markStepCompleted(progress, "ci_deploy");
    console.log("OUTCOME=" + (await deployCiStep(dir, "nm099999", progress)));
  `;
  let server: ReturnType<typeof Bun.serve>;
  let answer = 200;
  let calls = 0;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/notices") return Response.json({ notices: [] });
        calls++;
        return Response.json(answer === 200 ? { dataset_id: "nm099999" } : { error: "refused" }, {
          status: answer,
        });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    answer = 200;
    calls = 0;
  });

  async function outcome(opts: { stepDone?: boolean } = {}): Promise<string> {
    const configDir = makeConfigDir(`http://127.0.0.1:${server.port}`);
    try {
      const run = await spawnBun(["bun", "-e", SCRIPT], configDir, {
        env: { UPLOAD_DIR: dir, CI_STEP_DONE: opts.stepDone ? "1" : "0" },
      });
      const found = /OUTCOME=(\S+)/.exec(run.stdout);
      if (!found) throw new Error(`no outcome printed:\n${run.stdout}\n${run.stderr}`);
      return found[1] as string;
    } finally {
      removeConfigDir(configDir);
    }
  }

  test("CI set up: configured", async () => {
    expect(await outcome()).toBe("configured");
    expect(calls).toBe(1);
  });

  test("an owner refused by the admin-only route: not-configured", async () => {
    answer = 403;
    expect(await outcome()).toBe("not-configured");
    expect(calls).toBe(1);
  });

  test("any other failure: not-configured", async () => {
    answer = 500;
    expect(await outcome()).toBe("not-configured");
  });

  test("a resumed upload whose CI step already ran: unknown, and no second call", async () => {
    expect(await outcome({ stepDone: true })).toBe("unknown");
    expect(calls).toBe(0);
  });
});

describe("the upload command", () => {
  test("hands the CI step's outcome to the success output", () => {
    // A source pin, and only that: `nemar dataset upload` needs git-annex and S3
    // and cannot be driven end to end here. Without the argument the success
    // output falls back to `unknown` and sends an owner whose CI was never set
    // up to a command that cannot show it.
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "commands", "dataset.ts"),
      "utf8",
    );
    expect(source).toContain(
      "const ciOutcome = await deployCiStep(absolutePath, datasetInfo.dataset_id, uploadProgress);",
    );
    expect(source).toContain("printUploadSuccess(absolutePath, datasetInfo, ciOutcome);");
  });
});
