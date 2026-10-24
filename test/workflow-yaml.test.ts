/**
 * Workflow YAML Validation Tests
 *
 * Validates that all CI workflow templates in deployWorkflows() produce
 * syntactically valid YAML. This prevents regressions like #285 where
 * unescaped \n in JS template literals broke the deployed YAML.
 *
 * It also checks how the repository's own test workflow routes changes to jobs. That every
 * workflow gives its `gh` calls a repository is checked in `workflow-gh-calls.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { buildEnrichmentCommitPayload } from "../backend/src/services/enrich-dataset";
import { getWorkflowTemplates } from "../backend/src/services/github";
import { VALIDATOR_VERSION } from "../src/lib/bids-validator";
import validatorPin from "../validator-version.json" with { type: "json" };

describe("CI workflow templates", () => {
  const templates = getWorkflowTemplates();

  test("all templates produce valid YAML", () => {
    for (const { path, content } of templates) {
      let parsed: unknown;
      try {
        parsed = parse(content);
      } catch (err) {
        throw new Error(
          `${path}: Invalid YAML - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    }
  });

  test("all templates have required GitHub Actions top-level keys", () => {
    for (const { path, content } of templates) {
      const parsed = parse(content) as Record<string, unknown>;
      expect(parsed.name).toBeDefined();
      expect(parsed.on).toBeDefined();
      expect(parsed.jobs).toBeDefined();
    }
  });

  test("webhook URLs target the canonical api.nemar.org host", () => {
    for (const { path, content } of templates) {
      // The legacy api.osc.earth host is in read-only buffer mode and will be
      // sunset; templates emitted into dataset repos must target SCCN prod.
      expect(content).not.toContain("api.osc.earth");
      if (content.includes("/webhooks/")) {
        expect(content).toMatch(/https:\/\/api\.nemar\.org\/webhooks\//);
      }
    }
  });

  test("buildEnrichmentCommitPayload returns the contract field set", () => {
    // The llm-enrichment.yml Action reads exactly these field names via jq.
    // Pin the contract so a typo (`bidsignore_entry`, dropped key) is caught
    // by a unit test instead of by a silent no-op on the Action side.
    const payload = buildEnrichmentCommitPayload(
      '{"hello":"world"}',
      [".nemar/", "extra"],
      "Update X",
    );
    expect(payload.metadata_path).toBe(".nemar/metadata.json");
    expect(payload.metadata_content).toBe('{"hello":"world"}');
    expect(payload.bidsignore_entries).toEqual([".nemar/", "extra"]);
    expect(payload.commit_message).toBe("Update X");
    // The set of keys IS the contract; any future addition must be explicit.
    expect(Object.keys(payload).sort()).toEqual([
      "bidsignore_entries",
      "commit_message",
      "metadata_content",
      "metadata_path",
    ]);
  });

  test("llm-enrichment.yml is no longer shipped per-repo (centralized, #602)", () => {
    // The template is relocated to
    // `nemarDatasets/.github/.github/workflows/run-enrichment.yml` and
    // triggered via the Worker's /webhooks/github push handler. A future
    // edit that adds it back to deployWorkflows() would defeat the
    // centralization; pin the absence.
    const llm = templates.find((t) => t.path.endsWith("llm-enrichment.yml"));
    expect(llm).toBeUndefined();
  });

  test("version-doi.yml is no longer shipped per-repo (centralized, #606)", () => {
    // The template is relocated to
    // `nemarDatasets/.github/.github/workflows/run-version-doi.yml` and
    // triggered via the Worker's /webhooks/github tag-push handler. Pin
    // the absence so a future edit can't accidentally re-ship it.
    const versionDoi = templates.find((t) => t.path.endsWith("version-doi.yml"));
    expect(versionDoi).toBeUndefined();
  });

  test("generate-archive.yml is no longer shipped per-repo (centralized, #608)", () => {
    // The template is relocated to
    // `nemarDatasets/.github/.github/workflows/run-generate-archive.yml`.
    // The archiver-v7 pin still matters but is now reviewed on that
    // workflow's PR; pin the absence here so a re-shipment is caught.
    const archive = templates.find((t) => t.path.endsWith("generate-archive.yml"));
    expect(archive).toBeUndefined();
  });

  test("shim templates mint App tokens and never reference secrets.GITHUB_TOKEN", () => {
    // Each shim template authenticates as the App and dispatches to
    // nemarDatasets/.github; the token must be scoped to `.github` (where
    // the dispatch lands) NOT to the current repo. The central workflow
    // mints its own per-dataset token internally for the checkout step.
    // Phases #602/#606/#608 already removed their per-repo templates;
    // Phase 4 (#610) replaces bids-validation.yml + pr-merge.yml with
    // shims that follow this contract.
    const shimTemplates = ["pr-merge.yml", "bids-validation.yml", "version-check.yml"];
    for (const name of shimTemplates) {
      const tpl = templates.find((t) => t.path.endsWith(name));
      expect(tpl, `${name} missing from templates`).toBeDefined();
      if (!tpl) continue;
      expect(tpl.content).not.toContain("secrets.GITHUB_TOKEN");

      const parsed = parse(tpl.content) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      for (const [jobName, job] of Object.entries(parsed.jobs)) {
        const mintIdx = job.steps.findIndex((s) => s.uses === "actions/create-github-app-token@v1");
        // Not every job in a shim template mints (e.g. pr-merge's
        // cleanup-staging job uses AWS only). Only check when present.
        if (mintIdx < 0) continue;
        // Ordering: mint must be the first step so subsequent
        // dispatch calls can reference its outputs.
        expect(
          mintIdx,
          `${name}:${jobName} app-token step must be first (was index ${mintIdx})`,
        ).toBe(0);
        const mintWith = (job.steps[mintIdx].with ?? {}) as Record<string, unknown>;
        expect(mintWith["app-id"]).toBe("${{ secrets.NEMAR_APP_ID }}");
        expect(mintWith["private-key"]).toBe("${{ secrets.NEMAR_APP_PRIVATE_KEY }}");
        expect(mintWith.owner).toBe("nemarDatasets");
        // Phase 4 contract: shims mint a token scoped to .github (so they
        // can call repos/.github/dispatches), not the current dataset repo.
        // The central workflows on .github mint their own per-dataset
        // tokens for actual writes against the target repo.
        expect(mintWith.repositories).toBe(".github");

        // Any GH_TOKEN env in the rest of the job's steps must reference
        // the minted token, not a stale `secrets.GITHUB_TOKEN` left behind.
        for (const step of job.steps) {
          const env = (step.env ?? {}) as Record<string, unknown>;
          if ("GH_TOKEN" in env) {
            expect(env.GH_TOKEN).toBe("${{ steps.app-token.outputs.token }}");
          }
        }
      }
    }
  });

  test("shim templates dispatch to nemarDatasets/.github (centralization endstate)", () => {
    // The bids-validation and pr-merge shims must hit
    // repos/nemarDatasets/.github/dispatches with the right event_type so
    // the central workflows on .github receive the request. A future edit
    // that points the dispatch back at the dataset repo would undo the
    // centralization without obvious symptoms (the legacy workflows have
    // been stripped from dataset repos).
    const shimContracts: Array<{ name: string; eventType: string }> = [
      { name: "bids-validation.yml", eventType: "run-bids-validation" },
      { name: "pr-merge.yml", eventType: "run-pr-merge" },
      { name: "version-check.yml", eventType: "run-version-check" },
    ];
    for (const { name, eventType } of shimContracts) {
      const tpl = templates.find((t) => t.path.endsWith(name));
      expect(tpl, `${name} missing from templates`).toBeDefined();
      if (!tpl) continue;
      expect(tpl.content).toContain('"repos/nemarDatasets/.github/dispatches"');
      expect(tpl.content).toContain(`event_type=${eventType}`);
      expect(tpl.content).toContain('"client_payload[dataset_id]=$DATASET_ID"');
    }
  });

  test("bids-validation shim interpolates VALIDATOR_VERSION into the dispatch payload", () => {
    // Code-review #12 fix: the central workflow has no way to know which
    // validator version the CLI is currently pinned to, so the shim must
    // pass it as a client_payload field. The literal value lives in
    // validator-version.json and propagates through src/lib/bids-validator.ts
    // -> VALIDATOR_VERSION -> the shim's template-literal interpolation.
    const tpl = templates.find((t) => t.path.endsWith("bids-validation.yml"));
    expect(tpl, "bids-validation.yml missing from templates").toBeDefined();
    if (!tpl) return;
    // The shim must include the field, AND the value must match the pin.
    expect(tpl.content).toMatch(/client_payload\[validator_version\]=[0-9]+\.[0-9]+\.[0-9]+/);
    expect(tpl.content).toContain(`client_payload[validator_version]=${VALIDATOR_VERSION}`);
  });

  // The "App-token in BOTH jobs" contract for version-doi was specific to
  // the per-repo template. With Phase 2 centralization (#606) the
  // equivalent invariant lives in the run-version-doi.yml on
  // nemarDatasets/.github and is reviewed in that PR; this test is
  // removed rather than asserting a property of a template that no longer
  // ships from this repo.

  test("CLI BIDS validator pin stays in lockstep with the version-of-record", () => {
    // After Phase 4 (#610) the per-repo bids-validation.yml is a shim
    // and no longer contains the validator version — the central
    // run-bids-validation.yml on nemarDatasets/.github runs the
    // validator. The validator-version.json pin remains the source of
    // truth that the CLI runtime uses; this assertion stays so a future
    // CLI change can't drift from the pin file.
    expect(VALIDATOR_VERSION).toBe(validatorPin.version);
    expect(VALIDATOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The "read-only templates stay on the auto-token" test asserted that
  // version-check.yml carries no App-token step. Phase 4 (#610) turns it
  // into a dispatch shim, which must mint a token scoped to .github to
  // reach repos/nemarDatasets/.github/dispatches -- so the property no
  // longer holds, and version-check.yml was the list's only entry. Rather
  // than keep a vacuous loop, its coverage moved into the two shim tests
  // above, which are strictly stronger: they pin the token scoping, the
  // mint-step ordering, and the dispatch event_type. Same treatment the
  // bids-validation and generate-archive templates got in earlier phases.

  test("no literal newlines inside shell strings (escape regression)", () => {
    for (const { path, content } of templates) {
      // In valid YAML, printf format strings and jq arguments should
      // contain the two-character sequence \n, not a real newline.
      // A real newline inside a single-quoted shell string would appear
      // as a line ending with an unclosed quote.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        // Skip YAML keys, list items, conditionals, and shell comments
        if (
          trimmed.startsWith("name:") ||
          trimmed.startsWith("-") ||
          trimmed.startsWith("if:") ||
          trimmed.startsWith("#")
        ) {
          continue;
        }
        // Check for lines that end with an unclosed single quote
        // (indicating a literal newline broke the string)
        const singleQuotes = (line.match(/'/g) || []).length;
        if (singleQuotes % 2 !== 0) {
          throw new Error(
            `${path}:${i + 1}: Possible unescaped newline in shell string - odd number of single quotes: ${trimmed}`,
          );
        }
      }
    }
  });
});

/**
 * `lint`, `unit-pure-shard` and the `unit-pure` gate all read ONE `changes` output,
 * `unit_pure_due`, so they cannot disagree about whether they were due. The nine filter terms
 * live in that output's expression.
 */
type DueWorkflow = { jobs: Record<string, { if?: string; outputs?: Record<string, string> }> };

function unitPureDue(workflow: DueWorkflow): string {
  return String(workflow.jobs.changes.outputs?.unit_pure_due ?? "");
}

function expectDueJobs(workflow: DueWorkflow): void {
  for (const job of ["lint", "unit-pure-shard", "unit-pure"]) {
    expect(workflow.jobs[job]?.if ?? "", job).toContain(
      "needs.changes.outputs.unit_pure_due == 'true'",
    );
  }
}

describe("the repo's own test workflow routes changes to jobs", () => {
  /**
   * `.github/workflows/test.yml` decides which jobs run from a
   * `dorny/paths-filter` result, and a path matched by NO filter runs NOTHING:
   * the PR goes green having been compiled by nothing at all. That is not a
   * hypothetical -- `shared/**` (the wire contract, the facet vocabulary, the
   * two published Zarr JSON Schemas) was imported by both `src/` and
   * `backend/` and matched by neither filter, so a shared-only PR merged
   * untested.
   *
   * Asserted here rather than left to review, because the failure is silent in
   * exactly the direction nobody checks: a green PR with no jobs.
   */
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8"),
  ) as {
    jobs: Record<string, { if?: string; outputs?: Record<string, string>; steps?: unknown[] }>;
  };

  const filterNames = (): string[] => {
    const steps = (workflow.jobs.changes.steps ?? []) as { with?: { filters?: string } }[];
    const filters = steps.find((s) => s.with?.filters)?.with?.filters ?? "";
    // Top-level keys of the filters block: `name:` at zero indentation.
    return [...filters.matchAll(/^(\w+):/gm)].map((m) => m[1]);
  };

  test("every declared filter is exported as a job output", () => {
    // A filter with no output is unreadable by every downstream `if:`, which
    // evaluates to false and skips the job -- the same silent nothing.
    const outputs = Object.keys(workflow.jobs.changes.outputs ?? {});
    for (const name of filterNames()) {
      expect(outputs).toContain(name);
    }
  });

  test("shared/** has a filter, and gates the jobs that compile it", () => {
    expect(filterNames()).toContain("shared");
    expect(unitPureDue(workflow)).toContain("steps.filter.outputs.shared == 'true'");
    expect(workflow.jobs["integration-dev"]?.if ?? "").toContain("outputs.shared == 'true'");
    expectDueJobs(workflow);
  });

  test("workflow files have a filter, and gate lint and unit-pure alike", () => {
    // test/workflow-gh-calls.test.ts polices every workflow, but a pull request that edits
    // only a workflow matches no other filter and would run no job. `unit-pure` is the job
    // that runs the test, so it must be wired. `lint` is wired too, but that is convention
    // (the two `if:` conditions stay identical), not a requirement: a job skipped by its
    // `if:` reports Success and does not block a required check.
    expect(filterNames()).toContain("workflows");
    expect(unitPureDue(workflow)).toContain("steps.filter.outputs.workflows == 'true'");
    expectDueJobs(workflow);
    const filtersText = (workflow.jobs.changes.steps as { with?: { filters?: string } }[]).find(
      (s) => s.with?.filters,
    )?.with?.filters;
    // Parsed, not searched: the globs must sit under the `workflows:` key, not merely appear
    // somewhere in the block (under another filter, or in a comment).
    const filters = parse(filtersText ?? "") as Record<string, string[]>;
    expect(filters.workflows).toEqual(
      expect.arrayContaining([".github/workflows/**", ".github/dataset-workflows/**"]),
    );
  });

  test("the source trees the jobs build all have a filter", () => {
    // If a new top-level source directory appears without one, it is invisible
    // to CI. Keep this list in step with what the jobs actually compile.
    for (const name of ["cli", "backend", "tests", "shared", "zarr"]) {
      expect(filterNames()).toContain(name);
    }
  });
});

describe("a change to the validator pin alone", () => {
  /**
   * `validator-version.json` is read by the CLI (`src/lib/bids-validator.ts`) and bundled into
   * the Worker (`backend/src/services/github/shared.ts`), and the monthly bump changes that file
   * and nothing else. A path that no filter in `test.yml` lists runs no job, and a skipped job
   * reports its required check as passing; a path that `deploy-backend.yml` does not list
   * redeploys nothing. Both fail silently, so both are asserted from the real workflow files.
   */
  const readWorkflow = (file: string): unknown =>
    parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));

  test("runs lint and unit-pure: the cli filter lists the pin", () => {
    const workflow = readWorkflow("test.yml") as {
      jobs: Record<string, { if?: string; steps?: { with?: { filters?: string } }[] }>;
    };
    const filtersText = workflow.jobs.changes.steps?.find((s) => s.with?.filters)?.with?.filters;
    // Parsed, not searched: the entry must sit under `cli:`, not merely appear in the block
    // (under another filter, or in a comment).
    const filters = parse(filtersText ?? "") as Record<string, string[]>;
    expect(filters.cli).toContain("validator-version.json");
    expect(unitPureDue(workflow)).toContain("steps.filter.outputs.cli == 'true'");
    expectDueJobs(workflow);
  });

  test("redeploys the Worker: a push to main that changes the pin is a deploy path", () => {
    const deploy = readWorkflow("deploy-backend.yml") as {
      on: { push: { branches: string[]; paths: string[] } };
    };
    expect(deploy.on.push.branches).toEqual(["main"]);
    expect(deploy.on.push.paths).toContain("validator-version.json");
  });
});
