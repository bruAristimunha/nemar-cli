// Child-process harness for modality-tokenizer-termination.test.ts.
//
// Runs the REAL modality clause (buildDatasetFilterClauses) against a real
// bun:sqlite database with every migration applied, in its own process. A
// recursive query that never terminates blocks bun:sqlite's synchronous call
// for good, so no in-process test timeout can interrupt it; the parent test
// spawns this file with a hard timeout instead and treats a timeout as the
// failure it is.
//
// argv[2]: JSON array of [dataset_id, modalities-or-null] rows to insert.
// argv[3]: the `modality` filter value.
// Prints the matching dataset ids as a JSON array, sorted.

import { buildDatasetFilterClauses } from "../../src/services/dataset-filters";
import { freshDb } from "./d1";

const rows = JSON.parse(process.argv[2] ?? "[]") as [string, string | null][];
const modality = process.argv[3] ?? "";

const db = freshDb();
for (const [datasetId, modalities] of rows) {
  db.query(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, status, is_sandbox, modalities) VALUES (?, -1, ?, 'public', 'active', 0, ?)",
  ).run(datasetId, datasetId, modalities);
}

const params: (string | number)[] = [];
const clauses = buildDatasetFilterClauses(params, { modality });
const found = db
  .query(`SELECT d.dataset_id AS id FROM datasets d WHERE 1 = 1${clauses} ORDER BY d.dataset_id`)
  .all(...(params as never[])) as { id: string }[];
console.log(JSON.stringify(found.map((r) => r.id)));
