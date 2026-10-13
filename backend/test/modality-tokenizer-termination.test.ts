/**
 * The modality tokenizer's recursion always terminates (#1711 review).
 *
 * `MODALITY_TOKENS_SQL` is a `WITH RECURSIVE` over the stored list. Its stop
 * condition used to be `rest <> ''`, which holds only if every step drains
 * `rest` to the empty string. A stored value with a NUL byte breaks that:
 * SQLite's SUBSTR stops at an embedded NUL, so `rest` can be left non-empty and
 * comma-free, INSTR then returns 0, SUBSTR(rest, 1) returns `rest` unchanged,
 * and the recursion repeats the same row until the database's own time limit
 * (30 s on D1) ends the statement. One such row would stall every
 * modality-filtered request. No writer produces a NUL, which is exactly why this
 * is pinned: nothing else would ever notice.
 *
 * bun:sqlite is synchronous, so a bun test timeout cannot interrupt a hung
 * query. Each case therefore runs in a CHILD PROCESS (helpers/modality-clause-child.ts,
 * which drives the real clause builder against a real migrated database) under a
 * hard timeout, and a timeout fails the test.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "helpers", "modality-clause-child.ts");
const HARD_TIMEOUT_MS = 10_000;
// bun's default per-test timeout (5 s) is shorter than the child's hard limit,
// so each test names its own: the child's 10 s kill is the one that decides.
const TEST_TIMEOUT_MS = 90_000;

/** Run the modality filter over `rows` in a child process, failing on a hang. */
function runInChild(
  rows: [string, string | null][],
  modality: string,
): { ids: string[]; hung: boolean; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", CHILD, JSON.stringify(rows), modality],
    timeout: HARD_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdout: "pipe",
    stderr: "pipe",
  });
  const hung = result.exitedDueToTimeout === true;
  const stdout = result.stdout.toString().trim();
  return {
    ids: hung || result.exitCode !== 0 ? [] : (JSON.parse(stdout) as string[]),
    hung,
    stderr: result.stderr.toString(),
  };
}

// Stored values that make SUBSTR stop at a NUL while a comma sits beyond it. The
// first two are the shapes that looped; the rest are NUL placements that always
// terminated, kept so a change of stop condition cannot trade one for the other.
const NUL = "\u0000";
const POISONED: [string, string][] = [
  ["nm600001", `a,y${NUL},`],
  ["nm600002", `x,y,z${NUL},eeg`],
  ["nm600003", NUL],
  ["nm600004", `a,${NUL}`],
  ["nm600005", `y${NUL},eeg`],
];

describe("the modality tokenizer terminates on any stored value", () => {
  test(
    "a stored NUL byte neither hangs the query nor poisons the clean rows",
    () => {
      const rows: [string, string | null][] = [
        ...POISONED,
        ["nm600010", "eeg"],
        ["nm600011", "ieeg"],
        ["nm600012", "eeg,ieeg"],
        ["nm600013", "beh, EEG"],
      ];
      const { ids, hung, stderr } = runInChild(rows, "eeg");
      expect({ hung, stderr }).toEqual({ hung: false, stderr: "" });
      // The clean rows are answered correctly in the same statement as the
      // poisoned ones, and a poisoned row that holds no eeg token before its NUL
      // does not match.
      expect(ids).toEqual(expect.arrayContaining(["nm600010", "nm600012", "nm600013"]));
      expect(ids).not.toContain("nm600011");
      for (const id of ["nm600001", "nm600003", "nm600004"]) expect(ids).not.toContain(id);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every NUL placement terminates on its own as well",
    () => {
      for (const [id, modalities] of POISONED) {
        const { hung } = runInChild([[id, modalities]], "eeg");
        expect({ id, hung }).toEqual({ id, hung: false });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
