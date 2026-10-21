/**
 * The monthly bump finds the newest stable @bids/validator release on JSR, compares it with the
 * current pin on the reference datasets, and opens a pin PR with the comparison in its body.
 *
 * The selection is scripts/validator/latest-stable.jq, and bump-validator.yml runs that same file.
 * These tests run it with the real jq binary, check the workflow's contract (step order, the skip
 * guard, the artifact, the body file, and that an incomplete comparison fails the job), and run the
 * body step's own shell with a scratch RUNNER_TEMP. Real files and real shell, no mocks.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "..");
const PROGRAM = join(ROOT, "scripts/validator/latest-stable.jq");
const SNAPSHOT = join(ROOT, "test/fixtures/jsr-bids-validator-meta.json");
const WORKFLOW = join(ROOT, ".github/workflows/bump-validator.yml");

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bump-body-"));
  created.push(dir);
  return dir;
}

/** Run the workflow's selection on a JSR metadata document. */
function latestStable(meta: unknown): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(["jq", "-r", "-f", PROGRAM], {
    stdin: new TextEncoder().encode(JSON.stringify(meta)),
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString().trim() };
}

/** A JSR metadata document listing only these versions. */
function versionsMeta(...versions: string[]): { versions: Record<string, object> } {
  return { versions: Object.fromEntries(versions.map((version) => [version, {}])) };
}

type Step = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const workflow = parse(readFileSync(WORKFLOW, "utf-8"));
const steps: Step[] = workflow.jobs.bump.steps;
const stepNamed = (name: string) => steps.find((step) => step.name === name);

describe("latest-stable.jq", () => {
  test("picks 3.0.2 from the JSR snapshot that the 2.x regex froze at 2.4.1", () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf-8"));
    expect(latestStable(snapshot)).toEqual({ exitCode: 0, stdout: "3.0.2" });
  });

  test("takes a newer major version instead of staying on one line", () => {
    expect(latestStable(versionsMeta("2.4.1", "3.0.2", "4.0.0"))).toEqual({
      exitCode: 0,
      stdout: "4.0.0",
    });
  });

  test("never selects a prerelease, even when it is the highest version listed", () => {
    expect(latestStable(versionsMeta("2.4.1", "3.0.0-alpha.4"))).toEqual({
      exitCode: 0,
      stdout: "2.4.1",
    });
  });

  test("never selects a yanked release, so a withdrawn newest version is not proposed", () => {
    expect(latestStable({ versions: { "3.0.3": { yanked: true }, "3.0.2": {} } })).toEqual({
      exitCode: 0,
      stdout: "3.0.2",
    });
  });

  test("compares each part as a number, so 2.0.10 is newer than 2.0.9", () => {
    expect(latestStable(versionsMeta("2.0.2", "2.0.10", "2.0.9"))).toEqual({
      exitCode: 0,
      stdout: "2.0.10",
    });
  });

  test("fails rather than printing nothing when no stable release is listed", () => {
    expect(latestStable(versionsMeta("3.0.0-alpha.0")).exitCode).not.toBe(0);
  });
});

describe("bump-validator.yml", () => {
  test("resolves the newest release with the shared program and no major-version pin", () => {
    const resolve = steps.find((step) => step.id === "resolve");
    expect(resolve?.run).toContain("scripts/validator/latest-stable.jq");
    expect(resolve?.run).not.toContain("^2");
  });

  test("runs monthly, on the first day of the month", () => {
    expect(workflow.on.schedule[0].cron).toBe("0 6 1 * *");
  });

  test("compares the reference datasets before it opens the pull request", () => {
    const compareAt = steps.findIndex((step) => step.run?.includes("compare-gating.sh"));
    const openAt = steps.findIndex((step) =>
      step.uses?.startsWith("peter-evans/create-pull-request"),
    );
    expect(compareAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThan(compareAt);
  });

  test("a Deno runtime is set up before the comparison runs", () => {
    const setupAt = steps.findIndex((step) => step.uses?.startsWith("denoland/setup-deno"));
    const compareAt = steps.findIndex((step) => step.run?.includes("compare-gating.sh"));
    expect(setupAt).toBeGreaterThanOrEqual(0);
    expect(setupAt).toBeLessThan(compareAt);
  });

  test("the pull request body is written before the pull request is opened", () => {
    const writeAt = steps.findIndex((step) => step.name === "Write the pull request body");
    const openAt = steps.findIndex((step) =>
      step.uses?.startsWith("peter-evans/create-pull-request"),
    );
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeLessThan(openAt);
  });

  test("an incomplete comparison fails the job: the script is not asked to accept a partial result", () => {
    const compare = stepNamed("Compare the reference datasets across the two releases");
    expect(compare?.run).toContain('--out "$RUNNER_TEMP/validator-compare"');
    expect(compare?.run).not.toContain("--allow-partial");
  });

  test("every step after the version resolves only when a newer release exists", () => {
    const resolveAt = steps.findIndex((step) => step.id === "resolve");
    const guard = "steps.resolve.outputs.skip == 'false'";
    for (const step of steps.slice(resolveAt + 1)) {
      expect(step.if ?? "", `step ${step.name ?? step.uses}`).toContain(guard);
    }
  });

  test("the comparison is kept as an artifact even when the comparison fails", () => {
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
    expect(upload?.if).toContain("always()");
    expect(upload?.with?.path).toBe("${{ runner.temp }}/validator-compare");
  });

  test("the pull request body is the file the body step writes", () => {
    const open = steps.find((step) => step.uses?.startsWith("peter-evans/create-pull-request"));
    expect(open?.with?.["body-path"]).toBe("${{ runner.temp }}/bump-pr-body.md");
    expect(stepNamed("Write the pull request body")?.run).toContain(
      '} > "$RUNNER_TEMP/bump-pr-body.md"',
    );
  });

  test("the body step writes the comparison summary into the pull request body", () => {
    const runnerTemp = freshDir();
    mkdirSync(join(runnerTemp, "validator-compare"), { recursive: true });
    writeFileSync(
      join(runnerTemp, "validator-compare", "summary.md"),
      "## Reference datasets\n\nCompared 1 of 1 datasets; 0 changed.\n",
    );
    const body = stepNamed("Write the pull request body")?.run ?? "";
    const proc = Bun.spawnSync(["bash", "-c", body], {
      env: { ...process.env, RUNNER_TEMP: runnerTemp, CURRENT: "3.0.1", LATEST: "3.0.2" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const written = readFileSync(join(runnerTemp, "bump-pr-body.md"), "utf-8");
    expect(written).toContain("from `3.0.1` to `3.0.2`");
    expect(written).toContain("Compared 1 of 1 datasets; 0 changed.");
  });
});
