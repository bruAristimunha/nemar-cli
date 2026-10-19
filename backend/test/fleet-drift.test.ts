/**
 * Unit tests for the fleet drift classifier (epic #713, phase #719). Pure, no
 * mocks: assert `classifyDatasetDrift` over representative repo states.
 */

import { describe, expect, test } from "bun:test";
import { type RepoDriftState, classifyDatasetDrift } from "../src/services/fleet-drift";

const publicCompliant = (over: Partial<RepoDriftState> = {}): RepoDriftState => ({
  visibility: "public",
  defaultBranch: "main",
  hasBranchRuleset: true,
  rulesetContexts: ["Run BIDS Validation", "version-check"],
  expectedContexts: ["Run BIDS Validation", "version-check"],
  hasRequiredWorkflows: true,
  directReadGrants: 0,
  requiredCheckGreen: true,
  hasDeprecatedWorkflow: false,
  // A dataset the Worker reviews, with the review ruleset in force.
  reviewIntent: "require",
  reviewRuleset: { present: true, active: true },
  ...over,
});

const privateCompliant = (over: Partial<RepoDriftState> = {}): RepoDriftState => ({
  visibility: "private",
  defaultBranch: "main",
  hasBranchRuleset: false,
  rulesetContexts: [],
  expectedContexts: ["Run BIDS Validation", "version-check"],
  hasRequiredWorkflows: true,
  directReadGrants: 0,
  requiredCheckGreen: null,
  hasDeprecatedWorkflow: false,
  // A dataset the Worker does not review, with no review ruleset.
  reviewIntent: "remove",
  reviewRuleset: { present: false, active: false },
  ...over,
});

describe("classifyDatasetDrift", () => {
  test("compliant public and private repos -> COMPLIANT", () => {
    expect(classifyDatasetDrift(publicCompliant())).toEqual(["COMPLIANT"]);
    expect(classifyDatasetDrift(privateCompliant())).toEqual(["COMPLIANT"]);
  });

  test("public without the ruleset -> PUBLIC_UNPROTECTED", () => {
    expect(classifyDatasetDrift(publicCompliant({ hasBranchRuleset: false }))).toContain(
      "PUBLIC_UNPROTECTED",
    );
  });

  test("non-main default branch -> DEFAULT_BRANCH_OUTLIER", () => {
    expect(classifyDatasetDrift(privateCompliant({ defaultBranch: "master" }))).toContain(
      "DEFAULT_BRANCH_OUTLIER",
    );
  });

  test("missing workflows -> MISSING_REQUIRED_WORKFLOW", () => {
    expect(classifyDatasetDrift(publicCompliant({ hasRequiredWorkflows: false }))).toContain(
      "MISSING_REQUIRED_WORKFLOW",
    );
  });

  test("private with a stray read grant -> PRIVATE_WITH_STRAY_READ", () => {
    expect(classifyDatasetDrift(privateCompliant({ directReadGrants: 2 }))).toContain(
      "PRIVATE_WITH_STRAY_READ",
    );
  });

  test("public read grants are not flagged (reconcile strips them, harmless)", () => {
    expect(classifyDatasetDrift(publicCompliant({ directReadGrants: 5 }))).toEqual(["COMPLIANT"]);
  });

  test("protected public with mismatched contexts -> CONTEXT_NAME_MISMATCH", () => {
    expect(
      classifyDatasetDrift(publicCompliant({ rulesetContexts: ["bids-validation"] })),
    ).toContain("CONTEXT_NAME_MISMATCH");
  });

  test("context comparison is order- and dup-independent", () => {
    expect(
      classifyDatasetDrift(
        publicCompliant({
          rulesetContexts: ["version-check", "Run BIDS Validation", "version-check"],
        }),
      ),
    ).toEqual(["COMPLIANT"]);
  });

  test("protected public with a red required check -> RED_REQUIRED_CHECK", () => {
    expect(classifyDatasetDrift(publicCompliant({ requiredCheckGreen: false }))).toContain(
      "RED_REQUIRED_CHECK",
    );
  });

  test("an unprotected public repo is NOT flagged red even if the check is red", () => {
    const b = classifyDatasetDrift(
      publicCompliant({ hasBranchRuleset: false, requiredCheckGreen: false }),
    );
    expect(b).toContain("PUBLIC_UNPROTECTED");
    expect(b).not.toContain("RED_REQUIRED_CHECK");
  });

  test("deprecated workflow present -> DEPRECATED_WORKFLOW_PRESENT", () => {
    expect(classifyDatasetDrift(privateCompliant({ hasDeprecatedWorkflow: true }))).toContain(
      "DEPRECATED_WORKFLOW_PRESENT",
    );
  });

  describe("the required review (ADR 0107)", () => {
    test("a reviewed dataset without the ruleset -> REVIEW_RULESET_MISSING", () => {
      const b = classifyDatasetDrift(
        publicCompliant({ reviewRuleset: { present: false, active: false } }),
      );
      expect(b).toEqual(["REVIEW_RULESET_MISSING"]);
    });

    test("a ruleset that is present and switched off requires nothing, so it is missing too", () => {
      // The break-glass rollback sets enforcement to disabled and leaves the ruleset in place.
      const b = classifyDatasetDrift(
        publicCompliant({ reviewRuleset: { present: true, active: false } }),
      );
      expect(b).toEqual(["REVIEW_RULESET_MISSING"]);
    });

    test("a dataset the Worker does not review, with the ruleset on its repository -> REVIEW_RULESET_STRAY", () => {
      for (const active of [true, false]) {
        const b = classifyDatasetDrift(
          privateCompliant({ reviewRuleset: { present: true, active } }),
        );
        expect(b, String(active)).toEqual(["REVIEW_RULESET_STRAY"]);
      }
    });

    test("nothing is reported where the tooling has no say: the review is off, or a fixture", () => {
      // intent undefined is what reviewIntentOf answers for both; the ruleset is not even read.
      expect(
        classifyDatasetDrift(publicCompliant({ reviewIntent: undefined, reviewRuleset: null })),
      ).toEqual(["COMPLIANT"]);
      // And if one is there anyway, it is not this tooling's to call stray or missing.
      expect(
        classifyDatasetDrift(
          publicCompliant({
            reviewIntent: undefined,
            reviewRuleset: { present: false, active: false },
          }),
        ),
      ).toEqual(["COMPLIANT"]);
    });

    test("a repository GitHub could not be asked about is not reported either way", () => {
      expect(classifyDatasetDrift(publicCompliant({ reviewRuleset: null }))).toEqual(["COMPLIANT"]);
      expect(classifyDatasetDrift(privateCompliant({ reviewRuleset: null }))).toEqual([
        "COMPLIANT",
      ]);
    });

    test("a repository on another default branch is the outlier's finding, not a missing ruleset", () => {
      const b = classifyDatasetDrift(
        publicCompliant({
          defaultBranch: "git-annex",
          reviewRuleset: { present: false, active: false },
        }),
      );
      expect(b).toContain("DEFAULT_BRANCH_OUTLIER");
      expect(b).not.toContain("REVIEW_RULESET_MISSING");
    });

    test("a reviewed dataset with the ruleset in force, and an unreviewed one without, are compliant", () => {
      expect(classifyDatasetDrift(publicCompliant())).toEqual(["COMPLIANT"]);
      expect(classifyDatasetDrift(privateCompliant())).toEqual(["COMPLIANT"]);
    });

    test("it is reported next to the other findings, and not in place of them", () => {
      const b = classifyDatasetDrift(
        publicCompliant({
          hasBranchRuleset: false,
          reviewRuleset: { present: false, active: false },
        }),
      );
      expect(b).toEqual(expect.arrayContaining(["PUBLIC_UNPROTECTED", "REVIEW_RULESET_MISSING"]));
    });
  });

  test("multiple violations are all reported", () => {
    const b = classifyDatasetDrift(
      publicCompliant({
        hasBranchRuleset: false,
        hasRequiredWorkflows: false,
        defaultBranch: "master",
      }),
    );
    expect(b).toEqual(
      expect.arrayContaining([
        "PUBLIC_UNPROTECTED",
        "MISSING_REQUIRED_WORKFLOW",
        "DEFAULT_BRANCH_OUTLIER",
      ]),
    );
    expect(b).not.toContain("COMPLIANT");
  });
});
