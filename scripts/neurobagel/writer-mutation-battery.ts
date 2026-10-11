/**
 * A hand-written mutation battery for the Neurobagel writer (epic #1586, phase 4; ADR 0084).
 *
 *   bun run scripts/neurobagel/writer-mutation-battery.ts             # every mutant
 *   bun run scripts/neurobagel/writer-mutation-battery.ts predicate   # one layer
 *   bun run scripts/neurobagel/writer-mutation-battery.ts --check-anchors
 *
 * Each mutant makes ONE plausible mistake in the eligibility predicate, the two anonymity
 * guards, removal, write order, the index, the read route's authentication and its re-check,
 * the hooks or the cron fence.
 * The tests that exist for the area are then run against it, and the mutant is KILLED only if a
 * TEST FAILS ON AN ASSERTION: the log is read for failing tests, and a run that exits non-zero
 * with none (a suite that did not load, a refused connection to a test server) is run once more
 * and then reported INCONCLUSIVE, never counted as a kill. It has SURVIVED if every test passes.
 * A mutant that survives its own layer's tests is run once more against every Neurobagel
 * writer test, so the report can say whether the guard exists somewhere else or not at all.
 * A survivor is either a test that is missing or a mutant that changes nothing observable;
 * `equivalent` below says which one the author believes, and why.
 *
 * The script edits a source file in place and restores it in `finally`.
 * Run it on a clean tree, alone: it is not part of the test suite.
 * A mutant whose anchor text is not found exactly as often as declared is an ERROR, never a
 * pass, so a refactor that moves the code cannot turn a mutant into a no-op unnoticed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

type Layer =
  | "predicate"
  | "guards"
  | "removal"
  | "order"
  | "index"
  | "auth"
  | "route"
  | "hooks"
  | "admin"
  | "budget"
  | "plan"
  | "fingerprint"
  | "limits";

export interface Mutant {
  id: string;
  layer: Layer;
  file: string;
  find: string;
  count?: number;
  replace: string;
  note: string;
  /** The test files that should kill it (default: the whole writer suite). */
  tests?: string[];
  /** Set when the mutant changes nothing observable; the reason. */
  equivalent?: string;
}

const SVC = "backend/src/services";
const ROUTES = "backend/src/routes";
const T = "backend/test";

const ALL_TESTS = [
  `${T}/neurobagel-eligibility.test.ts`,
  `${T}/neurobagel-writer.test.ts`,
  `${T}/neurobagel-curation.test.ts`,
  `${T}/neurobagel-fingerprint.test.ts`,
  `${T}/neurobagel-read-route.test.ts`,
  `${T}/neurobagel-admin-routes.test.ts`,
  `${T}/neurobagel-hooks.test.ts`,
  `${T}/neurobagel-source-scan.test.ts`,
  `${T}/neurobagel-host-routing.test.ts`,
  `${T}/neurobagel-route-inventory.test.ts`,
  `${T}/rate-limit-buckets.test.ts`,
  `${T}/cron-sweep-wiring.test.ts`,
  "test/admin-neurobagel-cli.test.ts",
];

const ELIGIBILITY = `${SVC}/neurobagel-eligibility.ts`;
const WRITER = `${SVC}/neurobagel-writer.ts`;
const HOOKS = `${SVC}/neurobagel-hooks.ts`;
const GATHER = `${SVC}/neurobagel-gather.ts`;
const STORE = `${SVC}/neurobagel-store.ts`;
const PLAN = `${SVC}/neurobagel-plan.ts`;
const FINGERPRINT = `${SVC}/neurobagel-fingerprint.ts`;
const ROUTE = `${ROUTES}/neurobagel.ts`;
const ADMIN = `${ROUTES}/admin/neurobagel.ts`;

export const MUTANTS: Mutant[] = [
  // The predicate: each term in SQL and in TypeScript.
  {
    id: "P01-active-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.status = 'active'",`,
    replace: `sql: "1 = 1",`,
    note: "an archived or deleted row is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P02-active-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `holds: (row) => row.status === "active",`,
    replace: "holds: () => true,",
    note: "the re-check lets an archived row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P03-public-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.visibility = 'public'",`,
    replace: `sql: "d.visibility IS NOT NULL",`,
    note: "a private dataset is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P04-public-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `holds: (row) => row.visibility === "public",`,
    replace: "holds: () => true,",
    note: "the re-check lets a private row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P05-anonymous-sql-null-is-false",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.anonymous = 0",`,
    replace: `sql: "COALESCE(d.anonymous, 0) = 0",`,
    note: "an unknown anonymous value reads as not anonymous",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
    equivalent:
      "datasets.anonymous is NOT NULL, so no row can carry an unknown value and both forms select the same rows; the TypeScript form (P07) is the one that can see it",
  },
  {
    id: "P06-anonymous-sql-dropped",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.anonymous = 0",`,
    replace: `sql: "1 = 1",`,
    note: "the anonymous term is gone (the schema triggers are then the only guard)",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P07-anonymous-ts-null-is-false",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "holds: (row) => row.anonymous === 0,",
    replace: "holds: (row) => row.anonymous !== 1,",
    note: "the re-check reads an unknown anonymous value as not anonymous",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P08-first-published-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.first_published_at IS NOT NULL",`,
    replace: `sql: "1 = 1",`,
    note: "an unpublished dataset is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P09-first-published-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "holds: (row) => row.first_published_at !== null && row.first_published_at !== undefined,",
    replace: "holds: () => true,",
    note: "the re-check lets an unpublished row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P10-withdrawn-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.withdrawn_at IS NULL",`,
    replace: `sql: "1 = 1",`,
    note: "a withdrawn dataset is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P11-withdrawn-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "holds: (row) => row.withdrawn_at === null || row.withdrawn_at === undefined,",
    replace: "holds: () => true,",
    note: "the re-check lets a withdrawn row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P12-version-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `    sql: "EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id)",`,
    replace: `    sql: "1 = 1",`,
    note: "a dataset with no published version is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P13-version-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "holds: (row) => row.has_version === 1,",
    replace: "holds: () => true,",
    note: "the re-check lets a versionless row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P14-ceiling-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "AND d.dataset_id < '${NEUROBAGEL_REAL_NM_CEILING}')",
    replace: "AND d.dataset_id <= '${NEUROBAGEL_REAL_NM_CEILING}')",
    note: "nm099900, the first reserved fixture id, is federated",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P15-ceiling-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "NM_ID.test(row.dataset_id) && row.dataset_id < NEUROBAGEL_REAL_NM_CEILING",
    replace: "NM_ID.test(row.dataset_id)",
    note: "every nm id, the fixtures included, passes the re-check",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P16-on-mirrors-excluded-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "          OR d.dataset_id GLOB '${ON_GLOB}')",
    replace: "          )",
    note: "OpenNeuro mirrors are dropped (the owner decided to include them)",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P17-on-mirrors-excluded-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "        ON_ID.test(row.dataset_id)) &&",
    replace: "        false) &&",
    note: "the re-check drops OpenNeuro mirrors",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P18-xx-ids-admitted-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "          OR d.dataset_id GLOB '${ON_GLOB}')",
    replace: "          OR d.dataset_id GLOB '${ON_GLOB}' OR d.dataset_id GLOB 'xx*')",
    note: "an `xx` id (a sandbox, an exemplar) is selected: the store cannot hold it",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P19-xx-ids-admitted-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "        ON_ID.test(row.dataset_id)) &&",
    replace: "        ON_ID.test(row.dataset_id) || row.dataset_id.startsWith('xx')) &&",
    note: "the re-check admits an `xx` id",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P20-exemplar-fleet-admitted-staging",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "  return ON_ID.test(datasetId);",
    replace: "  return ON_ID.test(datasetId) || /^xx0999\\d{2}$/.test(datasetId);",
    note: "a hook schedules a write for an exemplar id",
    tests: [`${T}/neurobagel-eligibility.test.ts`, `${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "P22-tombstone-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "COALESCE(d.ezid_status, '') <> 'unavailable'",`,
    replace: `sql: "1 = 1",`,
    note: "a dataset whose DOI was tombstoned on its own stays federated",
    tests: [`${T}/neurobagel-eligibility.test.ts`, `${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "P23-tombstone-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `holds: (row) => row.ezid_status !== "unavailable",`,
    replace: "holds: () => true,",
    note: "the re-check lets a tombstoned dataset through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P21-sandbox-flag-dropped-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "        AND COALESCE(d.is_sandbox, 0) = 0 AND COALESCE(d.is_exemplar, 0) = 0\n",
    replace: "",
    note: "a sandbox or exemplar flag on a real id no longer excludes it",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },

  // The two anonymity guards.
  {
    id: "G01-metadata-guard-unknown-is-false",
    layer: "guards",
    file: GATHER,
    find: "return value === false;",
    replace: "return value !== true;",
    note: "a metadata document with no anonymous value (or null, or the string false) is trusted",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G02-metadata-guard-removed",
    layer: "guards",
    file: GATHER,
    find: "if (!saysNotAnonymous(doc.anonymous)) {",
    replace: "if (false) {",
    note: "the second guard is gone: the row is the only line",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G03-degraded-metadata-accepted",
    layer: "guards",
    file: GATHER,
    find: "doc.extensions?.nemar?.bids_index === null ||",
    replace: "false ||",
    note: "a metadata document built while the manifest was unreadable replaces a good artifact",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G04-recheck-before-write",
    layer: "guards",
    file: WRITER,
    find: `if (!fresh.eligible) return { id, outcome: "refused", code: "no_longer_eligible" };`,
    replace: "",
    note: "a dataset that stopped being eligible between the plan and the write is written",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G05-transform-backstop-not-anonymity",
    layer: "guards",
    file: WRITER,
    find: `if (err.code === "anonymous_not_false") return refuse(rc, id, "anonymity_disagreement");`,
    replace: "",
    note: "the transform's own refusal is filed as an ordinary refusal",
    equivalent:
      "unreachable: the gather guard refuses first, so the transform never sees a non-false value; the line is a backstop behind a backstop",
  },
  {
    id: "G06-curation-failure-falls-through",
    layer: "guards",
    file: WRITER,
    find: `  if (curation.kind === "failed") {\n    return refuse(rc, id, "curation_unavailable", clip(curation.reason));\n  }`,
    replace: "",
    note: "a failed curation lookup converts the dataset with no entry",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G07-curation-hash-not-in-fingerprint",
    layer: "guards",
    file: WRITER,
    find: `const curationHash = curation.kind === "entry" ? curation.hash : null;`,
    replace: "const curationHash = null;",
    note: "a changed curation entry does not change the fingerprint",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G08-stale-manifest-copy-kept",
    layer: "guards",
    file: WRITER,
    find: `if (copyEtag === currentEtag) return "current";`,
    replace: `return "current";`,
    note: "artifacts are built from a manifest copy older than the ETag they are stamped with",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G09-manifest-etag-not-in-fingerprint",
    layer: "guards",
    file: WRITER,
    find: "fingerprint: await inputFingerprint(rowFp, head.etag),",
    replace: `fingerprint: await inputFingerprint(rowFp, ""),`,
    note: "a manifest rewrite in place is invisible to the fingerprint",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G10-any-404-is-an-absent-file",
    layer: "guards",
    file: GATHER,
    find: `return body.error === "File not found";`,
    replace: "return true;",
    note: "a manifest the data plane could not read is passed to the transform as an absent table",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },

  // Removal.
  {
    id: "R01-delete-without-index",
    layer: "removal",
    file: WRITER,
    find: "if (index.written || !index.changed) {",
    replace: "if (true) {",
    note: "artifacts are deleted even when the index could not be updated first",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R02-removal-ignores-scope",
    layer: "removal",
    file: WRITER,
    find: ".filter((id) => !indexable.has(id) && (only === undefined || only.includes(id)))",
    replace: ".filter((id) => !indexable.has(id) && true)",
    note: "a run for one dataset deletes the others' objects",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R03-ineligible-not-removed",
    layer: "removal",
    file: WRITER,
    find: "const eligibleNow = await eligibleAmong(env.DB, [...fresh.datasets.keys()]);",
    replace: "const eligibleNow = new Set(fresh.datasets.keys());",
    note: "a dataset that stopped being eligible keeps its artifacts and its place in the index",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R04-anonymity-refusal-not-removed",
    layer: "removal",
    file: WRITER,
    find: "(id) => !rc.anonymityRefused.has(id) && !droppedWhileExamining.has(id),",
    replace: "(id) => !droppedWhileExamining.has(id),",
    note: "a dataset whose data said anonymous keeps what the store held",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R05-index-not-filtered-by-eligibility",
    layer: "removal",
    file: STORE,
    find: "    if (!eligibleIds.has(id)) continue;\n",
    replace: "",
    note: "the index lists a dataset that left",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R06-ledger-written-every-run",
    layer: "removal",
    file: PLAN,
    find: "if (sameLabel(previous?.label, label) && !spent) return false;",
    replace: "",
    note: "a standing finding is recorded on every run",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },

  // Order and idempotency.
  {
    id: "O01-jsonld-not-last",
    layer: "order",
    file: WRITER,
    find: `    { kind: "dictionary", text: files[names.dictionary] as string },\n    { kind: "description", text: files[names.datasetDescription] as string },\n    { kind: "jsonld", text: files[names.jsonld] as string },`,
    replace: `    { kind: "jsonld", text: files[names.jsonld] as string },\n    { kind: "dictionary", text: files[names.dictionary] as string },\n    { kind: "description", text: files[names.datasetDescription] as string },`,
    note: "the commit marker is written first, so an interrupted run leaves a stamped set that is not whole",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O02-companions-always-rewritten",
    layer: "order",
    file: WRITER,
    find: `if (kind !== "jsonld" && existing?.sha256 === sha) continue;`,
    replace: "",
    note: "identical companion bytes are written again",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O03-fingerprint-never-matches",
    layer: "order",
    file: WRITER,
    find: "storedFp === prepared.fingerprint",
    replace: "false",
    note: "a second run rewrites everything",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O04-incomplete-set-counts-as-complete",
    layer: "order",
    file: PLAN,
    find: " && stored.dictionary && stored.description",
    replace: "",
    note: "a set missing its companions is not rewritten",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O05-rotation-never-moves",
    layer: "order",
    file: PLAN,
    find: "const start = (day * Math.max(1, limit)) % rest.length;",
    replace: "const start = 0;",
    note: "the same datasets are examined every day and the rest never are",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O06-limit-ignored",
    layer: "order",
    file: PLAN,
    find: "const taken = work.slice(0, Math.max(0, limit));",
    replace: "const taken = work;",
    note: "a tick examines every dataset it finds",
    tests: [`${T}/neurobagel-writer.test.ts`, `${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "O07-stale-before-missing",
    layer: "order",
    file: PLAN,
    find: `      ...missing.map((id) => ({ id, class: "missing" as const })),\n      ...stale.map((id) => ({ id, class: "stale" as const })),`,
    replace: `      ...stale.map((id) => ({ id, class: "stale" as const })),\n      ...missing.map((id) => ({ id, class: "missing" as const })),`,
    note: "datasets with nothing in the store wait behind ones that merely changed",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },

  // The index.
  {
    id: "I01-index-write-unconditional",
    layer: "index",
    file: WRITER,
    find: "...(previous.etag ? { onlyIf: { etagMatches: previous.etag } } : {}),",
    replace: "",
    note: "a run that read a stale index overwrites a newer one",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I02-index-always-changed",
    layer: "index",
    file: STORE,
    find: "const unchanged = matchesPrevious ||",
    replace: "const unchanged = false &&",
    note: "an unchanged index is written on every run",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I03-empty-first-index-written",
    layer: "index",
    file: STORE,
    find: "(previous === null && entries.length === 0)",
    replace: "false",
    note: "a store with nothing eligible gets an empty index nobody reads",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I04-unstamped-set-indexed",
    layer: "index",
    file: STORE,
    find: "if (!jsonld || !jsonld.meta[META.fingerprint]) return null;",
    replace: "if (!jsonld) return null;",
    note: "a JSON-LD the writer did not stamp as complete is indexed",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },

  // Authentication and the read route.
  {
    id: "A01-token-not-checked",
    layer: "auth",
    file: ROUTE,
    find: "if (!match || !timingSafeEqual(match[1] as string, token)) return unauthorized();",
    replace: "",
    note: "the route answers anyone",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A02-token-compared-with-equals",
    layer: "auth",
    file: ROUTE,
    find: "!timingSafeEqual(match[1] as string, token)",
    replace: "match[1] !== token",
    note: "the token is compared with !==, which is not constant time",
    tests: [`${T}/neurobagel-source-scan.test.ts`],
  },
  {
    id: "A03-unconfigured-route-answers",
    layer: "auth",
    file: ROUTE,
    find: "if (!token || !c.env.NEUROBAGEL) return notFound();",
    replace: "if (!c.env.NEUROBAGEL) return notFound();",
    note: "with no token configured the route challenges instead of not existing",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A04-artifact-recheck-removed",
    layer: "route",
    file: ROUTE,
    find: "if (!eligible) return notFound();",
    replace: "",
    note: "an artifact of a dataset that went private is still served",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A05-index-not-filtered",
    layer: "route",
    file: ROUTE,
    find: "document.datasets.filter((d) => eligible.has(d.id))",
    replace: "document.datasets",
    note: "the served index still names a dataset that went private",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A06-unstamped-object-served",
    layer: "route",
    file: ROUTE,
    find: "if (!object || object.customMetadata?.[META.kind] !== parsed.kind) return notFound();",
    replace: "if (!object) return notFound();",
    note: "an object that only has an artifact-shaped name is served",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A07-cacheable",
    layer: "route",
    file: ROUTE,
    find: `"Cache-Control": "no-store",`,
    replace: `"Cache-Control": "public, max-age=3600",`,
    note: "an answer that depends on a check made now is cacheable for an hour",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A08-name-pattern-unanchored",
    layer: "route",
    file: STORE,
    find: "`^(${DATASET_ID})(\\\\.jsonld|_annotated\\\\.json|_dataset_description\\\\.json)$`,",
    replace: "`(${DATASET_ID})(\\\\.jsonld|_annotated\\\\.json|_dataset_description\\\\.json)$`,",
    note: "any name that ENDS like an artifact name is parsed as one",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A09-own-rate-bucket-removed",
    layer: "route",
    file: "backend/src/middleware/rateLimit.ts",
    find: "if (NEUROBAGEL_PATH_RE.test(path)) {",
    replace: "if (false) {",
    note: "rotating made-up bearers mint a bucket each, and reach the token lookup",
    tests: [`${T}/rate-limit-buckets.test.ts`],
  },

  // Hooks and cron.
  {
    id: "H01-hook-ignores-the-switch",
    layer: "hooks",
    file: HOOKS,
    find: `    if (mode === "disabled") return;`,
    replace: "",
    note: "the hooks run with the writer off",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H02-switch-is-truthy",
    layer: "hooks",
    file: WRITER,
    find: `if (env.NEUROBAGEL_WRITER_ENABLED !== "1") return "disabled";`,
    replace: `if (!env.NEUROBAGEL_WRITER_ENABLED) return "disabled";`,
    note: "any non-empty value, such as 0 or false, turns the writer on",
    tests: [`${T}/neurobagel-writer.test.ts`, `${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H03-cron-runs-outside-production",
    layer: "hooks",
    file: HOOKS,
    find: '  if (isNonProductionEnv(env)) {\n    console.log("[neurobagel] reconcile skipped (non-production)");',
    replace: '  if (false) {\n    console.log("[neurobagel] reconcile skipped (non-production)");',
    note: "the dev worker's reconcile runs",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H04-hook-awaits-nothing-but-throws",
    layer: "hooks",
    file: HOOKS,
    find: "    if (waitUntil) waitUntil(work);\n  } catch (err) {",
    replace: `    if (waitUntil) waitUntil(work);\n    throw new Error("scheduling failed");\n  } catch (err) {\n    throw err;`,
    note: "a failure while scheduling reaches the flow",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H05-import-hook-on-every-status",
    layer: "hooks",
    file: `${ROUTES}/callbacks/import-state.ts`,
    find: `    if (status === "complete") {\n      scheduleNeurobagelSync(`,
    replace: "    if (true) {\n      scheduleNeurobagelSync(",
    note: "an import still in flight is federated",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H06-version-hook-not-after-refresh",
    layer: "hooks",
    file: `${ROUTES}/callbacks/manifest.ts`,
    find: "        { after: refreshed },",
    replace: "",
    note: "the writer reads D1 before the metadata refresh has written it",
    tests: [`${T}/neurobagel-source-scan.test.ts`],
  },
  {
    id: "H07-hook-awaited-in-callback",
    layer: "hooks",
    file: `${ROUTES}/callbacks/manifest.ts`,
    find: "      scheduleNeurobagelSync(\n        c.env,",
    replace: "      await scheduleNeurobagelSync(\n        c.env,",
    note: "the callback waits for the hook",
    tests: [`${T}/neurobagel-source-scan.test.ts`],
  },

  // The admin route.
  {
    id: "D01-execute-by-default",
    layer: "admin",
    file: ADMIN,
    find: "const execute = body.execute === true;",
    replace: "const execute = body.execute !== false;",
    note: "an empty body writes",
    tests: [`${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "D02-disabled-gate-removed",
    layer: "admin",
    file: ADMIN,
    find: `if (execute && neurobagelWriterMode(c.env) !== "enabled") {`,
    replace: "if (false) {",
    note: "execute with the writer disabled answers 200 instead of 409",
    tests: [`${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "D03-loose-body",
    layer: "admin",
    file: ADMIN,
    find: "  .strict();",
    replace: "  .passthrough();",
    note: "a misspelled key is a silent dry run",
    tests: [`${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "D04-cli-always-executes",
    layer: "admin",
    file: "src/commands/admin.ts",
    find: "...(execute ? { execute: true } : {}),",
    replace: "execute: true,",
    note: "the CLI writes without --execute",
    tests: ["test/admin-neurobagel-cli.test.ts"],
  },

  // The review round (PR #1605): the index per dataset, the budget, parking, the signature,
  // the fingerprint's inputs, the size guards, the hooks' sites.
  {
    id: "I05-index-patch-skipped",
    layer: "index",
    file: WRITER,
    find: "    patch = await patchIndexEntry(rc, written);",
    replace: '    patch = "unchanged";',
    note: "artifacts are written and the index is left for the end of the run: a run cut off leaves them newer than it",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I06-index-patch-unconditional",
    layer: "index",
    file: WRITER,
    find: "      onlyIf: { etagMatches: previous.etag },\n",
    replace: "",
    note: "a per-dataset patch overwrites an index another run replaced",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I07-patch-failure-ignored",
    layer: "index",
    file: WRITER,
    find: 'if (patch === "failed") rc.indexPatchFailed = true;',
    replace: "",
    note: "a run whose index cannot be patched keeps writing artifacts",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I08-index-read-after-listing",
    layer: "index",
    file: WRITER,
    find: "    const previous = await readStoredIndex(bucket);\n    if (attempt > 1 || options.execute) listing = await listStore(bucket);",
    replace:
      "    if (attempt > 1 || options.execute) listing = await listStore(bucket);\n    const previous = await readStoredIndex(bucket);",
    note: "the previous index is read after the listing: the conditional write no longer protects an interleaved run",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I09-eligibility-from-the-start-of-the-run",
    layer: "index",
    file: WRITER,
    find: "const eligibleNow = await eligibleAmong(env.DB, [...fresh.datasets.keys()]);",
    replace: "const eligibleNow = eligibleIds;",
    note: "a dataset another run published while this one worked is dropped from the index and its artifacts deleted",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B01-budget-never-stops-the-loop",
    layer: "budget",
    file: WRITER,
    find: "ops.total + DATASET_OPS_WORST + reserve > budget",
    replace: "false",
    note: "a run spends past its budget",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B02-no-reserve-for-the-closing-steps",
    layer: "budget",
    file: WRITER,
    find: "const reserve = closingReserve(listing.objects, leavingEstimate);",
    replace: "const reserve = 0;",
    note: "the loop spends what the index sync and the removals need",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B03-first-dataset-not-exempt",
    layer: "budget",
    file: WRITER,
    find: "result.examined > 0 && ops.total",
    replace: "ops.total",
    note: "a tiny budget examines nothing, and never makes progress",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B04-hard-limit-not-enforced",
    layer: "budget",
    file: WRITER,
    find: "  const limit = Math.min(\n    RECONCILE_HARD_LIMIT,\n    Math.max(1, options.limit ?? reconcileLimit(callerEnv)),\n  );",
    replace: "  const limit = Math.max(1, options.limit ?? reconcileLimit(callerEnv));",
    note: "a caller can ask a run to examine more than the hard limit",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B05-removal-limit-ignored",
    layer: "budget",
    file: WRITER,
    find: "leaving.slice(0, Math.min(REMOVAL_LIMIT, room))",
    replace: "leaving.slice(0, room)",
    note: "one run deletes every leaving dataset's artifacts, however many",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B06-removals-ignore-the-budget",
    layer: "budget",
    file: WRITER,
    find: "const room = Math.max(0, budget - ops.total - 4);",
    replace: "const room = Number.POSITIVE_INFINITY;",
    note: "removals spend past the budget",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B07-schema-limit-unbounded",
    layer: "admin",
    file: ADMIN,
    find: ".max(RECONCILE_HARD_LIMIT).optional(),\n    force",
    replace: ".optional(),\n    force",
    note: "the route accepts a limit above the ceiling and the writer shortens it silently",
    tests: [`${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "B08-cli-ceiling-not-checked",
    layer: "admin",
    file: "src/commands/admin.ts",
    find: "if (limit !== undefined && limit > NEUROBAGEL_REGENERATE_MAX) {",
    replace: "if (false) {",
    note: "the CLI sends an over-ceiling limit and leaves the refusal to the server",
    tests: ["test/admin-neurobagel-cli.test.ts"],
  },
  {
    id: "B09-client-limit-check-removed",
    layer: "admin",
    file: "src/commands/admin.ts",
    find: "if (limit !== undefined && !Number.isInteger(limit)) {",
    replace: "if (false) {",
    note: "the CLI sends a malformed limit and leaves the refusal to the server",
    tests: ["test/admin-neurobagel-cli.test.ts"],
  },
  // The second review round: blips, attempts, margins, the HTTP count, the reserve, status.
  {
    id: "T01-blips-are-recorded-and-parked",
    layer: "plan",
    file: WRITER,
    find: 'new Set(["fetch_failed", "metadata_degraded"])',
    replace: "new Set([])",
    note: "a failed read is recorded as a standing finding and parks the dataset",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "T02-degraded-metadata-is-a-finding",
    layer: "plan",
    file: WRITER,
    find: 'new Set(["fetch_failed", "metadata_degraded"])',
    replace: 'new Set(["fetch_failed"])',
    note: "a manifest that broke mid-read parks the dataset until the window comes round",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "K04-stale-datasets-never-parked",
    layer: "plan",
    file: PLAN,
    find: "if ((incomplete || isStale) && standing?.has(id)) {",
    replace: "if (incomplete && standing?.has(id)) {",
    note: "a stale dataset with a standing refusal takes a slot of every tick",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "K05-parking-never-expires",
    layer: "plan",
    file: PLAN,
    find: "if (ageMs(entry.at, now) >= windowMs) continue;",
    replace: "",
    note: "a refusal hides a dataset for ever",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "K06-refusal-not-re-recorded",
    layer: "plan",
    file: PLAN,
    find: "if (sameLabel(previous?.label, label) && !spent) return false;",
    replace: "if (sameLabel(previous?.label, label)) return false;",
    note: "a standing refusal is never re-confirmed, so it is examined on every tick once its window is spent",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "K07-unexamined-counts-the-rotation",
    layer: "plan",
    file: PLAN,
    find: "unexamined: neededWork(work) - neededWork(taken),",
    replace: "unexamined: work.length - taken.length,",
    note: "a finished backfill reads as hundreds of datasets still waiting",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I10-patch-one-attempt",
    layer: "index",
    file: WRITER,
    find: "attempt <= INDEX_ATTEMPTS; attempt++) {\n    const previous = await readStoredIndex(rc.bucket);",
    replace: "attempt <= 1; attempt++) {\n    const previous = await readStoredIndex(rc.bucket);",
    note: "one lost race stops the run: the patch is tried once, not three times",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I11-sync-one-attempt",
    layer: "index",
    file: WRITER,
    find: "attempt <= INDEX_ATTEMPTS; attempt++) {\n    const previous = await readStoredIndex(bucket);",
    replace: "attempt <= 1; attempt++) {\n    const previous = await readStoredIndex(bucket);",
    note: "one lost race holds the removals back: the closing sync is tried once, not three times",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I12-throwing-patch-not-contained",
    layer: "index",
    file: WRITER,
    find: '  } catch (err) {\n    patch = "failed";',
    replace: '  } catch (err) {\n    throw err;\n    patch = "failed";',
    note: "a patch that throws is an error of the dataset, and the loop goes on writing",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B10-worst-case-margin-dropped",
    layer: "budget",
    file: WRITER,
    find: "ops.total + DATASET_OPS_WORST + reserve > budget",
    replace: "ops.total + reserve > budget",
    note: "the loop begins a dataset that may not fit before the reserve",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B11-per-leaving-reserve-dropped",
    layer: "budget",
    file: WRITER,
    find: "return CLOSING_FIXED_OPS + 2 * listingPages(objects) + Math.min(leaving, REMOVAL_LIMIT);",
    replace: "return CLOSING_FIXED_OPS + 2 * listingPages(objects);",
    note: "a run with many removals to make has nothing left to delete with",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B12-reserve-not-scaled-with-the-store",
    layer: "budget",
    file: WRITER,
    find: "return CLOSING_FIXED_OPS + 2 * listingPages(objects) + Math.min(leaving, REMOVAL_LIMIT);",
    replace: "return CLOSING_FIXED_OPS + 2 + Math.min(leaving, REMOVAL_LIMIT);",
    note: "the reserve is right for a small store and short for the real one",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B13-gather-http-allowance-zero",
    layer: "budget",
    file: WRITER,
    find: "export const GATHER_HTTP_OPS =\n  GATHER_HTTP_BASE_OPS + GATHER_ANNEX_PROBE_OPS + MAX_GATHER_CHUNK_GETS + GATHER_HTTP_MARGIN;",
    replace: "export const GATHER_HTTP_OPS = 0;",
    note: "the data plane's HTTP requests are not charged",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "B14-manifest-head-uncounted",
    layer: "budget",
    file: WRITER,
    find: '    ops.add("http");\n    head = await headManifestObject(s3Options(env), id, latestVersion);',
    replace: "    head = await headManifestObject(s3Options(env), id, latestVersion);",
    note: "the writer's own manifest HEAD is not counted",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "Z05-listing-cap-off-by-one",
    layer: "limits",
    file: STORE,
    find: "for (let page = 0; page < maxPages; page++) {",
    replace: "for (let page = 0; page < maxPages - 1; page++) {",
    note: "a listing that needs exactly the cap fails",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "Z06-listing-truncated-silently",
    layer: "limits",
    file: STORE,
    find: "  throw new Error(\n    `the Neurobagel store listing did not finish",
    replace:
      "  return { datasets, unexpected, index, objects };\n  throw new Error(\n    `the Neurobagel store listing did not finish",
    note: "a listing past the cap is returned as if it were the whole store",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "S02-refusal-age-omitted",
    layer: "admin",
    file: `${SVC}/neurobagel-status.ts`,
    find: "since: ledgerTime(entry.at)?.toISOString() ?? entry.at,",
    replace: "",
    note: "a standing refusal shows no age in status",
    tests: [`${T}/neurobagel-writer.test.ts`, `${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "Z07-fingerprint-pin-not-for-this-revision",
    layer: "fingerprint",
    file: FINGERPRINT,
    find: "export const FINGERPRINT_INPUTS = {\n  revision: 1,",
    replace: "export const FINGERPRINT_INPUTS = {\n  revision: 2,",
    note: "the pin and the revision disagree",
    tests: [`${T}/neurobagel-fingerprint.test.ts`],
  },
  {
    id: "L02-latest-version-compared-untagged",
    layer: "guards",
    file: WRITER,
    find: "if (toVersionTag(gathered.latestVersion) !== prepared.latestVersion) {",
    replace: "if (gathered.latestVersion !== prepared.latestVersion) {",
    note: "the data plane's latest version is compared without normalizing it",
    tests: [`${T}/neurobagel-writer.test.ts`],
    equivalent:
      "the data plane emits latest_snapshot already tagged (toVersionTag(row.version) in data-router.ts), and toVersionTag is the identity on a tagged version, so normalizing it again changes nothing; it is kept so a data plane that ever emitted a bare version would not refuse every dataset",
  },

  {
    id: "K01-standing-refusals-never-parked",
    layer: "plan",
    file: PLAN,
    find: "parked.add(id);\n  }\n  return parked;",
    replace: "}\n  return parked;",
    note: "a dataset refused for ever takes a slot of every tick",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "K02-parked-datasets-forgotten",
    layer: "plan",
    file: PLAN,
    find: "      rest.push(id);\n      parkedCount++;",
    replace: "      parkedCount++;",
    note: "a parked dataset never joins the rotation, so it is never examined again",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "K03-refusal-signature-ignored",
    layer: "plan",
    file: PLAN,
    find: "? a.code === b.code && a.sig === b.sig",
    replace: "? a.code === b.code",
    note: "a refusal after the row changed is not recorded, so the parking decision reads the old signature",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "S01-signature-from-the-plan-row",
    layer: "plan",
    file: WRITER,
    find: "{ dataset_id: id, ...prepared.detail },\n    prepared.curationHash,",
    replace: "row,\n    prepared.curationHash,",
    note: "a row edited between plan and processing is stamped with a state it was not built from, and is stale for ever",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "L01-latest-version-agreement-unchecked",
    layer: "guards",
    file: WRITER,
    find: "if (toVersionTag(gathered.latestVersion) !== prepared.latestVersion) {",
    replace: "if (false) {",
    note: "one version's manifest ETag is stamped on another version's content",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "F01-enrichment-length-not-in-the-signature",
    layer: "fingerprint",
    file: FINGERPRINT,
    find: "return { fields: row, enrichment_length: enrichmentLength, curation: curationHash, identity };",
    replace: "return { fields: row, curation: curationHash, identity };",
    note: "a changed enrichment document does not make the dataset stale",
    tests: [`${T}/neurobagel-fingerprint.test.ts`],
  },
  {
    id: "F02-enrichment-hash-not-in-the-row-fingerprint",
    layer: "fingerprint",
    file: FINGERPRINT,
    find: "return { fields: row, enrichment_sha256: enrichmentSha256, curation: curationHash, identity };",
    replace: "return { fields: row, curation: curationHash, identity };",
    note: "an enrichment edit of the same length is never rewritten",
    tests: [`${T}/neurobagel-fingerprint.test.ts`],
  },
  {
    id: "F03-vocabulary-pin-not-in-the-identity",
    layer: "fingerprint",
    file: FINGERPRINT,
    find: "    vocab_communities: VOCAB.pins.communities.commit,\n",
    replace: '    vocab_communities: "",\n',
    note: "a vocabulary re-pin does not mark any dataset stale",
    tests: [`${T}/neurobagel-fingerprint.test.ts`],
  },
  {
    id: "F04-writer-revision-not-in-the-identity",
    layer: "fingerprint",
    file: FINGERPRINT,
    find: "    writer: NEUROBAGEL_WRITER_REVISION,\n",
    replace: "    writer: 0,\n",
    note: "bumping the writer revision rewrites nothing",
    tests: [`${T}/neurobagel-fingerprint.test.ts`],
  },
  {
    id: "F05-license-not-in-the-fingerprint",
    layer: "fingerprint",
    file: WRITER,
    find: "      license: detail.license,\n",
    replace: "      license: null,\n",
    note: "a license change is not rewritten",
    tests: [`${T}/neurobagel-fingerprint.test.ts`],
  },
  {
    id: "F06-subject-count-not-in-the-fingerprint",
    layer: "fingerprint",
    file: WRITER,
    find: "      subject_count: detail.subject_count,\n",
    replace: "      subject_count: null,\n",
    note: "a subject count change is not rewritten",
    tests: [`${T}/neurobagel-fingerprint.test.ts`],
  },
  {
    id: "F07-concept-doi-not-in-the-fingerprint",
    layer: "fingerprint",
    file: WRITER,
    find: "      concept_doi: detail.concept_doi,\n",
    replace: "      concept_doi: null,\n",
    note: "a concept DOI change is not rewritten",
    tests: [`${T}/neurobagel-fingerprint.test.ts`],
  },
  {
    id: "Z01-size-cap-off-by-one",
    layer: "limits",
    file: WRITER,
    find: "if (size > (options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES)) {",
    replace: "if (size >= (options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES)) {",
    note: "an artifact exactly at the cap is refused",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "Z02-size-cap-removed",
    layer: "limits",
    file: WRITER,
    find: "if (size > (options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES)) {",
    replace: "if (false) {",
    note: "an oversize artifact is written and the loader refuses the whole release",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "Z03-metadata-never-trimmed",
    layer: "limits",
    file: WRITER,
    find: "while (flags.length > 0 && size(trimmed) > R2_METADATA_BUDGET) {",
    replace: "while (false) {",
    note: "custom metadata over R2's limit is written as it is",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "Z04-dry-run-writes-the-ledger",
    layer: "limits",
    file: WRITER,
    find: "  if (!rc.options.execute) return;\n  try {\n    await recordLedgerState(",
    replace: "  try {\n    await recordLedgerState(",
    note: "a dry run records findings",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "H08-publication-hook-wrong-dataset",
    layer: "hooks",
    file: `${SVC}/publication-orchestrator.ts`,
    find: 'scheduleNeurobagelSync(env, waitUntil, datasetId, "hook:publication");\n\n  // Audit log (non-fatal but warn user if fails)',
    replace:
      'scheduleNeurobagelSync(env, waitUntil, "nm000992", "hook:publication");\n\n  // Audit log (non-fatal but warn user if fails)',
    note: "the approval's own finalize federates the wrong dataset",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H09-legacy-version-hook-wrong-dataset",
    layer: "hooks",
    file: `${ROUTES}/callbacks/version-doi.ts`,
    find: '        dataset.dataset_id,\n        "hook:version",',
    replace: '        "nm000997",\n        "hook:version",',
    note: "the legacy version path federates the wrong dataset",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
];

export function mutate(source: string, m: Mutant): string {
  const expected = m.count ?? 1;
  const found = source.split(m.find).length - 1;
  if (found !== expected) {
    throw new Error(
      `${m.id}: anchor appears ${found} time(s) in ${m.file}, expected ${expected}; the mutant no longer applies`,
    );
  }
  const at = source.indexOf(m.find);
  return source.slice(0, at) + m.replace + source.slice(at + m.find.length);
}

/** One failing test, and whether the TEST INFRASTRUCTURE failed it rather than an assertion. */
interface Failure {
  name: string;
  infra: boolean;
}

interface TestRun {
  /** The process exited 0. */
  passed: boolean;
  failures: Failure[];
  /** Failing tests the code under test answers for: not a refused connection, not a missing suite. */
  asserted: Failure[];
}

/** What a failure caused by the harness (a stand-in or Miniflare's proxy not answering) reads like. */
const INFRASTRUCTURE =
  /ConnectionRefused|ECONNREFUSED|ECONNRESET|Unable to connect|platform[- ]proxy|socket hang up|fetch failed/i;

/**
 * Read a `bun test` log: the failing tests, each with the error text printed before it.
 * Exit status alone is not evidence of a kill: a suite that did not load, a crash, or a
 * server that refused a connection all exit non-zero with no failing assertion.
 */
export function readTestLog(text: string, exitCode: number): TestRun {
  const failures: Failure[] = [];
  let pending: string[] = [];
  for (const line of text.split("\n")) {
    const status = /^(?:\((pass|fail|skip)\)|(✓|✗)) (.+?)(?: \[[\d.]+ms\])?$/.exec(line);
    if (!status) {
      pending.push(line);
      continue;
    }
    const failed = status[1] === "fail" || status[2] === "✗";
    if (failed) {
      const name = status[3] as string;
      // `(unnamed)` is a hook that timed out or an error between tests: not an assertion in
      // the area the mutant changed, so it can never be the evidence of a kill.
      failures.push({
        name,
        infra: name === "(unnamed)" || INFRASTRUCTURE.test(pending.join("\n")),
      });
    }
    pending = [];
  }
  return {
    passed: exitCode === 0,
    failures,
    asserted: failures.filter((f) => !f.infra),
  };
}

async function runFile(file: string): Promise<TestRun> {
  const proc = Bun.spawn(["bun", "test", "--timeout", "60000", file], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character IS what is stripped
  const text = `${out}\n${err}`.replace(/\u001b\[[0-9;]*m/g, "");
  return readTestLog(text, code);
}

/**
 * Every file in its OWN process, in turn, stopping at the first failing assertion.
 * Several Miniflare instances in one bun process have been found to break one another's
 * connection to workerd (an unnamed hook timeout, `Failed to connect`), which in a battery
 * is a mutant that cannot be judged; one file at a time is slower and answers.
 */
async function runTestsOnce(files: string[]): Promise<TestRun> {
  const all: TestRun = { passed: true, failures: [], asserted: [] };
  for (const file of files) {
    const run = await runFile(file);
    all.passed &&= run.passed;
    all.failures.push(...run.failures);
    all.asserted.push(...run.asserted);
    if (run.asserted.length > 0) break;
  }
  return all;
}

/**
 * Run the tests; when they fail WITHOUT a failing assertion (infrastructure, or a suite that
 * did not load) run them once more before believing it. A second such failure is returned as
 * it is, and the caller reports the mutant as inconclusive, never as killed.
 */
export async function runTests(files: string[]): Promise<TestRun> {
  const first = await runTestsOnce(files);
  if (first.passed || first.asserted.length > 0) return first;
  return runTestsOnce(files);
}

async function main(): Promise<void> {
  if (process.argv.includes("--check-anchors")) {
    let broken = 0;
    for (const m of MUTANTS) {
      try {
        mutate(readFileSync(join(ROOT, m.file), "utf8"), m);
      } catch (error) {
        broken++;
        console.log((error as Error).message);
      }
    }
    console.log(`${MUTANTS.length} mutants, ${broken} whose anchor no longer applies`);
    process.exit(broken === 0 ? 0 : 1);
  }
  const only = process.argv.slice(2).find((a) => !a.startsWith("--")) as Layer | undefined;
  const selected = MUTANTS.filter((m) => only === undefined || m.layer === only);
  const baseline = await runTests(ALL_TESTS);
  if (!baseline.passed) {
    console.error(
      `the unmutated tests do not pass${baseline.failures.length > 0 ? ` (${baseline.failures.map((f) => f.name).join("; ")})` : " (no failing test: a suite did not load or the infrastructure failed)"}; fix them before measuring mutants`,
    );
    process.exit(2);
  }
  let killed = 0;
  const survivors: Mutant[] = [];
  const inconclusive: Mutant[] = [];
  for (const m of selected) {
    const path = join(ROOT, m.file);
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, mutate(original, m));
      const focused = await runTests(m.tests ?? ALL_TESTS);
      if (!focused.passed && focused.asserted.length === 0) {
        inconclusive.push(m);
        console.log(
          `INCONCLUSIVE ${m.id}  (the tests failed twice without a failing assertion: ${focused.failures.map((f) => f.name).join("; ") || "no test ran to a result"})`,
        );
        continue;
      }
      if (!focused.passed) {
        killed++;
        console.log(
          `killed   ${m.id}  by ${focused.asserted.length} test(s), for example: ${focused.asserted[0]?.name}`,
        );
        continue;
      }
      // Survived its own tests: does any other writer test notice?
      const wide = m.tests === undefined ? focused : await runTests(ALL_TESTS);
      if (!wide.passed && wide.asserted.length > 0) {
        killed++;
        console.log(
          `killed   ${m.id}  only by the wider suite (${wide.asserted[0]?.name}); its own tests missed it`,
        );
      } else if (!wide.passed) {
        inconclusive.push(m);
        console.log(`INCONCLUSIVE ${m.id}  (the wider suite failed without a failing assertion)`);
      } else {
        survivors.push(m);
        console.log(
          `SURVIVED ${m.id}  (${m.note})${m.equivalent ? `\n         believed equivalent: ${m.equivalent}` : "\n         NOT believed equivalent: a test is missing"}`,
        );
      }
    } finally {
      writeFileSync(path, original);
    }
  }
  const equivalent = survivors.filter((s) => s.equivalent).length;
  console.log(
    `\n${selected.length} mutants: ${killed} killed, ${survivors.length} survived (${equivalent} believed equivalent, ${survivors.length - equivalent} real gaps), ${inconclusive.length} inconclusive`,
  );
  if (survivors.length - equivalent > 0 || inconclusive.length > 0) process.exit(1);
}

if (import.meta.main) await main();
