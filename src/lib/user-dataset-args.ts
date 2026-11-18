/**
 * Resolve the `<username> <dataset-id>` positional pair used by invite and
 * access approve/deny. Either order is accepted: a swapped pair is repaired
 * locally instead of reaching the API as a misleading "Dataset not found".
 * A GitHub login can in principle look like a dataset id, so the declared
 * order wins whenever the second argument is an id; only when it is not and
 * the first is one do the two swap.
 */

import { failMessage, isBoundedDatasetId } from "./admin-command.js";

export type UserDatasetArgs = { username: string; datasetId: string };

/** The dataset id in normalized form (trimmed, lowercased), or null. */
function asDatasetId(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  return isBoundedDatasetId(id) ? id : null;
}

export function resolveUserDatasetArgs(first: string, second: string): UserDatasetArgs | null {
  const secondId = asDatasetId(second);
  if (secondId) return { username: first, datasetId: secondId };
  const firstId = asDatasetId(first);
  if (firstId) return { username: second, datasetId: firstId };
  return null;
}

export const USER_DATASET_ARGS_ERROR =
  "Expected <username> <dataset-id>; dataset ids look like nm000104. Neither argument looks like a dataset id.";

/** Resolve the pair, or say so (exit 1, no bug-report hint) and return null. */
export function requireUserDatasetArgs(first: string, second: string): UserDatasetArgs | null {
  const resolved = resolveUserDatasetArgs(first, second);
  if (!resolved) failMessage(USER_DATASET_ARGS_ERROR, { answered: true });
  return resolved;
}
