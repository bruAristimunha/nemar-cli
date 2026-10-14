/**
 * The capture half of issue #1309, checked against the classify half.
 *
 * `nemarDatasets/.github`'s `onboard-openneuro.yml` posts the failing phase's real
 * error line; `classifyImportFailure` turns that text into a cause. The two halves
 * live in different repositories and are joined only by the WORDING of a message, so
 * nothing in either repo's own tests can catch them drifting apart. That is what this
 * file is for.
 *
 * Two things are pinned:
 *
 *   1. The messages the workflow actually produces classify to the causes triage
 *      needs. The strings below are not invented: each was extracted by running the
 *      workflow's own shell pipeline over a log in the shape the CLI writes.
 *   2. The workflow file kept in this repo (`.github/dataset-workflows/`) still has
 *      the properties the capture depends on. It is a copy that an owner deploys by
 *      hand, so a well-meaning edit here is the likeliest way for capture to regress.
 *
 * Before this, every machine-filed tracking issue read `terminal: prepare=failure
 * copy=failure finalize=failure` -- a stage roll-up with no error text -- and a human
 * read Actions logs and applied labels by hand.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyImportFailure } from "../src/services/import-failure-cause";

const WORKFLOW = join(
  import.meta.dir,
  "..",
  "..",
  ".github",
  "dataset-workflows",
  "onboard-openneuro.yml",
);

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

describe("what the workflow captures is what the classifier can read", () => {
  /**
   * The three causes behind the 2026-07/09 outage, in the wording the CLI emits.
   * These are the cases the taxonomy was transcribed FROM, so if any stops
   * classifying, the epic's premise has broken rather than merely a test.
   */
  const REAL_INCIDENT_CASES: { label: string; message: string; cause: string }[] = [
    {
      label: "expired NEMAR_GITHUB_PAT",
      message:
        "Failed to clone: fatal: Authentication failed for https://github.com/nemarDatasets/on008065",
      cause: "auth_invalid",
    },
    {
      label: "annex-uuid collision on re-import",
      message:
        "Failed to enable s3-PUBLIC remote: git-annex: Unable to use this special remote the annex-uuid file indicates it is used by a different special remote",
      cause: "annex_uuid_conflict",
    },
    {
      label: "branch-protection ruleset",
      message:
        "Failed to push: remote: error: GH013: Repository rule violations found for refs/heads/main.",
      cause: "branch_protection",
    },
    {
      label: "git divergence, auto-rebase failed",
      message: "Failed to push: hint: Updates were rejected because the tip has diverging commits",
      cause: "git_divergence",
    },
  ];

  for (const c of REAL_INCIDENT_CASES) {
    test(`${c.label} classifies as ${c.cause}`, () => {
      expect(classifyImportFailure({ stage: "prepare", lastError: c.message }).cause).toBe(c.cause);
    });
  }

  test("the upstream marker the workflow forwards verbatim still matches", () => {
    // The workflow sends this sentence unchanged rather than an extracted line,
    // because the marker IS the signal and the wording tells triage to re-check with
    // an anonymous ranged GET before believing it. So the literal must stay in step.
    const sent =
      "[openneuro-upstream-inaccessible] OpenNeuro objects not anonymously readable; NEMAR has no signed OpenNeuro login (see run log)";
    expect(workflow()).toContain(sent);
    expect(classifyImportFailure({ stage: "prepare", lastError: sent }).cause).toBe(
      "upstream_inaccessible",
    );
  });

  test("the no-line fallback is unknown, not a guess", () => {
    // Reachable whenever the CLI dies without printing a failure line -- an OOM, a
    // runner eviction. It must route to needs-triage rather than borrow whichever
    // cause happens to match some substring of the sentence.
    for (const stage of ["prepare", "copy", "finalize"]) {
      const fallback = `${stage} failed with no CLI failure line captured (see run log)`;
      expect(workflow()).toContain(fallback);
      const r = classifyImportFailure({ stage, lastError: fallback });
      expect(r.cause).toBe("unknown");
      expect(r.label).toBe("needs-triage");
    }
  });

  test("the roll-up the report job still posts remains unknown", () => {
    // It is the backstop, not the diagnosis, and `lastErrorAssignmentSql` keeps it
    // from overwriting a specific message. If it ever classified as something
    // confident, every failure would acquire that label.
    expect(
      classifyImportFailure({
        stage: "prepare",
        lastError: "terminal: prepare=failure copy=failure finalize=failure",
      }).cause,
    ).toBe("unknown");
  });
});

describe("the deployable copy keeps the properties capture depends on", () => {
  /**
   * `.github/dataset-workflows/onboard-openneuro.yml` is deployed by copying it into
   * `nemarDatasets/.github`. Nothing in CI runs it, so these are the invariants worth
   * asserting statically.
   */
  test("every phase job tees the CLI output it later reads", () => {
    const src = workflow();
    // Without the tee there is no file to extract from, and the reporter silently
    // falls back to "no CLI failure line captured" on every failure -- which looks
    // like a working capture that never captures anything.
    expect(src).toContain('tee "/tmp/prepare-${DATASET_ID}.log"');
    expect(src).toContain('tee "/tmp/copy-${DATASET_ID}-${{ matrix.shard }}.log"');
    expect(src).toContain('tee "/tmp/finalize-${DATASET_ID}.log"');
    // `set -o pipefail` is what keeps the step's exit code the CLI's rather than
    // tee's, so a failure still fails the job.
    expect(src.match(/set -o pipefail/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("each phase has a failure reporter, and each names its own stage", () => {
    const src = workflow();
    for (const stage of ["prepare", "copy", "finalize"]) {
      expect(src).toContain(`- name: Report ${stage} failure`);
      expect(src).toContain(`stage:"${stage}"`);
    }
  });

  test("the failure payloads are built with jq, never string-interpolated", () => {
    const src = workflow();
    // An extracted error line can contain a quote, a backslash or a newline. The
    // hand-rolled JSON this replaced only ever carried fixed strings, so it worked
    // until the day the message stopped being fixed -- and the failure mode is a
    // silent 400 on the one callback that carries the diagnosis.
    expect(src.match(/jq -nc/g)?.length).toBeGreaterThanOrEqual(3);
    // No reporter may fall back to interpolating the message into a JSON literal.
    expect(src).not.toContain('\\"error_message\\":\\"$msg');
  });

  test("extraction reads the tee'd log, never the Actions log", () => {
    const src = workflow();
    // Two false positives make whole-log matching wrong, and both were met while
    // diagnosing this epic: a bare `403` matches apt's "Packages [403 kB]", and the
    // marker appears in every Actions log because the step's own source is echoed.
    expect(src).toContain("grep -nF '✖' \"$log\"");
    expect(src).not.toContain("gh run view");
    expect(src).not.toContain("--log |");
  });

  test("the marker check uses grep -F, so the brackets are not a character class", () => {
    expect(workflow()).toContain('grep -qF "[openneuro-upstream-inaccessible]"');
  });
});

/**
 * The reporters RUN here, rather than being asserted as text.
 *
 * Every test above reads the file, and that is what let issue #1364 ship: the
 * fallback assertion was `expect(workflow()).toContain(fallback)`, which passed
 * over dead code. Actions runs a `run:` step under `bash -e {0}` and these steps
 * add `pipefail`, so a log with no `✖` made `grep` exit 1, pipefail promoted it to
 * the pipeline's status, and `-e` killed the step at the assignment -- before the
 * fallback that the test was busy confirming the existence of. Nothing was posted,
 * and the stage roll-up this epic replaced is what landed, for exactly the failure
 * modes the fallback exists for: an OOM, an evicted runner, a cancellation, or a
 * failure early enough that the log was never written.
 *
 * The script is extracted from the file and executed up to the point where `msg` is
 * final; the `jq` payload and the `curl` POST are cut off, so nothing here needs jq
 * and nothing can reach `api.nemar.org`. `bash -e` is passed explicitly because
 * that is what Actions does and it is the whole point.
 */
describe("the reporters survive a log with no failure marker", () => {
  /** The `run:` body of one reporter step, dedented, cut where `msg` is final. */
  function reporterScript(stage: "prepare" | "copy" | "finalize"): string {
    const src = workflow();
    const start = src.indexOf(`- name: Report ${stage} failure`);
    expect(start).toBeGreaterThan(-1);
    const runAt = src.indexOf("run: |", start);
    expect(runAt).toBeGreaterThan(-1);
    const body = src.slice(src.indexOf("\n", runAt) + 1);
    const lines: string[] = [];
    for (const line of body.split("\n")) {
      // The step's body is indented under `run: |`; the first line at or below the
      // step's own indentation ends it.
      if (line.trim() !== "" && !line.startsWith("          ")) break;
      lines.push(line.replace(/^ {10}/, ""));
      if (line.includes('payload="$(jq -nc')) break;
    }
    const cut = lines.findIndex((l) => l.includes('payload="$(jq -nc'));
    const kept = (cut === -1 ? lines : lines.slice(0, cut)).join("\n");
    // `${{ matrix.shard }}` is an Actions expression, not shell: the copy reporter
    // interpolates it into its log path. Substituted with a literal so the script
    // runs, exactly as Actions would have substituted it before bash saw it.
    return `${kept.replace(/\$\{\{ matrix\.shard \}\}/g, "0")}\nprintf '%s\\n' "$msg"\n`;
  }

  async function runReporter(
    stage: "prepare" | "copy" | "finalize",
    logContents: string | null,
  ): Promise<{ code: number; out: string }> {
    const dir = mkdtempSync(join(tmpdir(), "reporter-"));
    const datasetId = "ds000001";
    if (logContents !== null) {
      const name = stage === "copy" ? `copy-${datasetId}-0.log` : `${stage}-${datasetId}.log`;
      writeFileSync(join(dir, name), logContents);
    }
    const script = join(dir, "reporter.sh");
    // The reporters hardcode /tmp; point them at the scratch directory instead so a
    // parallel test (or a real /tmp file) cannot feed them.
    writeFileSync(script, reporterScript(stage).replaceAll('"/tmp/', `"${dir}/`));
    const proc = Bun.spawn(["bash", "-e", script], {
      env: { ...process.env, DATASET_ID: datasetId, RUN_URL: "https://example/run/1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out: out + err };
  }

  for (const stage of ["prepare", "copy", "finalize"] as const) {
    test(`${stage}: a log with no marker yields the named fallback`, async () => {
      const { code, out } = await runReporter(stage, "cloning...\nsome output\nno marker here\n");
      expect(code).toBe(0);
      expect(out).toContain(`${stage} failed with no CLI failure line captured`);
    });

    test(`${stage}: a MISSING log yields the named fallback`, async () => {
      // The OOM and evicted-runner case: the step that would have written the log
      // never got far enough to create it.
      const { code, out } = await runReporter(stage, null);
      expect(code).toBe(0);
      expect(out).toContain(`${stage} failed with no CLI failure line captured`);
    });

    test(`${stage}: a real CLI failure line still wins over the fallback`, async () => {
      // The fix must not have turned every report into the fallback.
      const { code, out } = await runReporter(
        stage,
        "some output\n[31m✖[39m Failed to push: remote: Invalid username or token.\nmore\n",
      );
      expect(code).toBe(0);
      expect(out).toContain("Failed to push");
      expect(out).not.toContain("no CLI failure line captured");
      // ANSI stripped, marker removed, collapsed to one line.
      expect(out).not.toContain("[");
      expect(out).not.toContain("✖");
    });
  }

  test("prepare still prefers the upstream-inaccessible marker when present", async () => {
    // Its own branch, and the one case whose wording the classifier keys on.
    const { code, out } = await runReporter(
      "prepare",
      "[openneuro-upstream-inaccessible] some detail\n",
    );
    expect(code).toBe(0);
    expect(out).toContain("[openneuro-upstream-inaccessible]");
    expect(out).toContain("not anonymously readable");
  });
});
