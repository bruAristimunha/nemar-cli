/**
 * Run `saveDataset` in its own process, so a test can send that process a signal.
 *
 * usage: bun run save-runner.ts <dataset dir> <JSON array of skip entries>
 *
 * Prints the save's result as one JSON line. Only the signal tests use it: a signal
 * sent to the test runner itself would end the test run.
 */

import { saveDataset } from "../../src/lib/git-annex/clone-push";

const [dir, entries] = process.argv.slice(2);
const result = await saveDataset(dir, "upload", undefined, {
  skipContentCheck: JSON.parse(entries),
});
console.log(JSON.stringify(result));
