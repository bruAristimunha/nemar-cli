/**
 * NEMAR wire contract — single source of truth for the response shapes the CLI,
 * website, data plane, and third parties exchange (epic #896, #898).
 *
 * Authored in Zod, zero deps beyond zod, no imports from src/ or backend/ — so
 * this whole directory lifts verbatim into a standalone @nemar/contract package
 * (follow-up: publish to npm + emit OpenAPI/JSON-Schema at api.nemar.org).
 *
 * The dataset shape conforms to neuroschema v0.4.1 (NEUROSCHEMA_VERSION),
 * enforced against the vendored JSON Schema in the contract tests.
 */

export * from "./version.js";
export * from "./user.js";
export * from "./dataset.js";
export * from "./publication.js";
export * from "./identity.js";
export * from "./device-auth.js";
// Zero-dep string tables, not zod shapes: the copy every surface prints for a
// tier, an upload-access state or a missing profile field, and the matrix that
// decides which fields are missing (#1268, ADR 0045).
export * from "./account-copy.js";
export * from "./profile-gaps.js";
// Zarr serving index v3 reader and the MCP server's wire contract (issue
// #1293, phase 1 of epic #1065; ADR 0049).
export * from "./zarr-index.js";
export * from "./mcp.js";
// Zero-dep literals and types for the private site's session handoff and the
// service-binding entrypoint its Worker calls (ADR 0078, ADR 0079).
export * from "./private-site.js";
// The compute gateway: the job specification, partition and rate tables, owner policy and the
// launcher's file shapes (epic #2005, ADR 0118). Its words live in `../compute-state.ts`.
export * from "./compute.js";
// The routes of the compute allocation ledger and owner policy: error words, request shapes and
// the OPEN response schemas the CLI parses (epic #2005 phase A2).
export * from "./compute-admin.js";
// The runner protocol `nemar.runner.v1` (portable compute): its words, prefixes, header, numbers and
// the request and response shapes a runner and the Worker exchange. Its JSON Schema is shared byte for
// byte with nemarOrg/nemar-process; the words shared with the job model are in `../compute-state.ts`.
export * from "./compute-runner.js";
