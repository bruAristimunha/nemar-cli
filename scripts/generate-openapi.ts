#!/usr/bin/env bun
/**
 * Generates the OpenAPI 3.1 document served at `GET /openapi.json`, FROM the
 * Zod schemas in `shared/contract/` -- never hand-written (issue #937 item 2,
 * phase 5 of epic nemarOrg/website#284).
 *
 * Shape (b) from the issue: build-time generation into a checked-in static
 * artifact (`shared/openapi.json`), imported by `backend/src/routes/openapi.ts`
 * the same way `backend/src/routes/schemas.ts` imports
 * `shared/zarr-index.schema.json` -- "One file, two readers". This keeps
 * generation cost off the Worker's critical path (issue #937 explicitly
 * flags request-time generation, shape (a), as the alternative) and matches
 * this repo's existing precedent for serving a contract document: static,
 * D1-free, and unable to drift from the schema it is generated from because
 * a test regenerates it and diffs (see the DRIFT GUARD note below).
 *
 * DESCRIPTIVE ONLY (issue #937 item 2, hard constraint): every response
 * schema handed to the registry below is the EXACT object exported from
 * `shared/contract/*.ts` -- registered as-is, never hand-rebuilt, narrowed,
 * or given a different shape. `shared/contract/*.ts` itself is untouched by
 * this change (no `.describe()`/`.openapi()` annotations added there): this
 * file calls `extendZodWithOpenApi(z)` against the SAME `zod` module
 * instance those schemas were built from (both resolve "zod" from this
 * repo's root `node_modules`, since neither `scripts/` nor `shared/` has a
 * `node_modules` of its own to shadow it -- verified before writing this),
 * so `.openapi()` becomes callable on the already-constructed exports
 * without editing them. `OpenAPIRegistry#register()` also does not mutate
 * its argument (it returns a new wrapped clone, per
 * @asteasolutions/zod-to-openapi's own `ZodType.prototype.openapi`
 * implementation) so the exported contract objects are unchanged after this
 * script runs, in memory or on disk.
 *
 * NOT $ref'd, on purpose: nested shapes (CatalogItem, SearchHit, the facet
 * vocabulary entry, ...) are left to zod-to-openapi's own inline expansion
 * rather than separately registered as named components. The four envelope
 * schemas below embed the ORIGINAL contract object references (e.g.
 * `datasetListEnvelopeSchema`'s `datasets` field holds the literal
 * `catalogItemSchema` export), and `register()` returning a clone rather
 * than mutating means a nested schema registered independently would never
 * be recognized by the generator's own identity-based dedup as "the same
 * instance" embedded in the envelope -- getting a $ref there would require
 * reconstructing the envelope's field list by hand in this file, which is
 * exactly the drift risk this generator exists to remove. Inlining is valid
 * OpenAPI 3.1 / JSON Schema; it costs document size, not correctness.
 *
 * VersionTag IS registered as its own reusable component (per the issue),
 * using `strictVersionTagSchema` (the plain, non-transforming regex schema)
 * rather than the coercing `versionTagSchema` embedded in the contract's
 * `latest_version` field: zod-to-openapi represents a `ZodEffects` transform
 * by its PRE-transform (input) shape, since an arbitrary transform function's
 * output type is undecidable in general -- so the auto-generated inline
 * `latest_version` field describes what a caller could send in, while the
 * separately-registered `VersionTag` component describes the canonical
 * `vX.Y.Z` form the API actually SERVES on the wire. Both are accurate; they
 * describe different things, which is why VersionTag exists on its own.
 *
 * `info.version` is a fixed literal, deliberately NOT `package.json`'s
 * version: that version is CI-owned (ADR 0016, auto-tag.yml) and bumps on
 * every release with no schema change at all, which would make the DRIFT
 * GUARD test below fail on a routine version bump that changed nothing this
 * document describes. Bump the literal by hand only when the documented
 * contract's shape actually changes.
 *
 * DRIFT GUARD: backend/test/openapi-document.test.ts imports
 * `buildOpenApiDocument` from this file and asserts it deep-equals the
 * committed `shared/openapi.json` -- so editing a contract schema or a facet
 * definition without re-running this script fails that test.
 *
 * Run: `bun run scripts/generate-openapi.ts` (writes `shared/openapi.json`).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { z } from "zod";
import {
  datasetDetailEnvelopeSchema,
  datasetFacetsEnvelopeSchema,
  datasetListEnvelopeSchema,
  datasetSearchEnvelopeSchema,
} from "../shared/contract/dataset.js";
import { strictVersionTagSchema } from "../shared/contract/version.js";
import { FACETS, type FacetDefinition, type FacetValueKind } from "../shared/facets.js";

extendZodWithOpenApi(z);

/** Fixed literal -- see the module doc's `info.version` note above. Bump
 *  when the documented contract's shape changes, not on a package release. */
const OPENAPI_DOCUMENT_VERSION = "1.0.0";

/**
 * One query-string parameter schema per facet in `shared/facets.ts`, keyed
 * by its actual wire `queryParam` (not `key`, which is hyphenated for four
 * of them -- see FacetDefinition's doc comment on that split). Built
 * programmatically from the same `FACETS` table `dataset-facets.ts` binds
 * to SQL, so a facet added there is documented here automatically without
 * this file needing to change.
 */
function facetParamSchema(facet: FacetDefinition): z.ZodTypeAny {
  const label = facet.unit ? `${facet.label} (${facet.unit})` : facet.label;
  const rangeGrammar =
    'Range filter (shared/range.ts): "a..b" (between, inclusive), "a.." (at least), ' +
    '"..b" (at most), or a bare "a" for an exact match.';
  const byValueKind: Record<FacetValueKind, string> = {
    number: `${label}. ${rangeGrammar} Plain numbers only, no unit suffix.`,
    bytes: `${label}. ${rangeGrammar} A bare number is bytes; optional 1024-based unit suffixes b/kb/mb/gb/tb (e.g. "1.5gb..").`,
    duration: `${label}. ${rangeGrammar} A bare number is seconds; optional unit suffixes s/m/h/d (e.g. "30m..2h").`,
    enum: `${label}.`,
    text: `${label} (substring match).`,
    version: `${label}, e.g. "2.1.0".`,
  };
  const description = byValueKind[facet.valueKind];
  if (facet.valueKind === "enum" && facet.enumValues && facet.enumValues.length > 0) {
    return z
      .enum(facet.enumValues as [string, ...string[]])
      .optional()
      .describe(description);
  }
  return z.string().optional().describe(description);
}

const FACET_QUERY_PARAMS: Record<string, z.ZodTypeAny> = Object.fromEntries(
  FACETS.map((facet) => [facet.queryParam, facetParamSchema(facet)]),
);

/**
 * The nine legacy bespoke filters `parseFilterQuery`
 * (backend/src/routes/datasets/catalog.ts) parses in addition to the facet
 * table, shared verbatim by GET /datasets and GET /datasets/search. `search`
 * is deliberately NOT here: it is list-only (the search route's free text is
 * `q` instead -- `parseFilterQuery`'s `includeSearch: false` on that route).
 */
const LEGACY_FILTER_PARAMS = {
  modality: z.string().optional().describe("Filter by modality name (exact match)."),
  author: z.string().optional().describe("Filter by author name (substring match)."),
  task: z.string().optional().describe("Filter by BIDS task name (substring match)."),
  has_doi: z
    .enum(["true"])
    .optional()
    .describe(
      'Only datasets with a concept DOI. Any value other than the literal "true" is ignored (no filter applied).',
    ),
  has_hed: z
    .enum(["1", "true"])
    .optional()
    .describe('Only datasets with HED annotations. "1" or "true" enable the filter.'),
  has_zarr: z
    .enum(["1", "true"])
    .optional()
    .describe('Only datasets with a ready Zarr conversion. "1" or "true" enable the filter.'),
  has_zarr_verified: z
    .enum(["1", "true"])
    .optional()
    .describe(
      'Only datasets whose Zarr conversion also passed the standing fidelity sweep. "1" or "true" enable the filter.',
    ),
  data_complete: z
    .enum(["1", "true"])
    .optional()
    .describe(
      'Only datasets whose latest version has every manifest entry verified present in S3, whole or as a complete chunk set. "1" or "true" enable the filter.',
    ),
  recent: z.number().int().optional().describe("Only datasets created within the last N days."),
  license: z
    .string()
    .optional()
    .describe(
      "Comma-separated license tier tokens (OR semantics). Unrecognized tokens are dropped.",
    ),
  include_unknown: z
    .enum(["1", "true"])
    .optional()
    .describe(
      'Include rows unknown for the active facet filters instead of excluding them by default (ADR 0032). "1" or "true" enable it.',
    ),
} as const;

const listQuerySchema = z.object({
  mine: z
    .enum(["true"])
    .optional()
    .describe(
      "Only the authenticated caller's own managed datasets. Requires auth; ignores every other filter below except the shared ones.",
    ),
  status: z.string().optional().describe('Dataset status filter. Default "active".'),
  limit: z.number().int().min(1).max(200).optional().describe("Page size, 1-200. Default 50."),
  offset: z.number().int().min(0).optional().describe("Pagination offset. Default 0."),
  owner: z.string().optional().describe("Filter by owner username."),
  sort: z
    .enum(["newest", "oldest", "name", "participants", "size", "citations"])
    .optional()
    .describe('Sort order. Default "newest".'),
  search: z
    .string()
    .optional()
    .describe("Free-text search over name/description/tasks/authors (FTS5-backed)."),
  ...LEGACY_FILTER_PARAMS,
  ...FACET_QUERY_PARAMS,
});

const searchQuerySchema = z.object({
  q: z
    .string()
    .describe("Search query. Required; drives exact dataset-id, semantic, and FTS5 tiers."),
  limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100. Default 20."),
  offset: z.number().int().min(0).optional().describe("Pagination offset. Default 0."),
  min_score: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum semantic similarity score, 0-1. Default 0.6."),
  ...LEGACY_FILTER_PARAMS,
  ...FACET_QUERY_PARAMS,
});

const datasetIdParam = z.object({
  id: z.string().describe('NEMAR dataset id, e.g. "nm000123" or a sandbox "xx######" id.'),
});

/**
 * Not part of `shared/contract` (that directory documents success payloads
 * only), so this is new material rather than a re-derivation of an existing
 * schema. It intentionally under-specifies the many route-specific error
 * strings -- documenting the wire ENVELOPE shape these routes share, not
 * every message.
 */
const errorResponseSchema = z
  .object({
    error: z.string(),
    details: z.string().optional(),
  })
  .passthrough();

/**
 * zod-to-openapi (as of 7.3.4) renders `z.enum([...]).nullable()` as
 * `{ type: ["string", "null"], enum: [...] }` -- `type` correctly allows
 * null, but the `enum` array is never widened to include it, so the two
 * keywords disagree: per JSON Schema, `enum` is an independent constraint on
 * the VALUE, so a schema with `type` allowing null but `enum` omitting it
 * still rejects null (caught by backend/test/openapi-document.test.ts's
 * round-trip check against a real nullable `zarr_status`/`attestation_*`
 * row). This walks the generated document and adds `null` to every `enum`
 * array whose sibling `type` allows it -- a mechanical fix to the OUTPUT
 * representation of an already-nullable Zod schema, not a change to what any
 * contract schema accepts.
 */
function fixNullableEnums<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map((item) => fixNullableEnums(item)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const fixedEntries = Object.entries(obj).map(([key, value]) => [key, fixNullableEnums(value)]);
    const fixed = Object.fromEntries(fixedEntries) as Record<string, unknown>;
    const type = fixed.type;
    const typeAllowsNull = Array.isArray(type) && type.includes("null");
    if (typeAllowsNull && Array.isArray(fixed.enum) && !fixed.enum.includes(null)) {
      fixed.enum = [...fixed.enum, null];
    }
    return fixed as T;
  }
  return node;
}

/** Pure and side-effect-free beyond the module-level `extendZodWithOpenApi`
 *  call above: builds a fresh registry and document every call, so the
 *  drift-guard test can call it repeatedly and compare. */
export function buildOpenApiDocument(): OpenAPIObject {
  const registry = new OpenAPIRegistry();

  const VersionTag = registry.register(
    "VersionTag",
    strictVersionTagSchema.openapi({
      description:
        "Canonical dataset-version tag as served on the wire: always the v-prefixed " +
        "semver form (vX.Y.Z). See shared/contract/version.ts -- toVersionTag()/" +
        "isVersionTag() are the single source of truth both the catalog and data " +
        "planes route through.",
      example: "v1.2.0",
    }),
  );

  const ErrorResponse = registry.register(
    "ErrorResponse",
    errorResponseSchema.openapi({
      description: "Generic error envelope returned by these routes on a 4xx/5xx.",
    }),
  );

  const DatasetListEnvelope = registry.register(
    "DatasetListEnvelope",
    datasetListEnvelopeSchema.openapi({
      description: "GET /datasets response envelope: a page of the public dataset catalog.",
    }),
  );

  const DatasetDetailEnvelope = registry.register(
    "DatasetDetailEnvelope",
    datasetDetailEnvelopeSchema.openapi({
      description: "GET /datasets/{id} response envelope: one dataset's full detail record.",
    }),
  );

  const DatasetSearchEnvelope = registry.register(
    "DatasetSearchEnvelope",
    datasetSearchEnvelopeSchema.openapi({
      description: "GET /datasets/search response envelope: hybrid search hits.",
    }),
  );

  const DatasetFacetsEnvelope = registry.register(
    "DatasetFacetsEnvelope",
    datasetFacetsEnvelopeSchema.openapi({
      description:
        "GET /datasets/facets response envelope: the declared facet vocabulary with counts.",
    }),
  );

  registry.registerPath({
    method: "get",
    path: "/datasets",
    summary: "List and filter the public dataset catalog",
    description:
      "Single-table read over the `datasets` catalog (public rows, plus the caller's own " +
      "when `mine=true`). Supports the shared facet table (shared/facets.ts) plus nine " +
      "legacy bespoke filters, all AND-ed together.",
    tags: ["Datasets"],
    request: { query: listQuerySchema },
    responses: {
      200: {
        description: "A page of the catalog.",
        content: { "application/json": { schema: DatasetListEnvelope } },
      },
      400: {
        description: "An invalid facet range, enum value, or filter token.",
        content: { "application/json": { schema: ErrorResponse } },
      },
      401: {
        description:
          "`mine=true` with no valid session: either no bearer token was sent, or one " +
          "was sent but rejected (invalid, expired, or revoked).",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/datasets/search",
    summary: "Hybrid dataset search (exact id, semantic, full text)",
    description:
      "Combines exact dataset-id lookup, Vectorize semantic similarity (when configured), " +
      "and D1 FTS5 text search. Shares the same filter table as GET /datasets, minus " +
      "`search` (the free text here is `q` instead).",
    tags: ["Datasets"],
    request: { query: searchQuerySchema },
    responses: {
      200: {
        description: "Search hits.",
        content: { "application/json": { schema: DatasetSearchEnvelope } },
      },
      400: {
        description: 'Missing the required "q" parameter, or an invalid facet/range/enum filter.',
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/datasets/facets",
    summary: "Facet vocabulary for the catalog (distinct values with counts)",
    description:
      "Lets a client validate/autocomplete a filter value (e.g. --task, --electrode-system) " +
      "against what the catalog actually contains. No query parameters; the response is " +
      "identical for every caller.",
    tags: ["Datasets"],
    responses: {
      200: {
        description: "The facet vocabulary.",
        content: { "application/json": { schema: DatasetFacetsEnvelope } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/datasets/{id}",
    summary: "Get one dataset's detail record",
    description:
      "Public datasets are visible to everyone; private datasets require the caller to be " +
      "the owner, a collaborator, or an admin -- otherwise this 404s rather than 403s, so a " +
      "private dataset's existence is not disclosed to an unauthorized caller.",
    tags: ["Datasets"],
    request: { params: datasetIdParam },
    responses: {
      200: {
        description: "The dataset's detail record.",
        content: { "application/json": { schema: DatasetDetailEnvelope } },
      },
      400: {
        description: "Invalid dataset id format.",
        content: { "application/json": { schema: ErrorResponse } },
      },
      401: {
        description:
          "The dataset is private and the caller sent a bearer token that was rejected " +
          "(invalid, expired, or revoked). A private dataset requested with no credentials " +
          "at all still 404s, per the description above.",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Not found, or private and the caller lacks access.",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "NEMAR API",
      version: OPENAPI_DOCUMENT_VERSION,
      description:
        "Public read surface of api.nemar.org's dataset catalog, generated from the shared " +
        "wire contract (shared/contract/) rather than hand-written (issue #937). Covers the " +
        "catalog list, detail, search, and facet-vocabulary endpoints only -- write routes, " +
        "auth, admin, and sandbox endpoints are not documented here.",
    },
    servers: [
      { url: "https://api.nemar.org", description: "Production" },
      { url: "https://api-test.nemar.org", description: "Staging" },
    ],
    tags: [{ name: "Datasets", description: "Public dataset catalog reads." }],
  });
  return fixNullableEnums(document);
}

if (import.meta.main) {
  const doc = buildOpenApiDocument();
  const outPath = fileURLToPath(new URL("../shared/openapi.json", import.meta.url));
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}
