/**
 * A test file's header says which CI tier it runs in; the workflow decides, and the two must agree.
 *
 * `.github/workflows/test.yml` routes a file by text, not by header: a file whose text holds one
 * of three marker names (read from the workflow below, never spelled here) goes to the
 * `integration-dev` job, which runs with `--retry=2 --timeout 30000` and is not required on dev;
 * every other file goes to the required `unit-pure` job, which runs `bun test` with the default
 * five-second timeout and no retry; a file named `*.integration.test.ts` goes to the integration
 * job whatever its text says. When the spawn of the CLI moved out of six suites into a shared
 * helper, none of them held a marker any more, all six moved to `unit-pure` while their headers
 * still said "integration", and nothing noticed: a header is a claim, and a claim nothing checks
 * drifts. This file checks it.
 *
 * The routing pattern is parsed out of the two jobs' scripts rather than copied here, so a change
 * to the workflow is followed and a pattern the parser cannot read fails loudly instead of letting
 * every file pass. This file holds none of the marker names itself, so it routes to `unit-pure`
 * like the claim below says it does, and the last test proves it.
 *
 * CI TIER: unit-pure. Offline: it reads the workflow and the test files from disk and runs
 * nothing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { parse } from "yaml";

const ROOT = new URL("..", import.meta.url).pathname;

type Tier = "unit-pure" | "integration";

interface Job {
  steps?: { run?: string }[];
}

const workflow = parse(readFileSync(`${ROOT}.github/workflows/test.yml`, "utf8")) as {
  jobs: Record<string, Job>;
};

/** Every `run:` script of a job, in order. */
function scriptsOf(job: string): string[] {
  const steps = workflow.jobs[job]?.steps;
  if (!steps) throw new Error(`test.yml has no job named ${job}`);
  return steps.flatMap((s) => (s.run ? [s.run] : []));
}

interface Routing {
  /** The text the job greps each file for, exactly as the workflow spells it. */
  pattern: string;
  /** What the job does with a file that matches: the other tier takes the rest. */
  onMatch: "continue" | "files+=";
  /** The base names the job skips outright (the live end-to-end suites). */
  skipped: string[];
}

/** The routing of one job, or a thrown error naming what could not be read. */
function routingOf(job: string): Routing {
  const found = scriptsOf(job).flatMap((script) =>
    [...script.matchAll(/grep -Eq '([^']+)' "\$f"; then (continue|files\+=)/g)].map((m) => ({
      script,
      pattern: m[1],
      onMatch: m[2] as Routing["onMatch"],
    })),
  );
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one routing grep in the ${job} job, found ${found.length}: this guard must be updated with the workflow`,
    );
  }
  const [{ script, pattern, onMatch }] = found;
  const skipLine = script.match(/^\s*([\w.-]+(?:\|[\w.-]+)+)\) continue;;/m);
  if (!skipLine) throw new Error(`the ${job} job's skip list could not be read`);
  return { pattern, onMatch, skipped: skipLine[1].split("|") };
}

const unitPure = routingOf("unit-pure");
const integrationDev = routingOf("integration-dev");

/**
 * The marker names, unescaped, so a test can build a file that holds one without this file
 * spelling it. The workflow's pattern is an extended regular expression of plain alternatives
 * with backslash-escaped punctuation, which is also a valid JavaScript pattern.
 */
const MARKERS = unitPure.pattern.split("|").map((alt) => alt.replace(/\\(.)/g, "$1"));
const ROUTING_PATTERN = new RegExp(unitPure.pattern);

/** The tier the workflow gives a file of this name and text: `grep -E` over the whole file. */
function routedTo(name: string, text: string): Tier {
  if (name.endsWith(".integration.test.ts")) return "integration";
  return ROUTING_PATTERN.test(text) ? "integration" : "unit-pure";
}

/**
 * The tier a header claims, from the first `CI TIER:` in the file: the first tier word after it,
 * so "integration, like the other suites" and "this file runs in the integration tier, not
 * `unit-pure`" both read as integration. `undefined` when the file makes no claim, `"unreadable"`
 * when it makes one that names neither tier.
 */
function claimedBy(text: string): Tier | "unreadable" | undefined {
  const at = text.indexOf("CI TIER:");
  if (at === -1) return undefined;
  const word = text.slice(at + "CI TIER:".length, at + 400).match(/unit-pure|integration/);
  return word ? (word[0] as Tier) : "unreadable";
}

/** The publish harness's entry point, joined so that this file does not hold it as text. */
const HARNESS_ENTRY = ["startPublish", "Cli("].join("");

/** The files the workflow's loop visits: the same three globs, minus the jobs' skip list. */
function testFiles(): string[] {
  const dirs = ["test", "backend/test", "backend/test/helpers"];
  return dirs
    .flatMap((dir) =>
      readdirSync(`${ROOT}${dir}`)
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => `${dir}/${f}`),
    )
    .filter((path) => !unitPure.skipped.includes(basename(path)));
}

const files = testFiles().map((path) => ({
  path,
  text: readFileSync(`${ROOT}${path}`, "utf8"),
}));
const claimants = files.flatMap((f) => {
  const claim = claimedBy(f.text);
  return claim ? [{ ...f, claim }] : [];
});

describe("the workflow's routing can be read", () => {
  test("both tiers route on the same pattern, and the pure tier is the one that skips a match", () => {
    expect(integrationDev.pattern).toBe(unitPure.pattern);
    expect(unitPure.onMatch).toBe("continue");
    expect(integrationDev.onMatch).toBe("files+=");
    expect(integrationDev.skipped).toEqual(unitPure.skipped);
  });

  test("the pattern is a short list of plain marker names, and the skip list is not empty", () => {
    expect(MARKERS.length).toBeGreaterThanOrEqual(2);
    for (const marker of MARKERS) expect(marker).toMatch(/^[A-Za-z_][\w(]*$/);
    expect(unitPure.skipped.length).toBeGreaterThan(0);
  });
});

describe("a header's tier claim is the tier the workflow gives the file", () => {
  test("the guard reads claims from files at all, in both tiers", () => {
    // A guard whose scan found nothing would pass for ever.
    expect(claimants.some((f) => f.claim === "unit-pure")).toBe(true);
    expect(claimants.some((f) => f.claim === "integration")).toBe(true);
  });

  for (const { path, text, claim } of claimants) {
    test(`${path} claims ${claim}`, () => {
      expect(claim).not.toBe("unreadable");
      expect(routedTo(basename(path), text)).toBe(claim);
    });
  }

  test("every suite that spawns the CLI through the publish harness makes a claim", () => {
    // These are the suites whose tier moved when the spawn moved into the helper.
    const harnessed = files.filter((f) => f.text.includes(HARNESS_ENTRY));
    expect(harnessed.length).toBeGreaterThanOrEqual(6);
    for (const f of harnessed) expect(claimedBy(f.text), f.path).toBeDefined();
  });

  test("this file claims unit-pure and holds no marker, so the claim is true", () => {
    const self = files.find((f) => f.path === "test/ci-tier-routing.unit.test.ts");
    expect(self).toBeDefined();
    expect(claimedBy(self?.text ?? "")).toBe("unit-pure");
    expect(routedTo("ci-tier-routing.unit.test.ts", self?.text ?? "")).toBe("unit-pure");
  });
});

describe("the guard itself tells the tiers apart", () => {
  const withMarker = `/** x */\n// ${MARKERS[0]}\n`;

  test("a file holding a marker routes to the integration tier, one without routes to unit-pure", () => {
    for (const marker of MARKERS) {
      expect(routedTo("a.test.ts", `const x = "${marker}";`), marker).toBe("integration");
    }
    expect(routedTo("a.test.ts", "const x = 1;")).toBe("unit-pure");
  });

  test("a file named *.integration.test.ts routes to the integration tier whatever it holds", () => {
    expect(routedTo("a.integration.test.ts", "const x = 1;")).toBe("integration");
  });

  test("a marker in a comment routes a file, because grep reads the text and not the syntax", () => {
    expect(routedTo("a.test.ts", withMarker)).toBe("integration");
  });

  test("a claim reads as the first tier word after the label", () => {
    expect(claimedBy(" * CI TIER: integration, like the others.")).toBe("integration");
    expect(claimedBy(" * CI TIER: unit-pure. Hermetic.")).toBe("unit-pure");
    expect(claimedBy(" * CI TIER: runs in the integration tier, not `unit-pure`.")).toBe(
      "integration",
    );
    expect(claimedBy(" * CI TIER: pure.")).toBe("unreadable");
    expect(claimedBy("no claim here")).toBeUndefined();
  });
});
