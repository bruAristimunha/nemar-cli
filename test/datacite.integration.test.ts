/**
 * DataCite / llm-enrich integration tests that reach live external services.
 *
 * validateMeshTerms confirms a MeSH term against the live NLM MeSH API, so these
 * tests make real network calls and are non-deterministic (an NLM outage or slow
 * response fails them). They must NOT gate the required unit-pure tier or the
 * deploy gate; the `*.integration.test.ts` suffix keeps them in the soft
 * integration-dev tier (see test.yml / deploy-backend.yml classifiers, #963).
 */

import { describe, expect, test } from "bun:test";
import { validateMeshTerms } from "../backend/src/services/llm-enrich";
import type { NemarMetadataV2 } from "../shared/datacite-constants";

// CI has seen one NLM answer take 25 seconds, so the default 30-second budget leaves no margin.
// Only the two tests that reach the live API get this budget; their assertions are unchanged.
const NLM_TIMEOUT_MS = 120_000;

describe("validateMeshTerms", () => {
  test("returns unchanged metadata when no keywords", async () => {
    const metadata: NemarMetadataV2 = { version: "2.0" };
    const { metadata: result, log } = await validateMeshTerms(metadata);
    expect(result).toEqual(metadata);
    expect(log).toHaveLength(0);
  });

  test("strips non-MeSH schemes without calling API", async () => {
    const metadata: NemarMetadataV2 = {
      version: "2.0",
      keywords: [
        {
          term: "Brain",
          subject_scheme: "LCSH",
          scheme_uri: "http://id.loc.gov/authorities/subjects",
        },
        { term: "Neuroscience", subject_scheme: "FAST" },
        { term: "plain keyword" },
      ],
    };
    const { metadata: result, log } = await validateMeshTerms(metadata);
    // LCSH and FAST schemes should be stripped
    expect(log).toHaveLength(2);
    expect(log[0].action).toBe("scheme_removed");
    expect(log[1].action).toBe("scheme_removed");
    // Keywords should remain but without schemes
    expect(result.keywords).toHaveLength(3);
    expect(result.keywords?.[0].subject_scheme).toBeUndefined();
    expect(result.keywords?.[1].subject_scheme).toBeUndefined();
    // Plain keyword passes through untouched
    expect(result.keywords?.[2]).toEqual({ term: "plain keyword" });
  });

  test(
    "confirms valid MeSH term via NLM API",
    async () => {
      const metadata: NemarMetadataV2 = {
        version: "2.0",
        keywords: [{ term: "Electroencephalography", subject_scheme: "MeSH" }],
      };
      const { metadata: result, log } = await validateMeshTerms(metadata);
      expect(log).toHaveLength(1);
      expect(log[0].action).toBe("confirmed");
      expect(log[0].mesh_uri).toContain("nlm.nih.gov/mesh");
      expect(result.keywords?.[0].value_uri).toContain("nlm.nih.gov/mesh");
      expect(result.keywords?.[0].subject_scheme).toBe("MeSH");
    },
    NLM_TIMEOUT_MS,
  );

  test(
    "strips scheme from invalid MeSH term",
    async () => {
      const metadata: NemarMetadataV2 = {
        version: "2.0",
        keywords: [{ term: "BrainWaveStuff123NotReal", subject_scheme: "MeSH" }],
      };
      const { metadata: result, log } = await validateMeshTerms(metadata);
      expect(log).toHaveLength(1);
      expect(log[0].action).toBe("scheme_removed");
      expect(result.keywords?.[0].subject_scheme).toBeUndefined();
      expect(result.keywords?.[0].term).toBe("BrainWaveStuff123NotReal");
    },
    NLM_TIMEOUT_MS,
  );
});
