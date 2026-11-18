/**
 * Resolve the `<username> <dataset-id>` positional pair used by invite and
 * access approve/deny. Either order is accepted: a dataset id is
 * unambiguous (two letters plus six digits), so a swapped pair is repaired
 * locally instead of reaching the API as a misleading "Dataset not found".
 */

const DATASET_ID_RE = /^(nm|ds|on|xx)\d{6}$/;

export function looksLikeDatasetId(value: string): boolean {
  return DATASET_ID_RE.test(value);
}

export type UserDatasetArgs = { username: string; datasetId: string };

export function resolveUserDatasetArgs(first: string, second: string): UserDatasetArgs {
  if (looksLikeDatasetId(second)) return { username: first, datasetId: second };
  if (looksLikeDatasetId(first)) return { username: second, datasetId: first };
  throw new Error(
    `Expected <username> <dataset-id> (e.g. johndoe nm000104); neither "${first}" nor "${second}" looks like a dataset id.`,
  );
}
