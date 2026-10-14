/**
 * The CLI describes the publication it is about to run, not a different one
 * (#1447).
 *
 * The approve confirmation and `nemar dataset publish status` both rendered
 * `PUBLICATION_STEPS` unconditionally. An admin approving an ANONYMOUS RELEASE
 * was therefore shown a sixteen-step plan including "Make repo public" and
 * "Publish DOI (irreversible)", neither of which happens, and then watched the
 * progress stop short on a release that had finished. Measured on the dev
 * worker while building nm099998: the banner listed all sixteen and the
 * orchestrator ran ELEVEN, because the skip list then held five steps --
 * `version_doi` was on it, which is the other half of #1447. With that step
 * restored the set is the twelve `ANONYMOUS_RELEASE_STEPS` names, and the
 * assertions below are written against the list rather than against either
 * number, so removing a step from the skip list cannot make them stale.
 *
 * The live progress renderer was always right, because the backend hands it
 * the real step set. These two built their own.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANONYMOUS_RELEASE_SKIPPED_STEPS,
  PUBLICATION_STEPS,
  PUBLICATION_STEP_LABELS,
  stepsForRelease,
} from "../shared/publication-steps";

const SRC = join(import.meta.dir, "..", "src");

describe("stepsForRelease", () => {
  test("an anonymous release is the publication minus exactly the skipped steps", () => {
    const anonymous = stepsForRelease(true);
    const ordinary = stepsForRelease(false);

    expect(ordinary).toEqual(PUBLICATION_STEPS);
    expect(anonymous.length).toBe(
      PUBLICATION_STEPS.length - ANONYMOUS_RELEASE_SKIPPED_STEPS.length,
    );
    for (const skipped of ANONYMOUS_RELEASE_SKIPPED_STEPS) {
      expect(anonymous).not.toContain(skipped);
    }
    // Order is preserved, because both displays number the steps and an admin
    // reads the number against what the orchestrator reports.
    expect([...anonymous]).toEqual(PUBLICATION_STEPS.filter((s) => anonymous.includes(s)));
  });

  test("version_doi is in the anonymous set, and it is the one that carries the manifest", () => {
    // The reason this is not obvious: the step's NAME says DOI. Skipping it
    // left a released anonymous deposit with no dataset_versions row, so the
    // data plane answered "Version not published" for data the release had
    // just made public.
    expect(stepsForRelease(true)).toContain("version_doi");
  });
});

describe("PUBLICATION_STEP_LABELS", () => {
  test("every step has a non-empty label", () => {
    // The map is total by type, so this catches the other half: a step
    // added with an empty string to satisfy the compiler.
    for (const step of PUBLICATION_STEPS) {
      expect(PUBLICATION_STEP_LABELS[step].trim().length).toBeGreaterThan(0);
    }
  });

  test("repo_public says which thing goes public", () => {
    // `repo_public` keeps the GitHub repository PRIVATE for an anonymous
    // release -- it is the catalog row that flips. The old banner's "Make repo
    // public" was the single most misleading line on the approval screen.
    //
    // Asserted positively. The first version of this was
    // `.not.toContain("repo public")`, which pins one wrong spelling rather
    // than the promise: "Publish the repo" and "Make repository public" both
    // pass it while saying exactly the thing that was wrong.
    expect(PUBLICATION_STEP_LABELS.repo_public).toBe("Make catalog row public");
  });

  test("no label claims the git repository is published", () => {
    // The general form of the above, across every label: an anonymous release
    // runs 12 of the 16 steps and the repository stays private through all of
    // them, so no step may describe itself as publishing a repo.
    for (const step of PUBLICATION_STEPS) {
      expect(PUBLICATION_STEP_LABELS[step].toLowerCase()).not.toMatch(/repo(sitory)?\b/);
    }
  });
});

describe("neither display builds its own step list", () => {
  test("the approve banner asks what the request is before describing it", () => {
    const ADMIN = readFileSync(join(SRC, "commands", "admin-publish-approve.ts"), "utf8");
    expect(ADMIN).toContain("stepsForRelease(anonymousRelease)");
    // The review detail the command just read carries `anonymous` and is the first source; the
    // status read is the fallback when there is no detail (the CLI tests run both).
    expect(ADMIN).toContain("read.detail.anonymous");
    expect(ADMIN).toContain("getPublishStatus(datasetId)");
    // The hand-numbered literal that drifted. Its absence is the fix.
    expect(ADMIN).not.toContain("16-step orchestrator:");
    expect(ADMIN).not.toContain("4. Make repo public");
  });

  test("publish status renders the set the release actually runs", () => {
    const DATASET = readFileSync(join(SRC, "commands", "dataset.ts"), "utf8");
    expect(DATASET).toContain("stepsForRelease(result.anonymous === true)");
  });
});
