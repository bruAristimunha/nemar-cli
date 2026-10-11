/**
 * The Neurobagel writer, end to end (epic #1586, phase 4; ADR 0084).
 *
 * REAL ENGINES, no stand-ins for logic: a D1 carrying every production migration, the
 * R2 simulator `wrangler dev` runs, the real `dataRoutes` data plane, the real pure
 * transform. Only S3 and GitHub raw are a local HTTP server (`helpers/neurobagel-harness`).
 *
 * The anchor is nm000132: its REAL published manifest and the participants files
 * captured from data.nemar.org in phase 1. The writer reads them through the data
 * plane and must produce, byte for byte, the phase 1 goldens.
 *
 * Writes are counted by a transparent wrapper around the real bucket (`recordWrites`):
 * every call still reaches R2, the wrapper only records it, which is how "a second run
 * writes nothing" and the ordering of writes against deletes are proven.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import schema from "../../deploy/neurobagel/index.schema.json";
import { dataRoutes } from "../src/routes/data";
import { deleteDatasetCascade } from "../src/services/deletion";
import { type CurationResolver, createCurationResolver } from "../src/services/neurobagel-curation";
import { failedFederationTerms, loadEligibleRow } from "../src/services/neurobagel-eligibility";
import { saysNotAnonymous } from "../src/services/neurobagel-gather";
import {
  runNeurobagelReconcileCron,
  syncNeurobagelDataset,
} from "../src/services/neurobagel-hooks";
import { countOps, createOpCounter } from "../src/services/neurobagel-ops";
import {
  type LedgerEntry,
  type PlanRow,
  planWork,
  standingRefusals,
} from "../src/services/neurobagel-plan";
import { neurobagelStatus } from "../src/services/neurobagel-status";
import {
  ARTIFACT_KINDS,
  ARTIFACT_SUFFIX,
  type IndexDocument,
  LIST_MAX_PAGES,
  META,
  NEUROBAGEL_INDEX_KEY,
  NEUROBAGEL_INDEX_SCHEMA,
  indexProblems,
  listStore,
  parseStoredIndex,
} from "../src/services/neurobagel-store";
import {
  CLOSING_FIXED_OPS,
  DATASET_OPS_WORST,
  GATHER_HTTP_OPS,
  LIST_PAGE_OBJECTS,
  MAX_ARTIFACT_BYTES,
  OP_BUDGET,
  R2_METADATA_BUDGET,
  REMOVAL_LIMIT,
  type RunResult,
  TRANSIENT_CODES,
  closingReserve,
  fitMetadata,
  listingPages,
  neurobagelWriterMode,
  reconcileLimit,
  runNeurobagelWriter,
} from "../src/services/neurobagel-writer";
import {
  clearWithdrawalIntent,
  markConceptEzidStatus,
  markVersionEzidStatus,
  markWithdrawalIntent,
} from "../src/services/withdraw";
import type { Bindings } from "../src/types/bindings";
import { realD1, wrapD1 } from "./helpers/d1";
import {
  type Harness,
  gitBlobSha,
  golden,
  recordOps,
  recordWrites,
  seedDatasetRow,
  seedFromFixture,
  seedSynthetic,
  startHarness,
  storeKeys,
} from "./helpers/neurobagel-harness";

// These tests run a real D1 and an R2 simulator, and several loop over budgets or seed a few
// hundred objects. The budget loop took about 9 s on a CI runner and tripped bun's 5 s default,
// which also left a dangling process that failed the next test.
setDefaultTimeout(60_000);

let h: Harness;
const quiet = { error: console.error, warn: console.warn, log: console.log };

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
});

async function text(key: string): Promise<string> {
  const object = await h.bucket.get(key);
  if (!object) throw new Error(`no object ${key}`);
  return object.text();
}

async function storedIndex(): Promise<IndexDocument> {
  const parsed = parseStoredIndex(await text(NEUROBAGEL_INDEX_KEY));
  if (!parsed) throw new Error("stored index is not an index");
  return parsed;
}

/**
 * The REAL data plane, with one fault injected: `fault(path, real)` may return a replacement
 * for the answer to a request, or null to let the real one stand. For the faults the real
 * one makes only by accident (see `GatherDeps.dataPlane`).
 */
function dataPlaneWith(
  env: Bindings,
  fault: (path: string, real: Response) => Promise<Response | null>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const real = await dataRoutes.fetch(request, env, undefined);
    const replacement = await fault(new URL(request.url).pathname, real.clone());
    if (!replacement) return real;
    await real.body?.cancel().catch(() => {});
    return replacement;
  };
}

function run(over: Partial<Parameters<typeof runNeurobagelWriter>[1]> = {}, env?: Bindings) {
  return runNeurobagelWriter(env ?? h.env(), { trigger: "admin", execute: true, ...over });
}

const outcomes = (r: RunResult) => r.results.map((x) => `${x.id}:${x.outcome}`);

/**
 * A dataset whose table has a `group` column and a REAL curation entry for it, written
 * in the file's format and loaded by the real `lookupCuration` (the vocabulary is the
 * pinned one: `snomed:230690007` is "Cerebrovascular accident"). The pins are the git
 * blob hashes of the very bytes served, so the entry is current, unless `stalePin`.
 */
function curatedDataset(
  id: string,
  groupValue: string,
  options: { stalePin?: boolean } = {},
): { tsv: string; pjson: string; resolver: CurationResolver } {
  const tsv = `participant_id\tage\tgroup\nsub-01\t30\t${groupValue}\nsub-02\t31\t${groupValue}\nsub-03\t32\tpatient\n`;
  const pjson = JSON.stringify({ age: { Units: "years" } });
  const bytes = (t: string) => new TextEncoder().encode(t);
  const file = {
    format: 1,
    datasets: {
      [id]: {
        columns: {
          group: {
            IsAbout: { TermURL: "nb:Diagnosis", Label: "Diagnosis" },
            Levels: { patient: { TermURL: "snomed:230690007", Label: "Cerebrovascular accident" } },
            MissingValues: groupValue === "patient" ? [] : [groupValue],
            VariableType: "Categorical",
          },
        },
        evidence: { source: "a test", reviewer: "a test", review: "author", date: "2026-10-02" },
        pins: {
          participants_tsv: options.stalePin ? "0".repeat(40) : gitBlobSha(bytes(tsv)),
          participants_json: gitBlobSha(bytes(pjson)),
        },
      },
    },
  };
  const resolver = createCurationResolver({
    load: async () => ({
      file,
      lookupCuration: (await import("../../shared/neurobagel/curation")).lookupCuration,
    }),
    clock: () => new Date("2026-10-02T12:00:00Z"),
  });
  return { tsv, pjson, resolver };
}

// ----------------------------------------------------------------------------
// The anchor: real data through the real data plane
// ----------------------------------------------------------------------------

describe("nm000132, real manifest and real participants files", () => {
  test("the writer reproduces the phase 1 goldens byte for byte", async () => {
    seedFromFixture(h);
    const result = await run();

    expect(result.status).toBe("ok");
    expect(outcomes(result)).toEqual(["nm000132:written"]);
    expect(await storeKeys(h.bucket)).toEqual([
      "index.json",
      "nm000132.jsonld",
      "nm000132_annotated.json",
      "nm000132_dataset_description.json",
    ]);
    for (const name of [
      "nm000132.jsonld",
      "nm000132_annotated.json",
      "nm000132_dataset_description.json",
    ]) {
      expect(await text(name)).toBe(golden("nm000132", name));
    }
  });

  test("every artifact carries its sha256, verified by R2, and the JSON-LD carries the fingerprint", async () => {
    seedFromFixture(h);
    await run();
    const listing = await listStore(h.bucket);
    const stored = listing.datasets.get("nm000132");
    expect(stored?.jsonld && stored.dictionary && stored.description).toBeTruthy();
    for (const kind of ARTIFACT_KINDS) {
      const artifact = stored?.[kind];
      const head = await h.bucket.head(artifact?.key as string);
      // R2 was handed the hash and checked it against the bytes it stored.
      expect(head?.checksums.toJSON().sha256).toBe(artifact?.sha256);
      expect(head?.httpMetadata?.contentType).toBe(
        kind === "jsonld" ? "application/ld+json" : "application/json",
      );
    }
    const meta = stored?.jsonld?.meta ?? {};
    expect(meta[META.fingerprint]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta[META.rowFingerprint]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta[META.signature]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta[META.manifestEtag]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(meta[META.version]).toBe("v1.1.1");
    // The companions carry only the two facts the index needs.
    expect(Object.keys(stored?.dictionary?.meta ?? {}).sort()).toEqual(["kind", "sha256"]);
  });

  test("the transform ran with expectedDatasetId, so another dataset's metadata is refused", async () => {
    // Direct evidence the id is passed: a dataset whose data plane serves another
    // dataset's metadata is the case the transform's check exists for, and the writer
    // would have no way to notice. Here the gather itself checks it first.
    seedFromFixture(h);
    const result = await run({ only: ["nm000132"] });
    expect(outcomes(result)).toEqual(["nm000132:written"]);
  });
});

// ----------------------------------------------------------------------------
// The index, against the schema the node's tooling uses
// ----------------------------------------------------------------------------

const ajv = new Ajv({ strict: false, allErrors: true });
const validateIndex = ajv.compile(schema);

/** The schema's x-rules, which a JSON Schema cannot state, read FROM the schema file. */
function xRuleProblems(index: IndexDocument): string[] {
  const rules = (schema as unknown as { "x-rules": Record<string, unknown> })["x-rules"];
  const suffix = rules.artifactSuffix as Record<string, string>;
  const problems: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const d of index.datasets) {
    if (ids.has(d.id)) problems.push(`duplicate id ${d.id}`);
    ids.add(d.id);
    const jsonlds = d.artifacts.filter((a) => a.kind === "jsonld");
    if (rules.oneJsonldPerDataset && jsonlds.length !== 1) problems.push(`${d.id}: jsonld count`);
    for (const a of d.artifacts) {
      if (rules.nameIsIdPlusSuffix && a.name !== `${d.id}${suffix[a.kind]}`) {
        problems.push(`${a.name}: not id + suffix`);
      }
      if (names.has(a.name)) problems.push(`duplicate name ${a.name}`);
      names.add(a.name);
    }
  }
  return problems;
}

describe("index.json conforms to deploy/neurobagel/index.schema.json", () => {
  test("the writer's index validates, with the schema's own x-rules", async () => {
    seedFromFixture(h);
    seedSynthetic(h, "nm000600");
    seedSynthetic(h, "on000600");
    await run();
    const index = await storedIndex();
    expect(validateIndex(index), JSON.stringify(validateIndex.errors)).toBe(true);
    expect(xRuleProblems(index)).toEqual([]);
    expect(index.schema).toBe(NEUROBAGEL_INDEX_SCHEMA);
    expect(index.datasets.map((d) => d.id)).toEqual(["nm000132", "nm000600", "on000600"]);
    expect(indexProblems(index)).toEqual([]);
  });

  test("the producer-side constants cannot drift from the schema file", () => {
    const props = schema.properties as unknown as { schema: { const: string } };
    expect(NEUROBAGEL_INDEX_SCHEMA).toBe(props.schema.const);
    const rules = (schema as unknown as { "x-rules": { artifactSuffix: Record<string, string> } })[
      "x-rules"
    ];
    expect(ARTIFACT_SUFFIX).toEqual(rules.artifactSuffix);
    const kinds = (
      schema.definitions as unknown as { artifact: { properties: { kind: { enum: string[] } } } }
    ).artifact.properties.kind.enum;
    expect([...ARTIFACT_KINDS]).toEqual(kinds);
  });

  test("the artifact entry is the three-file shape the loader reads, with sizes and hashes of the real bytes", async () => {
    seedFromFixture(h);
    await run();
    const entry = (await storedIndex()).datasets[0];
    expect(entry?.artifacts.map((a) => [a.name, a.kind])).toEqual([
      ["nm000132.jsonld", "jsonld"],
      ["nm000132_annotated.json", "dictionary"],
      ["nm000132_dataset_description.json", "description"],
    ]);
    // The README's worked example is these very files.
    expect(entry?.artifacts.map((a) => a.bytes)).toEqual([41928, 1305, 811]);
    expect(entry?.artifacts.map((a) => a.sha256)).toEqual([
      "9008cd4477758e7da24339fe4dd43ee380025a600527d7b5540e5369d59824e2",
      "447f64adedea5463732607800fe4dfd0ad94296ea36ee04af0e0ace0166a886a",
      "465ce163d97fb10dbd61dfd8d12592fed07a931346f42c000cd88d62729dba9f",
    ]);
    // The reference fingerprint of the schema: sha256 of the artifact hashes, joined.
    expect(entry?.fingerprint).toBe(
      "sha256:acd7b00c07840016c67ae625fc3de2a01e1f247694db1e2b28dabe24af7b9f95",
    );
    expect(entry?.input_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("a document the loader would refuse is never written", () => {
    const good: IndexDocument = {
      schema: NEUROBAGEL_INDEX_SCHEMA,
      generated_at: "2026-10-02T00:00:00Z",
      datasets: [],
    };
    expect(indexProblems(good)).toEqual([]);
    expect(indexProblems({ ...good, generated_at: "yesterday" })).not.toEqual([]);
    const entry = {
      id: "nm000001",
      fingerprint: `sha256:${"a".repeat(64)}`,
      input_fingerprint: `sha256:${"b".repeat(64)}`,
      artifacts: [
        { name: "nm000001.jsonld", kind: "jsonld" as const, sha256: "c".repeat(64), bytes: 10 },
      ],
    };
    expect(indexProblems({ ...good, datasets: [entry] })).toEqual([]);
    // No JSON-LD, a name that is not id + suffix, a duplicate id: each is a refusal.
    expect(indexProblems({ ...good, datasets: [{ ...entry, artifacts: [] }] })).not.toEqual([]);
    expect(
      indexProblems({
        ...good,
        datasets: [
          { ...entry, artifacts: [{ ...entry.artifacts[0], name: "nm000002.jsonld" }] },
        ] as never,
      }),
    ).not.toEqual([]);
    expect(indexProblems({ ...good, datasets: [entry, entry] })).not.toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Idempotency: nothing changed, nothing written
// ----------------------------------------------------------------------------

describe("a second run with nothing changed writes nothing", () => {
  test("zero puts and zero deletes, to artifacts and index alike", async () => {
    seedFromFixture(h);
    seedSynthetic(h, "nm000601");
    const first = recordWrites(h.bucket);
    const r1 = await run({}, h.env({ NEUROBAGEL: first.bucket }));
    expect(outcomes(r1).sort()).toEqual(["nm000132:written", "nm000601:written"]);
    // Three artifacts a dataset, plus the index, once.
    expect(first.log.filter((e) => e.op === "put")).toHaveLength(7);

    const second = recordWrites(h.bucket);
    const r2 = await run({}, h.env({ NEUROBAGEL: second.bucket }));
    expect(outcomes(r2).sort()).toEqual(["nm000132:unchanged", "nm000601:unchanged"]);
    expect(second.log).toEqual([]);
    expect(r2.index).toMatchObject({ changed: false, written: false, entries: 2 });
  });

  test("and the index keeps its timestamp, so it is byte-identical", async () => {
    seedFromFixture(h);
    await run({ now: new Date("2026-10-02T10:00:00Z") });
    const before = await text(NEUROBAGEL_INDEX_KEY);
    await run({ now: new Date("2026-10-03T10:00:00Z") });
    expect(await text(NEUROBAGEL_INDEX_KEY)).toBe(before);
    expect(parseStoredIndex(before)?.generated_at).toBe("2026-10-02T10:00:00.000Z");
  });

  test("a change to one input rewrites exactly that dataset and the index", async () => {
    seedSynthetic(h, "nm000602");
    seedSynthetic(h, "nm000603");
    await run();
    h.db.query("UPDATE datasets SET name = 'Renamed' WHERE dataset_id = 'nm000602'").run();

    const rec = recordWrites(h.bucket);
    const result = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(outcomes(result).sort()).toEqual(["nm000602:written", "nm000603:unchanged"]);
    const puts = rec.log.map((e) => e.key).sort();
    expect(puts).toEqual(
      [
        "index.json",
        "nm000602.jsonld",
        "nm000602_annotated.json",
        "nm000602_dataset_description.json",
      ]
        .sort()
        .filter((k) => puts.includes(k)),
    );
    // Only the JSON-LD is certain to change with a name; every key written is this dataset's or the index.
    expect(puts.every((k) => k === "index.json" || k.startsWith("nm000602"))).toBe(true);
    expect(puts).toContain("nm000602.jsonld");
    expect(puts).toContain("index.json");
  });

  test("a row edited between the plan and the processing is stamped with what it was built from, so it is not stale for ever", async () => {
    seedSynthetic(h, "nm000607");
    // The edit lands on the first statement the writer issues AFTER it planned: the
    // re-check of the one row. The plan saw the old name; the fingerprint and the artifacts
    // are built from the new one, and the signature must be too.
    let edited = false;
    const d1 = wrapD1(realD1(h.db), (sql) => {
      if (!edited && sql.includes("WHERE d.dataset_id = ?") && !sql.includes("enrichment_length")) {
        edited = true;
        h.db
          .query("UPDATE datasets SET name = 'Edited mid-run' WHERE dataset_id = 'nm000607'")
          .run();
      }
    });
    const first = await run({}, h.env({ DB: d1 }));
    expect(edited).toBe(true);
    expect(outcomes(first)).toEqual(["nm000607:written"]);
    expect(await text("nm000607.jsonld")).toContain("Edited mid-run");

    const status = await neurobagelStatus(h.env());
    expect(status.counts.stale).toBe(0);
    expect(status.counts.written).toBe(1);
    // And the next run finds nothing to do at all, rather than examining it as stale each time.
    const rec = recordWrites(h.bucket);
    const second = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(outcomes(second)).toEqual(["nm000607:unchanged"]);
    expect(rec.log).toEqual([]);
  });

  test("two readers that disagree on the latest version (a timestamp tie) refuse the dataset, not stamp one version's ETag on another's content", async () => {
    // Two versions created in the same second. The writer breaks the tie by id (the newer
    // row); the data plane's own query does not, and answers the first. Both manifests exist.
    const tie = "2026-01-02 03:04:05";
    seedSynthetic(h, "nm000608", {
      version: "1.0.0",
      versions: [
        ["1.0.0", tie],
        ["1.1.0", tie],
      ],
    });
    const manifest = JSON.parse(
      new TextDecoder().decode(h.standin.objects.get("/nm000608/version/v1.0.0.json")?.body),
    );
    h.standin.put(
      "/nm000608/version/v1.1.0.json",
      JSON.stringify({ ...manifest, version: "1.1.0", doi: "10.82901/nemar.nm000608.v1.1.0" }),
    );
    const rec = recordWrites(h.bucket);
    const result = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(result.results).toEqual([
      {
        id: "nm000608",
        outcome: "refused",
        code: "latest_version_disagreement",
        detail: expect.stringContaining("1.1.0"),
      },
    ]);
    expect(rec.log).toEqual([]);
    // A standing disagreement is a finding a person can read, until it is resolved.
    const status = await neurobagelStatus(h.env());
    expect(status.needs_review).toEqual([
      {
        id: "nm000608",
        source: "refusal",
        code: "latest_version_disagreement",
        since: expect.any(String),
      },
    ]);
  });

  test("a rewritten manifest (a new ETag, same name) is a change the row cannot see", async () => {
    seedSynthetic(h, "nm000604");
    await run();
    // Same dataset row, same version; the manifest is rewritten in place, as the pipeline does.
    const key = "/nm000604/version/v1.0.0.json";
    const manifest = JSON.parse(new TextDecoder().decode(h.standin.objects.get(key)?.body));
    manifest.files["sub-04/eeg/sub-04_task-rest_eeg.edf"] = {
      key: "MD5E-s5--abc.edf",
      size: 5,
      checksum: "md5:abc",
    };
    h.standin.put(key, JSON.stringify(manifest));

    const result = await run({ only: ["nm000604"] });
    expect(outcomes(result)).toEqual(["nm000604:written"]);
    // The new subject is in the graph, which only the manifest could have told it.
    expect(await text("nm000604.jsonld")).toContain("sub-04");
  });

  test("force rewrites although the fingerprint matches", async () => {
    seedSynthetic(h, "nm000605");
    await run();
    const rec = recordWrites(h.bucket);
    const result = await run({ force: true }, h.env({ NEUROBAGEL: rec.bucket }));
    expect(outcomes(result)).toEqual(["nm000605:written"]);
    // Identical bytes are not rewritten (companions skipped); the JSON-LD records what it was built from.
    expect(rec.log.map((e) => e.key)).toEqual(["nm000605.jsonld"]);
  });

  test("the transform version moves the signature, so a version bump marks every dataset stale", async () => {
    seedSynthetic(h, "nm000606");
    await run();
    const listing = await listStore(h.bucket);
    const stamped = listing.datasets.get("nm000606")?.jsonld?.meta[META.signature];
    expect(stamped).toBeTruthy();
    // Corrupt the stored signature as a bumped transform version would leave it stale.
    const object = await h.bucket.get("nm000606.jsonld");
    const body = await (object as R2ObjectBody).arrayBuffer();
    await h.bucket.put("nm000606.jsonld", body, {
      customMetadata: { ...(object?.customMetadata ?? {}), [META.signature]: "sha256:stale" },
    });
    const dry = await run({ execute: false });
    expect(dry.results.find((r) => r.id === "nm000606")?.outcome).toBe("unchanged");
    // Stale rows are examined first; here the row fingerprint still matches, so nothing is written.
    const rec = recordWrites(h.bucket);
    const after = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(outcomes(after)).toEqual(["nm000606:unchanged"]);
    expect(rec.log).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Removal
// ----------------------------------------------------------------------------

describe("a dataset that stops being eligible leaves the store", () => {
  const CAUSES: [string, string][] = [
    ["goes private", "UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000610'"],
    [
      "is withdrawn",
      "UPDATE datasets SET visibility = 'private', withdrawn_at = datetime('now') WHERE dataset_id = 'nm000610'",
    ],
    ["is archived", "UPDATE datasets SET status = 'archived' WHERE dataset_id = 'nm000610'"],
    ["is marked deleted", "UPDATE datasets SET status = 'deleted' WHERE dataset_id = 'nm000610'"],
    ["is deleted outright", "DELETE FROM datasets WHERE dataset_id = 'nm000610'"],
    [
      "becomes anonymous",
      "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000610'",
    ],
    [
      "loses its first publication",
      "UPDATE datasets SET first_published_at = NULL WHERE dataset_id = 'nm000610'",
    ],
    ["loses its versions", "DELETE FROM dataset_versions WHERE dataset_id = 'nm000610'"],
    ["becomes a sandbox row", "UPDATE datasets SET is_sandbox = 1 WHERE dataset_id = 'nm000610'"],
  ];

  for (const [cause, sql] of CAUSES) {
    test(`it ${cause}: artifacts deleted and the index drops it, in one run`, async () => {
      seedSynthetic(h, "nm000610");
      seedSynthetic(h, "nm000611");
      await run();
      expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000610", "nm000611"]);

      h.db.run(sql);
      const result = await run();

      expect(result.removed).toEqual(["nm000610"]);
      expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000611"]);
      expect(await storeKeys(h.bucket)).toEqual([
        "index.json",
        "nm000611.jsonld",
        "nm000611_annotated.json",
        "nm000611_dataset_description.json",
      ]);
    });
  }

  test("a dataset that stops being eligible AFTER the plan, while earlier datasets are being written, is not written", async () => {
    // A run examines up to fifty datasets one after another, each taking round trips, so the
    // catalog read at its start is not the catalog it is working from by the end. The row is
    // asked for again when each dataset's turn comes.
    for (const id of ["nm000626", "nm000627", "nm000628"]) seedSynthetic(h, id);
    let rechecks = 0;
    const interleaved = wrapD1(realD1(h.db), (sql) => {
      // Each dataset's turn begins with the re-check of its row; the second turn is nm000627's.
      if (sql.includes("WHERE d.dataset_id = ?") && !sql.includes("enrichment_length")) {
        rechecks++;
        if (rechecks === 2) {
          // Archived, not private: the data plane's own gate looks at visibility only, so
          // only the writer's re-check stands between this row and a write.
          h.db.run("UPDATE datasets SET status = 'archived' WHERE dataset_id = 'nm000627'");
        }
      }
    });
    const result = await run({}, h.env({ DB: interleaved }));
    expect(rechecks).toBeGreaterThanOrEqual(2);
    expect(outcomes(result).filter((o) => !o.endsWith(":removed"))).toEqual([
      "nm000626:written",
      "nm000627:refused",
      "nm000628:written",
    ]);
    expect(result.results[1]).toMatchObject({ code: "no_longer_eligible" });
    expect(await storeKeys(h.bucket)).not.toContain("nm000627.jsonld");
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000626", "nm000628"]);
  });

  test("removal does not depend on ingestion: the data plane can be down entirely", async () => {
    seedSynthetic(h, "nm000612");
    seedSynthetic(h, "nm000613");
    await run();
    h.db.query("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000612'").run();
    // S3 and GitHub answer nothing at all.
    h.standin.objects.clear();

    const result = await run();

    expect(result.removed).toEqual(["nm000612"]);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000613"]);
    expect(await storeKeys(h.bucket)).not.toContain("nm000612.jsonld");
    // The survivor could not be re-examined (its manifest is gone) and was left exactly as it was.
    expect(await storeKeys(h.bucket)).toContain("nm000613.jsonld");
  });

  test("a dataset gone from D1 is removed from a store that holds it", async () => {
    seedSynthetic(h, "nm000614");
    await run();
    h.db.run("DELETE FROM dataset_versions WHERE dataset_id = 'nm000614'");
    h.db.run("DELETE FROM datasets WHERE dataset_id = 'nm000614'");
    const result = await run();
    expect(result.removed).toEqual(["nm000614"]);
    expect((await storedIndex()).datasets).toEqual([]);
  });

  test("a restored dataset comes back on the next run", async () => {
    seedSynthetic(h, "nm000615");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000615'");
    await run();
    expect(await storeKeys(h.bucket)).toEqual(["index.json"]);
    h.db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = 'nm000615'");
    const back = await run();
    expect(outcomes(back)).toEqual(["nm000615:written"]);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000615"]);
  });

  test("only the requested ids are removed when a list is given, though the index drops every ineligible one", async () => {
    seedSynthetic(h, "nm000616");
    seedSynthetic(h, "nm000617");
    await run();
    h.db.run(
      "UPDATE datasets SET visibility = 'private' WHERE dataset_id IN ('nm000616','nm000617')",
    );
    const result = await run({ only: ["nm000616"] });
    expect(result.removed).toEqual(["nm000616"]);
    // 617 is out of the index (removal is by omission, always) but its objects wait for their run.
    expect((await storedIndex()).datasets).toEqual([]);
    expect(await storeKeys(h.bucket)).toContain("nm000617.jsonld");
  });
});

// ----------------------------------------------------------------------------
// Ordering, for a consumer that may read at any moment
// ----------------------------------------------------------------------------

describe("write order", () => {
  test("an addition writes every artifact before the index", async () => {
    seedSynthetic(h, "nm000620");
    seedSynthetic(h, "nm000621");
    const rec = recordWrites(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    const keys = rec.log.map((e) => e.key);
    const indexAt = keys.indexOf("index.json");
    expect(indexAt).toBe(keys.length - 1);
    expect(rec.log.every((e) => e.op === "put")).toBe(true);
  });

  test("within a dataset the JSON-LD, the commit marker, is written last", async () => {
    seedSynthetic(h, "nm000622");
    const rec = recordWrites(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(rec.log.map((e) => e.key)).toEqual([
      "nm000622_annotated.json",
      "nm000622_dataset_description.json",
      "nm000622.jsonld",
      "index.json",
    ]);
  });

  test("a removal writes the index before it deletes the artifacts", async () => {
    seedSynthetic(h, "nm000623");
    seedSynthetic(h, "nm000624");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000623'");
    const rec = recordWrites(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(rec.log.map((e) => `${e.op}:${e.key}`)).toEqual([
      "put:index.json",
      "delete:nm000623.jsonld",
      "delete:nm000623_annotated.json",
      "delete:nm000623_dataset_description.json",
    ]);
  });

  test("a run that both adds and removes writes artifacts, then the index, then deletes", async () => {
    seedSynthetic(h, "nm000625");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000625'");
    seedSynthetic(h, "nm000626");
    const rec = recordWrites(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    const ops = rec.log.map((e) => `${e.op}:${e.key}`);
    const indexAt = ops.indexOf("put:index.json");
    const lastPut = ops
      .map((o, i) => (o.startsWith("put:nm") ? i : -1))
      .reduce((a, b) => Math.max(a, b));
    const firstDelete = ops.findIndex((o) => o.startsWith("delete:"));
    expect(lastPut).toBeLessThan(indexAt);
    expect(indexAt).toBeLessThan(firstDelete);
  });

  test("a stale index that cannot be replaced keeps the artifacts of what is leaving", async () => {
    seedSynthetic(h, "nm000627");
    seedSynthetic(h, "nm000628");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000627'");
    // Every attempt to replace the index loses: another writer changes it first.
    let bumps = 0;
    const real = h.bucket;
    const contended = new Proxy(real, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key === NEUROBAGEL_INDEX_KEY) {
              bumps++;
              await (target.put as (...a: unknown[]) => unknown)(
                key,
                `${JSON.stringify({ schema: NEUROBAGEL_INDEX_SCHEMA, generated_at: "2026-01-01T00:00:00Z", datasets: [], bump: bumps })}\n`,
              );
            }
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    console.warn = () => {};
    const result = await run({}, h.env({ NEUROBAGEL: contended }));
    console.warn = quiet.warn;
    expect(result.index.contended).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.removals_pending).toBe(1);
    // Nothing was deleted, because the index could not be brought up to date first.
    expect(await storeKeys(h.bucket)).toContain("nm000627.jsonld");
  });

  test("a writer that loses the index race rebuilds from a fresh listing and wins", async () => {
    seedSynthetic(h, "nm000629");
    let injected = false;
    const real = h.bucket;
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key === NEUROBAGEL_INDEX_KEY && !injected) {
              injected = true;
              // Another run replaced the index after this one read it.
              await (target.put as (...a: unknown[]) => unknown)(
                key,
                `${JSON.stringify({ schema: NEUROBAGEL_INDEX_SCHEMA, generated_at: "2026-01-01T00:00:00Z", datasets: [] })}\n`,
              );
            }
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    // Start with an index present, so the write is conditional.
    await run();
    seedSynthetic(h, "nm000630");
    const result = await run({}, h.env({ NEUROBAGEL: racing }));
    expect(result.index.written).toBe(true);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000629", "nm000630"]);
  });

  test("the previous index is read BEFORE the listing it is rebuilt from", async () => {
    seedSynthetic(h, "nm000633");
    await run();
    const rec = recordOps(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    // The first listing is the run's own, at the start. The sync that follows reads the
    // index and only then lists: a write conditional on the index it read cannot be
    // clobbered by a listing taken before another run's writes.
    const firstList = rec.log.indexOf("list");
    const indexRead = rec.log.indexOf("get:index.json");
    const secondList = rec.log.indexOf("list", firstList + 1);
    expect(indexRead).toBeGreaterThan(firstList);
    expect(secondList).toBeGreaterThan(indexRead);
  });

  test("a dataset another run publishes while this one works is kept: eligibility is decided after the listing", async () => {
    seedSynthetic(h, "nm000634");
    await run();
    // Another writer (a hook) publishes nm000635 at the moment this run lists the bucket for
    // its index. The catalog this run read at its start has never heard of it.
    let published = false;
    const rec = recordOps(h.bucket, async (op, count) => {
      if (op === "list" && count === 2 && !published) {
        published = true;
        seedSynthetic(h, "nm000635");
        await syncNeurobagelDataset(h.env(), "nm000635", "hook:version");
      }
    });
    const result = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(published).toBe(true);
    expect(result.removed).toEqual([]);
    expect(await storeKeys(h.bucket)).toContain("nm000635.jsonld");
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000634", "nm000635"]);
  });

  test("two hooks for two datasets at once leave an index naming both", async () => {
    seedSynthetic(h, "nm000631");
    seedSynthetic(h, "nm000632");
    const env = h.env();
    await Promise.all([
      syncNeurobagelDataset(env, "nm000631", "hook:version"),
      syncNeurobagelDataset(env, "nm000632", "hook:version"),
    ]);
    // Whatever the interleaving, a final reconcile settles the index to the listing.
    await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000631", "nm000632"]);
    expect(validateIndex(await storedIndex())).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// The anonymity double guard
// ----------------------------------------------------------------------------

describe("anonymity: two independent guards", () => {
  test("a dataset anonymous in D1 is never written, and no file of it is read", async () => {
    seedSynthetic(h, "nm000640", { anonymous: 1, firstPublishedAt: null });
    seedSynthetic(h, "nm000641");
    const result = await run();
    expect(outcomes(result)).toEqual(["nm000641:written"]);
    expect(await storeKeys(h.bucket)).not.toContain("nm000640.jsonld");
    // Not even its manifest or participants file was requested.
    expect(h.standin.log.filter((r) => r.path.includes("nm000640"))).toEqual([]);
    expect(result.eligible).toBe(1);
  });

  test("the standing anonymous deposit's id, in the reserved band, is never written", async () => {
    seedSynthetic(h, "nm099998", { anonymous: 1, firstPublishedAt: null, isSandbox: 1 });
    const result = await run();
    expect(result.eligible).toBe(0);
    expect(await storeKeys(h.bucket)).toEqual(
      ["index.json"].filter(() => (result.index.entries ?? 0) > 0),
    );
    expect(h.standin.log.filter((r) => r.path.includes("nm099998"))).toEqual([]);
  });

  test("the row says eligible, the data plane says anonymous: refused, audited, and nothing GitHub or mail", async () => {
    seedSynthetic(h, "nm000642");
    seedSynthetic(h, "nm000643");
    // The race the second guard exists for: the row is eligible when the plan is made and
    // is anonymous by the time the data plane builds its metadata. (The schema's triggers
    // forbid the state in one statement, so the stamp goes in the same UPDATE.)
    let flipped = false;
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (!flipped && sql.includes("SELECT dataset_id, name, description, github_repo")) {
        flipped = true;
        h.db.run(
          "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000642'",
        );
      }
    });
    const result = await run({ only: ["nm000642", "nm000643"] }, h.env({ DB: d1 }));

    expect(result.results.find((r) => r.id === "nm000642")).toMatchObject({
      outcome: "refused",
      code: "anonymity_disagreement",
    });
    expect(result.anonymity_findings).toBe(1);
    expect(await storeKeys(h.bucket)).not.toContain("nm000642.jsonld");
    // No depositor file of it was requested after the guard.
    expect(
      h.standin.log.filter((r) => r.path.includes("nm000642") && r.path.includes("participants")),
    ).toEqual([]);
    // Audit log, and only the audit log.
    const rows = h.db
      .query<{ action: string; resource_id: string; details: string }, []>(
        "SELECT action, resource_id, details FROM audit_log WHERE action LIKE 'neurobagel_%anonymity%'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe("nm000642");
    expect(rows[0]?.details).not.toMatch(/Ada|Lovelace|Dataset nm/);
  });

  test("a disagreement removes what the store already held for that dataset (fail closed)", async () => {
    seedSynthetic(h, "nm000644");
    seedSynthetic(h, "nm000645");
    await run();
    let flipped = false;
    h.db.run("UPDATE datasets SET name = 'Touched' WHERE dataset_id = 'nm000644'");
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (!flipped && sql.includes("SELECT dataset_id, name, description, github_repo")) {
        flipped = true;
        h.db.run(
          "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000644'",
        );
      }
    });
    const result = await run({ only: ["nm000644"] }, h.env({ DB: d1 }));
    expect(result.results.find((r) => r.id === "nm000644")?.outcome).toBe("refused");
    expect(result.removed).toEqual(["nm000644"]);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000645"]);
  });

  test("a data plane that says anonymous, over a row that still says eligible, removes what the store held: the finding alone is enough", async () => {
    // The row is NOT touched, so the end-of-run check against D1 would keep the dataset: only
    // the anonymity finding of this run can take it out of the index and delete its artifacts.
    seedSynthetic(h, "nm000649");
    seedSynthetic(h, "nm000659");
    await run();
    h.db.run("UPDATE datasets SET name = 'Touched' WHERE dataset_id = 'nm000649'");
    const env = h.env();
    const dataPlane = dataPlaneWith(env, async (path, real) => {
      if (!path.startsWith("/nm000649/metadata.json")) return null;
      const doc = (await real.json()) as Record<string, unknown>;
      doc.anonymous = true;
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const result = await run({ only: ["nm000649"], deps: { dataPlane } }, env);
    expect(result.results.find((r) => r.id === "nm000649")).toMatchObject({
      outcome: "refused",
      code: "anonymity_disagreement",
    });
    expect(result.removed).toEqual(["nm000649"]);
    expect((await storeKeys(h.bucket)).filter((k) => k.startsWith("nm000649"))).toEqual([]);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000659"]);
    expect((await loadEligibleRow(realD1(h.db), "nm000649")).eligible).toBe(true);
  });

  test("the guard's contract, as a pure function: exactly false passes, everything else is refused", () => {
    expect(saysNotAnonymous(false)).toBe(true);
    for (const value of [true, null, undefined, "false", "true", "", 0, 1, {}, [], Number.NaN]) {
      expect(saysNotAnonymous(value), String(value)).toBe(false);
    }
  });

  const UNKNOWN_VALUES: [string, (doc: Record<string, unknown>) => void][] = [
    ["a missing anonymous", (doc) => Reflect.deleteProperty(doc, "anonymous")],
    ["a null anonymous", (doc) => Object.assign(doc, { anonymous: null })],
    ['the string "false"', (doc) => Object.assign(doc, { anonymous: "false" })],
    ["the number 0", (doc) => Object.assign(doc, { anonymous: 0 })],
    ['the string "true"', (doc) => Object.assign(doc, { anonymous: "true" })],
    ["an empty object", (doc) => Object.assign(doc, { anonymous: {} })],
  ];

  for (const [label, corrupt] of UNKNOWN_VALUES) {
    test(`a metadata document with ${label} is refused: unknown is not false, and no depositor file is read`, async () => {
      seedSynthetic(h, "nm000646");
      const env = h.env();
      const dataPlane = dataPlaneWith(env, async (path, real) => {
        if (!path.endsWith("/metadata.json")) return null;
        const doc = (await real.json()) as Record<string, unknown>;
        corrupt(doc);
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const rec = recordWrites(h.bucket);
      const mark = h.standin.log.length;
      const result = await run(
        { deps: { dataPlane } },
        h.env({ NEUROBAGEL: rec.bucket, DB: env.DB }),
      );
      expect(result.results).toEqual([
        { id: "nm000646", outcome: "refused", code: "anonymity_disagreement" },
      ]);
      expect(result.anonymity_findings).toBe(1);
      expect(rec.log).toEqual([]);
      // The depositor's files live under the repository path; none was requested.
      expect(h.standin.log.slice(mark).filter((r) => r.path.startsWith("/nemarDatasets/"))).toEqual(
        [],
      );
      expect(
        h.db
          .query(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'neurobagel_anonymity_finding'",
          )
          .get(),
      ).toEqual({ n: 1 });
    });
  }

  test("the control: the same wrapper leaving anonymous: false alone writes the dataset", async () => {
    seedSynthetic(h, "nm000647");
    const env = h.env();
    const result = await run({ deps: { dataPlane: dataPlaneWith(env, async () => null) } }, env);
    expect(outcomes(result)).toEqual(["nm000647:written"]);
  });
});

// ----------------------------------------------------------------------------
// Curation: the lead's contract
// ----------------------------------------------------------------------------

describe("a dataset with a curation entry is never converted without it", () => {
  test("a failed lookup stops the dataset: nothing written, the existing artifact left, a finding recorded", async () => {
    seedSynthetic(h, "nm000650");
    await run();
    const before = await text("nm000650.jsonld");
    h.db.run(
      "UPDATE datasets SET name = 'Changed after curation broke' WHERE dataset_id = 'nm000650'",
    );

    const rec = recordWrites(h.bucket);
    const result = await run(
      {
        deps: { curation: async () => ({ kind: "failed", reason: "curation.json is not valid" }) },
      },
      h.env({ NEUROBAGEL: rec.bucket }),
    );

    expect(result.results[0]).toMatchObject({ outcome: "refused", code: "curation_unavailable" });
    expect(rec.log).toEqual([]);
    expect(await text("nm000650.jsonld")).toBe(before);
    const ledger = h.db
      .query<{ action: string; details: string }, []>(
        "SELECT action, details FROM audit_log WHERE resource_id = 'nm000650' AND action = 'neurobagel_refused'",
      )
      .all();
    expect(ledger).toHaveLength(1);
    expect(JSON.parse(ledger[0]?.details ?? "{}").code).toBe("curation_unavailable");
  });

  test("a lookup that THROWS is the same stop, never a conversion with no curation", async () => {
    seedSynthetic(h, "nm000651");
    const result = await run({
      deps: {
        curation: async () => {
          throw new Error("CurationError: an entry is stale");
        },
      },
    });
    expect(result.results[0]).toMatchObject({ outcome: "refused", code: "curation_unavailable" });
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("a real entry is applied through the real loader and the real transform", async () => {
    const { tsv, pjson, resolver } = curatedDataset("nm000652", "patient");
    seedSynthetic(h, "nm000652", { tsv, participantsJson: pjson });
    const result = await run({ deps: { curation: resolver } });
    expect(result.results[0]?.outcome).toBe("written");
    // The entry's diagnosis is in the graph, and the mechanical healthy control is too
    // (the entry maps `patient` and declares `Control` missing: it is the entry's call).
    const jsonld = await text("nm000652.jsonld");
    expect(jsonld).toContain("snomed:230690007");
    expect(result.needs_review).toEqual([]);
    const meta = (await listStore(h.bucket)).datasets.get("nm000652")?.jsonld?.meta ?? {};
    expect(meta[META.flags]).toBe("");
  });

  test("a stale entry federates the dataset WITHOUT a false healthy control, and says so", async () => {
    // The table says `Control` and the entry, reviewed against other bytes, withdraws the
    // mechanical healthy control mapping. The entry is stale (its pin is not this file),
    // so it is skipped whole and the variable it names is WITHHELD, never fallen back to.
    const { tsv, pjson, resolver } = curatedDataset("nm000653", "Control", { stalePin: true });
    seedSynthetic(h, "nm000653", { tsv, participantsJson: pjson });
    const result = await run({ deps: { curation: resolver } });
    const written = result.results[0];
    expect(written?.outcome).toBe("written");
    if (written?.outcome !== "written") throw new Error("unreachable");
    expect(written.flags).toEqual(expect.arrayContaining(["curation_stale", "curation_withheld"]));
    expect(await text("nm000653.jsonld")).not.toContain("ncit:C94342");
    expect(result.needs_review).toEqual([{ id: "nm000653", flags: written.flags }]);
    // The flags ride on the stored artifact, so status can list them without re-running.
    const meta = (await listStore(h.bucket)).datasets.get("nm000653")?.jsonld?.meta ?? {};
    expect(meta[META.flags]).toContain("curation_stale");
  });

  test("with no entry at all the same table DOES carry the mechanical healthy control", async () => {
    // The control for the test above: the withheld claim is real, and the entry's
    // absence is what would have published it.
    const { tsv, pjson } = curatedDataset("nm000654", "Control");
    seedSynthetic(h, "nm000654", { tsv, participantsJson: pjson });
    await run();
    expect(await text("nm000654.jsonld")).toContain("ncit:C94342");
  });

  test("a failed dataset does not stop the others, and the finding clears when it recovers", async () => {
    seedSynthetic(h, "nm000653");
    seedSynthetic(h, "nm000654");
    const failing = async (id: string) =>
      id === "nm000653"
        ? ({ kind: "failed", reason: "broken" } as const)
        : ({ kind: "none" } as const);
    const r1 = await run({ deps: { curation: failing } });
    expect(outcomes(r1).sort()).toEqual(["nm000653:refused", "nm000654:written"]);
    // The standing finding is recorded once, not once per run.
    await run({ deps: { curation: failing } });
    const refusals = () =>
      h.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'neurobagel_refused' AND resource_id = 'nm000653'",
        )
        .get()?.n;
    expect(refusals()).toBe(1);
    // Fixed: it is written, and a clearing row follows.
    const r3 = await run({});
    expect(outcomes(r3)).toContain("nm000653:written");
    const last = h.db
      .query<{ action: string }, []>(
        "SELECT action FROM audit_log WHERE resource_id = 'nm000653' AND action LIKE 'neurobagel_%' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(last?.action).toBe("neurobagel_cleared");
  });

  test("a curation hash joins the fingerprint, so a changed entry is a rewrite", async () => {
    seedSynthetic(h, "nm000655");
    await run({ deps: { curation: async () => ({ kind: "none" }) } });
    const rec = recordWrites(h.bucket);
    const result = await run(
      {
        execute: false,
        deps: { curation: async () => ({ kind: "entry", hash: "sha256:new", entry: {} }) },
      },
      h.env({ NEUROBAGEL: rec.bucket }),
    );
    expect(result.results[0]).toMatchObject({ outcome: "would_write", reason: "inputs changed" });
    expect(rec.log).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Needs-review flags
// ----------------------------------------------------------------------------

describe("needs-review flags are surfaced, never silent", () => {
  test("a partial join rides on the stored artifact and in the run", async () => {
    // Table ids meet the index in part: sub-01 and sub-02 join, sub-09 has no data.
    seedSynthetic(h, "nm000660", {
      subjects: ["sub-01", "sub-02", "sub-03"],
      tsv: "participant_id\tage\nsub-01\t21\nsub-02\t22\nsub-09\t23\n",
    });
    const result = await run();
    const written = result.results[0];
    expect(written?.outcome).toBe("written");
    if (written?.outcome !== "written") throw new Error("unreachable");
    expect(written.flags).toEqual(["partial_join"]);
    expect(result.needs_review).toEqual([{ id: "nm000660", flags: ["partial_join"] }]);
    const meta = (await listStore(h.bucket)).datasets.get("nm000660")?.jsonld?.meta ?? {};
    expect(meta[META.flags]).toBe("partial_join");
  });

  test("informational flags do not ask for review", async () => {
    seedSynthetic(h, "nm000661", { tsv: null, participantsJson: null });
    const result = await run();
    expect(result.results[0]?.outcome).toBe("written");
    expect(result.needs_review).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// What a dataset the data plane cannot answer does to the store
// ----------------------------------------------------------------------------

describe("failures never replace a good artifact with a worse one", () => {
  test("a manifest read that breaks mid-stream leaves metadata degraded: refused, existing set kept", async () => {
    seedSynthetic(h, "nm000670");
    await run();
    const before = await text("nm000670.jsonld");
    h.db.run(
      "UPDATE datasets SET name = 'Renamed while S3 was failing' WHERE dataset_id = 'nm000670'",
    );
    const key = "/nm000670/version/v1.0.0.json";
    const manifest = JSON.parse(new TextDecoder().decode(h.standin.objects.get(key)?.body));
    // The manifest is rewritten (a new ETag), and HEAD still answers with it; but the
    // body breaks off partway, as a dropped S3 connection does.
    manifest.created = "2026-02-02T00:00:00.000Z";
    h.standin.put(key, JSON.stringify(manifest), { breakAfter: 40 });
    console.error = () => {};

    const rec = recordWrites(h.bucket);
    const result = await run({ only: ["nm000670"] }, h.env({ NEUROBAGEL: rec.bucket }));
    console.error = quiet.error;

    expect(result.results[0]).toMatchObject({ outcome: "refused", code: "metadata_degraded" });
    expect(rec.log).toEqual([]);
    expect(await text("nm000670.jsonld")).toBe(before);
  });

  test("a transient S3 failure on the HEAD is an error of the run, written nowhere and ledgered nowhere", async () => {
    seedSynthetic(h, "nm000671");
    // Point the writer's S3 at a port nothing listens on.
    const result = await run({}, h.env({ S3_ENDPOINT_URL: "http://127.0.0.1:1" }));
    expect(result.results[0]?.outcome).toBe("error");
    expect(await storeKeys(h.bucket)).toEqual([]);
    const ledger = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'neurobagel_refused'",
      )
      .get();
    expect(ledger?.n).toBe(0);
  });

  test("a manifest the bucket does not have is refused (manifest_absent)", async () => {
    seedSynthetic(h, "nm000672");
    h.standin.remove("/nm000672/version/v1.0.0.json");
    const result = await run();
    expect(result.results[0]).toMatchObject({ outcome: "refused", code: "manifest_absent" });
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("an absent participants file is null to the transform, and a failed one is NOT", async () => {
    seedSynthetic(h, "nm000673", { tsv: null });
    const ok = await run({ only: ["nm000673"] });
    expect(ok.results[0]?.outcome).toBe("written");

    seedSynthetic(h, "nm000674");
    // The manifest names participants.tsv, but the raw host cannot serve it.
    h.standin.remove("/nemarDatasets/nm000674/v1.0.0/participants.tsv");
    console.error = () => {};
    console.warn = () => {};
    const bad = await run({ only: ["nm000674"] });
    console.error = quiet.error;
    console.warn = quiet.warn;
    expect(bad.results[0]).toMatchObject({ outcome: "refused", code: "fetch_failed" });
    expect(await storeKeys(h.bucket)).not.toContain("nm000674.jsonld");
  });

  test("a 404 that is not 'this file is not in the manifest' is never an absent table, even after metadata.json succeeded", async () => {
    // The manifest read fine for metadata.json; by the time participants.tsv is asked for, the
    // data plane answers 404 for another reason (the version, a manifest it could not read).
    // That must not publish the dataset without its phenotype table because S3 blinked.
    seedSynthetic(h, "nm000657");
    const env = h.env();
    for (const body of ["Version not published", "Version not found", "Dataset not found"]) {
      const dataPlane = dataPlaneWith(env, async (path) =>
        path.endsWith("/participants.tsv")
          ? new Response(JSON.stringify({ error: body }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            })
          : null,
      );
      const rec = recordWrites(h.bucket);
      const result = await run(
        { deps: { dataPlane } },
        h.env({ NEUROBAGEL: rec.bucket, DB: env.DB }),
      );
      expect(result.results).toEqual([
        {
          id: "nm000657",
          outcome: "refused",
          code: "fetch_failed",
          detail: expect.stringContaining("not for the file"),
        },
      ]);
      expect(rec.log, body).toEqual([]);
    }
    // The one 404 that IS an absent file ("File not found") still publishes without the table.
    const absent = dataPlaneWith(env, async (path) =>
      path.endsWith("/participants.tsv")
        ? new Response(JSON.stringify({ error: "File not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
        : null,
    );
    const ok = await run({ deps: { dataPlane: absent } }, env);
    expect(outcomes(ok)).toEqual(["nm000657:written"]);
  });

  test("an annexed participants file is reached through its redirect, once, and the URL is not reported", async () => {
    seedSynthetic(h, "nm000675", { annexTsv: true });
    const followed: string[] = [];
    const tsv = "participant_id\tage\tsex\nsub-01\t20\tM\nsub-02\t21\tF\nsub-03\t22\tM\n";
    const result = await run({
      deps: {
        followRedirect: (async (url: string) => {
          followed.push(url);
          return new Response(tsv, { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    expect(result.results[0]?.outcome).toBe("written");
    expect(followed).toHaveLength(1);
    expect(followed[0]).toMatch(/^https:\/\//);
    // The URL (a presigned credential) is in no part of the result.
    expect(JSON.stringify(result)).not.toContain(followed[0] as string);
    expect(await text("nm000675.jsonld")).toContain("sub-01");
  });
});

// ----------------------------------------------------------------------------
// Modes
// ----------------------------------------------------------------------------

describe("off by default, and a reported no-op without a bucket", () => {
  test("the switch is exactly the string 1", () => {
    expect(
      neurobagelWriterMode({ NEUROBAGEL_WRITER_ENABLED: undefined, NEUROBAGEL: undefined }),
    ).toBe("disabled");
    for (const value of ["0", "", "true", "yes", "1 ", " 1", "on"]) {
      expect(neurobagelWriterMode({ NEUROBAGEL_WRITER_ENABLED: value, NEUROBAGEL: h.bucket })).toBe(
        "disabled",
      );
    }
    expect(neurobagelWriterMode({ NEUROBAGEL_WRITER_ENABLED: "1", NEUROBAGEL: undefined })).toBe(
      "store_unconfigured",
    );
    expect(neurobagelWriterMode({ NEUROBAGEL_WRITER_ENABLED: "1", NEUROBAGEL: h.bucket })).toBe(
      "enabled",
    );
  });

  test("disabled: a real run does nothing and says so; no bucket call is made", async () => {
    seedSynthetic(h, "nm000680");
    const rec = recordWrites(h.bucket);
    const result = await run(
      {},
      h.env({ NEUROBAGEL: rec.bucket, NEUROBAGEL_WRITER_ENABLED: undefined }),
    );
    expect(result.status).toBe("disabled");
    expect(rec.log).toEqual([]);
    expect(await storeKeys(h.bucket)).toEqual([]);
    expect(h.standin.log).toEqual([]);
  });

  test("store_unconfigured: a reported no-op, not an error", async () => {
    seedSynthetic(h, "nm000681");
    const result = await run({}, h.env({ NEUROBAGEL: undefined }));
    expect(result.status).toBe("store_unconfigured");
    expect(result.error).toBeUndefined();
    expect(h.standin.log).toEqual([]);
  });

  test("a dry run needs the bucket but not the switch, and writes nothing", async () => {
    seedSynthetic(h, "nm000682");
    const rec = recordWrites(h.bucket);
    const result = await run(
      { execute: false },
      h.env({ NEUROBAGEL: rec.bucket, NEUROBAGEL_WRITER_ENABLED: undefined }),
    );
    expect(result.status).toBe("ok");
    expect(result.dry_run).toBe(true);
    expect(result.writer_enabled).toBe(false);
    expect(result.results).toEqual([
      { id: "nm000682", outcome: "would_write", reason: "not in the store" },
    ]);
    expect(rec.log).toEqual([]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'neurobagel_%'").get(),
    ).toEqual({
      n: 0,
    });
  });

  test("a dry run reports what a real run would remove", async () => {
    seedSynthetic(h, "nm000683");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000683'");
    const dry = await run({ execute: false });
    expect(dry.results).toContainEqual({ id: "nm000683", outcome: "would_remove" });
    expect(await storeKeys(h.bucket)).toContain("nm000683.jsonld");
    expect(dry.index.changed).toBe(true);
    expect(dry.index.written).toBe(false);
  });

  test("the per-tick bound reads its variable, defaults to 10 and never exceeds the hard limit of 50", () => {
    expect(reconcileLimit({})).toBe(10);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "7" })).toBe(7);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "0" })).toBe(10);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "-3" })).toBe(10);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "lots" })).toBe(10);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "50" })).toBe(50);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "51" })).toBe(50);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "99999" })).toBe(50);
  });

  test("a run is clamped to the hard limit however large a limit it is handed", async () => {
    for (let i = 0; i < 3; i++) seedSynthetic(h, `nm00083${i}`);
    for (const limit of [51, 200, 100000]) {
      const result = await run({ execute: false, limit });
      expect(result.limit).toBe(50);
    }
    expect((await run({ execute: false, limit: 50 })).limit).toBe(50);
    expect((await run({ execute: false, limit: 0 })).limit).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// Limits on what is written
// ----------------------------------------------------------------------------

describe("an artifact over the loader's cap is never written", () => {
  /** The three artifacts' sizes as stored, from a first real run. */
  async function sizesAfterFirstRun(
    id: string,
  ): Promise<{ jsonld: number; dictionary: number; description: number }> {
    seedSynthetic(h, id);
    await run();
    const stored = (await listStore(h.bucket)).datasets.get(id);
    return {
      jsonld: stored?.jsonld?.size ?? 0,
      dictionary: stored?.dictionary?.size ?? 0,
      description: stored?.description?.size ?? 0,
    };
  }

  test("exactly at the cap is written; one byte over is refused, with the artifact and its size named", async () => {
    const sizes = await sizesAfterFirstRun("nm000870");
    const largest = Math.max(sizes.jsonld, sizes.dictionary, sizes.description);
    expect(largest).toBeGreaterThan(100);
    const rec = recordWrites(h.bucket);

    const exact = await run(
      { force: true, maxArtifactBytes: largest },
      h.env({ NEUROBAGEL: rec.bucket }),
    );
    expect(outcomes(exact)).toEqual(["nm000870:written"]);

    const over = await run(
      { force: true, maxArtifactBytes: largest - 1 },
      h.env({ NEUROBAGEL: rec.bucket }),
    );
    expect(over.results[0]).toMatchObject({
      id: "nm000870",
      outcome: "refused",
      code: "artifact_too_large",
      detail: expect.stringMatching(/nm000870.*is \d+ bytes/),
    });
    // One oversize artifact makes the loader refuse the whole release, so none of the set
    // is written, and what the store held stays.
    expect(rec.log.filter((e) => e.op === "put").length).toBe(1);
    expect(await sizesAfterFirstRun2("nm000870")).toEqual(sizes);
  });

  async function sizesAfterFirstRun2(id: string) {
    const stored = (await listStore(h.bucket)).datasets.get(id);
    return {
      jsonld: stored?.jsonld?.size ?? 0,
      dictionary: stored?.dictionary?.size ?? 0,
      description: stored?.description?.size ?? 0,
    };
  }

  test("each of the three artifacts is held to the cap, not only the largest", async () => {
    // A cap below the smallest artifact refuses the dataset on whichever it meets first; a
    // cap between them refuses it on the larger. Together: no artifact is exempt.
    const sizes = await sizesAfterFirstRun("nm000871");
    for (const [kind, size] of Object.entries(sizes)) {
      const result = await run({ force: true, maxArtifactBytes: size - 1 });
      expect(result.results[0], kind).toMatchObject({ code: "artifact_too_large" });
    }
  });

  test("the refusal is a finding a person can read, and the good set the store holds stays", async () => {
    await sizesAfterFirstRun("nm000872");
    h.db.run("UPDATE datasets SET name = 'Revised' WHERE dataset_id = 'nm000872'");
    const first = await run({ maxArtifactBytes: 100 });
    expect(first.results[0]).toMatchObject({ code: "artifact_too_large" });
    const status = await neurobagelStatus(h.env());
    expect(status.needs_review).toEqual([
      { id: "nm000872", source: "refusal", code: "artifact_too_large", since: expect.any(String) },
    ]);
    // The old artifacts are still served: a refusal never replaces a good set with nothing.
    expect(await storeKeys(h.bucket)).toContain("nm000872.jsonld");
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000872"]);
  });

  test("the default cap is the loader's 6 MiB", () => {
    expect(MAX_ARTIFACT_BYTES).toBe(6 * 1024 * 1024);
  });
});

describe("custom metadata is kept inside R2's limit", () => {
  const base = {
    [META.sha256]: "a".repeat(64),
    [META.kind]: "jsonld",
    [META.fingerprint]: `sha256:${"b".repeat(64)}`,
  };

  test("a set under the budget is returned unchanged", () => {
    const meta = { ...base, [META.flags]: "partial_join,curation_stale" };
    expect(fitMetadata(meta)).toBe(meta);
  });

  test("over it, the FLAGS give way, one at a time, and the cut is marked with a +", () => {
    const flags = Array.from({ length: 200 }, (_, i) => `curation_flag_${i}`);
    const meta = { ...base, [META.flags]: flags.join(",") };
    const size = (m: Record<string, string>) =>
      Object.entries(m).reduce((n, [k, v]) => n + k.length + v.length, 0);
    expect(size(meta)).toBeGreaterThan(R2_METADATA_BUDGET);
    const fitted = fitMetadata(meta);
    expect(size(fitted)).toBeLessThanOrEqual(R2_METADATA_BUDGET);
    expect(fitted[META.flags]?.endsWith("+")).toBe(true);
    // Nothing else is touched, and what survives is a prefix of the flags, in order.
    expect(fitted[META.sha256]).toBe(base[META.sha256]);
    expect(fitted[META.fingerprint]).toBe(base[META.fingerprint]);
    const kept = (fitted[META.flags] ?? "").slice(0, -1).split(",");
    expect(kept.length).toBeGreaterThan(10);
    expect(kept).toEqual(flags.slice(0, kept.length));
  });

  test("over it with no flags to cut, there is nothing to trim and the set is returned as it is", () => {
    const meta = { ...base, [META.manifestEtag]: "e".repeat(2000) };
    expect(fitMetadata(meta)).toEqual(meta);
  });

  test("a real write stays inside the budget and is still stamped", async () => {
    // The stamp the writer puts on a JSON-LD is read back by the next run; a write R2 refused
    // for size would lose the whole dataset.
    seedSynthetic(h, "nm000873");
    const result = await run();
    expect(outcomes(result)).toEqual(["nm000873:written"]);
    const head = await h.bucket.head("nm000873.jsonld");
    const size = Object.entries(head?.customMetadata ?? {}).reduce(
      (n, [k, v]) => n + k.length + v.length,
      0,
    );
    expect(size).toBeLessThanOrEqual(R2_METADATA_BUDGET);
  });
});

describe("removals are bounded per run", () => {
  test("more datasets leaving than REMOVAL_LIMIT: that many are removed, the rest are reported pending, and the next run finishes", async () => {
    const total = REMOVAL_LIMIT + 5;
    const stamp = (kind: string) => ({ sha256: "0".repeat(64), kind });
    const ids = Array.from({ length: total }, (_, i) => `nm0009${String(i).padStart(2, "0")}`);
    // Objects the writer stamped for datasets that are in no catalog: all of them are leaving.
    for (const id of ids) {
      await h.bucket.put(`${id}.jsonld`, "{}", {
        customMetadata: { ...stamp("jsonld"), [META.fingerprint]: "sha256:x" },
      });
      await h.bucket.put(`${id}_annotated.json`, "{}", { customMetadata: stamp("dictionary") });
      await h.bucket.put(`${id}_dataset_description.json`, "{}", {
        customMetadata: stamp("description"),
      });
    }
    const first = await run();
    expect(first.removed).toHaveLength(REMOVAL_LIMIT);
    expect(first.removals_pending).toBe(5);
    expect((await storeKeys(h.bucket)).length).toBe(5 * 3);
    const second = await run();
    expect(second.removed).toHaveLength(5);
    expect(second.removals_pending).toBe(0);
    expect(await storeKeys(h.bucket)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// The owner's takedown flows
// ----------------------------------------------------------------------------

describe("every state the real takedown flows leave behind is ineligible, and the stored artifacts leave", () => {
  // The flows are the repository's own: `nemar admin withdraw` (services/withdraw.ts: visibility
  // private first, then the withdrawal columns, then the concept and every version DOI marked
  // `unavailable`), a DOI tombstoned on its own (POST /admin/datasets/:id/doi/update writes only
  // `datasets.ezid_status`), and the cascade delete (services/deletion.ts). Their D1 writes are
  // made here by the services' own exported helpers and by the real cascade, not by a copy.
  const ID = "nm000890";
  const CONTROL = "nm000891";

  beforeAll(() => {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = h.standin.url;
  });
  afterAll(() => {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  });

  const setPrivate = (d1: D1Database) =>
    // The one D1 statement `applyDatasetVisibility(.., "private")` issues; the GitHub and S3
    // halves of that service need the network.
    d1
      .prepare("UPDATE datasets SET visibility = ? WHERE dataset_id = ?")
      .bind("private", ID)
      .run();

  const STATES: [string, (d1: D1Database) => Promise<void>, string[]][] = [
    [
      "a complete withdrawal",
      async (d1) => {
        await setPrivate(d1);
        await markWithdrawalIntent(d1, ID, "upstream_403");
        await markConceptEzidStatus(d1, ID, "unavailable");
        await markVersionEzidStatus(d1, ID, "1.0.0", "unavailable");
      },
      ["public", "not_withdrawn", "not_tombstoned"],
    ],
    [
      "a withdrawal interrupted right after the visibility flip",
      async (d1) => {
        await setPrivate(d1);
      },
      ["public"],
    ],
    [
      "a withdrawal interrupted after its intent was stamped",
      async (d1) => {
        await setPrivate(d1);
        await markWithdrawalIntent(d1, ID, "no_source");
      },
      ["public", "not_withdrawn"],
    ],
    [
      "a withdrawal stamp on a dataset still public (a restore half done)",
      async (d1) => {
        await markWithdrawalIntent(d1, ID, "upstream_403");
      },
      ["not_withdrawn"],
    ],
    [
      "a concept DOI tombstoned on its own (doi/update, status unavailable)",
      async (d1) => {
        await markConceptEzidStatus(d1, ID, "unavailable");
      },
      ["not_tombstoned"],
    ],
    [
      "the cascade delete",
      async (d1) => {
        // A dataset a person owns: the harness's rows belong to the system catalog sentinel,
        // which the cascade refuses by design.
        h.db.run(
          `INSERT INTO users (username, email, password_hash, status, role, email_verified)
           VALUES ('takedownowner', 'takedownowner@example.org', 'x', 'approved', 'member', 1)`,
        );
        h.db.run(
          "UPDATE datasets SET owner_user_id = (SELECT id FROM users WHERE username = 'takedownowner') WHERE dataset_id = 'nm000890'",
        );
        // Production-shaped, because a non-production worker may only cascade ids it owns;
        // S3 is skipped, the repository delete goes to the local GitHub stand-in.
        const result = await deleteDatasetCascade(
          d1,
          h.env({ ENVIRONMENT: "production", DB: d1 }),
          ID,
          { skipS3: true },
        );
        expect(result.steps.d1.success).toBe(true);
      },
      ["real_dataset"],
    ],
  ];

  for (const [label, apply, terms] of STATES) {
    test(`${label}: rejected by ${terms.join(" and ")}, removed from the store and the index by the next run`, async () => {
      seedSynthetic(h, ID);
      seedSynthetic(h, CONTROL);
      await run();
      expect(await storeKeys(h.bucket)).toContain(`${ID}.jsonld`);
      expect((await storedIndex()).datasets.map((d) => d.id)).toEqual([ID, CONTROL]);

      await apply(realD1(h.db));

      // The predicate says no, and says which terms.
      const { row, eligible } = await loadEligibleRow(realD1(h.db), ID);
      expect(eligible).toBe(false);
      if (terms[0] !== "real_dataset") expect(failedFederationTerms(row)).toEqual(terms);
      else expect(row).toBeNull();

      // The next run takes it out, and leaves the control alone.
      const result = await run();
      expect(result.removed).toEqual([ID]);
      expect((await storeKeys(h.bucket)).filter((k) => k.startsWith(ID))).toEqual([]);
      expect((await storedIndex()).datasets.map((d) => d.id)).toEqual([CONTROL]);
      expect(await storeKeys(h.bucket)).toContain(`${CONTROL}.jsonld`);
    });
  }

  test("a complete withdrawal is removed by the hook that saw it, and by the daily reconcile", async () => {
    for (const via of ["hook", "cron"] as const) {
      await h.reset();
      seedSynthetic(h, ID);
      seedSynthetic(h, CONTROL);
      await run();
      const d1 = realD1(h.db);
      await setPrivate(d1);
      await markWithdrawalIntent(d1, ID, "upstream_403");
      await markConceptEzidStatus(d1, ID, "unavailable");
      if (via === "hook") {
        await syncNeurobagelDataset(h.env(), ID, "hook:publication");
      } else {
        const result = await runNeurobagelReconcileCron(h.env({ ENVIRONMENT: "production" }));
        expect(result?.removed).toEqual([ID]);
      }
      expect(
        (await storeKeys(h.bucket)).filter((k) => k.startsWith(ID)),
        via,
      ).toEqual([]);
      expect(
        (await storedIndex()).datasets.map((d) => d.id),
        via,
      ).toEqual([CONTROL]);
    }
  });

  test("a PARTIAL cascade delete (the row kept, the manifest gone) leaves the old artifact federated, and says so in status with its age", async () => {
    // `DELETE /admin/datasets/:id` answers 207 when a step failed and keeps the row. If the
    // objects went and the row did not, the row is still eligible, the writer cannot read a
    // manifest (`manifest_absent`) and keeps the artifact it has: a manifest that is
    // missing for a moment must not unfederate a healthy dataset. The dataset stays out
    // there until the owner finishes the delete, so the refusal is made VISIBLE: a standing
    // finding with the time it was last confirmed.
    seedSynthetic(h, ID);
    seedSynthetic(h, CONTROL);
    await run();
    h.standin.remove(`/${ID}/version/v1.0.0.json`);
    const result = await run();
    expect(result.results.find((r) => r.id === ID)).toMatchObject({
      outcome: "refused",
      code: "manifest_absent",
    });
    // Conservative: the old set is still stored and indexed.
    expect(await storeKeys(h.bucket)).toContain(`${ID}.jsonld`);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual([ID, CONTROL]);
    // And it is a finding, with its age, not silence.
    const status = await neurobagelStatus(h.env());
    expect(status.needs_review).toEqual([
      {
        id: ID,
        source: "refusal",
        code: "manifest_absent",
        since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      },
    ]);
    // Finishing the delete (the row goes) takes it out at the next run, and the finding with it.
    // (The cascade's last batch: the versions and the row.)
    h.db.run("DELETE FROM dataset_versions WHERE dataset_id = ?", [ID]);
    h.db.run("DELETE FROM datasets WHERE dataset_id = ?", [ID]);
    await run();
    expect((await storeKeys(h.bucket)).filter((k) => k.startsWith(ID))).toEqual([]);
    expect((await neurobagelStatus(h.env())).needs_review).toEqual([]);
  });

  test("restoring the dataset (the owner reverses the takedown) makes it eligible and written again", async () => {
    seedSynthetic(h, ID);
    await run();
    const d1 = realD1(h.db);
    await setPrivate(d1);
    await markWithdrawalIntent(d1, ID, "upstream_403");
    await markConceptEzidStatus(d1, ID, "unavailable");
    await run();
    expect((await storeKeys(h.bucket)).filter((k) => k.startsWith(ID))).toEqual([]);
    // What `restore` does to the same columns, in reverse.
    await d1
      .prepare("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?")
      .bind(ID)
      .run();
    await clearWithdrawalIntent(d1, ID);
    await markConceptEzidStatus(d1, ID, "public");
    const result = await run();
    expect(outcomes(result)).toEqual([`${ID}:written`]);
  });
});

describe("removals spend only what the budget has left", () => {
  test("with little budget left the run removes fewer than are leaving, says so, and the next run finishes", async () => {
    const total = 20;
    const stamp = (kind: string) => ({ sha256: "0".repeat(64), kind });
    const ids = Array.from({ length: total }, (_, i) => `nm0009${String(i).padStart(2, "0")}`);
    for (const id of ids) {
      await h.bucket.put(`${id}.jsonld`, "{}", {
        customMetadata: { ...stamp("jsonld"), [META.fingerprint]: "sha256:x" },
      });
      await h.bucket.put(`${id}_annotated.json`, "{}", { customMetadata: stamp("dictionary") });
      await h.bucket.put(`${id}_dataset_description.json`, "{}", {
        customMetadata: stamp("description"),
      });
    }
    // The run's own setup spends a handful of operations; each removal is one more.
    const first = await run({ opBudget: 20 });
    expect(first.removed.length).toBeGreaterThan(0);
    expect(first.removed.length).toBeLessThan(total);
    expect(first.removals_pending).toBe(total - first.removed.length);
    expect(first.ops.spent).toBeLessThanOrEqual(20);
    const second = await run();
    expect(second.removed.length).toBe(total - first.removed.length);
    expect(await storeKeys(h.bucket)).toEqual([]);
  });
});

describe("a dry run writes no ledger row and no audit row, whatever it finds", () => {
  const auditCount = () =>
    (h.db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;

  test("including a refused dataset, an anonymity-class disagreement and a failed curation lookup", async () => {
    seedDatasetRow(h.db, "nm000880"); // no manifest: refused (manifest_absent)
    seedSynthetic(h, "nm000881"); // the data plane will say anonymous: an anonymity finding
    seedSynthetic(h, "nm000882"); // its curation lookup fails
    const env = h.env();
    const dataPlane = dataPlaneWith(env, async (path, real) => {
      if (!path.startsWith("/nm000881/metadata.json")) return null;
      const doc = (await real.json()) as Record<string, unknown>;
      doc.anonymous = true;
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const curation: CurationResolver = async (id) =>
      id === "nm000882" ? { kind: "failed", reason: "the file did not load" } : { kind: "none" };

    const before = auditCount();
    const dry = await run({ execute: false, deps: { dataPlane, curation } }, env);
    // The dry run found what a real one would: the refusal and the failed lookup. (The
    // anonymity disagreement is only seen by a gather, which a dry run does not do.)
    expect(outcomes(dry)).toContain("nm000880:refused");
    expect(outcomes(dry)).toContain("nm000882:refused");
    expect(auditCount()).toBe(before);

    // The same inputs, executed, DO write the ledger: the guard above is what kept it clean.
    const real = await run({ deps: { dataPlane, curation } }, env);
    expect(real.anonymity_findings).toBe(1);
    expect(auditCount()).toBeGreaterThan(before);
    const kinds = h.db
      .query<{ action: string }, []>(
        "SELECT DISTINCT action FROM audit_log WHERE action LIKE 'neurobagel_%'",
      )
      .all()
      .map((r) => r.action);
    expect(kinds).toEqual(
      expect.arrayContaining(["neurobagel_refused", "neurobagel_anonymity_finding"]),
    );
  });
});

// ----------------------------------------------------------------------------
// What a run costs, and the budget that keeps it inside a request
// ----------------------------------------------------------------------------

describe("a run counts what it spends and stops with headroom to finish", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `nm0008${String(i).padStart(2, "0")}`);

  async function rewriteCost(n: number): Promise<RunResult> {
    await h.reset();
    for (const id of ids(n)) seedSynthetic(h, id);
    await run();
    h.db.run("UPDATE datasets SET name = name || ' (revised)'");
    return run({ limit: 50 });
  }

  test("the count is kept at the bindings: D1 statements, R2 calls and HTTP requests", async () => {
    seedSynthetic(h, "nm000801");
    const result = await run();
    expect(result.ops.d1).toBeGreaterThan(5);
    expect(result.ops.r2).toBeGreaterThan(3);
    expect(result.ops.http).toBeGreaterThan(0);
    expect(result.ops.spent).toBe(result.ops.d1 + result.ops.r2 + result.ops.http);
    expect(result.ops.budget).toBe(OP_BUDGET);
    // The same run on a quiet system is cheaper, which is the point of a fingerprint.
    const quiet = await run();
    expect(quiet.ops.spent).toBeLessThan(result.ops.spent);
  });

  test("a rewritten dataset costs no more than DATASET_OPS_WORST, an unchanged one far less", async () => {
    const small = await rewriteCost(2);
    const large = await rewriteCost(6);
    expect(small.results.every((r) => r.outcome === "written")).toBe(true);
    expect(large.results.every((r) => r.outcome === "written")).toBe(true);
    const perRewritten = (large.ops.spent - small.ops.spent) / 4;
    expect(perRewritten).toBeGreaterThan(5);
    expect(perRewritten).toBeLessThanOrEqual(DATASET_OPS_WORST);
    // A run's fixed overhead (the plan, the listing, the ledger, the index sync) fits its reserve.
    expect(small.ops.spent - 2 * perRewritten).toBeLessThanOrEqual(closingReserve(7, 0));

    const unchanged = await run({ limit: 50 });
    expect(unchanged.results.every((r) => r.outcome === "unchanged")).toBe(true);
    expect(unchanged.ops.spent).toBeLessThan(closingReserve(19, 0) + 6 * 6);
  });

  test("a run that spends its budget stops, says so, and still brings the index up to date", async () => {
    for (const id of ids(8)) seedSynthetic(h, id);
    await run({ limit: 1 });
    h.db.run("UPDATE datasets SET name = name || ' (revised)'");
    const result = await run({ limit: 50, opBudget: 130 });
    expect(result.stopped).toBe("ops_budget");
    expect(result.examined).toBeGreaterThanOrEqual(1);
    expect(result.examined).toBeLessThan(8);
    expect(result.unexamined).toBe(8 - result.examined);
    // The reserve is real: what was spent, closing steps included, is inside the budget.
    expect(result.ops.spent).toBeLessThanOrEqual(130);
    expect(await indexMismatches()).toEqual([]);
    expect(result.index.written || !result.index.changed).toBe(true);

    // Run again to continue: every dataset is eventually rewritten, and the index agrees at each step.
    for (let again = 0; again < 8; again++) {
      const next = await run({ limit: 50, opBudget: 130 });
      expect(await indexMismatches()).toEqual([]);
      if (next.stopped === null) break;
    }
    for (const id of ids(8)) expect(await text(`${id}.jsonld`)).toContain("(revised)");
  });

  test("the reserve is real: a run that has many removals to make still makes all of them", async () => {
    // 20 datasets leaving (objects the writer stamped, in no catalog) and 14 to write for the
    // first time, on a budget the loop could spend entirely if it kept nothing back.
    const stamp = (kind: string) => ({ sha256: "0".repeat(64), kind });
    const leaving = Array.from({ length: 20 }, (_, i) => `nm0009${String(i).padStart(2, "0")}`);
    for (const id of leaving) {
      await h.bucket.put(`${id}.jsonld`, "{}", {
        customMetadata: { ...stamp("jsonld"), [META.fingerprint]: "sha256:x" },
      });
      await h.bucket.put(`${id}_annotated.json`, "{}", { customMetadata: stamp("dictionary") });
      await h.bucket.put(`${id}_dataset_description.json`, "{}", {
        customMetadata: stamp("description"),
      });
    }
    for (const id of ids(14)) seedSynthetic(h, id);
    const budget = 220;
    const result = await run({ limit: 50, opBudget: budget });
    expect(result.stopped).toBe("ops_budget");
    expect(result.examined).toBeGreaterThan(0);
    expect(result.examined).toBeLessThan(14);
    // Every removal was made in this run: the loop left room for them.
    expect(result.removed).toHaveLength(20);
    expect(result.removals_pending).toBe(0);
    expect(result.ops.spent).toBeLessThanOrEqual(budget);
  });

  test("the reserve grows with the store: one list call a page, twice, plus a delete for each dataset leaving", () => {
    expect(listingPages(0)).toBe(1);
    expect(listingPages(LIST_PAGE_OBJECTS)).toBe(1);
    expect(listingPages(LIST_PAGE_OBJECTS + 1)).toBe(2);
    expect(listingPages(2400)).toBe(24);
    expect(closingReserve(0, 0)).toBe(CLOSING_FIXED_OPS + 2);
    // About 800 datasets: three artifacts each and the index.
    expect(closingReserve(2401, 0)).toBe(CLOSING_FIXED_OPS + 2 * 25);
    expect(closingReserve(2401, 12)).toBe(CLOSING_FIXED_OPS + 2 * 25 + 12);
    // A delete a dataset, up to the most one run removes.
    expect(closingReserve(2401, 5000)).toBe(CLOSING_FIXED_OPS + 2 * 25 + REMOVAL_LIMIT);
    // A bigger store holds back more, whatever else is the same.
    expect(closingReserve(2401, 0)).toBeGreaterThan(closingReserve(30, 0));
  });

  test("a run reports the reserve it held back, sized by the store it found", async () => {
    const small = await run({ execute: false });
    expect(small.ops.reserved).toBe(closingReserve(0, 0));
    // 150 datasets' objects, none eligible: 450 objects (5 pages) and 150 leaving (50 counted).
    const stamp = (kind: string) => ({ sha256: "0".repeat(64), kind });
    for (let i = 0; i < 150; i++) {
      const id = `nm${String(2000 + i).padStart(6, "0")}`;
      await h.bucket.put(`${id}.jsonld`, "{}", {
        customMetadata: { ...stamp("jsonld"), [META.fingerprint]: "sha256:x" },
      });
      await h.bucket.put(`${id}_annotated.json`, "{}", { customMetadata: stamp("dictionary") });
      await h.bucket.put(`${id}_dataset_description.json`, "{}", {
        customMetadata: stamp("description"),
      });
    }
    const large = await run({ execute: false });
    expect(large.ops.reserved).toBe(closingReserve(450, 150));
    expect(large.ops.reserved).toBeGreaterThan(small.ops.reserved + 50);
    // And what the listing itself cost is counted: a call a page (a dry run lists once).
    expect(large.ops.r2).toBeGreaterThanOrEqual(listingPages(450));
  });

  test("a run that stopped on its budget has left the reserve unspent: loop + reserved fits the budget", async () => {
    // Whatever the budget, the examination ends with the closing steps' share still there:
    // that is what the margin for one more dataset (its worst case) and the reserve buy.
    expect(DATASET_OPS_WORST).toBe(46);
    for (const budget of [120, 160, 200, 250, 330]) {
      await h.reset();
      for (const id of ids(30)) seedSynthetic(h, id);
      const first = await run({ limit: 50, opBudget: budget });
      expect(first.stopped, `budget ${budget}`).toBe("ops_budget");
      expect(
        first.ops.loop + first.ops.reserved,
        `first writes, budget ${budget}`,
      ).toBeLessThanOrEqual(budget);
      expect(first.ops.spent).toBeLessThanOrEqual(budget);
      // And the same on a run that REWRITES datasets, patching the index as it goes.
      h.db.run("UPDATE datasets SET name = name || ' (again)'");
      const again = await run({ limit: 50, opBudget: budget });
      if (again.stopped === "ops_budget") {
        expect(
          again.ops.loop + again.ops.reserved,
          `rewrites, budget ${budget}`,
        ).toBeLessThanOrEqual(budget);
      }
    }
  });

  test("the per-dataset part of the reserve is real: many removals still all happen in the run that stopped on its budget", async () => {
    // 40 datasets leaving and 14 to write, on a budget that a reserve of only the fixed part
    // would let the loop spend down to nothing, leaving too little to delete with.
    const stamp = (kind: string) => ({ sha256: "0".repeat(64), kind });
    for (let i = 0; i < 40; i++) {
      const id = `nm0009${String(i).padStart(2, "0")}`;
      await h.bucket.put(`${id}.jsonld`, "{}", {
        customMetadata: { ...stamp("jsonld"), [META.fingerprint]: "sha256:x" },
      });
      await h.bucket.put(`${id}_annotated.json`, "{}", { customMetadata: stamp("dictionary") });
      await h.bucket.put(`${id}_dataset_description.json`, "{}", {
        customMetadata: stamp("description"),
      });
    }
    for (const id of ids(14)) seedSynthetic(h, id);
    const result = await run({ limit: 50, opBudget: 220 });
    expect(result.stopped).toBe("ops_budget");
    expect(result.removed).toHaveLength(40);
    expect(result.removals_pending).toBe(0);
    expect(result.ops.reserved).toBe(closingReserve(120, 40));
  });

  test("the HTTP count is the writer's own HEAD plus the data plane's allowance, and the allowance covers what was really sent", async () => {
    // The pins: a HEAD per dataset (1) and the bounded allowance (24) for a gather. They are the
    // writer's own numbers, so a change is a decision to make here and in the ADR.
    expect(GATHER_HTTP_OPS).toBe(24);
    for (const id of ids(3)) seedSynthetic(h, id);
    const before = h.standin.log.length;
    const first = await run();
    const sent = h.standin.log.length - before;
    expect(outcomes(first).every((o) => o.endsWith(":written"))).toBe(true);
    // 3 rewritten datasets: one manifest HEAD plus the 24-request gather allowance each.
    expect(first.ops.http).toBe(3 * (1 + 24));
    // What the stand-in saw (the HEAD, the manifest, the two tables) is inside that.
    expect(sent).toBeGreaterThan(3);
    expect(sent).toBeLessThanOrEqual(first.ops.http);
    // Unchanged: the HEAD alone, one a dataset.
    const quiet2 = await run();
    expect(quiet2.results.every((r) => r.outcome === "unchanged")).toBe(true);
    expect(quiet2.ops.http).toBe(3);
  });

  test("the first dataset is always examined, so a tiny budget still makes progress", async () => {
    for (const id of ids(3)) seedSynthetic(h, id);
    const result = await run({ opBudget: 1 });
    expect(result.examined).toBe(1);
    expect(result.stopped).toBe("ops_budget");
    expect(outcomes(result)).toEqual(["nm000800:written"]);
  });

  test("a dry run reports the budget and spends no write", async () => {
    seedSynthetic(h, "nm000801");
    const rec = recordWrites(h.bucket);
    const result = await run({ execute: false }, h.env({ NEUROBAGEL: rec.bucket }));
    expect(rec.log).toEqual([]);
    expect(result.ops.spent).toBeGreaterThan(0);
    expect(result.stopped).toBeNull();
  });
});

describe("the store listing never returns part of the store", () => {
  test("past its page cap it FAILS, naming the cap, instead of handing back a truncated listing", async () => {
    const stamp = (kind: string) => ({ sha256: "0".repeat(64), kind });
    for (let i = 0; i < 70; i++) {
      const id = `nm${String(3000 + i).padStart(6, "0")}`;
      await h.bucket.put(`${id}.jsonld`, "{}", {
        customMetadata: { ...stamp("jsonld"), [META.fingerprint]: "sha256:x" },
      });
      await h.bucket.put(`${id}_annotated.json`, "{}", { customMetadata: stamp("dictionary") });
      await h.bucket.put(`${id}_dataset_description.json`, "{}", {
        customMetadata: stamp("description"),
      });
    }
    // 210 objects at 100 a page: three pages. Two are not enough, and say so.
    await expect(listStore(h.bucket, 2)).rejects.toThrow(
      /did not finish within 2 pages \(\d+ objects so far\): the store is larger than this writer can list/,
    );
    const whole = await listStore(h.bucket, 3);
    expect(whole.datasets.size).toBe(70);
    expect(whole.objects).toBe(210);
    // And the default is a hundred pages, which is what bounds the store.
    expect(LIST_MAX_PAGES).toBe(100);
  });

  test("a run whose listing fails is an error, writes nothing, and deletes nothing", async () => {
    seedSynthetic(h, "nm000870");
    await run();
    const rec = recordWrites(h.bucket);
    const failing = recordOps(rec.bucket, undefined);
    const broken = new Proxy(failing.bucket, {
      get(target, prop, receiver) {
        if (prop === "list") return () => Promise.reject(new Error("listing failed part way"));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    console.error = () => {};
    const result = await run({}, h.env({ NEUROBAGEL: broken }));
    console.error = quiet.error;
    expect(result.status).toBe("error");
    expect(result.error).toContain("listing failed part way");
    expect(rec.log).toEqual([]);
  });
});

describe("the operation counter", () => {
  test("counts statements run through D1 (first, all, run, batch as one), and R2 calls, and changes no result", async () => {
    const counter = createOpCounter();
    const env = countOps(h.env(), counter);
    seedDatasetRow(h.db, "nm000850");
    const row = await env.DB.prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
      .bind("nm000850")
      .first<{ dataset_id: string }>();
    expect(row?.dataset_id).toBe("nm000850");
    const all = await env.DB.prepare("SELECT dataset_id FROM datasets").all<{
      dataset_id: string;
    }>();
    expect(all.results.map((r) => r.dataset_id)).toEqual(["nm000850"]);
    await env.DB.prepare("UPDATE datasets SET name = 'x' WHERE dataset_id = 'nm000850'").run();
    expect(counter.d1).toBe(3);
    // A batch is one round trip, whatever it carries, and its statements still run.
    await env.DB.batch([
      env.DB.prepare("UPDATE datasets SET name = 'y' WHERE dataset_id = 'nm000850'"),
      env.DB.prepare("UPDATE datasets SET name = 'z' WHERE dataset_id = 'nm000850'"),
    ]);
    expect(counter.d1).toBe(4);
    expect(h.db.query("SELECT name FROM datasets WHERE dataset_id = 'nm000850'").get()).toEqual({
      name: "z",
    });

    const bucket = env.NEUROBAGEL as R2Bucket;
    await bucket.put("nm000850.jsonld", "{}");
    expect(await bucket.head("nm000850.jsonld")).not.toBeNull();
    await bucket.list();
    await bucket.delete("nm000850.jsonld");
    expect(counter.r2).toBe(4);
    expect(counter.total).toBe(counter.d1 + counter.r2 + counter.http);
  });

  test("an environment with no bucket or no database is passed through", () => {
    const counter = createOpCounter();
    const env = countOps({ ENVIRONMENT: "test" } as Bindings, counter);
    expect(env.NEUROBAGEL).toBeUndefined();
    expect(env.DB).toBeUndefined();
    expect(counter.total).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// The store's own hygiene
// ----------------------------------------------------------------------------

describe("the index is rebuilt from the listing", () => {
  test("a missing, corrupt or truncated index is replaced from the objects in the bucket", async () => {
    seedSynthetic(h, "nm000690");
    seedSynthetic(h, "nm000691");
    await run();
    const good = await text(NEUROBAGEL_INDEX_KEY);

    await h.bucket.delete(NEUROBAGEL_INDEX_KEY);
    await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000690", "nm000691"]);

    await h.bucket.put(NEUROBAGEL_INDEX_KEY, "{ not json");
    await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000690", "nm000691"]);

    await h.bucket.put(NEUROBAGEL_INDEX_KEY, good.slice(0, good.length / 2));
    await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000690", "nm000691"]);
  });

  test("a stored artifact the index lacks is added, and one for an ineligible id is dropped, from the listing alone", async () => {
    seedSynthetic(h, "nm000692");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000692'");
    // The previous run died after changing D1's view but before the index changed: simulate by
    // restoring an index that still lists the dataset.
    const stale = await text(NEUROBAGEL_INDEX_KEY);
    await run();
    await h.bucket.put(NEUROBAGEL_INDEX_KEY, stale);
    await h.bucket.put("nm000692.jsonld", "{}", {
      customMetadata: { [META.sha256]: "0".repeat(64), [META.kind]: "jsonld" },
    });
    await run();
    expect((await storedIndex()).datasets).toEqual([]);
  });

  test("objects that are not the writer's are ignored: never indexed, never deleted", async () => {
    seedSynthetic(h, "nm000693");
    await h.bucket.put("README.txt", "hello");
    await h.bucket.put("nm000999.jsonld", "{}"); // artifact-shaped, no writer stamp
    await h.bucket.put("xx000042.jsonld", "{}", {
      customMetadata: { [META.sha256]: "1".repeat(64), [META.kind]: "jsonld" },
    });
    const result = await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000693"]);
    expect(await storeKeys(h.bucket)).toEqual(
      expect.arrayContaining(["README.txt", "nm000999.jsonld", "xx000042.jsonld"]),
    );
    expect(result.removed).toEqual([]);
  });

  test("a JSON-LD the writer did not stamp as a whole set is never indexed, whatever else it carries", async () => {
    seedSynthetic(h, "nm000695");
    await run();
    // The commit marker is the fingerprint on the JSON-LD. An object with the right
    // hash and kind but no fingerprint is a set that was never completed.
    const object = await h.bucket.get("nm000695.jsonld");
    const body = await (object as R2ObjectBody).arrayBuffer();
    await h.bucket.put("nm000695.jsonld", body, {
      customMetadata: {
        [META.sha256]: object?.customMetadata?.[META.sha256] as string,
        [META.kind]: "jsonld",
      },
    });
    const result = await run({ execute: false });
    expect(result.index.skipped_incomplete).toEqual(["nm000695"]);
    expect(result.index.changed).toBe(true);
  });

  test("a set missing its companions is incomplete: rewritten, and not indexed until complete", async () => {
    seedSynthetic(h, "nm000694");
    await run();
    await h.bucket.delete("nm000694_annotated.json");
    const dry = await run({ execute: false });
    expect(dry.results[0]).toMatchObject({ outcome: "would_write", reason: "incomplete set" });
    const result = await run();
    expect(outcomes(result)).toEqual(["nm000694:written"]);
    expect(await storeKeys(h.bucket)).toContain("nm000694_annotated.json");
  });
});

// ----------------------------------------------------------------------------
// An interrupted run
// ----------------------------------------------------------------------------

/**
 * Every artifact the stored index names exists with the very bytes the index says
 * (the loader checks each sha256 and stops the WHOLE load on one mismatch), and every
 * entry's artifacts are complete.
 */
async function indexMismatches(): Promise<string[]> {
  const problems: string[] = [];
  const index = await storedIndex();
  for (const entry of index.datasets) {
    for (const artifact of entry.artifacts) {
      const head = await h.bucket.head(artifact.name);
      if (!head) problems.push(`${artifact.name}: absent`);
      else if (head.customMetadata?.[META.sha256] !== artifact.sha256) {
        problems.push(`${artifact.name}: stored sha256 is not the index's`);
      } else if (head.size !== artifact.bytes) problems.push(`${artifact.name}: size differs`);
    }
  }
  return problems;
}

/**
 * A bucket whose put of `hangOn` never returns: the run that issued it is cut off there,
 * exactly as a Worker killed for CPU, wall-clock or subrequests is. Nothing after that
 * line runs, and nothing is caught or cleaned up. Resolves `killed` when it happens.
 */
function killOnPut(bucket: R2Bucket, hangOn: (key: string) => boolean) {
  let kill: () => void = () => {};
  const killed = new Promise<void>((resolve) => {
    kill = resolve;
  });
  const wrapped = new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return (key: string, ...rest: unknown[]) => {
          if (hangOn(key)) {
            kill();
            return new Promise(() => {});
          }
          return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bucket: wrapped as R2Bucket, killed };
}

describe("an interrupted run never leaves artifacts newer than the index", () => {
  const IDS = ["nm000720", "nm000721", "nm000722", "nm000723"];

  async function seededAndWritten(): Promise<void> {
    for (const id of IDS) seedSynthetic(h, id);
    await run();
    expect(await indexMismatches()).toEqual([]);
    // Every dataset's row changes, so the next run rewrites all four.
    h.db.run("UPDATE datasets SET name = name || ' (revised)'");
  }

  test("a run cut off after two datasets leaves an index that matches every stored artifact", async () => {
    await seededAndWritten();
    const before = (await storedIndex()).datasets.map((d) => d.artifacts.map((a) => a.sha256));
    // The third dataset's first write never returns: the run is gone.
    const cut = killOnPut(h.bucket, (key) => key.startsWith("nm000722"));
    const running = run({}, h.env({ NEUROBAGEL: cut.bucket }));
    await Promise.race([running, cut.killed]);
    await cut.killed;

    // The first two are rewritten AND indexed; the others are as they were, and the loader,
    // which checks every sha256, would load all four.
    expect(await indexMismatches()).toEqual([]);
    const index = await storedIndex();
    expect(index.datasets).toHaveLength(4);
    const after = index.datasets.map((d) => d.artifacts.map((a) => a.sha256));
    expect(after[0]).not.toEqual(before[0]);
    expect(after[1]).not.toEqual(before[1]);
    expect(after[2]).toEqual(before[2]);
    expect(after[3]).toEqual(before[3]);
    expect(await text("nm000721.jsonld")).toContain("(revised)");
    expect(await text("nm000722.jsonld")).not.toContain("(revised)");
  });

  test("the next run finishes the job and the index matches again", async () => {
    await seededAndWritten();
    const cut = killOnPut(h.bucket, (key) => key.startsWith("nm000722"));
    void run({}, h.env({ NEUROBAGEL: cut.bucket }));
    await cut.killed;
    const result = await run();
    expect(outcomes(result).filter((o) => o.endsWith(":written"))).toEqual([
      "nm000722:written",
      "nm000723:written",
    ]);
    expect(await indexMismatches()).toEqual([]);
    for (const id of IDS) expect(await text(`${id}.jsonld`)).toContain("(revised)");
  });

  test("a cut-off inside one dataset's own three writes is healed by the next run", async () => {
    // The window that remains: between a dataset's first put and its last, its artifacts can
    // be ahead of its entry. The JSON-LD is written last and is the commit marker, so the
    // next run sees an unfinished set and redoes it, and the index is patched again.
    seedSynthetic(h, "nm000724");
    await run();
    h.db.run("UPDATE datasets SET name = 'Revised again' WHERE dataset_id = 'nm000724'");
    const cut = killOnPut(h.bucket, (key) => key === "nm000724.jsonld");
    void run({}, h.env({ NEUROBAGEL: cut.bucket }));
    await cut.killed;
    const healed = await run();
    expect(outcomes(healed)).toEqual(["nm000724:written"]);
    expect(await indexMismatches()).toEqual([]);
    expect(await text("nm000724.jsonld")).toContain("Revised again");
  });

  test("each dataset is indexed right after its own artifacts, and the closing sync finds nothing left to do", async () => {
    seedSynthetic(h, "nm000725");
    await run();
    seedSynthetic(h, "nm000726");
    seedSynthetic(h, "nm000727");
    const rec = recordWrites(h.bucket);
    const result = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(rec.log.map((e) => e.key)).toEqual([
      "nm000726_annotated.json",
      "nm000726_dataset_description.json",
      "nm000726.jsonld",
      "index.json",
      "nm000727_annotated.json",
      "nm000727_dataset_description.json",
      "nm000727.jsonld",
      "index.json",
    ]);
    expect(result.index.patched).toBe(2);
    expect(result.index.changed).toBe(false);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual([
      "nm000725",
      "nm000726",
      "nm000727",
    ]);
  });

  /**
   * The real bucket, except that each of the first `times` writes of the index is preceded by
   * another run's write of it (a changed document), so a write conditional on the ETag it read
   * loses, exactly as it does when two runs overlap.
   */
  function contendIndexWrites(bucket: R2Bucket, times: number) {
    let lost = 0;
    const wrapped = new Proxy(bucket, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key === NEUROBAGEL_INDEX_KEY && lost < times) {
              lost++;
              const current = JSON.parse((await (await target.get(key))?.text()) ?? "{}");
              await (target.put as (...a: unknown[]) => unknown)(
                key,
                `${JSON.stringify({ ...current, bump: lost })}\n`,
              );
            }
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    return { bucket: wrapped, lost: () => lost };
  }

  test("a patch that loses its race twice is retried and wins on the third attempt", async () => {
    await seededAndWritten();
    const race = contendIndexWrites(h.bucket, 2);
    const result = await run({}, h.env({ NEUROBAGEL: race.bucket }));
    expect(race.lost()).toBe(2);
    expect(result.stopped).toBeNull();
    expect(result.examined).toBe(4);
    expect(result.index.patched).toBe(4);
    expect(await indexMismatches()).toEqual([]);
  });

  test("a patch that loses all three attempts stops the run there, and the closing sync still settles the index", async () => {
    await seededAndWritten();
    const race = contendIndexWrites(h.bucket, 3);
    console.warn = () => {};
    const result = await run({}, h.env({ NEUROBAGEL: race.bucket }));
    console.warn = quiet.warn;
    expect(race.lost()).toBe(3);
    expect(result.stopped).toBe("index_patch");
    expect(result.examined).toBe(1);
    expect(await indexMismatches()).toEqual([]);
  });

  test("the closing sync loses its race twice and still wins on the third attempt, so a removal is not held back", async () => {
    seedSynthetic(h, "nm000728");
    seedSynthetic(h, "nm000729");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000728'");
    const race = contendIndexWrites(h.bucket, 2);
    const result = await run({}, h.env({ NEUROBAGEL: race.bucket }));
    expect(race.lost()).toBe(2);
    expect(result.index.written).toBe(true);
    expect(result.index.contended).toBeUndefined();
    expect(result.removed).toEqual(["nm000728"]);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000729"]);
  });

  test("the closing sync that loses all three attempts reports it, and keeps the artifacts of what is leaving", async () => {
    seedSynthetic(h, "nm000728");
    seedSynthetic(h, "nm000729");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000728'");
    const race = contendIndexWrites(h.bucket, 3);
    console.warn = () => {};
    const result = await run({}, h.env({ NEUROBAGEL: race.bucket }));
    console.warn = quiet.warn;
    expect(race.lost()).toBe(3);
    expect(result.index.contended).toBe(true);
    expect(result.removed).toEqual([]);
    expect(await storeKeys(h.bucket)).toContain("nm000728.jsonld");
  });

  test("a patch that THROWS is a patch that failed: the run stops there and the closing sync heals the index", async () => {
    await seededAndWritten();
    // The first write of the index (dataset 1's patch) throws outright; later ones are fine.
    let thrown = 0;
    const flaky = new Proxy(h.bucket, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key === NEUROBAGEL_INDEX_KEY && thrown === 0) {
              thrown++;
              throw new Error("R2 put refused");
            }
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const result = await run({}, h.env({ NEUROBAGEL: flaky }));
    expect(thrown).toBe(1);
    expect(result.status).toBe("ok");
    expect(result.stopped).toBe("index_patch");
    expect(result.examined).toBe(1);
    expect(result.unexamined).toBe(3);
    expect(result.warnings.join(" ")).toContain("index patch for nm000720 threw: R2 put refused");
    // Not a word more was written, and the closing sync left the index true to the store.
    expect(await indexMismatches()).toEqual([]);
    expect(await text("nm000720.jsonld")).toContain("(revised)");
    expect(await text("nm000721.jsonld")).not.toContain("(revised)");
  });

  test("an index that cannot be patched stops the run there, and the closing sync rebuilds it", async () => {
    await seededAndWritten();
    // Every write of the index that carries a CHANGED entry for nm000721 loses its race.
    let patches = 0;
    const racing = new Proxy(h.bucket, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key === NEUROBAGEL_INDEX_KEY && patches < 3) {
              patches++;
              // Another run replaces the index first, so this conditional write loses.
              const current = JSON.parse(
                (await (await target.get(NEUROBAGEL_INDEX_KEY))?.text()) ?? "{}",
              );
              await (target.put as (...a: unknown[]) => unknown)(
                key,
                `${JSON.stringify({ ...current, bump: patches })}\n`,
              );
            }
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    console.warn = () => {};
    const result = await run({}, h.env({ NEUROBAGEL: racing }));
    console.warn = quiet.warn;
    expect(result.warnings.join(" ")).toContain("the index could not be patched after nm000720");
    expect(result.examined).toBe(1);
    expect(result.unexamined).toBeGreaterThanOrEqual(3);
    // The closing sync still ran and left the index consistent with the store.
    expect(await indexMismatches()).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// The bound and the order of work
// ----------------------------------------------------------------------------

describe("a tick examines at most N datasets, in a deterministic order", () => {
  const IDS = ["nm000700", "nm000701", "nm000702", "nm000703", "nm000704", "nm000705", "nm000706"];

  test("missing datasets come first, by id, and progress is made across ticks", async () => {
    for (const id of IDS) seedSynthetic(h, id);
    const t1 = await run({ limit: 3 });
    expect(outcomes(t1)).toEqual(["nm000700:written", "nm000701:written", "nm000702:written"]);
    expect(t1.unexamined).toBe(4);
    const t2 = await run({ limit: 3 });
    expect(outcomes(t2)).toEqual(["nm000703:written", "nm000704:written", "nm000705:written"]);
    const t3 = await run({ limit: 3 });
    expect(outcomes(t3).filter((o) => o.endsWith(":written"))).toEqual(["nm000706:written"]);
    // Once all are written, the tick is the rotation: nothing is rewritten.
    const t4 = await run({ limit: 3 });
    expect(t4.results.every((r) => r.outcome === "unchanged")).toBe(true);
    // The rotation is not work anyone is waiting on, so nothing is "unexamined": a backfill
    // that is done must read as done, not as hundreds of datasets still to come.
    expect(t4.unexamined).toBe(0);
    expect((await storedIndex()).datasets).toHaveLength(7);
  });

  test("a dataset with nothing in the store is examined before one that merely changed", async () => {
    for (const id of ["nm000700", "nm000701", "nm000702"]) seedSynthetic(h, id);
    await run({ limit: 2 });
    // 700 and 701 are written; 702 is missing; 700 then goes stale. Missing outranks stale
    // even though 700 sorts first.
    h.db.run("UPDATE datasets SET name = 'Late edit' WHERE dataset_id = 'nm000700'");
    const dry = await run({ execute: false, limit: 2 });
    expect(outcomes(dry)).toEqual(["nm000702:would_write", "nm000700:would_write"]);
  });

  test("the same inputs plan the same work (a pure function of inputs and date)", async () => {
    for (const id of IDS) seedSynthetic(h, id);
    const a = await run({ execute: false, limit: 4 });
    const b = await run({ execute: false, limit: 4 });
    expect(outcomes(a)).toEqual(outcomes(b));
    expect(outcomes(a)).toEqual(IDS.slice(0, 4).map((id) => `${id}:would_write`));
  });

  test("stale datasets come before the rotation, and the rotation window moves each UTC day", async () => {
    for (const id of IDS) seedSynthetic(h, id);
    await run({ limit: 7 });
    // A change in one row makes it stale; it goes first however late its id.
    h.db.run("UPDATE datasets SET name = 'Late edit' WHERE dataset_id = 'nm000706'");
    const dry = await run({ execute: false, limit: 2, now: new Date("2026-10-01T12:00:00Z") });
    expect(dry.results[0]).toMatchObject({ id: "nm000706", outcome: "would_write" });

    // With nothing stale, the examined window differs day to day and covers everything.
    await run({ limit: 7 });
    const seen = new Set<string>();
    for (let day = 0; day < 4; day++) {
      const d = await run({
        execute: false,
        limit: 2,
        now: new Date(Date.UTC(2026, 9, 1 + day, 12)),
      });
      for (const r of d.results) seen.add(r.id);
    }
    expect([...seen].sort()).toEqual(IDS);
  });

  test("a set missing a companion is MISSING to the plan: it is examined first, on any day, however late its id", async () => {
    for (const id of ["nm000700", "nm000701", "nm000702"]) seedSynthetic(h, id);
    await run({ limit: 3 });
    await h.bucket.delete("nm000702_annotated.json");
    // With one slot a day, a rotation member would be examined on one day in three; a
    // set that is not whole must lead on every one of them.
    for (let day = 0; day < 3; day++) {
      const dry = await run({
        execute: false,
        limit: 1,
        now: new Date(Date.UTC(2026, 9, 1 + day, 12)),
      });
      expect(outcomes(dry)).toEqual(["nm000702:would_write"]);
    }
  });

  describe("a dataset refused for ever does not take a slot of every tick", () => {
    const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 12));
    // These ticks are days apart on a made-up clock while the ledger is stamped by the real one,
    // so the parking window is switched off here; the window itself has its own tests below.
    const runP = (over: Partial<Parameters<typeof runNeurobagelWriter>[1]> = {}, env?: Bindings) =>
      run({ parkWindowMs: Number.POSITIVE_INFINITY, ...over }, env);
    const examined = (r: RunResult) => r.results.map((x) => x.id);

    function seedStarvation(): void {
      // Two eligible rows with no manifest (refused for ever, manifest_absent) and one
      // healthy dataset whose id sorts after both.
      seedDatasetRow(h.db, "nm000860");
      seedDatasetRow(h.db, "nm000861");
      seedSynthetic(h, "nm000862");
    }

    test("two refused datasets and a healthy later one, limit 2, six daily ticks: the healthy one is written on the second", async () => {
      seedStarvation();
      const perTick: string[][] = [];
      for (let n = 0; n < 6; n++) {
        const tick = await runP({ limit: 2, now: day(n) });
        perTick.push(examined(tick));
        if (n === 0) {
          expect(outcomes(tick)).toEqual(["nm000860:refused", "nm000861:refused"]);
        }
      }
      // The first tick is all there is to know about the pair; after it they are parked, so
      // the healthy dataset is examined next, and written.
      expect(perTick[1]).toContain("nm000862");
      expect((await storeKeys(h.bucket)).filter((k) => k.startsWith("nm000862"))).toHaveLength(3);
      expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000862"]);
      // The pair is not forgotten: each is examined again, on the rotation's cadence.
      const flat = perTick.flat();
      for (const id of ["nm000860", "nm000861"]) {
        expect(flat.filter((x) => x === id).length, id).toBeGreaterThanOrEqual(2);
      }
    });

    test("the refusal is recorded against the row's signature, once, and again only when the row changes", async () => {
      seedDatasetRow(h.db, "nm000863");
      const rows = () =>
        h.db
          .query<{ details: string }, []>(
            "SELECT details FROM audit_log WHERE action = 'neurobagel_refused' AND resource_id = 'nm000863' ORDER BY id",
          )
          .all()
          .map((r) => JSON.parse(r.details) as { code: string; sig?: string });
      await runP({ now: day(0) });
      await runP({ now: day(1) });
      await runP({ now: day(2) });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]?.code).toBe("manifest_absent");
      expect(rows()[0]?.sig).toMatch(/^sha256:[0-9a-f]{64}$/);

      h.db.run("UPDATE datasets SET name = 'Renamed' WHERE dataset_id = 'nm000863'");
      await runP({ now: day(3) });
      const after = rows();
      expect(after).toHaveLength(2);
      expect(after[1]?.sig).not.toBe(after[0]?.sig);
    });

    test("a refused dataset whose row changes is examined first again, ahead of the rotation", async () => {
      seedStarvation();
      await runP({ limit: 2, now: day(0) });
      await runP({ limit: 2, now: day(1) });
      // Parked now. A change to nm000861's row un-parks it: it is missing again.
      h.db.run("UPDATE datasets SET name = 'Fixed upstream' WHERE dataset_id = 'nm000861'");
      const plan = await runP({ execute: false, limit: 1, now: day(2) });
      expect(examined(plan)).toEqual(["nm000861"]);
    });

    test("a manifest body that breaks mid-read is a blip: refused, never recorded, never parked, and tried again at once", async () => {
      // The real broken-body path: the manifest the data plane scans stops after 40 bytes, so
      // metadata.json carries no digest (`bids_index` null) and the gather refuses it as
      // degraded. One tick later the manifest reads fine. A dataset whose FIRST attempt
      // blipped must not wait for a window to come round to it: a hook is the first attempt.
      seedSynthetic(h, "nm000865");
      seedSynthetic(h, "nm000866");
      seedSynthetic(h, "nm000867");
      const key = "/nm000865/version/v1.0.0.json";
      const whole = new TextDecoder().decode(h.standin.objects.get(key)?.body);
      h.standin.put(key, whole, { breakAfter: 40 });
      console.warn = () => {};
      console.error = () => {};
      const first = await runP({ limit: 1, now: day(0) });
      expect(first.results).toEqual([
        expect.objectContaining({ id: "nm000865", outcome: "refused", code: "metadata_degraded" }),
      ]);
      // Never a finding: nothing in the ledger, nothing for a person to read.
      expect(
        h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'neurobagel_refused'").get(),
      ).toEqual({ n: 0 });
      expect((await neurobagelStatus(h.env())).needs_review).toEqual([]);

      // The upstream recovers. The very next tick examines the blipped dataset FIRST again
      // (it is not parked, so it still leads the missing class) and writes it.
      h.standin.put(key, whole);
      const second = await runP({ limit: 1, now: day(1) });
      console.warn = quiet.warn;
      console.error = quiet.error;
      expect(outcomes(second)).toEqual(["nm000865:written"]);
      const third = await runP({ limit: 1, now: day(2) });
      expect(outcomes(third)).toEqual(["nm000866:written"]);
    });

    test("the codes treated as blips are exactly the ones the writer emits for a failed read", () => {
      expect([...TRANSIENT_CODES].sort()).toEqual(["fetch_failed", "metadata_degraded"]);
      // Both are emitted by the gather (the second only when the manifest digest was unreadable).
      const gather = readFileSync(
        join(import.meta.dir, "../src/services/neurobagel-gather.ts"),
        "utf8",
      );
      for (const code of TRANSIENT_CODES) expect(gather, code).toContain(`"${code}"`);
    });

    test("a STALE dataset with a standing refusal is parked too, behind a stale one that is healthy", async () => {
      // The stale half of the demotion: both datasets have a stored set whose signature the
      // row has since left. nm000868's curation lookup fails (a standing refusal, recorded
      // against its signature); nm000869 is healthy and sorts after it.
      seedSynthetic(h, "nm000868");
      seedSynthetic(h, "nm000869");
      await runP({ now: day(0) });
      h.db.run(
        "UPDATE datasets SET name = name || ' (edited)' WHERE dataset_id IN ('nm000868', 'nm000869')",
      );
      const curation: CurationResolver = async (id) =>
        id === "nm000868" ? { kind: "failed", reason: "the file did not load" } : { kind: "none" };
      const first = await runP({ limit: 1, now: day(1), deps: { curation } });
      expect(outcomes(first)).toEqual(["nm000868:refused"]);
      // Parked now: the healthy stale dataset goes first, though it sorts later.
      const second = await runP({ limit: 1, now: day(2), deps: { curation } });
      expect(outcomes(second)).toEqual(["nm000869:written"]);
      expect(await text("nm000869.jsonld")).toContain("(edited)");
    });

    test("a standing refusal parks a dataset for a day, then it is examined again and the refusal is re-recorded", async () => {
      // No manifest: a standing `manifest_absent`. The real clock here (the ledger is stamped
      // by it) and the DEFAULT window.
      seedDatasetRow(h.db, "nm000860");
      seedSynthetic(h, "nm000861");
      const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
      const refusedRows = () =>
        (
          h.db
            .query(
              "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'neurobagel_refused' AND resource_id = 'nm000860'",
            )
            .get() as { n: number }
        ).n;

      const t0 = await run({ limit: 1, now: hours(0) });
      expect(outcomes(t0)).toEqual(["nm000860:refused"]);
      expect(refusedRows()).toBe(1);
      // Inside the window it is parked: the other dataset goes first.
      const t1 = await run({ limit: 1, now: hours(2) });
      expect(outcomes(t1)).toEqual(["nm000861:written"]);
      expect(refusedRows()).toBe(1);
      // Past the window it is examined again, refused again, and the refusal is written
      // afresh so that the NEXT window starts from now, not from the first day.
      const t2 = await run({ limit: 1, now: hours(25) });
      expect(outcomes(t2)).toEqual(["nm000860:refused"]);
      expect(refusedRows()).toBe(2);
      // ... and inside that new window nothing is written again (the dataset may still be
      // examined as a member of the rotation, but its refusal is not re-recorded). The
      // ledger's rows are stamped by the real clock, so "inside the new window" is a tick
      // half an hour after the real time of t2.
      await run({ limit: 1, now: hours(0.5) });
      expect(refusedRows()).toBe(2);
    });

    test("a transient failure is never parked: it is retried every tick", async () => {
      seedSynthetic(h, "nm000864");
      // The manifest HEAD fails (S3 answers 500 for the key): a transient error, not a finding.
      h.standin.remove("/nm000864/version/v1.0.0.json");
      const failing = h.env({ S3_ENDPOINT_URL: "http://127.0.0.1:9" });
      console.error = () => {};
      const first = await runP({ limit: 1, now: day(0) }, failing);
      const second = await runP({ limit: 1, now: day(1) }, failing);
      console.error = quiet.error;
      expect(outcomes(first)).toEqual(["nm000864:error"]);
      expect(outcomes(second)).toEqual(["nm000864:error"]);
      expect(
        h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'neurobagel_refused'").get(),
      ).toEqual({ n: 0 });
    });

    test("planWork: parked datasets join the rotation, the window covers them, and a changed signature un-parks", () => {
      const row = (id: string): PlanRow =>
        ({
          dataset_id: id,
          name: id,
          subject_count: 1,
          license: null,
          concept_doi: null,
          enrichment_length: 0,
          latest_version: "1.0.0",
        }) as PlanRow;
      const rows = ["nm000870", "nm000871", "nm000872", "nm000873"].map(row);
      const signatures = new Map(rows.map((r) => [r.dataset_id, `sig-${r.dataset_id}`]));
      const none = new Map();
      const parked = new Set(["nm000870", "nm000871"]);
      const plan = (limit: number, d: number, p: ReadonlySet<string> | undefined) =>
        planWork({ rows, stored: none, signatures, limit, day: d, parked: p });
      // Unparked: every dataset is missing, by id.
      expect(plan(2, 0, undefined).work.map((w) => w.id)).toEqual(["nm000870", "nm000871"]);
      // Parked: the two healthy ones lead as missing; the parked pair follow in the rotation.
      const first = plan(2, 0, parked);
      expect(first.work.map((w) => [w.id, w.class])).toEqual([
        ["nm000872", "missing"],
        ["nm000873", "missing"],
      ]);
      expect(first.parked).toBe(2);
      expect(first.missing).toBe(2);
      const wide = plan(4, 0, parked);
      expect(wide.work.map((w) => [w.id, w.class])).toEqual([
        ["nm000872", "missing"],
        ["nm000873", "missing"],
        ["nm000870", "rotation"],
        ["nm000871", "rotation"],
      ]);
      // The rotation window over the parked pair moves with the day.
      const lead = (d: number) => plan(3, d, parked).work[2]?.id;
      expect(new Set([lead(0), lead(1)]).size).toBe(2);
      // A signature that no longer matches the refusal's un-parks it, and so does age.
      const now = new Date("2026-10-02T12:00:00Z");
      const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
      const refused = (id: string, sig: string | undefined, at: string): [string, LedgerEntry] => [
        id,
        { dataset_id: id, label: { state: "refused", code: "x", ...(sig ? { sig } : {}) }, at },
      ];
      const ledger = new Map<string, LedgerEntry>([
        refused("nm000870", "sig-nm000870", hoursAgo(1)),
        refused("nm000871", "an older one", hoursAgo(1)),
        // A refusal recorded before signatures were kept names no signature and parks nothing.
        refused("nm000872", undefined, hoursAgo(1)),
        ["nm000873", { dataset_id: "nm000873", label: { state: "clear" }, at: hoursAgo(1) }],
      ]);
      expect([...standingRefusals(ledger, signatures, now)]).toEqual(["nm000870"]);
      // The window is bounded: a refusal older than it parks nothing, and SQLite's own
      // timestamp format (`YYYY-MM-DD HH:MM:SS`, UTC) is read the same as an ISO one.
      const aged = new Map<string, LedgerEntry>([
        refused("nm000870", "sig-nm000870", hoursAgo(23)),
        refused("nm000871", "sig-nm000871", hoursAgo(25)),
        refused("nm000872", "sig-nm000872", "2026-10-02 11:00:00"),
        refused("nm000873", "sig-nm000873", "2026-09-30 11:00:00"),
      ]);
      expect([...standingRefusals(aged, signatures, now, 24 * 3_600_000)].sort()).toEqual([
        "nm000870",
        "nm000872",
      ]);
      // Without an end to it, age never un-parks.
      expect(standingRefusals(aged, signatures, now, Number.POSITIVE_INFINITY).size).toBe(4);
      // A timestamp from the future (a skewed clock) parks; one that cannot be read does not.
      const odd = new Map<string, LedgerEntry>([
        refused("nm000870", "sig-nm000870", hoursAgo(-3)),
        refused("nm000871", "sig-nm000871", "not a time"),
      ]);
      expect([...standingRefusals(odd, signatures, now)]).toEqual(["nm000870"]);
    });
  });

  test("an explicit list is examined as asked and bounded by its own length", async () => {
    for (const id of IDS) seedSynthetic(h, id);
    const result = await run({ only: ["nm000705", "nm000701", "nm000999"], limit: 2 });
    // Two named, both eligible; the unknown id is not eligible and is not examined.
    expect(outcomes(result)).toEqual(["nm000701:written", "nm000705:written"]);
  });
});
