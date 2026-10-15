/**
 * The per-dataset BIDS Validation and Version Check shims run on `pull_request_target`, so a
 * pull request from a fork gets its central checks: on `pull_request` GitHub gives a fork's run
 * no secrets, the token step failed with "Input required and not supplied: app-id", and the
 * central validator was never asked (nemarDatasets/nm000182#3, on003825#2).
 *
 * `pull_request_target` runs the file from main WITH the secrets, so these tests pin what makes
 * that safe: nothing from the pull request is checked out or run, every event field reaches the
 * shell through env, and the script checks the fields before it sends them on. The dispatch
 * script is run in real bash with a stub `gh` that records its arguments.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { getWorkflowTemplates } from "../backend/src/services/github";

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, { steps: Step[] }>;
};

const SHIMS = {
  "bids-validation.yml": "run-bids-validation",
  "version-check.yml": "run-version-check",
} as const;

function shim(file: keyof typeof SHIMS): { wf: Workflow; dispatch: Step } {
  const t = getWorkflowTemplates().find((w) => w.path.endsWith(`/${file}`));
  if (!t) throw new Error(`${file} is not shipped`);
  const wf = parse(t.content) as Workflow;
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
  const dispatch = steps.find((s) => s.run?.includes("/dispatches"));
  if (!dispatch) throw new Error(`${file} has no dispatch step`);
  return { wf, dispatch };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
let dir: string;
let ghLog: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fork-shims-"));
  ghLog = join(dir, "gh.log");
  const gh = join(dir, "gh");
  // One argument per line, so a value with spaces or $(...) is seen exactly as received.
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${ghLog}"\n`,
  );
  chmodSync(gh, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runDispatch(step: Step, env: Record<string, string>) {
  writeFileSync(ghLog, "");
  const r = Bun.spawnSync(["bash", "-c", step.run ?? ""], {
    cwd: dir,
    env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "t", ...env },
  });
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    args: readFileSync(ghLog, "utf8").split("\n").filter(Boolean),
  };
}

const forkPr = {
  DATASET_ID: "nm000182",
  HEAD_SHA: SHA,
  REF: "changes-history-20261014",
  PR_NUMBER: "3",
};

for (const file of Object.keys(SHIMS) as (keyof typeof SHIMS)[]) {
  const eventType = SHIMS[file];

  describe(`${file} serves fork pull requests safely`, () => {
    test("it runs on pull_request_target to main, not on pull_request", () => {
      const { wf } = shim(file);
      expect(wf.on).not.toHaveProperty("pull_request");
      expect(wf.on.pull_request_target).toEqual({ branches: ["main"] });
    });

    test("no step checks out or runs anything from the pull request", () => {
      const { wf } = shim(file);
      for (const step of Object.values(wf.jobs).flatMap((j) => j.steps)) {
        expect(step.uses ?? "").not.toMatch(/actions\/checkout/);
        expect(step.run ?? "").not.toMatch(/\$\{\{/);
        expect(step.run ?? "").not.toMatch(/\bgit\s+(clone|fetch|checkout)\b/);
      }
    });

    test("the event fields reach the script through env", () => {
      const { dispatch } = shim(file);
      expect(dispatch.env).toMatchObject({
        DATASET_ID: "${{ github.event.repository.name }}",
        HEAD_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
        REF: "${{ github.event.pull_request.head.ref || github.ref_name }}",
        PR_NUMBER: "${{ github.event.pull_request.number || '' }}",
      });
    });

    test("a fork pull request is dispatched with its head commit", () => {
      const r = runDispatch(shim(file).dispatch, forkPr);
      expect(r.code).toBe(0);
      expect(r.args.slice(0, 2)).toEqual(["api", "repos/nemarDatasets/.github/dispatches"]);
      expect(r.args).toContain(`event_type=${eventType}`);
      expect(r.args).toContain("client_payload[dataset_id]=nm000182");
      expect(r.args).toContain(`client_payload[head_sha]=${SHA}`);
      expect(r.args).toContain("client_payload[ref]=changes-history-20261014");
      expect(r.args).toContain("client_payload[pr_number]=3");
    });

    test("a push to main (no PR number) is dispatched", () => {
      const r = runDispatch(shim(file).dispatch, { ...forkPr, REF: "main", PR_NUMBER: "" });
      expect(r.code).toBe(0);
      expect(r.args).toContain("client_payload[pr_number]=");
    });

    test("a branch name with shell syntax is passed on as data and never echoed", () => {
      const evil = '$(touch pwned)`touch pwned2`";echo ::add-mask::x';
      const r = runDispatch(shim(file).dispatch, { ...forkPr, REF: evil });
      expect(r.code).toBe(0);
      expect(r.args).toContain(`client_payload[ref]=${evil}`);
      expect(r.out).not.toContain("add-mask");
      expect(() => readFileSync(join(dir, "pwned"))).toThrow();
      expect(() => readFileSync(join(dir, "pwned2"))).toThrow();
    });

    for (const [field, value] of [
      ["HEAD_SHA", "main"],
      ["HEAD_SHA", `${SHA}\nx`],
      ["PR_NUMBER", "3; rm -rf /"],
      ["DATASET_ID", ".github"],
      ["DATASET_ID", "nm000182/../x"],
    ] as const) {
      test(`a malformed ${field} (${JSON.stringify(value)}) stops before gh is called`, () => {
        const r = runDispatch(shim(file).dispatch, { ...forkPr, [field]: value });
        expect(r.code).not.toBe(0);
        expect(r.args).toEqual([]);
      });
    }
  });
}
